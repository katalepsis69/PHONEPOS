// tests/remediation-final.test.js
// Behavioral coverage for the 2026-09-27 final remediation batch: payment-ref
// requirement, void-after-credit-refund wording, sold-part delete 409,
// op_id idempotency (settlements + returns), mirror completeness, outbox
// policy while sync is off, localtime backup guard, and the cloud /sync
// auth-before-parse + budget.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { dbTest } = require('./helper');
const { initDb } = require('../src/db');
const { createSale, voidSale } = require('../src/sales');
const { deleteInventoryItem } = require('../src/inventory');
const { createWarrantyReturn } = require('../src/returns');
const { settleCustomerCredit, setCustomerCreditLimit } = require('../src/credits');
const { closeDay } = require('../src/reconcile');
const { drainOutbox, enqueueCustomerProfile } = require('../src/sync');
const { runDailyBackup } = require('../src/server');
const { validateSyncUrl, validateSyncUrlHost } = require('../src/settings');

const ctxMgr = { actor: { type: 'manager', id: 1, name: 'Manager' }, elevated: true };
const SALE = { inventory_id: 1, quantity: 1, unit_price: 50.0 };

function seedPart(db) {
  return db.prepare(`
    INSERT INTO inventory (brand, model_name, part_type, cost_price, price_retail, price_technician, stock_quantity)
    VALUES ('TestBrand', 'Screen', 'LCD', 20.0, 50.0, 40.0, 10)
  `).run();
}
function stockOf(db, id) {
  return db.prepare('SELECT stock_quantity AS s FROM inventory WHERE id = ?').get(id).s;
}

test('gcash and transfer sales require a payment reference; cash does not', () => {
  const dbPath = path.join(os.tmpdir(), `t_ref_${process.pid}.db`);
  for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) fs.rmSync(f, { force: true });
  const db = initDb(dbPath);
  try {
    seedPart(db);
    assert.throws(() => createSale(db, { payment_method: 'gcash', items: [SALE], amount_paid: 50 }), /ref # is required/i);
    assert.throws(() => createSale(db, { payment_method: 'transfer', items: [SALE], amount_paid: 50 }), /ref # is required/i);
    const sale = createSale(db, { payment_method: 'gcash', payment_reference: 'GC-777', items: [SALE], amount_paid: 50 });
    assert.strictEqual(sale.payment_reference, 'GC-777');
    createSale(db, { payment_method: 'cash', items: [SALE], amount_paid: 50 });
  } finally { db.close(); for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) fs.rmSync(f, { force: true }); }
});

dbTest('void after a credit refund names the RMA instead of claiming settled', (db) => {
  const r = seedPart(db);
  const sale = createSale(db, {
    customer_name: 'RMA Void', payment_method: 'credit', items: [SALE], amount_paid: 0
  }, ctxMgr);
  const rma = createWarrantyReturn(db, {
    sale_id: sale.id, sale_item_id: sale.items[0].id, return_type: 'credit_refund', refund_amount: 20.0
  }, ctxMgr);
  const err = (() => { try { voidSale(db, sale.id, 'changed mind', ctxMgr); } catch (e) { return e; } return null; })();
  assert.ok(err, 'void must be refused');
  assert.match(err.message, new RegExp(rma.return_code), 'error names the RMA code');
  assert.doesNotMatch(err.message, /settled/i);
});

dbTest('deleting a sold part answers 409 and points at archive', (db) => {
  seedPart(db);
  const sale = createSale(db, { payment_method: 'cash', items: [SALE], amount_paid: 50 });
  const err = (() => { try { deleteInventoryItem(db, SALE.inventory_id, ctxMgr); } catch (e) { return e; } return null; })();
  assert.ok(err, 'delete must be refused');
  assert.strictEqual(err.statusCode, 409);
  assert.match(err.message, /archive/i);
});

dbTest('settlement op_id replay returns the same state and records one payment', (db) => {
  seedPart(db);
  createSale(db, { customer_name: 'Op Settle', payment_method: 'credit', items: [SALE], amount_paid: 0 }, ctxMgr);
  const body = { customer_name: 'Op Settle', amount_paid: 20, payment_method: 'cash', op_id: 'settle-op-1' };
  const first = settleCustomerCredit(db, { ...body }, ctxMgr);
  const replay = settleCustomerCredit(db, { ...body }, ctxMgr);
  const rows = db.prepare("SELECT COUNT(*) AS c FROM credit_payments WHERE customer_name = 'Op Settle'").get().c;
  assert.strictEqual(rows, 1, 'only one payment row exists');
  assert.strictEqual(replay.total_credit_balance, first.total_credit_balance, 'replay returns the settled state');
  // A different op_id is a genuinely new payment and must go through.
  settleCustomerCredit(db, { ...body, op_id: 'settle-op-2' }, ctxMgr);
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS c FROM credit_payments WHERE customer_name = 'Op Settle'").get().c, 2);
});

