import { S } from './state.js';
import { addTenderedAmount, applyThemeVisual, closeModal, closeTopModal, confirmModal, currentTopModalId, debouncedViewLoad, initConfirmModal, initInputModal, initLiveClock, openModal, searchCustomers, searchInventory, searchReturns, searchSales, showToast, toggleTheme } from './ui.js';
import { applyRoleVisibility, checkLicenseStatus, clearQrImage, copyMachineId, disconnectCloud, dismissLicenseOverlay, doLogout, handleLicenseFileUpload, initLoginGateListeners, initSessionGate, loadAuditChain, loadAuditLog, loadPrinters, loadReceiptPreview, loadShopSettings, loginGateBack, openPinSetup, openSettingsModal, onSettingsQrPathInput, handleQrFileUpload, pairCloudWithCode, pasteLicenseKeyTo, probeServer, saveShopSettings, skipPinSetup, submitLicenseActivation, submitLoginPin, submitNewStaff, submitPinChange, submitPinSetup, submitPinVerification, submitSettingsLicenseActivation, closePinModal, renderStaffPanel, requireManagerPin, setElevation, deactivateStaffPrompt, resetStaffPinPrompt, switchSettingsTab, toggleCostPriceReveal, updateLicensePreview, applyBusinessPreset, syncCloudUi, openForgotPinPanel, closeForgotPinPanel, submitRecoveryPinReset, submitRecoveryPasswordChange } from './auth.js';
import { autoPrintEnabled, calculateChange, calculateCreditBalance, clearDeviceSelection, setPosBrandFilter, clearRepairOrder, completeSale, copyRepairRef, customerComboboxInit, editCartQtyPrompt, fillExactAmount, focusImeiForScan, loadCustomerSuggestions, loadPosCatalog, newRepairRef, onCustomerNameInput, onDeviceSelected, onPartSearchKeydown, onRepairIntakeInput, printClaimStub, quickAddPart, refreshDraftChip, removeCartItem, renderCartSummary, resetPosFilters, resetRepairCounter, restoreCartRecovery, saveRepairDraft, setPartCategory, setInStockOnly, setPaymentMethod, setPriceTier, toggleRepairNote, renderPartsTable, initScanListeners, resumeRepairDraft, clearRefusedScans, openScanRefusals } from './views/pos.js';
import { archiveInventoryItemPrompt, attachPartCombos, attachSkuWarning, clearInventorySelection, downloadImportTemplate, exportReorderCsv, importCsvFile, loadInventoryTable, openAddPartModal, openAdjustStockModal, openBulkEditModal, openEditPartModal, openMovementHistory, setAddItemTemplate, setupInventoryEnhancements, submitAddPart, submitAdjustStock, submitEditPart, triggerCsvImport } from './views/inventory.js';
import { editCreditLimitPrompt, fillFullSettlement, loadCustomers, loadDashboardData, loadDayClose, loadExceptions, loadSalesHistory, loadWarrantyReturnsTable, openCustomerLedger, openWarrantyReturnModal, printSettlementReceiptById, restoreBackup, shutdownServer, submitCreditSettlement, submitDayClose, submitWarrantyReturn, switchLedgerTab, toggleSettleRefInput, triggerBackup, viewSaleDetails, voidSalePrompt, checkForAppUpdates, applyAppUpdate, dismissUpdateBanner, openUpdateModal, downloadBackup } from './views/backoffice.js';
import { openShiftPrompt, closeShiftPrompt } from './views/pos.js';
import { printModalSlip, printTestReceipt, printZReport, reprintLastReceipt } from './receipts.js';
import './api.js'; // side effect: session/auth-aware fetch wrapper
import { openSearchPalette } from './search.js';
import { initAppearance, initAppearanceModal } from './theme.js';
import { openQrModal, triggerResetDemoData } from './auth.js';
import { applyLanguage, toggleLanguage, t } from './i18n.js';

// -------------------------------------------------------------
// NAVIGATION & MODALS
// -------------------------------------------------------------
const TAB_ORDER = ['pos', 'credits', 'inventory', 'returns', 'sales', 'dashboard', 'audit'];

// Workspace header titles per tab.
const TAB_META = {
  pos: { title: 'Register' },
  credits: { title: 'Customers' },
  inventory: { title: 'Inventory' },
  returns: { title: 'Warranty & returns' },
  sales: { title: 'Sales history' },
  dashboard: { title: 'Reports & profit' },
  audit: { title: 'Audit log' }
};

// Which input the top-bar search feeds, per view, plus the loader to re-run.
const VIEW_SEARCH_TARGETS = {
  pos: { input: 'pos-search-input', load: () => renderPartsTable() },
  credits: { input: 'credit-search', load: () => loadCustomers() },
  inventory: { input: 'inv-search', load: () => loadInventoryTable() },
  returns: { input: 'returns-search', load: () => loadWarrantyReturnsTable() },
  sales: { input: 'sales-search', load: () => loadSalesHistory() }
};

export function switchTab(tab) {
  if ((tab === 'dashboard' || tab === 'audit') && !S.isManagerUnlocked) {
    const label = tab === 'dashboard' ? 'Reports & Profit' : 'the audit log';
    requireManagerPin(`Enter manager PIN to view ${label}`, () => {
      switchTab(tab);
    });
    return;
  }

  S.currentTab = tab;
  TAB_ORDER.forEach(t => {
    const btn = document.getElementById(`tab-btn-${t}`);
    const view = document.getElementById(`view-${t}`);
    if (btn) {
      btn.classList.toggle('is-active', t === tab);
      btn.setAttribute('aria-current', t === tab ? 'page' : 'false');
    }
    if (view) view.classList.toggle('hidden', t !== tab);
  });

  document.body.dataset.tab = tab;

  const meta = TAB_META[tab];
  if (meta) {
    const titleEl = document.getElementById('page-title');
    if (titleEl) titleEl.textContent = t(`title.${tab}`, meta.title);
  }

  // The top-bar query belongs to whichever view is on screen, so clear it on switch.
  const globalSearch = document.getElementById('global-search');
  if (globalSearch) globalSearch.value = '';

  if (tab === 'pos') loadPosCatalog();
  if (tab === 'credits') loadCustomers();
  if (tab === 'inventory') loadInventoryTable();
  if (tab === 'returns') loadWarrantyReturnsTable();
  if (tab === 'sales') loadSalesHistory();
  if (tab === 'dashboard') loadDashboardData();
  if (tab === 'audit') { loadAuditLog(); loadAuditChain(); }

}

