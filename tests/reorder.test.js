// phone-repair-pos/tests/reorder.test.js
// Auto reorder sheet: sold-in-window demand per part, grouped by supplier.
const assert = require('node:assert');
const { dbTest, serverTest } = require('./helper');
const {
  createInventoryItem,
  archiveInventoryItem,
  listReorderSuggestions
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
