const test = require('node:test');
const assert = require('node:assert');
const { DatabaseSync } = require('node:sqlite');
const { initDb } = require('../src/db');
const { seedInitialParts } = require('../src/seed');

test('seedInitialParts with zeroStock: true creates 17 parts with 0 stock and no sales', () => {
  const db = initDb(':memory:', new DatabaseSync(':memory:'));
  const count = seedInitialParts(db, { zeroStock: true, skipSales: true });
  assert.strictEqual(count, 17);

  const parts = db.prepare('SELECT stock_quantity FROM inventory').all();
  assert.strictEqual(parts.length, 17);
  for (const part of parts) {
    assert.strictEqual(part.stock_quantity, 0);
  }

  const salesCount = db.prepare('SELECT COUNT(*) as count FROM sales').get().count;
  assert.strictEqual(salesCount, 0);
});

const { dbTest, serverTest, ensurePinChanged } = require('./helper');

serverTest('POST /api/inventory/seed-starter seeds 17 parts when catalog is empty', async (baseUrl, db, auth) => {
  auth = await ensurePinChanged(baseUrl, auth);
  const seedRes = await fetch(`${baseUrl}/api/inventory/seed-starter`, {
    method: 'POST',
    headers: { ...auth }
  });
  assert.strictEqual(seedRes.status, 200);
  const data = await seedRes.json();
  assert.strictEqual(data.ok, true);
  assert.strictEqual(data.count, 17);

  const invCount = db.prepare('SELECT COUNT(*) as c FROM inventory').get().c;
  assert.strictEqual(invCount, 17);
});

serverTest('First-time setup workflow: change PIN, set shop name & printer, seed zero-stock starter parts', async (baseUrl, db, auth) => {
  // 1. Initial state: factory PIN requires change
  const initialSettingsRes = await fetch(`${baseUrl}/api/settings`, { headers: { ...auth } });
  assert.strictEqual(initialSettingsRes.status, 200);
  const initialSettings = await initialSettingsRes.json();
  assert.strictEqual(initialSettings.pin_change_required, true);

  // 2. Change PIN from 1234 to 8888
  const pinRes = await fetch(`${baseUrl}/api/auth/change-pin`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ old_pin: '1234', new_pin: '8888' })
  });
  assert.strictEqual(pinRes.status, 200);
  const pinData = await pinRes.json();
  assert.ok(pinData.token);
  assert.ok(pinData.elevationToken);

  const newAuth = {
    'Authorization': `Bearer ${pinData.token}`,
    'X-Elevation': pinData.elevationToken
  };

  // 3. Save shop name and paper width
  const settingsRes = await fetch(`${baseUrl}/api/settings`, {
    method: 'POST',
    headers: { ...newAuth, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      gcash_name: 'FixZone Phone Repair',
      owner_name: 'Alex Santos',
      shop_address: 'Level 2 Cyberzone, SM Megamall',
      gcash_number: '0918-987-6543',
      shop_footer_note: 'Quality parts, honest service.',
      warranty_days: '14',
      receipt_paper_width: '58mm'
    })
  });
  assert.strictEqual(settingsRes.status, 200);
  const updatedSettings = await settingsRes.json();
  assert.strictEqual(updatedSettings.gcash_name, 'FixZone Phone Repair');
  assert.strictEqual(updatedSettings.owner_name, 'Alex Santos');
  assert.strictEqual(updatedSettings.shop_address, 'Level 2 Cyberzone, SM Megamall');
  assert.strictEqual(updatedSettings.gcash_number, '0918-987-6543');
  assert.strictEqual(updatedSettings.shop_footer_note, 'Quality parts, honest service.');
  assert.strictEqual(updatedSettings.warranty_days, '14');
  assert.strictEqual(updatedSettings.receipt_paper_width, '58mm');
  assert.strictEqual(updatedSettings.pin_change_required, false);

  // 4. Seed zero-stock starter catalog
  const seedRes = await fetch(`${baseUrl}/api/inventory/seed-starter`, {
    method: 'POST',
    headers: { ...newAuth }
  });
  assert.strictEqual(seedRes.status, 200);
  const seedData = await seedRes.json();
  assert.strictEqual(seedData.ok, true);
  assert.strictEqual(seedData.count, 17);

  // 5. Verify inventory has 17 items with 0 stock
  const invRes = await fetch(`${baseUrl}/api/inventory`, { headers: { ...newAuth } });
  assert.strictEqual(invRes.status, 200);
  const inventory = await invRes.json();
  assert.strictEqual(inventory.length, 17);
  for (const item of inventory) {
    assert.strictEqual(item.stock_quantity, 0);
  }

  // 6. Verify sales table is completely clean
  const salesRes = await fetch(`${baseUrl}/api/sales`, { headers: { ...newAuth } });
  assert.strictEqual(salesRes.status, 200);
  const sales = await salesRes.json();
  assert.strictEqual(sales.length, 0);
});