// Sidebar primary action: land on the repair counter with a clean job sheet.
export async function startNewSale() {
  if (S.saleInFlight) return; // sale in flight: the job on screen is the request payload
  if (S.cart.length > 0) {
    const ok = await confirmModal('The repair currently on screen will be cleared.', { title: 'Start a new repair?', yes: 'Start fresh' });
    if (!ok) {
      switchTab('pos');
      document.getElementById('pos-search-input')?.focus();
      return;
    }
  }

  resetRepairCounter();
  switchTab('pos');
  // Scan-ready: the counter's most common next move after opening a job is
  // scanning a part, and this box answers a typed search just as well.
  document.getElementById('pos-search-input')?.focus();
}

// Top-bar search is a single field that drives whichever view is open.
export function routeGlobalSearch(value) {
  let target = VIEW_SEARCH_TARGETS[S.currentTab];
  if (!target) {
    switchTab('pos');
    target = VIEW_SEARCH_TARGETS.pos;
  }

  const input = document.getElementById(target.input);
  if (input) input.value = value;
  debouncedViewLoad(target);
}

// Keep background POS server alive while browser is open (auto-exits when tab is closed)
export function sendHeartbeat() {
  fetch('/api/system/heartbeat', { method: 'POST' }).catch(() => {});
}
setInterval(sendHeartbeat, 5000);
sendHeartbeat();
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') sendHeartbeat();
});
window.addEventListener('focus', sendHeartbeat);
// ponytail: last activity ping before the tab goes away. No close signal:
// a reload fires the same events, so "closing" cannot be distinguished and
// the 120s watchdog exit stays driven by silence.
window.addEventListener('beforeunload', () => {
  try { navigator.sendBeacon('/api/system/heartbeat', '1'); } catch (_) {}
});
window.addEventListener('pagehide', () => {
  try { navigator.sendBeacon('/api/system/heartbeat', '1'); } catch (_) {}
});

// -------------------------------------------------------------
// INJECTED UI ENHANCEMENTS
// -------------------------------------------------------------
// index.html is kept static, so the audit's interface additions are wired up
// here at startup: nav hint, rail action, receipt auto-print toggle, sales
// date filter, CSV links and the end-of-day report tile.
export function initUxEnhancements() {
  // A4: table headers announce their column scope to screen readers.
  document.querySelectorAll('.ptable thead th').forEach(th => th.setAttribute('scope', 'col'));

  // Delegated listeners replacing inline onclick attrs that carried names
  // (HTML entity decoding happens before JS parsing — quotes broke the
  // handler, crafted names injected code). Names ride data-* attributes,
  // read via .dataset (never re-parsed as JS).
  document.getElementById('staff-list')?.addEventListener('click', e => {
    const btn = e.target.closest('[data-staff-act]');
    if (!btn) return;
    const id = Number(btn.dataset.staffId);
    if (btn.dataset.staffAct === 'reset') resetStaffPinPrompt(id, btn.dataset.staffName);
    else deactivateStaffPrompt(id, btn.dataset.staffName);
  });

  // V5: F2 hint on the credits nav link (every other tab shows its shortcut).
  const creditsBtn = document.getElementById('tab-btn-credits');
  if (creditsBtn) {
    const hint = document.createElement('span');
    hint.className = 'rail-link__hint';
    hint.textContent = 'F2';
    creditsBtn.insertBefore(hint, document.getElementById('nav-debtors-badge'));
  }

  // F4: reprint lives in the rail now — static button in index.html wired
  // through ACTIONS as "reprint-last".

  // W5: auto-print toggle lives in the receipt footer (Settings → Printing is
  // the other door to the same techparts_autoprint key).
  const receiptFoot = document.querySelector('#modal-receipt .modal-card__foot');
  if (receiptFoot) {
    const label = document.createElement('label');
    label.className = 'check';
    label.style.marginRight = 'auto';
    label.innerHTML = '<input type="checkbox" id="autoprint-toggle"><span>Auto-print</span>';
    receiptFoot.prepend(label);
    const cb = label.querySelector('input');
    cb.checked = autoPrintEnabled();
    cb.addEventListener('change', () => {
      localStorage.setItem('techparts_autoprint', cb.checked ? '1' : '0');
      document.querySelectorAll('[data-action="autoprint-set"]').forEach(b =>
        b.classList.toggle('is-active', (b.dataset.on === '1') === cb.checked));
    });
  }

  // W10: date filter on sales history.
  const salesRefresh = document.querySelector('#view-sales .parts-tools button');
  if (salesRefresh) {
    const dateInput = document.createElement('input');
    dateInput.type = 'date';
    dateInput.id = 'sales-date-filter';
    dateInput.className = 'select-sm';
    dateInput.title = 'Show only sales from this date';
    dateInput.addEventListener('change', loadSalesHistory);
    salesRefresh.parentElement.insertBefore(dateInput, salesRefresh);
  }

  // F1: end-of-day Z-report tile on the dashboard.
  const qaRow = document.querySelector('#view-dashboard .qa-row');
  if (qaRow) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'qa';
    b.innerHTML = `
      <span class="qa__icon" data-tone="info"><i class="ph ph-printer w-4 h-4"></i></span>
      <span class="block text-left">
        <span class="qa__title block">End-of-day report</span>
        <span class="qa__meta block">Print today's Z-report</span>
      </span>`;
    b.addEventListener('click', printZReport);
    qaRow.appendChild(b);
  }

}

export async function downloadCsvFile(url, filename) {
  try {
    const res = await fetch(url); // wrapper attaches session + elevation
    if (!res.ok) throw new Error('Export rejected');
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    return true;
  } catch (err) {
    showToast(`Error exporting: ${err.message}`, 'error');
    return false;
  }
}

