// phone-repair-pos/src/printer.js
// ESC/POS counter printing. Layout is pure and byte output is isolated so both
// can be tested with no printer attached.
const COLUMNS_BY_ROLL = { '58mm': 32, '80mm': 48 };

function colsFor(paperWidth) {
  return COLUMNS_BY_ROLL[paperWidth] || COLUMNS_BY_ROLL['80mm'];
}

// Thermal clones disagree about high-bit code pages, so anything outside
// printable ASCII is dropped rather than risked as mojibake.
function plain(value) {
  return String(value ?? '').replace(/[^\x20-\x7e]/g, '');
}

// Shop time, always. The audit rows and SQLite store UTC, so a slice of
// toISOString() prints a receipt eight hours behind the counter clock and can
// push a warranty expiry onto the wrong day. src/reconcile.js documents the
// same trap.
function localStamp(value) {
  const d = value ? new Date(value) : new Date();
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function localDate(value) {
  return localStamp(value).slice(0, 10);
}

// Word-aware: a word that fits a line of its own is never split. Only a single
// word wider than the roll is hard-broken, which is what the while loop is for.
function wrap(value, cols) {
  const lines = [];
  let line = '';
  for (const word of plain(value).split(/\s+/).filter(Boolean)) {
    if (line && `${line} ${word}`.length > cols) {
      lines.push(line);
      line = '';
    }
    line = line ? `${line} ${word}` : word;
    while (line.length > cols) {
      lines.push(line.slice(0, cols));
      line = line.slice(cols);
    }
  }
  if (line) lines.push(line);
  return lines;
}

function row(label, value, cols) {
  const right = plain(value);
  if (right.length >= cols) return right.slice(0, cols);
  const head = plain(label).slice(0, Math.max(1, cols - right.length - 1));
  return head + ' '.repeat(cols - head.length - right.length) + right;
}

// For a label the paper must keep. row() right-aligns and pays for the value by
// trading the label away: at 58mm a 32-character customer name printed with no
// label at all and a 36-character one came out as "C Juan Dela Cruz Dela Cruz
// Dela", the name cut mid-word with no ellipsis. #pos-customer-name has no
// maxlength and src/sales.js str() imposes no cap, so this is one normal sale
// away, and the screen wraps the whole name while the receipt loses it.
// While label plus value still fit, the exact-width row() padding is preserved
// untouched (money columns and every other caller depend on it); past that the
// pair flows together as wrapped text, the way the device line below already
// does.
function labelled(label, value, cols) {
  const head = plain(label).trim();
  const body = plain(value).trim();
  if (`${head} ${body}`.length <= cols) return [row(head, body, cols)];
  return wrap(`${head} ${body}`, cols);
}

function rule(cols) {
  return '-'.repeat(cols);
}

// plain() can empty a name made entirely of unsupported characters, which would
// print a blank header instead of falling back.
function nameLines(value, budget) {
  const lines = wrap(value || '', budget);
  return lines.length ? lines : wrap('TECHPARTS POS', budget);
}

function ruler(cols) {
  return Array.from({ length: cols }, (_, i) => (i + 1) % 10).join('');
}

const DRAWER_KICK = [0x1b, 0x70, 0x00, 0x19, 0xfa, 0x1b, 0x70, 0x01, 0x19, 0xfa];

function encode(lines, { drawerKick = false } = {}) {
  const out = [0x1b, 0x40]; // ESC @ initialize
  if (drawerKick) out.push(...DRAWER_KICK); // ESC p pulse pins 2 & 5 (50ms on, 500ms off) to open cash drawer
  for (const line of lines) {
    if (line.centered) out.push(0x1b, 0x61, 0x01);
    if (line.wide) out.push(0x1d, 0x21, 0x11); // GS ! double width + height
    out.push(...Buffer.from(plain(line.text), 'ascii'), 0x0a);
    if (line.wide) out.push(0x1d, 0x21, 0x00);
    if (line.centered) out.push(0x1b, 0x61, 0x00);
  }
  out.push(0x1b, 0x64, 0x03); // ESC d 3 print and feed
  return Buffer.from(out);
}

function renderTestSlip(settings) {
  const cols = colsFor(settings.receipt_paper_width);
  const slip = [];
  const push = (text, opts) => slip.push({ text, ...opts });
  for (const line of nameLines(settings.gcash_name, Math.floor(cols / 2))) {
    push(line, { wide: true, centered: true });
  }
  push('TEST RECEIPT', { centered: true });
  push(localStamp());
  push(rule(cols));
  push('<' + '-'.repeat(cols - 2) + '>');
  push(ruler(cols));
  push('ABCDEFGHIJKLMNOPQRSTUVWXYZ012345'.slice(0, cols));
  push(row('Sample row:', 'P1,234.56', cols));
  push(ruler(cols));
  push('<' + '-'.repeat(cols - 2) + '>');
  push(rule(cols));
  for (const line of wrap('If both ruler lines touch both edges, the width matches the roll.', cols)) push(line);
  push('*** Test only, not a receipt ***', { centered: true });
  return slip;
}

// The same digits fmtMoney in public/js/ui.js puts on screen, with a plain P:
// plain() strips the ₱ sign as a high-bit character and thermal clones
// disagree about the code page, so paper says P2,700.00 and never mojibake.
//
// An amount that does not read as a number is refused, not printed. Before this
// guard a string amount reached the customer as `PNaN`, and an actual NaN read
// as `P0.00`, which a counter would take for a paid-off bill. Every stored
// amount here has already been through src/money.js, which throws the same way,
// so reaching this line means the row is broken; src/money.js:8 throws 'Money
// amount must be a finite number', which this copy echoes. Throwing refuses the
// whole slip while it is still being laid out, before encode() runs, so the
// queue gets no bytes at all, the route answers 400 with the reason, and the
// cashier reads it instead of handing out wrong paper. An absent field stays
// P0.00, like the screen's fmtMoney, because a slip with no change row is a
// normal print and not a broken number.
function money(n) {
  if (n === undefined || n === null || n === '') return 'P0.00';
  const value = Number(n);
  if (!Number.isFinite(value)) {
    const err = new Error('Money amount must be a finite number, so the slip was not printed');
    // The route reads this flag to answer fallback:false. A printer that refused,
    // a queue that could not be opened or a server fault must still send the tab
    // to the browser path, because a shop is never allowed to be without a
    // receipt; a slip whose amount is not a number is the one case where the
    // other paper is not a rescue, since printMoney() in public/js/receipts.js
    // throws the same refusal for the same figure. Without the flag both guards
    // would look like printer faults and the refused figure would come back out
    // of the browser instead.
    err.amountRefusal = true;
    throw err;
  }
  return 'P' + value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Read the flag the throw above sets, on either side of the route.
function isAmountRefusal(err) {
  return Boolean(err && err.amountRefusal);
}

// The sales schema has no column for the repaired unit, its IMEI or the job
// note, so public/js/views/pos.js rides them along as a single zero-price
// labour line whose name is this marker plus the details. The HTML receipt
// (public/js/receipts.js) lifts that line out of the billables and prints it as
// `Unit:` with the intake details; paper has to do exactly the same or the
// customer is handed a receipt that contradicts the one on screen: an invented
// `[LABOR] <prefix>IMEI... 1 x P0.00 P0.00` row and no device line at all.
//
// This literal is the browser's, duplicated on purpose, and
// tests/printer.test.js pins it against public/js/views/pos.js so renaming one
// half fails loudly instead of silently splitting the two renderers.
const DEVICE_LINE_PREFIX = 'DEVICE · ';

function splitDeviceLine(sale) {
  const allItems = sale.items || [];
  const deviceItem = allItems.find((it) => it.item_type === 'labor'
    && Number(it.unit_price) === 0
    && String(it.item_name || '').startsWith(DEVICE_LINE_PREFIX));
  return {
    deviceText: deviceItem ? String(deviceItem.item_name).slice(DEVICE_LINE_PREFIX.length) : '',
    billable: allItems.filter((it) => it !== deviceItem),
  };
}

// ---- Sale receipt templates ------------------------------------------------
// Five templates (Settings > Printing), sales receipt only. Content law: every
// template carries the same money rows, the utang balance, itemized returns,
// the credit signature block and the warranty expiry; 'OFFICIAL RECEIPT' stays
// on every template because it names the document. Trimmed templates (compact,
// airy, grid) drop the shop address and Tel/GCash lines and the warranty
// policy paragraph; airy and grid keep the footer note, compact drops it.

function itemRowMode(settings) {
  return ['auto', 'two_line', 'one_line'].includes(settings.receipt_item_rows) ? settings.receipt_item_rows : 'auto';
}

// One line per item: "2x Tempered glass (Poco X6) ... P300.00". The name pays
// for the width, cut with '...' so the money column stays exact-width.
function saleItemOneLine(item, cols) {
  const right = money(item.total_price);
  const text = `${item.quantity}x ${item.item_type === 'labor' ? '[LABOR] ' : ''}${plain(item.item_name)}`;
  const budget = cols - right.length - 1;
  const left = text.length > budget ? `${text.slice(0, Math.max(1, budget - 3))}...` : text;
  return row(left, right, cols);
}

// Item row styles: two_line is the original layout (name wrapped over a
// "qty x unit ... amount" line); one_line trades the name for paper; auto
// prints one line when the whole row fits and falls back to two_line when it
// does not, so a long part name wraps instead of truncating.
function saleItemLines(item, cols, mode) {
  if (mode === 'two_line') {
    const name = wrap(`${item.item_type === 'labor' ? '[LABOR] ' : ''}${item.item_name}`, cols)
      .map((text) => ({ text }));
    return [...name, { text: row(`  ${item.quantity} x ${money(item.unit_price)}`, money(item.total_price), cols) }];
  }
  const right = money(item.total_price);
  const text = `${item.quantity}x ${item.item_type === 'labor' ? '[LABOR] ' : ''}${plain(item.item_name)}`;
  if (mode === 'one_line' || text.length + right.length + 1 <= cols) {
    return [{ text: saleItemOneLine(item, cols) }];
  }
  return saleItemLines(item, cols, 'two_line');
}

// Grid items: qty / name / amount columns at any width. The name budget comes
// off the actual amount width, long names truncate on the first line and wrap
// on continuation lines, so nothing ever exceeds the roll.
function saleGridItemLines(billable, cols) {
  const out = ['QTY ITEM'.padEnd(cols - 10) + 'AMOUNT'.padStart(10)];
  billable.forEach((item, i) => {
    const right = money(item.total_price);
    const nameBudget = cols - 3 - 1 - right.length - 1;
    const name = `${item.item_type === 'labor' ? '[LABOR] ' : ''}${plain(item.item_name)}`;
    out.push(row(`${String(item.quantity).padStart(2)} ${name.slice(0, nameBudget)}`, right, cols));
    if (name.length > nameBudget) {
      for (const cont of wrap(name.slice(nameBudget), nameBudget)) out.push(`   ${cont}`);
    }
    if (i < billable.length - 1) out.push('');
  });
  return out;
}

function saleTotalsRows(sale, cols) {
  const out = [];
  out.push({ text: row('Subtotal:', money(sale.subtotal), cols) });
  if (Number(sale.discount) > 0) out.push({ text: row('Discount:', '-' + money(sale.discount), cols) });
  return out;
}

function salePaidRows(sale, cols) {
  const out = [];
  out.push({ text: row('Amount Paid:', money(sale.amount_paid), cols) });
  if (Number(sale.change_amount) > 0) out.push({ text: row('CHANGE:', money(sale.change_amount), cols) });
  // labelled(), not row(): this is the row that introduces the credit signature
  // block below it. row() still right-aligns short balances to the exact-width
  // money column, but a balance long enough to crowd the roll would trade away
  // the 'BALANCE (UTANG):' label, and a signed debt that prints without naming
  // itself is the one line the acknowledgement is signing up to.
  if (Number(sale.credit_balance) > 0) {
    for (const line of labelled('BALANCE (UTANG):', money(sale.credit_balance), cols)) out.push({ text: line });
  }
  return out;
}

// Returns/refunds, itemized on paper exactly as the on-screen receipt and its
// printable copy show them (public/js/receipts.js): the modal listed each RMA
// while the paper carried nothing (ESC/POS) or one aggregate line (browser),
// so the customer's slip and the counter's screen disagreed about what was
// returned. A replacement contributes no money and says so. Rule placement
// belongs to the template; only the rows live here. Only appended when the
// sale actually has returns, so a normal receipt's layout is untouched.
function saleReturnsRows(sale, cols) {
  const saleReturns = sale.returns || [];
  if (!saleReturns.length) return [];
  const out = [];
  for (const line of wrap(`RETURNS / REFUNDS (${saleReturns.length}):`, cols)) out.push({ text: line });
  for (const r of saleReturns) {
    for (const name of wrap(`  ${plain(r.return_code)} ${r.quantity || 1}x ${plain(r.item_name)}`, cols)) out.push({ text: name });
    // Never throws mid-layout: a row whose refund_amount is not a finite
    // number prints as a replacement rather than refusing the whole slip.
    const amt = Number(r.refund_amount);
    out.push({ text: row('  ', Number.isFinite(amt) && amt > 0 ? '-' + money(amt) : 'Replacement', cols) });
  }
  if (Number(sale.refunded_amount) > 0) out.push({ text: row('REFUNDED:', '-' + money(sale.refunded_amount), cols) });
  return out;
}

// A credit sale is signed on paper, not just on screen. The HTML receipt
// (public/js/receipts.js) carries an acknowledgement block with a signature
// line under the balance; a customer who walks out with utang has to be
// handed the same promise in ink. Compact on purpose: title, one sentence
// naming the balance, a rule to sign on, and who signs it.
function saleCreditAckRows(sale, cols) {
  if (Number(sale.credit_balance) <= 0) return [];
  const credit = money(sale.credit_balance);
  const out = [];
  for (const line of wrap('CREDIT / UTANG ACKNOWLEDGEMENT', cols)) out.push({ text: line, centered: true });
  for (const line of wrap(`I acknowledge receipt of the goods above and agree to pay the balance of ${credit}.`, cols)) out.push({ text: line });
  out.push({ text: '_'.repeat(Math.min(cols, 24)), centered: true });
  out.push({ text: 'Customer Signature', centered: true });
  return out;
}

// The one warranty rule (see warrantyDays below), on every template: the days
// the shop set (or seven), and the date-only shop-local expiry. Wrapped like
// every other line, because a hand-edited `warranty_days` of "99999999999999999999"
// used to put a 51-character line on a 32-column roll.
function saleWarrantyRows(sale, settings, cols, { withPolicy = true } = {}) {
  const warranty = warrantyDays(settings.warranty_days);
  const expiry = calculateWarrantyExpiry(sale.created_at, settings.warranty_days);
  const out = [];
  if (withPolicy) {
    for (const line of wrap(`WARRANTY (${warranty} DAYS):`, cols)) out.push({ text: line, centered: true });
    for (const line of wrap(settings.warranty_policy_text, cols)) out.push({ text: line });
    out.push({ text: `Valid Until: ${expiry}` });
  } else {
    for (const line of labelled('Warranty:', `${warranty} day(s), valid until ${expiry}`, cols)) out.push({ text: line });
  }
  return out;
}

// Framed as `*** note ***`, which is what public/js/receipts.js puts under the
// same setting on screen: the frame belongs to the renderer, so the shop types
// plain words in Settings and both documents show the same last line. Wrapped,
// not pushed whole: the framed default is 35 characters and a 58mm roll has 32.
function saleFooterRows(settings, cols) {
  return wrap(`*** ${plain(settings.shop_footer_note || 'Thank you for your business!')} ***`, cols)
    .map((line) => ({ text: line, centered: true }));
}

function defaultShopSubtitle(settings = {}) {
  const type = settings.business_type || 'hybrid';
  if (type === 'grocery') return 'Grocery & General Merchandise';
  if (type === 'pc') return 'PC & Electronics Sales & Services';
  if (type === 'retail') return 'Retail & General Merchandise';
  if (type === 'hybrid') return 'Sales & Repair Services';
  return 'Phone Parts, LCDs & Repair Service';
}

function saleShopNameRows(settings, cols) {
  return nameLines(settings.gcash_name, Math.floor(cols / 2)).map((line) => ({ text: line, wide: true, centered: true }));
}

// Trimmed header shared by compact, airy and grid: shop name, document title,
// invoice, date with the payment method. The address and Tel/GCash lines are
// the parts a trimmed template exists to drop.
function saleHeaderTrimmedRows(sale, settings, cols) {
  const pay = String(sale.payment_method || '').toUpperCase();
  const out = saleShopNameRows(settings, cols);
  out.push({ text: 'OFFICIAL RECEIPT', centered: true });
  // Wrapped, not pushed whole: a sale code is server-generated today, but the
  // invariant is that no emitted line exceeds the roll.
  for (const line of wrap(`Invoice #: ${sale.sale_code}`, cols)) out.push({ text: line });
  for (const line of wrap(`${localStamp(sale.created_at)}${pay ? ` / ${pay}` : ''}`, cols)) out.push({ text: line });
  return out;
}

// Customer / phone / unit / payment intake block, labels kept via labelled()
// for the same reason as the standard template: both fields are free text with
// no upstream cap, and the label must survive whatever the customer typed.
function saleInfoRows(sale, cols) {
  const { deviceText } = splitDeviceLine(sale);
  const out = [];
  for (const line of labelled('Customer:', sale.customer_name, cols)) out.push({ text: line });
  if (sale.customer_phone) {
    for (const line of labelled('Phone:', sale.customer_phone, cols)) out.push({ text: line });
  }
  if (deviceText) for (const line of wrap(`Unit: ${deviceText}`, cols)) out.push({ text: line });
  const paymentText = `${String(sale.payment_method || '').toUpperCase()} ${(sale.payment_reference || '').trim()}`.trim();
  for (const line of labelled('Payment:', paymentText, cols)) out.push({ text: line });
  return out;
}

function saleSlipStandard(sale, settings, cols) {
  const mode = itemRowMode(settings);
  const { billable } = splitDeviceLine(sale);
  const slip = [];
  const push = (text, opts) => slip.push({ text, ...opts });
  const lines = (v, wide) => wrap(v, wide ? Math.floor(cols / 2) : cols).forEach((t) => push(t, wide ? { wide: true, centered: true } : {}));
  for (const line of nameLines(settings.gcash_name, Math.floor(cols / 2))) push(line, { wide: true, centered: true });
  lines(settings.shop_address || defaultShopSubtitle(settings));
  lines(`Tel/GCash: ${settings.gcash_number || ''}`);
  push(rule(cols));
  push('OFFICIAL RECEIPT', { centered: true });
  for (const line of wrap(`Invoice #: ${sale.sale_code}`, cols)) push(line);
  push(`Date: ${localStamp(sale.created_at)}`);
  for (const line of saleInfoRows(sale, cols).map((l) => l.text)) push(line);
  push(rule(cols));
  for (const item of billable) {
    for (const line of saleItemLines(item, cols, mode)) push(line.text, line.centered ? { centered: true } : {});
  }
  push(rule(cols));
  for (const line of saleTotalsRows(sale, cols)) push(line.text);
  push(row('TOTAL DUE:', money(sale.total_amount), cols));
  for (const line of salePaidRows(sale, cols)) push(line.text);
  const returns = saleReturnsRows(sale, cols);
  if (returns.length) {
    push(rule(cols));
    for (const line of returns) push(line.text);
  }
  push(rule(cols));
  const credit = saleCreditAckRows(sale, cols);
  if (credit.length) {
    for (const line of credit) push(line.text, line.centered ? { centered: true } : {});
    push(rule(cols));
  }
  for (const line of saleWarrantyRows(sale, settings, cols, { withPolicy: true })) {
    push(line.text, line.centered ? { centered: true } : {});
  }
  for (const line of saleFooterRows(settings, cols)) push(line.text, { centered: true });
  return slip;
}

function saleSlipCompact(sale, settings, cols) {
  const mode = itemRowMode(settings);
  const { billable } = splitDeviceLine(sale);
  const slip = saleHeaderTrimmedRows(sale, settings, cols);
  const push = (text, opts) => slip.push({ text, ...opts });
  push(rule(cols));
  for (const line of saleInfoRows(sale, cols)) push(line.text);
  push(rule(cols));
  for (const item of billable) {
    for (const line of saleItemLines(item, cols, mode)) push(line.text);
  }
  push(rule(cols));
  for (const line of saleTotalsRows(sale, cols)) push(line.text);
  push(row('TOTAL DUE:', money(sale.total_amount), cols));
  for (const line of salePaidRows(sale, cols)) push(line.text);
  const returns = saleReturnsRows(sale, cols);
  if (returns.length) {
    push(rule(cols));
    for (const line of returns) push(line.text);
  }
  const credit = saleCreditAckRows(sale, cols);
  if (credit.length) {
    push(rule(cols));
    for (const line of credit) push(line.text, line.centered ? { centered: true } : {});
  }
  push(rule(cols));
  for (const line of saleWarrantyRows(sale, settings, cols, { withPolicy: false })) push(line.text);
  return slip;
}

function saleSlipBoxed(sale, settings, cols) {
  const mode = itemRowMode(settings);
  const { billable } = splitDeviceLine(sale);
  const hr = '='.repeat(cols);
  const slip = [];
  const push = (text, opts) => slip.push({ text, ...opts });
  const lines = (v, wide) => wrap(v, wide ? Math.floor(cols / 2) : cols).forEach((t) => push(t, wide ? { wide: true, centered: true } : {}));
  for (const line of nameLines(settings.gcash_name, Math.floor(cols / 2))) push(line, { wide: true, centered: true });
  lines(settings.shop_address || defaultShopSubtitle(settings));
  lines(`Tel/GCash: ${settings.gcash_number || ''}`);
  push(hr);
  push('OFFICIAL RECEIPT', { centered: true });
  for (const line of wrap(`Invoice #: ${sale.sale_code}`, cols)) push(line);
  const pay = String(sale.payment_method || '').toUpperCase();
  for (const line of wrap(`${localStamp(sale.created_at)}${pay ? ` / ${pay}` : ''}`, cols)) push(line);
  push(hr);
  for (const line of saleInfoRows(sale, cols)) push(line.text);
  push(hr);
  for (const item of billable) {
    for (const line of saleItemLines(item, cols, mode)) push(line.text);
  }
  push(hr);
  for (const line of saleTotalsRows(sale, cols)) push(line.text);
  // The total framed in a box: the one figure a counter scans for.
  push('+' + '-'.repeat(cols - 2) + '+');
  push('| ' + row('TOTAL DUE', money(sale.total_amount), cols - 4) + ' |');
  push('+' + '-'.repeat(cols - 2) + '+');
  for (const line of salePaidRows(sale, cols)) push(line.text);
  const returns = saleReturnsRows(sale, cols);
  if (returns.length) {
    push(hr);
    for (const line of returns) push(line.text);
  }
  const credit = saleCreditAckRows(sale, cols);
  if (credit.length) {
    push(hr);
    for (const line of credit) push(line.text, line.centered ? { centered: true } : {});
  }
  push(hr);
  for (const line of saleWarrantyRows(sale, settings, cols, { withPolicy: true })) {
    push(line.text, line.centered ? { centered: true } : {});
  }
  for (const line of saleFooterRows(settings, cols)) push(line.text, { centered: true });
  return slip;
}

function saleSlipAiry(sale, settings, cols) {
  const mode = itemRowMode(settings);
  const { billable } = splitDeviceLine(sale);
  const slip = [];
  const push = (text, opts) => slip.push({ text, ...opts });
  for (const line of saleShopNameRows(settings, cols)) push(line.text, { wide: true, centered: true });
  push('OFFICIAL RECEIPT', { centered: true });
  push('');
  for (const line of wrap(`Invoice #: ${sale.sale_code}`, cols)) push(line);
  const pay = String(sale.payment_method || '').toUpperCase();
  for (const line of wrap(`${localStamp(sale.created_at)}${pay ? ` / ${pay}` : ''}`, cols)) push(line);
  push('');
  for (const line of saleInfoRows(sale, cols)) push(line.text);
  push('');
  for (const item of billable) {
    for (const line of saleItemLines(item, cols, mode)) push(line.text);
  }
  push('');
  for (const line of saleTotalsRows(sale, cols)) push(line.text);
  push(row('TOTAL DUE:', money(sale.total_amount), cols));
  for (const line of salePaidRows(sale, cols)) push(line.text);
  const returns = saleReturnsRows(sale, cols);
  if (returns.length) {
    push('');
    for (const line of returns) push(line.text);
  }
  const credit = saleCreditAckRows(sale, cols);
  if (credit.length) {
    push('');
    for (const line of credit) push(line.text, line.centered ? { centered: true } : {});
  }
  push('');
  for (const line of saleWarrantyRows(sale, settings, cols, { withPolicy: false })) push(line.text);
  for (const line of saleFooterRows(settings, cols)) push(line.text, { centered: true });
  return slip;
}

function saleSlipGrid(sale, settings, cols) {
  const { billable } = splitDeviceLine(sale);
  const slip = saleHeaderTrimmedRows(sale, settings, cols);
  const push = (text, opts) => slip.push({ text, ...opts });
  push(rule(cols));
  for (const line of saleInfoRows(sale, cols)) push(line.text);
  push(rule(cols));
  for (const line of saleGridItemLines(billable, cols)) push(line);
  push(rule(cols));
  for (const line of saleTotalsRows(sale, cols)) push(line.text);
  push(row('TOTAL DUE:', money(sale.total_amount), cols));
  for (const line of salePaidRows(sale, cols)) push(line.text);
  const returns = saleReturnsRows(sale, cols);
  if (returns.length) {
    push(rule(cols));
    for (const line of returns) push(line.text);
  }
  const credit = saleCreditAckRows(sale, cols);
  if (credit.length) {
    push(rule(cols));
    for (const line of credit) push(line.text, line.centered ? { centered: true } : {});
  }
  push(rule(cols));
  for (const line of saleWarrantyRows(sale, settings, cols, { withPolicy: false })) push(line.text);
  for (const line of saleFooterRows(settings, cols)) push(line.text, { centered: true });
  return slip;
}

const SALE_TEMPLATES = new Set(['standard', 'compact', 'boxed', 'airy', 'grid']);

// Entry point used by the print queue and the paper preview alike: dispatches
// on Settings > Printing > Receipt template. Unknown or unset values read the
// standard layout, so existing shops print exactly what they printed before.
function renderSaleSlip(sale, settings) {
  const cols = colsFor(settings.receipt_paper_width);
  const template = SALE_TEMPLATES.has(settings.receipt_template) ? settings.receipt_template : 'standard';
  if (template === 'compact') return saleSlipCompact(sale, settings, cols);
  if (template === 'boxed') return saleSlipBoxed(sale, settings, cols);
  if (template === 'airy') return saleSlipAiry(sale, settings, cols);
  if (template === 'grid') return saleSlipGrid(sale, settings, cols);
  return saleSlipStandard(sale, settings, cols);
}

// One warranty rule, on both papers: the days the shop set, or seven when the row
// does not carry a number. This replaces three different answers that used to sit
// either side of the same figure: paper added `|| 0` days to the expiry while the
// screen added `|| 7`, and the slip's own header fell back to '7' while its expiry
// line fell back to 0, so one document could print "WARRANTY (7 DAYS)" above an
// expiry equal to the sale date.
// Seven is the answer the rest of the app already gives: src/db.js:362 seeds
// warranty_days as '7' for a new shop, and Settings treats a blank field as '7'
// on save (public/js/auth.js:682), so a row with no readable number means a shop
// that never set one, and the default is what it was set to.
// A saved "0" is different: it is a shop that did set it, and said no warranty,
// so zero passes straight through instead of being read as "unset". Anything that
// is not a finite number of zero or more days falls back the same way, and
// public/js/ui.js carries this exact rule for the browser.
// tests/printer.test.js pins both sides and all four cases.
function warrantyDays(days) {
  const raw = String(days ?? '').trim();
  if (!raw) return 7;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : 7;
}

// Date-only expiry, shop-local: a UTC slice would land the warranty on the
// wrong day eight hours before closing. An arithmetic overflow (a hand-edited
// value big enough to run the calendar off its end) prints `--` on this paper and
// on the screen's, rather than one sheet going blank and the other reading
// "Invalid Date".
function calculateWarrantyExpiry(created, days) {
  const d = new Date(created || Date.now());
  if (Number.isNaN(d.getTime())) return '--';
  d.setDate(d.getDate() + warrantyDays(days));
  return Number.isNaN(d.getTime()) ? '--' : localDate(d);
}

// The repair claim stub, mirroring public/js/receipts.js's renderClaimStub in
// the same order. It is estimate paper, not an official receipt: no invoice
// framing, no warranty block, and a footer that says so. The job arrives from
// the tab (the browser path renders the same fields), so every free-text field
// still goes through plain()/wrap() and every amount through money(), which
// refuses the slip instead of printing P0.00 for a broken figure. Until this
// existed the stub was the one counter paper with no ESC/POS encoder: a thermal
// counter printed it through the browser route while every other slip came
// from the queue.
function renderClaimStubSlip(job, settings) {
  const cols = colsFor(settings.receipt_paper_width);
  const slip = [];
  const push = (text, opts) => slip.push({ text, ...opts });
  const lines = (v, wide) => wrap(v, wide ? Math.floor(cols / 2) : cols).forEach((t) => push(t, wide ? { wide: true, centered: true } : {}));
  for (const line of nameLines(settings.gcash_name, Math.floor(cols / 2))) push(line, { wide: true, centered: true });
  lines(settings.shop_address || defaultShopSubtitle(settings));
  lines('Tel/GCash: ' + (settings.gcash_number || ''));
  push(rule(cols));
  push('REPAIR CLAIM STUB', { centered: true });
  for (const line of wrap('Ref: ' + plain(job.ref || ''), cols)) push(line);
  push('Date: ' + localStamp(job.created_at || new Date().toISOString()));
  for (const line of labelled('Customer:', job.customer || 'Walk-in Customer', cols)) push(line);
  if (job.phone) for (const line of labelled('Phone:', job.phone, cols)) push(line);
  if (job.device) for (const line of labelled('Device:', job.device, cols)) push(line);
  if (job.imei) for (const line of labelled('IMEI/SN:', job.imei, cols)) push(line);
  if (job.note) for (const line of labelled('Job Note:', job.note, cols)) push(line);
  const items = Array.isArray(job.items) ? job.items : [];
  if (items.length) {
    push(rule(cols));
    push('ESTIMATED ITEMS', { centered: true });
    for (const it of items) {
      const name = plain(it.name || [it.brand, it.model_name, it.part_type].filter(Boolean).join(' ') || 'Item');
      for (const line of wrap(name, cols)) push(line);
      const qty = Number(it.qty || 1);
      const unit = Number(it.unit_price || 0);
      // Same expression as the browser stub: a garbage price stays NaN and
      // money() refuses the slip rather than printing P0.00.
      push(row('  ' + qty + 'x P' + (Number.isFinite(unit) ? unit.toFixed(2) : String(it.unit_price)), money(qty * unit), cols));
    }
    if (Number(job.discount) > 0) push(row('Discount:', '-' + money(job.discount), cols));
    push(rule(cols));
    push(row('ESTIMATED TOTAL:', money(job.total), cols));
  }
  push(rule(cols));
  for (const line of wrap('Present this stub when claiming your unit.', cols)) push(line, { centered: true });
  for (const line of wrap('*** Claim stub only, not an official receipt ***', cols)) push(line, { centered: true });
  return slip;
}

// The credit settlement slip, mirroring public/js/receipts.js's
// renderSettlementReceipt in the same order: which collection came in and what
// is still owed. It is shorter than the sale receipt on purpose -- there is no
// invoice, no item list and no warranty on a payment -- but every label it does
// carry goes through labelled(), for the reason the sale slip documents: a
// debtor's name and phone are free text with no cap upstream, and a remaining
// balance long enough to crowd the roll is the one figure this slip exists to
// state. row() would trade the label away to pay for it.
function renderSettlementSlip(payment, customer, settings) {
  const cols = colsFor(settings.receipt_paper_width);
  const slip = [];
  const push = (text, opts) => slip.push({ text, ...opts });
  const lines = (v, wide) => wrap(v, wide ? Math.floor(cols / 2) : cols).forEach((t) => push(t, wide ? { wide: true, centered: true } : {}));
  for (const line of nameLines(settings.gcash_name, Math.floor(cols / 2))) push(line, { wide: true, centered: true });
  // The same two header lines the sale slip and the browser fallback carry, in the
  // same order, off the same helper. This is payment proof for a debt reduction:
  // the roll has to name who took the money and how to reach them, and for a GCash
  // collection the printed number frequently IS the receiving account.
  lines(settings.shop_address || defaultShopSubtitle(settings));
  lines(`Tel/GCash: ${settings.gcash_number || ''}`);
  push(rule(cols));
  push('SETTLEMENT RECEIPT', { centered: true });
  push(`Date: ${localStamp(payment.created_at)}`);
  for (const line of labelled('Customer:', customer.customer_name, cols)) push(line);
  if (customer.customer_phone) {
    for (const line of labelled('Phone:', customer.customer_phone, cols)) push(line);
  }
  const paymentText = `${String(payment.payment_method || '').toUpperCase()} ${(payment.payment_reference || '').trim()}`.trim();
  for (const line of labelled('Payment:', paymentText, cols)) push(line);
  if (payment.notes) for (const line of wrap(`Notes: ${payment.notes}`, cols)) push(line);
  push(rule(cols));
  for (const line of labelled('Payment received:', money(payment.amount_paid), cols)) push(line);
  const remainingText = Number(customer.total_credit_balance) <= 0.001
    ? `${money(customer.total_credit_balance)} (PAID IN FULL)`
    : money(customer.total_credit_balance);
  for (const line of labelled('Remaining balance:', remainingText, cols)) push(line);
  push(rule(cols));
  // Framed like the screen's settlement receipt (public/js/receipts.js:369), for
  // the reason the sale slip documents: the frame is the renderer's, not
  // something the shop types into the setting.
  // Wrapped, not pushed whole: the framed default is 35 characters and a 58mm
  // roll has 32, same trap the sale slip's footer documents.
  for (const line of wrap(`*** ${plain(settings.shop_footer_note || 'Thank you for your payment!')} ***`, cols)) {
    push(line, { centered: true });
  }
  return slip;
}

const { spawn } = require('node:child_process');

// Data reaches PowerShell only through env vars. Nothing user-entered is
// interpolated into a command line or a script literal, which is what keeps a
// Settings-supplied queue name from ever becoming code.
const SEND_SCRIPT = `$ErrorActionPreference = 'Stop'
$sig = @'
using System;
using System.Runtime.InteropServices;
public class W {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct D { public string n; public IntPtr f; public string t; }
  [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool OpenPrinter(string n, out IntPtr h, IntPtr z);
  [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool StartDocPrinter(IntPtr h, int l, ref D d);
  [DllImport("winspool.drv", SetLastError = true)]
  public static extern bool StartPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)]
  public static extern bool WritePrinter(IntPtr h, byte[] b, int c, out int w);
  [DllImport("winspool.drv", SetLastError = true)]
  public static extern bool EndPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)]
  public static extern bool EndDocPrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)]
  public static extern bool ClosePrinter(IntPtr h);
}
'@
Add-Type -TypeDefinition $sig
$b = [Convert]::FromBase64String($env:TP_PAYLOAD)
$h = [IntPtr]::Zero
if (-not [W]::OpenPrinter($env:TP_PRINTER, [ref]$h, [IntPtr]::Zero)) {
  ConvertTo-Json -Compress -InputObject @{ ok = $false; error = 'the printer queue could not be opened' }
  exit
}
$d = New-Object W+D
$d.n = $env:TP_DOC
$d.f = [IntPtr]::Zero
$d.t = 'RAW'
if (-not [W]::StartDocPrinter($h, 1, [ref]$d)) {
  [void][W]::ClosePrinter($h)
  ConvertTo-Json -Compress -InputObject @{ ok = $false; error = 'the print job could not be started' }
  exit
}
[void][W]::StartPagePrinter($h)
$w = 0
$ok = [W]::WritePrinter($h, $b, $b.Length, [ref]$w)
[void][W]::EndPagePrinter($h)
[void][W]::EndDocPrinter($h)
[void][W]::ClosePrinter($h)
if ($ok -and $w -eq $b.Length) {
  ConvertTo-Json -Compress -InputObject @{ ok = $true }
} else {
  ConvertTo-Json -Compress -InputObject @{ ok = $false; error = ('the printer took only ' + $w + ' of ' + $b.Length + ' bytes') }
}`;

const LIST_SCRIPT = `$ErrorActionPreference = 'Stop'
try {
  Get-CimInstance Win32_Printer |
    Select-Object Name,PortName,DriverName,Default,WorkOffline |
    ConvertTo-Json -Compress
} catch {
  try {
    $w = Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Windows' -ErrorAction SilentlyContinue
    $def = if ($w -and $w.Device) { ($w.Device -split ',')[0] } else { '' }
    $reg = Get-ChildItem 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Print\\Printers' -ErrorAction SilentlyContinue
    if ($reg) {
      $list = @($reg | ForEach-Object {
        $p = Get-ItemProperty $_.PSPath
        [PSCustomObject]@{
          Name = [string]$p.Name
          PortName = [string]$p.Port
          DriverName = [string]$p.'Printer Driver'
          Default = ([string]$p.Name -eq $def)
          WorkOffline = $false
        }
      })
      $list | ConvertTo-Json -Compress
    } else {
      $devs = Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Devices' -ErrorAction SilentlyContinue
      if ($devs) {
        $names = $devs.psobject.properties | Where-Object { $_.Name -notmatch '^PS' } | ForEach-Object { $_.Name }
        $list = @($names | ForEach-Object {
          [PSCustomObject]@{
            Name = [string]$_
            PortName = ''
            DriverName = ''
            Default = ([string]$_ -eq $def)
            WorkOffline = $false
          }
        })
        if ($list.Count -gt 0) { $list | ConvertTo-Json -Compress } else { '[]' }
      } else {
        'the print queue lookup failed'
      }
    }
  } catch {
    'the print queue lookup failed'
  }
}`;

// Windows PowerShell 5.1 runs `-Command -` stdin one statement at a time, so a
// script with a multi-line try or if block arrives in pieces and does nothing at
// all: listPrinters() came back empty and sendRaw() reported 'PowerShell returned
// nothing' against a queue that exists. -EncodedCommand hands the whole body over
// as a single base64 UTF-16LE token instead, which no quoting rule can break. The
// token is always this module's own constant; the printer name and the payload
// still only ever travel in env vars.
function powerShellArgs(script) {
  return ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
}

// A stalled spooler or a print processor waiting on a wedged USB device must not
// be able to hold a print route open forever, so every helper call is bounded.
const POWER_SHELL_TIMEOUT_MS = 15000;

// stderr is piped and must be drained or the OS pipe buffer fills and the child
// blocks on its next write: Add-Type and Get-CimInstance push progress records
// there under -EncodedCommand, so the volume is not this module's to control.
// The captured tail is kept only to explain a failure, so it is bounded; a
// runaway helper cannot grow this without limit.
const STDERR_BUFFER_LIMIT = 4096;

// Resolves { out, error } and never rejects: error is non-empty only when the
// call itself failed to deliver an answer (it never started, it never finished,
// or it exited non-zero leaving nothing but stderr), in which case out is empty
// so every caller falls onto its own failure path -- and the drained stderr rides
// along in that reason so the operator learns the real cause instead of a generic
// "returned nothing". command/args/timeoutMs are parameters because the deadline
// has to be provable without touching a real queue; listPrinters() and sendRaw()
// pass none of that, they always run powershell.exe with the deadline above.
function runCommand(command, args, env, timeoutMs = POWER_SHELL_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let timer = null;
    let settled = false;
    const settle = (out, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ out, error });
    };
    const child = spawn(command, args, {
      env: { ...process.env, ...env },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    let errTrimmed = false;
    // stdout is the answer channel; stderr is drained (never left to fill the
    // pipe and block the child) but kept only as a bound tail for the reason.
    child.stdout.on('data', (chunk) => { out += chunk; });
    if (child.stderr) {
      child.stderr.on('data', (chunk) => {
        if (err.length >= STDERR_BUFFER_LIMIT) { errTrimmed = true; return; }
        err += chunk;
        if (err.length > STDERR_BUFFER_LIMIT) {
          err = err.slice(0, STDERR_BUFFER_LIMIT);
          errTrimmed = true;
        }
      });
    }
    // Only surfaces on the failure paths; a clean helper ignores stderr entirely.
    const stderrReason = () => (err.trim() ? `: ${err.trim()}${errTrimmed ? ' [truncated]' : ''}` : '');
    timer = setTimeout(() => {
      child.kill('SIGKILL');
      settle('', `the print helper did not answer within ${timeoutMs} ms${stderrReason()}`);
    }, timeoutMs);
    child.on('error', (err2) => settle('', `the print helper could not start: ${err2.message}`));
    child.on('close', (code) => {
      const trimmed = out.trim();
      // A helper that exits non-zero and prints nothing to stdout delivered no
      // answer; its stderr is the reason. Empty stdout on a clean exit is still
      // a real answer (a shop with zero queues), so only a failing code counts.
      if (!trimmed && code !== 0) {
        settle('', `the print helper exited with code ${code}${stderrReason()}`);
      } else {
        settle(trimmed, null);
      }
    });
  });
}

