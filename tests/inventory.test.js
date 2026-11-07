// phone-repair-pos/tests/inventory.test.js
const assert = require('node:assert');
const { dbTest } = require('./helper');
const {
  createInventoryItem,
  listInventory,
  getInventoryItem,
  getInventoryByBarcode,
  updateInventoryItem,
  adjustStock,
  recordStockMovement,
  listStockMovements,
  archiveInventoryItem,
  importInventory,
  deleteInventoryItem,
  bulkEditInventory
} = require('../src/inventory');
const { createSale } = require('../src/sales');
const { createWarrantyReturn } = require('../src/returns');

dbTest('Inventory CRUD and stock adjustment', (db) => {
  // 1. Create item
  const item = createInventoryItem(db, {
    brand: 'Apple',
    model_name: 'iPhone 11',
    part_type: 'LCD (Incell)',
    cost_price: 15.0,
    price_retail: 35.0,
    price_technician: 25.0,
    stock_quantity: 5,
    min_stock_alert: 2
  });
  assert.ok(item.id > 0);
  assert.strictEqual(item.model_name, 'iPhone 11');

  // 2. List items & search filter
  const items = listInventory(db, { search: 'iPhone' });
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].brand, 'Apple');

  // 3. Stock adjust
  const updated = adjustStock(db, item.id, 3);
  assert.strictEqual(updated.stock_quantity, 8);

  // 4. Update item
  const edited = updateInventoryItem(db, item.id, { price_retail: 38.0 });
  assert.strictEqual(edited.price_retail, 38.0);

  // 5. Delete item
  const deleted = deleteInventoryItem(db, item.id);
  assert.strictEqual(deleted, true);
  assert.strictEqual(getInventoryItem(db, item.id), null);
});

dbTest('getInventoryByBarcode retrieves part by exact barcode or SKU', (db) => {
  const created = createInventoryItem(db, {
    brand: 'Apple',
    model_name: 'iPhone 13',
    part_type: 'OLED Screen',
    sku_barcode: 'IP13-OLED-001',
    cost_price: 1500,
    price_retail: 3200,
    price_technician: 2800,
    stock_quantity: 5,
    min_stock_alert: 2
  });

  const found = getInventoryByBarcode(db, 'IP13-OLED-001');
  assert.ok(found, 'Should find item by exact barcode');
  assert.strictEqual(found.id, created.id);
  assert.strictEqual(found.model_name, 'iPhone 13');

  const foundLower = getInventoryByBarcode(db, 'ip13-oled-001');
  assert.ok(foundLower, 'Should find item case-insensitively');
  assert.strictEqual(foundLower.id, created.id);

  const notFound = getInventoryByBarcode(db, 'NON-EXISTENT-BARCODE');
  assert.strictEqual(notFound, null, 'Should return null for unknown barcode');
});

dbTest('Inventory validates input boundaries and prevents negative stock', (db) => {
  // Empty brand rejected
  assert.throws(() => {
    createInventoryItem(db, {
      brand: '',
      model_name: 'iPhone 11',
      part_type: 'Battery',
      price_retail: 25.0
    });
  }, /Brand is required/);

  // Negative price rejected
  assert.throws(() => {
    createInventoryItem(db, {
      brand: 'Apple',
      model_name: 'iPhone 11',
      part_type: 'Battery',
      price_retail: -10.0
    });
  }, /Retail price cannot be negative/);

  // Negative cost rejected
  assert.throws(() => {
    createInventoryItem(db, {
      brand: 'Apple',
      model_name: 'iPhone 11',
      part_type: 'Battery',
      cost_price: -5.0
    });
  }, /Cost price cannot be negative/);

  // Valid item
  const item = createInventoryItem(db, {
    brand: 'Samsung',
    model_name: 'Galaxy A50',
    part_type: 'Battery',
    cost_price: 10.0,
    price_retail: 25.0,
    stock_quantity: 2
  });

  // adjustStock floor guard prevents negative stock
  assert.throws(() => {
    adjustStock(db, item.id, -5);
  }, /Insufficient stock: cannot reduce stock below 0/);

  // Valid adjustStock still succeeds
  const adjusted = adjustStock(db, item.id, -2);
  assert.strictEqual(adjusted.stock_quantity, 0);
});

