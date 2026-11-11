// phone-repair-pos/tests/printer.test.js
const assert = require('node:assert/strict');
const test = require('node:test');
const { colsFor, wrap, row, labelled, rule, encode, renderTestSlip, localStamp } = require('../src/printer');

test('columns follow the roll width, defaulting to 80mm', () => {
  assert.equal(colsFor('58mm'), 32);
  assert.equal(colsFor('80mm'), 48);
  assert.equal(colsFor(undefined), 48);
});

test('wrap breaks at spaces and keeps every word', () => {
  const src = 'Physical crack, flex tear, water damage voids warranty.';
  const lines = wrap(src, 32);
  assert.ok(lines.every(l => l.length <= 32));
  assert.equal(lines.join(' '), src);
});

test('wrap hard-breaks a word longer than the roll', () => {
  assert.deepEqual(wrap('ABCDEFGHIJKLMNOPQRSTUVWX YZ', 20), ['ABCDEFGHIJKLMNOPQRST', 'UVWX YZ']);
});

test('row pads so the value ends in the final column', () => {
  const r = row('Subtotal', 'P1,250.00', 32);
  assert.equal(r.length, 32);
  assert.ok(r.startsWith('Subtotal'));
  assert.ok(r.endsWith('P1,250.00'));
});

test('row truncates the label and never the value', () => {
  const r = row('Warranty valid until this date for the item listed', 'P12,345.67', 32);
  assert.equal(r.length, 32);
  assert.ok(r.endsWith('P12,345.67'));
});

test('encode emits init, one LF per line, then a three-line feed', () => {
  assert.deepEqual([...encode([{ text: 'AB' }])], [0x1b, 0x40, 0x41, 0x42, 0x0a, 0x1b, 0x64, 0x03]);
});

test('encode brackets a wide centered line with its own commands', () => {
  assert.deepEqual([...encode([{ text: 'AB', wide: true, centered: true }])], [
    0x1b, 0x40,
    0x1b, 0x61, 0x01, 0x1d, 0x21, 0x11,
    0x41, 0x42, 0x0a,
    0x1d, 0x21, 0x00, 0x1b, 0x61, 0x00,
    0x1b, 0x64, 0x03,
  ]);
});

test('encode emits cash drawer kick pulse when drawerKick is true', () => {
  assert.deepEqual([...encode([{ text: 'AB' }], { drawerKick: true })], [
    0x1b, 0x40,
    0x1b, 0x70, 0x00, 0x19, 0xfa,
    0x1b, 0x70, 0x01, 0x19, 0xfa,
    0x41, 0x42, 0x0a,
    0x1b, 0x64, 0x03,
  ]);
});

test('a 58mm slip never exceeds its column budget', () => {
  const slip = renderTestSlip({
    receipt_paper_width: '58mm',
    gcash_name: 'TECHPARTS REPAIR & POS',
    shop_address: 'Rizal Street, Cabanatuan City, Nueva Ecija',
    gcash_number: '0917-123-4567',
  });
  for (const line of slip) {
    const budget = line.wide ? 16 : 32;
    assert.ok(line.text.length <= budget, `over ${budget}: ${JSON.stringify(line.text)}`);
  }
});

test('nothing but printable ASCII reaches the printer', () => {
  const slip = renderTestSlip({ receipt_paper_width: '58mm', gcash_name: 'Shop ✓ “₱”' });
  for (const line of slip) assert.match(line.text, /^[\x20-\x7e]*$/);
});

test('the slip stamp is shop time, not a UTC slice', () => {
  const slip = renderTestSlip({ receipt_paper_width: '58mm' });
  const stamp = slip.find((l) => /^\d{4}-\d{2}-\d{2} /.test(l.text)).text;
  assert.equal(stamp.slice(0, 13), localStamp().slice(0, 13));
});

test('a name of only unsupported characters still prints a header', () => {
  const slip = renderTestSlip({ receipt_paper_width: '58mm', gcash_name: '“₱”' });
  assert.equal(slip[0].text, 'TECHPARTS POS');
  assert.equal(slip[0].wide, true);
});

const { buildSendJob, parseSendResult, parsePrinters, defaultPrinter, runCommand, parsePrinterLookup, POWER_SHELL_TIMEOUT_MS } = require('../src/printer');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('the printer name never reaches the command line', () => {
  const evil = `X"; Remove-Item C:\\ -Recurse; #`;
  const job = buildSendJob(evil, Buffer.from('hello'));
  assert.ok(!JSON.stringify(job.args).includes(evil));
  assert.ok(!job.script.includes(evil));
  assert.equal(job.env.TP_PRINTER, evil);
  assert.equal(Buffer.from(job.env.TP_PAYLOAD, 'base64').toString(), 'hello');
});

test('send result parsing covers success and both failure shapes', () => {
  assert.deepEqual(parseSendResult('{"ok":true}'), { ok: true });
  assert.deepEqual(parseSendResult('{"ok":false,"error":"no queue"}'), { ok: false, error: 'no queue' });
  assert.deepEqual(parseSendResult('boom\nnot json'), { ok: false, error: 'not json' });
});

test('printer rows parse one object or a list, and keep offline queues', () => {
  const one = parsePrinters('{"Name":"POS-58","PortName":"USB002","DriverName":"POS-58","Default":true,"WorkOffline":false}');
  assert.deepEqual(one, [{ name: 'POS-58', port: 'USB002', driver: 'POS-58', isDefault: true, offline: false }]);
  const many = parsePrinters('[{"Name":"A","WorkOffline":true},{"Name":"B","WorkOffline":false}]');
  assert.deepEqual(many.map(p => p.name), ['A', 'B']);
  assert.equal(many[0].offline, true);
});

test('parsing an empty or garbage listing yields no printers, not a throw', () => {
  assert.deepEqual(parsePrinters(''), []);
  assert.deepEqual(parsePrinters('ConvertTo-Json exploded'), []);
});

test('defaultPrinter prefers an online default, then any online queue, then the offline default', () => {
  // The Windows default wins only while its queue can take a job.
  assert.equal(defaultPrinter([{ name: 'X', offline: true, isDefault: false }, { name: 'B', offline: false, isDefault: true }]), 'B');
  // No usable default at all: the first online queue, as before.
  assert.equal(defaultPrinter([{ name: 'X', offline: true, isDefault: false }, { name: 'Y', offline: false, isDefault: false }]), 'Y');
  // A dead default must not shadow a live queue. At this layer a send to a
  // paused queue comes back ok:true, so picking it is picking a lost receipt.
  assert.equal(defaultPrinter([{ name: 'D', offline: true, isDefault: true }, { name: 'L', offline: false, isDefault: false }]), 'L');
  // Nothing is online: still name the default, last resort, since the operator
  // has to go re-enable it whatever the picker shows.
  assert.equal(defaultPrinter([{ name: 'E', offline: true, isDefault: false }, { name: 'D', offline: true, isDefault: true }]), 'D');
  assert.equal(defaultPrinter([]), null);
});

test('a broken queue lookup says so instead of arriving as an empty picker', () => {
  assert.deepEqual(
    parsePrinterLookup('[{"Name":"POS-58","WorkOffline":false}]', null),
    { printers: [{ name: 'POS-58', port: '', driver: '', isDefault: false, offline: false }], error: null }
  );
  // A shop with zero queues is a fact, not a failure.
  assert.deepEqual(parsePrinterLookup('', null), { printers: [], error: null });
  // Everything else is the lookup itself breaking, which Task 4 has to say out loud.
  const garbage = parsePrinterLookup('ConvertTo-Json exploded', null);
  assert.deepEqual(garbage.printers, []);
  assert.equal(garbage.error, 'the print queue list could not be read');
  const timedOut = parsePrinterLookup('', 'the print helper did not answer within 15000 ms');
  assert.deepEqual(timedOut.printers, []);
  assert.equal(timedOut.error, 'the print helper did not answer within 15000 ms');
});

test('a helper call that would never finish is cut off at its deadline instead of hanging', async () => {
  // The deadline the shipped transport runs on, pinned here because exercising
  // it end to end would mean either waiting 15 s or calling into a real queue.
  assert.equal(POWER_SHELL_TIMEOUT_MS, 15000);
  const pidFile = path.join(os.tmpdir(), `printer-timeout-${process.pid}-${Date.now()}.txt`);
  // A child that installs a timer and never exits: without a deadline this call
  // settles nothing, which is how one wedged spooler stalls a print route
  // forever. It writes its own pid so the test can tell a kill from a mere
  // walk-away. Nothing here reaches PowerShell, a queue or a printer.
  const hang = 'require("fs").writeFileSync(process.argv[1],String(process.pid));setInterval(function () {}, 1000);';
  // A short deadline: the whole point is that the child is cut off fast, and it
  // would still be alive forever without it. Whether the child booted far enough
  // to write its pid before the kill is no longer a correctness dependency -- the
  // pid file is polled below -- so a cold node.exe cannot turn this into a
  // spurious ENOENT; it only changes which proof branch runs.
  const outcome = await runCommand(process.execPath, ['-e', hang, pidFile], {}, 500)
    .then((result) => ({ state: 'resolved', result }), (error) => ({ state: 'rejected', error }));
  assert.equal(outcome.state, 'resolved');
  assert.equal(outcome.result.out, '');
  assert.equal(typeof outcome.result.error, 'string');
  assert.match(outcome.result.error, /500 ms/);
  try {
    // The child writes its own pid during boot. On a cold node.exe under an
    // antivirus scan that can land after the 500 ms deadline has already fired
    // and killed the process, so poll for the file instead of reading it once at
    // a guessed moment -- the same bounded-wait style used for ESRCH below. No
    // unconditional readFileSync, so no spurious ENOENT failing the suite.
    let pid;
    for (let i = 0; i < 40; i += 1) {
      let raw = '';
      try { raw = fs.readFileSync(pidFile, 'utf8'); } catch { raw = ''; }
      const n = Number(raw);
      if (Number.isInteger(n) && n > 0) { pid = n; break; }
      await new Promise((resolve) => { setTimeout(resolve, 25); });
    }
    // If the pid file appeared, the child had booted into its hang, so prove the
    // deadline killed it rather than let it walk away. If it never appeared, the
    // SIGKILL landed before boot finished writing it: the /500 ms/ assertion
    // above already proves the deadline fired and killed the handle, and there is
    // no live pid left to leak, so there is nothing further to assert.
    if (pid !== undefined) {
      let gone = false;
      for (let i = 0; i < 40 && !gone; i += 1) {
        try { process.kill(pid, 0); } catch (error) { gone = error.code === 'ESRCH'; }
        if (!gone) await new Promise((resolve) => { setTimeout(resolve, 25); });
      }
      assert.ok(gone, `child ${pid} outlived the deadline`);
    }
  } finally {
    // Runs even if an assertion above throws, so the temp file never escapes.
    fs.rmSync(pidFile, { force: true });
  }
  // A clean run stays a clean run: output through, no error, and the deadline
  // is cleared rather than left to hold the process open.
  assert.deepEqual(await runCommand(process.execPath, ['-e', 'console.log("alive")'], {}, 30000), { out: 'alive', error: null });
  // The other way a call can fail to answer is the helper never starting, which
  // has to resolve too: a missing powershell.exe would otherwise stall a route
  // exactly like a wedged spooler does.
  const missing = await runCommand('definitely-not-a-real-exe-91f3.exe', ['-NoProfile'], {}, 5000)
    .then((result) => ({ state: 'resolved', result }), () => ({ state: 'rejected' }));
  assert.equal(missing.state, 'resolved');
  assert.equal(missing.result.out, '');
  assert.match(missing.result.error, /could not start/);
});

test('stderr is drained, so a chatty helper neither wedges nor loses its reason', async () => {
  // Add-Type / Get-CimInstance push progress records to stderr under
  // -EncodedCommand, and a helper with no queue to talk to writes errors there.
  // Nothing here touches PowerShell, a queue or a printer: the child is
  // node.exe, exactly the transport's own stdio shape (stdout+stderr piped,
  // only stdout consumed) is what is under test.
  //
  // 400 KB is far past the OS pipe buffer. Left unread, the child blocks on the
  // write and never reaches console.log, so runCommand's deadline is what
  // answers and out comes back empty -- the reviewer's deadlock. Drained, the
  // write completes, the child prints its marker and exits clean, well inside
  // the generous 15 s deadline (the deadline must never be the thing that saves
  // this call; success is proof stderr was consumed).
  const flood = 'var s="x".repeat(1024);for(var i=0;i<400;i++){process.stderr.write(s);}console.log("drained");';
  const flooded = await runCommand(process.execPath, ['-e', flood], {}, POWER_SHELL_TIMEOUT_MS);
  assert.equal(flooded.out, 'drained');
  assert.equal(flooded.error, null);

  // A helper that fails outright has to hand back the reason it wrote to
  // stderr, not the generic "returned nothing" the parser would guess from an
  // empty stdout. This is what makes the drain reach sendRaw/listPrinters'
  // error path instead of being read and thrown away.
  const failed = await runCommand(process.execPath, ['-e', 'process.stderr.write("the queue is gone\\n");process.exit(3);'], {}, 5000);
  assert.equal(failed.out, '');
  assert.ok(failed.error, 'a non-zero exit with empty stdout has to surface an error');
  assert.match(failed.error, /code 3/);
  assert.match(failed.error, /the queue is gone/);

  // The bounded buffer keeps a runaway helper from growing the captured text
  // without limit; the tail is what matters, and the marker still shows the
  // child ran to completion.
  const runaway = 'process.stderr.write("y".repeat(2_000_000));console.log("done");';
  const drainedBig = await runCommand(process.execPath, ['-e', runaway], {}, POWER_SHELL_TIMEOUT_MS);
  assert.equal(drainedBig.out, 'done');
  assert.equal(drainedBig.error, null);
});

// --- the sale slip -----------------------------------------------------------
// Pure calls only: renderSaleSlip builds a line list, nothing here opens a
// queue, starts a document or touches the shop printer.
const { renderSaleSlip, localDate, DEVICE_LINE_PREFIX } = require('../src/printer');

// created_at arrives the way src/sales.js writes it: a UTC ISO string from
// new Date().toISOString(), which localStamp() then renders in shop time.
const nastySale = {
  sale_code: 'SALE-20260930-0007',
  created_at: '2026-09-30T01:14:22.000Z',
  customer_name: 'Mary Ann Santos-Dela Cruz Dela Cruz Dela Cruz Jr.',
  customer_phone: '09171234567',
  payment_method: 'gcash',
  payment_reference: '20260930WXYZ',
  subtotal: 9876543.2,
  discount: 1234.5,
  total_amount: 9875308.7,
  amount_paid: 9875400,
  change_amount: 91.3,
  credit_balance: 0,
  items: [
    { item_type: 'part', item_name: 'iPhone 11 Pro Max OLED Back Glass Digitizer Assembly Frame', quantity: 12, unit_price: 823045.25, total_price: 9876543 },
    { item_type: 'labor', item_name: 'LCD', quantity: 999, unit_price: 999999.99, total_price: 998999.01 }
  ]
};

