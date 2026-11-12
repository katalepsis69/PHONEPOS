// phone-repair-pos/src/expenses.js
// Operating expenses: the P&L leg the sales ledger cannot see (rent, utilities,
// supplies, transport...). Bookkeeping records only; an expense never moves the
// cash drawer (reconciliation stays the drawer's own contract). Categories are
// free text so any business type tracks what it actually spends on.
const { txn, audit } = require('./audit');
const { money } = require('./money');
const { enqueueRow, enqueueDelete } = require('./sync');
const { opReplayed, opRecord } = require('./inventory');

const CATEGORY_MAX = 40;
const DESCRIPTION_MAX = 200;

function expenseError(message) {
  const e = new Error(message);
  e.statusCode = 400;
  return e;
}

function cleanText(value, max) {
  return String(value ?? '').trim().slice(0, max);
}

function addExpense(db, actor, body = {}) {
  const category = cleanText(body.category, CATEGORY_MAX);
  if (!category) throw expenseError('Category is required');
  const amount = money(Number(body.amount));
  if (!Number.isFinite(amount) || amount <= 0) throw expenseError('Amount must be greater than zero');
  const description = cleanText(body.description, DESCRIPTION_MAX);
  // Money write, so it dedups like the rest: a retried or double-clicked POST
  // replays the first booking instead of shrinking net profit twice.
  const opId = typeof body.op_id === 'string' && body.op_id.length <= 64 ? body.op_id : '';
  const replay = opReplayed(db, opId);
  if (replay) return db.prepare('SELECT * FROM expenses WHERE id = ?').get(replay.entity_id) || null;
  return txn(db, () => {
    const r = db.prepare(
      'INSERT INTO expenses (category, description, amount, actor_name, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(category, description, amount, actor?.name || '', new Date().toISOString());
    const id = Number(r.lastInsertRowid);
    if (opId) opRecord(db, opId, id);
    enqueueRow(db, 'expenses', id);
    audit(db, actor, false, 'expense', 'add', { expense_id: id, category, amount });
    return db.prepare('SELECT * FROM expenses WHERE id = ?').get(id);
  });
}

// Booked window uses the same local-date read the analytics KPIs use, so an
// expense saved at 23:59 lands on the day the shop was actually open.
function listExpenses(db, opts = {}) {
  const today = db.prepare("SELECT date('now','localtime') AS d").get().d;
  const from = /^\d{4}-\d{2}-\d{2}$/.test(String(opts.from || '')) ? String(opts.from) : today;
  const to = /^\d{4}-\d{2}-\d{2}$/.test(String(opts.to || '')) ? String(opts.to) : from;
  const agg = db.prepare(
    "SELECT COUNT(*) AS count, COALESCE(SUM(amount), 0.0) AS total FROM expenses WHERE date(created_at, 'localtime') BETWEEN ? AND ?"
  ).get(from, to);
  const byCategory = db.prepare(
    "SELECT category, COALESCE(SUM(amount), 0.0) AS total FROM expenses WHERE date(created_at, 'localtime') BETWEEN ? AND ? GROUP BY category ORDER BY total DESC"
  ).all(from, to).map(r => ({ category: r.category, total: money(r.total) }));
  // Display list is capped; the totals above cover the whole window.
  const expenses = db.prepare(
    "SELECT id, category, description, amount, actor_name, created_at, date(created_at, 'localtime') AS expense_date FROM expenses WHERE date(created_at, 'localtime') BETWEEN ? AND ? ORDER BY id DESC LIMIT 200"
  ).all(from, to);
  return { from, to, count: agg.count, total: money(agg.total), by_category: byCategory, expenses };
}

function deleteExpense(db, id, actor, ctx = {}) {
  if (!ctx.elevated) {
    const e = new Error('Manager authorization required');
    e.statusCode = 403;
    e.code = 'elevation_required';
    throw e;
  }
  return txn(db, () => {
    const row = db.prepare('SELECT * FROM expenses WHERE id = ?').get(id);
    if (!row) {
      const e = new Error('Expense not found');
      e.statusCode = 404;
      throw e;
    }
    db.prepare('DELETE FROM expenses WHERE id = ?').run(id);
    enqueueDelete(db, 'expenses', id);
    audit(db, actor, true, 'expense', 'delete', { expense_id: id, category: row.category, amount: row.amount });
    return { success: true };
  });
}

module.exports = { addExpense, listExpenses, deleteExpense };