function runPowerShell(script, env) {
  return runCommand('powershell.exe', powerShellArgs(script), env, POWER_SHELL_TIMEOUT_MS);
}

function buildSendJob(printerName, bytes) {
  return {
    args: powerShellArgs(SEND_SCRIPT),
    env: {
      TP_PRINTER: String(printerName),
      TP_DOC: 'TechParts POS',
      TP_PAYLOAD: Buffer.from(bytes).toString('base64'),
    },
    script: SEND_SCRIPT,
  };
}

function parseSendResult(stdout) {
  const line = String(stdout).trim().split('\n').pop() || '';
  try {
    const parsed = JSON.parse(line);
    return parsed.ok ? { ok: true } : { ok: false, error: String(parsed.error || 'the printer refused the job') };
  } catch {
    return { ok: false, error: line.slice(0, 200) || 'PowerShell returned nothing' };
  }
}

function parsePrinters(stdout) {
  const raw = String(stdout).trim();
  if (!raw) return [];
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return []; }
  return (Array.isArray(parsed) ? parsed : [parsed]).map((p) => ({
    name: String(p.Name ?? ''),
    port: String(p.PortName ?? ''),
    driver: String(p.DriverName ?? ''),
    isDefault: p.Default === true,
    offline: p.WorkOffline === true,
  })).filter((p) => p.name);
}

