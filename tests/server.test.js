// phone-repair-pos/tests/server.test.js
const assert = require('node:assert');
const os = require('node:os');
const path = require('path');
const fs = require('fs');
const test = require('node:test');
const { spawnSync } = require('node:child_process');
const { serverTest, ensurePinChanged } = require('./helper');
const { createInventoryItem } = require('../src/inventory');

serverTest('Server REST endpoints serve inventory, customers, settings, and credit settlement', async (baseUrl, db, auth) => {
  // While the factory PIN is live, elevate refuses outright (1234 is in the
  // manual, so an elevation granted against it proves nothing). Assert that
  // before leaving the factory state, then change the PIN to gain elevation.
  const stillDefault = await fetch(`${baseUrl}/api/auth/elevate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin: '1234' })
  });
  assert.strictEqual(stillDefault.status, 403);
  const refused = await stillDefault.json();
  assert.match(refused.error, /factory PIN/i);
  assert.strictEqual(refused.code, 'elevation_required');
  const pinChange = await fetch(`${baseUrl}/api/auth/change-pin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ old_pin: '1234', new_pin: '4321' })
  });
  assert.strictEqual(pinChange.status, 200);
  const pinData = await pinChange.json();
  auth.Authorization = `Bearer ${pinData.token}`;
  auth['X-Elevation'] = pinData.elevationToken;
  // 1. Create inventory item via POST
  const resPost = await fetch(`${baseUrl}/api/inventory`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      brand: 'Apple',
      model_name: 'iPhone 13',
      part_type: 'LCD (OLED)',
      cost_price: 45.0,
      price_retail: 90.0,
      stock_quantity: 5
    })
  });
  assert.strictEqual(resPost.status, 201);
  const item = await resPost.json();
  assert.strictEqual(item.model_name, 'iPhone 13');

  // 2. Create a sale on Credit for customer "Dave"
  const resSale = await fetch(`${baseUrl}/api/sales`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      customer_name: 'Dave Tech',
      payment_method: 'credit',
      items: [{ inventory_id: item.id, quantity: 1, unit_price: 90.0 }],
      discount: 10.0, // 80.0 total
      amount_paid: 20.0 // 60.0 credit balance
    })
  });
  assert.strictEqual(resSale.status, 201);
  const saleData = await resSale.json();

  // 3. Fetch customers list
  const resCust = await fetch(`${baseUrl}/api/customers`, { headers: auth });
  assert.strictEqual(resCust.status, 200);
  const customers = await resCust.json();
  assert.strictEqual(customers.length, 1);
  assert.strictEqual(customers[0].customer_name, 'Dave Tech');
  assert.strictEqual(customers[0].total_credit_balance, 60.0);
  assert.strictEqual(customers[0].status, 'active_credit');

  // 4. Settle credit via POST /api/customers/:name/settle-credit
  const resSettle = await fetch(`${baseUrl}/api/customers/Dave%20Tech/settle-credit`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      amount_paid: 60.0,
      payment_method: 'gcash',
      payment_reference: 'GCASH-DAVE-123'
    })
  });
  assert.strictEqual(resSettle.status, 200);
  const settleData = await resSettle.json();
  assert.strictEqual(settleData.total_credit_balance, 0.0);
  assert.strictEqual(settleData.status, 'clean');

  // 5. Settings endpoints
  const resSettingsGet = await fetch(`${baseUrl}/api/settings`, { headers: auth });
  assert.strictEqual(resSettingsGet.status, 200);
  const settings = await resSettingsGet.json();
  assert.ok(settings.gcash_name);

  // Auth material must never reach the browser: an unsalted SHA256 of a 4-digit
  // PIN is trivially brute-forced.
  assert.strictEqual(settings.manager_pin_hash, undefined);
  assert.strictEqual(settings.license_key, undefined);
  assert.strictEqual(settings.counter_session_secret, undefined);
  assert.strictEqual(settings.sync_token, undefined);
  assert.strictEqual(settings.pin_change_required, false); // PIN changed during setup

  // ...and must not be writable through the generic settings endpoint either,
  // or anyone could install their own PIN hash.
  const resPinHijack = await fetch(`${baseUrl}/api/settings`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ manager_pin_hash: 'deadbeef' })
  });
  assert.notStrictEqual(resPinHijack.status, 200);

  const resSettingsPost = await fetch(`${baseUrl}/api/settings`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ gcash_number: '0999-000-1111' })
  });
  assert.strictEqual(resSettingsPost.status, 200);
  const updatedSettings = await resSettingsPost.json();
  assert.strictEqual(updatedSettings.gcash_number, '0999-000-1111');

  const syncConfig = await fetch(`${baseUrl}/api/settings`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sync_url: 'https://sync.invalid', sync_token: 'top-secret-token' })
  });
  assert.strictEqual(syncConfig.status, 200);
  const syncSettings = await syncConfig.json();
  assert.strictEqual(syncSettings.sync_url, 'https://sync.invalid');
  assert.strictEqual(syncSettings.sync_token, undefined);
  assert.strictEqual(db.prepare("SELECT value FROM shop_settings WHERE key = 'sync_token'").get().value, 'top-secret-token');
  const auditDetail = db.prepare("SELECT detail FROM audit_log WHERE category = 'settings' ORDER BY id DESC LIMIT 1").get().detail;
  assert.ok(!auditDetail.includes('top-secret-token'));

  // 6. Warranty Returns endpoint
  const resReturn = await fetch(`${baseUrl}/api/sales/${saleData.id}/returns`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sale_item_id: saleData.items[0].id,
      return_type: 'replacement',
      return_reason: 'ghost_touch',
      technician_notes: 'Touch issue testing'
    })
  });
  assert.strictEqual(resReturn.status, 201);
  const returnData = await resReturn.json();
  assert.ok(returnData.return_code.startsWith('RMA-'));

  const resListReturns = await fetch(`${baseUrl}/api/returns`, { headers: auth });
  assert.strictEqual(resListReturns.status, 200);
  const allReturns = await resListReturns.json();
  assert.strictEqual(allReturns.length, 1);

  // 7. Fetch dashboard stats
  const resDash = await fetch(`${baseUrl}/api/dashboard`, { headers: auth });
  assert.strictEqual(resDash.status, 200);
  const stats = await resDash.json();
  assert.strictEqual(stats.current.sale_count, 1);
  assert.strictEqual(stats.current.warranty_returns, 1);
  assert.strictEqual(stats.standing.total_parts_stock, 3); // 5 initial - 1 sold - 1 replacement = 3

  // 8. License & Activation Endpoints (session/license-exempt). Signing needs
  // the vendor private key, which is deliberately absent from the repo, so
  // this covers status + rejection of a forged key. Successful activation is
  // covered in license.test.js with an injected keypair.
  const crypto = require('node:crypto');
  const { getMachineId } = require('../src/license');
  const { generateLicenseKey } = require('../scripts/generate-license');
  const resLicStatus1 = await fetch(`${baseUrl}/api/license/status`);
  assert.strictEqual(resLicStatus1.status, 200);
  const lic1 = await resLicStatus1.json();
  assert.strictEqual(lic1.activated, false);

  const attacker = crypto.generateKeyPairSync('ed25519');
  const forgedKey = generateLicenseKey({ machine_id: getMachineId(), customer_name: 'Pirate' }, attacker.privateKey);
  const resLicForged = await fetch(`${baseUrl}/api/license/activate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ license_key: forgedKey })
  });
  assert.notStrictEqual(resLicForged.status, 200);
  assert.strictEqual((await fetch(`${baseUrl}/api/license/status`).then(r => r.json())).activated, false);

  // 9. Manager PIN Auth Endpoints. change-pin invalidates the caller's session
  // and elevation; the response carries fresh ones and the rest of the test
  // must keep using them. (The preamble above already left the factory PIN
  // behind, so the old PIN here is the preamble's 4321.)
  const oldSessionToken = auth['Authorization'].slice(7);
  const resPinChange = await fetch(`${baseUrl}/api/auth/change-pin`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ old_pin: '4321', new_pin: '9876' })
  });
  assert.strictEqual(resPinChange.status, 200);
  const pinChangeData = await resPinChange.json();
  assert.strictEqual(pinChangeData.success, true);
  assert.ok(pinChangeData.token, 'change-pin returns a fresh session token');
  assert.ok(pinChangeData.elevationToken, 'change-pin returns a fresh elevation token');
  auth['Authorization'] = `Bearer ${pinChangeData.token}`;
  auth['X-Elevation'] = pinChangeData.elevationToken;

  const resElev2 = await fetch(`${baseUrl}/api/auth/elevate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin: '9876' })
  });
  assert.strictEqual(resElev2.status, 200);
  assert.strictEqual((await resElev2.json()).valid, true);

  // The pre-change session is dead; the fresh one works.
  assert.strictEqual((await fetch(`${baseUrl}/api/auth/session`, { headers: { Authorization: `Bearer ${oldSessionToken}` } })).status, 401);
  assert.strictEqual((await fetch(`${baseUrl}/api/auth/session`, { headers: auth })).status, 200);

  // 10. Manual Backup Endpoint
  const resBackup = await fetch(`${baseUrl}/api/backup`, { method: 'POST', headers: auth });
  assert.strictEqual(resBackup.status, 200);
  const backupResult = await resBackup.json();
  assert.strictEqual(backupResult.success, true);
  assert.ok(backupResult.backup_file.startsWith('shop_backup_'));

  // The snapshot lands in the serverTest's throwaway backup dir and is removed
  // with it. This used to compute the REAL repo backups/ path from __dirname and
  // unlink that: a no-op while the names differ, and a real shop snapshot
  // deleted the day a test backup happened to collide with one.

  // 11. Reset Demo Data Endpoint (elevation replaces the body PIN)
  const resReset = await fetch(`${baseUrl}/api/settings/reset-demo`, {
    method: 'POST',
    headers: auth
  });
  assert.strictEqual(resReset.status, 200);
  const resetJson = await resReset.json();
  assert.strictEqual(resetJson.success, true);
  assert.ok(resetJson.count > 0);
});