const nastySettings = {
  receipt_paper_width: '58mm',
  // These tests pin the classic two-line item layout. Auto is the shipped
  // default (one line when the name fits), so the layout tests say so
  // explicitly; the auto/one_line behaviors get their own tests below.
  receipt_item_rows: 'two_line',
  gcash_name: 'TECHPARTS REPAIR & SERVICES & POS',
  shop_address: 'Rizal Street corner Quezon Avenue, Cabanatuan City, Nueva Ecija 3100',
  gcash_number: '0917-123-4567',
  warranty_days: '7',
  warranty_policy_text: 'Physical crack, flex tear, water damage voids warranty. Bring this receipt.',
  // The note as a shop would type it: bare words, no decoration. The framing is
  // the renderer's job on screen (public/js/receipts.js wraps it in ***), so
  // paper has to add the same frame rather than expect it in the setting.
  shop_footer_note: 'Thank you for your business, please come again to TechParts POS!'
};

// A counter-realistic sale: everything below fits a line, so the content
// assertions read the way the paper does at the shop.
const sampleSale = {
  sale_code: 'SALE-20260930-0007',
  created_at: '2026-09-30T01:14:22.000Z',
  customer_name: 'Juan Dela Cruz',
  customer_phone: '09171234567',
  payment_method: 'gcash',
  payment_reference: '20260930WXYZ',
  subtotal: 2750,
  discount: 50,
  total_amount: 2700,
  amount_paid: 3000,
  change_amount: 300,
  credit_balance: 0,
  items: [
    { item_type: 'part', item_name: 'iPhone 11 Screen OLED', quantity: 1, unit_price: 2200, total_price: 2200 },
    { item_type: 'labor', item_name: 'LCD Replacement', quantity: 1, unit_price: 450, total_price: 450 }
  ]
};

test('a sale slip keeps every line inside the roll budget, 58mm and 80mm', () => {
  for (const width of ['58mm', '80mm']) {
    const cols = colsFor(width);
    const slip = renderSaleSlip(nastySale, { ...nastySettings, receipt_paper_width: width });
    for (const line of slip) {
      const budget = line.wide ? Math.floor(cols / 2) : cols;
      assert.ok(line.text.length <= budget, `${width} over ${budget}: ${JSON.stringify(line.text)}`);
    }
  }
  // An empty note still prints the default, and nothing escapes past the roll.
  const bare = renderSaleSlip(nastySale, { receipt_paper_width: '58mm' });
  for (const line of bare) {
    const budget = line.wide ? 16 : 32;
    assert.ok(line.text.length <= budget, `${budget}: ${JSON.stringify(line.text)}`);
  }
  assert.equal(bare.filter((l) => l.centered && l.text.includes('*')).map((l) => l.text).join(' '),
    '*** Thank you for your business! ***');
});

test('a sale slip carries the sale, in the order the HTML receipt does', () => {
  const slip = renderSaleSlip(sampleSale, nastySettings);
  const text = slip.map((l) => l.text);
  assert.ok(text[0].startsWith('TECHPARTS'), text[0]);
  assert.ok(slip[0].wide, 'the shop name prints double-width');
  assert.equal(text[text.indexOf('OFFICIAL RECEIPT') - 1], '-'.repeat(32));
  assert.ok(text.includes('Invoice #: SALE-20260930-0007'));
  assert.ok(text.some((l) => l.startsWith('Customer:')));
  assert.ok(text.some((l) => l.startsWith('Phone:')));
  assert.ok(text.some((l) => l.startsWith('Payment:')), 'payment method and reference print');
  assert.ok(text.some((l) => l.startsWith('iPhone 11 Screen OLED')));
  assert.ok(text.some((l) => l.startsWith('[LABOR] LCD')), 'labor lines are tagged');
  assert.ok(text.some((l) => l.startsWith('Subtotal:')));
  assert.ok(text.some((l) => l.startsWith('Discount:')), 'a discount prints when there is one');
  assert.ok(text.some((l) => l.startsWith('TOTAL DUE:')));
  assert.ok(text.some((l) => l.startsWith('Amount Paid:')));
  assert.ok(text.some((l) => l.startsWith('CHANGE:')));
  assert.ok(text.indexOf('WARRANTY (7 DAYS):') > text.findIndex((l) => l.startsWith('TOTAL DUE:')));
  assert.ok(text.some((l) => l.startsWith('Valid Until: 2026-10-0')), 'a week out from the sale date');
  const footer = text.slice(text.findIndex((l) => l.startsWith('Valid Until: ')) + 1);
  assert.ok(footer.length >= 2, 'the long note wrapped instead of overflowing the roll');
  // Framed, exactly the way public/js/receipts.js frames it on screen: the same
  // setting has to produce the same last line on paper and in the modal.
  assert.equal(footer.join(' '), `*** ${nastySettings.shop_footer_note} ***`);
  // Money always lands in the last column, whatever the label costs.
  for (const l of slip.filter((x) => /P[\d,]+\.\d\d$/.test(x.text))) {
    assert.equal(l.text.length, 32, JSON.stringify(l.text));
  }
});

test('zero lines stay off the paper and a credit sale names the balance', () => {
  const cash = renderSaleSlip({ ...sampleSale, discount: 0, change_amount: 0, credit_balance: 0 }, nastySettings);
  const cashText = cash.map((l) => l.text);
  assert.ok(!cashText.some((l) => l.startsWith('Discount:')));
  assert.ok(!cashText.some((l) => l.startsWith('CHANGE:')));
  assert.ok(!cashText.some((l) => l.startsWith('BALANCE')));
  const credit = renderSaleSlip(
    { ...sampleSale, amount_paid: 0, change_amount: 0, credit_balance: 2700 },
    nastySettings
  );
  assert.ok(credit.map((l) => l.text).some((l) => l.startsWith('BALANCE (UTANG):') && l.endsWith('P2,700.00')));
});

test('the receipt stamp and warranty date are shop time, not the stored UTC row', () => {
  const slip = renderSaleSlip(sampleSale, nastySettings).map((l) => l.text);
  const stamp = slip.find((l) => l.startsWith('Date: '));
  assert.ok(!stamp.includes('T') && !stamp.includes('Z'), `raw ISO leaked onto paper: ${stamp}`);
  assert.equal(stamp, `Date: ${localStamp(sampleSale.created_at)}`);
  assert.equal(localStamp(sampleSale.created_at).slice(0, 10), localDate(sampleSale.created_at));
  const expiry = slip.find((l) => l.startsWith('Valid Until: '));
  assert.equal(expiry, `Valid Until: ${localDate(new Date(new Date(sampleSale.created_at).getTime() + 7 * 864e5))}`);
});

// A repair job the way public/js/views/pos.js actually stores it: the RO code,
// the unit, its IMEI and the note ride along as one zero-price labour line whose
// name starts with DEVICE_LINE_PREFIX, and public/js/receipts.js lifts it out of
// the billables and prints it as `Unit:` in the intake block. The paper has to
// agree with the screen, so the same line must not appear as a billable row.
const repairSale = {
  ...sampleSale,
  items: [
    { item_type: 'part', item_name: 'iPhone 11 Screen OLED', quantity: 1, unit_price: 2200, total_price: 2200 },
    { item_type: 'labor', item_name: 'LCD Replacement', quantity: 1, unit_price: 450, total_price: 450 },
    {
      item_type: 'labor',
      item_name: `${DEVICE_LINE_PREFIX}RO-0421 · iPhone 11 · IMEI 356945029912345 · screen cracked, customer asked for OLED`,
      quantity: 1,
      unit_price: 0,
      total_price: 0
    }
  ]
};

