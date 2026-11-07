// phone-repair-pos/tests/auth.test.js
const assert = require('node:assert');
const { dbTest } = require('./helper');
const { verifyManagerPin, updateManagerPin, isDefaultPin, hashPin } = require('../src/auth');

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

