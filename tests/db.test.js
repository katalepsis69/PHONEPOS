// phone-repair-pos/tests/db.test.js
const assert = require('node:assert');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { dbTest } = require('./helper');
const { initDb, isReleaseShaped, isProgramFilesPath, getBaseDir, resolveBaseDir } = require('../src/db');

dbTest('initDb creates all required tables in SQLite', (db) => {
  assert.ok(db, 'Database instance should be returned');

  // Verify inventory table
  const invTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='inventory'").get();
  assert.strictEqual(invTable.name, 'inventory');

  const invCols = db.prepare('PRAGMA table_info(inventory)').all().map(c => c.name);
  assert.ok(invCols.includes('supplier'), 'inventory should have supplier');
  assert.ok(invCols.includes('location'), 'inventory should have location');
  assert.ok(invCols.includes('archived'), 'inventory should have archived');

  const movesTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='stock_movements'").get();
  assert.strictEqual(movesTable.name, 'stock_movements');
  const moveCols = db.prepare('PRAGMA table_info(stock_movements)').all().map(c => c.name);
  ['inventory_id', 'delta', 'reason', 'note', 'ref', 'created_at'].forEach(c =>
    assert.ok(moveCols.includes(c), `stock_movements should have ${c}`));

  // Verify sales table and new columns
  const salesTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sales'").get();
  assert.strictEqual(salesTable.name, 'sales');

  const salesCols = db.prepare("PRAGMA table_info(sales)").all().map(c => c.name);
  assert.ok(salesCols.includes('customer_name'), 'sales should have customer_name');
  assert.ok(salesCols.includes('customer_phone'), 'sales should have customer_phone');
  assert.ok(salesCols.includes('payment_reference'), 'sales should have payment_reference');
  assert.ok(salesCols.includes('credit_balance'), 'sales should have credit_balance');

  // Verify sale_items table and item_type column
  const saleItemsCols = db.prepare("PRAGMA table_info(sale_items)").all().map(c => c.name);
  assert.ok(saleItemsCols.includes('item_type'), 'sale_items should have item_type column');

  // Verify warranty_returns table
  const returnsTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='warranty_returns'").get();
  assert.strictEqual(returnsTable.name, 'warranty_returns');

  const returnCols = db.prepare("PRAGMA table_info(warranty_returns)").all().map(c => c.name);
  assert.ok(returnCols.includes('return_code'));
  assert.ok(returnCols.includes('return_type'));
  assert.ok(returnCols.includes('return_reason'));

  // Verify credit_payments table
  const creditPaymentsTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='credit_payments'").get();
  assert.strictEqual(creditPaymentsTable.name, 'credit_payments');

  // Verify shop_settings table and defaults
  const settingsTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='shop_settings'").get();
  assert.strictEqual(settingsTable.name, 'shop_settings');

  const settings = db.prepare("SELECT key, value FROM shop_settings").all();
  const settingsMap = Object.fromEntries(settings.map(s => [s.key, s.value]));
  assert.strictEqual(settingsMap.receipt_paper_width, '80mm');
  assert.strictEqual(settingsMap.warranty_days, '7');
  assert.ok(settingsMap.warranty_policy_text.includes('Warranty'));
});

dbTest('initDb indexes the daily-aggregate date scans', (db) => {
  const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map(r => r.name);
  assert.ok(indexes.includes('idx_sales_created_at'));
  assert.ok(indexes.includes('idx_credit_payments_created_at'));
  assert.ok(indexes.includes('idx_returns_created_at'));
  assert.ok(indexes.includes('idx_sale_items_sale_id'));
  // The dashboard's date filter (with its sargable narrowing range) must plan
  // as an index seek, not a full table scan.
  const plan = db.prepare("EXPLAIN QUERY PLAN SELECT count(*) FROM sales WHERE date(created_at, 'localtime') = date('now', 'localtime') AND created_at >= datetime('now', '-2 days')").all();
  assert.ok(JSON.stringify(plan).includes('idx_sales_created_at'), 'dashboard date filter should use the created_at index');
});

