const { money } = require('./money');
const { audit, txn } = require('./audit');
const { enqueueRow } = require('./sync');

// One drawer rule, two windows: a shop-local calendar day and an arbitrary
// shift range. analytics.getExpectedCash reads through here for the same reason.
// ponytail: use SQLite localtime predicates — JS Date('YYYY-MM-DD') parses as
// local midnight but .toISOString() shifts by UTC offset, mis-aligning created_at
// ISOs (UTC with Z) by ±14h. date(col,'localtime') matches analytics.js convention.
function bucketsFor(db, whereSql, params) {
  const byMethod = db.prepare(`
    SELECT CASE WHEN payment_method = 'credit' THEN 'cash' ELSE payment_method END AS payment_method,
      COALESCE(SUM(amount_paid - change_amount), 0) AS collected, COUNT(*) AS count
    FROM sales WHERE voided = 0 AND ${whereSql}
    -- GROUP BY the expression, not the column: the column keeps a separate
    -- credit group whose row then relabels itself 'cash' below and OVERWRITES
    -- the cash bucket (utang downpayment day showed a phantom drawer shortfall).
    GROUP BY CASE WHEN payment_method = 'credit' THEN 'cash' ELSE payment_method END
  `).all(...params);
  const buckets = {};
  for (const row of byMethod) buckets[row.payment_method] = { collected: money(row.collected), count: row.count };
  const settlements = db.prepare(`
    SELECT payment_method, COALESCE(SUM(amount_paid), 0) AS collected, COUNT(*) AS count
    FROM credit_payments WHERE ${whereSql}
    GROUP BY payment_method
  `).all(...params);
  for (const row of settlements) {
    const bucket = buckets[row.payment_method] || { collected: 0, count: 0 };
    bucket.collected = money(bucket.collected + row.collected);
    bucket.count += row.count;
    buckets[row.payment_method] = bucket;
  }
  const adj = db.prepare(`
    SELECT COALESCE(SUM(ca.amount), 0) AS s, COUNT(*) AS c
    FROM cash_adjustments ca
    WHERE ${whereSql.replace(/\bcreated_at\b/g, 'ca.created_at')}
      AND NOT EXISTS (
        SELECT 1 FROM sales s
        WHERE ca.source_kind = 'sale_void' AND s.id = ca.source_id
          AND (${whereSql.replace(/\bcreated_at\b/g, 's.created_at')})
      )
  `).get(...params, ...params);
  if (adj.c) {
    const bucket = buckets.cash || { collected: 0, count: 0 };
    bucket.collected = money(bucket.collected + adj.s);
    bucket.count += adj.c;
    buckets.cash = bucket;
  }
  const refundTotal = money(db.prepare(`SELECT COALESCE(SUM(refund_amount), 0) AS s FROM warranty_returns WHERE return_type = 'cash_refund' AND ${whereSql}`).get(...params).s);
  const voidCount = db.prepare(`SELECT COUNT(*) AS c FROM sales WHERE voided = 1 AND ${whereSql}`).get(...params).c;
  const grossSales = money(db.prepare(`SELECT COALESCE(SUM(total_amount), 0) AS s FROM sales WHERE voided = 0 AND ${whereSql}`).get(...params).s);
  const expectedCash = money((buckets.cash ? buckets.cash.collected : 0) - refundTotal);
  return { buckets, refund_total: refundTotal, void_count: voidCount, gross_sales: grossSales, expected_cash: expectedCash };
}

const DAY_WHERE = `date(created_at,'localtime') = ? AND created_at >= datetime(?,'-1 day') AND created_at < datetime(?,'+2 days')`;

function getDayBuckets(db, dateStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr))) throw new Error('Date must be YYYY-MM-DD');
  // 2026-02-30 passes the shape test but is not a day, and SQLite rolls it to
  // 2026-03-02 rather than rejecting it, so only the round trip catches it.
  const parsed = db.prepare('SELECT date(?) AS d').get(dateStr)?.d;
  if (parsed !== dateStr) throw new Error(`Not a real calendar date: ${dateStr}`);
  return { day: dateStr, ...bucketsFor(db, DAY_WHERE, [dateStr, dateStr, dateStr]) };
}

