import { S } from '../state.js';
import { t } from '../i18n.js';
import { attachCombo, confirmModal, escHtml, fmtMoney, inputModal, openModal, setCounterText, showToast } from '../ui.js';
import { renderInvBrandFilter, renderPartTypeOptions, itemMatchesProfile, TEMPLATE_BRANDS, TEMPLATE_CATEGORIES } from '../views/inventory.js';
import { autoPrintSlip, renderClaimStub, renderReceipt, shopIdentityIsPlaceholder } from '../receipts.js';
import { serializeCartForRecovery, deserializeCartForRecovery } from '../cart-recovery.js';

const SALE_OP_KEY = 'pos_sale_op_id';

// -------------------------------------------------------------
// CUSTOMER SUGGESTIONS & AUTOCOMPLETE
// -------------------------------------------------------------
export async function loadCustomerSuggestions() {
  try {
    const res = await fetch('/api/customers');
    if (res.ok) {
      // The cache feeds the combobox and the utang badge; the <datalist>
      // itself is retired (the combobox replaces its popup).
      S.allCustomersCache = await res.json();
    }
  } catch (err) {
    console.error('Failed to load customer suggestions:', err);
  }
}

export function onCustomerNameInput() {
  const nameInput = document.getElementById('pos-customer-name');
  const badge = document.getElementById('pos-cust-status-badge');
  const phoneInput = document.getElementById('pos-customer-phone');
  if (!nameInput || !badge) return;

  const typed = nameInput.value.trim().toLowerCase();
  const matched = S.allCustomersCache.find(c => c.customer_name.toLowerCase() === typed);

  if (matched) {
    if (matched.customer_phone && phoneInput && !phoneInput.value) {
      phoneInput.value = matched.customer_phone;
    }
    badge.classList.remove('hidden');
    // State lives in words: color and emoji alone exclude color-blind cashiers.
    if (matched.total_credit_balance > 0.001) {
      badge.className = 'text-xs px-2 py-0.5 rounded font-mono font-bold bg-rose-500/20 text-rose-300 border border-rose-500/30';
      badge.textContent = `Active utang: ${fmtMoney(matched.total_credit_balance)}`;
    } else {
      badge.className = 'text-xs px-2 py-0.5 rounded font-mono font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30';
      badge.textContent = 'No balance / paid';
    }
  } else {
    badge.classList.add('hidden');
  }
}

// -------------------------------------------------------------
// CUSTOMER COMBOBOX (replaces the native datalist popup)
// -------------------------------------------------------------
// Substring match on name AND phone (the datalist only prefix-matches),
// utang status visible per row before selection, full keyboard support,
// and proper combobox ARIA. Appended to <body> so the panel's
// overflow:hidden can't clip it.
const COMBO_MAX = 8;

// Generic type-to-filter combobox under any text input: type to filter,
// ArrowUp/Down + Enter to pick, typed text always stands as a new entry.
// getOptions(query) -> candidate array (already filtered + capped);
// renderOption(opt) -> inner HTML of one option row;
// onPick(opt) applies the pick (defaults to writing it into the input);
// renderEmpty(query) -> HTML for the no-match state.
export function customerComboboxInit() {
  const input = document.getElementById('pos-customer-name');
  if (!input) return;
  attachCombo(input, {
    getOptions: q => {
      const ql = q.toLowerCase();
      // Empty query still shows the top of the cache (server sorts by debt
      // first), so focusing the field answers "who owes?".
      const src = ql
        ? S.allCustomersCache.filter(c =>
          c.customer_name.toLowerCase().includes(ql) ||
          String(c.customer_phone || '').includes(ql))
        : S.allCustomersCache;
      return src.slice(0, COMBO_MAX);
    },
    renderOption: c => {
      const debt = c.total_credit_balance > 0.001;
      return `
        <span class="combo__name">${escHtml(c.customer_name)}</span>
        <span class="combo__phone">${escHtml(c.customer_phone || '')}</span>
        ${debt
        ? `<span class="tag tag--danger">${fmtMoney(Number(c.total_credit_balance))}</span>`
        : `<span class="tag tag--pos">Clean</span>`}`;
    },
    renderEmpty: q => (S.allCustomersCache.length === 0
      ? `<div class="combo__empty">No customers recorded yet — the first sale under a name creates one.</div>`
      : `<div class="combo__empty">No existing customer matches — “${escHtml(q)}” will be saved as new.</div>`),
    onPick: c => {
      input.value = c.customer_name;
      const phone = document.getElementById('pos-customer-phone');
      if (phone && !phone.value && c.customer_phone) phone.value = c.customer_phone;
      onCustomerNameInput(); // refresh the utang badge
    }
  });
}

// -------------------------------------------------------------
// POS CATALOG & CART
// -------------------------------------------------------------
export const isWholesaleTier = t => t === 'wholesale' || t === 'technician';

// Tier flip re-prices every line on the job sheet, so a mid-job accidental
// click asks first. `quiet` skips the guard when code restores a draft's tier.
export async function setPriceTier(tier, opts = {}) {
  if (S.saleInFlight) return; // sale in flight: the job on screen is the request payload
  const currentIsWholesale = isWholesaleTier(S.currentPriceTier);
  const targetIsWholesale = isWholesaleTier(tier);
  if (currentIsWholesale !== targetIsWholesale && S.cart.length > 0 && !opts.quiet) {
    const ok = await confirmModal(`${S.cart.length} line(s) on this job will switch to ${targetIsWholesale ? 'wholesale' : 'retail'} prices.`, { title: 'Re-price this job?', yes: 'Re-price', danger: false });
    if (!ok) return;
  }

  S.currentPriceTier = targetIsWholesale ? 'wholesale' : 'retail';
  syncTierButtons(S.currentPriceTier);

  // Recalculate unit_price for each line item in S.cart
  S.cart.forEach(item => {
    if (!item.is_labor) {
      item.unit_price = targetIsWholesale ? (item.price_wholesale ?? item.price_technician) : item.price_retail;
    }
  });

  renderCart();
  renderPartsTable();
}

// The brand select filters the parts table
export function setPosBrandFilter(brand) {
  S.posBrandFilter = brand;
  renderBrandChips();
  renderPartsTable();
}

export function setPartCategory(category) {
  S.posCategoryFilter = category;
  renderPartsTable();
}

export function setInStockOnly(on) {
  S.posInStockOnly = !!on;
  renderBrandChips();
  renderPartsTable();
}

// Used by the empty states so the counter can recover in one click.
export function resetPosFilters() {
  ['pos-search-input', 'repair-device-input', 'global-search'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  S.activeDevice = null;
  S.posCategoryFilter = '';
  S.posInStockOnly = false;

  const cat = document.getElementById('pos-category-filter');
  if (cat) cat.value = '';
  const stock = document.getElementById('pos-instock-only');
  if (stock) stock.checked = false;

  setPosBrandFilter('');
  onDeviceSelected('');
  renderPartsTable();
}

// -------------------------------------------------------------
// BARCODE SCANNING (USB HID keyboard wedge: rapid chars + Enter)
// -------------------------------------------------------------

// Hardware scanners type chars in a rapid burst (< ~100ms between keys) then Enter.
// initialized in state.js: S.scanBuffer
// initialized in state.js: S.lastScanKeyTime
const SCAN_BURST_MS = 100;
// Taking a burst away from a field the cashier may be typing into needs more
// evidence than an unfocused burst does. A real retail code is 8-13 characters;
// 6 is the floor, so short hand-typed input always survives.
const SCAN_FIELD_MIN = 6;
// Fields the caret is deliberately parked in to describe the phone in front of
// you, or to take money. A phone's own box carries its IMEI as a barcode, so
// scanning into these must stay text — looking a part up there is wrong, not
// helpful. The parts search is absent on purpose: it answers a scan its own way.
const SCAN_TEXT_FIELDS = new Set(['repair-device-input', 'repair-imei', 'repair-note', 'pos-tendered', 'pos-discount']);

// Web Audio Context for instant cashier audio feedback without external audio files
// initialized in state.js: S.audioCtx
let scanAudioWarned = false;
export function playScanSound(isSuccess = true) {
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    if (!S.audioCtx) S.audioCtx = new AudioContext();
    // A context suspended by autoplay policy stays silent until resume()
    // settles; the old unawaited call let that failure vanish (promise
    // rejections are not caught by the try block), so one scan losing its
    // beep had no trace anywhere.
    if (S.audioCtx.state === 'suspended') {
      S.audioCtx.resume().catch((err) => {
        if (scanAudioWarned) return;
        scanAudioWarned = true;
        console.warn(`[scan-sound] AudioContext resume failed: ${err && err.message ? err.message : err}`);
      });
    }

    const osc = S.audioCtx.createOscillator();
    const gain = S.audioCtx.createGain();
    osc.connect(gain);
    gain.connect(S.audioCtx.destination);

    if (isSuccess) {
      // Crisp high-pitch POS beep: 1760Hz (A6) for 70ms
      osc.type = 'sine';
      osc.frequency.setValueAtTime(1760, S.audioCtx.currentTime);
      gain.gain.setValueAtTime(0.12, S.audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, S.audioCtx.currentTime + 0.07);
      osc.start();
      osc.stop(S.audioCtx.currentTime + 0.07);
    } else {
      // Low warning buzz: 220Hz for 160ms
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(220, S.audioCtx.currentTime);
      gain.gain.setValueAtTime(0.18, S.audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, S.audioCtx.currentTime + 0.16);
      osc.start();
      osc.stop(S.audioCtx.currentTime + 0.16);
    }
  } catch (_) {}
}

