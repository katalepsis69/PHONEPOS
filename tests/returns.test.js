// phone-repair-pos/tests/returns.test.js
const assert = require('node:assert');
const { dbTest } = require('./helper');
const { createInventoryItem, getInventoryItem } = require('../src/inventory');
const { createSale } = require('../src/sales');
const { createWarrantyReturn, listWarrantyReturns } = require('../src/returns');

dbTest('Warranty Return processes part replacement and decrements replacement stock', (db) => {
  const screen = createInventoryItem(db, {
    brand: 'Samsung',
    model_name: 'Galaxy A12',
    part_type: 'LCD (Incell)',
    cost_price: 450.0,
    price_retail: 1100.0,
    stock_quantity: 5
  });

  const sale = createSale(db, {
    customer_name: 'Mark Customer',
    customer_type: 'retail',
    payment_method: 'cash',
    items: [{ inventory_id: screen.id, quantity: 1, unit_price: 1100.0 }],
    amount_paid: 1100.0
  });

  assert.strictEqual(getInventoryItem(db, screen.id).stock_quantity, 4);

  // Process Defective Warranty Replacement (Ghost touch issue)
  const returnRecord = createWarrantyReturn(db, {
    sale_id: sale.id,
    sale_item_id: sale.items[0].id,
    return_type: 'replacement',
    return_reason: 'ghost_touch',
    replacement_inventory_id: screen.id,
    technician_notes: 'Replaced defective screen with fresh unit. Defective part set aside for supplier RMA.'
  });

  assert.ok(returnRecord.return_code.startsWith('RMA-'));
  assert.strictEqual(returnRecord.customer_name, 'Mark Customer');
  assert.strictEqual(returnRecord.return_type, 'replacement');
  assert.strictEqual(returnRecord.return_reason, 'ghost_touch');

  // Verify stock decremented by 1 more for the fresh replacement unit
  assert.strictEqual(getInventoryItem(db, screen.id).stock_quantity, 3);

  // Verify listing
  const returns = listWarrantyReturns(db);
  assert.strictEqual(returns.length, 1);
  assert.strictEqual(returns[0].return_code, returnRecord.return_code);
});

dbTest('Warranty Return processes credit refund on unpaid utang sale', (db) => {
  const screen = createInventoryItem(db, {
    brand: 'Apple',
    model_name: 'iPhone 11',
    part_type: 'LCD (Incell)',
    cost_price: 650.0,
    price_retail: 1400.0,
    stock_quantity: 4
  });

  const sale = createSale(db, {
    customer_name: 'Dan Tech',
    payment_method: 'credit',
    items: [{ inventory_id: screen.id, quantity: 1, unit_price: 1400.0 }],
    amount_paid: 0.0 // 1400 unpaid credit
  });

  assert.strictEqual(sale.credit_balance, 1400.0);

  // Return item and reduce credit balance
  const returnRecord = createWarrantyReturn(db, {
    sale_id: sale.id,
    sale_item_id: sale.items[0].id,
    return_type: 'credit_refund',
    return_reason: 'no_display',
    refund_amount: 1400.0,
    technician_notes: 'Screen dead on arrival. Customer credit voided.'
  });

  assert.strictEqual(returnRecord.return_type, 'credit_refund');
  assert.strictEqual(returnRecord.refund_amount, 1400.0);

  // Verify sale credit balance updated to 0
  const updatedSale = db.prepare('SELECT credit_balance FROM sales WHERE id = ?').get(sale.id);
  assert.strictEqual(updatedSale.credit_balance, 0.0);
});

