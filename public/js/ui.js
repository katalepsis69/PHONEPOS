import { S } from './state.js';
import { calculateChange } from './views/pos.js';
import { loadInventoryTable } from './views/inventory.js';
import { loadCustomers, loadSalesHistory, loadWarrantyReturnsTable } from './views/backoffice.js';
import { clearModalSlip } from './receipts.js';

export function escHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// One money formatter: thousands separators everywhere amounts are shown.
//
// The finite-number rule below is the one `money()` in src/printer.js and
// `printMoney()` in public/js/receipts.js apply on paper, but only those two
// refuse by throwing. This one marks, and the split is deliberate: fmtMoney has
// 81 call sites across the app, most of them inside a list view's try block, so a
// single non-numeric `sales.total_amount` thrown here took the whole sales
// history down with it (the catch repainted every row as "Couldn't load sales
// history / The server didn't answer" and toasted the operator about a server
// that is fine). The guard exists so a shop can FIND a corrupted amount, and the
// row it was written for is the one row that screen then hid. An unusable value
// now reads `₱--`, the marker this file already uses for a date that will not
// resolve, and the rest of the table stays listable. Paper still refuses the same
// figure outright. An absent field stays 0.00, exactly as on paper: a slip with
// no change row is a normal print, not a broken number.
export function isFiniteAmount(n) {
  if (n === undefined || n === null || n === '') return true;
  return Number.isFinite(Number(n));
}

// What an amount that is not a number looks like on screen. A constant, never
// the raw value: fmtMoney's output is interpolated into innerHTML templates by
// every caller, so echoing a stored string back out would hand a hand-edited
// row a way into the page.
export const UNREADABLE_AMOUNT = '₱--';

export function fmtMoney(n) {
  if (!isFiniteAmount(n)) return UNREADABLE_AMOUNT;
  return '₱' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function setCounterText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

export function showToast(message, type = 'info') {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    container.setAttribute('role', 'status');
    container.setAttribute('aria-live', 'polite');
    document.body.appendChild(container);
  }

  const toast = document.createElement('div');
  toast.className = `toast-item toast-${type}`;
  if (type === 'error') toast.setAttribute('role', 'alert');

  let iconSvg = '';
  if (type === 'success') {
    iconSvg = '<svg class="w-4 h-4 shrink-0 text-emerald-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>';
  } else if (type === 'error') {
    iconSvg = '<svg class="w-4 h-4 shrink-0 text-rose-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>';
  } else if (type === 'warning') {
    iconSvg = '<svg class="w-4 h-4 shrink-0 text-amber-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';
  } else {
    iconSvg = '<svg class="w-4 h-4 shrink-0 text-sky-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>';
  }

  toast.innerHTML = `${iconSvg}<span class="flex-1">${escHtml(message)}</span><button type="button" class="toast-x" aria-label="Dismiss notification">&times;</button>`;
  // Cap the stack: a burst of failures must not bury the screen corner.
  while (container.children.length >= 5) container.firstElementChild.remove();
  container.appendChild(toast);

  const dismiss = () => {
    toast.classList.add('toast-leave');
    setTimeout(() => toast.remove(), 220);
  };
  toast.querySelector('.toast-x').addEventListener('click', dismiss);
  setTimeout(dismiss, 3200);
}

export function initLiveClock() {
  const clockEl = document.getElementById('header-live-clock');
  if (!clockEl) return;
  const update = () => {
    const now = new Date();
    clockEl.textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  };
  update();
  setInterval(update, 1000);
}

export function addTenderedAmount(delta) {
  const tenderedEl = document.getElementById('pos-tendered');
  if (tenderedEl) {
    const current = Number(tenderedEl.value || 0);
    tenderedEl.value = current + delta;
    calculateChange();
  }
}

// One debounce shared by every server-filtered search box: one query per pause
// in typing instead of one per keystroke.
export function debounce(fn, ms = 200) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

export const searchCustomers = debounce(loadCustomers);
export const searchInventory = debounce(loadInventoryTable);
export const searchReturns = debounce(loadWarrantyReturnsTable);
export const searchSales = debounce(loadSalesHistory);
export const debouncedViewLoad = debounce(target => target.load());

