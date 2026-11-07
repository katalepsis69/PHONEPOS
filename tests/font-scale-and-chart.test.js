const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const styles = fs.readFileSync(path.join(ROOT, 'public/styles.css'), 'utf8');
const chartSrc = fs.readFileSync(path.join(ROOT, 'public/js/chart.js'), 'utf8');

// ---------------------------------------------------------------- font scale
// Mirrors the codemod's block tracking: @media print is the only legal home
// of fixed px text (thermal paper must not scale with the user setting).
function pxFontSizesOutsidePrint(css) {
  const offenders = [];
  let depth = 0;
  let inPrint = false;
  let printDepth = null;
  for (const [i, line] of css.split('\n').entries()) {
    if (line.includes('@media print') && !inPrint) {
      inPrint = true;
      printDepth = depth;
    }
    if (!inPrint && /font-size:\s*\d+(?:\.\d+)?px/.test(line)) {
      offenders.push({ line: i + 1, text: line.trim() });
    }
    depth += (line.match(/{/g) || []).length - (line.match(/}/g) || []).length;
    if (inPrint && depth <= printDepth) {
      inPrint = false;
      printDepth = null;
    }
  }
  return offenders;
}

test('text-size setting scales ALL ui text: no fixed px font sizes outside print', () => {
  const offenders = pxFontSizesOutsidePrint(styles);
  assert.deepEqual(offenders, [], `px font sizes outside print blocks: ${JSON.stringify(offenders.slice(0, 5))}`);
  // The mechanism: root font-size follows the published --font-scale var.
  assert.match(styles, /html \{\s*font-size: calc\(16px \* var\(--font-scale, 1\)\);/);
  // Body copy itself (was 14px, previously immune to the setting).
  assert.match(styles, /body \{[\s\S]*?font-size: 0\.875rem;/);
  // Print keeps physical sizing for paper. mm rather than px because the
  // receipt is pinned to the printer's dot grid (2.5mm = a 12-dot cell).
  assert.match(styles, /@media print \{[\s\S]*?font-size: \d+(?:\.\d+)?(?:px|mm)/);
});

// ---------------------------------------------------------------- chart
test('trend chart keeps a minimum hit target, honest labels, and a data table', async () => {
  const { renderTrendChart } = await import('../public/js/chart.js');

  // Dense series (30 buckets): wrapper must demand 30*44px, values move to
  // the table (no room for readable value labels at 44px buckets).
  const denseHost = { clientWidth: 700, innerHTML: '' };
  const series30 = Array.from({ length: 30 }, (_, i) => ({ label: `d${i}`, value: i }));
  renderTrendChart(denseHost, series30, { fmt: v => `${v}` });
  assert.match(denseHost.innerHTML, /--chart-min:1320px/);
  assert.match(denseHost.innerHTML, /viewBox="0 0 1320 210"/);
  assert.doesNotMatch(denseHost.innerHTML, /chart__value/);
  assert.equal((denseHost.innerHTML.match(/<th scope="row">/g) || []).length, 30);
  assert.match(denseHost.innerHTML, /<caption>Revenue trend by bucket<\/caption>/);

  // Sparse series still gets hover/focus value labels and no scroll demand.
  const sparseHost = { clientWidth: 900, innerHTML: '' };
  renderTrendChart(sparseHost, Array.from({ length: 7 }, (_, i) => ({ label: `d${i}`, value: i })), { fmt: v => `${v}` });
  assert.match(sparseHost.innerHTML, /viewBox="0 0 760 210"/);
  assert.match(sparseHost.innerHTML, /chart__value/);

  // Forced last label never collides with its left neighbor: with n=22 the
  // regular stride would label bucket 20 right next to forced bucket 21 —
  // 20 must be dropped.
  const adjHost = { clientWidth: 900, innerHTML: '' };
  renderTrendChart(adjHost, Array.from({ length: 22 }, (_, i) => ({ label: `d${i}`, value: i })), { fmt: v => `${v}` });
  // step = 968/22 = 44 → bucket-20 label center x = 20*44+22 = 902.
  assert.doesNotMatch(adjHost.innerHTML, /x="902\.0"[^>]*class="chart__label"/);
  assert.match(adjHost.innerHTML, /x="946\.0"[^>]*class="chart__label"/);

  // Table cells escape HTML-significant characters.
  const escHost = { clientWidth: 900, innerHTML: '' };
  renderTrendChart(escHost, [{ label: '<Sep> & "12"', value: 5, sub: '<b>' }], { fmt: v => `${v}` });
  assert.match(escHost.innerHTML, /&lt;Sep&gt; &amp; &quot;12&quot;/);
  assert.match(escHost.innerHTML, /&lt;b&gt;/);

  // Empty series and null container stay harmless.
  const emptyHost = { innerHTML: '' };
  renderTrendChart(emptyHost, [], {});
  assert.match(emptyHost.innerHTML, /No sales in this window/);
  assert.doesNotThrow(() => renderTrendChart(null, [{ label: 'x', value: 1 }]));
});
