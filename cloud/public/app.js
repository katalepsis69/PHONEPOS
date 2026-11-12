let loggedIn = false;
let currentTab = 'sales';
let period = 'day';
let selectedShop = localStorage.getItem('techparts_selected_shop') || '';
let feedSearchQuery = '';
let feedChip = 'all';
let lastLoadedData = null;
let eventSource = null;
let currentPairingCode = '';
let pairingTimerInterval = null;
let reorderDays = 7;
let reorderCustomTimer = null;
const reorderOrderQtyOverrides = new Map();
let activeStockModalItem = null;
let pendingImportRows = [];

const fmtMoney = n => '₱' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function timeAgo(dateStr) {
  if (!dateStr) return '';
  const diffMs = Date.now() - new Date(dateStr).getTime();
  if (diffMs < 0 || isNaN(diffMs)) return 'just now';
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function showToast(msg) {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = msg;
  toast.style.display = 'block';
  setTimeout(() => { toast.style.display = 'none'; }, 2400);
}

async function api(path, opts = {}) {
  const res = await fetch(path, { credentials: 'same-origin', ...opts });
  if (res.status === 401 && path !== '/api/login' && path !== '/api/auth-state') {
    handleLoggedOut();
    throw new Error('login required');
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'request failed');
  }
  return res.json();
}

function handleLoggedOut() {
  if (eventSource) {
    try { eventSource.close(); } catch (_) {}
    eventSource = null;
  }
  loggedIn = false;
  document.getElementById('app')?.classList.add('hidden');
  checkAuthState();
}

async function checkAuthState() {
  try {
    const state = await api('/api/auth-state');
    const setupModal = document.getElementById('setup-modal');
    const loginModal = document.getElementById('login-modal');
    const appEl = document.getElementById('app');

    const savedStoreName = localStorage.getItem('techparts_store_name') || '';
    const loginStoreInput = document.getElementById('login-store-name');
    const setupStoreInput = document.getElementById('setup-store-name');
    if (loginStoreInput && !loginStoreInput.value && savedStoreName) {
      loginStoreInput.value = savedStoreName;
    }
    if (setupStoreInput && !setupStoreInput.value && savedStoreName) {
      setupStoreInput.value = savedStoreName;
    }

    if (!state.pin_set && !savedStoreName) {
      setupModal?.classList.add('open');
      loginModal?.classList.remove('open');
      appEl?.classList.add('hidden');
      return;
    }

    setupModal?.classList.remove('open');
    if (!state.logged_in) {
      loginModal?.classList.add('open');
      appEl?.classList.add('hidden');
      return;
    }

    loginModal?.classList.remove('open');
    appEl?.classList.remove('hidden');
    loggedIn = true;

    const storeBadge = document.getElementById('store-badge');
    if (storeBadge) {
      if (state.store_name) {
        storeBadge.textContent = state.store_name;
        storeBadge.style.display = 'inline-block';
      } else {
        storeBadge.style.display = 'none';
      }
    }

    await refresh();
    connectSSE();
  } catch (err) {
    document.getElementById('login-modal')?.classList.add('open');
  }
}

async function submitSetupPin() {
  const storeName = document.getElementById('setup-store-name')?.value.trim();
  const pin = document.getElementById('setup-pin-input')?.value.trim();
  const confirm = document.getElementById('setup-pin-confirm')?.value.trim();
  const err = document.getElementById('setup-err');
  if (err) err.textContent = '';

  if (!storeName || storeName.length < 2 || storeName.length > 50) {
    if (err) err.textContent = 'Store name must be between 2 and 50 characters';
    return;
  }
  if (!pin || pin.length < 4 || pin.length > 12) {
    if (err) err.textContent = 'PIN must be between 4 and 12 characters';
    return;
  }
  if (pin !== confirm) {
    if (err) err.textContent = 'PINs do not match';
    return;
  }

  try {
    await api('/api/create-store', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ store_name: storeName, pin })
    });
    localStorage.setItem('techparts_store_name', storeName);
    showToast(`Store '${storeName}' created`);
    document.getElementById('setup-modal')?.classList.remove('open');
    checkAuthState();
  } catch (e) {
    if (err) err.textContent = e.message || 'Failed to create store';
  }
}

let keypadPin = '';
function updateKeypadDots() {
  // Rotation mints 8-digit PINs and store PINs run 4-12 chars, so the readout
  // is a mask line rather than a fixed 4-dot row.
  const mask = document.getElementById('pin-mask');
  if (mask) mask.textContent = '•'.repeat(keypadPin.length) || ' ';
  for (let i = 0; i < 4; i++) {
    const dot = document.getElementById(`dot-${i}`);
    if (dot) dot.classList.toggle('filled', i < keypadPin.length);
  }
}

async function submitLoginPin(pinToSubmit) {
  const storeName = document.getElementById('login-store-name')?.value.trim();
  const err = document.getElementById('login-err');
  if (err) err.textContent = '';
  try {
    await api('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ store_name: storeName, pin: pinToSubmit })
    });
    if (storeName) localStorage.setItem('techparts_store_name', storeName);
    keypadPin = '';
    updateKeypadDots();
    document.getElementById('login-modal')?.classList.remove('open');
    checkAuthState();
  } catch (e) {
    if (err) err.textContent = e.message || 'Wrong PIN';
    keypadPin = '';
    updateKeypadDots();
  }
}

async function logout() {
  await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => {});
  handleLoggedOut();
}

async function openPairingModal() {
  const modal = document.getElementById('pair-modal');
  const codeEl = document.getElementById('pairing-code');
  const timerText = document.getElementById('timer-text');
  const unpaired = document.getElementById('pair-unpaired-state');
  const paired = document.getElementById('pair-paired-state');

  if (unpaired) unpaired.style.display = 'block';
  if (paired) paired.style.display = 'none';

  try {
    const res = await api('/api/pairing-code/generate', { method: 'POST' });
    currentPairingCode = res.code;
    const formatted = `${res.code.slice(0, 3)} ${res.code.slice(3)}`;
    if (codeEl) codeEl.textContent = formatted;

    let seconds = res.expires_in_seconds || 600;
    if (pairingTimerInterval) clearInterval(pairingTimerInterval);
    pairingTimerInterval = setInterval(() => {
      if (seconds <= 0) {
        clearInterval(pairingTimerInterval);
        if (timerText) timerText.textContent = 'Code expired: open again to refresh';
        return;
      }
      seconds--;
      const m = String(Math.floor(seconds / 60)).padStart(2, '0');
      const s = String(seconds % 60).padStart(2, '0');
      if (timerText) timerText.textContent = `Code expires in ${m}:${s}`;
    }, 1000);

    modal?.classList.add('open');
  } catch (err) {
    showToast(err.message || 'Could not generate code');
  }
}

function copyPairingCode() {
  if (!currentPairingCode) return;
  navigator.clipboard.writeText(currentPairingCode).then(() => {
    showToast(`Code ${currentPairingCode} copied`);
  }).catch(() => {
    showToast(`Code: ${currentPairingCode}`);
  });
}

// Timestamp of the last refresh that actually returned data, so a failed poll
// can say how stale the numbers on screen are.
let lastOkRefreshAt = null;
let lastOverviewState = null;
const STALE_MAX_MS = 300000;
const REGISTER_STALE_MS = 120000;
const POLL_MS = 20000;

function updateCloudSyncStateBadge({ inFlight = false, overview = lastOverviewState, fetchError = false } = {}) {
  const badge = document.getElementById('sync-state-badge');
  if (!badge) return;
  badge.classList.remove('warn', 'off', 'syncing');

  if (inFlight) {
    badge.classList.add('syncing');
    badge.textContent = 'Syncing...';
    badge.title = 'Refreshing store telemetry and sync queue';
    return;
  }

  if (fetchError) {
    const ageMs = lastOkRefreshAt ? (Date.now() - lastOkRefreshAt) : Infinity;
    const isStale = ageMs < STALE_MAX_MS;
    badge.classList.add(isStale ? 'warn' : 'off');
    badge.textContent = isStale ? 'Stale · Retrying' : 'Unsynced · Offline';
    badge.title = lastOkRefreshAt
      ? `Cloud connection interrupted; last update ${timeAgo(new Date(lastOkRefreshAt).toISOString())}`
      : 'Could not reach cloud server';
    return;
  }

  const shops = Array.isArray(overview?.shops) ? overview.shops : [];
  if (shops.length === 0) {
    badge.classList.add('off');
    badge.textContent = 'Not synced (unpaired)';
    badge.title = 'Pair a counter POS register to start syncing';
    return;
  }

  const scopedShops = selectedShop ? shops.filter(s => s.shop_id === selectedShop) : shops;
  const targetShops = scopedShops.length ? scopedShops : shops;
  const pendingCount = (overview?.pending_command_items || []).filter(
    c => !selectedShop || c.shop_id === selectedShop
  ).length;

  if (pendingCount > 0) {
    badge.classList.add('warn');
    badge.textContent = `Unsynced · ${pendingCount} queued`;
    badge.title = `${pendingCount} cloud stock change${pendingCount === 1 ? '' : 's'} waiting for counter POS heartbeat`;
    return;
  }

  const now = Date.now();
  let minAgeMs = Infinity;
  let freshestIso = '';
  for (const s of targetShops) {
    const t = Date.parse(s.last_seen);
    if (Number.isFinite(t)) {
      const age = Math.max(0, now - t);
      if (age < minAgeMs) {
        minAgeMs = age;
        freshestIso = s.last_seen;
      }
    }
  }

  if (minAgeMs >= STALE_MAX_MS) {
    badge.classList.add('off');
    badge.textContent = `Counter offline (${timeAgo(freshestIso)})`;
    badge.title = `Counter POS has not heartbeated since ${freshestIso}`;
  } else if (minAgeMs >= REGISTER_STALE_MS) {
    badge.classList.add('warn');
    badge.textContent = `Counter stale (${timeAgo(freshestIso)})`;
    badge.title = `Last counter heartbeat ${timeAgo(freshestIso)}`;
  } else {
    badge.textContent = 'Synced · Live';
    badge.title = freshestIso ? `Counter synced (${timeAgo(freshestIso)})` : 'Live sync active';
  }
}

function getPendingDeltaForItem(data, item) {
  const items = data?.pendingCommandItems || [];
  const shopId = item.shop_id || selectedShop || '';
  let delta = 0;
  let count = 0;
  for (const c of items) {
    if (c.kind === 'adjust_stock' && Number(c.inventory_id) === Number(item.id) && (!shopId || !c.shop_id || c.shop_id === shopId)) {
      delta += Number(c.delta) || 0;
      count++;
    }
  }
  return count > 0 ? { count, delta } : null;
}