serverTest('GET /api/inventory/barcode/:code returns item or 404', async (baseUrl, db, auth) => {
  const created = createInventoryItem(db, {
    brand: 'Samsung',
    model_name: 'Galaxy S21',
    part_type: 'LCD Assembly',
    sku_barcode: 'SAM-S21-LCD',
    cost_price: 1200,
    price_retail: 2500,
    price_technician: 2200,
    stock_quantity: 4,
    min_stock_alert: 1
  });

  const resFound = await fetch(`${baseUrl}/api/inventory/barcode/SAM-S21-LCD`, { headers: auth });
  assert.strictEqual(resFound.status, 200);
  const foundItem = await resFound.json();
  assert.strictEqual(foundItem.id, created.id);
  assert.strictEqual(foundItem.sku_barcode, 'SAM-S21-LCD');

  const resNotFound = await fetch(`${baseUrl}/api/inventory/barcode/UNKNOWN-999`, { headers: auth });
  assert.strictEqual(resNotFound.status, 404);
  const notFoundJson = await resNotFound.json();
  assert.strictEqual(notFoundJson.error, 'Item not found');
});

serverTest('Server supports inventory edits and CSV exports', async (baseUrl, db, auth) => {
  auth = await ensurePinChanged(baseUrl, auth);
  // 1. Create a part, then edit it via PUT (the audit's W3 flow)
  const resPost = await fetch(`${baseUrl}/api/inventory`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      brand: 'Vivo',
      model_name: 'Y17s',
      part_type: 'LCD (Incell)',
      cost_price: 20.0,
      price_retail: 55.0,
      price_technician: 40.0,
      stock_quantity: 5
    })
  });
  assert.strictEqual(resPost.status, 201);
  const item = await resPost.json();

  const resPut = await fetch(`${baseUrl}/api/inventory/${item.id}`, {
    method: 'PUT',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ price_retail: 60.0, stock_quantity: 9 })
  });
  assert.strictEqual(resPut.status, 200);
  const updated = await resPut.json();
  assert.strictEqual(updated.price_retail, 60.0);
  assert.strictEqual(updated.stock_quantity, 9);
  assert.strictEqual(updated.model_name, 'Y17s'); // untouched fields survive

  // 2. A sale so the CSV export has something to chew on
  const resSale = await fetch(`${baseUrl}/api/sales`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      customer_name: 'Csv, "Quote" Customer', // commas and quotes must survive the CSV escaping
      payment_method: 'cash',
      items: [{ inventory_id: item.id, quantity: 1, unit_price: 60.0 }],
      amount_paid: 60.0
    })
  });
  assert.strictEqual(resSale.status, 201);

  // 3. Sales CSV: header row, content type, escaping
  const resCsv = await fetch(`${baseUrl}/api/export/sales.csv`, { headers: auth });
  assert.strictEqual(resCsv.status, 200);
  assert.match(resCsv.headers.get('content-type'), /text\/csv/);
  const csv = await resCsv.text();
  assert.ok(csv.startsWith('sale_code,date,customer,'));
  assert.ok(csv.includes('"Csv, ""Quote"" Customer"'));

  // 4. Customers CSV
  const resCustCsv = await fetch(`${baseUrl}/api/export/customers.csv`, { headers: auth });
  assert.strictEqual(resCustCsv.status, 200);
  const custCsv = await resCustCsv.text();
  assert.ok(custCsv.startsWith('customer,phone,orders,'));
  assert.ok(custCsv.includes('Csv'));
});