dbTest('Warranty Return caps crafted refund amounts at unit price and outstanding debt', (db) => {
  const screen = createInventoryItem(db, {
    brand: 'Apple', model_name: 'iPhone 13', part_type: 'LCD (OLED)',
    cost_price: 1850.0, price_retail: 30.0, stock_quantity: 4
  });

  // 2 x 30 = 60, paid 10 -> 50 outstanding.
  const sale = createSale(db, {
    customer_name: 'Cap Check',
    payment_method: 'credit',
    items: [{ inventory_id: screen.id, quantity: 2, unit_price: 30.0 }],
    amount_paid: 10.0
  });
  assert.strictEqual(sale.credit_balance, 50.0);

  // A staff-crafted 999999 credit refund must relieve one unit's price (30),
  // not wipe the whole balance, and must record the capped amount.
  const rma = createWarrantyReturn(db, {
    sale_id: sale.id,
    sale_item_id: sale.items[0].id,
    return_type: 'credit_refund',
    refund_amount: 999999
  });
  assert.strictEqual(rma.refund_amount, 30.0);
  const afterCredit = db.prepare('SELECT credit_balance FROM sales WHERE id = ?').get(sale.id);
  assert.strictEqual(afterCredit.credit_balance, 20.0, 'debt reduced by one unit, not wiped');

  // Cash refunds cap at the unit price too.
  const cashSale = createSale(db, {
    customer_name: 'Cash Cap Check',
    payment_method: 'cash',
    items: [{ inventory_id: screen.id, quantity: 1, unit_price: 30.0 }],
    amount_paid: 30.0
  });
  const cashRma = createWarrantyReturn(db, {
    sale_id: cashSale.id,
    sale_item_id: cashSale.items[0].id,
    return_type: 'cash_refund',
    refund_amount: 999999
  });
  assert.strictEqual(cashRma.refund_amount, 30.0);
});

dbTest('Warranty Return rejects returns exceeding purchased quantity', (db) => {
  const battery = createInventoryItem(db, {
    brand: 'Apple',
    model_name: 'iPhone 12',
    part_type: 'Battery',
    cost_price: 15.0,
    price_retail: 35.0,
    stock_quantity: 5
  });

  const sale = createSale(db, {
    customer_name: 'Over RMA Check',
    payment_method: 'cash',
    items: [{ inventory_id: battery.id, quantity: 1, unit_price: 35.0 }],
    amount_paid: 35.0
  });

  // First return succeeds
  createWarrantyReturn(db, {
    sale_id: sale.id,
    sale_item_id: sale.items[0].id,
    return_type: 'cash_refund',
    refund_amount: 35.0,
    technician_notes: 'First RMA'
  });

  // Second return on same single-item line must throw
  assert.throws(() => {
    createWarrantyReturn(db, {
      sale_id: sale.id,
      sale_item_id: sale.items[0].id,
      return_type: 'cash_refund',
      refund_amount: 35.0,
      technician_notes: 'Duplicate RMA attempt'
    });
  }, /Cannot return item: already returned 1 of 1 purchased unit/);
});

dbTest('Warranty Return rejects unknown return types and credit refunds without debt', (db) => {
  const battery = createInventoryItem(db, {
    brand: 'Apple', model_name: 'iPhone 12', part_type: 'Battery',
    cost_price: 15.0, price_retail: 35.0, stock_quantity: 5
  });

  const sale = createSale(db, {
    customer_name: 'Type Check',
    payment_method: 'cash',
    items: [{ inventory_id: battery.id, quantity: 1, unit_price: 35.0 }],
    amount_paid: 35.0
  });

  // Unknown type: would fall through every branch -- recorded, nothing refunded.
  assert.throws(() => {
    createWarrantyReturn(db, {
      sale_id: sale.id,
      sale_item_id: sale.items[0].id,
      return_type: 'store_credit',
      return_reason: 'other'
    });
  }, /Invalid return type/);

  // credit_refund on a fully paid cash sale: reduces a zero balance, refunds nobody.
  assert.throws(() => {
    createWarrantyReturn(db, {
      sale_id: sale.id,
      sale_item_id: sale.items[0].id,
      return_type: 'credit_refund',
      return_reason: 'other'
    });
  }, /outstanding credit/);

  // Nothing was recorded by the rejected attempts
  assert.strictEqual(listWarrantyReturns(db).length, 0);
});

