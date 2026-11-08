import { S } from './state.js';
import { closeModal, confirmModal, escHtml, fmtMoney, formatDateTime, inputModal, openModal, showGate, showToast, showSkeleton, syncAppInert } from './ui.js';
import { loadInventoryTable } from './views/inventory.js';
import { syncAppearanceModal } from './theme.js';
import { loadPosCatalog } from './views/pos.js';

// Session / role state. Token lives in memory + sessionStorage (survives F5,
// dies on tab close). Elevation rides the same storage with a 15-min TTL
// (verified server-side on every privileged call), so a manager session
// restored after F5 stays unlocked until the TTL runs out.
// initialized in state.js: S.sessionToken
// initialized in state.js: S.sessionActor
// initialized in state.js: S.elevationToken
// initialized in state.js: S.elevationExpiresAt
// initialized in state.js: S.loginGateResolve
// initialized in state.js: S.loginGateTarget

export const isStaff = () => S.sessionActor?.type === 'staff';
export const hasElevation = () => !!S.elevationToken && Date.now() < S.elevationExpiresAt;

// Manager Authentication State (client convenience flag; the server decides)
// initialized in state.js: S.isManagerUnlocked
// initialized in state.js: S.pendingPinCallback

export function setElevation(token, expiresAt) {
  S.elevationToken = token || null;
  S.elevationExpiresAt = Number(expiresAt) || 0;
  S.isManagerUnlocked = hasElevation();
  clearTimeout(window._pinLockTimer);
  // Mirror the session token: lives in sessionStorage so an F5 restores it
  // (still 15-min TTL, still verified server-side on every privileged call).
  try {
    if (S.elevationToken) sessionStorage.setItem('pos_elevation', JSON.stringify({ t: S.elevationToken, e: S.elevationExpiresAt }));
    else sessionStorage.removeItem('pos_elevation');
  } catch (_) {}
  if (S.elevationToken) {
    window._pinLockTimer = setTimeout(() => {
      setElevation(null, 0);
      S.costPricesRevealed = false;
      // Re-render so manager-only controls disappear with the elevation.
      if (S.currentTab === 'inventory') loadInventoryTable();
    }, Math.max(0, S.elevationExpiresAt - Date.now()));
  }
}

export function clearSession() {
  S.sessionToken = null;
  S.sessionActor = null;
  S.elevationToken = null;
  S.elevationExpiresAt = 0;
  S.isManagerUnlocked = false;
  S.costPricesRevealed = false;
  clearTimeout(window._pinLockTimer);
  try { sessionStorage.removeItem('pos_session'); sessionStorage.removeItem('pos_elevation'); } catch (_) {}
}

// -------------------------------------------------------------
// SERVER HEALTH PROBE (boot gate)
// -------------------------------------------------------------
// The page can outlive its own backend: the packaged exe self-terminates when
// its kiosk window never heartbeats, and a GUI-subsystem crash shows nothing.
// Without this probe the user was parked at the login gate with every action
// silently failing; now the failure has a face and a retry.
function fetchWithTimeout(url, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { signal: ctrl.signal }).finally(() => clearTimeout(t));
}

export async function probeServer() {
  const overlay = document.getElementById('server-down-overlay');
  const detail = document.getElementById('server-down-detail');
  const show = msg => {
    if (detail && msg) detail.textContent = msg;
    if (overlay) showGate('server-down-overlay');
  };
  const hide = () => {
    overlay?.classList.add('hidden');
    syncAppInert();
  };
  try {
    const res = await fetchWithTimeout('/api/license/status', 5000);
    if (res.status === 403) {
      // Static files are ungated but /api/* enforces a localhost Host/Origin
      // gate: opening the page via the machine name or LAN IP loads fine and
      // then fails on every API call. Name the actual mistake.
      show(`The server refused this address (localhost-only gate). Reopen the app via http://localhost:${window.location.port || '3000'}.`);
      return false;
    }
    if (!res.ok) {
      show(`The POS server answered with HTTP ${res.status}. Restart TechPartsPOS if this persists.`);
      return false;
    }
    hide();
    return true;
  } catch (_) {
    show('The POS server is not answering. Start TechPartsPOS.exe (or start.bat) and try again.');
    return false;
  }
}

// -------------------------------------------------------------
// LOGIN GATE ("Who's on shift?")
// -------------------------------------------------------------
export async function initSessionGate() {
  if (S.sessionToken) {
    try {
      const res = await fetch('/api/auth/session');
      if (res.ok) {
        const data = await res.json();
        S.sessionActor = data.actor;
        hideLoginGate();
        applyRoleVisibility();
        return;
      }
    } catch (_) {}
    clearSession();
  }
  // Block app init (and the app itself) until someone logs in.
  await new Promise(resolve => { S.loginGateResolve = resolve; renderLoginGate(); });
}

// initialized in state.js: S.loginGatePickerInited
export function initLoginGateListeners() {
  if (S.loginGatePickerInited) return;
  const rolePicker = document.getElementById('login-gate-role-picker');
  if (!rolePicker) return;
  S.loginGatePickerInited = true;
  rolePicker.addEventListener('click', e => {
    const manualBtn = e.target.closest('[data-login-manual]');
    if (manualBtn) {
      loginGatePick(null, '', true);
      return;
    }
    const roleBtn = e.target.closest('[data-login-role]');
    if (roleBtn) {
      const role = roleBtn.dataset.loginRole;
      // Manager role: no staffId, goes straight to PIN
      if (role === 'manager') {
        loginGatePick(null, 'Manager', false);
      } else if (role === 'cashier') {
        // Cashier: pick a known staff account (PIN only) from this machine's roster
        renderCashierStaffPicker();
      }
      return;
    }
  });

  // Cashier staff picker: roster buttons carry data-login-staff/data-login-name,
  // read via .dataset like the role buttons above.
  // Also handles the empty-state "Log in as Manager" button (data-login-role="manager-then-staff").
  document.getElementById('login-gate-staff-picker')?.addEventListener('click', e => {
    const roleBtn = e.target.closest('[data-login-role]');
    if (roleBtn && roleBtn.dataset.loginRole === 'manager-then-staff') {
      // Close picker, go to manager PIN entry
      loginGatePick(null, 'Manager', false);
      return;
    }
    const btn = e.target.closest('[data-login-staff]');
    if (!btn) return;
    loginGatePick(btn.dataset.loginStaff === '' ? null : Number(btn.dataset.loginStaff), btn.dataset.loginName, false);
  });
}

// The roster cache is the only pre-login staff source: GET /api/auth/staff
// needs a session, and the login gate runs before anyone has one.
export function renderCashierStaffPicker() {
  let roster = [];
  try { roster = JSON.parse(localStorage.getItem('pos_staff_roster') || '[]'); } catch (_) {}
  const list = document.getElementById('cashier-staff-list');
  if (!list) return;

  document.getElementById('login-gate-role-picker')?.classList.add('hidden');
  document.getElementById('login-gate-staff-picker')?.classList.remove('hidden');
  document.getElementById('login-gate-error')?.classList.add('hidden');

  if (!Array.isArray(roster) || roster.length === 0) {
    list.innerHTML = `
      <div class="p-3 rounded-lg border border-amber-500/30 bg-amber-500/10 text-xs text-center space-y-2">
        <p class="text-amber-300 font-medium"><i class="ph ph-warning-circle mr-1"></i>No cashier accounts found yet.</p>
        <p class="text-slate-400">Log in as Manager to add cashiers in Settings → Cashiers.</p>
        <button type="button" class="gate__btn gate__btn--quiet w-full" data-login-role="manager-then-staff">Log in as Manager</button>
      </div>`;
  } else {
    list.innerHTML = roster.map(s => `
      <button type="button" class="gate__btn gate__btn--quiet" data-login-staff="${s.id ?? ''}" data-login-name="${escHtml(s.name)}">
        ${escHtml(s.name)}
      </button>`).join('');
  }
}

export async function renderLoginGate(subText) {
  const gate = document.getElementById('login-gate');
  if (!gate) return;
  const sub = document.getElementById('login-gate-sub');
  if (sub && subText) sub.textContent = subText;
  showGate('login-gate');

  initLoginGateListeners();

  S.loginGateTarget = null;
  const rolePicker = document.getElementById('login-gate-role-picker');
  const pinRow = document.getElementById('login-gate-pin-row');
  pinRow?.classList.add('hidden');
  rolePicker?.classList.remove('hidden');

  // BUG FIX: Clear any previous error when re-rendering the gate
  const errEl = document.getElementById('login-gate-error');
  if (errEl) errEl.classList.add('hidden');

}

// Delegated listener: names never enter a JS string context (inline onclick
// attributes are HTML-entity-decoded before JS parsing — quoted names broke
// the button, crafted names ran arbitrary code).
export function loginGatePick(staffId, name, isManual = false) {
  S.loginGateTarget = { staffId, name, isManual };
  document.getElementById('login-gate-role-picker')?.classList.add('hidden');
  document.getElementById('login-gate-staff-picker')?.classList.add('hidden');
  const pinRow = document.getElementById('login-gate-pin-row');
  pinRow?.classList.remove('hidden');
  const who = document.getElementById('login-gate-who');
  const nameInput = document.getElementById('login-gate-name-input');

  // BUG FIX: Clear error and old values before showing PIN row
  const err = document.getElementById('login-gate-error');
  if (err) err.classList.add('hidden');

  if (isManual) {
    if (who) who.textContent = 'Staff Login';
    if (nameInput) {
      nameInput.classList.remove('hidden');
      nameInput.value = '';
      // BUG FIX: Increased delay to ensure DOM is ready
      setTimeout(() => nameInput.focus(), 100);
    }
  } else {
    if (who) who.textContent = `PIN for ${name}`;
    if (nameInput) nameInput.classList.add('hidden');
    const input = document.getElementById('login-gate-pin');
    if (input) { input.value = ''; setTimeout(() => input.focus(), 100); }
  }
}

export function loginGateBack() {
  const pinInput = document.getElementById('login-gate-pin');
  if (pinInput) pinInput.value = '';
  const nameInput = document.getElementById('login-gate-name-input');
  if (nameInput) nameInput.value = '';
  S.loginGateTarget = null;

  // BUG FIX: Clear error when going back
  const err = document.getElementById('login-gate-error');
  if (err) err.classList.add('hidden');

  document.getElementById('login-gate-pin-row')?.classList.add('hidden');
  document.getElementById('login-gate-staff-picker')?.classList.add('hidden');
  document.getElementById('login-gate-role-picker')?.classList.remove('hidden');
}