dbTest('Inventory create/update round-trip sku, supplier, location; duplicate SKU rejected', (db) => {
  const item = createInventoryItem(db, {
    brand: 'Apple',
    model_name: 'iPhone 14',
    part_type: 'Battery',
    sku_barcode: 'AP-BAT-14',
    supplier: 'Greenleaf',
    location: 'Drawer B2',
    cost_price: 8,
    price_retail: 20,
    stock_quantity: 4
  });
  assert.strictEqual(item.sku_barcode, 'AP-BAT-14');
  assert.strictEqual(item.supplier, 'Greenleaf');
  assert.strictEqual(item.location, 'Drawer B2');

  // A part born with stock gets its opening_balance ledger row.
  assert.deepStrictEqual(
    listStockMovements(db, item.id).map(m => [m.delta, m.reason]),
    [[4, 'opening_balance']]);

  // SKU collision on a second item: SQLite UNIQUE fires through the API.
  assert.throws(() => {
    createInventoryItem(db, {
      brand: 'Samsung',
      model_name: 'S23',
      part_type: 'Battery',
      sku_barcode: 'AP-BAT-14',
      cost_price: 8,
      price_retail: 20
    });
  }, /UNIQUE constraint failed: inventory\.sku_barcode/);

  assert.throws(() => {
    createInventoryItem(db, {
      brand: 'Google', model_name: 'Pixel', part_type: 'Battery',
      sku_barcode: 'ap-bat-14', price_retail: 20
    });
  }, /UNIQUE constraint failed/);

  const edited = updateInventoryItem(db, item.id, { supplier: 'TechParts PH', location: '' });
  assert.strictEqual(edited.supplier, 'TechParts PH');
  assert.strictEqual(edited.location, '');

  // Updating stock through edit writes a correction movement for the diff.
  updateInventoryItem(db, item.id, { stock_quantity: 6 });
  const moves = listStockMovements(db, item.id);
  assert.strictEqual(moves.length, 2); // newest first
  assert.strictEqual(moves[0].delta, 2);
  assert.strictEqual(moves[0].reason, 'correction');
});

dbTest('adjustStock records movements with reason, note and ref', (db) => {
  const item = createInventoryItem(db, { brand: 'Xiaomi', model_name: 'Redmi 12', part_type: 'Battery', stock_quantity: 5 });
  adjustStock(db, item.id, 4, { reason: 'receive', note: 'delivery', ref: 'PO-1' });
  adjustStock(db, item.id, -2); // defaults to correction

  const moves = listStockMovements(db, item.id); // newest first
  assert.strictEqual(moves.length, 3);
  assert.deepStrictEqual([moves[0].delta, moves[0].reason], [-2, 'correction']);
  assert.deepStrictEqual([moves[1].delta, moves[1].reason, moves[1].note, moves[1].ref], [4, 'receive', 'delivery', 'PO-1']);
  assert.deepStrictEqual([moves[2].delta, moves[2].reason], [5, 'opening_balance']);

  // recordStockMovement is the exported primitive; unknown reason falls back
  // to correction rather than writing blank reasons.
  recordStockMovement(db, { inventory_id: item.id, delta: 0, reason: '' });
  assert.deepStrictEqual(
    [listStockMovements(db, item.id)[0].delta, listStockMovements(db, item.id)[0].reason],
    [0, 'correction']);
});

