// phone-repair-pos/src/db.js
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { ensureSyncTables } = require('./sync');
const { hashRow } = require('./audit');

let cachedBaseDir = null;

// A write probe beats accessSync: Windows ACLs make directory permission
// checks unreliable (a Program Files folder can report writable yet fail on
// the first create). The probe file is unlinked immediately.
function isDirWritable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.write-probe-${process.pid}`);
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return true;
  } catch (_) {
    return false;
  }
}

// A release folder must stay byte-for-byte what ships. A smoke run launched
// from release/customer/ used to create data/ and backups/ beside the exe, so
// the next copy carried a shop's live rows. Any release-shaped base is
// therefore not a data home, writable or not.
//
// `publish\` is release-shaped in exactly that sense and was missing from the
// pattern: it is the handoff folder publish.bat stages dated executables into,
// the one an operator is told to copy a file out of (docs section 1). An exe run
// from there created data\, backups\, a browser profile and its log beside
// itself, so the next staged copy carried the previous shop's rows and the
// operator's "take the database from publish\" picked up somebody else's. Only a
// whole path segment counts, so `release-notes\` and `published-apps\` stay
// valid bases, as they did before.
const isReleaseShaped = dir => /(^|[\\/])(?:release|publish)([\\/]|$)/i.test(String(dir || ''));

// Handle -> file path, for consumers that need OS-level evidence about the
// database file (license.js floors the trial clock at its birth time) and
// cannot get the path from the node:sqlite handle itself.
const DB_FILES = new WeakMap();
function getDbFile(db) {
  return DB_FILES.get(db) || null;
}

function getBaseDir() {
  if (cachedBaseDir) return cachedBaseDir;
  let base = (process.execPath && !process.execPath.toLowerCase().endsWith('node.exe'))
    ? path.dirname(process.execPath)
    : path.join(__dirname, '..');
  // The packaged exe may be dropped into a read-only location (Program Files,
  // a network share, a locked-down kiosk image). SQLite must CREATE/WAL next
  // to the data dir; a base that cannot do that fails at db-open time — the
  // worst possible spot (process alive, nothing listening, no console). Fall
  // back to a per-machine writable home instead of failing.
  if (isReleaseShaped(base) || !isDirWritable(base)) {
    const fallback = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'TechPartsPOS');
    if (isDirWritable(fallback)) base = fallback;
  }
  cachedBaseDir = base;
  return base;
}

const DEFAULT_DB_PATH = path.join(getBaseDir(), 'data', 'shop.db');

function initDb(dbFilePath = DEFAULT_DB_PATH) {
  const dir = path.dirname(dbFilePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new DatabaseSync(dbFilePath);
  DB_FILES.set(db, dbFilePath);
  // Close the handle we opened if anything below throws, so temp dbs
  // (tests, failed migrations) stay deletable on Windows.
  try {
    db.exec('PRAGMA foreign_keys = ON;');
    db.exec('PRAGMA journal_mode = WAL;');
    // A second process (relaunched exe, a DB tool, the backup script) must
    // queue behind the register's write instead of failing the sale with
    // SQLITE_BUSY on first contact.
    db.exec('PRAGMA busy_timeout = 5000;');

    // Schema creation
    db.exec(`
      CREATE TABLE IF NOT EXISTS inventory (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        brand TEXT NOT NULL,
        model_name TEXT NOT NULL,
        part_type TEXT NOT NULL,
        sku_barcode TEXT COLLATE NOCASE UNIQUE,
        cost_price REAL NOT NULL DEFAULT 0.0,
        price_retail REAL NOT NULL DEFAULT 0.0,
        price_technician REAL NOT NULL DEFAULT 0.0,
        stock_quantity INTEGER NOT NULL DEFAULT 0,
        min_stock_alert INTEGER NOT NULL DEFAULT 3,
        supplier TEXT NOT NULL DEFAULT '',
        location TEXT NOT NULL DEFAULT '',
        archived INTEGER NOT NULL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS stock_movements (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        inventory_id INTEGER NOT NULL REFERENCES inventory(id) ON DELETE CASCADE,
        delta INTEGER NOT NULL,
        reason TEXT NOT NULL,
        note TEXT DEFAULT '',
        ref TEXT DEFAULT '',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_movements_inv ON stock_movements(inventory_id, id);

      CREATE TABLE IF NOT EXISTS sales (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sale_code TEXT UNIQUE NOT NULL,
        customer_name TEXT NOT NULL DEFAULT 'Walk-in Customer',
        customer_phone TEXT DEFAULT '',
        customer_type TEXT NOT NULL DEFAULT 'retail',
        payment_method TEXT NOT NULL DEFAULT 'cash',
        payment_reference TEXT DEFAULT '',
        subtotal REAL NOT NULL,
        discount REAL NOT NULL DEFAULT 0.0,
        total_amount REAL NOT NULL,
        amount_paid REAL NOT NULL,
        change_amount REAL NOT NULL DEFAULT 0.0,
        credit_balance REAL NOT NULL DEFAULT 0.0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS sale_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sale_id INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
        inventory_id INTEGER REFERENCES inventory(id),
        item_type TEXT NOT NULL DEFAULT 'part',
        item_name TEXT NOT NULL,
        unit_cost REAL NOT NULL,
        unit_price REAL NOT NULL,
        quantity INTEGER NOT NULL,
        total_price REAL NOT NULL
      );

      CREATE TABLE IF NOT EXISTS warranty_returns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        return_code TEXT UNIQUE NOT NULL,
        sale_id INTEGER NOT NULL REFERENCES sales(id),
        sale_item_id INTEGER NOT NULL REFERENCES sale_items(id),
        customer_name TEXT NOT NULL,
        item_name TEXT NOT NULL,
        quantity INTEGER NOT NULL DEFAULT 1,
        return_type TEXT NOT NULL,
        return_reason TEXT NOT NULL,
        replacement_inventory_id INTEGER,
        refund_amount REAL NOT NULL DEFAULT 0.0,
        technician_notes TEXT DEFAULT '',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS credit_payments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        customer_name TEXT NOT NULL,
        amount_paid REAL NOT NULL,
        payment_method TEXT NOT NULL DEFAULT 'cash',
        payment_reference TEXT DEFAULT '',
        notes TEXT DEFAULT '',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS shop_settings (
        key TEXT PRIMARY KEY,
        value TEXT
      );

      -- Per-person staff logins. Soft "delete" (active=0) keeps audit_log
      -- actor_id referable forever; no hard delete exists by design.
      CREATE TABLE IF NOT EXISTS staff (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        pin_hash TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        pin_failed_attempts INTEGER NOT NULL DEFAULT 0,
        pin_lockout_until INTEGER NOT NULL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      -- Append-only action trail. Actor fields are server-derived from the
      -- verified session, never from client payloads.
      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        actor_type TEXT NOT NULL,
        actor_id INTEGER,
        actor_name TEXT NOT NULL DEFAULT '',
        category TEXT NOT NULL,
        action TEXT NOT NULL,
        detail TEXT,
        elevated INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_audit_category ON audit_log(category, id);
      CREATE INDEX IF NOT EXISTS idx_audit_actor_name ON audit_log(actor_name, id);
      CREATE TRIGGER IF NOT EXISTS audit_log_no_update BEFORE UPDATE ON audit_log
      BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS audit_log_no_delete BEFORE DELETE ON audit_log
      BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;

      -- Date indexes for the dashboard's daily aggregates. A plain index on
      -- created_at + the redundant >= now-2days narrowing predicate in analytics.js
      -- (see there) makes "today" queries cost today's rows, not lifetime rows.
      -- NOTE: an expression index on date(created_at,'localtime') is NOT usable
      -- here -- SQLite rejects inserts with "non-deterministic use of date()".
      CREATE INDEX IF NOT EXISTS idx_sales_created_at ON sales(created_at);
      CREATE INDEX IF NOT EXISTS idx_credit_payments_created_at ON credit_payments(created_at);
      CREATE INDEX IF NOT EXISTS idx_returns_created_at ON warranty_returns(created_at);
      -- sale_id lookups (rma_count subquery on the sales list) get their own seek.
      CREATE INDEX IF NOT EXISTS idx_returns_sale_id ON warranty_returns(sale_id);
      CREATE INDEX IF NOT EXISTS idx_returns_sale_item_id ON warranty_returns(sale_item_id);
      -- sale_items is looked up by sale_id everywhere (receipts, customer ledgers,
      -- today's line-item split) but had no index on it.
      CREATE INDEX IF NOT EXISTS idx_sale_items_sale_id ON sale_items(sale_id);
      -- Customer lookups (ledger, utang grouping) key on customer_name.
      CREATE INDEX IF NOT EXISTS idx_sales_customer ON sales(customer_name);
      CREATE INDEX IF NOT EXISTS idx_credit_payments_customer ON credit_payments(customer_name);

      CREATE TABLE IF NOT EXISTS shifts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        -- ponytail: plain column, no FK — staff are soft-deleted, shifts must stay
        -- referable like audit_log.actor_id.
        staff_id INTEGER,
        staff_name TEXT NOT NULL DEFAULT '',
        opened_at TEXT NOT NULL,
        opening_float REAL NOT NULL DEFAULT 0,
        closed_at TEXT,
        counted_cash REAL,
        expected_cash REAL,
        variance REAL,
        status TEXT NOT NULL DEFAULT 'open'
      );
      CREATE INDEX IF NOT EXISTS idx_shifts_status ON shifts(status);

      CREATE TABLE IF NOT EXISTS day_reconciliations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        day TEXT UNIQUE NOT NULL,
        counted_cash REAL NOT NULL,
        expected_cash REAL NOT NULL,
        variance REAL NOT NULL,
        buckets TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'flagged',
        closed_by TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      );

      -- Money that moves today against a period somebody already signed (a
      -- void of a sale inside a closed shift or a reconciled day). The signed
      -- period is never rewritten; today's drawer absorbs the difference and
      -- the exceptions panel flags both ends.
      CREATE TABLE IF NOT EXISTS cash_adjustments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        amount REAL NOT NULL,
        reason TEXT NOT NULL,
        ref TEXT NOT NULL DEFAULT '',
        source_kind TEXT NOT NULL DEFAULT '',
        source_id INTEGER,
        created_at TEXT NOT NULL
      );

      -- "units received today" on the manager report scans stock_movements by
      -- created_at; same daily-aggregate pattern as the sales indexes above.
      CREATE INDEX IF NOT EXISTS idx_movements_created_at ON stock_movements(created_at);

      CREATE TABLE IF NOT EXISTS customer_profiles (
        customer_name TEXT PRIMARY KEY COLLATE NOCASE,
        credit_limit REAL NOT NULL DEFAULT 0.0,
        phone TEXT DEFAULT '',
        notes TEXT DEFAULT '',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Anti-fraud columns (guarded ALTERs — CREATE TABLE IF NOT EXISTS can't extend existing DBs)
    const salesCols = db.prepare('PRAGMA table_info(sales)').all().map(c => c.name);
    for (const [col, ddl] of [
      ['voided', 'ALTER TABLE sales ADD COLUMN voided INTEGER NOT NULL DEFAULT 0'],
      ['void_reason', 'ALTER TABLE sales ADD COLUMN void_reason TEXT DEFAULT NULL'],
      ['op_id', 'ALTER TABLE sales ADD COLUMN op_id TEXT DEFAULT NULL'],
      // One drawer can be worked by two cashiers. Without the person on the
      // row, cashier B's takings land in cashier A's signed variance.
      ['staff_id', 'ALTER TABLE sales ADD COLUMN staff_id INTEGER DEFAULT NULL']
    ]) {
      if (!salesCols.includes(col)) db.exec(ddl);
    }
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_sales_op_id ON sales(op_id) WHERE op_id IS NOT NULL');
    db.exec('CREATE INDEX IF NOT EXISTS idx_sales_staff ON sales(staff_id, id)');
    // Idempotency keys for the last two money paths without one (returns
    // filing, credit settlement): same guarded-ALTER + partial-unique pattern
    // as sales.op_id above.
    const returnsCols = db.prepare('PRAGMA table_info(warranty_returns)').all().map(c => c.name);
    if (!returnsCols.includes('op_id')) db.exec('ALTER TABLE warranty_returns ADD COLUMN op_id TEXT DEFAULT NULL');
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_returns_op_id ON warranty_returns(op_id) WHERE op_id IS NOT NULL');
    const paymentsCols = db.prepare('PRAGMA table_info(credit_payments)').all().map(c => c.name);
    if (!paymentsCols.includes('op_id')) db.exec('ALTER TABLE credit_payments ADD COLUMN op_id TEXT DEFAULT NULL');
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_credit_payments_op_id ON credit_payments(op_id) WHERE op_id IS NOT NULL');
    const auditCols = db.prepare('PRAGMA table_info(audit_log)').all().map(c => c.name);
    if (!auditCols.includes('row_hash')) db.exec("ALTER TABLE audit_log ADD COLUMN row_hash TEXT DEFAULT NULL");
    // Hash backfill (formula shared with audit.js — a drifting copy here would
    // silently break chain verification)
    const need = db.prepare("SELECT COUNT(*) AS c FROM audit_log WHERE row_hash IS NULL").get().c;
    if (need > 0) {
      db.exec('BEGIN');
      try {
        db.exec('DROP TRIGGER IF EXISTS audit_log_no_update');
        db.exec('DROP TRIGGER IF EXISTS audit_log_no_delete');
        // Resume chain from the last hashed row (genesis '' if none hashed yet)
        const prev0 = db.prepare('SELECT row_hash FROM audit_log WHERE row_hash IS NOT NULL ORDER BY id DESC LIMIT 1').get()?.row_hash || '';
        const rows = db.prepare('SELECT id, created_at, actor_type, actor_id, actor_name, category, action, detail, elevated FROM audit_log WHERE row_hash IS NULL ORDER BY id ASC').all();
        let prev = prev0;
        for (const r of rows) {
          const h = hashRow(prev, r);
          db.prepare('UPDATE audit_log SET row_hash = ? WHERE id = ?').run(h, r.id);
          prev = h;
        }
        db.exec(`CREATE TRIGGER IF NOT EXISTS audit_log_no_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END`);
        db.exec(`CREATE TRIGGER IF NOT EXISTS audit_log_no_delete BEFORE DELETE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END`);
        db.exec('COMMIT');
      } catch (e) { try { db.exec('ROLLBACK'); } catch(_){} try { db.exec(`CREATE TRIGGER IF NOT EXISTS audit_log_no_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END`); } catch(_){} try { db.exec(`CREATE TRIGGER IF NOT EXISTS audit_log_no_delete BEFORE DELETE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END`); } catch(_){} throw e; }
      }

    // Migration for DBs created before supplier/location/archived existed.
    // CREATE TABLE IF NOT EXISTS can't extend a table, so guarded ALTERs it is.
    const invCols = db.prepare('PRAGMA table_info(inventory)').all().map(c => c.name);
    for (const [col, ddl] of [
      ['supplier', "ALTER TABLE inventory ADD COLUMN supplier TEXT NOT NULL DEFAULT ''"],
      ['location', "ALTER TABLE inventory ADD COLUMN location TEXT NOT NULL DEFAULT ''"],
      ['archived', 'ALTER TABLE inventory ADD COLUMN archived INTEGER NOT NULL DEFAULT 0']
    ]) {
      if (!invCols.includes(col)) db.exec(ddl);
    }

    // Case-insensitive SKU collisions used to refuse the whole boot; renaming
    // the later row keeps the shop open, and the suffix (the row id) makes the
    // loser findable and editable in the catalog. One transaction, because the
    // rename UPDATE and the index below used to autocommit one by one: a rename
    // onto a suffix an existing row already held threw UNIQUE mid-boot and left
    // the register unopenable. The probe skips taken suffixes before writing.
    const dupRows = db.prepare(`
      SELECT id, UPPER(TRIM(sku_barcode)) AS sku
      FROM inventory
      WHERE sku_barcode IS NOT NULL AND TRIM(sku_barcode) != ''
      ORDER BY id
    `).all();
    db.exec('BEGIN');
    try {
      const seenSku = new Set();
      const skuTaken = db.prepare('SELECT 1 FROM inventory WHERE sku_barcode = ? COLLATE NOCASE LIMIT 1');
      let renamedSkus = 0;
      for (const row of dupRows) {
        if (seenSku.has(row.sku)) {
          let candidate = `${row.sku}-${row.id}`;
          for (let n = 2; skuTaken.get(candidate); n++) candidate = `${row.sku}-${row.id}-${n}`;
          db.prepare('UPDATE inventory SET sku_barcode = ? WHERE id = ?').run(candidate, row.id);
          seenSku.add(candidate);
          renamedSkus++;
        } else {
          seenSku.add(row.sku);
        }
      }
      if (renamedSkus) console.log(`[init] renamed ${renamedSkus} part(s) whose SKU collided case-insensitively; each loser carries its row id as a suffix`);
      db.prepare("UPDATE inventory SET sku_barcode = UPPER(TRIM(sku_barcode)) WHERE sku_barcode IS NOT NULL").run();
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_inventory_sku_nocase ON inventory(sku_barcode COLLATE NOCASE) WHERE sku_barcode IS NOT NULL');
      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch (_) {}
      throw e;
    }

    // Ledger backfill: one opening_balance row per pre-existing part that has no
    // movements yet (delta != 0 only), so SUM(stock_movements.delta) == stock
    // from the first run on. Idempotent: parts already tracked are excluded.
    // created_at rides along explicitly: the column default is zone-less
    // CURRENT_TIMESTAMP, which every other movement writer avoids.
    db.prepare(`
      INSERT INTO stock_movements (inventory_id, delta, reason, created_at)
      SELECT id, stock_quantity, 'opening_balance', ?
      FROM inventory
      WHERE stock_quantity != 0
        AND id NOT IN (SELECT inventory_id FROM stock_movements)
    `).run(new Date().toISOString());

    // Seed default shop settings if missing
    const insertSetting = db.prepare('INSERT OR IGNORE INTO shop_settings (key, value) VALUES (?, ?)');
    insertSetting.run('gcash_name', 'TechParts Repair & POS');
    insertSetting.run('gcash_number', '0917-123-4567');
    insertSetting.run('gcash_qr_url', '');
    insertSetting.run('receipt_paper_width', '80mm');
    insertSetting.run('warranty_days', '7');
    insertSetting.run('warranty_policy_text', '7 Days Test Warranty for LCDs & Batteries. Physical crack, flex tear, water damage, or removed warranty seal voids warranty.');
    insertSetting.run('shop_footer_note', 'Thank you for your business! Please keep this receipt for warranty claims.');
    insertSetting.run('license_key', '');
    insertSetting.run('manager_pin_hash', '03ac674216f3e15c761ee1a5e255f067953623c8b388b4459e13f978d7c846f4'); // SHA256('1234')
    insertSetting.run('last_backup_date', '');
    insertSetting.run('settle_elevation_threshold', '500');
    // 14-day trial clock. INSERT OR IGNORE: pre-existing DBs start a fresh trial
    // on first run of the new build (accepted; product is unshipped).
    insertSetting.run('first_run_ts', new Date().toISOString());
    insertSetting.run('last_seen_ts', new Date().toISOString());
    insertSetting.run('trial_compromised', '0');

    // Client op_id dedup for stock-moving writes that have no per-table op_id
    // column (adjustments, imports, part creation). Readers and writers live in
    // src/inventory.js; rows prune after 2 days.
    db.exec('CREATE TABLE IF NOT EXISTS op_log (op_id TEXT PRIMARY KEY, entity_id INTEGER, created_at TEXT NOT NULL)');

    // Sync outbox + shop identity (src/sync.js). Runs on every open; guarded
    // CREATEs make it a no-op after the first run.
    ensureSyncTables(db);
    return db;
  } catch (e) {
    try { db.close(); } catch (_) {}
    throw e;
  }
}

module.exports = { initDb, DEFAULT_DB_PATH, getBaseDir, isReleaseShaped, getDbFile };
