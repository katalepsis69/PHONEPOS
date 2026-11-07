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
const { createWarrantyReturn } = require('../src/returns');
const { adjustStock } = require('../src/inventory');
const { getProductPerformance } = require('../src/analytics');
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