function setCloudFreshness(ok) {
  const beacon = document.getElementById('conn-beacon');
  const staleBadge = document.getElementById('stale-badge');
  if (ok) {
    lastOkRefreshAt = Date.now();
    if (beacon) {
      beacon.classList.remove('warn', 'off');
      beacon.title = 'Live connection active';
    }
    if (staleBadge) {
      staleBadge.classList.remove('warn', 'off');
      staleBadge.classList.add('hidden');
    }
    updateCloudSyncStateBadge({ inFlight: false, overview: lastOverviewState, fetchError: false });
    return;
  }
  const ageMs = lastOkRefreshAt ? (Date.now() - lastOkRefreshAt) : Infinity;
  const isStale = ageMs < STALE_MAX_MS;
  if (beacon) {
    beacon.classList.toggle('warn', isStale);
    beacon.classList.toggle('off', !isStale);
    beacon.title = isStale ? 'Connection interrupted; showing recent data' : 'Offline';
  }
  if (staleBadge) {
    staleBadge.classList.toggle('warn', isStale);
    staleBadge.classList.toggle('off', !isStale);
    staleBadge.textContent = lastOkRefreshAt
      ? `Data: ${isStale ? 'stale' : 'offline'} (last update ${timeAgo(new Date(lastOkRefreshAt).toISOString())})`
      : 'Data: offline (no update yet)';
    staleBadge.classList.remove('hidden');
  }
  updateCloudSyncStateBadge({ inFlight: false, overview: lastOverviewState, fetchError: true });
}

function syncShopSelector(shops, rowCounts = {}) {
  const sel = document.getElementById('shop-filter');
  const list = Array.isArray(shops) ? shops : [];

  const pairedList = document.getElementById('paired-shops-list');
  const pairedCount = document.getElementById('paired-shops-count');
  if (pairedCount) pairedCount.textContent = `${list.length} paired`;
  if (pairedList) {
    if (list.length === 0) {
      pairedList.innerHTML = '<div style="font-size:11px;color:var(--text-dim);padding:8px 0;">No registers currently paired.</div>';
    } else {
      pairedList.innerHTML = list.map(s => {
        const name = s.shop_name && s.shop_name !== s.shop_id ? s.shop_name : (s.shop_id.length > 16 ? s.shop_id.slice(0, 12) + '...' : s.shop_id);
        const invCount = rowCounts[s.shop_id]?.find(r => r.table_name === 'inventory')?.n || 0;
        const salesCount = rowCounts[s.shop_id]?.find(r => r.table_name === 'sales')?.n || 0;
        const isSelected = s.shop_id === selectedShop;
        return `
          <div style="display:flex;align-items:center;justify-content:space-between;background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:8px 10px;gap:8px;">
            <div style="min-width:0;flex:1;">
              <div style="font-weight:600;font-size:12px;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                ${esc(name)} ${isSelected ? '<span style="font-size:10px;color:var(--accent);font-weight:700;">(Active)</span>' : ''}
              </div>
              <div style="font-family:var(--mono);font-size:10px;color:var(--text-dim);margin-top:2px;">
                ${invCount} parts · ${salesCount} sales · seen ${timeAgo(s.last_seen)}
              </div>
            </div>
            <button type="button" class="action-btn" data-unlink-shop="${esc(s.shop_id)}" title="Unlink and delete this register mirror" style="min-height:30px;min-width:60px;padding:2px 8px;font-size:11px;color:var(--alert);border-color:rgba(251,113,133,0.35);">
              Unlink
            </button>
          </div>
        `;
      }).join('');
    }
  }

  if (!sel) return;
  if (list.length === 0) {
    sel.classList.add('hidden');
    return;
  }
  sel.classList.remove('hidden');

  if (selectedShop && !list.some(s => s.shop_id === selectedShop)) {
    selectedShop = '';
    localStorage.removeItem('techparts_selected_shop');
  }

  const current = selectedShop;
  const optionsHtml = [
    `<option value="">All Registers (${list.length})</option>`,
    ...list.map(s => {
      const label = s.shop_name && s.shop_name !== s.shop_id
        ? `${s.shop_name} (${timeAgo(s.last_seen)})`
        : `${s.shop_id.length > 16 ? s.shop_id.slice(0, 10) + '...' : s.shop_id} (${timeAgo(s.last_seen)})`;
      return `<option value="${esc(s.shop_id)}"${s.shop_id === current ? ' selected' : ''}>${esc(label)}</option>`;
    })
  ].join('');
  if (sel.innerHTML !== optionsHtml) sel.innerHTML = optionsHtml;
}

function renderTrendAndMix(analytics) {
  const c = analytics?.current || {};
  const partsRev = Number(c.parts_revenue) || 0;
  const laborRev = Number(c.labor_revenue) || 0;
  const mixTotal = partsRev + laborRev;
  const partsPct = mixTotal > 0 ? Math.round((partsRev / mixTotal) * 100) : 50;
  const laborPct = mixTotal > 0 ? (100 - partsPct) : 50;

  const partsBar = document.getElementById('mix-bar-parts');
  const laborBar = document.getElementById('mix-bar-labor');
  if (partsBar) partsBar.style.width = `${partsPct}%`;
  if (laborBar) laborBar.style.width = `${laborPct}%`;

  const partsLbl = document.getElementById('mix-parts-label');
  const laborLbl = document.getElementById('mix-labor-label');
  if (partsLbl) {
    partsLbl.innerHTML = `<i class="mix-dot" style="background: var(--gcash);"></i>Parts ${fmtMoney(partsRev)} (${mixTotal > 0 ? partsPct : 0}%)`;
  }
  if (laborLbl) {
    laborLbl.innerHTML = `<i class="mix-dot" style="background: var(--cash);"></i>Repair Labor ${fmtMoney(laborRev)} (${mixTotal > 0 ? laborPct : 0}%)`;
  }

  const trend = Array.isArray(analytics?.trend) ? analytics.trend : [];
  const barsEl = document.getElementById('trend-bars');
  const peakEl = document.getElementById('trend-peak-label');
  if (!barsEl) return;

  const profitEl = document.getElementById('profit-bars');
  const profitLbl = document.getElementById('profit-window-label');
  if (profitEl) {
    if (!trend.length) {
      profitEl.innerHTML = '';
      if (profitLbl) profitLbl.textContent = '';
    } else {
      const vis = trend.slice(-14);
      const maxAbs = Math.max(...vis.map(t => Math.abs(Number(t.profit) || 0)), 1);
      const windowTotal = vis.reduce((sum, t) => sum + (Number(t.profit) || 0), 0);
      if (profitLbl) profitLbl.textContent = `Visible total ${fmtMoney(windowTotal)}`;
      profitEl.innerHTML = vis.map(t => {
        const p = Number(t.profit) || 0;
        const hPct = Math.max(6, Math.round((Math.abs(p) / maxAbs) * 100));
        return `
          <div class="trend-col" title="${esc(t.bucket)}: profit ${fmtMoney(p)}">
            <div class="trend-bar profit${p < 0 ? ' neg' : ''}" style="height: ${hPct}%;"></div>
            <span class="trend-lbl">${esc(String(t.bucket || '').slice(5))}</span>
          </div>
        `;
      }).join('');
    }
  }

  if (!trend.length) {
    if (peakEl) peakEl.textContent = 'No sales in window';
    barsEl.innerHTML = '<div style="width:100%;text-align:center;color:var(--text-dim);font-size:11px;padding-bottom:14px;">Daily revenue bars appear as sales sync</div>';
    return;
  }

  const maxRev = Math.max(...trend.map(t => Number(t.revenue) || 0), 1);
  let peakBucket = trend[0];
  for (const t of trend) {
    if ((Number(t.revenue) || 0) >= (Number(peakBucket.revenue) || 0)) peakBucket = t;
  }
  if (peakEl) {
    peakEl.textContent = `Peak ${peakBucket.bucket ? peakBucket.bucket.slice(5) : ''}: ${fmtMoney(peakBucket.revenue)}`;
  }

  const visible = trend.slice(-14);
  barsEl.innerHTML = visible.map(t => {
    const rev = Number(t.revenue) || 0;
    const hPct = Math.max(8, Math.round((rev / maxRev) * 100));
    const isPeak = t.bucket === peakBucket.bucket && rev > 0;
    const shortDate = String(t.bucket || '').slice(5);
    return `
      <div class="trend-col${isPeak ? ' peak' : ''}" title="${esc(t.bucket)}: ${fmtMoney(rev)} (${t.count || 0} sales)">
        <div class="trend-bar" style="height: ${hPct}%;"></div>
        <span class="trend-lbl">${esc(shortDate)}</span>
      </div>
    `;
  }).join('');
}

function renderPaymentSplit(c) {
  const cash = Number(c.cash_collected) || 0;
  const gcash = Number(c.gcash_collected) || 0;
  const transfer = Number(c.transfer_collected) || 0;
  const total = cash + gcash + transfer;
  const setSeg = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.style.width = total > 0 ? `${(val / total) * 100}%` : '0%';
  };
  setSeg('pay-bar-cash', cash);
  setSeg('pay-bar-gcash', gcash);
  setSeg('pay-bar-transfer', transfer);
  const legend = document.getElementById('pay-legend');
  if (legend) {
    const pct = v => total > 0 ? Math.round((v / total) * 100) : 0;
    legend.innerHTML = [
      ['var(--cash)', 'Cash', cash],
      ['var(--gcash)', 'GCash', gcash],
      ['var(--warn)', 'Transfer', transfer]
    ].map(([color, name, v]) => `<span><i class="mix-dot" style="background: ${color};"></i>${name} ${fmtMoney(v)} (${pct(v)}%)</span>`).join('');
  }
  const note = document.getElementById('pay-credit-note');
  if (note) note.textContent = `New utang issued ${fmtMoney(c.credit_issued)} · Utang paid ${fmtMoney(c.credit_settled)}`;
}

function agingBlockHtml(aging) {
  const rows = Array.isArray(aging) ? aging : [];
  const total = rows.reduce((sum, a) => sum + (Number(a.amount) || 0), 0);
  if (total <= 0.001) return '';
  const maxAmt = Math.max(...rows.map(a => Number(a.amount) || 0), 1);
  const colors = ['var(--accent)', 'var(--warn)', 'var(--alert)', 'var(--alert)'];
  return `
    <div class="aging-block" role="img" aria-label="Utang aging: outstanding balance by age of the unpaid sale">
      <div class="aging-title">Aging — how old the unpaid sales are</div>
      ${rows.map((a, i) => {
        const amt = Number(a.amount) || 0;
        const wPct = Math.round((amt / maxAmt) * 100);
        const count = Number(a.count) || 0;
        return `
          <div class="aging-row" title="${esc(a.label)}: ${fmtMoney(amt)} across ${count} unpaid sale${count === 1 ? '' : 's'}">
            <span class="aging-lbl">${esc(a.label)}</span>
            <div class="aging-track"><div class="aging-fill" style="width: ${wPct}%; background: ${colors[i] || 'var(--alert)'};"></div></div>
            <span class="aging-amt">${fmtMoney(amt)} · ${count}</span>
          </div>
        `;
      }).join('')}
    </div>
  `;
}