function defaultPrinter(rows) {
  // An offline queue is a dead one: a send that reaches it can come back ok:true
  // while nothing prints, so the Windows default is only preferred while it is
  // online. Order: online default, then any online queue, then the offline
  // default as a last resort so the picker still names the queue to fix.
  return (rows.find((r) => r.isDefault && !r.offline)
    || rows.find((r) => !r.offline)
    || rows.find((r) => r.isDefault)
    || {}).name || null;
}

// The queue lookup has three outcomes a caller has to be able to tell apart:
// queues, a machine that genuinely has none, and a lookup that broke. Only the
// last one carries an error; printers is always an array, so Task 4 can show an
// empty picker for the first two and say something loud about the third instead
// of reporting "no printers" for a broken spooler.
function parsePrinterLookup(stdout, transportError) {
  if (transportError) return { printers: [], error: String(transportError) };
  const printers = parsePrinters(stdout);
  if (!printers.length && String(stdout).trim()) {
    return { printers, error: 'the print queue list could not be read' };
  }
  return { printers, error: null };
}

async function sendRaw(printerName, bytes) {
  const job = buildSendJob(printerName, bytes);
  const { out, error } = await runPowerShell(job.script, job.env);
  // A transport that never delivered an answer already carries the drained
  // stderr as its reason; hand it to the operator rather than letting
  // parseSendResult guess "PowerShell returned nothing" from empty stdout.
  if (error) return { ok: false, error };
  return parseSendResult(out);
}

async function listPrinters() {
  const { out, error } = await runPowerShell(LIST_SCRIPT, {});
  return parsePrinterLookup(out, error);
}

module.exports = { colsFor, plain, localStamp, localDate, wrap, nameLines, row, labelled, rule, ruler, encode, DRAWER_KICK, renderTestSlip, renderSaleSlip, renderSettlementSlip, renderClaimStubSlip, calculateWarrantyExpiry, warrantyDays, money, isAmountRefusal, DEVICE_LINE_PREFIX, buildSendJob, parseSendResult, parsePrinters, parsePrinterLookup, defaultPrinter, runCommand, POWER_SHELL_TIMEOUT_MS, sendRaw, listPrinters };
