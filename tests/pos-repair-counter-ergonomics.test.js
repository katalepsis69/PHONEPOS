const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const styles = fs.readFileSync(path.join(ROOT, 'public/styles.css'), 'utf8');
const indexHtml = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const posJs = fs.readFileSync(path.join(ROOT, 'public/js/views/pos.js'), 'utf8');
const invJs = fs.readFileSync(path.join(ROOT, 'public/js/views/inventory.js'), 'utf8');
const backofficeJs = fs.readFileSync(path.join(ROOT, 'public/js/views/backoffice.js'), 'utf8');

test('system-wide ergonomics: visual comfort tokens, panel & stat elevation', () => {
  // Soft bone canvas and slate ink tokens
  assert.match(styles, /--app-bg:\s*#F0EFEA;/);
  assert.match(styles, /--surface:\s*#FFFFFF;/);
  assert.match(styles, /--line:\s*#E2E0D9;/);
  assert.match(styles, /--txt:\s*#1A1D20;/);
  assert.match(styles, /--txt-3:\s*#525860;/);

  // Panel & stat card elevation
  assert.match(styles, /\.panel\s*\{[\s\S]*?box-shadow:\s*var\(--shadow-sm\);/);
  assert.match(styles, /\.stat\s*\{[\s\S]*?box-shadow:\s*var\(--shadow-sm\);/);

  // Data table row hover feedback
  assert.match(styles, /\.ptable tbody tr:hover\s*\{[\s\S]*?background-color:\s*var\(--surface-2\);/);
});

test('repair counter: tactile in-stock filter pill and stock badges', () => {
  // In-stock pill markup and styling
  assert.match(indexHtml, /<label class="check check--pill">\s*<input type="checkbox" id="pos-instock-only"/);
  assert.match(styles, /\.check--pill\s*\{/);
  assert.match(styles, /\.check--pill:has\(input:checked\)\s*\{/);

  // Stock badges with rounded pills
  assert.match(styles, /\.stock\s*\{[\s\S]*?border-radius:\s*9999px;/);
  assert.match(styles, /\.stock--low\s*\{[\s\S]*?background:\s*var\(--warn-bg\);/);
  assert.match(styles, /\.stock--out\s*\{[\s\S]*?background:\s*var\(--danger-bg\);/);
});

test('repair counter: unit icon badge and checkout CTA calm idle state', () => {
  // Handset slot icon badge
  assert.match(indexHtml, /<span class="unit__icon-badge">\s*<i class="ph ph-device-mobile/);
  assert.match(styles, /\.unit__icon-badge\s*\{/);

  // Checkout button idle vs ready
  assert.match(styles, /\.btn-primary--pos\s*\{[\s\S]*?background:\s*var\(--surface-2\);/);
  assert.match(styles, /\.btn-primary--pos\.is-ready\s*\{[\s\S]*?background:\s*var\(--pos\);/);

  // Checkout button text in index.html is honest about empty cart
  assert.match(indexHtml, /data-action="complete-sale"[\s\S]*?Add items to checkout \(F9\)/);

  // pos.js updates button text dynamically
  assert.match(posJs, /labelSpan\.textContent = isReady \? t\('pos\.checkout_ready', 'Take payment & print \(F9\)'\) : t\('pos\.checkout_idle', 'Add items to checkout \(F9\)'\);/);

  // pos.js shows count when reset filters is needed
  assert.match(posJs, /pos.reset_show_all/, 'the reset chip copy is translated');
  assert.match(posJs, /\'Show all \{n\} items'/);
});

test('inventory view: retail price typography and toolbar filter pills', () => {
  // Inventory toolbar uses check--pill
  assert.match(indexHtml, /<label class="check check--pill">\s*<input type="checkbox" id="inv-low-stock-check"/);
  assert.match(indexHtml, /<label class="check check--pill">\s*<input type="checkbox" id="inv-archived-check"/);

  // Retail price does NOT wear a stock badge
  assert.doesNotMatch(invJs, /item\.price_retail[\s\S]*?class="stock"/);
  assert.match(invJs, /<td class="is-num money font-mono">\$\{fmtMoney\(Number\(item\.price_retail\)\)\}<\/td>/);
});

test('backoffice views: honest typography across sales, returns, and customers', () => {
  // Customers table has structured layout and status tag pill
  assert.match(backofficeJs, /c\.total_credit_balance > 0\.001\s*\?\s*`<span class="tag tag--danger/);
  assert.match(backofficeJs, /<span class="tag tag--pos font-mono text-xs">Paid<\/span>/);

  // Warranty returns uses tag for defect reason rather than uncontained cell background
  assert.doesNotMatch(backofficeJs, /<td class="font-mono stock--low capitalize">/);
  assert.match(backofficeJs, /<td class="font-mono capitalize"><span class="tag tag--warn">/);

  // Sales history total amount does NOT wear a stock badge
  assert.doesNotMatch(backofficeJs, /s\.total_amount[\s\S]*?class="stock"/);
  assert.match(backofficeJs, /<span class="font-bold text-\[var\(--txt\)\]">\$\{fmtMoney\(Number\(s\.total_amount\)\)\}<\/span>/);
});

test('anti-slop copy hygiene (no em dashes in dashboard QA)', () => {
  assert.doesNotMatch(indexHtml, /Back to the counter — F1/);
  assert.match(indexHtml, /Back to the counter - F1/);
});

test('audit log ergonomics: copy hygiene, hover isolation, and empty component', () => {
  const authJs = fs.readFileSync(path.join(ROOT, 'public/js/auth.js'), 'utf8');

  // No em dashes in the day label; Today/Yesterday keep the date, weekday
  // days say it once (no more "Thursday, Nov 5, 2026 · Nov 5, 2026")
  assert.doesNotMatch(authJs, /return `\$\{label} —/);
  assert.match(authJs, /return `Today · \$\{d\.toLocaleDateString/);
  assert.match(authJs, /weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' \}\);/);

  // Initial audit counter placeholder in HTML has no em dash
  assert.doesNotMatch(indexHtml, /id="audit-count">—/);
  assert.match(indexHtml, /id="audit-count">-<\/span>/);

  // The sentence feed ships its own day-header and loading styles
  assert.match(styles, /\.audit-day__label\s*\{/);
  assert.match(styles, /\.audit-loading\s*\{/);

  // Uses app-standard .empty component on 0 filter matches
  assert.match(authJs, /<div class="empty">[\s\S]*?ph-shield-check[\s\S]*?No audit entries found/);
});

test('phone repair counter: complete keyboard shortcuts and customer rehousing', () => {
  const mainJs = fs.readFileSync(path.join(ROOT, 'public/js/main.js'), 'utf8');

  // Customer input is rehoused in summary scroll, top intake bar is removed
  assert.doesNotMatch(indexHtml, /id="repair-intake-bar"/);
  assert.match(indexHtml, /id="pos-customer-wrap"[\s\S]*?id="pos-customer-name"/);

  // Table row highlight styling exists
  assert.match(styles, /\.ptable tbody tr\.is-highlighted\s*\{[\s\S]*?outline:/);

  // Alt shortcuts in main.js
  assert.match(mainJs, /e\.altKey && !e\.ctrlKey && !e\.metaKey/);
  assert.match(mainJs, /lowerKey === 'c'[\s\S]*?pos-customer-name/);
  assert.match(mainJs, /lowerKey === 'n'[\s\S]*?toggleRepairNote\(\)/);
  assert.match(mainJs, /lowerKey === 't'[\s\S]*?setPriceTier/);
  assert.match(mainJs, /e\.key === '1'[\s\S]*?setPaymentMethod\('cash'\)/);
  assert.match(mainJs, /e\.key === '2'[\s\S]*?setPaymentMethod\('gcash'\)/);
  assert.match(mainJs, /e\.key === '3'[\s\S]*?setPaymentMethod\('credit'\)/);
  assert.match(mainJs, /e\.key === '4'[\s\S]*?setPaymentMethod\('transfer'\)/);
  assert.match(mainJs, /lowerKey === 'e'[\s\S]*?fillExactAmount\(\)/);
  assert.match(mainJs, /lowerKey === 'x'[\s\S]*?clearRepairOrder\(\)/);
  assert.match(mainJs, /lowerKey === 'h'[\s\S]*?saveRepairDraft\(\)/);
  assert.match(mainJs, /lowerKey === 'r'[\s\S]*?resumeRepairDraft\(\)/);
  assert.match(mainJs, /lowerKey === 'a'[\s\S]*?openAddPartModal\(\)/);
});

test('customers & utang view: 5-column industrial layout, dynamic card state, and ledger triggers', () => {
  // Table header has 5 semantic columns, no fake single th
  assert.doesNotMatch(indexHtml, /<th class="flex items-center justify-between">/);
  assert.match(indexHtml, /<th>Customer Profile<\/th>[\s\S]*?<th class="is-num">Orders \/ Spent<\/th>[\s\S]*?<th class="is-num">Credit Limit<\/th>[\s\S]*?<th class="is-mid">Utang Balance \/ Status<\/th>[\s\S]*?<th class="is-mid">Action<\/th>/);

  // Skeleton aligns with 5 columns
  assert.match(backofficeJs, /showSkeleton\('customers-tbody', 5\)/);

  // Outstanding utang card toggles dynamically rather than stuck in stat--danger
  assert.match(backofficeJs, /outCard\.classList\.toggle\('stat--danger', totalOutstanding > 0\.001\)/);
  assert.match(backofficeJs, /outCard\.classList\.toggle\('stat--pos', totalOutstanding <= 0\.001\)/);

  // Button ledger trigger has expanded hit target
  assert.match(styles, /\.btn-ledger-trigger::after\s*\{/);
});

test('inventory view: honest metric copy, screen tech badges, and action hit areas', () => {
  // Metric card copy handles single unit and honest zero-stock meta
  assert.match(invJs, /units === 1 \? t\('inv\.stat_unit_single'/);
  assert.match(invJs, /units > 0 \? t\('inv\.stat_low_only', 'below alert level'\) : t\('inv\.stat_none', 'nothing on hand'\)/);

  // Screen tech rendered with uppercase badge
  assert.match(invJs, /<span class="tag tag--subtle font-mono uppercase text-xs">\$\{escHtml\(item\.part_type\)\}<\/span>/);

  // Action buttons have Phosphor icons and expanded hit areas
  assert.match(invJs, /class="btn-mini btn-inv-action"/);
  assert.match(invJs, /ph-sliders-horizontal/);
  assert.match(invJs, /ph-clock-counter-clockwise/);
  assert.match(styles, /\.btn-inv-action::after\s*\{/);
  assert.match(styles, /#view-inventory \.parts-tools \.field-search\s*\{[\s\S]*?max-width:\s*200px/);
  assert.match(styles, /body\[data-tab="inventory"\] \.topbar \.search/);
});

test('installer script: version expansion and clean task hierarchy', () => {
  const iss = fs.readFileSync(path.join(ROOT, 'installer/TechPartsPOS.iss'), 'utf8');
  assert.doesNotMatch(iss, /\[version\]/, 'installer script must not contain unexpanded [version] placeholders');
  assert.match(iss, /WelcomeLabel2=This will install TechParts POS and Repair System \{#MyAppVersion\}/);
  assert.match(iss, /LicenseLabel=TechParts POS and Repair System, version \{#MyAppVersion\}\./);
  assert.doesNotMatch(iss, /GroupDescription:\s*"{cm:AdditionalIcons}"/);
});

test('sales and returns ergonomics: no orphaned timestamp wrap, action hit areas, and hidden topbar search', () => {
  assert.match(backofficeJs, /<td class="font-mono whitespace-nowrap text-xs">\$\{formatDateTime\(s\.created_at\)\}<\/td>/);
  assert.match(backofficeJs, /<td class="font-mono whitespace-nowrap text-xs">\$\{formatDateTime\(r\.created_at\)\}<\/td>/);
  assert.match(styles, /\.sales-action-btn::after\s*\{/);
  assert.match(styles, /body\[data-tab="sales"\] \.topbar \.search/);
  assert.match(styles, /body\[data-tab="returns"\] \.topbar \.search/);
});

test('reports & profit ergonomics: currency sign placement, honest pluralization, expense form, and chart clarity', () => {
  const uiJs = fs.readFileSync(path.join(ROOT, 'public/js/ui.js'), 'utf8');

  // fmtMoney places negative sign before currency symbol
  assert.match(uiJs, /const sign = num < 0 \? '-' : '';\s*return sign \+ '₱' \+ Math\.abs\(num\)\.toLocaleString/);

  // Pluralization in backoffice
  assert.match(backofficeJs, /\$\{b\.count\} \$\{b\.count === 1 \? 'entry' : 'entries'\}/);
  assert.match(backofficeJs, /\$\{st\.total_parts_stock\} \$\{st\.total_parts_stock === 1 \? 'part' : 'parts'\} on shelf/);
  assert.match(backofficeJs, /\$\{p\.units\} \$\{p\.units === 1 \? 'unit' : 'units'\} ·/);

  // Expense form input class and width
  assert.match(indexHtml, /id="expense-amount"[^>]*class="dash-expense-input w-28"/);
  assert.match(styles, /\.dash-expense-input\s*\{/);

  // Dashboard topbar search hidden
  assert.match(styles, /body\[data-tab="dashboard"\] \.topbar \.search/);

  // Chart values visible by default on readable series
  assert.match(styles, /\.chart__value\s*\{[\s\S]*?opacity:\s*0\.92/);
});




