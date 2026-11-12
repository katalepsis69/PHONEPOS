// phone-repair-pos/tests/pickup-slip.test.js
// The pickup-ready notice: the repairs queue's no-SMS way to bring the
// customer back. Money-free on purpose; the ticket row comes from the server.
const assert = require('node:assert');
const test = require('node:test').test;
const { renderPickupReadySlip, colsFor } = require('../src/printer');

const nastySettings = { receipt_paper_width: '80mm', gcash_name: 'Tech<Parts> & Sons', shop_address: '', gcash_number: '' };

const pickupTicket = {
  ref_code: 'RO-251113-P1CK',
  customer_name: 'Juan Dela Cruz <b>',
  customer_phone: '0917 123 4567',
  device: 'iPhone 11',
  imei: '356789101112131',
  issue_note: 'Broken screen; data intact',
  estimate: 2600,
  updated_at: '2026-11-13T10:00:00.000Z'
};

test('the pickup-ready slip states the queue truth and carries no money figure', () => {
  const slip = renderPickupReadySlip(pickupTicket, nastySettings);
  const text = slip.map((l) => l.text).join('\n');
  assert.match(text, /READY FOR PICKUP/);
  assert.match(text, /Ref: RO-251113-P1CK/);
  assert.match(text, /Juan Dela Cruz/);
  assert.match(text, /IMEI\/SN:/);
  // wrap() may split the long footer across lines; assert the words land.
  assert.match(text, /balance/);
  assert.match(text, /counter/);
  assert.ok(!/P\d+\.\d{2}/.test(text), 'no peso figure on notice paper (ref codes may contain P+digits)');
  assert.ok(!/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text), 'no control bytes reach paper');
});

test('a pickup-ready slip keeps every line inside the roll, 58mm and 80mm', () => {
  for (const width of ['58mm', '80mm']) {
    const cols = colsFor(width);
    const slip = renderPickupReadySlip(pickupTicket, { ...nastySettings, receipt_paper_width: width });
    for (const line of slip) {
      const budget = line.wide ? Math.floor(cols / 2) : cols;
      assert.ok(line.text.length <= budget, `${width} over ${budget}: ${JSON.stringify(line.text)}`);
    }
  }
});
