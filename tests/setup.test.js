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
