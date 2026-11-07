// phone-repair-pos/src/license.js
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { getDbFile } = require('./db');

// Ed25519 vendor PUBLIC key (SPKI DER, base64). Safe to ship: it can only verify,
// never sign. The matching PRIVATE key stays on the vendor's machine and is the
// only thing that can mint keys -- never commit it, never bundle it.
// Rotate with: node scripts/generate-license.js --init
const VENDOR_PUBLIC_KEY_B64 = 'MCowBQYDK2VwAyEA/T/4JtvgWuWDcJJXHtXylSQSwiEtEbOlLtCi0zf9zjc=';

// Transition key: the public key this app shipped before the 2026-10-14
// rotation. Every seat activated against it must keep validating after the
// update, or the rotation itself 402-locks customers. Verification tries the
// current key first and falls back to this one; it can only verify, never sign.
// Drop it once no seat minted before the rotation is left in the field.
const VENDOR_PUBLIC_KEY_PREVIOUS_B64 = 'MCowBQYDK2VwAyEABLKie0DXZHrIofXh5EU5L+DLbe96wu51O9vcO7pP1Bg=';

function publicKey(b64 = VENDOR_PUBLIC_KEY_B64) {
  return crypto.createPublicKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'spki' });
}

function vendorVerifyKeyB64s() {
  const keys = [VENDOR_PUBLIC_KEY_B64];
  if (VENDOR_PUBLIC_KEY_PREVIOUS_B64 && VENDOR_PUBLIC_KEY_PREVIOUS_B64 !== VENDOR_PUBLIC_KEY_B64) {
    keys.push(VENDOR_PUBLIC_KEY_PREVIOUS_B64);
  }
  return keys;
}

// Constant for the process lifetime; os.cpus()+sha256 per call was ~150us of
// every API request via the license gate.
// The hostname is deliberately NOT part of the binding: it was, and renaming a
// PC silently invalidated a paid seat with no recovery besides a vendor
// re-mint. Keys minted before this change carry the hostname-bound ID, so
// verification still accepts that legacy shape (getLegacyMachineId).
function computeMachineId({ includeHostname }) {
  const platform = os.platform();
  const arch = os.arch();
  const cpus = os.cpus();
  const cpuModel = cpus.length > 0 ? cpus[0].model : 'unknown';
  const raw = includeHostname
    ? `${platform}|${os.hostname()}|${arch}|${cpuModel}`
    : `${platform}|${arch}|${cpuModel}`;
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  const short = hash.substring(0, 8).toUpperCase();
  return `TP-${platform.substring(0, 3).toUpperCase()}-${short.substring(0, 4)}-${short.substring(4, 8)}`;
}

let cachedMachineId;
let cachedLegacyMachineId;
function getMachineId() {
  if (!cachedMachineId) cachedMachineId = computeMachineId({ includeHostname: false });
  return cachedMachineId;
}
function getLegacyMachineId() {
  if (!cachedLegacyMachineId) cachedLegacyMachineId = computeMachineId({ includeHostname: true });
  return cachedLegacyMachineId;
}
// Both IDs are accepted for a stored key; minting always uses getMachineId().
function getMachineIds(db = null) {
  const ids = new Set([getMachineId(), getLegacyMachineId()]);
  if (db) {
    try {
      const row = db.prepare("SELECT value FROM shop_settings WHERE key = 'workstation_machine_id'").get();
      if (row && row.value) ids.add(row.value);
    } catch (_) {}
  }
  return Array.from(ids);
}

function getActiveMachineId(db = null) {
  if (!db) return getMachineId();
  try {
    const row = db.prepare("SELECT value FROM shop_settings WHERE key = 'workstation_machine_id'").get();
    if (row && row.value) return row.value;

    const licRow = db.prepare("SELECT value FROM shop_settings WHERE key = 'license_key'").get();
    if (licRow && licRow.value) {
      const match = matchVendorKey(licRow.value, licenseNow(db));
      if (match && match.result && match.result.valid && match.machineId) {
        db.prepare("INSERT OR REPLACE INTO shop_settings (key, value) VALUES ('workstation_machine_id', ?)").run(match.machineId);
        return match.machineId;
      }
    }

    const currentId = getMachineId();
    db.prepare("INSERT OR REPLACE INTO shop_settings (key, value) VALUES ('workstation_machine_id', ?)").run(currentId);
    return currentId;
  } catch (_) {
    return getMachineId();
  }
}

