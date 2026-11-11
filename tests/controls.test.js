// phone-repair-pos/tests/controls.test.js
// Anti-fraud internal controls: elevation gates, void, shifts, audit chain.
const { dbTest, serverTest, ensurePinChanged } = require('./helper');
const assert = require('node:assert/strict');
const { createSale, voidSale } = require('../src/sales');
const { createInventoryItem, getInventoryItem } = require('../src/inventory');
const { openShift, closeShift, listShifts } = require('../src/shifts');
const { verifyChain, audit } = require('../src/audit');
const { getDashboardStats, getExceptions } = require('../src/analytics');

const ctxMgr = { actor: { type: 'manager', id: null, name: 'Manager' }, elevated: true };

function seedPart(db, qty = 10) {
  return createInventoryItem(db, { brand: 'Apple', model_name: 'iPhone 11', part_type: 'LCD', cost_price: 100, price_retail: 500, price_technician: 400, stock_quantity: qty }, {}, {});
}

// 1. adjust-stock without elevation -> 403 elevation_required
serverTest('adjust-stock 403 unelevated', async (base, db, auth) => {
  const part = seedPart(db);
  const res = await fetch(`${base}/api/inventory/${part.id}/adjust-stock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: auth.Authorization }, // session, no X-Elevation
    body: JSON.stringify({ delta: 1, reason: 'receive' })
  });
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.equal(body.code, 'elevation_required');
});

// 2. void without elevation -> 403 elevation_required
serverTest('void-sale 403 unelevated', async (base, db, auth) => {
  const part = seedPart(db);
  const sale = createSale(db, { payment_method: 'cash', items: [{ inventory_id: part.id, item_type: 'part', quantity: 1 }], amount_paid: 500 }, ctxMgr);
  const res = await fetch(`${base}/api/sales/${sale.id}/void`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: auth.Authorization },
    body: JSON.stringify({ reason: 'test' })
  });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).code, 'elevation_required');
});

// 2b. replacement and credit_refund RMA also require elevation: every RMA
// type moves stock or money, not just cash_refund
serverTest('RMA replacement and credit_refund 403 unelevated', async (base, db, auth) => {
  const part = seedPart(db);
  const sale = createSale(db, { payment_method: 'cash', items: [{ inventory_id: part.id, item_type: 'part', quantity: 1 }], amount_paid: 500 }, ctxMgr);
  const si = db.prepare('SELECT * FROM sale_items WHERE sale_id = ?').get(sale.id);
  const sess = { ...auth };
  delete sess['X-Elevation'];
  for (const return_type of ['replacement', 'credit_refund']) {
    const res = await fetch(`${base}/api/sales/${sale.id}/returns`, {
      method: 'POST',
      headers: { ...sess, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sale_item_id: si.id, return_type, return_reason: 'other' })
    });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).code, 'elevation_required');
  }
});

// 2c. a null or comma-formatted count must never close a shift at zero
dbTest('closeShift rejects null/empty counted_cash and comma strings', (db) => {
  const shift = openShift(db, ctxMgr.actor, 0);
  assert.throws(() => closeShift(db, shift.id, null, ctxMgr), /required/);
  assert.throws(() => closeShift(db, shift.id, undefined, ctxMgr), /required/);
  assert.throws(() => closeShift(db, shift.id, '', ctxMgr), /required/);
  assert.throws(() => closeShift(db, shift.id, '1,250', ctxMgr), /finite|non-negative/);
  assert.strictEqual(db.prepare('SELECT status FROM shifts WHERE id = ?').get(shift.id).status, 'open');
});

// 2d. adjust-stock on a missing part answers 404, never 200-with-null
serverTest('adjust-stock on a deleted part is 404', async (base, db, auth) => {
  auth = await ensurePinChanged(base, auth);
  const res = await fetch(`${base}/api/inventory/999999/adjust-stock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({ delta: 1, reason: 'receive' })
  });
  assert.equal(res.status, 404);
});

