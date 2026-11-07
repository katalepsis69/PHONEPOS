// phone-repair-pos/tests/sales.test.js
const assert = require('node:assert');
const { dbTest } = require('./helper');
const { createInventoryItem, getInventoryItem } = require('../src/inventory');
const { createSale, listSales } = require('../src/sales');
const { createWarrantyReturn } = require('../src/returns');
const { money } = require('../src/money');

dbTest('money rejects non-finite and excessive values and rounds decimal ties correctly', () => {
  assert.strictEqual(money(1.005), 1.01);
  assert.strictEqual(money(10.075), 10.08);
  assert.strictEqual(money(-1.005), -1.01);
  assert.throws(() => money(Infinity), /finite number/);
  assert.throws(() => money('not-a-number'), /finite number/);
  assert.throws(() => money(1000000000), /exceeds maximum/);
});

dbTest('POS Checkout handles Cash with discount and customer name', (db) => {
  const screen = createInventoryItem(db, {
    brand: 'Samsung',
    model_name: 'Galaxy A52',
    part_type: 'LCD (OLED)',
    cost_price: 20.0,
    price_retail: 50.0,
    price_technician: 40.0,
    stock_quantity: 10
  });

  const sale = createSale(db, {
    customer_name: 'Alice Repair Tech',
    customer_phone: '09171112222',
    customer_type: 'technician',
    payment_method: 'cash',
    items: [
      { inventory_id: screen.id, quantity: 2, unit_price: 40.0 }
    ],
    discount: 10.0,
    amount_paid: 100.0
  });

  assert.ok(sale.sale_code.startsWith('SALE-'));
  assert.strictEqual(sale.customer_name, 'Alice Repair Tech');
  assert.strictEqual(sale.customer_phone, '09171112222');
  assert.strictEqual(sale.subtotal, 80.0);
  assert.strictEqual(sale.discount, 10.0);
  assert.strictEqual(sale.total_amount, 70.0);
  assert.strictEqual(sale.amount_paid, 100.0);
  assert.strictEqual(sale.change_amount, 30.0);
  assert.strictEqual(sale.credit_balance, 0.0);

  const updatedScreen = getInventoryItem(db, screen.id);
  assert.strictEqual(updatedScreen.stock_quantity, 8);
});

dbTest('POS Checkout handles GCash with payment reference', (db) => {
  const battery = createInventoryItem(db, {
    brand: 'Apple',
    model_name: 'iPhone 11',
    part_type: 'Battery',
    cost_price: 15.0,
    price_retail: 35.0,
    price_technician: 28.0,
    stock_quantity: 5
  });

  const sale = createSale(db, {
    customer_name: 'Bob Customer',
    payment_method: 'gcash',
    payment_reference: 'GCASH-9988776655',
    items: [
      { inventory_id: battery.id, quantity: 1, unit_price: 35.0 }
    ],
    discount: 0.0,
    amount_paid: 35.0
  });

  assert.strictEqual(sale.customer_name, 'Bob Customer');
  assert.strictEqual(sale.payment_method, 'gcash');
  assert.strictEqual(sale.payment_reference, 'GCASH-9988776655');
  assert.strictEqual(sale.total_amount, 35.0);
  assert.strictEqual(sale.credit_balance, 0.0);
});