dbTest('Archived items are hidden from the default list, visible with the flag', (db) => {
  const a = createInventoryItem(db, { brand: 'Apple', model_name: 'iPhone 11', part_type: 'LCD', stock_quantity: 3 });
  const b = createInventoryItem(db, { brand: 'Samsung', model_name: 'A32', part_type: 'LCD', stock_quantity: 3 });

  assert.strictEqual(listInventory(db).length, 2);
  const archived = archiveInventoryItem(db, b.id, 1);
  assert.strictEqual(archived.archived, 1);

  assert.strictEqual(listInventory(db).length, 1);
  assert.strictEqual(listInventory(db)[0].id, a.id);
  assert.strictEqual(listInventory(db, { include_archived: true }).length, 2);

  const restored = archiveInventoryItem(db, b.id, 0);
  assert.strictEqual(restored.archived, 0);
  assert.strictEqual(listInventory(db).length, 2);
  assert.strictEqual(archiveInventoryItem(db, 9999, 1), null);
});

dbTest('Ledger invariant holds across interleaved sale, adjust and RMA', (db) => {
  const item = createInventoryItem(db, {
    brand: 'Apple', model_name: 'iPhone 14', part_type: 'LCD',
    cost_price: 10, price_retail: 30, stock_quantity: 10
  });
  const sale = createSale(db, {
    items: [{ inventory_id: item.id, quantity: 2, unit_price: 30 }],
    amount_paid: 60
  });
  adjustStock(db, item.id, 5, { reason: 'receive', note: 'restock' });
  createWarrantyReturn(db, {
    sale_id: sale.id,
    sale_item_id: sale.items[0].id,
    return_type: 'replacement'
  });

  const final = getInventoryItem(db, item.id);
  const sum = db.prepare('SELECT COALESCE(SUM(delta), 0) AS s FROM stock_movements WHERE inventory_id = ?').get(item.id).s;
  assert.strictEqual(final.stock_quantity, 12);   // 10 - 2 + 5 - 1
  assert.strictEqual(sum, 12);
  assert.deepStrictEqual(
    db.prepare('SELECT reason FROM stock_movements WHERE inventory_id = ? ORDER BY id').all(item.id).map(r => r.reason),
    ['opening_balance', 'sale', 'receive', 'rma_replacement']);
});

dbTest('CSV import creates new parts, tops up stock, writes movements, stays atomic', (db) => {
  createInventoryItem(db, {
    brand: 'Apple', model_name: 'iPhone 11', part_type: 'LCD (Incell)',
    cost_price: 100, price_retail: 200, stock_quantity: 5, sku_barcode: 'AP-LCD-11'
  });

  const result = importInventory(db, [
    { brand: 'Apple', model_name: 'iPhone 11', part_type: 'LCD (incell)', stock_quantity: '3', price_retail: '250', supplier: 'Greenleaf' }, // ci identity match
    { brand: 'Samsung', model_name: 'A32', part_type: 'LCD (OLED)', cost_price: '120', price_retail: '260', stock_quantity: '4' },           // create
    { sku_barcode: 'AP-LCD-11', stock_quantity: '2' }                                                                                        // sku match
  ]);
  assert.deepStrictEqual(result, { created: 1, updated: 2, errors: [] });

  const topped = db.prepare(`SELECT * FROM inventory WHERE brand = 'Apple' AND model_name = 'iPhone 11'`).get();
  assert.strictEqual(topped.stock_quantity, 5 + 3 + 2);
  assert.strictEqual(topped.price_retail, 250);
  assert.strictEqual(topped.supplier, 'Greenleaf');

  const created = db.prepare(`SELECT * FROM inventory WHERE model_name = 'A32'`).get();
  assert.strictEqual(created.stock_quantity, 4);
  // Create landed as one receive row (not opening_balance) per import semantics.
  assert.deepStrictEqual(listStockMovements(db, created.id).map(m => [m.delta, m.reason, m.note]), [[4, 'receive', 'CSV import']]);

  // The invariant survives the import.
  for (const inv of db.prepare('SELECT id, stock_quantity FROM inventory').all()) {
    const sum = db.prepare('SELECT COALESCE(SUM(delta), 0) AS s FROM stock_movements WHERE inventory_id = ?').get(inv.id).s;
    assert.strictEqual(sum, inv.stock_quantity, `ledger drift on item ${inv.id}`);
  }

  // A bad row rejects the whole import: row-numbered error, no partial writes.
  const before = db.prepare('SELECT COUNT(*) AS n FROM inventory').get().n;
  assert.throws(() => importInventory(db, [
    { brand: 'Vivo', model_name: 'Y21', part_type: 'LCD', stock_quantity: '1' },
    { brand: '', model_name: 'X', part_type: 'LCD', stock_quantity: '1' },
    { brand: 'Oppo', model_name: 'A5s', part_type: 'LCD', stock_quantity: 'not-a-number' }
  ]), /Row 2: Brand is required \| Row 3: stock_quantity must be an integer/);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM inventory').get().n, before);
});