dbTest('cash refund is capped by allocated discount and remaining net collection', (db) => {
  const part = createInventoryItem(db, {
    brand: 'Discount', model_name: 'Allocation', part_type: 'Part', price_retail: 100, stock_quantity: 5
  });
  const sale = createSale(db, {
    customer_name: 'Discount Refund', payment_method: 'cash',
    items: [{ inventory_id: part.id, quantity: 2, unit_price: 100 }], discount: 50, amount_paid: 150
  });
  const first = createWarrantyReturn(db, {
    sale_id: sale.id, sale_item_id: sale.items[0].id, return_type: 'cash_refund', refund_amount: 100
  });
  assert.strictEqual(first.refund_amount, 75);
  const second = createWarrantyReturn(db, {
    sale_id: sale.id, sale_item_id: sale.items[0].id, return_type: 'cash_refund', refund_amount: 100
  });
  assert.strictEqual(second.refund_amount, 75);

  const creditSale = createSale(db, {
    customer_name: 'Part Paid Refund', payment_method: 'credit',
    items: [{ inventory_id: part.id, quantity: 1, unit_price: 100 }], amount_paid: 30
  });
  const capped = createWarrantyReturn(db, {
    sale_id: creditSale.id, sale_item_id: creditSale.items[0].id, return_type: 'cash_refund', refund_amount: 100
  });
  assert.strictEqual(capped.refund_amount, 30);
});

dbTest('warranty window: RMA on an old sale throws for staff, overrides with elevation, flags the audit row', (db) => {
  const ctxMgr = { actor: { type: 'manager', id: null, name: 'Manager' }, elevated: true };
  const part = createInventoryItem(db, {
    brand: 'Old', model_name: 'Sale', part_type: 'LCD', price_retail: 500, stock_quantity: 3
  });
  const sale = createSale(db, {
    customer_name: 'Aged', payment_method: 'cash',
    items: [{ inventory_id: part.id, quantity: 1, unit_price: 500 }], amount_paid: 500
  });
  db.prepare('UPDATE sales SET created_at = ? WHERE id = ?')
    .run(new Date(Date.now() - 90 * 86400000).toISOString(), sale.id);

  assert.throws(() => createWarrantyReturn(db, {
    sale_id: sale.id, sale_item_id: sale.items[0].id, return_type: 'replacement', return_reason: 'other'
  }), /Warranty expired/);

  const rma = createWarrantyReturn(db, {
    sale_id: sale.id, sale_item_id: sale.items[0].id, return_type: 'replacement', return_reason: 'other'
  }, ctxMgr);
  assert.ok(rma.return_code.startsWith('RMA-'));
  const row = db.prepare("SELECT detail FROM audit_log WHERE category = 'return' ORDER BY id DESC LIMIT 1").get();
  assert.strictEqual(JSON.parse(row.detail).out_of_window, true);
});

