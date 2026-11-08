import { S } from '../state.js';
import { attachCombo, closeModal, confirmModal, escHtml, fmtMoney, formatDateTime, openModal, showSkeleton, showToast } from '../ui.js';
import { formatCostPrice, hasElevation, isStaff, requireManagerPin, openSettingsModal } from '../auth.js';
import { loadPosCatalog } from './pos.js';
import { IMPORT_COLUMNS, matchHeaders, parseMoney, parseSku, parseXlsx } from '../importer.js';
import { t } from '../i18n.js';

let inventoryRequest = 0;
export const selectedPartIds = new Set();

export function clearInventorySelection() {
  selectedPartIds.clear();
  updateBulkBar();
  document.querySelectorAll('.inv-row-check').forEach(cb => { cb.checked = false; });
  const allCb = document.getElementById('inv-select-all');
  if (allCb) { allCb.checked = false; allCb.indeterminate = false; }
}

export function updateBulkBar() {
  const bar = document.getElementById('inv-bulk-bar');
  const countEl = document.getElementById('inv-bulk-count');
  const allCb = document.getElementById('inv-select-all');
  const size = selectedPartIds.size;
  if (bar) {
    bar.classList.toggle('hidden', size === 0);
  }
  if (countEl) {
    countEl.textContent = `${size} ${t('common.selected', 'selected')}`;
  }
  if (allCb) {
    const visibleIds = (S.inventoryRowsCache || []).map(i => i.id);
    const visibleSelected = visibleIds.filter(id => selectedPartIds.has(id)).length;
    allCb.checked = visibleIds.length > 0 && visibleSelected === visibleIds.length;
    allCb.indeterminate = visibleSelected > 0 && visibleSelected < visibleIds.length;
  }
}

// -------------------------------------------------------------
// INVENTORY CATALOG VIEW
// -------------------------------------------------------------
// index.html is kept static, so the metric strip, part-type filter and
// sales-rate column are injected here (same pattern as the wiring above).
export function setupInventoryEnhancements() {
  const view = document.getElementById('view-inventory');
  if (!view) return;

  if (!document.getElementById('inv-metric-total')) {
    const metrics = document.createElement('div');
    metrics.className = 'grid grid-cols-2 md:grid-cols-4 gap-3 shrink-0';
    metrics.innerHTML = `
      <div class="stat">
        <span class="stat__label" data-i18n="inv.stat_parts">${t('inv.stat_parts', 'Parts in catalog')}</span>
        <span id="inv-metric-total" class="stat__value">0</span>
        <span id="inv-metric-stock" class="stat__meta">0 units on hand</span>
      </div>
      <div class="stat stat--pos">
        <span class="stat__label" data-i18n="inv.stat_in_stock">${t('inv.stat_in_stock', 'In stock')}</span>
        <span id="inv-metric-in" class="stat__value">0</span>
        <span class="stat__meta" data-i18n="inv.stat_healthy">${t('inv.stat_healthy', 'healthy levels')}</span>
      </div>
      <div class="stat stat--warn">
        <span class="stat__label" data-i18n="inv.stat_low_stock">${t('inv.stat_low_stock', 'Low stock')}</span>
        <span id="inv-metric-low" class="stat__value">0</span>
        <span class="stat__meta" data-i18n="inv.stat_reorder">${t('inv.stat_reorder', 'at or below reorder point')}</span>
      </div>
      <div class="stat stat--danger">
        <span class="stat__label" data-i18n="inv.stat_out_stock">${t('inv.stat_out_stock', 'Out of stock')}</span>
        <span id="inv-metric-out" class="stat__value">0</span>
        <span class="stat__meta" data-i18n="inv.stat_restock">${t('inv.stat_restock', 'needs restock')}</span>
      </div>
    `;
    view.prepend(metrics);
  }

  const brandSel = document.getElementById('inv-brand-filter');
  if (brandSel && !document.getElementById('inv-type-filter')) {
    const typeSel = document.createElement('select');
    typeSel.id = 'inv-type-filter';
    typeSel.className = 'select-sm';
    typeSel.setAttribute('aria-label', 'Filter parts by part type');
    typeSel.innerHTML = `<option value="" data-i18n="inv.all_types">${t('inv.all_types', 'All Part Types')}</option>`;
    typeSel.addEventListener('change', loadInventoryTable);
    brandSel.insertAdjacentElement('afterend', typeSel);
  }

  const allCb = document.getElementById('inv-select-all');
  if (allCb && !allCb.dataset.bound) {
    allCb.dataset.bound = '1';
    allCb.addEventListener('change', () => {
      const visibleIds = (S.inventoryRowsCache || []).map(i => i.id);
      if (allCb.checked) {
        visibleIds.forEach(id => selectedPartIds.add(id));
      } else {
        visibleIds.forEach(id => selectedPartIds.delete(id));
      }
      document.querySelectorAll('.inv-row-check').forEach(cb => {
        const id = Number(cb.dataset.id);
        cb.checked = selectedPartIds.has(id);
      });
      updateBulkBar();
    });
  }

  const tbody = document.getElementById('inventory-tbody');
  if (tbody && !tbody.dataset.bulkBound) {
    tbody.dataset.bulkBound = '1';
    tbody.addEventListener('change', e => {
      if (e.target.classList.contains('inv-row-check')) {
        const id = Number(e.target.dataset.id);
        if (e.target.checked) selectedPartIds.add(id);
        else selectedPartIds.delete(id);
        updateBulkBar();
      }
    });
  }

  const clearBtn = document.getElementById('inv-bulk-clear-btn');
  if (clearBtn && !clearBtn.dataset.bound) {
    clearBtn.dataset.bound = '1';
    clearBtn.addEventListener('click', clearInventorySelection);
  }

  const editBtn = document.getElementById('inv-bulk-edit-btn');
  if (editBtn && !editBtn.dataset.bound) {
    editBtn.dataset.bound = '1';
    editBtn.addEventListener('click', openBulkEditModal);
  }

  const reorderToggle = document.getElementById('inv-reorder-toggle');
  if (reorderToggle && !reorderToggle.dataset.bound) {
    reorderToggle.dataset.bound = '1';
    reorderToggle.addEventListener('click', () => {
      const panel = document.getElementById('inv-reorder-panel');
      if (!panel) return;
      const willShow = panel.classList.contains('hidden');
      panel.classList.toggle('hidden', !willShow);
      // Re-fetch on every open so the sheet is never stale, not even after a sale.
      if (willShow) loadReorderPanel();
    });
  }

  const reorderDays = document.getElementById('inv-reorder-days');
  if (reorderDays && !reorderDays.dataset.bound) {
    reorderDays.dataset.bound = '1';
    reorderDays.addEventListener('change', loadReorderPanel);
  }

  // One delegated listener covers per-supplier copy buttons and copy-all (*).
  const reorderPanel = document.getElementById('inv-reorder-panel');
  if (reorderPanel && !reorderPanel.dataset.copyBound) {
    reorderPanel.dataset.copyBound = '1';
    reorderPanel.addEventListener('click', e => {
      const btn = e.target.closest('[data-reorder-copy]');
      if (btn) copyReorderList(btn.dataset.reorderCopy);
    });
  }

  // Edited order quantities re-price their row and group live.
  const reorderContent = document.getElementById('inv-reorder-content');
  if (reorderContent && !reorderContent.dataset.qtyBound) {
    reorderContent.dataset.qtyBound = '1';
    reorderContent.addEventListener('input', e => {
      if (e.target.matches('input[data-qty-id]')) updateReorderMoney(e.target);
    });
  }
}