export function handleBarcodeScan(scannedCode) {
  const code = (scannedCode || '').trim();
  if (!code) return false;

  // Strict exact match on sku_barcode (case-insensitive) — no fuzzy fallbacks
  const item = S.inventoryItems.find(it =>
    it.sku_barcode && it.sku_barcode.toLowerCase() === code.toLowerCase()
  );

  if (!item) {
    playScanSound(false);
    recordRefusedScan(code, 'pos.refuse_unknown');
    showToast(`Unknown barcode / SKU: "${code}"`, 'warning');
    return false;
  }

  if (item.stock_quantity <= 0) {
    playScanSound(false);
    recordRefusedScan(code, 'pos.refuse_out');
    showToast(`Cannot add "${item.brand} ${item.model_name}" — Out of stock!`, 'error');
    return false;
  }

  const currentQty = cartQtyFor(item.id);
  if (currentQty >= item.stock_quantity) {
    playScanSound(false);
    recordRefusedScan(code, 'pos.refuse_max');
    showToast(`Max stock reached for "${item.brand} ${item.model_name}" (${item.stock_quantity} available)`, 'warning');
    return false;
  }

  // setPartQty adds the line or increments quantity (also advances repairStep to 3 — intentional)
  setPartQty(item.id, 1);
  playScanSound(true);
  showToast(`Scanned: ${item.brand} ${item.model_name} (${item.part_type})`, 'success');

  const searchInput = document.getElementById('pos-search-input');
  if (searchInput && document.activeElement === searchInput) {
    searchInput.value = '';
    renderPartsTable();
  }
  return true;
}

// Refused scans the counter could not act on, kept for the shift: a cashier
// cannot read a toast at speed, so afterwards nobody could say why a scanned
// part never landed on the ticket. Last 50, tab-session lifetime.
const REFUSED_SCANS_KEY = 'pos_refused_scans';
const REFUSED_REASONS = {
  'pos.refuse_unknown': 'Unknown barcode / SKU',
  'pos.refuse_out': 'Out of stock',
  'pos.refuse_max': 'Max stock reached'
};
function recordRefusedScan(code, reasonKey) {
  try {
    const store = typeof sessionStorage === 'undefined' ? null : sessionStorage;
    if (!store) return;
    const list = JSON.parse(store.getItem(REFUSED_SCANS_KEY) || '[]');
    list.push({ code: String(code).slice(0, 64), reason: reasonKey, at: new Date().toISOString() });
    store.setItem(REFUSED_SCANS_KEY, JSON.stringify(list.slice(-50)));
    renderScanRefusalChip(list.length);
  } catch (_) {}
}
function refusedScanList() {
  try {
    const store = typeof sessionStorage === 'undefined' ? null : sessionStorage;
    return store ? JSON.parse(store.getItem(REFUSED_SCANS_KEY) || '[]') : [];
  } catch (_) { return []; }
}
export function clearRefusedScans() {
  try { sessionStorage.removeItem(REFUSED_SCANS_KEY); } catch (_) {}
  renderScanRefusalChip(0);
}
export function renderScanRefusalChip(count = refusedScanList().length) {
  const chip = document.getElementById('scan-refusals-chip');
  if (!chip) return;
  chip.classList.toggle('hidden', count <= 0);
  const label = chip.querySelector('span');
  if (label) label.textContent = t('pos.refused_scans', '{n} refused scans').replace('{n}', count);
}
export function openScanRefusals() {
  const list = refusedScanList();
  const box = document.getElementById('scan-refusals-list');
  if (box) {
    box.innerHTML = list.length === 0
      ? `<p class="empty__body">${escHtml(t('pos.refused_empty', 'No refused scans this session.'))}</p>`
      : list.slice().reverse().map(r => `<div class="flex justify-between gap-2 py-1 border-b border-[var(--line-soft)] last:border-0">
          <span class="font-mono text-xs">${escHtml(r.code)}</span>
          <span class="text-xs text-slate-400">${escHtml(t(r.reason, REFUSED_REASONS[r.reason] || r.reason))} · ${escHtml(String(r.at).slice(11, 19))}</span>
        </div>`).join('');
  }
  openModal('modal-scan-refusals');
}

let highlightedPartIndex = -1;

function updateHighlightedPartRow() {
  const tbody = document.getElementById('pos-parts-body');
  if (!tbody) return;
  const trs = tbody.querySelectorAll('tr');
  trs.forEach((tr, idx) => {
    const isSel = idx === highlightedPartIndex;
    tr.classList.toggle('is-highlighted', isSel);
    if (isSel) tr.scrollIntoView({ block: 'nearest' });
  });
}

// Focused search box: Enter adds top match or runs as barcode/SKU scan.
export function onPartSearchKeydown(e) {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const parts = getFilteredParts();
    if (!parts.length) return;
    const dir = e.key === 'ArrowDown' ? 1 : -1;
    highlightedPartIndex = Math.max(0, Math.min(parts.length - 1, highlightedPartIndex + dir));
    updateHighlightedPartRow();
    return;
  }

  if (e.key === 'Escape') {
    highlightedPartIndex = -1;
    updateHighlightedPartRow();
    e.target.blur();
    return;
  }

  if (e.key === 'Enter') {
    e.preventDefault();
    const query = (e.target.value || '').trim().toLowerCase();
    if (!query && highlightedPartIndex < 0) return;

    // A scanner burst in this box is a code, never a fuzzy search: left to the
    // typed path, digits that match nothing would add whatever they grazed.
    const burst = S.scanBuffer.trim();
    if (burst.toLowerCase() === query && burst.length >= SCAN_FIELD_MIN &&
        Date.now() - S.lastScanKeyTime <= SCAN_BURST_MS) {
      highlightedPartIndex = -1;
      // Same settle rule as the window handler: a CR mid-payload must not fire
      // on the partial code.
      scheduleScan(burst, null);
      return;
    }

    const catalog = S.posCatalog || S.inventoryItems;
    const exactBarcode = catalog.find(it => it.sku_barcode && it.sku_barcode.toLowerCase() === query);
    if (exactBarcode) {
      quickAddPart(exactBarcode.id);
      e.target.value = '';
      highlightedPartIndex = -1;
      renderPartsTable();
      return;
    }

    const parts = getFilteredParts();
    if (parts.length > 0) {
      const pickIdx = highlightedPartIndex >= 0 && highlightedPartIndex < parts.length ? highlightedPartIndex : 0;
      quickAddPart(parts[pickIdx].id);
      e.target.value = '';
      highlightedPartIndex = -1;
      renderPartsTable();
    } else {
      showToast('No matching part found in stock', 'warning');
    }
  }
}

// A CR can arrive in the middle of a scanner payload (a multi-line 2D symbol, or
// a reader programmed with CR as both separator and suffix), so an Enter no
// longer acts on the partial buffer the instant it arrives: the scan settles for
// one burst window first. A continuation character inside that window joins the
// same code; if nothing follows, the scan fires. The cost is ~100ms of beep
// latency per scan; the benefit is that a partial code is never looked up.
let pendingScan = null;      // { code, restore }
let pendingScanTimer = null;
function clearPendingScan() {
  if (pendingScanTimer) { clearTimeout(pendingScanTimer); pendingScanTimer = null; }
  pendingScan = null;
}
function flushPendingScan() {
  if (pendingScanTimer) { clearTimeout(pendingScanTimer); pendingScanTimer = null; }
  const scan = pendingScan;
  pendingScan = null;
  if (!scan) return;
  S.scanBuffer = '';
  // The keydown listener refuses to mutate the cart behind an overlay or off
  // the POS tab; the settle timer must honor the same gate, or a scan scheduled
  // just before a modal opens lands in the cart behind it.
  if (S.currentTab !== 'pos' || document.querySelector('.modal-backdrop:not(.hidden), .gate:not(.hidden)')) return;
  if (scan.restore) scan.restore();
  handleBarcodeScan(scan.code);
}
function scheduleScan(code, restore) {
  if (pendingScanTimer) clearTimeout(pendingScanTimer);
  pendingScan = { code, restore: restore || null };
  pendingScanTimer = setTimeout(flushPendingScan, SCAN_BURST_MS);
}