// The window an RMA enforces has to be the window the slip prints, and both have
// to come off the one rule (warrantyDays() in src/printer.js). This reader used
// Number() with no trim and no null guard, so a settings row that went NULL, blank
// or whitespace read as a 0-day window and the shop was told its warranty expired
// above a receipt printing seven days. A saved "0" is the one case where zero IS
// the answer: that shop granted no warranty, on paper and here.
dbTest('the RMA warranty window reads the one rule instead of its own coercion', (db) => {
  const { warrantyDays } = require('../src/printer');
  const part = createInventoryItem(db, {
    brand: 'Rule', model_name: 'Window', part_type: 'LCD', price_retail: 500, stock_quantity: 2
  });
  const sale = createSale(db, {
    customer_name: 'Aged', payment_method: 'cash',
    items: [{ inventory_id: part.id, quantity: 1, unit_price: 500 }], amount_paid: 500
  });
  db.prepare('UPDATE sales SET created_at = ? WHERE id = ?')
    .run(new Date(Date.now() - 90 * 86400000).toISOString(), sale.id);

  // The window is what the refusal says it is: the sale is 90 days old, so every
  // value below is out of its window and the message carries the number read off
  // the setting. The item id is deliberately absent, because the window is
  // checked first and nothing is written on a refusal.
  const statedWindow = () => {
    let err = null;
    try {
      createWarrantyReturn(db, { sale_id: sale.id, sale_item_id: 999999, return_type: 'replacement', return_reason: 'other' });
    } catch (e) { err = e; }
    const m = err && /warranty window is (\d+(?:\.\d+)?) days/.exec(err.message);
    if (!m) throw new Error(`no window in the refusal: ${err ? err.message : 'the return was allowed'}`);
    return Number(m[1]);
  };
  const setDays = (v) => db.prepare("INSERT OR REPLACE INTO shop_settings (key, value) VALUES ('warranty_days', ?)").run(v);

  for (const unusable of [null, '', '   ', 'abc', '-3']) {
    setDays(unusable);
    assert.strictEqual(statedWindow(), 7, `warranty_days ${JSON.stringify(unusable)} did not read as seven`);
  }
  setDays('0');
  assert.strictEqual(statedWindow(), 0, 'a saved zero lost its no-warranty choice here');
  setDays('14');
  assert.strictEqual(statedWindow(), 14, 'a real setting got overridden');

  // The enforcement and the print cannot disagree: same numbers in, same number
  // out, on the function the slip is laid out with.
  for (const v of [null, '', '   ', 'abc', '0', '7', '14']) {
    setDays(v);
    assert.strictEqual(statedWindow(), warrantyDays(v), `the RMA window and the slip disagree on ${JSON.stringify(v)}`);
  }
});

dbTest('replacement must draw the returned line SKU: staff throws, elevated may swap same part_type only', (db) => {
  const ctxMgr = { actor: { type: 'manager', id: null, name: 'Manager' }, elevated: true };
  const mk = (brand, model) => createInventoryItem(db, {
    brand, model_name: model, part_type: 'LCD', price_retail: 500, stock_quantity: 3
  });
  const battery = createInventoryItem(db, {
    brand: 'Other', model_name: 'Kind', part_type: 'Battery', price_retail: 300, stock_quantity: 3
  });
  const lcdA = mk('Samsung', 'A10');
  const lcdB = mk('Samsung', 'A20');
  const sale = createSale(db, {
    customer_name: 'Swap', payment_method: 'cash',
    items: [{ inventory_id: lcdA.id, quantity: 2, unit_price: 500 }], amount_paid: 1000
  });
  const si = sale.items[0];
  const args = { sale_id: sale.id, sale_item_id: si.id, return_type: 'replacement', return_reason: 'other' };

  assert.throws(() => createWarrantyReturn(db, { ...args, replacement_inventory_id: lcdB.id }), /needs a manager/);
  assert.strictEqual(getInventoryItem(db, lcdB.id).stock_quantity, 3);

  const swapped = createWarrantyReturn(db, { ...args, replacement_inventory_id: lcdB.id }, ctxMgr);
  assert.strictEqual(swapped.replacement_inventory_id, lcdB.id);
  assert.strictEqual(getInventoryItem(db, lcdB.id).stock_quantity, 2);

  assert.throws(() => createWarrantyReturn(db, { ...args, replacement_inventory_id: battery.id }, ctxMgr), /Cross-part-type/);
  assert.strictEqual(getInventoryItem(db, battery.id).stock_quantity, 3);
});

dbTest('a replacement RMA cannot be filed against a labor line', (db) => {
  const { createInventoryItem } = require('../src/inventory');
  const { createSale } = require('../src/sales');
  const anyPart = createInventoryItem(db, { brand: 'Any', model_name: 'Part', part_type: 'Battery', cost_price: 1, price_retail: 5, stock_quantity: 3 });
  const sale = createSale(db, { payment_method: 'cash', items: [{ item_type: 'labor', item_name: 'Screen install', quantity: 1, unit_price: 100 }], amount_paid: 100 });
  const laborLine = sale.items.find(i => i.item_type === 'labor');
  assert.throws(
    () => createWarrantyReturn(db, { sale_id: sale.id, sale_item_id: laborLine.id, return_type: 'replacement', replacement_inventory_id: anyPart.id }, { actor: { type: 'manager', id: null, name: 'M' }, elevated: true }),
    /no part to replace/
  );
});

