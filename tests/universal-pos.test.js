// tests/universal-pos.test.js
const assert = require('node:assert');
const { dbTest } = require('./helper');
const { createInventoryItem, getInventoryItem, partLabel, listInventory, adjustStock, importInventory, listReorderSuggestions } = require('../src/inventory');
const { createSale, getSaleDetails } = require('../src/sales');
const { createWarrantyReturn } = require('../src/returns');
const { updateShopSettings, getShopSettings } = require('../src/settings');
const { money } = require('../src/money');

dbTest('wholesale pricing tier accepts customer_type wholesale and charges wholesale price', (db) => {
  const item = createInventoryItem(db, {
    brand: 'Logitech',
    model_name: 'G102 Lightsync',
    part_type: 'Mouse',
    cost_price: 500,
    price_retail: 990,
    price_technician: 800,
    stock_quantity: 10
  });

  const sale = createSale(db, {
    customer_name: 'Bulk Buyer',
    customer_type: 'wholesale',
    payment_method: 'cash',
    items: [{ inventory_id: item.id, quantity: 3 }],
    amount_paid: 2400
  });

  assert.strictEqual(sale.subtotal, 2400); // 3 * 800
  assert.strictEqual(sale.total_amount, 2400);
  assert.strictEqual(sale.change_amount, 0);
  assert.strictEqual(sale.items[0].unit_price, 800);
});

dbTest('universal item creation with item_name works for grocery and PC components', (db) => {
  const drink = createInventoryItem(db, {
    item_name: 'Coca-Cola 1.5L',
    cost_price: 65,
    price_retail: 85,
    price_wholesale: 78,
    stock_quantity: 50,
    category: 'Beverages',
    uom: 'bottle'
  });

  assert.strictEqual(drink.item_name, 'Coca-Cola 1.5L');
  assert.strictEqual(partLabel(drink), 'Coca-Cola 1.5L');
  assert.strictEqual(drink.price_wholesale, 78);

  const found = listInventory(db, { search: 'coca' });
  assert.strictEqual(found.length, 1);
  assert.strictEqual(found[0].item_name, 'Coca-Cola 1.5L');
});

dbTest('fractional quantities allow weight/meter sales when allow_fractional is enabled', (db) => {
  const rice = createInventoryItem(db, {
    item_name: 'Sinandomeng Rice',
    category: 'Grains',
    uom: 'kg',
    allow_fractional: 1,
    cost_price: 40,
    price_retail: 55,
    price_wholesale: 50,
    stock_quantity: 100.5
  });

  assert.strictEqual(rice.stock_quantity, 100.5);

  const sale = createSale(db, {
    customer_name: 'Walk-in',
    customer_type: 'retail',
    payment_method: 'cash',
    items: [{ inventory_id: rice.id, quantity: 2.5 }],
    amount_paid: 137.5
  });

  assert.strictEqual(sale.subtotal, 137.5); // 2.5 * 55 = 137.50
  assert.strictEqual(sale.total_amount, 137.5);

  const updatedRice = getInventoryItem(db, rice.id);
  assert.strictEqual(updatedRice.stock_quantity, 98); // 100.5 - 2.5 = 98
});

dbTest('non-fractional items reject decimal quantities', (db) => {
  const phoneCase = createInventoryItem(db, {
    brand: 'Generic',
    model_name: 'Silicone Case',
    part_type: 'Accessories',
    cost_price: 50,
    price_retail: 150,
    price_wholesale: 100,
    stock_quantity: 20
  });

  assert.throws(() => {
    createSale(db, {
      customer_name: 'Walk-in',
      payment_method: 'cash',
      items: [{ inventory_id: phoneCase.id, quantity: 1.5 }],
      amount_paid: 225
    });
  }, /Must be a positive integer/);
});