dbTest('text bounds: catalog columns cap, movement notes keep what the manager typed', (db) => {
  const long = 'x'.repeat(400);
  const item = createInventoryItem(db, { brand: long, model_name: 'M', part_type: 'LCD', cost_price: 1, price_retail: 2, stock_quantity: 1, supplier: long, location: long });
  assert.equal(item.brand.length, 200, 'catalog text is bounded');
  assert.equal(item.supplier.length, 200);
  adjustStock(db, item.id, 1, { reason: 'receive', note: `delivery note ${long}` }, { actor: { type: 'manager', name: 'Boss' }, elevated: true });
  const mv = db.prepare('SELECT note FROM stock_movements ORDER BY id DESC LIMIT 1').get();
  assert.ok(mv.note.length > 400, 'a free-text movement note is not silently clipped');
});

dbTest('op_id replay: adjust-stock and import answer once', (db) => {
  const { adjustStock, importInventory } = require('../src/inventory');
  const item = createInventoryItem(db, { brand: 'Re', model_name: 'Play', part_type: 'LCD', cost_price: 1, price_retail: 5, stock_quantity: 10 });

  const movementsBefore = db.prepare('SELECT COUNT(*) AS c FROM stock_movements WHERE inventory_id = ?').get(item.id).c;
  const first = adjustStock(db, item.id, -2, { reason: 'damage', op_id: 'op-adj-1' }, {});
  const replay = adjustStock(db, item.id, -2, { reason: 'damage', op_id: 'op-adj-1' }, {});
  assert.strictEqual(first.stock_quantity, 8);
  assert.strictEqual(replay.stock_quantity, 8, 'the replay returns the same state');
  const movements = db.prepare('SELECT COUNT(*) AS c FROM stock_movements WHERE inventory_id = ?').get(item.id).c;
  assert.strictEqual(movements, movementsBefore + 1, 'the replay did not write a second movement');

  const summary = importInventory(db, [{ brand: 'Imp', model_name: 'Ort', part_type: 'Battery', stock_quantity: 4 }], {}, { op_id: 'op-imp-1' });
  assert.strictEqual(summary.created, 1);
  const replayImport = importInventory(db, [{ brand: 'Imp', model_name: 'Ort', part_type: 'Battery', stock_quantity: 4 }], {}, { op_id: 'op-imp-1' });
  assert.strictEqual(replayImport.replayed, true);
  const imp = db.prepare("SELECT stock_quantity FROM inventory WHERE model_name = 'Ort'").get();
  assert.strictEqual(imp.stock_quantity, 4, 'the replay did not receive the quantity twice');
});

