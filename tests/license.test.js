// phone-repair-pos/tests/license.test.js
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { dbTest } = require('./helper');
const {
  getMachineId, getLegacyMachineId, verifyLicenseKey, verifyLicenseKeyWithVendorKeys,
  getLicenseStatus, activateLicense,
  classifyLicenseStatus, publicKey, VENDOR_PUBLIC_KEY_B64, VENDOR_PUBLIC_KEY_PREVIOUS_B64
} = require('../src/license');
const { generateLicenseKey, normalizeMachineId, planFromDays, MACHINE_ID_RE, fingerprint, matchesShippedBuild } = require('../scripts/generate-license');
const fs = require('node:fs');
const path = require('node:path');

// Throwaway vendor keypair: tests must never depend on the real private key,
// which is not in the repo.
const vendor = crypto.generateKeyPairSync('ed25519');
const sign = payload => generateLicenseKey(payload, vendor.privateKey);

test('Machine ID is stable and well-formatted', () => {
  const id1 = getMachineId();
  const id2 = getMachineId();
  assert.strictEqual(id1, id2);
  assert.ok(id1.startsWith('TP-'));
  assert.ok(id1.length >= 12);
});

test('License key generation and verification round-trip', () => {
  const machineId = getMachineId();
  const key = sign({ machine_id: machineId, plan_type: 'lifetime', customer_name: 'Test Shop' });
  assert.ok(key.includes('.'));

  const result = verifyLicenseKey(key, machineId, vendor.publicKey);
  assert.strictEqual(result.valid, true);
  assert.strictEqual(result.machine_id, machineId);
  assert.strictEqual(result.plan_type, 'lifetime');
  assert.strictEqual(result.customer_name, 'Test Shop');
  assert.strictEqual(result.is_expired, false);
});

test('License key rejects tampered signature', () => {
  const machineId = getMachineId();
  const key = sign({ machine_id: machineId });
  const tampered = key.slice(0, -3) + 'XXX';
  assert.strictEqual(verifyLicenseKey(tampered, machineId, vendor.publicKey).valid, false);
});

test('License key rejects a tampered payload', () => {
  const machineId = getMachineId();
  const key = sign({ machine_id: machineId, customer_name: 'Paid Shop' });
  const [, signature] = key.split('.');
  const forgedPayload = Buffer.from(JSON.stringify({
    machine_id: machineId, plan_type: 'lifetime', expires_at: '', customer_name: 'Freeloader'
  })).toString('base64url');

  const result = verifyLicenseKey(`${forgedPayload}.${signature}`, machineId, vendor.publicKey);
  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.error, 'Invalid signature');
});

test('License key rejects wrong machine ID', () => {
  const key = sign({ machine_id: 'TP-WIN-FAKE-1234' });
  const result = verifyLicenseKey(key, 'TP-WIN-REAL-5678', vendor.publicKey);
  assert.strictEqual(result.valid, false);
  assert.ok(result.error.includes('mismatch'));
});

test('Subscription license detects expiry', () => {
  const machineId = getMachineId();
  const expired = sign({ machine_id: machineId, plan_type: 'subscription', expires_at: '2020-01-01' });
  const result = verifyLicenseKey(expired, machineId, vendor.publicKey);
  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.is_expired, true);
});

test('Expiry uses local calendar days, not UTC-midnight parsing', () => {
  const machineId = getMachineId();
  const dayStr = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const today = new Date();
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const in30 = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  // Expires today: still valid at 23:59 local, days_left exactly 0.
  const lastDay = sign({ machine_id: machineId, plan_type: 'monthly', expires_at: dayStr(today) });
  const lastDayResult = verifyLicenseKey(lastDay, machineId, vendor.publicKey);
  assert.strictEqual(lastDayResult.valid, true);
  assert.strictEqual(lastDayResult.is_expired, false);
  assert.strictEqual(lastDayResult.days_left, 0);

  // Expired yesterday: dead at 00:01 local, no timezone grace period.
  const past = sign({ machine_id: machineId, plan_type: 'monthly', expires_at: dayStr(yesterday) });
  assert.strictEqual(verifyLicenseKey(past, machineId, vendor.publicKey).valid, false);

  // A 30-day key reports exactly 30 whole days remaining.
  const monthly = sign({ machine_id: machineId, plan_type: 'monthly', expires_at: dayStr(in30) });
  assert.strictEqual(verifyLicenseKey(monthly, machineId, vendor.publicKey).days_left, 30);
});