let isLoginSubmitting = false;

export async function submitLoginPin() {
  if (isLoginSubmitting || !S.loginGateTarget) return;
  const inputEl = document.getElementById('login-gate-pin');
  const errorEl = document.getElementById('login-gate-error');
  const nameField = document.getElementById('login-gate-name-input');
  inputEl?.removeAttribute('aria-invalid');
  nameField?.removeAttribute('aria-invalid');
  const fail = (msg, fld) => {
    if (errorEl) { errorEl.textContent = msg; errorEl.classList.remove('hidden'); }
    (fld || inputEl)?.setAttribute('aria-invalid', 'true');
  };

  let staffName = null;
  if (S.loginGateTarget.isManual) {
    staffName = (document.getElementById('login-gate-name-input')?.value || '').trim();
    if (!staffName) return fail('Please enter your staff name', nameField);
  }

  const pin = (inputEl?.value || '').trim();
  if (!pin) return fail('Please enter the PIN');

  try {
    isLoginSubmitting = true;
    const payload = S.loginGateTarget.isManual
      ? { staffName, pin }
      : (S.loginGateTarget.staffId !== null ? { staffId: S.loginGateTarget.staffId, pin } : { pin });
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      // Name the failure mode instead of a blanket "Login failed": a 400 with
      // a message is server-surfaced (lockout, malformed body); a 403 is the
      // localhost Host/Origin gate, which means the page was opened by the
      // wrong address — a wrong PIN has nothing to do with it.
      if (res.status === 403) {
        return fail(`${data.error || 'Request blocked'} — open the app via http://localhost:${window.location.port || '3000'}`);
      }
      return fail(data.error || 'Login failed');
    }
    if (!data.token) return fail('Incorrect PIN');

    S.sessionToken = data.token;
    try { sessionStorage.setItem('pos_session', S.sessionToken); } catch (_) {}
    S.sessionActor = data.actor;
    if (data.elevationToken) setElevation(data.elevationToken, data.expiresAt); // manager login = fresh PIN entry
    if (inputEl) inputEl.value = '';

    // Remember staff who have used this machine — the login gate's cashier
    // picker reads this cache (pre-login, the roster API needs a session).
    if (data.actor?.type === 'staff' && data.actor.id && data.actor.name) {
      try {
        const cached = JSON.parse(localStorage.getItem('pos_staff_roster') || '[]');
        if (!cached.some(s => s.id === data.actor.id)) {
          cached.push({ id: data.actor.id, name: data.actor.name });
          localStorage.setItem('pos_staff_roster', JSON.stringify(cached));
        }
      } catch (_) {}
    }

    hideLoginGate();
    applyRoleVisibility();
    const resolve = S.loginGateResolve;
    S.loginGateResolve = null;
    if (resolve) {
      resolve(); // first boot: app init continues under the session
    } else {
      // Session died mid-run (PIN changed elsewhere): views hold stale data.
      window.location.reload();
    }
    showToast(`Logged in as ${data.actor.name}`, 'info');
  } catch (err) {
    // TypeError is what fetch throws for network-level failure (refused /
    // unreachable / aborted). Say the server is down — do not let the user
    // believe their PIN was wrong and burn the lockout retrying.
    if (err instanceof TypeError) {
      fail('Cannot reach the POS server — it may have stopped. Restart TechPartsPOS.');
    } else {
      fail(`Login failed: ${err?.message || 'unknown error'}`);
    }
  } finally {
    isLoginSubmitting = false;
  }
}

export function hideLoginGate() {
  document.getElementById('login-gate')?.classList.add('hidden');
  syncAppInert();
}

export async function doLogout() {
  try { await fetch('/api/auth/logout', { method: 'POST' }); } catch (_) {}
  clearSession();
  window.location.reload(); // cleanest: every view re-renders behind the gate
}

// Hide (not just re-prompt) manager-only controls for staff sessions.
export function applyRoleVisibility() {
  document.querySelectorAll('[data-manager-only]').forEach(el => {
    el.classList.toggle('hidden', isStaff());
  });
  const shift = document.getElementById('store-card-shift');
  if (shift && S.sessionActor) {
    shift.textContent = `${S.sessionActor.name} · on shift`;
    fetch('/api/shifts').then(r => r.json()).then(shifts => {
      const open = (Array.isArray(shifts) ? shifts : []).find(s => s.status === 'open');
      if (shift) {
        if (open) shift.textContent = `Drawer #${open.id} OPEN · ${open.staff_name || S.sessionActor.name}`;
        else shift.textContent = `Drawer CLOSED · ${S.sessionActor.name}`;
      }
    }).catch(() => {});
  }
}

// -------------------------------------------------------------
// SHOP SETTINGS & GCASH QR
// -------------------------------------------------------------
export async function loadShopSettings() {
  try {
    const res = await fetch('/api/settings');
    if (res.ok) {
      const data = await res.json();
      S.shopSettings = { ...S.shopSettings, ...data };
      S.shopSettingsUnavailable = false;
      hideSettingsBanner();
      updateGcashUiDisplays();
      enforcePinSetup();
      return;
    }
  } catch (err) {
    console.error('Failed to load shop settings:', err);
  }
  // Fetch failed or answered non-ok: the counter is running on the built-in
  // placeholder identity, so say so persistently (a 3s toast dies, a demo
  // GCash number on a receipt does not).
  S.shopSettingsUnavailable = true;
  showSettingsBanner();
}

function showSettingsBanner() {
  let el = document.getElementById('settings-banner');
  if (!el) {
    el = document.createElement('div');
    el.id = 'settings-banner';
    el.setAttribute('role', 'alert');
    el.className = 'settings-banner';
    el.textContent = 'Shop settings could not be loaded. Receipts would print placeholder shop details. Fix the connection or check pos-server.log, then reload.';
    document.body.prepend(el);
  }
  el.classList.remove('hidden');
}

function hideSettingsBanner() {
  document.getElementById('settings-banner')?.classList.add('hidden');
}

export function updateShopBrandUi() {
  const brandName = S.shopSettings.gcash_name || 'TechParts POS';
  const brandNumber = S.shopSettings.gcash_number || '09xx-xxx-xxxx';

  const railName = document.getElementById('rail-shop-name') || document.querySelector('.rail-word');
  if (railName) railName.textContent = brandName;

  document.title = S.shopSettings.gcash_name ? `${S.shopSettings.gcash_name} — POS` : 'TechParts POS — repair counter';

  const loginGateShop = document.getElementById('login-gate-shop-name');
  if (loginGateShop) {
    loginGateShop.textContent = S.shopSettings.gcash_name || '';
    loginGateShop.classList.toggle('hidden', !S.shopSettings.gcash_name);
  }

  ['pos-gcash-shop-name', 'modal-gcash-name'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = S.shopSettings.gcash_name || 'GCash Payment';
  });
  ['pos-gcash-shop-number', 'modal-gcash-number'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = brandNumber;
  });

  const qrSrc = S.shopSettings.gcash_qr_url || generateFallbackQrSvg();
  const thumbImg = document.getElementById('pos-gcash-qr-thumb');
  const largeImg = document.getElementById('large-gcash-qr-img');
  if (thumbImg) thumbImg.src = qrSrc;
  if (largeImg) largeImg.src = qrSrc;

  // Sync settings inputs
  const inputs = {
    'settings-gcash-name': S.shopSettings.gcash_name,
    'settings-owner-name': S.shopSettings.owner_name,
    'settings-shop-address': S.shopSettings.shop_address,
    'settings-gcash-number': S.shopSettings.gcash_number,
    'settings-gcash-qr': S.shopSettings.gcash_qr_url,
    'settings-footer-note': S.shopSettings.shop_footer_note,
    'settings-warranty-days': S.shopSettings.warranty_days,
    'settings-warranty-policy': S.shopSettings.warranty_policy_text,
    'settings-paper-width': S.shopSettings.receipt_paper_width || '80mm',
    'settings-template': S.shopSettings.receipt_template || 'standard',
    'settings-item-rows': S.shopSettings.receipt_item_rows || 'auto',
    'settings-sync-url': S.shopSettings.sync_url || DEFAULT_CLOUD_URL,
    'settings-settle-threshold': S.shopSettings.settle_elevation_threshold,
    'settings-shift-variance': S.shopSettings.shift_variance_threshold,
    'settings-default-retail-markup': S.shopSettings.default_retail_markup_pct ?? '50',
    'settings-default-wholesale-markup': S.shopSettings.default_wholesale_markup_pct ?? '20'
  };
  for (const [id, val] of Object.entries(inputs)) {
    const el = document.getElementById(id);
    if (el && typeof val !== 'undefined') el.value = val || '';
  }
  syncQrStatusUi(S.shopSettings.gcash_qr_url);
  syncCloudUi();
}

export const DEFAULT_CLOUD_URL = 'https://repairsync.bot-keep.xyz';

