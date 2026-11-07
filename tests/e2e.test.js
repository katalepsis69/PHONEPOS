// phone-repair-pos/tests/e2e.test.js
const assert = require('node:assert');
const { serverTest } = require('./helper');
const { seedInitialParts } = require('../src/seed');

serverTest('End-to-end flow: Seed catalog -> Check stock -> Create POS GCash Sale -> Settle Credit -> Verify Stats', async (baseUrl, db, auth) => {
  // 1. Seed database with real parts and initial sample transactions
  const count = seedInitialParts(db);
  assert.ok(count >= 10, 'Should seed at least 10 sample parts');

  // 2. Fetch inventory list
  const resInv = await fetch(`${baseUrl}/api/inventory`, { headers: auth });
  const items = await resInv.json();
  assert.ok(items.length >= 10);

  // 3. Make a new POS sale with GCash (Part + Labor) for customer "Carlos"
  const firstItem = items[0];
  const resSale = await fetch(`${baseUrl}/api/sales`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      customer_name: 'Carlos Tech',
      customer_phone: '0917-555-4321',
      customer_type: 'technician',
      payment_method: 'gcash',
      payment_reference: '1002 9999 8888',
      items: [
        { inventory_id: firstItem.id, quantity: 1, unit_price: firstItem.price_technician, item_type: 'part' },
        { item_type: 'labor', item_name: 'Screen Install Labor', unit_price: 300.0, quantity: 1 }
      ],
      discount: 50.0,
      amount_paid: (firstItem.price_technician + 300.0) - 50.0
    })
  });
  assert.strictEqual(resSale.status, 201);
  const sale = await resSale.json();
  assert.strictEqual(sale.payment_reference, '1002 9999 8888');
  assert.strictEqual(sale.items.length, 2);

  // 4. Verify Customer Credits tab data
  const resCust = await fetch(`${baseUrl}/api/customers`, { headers: auth });
  const customers = await resCust.json();
  assert.ok(customers.length >= 3);

  // Find "Mark Freelance Tech" who has active credit from seed
  const mark = customers.find(c => c.customer_name === 'Mark Freelance Tech');
  assert.ok(mark);
  assert.ok(mark.total_credit_balance > 0);

  // 5. Settle Mark's debt via GCash
  const resSettle = await fetch(`${baseUrl}/api/customers/${encodeURIComponent(mark.customer_name)}/settle-credit`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      amount_paid: mark.total_credit_balance,
      payment_method: 'gcash',
      payment_reference: 'GCASH-SETTLE-MARK-001'
    })
  });
  assert.strictEqual(resSettle.status, 200);
  const settledMark = await resSettle.json();
  assert.strictEqual(settledMark.total_credit_balance, 0.0);
  assert.strictEqual(settledMark.status, 'clean');

  // 6. Process Warranty RMA Replacement on Carlos's screen
  const screenItem = sale.items.find(i => i.item_type === 'part');
  const resRma = await fetch(`${baseUrl}/api/sales/${sale.id}/returns`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sale_item_id: screenItem.id,
      return_type: 'replacement',
      return_reason: 'ghost_touch',
      technician_notes: 'Replaced screen due to ghost touch'
    })
  });
  assert.strictEqual(resRma.status, 201);
  const rma = await resRma.json();
  assert.ok(rma.return_code.startsWith('RMA-'));

  // 7. Verify Dashboard reflects all sales, labor revenue, settlements, and RMA
  const resDash = await fetch(`${baseUrl}/api/dashboard`, { headers: auth });
  const dash = await resDash.json();
  assert.strictEqual(dash.period, 'day');
  assert.strictEqual(dash.current.sale_count, 4); // 3 seeded + 1 Carlos
  assert.strictEqual(dash.current.warranty_returns, 1);
  assert.strictEqual(dash.current.labor_revenue, 300.0);
  assert.ok(dash.current.gcash_collected > 0);
  assert.ok(dash.current.credit_settled > 0);
  assert.ok(dash.current.collected_total > 0);
});