dbTest('universal shop settings allow business profile and module switches', (db) => {
  updateShopSettings(db, 'business_type', 'grocery');
  updateShopSettings(db, 'enable_service_bench', '0');
  updateShopSettings(db, 'enable_fractional_qty', '1');
  updateShopSettings(db, 'enable_serial_tracking', '0');
  updateShopSettings(db, 'wholesale_tier_label', 'Wholesale');

  const settings = getShopSettings(db);
  assert.strictEqual(settings.business_type, 'grocery');
  assert.strictEqual(settings.enable_service_bench, '0');
  assert.strictEqual(settings.enable_fractional_qty, '1');
  assert.strictEqual(settings.enable_serial_tracking, '0');
  assert.strictEqual(settings.wholesale_tier_label, 'Wholesale');
});

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const i18nSource = fs.readFileSync(path.join(__dirname, '../public/js/i18n.js'), 'utf8');

dbTest('profile vocabulary: zero em dashes, zero technician, and complete EN/TL parity', () => {
  const context = { localStorage: { getItem: () => 'en', setItem: () => {} }, document: { documentElement: {} } };
  const evaluated = vm.runInNewContext(`${i18nSource.replace(/^export /gm, '')}\n; ({ I18N, PROFILE_VOCAB, setBusinessProfile, t })`, context);
  const { PROFILE_VOCAB, setBusinessProfile, t } = evaluated;

  assert.ok(PROFILE_VOCAB, 'PROFILE_VOCAB exists');
  for (const [prof, langs] of Object.entries(PROFILE_VOCAB)) {
    if (prof === 'phone') continue; // phone uses base dictionary
    assert.ok(langs.en && langs.tl, `Profile ${prof} must have both en and tl`);
    const enKeys = Object.keys(langs.en).sort();
    const tlKeys = Object.keys(langs.tl).sort();
    assert.deepStrictEqual(enKeys, tlKeys, `Profile ${prof} must have identical EN and TL keys`);

    for (const [k, v] of Object.entries(langs.en)) {
      assert.doesNotMatch(v, /—/, `Key ${prof}.en.${k} contains em dash`);
      assert.doesNotMatch(v, /technician/i, `Key ${prof}.en.${k} mentions technician`);
    }
    for (const [k, v] of Object.entries(langs.tl)) {
      assert.doesNotMatch(v, /—/, `Key ${prof}.tl.${k} contains em dash`);
      assert.doesNotMatch(v, /technician/i, `Key ${prof}.tl.${k} mentions technician`);
    }
  }

  // Test dynamic switching
  setBusinessProfile('grocery');
  assert.strictEqual(t('inv.add_part'), 'Add Product');
  assert.strictEqual(t('title.pos'), 'Checkout Counter');
  assert.strictEqual(t('title.inventory'), 'Product Inventory');
  assert.strictEqual(t('pos.cart_empty'), 'No items in current sale');

  setBusinessProfile('pc');
  assert.strictEqual(t('inv.add_part'), 'Add PC Component');
  assert.strictEqual(t('title.pos'), 'Sales & Service Counter');
  assert.strictEqual(t('title.inventory'), 'Hardware Inventory');

  setBusinessProfile('retail');
  assert.strictEqual(t('inv.add_part'), 'Add Item');
  assert.strictEqual(t('title.pos'), 'Checkout Counter');

  setBusinessProfile('hybrid');
  assert.strictEqual(t('inv.add_part'), 'Add Item / Part');
  assert.strictEqual(t('title.pos'), 'Sales & Service Counter');

  setBusinessProfile('phone');
  assert.strictEqual(t('inv.add_part'), 'Add New Phone Part');
  assert.strictEqual(t('title.pos'), 'Repair counter');
});

const invSource = fs.readFileSync(path.join(__dirname, '../public/js/views/inventory.js'), 'utf8');

