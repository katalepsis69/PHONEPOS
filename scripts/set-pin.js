// phone-repair-pos/scripts/set-pin.js
// Reset the Manager PIN directly in the shop database, bypassing the app UI.
// Use cases: reseller prepping a new workstation, or a shop that forgot its PIN.
//
// Usage: node scripts/set-pin.js --db <database-path> <new-pin>
// Example: node scripts/set-pin.js --db data/shop.db 5678

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { hashPin } = require('../src/auth');

const args = process.argv.slice(2);
const dbFlag = args.indexOf('--db');
const dbArg = dbFlag >= 0 ? args[dbFlag + 1] : null;
const remaining = args.filter((_, index) => index !== dbFlag && index !== dbFlag + 1);
const pin = remaining[0];

if (!dbArg || remaining.length !== 1 || !pin || !/^\d{4,}$/.test(String(pin))) {
  console.error('Usage: node scripts/set-pin.js --db <database-path> <new-pin>');
  console.error('The target database must be explicit and the PIN must be at least 4 digits.');
  process.exit(1);
}
if (pin === '1234') {
  console.error('The factory default PIN 1234 is not allowed. The app flags it for replacement anyway — pick another.');
  process.exit(1);
}

const dbPath = path.resolve(dbArg);
if (!fs.existsSync(dbPath) || !fs.statSync(dbPath).isFile()) {
  console.error(`Shop database not found: ${dbPath}`);
  process.exit(1);
}

const db = new DatabaseSync(dbPath);
let failure;
try {
  db.exec('BEGIN IMMEDIATE');
  try {
    const initialized = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'shop_settings'").get();
    if (!initialized) throw new Error('Target is not an initialized shop database (shop_settings is missing)');
    db.prepare("INSERT OR REPLACE INTO shop_settings (key, value) VALUES ('manager_pin_hash', ?)").run(hashPin(pin));
    db.prepare("INSERT OR REPLACE INTO shop_settings (key, value) VALUES ('pin_failed_attempts', '0')").run();
    db.prepare("INSERT OR REPLACE INTO shop_settings (key, value) VALUES ('pin_lockout_until', '0')").run();
    db.prepare("INSERT OR REPLACE INTO shop_settings (key, value) VALUES ('report_pin_failed_attempts', '0')").run();
    db.prepare("INSERT OR REPLACE INTO shop_settings (key, value) VALUES ('report_pin_lockout_until', '0')").run();
    db.prepare("INSERT OR REPLACE INTO shop_settings (key, value) VALUES ('report_token', ?)").run(crypto.randomBytes(32).toString('hex'));
    db.prepare("INSERT OR REPLACE INTO shop_settings (key, value) VALUES ('report_token_expires_at', ?)").run(String(Date.now() + 24 * 60 * 60 * 1000));
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    throw error;
  }
} catch (error) {
  failure = error;
} finally {
  db.close();
}

if (failure) {
  console.error(`Manager PIN was not changed: ${failure.message}`);
  process.exit(1);
}

console.log(`[ok] Manager PIN updated transactionally in ${dbPath}`);
console.log('Failed-attempt counter and lockout cleared. Logged-in report phones were revoked and must re-login.');
