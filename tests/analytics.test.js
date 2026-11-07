// phone-repair-pos/tests/analytics.test.js
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const { dbTest } = require('./helper');
const { createInventoryItem, adjustStock } = require('../src/inventory');
const { createSale } = require('../src/sales');
const { getDashboardStats } = require('../src/analytics');
const { createDbBackup } = require('../src/server');

dbTest('Dashboard stats computation and backup generation', (db, testDbPath) => {
  const backupDir = path.join(__dirname, 'test_backups');
  fs.rmSync(backupDir, { recursive: true, force: true });

  // Seed inventory
  const screen = createInventoryItem(db, {
    brand: 'Xiaomi',
    model_name: 'Redmi Note 10',
    part_type: 'LCD (OLED)',
    cost_price: 15.0,
    price_retail: 35.0,
    stock_quantity: 5,
    min_stock_alert: 2
  });

  // Make 1 cash sale (35.0)
  createSale(db, {
    customer_type: 'retail',
    payment_method: 'cash',
    items: [{ inventory_id: screen.id, quantity: 1, unit_price: 35.0 }],
    amount_paid: 35.0
  });

  // Make 1 GCash sale (35.0)
  createSale(db, {
    customer_type: 'retail',
    payment_method: 'gcash',
    payment_reference: 'GCASH-1234',
    items: [{ inventory_id: screen.id, quantity: 1, unit_price: 35.0 }],
    amount_paid: 35.0
  });

  // Make 1 Labor sale (20.0 labor fee)
  createSale(db, {
    customer_type: 'retail',
    payment_method: 'cash',
    items: [{ item_type: 'labor', item_name: 'LCD Install Labor', unit_price: 20.0, quantity: 1 }],
    amount_paid: 20.0
  });

  const stats = getDashboardStats(db);
  assert.strictEqual(stats.today_sales_revenue, 90.0);
  assert.strictEqual(stats.today_parts_revenue, 70.0);
  assert.strictEqual(stats.today_labor_revenue, 20.0);
  assert.strictEqual(stats.today_sales_profit, 60.0); // 90 rev - 30 parts cost = 60
  assert.strictEqual(stats.today_cash_collected, 55.0);
  assert.strictEqual(stats.today_gcash_collected, 35.0);
  assert.strictEqual(stats.total_parts_stock, 3);

  // Test backup
  const { initDb } = require('../src/db');
  const backupFile = createDbBackup(db, testDbPath, backupDir);
  assert.ok(fs.existsSync(backupFile));
  const backupDb = initDb(backupFile);
  const salesCount = backupDb.prepare('SELECT count(*) as count FROM sales').get().count;
  assert.strictEqual(salesCount, 3);
  backupDb.close();

  fs.rmSync(backupDir, { recursive: true, force: true });
});

dbTest('Dashboard does not multiply sale totals by line-item count', (db) => {
  const part = createInventoryItem(db, {
    brand: 'Oppo',
    model_name: 'A54',
    part_type: 'Battery',
    cost_price: 10.0,
    price_retail: 100.0,
    stock_quantity: 10
  });

  // ONE sale, THREE line items, total 300.0, fully paid in cash
  createSale(db, {
    customer_name: 'Fanout Check',
    payment_method: 'cash',
    items: [
      { inventory_id: part.id, quantity: 1, unit_price: 100.0, item_type: 'part' },
      { item_type: 'labor', item_name: 'Labor A', unit_price: 100.0, quantity: 1 },
      { item_type: 'labor', item_name: 'Labor B', unit_price: 100.0, quantity: 1 }
    ],
    amount_paid: 300.0
  });

  const stats = getDashboardStats(db);
  assert.strictEqual(stats.today_sales_count, 1);
  assert.strictEqual(stats.today_sales_revenue, 300.0);
  assert.strictEqual(stats.today_cash_collected, 300.0);
  assert.strictEqual(stats.today_collected_total, 300.0);
  assert.strictEqual(stats.today_parts_revenue, 100.0);
  assert.strictEqual(stats.today_labor_revenue, 200.0);
  assert.strictEqual(stats.today_sales_profit, 290.0); // 300 revenue - 10 part cost
});