export function syncCloudUi() {
  const isConnected = Boolean(S.shopSettings.sync_url && S.shopSettings.sync_token_configured);
  const badge = document.getElementById('settings-sync-status-badge');
  if (badge) {
    badge.textContent = isConnected ? 'Connected' : 'Not connected';
    badge.className = isConnected
      ? 'px-2 py-0.5 rounded text-xs font-mono badge-emerald'
      : 'px-2 py-0.5 rounded text-xs font-mono border border-[var(--line)] bg-[var(--surface-2)] text-[var(--txt-3)]';
  }
  const disconnectBtn = document.getElementById('btn-disconnect-cloud');
  if (disconnectBtn) disconnectBtn.classList.toggle('hidden', !isConnected);

  const bannerBadge = document.getElementById('dash-cloud-badge');
  if (bannerBadge) {
    bannerBadge.textContent = isConnected ? 'Connected' : 'Remote Access';
    bannerBadge.className = isConnected
      ? 'px-1.5 py-0.2 rounded text-[10px] font-mono badge-emerald'
      : 'px-1.5 py-0.2 rounded text-[10px] font-mono border border-[var(--line)] bg-[var(--surface-3)] text-[var(--txt-3)]';
  }
  const bannerText = document.getElementById('dash-cloud-text');
  if (bannerText) {
    bannerText.innerHTML = isConnected
      ? 'Real-time telemetry active. Counter sales and register totals stream live to <a href="https://repairsync.bot-keep.xyz/" target="_blank" rel="noopener noreferrer" class="underline underline-offset-2 font-mono text-[var(--txt)]">repairsync.bot-keep.xyz</a>.'
      : 'View live store sales and cash drawer from your phone anytime at <a href="https://repairsync.bot-keep.xyz/" target="_blank" rel="noopener noreferrer" class="underline underline-offset-2 font-mono text-[var(--txt)]">repairsync.bot-keep.xyz</a>.';
  }
  const btnLabel = document.getElementById('dash-cloud-btn-label');
  if (btnLabel) {
    btnLabel.textContent = isConnected ? 'Manage' : 'Pair Phone';
  }
  const localUrlEl = document.getElementById('local-report-url');
  if (localUrlEl && typeof fetch === 'function') {
    fetch('/api/sync/status').then(r => r.ok ? r.json() : null).then(d => {
      if (d && d.lan_report_url) {
        localUrlEl.textContent = d.lan_report_url.replace(/^https?:\/\//, '');
        localUrlEl.title = d.lan_report_url;
      }
    }).catch(() => {});
  }
}

function syncQrStatusUi(qrVal) {
  const hasQr = Boolean((qrVal || '').trim());
  const statusEl = document.getElementById('settings-qr-status');
  if (statusEl) statusEl.textContent = hasQr ? 'Custom QR image active.' : 'No custom QR uploaded.';
  const clearBtn = document.getElementById('settings-qr-clear');
  if (clearBtn) clearBtn.classList.toggle('hidden', !hasQr);
}

export function clearQrImage() {
  const qrInput = document.getElementById('settings-gcash-qr');
  if (qrInput) qrInput.value = '';
  const fileInput = document.getElementById('settings-qr-file');
  if (fileInput) fileInput.value = '';
  const preview = document.getElementById('settings-qr-preview');
  if (preview) preview.src = generateFallbackQrSvg();
  syncQrStatusUi('');
}

export function updateGcashUiDisplays() {
  updateShopBrandUi();
}

export function generateFallbackQrSvg() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200"><rect width="200" height="200" fill="#1e293b" rx="16"/><text x="100" y="94" fill="#94a3b8" font-size="15" font-weight="bold" font-family="sans-serif" text-anchor="middle">No GCash QR</text><text x="100" y="116" fill="#64748b" font-size="12" font-family="sans-serif" text-anchor="middle">Upload one in Settings</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

export function openQrModal() {
  const total = document.getElementById('pos-total')?.textContent || '₱0.00';
  const amountEl = document.getElementById('modal-gcash-amount');
  if (amountEl) amountEl.textContent = total;
  openModal('modal-gcash-qr');
}

// -------------------------------------------------------------
// SETTINGS MODAL — one modal, five tabs (Store · Printing ·
// Appearance · Security · Data), gated by the manager PIN.
// -------------------------------------------------------------
export function switchSettingsTab(tab) {
  document.querySelectorAll('.settings-tab').forEach(b => {
    const on = b.dataset.tab === tab;
    b.classList.toggle('is-active', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  document.querySelectorAll('[data-settings-pane]').forEach(p =>
    p.classList.toggle('hidden', p.dataset.settingsPane !== tab));
  if (tab === 'data') renderLicenseCard();
  if (tab === 'staff') renderStaffPanel();
}

// Read-only license card in the Data tab. Activation stays in its own overlay.
export async function renderLicenseCard() {
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  try {
    const res = await fetch('/api/license/status');
    const data = await res.json();
    set('license-card-machine-id', data.machine_id || '-');
    set('license-card-status', licenseChipText(data));
    set('license-card-customer', data.activated ? (data.customer_name || 'This workstation') : 'Not activated yet');
  } catch (_) {
    set('license-card-status', 'Could not read the license status');
  }
}

// The queue picker in Settings → Printing. An empty dropdown would otherwise
// leave the operator unable to tell "no printers on this machine" from "the
// lookup broke", so all three states get their own copy, and a failed lookup
// carries the server's clipped reason rather than a generic one.
export async function loadPrinters() {
  const select = document.getElementById('settings-printer');
  const note = document.getElementById('settings-printer-note');
  if (!select || !note) return;
  select.disabled = true;
  select.innerHTML = '<option value="">Detecting printers...</option>';
  let printers = [];
  try {
    const res = await fetch('/api/printers');
    // A 502 body is the one line that says WHY (dead spooler, clipped helper
    // stderr); "printer lookup failed (502)" would throw it away.
    let data = null;
    try { data = await res.json(); } catch (_) {}
    if (!res.ok) throw new Error(data?.error || `Printer lookup failed (HTTP ${res.status}).`);
    printers = data?.printers || [];
  } catch (err) {
    // TypeError is what fetch throws for a network-level failure, same rule
    // as submitLoginPin: name the server being down instead of echoing
    // "Failed to fetch".
    note.textContent = err instanceof TypeError
      ? 'Could not reach the POS server, so the printer list is unavailable.'
      : err.message;
    select.innerHTML = '<option value="">Printer list unavailable</option>';
    return;
  }
  if (!printers.length) {
    note.textContent = 'No printers found. Check the cable, then Refresh.';
    select.innerHTML = '<option value="">No printers found</option>';
    return;
  }
  note.textContent = '';
  const saved = S.shopSettings.printer_name || '';
  // A saved name that matches no row leaves every option unmarked, and an
  // unmarked select shows whatever WMI returned first, which the next unrelated
  // settings save then persists silently: a real name differs from the stored
  // value, so it passes the "only send it when it changed" guard. The stored
  // value is unusable in two cases, and both get the fallback pick below: a
  // shop that never configured a queue (saved is '') and one whose stored queue
  // was uninstalled. Only the second earns the note at the bottom, because an
  // empty saved name is not a queue that went missing.
  const usable = printers.some((p) => p.name === saved);
  const missing = saved && !usable;
  // Win32_Printer.WorkOffline on a USB virtual port tracks device sleep, not
  // printer health: this machine has been seen reporting every queue offline at
  // once while its only working printer printed fine. The tag gates nothing, so
  // it is shown only when it discriminates, and never as a claim that the one
  // queue the shop can print on is broken. Offline queues still stay listed.
  const anyOnline = printers.some((p) => !p.offline);
  // Without a usable saved queue the picker preselects the queue the server
  // itself would target. That ordering is defaultPrinter() in src/printer.js
  // (online default, then any online queue, then the offline default); the
  // module is CommonJS and this file is browser ESM with no bundler, so the
  // four lines are duplicated rather than shared, and tests/ui-fixes.test.js
  // asserts them in the same sequence in both sources to catch a drift.
  // The trailing printers[0] is picker-only: defaultPrinter answers null when
  // every queue is offline and none is the default, and the print route errors,
  // but a select has to show something.
  const fallback = usable
    ? ''
    : (printers.find((p) => p.isDefault && !p.offline)
      || printers.find((p) => !p.offline)
      || printers.find((p) => p.isDefault)
      || printers[0]).name;
  // Queue names are user-chosen strings on this machine, so every insertion
  // goes through escHtml, value attribute and label alike.
  select.innerHTML = printers.map((p) => {
    const tags = [p.port, p.isDefault && 'default', anyOnline && p.offline && 'offline'].filter(Boolean).join(', ');
    // A vanished saved queue is named in the note below; either way exactly one
    // option comes back marked, so nothing is left to the browser's ordering.
    const chosen = usable ? p.name === saved : p.name === fallback;
    return `<option value="${escHtml(p.name)}"${chosen ? ' selected' : ''}>${escHtml(p.name)}${tags ? ` (${escHtml(tags)})` : ''}</option>`;
  }).join('');
  select.disabled = false;
  if (missing) note.textContent = `Saved printer "${saved}" is not installed here. Pick one and save.`;
}

// Paper preview in Settings > Printing: the server renders the same slip
// builder the print queue feeds to encode(), so the preview cannot drift from
// what the roll outputs. Re-fetched whenever template, width or item rows move.
export async function loadReceiptPreview() {
  const pre = document.getElementById('settings-receipt-preview');
  if (!pre) return;
  const body = {
    template: document.getElementById('settings-template')?.value || 'standard',
    item_rows: document.getElementById('settings-item-rows')?.value || 'auto',
    paper_width: document.getElementById('settings-paper-width')?.value || '80mm',
  };
  try {
    const res = await fetch('/api/receipt/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'Preview failed');
    }
    const { lines } = await res.json();
    // Every line is one block span, and no '\n' joins them: a display:block
    // element already breaks the line, so joining with a newline rendered
    // centered and wide rows with blank lines the roll never prints. Empty
    // lines keep their height through a non-breaking space.
    pre.innerHTML = (lines || []).map((l) => {
      const cls = `rp-l${l.centered ? ' rp-c' : ''}${l.wide ? ' rp-w' : ''}`;
      return `<span class="${cls}">${escHtml(l.text) || '\u00a0'}</span>`;
    }).join('');
  } catch (err) {
    pre.textContent = err.message;
  }
}

export function openSettingsModal(targetTab = 'store') {
  if (!S.isManagerUnlocked) {
    requireManagerPin('Enter manager PIN to open Settings', () => {
      openSettingsModal(targetTab);
    });
    return;
  }

  switchSettingsTab(targetTab);
  updateShopBrandUi();
  loadReceiptPreview();

  // Native ESC/POS goes to the queue named in Settings whatever opened the
  // window, so the launcher's #kiosk=1 marker (per-tab sessionStorage) now only
  // decides what the browser fallback looks like: with --kiosk-printing the
  // fallback prints with no dialog, in a window opened by hand it shows one.
  // "Print test receipt" covers the queue itself.
  const kioskStatus = document.getElementById('kiosk-status');
  if (kioskStatus) {
    kioskStatus.textContent = sessionStorage.getItem('pos_kiosk') === '1'
      ? 'Active: slips print to the queue you picked in Settings. If a job ever falls back to the browser, this window prints without a dialog.'
      : 'Not active: slips still print to the queue you picked in Settings, but a browser fallback here would show the print dialog. Reopen the POS from its desktop icon (or start.bat) to print without it.';
  }

  const syncTokenInput = document.getElementById('settings-sync-token');
  if (syncTokenInput) {
    syncTokenInput.value = '';
    syncTokenInput.placeholder = S.shopSettings.sync_token_configured
      ? 'Configured - enter a replacement only'
      : 'Leave blank unless replacing manually';
  }
  const syncUrlInput = document.getElementById('settings-sync-url');
  if (syncUrlInput) {
    syncUrlInput.value = S.shopSettings.sync_url || DEFAULT_CLOUD_URL;
  }
  syncCloudUi();
  const pairCodeInput = document.getElementById('settings-pair-code');
  if (pairCodeInput) pairCodeInput.value = '';
  if (document.getElementById('settings-current-pin')) document.getElementById('settings-current-pin').value = '';
  if (document.getElementById('settings-new-pin')) document.getElementById('settings-new-pin').value = '';
  if (document.getElementById('settings-pin-msg')) document.getElementById('settings-pin-msg').classList.add('hidden');

  const preview = document.getElementById('settings-qr-preview');
  if (preview) {
    preview.src = S.shopSettings.gcash_qr_url || generateFallbackQrSvg();
  }

  // Auto-print seg mirrors the shared key (the receipt slip's checkbox is the
  // other door to the same switch). Mirrors pos.js autoPrintEnabled().
  const autoprintOn = localStorage.getItem('techparts_autoprint') !== '0';
  document.querySelectorAll('[data-action="autoprint-set"]').forEach(b =>
    b.classList.toggle('is-active', (b.dataset.on === '1') === autoprintOn));

  // Re-enumerate the queues on every open: USB printers come and go between
  // the last save and this visit, and the read is cheap.
  loadPrinters();

  syncAppearanceModal();
  // renderStaffPanel() is now called by switchSettingsTab when tab === 'staff'.
  // Still call it eagerly here if opening to a non-staff tab so the list is
  // warm when the user switches to Cashiers manually.
  if (targetTab !== 'staff') renderStaffPanel();
  const setupBanner = document.getElementById('settings-pin-setup-banner');
  if (setupBanner) {
    setupBanner.classList.toggle('hidden', !S.shopSettings.pin_change_required);
  }
  openModal('modal-settings');
}

export function handleQrFileUpload(event) {
  const file = event.target.files?.[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = function (e) {
    const dataUrl = e.target.result;
    const qrInput = document.getElementById('settings-gcash-qr');
    if (qrInput) qrInput.value = dataUrl;
    const preview = document.getElementById('settings-qr-preview');
    if (preview) preview.src = dataUrl;
    syncQrStatusUi(dataUrl);
  };
  reader.readAsDataURL(file);
}

export function cleanQrPath(p) {
  return (p || '').trim().replace(/^["']|["']$/g, '');
}

export function onSettingsQrPathInput() {
  const raw = document.getElementById('settings-gcash-qr')?.value || '';
  const cleaned = cleanQrPath(raw);
  const preview = document.getElementById('settings-qr-preview');
  if (preview) {
    preview.src = cleaned || generateFallbackQrSvg();
  }
  syncQrStatusUi(cleaned);
}

export async function saveShopSettings(e) {
  e.preventDefault();
  const gcash_name = document.getElementById('settings-gcash-name').value.trim();
  const owner_name = (document.getElementById('settings-owner-name')?.value || '').trim();
  const shop_address = (document.getElementById('settings-shop-address')?.value || '').trim();
  const gcash_number = document.getElementById('settings-gcash-number').value.trim();
  let gcash_qr_url = document.getElementById('settings-gcash-qr').value.trim();
  gcash_qr_url = cleanQrPath(gcash_qr_url);
  const receipt_paper_width = document.getElementById('settings-paper-width').value;
  const receipt_template = document.getElementById('settings-template')?.value || 'standard';
  const receipt_item_rows = document.getElementById('settings-item-rows')?.value || 'auto';
  // Reads '' while the picker is loading, failed or found nothing. The spread
  // below drops the field entirely unless the operator actually moved the
  // selection, so an unrelated save never pays for a queue enumeration.
  const printer_name = document.getElementById('settings-printer')?.value || '';
  const warranty_days = document.getElementById('settings-warranty-days').value.trim() || '7';
  const settle_elevation_threshold = document.getElementById('settings-settle-threshold').value.trim() || '500';
  // The exceptions report's materiality line had a code path and no screen;
  // this is its reader, so the value is no longer API-only.
  const shift_variance_threshold = document.getElementById('settings-shift-variance')?.value.trim() || '50';
  const default_retail_markup_pct = document.getElementById('settings-default-retail-markup')?.value.trim() || '50';
  const default_wholesale_markup_pct = document.getElementById('settings-default-wholesale-markup')?.value.trim() || '20';
  const warranty_policy_text = document.getElementById('settings-warranty-policy').value.trim();
  const shop_footer_note = document.getElementById('settings-footer-note').value.trim();
  const sync_url = document.getElementById('settings-sync-url')?.value.trim() || '';
  const syncTokenReplacement = document.getElementById('settings-sync-token')?.value.trim() || '';

  try {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        gcash_name,
        owner_name,
        shop_address,
        gcash_number,
        gcash_qr_url,
        receipt_paper_width,
        receipt_template,
        receipt_item_rows,
        warranty_days,
        settle_elevation_threshold,
        shift_variance_threshold,
        default_retail_markup_pct,
        default_wholesale_markup_pct,
        warranty_policy_text,
        shop_footer_note,
        sync_url,
        ...(syncTokenReplacement ? { sync_token: syncTokenReplacement } : {}),
        // An unchanged queue name and a never-loaded picker both leave the field
        // off the wire. The server validates printer_name by enumerating the
        // queues again, and that read can fail or burn its 15 s timeout, which
        // would answer 400/502 and skip this whole settings transaction over an
        // edit nobody made to the printer. S.shopSettings is replaced by every
        // settings response, so the stored side of the comparison stays current.
        ...(printer_name && printer_name !== (S.shopSettings.printer_name || '') ? { printer_name } : {})
      })
    });

    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.error || 'Failed to update settings');
    }

    S.shopSettings = await res.json();
    updateGcashUiDisplays();
    enforcePinSetup();
    closeModal('modal-settings');
    showToast('Settings saved', 'success');
  } catch (err) {
    showToast(`Error saving settings: ${err.message}`, 'error');
  }
}

// Cloud register pairing with 6-digit code (Option A)
export async function pairCloudWithCode() {
  const syncUrlInput = document.getElementById('settings-sync-url');
  const codeInput = document.getElementById('settings-pair-code');
  const pairBtn = document.getElementById('btn-pair-cloud');

  // The URL field is a managed, readonly link to the vendor cloud: an empty
  // value falls back to DEFAULT_CLOUD_URL, so there is no empty-URL refusal
  // to reach anymore. The 6-digit code is the only user input here.
  const sync_url = syncUrlInput?.value.trim() || DEFAULT_CLOUD_URL;
  const code = codeInput?.value.trim().replace(/\s+/g, '') || '';

  if (!/^\d{6}$/.test(code)) {
    showToast('Enter a valid 6-digit pairing code', 'error');
    codeInput?.focus();
    return;
  }

  const originalBtnHtml = pairBtn ? pairBtn.innerHTML : '';
  if (pairBtn) {
    pairBtn.disabled = true;
    pairBtn.innerHTML = '<i class="ph ph-spinner animate-spin w-3.5 h-3.5"></i> Connecting...';
  }

  try {
    const res = await fetch('/api/settings/pair-cloud', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sync_url, code })
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || 'Pairing failed');
    }

    S.shopSettings = data;
    if (codeInput) codeInput.value = '';
    const tokenInput = document.getElementById('settings-sync-token');
    if (tokenInput) {
      tokenInput.placeholder = 'Configured via 6-digit code';
    }
    syncCloudUi();
    showToast('Register paired with Cloud successfully!', 'success');
  } catch (err) {
    showToast(`Pairing failed: ${err.message}`, 'error');
  } finally {
    if (pairBtn) {
      pairBtn.disabled = false;
      pairBtn.innerHTML = originalBtnHtml;
    }
  }
}

