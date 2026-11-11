const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const source = file => fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/\r\n/g, '\n');
const pos = source('public/js/views/pos.js');
const main = source('public/js/main.js');
const ui = source('public/js/ui.js');
const state = source('public/js/state.js');
const auth = source('public/js/auth.js');
const inventory = source('public/js/views/inventory.js');
const backoffice = source('public/js/views/backoffice.js');
const styles = source('public/styles.css');
const index = source('public/index.html');
const report = source('public/report.html');
const reportJs = source('public/js/report.js');

// ---------------------------------------------------------------- in-flight sale lock
test('checkout locks every transaction mutation path while the sale POST is in flight', () => {
  for (const fn of ['export function quickAddPart(partId) {', 'export async function clearRepairOrder() {',
    'export async function saveRepairDraft() {', 'export function updateCartQty(index, delta) {',
    'export function removeCartItem(index) {', 'export function setPaymentMethod(method) {']) {
    const start = pos.indexOf(fn);
    assert.ok(start > 0, `${fn} exists`);
    const head = pos.slice(start, start + 200);
    assert.match(head, /S\.saleInFlight\) return/, `${fn} guards against in-flight sale`);
  }
  // The button says what is happening and is disabled, then restored in finally.
  const flight = pos.slice(pos.indexOf('S.saleInFlight = true;'), pos.indexOf('export async function openShiftPrompt'));
  assert.match(flight, /checkoutBtn\.disabled = true/);
  assert.match(flight, /Processing payment…/);
  assert.match(flight, /finally \{[\s\S]*?S\.saleInFlight = false;[\s\S]*?checkoutBtn\.disabled = false/);
  // The success path clears the flag BEFORE resetRepairCounter so its
  // internal setPaymentMethod('cash') isn't blocked by the in-flight guard.
  const successIdx = flight.indexOf("S.saleInFlight = false;\n    resetRepairCounter();");
  assert.ok(successIdx > -1, 'flag drops before the success-path reset');
});

// ---------------------------------------------------------------- settlement receipt
// The highest-value pin of the old set, executed instead of text-matched: the
// in-flight lock and the op_id persistence are what stop a double ring-up and a
// double-charge on retry, and a source pin cannot show either working.
test('completeSale executes: the in-flight lock, the op_id round trip, and the button state', async () => {
  const start = pos.indexOf('export async function completeSale()');
  const end = pos.indexOf('export async function openShiftPrompt');
  assert.ok(start > 0 && end > start, 'completeSale moved; update this test');
  const fnSource = pos.slice(start, end).replace(/export /g, '');

  const build = ({ saleOpId = null, storedOpId = null, fetchImpl } = {}) => {
    const calls = { fetch: 0, toasts: [], setItem: [], order: [] };
    const button = { disabled: false, querySelector: () => ({ textContent: '' }) };
    const S = {
      saleInFlight: false,
      saleOpId,
      lastSaleForReprint: null,
      currentPaymentMethod: 'cash',
      currentPriceTier: 'retail',
      cart: [{ id: 1, qty: 1, is_labor: false, name: 'LCD', unit_price: 100 }]
    };
    const ctx = vm.createContext({
      S,
      SALE_OP_KEY: 'pos_sale_op_id',
      autoPrintHintShown: false,
      showToast: (m, t) => calls.toasts.push(`${t}:${m}`),
      t: (k, fb) => fb || k,
      cartTotals: () => ({ discount: 0, total: 100 }),
      unitPriceOf: () => 100,
      deviceNoteLine: () => '',
      toCents: (v) => Math.round(v * 100),
      fmtMoney: (v) => `P${v}`,
      resetRepairCounter: () => calls.order.push(`reset:${S.saleInFlight}`),
      loadPosCatalog: () => {},
      loadCustomerSuggestions: () => {},
      renderReceipt: () => {},
      openModal: () => {},
      shopIdentityIsPlaceholder: () => false,
      autoPrintEnabled: () => false,
      autoPrintSlip: () => Promise.resolve(true),
      localStorage: { getItem: () => storedOpId, setItem: (k, v) => calls.setItem.push([k, v]) },
      sessionStorage: { getItem: () => '1' },
      crypto: { randomUUID: () => 'generated-op-id' },
      document: {
        querySelector: (sel) => (sel === '[data-action="complete-sale"]' ? button : null),
        getElementById: (id) => (id === 'pos-tendered' ? { value: '200' } : (id === 'pos-customer-name' ? { value: 'Ana' } : null))
      },
      fetch: async (url, opts) => { calls.fetch++; return fetchImpl(url, opts); }
    });
    vm.runInContext(fnSource, ctx);
    return { ctx, S, button, calls };
  };

  // Two overlapping calls: the second returns before the network, and the
  // button is disabled for the whole flight.
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const busy = build({ fetchImpl: async () => { await gate; return { ok: true, json: async () => ({ id: 7, sale_code: 'SALE-7' }) }; } });
  const first = vm.runInContext('completeSale', busy.ctx)();
  assert.equal(busy.S.saleInFlight, true, 'the flag must be set before the await');
  assert.equal(busy.button.disabled, true, 'the checkout button must be disabled during the flight');
  await vm.runInContext('completeSale', busy.ctx)();
  assert.equal(busy.calls.fetch, 1, 'a second click must not send a second sale');
  release();
  await first;
  assert.equal(busy.calls.fetch, 1);
  assert.equal(busy.button.disabled, false, 'the button must come back after the sale');
  assert.equal(busy.S.saleInFlight, false);
  assert.ok(busy.calls.toasts.some(t => t.startsWith('success:')), 'a completed sale must toast');

  // The op_id: a stored one is adopted and sent as-is, so a retry after a lost
  // response replays instead of charging twice.
  const replay = build({ storedOpId: 'op-from-last-attempt', fetchImpl: async () => ({ ok: true, json: async () => ({ id: 8, sale_code: 'SALE-8' }) }) });
  await vm.runInContext('completeSale', replay.ctx)();
  assert.equal(replay.S.saleOpId, 'op-from-last-attempt', 'the stored op_id must be adopted');
  assert.deepEqual(replay.calls.setItem[0], ['pos_sale_op_id', 'op-from-last-attempt'], 'the adopted op_id must be persisted');

  // The success path drops the flag BEFORE resetRepairCounter, whose internal
  // setPaymentMethod stands down while a sale is in flight.
  assert.ok(replay.calls.order.includes('reset:false'), 'the flag must be cleared before the success-path reset');

  // A failed send still hands the button back and keeps the op_id for the retry.
  const failed = build({ fetchImpl: async () => ({ ok: false, json: async () => ({ error: 'no printer stock' }) }) });
  await vm.runInContext('completeSale', failed.ctx)();
  assert.equal(failed.button.disabled, false, 'a failed sale must re-enable the button');
  assert.equal(failed.S.saleInFlight, false);
  assert.ok(failed.calls.toasts.some(t => t.startsWith('error:')), 'a failed sale must say so');
  assert.equal(failed.S.saleOpId, 'generated-op-id', 'the minted op_id survives for the retry');
});