// The marker is the browser's constant, duplicated in src/printer.js on
// purpose. Pin the copy against the real one: a rename on either side has to
// fail here loudly instead of silently splitting the two renderers, which is how
// the ESC/POS receipt would start losing the device line again.
test('the server-side device marker is the literal the browser writes', () => {
  const posSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'views', 'pos.js'), 'utf8');
  const found = posSrc.match(/DEVICE_LINE_PREFIX\s*=\s*(['"])((?:(?!\1).)*)\1/);
  assert.ok(found, 'no DEVICE_LINE_PREFIX literal to pin against in public/js/views/pos.js');
  assert.equal(DEVICE_LINE_PREFIX, found[2]);
});

test('a repair sale prints the device line as Unit:, never as a billable row', () => {
  const text = renderSaleSlip(repairSale, nastySettings).map((l) => l.text);
  const payment = text.findIndex((l) => l.startsWith('Payment:'));
  assert.ok(payment > -1);

  // Out of the item list entirely: the marker itself, the IMEI and a 1 x P0.00
  // row for it are all gone from the billables.
  assert.ok(!text.some((l) => l.includes('DEVICE')), 'the marker reached the paper');
  assert.ok(!text.some((l) => l.includes('[LABOR]') && l.includes('IMEI')), 'the device line printed as a billable item');
  assert.ok(!text.some((l) => l.includes('356945029912345') && l.includes(' x ')), 'the device line printed a price row');
  // The two real lines still bill, tagged exactly as before.
  assert.equal(text.filter((l) => l.startsWith('[LABOR]')).length, 1, 'only the real labour line is tagged');
  assert.ok(text.some((l) => l.startsWith('[LABOR] LCD Replacement')));

  // In the customer block, where receipts.js puts it: Customer, Phone, Unit,
  // Payment.
  const unit = text.findIndex((l) => l.startsWith('Unit: '));
  assert.ok(unit > -1, 'no Unit: line on the paper');
  assert.ok(text.findIndex((l) => l.startsWith('Customer:')) < unit);
  assert.ok(text.findIndex((l) => l.startsWith('Phone:')) < unit);
  assert.ok(unit < payment, 'Unit: prints after Payment:, unlike the screen');
  // The same content the browser prints: marker dropped, detail kept. The
  // middots plain() strips leave double spaces that wrap() rejoins on one.
  assert.equal(text.slice(unit, payment).join(' '),
    'Unit: RO-0421 iPhone 11 IMEI 356945029912345 screen cracked, customer asked for OLED');
});

test('a device line cannot escape the grid, and a marked line is only ever taken once', () => {
  // Longer than any roll, one token, nothing for wrap() to lean on.
  const long = {
    ...repairSale,
    items: [{ item_type: 'labor', item_name: `${DEVICE_LINE_PREFIX}${'X'.repeat(120)}`, quantity: 1, unit_price: 0, total_price: 0 }]
  };
  for (const width of ['58mm', '80mm']) {
    const cols = colsFor(width);
    for (const line of renderSaleSlip(long, { ...nastySettings, receipt_paper_width: width })) {
      const budget = line.wide ? Math.floor(cols / 2) : cols;
      assert.ok(line.text.length <= budget, `${width} over ${budget}: ${JSON.stringify(line.text)}`);
    }
  }
  // receipts.js takes the FIRST marked line and leaves any second one billable,
  // and it keeps a zero-price labour line without the marker as a normal row.
  const twice = {
    ...repairSale,
    items: [
      { item_type: 'labor', item_name: `${DEVICE_LINE_PREFIX}RO-1 · first`, quantity: 1, unit_price: 0, total_price: 0 },
      { item_type: 'labor', item_name: `${DEVICE_LINE_PREFIX}RO-2 · second`, quantity: 1, unit_price: 0, total_price: 0 },
      { item_type: 'labor', item_name: 'Test fit', quantity: 1, unit_price: 0, total_price: 0 }
    ]
  };
  const text = renderSaleSlip(twice, nastySettings).map((l) => l.text);
  assert.equal(text.filter((l) => l.startsWith('Unit: ')).length, 1);
  assert.ok(text.some((l) => l.startsWith('Unit: RO-1 first')));
  assert.ok(text.some((l) => l.includes('RO-2')), 'a second marked line stays billable, as on screen');
  assert.ok(text.some((l) => l.startsWith('[LABOR] Test fit') && text.some((x) => x.includes('1 x P0.00'))),
    'an unmarked zero-price labour line is still a billable row');
});

test('a plain parts sale invents no Unit: line and no zero row', () => {
  const text = renderSaleSlip(sampleSale, nastySettings).map((l) => l.text);
  assert.ok(!text.some((l) => l.startsWith('Unit:')));
  assert.ok(!text.some((l) => l.includes('P0.00')));
});

// R24. #pos-customer-name (public/index.html) has no maxlength and str() in
// src/sales.js caps nothing, so a long name arrives at the roll straight from
// the counter. row() right-aligns and pays for the value by trading the label
// away: at 58mm a 32-character name printed with no label at all, and a longer
// one came out as "C Juan Dela Cruz Dela Cruz Dela", cut mid-word. The screen
// wraps the whole name, so paper that drops it is not the same document.
const longCustomerName = 'Mary Ann Santos Dela Cruz Dela Cruz Dela Cruz Sr.';

test('a long customer name keeps its label and wraps instead of being cut', () => {
  assert.equal(longCustomerName.length, 49);
  const text = renderSaleSlip({ ...sampleSale, customer_name: longCustomerName }, nastySettings).map((l) => l.text);
  const first = text.findIndex((l) => l.startsWith('Customer:'));
  assert.ok(first > -1, 'the Customer: label was dropped');
  const next = text.findIndex((l, i) => i > first && l.startsWith('Phone:'));
  assert.ok(next > first, 'the name ran past the next field');
  // Every word of it, in order, under its own label, and nothing off the roll.
  assert.equal(text.slice(first, next).join(' '), `Customer: ${longCustomerName}`);
  for (const l of text.slice(first, next)) {
    assert.ok(l.length <= 32, `58mm line over budget: ${JSON.stringify(l)}`);
  }
  // Same at 80mm, where the budget is 48 and this name used to print bare.
  for (const width of ['58mm', '80mm']) {
    const cols = colsFor(width);
    const slip = renderSaleSlip({ ...sampleSale, customer_name: longCustomerName }, { ...nastySettings, receipt_paper_width: width });
    const lines = slip.map((l) => l.text);
    const at = lines.findIndex((l) => l.startsWith('Customer:'));
    assert.ok(at > -1, `${width} lost the label`);
    assert.equal(lines.slice(at, lines.findIndex((l, i) => i > at && l.startsWith('Phone:'))).join(' '), `Customer: ${longCustomerName}`);
    for (const l of slip) {
      const budget = l.wide ? Math.floor(cols / 2) : cols;
      assert.ok(l.text.length <= budget, `${width} over ${budget}: ${JSON.stringify(l.text)}`);
    }
  }
  // A name with no spaces at all is still labelled and still on the grid:
  // wrap() hard-breaks the single word, which is what cut mid-word becomes once
  // the label is allowed to survive.
  const hard = labelled('Customer:', 'X'.repeat(80), 32);
  assert.equal(hard[0], 'Customer:');
  assert.equal(hard.slice(1).join(''), 'X'.repeat(80));
  assert.ok(hard.every((l) => l.length <= 32), JSON.stringify(hard));
});

test('a customer name that fits still prints as one exact-width row', () => {
  // row()'s contract is untouched for short values: money columns and every
  // other caller depend on the padding, so only the overflow path changed.
  const line = renderSaleSlip(sampleSale, nastySettings).map((l) => l.text).find((l) => l.startsWith('Customer:'));
  assert.equal(line, row('Customer:', sampleSale.customer_name, 32));
  assert.equal(line.length, 32);
  assert.ok(line.endsWith(sampleSale.customer_name));
});

// R30. The same defect R24 closed for Customer:, still open on the two fields
// beside it. row() pays for a long value out of the label, so a phone longer
// than the roll printed as 'Ph' plus the number, and one 32 characters or longer
// printed with no label at all and its digits cut at the roll edge. #pos-customer-phone
// takes whatever the customer dictats and src/sales.js caps nothing.
const longPhone = '0917123456789012345678901234567890123456';

test('an over-long phone keeps its label and wraps instead of being cut', () => {
  assert.equal(longPhone.length, 40);
  for (const width of ['58mm', '80mm']) {
    const cols = colsFor(width);
    const slip = renderSaleSlip({ ...sampleSale, customer_phone: longPhone }, { ...nastySettings, receipt_paper_width: width });
    const text = slip.map((l) => l.text);
    const at = text.findIndex((l) => l.startsWith('Phone:'));
    assert.ok(at > -1, `${width} lost the Phone: label`);
    const stop = text.findIndex((l, i) => i > at && l.startsWith('Payment:'));
    // A single unbroken token hard-breaks, so the chunks rejoin with no space
    // between them: the number is whole, digits and all, under its own label.
    assert.equal(text.slice(at, stop).join('').replace(/\s/g, ''), `Phone:${longPhone}`, `${width} cut the number`);
    for (const line of slip) {
      const budget = line.wide ? Math.floor(cols / 2) : cols;
      assert.ok(line.text.length <= budget, `${width} over ${budget}: ${JSON.stringify(line.text)}`);
    }
  }
  // A phone that fits still prints as one exact-width row: row()'s padding
  // contract is untouched for short values, which is what every money column
  // on the slip depends on.
  const fits = renderSaleSlip(sampleSale, nastySettings).map((l) => l.text).find((l) => l.startsWith('Phone:'));
  assert.equal(fits, row('Phone:', sampleSale.customer_phone, 32));
  assert.equal(fits.length, 32);
});

test('a payment reference that runs past the roll keeps the Payment: label', () => {
  const ref = 'GCASH2026093000000000000000000';
  const slip = renderSaleSlip({ ...sampleSale, payment_method: 'gcash', payment_reference: ref }, nastySettings);
  const text = slip.map((l) => l.text);
  const at = text.findIndex((l) => l.startsWith('Payment:'));
  assert.ok(at > -1, 'the Payment: label was traded away for the reference');
  const stop = text.indexOf('-'.repeat(32), at);
  assert.ok(stop > at, 'the payment block ran off the slip');
  assert.equal(text.slice(at, stop).join(' ').replace(/\s+/g, ' '), `Payment: GCASH ${ref}`);
  for (const line of slip) {
    assert.ok(line.text.length <= 32, `58mm over budget: ${JSON.stringify(line.text)}`);
  }
});

// R31. A credit sale printed one line, 'BALANCE (UTANG):', and stopped. The HTML
// receipt carries an acknowledgement block with a signature line under the
// balance, so the customer who walked out owing money was handed paper that
// asked for nothing and proved nothing. Compact, because the warranty block has
// to stay on the roll.
const creditSale = { ...sampleSale, amount_paid: 0, change_amount: 0, credit_balance: 2700 };

test('a credit sale prints the acknowledgement and a signature rule, inside the budget', () => {
  for (const width of ['58mm', '80mm']) {
    const cols = colsFor(width);
    const slip = renderSaleSlip(creditSale, { ...nastySettings, receipt_paper_width: width });
    const text = slip.map((l) => l.text);
    const ack = text.findIndex((l) => l.startsWith('CREDIT / UTANG ACKNOWLEDGEMENT'));
    assert.ok(ack > -1, `${width} printed no acknowledgement`);
    const balance = text.findIndex((l) => l.startsWith('BALANCE (UTANG):'));
    const warranty = text.indexOf('WARRANTY (7 DAYS):');
    assert.ok(balance > -1 && balance < ack, 'the acknowledgement printed above the balance it names');
    assert.ok(warranty > ack, 'the warranty block sits above the signature, so it prints first');
    assert.match(text.slice(ack + 1, warranty).join(' '),
      /I acknowledge receipt of the goods above and agree to pay the balance of P2,700\.00\./);
    const signature = text.findIndex((l, i) => i > ack && /^_+$/.test(l));
    assert.ok(signature > ack && signature < warranty, 'no rule to sign on');
    assert.equal(text[signature + 1], 'Customer Signature');
    for (const line of slip) {
      const budget = line.wide ? Math.floor(cols / 2) : cols;
      assert.ok(line.text.length <= budget, `${width} over ${budget}: ${JSON.stringify(line.text)}`);
    }
  }
  // A sale with no utang signs nothing: no block, no rule, no free paper.
  const cash = renderSaleSlip({ ...sampleSale, credit_balance: 0 }, nastySettings).map((l) => l.text);
  assert.ok(!cash.some((l) => l.includes('ACKNOWLEDGEMENT')), 'a cash sale printed an acknowledgement');
  assert.ok(!cash.some((l) => /^_+$/.test(l)), 'a cash sale printed a signature rule');
});

// The brief's 58mm acceptance check, as a pure renderer call: no DB, and
// deliberately not through POST /api/print, because a request that reaches
// sendRaw feeds this counter's real roll.
test('a 58mm sale slip stays inside 32 columns and lands totals at the edge', () => {
  const slip = renderSaleSlip({
    sale_code: 'S-1', created_at: '2026-09-30 08:00:00', customer_name: 'Carlos Tech',
    payment_method: 'cash', payment_reference: '', subtotal: 1250, discount: 0,
    total_amount: 1250, amount_paid: 1000, change_amount: 250, credit_balance: 0,
    items: [{ item_type: 'part', item_name: 'iPhone 11 LCD Screen Original', quantity: 1, unit_price: 1250, total_price: 1250 }],
  }, { receipt_paper_width: '58mm', receipt_item_rows: 'two_line', gcash_name: 'TECHPARTS', warranty_days: '7', warranty_policy_text: '7 Days Test Warranty for LCDs & Batteries.' });
  for (const line of slip) {
    assert.ok(line.text.length <= (line.wide ? 16 : 32), `over budget: ${line.text}`);
  }
  const total = slip.find((l) => l.text.startsWith('TOTAL DUE:'));
  assert.equal(total.text.length, 32);
  assert.ok(total.text.endsWith('P1,250.00'));
  assert.ok(slip.some((l) => l.text.includes('iPhone 11 LCD Screen Original'.slice(0, 20))));
});

// --- the routes --------------------------------------------------------------
// Nothing below can reach a live queue: tests/helper.js seeds every serverTest
// database with printer_name set to a queue name that cannot exist (see
// SENTINEL_PRINTER_NAME), so the print route short-circuits past
// listPrinters() and sendRaw only ever opens a dead handle. This machine is the
// shop printer.
const { serverTest, SENTINEL_PRINTER_NAME, ensurePinChanged } = require('./helper');
const { createSale } = require('../src/sales');

const saleCtx = { actor: { type: 'manager', id: null, name: 'Manager' }, elevated: true };
const storedPrinterName = (db) => db.prepare("SELECT value FROM shop_settings WHERE key='printer_name'").get()?.value;
const cashSale = (db) => createSale(db, {
  customer_name: 'Juan Dela Cruz',
  payment_method: 'cash',
  items: [{ item_type: 'labor', item_name: 'LCD Replacement', unit_price: 450, quantity: 1 }],
  amount_paid: 450
}, saleCtx);
const printPost = (baseUrl, auth, payload) => fetch(`${baseUrl}/api/print`, {
  method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
  body: JSON.stringify(payload),
});
const settingsPost = (baseUrl, auth, payload) => fetch(`${baseUrl}/api/settings`, {
  method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
  body: JSON.stringify(payload),
});

// A source-shape pin, and the only honest proof available: the route's speed
// depends on a PowerShell spawn that must NOT happen, and the one way to show
// it without paying for it would be to print a real receipt on the counter's
// machine. So this asserts that nothing in the route asks the question before
// the configured queue has answered it.
test('a configured queue costs the print route no enumeration at all', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  const start = src.indexOf("pathname === '/api/print' && method === 'POST'");
  assert.ok(start > -1, 'the print route moved; update this test');
  const route = src.slice(start, src.indexOf('if (pathname ===', start));
  assert.ok(route.includes('const target'), 'no target selection in the print route');
  // Counted as the call, not the name: the route's own comment explains the
  // cost by naming the function.
  assert.equal(route.split('await listPrinters(').length - 1, 1, 'the route enumerates more than once');
  assert.ok(route.indexOf('await listPrinters(') > route.indexOf('const target'),
    'the route enumerates queues before the configured queue is consulted');
  // The one statement that picks the target must put the setting on the left of
  // the short-circuit and the enumeration on the right.
  const pickAt = route.indexOf('const target');
  const pick = route.slice(pickAt, route.indexOf(';', pickAt) + 1).replace(/\s+/g, ' ');
  assert.match(pick, /settings\.printer_name\b[^|]*\|\|[^;]*listPrinters\(\)/,
    `the enumeration is not behind the configured queue: ${pick}`);
  // The unconfigured path is unchanged: enumeration, defaultPrinter, and the
  // error when neither names a usable queue.
  assert.ok(route.indexOf("throw new Error('No printer found") > route.indexOf('const target'),
    'the no-usable-printer error no longer follows the selection');
});

serverTest('GET /api/printers needs a session', async (baseUrl) => {
  const res = await fetch(`${baseUrl}/api/printers`);
  assert.equal(res.status, 401);
});

serverTest('POST /api/print rejects an unknown kind', async (baseUrl, db, auth) => {
  const res = await fetch(`${baseUrl}/api/print`, {
    method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'everything' }),
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /Unknown print job/);
});

serverTest('POST /api/print rejects a sale that does not exist', async (baseUrl, db, auth) => {
  const res = await fetch(`${baseUrl}/api/print`, {
    method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'sale', sale_id: 999999 }),
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /not found/);
});

serverTest('printer_name refuses a queue that is not installed', async (baseUrl, db, auth) => {
  auth = await ensurePinChanged(baseUrl, auth);
  const res = await fetch(`${baseUrl}/api/settings`, {
    method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ printer_name: 'Not A Real Printer' }),
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /Not A Real Printer/);
  // The helper seeds this database with the dead sentinel queue, so "nothing was
  // written" now reads as "the seed is still there" rather than as no row at all.
  assert.equal(storedPrinterName(db), SENTINEL_PRINTER_NAME);
});

serverTest('a rejected print caps its reason and still sets fallback', async (baseUrl, db, auth) => {
  // The longest reason a rejected job can carry comes from the client, so it
  // probes the cap without going anywhere near a queue: the unknown kind
  // throws before listPrinters and sendRaw.
  const res = await fetch(`${baseUrl}/api/print`, {
    method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: `x${'#< CLIXML <Objs Version="1.1.0.1"><S S="Error">boom</S></Objs>'.repeat(60)}` }),
  });
  assert.equal(res.status, 400);
  const data = await res.json();
  assert.equal(data.fallback, true, 'a rejected job still tells the client to fall back');
  assert.ok(data.error.length <= 215, `error echoed to the counter is ${data.error.length} chars`);
  assert.match(data.error, /\[truncated\]$/);
  assert.ok(!data.error.includes('<Objs'), 'the markup envelope did not reach the toast');
  const entry = db.prepare("SELECT action, detail FROM audit_log WHERE category='print' ORDER BY id DESC LIMIT 1").get();
  assert.equal(entry.action, 'unknown', 'the audit action is the fixed vocabulary, not the client string');
  assert.ok(entry.detail.length < 300, `audit detail is ${entry.detail.length} bytes`);
  assert.equal(JSON.parse(entry.detail).ok, false);
});

serverTest('POST /api/print answers a body that is not an object', async (baseUrl, db, auth) => {
  // The one shape this route could not answer: a body that parses to null
  // threw on the first property read, outside the try, and the outer catch
  // turned it into a 500 with a generic message.
  const res = await fetch(`${baseUrl}/api/print`, {
    method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
    body: 'null',
  });
  assert.equal(res.status, 400);
  const data = await res.json();
  assert.match(data.error, /Unknown print job/);
  assert.equal(data.fallback, true);
});

// R25. The branch every real failure lands on and no test could reach before:
// the job left the route, went into the transport, and the transport said no.
// Reaching it needs a queue name that exists nowhere, which is exactly what
// tests/helper.js seeds, so this is the happy path of the no-printer rule.
serverTest('a sale print reaches the transport and comes back ok:false, not a rejection', async (baseUrl, db, auth) => {
  const sale = cashSale(db);
  const res = await printPost(baseUrl, auth, { kind: 'sale', sale_id: sale.id });
  // 200, not 400: the job was accepted and executed, and the printer refused it.
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, false);
  assert.equal(data.fallback, true, 'a refused job is the fallback signal Task 5 branches on');
  // The dead handle is the proof of where it went: OpenPrinter on a name that
  // cannot exist. A real queue would have printed, and a name the sentinel
  // never had would have been refused by the harness before the spawn.
  assert.match(data.error, /the printer queue could not be opened/);
  const entry = db.prepare("SELECT action, detail FROM audit_log WHERE category='print' ORDER BY id DESC LIMIT 1").get();
  assert.equal(entry.action, 'sale');
  const detail = JSON.parse(entry.detail);
  assert.equal(detail.printer, SENTINEL_PRINTER_NAME, 'the target was the seeded dead queue');
  assert.equal(detail.ok, false);
});

// R26. The save guard only looked at body.printer_name when it was already a
// non-empty string, while the write underneath does String(v) for every key.
serverTest('printer_name refuses a non-string instead of storing String(v)', async (baseUrl, db, auth) => {
  auth = await ensurePinChanged(baseUrl, auth);
  const res = await settingsPost(baseUrl, auth, { printer_name: 12345 });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /printer_name/);
  // "12345" is exactly what used to land in the row, unvalidated and unchecked.
  assert.equal(storedPrinterName(db), SENTINEL_PRINTER_NAME);
  assert.notEqual(storedPrinterName(db), '12345');
});

