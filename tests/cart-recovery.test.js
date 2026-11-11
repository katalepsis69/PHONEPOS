const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const pos = source('public/js/views/pos.js');
const main = source('public/js/main.js');
const savedCart = [
  { id: 1, brand: 'Apple', model_name: 'iPhone 15', part_type: 'LCD', price_retail: 100, qty: 2 },
  { is_labor: true, name: 'Screen fitting', unit_price: 50, qty: 1 }
];

async function harness(raw, cart = []) {
  const recovery = await import('../public/js/cart-recovery.js');
  const storage = new Map([['pos_cart_recovery', raw]]);
  const writes = [];
  const elements = new Map();
  const messages = [];
  const getElementById = id => {
    if (!elements.has(id)) elements.set(id, {
      value: '', textContent: '', innerHTML: '', closest: () => null, querySelector: () => null,
      classList: { toggle: () => {}, add: () => {}, remove: () => {} }
    });
    return elements.get(id);
  };
  const context = vm.createContext({
    ...recovery,
    S: { cart, currentPriceTier: 'retail', currentPaymentMethod: 'cash' },
    document: { getElementById, querySelector: () => null },
    localStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => { storage.set(key, value); writes.push(JSON.parse(value)); }
    },
    escHtml: value => String(value),
    fmtMoney: value => Number(value).toFixed(2),
    setCounterText: (id, value) => { getElementById(id).textContent = value; },
    showToast: message => messages.push(message),
    calculateChange() {}, calculateCreditBalance() {},
    fetch: async () => ({ ok: true, json: async () => [] }),
    console,
    populateDeviceDatalist() {}, renderBrandOptions() {}, renderPartTypeOptions() {},
    renderInvBrandFilter() {}, renderCategoryOptions() {}, renderRepairRef() {},
    renderSummaryDevice() {}, renderPartsTable() {},
    loadShopSettings: async () => {}, loadCustomerSuggestions: async () => {}, refreshDraftChip() {}
  });
  // Execute actual rendering/recovery and catalog functions, avoiding circular UI imports.
  const rendering = pos.slice(pos.indexOf('export function renderOrderLines()'), pos.indexOf('export function setPaymentMethod('));
  // loadPosCatalog restores the refused-scan chip, so the helpers block that
  // defines it rides along with the slices that run it.
  const refusals = pos.slice(pos.indexOf('// Refused scans the counter could not act on'), pos.indexOf('let highlightedPartIndex = -1;'));
  const catalog = pos.slice(pos.indexOf('export async function loadPosCatalog()'), pos.indexOf('export function renderRepairRef()'));
  vm.runInContext(`${refusals}\n${rendering}\n${catalog}`.replace(/export /g, ''), context);
  return { context, storage, writes, elements, messages };
}

test('startup preserves saved cart before catalog persistence and displays recovered lines', async () => {
  const h = await harness(JSON.stringify(savedCart));
  // Exercise the real startup sequence, including catalog loading and its renderCart call.
  const boot = main.slice(main.indexOf('  await loadShopSettings();', main.indexOf("document.addEventListener('DOMContentLoaded'")), main.indexOf('  // Dashboard data loads lazily'));
  assert.ok(boot.includes('loadPosCatalog()'));
  await vm.runInContext(`(async () => { ${boot} })()`, h.context);
  assert.deepEqual(JSON.parse(h.storage.get('pos_cart_recovery')), savedCart);
  assert.ok(h.writes.length >= 2, 'recovery and catalog both render');
  for (const write of h.writes) assert.deepEqual(write, savedCart, 'no empty startup overwrite');
  assert.match(h.elements.get('sum-parts').innerHTML, /Apple iPhone 15/);
  assert.match(h.elements.get('sum-services').innerHTML, /Screen fitting/);
  assert.equal(h.elements.get('pos-total').textContent, '250.00');
  assert.equal(h.messages.length, 1);
});

test('recovery immediately renders both parts and labor without waiting for catalog', async () => {
  const h = await harness(JSON.stringify(savedCart));
  h.context.restoreCartRecovery();
  assert.match(h.elements.get('sum-parts').innerHTML, /Apple iPhone 15/);
  assert.match(h.elements.get('sum-services').innerHTML, /Screen fitting/);
  assert.equal(h.elements.get('pos-total').textContent, '250.00');
});

test('empty or invalid recovery does not replace the current cart or persist data', async () => {
  for (const raw of ['', 'invalid JSON', '{}', '[]']) {
    const h = await harness(raw);
    h.context.restoreCartRecovery();
    assert.equal(h.context.S.cart.length, 0);
    assert.equal(h.writes.length, 0);
    assert.equal(h.messages.length, 0);
  }
  const active = [{ is_labor: true, name: 'Active job', unit_price: 25, qty: 1 }];
  const h = await harness(JSON.stringify(savedCart), active);
  h.context.restoreCartRecovery();
  assert.equal(h.context.S.cart, active);
  assert.equal(h.writes.length, 0);
  assert.equal(h.messages.length, 0);
});
