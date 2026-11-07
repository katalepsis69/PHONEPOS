const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { initDb } = require('../src/db');
const { serverTest } = require('./helper');
const { createDbBackup, runDailyBackup, runBackupTick, verifyBackupFile, getBackupStatus } = require('../src/server');

const scrub = p => [p, `${p}-shm`, `${p}-wal`].forEach(f => { try { fs.rmSync(f, { force: true }); } catch {} });

function withTmpDb(fn) {
  const dbPath = path.join(os.tmpdir(), `t_backup_${process.pid}_${Date.now()}.db`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-'));
  scrub(dbPath);
  try {
    const db = initDb(dbPath);
    try { return fn(db, dbPath, dir); } finally { db.close(); }
  } finally {
    scrub(dbPath);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('runDailyBackup backs up once a day and prunes stale shop- and shop_backup_ files', () => {
  withTmpDb((db, dbPath, dir) => {
    const stale = new Date('2020-01-01T00:00:00Z');
    const seed = (name, mtime) => {
      const p = path.join(dir, name);
      fs.writeFileSync(p, 'placeholder');
      fs.utimesSync(p, mtime, mtime);
      return p;
    };
    const oldDaily = seed('shop-2020-01-01.db', stale);
    const oldManual = seed('shop_backup_2020-06-01T00-00-00.db', stale);
    const stranger = seed('unrelated.db', stale);
    const freshManual = seed('shop_backup_fresh.db', new Date());

    const backupPath = runDailyBackup(db, dbPath, dir);
    assert.ok(backupPath, 'first call of the day performs a backup');
    assert.match(path.basename(backupPath), /^shop-\d{4}-\d{2}-\d{2}\.db$/);
    assert.ok(fs.existsSync(backupPath));
    assert.equal(verifyBackupFile(backupPath), true, 'published daily backup passes integrity_check');

    assert.equal(fs.existsSync(oldDaily), false, 'stale daily backup pruned');
    assert.equal(fs.existsSync(oldManual), false, 'stale manual backup pruned (F40 family)');
    assert.equal(fs.existsSync(stranger), true, 'unrelated files are left alone');
    assert.equal(fs.existsSync(freshManual), true, 'recent manual backup survives the 14-day cutoff');

    assert.equal(runDailyBackup(db, dbPath, dir), null, 'second same-day call is a no-op');
  });
});

test('verifyBackupFile accepts a real backup and rejects garbage', () => {
  withTmpDb((db, dbPath, dir) => {
    const backupPath = createDbBackup(db, dbPath, dir);
    assert.ok(fs.existsSync(backupPath));
    assert.equal(verifyBackupFile(backupPath), true);

    const junk = path.join(dir, 'junk.db');
    fs.writeFileSync(junk, 'this is not a database');
    assert.equal(verifyBackupFile(junk), false);
  });
});

test('createDbBackup refuses to publish a backup that fails verification', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-'));
  try {
    // Pretend VACUUM succeeded but wrote garbage: verify step must abort the rename.
    const fakeDb = { exec: sql => {
      const m = sql.match(/VACUUM INTO '(.+)'/);
      fs.writeFileSync(m[1], 'garbage bytes, not a database');
    } };
    assert.throws(() => createDbBackup(fakeDb, 'unused.db', dir), /verification failed/i);
    assert.equal(fs.readdirSync(dir).length, 0, 'no partial backup left behind');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('getBackupStatus reports the newest backup file and flags a stale till', () => {
  withTmpDb((db, dbPath, dir) => {
    const empty = getBackupStatus(db, dir);
    assert.equal(empty.last_backup_at, null);
    assert.equal(empty.age_hours, null);
    assert.equal(empty.stale, true, 'no backup at all is the worst case');

    runDailyBackup(db, dbPath, dir);
    const fresh = getBackupStatus(db, dir);
    assert.equal(fresh.stale, false, 'today\u2019s backup clears the warning');
    assert.ok(fresh.age_hours <= 1);

    // A manual snapshot counts the same as the automatic one.
    fs.writeFileSync(path.join(dir, 'shop_backup_manual.db'), 'x');
    assert.ok(getBackupStatus(db, dir).last_backup_at);

    // Only stale files left: overdue again, and the age is measured, not a flag.
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 3600 * 1000);
    for (const f of fs.readdirSync(dir)) fs.utimesSync(path.join(dir, f), threeDaysAgo, threeDaysAgo);
    const stale = getBackupStatus(db, dir);
    assert.equal(stale.stale, true);
    assert.ok(stale.age_hours >= 71 && stale.age_hours <= 73, `about three days (got ${stale.age_hours}h)`);
  });
});

test('getBackupStatus falls back to the recorded date when the folder is gone', () => {
  const dbPath = path.join(os.tmpdir(), `t_backup_fallback_${process.pid}.db`);
  scrub(dbPath);
  const db = initDb(dbPath);
  try {
    const missing = getBackupStatus(db, path.join(os.tmpdir(), 'no-such-backup-dir-xyz'));
    assert.equal(missing.stale, true);
    db.prepare("INSERT OR REPLACE INTO shop_settings (key, value) VALUES ('last_backup_date', ?)")
      .run(new Date().toISOString().split('T')[0]);
    assert.equal(getBackupStatus(db, path.join(os.tmpdir(), 'no-such-backup-dir-xyz')).stale, false);
  } finally { db.close(); scrub(dbPath); }
});

serverTest('dashboard carries the backup age so the browser can warn', async (baseUrl, db, auth) => {
  const data = await (await fetch(`${baseUrl}/api/dashboard?period=7d`, { headers: auth })).json();
  assert.ok(data.backup, 'backup status is part of the dashboard payload');
  // Not just "a boolean": the badge's whole job is to flip on age, so a backup
  // recorded as today must read fresh, and the same record dated into the past
  // must read stale. (The serverTest backup dir starts empty: no record means
  // stale.)
  assert.equal(data.backup.stale, true, 'no backup recorded yet must read stale');
  db.prepare("INSERT OR REPLACE INTO shop_settings (key, value) VALUES ('last_backup_date', ?)")
    .run(new Date().toISOString().split('T')[0]);
  const fresh = await (await fetch(`${baseUrl}/api/dashboard?period=7d`, { headers: auth })).json();
  assert.equal(fresh.backup.stale, false, 'a backup taken today must read fresh');
  assert.equal(typeof fresh.backup.age_hours, 'number');
});

test('the daily prune also clears interrupted VACUUM siblings', () => {
  withTmpDb((db, dbPath, dir) => {
    const stale = new Date('2020-01-01T00:00:00Z');
    const mk = (name, mtime) => {
      const p = path.join(dir, name);
      fs.writeFileSync(p, 'x');
      fs.utimesSync(p, mtime, mtime);
      return p;
    };
    const orphan = mk('shop-2020-01-01.db.tmp-4242-1577836800000', stale);
    const freshOrphan = mk(`shop-today.db.tmp-99-${Date.now()}`, new Date());
    runDailyBackup(db, dbPath, dir);
    assert.equal(fs.existsSync(orphan), false, 'an abandoned .tmp- sibling is pruned');
    assert.ok(fs.existsSync(freshOrphan), 'a sibling still being written is left alone');
    fs.rmSync(freshOrphan, { force: true });
  });
});

test('a daily-backup failure lands in pos-server.log, the only surface the exe has', () => {
  // logFilePath() answers the live path: under node --test the suite logs to a
  // per-process temp file so test failures stop polluting the shop's own log.
  const logPath = require('../src/server').logFilePath();
  const before = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
  // The GUI exe throws console output away, so the failure branch must go
  // through logLine; anything less hides backup breakage from the customer.
  runBackupTick(() => ({ prepare: () => { throw new TypeError('disk gremlins'); } }), 'unused.db');
  const logged = fs.readFileSync(logPath, 'utf8').slice(before.length);
  assert.match(logged, /Daily backup warning: disk gremlins/);
});