serverTest('Movements endpoint serves a part ledger newest-first, 404s unknown ids', async (baseUrl, db, auth) => {
  auth = await ensurePinChanged(baseUrl, auth);
  const resPost = await fetch(`${baseUrl}/api/inventory`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      brand: 'Apple', model_name: 'iPhone 15', part_type: 'Battery',
      cost_price: 12, price_retail: 30, stock_quantity: 6
    })
  });
  const item = await resPost.json();

  await fetch(`${baseUrl}/api/sales`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      customer_name: 'Movement Viewer',
      items: [{ inventory_id: item.id, quantity: 2, unit_price: 30 }],
      amount_paid: 60
    })
  });

  const resMoves = await fetch(`${baseUrl}/api/inventory/${item.id}/movements`, { headers: auth });
  assert.strictEqual(resMoves.status, 200);
  const moves = await resMoves.json();
  assert.strictEqual(moves.length, 2);           // opening_balance + sale
  assert.strictEqual(moves[0].reason, 'sale');   // newest first
  assert.strictEqual(moves[0].delta, -2);
  assert.match(moves[0].ref, /^SALE-/);
  assert.strictEqual(moves[1].reason, 'opening_balance');

  const res404 = await fetch(`${baseUrl}/api/inventory/99999/movements`, { headers: auth });
  assert.strictEqual(res404.status, 404);

  // Adjust with a reason/note through the API: the meta lands in the ledger.
  const resAdj = await fetch(`${baseUrl}/api/inventory/${item.id}/adjust-stock`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ delta: 4, reason: 'receive', note: 'delivery' })
  });
  assert.strictEqual(resAdj.status, 200);
  assert.strictEqual((await resAdj.json()).stock_quantity, 8);
  const after = await (await fetch(`${baseUrl}/api/inventory/${item.id}/movements`, { headers: auth })).json();
  assert.deepStrictEqual([after[0].delta, after[0].reason, after[0].note], [4, 'receive', 'delivery']);
});

serverTest('Archive endpoints hide parts from the default catalog and POS list', async (baseUrl, db, auth) => {
  auth = await ensurePinChanged(baseUrl, auth);
  const resPost = await fetch(`${baseUrl}/api/inventory`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      brand: 'Tecno', model_name: 'Spark 10', part_type: 'LCD',
      cost_price: 10, price_retail: 25, stock_quantity: 2
    })
  });
  const item = await resPost.json();

  const resArchive = await fetch(`${baseUrl}/api/inventory/${item.id}/archive`, { method: 'POST', headers: auth });
  assert.strictEqual(resArchive.status, 200);
  assert.strictEqual((await resArchive.json()).archived, 1);

  // Default list (what POS and the inventory tab load) excludes it...
  const plain = await (await fetch(`${baseUrl}/api/inventory?search=Spark`, { headers: auth })).json();
  assert.strictEqual(plain.length, 0);
  // ...the show-archived view still finds it.
  const withFlag = await (await fetch(`${baseUrl}/api/inventory?search=Spark&include_archived=true`, { headers: auth })).json();
  assert.strictEqual(withFlag.length, 1);
  assert.strictEqual(withFlag[0].archived, 1);

  const resUnarchive = await fetch(`${baseUrl}/api/inventory/${item.id}/unarchive`, { method: 'POST', headers: auth });
  assert.strictEqual(resUnarchive.status, 200);
  assert.strictEqual((await resUnarchive.json()).archived, 0);
  assert.strictEqual((await (await fetch(`${baseUrl}/api/inventory?search=Spark`, { headers: auth })).json()).length, 1);

  assert.strictEqual((await fetch(`${baseUrl}/api/inventory/99999/archive`, { method: 'POST', headers: auth })).status, 404);
});

serverTest('Reprint any sale writes an audit row and never creates a new sale', async (baseUrl, db, auth) => {
  auth = await ensurePinChanged(baseUrl, auth);
  const resItem = await fetch(`${baseUrl}/api/inventory`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ brand: 'OPPO', model_name: 'A16', part_type: 'Charging Port', cost_price: 3, price_retail: 12, stock_quantity: 6 })
  });
  const item = await resItem.json();
  const resSale = await fetch(`${baseUrl}/api/sales`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ payment_method: 'cash', items: [{ inventory_id: item.id, quantity: 1, unit_price: 12 }], amount_paid: 12 })
  });
  const sale = await resSale.json();

  const before = db.prepare('SELECT COUNT(*) AS c FROM sales').get().c;
  const resReprint = await fetch(`${baseUrl}/api/sales/${sale.id}/reprint`, { method: 'POST', headers: auth });
  assert.strictEqual(resReprint.status, 200);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS c FROM sales').get().c, before);

  const auditRow = db.prepare("SELECT * FROM audit_log WHERE category='receipt' AND action='reprint' ORDER BY id DESC LIMIT 1").get();
  assert.ok(auditRow);
  assert.ok(auditRow.detail.includes(sale.sale_code));

  const resMissing = await fetch(`${baseUrl}/api/sales/99999/reprint`, { method: 'POST', headers: auth });
  assert.strictEqual(resMissing.status, 404);
});

serverTest('Duplicate SKU returns 409, and inventory CSV export imports back round-trip', async (baseUrl, db, auth) => {
  auth = await ensurePinChanged(baseUrl, auth); // the import/export routes refuse the factory PIN
  const mkPart = body => fetch(`${baseUrl}/api/inventory`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  const first = await mkPart({
    brand: 'Oppo', model_name: 'A78', part_type: 'LCD (OLED)',
    sku_barcode: 'OP-A78-OLED', cost_price: 40, price_retail: 90, stock_quantity: 3
  });
  assert.strictEqual(first.status, 201);

  // Second part stealing the same SKU: friendly 409, not a raw 400.
  const dup = await mkPart({
    brand: 'Oppo', model_name: 'A58', part_type: 'LCD (OLED)',
    sku_barcode: 'OP-A78-OLED', cost_price: 30, price_retail: 70, stock_quantity: 2
  });
  assert.strictEqual(dup.status, 409);
  assert.match((await dup.json()).error, /OP-A78-OLED/);

  // Update into a collision also 409s.
  const item = await first.json();
  const other = await mkPart({
    brand: 'Oppo', model_name: 'A98', part_type: 'LCD (OLED)',
    cost_price: 50, price_retail: 110, stock_quantity: 1
  });
  const otherItem = await other.json();
  const collide = await fetch(`${baseUrl}/api/inventory/${otherItem.id}`, {
    method: 'PUT',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sku_barcode: 'OP-A78-OLED' })
  });
  assert.strictEqual(collide.status, 409);

  // Export -> tweak a row -> import: stock tops up, prices overwrite, new row created.
  const resExport = await fetch(`${baseUrl}/api/inventory/export`, { headers: auth });
  assert.strictEqual(resExport.status, 200);
  assert.match(resExport.headers.get('content-disposition'), /inventory\.csv/);
  const csv = await resExport.text();
  assert.ok(csv.startsWith('Brand,Model Name,Part Type,SKU / Barcode,Capital,'));

  const lines = csv.trim().split('\r\n');
  const header = lines[0].split(',');
  const rows = lines.slice(1).map(l => {
    const cells = l.split(','); // export escaping is quote-only; these rows have no quoted commas
    return Object.fromEntries(header.map((h, i) => [h, cells[i] ?? '']));
  });
  assert.ok(rows.length >= 2); // A78 + A98 (the dup POST created nothing)
  const a78 = rows.find(r => (r['SKU / Barcode'] || r.sku_barcode) === 'OP-A78-OLED');
  assert.strictEqual(Number(a78['Stock Qty'] || a78.stock_quantity), 3);

  a78['Stock Qty'] = '5';    // top-up via identity (sku present)
  a78['Retail Price'] = '95';     // overwrite non-empty price
  a78['Supplier'] = 'Greenleaf';
  rows.push({ brand: 'Vivo', model_name: 'Y27', part_type: 'LCD', cost_price: '20', price_retail: '50', stock_quantity: '4' });

  const resImport = await fetch(`${baseUrl}/api/inventory/import`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ rows })
  });
  assert.strictEqual(resImport.status, 200);
  const summary = await resImport.json();
  assert.strictEqual(summary.created, 1);
  assert.strictEqual(summary.updated, rows.length - 1);

  const after = await (await fetch(`${baseUrl}/api/inventory?search=A78`, { headers: auth })).json();
  assert.strictEqual(after[0].stock_quantity, 8);        // 3 + 5
  assert.strictEqual(after[0].price_retail, 95);
  assert.strictEqual(after[0].supplier, 'Greenleaf');

  // Bad import: row-numbered error, nothing written.
  const before = await (await fetch(`${baseUrl}/api/inventory`, { headers: auth })).json();
  const resBad = await fetch(`${baseUrl}/api/inventory/import`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ rows: [{ brand: 'Realme', model_name: 'C55', part_type: 'LCD', stock_quantity: '1' }, { brand: '', model_name: 'Bad', part_type: 'LCD' }] })
  });
  assert.strictEqual(resBad.status, 400);
  assert.match((await resBad.json()).error, /Row 2: Brand is required/);
  const unchanged = await (await fetch(`${baseUrl}/api/inventory`, { headers: auth })).json();
  assert.strictEqual(unchanged.length, before.length);
});

