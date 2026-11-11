const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const backoffice = fs.readFileSync(path.join(ROOT, 'public/js/views/backoffice.js'), 'utf8');
const analytics = fs.readFileSync(path.join(ROOT, 'src/analytics.js'), 'utf8');
const index = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const styles = fs.readFileSync(path.join(ROOT, 'public/styles.css'), 'utf8');

test('date input anchors every period and never shows a stale anchor', () => {
  // The gate is gone server-side: refDate anchors 3d/7d/30d/365d too.
  assert.doesNotMatch(analytics, /period === 'day' && \//);
  for (const fn of ['function periodWindows', 'function getProductPerformance', 'function getDeadStock', 'function getReorderList']) {
    const start = analytics.indexOf(fn);
    const body = analytics.slice(start, start + 400);
    assert.match(body, /reportEndDate\(db, refDate\)/, `${fn} honors the anchor`);
  }
  // The date box stays visible for all periods and resets to today when the
  // state has no anchor — a stale picked date must not disagree with the ask.
  assert.match(backoffice, /\$id\('dash-date-wrap'\)\.classList\.remove\('hidden'\);/);
  const sync = backoffice.slice(backoffice.indexOf('function syncPeriodUi'), backoffice.indexOf('function wireDashboardControls'));
  assert.match(sync, /if \(!dashState\.date\) \{[\s\S]*?dateInput\.value = new Date\(\)\.toLocaleDateString\('sv-SE'\);/);
  assert.match(index, /aria-label="Report window ending date"/);
});

test('trend chart toggles revenue / gross profit with honest caption', () => {
  assert.match(index, /id="dash-trend-mode" role="group" aria-label="Chart series"/);
  assert.match(index, /data-mode="revenue"/);
  assert.match(index, /data-mode="profit"/);
  assert.match(backoffice, /trendMode: 'revenue'/);
  const trend = backoffice.slice(backoffice.indexOf('function renderTrend(s) {'), backoffice.indexOf('function renderTopProducts'));
  assert.match(trend, /dashState\.trendMode === 'profit'/);
  assert.match(trend, /value: profit \? t\.profit : t\.revenue/);
  assert.match(trend, /deductions land on the return date/);
  assert.match(backoffice, /dash-trend-mode'\)\.addEventListener\('click'/);
});

test('collections mix shows its share of collected money', () => {
  const pmix = backoffice.slice(backoffice.indexOf('const mSum = mix.reduce'), backoffice.indexOf("renderTrend(s);\n") > 0 ? backoffice.indexOf('dash-pmix') + 400 : undefined);
  assert.ok(pmix.length > 0, 'pmix block found');
  const block = backoffice.slice(backoffice.indexOf('const mSum = mix.reduce'), backoffice.indexOf('.join(\'\');', backoffice.indexOf('const mSum = mix.reduce')));
  assert.match(block, /sharesValid \? ` · \$\{Math\.round\(\(m\.v \/ mSum\) \* 100\)\}%` : ''/);
});

test('KPI meta splits every return type; count and money agree', () => {
  assert.match(backoffice, /c\.return_cash > 0 \? `\$\{fmtMoney\(c\.return_cash\)\} \$\{t\('dash\.cash_refunded'/);
  assert.match(backoffice, /c\.return_credit > 0 \? `\$\{fmtMoney\(c\.return_credit\)\} \$\{t\('dash\.off_utang'/);
  assert.match(backoffice, /return_replacements > 0 \? swapWord\(c\.return_replacements\)/);
  assert.match(backoffice, /: t\('dash\.no_returns'/);
});

test('exceptions itemize every return type over any window', () => {
  assert.doesNotMatch(analytics, /Math\.min\(30, Number\(days\)/);
  assert.doesNotMatch(backoffice, /Math\.min\(30, Number\(days\)/);
  assert.match(analytics, /SELECT \* FROM warranty_returns WHERE \$\{W.sql\}/);
  assert.match(backoffice, /typeLabel = \{ cash_refund: 'cash', credit_refund: 'utang', replacement: 'swap' \}/);
  assert.match(backoffice, /Returns \(\$\{ex\.returns\?\.length \|\| 0\}\)/);
  assert.doesNotMatch(backoffice, /cashRefunds/);
});