export async function disconnectCloud() {
  const ok = await confirmModal('Disconnect this workstation from Manager Live View? Real-time sync will stop.', {
    title: 'Disconnect Cloud Sync?',
    yes: 'Disconnect',
    danger: true
  });
  if (!ok) return;

  try {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sync_url: '', sync_token: '' })
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'Failed to disconnect');
    }
    S.shopSettings = await res.json();
    updateShopBrandUi();
    showToast('Cloud sync disconnected', 'info');
  } catch (err) {
    showToast(`Error: ${err.message}`, 'error');
  }
}

// Security tab's own action — the PIN change no longer rides the settings save.
export async function submitPinChange() {
  const currentPin = document.getElementById('settings-current-pin')?.value.trim();
  const newPin = document.getElementById('settings-new-pin')?.value.trim();
  const msg = document.getElementById('settings-pin-msg');
  const fail = m => { if (msg) { msg.textContent = m; msg.classList.remove('hidden'); } };
  if (!newPin) return fail('Enter a new PIN to change it.');

  try {
    const res = await fetch('/api/auth/change-pin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ old_pin: currentPin, new_pin: newPin })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      // Elevation can lapse while the modal is open — re-prompt, don't dead-end.
      if (res.status === 403 && (data.code === 'elevation_required' || /manager/i.test(data.error || ''))) {
        requireManagerPin('Enter manager PIN to change the PIN', () => submitPinChange());
        return;
      }
      return fail(data.error || 'Could not change the PIN.');
    }

    // The change invalidated this session and elevation — swap in the fresh
    // ones the server handed back, or the manager self-logs-out.
    if (data.token) { S.sessionToken = data.token; try { sessionStorage.setItem('pos_session', S.sessionToken); } catch (_) {} }
    if (data.elevationToken) setElevation(data.elevationToken, data.expiresAt);
    document.getElementById('settings-current-pin').value = '';
    document.getElementById('settings-new-pin').value = '';
    if (msg) msg.classList.add('hidden');
    showToast('Manager PIN updated', 'success');
  } catch (err) {
    fail('Could not reach the server.');
  }
}

