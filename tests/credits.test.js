// phone-repair-pos/tests/credits.test.js
const assert = require('node:assert');
const { dbTest } = require('./helper');
const { createInventoryItem } = require('../src/inventory');
const { createSale } = require('../src/sales');
const { createWarrantyReturn } = require('../src/returns');
const {
  listCustomers,
  getCustomerDetails,
  settleCustomerCredit,
  setCustomerCreditLimit
} = require('../src/credits');

dbTest('Customer Credit Ledger aggregates customer status and settles utang via FIFO', (db) => {
  const item = createInventoryItem(db, {
    brand: 'Apple',
    model_name: 'iPhone 13',
    part_type: 'LCD (OLED)',
    cost_price: 50.0,
    price_retail: 100.0,
    price_technician: 80.0,
    stock_quantity: 20
  });

  // Customer 1: John Doe - Buys 1 on full Cash -> Clean (No Credit)
  createSale(db, {
    customer_name: 'John Doe',
    customer_phone: '09170000001',
    payment_method: 'cash',
    items: [{ inventory_id: item.id, quantity: 1, unit_price: 100.0 }],
    amount_paid: 100.0
  });

  // Customer 2: Mark Tech - Buys on Credit (Sale 1: 100.0 total, 20.0 paid -> 80.0 credit)
  createSale(db, {
    customer_name: 'Mark Tech',
    customer_phone: '09170000002',
    payment_method: 'credit',
    items: [{ inventory_id: item.id, quantity: 1, unit_price: 100.0 }],
    amount_paid: 20.0
  });

  // Customer 2: Mark Tech - Buys on Credit (Sale 2: 200.0 total, 0.0 paid -> 200.0 credit)
  createSale(db, {
    customer_name: 'Mark Tech',
    customer_phone: '09170000002',
    payment_method: 'credit',
    items: [{ inventory_id: item.id, quantity: 2, unit_price: 100.0 }],
    amount_paid: 0.0
  });

  // 1. Verify listCustomers
  const customers = listCustomers(db);
  assert.strictEqual(customers.length, 2);

  const john = customers.find(c => c.customer_name === 'John Doe');
  assert.ok(john);
  assert.strictEqual(john.total_purchases, 100.0);
  assert.strictEqual(john.total_credit_balance, 0.0);
  assert.strictEqual(john.status, 'clean');

  const mark = customers.find(c => c.customer_name === 'Mark Tech');
  assert.ok(mark);
  assert.strictEqual(mark.total_purchases, 300.0);
  assert.strictEqual(mark.total_credit_balance, 280.0); // 80 + 200
  assert.strictEqual(mark.status, 'active_credit');

  // Filter only debtors
  const debtors = listCustomers(db, { filter: 'credit' });
  assert.strictEqual(debtors.length, 1);
  assert.strictEqual(debtors[0].customer_name, 'Mark Tech');

  // 2. Verify getCustomerDetails
  const markDetails = getCustomerDetails(db, 'Mark Tech');
  assert.strictEqual(markDetails.customer_name, 'Mark Tech');
  assert.strictEqual(markDetails.sales.length, 2);
  assert.strictEqual(markDetails.total_credit_balance, 280.0);

  // 3. Settle partial credit: Mark pays 100.0 via GCash
  // Should pay off Sale 1 (80.0) completely, and reduce Sale 2 by 20.0 (leaving 180.0 debt)
  const settlement = settleCustomerCredit(db, {
    customer_name: 'Mark Tech',
    amount_paid: 100.0,
    payment_method: 'gcash',
    payment_reference: 'GCASH-SETTLE-001',
    notes: 'Paid via GCash at counter'
  });

  assert.strictEqual(settlement.total_credit_balance, 180.0);
  assert.strictEqual(settlement.payments.length, 1);
  assert.strictEqual(settlement.payments[0].amount_paid, 100.0);
  assert.strictEqual(settlement.payments[0].payment_reference, 'GCASH-SETTLE-001');

  // Settle remaining 180.0 credit -> status becomes clean
  const finalSettlement = settleCustomerCredit(db, {
    customer_name: 'Mark Tech',
    amount_paid: 180.0,
    payment_method: 'cash'
  });

  assert.strictEqual(finalSettlement.total_credit_balance, 0.0);
  assert.strictEqual(finalSettlement.status, 'clean');
});