dbTest('return op_id replay returns the same RMA and draws stock once', (db) => {
  seedPart(db);
  const sale = createSale(db, { payment_method: 'cash', items: [SALE], amount_paid: 50 });
  const afterSell = stockOf(db, SALE.inventory_id);
  const body = { sale_id: sale.id, sale_item_id: sale.items[0].id, return_type: 'replacement', op_id: 'rma-op-1' };
  const first = createWarrantyReturn(db, { ...body }, ctxMgr);
  const replay = createWarrantyReturn(db, { ...body }, ctxMgr);
  assert.strictEqual(replay.return_code, first.return_code, 'replay returns the original RMA');
  const rows = db.prepare('SELECT COUNT(*) AS c FROM warranty_returns').get().c;
  assert.strictEqual(rows, 1);
  assert.strictEqual(stockOf(db, SALE.inventory_id), afterSell - 1, 'replacement stock drawn exactly once');
});

dbTest('day close enqueues the reconciliation row to the mirror', (db) => {
  seedPart(db);
  createSale(db, { payment_method: 'cash', items: [SALE], amount_paid: 50 });
  const today = db.prepare("SELECT date('now','localtime') AS d").get().d;
  closeDay(db, today, 50, ctxMgr);
  const row = db.prepare("SELECT COUNT(*) AS c FROM sync_outbox WHERE table_name = 'day_reconciliations'").get();
  assert.strictEqual(row.c, 1, 'day_reconciliations rides the outbox');
});

dbTest('customer profile mirror omits notes and keys on rowid', (db) => {
  setCustomerCreditLimit(db, 'Profile Notes Check', 500, 'owes me a favor', ctxMgr);
  enqueueCustomerProfile(db, 'Profile Notes Check');
  const outbox = db.prepare("SELECT payload FROM sync_outbox WHERE table_name = 'customer_profiles' ORDER BY id DESC LIMIT 1").get();
  assert.ok(outbox, 'profile row enqueued');
  const payload = JSON.parse(outbox.payload);
  assert.strictEqual(payload.notes, undefined, 'notes never leave the shop');
  assert.ok(Number.isSafeInteger(payload.id), 'rowid rides as local id');
  assert.strictEqual(payload.credit_limit, 500);
});

dbTest('with sync off, outbox rows older than 30 days are pruned and recent rows stay', async (db) => {
  seedPart(db);
  createSale(db, { payment_method: 'cash', items: [SALE], amount_paid: 50 });
  // Backdate the sales snapshot; the sale_items snapshots stay recent.
  db.prepare("UPDATE sync_outbox SET created_at = datetime('now', '-45 days') WHERE table_name = 'sales'").run();
  const r = await drainOutbox(db); // no sync_url configured
  assert.deepStrictEqual(r, { skipped: true, reason: 'no sync_url' });
  const old = db.prepare("SELECT COUNT(*) AS c FROM sync_outbox WHERE created_at < datetime('now', '-30 days')").get().c;
  assert.strictEqual(old, 0, 'rows older than 30 days are gone');
  const recent = db.prepare("SELECT COUNT(*) AS c FROM sync_outbox WHERE table_name = 'sale_items'").get().c;
  assert.ok(recent > 0, 'recent rows survive');
});

dbTest('daily backup guard and filename use the shop-local date', (db) => {
  const backupDir = path.join(os.tmpdir(), `t_backup_local_${process.pid}`);
  fs.rmSync(backupDir, { recursive: true, force: true });
  try {
    const dbPath = path.join(os.tmpdir(), `t_backup_local_db_${process.pid}.db`);
    const backed = runDailyBackup(db, dbPath, backupDir);
    assert.ok(backed, 'first run creates a snapshot');
    const localToday = db.prepare("SELECT date('now','localtime') AS d").get().d;
    assert.strictEqual(path.basename(backed), `shop-${localToday}.db`);
    assert.strictEqual(db.prepare("SELECT value FROM shop_settings WHERE key = 'last_backup_date'").get().value, localToday);
    assert.strictEqual(runDailyBackup(db, dbPath, backupDir), null, 'same local day does not re-backup');
  } finally { fs.rmSync(backupDir, { recursive: true, force: true }); }
});