dbTest('importInventory: auto-pricing calculates retail and wholesale markup and preserves restock prices', (db) => {
  // Existing part with initial prices: Retail 1500, Wholesale 1200, Cost 1000
  createInventoryItem(db, {
    brand: 'Apple',
    model_name: 'iPhone 12',
    part_type: 'OLED',
    sku_barcode: 'IP12-OLED',
    cost_price: 1000,
    price_retail: 1500,
    price_technician: 1200,
    stock_quantity: 5
  });

  // 1. Restock with empty prices and auto_price: true -> preserves existing retail and wholesale
  importInventory(db, [
    { sku_barcode: 'IP12-OLED', stock_quantity: '3' }
  ], {}, { auto_price: true, retail_markup: 50, wholesale_markup: 20 });

  const restocked = getInventoryByBarcode(db, 'IP12-OLED');
  assert.strictEqual(restocked.stock_quantity, 8);
  assert.strictEqual(restocked.price_retail, 1500, 'Preserves existing retail price when blank in restock');
  assert.strictEqual(restocked.price_technician, 1200, 'Preserves existing wholesale price when blank in restock');

  // 2. New part with cost 800 and empty prices + auto_price: true -> calculates retail (800 + 50% = 1200) and wholesale (800 + 20% = 960)
  importInventory(db, [
    { brand: 'Samsung', model_name: 'A52', part_type: 'Screen', cost_price: '800', stock_quantity: '2' }
  ], {}, { auto_price: true, retail_markup: 50, wholesale_markup: 20 });

  const autoNew = db.prepare("SELECT * FROM inventory WHERE model_name = 'A52'").get();
  assert.strictEqual(autoNew.cost_price, 800);
  assert.strictEqual(autoNew.price_retail, 1200, 'Calculates retail = cost + 50%');
  assert.strictEqual(autoNew.price_technician, 960, 'Calculates wholesale = cost + 20%');

  // 3. Explicit price in import overrides auto_price calculation
  importInventory(db, [
    { brand: 'Xiaomi', model_name: 'Note 11', part_type: 'Battery', cost_price: '400', price_retail: '750', price_technician: '550', stock_quantity: '5' }
  ], {}, { auto_price: true, retail_markup: 50, wholesale_markup: 20 });

  const explicit = db.prepare("SELECT * FROM inventory WHERE model_name = 'Note 11'").get();
  assert.strictEqual(explicit.price_retail, 750, 'Explicit retail price overrides auto-markup');
  assert.strictEqual(explicit.price_technician, 550, 'Explicit wholesale price overrides auto-markup');

  // 4. Restock with identical cost and blank prices preserves custom prices
  createInventoryItem(db, {
    brand: 'Google',
    model_name: 'Pixel 7',
    part_type: 'Screen',
    sku_barcode: 'P7-SCR',
    cost_price: 2000,
    price_retail: 3800, // Custom 90% markup
    price_technician: 2900,
    stock_quantity: 2
  });

  importInventory(db, [
    { sku_barcode: 'P7-SCR', stock_quantity: '3', cost_price: '2000' }
  ], {}, { auto_price: true, retail_markup: 50, wholesale_markup: 20 });

  const pixelSame = getInventoryByBarcode(db, 'P7-SCR');
  assert.strictEqual(pixelSame.stock_quantity, 5);
  assert.strictEqual(pixelSame.price_retail, 3800, 'Custom retail price preserved when cost did not change');
  assert.strictEqual(pixelSame.price_technician, 2900, 'Custom wholesale price preserved when cost did not change');

  // 5. Restock with changed cost and blank prices recalculates with markup
  importInventory(db, [
    { sku_barcode: 'P7-SCR', stock_quantity: '2', cost_price: '2200' }
  ], {}, { auto_price: true, retail_markup: 50, wholesale_markup: 20 });

  const pixelChanged = getInventoryByBarcode(db, 'P7-SCR');
  assert.strictEqual(pixelChanged.stock_quantity, 7);
  assert.strictEqual(pixelChanged.cost_price, 2200);
  assert.strictEqual(pixelChanged.price_retail, 3300, 'Retail recalculated when cost changed (2200 + 50%)');
  assert.strictEqual(pixelChanged.price_technician, 2640, 'Wholesale recalculated when cost changed (2200 + 20%)');
});

