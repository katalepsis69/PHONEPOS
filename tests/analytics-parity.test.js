// tests/analytics-parity.test.js — one dataset, two engines, one answer.
// The v7 audit's largest standing parity risk: the cloud recomputes the
// workstation's numbers with its own SQL, and nothing compared the outputs.
// This mirrors a shop dataset to a spawned cloud through the REAL /sync
// pipeline, then compares /api/analytics top_products against
// getProductPerformance on the same rows: units, revenue and profit must
// agree to the centavo, including proportional discount allocation, an
// all-time refund, a replacement RMA's cost, and a voided sale.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { initDb } = require('../src/db');
const { createSale } = require('../src/sales');
const { settleCustomerCredit } = require('../src/credits');
const { createWarrantyReturn } = require('../src/returns');
const { adjustStock } = require('../src/inventory');
const { getProductPerformance, getStandingStats, getReorderList, getDeadStock, getPeriodStats, getDashboardStats } = require('../src/analytics');
const { drainOutbox, getShopId, enqueueRow } = require('../src/sync');
const { startCloud, stopCloud, login, sync, TOKEN_A } = require('./cloud-hardening-harness');

test('cloud top_products equals the workstation for the same dataset', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-shop-'));
  const db = initDb(path.join(dir, 'shop.db'));
  let child;
  const cloudDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-cloud-'));
  fs.writeFileSync(path.join(cloudDir, 'manager-pin.txt'), '2468\n');
  try {
    // Part A sells at 30 with a 50 discount spread over two lines; part B is
    // the replacement RMA target; one sale gets voided after selling B.
    const partA = { id: 1 };
    const partB = { id: 2 };
    db.prepare(`INSERT INTO inventory (id, brand, model_name, part_type, cost_price, price_retail, price_technician, stock_quantity, min_stock_alert)
      VALUES (1, 'Apple', 'iPhone 11', 'LCD', 100, 30, 25, 50, 2)`).run();
    db.prepare(`INSERT INTO inventory (id, brand, model_name, part_type, cost_price, price_retail, price_technician, stock_quantity, min_stock_alert)
      VALUES (2, 'Samsung', 'A50', 'Battery', 40, 20, 15, 50, 2)`).run();

    const discounted = createSale(db, {
      customer_name: 'Parity One', payment_method: 'cash', discount: 5,
      items: [
        { inventory_id: 1, item_type: 'part', quantity: 3, unit_price: 30 },
        { inventory_id: 2, item_type: 'part', quantity: 2, unit_price: 20 },
      ],
      amount_paid: 145,
    });
    // An all-time refund against part A's line: 30 off.
    createWarrantyReturn(db, {
      sale_id: discounted.id, sale_item_id: discounted.items[0].id,
      return_type: 'cash_refund', refund_amount: 30, quantity: 1,
    });
    // A replacement on part B's line: cost 40 leaves the P&L with the part.
    const replaced = createSale(db, {
      customer_name: 'Parity Two', payment_method: 'cash',
      items: [{ inventory_id: 2, item_type: 'part', quantity: 1, unit_price: 20 }],
      amount_paid: 20,
    });
    createWarrantyReturn(db, {
      sale_id: replaced.id, sale_item_id: replaced.items[0].id,
      return_type: 'replacement', quantity: 1,
    });
    adjustStock(db, 2, 1, { reason: 'rma_replacement' });
    // A voided sale of part A: both engines must ignore it entirely.
    const doomed = createSale(db, {
      customer_name: 'Parity Void', payment_method: 'cash',
      items: [{ inventory_id: 1, item_type: 'part', quantity: 1, unit_price: 30 }],
      amount_paid: 30,
    });
    const { voidSale } = require('../src/sales');
    voidSale(db, doomed.id, 'parity test void', { actor: { type: 'manager', id: null, name: 'Manager' }, elevated: true });

    const local = getProductPerformance(db, '30d');
    const expected = local.products.find(p => p.id === 1);
    const expectedB = local.products.find(p => p.id === 2);
    assert.ok(expected && expectedB, 'the workstation computed both parts');

    // Mirror the same rows to the spawned cloud through the real drain: the
    // outbox already holds every write; pointing sync_url at the cloud and
    // draining pushes the exact dataset the workstation just measured.
    const running = await startCloud(cloudDir, { SHOP_SYNC_CREDENTIALS: JSON.stringify({ north: TOKEN_A }) });
    child = running.child;
    db.prepare("INSERT OR REPLACE INTO shop_settings (key, value) VALUES ('sync_url', ?)").run(running.base);
    db.prepare("INSERT OR REPLACE INTO shop_settings (key, value) VALUES ('sync_token', ?)").run(TOKEN_A);
    const shopId = getShopId(db);
    let guard = 0;
    while ((await drainOutbox(db)).synced > 0) {
      if (++guard > 2000) throw new Error('the mirror never drained');
    }

    const { cookie } = await login(running.base);
    const res = await fetch(`${running.base}/api/analytics?period=30d`, { headers: { cookie } });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    const cloudA = (data.top_products || []).find(p => String(p.item_name).includes('iPhone 11'));
    const cloudB = (data.top_products || []).find(p => String(p.item_name).includes('A50'));
    assert.ok(cloudA && cloudB, 'the cloud computed both parts');

    const near = (a, b, what) => assert.ok(
      Math.abs(Number(a) - Number(b)) < 0.011,
      `${what}: workstation ${a} vs cloud ${b}`
    );
    near(expected.units, cloudA.units, 'part A units');
    near(expected.revenue, cloudA.revenue, 'part A revenue (proportional discount minus all-time refund)');
    near(expected.profit, cloudA.profit, 'part A profit');
    near(expectedB.units, cloudB.units, 'part B units (replacement decrements)');
    near(expectedB.revenue, cloudB.revenue, 'part B revenue');
    near(expectedB.profit, cloudB.profit, 'part B profit (carries the replacement cost)');
  } finally {
    if (child) await stopCloud(child);
    try { db.close(); } catch (_) {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    try { fs.rmSync(cloudDir, { recursive: true, force: true }); } catch (_) {}
  }
});