// Legacy DB: old schema (no supplier/location/archived, no movements table).
// initDb must migrate it and backfill one opening_balance per stocked part.
test('initDb migrates a legacy DB and backfills the ledger, idempotently', () => {
  const dbPath = path.join(__dirname, `t_legacy_migration_${process.pid}.db`);
  const scrub = p => [p, `${p}-shm`, `${p}-wal`].forEach(f => { try { fs.rmSync(f, { force: true }); } catch {} });
  scrub(dbPath);
  try {
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`
      CREATE TABLE inventory (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        brand TEXT NOT NULL, model_name TEXT NOT NULL, part_type TEXT NOT NULL,
        sku_barcode TEXT UNIQUE,
        cost_price REAL NOT NULL DEFAULT 0.0, price_retail REAL NOT NULL DEFAULT 0.0, price_technician REAL NOT NULL DEFAULT 0.0,
        stock_quantity INTEGER NOT NULL DEFAULT 0, min_stock_alert INTEGER NOT NULL DEFAULT 3,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    legacy.prepare(`INSERT INTO inventory (brand, model_name, part_type, stock_quantity) VALUES ('Apple', 'iPhone 11', 'LCD', 7)`).run();
    legacy.prepare(`INSERT INTO inventory (brand, model_name, part_type, stock_quantity) VALUES ('Samsung', 'S20', 'LCD', 0)`).run();
    legacy.close();

    const db = initDb(dbPath);
    const cols = db.prepare('PRAGMA table_info(inventory)').all().map(c => c.name);
    assert.ok(cols.includes('supplier'));
    assert.ok(cols.includes('location'));
    assert.ok(cols.includes('archived'));
    assert.strictEqual(db.prepare('SELECT archived FROM inventory WHERE id = 1').get().archived, 0);

    // One backfill row for the stocked part; the zero-stock part gets none.
    const moves = db.prepare('SELECT inventory_id, delta, reason FROM stock_movements').all();
    assert.strictEqual(moves.length, 1);
    assert.strictEqual(moves[0].inventory_id, 1);
    assert.strictEqual(moves[0].delta, 7);
    assert.strictEqual(moves[0].reason, 'opening_balance');
    db.close();

    // Re-running initDb adds no second backfill row.
    const db2 = initDb(dbPath);
    assert.strictEqual(db2.prepare('SELECT COUNT(*) AS n FROM stock_movements').get().n, 1);
    db2.close();
  } finally {
    scrub(dbPath);
  }
});

test('initDb normalizes legacy barcodes and enforces case-insensitive uniqueness', () => {
  const dbPath = path.join(__dirname, `t_barcode_migration_${process.pid}.db`);
  const scrub = p => [p, `${p}-shm`, `${p}-wal`].forEach(f => { try { fs.rmSync(f, { force: true }); } catch {} });
  scrub(dbPath);
  try {
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`CREATE TABLE inventory (
      id INTEGER PRIMARY KEY AUTOINCREMENT, brand TEXT NOT NULL, model_name TEXT NOT NULL, part_type TEXT NOT NULL,
      sku_barcode TEXT UNIQUE, cost_price REAL NOT NULL DEFAULT 0, price_retail REAL NOT NULL DEFAULT 0,
      price_technician REAL NOT NULL DEFAULT 0, stock_quantity INTEGER NOT NULL DEFAULT 0,
      min_stock_alert INTEGER NOT NULL DEFAULT 3, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    legacy.prepare("INSERT INTO inventory (brand, model_name, part_type, sku_barcode) VALUES ('A','B','C',' mixed-Sku ')").run();
    legacy.close();
    const db = initDb(dbPath);
    assert.strictEqual(db.prepare('SELECT sku_barcode FROM inventory').get().sku_barcode, 'MIXED-SKU');
    assert.throws(() => db.prepare("INSERT INTO inventory (brand, model_name, part_type, sku_barcode) VALUES ('D','E','F','mixed-sku')").run(), /UNIQUE/);
    db.close();
  } finally { scrub(dbPath); }
});

test('initDb surfaces audit hash backfill failures', () => {
  const dbPath = path.join(__dirname, `t_audit_failure_${process.pid}.db`);
  const scrub = p => [p, `${p}-shm`, `${p}-wal`].forEach(f => { try { fs.rmSync(f, { force: true }); } catch {} });
  scrub(dbPath);
  try {
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`
      CREATE TABLE audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        actor_type TEXT NOT NULL, actor_id INTEGER, actor_name TEXT NOT NULL DEFAULT '',
        category TEXT NOT NULL, action TEXT NOT NULL, detail TEXT, elevated INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO audit_log (actor_type, actor_name, category, action) VALUES ('manager','Manager','system','legacy');
      CREATE TRIGGER force_hash_failure BEFORE UPDATE OF row_hash ON audit_log
      BEGIN SELECT RAISE(ABORT, 'forced hash failure'); END;
    `);
    legacy.close();
    assert.throws(() => initDb(dbPath), /forced hash failure/);
  } finally { scrub(dbPath); }
  assert.ok(!fs.existsSync(dbPath), 'initDb left its handle open; the temp db could not be deleted');
});