// Skeleton rows for the table views (only when empty — during a re-search the
// stale rows stay up; flickering skeletons on every keystroke reads worse).
function skeletonRows(cols, n = 4) {
  return Array.from({ length: n }, () =>
    `<tr>${'<td><div class="skel" style="height:11px;margin:5px 0"></div></td>'.repeat(cols)}</tr>`).join('');
}

export function showSkeleton(id, cols) {
  const el = document.getElementById(id);
  if (el && (!el.children.length || el.querySelector('.empty'))) {
    el.innerHTML = skeletonRows(cols);
  }
}

// Modals are real dialogs: focus moves in, the app behind goes inert, and
// focus returns to the trigger on close. They form a stack — a confirm
// stacked on the receipt modal closes first, keeps the receipt alive beneath
// it (inert), and restores focus into that receipt when it settles.
// initialized in state.js: S.modalStack
// initialized in state.js: S.lastFocusedEl

let modalTrapInited = false;

// One Tab handler for the whole app: while a modal is open, Tab cycles inside
// the TOP layer only and focus that escaped (or started outside) is pulled
// back into it. Init lazily from openModal.
function initModalFocusGuard() {
  if (modalTrapInited) return;
  modalTrapInited = true;
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab' || !S.modalStack.length) return;
    const el = document.getElementById(S.modalStack[S.modalStack.length - 1].id);
    if (!el) return;
    const focusables = [...el.querySelectorAll(
      'button:not([disabled]), [href], input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )].filter(x => x.offsetParent !== null);
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (!el.contains(document.activeElement)) {
      e.preventDefault();
      first.focus();
    } else if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  });
}

export function openModal(id) {
  const el = document.getElementById(id);
  if (!el) return;
  initModalFocusGuard();

  const wasHidden = el.classList.contains('hidden');
  if (wasHidden) {
    S.modalStack = S.modalStack.filter(m => m.id !== id);
    S.modalStack.push({ id, prevFocus: document.activeElement });
    S.lastFocusedEl = document.activeElement;
    el.classList.remove('hidden');
  }
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  // Name the dialog from its heading so screen readers announce what is being
  // approved instead of an unnamed "dialog".
  if (!el.getAttribute('aria-labelledby')) {
    const heading = el.querySelector('h2[id], h3[id]');
    if (heading) el.setAttribute('aria-labelledby', heading.id);
  }
  syncAppInert();

  if (wasHidden) {
    const focusable = el.querySelector('input:not([type="hidden"]), textarea, select, button');
    if (focusable) focusable.focus();
  }
}

export function closeModal(id) {
  // Every dismissal settles cancellation. Confirm/Submit detach their resolver
  // first, so closing cannot turn an accepted answer into a cancellation.
  const key = id === 'modal-confirm' ? 'confirmResolveFn' : id === 'modal-input' ? 'inputResolveFn' : null;
  const cancel = key ? S[key] : null;
  if (key) S[key] = null;
  if (cancel) cancel(id === 'modal-confirm' ? false : null);
  const el = document.getElementById(id);
  if (el) el.classList.add('hidden');
  // Putting the dialog away also retires whatever the receipt modal declared for
  // its Print button. receipts.js owns that declaration and this is the one
  // dismissal path every close goes through (button, backdrop and Escape all
  // land here), so a payload can no longer outlive the slip that declared it.
  clearModalSlip(id);
  const index = S.modalStack.findIndex(m => m.id === id);
  const entry = index >= 0 ? S.modalStack.splice(index, 1)[0] : null;
  syncAppInert();

  // Restore the trigger recorded for THIS layer. If it's gone (its view was
  // re-rendered), fall back to the first control of the modal now on top.
  const restore = entry?.prevFocus;
  if (restore && document.contains(restore)) restore.focus();
  else if (S.modalStack.length) {
    const top = document.getElementById(S.modalStack[S.modalStack.length - 1].id);
    top?.querySelector('input:not([type="hidden"]), textarea, select, button')?.focus();
  }
  if (!S.modalStack.length) S.lastFocusedEl = null;
}

