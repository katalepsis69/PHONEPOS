import { S, PLACEHOLDER_SHOP } from './state.js';
import { DEVICE_LINE_PREFIX } from './views/pos.js';
import { calculateWarrantyExpiry, escHtml, fmtMoney, formatDateTime, isFiniteAmount, showToast, warrantyDays } from './ui.js';

// -------------------------------------------------------------
// MONEY THAT MAY NOT GO ON PAPER
// -------------------------------------------------------------
// The rule is one predicate, `isFiniteAmount` in ui.js, and it is the rule
// `money()` in src/printer.js runs on the roll. What differs is the answer: the
// two paper formatters THROW, because a figure nobody can read must not leave
// the counter at all, while the shared screen formatter marks it (`₱--`) so a
// list stays listable. This module adds the third piece: a slip with a broken
// amount is refused BEFORE any of it is built, because a throw halfway through
// the render would leave the PREVIOUS customer's document in #printable-receipt,
// which is precisely what a fallback window.print() hands over.
const SALE_MONEY_FIELDS = ['subtotal', 'discount', 'total_amount', 'amount_paid', 'change_amount', 'credit_balance', 'refunded_amount'];
const SALE_ITEM_MONEY_FIELDS = ['unit_price', 'total_price'];
const SETTLEMENT_MONEY_FIELDS = ['amount_paid'];
const SETTLEMENT_BALANCE_FIELDS = ['total_credit_balance'];

// The throw both papers make, flagged so the print route reads it as a refusal
// rather than a printer fault (src/printer.js's money() sets the same flag, and
// `isAmountRefusal` there is what answers `fallback:false`). It lives here, with
// the paper that refuses, and not in the shared screen module: this copy names
// the document that did not print, and a formatter used by list views has no
// business claiming anything about a receipt.
function amountRefusal(field) {
  const err = new Error(`${field} is not a number, so this slip was not printed`);
  err.amountRefusal = true;
  return err;
}

// Printable form of an amount for the browser's roll: the plain P the printable
// copy has always used, and the same refusal the ESC/POS slip makes.
function printMoney(n) {
  if (!isFiniteAmount(n)) throw amountRefusal('Amount');
  // Same digits and grouping as paper's money() (src/printer.js), so a
  // fallback copy reads like the queue slip it replaced.
  return 'P' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// The first amount on the slip that no paper may state, or null when all of them
// are real numbers. Field lists mirror what src/printer.js's renderers run
// through money(); tests/printer.test.js pins the two against each other, so a
// money row added on one paper and not the other fails there instead of silently
// printing a figure nobody checked.
function firstUnprintableAmount(row, fields, items) {
  for (const field of fields) {
    if (!isFiniteAmount(row?.[field])) return field;
  }
  for (const item of (items || [])) {
    for (const field of SALE_ITEM_MONEY_FIELDS) {
      if (!isFiniteAmount(item?.[field])) return `${item?.item_name || 'an item'}: ${field}`;
    }
  }
  return null;
}

// Both papers are refused, so say so where the cashier is looking and take the
// stale print canvas out of the way. The declared slip stays declared on purpose:
// a deliberate Print click then goes to the route, which refuses again with the
// reason it read off the row, instead of falling through to the browser and
// printing a blank page.
function refuseUnprintableAmount(container, printable, field) {
  const why = `Receipt not printed: the amount "${field}" on this slip is not a number, so no figure is safe to print on either paper.`;
  container.innerHTML = `<div class="text-[11px] text-rose-400 py-2">${escHtml(why)}</div>`;
  if (printable) printable.innerHTML = '';
  showToast(why, 'error');
}

function defaultShopSubtitle() {
  const type = S.shopSettings?.business_type || 'hybrid';
  if (type === 'grocery') return 'Grocery & General Merchandise';
  if (type === 'pc') return 'PC & Electronics Sales & Services';
  if (type === 'retail') return 'Retail & General Merchandise';
  if (type === 'hybrid') return 'Sales & Repair Services';
  return 'Phone Parts, LCDs & Repair Service';
}

function brandHeaderHtml(isThermal = false, trimmed = false) {
  const name = escHtml(S.shopSettings.gcash_name || 'TECHPARTS POS');
  const addr = S.shopSettings.shop_address ? escHtml(S.shopSettings.shop_address) : '';
  const tel = S.shopSettings.gcash_number ? escHtml(S.shopSettings.gcash_number) : '';
  // Trimmed templates (compact/airy/grid) drop the address and Tel/GCash lines,
  // mirroring the paper header in src/printer.js.
  if (trimmed) {
    return isThermal
      ? `<div class="rcp-lg" style="font-weight: bold; text-transform: uppercase;">${name}</div>`
      : `<div class="font-bold text-sm tracking-wider uppercase">${name}</div>`;
  }
  const sub = defaultShopSubtitle();
  if (isThermal) {
    return `<div class="rcp-lg" style="font-weight: bold; text-transform: uppercase;">${name}</div>
        <div>${addr || sub}</div>
        <div>Tel/GCash: ${tel}</div>`;
  }
  return `<div class="font-bold text-sm tracking-wider uppercase">${name}</div>
      ${addr ? `<div class="text-[10px] text-slate-400">${addr}</div>` : `<div class="text-[10px] text-slate-400">${sub}</div>`}
      ${tel ? `<div class="text-[10px] text-slate-400 font-mono">Tel/GCash: ${tel}</div>` : ''}`;
}

// -------------------------------------------------------------
// PRINT PAGE PINNING — keep the browser's print page 1:1 with the roll.
// With the stylesheet's generic `@page { size: auto }`, Chromium borrows the
// print dialog's default paper (often A4, or the other roll width) and then
// fit-scales the receipt onto the real paper — the classic "printed receipt
// too big / too small" report. Pinning the page to the roll at render time
// removes that scaling: Chromium prints a smaller CSS page at true size
// (never enlarges it) and only shrinks pages that overshoot the paper.
function paperWidthMm() {
  return S.shopSettings.receipt_paper_width === '58mm' ? 58 : 80;
}

// The head cannot ink the whole roll: 384 dots at 203dpi on a 58mm roll, 576 on
// 80mm. Read the window off the .thermal-* rules so the pinned page, the height
// probe and the printed box can never disagree about where the right edge is.
function printableWidthMm() {
  const sel = paperWidthMm() === 58 ? '.thermal-58mm' : '.thermal-80mm';
  for (const sheet of document.styleSheets) {
    let rules;
    try { rules = sheet.cssRules; } catch { continue; }
    for (const rule of rules) {
      if (rule.selectorText !== sel) continue;
      const spec = rule.style.width, n = parseFloat(spec);
      if (Number.isFinite(n)) return /px$/.test(spec) ? (n * 25.4) / 96 : n;
    }
  }
  return paperWidthMm() - 10;
}

function applyPrintPageSize() {
  let tag = document.getElementById('print-page-size');
  if (!tag) {
    tag = document.createElement('style');
    tag.id = 'print-page-size';
    document.head.appendChild(tag); // after the styles.css link, so it wins
  }
  const printableMm = printableWidthMm();
  const contentPx = measurePrintHeightPx(printableMm);
  if (!contentPx) { tag.textContent = ''; return; } // keep the generic fallback
  // Page width is the ROLL, matching the driver's own paper form, while the
  // receipt box stays at the printable window and is left-aligned. A page
  // narrower than the driver's paper gets centred onto it, which shifts every
  // line right; a page as wide as the roll leaves the driver nothing to centre.
  // Page height = the receipt's own height (+6px slack so sub-pixel rounding
  // in the mm→pt print pipeline can never spill a blank second page), capped
  // at ≈297mm: anything taller paginates like before instead of shrinking.
  const pagePx = Math.min(contentPx + 6, Math.round((297 * 96) / 25.4));
  tag.textContent = `@page { size: ${paperWidthMm()}mm ${pagePx}px; margin: 0mm; }`;
}

// The #printable-receipt rule inside styles.css's @media print block — the
// canonical print metrics, read from the CSSOM so this probe cannot drift
// from the print CSS. Null when the sheet is missing or blocked.
function printMetrics() {
  for (const sheet of document.styleSheets) {
    let rules;
    try { rules = sheet.cssRules; } catch { continue; }
    for (const rule of rules) {
      if (!(rule instanceof CSSMediaRule) || !/print/.test(rule.media.mediaText)) continue;
      for (const inner of rule.cssRules) {
        if (inner.selectorText === '#printable-receipt') return inner.style;
      }
    }
  }
  return null;
}

// Height the printer will lay out. The receipt element is display:none until
// print, so measure a detached probe playing its role: same content, same
// roll width, same print metrics.
function measurePrintHeightPx(printableMm) {
  const printable = document.getElementById('printable-receipt');
  const metrics = printMetrics();
  if (!printable || !printable.innerHTML || !metrics) return 0;
  let probe = document.getElementById('print-height-probe');
  if (!probe) {
    probe = document.createElement('div');
    probe.id = 'print-height-probe';
    document.body.appendChild(probe);
  }
  probe.style.cssText =
    'position:absolute;left:-9999mm;top:0;visibility:hidden;' +
    `box-sizing:border-box;width:${printableMm}mm;` +
    `padding:${metrics.padding};font-family:${metrics.fontFamily};` +
    `font-size:${metrics.fontSize};line-height:${metrics.lineHeight};overflow-wrap:${metrics.overflowWrap};`;
  probe.innerHTML = printable.innerHTML;
  const h = probe.offsetHeight;
  probe.innerHTML = '';
  return h;
}

// ------------------------------------------------------------------
// WHICH SLIP IS IN THE MODAL — one place owns this answer.
// #modal-receipt's Print button is shared by every slip the app can show, and
// the queue now prints more than one kind, so the button carries the whole
// payload of the slip on screen, written only through setModalSlip() below.
// Before this each renderer remembered an attribute name (data-sale-id) and
// cleared it by hand: correct while a sale was the only slip with a queue path,
// one forgotten clear away from reprinting the previous customer's receipt the
// moment a second slip type arrived behind the same button. A renderer that has
// no queue path declares null and the browser dialog prints, as before.
// ------------------------------------------------------------------
const MODAL_PRINT_BUTTON = '#modal-receipt [data-action="print-slip"]';

// One print from this button at a time. The browser dialog used to be the
// throttle: window.print() blocks, so a second click landed on a dialog that was
// already up. With the queue path the click only awaits a fetch, so a double click
// now sends two jobs and writes two audit rows for one sale, silently, and the
// customer gets two receipts. Set before the first await, released in a finally,
// and it covers the fallback print too, because that is the second half of the
// same click. The undeclared and placeholder-identity paths never await, so they
// cannot interleave with a second click and need no flag.
let modalPrintInFlight = false;

export function setModalSlip(payload) {
  const button = document.querySelector(MODAL_PRINT_BUTTON);
  if (!button) return;
  if (payload) button.dataset.slip = JSON.stringify(payload);
  else delete button.dataset.slip;
}

// A half-written or hand-edited attribute must not send a malformed job to the
// printer, so anything that is not an object with a kind reads as no slip.
export function getModalSlip() {
  const raw = document.querySelector(MODAL_PRINT_BUTTON)?.dataset?.slip;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && parsed.kind ? parsed : null;
  } catch {
    return null;
  }
}