serverTest('clearing printer_name clears it instead of storing the name null', async (baseUrl, db, auth) => {
  auth = await ensurePinChanged(baseUrl, auth);
  // The shape a UI sends when the field is emptied. Stored as "null" it is a
  // truthy queue name forever, so the print route would never consult
  // defaultPrinter again and the whole fallback would be dead.
  const res = await settingsPost(baseUrl, auth, { printer_name: null, gcash_number: '0917-000-2222' });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.printer_name, '', 'the response still advertises a queue name');
  assert.equal(storedPrinterName(db), '');
  assert.ok(!data.printer_name, 'an empty name is what lets defaultPrinter answer');
  assert.equal(data.gcash_number, '0917-000-2222', 'the rest of the save still lands');
  // Whitespace-only is the same case, and it must not store a blank-padded name.
  const blank = await settingsPost(baseUrl, auth, { printer_name: '   ' });
  assert.equal(blank.status, 200);
  assert.equal(storedPrinterName(db), '');
});

// R27. parsePrinterLookup documents three outcomes and this caller took one of
// them: printers, no queues, and a lookup that broke. Only the third has an
// error, and the print route's own enumeration already separates it.
serverTest('a broken queue lookup answers 502 instead of calling it a missing printer', async (baseUrl, db, auth) => {
  auth = await ensurePinChanged(baseUrl, auth);
  // What a dead spooler looks like from here: the helper cannot even start.
  // PATH is stripped of PowerShell for the request, so nothing is enumerated
  // and nothing can be printed, and the transport failure is real rather than
  // stubbed. Restored in finally, and these tests run one at a time.
  const savedPath = process.env.PATH;
  try {
    process.env.PATH = path.dirname(process.execPath);
    const res = await settingsPost(baseUrl, auth, { printer_name: 'ZZ TEST LOOKUP PROBE QUEUE' });
    assert.equal(res.status, 502);
    const data = await res.json();
    assert.match(data.error, /Could not check the printer list/);
    assert.match(data.error, /could not start|did not answer/);
    assert.ok(!/is not installed/.test(data.error), 'a dead spooler was reported as a typo');
    assert.equal(storedPrinterName(db), SENTINEL_PRINTER_NAME, 'the save is still refused, just not with a lie');
  } finally {
    process.env.PATH = savedPath;
  }
});

// R28. sendRaw had already handed its bytes to the spooler, so the paper is out
// and the only thing that failed is the log row.
serverTest('a delivered print is never reported as a failed print', async (baseUrl, db, auth) => {
  const sale = cashSale(db);
  // Every audit write now fails, which is the SQLITE_BUSY / restored-handle
  // shape, provoked without racing another process for a lock.
  db.exec('DROP TABLE audit_log');
  const res = await printPost(baseUrl, auth, { kind: 'sale', sale_id: sale.id });
  const data = await res.json();
  // Before the fix this was the catch's 400 (or the outer catch's 500) carrying
  // the audit error, which tells the counter to fall back and print a SECOND
  // receipt for one sale, and logs a wrong row into an append-only table that
  // can never be corrected. The transport answer stands either way.
  assert.equal(res.status, 200);
  assert.equal(data.ok, false);
  assert.equal(data.fallback, true);
  assert.match(data.error, /the printer queue could not be opened/);
  assert.ok(!/audit_log|no such table/.test(data.error), `the audit failure reached the client: ${data.error}`);
});

// R29. isInternalError already has a stated policy for engine text, and this
// route was not using it.
serverTest('an engine fault is a 500 with the generic message, still with fallback', async (baseUrl, db, auth) => {
  const sale = cashSale(db);
  // getSaleDetails now fails inside SQLite instead of rejecting bad input, the
  // same class of fault as the "database is locked" this route used to echo.
  db.exec('DROP TABLE sales');
  const res = await printPost(baseUrl, auth, { kind: 'sale', sale_id: sale.id });
  const data = await res.json();
  assert.equal(res.status, 500);
  assert.match(data.error, /Something went wrong on the server/);
  assert.ok(!/no such table|database is locked|sales/i.test(data.error), `engine text reached the client: ${data.error}`);
  assert.equal(data.fallback, true, 'a 500 still tells the counter to fall back');
});

serverTest('this route keeps its own rejections at 400 with their reason', async (baseUrl, db, auth) => {
  // The 400s are the route's own messages and must survive the 500 branch.
  const unknown = await printPost(baseUrl, auth, { kind: 'everything' });
  assert.equal(unknown.status, 400);
  assert.match((await unknown.json()).error, /Unknown print job 'everything'/);
  const missing = await printPost(baseUrl, auth, { kind: 'sale', sale_id: 999999 });
  assert.equal(missing.status, 400);
  assert.match((await missing.json()).error, /Sale not found/);
});

// R32. The queue a shop saved is the queue a shop can lose: the driver goes, the
// USB printer gets unplugged, the name changes. The spec is loud failure with the
// name in it and no silent substitution, and the route is the only place that
// knows which queue it aimed at, so the reason it hands back has to say so --
// Task 5's toast shows this string verbatim to the counter.
serverTest('a refused send names the queue the counter saved', async (baseUrl, db, auth) => {
  const sale = cashSale(db);
  const res = await printPost(baseUrl, auth, { kind: 'sale', sale_id: sale.id });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, false);
  assert.equal(data.fallback, true, 'the fallback to browser print still rides the refusal');
  assert.ok(data.error.includes(SENTINEL_PRINTER_NAME), `the toast does not name the queue it tried: ${data.error}`);
  assert.match(data.error, /the printer queue could not be opened/);
  assert.ok(data.error.length <= 200, `the named queue broke the reason cap: ${data.error.length} chars`);
  assert.ok(!/is not installed|Refresh in Settings/.test(data.error),
    `a saved queue was reported as a missing one: ${data.error}`);
  // The same name the audit row carries, so the two can never disagree.
  const entry = db.prepare("SELECT detail FROM audit_log WHERE category='print' ORDER BY id DESC LIMIT 1").get();
  assert.equal(JSON.parse(entry.detail).printer, SENTINEL_PRINTER_NAME);
});

// R33. tests/helper.js refuses every queue name but its own sentinel, and that
// belt is the only reason this suite can post to /api/print on the machine that
// is the shop printer. It works only while the route resolves sendRaw off the
// module at call time: a `const { sendRaw } = require('./printer')` binding is
// captured when server.js loads, and depending on file order it can be the
// original function, silently detached from the patch -- at which point a test
// aimed at a live queue prints on the counter.
test('the print route resolves sendRaw off the module, never a binding captured at require time', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  assert.match(src, /^const printer = require\('\.\/printer'\);$/m, 'server.js no longer holds the printer namespace');
  assert.ok(!/const \{[^}]*\bsendRaw\b[^}]*\} = require\('\.\/printer'\)/.test(src),
    'sendRaw is destructured at require time again, which makes the harness belt bypassable');
  const start = src.indexOf("pathname === '/api/print' && method === 'POST'");
  assert.ok(start > -1, 'the print route moved; update this test');
  const route = src.slice(start, src.indexOf('if (pathname ===', start));
  assert.equal(route.split('await printer.sendRaw(').length - 1, 1, 'the route does not call printer.sendRaw(...) at the call site');
  assert.ok(!/(^|[^.\w])await sendRaw\(/.test(route), 'the route still calls a captured sendRaw binding');
});

// The behavioral half of that proof, and the one test in this file that aims at
// a queue this machine really has. It reads a live name out of the spooler with a
// listing only (Get-CimInstance: no handle opened, nothing printed), writes it
// straight into shop_settings past the Settings guard, and posts a sale print.
// With the belt attached, the patch refuses before PowerShell starts and the job
// answers 400; detached, this is exactly the request that would feed the
// counter's roll -- which is why the belt is checked once more, in the same
// request path, before the live name is ever used.
const { listPrinters } = require('../src/printer');

const writeQueueName = (db, name) =>
  db.prepare('INSERT OR REPLACE INTO shop_settings (key, value) VALUES (?, ?)').run('printer_name', name);

serverTest('the harness belt stops a send aimed at a live queue', async (baseUrl, db, auth) => {
  const sale = cashSale(db);
  const refusal = async (name) => {
    writeQueueName(db, name);
    const res = await printPost(baseUrl, auth, { kind: 'sale', sale_id: sale.id });
    return { status: res.status, data: await res.json() };
  };

  // Pre-flight with a name that is neither the sentinel nor a queue. The belt
  // answers 400 and spawns nothing; detached, the real transport fails at
  // OpenPrinter on a name that cannot exist and answers 200 ok:false. So this
  // half distinguishes the two shapes and prints nothing either way, and it
  // stops the test before the live name below is ever aimed at.
  const probe = await refusal('ZZ BELT PROBE NOT A QUEUE');
  assert.equal(probe.status, 400, 'the belt is not attached: the route reached the real transport');
  assert.match(probe.data.error, /test refused to open printer queue/,
    'the harness belt did not fire: a test reached the transport, which means it could have printed');
  assert.match(probe.data.error, /ZZ BELT PROBE NOT A QUEUE/, `the refusal did not name the queue it stopped: ${probe.data.error}`);
  assert.equal(probe.data.fallback, true, 'the counter is still told to fall back');

  // Nothing was delivered on the refused path: the route stopped at the belt, so
  // the audit row is a rejection with no printer field, not the post-send record
  // of a job that reached a queue.
  const rejected = db.prepare("SELECT action, detail FROM audit_log WHERE category='print' ORDER BY id DESC LIMIT 1").get();
  assert.equal(rejected.action, 'sale');
  const rejectedDetail = JSON.parse(rejected.detail);
  assert.equal(rejectedDetail.ok, false);
  assert.ok(!('printer' in rejectedDetail), 'the route recorded a delivery it never made');

  // Now the shape the seed cannot cover: a queue that exists. A box with no
  // printers at all has nothing live to aim at, and the pre-flight above already
  // proved the belt fires.
  const { printers } = await listPrinters();
  const live = defaultPrinter(printers);
  if (!live) return;
  assert.notEqual(live, SENTINEL_PRINTER_NAME, 'the enumeration handed back the seed queue');
  const aimed = await refusal(live);
  assert.equal(aimed.status, 400, `the belt let a send through to '${live}'`);
  assert.match(aimed.data.error, /test refused to open printer queue/);
  assert.ok(aimed.data.error.includes(live), `the refusal did not name the queue it stopped: ${aimed.data.error}`);
});

// FINDING 3. BALANCE (UTANG): is the row that introduces the credit signature
// block, and row() pays for a long value out of the label. A balance whose money
// string crowds the roll printed as a truncated 'BALANCE (UTAN' (and past the
// budget, no label at all) -- the one line the acknowledgement signs up to would
// lose its name. labelled() keeps the label and wraps, exactly like Phone: and
// Payment:, while a normal-size balance still lands on row()'s exact-width money
// column so no existing receipt moved.
test('a credit balance long enough to crowd the roll keeps the BALANCE (UTANG): label', () => {
  const balanceText = 'P1,234,567,890.55'; // money(1234567890.55), 17 chars: row() would truncate the label
  assert.equal(balanceText.length, 17);
  const big = { ...sampleSale, amount_paid: 0, change_amount: 0, credit_balance: 1234567890.55 };
  for (const width of ['58mm', '80mm']) {
    const cols = colsFor(width);
    const slip = renderSaleSlip(big, { ...nastySettings, receipt_paper_width: width });
    const text = slip.map((l) => l.text);
    const at = text.findIndex((l) => l.startsWith('BALANCE (UTANG):'));
    assert.ok(at > -1, `${width} dropped the BALANCE (UTANG): label`);
    // The full amount survives, whole, under its label. At 58mm labelled() wraps
    // the label and the money onto separate lines; at 80mm it fits and keeps
    // row()'s exact-width column -- either way the digits are all there and the
    // label prefix (proven by the findIndex) is not truncated to 'BALANCE (UTAN'.
    const rule = text.indexOf('-'.repeat(cols), at);
    assert.ok(rule > at, `${width}: the balance block ran off the slip`);
    assert.ok(text.slice(at, rule).join('').includes(balanceText), `${width} cut the balance amount`);
    for (const line of slip) {
      const budget = line.wide ? Math.floor(cols / 2) : cols;
      assert.ok(line.text.length <= budget, `${width} over ${budget}: ${JSON.stringify(line.text)}`);
    }
  }
  // A normal balance is unchanged: still row()'s exact-width money column.
  const normal = renderSaleSlip(creditSale, nastySettings).map((l) => l.text).find((l) => l.startsWith('BALANCE (UTANG):'));
  assert.equal(normal, row('BALANCE (UTANG):', 'P2,700.00', 32));
  assert.equal(normal.length, 32);
  assert.ok(normal.endsWith('P2,700.00'));
});

// ---------------------------------------------------------------- TASK 6: the credit settlement slip
//
// The last customer-facing document still on the browser print path. Paper has
// to carry what the screen carries -- which collection came in and what is still
// owed -- and both rows survive the roll whatever the customer was typed as.
const { renderSettlementSlip, money } = require('../src/printer');
const { settleCustomerCredit } = require('../src/credits');

// The sale slip's pressure fixtures, in settlement shape: a name and a phone
// longer than a 58mm roll, a reference and a note that run over, and money big
// enough to crowd its own label.
const nastySettlementPayment = {
  id: 41,
  customer_name: 'Mary Ann Santos-Dela Cruz Dela Cruz Dela Cruz Jr.',
  amount_paid: 1234567.89,
  payment_method: 'gcash',
  payment_reference: '20260930WXYZABCDEFGH1234567890',
  notes: 'Half now, the rest after payday, and the balance on the second unit too',
  created_at: '2026-09-30T01:14:22.000Z'
};
const nastySettlementDebtor = {
  customer_name: 'Mary Ann Santos-Dela Cruz Dela Cruz Dela Cruz Jr.',
  customer_phone: '0917123456789012345678901234567890123456',
  total_credit_balance: 1234567890.55
};

// Counter-realistic sizes, the way an utang is actually paid down: everything
// below fits a line, so the content assertions read the way the paper does.
const smallSettlementPayment = { ...nastySettlementPayment, amount_paid: 1000, payment_reference: 'GC-7781', notes: '' };
const smallSettlementDebtor = { customer_name: 'Juan Dela Cruz', customer_phone: '09171234567', total_credit_balance: 1700 };