export function exportInventoryCsv() {
  requireManagerPin('Enter manager PIN to export the catalog', () => downloadCsvFile('/api/inventory/export', 'inventory.csv'));
}

// -------------------------------------------------------------
// EVENT DELEGATION — one dispatcher for every data-action
// -------------------------------------------------------------
const ACTIONS = {
  'start-new-sale': () => startNewSale(),
  'switch-tab': el => switchTab(el.dataset.tab),
  'open-settings': () => openSettingsModal(),
  'open-staff-settings': () => openSettingsModal('staff'),
  'open-cloud-settings': () => openSettingsModal('cloud'),
  'disconnect-cloud': () => disconnectCloud(),
  'settings-tab': el => switchSettingsTab(el.dataset.tab),
  'setup-width': el => {
    document.querySelectorAll('[data-setup-width]').forEach(b => {
      b.classList.toggle('is-active', b === el);
      b.setAttribute('aria-pressed', b === el ? 'true' : 'false');
    });
  },
  'autoprint-set': el => {
    localStorage.setItem('techparts_autoprint', el.dataset.on);
    const on = el.dataset.on === '1';
    document.querySelectorAll('[data-action="autoprint-set"]').forEach(b =>
      b.classList.toggle('is-active', (b.dataset.on === '1') === on));
    const receiptToggle = document.getElementById('autoprint-toggle');
    if (receiptToggle) receiptToggle.checked = on;
  },
  'export-sales-csv': () => requireManagerPin('Enter manager PIN to export sales data', () => downloadCsvFile('/api/export/sales.csv', 'sales.csv')),
  'export-customers-csv': () => requireManagerPin('Enter manager PIN to export customer data', () => downloadCsvFile('/api/export/customers.csv', 'customers.csv')),
  'trigger-backup': () => triggerBackup(),
  'download-backup': () => downloadBackup(),
  'restore-backup': () => restoreBackup(),
  'check-updates': () => checkForAppUpdates(),
  'apply-update': () => applyAppUpdate(),
  'dismiss-update-banner': () => dismissUpdateBanner(),
  'open-settings-updates': () => openUpdateModal(),
  'day-close-submit': () => submitDayClose(),
  'open-audit': () => { closeModal('modal-settings'); switchTab('audit'); }, // Settings → Data link lands on the tab
  'shutdown': () => shutdownServer(),
  'logout': () => doLogout(),
  'server-retry': () => probeServer().then(ok => { if (ok) window.location.reload(); }),
  'check-license': () => checkLicenseStatus(true),
  'toggle-theme': () => toggleTheme(),
  'toggle-lang': () => toggleLanguage(),
  'clear-device': () => clearDeviceSelection(),
  'focus-imei': () => focusImeiForScan(),
  'open-add-part': () => openAddPartModal(),
  'open-scan-refusals': () => openScanRefusals(),
  'clear-scan-refusals': () => clearRefusedScans(),
  'set-add-template': el => setAddItemTemplate(el.dataset.template),
  'copy-ref': () => copyRepairRef(),
  'toggle-note': () => toggleRepairNote(),
  'set-tier': el => setPriceTier(el.dataset.tier),
  'set-payment': el => setPaymentMethod(el.dataset.method),
  'fill-exact': () => fillExactAmount(),
  'tender-add': el => { addTenderedAmount(Number(el.dataset.amount)); },
  'open-qr': () => openQrModal(),
  'clear-qr': () => clearQrImage(),
  'complete-sale': () => completeSale(),
  'hold-draft': () => saveRepairDraft(),
  'resume-draft': () => resumeRepairDraft(),
  'clear-order': () => clearRepairOrder(),
  'print-claim-stub': () => printClaimStub(),
  'reload-catalog': () => loadPosCatalog(),
  'reload-inventory': () => loadInventoryTable(),
  'quick-add-part': el => quickAddPart(Number(el.dataset.partId)),
  'edit-line-qty': el => editCartQtyPrompt(Number(el.dataset.index)),
  'remove-line': el => removeCartItem(Number(el.dataset.index)),
  'reset-pos-filters': () => resetPosFilters(),
  'pos-brand': el => setPosBrandFilter(el.dataset.brand || ''),
  'reload-customers': () => loadCustomers(),
  'reload-returns': () => loadWarrantyReturnsTable(),
  'reload-sales': () => loadSalesHistory(),
  'sales-more': () => loadSalesHistory(true),
  'reload-audit': () => loadAuditLog(),
  'reload-staff': () => renderStaffPanel(),
  'close-modal': el => closeModal(el.dataset.modal),
  'ledger-tab': el => switchLedgerTab(el.dataset.tab),
  'view-sale': el => viewSaleDetails(Number(el.dataset.saleId)),
  'open-return': el => openWarrantyReturnModal(Number(el.dataset.saleId)),
  'print-settlement': el => printSettlementReceiptById(Number(el.dataset.paymentId)),
  'edit-part': el => openEditPartModal(Number(el.dataset.partId)),
  'adjust-stock': el => openAdjustStockModal(Number(el.dataset.partId)),
  'movement-history': el => openMovementHistory(Number(el.dataset.partId)),
  'archive-part': el => archiveInventoryItemPrompt(Number(el.dataset.partId), false),
  'unarchive-part': el => archiveInventoryItemPrompt(Number(el.dataset.partId), true),
  'reveal-cost': () => toggleCostPriceReveal(),
  'export-inventory-csv': () => exportInventoryCsv(),
  'export-reorder-csv': () => exportReorderCsv(),
  'import-csv': () => triggerCsvImport(),
  'import-template': () => downloadImportTemplate(),
  'bulk-clear': () => clearInventorySelection(),
  'bulk-edit': () => openBulkEditModal(),
  'print-slip': () => printModalSlip(),
  // The receipt modal's Print button lives here, but what it prints is decided
  // in receipts.js: whichever renderer filled the modal declared its own print
  // payload through setModalSlip(), and printModalSlip() asks the queue for
  // exactly that, with the browser dialog only as the fallback and placeholder
  // shop identity stopping both. main.js keeps no copy of the slip's identity --
  // that was the stale data-sale-id this button used to trust, and the shape a
  // second slip type turned into reprinting the previous sale.
  'print-test': () => printTestReceipt(),
  'refresh-printers': () => loadPrinters(),
  'activate-license': () => submitLicenseActivation(),
  'dismiss-license': () => dismissLicenseOverlay(),
  'open-license-settings': () => openSettingsModal('data'),
  'open-license-overlay': () => { closeModal('modal-settings'); checkLicenseStatus(true); },
  'copy-machine-id': el => copyMachineId(el),
  'paste-license-key': () => pasteLicenseKeyTo('license-key-input', 'license-key-preview'),
  'paste-settings-license': () => pasteLicenseKeyTo('settings-license-key-input', 'settings-license-preview'),
  'activate-settings-license': () => submitSettingsLicenseActivation(),
  'open-pin-setup': () => openPinSetup(),
  'save-pin-setup': () => submitPinSetup(),
  'skip-pin-setup': () => skipPinSetup(),
  'login-back': () => loginGateBack(),
  'login-submit': () => submitLoginPin(),
  'forgot-pin-open': () => openForgotPinPanel(),
  'recover-pin-submit': () => submitRecoveryPinReset(),
  'recover-pin-cancel': () => closeForgotPinPanel(),
  'close-pin': () => closePinModal(),
  'verify-pin': () => submitPinVerification(),
  'reset-demo': () => triggerResetDemoData(),
  'fill-full-settlement': () => fillFullSettlement(),
  'start-sale-for-customer': () => startSaleForCustomer(),
  'open-customer': el => openCustomerLedger(el.dataset.customer),
  'edit-credit-limit': () => editCreditLimitPrompt(),
  'void-sale': el => voidSalePrompt(Number(el.dataset.saleId)),
  'shift-open': () => openShiftPrompt(),
  'shift-close': () => closeShiftPrompt(),
  'reprint-last': () => reprintLastReceipt(), // rail shortcut: no walk to Sales history
  'open-feedback': () => openFeedbackDialog(),
  'feedback-email': () => feedbackSend(FEEDBACK_URLS.email),
  'feedback-gmail': () => feedbackSend(FEEDBACK_URLS.gmail),
  'feedback-yahoo': () => feedbackSend(FEEDBACK_URLS.yahoo),
  'feedback-copy': () => feedbackCopy(),
};