dbTest('Customer Credit Ledger rejects settlement exceeding outstanding debt', (db) => {
  const item = createInventoryItem(db, {
    brand: 'Samsung',
    model_name: 'Galaxy A32',
    part_type: 'Screen',
    price_retail: 300.0,
    stock_quantity: 10
  });

  createSale(db, {
    customer_name: 'Debt Limit Test',
    payment_method: 'credit',
    items: [{ inventory_id: item.id, quantity: 1, unit_price: 300.0 }],
    amount_paid: 0.0
  });

  // Attempting to settle ₱99,999 against ₱300 debt must throw
  assert.throws(() => {
    settleCustomerCredit(db, {
      customer_name: 'Debt Limit Test',
      amount_paid: 99999.0,
      payment_method: 'cash'
    });
  }, /Payment amount \(₱99999\.00\) exceeds total outstanding credit \(₱300\.00\)/);

  // Exact ₱300 settlement succeeds
  const settled = settleCustomerCredit(db, {
    customer_name: 'Debt Limit Test',
    amount_paid: 300.0,
    payment_method: 'cash'
  });
  assert.strictEqual(settled.total_credit_balance, 0.0);
  assert.strictEqual(settled.status, 'clean');

  // A typo'd settlement method is money no dashboard bucket reports — reject.
  createSale(db, {
    customer_name: 'Method Check',
    payment_method: 'credit',
    items: [{ inventory_id: item.id, quantity: 1, unit_price: 300.0 }],
    amount_paid: 0.0
  });
  assert.throws(() => {
    settleCustomerCredit(db, { customer_name: 'Method Check', amount_paid: 50.0, payment_method: 'gcasch' });
  }, /Invalid payment method: gcasch/);
  const untouched = db.prepare("SELECT COUNT(*) AS c FROM credit_payments WHERE customer_name = 'Method Check'").get();
  assert.strictEqual(untouched.c, 0, 'rejected method wrote no payment row');
});

dbTest('Customer list caps rows and orders by outstanding credit', (db) => {
  const item = createInventoryItem(db, {
    brand: 'X', model_name: 'Y', part_type: 'Z',
    cost_price: 10.0, price_retail: 100.0, price_technician: 90.0, stock_quantity: 10
  });

  for (const [name, paid] of [['Low Debtor', 90.0], ['Big Debtor', 0.0], ['Mid Debtor', 50.0]]) {
    createSale(db, {
      customer_name: name,
      payment_method: 'credit',
      items: [{ inventory_id: item.id, quantity: 1, unit_price: 100.0 }],
      amount_paid: paid
    });
  }

  // Debts: Big 100, Mid 50, Low 10 -> capped list keeps the biggest debtors.
  const capped = listCustomers(db, { limit: 2 });
  assert.strictEqual(capped.length, 2);
  assert.strictEqual(capped[0].customer_name, 'Big Debtor');
  assert.strictEqual(capped[1].customer_name, 'Mid Debtor');

  // The default cap must not bite realistic shops.
  assert.strictEqual(listCustomers(db).length, 3);
});

dbTest('settlement only allocates balances belonging to credit sales', (db) => {
  const item = createInventoryItem(db, {
    brand: 'Credit', model_name: 'Only', part_type: 'Part', price_retail: 100, stock_quantity: 2
  });
  const cash = createSale(db, {
    customer_name: 'Corrupt Balance', payment_method: 'cash',
    items: [{ inventory_id: item.id, quantity: 1 }], amount_paid: 100
  });
  db.prepare('UPDATE sales SET credit_balance = 50 WHERE id = ?').run(cash.id);
  assert.throws(() => settleCustomerCredit(db, {
    customer_name: 'Corrupt Balance', amount_paid: 10, payment_method: 'cash'
  }), /no outstanding credit/);
});