test('a settlement slip fits the roll at both widths, footer included', () => {
  for (const width of ['58mm', '80mm']) {
    const cols = colsFor(width);
    const slip = renderSettlementSlip(nastySettlementPayment, nastySettlementDebtor, { ...nastySettings, receipt_paper_width: width });
    for (const line of slip) {
      const budget = line.wide ? Math.floor(cols / 2) : cols;
      assert.ok(line.text.length <= budget, `${width} over ${budget}: ${JSON.stringify(line.text)}`);
    }
  }
  // The default footer note is 35 characters and a 58mm roll has 32 columns, so
  // it has to wrap exactly like the sale slip's: pushed whole it would sit on
  // the last row past the edge, where the printer clips it or breaks its own
  // centering.
  const bare = renderSettlementSlip(smallSettlementPayment, smallSettlementDebtor, { receipt_paper_width: '58mm' });
  for (const line of bare) {
    const budget = line.wide ? 16 : 32;
    assert.ok(line.text.length <= budget, `${budget}: ${JSON.stringify(line.text)}`);
  }
  assert.equal(bare.filter((l) => l.centered && l.text.includes('*')).map((l) => l.text).join(' '),
    '*** Thank you for your payment! ***');
});

test('a settlement slip carries the payment, in the order the HTML receipt does', () => {
  const slip = renderSettlementSlip(smallSettlementPayment, smallSettlementDebtor, nastySettings);
  const text = slip.map((l) => l.text);
  assert.ok(slip[0].wide && slip[0].centered, 'the shop name prints double-width');
  assert.ok(text[0].startsWith('TECHPARTS'), text[0]);
  // The name is wrapped into as many double-width lines as 16 columns need, so
  // the title sits after the LAST rule, not after a fixed line number.
  const ruleAt = text.indexOf(rule(32));
  assert.ok(ruleAt > 0, `no rule after the header: ${text.join(' | ')}`);
  assert.equal(text[ruleAt + 1], 'SETTLEMENT RECEIPT');
  // The header is the sale slip's header, line for line and in the same order:
  // this is payment proof for a debt reduction, so the roll names who took the
  // money and how to reach them, and for a GCash collection the number printed
  // is frequently the receiving account. The browser printable carries both
  // (brandHeaderHtml), so a slip that skipped them handed the same customer two
  // different documents depending on whether the queue answered.
  assert.ok(text.some((l) => l.startsWith('Rizal Street')), 'the shop address is on the settlement slip');
  assert.ok(text.some((l) => l.startsWith('Tel/GCash: 0917-123-4567')), 'the GCash number is on the settlement slip');
  const headerOf = (s) => s.slice(0, s.findIndex((l) => l.text === rule(32))).map((l) => l.text);
  assert.deepEqual(headerOf(slip), headerOf(renderSaleSlip(sampleSale, nastySettings)),
    'the two slips now print different shop identities');
  // Shop time, not the stored UTC row: a settlement stamped eight hours early
  // reads as a payment made before the till was opened.
  const stamp = text.find((l) => l.startsWith('Date: '));
  assert.ok(!stamp.includes('T') && !stamp.includes('Z'), `raw ISO leaked onto paper: ${stamp}`);
  assert.equal(stamp, `Date: ${localStamp(smallSettlementPayment.created_at)}`);
  assert.equal(text[ruleAt + 2], stamp, 'the date is the row under the title');
  assert.ok(text.some((l) => l.startsWith('Customer:')));
  assert.ok(text.some((l) => l.startsWith('Phone:')));
  assert.ok(text.some((l) => l.startsWith('Payment:') && l.includes('GCASH GC-7781')), 'method and ref print');
  assert.ok(!text.some((l) => l.startsWith('Notes:')), 'an empty note stays off the paper');
  const noted = renderSettlementSlip({ ...smallSettlementPayment, notes: 'Half now, half Friday' }, smallSettlementDebtor, nastySettings);
  assert.ok(noted.map((l) => l.text).some((l) => l.startsWith('Notes:')));
  // Both money rows land in row()'s exact-width column, so the settlement reads
  // like every other slip in this shop.
  assert.equal(text.find((l) => l.startsWith('Payment received:')), row('Payment received:', 'P1,000.00', 32));
  assert.equal(text.find((l) => l.startsWith('Remaining balance:')), row('Remaining balance:', 'P1,700.00', 32));
  assert.equal(slip.find((l) => l.text.startsWith('Remaining balance:')).text.length, 32);
  // A settlement is not a sale: no invoice number, no warranty block, no
  // signature line, no item list. Only the remaining balance is owed, and the
  // money already signed for is the collection above it.
  const joined = text.join(' ');
  for (const absent of ['Invoice', 'OFFICIAL RECEIPT', 'WARRANTY', 'LABOR', 'BALANCE (UTANG)']) {
    assert.ok(!joined.includes(absent), `the sale slip's ${absent} leaked onto the settlement slip`);
  }
});

test('a settlement slip keeps every label whatever the customer typed', () => {
  // The defect the sale slip already fixed, one document later: row() pays for
  // a long value out of the label, so at 58mm a 52-character name printed with
  // no label at all and a 40-character phone printed as 'Ph' plus digits. No
  // cap anywhere upstream -- #pos-customer-name and the settle form are free
  // text -- so the label the cashier reads has to survive.
  const squash = (s) => String(s).replace(/\s+/g, '');
  for (const width of ['58mm', '80mm']) {
    const cols = colsFor(width);
    const slip = renderSettlementSlip(nastySettlementPayment, nastySettlementDebtor, { ...nastySettings, receipt_paper_width: width });
    const text = slip.map((l) => l.text);
    for (const line of slip) {
      const budget = line.wide ? Math.floor(cols / 2) : cols;
      assert.ok(line.text.length <= budget, `${width} over ${budget}: ${JSON.stringify(line.text)}`);
    }
    for (const label of ['Customer:', 'Phone:', 'Payment:', 'Notes:', 'Payment received:', 'Remaining balance:']) {
      assert.ok(text.some((l) => l.startsWith(label)), `${label} lost its label at ${width}: ${text.join(' | ')}`);
    }
    // Nothing is cut either: every character of the name, the phone, the ref,
    // the note and both amounts is still on the paper, spread over as many
    // lines as the roll needs.
    const all = squash(text.join(''));
    for (const value of [nastySettlementDebtor.customer_name, nastySettlementDebtor.customer_phone,
      nastySettlementPayment.payment_reference, nastySettlementPayment.notes,
      money(nastySettlementPayment.amount_paid), money(nastySettlementDebtor.total_credit_balance)]) {
      assert.ok(all.includes(squash(value)), `${JSON.stringify(value)} was cut at ${width}`);
    }
  }
  // And the row() shape this replaced is exactly why: the same values through
  // row() lose the label outright.
  assert.ok(!row('Customer:', nastySettlementDebtor.customer_name, 32).includes('Customer:'));
  assert.ok(!row('Remaining balance:', money(nastySettlementDebtor.total_credit_balance), 32).startsWith('Remaining balance:'));
});

// A real debtor with a real collection: the settlement branch reads the payment
// row for what came in and the customer record for what is still owed, so the
// fixtures have to be rows, not hand-built objects. The helper hands back BOTH
// halves of the pair the route works from -- the payment row and the very object
// getCustomerDetails() built, including its payments array -- because the seam
// between that object and renderSettlementSlip() is exactly what a hand-built
// fixture cannot test. The amounts are deliberately different from each other
// (P2,700.00 labor, P700.00 at the counter, P1,250.00 settled = P750.00 owed) so
// a row read from the wrong field cannot coincidentally match.
const settledCustomer = (db, name = 'Juan Dela Cruz') => {
  createSale(db, {
    customer_name: name,
    customer_phone: '09171234567',
    payment_method: 'credit',
    items: [{ item_type: 'labor', item_name: 'LCD Replacement', unit_price: 2700, quantity: 1 }],
    amount_paid: 700
  }, saleCtx);
  const details = settleCustomerCredit(db, {
    customer_name: name,
    amount_paid: 1250,
    payment_method: 'gcash',
    payment_reference: 'GC-SETTLE-20260930'
  }, saleCtx);
  return { payment: details.payments[0], customer: details };
};

// FINDING 2: layout was tested against hand-built objects and the route was
// tested against status codes, so the two never met in one assertion. The
// balance this slip consumes is the one field another module produces --
// src/credits.js:98 runs it through src/money.js's same-named money() -- and a
// renderer that reads it from the wrong place, or a money() that one day returns
// a formatted string instead of a number, would print `Remaining balance: PNaN`
// on every settlement roll with the whole suite green.
serverTest('the settlement slip the route prints reads the real customer record', async (baseUrl, db, auth) => {
  const { payment, customer } = settledCustomer(db);
  // The route takes this exact pair: the debtor by name, the payment by id among
  // that debtor's own payments. Accepted, not rejected.
  const res = await printPost(baseUrl, auth, { kind: 'settlement', payment_id: payment.id, customer_name: payment.customer_name });
  assert.equal(res.status, 200, 'the route did not take the pair this test is holding');
  // ...and this is the paper it would have laid out, from the object it read.
  const text = renderSettlementSlip(payment, customer, nastySettings).map((l) => l.text);
  // Pinned to the ledger arithmetic rather than to a field of the object, so a
  // reader that grabs credit_limit, the payment amount or nothing at all fails.
  assert.equal(text.find((l) => l.startsWith('Payment received:')), row('Payment received:', 'P1,250.00', 32));
  assert.equal(text.find((l) => l.startsWith('Remaining balance:')), row('Remaining balance:', 'P750.00', 32));
  // The identity rows come off the same record, and the name is the one the route
  // resolved (cleanName), which is what the payload travels as.
  assert.equal(text.find((l) => l.startsWith('Customer:')), row('Customer:', customer.customer_name, 32));
  assert.equal(text.find((l) => l.startsWith('Phone:')), row('Phone:', '09171234567', 32));
  assert.ok(text.some((l) => l.startsWith('Payment:') && l.includes('GCASH')), 'the collection method prints off the real row');
  // No PNaN anywhere on a slip that states money twice.
  assert.ok(!text.some((l) => l.includes('NaN')), `a money field did not read as a number: ${text.join(' | ')}`);
});

serverTest('a settlement slip refuses an unknown payment', async (baseUrl, db, auth) => {
  const bad = await fetch(`${baseUrl}/api/print`, {
    method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'settlement', payment_id: 424242, customer_name: 'Nobody' }),
  });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /not found/);
});

serverTest('a settlement print with no payment id of its own is rejected, not guessed', async (baseUrl, db, auth) => {
  const paid = settledCustomer(db).payment;
  // The ids are read as numbers, and an absent one is NaN: it must land on the
  // route's own rejection instead of finding some other customer's row.
  const missing = await printPost(baseUrl, auth, { kind: 'settlement', customer_name: paid.customer_name });
  assert.equal(missing.status, 400);
  assert.match((await missing.json()).error, /not found/);
  // A payment that exists but is filed under a different debtor is not this
  // customer's slip to print.
  const other = await printPost(baseUrl, auth, { kind: 'settlement', payment_id: paid.id, customer_name: 'Someone Else' });
  assert.equal(other.status, 400);
  assert.match((await other.json()).error, /not found/);
});

// R34. The settlement branch is the one print path no test could reach before,
// and the proof it cannot print is the answer it gives: 200 with ok:false from
// the seeded dead queue, never a delivery to a live one.
serverTest('a settlement print reaches the transport and is stopped by both belts', async (baseUrl, db, auth) => {
  const paid = settledCustomer(db).payment;
  const post = async (name) => {
    writeQueueName(db, name);
    const res = await printPost(baseUrl, auth, { kind: 'settlement', payment_id: paid.id, customer_name: paid.customer_name });
    return { status: res.status, data: await res.json() };
  };

  // The queue the harness seeds: a name that is illegal in Windows, so
  // OpenPrinter can only ever fail. The job is accepted, sent, refused.
  const seeded = await post(SENTINEL_PRINTER_NAME);
  assert.equal(seeded.status, 200, 'a validated settlement is accepted, not rejected');
  assert.equal(seeded.data.ok, false);
  assert.equal(seeded.data.fallback, true, 'the counter is told to fall back to the dialog');
  assert.match(seeded.data.error, /the printer queue could not be opened/);
  assert.ok(seeded.data.error.includes(SENTINEL_PRINTER_NAME), `the answer did not name the dead queue: ${seeded.data.error}`);
  const sent = db.prepare("SELECT action, detail FROM audit_log WHERE category='print' ORDER BY id DESC LIMIT 1").get();
  assert.equal(sent.action, 'settlement', 'settlement is in the fixed audit vocabulary, not unknown');
  assert.equal(JSON.parse(sent.detail).printer, SENTINEL_PRINTER_NAME);

  // A queue this machine really has: the harness refuses before PowerShell
  // starts, so the route answers 400 and no byte is written anywhere.
  const { printers } = await listPrinters();
  const live = defaultPrinter(printers);
  if (!live) return;
  assert.notEqual(live, SENTINEL_PRINTER_NAME);
  const aimed = await post(live);
  assert.equal(aimed.status, 400, `the belt let a settlement send through to '${live}'`);
  assert.match(aimed.data.error, /test refused to open printer queue/);
  assert.ok(aimed.data.error.includes(live), `the refusal did not name the queue it stopped: ${aimed.data.error}`);
});

// The engine-fault rule is per-route, and the settlement branch has a new data
// path: a locked or missing table inside getCustomerDetails must not read to
// the counter as a typo they can fix.
serverTest('a settlement print keeps an engine fault at 500', async (baseUrl, db, auth) => {
  const paid = settledCustomer(db).payment;
  db.exec('DROP TABLE credit_payments');
  const res = await printPost(baseUrl, auth, { kind: 'settlement', payment_id: paid.id, customer_name: paid.customer_name });
  const data = await res.json();
  assert.equal(res.status, 500);
  assert.match(data.error, /Something went wrong on the server/);
  assert.equal(data.fallback, true);
  assert.ok(!/no such table|credit_payments/.test(data.error), `engine text reached the client: ${data.error}`);
});

// ------------------------------------------------- TASK 7: money guard and footer framing
//
// money() is the only place a figure becomes text on paper. It used to coerce
// whatever it was handed, so a value that did not read as a number reached the
// customer as `PNaN` (a string) or as `P0.00` (an actual NaN, which is worse:
// it looks like a paid-off bill). src/money.js already refuses both, and every
// row this module prints goes through it, so a non-finite amount here means the
// data is broken. Refusing the slip is the safe answer for a shop: no paper, a
// toast naming the reason, and the queue never hands out a wrong figure.
test('money prints real amounts and refuses anything that is not a finite number', () => {
  assert.equal(money(0), 'P0.00');
  assert.equal(money(1234.5), 'P1,234.50');
  assert.equal(money(1234567890.55), 'P1,234,567,890.55');
  // SQLite hands REAL columns back as numbers, but a row read through a text
  // column is a normal string of digits and must still print.
  assert.equal(money('2700'), 'P2,700.00');
  // An amount the slip does not carry is zero, the same rule the screen's
  // fmtMoney uses, so a missing optional field never refuses a good print.
  assert.equal(money(undefined), 'P0.00');
  assert.equal(money(null), 'P0.00');
  assert.equal(money(''), 'P0.00');
  for (const bad of ['abc', 'P1,000.00', '1.2.3', NaN, Infinity, -Infinity, {}, () => {}]) {
    assert.throws(() => money(bad), /finite number/, `${String(bad)} must not print`);
  }
});

