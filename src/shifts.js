const { txn, audit } = require('./audit');
const { money } = require('./money');
const { getExpectedCash } = require('./analytics');
const { enqueueRow } = require('./sync');

function openShift(db, actor, openingFloat = 0) {
  // closeShift refuses an absent count; open must not silently read garbage as
  // zero either.
  const amt = money(openingFloat === undefined || openingFloat === null || openingFloat === '' ? 0 : Number(openingFloat));
  if (amt < 0) throw new Error('Opening float cannot be negative');
  return txn(db, () => {
    const existing = db.prepare("SELECT id FROM shifts WHERE status='open' LIMIT 1").get();
    if (existing) { const e = new Error('Shift already open'); e.statusCode = 409; throw e; }
    const now = new Date().toISOString();
    const r = db.prepare('INSERT INTO shifts (staff_id, staff_name, opened_at, opening_float, status) VALUES (?, ?, ?, ?, ?)').run(actor?.id ?? null, actor?.name || '', now, amt, 'open');
    const id = Number(r.lastInsertRowid);
    enqueueRow(db, 'shifts', id);
    audit(db, actor, false, 'shift', 'open', { shift_id: id, opening_float: amt });
    return db.prepare('SELECT id, staff_id, staff_name, opened_at, opening_float, closed_at, counted_cash, expected_cash, variance, status FROM shifts WHERE id = ?').get(id);
  });
}

function closeShift(db, shiftId, countedCash, ctx = {}) {
  // A null/empty count must not silently become zero: that books a clean
  // drawer for a shift nobody counted.
  if (countedCash === null || countedCash === undefined || countedCash === '') {
    throw new Error('Counted cash is required');
  }
  const counted = money(Number(countedCash));
  if (isNaN(counted) || counted < 0) throw new Error('Counted cash must be non-negative');
  return txn(db, () => {
    const shift = db.prepare('SELECT * FROM shifts WHERE id = ?').get(shiftId);
    if (!shift) throw new Error('Shift not found');
    if (shift.status !== 'open') throw new Error('Shift already closed');
    // owner or manager
    if (ctx.actor && ctx.actor.type === 'staff' && shift.staff_id !== ctx.actor.id) {
      if (!ctx.elevated) { const e = new Error('Manager authorization required'); e.statusCode = 403; e.code = 'elevation_required'; throw e; }
    }
    const now = new Date().toISOString();
    const expected = money((shift.opening_float || 0) + getExpectedCash(db, shift.opened_at, now));
    const variance = money(counted - expected);
    db.prepare('UPDATE shifts SET closed_at = ?, counted_cash = ?, expected_cash = ?, variance = ?, status = ? WHERE id = ?').run(now, counted, expected, variance, 'closed', shiftId);
    enqueueRow(db, 'shifts', shiftId);
    const by_staff = getShiftBreakdown(db, shiftId);
    audit(db, ctx.actor, ctx.elevated, 'shift', 'close', {
      shift_id: shiftId, counted_cash: counted, expected_cash: expected, variance,
      by_staff: by_staff.map(s => ({ staff: s.staff_name, sales: s.sales, cash: s.cash_collected }))
    });
    return { ...db.prepare('SELECT id, staff_id, staff_name, opened_at, opening_float, closed_at, counted_cash, expected_cash, variance, status FROM shifts WHERE id = ?').get(shiftId), by_staff };
  });
}

// One drawer, possibly two cashiers: the count is signed for the workstation,
// so the takings have to be attributable per person or a variance lands on
// whoever happened to open the drawer.
function getShiftBreakdown(db, shiftId) {
  const shift = db.prepare('SELECT * FROM shifts WHERE id = ?').get(shiftId);
  if (!shift) return [];
  const to = shift.closed_at || new Date().toISOString();
  return db.prepare(`
    SELECT s.staff_id, COALESCE(st.name, CASE WHEN s.staff_id IS NULL THEN 'Manager' ELSE 'Removed cashier' END) AS staff_name,
           COUNT(*) AS sales,
           COALESCE(SUM(CASE WHEN s.payment_method IN ('cash','credit') THEN s.amount_paid - s.change_amount ELSE 0 END), 0) AS cash_collected,
           COALESCE(SUM(s.total_amount), 0) AS gross
    FROM sales s
    LEFT JOIN staff st ON st.id = s.staff_id
    WHERE s.voided = 0 AND datetime(s.created_at) >= datetime(?) AND datetime(s.created_at) <= datetime(?)
    GROUP BY s.staff_id, staff_name
    ORDER BY cash_collected DESC, sales DESC
  `).all(shift.opened_at, to).map(r => ({
    staff_id: r.staff_id, staff_name: r.staff_name, sales: r.sales,
    cash_collected: money(r.cash_collected), gross: money(r.gross)
  }));
}

function listShifts(db, actor) {
  const isManager = actor && actor.type === 'manager';
  // ponytail: staff sees own history plus any open shift they could close; managers see all.
  const rows = isManager
    ? db.prepare('SELECT id, staff_id, staff_name, opened_at, opening_float, closed_at, counted_cash, expected_cash, variance, status FROM shifts ORDER BY id DESC LIMIT 100').all()
    : db.prepare("SELECT id, staff_id, staff_name, opened_at, opening_float, closed_at, counted_cash, expected_cash, variance, status FROM shifts WHERE staff_id = ? OR status = 'open' ORDER BY id DESC LIMIT 100").all(actor?.id ?? -1);
  // blind count: never expose expected_cash/variance while a shift is open
  return rows.map(r => r.status === 'open' ? { ...r, expected_cash: undefined, variance: undefined } : r);
}

module.exports = { openShift, closeShift, listShifts, getShiftBreakdown };