dbTest('Warranty Return supports quantity > 1 for returning multiple items at once', (db) => {
  const screen = createInventoryItem(db, {
    brand: 'Apple',
    model_name: 'iPhone 11',
    part_type: 'LCD (Incell)',
    cost_price: 500.0,
    price_retail: 1000.0,
    stock_quantity: 20
  });

  // Customer orders 5 LCDs
  const sale = createSale(db, {
    customer_name: 'Bulk Buyer',
    payment_method: 'cash',
    items: [{ inventory_id: screen.id, quantity: 5, unit_price: 1000.0 }],
    amount_paid: 5000.0
  });

  assert.strictEqual(getInventoryItem(db, screen.id).stock_quantity, 15);

  // Return 3 units via cash refund
  const return1 = createWarrantyReturn(db, {
    sale_id: sale.id,
    sale_item_id: sale.items[0].id,
    quantity: 3,
    return_type: 'cash_refund',
    return_reason: 'ghost_touch',
    refund_amount: 3000.0
  });

  assert.strictEqual(return1.quantity, 3);
  assert.strictEqual(return1.refund_amount, 3000.0);

  // Remaining returnable is 2 units. Attempting to return 3 more units must throw.
  assert.throws(() => {
    createWarrantyReturn(db, {
      sale_id: sale.id,
      sale_item_id: sale.items[0].id,
      quantity: 3,
      return_type: 'cash_refund',
      return_reason: 'ghost_touch'
    });
  }, /Cannot return item: already returned 3 of 5 purchased unit/);

  // Return the remaining 2 units via replacement
  const return2 = createWarrantyReturn(db, {
    sale_id: sale.id,
    sale_item_id: sale.items[0].id,
    quantity: 2,
    return_type: 'replacement',
    return_reason: 'no_display'
  });

  assert.strictEqual(return2.quantity, 2);
  // Stock was 15, replacement deducted 2 fresh units
  assert.strictEqual(getInventoryItem(db, screen.id).stock_quantity, 13);

  // Now all 5 units are returned, subsequent returns fail
  assert.throws(() => {
    createWarrantyReturn(db, {
      sale_id: sale.id,
      sale_item_id: sale.items[0].id,
      quantity: 1,
      return_type: 'replacement'
    });
  }, /Cannot return item: already returned 5 of 5 purchased unit/);
});

dbTest('Warranty Return cash refund syncs with customer total_spent_paid and customer ledger', (db) => {
  const { listCustomers, getCustomerDetails } = require('../src/credits');
  const battery = createInventoryItem(db, {
    brand: 'Apple',
    model_name: 'iPhone 13',
    part_type: 'Battery',
    cost_price: 300.0,
    price_retail: 800.0,
    stock_quantity: 10
  });

  const sale = createSale(db, {
    customer_name: 'Cash Return Customer',
    payment_method: 'cash',
    items: [{ inventory_id: battery.id, quantity: 2, unit_price: 800.0 }],
    amount_paid: 1600.0
  });

  // Before return: customer has spent 1600.0
  let cust = listCustomers(db).find(c => c.customer_name === 'Cash Return Customer');
  assert.strictEqual(cust.total_purchases, 1600.0);
  assert.strictEqual(cust.total_spent_paid, 1600.0);

  // Perform cash return for 1 unit (800.0 refund)
  const rma = createWarrantyReturn(db, {
    sale_id: sale.id,
    sale_item_id: sale.items[0].id,
    quantity: 1,
    return_type: 'cash_refund',
    return_reason: 'battery_drain',
    refund_amount: 800.0
  });
  assert.strictEqual(rma.refund_amount, 800.0);

  // After return: customer total_spent_paid is deducted by cash refund (1600 - 800 = 800)
  cust = listCustomers(db).find(c => c.customer_name === 'Cash Return Customer');
  assert.strictEqual(cust.total_spent_paid, 800.0);
  assert.strictEqual(cust.returns_count, 1);
  assert.strictEqual(cust.total_refunded, 800.0);

  // Customer ledger details must include the returns list and sale rma info
  const details = getCustomerDetails(db, 'Cash Return Customer');
  assert.strictEqual(details.total_spent_paid, 800.0);
  assert.strictEqual(details.returns.length, 1);
  assert.strictEqual(details.returns[0].return_code, rma.return_code);
  assert.strictEqual(details.returns[0].refund_amount, 800.0);
  assert.strictEqual(details.sales[0].rma_count, 1);
  assert.strictEqual(details.sales[0].refunded_amount, 800.0);

  // listWarrantyReturns exposes sale_code and supports search by sale_code
  const listed = listWarrantyReturns(db, { search: sale.sale_code });
  assert.strictEqual(listed.length, 1);
  assert.strictEqual(listed[0].return_code, rma.return_code);
  assert.strictEqual(listed[0].sale_code, sale.sale_code);
});