dbTest('POS Checkout handles Credit (Utang) with partial and full debt', (db) => {
  const item = createInventoryItem(db, {
    brand: 'Xiaomi',
    model_name: 'Redmi Note 10',
    part_type: 'Charging Port',
    cost_price: 5.0,
    price_retail: 25.0,
    price_technician: 20.0,
    stock_quantity: 20
  });

  // Partial downpayment credit sale
  const sale1 = createSale(db, {
    customer_name: 'Charlie Sukit',
    customer_phone: '09181234567',
    payment_method: 'credit',
    items: [
      { inventory_id: item.id, quantity: 4, unit_price: 25.0 } // 100.0 total
    ],
    discount: 10.0, // 90.0 total_amount
    amount_paid: 30.0 // downpayment 30.0 -> credit_balance = 60.0
  });

  assert.strictEqual(sale1.total_amount, 90.0);
  assert.strictEqual(sale1.amount_paid, 30.0);
  assert.strictEqual(sale1.credit_balance, 60.0);
  assert.strictEqual(sale1.change_amount, 0.0);

  // Full utang credit sale (0 downpayment)
  const sale2 = createSale(db, {
    customer_name: 'Charlie Sukit',
    payment_method: 'credit',
    items: [
      { inventory_id: item.id, quantity: 2, unit_price: 25.0 } // 50.0 total
    ],
    discount: 0.0,
    amount_paid: 0.0
  });

  assert.strictEqual(sale2.total_amount, 50.0);
  assert.strictEqual(sale2.amount_paid, 0.0);
  assert.strictEqual(sale2.credit_balance, 50.0);
});

dbTest('POS Checkout handles Labor and Parts in a single transaction', (db) => {
  const screen = createInventoryItem(db, {
    brand: 'Apple',
    model_name: 'iPhone 11',
    part_type: 'LCD (Incell)',
    cost_price: 650.0,
    price_retail: 1400.0,
    price_technician: 1100.0,
    stock_quantity: 5
  });

  const sale = createSale(db, {
    customer_name: 'John Customer',
    customer_type: 'retail',
    payment_method: 'cash',
    items: [
      { inventory_id: screen.id, quantity: 1, unit_price: 1400.0, item_type: 'part' },
      { item_type: 'labor', item_name: 'Screen Installation Labor', unit_price: 300.0, quantity: 1 }
    ],
    discount: 50.0,
    amount_paid: 1650.0
  });

  assert.strictEqual(sale.subtotal, 1700.0);
  assert.strictEqual(sale.discount, 50.0);
  assert.strictEqual(sale.total_amount, 1650.0);
  assert.strictEqual(sale.items.length, 2);

  const laborItem = sale.items.find(i => i.item_type === 'labor');
  assert.ok(laborItem);
  assert.strictEqual(laborItem.item_name, 'Screen Installation Labor');
  assert.strictEqual(laborItem.unit_cost, 0.0);
  assert.strictEqual(laborItem.unit_price, 300.0);

  // Verify inventory stock reduced by 1 for screen
  const updatedScreen = getInventoryItem(db, screen.id);
  assert.strictEqual(updatedScreen.stock_quantity, 4);
});

dbTest('POS Checkout rejects negative discounts, negative payments, and non-integer quantities', (db) => {
  const item = createInventoryItem(db, {
    brand: 'Apple',
    model_name: 'iPhone 11',
    part_type: 'Battery',
    cost_price: 15.0,
    price_retail: 35.0,
    stock_quantity: 10
  });

  // Negative discount
  assert.throws(() => createSale(db, {
    customer_name: 'Test',
    items: [{ inventory_id: item.id, quantity: 1 }],
    discount: -10
  }), /Discount amount cannot be negative/);

  // Negative paid
  assert.throws(() => createSale(db, {
    customer_name: 'Test',
    items: [{ inventory_id: item.id, quantity: 1 }],
    amount_paid: -50
  }), /Amount paid cannot be negative/);

  // Invalid quantity (0 or negative)
  assert.throws(() => createSale(db, {
    customer_name: 'Test',
    items: [{ inventory_id: item.id, quantity: 0 }]
  }), /Invalid item quantity/);

  // Fractional quantity
  assert.throws(() => createSale(db, {
    customer_name: 'Test',
    items: [{ inventory_id: item.id, quantity: 1.5 }]
  }), /Invalid item quantity/);

  // Unknown payment method would be money no dashboard bucket reports
  assert.throws(() => createSale(db, {
    customer_name: 'Test',
    payment_method: 'paymaya',
    items: [{ inventory_id: item.id, quantity: 1 }]
  }), /Invalid payment method/);

  // Unknown customer type would silently price as retail
  assert.throws(() => createSale(db, {
    customer_name: 'Test',
    customer_type: 'wholesaler',
    items: [{ inventory_id: item.id, quantity: 1 }]
  }), /Invalid customer type/);

  // Non-string phone / reference must not crash the insert
  const ok = createSale(db, {
    customer_name: 'Test',
    customer_phone: null,
    payment_reference: 12345,
    payment_method: 'gcash',
    items: [{ inventory_id: item.id, quantity: 1, unit_price: 35.0 }],
    discount: 0,
    amount_paid: 35.0
  });
  assert.strictEqual(ok.customer_phone, '');
  assert.strictEqual(ok.payment_reference, '12345');
  assert.strictEqual(ok.discount, 0.0);
  assert.strictEqual(ok.total_amount, 35.0);

  assert.throws(() => createSale(db, {
    customer_name: 'Test',
    payment_method: 'cash',
    items: [{ item_type: 'labor', quantity: 1, unit_price: Infinity }],
    amount_paid: 35
  }), /finite number/);
});

