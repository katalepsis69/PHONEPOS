// Regression tests for low-end PC & large-scale performance optimizations.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { dbTest, serverTest, ensurePinChanged } = require('./helper');
const { initDb } = require('../src/db');
const { txn, audit, verifyChain, verifyChainIncremental } = require('../src/audit');
const { getCustomerDetails } = require('../src/credits');
const { getStandingStats, getDeadStock, getExceptions } = require('../src/analytics');
const { getSyncStatus } = require('../src/sync');
const { createInventoryItem } = require('../src/inventory');
const { createSale } = require('../src/sales');

const read = rel => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

dbTest('SQLite sets synchronous = NORMAL, memory temp_store, 16MB cache, and creates all performance indexes', (db, dbPath) => {
  const syncMode = db.prepare('PRAGMA synchronous').get();
  assert.strictEqual(syncMode.synchronous, 1, 'PRAGMA synchronous must be NORMAL (1) alongside WAL');
  assert.strictEqual(db.prepare('PRAGMA temp_store').get().temp_store, 2, 'PRAGMA temp_store must be MEMORY (2)');
  assert.strictEqual(db.prepare('PRAGMA cache_size').get().cache_size, -16000, 'PRAGMA cache_size must be -16000 (16MB)');

  const indexes = new Set(
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map(r => r.name)
  );
  for (const name of [
    'idx_sale_items_inv',
    'idx_op_log_created_at',
    'idx_cash_adj_created_at',
    'idx_cash_adj_source',
    'idx_audit_created_at',
    'idx_audit_cat_act',
    'idx_shifts_opened',
    'idx_shifts_closed',
    'idx_sales_open_credit',
    'idx_outbox_synced'
  ]) {
    assert.ok(indexes.has(name), `missing expected index: ${name}`);
  }

  // Dirty SKU normalizes on reopen without closing the helper's tracked handle.
  db.prepare(`
    INSERT INTO inventory (brand, model_name, part_type, sku_barcode, cost_price, price_retail, price_technician, stock_quantity)
    VALUES ('Apple', 'iPhone 12', 'LCD', ' ab-99 ', 10, 20, 15, 1)
  `).run();
  const reopened = initDb(dbPath);
  try {
    const row = reopened.prepare('SELECT sku_barcode FROM inventory ORDER BY id DESC LIMIT 1').get();
    assert.strictEqual(row.sku_barcode, 'AB-99');
  } finally {
    reopened.close();
  }
});

dbTest('keyset verifyChain and verifyChainIncremental handle >2000 audit rows and detect tail tampering', (db) => {
  txn(db, () => {
    for (let i = 0; i < 2010; i++) {
      audit(db, { id: 1, name: 'Cashier' }, false, 'sale', 'create', { idx: i });
    }
  });

  const full = verifyChain(db);
  assert.deepStrictEqual(full, { ok: true, first_bad_id: null });

  const inc1 = verifyChainIncremental(db);
  assert.deepStrictEqual(inc1, { ok: true, first_bad_id: null });

  txn(db, () => {
    audit(db, { id: 1, name: 'Cashier' }, false, 'sale', 'create', { idx: 2010 });
  });
  const inc2 = verifyChainIncremental(db);
  assert.deepStrictEqual(inc2, { ok: true, first_bad_id: null });

  // Forged appended row is caught incrementally across >2000 row chains.
  const forged = db.prepare(`
    INSERT INTO audit_log (created_at, actor_type, actor_id, actor_name, category, action, detail, elevated, row_hash)
    VALUES (datetime('now'), 'staff', 1, 'Cashier', 'sale', 'create', '{"forged":1}', 0, 'badhash')
  `).run();
  const incBad = verifyChainIncremental(db);
  assert.strictEqual(incBad.ok, false);
  assert.strictEqual(incBad.first_bad_id, Number(forged.lastInsertRowid));

  // Full keyset scan detects corruption past page 1 (>2000 rows).
  db.exec('DROP TRIGGER IF EXISTS audit_log_no_update');
  db.prepare("UPDATE audit_log SET detail = '{\"tampered\":true}' WHERE id = 2005").run();
  const broken = verifyChain(db);
  assert.strictEqual(broken.ok, false);
  assert.strictEqual(broken.first_bad_id, 2005);
});