// The whole point of asymmetric signing: a key minted by anyone else must not activate.
test('A key signed by a different private key is rejected by the shipped public key', () => {
  const attacker = crypto.generateKeyPairSync('ed25519');
  const forged = generateLicenseKey({ machine_id: getMachineId(), customer_name: 'Pirate' }, attacker.privateKey);
  assert.strictEqual(verifyLicenseKey(forged, getMachineId()).valid, false);
});

test('Shipped vendor public key is a usable Ed25519 key and holds no private half', () => {
  const key = publicKey();
  assert.strictEqual(key.asymmetricKeyType, 'ed25519');
  assert.strictEqual(key.type, 'public');
  assert.ok(VENDOR_PUBLIC_KEY_B64.length > 0);
  // Signing must be impossible with what ships in the binary.
  assert.throws(() => crypto.sign(null, Buffer.from('x'), key));
});

test('generateLicenseKey refuses to sign without a private key', () => {
  assert.throws(() => generateLicenseKey({ machine_id: getMachineId() }), /requires the vendor private key/);
});

test('normalizeMachineId cleans up how the vendor typed the ID', () => {
  assert.strictEqual(normalizeMachineId(' tp-win-8f12-a3d9 '), 'TP-WIN-8F12-A3D9');
  assert.strictEqual(normalizeMachineId('TP–WIN–8F12–A3D9'), 'TP-WIN-8F12-A3D9');
  const cleaned = normalizeMachineId('tp-win-dead-beef');
  assert.ok(MACHINE_ID_RE.test(cleaned), 'cleaned IDs pass the format check');
});

test('planFromDays maps validity to tiers', () => {
  assert.strictEqual(planFromDays(0), 'lifetime');
  assert.strictEqual(planFromDays(45), 'monthly');
  assert.strictEqual(planFromDays(46), 'yearly');
});

test('fingerprint and matchesShippedBuild read the public half off a private key', () => {
  assert.ok(/^[0-9A-F]{2}(?::[0-9A-F]{2}){7}$/.test(fingerprint(vendor.privateKey)));
  // The throwaway test keypair is never the key baked into the build.
  assert.strictEqual(matchesShippedBuild(vendor.privateKey), false);
});

dbTest('Database license activation and status check', (db) => {
  assert.strictEqual(getLicenseStatus(db, vendor.publicKey).activated, false);

  const key = sign({ machine_id: getMachineId(), plan_type: 'lifetime', customer_name: 'Unit Test Shop' });
  const activated = activateLicense(db, key, vendor.publicKey);
  assert.strictEqual(activated.activated, true);
  assert.strictEqual(activated.customer_name, 'Unit Test Shop');

  assert.strictEqual(getLicenseStatus(db, vendor.publicKey).activated, true);
});

dbTest('Activation rejects a forged key and stores nothing', (db) => {
  const attacker = crypto.generateKeyPairSync('ed25519');
  const forged = generateLicenseKey({ machine_id: getMachineId() }, attacker.privateKey);

  assert.throws(() => activateLicense(db, forged), /Invalid signature/);
  assert.strictEqual(getLicenseStatus(db).activated, false);
  assert.strictEqual(db.prepare("SELECT value FROM shop_settings WHERE key = 'license_key'").get().value, '');
});

// ---------------------------------------------------------------------------
// TRIAL STATE
// ---------------------------------------------------------------------------
const expireTrial = (db) => db.prepare("UPDATE shop_settings SET value = ? WHERE key = 'first_run_ts'")
  .run(new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString());

dbTest('Fresh DB gets an active 14-day trial, no license required', (db) => {
  const s = getLicenseStatus(db, vendor.publicKey);
  assert.strictEqual(s.activated, false);
  assert.strictEqual(s.trial_active, true);
  assert.strictEqual(s.license_required, false);
  assert.ok(s.trial_days_left > 13 && s.trial_days_left <= 14);
});

dbTest('Trial lapsed 20 days ago requires a license', (db) => {
  expireTrial(db);
  const s = getLicenseStatus(db, vendor.publicKey);
  assert.strictEqual(s.trial_active, false);
  assert.strictEqual(s.trial_days_left, 0);
  assert.strictEqual(s.license_required, true);
});

dbTest('Clock rollback sets the permanent compromise flag', (db) => {
  db.prepare("UPDATE shop_settings SET value = ? WHERE key = 'last_seen_ts'")
    .run(new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString());

  const s = getLicenseStatus(db, vendor.publicKey);
  assert.strictEqual(s.license_required, true);
  assert.strictEqual(db.prepare("SELECT value FROM shop_settings WHERE key = 'trial_compromised'").get().value, '1');

  // Permanent: a later clean clock read does not clear it.
  assert.strictEqual(getLicenseStatus(db, vendor.publicKey).license_required, true);
});