// The id of the topmost open dialog, or null. The global Escape handler uses
// this so one press retires exactly one layer.
export function currentTopModalId() {
  return S.modalStack.length ? S.modalStack[S.modalStack.length - 1].id : null;
}

// Close only the topmost open dialog. Returns whether one was open.
export function closeTopModal() {
  const top = S.modalStack[S.modalStack.length - 1];
  if (top) closeModal(top.id);
  return !!top;
}

// The app goes inert behind any open modal *and* behind the blocking gates
// (license / PIN setup / login), so keyboard users can't reach around them.
// Below the top dialog layer, earlier dialogs go inert too.
export function syncAppInert() {
  const app = document.querySelector('.app');
  if (!app) return;
  const gated = ['server-down-overlay', 'license-overlay', 'pin-setup-overlay', 'login-gate'].some(id => {
    const el = document.getElementById(id);
    return el && !el.classList.contains('hidden');
  });
  const modalOpen = !!document.querySelector('.modal-backdrop:not(.hidden)');
  app.inert = gated || modalOpen;
  const topId = S.modalStack.length ? S.modalStack[S.modalStack.length - 1].id : null;
  document.querySelectorAll('.modal-backdrop').forEach(el => {
    el.inert = modalOpen && el.id !== topId;
  });
}

// Blocking gates (license / login / server-down) are alert dialogs that own
// the whole app: move focus into the card when one appears, the same contract
// openModal enforces for ordinary dialogs.
export function showGate(id) {
  const gate = document.getElementById(id);
  if (!gate) return;
  gate.classList.remove('hidden');
  syncAppInert();
  const target = [...gate.querySelectorAll('input:not([type="hidden"]), button')]
    .find(el => !el.classList.contains('hidden') && !el.closest('.hidden'));
  target?.focus();
}

// confirmModal(): the in-app replacement for native confirm() — same design
// language as everything else, promise-based, keyboard-friendly (Escape and
// Enter both settle; Cancel keeps focus so Enter never confirms by accident).
// initialized in state.js: S.confirmResolveFn
// initialized in state.js: S.confirmInited

export function initConfirmModal() {
  if (S.confirmInited) return;
  const wrap = document.getElementById('modal-confirm');
  if (!wrap) return;
  S.confirmInited = true;
  const settle = val => {
    const resolve = S.confirmResolveFn;
    S.confirmResolveFn = null;
    closeModal('modal-confirm');
    if (resolve) resolve(val);
  };
  wrap.querySelector('#confirm-ok').addEventListener('click', () => settle(true));
  wrap.querySelector('#confirm-cancel').addEventListener('click', () => settle(false));
  wrap.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      settle(false);
    }
  });
}

export function confirmModal(message, opts = {}) {
  const { title = 'Are you sure?', yes = 'Confirm', danger = false } = opts;
  initConfirmModal();
  const wrap = document.getElementById('modal-confirm');
  wrap.querySelector('#confirm-title').textContent = title;
  wrap.querySelector('#confirm-msg').textContent = message;
  const okBtn = wrap.querySelector('#confirm-ok');
  okBtn.textContent = yes;
  okBtn.className = `btn-primary${danger ? ' btn-primary--danger' : ''}`;
  return new Promise(resolve => {
    // M1: a pending confirm can never be left hanging if a second one opens
    // (practically blocked by the inert background, cheap to guarantee).
    if (S.confirmResolveFn) S.confirmResolveFn(false);
    S.confirmResolveFn = resolve;
    openModal('modal-confirm');
  });
}