function verifyLicenseKey(licenseKey, currentMachineId, verifyKey = publicKey(), nowMs = Date.now()) {
  try {
    const [payloadB64, signature] = String(licenseKey).split('.');
    if (!payloadB64 || !signature) return { valid: false, error: 'Malformed key' };

    const signatureOk = crypto.verify(null, Buffer.from(payloadB64), verifyKey, Buffer.from(signature, 'base64url'));
    if (!signatureOk) return { valid: false, error: 'Invalid signature' };

    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());

    if (currentMachineId && payload.machine_id !== currentMachineId) {
      return { valid: false, error: 'Machine ID mismatch', ...payload };
    }

    let is_expired = false;
    let days_left = -1;
    // Any plan that carries an expiry date gets checked — monthly/yearly keys
    // must lapse exactly like legacy 'subscription' keys do.
    // expires_at is date-only (YYYY-MM-DD), and the generator has only ever
    // minted that shape. new Date('YYYY-MM-DD') parses as UTC midnight, so a
    // Date-vs-local-now compare skews the deadline ±14h by timezone; comparing
    // local calendar dates as strings matches the app's day convention
    // (listSales, dashboard) with no zone guessing.
    if (payload.expires_at) {
      const localNow = new Date(nowMs);
      const todayLocal = `${localNow.getFullYear()}-${String(localNow.getMonth() + 1).padStart(2, '0')}-${String(localNow.getDate()).padStart(2, '0')}`;
      const expiryDay = String(payload.expires_at).slice(0, 10);
      is_expired = todayLocal > expiryDay;
      // Both parsed as UTC midnights -> exact integer day distance.
      days_left = Math.max(0, Math.round(
        (Date.parse(`${expiryDay}T00:00:00Z`) - Date.parse(`${todayLocal}T00:00:00Z`)) / 86400000
      ));
    } else {
      days_left = 99999;
    }

    return {
      valid: !is_expired,
      machine_id: payload.machine_id,
      plan_type: payload.plan_type,
      expires_at: payload.expires_at || '',
      customer_name: payload.customer_name || '',
      is_expired,
      days_left
    };
  } catch (err) {
    return { valid: false, error: err.message };
  }
}

// Verification against every vendor key and every accepted machine ID, for the
// callers that hold the stored key (status, activation). A correctly signed key
// is returned even when it is expired or machine-mismatched: only a signature
// that matches NO vendor key is "Invalid signature". Returns the winning pair so
// the caller can remember it.
function matchVendorKey(licenseKey, nowMs = Date.now()) {
  const machineIds = getMachineIds();
  let signedButRejected = null;
  for (const b64 of vendorVerifyKeyB64s()) {
    let key;
    try { key = publicKey(b64); } catch (_) { continue; }
    for (const machineId of machineIds) {
      const result = verifyLicenseKey(licenseKey, machineId, key, nowMs);
      if (!result.error) return { result, keyB64: b64, machineId };
      if (result.error !== 'Invalid signature' && !signedButRejected) {
        signedButRejected = { result, keyB64: b64, machineId };
      }
    }
  }
  return signedButRejected || { result: { valid: false, error: 'Invalid signature' }, keyB64: '', machineId: '' };
}

function verifyLicenseKeyWithVendorKeys(licenseKey, nowMs = Date.now()) {
  return matchVendorKey(licenseKey, nowMs).result;
}

const TRIAL_MS = 14 * 24 * 60 * 60 * 1000;
const TRIAL_SEAL_SALT = 'tp-pos-offline-anti-tamper-v1';

function computeTrialSeal(machineId, firstRunStr, compromisedStr) {
  return crypto.createHmac('sha256', TRIAL_SEAL_SALT)
    .update(`${machineId}|${firstRunStr}|${compromisedStr}`)
    .digest('hex');
}

