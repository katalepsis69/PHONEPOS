const assert = require('node:assert');
const { dbTest } = require('./helper');
const { createInventoryItem } = require('../src/inventory');
const { createSale } = require('../src/sales');
const { getDayBuckets, closeDay, getDayReconciliation, closedPeriodAt } = require('../src/reconcile');
const { settleCustomerCredit } = require('../src/credits');

const today = () => new Date().toLocaleDateString('en-CA');

dbTest('balanced day close records status balanced', (db) => {
  const item = createInventoryItem(db, { brand: 'Day', model_name: 'Close', part_type: 'Part', cost_price: 1, price_retail: 10, stock_quantity: 5 });
  createSale(db, { payment_method: 'cash', items: [{ inventory_id: item.id, quantity: 2, unit_price: 10 }], amount_paid: 20 });

  const summary = getDayBuckets(db, today());
  assert.strictEqual(summary.expected_cash, 20);

  const closed = closeDay(db, today(), 20, { actor: { type: 'manager', id: 1, name: 'Boss' }, elevated: true });
  assert.strictEqual(closed.status, 'balanced');
  assert.strictEqual(closed.variance, 0);

  const stored = getDayReconciliation(db, today());
  assert.strictEqual(stored.status, 'balanced');
  assert.throws(() => closeDay(db, today(), 20), /already reconciled/);
});

dbTest('unbalanced day close flags variance and audit row is written', (db) => {
  const item = createInventoryItem(db, { brand: 'Flag', model_name: 'Variance', part_type: 'Part', cost_price: 1, price_retail: 15, stock_quantity: 3 });
  createSale(db, { payment_method: 'cash', items: [{ inventory_id: item.id, quantity: 1, unit_price: 15 }], amount_paid: 15 });
  createSale(db, { customer_name: 'GCash Buyer', payment_method: 'gcash', payment_reference: 'GC-OPEN-1', items: [{ inventory_id: item.id, quantity: 1, unit_price: 15 }], amount_paid: 15 });

  const summary = getDayBuckets(db, today());
  assert.strictEqual(summary.expected_cash, 15);
  assert.strictEqual(summary.buckets.gcash.collected, 15);

  const closed = closeDay(db, today(), 12, { actor: { type: 'manager', id: 1, name: 'Boss' }, elevated: true });
  assert.strictEqual(closed.status, 'flagged');
  assert.strictEqual(closed.variance, -3);

  const auditRow = db.prepare("SELECT * FROM audit_log WHERE category='day_close' ORDER BY id DESC LIMIT 1").get();
  assert.ok(auditRow);
  assert.ok(auditRow.detail.includes('flagged'));
});

dbTest('day buckets ignore voided sales', (db) => {
  const item = createInventoryItem(db, { brand: 'Void', model_name: 'Bucket', part_type: 'Part', cost_price: 1, price_retail: 10, stock_quantity: 4 });
  const sale = createSale(db, { payment_method: 'cash', items: [{ inventory_id: item.id, quantity: 1, unit_price: 10 }], amount_paid: 10 });
  const { voidSale } = require('../src/sales');
  voidSale(db, sale.id, 'wrong', {}, 'VOID_ERROR');

  const summary = getDayBuckets(db, today());
  assert.strictEqual(summary.expected_cash, 0);
  assert.strictEqual(summary.void_count, 1);
});

dbTest('day cash includes credit downpayments and cash settlements', (db) => {
  const item = createInventoryItem(db, { brand: 'Credit', model_name: 'Cash', part_type: 'Part', price_retail: 100, stock_quantity: 3 });
  createSale(db, {
    customer_name: 'Daily Debtor', payment_method: 'credit',
    items: [{ inventory_id: item.id, quantity: 1 }], amount_paid: 25
  });
  settleCustomerCredit(db, { customer_name: 'Daily Debtor', amount_paid: 20, payment_method: 'cash' });
  settleCustomerCredit(db, { customer_name: 'Daily Debtor', amount_paid: 10, payment_method: 'gcash', payment_reference: 'GC-DAILY-10' });
  const summary = getDayBuckets(db, today());
  assert.strictEqual(summary.buckets.cash.collected, 45);
  assert.strictEqual(summary.buckets.gcash.collected, 10);
  assert.strictEqual(summary.expected_cash, 45);
});