dbTest('getCustomerDetails chunks sale_item IN queries past 1000 sales without SQL variable overflow', (db) => {
  const part = createInventoryItem(db, {
    brand: 'Samsung', model_name: 'A54', part_type: 'Charging Flex',
    cost_price: 50, price_retail: 150, stock_quantity: 5
  });

  txn(db, () => {
    // All unpaid so the ledger window keeps them; this test is about the IN chunking.
    const insSale = db.prepare(`
      INSERT INTO sales (sale_code, customer_name, customer_type, subtotal, total_amount, amount_paid, credit_balance, payment_method, created_at)
      VALUES (?, 'Bulk Client', 'retail', 150, 150, 0, 150, 'credit', datetime('now'))
    `);
    const insItem = db.prepare(`
      INSERT INTO sale_items (sale_id, inventory_id, item_name, quantity, unit_price, unit_cost, total_price)
      VALUES (?, ?, 'Samsung A54 Charging Flex', 1, 150, 50, 150)
    `);
    for (let i = 1; i <= 1050; i++) {
      const r = insSale.run(`S-BULK-${i}`);
      insItem.run(Number(r.lastInsertRowid), part.id);
    }
  });

  const details = getCustomerDetails(db, 'Bulk Client');
  assert.strictEqual(details.sales.length, 1050);
  assert.strictEqual(details.sales[0].items.length, 1);
  assert.strictEqual(details.sales[1049].items.length, 1);
});

dbTest('getStandingStats uses open-credit filter and getDeadStock limits last-sale lookup cleanly', (db) => {
  const sold = createInventoryItem(db, {
    brand: 'Vivo', model_name: 'Y11', part_type: 'Battery',
    cost_price: 100, price_retail: 250, stock_quantity: 5
  });
  const idle = createInventoryItem(db, {
    brand: 'Oppo', model_name: 'A16', part_type: 'LCD',
    cost_price: 400, price_retail: 900, stock_quantity: 3
  });
  createSale(db, {
    customer_name: 'Juan', payment_method: 'credit',
    items: [{ inventory_id: sold.id, quantity: 1, unit_price: 250 }],
    amount_paid: 50
  });
  createSale(db, {
    customer_name: 'Paid Guy', payment_method: 'cash',
    items: [{ inventory_id: sold.id, quantity: 1, unit_price: 250 }],
    amount_paid: 250
  });

  const st = getStandingStats(db);
  assert.strictEqual(st.total_credit_outstanding, 200);
  assert.strictEqual(st.total_debtors_count, 1);

  const dead = getDeadStock(db, '30d');
  assert.deepStrictEqual(dead.map(d => d.id), [idle.id]);
  assert.strictEqual(dead[0].last_sold, null);

  const ex = getExceptions(db, 7);
  assert.deepStrictEqual(ex.auditChain, { ok: true, first_bad_id: null });
});

dbTest('getSyncStatus short-circuits sync_outbox scans when sync URL is unconfigured', (db) => {
  db.prepare(`
    INSERT INTO sync_outbox (table_name, local_id, payload, created_at)
    VALUES ('sales', 1, '{}', datetime('now'))
  `).run();
  const st = getSyncStatus(db);
  assert.strictEqual(st.state, 'local');
  assert.strictEqual(st.url_configured, false);
  assert.strictEqual(st.pending, 0);
  assert.deepStrictEqual(st.pending_rows, []);
});

serverTest('HTTP API emits Server-Timing headers and /api/dashboard?lite=1 skips heavy panel queries', async (baseUrl, _db, rawAuth) => {
  const auth = await ensurePinChanged(baseUrl, rawAuth);
  const fullRes = await fetch(`${baseUrl}/api/dashboard?period=day`, { headers: auth });
  assert.strictEqual(fullRes.status, 200);
  assert.match(fullRes.headers.get('server-timing') || '', /app;dur=\d+\.\d+/);
  const full = await fullRes.json();
  assert.ok(full.products && Array.isArray(full.dead_stock) && full.backup);

  const liteRes = await fetch(`${baseUrl}/api/dashboard?period=day&lite=1`, { headers: auth });
  assert.strictEqual(liteRes.status, 200);
  assert.match(liteRes.headers.get('server-timing') || '', /app;dur=\d+\.\d+/);
  const lite = await liteRes.json();
  assert.ok(lite.current && lite.standing && Array.isArray(lite.period_shifts));
  assert.strictEqual(lite.products, undefined);
  assert.strictEqual(lite.dead_stock, undefined);
  assert.strictEqual(lite.reorder, undefined);
  assert.strictEqual(lite.backup, undefined);
});

