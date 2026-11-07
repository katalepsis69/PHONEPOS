const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const source = file => fs.readFileSync(path.join(ROOT, file), 'utf8');

test('sale retries retain one operation id and validate credit downpayments', () => {
  const pos = source('public/js/views/pos.js');

  assert.match(pos, /S\.saleOpId \|\|=/);
  assert.match(pos, /op_id: S\.saleOpId/);
  assert.match(pos, /S\.saleOpId = null/);
  assert.match(pos, /localStorage\.getItem\(SALE_OP_KEY\)/);
  assert.match(pos, /localStorage\.setItem\(SALE_OP_KEY, S\.saleOpId\)/);
  assert.match(pos, /localStorage\.removeItem\(SALE_OP_KEY\)/);
  assert.match(pos, /saleOpId: S\.saleOpId/);
  assert.match(pos, /resetRepairCounter\(\{ clearSaleOp: false \}\)/);
  assert.match(pos, /!Number\.isFinite\(amountPaid\) \|\| amountPaid < 0 \|\| toCents\(amountPaid\) > toCents\(totalAmount\)/);
});

test('settings save leaves write-only sync token unchanged when blank', () => {
  const auth = source('public/js/auth.js');

  assert.match(auth, /sync_token_configured/);
  assert.match(auth, /\.\.\.\(syncTokenReplacement \? \{ sync_token: syncTokenReplacement \} : \{\}\)/);
  assert.doesNotMatch(auth, /sync_token\s*\n\s*\}\)/);
});