document.addEventListener('click', e => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const fn = ACTIONS[el.dataset.action];
  if (fn) fn(el);
});

// -------------------------------------------------------------
// REPORT A PROBLEM / REQUEST A FEATURE
// -------------------------------------------------------------
// No backend: the report is a pre-filled email the shop sends from its own
// account. Four doors out of the dialog because a browser cannot detect
// whether this PC has a mail handler: the mail app, Gmail, Yahoo, clipboard.
const FEEDBACK_EMAIL = 'bfffpt@gmail.com';
let feedbackKind = 'problem';

async function feedbackContextLines() {
  try {
    const res = await fetch('/api/license/status');
    const d = await res.json();
    const license = d.activated
      ? `License: activated (${d.plan_type || 'plan'})${d.expires_at ? `, valid until ${d.expires_at}` : ''}`
      : d.trial_active ? `License: trial, ${d.trial_days_left} day(s) left` : 'License: not activated';
    return `App version: ${d.version || 'unknown'}\nMachine ID: ${d.machine_id || 'unknown'}\n${license}`;
  } catch (_) {
    return 'App version: unknown\nMachine ID: unknown (server not reached)';
  }
}

async function buildFeedbackReport() {
  const textEl = document.getElementById('feedback-text');
  const errEl = document.getElementById('feedback-error');
  const text = textEl?.value.trim() || '';
  if (!text) {
    if (errEl) { errEl.textContent = 'Type a few words first, so the report can be answered.'; errEl.classList.remove('hidden'); }
    textEl?.focus();
    return null;
  }
  errEl?.classList.add('hidden');
  const kindWord = feedbackKind === 'feature' ? 'Feature request' : 'Problem report';
  const subject = `${kindWord} - TechParts POS`;
  const body = `${text}\n\n---- attached automatically ----\n${await feedbackContextLines()}`;
  return { subject, body };
}

async function openFeedbackDialog() {
  const textEl = document.getElementById('feedback-text');
  const errEl = document.getElementById('feedback-error');
  if (textEl) textEl.value = '';
  errEl?.classList.add('hidden');
  openModal('modal-feedback');
  setTimeout(() => textEl?.focus(), 100);
}

async function feedbackSend(handler) {
  const report = await buildFeedbackReport();
  if (report) handler(report);
}

const FEEDBACK_URLS = {
  email: ({ subject, body }) => {
    window.location.href = `mailto:${FEEDBACK_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  },
  gmail: ({ subject, body }) => window.open(
    `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(FEEDBACK_EMAIL)}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`,
    '_blank', 'noopener'),
  yahoo: ({ subject, body }) => window.open(
    `https://compose.mail.yahoo.com/?to=${encodeURIComponent(FEEDBACK_EMAIL)}&subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`,
    '_blank', 'noopener'),
};

async function feedbackCopy() {
  const report = await buildFeedbackReport();
  if (!report) return;
  try {
    await navigator.clipboard.writeText(`To: ${FEEDBACK_EMAIL}\nSubject: ${report.subject}\n\n${report.body}`);
    showToast('Report copied. Paste it into any email or message.', 'success');
  } catch (_) {
    showToast('Could not reach the clipboard on this browser.', 'error');
  }
}