// Repair counter keystroke listeners: barcode bursts, IMEI-Enter, and the
// parts-search live filter. Called once from main.js DOMContentLoaded.
export function initScanListeners() {
  let burstStart = null; // what the focused field held before this burst began

  // A paste is a human editing the field, never part of a scan: dropping the
  // captured value means the hijack restore below can no longer wipe pasted
  // text (a paste into a field while a burst was in flight used to be lost
  // when the burst's Enter restored the pre-burst value).
  document.addEventListener('paste', () => { burstStart = null; }, true);

  window.addEventListener('keydown', (e) => {
    if (S.currentTab !== 'pos') return;

    // Don't mutate the S.cart behind an open overlay. Modals use
    // .modal-backdrop, but the login, license and PIN-setup gates use .gate
    // (public/index.html), and a burst during a gate must stay out of the cart
    // behind it too.
    if (document.querySelector('.modal-backdrop:not(.hidden), .gate:not(.hidden)')) return;

    const target = e.target;
    const inField = ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
    // The parts search answers Enter its own way (typed search and scan share
    // the box), so it keeps its keystrokes.
    const ownsEnter = inField && (target.id === 'pos-search-input' || SCAN_TEXT_FIELDS.has(target.id));

    const now = Date.now();
    if (now - S.lastScanKeyTime > SCAN_BURST_MS) {
      // Slow typing = human, reset burst, and a scan already in its settle
      // window belongs to a burst that is over.
      S.scanBuffer = ''; burstStart = null; clearPendingScan();
    }
    // Only printable keys and Enter refresh the burst clock: a stuck modifier
    // auto-repeating otherwise keeps a stale buffer alive past the slow-typing
    // reset and concatenates onto the next real scan.
    if (e.key === 'Enter' || e.key.length === 1) S.lastScanKeyTime = now;

    if (e.key === 'Enter') {
      const code = S.scanBuffer.trim();
      if (!ownsEnter && code.length >= (inField ? SCAN_FIELD_MIN : 2)) {
        e.preventDefault();
        scheduleScan(code, () => {
          // Put back whatever the field held: the characters were never meant as
          // text, and a code that turns out to be unknown must leave nothing behind.
          if (inField && burstStart && burstStart.el === target) target.value = burstStart.value;
        });
      } else if (inField) {
        // A human Enter in a field is not a scan. A pending scan's buffer has to
        // survive its own settle window instead: the search box schedules first
        // (element listener), then this window listener sees the same event.
        if (!pendingScan) S.scanBuffer = '';
      }
    } else if (e.key.length === 1) {
      // A character arriving inside the settle window is the same scan
      // continuing, so the scheduled scan is cancelled and the buffer keeps
      // growing; the next Enter scans the whole payload.
      clearPendingScan();
      // Every keystroke feeds the burst buffer, including the fields that keep
      // their own text — the parts search reads it to tell a scan from a search.
      if (inField && !ownsEnter && !burstStart) burstStart = { el: target, value: target.value };
      S.scanBuffer += e.key;
    }
  });

  // Repair intake: scanner into the IMEI field, Enter confirms and advances focus.
  document.getElementById('repair-imei')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const imeiVal = e.target.value.trim();
      if (imeiVal) {
        playScanSound(true);
        document.getElementById('repair-note')?.focus();
      }
    }
  });

}

export async function loadPosCatalog() {
  // A reload keeps the session's refusal list alive: restore the chip with it.
  renderScanRefusalChip();
  try {
    const res = await fetch('/api/inventory');
    if (!res.ok) throw new Error('Inventory unavailable');
    S.inventoryItems = await res.json();
    S.posCatalog = S.inventoryItems;
    S.catalogLoadFailed = false;
  } catch (err) {
    console.error('Failed to load inventory for the repair counter:', err);
    // Keep any last-good catalog on screen: an empty shelf reads as "no parts
    // exist", which is a lie when the server is merely unreachable.
    if ((S.posCatalog || S.inventoryItems || []).length > 0) {
      showToast('Catalog refresh failed — showing the last saved list', 'warning');
    } else {
      S.catalogLoadFailed = true;
      showToast('Could not load the parts catalog — check the server', 'error');
    }
  }

  populateDeviceDatalist();
  renderBrandOptions();
  renderPartTypeOptions();
  renderInvBrandFilter();
  renderCategoryOptions();
  renderRepairRef();
  renderSummaryDevice();
  renderPartsTable();
  renderCart();
}

export function renderRepairRef() {
  setCounterText('repair-ref', S.repairRefCode);
}

export async function copyRepairRef() {
  try {
    await navigator.clipboard.writeText(S.repairRefCode);
    showToast(`Copied ${S.repairRefCode}`, 'success');
  } catch (err) {
    showToast(`Job reference: ${S.repairRefCode}`, 'info');
  }
}

const BRAND_TONES = { Apple: '1', Samsung: '2', Xiaomi: '3', Realme: '4', Oppo: '5', Infinix: '2', Vivo: '3', Tecno: '4' };

export function brandTone(brand) {
  return BRAND_TONES[brand] || '1';
}

// "LCD (Incell)" and "LCD (OLED)" are the same aisle to a counter clerk.
export function categoryOf(item) {
  return String(item.category || item.part_type || 'Other').split('(')[0].trim() || 'Other';
}

export function categoryIcon(item) {
  const c = categoryOf(item).toLowerCase();
  if (c.includes('battery')) return 'battery-charging';
  if (c.includes('lcd') || c.includes('screen') || c.includes('display')) return 'device-mobile';
  if (c.includes('charging') || c.includes('flex')) return 'lightning';
  if (c.includes('camera')) return 'camera';
  if (c.includes('speaker') || c.includes('earpiece') || c.includes('audio')) return 'speaker-high';
  if (c.includes('board') || c.includes('ic') || c.includes('cpu') || c.includes('gpu') || c.includes('ram')) return 'cpu';
  if (c.includes('beverage') || c.includes('drink')) return 'cup';
  if (c.includes('food') || c.includes('snack') || c.includes('grocery') || c.includes('canned')) return 'basket';
  return 'package';
}

export function renderBrandOptions() {
  renderBrandChips();
}