export function attachCombo(input, { getOptions, renderOption, onPick, renderEmpty }) {
  if (!input) return;
  input.removeAttribute('list'); // keep the native popup from stacking on ours
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-expanded', 'false');
  const listId = `${input.id}-combo`;
  input.setAttribute('aria-controls', listId);

  const list = document.createElement('div');
  list.id = listId;
  list.className = 'combo hidden';
  list.setAttribute('role', 'listbox');
  document.body.appendChild(list);

  let highlighted = -1;
  let matches = [];
  const isOpen = () => !list.classList.contains('hidden');

  const close = () => {
    list.classList.add('hidden');
    highlighted = -1;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  };

  const position = () => {
    const r = input.getBoundingClientRect();
    list.style.left = `${Math.round(r.left)}px`;
    list.style.top = `${Math.round(r.bottom + 5)}px`;
    list.style.width = `${Math.round(r.width)}px`;
  };

  const render = () => {
    matches = getOptions(input.value.trim()) || [];
    if (highlighted >= matches.length) highlighted = matches.length - 1;

    if (matches.length === 0) {
      list.innerHTML = renderEmpty
        ? renderEmpty(input.value.trim())
        : `<div class="combo__empty">No match — the typed text will be kept.</div>`;
    } else {
      list.innerHTML = matches.map((opt, i) => `
        <div class="combo__opt" role="option" id="${listId}-opt-${i}" aria-selected="${i === highlighted}" data-i="${i}">
          ${renderOption(opt)}
        </div>`).join('');
    }

    list.classList.remove('hidden');
    input.setAttribute('aria-expanded', 'true');
    if (highlighted >= 0 && matches[highlighted]) {
      input.setAttribute('aria-activedescendant', `${listId}-opt-${highlighted}`);
      list.querySelector(`#${listId}-opt-${highlighted}`)?.scrollIntoView({ block: 'nearest' });
    }
    position();
  };

  const pick = (i) => {
    const opt = matches[i];
    if (!opt) return;
    if (onPick) onPick(opt);
    else input.value = String(opt);
    close();
  };

  // mousedown (not click) + preventDefault keeps focus in the input,
  // so the blur handler below never races the selection.
  list.addEventListener('mousedown', (e) => {
    const opt = e.target.closest('.combo__opt');
    if (!opt) return;
    e.preventDefault();
    pick(Number(opt.dataset.i));
  });

  input.addEventListener('input', () => { highlighted = -1; render(); });
  input.addEventListener('focus', render);
  input.addEventListener('blur', close);

  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!isOpen()) { highlighted = -1; render(); }
      const dir = e.key === 'ArrowDown' ? 1 : -1;
      highlighted = Math.max(0, Math.min(matches.length - 1, highlighted + dir));
      render();
    } else if (e.key === 'Enter') {
      if (isOpen()) {
        e.preventDefault();
        if (highlighted >= 0) pick(highlighted);
        else close(); // typed text stands: new entry
      }
    } else if (e.key === 'Escape') {
      if (isOpen()) {
        e.stopPropagation(); // don't let it ripple into modal-close
        close();
      }
    } else if (e.key === 'Tab') {
      close();
    }
  });

  // Panels scroll independently of the page, so reposition on any scroll.
  document.addEventListener('scroll', () => { if (isOpen()) position(); }, true);
  window.addEventListener('resize', () => { if (isOpen()) position(); });
}