// Inputs/forms whose inline handlers were removed get wired here instead.
function initFormWiring() {
  const on = (id, ev, fn) => document.getElementById(id)?.addEventListener(ev, fn);
  document.querySelectorAll('#modal-feedback [data-feedback-kind]').forEach(btn => btn.addEventListener('click', () => {
    feedbackKind = btn.dataset.feedbackKind;
    document.querySelectorAll('#modal-feedback [data-feedback-kind]').forEach(b => b.classList.toggle('is-active', b === btn));
  }));
  on('global-search', 'input', e => routeGlobalSearch(e.target.value));
  on('login-gate-pin', 'keydown', e => { if (e.key === 'Enter') submitLoginPin(); });
  on('login-gate-name-input', 'keydown', e => { if (e.key === 'Enter') submitLoginPin(); });
  on('pin-input', 'keydown', e => { if (e.key === 'Enter') submitPinVerification(); });
  on('repair-device-input', 'input', e => onDeviceSelected(e.target.value));
  on('repair-imei', 'input', onRepairIntakeInput);
  on('pos-search-input', 'keydown', onPartSearchKeydown);
  on('pos-search-input', 'input', () => renderPartsTable());
  on('pos-category-filter', 'change', e => setPartCategory(e.target.value));
  on('pos-instock-only', 'change', e => setInStockOnly(e.target.checked));
  on('pos-customer-name', 'input', onCustomerNameInput);
  on('pos-discount', 'input', renderCartSummary);
  on('pos-tendered', 'input', calculateChange);
  on('pos-credit-downpayment', 'input', calculateCreditBalance);
  on('repair-note', 'input', onRepairIntakeInput);

  on('credit-search', 'input', searchCustomers);
  on('day-close-date', 'change', loadDayClose);
  on('credit-filter', 'change', loadCustomers);
  on('inv-search', 'input', searchInventory);
  on('inv-brand-filter', 'change', loadInventoryTable);
  on('inv-type-filter', 'change', loadInventoryTable);
  on('inv-low-stock-check', 'change', loadInventoryTable);
  on('inv-archived-check', 'change', loadInventoryTable);
  on('inv-import-file', 'change', importCsvFile);
  on('returns-search', 'input', searchReturns);
  on('returns-type-filter', 'change', loadWarrantyReturnsTable);
  on('sales-search', 'input', searchSales);
  on('sales-payment-filter', 'change', loadSalesHistory);
  on('settle-method', 'change', toggleSettleRefInput);
  // Settings > Printing: the paper preview re-renders as the choice moves.
  on('settings-template', 'change', loadReceiptPreview);
  on('settings-item-rows', 'change', loadReceiptPreview);
  on('settings-paper-width', 'change', loadReceiptPreview);
  on('settings-business-type', 'change', e => applyBusinessPreset(e.target.value));

  on('form-add-part', 'submit', submitAddPart);
  on('form-edit-part', 'submit', submitEditPart);
  on('form-adjust-stock', 'submit', submitAdjustStock);
  on('form-settle-credit', 'submit', submitCreditSettlement);
  on('form-warranty-return', 'submit', submitWarrantyReturn);
  on('form-settings', 'submit', saveShopSettings);
  // Save can be pressed from any of the five Settings tabs, but the two required
  // shop-identity fields live in Store. When that pane is display:none its empty
  // input blocks submission with no visible message (Chrome just logs
  // "not focusable"), so reveal the pane during validation and let the browser
  // report the problem normally. ponytail: always reveals Store — it holds the
  // only required fields in this form.
  document.getElementById('form-settings')?.addEventListener('invalid', () => switchSettingsTab('store'), true);
  on('settings-gcash-qr', 'input', onSettingsQrPathInput);
  on('settings-qr-file', 'change', handleQrFileUpload);
  on('license-key-input', 'input', () => updateLicensePreview('license-key-input', 'license-key-preview'));
  on('settings-license-key-input', 'input', () => updateLicensePreview('settings-license-key-input', 'settings-license-preview'));
  on('setup-license-key', 'input', () => updateLicensePreview('setup-license-key', 'setup-license-preview'));
  on('license-file-input', 'change', e => handleLicenseFileUpload(e, 'license-key-input', 'license-key-preview'));
  on('settings-license-file', 'change', e => handleLicenseFileUpload(e, 'settings-license-key-input', 'settings-license-preview'));
  on('settings-pin-btn', 'click', submitPinChange);
  on('settings-current-pin', 'keydown', e => { if (e.key === 'Enter') { e.preventDefault(); submitPinChange(); } });
  on('settings-new-pin', 'keydown', e => { if (e.key === 'Enter') { e.preventDefault(); submitPinChange(); } });
  on('settings-recovery-btn', 'click', submitRecoveryPasswordChange);
  on('settings-recovery-new', 'keydown', e => { if (e.key === 'Enter') { e.preventDefault(); document.getElementById('settings-recovery-confirm')?.focus(); } });
  on('settings-recovery-confirm', 'keydown', e => { if (e.key === 'Enter') { e.preventDefault(); submitRecoveryPasswordChange(); } });
  on('btn-pair-cloud', 'click', pairCloudWithCode);
  on('settings-pair-code', 'keydown', e => { if (e.key === 'Enter') { e.preventDefault(); pairCloudWithCode(); } });
  // Enter in the staff fields adds the person, instead of falling through to
  // the form's implicit submit (which would save shop settings).
  on('staff-new-name', 'keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); document.getElementById('staff-new-pin')?.focus(); }
  });
  on('staff-new-pin', 'keydown', e => { if (e.key === 'Enter') { e.preventDefault(); submitNewStaff(); } });
  on('login-gate-pin', 'keydown', e => { if (e.key === 'Enter') submitLoginPin(); });
  on('setup-shop-name', 'keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      document.getElementById('pin-setup-new')?.focus();
    }
  });
  on('pin-setup-new', 'input', () => document.getElementById('pin-setup-error')?.classList.add('hidden'));
  on('pin-setup-confirm', 'input', () => document.getElementById('pin-setup-error')?.classList.add('hidden'));
  on('pin-setup-recovery', 'input', () => document.getElementById('pin-setup-error')?.classList.add('hidden'));
  on('pin-setup-recovery-confirm', 'input', () => document.getElementById('pin-setup-error')?.classList.add('hidden'));
  on('pin-setup-new', 'keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      document.getElementById('pin-setup-confirm')?.focus();
    }
  });
  on('pin-setup-confirm', 'keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      document.getElementById('pin-setup-recovery')?.focus();
    }
  });
  on('pin-setup-recovery', 'keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      document.getElementById('pin-setup-recovery-confirm')?.focus();
    }
  });
  on('pin-setup-recovery-confirm', 'keydown', e => { if (e.key === 'Enter') submitPinSetup(); });
  on('recover-pw', 'input', () => document.getElementById('recover-error')?.classList.add('hidden'));
  on('recover-new-pin', 'input', () => document.getElementById('recover-error')?.classList.add('hidden'));
  on('recover-confirm-pin', 'input', () => document.getElementById('recover-error')?.classList.add('hidden'));
  on('recover-pw', 'keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      document.getElementById('recover-new-pin')?.focus();
    }
  });
  on('recover-new-pin', 'keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      document.getElementById('recover-confirm-pin')?.focus();
    }
  });
  on('recover-confirm-pin', 'keydown', e => { if (e.key === 'Enter') submitRecoveryPinReset(); });
  on('pin-input', 'keydown', e => { if (e.key === 'Enter') submitPinVerification(); });
}