function updateAuditBanner({ sales, rets, reconciliations, adjustments }) {
  const summaryEl = document.getElementById('audit-banner-summary');
  if (!summaryEl) return;

  const voidedSales = (sales || []).filter(s => Boolean(s.voided));
  const latestRecon = (reconciliations || [])[0];
  const reconVar = latestRecon ? Number(latestRecon.variance) || 0 : 0;
  const rmaCount = (rets || []).length;
  const adjCount = (adjustments || []).length;

  const parts = [];
  if (latestRecon) {
    if (Math.abs(reconVar) >= 0.01) {
      parts.push(`Drawer ${reconVar < 0 ? 'short' : 'over'} ${fmtMoney(reconVar)}`);
    } else {
      parts.push(`Drawer balanced (${latestRecon.day})`);
    }
  }
  if (voidedSales.length) parts.push(`${voidedSales.length} voided (recent)`);
  if (adjCount) parts.push(`${adjCount} cash adj (recent)`);
  if (rmaCount) parts.push(`${rmaCount} RMA (recent)`);

  summaryEl.textContent = parts.length
    ? parts.join(' · ')
    : 'No drawer shortages, voids, or returns logged';
}

function setDeltaPill(el, delta) {
  if (!el) return;
  const v = Number(delta);
  // delta === null means "no previous window": Number(null) is 0, so the
  // null must be checked before the finite test or an empty baseline
  // renders as a fake "0% vs prev".
  if (delta === null || delta === undefined || !Number.isFinite(v)) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  el.textContent = `${v >= 0 ? '▲' : '▼'} ${Math.abs(v)}% vs prev`;
  el.classList.toggle('delta-up', v >= 0);
  el.classList.toggle('delta-down', v < 0);
}

async function refresh() {
  if (!loggedIn) return;
  updateCloudSyncStateBadge({ inFlight: true });
  const countEl = document.getElementById('feed-count');
  if (countEl && !lastLoadedData) countEl.textContent = 'Syncing...';
  try {
    const shopQuery = selectedShop ? `&shop=${encodeURIComponent(selectedShop)}` : '';
    const shopParam = selectedShop ? `?shop=${encodeURIComponent(selectedShop)}` : '';
    const standingPath = selectedShop ? `/api/standing?shop=${encodeURIComponent(selectedShop)}` : '/api/standing';
    let analyticsQuery = 'period=' + period + shopQuery;
    if (period === 'custom') {
      const f = document.getElementById('range-from')?.value;
      const t = document.getElementById('range-to')?.value;
      analyticsQuery = `period=custom&from=${encodeURIComponent(f || '')}` + (t ? `&to=${encodeURIComponent(t)}` : '') + shopQuery;
    }
    const [sales, utang, reorder, rets, reconciliations, adjustments, shifts, overview, analytics, standing, deadStock, reorderSheet, inventory] = await Promise.all([
      api('/api/rows?table=sales' + shopQuery),
      api('/api/rows?table=credit_payments' + shopQuery),
      api('/api/reorder?days=' + reorderDays + shopQuery),
      api('/api/rows?table=warranty_returns' + shopQuery),
      api('/api/rows?table=day_reconciliations' + shopQuery),
      api('/api/rows?table=cash_adjustments' + shopQuery),
      api('/api/rows?table=shifts' + shopQuery),
      api('/api/overview'),
      api('/api/analytics?' + analyticsQuery),
      api(standingPath),
      api('/api/dead-stock' + shopParam),
      api('/api/inventory/reorder?days=' + reorderDays + shopQuery).catch(() => ({ days: reorderDays, rows: [] })),
      api('/api/rows?table=inventory&limit=5000' + shopQuery).catch(() => []),
    ]);

    lastOverviewState = overview;
    const shopsBadge = document.getElementById('shops-badge');
    if (shopsBadge) {
      // Honest count: a paired-but-dead register is not online. The shop
      // heartbeats once a minute, so five minutes of silence is offline.
      const now = Date.now();
      const allShops = overview.shops || [];
      const online = allShops.filter(s => now - Date.parse(s.last_seen) < 5 * 60 * 1000).length;
      const n = online;
      shopsBadge.textContent = allShops.length === 0
        ? 'No register'
        : `${n} shop${n === 1 ? '' : 's'} online`;
      shopsBadge.classList.toggle('warn', allShops.length > 0 && n === 0);
      shopsBadge.classList.toggle('off', allShops.length === 0);
    }
    syncShopSelector(overview.shops, overview.rowCounts);

    const bk = overview.backup;
    const backupBadge = document.getElementById('backup-badge');
    if (backupBadge) {
      backupBadge.textContent = bk && bk.last_at
        ? `Backup: ${bk.age_hours}h ago`
        : 'Backup: none';
    }

    const c = analytics.current || {};
    const periodLabel = { day: 'Today', '7d': '7 Days', '30d': '30 Days', custom: 'Custom' }[period] || 'Today';
    document.getElementById('hero-label-title').textContent = `Takings (${periodLabel})`;
    document.getElementById('hero-revenue').textContent = fmtMoney(c.net_revenue ?? c.revenue);
    document.getElementById('hero-cash').textContent = fmtMoney(c.cash_collected);
    document.getElementById('hero-cash-sub').textContent = `${c.sale_count || 0} sales in period`;
    document.getElementById('hero-gcash').textContent = fmtMoney(c.gcash_collected);
    document.getElementById('hero-gcash-sub').textContent = `${fmtMoney(c.transfer_collected)} transfers`;

    const avgEl = document.getElementById('hero-avg-ticket');
    const colEl = document.getElementById('hero-collected-total');
    const setEl = document.getElementById('hero-utang-settled');
    if (avgEl) avgEl.textContent = `Avg ticket ${fmtMoney(c.avg_ticket)}`;
    if (colEl) colEl.textContent = `Collected ${fmtMoney(c.collected_total)}`;
    if (setEl) setEl.textContent = `Utang paid ${fmtMoney(c.credit_settled)}`;

    setDeltaPill(document.getElementById('hero-revenue-delta'), analytics.deltas?.revenue);
    setDeltaPill(document.getElementById('hero-profit-delta'), analytics.deltas?.net_profit);
    const unitsEl = document.getElementById('hero-units');
    if (unitsEl) unitsEl.textContent = `Delivered ${analytics.current.units_received || 0} units`;

    renderTrendAndMix(analytics);
    renderPaymentSplit(c);

    document.getElementById('card-utang').textContent = fmtMoney(standing.outstanding_credit);
    document.getElementById('card-utang-sub').textContent = `${standing.debtors || 0} open debtors`;

    // Server-computed over the whole mirror (/api/reorder + standing). The old
    // client-side filter ran on the newest-500 /api/rows window and dropped
    // older breaches once the catalog outgrew the window.
    const lowStockItems = (reorder || []).filter(i => i.below_min);
    const stockoutCount = lowStockItems.filter(i => Number(i.stock_quantity) <= 0).length;
    const restockBudget = lowStockItems.reduce((sum, i) => sum + (Number(i.restock_cost) || 0), 0);
    document.getElementById('card-stock').textContent = `${standing.low_stock_count} parts`;
    document.getElementById('card-stock-sub').textContent = lowStockItems.length
      ? `${stockoutCount} out · Restock ${fmtMoney(restockBudget)}`
      : 'Healthy inventory';

    const grossProfit = c.gross_profit || 0;
    const netProfit = c.net_profit ?? grossProfit;
    const revenue = c.revenue || 1;
    const marginPct = ((grossProfit / revenue) * 100).toFixed(1);
    document.getElementById('card-profit').textContent = fmtMoney(netProfit);
    document.getElementById('card-margin').textContent = `Gross ${fmtMoney(grossProfit)} · ${marginPct}% margin`
      + ((c.expenses_total || 0) > 0 ? ` · Exp ${fmtMoney(c.expenses_total)}` : '');

    const retailVal = Number(standing.inventory_retail_value) || 0;
    const costVal = Number(standing.inventory_cost_value) || 0;
    const markupVal = Math.max(0, retailVal - costVal);
    document.getElementById('card-inventory').textContent = fmtMoney(retailVal);
    const invSubEl = document.getElementById('card-inventory-sub');
    if (invSubEl) {
      invSubEl.textContent = costVal > 0
        ? `Cost ${fmtMoney(costVal)} · +${fmtMoney(markupVal)} markup`
        : 'Catalog value';
    }

    updateAuditBanner({ sales, rets, reconciliations, adjustments });
    setCloudFreshness(true);

    lastLoadedData = {
      analytics,
      sales,
      utang,
      reorder,
      reorderSheet: reorderSheet && Array.isArray(reorderSheet.rows) ? reorderSheet.rows : [],
      inventory: Array.isArray(inventory) ? inventory.filter(i => !i.archived) : [],
      pendingCommandItems: Array.isArray(overview.pending_command_items) ? overview.pending_command_items : [],
      rets,
      reconciliations,
      adjustments,
      shifts,
      deadStock,
      debtors: standing.debtor_list,
      aging: Array.isArray(standing.aging) ? standing.aging : []
    };
    renderTab(lastLoadedData);
  } catch (e) {
    // A swallowed failure left stale numbers on screen looking live. The badge
    // says when the data last actually arrived, like the backup badge does.
    console.error('Refresh error:', e);
    setCloudFreshness(false);
  }
}

const CHIP_CONFIG = {
  sales: [
    { id: 'all', label: 'All' },
    { id: 'cash', label: 'Cash' },
    { id: 'digital', label: 'GCash & Transfer' },
    { id: 'utang', label: 'Utang' },
    { id: 'voided', label: 'Voided' }
  ],
  utang: [
    { id: 'all', label: 'All Debtors' },
    { id: 'high', label: 'Over ₱1,000' },
    { id: 'payments', label: 'Recent Payments' }
  ],
  stock: [
    { id: 'all', label: 'All Alerts' },
    { id: 'out', label: 'Stockout (0)' },
    { id: 'low', label: 'Low Stock (1+)' },
    { id: 'fast', label: 'Fast Movers' },
    { id: 'catalog', label: 'All Catalog' }
  ],
  reorder: [
    { id: 'all', label: 'Sold in Window' },
    { id: 'below', label: 'Below Minimum' },
    { id: 'fast', label: 'Fast Movers' }
  ],
  reports: [
    { id: 'all', label: 'By Revenue' },
    { id: 'profit', label: 'By Profit' },
    { id: 'dead', label: 'Dead Stock' }
  ],
  audit: [
    { id: 'all', label: 'All Events' },
    { id: 'drawer', label: 'Drawer Counts' },
    { id: 'shifts', label: 'Shifts' },
    { id: 'voids', label: 'Voided Sales' },
    { id: 'cash_adj', label: 'Cash In/Out' },
    { id: 'rma', label: 'RMA Returns' }
  ]
};