dbTest('Refunds net against cash collected, profit, and revenue in dashboard stats', (db) => {
  const { createWarrantyReturn } = require('../src/returns');
  const part = createInventoryItem(db, {
    brand: 'Samsung',
    model_name: 'Galaxy S21',
    part_type: 'LCD (OLED)',
    cost_price: 100.0,
    price_retail: 300.0,
    stock_quantity: 5
  });

  const sale = createSale(db, {
    customer_name: 'Refund Probe',
    payment_method: 'cash',
    items: [{ inventory_id: part.id, quantity: 1, unit_price: 300.0 }],
    amount_paid: 300.0
  });

  // Verify before return
  const statsBefore = getDashboardStats(db);
  assert.strictEqual(statsBefore.today_sales_revenue, 300.0);
  assert.strictEqual(statsBefore.today_net_revenue, 300.0);
  assert.strictEqual(statsBefore.today_cash_collected, 300.0);
  assert.strictEqual(statsBefore.today_sales_profit, 200.0); // 300 rev - 100 cost

  // Process full cash refund
  createWarrantyReturn(db, {
    sale_id: sale.id,
    sale_item_id: sale.items[0].id,
    return_type: 'cash_refund',
    refund_amount: 300.0,
    technician_notes: 'Full refund probe'
  });

  const statsAfter = getDashboardStats(db);
  assert.strictEqual(statsAfter.today_sales_revenue, 300.0); // Gross revenue unchanged
  assert.strictEqual(statsAfter.today_net_revenue, 0.0); // 300 rev - 300 refund = 0
  assert.strictEqual(statsAfter.today_cash_collected, 0.0); // 300 collected - 300 refund = 0
  assert.strictEqual(statsAfter.today_sales_profit, -100.0); // 200 profit - 300 refund = -100 (lost part cost)
  assert.strictEqual(statsAfter.today_refunded_total, 300.0);
  assert.strictEqual(statsAfter.today_warranty_returns, 1);
});


dbTest('Cash collected is net of change given (tendered vs total)', (db) => {
  const part = createInventoryItem(db, {
    brand: 'Apple', model_name: 'iPhone 11', part_type: 'Battery',
    cost_price: 10.0, price_retail: 70.0, stock_quantity: 5
  });

  // Customer pays a 70.0 total with a 100.0 bill: 30.0 comes back as change.
  // The drawer only ever held 70.0 of this sale.
  createSale(db, {
    customer_name: 'Change Check',
    payment_method: 'cash',
    items: [{ inventory_id: part.id, quantity: 1, unit_price: 70.0 }],
    amount_paid: 100.0
  });

  const stats = getDashboardStats(db);
  assert.strictEqual(stats.today_cash_collected, 70.0);  // not the 100.0 tendered
  assert.strictEqual(stats.today_collected_total, 70.0); // not the 100.0 tendered
});

dbTest('Credit downpayment and bank transfer land in the right collections buckets', (db) => {
  const screen = createInventoryItem(db, {
    brand: 'Apple',
    model_name: 'iPhone 11',
    part_type: 'LCD (OLED)',
    cost_price: 2000.0,
    price_retail: 5000.0,
    stock_quantity: 5
  });

  // The reported bug: 5500 credit sale with a 1000 cash downpayment �
  // the 1000 vanished from every collections bucket.
  createSale(db, {
    customer_name: 'Downpayment Customer',
    payment_method: 'credit',
    items: [{ inventory_id: screen.id, quantity: 1, unit_price: 5000.0 },
            { item_type: 'labor', item_name: 'LCD Screen Installation', unit_price: 500.0, quantity: 1 }],
    amount_paid: 1000.0
  });

  // Bank transfer sale: previously computed but never surfaced.
  createSale(db, {
    customer_name: 'Transfer Customer',
    payment_method: 'transfer',
    payment_reference: 'TX-8899',
    items: [{ inventory_id: screen.id, quantity: 1, unit_price: 5000.0 }],
    amount_paid: 5000.0
  });

  const stats = getDashboardStats(db);
  assert.strictEqual(stats.today_sales_revenue, 10500.0);
  // The downpayment must read as cash � it sits in the drawer.
  assert.strictEqual(stats.today_cash_collected, 1000.0);
  assert.strictEqual(stats.today_gcash_collected, 0.0);
  assert.strictEqual(stats.today_transfer_collected, 5000.0);
  // Utang outstanding is the unpaid 4500, not the full sale.
  assert.strictEqual(stats.total_credit_outstanding, 4500.0);
  // Everything collected today adds up: 1000 downpayment + 5000 transfer.
  assert.strictEqual(stats.today_collected_total, 6000.0);
});