export async function loadInventoryTable() {
  const request = ++inventoryRequest;
  const search = document.getElementById('inv-search')?.value || '';
  const brand = document.getElementById('inv-brand-filter')?.value || '';
  const partType = document.getElementById('inv-type-filter')?.value || '';
  const lowStock = document.getElementById('inv-low-stock-check')?.checked || false;
  const showArchived = document.getElementById('inv-archived-check')?.checked || false;
  showSkeleton('inventory-tbody', 9);

  let url = `/api/inventory?search=${encodeURIComponent(search)}`;
  if (brand) url += `&brand=${encodeURIComponent(brand)}`;
  if (partType) url += `&part_type=${encodeURIComponent(partType)}`;
  if (lowStock) url += `&low_stock=true`;
  if (showArchived) url += `&include_archived=true`;

  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error('Inventory request failed');
    const items = await res.json();
    if (request !== inventoryRequest) return;
    renderInventoryTable(items);
    renderInventoryMetrics(items);
  } catch (err) {
    if (request !== inventoryRequest) return;
    console.error('Failed to load inventory table:', err);
    // If a skeleton is showing (no previous rows to keep), replace it with an
    // honest error state + retry instead of leaving "perpetual loading".
    // When older rows exist they stay on screen: stale data beats a blank
    // table, and the toast says the refresh failed.
    const tbody = document.getElementById('inventory-tbody');
    if (tbody && tbody.querySelector('.skel')) {
      tbody.innerHTML = `<tr><td colspan="9">
        <div class="empty">
          <div class="empty__icon"><i class="ph ph-wifi-slash w-5 h-5"></i></div>
          <div class="empty__title">Couldn't load inventory</div>
          <p class="empty__body">The server didn't answer. Retry, or check that the POS server is running.</p>
          <button type="button" class="chip" data-action="reload-inventory">Retry</button>
        </div>
      </td></tr>`;
    }
    showToast('Could not load inventory - check the server and retry', 'error');
  }
}

// Latest rows rendered in the inventory view — the edit modal reads from here
// so opening it costs no extra fetch.
// initialized in state.js: S.inventoryRowsCache

export function renderInventoryMetrics(items) {
  let inStock = 0, low = 0, out = 0, units = 0;
  items.forEach(i => {
    const q = Number(i.stock_quantity) || 0;
    units += q;
    if (q <= 0) out++;
    else if (q <= (Number(i.min_stock_alert) || 0)) low++;
    else inStock++;
  });
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  set('inv-metric-total', items.length);
  set('inv-metric-stock', `${units.toLocaleString()} ${t('inv.stat_units', 'units on hand')}`);
  set('inv-metric-in', inStock);
  set('inv-metric-low', low);
  set('inv-metric-out', out);
}

// -------------------------------------------------------------
// REORDER SHEET — computed live from recent sales, grouped by supplier
// -------------------------------------------------------------
let reorderReport = null;
let reorderRequest = 0;

export async function loadReorderPanel() {
  const request = ++reorderRequest;
  const days = document.getElementById('inv-reorder-days')?.value || '3';
  const content = document.getElementById('inv-reorder-content');
  if (!content) return;
  try {
    const res = await fetch(`/api/inventory/reorder?days=${encodeURIComponent(days)}`);
    if (!res.ok) throw new Error('Reorder request failed');
    const report = await res.json();
    if (request !== reorderRequest) return;
    renderReorderPanel(report);
  } catch (err) {
    if (request !== reorderRequest) return;
    console.error('Failed to load reorder list:', err);
    content.innerHTML = `<p class="foot-note p-3">${escHtml(t('inv.reorder_error', "Couldn't load the reorder list."))}</p>`;
    showToast(t('inv.reorder_error', "Couldn't load the reorder list."), 'error');
  }
}

// Server rows arrive sorted by supplier, so first-seen grouping keeps that order.
// ponytail: O(n²) group find is fine, catalogs are hundreds of rows not millions
function reorderGroups(report) {
  const groups = [];
  for (const r of (report?.rows || [])) {
    const supplier = (r.supplier || '').trim();
    let g = groups.find(x => x.supplier === supplier);
    if (!g) groups.push(g = { supplier, rows: [] });
    g.rows.push(r);
  }
  return groups;
}

const reorderItemName = r => `${r.brand} ${r.model_name} - ${r.part_type}`;

const round2 = v => Math.round((Number(v) || 0) * 100) / 100;

// The edited order quantity lives in the DOM input — single source of truth,
// no edit-state to keep in sync. Falls back to the server suggestion.
function domQty(id, fallback) {
  const input = document.querySelector(`input[data-qty-id="${id}"]`);
  if (!input) return fallback;
  return Math.max(0, Math.floor(Number(input.value) || 0));
}

// One cell renderer for the est-cost column, used at render time and on live
// edits, so the two can never drift. The "ea" suffix is the unit-cost anchor:
// it shows what the total is based on so the manager can trim the order.
const estCellHtml = (r, qty) => {
  if (r.cost_price == null) return '—';
  const unit = ` <span class="reorder-unit">${fmtMoney(round2(r.cost_price))} ea</span>`;
  return `${fmtMoney(round2(qty * r.cost_price))}${unit}`;
};

// Keep the money honest while the cashier edits quantities: recompute the row's
// est cost and its group subtotal from the same inputs the copy button reads.
function updateReorderMoney(inputEl) {
  if (!reorderReport) return;
  const row = reorderReport.rows.find(r => r.id === Number(inputEl.dataset.qtyId));
  if (!row || row.cost_price == null) return;
  const qty = Math.max(0, Math.floor(Number(inputEl.value) || 0));
  const estCell = document.querySelector(`[data-est-id="${row.id}"]`);
  if (estCell) estCell.innerHTML = estCellHtml(row, qty);
  const group = inputEl.closest('[data-reorder-group]');
  if (!group) return;
  let sum = 0;
  for (const r of reorderReport.rows) {
    if ((r.supplier || '').trim() !== group.dataset.reorderGroup || r.cost_price == null) continue;
    sum += domQty(r.id, r.suggested_qty) * r.cost_price;
  }
  const sub = group.querySelector('[data-reorder-subtotal]');
  if (sub) sub.textContent = fmtMoney(round2(sum));
}

// Plain-text order sheet to paste into a supplier chat (Messenger/Viber).
// Quantities come from the editable inputs; only actionable lines (qty > 0) travel.
function buildReorderText() {
  const groups = reorderGroups(reorderReport);
  return groups.map(g => {
    const lines = [
      `ORDER - ${g.supplier || t('inv.reorder_no_supplier', 'No supplier')} - ${new Date().toLocaleDateString('en-CA')}`,
      ...g.rows
        .map(r => ({ r, qty: domQty(r.id, r.suggested_qty) }))
        .filter(x => x.qty > 0)
        .map(x => `${x.qty}x ${reorderItemName(x.r)}${x.r.sku_barcode ? ` (${x.r.sku_barcode})` : ''}`)
    ];
    if (g.rows.some(r => r.est_cost != null)) {
      const sum = g.rows.reduce((s, r) => (r.cost_price != null ? s + domQty(r.id, r.suggested_qty) * r.cost_price : s), 0);
      lines.push(`Est. cost: ${fmtMoney(round2(sum))}`);
    }
    return lines.join('\n');
  }).join('\n\n');
}