function renderChipsForTab() {
  const wrap = document.getElementById('feed-chips');
  if (!wrap) return;
  const chips = CHIP_CONFIG[currentTab] || [];
  if (!chips.some(c => c.id === feedChip)) feedChip = 'all';
  wrap.innerHTML = chips.map(c => `
    <button type="button" class="chip-btn${c.id === feedChip ? ' active' : ''}" data-chip="${esc(c.id)}">${esc(c.label)}</button>
  `).join('');
  wrap.querySelectorAll('.chip-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      feedChip = btn.dataset.chip || 'all';
      renderChipsForTab();
      if (lastLoadedData) renderTab(lastLoadedData);
    });
  });
}

function matchesQuery(text) {
  if (!feedSearchQuery) return true;
  return String(text || '').toLowerCase().includes(feedSearchQuery);
}

// Sale tap-to-expand cache, keyed shop:id because /api/sale scopes by shop
// when the manager is filtering one register. null = fetch in flight;
// capped so a long session cannot grow it without bound.
const expandedSales = new Map();

function saleDetailHtml(detail) {
  const s = detail.sale || {};
  const lines = (detail.items || []).map(it => `
    <div class="sale-detail-row">
      <span>${esc(it.item_name || (it.item_type === 'labor' ? 'Repair labor' : 'Part'))}</span>
      <span>x${Number(it.quantity) || 0}</span>
      <span>${fmtMoney(it.total_price)}</span>
    </div>`).join('');
  const moneyRow = (label, val, cls = '') => `
    <div class="sale-detail-row${cls}"><span>${esc(label)}</span><span></span><span>${fmtMoney(val)}</span></div>`;
  return `
    <div class="sale-detail">
      ${lines || '<div class="sale-detail-row"><span>No line items synced for this sale.</span></div>'}
      ${moneyRow('Subtotal', s.subtotal)}
      ${Number(s.discount) > 0 ? moneyRow('Discount', -Number(s.discount)) : ''}
      ${moneyRow('Total', s.total_amount, ' sale-detail-total')}
    </div>`;
}

async function toggleSaleDetail(item) {
  const saleId = item.getAttribute('data-sale-id');
  if (!saleId) return;
  const shopId = item.getAttribute('data-sale-shop') || selectedShop || '';
  const key = `${shopId}:${saleId}`;
  if (expandedSales.has(key)) {
    expandedSales.delete(key);
    renderTab(lastLoadedData);
    return;
  }
  if (expandedSales.size > 50) expandedSales.clear();
  expandedSales.set(key, null);
  renderTab(lastLoadedData);
  try {
    expandedSales.set(key, await api(`/api/sale?id=${encodeURIComponent(saleId)}${shopId ? `&shop=${encodeURIComponent(shopId)}` : ''}`));
  } catch (err) {
    expandedSales.set(key, { error: err.message || 'request failed' });
  }
  renderTab(lastLoadedData);
}