serverTest('API rejects cross-origin requests and foreign Host headers', async (baseUrl, db, auth) => {
  const http = require('node:http');
  const port = Number(new URL(baseUrl).port);

  // CSRF probe: a page on evil.example firing a state-changing POST from the
  // same browser. text/plain avoids the CORS preflight, so the server itself
  // must reject the foreign Origin.
  const res = await fetch(`${baseUrl}/api/sales`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain', 'Origin': 'http://evil.example' },
    body: JSON.stringify({ items: [{ item_type: 'labor', item_name: 'x', unit_price: 1, quantity: 1 }] })
  });
  assert.strictEqual(res.status, 403);

  // DNS rebinding probe: request arrives with a foreign Host header.
  const hostRes = await new Promise((resolve, reject) => {
    const r = http.request(
      { host: '127.0.0.1', port, path: '/api/inventory', method: 'GET', headers: { Host: 'evil.example' } },
      resolve
    );
    r.on('error', reject);
    r.end();
  });
  assert.strictEqual(hostRes.statusCode, 403);
  hostRes.resume();

  // Sanity: same-origin localhost requests still pass (session in place).
  const okRes = await fetch(`${baseUrl}/api/inventory`, { headers: auth });
  assert.strictEqual(okRes.status, 200);
});

serverTest('API rejects chunked (transfer-encoding) request bodies', async (baseUrl, db, auth) => {
  // Chunked POSTs carry no content-length, so buffering one would bypass the
  // body-size cap entirely (stress-test finding: a 32MB chunked body was
  // accepted). Every client this app has sends content-length JSON.
  const http = require('node:http');
  const port = Number(new URL(baseUrl).port);
  const res = await new Promise((resolve, reject) => {
    const r = http.request(
      { host: '127.0.0.1', port, path: '/api/sales', method: 'POST', headers: { 'Content-Type': 'application/json', ...auth } },
      resolve
    );
    r.on('error', reject);
    r.write('{"items":'); // no content-length + chunked writes
    r.end('[]}');
  });
  assert.strictEqual(res.statusCode, 411); // parseBody rejects chunked before parsing
  res.resume();
});

// ---------------------------------------------------------------------------
// TRIAL / LICENSE GATE
// ---------------------------------------------------------------------------
const crypto = require('node:crypto');
const { generateLicenseKey } = require('../scripts/generate-license');
const { getMachineId, activateLicense, setVerifyKeyForTests } = require('../src/license');
const throwawayVendor = crypto.generateKeyPairSync('ed25519');
// The HTTP gate verifies with the module default, so point it at the throwaway
// keypair for this file. The /api/license/activate route is exercised shipped-key-only
// in license.test.js; the private key never exists in the repo.
setVerifyKeyForTests(throwawayVendor.publicKey);

const saleBody = JSON.stringify({
  items: [{ item_type: 'labor', item_name: 'Gate probe', unit_price: 100, quantity: 1 }],
  amount_paid: 100
});
const postSale = (baseUrl, auth) => fetch(`${baseUrl}/api/sales`, {
  method: 'POST',
  headers: { ...auth, 'Content-Type': 'application/json' },
  body: saleBody
});
const expireTrial = db => db.prepare("UPDATE shop_settings SET value = ? WHERE key = 'first_run_ts'")
  .run(new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString());

serverTest('Trial gate: fresh DB passes, expired DB returns 402, activation restores access', async (baseUrl, db, auth) => {
  // 1. Fresh DB: full-function trial.
  let res = await postSale(baseUrl, auth);
  assert.strictEqual(res.status, 201);

  // 2. Expire: business endpoints gated, license endpoints exempt.
  //    The license gate runs before the session check, so this stays 402.
  expireTrial(db);
  res = await postSale(baseUrl, auth);
  assert.strictEqual(res.status, 402);
  const body = await res.json();
  assert.ok(body.machine_id.startsWith('TP-'), '402 body carries the Machine ID for reissue');

  res = await fetch(`${baseUrl}/api/license/status`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual((await res.json()).license_required, true);

  // 3. Module-level activation on the live db (the HTTP activate route stays
  // shipped-key-only; the private key never exists in the repo).
  const key = generateLicenseKey(
    { machine_id: getMachineId(), plan_type: 'lifetime', customer_name: 'E2E Gate Shop' },
    throwawayVendor.privateKey
  );
  activateLicense(db, key, throwawayVendor.publicKey);
  res = await postSale(baseUrl, auth);
  assert.strictEqual(res.status, 201);
});

serverTest('Expired trial still rejects cross-origin requests before the license gate', async (baseUrl, db) => {
  expireTrial(db);
  const res = await fetch(`${baseUrl}/api/sales`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain', 'Origin': 'http://evil.example' },
    body: saleBody
  });
  assert.strictEqual(res.status, 403); // security before commerce
});