serverTest('POST /api/inventory/bulk-edit and auto-pricing import via REST API', async (baseUrl, db, auth) => {
  auth = await ensurePinChanged(baseUrl, auth); // bulk-edit and import refuse the factory PIN
  // 1. Auto-pricing import
  const resImport = await fetch(`${baseUrl}/api/inventory/import`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      rows: [
        { brand: 'Infinix', model_name: 'Hot 30', part_type: 'Screen', cost_price: '500', stock_quantity: '3' },
        { brand: 'Tecno', model_name: 'Spark 10', part_type: 'Battery', cost_price: '300', stock_quantity: '2' }
      ],
      auto_price: true,
      retail_markup: 50,
      wholesale_markup: 20
    })
  });
  assert.strictEqual(resImport.status, 200);
  const importSummary = await resImport.json();
  assert.strictEqual(importSummary.created, 2);

  const parts = await (await fetch(`${baseUrl}/api/inventory?search=Hot%2030`, { headers: auth })).json();
  assert.strictEqual(parts.length, 1);
  const infinix = parts[0];
  assert.strictEqual(infinix.price_retail, 750); // 500 * 1.5
  assert.strictEqual(infinix.price_technician, 600); // 500 * 1.2

  const tecnoParts = await (await fetch(`${baseUrl}/api/inventory?search=Spark%2010`, { headers: auth })).json();
  const tecno = tecnoParts[0];

  // 2. Bulk edit endpoint: adjust prices
  const resBulkAdjust = await fetch(`${baseUrl}/api/inventory/bulk-edit`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ids: [infinix.id, tecno.id],
      action: 'adjust_price',
      params: { target: 'both', mode: 'amount', value: 50 }
    })
  });
  assert.strictEqual(resBulkAdjust.status, 200);
  const bulkRes = await resBulkAdjust.json();
  assert.strictEqual(bulkRes.updated, 2);

  const infinixUpdated = (await (await fetch(`${baseUrl}/api/inventory?search=Hot%2030`, { headers: auth })).json())[0];
  assert.strictEqual(infinixUpdated.price_retail, 800); // 750 + 50
  assert.strictEqual(infinixUpdated.price_technician, 650); // 600 + 50

  // 3. Elevation required for bulk edit
  const noElev = { 'Authorization': auth['Authorization'] };
  const resDenied = await fetch(`${baseUrl}/api/inventory/bulk-edit`, {
    method: 'POST',
    headers: { ...noElev, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: [infinix.id], action: 'archive' })
  });
  assert.strictEqual(resDenied.status, 403);
});

// A reload fires the same closing beacon as a tab close, then heartbeats
// again at once. The reload heartbeat must cancel the close: the server
// that exits 3s after every F5 is the client-server connection bug.
serverTest('Heartbeat: closing beacon cancelled by reload heartbeat keeps server alive', async (baseUrl) => {
  const post = (url) => fetch(url, { method: 'POST' });
  await post(`${baseUrl}/api/system/heartbeat?closing=1`);
  await post(`${baseUrl}/api/system/heartbeat`);
  await new Promise(r => setTimeout(r, 3500)); // past the old 3s kill timer
  const after = await fetch(`${baseUrl}/api/license/status`);
  assert.strictEqual(after.status, 200, 'server died after reload heartbeat');
});

serverTest('security headers mirror the cloud set on static, JSON, and 404 responses', async (baseUrl) => {
  const EXPECTED = {
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'permissions-policy': 'camera=(), microphone=(), geolocation=()',
    'cross-origin-opener-policy': 'same-origin',
    'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
  };
  const check = (res, label) => {
    for (const [header, value] of Object.entries(EXPECTED)) {
      assert.strictEqual(res.headers.get(header), value, `${label}: ${header}`);
    }
  };

  const home = await fetch(`${baseUrl}/`);
  assert.strictEqual(home.status, 200);
  check(home, '/');

  const report = await fetch(`${baseUrl}/report.html`);
  assert.strictEqual(report.status, 200);
  check(report, '/report.html');
  const reportBody = await report.text();
  assert.ok(reportBody.includes('<script src="js/report.js"></script>'), 'report page loads its script externally');
  assert.ok(!reportBody.includes('<script>'), 'no inline script left: CSP script-src must not need unsafe-inline');

  const reportJs = await fetch(`${baseUrl}/js/report.js`);
  assert.strictEqual(reportJs.status, 200);
  assert.match(reportJs.headers.get('content-type'), /text\/javascript/);
  assert.ok((await reportJs.text()).includes('(function () {'), 'extracted report logic is served');

  const static404 = await fetch(`${baseUrl}/no-such-page.js`);
  assert.strictEqual(static404.status, 404);
  check(static404, 'static 404');

  const apiJson = await fetch(`${baseUrl}/api/license/status`);
  assert.strictEqual(apiJson.status, 200);
  check(apiJson, 'sendJson');
});

