// phone-repair-pos/public/js/chart.js
// Zero-dependency SVG bar chart for the Reports & profit tab. One series of
// {label, value, sub, detail}. Each bucket is a full-column, keyboard-focusable hit
// target: hovering or focusing it reveals the value, a native <title>
// gives the same detail to pointer users, and a compact summary strip shows
// total, peak, average, and split context above the bars.
//
// Hit-target floor: buckets never render thinner than MIN_BUCKET px. When a
// long series would squeeze below that, the wrapper scrolls horizontally
// instead of shrinking the bars into slivers. The same numbers ship as a
// visually-hidden data table, so screen readers get exact figures (the svg's
// summary aria-label alone can't carry a series).
const MIN_BUCKET = 44;  // px — comfortable hover/keyboard target
const VALUE_LABEL_MIN = 56; // px — below this, values only via title/table

function niceTicks(minVal, maxVal) {
  const lo = Math.min(0, minVal);
  const hi = Math.max(0, maxVal);
  const rawSpan = hi - lo || 100;
  const rawStep = rawSpan / 4;
  const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const norm = rawStep / mag;
  const niceMult = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
  const step = niceMult * mag;
  const niceMin = lo < 0 ? -Math.ceil(Math.abs(lo) / step) * step : 0;
  const niceMax = hi > 0 ? Math.ceil(hi / step) * step : 0;
  const ticks = [];
  const count = Math.min(8, Math.round((niceMax - niceMin) / step));
  for (let i = 0; i <= count; i++) {
    ticks.push(Math.round((niceMin + step * i) * 100) / 100);
  }
  if (!ticks.includes(0) && niceMin <= 0 && niceMax >= 0) ticks.push(0);
  ticks.sort((a, b) => a - b);
  return { niceMin, niceMax: Math.max(niceMax, step), ticks };
}