// 3. void restores stock net of RMA and is excluded from analytics
dbTest('void restores stock net of RMA, excluded from analytics', async (db) => {
  const part = seedPart(db, 5);
  const sale = createSale(db, { payment_method: 'cash', items: [{ inventory_id: part.id, item_type: 'part', quantity: 2 }], amount_paid: 1000 }, ctxMgr);
  assert.equal(getInventoryItem(db, part.id).stock_quantity, 3);
  // RMA one of the two units
  const si = db.prepare('SELECT * FROM sale_items WHERE sale_id = ?').get(sale.id);
  db.prepare(`INSERT INTO warranty_returns (return_code, sale_id, sale_item_id, customer_name, item_name, quantity, return_type, return_reason, refund_amount, created_at)
    VALUES ('RMA-T1', ?, ?, 'X', 'LCD', 1, 'replacement', 'other', 0, ?)`).run(sale.id, si.id, new Date().toISOString());
  const v = voidSale(db, sale.id, 'test void', ctxMgr);
  // Only the non-returned unit is restored: 3 + 1 = 4
  assert.equal(getInventoryItem(db, part.id).stock_quantity, 4);
  assert.equal(v.restored, 1);
  assert.equal(getDashboardStats(db).today_sales_count, 0);
  assert.equal(getDashboardStats(db).today_sales_revenue, 0);
  // double void rejected
  assert.throws(() => voidSale(db, sale.id, 'again', ctxMgr), /already voided/);
});

// 4. void rejected when cash refund exists or credit settled
dbTest('void rejected on cash refund / settled credit', async (db) => {
  const part = seedPart(db, 5);
  const s1 = createSale(db, { payment_method: 'cash', items: [{ inventory_id: part.id, item_type: 'part', quantity: 1 }], amount_paid: 500 }, ctxMgr);
  const si1 = db.prepare('SELECT * FROM sale_items WHERE sale_id = ?').get(s1.id);
  db.prepare(`INSERT INTO warranty_returns (return_code, sale_id, sale_item_id, customer_name, item_name, quantity, return_type, return_reason, refund_amount, created_at)
    VALUES ('RMA-T2', ?, ?, 'X', 'LCD', 1, 'cash_refund', 'other', 500, ?)`).run(s1.id, si1.id, new Date().toISOString());
  assert.throws(() => voidSale(db, s1.id, 'r', ctxMgr), /cash refund/);

  const s2 = createSale(db, { customer_name: 'Debtor', payment_method: 'credit', items: [{ inventory_id: part.id, item_type: 'part', quantity: 1 }], amount_paid: 0 }, ctxMgr);
  db.prepare('UPDATE sales SET credit_balance = 0 WHERE id = ?').run(s2.id); // settled
  assert.throws(() => voidSale(db, s2.id, 'r', ctxMgr), /settled/);
});

// 5. blind close: expected_cash hidden while open, variance correct on close
dbTest('shift blind close variance', async (db) => {
  const s = openShift(db, { type: 'staff', id: 1, name: 'Ana' }, 100);
  const listed = listShifts(db, { type: 'staff', id: 1, name: 'Ana' });
  const openRow = listed.find(r => r.id === s.id);
  assert.equal(openRow.expected_cash, undefined); // blind: not exposed while open
  // one cash sale of 500 during the shift
  createSale(db, { payment_method: 'cash', items: [{ item_type: 'labor', item_name: 'Fix', quantity: 1, unit_price: 500 }], amount_paid: 500 }, ctxMgr);
  const closed = closeShift(db, s.id, 620, ctxMgr); // expected = 100 + 500 = 600
  assert.equal(closed.expected_cash, 600);
  assert.equal(closed.variance, 20);
  assert.equal(closed.status, 'closed');
  // single global open shift: second open → rejected while one is open
  const s2 = openShift(db, { type: 'staff', id: 2, name: 'Ben' }, 0);
  assert.throws(() => openShift(db, { type: 'staff', id: 1, name: 'Ana' }, 0), /already open/);
  closeShift(db, s2.id, 0, ctxMgr);
});