async function copyReorderList() {
  if (!reorderReport || !(reorderReport.rows || []).length) {
    showToast(t('inv.reorder_empty', 'No parts sold in this window.'), 'info');
    return;
  }
  const hasAny = reorderGroups(reorderReport).some(g => g.rows.some(r => domQty(r.id, r.suggested_qty) > 0));
  if (!hasAny) {
    showToast(t('inv.reorder_empty', 'No parts sold in this window.'), 'info');
    return;
  }
  try {
    await navigator.clipboard.writeText(buildReorderText());
    showToast(t('inv.reorder_copied', 'Order list copied - paste it to your supplier'), 'success');
  } catch {
    showToast('Could not copy - check that the page is focused and try again', 'error');
  }
}

function renderReorderPanel(report) {
  const content = document.getElementById('inv-reorder-content');
  if (!content) return;
  reorderReport = report;
  const groups = reorderGroups(report);
  if (groups.length === 0) {
    content.innerHTML = `<p class="foot-note p-3">${escHtml(t('inv.reorder_empty', 'No parts sold in this window.'))}</p>`;
    return;
  }
  // Staff sessions get est_cost nulled server-side; hide the whole money column
  // instead of showing dashes that say nothing to a cashier.
  const showCost = (report.rows || []).some(r => r.est_cost != null);
  content.innerHTML = groups.map(g => `
    <div class="mb-3" data-reorder-group="${escHtml(g.supplier)}">
      <h3 class="font-bold text-sm py-1">${escHtml(g.supplier || t('inv.reorder_no_supplier', 'No supplier'))}</h3>
      <table class="ptable">
        <thead><tr>
          <th data-i18n="inv.reorder_col_item">${t('inv.reorder_col_item', 'Item')}</th>
          <th class="is-mid" data-i18n="inv.reorder_col_sku">${t('inv.reorder_col_sku', 'SKU')}</th>
          <th class="is-num" data-i18n="inv.reorder_col_sold">${t('inv.reorder_col_sold', 'Sold')}</th>
          <th class="is-num" data-i18n="inv.reorder_col_on_hand">${t('inv.reorder_col_on_hand', 'On hand')}</th>
          <th class="is-num" data-i18n="inv.reorder_col_order">${t('inv.reorder_col_order', 'Order')}</th>
          ${showCost ? `<th class="is-num" data-i18n="inv.reorder_col_cost">${t('inv.reorder_col_cost', 'Est. cost (₱)')}</th>` : ''}
        </tr></thead>
        <tbody>
          ${g.rows.map(r => `
          <tr>
            <td>${escHtml(reorderItemName(r))}</td>
            <td class="is-mid font-mono text-xs">${escHtml(r.sku_barcode || '')}</td>
            <td class="is-num font-mono tabular-nums">${r.qty_sold}</td>
            <td class="is-num font-mono tabular-nums">${r.stock_quantity}</td>
            <td class="is-num">
              <input type="number" inputmode="numeric" min="0" step="1" value="${r.suggested_qty}" data-qty-id="${r.id}"
                class="reorder-qty"
                aria-label="${escHtml(t('inv.reorder_col_order', 'Order quantity'))} - ${escHtml(reorderItemName(r))}">
            </td>
            ${showCost ? `<td class="is-num font-mono tabular-nums" data-est-id="${r.id}">${estCellHtml(r, r.suggested_qty)}</td>` : ''}
          </tr>`).join('')}
        </tbody>
        ${showCost ? `<tfoot><tr>
            <td colspan="5" class="text-right font-bold">${escHtml(t('inv.reorder_group_total', 'Est. cost'))}</td>
            <td class="is-num font-mono tabular-nums font-bold" data-reorder-subtotal>${fmtMoney(round2(g.rows.reduce((s, r) => s + (r.est_cost || 0), 0)))}</td>
          </tr></tfoot>` : ''}
      </table>
    </div>`).join('');
}

export function renderPartTypeOptions() {
  const sel = document.getElementById('inv-type-filter');
  if (!sel) return;
  const current = sel.value;
  const types = [...new Set(S.inventoryItems.map(i => (i.part_type || '').trim()).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));
  sel.innerHTML = `<option value="" data-i18n="inv.all_types">${escHtml(t('inv.all_types', 'All Part Types'))}</option>` +
    types.map(tp => `<option value="${escHtml(tp)}">${escHtml(tp)}</option>`).join('');
  if (types.includes(current)) sel.value = current;
}

// The inventory tab's brand filter mirrors the POS one: options from the live
// catalog, not the hardcoded launch list. (Archived-only brands drop out —
// the catalog cache excludes them; acceptable edge.)
export function renderInvBrandFilter() {
  const sel = document.getElementById('inv-brand-filter');
  if (!sel) return;
  const current = sel.value;
  const brands = [...new Set(S.inventoryItems.map(i => i.brand))].sort();
  sel.innerHTML = '<option value="">All Brands</option>' +
    brands.map(b => `<option value="${escHtml(b)}">${escHtml(b)}</option>`).join('');
  if (brands.includes(current)) sel.value = current;
  else sel.value = '';
}

// Model + Part Type comboboxes for the Add/Edit part modals. Options are read
// live on every open/keystroke, so a brand change re-scopes the model list
// with no extra wiring; typed text always stands (new phones must be enterable).
// No COMBO_MAX cap here: the list is bounded by the shop's own catalog and the
// dropdown already scrolls — capping made a brand's model list look truncated.
export function attachPartCombos({ brandId, modelId, typeId }) {
  const modelInput = document.getElementById(modelId);
  if (modelInput) {
    attachCombo(modelInput, {
      getOptions: q => {
        const brand = document.getElementById(brandId)?.value || '';
        const ql = q.toLowerCase();
        return [...new Set(S.inventoryItems.filter(i => i.brand === brand).map(i => i.model_name))]
          .sort()
          .filter(m => m.toLowerCase().includes(ql));
      },
      renderOption: m => `<span class="combo__name">${escHtml(m)}</span>`,
      renderEmpty: q => `<div class="combo__empty">No saved model${q ? ' matching “' + escHtml(q) + '”' : ' for this brand'} — your text will be saved as new.</div>`
    });
  }
  const typeInput = document.getElementById(typeId);
  if (typeInput) {
    attachCombo(typeInput, {
      getOptions: q => {
        const ql = q.toLowerCase();
        return [...new Set(S.inventoryItems.map(i => (i.part_type || '').trim()).filter(Boolean))]
          .sort((a, b) => a.localeCompare(b))
          .filter(t => t.toLowerCase().includes(ql));
      },
      renderOption: t => `<span class="combo__name">${escHtml(t)}</span>`,
      renderEmpty: q => `<div class="combo__empty">No saved part type${q ? ' matching “' + escHtml(q) + '”' : ''} - your text will be saved as new.</div>`
    });
  }
}