// The 2026-11-09 audit's standing parity gap: the cloud recomputes the
// workstation's utang and inventory-value numbers over the mirror with its own
// SQL (cloud-deploy/server.js /api/standing) while the workstation computes
// them in getStandingStats (src/analytics.js). Nothing compared the two until
// now: one dataset, two engines, one answer, to the centavo, including a
// partial settlement, a voided sale, and a name case-fold.
test('cloud standing equals the workstation for the same dataset', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-standing-shop-'));
  const cloudDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-standing-cloud-'));
  fs.writeFileSync(path.join(cloudDir, 'manager-pin.txt'), '2468\n');
  const db = initDb(path.join(dir, 'shop.db'));
  let child;
  try {
    db.prepare(`INSERT INTO inventory (id, brand, model_name, part_type, cost_price, price_retail, price_technician, stock_quantity, min_stock_alert)
      VALUES (1, 'Apple', 'iPhone 11', 'LCD', 100, 30, 25, 12, 2)`).run();

    // Two debtors whose names fold together, a downpayment, and a partial
    // settlement that must restate the mirrored sale row's credit_balance.
    const saleA = createSale(db, {
      customer_name: 'Utang Joe', payment_method: 'credit',
      items: [{ inventory_id: 1, item_type: 'part', quantity: 1, unit_price: 30 }],
      amount_paid: 10,
    });
    createSale(db, {
      customer_name: 'utang joe', payment_method: 'credit',
      items: [{ inventory_id: 1, item_type: 'part', quantity: 2, unit_price: 30 }],
      amount_paid: 0,
    });
    settleCustomerCredit(db, { customer_name: 'Utang Joe', amount_paid: 15, payment_method: 'cash' });
    // A voided credit sale both engines must ignore entirely.
    const doomed = createSale(db, {
      customer_name: 'Utang Joe', payment_method: 'credit',
      items: [{ inventory_id: 1, item_type: 'part', quantity: 1, unit_price: 30 }],
      amount_paid: 0,
    });
    const { voidSale } = require('../src/sales');
    voidSale(db, doomed.id, 'parity standing void', { actor: { type: 'manager', id: null, name: 'Manager' }, elevated: true });
    const local = getStandingStats(db);

    const running = await startCloud(cloudDir, { SHOP_SYNC_CREDENTIALS: JSON.stringify({ north: TOKEN_A }) });
    child = running.child;
    db.prepare("INSERT OR REPLACE INTO shop_settings (key, value) VALUES ('sync_url', ?)").run(running.base);
    db.prepare("INSERT OR REPLACE INTO shop_settings (key, value) VALUES ('sync_token', ?)").run(TOKEN_A);
    let guard = 0;
    while ((await drainOutbox(db)).synced > 0) {
      if (++guard > 2000) throw new Error('the mirror never drained');
    }

    const { cookie } = await login(running.base);
    const res = await fetch(`${running.base}/api/standing`, { headers: { cookie } });
    assert.strictEqual(res.status, 200);
    const cloud = await res.json();

    const near = (a, b, what) => assert.ok(
      Math.abs(Number(a) - Number(b)) < 0.011,
      `${what}: workstation ${a} vs cloud ${b}`
    );
    near(local.total_credit_outstanding, cloud.outstanding_credit, 'outstanding utang (downpayment and settlement netted the same way)');
    near(local.total_debtors_count, cloud.debtors, 'debtor count (case-folded once, not twice)');
    assert.strictEqual(cloud.debtor_list.length, 1, 'the folded pair is one debtor row');
    near(local.total_credit_outstanding, cloud.debtor_list[0].balance, 'the single debtor carries the whole utang');
    near(local.total_inventory_retail_value, cloud.inventory_retail_value, 'inventory retail value (non-archived only)');
    near(local.total_inventory_cost_value, cloud.inventory_cost_value, 'inventory cost value');
  } finally {
    if (child) await stopCloud(child);
    try { db.close(); } catch (_) {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    try { fs.rmSync(cloudDir, { recursive: true, force: true }); } catch (_) {}
  }
});

