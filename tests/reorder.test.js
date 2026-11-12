// phone-repair-pos/tests/reorder.test.js
// Auto reorder sheet: sold-in-window demand per part, grouped by supplier.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test').test;
const { dbTest, serverTest, ensurePinChanged } = require('./helper');
const {
  createInventoryItem,
  archiveInventoryItem,
  listReorderSuggestions,
  importInventory,
  getInventoryItem,
  receiveInventory
} = require('../src/inventory');
const { createSale, voidSale } = require('../src/sales');
const { createStaff } = require('../src/auth');

const ctxMgr = { actor: { type: 'manager', id: null, name: 'Manager' }, elevated: true };
const backdate = (db, saleId, daysAgo) =>
  db.prepare('UPDATE sales SET created_at = ? WHERE id = ?').run(new Date(Date.now() - daysAgo * 86400000).toISOString(), saleId);

dbTest('Reorder list: suggested = sold - on hand; voided, archived, labor excluded', (db) => {
  const a = createInventoryItem(db, {
    brand: 'Samsung', model_name: 'S21', part_type: 'OLED', sku_barcode: 'S21-OLED',
    cost_price: 100, price_retail: 200, price_technician: 150, stock_quantity: 7, supplier: 'ABC Parts'
  });
  const b = createInventoryItem(db, {
    brand: 'Infinix', model_name: 'Hot 10', part_type: 'Battery',
    cost_price: 50, price_retail: 120, price_technician: 90, stock_quantity: 4, supplier: ''
  });
  const c = createInventoryItem(db, {
    brand: 'Oppo', model_name: 'A54', part_type: 'LCD',
    cost_price: 80, price_retail: 160, price_technician: 120, stock_quantity: 6, supplier: 'XYZ'
  });

  // a: 5 sold (3 + 2) -> stock 2 -> suggest 3 @ 100 = 300. b: 1 sold -> stock 3 -> suggest 0.
  // Labor rides along (inventory_id NULL) and must not break the join.
  const s1 = createSale(db, {
    items: [{ inventory_id: a.id, quantity: 3 }, { inventory_id: b.id, quantity: 1 },
      { item_type: 'labor', item_name: 'Install', unit_price: 50, quantity: 1 }],
    amount_paid: 1000
  }, ctxMgr);
  assert.ok(s1.id > 0);
  createSale(db, { items: [{ inventory_id: a.id, quantity: 2 }], amount_paid: 1000 }, ctxMgr);
  // c: sold in a sale that then gets voided, and the part is archived — both
  // independently disqualify it from the sheet.
  const s2 = createSale(db, { items: [{ inventory_id: c.id, quantity: 1 }], amount_paid: 500 }, ctxMgr);
  archiveInventoryItem(db, c.id, true, ctxMgr);
  voidSale(db, s2.id, 'reorder test void', ctxMgr);

  const report = listReorderSuggestions(db, { days: 3 });
  assert.strictEqual(report.days, 3);
  // '' supplier sorts before 'ABC Parts'; voided+archived c is gone entirely.
  assert.deepStrictEqual(report.rows.map(r => r.id), [b.id, a.id]);
  const byId = Object.fromEntries(report.rows.map(r => [r.id, r]));

  assert.strictEqual(byId[a.id].qty_sold, 5);
  assert.strictEqual(byId[a.id].stock_quantity, 2);
  assert.strictEqual(byId[a.id].suggested_qty, 3);
  assert.strictEqual(byId[a.id].est_cost, 300);
  assert.strictEqual(byId[a.id].supplier, 'ABC Parts');

  assert.strictEqual(byId[b.id].qty_sold, 1);
  assert.strictEqual(byId[b.id].suggested_qty, 0);
  assert.strictEqual(byId[b.id].est_cost, 0);

  assert.ok(!byId[c.id]);
});