function closeDay(db, dateStr, countedCash, ctx = {}) {
  const counted = money(countedCash);
  if (counted < 0) throw new Error('Counted cash must be non-negative');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr))) throw new Error('Date must be YYYY-MM-DD');
  // The day model has no opening float: expected_cash is the day's collections
  // (plus settlements and adjustments) minus cash refunds, and the operator
  // counts today's takings, not the whole drawer. The overnight float is the
  // shift model's opening_float (shifts.js), where a shift count does include
  // it. The day-close screen states "excluding float" for this reason.
  // Only future days are refused: today stays closable so end-of-trade runs
  // work, and sales landing after the sign-off surface as after-close
  // exceptions with their own drawer adjustment.
  const today = db.prepare("SELECT date('now','localtime') AS d").get().d;
  if (String(dateStr) > today) throw new Error('Cannot close a day that has not ended');
  return txn(db, () => {
    const existing = db.prepare('SELECT id FROM day_reconciliations WHERE day = ?').get(dateStr);
    if (existing) throw new Error(`Day ${dateStr} is already reconciled`);
    const summary = getDayBuckets(db, dateStr);
    const variance = money(counted - summary.expected_cash);
    const status = Math.abs(variance) < 0.005 ? 'balanced' : 'flagged';
    const r = db.prepare('INSERT INTO day_reconciliations (day, counted_cash, expected_cash, variance, buckets, status, closed_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      dateStr, counted, summary.expected_cash, variance, JSON.stringify(summary.buckets), status, ctx.actor?.name || '', new Date().toISOString());
    enqueueRow(db, 'day_reconciliations', Number(r.lastInsertRowid));
    const id = Number(r.lastInsertRowid);
    audit(db, ctx.actor, ctx.elevated, 'day_close', 'close', { day: dateStr, counted_cash: counted, expected_cash: summary.expected_cash, variance, status });
    return { id, ...summary, counted_cash: counted, variance, status };
  });
}

// Was this instant already signed off (closed shift, or a reconciled day)?
// Money moving now against a signed period gets recorded and flagged, not rewritten.
function closedPeriodAt(db, isoTs) {
  if (!isoTs) return null;
  const shift = db.prepare(`
    SELECT id, closed_at, staff_name FROM shifts
    WHERE status = 'closed' AND closed_at IS NOT NULL
      AND datetime(opened_at) <= datetime(?) AND datetime(closed_at) >= datetime(?)
    ORDER BY id DESC LIMIT 1
  `).get(isoTs, isoTs);
  if (shift) return { kind: 'shift', label: `shift #${shift.id}`, signed_at: shift.closed_at, closed_by: shift.staff_name || 'a manager' };
  const rec = db.prepare("SELECT day, closed_by, created_at FROM day_reconciliations WHERE day = date(?, 'localtime')").get(isoTs);
  // A row with no created_at (legacy or hand-inserted; closeDay always sets it)
  // used to fall back to the bare day string, which Date.parse reads as UTC
  // midnight: sales in the second half of that local day then compared as
  // "after the close" and their voids paid no drawer adjustment. Local
  // end-of-day is the conservative reading of an unknown sign-off instant.
  if (rec) return { kind: 'day', label: rec.day, signed_at: rec.created_at || `${rec.day}T23:59:59`, closed_by: rec.closed_by || 'a manager' };
  return null;
}

function getDayReconciliation(db, dateStr) {
  const row = db.prepare('SELECT * FROM day_reconciliations WHERE day = ?').get(dateStr);
  if (!row) return null;
  return { ...row, buckets: JSON.parse(row.buckets) };
}

module.exports = { bucketsFor, closedPeriodAt, getDayBuckets, closeDay, getDayReconciliation };