dbTest('bulkEditInventory: adjust prices, recalculate markups, update fields, and archive', (db) => {
  const item1 = createInventoryItem(db, {
    brand: 'Apple', model_name: 'iPhone 13', part_type: 'LCD', cost_price: 1000,
    price_retail: 1500, price_technician: 1200, stock_quantity: 4
  });
  const item2 = createInventoryItem(db, {
    brand: 'Apple', model_name: 'iPhone 14', part_type: 'LCD', cost_price: 2000,
    price_retail: 3000, price_technician: 2400, stock_quantity: 6
  });

  const ctx = { actor: { type: 'manager', name: 'Admin' }, elevated: true };

  // 1. adjust_price with fixed amount on both
  const res1 = bulkEditInventory(db, {
    ids: [item1.id, item2.id],
    action: 'adjust_price',
    params: { target: 'both', mode: 'amount', value: 100 }
  }, ctx);
  assert.strictEqual(res1.updated, 2);
  let p1 = getInventoryItem(db, item1.id);
  let p2 = getInventoryItem(db, item2.id);
  assert.strictEqual(p1.price_retail, 1600);
  assert.strictEqual(p1.price_technician, 1300);
  assert.strictEqual(p2.price_retail, 3100);
  assert.strictEqual(p2.price_technician, 2500);

  // 2. adjust_price with percentage on retail only (-10%)
  const res2 = bulkEditInventory(db, {
    ids: [item1.id],
    action: 'adjust_price',
    params: { target: 'retail', mode: 'pct', value: -10 }
  }, ctx);
  assert.strictEqual(res2.updated, 1);
  p1 = getInventoryItem(db, item1.id);
  assert.strictEqual(p1.price_retail, 1440);
  assert.strictEqual(p1.price_technician, 1300);

  // 3. recalculate_markup from cost (50% retail, 20% wholesale)
  const res3 = bulkEditInventory(db, {
    ids: [item1.id, item2.id],
    action: 'recalculate_markup',
    params: { retail_markup: 50, wholesale_markup: 20 }
  }, ctx);
  assert.strictEqual(res3.updated, 2);
  p1 = getInventoryItem(db, item1.id);
  p2 = getInventoryItem(db, item2.id);
  assert.strictEqual(p1.price_retail, 1500);
  assert.strictEqual(p1.price_technician, 1200);
  assert.strictEqual(p2.price_retail, 3000);
  assert.strictEqual(p2.price_technician, 2400);

  // 4. update_fields (supplier, location, min_stock_alert)
  const res4 = bulkEditInventory(db, {
    ids: [item1.id, item2.id],
    action: 'update_fields',
    params: { supplier: 'Top Supplier', location: 'Shelf B-2', min_stock_alert: 5 }
  }, ctx);
  assert.strictEqual(res4.updated, 2);
  p1 = getInventoryItem(db, item1.id);
  assert.strictEqual(p1.supplier, 'Top Supplier');
  assert.strictEqual(p1.location, 'Shelf B-2');
  assert.strictEqual(p1.min_stock_alert, 5);

  // 5. archive and unarchive
  const res5 = bulkEditInventory(db, {
    ids: [item1.id, item2.id],
    action: 'archive'
  }, ctx);
  assert.strictEqual(res5.updated, 2);
  p1 = getInventoryItem(db, item1.id);
  assert.strictEqual(p1.archived, 1);

  const res6 = bulkEditInventory(db, {
    ids: [item1.id, item2.id],
    action: 'unarchive'
  }, ctx);
  assert.strictEqual(res6.updated, 2);
  p1 = getInventoryItem(db, item1.id);
  assert.strictEqual(p1.archived, 0);

  // 6. validation checks
  assert.throws(() => bulkEditInventory(db, { ids: [], action: 'archive' }), /No items selected/);
  assert.throws(() => bulkEditInventory(db, { ids: [item1.id], action: 'unknown_action' }), /Unknown bulk edit action/);
  assert.throws(() => bulkEditInventory(db, { ids: [item1.id], action: 'adjust_price', params: { target: 'invalid' } }), /Invalid price target/);
  assert.throws(() => bulkEditInventory(db, { ids: [item1.id], action: 'adjust_price', params: { target: 'retail', mode: 'invalid' } }), /Invalid adjustment mode/);
  assert.throws(() => bulkEditInventory(db, { ids: [item1.id], action: 'adjust_price', params: { target: 'retail', mode: 'amount', value: '' } }), /Valid adjustment value is required/);
  assert.throws(() => bulkEditInventory(db, { ids: [item1.id], action: 'update_fields', params: { min_stock_alert: -3 } }), /Min stock alert must be a non-negative integer/);
});