test('validateSyncUrl keeps rejecting non-https and private literals; unresolvable host warns', async () => {
  assert.throws(() => validateSyncUrl('http://example.com'), /https/);
  assert.throws(() => validateSyncUrl('https://192.168.1.10'), /private/);
  assert.doesNotThrow(() => validateSyncUrl('https://pos.example.com'));
  const warning = await validateSyncUrlHost('https://definitely-not-a-real-host-6f3.invalid');
  assert.ok(warning && /could not be resolved/.test(warning), 'failed lookup saves with a warning');
});

// --- cloud: auth-before-parse, request budget, new mirror tables ------------
const ROOT = path.join(__dirname, '..');
const CLOUD_SERVER = path.join(ROOT, 'cloud', 'server.js');
const TOKEN_A = 'a'.repeat(64);

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(err => err ? reject(err) : resolve(port));
    });
  });
}
function waitForServer(child) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`cloud server timeout: ${output}`)), 8000);
    const onData = chunk => {
      output += chunk;
      // PORT=0: the kernel picks the port and the boot line reports it, so no
      // reserve-then-release race against parallel test files.
      const m = output.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/);
      if (output.includes('Cloud sync service listening') && m) { clearTimeout(timer); resolve(`http://127.0.0.1:${m[1]}`); }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`cloud server exited ${code}: ${output}`)); });
  });
}
async function startCloud(dataDir, extraEnv = {}) {
  const child = spawn(process.execPath, [CLOUD_SERVER], {
    cwd: ROOT,
    env: { ...process.env, PORT: '0', HOST: '127.0.0.1', DATA_DIR: dataDir, SHOP_SYNC_CREDENTIALS: JSON.stringify({ north: TOKEN_A }), ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const baseUrl = await waitForServer(child);
  return { child, baseUrl };
}
async function postSync(baseUrl, token, body) {
  return fetch(`${baseUrl}/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { 'x-sync-token': token } : {}) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

test('cloud /sync: 401 precedes parsing, budget answers 429, profile rows without notes are accepted', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-final-'));
  const { child, baseUrl } = await startCloud(dataDir);
  try {
    // Wrong credential + a 2MB body: must answer 401, not hang or parse first.
    const big = 'x'.repeat(2 * 1024 * 1024);
    const unauthorized = await postSync(baseUrl, 'wrong-token', { shop_id: 'north', events: [], pad: big });
    assert.strictEqual(unauthorized.status, 401);

    // New mirror tables ride the same endpoint (notes never leaves the shop).
    const now = new Date().toISOString();
    const events = [
      { outbox_id: 1, table: 'customer_profiles', local_id: 1, deleted: false,
        row: { id: 1, customer_name: 'Cloud Buyer', credit_limit: 300, created_at: now, updated_at: now } },
      { outbox_id: 2, table: 'day_reconciliations', local_id: 1, deleted: false,
        row: { id: 1, day: '2026-09-27', counted_cash: 500, expected_cash: 500, variance: 0, buckets: '{}', status: 'balanced', created_at: now } },
      { outbox_id: 3, table: 'cash_adjustments', local_id: 1, deleted: false,
        row: { id: 1, amount: -50, reason: 'void after close', created_at: now } },
    ];
    const ok = await postSync(baseUrl, TOKEN_A, { shop_id: 'north', events });
    assert.strictEqual(ok.status, 200);
    const ack = await ok.json();
    assert.deepStrictEqual(ack.ok_ids, [1, 2, 3], 'all three new tables accepted');

    // Budget: 130 rapid posts from one client must trip the fixed window.
    let saw429 = false;
    for (let i = 0; i < 130; i++) {
      const res = await postSync(baseUrl, TOKEN_A, { shop_id: 'north', events: [] });
      await res.arrayBuffer().catch(() => {});
      if (res.status === 429) { saw429 = true; break; }
    }
    assert.ok(saw429, 'sync budget answers 429 under a flood of requests');
  } finally {
    child.kill();
    await new Promise(resolve => {
      if (child.exitCode !== null) return resolve();
      child.once('exit', resolve);
      setTimeout(resolve, 2000);
    });
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
