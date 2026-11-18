// Profile lanes: items carry an explicit store-profile tag; non-hybrid
// profiles show only their own lane. Regression for the 2026-11-17 report
// (phone stock leaking into every other profile, on-screen and in the cloud).
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { dbTest } = require('./helper');
const {
  createInventoryItem,
  updateInventoryItem,
  getInventoryItem,
  importInventory,
  bulkEditInventory,
  deleteInventoryItem
} = require('../src/inventory');
const { createSale } = require('../src/sales');

const setMode = (db, mode) =>
  db.prepare("INSERT OR REPLACE INTO shop_settings (key, value) VALUES ('business_type', ?)").run(mode);

const part = (over = {}) => ({
  brand: 'Apple', model_name: 'iPhone 11', part_type: 'LCD (Incell)',
  cost_price: 100, price_retail: 200, price_technician: 150, stock_quantity: 5,
  ...over
});

dbTest('migration adds the profile column and legacy rows stay untagged', (db) => {
  const cols = db.prepare('PRAGMA table_info(inventory)').all().map(c => c.name);
  assert.ok(cols.includes('profile'));
  const item = createInventoryItem(db, part());
  assert.strictEqual(item.profile, '', 'default register is hybrid with no template sent: untagged');
  db.prepare("UPDATE inventory SET profile = '' WHERE id = ?").run(item.id);
  assert.strictEqual(getInventoryItem(db, item.id).profile, '');
});

dbTest('non-hybrid register stamps its active profile on every new item', (db) => {
  setMode(db, 'phone');
  const item = createInventoryItem(db, part());
  assert.strictEqual(item.profile, 'phone');
  // The register's lane wins over whatever the form sent.
  const other = createInventoryItem(db, part({ model_name: 'iPhone 12', profile: 'retail' }));
  assert.strictEqual(other.profile, 'phone');
  setMode(db, 'grocery');
  const coke = createInventoryItem(db, { brand: 'Coca-Cola', model_name: '1.5L', part_type: 'Beverages', item_name: 'Coke 1.5L', stock_quantity: 24 });
  assert.strictEqual(coke.profile, 'grocery');
});

dbTest('hybrid register honors the form template; absent template stays shared', (db) => {
  setMode(db, 'hybrid');
  const tagged = createInventoryItem(db, part({ profile: 'phone' }));
  assert.strictEqual(tagged.profile, 'phone');
  const shared = createInventoryItem(db, part({ model_name: 'iPhone 13' }));
  assert.strictEqual(shared.profile, '');
  assert.throws(() => createInventoryItem(db, part({ model_name: 'X', profile: 'bogus' })), /Unknown store profile/);
});

dbTest('edit preserves the lane unless the form changes it', (db) => {
  setMode(db, 'phone');
  const item = createInventoryItem(db, part());
  updateInventoryItem(db, item.id, { price_retail: 250 });
  assert.strictEqual(getInventoryItem(db, item.id).profile, 'phone', 'price edit must not drop the tag');
  updateInventoryItem(db, item.id, { profile: 'retail' });
  assert.strictEqual(getInventoryItem(db, item.id).profile, 'retail');
  updateInventoryItem(db, item.id, { profile: '' });
  assert.strictEqual(getInventoryItem(db, item.id).profile, '', 'explicit shared is a valid lane choice');
  assert.throws(() => updateInventoryItem(db, item.id, { profile: 'bogus' }), /Unknown store profile/);
});

dbTest('CSV import stamps new rows with the active lane and keeps matched tags', (db) => {
  setMode(db, 'phone');
  const res = importInventory(db, [
    { Brand: 'Apple', 'Model Name': 'iPhone 14', 'Part Type': 'LCD (OLED)', 'Stock Qty': 3 },
    { Brand: 'Samsung', 'Model Name': 'Galaxy A14', 'Part Type': 'LCD (Incell)', 'Stock Qty': 2, Profile: 'retail' }
  ]);
  assert.strictEqual(res.created, 2);
  const rows = db.prepare('SELECT model_name, profile FROM inventory ORDER BY id').all();
  assert.strictEqual(rows[0].profile, 'phone');
  assert.strictEqual(rows[1].profile, 'phone', 'active register lane wins over a sheet tag on create');
  // Re-import with a Profile column on the matched row moves it.
  importInventory(db, [{ Brand: 'Samsung', 'Model Name': 'Galaxy A14', 'Part Type': 'LCD (Incell)', 'Stock Qty': 0, Profile: 'retail' }]);
  const moved = db.prepare("SELECT profile FROM inventory WHERE model_name = 'Galaxy A14'").get();
  assert.strictEqual(moved.profile, 'retail');
});