dbTest('non-credit checkout cannot persist an unpaid balance', (db) => {
  const item = createInventoryItem(db, {
    brand: 'Safe', model_name: 'Payment', part_type: 'Part', price_retail: 100, stock_quantity: 2
  });
  assert.throws(() => createSale(db, {
    payment_method: 'cash', items: [{ inventory_id: item.id, quantity: 1 }], amount_paid: 99.99
  }), /must be fully paid/);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS c FROM sales').get().c, 0);
});

dbTest('part prices come from the selected catalog tier and credit downpayments cannot exceed total', (db) => {
  const item = createInventoryItem(db, {
    brand: 'Server', model_name: 'Pricing', part_type: 'Part',
    price_retail: 100, price_technician: 75, stock_quantity: 3
  });
  const retail = createSale(db, {
    customer_type: 'retail', payment_method: 'cash',
    items: [{ inventory_id: item.id, quantity: 1, unit_price: 0.01 }], amount_paid: 100
  });
  assert.strictEqual(retail.items[0].unit_price, 100);
  const technician = createSale(db, {
    customer_type: 'technician', payment_method: 'cash',
    items: [{ inventory_id: item.id, quantity: 1, unit_price: 999999 }], amount_paid: 75
  });
  assert.strictEqual(technician.items[0].unit_price, 75);
  assert.throws(() => createSale(db, {
    customer_type: 'retail', payment_method: 'credit',
    items: [{ inventory_id: item.id, quantity: 1 }], amount_paid: 100.01
  }), /cannot exceed total amount/);
});

dbTest('POS Checkout avoids floating point inaccuracies with 2dp rounding', (db) => {
  const screw = createInventoryItem(db, {
    brand: 'Generic',
    model_name: 'Screw Pack',
    part_type: 'Screw',
    cost_price: 0.05,
    price_retail: 0.10,
    stock_quantity: 100
  });

  // 3 * 0.10 = 0.30000000000000004 in raw float arithmetic
  const sale = createSale(db, {
    customer_name: 'Precision Test',
    payment_method: 'credit',
    items: [{ inventory_id: screw.id, quantity: 3, unit_price: 0.10 }],
    amount_paid: 0.30
  });

  assert.strictEqual(sale.subtotal, 0.30);
  assert.strictEqual(sale.total_amount, 0.30);
  assert.strictEqual(sale.amount_paid, 0.30);
  assert.strictEqual(sale.credit_balance, 0.0);
});

