// phone-repair-pos/src/auth.js
const crypto = require('node:crypto');

const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 60 * 1000;
const REPORT_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

// PIN hashing: PBKDF2 (100k SHA256 iterations, per-hash random salt). An
// unsalted single SHA256 over a 4-digit PIN falls to a rainbow table in
// seconds if the DB file leaks. Format: pbkdf2$<iters>$<salt-hex>$<hash-hex>.
// verifyPin accepts BOTH formats and silently upgrades legacy sha256 rows on
// successful login, so existing installs migrate without a migration step.
const PBKDF2_ITERATIONS = 100000;
const LEGACY_PREFIX = 'pbkdf2$';

function hashPin(pin) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.pbkdf2Sync(String(pin), salt, PBKDF2_ITERATIONS, 32, 'sha256');
  return `${LEGACY_PREFIX}${PBKDF2_ITERATIONS}$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function legacyHashPin(pin) {
  return crypto.createHash('sha256').update(String(pin)).digest('hex');
}

// Returns { ok, upgrade: 'legacyHash' | null }
function verifyPinHash(stored, pin) {
  if (!stored) return { ok: false, upgrade: null };
  if (stored.startsWith(LEGACY_PREFIX)) {
    const [, iterStr, saltHex, hashHex] = stored.split('$');
    const hash = crypto.pbkdf2Sync(String(pin), Buffer.from(saltHex, 'hex'), Number(iterStr) || PBKDF2_ITERATIONS, 32, 'sha256');
    const expected = Buffer.from(hashHex, 'hex');
    return { ok: hash.length === expected.length && crypto.timingSafeEqual(hash, expected), upgrade: null };
  }
  const input = Buffer.from(legacyHashPin(pin));
  const expected = Buffer.from(stored);
  const ok = input.length === expected.length && crypto.timingSafeEqual(input, expected);
  // Upgrade value is the PBKDF2 re-hash, not the legacy digest (writing the
  // legacy digest back would be a no-op upgrade).
  return { ok, upgrade: ok ? hashPin(pin) : null };
}

// ponytail: prepared-statement cache — avoid re-parsing same SQL every call
const _stmtCache = new WeakMap();
function _prep(db, sql) {
  let m = _stmtCache.get(db);
  if (!m) { m = new Map(); _stmtCache.set(db, m); }
  let s = m.get(sql);
  if (!s) { s = db.prepare(sql); m.set(sql, s); }
  return s;
}
const getSetting = (db, key) => _prep(db, 'SELECT value FROM shop_settings WHERE key = ?').get(key)?.value || '';
const setSetting = (db, key, value) => _prep(db, 'INSERT OR REPLACE INTO shop_settings (key, value) VALUES (?, ?)').run(key, String(value));

// The secret is minted once per install and never rotated, but every request
// used to re-read it — memoize per database handle.
const _secretCache = new WeakMap();
function getSessionSecret(db) {
  let secret = _secretCache.get(db);
  if (secret) return secret;
  secret = getSetting(db, 'counter_session_secret');
  if (!secret) {
    secret = crypto.randomBytes(32).toString('hex');
    setSetting(db, 'counter_session_secret', secret);
  }
  _secretCache.set(db, secret);
  return secret;
}

const getManagerPinHash = db => getSetting(db, 'manager_pin_hash');

// The PBKDF2 round runs on every call, not only while the factory PIN is live,
// and callers hit this per settings read. Memoize against the stored hash.
const _defaultPinCache = new WeakMap();
function isDefaultPin(db) {
  // Salted hashes make string comparison impossible — just verify the PIN.
  const stored = getSetting(db, 'manager_pin_hash');
  if (!stored) return false;
  const cached = _defaultPinCache.get(db);
  if (cached && cached.hash === stored) return cached.isDefault;
  const isDefault = verifyPinHash(stored, '1234').ok;
  _defaultPinCache.set(db, { hash: stored, isDefault });
  return isDefault;
}

// Lockout is namespaced: the LAN-reachable phone report must not share the
// counter's 5-try budget, or five guesses from a phone freeze the register.
const PIN_NAMESPACES = {
  counter: { attempts: 'pin_failed_attempts', lockout: 'pin_lockout_until', ms: LOCKOUT_MS, what: 'Workstation' },
  report: { attempts: 'report_pin_failed_attempts', lockout: 'report_pin_lockout_until', ms: 15 * 60 * 1000, what: 'Report logins' },
  recovery: { attempts: 'recovery_failed_attempts', lockout: 'recovery_lockout_until', ms: 15 * 60 * 1000, what: 'PIN recovery' }
};

function checkLockout(db, ns) {
  const config = PIN_NAMESPACES[ns] || PIN_NAMESPACES.counter;
  const lockoutUntil = Number(getSetting(db, config.lockout)) || 0;
  const now = Date.now();
  if (now < lockoutUntil) {
    const e = new Error(`Too many incorrect PIN attempts. Locked for ${Math.ceil((lockoutUntil - now) / 1000)}s.`);
    e.statusCode = 429;
    throw e;
  }
  return config;
}

function recordPinFailure(db, ns) {
  const { attempts: attemptsKey, lockout: lockoutKey, ms: lockoutMs, what } = PIN_NAMESPACES[ns] || PIN_NAMESPACES.counter;
  const attempts = (Number(getSetting(db, attemptsKey)) || 0) + 1;
  if (attempts >= MAX_ATTEMPTS) {
    setSetting(db, attemptsKey, 0);
    setSetting(db, lockoutKey, Date.now() + lockoutMs);
    const e = new Error(`Too many incorrect PIN attempts. ${what} locked for ${lockoutMs / 1000}s.`);
    e.statusCode = 429;
    throw e;
  }
  setSetting(db, attemptsKey, attempts);
  return false;
}

function verifyManagerPin(db, pin, ns = 'counter') {
  const { attempts: attemptsKey, lockout: lockoutKey } = checkLockout(db, ns);

  const storedHash = getSetting(db, 'manager_pin_hash');
  const { ok: isValid, upgrade } = verifyPinHash(storedHash, pin);

  if (isValid) {
    if (upgrade) setSetting(db, 'manager_pin_hash', upgrade);
    setSetting(db, attemptsKey, 0);
    setSetting(db, lockoutKey, 0);
    return true;
  }

  return recordPinFailure(db, ns);
}

// One token shared by manager report sessions. It rotates after a bounded
// lifetime and still rotates immediately when the manager PIN changes.
function getReportToken(db) {
  let token = getSetting(db, 'report_token');
  const expiresAt = Number(getSetting(db, 'report_token_expires_at')) || 0;
  if (!token || Date.now() > expiresAt) {
    token = crypto.randomBytes(32).toString('hex');
    setSetting(db, 'report_token', token);
    setSetting(db, 'report_token_expires_at', Date.now() + REPORT_TOKEN_TTL_MS);
  }
  return token;
}

function verifyReportToken(db, token) {
  const expected = getSetting(db, 'report_token');
  const expiresAt = Number(getSetting(db, 'report_token_expires_at')) || 0;
  if (!expected || !token || Date.now() > expiresAt) return false;
  const input = Buffer.from(String(token));
  const stored = Buffer.from(expected);
  return input.length === stored.length && crypto.timingSafeEqual(input, stored);
}

function validateNewPin(pin) {
  if (!pin || !/^\d{4,}$/.test(String(pin))) {
    const e = new Error('New PIN must be at least 4 digits');
    e.statusCode = 400;
    throw e;
  }
  if (String(pin) === '1234') {
    const e = new Error('Choose a PIN other than the factory default');
    e.statusCode = 400;
    throw e;
  }
}

function applyManagerPinReset(db, newPin) {
  setSetting(db, 'manager_pin_hash', hashPin(newPin));
  setSetting(db, 'pin_failed_attempts', 0);
  setSetting(db, 'pin_lockout_until', 0);
  setSetting(db, 'report_pin_failed_attempts', 0);
  setSetting(db, 'report_pin_lockout_until', 0);
  setSetting(db, 'recovery_failed_attempts', 0);
  setSetting(db, 'recovery_lockout_until', 0);
  _defaultPinCache.delete(db);
  // PIN change is also report-token revocation: every logged-in phone
  // is holding a token that no longer matches.
  setSetting(db, 'report_token', crypto.randomBytes(32).toString('hex'));
  setSetting(db, 'report_token_expires_at', Date.now() + REPORT_TOKEN_TTL_MS);
}

function updateManagerPin(db, oldPin, newPin) {
  if (!verifyManagerPin(db, oldPin)) {
    const e = new Error('Current PIN is incorrect');
    e.statusCode = 400;
    throw e;
  }
  validateNewPin(newPin);
  applyManagerPinReset(db, newPin);
  return { success: true };
}

function hasRecoveryPassword(db) {
  return Boolean(getSetting(db, 'recovery_password_hash'));
}

function setRecoveryPassword(db, recoveryPassword) {
  if (typeof recoveryPassword !== 'string' || recoveryPassword.length < 6 || recoveryPassword.trim().length < 6) {
    const e = new Error('Recovery password must be at least 6 characters');
    e.statusCode = 400;
    throw e;
  }
  if (recoveryPassword === '1234') {
    const e = new Error('Recovery password must be different from factory default (1234)');
    e.statusCode = 400;
    throw e;
  }
  if (verifyPinHash(getManagerPinHash(db), recoveryPassword).ok) {
    const e = new Error('Recovery password must be different from your current Manager PIN.');
    e.statusCode = 400;
    throw e;
  }
  setSetting(db, 'recovery_password_hash', hashPin(recoveryPassword));
  setSetting(db, 'recovery_failed_attempts', 0);
  setSetting(db, 'recovery_lockout_until', 0);
}

function recoverManagerPin(db, recoveryPassword, newPin) {
  if (!hasRecoveryPassword(db)) {
    const e = new Error('No recovery password is set on this workstation.');
    e.statusCode = 400;
    throw e;
  }
  checkLockout(db, 'recovery');

  const storedHash = getSetting(db, 'recovery_password_hash');
  const { ok: isValid } = verifyPinHash(storedHash, recoveryPassword);
  if (!isValid) {
    return recordPinFailure(db, 'recovery');
  }

  validateNewPin(newPin);
  applyManagerPinReset(db, newPin);
  return true;
}

// -------------------------------------------------------------
// STAFF (per-person logins; "Who's on shift?")
// -------------------------------------------------------------

function validateStaffPin(pin) {
  if (!pin || !/^\d{4,}$/.test(String(pin))) {
    throw new Error('Staff PIN must be at least 4 digits');
  }
  if (String(pin) === '1234') {
    throw new Error('Choose a staff PIN other than the factory default');
  }
}

function createStaff(db, name, pin) {
  const clean = String(name || '').trim();
  if (!clean) throw new Error('Staff name is required');
  validateStaffPin(pin);
  if (db.prepare('SELECT id FROM staff WHERE name = ? COLLATE NOCASE').get(clean)) {
    throw new Error(`Staff name "${clean}" is already taken`);
  }
  const result = db.prepare('INSERT INTO staff (name, pin_hash) VALUES (?, ?)').run(clean, hashPin(pin));
  return db.prepare('SELECT id, name, active, created_at FROM staff WHERE id = ?').get(Number(result.lastInsertRowid));
}

function listActiveStaff(db) {
  return db.prepare('SELECT id, name FROM staff WHERE active = 1 ORDER BY name COLLATE NOCASE').all();
}

// Soft delete only — audit_log.actor_id must stay referable.
function deactivateStaff(db, id) {
  return db.prepare('UPDATE staff SET active = 0 WHERE id = ? AND active = 1').run(id).changes > 0;
}

// PIN reset doubles as revocation: the cred fingerprint in that person's
// session tokens stops matching, killing their open tabs on next request.
function resetStaffPin(db, id, newPin) {
  validateStaffPin(newPin);
  return db.prepare('UPDATE staff SET pin_hash = ?, pin_failed_attempts = 0, pin_lockout_until = 0 WHERE id = ?')
    .run(hashPin(newPin), id).changes > 0;
}

function verifyStaffPin(db, id, pin) {
  const row = db.prepare('SELECT * FROM staff WHERE id = ?').get(id);
  if (!row || !row.active) return false;

  const now = Date.now();
  const lockoutUntil = Number(row.pin_lockout_until) || 0;
  if (now < lockoutUntil) {
    const e = new Error(`Too many incorrect PIN attempts. Locked for ${Math.ceil((lockoutUntil - now) / 1000)}s.`);
    e.statusCode = 429;
    throw e;
  }

  const inputHash = row.pin_hash;
  const { ok: isValid, upgrade } = verifyPinHash(inputHash, pin);

  if (isValid) {
    if (upgrade) db.prepare('UPDATE staff SET pin_hash = ? WHERE id = ?').run(upgrade, id);
    db.prepare('UPDATE staff SET pin_failed_attempts = 0, pin_lockout_until = 0 WHERE id = ?').run(id);
    return true;
  }

  const attempts = (Number(row.pin_failed_attempts) || 0) + 1;
  if (attempts >= MAX_ATTEMPTS) {
    db.prepare('UPDATE staff SET pin_failed_attempts = 0, pin_lockout_until = ? WHERE id = ?').run(now + LOCKOUT_MS, id);
    const e = new Error(`Too many incorrect PIN attempts. Locked for ${LOCKOUT_MS / 1000}s.`);
    e.statusCode = 429;
    throw e;
  }
  db.prepare('UPDATE staff SET pin_failed_attempts = ? WHERE id = ?').run(attempts, id);
  return false;
}

// -------------------------------------------------------------
// SIGNED SESSION / ELEVATION TOKENS
// HMAC-SHA256 with a per-install secret in shop_settings. No expiry
// bookkeeping: `cred` is a fingerprint of the actor's current pin_hash, so
// a PIN change (or staff deactivation) revokes tokens on the next request.
// -------------------------------------------------------------

const credOf = pinHash => crypto.createHash('sha256').update(String(pinHash)).digest('hex').slice(0, 16);

function credForActor(db, actor) {
  if (actor.type === 'staff') {
    const row = db.prepare('SELECT pin_hash FROM staff WHERE id = ?').get(actor.id);
    return row ? credOf(row.pin_hash) : null; // deleted/unknown staff: nothing matches
  }
  return credOf(getManagerPinHash(db));
}

function signToken(db, payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', getSessionSecret(db)).update(body).digest('base64url');
  return `${body}.${mac}`;
}

function verifySignedToken(db, token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [body, mac] = token.split('.');
  try {
    const expected = crypto.createHmac('sha256', getSessionSecret(db)).update(body).digest();
    const given = Buffer.from(String(mac), 'base64url');
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
    return JSON.parse(Buffer.from(body, 'base64url').toString());
  } catch (_) {
    return null;
  }
}

function issueSessionToken(db, actor) {
  return signToken(db, { t: 'session', type: actor.type, id: actor.id ?? null, name: actor.name, iat: Date.now(), cred: credForActor(db, actor) });
}

function verifySessionToken(db, token) {
  const p = verifySignedToken(db, token);
  if (!p || p.t !== 'session') return null;
  if (!p.cred || credForActor(db, p) !== p.cred) return null;
  if (p.type === 'staff') {
    const row = db.prepare('SELECT active FROM staff WHERE id = ?').get(p.id);
    if (!row || !row.active) return null;
  }
  return { type: p.type, id: p.id ?? null, name: p.name };
}

const ELEVATION_TTL_MS = 15 * 60 * 1000;

function issueElevationToken(db) {
  const payload = { t: 'elev', exp: Date.now() + ELEVATION_TTL_MS, cred: credOf(getManagerPinHash(db)) };
  return { token: signToken(db, payload), expiresAt: payload.exp };
}

function verifyElevationToken(db, token) {
  const p = verifySignedToken(db, token);
  return !!(p && p.t === 'elev' && Date.now() <= p.exp && p.cred === credOf(getManagerPinHash(db)));
}

module.exports = {
  hashPin,
  legacyHashPin,
  verifyPinHash,
  verifyManagerPin,
  updateManagerPin,
  isDefaultPin,
  hasRecoveryPassword,
  setRecoveryPassword,
  recoverManagerPin,
  getReportToken,
  verifyReportToken,
  createStaff,
  listActiveStaff,
  deactivateStaff,
  resetStaffPin,
  verifyStaffPin,
  issueSessionToken,
  verifySessionToken,
  issueElevationToken,
  verifyElevationToken
};
