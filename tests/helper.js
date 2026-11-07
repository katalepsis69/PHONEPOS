// phone-repair-pos/tests/helper.js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { initDb } = require('../src/db');

// This machine's counter has a real printer attached, so "never print from a
// test" has to be a property of the harness, not a lucky coincidence in the
// bodies the suite happens to post. Every serverTest database starts with
// printer_name set to a queue name that CANNOT exist: '<', '>' and '|' are
// illegal in a Windows printer name, so no enumeration can ever return this
// string and OpenPrinter can ever resolve it.
//
// That single seed closes the whole route, because src/server.js picks the
// target as `settings.printer_name || defaultPrinter((await listPrinters())
// .printers)`: a configured queue short-circuits, so a test never enumerates
// onto a live queue and never asks Windows which printer the shop owns, and the
// only handle sendRaw can open is this dead one. Which also makes the
// 200 / ok:false / fallback:true branch testable for the first time.
const SENTINEL_PRINTER_NAME = 'ZZ TEST SENTINEL NOT A QUEUE <>|';

// Belt, for the one shape the seed cannot cover: a test that deliberately
// clears or overwrites printer_name would otherwise hand the route a real queue
// name. sendRaw is refused anything but the sentinel, so no request from the
// suite can put bytes into a live queue no matter what the settings say. The
// sentinel itself still travels the real transport, because the dead handle is
// the answer the print route is supposed to give.
// src/server.js reads this off the module object at the call site
// (printer.sendRaw(...)), so the patch is seen whatever the require order of the
// test files is; tests/printer.test.js proves it fires.
const printer = require('../src/printer');
const realSendRaw = printer.sendRaw;
printer.sendRaw = async (printerName, bytes) => {
  if (printerName !== SENTINEL_PRINTER_NAME) {
    throw new Error(`test refused to open printer queue '${printerName}'`);
  }
  return realSendRaw(printerName, bytes);
};

// Fresh databases have no printer_name row at all, so the seed is written
// here rather than in db.js: production never sees it.
function seedSentinelPrinter(db) {
  db.prepare('INSERT OR REPLACE INTO shop_settings (key, value) VALUES (?, ?)').run('printer_name', SENTINEL_PRINTER_NAME);
}

// WAL mode leaves -shm/-wal siblings behind, and a killed run can leave a
// -journal, so scrub all four.
function scrub(dbPath) {
  for (const f of [dbPath, `${dbPath}-shm`, `${dbPath}-wal`, `${dbPath}-journal`]) {
    try {
      if (fs.existsSync(f)) {
        fs.rmSync(f, { force: true, maxRetries: 5, retryDelay: 25 });
      }
    } catch {}
  }
}

// A run that is KILLED never reaches the scrub in a test's finally, so its
// t_*.db survived and the folder grew every run (~80 files by 2026-10-14). Sweep
// what is provably stale at load time: anything over an hour old cannot belong to
// a live parallel test process (a run takes seconds), so removing it is safe.
function sweepStaleTestDbs() {
  try {
    const cutoff = Date.now() - 60 * 60 * 1000;
    for (const f of fs.readdirSync(__dirname)) {
      if (!/^t_.*\.db(-wal|-shm|-journal)?$/.test(f)) continue;
      const file = path.join(__dirname, f);
      try {
        if (fs.statSync(file).mtimeMs < cutoff) fs.rmSync(file, { force: true, maxRetries: 2, retryDelay: 25 });
      } catch {}
    }
  } catch {}
}
sweepStaleTestDbs();

// ponytail: db file named from the test name + pid, so parallel test files never collide
function tmpDbPath(name) {
  return path.join(__dirname, `t_${name.replace(/\W+/g, '_').slice(0, 40)}_${process.pid}.db`);
}

// Fresh SQLite file per test, removed afterwards even if the test throws.
function dbTest(name, fn) {
  test(name, async () => {
    const dbPath = tmpDbPath(name);
    scrub(dbPath);
    const db = initDb(dbPath);
    try {
      await fn(db, dbPath);
    } finally {
      db?.close();
      scrub(dbPath);
    }
  });
}