dbTest('Units received today counts receive movements only', (db) => {
  const part = createInventoryItem(db, {
    brand: 'Apple', model_name: 'iPhone 12', part_type: 'Battery',
    cost_price: 10.0, price_retail: 50.0, stock_quantity: 5
  });

  // Nothing received yet: opening_balance doesn't count.
  assert.strictEqual(getDashboardStats(db).today_units_received, 0);

  // A delivery lands, a quick -1 and a damage write-off happen.
  adjustStock(db, part.id, 10, { reason: 'receive', note: 'delivery' });
  adjustStock(db, part.id, 5, { reason: 'receive', note: 'second box' });
  adjustStock(db, part.id, -1);                              // correction
  adjustStock(db, part.id, -2, { reason: 'damage' });
  createSale(db, {                                          // sale
    customer_name: 'Receive Counter Check',
    items: [{ inventory_id: part.id, quantity: 2, unit_price: 50.0 }],
    amount_paid: 100.0
  });

  // Only the two receive movements: 10 + 5.
  assert.strictEqual(getDashboardStats(db).today_units_received, 15);
});
// ---- Period analytics (Reports & profit tab) ----
const { getPeriodStats, getProductPerformance, getDeadStock, getReorderList } = require('../src/analytics');
const { voidSale } = require('../src/sales');
const ctxMgr = { actor: { type: 'manager', id: null, name: 'Manager' }, elevated: true };

// created_at is UTC; datetime('now', '-N days') lands on the exact local
// calendar date N days back (same wall clock), so window membership is
// deterministic regardless of when the suite runs.
const setSaleAge = (db, saleId, daysAgo) =>
  db.prepare(`UPDATE sales SET created_at = datetime('now', ?) WHERE id = ?`).run(`-${daysAgo} days`, saleId);

dbTest('Period stats: trailing windows, previous window, voided exclusion', (db) => {
  const part = createInventoryItem(db, {
    brand: 'Realme', model_name: 'C55', part_type: 'Battery',
    cost_price: 10.0, price_retail: 50.0, stock_quantity: 20
  });
  createSale(db, { payment_method: 'cash', items: [{ inventory_id: part.id, quantity: 1, unit_price: 50.0 }], amount_paid: 50.0 });
  const older = createSale(db, { payment_method: 'gcash', payment_reference: 'GC-PERIOD-1', items: [{ inventory_id: part.id, quantity: 2, unit_price: 50.0 }], amount_paid: 100.0 });
  setSaleAge(db, older.id, 2);
  const doomed = createSale(db, { payment_method: 'cash', items: [{ inventory_id: part.id, quantity: 1, unit_price: 50.0 }], amount_paid: 50.0 });
  voidSale(db, doomed.id, 'period stats test void', ctxMgr);

  const day = getPeriodStats(db, 'day');
  assert.strictEqual(day.days, 1);
  assert.strictEqual(day.current.sale_count, 1);
  assert.strictEqual(day.current.revenue, 50.0);
  assert.strictEqual(day.current.avg_ticket, 50.0);
  assert.strictEqual(day.previous.sale_count, 0);
  assert.strictEqual(day.deltas.revenue, null); // no previous window to compare

  const d3 = getPeriodStats(db, '3d');
  assert.strictEqual(d3.current.sale_count, 2);   // today + 2-days-ago, voided out
  assert.strictEqual(d3.current.revenue, 150.0);
  assert.strictEqual(d3.current.gross_profit, 120.0); // 150 revenue - 3 units * 10 cost
  assert.strictEqual(d3.current.parts_revenue, 150.0);
  assert.strictEqual(d3.current.labor_revenue, 0.0);
  assert.strictEqual(d3.previous.sale_count, 0);  // nothing 3-6 days back
  assert.strictEqual(d3.trend.length, 2);         // one bucket per day with sales
});

