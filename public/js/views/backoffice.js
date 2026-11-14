import { S } from '../state.js';
import { t } from '../i18n.js';
import { closeModal, confirmModal, escHtml, fmtMoney, formatDateOnly, formatDateTime, inputModal, openModal, showSkeleton, showToast, warrantyDays } from '../ui.js';
import { hasElevation, requireManagerPin, syncCloudUi } from '../auth.js';
import { autoPrintEnabled, formatPhPhone, loadCustomerSuggestions, loadPosCatalog } from '../views/pos.js';
import { autoPrintSlip, printPeriodSummary, printSlip, renderReceipt, renderSettlementReceipt, shopIdentityIsPlaceholder } from '../receipts.js';
import { renderTrendChart } from '../chart.js';
import { loadInventoryTable } from '../views/inventory.js';

let returnsRequest = 0;
let customersRequest = 0;
let salesRequest = 0;
let dashboardRequest = 0;
let exceptionsRequest = 0;

// -------------------------------------------------------------
// WARRANTY & RETURNS LOGIC
// -------------------------------------------------------------
export async function loadWarrantyReturnsTable() {
  const request = ++returnsRequest;
  const search = document.getElementById('returns-search')?.value || '';
  const filter = document.getElementById('returns-type-filter')?.value || '';
  showSkeleton('returns-tbody', 8);

  let url = `/api/returns?search=${encodeURIComponent(search)}`;
  if (filter) url += `&return_type=${encodeURIComponent(filter)}`;

  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error('Returns request failed');
    const returns = await res.json();
    if (request !== returnsRequest) return;
    renderWarrantyReturnsTable(returns);
  } catch (err) {
    if (request !== returnsRequest) return;
    console.error('Failed to load returns:', err);
    const tbody = document.getElementById('returns-tbody');
    if (tbody && tbody.querySelector('.skel')) {
      tbody.innerHTML = `<tr><td colspan="8">
        <div class="empty">
          <div class="empty__icon"><i class="ph ph-wifi-slash w-5 h-5"></i></div>
          <div class="empty__title">Couldn't load returns</div>
          <p class="empty__body">The server didn't answer. Retry, or check that the POS server is running.</p>
          <button type="button" class="chip" data-action="reload-returns">Retry</button>
        </div>
      </td></tr>`;
    }
    showToast('Could not load returns — check the server and retry', 'error');
  }
}

export function renderWarrantyReturnsTable(returns) {
  const tbody = document.getElementById('returns-tbody');
  if (!tbody) return;

  if (returns.length === 0) {
    tbody.innerHTML = `
      <tr><td colspan="8">
        <div class="empty">
          <div class="empty__icon"><i class="ph ph-shield-check w-5 h-5"></i></div>
          <div class="empty__title">No returns logged</div>
          <p class="empty__body">Process a return from Sales history and it will appear here.</p>
        </div>
      </td></tr>
    `;
    return;
  }

  tbody.innerHTML = returns.map(r => {
    let actionBadge = '';
    if (r.return_type === 'replacement') {
      actionBadge = `<span class="tag tag--info">Part replacement</span>`;
    } else if (r.return_type === 'credit_refund') {
      actionBadge = `<span class="tag tag--warn">Credit deduction</span>`;
    } else {
      actionBadge = `<span class="tag tag--danger">Cash refund</span>`;
    }

    const isWalkIn = !r.customer_name || r.customer_name.toLowerCase() === 'walk-in customer';
    const custDisplay = isWalkIn
      ? escHtml(r.customer_name || 'Walk-in Customer')
      : `<button type="button" class="linkish font-bold text-left" data-action="open-customer" data-customer="${escHtml(r.customer_name)}" title="Open customer panel">${escHtml(r.customer_name)}</button>`;

    const saleDisplay = r.sale_id
      ? `<div class="foot-note font-mono text-xs">Sale: <button type="button" class="linkish font-mono" data-action="view-sale" data-sale-id="${r.sale_id}" title="View original receipt">${escHtml(r.sale_code || '#' + r.sale_id)}</button></div>`
      : '';

    const qtyDisplay = (r.quantity && r.quantity > 1)
      ? ` <span class="tag text-xs font-mono font-bold">x${r.quantity}</span>`
      : '';

    return `
      <tr>
        <td class="font-mono font-bold">
          <div>${escHtml(r.return_code)}</div>
          ${saleDisplay}
        </td>
        <td class="font-mono whitespace-nowrap text-xs">${formatDateTime(r.created_at)}</td>
        <td>${custDisplay}</td>
        <td>${escHtml(r.item_name)}${qtyDisplay}</td>
        <td class="font-mono capitalize"><span class="tag tag--warn">${escHtml(r.return_reason.replace(/_/g, ' '))}</span></td>
        <td class="is-mid">${actionBadge}</td>
        <td class="is-num font-mono font-bold">${fmtMoney(Number(r.refund_amount))}</td>
        <td class="foot-note">${escHtml(r.technician_notes || '--')}</td>
      </tr>
    `;
  }).join('');

}

// Idempotency keys (mirror of pos.js's saleOpId): a network failure after the
// server committed must not double-apply when the user retries. Generated when
// the intent starts, reused across retries and PIN prompts, cleared on success.
const newOpId = () => (globalThis.crypto?.randomUUID?.() || `op-${Date.now()}-${Math.random().toString(36).slice(2)}`);
let pendingReturnOpId = null;
let pendingSettleOpId = null;
let pendingSettleCustomer = null;

let currentReturnSaleItems = [];

export function getDefectReasonsForPart(partType = '', itemName = '') {
  const text = `${partType} ${itemName}`.toLowerCase();

  if (/lcd|screen|oled|amoled|display|incell|touch/.test(text)) {
    return [
      { value: 'ghost_touch', label: 'Ghost Touch / Auto-touching' },
      { value: 'touch_dead_spots', label: 'Touch Screen Dead Spots' },
      { value: 'no_display', label: 'No Display / Black Screen' },
      { value: 'lines_flickering', label: 'Display Lines / Flickering' },
      { value: 'dead_pixels', label: 'Dead Pixels / Screen Bleed' },
      { value: 'wrong_item', label: 'Wrong Part Ordered' },
      { value: 'other', label: 'Other Defect / Reason' }
    ];
  }

  if (/battery|batt/.test(text)) {
    return [
      { value: 'battery_drain', label: 'Fast Drain / Low Battery Health' },
      { value: 'not_charging', label: 'Not Charging / Will Not Power On' },
      { value: 'swollen_battery', label: 'Swollen / Bloated Battery' },
      { value: 'sudden_shutdown', label: 'Sudden Shutdown / Restarting' },
      { value: 'wrong_item', label: 'Wrong Part Ordered' },
      { value: 'other', label: 'Other Defect / Reason' }
    ];
  }

  if (/charg|port|flex|dock|sub-board|usb/.test(text)) {
    return [
      { value: 'loose_port', label: 'Loose Port / Intermittent Connection' },
      { value: 'no_charging', label: 'Not Charging / No Power Input' },
      { value: 'slow_charging', label: 'Slow Charging / No Fast Charge' },
      { value: 'mic_issue', label: 'Microphone / Call Audio Defective' },
      { value: 'wrong_item', label: 'Wrong Part Ordered' },
      { value: 'other', label: 'Other Defect / Reason' }
    ];
  }

  if (/camera|cam|lens/.test(text)) {
    return [
      { value: 'blurry_focus', label: 'Blurry / Focus Failure' },
      { value: 'black_camera', label: 'Black Screen / Camera App Error' },
      { value: 'camera_vibration', label: 'Camera Shaking / OIS Defect' },
      { value: 'wrong_item', label: 'Wrong Part Ordered' },
      { value: 'other', label: 'Other Defect / Reason' }
    ];
  }

  if (/back cover|housing|glass|frame/.test(text)) {
    return [
      { value: 'fit_alignment', label: 'Poor Fit / Alignment Issue' },
      { value: 'cosmetic_defect', label: 'Factory Scratch / Cosmetic Defect' },
      { value: 'wrong_item', label: 'Wrong Part Ordered' },
      { value: 'other', label: 'Other Defect / Reason' }
    ];
  }

  return [
    { value: 'defective_part', label: 'Defective / Malfunctioning' },
    { value: 'wrong_item', label: 'Wrong Part Ordered' },
    { value: 'other', label: 'Other Defect / Reason' }
  ];
}

export function syncReturnDefectAndQuantity() {
  const select = document.getElementById('return-item-select');
  const selectedId = Number(select?.value);
  const item = currentReturnSaleItems.find(it => it.id === selectedId);
  if (!item) return;

  const returnable = Math.max(0, Math.round((item.quantity - (item.returned_quantity || 0)) * 1000) / 1000);
  const qtyInput = document.getElementById('return-quantity');
  const qtyHint = document.getElementById('return-quantity-hint');
  if (qtyInput) {
    qtyInput.max = returnable;
    if (Number(qtyInput.value) > returnable || Number(qtyInput.value) < 0.001) {
      qtyInput.value = Math.min(1, returnable) || 0.001;
    }
  }
  if (qtyHint) {
    qtyHint.textContent = `Max: ${returnable} unit${returnable > 1 ? 's' : ''} (ordered: ${item.quantity}${item.returned_quantity > 0 ? `, returned: ${item.returned_quantity}` : ''})`;
  }

  const reasonSelect = document.getElementById('return-reason');
  if (reasonSelect) {
    const reasons = getDefectReasonsForPart(item.part_type || '', item.item_name || '');
    const currentReason = reasonSelect.value;
    reasonSelect.innerHTML = reasons.map(r => `
      <option value="${escHtml(r.value)}" ${r.value === currentReason ? 'selected' : ''}>
        ${escHtml(r.label)}
      </option>
    `).join('');
  }
}

document.getElementById('return-item-select')?.addEventListener('change', syncReturnDefectAndQuantity);

export async function openWarrantyReturnModal(saleId, preselectedItemId = null) {
  pendingReturnOpId = newOpId();
  try {
    const res = await fetch(`/api/sales/${saleId}`);
    if (!res.ok) throw new Error('Sale details not found');
    const sale = await res.json();

    document.getElementById('return-sale-id').value = sale.id;
    document.getElementById('return-modal-sale-code').textContent = sale.sale_code;
    document.getElementById('return-modal-sale-date').textContent = formatDateTime(sale.created_at);
    document.getElementById('return-modal-customer').textContent = sale.customer_name;

    currentReturnSaleItems = (sale.items || []).filter(it => it.item_type !== 'labor'); // Only physical parts can be returned

    const select = document.getElementById('return-item-select');
    if (select) {
      select.innerHTML = currentReturnSaleItems
        .map(it => {
          const returnable = Math.max(0, it.quantity - (it.returned_quantity || 0));
          return `
            <option value="${escHtml(it.id)}" ${preselectedItemId === it.id ? 'selected' : ''} ${returnable <= 0 ? 'disabled' : ''}>
              ${escHtml(it.item_name)} (${returnable <= 0 ? 'Fully returned' : `Available: ${returnable} of ${it.quantity}`}, Price: ${fmtMoney(Number(it.unit_price))})
            </option>
          `;
        }).join('');

      if (select.selectedOptions[0]?.disabled) {
        const availableOpt = Array.from(select.options).find(o => !o.disabled);
        if (availableOpt) availableOpt.selected = true;
      }
    }

    syncReturnDefectAndQuantity();

    // F3: warranty expiry hint — the system remembers so the clerk doesn't
    // have to. Only surfaces when the sale is actually past its window. The hint
    // reads the one warranty rule (ui.js's warrantyDays, the twin of the copy
    // src/printer.js prints from) instead of `Number(...) || 7`: that `||` turned
    // a saved 0 back into a week, so a no-warranty sale got no hint here and then
    // src/returns.js refused the return this screen never warned about.
    document.getElementById('rma-warranty-hint')?.remove();
    const wDays = warrantyDays(S.shopSettings.warranty_days);
    const wExpiry = new Date(sale.created_at);
    if (!isNaN(wExpiry.getTime())) {
      wExpiry.setDate(wExpiry.getDate() + wDays);
      if (new Date() > wExpiry) {
        document.getElementById('return-item-select')?.closest('.field')
          ?.insertAdjacentHTML('beforebegin', `
            <div class="note-box note-box--warn" id="rma-warranty-hint">
              <i class="ph ph-warning w-4 h-4"></i>
              <span>Sold ${formatDateOnly(sale.created_at)} — outside the ${wDays}-day warranty. Re-check the policy before approving.</span>
            </div>`);
      }
    }

    openModal('modal-warranty-return');
  } catch (err) {
    showToast(`Error: ${err.message}`, 'error');
  }
}

let returnInFlight = false;
export async function submitWarrantyReturn(e) {
  e.preventDefault();
  const saleId = document.getElementById('return-sale-id').value;
  const saleItemId = document.getElementById('return-item-select').value;
  const returnType = document.getElementById('return-action').value;
  const returnReason = document.getElementById('return-reason').value;
  const quantity = Math.max(0.001, parseFloat(document.getElementById('return-quantity')?.value) || 1);
  const notes = document.getElementById('return-notes').value;

  if (!saleItemId) {
    showToast('Select a physical part to return', 'warning');
    return;
  }

  // Cash refunds take money out of the drawer: fresh manager PIN first.
  if (returnType === 'cash_refund' && !hasElevation()) {
    requireManagerPin('Enter manager PIN to authorize a cash refund', () => submitWarrantyReturn(e));
    return;
  }

  if (returnInFlight) return;
  returnInFlight = true;
  try {
    const res = await fetch(`/api/sales/${saleId}/returns`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sale_item_id: Number(saleItemId),
        quantity: quantity,
        return_type: returnType,
        return_reason: returnReason,
        technician_notes: notes,
        op_id: pendingReturnOpId
      })
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Failed to process return');
    }

    const returnData = await res.json();
    pendingReturnOpId = null;
    closeModal('modal-warranty-return');
    showToast(`Return ${returnData.return_code} processed successfully`, 'success');

    loadWarrantyReturnsTable();
    loadSalesHistory();
    loadPosCatalog();
    loadInventoryTable();
    loadDashboardData();
    loadCustomers();
    if (S.activeCustomerDetails?.customer_name) {
      openCustomerLedger(S.activeCustomerDetails.customer_name).catch(() => {});
    }
  } catch (err) {
    showToast(`Error: ${err.message}`, 'error');
  } finally {
    returnInFlight = false;
  }
}

// -------------------------------------------------------------
// CUSTOMER CREDITS (UTANG) MANAGEMENT
// -------------------------------------------------------------
export async function loadCustomers() {
  const request = ++customersRequest;
  const search = document.getElementById('credit-search')?.value || '';
  const filter = document.getElementById('credit-filter')?.value || '';
  showSkeleton('customers-tbody', 5);

  let url = `/api/customers?search=${encodeURIComponent(search)}`;
  if (filter) url += `&filter=${encodeURIComponent(filter)}`;

  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error('Customers request failed');
    const customers = await res.json();
    if (request !== customersRequest) return;
    renderCustomersTable(customers);
    updateCreditMetricCards(customers);
    loadNameVariants();
  } catch (err) {
    if (request !== customersRequest) return;
    console.error('Failed to load customers:', err);
    const tbody = document.getElementById('customers-tbody');
    if (tbody && tbody.querySelector('.skel')) {
      tbody.innerHTML = `<tr><td>
        <div class="empty">
          <div class="empty__icon"><i class="ph ph-wifi-slash w-5 h-5"></i></div>
          <div class="empty__title">Couldn't load customers</div>
          <p class="empty__body">The server didn't answer. Retry, or check that the POS server is running.</p>
          <button type="button" class="chip" data-action="reload-customers">Retry</button>
        </div>
      </td></tr>`;
    }
    showToast('Could not load customers — check the server and retry', 'error');
  }
}