dbTest('Sales search reaches item names, so the RO reference is findable', (db) => {
  const item = createInventoryItem(db, {
    brand: 'Samsung',
    model_name: 'Galaxy A55',
    part_type: 'LCD (OLED)',
    cost_price: 30.0,
    price_retail: 70.0,
    stock_quantity: 5
  });

  createSale(db, {
    customer_name: 'RO Search Customer',
    payment_method: 'cash',
    items: [
      { inventory_id: item.id, quantity: 1, unit_price: 70.0 },
      // The intake line the POS sends: device + IMEI ride as a ₱0 labor line
      { item_type: 'labor', item_name: 'DEVICE · RO-260830-999 · Samsung Galaxy A55 · IMEI 123456', unit_price: 0, quantity: 1 }
    ],
    amount_paid: 70.0
  });

  // Quoting the paper tag's RO code over the phone must find the sale.
  assert.strictEqual(listSales(db, { search: 'RO-260830-999' }).length, 1);
  // IMEI too — it lives on the same line.
  assert.strictEqual(listSales(db, { search: '123456' }).length, 1);
  assert.strictEqual(listSales(db, { search: 'RO-000000-000' }).length, 0);
});

dbTest('Sales date filter matches the local calendar day', (db) => {
  const item = createInventoryItem(db, {
    brand: 'Xiaomi',
    model_name: 'Redmi 12',
    part_type: 'Battery',
    cost_price: 8.0,
    price_retail: 25.0,
    stock_quantity: 5
  });

  createSale(db, {
    customer_name: 'Date Filter Customer',
    payment_method: 'cash',
    items: [{ inventory_id: item.id, quantity: 1, unit_price: 25.0 }],
    amount_paid: 25.0
  });

  const now = new Date();
  const ymd = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  assert.strictEqual(listSales(db, { date: ymd }).length, 1);
  assert.strictEqual(listSales(db, { date: '2000-01-01' }).length, 0);
});

dbTest('Sales history rows carry rma_count once a warranty return lands', (db) => {
  const item = createInventoryItem(db, {
    brand: 'Apple', model_name: 'iPhone 11', part_type: 'LCD',
    cost_price: 10, price_retail: 30, stock_quantity: 5
  });
  const sale = createSale(db, {
    customer_name: 'RMA Tag Customer',
    items: [{ inventory_id: item.id, quantity: 2, unit_price: 30 }],
    amount_paid: 60
  });

  const before = listSales(db, { search: 'RMA Tag' }).find(s => s.id === sale.id);
  assert.strictEqual(before.rma_count, 0);
  assert.strictEqual(before.rma_available, 1);

  createWarrantyReturn(db, {
    sale_id: sale.id,
    sale_item_id: sale.items[0].id,
    return_type: 'cash_refund'
  });
  const after = listSales(db, { search: 'RMA Tag' }).find(s => s.id === sale.id);
  assert.strictEqual(after.rma_count, 1);
  assert.strictEqual(after.rma_available, 1); // qty-2 line: one unit still claimable

  // Claim the remaining unit -> nothing left to return on this sale.
  createWarrantyReturn(db, {
    sale_id: sale.id,
    sale_item_id: sale.items[0].id,
    return_type: 'cash_refund'
  });
  const spent = listSales(db, { search: 'RMA Tag' }).find(s => s.id === sale.id);
  assert.strictEqual(spent.rma_count, 2);
  assert.strictEqual(spent.rma_available, 0);

  // Untouched sales report zero, not null; labor-only sales have nothing to claim.
  const other = createSale(db, {
    customer_name: 'RMA Tag Customer',
    items: [{ item_type: 'labor', item_name: 'Diagnostics', unit_price: 50, quantity: 1 }],
    amount_paid: 50
  });
  const otherRow = listSales(db, { search: 'RMA Tag' }).find(s => s.id === other.id);
  assert.strictEqual(otherRow.rma_count, 0);
  assert.strictEqual(otherRow.rma_available, 0);
});