// 6. 5% discount flags in exceptions
dbTest('5% discount flags in exceptions', async (db) => {
  const part = seedPart(db, 5);
  createSale(db, { payment_method: 'cash', items: [{ inventory_id: part.id, item_type: 'part', quantity: 1, unit_price: 1000 }], discount: 60, amount_paid: 940 }, ctxMgr);
  const ex = getExceptions(db, 7);
  assert.equal(ex.discounts.length, 1);
});

// 8. A voided credit sale disappears from utang and cannot be settled
dbTest('voided credit sale leaves no debt behind', async (db) => {
  const { listCustomers, settleCustomerCredit } = require('../src/credits');
  const part = seedPart(db, 5);
  const sale = createSale(db, { customer_name: 'VoidUtang', payment_method: 'credit', items: [{ inventory_id: part.id, item_type: 'part', quantity: 1 }], amount_paid: 0 }, ctxMgr);
  let cust = listCustomers(db).find(c => c.customer_name === 'VoidUtang');
  assert.ok(cust.total_credit_balance > 0); // debt exists before void
  voidSale(db, sale.id, 'fake ring-up', ctxMgr);
  cust = listCustomers(db).find(c => c.customer_name === 'VoidUtang');
  assert.ok(!cust || cust.total_credit_balance === 0); // void dropped the debt
  assert.throws(() => settleCustomerCredit(db, { customer_name: 'VoidUtang', amount_paid: 100 }, ctxMgr), /no outstanding credit/);
});
dbTest('tampered audit row breaks chain', async (db) => {
  audit(db, ctxMgr.actor, true, 'test', 'one', { a: 1 });
  audit(db, ctxMgr.actor, true, 'test', 'two', { b: 2 });
  assert.deepEqual(verifyChain(db).ok, true);
  // Tamper: flip row data directly (bypass trigger to simulate DB-file edit)
  db.exec('DROP TRIGGER IF EXISTS audit_log_no_update');
  db.prepare("UPDATE audit_log SET actor_name = 'Forged' WHERE action = 'one'").run();
  db.exec(`CREATE TRIGGER IF NOT EXISTS audit_log_no_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END`);
  const v = verifyChain(db);
  assert.equal(v.ok, false);
  assert.ok(v.first_bad_id > 0);
});

// Regression: /api/audit used `Number(days) || 30`, so the UI's "All time"
// (days=0) silently showed only the last 30 days.
serverTest('/api/audit days=0 means all time, not 30 days', async (base, db, auth) => {
  auth = await ensurePinChanged(base, auth);
  // INSERT is allowed; the append-only trigger only blocks UPDATE/DELETE.
  db.prepare("INSERT INTO audit_log (created_at, actor_type, actor_name, category, action, elevated) VALUES (datetime('now','-60 days'), 'manager', 'Manager', 'system', 'old_backup', 1)").run();
  const all = await (await fetch(`${base}/api/audit?days=0`, { headers: auth })).json();
  const month = await (await fetch(`${base}/api/audit?days=30`, { headers: auth })).json();
  assert.ok(all.total > month.total, `all-time (${all.total}) must include the 60-day-old row; 30-day view (${month.total}) must not`);
});

