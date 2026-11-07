// phone-repair-pos/tests/dash-scope.test.js
// Reports & profit scope: date anchoring for every period, per-bucket profit
// trend with refunds allocated to the day they happened, and the exceptions
// list covering every return type over any window.
const assert = require('node:assert');
const { dbTest } = require('./helper');
const { createInventoryItem } = require('../src/inventory');
const { createSale } = require('../src/sales');
const { getPeriodStats, getProductPerformance, getExceptions } = require('../src/analytics');
const { createWarrantyReturn } = require('../src/returns');

const setSaleAge = (db, saleId, daysAgo) =>
  db.prepare(`UPDATE sales SET created_at = datetime('now', ?) WHERE id = ?`).run(`-${daysAgo} days`, saleId);
const setReturnAge = (db, returnId, daysAgo) =>
  db.prepare(`UPDATE warranty_returns SET created_at = datetime('now', ?) WHERE id = ?`).run(`-${daysAgo} days`, returnId);
const localDate = (db, expr) => db.prepare(`SELECT date('now','localtime',${expr}) AS d`).get().d;

dbTest('Any period can anchor to a picked end date (7d)', (db) => {
  const part = createInventoryItem(db, {
    brand: 'Anchor', model_name: 'A1', part_type: 'Battery',
    cost_price: 10.0, price_retail: 50.0, stock_quantity: 10
  });
  const inWindow = createSale(db, { payment_method: 'cash', items: [{ inventory_id: part.id, quantity: 1, unit_price: 50.0 }], amount_paid: 50.0 });
  setSaleAge(db, inWindow.id, 13);
  const outOfWindow = createSale(db, { payment_method: 'cash', items: [{ inventory_id: part.id, quantity: 1, unit_price: 50.0 }], amount_paid: 50.0 });
  setSaleAge(db, outOfWindow.id, 1);

  // 7 days ENDING 12 days ago: covers days -18..-12 → only the 9-days-ago sale.
  const target = localDate(db, "'-12 days'");
  const stats = getPeriodStats(db, '7d', target);
  assert.strictEqual(stats.range.to, target);
  assert.strictEqual(stats.range.from, localDate(db, "'-18 days'"));
  assert.strictEqual(stats.current.sale_count, 1);
  assert.strictEqual(stats.previous.sale_count, 0); // previous window: days -25..-19
  assert.strictEqual(stats.trend.length, 1);
  assert.strictEqual(stats.trend[0].revenue, 50.0);
  assert.strictEqual(stats.trend[0].profit, 40.0); // 50 revenue - 10 cost

  // The anchor drives the product panels too, not just the KPIs.
  const perf = getProductPerformance(db, '7d', target);
  assert.strictEqual(perf.products.length, 1);
  assert.strictEqual(perf.products[0].units, 1);
});

dbTest('Profit trend subtracts costs and refunds on the day they happened', (db) => {
  const part = createInventoryItem(db, {
    brand: 'Trend', model_name: 'T1', part_type: 'LCD',
    cost_price: 100.0, price_retail: 300.0, stock_quantity: 5
  });
  const cashSale = createSale(db, { payment_method: 'cash', items: [{ inventory_id: part.id, quantity: 1, unit_price: 300.0 }], amount_paid: 300.0 });
  const utangSale = createSale(db, {
    customer_name: 'Trend Utang', payment_method: 'credit',
    items: [{ inventory_id: part.id, quantity: 1, unit_price: 300.0 }], amount_paid: 0
  });
  createWarrantyReturn(db, {
    sale_id: cashSale.id, sale_item_id: cashSale.items[0].id,
    return_type: 'cash_refund', refund_amount: 50.0, technician_notes: 'partial'
  });
  createWarrantyReturn(db, {
    sale_id: utangSale.id, sale_item_id: utangSale.items[0].id,
    return_type: 'credit_refund', refund_amount: 300.0, technician_notes: 'utang erase'
  });
  // The utang erase was given two days ago — it lands in THAT day's bucket,
  // not today's, even though its sale happened today.
  const lastReturn = db.prepare(`SELECT id FROM warranty_returns ORDER BY id DESC LIMIT 1`).get();
  setReturnAge(db, lastReturn.id, 2);

  const stats = getPeriodStats(db, '7d');
  const byBucket = Object.fromEntries(stats.trend.map(t => [t.bucket, t]));
  const today = localDate(db, "'0 days'");
  const twoBack = localDate(db, "'-2 days'");

  // Today: TWO sales (600 revenue) - 200 cost - 50 cash refund = 350
  assert.strictEqual(byBucket[today].revenue, 600.0);
  assert.strictEqual(byBucket[today].profit, 350.0);
  // Two days back: no sales at all — only the utang erase, so the bar is -300.
  assert.strictEqual(byBucket[twoBack].count, 0);
  assert.strictEqual(byBucket[twoBack].revenue, 0.0);
  assert.strictEqual(byBucket[twoBack].profit, -300.0);
});

dbTest('Exceptions list every return type, over any window', (db) => {
  const part = createInventoryItem(db, {
    brand: 'Exc', model_name: 'E1', part_type: 'LCD',
    cost_price: 10.0, price_retail: 30.0, stock_quantity: 10
  });
  const cashSale = createSale(db, { payment_method: 'cash', items: [{ inventory_id: part.id, quantity: 1, unit_price: 30.0 }], amount_paid: 30.0 });
  const utangSale = createSale(db, {
    customer_name: 'Exc Utang', payment_method: 'credit',
    items: [{ inventory_id: part.id, quantity: 1, unit_price: 30.0 }], amount_paid: 0
  });
  const swapSale = createSale(db, { payment_method: 'gcash', payment_reference: 'GC-EXC-1', items: [{ inventory_id: part.id, quantity: 1, unit_price: 30.0 }], amount_paid: 30.0 });
  createWarrantyReturn(db, { sale_id: cashSale.id, sale_item_id: cashSale.items[0].id, return_type: 'cash_refund', refund_amount: 30.0 });
  createWarrantyReturn(db, { sale_id: utangSale.id, sale_item_id: utangSale.items[0].id, return_type: 'credit_refund', refund_amount: 30.0 });
  createWarrantyReturn(db, { sale_id: swapSale.id, sale_item_id: swapSale.items[0].id, return_type: 'replacement', refund_amount: 0.0, technician_notes: 'swap' });

  const types = getExceptions(db, 7).returns.map(r => r.return_type).sort();
  assert.deepEqual(types, ['cash_refund', 'credit_refund', 'replacement']);

  // The old 30-day cap is gone: a 40-day-old return shows on a 60-day window
  // and correctly drops off the 7-day one.
  const oldest = db.prepare(`SELECT id FROM warranty_returns ORDER BY id LIMIT 1`).get();
  setReturnAge(db, oldest.id, 40);
  assert.strictEqual(getExceptions(db, 60).returns.length, 3);
  assert.strictEqual(getExceptions(db, 7).returns.length, 2);
});