dbTest('A multi-part sale writes one negative movement per part line with the sale code', (db) => {
  const a = createInventoryItem(db, { brand: 'Apple', model_name: 'iPhone 11', part_type: 'LCD', cost_price: 10, price_retail: 30, stock_quantity: 10 });
  const b = createInventoryItem(db, { brand: 'Samsung', model_name: 'A32', part_type: 'LCD', cost_price: 10, price_retail: 30, stock_quantity: 10 });

  const sale = createSale(db, {
    customer_name: 'Ledger Test',
    items: [
      { inventory_id: a.id, quantity: 2, unit_price: 30 },
      { inventory_id: b.id, quantity: 1, unit_price: 30 },
      { item_type: 'labor', item_name: 'Install', unit_price: 50, quantity: 1 }
    ],
    amount_paid: 140
  });

  const saleMoves = db.prepare("SELECT inventory_id, delta, reason, ref FROM stock_movements WHERE reason = 'sale'").all();
  assert.strictEqual(saleMoves.length, 2);
  assert.ok(saleMoves.every(m => m.ref === sale.sale_code));
  const byId = Object.fromEntries(saleMoves.map(m => [m.inventory_id, m.delta]));
  assert.strictEqual(byId[a.id], -2);
  assert.strictEqual(byId[b.id], -1);
});

dbTest('A sale that fails mid-transaction rolls back its stock movements', (db) => {
  const item = createInventoryItem(db, { brand: 'Apple', model_name: 'iPhone 11', part_type: 'LCD', cost_price: 10, price_retail: 30, stock_quantity: 5 });

  // Two lines of the same part: each passes the pre-check (5 >= 3), but the
  // second decrement inside the transaction trips the below-zero guard.
  assert.throws(() => createSale(db, {
    customer_name: 'Rollback Test',
    items: [{ inventory_id: item.id, quantity: 3 }, { inventory_id: item.id, quantity: 3 }],
    amount_paid: 180
  }), /Insufficient stock/);

  assert.strictEqual(getInventoryItem(db, item.id).stock_quantity, 5);
  // Only the opening_balance row remains: no sale movement, no orphan.
  assert.deepStrictEqual(
    db.prepare('SELECT delta, reason FROM stock_movements WHERE inventory_id = ?').all(item.id)
      .map(m => ({ delta: m.delta, reason: m.reason })),
    [{ delta: 5, reason: 'opening_balance' }]);
  assert.strictEqual(listSales(db, { search: 'Rollback Test' }).length, 0);
});

dbTest('POS Checkout verifies wholesale tier (technician) pricing, stock deduction, and float accuracy', (db) => {
  const battery = createInventoryItem(db, {
    brand: 'Apple',
    model_name: 'iPhone 13',
    part_type: 'Battery',
    cost_price: 450.50,
    price_retail: 950.00,
    price_technician: 750.33,
    stock_quantity: 15
  });

  const screen = createInventoryItem(db, {
    brand: 'Apple',
    model_name: 'iPhone 13',
    part_type: 'OLED Screen',
    cost_price: 1200.00,
    price_retail: 2500.00,
    price_technician: 1850.67,
    stock_quantity: 8
  });

  // Wholesale checkout omitting unit_price so it automatically falls back to price_technician
  // 750.33 * 3 = 2250.99
  // 1850.67 * 1 = 1850.67
  // Subtotal = 2250.99 + 1850.67 = 4101.66
  // Discount = 101.66
  // Total = 4000.00
  // Paid = 5000.00 -> change = 1000.00
  const sale = createSale(db, {
    customer_name: 'Wholesale Partner Tech',
    customer_phone: '09998887777',
    customer_type: 'technician',
    payment_method: 'cash',
    items: [
      { inventory_id: battery.id, quantity: 3 },
      { inventory_id: screen.id, quantity: 1 }
    ],
    discount: 101.66,
    amount_paid: 5000.00
  });

  // Verify wholesale technician pricing was applied automatically
  assert.strictEqual(sale.customer_type, 'technician');
  assert.strictEqual(sale.items.length, 2);

  const saleBattery = sale.items.find(i => i.inventory_id === battery.id);
  assert.strictEqual(saleBattery.unit_price, 750.33);
  assert.strictEqual(saleBattery.total_price, 2250.99);

  const saleScreen = sale.items.find(i => i.inventory_id === screen.id);
  assert.strictEqual(saleScreen.unit_price, 1850.67);
  assert.strictEqual(saleScreen.total_price, 1850.67);

  // Verify math & zero float inaccuracies
  assert.strictEqual(sale.subtotal, 4101.66);
  assert.strictEqual(sale.discount, 101.66);
  assert.strictEqual(sale.total_amount, 4000.00);
  assert.strictEqual(sale.amount_paid, 5000.00);
  assert.strictEqual(sale.change_amount, 1000.00);
  assert.strictEqual(sale.credit_balance, 0.00);

  // Verify stock deduction
  const updatedBattery = getInventoryItem(db, battery.id);
  assert.strictEqual(updatedBattery.stock_quantity, 12); // 15 - 3

  const updatedScreen = getInventoryItem(db, screen.id);
  assert.strictEqual(updatedScreen.stock_quantity, 7); // 8 - 1

  // Verify stock movements recorded in ledger
  const movements = db.prepare("SELECT inventory_id, delta, reason, ref FROM stock_movements WHERE ref = ?").all(sale.sale_code);
  assert.strictEqual(movements.length, 2);
  assert.deepStrictEqual(
    movements.map(m => ({ inventory_id: m.inventory_id, delta: m.delta, reason: m.reason })),
    [
      { inventory_id: battery.id, delta: -3, reason: 'sale' },
      { inventory_id: screen.id, delta: -1, reason: 'sale' }
    ]
  );
});