dbTest('Expired subscription key still requires a license', (db) => {
  // A subscription key that was valid at activation time, then lapsed: stored
  // in shop_settings, no longer verifying. activateLicense() would reject it,
  // so write it directly like the passage of time did.
  const key = sign({ machine_id: getMachineId(), plan_type: 'subscription', expires_at: '2020-01-01' });
  db.prepare("INSERT OR REPLACE INTO shop_settings (key, value) VALUES ('license_key', ?)").run(key);
  expireTrial(db); // gate only closes once the trial window is also over
  const s = getLicenseStatus(db, vendor.publicKey);
  assert.strictEqual(s.activated, false);
  assert.strictEqual(s.license_required, true);
});

dbTest('Demo reset does not clear trial state', (db) => {
  expireTrial(db);
  const { resetDemoData } = require('../src/seed');
  resetDemoData(db);
  assert.strictEqual(getLicenseStatus(db, vendor.publicKey).license_required, true);
});

dbTest('Activation opens the gate even on a compromised trial', (db) => {
  db.prepare("UPDATE shop_settings SET value = ? WHERE key = 'last_seen_ts'")
    .run(new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString());
  getLicenseStatus(db, vendor.publicKey); // trip the rollback detector

  const key = sign({ machine_id: getMachineId(), plan_type: 'lifetime', customer_name: 'Compromised Clock Shop' });
  activateLicense(db, key, vendor.publicKey);
  const s = getLicenseStatus(db, vendor.publicKey);
  assert.strictEqual(s.activated, true);
  assert.strictEqual(s.license_required, false);
  // The compromise flag itself is never cleared -- only the gate opens.
  assert.strictEqual(db.prepare("SELECT value FROM shop_settings WHERE key = 'trial_compromised'").get().value, '1');
});

// The public key was replaced on 2026-10-14. Every seat activated before that
// rotation verifies with the PREVIOUS key, so the app ships it as a transition
// key: without it, a self-update 402-locks every existing customer on first boot.
test('a key minted before the vendor-key rotation still verifies (transition key)', () => {
  assert.ok(VENDOR_PUBLIC_KEY_PREVIOUS_B64, 'the transition key constant is gone');
  assert.notStrictEqual(VENDOR_PUBLIC_KEY_PREVIOUS_B64, VENDOR_PUBLIC_KEY_B64);
  // The vendor ledger holds a real key minted 2026-10-14T10:25Z, before the
  // 18:29Z rotation. Its signature must still match a shipped vendor key; the
  // machine check may legitimately fail on a different machine, so "not Invalid
  // signature" is the property under test.
  const ledger = path.join(__dirname, '..', 'dist', 'licenses-issued.jsonl');
  if (!fs.existsSync(ledger)) return; // vendor workspace absent: nothing to pin
  const first = fs.readFileSync(ledger, 'utf8').trim().split('\n').filter(Boolean)[0];
  if (!first) return;
  const rec = JSON.parse(first);
  const result = verifyLicenseKeyWithVendorKeys(rec.license_key);
  assert.notStrictEqual(result.error, 'Invalid signature', 'the pre-rotation key no longer matches any shipped vendor key');
  assert.strictEqual(result.plan_type, rec.plan_type);
});

test('the machine binding has a stable ID and still accepts the legacy hostname-bound ID', () => {
  const stable = getMachineId();
  const legacy = getLegacyMachineId();
  assert.notStrictEqual(stable, legacy, 'the two shapes differ on any machine');
  // The hostname is no longer part of the hash, so renaming the PC leaves the
  // stable ID untouched; keys minted before the change carry the legacy ID and
  // stay acceptable.
  const legacyKey = sign({ machine_id: legacy, plan_type: 'lifetime' });
  assert.strictEqual(verifyLicenseKey(legacyKey, legacy, vendor.publicKey).valid, true);
  assert.strictEqual(require('../src/license').getMachineIds().includes(legacy), true);
});

dbTest('a key bound to the legacy hostname machine ID still activates (test seam)', (db) => {
  const { setVerifyKeyForTests } = require('../src/license');
  setVerifyKeyForTests(vendor.publicKey);
  try {
    const legacyKey = sign({ machine_id: getLegacyMachineId(), plan_type: 'lifetime' });
    const status = activateLicense(db, legacyKey);
    assert.strictEqual(status.activated, true, 'a pre-change key must still activate');
    const stranger = sign({ machine_id: 'TP-WIN-0000-0000', plan_type: 'lifetime' });
    assert.throws(() => activateLicense(db, stranger), /Machine ID mismatch/);
  } finally {
    setVerifyKeyForTests(null);
  }
});