test('report authentication is scoped to session storage', () => {
  const reportJs = source('public/js/report.js'); // logic lives in the CSP-safe external file

  assert.match(reportJs, /sessionStorage\.setItem\(TOKEN_KEY, token\)/);
  assert.match(reportJs, /sessionStorage\.getItem\(TOKEN_KEY\)/);
  assert.match(reportJs, /sessionStorage\.removeItem\(TOKEN_KEY\)/);
  assert.doesNotMatch(reportJs, /localStorage\.(?:setItem|getItem|removeItem)\(TOKEN_KEY/);
});

test('filtered frontend loaders discard stale responses', () => {
  const inventory = source('public/js/views/inventory.js');
  const backoffice = source('public/js/views/backoffice.js');

  assert.match(inventory, /request !== inventoryRequest/);
  for (const counter of ['returnsRequest', 'customersRequest', 'salesRequest', 'dashboardRequest']) {
    assert.match(backoffice, new RegExp(`request !== ${counter}`));
  }
});

test('POS search stays local and printable reports keep counts non-monetary', () => {
  const main = source('public/js/main.js');
  const pos = source('public/js/views/pos.js');
  const receipts = source('public/js/receipts.js');

  assert.match(main, /pos: \{ input: 'pos-search-input', load: \(\) => renderPartsTable\(\) \}/);
  assert.equal((main.match(/on\('pos-search-input', 'input'/g) || []).length, 1);
  assert.equal((pos.match(/pos-search-input'\)\?\.addEventListener\('input'/g) || []).length, 0);
  assert.match(receipts, /moneyRow\('Parts', c\.parts_revenue\)/);
  assert.match(receipts, /moneyRow\('Labor', c\.labor_revenue\)/);
  assert.match(receipts, /countRow\('Sales completed', c\.sale_count\)/);
  assert.doesNotMatch(receipts, /row\('Parts \/ Labor'/);
});

test('reprint unwraps the sale response and palette copy matches its scope', () => {
  const backoffice = source('public/js/views/backoffice.js');
  const index = source('public/index.html');

  assert.doesNotMatch(index, /Search customers, parts, sale codes/);
  assert.doesNotMatch(index, /Search parts, customers, sale codes/);
});

test('counter hygiene: tier resets per job, discount caps at subtotal, zero-peso sales are refused', () => {
  const pos = source('public/js/views/pos.js');

  // F13: the price tier is per-job state; a technician job must not leak
  // wholesale prices into the next customer
  assert.match(pos, /S\.currentPriceTier = 'retail';\s*\n\s*syncTierButtons\('retail'\)/);
  // F12 client half: the discount never exceeds the running subtotal
  assert.match(pos, /Math\.min\(subtotalCents, Math\.max\(0, toCents\(/);
  // F14: nothing billable means no sale and no receipt
  assert.match(pos, /Order has nothing to charge/);
  // F6 client half: counted cash uses the numbered modal, not prompt()
  assert.match(pos, /inputModal\('Counted cash', \{ inputType: 'number'/);
  assert.doesNotMatch(pos, /prompt\('Counted cash/);
});

test('failed loads are honest: settings banner, view retry states, Z-report refuses wrong shape', () => {
  const auth = source('public/js/auth.js');
  const back = source('public/js/views/backoffice.js');
  const receipts = source('public/js/receipts.js');

  // F53: a settings fetch failure is a persistent banner, not a console whisper
  assert.match(auth, /S\.shopSettingsUnavailable = true/);
  assert.match(auth, /showSettingsBanner\(\)/);
  assert.match(receipts, /shopIdentityIsPlaceholder\(\)/);
  assert.match(receipts, /placeholder\. Save real shop details/);
  // F54: each failing view renders a Retry affordance, never a fake empty state
  assert.match(back, /data-action="reload-customers">Retry/);
  assert.match(back, /data-action="reload-sales">Retry/);
  assert.match(auth, /data-action="reload-staff">Retry/);
  assert.doesNotMatch(auth, /catch \(_\) \{\}\s*\n\s*list\.innerHTML/);
  // F55: the Z-report requires its keys before anything prints
  assert.match(receipts, /Z_REQUIRED_KEYS/);
  assert.match(receipts, /Report data is incomplete/);
});

test('cart math mirrors the server cent rule and cart lines re-price from the catalog', () => {
  const pos = source('public/js/views/pos.js');
  const { money } = require('../src/money');

  const math = pos.slice(pos.indexOf('export function unitPriceOf'), pos.indexOf('export function renderCartSummary'));
  const reprice = pos.slice(pos.indexOf('function repriceCartLines'), pos.indexOf('function syncTierButtons'));
  let discountValue = '';
  const S = { currentPriceTier: 'retail', cart: [], posCatalog: [] };
  const document = { getElementById: id => id === 'pos-discount' ? { value: discountValue } : null };
  const ctx = vm.createContext({ S, document, console });
  vm.runInContext(`${math.replace(/export /g, '')}\n${reprice.replace(/export /g, '')}`, ctx);

  // The audit's 27% drift class: raw float accumulation vs per-line cents.
  const cases = [
    [[0.1, 1], [0.2, 1]],
    [[1.1, 3], [2.2, 7]],
    [[19.99, 1], [0.07, 13], [3.33, 5]],
    [[999.99, 2], [0.01, 1]],
    [[49.95, 3], [0.05, 9]]
  ];
  for (const c of cases) {
    S.cart = c.map(([price, qty], i) => ({ id: i + 1, is_labor: false, price_retail: price, qty }));
    const client = vm.runInContext('cartTotals()', ctx);
    let serverSub = 0;
    for (const [price, qty] of c) serverSub = money(serverSub + money(money(price) * qty));
    assert.equal(client.subtotal, serverSub, `client subtotal matches server for ${JSON.stringify(c)}`);
    assert.ok(Number.isInteger(Math.round(client.total * 100)), 'total lands on a whole centavo');
    assert.ok(Math.abs(client.subtotal * 100 - Math.round(client.subtotal * 100)) < 1e-9);
  }

  // Decimal halves the binary float cannot hold: the client must round the way
  // src/money.js does, or a typed discount books a cent away from the screen.
  for (const typed of ['1.005', '8.575', '0.145', '1.015']) {
    S.cart = [{ id: 1, is_labor: false, price_retail: 100, qty: 1 }];
    discountValue = typed;
    const got = vm.runInContext('cartTotals()', ctx);
    assert.equal(got.discount, money(Number(typed)), `discount ${typed} matches the server rule`);
  }
  discountValue = '';

  // Tier switch prices from the technician column, like the server re-price.
  S.currentPriceTier = 'technician';
  S.cart = [{ id: 1, is_labor: false, price_retail: 100, price_technician: 85.5, qty: 2 }];
  assert.equal(vm.runInContext('cartTotals()', ctx).total, 171);
  S.currentPriceTier = 'retail';

  // A typed discount rounds half-away-from-zero before subtracting.
  S.cart = [{ id: 1, is_labor: false, price_retail: 50, qty: 2 }];
  discountValue = '33.335';
  const disc = vm.runInContext('cartTotals()', ctx);
  assert.equal(disc.subtotal, 100);
  assert.equal(disc.discount, 33.34);
  assert.equal(disc.total, 66.66);
  // Discount caps at the subtotal: no negative totals, no zero-peso sale.
  discountValue = '500';
  assert.equal(vm.runInContext('cartTotals()', ctx).total, 0);
  discountValue = '';

  // Re-price: a catalog price change reaches every open cart line.
  S.cart = [{ id: 7, is_labor: false, price_retail: 100, price_technician: 90, stock: 9, qty: 2 }];
  S.posCatalog = [{ id: 7, price_retail: 120.5, price_technician: 95.25, stock_quantity: 3 }];
  vm.runInContext('repriceCartLines()', ctx);
  assert.equal(S.cart[0].price_retail, 120.5);
  assert.equal(S.cart[0].price_technician, 95.25);
  assert.equal(S.cart[0].stock, 3);
  // A part gone from the catalog keeps its snapshot; the server rejects with
  // its own error rather than the screen inventing a price.
  S.cart = [{ id: 99, is_labor: false, price_retail: 42, price_technician: 40, stock: 1, qty: 1 }];
  vm.runInContext('repriceCartLines()', ctx);
  assert.equal(S.cart[0].price_retail, 42);

  // Wired into every render path, which includes catalog reload and recovery.
  assert.match(pos, /export function renderCart\(\) \{\s*\n\s*repriceCartLines\(\);/);
});

test('every client module parses before a browser is asked to run it', () => {
  // Most of this file matches source text, so a broken statement in the SPA
  // could ship green: this is the one check that actually parses it.
  const dirs = ['public/js', 'public/js/views'];
  let checked = 0;
  for (const dir of dirs) {
    for (const f of fs.readdirSync(path.join(ROOT, dir))) {
      if (!f.endsWith('.js')) continue;
      const file = path.join(ROOT, dir, f);
      const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
      assert.equal(r.status, 0, `${dir}/${f} does not parse: ${String(r.stderr).slice(0, 200)}`);
      checked++;
    }
  }
  assert.ok(checked >= 10, `expected the whole client tree, checked only ${checked}`);
});

test('static file streams carry an error handler so a mid-read failure cannot hang the response', () => {
  const serverSrc = source('src/server.js');
  assert.match(serverSrc, /createReadStream\(filePath\)\s*\.on\('error', \(\) => res\.destroy\(\)\)/);
});

test('both settlement slip paths respect the placeholder identity gate', () => {
  const backoffice = source('public/js/views/backoffice.js');
  assert.match(backoffice, /import \{[^}]*shopIdentityIsPlaceholder[^}]*\} from '\.\.\/receipts\.js';/);

  // Direct print action (ledger row button): refuse before rendering anything.
  const reprint = backoffice.slice(backoffice.indexOf('export function printSettlementReceiptById'));
  const gate1 = reprint.indexOf('if (shopIdentityIsPlaceholder())');
  const render1 = reprint.indexOf('renderSettlementReceipt(payment, S.activeCustomerDetails);');
  assert.ok(gate1 !== -1 && gate1 < render1, 'gate precedes render in printSettlementReceiptById');

  // Post-settlement auto-print: gate precedes the print branch, as in pos.js.
  // The branch is the ESC/POS ask now, with the dialog only behind it.
  const submit = backoffice.slice(backoffice.indexOf('const details = await res.json();'));
  const gate2 = submit.indexOf('if (shopIdentityIsPlaceholder())');
  const print2 = submit.indexOf("{ kind: 'settlement'");
  assert.ok(gate2 !== -1 && gate2 < print2, 'gate precedes auto-print in submitCreditSettlement');
  assert.ok(submit.indexOf('renderSettlementReceipt(payment, details)') < print2, 'the slip is on screen before the queue is asked');
});

test('remediation batch: idempotency keys wired, dead dispatcher entries gone, labels re-keyed', () => {
  const backoffice = source('public/js/views/backoffice.js');
  // Both money paths send a client op_id so a timeout retry replays, not duplicates.
  assert.match(backoffice, /op_id: pendingReturnOpId/);
  assert.match(backoffice, /op_id: pendingSettleOpId/);
  assert.match(backoffice, /pendingReturnOpId = newOpId\(\)/, 'return key is minted when the dialog opens');

  const main = source('public/js/main.js');
  assert.doesNotMatch(main, /'reprint-sale':/, 'dead dispatcher entry removed');
  assert.doesNotMatch(main, /'refresh-exceptions':/, 'dead dispatcher entry removed');

  const auth = source('public/js/auth.js');
  // Re-keyed from the actions the server actually emits.
  assert.match(auth, /'receipt reprint':/, 'reprint label keyed to the real receipt category');
  assert.match(auth, /'inventory adjust_stock':/,);
  assert.doesNotMatch(auth, /'security staff_add'/, 'drifted key removed');
  assert.doesNotMatch(auth, /'credit utang':/, 'dead key removed');
});
