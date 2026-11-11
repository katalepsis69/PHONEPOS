// tests/fix-batch-v6.test.js
// Coverage for the 2026-10-15 v6 audit batch: the protections the audit found
// implemented but unexercised, and the two idempotency holes it found open.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { serverTest, dbTest, ensurePinChanged } = require('./helper');
const { initDb } = require('../src/db');
const { getLicenseStatus } = require('../src/license');
const printer = require('../src/printer');

const REPO = 'katalepsis69/PHONEPOS';

function post(baseUrl, route, auth, body) {
  return fetch(`${baseUrl}${route}`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {})
  });
}

async function makeItem(baseUrl, auth, overrides = {}) {
  const res = await post(baseUrl, '/api/inventory', auth, {
    brand: 'Apple', model_name: 'iPhone 12', part_type: 'Battery',
    cost_price: 100, price_retail: 250, price_technician: 200, stock_quantity: 10,
    ...overrides
  });
  assert.strictEqual(res.status, 201, `item create answered ${res.status}`);
  return res.json();
}

// The audit's HIGH finding: every other test changes the factory PIN before it
// reaches these routes, so deleting one isDefaultPin(db) line kept the suite
// green. This drives all of them while 1234 is still live.
serverTest('factory PIN: every consequential route refuses while 1234 is live', async (baseUrl, db, auth) => {
  const routes = [
    ['/api/inventory/import', { rows: [{ brand: 'A', model_name: 'B', part_type: 'C' }] }],
    ['/api/inventory/bulk-edit', { ids: [1], action: 'archive' }],
    ['/api/inventory/seed-starter', {}],
    ['/api/settings/pair-cloud', { sync_url: 'https://cloud.example.com', code: '123456' }],
    ['/api/backup/restore', { file: 'shop_backup_nope.db' }],
    ['/api/settings/reset-demo', {}],
    ['/api/settings', { warranty_days: '14' }],
    ['/api/system/update/apply', { downloadUrl: `https://github.com/${REPO}/releases/download/v1.1.1/TechPartsPOS.exe` }],
    ['/api/system/shutdown', {}]
  ];
  for (const [route, body] of routes) {
    const res = await post(baseUrl, route, auth, body);
    assert.strictEqual(res.status, 403, `${route} must refuse while the factory PIN is live`);
    assert.match(String((await res.json()).error), /factory PIN|Manager authorization/i, `${route}: wrong refusal reason`);
  }

  // Elevation itself is refused too: the factory PIN cannot be used to elevate.
  const elevate = await post(baseUrl, '/api/auth/elevate', auth, { pin: '1234' });
  assert.strictEqual(elevate.status, 403, 'the factory PIN must not elevate');

  // Nothing above wrote anything: no restore, no seed, no import, no shutdown.
  const seeded = db.prepare("SELECT COUNT(*) AS c FROM inventory").get().c;
  assert.strictEqual(seeded, 0, 'a refused route still wrote to the database');
  const shutdownRow = db.prepare("SELECT COUNT(*) AS c FROM audit_log WHERE action = 'shutdown'").get().c;
  assert.strictEqual(shutdownRow, 0, 'a refused shutdown was audited as done');
});

// Print dedup and the drawer kick were both implemented and both untested: a
// lost response must not produce a second slip, and the slip's bytes must carry
// (or not carry) the drawer pulse the caller asked for.
serverTest('print route: the dedup window answers a duplicate and the drawer kick is per-request', async (baseUrl, db, auth) => {
  auth = await ensurePinChanged(baseUrl, auth);
  const captured = [];
  const original = printer.sendRaw;
  const kick = Buffer.from(printer.DRAWER_KICK);
  printer.sendRaw = async (name, bytes) => { captured.push(Buffer.from(bytes)); return { ok: true }; };
  try {
    const item = await makeItem(baseUrl, auth);
    // The server re-prices parts from the live catalog row, so the payment has
    // to cover the catalog price, not whatever unit_price the body claims.
    const makeSale = async () => {
      const res = await post(baseUrl, '/api/sales', auth, {
        customer_name: 'Print Customer', payment_method: 'cash',
        items: [{ inventory_id: item.id, quantity: 1 }],
        amount_paid: item.price_retail
      });
      assert.strictEqual(res.status, 201);
      return res.json();
    };
    const sale = await makeSale();

    const first = await post(baseUrl, '/api/print', auth, { kind: 'sale', sale_id: sale.id });
    assert.deepStrictEqual(await first.json(), { ok: true, fallback: false });
    assert.strictEqual(captured.length, 1, 'the first print must reach the queue');
    assert.ok(captured[0].includes(kick), 'a sale slip must carry the drawer pulse by default');

    // Same job again inside the window: answered, no second slip, no second pulse.
    const dup = await post(baseUrl, '/api/print', auth, { kind: 'sale', sale_id: sale.id });
    assert.deepStrictEqual(await dup.json(), { ok: true, deduplicated: true });
    assert.strictEqual(captured.length, 1, 'a duplicate print must not reach the queue again');

    // The reprint override: same job kind, drawer_kick:false, and the bytes must
    // not pulse the drawer (this is what the rail and modal reprint now send).
    const sale2 = await makeSale();
    const quiet = await post(baseUrl, '/api/print', auth, { kind: 'sale', sale_id: sale2.id, drawer_kick: false });
    assert.deepStrictEqual(await quiet.json(), { ok: true, fallback: false });
    assert.strictEqual(captured.length, 2);
    assert.ok(!captured[1].includes(kick), 'drawer_kick:false must not pulse the drawer');
  } finally {
    printer.sendRaw = original;
  }
});