dbTest('a clock rollback cannot hold a time-boxed license open', (db) => {
  const inDays = days => new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const key = sign({ machine_id: getMachineId(), plan_type: 'monthly', expires_at: inDays(30) });
  activateLicense(db, key, vendor.publicKey);
  assert.strictEqual(getLicenseStatus(db, vendor.publicKey).activated, true);

  // The stored monotonic stamp is 40 days ahead of "now" (the rollback shape:
  // the PC clock was moved back). Expiry must be judged at the highest time
  // already observed, or rolling the clock back extends the key indefinitely.
  db.prepare("INSERT OR REPLACE INTO shop_settings (key, value) VALUES ('license_seen_ts', ?)")
    .run(new Date(Date.now() + 40 * 24 * 60 * 60 * 1000).toISOString());
  const s = getLicenseStatus(db, vendor.publicKey);
  assert.strictEqual(s.activated, false, 'a rolled-back clock must not extend the license');
  // The plan tier still rides along, but an unverified key does not outrank the
  // still-active trial window (the same precedence as any expired key).
  assert.strictEqual(s.plan_type, 'monthly');
  assert.strictEqual(s.status, 'trial');

  // A normal clock (stamp behind now) still reports the key active.
  db.prepare("INSERT OR REPLACE INTO shop_settings (key, value) VALUES ('license_seen_ts', ?)")
    .run(new Date(Date.now() - 60 * 1000).toISOString());
  assert.strictEqual(getLicenseStatus(db, vendor.publicKey).activated, true);
});

// ---------------------------------------------------------------------------
// STATUS CLASSIFICATION (Trial / Expired / Monthly / Yearly / Lifetime)
// ---------------------------------------------------------------------------
const future = days => new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

dbTest('Fresh DB reports trial status', (db) => {
  assert.strictEqual(getLicenseStatus(db, vendor.publicKey).status, 'trial');
});

dbTest('Lapsed trial with no key reports expired', (db) => {
  expireTrial(db);
  assert.strictEqual(getLicenseStatus(db, vendor.publicKey).status, 'expired');
});

dbTest('Activated keys report their tier as status', (db) => {
  const activate = plan => {
    const key = sign({ machine_id: getMachineId(), plan_type: plan, expires_at: plan === 'lifetime' ? '' : future(30) });
    activateLicense(db, key, vendor.publicKey);
    return getLicenseStatus(db, vendor.publicKey).status;
  };
  assert.strictEqual(activate('monthly'), 'monthly');
  assert.strictEqual(activate('yearly'), 'yearly');
  assert.strictEqual(activate('lifetime'), 'lifetime');
});

dbTest('Legacy subscription keys derive the tier from time remaining', (db) => {
  const key = sign({ machine_id: getMachineId(), plan_type: 'subscription', expires_at: future(300) });
  activateLicense(db, key, vendor.publicKey);
  assert.strictEqual(getLicenseStatus(db, vendor.publicKey).status, 'yearly');

  const shortKey = sign({ machine_id: getMachineId(), plan_type: 'subscription', expires_at: future(30) });
  activateLicense(db, shortKey, vendor.publicKey);
  assert.strictEqual(getLicenseStatus(db, vendor.publicKey).status, 'monthly');
});

dbTest('Expired monthly key reports expired once the trial is over', (db) => {
  // Stale key written directly, as the passage of time would leave behind.
  const key = sign({ machine_id: getMachineId(), plan_type: 'monthly', expires_at: '2020-01-01' });
  db.prepare("INSERT OR REPLACE INTO shop_settings (key, value) VALUES ('license_key', ?)").run(key);

  // While the trial still runs, the app stays usable and reports the trial.
  assert.strictEqual(getLicenseStatus(db, vendor.publicKey).status, 'trial');

  expireTrial(db);
  const s = getLicenseStatus(db, vendor.publicKey);
  assert.strictEqual(s.activated, false);
  assert.strictEqual(s.status, 'expired');
  assert.strictEqual(s.license_required, true);
});

