// phone-repair-pos/tests/barcode-scan.test.js
// Hardware-scanner behaviour at the repair counter: a USB scanner is a keyboard,
// so the app has to tell a scan burst apart from typing, and it must do it from
// wherever the caret happens to be — but only while the POS tab is open.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const src = read('public/js/views/pos.js');
const code = src.slice(
  src.indexOf('// BARCODE SCANNING'),
  src.indexOf('export async function loadPosCatalog')
).replace(/export /g, '');

const SCANNED = {
  id: 7, sku_barcode: '6941234567890', brand: 'Samsung', model_name: 'A14',
  part_type: 'LCD (Incell)', stock_quantity: 3, price_retail: 1800
};

// The browser inserts a printable character into a field only if the keydown
// handler let the default action through. Mirroring that here is what makes
// "the field keeps its own text" a real assertion instead of a guess.
function harness({ tab = 'pos', item = SCANNED, modal = null, gate = null, filtered = [] } = {}) {
  const S = {
    currentTab: tab, scanBuffer: '', lastScanKeyTime: 0,
    inventoryItems: [item], posCatalog: [item], cart: []
  };
  const toasts = [];
  const clock = { t: 1000 };
  let keydown = null;
  let pasteHandler = null;
  // The Enter handler schedules the scan one burst window out (so a CR
  // mid-payload can join instead of firing on the partial code); the harness
  // runs that timer on demand, like the browser would.
  const timers = [];
  let nextTimerId = 1;
  const drainTimers = () => {
    for (const t of timers.splice(0, timers.length)) if (!t.dead) t.fn();
  };

  const ctx = vm.createContext({
    S,
    Date: { now: () => clock.t },
    window: { addEventListener: (type, fn) => { if (type === 'keydown') keydown = fn; } },
    setTimeout: (fn) => { const id = nextTimerId++; timers.push({ id, fn }); return id; },
    clearTimeout: (id) => { const t = timers.find(x => x.id === id); if (t) t.dead = true; },
    document: {
      getElementById: () => null,
      querySelector: () => modal || gate || null,
      addEventListener: (type, fn) => { if (type === 'paste') pasteHandler = fn; }
    },
    showToast: (msg, kind) => toasts.push(`${kind}: ${msg}`),
    cartQtyFor: id => (S.cart.find(c => c.id === id) || {}).qty || 0,
    setPartQty: (id, delta) => {
      const line = S.cart.find(c => c.id === id);
      if (line) line.qty += delta; else S.cart.push({ id, qty: delta });
    },
    quickAddPart: id => S.cart.push({ id, qty: 1 }),
    renderPartsTable: () => {},
    getFilteredParts: () => filtered
  });
  vm.runInContext(code, ctx);
  ctx.initScanListeners();

  const field = (id, value = '') => ({ tagName: 'INPUT', id, value });
  const acceptsText = t => t.tagName === 'INPUT' || t.tagName === 'TEXTAREA';
  const send = (key, target) => {
    const ev = { key, target, prevented: false, preventDefault() { this.prevented = true; } };
    keydown(ev);
    if (key.length === 1 && !ev.prevented && acceptsText(target)) target.value += key;
    return ev;
  };
  const sendChars = (text, target) => {
    for (const ch of text) { send(ch, target); clock.t += 5; }
  };
  const pressEnter = (target) => send('Enter', target);
  // A scanner dumps its whole payload in one run: no gap above 100ms, Enter last.
  const scan = (text, target) => {
    sendChars(text, target);
    const ev = pressEnter(target);
    clock.t += 500;
    drainTimers();
    return ev;
  };
  // The parts search answers Enter itself, and a listener on the element runs
  // before the window one — so a scan into that box goes through both.
  const searchEnter = (input) => {
    const ev = { key: 'Enter', target: input, prevented: false, preventDefault() { this.prevented = true; } };
    ctx.onPartSearchKeydown(ev);
    keydown(ev);
    return ev;
  };
  const scanIntoSearch = (text, input) => {
    sendChars(text, input);
    const ev = searchEnter(input);
    clock.t += 500;
    drainTimers();
    return ev;
  };
  // Human typing: the same characters, but comfortably slower than a scanner.
  const typeSlowly = (text, target) => {
    for (const ch of text) { clock.t += 180; send(ch, target); }
    clock.t += 180;
    const ev = pressEnter(target);
    drainTimers();
    return ev;
  };
  const firePaste = () => { if (pasteHandler) pasteHandler(); };

  return { S, toasts, field, scan, scanIntoSearch, searchEnter, typeSlowly, sendChars, pressEnter, drainTimers, firePaste };
}