// Inline "SKU already taken" warning for the Add/Edit part forms.
export function attachSkuWarning(inputId, warnId, excludeIdFn) {
  const input = document.getElementById(inputId);
  const warn = document.getElementById(warnId);
  if (!input || !warn) return;
  input.addEventListener('input', () => {
    const sku = input.value.trim();
    const exclude = excludeIdFn ? excludeIdFn() : null;
    warn.classList.toggle('hidden', !(sku && S.inventoryItems.some(i => i.sku_barcode === sku && i.id !== exclude)));
  });
}

export function renderInventoryTable(items) {
  S.inventoryRowsCache = items;
  const tbody = document.getElementById('inventory-tbody');
  if (!tbody) return;

  if (items.length === 0) {
    tbody.innerHTML = `
      <tr><td colspan="9">
        <div class="empty">
          <div class="empty__icon"><i class="ph ph-package w-5 h-5"></i></div>
          <div class="empty__title">No parts in this view</div>
          <p class="empty__body">Adjust the brand or low-stock filter, or add a new phone part to the catalog.</p>
        </div>
      </td></tr>
    `;
    updateBulkBar();
    return;
  }

  tbody.innerHTML = items.map(item => {
    const isOut = item.stock_quantity <= 0;
    const isLow = item.stock_quantity > 0 && item.stock_quantity <= item.min_stock_alert;
    const statusBadge = item.archived
      ? `<span class="tag">Archived</span>`
      : (isOut
        ? `<span class="badge-rose px-2 py-0.5 text-xs font-semibold">Out of stock</span>`
        : (isLow
          ? `<span class="badge-amber px-2 py-0.5 text-xs font-semibold">Low stock</span>`
          : `<span class="badge-emerald px-2 py-0.5 text-xs font-semibold">In stock</span>`));

    // Price/part editing is manager-only: hide (not just re-prompt) for a
    // plain staff session. Stock adjust and history stay for everyone.
    const canEditParts = !isStaff() || hasElevation();
    const isChecked = selectedPartIds.has(item.id);

    return `
      <tr${item.archived ? ' class="archived-row"' : ''}>
        <td class="w-8 text-center">
          <input type="checkbox" class="inv-row-check checkbox-sm cursor-pointer" data-id="${item.id}"
            aria-label="Select ${escHtml(item.brand)} ${escHtml(item.model_name)} ${escHtml(item.part_type)}"
            ${isChecked ? 'checked' : ''}>
        </td>
        <td>
          <span class="block pname__t">${escHtml(item.model_name)}</span>
          <span class="block foot-note uppercase">${escHtml(item.brand)}</span>
        </td>
        <td>
          ${escHtml(item.part_type)}
          ${item.location ? `<span class="block foot-note">${escHtml(item.location)}</span>` : ''}
        </td>
        <td class="is-num">
          <button type="button" class="cell-btn font-mono" data-action="reveal-cost" title="Click to unlock/view cost prices">${formatCostPrice(item.cost_price)}</button>
        </td>
        <td class="is-num money font-mono">${fmtMoney(Number(item.price_retail))}</td>
        <td class="is-num font-mono font-bold">${fmtMoney(Number(item.price_technician))}</td>
        <td class="is-mid"><span class="stock${isOut ? ' stock--out' : (isLow ? ' stock--low' : '')}">${item.stock_quantity}</span></td>
        <td class="is-mid">${statusBadge}</td>
        <td class="is-mid">
          <span class="inline-flex items-center gap-1">
            ${canEditParts ? `<button data-action="edit-part" data-part-id="${item.id}" class="btn-mini" title="Edit part / set stock" aria-label="Edit part / set stock">
              <i class="ph ph-pencil w-3.5 h-3.5"></i>
            </button>` : ''}
            <button data-action="adjust-stock" data-part-id="${item.id}" class="btn-mini" title="Adjust / receive with reason">Adj</button>
            <button data-action="movement-history" data-part-id="${item.id}" class="btn-mini" title="Stock movement history">Hist</button>
            ${canEditParts ? (item.archived
              ? `<button data-action="unarchive-part" data-part-id="${item.id}" class="btn-mini" title="Restore this part to the active catalog">Unarch</button>`
              : `<button data-action="archive-part" data-part-id="${item.id}" class="btn-mini btn-mini--danger" title="Archive: hide from catalog and POS, keep stock and history">Arch</button>`) : ''}
          </span>
        </td>
      </tr>
    `;
  }).join('');

  updateBulkBar();
}

export function openAddPartModal() {
  if (!hasElevation()) {
    requireManagerPin('Enter manager PIN to add parts to the catalog', () => openAddPartModal());
    return;
  }
  const costEl = document.getElementById('part-cost');
  const retailEl = document.getElementById('part-retail');
  const techEl = document.getElementById('part-tech');
  if (costEl && retailEl && techEl && !costEl.dataset.markupBound) {
    costEl.dataset.markupBound = '1';
    retailEl.addEventListener('input', () => { delete retailEl.dataset.autoMarkup; });
    techEl.addEventListener('input', () => { delete techEl.dataset.autoMarkup; });
    costEl.addEventListener('input', () => {
      const cost = Number(costEl.value);
      if (!(cost > 0)) return;
      const retPct = Number(S.shopSettings?.default_retail_markup_pct ?? 50);
      const whoPct = Number(S.shopSettings?.default_wholesale_markup_pct ?? 20);
      if (!retailEl.value || retailEl.dataset.autoMarkup === '1') {
        retailEl.value = String(Math.round(cost * (1 + (Number.isFinite(retPct) ? retPct : 50) / 100)));
        retailEl.dataset.autoMarkup = '1';
      }
      if (!techEl.value || techEl.dataset.autoMarkup === '1') {
        techEl.value = String(Math.round(cost * (1 + (Number.isFinite(whoPct) ? whoPct : 20) / 100)));
        techEl.dataset.autoMarkup = '1';
      }
    });
  }
  if (retailEl && !retailEl.value) retailEl.dataset.autoMarkup = '1';
  if (techEl && !techEl.value) techEl.dataset.autoMarkup = '1';
  openModal('modal-add-part');
}

// Slow POST + a second Enter would create the part twice.
let addPartInFlight = false;
export async function submitAddPart(e) {
  e.preventDefault();
  const brand = document.getElementById('part-brand').value;
  const model_name = document.getElementById('part-model').value.trim();
  const part_type = document.getElementById('part-type').value.trim();
  const cost_price = Number(document.getElementById('part-cost').value);
  const price_retail = Number(document.getElementById('part-retail').value);
  const price_technician = Number(document.getElementById('part-tech').value);
  const stock_quantity = Number(document.getElementById('part-stock').value);
  const min_stock_alert = Number(document.getElementById('part-min-alert').value);
  const sku_barcode = document.getElementById('part-sku').value.trim();
  const supplier = document.getElementById('part-supplier').value.trim();
  const location = document.getElementById('part-location').value.trim();

  // Duplicate guard (client): same brand+model+type can be legit (quality
  // grades), so ask before creating a near-twin row.
  const dup = findPartDuplicate(brand, model_name, part_type);
  if (dup) {
    const ok = await confirmModal(
      `${brand} ${model_name} — ${part_type} already exists with ${dup.stock_quantity} in stock. Create anyway?`,
      { title: 'Duplicate part?', yes: 'Create anyway' });
    if (!ok) return;
  }

  if (addPartInFlight) return;
  addPartInFlight = true;
  try {
    const res = await fetch('/api/inventory', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        op_id: crypto.randomUUID(),
        brand, model_name, part_type, sku_barcode, supplier, location,
        cost_price, price_retail, price_technician, stock_quantity, min_stock_alert
      })
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'Failed to create part');
    }
    closeModal('modal-add-part');
    document.getElementById('form-add-part').reset();
    document.getElementById('part-sku-warn')?.classList.add('hidden');
    loadInventoryTable();
    loadPosCatalog();
    showToast('Part added to inventory catalog', 'success');
  } catch (err) {
    showToast(`Error: ${err.message}`, 'error');
  } finally {
    addPartInFlight = false;
  }
}