dbTest('D4: gcash and transfer collections require a ref; cash does not', (db) => {
  const { createSale } = require('../src/sales');
  const { settleCustomerCredit } = require('../src/credits');
  createSale(db, { customer_name: 'Ref Check', payment_method: 'credit', items: [{ item_type: 'labor', item_name: 'LCD swap', unit_price: 400, quantity: 1 }], amount_paid: 100 });
  assert.throws(() => settleCustomerCredit(db, { customer_name: 'Ref Check', amount_paid: 50, payment_method: 'gcash' }), /ref # is required/i);
  assert.throws(() => settleCustomerCredit(db, { customer_name: 'Ref Check', amount_paid: 50, payment_method: 'transfer', payment_reference: '   ' }), /ref # is required/i);
  const paid = settleCustomerCredit(db, { customer_name: 'Ref Check', amount_paid: 50, payment_method: 'gcash', payment_reference: 'GC-991' }, ctxMgr);
  assert.equal(paid.payments[0].payment_reference, 'GC-991');
  // Cash still needs nothing: it is countable in the drawer on its own.
  settleCustomerCredit(db, { customer_name: 'Ref Check', amount_paid: 50, payment_method: 'cash' }, ctxMgr);
});

serverTest('D4: a collection above the shop threshold needs a manager', async (baseUrl, db, auth) => {
  auth = await ensurePinChanged(baseUrl, auth);
  const { createSale } = require('../src/sales');
  createSale(db, { customer_name: 'Big Debt', payment_method: 'credit', items: [{ item_type: 'labor', item_name: 'Panel', unit_price: 2000, quantity: 1 }], amount_paid: 0 });
  const noElev = { ...auth };
  delete noElev['X-Elevation'];

  const overThreshold = await fetch(`${baseUrl}/api/customers/${encodeURIComponent('Big Debt')}/settle-credit`, {
    method: 'POST', headers: { ...noElev, 'Content-Type': 'application/json' },
    body: JSON.stringify({ amount_paid: 1500, payment_method: 'cash' })
  });
  assert.equal(overThreshold.status, 403);
  assert.equal((await overThreshold.json()).code, 'elevation_required');

  const underThreshold = await fetch(`${baseUrl}/api/customers/${encodeURIComponent('Big Debt')}/settle-credit`, {
    method: 'POST', headers: { ...noElev, 'Content-Type': 'application/json' },
    body: JSON.stringify({ amount_paid: 100, payment_method: 'cash' })
  });
  assert.equal(underThreshold.status, 200, JSON.stringify(await underThreshold.json()));

  // The threshold is a shop setting, and the gate follows it.
  const raise = await fetch(`${baseUrl}/api/settings`, {
    method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ settle_elevation_threshold: '50' })
  });
  assert.equal(raise.status, 200);
  assert.equal((await raise.json()).settle_elevation_threshold, '50');
  const nowOver = await fetch(`${baseUrl}/api/customers/${encodeURIComponent('Big Debt')}/settle-credit`, {
    method: 'POST', headers: { ...noElev, 'Content-Type': 'application/json' },
    body: JSON.stringify({ amount_paid: 100, payment_method: 'cash' })
  });
  assert.equal(nowOver.status, 403);
});

serverTest('D3: the name-variants report lists spellings without merging anything', async (baseUrl, db, auth) => {
  auth = await ensurePinChanged(baseUrl, auth);
  const { createSale } = require('../src/sales');
  createSale(db, { customer_name: 'Ana Lim', payment_method: 'credit', items: [{ item_type: 'labor', item_name: 'LCD', unit_price: 300, quantity: 1 }], amount_paid: 0 });
  createSale(db, { customer_name: 'ANA LIM', payment_method: 'credit', items: [{ item_type: 'labor', item_name: 'Labor', unit_price: 100, quantity: 1 }], amount_paid: 0 });
  createSale(db, { customer_name: 'Solo Buyer', payment_method: 'credit', items: [{ item_type: 'labor', item_name: 'LCD', unit_price: 50, quantity: 1 }], amount_paid: 0 });

  const groups = await (await fetch(`${baseUrl}/api/customers/name-variants`, { headers: auth })).json();
  assert.equal(groups.length, 1, 'only the doubly-spelled name is reported');
  assert.deepEqual(groups[0].variants.slice().sort(), ['ANA LIM', 'Ana Lim']);
  assert.equal(groups[0].debt, 400);

  const noElev = { ...auth };
  delete noElev['X-Elevation'];
  const denied = await fetch(`${baseUrl}/api/customers/name-variants`, { headers: noElev });
  assert.equal(denied.status, 403);
  await denied.text();
});