test('classifyLicenseStatus is a pure ladder over the five outcomes', () => {
  const c = classifyLicenseStatus;
  // Activated tiers
  assert.strictEqual(c({ activated: true, plan_type: 'lifetime', expires_at: '', days_left: 99999, trial_active: true }), 'lifetime');
  assert.strictEqual(c({ activated: true, plan_type: 'monthly', expires_at: '2026-09-30', days_left: 30, trial_active: false }), 'monthly');
  assert.strictEqual(c({ activated: true, plan_type: 'yearly', expires_at: '2027-08-31', days_left: 365, trial_active: false }), 'yearly');
  // Legacy fallback by remaining time
  assert.strictEqual(c({ activated: true, plan_type: 'subscription', expires_at: '2026-12-31', days_left: 200, trial_active: false }), 'yearly');
  assert.strictEqual(c({ activated: true, plan_type: 'subscription', expires_at: '2026-09-30', days_left: 30, trial_active: false }), 'monthly');
  // No key: trial decides
  assert.strictEqual(c({ activated: false, plan_type: '', expires_at: '', days_left: 0, trial_active: true }), 'trial');
  assert.strictEqual(c({ activated: false, plan_type: '', expires_at: '', days_left: 0, trial_active: false }), 'expired');
});

dbTest('getLicenseStatus preserves the licensed machine ID when activated with legacy ID', (db) => {
  const { setVerifyKeyForTests } = require('../src/license');
  setVerifyKeyForTests(vendor.publicKey);
  try {
    const legacyKey = sign({ machine_id: getLegacyMachineId(), plan_type: 'lifetime', customer_name: 'Legacy Seat' });
    const status = activateLicense(db, legacyKey);
    assert.strictEqual(status.activated, true);
    assert.strictEqual(status.machine_id, getLegacyMachineId(), 'must preserve the licensed legacy machine ID');

    // Subsequent status check without passing key explicitly
    const recheck = getLicenseStatus(db);
    assert.strictEqual(recheck.activated, true);
    assert.strictEqual(recheck.machine_id, getLegacyMachineId(), 'recheck must retain the licensed machine ID');
  } finally {
    setVerifyKeyForTests(null);
  }
});

dbTest('getLicenseStatus persists workstation_machine_id so serial never drifts', (db) => {
  const s1 = getLicenseStatus(db);
  const persisted = db.prepare("SELECT value FROM shop_settings WHERE key = 'workstation_machine_id'").get()?.value;
  assert.ok(persisted, 'workstation_machine_id must be persisted');
  assert.strictEqual(s1.machine_id, persisted);

  // Subsequent check reads the same persisted machine ID
  const s2 = getLicenseStatus(db);
  assert.strictEqual(s2.machine_id, persisted);
});

dbTest('trial_seal detects direct SQLite edits to first_run_ts or trial_compromised', (db) => {
  // 1. First read seals the legitimate trial state
  const initial = getLicenseStatus(db, vendor.publicKey);
  assert.strictEqual(initial.trial_active, true);
  assert.ok(db.prepare("SELECT value FROM shop_settings WHERE key = 'trial_seal'").get()?.value);

  // 2. Attacker pushes first_run_ts into the future via SQLite Browser to extend the trial
  db.prepare("UPDATE shop_settings SET value = '2099-01-01T00:00:00.000Z' WHERE key = 'first_run_ts'").run();
  const afterExtend = getLicenseStatus(db, vendor.publicKey);
  assert.strictEqual(afterExtend.trial_active, false);
  assert.strictEqual(afterExtend.trial_days_left, 0);
  assert.strictEqual(afterExtend.license_required, true);
  assert.strictEqual(db.prepare("SELECT value FROM shop_settings WHERE key = 'trial_compromised'").get().value, '1');

  // 3. Attacker flips trial_compromised back to '0' via SQLite Browser
  db.prepare("UPDATE shop_settings SET value = '0' WHERE key = 'trial_compromised'").run();
  const afterFlip = getLicenseStatus(db, vendor.publicKey);
  assert.strictEqual(afterFlip.trial_active, false);
  assert.strictEqual(afterFlip.license_required, true);
  assert.strictEqual(db.prepare("SELECT value FROM shop_settings WHERE key = 'trial_compromised'").get().value, '1');

  // 4. Attacker deletes trial_seal and pushes first_run_ts past last_seen_ts
  db.prepare("DELETE FROM shop_settings WHERE key = 'trial_seal'").run();
  db.prepare("UPDATE shop_settings SET value = '0' WHERE key = 'trial_compromised'").run();
  const afterDropSeal = getLicenseStatus(db, vendor.publicKey);
  assert.strictEqual(afterDropSeal.trial_active, false);
  assert.strictEqual(afterDropSeal.license_required, true);
  assert.strictEqual(db.prepare("SELECT value FROM shop_settings WHERE key = 'trial_compromised'").get().value, '1');
});