// Case-insensitive brand+model+part_type match against the cached catalog.
export function findPartDuplicate(brand, model_name, part_type, excludeId) {
  const norm = s => String(s || '').trim().toLowerCase();
  return S.inventoryItems.find(i =>
    i.id !== excludeId &&
    norm(i.brand) === norm(brand) &&
    norm(i.model_name) === norm(model_name) &&
    norm(i.part_type) === norm(part_type)) || null;
}

// ---- Adjust / Receive modal (reason + note land in the stock ledger) ----
export function openAdjustStockModal(id) {
  const item = S.inventoryRowsCache.find(i => i.id === id);
  if (!item) return;
  document.getElementById('adjust-part-id').value = id;
  document.getElementById('adjust-part-name').textContent =
    `${item.brand} ${item.model_name} — ${item.part_type} (current stock: ${item.stock_quantity})`;
  document.getElementById('adjust-delta').value = '';
  document.getElementById('adjust-reason').value = 'receive';
  document.getElementById('adjust-note').value = '';
  openModal('modal-adjust-stock');
}

let adjustInFlight = false;
export async function submitAdjustStock(e) {
  e.preventDefault();
  const id = document.getElementById('adjust-part-id').value;
  const delta = Number(document.getElementById('adjust-delta').value);
  const reason = document.getElementById('adjust-reason').value;
  const note = document.getElementById('adjust-note').value.trim();
  if (adjustInFlight) return;
  adjustInFlight = true;
  try {
    const res = await fetch(`/api/inventory/${id}/adjust-stock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ delta, reason, note, op_id: crypto.randomUUID() })
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'Stock adjustment failed');
    }
    closeModal('modal-adjust-stock');
    loadInventoryTable();
    loadPosCatalog();
    showToast(`Stock ${delta > 0 ? '+' : ''}${delta} recorded (${reason})`, 'success');
  } catch (err) {
    showToast(`Error: ${err.message}`, 'error');
  } finally {
    adjustInFlight = false;
  }
}

// ---- Stock movement history (read-only ledger view) ----
export async function openMovementHistory(id) {
  const item = S.inventoryRowsCache.find(i => i.id === id);
  if (!item) return;
  document.getElementById('history-part-name').textContent =
    `${item.brand} ${item.model_name} — ${item.part_type} (current stock: ${item.stock_quantity})`;
  const body = document.getElementById('history-body');
  body.innerHTML = '<p class="foot-note">Loading…</p>';
  openModal('modal-movement-history');
  try {
    const res = await fetch(`/api/inventory/${id}/movements`);
    if (!res.ok) throw new Error('Could not load history');
    const moves = await res.json();
    if (moves.length === 0) {
      body.innerHTML = '<p class="foot-note">No stock movements recorded yet.</p>';
      return;
    }
    body.innerHTML = moves.map(m => `
      <div class="flex items-center gap-2" style="padding:6px 0;border-bottom:1px solid var(--line-soft, rgba(148,163,184,.15));">
        <span class="stock${m.delta < 0 ? ' stock--out' : ' stock--low'} font-mono" style="min-width:3rem;">${m.delta > 0 ? '+' : ''}${m.delta}</span>
        <span class="tag">${escHtml(m.reason)}</span>
        ${m.ref ? `<span class="foot-note font-mono">${escHtml(m.ref)}</span>` : ''}
        ${m.note ? `<span class="foot-note">${escHtml(m.note)}</span>` : ''}
        <span class="foot-note font-mono" style="margin-left:auto;">${escHtml(formatDateTime(m.created_at))}</span>
      </div>`).join('');
  } catch (err) {
    body.innerHTML = `<p class="foot-note">${escHtml(err.message)}</p>`;
  }
}

// ---- Archive / Unarchive (soft delete; stock and history stay) ----
// `isArchived` = the item's CURRENT state: true means it is archived and the
// action is Unarchive. Callers pass this from the row's rendered action
// (active rows render "Archive", archived rows render "Unarchive").
export async function archiveInventoryItemPrompt(id, isArchived) {
  if (!hasElevation()) {
    requireManagerPin('Enter manager PIN to archive parts', () => archiveInventoryItemPrompt(id, isArchived));
    return;
  }
  const item = S.inventoryRowsCache.find(i => i.id === id);
  const label = item ? `${item.brand} ${item.model_name} — ${item.part_type}` : 'This part';
  const ok = await confirmModal(
    isArchived
      ? `${label} will be restored to the active catalog and POS.`
      : `${label} will be hidden from the catalog and POS. Its stock and history are kept.`,
    { title: isArchived ? 'Unarchive part?' : 'Archive part?', yes: isArchived ? 'Unarchive' : 'Archive', danger: !isArchived });
  if (!ok) return;
  try {
    const res = await fetch(`/api/inventory/${id}/${isArchived ? 'unarchive' : 'archive'}`, { method: 'POST' });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'Archive failed');
    }
    loadInventoryTable();
    loadPosCatalog();
    showToast(isArchived ? 'Part restored to the catalog' : 'Part archived', 'success');
  } catch (err) {
    showToast(`Error: ${err.message}`, 'error');
  }
}

// ---- CSV import (client parse, server-side atomic apply) ----
// Quoted-CSV state machine: handles quotes, embedded commas/quotes/newlines.
export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  const endField = () => { row.push(field); field = ''; };
  const endRow = () => {
    endField();
    if (row.length > 1 || row[0] !== '') rows.push(row); // skip blank lines
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      endField();
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      endRow();
    } else field += c;
  }
  endRow();
  return rows;
}

const IMPORT_REQUIRED = ['brand', 'model_name', 'part_type', 'stock_quantity'];
const IMPORT_PRICE_COLS = ['cost_price', 'price_retail', 'price_technician'];
let importState = null; // { rows, header } for the mapping preview

export function importCsvFile(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  (async () => {
    try {
      if (!/\.(csv|xlsx)$/i.test(file.name)) throw new Error('Save this file as .xlsx or .csv first; legacy .xls is not supported.');
      if (file.size > 5 * 1024 * 1024) throw new Error('Import files must be 5 MB or smaller.');
      const isXlsx = /\.xlsx$/i.test(file.name);
      const rows = isXlsx ? await parseXlsx(await file.arrayBuffer()) : parseCsv(await file.text());
      openImportPreview(rows);
    } catch (err) {
      showToast(`Import failed: ${err.message}`, 'error');
    } finally {
      event.target.value = ''; // re-selecting the same file re-fires onchange
    }
  })();
}

// ---- Import preview: shows auto-matched parts and calculated selling prices.
// Anything the server rejects is reported row-wise (all-or-nothing).
function ensureImportPreviewModal() {
  if (document.getElementById('modal-import-preview')) return;
  document.body.insertAdjacentHTML('beforeend', `
    <div id="modal-import-preview" class="modal-backdrop fixed inset-0 z-[92] flex items-center justify-center hidden"
      role="dialog" aria-modal="true" aria-labelledby="import-preview-title">
      <div class="modal-card w-full max-w-xl">
        <div class="modal-card__head"><h3 id="import-preview-title" class="modal-card__title">Confirm import</h3></div>
        <div class="modal-card__body space-y-3">
          <p id="import-preview-note" class="foot-note"></p>
          <div id="import-auto-price-tip" class="p-2.5 rounded border border-[var(--line-soft)] bg-[var(--surface-sunken)] text-xs text-[var(--txt-2)] flex items-center justify-between gap-3 flex-wrap">
            <span id="import-auto-price-tip-text"></span>
            <button type="button" id="import-settings-btn" class="btn-mini shrink-0 inline-flex items-center gap-1"
              data-i18n-title="inv.open_store_settings" title="Open Store Settings">
              <i class="ph ph-gear w-3.5 h-3.5" aria-hidden="true"></i>
              <span data-i18n="inv.settings_store">Settings &gt; Store</span>
            </button>
          </div>
          <div id="import-missing-warning" class="hidden p-2.5 rounded border text-xs" style="border-color: var(--danger); color: var(--danger);"></div>
          <div id="import-table-wrap" class="max-h-48 overflow-auto rounded border border-[var(--line-soft)]">
            <table id="import-preview-table" class="w-full text-xs"></table>
          </div>
          <div id="import-errors" class="hidden rounded border p-2 max-h-32 overflow-auto" style="border-color: var(--danger);"></div>
        </div>
        <div class="modal-card__foot">
          <button type="button" id="import-preview-cancel" class="btn-quiet">Cancel</button>
          <button type="button" id="import-preview-ok" class="btn-primary">Import</button>
        </div>
      </div>
    </div>`);

  document.getElementById('import-preview-cancel').addEventListener('click', () => closeModal('modal-import-preview'));
  document.getElementById('import-preview-ok').addEventListener('click', applyImport);
  document.getElementById('import-settings-btn')?.addEventListener('click', () => {
    closeModal('modal-import-preview');
    openSettingsModal('store');
    setTimeout(() => {
      document.getElementById('settings-default-retail-markup')?.focus();
    }, 150);
  });
  const modal = document.getElementById('modal-import-preview');
  modal.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      closeModal('modal-import-preview');
    }
  });
}

export function openImportPreview(rows) {
  if (!Array.isArray(rows) || rows.length < 2) {
    showToast('The file has no data rows', 'error');
    return;
  }
  const header = Array.from(rows[0], h => String(h ?? '').trim());
  ensureImportPreviewModal();
  const errBox = document.getElementById('import-errors');
  if (errBox) { errBox.innerHTML = ''; errBox.classList.add('hidden'); }
  importState = { rows, header, op_id: crypto.randomUUID() };
  const auto = matchHeaders(header);

  const missing = IMPORT_REQUIRED.filter(col => auto[col] === -1);
  const warnBox = document.getElementById('import-missing-warning');
  const tableWrap = document.getElementById('import-table-wrap');
  const tipBox = document.getElementById('import-auto-price-tip');
  const okBtn = document.getElementById('import-preview-ok');

  const retPct = Number(S.shopSettings?.default_retail_markup_pct ?? 50);
  const whoPct = Number(S.shopSettings?.default_wholesale_markup_pct ?? 20);

  if (missing.length > 0) {
    const missingLabels = missing.map(m => m.replace(/_/g, ' ')).join(', ');
    warnBox.innerHTML = `
      <p class="font-semibold">Missing required columns: ${escHtml(missingLabels)}</p>
      <p class="mt-1">Make sure your headers match the template format.</p>
      <button type="button" id="import-download-sample-btn" class="btn-mini mt-2">Download template</button>
    `;
    warnBox.classList.remove('hidden');
    warnBox.querySelector('#import-download-sample-btn')?.addEventListener('click', downloadImportTemplate);
    tableWrap.classList.add('hidden');
    tipBox.classList.add('hidden');
    document.getElementById('import-preview-note').textContent = `${rows.length - 1} data row(s) detected.`;
    okBtn.disabled = true;
    okBtn.textContent = 'Missing columns';
    openModal('modal-import-preview');
    return;
  }

  warnBox.classList.add('hidden');
  tableWrap.classList.remove('hidden');
  tipBox.classList.remove('hidden');

  const tipMsg = (t('inv.import_auto_note', 'Blank prices use store markup (%s% retail, %s% wholesale) for new parts, and for existing parts when their capital changed. Set in Settings > Store.'))
    .replace('%s', retPct).replace('%s', whoPct);
  document.getElementById('import-auto-price-tip-text').textContent = tipMsg;

  const dataRows = rows.slice(1);
  const previewData = dataRows.slice(0, 4).map(r => {
    const obj = {};
    for (const [col, idx] of Object.entries(auto)) {
      if (idx !== -1) obj[col] = String(r[idx] ?? '').trim();
    }
    const cost = Number(obj.cost_price || 0);
    let ret = obj.price_retail, who = obj.price_technician;
    let retAuto = false, whoAuto = false;
    if (cost > 0) {
      if (!ret || Number(ret) === 0) {
        ret = Math.round(cost * (1 + retPct / 100));
        retAuto = true;
      }
      if (!who || Number(who) === 0) {
        who = Math.round(cost * (1 + whoPct / 100));
        whoAuto = true;
      }
    }
    return { ...obj, ret, who, retAuto, whoAuto };
  });

  document.getElementById('import-preview-note').textContent =
    `${dataRows.length} part(s) ready to import.`;

  document.getElementById('import-preview-table').innerHTML = `
    <thead>
      <tr class="text-left border-b border-[var(--line-soft)]">
        <th class="px-2 py-1">${escHtml(t('part.brand', 'Brand'))}</th>
        <th class="px-2 py-1">${escHtml(t('part.model', 'Model'))}</th>
        <th class="px-2 py-1">${escHtml(t('part.type', 'Type'))}</th>
        <th class="px-2 py-1">${escHtml(t('part.cost', 'Capital'))}</th>
        <th class="px-2 py-1">${escHtml(t('part.retail', 'Retail'))}</th>
        <th class="px-2 py-1">${escHtml(t('part.wholesale', 'Wholesale'))}</th>
        <th class="px-2 py-1">${escHtml(t('part.stock', 'Stock'))}</th>
      </tr>
    </thead>
    <tbody>
      ${previewData.map(p => `
        <tr class="border-b border-[var(--line-soft)]">
          <td class="px-2 py-1">${escHtml(p.brand || '-')}</td>
          <td class="px-2 py-1">${escHtml(p.model_name || '-')}</td>
          <td class="px-2 py-1">${escHtml(p.part_type || '-')}</td>
          <td class="px-2 py-1 font-mono">${p.cost_price ? '₱' + escHtml(p.cost_price) : '-'}</td>
          <td class="px-2 py-1 font-mono">${p.ret ? '₱' + escHtml(p.ret) + (p.retAuto ? ' <span class="tag tag--quiet text-xs">auto</span>' : '') : '-'}</td>
          <td class="px-2 py-1 font-mono">${p.who ? '₱' + escHtml(p.who) + (p.whoAuto ? ' <span class="tag tag--quiet text-xs">auto</span>' : '') : '-'}</td>
          <td class="px-2 py-1 font-mono">${escHtml(p.stock_quantity || '0')}</td>
        </tr>
      `).join('')}
    </tbody>`;

  okBtn.disabled = false;
  okBtn.textContent = `Import ${dataRows.length} part(s)`;
  openModal('modal-import-preview');
}

function showImportErrors(messages) {
  const box = document.getElementById('import-errors');
  if (!box) return;
  box.innerHTML = messages.map(m => `<p class="foot-note stock--out">${escHtml(m)}</p>`).join('');
  box.classList.remove('hidden');
}

let importInFlight = false;
async function applyImport() {
  if (importInFlight) return;
  const auto = matchHeaders(importState.header);
  let rows;
  try {
    rows = importState.rows.slice(1).map(r => {
      const obj = {};
      for (const [col, hdrIdx] of Object.entries(auto)) {
        if (hdrIdx === -1) continue;
        let v = String(r[hdrIdx] ?? '').trim();
        if (v === '') continue;
        if (IMPORT_PRICE_COLS.includes(col)) v = parseMoney(v);
        else if (col === 'sku_barcode') v = parseSku(v);
        obj[col] = v;
      }
      return obj;
    }).filter(o => Object.keys(o).length);
  } catch (err) {
    showImportErrors([err.message]);
    return;
  }
  if (!rows.length) {
    showImportErrors(['No data rows to import']);
    return;
  }
  const btn = document.getElementById('import-preview-ok');
  btn.disabled = true;
  btn.textContent = 'Importing…';
  importInFlight = true;
  try {
    const retailMarkup = Number(S.shopSettings?.default_retail_markup_pct ?? 50);
    const wholesaleMarkup = Number(S.shopSettings?.default_wholesale_markup_pct ?? 20);

    const res = await fetch('/api/inventory/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        rows,
        op_id: importState.op_id,
        auto_price: true,
        retail_markup: retailMarkup,
        wholesale_markup: wholesaleMarkup
      })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Import failed');
    closeModal('modal-import-preview');
    loadInventoryTable();
    loadPosCatalog();
    showToast(data.replayed
      ? 'Import was already applied (duplicate submit)'
      : `Import complete: ${data.created} created, ${data.updated} updated`, 'success');
  } catch (err) {
    showImportErrors(err.message.split(' | '));
    showToast('Import failed: fix the highlighted rows and try again', 'error');
    if (btn) {
      btn.disabled = false;
      btn.textContent = `Import ${importState.rows.length - 1} part(s)`;
    }
  } finally {
    importInFlight = false;
  }
}

export function triggerCsvImport() {
  if (!hasElevation()) {
    requireManagerPin('Enter manager PIN to import inventory', () => triggerCsvImport());
    return;
  }
  document.getElementById('inv-import-file')?.click();
}

// Friendly headers with no dummy data rows. The alias matcher maps these
// names the same as snake_case, so the template reads like a spreadsheet.
const IMPORT_TEMPLATE_HEADERS = ['Brand', 'Model Name', 'Part Type', 'SKU / Barcode', 'Capital',
  'Retail Price', 'Wholesale Price', 'Stock Qty', 'Min Stock Alert', 'Supplier', 'Location'];

export function downloadImportTemplate() {
  const csv = [IMPORT_TEMPLATE_HEADERS].map(row => row.join(',')).join('\r\n') + '\r\n';
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = 'inventory-import-template.csv';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// ---- Edit part (modal is in index.html) ----
const PART_BRANDS = ['Apple', 'Samsung', 'Xiaomi', 'Infinix', 'Tecno', 'Realme', 'Oppo', 'Vivo', 'Huawei', 'Other'];

export function openEditPartModal(id) {
  if (!hasElevation()) {
    requireManagerPin('Enter manager PIN to edit parts and prices', () => openEditPartModal(id));
    return;
  }
  const item = S.inventoryRowsCache.find(i => i.id === id);
  if (!item) return;

  const brandSel = document.getElementById('edit-part-brand');
  const brands = PART_BRANDS.includes(item.brand) ? PART_BRANDS : [item.brand, ...PART_BRANDS];
  brandSel.innerHTML = brands.map(b => `<option value="${escHtml(b)}">${escHtml(b)}</option>`).join('');
  brandSel.value = item.brand;

  document.getElementById('edit-part-id').value = item.id;
  document.getElementById('edit-part-model').value = item.model_name || '';
  document.getElementById('edit-part-type').value = item.part_type || '';
  document.getElementById('edit-part-sku').value = item.sku_barcode || '';
  document.getElementById('edit-part-supplier').value = item.supplier || '';
  document.getElementById('edit-part-location').value = item.location || '';
  document.getElementById('edit-part-cost').value = item.cost_price ?? 0;
  document.getElementById('edit-part-retail').value = item.price_retail ?? 0;
  document.getElementById('edit-part-tech').value = item.price_technician ?? 0;
  document.getElementById('edit-part-stock').value = item.stock_quantity ?? 0;
  document.getElementById('edit-part-min-alert').value = item.min_stock_alert ?? 2;
  document.getElementById('edit-part-sku-warn')?.classList.add('hidden');
  // Stamped at open: the PUT sends it back and the server refuses the save if
  // a sale moved the shelf since this form was filled (stale-form overwrite).
  editPartExpectedStock = item.stock_quantity ?? 0;
  editPartOpId = crypto.randomUUID();

  openModal('modal-edit-part');
}

let editPartInFlight = false;
// Stamped by openEditPartModal, sent with every Apply until the modal closes:
// the shelf count the form was filled from, plus one op key for dedup.
let editPartExpectedStock = null;
let editPartOpId = null;
export async function submitEditPart(e) {
  e.preventDefault();
  const id = Number(document.getElementById('edit-part-id').value);
  const brand = document.getElementById('edit-part-brand').value;
  const model_name = document.getElementById('edit-part-model').value.trim();
  const part_type = document.getElementById('edit-part-type').value.trim();

  // Identity moved onto another existing row? Ask before saving the merge.
  const dup = findPartDuplicate(brand, model_name, part_type, id);
  if (dup) {
    const ok = await confirmModal(
      `${brand} ${model_name} — ${part_type} already exists (ID ${dup.id}, ${dup.stock_quantity} in stock). Merge-looking edit — save anyway?`,
      { title: 'Duplicate part?', yes: 'Save anyway' });
    if (!ok) return;
  }

  if (editPartInFlight) return;
  editPartInFlight = true;
  try {
    const res = await fetch(`/api/inventory/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        brand,
        model_name,
        part_type,
        sku_barcode: document.getElementById('edit-part-sku').value.trim(),
        supplier: document.getElementById('edit-part-supplier').value.trim(),
        location: document.getElementById('edit-part-location').value.trim(),
        cost_price: Number(document.getElementById('edit-part-cost').value),
        price_retail: Number(document.getElementById('edit-part-retail').value),
        price_technician: Number(document.getElementById('edit-part-tech').value),
        stock_quantity: Number(document.getElementById('edit-part-stock').value),
        min_stock_alert: Number(document.getElementById('edit-part-min-alert').value),
        expected_stock: editPartExpectedStock,
        op_id: editPartOpId
      })
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      // The shelf moved under this form (a concurrent sale): keep the modal
      // open with the fresh row so the manager can decide, instead of
      // resurrecting sold units.
      if (res.status === 409) {
        showToast(data.error || 'Stock changed; reopening the part with the current shelf count.', 'error');
        closeModal('modal-edit-part');
        openEditPartModal(id);
        return;
      }
      throw new Error(data.error || 'Failed to save part');
    }

    closeModal('modal-edit-part');
    loadInventoryTable();
    loadPosCatalog();
    showToast('Part updated', 'success');
  } catch (err) {
    showToast(`Error: ${err.message}`, 'error');
  } finally {
    editPartInFlight = false;
  }
}

