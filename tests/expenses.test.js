// phone-repair-pos/tests/expenses.test.js
// Operating expenses: CRUD + P&L integration. Expenses are bookkeeping only
// (the cash drawer math must not move) and net profit must shrink by them.
const assert = require('node:assert');
const { dbTest, serverTest, ensurePinChanged } = require('./helper');
const { addExpense, listExpenses, deleteExpense } = require('../src/expenses');
const { getPeriodStats, getDashboardStats } = require('../src/analytics');
const { money } = require('../src/money');

const MANAGER = { type: 'manager', id: null, name: 'Manager' };

function expenseError(fn) {
  try { fn(); } catch (e) { return e; }
  return null;
}

dbTest('addExpense books a row, enqueues sync, and writes one audit event', (db) => {
  const row = addExpense(db, MANAGER, { category: 'Rent', description: ' Stall 12 rent ', amount: '1500.005' });
  assert.equal(row.category, 'Rent');
  assert.equal(row.description, 'Stall 12 rent'); // trimmed
  assert.equal(row.amount, 1500.01); // money(): half away from zero, EPSILON-corrected

  const synced = db.prepare("SELECT COUNT(*) AS n FROM sync_outbox WHERE table_name = 'expenses'").get();
  assert.equal(synced.n, 1);
  const auditRow = db.prepare("SELECT category, action FROM audit_log WHERE action = 'add' AND category = 'expense'").get();
  assert.ok(auditRow);
});

dbTest('addExpense rejects empty category and non-positive or non-numeric amounts', (db) => {
  assert.match(expenseError(() => addExpense(db, MANAGER, { category: '  ', amount: 5 }))?.message, /Category is required/);
  assert.match(expenseError(() => addExpense(db, MANAGER, { category: 'Rent', amount: 0 }))?.message, /greater than zero/);
  assert.match(expenseError(() => addExpense(db, MANAGER, { category: 'Rent', amount: -50 }))?.message, /greater than zero/);
  assert.match(expenseError(() => addExpense(db, MANAGER, { category: 'Rent', amount: 'abc' }))?.message, /finite number/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM expenses').get().n, 0);
});

dbTest('listExpenses totals the whole window, not just the displayed rows', (db) => {
  const today = db.prepare("SELECT date('now','localtime') AS d").get().d;
  addExpense(db, MANAGER, { category: 'Rent', amount: 1000 });
  addExpense(db, MANAGER, { category: 'Utilities', amount: 250.5 });
  addExpense(db, MANAGER, { category: 'Rent', amount: 100 });

  const list = listExpenses(db, {});
  assert.equal(list.from, today);
  assert.equal(list.count, 3);
  assert.equal(list.total, 1350.5);
  assert.deepEqual(list.by_category.map(c => c.category), ['Rent', 'Utilities']);
  assert.equal(list.by_category[0].total, 1100);
  assert.equal(list.expenses.length, 3); // newest first, all three under the cap

  // A foreign window is empty even though today has rows.
  const other = listExpenses(db, { from: '2020-01-01', to: '2020-01-02' });
  assert.equal(other.total, 0);
  assert.equal(other.count, 0);
});

dbTest('deleteExpense requires elevation, audits, and enqueues the delete', (db) => {
  const row = addExpense(db, MANAGER, { category: 'Supplies', amount: 75 });
  assert.match(expenseError(() => deleteExpense(db, row.id, MANAGER, { elevated: false }))?.message, /authorization required/i);

  const done = deleteExpense(db, row.id, MANAGER, { elevated: true });
  assert.equal(done.success, true);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM expenses').get().n, 0);
  const del = db.prepare("SELECT payload FROM sync_outbox WHERE table_name = 'expenses' ORDER BY id DESC").get();
  assert.equal(JSON.parse(del.payload)._deleted, true);
  assert.ok(db.prepare("SELECT id FROM audit_log WHERE action = 'delete' AND category = 'expense'").get());
  assert.match(expenseError(() => deleteExpense(db, row.id, MANAGER, { elevated: true }))?.message, /not found/);
});

dbTest('period and dashboard net figures subtract operating expenses', (db) => {
  const before = getPeriodStats(db, 'day');
  addExpense(db, MANAGER, { category: 'Rent', amount: 400 });
  const after = getPeriodStats(db, 'day');
  assert.equal(after.current.expenses_total, 400);
  assert.equal(Number(after.current.net_profit), Number(before.current.net_profit) - 400);

  const dash = getDashboardStats(db);
  assert.equal(dash.today_expenses, 400);
});

serverTest('/api/expenses is elevation-gated end to end', async (base, db, auth) => {
  auth = await ensurePinChanged(base, auth);

  const denied = await fetch(`${base}/api/expenses`, { headers: { Authorization: auth.Authorization } });
  assert.equal(denied.status, 403);

  const created = await fetch(`${base}/api/expenses`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ category: 'Fuel', description: 'delivery run', amount: 120.5 })
  });
  assert.equal(created.status, 201);
  const row = await created.json();
  assert.equal(row.amount, 120.5);

  const bad = await fetch(`${base}/api/expenses`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ category: 'Fuel', amount: -3 })
  });
  assert.equal(bad.status, 400);

  const list = await fetch(`${base}/api/expenses`, { headers: auth });
  assert.equal(list.status, 200);
  const body = await list.json();
  assert.equal(body.total, 120.5);
  assert.equal(body.count, 1);

  const noElev = await fetch(`${base}/api/expenses/${row.id}`, { method: 'DELETE', headers: { Authorization: auth.Authorization } });
  assert.equal(noElev.status, 403);
  const del = await fetch(`${base}/api/expenses/${row.id}`, { method: 'DELETE', headers: auth });
  assert.equal(del.status, 200);
  const after = await fetch(`${base}/api/expenses`, { headers: auth });
  assert.equal((await after.json()).count, 0);
});