dbTest('bulk delete removes unsold parts and skips sold ones with a count', (db) => {
  const sold = createInventoryItem(db, part());
  const unsold = createInventoryItem(db, part({ model_name: 'iPhone 12' }));
  const unsold2 = createInventoryItem(db, part({ model_name: 'iPhone 13' }));
  createSale(db, { items: [{ inventory_id: sold.id, quantity: 1, unit_price: 200 }], amount_paid: 200 });
  const res = bulkEditInventory(db, { ids: [sold.id, unsold.id, unsold2.id], action: 'delete' });
  assert.strictEqual(res.updated, 2);
  assert.strictEqual(res.skipped, 1);
  assert.ok(getInventoryItem(db, sold.id), 'sold part stays referable');
  assert.strictEqual(getInventoryItem(db, unsold.id), null);
  assert.strictEqual(getInventoryItem(db, unsold2.id), null);
  assert.throws(() => deleteInventoryItem(db, sold.id), /sold line/);
});

dbTest('bulk update_fields moves selected items into one lane', (db) => {
  const a = createInventoryItem(db, part());
  const b = createInventoryItem(db, part({ model_name: 'iPhone 12' }));
  const res = bulkEditInventory(db, { ids: [a.id, b.id], action: 'update_fields', params: { profile: 'phone' } });
  assert.strictEqual(res.updated, 2);
  assert.strictEqual(getInventoryItem(db, a.id).profile, 'phone');
  assert.strictEqual(getInventoryItem(db, b.id).profile, 'phone');
  bulkEditInventory(db, { ids: [a.id], action: 'update_fields', params: { profile: '' } });
  assert.strictEqual(getInventoryItem(db, a.id).profile, '');
});

// Frontend lane rule, sliced from source the same way universal-pos.test.js
// evaluates the classifier (no DOM needed for either function).
const invSource = fs.readFileSync(path.join(__dirname, '../public/js/views/inventory.js'), 'utf8');
const matchCode = invSource.slice(
  invSource.indexOf('export function itemMatchesProfile('),
  invSource.indexOf('export function renderInventoryTable(')
).replace(/^export /gm, '');
const ctx = vm.createContext({});
vm.runInContext(`${matchCode}\n; this.itemVisibleInProfile = itemVisibleInProfile; this.itemMatchesProfile = itemMatchesProfile;`, ctx);
const { itemVisibleInProfile } = ctx;

const leakyPhonePart = { brand: 'Apple', model_name: 'iPhone 11', part_type: 'Camera', item_name: 'iPhone 11 Rear Camera', profile: 'phone' };
const taggedGrocery = { brand: 'Coca-Cola', model_name: '1.5L', part_type: 'Beverages', item_name: 'Coke 1.5L', profile: 'grocery' };

dbTest('tagged items never leak across lanes, even when the keyword guess disagrees', () => {
  // The reported defect: a phone part the heuristic misses used to show up
  // in every other profile. The tag now owns the lane.
  assert.strictEqual(ctx.itemMatchesProfile(leakyPhonePart, 'retail'), true, 'heuristic alone still misses this part');
  for (const lane of ['retail', 'grocery', 'service', 'pc']) {
    assert.strictEqual(itemVisibleInProfile(leakyPhonePart, lane), false, `phone-tagged part must not show in ${lane}`);
  }
  assert.strictEqual(itemVisibleInProfile(leakyPhonePart, 'phone'), true);
  assert.strictEqual(itemVisibleInProfile(taggedGrocery, 'phone'), false);
  assert.strictEqual(itemVisibleInProfile(taggedGrocery, 'retail'), false);
  assert.strictEqual(itemVisibleInProfile(taggedGrocery, 'grocery'), true);
  for (const item of [leakyPhonePart, taggedGrocery]) {
    assert.strictEqual(itemVisibleInProfile(item, 'hybrid'), true, 'hybrid sees every lane');
  }
});