// -------------------------------------------------------------
// LICENSE ACTIVATION & VERIFICATION
// -------------------------------------------------------------
// Tone per status. Empty = draft-chip's default warn tone (trial).
// ponytail: inline styles instead of new CSS classes — five one-off tones.
const LICENSE_CHIP_STYLES = {
  trial: '',
  monthly: 'color:var(--info);border-color:color-mix(in oklab,var(--info) 34%,transparent)',
  yearly: 'color:var(--pos);border-color:color-mix(in oklab,var(--pos) 34%,transparent)',
  lifetime: 'color:var(--txt-2);border-color:color-mix(in oklab,var(--txt-2) 30%,transparent)',
  expired: 'color:var(--danger);border-color:color-mix(in oklab,var(--danger) 34%,transparent)'
};

export function licenseChipText(data) {
  const days = n => `${n} day${n === 1 ? '' : 's'} left`;
  switch (data.status) {
    case 'monthly': return `Monthly \u00b7 ${days(data.days_left)}`;
    case 'yearly': return `Yearly \u00b7 ${days(data.days_left)}`;
    case 'lifetime': return 'Lifetime license';
    case 'expired': return 'License expired \u2014 activate';
    default: return `Trial: ${days(data.trial_days_left)}`;
  }
}

export function dismissLicenseOverlay() {
  if (S.licenseRequired) return;
  const overlay = document.getElementById('license-overlay');
  if (overlay) overlay.classList.add('hidden');
  syncAppInert();
}

export async function checkLicenseStatus(forceOverlay = false) {
  try {
    const res = await fetch('/api/license/status');
    const data = await res.json();
    const overlay = document.getElementById('license-overlay');
    const machineIdEl = document.getElementById('license-machine-id');

    if (machineIdEl) machineIdEl.textContent = data.machine_id || 'Unknown';

    S.licenseRequired = !!data.license_required;
    // A lifetime license has nothing to activate — a chip click confirms the
    // license instead of reopening the key-paste form. Every other status
    // (trial = activate early, monthly/yearly = renew, expired = locked) has
    // a reason for the overlay.
    if (data.license_required || (forceOverlay && data.status !== 'lifetime')) {
      if (overlay) showGate('license-overlay');
    } else {
      if (overlay) overlay.classList.add('hidden');
      if (forceOverlay && data.status === 'lifetime') {
        showToast(`Licensed to ${data.customer_name || 'this workstation'} — no expiry`, 'success');
      }
    }
    syncAppInert();

    // Escape hatch for the mid-trial "chip click" path: the overlay can be
    // dismissed only while the trial still runs. Locked installs never see it,
    // so the gate stays a gate.
    const dismiss = document.getElementById('license-dismiss');
    if (dismiss) dismiss.classList.toggle('hidden', !!data.license_required);
    const closeX = document.getElementById('license-close-x');
    if (closeX) closeX.classList.toggle('hidden', !!data.license_required);

    // Status chip: Trial / Monthly / Yearly / Lifetime — click opens the
    // license overlay. Hidden only on the locked screen, where the overlay
    // itself is the message.
    const chip = document.getElementById('trial-chip');
    if (chip) {
      if (data.license_required) {
        chip.classList.add('hidden');
      } else {
        chip.classList.remove('hidden');
        chip.style.cssText = LICENSE_CHIP_STYLES[data.status] ?? '';
        chip.textContent = licenseChipText(data);
        chip.title = data.activated
          ? `Licensed to ${data.customer_name || 'this workstation'}${data.expires_at ? ` until ${data.expires_at}` : ', no expiry'}`
          : 'Trial days remaining. Click to activate this workstation now.';
      }
    }
  } catch (err) {
    console.error('License check failed:', err);
    showToast('License status could not be checked; the trial chip may be stale', 'warning');
  }
}

export async function submitLicenseActivation() {
  const input = document.getElementById('license-key-input');
  const errorEl = document.getElementById('license-error');
  const key = (input?.value || '').trim();

  if (!key) {
    if (errorEl) { errorEl.textContent = 'Please paste a license key'; errorEl.classList.remove('hidden'); }
    return;
  }

  if (key.startsWith('TP-') && !key.includes('.')) {
    if (errorEl) {
      errorEl.textContent = 'You pasted your Machine ID. Please enter the signed License Key issued by the vendor.';
      errorEl.classList.remove('hidden');
    }
    return;
  }

  try {
    const res = await fetch('/api/license/activate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ license_key: key })
    });
    const data = await res.json();

    if (data.activated) {
      const overlay = document.getElementById('license-overlay');
      if (overlay) overlay.classList.add('hidden');
      syncAppInert(); // the reload below frees the app; this covers the 1s gap
      if (errorEl) errorEl.classList.add('hidden');
      showToast(`License activated for ${data.customer_name || 'Customer'}`, 'success');
      setTimeout(() => window.location.reload(), 1000);
    } else {
      throw new Error(data.error || 'Activation failed');
    }
  } catch (err) {
    if (errorEl) {
      errorEl.textContent = err.message || 'Invalid license key';
      errorEl.classList.remove('hidden');
    }
  }
}

// -------------------------------------------------------------
// MANAGER PIN AUTHENTICATION
// -------------------------------------------------------------

// Every fresh install ships with PIN 1234, so a shop that never visits Settings would
// run forever with a PIN that is printed in the manual. Block the app until it changes.
export function enforcePinSetup() {
  const overlay = document.getElementById('pin-setup-overlay');
  if (!overlay) return;
  if (S.licenseRequired) return; // one gate at a time: activation reload re-runs this
  if (!S.shopSettings.pin_change_required || sessionStorage.getItem('pin_setup_skipped') === '1') {
    overlay.classList.add('hidden');
    syncAppInert();
    return;
  }

  // Pre-fill shop name & details if empty
  [
    ['setup-shop-name', S.shopSettings.gcash_name],
    ['setup-owner-name', S.shopSettings.owner_name],
    ['setup-shop-address', S.shopSettings.shop_address],
    ['setup-shop-phone', S.shopSettings.gcash_number],
    ['setup-footer-note', S.shopSettings.shop_footer_note],
    ['setup-warranty-days', S.shopSettings.warranty_days || '7']
  ].forEach(([id, val]) => {
    const el = document.getElementById(id);
    if (el && !el.value) el.value = val || '';
  });

  // Sync active width button with current setting
  const curWidth = S.shopSettings.receipt_paper_width || '80mm';
  overlay.querySelectorAll('[data-setup-width]').forEach(b => {
    const active = b.dataset.setupWidth === curWidth;
    b.classList.toggle('is-active', active);
    b.setAttribute('aria-pressed', active ? 'true' : 'false');
  });

  overlay.classList.remove('hidden');
  syncAppInert();
  setTimeout(() => {
    const shopNameInput = document.getElementById('setup-shop-name');
    const target = (shopNameInput && !shopNameInput.value) ? shopNameInput : document.getElementById('pin-setup-new');
    target?.focus();
  }, 100);
}

let isPinSetupSubmitting = false;
// True once an attempt has successfully changed the PIN — a retry then skips
// change-pin instead of re-sending the factory PIN (which now fails).
let pinSetupPinChanged = false;

export function openPinSetup() {
  try { sessionStorage.removeItem('pin_setup_skipped'); } catch (_) {}
  enforcePinSetup();
}

export function skipPinSetup() {
  if (isPinSetupSubmitting) return;
  try { sessionStorage.setItem('pin_setup_skipped', '1'); } catch (_) {}
  document.getElementById('pin-setup-overlay')?.classList.add('hidden');
  syncAppInert();
  showToast('Setup skipped. You can configure shop name and PIN anytime in Settings.', 'info');
}

export async function submitPinSetup() {
  if (isPinSetupSubmitting) return;
  const shopName = (document.getElementById('setup-shop-name')?.value || '').trim();
  const ownerName = (document.getElementById('setup-owner-name')?.value || '').trim();
  const shopAddress = (document.getElementById('setup-shop-address')?.value || '').trim();
  const shopPhone = (document.getElementById('setup-shop-phone')?.value || '').trim();
  const footerNote = (document.getElementById('setup-footer-note')?.value || '').trim();
  const warrantyDays = (document.getElementById('setup-warranty-days')?.value || '').trim() || '7';
  const newPin = (document.getElementById('pin-setup-new')?.value || '').trim();
  const confirmPin = (document.getElementById('pin-setup-confirm')?.value || '').trim();
  const activeWidthBtn = document.querySelector('[data-setup-width].is-active');
  const paperWidth = activeWidthBtn?.dataset?.setupWidth || '80mm';
  const shouldSeedParts = document.getElementById('setup-seed-parts')?.checked ?? false;
  const errorEl = document.getElementById('pin-setup-error');
  if (errorEl) errorEl.classList.add('hidden');
  ['pin-setup-new', 'pin-setup-confirm'].forEach(id => document.getElementById(id)?.removeAttribute('aria-invalid'));
  const fail = msg => {
    if (errorEl) { errorEl.textContent = msg; errorEl.classList.remove('hidden'); }
    // PIN-related failures mark the fields; the error paragraph is a live
    // region (role="alert"), so the message is announced.
    if (/PIN/i.test(msg)) ['pin-setup-new', 'pin-setup-confirm'].forEach(id => document.getElementById(id)?.setAttribute('aria-invalid', 'true'));
  };

  if (!shopName) return fail('Please enter your shop name.');
  if (!/^\d{4,}$/.test(newPin)) return fail('PIN must be at least 4 digits.');
  if (newPin === '1234') return fail('Choose a PIN other than 1234, or click "Keep factory PIN / Skip" below.');
  if (newPin !== confirmPin) return fail('The two PINs do not match.');

  const submitBtn = document.querySelector('[data-action="save-pin-setup"]');
  const skipBtn = document.querySelector('[data-action="skip-pin-setup"]');
  const origText = submitBtn ? submitBtn.textContent : '';

  try {
    isPinSetupSubmitting = true;
    if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Configuring shop...'; }
    if (skipBtn) skipBtn.disabled = true;

    // A retry after a partial failure must not re-send the factory PIN: the
    // previous attempt already changed it, so only the remaining steps run.
    if (pinSetupPinChanged) {
      showToast('PIN already set — finishing setup…', 'info');
    } else {
      const res = await fetch('/api/auth/change-pin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ old_pin: '1234', new_pin: newPin })
      });
      const data = await res.json();
      if (!res.ok) {
        if (res.status === 403 && (data.code === 'elevation_required' || /manager/i.test(data.error || ''))) {
          requireManagerPin('Enter manager PIN to set your new PIN', () => submitPinSetup());
          return;
        }
        return fail(data.error || 'Could not change PIN.');
      }

      if (data.token) { S.sessionToken = data.token; try { sessionStorage.setItem('pos_session', S.sessionToken); } catch (_) {} }
      if (data.elevationToken) setElevation(data.elevationToken, data.expiresAt);
      pinSetupPinChanged = true;
    }

    // Save shop settings (api.js fetch automatically attaches session & X-Elevation)
    const settingsPayload = {
      gcash_name: shopName,
      owner_name: ownerName || S.shopSettings.owner_name || '',
      shop_address: shopAddress || S.shopSettings.shop_address || '',
      receipt_paper_width: paperWidth,
      gcash_number: shopPhone || S.shopSettings.gcash_number,
      shop_footer_note: footerNote || S.shopSettings.shop_footer_note,
      warranty_days: warrantyDays
    };

    // Settings save is critical — a silent failure here used to announce
    // "configured successfully" while the shop ran on placeholder defaults.
    const settingsRes = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settingsPayload)
    });
    if (!settingsRes.ok) {
      const sdata = await settingsRes.json().catch(() => ({}));
      return fail(sdata.error || 'Shop settings could not be saved — submit again to retry (your PIN is already set).');
    }

    // Optionally seed 17 standard phone repair parts with 0 initial stock.
    // Seeding is convenience, not critical: report it, but don't block setup.
    if (shouldSeedParts) {
      const seedRes = await fetch('/api/inventory/seed-starter', { method: 'POST' });
      if (!seedRes.ok) showToast('Shop is ready, but starter parts could not be seeded — add parts or import a CSV.', 'warning');
    }

    await loadShopSettings();
    await loadPosCatalog();
    document.getElementById('pin-setup-overlay')?.classList.add('hidden');
    syncAppInert();
    showToast('Shop configured successfully! Ready for sales.', 'success');
  } catch (err) {
    fail('Could not reach the server.');
  } finally {
    isPinSetupSubmitting = false;
    if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = origText || 'Save & Launch Shop'; }
    if (skipBtn) skipBtn.disabled = false;
  }
}