// The declaration is retired with the slip that made it. ui.js's closeModal()
// calls this for every dialog it shuts, and only the receipt modal has ever
// declared one, so the rest are untouched -- but the write stays here, in the
// one module that owns it, rather than in a second module reaching for the same
// dataset key. Without this the payload outlived its document: close a
// settlement, and any later print from this button would still name that
// payment, because nothing on close said the modal was empty again. A slip that
// is merely undeclared still routes to the browser dialog.
export function clearModalSlip(id) {
  if (id === 'modal-receipt') setModalSlip(null);
}

export function renderReceipt(sale) {
  const container = document.getElementById('receipt-content');
  const printable = document.getElementById('printable-receipt');
  if (!container) return;
  // The modal is reused, so declare what it now holds: a deliberate click on
  // Print Slip prints THIS sale through the queue, never whatever sale the
  // last renderer left behind.
  setModalSlip(sale && sale.id != null ? { kind: 'sale', sale_id: Number(sale.id) } : null);

  // Refuse the whole slip before a single line of it is built: an amount that is
  // not a number is a corrupted or hand-edited row, no paper may state it, and a
  // throw halfway through would leave the last customer's slip on the print
  // canvas for a fallback window.print() to hand over.
  const brokenAmount = firstUnprintableAmount(sale, SALE_MONEY_FIELDS, sale.items);
  if (brokenAmount) {
    refuseUnprintableAmount(container, printable, brokenAmount);
    return;
  }

  const dateStr = formatDateTime(sale.created_at || new Date().toISOString());
  const expiryDate = calculateWarrantyExpiry(sale.created_at, S.shopSettings.warranty_days);
  const paperClass = S.shopSettings.receipt_paper_width === '58mm' ? 'thermal-58mm' : 'thermal-80mm';
  // Template + item rows come from Settings; unknown values read standard/auto,
  // the same fallback src/printer.js applies on paper.
  const template = ['standard', 'compact', 'boxed', 'airy', 'grid'].includes(S.shopSettings.receipt_template) ? S.shopSettings.receipt_template : 'standard';
  const rowMode = ['auto', 'two_line', 'one_line'].includes(S.shopSettings.receipt_item_rows) ? S.shopSettings.receipt_item_rows : 'auto';
  const trimmed = template === 'compact' || template === 'airy' || template === 'grid';
  const withPolicy = !trimmed;
  // The footer note is decorative, so compact is the one template without it;
  // the same rule the paper builders apply.
  const showFooterNote = template !== 'compact';
  const dateLine = `${escHtml(dateStr)}${trimmed && sale.payment_method ? ` / ${escHtml(String(sale.payment_method).toUpperCase())}` : ''}`;

  // The repair's unit / IMEI / note rides along as a ₱0 labour line so it can be
  // stored without a schema change. It belongs with the intake details here,
  // never as a priced row.
  const allItems = sale.items || [];
  const deviceItem = allItems.find(it => it.item_type === 'labor' &&
    Number(it.unit_price) === 0 && String(it.item_name || '').startsWith(DEVICE_LINE_PREFIX));
  const deviceText = deviceItem ? String(deviceItem.item_name).slice(DEVICE_LINE_PREFIX.length) : '';
  const billable = allItems.filter(it => it !== deviceItem);

  // Item rows follow the template and the Item rows setting: two_line is the
  // original stacked row; one_line/auto collapse to "2x name ... amount" like
  // paper does; grid sets its own qty/name/amount columns.
  let itemsHtml;
  if (template === 'grid') {
    itemsHtml = `
      <div class="py-2 text-[11px]">
        <div class="flex justify-between font-bold text-slate-500 pb-1 border-b border-slate-800">
          <span class="w-8">QTY</span><span class="flex-1">ITEM</span><span class="text-right">AMOUNT</span>
        </div>
        ${billable.map(it => `
          <div class="flex justify-between py-1">
            <span class="w-8 tabular-nums">${it.quantity}</span>
            <span class="flex-1">${it.item_type === 'labor' ? '[LABOR] ' : ''}${escHtml(it.item_name)}</span>
            <span class="text-right font-bold text-teal-400 whitespace-nowrap">${fmtMoney(Number(it.total_price))}</span>
          </div>`).join('')}
      </div>`;
  } else if (rowMode === 'two_line') {
    itemsHtml = billable.map(it => `
      <div class="flex justify-between py-1 border-b border-slate-800">
        <div>
          <div class="font-bold flex items-center gap-1">
            ${it.item_type === 'labor' ? `<span class="text-[9px] px-1 bg-amber-500/20 text-amber-300 rounded">LABOR</span>` : ''}
            <span>${escHtml(it.item_name)}</span>
          </div>
          <div class="text-[10px] text-slate-400">${it.quantity} x ${fmtMoney(Number(it.unit_price))}</div>
        </div>
        <div class="text-right text-teal-400 font-bold">${fmtMoney(Number(it.total_price))}</div>
      </div>
    `).join('');
    itemsHtml = `<div class="py-2 space-y-1">${itemsHtml}</div>`;
  } else {
    itemsHtml = `
      <div class="py-2 space-y-0.5 text-[11px]">
        ${billable.map(it => `
          <div class="flex justify-between py-1 border-b border-slate-800 gap-2">
            <span class="truncate">${it.quantity}x ${it.item_type === 'labor' ? '[LABOR] ' : ''}${escHtml(it.item_name)}</span>
            <span class="text-right text-teal-400 font-bold whitespace-nowrap">${fmtMoney(Number(it.total_price))}</span>
          </div>`).join('')}
      </div>`;
  }

  // UI Modal Preview
  container.innerHTML = `
    <div class="text-center pb-3 border-b border-slate-800">
      ${brandHeaderHtml(false, trimmed)}
      <div class="text-[10px] text-slate-500 mt-1 font-mono">Invoice #${escHtml(sale.sale_code)}</div>
      <div class="text-[10px] text-slate-500">${dateLine}</div>
    </div>

    <div class="text-[11px] space-y-0.5 py-1 border-b border-slate-800 text-slate-300">
      <div><span class="text-slate-500">Customer:</span> <strong>${escHtml(sale.customer_name)}</strong></div>
      ${sale.customer_phone ? `<div><span class="text-slate-500">Phone:</span> ${escHtml(sale.customer_phone)}</div>` : ''}
      ${deviceText ? `<div><span class="text-slate-500">Unit:</span> ${escHtml(deviceText)}</div>` : ''}
      <div><span class="text-slate-500">Payment:</span> <span class="uppercase font-bold text-sky-400">${escHtml(sale.payment_method)}</span> ${sale.payment_reference ? `(Ref: ${escHtml(sale.payment_reference)})` : ''}</div>
    </div>

    <div class="py-2 space-y-1">${itemsHtml}</div>

    <div class="pt-2 border-t border-slate-800 space-y-1 text-[11px]">
      <div class="flex justify-between text-slate-400"><span>Subtotal</span><span>${fmtMoney(Number(sale.subtotal))}</span></div>
      ${sale.discount > 0 ? `<div class="flex justify-between text-amber-400"><span>Discount</span><span>-${fmtMoney(Number(sale.discount))}</span></div>` : ''}
      ${template === 'boxed'
        ? `<div class="flex justify-between font-bold text-sm pt-1 mt-1 border-2 border-slate-800 rounded px-2 py-1">
            <span>Total Due</span><span class="text-teal-400">${fmtMoney(Number(sale.total_amount))}</span>
          </div>`
        : `<div class="flex justify-between font-bold text-sm pt-1 border-t border-slate-800">
            <span>Total Due</span><span class="text-teal-400">${fmtMoney(Number(sale.total_amount))}</span>
          </div>`}
      <div class="flex justify-between text-slate-300"><span>Amount Paid</span><span>${fmtMoney(Number(sale.amount_paid))}</span></div>
      ${sale.change_amount > 0 ? `<div class="flex justify-between font-bold text-teal-400"><span>Change</span><span>${fmtMoney(Number(sale.change_amount))}</span></div>` : ''}
      ${sale.credit_balance > 0 ? `
        <div class="flex justify-between font-bold text-rose-400 bg-rose-500/10 p-1.5 rounded-lg mt-1 border border-rose-500/30">
          <span>Outstanding Utang:</span><span>${fmtMoney(Number(sale.credit_balance))}</span>
        </div>` : ''}
      ${sale.returns && sale.returns.length > 0 ? `
        <div class="pt-2 border-t border-slate-800 space-y-1 text-[11px] text-amber-300">
          <div class="flex justify-between font-bold">
            <span>Returns / Refunds (${sale.returns.length}):</span>
            <span class="text-rose-400">-${fmtMoney(Number(sale.refunded_amount || 0))}</span>
          </div>
          ${sale.returns.map(r => `
            <div class="flex justify-between text-[10px] text-slate-400">
              <span>${escHtml(r.return_code)} (${r.quantity || 1}x ${escHtml(r.item_name)})</span>
              <span>${r.refund_amount > 0 ? fmtMoney(Number(r.refund_amount)) : 'Replacement'}</span>
            </div>
          `).join('')}
        </div>` : ''}
    </div>

    <div class="pt-2 border-t border-slate-800 text-[10px] text-slate-400 space-y-1">
      ${withPolicy ? `
        <div class="font-bold text-slate-300">WARRANTY POLICY (${warrantyDays(S.shopSettings.warranty_days)} Days):</div>
        <div class="text-[9px] text-slate-500">${escHtml(S.shopSettings.warranty_policy_text)}</div>` : ''}
      <div class="text-[9px] text-amber-400/90 font-mono">${withPolicy ? 'Warranty Valid Until: ' : `Warranty: ${warrantyDays(S.shopSettings.warranty_days)} day(s), valid until `}${escHtml(expiryDate)}</div>
      ${showFooterNote && S.shopSettings.shop_footer_note ? `<div class="text-[9px] text-slate-400 text-center pt-1 font-medium">*** ${escHtml(S.shopSettings.shop_footer_note)} ***</div>` : ''}
    </div>
  `;

  // Render High-Contrast Thermal Print HTML for @media print
  if (printable) {
    // Keep .hidden so the print block never leaks onto the screen; the print
    // stylesheet forces display:block for @media print.
    printable.className = `${paperClass} hidden`;
    // At the printer's 12-dot cell a 58mm roll is 32 columns, which still does
    // not fit name + qty + price for long part names, so there each item prints
    // as a bold name line over a "qty x unit … total" line.
    const is58 = paperWidthMm() === 58;
    const hrStyle = template === 'boxed' ? 'border-top: 3px double #000;' : 'border-top: 1px dashed #000;';
    let itemsPrintHtml;
    if (template === 'grid') {
      itemsPrintHtml = `
      <div style="font-size: 12px;">
        <div style="display: flex; font-weight: bold; border-bottom: 1px solid #000; padding-bottom: 2px;">
          <span style="width: 24px;">QTY</span><span style="flex: 1;">ITEM</span><span style="text-align: right;">AMOUNT</span>
        </div>
        ${billable.map(it => `
          <div style="display: flex; padding: 2px 0;">
            <span style="width: 24px;">${it.quantity}</span>
            <span style="flex: 1;">${it.item_type === 'labor' ? '[LABOR] ' : ''}${escHtml(it.item_name)}</span>
            <span style="text-align: right; white-space: nowrap;">${printMoney(it.total_price)}</span>
          </div>`).join('')}
      </div>
    `;
    } else if (rowMode === 'two_line') {
      itemsPrintHtml = is58 ? `
      <div style="font-size: 12px;">
        ${billable.map(it => `
          <div style="padding: 2px 0;">
            <div style="font-weight: bold;">${it.item_type === 'labor' ? '[LABOR] ' : ''}${escHtml(it.item_name)}</div>
            <div style="display: flex; justify-content: space-between;">
              <span>${it.quantity} x ${printMoney(it.unit_price)}</span>
              <span>${printMoney(it.total_price)}</span>
            </div>
          </div>
        `).join('')}
      </div>
    ` : `
      <table style="width: 100%; font-size: 12px; border-collapse: collapse;">
        <thead>
          <tr style="border-bottom: 1px dashed #000; text-align: left;">
            <th>Item / Description</th>
            <th style="text-align: center;">Qty</th>
            <th style="text-align: right;">Unit</th>
            <th style="text-align: right;">Total</th>
          </tr>
        </thead>
        <tbody>
          ${billable.map(it => `
            <tr>
              <td style="padding: 2px 0;">${it.item_type === 'labor' ? '[LABOR] ' : ''}${escHtml(it.item_name)}</td>
              <td style="text-align: center; padding: 2px 0;">${it.quantity}</td>
              <td style="text-align: right; padding: 2px 0;">${printMoney(it.unit_price)}</td>
              <td style="text-align: right; padding: 2px 0;">${printMoney(it.total_price)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
    } else {
      // One line per item, like paper's one_line/auto: "2x name ... amount".
      // The browser flows long names onto a second row instead of truncating.
      itemsPrintHtml = `
      <div style="font-size: 12px;">
        ${billable.map(it => `
          <div style="display: flex; justify-content: space-between; gap: 8px; padding: 2px 0;">
            <span style="min-width: 0; overflow-wrap: anywhere;">${it.quantity}x ${it.item_type === 'labor' ? '[LABOR] ' : ''}${escHtml(it.item_name)}</span>
            <span style="white-space: nowrap;">${printMoney(it.total_price)}</span>
          </div>
        `).join('')}
      </div>
    `;
    }

    printable.innerHTML = `
      <div style="text-align: center; margin-bottom: 4px;">
        ${brandHeaderHtml(true, trimmed)}
        <div style="margin: 4px 0; ${hrStyle}"></div>
        <div style="font-size: 13px; font-weight: bold;">OFFICIAL RECEIPT</div>
        <div style="font-size: 12px;">Invoice #: ${escHtml(sale.sale_code)}</div>
        <div style="font-size: 12px;">${dateLine}</div>
      </div>

      <div style="margin-bottom: 4px; font-size: 12px;">
        <div>Customer: <strong>${escHtml(sale.customer_name)}</strong></div>
        ${sale.customer_phone ? `<div>Phone: ${escHtml(sale.customer_phone)}</div>` : ''}
        ${deviceText ? `<div>Unit: ${escHtml(deviceText)}</div>` : ''}
        <div>Payment: ${escHtml(sale.payment_method.toUpperCase())} ${sale.payment_reference ? `(Ref: ${escHtml(sale.payment_reference)})` : ''}</div>
      </div>

      <div style="${hrStyle} margin: 4px 0;"></div>

      ${itemsPrintHtml}

      <div style="${hrStyle} margin: 4px 0;"></div>

      <div style="font-size: 13px; line-height: 1.4;">
        <div style="display: flex; justify-content: space-between;"><span>Subtotal:</span><span>${printMoney(sale.subtotal)}</span></div>
        ${sale.discount > 0 ? `<div style="display: flex; justify-content: space-between;"><span>Discount:</span><span>-${printMoney(sale.discount)}</span></div>` : ''}
        ${template === 'boxed'
          ? `<div style="border: 1px solid #000; padding: 2px 4px; margin: 4px 0; display: flex; justify-content: space-between; font-weight: bold; font-size: 14px;">
              <span>TOTAL DUE:</span><span>${printMoney(sale.total_amount)}</span>
            </div>`
          : `<div style="display: flex; justify-content: space-between; font-weight: bold; font-size: 14px; border-top: 1px solid #000; padding-top: 2px;">
              <span>TOTAL DUE:</span><span>${printMoney(sale.total_amount)}</span>
            </div>`}
        <div style="display: flex; justify-content: space-between;"><span>Amount Paid:</span><span>${printMoney(sale.amount_paid)}</span></div>
        ${sale.change_amount > 0 ? `<div style="display: flex; justify-content: space-between; font-weight: bold;"><span>CHANGE:</span><span>${printMoney(sale.change_amount)}</span></div>` : ''}
        ${sale.credit_balance > 0 ? `<div style="display: flex; justify-content: space-between; font-weight: bold;"><span>BALANCE (UTANG):</span><span>${printMoney(sale.credit_balance)}</span></div>` : ''}
        ${sale.returns && sale.returns.length > 0 ? `
          <div style="border-top: 1px dashed #000; margin-top: 4px; padding-top: 2px; color: #b91c1c;">
            <div style="display: flex; justify-content: space-between; font-weight: bold;">
              <span>RETURNS / REFUNDS (${sale.returns.length}):</span>
              <span>-P${Number(sale.refunded_amount || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
            </div>
            ${sale.returns.map(r => `
              <div style="display: flex; justify-content: space-between; font-size: 11px;">
                <span>${escHtml(r.return_code)} (${r.quantity || 1}x ${escHtml(r.item_name)})</span>
                <span>${Number.isFinite(Number(r.refund_amount)) && Number(r.refund_amount) > 0 ? printMoney(r.refund_amount) : 'Replacement'}</span>
              </div>
            `).join('')}
          </div>` : ''}
      </div>

      ${sale.credit_balance > 0 ? `
        <div style="border: 1px solid #000; padding: 4px; margin-top: 8px; font-size: 11px; text-align: center;">
          <div style="font-weight: bold; text-decoration: underline;">CREDIT / UTANG ACKNOWLEDGEMENT</div>
          <div style="margin-top: 3px;">I acknowledge receipt of the goods above and agree to pay the balance of ${printMoney(sale.credit_balance)}.</div>
          <div style="margin-top: 16px; border-top: 1px solid #000; padding-top: 2px;">Customer Signature</div>
        </div>` : ''}

      <div style="${hrStyle} margin-top: 8px; padding-top: 4px; font-size: 11px; text-align: center;">
        ${withPolicy ? `
          <div style="font-weight: bold;">WARRANTY (${warrantyDays(S.shopSettings.warranty_days)} DAYS):</div>
          <div>${escHtml(S.shopSettings.warranty_policy_text)}</div>` : ''}
        <div style="margin-top: 2px; font-weight: bold;">${withPolicy ? 'Valid Until: ' : `Warranty: ${warrantyDays(S.shopSettings.warranty_days)} day(s), valid until `}${escHtml(expiryDate)}</div>
        ${showFooterNote ? `<div style="margin-top: 4px;">*** ${escHtml(S.shopSettings.shop_footer_note || 'Thank you for your business!')} ***</div>` : ''}
      </div>
    `;
    applyPrintPageSize();
  }
}

export function renderSettlementReceipt(payment, customer) {
  const container = document.getElementById('receipt-content');
  const printable = document.getElementById('printable-receipt');
  if (!container) return;
  // A settlement is its own slip, so it declares its own payload: the server
  // re-reads the payment row and the debtor's live balance by name, which is
  // also what stops a stale id from printing some other customer's collection.
  // The name travels as the payment's own stored spelling, because that is the
  // row the id was found under.
  setModalSlip(payment && payment.id != null
    ? { kind: 'settlement', payment_id: Number(payment.id), customer_name: String(payment.customer_name || customer?.customer_name || '') }
    : null);

  // The same refusal the sale slip makes, on the two amounts this one states: the
  // collection and the live balance still owed. The balance is the figure the
  // customer is signing for, so a broken one must not reach paper either.
  const brokenAmount = firstUnprintableAmount(payment, SETTLEMENT_MONEY_FIELDS)
    || firstUnprintableAmount(customer || {}, SETTLEMENT_BALANCE_FIELDS);
  if (brokenAmount) {
    refuseUnprintableAmount(container, printable, brokenAmount);
    return;
  }

  const dateStr = formatDateTime(payment.created_at || new Date().toISOString());
  const paperClass = S.shopSettings.receipt_paper_width === '58mm' ? 'thermal-58mm' : 'thermal-80mm';
  const customerName = customer?.customer_name || payment.customer_name || 'Customer';
  const customerPhone = customer?.customer_phone || '';
  const remainingBal = customer?.total_credit_balance ?? 0;

  // UI Modal Preview
  container.innerHTML = `
    <div class="text-center pb-3 border-b border-slate-800">
      ${brandHeaderHtml()}
      <div class="text-[10px] text-teal-400 mt-1 font-mono font-bold uppercase tracking-wider">CREDIT SETTLEMENT RECEIPT</div>
      <div class="text-[10px] text-slate-500">${escHtml(dateStr)}</div>
    </div>

    <div class="text-[11px] space-y-0.5 py-2 border-b border-slate-800 text-slate-300">
      <div><span class="text-slate-500">Customer:</span> <strong>${escHtml(customerName)}</strong></div>
      ${customerPhone ? `<div><span class="text-slate-500">Phone:</span> ${escHtml(customerPhone)}</div>` : ''}
      <div><span class="text-slate-500">Payment:</span> <span class="uppercase font-bold text-sky-400">${escHtml(payment.payment_method)}</span> ${payment.payment_reference ? `(Ref: ${escHtml(payment.payment_reference)})` : ''}</div>
      ${payment.notes ? `<div><span class="text-slate-500">Notes:</span> ${escHtml(payment.notes)}</div>` : ''}
    </div>

    <div class="py-3 space-y-2 text-xs">
      <div class="flex justify-between items-center text-sm font-bold text-emerald-400 bg-emerald-500/10 p-2 rounded-lg border border-emerald-500/30">
        <span>PAYMENT RECEIVED</span>
        <span class="font-mono text-base">+${fmtMoney(Number(payment.amount_paid))}</span>
      </div>
      <div class="flex justify-between text-slate-300 pt-2 border-t border-slate-800">
        <span>Remaining Balance:</span>
        <span class="font-mono font-bold ${remainingBal > 0.001 ? 'text-rose-400' : 'text-emerald-400'}">
          ${remainingBal > 0.001 ? fmtMoney(Number(remainingBal)) : '₱0.00 (PAID IN FULL)'}
        </span>
      </div>
    </div>

    <div class="pt-2 border-t border-slate-800 text-[10px] text-slate-400 text-center space-y-1">
      <div>*** ${escHtml(S.shopSettings.shop_footer_note || 'Thank you for your payment!')} ***</div>
      <div class="text-[9px] text-slate-500">Official Settlement Acknowledgment Slip</div>
    </div>
  `;

  // Render High-Contrast Thermal Print HTML for @media print
  if (printable) {
    printable.className = `${paperClass} hidden`;
    printable.innerHTML = `
      <div style="text-align: center; margin-bottom: 6px;">
        ${brandHeaderHtml(true)}
        <div style="margin: 4px 0; border-top: 1px dashed #000;"></div>
        <div style="font-size: 13px; font-weight: bold;">SETTLEMENT RECEIPT</div>
        <div style="font-size: 12px;">Date: ${escHtml(dateStr)}</div>
      </div>

      <div style="margin-bottom: 4px; font-size: 12px;">
        <div>Customer: <strong>${escHtml(customerName)}</strong></div>
        ${customerPhone ? `<div>Phone: ${escHtml(customerPhone)}</div>` : ''}
        <div>Payment: ${escHtml(payment.payment_method.toUpperCase())} ${payment.payment_reference ? `(Ref: ${escHtml(payment.payment_reference)})` : ''}</div>
        ${payment.notes ? `<div>Notes: ${escHtml(payment.notes)}</div>` : ''}
      </div>

      <div style="border-top: 1px dashed #000; margin: 6px 0;"></div>

      <div style="font-size: 13px; line-height: 1.5;">
        <div style="display: flex; justify-content: space-between; font-weight: bold; font-size: 15px;">
          <span>Payment received:</span><span>${printMoney(payment.amount_paid)}</span>
        </div>
        <div style="display: flex; justify-content: space-between; font-size: 12px; margin-top: 4px;">
          <span>Remaining balance:</span>
          <span>${remainingBal > 0.001 ? printMoney(remainingBal) : 'P0.00 (PAID IN FULL)'}</span>
        </div>
      </div>

      <div style="border-top: 1px dashed #000; margin-top: 10px; padding-top: 4px; font-size: 11px; text-align: center;">
        <div>*** ${escHtml(S.shopSettings.shop_footer_note || 'Thank you for your payment!')} ***</div>
        <div style="margin-top: 20px; border-top: 1px solid #000; padding-top: 2px; width: 60%; margin-left: auto; margin-right: auto;">
          Cashier / Authorized Signature
        </div>
      </div>
    `;
    applyPrintPageSize();
  }
}

// True while the shop name or GCash number is still the built-in demo value:
// anything printed now carries identity that belongs to nobody.
export function shopIdentityIsPlaceholder() {
  const s = S.shopSettings || {};
  return s.gcash_name === PLACEHOLDER_SHOP.name || s.gcash_number === PLACEHOLDER_SHOP.number;
}

// -------------------------------------------------------------
// NATIVE ESC/POS PRINTING — the server lays the slip out and pushes the bytes
// to the queue named in Settings; the browser print dialog is the fallback,
// never the plan. See src/printer.js and POST /api/print.
// -------------------------------------------------------------
// Ask the server to print. The answer is three-valued and the caller only has to
// branch on one thing: `false` means print the same slip through the browser
// (window.print()), anything truthy means this tab is done.
//   true      the queue took the bytes, paper moved
//   false     the printer or the server failed, so the shop must not be left
//             without a receipt: the caller falls back (docs 2.1, 2.3)
//   'refused' the route deliberately refused THIS slip and no paper is safe for
//             it, so falling back would only retry the refusal on the other sheet
// Which of the last two it is comes from the route's own `fallback` field, not
// from guessing at the HTTP status: every printer fault carries fallback:true,
// while a slip whose amount is not a finite number carries fallback:false, because
// src/printer.js refuses to lay it out and this module's `printMoney` refuses to
// print it on the browser's sheet either. Before this, any non-success fell back,
// so the money guard moved the wrong figure onto browser paper instead of
// stopping.
export async function printSlip(payload) {
  let data;
  try {
    const res = await fetch('/api/print', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    data = await res.json().catch(() => ({}));
    if (res.ok && data.ok) {
      // A deduplicated answer means a duplicate ask inside the dedup window got
      // no paper; unsurfaced, the counter sees a successful reprint and an
      // empty roll.
      if (data.deduplicated) showToast('Nothing printed: this slip was already sent moments ago (duplicate suppressed)', 'info');
      return true;
    }
  } catch (err) {
    showToast(`Printing failed: ${err.message}. Using browser print`, 'warning');
    return false;
  }
  if (data.fallback === false) {
    showToast(data.error || 'The receipt was refused: this slip carries an amount that is not a number, so no paper is safe for it.', 'error');
    return 'refused';
  }
  showToast(data.error || 'The printer refused the job, using browser print', 'warning');
  return false;
}

// The automatic send after a sale or settlement. It shares the modal button's
// in-flight flag (a click during the automatic send must not double-print) and
// re-renders the fallback slip first: while the send is open the modal can
// already show a NEWER sale, and window.print() would put that one on paper.
export async function autoPrintSlip(payload, renderFallback) {
  if (modalPrintInFlight) return false;
  modalPrintInFlight = true;
  let fellBack = false;
  try {
    if (!(await printSlip(payload))) {
      fellBack = true;
      if (renderFallback) renderFallback();
      window.print();
    }
  } finally {
    modalPrintInFlight = false;
  }
  return fellBack;
}

// The receipt modal's Print button: ask the queue for exactly the slip on
// screen, with the browser dialog behind it. Two rules the button did not have
// before, both inherited from the sale-side triggers that already enforce them:
// a slip with no declared payload prints through the browser (the Z-report and
// period summary stay on that path by design), and placeholder shop identity
// stops paper entirely -- a deliberate click was the one path that still let a
// receipt carrying the demo shop name reach the roll.
export async function printModalSlip() {
  if (modalPrintInFlight) return;
  const slip = getModalSlip();
  if (!slip) { window.print(); return; }
  if (shopIdentityIsPlaceholder()) {
    showToast('Receipt not printed: shop identity is still the placeholder. Save real shop details in Settings, then reprint.', 'error');
    return;
  }
  // The flag is the guard; the disabled attribute is the same answer given where
  // the cashier is looking, so a second click has nothing to press while the
  // first send is still open. Both are released in the finally, because the send
  // can leave this function three ways: the queue took it, the queue failed and
  // the dialog printed, or the ask threw on the way out. Any of the three has to
  // hand the button back, or a receipt that never reached paper leaves the modal
  // with a dead control.
  const button = document.querySelector(MODAL_PRINT_BUTTON);
  modalPrintInFlight = true;
  if (button) button.disabled = true;
  try {
    // A manual print from this modal is a reprint, whatever the job: the sale
    // (or collection) already rang the drawer when it happened, so the slip's
    // bytes must not carry a second kick.
    if (!(await printSlip({ ...slip, drawer_kick: false }))) window.print();
  } finally {
    if (button) button.disabled = false;
    modalPrintInFlight = false;
  }
}

export async function reprintLastReceipt() {
  if (!S.lastSaleForReprint) {
    showToast('No receipt yet — complete a sale first', 'warning');
    return;
  }
  if (shopIdentityIsPlaceholder()) {
    showToast('Receipt not printed: shop identity is still the placeholder. Save real shop details in Settings, then reprint.', 'error');
    return;
  }
  // The modal keeps the on-screen receipt either way, and #printable-receipt is
  // filled before the ask, so the browser fallback below still has content.
  // Same flag as the modal button: a double click here is two jobs and two
  // audit rows for one sale.
  if (modalPrintInFlight) return;
  modalPrintInFlight = true;
  try {
    renderReceipt(S.lastSaleForReprint);
    // drawer_kick:false — a reprint is not a sale. The route's default kicks
    // the drawer for job 'sale', which made every reprint pulse it.
    if (!(await printSlip({ kind: 'sale', sale_id: S.lastSaleForReprint.id, drawer_kick: false }))) window.print();
  } finally {
    modalPrintInFlight = false;
  }
}

// A no-sale slip for the Settings → Printing "Print test receipt" button:
// confirms the printer feeds and the roll width matches without ringing up a
// sale first. Prints regardless of the placeholder-identity guard — a test
// slip with placeholder text is the point of a test.
export async function printTestReceipt() {
  const printable = document.getElementById('printable-receipt');
  if (!printable) return;
  const paperClass = S.shopSettings.receipt_paper_width === '58mm' ? 'thermal-58mm' : 'thermal-80mm';
  printable.className = `${paperClass} hidden`;
  // Every line below is a ruler: the first and last columns are marked and the
  // digit row counts up, so a clipped right edge or a line that wraps one
  // column early is visible without a tape measure.
  const cols = Math.floor(printableWidthMm() / 1.5);
  const ruler = Array.from({ length: cols }, (_, i) => (i + 1) % 10).join('');
  const edges = `<${'-'.repeat(Math.max(cols - 2, 1))}>`;
  printable.innerHTML = `
    <div style="text-align: center;">
      ${brandHeaderHtml(true)}
      <div class="rcp-rule"></div>
      <div style="font-weight: bold;">TEST RECEIPT</div>
      <div>${escHtml(formatDateTime(new Date().toISOString()))}</div>
      <div>${escHtml(`Roll ${paperWidthMm()}mm / Print ${printableWidthMm()}mm / ${cols} cols`)}</div>
    </div>
    <div class="rcp-rule"></div>
    <div>${escHtml(edges)}</div>
    <div>${ruler}</div>
    <div>ABCDEFGHIJKLMNOPQRSTUVWXYZ</div>
    <div>0123456789</div>
    <div style="display: flex; justify-content: space-between;"><span>Sample row:</span><span>P1,234.56</span></div>
    <div>${ruler}</div>
    <div>${escHtml(edges)}</div>
    <div class="rcp-rule"></div>
    <div style="text-align: center;">
      <div>If both ruler lines are unbroken and every line ends at the same</div>
      <div>edge, the feed and the roll setting both match.</div>
      <div style="margin-top: 2mm;">*** Test only, not a receipt ***</div>
    </div>`;
  applyPrintPageSize();
  // The printable copy above still drives the browser fallback and the on-screen
  // text, so it stays even now the queue gets ESC/POS bytes. If the server could
  // not print, window.print() has the same slip ready.
  if (!(await printSlip({ kind: 'test' }))) window.print();
}

// -------------------------------------------------------------
// END-OF-DAY (Z) REPORT — rides the same thermal print machinery
// -------------------------------------------------------------
// A human signs the Z-report, so a wrong-shaped payload must refuse instead
// of printing a quiet all-zero day. /api/dashboard?period=day serves the
// period shape (stats.current + stats.standing); the flat fallback keeps the
// legacy today_* keys working.
const Z_REQUIRED_KEYS = [
  'revenue', 'parts_revenue', 'labor_revenue', 'sale_count', 'gross_profit',
  'cash_collected', 'gcash_collected', 'transfer_collected',
  'credit_settled', 'warranty_returns', 'refunded_total', 'expenses_total'
];
const Z_REQUIRED_STANDING_KEYS = [
  'total_credit_outstanding', 'total_debtors_count',
  'total_inventory_retail_value', 'total_parts_stock'
];

export async function printZReport() {
  try {
    if (shopIdentityIsPlaceholder()) {
      throw new Error('Shop identity is still the placeholder. Save real shop details in Settings before printing reports.');
    }
    const res = await fetch('/api/dashboard?period=day');
    if (!res.ok) throw new Error('Reports unavailable');
    const stats = await res.json();
    const c = stats.current || stats;
    const st = stats.standing || stats;
    const missing = [
      ...Z_REQUIRED_KEYS.filter(k => !Number.isFinite(Number(c?.[k]))),
      ...Z_REQUIRED_STANDING_KEYS.filter(k => !Number.isFinite(Number(st?.[k])))
    ];
    if (missing.length) {
      throw new Error(`Report data is incomplete (missing ${missing.slice(0, 3).join(', ')}). Reload the page and try again.`);
    }
    renderZReport(stats);
    window.print();
  } catch (err) {
    showToast(`Error printing report: ${err.message}`, 'error');
  }
}

export function renderZReport(stats) {
  const printable = document.getElementById('printable-receipt');
  if (!printable) return;
  // /api/dashboard serves the period shape; tolerate the legacy flat shape.
  const c = stats.current || stats;
  const st = stats.standing || stats;
  const paperClass = S.shopSettings.receipt_paper_width === '58mm' ? 'thermal-58mm' : 'thermal-80mm';
  printable.className = `${paperClass} hidden`;

  const moneyRow = (l, v) => `<div style="display:flex;justify-content:space-between;"><span>${l}:</span><span>P${Number(v || 0).toFixed(2)}</span></div>`;
  const countRow = (l, v) => `<div style="display:flex;justify-content:space-between;"><span>${l}:</span><span>${Number(v || 0)}</span></div>`;
  const now = new Date();
  printable.innerHTML = `
    <div style="text-align:center;">
      <div style="font-size:16px;font-weight:bold;text-transform:uppercase;">${escHtml(S.shopSettings.gcash_name || 'TECHPARTS POS')}</div>
      <div style="font-size:13px;font-weight:bold;margin-top:2px;">END-OF-DAY REPORT (Z)</div>
      <div style="font-size:12px;">${escHtml(formatDateTime(now.toISOString()))}</div>
    </div>
    <div style="border-top:1px dashed #000;margin:4px 0;"></div>
    <div style="font-size:13px;line-height:1.5;">
      <div style="font-weight:bold;">SALES</div>
      ${moneyRow('Revenue', c.revenue ?? c.today_sales_revenue)}
      ${moneyRow('Parts', c.parts_revenue ?? c.today_parts_revenue)}
      ${moneyRow('Labor', c.labor_revenue ?? c.today_labor_revenue)}
      ${countRow('Sales completed', c.sale_count ?? c.today_sales_count)}
      ${moneyRow('Gross profit', c.gross_profit ?? c.today_sales_profit)}
      ${moneyRow('Operating expenses', c.expenses_total ?? c.today_expenses)}
      ${moneyRow('Net after refunds & expenses', c.net_profit ?? c.today_sales_profit)}
      <div style="border-top:1px dashed #000;margin:3px 0;"></div>
      <div style="font-weight:bold;">COLLECTIONS</div>
      ${moneyRow('Cash', c.cash_collected ?? c.today_cash_collected)}
      ${moneyRow('GCash', c.gcash_collected ?? c.today_gcash_collected)}
      ${moneyRow('Bank transfer', c.transfer_collected ?? c.today_transfer_collected)}
      ${moneyRow('Utang settled', c.credit_settled ?? c.today_credit_settled)}
      <div style="display:flex;justify-content:space-between;"><span>Returns:</span><span>${Number(c.warranty_returns ?? c.today_warranty_returns ?? 0)} claims, P${Number(c.refunded_total ?? c.today_refunded_total ?? 0).toFixed(2)}</span></div>
      <div style="border-top:1px dashed #000;margin:3px 0;"></div>
      <div style="font-weight:bold;">STANDING</div>
      ${moneyRow('Credit outstanding', st.total_credit_outstanding)}
      <div style="display:flex;justify-content:space-between;"><span>Active debtors:</span><span>${Number(st.total_debtors_count || 0)}</span></div>
      ${moneyRow('Inventory value', st.total_inventory_retail_value)}
      <div style="display:flex;justify-content:space-between;"><span>Parts in stock:</span><span>${Number(st.total_parts_stock || 0)}</span></div>
    </div>
    <div style="border-top:1px dashed #000;margin-top:6px;padding-top:3px;font-size:11px;text-align:center;">
      *** End of day close-out ***<br>Generated by ${escHtml(S.shopSettings.gcash_name || 'TechParts POS')}
    </div>`;
  applyPrintPageSize();
}

// -------------------------------------------------------------
// PERIOD SUMMARY — the Reports & profit tab's print button. Same thermal
// canvas as the Z-report, but for whichever window the dashboard shows.
// -------------------------------------------------------------
export function printPeriodSummary(stats) {
  if (shopIdentityIsPlaceholder()) {
    showToast('Report not printed: shop identity is still the placeholder. Save real shop details in Settings.', 'error');
    return;
  }
  renderPeriodSummary(stats);
  window.print();
}

export function renderPeriodSummary(s) {
  const printable = document.getElementById('printable-receipt');
  if (!printable) return;
  const c = s.current || {};
  const st = s.standing || {};
  const paperClass = S.shopSettings.receipt_paper_width === '58mm' ? 'thermal-58mm' : 'thermal-80mm';
  printable.className = `${paperClass} hidden`;

  const moneyRow = (l, v) => `<div style="display:flex;justify-content:space-between;"><span>${l}:</span><span>P${Number(v || 0).toFixed(2)}</span></div>`;
  const countRow = (l, v) => `<div style="display:flex;justify-content:space-between;"><span>${l}:</span><span>${Number(v || 0)}</span></div>`;
  const fday = d => new Date(d + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const fdayY = d => new Date(d + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const names = { day: 'DAILY', '3d': '3-DAY', '7d': 'WEEKLY', '30d': 'MONTHLY', '365d': 'YEARLY', custom: 'CUSTOM' };
  const span = s.period === 'day' ? fday(s.range.to)
    : s.period === '365d' ? `${fdayY(s.range.from)} - ${fdayY(s.range.to)}`
    : `${fday(s.range.from)} - ${fday(s.range.to)}`;

  const tops = ((s.products || {}).products || []).slice(0, 5);
  const dead = s.dead_stock || [];
  const deadCapital = dead.reduce((a, r) => a + Number(r.tied_up_capital || 0), 0);

  printable.innerHTML = `
    <div style="text-align:center;">
      <div style="font-size:16px;font-weight:bold;text-transform:uppercase;">${escHtml(S.shopSettings.gcash_name || 'TECHPARTS POS')}</div>
      <div style="font-size:13px;font-weight:bold;margin-top:2px;">${names[s.period] || 'PERIOD'} REPORT</div>
      <div style="font-size:12px;">${span}</div>
      <div style="font-size:12px;">Printed ${escHtml(formatDateTime(new Date().toISOString()))}</div>
    </div>
    <div style="border-top:1px dashed #000;margin:4px 0;"></div>
    <div style="font-size:13px;line-height:1.5;">
      <div style="font-weight:bold;">SALES</div>
      ${moneyRow('Revenue', c.revenue)}
      ${moneyRow('Parts', c.parts_revenue)}
      ${moneyRow('Labor', c.labor_revenue)}
      ${countRow('Sales completed', c.sale_count)}
      ${moneyRow('Average ticket', c.avg_ticket)}
      ${moneyRow('Gross profit', c.gross_profit)}
      ${moneyRow('Operating expenses', c.expenses_total)}
      ${moneyRow('Net after refunds & expenses', c.net_profit)}
      <div style="border-top:1px dashed #000;margin:3px 0;"></div>
      <div style="font-weight:bold;">COLLECTIONS</div>
      ${moneyRow('Cash', c.cash_collected)}
      ${moneyRow('GCash', c.gcash_collected)}
      ${moneyRow('Bank transfer', c.transfer_collected)}
      ${moneyRow('Utang settled', c.credit_settled)}
      ${moneyRow('Collected total', c.collected_total)}
      ${tops.length ? `<div style="border-top:1px dashed #000;margin:3px 0;"></div>
      <div style="font-weight:bold;">TOP PARTS</div>
      ${tops.map((p, i) => `<div style="display:flex;justify-content:space-between;"><span>${i + 1}. ${escHtml(String(p.item_name || 'Part').slice(0, 26))}</span><span>${Number(p.units || 0)}u P${Number(p.revenue || 0).toFixed(2)}</span></div>`).join('')}` : ''}
      <div style="border-top:1px dashed #000;margin:3px 0;"></div>
      <div style="font-weight:bold;">SHELF &amp; UTANG</div>
      <div style="display:flex;justify-content:space-between;"><span>Dead stock:</span><span>${dead.length} lines, P${deadCapital.toFixed(2)} tied up</span></div>
      ${moneyRow('Credit outstanding', st.total_credit_outstanding)}
      ${moneyRow('Inventory value', st.total_inventory_retail_value)}
    </div>
    <div style="border-top:1px dashed #000;margin-top:6px;padding-top:3px;font-size:11px;text-align:center;">
      *** Period summary ***<br>Generated by ${escHtml(S.shopSettings.gcash_name || 'TechParts POS')}
    </div>`;
  applyPrintPageSize();
}

// Browser fallback for the pickup-ready notice: same field order as
// renderPickupReadySlip in src/printer.js, money-free on purpose.
export function renderPickupReadyNotice(ticket) {
  const printable = document.getElementById('printable-receipt');
  if (!printable) return;
  const paperClass = S.shopSettings.receipt_paper_width === '58mm' ? 'thermal-58mm' : 'thermal-80mm';
  printable.className = `${paperClass} hidden`;
  printable.innerHTML = `
    <div style="text-align:center;">
      ${brandHeaderHtml(true)}
      <div class="rcp-rule"></div>
      <div style="font-size:14px;font-weight:bold;">READY FOR PICKUP</div>
      <div style="font-size:12px;font-weight:bold;">Ref: ${escHtml(ticket.ref_code || '')}</div>
      <div style="font-size:11px;">${escHtml(formatDateTime(ticket.updated_at || new Date().toISOString()))}</div>
    </div>
    <div class="rcp-rule"></div>
    <div style="font-size:12px;line-height:1.45;">
      <div><strong>Customer:</strong> ${escHtml(ticket.customer_name || 'Walk-in Customer')}</div>
      ${ticket.customer_phone ? `<div><strong>Phone:</strong> ${escHtml(ticket.customer_phone)}</div>` : ''}
      ${ticket.device ? `<div><strong>Device:</strong> ${escHtml(ticket.device)}</div>` : ''}
      ${ticket.imei ? `<div><strong>IMEI/SN:</strong> ${escHtml(ticket.imei)}</div>` : ''}
      ${ticket.issue_note ? `<div><strong>Job Note:</strong> ${escHtml(ticket.issue_note)}</div>` : ''}
    </div>
    <div class="rcp-rule"></div>
    <div style="font-size:12px;line-height:1.45;text-align:center;">
      Your unit is repaired and ready for pickup.<br>
      Please present this notice and settle any balance at the counter.
    </div>`;
}

export function renderClaimStub(job) {
  const printable = document.getElementById('printable-receipt');
  if (!printable) return;
  const paperClass = S.shopSettings.receipt_paper_width === '58mm' ? 'thermal-58mm' : 'thermal-80mm';
  printable.className = `${paperClass} hidden`;
  const lines = Array.isArray(job.items) ? job.items : [];
  const itemsHtml = lines.map(it => {
    const qty = Number(it.qty || 1);
    const unit = Number(it.unit_price || 0);
    // Round the unit*qty PRODUCT to cents (half away from zero), exactly like
    // cartTotals() and src/money.js, so the stub line sums to the stub total.
    const product = unit * qty;
    const [coef, exp = '0'] = String(Math.abs(product)).split('e');
    const total = Math.sign(product) * Math.round(Number(`${coef}e${Number(exp) + 2}`)) / 100;
    // Stub rows go through printMoney like every other slip: same grouping,
    // and a broken total refuses to print instead of rendering P0.00.
    return `<div style="display:flex;justify-content:space-between;padding:1px 0;">
      <span>${qty}x ${escHtml(it.name || `${it.brand || ''} ${it.model_name || ''} ${it.part_type || ''}`.trim())}</span>
      <span>${printMoney(total)}</span>
    </div>`;
  }).join('');

  printable.innerHTML = `
    <div style="text-align:center;">
      ${brandHeaderHtml(true)}
      <div class="rcp-rule"></div>
      <div style="font-size:13px;font-weight:bold;">REPAIR CLAIM STUB</div>
      <div style="font-size:12px;font-weight:bold;">Ref: ${escHtml(job.ref || '')}</div>
      <div style="font-size:11px;">${escHtml(formatDateTime(new Date().toISOString()))}</div>
    </div>
    <div class="rcp-rule"></div>
    <div style="font-size:12px;line-height:1.45;">
      <div><strong>Customer:</strong> ${escHtml(job.customer || 'Walk-in Customer')}</div>
      ${job.phone ? `<div><strong>Phone:</strong> ${escHtml(job.phone)}</div>` : ''}
      ${job.device ? `<div><strong>Device:</strong> ${escHtml(job.device)}</div>` : ''}
      ${job.imei ? `<div><strong>IMEI/SN:</strong> ${escHtml(job.imei)}</div>` : ''}
      ${job.note ? `<div><strong>Job Note:</strong> ${escHtml(job.note)}</div>` : ''}
    </div>
    ${lines.length ? `
      <div class="rcp-rule"></div>
      <div style="font-size:12px;line-height:1.4;">
        <div style="font-weight:bold;">ESTIMATED ITEMS</div>
        ${itemsHtml}
        ${Number(job.discount) > 0 ? `<div style="display:flex;justify-content:space-between;"><span>Discount:</span><span>-${printMoney(job.discount)}</span></div>` : ''}
        <div style="display:flex;justify-content:space-between;font-weight:bold;margin-top:2px;">
          <span>Estimated Total:</span><span>${printMoney(job.total)}</span>
        </div>
      </div>` : ''}
    <div class="rcp-rule"></div>
    <div style="font-size:11px;text-align:center;line-height:1.35;">
      Present this stub when claiming your unit.<br>
      *** Claim stub only, not an official receipt ***
    </div>`;
  applyPrintPageSize();
}