dbTest('profile-scoped inventory filtering: off-profile items are identified and separated cleanly', () => {
  const matchCode = invSource.slice(
    invSource.indexOf('export function itemMatchesProfile('),
    invSource.indexOf('export function renderInventoryTable(')
  );
  const context = {};
  const evaluated = vm.runInNewContext(`${matchCode.replace(/^export /gm, '')}\n; itemMatchesProfile`, context);
  const itemMatchesProfile = evaluated;

  // 1. Phone Repair Parts (e.g. starter phone parts)
  const phoneScreen = { brand: 'Apple', model_name: 'iPhone 11', part_type: 'LCD (Incell)', item_name: null };
  const phoneBattery = { brand: 'Samsung', model_name: 'Galaxy A12', part_type: 'Battery (5000mAh)', item_name: null };
  const samsungOledFrame = { brand: 'Samsung', model_name: 'Galaxy A52 / A52s', part_type: 'LCD (OLED with Frame)', item_name: null };

  // 2. PC Hardware Components
  const pcGpu = { brand: 'ASUS', model_name: 'GeForce RTX 4060', part_type: 'GPU', category: 'GPU', item_name: 'GeForce RTX 4060 8GB' };
  const pcRam = { brand: 'Kingston', model_name: 'Fury 16GB DDR5', part_type: 'RAM', category: 'RAM', item_name: 'Fury 16GB DDR5 5600MHz' };

  // 3. Grocery / Retail Items
  const groceryCoke = { brand: 'Coca-Cola', model_name: '1.5L', part_type: 'Beverages', category: 'Beverages', item_name: 'Coca-Cola 1.5L' };
  const groceryRice = { brand: 'Generic', model_name: 'Sinandomeng', part_type: 'Grains', category: 'Produce', item_name: 'Sinandomeng Rice', allow_fractional: 1 };

  // Phone profile: only phone parts match
  assert.strictEqual(itemMatchesProfile(phoneScreen, 'phone'), true);
  assert.strictEqual(itemMatchesProfile(phoneBattery, 'phone'), true);
  assert.strictEqual(itemMatchesProfile(samsungOledFrame, 'phone'), true);
  assert.strictEqual(itemMatchesProfile(pcGpu, 'phone'), false);
  assert.strictEqual(itemMatchesProfile(groceryCoke, 'phone'), false);

  // PC profile: only PC parts match, zero phone parts (even with "Frame" in type)
  assert.strictEqual(itemMatchesProfile(pcGpu, 'pc'), true);
  assert.strictEqual(itemMatchesProfile(pcRam, 'pc'), true);
  assert.strictEqual(itemMatchesProfile(phoneScreen, 'pc'), false);
  assert.strictEqual(itemMatchesProfile(phoneBattery, 'pc'), false);
  assert.strictEqual(itemMatchesProfile(samsungOledFrame, 'pc'), false, 'Samsung OLED with Frame must never match PC profile');

  // Grocery profile: phone parts and internal PC hardware are hidden
  assert.strictEqual(itemMatchesProfile(groceryCoke, 'grocery'), true);
  assert.strictEqual(itemMatchesProfile(groceryRice, 'grocery'), true);
  assert.strictEqual(itemMatchesProfile(phoneScreen, 'grocery'), false, 'phone LCD must not show in grocery store');
  assert.strictEqual(itemMatchesProfile(phoneBattery, 'grocery'), false, 'phone battery must not show in grocery store');
  assert.strictEqual(itemMatchesProfile(samsungOledFrame, 'grocery'), false, 'phone OLED must not show in grocery store');
  assert.strictEqual(itemMatchesProfile(pcGpu, 'grocery'), false, 'PC GPU must not show in grocery store');

  // Retail profile: phone repair parts are hidden
  assert.strictEqual(itemMatchesProfile(groceryCoke, 'retail'), true);
  assert.strictEqual(itemMatchesProfile(phoneScreen, 'retail'), false, 'phone LCD must not show in general retail');
  assert.strictEqual(itemMatchesProfile(samsungOledFrame, 'retail'), false, 'phone OLED must not show in general retail');

  // Hybrid profile: everything matches
  assert.strictEqual(itemMatchesProfile(phoneScreen, 'hybrid'), true);
  assert.strictEqual(itemMatchesProfile(pcGpu, 'hybrid'), true);
  assert.strictEqual(itemMatchesProfile(groceryCoke, 'hybrid'), true);
  assert.strictEqual(itemMatchesProfile(groceryRice, 'hybrid'), true);
});

