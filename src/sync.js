// phone-repair-pos/src/sync.js
// Outbox-based push-up sync. Every write path in the shop DB enqueues a full
// row snapshot; the agent POSTs batches to the cloud and marks them synced.
// The cloud keys rows by (shop_id, table, local_id) so retries are idempotent.
const { randomUUID } = require('node:crypto');
const { validateSyncUrl } = require('./settings');
const { foldName, foldSql } = require('./names');

// Sync target. Set SYNC_URL (or shop setting 'sync_url') to enable; empty = off.
// Read at call time, not module load, so env changes are honored without
// reloading the module.
function envSyncUrl() {
  return process.env.SYNC_URL || '';
}
// Shop identity: unique per install, minted once.
const SHOP_ID_KEY = 'sync_shop_id';

function ensureSyncTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      table_name TEXT NOT NULL,
      local_id INTEGER NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL,
      synced_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_outbox_unsynced ON sync_outbox(synced_at) WHERE synced_at IS NULL;
  `);
  const shopId = db.prepare("SELECT value FROM shop_settings WHERE key = ?").get(SHOP_ID_KEY);
  if (!shopId) {
    db.prepare('INSERT INTO shop_settings (key, value) VALUES (?, ?)').run(SHOP_ID_KEY, randomUUID());
  }
}

function getShopId(db) {
  const row = db.prepare("SELECT value FROM shop_settings WHERE key = ?").get(SHOP_ID_KEY);
  return row ? row.value : null;
}

function getSyncUrl(db) {
  const env = envSyncUrl();
  if (env) return env;
  const row = db.prepare("SELECT value FROM shop_settings WHERE key = 'sync_url'").get();
  return row ? row.value.trim() : '';
}

function getSyncToken(db) {
  if (process.env.SYNC_TOKEN) return process.env.SYNC_TOKEN;
  const row = db.prepare("SELECT value FROM shop_settings WHERE key = 'sync_token'").get();
  return row ? row.value.trim() : '';
}

// Enqueue inside the caller's transaction: the row snapshot rides the same
// COMMIT/ROLLBACK as the write it mirrors.
function enqueue(db, table, localId, payload) {
  db.prepare(`
    INSERT INTO sync_outbox (table_name, local_id, payload, created_at)
    VALUES (?, ?, ?, ?)
  `).run(table, localId, JSON.stringify(payload), new Date().toISOString());
}

// ponytail: whitelist — table name can't be bound param
const ALLOWED_SYNC_TABLES = new Set(['inventory','sales','sale_items','stock_movements','credit_payments','warranty_returns','shop_settings','staff','audit_log','sync_outbox','shifts','day_reconciliations','cash_adjustments','customer_profiles']);
function enqueueDelete(db, table, localId) {
  if (!ALLOWED_SYNC_TABLES.has(table)) throw new Error(`Sync table not allowed: ${table}`);
  enqueue(db, table, localId, { _deleted: true });
}
function enqueueRow(db, table, localId) {
  if (!ALLOWED_SYNC_TABLES.has(table)) throw new Error(`Sync table not allowed: ${table}`);
  const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(localId);
  if (row) enqueue(db, table, localId, row);
}
// customer_profiles keys on customer_name, not id, so the mirror uses the
// implicit rowid as local_id. notes stays home on purpose: it is owner free
// text and not part of the mirror contract (privacy decision, 2026-09-27).
function enqueueCustomerProfile(db, customerName) {
  // Folded, not COLLATE NOCASE: a diacritic name re-cased must still find its
  // profile row (NOCASE folds ASCII only).
  const row = db.prepare(`SELECT rowid AS id, customer_name, credit_limit, phone, created_at, updated_at FROM customer_profiles WHERE ${foldSql(db, 'customer_name')} = ?`).get(foldName(customerName));
  if (row) enqueue(db, 'customer_profiles', Number(row.id), row);
}

async function postBatch(url, token, shopId, events, ackCommandIds) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 8000);
  const body = { shop_id: shopId, events };
  if (Array.isArray(ackCommandIds) && ackCommandIds.length > 0) {
    body.ack_command_ids = ackCommandIds;
  }
  try {
    return await fetch(url.replace(/\/$/, '') + '/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-sync-token': token },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally { clearTimeout(t); }
}

function applyCloudCommands(db, commands) {
  if (!Array.isArray(commands) || commands.length === 0) return [];
  const { adjustStock, importInventory } = require('./inventory');
  const ackedIds = [];
  for (const cmd of commands) {
    if (!cmd || !Number.isSafeInteger(cmd.id) || cmd.id <= 0) continue;
    const p = cmd.payload && typeof cmd.payload === 'object' ? cmd.payload : {};
    const opId = cmd.op_id || `cloud-cmd-${cmd.id}`;
    try {
      if (cmd.kind === 'adjust_stock') {
        // adjustStock(db, id, delta, meta, ctx): op_id rides meta, actor rides
        // ctx. Actor in meta left ctx empty, so audit() wrote no row.
        adjustStock(db, Number(p.id), Number(p.delta), {
          reason: p.reason || 'receive',
          note: p.note || 'Added from Cloud',
          op_id: opId,
        }, { actor: { type: 'manager', id: null, name: 'Cloud Manager' } });
        ackedIds.push(cmd.id);
      } else if (cmd.kind === 'import_inventory') {
        // importInventory(db, rows, ctx, meta): actor rides ctx, op_id rides
        // meta. op_id in ctx left meta empty, so a redelivered command doubled
        // every row's stock instead of replaying.
        importInventory(db, Array.isArray(p.rows) ? p.rows : [], {
          actor: { type: 'manager', id: null, name: 'Cloud Manager' },
        }, { op_id: opId });
        ackedIds.push(cmd.id);
      }
    } catch (err) {
      if (err && /not found|must be/i.test(String(err.message || ''))) {
        ackedIds.push(cmd.id);
      }
    }
  }
  return ackedIds;
}

async function ackAndFlushCommands(db, url, token, shopId, appliedIds, batch = 50) {
  if (!appliedIds.length) return;
  const rows = db.prepare(
    'SELECT id, table_name, local_id, payload FROM sync_outbox WHERE synced_at IS NULL ORDER BY id LIMIT ?'
  ).all(batch);
  const events = [];
  for (const r of rows) {
    try {
      const payload = JSON.parse(r.payload);
      const deleted = payload && payload._deleted === true;
      events.push({ outbox_id: r.id, table: r.table_name, local_id: r.local_id, deleted, row: deleted ? null : payload });
    } catch (_) {}
  }
  const res = await postBatch(url, token, shopId, events, appliedIds).catch(() => null);
  if (!res || !res.ok) return;
  const ack = await res.json().catch(() => ({}));
  const acked = new Set(ack.ok_ids || []);
  if (acked.size > 0) {
    const mark = db.prepare('UPDATE sync_outbox SET synced_at = ? WHERE id = ?');
    const now = new Date().toISOString();
    db.exec('BEGIN');
    try {
      for (const id of acked) mark.run(now, id);
      db.exec('COMMIT');
    } catch (_) {
      db.exec('ROLLBACK');
    }
  }
}

// Pair-time initial sync. The outbox only captures writes made while it
// existed, so a shop pairing an already-populated DB would push nothing.
// Current-state tables go in full; event tables follow the outbox's own
// 30-day retention window (the no-sync-url prune drops older rows anyway).
// ponytail: literal table list, the SQL is per-table by shape, and
// enqueueRow re-checks ALLOWED_SYNC_TABLES.
function backfillMirror(db) {
  let queued = 0;
  const recent = "datetime('now', '-30 days')";
  const add = (table, sql) => {
    for (const r of db.prepare(sql).all()) {
      enqueueRow(db, table, Number(r.id));
      queued++;
    }
  };
  add('inventory', 'SELECT id FROM inventory');
  add('sales', `SELECT id FROM sales WHERE datetime(created_at) >= ${recent}`);
  add('sale_items', `SELECT id FROM sale_items WHERE sale_id IN (SELECT id FROM sales WHERE datetime(created_at) >= ${recent})`);
  add('stock_movements', `SELECT id FROM stock_movements WHERE datetime(created_at) >= ${recent}`);
  add('credit_payments', `SELECT id FROM credit_payments WHERE datetime(created_at) >= ${recent}`);
  add('warranty_returns', `SELECT id FROM warranty_returns WHERE datetime(created_at) >= ${recent}`);
  add('shifts', `SELECT id FROM shifts WHERE datetime(opened_at) >= ${recent}`);
  add('day_reconciliations', `SELECT id FROM day_reconciliations WHERE datetime(created_at) >= ${recent}`);
  add('cash_adjustments', `SELECT id FROM cash_adjustments WHERE datetime(created_at) >= ${recent}`);
  for (const r of db.prepare('SELECT customer_name FROM customer_profiles').all()) {
    enqueueCustomerProfile(db, r.customer_name);
    queued++;
  }
  return { queued };
}

// Agent: drain up to `batch` unsent rows. Cloud 200 = marked synced. Network
// error / non-200 = left in the outbox, retried on the next tick.
async function drainOutbox(db, { batch = 50 } = {}) {
  const url = getSyncUrl(db);
  if (!url) {
    // Outbox policy while sync is off (decided 2026-09-27): rows still enqueue
    // so enabling sync later backfills the recent month, but anything older
    // than 30 days is dead weight and gets dropped. Without this the outbox
    // grows forever on an offline shop, because the synced-row prune below
    // only fires after a successful drain.
    try {
      // datetime() normalizes the ISO 'T'/'Z' shape: a raw string compare
      // against datetime('now') sorts the whole cutoff day after it ('T' > ' ')
      // and prunes a day late.
      db.prepare("DELETE FROM sync_outbox WHERE datetime(created_at) < datetime('now', '-30 days')").run();
    } catch (_) {}
    return { skipped: true, reason: 'no sync_url' };
  }
  // The shop-setting path validates through settings.js; a SYNC_URL env
  // override must meet the same bar (https, no private targets) or the agent
  // would stall forever against a host that can never be the real cloud.
  // Loopback plain-HTTP stays allowed, matching the cloud server's own bind
  // policy for local development.
  const parsed = new URL(url);
  const loopbackHttp = parsed.protocol === 'http:' &&
    ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname);
  if (!loopbackHttp) {
    try { validateSyncUrl(url); } catch (err) { throw new Error(`SYNC_URL invalid: ${err.message}`); }
  }
  const shopId = getShopId(db);
  if (!shopId) return { skipped: true, reason: 'no shop_id' };

  const token = getSyncToken(db);
  const rows = db.prepare(
    'SELECT id, table_name, local_id, payload FROM sync_outbox WHERE synced_at IS NULL ORDER BY id LIMIT ?'
  ).all(batch);
  if (rows.length === 0) {
    const res = await postBatch(url, token, shopId, []);
    if (!res.ok) throw new Error(`cloud sync responded ${res.status}`);
    const ack = await res.json().catch(() => ({}));
    const appliedIds = applyCloudCommands(db, ack.commands);
    if (appliedIds.length > 0) {
      await ackAndFlushCommands(db, url, token, shopId, appliedIds, batch);
    }
    return { synced: 0, heartbeat: true, commands_applied: appliedIds.length };
  }

  // One corrupt payload row must not poison the whole oldest-first window:
  // it stays pending (one wasted slot, visible in the status) while the rest
  // of the batch still flows.
  const events = [];
  let unreadable = 0;
  const unreadableIds = [];
  for (const r of rows) {
    let payload;
    try { payload = JSON.parse(r.payload); } catch (_) { unreadable++; unreadableIds.push(r.id); continue; }
    const deleted = payload && payload._deleted === true;
    events.push({ outbox_id: r.id, table: r.table_name, local_id: r.local_id, deleted, row: deleted ? null : payload });
  }
  if (events.length === 0) {
    // The whole window is corrupt: enqueue always writes valid JSON, so these
    // rows can never become readable and re-parsing them every 2s freezes the
    // drain behind a head-of-line block forever. Drop them the same way the
    // cloud-rejected path does; the local rows themselves are untouched.
    const drop = db.prepare('DELETE FROM sync_outbox WHERE id = ?');
    db.exec('BEGIN');
    try {
      for (const id of unreadableIds) drop.run(id);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    return { synced: 0, unreadable, quarantined: unreadableIds.length };
  }

  const res = await postBatch(url, token, shopId, events);
  if (!res.ok) throw new Error(`cloud sync responded ${res.status}`);
  const ack = await res.json().catch(() => ({}));
  const acked = new Set(ack.ok_ids || []);
  const bulkOk = ack.ok === true && !Array.isArray(ack.ok_ids);
  const rejectedIds = new Set((Array.isArray(ack.rejected) ? ack.rejected : [])
    .map(rj => rj && rj.outbox_id).filter(Boolean));

  const mark = db.prepare('UPDATE sync_outbox SET synced_at = ? WHERE id = ?');
  const drop = db.prepare('DELETE FROM sync_outbox WHERE id = ?');
  const now = new Date().toISOString();
  let marked = 0;
  let quarantined = 0;
  // Plain BEGIN, not txn(): audit.js requires this module, so requiring
  // txn() back from audit would be a broken require cycle.
  db.exec('BEGIN');
  try {
    for (const r of rows) {
      // A row the cloud refuses on every attempt is a poison pill: the local
      // row stays untouched, only its push is abandoned, and the log line
      // names the count so the drift is somebody's problem today.
      if (rejectedIds.has(r.id)) { drop.run(r.id); quarantined++; continue; }
      if (bulkOk || acked.has(r.id)) { mark.run(now, r.id); marked++; }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  const appliedIds = applyCloudCommands(db, ack.commands);
  if (appliedIds.length > 0) {
    await ackAndFlushCommands(db, url, token, shopId, appliedIds, batch);
  }
  // A 200 that acks nothing is a confused endpoint, not success: treating it
  // as success reset the backoff and re-POSTed the same batch every 2s
  // forever. Throwing feeds the normal failure backoff instead.
  if (marked === 0 && quarantined === 0) throw new Error(`Cloud sync acknowledged none of ${rows.length} queued rows`);
  return { synced: marked, unreadable, quarantined, commands_applied: appliedIds.length };
}

function getSyncStatus(db) {
  const url = getSyncUrl(db);
  const pending = db.prepare('SELECT COUNT(*) AS c FROM sync_outbox WHERE synced_at IS NULL').get().c;
  const total = db.prepare('SELECT COUNT(*) AS c FROM sync_outbox').get().c;
  const lastRow = db.prepare('SELECT synced_at FROM sync_outbox WHERE synced_at IS NOT NULL ORDER BY id DESC LIMIT 1').get();
  const synced = total - pending;
  let state;
  if (!url) state = 'local';
  else if (pending === 0) state = 'synced';
  else if (synced === 0 && pending > 0) state = 'attention';
  else state = 'syncing';
  const pendingRows = db.prepare('SELECT id, table_name, local_id, created_at FROM sync_outbox WHERE synced_at IS NULL ORDER BY id DESC LIMIT 20').all();
  return { state, pending, synced, total, url_configured: Boolean(url), last_synced_at: lastRow ? lastRow.synced_at : null, pending_rows: pendingRows };
}

module.exports = { ensureSyncTables, getShopId, getSyncUrl, getSyncToken, enqueue, enqueueRow, enqueueCustomerProfile, enqueueDelete, drainOutbox, getSyncStatus, backfillMirror };