// A replacement moves no money, but refund_amount is request-supplied and the
// replacement branch never touched it: one bad payload persisted a figure that
// every consumer (netProfit, netRevenue, refunded totals, dashboard, customer
// details) subtracts, permanently deflating the reports.
dbTest('a replacement RMA never stores a refund amount, so the reports cannot be deflated', (db) => {
  const part = createInventoryItem(db, {
    brand: 'Zero', model_name: 'Refund', part_type: 'Battery', price_retail: 500, stock_quantity: 5
  });
  const sale = createSale(db, {
    customer_name: 'Replacement Shop', payment_method: 'cash',
    items: [{ inventory_id: part.id, quantity: 1, unit_price: 500 }], amount_paid: 500
  });
  const rma = createWarrantyReturn(db, {
    sale_id: sale.id, sale_item_id: sale.items[0].id,
    return_type: 'replacement', refund_amount: 500 // crafted payload: ignored
  });
  assert.strictEqual(Number(rma.refund_amount), 0, 'a replacement must store no money');

  const { getDashboardStats } = require('../src/analytics');
  const { listSales } = require('../src/sales');
  const { getCustomerDetails } = require('../src/credits');
  assert.strictEqual(getDashboardStats(db).today_refunded_total, 0, 'dashboard refunded total');
  assert.strictEqual(Number(listSales(db)[0].refunded_amount), 0, 'sale history refunded figure');
  assert.strictEqual(getCustomerDetails(db, 'Replacement Shop').total_refunded, 0, 'customer ledger refunded figure');
});

// The cash path scaled the per-unit price by total_amount/subtotal; the credit
// path used the undiscounted unit_price * qty, so a discounted utang sale
// forgave the discount share twice and understated receivables.
dbTest('credit refund on a discounted utang sale relieves the discounted share, not the list price', (db) => {
  const part = createInventoryItem(db, {
    brand: 'Disc', model_name: 'Utang', part_type: 'LCD', price_retail: 500, stock_quantity: 4
  });
  const sale = createSale(db, {
    customer_name: 'Discounted Utang', payment_method: 'credit',
    items: [{ inventory_id: part.id, quantity: 2, unit_price: 500 }],
    discount: 200, amount_paid: 0
  });
  assert.strictEqual(sale.subtotal, 1000);
  assert.strictEqual(sale.total_amount, 800);
  assert.strictEqual(sale.credit_balance, 800);

  const rma = createWarrantyReturn(db, {
    sale_id: sale.id, sale_item_id: sale.items[0].id, return_type: 'credit_refund'
  });
  // One of two units: its discounted share is 400, not the 500 list price.
  assert.strictEqual(rma.refund_amount, 400);
  const after = Number(db.prepare('SELECT credit_balance FROM sales WHERE id = ?').get(sale.id).credit_balance);
  assert.strictEqual(after, 400, 'the remaining utang keeps its discounted share');
});
