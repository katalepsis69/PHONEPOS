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

test('manager elevation survives F5 but not logout or expiry', () => {
  const auth = source('public/js/auth.js');
  const main = source('public/js/main.js');

  // setElevation mirrors the token into sessionStorage next to pos_session
  assert.match(auth, /sessionStorage\.setItem\('pos_elevation', JSON\.stringify\(\{ t: S\.elevationToken, e: S\.elevationExpiresAt \}\)\)/);
  // expiry timer and logout both drop the stored token
  assert.match(auth, /setElevation\(null, 0\)/);
  assert.match(auth, /sessionStorage\.removeItem\('pos_session'\); sessionStorage\.removeItem\('pos_elevation'\)/);
  // boot restore only revives an unexpired token
  assert.match(main, /sessionStorage\.getItem\('pos_elevation'\)/);
  assert.match(main, /Number\(savedElevation\.e\) > Date\.now\(\)/);
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
    [[49.95, 3], [0.05, 9]],
    // Fractional quantities: the client must round the unit*qty product the
    // way src/money.js does, not cents(unit)*qty (a centavo off on halves).
    [[0.25, 0.58], [0.05, 0.7], [0.2, 0.575], [0.33, 0.333]]
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
  // F2: the stale wholesale snapshot must refresh too, or unitPriceOf quotes
  // a price the register will not charge.
  S.cart = [{ id: 7, is_labor: false, price_retail: 100, price_technician: 90, price_wholesale: 90, stock: 9, qty: 2 }];
  S.posCatalog = [{ id: 7, price_retail: 120.5, price_technician: 95.25, price_wholesale: 95.25, stock_quantity: 3 }];
  vm.runInContext('repriceCartLines()', ctx);
  assert.equal(S.cart[0].price_wholesale, 95.25);
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

test('audit feed: sentence-first, outcome-only color, repeat collapse', () => {
  const auth = source('public/js/auth.js');
  const html = source('public/index.html');
  assert.match(auth, /function auditSentence\(r, d\)/);
  assert.match(auth, /audit-line__sentence--neg/);
  assert.match(auth, /audit-line__sentence--pos/);
  assert.match(auth, /details class="audit-repeat"/);
  assert.match(auth, /auditCategoryLabel\(group\.category\)/);
  // Categories are plain words now; the colored category badges are gone.
  assert.doesNotMatch(auth, /audit-tag--/);
  assert.doesNotMatch(auth, /audit-narrative/);
  // The raw payload stays reachable one Details click away.
  assert.match(auth, /Inspect payload|>Details</);
  // Who sits in its own scannable column, not the faint meta line; identifiers
  // are bolded refs; sentence is HTML built with ref()/txt() escaping at the
  // source (renderer no longer re-escapes it).
  assert.match(auth, /audit-line__actor/);
  assert.match(auth, /audit-line__ref/);
  assert.match(auth, /sentence\.html/);
  assert.doesNotMatch(auth, /escHtml\(sentence\.text\)/, 'escaping moved into the sentence builders');
  // The five numeric-only payload interpolations are escaped like everything
  // else: if a future server change logs a string into one of these keys, it
  // must not reach innerHTML raw (2026-11-09 audit).
  assert.match(auth, /txt\(d\.items\)/);
  assert.match(auth, /stock \$\{txt\(d\.stock\)\}/);
  assert.match(auth, /txt\(d\.created \|\| 0\)/);
  assert.match(auth, /txt\(d\.count \|\| 0\)/);
  assert.match(auth, /txt\(d\.backfill_rows\)/);
  // Highlights: category dot + elevated badge in the meta, single-occurrence
  // groups render plain (no "1 times" expander).
  assert.match(auth, /audit-cat-dot/);
  assert.match(auth, /audit-elev-badge/);
  assert.doesNotMatch(auth, /1 times/, 'single occurrences render plain, counts pluralize');
  assert.match(html, /<ol id="audit-tbody" class="audit-feed"/);
  assert.doesNotMatch(html, /audit-table/);
  const styles = source('public/styles.css');
  assert.match(styles, /\.audit-line__actor\s*\{/);
  assert.match(styles, /\.audit-line__ref\s*\{/);
  assert.match(styles, /\.audit-cat-dot\s*\{/);
  assert.match(styles, /\.audit-elev-badge\s*\{/);
  assert.match(styles, /\.audit-line__time\s*\{[^}]*white-space:\s*nowrap/, 'timestamps never wrap to two lines');
});

test('receipt templates ship with a paper preview wired to the print builder', () => {
  const auth = source('public/js/auth.js');
  assert.match(auth, /loadReceiptPreview/);
  assert.match(auth, /\/api\/receipt\/preview/);
  const printer = source('src/printer.js');
  for (const t of ['saleSlipStandard', 'saleSlipCompact', 'saleSlipBoxed', 'saleSlipAiry', 'saleSlipGrid']) {
    assert.match(printer, new RegExp(`function ${t}[\\(]`));
  }
  assert.match(printer, /SALE_TEMPLATES\.has\(settings\.receipt_template\)/);
  const server = source('src/server.js');
  assert.match(server, /\/api\/receipt\/preview/);
  assert.match(server, /if \(!elevated\) return elevationDenied\(\);[\s\S]*?const overrides = await parseBody\(req\);/);
  const html = source('public/index.html');
  for (const id of ['settings-template', 'settings-item-rows', 'settings-receipt-preview']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  // The preview renders one block per line with no '\n' joins: a display:block
  // span already breaks the line, so joining with a newline showed blank lines
  // between centered/wide rows that the roll never prints.
  const styles = source('public/styles.css');
  assert.match(auth, /const cls = `rp-l\$\{l\.centered \? ' rp-c' : ''\}\$\{l\.wide \? ' rp-w' : ''\}`;/);
  assert.match(auth, /escHtml\(l\.text\) \|\| '\\u00a0'/, 'empty lines keep their height');
  assert.doesNotMatch(auth, /join\('\\n'\)/);
  assert.match(styles, /\.receipt-preview \.rp-l \{ display: block; \}/);
  assert.match(styles, /\.receipt-preview \.rp-c \{ text-align: center; \}/);
});

test('feedback dialog composes a pre-filled report with no backend', () => {
  const main = source('public/js/main.js');
  assert.match(main, /bfffpt@gmail\.com/);
  assert.match(main, /mailto:\$\{FEEDBACK_EMAIL\}/);
  assert.match(main, /mail\.google\.com\/mail\/\?view=cm/);
  assert.match(main, /compose\.mail\.yahoo\.com/);
  assert.match(main, /navigator\.clipboard\.writeText/);
  const html = source('public/index.html');
  assert.match(html, /id="modal-feedback"/);
  assert.match(html, /data-action="open-feedback"/);
});

test('fractional order lines show the centavo the register charges', () => {
  const pos = source('public/js/views/pos.js');
  // Slice the order-sheet region through the money helpers it needs; renderCart
  // stays defined but uninvoked, so no extra DOM stubs are required.
  const code = pos.slice(
    pos.indexOf('export function renderOrderLines'),
    pos.indexOf('export function renderCartSummary')
  ).replace(/export /g, '');

  const boxes = { 'sum-parts': { innerHTML: '', closest: () => null }, 'sum-services': { innerHTML: '', closest: () => null } };
  const counters = [];
  const ctx = vm.createContext({
    S: {
      currentPriceTier: 'retail',
      cart: [{ is_labor: false, id: 1, brand: 'Rice', model_name: 'Premium', part_type: 'Grain',
        price_retail: 12.35, price_technician: 10, qty: 0.3 }],
      posCatalog: []
    },
    document: { getElementById: id => boxes[id] || null },
    t: (key, fallback) => fallback,
    escHtml: s => String(s),
    fmtMoney: v => `P${Number(v).toFixed(2)}`,
    setCounterText: (id, text) => counters.push(`${id}: ${text}`)
  });
  vm.runInContext(code, ctx);
  ctx.renderOrderLines();

  // server money(12.35 * 0.3) = 3.70; the old Math.round(toCents(unit) * qty)
  // producted 371, so the line read one centavo above the register total.
  assert.ok(boxes['sum-parts'].innerHTML.includes('P3.70'), `line must show 3.70, got: ${boxes['sum-parts'].innerHTML}`);
  assert.ok(!boxes['sum-parts'].innerHTML.includes('P3.71'), 'line must not show the stale 3.71');
  ctx.document.getElementById = id => (id === 'pos-discount' ? { value: '' } : boxes[id] || null);
  assert.equal(ctx.cartTotals().subtotal, 3.7, 'cart totals must agree with the displayed line');
});

test('renderBrandChips skips out-of-stock brands when posInStockOnly is on and CSS bounds chip height', () => {
  const pos = source('public/js/views/pos.js');
  const css = source('public/styles.css');

  assert.match(css, /\.brand-chips\s*\{[^}]*max-height:\s*\d+px;[^}]*overflow-y:\s*auto;/s);

  const fnStart = pos.indexOf('export function renderBrandChips()');
  const fnEnd = pos.indexOf('\nexport function renderCategoryOptions()');
  const code = pos.slice(fnStart, fnEnd).replace(/^export /, '');

  const box = { innerHTML: '' };
  const ctx = vm.createContext({
    S: {
      shopSettings: { business_type: 'phone' },
      posInStockOnly: true,
      posBrandFilter: '',
      posCatalog: [
        { brand: 'Apple', model_name: 'iPhone 11', part_type: 'LCD', stock_quantity: 4 },
        { brand: 'ZeroBrand', model_name: 'Model X', part_type: 'Battery', stock_quantity: 0 }
      ]
    },
    TEMPLATE_BRANDS: { phone: ['Apple', 'Samsung'] },
    itemMatchesProfile: () => true,
    escHtml: s => String(s),
    document: { getElementById: id => (id === 'pos-brand-chips' ? box : null) }
  });
  vm.runInContext(code, ctx);
  ctx.renderBrandChips();

  assert.ok(box.innerHTML.includes('Apple'), 'in-stock brand should render');
  assert.ok(!box.innerHTML.includes('ZeroBrand'), '0-stock brand must stay hidden while In stock only is checked');
});

test('openImportPreview displays Min Stock Alert and swaps Brand/Model when clicked', async () => {
  const inv = source('public/js/views/inventory.js');
  const { matchHeaders } = await import('../public/js/importer.js');

  const fnStart = inv.indexOf('let importState = null;');
  const fnEnd = inv.indexOf('\nexport function openImportPreview(');
  const code = inv.slice(fnStart, fnEnd)
    .replace('function ensureImportPreviewModal()', 'function ensureImportPreviewModal_unused()')
    .replace(/^export /gm, '');

  const makeEl = () => {
    const classes = new Set();
    let clickFn = null;
    return {
      innerHTML: '',
      textContent: '',
      classList: { add: c => classes.add(c), remove: c => classes.delete(c), has: c => classes.has(c) },
      querySelector: sel => (sel === '#import-swap-btn' ? { addEventListener: (_ev, fn) => { clickFn = fn; } } : null),
      triggerSwap: () => clickFn && clickFn()
    };
  };
  const els = {
    'import-swap-warning': makeEl(),
    'import-preview-note': makeEl(),
    'import-preview-table': makeEl()
  };
  const rows = [
    ['Brand', 'Model Name', 'Part Type', 'Stock Qty', 'Min Stock Alert'],
    ...Array.from({ length: 22 }, (_, i) => [`Part ${i}`, 'Apple', 'LCD', '5', ''])
  ];
  const ctx = vm.createContext({
    S: { shopSettings: { default_retail_markup_pct: 50, default_wholesale_markup_pct: 20 } },
    t: (_k, fb) => fb,
    escHtml: s => String(s),
    matchHeaders,
    rows,
    document: { getElementById: id => els[id] || null }
  });
  const state = vm.runInContext(`${code}\nimportState = { rows, header: rows[0], auto: matchHeaders(rows[0]), op_id: 'op1' }; renderImportPreviewTable(); importState;`, ctx);

  assert.equal(els['import-swap-warning'].classList.has('hidden'), false, 'swap warning must show when Brands >> Models');
  assert.ok(els['import-preview-table'].innerHTML.includes('Min Stock Alert'), 'preview must show Min Stock Alert header');
  assert.ok(els['import-preview-table'].innerHTML.includes('3 <span class="tag tag--quiet text-xs">default</span>'), 'blank alert previews default 3');
  assert.equal(state.auto.brand, 0);

  els['import-swap-warning'].triggerSwap();
  assert.equal(state.auto.brand, 1, 'swap button flips Brand and Model column mapping');
  assert.equal(state.auto.model_name, 0);
  assert.equal(els['import-swap-warning'].classList.has('hidden'), true, 'swap warning clears after swap');
});

test('inventory table renders an explicit Min Stock Alert column', () => {
  const html = source('public/index.html');
  const inv = source('public/js/views/inventory.js');
  assert.match(html, /data-i18n="inv\.th_min_alert"[^>]*>Min Stock Alert<\/th>/);
  assert.match(inv, /showSkeleton\('inventory-tbody', 10\)/);
  assert.match(inv, /<td class="is-mid font-mono" style="color: var\(--txt-2\);">\$\{item\.min_stock_alert \?\? 0\}<\/td>/);
});