dbTest('untagged legacy rows keep the keyword fallback until assigned', () => {
  const legacyPhone = { brand: 'Apple', model_name: 'iPhone 11', part_type: 'LCD (Incell)', item_name: null };
  assert.strictEqual(itemVisibleInProfile(legacyPhone, 'phone'), true);
  assert.strictEqual(itemVisibleInProfile(legacyPhone, 'grocery'), false);
  const legacyCoke = { brand: 'Coca-Cola', model_name: '1.5L', part_type: 'Beverages', item_name: 'Coke 1.5L' };
  assert.strictEqual(itemVisibleInProfile(legacyCoke, 'grocery'), true);
  assert.strictEqual(itemVisibleInProfile(legacyCoke, 'phone'), false);
});

dbTest('profile select and delete controls exist in the counter markup', () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  assert.ok(html.includes('id="edit-part-profile"'), 'edit modal lane picker');
  assert.ok(html.includes('id="bulk-profile"'), 'bulk lane move picker');
  assert.ok(html.includes('value="delete"'), 'bulk delete action');
  assert.ok(html.includes('id="bulk-panel-delete"'), 'bulk delete info panel');
  assert.ok(html.includes('id="tpl-btn-grocery"'), 'hybrid grocery template button');
  assert.ok(/<option value="service">Service \/ Labor<\/option>/.test(html), 'service profile selectable in settings');
  const main = fs.readFileSync(path.join(__dirname, '../public/js/main.js'), 'utf8');
  assert.ok(main.includes("'delete-part'"), 'row delete action wired');
  assert.ok(main.includes("'bulk-delete'"), 'bulk bar delete action wired');
  assert.ok(html.includes('id="inv-bulk-delete-btn"'), 'floating bulk bar includes Delete button');
  assert.ok(/option value="shared"/.test(html), 'shared lane option exists in profile selectors');
  const inv = invSource;
  assert.ok(inv.includes('data-action="delete-part"'), 'row delete button rendered');
  assert.ok(inv.includes("initialTemplate = mode") && /mode === 'service'\) initialTemplate = mode/.test(inv), 'service profile opens its own template');
  assert.ok(inv.includes("bulkDeleteSelectedPrompt"), 'bulk delete prompt handler exported');

  // Verify bulk bar and Select All filter by active profile (never select hidden lanes).
  assert.match(inv, /function updateBulkBar\(\)[\s\S]*itemVisibleInProfile\(i, mode\)/);
  assert.match(inv, /inv-select-all[\s\S]*itemVisibleInProfile\(i, mode\)/);

  // Verify POS search, barcode lookup, datalist, Ctrl+K palette, auth presets, receipts, and backoffice support all lanes + service.
  const posSrc = fs.readFileSync(path.join(__dirname, '../public/js/views/pos.js'), 'utf8');
  assert.match(posSrc, /function lookupBarcode[\s\S]*itemVisibleInProfile/);
  assert.match(posSrc, /populateDeviceDatalist[\s\S]*itemVisibleInProfile/);
  const searchSrc = fs.readFileSync(path.join(__dirname, '../public/js/search.js'), 'utf8');
  assert.match(searchSrc, /itemVisibleInProfile/);
  const authSrc = fs.readFileSync(path.join(__dirname, '../public/js/auth.js'), 'utf8');
  assert.match(authSrc, /service:\s*\[/);
  assert.match(authSrc, /preset === 'service'/);
  assert.match(authSrc, /clearInventorySelection/);
  const boSrc = fs.readFileSync(path.join(__dirname, '../public/js/views/backoffice.js'), 'utf8');
  assert.match(boSrc, /service:\s*'Service \/ Labor'/);
  const { defaultShopSubtitle } = (() => {
    const pSrc = fs.readFileSync(path.join(__dirname, '../src/printer.js'), 'utf8');
    const c = vm.createContext({});
    const fnSrc = pSrc.slice(pSrc.indexOf('function defaultShopSubtitle'), pSrc.indexOf('function saleShopNameRows'));
    vm.runInContext(`${fnSrc}; this.defaultShopSubtitle = defaultShopSubtitle;`, c);
    return c;
  })();
  assert.strictEqual(defaultShopSubtitle({ business_type: 'service' }), 'Repair & Technical Services');
});

