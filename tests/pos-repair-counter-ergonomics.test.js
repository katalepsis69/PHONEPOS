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
  assert.match(posJs, /labelSpan\.textContent = isReady \? 'Take payment & print \(F9\)' : 'Add items to checkout \(F9\)';/);

  // pos.js shows count when reset filters is needed
  assert.match(posJs, /Show all \$\{catalog\.length\} parts/);
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

  // No em dashes in auditDayLabel or empty details
  assert.doesNotMatch(authJs, /return `\${label} —/);
  assert.match(authJs, /return `\${label} · \${d\.toLocaleDateString/);

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