// -------------------------------------------------------------
// BULK EDIT MODAL
// -------------------------------------------------------------
// BULK EDIT MODAL
// -------------------------------------------------------------
function ensureBulkEditModal() {
  const modal = document.getElementById('modal-bulk-edit');
  if (!modal || modal.dataset.bound) return;
  modal.dataset.bound = '1';

  const actionSel = document.getElementById('bulk-action-type');
  const cancelBtn = document.getElementById('bulk-edit-cancel');
  const form = document.getElementById('form-bulk-edit');

  actionSel.addEventListener('change', () => {
    const act = actionSel.value;
    document.getElementById('bulk-panel-adjust-price').classList.toggle('hidden', act !== 'adjust_price');
    document.getElementById('bulk-panel-recalculate').classList.toggle('hidden', act !== 'recalculate_markup');
    document.getElementById('bulk-panel-fields').classList.toggle('hidden', act !== 'update_fields');
    document.getElementById('bulk-panel-archive').classList.toggle('hidden', act !== 'archive' && act !== 'unarchive');
    const infoEl = document.getElementById('bulk-archive-info');
    if (infoEl) {
      if (act === 'archive') {
        infoEl.dataset.i18n = 'bulk.archive_info';
        infoEl.textContent = t('bulk.archive_info', 'Selected parts will be hidden from the active catalog and POS. Stock quantity and ledger history will be preserved.');
      } else if (act === 'unarchive') {
        infoEl.dataset.i18n = 'bulk.unarchive_info';
        infoEl.textContent = t('bulk.unarchive_info', 'Selected parts will be restored to the active catalog and POS.');
      }
    }
  });

  cancelBtn.addEventListener('click', () => closeModal('modal-bulk-edit'));
  modal.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      closeModal('modal-bulk-edit');
    }
    if (e.key === 'Tab') {
      const controls = [...modal.querySelectorAll('input:not(:disabled), select:not(:disabled), button:not(:disabled)')];
      if (!controls.length) return;
      const first = controls[0], last = controls[controls.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });

  form.addEventListener('submit', submitBulkEdit);
}

