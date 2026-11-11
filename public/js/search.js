// Global search palette (Ctrl+K): customers and parts in one type-to-filter
// list over data the app has already loaded. Selecting a customer opens the
// 360 drawer; selecting a part filters the shelf.
import { S } from './state.js';
import { closeModal, escHtml, fmtMoney, openModal } from './ui.js';
import { switchTab } from './main.js';
import { renderPartsTable } from './views/pos.js';
import { openCustomerLedger } from './views/backoffice.js';

const PALETTE_GROUPS = [
  {
    label: 'Customers',
    match: q => S.allCustomersCache.filter(c =>
      c.customer_name.toLowerCase().includes(q) || String(c.customer_phone || '').includes(q)).slice(0, 6),
    pick: c => openCustomerLedger(c.customer_name),
    render: c => ({
      main: escHtml(c.customer_name),
      sub: c.total_credit_balance > 0.001 ? 'utang ' + fmtMoney(Number(c.total_credit_balance)) : (escHtml(c.customer_phone || '') || 'clean'),
    }),
  },
  {
    label: 'Parts',
    match: q => (S.posCatalog || S.inventoryItems).filter(p =>
      `${p.item_name || ''} ${p.brand} ${p.model_name} ${p.part_type} ${p.category || ''} ${p.sku_barcode || ''}`.toLowerCase().includes(q)).slice(0, 6),
    pick: p => {
      switchTab('pos');
      const input = document.getElementById('pos-search-input');
      if (input) { input.value = p.item_name || `${p.brand} ${p.model_name}`; }
      renderPartsTable();
    },
    render: p => ({
      main: `${escHtml(p.item_name || `${p.brand} ${p.model_name}`)} <span class="palette__sub-note">${escHtml(p.item_name ? (p.category || p.part_type || '') : p.part_type)}</span>`,
      sub: p.stock_quantity > 0 ? `${p.stock_quantity} in stock` : 'out of stock',
    }),
  },
];

let paletteInited = false;
let highlighted = -1;
let flatItems = [];

export function openSearchPalette() {
  initPalette();
  const input = document.getElementById('palette-input');
  if (input) input.value = '';
  highlighted = -1;
  renderPaletteResults('');
  openModal('modal-search');
  setTimeout(() => input?.focus(), 60);
}

function initPalette() {
  if (paletteInited) return;
  paletteInited = true;
  const input = document.getElementById('palette-input');
  input?.addEventListener('input', () => {
    highlighted = -1;
    renderPaletteResults(input.value.trim().toLowerCase());
  });
  input?.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (flatItems.length === 0) return;
      const dir = e.key === 'ArrowDown' ? 1 : -1;
      highlighted = Math.max(0, Math.min(flatItems.length - 1, highlighted + dir));
      document.querySelectorAll('.palette__item').forEach(el =>
        el.classList.toggle('is-active', Number(el.dataset.idx) === highlighted));
      document.querySelector(`.palette__item[data-idx="${highlighted}"]`)?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (highlighted >= 0 && flatItems[highlighted]) pickItem(flatItems[highlighted]);
      else if (flatItems.length === 1) pickItem(flatItems[0]);
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      closeModal('modal-search');
    }
  });
  // Clicks on results (mousedown keeps focus behavior simple inside the list).
  document.getElementById('palette-results')?.addEventListener('mousedown', e => {
    const item = e.target.closest('.palette__item');
    if (item) pickItem(flatItems[Number(item.dataset.idx)]);
  });
}

function renderPaletteResults(q) {
  const box = document.getElementById('palette-results');
  if (!box) return;
  flatItems = [];

  if (!q) {
    box.innerHTML = `<div class="palette__empty">Type to search customers and parts — Ctrl K opens this from anywhere.</div>`;
    return;
  }

  let html = '';
  for (const group of PALETTE_GROUPS) {
    const hits = group.match(q);
    if (hits.length === 0) continue;
    html += `<div class="palette__group">${group.label}</div>`;
    for (const hit of hits) {
      const r = group.render(hit);
      const idx = flatItems.length;
      flatItems.push({ pick: () => group.pick(hit) });
      html += `<button type="button" class="palette__item${idx === highlighted ? ' is-active' : ''}" data-idx="${idx}" role="option">
        <span class="palette__main">${r.main}</span>
        <span class="palette__sub">${r.sub}</span>
      </button>`;
    }
  }
  box.innerHTML = html || `<div class="palette__empty">No matches for “${escHtml(q)}”.</div>`;
}

function pickItem(item) {
  closeModal('modal-search');
  item.pick();
}