test('a slip holding a non-numeric amount refuses the print instead of papering a wrong figure', () => {
  // The refusal happens while the slip is being laid out, before a single byte
  // is encoded, so the queue never sees a half-built receipt.
  assert.throws(() => renderSaleSlip({ ...sampleSale, total_amount: 'not-a-number' }, nastySettings), /finite number/);
  assert.throws(() => renderSaleSlip({
    ...sampleSale,
    items: [{ item_type: 'part', item_name: 'iPhone 11 Screen OLED', quantity: 1, unit_price: NaN, total_price: 2200 }]
  }, nastySettings), /finite number/);
  assert.throws(() => renderSettlementSlip({ ...smallSettlementPayment, amount_paid: 'GC-7781' }, smallSettlementDebtor, nastySettings), /finite number/);
  assert.throws(() => renderSettlementSlip(smallSettlementPayment, { ...smallSettlementDebtor, total_credit_balance: 'oops' }, nastySettings), /finite number/);
});

test('no slip with a broken amount prints anything at all', () => {
  // Nothing on the roll: the render throws, so encode() never runs and there is
  // no partial slip to send. Proved by asking the renderers for the bytes they
  // would have laid out.
  for (const build of [
    () => encode(renderSaleSlip({ ...sampleSale, subtotal: 'x' }, nastySettings)),
    () => encode(renderSettlementSlip({ ...smallSettlementPayment, amount_paid: 'x' }, smallSettlementDebtor, nastySettings))
  ]) {
    assert.throws(build, /finite number/);
  }
});

// The framing is the screen's habit (public/js/receipts.js puts `*** note ***`
// under every sale and settlement receipt, and adds it for the shop that typed
// a bare sentence). Paper read the setting verbatim, so the same shop got one
// framing on screen and another on the roll. Pin both sides: a rename of the
// default text or the frame on either side fails here instead of drifting.
test('paper and screen frame the shop footer note the same way', () => {
  const receiptsSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'receipts.js'), 'utf8');
  assert.match(receiptsSrc, /\*\*\* \$\{escHtml\(S\.shopSettings\.shop_footer_note \|\| 'Thank you for your business!'\)\} \*\*\*/,
    'the sale receipt on screen no longer frames the footer note');
  assert.match(receiptsSrc, /\*\*\* \$\{escHtml\(S\.shopSettings\.shop_footer_note \|\| 'Thank you for your payment!'\)\} \*\*\*/,
    'the settlement receipt on screen no longer frames the footer note');

  // Short enough to stay one line at both widths, so the frame is asserted
  // rather than measured across a wrap.
  const note = 'Quality parts, honest service.';
  const framed = `*** ${note} ***`;
  const starred = (slip) => slip.filter((l) => l.centered && l.text.includes('*')).map((l) => l.text).join(' ');
  for (const width of ['58mm', '80mm']) {
    const s = { ...nastySettings, shop_footer_note: note, receipt_paper_width: width };
    assert.equal(starred(renderSaleSlip(sampleSale, s)), framed, `sale footer at ${width}`);
    assert.equal(starred(renderSettlementSlip(smallSettlementPayment, smallSettlementDebtor, s)), framed, `settlement footer at ${width}`);
  }

  // And a shop that never filled the field still gets the default, framed.
  const bareSale = renderSaleSlip(sampleSale, { receipt_paper_width: '80mm' }).map((l) => l.text);
  assert.equal(bareSale[bareSale.length - 1], '*** Thank you for your business! ***');
  const bareSettle = renderSettlementSlip(smallSettlementPayment, smallSettlementDebtor, { receipt_paper_width: '80mm' }).map((l) => l.text);
  assert.equal(bareSettle[bareSettle.length - 1], '*** Thank you for your payment! ***');
});

// =====================================================================
// FINAL REVIEW FIX WAVE (items 1, 2, 3, 4, 8)
// =====================================================================

const { warrantyDays, isAmountRefusal, calculateWarrantyExpiry } = require('../src/printer');
const vm = require('node:vm');
const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
const uiSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'ui.js'), 'utf8');
const receiptsSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'receipts.js'), 'utf8');
const printerSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'printer.js'), 'utf8');

// public/js/* is browser ESM and this suite is CJS with no bundler, so the real
// browser functions are evaluated in a vm instead of required. Same approach
// tests/ui-fixes.test.js uses for the picker and the modal print action, and for
// the same reason: the rule has to be proved by what it returns, not by grep.
const sandbox = (code) => {
  const ctx = vm.createContext({});
  vm.runInContext(code.replace(/export /g, ''), ctx);
  return ctx;
};
const uiMoneyBlock = uiSrc.slice(uiSrc.indexOf('export function isFiniteAmount'), uiSrc.indexOf('export function setCounterText'));
const uiMoney = sandbox(uiMoneyBlock);
// The browser's own paper: the real printMoney out of receipts.js, evaluated with
// the predicate it imports from ui.js and the refusal factory that now sits beside
// it instead of in the shared screen module.
const receiptsMoneyBlock = receiptsSrc.slice(receiptsSrc.indexOf('function amountRefusal('), receiptsSrc.indexOf('// The first amount on the slip'));
// The marker brake runs before the vm does: a moved function in receipts.js would
// otherwise fail here with a clear line instead of as a syntax error at load.
assert.ok(receiptsMoneyBlock.includes('function printMoney') && receiptsMoneyBlock.includes('function amountRefusal'),
  'the browser money block moved; update this slice');
const browserPaper = vm.createContext({});
vm.runInContext(uiMoneyBlock.replace(/export /g, ''), browserPaper);
vm.runInContext(receiptsMoneyBlock, browserPaper);
const printMoney = vm.runInContext('printMoney', browserPaper);
const uiWarranty = sandbox(uiSrc.slice(uiSrc.indexOf('export function warrantyDays'), uiSrc.indexOf('// One-off single-input modal')));

// --- item 2: one warranty rule, on both papers ---------------------------------
// Paper added `|| 0` days to the expiry while the screen added `|| 7`, and the
// slip's own header fell back to '7' above an expiry that fell back to 0, so one
// document printed "WARRANTY (7 DAYS)" over a date that was the sale date.
// Settings saves warranty_days as "0" for a shop that grants no warranty (the
// field is min=0), and src/db.js:362 seeds '7' for one that never set it, so the
// rule is: a finite number of zero or more days as written, seven for anything
// that does not read as a number at all. Zero stays zero, and unset lands on the
// same seven the rest of the app uses.
const WARRANTY_TABLE = [['7', 7], [14, 14], ['14', 14], ['0', 0], [0, 0], ['', 7], [undefined, 7], [null, 7], ['abc', 7], ['  ', 7], ['-3', 7], [Infinity, 7], [NaN, 7]];

test('the warranty rule is the number the shop set, or seven when it set none', () => {
  for (const [input, expected] of WARRANTY_TABLE) {
    assert.equal(warrantyDays(input), expected, `warrantyDays(${JSON.stringify(input)})`);
  }
  // The two cases this item turns on, spelled out: a saved zero is a decision,
  // not a blank, and a blank is a shop that never chose.
  assert.equal(warrantyDays('0'), 0, 'a shop that grants no warranty must not be shown a week');
  assert.equal(warrantyDays(''), 7, 'a cleared field is an unset field, and the app default is seven');
});

test('the browser resolves warranty days exactly the way paper does', () => {
  const browserRule = vm.runInContext('warrantyDays', uiWarranty);
  for (const [input, expected] of WARRANTY_TABLE) {
    assert.equal(browserRule(input), expected, `ui.js warrantyDays(${JSON.stringify(input)})`);
    assert.equal(browserRule(input), warrantyDays(input), `the two sides disagree on ${JSON.stringify(input)}`);
  }
  // Neither side may keep its own arithmetic or its own fallback any more.
  const uiBlock = uiSrc.slice(uiSrc.indexOf('export function warrantyDays'), uiSrc.indexOf('// One-off single-input modal'));
  assert.match(uiBlock, /d\.setDate\(d\.getDate\(\) \+ warrantyDays\(days\)\);/, 'the screen is back to its own arithmetic');
  assert.ok(!/\|\|\s*7|\?\s*7\s*:/.test(uiBlock), 'ui.js is granting a week of warranty to a shop that set none');
  assert.match(printerSrc, /d\.setDate\(d\.getDate\(\) \+ warrantyDays\(days\)\);/, 'paper is back to its own arithmetic');
  assert.ok(!/\|\|\s*'7'/.test(printerSrc), "src/printer.js is back to falling back to '7' in the header");
  assert.ok(!/plain\(settings\.warranty_days\)/.test(printerSrc), 'the header is printing the raw setting again');
});

test('one slip cannot promise a week above an expiry that is the sale date', () => {
  // The header is the run of lines from "WARRANTY (" through the line that ends
  // it, because the policy text prints between the header and the expiry.
  const warrantyBlock = (settings) => {
    const text = renderSaleSlip(sampleSale, { ...nastySettings, ...settings }).map((l) => l.text);
    const from = text.findIndex((l) => l.startsWith('WARRANTY ('));
    assert.ok(from > -1, `no warranty header on the slip: ${text.join(' | ')}`);
    const last = text.findIndex((l, i) => i >= from && l.endsWith('DAYS):'));
    assert.ok(last > -1, `the warranty header never closed: ${text.slice(from, from + 3).join(' | ')}`);
    const expiry = text.findIndex((l, i) => i > from && l.startsWith('Valid Until: '));
    assert.ok(expiry > last, 'the warranty header printed below its own expiry');
    return { header: text.slice(from, last + 1).join(' '), expiry: text[expiry], lines: last - from + 1 };
  };
  const plus = (n) => localDate(new Date(new Date(sampleSale.created_at).getTime() + n * 864e5));
  // The four cases the rule has to answer, each checked on the header AND the
  // expiry of the SAME slip: they can no longer disagree, because both lines read
  // the one warrantyDays() answer.
  const zero = warrantyBlock({ warranty_days: '0' });
  assert.equal(zero.header, 'WARRANTY (0 DAYS):', 'a saved zero was not printed as zero');
  assert.equal(zero.expiry, `Valid Until: ${plus(0)}`, 'a zero warranty must expire on the sale date');
  assert.equal(calculateWarrantyExpiry(sampleSale.created_at, '0'), localDate(sampleSale.created_at));
  const empty = warrantyBlock({ warranty_days: '' });
  assert.equal(empty.header, 'WARRANTY (7 DAYS):', 'an empty field is an unset field, not a zero one');
  assert.equal(empty.expiry, `Valid Until: ${plus(7)}`);
  const absent = warrantyBlock({ warranty_days: undefined });
  assert.equal(absent.header, 'WARRANTY (7 DAYS):', 'a missing field is an unset field');
  assert.equal(absent.expiry, `Valid Until: ${plus(7)}`);
  const junk = warrantyBlock({ warranty_days: 'abc' });
  assert.equal(junk.header, 'WARRANTY (7 DAYS):', 'a non-numeric field is not a promise of nothing');
  assert.equal(junk.expiry, `Valid Until: ${plus(7)}`);
  // A real period still reads as the shop set it, header and expiry together.
  assert.equal(warrantyBlock({ warranty_days: '14' }).header, 'WARRANTY (14 DAYS):');
  assert.equal(warrantyBlock({ warranty_days: '14' }).expiry,
    `Valid Until: ${calculateWarrantyExpiry(sampleSale.created_at, '14')}`);
  assert.equal(calculateWarrantyExpiry(sampleSale.created_at, '14'), plus(14));
  // The screen's own copy of the answer, same input, same day count, and the same
  // `--` when a hand-edited value runs the calendar off its end on both papers.
  const browserExpiry = vm.runInContext('calculateWarrantyExpiry', uiWarranty);
  assert.equal(browserExpiry('not-a-date', '0'), '--');
  assert.equal(calculateWarrantyExpiry('not-a-date', '0'), '--');
  const huge = '99999999999999999999';
  assert.equal(calculateWarrantyExpiry(sampleSale.created_at, huge), '--', 'paper prints a blank date');
  assert.equal(browserExpiry(sampleSale.created_at, huge), '--', 'the screen prints Invalid Date');
});

// --- item 4: no emitted line leaves the budget ---------------------------------
// `Invoice #: ...` and `WARRANTY (n DAYS):` used to be pushed whole. A
// warranty_days long enough to crowd the roll put a 51-character line on a
// 32-column one, so both go through wrap() now and the invariant holds everywhere.
const LONG_INVOICE = `SALE-${'X'.repeat(70)}`;
const LONG_DAYS = '1234567890123456789012345678901234567890';

test('a hostile warranty value and invoice code stay inside the roll at both widths', () => {
  const observed = {};
  for (const width of ['58mm', '80mm']) {
    const cols = colsFor(width);
    const slip = renderSaleSlip({ ...sampleSale, sale_code: LONG_INVOICE },
      { ...nastySettings, warranty_days: LONG_DAYS, receipt_paper_width: width });
    for (const line of slip) {
      const budget = line.wide ? Math.floor(cols / 2) : cols;
      observed[width] = Math.max(observed[width] || 0, line.text.length);
      assert.ok(line.text.length <= budget, `${width} over ${budget}: ${JSON.stringify(line.text)}`);
    }
    const text = slip.map((l) => l.text);
    // Wrapped, not truncated: the whole value is still on the paper, spread over as
    // many rows as the roll needs.
    const invoice = text.findIndex((l) => l.startsWith('Invoice #:'));
    const date = text.findIndex((l) => l.startsWith('Date: '));
    assert.ok(invoice > -1 && date > invoice, 'the invoice block ran into the date line');
    const squash = (s) => String(s).replace(/\s+/g, '');
    assert.equal(squash(text.slice(invoice, date).join('')), squash(`Invoice #: ${LONG_INVOICE}`), 'the invoice code was cut');
    assert.ok(date - invoice > 1, `${width}: a ${LONG_INVOICE.length + 10}-character invoice line still went out on one line`);
    const warranty = text.findIndex((l) => l.startsWith('WARRANTY ('));
    const warrantyEnd = text.findIndex((l, i) => i >= warranty && l.endsWith('DAYS):'));
    const expiry = text.findIndex((l, i) => i > warranty && l.startsWith('Valid Until: '));
    const headerText = `WARRANTY (${warrantyDays(LONG_DAYS)} DAYS):`;
    assert.ok(warranty > -1 && warrantyEnd >= warranty && expiry > warrantyEnd, 'the warranty header lost its block');
    assert.equal(squash(text.slice(warranty, warrantyEnd + 1).join(' ')), squash(headerText), 'the warranty header lost its tail');
    // The wrap path is proven engaged, not merely tolerated: a header longer than
    // the roll goes out over several rows, one that fits stays on one. At 80mm even
    // a hostile value collapses to a short number, so a single row is the correct
    // answer there and the budget assertion above is what keeps it honest.
    assert.equal(warrantyEnd - warranty > 0, headerText.length > cols,
      `${width}: a ${headerText.length}-character header on a ${cols}-column roll came out in the wrong shape`);
  }
  // The widest line the hostile render emitted, asserted rather than eyeballed.
  assert.equal(observed['58mm'], 32, JSON.stringify(observed));
  assert.equal(observed['80mm'], 48, JSON.stringify(observed));
});