dbTest('Period stats: daily window can be pinned to a past date', (db) => {
  const part = createInventoryItem(db, {
    brand: 'Vivo', model_name: 'Y21', part_type: 'Battery',
    cost_price: 10.0, price_retail: 50.0, stock_quantity: 10
  });
  const pinned = createSale(db, { payment_method: 'cash', items: [{ inventory_id: part.id, quantity: 1, unit_price: 50.0 }], amount_paid: 50.0 });
  setSaleAge(db, pinned.id, 3);
  const other = createSale(db, { payment_method: 'cash', items: [{ inventory_id: part.id, quantity: 1, unit_price: 50.0 }], amount_paid: 50.0 });
  setSaleAge(db, other.id, 10);

  const target = db.prepare(`SELECT date('now','localtime','-3 days') AS d`).get().d;
  const stats = getPeriodStats(db, 'day', target);
  assert.strictEqual(stats.period, 'day');
  assert.strictEqual(stats.range.to, target);
  assert.strictEqual(stats.current.sale_count, 1);
  assert.strictEqual(stats.current.revenue, 50.0);
  assert.strictEqual(stats.previous.sale_count, 0); // the day before the picked day

  // The pinned day drives the lower panels too, not just the KPIs — otherwise
  // the tab contradicts itself (KPIs see the sale, Top performers shows none).
  const perf = getProductPerformance(db, 'day', target);
  assert.strictEqual(perf.products.length, 1);
  assert.strictEqual(perf.products[0].revenue, 50.0);
  assert.strictEqual(getDeadStock(db, 'day', target).length, 0); // the part sold that day
});

dbTest('Day-close expected_cash agrees with dashboard cash buckets on a mixed day', (db) => {
  const { settleCustomerCredit } = require('../src/credits');
  const { createWarrantyReturn } = require('../src/returns');
  const { getDayBuckets } = require('../src/reconcile');

  const part = createInventoryItem(db, {
    brand: 'Infinix', model_name: 'Hot 12', part_type: 'LCD',
    cost_price: 10.0, price_retail: 50.0, stock_quantity: 10
  });
  // cash 100, gcash 50, credit downpayment 20 (cash) — then a cash refund of 50
  // and a gcash utang settlement of 10.
  const cashSale = createSale(db, { payment_method: 'cash', items: [{ inventory_id: part.id, quantity: 2, unit_price: 50.0 }], amount_paid: 100.0 });
  createSale(db, { payment_method: 'gcash', payment_reference: 'GC-DAY-1', items: [{ inventory_id: part.id, quantity: 1, unit_price: 50.0 }], amount_paid: 50.0 });
  const creditSale = createSale(db, { customer_name: 'Utang Buyer', payment_method: 'credit', items: [{ inventory_id: part.id, quantity: 1, unit_price: 50.0 }], amount_paid: 20.0 });
  settleCustomerCredit(db, { customer_name: 'Utang Buyer', amount_paid: 10.0, payment_method: 'gcash', payment_reference: 'GC-SET-10' });
  createWarrantyReturn(db, { sale_id: cashSale.id, sale_item_id: cashSale.items[0].id, return_type: 'cash_refund', return_reason: 'other' }, ctxMgr);

  // Dashboard: 100 + 20 (credit downpayment sits in the drawer) - 50 refund
  const stats = getDashboardStats(db);
  assert.strictEqual(stats.today_cash_collected, 70.0);
  assert.strictEqual(stats.today_gcash_collected, 60.0); // 50 sale + 10 settlement
  assert.strictEqual(stats.today_credit_settled, 10.0);

  // Day close must land on exactly the same drawer numbers.
  const today = db.prepare(`SELECT date('now','localtime') AS d`).get().d;
  const summary = getDayBuckets(db, today);
  assert.strictEqual(summary.expected_cash, stats.today_cash_collected);
  assert.strictEqual(summary.buckets.gcash.collected, stats.today_gcash_collected);
});