dbTest('credit refund enqueues the changed sale snapshot', (db) => {
  const item = createInventoryItem(db, {
    brand: 'Refund', model_name: 'Sync', part_type: 'Part', price_retail: 100, stock_quantity: 2
  });
  const sale = createSale(db, {
    customer_name: 'Refund Sync', payment_method: 'credit',
    items: [{ inventory_id: item.id, quantity: 1 }], amount_paid: 0
  });
  db.prepare('UPDATE sync_outbox SET synced_at = ?').run(new Date().toISOString());
  createWarrantyReturn(db, {
    sale_id: sale.id, sale_item_id: sale.items[0].id, return_type: 'credit_refund', refund_amount: 25
  });
  const event = db.prepare("SELECT payload FROM sync_outbox WHERE table_name = 'sales' AND local_id = ? AND synced_at IS NULL ORDER BY id DESC LIMIT 1").get(sale.id);
  assert.ok(event);
  assert.strictEqual(JSON.parse(event.payload).credit_balance, 75);
});

dbTest('Customer credit limit setting and checkout enforcement', (db) => {
  const item = createInventoryItem(db, {
    brand: 'Samsung', model_name: 'S22', part_type: 'Screen', price_retail: 1000, stock_quantity: 10
  });

  // 1. Set credit limit
  setCustomerCreditLimit(db, 'CreditTester', 1500, 'VIP Customer');
  const details = getCustomerDetails(db, 'CreditTester');
  assert.strictEqual(details.credit_limit, 1500);
  assert.strictEqual(details.notes, 'VIP Customer');

  // 2. Credit sale within limit passes (1000 <= 1500)
  const sale1 = createSale(db, {
    customer_name: 'CreditTester',
    payment_method: 'credit',
    items: [{ inventory_id: item.id, quantity: 1 }],
    amount_paid: 0
  });
  assert.strictEqual(sale1.credit_balance, 1000);

  // 3. Second credit sale exceeding limit (1000 + 1000 = 2000 > 1500) fails without elevation
  assert.throws(() => {
    createSale(db, {
      customer_name: 'CreditTester',
      payment_method: 'credit',
      items: [{ inventory_id: item.id, quantity: 1 }],
      amount_paid: 0
    });
  }, (err) => {
    return err.statusCode === 403 && err.code === 'elevation_required' && err.message.includes('Credit limit of ₱1500.00 exceeded');
  });

  // 4. Manager override with ctx.elevated passes
  const sale2 = createSale(db, {
    customer_name: 'CreditTester',
    payment_method: 'credit',
    items: [{ inventory_id: item.id, quantity: 1 }],
    amount_paid: 0
  }, { elevated: true });
  assert.strictEqual(sale2.credit_balance, 1000);

  // 5. Verify audit log row
  setCustomerCreditLimit(db, 'CreditTester', 2500, '', { actor: { name: 'Boss', type: 'manager' }, elevated: true });
  const auditRow = db.prepare("SELECT * FROM audit_log WHERE category = 'credit' AND action = 'set_limit' ORDER BY id DESC LIMIT 1").get();
  assert.ok(auditRow);
  assert.strictEqual(auditRow.actor_name, 'Boss');
  assert.strictEqual(JSON.parse(auditRow.detail).credit_limit, 2500);
});


dbTest('D3: one debtor regardless of how the name was typed', (db) => {
  createSale(db, { customer_name: 'JOHN DOE', payment_method: 'credit', items: [{ item_type: 'labor', item_name: 'Panel', unit_price: 1000, quantity: 1 }], amount_paid: 0 });
  createSale(db, { customer_name: 'John Doe', payment_method: 'credit', items: [{ item_type: 'labor', item_name: 'Battery', unit_price: 1000, quantity: 1 }], amount_paid: 0 });

  // The spelling that owes nothing on its own can still clear the whole debt.
  const settled = settleCustomerCredit(db, { customer_name: 'john doe', amount_paid: 1500, payment_method: 'cash' });
  assert.equal(settled.total_credit_balance, 500);

  const rows = listCustomers(db, { search: 'doe' });
  assert.equal(rows.length, 1, 'two spellings are one customer in the list');
  assert.equal(rows[0].sales_count, 2);
  assert.equal(rows[0].total_credit_balance, 500);

  // The limit check already summed both spellings; it must keep doing so after
  // the write rule collapses stray whitespace too.
  setCustomerCreditLimit(db, 'John Doe', 400);
  assert.throws(() => createSale(db, {
    customer_name: '  JOHN   DOE  ', payment_method: 'credit',
    items: [{ item_type: 'labor', item_name: 'LCD', unit_price: 200, quantity: 1 }], amount_paid: 0
  }), /Credit limit of .* exceeded/);

  // The ledger detail follows the same rule as the list.
  const details = getCustomerDetails(db, 'JOHN DOE');
  assert.equal(details.sales_count, 2);
  assert.equal(details.total_credit_balance, 500);
});