serverTest('internal errors answer 500 generic, never leak engine text', async (baseUrl, db, auth) => {
  // logFilePath() answers the live path: under node --test the suite logs to a
  // per-process temp file so test failures stop polluting the shop's own log.
  const logPath = require('../src/server').logFilePath();
  const logBefore = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
  const origPrepare = db.prepare.bind(db);
  db.prepare = sql => {
    if (String(sql).includes('FROM shifts')) throw new TypeError("Cannot read properties of undefined (reading 'shop')");
    return origPrepare(sql);
  };
  try {
    const res = await fetch(`${baseUrl}/api/shifts`, { headers: auth });
    assert.strictEqual(res.status, 500);
    const body = await res.json();
    assert.doesNotMatch(body.error, /Cannot read properties/);
    assert.match(body.error, /pos-server\.log/);
    // The hidden details land in the log instead: stack, method, path, actor.
    const logged = fs.readFileSync(logPath, 'utf8').slice(logBefore.length);
    assert.match(logged, /GET \/api\/shifts failed: TypeError: Cannot read properties/);
    assert.match(logged, /\[actor Manager\]/);
  } finally {
    db.prepare = origPrepare;
  }
});

serverTest('CSV export defangs formula prefixes; import strips control chars and caps length', async (baseUrl, db, auth) => {
  auth = await ensurePinChanged(baseUrl, auth);
  const mk = body => fetch(`${baseUrl}/api/inventory`, {
    method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  const hostile = await mk({
    brand: 'Fraud', model_name: 'Probe', part_type: 'LCD', cost_price: 1, price_retail: 2,
    stock_quantity: 1, supplier: '=HYPERLINK("https://evil.example","Click")', location: '-Aisle 3'
  });
  assert.ok(hostile.ok, 'create with hostile text fields');

  const csv = await (await fetch(`${baseUrl}/api/inventory/export`, { headers: auth })).text();
  assert.match(csv, /'=HYPERLINK/, 'formula prefix defanged in the export writer');
  assert.match(csv, /'-Aisle 3/, 'leading hyphen on text defanged');
  assert.doesNotMatch(csv, /^[=+@]/m, 'no exported cell begins with a formula character');

  const big = await mk({
    brand: 'Cap', model_name: 'Probe', part_type: 'Battery', cost_price: 1, price_retail: 2,
    stock_quantity: 1, supplier: 'A\u0000B\u0007C', location: `${'X'.repeat(300)}\u0007Ding`
  });
  assert.ok(big.ok);
  const list = await (await fetch(`${baseUrl}/api/inventory?search=Cap`, { headers: auth })).json();
  const hit = list.find(i => i.model_name === 'Probe' && i.brand === 'Cap');
  assert.ok(hit, 'capped row imported');
  assert.strictEqual(hit.supplier, 'ABC', 'control characters stripped at the boundary');
  assert.strictEqual(hit.location.length, 200, 'text fields capped at 200 chars');
});

serverTest('settings audit digests oversized value bodies and keeps small ones whole', async (baseUrl, db, auth) => {
  auth = await ensurePinChanged(baseUrl, auth);
  const bigQr = 'data:image/png;base64,' + 'A'.repeat(5000);
  const res = await fetch(`${baseUrl}/api/settings`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ gcash_qr_url: bigQr, gcash_number: '0917-000-1111' })
  });
  assert.strictEqual(res.status, 200);
  await res.json();

  const row = db.prepare("SELECT detail FROM audit_log WHERE category='settings' AND action='update' AND detail LIKE '%gcash_qr_url%' ORDER BY id DESC LIMIT 1").get();
  const detail = JSON.parse(row.detail).changes;
  assert.match(detail.gcash_qr_url[1], /^\[\d+B sha256:[0-9a-f]{12}\]$/, 'oversized value stored as digest');
  assert.ok(!row.detail.includes('AAAAAA'), 'no raw payload body in the append-only log');
  assert.strictEqual(detail.gcash_number[1], '0917-000-1111', 'short values keep full text');
  assert.ok(row.detail.length < 1000, `whole audit row stays small (got ${row.detail.length} bytes)`);

  // The digest still answers "did it change and to what shape": a different
  // body of the same length must produce a different digest.
  const other = bigQr.slice(0, -1) + 'B';
  await fetch(`${baseUrl}/api/settings`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ gcash_qr_url: other })
  });
  const d2 = JSON.parse(db.prepare("SELECT detail FROM audit_log WHERE category='settings' AND action='update' AND detail LIKE '%gcash_qr_url%' ORDER BY id DESC LIMIT 1").get().detail).changes;
  assert.notStrictEqual(d2.gcash_qr_url[1], detail.gcash_qr_url[1]);
  assert.match(d2.gcash_qr_url[1], /^\[\d+B sha256:[0-9a-f]{12}\]$/);
});

// FINDING 2 brake. Requiring src/server.js as a NON-main module must start
// nothing. `node -e "require('./src/server.js')"` gets no main module and no
// argv[1]; the old guard's `!process.argv[1]` clause fired on exactly that shape,
// so any `-e` / `-p` / REPL probe booted a full server against the live
// data/shop.db, bound port 3000, ran today's backup and launched a browser.
// This runs that very command in a child whose database is a throwaway file and
// whose net.Server.listen is a tripwire, so even a regression can neither bind a
// port nor touch the shop database. The `node -e` child is required to exit on
// its own: a server that started would keep the loop open and time the spawn out.
test('requiring src/server.js as a non-main module starts no server, binds no port, opens no database', () => {
  const serverPath = path.join(__dirname, '..', 'src', 'server.js');
  const tmpDb = path.join(__dirname, `t_require_no_start_${process.pid}.db`);
  const scrub = () => {
    for (const f of [tmpDb, `${tmpDb}-shm`, `${tmpDb}-wal`]) {
      try { fs.rmSync(f, { force: true }); } catch (_) { /* never created */ }
    }
  };
  scrub();

  const probe = [
    'const net = require("node:net");',
    'let listened = false;',
    'net.Server.prototype.listen = function () { listened = true; process.stdout.write("LISTEN_ATTEMPT\\n"); throw new Error("test forbids binding a port"); };',
    'try { require(process.env.PROBE_SERVER_PATH); }',
    'catch (e) { process.stdout.write("REQUIRE_THREW:" + (e && e.message) + "\\n"); }',
    'process.stdout.write("DONE listened=" + listened + "\\n");',
  ].join(' ');

  const res = spawnSync(process.execPath, ['-e', probe], {
    env: {
      ...process.env,
      PROBE_SERVER_PATH: serverPath,
      POS_DB_PATH: tmpDb,      // a throwaway: nothing here can be data/shop.db
      // The boot path this probe exists to prove does not run also takes
      // today's backup. A guard regression must fail this assertion, not quietly
      // land a shop_backup_* file in the real backups/ of the machine under test.
      POS_BACKUP_DIR: path.join(os.tmpdir(), `t_require_no_start_backups_${process.pid}`),
      NODE_ENV: 'test',        // skips the instance-lock handoff, so a regression would still hit createServer+listen
      NO_AUTO_BROWSER: '1',    // a regression must not open a window either
    },
    timeout: 20000,
  });
  const out = ((res.stdout || '') + (res.stderr || '')).toString();
  try {
    assert.ok(!out.includes('LISTEN_ATTEMPT'), `requiring server.js tried to bind a port: ${out}`);
    assert.ok(!out.includes('REQUIRE_THREW'), `requiring server.js threw on require: ${out}`);
    assert.match(out, /DONE listened=false/, `probe did not report a clean no-start: ${out}`);
    assert.ok(!fs.existsSync(tmpDb), 'requiring server.js opened a database file');
    assert.strictEqual(res.status, 0, `probe did not exit on its own (code ${res.status}) — a server started: ${out}`);
  } finally {
    scrub();
  }
});

