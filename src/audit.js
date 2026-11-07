// phone-repair-pos/src/audit.js
// Append-only audit trail. Actor comes from the verified session on the
// server — client payloads are never trusted for attribution.

// SAVEPOINT, not BEGIN: a savepoint nests inside a caller's transaction
// (importInventory, createSale) and acts as a deferred transaction when
// called standalone, so mutation + audit row always commit or roll back
// together without "cannot start a transaction within a transaction".
// ponytail: unique name per nesting — random suffix avoids cross-db global races;
// fixed counter shared across handles collided when two DBs interleaved.
function txn(db, fn) {
  const name = `audit_sp_${Math.random().toString(36).slice(2, 8)}_${Date.now().toString(36)}`;
  db.exec(`SAVEPOINT ${name}`);
  try {
    const result = fn();
    db.exec(`RELEASE ${name}`);
    return result;
  } catch (err) {
    try { db.exec(`ROLLBACK TO ${name}`); db.exec(`RELEASE ${name}`); } catch (_) {}
    throw err;
  }
}

const crypto = require('node:crypto');
function hashRow(prev, row) {
  // ponytail: single join hash — prev links chain, rest is row identity.
  // detail is the exact JSON.stringify string stored in the column.
  return crypto.createHash('sha256').update(
    String(prev) + '|' + row.id + '|' + (row.created_at||'') + '|' + (row.actor_type||'') + '|' + (row.actor_id??'') + '|' + (row.actor_name||'') + '|' + (row.category||'') + '|' + (row.action||'') + '|' + (row.detail||'') + '|' + (row.elevated??0)
  ).digest('hex');
}

// ctx = { actor, elevated } from the session layer. Module-level callers
// (tests, seeding) pass no actor and simply get no audit row.
// created_at is ISO-with-Z (matching sales/returns): SQLite's
// CURRENT_TIMESTAMP default emits UTC without a zone marker, and V8 parses
// that shape as local time — 8h display skew on UTC+8 machines.
function audit(db, actor, elevated, category, action, detail = null) {
  if (!actor) return;
  txn(db, () => {
    const detailStr = detail === null ? null : JSON.stringify(detail);
    const createdAt = new Date().toISOString();
    const actor_type = actor.type === 'staff' ? 'staff' : 'manager';
    const actor_id = actor.id ?? null;
    const actor_name = actor.name || '';
    const elevatedInt = elevated ? 1 : 0;
    // Single INSERT with predicted id — safe in SQLite's serialized single-writer
    // model; JS is single-threaded and SAVEPOINT holds RESERVED lock, so two
    // concurrent audits cannot interleave mid-transaction.
    const meta = db.prepare('SELECT COALESCE(MAX(id),0) AS m, (SELECT row_hash FROM audit_log ORDER BY id DESC LIMIT 1) AS h FROM audit_log').get();
    const prev = meta.h || '';
    const nextId = meta.m + 1;
    const h = hashRow(prev, { id: nextId, created_at: createdAt, actor_type, actor_id, actor_name, category, action, detail: detailStr, elevated: elevatedInt });
    db.prepare('INSERT INTO audit_log (id, created_at, actor_type, actor_id, actor_name, category, action, detail, elevated, row_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(nextId, createdAt, actor_type, actor_id, actor_name, category, action, detailStr, elevatedInt, h);
  });
}

function verifyChain(db) {
  // ponytail: stream in pages — loading 100k rows at once OOMs; hash still chained across pages
  let prev = '';
  let offset = 0;
  const PAGE = 2000;
  while (true) {
    const rows = db.prepare('SELECT id, created_at, actor_type, actor_id, actor_name, category, action, detail, elevated, row_hash FROM audit_log ORDER BY id ASC LIMIT ? OFFSET ?').all(PAGE, offset);
    if (rows.length === 0) break;
    for (const r of rows) {
      const expected = hashRow(prev, r);
      if (r.row_hash !== expected) return { ok: false, first_bad_id: r.id };
      prev = r.row_hash;
    }
    if (rows.length < PAGE) break;
    offset += PAGE;
  }
  return { ok: true, first_bad_id: null };
}

function listAuditLog(db, { category = '', actor = '', days = 30, limit = 100, offset = 0 } = {}) {
  const cappedLimit = Math.min(500, Math.max(1, Number(limit) || 100));
  const cappedOffset = Math.max(0, Number(offset) || 0);
  const where = [];
  const params = [];

  if (category) {
    where.push('category = ?');
    params.push(category);
  }
  if (actor) {
    const esc = s => s.replace(/[\\%_]/g, m => '\\' + m);
    where.push("actor_name LIKE ? ESCAPE '\\'");
    params.push(`%${esc(actor)}%`);
  }
  const daysNum = Number(days) || 0;
  if (daysNum > 0) {
    // datetime(created_at): ISO-with-Z vs SQLite's 'YYYY-MM-DD HH:MM:SS' shape
    // mis-compares on the boundary day (the 'T' beats the space), pulling in
    // rows from the cutoff day's early hours.
    where.push("datetime(created_at) >= datetime('now', ?)");
    params.push(`-${daysNum} days`);
  }

  const whereSql = where.length ? ` WHERE ${where.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) AS c FROM audit_log${whereSql}`).get(...params).c;
  const rows = db.prepare(`
    SELECT * FROM audit_log${whereSql}
    ORDER BY id DESC
    LIMIT ? OFFSET ?
  `).all(...params, cappedLimit, cappedOffset);

  return { total, rows };
}

module.exports = { txn, audit, listAuditLog, hashRow, verifyChain };