export function requireManagerPin(reason, callback, opts = {}) {
  // opts.fresh: always prompt even when unlocked -- kept for callers whose
  // wording implies a fresh PIN; the elevation token is short-lived anyway.
  if (S.isManagerUnlocked && !opts.fresh) {
    callback();
    return;
  }

  S.pendingPinCallback = callback;
  const reasonEl = document.getElementById('pin-prompt-reason');
  const errorEl = document.getElementById('pin-error');
  const inputEl = document.getElementById('pin-input');

  if (reasonEl) reasonEl.textContent = reason || 'Enter manager PIN to continue';
  if (errorEl) errorEl.classList.add('hidden');
  if (inputEl) { inputEl.value = ''; inputEl.removeAttribute('aria-invalid'); }

  openModal('modal-pin');
  setTimeout(() => { if (inputEl) inputEl.focus(); }, 100);
}

// Elevation: the PIN modal now trades the manager PIN for a signed 15-minute
// elevation token (verified server-side on every privileged request).
export async function submitPinVerification() {
  const inputEl = document.getElementById('pin-input');
  const errorEl = document.getElementById('pin-error');
  const pin = (inputEl?.value || '').trim();
  inputEl?.removeAttribute('aria-invalid');

  if (!pin) {
    if (errorEl) { errorEl.textContent = 'Please enter PIN'; errorEl.classList.remove('hidden'); }
    inputEl?.setAttribute('aria-invalid', 'true');
    return;
  }

  try {
    const res = await fetch('/api/auth/elevate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin })
    });
    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      // Lockout surfaces its real message ('Locked for 43s').
      if (errorEl) { errorEl.textContent = data.error || 'Verification failed'; errorEl.classList.remove('hidden'); }
      inputEl?.setAttribute('aria-invalid', 'true');
      if (inputEl) inputEl.focus();
      return;
    }

    if (data.valid) {
      setElevation(data.elevationToken, data.expiresAt);
      closeModal('modal-pin');
      if (errorEl) errorEl.classList.add('hidden');

      // Re-render inventory table if currently visible so cost prices appear
      if (S.currentTab === 'inventory') loadInventoryTable();

      if (S.pendingPinCallback) {
        const cb = S.pendingPinCallback;
        S.pendingPinCallback = null;
        cb();
      }
    } else {
      if (errorEl) { errorEl.textContent = 'Incorrect PIN'; errorEl.classList.remove('hidden'); }
      if (inputEl) { inputEl.value = ''; inputEl.focus(); }
    }
  } catch (err) {
    if (errorEl) { errorEl.textContent = 'Verification failed'; errorEl.classList.remove('hidden'); }
  }
}

export function closePinModal() {
  closeModal('modal-pin');
  S.pendingPinCallback = null;
}

export function formatCostPrice(value) {
  if (S.costPricesRevealed) return fmtMoney(value);
  return '••••';
}

export function toggleCostPriceReveal() {
  // costPricesRevealed is a display flag of its own: overwriting
  // isManagerUnlocked here left hasElevation() true while the unlock flag was
  // false, so one manager surface re-prompted while another did not.
  if (S.costPricesRevealed) {
    S.costPricesRevealed = false;
    loadInventoryTable();
  } else {
    requireManagerPin('Enter manager PIN to reveal cost prices', () => {
      S.costPricesRevealed = true;
      loadInventoryTable();
    });
  }
}

export async function triggerResetDemoData() {
  // The elevation token proves a fresh manager PIN entry; the body no longer
  // carries one.
  requireManagerPin('Enter manager PIN to confirm Demo Data Reset', async () => {
    if (!await confirmModal('This will wipe active transactions and restore clean demonstration parts & sales.', { title: 'Reset demo data?', yes: 'Wipe & reset', danger: true })) return;
    try {
      const res = await fetch('/api/settings/reset-demo', { method: 'POST' });
      if (!res.ok) throw new Error('Reset failed');
      closeModal('modal-settings');
      showToast('Demo data reset successfully', 'success');
      setTimeout(() => window.location.reload(), 800);
    } catch (err) {
      showToast(`Error: ${err.message}`, 'error');
    }
  });
}

// -------------------------------------------------------------
// STAFF MANAGEMENT (manager-gated, lives in Store & print settings)
// -------------------------------------------------------------
export async function renderStaffPanel() {
  const list = document.getElementById('staff-list');
  if (!list) return;
  let staff = [];
  let failed = false;
  try {
    const res = await fetch('/api/auth/staff');
    if (res.ok) {
      staff = await res.json();
      try { localStorage.setItem('pos_staff_roster', JSON.stringify(staff.map(s => ({ id: s.id, name: s.name })))); } catch (_) {}
    } else {
      failed = true;
    }
  } catch (_) {
    failed = true;
  }
  if (failed) {
    // A fetch failure rendered as "No staff yet" once and invited the manager
    // to re-add existing cashiers. Say what actually happened instead.
    list.innerHTML = `
      <div class="empty">
        <div class="empty__icon"><i class="ph ph-wifi-slash w-5 h-5"></i></div>
        <div class="empty__title">Couldn't load staff</div>
        <p class="empty__body">The server didn't answer, so this list may be out of date. Retry before adding anyone new.</p>
        <button type="button" class="chip" data-action="reload-staff">Retry</button>
      </div>`;
    return;
  }
  list.innerHTML = staff.length === 0
    ? '<p class="foot-note">No staff yet. Add one so sales and returns are logged under their name.</p>'
    : staff.map(s => `
      <div class="flex items-center gap-2" style="padding:4px 0;border-bottom:1px solid var(--line-soft, rgba(148,163,184,.15));">
        <span class="flex-1 text-xs font-bold">${escHtml(s.name)}</span>
        <button type="button" class="btn-mini" data-staff-act="reset" data-staff-id="${s.id}" data-staff-name="${escHtml(s.name)}">Reset PIN</button>
        <button type="button" class="btn-mini btn-mini--danger" data-staff-act="deactivate" data-staff-id="${s.id}" data-staff-name="${escHtml(s.name)}">Deactivate</button>
      </div>`).join('');
}

export async function submitNewStaff() {
  const name = document.getElementById('staff-new-name')?.value.trim();
  const pin = document.getElementById('staff-new-pin')?.value.trim();
  const msg = document.getElementById('staff-msg');
  const fail = m => { if (msg) { msg.textContent = m; msg.classList.remove('hidden'); } };
  if (!name || !pin) return fail('Name and PIN are both required.');
  try {
    const res = await fetch('/api/auth/staff', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, pin })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return fail(data.error || 'Could not add staff.');
    document.getElementById('staff-new-name').value = '';
    document.getElementById('staff-new-pin').value = '';
    if (msg) msg.classList.add('hidden');
    renderStaffPanel();
    showToast(`Staff "${name}" added`, 'success');
  } catch (err) {
    fail('Could not reach the server.');
  }
}

