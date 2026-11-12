// phone-repair-pos/cloud/server.js
// Cloud sync service: runs on the Oracle VM (or anywhere). Same zero-dep
// stack as the shop server. Receives push-up batches from shops, stores one
// row per (shop_id, table, local_id) so retries are idempotent, and streams
// SSE "change" events for the manager web app.
//
// Start: node cloud/server.js   (PORT=8443 DATA_DIR=cloud/data optional)
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const rawPort = process.env.PORT || process.env.SERVER_PORT;
const PORT = rawPort ? parseInt(rawPort, 10) : 8443;
const isBotkeep = Boolean(process.env.SERVER_PORT);
const HOST = process.env.HOST || (isBotkeep ? '0.0.0.0' : '127.0.0.1');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'cloud.db');
const PUBLIC_DIR = path.join(__dirname, 'public');
const REMOTE_HTTP_ACK = process.env.CLOUD_HTTP_DEPLOYMENT_ACK === '1' || isBotkeep;
const TRUST_TLS_PROXY = process.env.TRUST_TLS_PROXY === '1' || isBotkeep;

// A present-but-blank MANAGER_PIN (deployment tooling produces '' through
// quoting) used to fall through to the file check and reopen unauthenticated
// /api/setup-pin with no error anywhere. Fail the boot instead.
if (process.env.MANAGER_PIN !== undefined && !String(process.env.MANAGER_PIN).trim()) {
  throw new Error('MANAGER_PIN is set but blank. Unset it, or give it a value: a blank value must not reopen the unauthenticated setup path.');
}

// Every analytics window buckets by the SHOP's clock. The mirrored created_at
// values are the register's UTC stamps, so 'localtime' means "this VPS happens
// to run on shop time". On a UTC VPS, set SHOP_TZ_OFFSET_MINUTES (480 for
// UTC+8) or the manager app's day buckets sit hours off the day close.
const SHOP_TZ_OFFSET_MINUTES = process.env.SHOP_TZ_OFFSET_MINUTES !== undefined
  && Number.isFinite(Number(process.env.SHOP_TZ_OFFSET_MINUTES))
  ? Math.trunc(Number(process.env.SHOP_TZ_OFFSET_MINUTES))
  : null;
const TZ_MODIFIER = SHOP_TZ_OFFSET_MINUTES === null
  ? "'localtime'"
  : `'${SHOP_TZ_OFFSET_MINUTES >= 0 ? '+' : ''}${SHOP_TZ_OFFSET_MINUTES} minutes'`;

function isLoopbackHost(host) {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}
if (!isLoopbackHost(HOST) && !REMOTE_HTTP_ACK) {
  throw new Error('Refusing remote plain-HTTP bind. Set CLOUD_HTTP_DEPLOYMENT_ACK=1 only when a trusted TLS proxy protects this service.');
}

// Per-shop credentials are stored as { "shop-id": "random-token" }. The
// authenticated credential, never the request body, selects the mirror tenant.
// The old shared token can be enabled temporarily for an explicit migration.
const TOKEN_PATH = path.join(DATA_DIR, 'sync-token.txt');
const CREDENTIALS_PATH = path.join(DATA_DIR, 'sync-credentials.json');
const MANAGER_PIN_PATH = path.join(DATA_DIR, 'manager-pin.txt');

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA cache_size = -64000;
  PRAGMA temp_store = MEMORY;
  PRAGMA mmap_size = 268435456;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS stores (
    store_id TEXT PRIMARY KEY,
    store_name TEXT NOT NULL,
    pin_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS shops (
    shop_id TEXT PRIMARY KEY,
    store_id TEXT REFERENCES stores(store_id),
    shop_name TEXT,
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL
  );
  -- Mirror of the shop rows, keyed for idempotent upsert.
  CREATE TABLE IF NOT EXISTS shop_rows (
    shop_id TEXT NOT NULL REFERENCES shops(shop_id),
    table_name TEXT NOT NULL,
    local_id INTEGER NOT NULL,
    row_json TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (shop_id, table_name, local_id)
  );
  CREATE INDEX IF NOT EXISTS idx_shop_rows_table_updated
    ON shop_rows(table_name, updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_shop_rows_shop_table_updated
    ON shop_rows(shop_id, table_name, updated_at DESC);
  CREATE TABLE IF NOT EXISTS cloud_commands (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shop_id TEXT NOT NULL REFERENCES shops(shop_id),
    op_id TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    acked_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_cloud_commands_pending
    ON cloud_commands(shop_id, id) WHERE acked_at IS NULL;
`);
try { db.exec('ALTER TABLE shops ADD COLUMN store_id TEXT REFERENCES stores(store_id)'); } catch (_) {}
try { db.exec('ALTER TABLE shops ADD COLUMN shop_name TEXT'); } catch (_) {}
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_shops_store
    ON shops(store_id);
  CREATE INDEX IF NOT EXISTS idx_stores_name
    ON stores(store_name COLLATE NOCASE);
`);

// Debtor names fold the same way the shop folds them (NFC + lowercase), or
// 'Jose' and 'jose' count as two debtors here while the shop counts one and the
// Utang tab splits a balance in two. Kept in sync with src/names.js by hand:
// this folder deploys on its own, so it does not require the shop tree.
function foldName(value) {
  return String(value ?? '').normalize('NFC').toLowerCase();
}
if (typeof db.function === 'function') {
  db.function('namefold', (v) => foldName(v == null ? '' : String(v)));
} else {
  console.error('[names] db.function is unavailable on this runtime; debtor name matching degrades to ASCII-only lower()');
}
const NAMEFOLD = typeof db.function === 'function' ? 'namefold' : 'LOWER';

console.log(SHOP_TZ_OFFSET_MINUTES === null
  ? `[clock] analytics bucket by this server's local time (${Intl.DateTimeFormat().resolvedOptions().timeZone || 'unknown zone'}); set SHOP_TZ_OFFSET_MINUTES when the VPS is not on shop time`
  : `[clock] analytics bucket by UTC offset ${SHOP_TZ_OFFSET_MINUTES >= 0 ? '+' : ''}${SHOP_TZ_OFFSET_MINUTES} minutes (SHOP_TZ_OFFSET_MINUTES)`);

// First run: mint tokens.
function readOrCreate(file, label) {
  try {
    if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  } catch (_) {}
  const token = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(file, token, { encoding: 'utf8', mode: 0o600 });
  console.log(`[setup] ${label} created and saved to ${file} (read the value from that file, not from a journal)`);
  return token;
}
function validShopId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value);
}

function loadShopCredentials() {
  let raw = process.env.SHOP_SYNC_CREDENTIALS || '';
  if (!raw && fs.existsSync(CREDENTIALS_PATH)) raw = fs.readFileSync(CREDENTIALS_PATH, 'utf8');
  if (!raw) {
    const shopId = validShopId(process.env.INITIAL_SHOP_ID) ? process.env.INITIAL_SHOP_ID : `shop-${crypto.randomBytes(6).toString('hex')}`;
    const token = crypto.randomBytes(32).toString('hex');
    const initial = { [shopId]: token };
    fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify(initial, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    console.log(`[setup] Per-shop sync credential created for ${shopId} in ${CREDENTIALS_PATH} (read the token from that file)`);
    return initial;
  }
  const parsed = JSON.parse(raw);
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('SHOP_SYNC_CREDENTIALS must be a JSON object');
  const seen = new Set();
  for (const [shopId, token] of Object.entries(parsed)) {
    if (!validShopId(shopId) || typeof token !== 'string' || token.length < 32) throw new Error(`Invalid sync credential entry for ${shopId}`);
    if (seen.has(token)) throw new Error('Each shop must have a unique sync token');
    seen.add(token);
  }
  if (seen.size === 0) throw new Error('At least one per-shop sync credential is required');
  return parsed;
}

const SHOP_CREDENTIALS = loadShopCredentials();
const ALLOW_LEGACY_SYNC_TOKEN = process.env.ALLOW_LEGACY_SYNC_TOKEN === '1';
const LEGACY_SYNC_TOKEN = ALLOW_LEGACY_SYNC_TOKEN ? readOrCreate(TOKEN_PATH, 'Legacy shared shop sync token') : null;

// Multi-tenant store accounts: PBKDF2 PIN hashing (100k rounds, 16-byte salt)
const PBKDF2_ITERATIONS = 100000;
const PBKDF2_PREFIX = 'pbkdf2$';
function hashPin(pin) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.pbkdf2Sync(String(pin), salt, PBKDF2_ITERATIONS, 32, 'sha256');
  return `${PBKDF2_PREFIX}${PBKDF2_ITERATIONS}$${salt.toString('hex')}$${hash.toString('hex')}`;
}
function verifyPinHash(stored, pin) {
  if (!stored) return false;
  if (stored.startsWith(PBKDF2_PREFIX)) {
    const [, iterStr, saltHex, hashHex] = stored.split('$');
    const hash = crypto.pbkdf2Sync(String(pin), Buffer.from(saltHex, 'hex'), Number(iterStr) || PBKDF2_ITERATIONS, 32, 'sha256');
    const expected = Buffer.from(hashHex, 'hex');
    return hash.length === expected.length && crypto.timingSafeEqual(hash, expected);
  }
  return timingSafeEq(stored, pin);
}

// A manager PIN the phone keypad can actually type. The old rotation wrote
// crypto.randomBytes(24).toString('hex'), exactly the 48-hex shape the legacy
// migration below rewrites, so every rotation self-destructed on the next boot.
function newManagerPin() {
  return String(crypto.randomInt(10000000, 100000000));
}
function getManagerPin() {
  if (process.env.MANAGER_PIN && process.env.MANAGER_PIN.trim()) {
    return process.env.MANAGER_PIN.trim();
  }
  try {
    if (fs.existsSync(MANAGER_PIN_PATH)) {
      const pin = fs.readFileSync(MANAGER_PIN_PATH, 'utf8').trim();
      // A legacy 48-hex auto-generated PIN cannot be typed on the keypad. It used
      // to be unlinked and reported as "no PIN", which reopened unauthenticated
      // POST /api/setup-pin and the default-1234 login on the next boot. Rotate
      // it in place instead: the file keeps holding a live PIN, so setup stays
      // closed, and the operator can still get in.
      if (/^[0-9a-f]{48}$/i.test(pin)) {
        const rotated = newManagerPin();
        try {
          fs.writeFileSync(MANAGER_PIN_PATH, rotated + '\n', { encoding: 'utf8', mode: 0o600 });
          console.log(`[setup] Legacy 48-hex manager PIN replaced with a keypad-typable PIN in ${MANAGER_PIN_PATH} (read it from that file)`);
          return rotated;
        } catch (err) {
          // Could not rewrite: keep the legacy value live rather than reopening setup.
          console.error(`[setup] Could not rewrite ${MANAGER_PIN_PATH}: ${err.message}`);
          return pin;
        }
      }
      return pin || null;
    }
  } catch (_) {}
  return null;
}

function ensureDefaultStore() {
  try {
    const rawPin = getManagerPin();
    const hash = rawPin ? hashPin(rawPin) : '';
    const now = new Date().toISOString();
    const storeCount = db.prepare('SELECT COUNT(*) AS c FROM stores').get()?.c || 0;
    if (storeCount === 0 || rawPin) {
      db.prepare('INSERT OR IGNORE INTO stores (store_id, store_name, pin_hash, created_at) VALUES (?, ?, ?, ?)').run('default', 'Main Store', hash, now);
      if (rawPin) {
        db.prepare("UPDATE stores SET pin_hash = ? WHERE store_id = 'default' AND (pin_hash = '' OR pin_hash IS NULL)").run(hash);
      }
    }
    const primaryStore = db.prepare("SELECT store_id FROM stores WHERE store_id = 'default'").get()
      || db.prepare("SELECT store_id FROM stores ORDER BY created_at ASC LIMIT 1").get();
    if (primaryStore) {
      db.prepare("UPDATE shops SET store_id = ? WHERE store_id IS NULL OR store_id = ''").run(primaryStore.store_id);
    }
    const adoptStoreId = primaryStore ? primaryStore.store_id : 'default';
    for (const shopId of Object.keys(SHOP_CREDENTIALS)) {
      db.prepare("INSERT OR IGNORE INTO shops (shop_id, store_id, shop_name, first_seen, last_seen) VALUES (?, ?, ?, ?, ?)").run(shopId, adoptStoreId, shopId, now, now);
    }
  } catch (_) {}
}
ensureDefaultStore();

const activePairingCodes = new Map();
const pairingCleaner = setInterval(() => {
  const now = Date.now();
  for (const [code, entry] of activePairingCodes) {
    if (now > entry.expiresAt) activePairingCodes.delete(code);
  }
  // pinAttempts keys are client addresses: an entry per address that ever
  // mistyped, and IPv6 keys are unlimited, so spent entries are dropped.
  for (const [key, attempt] of pinAttempts) {
    if (now - (attempt.at || 0) > PIN_ATTEMPT_IDLE_MS) pinAttempts.delete(key);
  }
}, 60000);
if (pairingCleaner.unref) pairingCleaner.unref();

// --- SSE clients (manager app) ---
const sseClients = new Set();
function broadcast(event, data, targetStoreId = null) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    if (targetStoreId && client.storeId && client.storeId !== targetStoreId) continue;
    try { client.write(msg); } catch (_) { sseClients.delete(client); }
  }
}