serverTest('POST /api/settings/pair-cloud validates 6-digit code and pairs with cloud service', async (baseUrl, db, auth) => {
  auth = await ensurePinChanged(baseUrl, auth);

  // 1. Invalid code rejection
  const resBadCode = await fetch(`${baseUrl}/api/settings/pair-cloud`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sync_url: 'https://cloud.invalid', code: '123' })
  });
  assert.strictEqual(resBadCode.status, 400);
  const badData = await resBadCode.json();
  assert.strictEqual(badData.error, 'Pairing code must be 6 digits');

  // 2. Successful pairing with mock cloud server
  const http = require('node:http');
  let receivedCode = null;
  let receivedShopName = null;
  const mockCloud = http.createServer((req, res) => {
    if (req.url === '/api/pair' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        const parsed = JSON.parse(body);
        receivedCode = parsed.code;
        receivedShopName = parsed.shop_name;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: true,
          shop_id: 'shop-42',
          sync_token: 'aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899'
        }));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise(r => mockCloud.listen(0, '127.0.0.1', r));
  const cloudPort = mockCloud.address().port;
  const cloudUrl = `http://127.0.0.1:${cloudPort}`;

  // Existing stock predating the pair: the pair must enqueue it for the mirror.
  db.prepare(`INSERT INTO inventory (brand, model_name, part_type, cost_price, price_retail, price_technician, stock_quantity, min_stock_alert)
    VALUES ('Backfill', 'Test Part', 'LCD', 10, 20, 15, 4, 2)`).run();

  try {
    const resPair = await fetch(`${baseUrl}/api/settings/pair-cloud`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sync_url: cloudUrl, code: '582 194' })
    });
    assert.strictEqual(resPair.status, 200);
    const pairResult = await resPair.json();
    assert.strictEqual(pairResult.ok, true);
    assert.strictEqual(pairResult.shop_id, 'shop-42');
    assert.strictEqual(pairResult.sync_token_configured, true);
    assert.strictEqual(pairResult.sync_url, cloudUrl);
    assert.strictEqual(receivedCode, '582194');

    // DB verify
    assert.strictEqual(db.prepare("SELECT value FROM shop_settings WHERE key = 'sync_url'").get()?.value, cloudUrl);
    assert.strictEqual(db.prepare("SELECT value FROM shop_settings WHERE key = 'sync_token'").get()?.value, 'aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899');
    assert.strictEqual(db.prepare("SELECT value FROM shop_settings WHERE key = 'sync_shop_id'").get()?.value, 'shop-42');

    // Audit verify
    const auditRow = db.prepare("SELECT action, detail FROM audit_log WHERE category = 'settings' AND action = 'cloud_paired' ORDER BY id DESC LIMIT 1").get();
    assert.ok(auditRow);
    assert.ok(auditRow.detail.includes('shop-42'));

    // Pair-time backfill: the pre-existing part is queued for the mirror.
    const backfilled = db.prepare("SELECT COUNT(*) c FROM sync_outbox WHERE synced_at IS NULL AND table_name = 'inventory'").get().c;
    assert.ok(backfilled >= 1, 'pairing enqueues existing inventory into the outbox');
  } finally {
    mockCloud.close();
  }
});

serverTest('drawer shifts are connected to reconcile day close and dashboard reports', async (baseUrl, db, auth) => {
  auth = await ensurePinChanged(baseUrl, auth);
  const today = new Date().toLocaleDateString('en-CA');

  // 1. Open drawer with opening float 100
  const openRes = await fetch(`${baseUrl}/api/shifts/open`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ opening_float: 100 })
  });
  assert.strictEqual(openRes.status, 201);
  const openData = await openRes.json();
  assert.strictEqual(openData.opening_float, 100);
  assert.strictEqual(openData.status, 'open');

  // 2. Dashboard and Reconcile report the active open drawer
  const dash1 = await (await fetch(`${baseUrl}/api/dashboard`, { headers: auth })).json();
  assert.ok(dash1.active_shift);
  assert.strictEqual(dash1.active_shift.id, openData.id);
  assert.strictEqual(dash1.active_shift.opening_float, 100);

  const rec1 = await (await fetch(`${baseUrl}/api/reconcile/${today}`, { headers: auth })).json();
  assert.ok(rec1.open_shift);
  assert.strictEqual(rec1.open_shift.id, openData.id);

  // 3. Ring up a sale of 200 cash
  const itemRes = await fetch(`${baseUrl}/api/inventory`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ brand: 'DrawerTest', model_name: 'POS', part_type: 'Screen', cost_price: 50, price_retail: 200, stock_quantity: 5 })
  });
  const item = await itemRes.json();
  await fetch(`${baseUrl}/api/sales`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ payment_method: 'cash', items: [{ inventory_id: item.id, quantity: 1, unit_price: 200 }], amount_paid: 200 })
  });

  // 4. Close drawer with counted cash 280 (Float 100 + Sale 200 = Expected 300; Variance = -20 shortage)
  const closeRes = await fetch(`${baseUrl}/api/shifts/${openData.id}/close`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ counted_cash: 280 })
  });
  assert.strictEqual(closeRes.status, 200);
  const closeData = await closeRes.json();
  assert.strictEqual(closeData.counted_cash, 280);
  assert.strictEqual(closeData.expected_cash, 300);
  assert.strictEqual(closeData.variance, -20);
  assert.strictEqual(closeData.status, 'closed');

  // 5. Dashboard now reports closed shifts, drawer variance, and drawer counted
  const dash2 = await (await fetch(`${baseUrl}/api/dashboard`, { headers: auth })).json();
  assert.strictEqual(dash2.active_shift, null);
  assert.strictEqual(dash2.drawer_variance, -20);
  assert.strictEqual(dash2.drawer_counted, 180); // 280 counted - 100 float = 180 takings
  assert.ok(Array.isArray(dash2.period_shifts));
  assert.strictEqual(dash2.period_shifts[0].id, openData.id);

  // 6. Reconcile endpoint returns shifts breakdown, total variance, and total counted takings
  const rec2 = await (await fetch(`${baseUrl}/api/reconcile/${today}`, { headers: auth })).json();
  assert.strictEqual(rec2.open_shift, null);
  assert.strictEqual(rec2.total_shift_variance, -20);
  assert.strictEqual(rec2.total_shift_counted, 180);
  assert.ok(rec2.shifts.length >= 1);
  assert.strictEqual(rec2.shifts.find(s => s.id === openData.id).variance, -20);
});