// Reads treat the spellings as one debtor already; this is the owner's review
// list, and where two people sharing a name become visible.
async function loadNameVariants() {
  const box = document.getElementById('credit-name-variants');
  if (!box || !hasElevation()) return;
  try {
    const res = await fetch('/api/customers/name-variants');
    if (!res.ok) return;
    const groups = await res.json();
    if (!groups.length) {
      box.classList.add('hidden');
      box.textContent = '';
      return;
    }
    const worst = groups[0];
    box.textContent = `${groups.length} customer name${groups.length === 1 ? '' : 's'} spelled more than one way `
      + `(for example ${worst.variants.join(' and ')}). They are counted as one debtor; the spelling on each receipt still differs.`;
    box.classList.remove('hidden');
  } catch (_) {
    // Informational only: a failed read must not look like a failed ledger.
    box.classList.add('hidden');
  }
}

export function updateCreditMetricCards(customers) {
  let totalOutstanding = 0;
  let activeDebtors = 0;

  customers.forEach(c => {
    totalOutstanding += c.total_credit_balance;
    if (c.total_credit_balance > 0.001) activeDebtors += 1;
  });

  const countEl = document.getElementById('customers-total-count');
  const utangEl = document.getElementById('customers-active-utang');
  const outEl = document.getElementById('credit-total-outstanding');
  const navBadge = document.getElementById('nav-debtors-badge');

  if (countEl) countEl.textContent = customers.length;
  if (utangEl) utangEl.textContent = activeDebtors;
  if (outEl) outEl.textContent = `${fmtMoney(totalOutstanding)}`;

  const activeCard = document.getElementById('customers-active-card') || utangEl?.closest('.stat');
  const outCard = document.getElementById('credit-outstanding-card') || outEl?.closest('.stat');

  if (activeCard) {
    activeCard.classList.toggle('stat--warn', activeDebtors > 0);
  }
  if (outCard) {
    outCard.classList.toggle('stat--danger', totalOutstanding > 0.001);
    outCard.classList.toggle('stat--pos', totalOutstanding <= 0.001);
  }

  if (navBadge) {
    navBadge.textContent = activeDebtors;
    if (activeDebtors > 0) navBadge.classList.remove('hidden');
    else navBadge.classList.add('hidden');
  }
}


// Aging badge from credit_date (oldest unpaid sale): 30/60/90-day thresholds
// so old debts stand out instead of one flat balance list.
export function utangAgeBadge(c) {
  if (!(c.total_credit_balance > 0.001) || !c.credit_date) return { html: '', label: null };
  const days = Math.floor((Date.now() - new Date(c.credit_date).getTime()) / 86400000);
  if (days < 30) return { html: '', label: null };
  const band = days >= 90 ? 90 : days >= 60 ? 60 : 30;
  return {
    html: `<span class="tag tag--danger" title="Oldest unpaid balance is ${days} days old">${band}d</span>`,
    label: `${band}d`,
  };
}

export function renderCustomersTable(customers) {
  const tbody = document.getElementById('customers-tbody');
  if (!tbody) return;

  if (customers.length === 0) {
    tbody.innerHTML = `
      <tr><td colspan="5">
        <div class="empty">
          <div class="empty__icon"><i class="ph ph-users w-5 h-5"></i></div>
          <div class="empty__title">No customers match this filter</div>
          <p class="empty__body">Customers appear here once a sale is rung up under their name.</p>
        </div>
      </td></tr>
    `;
    return;
  }

  tbody.innerHTML = customers.map(c => {
    const aging = utangAgeBadge(c);
    const hasUtang = Number(c.total_credit_balance) > 0.001;
    const creditLimitVal = Number(c.credit_limit) || 0;
    const ordersCount = Number(c.sales_count) || 0;
    const totalSpent = Number(c.total_purchases) || 0;

    return `
    <tr data-name="${escHtml(c.customer_name)}" tabindex="0" role="button"
      aria-label="Open ledger for ${escHtml(c.customer_name)}"
      class="cursor-pointer hover:bg-[var(--surface-2)] focus-visible:bg-[var(--surface-2)] outline-none transition-colors">
      <td class="py-2.5 px-3">
        <div class="flex items-center gap-2.5">
          <span class="flex items-center justify-center w-7 h-7 rounded-full bg-[var(--surface-3)] text-[var(--txt-3)] shrink-0">
            <i class="ph ph-user w-3.5 h-3.5"></i>
          </span>
          <div class="min-w-0">
            <span class="font-semibold text-sm text-[var(--txt)]">${escHtml(c.customer_name)}</span>
            ${c.customer_phone ? `<span class="foot-note font-mono text-xs ml-2 text-[var(--txt-3)]">${escHtml(c.customer_phone)}</span>` : ''}
          </div>
        </div>
      </td>
      <td class="is-num py-2.5 px-3">
        <div class="font-medium text-xs text-[var(--txt)]">${ordersCount} ${ordersCount === 1 ? 'order' : 'orders'}</div>
        <div class="foot-note font-mono text-xs text-[var(--txt-3)]">${fmtMoney(totalSpent)}</div>
      </td>
      <td class="is-num py-2.5 px-3">
        ${creditLimitVal > 0.001
          ? `<span class="font-mono text-xs font-semibold text-[var(--txt)]">${fmtMoney(creditLimitVal)}</span>`
          : `<span class="foot-note text-xs text-[var(--txt-3)]">No limit</span>`}
      </td>
      <td class="is-mid py-2.5 px-3">
        <div class="inline-flex items-center gap-1.5">
          ${aging.html}
          ${c.total_credit_balance > 0.001
            ? `<span class="tag tag--danger font-mono text-xs font-bold">${fmtMoney(Number(c.total_credit_balance))}</span>`
            : `<span class="tag tag--pos font-mono text-xs">Paid</span>`}
        </div>
      </td>
      <td class="is-mid py-2.5 px-3">
        <button type="button" class="btn-mini btn-ledger-trigger py-1 px-2.5" data-customer="${escHtml(c.customer_name)}" aria-label="View ledger for ${escHtml(c.customer_name)}">
          <i class="ph ph-book-open w-3.5 h-3.5"></i> Ledger
        </button>
      </td>
    </tr>`;
  }).join('');

}

// Names ride in data-name, where the browser unescapes them safely. The old
// inline onclick broke on apostrophes: escHtml's &#39; decodes back to ' before
// the JS engine parses the attribute, killing the string literal.
const customersTbody = document.getElementById('customers-tbody');
customersTbody?.addEventListener('click', e => {
  const row = e.target.closest('tr[data-name]');
  if (row) openCustomerLedger(row.dataset.name);
});
customersTbody?.addEventListener('keydown', e => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const row = e.target.closest('tr[data-name]');
  if (row) { e.preventDefault(); openCustomerLedger(row.dataset.name); }
});

export async function openCustomerLedger(customerName, { propagateError = false } = {}) {
  try {
    const res = await fetch(`/api/customers/${encodeURIComponent(customerName)}`);
    if (!res.ok) throw new Error('Failed to load customer details');

    S.activeCustomerDetails = await res.json();

    document.getElementById('ledger-customer-name').textContent = S.activeCustomerDetails.customer_name;
    document.getElementById('ledger-customer-phone').textContent = `Phone: ${formatPhPhone(S.activeCustomerDetails.customer_phone) || 'None provided'}`;

    const balEl = document.getElementById('ledger-credit-balance');
    const isDebt = S.activeCustomerDetails.total_credit_balance > 0.001;
    balEl.textContent = `${fmtMoney(S.activeCustomerDetails.total_credit_balance)}`;
    balEl.className = `stat__value${isDebt ? ' stat--danger' : ' stat--pos'}`;

    const limitEl = document.getElementById('ledger-credit-limit');
    const limitVal = Number(S.activeCustomerDetails.credit_limit) || 0;
    if (limitEl) {
      limitEl.textContent = limitVal > 0 ? fmtMoney(limitVal) : 'No limit';
    }

    const ordersEl = document.getElementById('ledger-orders-count');
    if (ordersEl) ordersEl.textContent = S.activeCustomerDetails.sales_count || 0;

    const purchEl = document.getElementById('ledger-total-purchases');
    if (purchEl) purchEl.textContent = fmtMoney(Number(S.activeCustomerDetails.total_purchases));

    const paidEl = document.getElementById('ledger-total-paid');
    if (paidEl) paidEl.textContent = fmtMoney(Number(S.activeCustomerDetails.total_spent_paid));

    const statusEl = document.getElementById('ledger-credit-status');
    if (statusEl) {
      // getCustomerDetails has no credit_date; derive it from the oldest unpaid sale.
      const oldest = (S.activeCustomerDetails.sales || [])
        .filter(s => Number(s.credit_balance) > 0.001)
        .map(s => s.created_at).sort()[0] || null;
      const aging = utangAgeBadge({ ...S.activeCustomerDetails, credit_date: oldest });
      const overLimit = limitVal > 0 && S.activeCustomerDetails.total_credit_balance > limitVal;
      statusEl.innerHTML = isDebt
        ? `<span class="tag tag--danger rounded-full px-3 py-1 text-sm font-bold uppercase tracking-wider">Active utang</span>${aging.html}${overLimit ? '<span class="tag tag--danger rounded-full px-2 py-0.5 text-xs font-bold uppercase ml-1">Over limit</span>' : ''}`
        : '<span class="tag tag--pos rounded-full px-3 py-1 text-sm font-bold uppercase tracking-wider">Paid up</span>';
    }

    const salesCountEl = document.getElementById('ledger-sales-count');
    if (salesCountEl) salesCountEl.textContent = S.activeCustomerDetails.sales?.length || 0;
    const payCountEl = document.getElementById('ledger-payments-count');
    if (payCountEl) payCountEl.textContent = S.activeCustomerDetails.payments?.length || 0;
    const retCountEl = document.getElementById('ledger-returns-count');
    if (retCountEl) retCountEl.textContent = S.activeCustomerDetails.returns?.length || 0;

    document.getElementById('settle-amount').value = isDebt ? S.activeCustomerDetails.total_credit_balance.toFixed(2) : '';
    document.getElementById('settle-method').value = 'cash';
    toggleSettleRefInput();

    const isWalkIn = S.activeCustomerDetails.customer_name === 'Walk-in Customer' || !S.activeCustomerDetails.id;
    const settleForm = document.getElementById('form-settle-credit');
    if (settleForm) settleForm.classList.toggle('hidden', !isDebt);

    const limitBtn = document.querySelector('#modal-customer-ledger [data-action="edit-credit-limit"]');
    if (limitBtn) limitBtn.classList.toggle('hidden', isWalkIn);

    // Paid-up customer: nothing to settle, so the row says so instead of letting
    // a click die on the server's 'no outstanding credit' rejection.
    for (const id of ['settle-amount', 'settle-method', 'btn-submit-settlement']) {
      const el = document.getElementById(id);
      if (el) el.disabled = !isDebt;
    }
    const fullBtn = document.querySelector('#modal-customer-ledger .settle-full-btn');
    if (fullBtn) fullBtn.disabled = !isDebt;

    renderLedgerTabs();
    openModal('modal-customer-ledger');
  } catch (err) {
    if (propagateError) throw err;
    showToast(`Could not open ledger — ${err.message}`, 'error');
  }
}

export function switchLedgerTab(tab) {
  const tabs = ['sales', 'payments', 'returns'];
  for (const t of tabs) {
    const btn = document.getElementById(`ledger-tab-btn-${t}`);
    const view = document.getElementById(`ledger-tab-${t}`);
    const active = t === tab;
    if (btn) {
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-selected', String(active));
    }
    if (view) view.classList.toggle('hidden', !active);
  }
}