test('a scan burst typed into a counter field looks the part up instead of filling the field', () => {
  const h = harness();
  const name = h.field('pos-customer-name', 'Ali');
  h.scan('6941234567890', name);

  assert.deepEqual(h.S.cart, [{ id: 7, qty: 1 }], 'the scanned part should be in the cart');
  assert.equal(name.value, 'Ali', 'the barcode must not stay typed into the customer name');
  assert.ok(h.toasts.some(t => t.startsWith('success: Scanned:')), `expected a scan confirmation, got ${h.toasts}`);
});

test('scanning a phone box into the IMEI field records the number, it does not look up a part', () => {
  const h = harness();
  const imei = h.field('repair-imei');
  h.scan('356948035123456', imei);

  assert.equal(imei.value, '356948035123456', 'the IMEI must stay in its own field');
  assert.deepEqual(h.S.cart, [], 'an IMEI is not a part code and must not add a line');
});

test('scanning the unit label into the device field names the device, it does not look up a part', () => {
  const h = harness();
  const device = h.field('repair-device-input');
  h.scan('356948035123456', device);

  assert.equal(device.value, '356948035123456', 'the device box must keep what was scanned');
  assert.deepEqual(h.S.cart, [], 'a device serial is not a part code');
});

test('a scan into the tendered box pays an amount, it does not add a part', () => {
  const h = harness();
  const tendered = h.field('pos-tendered', '2');
  h.scan('6941234567890', tendered);

  assert.deepEqual(h.S.cart, [], 'money fields must never be reinterpreted as a part code');
  assert.equal(tendered.value, '26941234567890', 'the digits stay where the cashier aimed them');
});

test('a burst in the job note box is the technician typing fast, not a part code', () => {
  const h = harness();
  const note = { tagName: 'TEXTAREA', id: 'repair-note', value: 'ear ' };
  h.scan('6941234567890', note);

  assert.equal(note.value, 'ear 6941234567890', 'the note keeps its text even at scanner speed');
  assert.deepEqual(h.S.cart, [], 'a note is not a lookup');
});

test('typing a customer name at ordinary speed just types a name', () => {
  const h = harness();
  const name = h.field('pos-customer-name');
  h.typeSlowly('Maria Cristina', name);

  assert.equal(name.value, 'Maria Cristina', 'hand typing must survive');
  assert.deepEqual(h.S.cart, [], 'nobody scanned anything');
});

test('scanning an unregistered code into the parts search fails instead of adding the top match', () => {
  // The digits substring-match a real part, which is exactly how the old
  // typed-search fallback would have added the wrong item.
  const h = harness({ filtered: [SCANNED] });
  const search = h.field('pos-search-input');
  h.scanIntoSearch('9941234567890', search);

  assert.deepEqual(h.S.cart, [], 'an unknown code must not add a part');
  assert.ok(h.toasts.some(t => t.startsWith('warning: Unknown barcode')), `expected the unknown-code warning, got ${h.toasts}`);
});

test('scanning a registered code into the parts search confirms it as a scan', () => {
  const h = harness();
  const search = h.field('pos-search-input');
  h.scanIntoSearch('6941234567890', search);

  assert.deepEqual(h.S.cart, [{ id: 7, qty: 1 }], 'the scanned part should be in the cart');
  assert.ok(h.toasts.some(t => t.startsWith('success: Scanned:')), `a scan should read as a scan, got ${h.toasts}`);
});

// The old trap: a new repair parked the caret in the device box, so the first
// scan of the job typed a part barcode into the device name.
test('opening a new repair leaves the caret where a scan is useful', async () => {
  const main = read('public/js/main.js');
  const slice = main.slice(
    main.indexOf('export async function startNewSale()'),
    main.indexOf('// Top-bar search')
  ).replace(/export /g, '');

  let focused = '';
  const S = { saleInFlight: false, cart: [] };
  const ctx = vm.createContext({
    S,
    resetRepairCounter: () => {},
    switchTab: () => {},
    confirmModal: async () => true,
    document: { getElementById: id => ({ focus() { focused = id; } }) }
  });
  vm.runInContext(slice, ctx);
  await ctx.startNewSale();

  assert.equal(focused, 'pos-search-input', 'a new job should open scan-ready');
});