serverTest('a failed sync push is visible in /api/sync/status and the log', async (baseUrl, db, auth) => {
  auth = await ensurePinChanged(baseUrl, auth);
  // Reserve-then-release a loopback port on purpose: sync_url must point at
  // something reachable-but-dead so the drain fails fast with ECONNREFUSED.
  const net = require('node:net');
  const dead = net.createServer(() => {});
  await new Promise(r => dead.listen(0, '127.0.0.1', r));
  const deadPort = dead.address().port;
  await new Promise(r => dead.close(r));

  const setRes = await fetch(`${baseUrl}/api/settings`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sync_url: `http://127.0.0.1:${deadPort}` })
  });
  assert.equal(setRes.status, 200);

  // A non-GET API call kicks the debounced drain; wait past the 2s debounce
  // plus a refused-connection attempt.
  const saleRes = await fetch(`${baseUrl}/api/sales`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ customer_name: 'Sync Fail Probe', payment_method: 'cash', items: [], amount_paid: 0 })
  });
  assert.ok([200, 400].includes(saleRes.status), 'the write itself only needs to kick the drain');
  await new Promise(r => setTimeout(r, 4500));

  const status = await (await fetch(`${baseUrl}/api/sync/status`, { headers: auth })).json();
  assert.ok(status.last_error, `a failed push leaves last_error set (got ${JSON.stringify(status.last_error)})`);
  assert.ok(status.next_attempt_in_ms > 0, 'the failure feeds the backoff the chip reads');

  const { logFilePath } = require('../src/server');
  const log = fs.readFileSync(logFilePath(), 'utf8');
  assert.match(log, /sync: push failed/, 'the failure streak lands in pos-server.log');
});

// The 2026-11-09 audit: the cloud spends the pairing code before it answers,
// so a response lost to the pair route's 15 s abort can leave the shop paired
// on the cloud with a token the register never received. A behavioral test
// would need a >15 s hang, too slow for the suite: this pins the branch at
// source instead, so the timeout failure keeps naming the stranded state.
test('pair-cloud timeout names the stranded-pairing state, not a generic network error', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  const route = src.slice(src.indexOf("'/api/settings/pair-cloud'"), src.indexOf("'/api/settings/pair-cloud'") + 4200);
  assert.match(route, /TimeoutError/, 'the abort signal rejection is detected by name');
  assert.match(route, /504/, 'a lost pairing response answers 504, not 502');
  assert.match(route, /pairing may have completed on the cloud side/, 'the error names the possibly-completed pairing');
  assert.match(route, /rotate this shop's credential/, 'the error names the recovery path');
});

test('resolveLaunchMode correctly distinguishes direct, launcher, and service modes', () => {
  const { resolveLaunchMode } = require('../src/server');
  assert.strictEqual(typeof resolveLaunchMode, 'function', 'resolveLaunchMode is exported');

  // 1. Dev run (node.exe)
  assert.strictEqual(
    resolveLaunchMode({
      execPath: 'C:\\Program Files\\nodejs\\node.exe',
      argv: ['C:\\Program Files\\nodejs\\node.exe', 'src/server.js'],
      env: {}
    }),
    'direct'
  );
  assert.strictEqual(
    resolveLaunchMode({
      execPath: '/usr/local/bin/node',
      argv: ['node', 'src/server.js'],
      env: {}
    }),
    'direct'
  );

  // 2. verify-exe.js run (dist/TechPartsPOS.exe + POS_DB_PATH)
  assert.strictEqual(
    resolveLaunchMode({
      execPath: 'C:\\Users\\sloth\\Downloads\\phone-repair-pos\\dist\\TechPartsPOS.exe',
      argv: ['C:\\Users\\sloth\\Downloads\\phone-repair-pos\\dist\\TechPartsPOS.exe'],
      env: { POS_DB_PATH: 'C:\\Users\\sloth\\AppData\\Local\\Temp\\shop.db' }
    }),
    'direct'
  );
  // Portable run outside Program Files without POS_DB_PATH also resolves direct
  assert.strictEqual(
    resolveLaunchMode({
      execPath: 'C:\\Users\\sloth\\Desktop\\TechPartsPOS.exe',
      argv: ['C:\\Users\\sloth\\Desktop\\TechPartsPOS.exe'],
      env: {}
    }),
    'direct'
  );

  // 3. Service mode (--service argument)
  assert.strictEqual(
    resolveLaunchMode({
      execPath: 'C:\\Program Files\\TechPartsPOS\\TechPartsPOS.exe',
      argv: ['C:\\Program Files\\TechPartsPOS\\TechPartsPOS.exe', '--service'],
      env: {}
    }),
    'service'
  );
  assert.strictEqual(
    resolveLaunchMode({
      execPath: 'C:\\Program Files (x86)\\TechPartsPOS\\TechPartsPOS.exe',
      argv: ['TechPartsPOS.exe', '--service'],
      env: {}
    }),
    'service'
  );

  // 4. Installed desktop shortcut (Program Files exe with no --service and no POS_DB_PATH)
  assert.strictEqual(
    resolveLaunchMode({
      execPath: 'C:\\Program Files\\TechPartsPOS\\TechPartsPOS.exe',
      argv: ['C:\\Program Files\\TechPartsPOS\\TechPartsPOS.exe'],
      env: {}
    }),
    'launcher'
  );
  assert.strictEqual(
    resolveLaunchMode({
      execPath: 'C:\\Program Files (x86)\\TechPartsPOS\\TechPartsPOS.exe',
      argv: ['C:\\Program Files (x86)\\TechPartsPOS\\TechPartsPOS.exe'],
      env: {}
    }),
    'launcher'
  );
});

test('browserProfileDir respects LOCALAPPDATA or falls back to getBaseDir', () => {
  const { browserProfileDir } = require('../src/server');
  assert.strictEqual(typeof browserProfileDir, 'function', 'browserProfileDir is exported');

  const customLocal = path.join('C:', 'Users', 'Cashier', 'AppData', 'Local');
  assert.strictEqual(
    browserProfileDir({ LOCALAPPDATA: customLocal }),
    path.join(customLocal, 'TechPartsPOS', 'browser-profile')
  );

  const { getBaseDir } = require('../src/db');
  assert.strictEqual(
    browserProfileDir({}),
    path.join(getBaseDir(), 'browser-profile')
  );
});