export function renderLedgerTabs() {
  if (!S.activeCustomerDetails) return;

  const salesContainer = document.getElementById('ledger-tab-sales');
  const sales = S.activeCustomerDetails.sales || [];
  if (sales.length === 0) {
    salesContainer.innerHTML = `
      <div class="empty py-8">
        <div class="empty__icon"><i class="ph ph-receipt w-5 h-5" aria-hidden="true"></i></div>
        <div class="empty__title">No purchase history recorded yet</div>
        <p class="empty__body">Completed orders will appear here with their items and balance.</p>
      </div>
    `;
  } else {
    salesContainer.innerHTML = sales.map(s => {
      const itemsText = (s.items || []).map(i => `${i.quantity}x ${i.item_name}`).join(', ');
      const hasDebt = s.credit_balance > 0.001;
      const methodTag = (s.payment_method === 'credit')
        ? `<span class="tag tag--warn rounded-full font-semibold text-xs uppercase tracking-wide">Credit / Utang</span>`
        : `<span class="tag rounded-full font-semibold text-xs uppercase tracking-wide">${escHtml(s.payment_method)}</span>`;

      return `
        <div class="ledger-card">
          <div class="flex items-start justify-between gap-3">
            <div class="space-y-1 min-w-0">
              <div class="flex items-center gap-1.5 flex-wrap">
                <span class="font-mono font-bold text-xs text-[var(--txt)]">${escHtml(s.sale_code)}</span>
                ${methodTag}
                ${s.payment_reference ? `<span class="foot-note font-mono text-xs">Ref: ${escHtml(s.payment_reference)}</span>` : ''}
                ${s.rma_count > 0 ? `<span class="tag tag--warn rounded-full px-2 py-0.5 text-xs font-bold">Return${s.refunded_amount > 0 ? ` (-${fmtMoney(Number(s.refunded_amount))})` : ''}</span>` : ''}
              </div>
              <div class="text-xs text-[var(--txt-3)] font-mono">${formatDateTime(s.created_at)}</div>
              <div class="text-xs text-[var(--txt-2)] truncate">${escHtml(itemsText || 'Parts / Repair')}</div>
            </div>
            <div class="text-right shrink-0 space-y-1.5">
              <div class="font-mono font-bold text-sm text-[var(--txt)] tabular-nums${s.voided ? ' line-through opacity-50' : ''}">${fmtMoney(Number(s.total_amount))}</div>
              <div>
                ${s.voided
                  ? `<span class="tag tag--danger rounded-full px-2 py-0.5 text-xs font-mono font-bold">Voided${s.void_reason ? ` · ${escHtml(s.void_reason)}` : ''}</span>`
                  : (hasDebt
                    ? `<span class="tag tag--danger rounded-full px-2 py-0.5 text-xs font-mono font-bold tabular-nums">Unpaid: ${fmtMoney(Number(s.credit_balance))}</span>`
                    : `<span class="tag tag--pos rounded-full px-2 py-0.5 text-xs font-mono font-bold tabular-nums">Paid in full</span>`)}
              </div>
              <div class="flex items-center justify-end gap-1.5">
                <button type="button" data-action="view-sale" data-sale-id="${s.id}" class="btn-mini flex items-center gap-1.5 py-1 px-2 text-xs font-semibold" title="View / Print Sale Receipt">
                  <i class="ph ph-printer w-3.5 h-3.5" aria-hidden="true"></i>
                  <span>Receipt</span>
                </button>
                ${s.voided ? '' : (s.items?.some(it => it.item_type !== 'labor') ? `
                  <button type="button" data-action="open-return" data-sale-id="${s.id}" class="btn-mini btn-mini--danger flex items-center gap-1 py-1 px-2 text-xs font-semibold" title="Process Return / Warranty">
                    <i class="ph ph-shield-warning w-3.5 h-3.5" aria-hidden="true"></i>
                    <span>Return</span>
                  </button>
                ` : '')}
              </div>
            </div>
          </div>
        </div>
      `;
    }).join('');
  }

  const paymentsContainer = document.getElementById('ledger-tab-payments');
  const payments = S.activeCustomerDetails.payments || [];
  if (payments.length === 0) {
    paymentsContainer.innerHTML = `
      <div class="empty py-8">
        <div class="empty__icon"><i class="ph ph-wallet w-5 h-5" aria-hidden="true"></i></div>
        <div class="empty__title">No settlement payments recorded yet</div>
        <p class="empty__body">Utang settlements and payments will appear here.</p>
      </div>
    `;
  } else {
    paymentsContainer.innerHTML = payments.map(p => `
      <div class="ledger-card">
        <div class="flex items-center justify-between gap-3">
          <div class="flex items-center gap-3 min-w-0">
            <div class="w-7 h-7 rounded-full bg-[var(--pos-bg)] text-[var(--pos)] flex items-center justify-center shrink-0">
              <i class="ph ph-receipt w-3.5 h-3.5" aria-hidden="true"></i>
            </div>
            <div class="min-w-0">
              <div class="font-mono font-bold text-sm text-[var(--pos)] tabular-nums">+${fmtMoney(Number(p.amount_paid))}</div>
              <div class="text-xs text-[var(--txt-3)] font-mono">${formatDateTime(p.created_at)}${p.notes ? ` &middot; ${escHtml(p.notes)}` : ''}</div>
              ${p.payment_reference ? `<div class="text-xs text-[var(--txt-4)] font-mono">Ref: ${escHtml(p.payment_reference)}</div>` : ''}
            </div>
          </div>
          <div class="flex items-center gap-2 shrink-0">
            <span class="tag tag--pos rounded-full uppercase text-xs font-semibold tracking-wide">${escHtml(p.payment_method)}</span>
            <button type="button" data-action="print-settlement" data-payment-id="${p.id}" class="btn-mini flex items-center gap-1.5 py-1 px-2.5 text-xs font-semibold" title="Print Settlement Receipt">
              <i class="ph ph-printer w-3.5 h-3.5" aria-hidden="true"></i>
              <span>Receipt</span>
            </button>
          </div>
        </div>
      </div>
    `).join('');
  }

  const returnsContainer = document.getElementById('ledger-tab-returns');
  const returns = S.activeCustomerDetails.returns || [];
  if (returnsContainer) {
    if (returns.length === 0) {
      returnsContainer.innerHTML = `
        <div class="empty py-8">
          <div class="empty__icon"><i class="ph ph-shield-check w-5 h-5" aria-hidden="true"></i></div>
          <div class="empty__title">No returns or warranty claims</div>
          <p class="empty__body">Warranty returns and replacements for this customer will appear here.</p>
        </div>
      `;
    } else {
      returnsContainer.innerHTML = returns.map(r => {
        let actionBadge;
        if (r.return_type === 'replacement') {
          actionBadge = `<span class="tag tag--info text-xs">Part replacement</span>`;
        } else if (r.return_type === 'credit_refund') {
          actionBadge = `<span class="tag tag--warn text-xs">Off utang</span>`;
        } else {
          actionBadge = `<span class="tag tag--danger text-xs">Cash refund</span>`;
        }
        return `
          <div class="ledger-card">
            <div class="flex items-start justify-between gap-3">
              <div class="space-y-1 min-w-0">
                <div class="flex items-center gap-2 flex-wrap">
                  <span class="font-mono font-bold text-xs text-[var(--txt)]">${escHtml(r.return_code)}</span>
                  ${actionBadge}
                  <span class="tag rounded-full text-xs font-mono capitalize">${escHtml(r.return_reason.replace(/_/g, ' '))}</span>
                </div>
                <div class="text-xs text-[var(--txt-3)] font-mono">${formatDateTime(r.created_at)} &middot; From ${escHtml(r.sale_code || 'Sale')}</div>
                <div class="text-xs text-[var(--txt-2)] font-semibold truncate">${escHtml(r.item_name)} (Qty: ${r.quantity || 1})</div>
                ${r.technician_notes ? `<div class="foot-note text-xs italic">${escHtml(r.technician_notes)}</div>` : ''}
              </div>
              <div class="text-right shrink-0 space-y-1">
                <div class="font-mono font-bold text-sm text-[var(--txt)] tabular-nums">${r.refund_amount > 0 ? fmtMoney(Number(r.refund_amount)) : '₱0.00'}</div>
                <div class="text-xs text-[var(--txt-4)] font-mono">${r.return_type === 'cash_refund' ? 'Cash refunded' : (r.return_type === 'credit_refund' ? 'Credit deducted' : 'Replacement')}</div>
              </div>
            </div>
          </div>
        `;
      }).join('');
    }
  }

}

export function printSettlementReceiptById(paymentId) {
  if (!S.activeCustomerDetails || !S.activeCustomerDetails.payments) return;
  const payment = S.activeCustomerDetails.payments.find(p => p.id === paymentId);
  if (!payment) return;
  // Direct print action, so the hard gate: refuse before rendering, like
  // reprintLastReceipt. A slip carrying placeholder identity belongs to nobody.
  if (shopIdentityIsPlaceholder()) {
    showToast('Settlement receipt not printed: shop identity is still the placeholder. Save real shop details in Settings, then reprint.', 'error');
    return;
  }
  renderSettlementReceipt(payment, S.activeCustomerDetails);
  openModal('modal-receipt');
}

export function fillFullSettlement() {
  if (S.activeCustomerDetails) {
    const input = document.getElementById('settle-amount');
    if (input) {
      input.value = S.activeCustomerDetails.total_credit_balance.toFixed(2);
      input.focus();
    }
  }
}

export function toggleSettleRefInput() {
  const method = document.getElementById('settle-method')?.value;
  const refContainer = document.getElementById('settle-ref-container');
  const ref = document.getElementById('settle-ref');
  const needsRef = method === 'gcash' || method === 'transfer';
  if (refContainer) refContainer.classList.toggle('hidden', !needsRef);
  // Required only while visible: a hidden required input would block submit
  // with a validation bubble pointing at a field nobody can see.
  if (ref) {
    ref.required = needsRef;
    ref.setAttribute('aria-required', needsRef ? 'true' : 'false');
  }
}

let settleInFlight = false;
export async function submitCreditSettlement(e) {
  e.preventDefault();
  if (!S.activeCustomerDetails) return;

  const amount = Number(document.getElementById('settle-amount').value);
  const method = document.getElementById('settle-method').value;
  const ref = document.getElementById('settle-ref')?.value.trim() || '';

  if (isNaN(amount) || amount <= 0) {
    showToast('Please enter a valid settlement amount.', 'warning');
    return;
  }
  if (method !== 'cash' && !ref) {
    showToast('Enter the GCash or transfer ref number so this collection can be checked', 'warning');
    document.getElementById('settle-ref')?.focus();
    return;
  }
  // Collections above the shop threshold are a manager call; ask before the
  // POST so the PIN prompt is not sitting behind a failed payment.
  const threshold = Number(S.shopSettings?.settle_elevation_threshold);
  if (Number.isFinite(threshold) && amount > threshold && !hasElevation()) {
    requireManagerPin(`Enter manager PIN to authorize a ${fmtMoney(amount)} collection`, () => submitCreditSettlement(e));
    return;
  }

  if (settleInFlight) return;
  settleInFlight = true;
  // One key per customer until a payment confirms: the elevation retry and a
  // post-timeout retry both reuse it, so the server replays the same payment.
  if (!pendingSettleOpId || pendingSettleCustomer !== S.activeCustomerDetails?.customer_name) {
    pendingSettleOpId = newOpId();
    pendingSettleCustomer = S.activeCustomerDetails?.customer_name;
  }
  try {
    const res = await fetch(`/api/customers/${encodeURIComponent(S.activeCustomerDetails.customer_name)}/settle-credit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amount_paid: amount,
        payment_method: method,
        payment_reference: ref,
        op_id: pendingSettleOpId
      })
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      // The server holds the live threshold; a stale local copy lands here.
      if (res.status === 403 && err.code === 'elevation_required') {
        requireManagerPin(`Enter manager PIN to authorize a ${fmtMoney(amount)} collection`, () => submitCreditSettlement(e));
        return;
      }
      throw new Error(err.error || 'Failed to settle credit');
    }

    // The settle endpoint responds with the refreshed customer record, so its
    // payments[0] IS the payment just recorded. Printing from a re-fetched
    // ledger risked printing an OLDER payment when the refresh failed — the
    // receipt is therefore rendered straight from this confirmed response.
    const details = await res.json();
    pendingSettleOpId = null;
    pendingSettleCustomer = null;
    S.activeCustomerDetails = details;
    if (details.payments && details.payments.length > 0) {
      // payments[0] IS the payment just recorded, so the slip and the queue both
      // describe it; nothing here is re-fetched from a ledger that may lag.
      const payment = details.payments[0];
      renderSettlementReceipt(payment, details);
      openModal('modal-receipt');
      // Payment is committed, but placeholder identity must not reach paper:
      // skip auto-print and say why (mirrors the sale flow in pos.js).
      if (shopIdentityIsPlaceholder()) {
        showToast('Payment recorded, but the receipt was not printed: shop identity is still the placeholder. Fix it in Settings, then reprint.', 'warning');
      } else if (autoPrintEnabled()) {
        // Native ESC/POS: the server re-reads this payment and the debtor's live
        // balance and pushes bytes to the queue named in Settings, so the counter
        // never touches a dialog. window.print() is only the fallback, and
        // renderSettlementReceipt has already filled #printable-receipt for it.
        autoPrintSlip(
          { kind: 'settlement', payment_id: payment.id, customer_name: payment.customer_name || details.customer_name },
          () => renderSettlementReceipt(payment, details)
        );
      }
    }

    // Screen refresh is best-effort and clearly separate: a failure here must
    // not read as a failed payment — it was already confirmed above.
    try {
      await openCustomerLedger(details.customer_name, { propagateError: true });
    } catch (refreshErr) {
      console.error('Ledger refresh failed after settlement:', refreshErr);
      showToast('Payment recorded — the ledger view could not refresh', 'warning');
    }
    loadCustomers();
    loadCustomerSuggestions();
    loadDashboardData();
    showToast('Credit settlement payment recorded successfully!', 'success');
  } catch (err) {
    showToast(`Error: ${err.message}`, 'error');
  } finally {
    settleInFlight = false;
  }
}

export async function editCreditLimitPrompt() {
  if (!S.activeCustomerDetails) return;
  const current = Number(S.activeCustomerDetails.credit_limit) || 0;
  const v = await inputModal(`Set credit limit for ${S.activeCustomerDetails.customer_name} (₱, 0 for no limit)`, {
    inputType: 'number',
    placeholder: '0.00',
    defaultValue: current > 0 ? String(current) : '0',
    yes: 'Save limit'
  });
  if (v === null) return;
  const num = Number(v);
  if (String(v).trim() === '' || !Number.isFinite(num) || num < 0) {
    showToast('Invalid credit limit amount', 'error');
    return;
  }
  try {
    const res = await fetch(`/api/customers/${encodeURIComponent(S.activeCustomerDetails.customer_name)}/limit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ credit_limit: num })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 403 && data.code === 'elevation_required') {
        const { requireManagerPin } = await import('../auth.js');
        requireManagerPin('Enter manager PIN to set credit limit', () => editCreditLimitPrompt());
        return;
      }
      throw new Error(data.error || 'Failed to update credit limit');
    }
    showToast(`Credit limit updated to ${num > 0 ? fmtMoney(num) : 'No limit'}`, 'success');
    await openCustomerLedger(S.activeCustomerDetails.customer_name);
    loadCustomers();
    loadCustomerSuggestions();
  } catch (err) {
    showToast(`Error: ${err.message}`, 'error');
  }
}

// -------------------------------------------------------------
// SALES HISTORY VIEW
// -------------------------------------------------------------
let salesHistoryRows = [];
let salesHistoryOffset = 0;
const SALES_PAGE_SIZE = 50;

export async function loadSalesHistory(more = false) {
  const request = ++salesRequest;
  const search = document.getElementById('sales-search')?.value || '';
  const method = document.getElementById('sales-payment-filter')?.value || '';
  const date = document.getElementById('sales-date-filter')?.value || '';
  if (!more) {
    salesHistoryRows = [];
    salesHistoryOffset = 0;
    showSkeleton('sales-tbody', 9);
  }

  let url = `/api/sales?search=${encodeURIComponent(search)}&limit=${SALES_PAGE_SIZE}&offset=${salesHistoryOffset}`;
  if (method) url += `&payment_method=${encodeURIComponent(method)}`;
  if (date) url += `&date=${encodeURIComponent(date)}`;

  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error('Sales history request failed');
    const page = await res.json();
    if (request !== salesRequest) return;
    salesHistoryRows = salesHistoryRows.concat(page);
    salesHistoryOffset += page.length;
    renderSalesHistory(salesHistoryRows);
    // A full page back means older rows probably exist; the footer asks for
    // them instead of silently truncating the shop's history at the default.
    const tbody = document.getElementById('sales-tbody');
    if (tbody && page.length === SALES_PAGE_SIZE) {
      tbody.insertAdjacentHTML('beforeend', `<tr><td colspan="9" class="py-2 text-center"><button type="button" class="chip" data-action="sales-more">Load older sales</button></td></tr>`);
    }
  } catch (err) {
    if (request !== salesRequest) return;
    console.error('Failed to load sales history:', err);
    const tbody = document.getElementById('sales-tbody');
    if (tbody && tbody.querySelector('.skel')) {
      tbody.innerHTML = `<tr><td colspan="9">
        <div class="empty">
          <div class="empty__icon"><i class="ph ph-wifi-slash w-5 h-5"></i></div>
          <div class="empty__title">Couldn't load sales history</div>
          <p class="empty__body">The server didn't answer. Retry, or check that the POS server is running.</p>
          <button type="button" class="chip" data-action="reload-sales">Retry</button>
        </div>
      </td></tr>`;
    }
    showToast('Could not load sales history — check the server and retry', 'error');
  }
}