export function renderTrendChart(container, series, { fmt = v => String(v), title = 'Revenue trend', meta = null } = {}) {
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
  const uid = `cg-${Math.random().toString(36).slice(2, 7)}`;
  const W = Math.max(760, series.length * MIN_BUCKET), H = 210, PT = 14, PB = 22;
  const inner = H - PT - PB;
  const rawMax = Math.max(...series.map(d => d.value), 0);
  const rawMin = Math.min(...series.map(d => d.value), 0);
  const { niceMin, niceMax, ticks } = niceTicks(rawMin, rawMax);
  const min = niceMin;
  const span = (niceMax - niceMin) || 1;
  // Headroom above the top tick so peak labels never clip.
  const top = niceMax + span * 0.10;
  const yFor = value => PT + inner * ((top - value) / (top - min));
  const zeroY = yFor(0);
  const step = W / series.length;
  const maxBarWidth = series.length <= 3 ? 88 : series.length <= 7 ? 52 : 38;
  const bw = Math.max(2, Math.min(maxBarWidth, step * 0.66));
  const showValues = step >= VALUE_LABEL_MIN;

  const nonZero = series.filter(d => Number(d.value) !== 0);
  const activeCount = nonZero.length;
  const total = series.reduce((a, d) => a + (d.value || 0), 0);
  const totalCount = series.reduce((a, d) => a + (Number(d.count) || 0), 0);
  const activeAvg = activeCount > 0 ? total / activeCount : 0;
  const peak = nonZero.reduce((best, d) => (!best || d.value > best.value ? d : best), null);

  // One bucket per data point: a full-height transparent hit rect (no dead
  // zones above/below the bar), optional subtle slot track for coarse buckets,
  // the bar itself, and — when there's room — a value label. Zero-value
  // timeline anchors draw a faint baseline pill so empty time blocks stay legible.
  const showSlots = series.length <= 14;
  const buckets = series.map((d, i) => {
    const val = Number(d.value) || 0;
    const hRaw = Math.abs(yFor(val) - zeroY);
    const isZero = Math.abs(val) < 0.005;
    const isPeak = Boolean(peak && d === peak && val > 0);
    const isCurrent = Boolean(d.isCurrent);
    const h = isZero ? 3 : Math.max(3, hRaw);
    const x = i * step + (step - bw) / 2;
    const y = isZero ? (zeroY - 3) : Math.min(zeroY, yFor(val));
    const labelText = `${d.label}: ${fmt(val)}${d.sub ? ` (${d.sub})` : ''}`;
    const label = cell(labelText);
    const barFill = isZero
      ? ' style="fill:var(--line);opacity:0.55"'
      : (val < 0 ? ` style="fill:url(#${uid}-neg)"` : ` style="fill:url(#${uid}-pos)"`);
    const showTopVal = showValues && (!isZero || series.length <= 12);
    const valY = val < 0
      ? Math.min(H - PB - 4, y + h + 11)
      : Math.max(11, y - 5);
    const slotRect = showSlots
      ? `<rect class="chart__slot${isCurrent ? ' is-now' : ''}" x="${(i * step + 3).toFixed(1)}" y="${PT}" width="${Math.max(4, step - 6).toFixed(1)}" height="${Math.max(4, zeroY - PT).toFixed(1)}" rx="4"></rect>`
      : '';
    return `<g class="chart__bucket${isPeak ? ' is-peak' : ''}${isCurrent ? ' is-now' : ''}" tabindex="0" role="img" data-bucket-summary="${label}" aria-label="${label}">
      ${slotRect}
      <rect class="chart__hit" x="${(i * step).toFixed(1)}" y="0" width="${step.toFixed(1)}" height="${H}"><title>${label}</title></rect>
      <rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="3.5" class="chart__bar${isZero ? ' chart__bar--zero' : ''}"${barFill}></rect>
      ${showTopVal && !isZero ? `<text class="chart__value" x="${(i * step + step / 2).toFixed(1)}" y="${valY.toFixed(1)}" text-anchor="middle">${cell(fmt(val))}</text>` : ''}
    </g>`;
  }).join('');

  const grid = ticks.map(value => {
    const gy = yFor(value).toFixed(1);
    const isZeroLine = Math.abs(value) < 0.005;
    return `<line x1="0" x2="${W}" y1="${gy}" y2="${gy}" class="chart__grid${isZeroLine ? ' chart__grid--zero' : ''}"${isZeroLine ? ' style="stroke:var(--txt-3)"' : ' stroke-dasharray="3 3"'}></line>`;
  }).join('');

  const yAxisHtml = `<div class="chart-yaxis" aria-hidden="true">${ticks.map(value =>
    `<span class="chart-yaxis__tick" style="top:${(yFor(value) / H * 100).toFixed(2)}%">${cell(fmt(value))}</span>`
  ).join('')}</div>`;

  const hasAvgLine = activeCount >= 2 && activeAvg > niceMin && activeAvg < top;
  const avgLine = hasAvgLine
    ? `<line x1="0" x2="${W}" y1="${yFor(activeAvg).toFixed(1)}" y2="${yFor(activeAvg).toFixed(1)}" class="chart__avg-line"><title>Active avg: ${cell(fmt(activeAvg))}</title></line>`
    : '';

  // Label every bucket when compact (<= 12 slots with >= 52px width, e.g. all
  // 12 intraday AM/PM windows or 7 daily bars); otherwise thin cleanly.
  const labelAll = series.length <= 12 && step >= 52;
  const every = labelAll ? 1 : Math.max(1, Math.ceil(series.length / 6));
  const last = series.length - 1;
  const labeled = new Set(series.map((_, i) => (i % every === 0 ? i : -1)).filter(i => i >= 0));
  labeled.add(last);
  if (!labelAll && last > 0 && (last - 1) % every === 0) labeled.delete(last - 1);
  const labels = series.map((d, i) =>
    labeled.has(i)
      ? `<text x="${(i * step + step / 2).toFixed(1)}" y="${H - 6}" text-anchor="middle" class="chart__label${d.isCurrent ? ' is-now' : ''}">${cell(d.label)}</text>`
      : ''
  ).join('');

  const defs = `<defs>
    <linearGradient id="${uid}-pos" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="var(--pos)" stop-opacity="0.92"/>
      <stop offset="100%" stop-color="var(--pos)" stop-opacity="0.58"/>
    </linearGradient>
    <linearGradient id="${uid}-neg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="var(--danger)" stop-opacity="0.92"/>
      <stop offset="100%" stop-color="var(--danger)" stop-opacity="0.62"/>
    </linearGradient>
  </defs>`;

  const avgTitle = meta?.avgLabel || 'Active avg';
  const peakLabel = peak ? `${cell(peak.label)} (${cell(fmt(peak.value))})` : 'None';
  const activeSummary = `${activeCount}/${series.length}${totalCount > 0 ? ` · ${totalCount} ${totalCount === 1 ? 'sale' : 'sales'}` : ''}`;
  const flowsHtml = Array.isArray(meta?.flows) && meta.flows.length
    ? `<div class="chart-flows">${meta.flows.map(f => `<span class="chart-flow">${cell(f)}</span>`).join('')}</div>`
    : '';
  const summaryHtml = `
    <div class="chart-meta">
      <div class="chart-meta__pills">
        <span class="chart-stat"><span class="chart-stat__k">Total</span><strong class="chart-stat__v">${cell(fmt(total))}</strong></span>
        <span class="chart-stat"><span class="chart-stat__k">Peak</span><strong class="chart-stat__v">${peakLabel}</strong></span>
        <span class="chart-stat"><span class="chart-stat__k">${hasAvgLine ? '<span class="chart-stat__swatch" aria-hidden="true"></span>' : ''}${cell(avgTitle)}</span><strong class="chart-stat__v">${activeCount ? cell(fmt(activeAvg)) : cell(fmt(0))}</strong></span>
        <span class="chart-stat"><span class="chart-stat__k">Windows</span><strong class="chart-stat__v">${cell(activeSummary)}</strong></span>
        ${meta?.split ? `<span class="chart-stat"><span class="chart-stat__k">${cell(meta.splitLabel || 'Mix')}</span><strong class="chart-stat__v">${cell(meta.split)}</strong></span>` : ''}
      </div>
      <span class="chart-hover-readout" data-chart-readout>Hover or focus a bar for breakdown</span>
      ${flowsHtml}
    </div>`;

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

  container.innerHTML = `${summaryHtml}<div class="chart-frame">${yAxisHtml}<div class="chart-scroll" style="--chart-min:${(series.length * MIN_BUCKET)}px"><svg class="chart" viewBox="0 0 ${W} ${H}" role="group" aria-label="${cell(title)}, ${series.length} buckets, total ${cell(fmt(total))}">${defs}${grid}${avgLine}${buckets}${labels}</svg></div></div>${table}`;

  if (typeof container.addEventListener === 'function' && !container.dataset?.chartWired) {
    if (container.dataset) container.dataset.chartWired = '1';
    const setReadout = (target) => {
      const bucket = target?.closest?.('.chart__bucket');
      const readout = container.querySelector('[data-chart-readout]');
      if (!readout) return;
      readout.textContent = bucket ? (bucket.getAttribute('data-bucket-summary') || '') : 'Hover or focus a bar for breakdown';
    };
    container.addEventListener('mouseover', e => setReadout(e.target));
    container.addEventListener('focusin', e => setReadout(e.target));
    container.addEventListener('mouseleave', () => setReadout(null));
    container.addEventListener('focusout', e => {
      if (typeof container.contains === 'function' && !container.contains(e.relatedTarget)) setReadout(null);
    });
  }
}