function renderTab(data) {
  if (!data) return;
  const titleMap = {
    sales: 'Live Sales Stream',
    utang: 'Open Utang Balances',
    stock: 'Critical Stock Radar',
    reorder: 'Reorder List',
    reports: 'Top Selling Parts',
    audit: 'Cashier & Drawer Audit'
  };
  const titleEl = document.getElementById('feed-title');
  const countEl = document.getElementById('feed-count');
  const box = document.getElementById('rows');
  if (titleEl) titleEl.textContent = titleMap[currentTab] || 'Activity';
  renderChipsForTab();
  document.getElementById('cloud-reorder-bar')?.classList.toggle('hidden', currentTab !== 'reorder');
  document.getElementById('cloud-stock-bar')?.classList.toggle('hidden', currentTab !== 'stock');

  if (currentTab === 'sales') {
    const allSales = (data.sales || []).filter(s => {
      const voided = Boolean(s.voided);
      const isUtang = Number(s.credit_balance) > 0.001 && !voided;
      if (feedChip === 'cash' && (voided || isUtang || (s.payment_method && s.payment_method !== 'cash'))) return false;
      if (feedChip === 'digital' && (voided || (s.payment_method !== 'gcash' && s.payment_method !== 'transfer'))) return false;
      if (feedChip === 'utang' && !isUtang) return false;
      if (feedChip === 'voided' && !voided) return false;
      return matchesQuery(`${s.sale_code || ''} ${s.customer_name || ''} ${s.payment_method || ''}`);
    });
    const rows = allSales.slice(0, 50);
    if (countEl) countEl.textContent = `${rows.length} synced`;
    if (!rows.length) {
      box.innerHTML = '<div class="empty-state">No sales transactions match this filter.</div>';
      return;
    }
    box.innerHTML = rows.map(s => {
      const voided = Boolean(s.voided);
      const isUtang = Number(s.credit_balance) > 0.001 && !voided;
      const badgeClass = voided
        ? 'utang'
        : (isUtang
          ? 'utang'
          : (s.payment_method === 'gcash'
            ? 'gcash'
            : (s.payment_method === 'transfer' ? 'transfer' : 'cash')));
      const badgeLabel = voided
        ? 'Voided'
        : (isUtang
          ? 'Utang'
          : (s.payment_method === 'transfer' ? 'Transfer' : esc(s.payment_method || 'Cash')));
      const key = `${s.shop_id || selectedShop || ''}:${s.id}`;
      const detail = expandedSales.get(key);
      const detailHtml = detail === undefined ? '' : (detail === null
        ? '<div class="sale-detail">Loading items...</div>'
        : (detail.error
          ? `<div class="sale-detail">Could not load items: ${esc(detail.error)}</div>`
          : saleDetailHtml(detail)));
      return `
        <div class="feed-item sale-row" data-sale-id="${esc(s.id)}" data-sale-shop="${esc(s.shop_id || selectedShop || '')}" role="button" tabindex="0" aria-expanded="${detail === undefined ? 'false' : 'true'}">
          <div class="feed-left">
            <div class="feed-code-row">
              <span class="feed-code">${esc(s.sale_code || '#SALE')}</span>
              <span class="badge ${badgeClass}">${badgeLabel}</span>
            </div>
            <div class="feed-meta">${esc(s.customer_name || 'Walk-in')} · ${timeAgo(s.created_at)}</div>
          </div>
          <div class="feed-right">
            <div class="feed-amt ${isUtang ? 'debt' : ''}"${voided ? ' style="text-decoration:line-through;opacity:.55"' : ''}>${fmtMoney(s.total_amount)}</div>
            <div class="feed-time">${timeAgo(s.created_at)}</div>
          </div>
        </div>${detailHtml}
      `;
    }).join('');
  } else if (currentTab === 'utang') {
    if (feedChip === 'payments') {
      const payments = (data.utang || []).filter(p => matchesQuery(`${p.customer_name || ''} ${p.payment_method || ''}`)).slice(0, 50);
      if (countEl) countEl.textContent = `${payments.length} payments`;
      if (!payments.length) {
        box.innerHTML = '<div class="empty-state">No utang settlement payments synced yet.</div>';
        return;
      }
      box.innerHTML = payments.map(p => `
        <div class="feed-item">
          <div class="feed-left">
            <div class="feed-code-row">
              <span class="feed-code">${esc(p.customer_name || 'Customer')}</span>
              <span class="badge ${p.payment_method === 'gcash' ? 'gcash' : (p.payment_method === 'transfer' ? 'transfer' : 'cash')}">${esc(p.payment_method || 'cash')}</span>
            </div>
            <div class="feed-meta">Settled ${timeAgo(p.created_at)}</div>
          </div>
          <div class="feed-right">
            <div class="feed-amt">${fmtMoney(p.amount_paid)}</div>
          </div>
        </div>
      `).join('');
      return;
    }

    // Server-computed over the whole mirror (standing.debtor_list). Building
    // this from the newest-500 /api/rows window silently dropped the oldest
    // balances, which are also the likeliest to be forgotten.
    const sorted = (data.debtors || []).filter(d => {
      if (feedChip === 'high' && (Number(d.balance) || 0) < 1000) return false;
      return matchesQuery(d.name);
    });
    const agingHtml = agingBlockHtml(data.aging);
    if (countEl) countEl.textContent = `${sorted.length} debtors`;
    if (!sorted.length) {
      box.innerHTML = agingHtml + '<div class="empty-state">No open utang balances found.</div>';
      return;
    }
    box.innerHTML = agingHtml + sorted.map(d => `
      <div class="feed-item">
        <div class="feed-left">
          <span class="feed-code">${esc(d.name || 'Walk-in')}</span>
          <div class="feed-meta">Last transaction ${timeAgo(d.last_at)}${d.phone ? ` · <a class="debtor-tel" href="tel:${esc(d.phone)}">${esc(d.phone)}</a>` : ''}</div>
        </div>
        <div class="feed-right" style="display: flex; align-items: center; gap: 8px;">
          <div class="feed-amt debt">${fmtMoney(d.balance)}</div>
        </div>
      </div>
    `).join('');
  } else if (currentTab === 'stock') {
    if (feedChip === 'catalog') {
      const catalog = (data.inventory || []).filter(item => {
        const name = [item.brand, item.model_name, item.part_type, item.sku_barcode, item.supplier].filter(Boolean).join(' ');
        return matchesQuery(name);
      });
      const rows = catalog.slice(0, 200);
      if (countEl) countEl.textContent = `${catalog.length} parts`;
      if (!rows.length) {
        box.innerHTML = '<div class="empty-state">No inventory parts match this search.</div>';
        return;
      }
      box.innerHTML = rows.map(item => {
        const qty = Number(item.stock_quantity) || 0;
        const minAlert = Number(item.min_stock_alert ?? 2);
        const name = [item.brand, item.model_name, item.part_type].filter(Boolean).join(' ');
        const badgeCls = qty <= 0 ? 'utang' : (qty <= minAlert ? 'warn' : 'cash');
        const pend = getPendingDeltaForItem(data, item);
        const pendHtml = pend
          ? `<span class="badge warn" title="Waiting for counter POS heartbeat">Pending sync (${pend.delta > 0 ? '+' + pend.delta : pend.delta})</span>`
          : '';
        return `
          <div class="feed-item">
            <div class="feed-left">
              <div class="feed-code-row">
                <span class="feed-code">${esc(name || 'Part')}</span>
                ${item.sku_barcode ? `<span class="badge gcash">${esc(item.sku_barcode)}</span>` : ''}
                ${pendHtml}
              </div>
              <div class="feed-meta">Retail ${fmtMoney(item.price_retail)} · Capital ${fmtMoney(item.cost_price)} · Min ${esc(minAlert)}${item.supplier ? ` · ${esc(item.supplier)}` : ''}</div>
            </div>
            <div class="feed-right" style="display: flex; align-items: center; gap: 8px;">
              <span class="badge ${badgeCls}">${esc(qty)} in stock</span>
              <button type="button" class="row-stock-btn" data-add-stock-id="${esc(item.id)}" data-add-stock-shop="${esc(item.shop_id || selectedShop || '')}" data-add-stock-name="${esc(name)}" data-add-stock-qty="${esc(qty)}">+ Stock</button>
            </div>
          </div>
        `;
      }).join('');
      return;
    }

    const filtered = (data.reorder || []).filter(item => {
      const qty = Number(item.stock_quantity) || 0;
      if (feedChip === 'out' && qty > 0) return false;
      if (feedChip === 'low' && qty <= 0) return false;
      if (feedChip === 'fast' && !(!item.below_min && Number(item.units_sold) > 0)) return false;
      return matchesQuery(item.name);
    });
    const rows = filtered.slice(0, 100);
    if (countEl) countEl.textContent = `${rows.length} alerts`;
    if (!rows.length) {
      box.innerHTML = `<div class="empty-state">${feedChip === 'fast' ? 'No fast movers are running low on cover.' : 'All parts are at or above healthy stock levels.'}</div>`;
      return;
    }
    box.innerHTML = rows.map(item => {
      const qty = Number(item.stock_quantity) || 0;
      const coverNote = item.cover_days !== null && item.cover_days !== undefined
        ? ` · ${item.units_sold} sold/${reorderDays}d · ${item.cover_days}d cover`
        : '';
      const pend = getPendingDeltaForItem(data, item);
      const pendHtml = pend
        ? `<span class="badge warn" title="Waiting for counter POS heartbeat">Pending sync (${pend.delta > 0 ? '+' + pend.delta : pend.delta})</span>`
        : '';
      return `
        <div class="feed-item">
          <div class="feed-left">
            <div class="feed-code-row">
              <span class="feed-code">${esc(item.name || 'Part')}</span>
              ${pendHtml}
            </div>
            <div class="feed-meta">Alert threshold: ${esc(item.min_stock_alert)} · Restock ${esc(item.restock_qty)} (${fmtMoney(item.restock_cost)})${coverNote}</div>
          </div>
          <div class="feed-right" style="display: flex; align-items: center; gap: 8px;">
            <span class="badge ${qty <= 0 ? 'utang' : 'warn'}">${esc(item.stock_quantity)} units left</span>
            <button type="button" class="row-stock-btn" data-add-stock-id="${esc(item.id)}" data-add-stock-shop="${esc(item.shop_id || selectedShop || '')}" data-add-stock-name="${esc(item.name || 'Part')}" data-add-stock-qty="${esc(qty)}">+ Stock</button>
          </div>
        </div>
      `;
    }).join('');
  } else if (currentTab === 'reorder') {
    const activeRows = getActiveReorderRows(data);
    updateCloudReorderSummary(activeRows);
    const rows = activeRows.slice(0, 150);
    if (countEl) countEl.textContent = `${rows.length} parts`;
    if (!rows.length) {
      box.innerHTML = `<div class="empty-state">${feedChip === 'all' ? `No parts sold in the last ${reorderDays} day${reorderDays === 1 ? '' : 's'}.` : 'No parts match this reorder filter.'}</div>`;
      return;
    }
    box.innerHTML = rows.map(item => {
      const qty = Number(item.stock_quantity) || 0;
      const minAlert = Number(item.min_stock_alert) || 0;
      const sold = Number(item.qty_sold ?? item.units_sold) || 0;
      const name = item.name || [item.brand, item.model_name, item.part_type].filter(Boolean).join(' ');
      const key = `${item.shop_id || selectedShop || ''}:${item.id}`;
      const orderQty = reorderOrderQtyOverrides.has(key)
        ? reorderOrderQtyOverrides.get(key)
        : (Number(item.suggested_qty ?? item.restock_qty) || 1);
      const badgeCls = qty <= 0 ? 'utang' : (qty <= minAlert ? 'warn' : 'cash');
      const pend = getPendingDeltaForItem(data, item);
      const pendHtml = pend
        ? `<span class="badge warn" title="Waiting for counter POS heartbeat">Pending sync (${pend.delta > 0 ? '+' + pend.delta : pend.delta})</span>`
        : '';
      return `
        <div class="feed-item">
          <div class="feed-left">
            <div class="feed-code-row">
              <span class="feed-code">${esc(name || 'Part')}</span>
              ${item.supplier ? `<span class="badge gcash">${esc(item.supplier)}</span>` : ''}
              ${pendHtml}
            </div>
            <div class="feed-meta">Sold ${esc(sold)} (${reorderDays}d) · On hand <span class="badge ${badgeCls}" style="padding: 1px 5px; font-size: 10px;">${esc(qty)}</span> · Min ${esc(minAlert)} · Cost ${fmtMoney(item.cost_price)}</div>
          </div>
          <div class="feed-right" style="display: flex; align-items: center; gap: 8px;">
            <label style="display: inline-flex; align-items: center; gap: 4px; font-family: var(--mono); font-size: 11px; color: var(--text-muted);">
              <span>Order</span>
              <input type="number" class="order-qty-input" min="0" step="${item.allow_fractional ? 'any' : '1'}" value="${esc(orderQty)}" data-order-key="${esc(key)}" data-unit-cost="${esc(Number(item.cost_price) || 0)}" aria-label="Order quantity for ${esc(name)}">
            </label>
            <button type="button" class="row-stock-btn" data-add-stock-id="${esc(item.id)}" data-add-stock-shop="${esc(item.shop_id || selectedShop || '')}" data-add-stock-name="${esc(name)}" data-add-stock-qty="${esc(qty)}">+ Stock</button>
          </div>
        </div>
      `;
    }).join('');
  } else if (currentTab === 'reports') {
    if (feedChip === 'dead') {
      const dead = (data.deadStock || []).filter(p => matchesQuery(p.name));
      if (countEl) countEl.textContent = `${dead.length} parts`;
      if (!dead.length) {
        box.innerHTML = '<div class="empty-state">Everything on the shelf sold within this window.</div>';
        return;
      }
      box.innerHTML = dead.map(p => `
        <div class="feed-item">
          <div class="feed-left">
            <span class="feed-code">${esc(p.name || 'Part')}</span>
            <div class="feed-meta">${p.stock_quantity} in stock · no sale for ${p.days_no_sale}d · last ${p.last_sold ? esc(p.last_sold) : 'never recorded'}</div>
          </div>
          <div class="feed-right">
            <div class="feed-amt debt">${fmtMoney(p.tied_up_capital)}</div>
            <div class="feed-time">band ${esc(p.age_band)}</div>
          </div>
        </div>
      `).join('');
      return;
    }
    const raw = (data.analytics?.top_products || []).slice();
    if (feedChip === 'profit') {
      raw.sort((a, b) => (Number(b.profit) || 0) - (Number(a.profit) || 0));
    }
    const rows = raw.filter(p => matchesQuery(p.item_name)).slice(0, 30);
    if (countEl) countEl.textContent = `${rows.length} parts`;
    if (!rows.length) {
      box.innerHTML = '<div class="empty-state">No parts sold during this reporting window.</div>';
      return;
    }
    box.innerHTML = rows.map(p => {
      const rev = Number(p.revenue) || 0;
      const prof = Number(p.profit) || 0;
      const mPct = rev > 0 ? ((prof / rev) * 100).toFixed(0) : '0';
      return `
        <div class="feed-item">
          <div class="feed-left">
            <span class="feed-code">${esc(p.item_name)}</span>
            <div class="feed-meta">${p.units} units · profit ${fmtMoney(p.profit)} (${mPct}% margin)</div>
          </div>
          <div class="feed-right">
            <div class="feed-amt">${fmtMoney(p.revenue)}</div>
          </div>
        </div>
      `;
    }).join('');
  } else if (currentTab === 'audit') {
    const events = [];
    if (feedChip === 'all' || feedChip === 'drawer') {
      for (const r of (data.reconciliations || [])) {
        const v = Number(r.variance) || 0;
        events.push({
          ts: r.created_at || r.day || '',
          code: `Drawer Close (${r.day || 'Shift'})`,
          badge: Math.abs(v) < 0.01 ? 'Balanced' : (v < 0 ? 'Shortage' : 'Overage'),
          badgeClass: Math.abs(v) < 0.01 ? 'cash' : (v < 0 ? 'utang' : 'warn'),
          meta: `Counted ${fmtMoney(r.counted_cash)} vs Expected ${fmtMoney(r.expected_cash)}`,
          amt: fmtMoney(v),
          amtClass: Math.abs(v) < 0.01 ? '' : (v < 0 ? 'debt' : 'warn')
        });
      }
    }
    if (feedChip === 'all' || feedChip === 'shifts') {
      for (const sh of (data.shifts || [])) {
        const open = sh.status !== 'closed';
        const variance = Number(sh.variance) || 0;
        events.push({
          ts: open ? (sh.opened_at || '') : (sh.closed_at || sh.opened_at || ''),
          code: open ? 'Shift Open' : 'Shift Close',
          badge: open ? 'Open' : (Math.abs(variance) < 0.01 ? 'Balanced' : (variance < 0 ? 'Shortage' : 'Overage')),
          badgeClass: open ? 'gcash' : (Math.abs(variance) < 0.01 ? 'cash' : (variance < 0 ? 'utang' : 'warn')),
          meta: open
            ? `${sh.staff_name || 'Counter'} opened with float ${fmtMoney(sh.opening_float)}`
            : `${sh.staff_name || 'Counter'} · Counted ${fmtMoney(sh.counted_cash)} vs Expected ${fmtMoney(sh.expected_cash)}`,
          amt: open ? '' : fmtMoney(variance),
          amtClass: variance < 0 ? 'debt' : 'warn'
        });
      }
    }
    if (feedChip === 'all' || feedChip === 'voids') {
      for (const s of (data.sales || [])) {
        if (!s.voided) continue;
        events.push({
          ts: s.created_at || '',
          code: s.sale_code || '#VOID',
          badge: 'Voided Sale',
          badgeClass: 'utang',
          meta: `${s.customer_name || 'Walk-in'} · ${s.void_reason || 'Ticket voided at counter'}`,
          amt: fmtMoney(s.total_amount),
          amtClass: 'debt'
        });
      }
    }
    if (feedChip === 'all' || feedChip === 'cash_adj') {
      for (const a of (data.adjustments || [])) {
        const amt = Number(a.amount) || 0;
        events.push({
          ts: a.created_at || '',
          code: amt < 0 ? 'Cash Payout / Drop' : 'Cash Float In',
          badge: amt < 0 ? 'Cash Out' : 'Cash In',
          badgeClass: amt < 0 ? 'warn' : 'cash',
          meta: a.reason || 'Manual drawer adjustment',
          amt: fmtMoney(amt),
          amtClass: amt < 0 ? 'warn' : ''
        });
      }
    }
    if (feedChip === 'all' || feedChip === 'rma') {
      for (const w of (data.rets || [])) {
        const isSwap = w.return_type === 'replacement';
        events.push({
          ts: w.created_at || '',
          code: w.return_code || '#RMA',
          badge: isSwap ? 'Part Swap' : 'Cash Refund',
          badgeClass: isSwap ? 'warn' : 'utang',
          meta: `${w.reason || 'Warranty claim'} (Sale #${w.sale_id})`,
          amt: isSwap ? `${w.quantity || 1} unit` : fmtMoney(w.refund_amount),
          amtClass: isSwap ? 'warn' : 'debt'
        });
      }
    }

    events.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
    const filtered = events.filter(ev => matchesQuery(`${ev.code} ${ev.badge} ${ev.meta}`)).slice(0, 50);
    if (countEl) countEl.textContent = `${filtered.length} events`;
    if (!filtered.length) {
      box.innerHTML = '<div class="empty-state">No drawer discrepancies, voids, cash adjustments, or RMA claims found.</div>';
      return;
    }
    box.innerHTML = filtered.map(ev => `
      <div class="feed-item">
        <div class="feed-left">
          <div class="feed-code-row">
            <span class="feed-code">${esc(ev.code)}</span>
            <span class="badge ${ev.badgeClass}">${esc(ev.badge)}</span>
          </div>
          <div class="feed-meta">${esc(ev.meta)} · ${timeAgo(ev.ts)}</div>
        </div>
        <div class="feed-right">
          <div class="feed-amt ${ev.amtClass}">${esc(ev.amt)}</div>
          <div class="feed-time">${timeAgo(ev.ts)}</div>
        </div>
      </div>
    `).join('');
  }
}