export function renderSalesHistory(sales) {
  const tbody = document.getElementById('sales-tbody');
  if (!tbody) return;

  if (sales.length === 0) {
    tbody.innerHTML = `
      <tr><td colspan="9">
        <div class="empty">
          <div class="empty__icon"><i class="ph ph-receipt w-5 h-5"></i></div>
          <div class="empty__title">No sales match this filter</div>
          <p class="empty__body">Completed orders show up here with their receipt and balance.</p>
        </div>
      </td></tr>
    `;
    return;
  }

  tbody.innerHTML = sales.map(s => {
    const hasDebt = s.credit_balance > 0.001;
    const methodTag = (s.payment_method === 'gcash' || s.payment_method === 'transfer')
      ? `<span class="tag tag--info">${escHtml(s.payment_method)}</span>`
      : (s.payment_method === 'credit'
        ? `<span class="tag tag--warn">${escHtml(s.payment_method)}</span>`
        : `<span class="tag">${escHtml(s.payment_method)}</span>`);
      return `
      <tr>
        <td class="font-mono font-bold">${escHtml(s.sale_code)}
          ${s.voided ? ` <span class="tag tag--danger">VOIDED</span>` : ''}
          ${s.rma_count > 0 ? ` <span class="tag tag--warn" title="${s.rma_count} return(s) on this sale${s.refunded_amount > 0 ? ` (${fmtMoney(Number(s.refunded_amount))} refunded)` : ''}">Return${s.rma_count > 1 ? ` ×${s.rma_count}` : ''}${s.refunded_amount > 0 ? ` (-${fmtMoney(Number(s.refunded_amount))})` : ''}</span>` : ''}
        </td>
        <td class="font-mono whitespace-nowrap text-xs">${formatDateTime(s.created_at)}</td>
        <td>
          <button type="button" class="linkish font-bold" data-action="open-customer" data-customer="${escHtml(s.customer_name)}" title="Open customer panel">${escHtml(s.customer_name)}</button>
          ${(s.customer_type === 'technician' || s.customer_type === 'wholesale') ? '<span class="tag tag--info text-xs ml-1.5 font-semibold" title="Wholesale order">Wholesale</span>' : ''}
        </td>
        <td>
          ${methodTag}
          ${s.payment_reference ? `<span class="block foot-note font-mono">Ref: ${escHtml(s.payment_reference)}</span>` : ''}
        </td>
        <td class="is-num font-mono">${fmtMoney(Number(s.subtotal))}</td>
        <td class="is-num font-mono${s.discount > 0 ? ' text-[var(--warn)] font-bold' : ''}">${fmtMoney(Number(s.discount))}</td>
        <td class="is-num font-mono">
          <span class="font-bold text-[var(--txt)]">${fmtMoney(Number(s.total_amount))}</span>
          ${s.refunded_amount > 0 ? `<div class="foot-note text-xs text-[var(--danger)] whitespace-nowrap">Refunded: ${fmtMoney(Number(s.refunded_amount))}</div>` : ''}
        </td>
        <td class="is-num font-mono${hasDebt ? ' text-[var(--danger)] font-bold' : ''}">${hasDebt ? `${fmtMoney(Number(s.credit_balance))}` : '₱0.00'}</td>
        <td class="is-mid">
          <span class="inline-flex items-center gap-1.5 whitespace-nowrap">
            <button data-action="view-sale" data-sale-id="${s.id}" class="btn-mini sales-action-btn">Receipt</button>
            ${s.voided ? '' : (s.rma_available === 0
              ? `<button class="btn-mini btn-mini--danger sales-action-btn" disabled style="opacity:.4;cursor:not-allowed;" title="Every returnable part on this sale has already been claimed">Return</button>`
              : `<button data-action="open-return" data-sale-id="${s.id}" class="btn-mini btn-mini--danger sales-action-btn" title="Process Return / Warranty">Return</button>`)}
            ${s.voided ? '' : `<button data-action="void-sale" data-sale-id="${s.id}" class="btn-mini btn-mini--danger sales-action-btn">Void</button>`}
          </span>
        </td>
      </tr>
    `;
  }).join('');

}

export async function viewSaleDetails(saleId) {
  try {
    const res = await fetch(`/api/sales/${saleId}`);
    if (!res.ok) throw new Error('Sale not found');
    const sale = await res.json();
    S.lastSaleForReprint = sale;
    renderReceipt(sale);
    openModal('modal-receipt');
  } catch (err) {
    showToast(`Error loading receipt: ${err.message}`, 'error');
  }
}

export async function voidSalePrompt(saleId) {
  const reason = await inputModal('Void reason', { placeholder: 'Wrong item, customer cancelled...', yes: 'Void sale' });
  if (reason === null) return;
  if (!reason.trim()) { showToast('Void cancelled - reason required', 'warning'); return; }
  const doVoid = async () => {
    try {
      const res = await fetch(`/api/sales/${saleId}/void`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: reason.trim() }) });
      const data = await res.json().catch(()=>({}));
      if (!res.ok) {
        if (res.status === 403 && data.code === 'elevation_required') { requireManagerPin('Enter manager PIN to void sale', () => voidSalePrompt(saleId)); return; }
        throw new Error(data.error || 'Void failed');
      }
      showToast('Sale voided', 'success');
      loadSalesHistory();
      loadDashboardData();
      loadPosCatalog();
      loadInventoryTable();
      loadCustomers();
      if (S.activeCustomerDetails?.customer_name) {
        openCustomerLedger(S.activeCustomerDetails.customer_name).catch(() => {});
      }
    } catch (e) { showToast(e.message, 'error'); }
  };
  if (!hasElevation()) requireManagerPin('Enter manager PIN to void sale', doVoid); else doVoid();
}

export async function loadExceptions(days = null, date = null) {
  if (!hasElevation()) return;
  const request = ++exceptionsRequest;
  try {
    const d = days ?? PERIOD_DAYS[dashState.period];
    const qs = new URLSearchParams({ days: String(d) });
    const end = date || dashState.date;
    if (end) qs.set('date', end);
    const res = await fetch(`/api/exceptions?${qs}`);
    if (!res.ok) throw new Error('Exceptions unavailable');
    const ex = await res.json();
    if (request !== exceptionsRequest) return;
    const panel = document.getElementById('exceptions-panel');
    if (!panel) return;
    const hint = document.getElementById('dash-exceptions-hint');
    if (hint) hint.textContent = `Voids, all returns, discounts and shift variances: ${ex.range.from} to ${ex.range.to}. Audit chain is current.`;
    const fmt = v => fmtMoney(Number(v));
    let html = '';
    html += `<div><strong>Voided sales (${ex.voided?.length||0})</strong>: ${(ex.voided||[]).map(s=>`${escHtml(s.sale_code)} ${fmt(s.total_amount)} by ${escHtml(s.actor_name||'?')}`).join('<br>')||'none'}</div>`;
    // One Returns section for every type — a credit refund (utang erased) or
    // a replacement has no drawer paper trail, so this list is its only
    // itemized home.
    const typeLabel = { cash_refund: 'cash', credit_refund: 'utang', replacement: 'swap' };
    html += `<div><strong>Returns (${ex.returns?.length || 0})</strong>: ${(ex.returns || []).map(r => `${escHtml(r.return_code)} ${typeLabel[r.return_type] || escHtml(r.return_type)} ${r.return_type === 'replacement' ? '' : fmt(r.refund_amount)}`).join('<br>') || 'none'}</div>`;
    html += `<div><strong>Large discounts (${ex.discounts?.length||0})</strong>: ${(ex.discounts||[]).map(s=>`${escHtml(s.sale_code)} disc ${fmt(s.discount)}`).join('<br>')||'none'}</div>`;
    html += `<div><strong>Shift variances (${ex.shifts?.length||0})</strong>: ${(ex.shifts||[]).map(s=>`Shift #${s.id} var ${fmt(s.variance)}`).join('<br>')||'none'}</div>`;
    // Money that moved today against a period somebody already signed. Neither
    // stored number changed, so without this line the drawer looks right twice.
    html += `<div><strong>Moved after close (${ex.afterClose?.length||0})</strong>: ${(ex.afterClose||[]).map(a=>`${escHtml(a.ref)} ${escHtml(a.kind.replace(/_/g, ' '))}${a.cash_out ? ` out ${fmt(a.cash_out)}` : ''}, signed period was ${escHtml(a.signed_period)} by ${escHtml(a.signed_by)}`).join('<br>')||'none'}</div>`;
    // ok is true, false, or 'unknown' (verification itself failed): the
    // unknown state must not read as a clean chain.
    const chain = ex.auditChain || {};
    const chainText = chain.ok === true ? 'OK'
      : chain.ok === false ? `TAMPERED at #${chain.first_bad_id}`
      : 'COULD NOT VERIFY';
    html += `<div><strong>Audit chain:</strong> ${chainText}</div>`;
    panel.innerHTML = html;
  } catch (_) {
    if (request === exceptionsRequest) $id('exceptions-panel').textContent = 'Could not load exceptions. Refresh the report to retry.';
  }
}

// -------------------------------------------------------------
// DASHBOARD & REPORTS LOGIC (Reports & profit tab)
// One period selector drives every panel; each KPI also reads the previous
// equal-length window so the delta chips have a baseline.
// -------------------------------------------------------------
const PERIOD_DAYS = { day: 1, '3d': 3, '7d': 7, '30d': 30, '365d': 365 };
const dashState = { period: 'day', date: null, from: null, topSort: 'revenue', topExpanded: false, reorderExpanded: false, trendMode: 'revenue', wired: false };
let lastDash = null;