dbTest('importInventory: accepts friendly spreadsheet headers (Capital, Wholesale Price, Retail Price)', (db) => {
  const { importInventory } = require('../src/inventory');
  const res = importInventory(db, [
    {
      'Brand': 'Tecno',
      'Model Name': 'Spark 10',
      'Part Type': 'Battery',
      'SKU / Barcode': 'TEC-SP10',
      'Capital': '350',
      'Retail Price': '650',
      'Wholesale Price': '500',
      'Stock Qty': '12',
      'Min Stock Alert': '3',
      'Supplier': 'Direct Distro',
      'Location': 'Bin 4'
    }
  ]);
  assert.strictEqual(res.created, 1);
  const item = db.prepare("SELECT * FROM inventory WHERE sku_barcode = 'TEC-SP10'").get();
  assert.strictEqual(item.brand, 'Tecno');
  assert.strictEqual(item.model_name, 'Spark 10');
  assert.strictEqual(item.cost_price, 350);
  assert.strictEqual(item.price_retail, 650);
  assert.strictEqual(item.price_technician, 500);
  assert.strictEqual(item.stock_quantity, 12);
  assert.strictEqual(item.location, 'Bin 4');
});

dbTest('edit-modal stock set refuses a stale form and dedups a retry', (db) => {
  const item = createInventoryItem(db, {
    brand: 'Stale', model_name: 'Guard', part_type: 'LCD',
    cost_price: 10, price_retail: 20, price_technician: 15, stock_quantity: 5, min_stock_alert: 2,
  });

  // The form was filled when the shelf held 5; a sale took one unit since.
  createSale(db, {
    customer_name: 'Race', payment_method: 'cash',
    items: [{ inventory_id: item.id, item_type: 'part', quantity: 1, unit_price: 20 }],
    amount_paid: 20,
  });
  assert.strictEqual(getInventoryItem(db, item.id).stock_quantity, 4, 'the sale landed');

  assert.throws(
    () => updateInventoryItem(db, item.id, { stock_quantity: 5 }, { expected_stock: 5 }),
    /Stock changed since the form loaded/,
    'a stale form must not resurrect the sold unit'
  );
  assert.strictEqual(getInventoryItem(db, item.id).stock_quantity, 4, 'the shelf is untouched by the refusal');

  // A fresh form (expected matches the shelf) still saves, and a retried PUT
  // with the same op key is a no-op returning the same row.
  const saved = updateInventoryItem(db, item.id, { stock_quantity: 6 }, { expected_stock: 4, op_id: 'edit-op-1' });
  assert.strictEqual(saved.stock_quantity, 6);
  const replay = updateInventoryItem(db, item.id, { stock_quantity: 9 }, { expected_stock: 6, op_id: 'edit-op-1' });
  assert.strictEqual(replay.stock_quantity, 6, 'the replay returns the saved row, not a second edit');
  assert.strictEqual(getInventoryItem(db, item.id).stock_quantity, 6, 'the op log swallowed the duplicate');
});