test('a release folder is never chosen as the data home', () => {
  const dbSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'db.js'), 'utf8');
  const win = (...parts) => parts.join('\\');
  assert.equal(isReleaseShaped(win('C:', 'TechParts', 'release', 'customer')), true);
  assert.equal(isReleaseShaped('/home/shop/release'), true);
  assert.equal(isReleaseShaped(path.join(__dirname, '..', 'release', 'customer')), true);
  // publish\ is the handoff folder publish.bat stages dated executables into and
  // the one the operator is told to copy a file out of (docs section 1), so it is
  // release-shaped in exactly the same sense: an exe run from there used to create
  // data\, backups\, a browser profile and its log beside the artifacts, and the
  // next staged copy carried the previous shop's live rows.
  assert.equal(isReleaseShaped(win('C:', 'TechParts', 'publish')), true);
  assert.equal(isReleaseShaped(win('C:', 'TechParts', 'publish', 'x64')), true);
  assert.equal(isReleaseShaped('/home/shop/publish'), true);
  assert.equal(isReleaseShaped(path.join(__dirname, '..', 'publish')), true,
    'this repo\'s own publish folder must not read as a data home');
  assert.equal(isReleaseShaped(win('C:', 'TechParts', 'dist')), false);
  assert.equal(isReleaseShaped(win('C:', 'TechParts', 'release-notes')), false);
  // Only a whole path segment counts, so a folder that merely starts with the word
  // stays a valid base.
  assert.equal(isReleaseShaped(win('C:', 'TechParts', 'published-apps')), false);
  assert.equal(isReleaseShaped(win('C:', 'TechParts', 'publishers')), false);
  assert.equal(isReleaseShaped(path.join(__dirname, '..')), false, 'the dev tree stays a valid base');
  // getBaseDir consults it alongside the writability probe.
  assert.match(dbSource, /if \(isReleaseShaped\(base\) \|\| !isDirWritable\(base\)\)/);
});

// The 2026-11-09 audit: startup repair writes (SKU collision rename, opening
// balance backfill) used to bypass the sync outbox, so on an already-paired
// shop the renamed loser and a pre-pairing part's opening balance never
// reached the cloud mirror. ensureSyncTables now runs before the repairs and
// both write paths enqueue their rows.
test('startup repairs enqueue their rows into the sync outbox', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 't_db_repair_'));
  const dbPath = path.join(tmp, 'shop.db');
  try {
    // First open: schema only (fresh installs seed no parts).
    const db1 = initDb(dbPath);
    db1.close();
    // Legacy shape: the migration's dupRows query folds UPPER(TRIM(sku)), so
    // a trailing-space twin is the collision case it exists for (the column's
    // own NOCASE UNIQUE rejects a pure case twin on the current schema).
    const raw = new DatabaseSync(dbPath);
    raw.prepare(`INSERT INTO inventory (brand, model_name, part_type, sku_barcode, stock_quantity) VALUES ('A', 'M1', 'LCD', 'abc123', 5)`).run();
    raw.prepare(`INSERT INTO inventory (brand, model_name, part_type, sku_barcode, stock_quantity) VALUES ('B', 'M2', 'Battery', 'ABC123 ', 3)`).run();
    raw.close();

    const db2 = initDb(dbPath);
    const renamed = db2.prepare("SELECT id, sku_barcode FROM inventory WHERE sku_barcode LIKE 'ABC123-%'").all();
    assert.strictEqual(renamed.length, 1, 'exactly one colliding row is renamed with an id suffix');
    const outboxInv = db2.prepare("SELECT COUNT(*) AS c FROM sync_outbox WHERE table_name = 'inventory' AND local_id = ?").get(renamed[0].id);
    assert.strictEqual(outboxInv.c, 1, 'the renamed SKU must ride the outbox');

    const mv = db2.prepare("SELECT id FROM stock_movements WHERE reason = 'opening_balance'").all();
    assert.strictEqual(mv.length, 2, 'both parts got an opening balance');
    const outboxMv = db2.prepare("SELECT COUNT(*) AS c FROM sync_outbox WHERE table_name = 'stock_movements'").get().c;
    assert.strictEqual(outboxMv, mv.length, 'every backfilled opening balance must ride the outbox');
    db2.close();
  } finally {
    // WAL mode leaves -shm/-wal siblings behind and Windows can hold them a
    // beat after close(): best-effort per-file scrub, same as helper.js.
    for (const f of [dbPath, `${dbPath}-shm`, `${dbPath}-wal`, `${dbPath}-journal`]) {
      try { fs.rmSync(f, { force: true, maxRetries: 5, retryDelay: 25 }); } catch {}
    }
    try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }); } catch {}
  }
});

