// phone-repair-pos/tests/backup-restore.test.js
// Restore-from-backup: the picked .db file replaces the live database in the
// same process, a pre-restore safety snapshot lands in the list first, and
// hostile filenames / corrupt files are refused.
// This file runs in its own test process, so the env override below is seen
// before src/server computes its runtime backup dir.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.env.POS_BACKUP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-restore-'));

const assert = require('node:assert/strict');
const { dbTest, serverTest, ensurePinChanged } = require('./helper');
const { createInventoryItem } = require('../src/inventory');
const { createSale } = require('../src/sales');
const { getPeriodStats } = require('../src/analytics');

const authed = (auth, extra = {}) => ({ ...auth, ...extra });
const postJson = (baseUrl, auth, pathname, body) => fetch(`${baseUrl}${pathname}`, {
  method: 'POST',
  headers: authed(auth, { 'Content-Type': 'application/json' }),
  body: JSON.stringify(body)
});

serverTest('restore replaces the live database with the picked backup', async (baseUrl, db, auth) => {
  auth = await ensurePinChanged(baseUrl, auth); // restore refuses the factory PIN
  const dir = process.env.POS_BACKUP_DIR;
  const part = createInventoryItem(db, {
    brand: 'Restore', model_name: 'R1', part_type: 'LCD',
    cost_price: 10.0, price_retail: 50.0, stock_quantity: 3
  });
  const sale = createSale(db, { payment_method: 'cash', items: [{ inventory_id: part.id, quantity: 1, unit_price: 50.0 }], amount_paid: 50.0 });
  assert.ok(sale.id);

  // Snapshot: exactly one part and one sale from here on.
  const bRes = await fetch(`${baseUrl}/api/backup`, { method: 'POST', headers: authed(auth) });
  assert.equal(bRes.status, 200);
  const { backup_file: file } = await bRes.json();

  // Live-only data added after the snapshot — restore must make it vanish.
  createInventoryItem(db, {
    brand: 'Restore', model_name: 'R2-live-only', part_type: 'Battery',
    cost_price: 5.0, price_retail: 20.0, stock_quantity: 9
  });

  const list = await (await fetch(`${baseUrl}/api/backup/list`, { headers: authed(auth) })).json();
  assert.ok(list.backups.some(b => b.file === file), 'the manual backup is listed as a restore candidate');

  // Custom range over HTTP: picked start wins, end defaults to today.
  const from = db.prepare(`SELECT date('now','localtime','-13 days') AS d`).get().d;
  const dash = await (await fetch(`${baseUrl}/api/dashboard?period=custom&from=${from}`, { headers: authed(auth) })).json();
  assert.equal(dash.range.from, from);
  assert.equal(dash.current.sale_count, 1);

  const rRes = await postJson(baseUrl, auth, '/api/backup/restore', { file });
  assert.equal(rRes.status, 200);
  const rData = await rRes.json();
  assert.equal(rData.restored_from, file);
  assert.match(rData.pre_restore_backup, /^shop_backup_pre-restore_/);
  assert.ok(fs.existsSync(path.join(dir, rData.pre_restore_backup)), 'safety snapshot landed in the backups folder');

  // The server handle was swapped: reads go over HTTP against the restored file.
  const parts = await (await fetch(`${baseUrl}/api/inventory`, { headers: authed(auth) })).json();
  assert.equal(parts.length, 1, 'post-restore part list matches the snapshot');
  assert.equal(parts[0].model_name, 'R1');

  const salesRes = await fetch(`${baseUrl}/api/sales?search=${sale.sale_code}`, { headers: authed(auth) });
  const sales = await salesRes.json();
  assert.equal(sales.length, 1, 'the snapshotted sale is back');

  const listAfter = await (await fetch(`${baseUrl}/api/backup/list`, { headers: authed(auth) })).json();
  assert.ok(listAfter.backups.some(b => b.file === rData.pre_restore_backup), 'the restore itself is undoable from the same list');

  // Restore the restore: the live-only part comes back.
  const undo = await postJson(baseUrl, auth, '/api/backup/restore', { file: rData.pre_restore_backup });
  assert.equal(undo.status, 200);
  const partsAfter = await (await fetch(`${baseUrl}/api/inventory`, { headers: authed(auth) })).json();
  assert.equal(partsAfter.length, 2, 'undoing the restore returns the live data');
});

serverTest('restore refuses traversal, strangers, and corrupt files', async (baseUrl, db, auth) => {
  auth = await ensurePinChanged(baseUrl, auth); // restore refuses the factory PIN
  const dir = process.env.POS_BACKUP_DIR;
  fs.writeFileSync(path.join(dir, 'shop_backup_junk.db'), 'garbage bytes, not a database');

  const traversal = await postJson(baseUrl, auth, '/api/backup/restore', { file: '../data/shop.db' });
  assert.equal(traversal.status, 400);

  const stranger = await postJson(baseUrl, auth, '/api/backup/restore', { file: 'unrelated.db' });
  assert.equal(stranger.status, 400);

  const missing = await postJson(baseUrl, auth, '/api/backup/restore', { file: 'shop_backup_ghost.db' });
  assert.equal(missing.status, 400);

  const junk = await postJson(baseUrl, auth, '/api/backup/restore', { file: 'shop_backup_junk.db' });
  assert.equal(junk.status, 400);
  assert.match((await junk.json()).error, /integrity/i);

  // The folder also holds leftovers from the round-trip test (same process,
  // same dir): the filter only has to prove strangers never surface.
  fs.writeFileSync(path.join(dir, 'unrelated.db'), 'x');
  const files = (await (await fetch(`${baseUrl}/api/backup/list`, { headers: authed(auth) })).json()).backups.map(b => b.file);
  assert.ok(files.includes('shop_backup_junk.db'), 'shop-family files are offered');
  assert.ok(!files.includes('unrelated.db'), 'stranger files are filtered out');
});

dbTest('custom range spans the picked start and end dates', (db) => {
  const part = createInventoryItem(db, {
    brand: 'Custom', model_name: 'C1', part_type: 'LCD',
    cost_price: 10.0, price_retail: 50.0, stock_quantity: 5
  });
  const sale = createSale(db, { payment_method: 'cash', items: [{ inventory_id: part.id, quantity: 1, unit_price: 50.0 }], amount_paid: 50.0 });
  db.prepare(`UPDATE sales SET created_at = datetime('now', '-10 days') WHERE id = ?`).run(sale.id);

  const localDate = expr => db.prepare(`SELECT date('now','localtime',${expr}) AS d`).get().d;

  // 14-day custom window ending today: the 10-day-old sale is inside.
  const wide = getPeriodStats(db, 'custom', null, localDate(`'-13 days'`));
  assert.equal(wide.period, 'custom');
  assert.equal(wide.days, 14);
  assert.equal(wide.range.from, localDate(`'-13 days'`));
  assert.equal(wide.range.to, localDate(`'0 days'`));
  assert.equal(wide.current.sale_count, 1);
  // The equal-length previous window is the 14 days before the start.
  assert.equal(wide.previous_range.from, localDate(`'-27 days'`));

  // 7-day custom window ending today: the sale is outside.
  const narrow = getPeriodStats(db, 'custom', null, localDate(`'-6 days'`));
  assert.equal(narrow.current.sale_count, 0);
  assert.equal(narrow.previous_range.to, localDate(`'-7 days'`));

  // A start after the end is not a range.
  assert.throws(
    () => getPeriodStats(db, 'custom', localDate(`'-10 days'`), localDate(`'-2 days'`)),
    /start date/
  );
});