// Reads and advances the trial clock. Called on every API request: two/three
// tiny SELECTs plus at most one throttled write per hour. Memoize nothing.
function getTrialState(db) {
  const get = key => db.prepare('SELECT value FROM shop_settings WHERE key = ?').get(key)?.value;
  const set = (key, value) => db.prepare('INSERT OR REPLACE INTO shop_settings (key, value) VALUES (?, ?)').run(key, value);
  const now = Date.now();
  let firstRunStr = get('first_run_ts') || new Date(now).toISOString();
  let firstRun = Date.parse(firstRunStr) || now;
  const lastSeen = Date.parse(get('last_seen_ts')) || firstRun;
  let compromised = get('trial_compromised') === '1';

  const machineId = getActiveMachineId(db);
  const storedSeal = get('trial_seal');
  let expectedSeal = computeTrialSeal(machineId, firstRunStr, compromised ? '1' : '0');

  if (!storedSeal) {
    // A deleted seal must not buy a fresh trial: an attacker edits
    // first_run_ts/last_seen_ts to now and this branch reseeds honestly over
    // the edited inputs. Floor first-run at the oldest evidence a DB edit
    // cannot move (the shop.db file's own birth time, first audit row), then
    // reseed over the floored value. ponytail: evidence is advisory, a wiped
    // audit log plus a moved database file is beyond the casual bypass this
    // closes.
    const evidence = [];
    const dbFile = getDbFile(db);
    if (dbFile) { try { evidence.push(fs.statSync(dbFile).birthtimeMs); } catch (_) {} }
    try {
      const row = db.prepare('SELECT MIN(created_at) AS m FROM audit_log').get();
      const t = row && Date.parse(row.m);
      if (Number.isFinite(t)) evidence.push(t);
    } catch (_) {}
    const earliest = evidence.length ? Math.min(...evidence) : null;
    // A first-run pushed past last-seen is the edit itself: flag it on the
    // stored value before flooring, so the tamper stays on the record.
    if (firstRun > lastSeen + 60 * 1000) {
      compromised = true;
      set('trial_compromised', '1');
    }
    if (earliest && firstRun > earliest + 60 * 1000) {
      firstRun = earliest;
      firstRunStr = new Date(firstRun).toISOString();
      set('first_run_ts', firstRunStr);
    }
    expectedSeal = computeTrialSeal(machineId, firstRunStr, compromised ? '1' : '0');
    set('trial_seal', expectedSeal);
  } else if (storedSeal !== expectedSeal) {
    compromised = true;
    set('trial_compromised', '1');
    set('trial_seal', computeTrialSeal(machineId, firstRunStr, '1'));
  }

  // Rollback: clock moved back >24h. Flag is permanent -- only activation
  // clears the gate, never the flag.
  if (now < lastSeen - 24 * 60 * 60 * 1000) {
    if (!compromised) {
      compromised = true;
      set('trial_compromised', '1');
      set('trial_seal', computeTrialSeal(machineId, firstRunStr, '1'));
    }
  } else if (now > lastSeen + 60 * 60 * 1000) {
    // Advance: throttled write on the read path catches rollback while running.
    set('last_seen_ts', new Date(now).toISOString());
  }

  // Crawl guard: the 24h flag only catches one big jump, so the highest clock
  // ever observed is persisted and expiry is judged against it. A daily
  // 23h59m back-step stops extending anything on the first day. ponytail: a
  // clock set legitimately AHEAD once costs those days back, fail-closed.
  const storedMax = Date.parse(get('trial_max_seen_ts') || '') || 0;
  const maxSeen = Math.max(storedMax, now, lastSeen);
  if (maxSeen !== storedMax) set('trial_max_seen_ts', new Date(maxSeen).toISOString());

  const trialEnd = firstRun + TRIAL_MS;
  const active = !compromised && maxSeen <= trialEnd;
  const days_left = compromised ? 0 : Math.max(0, Math.ceil((trialEnd - maxSeen) / (24 * 60 * 60 * 1000)));
  return { active, days_left };
}

// Test seam: node --test loads tests and the server in one process, so a test
// can point the default verify key at a throwaway keypair. Production never calls this.
let verifyKeyOverride;
function setVerifyKeyForTests(key) { verifyKeyOverride = key; }

// One of: 'trial' | 'expired' | 'monthly' | 'yearly' | 'lifetime'.
// Precedence: a verified license outranks the trial; an activated key without
// an expiry is lifetime; time-boxed keys carry their tier in plan_type.
// Legacy 'subscription' keys predate the split, so the tier is derived from
// remaining time — close enough for display, and the generator now mints
// explicit tiers so the fallback only serves old keys.
function classifyLicenseStatus({ activated, plan_type, expires_at, days_left, trial_active }) {
  if (activated) {
    if (plan_type === 'lifetime' || !expires_at) return 'lifetime';
    if (plan_type === 'monthly' || plan_type === 'yearly') return plan_type;
    return Number(days_left) > 180 ? 'yearly' : 'monthly';
  }
  return trial_active ? 'trial' : 'expired';
}

// License expiry gets the same anti-rollback treatment the trial already has: a
// monotonic last-seen stamp, so setting the PC clock back cannot hold a
// monthly/yearly key open indefinitely. Seeded on first read: unseeded, seen
// stayed 0 and both legs below were dead (their windows never match a real
// clock). A rollback past 24h holds the deadline at its highest seen value; a
// forward jump is recorded like any other advance, so the clamp base keeps
// tracking the running clock instead of freezing after a >48h gap.
function licenseNow(db) {
  const get = key => db.prepare('SELECT value FROM shop_settings WHERE key = ?').get(key)?.value;
  const set = (key, value) => db.prepare('INSERT OR REPLACE INTO shop_settings (key, value) VALUES (?, ?)').run(key, value);
  const now = Date.now();
  const seen = Date.parse(get('license_seen_ts')) || 0;
  if (!seen) {
    set('license_seen_ts', new Date(now).toISOString());
    return now;
  }
  // ANY rollback holds the highest seen, not just past-24h jumps: a daily
  // 23h59m back-step used to slip under the old threshold and stretch a
  // time-boxed key indefinitely. An honest small correction rides out the
  // difference in wall-clock time; fail-closed is the correct bias here.
  if (now < seen) return seen;
  if (now > seen + 60 * 60 * 1000) {
    // Advance, throttled to one write per hour on the read path.
    set('license_seen_ts', new Date(now).toISOString());
  }
  return now;
}