serverTest('Un-elevated first-time setup: change factory PIN and set settings without prior session', async (baseUrl, db) => {
  // Directly call change-pin without Authorization or X-Elevation headers
  const pinRes = await fetch(`${baseUrl}/api/auth/change-pin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ old_pin: '1234', new_pin: '7777' })
  });
  assert.strictEqual(pinRes.status, 200);
  const pinData = await pinRes.json();
  assert.ok(pinData.token);
  assert.ok(pinData.elevationToken);

  // Calling again with old 1234 should now fail
  const failedRes = await fetch(`${baseUrl}/api/auth/change-pin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ old_pin: '1234', new_pin: '9999' })
  });
  // Since PIN is no longer default and no elevation provided, it is denied
  assert.strictEqual(failedRes.status, 403);
});

serverTest('Manager Recovery Password: status, setup, settings reflection, recovery, and expired trial immunity', async (baseUrl, db, auth) => {
  // 1. Unconfigured GET /api/auth/recovery-status -> { configured: false }
  const statusRes = await fetch(`${baseUrl}/api/auth/recovery-status`);
  assert.strictEqual(statusRes.status, 200);
  const statusData = await statusRes.json();
  assert.strictEqual(statusData.configured, false);

  // 2. Change PIN from 1234 to 8888 so factory PIN gate is cleared
  const pinRes = await fetch(`${baseUrl}/api/auth/change-pin`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ old_pin: '1234', new_pin: '8888' })
  });
  assert.strictEqual(pinRes.status, 200);
  const pinData = await pinRes.json();
  const managerAuth = {
    'Authorization': `Bearer ${pinData.token}`,
    'X-Elevation': pinData.elevationToken
  };

  // 3. Staff session rejected (403) on POST /api/auth/recovery-password
  const staffRes = await fetch(`${baseUrl}/api/auth/staff`, {
    method: 'POST',
    headers: { ...managerAuth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Cashier Alice', pin: '5555' })
  });
  assert.strictEqual(staffRes.status, 201);
  const staffUser = await staffRes.json();

  const staffLoginRes = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ staffId: staffUser.id, pin: '5555' })
  });
  assert.strictEqual(staffLoginRes.status, 200);
  const staffLoginData = await staffLoginRes.json();
  const staffAuth = { 'Authorization': `Bearer ${staffLoginData.token}` };

  const staffRecRes = await fetch(`${baseUrl}/api/auth/recovery-password`, {
    method: 'POST',
    headers: { ...staffAuth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ recovery_password: 'secretRecovery123' })
  });
  assert.strictEqual(staffRecRes.status, 403);

  // 4. Manager POST /api/auth/recovery-password -> 200
  const recRes = await fetch(`${baseUrl}/api/auth/recovery-password`, {
    method: 'POST',
    headers: { ...managerAuth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ recovery_password: 'secretRecovery123' })
  });
  assert.strictEqual(recRes.status, 200);
  const recData = await recRes.json();
  assert.strictEqual(recData.success, true);
  assert.strictEqual(recData.recovery_password_configured, true);

  // Verify recovery-status returns configured: true
  const statusRes2 = await fetch(`${baseUrl}/api/auth/recovery-status`);
  assert.strictEqual(statusRes2.status, 200);
  assert.strictEqual((await statusRes2.json()).configured, true);

  // 5. GET /api/settings returns recovery_password_configured: true without hash fields
  const settingsRes = await fetch(`${baseUrl}/api/settings`, { headers: { ...managerAuth } });
  assert.strictEqual(settingsRes.status, 200);
  const settingsData = await settingsRes.json();
  assert.strictEqual(settingsData.recovery_password_configured, true);
  assert.strictEqual(settingsData.recovery_password_hash, undefined);
  assert.strictEqual(settingsData.recovery_failed_attempts, undefined);
  assert.strictEqual(settingsData.recovery_lockout_until, undefined);

  // 6. POST /api/auth/recover-pin wrong password -> 403
  const badRecoverRes = await fetch(`${baseUrl}/api/auth/recover-pin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ recovery_password: 'wrongpassword', new_pin: '9999' })
  });
  assert.strictEqual(badRecoverRes.status, 403);

  // 7. Valid recovery password -> 200 returning token + elevationToken
  const recoverRes = await fetch(`${baseUrl}/api/auth/recover-pin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ recovery_password: 'secretRecovery123', new_pin: '9999' })
  });
  assert.strictEqual(recoverRes.status, 200);
  const recoverData = await recoverRes.json();
  assert.strictEqual(recoverData.success, true);
  assert.ok(recoverData.token);
  assert.ok(recoverData.elevationToken);
  assert.strictEqual(recoverData.actor.type, 'manager');

  // Verify newly issued elevation token can access elevated endpoints
  const checkElevatedRes = await fetch(`${baseUrl}/api/backup/list`, {
    headers: {
      'Authorization': `Bearer ${recoverData.token}`,
      'X-Elevation': recoverData.elevationToken
    }
  });
  assert.strictEqual(checkElevatedRes.status, 200);

  // 8. Expired trial immunity: corrupt trial_seal so trial is expired/required
  db.prepare("INSERT OR REPLACE INTO shop_settings (key, value) VALUES ('trial_seal', 'corrupt-seal-tamper')").run();
  // Normal endpoint is now blocked with 402
  const blockedRes = await fetch(`${baseUrl}/api/inventory`, {
    headers: { 'Authorization': `Bearer ${recoverData.token}` }
  });
  assert.strictEqual(blockedRes.status, 402);

  // recovery-status is licenseExempt (200, not 402)
  const exemptStatusRes = await fetch(`${baseUrl}/api/auth/recovery-status`);
  assert.strictEqual(exemptStatusRes.status, 200);

  // recover-pin is licenseExempt (200, not 402)
  const exemptRecoverRes = await fetch(`${baseUrl}/api/auth/recover-pin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ recovery_password: 'secretRecovery123', new_pin: '7777' })
  });
  assert.strictEqual(exemptRecoverRes.status, 200);
});

serverTest('GET /api/license/status includes service_mode and POST /api/system/shutdown handles service mode', async (baseUrl, db, auth) => {
  auth = await ensurePinChanged(baseUrl, auth);
  const licRes = await fetch(`${baseUrl}/api/license/status`);
  assert.strictEqual(licRes.status, 200);
  const licData = await licRes.json();
  assert.strictEqual(typeof licData.service_mode, 'boolean');
  assert.strictEqual(licData.service_mode, false);

  // In normal mode, shutdown succeeds
  const normalShutdown = await fetch(`${baseUrl}/api/system/shutdown`, {
    method: 'POST',
    headers: { ...auth }
  });
  assert.strictEqual(normalShutdown.status, 200);
});

test('service mode via POS_TEST_SERVICE_MODE env: status returns service_mode: true and shutdown returns 400', async () => {
  process.env.POS_TEST_SERVICE_MODE = '1';
  let server, db;
  try {
    const { createServer } = require('../src/server');
    const res = createServer({ dbPath: ':memory:' });
    server = res.server;
    db = res.db;
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const baseUrl = `http://127.0.0.1:${port}`;

    const licRes = await fetch(`${baseUrl}/api/license/status`);
    assert.strictEqual(licRes.status, 200);
    const licData = await licRes.json();
    assert.strictEqual(licData.service_mode, true);

    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: '1234' })
    });
    const loginData = await loginRes.json();

    const shutRes = await fetch(`${baseUrl}/api/system/shutdown`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${loginData.token}` }
    });
    assert.strictEqual(shutRes.status, 400);
    const shutData = await shutRes.json();
    assert.match(shutData.error, /Background server stays active in installed mode/i);
  } finally {
    delete process.env.POS_TEST_SERVICE_MODE;
    if (server) await new Promise(resolve => server.close(resolve));
    try { db?.close(); } catch (_) {}
  }
});