// The reorder sheet and dead-stock report existed only on the workstation;
// the cloud's low-stock card filtered the newest-500 /api/rows window
// client-side and dropped older breaches once the catalog outgrew it. Both
// lists are now recomputed over the whole mirror, so one dataset must give
// one answer on both engines: a healthy part excluded, a below-minimum part
// in both lists, a never-sold shelf hugger dead-stock only, and a fast mover
// whose cover dropped under 14 days reorder-only.
test('cloud reorder and dead stock equal the workstation for the same dataset', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-reorder-shop-'));
  const cloudDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-reorder-cloud-'));
  fs.writeFileSync(path.join(cloudDir, 'manager-pin.txt'), '2468\n');
  const db = initDb(path.join(dir, 'shop.db'));
  let child;
  try {
    db.prepare(`INSERT INTO inventory (id, brand, model_name, part_type, cost_price, price_retail, price_technician, stock_quantity, min_stock_alert)
      VALUES (1, 'Apple', 'iPhone 11', 'LCD', 100, 30, 25, 50, 2)`).run();
    db.prepare(`INSERT INTO inventory (id, brand, model_name, part_type, cost_price, price_retail, price_technician, stock_quantity, min_stock_alert)
      VALUES (3, 'Xiaomi', 'Redmi 9', 'Housing', 40, 20, 15, 25, 2)`).run();
    db.prepare(`INSERT INTO inventory (id, brand, model_name, part_type, cost_price, price_retail, price_technician, stock_quantity, min_stock_alert)
      VALUES (4, 'Oppo', 'A5s', 'Battery', 100, 50, 45, 3, 5)`).run();
    db.prepare(`INSERT INTO inventory (id, brand, model_name, part_type, cost_price, price_retail, price_technician, stock_quantity, min_stock_alert)
      VALUES (5, 'Samsung', 'A50', 'Charging Port', 10, 25, 20, 24, 2)`).run();
    // Raw INSERTs do not ride the outbox; mirror the static rows the same way
    // the app's write paths would.
    for (const id of [1, 3, 4]) enqueueRow(db, 'inventory', id);
    // 20 units sold drops the shelf to 4: cover 4*30/20 = 6 days, fast mover.
    createSale(db, {
      customer_name: 'Fast Mover', payment_method: 'cash',
      items: [{ inventory_id: 5, item_type: 'part', quantity: 20, unit_price: 25 }],
      amount_paid: 500,
    });

    const localReorder = getReorderList(db, '30d');
    const localDead = getDeadStock(db, '30d');
    assert.deepStrictEqual(localReorder.map(r => r.id).sort((a, b) => a - b), [4, 5], 'workstation: below-min part plus the fast mover, nothing else');
    // Part 1 never sold either, so it is dead stock by the same rule even
    // though its stock level is healthy: no sales in the window is the only
    // criterion, sold parts (5) are the exclusions.
    assert.deepStrictEqual(localDead.map(r => r.id).sort((a, b) => a - b), [1, 3, 4], 'workstation: every no-sale shelf, sold parts excluded');

    const running = await startCloud(cloudDir, { SHOP_SYNC_CREDENTIALS: JSON.stringify({ north: TOKEN_A }) });
    child = running.child;
    db.prepare("INSERT OR REPLACE INTO shop_settings (key, value) VALUES ('sync_url', ?)").run(running.base);
    db.prepare("INSERT OR REPLACE INTO shop_settings (key, value) VALUES ('sync_token', ?)").run(TOKEN_A);
    let guard = 0;
    while ((await drainOutbox(db)).synced > 0) {
      if (++guard > 2000) throw new Error('the mirror never drained');
    }

    const { cookie } = await login(running.base);
    const cloudReorder = await (await fetch(`${running.base}/api/reorder?period=30d`, { headers: { cookie } })).json();
    const cloudDead = await (await fetch(`${running.base}/api/dead-stock?period=30d`, { headers: { cookie } })).json();
    const near = (a, b, what) => assert.ok(
      Math.abs(Number(a) - Number(b)) < 0.011,
      `${what}: workstation ${a} vs cloud ${b}`
    );

    assert.deepStrictEqual(cloudReorder.map(r => r.id).sort((a, b) => a - b), [4, 5], 'cloud reorder selects the same parts');
    assert.deepStrictEqual(cloudDead.map(r => r.id).sort((a, b) => a - b), [1, 3, 4], 'cloud dead stock selects the same parts');
    for (const lr of localReorder) {
      const cr = cloudReorder.find(x => x.id === lr.id);
      near(lr.units_sold, cr.units_sold, `part ${lr.id} units sold in window`);
      near(lr.cover_days, cr.cover_days, `part ${lr.id} cover days`);
      assert.strictEqual(lr.below_min, cr.below_min, `part ${lr.id} below_min flag`);
      assert.ok(cr.restock_qty >= 1 && cr.restock_cost >= 0, 'cloud rows carry a buy quantity and cost');
    }
    for (const ld of localDead) {
      const cd = cloudDead.find(x => x.id === ld.id);
      near(ld.tied_up_capital, cd.tied_up_capital, `part ${ld.id} tied-up capital`);
      assert.strictEqual(ld.days_no_sale, cd.days_no_sale, `part ${ld.id} days without a sale`);
      assert.strictEqual(ld.age_band, cd.age_band, `part ${ld.id} age band`);
      assert.strictEqual(ld.last_sold, cd.last_sold, `part ${ld.id} last-sold date (null when never sold)`);
    }
  } finally {
    if (child) await stopCloud(child);
    try { db.close(); } catch (_) {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    try { fs.rmSync(cloudDir, { recursive: true, force: true }); } catch (_) {}
  }
});