function authenticateShop(req, claimedShopId) {
  const supplied = String(req.headers['x-sync-token'] || '');
  for (const [shopId, token] of Object.entries(SHOP_CREDENTIALS)) {
    if (timingSafeEq(supplied, token)) return { shopId, legacy: false };
  }
  if (ALLOW_LEGACY_SYNC_TOKEN && timingSafeEq(supplied, LEGACY_SYNC_TOKEN) && validShopId(claimedShopId)) {
    return { shopId: claimedShopId, legacy: true };
  }
  return null;
}
function authorizedManager(req) {
  const cookies = Object.fromEntries(String(req.headers.cookie || '').split(';').map(v => v.trim().split('=').map(decodeURIComponent)).filter(v => v.length === 2));
  // Header support keeps older manager tabs functional during deployment; the
  // current app uses only the HttpOnly cookie and never puts it in an SSE URL.
  const h = cookies.manager_session || req.headers['x-manager-session'] || '';
  const s = managerSessions.get(h);
  if (!s) return null;
  const issuedAt = typeof s === 'number' ? s : s.issuedAt;
  if (Date.now() - issuedAt > SESSION_TTL_MS) { managerSessions.delete(h); return null; }
  if (typeof s === 'number') {
    return { storeId: 'default', storeName: 'Main Store', issuedAt: s };
  }
  return s; // { storeId, storeName, issuedAt }
}
// token -> { storeId, storeName, issuedAt }; sessions expire instead of living forever.
const managerSessions = new Map();
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

function getStoreShopFilter(sessionStoreId, shopParam, tableAlias = 'r') {
  const prefix = tableAlias ? `${tableAlias}.` : '';
  if (shopParam) {
    const belongs = db.prepare(`SELECT shop_id FROM shops WHERE shop_id = ? AND (store_id = ? OR (? = 'default' AND (store_id IS NULL OR store_id = '')))`).get(shopParam, sessionStoreId, sessionStoreId);
    if (!belongs) return { allowed: false, clause: ' AND 1 = 0', params: [] };
    return { allowed: true, clause: ` AND ${prefix}shop_id = ?`, params: [shopParam] };
  }
  return { allowed: true, clause: ` AND ${prefix}shop_id IN (SELECT shop_id FROM shops WHERE store_id = ? OR (? = 'default' AND (store_id IS NULL OR store_id = '')))`, params: [sessionStoreId, sessionStoreId] };
}