test('runtimeStatePath resolves runtime/server.json under getBaseDir', () => {
  const { runtimeStatePath } = require('../src/server');
  assert.strictEqual(typeof runtimeStatePath, 'function', 'runtimeStatePath is exported');

  const { getBaseDir } = require('../src/db');
  assert.strictEqual(runtimeStatePath(), path.join(getBaseDir(), 'runtime', 'server.json'));
  assert.strictEqual(runtimeStatePath('C:\\TestBase'), path.join('C:\\TestBase', 'runtime', 'server.json'));
});

test('runInstalledLauncher fast-path opens browser on port from server.json without starting server', async () => {
  const { runInstalledLauncher } = require('../src/server');
  assert.strictEqual(typeof runInstalledLauncher, 'function', 'runInstalledLauncher is exported');

  const launchedUrls = [];
  const probedUrls = [];
  let taskRan = false;
  let errorBoxShown = false;

  const result = await runInstalledLauncher({
    readRuntimeState: () => ({ pid: 9999, port: 3004 }),
    fetchImpl: async (url) => {
      probedUrls.push(url);
      if (url === 'http://127.0.0.1:3004/api/license/status') {
        return { ok: true, status: 200 };
      }
      return { ok: false, status: 404 };
    },
    launchBrowser: async (url) => { launchedUrls.push(url); },
    runTask: () => { taskRan = true; },
    showErrorBox: () => { errorBoxShown = true; }
  });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.port, 3004);
  assert.strictEqual(result.exitCode, 0);
  assert.deepStrictEqual(launchedUrls, ['http://localhost:3004']);
  assert.strictEqual(taskRan, false, 'runTask should not be called on fast-path');
  assert.strictEqual(errorBoxShown, false, 'showErrorBox should not be called on fast-path');
  assert.ok(probedUrls.includes('http://127.0.0.1:3004/api/license/status'));
});

test('runInstalledLauncher recovers by triggering schtasks when server is unreachable initially', async () => {
  const { runInstalledLauncher } = require('../src/server');

  const launchedUrls = [];
  let taskRan = false;
  let taskNameCalled = '';
  let errorBoxShown = false;

  const result = await runInstalledLauncher({
    initialWaitMs: 20,
    totalTimeoutMs: 300,
    sleep: (ms) => new Promise(r => setTimeout(r, 10)),
    readRuntimeState: () => ({ pid: 8888, port: 3001 }),
    fetchImpl: async (url) => {
      // Unreachable until task has been kicked
      if (!taskRan) throw new Error('ECONNREFUSED');
      return { ok: true, status: 200 };
    },
    runTask: (taskName) => {
      taskRan = true;
      taskNameCalled = taskName;
      return true;
    },
    launchBrowser: async (url) => { launchedUrls.push(url); },
    showErrorBox: () => { errorBoxShown = true; }
  });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.port, 3001);
  assert.strictEqual(result.exitCode, 0);
  assert.strictEqual(taskRan, true);
  assert.strictEqual(taskNameCalled, 'TechPartsPOS-Server');
  assert.deepStrictEqual(launchedUrls, ['http://localhost:3001']);
  assert.strictEqual(errorBoxShown, false);
});

test('runInstalledLauncher displays error box and exits 1 when server remains unreachable', async () => {
  const { runInstalledLauncher } = require('../src/server');

  const launchedUrls = [];
  let taskRan = false;
  let errorBoxShown = false;
  let errorBoxMessage = '';

  const result = await runInstalledLauncher({
    initialWaitMs: 15,
    totalTimeoutMs: 60,
    sleep: (ms) => new Promise(r => setTimeout(r, 10)),
    readRuntimeState: () => null,
    fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
    runTask: () => { taskRan = true; return true; },
    launchBrowser: async (url) => { launchedUrls.push(url); },
    showErrorBox: (msg) => {
      errorBoxShown = true;
      errorBoxMessage = msg;
    }
  });

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.exitCode, 1);
  assert.strictEqual(taskRan, true, 'attempts schtasks before giving up');
  assert.strictEqual(errorBoxShown, true);
  assert.match(errorBoxMessage, /Administrator|restart/i);
  assert.strictEqual(launchedUrls.length, 0, 'never launches browser when unreachable');
});

test('--service sets loopback 127.0.0.1 default when HOST is unset', () => {
  const serverPath = path.resolve(__dirname, '..', 'src', 'server.js');
  const tmpScript = path.join(os.tmpdir(), `t_service_host_probe_${process.pid}_${Date.now()}.js`);
  const code = `
const net = require('node:net');
net.Server.prototype.listen = function(...args) {
  const host = typeof args[1] === 'string' ? args[1] : (args[0] && typeof args[0] === 'object' ? args[0].host : null);
  process.stdout.write("BOUND_HOST=" + host + "\\n");
  process.exit(0);
};
process.argv = [process.execPath, 'C:\\\\Program Files\\\\TechPartsPOS\\\\TechPartsPOS.exe', '--service'];
require(${JSON.stringify(serverPath)});
`;
  fs.writeFileSync(tmpScript, code, 'utf8');

  try {
    const res = spawnSync(process.execPath, [tmpScript], {
      env: {
        ...process.env,
        HOST: '', // unset HOST
        NODE_ENV: 'test',
        POS_DB_PATH: path.join(os.tmpdir(), `t_service_probe_${process.pid}.db`)
      },
      timeout: 10000
    });
    const out = (res.stdout || '').toString();
    assert.match(out, /BOUND_HOST=127\.0\.0\.1/, `expected BOUND_HOST=127.0.0.1, got: ${out}`);
  } finally {
    try { fs.unlinkSync(tmpScript); } catch (_) {}
    try { fs.unlinkSync(path.join(os.tmpdir(), `t_service_probe_${process.pid}.db`)); } catch (_) {}
  }
});


serverTest('factory-PIN login yields a session without elevation and answers pin_change_required', async (baseUrl) => {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin: '1234' })
  });
  assert.strictEqual(res.status, 200);
  const data = await res.json();
  assert.ok(data.token, 'a session token is issued so the setup screens work');
  assert.strictEqual(data.pin_change_required, true);
  assert.strictEqual(data.elevationToken, undefined, 'the factory PIN must never mint elevation');
  // The bare session stays locked out of an elevated route (pair-cloud checks
  // elevation before it reads the body, and the factory-PIN gate after).
  const denied = await fetch(`${baseUrl}/api/settings/pair-cloud`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${data.token}` },
    body: JSON.stringify({ url: 'https://example.com', code: '123456' })
  });
  assert.strictEqual(denied.status, 403);
});

serverTest('update posture: progress reads without a session, apply stays locked', async (baseUrl) => {
  // GET /progress is deliberately reachable with no session (the kiosk boot
  // poll and the settings panel both read it); pin that, and pin that POST
  // /apply still demands a session so no LAN peer can start an install.
  const progressRes = await fetch(`${baseUrl}/api/system/update/progress`);
  assert.strictEqual(progressRes.status, 200);
  const progressData = await progressRes.json();
  assert.ok(typeof progressData === 'object');
  const applyRes = await fetch(`${baseUrl}/api/system/update/apply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}'
  });
  assert.strictEqual(applyRes.status, 401);
});