// Brand chips on the parts shelf: one tap jumps between brands while selling.
export function renderBrandChips() {
  const box = document.getElementById('pos-brand-chips');
  if (!box) return;
  const mode = S.shopSettings?.business_type || 'hybrid';
  const catalog = S.posCatalog || S.inventoryItems;
  const profileItems = (mode !== 'hybrid')
    ? catalog.filter(i => itemMatchesProfile(i, mode))
    : catalog;
  const chipItems = S.posInStockOnly ? profileItems.filter(i => i.stock_quantity > 0) : profileItems;

  const catalogBrands = [...new Set(chipItems.map(i => (i.brand || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const templateBrands = (TEMPLATE_BRANDS?.[mode] || TEMPLATE_BRANDS?.retail || []).filter(b => b !== 'Other');
  const brands = catalogBrands.length > 0 ? catalogBrands : templateBrands;

  if (S.posBrandFilter && !brands.includes(S.posBrandFilter)) {
    S.posBrandFilter = '';
  }

  box.innerHTML = `<button type="button" class="brand-chip${S.posBrandFilter ? '' : ' is-active'}" data-action="pos-brand" data-brand="">All</button>` +
    brands.map(b => `<button type="button" class="brand-chip${S.posBrandFilter === b ? ' is-active' : ''}" data-action="pos-brand" data-brand="${escHtml(b)}">${escHtml(b)}</button>`).join('');
}

export function renderCategoryOptions() {
  const sel = document.getElementById('pos-category-filter');
  if (!sel) return;
  const mode = S.shopSettings?.business_type || 'hybrid';
  const catalog = S.posCatalog || S.inventoryItems;
  const profileItems = (mode !== 'hybrid')
    ? catalog.filter(i => itemMatchesProfile(i, mode))
    : catalog;

  const catalogCats = [...new Set(profileItems.map(item => categoryOf(item)).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const templateCats = (TEMPLATE_CATEGORIES?.[mode] || TEMPLATE_CATEGORIES?.retail || []).filter(c => c !== 'Other');
  const cats = catalogCats.length > 0 ? catalogCats : templateCats;

  sel.innerHTML = `<option value="">All categories</option>` +
    cats.map(c => `<option value="${escHtml(c)}">${escHtml(c)}</option>`).join('');
  sel.value = cats.includes(S.posCategoryFilter) ? S.posCategoryFilter : '';
  S.posCategoryFilter = sel.value;
}

// -------------------------------------------------------------
// REPAIR COUNTER — DEVICE AUTOCOMPLETE & INTAKE
// -------------------------------------------------------------
export function populateDeviceDatalist() {
  const datalist = document.getElementById('device-datalist');
  const catalog = S.posCatalog || S.inventoryItems;
  if (!datalist || !catalog) return;
  const models = [...new Set(catalog.map(p => `${p.brand} ${p.model_name}`).filter(Boolean))].sort();
  datalist.innerHTML = models.map(m => `<option value="${escHtml(m)}"></option>`).join('');
}

export function onDeviceSelected(val) {
  S.activeDevice = (val || '').trim();
  const sumName = document.getElementById('sum-device-name');
  const sumMeta = document.getElementById('sum-device-meta');
  const shelfTitle = document.getElementById('shelf-title');
  const shelfHint = document.getElementById('shelf-hint');

  if (S.activeDevice) {
    if (sumName) sumName.textContent = S.activeDevice;
    if (sumMeta) sumMeta.textContent = 'Active handset on bench';
    if (shelfTitle) shelfTitle.textContent = `${S.activeDevice} Parts`;
    if (shelfHint) shelfHint.textContent = 'Compatible in-stock parts for this handset.';
  } else {
    if (sumName) sumName.textContent = 'No device chosen';
    if (sumMeta) sumMeta.textContent = 'Universal / all parts shown.';
    if (shelfTitle) shelfTitle.textContent = t('pos.shelf_title', 'All Available Parts');
    if (shelfHint) shelfHint.textContent = t('pos.shelf_hint', 'Showing all active parts in inventory.');
  }
  renderPartsTable();
}

export function clearDeviceSelection() {
  const input = document.getElementById('repair-device-input');
  if (input) input.value = '';
  onDeviceSelected('');
}

export function deviceLabel() {
  if (!S.activeDevice) return '';
  if (typeof S.activeDevice === 'string') return S.activeDevice;
  return `${S.activeDevice.brand || ''} ${S.activeDevice.model_name || ''}`.trim();
}

export function focusImeiForScan() {
  const el = document.getElementById('repair-imei');
  if (!el) return;
  el.focus();
  el.select();
  showToast('Scan now — the reader types straight into this field', 'info');
}

export function onRepairIntakeInput() {
  renderSummaryDevice();
}

export function toggleRepairNote() {
  const wrap = document.getElementById('repair-note-wrap');
  const label = document.getElementById('note-toggle-label');
  if (!wrap) return;

  const showing = !wrap.classList.toggle('hidden');
  const hasNote = !!document.getElementById('repair-note')?.value.trim();
  if (label) label.textContent = showing ? 'Hide note' : (hasNote ? 'Edit note' : 'Add note');
  if (showing) document.getElementById('repair-note')?.focus();
}

export function renderSummaryDevice() {
  const label = deviceLabel();
  const imei = document.getElementById('repair-imei')?.value.trim() || '';
  const note = document.getElementById('repair-note')?.value.trim() || '';

  setCounterText('sum-device-name', label || (S.activeDevice ? 'Unnamed device' : 'No device chosen'));
  setCounterText('sum-device-meta', S.activeDevice
    ? [imei ? `IMEI ${imei}` : 'No IMEI / serial', note ? `Note: ${note}` : ''].filter(Boolean).join(' · ')
    : 'Pick a unit above, or enter one by hand.');

  const label2 = document.getElementById('note-toggle-label');
  const wrap = document.getElementById('repair-note-wrap');
  if (label2 && wrap && wrap.classList.contains('hidden')) {
    label2.textContent = note ? 'Edit note' : 'Add note';
  }
}

// The sales schema has no column for the unit, its IMEI or the job note, so they
// travel as a single ₱0 labour line. renderReceipt() lifts it back out to print.
export const DEVICE_LINE_PREFIX = 'DEVICE · ';

export function deviceNoteLine() {
  // The job reference travels first so the RO code on the customer's paper
  // tag is findable in Sales history (the search covers item names).
  const bits = [S.repairRefCode];
  const label = deviceLabel();
  if (label) bits.push(label);

  const imei = document.getElementById('repair-imei')?.value.trim();
  if (imei) bits.push(`IMEI ${imei}`);

  const note = document.getElementById('repair-note')?.value.trim();
  if (note) bits.push(note);

  return bits.length ? DEVICE_LINE_PREFIX + bits.join(' · ') : '';
}

// -------------------------------------------------------------
// LIVE PARTS SHELF & QUICK ADD
// -------------------------------------------------------------
const roundQty = q => Math.round((Number(q) || 0) * 1000) / 1000;

export function getFilteredParts() {
  const catalog = S.posCatalog || S.inventoryItems;
  const mode = S.shopSettings?.business_type || 'hybrid';

  const q = (document.getElementById('pos-search-input')?.value || '').trim().toLowerCase();
  const devStr = typeof S.activeDevice === 'string' ? S.activeDevice.toLowerCase() : (deviceLabel().toLowerCase());
  const devTokens = devStr ? devStr.split(/\s+/).filter(Boolean) : [];

  return catalog.filter(item => {
    if (mode !== 'hybrid' && typeof itemMatchesProfile === 'function' && !itemMatchesProfile(item, mode)) return false;
    if (devTokens.length > 0) {
      const itemDev = `${item.brand || ''} ${item.model_name || ''}`.toLowerCase();
      const matches = itemDev.includes(devStr) || devStr.includes(itemDev) || devTokens.every(token => itemDev.includes(token));
      if (!matches) return false;
    }
    if (S.posBrandFilter && item.brand !== S.posBrandFilter) return false;
    if (S.posCategoryFilter && categoryOf(item) !== S.posCategoryFilter) return false;
    if (S.posInStockOnly && item.stock_quantity <= 0) return false;
    if (!q) return true;
    return `${item.item_name || ''} ${item.brand} ${item.model_name} ${item.part_type} ${item.category || ''} ${item.sku_barcode || ''}`.toLowerCase().includes(q);
  });
}

export function cartQtyFor(itemId) {
  const line = S.cart.find(c => !c.is_labor && c.id === itemId);
  return line ? line.qty : 0;
}

export function renderPartsTable() {
  const body = document.getElementById('pos-parts-body');
  if (!body) return;

  const rows = getFilteredParts();
  const catalog = S.posCatalog || S.inventoryItems;
  const partLines = S.cart.filter(c => !c.is_labor).length;

  const mode = S.shopSettings?.business_type || 'hybrid';
  const profileCatalog = (mode !== 'hybrid')
    ? catalog.filter(i => itemMatchesProfile(i, mode))
    : catalog;

  // Failed load with nothing to fall back on: say so and offer a retry —
  // this must never wear the "no parts in inventory yet" empty state.
  if (S.catalogLoadFailed && catalog.length === 0) {
    body.innerHTML = `
      <tr>
        <td colspan="5">
          <div class="empty">
            <div class="empty__icon"><i class="ph ph-wifi-slash w-5 h-5"></i></div>
            <div class="empty__title">Couldn't load the parts catalog</div>
            <p class="empty__body">The server didn't answer. Retry, or check that the POS server is running.</p>
            <button type="button" class="chip" data-action="reload-catalog">Retry</button>
          </div>
        </td>
      </tr>`;
    return;
  }

  if (profileCatalog.length === 0) {
    body.innerHTML = `
      <tr>
        <td colspan="5">
          <div class="empty">
            <div class="empty__icon"><i class="ph ph-package w-5 h-5"></i></div>
            <div class="empty__title">${escHtml(t('pos.empty_catalog_title', 'No items in catalog yet'))}</div>
            <p class="empty__body">${escHtml(t('pos.empty_catalog', 'Add your first item, or import your catalog from Settings > Data.'))}</p>
            <button type="button" class="chip" data-action="open-add-part" data-manager-only>+ ${escHtml(t('inv.add_part', 'Add Item'))}</button>
          </div>
        </td>
      </tr>`;
  } else if (rows.length === 0) {
    const q = (document.getElementById('pos-search-input')?.value || '').trim();
    const active = [];
    if (deviceLabel()) active.push('device');
    if (S.posBrandFilter) active.push('brand');
    if (S.posCategoryFilter) active.push('category');
    if (q) active.push('search');
    if (S.posInStockOnly) active.push('in-stock');
    const countUnit = t('inv.parts_count', 'items');
    const why = active.length
      ? t('pos.filter_why_filters', 'Nothing matches the {filters} filter. Reset them, or add the item to inventory.').replace('{filters}', active.join(', '))
      : t('pos.filter_why_plain', 'Nothing matches yet. Add the item to inventory.');
    const isOnlyInStock = active.length === 1 && S.posInStockOnly;
    const resetText = (isOnlyInStock && catalog.length > 0)
      ? t('pos.reset_show_all', 'Show all {n} items').replace('{n}', catalog.length)
      : t('pos.reset_filters', 'Reset filters');
    body.innerHTML = `
      <tr>
        <td colspan="5">
          <div class="empty">
            <div class="empty__icon"><i class="ph ph-package w-5 h-5"></i></div>
            <div class="empty__title">${escHtml(t('pos.filter_empty', 'No items match these filters'))}</div>
            <p class="empty__body">${why}</p>
            <div class="flex gap-2">
              <button type="button" class="chip" data-action="reset-pos-filters">${resetText}</button>
              <button type="button" class="chip" data-action="open-add-part" data-manager-only>+ ${escHtml(t('inv.add_part', 'Add item'))}</button>
            </div>
          </div>
        </td>
      </tr>`;
  } else {
    body.innerHTML = rows.map(item => {
      const price = Number(isWholesaleTier(S.currentPriceTier) ? (item.price_wholesale ?? item.price_technician) : item.price_retail);
      const out = item.stock_quantity <= 0;
      const low = !out && item.stock_quantity <= item.min_stock_alert;
      const titleText = item.item_name || `${item.brand} ${item.model_name}`;
      const subText = item.item_name ? (item.category || item.part_type || '') : item.part_type;

      return `
        <tr class="${out ? 'is-out' : ''}">
          <td>
            <div class="pname">
              <span class="pname__icon"><i class="ph ph-${categoryIcon(item)} w-4 h-4"></i></span>
              <div>
                <div class="pname__t">${escHtml(titleText)}</div>
                <div class="pname__s">${escHtml(subText)}${item.sku_barcode ? ` · ${escHtml(item.sku_barcode)}` : ''}</div>
              </div>
            </div>
          </td>
          <td><span class="tag">${escHtml(categoryOf(item))}</span></td>
          <td class="is-num money">${fmtMoney(price)}</td>
          <td class="is-mid"><span class="stock${out ? ' stock--out' : (low ? ' stock--low' : '')}">${out ? 'Out' : item.stock_quantity}</span></td>
          <td class="is-mid">
            <button type="button" class="btn-add-part" data-action="quick-add-part" data-part-id="${item.id}" ${out ? 'disabled' : ''}>+ Add</button>
          </td>
        </tr>`;
    }).join('');
  }

  const countUnit = t('inv.parts_count', 'items');
  setCounterText('parts-count-note', profileCatalog.length === 0
    ? `No ${countUnit} in inventory yet`
    : `${rows.length} of ${profileCatalog.length} ${countUnit} shown · ${partLines} in ticket`);

  if (highlightedPartIndex >= rows.length) highlightedPartIndex = -1;
  updateHighlightedPartRow();
}

export function quickAddPart(partId) {
  if (S.saleInFlight) return; // sale in flight: the job on screen is the request payload
  const catalog = S.posCatalog || S.inventoryItems;
  const part = catalog.find(p => p.id === partId);
  if (!part) return;
  if (part.stock_quantity <= 0) {
    showToast(t('pos.out_of_stock', '{name} is out of stock').replace('{name}', `${part.item_name || [part.brand, part.model_name, part.part_type].filter(Boolean).join(' ')}`), 'warning');
    return;
  }
  const maxStock = Number(part.stock_quantity) || 0;
  const existing = S.cart.find(c => !c.is_labor && c.id === part.id);
  if (existing) {
    if (existing.qty >= maxStock - 1e-6) {
      showToast(t('pos.add_over_stock', 'Cannot add more than available stock ({n})').replace('{n}', part.stock_quantity), 'warning');
      return;
    }
    existing.qty = part.allow_fractional && existing.qty + 1 > maxStock
      ? roundQty(maxStock)
      : roundQty(existing.qty + 1);
  } else {
    const initQty = (part.allow_fractional && maxStock < 1) ? roundQty(maxStock) : 1;
    S.cart.push({
      id: part.id,
      sku: part.sku_barcode,
      brand: part.brand,
      model_name: part.model_name,
      part_type: part.part_type,
      item_name: part.item_name || null,
      name: part.item_name || `${part.brand} ${part.model_name} ${part.part_type}`.trim(),
      price_retail: part.price_retail,
      price_technician: part.price_technician,
      price_wholesale: part.price_wholesale ?? part.price_technician,
      unit_price: isWholesaleTier(S.currentPriceTier) ? (part.price_wholesale ?? part.price_technician) : part.price_retail,
      qty: initQty,
      stock: part.stock_quantity,
      allow_fractional: Boolean(part.allow_fractional),
      uom: part.uom || 'pcs',
      is_labor: false
    });
  }
  renderCart();
  renderPartsTable();
  showToast(t('pos.added', 'Added {name}').replace('{name}', part.item_name || part.part_type), 'success');
}

export function setPartQty(itemId, delta) {
  const index = S.cart.findIndex(c => !c.is_labor && c.id === itemId);
  if (index === -1) {
    if (delta > 0) {
      quickAddPart(itemId);
    }
    return;
  }
  updateCartQty(index, delta);
}

export async function clearRepairOrder() {
  if (S.saleInFlight) return; // sale in flight: the job on screen is the request payload
  if (S.cart.length > 0 && !await confirmModal('Clear this repair order?', { yes: 'Clear' })) return;
  resetRepairCounter();
  showToast('Repair order cleared', 'info');
}

// Held jobs live on this machine only — the shop is offline-first and a draft is
// not a sale, so it never touches the database.
const REPAIR_DRAFT_KEY = 'techparts_repair_draft';

export function readRepairDraft() {
  try {
    return JSON.parse(localStorage.getItem(REPAIR_DRAFT_KEY) || 'null');
  } catch (err) {
    return null;
  }
}

export async function saveRepairDraft() {
  if (S.saleInFlight) return; // sale in flight: the job on screen is the request payload
  if (S.cart.length === 0) {
    showToast('Nothing to hold yet — add a part to the order', 'warning');
    return;
  }

  // One held job per machine: warn before silently destroying the previous one.
  const existing = readRepairDraft();
  if (existing && existing.ref !== S.repairRefCode) {
    const ok = await confirmModal(`Only one job can be held at a time — holding this one replaces ${existing.ref}.`, { title: `Replace the held job ${existing.ref}?`, yes: 'Replace held job' });
    if (!ok) return;
  }

  const draft = {
    ref: S.repairRefCode,
    saleOpId: S.saleOpId,
    cart: S.cart,
    device: S.activeDevice,
    deviceInput: document.getElementById('repair-device-input')?.value || '',
    imei: document.getElementById('repair-imei')?.value || '',
    note: document.getElementById('repair-note')?.value || '',
    customer: document.getElementById('pos-customer-name')?.value || '',
    phone: document.getElementById('pos-customer-phone')?.value || '',
    discount: document.getElementById('pos-discount')?.value || 0,
    tier: S.currentPriceTier,
    held_at: new Date().toISOString()
  };

  try {
    localStorage.setItem(REPAIR_DRAFT_KEY, JSON.stringify(draft));
  } catch (err) {
    showToast('This machine would not store the held job', 'error');
    return;
  }

  // The held job becomes a server-side ticket keyed by its reference, so the
  // queue sees the intake even before the unit is billed. Best effort: the
  // local hold still stands if the server is unreachable, and ringing the
  // sale upserts the same reference again.
  if (draft.deviceInput || draft.imei || draft.note) {
    try {
      const res = await fetch('/api/repairs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ref: draft.ref,
          customer_name: draft.customer || 'Walk-in Customer',
          customer_phone: draft.phone,
          device: draft.deviceInput,
          imei: draft.imei,
          issue_note: draft.note,
          status: 'intake'
        })
      });
      if (!res.ok) throw new Error('ticket save failed');
    } catch (_) {
      showToast('Job held locally, but the repair ticket did not reach the server. It will attach when the sale is rung up.', 'warning');
    }
  }

  const ref = draft.ref;
  resetRepairCounter({ clearSaleOp: false });
  refreshDraftChip();
  showToast(`${ref} held — resume it from the chip above`, 'success');
}

export async function resumeRepairDraft() {
  if (S.saleInFlight) return; // sale in flight: the job on screen is the request payload
  const draft = readRepairDraft();
  if (!draft) {
    refreshDraftChip();
    showToast('No held job to resume', 'warning');
    return;
  }
  if (S.cart.length > 0 && !(await confirmModal('Replace the repair on screen with the held job?', { yes: 'Replace' }))) return;

  resetRepairCounter({ clearSaleOp: false });

  S.cart = Array.isArray(draft.cart) ? draft.cart : [];
  S.saleOpId = draft.saleOpId || S.saleOpId;
  if (S.saleOpId) {
    try { localStorage.setItem(SALE_OP_KEY, S.saleOpId); } catch (_) {}
  }
  S.repairRefCode = draft.ref || S.repairRefCode;
  S.activeDevice = draft.device || null;

  const deviceInput = document.getElementById('repair-device-input');
  if (deviceInput) {
    deviceInput.value = draft.deviceInput || (typeof S.activeDevice === 'string' ? S.activeDevice : (deviceLabel() || ''));
  }
  if (S.activeDevice) {
    onDeviceSelected(typeof S.activeDevice === 'string' ? S.activeDevice : (deviceLabel() || ''));
  }

  const fields = {
    'repair-imei': draft.imei || '',
    'repair-note': draft.note || '',
    'pos-customer-name': draft.customer || '',
    'pos-customer-phone': draft.phone || '',
    'pos-discount': draft.discount || 0
  };
  Object.entries(fields).forEach(([id, v]) => {
    const el = document.getElementById(id);
    if (el) el.value = v;
  });

  if (draft.note) {
    document.getElementById('repair-note-wrap')?.classList.remove('hidden');
    setCounterText('note-toggle-label', 'Hide note');
  }

  localStorage.removeItem(REPAIR_DRAFT_KEY);
  refreshDraftChip();

  setPriceTier(isWholesaleTier(draft.tier) ? 'wholesale' : 'retail', { quiet: true });
  onCustomerNameInput();
  renderRepairRef();
  renderSummaryDevice();
  renderCart();
  renderPartsTable();
  showToast(`${S.repairRefCode} resumed`, 'success');
}

export function refreshDraftChip() {
  const chip = document.getElementById('draft-chip');
  if (!chip) return;

  const draft = readRepairDraft();
  chip.classList.toggle('hidden', !draft);
  if (!draft) return;

  const lines = Array.isArray(draft.cart) ? draft.cart.length : 0;
  const label = chip.querySelector('span');
  if (label) label.textContent = `Resume ${draft.ref || 'held job'} · ${lines} line${lines === 1 ? '' : 's'}`;
}

// Single place that puts the counter back to a blank job sheet.
export function resetRepairCounter({ clearSaleOp = true } = {}) {
  S.cart = [];
  if (clearSaleOp) {
    S.saleOpId = null;
    try { localStorage.removeItem(SALE_OP_KEY); } catch (_) {}
  }
  S.activeDevice = null;
  S.posCategoryFilter = '';
  S.posInStockOnly = true;
  // The tier is per-job pricing state, not counter state: without this reset
  // a technician-tier job leaks wholesale prices into the next customer.
  // Direct assignment, not setPriceTier(): its sale-in-flight guard would
  // swallow the call mid-checkout.
  S.currentPriceTier = 'retail';
  syncTierButtons('retail');
  S.repairRefCode = newRepairRef();

  const blanks = {
    'repair-device-input': '',
    'repair-imei': '',
    'repair-note': '',
    'pos-customer-name': '',
    'pos-customer-phone': '',
    'pos-discount': 0,
    'pos-tendered': '',
    'pos-gcash-ref': '',
    'pos-transfer-ref': '',
    'pos-credit-downpayment': 0,
    'pos-search-input': '',
    'pos-category-filter': ''
  };
  Object.entries(blanks).forEach(([id, v]) => {
    const el = document.getElementById(id);
    if (el) el.value = v;
  });

  const inStock = document.getElementById('pos-instock-only');
  if (inStock) inStock.checked = true;

  document.getElementById('pos-cust-status-badge')?.classList.add('hidden');
  document.getElementById('repair-note-wrap')?.classList.add('hidden');
  setCounterText('note-toggle-label', 'Add note');

  setPaymentMethod('cash');
  renderRepairRef();
  renderSummaryDevice();
  renderCart();
  renderPartsTable();
}

export function updateCartQty(index, delta) {
  if (S.saleInFlight) return; // sale in flight: the job on screen is the request payload
  if (!S.cart[index]) return;
  const item = S.cart[index];

  if (item.is_labor) {
    item.qty += delta;
    if (item.qty <= 0) S.cart.splice(index, 1);
  } else {
    const catalog = S.posCatalog || S.inventoryItems;
    const inv = catalog.find(i => i.id === item.id);
    const maxStock = inv ? Number(inv.stock_quantity) : Number(item.stock);
    const allowFrac = Boolean(item.allow_fractional) || Boolean(inv?.allow_fractional);
    if (delta > 0 && Number.isFinite(maxStock)) {
      if (item.qty >= maxStock - 1e-6) {
        showToast(t('pos.stock_ceiling', 'Only {n} available in stock').replace('{n}', maxStock), 'warning');
        return;
      }
      const next = roundQty(item.qty + delta);
      item.qty = (allowFrac && next > maxStock) ? roundQty(maxStock) : next;
    } else {
      item.qty = allowFrac ? roundQty(item.qty + delta) : Math.round(item.qty + delta);
    }
    if (item.qty <= 0) S.cart.splice(index, 1);
  }

  renderCart();
  renderPartsTable();
}

export async function editCartQtyPrompt(index) {
  if (S.saleInFlight) return; // sale in flight: the job on screen is the request payload
  const item = S.cart[index];
  if (!item) return;
  const catalog = S.posCatalog || S.inventoryItems;
  const inv = !item.is_labor ? catalog.find(i => i.id === item.id) : null;
  const allowFrac = !item.is_labor && (Boolean(item.allow_fractional) || Boolean(inv?.allow_fractional));
  const label = item.is_labor ? item.name : (item.item_name || `${item.brand} ${item.model_name} ${item.part_type}`);
  const v = await inputModal(`Quantity for ${label}`, {
    inputType: 'number',
    step: allowFrac ? 'any' : '1',
    placeholder: allowFrac ? '0.5' : '1',
    defaultValue: String(item.qty),
    yes: 'Set quantity'
  });
  if (v === null) return;
  const trimmed = String(v).trim();
  const rawQty = Number(trimmed);
  const qty = allowFrac ? roundQty(rawQty) : rawQty;
  if (trimmed === '' || !Number.isFinite(rawQty) || rawQty < 0 || (!allowFrac && !Number.isInteger(rawQty))) {
    showToast(allowFrac ? t('pos.qty_valid_number', 'Quantity must be a valid number (0 to remove)') : t('pos.qty_whole_number', 'Quantity must be a whole number (0 to remove)'), 'error');
    return;
  }
  if (allowFrac && rawQty > 0 && qty === 0) {
    showToast(t('pos.qty_min', 'Quantity must be at least 0.001 (0 to remove)'), 'error');
    return;
  }
  if (qty === 0) {
    removeCartItem(index);
    return;
  }
  if (!item.is_labor) {
    const maxStock = inv ? Number(inv.stock_quantity) : Number(item.stock);
    if (Number.isFinite(maxStock) && qty > maxStock + 1e-6) {
      showToast(`Only ${maxStock} available in stock`, 'warning');
      return;
    }
    item.qty = Number.isFinite(maxStock) && qty > maxStock ? roundQty(maxStock) : qty;
  } else {
    item.qty = qty;
  }
  renderCart();
  renderPartsTable();
}

export function removeCartItem(index) {
  if (S.saleInFlight) return; // sale in flight: the job on screen is the request payload
  S.cart.splice(index, 1);
  renderCart();
  renderPartsTable();
}

// The running job sheet on the right: line items and totals
export function renderOrderLines() {
  const services = [];
  const parts = [];
  S.cart.forEach((item, index) => (item.is_labor ? services : parts).push({ item, index }));

  const lineHtml = ({ item, index }) => {
    const unit = unitPriceOf(item);
    const title = item.is_labor ? item.name : (item.item_name || `${item.brand} ${item.model_name}`);
    const sub = item.is_labor ? '' : (item.item_name ? (item.category || '') : item.part_type);
    // Round the unit*qty product to cents like cartTotals() and the claim stub,
    // so a fractional line shows the centavo the register actually charges.
    const lineCents = toCents(unit * (Number(item.qty) || 0));

    return `
      <div class="sumline">
        <span class="sumline__t">${escHtml(title)}${sub ? ` <span class="sumline__q">${escHtml(sub)}</span>` : ''}${item.qty !== 1 ? ` <span class="sumline__q">×${item.qty} @ ${fmtMoney(Number(unit))}</span>` : ''}</span>
        <button type="button" class="sumline__qty" data-action="edit-line-qty" data-index="${index}" title="Set quantity" aria-label="Quantity ${item.qty} for ${escHtml(title)}">×${item.qty}</button>
        <span class="sumline__a">${fmtMoney(lineCents / 100)}</span>
        <button type="button" class="sumline__x" data-action="remove-line" data-index="${index}" title="Remove" aria-label="Remove ${escHtml(title)}">
          <i class="ph ph-x w-3 h-3"></i>
        </button>
      </div>`;
  };

  const svcBox = document.getElementById('sum-services');
  const partBox = document.getElementById('sum-parts');
  if (svcBox) {
    svcBox.innerHTML = services.length
      ? services.map(lineHtml).join('')
      : '';
    const svcGroup = svcBox.closest('.sumgroup');
    if (svcGroup) svcGroup.style.display = services.length > 0 ? '' : 'none';
  }
  if (partBox) {
    partBox.innerHTML = parts.length
      ? parts.map(lineHtml).join('')
      : `<p class="sum-empty">${escHtml(t('pos.cart_empty_hint', 'No items in this order. Click + Add on the shelf.'))}</p>`;
  }

  let svcCents = 0, partCents = 0;
  for (const l of services) svcCents += Math.round(toCents(unitPriceOf(l.item)) * (Number(l.item.qty) || 0));
  for (const l of parts) partCents += Math.round(toCents(unitPriceOf(l.item)) * (Number(l.item.qty) || 0));
  const svcTotal = svcCents / 100;
  const partTotal = partCents / 100;
  setCounterText('sum-services-count', `(${services.length})`);
  setCounterText('sum-services-total', `${fmtMoney(svcTotal)}`);
  setCounterText('sum-parts-count', `(${parts.length})`);
  setCounterText('sum-parts-total', `${fmtMoney(partTotal)}`);
}

// Kept as renderCart() because the rest of the app already calls it after every
// change to the order.
export function renderCart() {
  repriceCartLines();
  renderOrderLines();
  renderCartSummary();
}

// The server re-prices parts from the live catalog row, so a snapshot price on
// screen can be one the register will not charge.
function repriceCartLines() {
  const catalog = S.posCatalog || [];
  if (!catalog.length) return;
  const byId = new Map(catalog.map(i => [i.id, i]));
  for (const line of S.cart) {
    if (line.is_labor) continue;
    const inv = byId.get(line.id);
    // A part gone from the catalog keeps its snapshot; the server refuses the
    // sale with its own clear error.
    if (!inv) continue;
    line.price_retail = Number(inv.price_retail) || 0;
    line.price_technician = Number(inv.price_technician) || 0;
    // unitPriceOf prefers price_wholesale; leaving it frozen at add time quoted
    // a stale wholesale price the register would not charge.
    line.price_wholesale = Number(inv.price_wholesale ?? inv.price_technician) || 0;
    line.stock = inv.stock_quantity;
    line.item_name = inv.item_name || null;
    line.allow_fractional = Boolean(inv.allow_fractional);
    line.uom = inv.uom || 'pcs';
  }
}

function syncTierButtons(tier) {
  const retailBtn = document.getElementById('tier-retail-btn');
  const wholesaleBtn = document.getElementById('tier-wholesale-btn');
  const wholesaleActive = tier === 'wholesale' || tier === 'technician';
  if (retailBtn) {
    retailBtn.classList.toggle('is-active', !wholesaleActive);
    retailBtn.setAttribute('aria-pressed', !wholesaleActive ? 'true' : 'false');
  }
  if (wholesaleBtn) {
    wholesaleBtn.classList.toggle('is-active', wholesaleActive);
    wholesaleBtn.setAttribute('aria-pressed', wholesaleActive ? 'true' : 'false');
  }
}

export function unitPriceOf(item) {
  if (item.is_labor) return item.unit_price;
  const isWholesale = S.currentPriceTier === 'wholesale' || S.currentPriceTier === 'technician';
  return isWholesale ? (item.price_wholesale ?? item.price_technician) : item.price_retail;
}

// Integer centavos, rounded the way src/money.js rounds: Math.round(v * 100)
// is a cent low on decimal halves like 1.005, which a typed discount carries.
const toCents = v => {
  const value = Number(v) || 0;
  const [coefficient, exponent = '0'] = String(Math.abs(value)).split('e');
  return Math.sign(value) * Math.round(Number(`${coefficient}e${Number(exponent) + 2}`));
};

export function cartTotals() {
  let subtotalCents = 0;
  // Round the unit*qty PRODUCT to cents, exactly like src/money.js does on the
  // server. Math.round(toCents(unit) * qty) rounds a binary float product and
  // lands a centavo off on decimal halves (0.25 x 0.58), so the register and
  // the displayed total disagreed and cash sales were refused as underpaid.
  for (const item of S.cart) subtotalCents += toCents(unitPriceOf(item) * (Number(item.qty) || 0));
  const discountCents = Math.min(subtotalCents, Math.max(0, toCents(document.getElementById('pos-discount')?.value || 0)));
  return {
    subtotal: subtotalCents / 100,
    discount: discountCents / 100,
    total: (subtotalCents - discountCents) / 100
  };
}

export function renderCartSummary() {
  const { subtotal, total } = cartTotals();

  // Crash recovery: every cart change re-renders here, so this one write
  // keeps the on-disk snapshot current without touching each call site.
  try { localStorage.setItem('pos_cart_recovery', serializeCartForRecovery(S.cart)); } catch (_) {}

  const subtotalEl = document.getElementById('pos-subtotal');
  const totalEl = document.getElementById('pos-total');
  const gcashBadge = document.getElementById('pos-gcash-amount-badge');

  if (subtotalEl) subtotalEl.textContent = `${fmtMoney(subtotal)}`;
  if (totalEl) totalEl.textContent = `${fmtMoney(total)}`;
  if (gcashBadge) gcashBadge.textContent = `${fmtMoney(total)}`;

  const checkoutBtn = document.querySelector('[data-action="complete-sale"]');
  if (checkoutBtn) {
    const isReady = total > 0;
    checkoutBtn.classList.toggle('is-ready', isReady);
    const labelSpan = checkoutBtn.querySelector('span');
    if (labelSpan) {
      labelSpan.textContent = isReady ? t('pos.checkout_ready', 'Take payment & print (F9)') : t('pos.checkout_idle', 'Add items to checkout (F9)');
    }
  }

  if (S.currentPaymentMethod === 'cash') calculateChange();
  if (S.currentPaymentMethod === 'credit') calculateCreditBalance();
}

// Boot-time restore of a cart persisted by renderCartSummary — a crashed or
// closed tab should not cost the cashier a half-built job.
export function restoreCartRecovery() {
  try {
    const cart = deserializeCartForRecovery(localStorage.getItem('pos_cart_recovery') || '');
    if (cart.length && S.cart.length === 0) {
      S.cart = cart;
      renderCart();
      showToast(`Recovered ${cart.length} unsaved cart line${cart.length === 1 ? '' : 's'}`, 'info');
    }
  } catch (_) {}
}

export function setPaymentMethod(method) {
  if (S.saleInFlight) return; // sale in flight: the method was captured with the request
  S.currentPaymentMethod = method;

  ['cash', 'gcash', 'credit', 'transfer'].forEach(m => {
    const btn = document.getElementById(`pay-${m}-btn`);
    const panel = document.getElementById(`payment-panel-${m}`);
    if (btn) {
      btn.classList.toggle('is-active', m === method);
      btn.setAttribute('aria-pressed', m === method ? 'true' : 'false');
    }
    if (panel) panel.classList.toggle('hidden', m !== method);
  });

  if (method === 'cash') calculateChange();
  if (method === 'credit') calculateCreditBalance();
}

export function fillExactAmount() {
  const tenderedEl = document.getElementById('pos-tendered');
  if (tenderedEl) {
    tenderedEl.value = cartTotals().total.toFixed(2);
    calculateChange();
  }
}

export function calculateChange() {
  const tendered = Number(document.getElementById('pos-tendered')?.value || 0);
  const change = Math.max(0, toCents(tendered) - toCents(cartTotals().total)) / 100;

  const changeEl = document.getElementById('pos-change');
  if (changeEl) {
    changeEl.textContent = `${fmtMoney(change)}`;
    changeEl.classList.toggle('is-positive', change > 0);
  }
}

export function calculateCreditBalance() {
  const downpayment = Number(document.getElementById('pos-credit-downpayment')?.value || 0);
  const remaining = Math.max(0, toCents(cartTotals().total) - toCents(downpayment)) / 100;

  const previewEl = document.getElementById('pos-credit-balance-preview');
  if (previewEl) previewEl.textContent = `${fmtMoney(remaining)}`;
}

// F9 / double-click during the in-flight POST would ring the sale up twice.
// initialized in state.js: S.saleInFlight
// initialized in state.js: S.lastSaleForReprint

export function autoPrintEnabled() {
  return localStorage.getItem('techparts_autoprint') !== '0';
}

// The dialog-vs-silent hint fires once per tab: repeating it on every sale
// would be noise, but the first sale after a manual open is the moment the
// shop learns why auto-print "stopped working".
let autoPrintHintShown = false;

export async function completeSale() {
  if (S.saleInFlight) return;
  if (S.cart.length === 0) {
    showToast(t('pos.err_no_items', 'Add items to the order first'), 'warning');
    return;
  }
  // A zero-peso sale (blank device line alone, or everything discounted away)
  // must not ring up and print a receipt for nothing.
  if (cartTotals().total <= 0) {
    showToast('Order has nothing to charge: add a billable line or reduce the discount', 'warning');
    return;
  }

  const customerName = document.getElementById('pos-customer-name')?.value.trim() || 'Walk-in Customer';
  const customerPhone = document.getElementById('pos-customer-phone')?.value.trim() || '';

  if (S.currentPaymentMethod === 'credit' && (customerName === 'Walk-in Customer' || !customerName)) {
    showToast('Customer / Buyer Name is required for Credit (Utang)', 'warning');
    document.getElementById('pos-customer-name')?.focus();
    return;
  }

  let paymentReference = '';
  if (S.currentPaymentMethod === 'gcash') {
    paymentReference = document.getElementById('pos-gcash-ref')?.value.trim() || '';
  } else if (S.currentPaymentMethod === 'transfer') {
    paymentReference = document.getElementById('pos-transfer-ref')?.value.trim() || '';
  }

  const items = S.cart.map(item => item.is_labor
    ? { item_type: 'labor', item_name: item.name, unit_price: item.unit_price, quantity: item.qty }
    : { inventory_id: item.id, item_type: 'part', quantity: item.qty, unit_price: unitPriceOf(item) });

  // Unit, IMEI and job note as one ₱0 labour line — it costs nothing, so totals
  // are untouched, and the receipt prints it with the intake details.
  const deviceLine = deviceNoteLine();
  if (deviceLine) items.push({ item_type: 'labor', item_name: deviceLine, unit_price: 0, quantity: 1 });

  const { discount, total: totalAmount } = cartTotals();

  let amountPaid = totalAmount;
  if (S.currentPaymentMethod === 'cash') {
    const rawTendered = document.getElementById('pos-tendered')?.value.trim();
    if (rawTendered === '' && totalAmount > 0) {
      showToast('Enter cash tendered or click exact due', 'warning');
      document.getElementById('pos-tendered')?.focus();
      return;
    }
    const tendered = rawTendered === '' ? 0 : Number(rawTendered);
    if (isNaN(tendered) || tendered < 0) {
      showToast('Enter a valid cash tendered amount', 'warning');
      document.getElementById('pos-tendered')?.focus();
      return;
    }
    // Half-cent slack: a cent-quantized due amount compared against a typed
    // tender can differ by float representation alone.
    if (toCents(tendered) < toCents(totalAmount) - 0.5) {
      showToast(`Tendered ${fmtMoney(tendered)} is less than total due ${fmtMoney(totalAmount)}`, 'warning');
      document.getElementById('pos-tendered')?.focus();
      return;
    }
    amountPaid = Math.max(tendered, totalAmount);
  } else if (S.currentPaymentMethod === 'credit') {
    const downpaymentEl = document.getElementById('pos-credit-downpayment');
    const rawDownpayment = downpaymentEl?.value.trim() || '0';
    amountPaid = Number(rawDownpayment);
    if (!Number.isFinite(amountPaid) || amountPaid < 0 || toCents(amountPaid) > toCents(totalAmount) + 0.5) {
      showToast(`Enter a credit downpayment from ${fmtMoney(0)} to ${fmtMoney(totalAmount)}`, 'warning');
      downpaymentEl?.focus();
      return;
    }
  } else if (S.currentPaymentMethod === 'gcash' || S.currentPaymentMethod === 'transfer') {
    amountPaid = totalAmount;
  }

  if (!S.saleOpId) {
    try { S.saleOpId = localStorage.getItem(SALE_OP_KEY) || null; } catch (_) {}
  }
  S.saleOpId ||= (globalThis.crypto?.randomUUID?.() || `sale-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  try { localStorage.setItem(SALE_OP_KEY, S.saleOpId); } catch (_) {}
  S.saleInFlight = true;
  // Lock the checkout control so a double-click or impatient Enter can't
  // re-enter, and say so: the button itself is the processing indicator.
  const checkoutBtn = document.querySelector('[data-action="complete-sale"]');
  const checkoutLabel = checkoutBtn?.querySelector('span');
  const checkoutOrig = checkoutLabel?.textContent || '';
  if (checkoutBtn) { checkoutBtn.disabled = true; if (checkoutLabel) checkoutLabel.textContent = t('pos.processing_payment', 'Processing payment…'); }
  try {
    const res = await fetch('/api/sales', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customer_name: customerName,
        customer_phone: customerPhone,
        customer_type: S.currentPriceTier,
        payment_method: S.currentPaymentMethod,
        payment_reference: paymentReference,
        items,
        discount,
        amount_paid: amountPaid,
        op_id: S.saleOpId
      })
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Sale failed');
    }

    const sale = await res.json();

    // A billed repair upserts its ticket (same reference the hold created) and
    // moves it onto the bench. Read the intake BEFORE the reset clears it.
    const repairIntake = {
      ref: S.repairRefCode,
      customer_name: customerName,
      customer_phone: customerPhone,
      device: document.getElementById('repair-device-input')?.value.trim() || '',
      imei: document.getElementById('repair-imei')?.value.trim() || '',
      issue_note: document.getElementById('repair-note')?.value.trim() || '',
      status: 'in_repair',
      sale_id: sale.id
    };
    if (repairIntake.device || repairIntake.imei || repairIntake.issue_note) {
      try {
        const rres = await fetch('/api/repairs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(repairIntake)
        });
        if (!rres.ok) throw new Error('ticket save failed');
      } catch (_) {
        showToast('Sale recorded, but the repair ticket did not save. Add it in the Repairs tab by reference ' + S.repairRefCode + '.', 'warning');
      }
    }

    // Blank job sheet and a fresh reference for the next customer.
    // The in-flight flag must drop BEFORE the reset: resetRepairCounter()
    // routes through setPaymentMethod, which now stands down while a sale
    // is in flight.
    S.saleInFlight = false;
    resetRepairCounter();
    loadPosCatalog();
    loadCustomerSuggestions();

    // Display Itemized Receipt Modal & Render Thermal
    S.lastSaleForReprint = sale;
    renderReceipt(sale);
    openModal('modal-receipt');
    // The sale is committed, but placeholder identity must not reach paper:
    // skip auto-print and say why. Settings then reprint from the modal.
    if (shopIdentityIsPlaceholder()) {
      showToast('Sale recorded, but the receipt was not printed: shop identity is still the placeholder. Fix it in Settings, then reprint.', 'warning');
    } else if (autoPrintEnabled()) {
      // Native ESC/POS: the server lays the slip out and pushes it to the queue
      // named in Settings, so the counter never has to touch a dialog. The
      // fallback re-renders THIS sale first: while the send is open the modal
      // may already show a newer one, and the dialog prints what is on screen.
      autoPrintSlip({ kind: 'sale', sale_id: sale.id }, () => renderReceipt(sale)).then((fellBack) => {
        if (!fellBack) return;
        // A manual tab cannot print silently; say so once instead of every sale.
        if (sessionStorage.getItem('pos_kiosk') !== '1' && !autoPrintHintShown) {
          autoPrintHintShown = true;
          showToast('Auto-print fell back to the print dialog: this window was opened manually. Reopen the POS from its desktop icon for one-touch printing.', 'info');
        }
      });
    }
    showToast(t('pos.sale_completed', 'Sale #{code} completed').replace('{code}', sale.sale_code), 'success');
    if (typeof window.refreshSyncChip === 'function') window.refreshSyncChip();
  } catch (err) {
    showToast(t('pos.sale_error', 'Error completing sale: {msg}').replace('{msg}', err.message), 'error');
  } finally {
    S.saleInFlight = false;
    if (checkoutBtn) { checkoutBtn.disabled = false; if (checkoutLabel) checkoutLabel.textContent = checkoutOrig; }
  }
}

export async function openShiftPrompt() {
  const v = await inputModal('Opening float', { inputType: 'number', placeholder: '0.00', defaultValue: '0', yes: 'Open drawer' });
  if (v === null) return;
  const floatAmt = String(v).trim() === '' ? 0 : Number(v);
  if (!Number.isFinite(floatAmt) || floatAmt < 0) {
    const m = 'Opening float must be a non-negative number';
    if (typeof showToast !== 'undefined') showToast(m, 'error'); else alert(m);
    return;
  }
  try {
    const res = await fetch('/api/shifts/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ opening_float: floatAmt }) });
    const data = await res.json().catch(()=>({}));
    if (!res.ok) throw new Error(data.error||'Open failed');
    const msg = `Drawer #${data.id} opened for this workstation`;
    if (typeof showToast !== 'undefined') showToast(msg,'success'); else alert(msg);
    const shiftEl = document.getElementById('store-card-shift');
    if (shiftEl) shiftEl.textContent = `Drawer #${data.id} OPEN · ${S.sessionActor?.name || 'Counter'}`;
    if (S.currentTab === 'dashboard') {
      import('./backoffice.js').then(b => {
        b.loadDashboardData({ silent: true });
        b.loadDayClose();
      }).catch(() => {});
    }
  } catch(e){ const msg=e.message; if(typeof showToast!=='undefined') showToast(msg,'error'); else alert(msg); }
}
export async function closeShiftPrompt() {
  const shifts = await fetch('/api/shifts').then(r=>r.json()).catch(()=>[]);
  const open = (Array.isArray(shifts)?shifts:[]).find(s=>s.status==='open');
  if (!open) { const m = 'No open drawer on this workstation'; if (typeof showToast !== 'undefined') showToast(m, 'warning'); else alert(m); return; }
  // Numbered field, not prompt(): a typed "1,250" through Number() becomes
  // NaN, stringifies to null over JSON, and closed the shift at 0 on the
  // server. Parse here, refuse what is not a non-negative amount.
  const v = await inputModal('Counted cash', { inputType: 'number', placeholder: '0.00', yes: 'Close drawer' });
  if (v === null) return;
  const counted = Number(v);
  if (String(v).trim() === '' || !Number.isFinite(counted) || counted < 0) {
    const m = 'Counted cash must be a non-negative number';
    if (typeof showToast !== 'undefined') showToast(m, 'error'); else alert(m);
    return;
  }
  try {
    const res = await fetch(`/api/shifts/${open.id}/close`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ counted_cash: counted })});
    const data = await res.json().catch(()=>({}));
    if (!res.ok) {
      if (res.status===403 && data.code==='elevation_required') {
        const { requireManagerPin } = await import('../auth.js');
        requireManagerPin('Enter manager PIN to close the drawer', () => closeShiftPrompt()); return;
      }
      throw new Error(data.error||'Close failed');
    }
    // One drawer can pass through two cashiers: name who took what so the
    // signed variance is attributable instead of landing on whoever opened.
    const who = Array.isArray(data.by_staff) && data.by_staff.length > 1
      ? ` · ${data.by_staff.map(s => `${s.staff_name} ${fmtMoney(s.cash_collected)}`).join(', ')}`
      : '';
    const msg = `Drawer closed: expected ${data.expected_cash}, variance ${data.variance}${who}`;
    if(typeof showToast!=='undefined') showToast(msg,'success'); else alert(msg);
    const shiftEl = document.getElementById('store-card-shift');
    if (shiftEl) shiftEl.textContent = `Drawer CLOSED · ${S.sessionActor?.name || 'Counter'}`;
    if (S.currentTab === 'dashboard') {
      import('./backoffice.js').then(b => {
        b.loadDashboardData({ silent: true });
        b.loadDayClose();
      }).catch(() => {});
    }
  } catch(e){ const msg=e.message; if(typeof showToast!=='undefined') showToast(msg,'error'); else alert(msg); }
}