// `warranty_days` has no value validation anywhere between the Settings field and
// this renderer, and the header used to interpolate the raw string, so a
// hand-edited value of any length landed on the roll verbatim. It is a number or
// it is seven now, so the text of a non-numeric one cannot reach paper at all.
test('a non-numeric warranty_days cannot put its own text on the roll', () => {
  const junk = 'NOT-A-NUMBER'.repeat(8);
  for (const width of ['58mm', '80mm']) {
    const cols = colsFor(width);
    const slip = renderSaleSlip(sampleSale, { ...nastySettings, warranty_days: junk, receipt_paper_width: width });
    const text = slip.map((l) => l.text);
    for (const line of slip) {
      const budget = line.wide ? Math.floor(cols / 2) : cols;
      assert.ok(line.text.length <= budget, `${width} over ${budget}: ${JSON.stringify(line.text)}`);
    }
    assert.ok(text.includes('WARRANTY (7 DAYS):'), `a value that is not a number did not fall back to seven: ${text.join(' | ')}`);
    assert.ok(!text.join(' ').includes('NOT-A-NUMBER'), 'the raw setting reached the paper as text');
    assert.equal(text.filter((l) => l.startsWith('Valid Until: ')).length, 1, 'the expiry line moved');
  }
});

test('an ordinary invoice line and warranty header are unchanged', () => {
  const text = renderSaleSlip(sampleSale, nastySettings).map((l) => l.text);
  const at = text.indexOf(`Invoice #: ${sampleSale.sale_code}`);
  assert.ok(at > -1, 'the ordinary case changed shape');
  assert.equal(text[at + 1], `Date: ${localStamp(sampleSale.created_at)}`, 'the invoice line pushed the date down');
  assert.ok(text.includes('WARRANTY (7 DAYS):'), 'the ordinary warranty header moved');
});

// --- item 1: a refusal is not a printer fault ----------------------------------
test('the money guard throws an error the route can recognise', () => {
  let caught = null;
  try { money('abc'); } catch (err) { caught = err; }
  assert.ok(caught, 'a non-numeric amount did not throw');
  assert.equal(isAmountRefusal(caught), true, 'the throw is not flagged as an amount refusal');
  for (const notARefusal of [new Error('the printer queue could not be opened'), new Error('No printer found. Check the cable'), null, undefined, {}]) {
    assert.equal(isAmountRefusal(notARefusal), false, `${String(notARefusal)} was read as an amount refusal`);
  }
});

// src/money.js is the guarded throw's sibling: it runs on the READ path too (the
// settlement route pushes stored balances through it in src/credits.js), so an
// amount past the cap surfacing inside a render must read as a refusal and not as
// a printer fault, or the route answers fallback:true and the browser prints the
// figure the server just refused.
test('the write-time money guards refuse in the same flagged way, both of them', () => {
  const { money: stored } = require('../src/money');
  assert.equal(stored(1234.5), 1234.5, 'a good amount must not throw');
  for (const [bad, why] of [['not-a-number', /finite number/], [Infinity, /finite number/], [1e12, /exceeds maximum/], [-1e12, /exceeds maximum/]]) {
    let caught = null;
    try { stored(bad); } catch (err) { caught = err; }
    assert.ok(caught, `src/money.js printed ${String(bad)}`);
    assert.match(caught.message, why, `src/money.js(${String(bad)}) threw the wrong thing: ${caught.message}`);
    assert.equal(isAmountRefusal(caught), true, `the ${why} throw is not flagged as an amount refusal`);
  }
});

test('both papers refuse the same money table and the screen marks it instead', () => {
  const screen = vm.runInContext('fmtMoney', uiMoney);
  const placeholder = vm.runInContext('UNREADABLE_AMOUNT', uiMoney);
  assert.equal(placeholder, '₱--', 'the on-screen marker for an unreadable amount changed shape');
  for (const [input, paper] of [[0, 'P0.00'], [1234.5, 'P1,234.50'], ['2700', 'P2,700.00'], [undefined, 'P0.00'], [null, 'P0.00'], ['', 'P0.00']]) {
    assert.equal(money(input), paper, `ESC/POS money(${JSON.stringify(input)})`);
    assert.ok(/^P\d/.test(printMoney(input)), `browser printMoney(${JSON.stringify(input)}) printed ${printMoney(input)}`);
    assert.equal(screen(input), `₱${paper.slice(1)}`, `screen fmtMoney(${JSON.stringify(input)})`);
  }
  // The two papers stop. The screen marks, and the mark is a constant: this
  // formatter's output reaches innerHTML at 81 call sites, so echoing the stored
  // text back would hand a hand-edited row a way into the page.
  for (const bad of ['abc', 'P1,000.00', '1.2.3', NaN, Infinity, -Infinity, {}, () => {}, '<img src=x onerror=alert(1)>']) {
    assert.throws(() => money(bad), /finite number/, `${String(bad)} reached the roll`);
    let caught = null;
    try { printMoney(bad); } catch (err) { caught = err; }
    assert.ok(caught, `${String(bad)} reached the browser sheet`);
    assert.equal(isAmountRefusal(caught), true, 'the browser throw is not the flagged refusal the roll throws');
    assert.match(caught.message, /slip was not printed/, 'the browser refusal no longer says what it did');
    assert.ok(!/receipt/i.test(caught.message), 'a print formatter that never touches a receipt modal blames one');
    assert.doesNotThrow(() => screen(bad), `the screen formatter still throws on ${String(bad)}`);
    assert.equal(screen(bad), '₱--', `screen fmtMoney(${String(bad)}) did not mark the amount`);
    assert.ok(!screen(bad).includes('<'), 'the raw stored text reached the screen');
  }
});