dbTest('brand and category dropdown filters strictly scope to active store profile', () => {
  // Extract TEMPLATE_BRANDS, TEMPLATE_CATEGORIES, itemMatchesProfile, renderInvBrandFilter, renderPartTypeOptions
  const block = invSource.replace(/^import\s+.*?;/gm, '').replace(/^export /gm, '');
  const domElements = {
    'inv-profile-filter-check': { checked: true }
  };
  const mockDoc = {
    getElementById: (id) => domElements[id] || (domElements[id] = { value: '', innerHTML: '', classList: { contains: () => false, toggle: () => {} } }),
    querySelector: () => null,
    querySelectorAll: () => []
  };
  const mockS = {
    inventoryItems: [
      { id: 1, brand: 'Apple', model_name: 'iPhone 11', part_type: 'LCD (Incell)', item_name: null },
      { id: 2, brand: 'Samsung', model_name: 'Galaxy A12', part_type: 'Battery (5000mAh)', item_name: null }
    ],
    shopSettings: { business_type: 'grocery' }
  };
  const context = {
    document: mockDoc,
    S: mockS,
    escHtml: s => s,
    t: (k, fb) => fb
  };
  const mod = vm.runInNewContext(block + '\n; ({ TEMPLATE_BRANDS, TEMPLATE_CATEGORIES, renderInvBrandFilter, renderPartTypeOptions })', context);

  // 1. Verify TEMPLATE_CATEGORIES covers all profiles
  assert.ok(mod.TEMPLATE_CATEGORIES.grocery.includes('Beverages'));
  assert.ok(mod.TEMPLATE_CATEGORIES.pc.includes('Graphics Cards (GPU)'));
  assert.ok(mod.TEMPLATE_CATEGORIES.phone.includes('LCD Screens'));

  // 2. In Grocery profile with only phone parts in DB, brand filter must NOT show Apple/Samsung
  mockDoc.getElementById('inv-brand-filter').innerHTML = '';
  mod.renderInvBrandFilter();
  const brandHtml = mockDoc.getElementById('inv-brand-filter').innerHTML;
  assert.doesNotMatch(brandHtml, />Apple</);
  assert.doesNotMatch(brandHtml, />Samsung</);
  assert.match(brandHtml, />Coca-Cola</);
  assert.match(brandHtml, />Nestle</);

  // 3. In Grocery profile with only phone parts in DB, type filter must NOT show LCD/Battery
  mockDoc.getElementById('inv-type-filter').innerHTML = '';
  mod.renderPartTypeOptions();
  const typeHtml = mockDoc.getElementById('inv-type-filter').innerHTML;
  assert.doesNotMatch(typeHtml, />LCD \(Incell\)</);
  assert.doesNotMatch(typeHtml, />Battery \(5000mAh\)</);
  assert.match(typeHtml, />Beverages</);
  assert.match(typeHtml, />Canned Goods</);

  // 4. In PC profile, brand filter falls back to PC hardware brands and hides phone parts
  const samsungOledFrame = { brand: 'Samsung', model_name: 'Galaxy A52 / A52s', part_type: 'LCD (OLED with Frame)', item_name: null };
  mockS.inventoryItems.push(samsungOledFrame);
  mockS.shopSettings.business_type = 'pc';
  mockDoc.getElementById('inv-brand-filter').innerHTML = '';
  mod.renderInvBrandFilter();
  const pcBrandHtml = mockDoc.getElementById('inv-brand-filter').innerHTML;
  assert.doesNotMatch(pcBrandHtml, />Apple</);
  assert.doesNotMatch(pcBrandHtml, />Samsung</);
  assert.match(pcBrandHtml, />ASUS</);
  assert.match(pcBrandHtml, />Corsair</);

  mockDoc.getElementById('inv-type-filter').innerHTML = '';
  mod.renderPartTypeOptions();
  const pcTypeHtml = mockDoc.getElementById('inv-type-filter').innerHTML;
  assert.doesNotMatch(pcTypeHtml, />LCD/);
  assert.match(pcTypeHtml, />Graphics Cards \(GPU\)/);
});