function setActiveTab(nextTab) {
  currentTab = nextTab;
  feedChip = 'all';
  document.querySelectorAll('.nav-btn, .desk-tab').forEach(b => {
    const active = b.dataset.tab === nextTab;
    b.classList.toggle('active', active);
    if (b.hasAttribute('aria-selected')) {
      b.setAttribute('aria-selected', active ? 'true' : 'false');
    }
  });
  if (lastLoadedData) renderTab(lastLoadedData);
  else refresh();
}

// One change event per shop push, and every event ran the full refresh (nine
// API calls, each a mirror scan). Several shops pushing at once, or a retry
// storm, multiplied that with no visible benefit; coalescing into one refresh
// per window keeps the feed live without the request fan-out.
let refreshTimer = null;
function scheduleRefresh(delayMs = 1000) {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => { refreshTimer = null; refresh().catch(() => {}); }, delayMs);
}

// Shop-blind refetch, closed: a change event names its shop, so when the
// manager is looking at one register, another shop's heartbeat or sale no
// longer triggers a full nine-call refetch of the wrong view. Deployments,
// deletions and untagged payloads (older server) always refresh.
function onSseChange(e) {
  let shopId = '';
  try { shopId = String(JSON.parse(e && e.data ? e.data : '{}').shop_id || ''); } catch (_) {}
  if (selectedShop && shopId && shopId !== selectedShop) return;
  scheduleRefresh();
}

function connectSSE() {
  if (!loggedIn) return;
  if (eventSource) eventSource.close();
  const es = new EventSource('/events');
  eventSource = es;
  const beacon = document.getElementById('conn-beacon');

  es.addEventListener('hello', () => {
    // Socket up is not data current: the badge (lastOkRefreshAt) owns the truth.
    if (beacon && lastOkRefreshAt) { beacon.classList.remove('off'); beacon.title = 'Live connection active'; }
  });

  es.addEventListener('change', (e) => {
    onSseChange(e);
  });

  es.addEventListener('paired', (e) => {
    const payload = JSON.parse(e.data || '{}');
    const unpaired = document.getElementById('pair-unpaired-state');
    const paired = document.getElementById('pair-paired-state');
    const desc = document.getElementById('pair-success-desc');
    if (unpaired) unpaired.style.display = 'none';
    if (paired) paired.style.display = 'block';
    if (desc) desc.textContent = `Shop "${payload.shop_name || 'Counter'}" paired successfully via SSE.`;
    showToast(`Register "${payload.shop_name || 'Counter'}" paired`);
    refresh().catch(() => {});
  });

  es.onerror = () => {
    setCloudFreshness(false);
  };

  es.addEventListener('open', () => {
    // Same rule as hello: green only when data is actually current.
    if (beacon && lastOkRefreshAt) { beacon.classList.remove('warn', 'off'); beacon.title = 'Live connection active'; }
    refresh().catch(() => {});
  });
}

setInterval(() => {
  if (!loggedIn || document.hidden) return;
  if (!eventSource || eventSource.readyState !== 1) {
    refresh().catch(() => {});
  }
}, POLL_MS);

document.addEventListener('visibilitychange', () => {
  if (!loggedIn || document.hidden) return;
  refresh().catch(() => {});
  if (!eventSource || eventSource.readyState === 2) {
    connectSSE();
  }
});

// Event Listeners
document.getElementById('setup-submit-btn')?.addEventListener('click', submitSetupPin);

document.querySelectorAll('.key-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const key = btn.dataset.key;
    if (key === 'clear') {
      keypadPin = '';
      updateKeypadDots();
    } else if (key === 'go') {
      if (keypadPin) submitLoginPin(keypadPin);
    } else if (key === 'back') {
      keypadPin = keypadPin.slice(0, -1);
      updateKeypadDots();
    } else if (keypadPin.length < 12) {
      keypadPin += key;
      updateKeypadDots();
    }
  });
});

document.getElementById('login-text-btn')?.addEventListener('click', () => {
  const textPin = document.getElementById('pin-text-input')?.value.trim();
  if (textPin) submitLoginPin(textPin);
});

document.getElementById('pin-text-input')?.addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    const textPin = document.getElementById('pin-text-input')?.value.trim();
    if (textPin) submitLoginPin(textPin);
  }
});

document.addEventListener('keydown', e => {
  const loginOpen = document.getElementById('login-modal')?.classList.contains('open');
  if (!loginOpen) return;
  const tag = (document.activeElement?.tagName || '').toUpperCase();
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  if (/^[0-9]$/.test(e.key)) {
    e.preventDefault();
    // Accumulate up to 12 digits and submit on Enter: rotated PINs are 8, so
    // auto-firing at 4 made the hardware-keyboard path unable to log in.
    if (keypadPin.length < 12) {
      keypadPin += e.key;
      updateKeypadDots();
    }
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (keypadPin) submitLoginPin(keypadPin);
  } else if (e.key === 'Backspace') {
    e.preventDefault();
    keypadPin = keypadPin.slice(0, -1);
    updateKeypadDots();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    keypadPin = '';
    updateKeypadDots();
  }
});

document.getElementById('login-reset-btn')?.addEventListener('click', () => {
  document.getElementById('login-modal')?.classList.remove('open');
  document.getElementById('setup-modal')?.classList.add('open');
  document.getElementById('setup-store-name')?.focus();
});

document.getElementById('toggle-to-login-btn')?.addEventListener('click', () => {
  document.getElementById('setup-modal')?.classList.remove('open');
  document.getElementById('login-modal')?.classList.add('open');
  document.getElementById('login-store-name')?.focus();
});

document.getElementById('logout-btn')?.addEventListener('click', logout);
document.getElementById('open-pair-modal')?.addEventListener('click', openPairingModal);
document.getElementById('close-pair-modal')?.addEventListener('click', () => {
  document.getElementById('pair-modal')?.classList.remove('open');
  if (pairingTimerInterval) clearInterval(pairingTimerInterval);
});
document.getElementById('close-pair-success')?.addEventListener('click', () => {
  document.getElementById('pair-modal')?.classList.remove('open');
  if (pairingTimerInterval) clearInterval(pairingTimerInterval);
});
document.getElementById('copy-code-btn')?.addEventListener('click', copyPairingCode);

document.getElementById('shop-filter')?.addEventListener('change', e => {
  selectedShop = e.target.value || '';
  if (selectedShop) {
    localStorage.setItem('techparts_selected_shop', selectedShop);
  } else {
    localStorage.removeItem('techparts_selected_shop');
  }
  refresh();
});

document.getElementById('paired-shops-list')?.addEventListener('click', async e => {
  const btn = e.target.closest('[data-unlink-shop]');
  if (!btn) return;
  const shopId = btn.getAttribute('data-unlink-shop');
  if (!shopId) return;

  if (!confirm(`Are you sure you want to unlink register "${shopId}"?\n\nThis will permanently remove this register and purge all of its mirrored sales, inventory, and telemetry from the cloud.`)) return;

  btn.disabled = true;
  btn.textContent = 'Purging...';
  try {
    const res = await api('/api/shops/' + encodeURIComponent(shopId), { method: 'DELETE' });
    if (res.ok) {
      showToast('Register unlinked and purged');
      if (selectedShop === shopId) {
        selectedShop = '';
        localStorage.removeItem('techparts_selected_shop');
      }
      refresh();
    } else {
      showToast(res.error || 'Failed to unlink register');
      btn.disabled = false;
      btn.textContent = 'Unlink';
    }
  } catch (err) {
    showToast('Unlink error: ' + err.message);
    btn.disabled = false;
    btn.textContent = 'Unlink';
  }
});

document.getElementById('feed-search')?.addEventListener('input', e => {
  feedSearchQuery = String(e.target.value || '').trim().toLowerCase();
  if (lastLoadedData) renderTab(lastLoadedData);
});

document.getElementById('audit-banner')?.addEventListener('click', () => {
  setActiveTab('audit');
});

document.querySelectorAll('.period-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.period-tab').forEach(t => {
      t.classList.remove('active');
      t.setAttribute('aria-selected', 'false');
    });
    tab.classList.add('active');
    tab.setAttribute('aria-selected', 'true');
    period = tab.dataset.period;
    const customRow = document.getElementById('custom-range-row');
    if (customRow) customRow.classList.toggle('hidden', period !== 'custom');
    if (period === 'custom') {
      const fromInput = document.getElementById('range-from');
      if (fromInput && !fromInput.value) fromInput.value = new Date().toLocaleDateString('en-CA');
    }
    refresh();
  });
});

document.getElementById('range-from')?.addEventListener('change', () => refresh());
document.getElementById('range-to')?.addEventListener('change', () => refresh());

const CLOUD_IMPORT_TEMPLATE_HEADERS = [
  'Brand', 'Model Name', 'Part Type', 'SKU / Barcode',
  'Capital', 'Retail Price', 'Wholesale Price', 'Stock Qty',
  'Min Stock Alert', 'Supplier', 'Location',
];

