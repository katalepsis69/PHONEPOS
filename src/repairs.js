// phone-repair-pos/src/repairs.js
// Repair tickets: the server-side lifecycle the intake flow never had. A hold
// job or a claim stub used to be print-only; now the intake upserts a ticket
// keyed by its job reference (RO-...), the billed sale links back to it, and
// the queue tracks intake -> in_repair -> ready -> released.
const { txn, audit } = require('./audit');
const { money } = require('./money');
const { enqueueRow } = require('./sync');

const STATUSES = ['intake', 'in_repair', 'ready', 'released', 'cancelled'];

const TEXT_CAPS = {
  customer_name: 80,
  customer_phone: 60,
  device: 120,
  imei: 60,
  issue_note: 500,
  assigned_to: 80
};

function repairError(message, code, status = 400) {
  const e = new Error(message);
  e.statusCode = status;
  if (code) e.code = code;
  return e;
}

function cleanField(body, key) {
  if (body?.[key] === undefined) return undefined;
  return String(body[key]).trim().slice(0, TEXT_CAPS[key]);
}

function getRepair(db, id) {
  return db.prepare('SELECT * FROM repairs WHERE id = ?').get(id);
}

function getRepairByRef(db, ref) {
  return db.prepare('SELECT * FROM repairs WHERE ref_code = ?').get(ref);
}

// Create-or-update keyed by the job reference: the counter can hold a job,
// ring it up, or resume a draft in any order and the same POST lands the
// truth. Only provided fields change; the clock is the tiebreaker.
function upsertRepair(db, actor, body = {}) {
  const ref = String(body.ref_code || body.ref || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{3,39}$/.test(ref)) {
    throw repairError('A job reference (4-40 letters, digits, or dashes) is required');
  }
  const status = body.status === undefined ? undefined : String(body.status).trim();
  if (status !== undefined && !STATUSES.includes(status)) {
    throw repairError(`Unknown repair status: ${status}`);
  }
  const estimate = body.estimate === undefined || body.estimate === null || body.estimate === ''
    ? undefined
    : money(Number(body.estimate));
  if (estimate !== undefined && estimate < 0) throw repairError('Estimate must be zero or more');
  const saleId = body.sale_id === undefined || body.sale_id === null || body.sale_id === ''
    ? undefined
    : Number(body.sale_id);

  return txn(db, () => {
    const now = new Date().toISOString();
    const existing = getRepairByRef(db, ref);
    if (!existing) {
      const r = db.prepare(`
        INSERT INTO repairs (ref_code, customer_name, customer_phone, device, imei, issue_note,
                             estimate, status, sale_id, assigned_to, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        ref,
        cleanField(body, 'customer_name') || 'Walk-in Customer',
        cleanField(body, 'customer_phone') ?? '',
        cleanField(body, 'device') ?? '',
        cleanField(body, 'imei') ?? '',
        cleanField(body, 'issue_note') ?? '',
        estimate ?? 0.0,
        status ?? 'intake',
        Number.isSafeInteger(saleId) && saleId > 0 ? saleId : null,
        cleanField(body, 'assigned_to') ?? '',
        now, now
      );
      const id = Number(r.lastInsertRowid);
      enqueueRow(db, 'repairs', id);
      audit(db, actor, false, 'repair', 'create', { repair_id: id, ref_code: ref, status: status ?? 'intake' });
      return getRepair(db, id);
    }
    const fields = {};
    for (const key of ['customer_name', 'customer_phone', 'device', 'imei', 'issue_note', 'assigned_to']) {
      const v = cleanField(body, key);
      if (v !== undefined) fields[key] = v;
    }
    if (estimate !== undefined) fields.estimate = estimate;
    if (status !== undefined) fields.status = status;
    if (saleId !== undefined) fields.sale_id = Number.isSafeInteger(saleId) && saleId > 0 ? saleId : null;
    if (Object.keys(fields).length === 0) return existing;
    fields.updated_at = now;
    const sets = Object.keys(fields).map(k => `${k} = ?`).join(', ');
    db.prepare(`UPDATE repairs SET ${sets} WHERE id = ?`).run(...Object.values(fields), existing.id);
    enqueueRow(db, 'repairs', existing.id);
    audit(db, actor, false, 'repair', 'update', { repair_id: existing.id, ref_code: ref, changed: Object.keys(fields).filter(k => k !== 'updated_at') });
    return getRepair(db, existing.id);
  });
}

function updateRepair(db, id, body, actor) {
  return txn(db, () => {
    const existing = getRepair(db, Number(id));
    if (!existing) throw repairError('Repair ticket not found', null, 404);
    const patch = {};
    const status = body.status === undefined ? undefined : String(body.status).trim();
    if (status !== undefined) {
      if (!STATUSES.includes(status)) throw repairError(`Unknown repair status: ${status}`);
      patch.status = status;
    }
    const estimate = body.estimate === undefined || body.estimate === null || body.estimate === ''
      ? undefined
      : money(Number(body.estimate));
    if (estimate !== undefined) {
      if (estimate < 0) throw repairError('Estimate must be zero or more');
      patch.estimate = estimate;
    }
    for (const key of ['assigned_to', 'issue_note']) {
      const v = cleanField(body, key);
      if (v !== undefined) patch[key] = v;
    }
    if (Object.keys(patch).length === 0) return existing;
    patch.updated_at = new Date().toISOString();
    const sets = Object.keys(patch).map(k => `${k} = ?`).join(', ');
    db.prepare(`UPDATE repairs SET ${sets} WHERE id = ?`).run(...Object.values(patch), existing.id);
    enqueueRow(db, 'repairs', existing.id);
    audit(db, actor, false, 'repair', 'status' in patch ? 'status' : 'update', {
      repair_id: existing.id,
      ref_code: existing.ref_code,
      ...( 'status' in patch ? { from: existing.status, to: patch.status } : { changed: Object.keys(patch).filter(k => k !== 'updated_at') })
    });
    return getRepair(db, existing.id);
  });
}

// Active work floats up (intake/in_repair/ready by most recent touch);
// released and cancelled sink to the bottom so the queue reads as a bench.
function listRepairs(db, opts = {}) {
  const clauses = [];
  const params = [];
  if (opts.status && STATUSES.includes(opts.status)) {
    clauses.push('status = ?');
    params.push(opts.status);
  }
  const search = String(opts.search || '').trim();
  if (search) {
    clauses.push("(ref_code LIKE ? ESCAPE '\\' OR customer_name LIKE ? ESCAPE '\\' OR device LIKE ? ESCAPE '\\' OR imei LIKE ? ESCAPE '\\')");
    const like = `%${search.replace(/[%_\\]/g, c => `\\${c}`)}%`;
    params.push(like, like, like, like);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db.prepare(`
    SELECT * FROM repairs ${where}
    ORDER BY CASE WHEN status IN ('released', 'cancelled') THEN 1 ELSE 0 END ASC,
             updated_at DESC
    LIMIT 200
  `).all(...params);
  const counts = Object.fromEntries(STATUSES.map(st => [st, 0]));
  for (const c of db.prepare('SELECT status, COUNT(*) AS n FROM repairs GROUP BY status').all()) counts[c.status] = c.n;
  return { repairs: rows, counts, statuses: STATUSES };
}

module.exports = { upsertRepair, updateRepair, listRepairs, getRepair, getRepairByRef, STATUSES };
