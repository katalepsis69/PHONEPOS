// phone-repair-pos/tests/reorder.test.js
// Auto reorder sheet: sold-in-window demand per part, grouped by supplier.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test').test;
const { dbTest, serverTest } = require('./helper');
const {
  createInventoryItem,
  archiveInventoryItem,
  listReorderSuggestions,
  importInventory,
  getInventoryItem
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