// Guards on the two checks this change reordered: the tab gate and the
// open-modal gate. Both predate the change, and a scan stays out of both.
test('a scan burst outside the POS tab stays in the field it landed in', () => {
  const h = harness({ tab: 'backoffice' });
  const note = h.field('some-other-field');
  h.scan('6941234567890', note);

  assert.deepEqual(h.S.cart, [], 'another tab must never be read as a part code');
  assert.equal(note.value, '6941234567890', 'the field keeps its text');
});

test('a scan burst while a dialog is open does not touch the cart behind it', () => {
  const h = harness({ modal: {} });
  const name = h.field('pos-customer-name');
  h.scan('6941234567890', name);

  assert.deepEqual(h.S.cart, [], 'the cart behind a modal is off limits');
  assert.equal(name.value, '6941234567890', 'and nothing is taken from the field');
});

// The login, license and PIN-setup overlays use .gate, not .modal-backdrop, so
// the modal guard never covered them: a burst during those gates still fed the
// scan buffer and the cart behind them.
test('a scan burst while a login or license gate is open does not touch the cart', () => {
  const h = harness({ gate: {} });
  const name = h.field('pos-customer-name');
  h.scan('6941234567890', name);

  assert.deepEqual(h.S.cart, [], 'the cart behind a gate is off limits');
  assert.equal(name.value, '6941234567890', 'and nothing is taken from the field');
});

// A CR can sit inside a scanner payload (multi-line 2D symbologies, or a reader
// programmed with CR as separator). The first Enter used to fire on the partial
// buffer — a spurious unknown-code buzz, or worse, a wrong part added — and the
// payload tail then re-accumulated as a second scan.
test('a CR inside a scanner payload joins the burst instead of scanning the partial code', () => {
  const h = harness();
  const name = h.field('pos-customer-name');

  h.sendChars('694123', name);
  h.pressEnter(name);          // the CR mid-payload: no scan yet
  h.sendChars('4567890', name); // the tail arrives inside the settle window
  const ev = h.pressEnter(name);
  h.drainTimers();

  assert.deepEqual(h.S.cart, [{ id: 7, qty: 1 }], 'the joined payload resolves once');
  assert.equal(h.toasts.filter(t => t.startsWith('warning: Unknown')).length, 0, 'no partial-code warning');
  assert.equal(h.toasts.filter(t => t.startsWith('success: Scanned:')).length, 1, 'exactly one scan confirmation');
  assert.equal(ev.prevented, true, 'the Enter is still consumed');
});

test('a CR inside a payload scanned into the parts search also joins first', () => {
  const h = harness();
  const search = h.field('pos-search-input');

  h.sendChars('694123', search);
  h.searchEnter(search);
  h.sendChars('4567890', search);
  h.searchEnter(search);
  h.drainTimers();

  assert.deepEqual(h.S.cart, [{ id: 7, qty: 1 }], 'the joined payload resolves once');
  assert.equal(h.toasts.filter(t => t.startsWith('warning: Unknown')).length, 0, 'no partial-code warning');
});

// The hijack restore puts the field back to what it held when the burst began.
// A paste inside that window is human input the restore must not discard.
test('a paste into a field is not wiped by a burst that was already in flight', () => {
  const h = harness();
  const name = h.field('pos-customer-name', 'Al');

  h.sendChars('6941', name);   // the burst starts; the field held 'Al'
  name.value += 'Mara';        // the browser inserts the pasted text
  h.firePaste();               // ...and fires the paste event
  h.sendChars('234567890', name);
  h.pressEnter(name);
  h.drainTimers();

  assert.deepEqual(h.S.cart, [{ id: 7, qty: 1 }], 'the scan itself still resolves');
  assert.ok(name.value.includes('Mara'), `the pasted text must survive, got "${name.value}"`);
});

test('a slow human Enter after a scan burst does not fire a second scan', () => {
  const h = harness();
  const name = h.field('pos-customer-name');
  h.scan('6941234567890', name);
  assert.deepEqual(h.S.cart, [{ id: 7, qty: 1 }]);

  // The operator presses Enter again, well after the burst window closed.
  h.pressEnter(name);
  h.drainTimers();
  assert.deepEqual(h.S.cart, [{ id: 7, qty: 1 }], 'a stray Enter must not rescan the last code');
});