// The cloud /api/analytics rework: windowed KPIs must equal the workstation's
// getPeriodStats to the centavo, the previous window and its delta must ride
// along, the trend must carry profit (revenue minus costs minus refunds), and
// a custom single-day range must equal Today.
test('cloud period analytics equal the workstation, including the previous window and trend profit', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-period-shop-'));
  const cloudDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-period-cloud-'));
  fs.writeFileSync(path.join(cloudDir, 'manager-pin.txt'), '2468\n');
  const db = initDb(path.join(dir, 'shop.db'));
  let child;
  try {
    db.prepare(`INSERT INTO inventory (id, brand, model_name, part_type, cost_price, price_retail, price_technician, stock_quantity, min_stock_alert)
      VALUES (1, 'Apple', 'iPhone 11', 'LCD', 100, 30, 25, 50, 2)`).run();

    createSale(db, {
      customer_name: 'Today One', payment_method: 'cash',
      items: [{ inventory_id: 1, item_type: 'part', quantity: 2, unit_price: 30 }],
      amount_paid: 60,
    });
    createSale(db, {
      customer_name: 'Today Two', payment_method: 'credit',
      items: [{ inventory_id: 1, item_type: 'part', quantity: 1, unit_price: 30 }],
      amount_paid: 5,
    });
    settleCustomerCredit(db, { customer_name: 'Today Two', amount_paid: 10, payment_method: 'gcash', payment_reference: 'PARITY-GCASH-01' });
    adjustStock(db, 1, 7, { reason: 'receive' });

    // A restamped yesterday sale gives the delta a real previous window. The
    // outbox already holds the original snapshot, so the corrected row is
    // enqueued again and the mirror's last write wins.
    const yesterday = createSale(db, {
      customer_name: 'Yesterday One', payment_method: 'cash',
      items: [{ inventory_id: 1, item_type: 'part', quantity: 1, unit_price: 30 }],
      amount_paid: 30,
    });
    db.prepare('UPDATE sales SET created_at = ? WHERE id = ?').run(new Date(Date.now() - 86400000).toISOString(), yesterday.id);
    enqueueRow(db, 'sales', yesterday.id);

    const local = getPeriodStats(db, 'day');
    const localDashboard = getDashboardStats(db);

    const running = await startCloud(cloudDir, { SHOP_SYNC_CREDENTIALS: JSON.stringify({ north: TOKEN_A }) });
    child = running.child;
    db.prepare("INSERT OR REPLACE INTO shop_settings (key, value) VALUES ('sync_url', ?)").run(running.base);
    db.prepare("INSERT OR REPLACE INTO shop_settings (key, value) VALUES ('sync_token', ?)").run(TOKEN_A);
    let guard = 0;
    while ((await drainOutbox(db)).synced > 0) {
      if (++guard > 2000) throw new Error('the mirror never drained');
    }

    const { cookie } = await login(running.base);
    const cloud = await (await fetch(`${running.base}/api/analytics?period=day`, { headers: { cookie } })).json();
    const near = (a, b, what) => assert.ok(
      Math.abs(Number(a) - Number(b)) < 0.011,
      `${what}: workstation ${a} vs cloud ${b}`
    );

    near(local.current.revenue, cloud.current.revenue, 'current revenue');
    near(local.current.net_revenue, cloud.current.net_revenue, 'net revenue');
    near(local.current.net_profit, cloud.current.net_profit, 'net profit');
    near(local.current.credit_issued, cloud.current.credit_issued, 'utang issued (the credit downpayment)');
    near(local.current.credit_settled, cloud.current.credit_settled, 'utang settled');
    near(localDashboard.today_units_received, cloud.current.units_received, 'units received from the stock ledger');
    near(local.previous.revenue, cloud.previous.revenue, 'previous-window revenue (yesterday only)');
    assert.strictEqual(cloud.deltas.revenue, local.deltas.revenue, 'revenue delta vs the previous window');
    const localToday = local.trend[local.trend.length - 1];
    const cloudToday = cloud.trend[cloud.trend.length - 1];
    assert.strictEqual(cloudToday.bucket, localToday.bucket, 'the last trend bucket is today');
    near(localToday.profit, cloudToday.profit, 'trend profit (revenue minus costs minus refunds)');
    assert.strictEqual(cloud.range.from, local.range.from, 'window start matches the workstation');
    assert.strictEqual(cloud.previous_range.from, local.previous_range.from, 'previous-window start matches');

    const custom = await (await fetch(`${running.base}/api/analytics?period=custom&from=${new Date().toLocaleDateString('en-CA')}`, { headers: { cookie } })).json();
    near(cloud.current.revenue, custom.current.revenue, 'a custom single-day range equals Today');
  } finally {
    if (child) await stopCloud(child);
    try { db.close(); } catch (_) {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    try { fs.rmSync(cloudDir, { recursive: true, force: true }); } catch (_) {}
  }
});
