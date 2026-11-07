// phone-repair-pos/public/js/chart.js
// Zero-dependency SVG bar chart for the Reports & profit tab. One series of
// {label, value, sub}. Each bucket is a full-column, keyboard-focusable hit
// target: hovering or focusing it reveals the value, and a native <title>
// gives the same detail to pointer users. No pointer math, no listeners, no library.
//
// Hit-target floor: buckets never render thinner than MIN_BUCKET px. When a
// long series would squeeze below that, the wrapper scrolls horizontally
// instead of shrinking the bars into slivers. The same numbers ship as a
// visually-hidden data table, so screen readers get exact figures (the svg's
// summary aria-label alone can't carry a series).
const MIN_BUCKET = 44;  // px — comfortable hover/keyboard target
const VALUE_LABEL_MIN = 56; // px — below this, values only via title/table

export function renderTrendChart(container, series, { fmt = v => String(v), title = 'Revenue trend' } = {}) {
  if (!container) return;
  if (!series.length) {
    container.innerHTML = `
      <div class="empty">
        <div class="empty__icon"><i class="ph ph-chart-line-up w-5 h-5"></i></div>
        <div class="empty__title">No sales in this window</div>
        <p class="empty__body">The trend fills in as sales land.</p>
      </div>`;
    return;
  }
  const cell = v => String(v).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const W = Math.max(760, series.length * MIN_BUCKET), H = 210, PT = 8, PB = 20;
  const inner = H - PT - PB;
  const max = Math.max(...series.map(d => d.value), 0);
  const min = Math.min(...series.map(d => d.value), 0);
  const yFor = value => PT + inner * ((max - value) / (max - min || 1));
  const zeroY = yFor(0);
  const step = W / series.length;
  const bw = Math.max(2, Math.min(38, step * 0.66));
  const showValues = step >= VALUE_LABEL_MIN;

  // One bucket per data point: a full-height transparent hit rect (no dead
  // zones above/below the bar), the bar itself, and — when there's room — a
  // value label the CSS reveals on :hover / :focus-visible.
  const buckets = series.map((d, i) => {
    const h = Math.abs(yFor(d.value) - zeroY);
    const x = i * step + (step - bw) / 2;
    const y = Math.min(zeroY, yFor(d.value));
    const label = cell(`${d.label}: ${fmt(d.value)}${d.sub ? ` (${d.sub})` : ''}`);
    return `<g class="chart__bucket" tabindex="0" role="img" aria-label="${label}">
      <rect class="chart__hit" x="${(i * step).toFixed(1)}" y="0" width="${step.toFixed(1)}" height="${H}"><title>${label}</title></rect>
      <rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="2.5" class="chart__bar"${d.value < 0 ? ' style="fill:var(--danger)"' : ''}></rect>
      ${showValues ? `<text class="chart__value" x="${(i * step + step / 2).toFixed(1)}" y="${Math.max(10, y - 4).toFixed(1)}" text-anchor="middle">${cell(fmt(d.value))}</text>` : ''}
    </g>`;
  }).join('');

  const grid = [...new Set([min, 0, max])].map(value =>
    `<line x1="0" x2="${W}" y1="${yFor(value).toFixed(1)}" y2="${yFor(value).toFixed(1)}" class="chart__grid"${value === 0 ? ' style="stroke:var(--txt-3)"' : ''}></line><text x="2" y="${Math.max(12, yFor(value) - 4).toFixed(1)}" class="chart__label">${cell(fmt(value))}</text>`
  ).join('');

  // Sparse x labels: about six, always including the last bucket. When the
  // forced last label would crowd the previous one (one step apart), the
  // earlier label is dropped instead of colliding.
  const every = Math.max(1, Math.ceil(series.length / 6));
  const last = series.length - 1;
  const labeled = new Set(series.map((_, i) => (i % every === 0 ? i : -1)).filter(i => i >= 0));
  labeled.add(last);
  if (last > 0 && (last - 1) % every === 0) labeled.delete(last - 1);
  const labels = series.map((d, i) =>
    labeled.has(i)
      ? `<text x="${(i * step + step / 2).toFixed(1)}" y="${H - 6}" text-anchor="middle" class="chart__label">${cell(d.label)}</text>`
      : ''
  ).join('');

  // Accessible alternative: the same numbers as a real table. Visually hidden
  // (the chart is the picture), announced in full by screen readers.
  const hasSub = series.some(d => d.sub);
  const table = `<table class="visually-hidden">
    <caption>${cell(title)} by bucket</caption>
    <thead><tr><th scope="col">Bucket</th><th scope="col">Value</th>${hasSub ? '<th scope="col">Detail</th>' : ''}</tr></thead>
    <tbody>${series.map(d =>
      `<tr><th scope="row">${cell(d.label)}</th><td>${cell(fmt(d.value))}</td>${hasSub ? `<td>${cell(d.sub || '')}</td>` : ''}</tr>`
    ).join('')}</tbody>
  </table>`;

  const total = series.reduce((a, d) => a + (d.value || 0), 0);
  container.innerHTML = `<div class="chart-scroll" style="--chart-min:${(series.length * MIN_BUCKET)}px"><svg class="chart" viewBox="0 0 ${W} ${H}" role="group" aria-label="${cell(title)}, ${series.length} buckets, total ${cell(fmt(total))}">${grid}${buckets}${labels}</svg></div>${table}`;
}