dbTest('D2: a void across a closed till pays out of today and flags both periods', (db) => {
  const { voidSale } = require('../src/sales');
  const { openShift, closeShift } = require('../src/shifts');
  const { getExceptions } = require('../src/analytics');
  const mgr = { actor: { type: 'manager', id: null, name: 'Boss' }, elevated: true };
  const item = createInventoryItem(db, { brand: 'Past', model_name: 'Till', part_type: 'LCD', cost_price: 1, price_retail: 100, stock_quantity: 10 });

  const shift = openShift(db, { type: 'manager', id: null, name: 'Boss' }, 0);
  const cashSale = createSale(db, { payment_method: 'cash', items: [{ inventory_id: item.id, quantity: 1, unit_price: 100 }], amount_paid: 100 });
  const gcashSale = createSale(db, { payment_method: 'gcash', payment_reference: 'GC-CROSS-1', items: [{ inventory_id: item.id, quantity: 1, unit_price: 100 }], amount_paid: 100 });
  const closedShift = closeShift(db, shift.id, 100, mgr);
  assert.strictEqual(closedShift.expected_cash, 100);
  assert.strictEqual(closedShift.variance, 0);

  // Move the whole period into the past, the way a three-day-late void finds it.
  const back = "datetime('now','-3 days')";
  db.prepare(`UPDATE sales SET created_at=${back} WHERE id IN (?,?)`).run(cashSale.id, gcashSale.id);
  db.prepare(`UPDATE shifts SET opened_at=${back}, closed_at=${back} WHERE id=?`).run(shift.id);
  const pastDay = db.prepare(`SELECT date(${back},'localtime') AS d`).get().d;

  voidSale(db, cashSale.id, 'wrong part handed over', mgr);
  const adj = db.prepare('SELECT * FROM cash_adjustments').all();
  assert.strictEqual(adj.length, 1, 'the drawer pays out of today');
  assert.strictEqual(adj[0].amount, -100);

  // The signed shift is exactly as signed; nobody retakes its count.
  const signed = db.prepare('SELECT expected_cash, counted_cash, variance FROM shifts WHERE id = ?').get(shift.id);
  assert.strictEqual(signed.expected_cash, 100);
  assert.strictEqual(signed.variance, 0);

  // Today's drawer reads the payout, and the past day reads what a recount
  // would find: nothing. That gap is the exception, not a corrected number.
  assert.strictEqual(getDayBuckets(db, today()).expected_cash, -100);
  assert.strictEqual(getDayBuckets(db, pastDay).expected_cash, 0);

  // A gcash void returns no drawer cash, so it is flagged but never adjusted.
  voidSale(db, gcashSale.id, 'customer changed mind', mgr);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS c FROM cash_adjustments').get().c, 1);

  const ex = getExceptions(db, 1);
  assert.strictEqual(ex.afterClose.length, 2);
  const cashEntry = ex.afterClose.find(a => a.ref === cashSale.sale_code);
  assert.strictEqual(cashEntry.cash_out, 100);
  assert.strictEqual(cashEntry.signed_kind, 'shift');
  assert.match(cashEntry.signed_period, /shift #/);
  assert.strictEqual(ex.afterClose.find(a => a.ref === gcashSale.sale_code).cash_out, 0);
});

dbTest('D2: a same-day void needs no compensation because today already lost it', (db) => {
  const { voidSale } = require('../src/sales');
  const mgr = { actor: { type: 'manager', id: null, name: 'Boss' }, elevated: true };
  const item = createInventoryItem(db, { brand: 'Today', model_name: 'Till', part_type: 'LCD', cost_price: 1, price_retail: 60, stock_quantity: 5 });
  closeDay(db, today(), 60, mgr);
  const sale = createSale(db, { payment_method: 'cash', items: [{ inventory_id: item.id, quantity: 1, unit_price: 60 }], amount_paid: 60 });
  voidSale(db, sale.id, 'double rung', mgr);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS c FROM cash_adjustments').get().c, 0, 'no second payout for the same money');
  const day = getDayBuckets(db, today());
  assert.strictEqual(day.expected_cash, 0, 'the void already left today');
});

dbTest('D2: voiding a same-day sale the close already counted pays out once', (db) => {
  const { voidSale } = require('../src/sales');
  const { getExceptions } = require('../src/analytics');
  const mgr = { actor: { type: 'manager', id: null, name: 'Boss' }, elevated: true };
  const item = createInventoryItem(db, { brand: 'Same', model_name: 'Day', part_type: 'LCD', cost_price: 1, price_retail: 80, stock_quantity: 5 });
  const sale = createSale(db, { payment_method: 'cash', items: [{ inventory_id: item.id, quantity: 1, unit_price: 80 }], amount_paid: 80 });
  const closed = closeDay(db, today(), 80, mgr);
  assert.strictEqual(closed.status, 'balanced');

  voidSale(db, sale.id, 'rung twice', mgr);
  const adj = db.prepare('SELECT * FROM cash_adjustments').all();
  assert.strictEqual(adj.length, 1, 'the counted sale pays out of the drawer');
  assert.strictEqual(adj[0].amount, -80);
  const ex = getExceptions(db, 1);
  assert.strictEqual(ex.afterClose.find(a => a.ref === sale.sale_code).cash_out, 80);
});

dbTest('day close refuses a future date', (db) => {
  assert.throws(
    () => closeDay(db, '2099-01-01', 0, { actor: { type: 'manager', id: null, name: 'Boss' }, elevated: true }),
    /has not ended/
  );
});

// closedPeriodAt: a day_reconciliations row whose created_at is unusable (the
// column is NOT NULL today, but a legacy or hand-edited row can hold an empty
// string) used to fall back to the bare day string, which Date.parse reads as
// UTC midnight. A sale in the FIRST HALF of that local day then compared as
// "after the close" in any positive-offset timezone and its void paid no drawer
// adjustment. Local end-of-day is the conservative reading of an unknown
// sign-off instant.
dbTest('a day row with an unusable created_at signs off at local end-of-day, not UTC midnight', (db) => {
  const { voidSale, createSale: mkSale } = require('../src/sales');
  const mgr = { actor: { type: 'manager', id: null, name: 'Boss' }, elevated: true };
  const item = createInventoryItem(db, { brand: 'Null', model_name: 'Stamp', part_type: 'LCD', cost_price: 1, price_retail: 70, stock_quantity: 5 });

  // A sale rung up at local 00:30 of today: inside the counted day, and (for a
  // positive UTC offset) BEFORE UTC midnight of that date.
  const sale = mkSale(db, { payment_method: 'cash', items: [{ inventory_id: item.id, quantity: 1, unit_price: 70 }], amount_paid: 70 });
  const localEarly = new Date(`${today()}T00:30:00`).toISOString();
  db.prepare('UPDATE sales SET created_at = ? WHERE id = ?').run(localEarly, sale.id);

  closeDay(db, today(), 70, mgr);
  db.prepare("UPDATE day_reconciliations SET created_at = '' WHERE day = ?").run(today());

  const closed = closedPeriodAt(db, localEarly);
  assert.strictEqual(closed.kind, 'day');
  assert.strictEqual(closed.signed_at, `${today()}T23:59:59`);

  voidSale(db, sale.id, 'wrong part', mgr);
  const adj = db.prepare('SELECT * FROM cash_adjustments').all();
  assert.strictEqual(adj.length, 1, 'a sale counted inside the day must pay out when voided');
  assert.strictEqual(adj[0].amount, -70);
});

dbTest('void after a warranty replacement restores the replacement unit', (db) => {
  const { voidSale } = require('../src/sales');
  const { createWarrantyReturn } = require('../src/returns');
  const { getInventoryItem } = require('../src/inventory');
  const mgr = { actor: { type: 'manager', id: null, name: 'Boss' }, elevated: true };
  const part = createInventoryItem(db, { brand: 'RMA', model_name: 'Swap', part_type: 'LCD', cost_price: 10, price_retail: 100, stock_quantity: 5 });

  // Buy 1 unit (stock 5 -> 4), then replace 1 DOA unit under warranty (stock 4 -> 3).
  const sale = createSale(db, { payment_method: 'cash', items: [{ inventory_id: part.id, quantity: 1, unit_price: 100 }], amount_paid: 100 }, mgr);
  assert.strictEqual(getInventoryItem(db, part.id).stock_quantity, 4);
  createWarrantyReturn(db, { sale_id: sale.id, sale_item_id: sale.items[0].id, quantity: 1, return_type: 'replacement' }, mgr);
  assert.strictEqual(getInventoryItem(db, part.id).stock_quantity, 3);

  // Voiding the sale returns the good replacement unit to sellable stock (3 -> 4; the 1 DOA unit stays out).
  const res = voidSale(db, sale.id, 'customer refunded after replacement', mgr);
  assert.strictEqual(res.restored, 1);
  assert.strictEqual(getInventoryItem(db, part.id).stock_quantity, 4);
});

dbTest('after-close void cash_adjustments match across day close, dashboard stats, and period KPIs', (db) => {
  const { voidSale } = require('../src/sales');
  const { openShift, closeShift } = require('../src/shifts');
  const { getDashboardStats, getPeriodStats } = require('../src/analytics');
  const mgr = { actor: { type: 'manager', id: null, name: 'Boss' }, elevated: true };
  const item = createInventoryItem(db, { brand: 'Sync', model_name: 'Buckets', part_type: 'LCD', cost_price: 10, price_retail: 100, stock_quantity: 10 });

  const shift = openShift(db, mgr.actor, 0);
  const pastSale = createSale(db, { payment_method: 'cash', items: [{ inventory_id: item.id, quantity: 1, unit_price: 100 }], amount_paid: 100 });
  closeShift(db, shift.id, 100, mgr);

  const back = "datetime('now','-3 days')";
  db.prepare(`UPDATE sales SET created_at=${back} WHERE id=?`).run(pastSale.id);
  db.prepare(`UPDATE shifts SET opened_at=${back}, closed_at=${back} WHERE id=?`).run(shift.id);

  // Voiding the 3-day-old sale today pays -100 out of today's drawer.
  voidSale(db, pastSale.id, 'returned 3 days later', mgr);

  const dayClose = getDayBuckets(db, today());
  const dash = getDashboardStats(db);
  const dailyPeriod = getPeriodStats(db, 'day', today());
  const weekPeriod = getPeriodStats(db, '7d', today());

  assert.strictEqual(dayClose.expected_cash, -100);
  assert.strictEqual(dash.today_cash_collected, -100);
  assert.strictEqual(dash.today_collected_total, -100);
  assert.strictEqual(dailyPeriod.current.cash_collected, -100);
  assert.strictEqual(dailyPeriod.current.collected_total, -100);
  // Across the 7-day window containing BOTH the original sale and today's void, net cash is 0, not -100.
  assert.strictEqual(weekPeriod.current.cash_collected, 0);
  assert.strictEqual(weekPeriod.current.collected_total, 0);

  // Voiding a credit sale clears credit_balance on the row itself so no view shows stale debt.
  const creditSale = createSale(db, { customer_name: 'Zeroed Debt', payment_method: 'credit', items: [{ inventory_id: item.id, quantity: 1, unit_price: 100 }], amount_paid: 20 });
  const voidedCredit = voidSale(db, creditSale.id, 'cancelled order', mgr);
  assert.strictEqual(voidedCredit.credit_balance, 0);
  assert.strictEqual(db.prepare('SELECT credit_balance FROM sales WHERE id = ?').get(creditSale.id).credit_balance, 0);
});