dbTest('Reorder list: sales outside the window drop out; days clamps to 1-90 (default 3)', (db) => {
  const item = createInventoryItem(db, {
    brand: 'Xiaomi', model_name: 'Redmi 12', part_type: 'LCD',
    cost_price: 90, price_retail: 180, price_technician: 140, stock_quantity: 10
  });
  const sale = createSale(db, { items: [{ inventory_id: item.id, quantity: 2 }], amount_paid: 500 }, ctxMgr);
  backdate(db, sale.id, 40);

  assert.strictEqual(listReorderSuggestions(db, { days: 3 }).rows.length, 0);
  const wide = listReorderSuggestions(db, { days: 90 });
  assert.strictEqual(wide.rows.length, 1);
  assert.strictEqual(wide.rows[0].qty_sold, 2);
  assert.strictEqual(wide.rows[0].suggested_qty, 0);

  assert.strictEqual(listReorderSuggestions(db, { days: 0 }).days, 3);
  assert.strictEqual(listReorderSuggestions(db, { days: 500 }).days, 3);
  assert.strictEqual(listReorderSuggestions(db, { days: 2.5 }).days, 3);
  assert.strictEqual(listReorderSuggestions(db, {}).days, 3);
});

serverTest('Reorder route: manager sees est costs, staff gets them stripped', async (baseUrl, db, auth) => {
  const item = createInventoryItem(db, {
    brand: 'Vivo', model_name: 'Y20', part_type: 'LCD',
    cost_price: 100, price_retail: 220, price_technician: 170, stock_quantity: 4, supplier: 'ABC Parts'
  });
  createSale(db, { items: [{ inventory_id: item.id, quantity: 4 }], amount_paid: 1000 }, ctxMgr);

  const mgrRes = await fetch(`${baseUrl}/api/inventory/reorder?days=3`, { headers: auth });
  assert.strictEqual(mgrRes.status, 200);
  const mgrReport = await mgrRes.json();
  assert.strictEqual(mgrReport.days, 3);
  assert.strictEqual(mgrReport.rows.length, 1);
  assert.strictEqual(mgrReport.rows[0].est_cost, 400);
  assert.strictEqual(mgrReport.rows[0].cost_price, 100);

  const jun = createStaff(db, 'Jun', '4321');
  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ staffId: jun.id, pin: '4321' })
  });
  const staffAuth = { Authorization: `Bearer ${(await login.json()).token}` };

  const staffRes = await fetch(`${baseUrl}/api/inventory/reorder?days=3`, { headers: staffAuth });
  assert.strictEqual(staffRes.status, 200);
  const staffReport = await staffRes.json();
  assert.strictEqual(staffReport.rows.length, 1);
  assert.strictEqual(staffReport.rows[0].qty_sold, 4);
  assert.strictEqual(staffReport.rows[0].suggested_qty, 4);
  assert.strictEqual(staffReport.rows[0].est_cost, null);
  assert.strictEqual(staffReport.rows[0].cost_price, null);
});

// UI contract: ONE copy button (toolbar), editable order quantities whose
// inputs are what the copy text reads, and no orphaned i18n key left behind.
test('Reorder UI: single copy button, editable quantities, i18n keys consistent', () => {
  const root = path.join(__dirname, '..');
  const index = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  assert.strictEqual((index.match(/data-reorder-copy/g) || []).length, 1, 'there must be exactly one copy button');
  assert.match(index, /data-i18n="inv\.reorder_copy"/);

  const view = fs.readFileSync(path.join(root, 'public', 'js', 'views', 'inventory.js'), 'utf8');
  assert.match(view, /type="number"[^>]*data-qty-id/, 'order quantities must be editable inputs');
  assert.match(view, /function updateReorderMoney/, 'edits must re-price rows and groups');
  assert.match(view, /const estCellHtml/, 'est cost has one cell renderer for render and live edits');
  assert.match(view, /reorder-unit/, 'row totals carry the unit-cost anchor');
  assert.ok(!view.includes('data-reorder-copy="${escHtml(g.supplier)}"'), 'per-group copy buttons must stay removed');

  const i18n = fs.readFileSync(path.join(root, 'public', 'js', 'i18n.js'), 'utf8');
  assert.ok(!i18n.includes('inv.reorder_copy_all'), 'removed key must not linger in either dictionary');
  assert.ok(i18n.includes("'inv.reorder_copy'"));

  const styles = fs.readFileSync(path.join(root, 'public', 'styles.css'), 'utf8');
  assert.match(styles, /\.reorder-qty\s*\{[^}]*height:\s*44px/, 'order qty input meets the 44px touch target');
  assert.match(styles, /\[data-reorder-group\] > h3\s*\{[^}]*padding-inline:\s*10px/, 'group heading lines up with the item column');
  assert.match(styles, /\.reorder-unit\s*\{[^}]*display:\s*block/, 'ea anchor drops under the total so money aligns with the subtotal');
});