// bulkEditInventory grew an op_log replay gate: a retry after a lost response
// must re-answer instead of moving every selected price a second time.
serverTest('bulk price edit: a replayed op_id does not move the price twice', async (baseUrl, db, auth) => {
  auth = await ensurePinChanged(baseUrl, auth);
  const item = await makeItem(baseUrl, auth, { price_retail: 100, price_technician: 80 });
  const body = { ids: [item.id], action: 'adjust_price', params: { target: 'both', mode: 'amount', value: 50 }, op_id: 'bulk-test-op-1' };

  const first = await post(baseUrl, '/api/inventory/bulk-edit', auth, body);
  assert.strictEqual(first.status, 200);
  assert.strictEqual((await first.json()).updated, 1);

  const replay = await post(baseUrl, '/api/inventory/bulk-edit', auth, body);
  assert.strictEqual(replay.status, 200);
  const replayBody = await replay.json();
  assert.strictEqual(replayBody.replayed, true, 'the retry must be recognized as a replay');
  assert.strictEqual(replayBody.updated, 0);

  const after = db.prepare('SELECT price_retail, price_technician FROM inventory WHERE id = ?').get(item.id);
  assert.strictEqual(after.price_retail, 150, 'the price must have moved exactly once');
  assert.strictEqual(after.price_technician, 130, 'the price must have moved exactly once');

  // A different op_id is a new intent and applies again (the escape hatch).
  const second = await post(baseUrl, '/api/inventory/bulk-edit', auth, { ...body, op_id: 'bulk-test-op-2' });
  assert.strictEqual((await second.json()).updated, 1);
  const after2 = db.prepare('SELECT price_retail FROM inventory WHERE id = ?').get(item.id);
  assert.strictEqual(after2.price_retail, 200);
});

// The sync operator surface (state + last_error + last_attempt_at + the backoff
// window) was untested; a down VPS must show up as an operator-visible error
// instead of a silent retry loop.
serverTest('sync status: a failing drain records the error and the backoff window', async (baseUrl, db, auth) => {
  auth = await ensurePinChanged(baseUrl, auth);
  // A pending outbox row, or the drain returns before it ever tries the URL.
  await makeItem(baseUrl, auth);
  // Loopback plain HTTP is allowed by validateSyncUrl, and port 9 refuses
  // immediately, so the drain fails fast without touching the network.
  const save = await post(baseUrl, '/api/settings', auth, { sync_url: 'http://127.0.0.1:9' });
  assert.strictEqual(save.status, 200);

  let status = null;
  for (let i = 0; i < 40; i++) {
    const res = await fetch(`${baseUrl}/api/sync/status`, { headers: auth });
    assert.strictEqual(res.status, 200);
    status = await res.json();
    if (status.last_error) break;
    await new Promise(r => setTimeout(r, 250));
  }
  assert.ok(status.last_error, 'a failing drain must record last_error');
  assert.ok(status.last_attempt_at, 'last_attempt_at must be stamped');
  assert.ok(status.next_attempt_in_ms > 0, 'the backoff window must be visible to the operator');
  assert.strictEqual(typeof status.pending, 'number');
  assert.strictEqual(status.state, 'attention', 'nothing synced yet and rows pending');
});

// The license anti-rollback clamp was inert because license_seen_ts was never
// written by any real deployment. It is now seeded on the first read.
dbTest('license: the anti-rollback stamp is seeded on first read', (db) => {
  const before = db.prepare("SELECT value FROM shop_settings WHERE key = 'license_seen_ts'").get();
  assert.strictEqual(before, undefined, 'a fresh database starts without the stamp');
  // Any stored key routes the read through verifyStoredKey, which stamps the
  // clamp before it verifies; a placeholder string is enough to reach it.
  db.prepare("INSERT OR REPLACE INTO shop_settings (key, value) VALUES ('license_key', ?)").run('not-a-real-key');
  getLicenseStatus(db, null);
  const after = db.prepare("SELECT value FROM shop_settings WHERE key = 'license_seen_ts'").get();
  assert.ok(after && after.value, 'the first read must seed the clamp base');
  assert.ok(Number.isFinite(Date.parse(after.value)), 'the seeded value must be a timestamp');
});