dbTest('seedInitialParts tags starter stock as phone and non-hybrid queries isolate lanes', (db) => {
  const { seedInitialParts } = require('../src/seed');
  const { listInventory, getInventoryByBarcode, listReorderSuggestions } = require('../src/inventory');
  const { getStandingStats, getReorderList, getDeadStock } = require('../src/analytics');

  seedInitialParts(db, { zeroStock: false, skipSales: true });
  const phoneCount = db.prepare("SELECT COUNT(*) AS c FROM inventory WHERE profile = 'phone'").get().c;
  assert.ok(phoneCount > 0, 'starter parts must be stamped phone');
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS c FROM inventory WHERE profile = ''").get().c, 0, 'no starter part left untagged');

  setMode(db, 'grocery');
  const coke = createInventoryItem(db, {
    brand: 'Coca-Cola', model_name: '1.5L', part_type: 'Beverages',
    item_name: 'Coke 1.5L', sku_barcode: 'COKE-15L', stock_quantity: 2, min_stock_alert: 5, cost_price: 50, price_retail: 75
  });
  const sharedTape = createInventoryItem(db, {
    brand: '3M', model_name: 'Tape', part_type: 'Supplies',
    item_name: 'Packaging Tape', sku_barcode: 'TAPE-1', profile: 'shared', stock_quantity: 10, cost_price: 20, price_retail: 35
  });
  assert.strictEqual(sharedTape.profile, 'shared');

  const groceryList = listInventory(db, { profile: 'active' });
  assert.deepStrictEqual(groceryList.map(i => i.id).sort((a, b) => a - b), [coke.id, sharedTape.id].sort((a, b) => a - b));
  assert.strictEqual(itemVisibleInProfile(sharedTape, 'pc'), true);
  assert.strictEqual(itemVisibleInProfile(sharedTape, 'grocery'), true);

  // A phone barcode must not scan when the register is in grocery mode.
  const phoneItem = createInventoryItem(db, part({ model_name: 'iPhone 15', sku_barcode: 'PH-15', profile: 'phone' }), {}, { preserveProfile: true });
  assert.strictEqual(getInventoryByBarcode(db, 'PH-15', { profile: 'active' }), null);
  assert.strictEqual(getInventoryByBarcode(db, 'COKE-15L', { profile: 'active' })?.id, coke.id);

  // Analytics standing/dead-stock/reorder respect the active lane, while hybrid sees all.
  const groceryStanding = getStandingStats(db);
  assert.strictEqual(groceryStanding.total_inventory_types, 2);
  assert.strictEqual(groceryStanding.low_stock_count, 1);

  createSale(db, { items: [{ inventory_id: coke.id, quantity: 1, unit_price: 75 }], amount_paid: 75 });
  createSale(db, { items: [{ inventory_id: phoneItem.id, quantity: 1, unit_price: 200 }], amount_paid: 200 });
  assert.deepStrictEqual(listReorderSuggestions(db, { days: 3 }).rows.map(r => r.id), [coke.id]);
  assert.deepStrictEqual(getReorderList(db, '30d').map(r => r.id), [coke.id]);
  assert.deepStrictEqual(getDeadStock(db, '30d').map(r => r.id), [sharedTape.id]);

  setMode(db, 'hybrid');
  const hybridStanding = getStandingStats(db);
  assert.strictEqual(hybridStanding.total_inventory_types, phoneCount + 3);
  assert.strictEqual(getInventoryByBarcode(db, 'PH-15', { profile: 'active' })?.id, phoneItem.id);
});