// Alignment contract: footer subtotal cells must carry body-cell padding, or
// the UA's ~1px td padding lets the total overhang past the money column edge.
test('Reorder footer: subtotal cells align with the column edges above', () => {
  const styles = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  assert.match(styles, /\.ptable tfoot td\s*\{[^}]*padding:\s*6px 10px/, 'footer cells mirror body-cell padding');
  assert.match(styles, /\.ptable tfoot td\s*\{[^}]*padding:\s*5px 8px/, 'footer padding tracks the compact rows');
});

dbTest('Reorder export format round-trips into importInventory() with full fidelity', async (db) => {
  const importer = await import('../public/js/importer.js');
  const part = createInventoryItem(db, {
    brand: 'Apple', model_name: 'iPhone 11', part_type: 'LCD', sku_barcode: 'IP11-LCD',
    cost_price: 600, price_retail: 1200, price_technician: 900, stock_quantity: 5,
    min_stock_alert: 5, supplier: 'Greenhills Wholesale', location: 'Bin A1'
  });
  createSale(db, { items: [{ inventory_id: part.id, quantity: 3 }], amount_paid: 3600 }, ctxMgr);

  const report = listReorderSuggestions(db, { days: 5 });
  assert.strictEqual(report.rows.length, 1);
  const row = report.rows[0];
  assert.strictEqual(row.qty_sold, 3);
  assert.strictEqual(row.stock_quantity, 2);
  assert.strictEqual(row.suggested_qty, 1);
  assert.strictEqual(row.price_retail, 1200);
  assert.strictEqual(row.price_technician, 900);
  assert.strictEqual(row.min_stock_alert, 5);
  assert.strictEqual(row.location, 'Bin A1');

  const headers = ['Brand', 'Model Name', 'Part Type', 'SKU / Barcode', 'Capital', 'Retail Price', 'Wholesale Price', 'Sold', 'In Stock', 'Stock Qty', 'Min Stock Alert', 'Supplier', 'Location'];
  const map = importer.matchHeaders(headers);
  for (const col of Object.keys(map)) assert.ok(map[col] !== -1, `${col} must map to a column`);
  assert.strictEqual(map.stock_quantity, 9, 'Stock Qty column (not Sold or In Stock) maps to stock_quantity');

  const uneditedRow = {
    brand: row.brand,
    model_name: row.model_name,
    part_type: row.part_type,
    sku_barcode: row.sku_barcode,
    cost_price: row.cost_price,
    price_retail: row.price_retail,
    price_technician: row.price_technician,
    min_stock_alert: row.min_stock_alert,
    supplier: row.supplier,
    location: row.location
  };
  importInventory(db, [uneditedRow], ctxMgr, { auto_price: false });
  assert.strictEqual(getInventoryItem(db, part.id).stock_quantity, 2, 'blank Stock Qty leaves stock untouched');

  const exportRow = { ...uneditedRow, stock_quantity: 3 };
  const res = importInventory(db, [exportRow], ctxMgr, { auto_price: false });
  assert.strictEqual(res.updated, 1);
  assert.strictEqual(res.created, 0);

  const updated = getInventoryItem(db, part.id);
  assert.strictEqual(updated.stock_quantity, 5);
});

test('Reorder UI: Export CSV button, custom days input, and actions wired', () => {
  const root = path.join(__dirname, '..');
  const index = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  assert.match(index, /data-action="export-reorder-csv"/, 'Export CSV action wired');
  assert.match(index, /data-i18n="inv\.reorder_export"/, 'Export CSV i18n label present');
  assert.match(index, /id="inv-reorder-custom-days"/, 'Custom days input element present');
  assert.match(index, /value="custom"/, 'Custom days option present in dropdown');
  assert.match(index, /id="inv-reorder-summary"/, 'Live reorder summary badge present');
  assert.match(index, /id="inv-bulk-hint" class="inv-bulk-hint"/, 'Bulk hint uses padded subbar class');

  const view = fs.readFileSync(path.join(root, 'public', 'js', 'views', 'inventory.js'), 'utf8');
  assert.match(view, /function exportReorderCsv/, 'exportReorderCsv defined in inventory view');
  assert.match(view, /reorder-custom-days/, 'custom days input listener wired');
  assert.match(view, /function updateReorderSummary/, 'live reorder summary updater defined');

  const styles = fs.readFileSync(path.join(root, 'public', 'styles.css'), 'utf8');
  assert.match(styles, /\.reorder-days-input\s*\{[^}]*appearance:\s*textfield/, 'custom days input strips native spin buttons and chevron padding');
  assert.match(styles, /\.inv-bulk-hint\s*\{[^}]*padding:\s*6px 10px/, 'bulk hint has counter subbar padding');

  const main = fs.readFileSync(path.join(root, 'public', 'js', 'main.js'), 'utf8');
  assert.match(main, /'export-reorder-csv':/, 'export-reorder-csv registered in main ACTIONS');
});

