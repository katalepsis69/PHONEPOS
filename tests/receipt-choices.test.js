// tests/receipt-choices.test.js
// Regression: Settings > Printing choices never saved. updateShopSettings
// whitelists writable keys, and receipt_template / receipt_item_rows were
// missing from that list, so every save the Printing pane sent threw
// "Unknown setting 'receipt_template'" (400) and rolled the whole form back —
// while the paper preview kept working, because it passes its choices
// directly to renderSaleSlip instead of through the settings store.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { serverTest, ensurePinChanged } = require('./helper');
const { getShopSettings } = require('../src/settings');
const { renderSaleSlip } = require('../src/printer');

const SAMPLE_SALE = {
  sale_code: 'SALE-REGRESSION',
  created_at: new Date().toISOString(),
  customer_name: 'Save Test',
  payment_method: 'cash',
  subtotal: 100, discount: 0, total_amount: 100, amount_paid: 100, change_amount: 0, credit_balance: 0,
  items: [{ item_type: 'part', item_name: 'Tempered glass', quantity: 1, unit_price: 100, total_price: 100 }],
  returns: [],
};

serverTest('receipt template and item rows save through /api/settings and reach the printed slip', async (baseUrl, db, auth) => {
  auth = await ensurePinChanged(baseUrl, auth);

  const save = await fetch(`${baseUrl}/api/settings`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ receipt_template: 'grid', receipt_item_rows: 'two_line', receipt_paper_width: '58mm' })
  });
  assert.strictEqual(save.status, 200, `settings save answered ${save.status}: ${await save.text()}`);

  // Exactly what the manager picked is what the shop now has.
  const stored = getShopSettings(db);
  assert.strictEqual(stored.receipt_template, 'grid');
  assert.strictEqual(stored.receipt_item_rows, 'two_line');
  assert.strictEqual(stored.receipt_paper_width, '58mm');

  // The print queue renders from these stored settings, so the saved template
  // has to be the layout the roll gets.
  const slip = renderSaleSlip(SAMPLE_SALE, { ...getShopSettings(db) }).map((l) => l.text).join('\n');
  assert.match(slip, /QTY ITEM/, 'the saved grid template must reach the printed slip');

  // two_line reads the stored receipt_item_rows on the standard layout: the
  // name sits on its own line above the indented qty/price row.
  const twoLine = renderSaleSlip(SAMPLE_SALE, {
    ...getShopSettings(db), receipt_template: 'standard'
  }).map((l) => l.text).join('\n');
  assert.match(twoLine, /Tempered glass\n\s+1 x P100\.00/, 'the saved item-rows choice must reach the printed slip');

  // A saved choice survives a re-read through the API the settings modal uses.
  const roundtrip = await fetch(`${baseUrl}/api/settings`, { headers: auth });
  const view = await roundtrip.json();
  assert.strictEqual(view.receipt_template, 'grid');
  assert.strictEqual(view.receipt_item_rows, 'two_line');
});