// SQLite's COLLATE NOCASE and lower() fold ASCII only, so 'Muñoz' and 'MUÑOZ'
// (common in Filipino names) were two debtors, the variants review list built on
// lower() never surfaced the pair, and a re-cased diacritic name walked past the
// credit-limit sum entirely.
dbTest('D4: a diacritic name re-cased is one debtor and cannot walk past the credit limit', (db) => {
  const { listCustomerNameVariants } = require('../src/credits');
  createSale(db, { customer_name: 'Muñoz', payment_method: 'credit', items: [{ item_type: 'labor', item_name: 'Panel', unit_price: 600, quantity: 1 }], amount_paid: 0 });
  createSale(db, { customer_name: 'MUÑOZ', payment_method: 'credit', items: [{ item_type: 'labor', item_name: 'Battery', unit_price: 600, quantity: 1 }], amount_paid: 0 });

  const rows = listCustomers(db, { search: '' });
  const munoz = rows.filter(r => /muñoz/i.test(r.customer_name));
  assert.equal(munoz.length, 1, 'the two spellings are one debtor');
  assert.equal(munoz[0].total_credit_balance, 1200);

  const details = getCustomerDetails(db, 'MUÑOZ');
  assert.equal(details.sales_count, 2, 'the ledger follows the fold');
  assert.equal(details.total_credit_balance, 1200);

  // The review list meant to catch exactly this case must surface it.
  const variants = listCustomerNameVariants(db);
  const hit = variants.find(v => /muñoz/i.test(v.variants.join(' ')));
  assert.ok(hit, `the variants list must surface the pair, got ${JSON.stringify(variants)}`);
  assert.equal(hit.spellings, 2);

  // The limit check sums the folded name, so re-casing cannot bypass it.
  setCustomerCreditLimit(db, 'Muñoz', 1000);
  assert.throws(() => createSale(db, {
    customer_name: 'MUÑOZ', payment_method: 'credit',
    items: [{ item_type: 'labor', item_name: 'LCD', unit_price: 200, quantity: 1 }], amount_paid: 0
  }), /Credit limit of .* exceeded/);

  // A profile saved under a new spelling collapses onto one row.
  setCustomerCreditLimit(db, 'MUÑOZ', 1500);
  const profRows = db.prepare('SELECT COUNT(*) AS c FROM customer_profiles').get().c;
  assert.equal(profRows, 1, 'one profile row per folded name');
  assert.equal(getCustomerDetails(db, 'muñoz').credit_limit, 1500);
});

// The same bypass through the ASCII-only NOCASE used to split a name that
// differs only in its diacritic form (composed vs decomposed). cleanName()
// normalizes NFC on write, so both spellings store identically.
dbTest('D5: composed and decomposed diacritics store as one name', (db) => {
  const composed = 'Pe\u00f1a';        // ñ as U+00F1
  const decomposed = 'Pen\u0303a';     // n + U+0303 combining tilde
  createSale(db, { customer_name: composed, payment_method: 'credit', items: [{ item_type: 'labor', item_name: 'A', unit_price: 100, quantity: 1 }], amount_paid: 0 });
  createSale(db, { customer_name: decomposed, payment_method: 'credit', items: [{ item_type: 'labor', item_name: 'B', unit_price: 100, quantity: 1 }], amount_paid: 0 });
  const rows = listCustomers(db, { search: '' });
  assert.equal(rows.filter(r => /pe/i.test(r.customer_name) && r.sales_count === 2).length, 1, 'NFC-normalized storage keeps one debtor');
});