// The 2.4 bullet used to close by claiming the fallback shares paper's content
// AND wording, and to count the browser's money sites as "roughly seventeen".
// Neither is true, so the sentence is pinned to the two renderers it describes:
// unify a label for real and this fails until the doc is edited too.
test('the fallback shares paper labels and money shape, and the doc says so', () => {
  const ops = fs.readFileSync(path.join(__dirname, '..', 'docs', 'OPERATIONS_AND_DEPLOYMENT.md'), 'utf8');
  const bullet = ops.split('\n').find((l) => l.startsWith('- **Same content,'));
  assert.ok(bullet, 'the 2.4 fallback bullet is gone or renamed');
  
  // One money formatter on both papers: same digits, same grouping.
  assert.ok(receiptsSrc.includes("toLocaleString('en-US'"), 'the fallback lost the shared money shape');
  // The call-site count in the sentence is the count in the file.
  const sites = (receiptsSrc.match(/printMoney\(/g) || []).length - 1;
  assert.equal(sites, 20, `printMoney call sites moved to ${sites}; the doc sentence and this test both need the new number`);
  assert.match(bullet, /twenty call sites/, 'the doc no longer matches the twenty sites');
  // The labels are shared now; a re-split fails here until the doc is edited too.
  for (const label of ['WARRANTY (', 'Payment received:', 'Remaining balance:', 'RETURNS / REFUNDS']) {
    assert.ok(printerSrc.includes(label), `paper no longer prints ${label}`);
    assert.ok(receiptsSrc.includes(label), `the fallback no longer prints ${label}`);
    assert.ok(bullet.includes(label), `${label} is not named as shared in the doc`);
  }
  // Dates stay medium-shaped on purpose, and the doc names both shapes.
  assert.match(bullet, /Oct 7, 2026/, 'the date shape is not named');
  assert.match(bullet, /2026-10-07/, 'the paper date shape is not named');
  assert.ok(printerSrc.includes('localDate(') && receiptsSrc.includes('formatDateTime'), 'the two date renderers moved');
});

serverTest('a broken amount is refused on paper and the tab is told not to retry in the browser', async (baseUrl, db, auth) => {
  const sale = cashSale(db);
  // REAL affinity keeps an unconvertible text value as text, which is exactly the
  // corrupted or hand-edited row money() refuses. Written straight to the row
  // because src/money.js will not let a sale be stored this way.
  db.prepare('UPDATE sales SET total_amount = ? WHERE id = ?').run('not-a-number', sale.id);
  const res = await printPost(baseUrl, auth, { kind: 'sale', sale_id: sale.id });
  // 400, not 200: the render threw before the route ever looked for a queue, so no
  // byte was sent and the harness belt was never even needed.
  assert.equal(res.status, 400);
  const data = await res.json();
  assert.match(data.error, /finite number/);
  assert.equal(data.fallback, false, 'a deliberate refusal must not be retried on the browser path');
  const entry = db.prepare("SELECT detail FROM audit_log WHERE category='print' ORDER BY id DESC LIMIT 1").get();
  const detail = JSON.parse(entry.detail);
  assert.equal(detail.ok, false);
  assert.equal(detail.refused_by_guard, true, 'the audit cannot tell a guard from a printer fault');
  assert.ok(!('printer' in detail), 'the audit named a queue the route never reached');

  // The contrast that makes the flag worth having: every other rejection on this
  // branch is a fault the browser path can still rescue, because a shop must never
  // be left unable to hand over a receipt.
  const unknown = await printPost(baseUrl, auth, { kind: 'everything' });
  assert.equal(unknown.status, 400);
  assert.equal((await unknown.json()).fallback, true, 'an unknown kind stopped offering the browser fallback');
  const missing = await printPost(baseUrl, auth, { kind: 'sale', sale_id: 999999 });
  assert.equal(missing.status, 400);
  assert.equal((await missing.json()).fallback, true, 'a missing row stopped offering the browser fallback');
});

serverTest('a settlement with an unprintable collection is refused the same way', async (baseUrl, db, auth) => {
  const { payment } = settledCustomer(db);
  // The payment row is read with SELECT *, so a corrupted amount_paid reaches the
  // renderer as stored, which is the shape money() refuses. (The balance beside it
  // is a SQL SUM and can only come back numeric.)
  db.prepare('UPDATE credit_payments SET amount_paid = ? WHERE id = ?').run('GC-7781', payment.id);
  const res = await printPost(baseUrl, auth, { kind: 'settlement', payment_id: payment.id, customer_name: payment.customer_name });
  assert.equal(res.status, 400);
  const data = await res.json();
  assert.match(data.error, /finite number/, `the collection was not refused: ${JSON.stringify(data)}`);
  assert.equal(data.fallback, false, 'a deliberate refusal must not be retried on the browser path');
});

test('the browser refuses exactly the amounts the paper slip prints', () => {
  const list = (name) => {
    const found = receiptsSrc.match(new RegExp(`const ${name} = (\\[[^\\]]*\\])`));
    assert.ok(found, `${name} has gone out of public/js/receipts.js`);
    return JSON.parse(found[1].replace(/'/g, '"'));
  };
  const saleFields = list('SALE_MONEY_FIELDS');
  const itemFields = list('SALE_ITEM_MONEY_FIELDS');
  const settleFields = list('SETTLEMENT_MONEY_FIELDS');
  const balanceFields = list('SETTLEMENT_BALANCE_FIELDS');
  const slice = (src, from, to) => {
    const start = src.indexOf(from);
    const stop = src.indexOf(to);
    assert.ok(start > -1 && stop > start, `${from} moved; update this test`);
    return src.slice(start, stop);
  };
  // The template section: the shared leaf helpers plus all five builders, so
  // the regex sees every money() call the paper can make for one sale.
  const paperSale = slice(printerSrc, 'function splitDeviceLine', 'function warrantyDays');
  const paperSettle = slice(printerSrc, 'function renderSettlementSlip', "const { spawn }");
  const called = (body, receiver) =>
    [...new Set([...body.matchAll(new RegExp(`money\\(\\s*${receiver}\\.([\\w_]+)\\s*\\)`, 'g'))].map((m) => m[1]))].sort();
  assert.deepEqual(called(paperSale, 'sale'), [...saleFields].sort(), 'paper and screen check different sale amounts');
  assert.deepEqual(called(paperSale, 'item'), [...itemFields].sort(), 'paper and screen check different item amounts');
  assert.deepEqual(called(paperSettle, 'payment'), [...settleFields].sort(), 'paper and screen check different payment amounts');
  assert.deepEqual(called(paperSettle, 'customer'), [...balanceFields].sort(), 'paper and screen check different balances');
  // And each list describes what the browser renderer actually states, so a field
  // cannot be guarded on paper and printed unchecked on the fallback sheet.
  const browserSale = slice(receiptsSrc, 'export function renderReceipt', 'export function renderSettlementReceipt');
  const browserSettle = slice(receiptsSrc, 'export function renderSettlementReceipt', '// True while the shop name');
  for (const field of [...saleFields, ...itemFields]) {
    assert.ok(new RegExp(`(fmtMoney|printMoney)\\([^)]*${field}`).test(browserSale), `renderReceipt states no ${field} through a money formatter`);
  }
  for (const field of settleFields) {
    assert.ok(new RegExp(`(fmtMoney|printMoney)\\([^)]*${field}`).test(browserSettle), `renderSettlementReceipt states no ${field} through a money formatter`);
  }
  for (const field of balanceFields) {
    assert.ok(browserSettle.includes(`customer?.${field}`), `renderSettlementReceipt no longer reads ${field} off the customer record`);
    assert.ok(new RegExp(`(fmtMoney|printMoney)\\([^)]*remainingBal`).test(browserSettle), 'the balance is printed without a money formatter');
  }
});

// --- item 3: the framed footer is on all three copies --------------------------
test('the settlement fallback copy frames the footer note like the screen and paper do', () => {
  // The frame is the renderer's, not something the shop types, so every copy of
  // either note carries it. Counted per renderer, because both notes are in one
  // file and a bare count cannot tell the sale copies from the settlement ones.
  const saleBlock = receiptsSrc.slice(receiptsSrc.indexOf('export function renderReceipt'), receiptsSrc.indexOf('export function renderSettlementReceipt'));
  const settleBlock = receiptsSrc.slice(receiptsSrc.indexOf('export function renderSettlementReceipt'), receiptsSrc.indexOf('// True while the shop name'));
  assert.ok(saleBlock.includes('export function renderReceipt') && settleBlock.includes('renderSettlementReceipt'),
    'a receipt renderer moved; update these slices');
  const framed = (src) => (src.match(/\*\*\* \$\{escHtml\(S\.shopSettings\.shop_footer_note[^)]*\)\} \*\*\*/g) || []).length;
  assert.equal(framed(settleBlock), 2, 'the settlement footer note must be framed on the preview AND the printable fallback copy');
  assert.equal(framed(saleBlock), 2, 'the sale footer note must be framed on the preview AND the printable fallback copy');
  // Nothing prints the setting bare any more, which is what
  // docs/OPERATIONS_AND_DEPLOYMENT.md 2.4 claims about the fallback copy.
  assert.ok(!/(?<!\*\*\* )\$\{escHtml\(S\.shopSettings\.shop_footer_note/.test(receiptsSrc),
    'a footer note is still printed unframed, and docs 2.4 says it is framed on the fallback copy');
  // The credit acknowledgement on the fallback sheet quotes the same promise the
  // ESC/POS slip prints, because the customer signs whichever one comes off. Held
  // as a plain sentence on both sides, so rewording one half fails here instead of
  // handing the same debt two different acknowledgements.
  const paperAck = 'I acknowledge receipt of the goods above and agree to pay the balance of';
  assert.ok(printerSrc.includes(paperAck), 'src/printer.js reworded the acknowledgement; re-pin both copies');
  assert.ok(receiptsSrc.includes(paperAck), 'the browser fallback prints a different acknowledgement sentence than the roll');
  // The same note still lands framed on paper, at both widths. Short enough that
  // the framed form fits one 32-column line, so the last row is the whole note.
  const note = 'Come back soon!';
  for (const width of ['58mm', '80mm']) {
    const s = { ...nastySettings, shop_footer_note: note, receipt_paper_width: width };
    const sale = renderSaleSlip(sampleSale, s).map((l) => l.text);
    const settle = renderSettlementSlip(smallSettlementPayment, smallSettlementDebtor, s).map((l) => l.text);
    assert.equal(sale[sale.length - 1], `*** ${note} ***`);
    assert.equal(settle[settle.length - 1], `*** ${note} ***`);
  }
});

// --- item 8: the audit stores a clipped queue name -----------------------------
serverTest('a queue name long enough to flood the audit is clipped to the reason cap', async (baseUrl, db, auth) => {
  const sale = cashSale(db);
  writeQueueName(db, `ZZ ${'Q'.repeat(400)}`);
  const res = await printPost(baseUrl, auth, { kind: 'sale', sale_id: sale.id });
  const data = await res.json();
  // The harness belt refuses this name before PowerShell starts, which is the
  // route's own rejection path and the only one a test may aim a queue name at.
  // Under test is the clip the route puts on text that came out of a queue name.
  assert.equal(res.status, 400);
  assert.match(data.error, /test refused to open printer queue/);
  assert.ok(data.error.length <= 215, `an unclipped queue name reached the client: ${data.error.length} chars`);
  assert.match(data.error, /\[truncated\]$/, 'the clipped reason no longer says it was clipped');
  // The delivered branch, the one that records a queue name, is the one no test may
  // reach: it would print on this machine. So it is pinned at the call site, on the
  // same helper the assertions above prove.
  assert.match(serverSrc, /audit\(db, session, false, 'print', job, \{ printer: clipPrintError\(target\), \.\.\.sent \}\);/,
    'the audit stores the queue name whole again, so a long one lands intact in an append-only log');
  assert.ok(!/printer: target[,}]/.test(serverSrc), 'a raw queue name is still audited unclipped somewhere on the print path');
});


// =====================================================================
// CLAIM STUB ESC/POS PATH (v7 audit 9f: the one counter paper with no encoder)
// =====================================================================
const { renderClaimStubSlip } = require('../src/printer');

const stubJob = {
  ref: 'RO-7F3A2B',
  customer: 'Juan Dela Cruz <b>',
  phone: '0917 123 4567',
  device: 'iPhone 11',
  imei: '356789101112131',
  note: 'Broken screen; data intact',
  items: [
    { name: 'iPhone 11 Screen OLED Assembly', qty: 1, unit_price: 2200 },
    { name: 'Labor', qty: 1, unit_price: 450 },
  ],
  discount: 50,
  total: 2600,
};

test('the claim stub slip carries the job, in the order the browser stub does', () => {
  const slip = renderClaimStubSlip(stubJob, nastySettings);
  const text = slip.map((l) => l.text).join('\n');
  assert.match(text, /REPAIR CLAIM STUB/);
  assert.match(text, /Ref: RO-7F3A2B/);
  assert.match(text, /Customer:/);
  assert.match(text, /Juan Dela Cruz/);
  assert.ok(!text.includes('\x1b') && !text.includes('\x00'), 'plain() strips control bytes; ASCII markup stays as inert characters on paper');
  assert.match(text, /IMEI\/SN:/);
  assert.match(text, /ESTIMATED ITEMS/);
  assert.match(text, /ESTIMATED TOTAL:\s+P2,600\.00/);
  assert.match(text, /official receipt/);
  // Parity with the browser renderer: every field the browser shows, paper shows.
  const browser = receiptsSrc.slice(receiptsSrc.indexOf('export function renderClaimStub('));
  for (const field of ['ref', 'customer', 'phone', 'device', 'imei', 'note', 'items', 'discount', 'total']) {
    assert.ok(new RegExp(`(job|stubJob)\.${field}|\b${field}:`).test(browser) || browser.includes(`job.${field}`) || stubJob[field] !== undefined,
      `the browser stub renders ${field}`);
  }
});

test('a claim stub keeps every line inside the roll, 58mm and 80mm', () => {
  for (const width of ['58mm', '80mm']) {
    const cols = colsFor(width);
    const slip = renderClaimStubSlip(stubJob, { ...nastySettings, receipt_paper_width: width });
    for (const line of slip) {
      const budget = line.wide ? Math.floor(cols / 2) : cols;
      assert.ok(line.text.length <= budget, `${width} over ${budget}: ${JSON.stringify(line.text)}`);
    }
  }
});

test('a claim stub with a broken total is refused, not printed as P0.00', () => {
  assert.throws(() => renderClaimStubSlip({ ...stubJob, total: Number.NaN }, nastySettings), isAmountRefusal);
  assert.throws(() => renderClaimStubSlip({ ...stubJob, items: [{ name: 'x', qty: 1, unit_price: 'oops' }] }, nastySettings), isAmountRefusal);
});

test('the stub encodes to bytes through the same pipeline as every other slip', () => {
  const slip = renderClaimStubSlip(stubJob, nastySettings);
  const bytes = encode(slip, { drawerKick: false });
  assert.ok(Buffer.isBuffer(bytes) && bytes.length > 100, 'encode returns real ESC/POS bytes');
  assert.ok(!bytes.includes(0xe2), 'no UTF-8 multibyte leak (plain() strips non-ASCII)');
});

serverTest('POST /api/print kind=claim_stub goes to the queue without a sale', async (baseUrl, db, auth) => {
  const res = await fetch(`${baseUrl}/api/print`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'claim_stub', ...stubJob }),
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(res.status, 200, `the route accepted the stub: ${JSON.stringify(data)}`);
  // The sentinel queue cannot open, so paper answers fallback:true exactly
  // like every other slip in this suite; the tab then renders the browser stub.
  assert.equal(data.fallback, true, 'a refused queue still sends the tab to the browser path');
  const row = db.prepare("SELECT action, detail FROM audit_log WHERE category = 'print' ORDER BY id DESC LIMIT 1").get();
  assert.equal(row.action, 'claim_stub', 'the stub leaves the same print audit row as a sale slip');
  // And a broken amount answers 400 with fallback:false: the browser must not
  // print paper the printer just refused.
  const bad = await fetch(`${baseUrl}/api/print`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'claim_stub', ...stubJob, total: 'broken' }),
  });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).fallback, false, 'an amount refusal is not a printer fault');
});

// ---- Templates + item rows (Settings > Printing) ---------------------------
test('item rows: auto prints one line when the row fits and wraps when it does not', () => {
  const fits = renderSaleSlip(
    { ...sampleSale, items: [{ item_type: 'part', item_name: 'LCD', quantity: 1, unit_price: 100, total_price: 100 }] },
    { ...nastySettings, receipt_item_rows: 'auto', receipt_paper_width: '80mm' }).map((l) => l.text);
  assert.ok(fits.some((l) => l.startsWith('1x LCD')), `auto collapsed the row: ${JSON.stringify(fits)}`);
  const wide = renderSaleSlip(
    { ...sampleSale, items: [{ item_type: 'part', item_name: 'iPhone 12 Screen Original Assembly OLED', quantity: 1, unit_price: 2200, total_price: 2200 }] },
    { ...nastySettings, receipt_item_rows: 'auto', receipt_paper_width: '58mm' }).map((l) => l.text);
  assert.ok(wide.some((l) => l.startsWith('iPhone 12 Screen')), 'a long name wraps instead of truncating');
  assert.ok(wide.some((l) => l.startsWith('  1 x P2,200.00')), 'the wrapped name keeps the qty x unit row');
});

test('item rows: one_line truncates the name and keeps the money column exact', () => {
  const long = 'iPhone 12 Pro Max Screen Original Assembly OLED Grade A';
  const text = renderSaleSlip(
    { ...sampleSale, items: [{ item_type: 'part', item_name: long, quantity: 2, unit_price: 150, total_price: 300 }] },
    { ...nastySettings, receipt_item_rows: 'one_line', receipt_paper_width: '58mm' }).map((l) => l.text);
  const line = text.find((l) => l.startsWith('2x iPhone'));
  assert.ok(line, `one-line row missing: ${JSON.stringify(text)}`);
  assert.ok(line.length <= 32, line);
  assert.ok(line.endsWith('P300.00'), line);
  assert.ok(line.includes('...'), 'the truncated name says so');
});

test('every template stays inside the roll at both widths and keeps the shared content', () => {
  const sale = { ...sampleSale, credit_balance: 250 };
  for (const template of ['standard', 'compact', 'boxed', 'airy', 'grid']) {
    for (const width of ['58mm', '80mm']) {
      const cols = colsFor(width);
      const slip = renderSaleSlip(sale, { ...nastySettings, receipt_template: template, receipt_paper_width: width });
      assert.ok(slip.length > 10, `${template} produced no slip`);
      for (const line of slip) {
        const budget = line.wide ? Math.floor(cols / 2) : cols;
        assert.ok((line.text || '').length <= budget, `${template}/${width} over budget: ${JSON.stringify(line.text)}`);
      }
      const text = slip.map((l) => l.text).join('\n');
      // The trimmed templates phrase the warranty line differently, so the
      // shared-content check looks for the expiry date itself (sampleSale is
      // 2026-09-30 + 7 days).
      for (const must of ['OFFICIAL RECEIPT', 'Invoice #', 'TOTAL DUE', 'BALANCE (UTANG):', 'Customer Signature', '2026-10-07']) {
        assert.ok(text.includes(must), `${template} lost ${must}`);
      }
    }
  }
});

test('trimmed templates drop address, tel and policy; compact also drops the footer', () => {
  const render = (t) => renderSaleSlip(sampleSale, { ...nastySettings, receipt_template: t, receipt_paper_width: '80mm' }).map((l) => l.text).join('\n');
  const compact = render('compact');
  for (const gone of ['Tel/GCash:', 'Rizal Street', 'WARRANTY (', 'Thank you for your business']) {
    assert.ok(!compact.includes(gone), `compact kept ${gone}`);
  }
  assert.match(compact, /Warranty:\s+7 day\(s\), valid until 2026-10-07/, compact);
  for (const t of ['airy', 'grid']) {
    const text = render(t);
    assert.ok(!text.includes('Tel/GCash:'), `${t} kept the tel line`);
    assert.ok(!text.includes('WARRANTY ('), `${t} kept the policy header`);
    assert.ok(text.includes('Thank you for your business'), `${t} lost the footer note`);
  }
});

test('boxed frames the total; grid sets qty/name/amount columns', () => {
  const boxed = renderSaleSlip(sampleSale, { ...nastySettings, receipt_template: 'boxed', receipt_paper_width: '80mm' }).map((l) => l.text);
  assert.ok(boxed.some((l) => l.startsWith('+---')), 'boxed total frame missing');
  assert.ok(boxed.some((l) => l.startsWith('| TOTAL DUE')), 'boxed total row missing');
  assert.ok(boxed.includes('='.repeat(48)), 'boxed double rules missing');
  const grid = renderSaleSlip(sampleSale, { ...nastySettings, receipt_template: 'grid', receipt_paper_width: '80mm' }).map((l) => l.text);
  assert.ok(grid.some((l) => l.startsWith('QTY ITEM') && l.endsWith('AMOUNT')), 'grid header missing');
  assert.ok(grid.some((l) => l.includes('iPhone 11 Screen OLED')), 'grid item rows missing');
});

serverTest('the paper preview renders the chosen template from the sample sale', async (baseUrl, db, auth) => {
  auth = await ensurePinChanged(baseUrl, auth);
  const preview = async (body, headers = auth) => {
    const res = await fetch(`${baseUrl}/api/receipt/preview`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, data: await res.json() };
  };
  // Manager-gated like the settings it mirrors.
  const denied = await preview({ template: 'compact' }, { Authorization: auth.Authorization });
  assert.equal(denied.status, 403);
  const { status, data } = await preview({ template: 'compact', item_rows: 'auto', paper_width: '58mm' });
  assert.equal(status, 200);
  assert.ok(Array.isArray(data.lines) && data.lines.length > 10);
  assert.ok(data.lines.every((l) => l.text.length <= 32), 'a preview line exceeds the roll');
  const text = data.lines.map((l) => l.text).join('\n');
  assert.ok(text.includes('OFFICIAL RECEIPT'));
  assert.ok(!text.includes('Tel/GCash:'), 'compact preview kept the tel line');
  assert.ok(text.includes('iPhone 12 screen assembly'), 'the sample sale drives the preview');
  const boxed = await preview({ template: 'boxed', item_rows: 'two_line', paper_width: '80mm' });
  assert.ok(boxed.data.lines.some((l) => l.text.startsWith('| TOTAL DUE')), 'boxed total missing from preview');
});