export function formatDateTime(dateStr) {
  const d = new Date(dateStr);
  // '--', never the raw input: this return value is interpolated into
  // innerHTML, and an unparseable stored string is not safe to echo.
  return isNaN(d.getTime()) ? '--' : d.toLocaleString([], { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function formatDateOnly(dateStr) {
  const d = new Date(dateStr);
  return isNaN(d.getTime()) ? '--' : d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}

// The one warranty rule, on this paper too, and it is src/printer.js's rule
// verbatim: the days the shop set when they read as a finite number of zero or
// more days, otherwise seven. The `|| 7` that used to sit here disagreed with
// paper's `|| 0`, and the printed slip disagreed with itself (header 7, expiry 0),
// so one sale could be handed a receipt promising a week above an expiry that was
// the sale date. Seven is what the app already stores for a shop that never set
// the field (src/db.js seeds '7' and Settings saves a blank as '7'); a saved "0"
// is a shop that did set it and said no warranty, so zero passes through instead
// of being read as unset. tests/printer.test.js pins both sides.
export function warrantyDays(days) {
  const raw = String(days ?? '').trim();
  if (!raw) return 7;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : 7;
}

export function calculateWarrantyExpiry(dateStr, days) {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return '--';
  d.setDate(d.getDate() + warrantyDays(days));
  // An overflowed calendar reads the same on both sheets: `--` here and in
  // src/printer.js, not "Invalid Date" on the screen over a blank on the roll.
  return isNaN(d.getTime()) ? '--' : d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}

// One-off single-input modal, promise-based like confirmModal.
// initialized in state.js: S.inputResolveFn
// initialized in state.js: S.inputInited
export function initInputModal() {
  if (S.inputInited) return;
  const wrap = document.getElementById('modal-input');
  if (!wrap) return;
  S.inputInited = true;
  const settle = val => {
    const resolve = S.inputResolveFn;
    S.inputResolveFn = null;
    closeModal('modal-input');
    if (resolve) resolve(val);
  };
  wrap.querySelector('#input-ok').addEventListener('click', () => settle(wrap.querySelector('#input-value').value));
  wrap.querySelector('#input-cancel').addEventListener('click', () => settle(null));
  wrap.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.stopPropagation(); settle(null); }
    if (e.key === 'Enter') settle(wrap.querySelector('#input-value').value);
  });
}

export function inputModal(title, { placeholder = '', inputType = 'text', step = '', yes = 'OK', defaultValue = '' } = {}) {
  initInputModal();
  const wrap = document.getElementById('modal-input');
  wrap.querySelector('#input-title').textContent = title;
  const valueLabel = wrap.querySelector('#input-value-label');
  if (valueLabel) valueLabel.textContent = title;
  const input = wrap.querySelector('#input-value');
  input.type = inputType;
  if (step) input.step = step;
  else input.removeAttribute('step');
  if (inputType === 'number') input.inputMode = step === 'any' ? 'decimal' : 'numeric';
  else input.removeAttribute('inputmode');
  input.value = String(defaultValue ?? '');
  input.placeholder = placeholder;
  wrap.querySelector('#input-ok').textContent = yes;
  if (S.inputResolveFn) S.inputResolveFn(null);
  return new Promise(resolve => {
    S.inputResolveFn = resolve;
    openModal('modal-input');
    setTimeout(() => { input.focus(); input.select?.(); }, 50);
  });
}

// Theme State (Default to Dark, with smooth toggle & localStorage persistence)
// Applies via applyAppearance on boot (theme.js), which reads BOTH storage
// keys — so persist the mode to the appearance blob too, or a toggle
// reverts on reload (writeAppearance owns 'techparts_appearance').
// Visual-only switch: classes + header button. Used by the 'auto' theme,
// which must not persist — the OS can flip it back at any time.
export function applyThemeVisual(theme) {
  S.currentTheme = theme;
  const isDark = theme === 'dark';
  document.documentElement.classList.toggle('dark', isDark);
  document.documentElement.classList.toggle('light', !isDark);

  const toggleBtn = document.getElementById('theme-toggle-btn');
  if (toggleBtn) {
    const label = isDark ? 'Switch to light mode' : 'Switch to dark mode';
    toggleBtn.setAttribute('aria-label', label);
    toggleBtn.setAttribute('title', label);
    toggleBtn.innerHTML = `<i class="ph ph-${isDark ? 'sun' : 'moon'} w-4 h-4"></i>`;
  }
}

// Explicit switch (header toggle, appearance settings): also persists.
export function applyTheme(theme) {
  applyThemeVisual(theme);
  // A plain light/dark switch leaves Dim/Paper; applyAppearance re-sets the tone after this.
  if (document.documentElement.dataset) document.documentElement.dataset.tone = '';
  localStorage.setItem('techparts_theme', theme);
  try {
    const app = JSON.parse(localStorage.getItem('techparts_appearance') || '{}');
    if (app.mode !== theme) {
      app.mode = theme;
      localStorage.setItem('techparts_appearance', JSON.stringify(app));
    }
  } catch (_) {}
}

export function toggleTheme() {
  applyTheme(S.currentTheme === 'dark' ? 'light' : 'dark');
}