dbTest('cloud sync propagates business_type and enforces per-shop lane isolation', async () => {
  const os = require('node:os');
  const { startCloud, stopCloud, login, TOKEN_A } = require('./cloud-hardening-harness');
  const { drainOutbox } = require('../src/sync');
  const { initDb } = require('../src/db');

  const shopDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lanes-shop-'));
  const cloudDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lanes-cloud-'));
  fs.writeFileSync(path.join(cloudDir, 'manager-pin.txt'), '2468\n');
  const shopDb = initDb(path.join(shopDir, 'shop.db'));
  let child;
  try {
    setMode(shopDb, 'phone');
    const lcd = createInventoryItem(shopDb, part({ model_name: 'iPhone 11', stock_quantity: 2, min_stock_alert: 5 }));
    setMode(shopDb, 'grocery');
    const coke = createInventoryItem(shopDb, {
      brand: 'Coca-Cola', model_name: '1.5L', part_type: 'Beverages',
      item_name: 'Coke 1.5L', stock_quantity: 1, min_stock_alert: 5, cost_price: 50, price_retail: 75
    });
    const shared = createInventoryItem(shopDb, {
      brand: '3M', model_name: 'Tape', part_type: 'Supplies',
      item_name: 'Packing Tape', profile: 'shared', stock_quantity: 10, cost_price: 20, price_retail: 30
    });

    const running = await startCloud(cloudDir, { SHOP_SYNC_CREDENTIALS: JSON.stringify({ north: TOKEN_A }) });
    child = running.child;
    shopDb.prepare("INSERT OR REPLACE INTO shop_settings (key, value) VALUES ('sync_url', ?)").run(running.base);
    shopDb.prepare("INSERT OR REPLACE INTO shop_settings (key, value) VALUES ('sync_token', ?)").run(TOKEN_A);
    while ((await drainOutbox(shopDb)).synced > 0) {}

    const { cookie } = await login(running.base);
    const headers = { Cookie: cookie };
    const overview = await (await fetch(`${running.base}/api/overview`, { headers })).json();
    assert.strictEqual(overview.shops[0].business_type, 'grocery', 'sync persists active shop business_type');

    // In grocery mode, cloud standing/rows/reorder/dead-stock exclude the phone LCD.
    const standingG = await (await fetch(`${running.base}/api/standing`, { headers })).json();
    assert.strictEqual(standingG.inventory_types, 2);
    assert.strictEqual(standingG.low_stock_count, 1);
    assert.strictEqual(standingG.inventory_retail_value, 1 * 75 + 10 * 30);

    const rowsG = await (await fetch(`${running.base}/api/rows?table=inventory`, { headers })).json();
    assert.deepStrictEqual(rowsG.map(r => r.id).sort((a, b) => a - b), [coke.id, shared.id].sort((a, b) => a - b));

    const deadG = await (await fetch(`${running.base}/api/dead-stock?period=30d`, { headers })).json();
    assert.deepStrictEqual(deadG.map(r => r.id).sort((a, b) => a - b), [coke.id, shared.id].sort((a, b) => a - b));

    const reorderG = await (await fetch(`${running.base}/api/reorder?period=30d`, { headers })).json();
    assert.deepStrictEqual(reorderG.map(r => r.id), [coke.id]);

    // Flip workstation to hybrid -> heartbeat sync updates cloud and exposes all 3 items.
    setMode(shopDb, 'hybrid');
    await drainOutbox(shopDb);
    const overviewH = await (await fetch(`${running.base}/api/overview`, { headers })).json();
    assert.strictEqual(overviewH.shops[0].business_type, 'hybrid');
    const standingH = await (await fetch(`${running.base}/api/standing`, { headers })).json();
    assert.strictEqual(standingH.inventory_types, 3, 'hybrid mode exposes phone + grocery + shared in cloud standing');

    const cloudAppSrc = fs.readFileSync(path.join(__dirname, '../cloud-deploy/public/app.js'), 'utf8');
    assert.match(cloudAppSrc, /CLOUD_PROFILE_TEMPLATES/);
    assert.match(cloudAppSrc, /isItemVisibleInCloud/);
    assert.match(cloudAppSrc, /\$\{slug\}-import-template\.csv/);
  } finally {
    if (child) await stopCloud(child);
    try { shopDb.close(); } catch (_) {}
    try { fs.rmSync(shopDir, { recursive: true, force: true }); } catch (_) {}
    try { fs.rmSync(cloudDir, { recursive: true, force: true }); } catch (_) {}
  }
});