serverTest('D1: day close routes are elevation-gated and sign a day once', async (baseUrl, db, auth) => {
  auth = await ensurePinChanged(baseUrl, auth);
  const { createSale } = require('../src/sales');
  const part = require('../src/inventory').createInventoryItem(db, { brand: 'X', model_name: 'Y', part_type: 'LCD', cost_price: 1, price_retail: 20, stock_quantity: 5 });
  createSale(db, { payment_method: 'cash', items: [{ inventory_id: part.id, quantity: 1, unit_price: 20 }], amount_paid: 20 });
  const day = db.prepare("SELECT date('now','localtime') AS d").get().d;
  const noElev = { ...auth };
  delete noElev['X-Elevation'];

  assert.equal((await fetch(`${baseUrl}/api/reconcile/${day}`, { headers: noElev })).status, 403);
  const pre = await (await fetch(`${baseUrl}/api/reconcile/${day}`, { headers: auth })).json();
  assert.equal(pre.day, day);
  assert.equal(pre.expected_cash, 20);
  assert.equal(pre.stored, null);
  assert.equal(pre.buckets.cash.count, 1);

  const closed = await fetch(`${baseUrl}/api/reconcile/close-day`, {
    method: 'POST', headers: { ...noElev, 'Content-Type': 'application/json' },
    body: JSON.stringify({ date: day, counted_cash: 18.5 })
  });
  assert.equal(closed.status, 403, 'a cashier cannot sign the day');
  await closed.json();

  const ok = await fetch(`${baseUrl}/api/reconcile/close-day`, {
    method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ date: day, counted_cash: 18.5 })
  });
  assert.equal(ok.status, 201);
  const result = await ok.json();
  assert.equal(result.status, 'flagged');
  assert.equal(result.variance, -1.5);

  const again = await fetch(`${baseUrl}/api/reconcile/close-day`, {
    method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ date: day, counted_cash: 20 })
  });
  assert.equal(again.status, 400);
  assert.match((await again.json()).error, /already reconciled/);

  const after = await (await fetch(`${baseUrl}/api/reconcile/${day}`, { headers: auth })).json();
  assert.equal(after.stored.counted_cash, 18.5);
  assert.equal(after.stored.status, 'flagged');

  const missing = await fetch(`${baseUrl}/api/reconcile/close-day`, {
    method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ date: day })
  });
  assert.equal(missing.status, 400);
  assert.match((await missing.json()).error, /Counted cash is required/);
});

dbTest('D1: the shift drawer and the day close read one cash rule', (db) => {
  const { createSale } = require('../src/sales');
  const { settleCustomerCredit } = require('../src/credits');
  const { createWarrantyReturn } = require('../src/returns');
  const { getDayBuckets } = require('../src/reconcile');
  const { getExpectedCash } = require('../src/analytics');
  const part = createInventoryItem(db, { brand: 'One', model_name: 'Rule', part_type: 'LCD', cost_price: 5, price_retail: 40, stock_quantity: 20 });
  const cash = createSale(db, { payment_method: 'cash', items: [{ inventory_id: part.id, quantity: 2, unit_price: 40 }], amount_paid: 80 });
  createSale(db, { customer_name: 'Debtor', payment_method: 'credit', items: [{ inventory_id: part.id, quantity: 1, unit_price: 40 }], amount_paid: 15 });
  settleCustomerCredit(db, { customer_name: 'Debtor', amount_paid: 10, payment_method: 'cash' });
  settleCustomerCredit(db, { customer_name: 'Debtor', amount_paid: 5, payment_method: 'gcash', payment_reference: 'GC-1' });
  createWarrantyReturn(db, { sale_id: cash.id, sale_item_id: cash.items[0].id, return_type: 'cash_refund', return_reason: 'other', refund_amount: 12 });

  const day = db.prepare("SELECT date('now','localtime') AS d").get().d;
  const buckets = getDayBuckets(db, day);
  // A window wide enough to hold the whole day must produce the same number.
  const wide = getExpectedCash(db, '1970-01-01T00:00:00.000Z', '2999-01-01T00:00:00.000Z');
  assert.equal(wide, buckets.expected_cash, 'one rule, two windows');
  assert.equal(buckets.expected_cash, 93, '80 sale + 15 downpayment + 10 cash settlement - 12 refund');
  assert.equal(buckets.buckets.gcash.collected, 5, 'a gcash collection lands in its own bucket, not the drawer');
});