dbTest('Idempotent checkout: duplicate op_id returns original sale without creating a second', (db) => {
  const part = createInventoryItem(db, {
    brand: 'Xiaomi',
    model_name: 'Redmi Note 12',
    part_type: 'Battery',
    cost_price: 10.0,
    price_retail: 25.0,
    price_technician: 20.0,
    stock_quantity: 5
  });

  const payload = {
    payment_method: 'cash',
    items: [{ inventory_id: part.id, quantity: 1, unit_price: 25.0 }],
    amount_paid: 25.0,
    op_id: 'op-abc-123'
  };

  const first = createSale(db, payload);
  const retry = createSale(db, payload);

  assert.strictEqual(retry.id, first.id);
  assert.strictEqual(retry.sale_code, first.sale_code);
  const count = db.prepare('SELECT COUNT(*) AS c FROM sales').get().c;
  assert.strictEqual(count, 1);
  const stock = getInventoryItem(db, part.id).stock_quantity;
  assert.strictEqual(stock, 4);

  const noOp = createSale(db, { ...payload, op_id: null });
  assert.notStrictEqual(noOp.id, first.id);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS c FROM sales').get().c, 2);
});

dbTest('discount above subtotal is rejected; a full-subtotal discount is allowed', (db) => {
  const part = createInventoryItem(db, {
    brand: 'Cap', model_name: 'Test', part_type: 'LCD', price_retail: 100, stock_quantity: 5
  });
  assert.throws(() => createSale(db, {
    payment_method: 'cash',
    items: [{ inventory_id: part.id, quantity: 1, unit_price: 100 }],
    amount_paid: 100, discount: 5000
  }), /exceeds the sale subtotal/);
  const free = createSale(db, {
    payment_method: 'cash',
    items: [{ inventory_id: part.id, quantity: 1, unit_price: 100 }],
    amount_paid: 0, discount: 100
  });
  assert.strictEqual(free.total_amount, 0);
});

dbTest('persisted sale item_name matches partLabel: one shape, plain hyphen', (db) => {
  const { partLabel } = require('../src/inventory');
  const part = createInventoryItem(db, {
    brand: 'Samsung', model_name: 'Galaxy A12', part_type: 'LCD (Incell)', price_retail: 100, stock_quantity: 2
  });
  const sale = createSale(db, {
    payment_method: 'cash', items: [{ inventory_id: part.id, quantity: 1 }], amount_paid: 100
  });
  assert.strictEqual(sale.items[0].item_name, 'Samsung Galaxy A12 - LCD (Incell)');
  assert.strictEqual(partLabel(part), sale.items[0].item_name);
  assert.doesNotMatch(sale.items[0].item_name, /—/);
});