// The client-side half of the two idempotency fixes: the import op_id must be
// minted once per preview session and reused by every retry, and the bulk edit
// must send the id minted when its modal opened.
test('inventory frontend: import and bulk edit carry a retry-stable op_id', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'views', 'inventory.js'), 'utf8');
  assert.match(src, /importState = \{ rows, header, op_id: crypto\.randomUUID\(\) \}/,
    'the import preview session must mint its op_id once');
  assert.match(src, /op_id: importState\.op_id/, 'applyImport must reuse the preview session op_id');
  assert.ok(!/op_id: crypto\.randomUUID\(\),\s*\n\s*auto_price/.test(src),
    'applyImport must not mint a fresh op_id per attempt');
  assert.match(src, /bulkEditOpId = crypto\.randomUUID\(\)/, 'openBulkEditModal must mint the bulk-edit op_id');
  assert.match(src, /params, op_id: bulkEditOpId \}/, 'the bulk-edit request must send that op_id');
  assert.match(src, /data\.replayed/, 'both clients must surface a replayed answer');
});

test('main.js: F3 reaches the inventory tab and no closing signal is sent', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'main.js'), 'utf8');
  // F3 is the rail's advertised Inventory shortcut; Ctrl+F is the palette.
  assert.match(src, /if \(isCtrl && lowerKey === 'f'\) \{\s*\n\s*e\.preventDefault\(\);\s*\n\s*openSearchPalette\(\);/);
  assert.match(src, /if \(e\.key === 'F3'\) \{ e\.preventDefault\(\); switchTab\('inventory'\); return; \}/);
  // The heartbeat beacon is a plain activity ping: reload fires the same events
  // as a close, so no "closing" flag can be honest about it.
  assert.ok(!src.includes('heartbeat?closing=1'), 'the closing query param is gone');
});

// The report service worker existed with zero coverage. It is a deliberate
// pass-through (a cached report page would show stale money), so what matters is
// that it never starts caching, and that the page registers it on a secure
// origin only.
test('report service worker stays a pass-through and is registered only where it can be', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const sw = fs.readFileSync(path.join(__dirname, '..', 'public', 'report-sw.js'), 'utf8');
  assert.match(sw, /self\.addEventListener\('install', \(\) => self\.skipWaiting\(\)\)/);
  assert.match(sw, /self\.addEventListener\('fetch', \(e\) => e\.respondWith\(fetch\(e\.request\)\)\)/);
  // No cache API anywhere: a stale report is a lie.
  assert.ok(!/caches\.|CacheStorage|cache\.put/.test(sw), 'the pass-through worker must not cache');
  const report = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'report.js'), 'utf8');
  assert.match(report, /navigator\.serviceWorker\.register\('\/report-sw\.js'\)/);
});

// mirror-backups used to print PASS while mirroring the wrong folder: a
// zip-extract install keeps data beside the exe, so the repo-resolution landed
// on the checkout's stale backups. The off-machine copy the operator trusts is
// the data-loss path, so a source with no recent snapshot now fails loudly.
test('mirror-backups refuses a source with no recent snapshot', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { spawnSync } = require('node:child_process');
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 't_mirror_src-'));
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 't_mirror_dst-'));
  const run = (extraEnv = {}) => spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'mirror-backups.js')], {
    encoding: 'utf8',
    env: { ...process.env, POS_BACKUP_MIRROR: dest, POS_BACKUP_DIR: src, ...extraEnv }
  });
  try {
    // Empty source: exactly the shape that used to mirror stale files silently.
    let r = run();
    assert.strictEqual(r.status, 2, 'an empty source must fail the run');
    assert.match(r.stderr, /no snapshot newer than 30h/);

    // A snapshot from last week is still not the live install.
    const old = path.join(src, 'shop_backup_2020-01-01T00-00-00-000Z.db');
    fs.writeFileSync(old, 'not a real db');
    const longAgo = new Date(Date.now() - 100 * 3600000);
    fs.utimesSync(old, longAgo, longAgo);
    r = run();
    assert.strictEqual(r.status, 2, 'a stale snapshot must fail the run');
    assert.match(r.stderr, /no snapshot newer than 30h/);

    // The window is tunable for a shop that backs up rarely.
    r = run({ POS_BACKUP_MAX_AGE_HOURS: '720' });
    assert.ok(!/no snapshot newer than/.test(r.stderr), 'POS_BACKUP_MAX_AGE_HOURS must widen the window');

    // A fresh snapshot passes the gate (what robocopy then does is the
    // Windows-only step, asserted elsewhere).
    fs.writeFileSync(path.join(src, 'shop_2026-01-01.db'), 'not a real db');
    r = run();
    assert.ok(!/no snapshot newer than/.test(r.stderr), 'a fresh snapshot must pass the staleness gate');
  } finally {
    fs.rmSync(src, { recursive: true, force: true });
    fs.rmSync(dest, { recursive: true, force: true });
  }
});