dbTest('Product performance: revenue ranking, margin, labor kept separate', (db) => {
  const battery = createInventoryItem(db, {
    brand: 'Oppo', model_name: 'A78', part_type: 'Battery',
    cost_price: 10.0, price_retail: 50.0, stock_quantity: 10
  });
  const screen = createInventoryItem(db, {
    brand: 'Oppo', model_name: 'A78', part_type: 'LCD',
    cost_price: 100.0, price_retail: 500.0, stock_quantity: 5
  });
  createSale(db, { payment_method: 'cash', items: [{ inventory_id: battery.id, quantity: 2, unit_price: 50.0 }], amount_paid: 100.0 });
  createSale(db, { payment_method: 'cash', items: [
    { inventory_id: screen.id, quantity: 1, unit_price: 500.0 },
    { item_type: 'labor', item_name: 'Screen install', unit_price: 100.0, quantity: 1 }
  ], amount_paid: 600.0 });

  const perf = getProductPerformance(db, '7d');
  assert.strictEqual(perf.products.length, 2);
  const top = perf.products[0]; // screen: 500 revenue
  assert.strictEqual(top.revenue, 500.0);
  assert.strictEqual(top.profit, 400.0);
  assert.strictEqual(top.margin_pct, 80.0);
  const second = perf.products[1];
  assert.strictEqual(second.revenue, 100.0);
  assert.strictEqual(second.profit, 80.0);
  assert.strictEqual(perf.labor.revenue, 100.0);
  assert.strictEqual(perf.labor.profit, 100.0); // labor carries no cost line
});

dbTest('Dead stock: unsold shelf capital ranked, aging from last sale', (db) => {
  const mover = createInventoryItem(db, { brand: 'A', model_name: 'M1', part_type: 'Battery', cost_price: 10.0, price_retail: 50.0, stock_quantity: 5 });
  const sleeper = createInventoryItem(db, { brand: 'B', model_name: 'M2', part_type: 'LCD', cost_price: 100.0, price_retail: 300.0, stock_quantity: 4 });
  const neverSold = createInventoryItem(db, { brand: 'C', model_name: 'M3', part_type: 'Camera', cost_price: 50.0, price_retail: 150.0, stock_quantity: 2 });

  createSale(db, { payment_method: 'cash', items: [{ inventory_id: mover.id, quantity: 1, unit_price: 50.0 }], amount_paid: 50.0 });
  const oldSale = createSale(db, { payment_method: 'cash', items: [{ inventory_id: sleeper.id, quantity: 1, unit_price: 300.0 }], amount_paid: 300.0 });
  setSaleAge(db, oldSale.id, 40);

  const dead = getDeadStock(db, '30d');
  const ids = dead.map(d => d.id);
  assert.ok(!ids.includes(mover.id));      // sold inside the window
  assert.ok(ids.includes(sleeper.id));     // last sale 40 days back: dead for 30d
  assert.ok(ids.includes(neverSold.id));   // never sold at all
  assert.strictEqual(dead[0].id, sleeper.id); // 3 * 100 capital outranks 2 * 50
  assert.strictEqual(dead[0].tied_up_capital, 300.0); // 4 stocked - 1 sold = 3 left, 3 * 100
  assert.strictEqual(dead[0].days_no_sale, 40);
  assert.strictEqual(dead[0].age_band, '30+');
  assert.strictEqual(dead.find(d => d.id === neverSold.id).age_band, '<30');
});