const CLOUD_REORDER_CSV_HEADERS = [
  'Brand', 'Model Name', 'Part Type', 'SKU / Barcode',
  'Capital', 'Retail Price', 'Wholesale Price', 'Sold', 'In Stock', 'Stock Qty',
  'Min Stock Alert', 'Supplier', 'Location',
];

const CLOUD_HEADER_ALIASES = {
  item_name:        ['itemname', 'productname', 'name'],
  brand:            ['brand', 'make', 'manufacturer'],
  model_name:       ['model', 'modelname', 'device', 'phone', 'unit'],
  part_type:        ['parttype', 'part', 'type', 'category', 'item', 'description'],
  category:         ['category', 'cat'],
  uom:              ['uom', 'unitofmeasure'],
  allow_fractional: ['allowfractional', 'fractional', 'decimal'],
  sku_barcode:      ['sku', 'barcode', 'skubarcode', 'code', 'partnumber', 'partno', 'upc', 'ean'],
  cost_price:       ['costprice', 'cost', 'unitcost', 'buyprice', 'capital', ' puhunan', 'puhunan', 'wholesale'],
  price_retail:     ['priceretail', 'retail', 'retailprice', 'price', 'sellingprice', 'srp', 'walkin'],
  price_technician: ['pricetechnician', 'technicianprice', 'techprice', 'tprice', 'dealer', 'dealerprice', 'wholesaleprice'],
  stock_quantity:   ['stockquantity', 'stock', 'qty', 'quantity', 'onhand', 'stockqty'],
  min_stock_alert:  ['minstockalert', 'minstock', 'reorderlevel', 'alert', 'lowstock', 'min'],
  supplier:         ['supplier', 'vendor', 'source'],
  location:         ['location', 'bin', 'shelf', 'drawer', 'slot'],
};

function getActiveReorderRows(data) {
  if (!data) return [];
  const base = feedChip === 'all'
    ? (data.reorderSheet || [])
    : (data.reorder || []).filter(item => {
        if (feedChip === 'below') return Boolean(item.below_min);
        if (feedChip === 'fast') return !item.below_min && Number(item.units_sold) > 0;
        return true;
      });
  return base.filter(item => {
    const text = [item.name, item.brand, item.model_name, item.part_type, item.sku_barcode, item.supplier].filter(Boolean).join(' ');
    return matchesQuery(text);
  });
}

function getRowOrderQty(item) {
  const key = `${item.shop_id || selectedShop || ''}:${item.id}`;
  if (reorderOrderQtyOverrides.has(key)) return reorderOrderQtyOverrides.get(key);
  const raw = Number(item.suggested_qty ?? item.restock_qty) || 1;
  return Math.max(0, Math.round(raw * 1000) / 1000);
}

function updateCloudReorderSummary(rows) {
  const summaryEl = document.getElementById('cloud-reorder-summary');
  if (!summaryEl) return;
  const list = Array.isArray(rows) ? rows : getActiveReorderRows(lastLoadedData);
  let totalUnits = 0;
  let totalCost = 0;
  for (const r of list) {
    const qty = getRowOrderQty(r);
    const cost = Number(r.cost_price) || 0;
    totalUnits += qty;
    totalCost += qty * cost;
  }
  const cleanUnits = Math.round(totalUnits * 1000) / 1000;
  summaryEl.textContent = `${list.length} part${list.length === 1 ? '' : 's'} · ${cleanUnits} to order · Est ${fmtMoney(totalCost)}`;
}

function csvCell(val) {
  let s = String(val ?? '');
  if (/^[=+@\t\r]/.test(s) || (/^-/.test(s) && !/^-?\d+(\.\d+)?$/.test(s))) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function triggerCsvDownload(filename, lines) {
  const csv = '\uFEFF' + lines.join('\r\n') + '\r\n';
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function copyCloudReorderOrder() {
  const rows = getActiveReorderRows(lastLoadedData);
  if (!rows.length) {
    showToast('Nothing to copy');
    return;
  }
  const bySupplier = new Map();
  let count = 0;
  for (const r of rows) {
    const qty = getRowOrderQty(r);
    if (qty <= 0) continue;
    const sup = (r.supplier || '').trim() || 'Unspecified supplier';
    if (!bySupplier.has(sup)) bySupplier.set(sup, []);
    const sku = r.sku_barcode ? ` [${r.sku_barcode}]` : '';
    const label = [r.brand, r.model_name, r.part_type].filter(Boolean).join(' ') || r.name || 'Part';
    bySupplier.get(sup).push(`  ${qty}x ${label}${sku}`);
    count++;
  }
  if (!count) {
    showToast('All order quantities are 0');
    return;
  }
  const lines = [];
  for (const [sup, items] of bySupplier) {
    lines.push(`=== ${sup} ===`, ...items, '');
  }
  navigator.clipboard.writeText(lines.join('\n').trim()).then(
    () => showToast(`Copied ${count} line${count === 1 ? '' : 's'} to clipboard`),
    () => showToast('Clipboard unavailable')
  );
}

function exportCloudReorderCsv() {
  const rows = getActiveReorderRows(lastLoadedData);
  if (!rows.length) {
    showToast('No reorder items to export');
    return;
  }
  const body = rows.map(r => [
    r.brand || '',
    r.model_name || '',
    r.part_type || '',
    r.sku_barcode || '',
    r.cost_price ?? 0,
    r.price_retail ?? 0,
    r.price_technician ?? r.price_retail ?? 0,
    r.qty_sold ?? r.units_sold ?? 0,
    r.stock_quantity ?? 0,
    '',
    r.min_stock_alert ?? 2,
    r.supplier || '',
    r.location || '',
  ].map(csvCell).join(','));
  const stamp = new Date().toISOString().slice(0, 10);
  triggerCsvDownload(`techparts-reorder-${stamp}.csv`, [CLOUD_REORDER_CSV_HEADERS.map(csvCell).join(','), ...body]);
  showToast(`Exported ${body.length} reorder row${body.length === 1 ? '' : 's'} (fill Stock Qty when order arrives)`);
}

function downloadCloudTemplateCsv() {
  const example = ['Samsung', 'A15 5G', 'LCD Screen', 'SAM-A15-LCD', '650', '1200', '950', '5', '2', 'Quiapo Parts', 'Drawer A2'];
  triggerCsvDownload('techparts-import-template.csv', [
    CLOUD_IMPORT_TEMPLATE_HEADERS.map(csvCell).join(','),
    example.map(csvCell).join(','),
  ]);
  showToast('Template CSV downloaded');
}

function exportCloudStockCsv() {
  const items = lastLoadedData?.inventory || [];
  if (!items.length) {
    showToast('No inventory items to export');
    return;
  }
  const body = items.map(r => [
    r.brand || '',
    r.model_name || '',
    r.part_type || '',
    r.sku_barcode || '',
    r.cost_price ?? 0,
    r.price_retail ?? 0,
    r.price_technician ?? 0,
    r.stock_quantity ?? 0,
    r.min_stock_alert ?? 2,
    r.supplier || '',
    r.location || '',
  ].map(csvCell).join(','));
  const stamp = new Date().toISOString().slice(0, 10);
  triggerCsvDownload(`techparts-inventory-${stamp}.csv`, [CLOUD_IMPORT_TEMPLATE_HEADERS.map(csvCell).join(','), ...body]);
  showToast(`Exported ${items.length} part${items.length === 1 ? '' : 's'}`);
}

function parseDelimitedText(text) {
  const firstLine = text.split(/\r?\n/)[0] || '';
  const delim = (firstLine.match(/\t/g) || []).length > (firstLine.match(/,/g) || []).length ? '\t' : ',';
  const rows = [];
  let row = [], cell = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else cell += c;
    } else if (c === '"' && cell === '') {
      inQuotes = true;
    } else if (c === delim) {
      row.push(cell.trim()); cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell.trim()); cell = '';
      if (row.some(v => v !== '')) rows.push(row);
      row = [];
    } else {
      cell += c;
    }
  }
  if (cell !== '' || row.length) {
    row.push(cell.trim());
    if (row.some(v => v !== '')) rows.push(row);
  }
  return rows;
}

function parseCloudImportRows(text) {
  const cleanText = String(text || '').replace(/^\uFEFF/, '');
  const grid = parseDelimitedText(cleanText);
  if (grid.length < 2) return [];
  const headers = grid[0].map(h => String(h || '').toLowerCase().replace(/[^a-z0-9]/g, ''));
  const mapping = {};
  for (const [field, aliases] of Object.entries(CLOUD_HEADER_ALIASES)) {
    const idx = headers.findIndex(h => aliases.includes(h));
    if (idx !== -1) mapping[field] = idx;
  }
  const num = v => {
    const n = Number(String(v ?? '').replace(/[₱$,\s]/g, ''));
    return Number.isFinite(n) ? n : 0;
  };
  const out = [];
  for (const r of grid.slice(1)) {
    const get = f => mapping[f] !== undefined ? (r[mapping[f]] ?? '') : '';
    const item_name = String(get('item_name')).trim();
    const brand = String(get('brand')).trim() || (item_name ? 'General' : '');
    const model_name = String(get('model_name')).trim() || item_name;
    const category = String(get('category')).trim();
    const part_type = String(get('part_type')).trim() || category || (item_name ? 'General' : '');
    if (!brand || !model_name || !part_type) continue;
    const rawMin = String(get('min_stock_alert')).trim();
    const rawFrac = String(get('allow_fractional')).trim();
    out.push({
      item_name,
      brand,
      model_name,
      part_type,
      category: category || part_type,
      uom: String(get('uom')).trim(),
      allow_fractional: rawFrac !== '' ? (/^(1|true|yes)$/i.test(rawFrac) ? 1 : 0) : '',
      sku_barcode: String(get('sku_barcode')).trim(),
      cost_price: num(get('cost_price')),
      price_retail: num(get('price_retail')),
      price_technician: get('price_technician') !== '' ? num(get('price_technician')) : num(get('price_retail')),
      stock_quantity: Math.max(0, Math.round(num(get('stock_quantity')) * 1000) / 1000),
      min_stock_alert: rawMin !== '' ? Math.max(0, Math.round(num(rawMin) * 1000) / 1000) : '',
      supplier: String(get('supplier')).trim(),
      location: String(get('location')).trim(),
    });
  }
  return out;
}

function openStockModal(item) {
  activeStockModalItem = item;
  const modal = document.getElementById('stock-modal');
  const partEl = document.getElementById('stock-modal-part');
  const deltaEl = document.getElementById('stock-modal-delta');
  const reasonEl = document.getElementById('stock-modal-reason');
  const noteEl = document.getElementById('stock-modal-note');
  const errEl = document.getElementById('stock-modal-err');
  if (!modal) return;
  if (partEl) partEl.textContent = `${item.name} · Currently ${item.qty} in stock`;
  if (deltaEl) deltaEl.value = '1';
  if (reasonEl) reasonEl.value = 'receive';
  if (noteEl) noteEl.value = '';
  if (errEl) errEl.textContent = '';
  modal.classList.add('open');
  setTimeout(() => deltaEl?.focus(), 40);
}