// -------------------------------------------------------------
// INITIALIZATION
// -------------------------------------------------------------
S.sessionToken = sessionStorage.getItem('pos_session') || null;
// Restore the elevation token saved by setElevation so a manager session
// revived after F5 stays unlocked (expired entries are dropped, not reused).
try {
  const savedElevation = JSON.parse(sessionStorage.getItem('pos_elevation') || 'null');
  if (savedElevation?.t && Number(savedElevation.e) > Date.now()) setElevation(savedElevation.t, Number(savedElevation.e));
  else sessionStorage.removeItem('pos_elevation');
} catch (_) { try { sessionStorage.removeItem('pos_elevation'); } catch (_) {} }
S.currentTheme = localStorage.getItem('techparts_theme') || 'dark';
S.repairRefCode = newRepairRef();
// Appearance (accent/scale/density) applies before first paint too.
initAppearance();
// Run before first paint so light-theme users don't get a dark flash.
// Visual-only: an 'auto' theme resolves to whatever the OS says and must
// never be written back as an explicit choice.
applyThemeVisual(S.currentTheme);

document.addEventListener('DOMContentLoaded', async () => {
  initLiveClock();
  applyLanguage();

  // The POS launcher opens this URL with #kiosk=1; sessionStorage keeps the
  // marker per-tab, so a manually opened tab correctly reports that it can
  // only print through the dialog.
  if (location.hash.includes('kiosk=1')) sessionStorage.setItem('pos_kiosk', '1');

  // index.html is kept static, so screen-reader and debounce wiring happens here.
  const toastBox = document.getElementById('toast-container');
  if (toastBox) {
    toastBox.setAttribute('role', 'status');
    toastBox.setAttribute('aria-live', 'polite');
  }

  initFormWiring();
  initAppearanceModal();
  initMobileNav();
  initLoginGateListeners();
  customerComboboxInit();
  attachPartCombos({ brandId: 'part-brand', modelId: 'part-model', typeId: 'part-type' });
  attachSkuWarning('part-sku', 'part-sku-warn');
  attachPartCombos({ brandId: 'edit-part-brand', modelId: 'edit-part-model', typeId: 'edit-part-type' });
  attachSkuWarning('edit-part-sku', 'edit-part-sku-warn', () => Number(document.getElementById('edit-part-id')?.value || 0));
  initConfirmModal();
  initInputModal();
  document.getElementById('staff-add-btn')?.addEventListener('click', submitNewStaff);
  initUxEnhancements();
  setupInventoryEnhancements();
  initScanListeners();

  // Health probe before anything else touches the API: a dead or unreachable
  // server must be announced with a retry — not silently mistaken for a login
  // problem while the user stares at an inert gate.
  if (!(await probeServer())) return;

  // Check license first (its overlay renders above the login gate)
  await checkLicenseStatus();

  // Mandatory login before anything else touches the API
  await initSessionGate();

  applyRoleVisibility();

  await loadShopSettings();
  // Recover before catalog rendering persists the initially empty cart.
  restoreCartRecovery();
  await loadPosCatalog();
  await loadCustomerSuggestions();
  refreshDraftChip();
  // Dashboard data loads lazily via switchTab('dashboard') — it is
  // manager-elevation-gated server-side now.

  // Disable browser context menu across kiosk workstation
  window.addEventListener('contextmenu', (e) => e.preventDefault(), { capture: true });
  window.addEventListener('dragover', (e) => e.preventDefault(), { capture: true });
  window.addEventListener('drop', (e) => e.preventDefault(), { capture: true });
  window.addEventListener('wheel', (e) => {
    if (e.ctrlKey) e.preventDefault();
  }, { passive: false, capture: true });

  // Global Keyboard Shortcuts
  window.addEventListener('keydown', (e) => {
    const isCtrl = e.ctrlKey || e.metaKey;
    const lowerKey = e.key.toLowerCase();

    // DevTools inspection
    if (e.key === 'F12' || (isCtrl && e.shiftKey && ['i', 'j', 'c'].includes(lowerKey))) {
      e.preventDefault();
      return;
    }

    // Page reload and history traversal
    if (e.key === 'F5' || (isCtrl && lowerKey === 'r')) {
      e.preventDefault();
      return;
    }
    if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault();
      return;
    }
    if (e.key === 'Backspace' && !['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName) && !document.activeElement?.isContentEditable) {
      e.preventDefault();
      return;
    }

    // Browser print (POS uses ESC/POS thermal pipeline)
    if (isCtrl && lowerKey === 'p') {
      e.preventDefault();
      return;
    }

    // Browser in-page find: route to POS palette. F3 is not hijacked here: the
    // rail advertises it as the Inventory switch and that branch would be dead.
    if (isCtrl && lowerKey === 'f') {
      e.preventDefault();
      openSearchPalette();
      return;
    }

    // Browser page, tab, and flyout shortcuts
    if (isCtrl && ['s', 'u', 'o', 'n', 't', 'w', 'h', 'j', 'd'].includes(lowerKey)) {
      e.preventDefault();
      return;
    }

    // Edge specific panels: Web Capture, Read Aloud, Collections
    if (isCtrl && e.shiftKey && ['s', 'u', 'y'].includes(lowerKey)) {
      e.preventDefault();
      return;
    }

    // Browser zoom
    if (isCtrl && ['+', '-', '=', '0'].includes(e.key)) {
      e.preventDefault();
      return;
    }

    // Fullscreen and caret browsing
    if (e.key === 'F11') {
      e.preventDefault();
      return;
    }

    if (e.key === 'Escape') {
      const licenseOverlay = document.getElementById('license-overlay');
      if (licenseOverlay && !licenseOverlay.classList.contains('hidden') && !S.licenseRequired) {
        dismissLicenseOverlay();
        return;
      }
      // Escape retires exactly ONE layer: a confirm stacked on the receipt
      // modal must not tear the receipt down beneath it.
      const top = currentTopModalId();
      if (top && !['pin-setup-overlay', 'license-overlay', 'login-gate'].includes(top)) {
        if (top === 'modal-pin') closePinModal();
        else closeTopModal(); // via closeTopModal so inert/focus state is cleaned up
        return;
      }
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) {
        document.activeElement.blur();
      }
      return;
    }

    // Shortcuts stand down while any modal or gate is up: an F9 behind the
    // receipt modal must never start a second sale, and shortcut keys must not
    // fight an open dialog for focus.
    const overlayOpen = document.querySelector('.modal-backdrop:not(.hidden)')
      || ['server-down-overlay', 'license-overlay', 'pin-setup-overlay', 'login-gate']
        .some(id => { const el = document.getElementById(id); return el && !el.classList.contains('hidden'); });
    if (overlayOpen) return;

    if (e.key === 'F1') { e.preventDefault(); switchTab('pos'); return; }
    if (e.key === 'F2') { e.preventDefault(); switchTab('credits'); return; }
    if (e.key === 'F3') { e.preventDefault(); switchTab('inventory'); return; }
    if (e.key === 'F4') { e.preventDefault(); switchTab('returns'); return; }
    if (e.key === 'F8') { e.preventDefault(); switchTab('sales'); return; }
    // F7: audit tab — staff have the button hidden, so the key follows it.
    if (e.key === 'F7') {
      e.preventDefault();
      if (!document.getElementById('tab-btn-audit')?.classList.contains('hidden')) {
        switchTab('audit');
      }
      return;
    }

    // Phone repair counter shortcuts (POS tab)
    if (S.currentTab === 'pos') {
      if (e.key === 'F9') { e.preventDefault(); completeSale(); return; }
      if (e.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) {
        e.preventDefault();
        document.getElementById('pos-search-input')?.focus();
        return;
      }
      if (e.altKey && !e.ctrlKey && !e.metaKey) {
        if (lowerKey === 'c') {
          e.preventDefault();
          const cust = document.getElementById('pos-customer-name');
          if (cust) { cust.focus(); cust.select(); }
          return;
        }
        if (lowerKey === 'n') {
          e.preventDefault();
          toggleRepairNote();
          return;
        }
        if (lowerKey === 't') {
          e.preventDefault();
          setPriceTier(S.currentPriceTier === 'retail' ? 'technician' : 'retail');
          return;
        }
        if (e.key === '1') {
          e.preventDefault();
          setPaymentMethod('cash');
          const el = document.getElementById('pos-tendered');
          if (el) { el.focus(); el.select(); }
          return;
        }
        if (e.key === '2') {
          e.preventDefault();
          setPaymentMethod('gcash');
          const el = document.getElementById('pos-gcash-ref');
          if (el) { el.focus(); el.select(); }
          return;
        }
        if (e.key === '3') {
          e.preventDefault();
          setPaymentMethod('credit');
          const el = document.getElementById('pos-credit-downpayment');
          if (el) { el.focus(); el.select(); }
          return;
        }
        if (e.key === '4') {
          e.preventDefault();
          setPaymentMethod('transfer');
          const el = document.getElementById('pos-transfer-ref');
          if (el) { el.focus(); el.select(); }
          return;
        }
        if (lowerKey === 'e') {
          e.preventDefault();
          fillExactAmount();
          return;
        }
        if (lowerKey === 'x') {
          e.preventDefault();
          clearRepairOrder();
          return;
        }
        if (lowerKey === 'h') {
          e.preventDefault();
          saveRepairDraft();
          return;
        }
        if (lowerKey === 'r') {
          e.preventDefault();
          resumeRepairDraft();
          return;
        }
        if (lowerKey === 'p') {
          e.preventDefault();
          printClaimStub();
          return;
        }
      }
    }

    if (e.altKey && !e.ctrlKey && !e.metaKey && lowerKey === 'a') {
      if (S.currentTab === 'pos' || S.currentTab === 'inventory') {
        e.preventDefault();
        openAddPartModal();
        return;
      }
    }
  }, { capture: true });

  // Close modals when clicking backdrop outside dialog card
  document.addEventListener('click', (e) => {
    if (e.target?.id === 'license-overlay' && !S.licenseRequired) {
      dismissLicenseOverlay();
      return;
    }
    if (e.target && e.target.classList && e.target.classList.contains('modal-backdrop')) {
      if (!['pin-setup-overlay', 'license-overlay', 'login-gate'].includes(e.target.id)) {
        if (e.target.id === 'modal-pin') closePinModal();
        else closeModal(e.target.id);
      }
    }
  });
});