test('Cloud Reorder parity, Stock CSV Import, and Two-Way Stock Sync end-to-end', async () => {
  const os = require('node:os');
  const { initDb } = require('../src/db');
  const { drainOutbox } = require('../src/sync');
  const { startCloud, stopCloud, login, TOKEN_A } = require('./cloud-hardening-harness');

  const shopDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-stock-sync-shop-'));
  const cloudDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-stock-sync-cloud-'));
  fs.writeFileSync(path.join(cloudDir, 'manager-pin.txt'), '2468\n');
  const db = initDb(path.join(shopDir, 'shop.db'));
  let child;
  try {
    const partA = createInventoryItem(db, {
      brand: 'Apple', model_name: 'iPhone 13', part_type: 'LCD', sku_barcode: 'IP13-LCD',
      cost_price: 1000, price_retail: 2200, price_technician: 1800, stock_quantity: 5,
      min_stock_alert: 3, supplier: 'Quiapo Parts', location: 'Bin B2'
    });
    createSale(db, { items: [{ inventory_id: partA.id, quantity: 3 }], amount_paid: 6600 }, ctxMgr);

    const running = await startCloud(cloudDir, { SHOP_SYNC_CREDENTIALS: JSON.stringify({ north: TOKEN_A }) });
    child = running.child;
    db.prepare("INSERT OR REPLACE INTO shop_settings (key, value) VALUES ('sync_url', ?)").run(running.base);
    db.prepare("INSERT OR REPLACE INTO shop_settings (key, value) VALUES ('sync_token', ?)").run(TOKEN_A);

    while ((await drainOutbox(db)).synced > 0) {}

    const { cookie } = await login(running.base);
    const auth = { Cookie: cookie, 'Content-Type': 'application/json' };

    // 1. Cloud /api/inventory/reorder?days=custom matches workstation listReorderSuggestions
    const cloudReorderRes = await fetch(`${running.base}/api/inventory/reorder?days=5`, { headers: { Cookie: cookie } });
    assert.strictEqual(cloudReorderRes.status, 200);
    const cloudReorder = await cloudReorderRes.json();
    assert.strictEqual(cloudReorder.days, 5);
    assert.strictEqual(cloudReorder.rows.length, 1);
    assert.strictEqual(cloudReorder.rows[0].brand, 'Apple');
    assert.strictEqual(cloudReorder.rows[0].sku_barcode, 'IP13-LCD');
    assert.strictEqual(cloudReorder.rows[0].qty_sold, 3);
    assert.strictEqual(cloudReorder.rows[0].stock_quantity, 2);
    // Parity with the counter sheet (suggested = sold - on hand): 3 - 2 = 1.
    // The cloud used to buy up max(sold, deficit, 1) = 3, disagreeing with the
    // workstation; both now use the net replenishment need.
    assert.strictEqual(cloudReorder.rows[0].suggested_qty, 1);
    assert.strictEqual(cloudReorder.rows[0].supplier, 'Quiapo Parts');

    // 2. Cloud POST /api/inventory/adjust-stock updates cloud mirror immediately and syncs down to shop POS
    const adjRes = await fetch(`${running.base}/api/inventory/adjust-stock`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ id: partA.id, delta: 6, reason: 'receive', note: 'Cloud delivery' }),
    });
    assert.strictEqual(adjRes.status, 200);
    const adjBody = await adjRes.json();
    assert.strictEqual(adjBody.ok, true);
    assert.strictEqual(adjBody.item.stock_quantity, 8, 'cloud mirror updated immediately from 2 to 8');

    // Before shop POS heartbeat, /api/overview exposes pending_commands = 1 and item delta
    const ovBefore = await (await fetch(`${running.base}/api/overview`, { headers: { Cookie: cookie } })).json();
    assert.strictEqual(ovBefore.pending_commands, 1, 'overview shows 1 unacked command queued for counter');
    assert.strictEqual(ovBefore.pending_command_items.length, 1);
    assert.strictEqual(ovBefore.pending_command_items[0].inventory_id, partA.id);
    assert.strictEqual(ovBefore.pending_command_items[0].delta, 6);

    // Shop POS heartbeat drains and applies the cloud command
    const hb1 = await drainOutbox(db);
    assert.strictEqual(hb1.commands_applied, 1, 'shop POS applied the adjust_stock command');
    assert.strictEqual(getInventoryItem(db, partA.id).stock_quantity, 8, 'local shop DB stock updated to 8');

    // After shop POS heartbeat acks the command, /api/overview shows pending_commands = 0
    const ovAfter = await (await fetch(`${running.base}/api/overview`, { headers: { Cookie: cookie } })).json();
    assert.strictEqual(ovAfter.pending_commands, 0, 'overview shows 0 pending commands once counter synced');
    assert.strictEqual(ovAfter.pending_command_items.length, 0);

    // Second heartbeat applies 0 commands (already acked)
    const hb2 = await drainOutbox(db);
    assert.strictEqual(hb2.commands_applied, 0, 'acked command is not re-applied');
    assert.strictEqual(getInventoryItem(db, partA.id).stock_quantity, 8);

    // 3. Cloud POST /api/inventory/import updates existing part (+4) and creates new part (+10)
    const impRes = await fetch(`${running.base}/api/inventory/import`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        rows: [
          // Unedited reorder row (Stock Qty = 0 / blank) -> +0 stock change
          { brand: 'Apple', model_name: 'iPhone 13', part_type: 'LCD', sku_barcode: 'IP13-LCD', cost_price: 1000, price_retail: 2200, stock_quantity: 0 },
          // Filled reorder row -> +4 added
          { brand: 'Apple', model_name: 'iPhone 13', part_type: 'LCD', sku_barcode: 'IP13-LCD', cost_price: 1000, price_retail: 2200, stock_quantity: 4 },
          // New part from CSV -> created with 10 stock
          { brand: 'Samsung', model_name: 'A54', part_type: 'Battery', sku_barcode: 'SAM-A54-BAT', cost_price: 400, price_retail: 900, stock_quantity: 10, supplier: 'Quiapo Parts' },
        ],
      }),
    });
    assert.strictEqual(impRes.status, 200);
    const impBody = await impRes.json();
    assert.strictEqual(impBody.created, 1);
    assert.strictEqual(impBody.updated, 2);

    // Verify cloud mirror has both items with updated stock immediately
    const cloudCatalog = await (await fetch(`${running.base}/api/rows?table=inventory&limit=5000`, { headers: { Cookie: cookie } })).json();
    const cloudIp13 = cloudCatalog.find(i => i.sku_barcode === 'IP13-LCD');
    const cloudA54 = cloudCatalog.find(i => i.sku_barcode === 'SAM-A54-BAT');
    assert.strictEqual(cloudIp13.stock_quantity, 12, 'cloud mirror added +4 to 8 -> 12');
    assert.strictEqual(cloudA54.stock_quantity, 10, 'cloud mirror created new part with 10');

    // Shop POS drains and applies the import_inventory command
    const hb3 = await drainOutbox(db);
    assert.strictEqual(hb3.commands_applied, 1, 'shop POS applied import_inventory command');
    assert.strictEqual(getInventoryItem(db, partA.id).stock_quantity, 12, 'local shop DB updated to 12');
    const localA54 = db.prepare("SELECT * FROM inventory WHERE sku_barcode = 'SAM-A54-BAT'").get();
    assert.ok(localA54, 'new part created in local shop DB');
    assert.strictEqual(localA54.stock_quantity, 10);
  } finally {
    if (child) await stopCloud(child);
    try { db.close(); } catch (_) {}
    try { fs.rmSync(shopDir, { recursive: true, force: true }); } catch (_) {}
    try { fs.rmSync(cloudDir, { recursive: true, force: true }); } catch (_) {}
  }
});