const $id = id => document.getElementById(id);
const fday = d => new Date(d + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const fdayY = d => new Date(d + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
const fmonth = m => new Date(m + '-01T00:00:00').toLocaleDateString('en-US', { month: 'short', year: 'numeric' });

function windowLabel(s) {
  if (s.period === 'day') return fday(s.range.to);
  if (s.period === '365d' || s.period === 'custom') return `${fday(s.range.from)} - ${fdayY(s.range.to)}`;
  return `${fday(s.range.from)} - ${fday(s.range.to)}`;
}

function deltaTag(node, pct) {
  if (!node) return;
  if (pct === null || pct === undefined) { node.className = 'tag'; node.textContent = 'no prior'; return; }
  // 0% is not a win: green + trend-up arrow on "no change" read as a boast.
  if (pct === 0) { node.className = 'tag'; node.textContent = '0%'; return; }
  const up = pct > 0;
  node.className = `tag tag--${up ? 'pos' : 'danger'}`;
  node.innerHTML = `<i class="ph ph-${up ? 'trend-up' : 'trend-down'}"></i>${up ? '+' : ''}${pct}%`;
}

const emptyPanel = (icon, title, body) => `
  <div class="empty">
    <div class="empty__icon"><i class="ph ph-${icon} w-5 h-5"></i></div>
    <div class="empty__title">${title}</div>
    <p class="empty__body">${body}</p>
  </div>`;

function renderDashboard(s) {
  const c = s.current, st = s.standing || {};

  $id('dash-range').textContent = windowLabel(s);
  $id('dash-trend-hint').textContent = (s.period === '365d' || s.days >= 365) ? t('dash.trend_hint_month', 'Per month, hover a bar for detail.') : t('dash.trend_hint_day', 'Per day, hover a bar for detail.');

  // KPI row
  $id('dash-revenue').textContent = fmtMoney(c.revenue);
  deltaTag($id('dash-revenue-delta'), s.deltas.revenue);
  $id('dash-revenue-split').textContent = `${t('dash.parts', 'Parts')} ${fmtMoney(c.parts_revenue)} · ${t('dash.labor', 'Labor')} ${fmtMoney(c.labor_revenue)}`;
  $id('dash-sales').textContent = c.sale_count;
  deltaTag($id('dash-sales-delta'), s.deltas.sale_count);
  // Every return type is named, so count and money always agree with each
  // other — a utang erase or a swap is invisible in no other panel.
  const swapWord = n => t(n === 1 ? 'dash.swap_count' : 'dash.swaps_count', `{n} swap${n === 1 ? '' : 's'}`).replace('{n}', n);
  $id('dash-sales-meta').textContent = [
    c.warranty_returns > 0 ? t(c.warranty_returns === 1 ? 'dash.return_count' : 'dash.returns_count', `{n} return${c.warranty_returns === 1 ? '' : 's'}`).replace('{n}', c.warranty_returns) : t('dash.no_returns', 'no returns'),
    c.return_cash > 0 ? `${fmtMoney(c.return_cash)} ${t('dash.cash_refunded', 'cash refunded')}` : '',
    c.return_credit > 0 ? `${fmtMoney(c.return_credit)} ${t('dash.off_utang', 'off utang')}` : '',
    c.return_replacements > 0 ? swapWord(c.return_replacements) : ''
  ].filter(Boolean).join(' · ');
  $id('dash-avg-ticket').textContent = fmtMoney(c.avg_ticket);
  deltaTag($id('dash-avg-delta'), s.deltas.avg_ticket);
  $id('dash-avg-meta').textContent = `${t('dash.collected', 'Collected')} ${fmtMoney(c.collected_total)}`;
  $id('dash-profit').textContent = fmtMoney(c.gross_profit);
  deltaTag($id('dash-profit-delta'), s.deltas.gross_profit);
  let profitMeta = c.replacement_cost > 0
    ? `${t('dash.net', 'Net')} ${fmtMoney(c.net_profit)} ${t('dash.after_refunds_replacements', 'after refunds & replacements')}`
    : `${t('dash.net', 'Net')} ${fmtMoney(c.net_profit)} ${t('dash.after_refunds', 'after refunds')}`;
  if (c.expenses_total > 0) profitMeta += ` · ${t('dash.expenses', 'Expenses')} ${fmtMoney(c.expenses_total)}`;
  if (typeof s.drawer_variance === 'number' && Math.abs(s.drawer_variance) >= 0.01) {
    const adjNet = c.net_profit + s.drawer_variance;
    const varText = s.drawer_variance < 0 ? `${t('dash.shortage', 'shortage')} -${fmtMoney(Math.abs(s.drawer_variance))}` : `${t('dash.overage', 'overage')} +${fmtMoney(s.drawer_variance)}`;
    profitMeta += ` · ${t('dash.drawer', 'Drawer')} ${varText} (${t('dash.adj', 'Adj')} ${fmtMoney(adjNet)})`;
  }
  $id('dash-profit-meta').textContent = profitMeta;

  renderTrend(s);

  // Collections mix, bars proportional to the window's biggest bucket.
  // ponytail: settlements are already inside payment methods, not a fourth share.
  const mix = [
    { icon: 'money', label: 'Cash', v: c.cash_collected, tone: 'pos' },
    { icon: 'qr-code', label: 'GCash', v: c.gcash_collected, tone: 'info' },
    { icon: 'arrows-left-right', label: 'Bank transfer', v: c.transfer_collected, tone: 'accent' }
  ];
  const mSum = mix.reduce((a, m) => a + m.v, 0);
  const sharesValid = mSum > 0 && mix.every(m => m.v >= 0);
  const mx = Math.max(...mix.map(m => Math.abs(m.v)), 1);
  let drawerStatusHtml = '';
  if (s.active_shift) {
    drawerStatusHtml = `
      <div class="p-2 mb-2 rounded border border-emerald-500/30 bg-emerald-500/10 flex items-center justify-between text-xs">
        <span class="flex items-center gap-1.5 font-medium text-[var(--txt)]">
          <span class="w-2 h-2 rounded-full bg-emerald-500 inline-block"></span>
          Drawer #${s.active_shift.id} OPEN (${escHtml(s.active_shift.staff_name || 'Counter')})
        </span>
        <span class="font-mono text-[var(--txt-2)]">Float ${fmtMoney(s.active_shift.opening_float)}</span>
      </div>`;
  }
  $id('dash-pmix').innerHTML = drawerStatusHtml + mix.map(m => `
    <div class="pmix">
      <span class="pmix__fill pmix--${m.tone}" style="width:${Math.round((Math.abs(m.v) / mx) * 100)}%"></span>
      <span class="pmix__label"><i class="ph ph-${m.icon} w-4 h-4"></i>${m.label}</span>
      <strong>${fmtMoney(m.v)}${sharesValid ? ` · ${Math.round((m.v / mSum) * 100)}%` : ''}</strong>
    </div>`).join('') + `<p class="foot-note">Includes ${fmtMoney(c.credit_settled)} in utang settlements. ${sharesValid ? 'Shares of net collections.' : 'Shares omitted when net collections are zero or negative.'}</p>`;

  // Standing book: not window-scoped, always "right now"
  // DR exposure belongs here too: the dashboard is where the owner looks, and
  // the age of the last good backup is stated in words, not by color alone.
  const bk = s.backup || {};
  const ageTxt = bk.last_backup_at
    ? (bk.age_hours >= 1 ? `${Math.round(bk.age_hours)}h ago` : 'in the last hour')
    : 'no backup file found';
  $id('dash-standing').innerHTML = `
    <div class="kv${st.total_credit_outstanding > 0.001 ? ' kv--danger' : ''}">
      <span class="flex items-center gap-2"><i class="ph ph-credit-card w-4 h-4"></i>Utang outstanding</span>
      <span class="text-right"><strong class="block">${fmtMoney(st.total_credit_outstanding)}</strong><span class="foot-note">${st.total_debtors_count} debtor${st.total_debtors_count === 1 ? '' : 's'}, right now</span></span>
    </div>
    <div class="kv">
      <span class="flex items-center gap-2"><i class="ph ph-package w-4 h-4"></i>Inventory value (retail)</span>
      <span class="text-right"><strong class="block">${fmtMoney(st.total_inventory_retail_value)}</strong><span class="foot-note">${st.total_parts_stock} ${st.total_parts_stock === 1 ? 'part' : 'parts'} on shelf</span></span>
    </div>
    <button type="button" class="kv kv--link kv--warn" data-action="dash-low-stock"
      aria-label="Open inventory filtered to low stock parts">
      <span class="flex items-center gap-2"><i class="ph ph-warning w-4 h-4"></i>Low stock parts</span>
      <span class="text-right"><strong class="block">${st.low_stock_count}</strong><span class="foot-note">at or below minimum, click to review</span></span>
    </button>
    <div class="kv${bk.stale ? ' kv--danger' : ''}">
      <span class="flex items-center gap-2"><i class="ph ph-floppy-disk w-4 h-4"></i>Backup ${bk.stale ? 'overdue' : 'current'}</span>
      <span class="text-right"><strong class="block">${ageTxt}</strong><span class="foot-note">${bk.stale ? 'Older than a day plus slack; mirror it off this disk (docs section 3.3)' : 'On the same disk as the database; mirror it off-machine (docs section 3.3)'}</span></span>
    </div>`;

  renderTopProducts();
  renderDeadStock(s.dead_stock || []);
  renderReorder(s.reorder || []);

  // Rail badge mirrors the standing KPI: the owner sees low stock without
  // opening the inventory tab, and the count always matches the panel above.
  const lowStockBadge = document.getElementById('nav-lowstock-badge');
  if (lowStockBadge) {
    const low = Number(st.low_stock_count) || 0;
    lowStockBadge.textContent = low;
    lowStockBadge.classList.toggle('hidden', !(low > 0));
  }
}

// Trend chart: revenue or net profit (refunds and expenses land on the day
// they happened), driven by the seg control in the panel header.
function renderTrend(s) {
  const profit = dashState.trendMode === 'profit';
  const totalRefunds = (s.trend || []).reduce((sum, t) => sum + (t.refunded || 0), 0);
  renderTrendChart($id('dash-trend'), (s.trend || []).map(t => {
    let sub = `${t.count} sale${t.count === 1 ? '' : 's'}`;
    if (!profit && t.refunded > 0) {
      sub += ` · ${fmtMoney(t.refunded)} refunded`;
    } else if (profit && t.refunded > 0) {
      sub += ` · incl. -${fmtMoney(t.refunded)} refunds`;
    }
    return {
      label: s.days >= 365 ? fmonth(t.bucket) : fday(t.bucket),
      value: profit ? t.profit : t.revenue,
      sub
    };
  }), { fmt: fmtMoney, title: profit ? 'Profit after refunds & expenses' : 'Revenue trend' });
  $id('dash-trend-title').textContent = profit ? 'Profit after refunds & expenses' : 'Revenue trend';
  $id('dash-trend-hint').textContent = (profit
    ? 'Profit after refunds, replacement parts, and operating expenses; each lands on the date it happened.'
    : (totalRefunds > 0
        ? `Gross sales volume (${fmtMoney(totalRefunds)} refunded in this window; click 'Net profit' for bottom line).`
        : 'Gross sales volume per day.'))
    + (s.period === '365d' ? ' Monthly buckets.' : '');
}

function renderTopProducts() {
  const box = $id('dash-top-products');
  if (!box || !lastDash) return;
  const pp = lastDash.products || {};
  const products = pp.products || [];
  const labor = pp.labor || { units: 0, revenue: 0 };
  if (!products.length && !labor.units) {
    box.innerHTML = emptyPanel('package', 'No parts sold in this window', 'Sales rank here as the window fills in.');
    return;
  }
  const key = dashState.topSort;
  const sorted = [...products].sort((a, b) => (b[key] || 0) - (a[key] || 0));
  const max = Math.max(...sorted.map(p => p[key] || 0), 1);
  const shown = dashState.topExpanded ? sorted : sorted.slice(0, 10);
  box.innerHTML = shown.map((p, i) => `
    <div class="rank">
      <span class="rank__no">${i + 1}</span>
      <div class="rank__body">
        <div class="rank__line">
          <span class="rank__name" title="${escHtml(p.item_name || '')}">${escHtml(p.item_name || 'Part')}</span>
          <span class="rank__val">${key === 'units' ? p.units : fmtMoney(p[key])}</span>
        </div>
        <div class="rank__sub">
          <span class="rank__bar"><span style="width:${Math.round(((p[key] || 0) / max) * 100)}%"></span></span>
          <span class="rank__meta">${p.units} ${p.units === 1 ? 'unit' : 'units'} · ${p.margin_pct === null ? '-' : p.margin_pct}% margin</span>
        </div>
      </div>
    </div>`).join('')
    + (labor.units > 0 ? `
    <div class="kv kv--info">
      <span class="flex items-center gap-2"><i class="ph ph-wrench w-4 h-4"></i>Labor &amp; services</span>
      <span class="text-right"><strong class="block">${fmtMoney(labor.revenue)}</strong><span class="foot-note">${labor.units} job${labor.units === 1 ? '' : 's'}, pure margin</span></span>
    </div>` : '')
    + (sorted.length > 10 ? `<button type="button" class="linkish w-full text-center mt-1" data-dash-action="expand-top">${dashState.topExpanded ? 'Show top 10 only' : `Show all ${sorted.length}`}</button>` : '');
}

function renderDeadStock(rows) {
  const box = $id('dash-dead-stock');
  if (!box) return;
  if (!rows.length) {
    box.innerHTML = emptyPanel('check-circle', 'Nothing is dead', 'Everything on the shelf sold at least once this window.');
    return;
  }
  const max = rows[0].tied_up_capital || 1;
  box.innerHTML = rows.map((r, i) => {
    const band = r.days_no_sale >= 60 ? 'danger' : r.days_no_sale >= 30 ? 'warn' : '';
    return `
    <div class="rank">
      <span class="rank__no">${i + 1}</span>
      <div class="rank__body">
        <div class="rank__line">
          <span class="rank__name" title="${escHtml(r.name)}">${escHtml(r.name)}</span>
          <span class="rank__val">${fmtMoney(r.tied_up_capital)}</span>
        </div>
        <div class="rank__sub">
          <span class="rank__bar"><span class="${band ? `rk--${band}` : ''}" style="width:${Math.round((r.tied_up_capital / max) * 100)}%"></span></span>
          <span class="rank__meta">${r.stock_quantity} on shelf · no sale ${r.days_no_sale}d${r.last_sold ? '' : ' (never)'}</span>
        </div>
      </div>
    </div>`;
  }).join('');
}

const REORDER_PREVIEW = 5;

function renderReorder(rows) {
  const box = $id('dash-reorder');
  if (!box) return;
  const count = $id('dash-reorder-count');
  if (count) {
    count.textContent = rows.length ? `${rows.length} part${rows.length === 1 ? '' : 's'}` : '';
    count.classList.toggle('hidden', !rows.length);
  }
  if (!rows.length) {
    box.innerHTML = emptyPanel('check-circle', 'Nothing to reorder', 'Stock levels and days of cover are healthy.');
    return;
  }
  // Collapsed shows a glanceable handful; See all opens the full list and the
  // card's own scroll cap keeps it from stretching the page (the original bug).
  const shown = dashState.reorderExpanded ? rows : rows.slice(0, REORDER_PREVIEW);
  box.innerHTML = shown.map(r => `
    <div class="kv">
      <div class="min-w-0">
        <span class="block font-bold truncate">${escHtml(r.name)}</span>
        <span class="block foot-note font-mono">${r.below_min ? `below minimum of ${r.min_stock_alert}` : `${r.cover_days} days of cover`}</span>
      </div>
      <div class="text-right shrink-0">
        <span class="block font-mono font-bold ${r.stock_quantity === 0 ? 'stock--out' : 'stock--low'}">${r.stock_quantity} left</span>
        <span class="block foot-note font-mono">${r.units_sold} sold this window</span>
        ${r.suggested_qty > 0 ? `<button type="button" class="btn-mini mt-1" data-action="receive-part" data-part-id="${r.id}" data-suggested="${r.suggested_qty}" data-cost="${r.cost_price || 0}"><i class="ph ph-package w-3.5 h-3.5"></i> Receive ${r.suggested_qty}</button>` : ''}
      </div>
    </div>`).join('') + (rows.length > REORDER_PREVIEW
      ? `<button type="button" class="linkish w-full text-center" data-dash-action="toggle-reorder">${dashState.reorderExpanded ? 'See less' : `See all ${rows.length} parts`}</button>`
      : '');
}

function syncPeriodUi() {
  document.querySelectorAll('#dash-period-bar [data-period]').forEach(b =>
    b.classList.toggle('is-active', b.dataset.period === dashState.period));
  // The date box anchors EVERY period now ("the 7 days ending Friday"), so it
  // never hides — and a stale picked date from a previous period must not sit
  // in the input while the state says "today".
  $id('dash-date-wrap').classList.remove('hidden');
  const dateInput = $id('dash-date');
  if (!dashState.date) {
    // Local calendar date, matching the server's localtime windows — a UTC
    // prefill here silently turns "Daily" into yesterday past midnight.
    dateInput.value = new Date().toLocaleDateString('sv-SE');
  }
  // Custom ranges show the start picker; the end picker above stays the range's
  // "Ending" date. Prefill start = 7 days back so both ends are always set.
  const isCustom = dashState.period === 'custom';
  $id('dash-date-from-wrap').classList.toggle('hidden', !isCustom);
  if (isCustom && !dashState.from) {
    const fromInput = $id('dash-date-from');
    fromInput.value = new Date(Date.now() - 6 * 86400000).toLocaleDateString('sv-SE');
    dashState.from = fromInput.value;
  }
  document.querySelectorAll('#dash-top-sort [data-sort]').forEach(b =>
    b.classList.toggle('is-active', b.dataset.sort === dashState.topSort));
  document.querySelectorAll('#dash-trend-mode [data-mode]').forEach(b =>
    b.classList.toggle('is-active', b.dataset.mode === dashState.trendMode));
  document.querySelectorAll('#dash-period-bar [data-period], #dash-top-sort [data-sort], #dash-trend-mode [data-mode]').forEach(b => b.setAttribute('aria-pressed', String(b.classList.contains('is-active'))));
}

function wireDashboardControls() {
  if (dashState.wired) return;
  dashState.wired = true;
  $id('dash-period-bar').addEventListener('click', e => {
    const p = e.target.closest('[data-period]');
    if (p) {
      dashState.period = p.dataset.period;
      dashState.topExpanded = false;
      dashState.reorderExpanded = false;
      syncPeriodUi();
      loadDashboardData();
      return;
    }
    const a = e.target.closest('[data-dash-action]');
    if (!a) return;
    if (a.dataset.dashAction === 'print' && lastDash) printPeriodSummary(lastDash);
  });
  $id('dash-top-products').addEventListener('click', e => {
    const button = e.target.closest('[data-dash-action="expand-top"]');
    if (!button) return;
    dashState.topExpanded = !dashState.topExpanded;
    renderTopProducts();
  });
  // Receive-from-reorder: two Enter-driven prompts (qty, then unit cost that
  // defaults to the current cost). One batch line per part; the server applies
  // the whole request or nothing.
  $id('dash-reorder').addEventListener('click', async e => {
    if (e.target.closest('[data-dash-action="toggle-reorder"]')) {
      dashState.reorderExpanded = !dashState.reorderExpanded;
      renderReorder(lastDash?.reorder || []);
      return;
    }
    const btn = e.target.closest('[data-action="receive-part"]');
    if (!btn) return;
    if (!hasElevation()) {
      requireManagerPin('Enter manager PIN to receive stock', () => loadDashboardData());
      return;
    }
    const qty = Number(await inputModal('Quantity received', { inputType: 'number', step: 'any', defaultValue: btn.dataset.suggested, yes: 'Next' }));
    if (!Number.isFinite(qty) || qty <= 0) return;
    const line = { id: Number(btn.dataset.partId), quantity: qty, op_id: globalThis.crypto?.randomUUID?.() || `receive-${Date.now()}` };
    const cost = await inputModal('Unit cost, blank keeps the current cost', { inputType: 'number', step: 'any', defaultValue: btn.dataset.cost, yes: 'Receive' });
    if (cost !== null && String(cost).trim() !== '' && Number(cost) >= 0) line.unit_cost = Number(cost);
    try {
      const res = await fetch('/api/inventory/receive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: [line] })
      });
      if (res.status === 403) {
        requireManagerPin('Enter manager PIN to receive stock', () => loadDashboardData());
        return;
      }
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Could not receive the stock');
      showToast('Stock received.', 'success');
      loadDashboardData();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });
  $id('dash-top-sort').addEventListener('click', e => {
    const b = e.target.closest('[data-sort]');
    if (!b) return;
    dashState.topSort = b.dataset.sort;
    syncPeriodUi();
    renderTopProducts();
  });
  $id('dash-trend-mode').addEventListener('click', e => {
    const b = e.target.closest('[data-mode]');
    if (!b) return;
    dashState.trendMode = b.dataset.mode;
    syncPeriodUi();
    if (lastDash) renderTrend(lastDash);
  });
  $id('dash-date').addEventListener('change', e => {
    dashState.date = e.target.value || null;
    loadDashboardData();
  });
  $id('dash-date-from').addEventListener('change', e => {
    dashState.from = e.target.value || null;
    loadDashboardData();
  });
  const expenseForm = $id('dash-expense-form');
  if (expenseForm) expenseForm.addEventListener('submit', async e => {
    e.preventDefault();
    const body = {
      category: $id('expense-category').value,
      description: $id('expense-description').value,
      amount: $id('expense-amount').value
    };
    if (!body.category.trim() || !(Number(body.amount) > 0)) {
      showToast('Category and a positive amount are required.', 'error');
      return;
    }
    const submitBtn = expenseForm.querySelector('[type="submit"]');
    if (submitBtn) submitBtn.disabled = true;
    try {
      const res = await fetch('/api/expenses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, op_id: globalThis.crypto?.randomUUID?.() || `expense-${Date.now()}` })
      });
      if (res.status === 403) {
        requireManagerPin('Enter manager PIN to record an expense', () => loadDashboardData());
        return;
      }
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Could not save the expense');
      expenseForm.reset();
      showToast('Expense recorded.', 'success');
      loadDashboardData();
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      if (submitBtn) submitBtn.disabled = false;
    }
  });
  const expenseList = $id('dash-expenses-list');
  if (expenseList) expenseList.addEventListener('click', async e => {
    const btn = e.target.closest('[data-action="delete-expense"]');
    if (!btn) return;
    if (!await confirmModal('Remove this expense from the record? The audit log keeps the entry.', { title: 'Remove expense?', yes: 'Remove', danger: true })) return;
    try {
      const res = await fetch(`/api/expenses/${btn.dataset.expenseId}`, { method: 'DELETE' });
      if (res.status === 403) {
        requireManagerPin('Enter manager PIN to remove an expense', () => loadDashboardData());
        return;
      }
      if (!res.ok) throw new Error('Could not remove the expense');
      showToast('Expense removed.', 'success');
      loadDashboardData();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });
  const canPoll = () => typeof document !== 'undefined' && !document.hidden && S.currentTab === 'dashboard' && hasElevation()
    && (!dashState.date || dashState.date === localToday());
  if (typeof setInterval !== 'undefined') {
    const pollTimer = setInterval(() => {
      if (canPoll()) loadDashboardData({ silent: true });
    }, 20000);
    if (pollTimer && typeof pollTimer.unref === 'function') pollTimer.unref();
  }
  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('visibilitychange', () => {
      if (canPoll()) loadDashboardData({ silent: true });
    });
  }
}

export async function loadDashboardData(opts = {}) {
  const silent = Boolean(opts && opts.silent);
  // Elevation-gated server-side. Prompt manager for PIN if on dashboard tab.
  if (!hasElevation()) {
    if (!silent && S.currentTab === 'dashboard') {
      requireManagerPin('Enter manager PIN to view Reports & Profit', () => loadDashboardData());
    }
    return;
  }
  const request = ++dashboardRequest;
  wireDashboardControls();
  if (!silent) syncPeriodUi();
  if (typeof syncCloudUi === 'function') syncCloudUi();
  try {
    const qs = new URLSearchParams({ period: dashState.period });
    if (dashState.date) qs.set('date', dashState.date);
    if (dashState.period === 'custom' && dashState.from) qs.set('from', dashState.from);
    const res = await fetch('/api/dashboard?' + qs);
    if (res.status === 403) {
      if (!silent && S.currentTab === 'dashboard') {
        requireManagerPin('Enter manager PIN to view Reports & Profit', () => loadDashboardData());
      }
      return;
    }
    if (!res.ok) throw new Error('Reports unavailable');
    const stats = await res.json();
    if (request !== dashboardRequest) return;
    lastDash = stats;
    renderDashboard(stats);
    loadExpenses(stats.range?.from, stats.range?.to);
    setDashFreshness(true);
    if (!silent) {
      // Custom ranges carry their own length; /api/exceptions caps days at 365.
      const exDays = stats.period === 'custom'
        ? Math.min(365, Math.max(1, Math.round((Date.parse(`${stats.range.to}T00:00:00Z`) - Date.parse(`${stats.range.from}T00:00:00Z`)) / 86400000) + 1))
        : PERIOD_DAYS[stats.period];
      loadExceptions(exDays, stats.range.to);
      loadDayClose();
    }
  } catch (err) {
    if (request !== dashboardRequest) return;
    setDashFreshness(false);
    if (silent) return;
    console.error('Failed to load dashboard:', err);
    // Static zeros read as real numbers at a glance; say the panels are empty
    // because the load failed, not because the shop sold nothing.
    const trend = document.getElementById('dash-trend');
    if (trend) trend.innerHTML = '<p class="foot-note">The trend could not be loaded. Retry from the tab.</p>';
    const dayCloseBody = document.getElementById('day-close-body');
    if (dayCloseBody) dayCloseBody.innerHTML = '<p class="foot-note">The day close could not be loaded. Retry from the tab.</p>';
    showToast('Could not load the reports - check the server and retry', 'error');
  }
}

let lastDashOkAt = 0;

function setDashFreshness(ok) {
  const el = $id('dash-freshness');
  if (!el) return;
  el.hidden = false;
  if (el.classList) el.classList.remove('hidden');
  const now = new Date();
  const timeStr = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (ok) {
    lastDashOkAt = Date.now();
    el.className = 'tag tag--pos font-mono text-xs';
    el.textContent = `Live · ${timeStr}`;
    return;
  }
  const ageMs = lastDashOkAt ? (Date.now() - lastDashOkAt) : Infinity;
  if (ageMs < 300000) {
    const mins = Math.max(1, Math.round(ageMs / 60000));
    el.className = 'tag tag--warn font-mono text-xs';
    el.textContent = `Stale · ${mins}m ago`;
  } else {
    el.className = 'tag tag--danger font-mono text-xs';
    el.textContent = lastDashOkAt
      ? `Offline · last ${new Date(lastDashOkAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
      : 'Offline';
  }
}

// -------------------------------------------------------------
// DAY CLOSE: the drawer count for one calendar day
// -------------------------------------------------------------
let dayCloseRequest = 0;

function localToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export async function loadDayClose() {
  const body = document.getElementById('day-close-body');
  const dateEl = document.getElementById('day-close-date');
  if (!body || !dateEl) return;
  if (!hasElevation()) {
    // Elevation expires on a TTL: a panel frozen at "Loading…" reads as a slow
    // server, not as a manager PIN that went stale ten minutes ago.
    body.textContent = 'Manager PIN required. Open the reports tab again to re-authorize.';
    return;
  }
  if (!dateEl.value) dateEl.value = localToday();
  const request = ++dayCloseRequest;
  try {
    const res = await fetch(`/api/reconcile/${dateEl.value}`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      body.textContent = err.error || 'The day could not be read.';
      return;
    }
    const d = await res.json();
    if (request !== dayCloseRequest) return;
    const methods = Object.entries(d.buckets || {});
    const shifts = Array.isArray(d.shifts) ? d.shifts : [];
    const openShift = d.open_shift;
    const prefillVal = (typeof d.total_shift_counted === 'number' && d.total_shift_counted > 0)
      ? d.total_shift_counted
      : '';

    let openShiftAlert = '';
    if (openShift) {
      openShiftAlert = `
        <div class="p-2.5 mb-2 rounded-lg border border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400 font-medium flex items-center justify-between text-xs">
          <span class="flex items-center gap-1.5"><i class="ph ph-lock-open w-4 h-4"></i> Drawer #${openShift.id} is currently OPEN (${escHtml(openShift.staff_name || 'Cashier')})</span>
          <span class="font-mono">Float ${fmtMoney(openShift.opening_float)}</span>
        </div>`;
    }

    let shiftsBreakdown = '';
    if (shifts.length > 0) {
      const closedShifts = shifts.filter(s => s.status === 'closed');
      shiftsBreakdown = `
        <div class="mt-2.5 pt-2 border-t border-[var(--line-soft)] space-y-1.5">
          <div class="flex items-center justify-between text-[11px] font-semibold text-[var(--txt-2)]">
            <span class="flex items-center gap-1"><i class="ph ph-cash-register w-3.5 h-3.5"></i> Drawer Shifts (${shifts.length})</span>
            <span>${closedShifts.length > 0 ? (d.total_shift_variance === 0 ? '<span class="text-[var(--pos)] font-mono">Balanced (₱0.00)</span>' : `<span class="text-amber-600 dark:text-amber-400 font-mono">Net var: ${fmtMoney(d.total_shift_variance)}</span>`) : '<span class="foot-note">Open</span>'}</span>
          </div>
          <div class="space-y-1">
            ${shifts.map(s => `
              <div class="p-1.5 rounded border border-[var(--line)] bg-[var(--surface-2)] flex items-center justify-between text-[11px]">
                <div>
                  <strong class="font-mono">#${s.id}</strong> ${escHtml(s.staff_name || 'Counter')}
                  <span class="foot-note">${s.status === 'open' ? '· OPEN' : '· Closed ' + new Date(s.closed_at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}</span>
                </div>
                <div class="font-mono text-right text-xs">
                  ${s.status === 'open'
                    ? `Float ${fmtMoney(s.opening_float)}`
                    : `Counted ${fmtMoney(s.counted_cash)} <span class="${Math.abs(s.variance) < 0.005 ? 'text-[var(--pos)]' : 'text-amber-600 dark:text-amber-400'} font-semibold">(var ${fmtMoney(s.variance)})</span>`
                  }
                </div>
              </div>
            `).join('')}
          </div>
        </div>`;
    }

    body.innerHTML = `
      ${openShiftAlert}
      <table class="w-full text-xs">
        <tbody>
          ${methods.length
            ? methods.map(([m, b]) => `<tr>
                <td class="capitalize">${escHtml(m)}</td>
                <td class="text-right font-mono">${fmtMoney(b.collected)}</td>
                <td class="text-right foot-note">${b.count} ${b.count === 1 ? 'entry' : 'entries'}</td>
              </tr>`).join('')
            : `<tr><td class="foot-note">Nothing collected on this day.</td></tr>`}
          <tr>
            <td>Cash refunds out</td>
            <td class="text-right font-mono">-${fmtMoney(d.refund_total)}</td>
            <td class="text-right foot-note">${escHtml(String(d.void_count))} void${d.void_count === 1 ? '' : 's'}</td>
          </tr>
          <tr>
            <td><strong>Expected in drawer</strong></td>
            <td class="text-right font-mono"><strong>${fmtMoney(d.expected_cash)}</strong></td>
            <td></td>
          </tr>
        </tbody>
      </table>
      ${shiftsBreakdown}
      ${d.stored
        ? `<p class="foot-note mt-2">Closed by ${escHtml(d.stored.closed_by || 'a manager')}: counted ${fmtMoney(d.stored.counted_cash)}, variance ${fmtMoney(d.stored.variance)}, ${escHtml(d.stored.status)}. This day is signed; it is not counted again.</p>`
        : `<div class="flex items-center gap-2 mt-2">
             <label class="sr-only" for="day-close-counted">Counted cash takings for the day, excluding the opening float</label>
             <input type="number" id="day-close-counted" min="0" step="0.01" value="${prefillVal}" placeholder="Counted cash (excl. float)" class="flex-1 px-2 py-1 text-xs font-mono" title="Count today's cash takings only. Money left in the drawer overnight is not part of the expected figure and must not be counted here.">
             <button type="button" class="btn-primary" data-action="day-close-submit">Close ${escHtml(d.day)}</button>
           </div>
           <p class="foot-note">Count today's cash takings only. ${prefillVal !== '' ? `Prefilled from closed shift count (${fmtMoney(prefillVal)}).` : 'Excluding opening float left in drawer.'}</p>`}`;
  } catch (err) {
    if (request !== dayCloseRequest) return;
    body.textContent = 'The day could not be read. Refresh the reports to try again.';
  }
}

// Operating expenses: window-scoped list + quick add. Bookkeeping only, the
// drawer never moves; the P&L panels above already subtract the total.
function renderExpenses(data) {
  const box = $id('dash-expenses-list');
  if (!box || !data) return;
  const total = $id('dash-expenses-total');
  if (total) total.textContent = `${t('dash.expenses_total_label', 'Total')} ${fmtMoney(data.total)}`;
  const rows = data.expenses || [];
  box.innerHTML = rows.length
    ? rows.map(r => `
      <div class="flex items-center justify-between gap-2 py-1">
        <span class="min-w-0 flex-1 truncate">
          <strong class="font-semibold">${escHtml(r.category)}</strong>${r.description ? `<span class="text-[var(--txt-3)]"> · ${escHtml(r.description)}</span>` : ''}
          <span class="foot-note font-mono"> ${escHtml(formatDateTime(r.created_at))}${r.actor_name ? ` · ${escHtml(r.actor_name)}` : ''}</span>
        </span>
        <span class="font-mono whitespace-nowrap">${fmtMoney(r.amount)}</span>
        <button type="button" class="btn-mini" data-action="delete-expense" data-expense-id="${r.id}" aria-label="Remove expense"><i class="ph ph-trash w-3.5 h-3.5"></i></button>
      </div>`).join('')
    : emptyPanel('receipt', 'No expenses booked in this window', 'Rent, utilities, supplies; anything the shop pays for.');
}

async function loadExpenses(from, to) {
  const box = $id('dash-expenses-list');
  if (!box) return;
  try {
    const qs = new URLSearchParams();
    if (from) qs.set('from', from);
    if (to) qs.set('to', to);
    const res = await fetch('/api/expenses?' + qs);
    if (!res.ok) throw new Error('unavailable');
    renderExpenses(await res.json());
  } catch (_) {
    // Static zeros read as real numbers; say the load failed instead.
    box.innerHTML = emptyPanel('wifi-slash', 'Expenses unavailable', 'Load failed; check the server and retry.');
  }
}

let dayCloseInFlight = false;

export async function submitDayClose() {
  if (dayCloseInFlight) return;
  const dateEl = document.getElementById('day-close-date');
  const countedEl = document.getElementById('day-close-counted');
  const day = dateEl?.value;
  const raw = countedEl?.value.trim();
  if (!day || raw === '' || !Number.isFinite(Number(raw)) || Number(raw) < 0) {
    showToast('Enter the counted cash for the day', 'warning');
    countedEl?.focus();
    return;
  }
  dayCloseInFlight = true;
  try {
    const res = await fetch('/api/reconcile/close-day', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: day, counted_cash: Number(raw) })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'The day could not be closed');
    showToast(data.status === 'balanced'
      ? `Day ${data.day} closed: drawer balanced`
      : `Day ${data.day} closed with a ${fmtMoney(data.variance)} variance`, data.status === 'balanced' ? 'success' : 'warning');
    loadDayClose();
    loadExceptions(1, day);
  } catch (err) {
    showToast(`Error: ${err.message}`, 'error');
  } finally {
    dayCloseInFlight = false;
  }
}

export async function triggerBackup() {
  if (!hasElevation()) {
    requireManagerPin('Enter manager PIN to create a manual backup', () => {
      triggerBackup();
    });
    return;
  }

  try {
    const res = await fetch('/api/backup', { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      showToast(`Database backup saved: ${data.backup_file}`, 'success');
    } else {
      throw new Error('Backup failed');
    }
  } catch (err) {
    showToast(`Error creating backup: ${err.message}`, 'error');
  }
}

export async function restoreBackup() {
  if (!hasElevation()) {
    requireManagerPin('Enter manager PIN to restore a backup', () => {
      restoreBackup();
    });
    return;
  }

  const fmtSize = b => b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`;
  try {
    const res = await fetch('/api/backup/list');
    if (!res.ok) throw new Error('Could not list backups');
    const { backups } = await res.json();
    if (!backups.length) {
      showToast('No backup files found yet. Take a backup first.', 'warning');
      return;
    }
    pickBackupToRestore(backups, fmtSize);
  } catch (err) {
    showToast(`Error listing backups: ${err.message}`, 'error');
  }
}

function pickBackupToRestore(backups, fmtSize) {
  const id = 'modal-restore-backup';
  let modal = document.getElementById(id);
  if (!modal) {
    document.body.insertAdjacentHTML('beforeend', `
      <div id="${id}" class="modal-backdrop fixed inset-0 z-[92] flex items-center justify-center hidden"
        aria-labelledby="restore-backup-title" aria-describedby="restore-backup-note">
        <div class="modal-card w-full max-w-lg">
          <div class="modal-card__head"><h3 id="restore-backup-title" class="modal-card__title">Restore from backup</h3></div>
          <div class="modal-card__body space-y-3">
            <p id="restore-backup-note" class="foot-note">Pick the dated copy to load. A safety backup of the
              current data is saved first, so a restore can itself be undone.</p>
            <label class="field">
              <span class="field__label">Backup file</span>
              <select id="restore-backup-file" class="w-full"></select>
            </label>
            <p class="foot-note text-rose-400">Restoring replaces everything: sales, inventory, customers and
              settings go back to the state in that file.</p>
          </div>
          <div class="modal-card__foot">
            <button type="button" id="restore-backup-cancel" class="btn-quiet">Cancel</button>
            <button type="button" id="restore-backup-confirm" class="btn-primary btn-primary--danger">Restore selected</button>
          </div>
        </div>
      </div>`);
    modal = document.getElementById(id);
    modal.querySelector('#restore-backup-cancel').addEventListener('click', () => closeModal(id));
    modal.querySelector('#restore-backup-confirm').addEventListener('click', () => {
      const file = document.getElementById('restore-backup-file').value;
      closeModal(id);
      confirmRestore(file);
    });
  }
  const sel = modal.querySelector('#restore-backup-file');
  sel.innerHTML = backups.map(b => {
    const when = new Date(b.modified_at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
    return `<option value="${escHtml(b.file)}">${escHtml(b.file)} · ${when} · ${fmtSize(b.size_bytes)}</option>`;
  }).join('');
  openModal(id);
}

async function confirmRestore(file) {
  const ok = await confirmModal(
    `Replace the live database with "${file}"? You may need to sign in again after the restore.`,
    { title: 'Restore this backup?', yes: 'Restore', danger: true });
  if (!ok) return;
  try {
    const res = await fetch('/api/backup/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file })
    });
    const data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.error || 'Restore failed');
    showToast(`Restored from ${data.restored_from}. Reloading…`, 'success');
    setTimeout(() => location.reload(), 1200);
  } catch (err) {
    showToast(`Error restoring backup: ${err.message}`, 'error');
  }
}

export async function downloadBackup() {
  if (!hasElevation()) {
    return new Promise((resolve, reject) => {
      requireManagerPin('Enter manager PIN to download a database backup', () => {
        downloadBackup().then(resolve, reject);
      });
    });
  }

  try {
    const res = await fetch('/api/backup', { method: 'POST' });
    const data = await res.json();
    if (!res.ok || !data.backup_file) {
      throw new Error(data.error || 'Backup creation failed');
    }
    const dl = typeof downloadCsvFile === 'function' ? downloadCsvFile : (await import('../main.js')).downloadCsvFile;
    const downloaded = await dl('/api/backup/download?file=' + encodeURIComponent(data.backup_file), data.backup_file);
    if (downloaded) {
      showToast(`Backup downloaded: ${data.backup_file}`, 'success');
    }
  } catch (err) {
    showToast(`Error creating backup download: ${err.message}`, 'error');
  }
}

export async function shutdownServer() {
  if (S.serviceMode) {
    document.body.innerHTML = `
      <div style="min-height: 100dvh; display: flex; align-items: center; justify-content: center; background: #0b1120; color: #f1f5f9; font-family: sans-serif; padding: 24px;">
        <div style="max-width: 420px; text-align: center; background: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 32px; box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.5);">
          <div style="width: 48px; height: 48px; border-radius: 9999px; background: rgba(16, 185, 129, 0.15); color: #10b981; display: flex; align-items: center; justify-content: center; margin: 0 auto 16px;">
            <svg style="width: 24px; height: 24px;" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path></svg>
          </div>
          <h2 style="font-size: 1.25rem; font-weight: 700; margin-bottom: 8px;">POS Window Closed</h2>
          <p style="color: #94a3b8; font-size: 0.875rem; margin-bottom: 12px;">Background server stays active; open the TechParts POS desktop shortcut whenever you want to return.</p>
          <p style="color: #64748b; font-size: 0.75rem; margin-bottom: 0;">You can now close this browser tab.</p>
        </div>
      </div>`;
    try { window.close(); } catch (_) {}
    return;
  }

  if (!hasElevation()) {
    requireManagerPin('Enter manager PIN to quit the POS', () => shutdownServer());
    return;
  }
  if (!await confirmModal('The POS server will stop. Finish and print any open receipt first.', { title: 'Quit the POS?', yes: 'Stop the server', danger: true })) return;
  
  const showShutdownScreen = () => {
    document.body.innerHTML = `
      <div style="min-height: 100dvh; display: flex; align-items: center; justify-content: center; background: #0b1120; color: #f1f5f9; font-family: sans-serif; padding: 24px;">
        <div style="max-width: 420px; text-align: center; background: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 32px; box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.5);">
          <div style="width: 48px; height: 48px; border-radius: 9999px; background: rgba(16, 185, 129, 0.15); color: #10b981; display: flex; align-items: center; justify-content: center; margin: 0 auto 16px;">
            <svg style="width: 24px; height: 24px;" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path></svg>
          </div>
          <h2 style="font-size: 1.25rem; font-weight: 700; margin-bottom: 8px;">POS Server Shut Down</h2>
          <p style="color: #94a3b8; font-size: 0.875rem; margin-bottom: 12px;">The server has been safely stopped.</p>
          <p style="color: #64748b; font-size: 0.75rem; margin-bottom: 0;">You can now close this browser tab.</p>
        </div>
      </div>`;
    try { window.close(); } catch (_) {}
  };

  try {
    await fetch('/api/system/shutdown', { method: 'POST' });
    showShutdownScreen();
  } catch (err) {
    // If the server terminates before or during response delivery, shutdown is successful
    showShutdownScreen();
  }
}

let _lastUpdateCheck = null;
let _bannerDismissed = false;
let _updateCheckInFlight = false;
let _updateApplyInFlight = false;
let _updateProgressTimer = null;

function renderUpdateProgressState(p) {
  if (!_updateApplyInFlight || !p) return;
  const mb = b => (Number(b || 0) / 1048576).toFixed(1);
  const pct = Number(p.percent) || 0;
  const hasBytes = p.downloadedBytes > 0;
  const hasTotal = p.totalBytes > 0;
  const retryNote = p.attempt > 1 ? ` · retry #${p.attempt}` : '';

  let shortLabel = 'Downloading…';
  let detailLabel = 'Downloading update from GitHub Releases…';
  if (p.phase === 'verifying') {
    shortLabel = 'Verifying…';
    detailLabel = 'Verifying SHA-256 checksum…';
  } else if (p.phase === 'restarting') {
    shortLabel = 'Restarting…';
    detailLabel = 'Applying update and restarting…';
  } else if (hasTotal && hasBytes) {
    shortLabel = `Downloading ${pct}%`;
    detailLabel = `Downloading update… ${pct}% (${mb(p.downloadedBytes)} / ${mb(p.totalBytes)} MB)${retryNote}`;
  } else if (hasBytes) {
    shortLabel = `Downloading ${mb(p.downloadedBytes)} MB`;
    detailLabel = `Downloading update… ${mb(p.downloadedBytes)} MB${retryNote}`;
  }

  for (const id of ['btn-apply-update', 'btn-banner-apply-update', 'btn-modal-apply-update']) {
    const lbl = document.getElementById(id)?.querySelector('span');
    if (lbl) lbl.textContent = shortLabel;
  }
  const chipText = document.getElementById('update-chip-text');
  if (chipText) chipText.textContent = shortLabel;
  const bannerText = document.getElementById('update-banner-text');
  if (bannerText) bannerText.textContent = detailLabel;
  const statusEl = document.getElementById('update-status-msg');
  if (statusEl) {
    statusEl.textContent = detailLabel;
    statusEl.className = 'foot-note text-cyan-400';
  }

  // Official Software Update Modal progress bar
  const modalProgressWrap = document.getElementById('modal-update-progress-wrap');
  const modalProgressBar = document.getElementById('modal-update-progress-bar');
  const modalProgressPct = document.getElementById('modal-update-progress-pct');
  const modalProgressDetail = document.getElementById('modal-update-progress-detail');
  const modalBadge = document.getElementById('modal-update-badge');
  if (modalProgressWrap) {
    modalProgressWrap.classList.remove('hidden');
    if (modalProgressBar && pct !== null) modalProgressBar.style.width = `${pct}%`;
    if (modalProgressPct && pct !== null) modalProgressPct.textContent = `${pct}%`;
    if (modalProgressDetail) modalProgressDetail.textContent = detailLabel;
    if (modalBadge) {
      modalBadge.textContent = shortLabel;
      modalBadge.className = 'px-2 py-0.5 rounded text-xs font-mono border border-[var(--line)] bg-[var(--pos-bg)] text-[var(--pos)] font-semibold';
    }
  }
}

function setCheckLoading(loading) {
  _updateCheckInFlight = loading;
  const checkBtn = document.getElementById('btn-check-updates');
  if (checkBtn) {
    checkBtn.disabled = loading;
    checkBtn.setAttribute('aria-busy', loading ? 'true' : 'false');
    const icon = checkBtn.querySelector('i');
    const label = checkBtn.querySelector('span');
    if (loading) {
      if (icon) icon.className = 'ph ph-arrows-clockwise w-3.5 h-3.5 animate-spin';
      if (label) label.textContent = 'Checking…';
    } else {
      if (icon) icon.className = 'ph ph-arrows-clockwise w-3.5 h-3.5';
      if (label) label.textContent = 'Check for updates';
    }
  }
}

function setApplyLoading(loading) {
  _updateApplyInFlight = loading;
  if (_updateProgressTimer) {
    clearInterval(_updateProgressTimer);
    _updateProgressTimer = null;
  }
  if (loading) {
    _updateProgressTimer = setInterval(async () => {
      if (!_updateApplyInFlight) return;
      try {
        const r = await fetch('/api/system/update/progress');
        if (r.ok) renderUpdateProgressState(await r.json());
      } catch (_) {}
    }, 400);
  }
  const settingsBtn = document.getElementById('btn-apply-update');
  const bannerBtn = document.getElementById('btn-banner-apply-update');
  const modalBtn = document.getElementById('btn-modal-apply-update');
  const dismissBtn = document.getElementById('btn-banner-dismiss-update');
  const checkBtn = document.getElementById('btn-check-updates');
  const chip = document.getElementById('update-status-chip');
  const chipText = document.getElementById('update-chip-text');
  const chipIcon = chip?.querySelector('i');

  if (dismissBtn) dismissBtn.disabled = loading;
  if (checkBtn) checkBtn.disabled = loading;

  const updateBtnState = (btn, normalText = t('update.now', 'Update Now')) => {
    if (!btn) return;
    btn.disabled = loading;
    btn.setAttribute('aria-busy', loading ? 'true' : 'false');
    const icon = btn.querySelector('i');
    const label = btn.querySelector('span');
    if (loading) {
      if (icon) icon.className = 'ph ph-circle-notch w-3.5 h-3.5 animate-spin';
      if (label) label.textContent = t('update.downloading_btn', 'Downloading…');
    } else {
      if (icon) icon.className = 'ph ph-download-simple w-3.5 h-3.5';
      if (label) label.textContent = normalText;
    }
  };

  updateBtnState(settingsBtn);
  updateBtnState(bannerBtn);
  updateBtnState(modalBtn);

  if (!loading) {
    const modalProgressWrap = document.getElementById('modal-update-progress-wrap');
    if (modalProgressWrap) modalProgressWrap.classList.add('hidden');
  }

  if (chip && chipIcon && chipText) {
    if (loading) {
      chipIcon.className = 'ph ph-circle-notch w-3.5 h-3.5 text-emerald-400 animate-spin';
      chipText.textContent = t('update.downloading_chip', 'Downloading update…');
    } else if (_lastUpdateCheck?.latestVersion) {
      chipIcon.className = 'ph ph-arrow-circle-up w-3.5 h-3.5 text-emerald-400';
      chipText.textContent = `Update ${_lastUpdateCheck.latestVersion}`;
    }
  }
  if (!loading && _lastUpdateCheck?.latestVersion) {
    const bannerText = document.getElementById('update-banner-text');
    if (bannerText) bannerText.textContent = t('update.available', 'A new version (%s) is available!').replace('%s', _lastUpdateCheck.latestVersion);
  }
}

export function dismissUpdateBanner() {
  if (_updateApplyInFlight) return;
  _bannerDismissed = true;
  document.getElementById('update-notification-banner')?.classList.add('hidden');
}

export function openUpdateModal() {
  if (_lastUpdateCheck?.hasUpdate) {
    const modalVer = document.getElementById('modal-update-version');
    if (modalVer) modalVer.textContent = `Version ${_lastUpdateCheck.latestVersion} available`;
    const modalCur = document.getElementById('modal-update-current');
    if (modalCur) modalCur.textContent = `Current version: v${_lastUpdateCheck.currentVersion || 'unknown'}`;
    const modalNotesLink = document.getElementById('modal-update-notes-link');
    if (modalNotesLink) modalNotesLink.href = _lastUpdateCheck.htmlUrl || 'https://github.com/katalepsis69/PHONEPOS/releases';
    const modalApplyBtn = document.getElementById('btn-modal-apply-update');
    if (modalApplyBtn && !modalApplyBtn._wired) {
      modalApplyBtn._wired = true;
      modalApplyBtn.addEventListener('click', () => {
        closeModal('modal-update');
        applyAppUpdate();
      });
    }
    openModal('modal-update');
  } else {
    checkForAppUpdates(false);
  }
}

export async function checkForAppUpdates(silent = false) {
  if (_updateCheckInFlight || _updateApplyInFlight) return;
  const statusEl = document.getElementById('update-status-msg');
  const applyBtn = document.getElementById('btn-apply-update');
  const releaseLink = document.getElementById('update-release-link');
  const versionEl = document.getElementById('update-current-version');

  if (!silent) setCheckLoading(true);

  if (statusEl && !silent) {
    statusEl.textContent = 'Checking GitHub Releases…';
    statusEl.className = 'foot-note text-[var(--txt-3)]';
  }

  try {
    const res = await fetch('/api/system/update/check');
    const data = await res.json();
    _lastUpdateCheck = data;

    if (versionEl && data.currentVersion) {
      versionEl.textContent = `v${data.currentVersion}`;
    }

    if (data.checkError) {
      if (statusEl) {
        statusEl.textContent = data.checkError;
        statusEl.className = 'foot-note text-amber-500';
      }
      if (!silent) showToast(data.checkError, 'warn');
      return;
    }

    if (data.hasUpdate) {
      if (statusEl) {
        statusEl.textContent = `Update ${data.latestVersion} is available!`;
        statusEl.className = 'foot-note text-[var(--pos)] font-medium';
      }
      if (applyBtn) applyBtn.classList.remove('hidden');
      if (releaseLink) {
        releaseLink.href = data.htmlUrl || 'https://github.com/katalepsis69/PHONEPOS/releases';
        releaseLink.classList.remove('hidden');
      }

      // Top notification banner
      const banner = document.getElementById('update-notification-banner');
      const bannerText = document.getElementById('update-banner-text');
      const bannerNotes = document.getElementById('update-banner-notes');
      if (banner && !_bannerDismissed) {
        if (bannerText) bannerText.textContent = `A new version (${data.latestVersion}) is available!`;
        if (bannerNotes) bannerNotes.href = data.htmlUrl || 'https://github.com/katalepsis69/PHONEPOS/releases';
        banner.classList.remove('hidden');
      }

      // Topbar status chip: always reveal when update is ready
      const chip = document.getElementById('update-status-chip');
      const chipText = document.getElementById('update-chip-text');
      const chipIcon = chip?.querySelector('i');
      if (chip) {
        if (chipIcon) chipIcon.className = 'ph ph-arrow-circle-up w-3.5 h-3.5 text-emerald-400';
        if (chipText) chipText.textContent = `Update ${data.latestVersion}`;
        chip.classList.remove('hidden');
      }

      // Pop up update modal
      const modalVer = document.getElementById('modal-update-version');
      if (modalVer) modalVer.textContent = `Version ${data.latestVersion} available`;
      const modalCur = document.getElementById('modal-update-current');
      if (modalCur) modalCur.textContent = `Current version: v${data.currentVersion || 'unknown'}`;
      const modalNotesLink = document.getElementById('modal-update-notes-link');
      if (modalNotesLink) modalNotesLink.href = data.htmlUrl || 'https://github.com/katalepsis69/PHONEPOS/releases';
      const modalApplyBtn = document.getElementById('btn-modal-apply-update');
      if (modalApplyBtn && !modalApplyBtn._wired) {
        modalApplyBtn._wired = true;
        modalApplyBtn.addEventListener('click', () => {
          closeModal('modal-update');
          applyAppUpdate();
        });
      }

      // Automatically prompt once per session per version, or on manual check
      const sessionPromptKey = `tp_update_prompted_${data.latestVersion}`;
      if (!silent || !sessionStorage.getItem(sessionPromptKey)) {
        sessionStorage.setItem(sessionPromptKey, '1');
        openModal('modal-update');
      }

      showToast(`Update ${data.latestVersion} is available!`, 'info');
    } else {
      if (statusEl) {
        statusEl.textContent = `You are up to date! (v${data.currentVersion})`;
        statusEl.className = 'foot-note text-[var(--txt-3)]';
      }
      if (applyBtn) applyBtn.classList.add('hidden');
      if (releaseLink) releaseLink.classList.add('hidden');
      document.getElementById('update-notification-banner')?.classList.add('hidden');
      document.getElementById('update-status-chip')?.classList.add('hidden');
      if (!silent) showToast(`TechParts POS is up to date (v${data.currentVersion})`, 'success');
    }
  } catch (err) {
    if (statusEl) {
      statusEl.textContent = 'Could not check for updates.';
      statusEl.className = 'foot-note text-rose-500';
    }
    if (!silent) showToast('Failed to check for updates', 'error');
  } finally {
    if (!silent) setCheckLoading(false);
  }
}

export async function applyAppUpdate() {
  if (_updateApplyInFlight) return;

  if (!hasElevation()) {
    requireManagerPin('Enter manager PIN to update TechParts POS', () => applyAppUpdate());
    return;
  }

  if (!await confirmModal('The POS will download the update, replace the executable, and restart automatically. Open receipts should be finished first.', { title: 'Install Update Now?', yes: 'Download & Restart', danger: false })) return;

  const statusEl = document.getElementById('update-status-msg');
  setApplyLoading(true);

  if (statusEl) {
    statusEl.textContent = 'Downloading update from GitHub Releases…';
    statusEl.className = 'foot-note text-cyan-400';
  }
  showToast('Downloading update from GitHub…', 'info');

  try {
    const payload = _lastUpdateCheck ? {
      downloadUrl: _lastUpdateCheck.downloadUrl,
      expectedBytes: _lastUpdateCheck.expectedBytes
    } : {};

    const res = await fetch('/api/system/update/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();

    if (data.runningInDev) {
      if (statusEl) statusEl.textContent = data.message;
      showToast(data.message, 'info');
      if (data.htmlUrl) window.open(data.htmlUrl, '_blank', 'noopener');
      setApplyLoading(false);
      return;
    }

    if (data.success) {
      showToast('Update downloaded. Restarting TechParts POS…', 'success');
      const releaseUrl = (_lastUpdateCheck && _lastUpdateCheck.htmlUrl) || '';
      // The handoff screen replaces the DOM the poll writes into; stop the
      // timer or it fires blind for the whole swap window.
      _updateApplyInFlight = false;
      if (_updateProgressTimer) { clearInterval(_updateProgressTimer); _updateProgressTimer = null; }
      document.body.innerHTML = `
        <div style="min-height: 100dvh; display: flex; align-items: center; justify-content: center; background: var(--app-bg); color: var(--txt); font-family: var(--font-text, system-ui, sans-serif); padding: 24px;">
          <div style="max-width: 440px; width: 100%; text-align: center; background: var(--surface); border: 1px solid var(--line); border-radius: 16px; padding: 36px 28px; box-shadow: 0 20px 40px -15px rgba(0, 0, 0, 0.1);">
            <div style="position: relative; width: 64px; height: 64px; margin: 0 auto 20px;">
              <div style="width: 64px; height: 64px; border-radius: 16px; background: var(--surface-2); border: 1px solid var(--line); display: flex; align-items: center; justify-content: center; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.05);">
                <img src="icon.svg" alt="TechParts POS" style="width: 36px; height: 36px; border-radius: 8px;">
              </div>
              <div style="position: absolute; right: -4px; bottom: -4px; width: 22px; height: 22px; border-radius: 9999px; background: var(--surface); border: 2px solid var(--surface); display: flex; align-items: center; justify-content: center;">
                <i class="ph ph-circle-notch animate-spin" style="font-size: 14px; color: var(--pos);"></i>
              </div>
            </div>
            <div style="font-size: 0.6875rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--txt-3); margin-bottom: 6px;">TechParts POS • System Update</div>
            <h2 style="font-size: 1.25rem; font-weight: 700; letter-spacing: -0.02em; color: var(--txt); margin: 0 0 8px 0;">Applying Update…</h2>
            <p style="color: var(--txt-3); font-size: 0.8125rem; line-height: 1.5; margin: 0 0 20px 0;">TechParts POS is restarting the background service and updating files. Your shop records stay safe.</p>
            <div style="display: inline-flex; align-items: center; gap: 8px; padding: 6px 14px; border-radius: 9999px; background: var(--surface-2); border: 1px solid var(--line); font-family: var(--font-numeric, monospace); font-size: 0.75rem; color: var(--txt-2); margin-bottom: 20px;">
              <span style="width: 7px; height: 7px; border-radius: 9999px; background: var(--pos); display: inline-block;"></span>
              <span id="update-handoff-clock">Waiting for the register to answer. 0s elapsed.</span>
            </div>
            <div style="text-align: left; background: var(--surface-2); border: 1px solid var(--line-soft); border-radius: 12px; padding: 14px 16px; font-size: 0.75rem; line-height: 1.6; color: var(--txt-3); display: flex; flex-direction: column; gap: 6px;">
              <div style="display: flex; align-items: center; gap: 8px; color: var(--pos); font-weight: 500;">
                <i class="ph ph-check-circle" style="font-size: 0.95rem; flex-shrink: 0;"></i>
                <span>Update package verified (SHA-256)</span>
              </div>
              <div style="display: flex; align-items: center; gap: 8px; color: var(--pos); font-weight: 500;">
                <i class="ph ph-check-circle" style="font-size: 0.95rem; flex-shrink: 0;"></i>
                <span>Executable handoff initiated</span>
              </div>
              <div style="display: flex; align-items: center; gap: 8px; color: var(--txt); font-weight: 600;">
                <i class="ph ph-arrows-clockwise animate-spin" style="font-size: 0.95rem; color: var(--pos); flex-shrink: 0;"></i>
                <span>Reconnecting to register…</span>
              </div>
            </div>
          </div>
        </div>`;
      const clockEl = document.getElementById('update-handoff-clock');
      watchForRegisterBack(clockEl, () => showUpdateHandoffStalled(releaseUrl, 90), 90);
    } else {
      throw new Error(data.error || 'Update failed');
    }
  } catch (err) {
    if (statusEl) {
      statusEl.textContent = `Update failed: ${err.message}`;
      statusEl.className = 'foot-note text-red-400';
    }
    showToast(`Update error: ${err.message}`, 'error');
    setApplyLoading(false);
  }
}

// One pass a second. The count is the point: a still screen reads as a freeze
// whether the swap is two seconds from done or never coming back. The first two
// passes ignore the probe because the old process is still shutting down, and an
// answer from it would reload this page into the version being replaced.
function watchForRegisterBack(clockEl, onStalled, limitS) {
  let waited = 0;
  const timer = setInterval(async () => {
    waited += 1;
    if (clockEl) clockEl.textContent = `Waiting for the register to answer. ${waited}s elapsed.`;
    if (waited > 2) {
      try {
        const probe = await fetch('/api/system/heartbeat', { method: 'POST' });
        if (probe.ok) {
          clearInterval(timer);
          try { sessionStorage.setItem('tp_update_complete', '1'); } catch (_) {}
          window.location.replace('/');
          return;
        }
      } catch (_) {}
    }
    if (waited >= limitS) {
      clearInterval(timer);
      onStalled();
    }
  }, 1000);
}

// The swap can still fail: a file locked by something else, a helper killed mid
// run. Without this state the operator had a spinner forever and no way out,
// which is exactly what a hung update looks like from the counter.
function showUpdateHandoffStalled(releaseUrl, waitedS) {
  document.body.innerHTML = `
    <div style="min-height: 100dvh; display: flex; align-items: center; justify-content: center; background: var(--app-bg); color: var(--txt); font-family: var(--font-text, system-ui, sans-serif); padding: 24px;">
      <div style="max-width: 480px; width: 100%; text-align: center; background: var(--surface); border: 1px solid var(--line); border-radius: 16px; padding: 36px 32px; box-shadow: 0 20px 40px -15px rgba(0, 0, 0, 0.1);">
        <div style="width: 56px; height: 56px; border-radius: 14px; background: var(--warn-bg, #FBF3DB); border: 1px solid var(--line); display: flex; align-items: center; justify-content: center; margin: 0 auto 20px; color: var(--warn, #7A5200);">
          <i class="ph ph-warning" style="font-size: 1.75rem;"></i>
        </div>
        <div style="font-size: 0.6875rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--txt-3); margin-bottom: 6px;">TechParts POS • Update Handoff</div>
        <h2 style="font-size: 1.25rem; font-weight: 700; letter-spacing: -0.02em; color: var(--txt); margin: 0 0 8px 0;">The register has not come back</h2>
        <p style="color: var(--txt-3); font-size: 0.8125rem; line-height: 1.5; margin: 0 0 12px 0;">Nothing answered here for ${waitedS} seconds. Start TechParts POS again and press Update Now to retry the swap.</p>
        <div style="color: var(--txt-3); font-size: 0.75rem; font-family: var(--font-numeric, monospace); background: var(--surface-2); border: 1px solid var(--line); border-radius: 8px; padding: 8px 12px; margin: 0 0 16px 0; word-break: break-all; text-align: left;">
          <span style="display: block; font-size: 0.6875rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--txt-4); margin-bottom: 2px;">Log location</span>
          ${S.serviceMode ? 'C:\\ProgramData\\TechPartsPOS\\updates\\TechPartsPOS_update.handoff.log' : '%LOCALAPPDATA%\\TechPartsPOS\\TechPartsPOS_update.handoff.log'}
        </div>
        <p id="update-handoff-clock" style="color: var(--txt-3); font-size: 0.8125rem; margin-bottom: 20px;">Waiting for the register to answer. 0s elapsed.</p>
        <div style="display: flex; gap: 10px; justify-content: center; flex-wrap: wrap;">
          <button type="button" id="update-handoff-wait" class="btn-primary" style="min-height: 44px; padding: 0 20px; font-weight: 600; font-size: 0.875rem; border-radius: 8px; cursor: pointer;">
            <i class="ph ph-clock-countdown w-4 h-4"></i> <span>Keep waiting</span>
          </button>
          ${releaseUrl ? `<button type="button" id="update-handoff-page" class="btn-secondary" style="min-height: 44px; padding: 0 18px; font-weight: 600; font-size: 0.875rem; border-radius: 8px; cursor: pointer; background: var(--surface-2); color: var(--txt); border: 1px solid var(--line);">
            <i class="ph ph-arrow-square-out w-4 h-4"></i> <span>Open release page</span>
          </button>` : ''}
        </div>
      </div>
    </div>`;
  // The URL stays out of the markup: it arrives from a network response, and a
  // closure keeps it out of any attribute the browser would have to parse.
  const pageBtn = document.getElementById('update-handoff-page');
  if (pageBtn) pageBtn.addEventListener('click', () => window.open(releaseUrl, '_blank', 'noopener'));
  const waitBtn = document.getElementById('update-handoff-wait');
  if (waitBtn) {
    waitBtn.addEventListener('click', () => {
      waitBtn.disabled = true;
      const stalledClock = document.getElementById('update-handoff-clock');
      watchForRegisterBack(stalledClock, () => showUpdateHandoffStalled(releaseUrl, 120), 120);
    });
  }
}