async function submitStockModal() {
  if (!activeStockModalItem) return;
  const deltaEl = document.getElementById('stock-modal-delta');
  const reasonEl = document.getElementById('stock-modal-reason');
  const noteEl = document.getElementById('stock-modal-note');
  const errEl = document.getElementById('stock-modal-err');
  const saveBtn = document.getElementById('stock-modal-save');
  const rawDelta = Number(deltaEl?.value);
  const delta = Math.round(rawDelta * 1000) / 1000;
  if (!Number.isFinite(rawDelta) || delta === 0) {
    if (errEl) errEl.textContent = 'Enter a non-zero number (+ to add, - to deduct).';
    return;
  }
  const origText = saveBtn ? saveBtn.textContent : 'Save Stock Update';
  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving...';
  }
  updateCloudSyncStateBadge({ inFlight: true });
  try {
    await api('/api/inventory/adjust-stock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: Number(activeStockModalItem.id),
        shop_id: activeStockModalItem.shop || selectedShop || '',
        delta,
        reason: reasonEl?.value || 'receive',
        note: noteEl?.value || 'Added from Cloud',
      }),
    });
    document.getElementById('stock-modal')?.classList.remove('open');
    activeStockModalItem = null;
    showToast(`Stock ${delta > 0 ? '+' + delta : delta} saved and queued for counter sync`);
    await refresh();
  } catch (err) {
    if (errEl) errEl.textContent = err.message || 'Could not update stock';
    updateCloudSyncStateBadge({ inFlight: false });
  } finally {
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.textContent = origText;
    }
  }
}

function openCloudImportModal(fileName, rows) {
  pendingImportRows = rows;
  const modal = document.getElementById('import-modal');
  const subEl = document.getElementById('import-modal-sub');
  const previewEl = document.getElementById('import-modal-preview');
  const errEl = document.getElementById('import-modal-err');
  const confirmBtn = document.getElementById('import-modal-confirm');
  if (!modal) return;
  const addingCount = rows.filter(r => (Number(r.stock_quantity) || 0) > 0).length;
  const totalAddingUnits = rows.reduce((s, r) => s + (Number(r.stock_quantity) || 0), 0);
  if (subEl) {
    subEl.textContent = `${fileName}: ${rows.length} row${rows.length === 1 ? '' : 's'} ready (${addingCount} adding +${totalAddingUnits} units total)`;
  }
  if (previewEl) {
    previewEl.innerHTML = rows.slice(0, 40).map(r => {
      const label = [r.brand, r.model_name, r.part_type].filter(Boolean).join(' ');
      const qty = Number(r.stock_quantity) || 0;
      return `<div style="display:flex;justify-content:space-between;gap:8px;padding:3px 0;border-bottom:1px solid var(--border);">
        <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(label)}</span>
        <span style="color:${qty > 0 ? 'var(--cash)' : 'var(--text-muted)'};font-weight:700;">+${esc(qty)}</span>
      </div>`;
    }).join('');
  }
  if (errEl) errEl.textContent = '';
  if (confirmBtn) confirmBtn.textContent = `Import ${rows.length} Row${rows.length === 1 ? '' : 's'}`;
  modal.classList.add('open');
}

async function confirmCloudCsvImport() {
  if (!pendingImportRows.length) return;
  const errEl = document.getElementById('import-modal-err');
  const confirmBtn = document.getElementById('import-modal-confirm');
  const origText = confirmBtn ? confirmBtn.textContent : 'Import Rows';
  if (confirmBtn) {
    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Importing...';
  }
  updateCloudSyncStateBadge({ inFlight: true });
  try {
    const res = await api('/api/inventory/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        shop_id: selectedShop || '',
        rows: pendingImportRows,
      }),
    });
    document.getElementById('import-modal')?.classList.remove('open');
    pendingImportRows = [];
    showToast(`Imported: ${res.created || 0} new, ${res.updated || 0} updated`);
    await refresh();
  } catch (err) {
    if (errEl) errEl.textContent = err.message || 'CSV import failed';
    updateCloudSyncStateBadge({ inFlight: false });
  } finally {
    if (confirmBtn) {
      confirmBtn.disabled = false;
      confirmBtn.textContent = origText;
    }
  }
}

document.getElementById('rows')?.addEventListener('click', e => {
  const stockBtn = e.target.closest('[data-add-stock-id]');
  if (stockBtn) {
    e.stopPropagation();
    openStockModal({
      id: stockBtn.getAttribute('data-add-stock-id'),
      shop: stockBtn.getAttribute('data-add-stock-shop') || '',
      name: stockBtn.getAttribute('data-add-stock-name') || 'Part',
      qty: Number(stockBtn.getAttribute('data-add-stock-qty')) || 0,
    });
    return;
  }
  if (currentTab !== 'sales') return;
  const item = e.target.closest('.sale-row');
  if (item) toggleSaleDetail(item);
});

document.getElementById('rows')?.addEventListener('input', e => {
  const qtyInput = e.target.closest('.order-qty-input');
  if (!qtyInput) return;
  const key = qtyInput.getAttribute('data-order-key');
  const raw = Math.max(0, Number(qtyInput.value) || 0);
  const val = qtyInput.step === 'any' ? Math.round(raw * 1000) / 1000 : Math.trunc(raw);
  if (key) reorderOrderQtyOverrides.set(key, val);
  updateCloudReorderSummary();
});

document.querySelectorAll('[data-reorder-days]').forEach(btn => {
  btn.addEventListener('click', () => {
    const d = Math.max(1, Math.min(90, Number(btn.getAttribute('data-reorder-days')) || 7));
    reorderDays = d;
    reorderOrderQtyOverrides.clear();
    document.querySelectorAll('[data-reorder-days]').forEach(b => b.classList.toggle('active', b === btn));
    const customInput = document.getElementById('cloud-reorder-custom-days');
    if (customInput) customInput.value = '';
    refresh();
  });
});

function applyCloudCustomReorderDays(raw, clampInput = false) {
  const parsed = parseInt(String(raw || '').trim(), 10);
  if (!Number.isFinite(parsed) || parsed < 1) return;
  const d = Math.max(1, Math.min(90, parsed));
  const customInput = document.getElementById('cloud-reorder-custom-days');
  if (clampInput && customInput) customInput.value = String(d);
  reorderDays = d;
  reorderOrderQtyOverrides.clear();
  document.querySelectorAll('[data-reorder-days]').forEach(b => b.classList.remove('active'));
  refresh();
}

document.getElementById('cloud-reorder-custom-days')?.addEventListener('input', e => {
  clearTimeout(reorderCustomTimer);
  reorderCustomTimer = setTimeout(() => applyCloudCustomReorderDays(e.target.value, false), 260);
});
document.getElementById('cloud-reorder-custom-days')?.addEventListener('change', e => {
  clearTimeout(reorderCustomTimer);
  applyCloudCustomReorderDays(e.target.value, true);
});

document.getElementById('cloud-copy-order-btn')?.addEventListener('click', copyCloudReorderOrder);
document.getElementById('cloud-export-reorder-btn')?.addEventListener('click', exportCloudReorderCsv);
document.getElementById('cloud-template-csv-btn')?.addEventListener('click', downloadCloudTemplateCsv);
document.getElementById('cloud-export-stock-btn')?.addEventListener('click', exportCloudStockCsv);

const csvFileInput = document.getElementById('cloud-csv-file-input');
document.getElementById('cloud-import-reorder-btn')?.addEventListener('click', () => csvFileInput?.click());
document.getElementById('cloud-import-stock-btn')?.addEventListener('click', () => csvFileInput?.click());

csvFileInput?.addEventListener('change', async e => {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const text = await file.text();
    const rows = parseCloudImportRows(text);
    if (!rows.length) {
      showToast('No valid inventory rows found in CSV');
      return;
    }
    openCloudImportModal(file.name, rows);
  } catch (err) {
    showToast('Could not read CSV file');
  }
});

document.querySelectorAll('[data-stock-preset]').forEach(btn => {
  btn.addEventListener('click', () => {
    const deltaEl = document.getElementById('stock-modal-delta');
    if (deltaEl) deltaEl.value = String(btn.getAttribute('data-stock-preset') || '1');
  });
});
document.getElementById('stock-modal-save')?.addEventListener('click', submitStockModal);
document.getElementById('stock-modal-cancel')?.addEventListener('click', () => {
  document.getElementById('stock-modal')?.classList.remove('open');
  activeStockModalItem = null;
});
document.getElementById('import-modal-confirm')?.addEventListener('click', confirmCloudCsvImport);
document.getElementById('import-modal-cancel')?.addEventListener('click', () => {
  document.getElementById('import-modal')?.classList.remove('open');
  pendingImportRows = [];
});
document.getElementById('rows')?.addEventListener('keydown', e => {
  if (currentTab !== 'sales' || (e.key !== 'Enter' && e.key !== ' ')) return;
  const item = e.target.closest('.sale-row');
  if (item) { e.preventDefault(); toggleSaleDetail(item); }
});

document.querySelectorAll('.nav-btn, .desk-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    setActiveTab(btn.dataset.tab || 'sales');
  });
});

const themeToggle = document.getElementById('theme-toggle');
const sunIcon = document.getElementById('theme-icon-sun');
const moonIcon = document.getElementById('theme-icon-moon');

// Suppress transitions during theme swap so colors snap cleanly (better-ui)
function applyTheme(isLight) {
  const blocker = document.createElement('style');
  blocker.textContent = '*,*::before,*::after{transition:none !important}';
  document.head.appendChild(blocker);
  document.documentElement.classList.toggle('light', isLight);
  void document.documentElement.offsetHeight;
  requestAnimationFrame(() => blocker.remove());

  if (sunIcon) sunIcon.style.display = isLight ? 'none' : 'inline-block';
  if (moonIcon) moonIcon.style.display = isLight ? 'inline-block' : 'none';
  localStorage.setItem('techparts_theme', isLight ? 'light' : 'dark');
}

themeToggle?.addEventListener('click', () => {
  const isLight = !document.documentElement.classList.contains('light');
  applyTheme(isLight);
  showToast(isLight ? 'Daylight ledger active' : 'Workbench dark active');
});

const savedTheme = localStorage.getItem('techparts_theme');
if (savedTheme === 'light') applyTheme(true);

window.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    document.getElementById('pair-modal')?.classList.remove('open');
    document.getElementById('stock-modal')?.classList.remove('open');
    document.getElementById('import-modal')?.classList.remove('open');
    activeStockModalItem = null;
    pendingImportRows = [];
    if (pairingTimerInterval) clearInterval(pairingTimerInterval);
  }
});

// Initialize on page load
checkAuthState();