test('Cloud UI: Reorder toolbar, Stock catalog/import/export actions, and CSV parser wired', () => {
  const root = path.join(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'cloud', 'public', 'index.html'), 'utf8');
  const appJs = fs.readFileSync(path.join(root, 'cloud', 'public', 'app.js'), 'utf8');

  assert.match(html, /id="cloud-reorder-bar"/);
  assert.match(html, /id="cloud-reorder-custom-days"/);
  assert.match(html, /id="cloud-copy-order-btn"/);
  assert.match(html, /id="cloud-export-reorder-btn"/);
  assert.match(html, /id="cloud-import-reorder-btn"/);
  assert.match(html, /id="cloud-stock-bar"/);
  assert.match(html, /id="cloud-import-stock-btn"/);
  assert.match(html, /id="cloud-template-csv-btn"/);
  assert.match(html, /id="cloud-export-stock-btn"/);
  assert.match(html, /id="stock-modal"/);
  assert.match(html, /id="import-modal"/);
  assert.match(html, /id="sync-state-badge"/);

  assert.match(appJs, /function exportCloudReorderCsv/);
  assert.match(appJs, /function parseCloudImportRows/);
  assert.match(appJs, /function updateCloudSyncStateBadge/);
  assert.match(appJs, /function getPendingDeltaForItem/);
  assert.match(appJs, /\/api\/inventory\/adjust-stock/);
  assert.match(appJs, /\/api\/inventory\/import/);
});