let bulkEditInFlight = false;
// One op_id per modal session, reused by every Apply until the modal closes on
// success: a retry after a lost response re-answers instead of moving every
// selected price twice.
let bulkEditOpId = null;
async function submitBulkEdit(e) {
  e.preventDefault();
  if (bulkEditInFlight) return;
  if (selectedPartIds.size === 0) {
    showToast(t('bulk.none_selected', 'Select one or more parts first'), 'error');
    return;
  }
  const action = document.getElementById('bulk-action-type').value;
  const params = {};

  if (action === 'adjust_price') {
    const rawVal = document.getElementById('bulk-price-val').value.trim();
    if (!rawVal || !Number.isFinite(Number(rawVal))) {
      showToast('Enter a valid adjustment value', 'error');
      return;
    }
    params.target = document.getElementById('bulk-price-target').value;
    params.mode = document.getElementById('bulk-price-mode').value;
    params.value = Number(rawVal);
  } else if (action === 'recalculate_markup') {
    const rawRet = document.getElementById('bulk-retail-markup').value.trim();
    const rawWho = document.getElementById('bulk-wholesale-markup').value.trim();
    const ret = Number(rawRet);
    const who = Number(rawWho);
    if (!rawRet || !Number.isFinite(ret) || ret < 0 || !rawWho || !Number.isFinite(who) || who < 0) {
      showToast('Enter non-negative markup percentages', 'error');
      return;
    }
    params.retail_markup = ret;
    params.wholesale_markup = who;
  } else if (action === 'update_fields') {
    const sup = document.getElementById('bulk-supplier').value.trim();
    const loc = document.getElementById('bulk-location').value.trim();
    const minAlert = document.getElementById('bulk-min-alert').value.trim();
    if (sup) params.supplier = sup;
    if (loc) params.location = loc;
    if (minAlert !== '') {
      const parsedAlert = Number(minAlert);
      if (!Number.isInteger(parsedAlert) || parsedAlert < 0) {
        showToast('Min stock alert must be a non-negative whole number', 'error');
        return;
      }
      params.min_stock_alert = parsedAlert;
    }
    if (Object.keys(params).length === 0) {
      showToast('Please fill in at least one field to update', 'error');
      return;
    }
  }

  const submitBtn = document.getElementById('bulk-edit-submit');
  bulkEditInFlight = true;
  if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = t('bulk.applying', 'Applying...'); }
  try {
    const res = await fetch('/api/inventory/bulk-edit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [...selectedPartIds], action, params, op_id: bulkEditOpId })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || t('bulk.failed', 'Bulk edit failed'));
    closeModal('modal-bulk-edit');
    clearInventorySelection();
    loadInventoryTable();
    loadPosCatalog();
    if (data.replayed) {
      showToast(t('bulk.replayed', 'Bulk edit was already applied (duplicate submit)'), 'success');
    } else if (data.updated === 0 && action === 'recalculate_markup') {
      showToast(t('bulk.no_updated', 'No parts were updated (selected parts may have zero cost price)'), 'warning');
    } else {
      showToast(`${t('bulk.applied', 'Bulk edit applied to')} ${data.updated} ${t('bulk.parts_count', 'part(s)')}`, 'success');
    }
  } catch (err) {
    showToast(`${t('bulk.failed', 'Bulk edit failed')}: ${err.message}`, 'error');
  } finally {
    bulkEditInFlight = false;
    if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = t('bulk.apply', 'Apply Changes'); }
  }
}

export function openBulkEditModal() {
  if (!hasElevation()) {
    requireManagerPin('Enter manager PIN to bulk edit inventory', () => openBulkEditModal());
    return;
  }
  if (selectedPartIds.size === 0) {
    showToast(t('bulk.none_selected', 'Select one or more parts first'), 'error');
    return;
  }
  ensureBulkEditModal();
  // Fresh intent per modal session; every Apply inside reuses this id so a
  // lost-response retry resolves to the same op instead of applying twice.
  bulkEditOpId = crypto.randomUUID();
  const badge = document.getElementById('bulk-edit-badge');
  if (badge) badge.textContent = `${selectedPartIds.size} ${t('common.selected', 'selected')}`;

  const retInput = document.getElementById('bulk-retail-markup');
  const whoInput = document.getElementById('bulk-wholesale-markup');
  if (retInput) retInput.value = S.shopSettings.default_retail_markup_pct ?? 50;
  if (whoInput) whoInput.value = S.shopSettings.default_wholesale_markup_pct ?? 20;

  document.getElementById('bulk-action-type').value = 'adjust_price';
  document.getElementById('bulk-action-type').dispatchEvent(new Event('change'));
  document.getElementById('bulk-price-val').value = '';

  openModal('modal-bulk-edit');
}