dbTest('fractional stock adjust, CSV import, reorder suggestions, and warranty return round-trip', (db) => {
  const cable = createInventoryItem(db, {
    item_name: 'CAT6 Patch Cable',
    category: 'Cables',
    uom: 'm',
    allow_fractional: 1,
    cost_price: 20,
    price_retail: 50,
    price_technician: 40,
    stock_quantity: 1.5
  });
  assert.strictEqual(adjustStock(db, cable.id, 0.25, { reason: 'receive' }).stock_quantity, 1.75);
  assert.strictEqual(adjustStock(db, cable.id, -0.5, { reason: 'correction' }).stock_quantity, 1.25);

  const phonePart = createInventoryItem(db, {
    brand: 'Apple',
    model_name: 'iPhone 13',
    part_type: 'LCD',
    cost_price: 1000,
    price_retail: 2000,
    stock_quantity: 2
  });
  assert.throws(() => adjustStock(db, phonePart.id, 0.5), /must be an integer/);

  const imp = importInventory(db, [{
    'Item Name': 'Copper Wire 2.5mm',
    'SKU / Barcode': 'WIRE-25',
    Category: 'Hardware',
    UOM: 'm',
    'Allow Fractional': '1',
    Capital: '30',
    'Retail Price': '60',
    'Stock Qty': '12.5'
  }]);
  assert.strictEqual(imp.created, 1);

  const imp2 = importInventory(db, [{
    'SKU / Barcode': 'WIRE-25',
    'Stock Qty': '2.5'
  }]);
  assert.strictEqual(imp2.updated, 1);
  const wire = listInventory(db, { search: 'WIRE-25' })[0];
  assert.strictEqual(wire.stock_quantity, 15);
  assert.strictEqual(wire.allow_fractional, 1);
  assert.strictEqual(wire.uom, 'm');

  const sale = createSale(db, {
    customer_name: 'Walk-in',
    payment_method: 'cash',
    items: [{ inventory_id: cable.id, quantity: 0.75 }],
    amount_paid: 37.5
  });

  const reorder = listReorderSuggestions(db, { days: 7 });
  const row = reorder.rows.find(r => r.id === cable.id);
  assert.ok(row, 'fractional sold item appears in reorder suggestions');
  assert.strictEqual(row.qty_sold, 0.75);
  assert.strictEqual(row.suggested_qty, 0.25);
  assert.strictEqual(row.item_name, 'CAT6 Patch Cable');

  const rma = createWarrantyReturn(db, {
    sale_id: sale.id,
    sale_item_id: sale.items[0].id,
    quantity: 0.5,
    return_type: 'cash_refund',
    refund_amount: 25
  });
  assert.strictEqual(rma.quantity, 0.5);
  assert.throws(() => createWarrantyReturn(db, {
    sale_id: sale.id,
    sale_item_id: sale.items[0].id,
    quantity: 0.3,
    return_type: 'cash_refund'
  }), /already returned 0\.5 of 0\.75/);
});