// Customer 360 drawer action: prefill the counter with this customer and land there.
export async function startSaleForCustomer() {
  if (S.saleInFlight) return; // sale in flight: the job on screen is the request payload
  const name = document.getElementById('ledger-customer-name')?.textContent?.trim();
  const phone = (document.getElementById('ledger-customer-phone')?.textContent || '').replace(/^Phone:\s*/, '').trim();
  if (!name) return;
  if (S.cart.length > 0) {
    const ok = await confirmModal('The repair currently on screen will be cleared for this customer.', { title: 'Start a new repair?', yes: 'Start fresh' });
    if (!ok) return;
  }
  resetRepairCounter();
  switchTab('pos');
  const nameEl = document.getElementById('pos-customer-name');
  if (nameEl) nameEl.value = name;
  if (phone && phone !== 'None provided') {
    const phoneEl = document.getElementById('pos-customer-phone');
    if (phoneEl) phoneEl.value = phone;
  }
  closeModal('modal-customer-ledger');
  onCustomerNameInput();
  nameEl?.focus();
}


// -------------------------------------------------------------
// MOBILE NAV — under 820px the rail becomes a slide-out drawer
// with a hamburger in the topbar; under 480px a bottom tab bar
// replaces it entirely.
// -------------------------------------------------------------
function initMobileNav() {
  const rail = document.querySelector('.rail');
  const topbar = document.querySelector('.topbar__head');
  if (!rail || !topbar) return;

  // Hamburger + scrim (CSS only shows them under 820px)
  const burger = document.createElement('button');
  burger.type = 'button';
  burger.className = 'rail-toggle';
  burger.setAttribute('aria-label', 'Open menu');
  burger.setAttribute('aria-expanded', 'false');
  burger.innerHTML = '<i class="ph ph-list w-5 h-5"></i>';
  const scrim = document.createElement('div');
  scrim.className = 'rail-scrim hidden';

  const closeRail = () => {
    rail.classList.remove('is-open');
    scrim.classList.add('hidden');
    burger.setAttribute('aria-expanded', 'false');
  };

  burger.addEventListener('click', () => {
    const open = rail.classList.toggle('is-open');
    scrim.classList.toggle('hidden', !open);
    burger.setAttribute('aria-expanded', String(open));
  });
  scrim.addEventListener('click', closeRail);

  topbar.prepend(burger);
  document.body.appendChild(scrim);

  // Any rail navigation closes the drawer.
  rail.addEventListener('click', e => {
    if (e.target.closest('.rail-link, .rail-cta')) closeRail();
  });

  // Bottom tab bar (CSS shows it under 480px).
  const tabBar = document.createElement('nav');
  tabBar.className = 'tabbar';
  tabBar.setAttribute('aria-label', 'Sections');
  const TABS = [
    ['pos', 'Repair', 'calculator'],
    ['credits', 'Customers', 'users'],
    ['inventory', 'Stock', 'package'],
    ['sales', 'Sales', 'receipt'],
  ];
  tabBar.innerHTML = TABS.map(([id, label, icon]) =>
    `<button type="button" data-action="switch-tab" data-tab="${id}" data-tabbar="${id}"><i class="ph ph-${icon}"></i><span>${label}</span></button>`
  ).join('');
  document.body.appendChild(tabBar);

  // Keep tabbar buttons in sync with the active tab.
  const syncTabbar = () => {
    tabBar.querySelectorAll('[data-tabbar]').forEach(b =>
      b.classList.toggle('is-active', b.dataset.tabbar === S.currentTab));
  };
  const origSwitch = switchTab;
  // wrap: switchTab is imported; monkey-patch not possible on import binding —
  // instead observe clicks + a MutationObserver-free interval is overkill:
  // the delegated switch-tab action above already fires; sync on every tab action:
  document.addEventListener('click', e => {
    if (e.target.closest('[data-action="switch-tab"]')) setTimeout(syncTabbar, 0);
  });
  syncTabbar();

}