dbTest('profile exports use plain-English headers, matching filenames, and round-trip with legacy aliases', (db) => {
  const { buildInventoryExport } = require('../src/inventory');

  setMode(db, 'grocery');
  createInventoryItem(db, {
    brand: 'Coca-Cola', model_name: '1.5L', part_type: 'Beverages', item_name: 'Coke 1.5L',
    category: 'Beverages', uom: 'bottle', allow_fractional: 0, sku_barcode: 'COKE-15L',
    cost_price: 55, price_retail: 75, price_technician: 68, stock_quantity: 12,
    min_stock_alert: 4, supplier: 'Dist', location: 'Aisle 1'
  });
  const exp = buildInventoryExport(db);
  assert.strictEqual(exp.filename, 'grocery-inventory.csv');
  assert.ok(exp.headers.includes('Unit') && exp.headers.includes('Sell by Weight or Decimal'));
  assert.ok(exp.headers.includes('Capital') && exp.headers.includes('Retail Price') && exp.headers.includes('Wholesale Price'));
  assert.ok(exp.headers.includes('Stock Count') && exp.headers.includes('Low Stock Alert') && exp.headers.includes('Shelf / Bin'));
  assert.strictEqual(exp.rows.length, 1);

  // Re-import using exported plain-English headers (adds +5 stock).
  const rowObj = Object.fromEntries(exp.headers.map((h, idx) => [h, h === 'Stock Count' ? 5 : exp.rows[0][idx]]));
  const roundTrip = importInventory(db, [rowObj]);
  assert.strictEqual(roundTrip.updated, 1);
  assert.strictEqual(db.prepare("SELECT stock_quantity FROM inventory WHERE sku_barcode = 'COKE-15L'").get().stock_quantity, 17);

  // Barcodeless Grocery item re-import matches item_name + category without duplicating.
  createInventoryItem(db, {
    brand: 'Generic', model_name: '1kg', part_type: 'Condiments & Sauces', item_name: 'Brown Sugar 1kg',
    category: 'Condiments & Sauces', uom: 'kg', allow_fractional: 1, sku_barcode: null,
    cost_price: 55, price_retail: 75, price_technician: 68, stock_quantity: 10, min_stock_alert: 3
  });
  const noSkuExp = buildInventoryExport(db);
  const sugarIdx = noSkuExp.rows.findIndex(r => r[0] === 'Brown Sugar 1kg');
  assert.ok(sugarIdx >= 0);
  const sugarRowObj = Object.fromEntries(noSkuExp.headers.map((h, idx) => [h, h === 'Stock Count' ? 2.5 : noSkuExp.rows[sugarIdx][idx]]));
  const sugarRoundTrip = importInventory(db, [sugarRowObj]);
  assert.strictEqual(sugarRoundTrip.updated, 1);
  assert.strictEqual(sugarRoundTrip.created, 0);
  assert.strictEqual(db.prepare("SELECT stock_quantity FROM inventory WHERE item_name = 'Brown Sugar 1kg'").get().stock_quantity, 12.5);

  // Legacy jargon headers still import under hybrid mode.
  setMode(db, 'hybrid');
  const legacyRes = importInventory(db, [{
    Brand: 'Apple', 'Model Name': 'iPhone 12', 'Part Type': 'Battery', 'SKU / Barcode': 'AP-BAT-12',
    Capital: 500, 'Retail Price': 1100, 'Wholesale Price': 900, 'Stock Qty': 3,
    'Min Stock Alert': 2, UOM: 'pcs', 'Allow Fractional': 'no', 'Track Serial': 'no',
    Profile: 'phone', Location: 'Bin 2'
  }]);
  assert.strictEqual(legacyRes.created, 1);
  const legacyItem = db.prepare("SELECT * FROM inventory WHERE sku_barcode = 'AP-BAT-12'").get();
  assert.strictEqual(legacyItem.profile, 'phone');
  assert.strictEqual(legacyItem.location, 'Bin 2');

  for (const [mode, expectedFile] of [
    ['phone', 'phone-repair-inventory.csv'],
    ['pc', 'pc-electronics-inventory.csv'],
    ['retail', 'retail-inventory.csv'],
    ['service', 'service-labor-inventory.csv'],
    ['hybrid', 'hybrid-inventory.csv']
  ]) {
    setMode(db, mode);
    assert.strictEqual(buildInventoryExport(db).filename, expectedFile);
  }
});