// Every accepted binding (stable ID first, then the legacy hostname-bound ID)
// against one key: a key minted before the hostname was dropped from the hash
// must still verify on the machine that holds the same hostname.
function verifyWithKey(licenseKey, key, nowMs) {
  let signedButRejected = null;
  for (const machineId of getMachineIds()) {
    const result = verifyLicenseKey(licenseKey, machineId, key, nowMs);
    if (!result.error) return result;
    if (result.error !== 'Invalid signature' && !signedButRejected) signedButRejected = result;
  }
  return signedButRejected || { valid: false, error: 'Invalid signature' };
}

// One crypto.verify per request on the hot license-gate path: the (key, machine
// ID) pair that verified last time is remembered and tried first, and only a
// change re-runs the full search.
let matchedLicenseKey = null; // { licenseKey, keyB64, machineId }
function verifyStoredKey(db, licenseKey) {
  const nowMs = licenseNow(db);
  if (verifyKeyOverride) return verifyWithKey(licenseKey, verifyKeyOverride, nowMs);
  const cached = matchedLicenseKey;
  if (cached && cached.licenseKey === licenseKey) {
    try {
      const result = verifyLicenseKey(licenseKey, cached.machineId, publicKey(cached.keyB64), nowMs);
      if (!result.error) return result;
    } catch (_) {}
    matchedLicenseKey = null;
  }
  const match = matchVendorKey(licenseKey, nowMs);
  if (!match.result.error) {
    matchedLicenseKey = { licenseKey, keyB64: match.keyB64, machineId: match.machineId };
  }
  return match.result;
}

function getLicenseStatus(db, verifyKey = null) {
  const trial = getTrialState(db);
  const row = db.prepare("SELECT value FROM shop_settings WHERE key = 'license_key'").get();
  const licenseKey = row?.value || '';

  const activeId = getActiveMachineId(db);
  const result = licenseKey
    ? (verifyKey
        ? verifyWithKey(licenseKey, verifyKey, licenseNow(db))
        : verifyStoredKey(db, licenseKey))
    : { valid: false };

  const reportedMachineId = (result && result.valid && result.machine_id)
    ? result.machine_id
    : activeId;

  const base = {
    machine_id: reportedMachineId,
    legacy_machine_id: getLegacyMachineId(),
    trial_active: trial.active,
    trial_days_left: trial.days_left
  };

  if (!licenseKey) {
    return { ...base, activated: false, plan_type: '', expires_at: '', days_left: 0, customer_name: '', license_required: !trial.active, status: classifyLicenseStatus({ activated: false, trial_active: trial.active }) };
  }

  return {
    ...base,
    activated: result.valid,
    plan_type: result.plan_type || '',
    expires_at: result.expires_at || '',
    days_left: result.days_left || 0,
    customer_name: result.customer_name || '',
    error: result.error || '',
    license_required: !result.valid && !trial.active,
    status: classifyLicenseStatus({
      activated: result.valid,
      plan_type: result.plan_type || '',
      expires_at: result.expires_at || '',
      days_left: result.days_left || 0,
      trial_active: trial.active
    })
  };
}

function activateLicense(db, licenseKey, verifyKey = null) {
  const key = verifyKey || verifyKeyOverride || null;
  const result = key
    ? verifyWithKey(licenseKey, key, licenseNow(db))
    : matchVendorKey(licenseKey, licenseNow(db)).result;

  if (!result.valid) {
    throw new Error(result.error || 'Invalid license key');
  }

  db.prepare("INSERT OR REPLACE INTO shop_settings (key, value) VALUES ('license_key', ?)").run(licenseKey);
  if (result.machine_id) {
    db.prepare("INSERT OR REPLACE INTO shop_settings (key, value) VALUES ('workstation_machine_id', ?)").run(result.machine_id);
  }
  matchedLicenseKey = null; // the stored key changed; re-match on the next status read
  return getLicenseStatus(db, verifyKey);
}

module.exports = {
  getMachineId,
  getActiveMachineId,
  getLegacyMachineId,
  getMachineIds,
  verifyLicenseKey,
  verifyLicenseKeyWithVendorKeys,
  getLicenseStatus,
  classifyLicenseStatus,
  activateLicense,
  setVerifyKeyForTests,
  publicKey,
  VENDOR_PUBLIC_KEY_B64,
  VENDOR_PUBLIC_KEY_PREVIOUS_B64
};