export function newRepairRef() {
  const d = new Date();
  const stamp = `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  // Time-of-day base36 instead of a 3-digit random: two jobs minted near each
  // other shared a printed ref otherwise, and the ref is what the counter
  // reads aloud and searches for.
  return `RO-${stamp}-${Date.now().toString(36).slice(-4).toUpperCase()}`;
}

export function printClaimStub() {
  if (S.saleInFlight) return; // sale in flight: the job on screen is the request payload
  if (shopIdentityIsPlaceholder()) {
    showToast(t('stub.no_identity', 'Claim stub not printed: shop identity is still the placeholder. Save real shop details in Settings.'), 'error');
    return;
  }
  const device = deviceLabel() || document.getElementById('repair-device-input')?.value.trim() || '';
  const imei = document.getElementById('repair-imei')?.value.trim() || '';
  const note = document.getElementById('repair-note')?.value.trim() || '';
  if (!device && !note && S.cart.length === 0) {
    showToast(t('stub.nothing', 'Enter a device, job note, or part before printing a claim stub'), 'warning');
    return;
  }
  const customer = document.getElementById('pos-customer-name')?.value.trim() || 'Walk-in Customer';
  const phone = document.getElementById('pos-customer-phone')?.value.trim() || '';
  const { subtotal, discount, total } = cartTotals();
  const items = S.cart.map(item => ({
    ...item,
    unit_price: unitPriceOf(item)
  }));
  const job = {
    ref: S.repairRefCode,
    customer,
    phone,
    device,
    imei,
    note,
    items,
    subtotal,
    discount,
    total
  };
  // Queue first like every other counter slip; the browser render is the
  // fallback, not the primary path. The dialog hint is the sale path's
  // once-per-session message: a manual tab cannot print silently.
  autoPrintSlip({ kind: 'claim_stub', ...job }, () => renderClaimStub(job)).then((fellBack) => {
    if (!fellBack) return;
    if (sessionStorage.getItem('pos_kiosk') !== '1' && !autoPrintHintShown) {
      autoPrintHintShown = true;
      showToast(t('stub.fallback', 'Printed through the browser dialog: this window was opened manually. Reopen the POS from its desktop icon for one-touch printing.'), 'info');
    }
  });
}