dbTest('inventory modal: submitAddPart keeps item_name null and openEditPartModal avoids service template for retail items', async () => {
  const block = invSource.replace(/^import\s+.*?;/gm, '').replace(/^export /gm, '');
  const domElements = {};
  const makeEl = () => ({ value: '', innerHTML: '', textContent: '', checked: false, classList: { contains: () => false, toggle: () => {}, add: () => {}, remove: () => {} } });
  const titleSpan = { textContent: '' };
  const mockDoc = {
    getElementById: id => domElements[id] || (domElements[id] = makeEl()),
    querySelector: sel => (sel === '#edit-part-title [data-i18n="part.edit_title"]' ? titleSpan : null),
    querySelectorAll: () => []
  };
  let postedBody = null;
  const mockS = {
    inventoryRowsCache: [
      { id: 10, brand: 'Coca-Cola', model_name: '1.5L', part_type: 'Beverages', category: 'Beverages', item_name: 'Coca-Cola 1.5L', stock_quantity: 5, cost_price: 50, price_retail: 75, price_technician: 70 },
      { id: 11, brand: 'Service', model_name: 'Board Rework', part_type: 'Service', category: 'Service', item_name: null, stock_quantity: 99, cost_price: 0, price_retail: 500, price_technician: 400 }
    ],
    inventoryItems: [],
    shopSettings: { business_type: 'hybrid' }
  };
  const mod = vm.runInNewContext(block + '\n; ({ submitAddPart, openEditPartModal })', {
    document: mockDoc,
    S: mockS,
    escHtml: s => String(s ?? ''),
    t: (k, fb) => fb,
    hasElevation: () => true,
    openModal: () => {},
    closeModal: () => {},
    confirmModal: async () => true,
    showToast: () => {},
    loadInventoryTable: () => {},
    loadPosCatalog: () => {},
    crypto: { randomUUID: () => 'uuid-test-1' },
    fetch: async (_url, opts) => {
      postedBody = JSON.parse(opts.body);
      return { ok: true, json: async () => ({ id: 99 }) };
    }
  });

  mockDoc.getElementById('part-name').value = '';
  mockDoc.getElementById('part-brand').value = 'Apple';
  mockDoc.getElementById('part-model').value = 'iPhone 13';
  mockDoc.getElementById('part-type').value = 'LCD (OLED)';
  mockDoc.getElementById('part-cost').value = '1500';
  mockDoc.getElementById('part-retail').value = '2500';
  mockDoc.getElementById('part-tech').value = '2100';
  mockDoc.getElementById('part-stock').value = '4';
  mockDoc.getElementById('part-min-alert').value = '2';
  await mod.submitAddPart({ preventDefault: () => {} });
  assert.strictEqual(postedBody.item_name, null, 'optional alias left blank must stay null instead of copying model_name');

  mod.openEditPartModal(10);
  assert.strictEqual(titleSpan.textContent, 'Edit Product', 'retail grocery item must not open as Edit Service / Labor');
  mod.openEditPartModal(11);
  assert.strictEqual(titleSpan.textContent, 'Edit Service / Labor', 'service item still opens as Edit Service / Labor');
});