export async function resetStaffPinPrompt(id, name) {
  const pin = await inputModal(`New PIN for ${name}`, { placeholder: 'At least 4 digits, not 1234', inputType: 'password', yes: 'Reset PIN' });
  if (pin === null || !pin.trim()) return;
  try {
    const res = await fetch(`/api/auth/staff/${id}/reset-pin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: pin.trim() })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Reset failed');
    showToast(`PIN reset for ${name} — their open tab logs out on next use`, 'success');
  } catch (err) {
    showToast(`Error: ${err.message}`, 'error');
  }
}

export async function deactivateStaffPrompt(id, name) {
  if (!await confirmModal(`${name} will no longer be able to log in. Their history in the audit log is kept.`, { title: 'Deactivate staff?', yes: 'Deactivate', danger: true })) return;
  try {
    const res = await fetch(`/api/auth/staff/${id}/deactivate`, { method: 'POST' });
    if (!res.ok) throw new Error('Deactivation failed');
    try {
      const cached = JSON.parse(localStorage.getItem('pos_staff_roster') || '[]');
      localStorage.setItem('pos_staff_roster', JSON.stringify(cached.filter(s => s.id !== id)));
    } catch (_) {}
    renderStaffPanel();
    showToast(`${name} deactivated`, 'success');
  } catch (err) {
    showToast(`Error: ${err.message}`, 'error');
  }
}

// -------------------------------------------------------------
// AUDIT LOG VIEW (manager-gated tab, read-only)
// -------------------------------------------------------------
const AUDIT_PAGE = 100;
let auditOffset = 0;     // paging cursor for "Load more"
let auditCategory = '';  // active category chip ('' = All)
let auditShown = 0;      // rows on screen for the current filter
let auditInited = false; // one-time filter listener wiring

// ---- Human-readable action labels ----------------------------------------
// Re-keyed 2026-09-27 from the actions the server actually emits
// (SELECT DISTINCT category, action FROM audit_log). Keys not in this map
// still render via the fallback in auditLabel().
const ACTION_LABELS = {
  // security
  'security login':              'Signed in',
  'security login_failed':       'Wrong PIN',
  'security logout':             'Signed out',
  'security elevate':            'Elevation granted',
  'security elevate_failed':     'Elevation failed',
  'security change_pin':         'PIN changed',
  'security staff_create':       'Staff added',
  'security staff_reset_pin':    'Staff PIN reset',
  'security staff_deactivate':   'Staff deactivated',
  'security report_login':       'Report page signed in',
  'security report_login_failed':'Report page wrong PIN',
  // sale / receipt
  'sale create':                 'Sale recorded',
  'sale void':                   'Sale voided',
  'receipt reprint':             'Receipt reprinted',
  // credit
  'credit settle':               'Credit settled',
  'credit set_limit':            'Credit limit set',
  // return
  'return create':               'Warranty return',
  // inventory
  'inventory create':            'Part added',
  'inventory update':            'Part updated',
  'inventory adjust_stock':      'Stock adjusted',
  'inventory archive':           'Part archived',
  'inventory unarchive':         'Part unarchived',
  'inventory delete':            'Part deleted',
  'inventory export':            'Inventory exported',
  'inventory import':            'CSV imported',
  'inventory bulk_edit':         'Bulk edit parts',
  'inventory seed_starter':      'Starter catalog seeded',
  // settings
  'settings update':             'Settings changed',
  'settings cloud_paired':       'Cloud register paired',
  // print
  'print sale':                  'Sale receipt printed',
  'print return':                'Return slip printed',
  'print payment':               'Payment receipt printed',
  'print drawer':                'Cash drawer kicked',
  'print test':                  'Test slip printed',
  // shift / day close / system
  'shift open':                  'Shift opened',
  'shift close':                 'Shift closed',
  'day_close close':             'Day closed',
  'system backup':               'Backup triggered',
  'system restore':              'Backup restored',
  'system export':               'Data exported',
  'system shutdown':             'Server shut down',
  'system reset_demo':           'Demo data reset',
  'system update_apply':         'App update applied',
};

// ---- Category → quiet text label ------------------------------------------
// The feed colors outcomes, not categories, so a category is a plain word in
// the meta line, never a colored badge.
const CATEGORY_LABELS = {
  security:  'Security',
  sale:      'Sales',
  receipt:   'Sales',
  print:     'Printer',
  credit:    'Credits',
  return:    'Returns',
  inventory: 'Stock',
  settings:  'Settings',
  shift:     'Shift',
  day_close: 'Day close',
  system:    'System',
};

function auditCategoryLabel(category) {
  return CATEGORY_LABELS[category] || category;
}

// Category dots: the color anchor the eye scans by (user-requested highlight).
// They identify the category only; good/bad still lives in the sentence color,
// so a routine green dot never disguises a red outcome.
const CATEGORY_DOT_CLASS = {
  security:  'danger',
  sale:      'pos',
  receipt:   'pos',
  credit:    'info',
  return:    'info',
  inventory: 'warn',
};
const auditCatDot = (c) => {
  const m = CATEGORY_DOT_CLASS[c];
  return `<span class="audit-cat-dot${m ? ` audit-cat-dot--${m}` : ''}"></span>`;
};
// Manager override on a staff session: a real status worth spotting fast.
const auditElevBadge = () => ' <span class="audit-elev-badge">elevated</span>';

function auditLabel(r) {
  const key = `${r.category} ${r.action}`;
  return ACTION_LABELS[key] || r.action.replace(/_/g, ' ');
}

function formatReason(r) {
  if (!r) return '';
  const map = {
    damage: 'Damaged stock',
    damaged: 'Damaged stock',
    defect: 'Defective unit',
    defective: 'Defective unit',
    audit_correction: 'Audit recount',
    correction: 'Inventory recount',
    warranty: 'Warranty write-off',
    supplier_return: 'Returned to supplier',
    lost: 'Missing / lost stock',
    expired: 'Expired'
  };
  return map[r] || String(r).replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

// ---- Sentence feed: one human line per entry -------------------------------
// parseAuditDetail: the raw detail JSON, or null when the row carries none.
// A malformed payload surfaces as { raw }, so broken JSON is inspectable
// instead of silently blank.
function parseAuditDetail(r) {
  try {
    const d = r.detail ? JSON.parse(r.detail) : null;
    return d && typeof d === 'object' && Object.keys(d).length ? d : null;
  } catch (_) {
    return { raw: String(r.detail) };
  }
}

function auditPayloadHtml(d) {
  const rows = Object.entries(d).map(([k, v]) => {
    const val = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return `<div><dt>${escHtml(k)}</dt><dd>${escHtml(val)}</dd></div>`;
  }).join('');
  return `<details class="audit-raw-toggle"><summary class="audit-raw-toggle__summary">Details</summary><dl class="audit-detail__dl">${rows}</dl></details>`;
}

// The sentence carries the event's own figures (money, stock, names) inline so
// the feed reads like the day's story; the raw payload stays one Details click
// away. tone colors outcomes only: red where money or access went wrong,
// green where a balance settled. Categories stay colorless on purpose, so a
// routine sign-in never looks like an alarm.
// Builders emit HTML: identifiers (sale codes, part names, customers) go
// through ref() so the "where" is scannable; every other dynamic value goes
// through txt(). Both escape at the source, so the renderer can trust
// sentence.html directly.
const ref = (v) => `<b class="audit-line__ref">${escHtml(String(v))}</b>`;
const txt = (v) => escHtml(String(v));

function auditSentence(r, d) {
  const label = txt(auditLabel(r));
  if (!d) return { html: label, tone: '' };
  const cat = r.category;
  const act = r.action;
  const P = fmtMoney;
  const pair = (k, v) => `${txt(k)}: ${txt(v)}`;

  if (cat === 'security' && (act === 'login_failed' || act === 'report_login_failed')) {
    return { html: 'Incorrect PIN entered, access rejected', tone: 'neg' };
  }
  if (cat === 'sale' && act === 'void') {
    const bits = [`Sale ${d.sale_code ? ref(d.sale_code) : ''} voided`];
    if (d.total !== undefined) bits.push(`amount ${P(d.total)}`);
    if (d.restored) bits.push('stock restored');
    if (d.reason) bits.push(`reason: ${txt(d.reason)}`);
    return { html: bits.join(', '), tone: 'neg' };
  }
  if (cat === 'sale' && act === 'create') {
    const bits = [`${d.sale_code ? ref(d.sale_code) : 'Sale'} recorded`];
    if (d.total !== undefined) bits.push(P(d.total));
    if (d.payment_method) bits.push(txt(String(d.payment_method).toUpperCase()));
    if (d.items) bits.push(`${txt(d.items)} item${d.items > 1 ? 's' : ''}`);
    if (d.customer) bits.push(ref(d.customer));
    return { html: bits.join(' · '), tone: '' };
  }
  if (cat === 'receipt' && act === 'reprint') {
    return { html: `Receipt reprinted for ${d.sale_code ? ref(d.sale_code) : 'a sale'}`, tone: '' };
  }
  if (cat === 'credit' && act === 'settle') {
    const bits = [`${ref(d.customer || d.customer_name || 'Customer')} paid ${P(d.amount)}`];
    if (d.method) bits.push(txt(String(d.method).toUpperCase()));
    if (d.reference) bits.push(`ref ${ref(d.reference)}`);
    return { html: bits.join(' · '), tone: 'pos' };
  }
  if (cat === 'credit' && act === 'set_limit') {
    const limit = Number(d.credit_limit) > 0 ? P(d.credit_limit) : 'no limit';
    return { html: `${ref(d.customer || d.customer_name || 'Customer')}: credit limit set to ${limit}`, tone: '' };
  }
  if (cat === 'return' && act === 'create') {
    const what = d.type === 'replacement' ? 'part replacement' : `refund ${P(d.amount)}`;
    return { html: `${d.return_code ? ref(d.return_code) : 'Warranty return'} on sale ${d.sale_code ? ref(d.sale_code) : ''}: ${what}`, tone: '' };
  }
  if (cat === 'inventory' && (act === 'adjust_stock' || act === 'adjust')) {
    const part = d.part || (d.id ? `Part #${d.id}` : 'Inventory item');
    const delta = Number(d.delta) || 0;
    const before = d.before !== undefined ? d.before : '?';
    const after = d.after !== undefined ? d.after : '?';
    const reason = d.reason ? `, reason: ${txt(formatReason(d.reason))}` : '';
    return { html: `${ref(part)}: stock ${txt(before)} → ${txt(after)} (${delta >= 0 ? '+' : ''}${delta} units${reason})`, tone: '' };
  }
  if (cat === 'inventory' && act === 'create') {
    const bits = [`${d.part ? ref(d.part) : 'New part'} added`];
    if (d.stock !== undefined) bits.push(`stock ${txt(d.stock)}`);
    if (d.price !== undefined) bits.push(`price ${P(d.price)}`);
    if (d.sku) bits.push(`SKU ${ref(d.sku)}`);
    return { html: bits.join(', '), tone: '' };
  }
  if (cat === 'inventory' && (act === 'archive' || act === 'unarchive')) {
    return { html: `${d.part ? ref(d.part) : `Part #${d.id}`} ${act === 'archive' ? 'archived from' : 'restored to'} the catalog`, tone: '' };
  }
  if (cat === 'inventory' && act === 'delete') {
    return { html: `${d.part ? ref(d.part) : `Part #${d.id}`} deleted`, tone: 'neg' };
  }
  if (cat === 'inventory' && act === 'import') {
    return { html: `CSV import: ${txt(d.created || 0)} created, ${txt(d.updated || 0)} stock updated`, tone: '' };
  }
  if (cat === 'inventory' && act === 'bulk_edit') {
    const act2 = d.action ? `, ${txt(String(d.action).replace(/_/g, ' '))}` : '';
    return { html: `Bulk edit: ${txt(d.count || 0)} part(s)${act2}`, tone: '' };
  }
  if ((cat === 'shift' || cat === 'day_close') && act === 'close') {
    const variance = Number(d.variance) || 0;
    const balanced = Math.abs(variance) < 0.01;
    const title = cat === 'day_close' ? `Day ${d.day ? ref(d.day) : ''} closed` : `Shift #${ref(d.shift_id || '1')} closed`;
    const verdict = balanced ? 'balanced' : `variance ${P(variance)}`;
    return { html: `${title}: counted ${P(d.counted_cash)}, expected ${P(d.expected_cash)}, ${verdict}`, tone: balanced ? 'pos' : 'neg' };
  }
  if (cat === 'settings' && act === 'update' && d.changes && typeof d.changes === 'object') {
    const keys = Object.keys(d.changes).map((k) => txt(k.replace(/_/g, ' ')));
    const shown = keys.slice(0, 3).join(', ');
    const more = keys.length > 3 ? ` +${keys.length - 3} more` : '';
    return { html: `Settings changed: ${shown}${more}`, tone: '' };
  }
  if (cat === 'settings' && act === 'cloud_paired') {
    const backfill = Number(d.backfill_rows) > 0 ? `, ${txt(d.backfill_rows)} rows backfilled` : '';
    return { html: `Cloud register paired, shop ${txt(d.shop_id || '')}${backfill}`, tone: '' };
  }
  // Unknown shapes: the label plus the first few payload pairs, values
  // bounded so one long field cannot stretch the line.
  const entries = Object.entries(d).filter(([k]) => !['id', 'staff_id', 'customer_id', 'hold_id'].includes(k));
  if (!entries.length) return { html: label, tone: '' };
  const pairs = entries.slice(0, 3).map(([k, v]) => {
    const val = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return pair(k, val.length > 48 ? `${val.slice(0, 48)}...` : val);
  }).join(', ');
  return { html: `${label}: ${pairs}`, tone: '' };
}

// ---- Relative timestamp --------------------------------------------------
function auditRelTime(dateStr) {
  const d = new Date(dateStr);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60)   return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return '';
}

// ---- Day label for group header ------------------------------------------
// Weekday form already carries the date, so appending it again produced
// "Thursday, Nov 5, 2026 · Nov 5, 2026". Today/Yesterday keep the date,
// other days say it once.
function auditDayLabel(dateStr) {
  const d = new Date(dateStr);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (sameDay(d, today)) return `Today · ${d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}`;
  if (sameDay(d, yesterday)) return `Yesterday · ${d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}`;
  return d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' });
}

function auditDayKey(dateStr) {
  const d = new Date(dateStr);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

// Filters re-query immediately; no separate "apply" step.
function initAuditFilters() {
  auditInited = true;
  const actorInput = document.getElementById('audit-filter-actor');
  let actorDebounce;
  actorInput?.addEventListener('input', () => {
    clearTimeout(actorDebounce);
    actorDebounce = setTimeout(() => loadAuditLog(), 300);
  });
  // Category chips (pill buttons) drive loadAuditLog through auditCategory
  document.getElementById('audit-filter-days')?.addEventListener('change', () => loadAuditLog());
  document.getElementById('audit-more')?.addEventListener('click', () => loadAuditLog({ append: true }));

  // Category chip buttons (in redesigned toolbar)
  document.querySelector('[data-audit-cats]')?.addEventListener('click', e => {
    const chip = e.target.closest('[data-cat]');
    if (!chip) return;
    document.querySelectorAll('[data-audit-cats] [data-cat]').forEach(b => b.classList.remove('is-active'));
    chip.classList.add('is-active');
    auditCategory = chip.dataset.cat;
    loadAuditLog();
  });
}

export async function loadAuditLog({ append = false } = {}) {
  const tbody = document.getElementById('audit-tbody');
  if (!tbody) return;
  if (!hasElevation()) {
    if (S.currentTab === 'audit') {
      requireManagerPin('Enter manager PIN to view the audit log', () => {
        loadAuditLog({ append });
        loadAuditChain();
      });
    }
    return;
  }
  if (!auditInited) initAuditFilters();
  if (!append) tbody.innerHTML = '<li class="audit-loading">Loading audit entries...</li>';
  try {
    const actor = document.getElementById('audit-filter-actor')?.value.trim() || '';
    const category = auditCategory;
    const days = document.getElementById('audit-filter-days')?.value || '30';
    const offset = append ? auditOffset : 0;
    const qs = new URLSearchParams({ actor, category, days, limit: String(AUDIT_PAGE), offset: String(offset) });
    const res = await fetch(`/api/audit?${qs}`);
    if (res.status === 403) {
      if (S.currentTab === 'audit') {
        requireManagerPin('Enter manager PIN to view the audit log', () => {
          loadAuditLog({ append });
          loadAuditChain();
        });
      }
      return;
    }
    if (!res.ok) throw new Error('Could not load the audit log');
    const { rows, total } = await res.json();
    auditOffset = offset + rows.length;
    auditShown = append ? auditShown + rows.length : rows.length;

    const countEl = document.getElementById('audit-count');
    if (countEl) countEl.textContent = `${auditShown} of ${total} entries`;
    const moreBtn = document.getElementById('audit-more');
    if (moreBtn) moreBtn.classList.toggle('hidden', auditShown >= total);

    if (!append && rows.length === 0) {
      tbody.innerHTML = `
        <li class="audit-loading">
          <div class="empty">
            <div class="empty__icon"><i class="ph ph-shield-check w-5 h-5"></i></div>
            <div class="empty__title">No audit entries found</div>
            <p class="empty__body">No activity logged for this filter or date range.</p>
          </div>
        </li>`;
      return;
    }

    // Build the feed: day headers, then entries. Consecutive detail-less
    // entries with the same who + what (the sign-in spam case) collapse into
    // one expandable row; every entry is still in the log and listed on expand.
    // ponytail: a repeat straddling a "Load more" boundary renders as two
    // groups; merging across pages needs state the DOM does not carry.
    let lastDay = append ? [...tbody.querySelectorAll('[data-day]')].pop()?.dataset.day || '' : '';
    const parts = [];
    let group = null;
    const flushGroup = () => {
      if (!group) return;
      const n = group.times.length;
      const name = escHtml(group.actor || 'Unknown');
      const meta = `${auditCatDot(group.category)}${escHtml(auditCategoryLabel(group.category))}${group.elevated ? auditElevBadge() : ''}`;
      // One occurrence is a plain row; the expander only earns its keep from 2 up.
      // Range reads oldest to newest even though the feed is newest-first.
      if (n === 1) {
        parts.push(`
        <li class="audit-line">
          <span class="audit-line__time">${escHtml(group.times[0])}</span>
          <span class="audit-line__actor" title="${name}">${name}</span>
          <div class="audit-line__body">
            <p class="audit-line__sentence">${escHtml(group.label)}</p>
            <p class="audit-line__meta">${meta}</p>
          </div>
        </li>`);
      } else {
        parts.push(`
        <li class="audit-line">
          <span class="audit-line__time">${escHtml(group.times[0])}</span>
          <span class="audit-line__actor" title="${name}">${name}</span>
          <div class="audit-line__body">
            <details class="audit-repeat">
              <summary class="audit-line__sentence">${escHtml(group.label)} · ${n} times, ${escHtml(group.times[n - 1])} to ${escHtml(group.times[0])}</summary>
              <ul class="audit-repeat__list">${group.times.map((t) => `<li>${escHtml(t)}</li>`).join('')}</ul>
            </details>
            <p class="audit-line__meta">${meta}</p>
          </div>
        </li>`);
      }
      group = null;
    };
    for (const r of rows) {
      const dayKey = auditDayKey(r.created_at);
      if (dayKey !== lastDay) {
        flushGroup();
        lastDay = dayKey;
        parts.push(`<li class="audit-day" data-day="${escHtml(dayKey)}"><span class="audit-day__label">${escHtml(auditDayLabel(r.created_at))}</span></li>`);
      }
      const detail = parseAuditDetail(r);
      const timeStr = new Date(r.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      if (!detail) {
        const key = `${r.actor_name}|${r.elevated}|${r.category}|${r.action}`;
        if (group && group.key === key) {
          group.times.push(timeStr);
          continue;
        }
        flushGroup();
        group = { key, label: auditLabel(r), actor: r.actor_name, category: r.category, elevated: !!r.elevated, times: [timeStr] };
        continue;
      }
      flushGroup();
      const sentence = auditSentence(r, detail);
      const tone = sentence.tone === 'neg' ? ' audit-line__sentence--neg' : sentence.tone === 'pos' ? ' audit-line__sentence--pos' : '';
      const rel = auditRelTime(r.created_at);
      parts.push(`
        <li class="audit-line">
          <span class="audit-line__time">${escHtml(timeStr)}</span>
          <span class="audit-line__actor" title="${escHtml(r.actor_name)}">${escHtml(r.actor_name || 'Unknown')}</span>
          <div class="audit-line__body">
            <p class="audit-line__sentence${tone}">${sentence.html}</p>
            <p class="audit-line__meta">${auditCatDot(r.category)}${escHtml(auditCategoryLabel(r.category))}${r.elevated ? auditElevBadge() : ''}${rel ? ` · ${escHtml(rel)}` : ''}</p>
            ${auditPayloadHtml(detail)}
          </div>
        </li>`);
    }
    flushGroup();
    const html = parts.join('');

    if (append) tbody.insertAdjacentHTML('beforeend', html);
    else tbody.innerHTML = html;
  } catch (err) {
    if (!append) tbody.innerHTML = `<li class="audit-loading"><p class="foot-note" style="padding:8px 0;">${escHtml(err.message)}</p></li>`;
    showToast(err.message, 'error');
  }
}

// Chain-integrity chip in the toolbar: hash chain over every audit row.
export async function loadAuditChain() {
  const chip = document.getElementById('audit-chain');
  if (!chip) return;
  try {
    const res = await fetch('/api/audit/verify');
    if (!res.ok) throw new Error();
    const { ok, first_bad_id } = await res.json();
    chip.classList.toggle('is-bad', !ok);
    chip.innerHTML = `<span class="chain-chip__dot"></span>${ok ? 'Chain intact' : `Tampered at #${first_bad_id}`}`;
  } catch (_) {
    chip.innerHTML = '<span class="chain-chip__dot"></span>Unverified';
  }
}
