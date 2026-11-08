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
const { getProductPerformance, getStandingStats } = require('../src/analytics');
const { drainOutbox, getShopId } = require('../src/sync');
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