// Same reasoning as the sentinel queue name, one level up. src/server.js's
// default backup dir is the live shop's own backups/, and a test that POSTs
// /api/backup lands a real file in it -- which then sits in the owner's restore
// picker as a candidate that would install a test database over the shop's. So
// every serverTest gets a throwaway folder. A suite that has already chosen one
// through POS_BACKUP_DIR (backup-restore.test.js seeds files there and expects
// the server to read them back) keeps its own dir and this leaves it alone.
function chooseBackupDir() {
  if (process.env.POS_BACKUP_DIR) return { dir: process.env.POS_BACKUP_DIR, ours: false };
  return { dir: fs.mkdtempSync(path.join(os.tmpdir(), 't_server_backups-')), ours: true };
}

// Same, plus a live HTTP server on a random port; passes its base URL.
// Every server boots session-gated now, so the helper logs in as the manager
// (fresh DBs ship with PIN 1234) and passes ready-to-spread auth headers:
// `headers: { ...auth }` (plus 'Content-Type' where a body is sent).
function serverTest(name, fn) {
  test(name, async () => {
    const { createServer } = require('../src/server');
    const dbPath = tmpDbPath(name);
    const backups = chooseBackupDir();
    scrub(dbPath);
    const { server, db, getDb } = createServer({ dbPath, backupDir: backups.dir });
    // Before a single request: this server can only ever aim at the dead queue.
    seedSentinelPrinter(db);
    // listen(0) draws from this machine's dynamic range (1024-15000), and
    // several ports in it are ones fetch() refuses to connect to at all — the
    // test then dies with "bad port" on a server that is running fine. Keep no
    // copy of that denylist: bind, probe with a real request, rebind until the
    // port actually answers.
    for (;;) {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
          server.removeListener('error', reject);
          resolve();
        });
      });
      let usable = false;
      try {
        await fetch(`http://127.0.0.1:${server.address().port}/api/license/status`);
        usable = true;
      } catch (_) {}
      if (usable) break;
      await new Promise(resolve => server.close(resolve));
    }
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const auth = {};
    try {
      const res = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: '1234' })
      });
      if (res.ok) {
        const data = await res.json();
        auth['Authorization'] = `Bearer ${data.token}`;
        if (data.elevationToken) auth['X-Elevation'] = data.elevationToken;
      }
    } catch (_) {}
    try {
      await fn(baseUrl, db, auth);
    } finally {
      server.close();
      // A restore test swaps the server's live handle for a fresh one, so the
      // original `db` can already be closed while the replacement still holds the
      // file open. Close the live handle through getDb(), or Windows refuses the
      // scrub below and the t_*.db litter never shrinks (the defect behind ~50
      // t_restore_*.db files as of 2026-10-14).
      try { getDb?.()?.close(); } catch (_) {}
      try { db?.close(); } catch (_) {}
      scrub(dbPath);
      if (backups.ours) {
        try { fs.rmSync(backups.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }); } catch (_) {}
      }
    }
  });
}

// The factory-PIN gates (settings save, starter seeding, day close) refuse
// manager actions until 1234 is replaced. Tests that exercise those routes
// call this first; it returns auth headers carrying the new PIN's elevation.
async function ensurePinChanged(baseUrl, auth) {
  const probe = await fetch(`${baseUrl}/api/settings`, { headers: auth });
  const state = await probe.json().catch(() => ({}));
  if (!state.pin_change_required) return auth;
  const res = await fetch(`${baseUrl}/api/auth/change-pin`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ old_pin: '1234', new_pin: '4321' })
  });
  if (!res.ok) throw new Error(`ensurePinChanged: change-pin answered ${res.status}`);
  const data = await res.json();
  return { ...auth, Authorization: `Bearer ${data.token}`, 'X-Elevation': data.elevationToken };
}

module.exports = { dbTest, serverTest, SENTINEL_PRINTER_NAME, ensurePinChanged };