// Login brute-force lockout is per client, so one hostile address cannot lock
// every manager out. Behind the documented TLS proxy the socket address is the
// proxy's loopback for everyone; either trust env opts into the forwarded IP,
// taking the LAST X-Forwarded-For entry: a proxy that appends puts the real
// client there, while the first entry is whatever the client typed.
const MAX_PIN_ATTEMPTS = 5;
const PIN_LOCKOUT_MS = 5 * 60 * 1000;
const PIN_ATTEMPT_IDLE_MS = 30 * 60 * 1000;
const pinAttempts = new Map();
function timingSafeEq(a, b) {
  const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function clientKey(req) {
  if (process.env.TRUST_PROXY === '1' || TRUST_TLS_PROXY) {
    const parts = String(req.headers['x-forwarded-for'] || '').split(',').map(v => v.trim()).filter(Boolean);
    const candidate = parts[parts.length - 1];
    if (candidate && /^[0-9a-f:.]{3,45}$/i.test(candidate)) return candidate;
  }
  return req.socket.remoteAddress || 'unknown';
}

// /sync request budget (fixed window per client). With auth before readBody a
// hostile client pays nothing: 401 before a byte is parsed. The budget still
// caps a VALID credential from streaming unlimited batches; a legitimate shop
// never comes close (drain batch 50, tick 60s, debounce 2s). Exceeding it
// answers 429, which feeds the shop agent's existing failure backoff.
const SYNC_BUDGET_LIMIT = 120;
const SYNC_BUDGET_WINDOW_MS = 60000;
const syncBudget = new Map();
function fixedWindowBudget(map, limit, req) {
  const key = clientKey(req);
  const now = Date.now();
  let b = map.get(key);
  if (!b || now - b.start > SYNC_BUDGET_WINDOW_MS) { b = { start: now, count: 0 }; map.set(key, b); }
  b.count++;
  // A spoofable client key (X-Forwarded-For behind the trusted proxy) must not
  // grow an unbounded map: prune expired windows once the map gets large.
  if (map.size > 1000) {
    for (const [k, v] of map) if (now - v.start > SYNC_BUDGET_WINDOW_MS) map.delete(k);
  }
  return b.count > limit;
}
function syncBudgetExceeded(req) {
  return fixedWindowBudget(syncBudget, SYNC_BUDGET_LIMIT, req);
}
// /api/login shares the per-client idea at a tighter cap: the lockout punishes
// bad PINs, this punishes raw request floods against a public endpoint. The
// per-client key is a spoofable address (last X-Forwarded-For behind the TLS
// proxy), so a GLOBAL login budget backs it: one box cannot flood the process
// with 100k-round PBKDF2 verifies by rotating its claimed address.
const LOGIN_BUDGET_LIMIT = 30;
const LOGIN_GLOBAL_BUDGET_LIMIT = 240;
const loginBudget = new Map();
const loginGlobalBudget = { start: 0, count: 0 };
function loginBudgetExceeded(req) {
  const now = Date.now();
  if (now - loginGlobalBudget.start > 60000) { loginGlobalBudget.start = now; loginGlobalBudget.count = 0; }
  loginGlobalBudget.count++;
  if (loginGlobalBudget.count > LOGIN_GLOBAL_BUDGET_LIMIT) return true;
  return fixedWindowBudget(loginBudget, LOGIN_BUDGET_LIMIT, req);
}
// /api/pair is internet-facing too, and a 6-digit code carries 900k
// combinations over a 10-minute life. A real pairing is one attempt, so 20/min
// per client leaves it room and leaves brute force none.
const PAIR_BUDGET_LIMIT = 20;
const PAIR_GLOBAL_BUDGET_LIMIT = 120;
const pairBudget = new Map();
const pairGlobalBudget = { start: 0, count: 0 };
function pairBudgetExceeded(req) {
  // The per-client key is spoofable (last X-Forwarded-For), so a global cap
  // backs it: rotating claimed addresses cannot crawl the 900k code space.
  const now = Date.now();
  if (now - pairGlobalBudget.start > 60000) { pairGlobalBudget.start = now; pairGlobalBudget.count = 0; }
  pairGlobalBudget.count++;
  if (pairGlobalBudget.count > PAIR_GLOBAL_BUDGET_LIMIT) return true;
  return fixedWindowBudget(pairBudget, PAIR_BUDGET_LIMIT, req);
}

const ALLOWED_TABLES = new Map([
  ['inventory', ['brand', 'model_name', 'part_type']],
  ['sales', ['sale_code', 'customer_name', 'payment_method', 'total_amount', 'created_at']],
  ['sale_items', ['sale_id', 'item_type', 'quantity', 'total_price']],
  ['stock_movements', ['inventory_id', 'delta', 'reason', 'created_at']],
  ['credit_payments', ['customer_name', 'amount_paid', 'payment_method', 'created_at']],
  ['warranty_returns', ['return_code', 'sale_id', 'return_type', 'refund_amount', 'created_at']],
  ['shifts', ['opened_at', 'status']],
  ['day_reconciliations', ['day', 'counted_cash', 'expected_cash', 'variance', 'buckets', 'status', 'created_at']],
  ['cash_adjustments', ['amount', 'reason', 'created_at']],
  // description is deliberately absent from the required fields: owner free
  // text, same posture as customer_profiles notes below.
  ['expenses', ['category', 'amount', 'created_at']],
  // notes is deliberately absent from the required fields: the shop redacts
  // owner free text before it ever leaves (privacy contract, 2026-09-27).
  ['customer_profiles', ['customer_name', 'credit_limit']],
]);
const MANAGER_ROW_TABLES = new Set(['inventory', 'sales', 'credit_payments', 'warranty_returns', 'shifts', 'day_reconciliations', 'cash_adjustments', 'customer_profiles', 'expenses']);

function positiveId(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function validateEvents(events) {
  if (!Array.isArray(events) || events.length > 100) throw new Error('events must be an array of at most 100 items');
  return events.map(ev => {
    if (!ev || typeof ev !== 'object' || !ALLOWED_TABLES.has(ev.table)) throw new Error('event table is not allowed');
    if (!positiveId(ev.outbox_id) || !positiveId(ev.local_id)) throw new Error('event IDs must be positive safe integers');
    const deleting = ev.op === 'delete' || ev.deleted === true;
    if (ev.op && ev.op !== 'upsert' && ev.op !== 'delete') throw new Error('event op must be upsert or delete');
    if (!deleting) {
      if (!ev.row || Array.isArray(ev.row) || typeof ev.row !== 'object') throw new Error('upsert event row must be an object');
      if (ev.row.id !== ev.local_id) throw new Error('event row id must match local_id');
      for (const key of ALLOWED_TABLES.get(ev.table)) {
        if (ev.row[key] === undefined || ev.row[key] === null) throw new Error(`event row missing ${key}`);
      }
      const encoded = JSON.stringify(ev.row);
      if (encoded.length > 100000) throw new Error('event row is too large');
      return { ...ev, deleting, encoded };
    }
    return { ...ev, deleting, encoded: null };
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let rejected = false;
    req.on('data', c => {
      if (rejected) { req.destroy(); return; }
      body += c;
      if (body.length > 5e6) { rejected = true; reject(new Error('too large')); req.destroy(); }
    });
    req.on('end', () => { if (!rejected) resolve(body); });
    req.on('error', reject);
  });
}

function json(res, code, obj) {
  res.setHeader('Cache-Control', 'no-store');
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  if (TRUST_TLS_PROXY) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  try {
    // --- shop sync endpoint ---
    if (p === '/sync' && req.method === 'POST') {
      if (syncBudgetExceeded(req)) return json(res, 429, { error: 'sync budget exceeded; retry later' });
      // Auth before readBody: the per-shop credential check is header-only,
      // so an unauthenticated client no longer gets megabytes parsed for free
      // (measured: a 4MB wrong-token request cost ~22ms, 401 only after the
      // full parse). The opt-in legacy shared token still needs the body:
      // it carries the claimed shop id.
      let auth = authenticateShop(req, null);
      if (!auth && !ALLOW_LEGACY_SYNC_TOKEN) return json(res, 401, { error: 'bad sync credential' });
      const { shop_id: claimedShopId, events = [], ack_command_ids } = JSON.parse(await readBody(req) || '{}');
      if (!auth) auth = authenticateShop(req, claimedShopId);
      if (!auth) return json(res, 401, { error: 'bad sync credential' });
      // Per-event validation: one invalid row must not freeze every newer
      // event behind it in the shop's oldest-first outbox forever. Valid rows
      // apply; rejected ones ride back with their reason so the shop can
      // quarantine them and keep flowing.
      if (!Array.isArray(events) || events.length > 100) {
        return json(res, 400, { error: 'events must be an array of at most 100 items' });
      }
      const validated = [];
      const rejected = [];
      for (const ev of events) {
        try { validated.push(validateEvents([ev])[0]); }
        catch (e) { rejected.push({ outbox_id: ev && ev.outbox_id, error: String((e && e.message) || e) }); }
      }
      if (validated.length === 0 && rejected.length) return json(res, 400, { error: rejected[0].error, rejected });
      const shopId = auth.shopId;

      const now = new Date().toISOString();
      const defStore = db.prepare("SELECT store_id FROM stores WHERE store_id = 'default'").get()
        || db.prepare("SELECT store_id FROM stores ORDER BY created_at ASC LIMIT 1").get();
      const targetStoreId = defStore ? defStore.store_id : null;
      const heartbeat = db.prepare(`INSERT INTO shops (shop_id, store_id, first_seen, last_seen)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(shop_id) DO UPDATE SET last_seen = excluded.last_seen, store_id = COALESCE(shops.store_id, excluded.store_id)`);
      const upsert = db.prepare(`
        INSERT INTO shop_rows (shop_id, table_name, local_id, row_json, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (shop_id, table_name, local_id)
        DO UPDATE SET row_json = excluded.row_json, updated_at = excluded.updated_at
      `);
      const remove = db.prepare('DELETE FROM shop_rows WHERE shop_id = ? AND table_name = ? AND local_id = ?');
      const ackCmd = db.prepare('UPDATE cloud_commands SET acked_at = ? WHERE shop_id = ? AND id = ? AND acked_at IS NULL');
      const okIds = [];
      let ackedCmdCount = 0;
      db.exec('BEGIN');
      try {
        heartbeat.run(shopId, targetStoreId, now, now);
        if (Array.isArray(ack_command_ids)) {
          for (const cid of ack_command_ids) {
            if (positiveId(cid)) {
              const info = ackCmd.run(now, shopId, cid);
              if (info && info.changes > 0) ackedCmdCount += info.changes;
            }
          }
        }
        for (const ev of validated) {
          if (ev.deleting) remove.run(shopId, ev.table, ev.local_id);
          else upsert.run(shopId, ev.table, ev.local_id, ev.encoded, now);
          okIds.push(ev.outbox_id);
        }
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        // Fixed text only: this catch is reachable from the internet and the
        // transaction text is constraint wording, not an API. The detail stays
        // in the service log.
        console.error('[sync] transaction failed:', err && err.message ? err.message : err);
        return json(res, 400, { error: 'the batch could not be stored; retry later' });
      }

      const pendingCommands = db.prepare(
        'SELECT id, op_id, kind, payload_json, created_at FROM cloud_commands WHERE shop_id = ? AND acked_at IS NULL ORDER BY id ASC LIMIT 50'
      ).all(shopId).map(c => ({
        id: c.id,
        op_id: c.op_id,
        kind: c.kind,
        payload: JSON.parse(c.payload_json),
        created_at: c.created_at,
      }));

      const shopOwner = db.prepare('SELECT store_id FROM shops WHERE shop_id = ?').get(shopId);
      const storeId = shopOwner ? shopOwner.store_id : null;
      // An empty batch is the shop's 60s heartbeat, not news: broadcasting it
      // made every manager phone run a full refetch once a minute per shop.
      if (validated.length > 0 || ackedCmdCount > 0) {
        broadcast('change', { shop_id: shopId, count: validated.length || ackedCmdCount, tables: [...new Set(validated.map(e => e.table))] }, storeId);
      }
      return json(res, 200, { ok: true, protocol: 2, shop_id: shopId, legacy_credential: auth.legacy, ok_ids: okIds, rejected, commands: pendingCommands });
    }

    // --- manager auth & pairing ---
    if (p === '/api/auth-state' && req.method === 'GET') {
      const session = authorizedManager(req);
      return json(res, 200, {
        ok: true,
        pin_set: Boolean(getManagerPin()),
        logged_in: Boolean(session),
        store_id: session ? session.storeId : null,
        store_name: session ? session.storeName : null
      });
    }

    if (p === '/api/create-store' && req.method === 'POST') {
      if (loginBudgetExceeded(req)) return json(res, 429, { error: 'too many attempts; retry later' });
      const { store_name, pin, manager_pin } = JSON.parse(await readBody(req) || '{}');
      const cleanName = String(store_name || '').trim();
      const cleanPin = String(pin || '').trim();
      if (!cleanName || cleanName.length < 2 || cleanName.length > 50) {
        return json(res, 400, { error: 'Store name must be between 2 and 50 characters' });
      }
      if (!/^[0-9a-zA-Z]{4,12}$/.test(cleanPin)) {
        return json(res, 400, { error: 'PIN must be between 4 and 12 characters' });
      }
      // First-run bootstrap is unauthenticated; once a claimed store exists
      // the door needs the server's owner PIN. Left wide open this route is
      // an unauthenticated store mint on a public box whose claim UPDATE
      // adopts any shop the operator has not attached yet.
      const claimedStore = db.prepare("SELECT store_id FROM stores WHERE pin_hash != '' AND pin_hash IS NOT NULL LIMIT 1").get();
      if (claimedStore) {
        const serverPin = getManagerPin();
        if (!serverPin || !timingSafeEq(String(manager_pin || ''), serverPin)) {
          return json(res, 403, { error: 'This server already has an owner: adding a store needs the server manager PIN.' });
        }
      }
      const existing = db.prepare('SELECT store_id FROM stores WHERE LOWER(store_name) = LOWER(?)').get(cleanName);
      if (existing) {
        return json(res, 409, { error: 'A store with this name already exists. Please choose a different name or sign in.' });
      }
      const slug = cleanName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 20) || 'store';
      const storeId = `${slug}-${crypto.randomBytes(3).toString('hex')}`;
      const now = new Date().toISOString();
      const pinHash = hashPin(cleanPin);
      db.prepare('INSERT INTO stores (store_id, store_name, pin_hash, created_at) VALUES (?, ?, ?, ?)').run(storeId, cleanName, pinHash, now);
      // Adopt only truly unassigned shops. The old clause also stole every
      // 'default' shop while default had no PIN, so an internet client could
      // claim another operator's paired registers before setup-pin ran.
      db.prepare(`UPDATE shops SET store_id = ? WHERE store_id IS NULL OR store_id = ''`).run(storeId);

      const token = crypto.randomUUID();
      managerSessions.set(token, { storeId, storeName: cleanName, issuedAt: Date.now() });
      const secure = TRUST_TLS_PROXY ? '; Secure' : '';
      res.setHeader('Set-Cookie', `manager_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL_MS / 1000}${secure}`);
      return json(res, 200, { ok: true, store_id: storeId, store_name: cleanName });
    }

    if (p === '/api/setup-pin' && req.method === 'POST') {
      if (loginBudgetExceeded(req)) return json(res, 429, { error: 'too many attempts; retry later' });
      // First-run bootstrap only. Rotation is a server-side operation, so this route
      // must never be able to replace a PIN that is already live: without this guard
      // an unauthenticated visitor could overwrite the PIN and take the session cookie
      // this same response hands back.
      if (getManagerPin()) {
        return json(res, 403, { error: 'A manager PIN is already set. Rotate it on the server: node cloud/server.js --rotate-pin' });
      }
      const { pin } = JSON.parse(await readBody(req) || '{}');
      const cleanPin = String(pin || '').trim();
      if (!/^[0-9a-zA-Z]{4,12}$/.test(cleanPin)) {
        return json(res, 400, { error: 'PIN must be between 4 and 12 characters' });
      }
      fs.writeFileSync(MANAGER_PIN_PATH, cleanPin + '\n', { encoding: 'utf8', mode: 0o600 });
      const now = new Date().toISOString();
      const hash = hashPin(cleanPin);
      db.prepare('INSERT INTO stores (store_id, store_name, pin_hash, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(store_id) DO UPDATE SET pin_hash = excluded.pin_hash').run('default', 'Main Store', hash, now);
      db.prepare("UPDATE shops SET store_id = 'default' WHERE store_id IS NULL OR store_id = ''").run();
      const token = crypto.randomUUID();
      managerSessions.set(token, { storeId: 'default', storeName: 'Main Store', issuedAt: Date.now() });
      const secure = TRUST_TLS_PROXY ? '; Secure' : '';
      res.setHeader('Set-Cookie', `manager_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL_MS / 1000}${secure}`);
      return json(res, 200, { ok: true });
    }

    if (p === '/api/pair' && req.method === 'POST') {
      // Budget before the body: a guess loop must not pay for a 5MB parse, and a
      // 6-digit code must not be loopable for its whole 10-minute life.
      if (pairBudgetExceeded(req)) return json(res, 429, { error: 'too many attempts; retry later' });
      const { code, shop_name, register_name } = JSON.parse(await readBody(req) || '{}');
      const cleanCode = String(code || '').trim().replace(/\s+/g, '');
      const entry = activePairingCodes.get(cleanCode);
      if (!entry || Date.now() > entry.expiresAt) {
        return json(res, 400, { error: 'Invalid or expired pairing code' });
      }

      const shopId = validShopId(shop_name) ? shop_name : `shop-${crypto.randomBytes(4).toString('hex')}`;
      // A pairing code mints a NEW shop. When the name names an existing
      // shop_id the mint would silently rotate that shop's credential from an
      // unauthenticated route: the real register's pushes start answering 401
      // and its outbox prunes the backlog after 30 days. Rotation stays a
      // server-side operation.
      if (SHOP_CREDENTIALS[shopId]) {
        return json(res, 409, { error: `Shop '${shopId}' is already paired. Rotate its credential on the server, or pair under a different name.` });
      }
      const syncToken = crypto.randomBytes(32).toString('hex');
      const displayName = String(register_name || shop_name || shopId).slice(0, 100);
      const targetStoreId = entry.storeId || 'default';

      // Mint order matters. The shops row goes first (a DB failure answers 400
      // through the catch-all with the code still live, so the operator can
      // retry), then the credential is persisted, and only then is the code
      // spent. The old order deleted the code first and swallowed a failed
      // credentials write, so a broken mint burned the code and returned a token
      // that died with the process.
      const now = new Date().toISOString();
      db.prepare(`INSERT INTO shops (shop_id, store_id, shop_name, first_seen, last_seen) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(shop_id) DO UPDATE SET last_seen = excluded.last_seen, store_id = COALESCE(shops.store_id, excluded.store_id), shop_name = COALESCE(excluded.shop_name, shops.shop_name)`).run(shopId, targetStoreId, displayName, now, now);

      const previous = SHOP_CREDENTIALS[shopId];
      SHOP_CREDENTIALS[shopId] = syncToken;
      try {
        fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify(SHOP_CREDENTIALS, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
      } catch (err) {
        if (previous === undefined) delete SHOP_CREDENTIALS[shopId];
        else SHOP_CREDENTIALS[shopId] = previous;
        console.error(`[credentials] Failed to save ${CREDENTIALS_PATH}:`, err.message);
        return json(res, 500, { error: 'the pairing could not be saved; try again' });
      }

      activePairingCodes.delete(cleanCode);
      broadcast('paired', { shop_id: shopId, shop_name: displayName, store_id: targetStoreId }, targetStoreId);
      return json(res, 200, { ok: true, shop_id: shopId, sync_token: syncToken });
    }

    if (p === '/api/login' && req.method === 'POST') {
      if (loginBudgetExceeded(req)) return json(res, 429, { error: 'too many attempts; retry later' });
      const key = clientKey(req);
      const attempt = pinAttempts.get(key) || { failures: 0, lockedUntil: 0 };
      if (Date.now() < attempt.lockedUntil) return json(res, 429, { error: 'Too many attempts: locked' });
      const body = JSON.parse(await readBody(req) || '{}');
      const cleanPin = String(body.pin || '').trim();
      const cleanStoreName = String(body.store_name || '').trim();

      const currentPin = getManagerPin();
      // No PIN yet means no operator has claimed this server and no stores exist.
      if (!currentPin && !cleanStoreName) {
        return json(res, 403, { error: 'No manager PIN is set on this server yet. Set one from the server first: node cloud/server.js --rotate-pin' });
      }

      let matchedStore = null;
      if (cleanStoreName) {
        const store = db.prepare('SELECT store_id, store_name, pin_hash FROM stores WHERE LOWER(store_name) = LOWER(?) OR store_id = ?').get(cleanStoreName, cleanStoreName);
        if (store && verifyPinHash(store.pin_hash, cleanPin)) {
          matchedStore = store;
        }
      }
      if (!matchedStore) {
        if (currentPin && timingSafeEq(cleanPin, currentPin)) {
          const defStore = db.prepare('SELECT store_id, store_name, pin_hash FROM stores WHERE store_id = ?').get('default');
          matchedStore = defStore || { store_id: 'default', store_name: 'Main Store' };
        } else {
          // Each row here costs 100k PBKDF2 rounds, so the guess-once-try-all
          // fallback is capped: past a handful of tenants a nameless login
          // must name its store.
          const allStores = db.prepare('SELECT store_id, store_name, pin_hash FROM stores LIMIT 8').all();
          const matching = allStores.filter(s => s.pin_hash && verifyPinHash(s.pin_hash, cleanPin));
          if (matching.length === 1) {
            matchedStore = matching[0];
          }
        }
      }

      if (!matchedStore) {
        attempt.failures++;
        if (attempt.failures >= MAX_PIN_ATTEMPTS) {
          attempt.lockedUntil = Date.now() + PIN_LOCKOUT_MS;
          attempt.failures = 0;
        }
        attempt.at = Date.now();
        pinAttempts.set(key, attempt);
        return json(res, 401, { error: cleanStoreName ? 'Store not found or wrong PIN' : 'wrong PIN' });
      }

      pinAttempts.delete(key);
      const token = crypto.randomUUID();
      managerSessions.set(token, { storeId: matchedStore.store_id, storeName: matchedStore.store_name, issuedAt: Date.now() });
      const secure = TRUST_TLS_PROXY ? '; Secure' : '';
      res.setHeader('Set-Cookie', `manager_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL_MS / 1000}${secure}`);
      return json(res, 200, { ok: true });
    }
    if (p === '/api/logout' && req.method === 'POST') {
      const cookies = Object.fromEntries(String(req.headers.cookie || '').split(';').map(v => v.trim().split('=').map(decodeURIComponent)).filter(v => v.length === 2));
      if (cookies.manager_session) managerSessions.delete(cookies.manager_session);
      res.setHeader('Set-Cookie', `manager_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${TRUST_TLS_PROXY ? '; Secure' : ''}`);
      return json(res, 200, { ok: true });
    }

    // --- manager data & authenticated actions ---
    if (p.startsWith('/api/') && !['/api/login', '/api/auth-state', '/api/setup-pin', '/api/pair', '/api/create-store'].includes(p)) {
      const session = authorizedManager(req);
      if (!session) return json(res, 401, { error: 'login required' });

      if (p === '/api/pairing-code/generate' && req.method === 'POST') {
        const code = String(crypto.randomInt(100000, 1000000));
        activePairingCodes.set(code, {
          storeId: session.storeId,
          storeName: session.storeName,
          expiresAt: Date.now() + 600000,
          createdAt: Date.now()
        });
        return json(res, 200, { ok: true, code, expires_in_seconds: 600 });
      }

      if (p === '/api/deploy' && req.method === 'POST') {
        // A manager session here is arbitrary persistent code execution, so it
        // gets the login-class budget, a durable audit line and a rollback copy
        // of every file it replaces.
        if (loginBudgetExceeded(req)) return json(res, 429, { error: 'too many attempts; retry later' });
        if (session.storeId !== 'default') {
          return json(res, 403, { error: 'only primary store owner can deploy updates' });
        }
        const { files } = JSON.parse(await readBody(req) || '{}');
        if (!files || typeof files !== 'object' || Array.isArray(files)) {
          return json(res, 400, { error: 'files object required' });
        }
        const deployRoot = process.env.DEPLOY_DIR || __dirname;
        const allowedTargets = new Map([
          ['public/index.html', path.join(deployRoot, 'public', 'index.html')],
          ['public/app.js', path.join(deployRoot, 'public', 'app.js')],
          ['server.js', path.join(deployRoot, 'server.js')]
        ]);
        const vm = require('node:vm');
        for (const [rel, content] of Object.entries(files)) {
          if (!allowedTargets.has(rel) || typeof content !== 'string' || content.length < 32) {
            return json(res, 400, { error: `invalid deploy file: ${rel}` });
          }
          if (rel.endsWith('.js')) {
            try {
              new vm.Script(content, { filename: rel });
            } catch (err) {
              return json(res, 400, { error: `syntax error in ${rel}: ${err.message}` });
            }
          }
        }
        const updated = [];
        let serverChanged = false;
        const auditEntries = [];
        for (const [rel, content] of Object.entries(files)) {
          const dest = allowedTargets.get(rel);
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          const current = fs.existsSync(dest) ? fs.readFileSync(dest, 'utf8') : '';
          if (current === content) continue;
          const sha = s => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
          // One-generation rollback copy: a bad push must not be a dead end.
          if (current) {
            try { fs.copyFileSync(dest, `${dest}.prev`); } catch (_) {}
          }
          const tmp = `${dest}.tmp-${process.pid}-${Date.now()}`;
          fs.writeFileSync(tmp, content, 'utf8');
          fs.renameSync(tmp, dest);
          updated.push(rel);
          auditEntries.push({ file: rel, from: sha(current), to: sha(content), bytes: content.length });
          if (rel === 'server.js') serverChanged = true;
        }
        // Durable trail: who deployed what, when, and which bytes changed.
        if (auditEntries.length) {
          try {
            const line = JSON.stringify({ at: new Date().toISOString(), store: session.storeId, name: session.storeName, files: auditEntries }) + '\n';
            fs.appendFileSync(path.join(DATA_DIR, 'deploy-log.jsonl'), line);
          } catch (_) {}
        }
        if (updated.length) broadcast('change', { deployed: updated });
        const restarting = Boolean(serverChanged && isBotkeep);
        json(res, 200, { ok: true, updated, restarting });
        if (restarting) setTimeout(() => process.exit(0), 250).unref();
        return;
      }

      if (p === '/api/overview') {
        const shops = db.prepare(`SELECT shop_id, COALESCE(shop_name, shop_id) AS shop_name, first_seen, last_seen FROM shops WHERE store_id = ? OR (? = 'default' AND (store_id IS NULL OR store_id = '')) ORDER BY last_seen DESC`).all(session.storeId, session.storeId);
        const rows = {};
        for (const s of shops) {
          rows[s.shop_id] = db.prepare('SELECT table_name, COUNT(*) n FROM shop_rows WHERE shop_id = ? GROUP BY table_name').all(s.shop_id);
        }
        const pendingCmdRows = db.prepare(`
          SELECT c.id, c.shop_id, c.kind, c.payload_json, c.created_at
          FROM cloud_commands c
          JOIN shops s ON s.shop_id = c.shop_id
          WHERE c.acked_at IS NULL
            AND (s.store_id = ? OR (? = 'default' AND (s.store_id IS NULL OR s.store_id = '')))
          ORDER BY c.id ASC LIMIT 100
        `).all(session.storeId, session.storeId);
        const pendingCommandItems = pendingCmdRows.map(c => {
          let payload = {};
          try { payload = JSON.parse(c.payload_json); } catch (_) {}
          return {
            id: c.id,
            shop_id: c.shop_id,
            kind: c.kind,
            inventory_id: payload.id || null,
            delta: payload.delta || null,
            row_count: Array.isArray(payload.rows) ? payload.rows.length : null,
            created_at: c.created_at,
          };
        });
        // The mirror is the only copy of history older than the shop's 30-day
        // outbox prune, so the backup age belongs on the same screen.
        let backup = { last_at: null, age_hours: null, stale: true };
        try {
          let newest = 0;
          for (const f of fs.readdirSync(BACKUP_DIR)) {
            if (!/^cloud-\d{4}-\d{2}-\d{2}\.db$/.test(f)) continue;
            const m = fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs;
            if (m > newest) newest = m;
          }
          if (newest) {
            backup = {
              last_at: new Date(newest).toISOString(),
              age_hours: Math.floor((Date.now() - newest) / 3600000),
              stale: (Date.now() - newest) > 26 * 3600000
            };
          }
        } catch (_) {}
        return json(res, 200, {
          store_id: session.storeId,
          store_name: session.storeName,
          shops,
          rowCounts: rows,
          pending_commands: pendingCmdRows.length,
          pending_command_items: pendingCommandItems,
          backup
        });
      }

      if (p.startsWith('/api/shops/') && req.method === 'DELETE') {
        const targetShopId = decodeURIComponent(p.slice('/api/shops/'.length)).trim();
        if (!validShopId(targetShopId)) return json(res, 400, { error: 'invalid shop_id' });

        const targetShop = db.prepare('SELECT shop_id, store_id FROM shops WHERE shop_id = ?').get(targetShopId);
        if (!targetShop || targetShop.store_id !== session.storeId) {
          return json(res, 404, { error: 'shop not found' });
        }

        // The credential dies before the mirror rows: an unlink whose file
        // write fails used to resurrect a live credential on the next restart
        // while the rows were already gone. Writing the file first means a
        // failure leaves both halves intact for a clean retry.
        if (SHOP_CREDENTIALS[targetShopId]) {
          const remaining = { ...SHOP_CREDENTIALS };
          delete remaining[targetShopId];
          try {
            fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify(remaining, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
          } catch (err) {
            console.error(`[credentials] Failed to update ${CREDENTIALS_PATH} on shop delete:`, err.message);
            return json(res, 500, { error: 'the credential could not be removed; the shop is NOT unlinked, try again' });
          }
          delete SHOP_CREDENTIALS[targetShopId];
        }

        db.exec('BEGIN');
        try {
          db.prepare('DELETE FROM cloud_commands WHERE shop_id = ?').run(targetShopId);
          db.prepare('DELETE FROM shop_rows WHERE shop_id = ?').run(targetShopId);
          db.prepare('DELETE FROM shops WHERE shop_id = ?').run(targetShopId);
          db.exec('COMMIT');
        } catch (err) {
          db.exec('ROLLBACK');
          return json(res, 500, { error: 'failed to delete shop rows' });
        }
        broadcast('change', { deleted_shop: targetShopId }, session.storeId);
        return json(res, 200, { ok: true, deleted: targetShopId });
      }

      if (p === '/api/standing') {
        const shop = url.searchParams.get('shop');
        const filter = getStoreShopFilter(session.storeId, shop, 'r');
        const debt = db.prepare(`
          SELECT COALESCE(SUM(CAST(json_extract(r.row_json,'$.credit_balance') AS REAL)), 0) AS outstanding,
                 COUNT(DISTINCT CASE WHEN CAST(json_extract(r.row_json,'$.credit_balance') AS REAL) > 0.001
                   THEN ${NAMEFOLD}(json_extract(r.row_json,'$.customer_name')) END) AS debtors
          FROM shop_rows r
          WHERE r.table_name = 'sales'${filter.clause}
            AND COALESCE(CAST(json_extract(r.row_json,'$.voided') AS INTEGER), 0) = 0
        `).get(...filter.params);
        // The live debtor list is computed here, over the whole mirror: the
        // Utang tab used to build it from the newest-500 /api/rows window, so an
        // utang older than a few days of newer sales vanished from the list while
        // the card above still counted it. Grouping folds names (NFC+lowercase)
        // so 'Jose' and 'jose' stay one debtor, matching the count above.
        const debtors = db.prepare(`
          SELECT MAX(json_extract(r.row_json,'$.customer_name')) AS name,
                 SUM(CAST(json_extract(r.row_json,'$.credit_balance') AS REAL)) AS balance,
                 MAX(json_extract(r.row_json,'$.created_at')) AS last_at,
                 MAX(json_extract(r.row_json,'$.customer_phone')) AS phone
          FROM shop_rows r
          WHERE r.table_name = 'sales'${filter.clause}
            AND COALESCE(CAST(json_extract(r.row_json,'$.voided') AS INTEGER), 0) = 0
          GROUP BY ${NAMEFOLD}(json_extract(r.row_json,'$.customer_name'))
          HAVING SUM(CAST(json_extract(r.row_json,'$.credit_balance') AS REAL)) > 0.001
          ORDER BY balance DESC
          LIMIT 300
        `).all(...filter.params);
        // Utang aging: FIFO settlement pays the oldest sale first, so each
        // unpaid sale's own age is the age of that debt. Bucketed on the
        // shop's clock, same as the analytics day windows.
        const agingRows = db.prepare(`
          SELECT CASE WHEN age <= 7 THEN 0 WHEN age <= 30 THEN 1 WHEN age <= 60 THEN 2 ELSE 3 END AS bucket,
                 COALESCE(SUM(balance), 0) AS amount, COUNT(*) AS count
          FROM (
            SELECT CAST(json_extract(r.row_json,'$.credit_balance') AS REAL) AS balance,
                   julianday(date('now',${TZ_MODIFIER})) - julianday(date(json_extract(r.row_json,'$.created_at'),${TZ_MODIFIER})) AS age
            FROM shop_rows r
            WHERE r.table_name = 'sales'${filter.clause}
              AND COALESCE(CAST(json_extract(r.row_json,'$.voided') AS INTEGER), 0) = 0
              AND CAST(json_extract(r.row_json,'$.credit_balance') AS REAL) > 0.001
          )
          GROUP BY bucket ORDER BY bucket
        `).all(...filter.params);
        const aging = ['0–7 days', '8–30 days', '31–60 days', '60+ days'].map((label, i) => {
          const row = agingRows.find(a => a.bucket === i);
          return { label, amount: Math.round((Number(row && row.amount) || 0) * 100) / 100, count: row ? row.count : 0 };
        });
        const inventory = db.prepare(`
          SELECT COALESCE(SUM(CAST(json_extract(r.row_json,'$.price_retail') AS REAL)
            * CAST(json_extract(r.row_json,'$.stock_quantity') AS REAL)), 0) AS retail_value,
                 COALESCE(SUM(CAST(json_extract(r.row_json,'$.cost_price') AS REAL)
            * CAST(json_extract(r.row_json,'$.stock_quantity') AS REAL)), 0) AS cost_value
          FROM shop_rows r
          WHERE r.table_name = 'inventory'${filter.clause}
            AND COALESCE(CAST(json_extract(r.row_json,'$.archived') AS INTEGER), 0) = 0
        `).get(...filter.params);
        // Mirror-wide counts: the low-stock card used to filter the newest-500
        // /api/rows window client-side, which dropped older breaches once the
        // catalog outgrew the window (same failure the debtor list fixed).
        // /api/reorder serves the same population with buy quantities.
        const invCounts = db.prepare(`
          SELECT COUNT(*) AS types,
                 COALESCE(SUM(CAST(json_extract(r.row_json,'$.stock_quantity') AS REAL)), 0) AS parts_stock,
                 COALESCE(SUM(CASE WHEN COALESCE(CAST(json_extract(r.row_json,'$.archived') AS INTEGER), 0) = 0
                   AND CAST(json_extract(r.row_json,'$.stock_quantity') AS REAL)
                     <= CAST(json_extract(r.row_json,'$.min_stock_alert') AS REAL)
                   THEN 1 ELSE 0 END), 0) AS low_stock
          FROM shop_rows r
          WHERE r.table_name = 'inventory'${filter.clause}
        `).get(...filter.params);
        return json(res, 200, {
          outstanding_credit: Math.round(debt.outstanding * 100) / 100,
          debtors: debt.debtors,
          debtor_list: debtors.map(d => ({
            name: d.name,
            balance: Math.round((Number(d.balance) || 0) * 100) / 100,
            last_at: d.last_at || '',
            phone: d.phone || ''
          })),
          aging,
          inventory_retail_value: Math.round(inventory.retail_value * 100) / 100,
          inventory_cost_value: Math.round(inventory.cost_value * 100) / 100,
          inventory_types: invCounts.types,
          total_parts_stock: invCounts.parts_stock,
          low_stock_count: invCounts.low_stock
        });
      }
      if (p === '/api/rows') {
        const table = url.searchParams.get('table');
        const shop = url.searchParams.get('shop');
        if (!MANAGER_ROW_TABLES.has(table)) return json(res, 400, { error: 'bad table' });
        const limit = url.searchParams.has('limit')
          ? Math.max(1, Math.min(5000, Math.trunc(Number(url.searchParams.get('limit')) || 500)))
          : 500;
        const filter = getStoreShopFilter(session.storeId, shop, 'r');
        const stmt = db.prepare(`SELECT r.shop_id, r.row_json, r.updated_at FROM shop_rows r WHERE r.table_name = ?${filter.clause} ORDER BY r.updated_at DESC LIMIT ?`);
        const out = stmt.all(table, ...filter.params, limit)
          .map(r => ({ ...JSON.parse(r.row_json), ...(shop ? {} : { shop_id: r.shop_id }), updated_at: r.updated_at }));
        return json(res, 200, out);
      }

      // One sale plus its line items for the feed's tap-to-expand. /api/rows
      // caps at the newest 500, so an older sale's items are not reachable
      // from that window; this reads the full mirror instead.
      if (p === '/api/sale' && req.method === 'GET') {
        const shop = url.searchParams.get('shop');
        const filter = getStoreShopFilter(session.storeId, shop, 'r');
        const id = Number(url.searchParams.get('id'));
        if (!positiveId(id)) return json(res, 400, { error: 'bad sale id' });
        const sale = db.prepare(`SELECT r.row_json FROM shop_rows r WHERE r.table_name = 'sales' AND r.local_id = ?${filter.clause}`)
          .get(id, ...filter.params);
        if (!sale) return json(res, 404, { error: 'sale not found in this mirror' });
        const items = db.prepare(`SELECT r.row_json FROM shop_rows r WHERE r.table_name = 'sale_items' AND CAST(json_extract(r.row_json,'$.sale_id') AS INTEGER) = ?${filter.clause}`)
          .all(id, ...filter.params).map(r => JSON.parse(r.row_json));
        return json(res, 200, { sale: JSON.parse(sale.row_json), items });
      }

      // --- period analytics over the mirror -----------------------------
      // Same trailing-localtime-day windows and metric formulas as the shop's
      // src/analytics.js, computed with json_extract over the stored snapshots.
      // ponytail: no index can serve json_extract, so each query scans the
      // mirrored table once (fine at shop scale, tens of thousands of rows);
      // materialize typed tables if a multi-shop install ever makes it stutter.
      if (p === '/api/analytics') {
        // Window shapes follow src/analytics.js periodWindows: trailing
        // localtime-day windows ending on the shop's today, plus a custom
        // from/to range whose previous window is the equal-length stretch
        // before it (so delta chips keep their baseline). from/to are
        // strict-regex validated before they are inlined.
        const validDate = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(`${v}T00:00:00Z`));
        const addDays = (dateStr, k) => new Date(Date.parse(`${dateStr}T00:00:00Z`) + k * 86400000).toISOString().slice(0, 10);
        const period = ['day', '7d', '30d'].includes(url.searchParams.get('period')) ? url.searchParams.get('period') : 'day';
        const fromParam = url.searchParams.get('from');
        const toParam = url.searchParams.get('to');
        const today = db.prepare(`SELECT date('now',${TZ_MODIFIER}) AS d`).get().d;
        let from, to, days;
        if (fromParam !== null || toParam !== null) {
          if (!validDate(fromParam)) return json(res, 400, { error: 'custom range needs from=YYYY-MM-DD' });
          if (toParam !== null && !validDate(toParam)) return json(res, 400, { error: 'to must be a YYYY-MM-DD date' });
          from = fromParam;
          to = toParam || today;
          if (from > to) return json(res, 400, { error: 'custom start must be on or before the end date' });
          days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1;
          if (days > 365) return json(res, 400, { error: 'custom range is limited to 365 days' });
        } else {
          days = { day: 1, '7d': 7, '30d': 30 }[period];
          to = today;
          from = addDays(today, -(days - 1));
        }
        const prevFrom = addDays(from, -days);
        const prevTo = addDays(from, -1);
        const shop = url.searchParams.get('shop');
        const filterR = getStoreShopFilter(session.storeId, shop, 'r');
        const filterI = getStoreShopFilter(session.storeId, shop, 'i');
        const r2 = v => {
          // Same half-away-from-zero tie rule as src/money.js (Math.round ties
          // toward +Infinity, a centavo off on negative half-centavos); keep the
          // non-finite-to-0 coercion analytics aggregates need.
          const value = Number(v) || 0;
          const [coefficient, exponent = '0'] = String(Math.abs(value)).split('e');
          const cents = Math.round(Number(`${coefficient}e${Number(exponent) + 2}`));
          return Math.sign(value) * cents / 100;
        };
        const num = (r, k) => `CAST(json_extract(${r}.row_json,'$.${k}') AS REAL)`;
        const inWindow = (col, wFrom, wTo) =>
          `date(json_extract(${col}.row_json,'$.created_at'),${TZ_MODIFIER}) >= '${wFrom}' AND date(json_extract(${col}.row_json,'$.created_at'),${TZ_MODIFIER}) <= '${wTo}'`;

        // Same formulas as getDashboardStats/windowKpis, parameterized by
        // window: one row per sale for sales sums, separate passes for the
        // line-item split and ledger movements.
        const windowKpis = (wFrom, wTo) => {
          const sales = db.prepare(`
            SELECT COUNT(*) AS sale_count,
                   COALESCE(SUM(${num('r','total_amount')}), 0) AS revenue,
                   COALESCE(SUM(${num('r','amount_paid')} - ${num('r','change_amount')}), 0) AS paid_at_counter,
                   COALESCE(SUM(${num('r','credit_balance')}), 0) AS credit_issued,
                   COALESCE(SUM(CASE WHEN json_extract(r.row_json,'$.payment_method') = 'cash'
                     THEN ${num('r','amount_paid')} - ${num('r','change_amount')} ELSE 0 END), 0) AS cash_collected,
                   COALESCE(SUM(CASE WHEN json_extract(r.row_json,'$.payment_method') = 'gcash'
                     THEN ${num('r','amount_paid')} - ${num('r','change_amount')} ELSE 0 END), 0) AS gcash_collected,
                   COALESCE(SUM(CASE WHEN json_extract(r.row_json,'$.payment_method') = 'transfer'
                     THEN ${num('r','amount_paid')} - ${num('r','change_amount')} ELSE 0 END), 0) AS transfer_collected,
                   COALESCE(SUM(CASE WHEN json_extract(r.row_json,'$.payment_method') = 'credit'
                     THEN ${num('r','amount_paid')} ELSE 0 END), 0) AS credit_downpayments
            FROM shop_rows r
            WHERE r.table_name = 'sales'${filterR.clause}
              AND COALESCE(CAST(json_extract(r.row_json,'$.voided') AS INTEGER), 0) = 0
              AND ${inWindow('r', wFrom, wTo)}
          `).get(...filterR.params);

          const settlements = db.prepare(`
            SELECT COALESCE(SUM(${num('r','amount_paid')}), 0) AS total,
                   COALESCE(SUM(CASE WHEN json_extract(r.row_json,'$.payment_method') = 'cash' THEN ${num('r','amount_paid')} ELSE 0 END), 0) AS cash,
                   COALESCE(SUM(CASE WHEN json_extract(r.row_json,'$.payment_method') = 'gcash' THEN ${num('r','amount_paid')} ELSE 0 END), 0) AS gcash,
                   COALESCE(SUM(CASE WHEN json_extract(r.row_json,'$.payment_method') = 'transfer' THEN ${num('r','amount_paid')} ELSE 0 END), 0) AS transfer
            FROM shop_rows r
            WHERE r.table_name = 'credit_payments'${filterR.clause}
              AND ${inWindow('r', wFrom, wTo)}
          `).get(...filterR.params);

          // The replacement cost only leaves the P&L while its sale stands:
          // voiding the sale restores the part, matching windowKpis.
          const refunds = db.prepare(`
            SELECT COUNT(*) AS count,
                   COALESCE(SUM(${num('r','refund_amount')}), 0) AS total,
                   COALESCE(SUM(CASE WHEN json_extract(r.row_json,'$.return_type') = 'cash_refund' THEN ${num('r','refund_amount')} ELSE 0 END), 0) AS cash,
                   COALESCE(SUM(CASE WHEN json_extract(r.row_json,'$.return_type') = 'credit_refund' THEN ${num('r','refund_amount')} ELSE 0 END), 0) AS credit,
                   COALESCE(SUM(CASE WHEN json_extract(r.row_json,'$.return_type') = 'replacement' THEN 1 ELSE 0 END), 0) AS replacements,
                   COALESCE(SUM(CASE WHEN json_extract(r.row_json,'$.return_type') = 'replacement'
                     AND COALESCE(CAST(json_extract(sv.row_json,'$.voided') AS INTEGER), 0) = 0
                     THEN CAST(json_extract(r.row_json,'$.quantity') AS REAL) * COALESCE(CAST(json_extract(inv.row_json,'$.cost_price') AS REAL), 0.0)
                     ELSE 0.0 END), 0.0) AS replacement_cost
            FROM shop_rows r
            LEFT JOIN shop_rows inv ON inv.table_name = 'inventory' AND inv.shop_id = r.shop_id
              AND inv.local_id = CAST(json_extract(r.row_json,'$.replacement_inventory_id') AS INTEGER)
            LEFT JOIN shop_rows sv ON sv.table_name = 'sales' AND sv.shop_id = r.shop_id
              AND sv.local_id = CAST(json_extract(r.row_json,'$.sale_id') AS INTEGER)
            WHERE r.table_name = 'warranty_returns'${filterR.clause}
              AND ${inWindow('r', wFrom, wTo)}
          `).get(...filterR.params);

          const items = db.prepare(`
            SELECT
              COALESCE(SUM(CASE WHEN json_extract(i.row_json,'$.item_type') = 'part'
                THEN CAST(json_extract(i.row_json,'$.quantity') AS REAL) * ${num('i','unit_cost')} ELSE 0 END), 0) AS cost,
              COALESCE(SUM(CASE WHEN json_extract(i.row_json,'$.item_type') = 'part'
                THEN ${num('i','total_price')} ELSE 0 END), 0) AS parts_revenue,
              COALESCE(SUM(CASE WHEN json_extract(i.row_json,'$.item_type') = 'labor'
                THEN ${num('i','total_price')} ELSE 0 END), 0) AS labor_revenue
            FROM shop_rows i
            JOIN shop_rows s ON s.table_name = 'sales' AND s.shop_id = i.shop_id
              AND s.local_id = CAST(json_extract(i.row_json,'$.sale_id') AS INTEGER)
            WHERE i.table_name = 'sale_items'${filterI.clause}
              AND COALESCE(CAST(json_extract(s.row_json,'$.voided') AS INTEGER), 0) = 0
              AND ${inWindow('s', wFrom, wTo)}
          `).get(...filterI.params);

          const movements = db.prepare(`
            SELECT COALESCE(SUM(CAST(json_extract(r.row_json,'$.delta') AS REAL)), 0) AS units_received
            FROM shop_rows r
            WHERE r.table_name = 'stock_movements'${filterR.clause}
              AND json_extract(r.row_json,'$.reason') = 'receive'
              AND ${inWindow('r', wFrom, wTo)}
          `).get(...filterR.params);

          const adjustments = db.prepare(`
            SELECT COALESCE(SUM(${num('r','amount')}), 0) AS total
            FROM shop_rows r
            WHERE r.table_name = 'cash_adjustments'${filterR.clause}
              AND ${inWindow('r', wFrom, wTo)}
              AND NOT EXISTS (
                SELECT 1 FROM shop_rows s
                WHERE s.shop_id = r.shop_id AND s.table_name = 'sales'
                  AND json_extract(r.row_json,'$.source_kind') = 'sale_void'
                  AND s.local_id = CAST(json_extract(r.row_json,'$.source_id') AS INTEGER)
                  AND ${inWindow('s', wFrom, wTo)}
              )
          `).get(...filterR.params);

          const expenses = db.prepare(`
            SELECT COALESCE(SUM(${num('r','amount')}), 0) AS total
            FROM shop_rows r
            WHERE r.table_name = 'expenses'${filterR.clause}
              AND ${inWindow('r', wFrom, wTo)}
          `).get(...filterR.params);

          const grossProfit = sales.revenue - items.cost;
          const netProfit = grossProfit - refunds.total - refunds.replacement_cost - expenses.total;
          const netRevenue = sales.revenue - refunds.total;
          const cashCollected = sales.cash_collected + sales.credit_downpayments + settlements.cash + adjustments.total - refunds.cash;
          const gcashCollected = sales.gcash_collected + settlements.gcash;
          const transferCollected = sales.transfer_collected + settlements.transfer;
          const collectedTotal = sales.paid_at_counter + settlements.total + adjustments.total - refunds.cash;
          return {
            sale_count: sales.sale_count,
            revenue: r2(sales.revenue),
            avg_ticket: r2(sales.sale_count ? sales.revenue / sales.sale_count : 0),
            gross_profit: r2(grossProfit),
            net_profit: r2(netProfit),
            expenses_total: r2(expenses.total),
            net_revenue: r2(netRevenue),
            parts_revenue: r2(items.parts_revenue),
            labor_revenue: r2(items.labor_revenue),
            cash_collected: r2(cashCollected),
            gcash_collected: r2(gcashCollected),
            transfer_collected: r2(transferCollected),
            collected_total: r2(collectedTotal),
            credit_downpayments: r2(sales.credit_downpayments),
            credit_issued: r2(sales.credit_issued),
            credit_settled: r2(settlements.total),
            warranty_returns: refunds.count,
            return_replacements: refunds.replacements,
            refunded_total: r2(refunds.total),
            return_cash: r2(refunds.cash),
            return_credit: r2(refunds.credit),
            replacement_cost: r2(refunds.replacement_cost),
            units_received: movements.units_received
          };
        };

        const current = windowKpis(from, to);
        const previous = windowKpis(prevFrom, prevTo);
        // prev === 0 means "no prior window": a 0 to X jump has no honest
        // percentage (same rule as the workstation's delta chips).
        const deltas = {};
        for (const k of Object.keys(current)) {
          deltas[k] = typeof current[k] === 'number' && previous[k] !== 0
            ? Math.round(((current[k] - previous[k]) / Math.abs(previous[k])) * 1000) / 10
            : null;
        }

        const trendSales = db.prepare(`
          SELECT date(json_extract(r.row_json,'$.created_at'),${TZ_MODIFIER}) AS bucket,
                 COUNT(*) AS count,
                 COALESCE(SUM(${num('r','total_amount')}), 0) AS revenue
          FROM shop_rows r
          WHERE r.table_name = 'sales'${filterR.clause}
            AND COALESCE(CAST(json_extract(r.row_json,'$.voided') AS INTEGER), 0) = 0
            AND ${inWindow('r', from, to)}
          GROUP BY bucket ORDER BY bucket
        `).all(...filterR.params);
        const costs = new Map(db.prepare(`
          SELECT date(json_extract(s.row_json,'$.created_at'),${TZ_MODIFIER}) AS bucket,
                 COALESCE(SUM(CAST(json_extract(i.row_json,'$.quantity') AS REAL) * ${num('i','unit_cost')}), 0) AS cost
          FROM shop_rows i
          JOIN shop_rows s ON s.table_name = 'sales' AND s.shop_id = i.shop_id
            AND s.local_id = CAST(json_extract(i.row_json,'$.sale_id') AS INTEGER)
          WHERE i.table_name = 'sale_items' AND json_extract(i.row_json,'$.item_type') = 'part'${filterI.clause}
            AND COALESCE(CAST(json_extract(s.row_json,'$.voided') AS INTEGER), 0) = 0
            AND ${inWindow('s', from, to)}
          GROUP BY bucket ORDER BY bucket
        `).all(...filterI.params).map(t => [t.bucket, t.cost]));
        const refundBuckets = new Map(db.prepare(`
          SELECT date(json_extract(r.row_json,'$.created_at'),${TZ_MODIFIER}) AS bucket,
                 COALESCE(SUM(${num('r','refund_amount')} + CASE WHEN json_extract(r.row_json,'$.return_type') = 'replacement'
                   AND COALESCE(CAST(json_extract(sv.row_json,'$.voided') AS INTEGER), 0) = 0
                   THEN CAST(json_extract(r.row_json,'$.quantity') AS REAL) * COALESCE(CAST(json_extract(inv.row_json,'$.cost_price') AS REAL), 0.0)
                   ELSE 0.0 END), 0) AS refunded
          FROM shop_rows r
          LEFT JOIN shop_rows inv ON inv.table_name = 'inventory' AND inv.shop_id = r.shop_id
            AND inv.local_id = CAST(json_extract(r.row_json,'$.replacement_inventory_id') AS INTEGER)
          LEFT JOIN shop_rows sv ON sv.table_name = 'sales' AND sv.shop_id = r.shop_id
            AND sv.local_id = CAST(json_extract(r.row_json,'$.sale_id') AS INTEGER)
          WHERE r.table_name = 'warranty_returns'${filterR.clause}
            AND ${inWindow('r', from, to)}
          GROUP BY bucket ORDER BY bucket
        `).all(...filterR.params).map(t => [t.bucket, t.refunded]));
        const expenseBuckets = new Map(db.prepare(`
          SELECT date(json_extract(r.row_json,'$.created_at'),${TZ_MODIFIER}) AS bucket,
                 COALESCE(SUM(${num('r','amount')}), 0) AS total
          FROM shop_rows r
          WHERE r.table_name = 'expenses'${filterR.clause}
            AND ${inWindow('r', from, to)}
          GROUP BY bucket ORDER BY bucket
        `).all(...filterR.params).map(t => [t.bucket, t.total]));
        const trendMap = new Map(trendSales.map(t => [t.bucket, t]));
        const trend = [...new Set([...trendMap.keys(), ...costs.keys(), ...refundBuckets.keys(), ...expenseBuckets.keys()])].sort().map(b => {
          const t = trendMap.get(b) || { count: 0, revenue: 0 };
          return {
            bucket: b,
            count: t.count,
            revenue: r2(t.revenue),
            profit: r2(t.revenue - (costs.get(b) || 0) - (refundBuckets.get(b) || 0) - (expenseBuckets.get(b) || 0))
          };
        });

        const tops = db.prepare(`
          SELECT i.shop_id,
                 MAX(CAST(json_extract(i.row_json,'$.item_name') AS TEXT)) AS item_name,
                 MAX(json_extract(inv_d.row_json,'$.brand')) AS brand,
                 MAX(json_extract(inv_d.row_json,'$.model_name')) AS model_name,
                 MAX(json_extract(inv_d.row_json,'$.part_type')) AS part_type,
                 -- Per-line parity with src/analytics.js getProductPerformance:
                 -- net units and net revenue clamp at zero per LINE, refunds are
                 -- all-time per sale_item (no window), zero subtotal allocates
                 -- zero, and profit subtracts the NET units' cost plus the
                 -- replacement part's cost.
                 SUM(MAX(0, CAST(json_extract(i.row_json,'$.quantity') AS REAL) - COALESCE((
                   SELECT SUM(CASE WHEN json_extract(wr.row_json,'$.return_type') != 'replacement'
                     THEN CAST(json_extract(wr.row_json,'$.quantity') AS REAL) ELSE 0 END)
                   FROM shop_rows wr
                   WHERE wr.table_name = 'warranty_returns' AND wr.shop_id = i.shop_id
                     AND CAST(json_extract(wr.row_json,'$.sale_item_id') AS INTEGER) = i.local_id
                 ), 0))) AS units,
                 SUM(MAX(0.0, (CASE WHEN COALESCE(${num('s','subtotal')}, 0) > 0
                   THEN ${num('i','total_price')} * (1.0 * ${num('s','total_amount')} / ${num('s','subtotal')})
                   ELSE 0.0 END) - COALESCE((
                   SELECT SUM(${num('wr','refund_amount')})
                   FROM shop_rows wr
                   WHERE wr.table_name = 'warranty_returns' AND wr.shop_id = i.shop_id
                     AND CAST(json_extract(wr.row_json,'$.sale_item_id') AS INTEGER) = i.local_id
                 ), 0.0))) AS revenue,
                 SUM(MAX(0.0, (CASE WHEN COALESCE(${num('s','subtotal')}, 0) > 0
                   THEN ${num('i','total_price')} * (1.0 * ${num('s','total_amount')} / ${num('s','subtotal')})
                   ELSE 0.0 END) - COALESCE((
                   SELECT SUM(${num('wr','refund_amount')})
                   FROM shop_rows wr
                   WHERE wr.table_name = 'warranty_returns' AND wr.shop_id = i.shop_id
                     AND CAST(json_extract(wr.row_json,'$.sale_item_id') AS INTEGER) = i.local_id
                 ), 0.0))
                   - (MAX(0, CAST(json_extract(i.row_json,'$.quantity') AS REAL) - COALESCE((
                   SELECT SUM(CASE WHEN json_extract(wr.row_json,'$.return_type') != 'replacement'
                     THEN CAST(json_extract(wr.row_json,'$.quantity') AS REAL) ELSE 0 END)
                   FROM shop_rows wr
                   WHERE wr.table_name = 'warranty_returns' AND wr.shop_id = i.shop_id
                     AND CAST(json_extract(wr.row_json,'$.sale_item_id') AS INTEGER) = i.local_id
                 ), 0)) * ${num('i','unit_cost')})
                   - COALESCE((
                     -- Per-line, inside the SUM: a subquery outside an aggregate
                     -- correlates with an arbitrary row of the group.
                     SELECT SUM(CAST(json_extract(wr.row_json,'$.quantity') AS REAL) * COALESCE(CAST(json_extract(inv.row_json,'$.cost_price') AS REAL), 0.0))
                     FROM shop_rows wr
                     LEFT JOIN shop_rows inv ON inv.table_name = 'inventory' AND inv.shop_id = wr.shop_id
                       AND inv.local_id = CAST(json_extract(wr.row_json,'$.replacement_inventory_id') AS INTEGER)
                     WHERE wr.table_name = 'warranty_returns' AND wr.shop_id = i.shop_id
                       AND CAST(json_extract(wr.row_json,'$.sale_item_id') AS INTEGER) = i.local_id
                       AND json_extract(wr.row_json,'$.return_type') = 'replacement'
                   ), 0.0)) AS profit
          FROM shop_rows i
          JOIN shop_rows s ON s.table_name = 'sales' AND s.shop_id = i.shop_id
            AND s.local_id = CAST(json_extract(i.row_json,'$.sale_id') AS INTEGER)
          LEFT JOIN shop_rows inv_d ON inv_d.table_name = 'inventory' AND inv_d.shop_id = i.shop_id
            AND inv_d.local_id = CAST(json_extract(i.row_json,'$.inventory_id') AS INTEGER)
          WHERE i.table_name = 'sale_items' AND json_extract(i.row_json,'$.inventory_id') IS NOT NULL${filterI.clause}
            AND COALESCE(CAST(json_extract(s.row_json,'$.voided') AS INTEGER), 0) = 0
            AND ${inWindow('s', from, to)}
          GROUP BY i.shop_id, json_extract(i.row_json,'$.inventory_id')
          ORDER BY revenue DESC
          LIMIT 10
        `).all(...filterI.params);

        return json(res, 200, {
          generated_at: new Date().toISOString(),
          period: fromParam !== null || toParam !== null ? 'custom' : period,
          days,
          range: { from, to },
          previous_range: { from: prevFrom, to: prevTo },
          current,
          previous,
          deltas,
          trend,
          top_products: tops.map(p => ({
            shop_id: p.shop_id,
            item_name: p.item_name,
            brand: p.brand || '',
            model_name: p.model_name || '',
            part_type: p.part_type || '',
            units: p.units,
            revenue: r2(p.revenue),
            profit: r2(p.profit),
            margin_pct: p.revenue > 0 ? Math.round((p.profit / p.revenue) * 1000) / 10 : null
          }))
        });
      }

      // --- reorder & dead stock over the whole mirror ----------------------
      // The workstation's getReorderList/getDeadStock recomputed here so the
      // manager phone sees them without walking to the register. The old
      // client-side low-stock filter ran on the newest-500 /api/rows window
      // and dropped older breaches once the catalog outgrew the window.
      if (p === '/api/reorder') {
        const period = url.searchParams.get('period');
        const daysParam = Number(url.searchParams.get('days'));
        const days = Number.isFinite(daysParam) && daysParam > 0
          ? Math.max(1, Math.min(90, Math.trunc(daysParam)))
          : (['day', '7d', '30d'].includes(period) ? { day: 1, '7d': 7, '30d': 30 }[period] : 30);
        const since = `date('now',${TZ_MODIFIER},'-${days - 1} days')`;
        const shop = url.searchParams.get('shop');
        const filter = getStoreShopFilter(session.storeId, shop, 'i');
        const rows = db.prepare(`
          SELECT i.shop_id,
                 CAST(json_extract(i.row_json,'$.id') AS INTEGER) AS id,
                 json_extract(i.row_json,'$.brand') AS brand,
                 json_extract(i.row_json,'$.model_name') AS model_name,
                 json_extract(i.row_json,'$.part_type') AS part_type,
                 json_extract(i.row_json,'$.sku_barcode') AS sku_barcode,
                 CAST(json_extract(i.row_json,'$.stock_quantity') AS REAL) AS stock_quantity,
                 CAST(json_extract(i.row_json,'$.min_stock_alert') AS REAL) AS min_stock_alert,
                 CAST(json_extract(i.row_json,'$.cost_price') AS REAL) AS cost_price,
                 CAST(json_extract(i.row_json,'$.price_retail') AS REAL) AS price_retail,
                 CAST(json_extract(i.row_json,'$.price_technician') AS REAL) AS price_technician,
                 json_extract(i.row_json,'$.supplier') AS supplier,
                 json_extract(i.row_json,'$.location') AS location,
                 COALESCE(v.units, 0) AS units_sold
          FROM shop_rows i
          LEFT JOIN (
            SELECT si.shop_id, CAST(json_extract(si.row_json,'$.inventory_id') AS INTEGER) AS inv_id,
                   SUM(CAST(json_extract(si.row_json,'$.quantity') AS REAL)) AS units
            FROM shop_rows si
            JOIN shop_rows s ON s.table_name = 'sales' AND s.shop_id = si.shop_id
              AND s.local_id = CAST(json_extract(si.row_json,'$.sale_id') AS INTEGER)
            WHERE si.table_name = 'sale_items' AND json_extract(si.row_json,'$.inventory_id') IS NOT NULL
              AND COALESCE(CAST(json_extract(s.row_json,'$.voided') AS INTEGER), 0) = 0
              AND date(json_extract(s.row_json,'$.created_at'),${TZ_MODIFIER}) >= ${since}
            GROUP BY si.shop_id, inv_id
          ) v ON v.shop_id = i.shop_id AND v.inv_id = CAST(json_extract(i.row_json,'$.id') AS INTEGER)
          WHERE i.table_name = 'inventory'${filter.clause}
            AND COALESCE(CAST(json_extract(i.row_json,'$.archived') AS INTEGER), 0) = 0
            AND (CAST(json_extract(i.row_json,'$.stock_quantity') AS REAL) <= CAST(json_extract(i.row_json,'$.min_stock_alert') AS REAL)
              OR v.units > 0)
        `).all(...filter.params);
        const list = rows
          .map(r => {
            const restockQty = Math.max(1, (r.min_stock_alert - r.stock_quantity) + 1);
            return {
              id: r.id,
              shop_id: r.shop_id,
              brand: r.brand || '',
              model_name: r.model_name || '',
              part_type: r.part_type || '',
              sku_barcode: r.sku_barcode || '',
              cost_price: Number(r.cost_price) || 0,
              price_retail: Number(r.price_retail) || 0,
              price_technician: Number(r.price_technician) || 0,
              supplier: r.supplier || '',
              location: r.location || '',
              name: [r.brand, r.model_name, r.part_type].filter(Boolean).join(' '),
              stock_quantity: r.stock_quantity,
              min_stock_alert: r.min_stock_alert,
              units_sold: r.units_sold,
              cover_days: r.units_sold > 0 ? Math.round((r.stock_quantity * days / r.units_sold) * 10) / 10 : null,
              below_min: r.stock_quantity <= r.min_stock_alert,
              restock_qty: restockQty,
              restock_cost: Math.round(restockQty * (Number(r.cost_price) || 0) * 100) / 100
            };
          })
          .filter(r => r.below_min || (r.cover_days !== null && r.cover_days < 14))
          .sort((a, b) => ((b.below_min ? 1 : 0) - (a.below_min ? 1 : 0)) || (a.stock_quantity - b.stock_quantity))
          .slice(0, 300);
        return json(res, 200, list);
      }

      if (p === '/api/inventory/reorder' && req.method === 'GET') {
        const d = Math.max(1, Math.min(90, Math.trunc(Number(url.searchParams.get('days')) || 7)));
        const sinceIso = new Date(Date.now() - d * 86400 * 1000).toISOString();
        const shop = url.searchParams.get('shop');
        const filter = getStoreShopFilter(session.storeId, shop, 'si');
        const rows = db.prepare(`
          SELECT i.shop_id,
                 CAST(json_extract(i.row_json,'$.id') AS INTEGER) AS id,
                 json_extract(i.row_json,'$.brand') AS brand,
                 json_extract(i.row_json,'$.model_name') AS model_name,
                 json_extract(i.row_json,'$.part_type') AS part_type,
                 json_extract(i.row_json,'$.sku_barcode') AS sku_barcode,
                 CAST(json_extract(i.row_json,'$.cost_price') AS REAL) AS cost_price,
                 CAST(json_extract(i.row_json,'$.price_retail') AS REAL) AS price_retail,
                 CAST(json_extract(i.row_json,'$.price_technician') AS REAL) AS price_technician,
                 CAST(json_extract(i.row_json,'$.stock_quantity') AS REAL) AS stock_quantity,
                 CAST(json_extract(i.row_json,'$.min_stock_alert') AS REAL) AS min_stock_alert,
                 COALESCE(CAST(json_extract(i.row_json,'$.allow_fractional') AS INTEGER), 0) AS allow_fractional,
                 json_extract(i.row_json,'$.supplier') AS supplier,
                 json_extract(i.row_json,'$.location') AS location,
                 SUM(CAST(json_extract(si.row_json,'$.quantity') AS REAL)) AS qty_sold,
                 COUNT(DISTINCT s.local_id) AS sale_count,
                 MAX(json_extract(s.row_json,'$.created_at')) AS last_sold_at
          FROM shop_rows si
          JOIN shop_rows s ON s.table_name = 'sales' AND s.shop_id = si.shop_id
            AND s.local_id = CAST(json_extract(si.row_json,'$.sale_id') AS INTEGER)
          JOIN shop_rows i ON i.table_name = 'inventory' AND i.shop_id = si.shop_id
            AND i.local_id = CAST(json_extract(si.row_json,'$.inventory_id') AS INTEGER)
          WHERE si.table_name = 'sale_items'${filter.clause}
            AND json_extract(si.row_json,'$.item_type') = 'part'
            AND json_extract(si.row_json,'$.inventory_id') IS NOT NULL
            AND COALESCE(CAST(json_extract(s.row_json,'$.voided') AS INTEGER), 0) = 0
            AND COALESCE(CAST(json_extract(i.row_json,'$.archived') AS INTEGER), 0) = 0
            AND json_extract(s.row_json,'$.created_at') >= ?
          GROUP BY i.shop_id, i.local_id
          ORDER BY qty_sold DESC, stock_quantity ASC, brand ASC, model_name ASC
        `).all(...filter.params, sinceIso);
        const mapped = rows.map(r => {
          const sold = Number(r.qty_sold) || 0;
          const stock = Number(r.stock_quantity) || 0;
          const minAlert = Number(r.min_stock_alert) || 0;
          // Match the counter's reorder sheet (src/inventory.js
          // listReorderSuggestions): net replenishment need, not a full
          // buy-up of everything sold. The two surfaces must agree.
          const suggested_qty = Math.max(Math.round((sold - stock) * 1000) / 1000, 0);
          return {
            id: r.id,
            shop_id: r.shop_id,
            brand: r.brand || '',
            model_name: r.model_name || '',
            part_type: r.part_type || '',
            sku_barcode: r.sku_barcode || '',
            cost_price: Number(r.cost_price) || 0,
            price_retail: Number(r.price_retail) || 0,
            price_technician: Number(r.price_technician) || 0,
            stock_quantity: stock,
            min_stock_alert: minAlert,
            allow_fractional: Number(r.allow_fractional) ? 1 : 0,
            supplier: r.supplier || '',
            location: r.location || '',
            qty_sold: sold,
            sale_count: Number(r.sale_count) || 0,
            last_sold_at: r.last_sold_at || '',
            suggested_qty,
            est_cost: Math.round(suggested_qty * (Number(r.cost_price) || 0) * 100) / 100
          };
        });
        return json(res, 200, { days: d, rows: mapped });
      }

      if (p === '/api/inventory/adjust-stock' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req) || '{}');
        const id = Number(body.id);
        const rawDelta = Number(body.delta);
        if (!positiveId(id)) return json(res, 400, { error: 'valid part id required' });
        if (!Number.isFinite(rawDelta) || rawDelta === 0 || Math.abs(rawDelta) > 100000) {
          return json(res, 400, { error: 'delta must be a non-zero number' });
        }
        const reason = String(body.reason || 'receive').trim().slice(0, 40) || 'receive';
        const note = String(body.note || 'Added from Cloud').trim().slice(0, 200);
        const opId = typeof body.op_id === 'string' && body.op_id.trim()
          ? body.op_id.trim().slice(0, 120)
          : `cloud-adj-${crypto.randomUUID()}`;

        const storeShops = db.prepare(`SELECT shop_id FROM shops WHERE store_id = ? OR (? = 'default' AND (store_id IS NULL OR store_id = '')) ORDER BY last_seen DESC`).all(session.storeId, session.storeId).map(s => s.shop_id);
        if (storeShops.length === 0) return json(res, 400, { error: 'No shop register is paired yet' });

        let targetShopId = body.shop_id && storeShops.includes(body.shop_id) ? body.shop_id : '';
        if (!targetShopId) {
          if (storeShops.length === 1) {
            targetShopId = storeShops[0];
          } else {
            const matching = storeShops.filter(sid => db.prepare("SELECT 1 FROM shop_rows WHERE shop_id = ? AND table_name = 'inventory' AND local_id = ?").get(sid, id));
            if (matching.length === 1) targetShopId = matching[0];
            else return json(res, 400, { error: 'Select a specific shop register first' });
          }
        }

        const existingCmd = db.prepare('SELECT id FROM cloud_commands WHERE op_id = ?').get(opId);
        const invRow = db.prepare("SELECT row_json FROM shop_rows WHERE shop_id = ? AND table_name = 'inventory' AND local_id = ?").get(targetShopId, id);
        if (!invRow) return json(res, 404, { error: 'Part not found in cloud mirror' });
        const item = JSON.parse(invRow.row_json);
        if (existingCmd) {
          return json(res, 200, { ok: true, shop_id: targetShopId, item, deduplicated: true });
        }

        const allowFrac = Boolean(item.allow_fractional);
        if (!allowFrac && !Number.isInteger(rawDelta)) {
          return json(res, 400, { error: 'delta must be a non-zero integer' });
        }
        const delta = allowFrac ? Math.round(rawDelta * 1000) / 1000 : rawDelta;
        if (allowFrac && delta === 0) {
          return json(res, 400, { error: 'delta must be at least 0.001' });
        }

        const now = new Date().toISOString();
        const rawNext = (Number(item.stock_quantity) || 0) + delta;
        // The register has the final say on the floor: refusing here answers
        // the manager immediately instead of queueing a command the register
        // will refuse on every drain while the mirror already shows the clamp.
        if (rawNext < -1e-9) {
          return json(res, 409, { error: `Adjustment would take stock below zero (mirror stock: ${item.stock_quantity}, delta: ${delta}). The register holds the truth; send a smaller delta or receive stock first.` });
        }
        item.stock_quantity = allowFrac ? Math.round(rawNext * 1000) / 1000 : rawNext;
        item.updated_at = now;
        const cmdPayload = JSON.stringify({ id, delta, reason, note });

        db.exec('BEGIN');
        try {
          db.prepare("UPDATE shop_rows SET row_json = ?, updated_at = ? WHERE shop_id = ? AND table_name = 'inventory' AND local_id = ?")
            .run(JSON.stringify(item), now, targetShopId, id);
          db.prepare('INSERT INTO cloud_commands (shop_id, op_id, kind, payload_json, created_at) VALUES (?, ?, ?, ?, ?)')
            .run(targetShopId, opId, 'adjust_stock', cmdPayload, now);
          db.exec('COMMIT');
        } catch (err) {
          db.exec('ROLLBACK');
          throw err;
        }
        broadcast('change', { shop_id: targetShopId, count: 1, tables: ['inventory'] }, session.storeId);
        return json(res, 200, { ok: true, shop_id: targetShopId, item });
      }

      if (p === '/api/inventory/import' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req) || '{}');
        const rows = body.rows;
        if (!Array.isArray(rows) || rows.length === 0 || rows.length > 2000) {
          return json(res, 400, { error: 'rows must be an array of 1 to 2000 items' });
        }
        const opId = typeof body.op_id === 'string' && body.op_id.trim()
          ? body.op_id.trim().slice(0, 120)
          : `cloud-imp-${crypto.randomUUID()}`;

        const storeShops = db.prepare(`SELECT shop_id FROM shops WHERE store_id = ? OR (? = 'default' AND (store_id IS NULL OR store_id = '')) ORDER BY last_seen DESC`).all(session.storeId, session.storeId).map(s => s.shop_id);
        if (storeShops.length === 0) return json(res, 400, { error: 'No shop register is paired yet' });

        let targetShopId = body.shop_id && storeShops.includes(body.shop_id) ? body.shop_id : '';
        if (!targetShopId) {
          if (storeShops.length === 1) targetShopId = storeShops[0];
          else return json(res, 400, { error: 'Select a specific shop register in the top bar before importing CSV' });
        }

        const existingCmd = db.prepare('SELECT id FROM cloud_commands WHERE op_id = ?').get(opId);
        if (existingCmd) {
          return json(res, 200, { ok: true, shop_id: targetShopId, created: 0, updated: 0, skipped: 0, deduplicated: true });
        }

        const now = new Date().toISOString();
        const existingRows = db.prepare("SELECT local_id, row_json FROM shop_rows WHERE shop_id = ? AND table_name = 'inventory'").all(targetShopId)
          .map(r => ({ local_id: r.local_id, data: JSON.parse(r.row_json) }));
        let maxLocalId = existingRows.reduce((m, r) => Math.max(m, Number(r.local_id) || 0), 0);

        const upsertStmt = db.prepare(`
          INSERT INTO shop_rows (shop_id, table_name, local_id, row_json, updated_at)
          VALUES (?, 'inventory', ?, ?, ?)
          ON CONFLICT (shop_id, table_name, local_id)
          DO UPDATE SET row_json = excluded.row_json, updated_at = excluded.updated_at
        `);

        let created = 0, updated = 0, skipped = 0;
        const cleanRows = [];

        db.exec('BEGIN');
        try {
          for (const raw of rows) {
            if (!raw || typeof raw !== 'object') { skipped++; continue; }
            const item_name = raw.item_name && String(raw.item_name).trim() ? String(raw.item_name).trim() : null;
            const brand = String(raw.brand || '').trim() || (item_name ? 'General' : '');
            const model_name = String(raw.model_name || '').trim() || (item_name || '');
            const part_type = String(raw.part_type || '').trim() || (item_name ? (String(raw.category || '').trim() || 'General') : '');
            if (!brand || !model_name || !part_type) { skipped++; continue; }

            const sku = raw.sku_barcode && String(raw.sku_barcode).trim() ? String(raw.sku_barcode).trim() : null;
            let match = sku
              ? existingRows.find(e => e.data && String(e.data.sku_barcode || '').trim() === sku)
              : null;
            if (!match) {
              const bL = brand.toLowerCase(), mL = model_name.toLowerCase(), pL = part_type.toLowerCase();
              match = existingRows.find(e => e.data
                && String(e.data.brand || '').trim().toLowerCase() === bL
                && String(e.data.model_name || '').trim().toLowerCase() === mL
                && String(e.data.part_type || '').trim().toLowerCase() === pL);
            }

            const cost = Math.max(0, Number(raw.cost_price) || 0);
            const retail = Math.max(0, Number(raw.price_retail) || 0);
            const tech = raw.price_technician !== undefined && raw.price_technician !== '' && Number(raw.price_technician) >= 0
              ? Number(raw.price_technician)
              : retail;
            const hasFracFlag = raw.allow_fractional !== undefined && raw.allow_fractional !== '';
            const allowFrac = hasFracFlag
              ? (raw.allow_fractional === true || /^(1|true|yes)$/i.test(String(raw.allow_fractional).trim()))
              : Boolean(match?.data?.allow_fractional);
            const rawQty = Math.max(0, Number(raw.stock_quantity) || 0);
            const qty = allowFrac ? Math.round(rawQty * 1000) / 1000 : Math.trunc(rawQty);
            const hasMinAlert = raw.min_stock_alert !== undefined && raw.min_stock_alert !== '' && Number(raw.min_stock_alert) >= 0;
            const minAlert = hasMinAlert ? (allowFrac ? Math.round(Number(raw.min_stock_alert) * 1000) / 1000 : Math.trunc(Number(raw.min_stock_alert))) : 3;
            const supplier = String(raw.supplier || '').trim();
            const location = String(raw.location || '').trim();
            const category = raw.category && String(raw.category).trim() ? String(raw.category).trim() : part_type;
            const uom = raw.uom && String(raw.uom).trim() ? String(raw.uom).trim() : '';

            cleanRows.push({
              brand, model_name, part_type,
              item_name: item_name || '',
              category,
              uom,
              allow_fractional: allowFrac ? 1 : 0,
              sku_barcode: sku || '',
              cost_price: cost,
              price_retail: retail,
              price_technician: tech,
              stock_quantity: qty,
              min_stock_alert: hasMinAlert ? minAlert : '',
              supplier, location
            });

            if (match) {
              const d = match.data;
              const sum = (Number(d.stock_quantity) || 0) + qty;
              d.stock_quantity = allowFrac ? Math.max(0, Math.round(sum * 1000) / 1000) : Math.max(0, sum);
              if (item_name) d.item_name = item_name;
              if (raw.category && String(raw.category).trim()) d.category = category;
              if (uom) d.uom = uom;
              if (hasFracFlag) d.allow_fractional = allowFrac ? 1 : 0;
              if (cost > 0) d.cost_price = cost;
              if (retail > 0) d.price_retail = retail;
              if (tech > 0) d.price_technician = tech;
              if (hasMinAlert) d.min_stock_alert = minAlert;
              if (sku) d.sku_barcode = sku;
              if (supplier) d.supplier = supplier;
              if (location) d.location = location;
              d.archived = 0;
              d.updated_at = now;
              upsertStmt.run(targetShopId, match.local_id, JSON.stringify(d), now);
              updated++;
            } else {
              const newId = ++maxLocalId;
              const newItem = {
                id: newId,
                brand, model_name, part_type,
                item_name,
                category,
                uom: uom || 'pcs',
                allow_fractional: allowFrac ? 1 : 0,
                sku_barcode: sku,
                cost_price: cost,
                price_retail: retail,
                price_technician: tech,
                stock_quantity: qty,
                min_stock_alert: minAlert,
                supplier, location,
                archived: 0,
                created_at: now,
                updated_at: now
              };
              existingRows.push({ local_id: newId, data: newItem });
              upsertStmt.run(targetShopId, newId, JSON.stringify(newItem), now);
              created++;
            }
          }
          if (cleanRows.length > 0) {
            db.prepare('INSERT INTO cloud_commands (shop_id, op_id, kind, payload_json, created_at) VALUES (?, ?, ?, ?, ?)')
              .run(targetShopId, opId, 'import_inventory', JSON.stringify({ rows: cleanRows }), now);
          }
          db.exec('COMMIT');
        } catch (err) {
          db.exec('ROLLBACK');
          throw err;
        }
        if (created + updated > 0) {
          broadcast('change', { shop_id: targetShopId, count: created + updated, tables: ['inventory'] }, session.storeId);
        }
        return json(res, 200, { ok: true, shop_id: targetShopId, created, updated, skipped });
      }

      if (p === '/api/dead-stock') {
        const period = url.searchParams.get('period');
        const days = ['day', '7d', '30d'].includes(period) ? { day: 1, '7d': 7, '30d': 30 }[period] : 30;
        const since = `date('now',${TZ_MODIFIER},'-${days - 1} days')`;
        const today = db.prepare(`SELECT date('now',${TZ_MODIFIER}) AS d`).get().d;
        const shop = url.searchParams.get('shop');
        const filter = getStoreShopFilter(session.storeId, shop, 'r');
        const lastSold = new Map(db.prepare(`
          SELECT si.shop_id, CAST(json_extract(si.row_json,'$.inventory_id') AS INTEGER) AS inv_id,
                 MAX(date(json_extract(s.row_json,'$.created_at'),${TZ_MODIFIER})) AS last_day
          FROM shop_rows si
          JOIN shop_rows s ON s.table_name = 'sales' AND s.shop_id = si.shop_id
            AND s.local_id = CAST(json_extract(si.row_json,'$.sale_id') AS INTEGER)
          WHERE si.table_name = 'sale_items' AND json_extract(si.row_json,'$.inventory_id') IS NOT NULL
            AND COALESCE(CAST(json_extract(s.row_json,'$.voided') AS INTEGER), 0) = 0
          GROUP BY si.shop_id, inv_id
        `).all().map(r => [`${r.shop_id}:${r.inv_id}`, r.last_day]));
        const soldInWindow = new Set(db.prepare(`
          SELECT DISTINCT si.shop_id || ':' || CAST(json_extract(si.row_json,'$.inventory_id') AS INTEGER) AS key
          FROM shop_rows si
          JOIN shop_rows s ON s.table_name = 'sales' AND s.shop_id = si.shop_id
            AND s.local_id = CAST(json_extract(si.row_json,'$.sale_id') AS INTEGER)
          WHERE si.table_name = 'sale_items' AND json_extract(si.row_json,'$.inventory_id') IS NOT NULL
            AND COALESCE(CAST(json_extract(s.row_json,'$.voided') AS INTEGER), 0) = 0
            AND date(json_extract(s.row_json,'$.created_at'),${TZ_MODIFIER}) >= ${since}
        `).all().map(r => r.key));
        const rows = db.prepare(`
          SELECT r.shop_id,
                 CAST(json_extract(r.row_json,'$.id') AS INTEGER) AS id,
                 json_extract(r.row_json,'$.brand') AS brand,
                 json_extract(r.row_json,'$.model_name') AS model_name,
                 json_extract(r.row_json,'$.part_type') AS part_type,
                 CAST(json_extract(r.row_json,'$.stock_quantity') AS REAL) AS stock_quantity,
                 CAST(json_extract(r.row_json,'$.cost_price') AS REAL) AS cost_price,
                 date(json_extract(r.row_json,'$.created_at'),${TZ_MODIFIER}) AS stocked_at
          FROM shop_rows r
          WHERE r.table_name = 'inventory'${filter.clause}
            AND COALESCE(CAST(json_extract(r.row_json,'$.archived') AS INTEGER), 0) = 0
            AND CAST(json_extract(r.row_json,'$.stock_quantity') AS REAL) > 0
        `).all(...filter.params);
        const dead = rows
          .filter(r => !soldInWindow.has(`${r.shop_id}:${r.id}`))
          .map(r => {
            const stockedSince = r.stocked_at || today;
            const last = lastSold.get(`${r.shop_id}:${r.id}`) || stockedSince;
            const daysNoSale = Math.max(0, Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${last}T00:00:00Z`)) / 86400000));
            return {
              id: r.id,
              shop_id: r.shop_id,
              name: [r.brand, r.model_name, r.part_type].filter(Boolean).join(' '),
              stock_quantity: r.stock_quantity,
              tied_up_capital: Math.round(r.stock_quantity * (Number(r.cost_price) || 0) * 100) / 100,
              last_sold: lastSold.has(`${r.shop_id}:${r.id}`) ? last : null,
              days_no_sale: daysNoSale,
              age_band: daysNoSale >= 90 ? '90+' : daysNoSale >= 60 ? '60+' : daysNoSale >= 30 ? '30+' : '<30'
            };
          })
          .sort((a, b) => b.tied_up_capital - a.tied_up_capital)
          .slice(0, 20);
        return json(res, 200, dead);
      }
      return json(res, 404, { error: 'unknown endpoint' });
    }

    // --- SSE stream (manager) ---
    if (p === '/events') {
      const session = authorizedManager(req);
      if (!session) return json(res, 401, { error: 'login required' });
      // A held-open stream costs a socket plus a ping interval; a session that
      // cannot open hundreds of them cannot exhaust the VPS either.
      if (sseClients.size >= 500) return json(res, 429, { error: 'too many live streams' });
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
      });
      res.write('event: hello\ndata: {}\n\n');
      res.storeId = session.storeId;
      sseClients.add(res);
      // Reverse proxies (nginx and friends) drop idle SSE streams; a comment
      // ping every 25s keeps the connection warm without emitting events.
      const ping = setInterval(() => {
        try { res.write(': ping\n\n'); } catch (_) { sseClients.delete(res); clearInterval(ping); }
      }, 25000);
      if (ping.unref) ping.unref();
      req.on('close', () => { sseClients.delete(res); clearInterval(ping); });
      return;
    }

    // --- static manager app (containment check mirrors src/server.js) ---
    let filePath = path.join(PUBLIC_DIR, p === '/' ? 'index.html' : path.normalize(p));
    const base = path.resolve(PUBLIC_DIR);
    if (filePath !== base && !filePath.startsWith(base + path.sep)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden');
      return;
    }
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath);
      const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }[ext] || 'text/plain';
      res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store' });
      fs.createReadStream(filePath).pipe(res);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  } catch (err) {
    // Fixed text only: the internet does not get V8 parse messages or SQLite
    // constraint text. The real reason goes to the service log.
    console.error(`[error] ${req.method} ${p} failed: ${err.stack || err.message}`);
    json(res, 400, { error: 'Request failed' });
  }
});

// --- ops: PIN rotation ------------------------------------------------------
// The first-minted PIN prints once at setup (bootstrap needs it somewhere).
// This is the standing rotation path: run `node cloud/server.js --rotate-pin`,
// record the new PIN from the output, restart the service. Sessions live in
// memory, so the restart also evicts every existing manager login.
// The PIN is a keypad-typable 8-digit number on purpose: the old rotation wrote
// a 48-hex random string, which getManagerPin() treats as the legacy shape and
// rewrites on the next boot, so the "new" PIN never survived a restart.
if (process.argv.includes('--rotate-pin')) {
  const pin = newManagerPin();
  fs.writeFileSync(MANAGER_PIN_PATH, pin, { encoding: 'utf8', mode: 0o600 });
  console.log(`[setup] Manager PIN rotated and saved to ${MANAGER_PIN_PATH} (read it from that file, not from a journal)`);
  console.log('[setup] Restart the cloud service now; the restart also signs out all manager sessions.');
  process.exit(0);
}

// --- ops: daily cloud.db backup --------------------------------------------
// The outbox prunes synced rows 30 days after upload, so for anything older
// the mirror is the only copy outside the shop. Decision (2026-09-27): the
// cloud view is disposable-in-disaster: it is backed up daily here with the
// same integrity bar as the shop, and restored from backups/cloud-<date>.db;
// a full re-push-history mode from the shop was considered and not built.
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
function runDailyCloudBackup() {
  try {
    const d = new Date();
    const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const finalPath = path.join(BACKUP_DIR, `cloud-${today}.db`);
    if (fs.existsSync(finalPath)) return;
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    // ponytail: vacuum to tmp, verify, atomic rename: same shape as the shop's
    // createDbBackup so a corrupt or partial file never evicts the last good one.
    let tmpPath = '';
    try {
      const normalizedSqlPath = '';
      tmpPath = `${finalPath}.tmp-${process.pid}-${Date.now()}`;
      const sqlPath = tmpPath.replace(/\\/g, '/').replace(/'/g, "''");
      db.exec(`VACUUM INTO '${sqlPath}'`);
      const vdb = new DatabaseSync(tmpPath);
      const ok = vdb.prepare('PRAGMA integrity_check').get()?.integrity_check === 'ok';
      vdb.close();
      if (!ok) throw new Error('integrity_check failed on the temporary backup');
      if (fs.existsSync(finalPath)) fs.unlinkSync(finalPath);
      fs.renameSync(tmpPath, finalPath);
      tmpPath = '';
    } finally {
      // A failed VACUUM leaves a partial sibling; no integrity check ran on it,
      // so it must not sit there looking like a candidate.
      if (tmpPath) { try { fs.unlinkSync(tmpPath); } catch (_) {} }
    }
    const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
    for (const f of fs.readdirSync(BACKUP_DIR)) {
      if (!/^cloud-.*\.db(\.tmp-.*)?$/.test(f)) continue;
      const fp = path.join(BACKUP_DIR, f);
      try { if (fs.statSync(fp).mtimeMs < cutoff) fs.unlinkSync(fp); } catch (_) {}
    }
    console.log(`[backup] cloud.db snapshot written: ${finalPath}`);
  } catch (err) {
    console.error(`[backup] cloud.db backup failed: ${err.message}`);
  }
}
runDailyCloudBackup();
setInterval(runDailyCloudBackup, 60 * 60 * 1000).unref();

server.listen(PORT, HOST, () => {
  // The bound port, not the configured one: PORT=0 (test harnesses, throwaway
  // runs) must report what the kernel actually handed out.
  console.log(`Cloud sync service listening on http://${HOST}:${server.address().port}`);
  console.log(`Data: ${DB_PATH}`);
});