dbTest('D8: each sale carries the cashier who rang it, and the drawer rolls up by person', (db) => {
  const { openShift, closeShift, getShiftBreakdown } = require('../src/shifts');
  const { createStaff } = require('../src/auth');
  const part = createInventoryItem(db, { brand: 'Who', model_name: 'Rang', part_type: 'LCD', cost_price: 5, price_retail: 50, stock_quantity: 20 });
  const ana = createStaff(db, 'Ana', '2468');
  const ben = createStaff(db, 'Ben', '1357');
  const asAna = { actor: { type: 'staff', id: ana.id, name: ana.name }, elevated: false };
  const asBen = { actor: { type: 'staff', id: ben.id, name: ben.name }, elevated: false };

  const shift = openShift(db, { type: 'staff', id: ana.id, name: ana.name }, 0);
  createSale(db, { payment_method: 'cash', items: [{ inventory_id: part.id, quantity: 1, unit_price: 50 }], amount_paid: 50 }, asAna);
  createSale(db, { payment_method: 'cash', items: [{ inventory_id: part.id, quantity: 2, unit_price: 50 }], amount_paid: 100 }, asBen);
  const mgrSale = createSale(db, { payment_method: 'cash', items: [{ inventory_id: part.id, quantity: 1, unit_price: 50 }], amount_paid: 50 }, ctxMgr);

  assert.equal(db.prepare('SELECT staff_id FROM sales WHERE id = ?').get(mgrSale.id).staff_id, null, 'a manager sale is not pinned to a cashier');
  const closed = closeShift(db, shift.id, 200, { actor: { type: 'manager', id: null, name: 'Boss' }, elevated: true });
  const byName = Object.fromEntries(closed.by_staff.map(r => [r.staff_name, r]));
  assert.equal(byName.Ana.cash_collected, 50);
  assert.equal(byName.Ben.cash_collected, 100);
  assert.equal(byName.Manager.cash_collected, 50, 'a manager row says manager, not a guessed name');
  assert.deepEqual(getShiftBreakdown(db, shift.id).map(r => r.staff_name).sort(), ['Ana', 'Ben', 'Manager']);

  // The attribution is written to the audit trail, not only to the response.
  const row = db.prepare("SELECT detail FROM audit_log WHERE category='shift' AND action='close' ORDER BY id DESC LIMIT 1").get();
  assert.match(row.detail, /"staff":"Ben","sales":1,"cash":100/);
});

serverTest('D1: a shaped-but-impossible date is refused by the day close, not read as empty', async (baseUrl, db, auth) => {
  auth = await ensurePinChanged(baseUrl, auth);
  const res = await fetch(`${baseUrl}/api/reconcile/2026-02-30`, { headers: auth });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /not a real calendar date/i);
  const ok = await fetch(`${baseUrl}/api/reconcile/2026-03-30`, { headers: auth });
  assert.equal(ok.status, 200);
  await ok.json();
});

dbTest('openShift refuses a non-numeric opening float instead of reading zero', (db) => {
  const { openShift } = require('../src/shifts');
  const actor = { type: 'manager', id: null, name: 'M' };
  assert.throws(() => openShift(db, actor, 'abc'), /finite number/);
  const shift = openShift(db, actor);
  assert.strictEqual(shift.opening_float, 0, 'an omitted float still reads as zero');
});
