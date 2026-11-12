// phone-repair-pos/tests/repairs.test.js
// Repair tickets: upsert-by-ref lifecycle. The counter can hold, ring up, and
// resume in any order; the same POST lands the truth, and the queue sorts
// active work above released/cancelled.
const assert = require('node:assert');
const { dbTest, serverTest } = require('./helper');
const { createSale } = require('../src/sales');
const { upsertRepair, updateRepair, listRepairs, STATUSES } = require('../src/repairs');

const MANAGER = { type: 'manager', id: null, name: 'Manager' };
const STAFF = { type: 'staff', id: 1, name: 'Ben' };

function repairError(fn) {
  try { fn(); } catch (e) { return e; }
  return null;
}

dbTest('upsertRepair creates, then updates the same ref without duplicating', (db) => {
  const first = upsertRepair(db, MANAGER, {
    ref: 'RO-251113-TEST', customer_name: ' Ana Reyes ', customer_phone: '0917...', device: ' iPhone 12 ',
    imei: '3567...', issue_note: ' no display ', estimate: 1500
  });
  assert.equal(first.ref_code, 'RO-251113-TEST');
  assert.equal(first.customer_name, 'Ana Reyes'); // trimmed
  assert.equal(first.status, 'intake');
  assert.equal(first.estimate, 1500);

  const second = upsertRepair(db, STAFF, { ref: 'RO-251113-TEST', device: 'iPhone 12 (back glass cracked)', status: 'in_repair' });
  assert.equal(second.id, first.id);
  assert.equal(second.customer_name, 'Ana Reyes', 'unprovided fields stay');
  assert.equal(second.device, 'iPhone 12 (back glass cracked)');
  assert.equal(second.status, 'in_repair');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM repairs').get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sync_outbox WHERE table_name = 'repairs'").get().n, 2);
  assert.ok(db.prepare("SELECT id FROM audit_log WHERE category = 'repair' AND action = 'create'").get());
  assert.ok(db.prepare("SELECT id FROM audit_log WHERE category = 'repair' AND action = 'update'").get());
});

dbTest('an empty customer_name falls back to Walk-in Customer', (db) => {
  const t = upsertRepair(db, MANAGER, { ref: 'RO-251113-EMPTY', customer_name: '   ' });
  assert.equal(t.customer_name, 'Walk-in Customer');
});

dbTest('upsertRepair validates ref, status, and estimate', (db) => {
  assert.match(repairError(() => upsertRepair(db, MANAGER, { ref: 'no spaces allowed' }))?.message, /job reference/);
  assert.match(repairError(() => upsertRepair(db, MANAGER, { ref: 'RO-251113-OK', status: 'exploded' }))?.message, /Unknown repair status/);
  assert.match(repairError(() => upsertRepair(db, MANAGER, { ref: 'RO-251113-OK', estimate: -5 }))?.message, /zero or more/);
  assert.match(repairError(() => updateRepair(db, 999, { status: 'ready' }, MANAGER))?.message, /not found/);
});

dbTest('updateRepair moves status with an audit trail and listRepairs sorts the bench', (db) => {
  const a = upsertRepair(db, MANAGER, { ref: 'RO-251113-A', customer_name: 'Ana', device: 'iPhone 12' });
  const b = upsertRepair(db, MANAGER, { ref: 'RO-251113-B', customer_name: 'Ben', device: 'Pixel 7' });
  const c = upsertRepair(db, MANAGER, { ref: 'RO-251113-C', customer_name: 'Cai', device: 'Tablet' });

  updateRepair(db, b.id, { status: 'ready', assigned_to: 'Ben' }, MANAGER);
  updateRepair(db, c.id, { status: 'released' }, MANAGER);

  const moved = updateRepair(db, a.id, { status: 'in_repair', estimate: 800 }, MANAGER);
  assert.equal(moved.status, 'in_repair');
  assert.equal(moved.estimate, 800);

  const list = listRepairs(db, {});
  assert.deepEqual(list.statuses, STATUSES);
  assert.deepEqual(list.counts, { intake: 0, in_repair: 1, ready: 1, released: 1, cancelled: 0 });
  assert.equal(list.repairs[0].status, 'in_repair', 'newest active first');
  assert.equal(list.repairs[list.repairs.length - 1].status, 'released', 'released sinks');

  const ready = listRepairs(db, { status: 'ready' });
  assert.equal(ready.repairs.length, 1);
  assert.equal(ready.repairs[0].assigned_to, 'Ben');

  const found = listRepairs(db, { search: 'pixel' });
  assert.equal(found.repairs.length, 1);
  assert.equal(found.repairs[0].ref_code, 'RO-251113-B');

  // Same-status rewrite is a no-op, not a new audit event.
  const auditBefore = db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE category = 'repair'").get().n;
  const noop = updateRepair(db, a.id, {}, MANAGER);
  assert.equal(noop.status, 'in_repair');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE category = 'repair'").get().n, auditBefore);
});

dbTest('a billed repair sale can link back through sale_id via upsert', (db) => {
  const item = db.prepare("INSERT INTO inventory (brand, model_name, part_type, cost_price, price_retail, price_technician, stock_quantity) VALUES ('T', 'X', 'Labor', 0, 0, 0, 5)").run();
  const sale = createSale(db, {
    customer_name: 'Ana', payment_method: 'cash', amount_paid: 500,
    items: [{ inventory_id: Number(item.lastInsertRowid), quantity: 1 }]
  });
  const ticket = upsertRepair(db, MANAGER, { ref: 'RO-251113-SALE', customer_name: 'Ana', status: 'in_repair', sale_id: sale.id });
  assert.equal(ticket.sale_id, sale.id);
  assert.equal(ticket.status, 'in_repair');
});

serverTest('/api/repairs upserts, lists, and patches without elevation', async (base, db, auth) => {
  const created = await fetch(`${base}/api/repairs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({ ref: 'RO-251113-HTTP', customer_name: 'Ana', device: 'iPhone 12', estimate: 1200 })
  });
  assert.equal(created.status, 201);
  const ticket = await created.json();
  assert.equal(ticket.status, 'intake');

  const bad = await fetch(`${base}/api/repairs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({ ref: 'x' })
  });
  assert.equal(bad.status, 400);

  const patched = await fetch(`${base}/api/repairs/${ticket.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({ status: 'ready' })
  });
  assert.equal(patched.status, 200);
  assert.equal((await patched.json()).status, 'ready');

  const badStatus = await fetch(`${base}/api/repairs/${ticket.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({ status: 'vibes' })
  });
  assert.equal(badStatus.status, 400);

  const list = await fetch(`${base}/api/repairs?search=iphone`, { headers: auth });
  assert.equal(list.status, 200);
  const body = await list.json();
  assert.equal(body.repairs.length, 1);
  assert.equal(body.counts.ready, 1);
});