dbTest('Reorder list: min-stock breach first, low cover second, dead stock never', (db) => {
  const low = createInventoryItem(db, { brand: 'D', model_name: 'M4', part_type: 'Battery', cost_price: 10.0, price_retail: 50.0, stock_quantity: 1, min_stock_alert: 3 });
  const hot = createInventoryItem(db, { brand: 'E', model_name: 'M5', part_type: 'LCD', cost_price: 100.0, price_retail: 500.0, stock_quantity: 16 });
  const steady = createInventoryItem(db, { brand: 'F', model_name: 'M6', part_type: 'Camera', cost_price: 50.0, price_retail: 150.0, stock_quantity: 10 });
  const idle = createInventoryItem(db, { brand: 'G', model_name: 'M7', part_type: 'Speaker', cost_price: 20.0, price_retail: 60.0, stock_quantity: 8 });

  createSale(db, { payment_method: 'cash', items: [{ inventory_id: hot.id, quantity: 6, unit_price: 500.0 }], amount_paid: 3000.0 });
  createSale(db, { payment_method: 'cash', items: [{ inventory_id: steady.id, quantity: 1, unit_price: 150.0 }], amount_paid: 150.0 });
  // idle sells nothing: zero velocity is dead stock, not a reorder signal.

  const reorder = getReorderList(db, '7d');
  assert.strictEqual(reorder.length, 2);
  assert.strictEqual(reorder[0].id, low.id);        // min-stock breach sorts first
  assert.strictEqual(reorder[0].below_min, true);
  assert.strictEqual(reorder[1].id, hot.id);        // 10 left / 6 per week = 11.7 days
  assert.strictEqual(reorder[1].below_min, false);
  assert.strictEqual(reorder[1].cover_days, 11.7);
  assert.ok(!reorder.some(r => r.id === steady.id)); // cover 70 days: fine
  assert.ok(!reorder.some(r => r.id === idle.id));   // never sells: not a buy signal
});

dbTest('audit chain that fails to verify reports unknown, never clean', (db) => {
  const { getExceptions } = require('../src/analytics');
  const orig = db.prepare.bind(db);
  db.prepare = sql => {
    if (String(sql).includes('row_hash FROM audit_log')) throw new Error('boom');
    return orig(sql);
  };
  try {
    const ex = getExceptions(db, 7);
    assert.strictEqual(ex.auditChain.ok, 'unknown');
  } finally {
    db.prepare = orig;
  }
});

dbTest('RMA replacements and refunds net out in dashboard profit, period stats, and top products', (db) => {
  const { createWarrantyReturn } = require('../src/returns');
  const { getPeriodStats, getProductPerformance } = require('../src/analytics');

  const screen = createInventoryItem(db, {
    brand: 'Apple', model_name: 'iPhone 13', part_type: 'LCD',
    cost_price: 100.0, price_retail: 300.0, stock_quantity: 5
  });

  const sale = createSale(db, {
    customer_name: 'RMA Test',
    payment_method: 'cash',
    items: [{ inventory_id: screen.id, quantity: 1, unit_price: 300.0 }],
    amount_paid: 300.0
  });

  // Replacement: draw 1 replacement unit (cost 100).
  createWarrantyReturn(db, {
    sale_id: sale.id,
    sale_item_id: sale.items[0].id,
    return_type: 'replacement',
    quantity: 1,
    refund_amount: 0.0
  });

  const stats = getDashboardStats(db);
  // Revenue 300, original item cost 100, replacement cost 100 -> profit = 300 - 100 - 100 = 100
  assert.strictEqual(stats.today_sales_profit, 100.0);
  assert.strictEqual(stats.today_replacement_cost, 100.0);

  const period = getPeriodStats(db, 'day');
  assert.strictEqual(period.current.net_profit, 100.0);
  assert.strictEqual(period.current.replacement_cost, 100.0);

  const perf = getProductPerformance(db, 'day');
  assert.strictEqual(perf.products.length, 1);
  assert.strictEqual(perf.products[0].units, 1);
  assert.strictEqual(perf.products[0].revenue, 300.0);
  assert.strictEqual(perf.products[0].profit, 100.0);
});