// Receiving closes the loop the reorder sheet opens: one call per supplier
// batch, quantity in, optional new cost, whole batch or nothing.
dbTest('receiveInventory adds stock, can reprice, and rejects bad lines atomically', (db) => {
  const a = createInventoryItem(db, { brand: 'Samsung', model_name: 'S21', part_type: 'OLED', cost_price: 100, price_retail: 200, price_technician: 150, stock_quantity: 7, supplier: 'ABC Parts' });
  const b = createInventoryItem(db, { brand: 'Infinix', model_name: 'Hot 10', part_type: 'Battery', cost_price: 50, price_retail: 120, price_technician: 90, stock_quantity: 4, supplier: 'XYZ' });

  const rows = receiveInventory(db, [
    { id: a.id, quantity: 5, unit_cost: 95 },
    { id: b.id, quantity: 2 }
  ], ctxMgr);
  assert.equal(rows[0].received, 5);
  assert.equal(rows[0].unit_cost, 95);
  assert.equal(rows[1].unit_cost, 50, 'no unit_cost keeps the old cost');
  assert.equal(getInventoryItem(db, a.id).stock_quantity, 12);
  assert.equal(getInventoryItem(db, a.id).cost_price, 95);
  assert.equal(getInventoryItem(db, b.id).stock_quantity, 6);
  assert.equal(getInventoryItem(db, b.id).cost_price, 50);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM stock_movements WHERE reason = 'receive' AND note = 'Supplier receive'").get().n, 2);
  assert.ok(db.prepare("SELECT id FROM audit_log WHERE action = 'adjust_stock'").get(), 'per-line audit rides adjustStock');

  assert.throws(() => receiveInventory(db, [{ id: a.id, quantity: 1 }, { id: b.id, quantity: 0 }], ctxMgr), /quantity must be greater/);
  assert.equal(getInventoryItem(db, a.id).stock_quantity, 12, 'batch atomic: first line not applied');
  assert.throws(() => receiveInventory(db, [{ id: 99999, quantity: 1 }], ctxMgr), /part not found/);
  assert.throws(() => receiveInventory(db, [{ id: a.id, quantity: 1, unit_cost: -3 }], ctxMgr), /unit cost must be zero or more/);
  assert.throws(() => receiveInventory(db, [], ctxMgr), /1 to 100/);
});

serverTest('/api/inventory/receive is elevation-gated and receives stock', async (base, db, auth) => {
  auth = await ensurePinChanged(base, auth);
  const item = createInventoryItem(db, { brand: 'Test', model_name: 'R', part_type: 'X', cost_price: 10, price_retail: 20, price_technician: 15, stock_quantity: 1 });
  const denied = await fetch(`${base}/api/inventory/receive`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: auth.Authorization },
    body: JSON.stringify({ items: [{ id: item.id, quantity: 1 }] })
  });
  assert.equal(denied.status, 403);
  const ok = await fetch(`${base}/api/inventory/receive`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({ items: [{ id: item.id, quantity: 3, unit_cost: 9 }] })
  });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json())[0].received, 3);
  assert.equal(getInventoryItem(db, item.id).stock_quantity, 4);
  assert.equal(getInventoryItem(db, item.id).cost_price, 9);
  const bad = await fetch(`${base}/api/inventory/receive`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({ items: [] })
  });
  assert.equal(bad.status, 400);
});