test('isProgramFilesPath detects Program Files directories case-insensitively', () => {
  assert.equal(isProgramFilesPath('C:\\Program Files\\TechPartsPOS'), true);
  assert.equal(isProgramFilesPath('C:\\Program Files (x86)\\TechPartsPOS'), true);
  assert.equal(isProgramFilesPath('c:\\program files\\TechPartsPOS'), true);
  assert.equal(isProgramFilesPath('/opt/program files/TechPartsPOS'), true);
  assert.equal(isProgramFilesPath('C:\\Users\\sloth\\Desktop\\dist'), false);
  assert.equal(isProgramFilesPath('C:\\TechPartsPOS'), false);
  assert.equal(isProgramFilesPath('C:\\Program Files Extra\\TechPartsPOS'), false);
  assert.equal(isProgramFilesPath(null), false);
  assert.equal(isProgramFilesPath(''), false);
});

test('getBaseDir and resolveBaseDir route Program Files installs to ProgramData\\TechPartsPOS', () => {
  const customProgramData = path.join(os.tmpdir(), 't_fake_program_data');
  const expectedTarget = path.join(customProgramData, 'TechPartsPOS');

  const resolved64 = resolveBaseDir({
    execDir: 'C:\\Program Files\\TechPartsPOS',
    programData: customProgramData
  });
  assert.equal(resolved64, expectedTarget);

  const resolvedX86 = resolveBaseDir({
    execDir: 'C:\\Program Files (x86)\\TechPartsPOS',
    programData: customProgramData
  });
  assert.equal(resolvedX86, expectedTarget);

  // Calling getBaseDir with options resolves cleanly without mutating cachedBaseDir
  const viaGetBaseDir = getBaseDir({
    execDir: 'C:\\Program Files\\TechPartsPOS',
    programData: customProgramData
  });
  assert.equal(viaGetBaseDir, expectedTarget);

  // Calling getBaseDir without options returns the unpolluted process cachedBaseDir
  const defaultBase = getBaseDir();
  assert.ok(typeof defaultBase === 'string' && defaultBase.length > 0);
  assert.notEqual(defaultBase, expectedTarget);
});

test('mirror-backups script prefers ProgramData over LOCALAPPDATA when shop.db exists', () => {
  const { spawnSync } = require('node:child_process');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 't_mirror_routing_'));
  const fakeProgramData = path.join(tmpRoot, 'ProgramData');
  const fakeLocalAppData = path.join(tmpRoot, 'LocalAppData');
  const mirrorDest = path.join(tmpRoot, 'mirror_dest');

  try {
    fs.mkdirSync(path.join(fakeProgramData, 'TechPartsPOS', 'data'), { recursive: true });
    fs.mkdirSync(path.join(fakeProgramData, 'TechPartsPOS', 'backups'), { recursive: true });
    fs.mkdirSync(path.join(fakeLocalAppData, 'TechPartsPOS', 'data'), { recursive: true });
    fs.mkdirSync(path.join(fakeLocalAppData, 'TechPartsPOS', 'backups'), { recursive: true });
    fs.mkdirSync(mirrorDest, { recursive: true });

    // Put a dummy shop.db in both fake ProgramData and fake LocalAppData
    fs.writeFileSync(path.join(fakeProgramData, 'TechPartsPOS', 'data', 'shop.db'), 'fake-program-data-db');
    fs.writeFileSync(path.join(fakeLocalAppData, 'TechPartsPOS', 'data', 'shop.db'), 'fake-local-app-data-db');

    // Run mirror-backups.js with ProgramData and LOCALAPPDATA pointing to temp dirs, POS_BACKUP_DIR unset
    const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'mirror-backups.js')], {
      encoding: 'utf8',
      env: {
        ...process.env,
        POS_BACKUP_DIR: '',
        POS_BACKUP_MIRROR: mirrorDest,
        ProgramData: fakeProgramData,
        ALLUSERSPROFILE: fakeProgramData,
        LOCALAPPDATA: fakeLocalAppData
      }
    });

    // The script should target fakeProgramData\TechPartsPOS\backups (which has no backups yet, so fails on max age)
    const expectedSource = path.join(fakeProgramData, 'TechPartsPOS', 'backups');
    assert.match(r.stderr, new RegExp(expectedSource.replace(/\\/g, '\\\\')));
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