dbTest('inventory metrics and navbar badge count all low and out-of-stock items', () => {
  const vm = require('node:vm');
  const start = invSource.indexOf('export function renderInventoryMetrics');
  const end = invSource.indexOf('// REORDER SHEET', start);
  const metricsCode = invSource.slice(start, invSource.lastIndexOf('\n', end - 1)).replace(/^export /, '');
  const badgeStart = invSource.indexOf('export function refreshInventoryBadge');
  const badgeEnd = invSource.indexOf('export const TEMPLATE_CATEGORIES');
  const badgeCode = invSource.slice(badgeStart, badgeEnd).replaceAll('export ', '');
  const visStart = invSource.indexOf('export function itemVisibleInProfile');
  const visEnd = invSource.indexOf('export function renderInventoryTable');
  const visCode = invSource.slice(visStart, visEnd).replaceAll('export ', '');

  const makeEl = () => {
    const classes = new Set();
    return {
      textContent: '',
      title: '',
      classList: {
        has: c => classes.has(c),
        toggle: (c, force) => (force === undefined ? (classes.has(c) ? classes.delete(c) : classes.add(c)) : (force ? classes.add(c) : classes.delete(c))),
      },
    };
  };
  const els = {
    'inv-metric-total': makeEl(),
    'inv-metric-stock': makeEl(),
    'inv-metric-in': makeEl(),
    'inv-metric-in-meta': makeEl(),
    'inv-metric-low': makeEl(),
    'inv-metric-out': makeEl(),
    'inv-metric-out-card': makeEl(),
    'inv-metric-out-meta': makeEl(),
    'nav-lowstock-badge': makeEl(),
  };
  const ctx = vm.createContext({
    S: { shopSettings: { business_type: 'phone' }, inventoryItems: [] },
    t: (_k, fb) => fb,
    itemMatchesProfile: () => true,
    document: { getElementById: id => els[id] || null },
  });
  vm.runInContext(`${visCode}\n${badgeCode}\n${metricsCode}`, ctx);

  // 1 stocked low battery + 2 zero-stock items -> low=1, out=2, badge=3 (low + out), red danger.
  const catalog = [
    { profile: 'phone', stock_quantity: 3, min_stock_alert: 3, ever_stocked: 1, archived: 0 },
    { profile: 'phone', stock_quantity: 0, min_stock_alert: 2, ever_stocked: 0, archived: 0 },
    { profile: 'phone', stock_quantity: 0, min_stock_alert: 2, ever_stocked: 0, archived: 0 },
  ];
  ctx.renderInventoryMetrics(catalog);
  ctx.refreshInventoryBadge(catalog);
  assert.strictEqual(els['inv-metric-total'].textContent, 3);
  assert.strictEqual(els['inv-metric-low'].textContent, 1);
  assert.strictEqual(els['inv-metric-out'].textContent, 2);
  assert.strictEqual(els['nav-lowstock-badge'].textContent, '3');
  assert.strictEqual(els['inv-metric-out-card'].classList.has('stat--danger'), true);
  assert.strictEqual(els['inv-metric-out-meta'].textContent, 'needs restock');

  // Another zero-stock item increments out=3 and badge=4.
  catalog.push({ profile: 'phone', stock_quantity: 0, min_stock_alert: 2, ever_stocked: 1, archived: 0 });
  ctx.renderInventoryMetrics(catalog);
  ctx.refreshInventoryBadge(catalog);
  assert.strictEqual(els['inv-metric-out'].textContent, 3);
  assert.strictEqual(els['nav-lowstock-badge'].textContent, '4');
  assert.strictEqual(els['inv-metric-out-card'].classList.has('stat--danger'), true);
});

dbTest('topbar quick profile switcher and zero-scroll inventory table CSS exist', () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  const auth = fs.readFileSync(path.join(__dirname, '../public/js/auth.js'), 'utf8');
  const main = fs.readFileSync(path.join(__dirname, '../public/js/main.js'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '../public/styles.css'), 'utf8');

  assert.match(html, /class="topbar-profile" data-manager-only/);
  assert.match(html, /id="topbar-profile-switcher"/);
  assert.match(auth, /export async function switchActiveBusinessProfile/);
  assert.ok(auth.includes('m.loadDashboardData?.()'), 'dashboard reload uses loadDashboardData');
  assert.ok(invSource.includes('function getVisibleSelectedIds()'), 'bulk operations use visible-profile selection helper');
  assert.match(main, /on\('topbar-profile-switcher', 'change'/);
  assert.match(css, /#view-inventory table\.ptable:not\(\.reorder-table\)\s*\{\s*width:\s*100%;\s*min-width:\s*980px;/);
  assert.match(css, /#view-inventory table\.ptable:not\(\.reorder-table\) thead th:nth-child\(2\) \{ width: 15%; \}/);
  assert.match(css, /#view-inventory table\.ptable:not\(\.reorder-table\) thead th:nth-child\(8\) \{ width: 11\.5%; \}/);
  assert.match(css, /\.inv-actions-row\s*\{[\s\S]*gap:\s*3px;/);
});