// settlement receipt
test('settlement receipt prints the confirmed payment from the settle response', () => {
  const settle = backoffice.slice(backoffice.indexOf('settleInFlight = true;'), backoffice.indexOf('export async function editCreditLimitPrompt'));
  // Receipt is rendered from the settle response BEFORE any screen refresh…
  assert.match(settle, /const details = await res\.json\(\);/);
  assert.match(settle, /const payment = details\.payments\[0\];/);
  assert.match(settle, /renderSettlementReceipt\(payment, details\)/);
  const receiptIdx = settle.indexOf('renderSettlementReceipt');
  const refreshIdx = settle.indexOf('await openCustomerLedger(');
  assert.ok(receiptIdx > -1 && refreshIdx > receiptIdx, 'receipt renders before ledger refresh');
  // …and a refresh failure cannot read as a failed payment.
  assert.match(settle, /catch \(refreshErr\) \{[\s\S]*?Payment recorded — the ledger view could not refresh/);
});

// The same ordering, executed: the slip comes from the confirmed response, and
// a ledger-refresh failure after it warns instead of reporting the payment as
// failed.
test('a settlement ledger refresh failure never reads as a failed payment', async () => {
  const body = backoffice
    .slice(backoffice.indexOf('settleInFlight = true;'), backoffice.indexOf('export async function editCreditLimitPrompt'));
  const trimmed = body.slice(0, body.lastIndexOf('}'));

  const run = async ({ refreshFails }) => {
    const calls = { receipts: [], toasts: [], order: [] };
    const response = {
      ok: true,
      json: async () => ({ customer_name: 'Ana Cruz', payments: [{ id: 42, customer_name: 'Ana Cruz', amount_paid: 200 }] })
    };
    const ctx = vm.createContext({
      S: { activeCustomerDetails: { customer_name: 'Ana Cruz' } },
      amount: 200,
      method: 'cash',
      ref: '',
      e: { preventDefault: () => {} },
      settleInFlight: false,
      pendingSettleOpId: null,
      pendingSettleCustomer: null,
      newOpId: () => 'settle-op-1',
      showToast: (m, t) => calls.toasts.push(`${t}:${m}`),
      t: (k, fb) => fb || k,
      fmtMoney: (v) => `P${v}`,
      hasElevation: () => true,
      requireManagerPin: () => {},
      renderSettlementReceipt: (payment) => { calls.receipts.push(payment.id); calls.order.push('receipt'); },
      openModal: () => {},
      shopIdentityIsPlaceholder: () => false,
      autoPrintEnabled: () => false,
      autoPrintSlip: () => Promise.resolve(true),
      openCustomerLedger: async () => { calls.order.push('ledger'); if (refreshFails) throw new Error('ledger exploded'); },
      loadCustomers: () => {},
      loadCustomerSuggestions: () => {},
      loadDashboardData: () => {},
      console,
      window: { print: () => {} },
      fetch: async () => response
    });
    await vm.runInContext(`(async function(){\n${trimmed}\n})()`, ctx);
    return calls;
  };

  const ok = await run({ refreshFails: false });
  assert.deepEqual(ok.receipts, [42], 'the slip must come from the settle response payment');
  assert.deepEqual(ok.order, ['receipt', 'ledger'], 'the receipt must render before the ledger refresh');
  assert.ok(ok.toasts.some(t => t.startsWith('success:')), 'a recorded payment must toast success');

  const broken = await run({ refreshFails: true });
  assert.deepEqual(broken.receipts, [42], 'the slip must still be the confirmed payment');
  assert.ok(broken.toasts.some(t => t.includes('Payment recorded') && t.startsWith('warning:')),
    'a refresh failure must be a warning, not a failed payment');
  assert.ok(!broken.toasts.some(t => t.startsWith('error:')), 'a refresh failure must not read as an error');
});

// ---------------------------------------------------------------- dialog stack
test('dialogs form a stack: top-only escape, inert lower layers, per-layer focus restore', () => {
  assert.match(state, /modalStack: \[\]/);
  assert.match(ui, /S\.modalStack\.push\(\{ id, prevFocus: document\.activeElement \}\)/);
  assert.match(ui, /export function currentTopModalId\(\)/);
  assert.match(ui, /export function closeTopModal\(\)/);
  assert.match(ui, /el\.inert = modalOpen && el\.id !== topId/);
  // Escape closes ONE layer, not every visible modal.
  assert.match(main, /const top = currentTopModalId\(\);[\s\S]*?closeTopModal\(\)/);
  // Shortcuts stand down behind any modal or gate.
  assert.match(main, /const overlayOpen = document\.querySelector\('\.modal-backdrop:not\(\.hidden\)'\)[\s\S]*?if \(overlayOpen\) return;/);
});

test('modal stack behaves: nesting, inert lower layers, and Tab containment', () => {
  const slice = ui.slice(ui.indexOf('let modalTrapInited'), ui.indexOf('export function initConfirmModal'));
  const els = new Map();
  const listeners = [];
  const backdropIds = ['modal-a', 'modal-b'];
  const makeEl = id => {
    const el = {
      id, hidden: true, inert: false, focused: 0,
      classList: {
        add: c => { if (c === 'hidden') el.hidden = true; },
        remove: c => { if (c === 'hidden') el.hidden = false; },
        contains: c => c === 'hidden'
      },
      setAttribute() {},
      getAttribute: () => null,
      querySelector: () => ({ focus() { el.focused++; } }),
      querySelectorAll: () => [],
      contains: () => false
    };
    return el;
  };
  backdropIds.forEach(id => els.set(id, makeEl(id)));
  const app = { inert: false };
  const document = {
    getElementById: id => els.get(id) || null,
    addEventListener: (type, fn) => { if (type === 'keydown') listeners.push(fn); },
    querySelector: sel => {
      if (sel === '.app') return app;
      if (sel.startsWith('.modal-backdrop:not')) {
        return backdropIds.map(id => els.get(id)).find(el => !el.hidden) || null;
      }
      return null;
    },
    querySelectorAll: sel => (sel.startsWith('.modal-backdrop') ? backdropIds.map(id => els.get(id)) : [])
  };
  const S = { modalStack: [], lastFocusedEl: null };
  // closeModal() now retires the receipt modal's print declaration on every
  // dismissal (see the modal test further down); this slice has no receipts.js
  // in it, so the call is stubbed and counted instead of resolved.
  const cleared = [];
  const ctx = vm.createContext({ S, document, clearModalSlip: (id) => cleared.push(id) });
  vm.runInContext(slice.replace(/export /g, ''), ctx);

  vm.runInContext("openModal('modal-a')", ctx);
  assert.ok(app.inert, 'app inert behind modal');
  vm.runInContext("openModal('modal-b')", ctx);
  assert.equal(els.get('modal-a').inert, true, 'lower layer inert');
  assert.equal(els.get('modal-b').inert, false, 'top layer interactive');
  // Reopening an already-open id must not duplicate stack entries.
  vm.runInContext("openModal('modal-b')", ctx);
  assert.equal(S.modalStack.length, 2, 'no duplicate entries');
  vm.runInContext("closeModal('modal-b')", ctx);
  assert.equal(S.modalStack.length, 1);
  assert.equal(els.get('modal-a').inert, false, 'lower layer interactive again');
  // The dismissal forwarded its id, which is how the receipt modal's declared
  // print payload gets retired. Every other dialog is reported too and simply
  // has no declaration to clear.
  assert.deepEqual(cleared, ['modal-b'], 'closeModal() did not report the dismissed id to clearModalSlip()');
  // Tab containment pulls focus back into the top layer.
  const tab = listeners[0];
  const evt = { key: 'Tab', shiftKey: false, prevented: false, preventDefault() { evt.prevented = true; } };
  els.get('modal-a').querySelectorAll = () => [{ focus() {} }];
  tab(evt);
  assert.equal(evt.prevented, true, 'Tab outside the modal is contained');
});

// ---------------------------------------------------------------- archive semantics
test('archive/unarchive copy, endpoint, and toast follow the item\u2019s CURRENT state', () => {
  assert.match(inventory, /export async function archiveInventoryItemPrompt\(id, isArchived\)/);
  assert.match(inventory, /isArchived \? 'unarchive' : 'archive'/);
  assert.match(inventory, /isArchived \? 'Part restored to the catalog' : 'Part archived'/);
  assert.match(main, /'archive-part': el => archiveInventoryItemPrompt\(Number\(el\.dataset\.partId\), false\)/);
  assert.match(main, /'unarchive-part': el => archiveInventoryItemPrompt\(Number\(el\.dataset\.partId\), true\)/);
});

// ---------------------------------------------------------------- setup partial failure
test('pin setup verifies every step and retries only the unfinished ones', () => {
  assert.match(auth, /let pinSetupPinChanged = false;/);
  assert.match(auth, /if \(pinSetupPinChanged\) \{[\s\S]*?PIN already set/);
  assert.match(auth, /const settingsRes = await fetch\('\/api\/settings'[\s\S]*?if \(!settingsRes\.ok\)/);
  assert.match(auth, /const seedRes = await fetch\('\/api\/inventory\/seed-starter'[\s\S]*?if \(!seedRes\.ok\) showToast/);
});

// ---------------------------------------------------------------- error/empty state honesty
test('failed catalog loads get a retry state, never the empty-shelf copy', () => {
  assert.match(pos, /S\.catalogLoadFailed = true;/);
  assert.match(pos, /Couldn't load the parts catalog/);
  assert.match(pos, /data-action="reload-catalog"/);
  assert.match(inventory, /data-action="reload-inventory"/);
  assert.match(main, /'reload-catalog': \(\) => loadPosCatalog\(\)/);
  assert.match(main, /'reload-inventory': \(\) => loadInventoryTable\(\)/);
});

// ---------------------------------------------------------------- PIN fields announce
test('PIN fields are labelled and their errors are announced', () => {
  assert.match(index, /id="login-gate-pin"[^>]*aria-label="PIN"/);
  assert.match(index, /id="login-gate-pin"[^>]*aria-describedby="login-gate-error"/);
  assert.match(index, /id="pin-input"[^>]*aria-label="Manager PIN"/);
  assert.match(index, /id="login-gate-error"[^>]*role="alert"/);
  assert.match(index, /id="pin-error"[^>]*role="alert"/);
  assert.match(index, /id="pin-setup-error"[^>]*role="alert"/);
  assert.match(auth, /setAttribute\('aria-invalid', 'true'\)/);
});

// ---------------------------------------------------------------- theme/print/mobile CSS
test('danger badge ink stays readable in both themes', () => {
  assert.match(styles, /--danger-ink: #FFFFFF;/);
  assert.match(styles, /--danger-ink: #2B1514;/);
  assert.match(styles, /\.rail-count \{[\s\S]*?color: var\(--danger-ink\);/);
});

test('thermal print rules no longer blank the report page', () => {
  assert.match(styles, /body:has\(#printable-receipt\) > \*:not\(#printable-receipt\)/);
  assert.match(styles, /#printable-receipt,\s*#printable-receipt \* \{[\s\S]*?color: #000 !important/);
  assert.match(report, /@media print \{[\s\S]*?\.rpt-card[\s\S]*?background: #fff !important/);
});

test('stacked checkout and phone chrome get honest layout', () => {
  const stacked = styles.slice(styles.indexOf('.counter {\n    grid-template-columns: 1fr;'));
  assert.match(stacked, /\.summary \{[\s\S]*?height: auto !important;[\s\S]*?overflow: visible !important;/);
  // Toasts hang top-right: bottom-right sat exactly on "Take payment & print".
  assert.match(styles, /#toast-container \{\s*position: fixed;\s*\/\* Top-right[\s\S]*?top: 16px;\s*right: 16px;/);
  assert.match(styles, /#toast-container \{\s*top: calc\(12px \+ env\(safe-area-inset-top\)\);/);
  const phone = styles.slice(styles.indexOf('@media (max-width: 480px) {'));
  assert.match(phone, /\.workspace \{[\s\S]*?env\(safe-area-inset-left\)\) !important;/);
});

test('reduced motion also drops stagger delays', () => {
  const rm = styles.slice(styles.indexOf('@media (prefers-reduced-motion: reduce)'));
  assert.match(rm, /animation-delay: 0s !important;/);
});

// ---------------------------------------------------------------- report freshness
test('report polling renders only the latest response and resets on sign-out', () => {
  // Logic lives in the external file the CSP-safe script tag loads.
  assert.match(report, /<script src="js\/report\.js"><\/script>/);
  assert.ok(!report.includes('<script>'), 'no inline script: CSP script-src must not need unsafe-inline');
  assert.match(reportJs, /var gen = \+\+refreshGen;/);
  assert.match(reportJs, /if \(gen !== refreshGen\) return;/);
  assert.match(reportJs, /new AbortController\(\)/);
  assert.match(reportJs, /REFRESH_TIMEOUT_MS/);
  assert.match(reportJs, /refreshGen\+\+; \/\/ any in-flight response can no longer render stale figures/);
  assert.match(reportJs, /\$\('sales-list'\)\.innerHTML = '';/);
});

test('setup overlay follows dialog and toggle accessibility standards', () => {
  assert.match(index, /id="pin-setup-overlay"[^>]*role="dialog"[^>]*aria-modal="true"[^>]*aria-labelledby="pin-setup-title"/);
  assert.match(index, /id="pin-setup-title"[^>]*>Set Up Your Shop<\/h2>/);
  assert.match(index, /id="pin-setup-new"[^>]*aria-required="true"/);
  assert.match(index, /id="pin-setup-confirm"[^>]*aria-required="true"/);
  assert.match(index, /role="group"[^>]*aria-labelledby="setup-width-label"/);
  assert.match(index, /data-action="setup-width"[^>]*aria-pressed="true"/);
  assert.doesNotMatch(index, /id="setup-seed-parts"[^>]*focus:ring-0/);
});



// ---------------------------------------------------------------- silent auto-print
test('launcher forces its own browser profile so --kiosk-printing cannot be dropped', () => {
  const serverSrc = source('src/server.js');
  // An already-running Edge/Chrome adopts the URL and ignores per-launch
  // flags; the dedicated --user-data-dir forces a fresh process that keeps
  // the flag (and therefore silent auto-print).
  assert.match(serverSrc, /--kiosk-printing --no-first-run --no-default-browser-check --user-data-dir=/);
  assert.match(serverSrc, /--app=\$\{url\}#kiosk=1/);
});

test('launcher hardens browser profile and flags against cloud sync, auto-sign-in, and popups', () => {
  const { prepareBrowserProfile } = require('../src/server');
  const serverSrc = source('src/server.js');
  const htmlSrc = source('public/index.html');

  assert.match(serverSrc, /--disable-sync/);
  assert.match(serverSrc, /--disable-features=[^ ]*Translate/);
  assert.match(serverSrc, /--disable-session-crashed-bubble/);
  assert.match(serverSrc, /--hide-crash-restore-bubble/);
  assert.match(serverSrc, /--disable-save-password-bubble/);
  assert.match(serverSrc, /--disable-infobars/);
  assert.match(serverSrc, /--start-maximized/);
  assert.match(serverSrc, /--disable-devtools/);
  assert.match(serverSrc, /--disable-extensions/);

  assert.match(htmlSrc, /translate="no"/);
  assert.match(htmlSrc, /<meta name="google" content="notranslate">/);
  assert.match(main, /window\.addEventListener\('dragover'/);
  assert.match(main, /window\.addEventListener\('drop'/);

  const os = require('node:os');
  const fs = require('node:fs');
  const path = require('node:path');
  const tempProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-test-profile-'));
  try {
    const defaultDir = path.join(tempProfile, 'Default');
    fs.mkdirSync(defaultDir, { recursive: true });
    fs.writeFileSync(path.join(defaultDir, 'Preferences'), JSON.stringify({
      account_info: [{ email: 'leaked@example.com' }],
      sync_profile_info: { edge_san_is_option_explicitly_selectedby_user: false },
      sync: { keep_everything_synced: true, has_setup_completed: true },
      signin: { allowed: true }
    }));
    fs.writeFileSync(path.join(tempProfile, 'Local State'), JSON.stringify({
      profile: { info_cache: { Default: { user_name: 'leaked@example.com', edge_sync_enabled: true } } }
    }));

    const ok = prepareBrowserProfile(tempProfile);
    assert.strictEqual(ok, true);

    const updatedPref = JSON.parse(fs.readFileSync(path.join(defaultDir, 'Preferences'), 'utf8'));
    assert.deepStrictEqual(updatedPref.account_info, []);
    assert.strictEqual(updatedPref.sync_profile_info.edge_san_is_option_explicitly_selectedby_user, true);
    assert.strictEqual(updatedPref.sync.keep_everything_synced, false);
    assert.strictEqual(updatedPref.signin.allowed, false);
    assert.strictEqual(updatedPref.profile.password_manager_enabled, false);
    assert.strictEqual(updatedPref.profile.exited_cleanly, true);
    assert.strictEqual(updatedPref.translate.enabled, false);
    assert.strictEqual(updatedPref.edge.quick_search.show_mini_menu, false);
    assert.strictEqual(updatedPref.devtools.disabled, true);
    assert.strictEqual(updatedPref.download.prompt_for_download, false);

    const updatedLocal = JSON.parse(fs.readFileSync(path.join(tempProfile, 'Local State'), 'utf8'));
    assert.strictEqual(updatedLocal.fre.has_user_seen_fre, true);
    assert.strictEqual(updatedLocal.profile.info_cache.Default.user_name, '');
    assert.strictEqual(updatedLocal.profile.info_cache.Default.edge_sync_enabled, false);
  } finally {
    fs.rmSync(tempProfile, { recursive: true, force: true });
  }
});

test('auto-print knows whether the tab can print silently and says so', () => {
  assert.match(main, /location\.hash\.includes\('kiosk=1'\)\) sessionStorage\.setItem\('pos_kiosk', '1'\)/);
  assert.match(auth, /sessionStorage\.getItem\('pos_kiosk'\) === '1'/);
  assert.match(pos, /sessionStorage\.getItem\('pos_kiosk'\) !== '1' && !autoPrintHintShown/);
  assert.match(index, /id="kiosk-status"[^>]*role="status"/);
});

test('a no-sale test receipt rides the thermal machinery for the printer check', () => {
  const receipts = source('public/js/receipts.js');
  // async now: the ask goes to the server first (Task 5) and window.print() only
  // runs when that send fails, so the printable copy still has to be built here.
  assert.match(receipts, /export async function printTestReceipt\(\)/);
  assert.match(receipts, /applyPrintPageSize\(\)/);
  assert.match(receipts, /printable\.innerHTML = `/);
  // Page width is the roll, box width the printable window — a page narrower
  // than the driver's paper form gets centred and every line shifts right.
  assert.match(receipts, /@page \{ size: \$\{paperWidthMm\(\)\}mm/);
  assert.match(receipts, /measurePrintHeightPx\(printableMm\)/);
  assert.match(main, /'print-test': \(\) => printTestReceipt\(\)/);
  assert.match(index, /data-action="print-test"/);
  assert.ok(!/Test only —/.test(receipts), 'no em dash in printable test text');
});

// ---------------------------------------------------- sale-side ESC/POS printing
// The three customer-facing sale triggers now ask the server to print over
// ESC/POS and use the browser dialog only as the fallback. Source pins, like the
// rest of this file: the flow is a call order across four modules and a stub
// cannot show the queue ever being reached.
test('a sale receipt goes to the printer queue first and the dialog only as fallback', () => {
  const receipts = source('public/js/receipts.js');
  const backoffice = source('public/js/views/backoffice.js');
  const api = source('public/js/api.js');

  // printSlip: the ask, the answer shape, and the fallback contract.
  assert.match(receipts, /export async function printSlip\(payload\)/);
  assert.match(receipts, /fetch\('\/api\/print', \{\s*\n\s*method: 'POST'/);
  assert.match(receipts, /if \(res\.ok && data\.ok\) \{/);
  assert.match(receipts, /if \(data\.deduplicated\) showToast\(/);
  assert.match(receipts, /return true;/);
  assert.match(receipts, /return false;/, 'a failed send reports false so the caller prints');
  // The toast is the server's reason, which names the queue the send aimed at.
  assert.match(receipts, /showToast\(data\.error \|\|/);
  // fetch is wrapped in api.js, so printSlip's plain call is already authenticated.
  assert.match(api, /init\.headers\['Authorization'\] = `Bearer \$\{S\.sessionToken\}`/);

  // Every sale-side trigger: ESC/POS first, window.print() behind it. The
  // reprint carries drawer_kick:false — a reprint is not a sale, and the
  // route's default kick would pulse the drawer again.
  assert.match(receipts, /if \(!\(await printSlip\(\{ kind: 'sale', sale_id: S\.lastSaleForReprint\.id, drawer_kick: false \}\)\)\) window\.print\(\);/);
  assert.match(receipts, /if \(!\(await printSlip\(\{ kind: 'test' \}\)\)\) window\.print\(\);/);
  assert.match(pos, /autoPrintSlip\(\{ kind: 'sale', sale_id: sale\.id \}, \(\) => renderReceipt\(sale\)\)/);
  for (const [name, src] of [['receipts.js', receipts], ['views/backoffice.js', backoffice]]) {
    assert.match(src, /window\.print\(\)/, `${name} lost the browser fallback`);
  }
  // pos.js and the settlement path delegate to autoPrintSlip, which owns the
  // dialog and re-renders the right slip before printing it.

  // Render before the ask, both times: on the fallback path #printable-receipt
  // has to carry the slip, or the modal prints a blank page.
  const reprint = receipts.slice(receipts.indexOf('export async function reprintLastReceipt'));
  assert.ok(reprint.indexOf('renderReceipt(S.lastSaleForReprint)') < reprint.indexOf('printSlip('),
    'reprintLastReceipt asks the queue before it has anything to fall back to');
  // The settlement slip rides the same queue as the sale, behind the same
  // placeholder guard: a demo identity still means no auto-print at all, and the
  // dialog fires only when the queue refused.
  assert.match(pos, /if \(shopIdentityIsPlaceholder\(\)\) \{[\s\S]*?\} else if \(autoPrintEnabled\(\)\)/);
  assert.match(backoffice, /if \(shopIdentityIsPlaceholder\(\)\) \{[\s\S]*?\} else if \(autoPrintEnabled\(\)\)/,
    'the settlement auto-print lost its placeholder guard');
  assert.match(backoffice, /autoPrintSlip\(\s*\{ kind: 'settlement', payment_id: payment\.id, customer_name: payment\.customer_name \|\| details\.customer_name \},\s*\(\) => renderSettlementReceipt\(payment, details\)\s*\)/,
    'the settlement rides the same autoPrintSlip identity guard as the sale');
  assert.ok(!/setTimeout\(\(\) => window\.print\(\), 250\)/.test(backoffice),
    'the settlement auto-print still goes straight to the browser');
  const autoSettle = backoffice.slice(backoffice.indexOf('settleInFlight = true;'), backoffice.indexOf('export async function editCreditLimitPrompt'));
  assert.ok(autoSettle.indexOf('renderSettlementReceipt(payment, details)') < autoSettle.indexOf('autoPrintSlip('),
    'the settlement auto-print asks the queue before it has anything to fall back to');
});

// ---------------------------------------------------------------- printer picker
test('the printer picker lists queues and says so when there are none', () => {
  const index = source('public/index.html');
  const auth = source('public/js/auth.js');
  assert.match(index, /id="settings-printer"/);
  assert.match(index, /data-action="refresh-printers"/);
  assert.match(auth, /fetch\('\/api\/printers'\)/);
  assert.match(auth, /No printers found/);
  assert.match(auth, /Detecting printers/);
});

test('the picker saves the chosen queue and Refresh is wired through main.js', () => {
  assert.match(auth, /const printer_name = document\.getElementById\('settings-printer'\)\?\.value \|\| '';/);
  // Only a queue the operator actually moved rides the POST. The server
  // validates printer_name by enumerating the spooler again, and that read can
  // fail or burn its 15 s timeout, which would 400/502 an unrelated footer or
  // warranty edit. A picker that never loaded reads '' and is covered by the
  // same guard, so an unlucky save can never blank the saved queue either.
  assert.match(auth, /\.\.\.\(printer_name && printer_name !== \(S\.shopSettings\.printer_name \|\| ''\) \? \{ printer_name \} : \{\}\)/);
  assert.match(main, /'refresh-printers': \(\) => loadPrinters\(\)/);
  assert.match(main, /import \{[^}]*loadPrinters[^}]*\} from '\.\/auth\.js'/);
});

test('the settings save puts printer_name on the wire only when the queue changed', async () => {
  const save = auth.slice(auth.indexOf('export async function saveShopSettings('), auth.indexOf("// Security tab's own action"));
  const post = async ({ picker, saved }) => {
    const values = {
      'settings-gcash-name': 'Shop GCash', 'settings-owner-name': 'Owner',
      'settings-shop-address': 'Address', 'settings-gcash-number': '09170000000',
      'settings-gcash-qr': 'qr.png', 'settings-paper-width': '42', 'settings-printer': picker,
      'settings-warranty-days': '7', 'settings-settle-threshold': '500',
      'settings-warranty-policy': 'policy', 'settings-footer-note': 'footer',
      'settings-sync-url': '', 'settings-sync-token': ''
    };
    let body = null;
    const document = { getElementById: id => (id in values ? { value: values[id] } : null) };
    const fetch = async (_url, opts) => {
      body = JSON.parse(opts.body);
      return { ok: true, json: async () => ({ printer_name: body.printer_name ?? saved }) };
    };
    const S = { shopSettings: { printer_name: saved } };
    const ctx = vm.createContext({
      document, fetch, S, cleanQrPath: v => v,
      updateGcashUiDisplays() {}, enforcePinSetup() {}, closeModal() {}, showToast() {}
    });
    vm.runInContext(save.replace(/export /g, ''), ctx);
    await vm.runInContext('saveShopSettings({ preventDefault() {} })', ctx);
    return body;
  };
  // Unchanged selection: the field is absent, so the save cannot be taken down
  // by a queue enumeration nobody asked for.
  const same = await post({ picker: 'POS-58', saved: 'POS-58' });
  assert.ok(!('printer_name' in same), 'an untouched picker does not resend the queue');
  assert.equal(same.shop_footer_note, 'footer', 'the rest of the edit still saves');
  // Changed selection: the new queue is sent and validated exactly as before.
  assert.equal((await post({ picker: 'Xprinter XP-58', saved: 'POS-58' })).printer_name, 'Xprinter XP-58');
  // Never-loaded picker (Detecting/failed/empty all read ''): an unrelated save
  // neither resends nor blanks the stored queue.
  assert.ok(!('printer_name' in await post({ picker: '', saved: 'POS-58' })), 'an unloaded picker cannot clear the queue');
  // The first queue ever chosen, with nothing stored yet.
  assert.equal((await post({ picker: 'POS-58', saved: '' })).printer_name, 'POS-58');
});

// The real loadPrinters source against a stubbed document/fetch: every picker
// state is checkable without a queue installed on this machine.
const runPicker = async ({ ok = true, status = 200, payload, saved = '' }) => {
  const els = {
    'settings-printer': { disabled: true, innerHTML: '' },
    'settings-printer-note': { textContent: '' }
  };
  const document = { getElementById: id => els[id] || null };
  const S = { shopSettings: { printer_name: saved } };
  const escHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const fetch = async () => ({ ok, status, json: async () => payload });
  const load = auth.slice(auth.indexOf('export async function loadPrinters('), auth.indexOf('export function openSettingsModal('));
  const ctx = vm.createContext({ document, S, escHtml, fetch });
  vm.runInContext(load.replace(/export /g, ''), ctx);
  await vm.runInContext('loadPrinters()', ctx);
  return els;
};

const selectedOf = html => [...html.matchAll(/<option value="([^"]*)"[^>]*selected>/g)].map(m => m[1]);

test('the picker tells a dead lookup from an empty machine from a vanished saved queue', async () => {
  // 502: the server's own clipped reason is surfaced verbatim, and the select
  // never pretends to be a list.
  const down = await runPicker({ ok: false, status: 502, payload: { error: 'Could not check the printer list: spooler not responding' } });
  assert.equal(down['settings-printer-note'].textContent, 'Could not check the printer list: spooler not responding');
  assert.match(down['settings-printer'].innerHTML, /Printer list unavailable/);
  assert.equal(down['settings-printer'].disabled, true);
  // Zero queues on a working spooler: the empty machine says so out loud.
  const none = await runPicker({ payload: { printers: [] } });
  assert.match(none['settings-printer'].innerHTML, /No printers found/);
  assert.match(none['settings-printer-note'].textContent, /No printers found/);
  // A saved queue that is no longer installed is named in the note, the
  // default is preselected, offline stays listed when it discriminates, and
  // every label escapes.
  const gone = await runPicker({
    saved: 'ZZ GONE <>|',
    payload: { printers: [
      { name: 'POS-58', port: 'USB002', isDefault: true, offline: false },
      { name: 'Xprinter "Bad" XP-58', port: 'USB001', isDefault: false, offline: true }
    ] }
  });
  assert.match(gone['settings-printer'].innerHTML, /<option value="POS-58" selected>POS-58 \(USB002, default\)<\/option>/);
  assert.match(gone['settings-printer'].innerHTML, /Xprinter &quot;Bad&quot; XP-58 \(USB001, offline\)/);
  assert.match(gone['settings-printer-note'].textContent, /Saved printer "ZZ GONE <>\|" is not installed here/);
  // A saved queue that still exists is selected, and the note stays empty.
  const kept = await runPicker({
    saved: 'POS-58',
    payload: { printers: [{ name: 'POS-58', port: 'USB002', isDefault: true, offline: false }] }
  });
  assert.match(kept['settings-printer'].innerHTML, /<option value="POS-58" selected>/);
  assert.equal(kept['settings-printer-note'].textContent, '');
  assert.equal(kept['settings-printer'].disabled, false);
});

test('the offline tag only appears when it can discriminate', async () => {
  // This machine's live state: POS-58 worked and printed earlier today, and
  // Win32_Printer now reports BOTH queues WorkOffline, because the flag tracks
  // device sleep on a USB virtual port rather than printer health. Labelling
  // the shop's only working printer broken is worse than saying nothing, so a
  // spooler that reads offline across the board is noise the picker drops.
  const allAsleep = await runPicker({
    saved: 'POS-58',
    payload: { printers: [
      { name: 'Xprinter XP-58', port: 'USB001', isDefault: false, offline: true },
      { name: 'POS-58', port: 'USB002', isDefault: true, offline: true }
    ] }
  });
  assert.ok(!/offline/i.test(allAsleep['settings-printer'].innerHTML),
    `no offline claim when every queue reads offline, got: ${allAsleep['settings-printer'].innerHTML}`);
  // The queues, their ports and the default marker all stay listed.
  assert.match(allAsleep['settings-printer'].innerHTML, /<option value="POS-58" selected>POS-58 \(USB002, default\)<\/option>/);
  assert.match(allAsleep['settings-printer'].innerHTML, /<option value="Xprinter XP-58">Xprinter XP-58 \(USB001\)<\/option>/);
  // One queue reporting online is enough for the tag to mean something, and
  // then the sleeping queue is still marked.
  const mixed = await runPicker({
    saved: 'POS-58',
    payload: { printers: [
      { name: 'Xprinter XP-58', port: 'USB001', isDefault: false, offline: true },
      { name: 'POS-58', port: 'USB002', isDefault: true, offline: false }
    ] }
  });
  assert.match(mixed['settings-printer'].innerHTML, /Xprinter XP-58 \(USB001, offline\)/);
  assert.match(mixed['settings-printer'].innerHTML, /POS-58 \(USB002, default\)/);
});

test('a vanished saved queue preselects what the server itself would print on', async () => {
  // defaultPrinter() in src/printer.js is the contract: online default, then
  // any online queue, then the offline default, then (picker only) the first
  // row. Nothing selected would leave the browser on whatever WMI returned
  // first and the next Save would persist that silently.
  // No default row at all: the first ONLINE queue wins, not the first row.
  const onlineWins = await runPicker({
    saved: 'ZZ GONE',
    payload: { printers: [
      { name: 'DOWN-1', port: 'USB003', isDefault: false, offline: true },
      { name: 'UP-2', port: 'USB004', isDefault: false, offline: false },
      { name: 'UP-3', port: 'USB005', isDefault: false, offline: false }
    ] }
  });
  assert.deepEqual(selectedOf(onlineWins['settings-printer'].innerHTML), ['UP-2'], 'exactly one option, the first online queue');
  // Only the default, and it is offline: the offline default still beats the
  // first row, so the picker names the queue to fix.
  const offlineDefault = await runPicker({
    saved: 'ZZ GONE',
    payload: { printers: [
      { name: 'DOWN-1', port: 'USB003', isDefault: false, offline: true },
      { name: 'DEF-2', port: 'USB001', isDefault: true, offline: true }
    ] }
  });
  assert.deepEqual(selectedOf(offlineDefault['settings-printer'].innerHTML), ['DEF-2'], 'the offline default is the last resort');
  assert.ok(!/offline/i.test(offlineDefault['settings-printer'].innerHTML), 'and the all-offline read is not asserted as a fault');
  // Nothing online, nothing default: the first row is selected visibly rather
  // than left to the browser, and the missing queue is still named in the note.
  const nothing = await runPicker({
    saved: 'ZZ GONE',
    payload: { printers: [
      { name: 'DOWN-1', port: 'USB003', isDefault: false, offline: true },
      { name: 'DOWN-2', port: 'USB004', isDefault: false, offline: true }
    ] }
  });
  assert.deepEqual(selectedOf(nothing['settings-printer'].innerHTML), ['DOWN-1'], 'the first row is selected, not left to chance');
  assert.match(nothing['settings-printer-note'].textContent, /Saved printer "ZZ GONE" is not installed here/);
});

test('a shop that never configured a printer still gets one queue marked selected', async () => {
  // An empty saved name matches no row, which is the same hole a vanished queue
  // opened: no option is selected, the browser displays whichever queue WMI
  // returned first, and the next unrelated settings save persists it, because a
  // real name differs from the stored empty string and so clears the "only send
  // it when it changed" guard. This machine's live order puts the offline
  // Xprinter XP-58 first, so a shop editing only its footer would have pinned
  // receipts to a dead queue.
  const never = await runPicker({
    payload: { printers: [
      { name: 'Xprinter XP-58', port: 'USB001', isDefault: false, offline: true },
      { name: 'POS-58', port: 'USB002', isDefault: true, offline: false }
    ] }
  });
  assert.deepEqual(selectedOf(never['settings-printer'].innerHTML), ['POS-58'],
    'the online default is preselected, not the first row WMI happened to return');
  // Nothing was ever saved, so nothing vanished: the note must stay quiet rather
  // than report a missing queue the shop never had.
  assert.equal(never['settings-printer-note'].textContent, '', 'no saved-printer claim for an unconfigured shop');
  // The same tiers as the vanished case, and the picker still unlocks.
  const noDefault = await runPicker({
    payload: { printers: [
      { name: 'DOWN-1', port: 'USB003', isDefault: false, offline: true },
      { name: 'UP-2', port: 'USB004', isDefault: false, offline: false }
    ] }
  });
  assert.deepEqual(selectedOf(noDefault['settings-printer'].innerHTML), ['UP-2'], 'first online queue when no row is the default');
  assert.equal(never['settings-printer'].disabled, false);
});

// The picker's fallback is a hand copy of defaultPrinter() in src/printer.js:
// that module is CommonJS server code and auth.js is browser ESM with no
// bundler, so sharing the four lines costs more than they save. The brake is
// therefore on the ORDER, read out of both sources: each tier is matched by the
// shape of its predicate (backreferenced parameter name, so rows/printers
// renames do not matter) and the two files must list them in the same sequence.
test('the picker copies defaultPrinter tier order from the server source', () => {
  const TIERS = [
    ['online default', /\.find\(\((\w)\) => \1\.isDefault && !\1\.offline\)/],
    ['any online queue', /\.find\(\((\w)\) => !\1\.offline\)/],
    ['offline default', /\.find\(\((\w)\) => \1\.isDefault\)/]
  ];
  const orderIn = src => TIERS
    .map(([name, re]) => ({ name, at: src.search(re) }))
    .filter(tier => tier.at > -1)
    .sort((a, b) => a.at - b.at)
    .map(tier => tier.name);
  const server = orderIn(source('src/printer.js'));
  const picker = orderIn(auth);
  const names = TIERS.map(([name]) => name);
  // Without this the order check could pass vacuously on two empty lists.
  for (const [label, seq] of [['src/printer.js', server], ['the picker', picker]]) {
    assert.deepEqual([...seq].sort(), [...names].sort(), `${label} consults all three tiers`);
  }
  assert.deepEqual(picker, server,
    `loadPrinters() must consult the tiers in the order defaultPrinter() does: server ${JSON.stringify(server)}, picker ${JSON.stringify(picker)}`);
});

// ---------------------------------------------------------------- modal print action
// FINDING 1. The receipt modal's own Print button was the generic
// data-action="print" -> window.print(): with auto-print off an everyday sale
// receipt still printed through the browser raster path, and after a successful
// ESC/POS print one deliberate click made a second copy on the OS default queue,
// which may not be the queue chosen in Settings. The button now routes the slip
// the modal is showing through printSlip for its sale id, with the dialog only
// as the fallback.
test('the receipt modal prints the slip it is showing over the queue, not the browser', () => {
  const receipts = source('public/js/receipts.js');

  // The modal button is a per-slip action; the bare browser-print action is gone.
  assert.match(index, /data-action="print-slip"/);
  assert.ok(!index.includes('data-action="print"'), 'the modal still carries the bare browser-print action');

  // main.js holds no opinion about which slip is open. It hands the click to
  // receipts.js and never reads an identity off the button itself -- trusting a
  // data-sale-id there is what reprinted the previous sale once a second slip
  // type shared the button.
  assert.match(main, /import \{[^}]*printModalSlip[^}]*\} from '\.\/receipts\.js'/);
  assert.ok(!/import \{[^}]*\bprintSlip\b[^}]*\} from '\.\/receipts\.js'/.test(main),
    'main.js imports the raw ask again, which means it is deciding the payload');
  assert.match(main, /'print-slip': \(\) => printModalSlip\(\)/);
  const modalAction = main.slice(main.indexOf("'print-slip':"), main.indexOf("'print-test':"));
  assert.ok(!/dataset\./.test(modalAction), 'the modal action still reads the slip identity out of the DOM itself');

  // One place owns the answer: a renderer declares its whole print payload through
  // setModalSlip(), so nothing has to remember to clear someone else's attribute.
  assert.match(receipts, /const MODAL_PRINT_BUTTON = '#modal-receipt \[data-action="print-slip"\]';/);
  assert.match(receipts, /export function setModalSlip\(payload\)/);
  assert.match(receipts, /export function getModalSlip\(\)/);
  assert.match(receipts, /export async function printModalSlip\(\)/);
  assert.ok(!/dataset\.saleId/.test(receipts), 'a renderer still stamps the per-slip sale id');

  // Closing the receipt modal retires the declaration with it, so a payload
  // cannot outlive the slip that declared it. The write still belongs to
  // receipts.js: ui.js hands over the id it is shutting and never touches the
  // dataset, and closeModal() is the one dismissal path every close reaches
  // (the Close button, the backdrop and Escape all go through it).
  assert.match(receipts, /export function clearModalSlip\(id\)/);
  assert.match(receipts, /if \(id === 'modal-receipt'\) setModalSlip\(null\);/);
  assert.match(ui, /import \{ clearModalSlip \} from '\.\/receipts\.js';/);
  const closing = ui.slice(ui.indexOf('export function closeModal'), ui.indexOf('// The id of the topmost open dialog'));
  assert.match(closing, /clearModalSlip\(id\);/, 'closeModal() no longer retires the slip the modal declared');
  assert.ok(!/dataset\.slip/.test(closing), 'ui.js writes the slip declaration itself instead of asking receipts.js to');

  // Every renderer that fills the modal declares what it holds, and a new one has
  // to fail this before it can silently reprint the last sale.
  const fillers = receipts.split('\n').filter((l) => l.includes("getElementById('receipt-content')"));
  assert.equal(fillers.length, 2, `a new modal renderer appeared (${fillers.length} writers): it must declare its slip through setModalSlip()`);
  for (const name of ['renderReceipt', 'renderSettlementReceipt']) {
    const at = receipts.indexOf(`export function ${name}(`);
    assert.ok(at > -1, `${name} is gone`);
    const body = receipts.slice(at, receipts.indexOf('\n}', at));
    assert.match(body, /setModalSlip\(/, `${name} fills the modal without declaring its slip`);
  }
  assert.match(receipts, /setModalSlip\(sale && sale\.id != null \? \{ kind: 'sale', sale_id: Number\(sale\.id\) \} : null\)/);
  assert.match(receipts, /setModalSlip\(payment && payment\.id != null/);
  assert.match(receipts, /kind: 'settlement', payment_id: Number\(payment\.id\), customer_name: String\(payment\.customer_name \|\| customer\?\.customer_name \|\| ''\)/);

  // The click: declared payload to the queue, browser only for a slip nobody
  // declared, and placeholder identity stops paper on both paths.
  const modal = receipts.slice(receipts.indexOf('export async function printModalSlip'), receipts.indexOf('export async function reprintLastReceipt'));
  assert.match(modal, /const slip = getModalSlip\(\);/);
  assert.match(modal, /if \(!slip\) \{ window\.print\(\); return; \}/, 'an undeclared slip must still reach the browser');
  assert.match(modal, /if \(shopIdentityIsPlaceholder\(\)\) \{[\s\S]*?return;\n  \}/, 'the modal click lost the placeholder-identity guard');
  assert.match(modal, /if \(!\(await printSlip\(\{ \.\.\.slip, drawer_kick: false \}\)\)\) window\.print\(\);/);
});

// Execute the modal's print path against stubs, so the routing is proven by what
// it calls and not only by the source shape: a sale slip asks the queue, a
// refused send falls back to the dialog, an undeclared slip goes to the browser,
// placeholder identity stops paper, and a settlement opened on top of a sale
// prints the settlement -- never the id the button used to carry.
test('the modal print action prints the slip the modal declares, not the last id it saw', async () => {
  const receipts = source('public/js/receipts.js');
  const ownership = receipts.slice(receipts.indexOf('const MODAL_PRINT_BUTTON'), receipts.indexOf('export async function printSlip('));
  const modal = receipts.slice(receipts.indexOf('export async function printModalSlip'), receipts.indexOf('export async function reprintLastReceipt'));
  assert.ok(ownership.startsWith('const MODAL_PRINT_BUTTON'), 'the modal slip ownership moved; update this test');
  assert.ok(modal.startsWith('export async function printModalSlip'), 'printModalSlip moved; update this test');
  assert.ok(ownership.includes('function shopIdentityIsPlaceholder'), 'the guard is no longer inside the sliced block');

  const PLACEHOLDER = { name: 'TechParts Repair & POS', number: '0917-123-4567' };
  // `staleSaleId` is the attribute the previous design read: the modal button
  // keeping sale 12's id while showing something else is the exact case that
  // warning predicted, so it is seeded here on purpose.
  const open = ({ printOk = true, placeholder = false, staleSaleId = null } = {}) => {
    const seen = [];
    const button = { dataset: {} };
    if (staleSaleId != null) button.dataset.saleId = String(staleSaleId);
    const ctx = vm.createContext({
      document: { querySelector: (sel) => (sel === '#modal-receipt [data-action="print-slip"]' ? button : null) },
      window: { print: () => seen.push('browser') },
      showToast: (msg) => seen.push(`toast: ${msg}`),
      // printSlip's own POST is pinned in the sale-side test above; here it is
      // the seam that says which payload the modal asked for, and whether the
      // send succeeded.
      printSlip: async (payload) => { seen.push(payload); return printOk; },
      S: { shopSettings: { gcash_name: placeholder ? PLACEHOLDER.name : 'Juan Time LCD Shop', gcash_number: '0999-000-1111' } },
      PLACEHOLDER_SHOP: PLACEHOLDER,
    });
    vm.runInContext(`${ownership}\n${modal}`.replace(/export /g, ''), ctx);
    return { seen, ctx, button };
  };
  const declare = (ctx, payload) => vm.runInContext('setModalSlip', ctx)(payload);
  const click = (ctx) => vm.runInContext('printModalSlip', ctx)();

  // Sale slip, queue prints: exactly one ask for THIS sale, no browser dialog.
  // Compared field by field: the payload object was built in another realm, so
  // its prototype is not this file's Object.prototype and deep equality of the
  // array would fail on that alone.
  const sale = open({ staleSaleId: 12 });
  declare(sale.ctx, { kind: 'sale', sale_id: 12 });
  await click(sale.ctx);
  assert.equal(sale.seen.length, 1, JSON.stringify(sale.seen));
  assert.equal(sale.seen[0].kind, 'sale');
  assert.equal(sale.seen[0].sale_id, 12);
  assert.equal(typeof sale.seen[0].sale_id, 'number', 'the sale id reaches the route as a number, not a string');

  // Sale slip, queue refused: the dialog is the fallback.
  const refused = open({ printOk: false });
  declare(refused.ctx, { kind: 'sale', sale_id: 12 });
  await click(refused.ctx);
  assert.equal(refused.seen[0].sale_id, 12);
  assert.equal(refused.seen[refused.seen.length - 1], 'browser');

  // The regression this exists to stop: a settlement slip is open in the modal
  // that was showing sale 12, and the button still carries that sale's id.
  const settlement = open({ staleSaleId: 12 });
  declare(settlement.ctx, { kind: 'sale', sale_id: 12 });
  declare(settlement.ctx, { kind: 'settlement', payment_id: 7, customer_name: 'Mary Ann Dela Cruz' });
  await click(settlement.ctx);
  assert.equal(settlement.seen.length, 1, JSON.stringify(settlement.seen));
  assert.equal(settlement.seen[0].kind, 'settlement', 'the modal reprinted the previous sale instead of the slip on screen');
  assert.equal(settlement.seen[0].payment_id, 7);
  assert.equal(settlement.seen[0].customer_name, 'Mary Ann Dela Cruz');
  assert.ok(!settlement.seen.some((p) => p && p.kind === 'sale'), 'a stale sale id reached the queue');

  // Undoing the declaration undoes it completely: the stale attribute left behind
  // by the old design cannot resurrect a print job.
  const cleared = open({ staleSaleId: 12 });
  declare(cleared.ctx, { kind: 'settlement', payment_id: 7, customer_name: 'Mary Ann Dela Cruz' });
  declare(cleared.ctx, null);
  assert.ok(!('slip' in cleared.button.dataset), 'setModalSlip(null) left a payload on the button');
  await click(cleared.ctx);
  assert.deepEqual(cleared.seen, ['browser']);

  // Closing the modal is the same retirement, just automatic: a settlement is
  // declared, the modal is put away, and the very next click on that same
  // button must fall through to the browser instead of resending payment 7.
  const closed = open({ staleSaleId: 12 });
  declare(closed.ctx, { kind: 'settlement', payment_id: 7, customer_name: 'Mary Ann Dela Cruz' });
  vm.runInContext('clearModalSlip', closed.ctx)('modal-receipt');
  assert.ok(!('slip' in closed.button.dataset), 'the receipt modal kept its payload after closing');
  await click(closed.ctx);
  assert.deepEqual(closed.seen, ['browser'], 'a closed modal resent the slip it was showing');
  // And the id decides: any other dialog shutting leaves a live declaration of
  // its own alone, so clearModalSlip cannot be the thing that blanks the button
  // for a slip that is still on screen.
  const other = open();
  declare(other.ctx, { kind: 'sale', sale_id: 12 });
  vm.runInContext('clearModalSlip', other.ctx)('modal-settings');
  await click(other.ctx);
  assert.equal(other.seen.length, 1, JSON.stringify(other.seen));
  assert.equal(other.seen[0].kind, 'sale');
  assert.equal(other.seen[0].sale_id, 12);

  // A slip nobody declared (the Z-report and period summary stay on the browser
  // path by design) never reaches the queue.
  const undeclared = open();
  await click(undeclared.ctx);
  assert.deepEqual(undeclared.seen, ['browser']);

  // Placeholder identity: every other sale-side trigger refuses, and the modal's
  // deliberate click was the path that still let the demo shop name reach paper.
  for (const payload of [{ kind: 'sale', sale_id: 12 }, { kind: 'settlement', payment_id: 7, customer_name: 'Juan Dela Cruz' }]) {
    const demo = open({ placeholder: true, staleSaleId: 12 });
    declare(demo.ctx, payload);
    await click(demo.ctx);
    assert.ok(demo.seen.every((s) => typeof s === 'string'), `a placeholder-identity slip reached the queue: ${JSON.stringify(demo.seen)}`);
    assert.ok(!demo.seen.includes('browser'), 'placeholder identity must stop the browser fallback too');
    assert.match(demo.seen[0] || '', /^toast: Receipt not printed: shop identity is still the placeholder/,
      'the refusal said nothing to the cashier');
  }
});


// ------------------------------------------------- final review fix wave: item 5
// The old print dialog was the throttle: window.print() blocks, so a second click
// landed on a dialog that was already up. The queue path only awaits a fetch, so
// without a lock of its own a double click sends two jobs and writes two audit
// rows for one sale. Proved against the real printSlip + printModalSlip pair with
// a stubbed fetch, so it fails if either half forgets to hand the button back.
test('the modal print button is locked for the whole send and handed back on every exit', async () => {
  const receipts = source('public/js/receipts.js');
  const ownership = receipts.slice(receipts.indexOf('const MODAL_PRINT_BUTTON'), receipts.indexOf('export async function printSlip('));
  const queue = receipts.slice(receipts.indexOf('export async function printSlip'), receipts.indexOf('export async function reprintLastReceipt'));
  assert.ok(ownership.startsWith('const MODAL_PRINT_BUTTON'), 'the modal ownership block moved; update this test');
  assert.ok(queue.startsWith('export async function printSlip'), 'printSlip moved; update this test');

  const open = (buildFetch) => {
    const button = { dataset: {}, disabled: false };
    const seen = [];
    const ctx = vm.createContext({
      document: { querySelector: (sel) => (sel === '#modal-receipt [data-action="print-slip"]' ? button : null) },
      window: { print: () => seen.push('browser') },
      showToast: (msg) => seen.push(`toast: ${msg}`),
      fetch: buildFetch(seen),
      S: { shopSettings: { gcash_name: 'Juan Time LCD Shop', gcash_number: '0999-000-1111' } },
      PLACEHOLDER_SHOP: { name: 'TechParts Repair & POS', number: '0917-123-4567' },
    });
    vm.runInContext(`${ownership}\n${queue}`.replace(/export /g, ''), ctx);
    vm.runInContext('setModalSlip', ctx)({ kind: 'sale', sale_id: 12 });
    return { button, seen, ctx };
  };
  const response = (payload) => ({ ok: true, json: async () => payload });

  // One send in flight: the button is disabled while it waits, a second click
  // cannot open a second job, and the flag is off again once it lands.
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const inflight = open((seen) => async (url, opts) => {
    seen.push(opts.body);
    await pending;
    return response({ ok: true });
  });
  const first = vm.runInContext('printModalSlip', inflight.ctx)();
  assert.equal(inflight.button.disabled, true, 'the button was still pressable the moment the send started');
  await vm.runInContext('printModalSlip', inflight.ctx)();
  assert.equal(inflight.seen.length, 1, `a double click fed the queue twice: ${JSON.stringify(inflight.seen)}`);
  release();
  await first;
  assert.equal(inflight.button.disabled, false, 'the button stayed dead after a successful print');
  assert.deepEqual(inflight.seen, ['{"kind":"sale","sale_id":12,"drawer_kick":false}']);
  // And the button is pressable again, so the lock did not eat the next receipt.
  let releaseSecond;
  const secondPending = new Promise((resolve) => { releaseSecond = resolve; });
  const armed = open((seen) => async (url, opts) => {
    seen.push(opts.body);
    await secondPending;
    return response({ ok: true });
  });
  const second = vm.runInContext('printModalSlip', armed.ctx)();
  assert.equal(armed.button.disabled, true, 'a click after a finished send never re-armed the lock');
  releaseSecond();
  await second;
  assert.equal(armed.button.disabled, false, 'the button was left disabled after the second send');

  // A fetch that throws (the network dropped, the tab lost the server): printSlip
  // swallows it and says fall back, the dialog prints the same slip, and the
  // button comes back either way. This is the path that used to strand the click.
  const dropped = open(() => async () => { throw new TypeError('Failed to fetch'); });
  await vm.runInContext('printModalSlip', dropped.ctx)();
  assert.equal(dropped.button.disabled, false, 'a rejected fetch left the button disabled');
  assert.equal(dropped.seen[dropped.seen.length - 1], 'browser', 'a rejected fetch did not fall back to the dialog');
  assert.ok(dropped.seen.some((s) => typeof s === 'string' && s.startsWith('toast:')), 'the cashier was told nothing');

  // The route answered a refusal (fallback:false): no second paper, and still no
  // dead button, because the tab is done with this slip either way.
  const refused = open(() => async () => response({ ok: false, error: 'Amount is not a number', fallback: false }));
  await vm.runInContext('printModalSlip', refused.ctx)();
  assert.equal(refused.button.disabled, false, 'a refused slip left the button disabled');
  assert.ok(!refused.seen.includes('browser'), 'the browser path re-printed the figure the guard refused');
  assert.match(refused.seen[0], /toast: Amount is not a number/);

  // A printer fault keeps its fallback: the shop is never left without a receipt.
  const fault = open(() => async () => ({ ok: false, status: 500, json: async () => ({ ok: false, error: 'the print helper did not answer', fallback: true }) }));
  await vm.runInContext('printModalSlip', fault.ctx)();
  assert.equal(fault.seen[fault.seen.length - 1], 'browser', 'a printer fault stopped offering the browser path');
  assert.equal(fault.button.disabled, false);

  // The source shape, so the lock cannot be dropped for one exit path only.
  const modal = receipts.slice(receipts.indexOf('export async function printModalSlip'), receipts.indexOf('export async function reprintLastReceipt'));
  assert.match(modal, /if \(modalPrintInFlight\) return;/, 'the re-entry guard is gone');
  assert.match(modal, /button\.disabled = true;\n  try \{/, 'the button is not disabled before the send');
  assert.match(modal, /finally \{\s*if \(button\) button\.disabled = false;\s*modalPrintInFlight = false;\s*\}/,
    'the button is not handed back on every exit path');
});

// ------------------------------------------------- task 7: the docs describe what ships
test('the docs describe ESC/POS printing, not a browser-only path', () => {
  const readme = source('README.md');
  const ops = source('docs/OPERATIONS_AND_DEPLOYMENT.md');
  assert.match(readme, /ESC\/POS/);
  assert.ok(!/no raw ESC\/POS/.test(readme), 'README still claims raw ESC/POS is absent');
  assert.match(ops, /\/api\/print/);
  assert.match(ops, /\/api\/printers/);
  // The counter flow an operator actually follows on a new shop, and the
  // consequence of the route recording delivery before it audits.
  assert.match(ops, /Print test receipt/);
  assert.match(ops, /pos-server\.log/);
  // Reports still print through the browser, on purpose: the docs that say the
  // slips all went native are lying about the two that did not.
  assert.match(ops, /browser print path/);
  assert.match(readme, /browser/);
});

test('the printing status names the queue, not a dialog as the normal outcome', () => {
  const block = auth.slice(auth.indexOf('const kioskStatus'), auth.indexOf('const syncTokenInput'));
  assert.match(block, /sessionStorage\.getItem\('pos_kiosk'\) === '1'/);
  assert.match(block, /queue/i, 'the status copy never mentions the queue slips actually print to');
  assert.ok(!/auto-print has to show the print dialog/.test(block), 'the status still calls the dialog the normal outcome');
  for (const line of block.split('\n')) {
    assert.ok(!/—/.test(line), `em dash in user-facing status copy: ${line.trim()}`);
  }
});

// =====================================================================
// POST-FIX-WAVE REGRESSION CLOSE
// =====================================================================

// The browser modules are ESM with a DOM behind them, so the real functions are
// evaluated in a vm over a hand-built table, the way the modal-print tests above
// run the real printModalSlip. Grep alone cannot show that a list survives a
// broken row: only calling the renderer can.
const uiMoneyBlock = ui.slice(ui.indexOf('export function escHtml'), ui.indexOf('export function setCounterText'));
const uiSkeletonBlock = ui.slice(ui.indexOf('function skeletonRows'), ui.indexOf('// Modals are real dialogs'));
const uiDateBlock = ui.slice(ui.indexOf('export function formatDateTime'), ui.indexOf('export function calculateWarrantyExpiry'));
const salesViewBlock = backoffice.slice(
  backoffice.indexOf('let salesHistoryRows'),
  backoffice.indexOf('export async function viewSaleDetails')
);

// A tbody that answers querySelector the way the real one does, because the
// server-down card is only painted when the skeleton is still in the table: a
// stub returning null for .skel would hide the very failure this test is about.
const fakeTbody = () => {
  const el = { innerHTML: '', children: [], querySelector: (sel) => (el.innerHTML.includes(sel.slice(1)) ? {} : null) };
  return el;
};

// One sales list, one corrupt amount, straight through the view the operator
// actually opens: fetch, loadSalesHistory, renderSalesHistory, #sales-tbody.
const openSalesHistory = (rows) => {
  const tbody = fakeTbody();
  const toasts = [];
  const ctx = vm.createContext({
    document: { getElementById: (id) => (id === 'sales-tbody' ? tbody : null) },
    fetch: async () => ({ ok: true, json: async () => rows }),
    encodeURIComponent,
    showToast: (msg) => toasts.push(msg),
  });
  const code = `let salesRequest = 0;\n${uiMoneyBlock}\n${uiSkeletonBlock}\n${uiDateBlock}\n${salesViewBlock}`;
  assert.ok(salesViewBlock.includes('export async function loadSalesHistory') && code.includes('function showSkeleton'),
    'loadSalesHistory or a ui.js helper moved; update these slices');
  vm.runInContext(code.replace(/export /g, ''), ctx);
  return { tbody, toasts, ctx };
};

test('one corrupt row cannot blank the sales history table', async () => {
  const rows = [
    { id: 1, sale_code: 'S-1', created_at: '2026-10-01T02:00:00Z', customer_name: 'Ada', payment_method: 'cash', subtotal: 100, discount: 0, total_amount: 100, credit_balance: 0, rma_count: 0, rma_available: 1 },
    { id: 2, sale_code: 'S-2', created_at: '2026-10-02T02:00:00Z', customer_name: 'Bo', payment_method: 'cash', subtotal: 200, discount: 0, total_amount: 'not-a-number', credit_balance: 0, rma_count: 0, rma_available: 1 },
    { id: 3, sale_code: 'S-3', created_at: '2026-10-03T02:00:00Z', customer_name: 'Cy', payment_method: 'gcash', subtotal: 300, discount: 0, total_amount: 300, credit_balance: 0, rma_count: 0, rma_available: 1 }
  ];
  const { tbody, toasts, ctx } = openSalesHistory(rows);
  await vm.runInContext('loadSalesHistory', ctx)();
  const html = tbody.innerHTML;

  // The whole table is still there: three rows, and the healthy totals intact.
  assert.equal((html.match(/<tr>/g) || []).length, 3, `rows went missing: ${html.slice(0, 200)}`);
  for (const code of ['S-1', 'S-2', 'S-3']) assert.ok(html.includes(code), `${code} disappeared from the list`);
  assert.ok(html.includes('₱100.00') && html.includes('₱300.00'), 'the good rows lost their totals');
  // The bad cell carries the marker, so the corrupted row is the one the operator
  // can go looking for, and it is still on the screen they look at.
  assert.ok(html.includes('₱--'), 'the corrupt amount is not marked on screen');
  assert.ok(!/NaN/.test(html), 'a NaN total reached the table');
  // The failure this pins: the throw used to land inside loadSalesHistory's try
  // block and its catch repainted every row as a server outage.
  assert.ok(!html.includes("Couldn't load sales history"), 'the table fell back to the server-down card');
  assert.ok(!html.includes('class="empty"'), 'the list was replaced by an empty or error state');
  assert.deepEqual(toasts, [], 'the operator was told the server did not answer');
});

test('the shared screen formatter marks an unreadable amount instead of throwing', () => {
  const ctx = vm.createContext({});
  vm.runInContext(uiMoneyBlock.replace(/export /g, ''), ctx);
  const fmt = vm.runInContext('fmtMoney', ctx);
  // Every value a list can be handed: the marker, never a throw, never NaN, and
  // never the raw stored text (all of these outputs reach innerHTML).
  for (const bad of ['abc', '1.2.3', NaN, Infinity, -Infinity, {}, () => {}, '<b>x</b>']) {
    assert.doesNotThrow(() => fmt(bad), `fmtMoney(${String(bad)}) still throws`);
    assert.equal(fmt(bad), '₱--', `fmtMoney(${String(bad)}) did not mark the amount`);
  }
  for (const [good, shown] of [[0, '₱0.00'], ['', '₱0.00'], [null, '₱0.00'], [undefined, '₱0.00'], ['2700', '₱2,700.00'], [1234.5, '₱1,234.50']]) {
    assert.equal(fmt(good), shown, `fmtMoney(${JSON.stringify(good)})`);
  }
  // The refusal factory is out of the shared module entirely: a formatter list
  // views call at 81 sites has no business talking about a receipt.
  assert.ok(!/amountRefusal/.test(uiMoneyBlock), 'ui.js still carries the throwing refusal factory');
});

// Item 2: the returns screen was the last reader with its own arithmetic.
// `Number(x) || 7` turned a saved 0 back into a week, so a no-warranty sale got
// no hint here and then src/returns.js refused the return as out of window.
test('the RMA warranty hint reads the one rule, so a saved zero is not a week', () => {
  const hintBlock = backoffice.slice(
    backoffice.indexOf("document.getElementById('rma-warranty-hint')?.remove();"),
    backoffice.indexOf("openModal('modal-warranty-return')")
  );
  assert.ok(hintBlock.includes('const wDays ='), 'the hint block moved; update this slice');
  assert.match(hintBlock, /warrantyDays\(S\.shopSettings\.warranty_days\)/, 'the hint is back to its own reading of the setting');
  assert.ok(!/Number\(S\.shopSettings\.warranty_days\)\s*\|\|/.test(hintBlock), 'the hint still coerces a saved zero');

  const uiWarrantyBlock = ui.slice(ui.indexOf('export function warrantyDays'), ui.indexOf('// One-off single-input modal'));
  const hintFor = (setting, saleDate) => {
    const shown = [];
    const select = { closest: () => ({ insertAdjacentHTML: (_pos, html) => shown.push(html) }) };
    const ctx = vm.createContext({
      document: { getElementById: (id) => (id === 'return-item-select' ? select : { remove() {} }) },
      S: { shopSettings: { warranty_days: setting } },
      sale: { created_at: saleDate },
      Date,
      isNaN,
    });
    vm.runInContext(`${uiWarrantyBlock}\nconst formatDateOnly = () => 'sold';\n${hintBlock}`.replace(/export /g, ''), ctx);
    return shown[0] || null;
  };
  const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();
  // A no-warranty shop, three days on: the hint fires and says zero days, which
  // is the same answer src/returns.js refuses on.
  assert.match(hintFor('0', daysAgo(3)) || '', /outside the 0-day warranty/, 'a saved zero is still read as a week here');
  assert.match(hintFor('0', daysAgo(1)) || '', /outside the 0-day warranty/, 'a day old is outside a zero-day warranty');
  // An unset or unreadable row is seven, the way the slip prints it, and the raw
  // setting never becomes the sentence. Ten days old is inside a fortnight and
  // outside a week, so the number the hint prints IS the answer the rule gave.
  for (const unusable of [null, '', '   ', 'abc']) {
    const hint = hintFor(unusable, daysAgo(10)) || '';
    assert.match(hint, /outside the 7-day warranty/, `${JSON.stringify(unusable)} did not read as seven`);
    assert.ok(!/abc|null/.test(hint), 'the raw setting leaked into the hint text');
  }
  // A real setting stands, in both directions.
  assert.equal(hintFor('14', daysAgo(10)), null, 'a 14-day shop got an out-of-window hint');
  assert.match(hintFor('2', daysAgo(3)) || '', /outside the 2-day warranty/);
});

test('kiosk polish: no native prompt() calls remain and cart quantity pill + claim stub are wired', () => {
  assert.doesNotMatch(pos, /=\s*prompt\s*\(/, 'pos.js must use inputModal instead of native prompt()');
  assert.doesNotMatch(backoffice, /=\s*prompt\s*\(/, 'backoffice.js must use inputModal instead of native prompt()');
  assert.match(ui, /defaultValue = ''/, 'inputModal supports pre-filled defaultValue');
  assert.match(pos, /data-action="edit-line-qty"/, 'cart lines render clickable quantity pill');
  assert.match(pos, /export async function editCartQtyPrompt\(index\)/, 'editCartQtyPrompt is exported');
  assert.match(pos, /export function printClaimStub\(\)/, 'printClaimStub is exported');
  assert.match(index, /data-action="print-claim-stub"/, 'Claim stub button is in the POS counter');
  assert.match(main, /'edit-line-qty':/, 'main.js dispatches edit-line-qty');
  assert.match(main, /'print-claim-stub':/, 'main.js dispatches print-claim-stub');
});

// The inline cart quantity editor is a money and stock path: exercise it for
// real instead of pinning its export line (v7 audit 8.2).
test('cart quantity editor validates, clamps to stock, and removes at zero', async () => {
  const src = source('public/js/views/pos.js');
  const start = src.indexOf('export async function editCartQtyPrompt(');
  const end = src.indexOf('export function removeCartItem(');
  const code = src.slice(start, end).replaceAll('export ', '');
  const toasts = [];
  const S = {
    saleInFlight: false,
    cart: [{ id: 7, brand: 'Apple', model_name: '11', part_type: 'LCD', qty: 1, stock: 2 }],
    posCatalog: [{ id: 7, stock_quantity: 2 }],
  };
  const ctx = vm.createContext({
    S,
    inputModal: async () => arguments0.v,
    removeCartItem: () => { removed = true; },
    renderCart() { renders++; },
    renderPartsTable() {},
    showToast: (m) => toasts.push(m),
    t: (k, fb) => fb || k,
  });
  let removed = false;
  let renders = 0;
  const arguments0 = { v: null };
  vm.runInContext(code, ctx);

  arguments0.v = 'abc';           // non-numeric
  await ctx.editCartQtyPrompt(0);
  assert.equal(S.cart[0].qty, 1, 'garbage input changes nothing');

  arguments0.v = '1.5';           // non-integer
  await ctx.editCartQtyPrompt(0);
  assert.equal(S.cart[0].qty, 1, 'fractional quantity is refused');

  arguments0.v = '-2';            // negative
  await ctx.editCartQtyPrompt(0);
  assert.equal(S.cart[0].qty, 1, 'negative quantity is refused');

  arguments0.v = '9';             // over the stock ceiling
  await ctx.editCartQtyPrompt(0);
  assert.equal(S.cart[0].qty, 1, 'over-stock quantity is refused');
  assert.ok(toasts.some(m => /Only 2 available/.test(m)), 'the ceiling toast names the stock');

  arguments0.v = '2';             // at the ceiling: accepted
  await ctx.editCartQtyPrompt(0);
  assert.equal(S.cart[0].qty, 2, 'a valid quantity lands');
  assert.ok(renders > 0, 'the cart re-renders');

  arguments0.v = '0';             // zero removes the line
  await ctx.editCartQtyPrompt(0);
  assert.equal(removed, true, 'zero quantity removes the line');
});

// The claim stub is the one print surface with no ESC/POS twin, so its renderer
// is pinned directly: escaping on every intake field, and the same money
// refusal as paper (v7 audit 8.2 and 9f).
test('claim stub renderer escapes intake text and refuses broken money', () => {
  const receiptsSrc = source('public/js/receipts.js');
  const start = receiptsSrc.indexOf('export function renderClaimStub(');
  const code = receiptsSrc.slice(start).replace('export ', '');
  const captured = { html: null };
  const printable = {
    set className(v) { captured.class = v; },
    set innerHTML(v) { captured.html = v; },
  };
  const ctx = vm.createContext({
    document: { getElementById: (id) => (id === 'printable-receipt' ? printable : null) },
    S: { shopSettings: { receipt_paper_width: '58mm' } },
    brandHeaderHtml: () => '<div>brand</div>',
    formatDateTime: () => 'Nov 6, 2026',
    escHtml: (v) => String(v ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;'),
    printMoney: (n) => { if (!Number.isFinite(Number(n))) throw new Error('refused'); return 'P' + Number(n).toFixed(2); },
    applyPrintPageSize() {},
  });
  vm.runInContext(code, ctx);

  ctx.renderClaimStub({
    ref: 'RMA<1>', customer: 'Juan <script>', phone: '0917', device: 'iPhone<b>',
    imei: '35"&x', note: 'note<img>', items: [{ name: 'Part & Co', qty: 2, unit_price: 1.005 }], total: 2.01,
  });
  assert.ok(!captured.html.includes('<script>'), 'raw markup never reaches the stub');
  assert.ok(captured.html.includes('Juan &lt;script&gt;'), 'customer text is escaped');
  assert.ok(captured.html.includes('RMA&lt;1&gt;'), 'the ref is escaped');
  assert.ok(captured.html.includes('35&quot;&amp;x'), 'the IMEI is escaped');

  assert.throws(() => ctx.renderClaimStub({ ref: 'X', customer: 'x', items: [{ name: 'x', qty: 1, unit_price: 5 }], total: Number.NaN }),
    /refused/, 'a broken total refuses to print instead of rendering P0.00');
});

test('the sync chip shows the error state only for a synced-but-refused credential', () => {
  // The chip's label rule lives in main.js; drive the real expression with
  // the /api/sync/status shapes that matter instead of pinning its text.
  const src = source('public/js/main.js');
  const start = src.indexOf('const n = s.pending || 0;');
  const end = src.indexOf(';', src.indexOf("? 'Cloud sync error'")) + 1;
  const code = src.slice(start, end);
  const make = () => ({ text: '', classList: { add() {}, remove() {} }, title: '' });
  const run = (s) => {
    const chip = make();
    const ctx = vm.createContext({ chip, s });
    vm.runInContext(code, ctx);
    return chip.textContent;
  };
  assert.equal(run({ state: 'synced', pending: 0, last_error: null, url_configured: true }), 'Cloud synced');
  assert.equal(run({ state: 'synced', pending: 0, last_error: 'cloud sync responded 401', url_configured: true }), 'Cloud sync error',
    'a refused credential overrides the green label');
  assert.equal(run({ state: 'syncing', pending: 3, last_error: 'x', url_configured: true }), 'Syncing 3 changes');
  assert.equal(run({ state: 'attention', pending: 2, last_error: null, url_configured: true }), '2 changes queued');
});

// -------------------------------------------------------------
// Task 3: PIN Recovery, USB Backup Download, and Close POS UI
// -------------------------------------------------------------
test('Task 3: public/index.html contains all required recovery and backup DOM elements and actions', () => {
  const html = source('public/index.html');
  const requiredIds = [
    'pin-setup-recovery',
    'pin-setup-recovery-confirm',
    'pin-setup-skip',
    'counter-exit-btn',
    'settings-recovery-status',
    'settings-recovery-new',
    'settings-recovery-confirm',
    'settings-recovery-btn',
    'settings-recovery-msg',
    'login-gate-forgot-pin',
    'login-gate-no-recovery',
    'recover-pw',
    'recover-new-pin',
    'recover-confirm-pin',
    'recover-error'
  ];
  for (const id of requiredIds) {
    assert.ok(html.includes(`id="${id}"`), `public/index.html must contain id="${id}"`);
  }

  const requiredActions = [
    'data-action="download-backup"',
    'data-action="forgot-pin-open"',
    'data-action="recover-pin-submit"',
    'data-action="recover-pin-cancel"'
  ];
  for (const act of requiredActions) {
    assert.ok(html.includes(act), `public/index.html must contain action ${act}`);
  }

  // Zero references to scripts/set-pin.js in public/
  const authSrc = source('public/js/auth.js');
  assert.equal(html.includes('scripts/set-pin.js'), false, 'index.html must not reference scripts/set-pin.js');
  assert.equal(authSrc.includes('scripts/set-pin.js'), false, 'auth.js must not reference scripts/set-pin.js');
});

test('Task 3: public/js/state.js defines serviceMode and recoveryConfigured', () => {
  const stateSrc = source('public/js/state.js');
  assert.match(stateSrc, /serviceMode:\s*false/, 'state.js must initialize serviceMode: false');
  assert.match(stateSrc, /recoveryConfigured:\s*false/, 'state.js must initialize recoveryConfigured: false');
});

test('Task 3: syncServiceModeUi updates exit button and hides pin setup skip button', () => {
  const authSrc = source('public/js/auth.js');
  assert.match(authSrc, /export function syncServiceModeUi\(/, 'auth.js must export syncServiceModeUi');

  const skipBtn = {
    classes: new Set(),
    classList: {
      add(c) { skipBtn.classes.add(c); },
      remove(c) { skipBtn.classes.delete(c); },
      toggle(c, force) { if (force) skipBtn.classes.add(c); else skipBtn.classes.delete(c); }
    }
  };
  const exitBtn = {
    title: 'Quit / Exit POS',
    ariaLabel: 'Quit or exit POS',
    textContent: 'Quit',
    setAttribute(k, v) { if (k === 'aria-label') exitBtn.ariaLabel = v; }
  };
  const S = { serviceMode: false };
  const ctx = vm.createContext({
    S,
    document: {
      getElementById: id => (id === 'pin-setup-skip' ? skipBtn : (id === 'counter-exit-btn' ? exitBtn : null)),
      querySelector: sel => (sel === '#counter-exit-btn' || sel === '[data-action="shutdown"]' ? exitBtn : null)
    }
  });

  const fnStart = authSrc.indexOf('export function syncServiceModeUi(');
  assert.ok(fnStart > -1, 'syncServiceModeUi must exist in auth.js');
  const fnEnd = authSrc.indexOf('\nexport ', fnStart + 1);
  const fnCode = authSrc.slice(fnStart, fnEnd > -1 ? fnEnd : fnStart + 600).replace('export ', '');
  vm.runInContext(fnCode, ctx);

  // When service mode is true
  ctx.syncServiceModeUi(true);
  assert.equal(S.serviceMode, true, 'S.serviceMode must be set to true');
  assert.ok(skipBtn.classes.has('hidden'), '#pin-setup-skip must have hidden class in service mode');
  assert.equal(exitBtn.title, 'Close POS Window', 'Exit button title should be Close POS Window');

  // When service mode is false
  ctx.syncServiceModeUi(false);
  assert.equal(S.serviceMode, false, 'S.serviceMode must be set to false');
  assert.ok(!skipBtn.classes.has('hidden'), '#pin-setup-skip must not have hidden class in dev mode');
  assert.equal(exitBtn.title, 'Quit / Exit POS', 'Exit button title should be restored');
});

test('Task 3: skipPinSetup is blocked when S.serviceMode is true', () => {
  const authSrc = source('public/js/auth.js');
  const start = authSrc.indexOf('export function skipPinSetup()');
  const end = authSrc.indexOf('\nexport ', start + 1);
  const code = authSrc.slice(start, end).replace('export ', '');

  let overlayHidden = false;
  let sessionStored = false;
  const S = { serviceMode: true };
  const ctx = vm.createContext({
    S,
    isPinSetupSubmitting: false,
    sessionStorage: { setItem: () => { sessionStored = true; } },
    document: {
      getElementById: id => (id === 'pin-setup-overlay' ? { classList: { add: () => { overlayHidden = true; } } } : null)
    },
    syncAppInert: () => {},
    showToast: () => {}
  });
  vm.runInContext(code, ctx);

  // In service mode:
  ctx.skipPinSetup();
  assert.equal(overlayHidden, false, 'skipPinSetup must not hide overlay when in service mode');
  assert.equal(sessionStored, false, 'skipPinSetup must not record pin_setup_skipped when in service mode');

  // In non-service mode:
  S.serviceMode = false;
  ctx.skipPinSetup();
  assert.equal(overlayHidden, true, 'skipPinSetup hides overlay in non-service mode');
  assert.equal(sessionStored, true, 'skipPinSetup stores skipped in non-service mode');
});

test('Task 3: shutdownServer renders Close POS screen and skips API call in service mode', async () => {
  const backofficeSrc = source('public/js/views/backoffice.js');
  const start = backofficeSrc.indexOf('export async function shutdownServer()');
  const end = backofficeSrc.indexOf('\nexport ', start + 1);
  const code = backofficeSrc.slice(start, end > -1 ? end : undefined).replace('export ', '');

  let apiCalled = false;
  let closed = false;
  const S = { serviceMode: true };
  let bodyHtml = '';
  const ctx = vm.createContext({
    S,
    hasElevation: () => false,
    requireManagerPin: () => { throw new Error('should not prompt manager pin'); },
    confirmModal: async () => true,
    document: {
      body: {
        set innerHTML(v) { bodyHtml = v; },
        get innerHTML() { return bodyHtml; }
      }
    },
    window: { close: () => { closed = true; } },
    fetch: async () => { apiCalled = true; return { ok: true }; }
  });
  vm.runInContext(code, ctx);

  await ctx.shutdownServer();
  assert.equal(apiCalled, false, 'shutdownServer must not call /api/system/shutdown in service mode');
  assert.equal(closed, true, 'shutdownServer must call window.close()');
  assert.ok(bodyHtml.includes('POS Window Closed'), 'must render POS Window Closed screen');
  assert.ok(bodyHtml.includes('Background server stays active'), 'must inform user background server stays active');
});

test('Task 3: downloadBackup requires elevation, creates backup, and triggers browser download', async () => {
  const backofficeSrc = source('public/js/views/backoffice.js');
  assert.match(backofficeSrc, /export async function downloadBackup\(/, 'backoffice.js must export downloadBackup');
  const start = backofficeSrc.indexOf('export async function downloadBackup()');
  const end = backofficeSrc.indexOf('\nexport ', start + 1);
  const code = backofficeSrc.slice(start, end > -1 ? end : undefined).replace('export ', '');

  let elevationPrompted = false;
  let backupPostCalled = false;
  let downloadedUrl = '';
  let downloadedFile = '';
  let elevated = false;

  let toastCalls = [];
  const ctx = vm.createContext({
    hasElevation: () => elevated,
    requireManagerPin: (reason, cb) => {
      elevationPrompted = true;
      elevated = true;
      cb();
    },
    fetch: async (url, opts) => {
      if (url === '/api/backup' && opts?.method === 'POST') {
        backupPostCalled = true;
        return { ok: true, json: async () => ({ success: true, backup_file: 'shop-20261111-test.db' }) };
      }
      return { ok: false };
    },
    downloadCsvFile: async (url, file) => {
      downloadedUrl = url;
      downloadedFile = file;
      return true;
    },
    showToast: (msg, type) => { toastCalls.push({ msg, type }); }
  });
  vm.runInContext(code, ctx);

  await ctx.downloadBackup();
  assert.equal(elevationPrompted, true, 'must require manager pin if not elevated');
  assert.equal(backupPostCalled, true, 'must call POST /api/backup');
  assert.equal(downloadedFile, 'shop-20261111-test.db');
  assert.ok(downloadedUrl.includes('/api/backup/download?file=shop-20261111-test.db'));
  assert.ok(toastCalls.some(t => t.type === 'success' && t.msg.includes('Backup downloaded')), 'emits success toast when download succeeds');

  // When downloadCsvFile returns false (failed/rejected download), NO success toast must be emitted
  toastCalls = [];
  const ctxFailed = vm.createContext({
    hasElevation: () => true,
    requireManagerPin: (_reason, cb) => cb(),
    fetch: async () => ({ ok: true, json: async () => ({ success: true, backup_file: 'shop-20261111-fail.db' }) }),
    downloadCsvFile: async () => false,
    showToast: (msg, type) => { toastCalls.push({ msg, type }); }
  });
  vm.runInContext(code, ctxFailed);
  await ctxFailed.downloadBackup();
  assert.equal(toastCalls.filter(t => t.type === 'success').length, 0, 'must NOT emit success toast when downloadCsvFile returns false');
});

test('downloadCsvFile returns true on success and false on error', async () => {
  const mainSrc = source('public/js/main.js');
  const start = mainSrc.indexOf('export async function downloadCsvFile(');
  const end = mainSrc.indexOf('\nexport ', start + 1);
  const code = mainSrc.slice(start, end > -1 ? end : undefined).replace('export ', '');

  let clicked = false;
  const fakeElement = {
    set href(v) {},
    set download(v) {},
    click: () => { clicked = true; },
    remove: () => {}
  };
  const makeCtx = (fetchImpl) => vm.createContext({
    fetch: fetchImpl,
    document: {
      createElement: () => fakeElement,
      body: { appendChild: () => {} }
    },
    URL: {
      createObjectURL: () => 'blob:test',
      revokeObjectURL: () => {}
    },
    setTimeout: (fn) => fn(),
    showToast: () => {}
  });

  const ctxSuccess = makeCtx(async () => ({ ok: true, blob: async () => ({}) }));
  vm.runInContext(code, ctxSuccess);
  const successResult = await ctxSuccess.downloadCsvFile('/test', 'test.csv');
  assert.equal(successResult, true, 'downloadCsvFile must return true on success');
  assert.equal(clicked, true, 'download trigger clicked');

  const ctxFail = makeCtx(async () => ({ ok: false }));
  vm.runInContext(code, ctxFail);
  const failResult = await ctxFail.downloadCsvFile('/test', 'test.csv');
  assert.equal(failResult, false, 'downloadCsvFile must return false on HTTP failure');
});

test('Task 3: submitPinChange prompts for recovery password when !S.recoveryConfigured', async () => {
  const authSrc = source('public/js/auth.js');
  const start = authSrc.indexOf('export async function submitPinChange()');
  const end = authSrc.indexOf('export function syncRecoveryStatusUi', start + 1);
  const code = authSrc.slice(start, end).replace('export ', '');

  let focusedRecovery = false;
  let errorMsg = '';
  let apiCalled = false;
  const S = { recoveryConfigured: false };
  const ctx = vm.createContext({
    S,
    document: {
      getElementById: id => {
        if (id === 'settings-current-pin') return { value: '1234' };
        if (id === 'settings-new-pin') return { value: '5678' };
        if (id === 'settings-pin-msg') return { textContent: '', classList: { remove() {}, add() {} }, set textContent(v) { errorMsg = v; } };
        if (id === 'settings-recovery-new') return { focus: () => { focusedRecovery = true; } };
        return null;
      }
    },
    setTimeout: (fn) => fn(),
    fetch: async () => { apiCalled = true; return { ok: true }; }
  });
  vm.runInContext(code, ctx);

  await ctx.submitPinChange();
  assert.equal(apiCalled, false, 'must not call change-pin when recovery password is not configured');
  assert.ok(errorMsg.includes('Manager Recovery Password'), 'must explain why change was blocked');
  assert.equal(focusedRecovery, true, 'must focus the recovery password input');
});

test('Task 3: submitPinSetup validates recovery password and posts to /api/auth/recovery-password', async () => {
  const authSrc = source('public/js/auth.js');
  const start = authSrc.indexOf('let pinSetupPinChanged = false;');
  const end = authSrc.indexOf('export function requireManagerPin', start + 1);
  const code = authSrc.slice(start, end).replace(/export /g, '');

  const dom = {
    'setup-shop-name': { value: 'FixZone Repair' },
    'setup-owner-name': { value: 'Owner' },
    'setup-shop-address': { value: 'Branch 1' },
    'setup-shop-phone': { value: '09171234567' },
    'setup-footer-note': { value: 'Thanks' },
    'setup-warranty-days': { value: '7' },
    'pin-setup-new': { value: '5678', removeAttribute() {}, setAttribute() {} },
    'pin-setup-confirm': { value: '5678', removeAttribute() {}, setAttribute() {} },
    'pin-setup-recovery': { value: 'short', removeAttribute() {}, setAttribute() {} },
    'pin-setup-recovery-confirm': { value: 'short', removeAttribute() {}, setAttribute() {} },
    'setup-seed-parts': { checked: false },
    'setup-license-key': { value: '' },
    'pin-setup-error': { classList: { add() {}, remove() {} }, textContent: '' },
    'pin-setup-overlay': { classList: { add() {} } }
  };

  let postedUrls = [];
  let postedBodies = [];
  const S = {
    serviceMode: false,
    recoveryConfigured: false,
    shopSettings: {},
    sessionToken: null
  };

  const ctx = vm.createContext({
    S,
    isPinSetupSubmitting: false,
    document: {
      getElementById: id => dom[id] || null,
      querySelector: sel => {
        if (sel === '[data-action="save-pin-setup"]') return { disabled: false, textContent: 'Save' };
        if (sel === '[data-action="skip-pin-setup"]') return { disabled: false };
        if (sel === '[data-setup-width].is-active') return { dataset: { setupWidth: '80mm' } };
        return null;
      }
    },
    extractLicenseKeyClient: () => '',
    loadShopSettings: async () => {},
    loadPosCatalog: async () => {},
    syncAppInert: () => {},
    showToast: () => {},
    setElevation: () => {},
    sessionStorage: { setItem: () => {} },
    fetch: async (url, opts) => {
      postedUrls.push(url);
      postedBodies.push(JSON.parse(opts?.body || '{}'));
      if (url === '/api/auth/change-pin') return { ok: true, json: async () => ({ token: 't-123' }) };
      if (url === '/api/auth/recovery-password') return { ok: true, json: async () => ({ success: true }) };
      if (url === '/api/settings') return { ok: true, json: async () => ({ success: true }) };
      return { ok: true, json: async () => ({}) };
    }
  });
  vm.runInContext(code, ctx);

  // Short recovery password fails validation
  await ctx.submitPinSetup();
  assert.ok(dom['pin-setup-error'].textContent.includes('at least 6 characters'), 'must reject short recovery password');
  assert.equal(postedUrls.length, 0, 'no network requests on validation failure');

  // Valid recovery password passes and posts recovery password
  dom['pin-setup-recovery'].value = 'master-secret-pw';
  dom['pin-setup-recovery-confirm'].value = 'master-secret-pw';
  await ctx.submitPinSetup();

  assert.ok(postedUrls.includes('/api/auth/change-pin'), 'calls change-pin');
  assert.ok(postedUrls.includes('/api/auth/recovery-password'), 'calls /api/auth/recovery-password');
  const recBody = postedBodies[postedUrls.indexOf('/api/auth/recovery-password')];
  assert.equal(recBody.recovery_password, 'master-secret-pw', 'sends recovery_password payload');
  assert.equal(S.recoveryConfigured, true, 'marks recoveryConfigured in state');
});

test('Task 3: showUpdateHandoffStalled displays ProgramData log path when serviceMode is true', () => {
  const backofficeSrc = source('public/js/views/backoffice.js');
  const start = backofficeSrc.indexOf('function showUpdateHandoffStalled(releaseUrl, waitedS)');
  const end = backofficeSrc.indexOf('\nfunction ', start + 1);
  const code = backofficeSrc.slice(start, end > -1 ? end : undefined);

  let capturedHtml = '';
  const S = { serviceMode: true };
  const ctx = vm.createContext({
    S,
    document: {
      body: {
        set innerHTML(v) { capturedHtml = v; }
      },
      getElementById: () => null
    }
  });
  vm.runInContext(code, ctx);

  ctx.showUpdateHandoffStalled('', 30);
  assert.ok(capturedHtml.includes('C:\\ProgramData\\TechPartsPOS\\updates\\TechPartsPOS_update.handoff.log'),
    'must reference ProgramData log path when S.serviceMode is true');

  S.serviceMode = false;
  ctx.showUpdateHandoffStalled('', 30);
  assert.ok(capturedHtml.includes('%LOCALAPPDATA%\\TechPartsPOS\\TechPartsPOS_update.handoff.log'),
    'must reference %LOCALAPPDATA% log path when S.serviceMode is false');
});

test('Task 3: Forgot PIN flow opens recovery panel when configured and resets PIN on valid submission', async () => {
  const authSrc = source('public/js/auth.js');
  const start = authSrc.indexOf('export async function openForgotPinPanel()');
  const end = authSrc.indexOf('export async function submitLoginPin', start + 1);
  const code = authSrc.slice(start, end).replace(/export /g, '');

  const dom = {
    'login-gate-forgot-pin': { classes: new Set(['hidden']), classList: { add(c) { dom['login-gate-forgot-pin'].classes.add(c); }, remove(c) { dom['login-gate-forgot-pin'].classes.delete(c); } } },
    'login-gate-no-recovery': { classes: new Set(['hidden']), classList: { add(c) { dom['login-gate-no-recovery'].classes.add(c); }, remove(c) { dom['login-gate-no-recovery'].classes.delete(c); } } },
    'recover-error': { classes: new Set(['hidden']), textContent: '', classList: { add(c) { dom['recover-error'].classes.add(c); }, remove(c) { dom['recover-error'].classes.delete(c); } } },
    'recover-pw': { value: '', focus() {} },
    'recover-new-pin': { value: '' },
    'recover-confirm-pin': { value: '' },
    'login-gate-pin': { value: '', focus() {} },
    'login-gate': { classList: { add() {} } }
  };

  let configured = false;
  let recoverCalled = false;
  let recoverPayload = null;
  let resolvedLogin = false;
  const S = {
    sessionToken: null,
    sessionActor: null,
    loginGateResolve: () => { resolvedLogin = true; }
  };

  const ctx = vm.createContext({
    S,
    document: { getElementById: id => dom[id] || null },
    setTimeout: fn => fn(),
    sessionStorage: { setItem: () => {} },
    setElevation: () => {},
    hideLoginGate: () => {},
    applyRoleVisibility: () => {},
    showToast: () => {},
    fetch: async (url, opts) => {
      if (url === '/api/auth/recovery-status') {
        return { ok: true, json: async () => ({ configured }) };
      }
      if (url === '/api/auth/recover-pin') {
        recoverCalled = true;
        recoverPayload = JSON.parse(opts.body);
        return {
          ok: true,
          json: async () => ({
            success: true,
            token: 'tok-recovered-mgr',
            actor: { type: 'manager', id: null, name: 'Manager' },
            elevationToken: 'elev-recovered'
          })
        };
      }
      return { ok: false };
    }
  });
  vm.runInContext(code, ctx);

  // 1. When recovery is not configured on the workstation
  configured = false;
  await ctx.openForgotPinPanel();
  assert.ok(dom['login-gate-forgot-pin'].classes.has('hidden'), 'forgot-pin panel remains hidden when unconfigured');
  assert.ok(!dom['login-gate-no-recovery'].classes.has('hidden'), 'no-recovery notice is displayed when unconfigured');

  // 2. When recovery is configured
  configured = true;
  await ctx.openForgotPinPanel();
  assert.ok(!dom['login-gate-forgot-pin'].classes.has('hidden'), 'forgot-pin panel is displayed when configured');
  assert.ok(dom['login-gate-no-recovery'].classes.has('hidden'), 'no-recovery notice is hidden when configured');

  // 3. Submitting invalid recovery PIN reset
  dom['recover-pw'].value = '';
  await ctx.submitRecoveryPinReset();
  assert.equal(recoverCalled, false, 'must not call API when fields are empty');
  assert.ok(!dom['recover-error'].classes.has('hidden'), 'error is displayed');

  // 4. Submitting valid recovery PIN reset
  dom['recover-pw'].value = 'correct-recovery-pw';
  dom['recover-new-pin'].value = '9876';
  dom['recover-confirm-pin'].value = '9876';
  await ctx.submitRecoveryPinReset();

  assert.equal(recoverCalled, true, 'calls /api/auth/recover-pin');
  assert.equal(recoverPayload.recovery_password, 'correct-recovery-pw');
  assert.equal(recoverPayload.new_pin, '9876');
  assert.equal(S.sessionToken, 'tok-recovered-mgr', 'adopts returned session token');
  assert.equal(S.sessionActor.name, 'Manager', 'adopts Manager session actor');
  assert.equal(resolvedLogin, true, 'continues post-login app initialization');
});