// -------------------------------------------------------------
// CLOUD SYNC CHIP — mirrors /api/sync/status in the topbar. Hidden
// while sync is off so the offline-first default stays visually quiet.
// -------------------------------------------------------------
export async function refreshSyncChip() {
  const chip = document.getElementById('sync-status-chip');
  try {
    const res = await fetch('/api/sync/status');
    if (res.status === 401 || res.status === 403) {
      if (chip) chip.classList.add('hidden');
      syncCloudUi({ offline: true });
      return;
    }
    if (!res.ok) throw new Error('status unavailable');
    const s = await res.json();
    syncCloudUi(s);
    if (!chip) return;
    if (!s.url_configured) { chip.classList.add('hidden'); return; }
    chip.classList.remove('hidden');
    const n = s.pending || 0;
    const labels = {
      synced: 'Cloud synced',
      syncing: `Syncing ${n} change${n === 1 ? '' : 's'}`,
      attention: `${n} change${n === 1 ? '' : 's'} queued`,
      local: 'Local only'
    };
    // 'synced' only means the last push/heartbeat was accepted; a fresh
    // last_error (e.g. the shop was unlinked on the cloud) overrides it.
    chip.textContent = (s.state === 'synced' && s.last_error)
      ? 'Cloud sync error'
      : (labels[s.state] || 'Cloud sync');
    if (s.in_flight) {
      chip.textContent = n > 0 ? `Syncing ${n} change${n === 1 ? '' : 's'}...` : 'Syncing...';
    } else if (s.state === 'synced' && !s.last_error && s.stale) {
      chip.textContent = 'Cloud stale';
    }
    chip.classList.remove('is-synced', 'is-syncing', 'is-error', 'is-local');
    if (s.in_flight || s.state === 'syncing') chip.classList.add('is-syncing');
    else if (s.last_error || s.state === 'attention') chip.classList.add('is-error');
    else if (s.state === 'local') chip.classList.add('is-local');
    else if (s.state === 'synced' && !s.stale) chip.classList.add('is-synced');
    chip.title = `Cloud sync: ${chip.textContent}`
      + (s.last_synced_at ? `. Last push: ${new Date(s.last_synced_at).toLocaleString()}` : '')
      + (s.last_error ? `. Last error: ${s.last_error}` : '');
  } catch (_) {
    syncCloudUi({ offline: true });
    if (chip) {
      chip.classList.remove('is-synced', 'is-syncing', 'is-local');
      chip.classList.add('is-error');
      chip.textContent = 'Sync offline';
    }
  }
}
window.refreshSyncChip = refreshSyncChip;
refreshSyncChip();
setInterval(refreshSyncChip, 30000);
checkForAppUpdates(true);

try {
  if (sessionStorage.getItem('tp_update_complete')) {
    sessionStorage.removeItem('tp_update_complete');
    setTimeout(() => {
      showToast('Update complete! TechParts POS has been updated.', 'success');
    }, 400);
  }
} catch (_) {}