dbTest('getDashboardStats matches getPeriodStats(db, "day").current across all payment, return, and void flows', (db) => {
  const { createWarrantyReturn } = require('../src/returns');
  const { settleCustomerCredit } = require('../src/credits');

  const partA = createInventoryItem(db, { brand: 'Samsung', model_name: 'A54', part_type: 'OLED', cost_price: 80.0, price_retail: 200.0, stock_quantity: 10 });
  const partB = createInventoryItem(db, { brand: 'Apple', model_name: '14 Pro', part_type: 'Battery', cost_price: 40.0, price_retail: 120.0, stock_quantity: 10 });

  const s1 = createSale(db, {
    customer_name: 'Walk-in Cash',
    payment_method: 'cash',
    items: [
      { inventory_id: partA.id, quantity: 2, unit_price: 200.0 },
      { item_type: 'labor', item_name: 'Install', quantity: 1, unit_price: 50.0 }
    ],
    discount_amount: 30.0,
    amount_paid: 500.0
  });
  createSale(db, {
    customer_name: 'Walk-in GCash',
    payment_method: 'gcash',
    payment_reference: 'GC-PARITY-1',
    items: [{ inventory_id: partB.id, quantity: 1, unit_price: 120.0 }],
    amount_paid: 120.0
  });
  createSale(db, {
    customer_name: 'Walk-in Transfer',
    payment_method: 'transfer',
    payment_reference: 'TX-PARITY-1',
    items: [{ inventory_id: partB.id, quantity: 1, unit_price: 120.0 }],
    amount_paid: 120.0
  });
  createSale(db, {
    customer_name: 'Tech Credit',
    payment_method: 'credit',
    items: [{ inventory_id: partA.id, quantity: 1, unit_price: 200.0 }],
    amount_paid: 50.0
  });
  settleCustomerCredit(db, { customer_name: 'Tech Credit', amount_paid: 40.0, payment_method: 'cash' });

  const sVoid = createSale(db, {
    customer_name: 'Voided Buyer',
    payment_method: 'cash',
    items: [{ inventory_id: partB.id, quantity: 1, unit_price: 120.0 }],
    amount_paid: 120.0
  });
  voidSale(db, sVoid.id, 'wrong part', ctxMgr);

  createWarrantyReturn(db, {
    sale_id: s1.id,
    sale_item_id: s1.items[0].id,
    return_type: 'replacement',
    quantity: 1,
    refund_amount: 0.0
  });
  createWarrantyReturn(db, {
    sale_id: s1.id,
    sale_item_id: s1.items[0].id,
    return_type: 'cash_refund',
    quantity: 1,
    refund_amount: 180.0
  });

  const phone = getDashboardStats(db);
  const desk = getPeriodStats(db, 'day').current;

  assert.strictEqual(phone.today_sales_count, desk.sale_count);
  assert.strictEqual(phone.today_sales_revenue, desk.revenue);
  assert.strictEqual(phone.today_sales_profit, desk.net_profit);
  assert.strictEqual(phone.today_gross_profit, desk.gross_profit);
  assert.strictEqual(phone.today_refunded_total, desk.refunded_total);
  assert.strictEqual(phone.today_replacement_cost, desk.replacement_cost);
  assert.strictEqual(phone.today_cash_collected, desk.cash_collected);
  assert.strictEqual(phone.today_gcash_collected, desk.gcash_collected);
  assert.strictEqual(phone.today_transfer_collected, desk.transfer_collected);
  assert.strictEqual(phone.today_collected_total, desk.collected_total);
});