test('CSS removes fixed .grain compositor blend/filter and ui pager walks pages cleanly', () => {
  const css = read('public/styles.css');
  const grainStart = css.indexOf('.grain');
  assert.ok(grainStart !== -1);
  const grainCss = css.slice(grainStart, grainStart + 200);
  assert.doesNotMatch(grainCss, /feTurbulence/);
  assert.doesNotMatch(grainCss, /mix-blend-mode/);

  const uiSrc = read('public/js/ui.js');
  const start = uiSrc.indexOf('const wiredPagerEls');
  const end = uiSrc.indexOf('export function showToast');
  const pagerCode = uiSrc.slice(start, end).replace(/export /g, '');

  const els = {};
  const el = id => els[id] || (els[id] = {
    textContent: '',
    disabled: false,
    classList: { hidden: true, add(c) { if (c === 'hidden') this.hidden = true; }, remove(c) { if (c === 'hidden') this.hidden = false; } },
    addEventListener(ev, fn) { if (ev === 'click') this.click = fn; }
  });
  let page = 1;
  const ctx = vm.createContext({
    document: { getElementById: el }
  });
  vm.runInContext(pagerCode, ctx);

  ctx.updateTablePager('pos-parts-pager', 250, page, 100, (step) => { page += step; });
  assert.strictEqual(el('pos-parts-pager').classList.hidden, false);
  assert.strictEqual(el('pos-parts-pager-range').textContent, '1-100 of 250');
  assert.strictEqual(el('pos-parts-pager-page').textContent, '1 / 3');
  assert.strictEqual(el('pos-parts-pager-prev').disabled, true);
  assert.strictEqual(el('pos-parts-pager-next').disabled, false);

  el('pos-parts-pager-next').click();
  assert.strictEqual(page, 2);
  ctx.updateTablePager('pos-parts-pager', 250, page, 100, (step) => { page += step; });
  assert.strictEqual(el('pos-parts-pager-range').textContent, '101-200 of 250');

  ctx.updateTablePager('pos-parts-pager', 50, 1, 100);
  assert.strictEqual(el('pos-parts-pager').classList.hidden, true);
});

test('POS shelf paginates at 100 rows and lookupBarcode resolves via O(1) Map', () => {
  const posSrc = read('public/js/views/pos.js');
  const mapStart = posSrc.indexOf('const POS_PAGE_SIZE = 100;');
  const mapEnd = posSrc.indexOf('export async function loadPosCatalog');
  const slice1 = posSrc.slice(mapStart, mapEnd).replace(/export /g, '');

  const tblStart = posSrc.indexOf('export function getFilteredParts()');
  const tblEnd = posSrc.indexOf('export function quickAddPart(');
  const slice2 = posSrc.slice(tblStart, tblEnd).replace(/export /g, '');

  const uiSrc = read('public/js/ui.js');
  const pStart = uiSrc.indexOf('const wiredPagerEls');
  const pEnd = uiSrc.indexOf('export function showToast');
  const pagerSlice = uiSrc.slice(pStart, pEnd).replace(/export /g, '');

  const catalog = Array.from({ length: 250 }, (_, i) => ({
    id: i + 1,
    brand: 'Apple',
    model_name: `Model ${i + 1}`,
    part_type: 'LCD',
    sku_barcode: `SKU-${i + 1}`,
    price_retail: 500,
    price_technician: 400,
    stock_quantity: 5,
    min_stock_alert: 1
  }));

  const els = {};
  const el = id => els[id] || (els[id] = {
    value: '',
    textContent: '',
    innerHTML: '',
    disabled: false,
    classList: { hidden: true, add(c) { if (c === 'hidden') this.hidden = true; }, remove(c) { if (c === 'hidden') this.hidden = false; }, toggle() {} },
    addEventListener(ev, fn) { if (ev === 'click') this.click = fn; },
    querySelectorAll: () => []
  });

  const ctx = vm.createContext({
    S: {
      currentTab: 'pos',
      currentPriceTier: 'retail',
      posBrandFilter: '',
      posCategoryFilter: '',
      posInStockOnly: false,
      inventoryItems: catalog,
      posCatalog: catalog,
      cart: [],
      scanBuffer: '',
      lastScanKeyTime: 0,
      shopSettings: { business_type: 'hybrid' }
    },
    document: { getElementById: el, querySelector: () => null, addEventListener: () => {} },
    window: { addEventListener: () => {} },
    sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    Date,
    AudioContext: null,
    escHtml: v => String(v ?? ''),
    fmtMoney: v => String(v),
    t: (_k, fb) => fb || '',
    setCounterText: (id, v) => { el(id).textContent = v; },
    isWholesaleTier: () => false,
    categoryIcon: () => 'package',
    categoryOf: it => it.part_type || 'Other',
    deviceLabel: () => '',
    showToast: () => {},
    cartQtyFor: () => 0,
    setPartQty: () => {},
    quickAddPart: () => {},
    itemMatchesProfile: () => true,
    itemVisibleInProfile: () => true
  });

  vm.runInContext(`${pagerSlice}\n${slice1}\n${slice2}`, ctx);

  assert.strictEqual(ctx.lookupBarcode('sku-250')?.id, 250);
  assert.strictEqual(ctx.lookupBarcode('missing'), null);

  ctx.renderPartsTable();
  assert.strictEqual((el('pos-parts-body').innerHTML.match(/<tr/g) || []).length, 100);
  assert.strictEqual(el('pos-parts-pager-range').textContent, '1-100 of 250');

  el('pos-parts-pager-next').click();
  assert.strictEqual((el('pos-parts-body').innerHTML.match(/<tr/g) || []).length, 100);
  assert.strictEqual(el('pos-parts-pager-range').textContent, '101-200 of 250');

  el('pos-parts-pager-next').click();
  assert.strictEqual((el('pos-parts-body').innerHTML.match(/<tr/g) || []).length, 50);
  assert.strictEqual(el('pos-parts-pager-range').textContent, '201-250 of 250');
});
