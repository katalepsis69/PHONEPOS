// phone-repair-pos/tests/auth.test.js
const assert = require('node:assert');
const { dbTest } = require('./helper');
const {
  verifyManagerPin, updateManagerPin, isDefaultPin, hashPin,
  hasRecoveryPassword, setRecoveryPassword, recoverManagerPin,
  getReportToken, verifyReportToken
} = require('../src/auth');
const { getShopSettings } = require('../src/settings');

dbTest('Default manager PIN is 1234 and is flagged for replacement', (db) => {
  assert.strictEqual(verifyManagerPin(db, '1234'), true);
  assert.strictEqual(verifyManagerPin(db, '0000'), false);
  assert.strictEqual(verifyManagerPin(db, '9999'), false);
  assert.strictEqual(isDefaultPin(db), true);
  // The first successful login transparently upgrades the seeded legacy
  // sha256 row to salted PBKDF2, and it keeps verifying.
  assert.match(db.prepare("SELECT value FROM shop_settings WHERE key = 'manager_pin_hash'").get().value, /^pbkdf2\$/);
  assert.strictEqual(verifyManagerPin(db, '1234'), true);
  assert.strictEqual(isDefaultPin(db), true);
});

dbTest('Manager PIN can be changed and verified', (db) => {
  assert.strictEqual(verifyManagerPin(db, '1234'), true);

  const result = updateManagerPin(db, '1234', '5678');
  assert.strictEqual(result.success, true);

  assert.strictEqual(verifyManagerPin(db, '1234'), false);
  assert.strictEqual(verifyManagerPin(db, '5678'), true);
  assert.strictEqual(isDefaultPin(db), false);

  assert.throws(() => updateManagerPin(db, 'wrong', '9999'), /Current PIN is incorrect/);
});

dbTest('Manager PIN cannot be set back to the factory default or to a weak value', (db) => {
  assert.throws(() => updateManagerPin(db, '1234', '1234'), /other than the factory default/);
  assert.throws(() => updateManagerPin(db, '1234', '123'), /at least 4 digits/);
  assert.throws(() => updateManagerPin(db, '1234', 'abcd'), /at least 4 digits/);
  assert.strictEqual(isDefaultPin(db), true); // nothing was written
});

// M6: PIN hashes are salted — the same PIN never hashes twice.
dbTest('Stored PIN hashes are salted PBKDF2', (db) => {
  const a = hashPin('5678');
  const b = hashPin('5678');
  assert.notStrictEqual(a, b);
  assert.match(a, /^pbkdf2\$/);
});

dbTest('Lockout triggers after 5 failures and blocks the correct PIN too', (db) => {
  for (let i = 0; i < 4; i++) assert.strictEqual(verifyManagerPin(db, '0000'), false);
  assert.throws(() => verifyManagerPin(db, '0000'), /locked for 60s/i);

  // A correct PIN must not slip past an active lockout.
  assert.throws(() => verifyManagerPin(db, '1234'), /Locked for/i);
});

// The reason lockout state lives in the database: restarting the .exe must not clear it.
dbTest('Lockout deadline is persisted, not held in process memory', (db) => {
  for (let i = 0; i < 4; i++) verifyManagerPin(db, '0000');
  assert.throws(() => verifyManagerPin(db, '0000'), /locked/i);

  const until = Number(db.prepare("SELECT value FROM shop_settings WHERE key = 'pin_lockout_until'").get().value);
  assert.ok(until > Date.now(), 'lockout deadline must be stored in shop_settings so a restart cannot reset it');
});

dbTest('A correct PIN clears the failure counter', (db) => {
  verifyManagerPin(db, '0000');
  verifyManagerPin(db, '0000');
  assert.strictEqual(verifyManagerPin(db, '1234'), true);

  // Counter reset, so 4 more failures must not lock out.
  for (let i = 0; i < 4; i++) assert.strictEqual(verifyManagerPin(db, '0000'), false);
});

dbTest('recovery password validation, independent 15m lockout, and Manager PIN reset', (db) => {
  assert.strictEqual(hasRecoveryPassword(db), false);
  assert.throws(() => recoverManagerPin(db, 'secret1', '5678'), /No recovery password/);

  for (const bad of ['', '12345', '      ', '1234']) {
    assert.throws(() => setRecoveryPassword(db, bad));
  }
  updateManagerPin(db, '1234', '2580');
  assert.throws(() => setRecoveryPassword(db, '2580'), /different|6/);
  updateManagerPin(db, '2580', '258099');
  assert.throws(() => setRecoveryPassword(db, '258099'), /Manager PIN/i);

  setRecoveryPassword(db, 'shop-owner-99');
  assert.strictEqual(hasRecoveryPassword(db), true);
  const pub = getShopSettings(db);
  assert.strictEqual('recovery_password_hash' in pub, false);
  assert.strictEqual('recovery_lockout_until' in pub, false);
  assert.strictEqual('recovery_failed_attempts' in pub, false);

  // 5 wrong recovery tries lock recovery only, leaving Manager PIN login working
  for (let i = 0; i < 4; i++) assert.strictEqual(recoverManagerPin(db, 'wrong-pw', '4321'), false);
  assert.throws(() => recoverManagerPin(db, 'wrong-pw', '4321'), err => err.statusCode === 429);
  assert.strictEqual(verifyManagerPin(db, '258099'), true);

  // Reset recovery lockout timestamp cleanly in test DB, then recover PIN to 7788
  db.prepare("UPDATE shop_settings SET value = '0' WHERE key IN ('recovery_failed_attempts','recovery_lockout_until')").run();
  const prevReport = getReportToken(db);
  assert.strictEqual(recoverManagerPin(db, 'shop-owner-99', '7788'), true);
  assert.strictEqual(verifyManagerPin(db, '7788'), true);
  assert.strictEqual(verifyReportToken(db, prevReport), false);
});

dbTest('recovery password input validation and new PIN edge cases', (db) => {
  // Unconfigured recovery password throws 400
  assert.throws(() => recoverManagerPin(db, 'secret1', '5678'), err => err.statusCode === 400 && /No recovery password/.test(err.message));

  // Non-string or null recovery passwords throw 400
  for (const bad of [null, undefined, 123456, {}, []]) {
    assert.throws(() => setRecoveryPassword(db, bad), err => err.statusCode === 400);
  }

  setRecoveryPassword(db, 'shop-owner-99');

  // Once recovery password is set, wrong password returns false and does not throw 400
  assert.strictEqual(recoverManagerPin(db, 'wrong-password', '5678'), false);

  // Correct recovery password with invalid newPin throws 400
  for (const badPin of ['', '123', 'abcd', '1234', null, undefined]) {
    assert.throws(() => recoverManagerPin(db, 'shop-owner-99', badPin), err => err.statusCode === 400);
  }
});