dbTest('POS search matches item_name/category and cart quantity helpers handle fractional items', async () => {
  const posSource = fs.readFileSync(path.join(__dirname, '../public/js/views/pos.js'), 'utf8');
  const block = posSource
    .replace(/^import\s+\{[^}]+\}\s+from\s+['"][^'"]+['"];\r?\n/gm, '')
    .replace(/^export /gm, '');
  const domElements = {};
  const makeEl = () => ({ value: '', innerHTML: '', textContent: '', checked: false, classList: { contains: () => false, toggle: () => {}, add: () => {}, remove: () => {} }, closest: () => null, querySelector: () => null, querySelectorAll: () => [], setAttribute: () => {}, removeAttribute: () => {} });
  const mockDoc = {
    getElementById: id => domElements[id] || (domElements[id] = makeEl()),
    querySelector: () => null,
    querySelectorAll: () => []
  };
  let promptCalls = 0;
  let promptAnswer = '0.25';
  let lastStep = null;
  const toasts = [];
  const rice = { id: 7, brand: 'General', model_name: 'Dinorado', part_type: 'Grains', category: 'Produce', item_name: 'Dinorado Rice 1kg', uom: 'kg', allow_fractional: 1, price_retail: 60, price_technician: 55, stock_quantity: 0.75, min_stock_alert: 1 };
  const mockS = {
    posCatalog: [rice],
    inventoryItems: [rice],
    cart: [],
    shopSettings: { business_type: 'hybrid' },
    currentPriceTier: 'retail',
    currentPaymentMethod: 'cash',
    saleInFlight: false,
    activeDevice: ''
  };
  const mod = vm.runInNewContext(block + '\n; ({ getFilteredParts, quickAddPart, updateCartQty, editCartQtyPrompt, cartTotals })', {
    document: mockDoc,
    localStorage: { getItem: () => null, setItem: () => {} },
    S: mockS,
    escHtml: s => String(s ?? ''),
    fmtMoney: n => `P${Number(n).toFixed(2)}`,
    t: (k, fb) => fb,
    showToast: (m, lvl) => toasts.push({ m, lvl }),
    inputModal: async (_title, opts) => { promptCalls++; lastStep = opts.step; return promptAnswer; },
    confirmModal: async () => true,
    openModal: () => {},
    closeModal: () => {},
    isWholesaleTier: () => false,
    renderCustomerPicker: () => {},
    openReceiptModal: () => {},
    loadSalesTable: () => {},
    loadInventoryTable: () => {},
    refreshDashboard: () => {},
    loadCustomersTable: () => {},
    loadDashboardQuickPick: () => {},
    requirePinOrRun: async (_m, fn) => fn(),
    hasElevation: () => true,
    itemMatchesProfile: () => true,
    setCounterText: () => {},
    calculateChange: () => {},
    calculateCreditBalance: () => {},
    serializeCartForRecovery: () => '[]',
    deserializeCartForRecovery: () => [],
    window: { addEventListener: () => {} }
  });

  mockDoc.getElementById('pos-search-input').value = 'produce';
  assert.strictEqual(mod.getFilteredParts().length, 1, 'POS search matches item category');
  mockDoc.getElementById('pos-search-input').value = 'dinorado rice';
  assert.strictEqual(mod.getFilteredParts().length, 1, 'POS search matches item_name');

  mod.quickAddPart(7);
  assert.strictEqual(mockS.cart[0].qty, 0.75, 'fractional item with <1 stock adds available stock instead of exceeding to 1');

  promptAnswer = '0.4';
  await mod.editCartQtyPrompt(0);
  assert.strictEqual(promptCalls, 1);
  assert.strictEqual(lastStep, 'any');
  assert.strictEqual(mockS.cart[0].qty, 0.4);
  assert.strictEqual(mod.cartTotals().subtotal, 24);

  mod.updateCartQty(0, 1);
  assert.strictEqual(mockS.cart[0].qty, 0.75, 'fractional increment clamps at remaining stock 0.75 instead of overshooting');
  assert.strictEqual(mod.cartTotals().subtotal, 45);
});

dbTest('allow_fractional accepts the same truthy spellings the CSV import takes', (db) => {
  // The CSV path (parseBoolFlag) takes 1/true/yes; the API path must not
  // quietly disagree with "true" spelled out.
  for (const [flag, expected] of [['true', 1], ['yes', 1], [true, 1], [1, 1], ['no', 0], [0, 0], [undefined, 0]]) {
    const item = createInventoryItem(db, {
      item_name: `Flag ${String(flag)} ${expected}`,
      cost_price: 10,
      price_retail: 15,
      stock_quantity: 5,
      allow_fractional: flag
    });
    assert.strictEqual(item.allow_fractional, expected, `flag ${JSON.stringify(flag)} should store ${expected}`);
  }
});
