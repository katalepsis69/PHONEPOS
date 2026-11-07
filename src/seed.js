const { initDb, DEFAULT_DB_PATH } = require('./db');
const { createInventoryItem } = require('./inventory');
const { audit, txn } = require('./audit');
const { enqueueDelete } = require('./sync');

const INITIAL_PARTS = [
  // Apple LCDs & Batteries
  { brand: 'Apple', model_name: 'iPhone 11', part_type: 'LCD (Incell)', cost_price: 650.0, price_retail: 1400.0, price_technician: 1100.0, stock_quantity: 6, min_stock_alert: 2 },
  { brand: 'Apple', model_name: 'iPhone 11', part_type: 'LCD (OLED / High Copy)', cost_price: 950.0, price_retail: 2200.0, price_technician: 1700.0, stock_quantity: 4, min_stock_alert: 2 },
  { brand: 'Apple', model_name: 'iPhone 11', part_type: 'Battery (High Capacity)', cost_price: 400.0, price_retail: 950.0, price_technician: 750.0, stock_quantity: 8, min_stock_alert: 3 },
  { brand: 'Apple', model_name: 'iPhone 12 / 12 Pro', part_type: 'LCD (OLED)', cost_price: 1600.0, price_retail: 3200.0, price_technician: 2600.0, stock_quantity: 5, min_stock_alert: 2 },
  { brand: 'Apple', model_name: 'iPhone 13', part_type: 'LCD (OLED)', cost_price: 1850.0, price_retail: 3800.0, price_technician: 3100.0, stock_quantity: 3, min_stock_alert: 2 },
  { brand: 'Apple', model_name: 'iPhone X / XS', part_type: 'LCD (OLED)', cost_price: 1100.0, price_retail: 2400.0, price_technician: 1900.0, stock_quantity: 4, min_stock_alert: 2 },

  // Samsung LCDs & Parts
  { brand: 'Samsung', model_name: 'Galaxy A12 / A125', part_type: 'LCD (Incell)', cost_price: 450.0, price_retail: 1100.0, price_technician: 850.0, stock_quantity: 8, min_stock_alert: 3 },
  { brand: 'Samsung', model_name: 'Galaxy A32 4G', part_type: 'LCD (OLED)', cost_price: 1200.0, price_retail: 2500.0, price_technician: 2000.0, stock_quantity: 3, min_stock_alert: 2 },
  { brand: 'Samsung', model_name: 'Galaxy A52 / A52s', part_type: 'LCD (OLED with Frame)', cost_price: 1550.0, price_retail: 3100.0, price_technician: 2500.0, stock_quantity: 4, min_stock_alert: 2 },
  { brand: 'Samsung', model_name: 'Galaxy A03 / A03s', part_type: 'LCD (Incell)', cost_price: 420.0, price_retail: 1050.0, price_technician: 800.0, stock_quantity: 6, min_stock_alert: 2 },

  // Xiaomi & Redmi LCDs
  { brand: 'Xiaomi', model_name: 'Redmi Note 10 4G', part_type: 'LCD (OLED)', cost_price: 1150.0, price_retail: 2400.0, price_technician: 1950.0, stock_quantity: 5, min_stock_alert: 2 },
  { brand: 'Xiaomi', model_name: 'Redmi Note 11', part_type: 'LCD (OLED)', cost_price: 1250.0, price_retail: 2600.0, price_technician: 2100.0, stock_quantity: 4, min_stock_alert: 2 },
  { brand: 'Xiaomi', model_name: 'Poco X3 / X3 Pro', part_type: 'LCD (Original Spec 120Hz)', cost_price: 850.0, price_retail: 1850.0, price_technician: 1450.0, stock_quantity: 5, min_stock_alert: 2 },

  // Infinix & Tecno LCDs
  { brand: 'Infinix', model_name: 'Hot 10 Play', part_type: 'LCD (Incell)', cost_price: 420.0, price_retail: 1000.0, price_technician: 780.0, stock_quantity: 7, min_stock_alert: 2 },
  { brand: 'Infinix', model_name: 'Note 12 G96', part_type: 'LCD (AMOLED)', cost_price: 1300.0, price_retail: 2700.0, price_technician: 2200.0, stock_quantity: 3, min_stock_alert: 1 },

  // Oppo & Realme LCDs
  { brand: 'Oppo', model_name: 'A5s / A7 / A12', part_type: 'LCD (Incell)', cost_price: 380.0, price_retail: 950.0, price_technician: 700.0, stock_quantity: 10, min_stock_alert: 3 },
  { brand: 'Realme', model_name: 'Realme 5 / 5i / C3', part_type: 'LCD (Incell)', cost_price: 380.0, price_retail: 950.0, price_technician: 700.0, stock_quantity: 9, min_stock_alert: 3 }
];

function seedInitialParts(db, opts = {}) {
  const { zeroStock = false, skipSales = false } = opts;
  const existing = db.prepare('SELECT COUNT(*) as count FROM inventory').get();
  let createdParts = [];
  if (!existing || existing.count === 0) {
    console.log(`Seeding ${INITIAL_PARTS.length} standard phone LCDs and parts...`);
    // One savepoint around the whole catalog: a crash mid-seed used to leave a
    // half-populated demo shop (txn() is a SAVEPOINT, so the per-part
    // transactions below nest inside it cleanly).
    txn(db, () => {
      for (const part of INITIAL_PARTS) {
        const partData = zeroStock ? { ...part, stock_quantity: 0 } : part;
        createdParts.push(createInventoryItem(db, partData));
      }
    });
    console.log('Seeding inventory complete!');
  } else {
    createdParts = db.prepare('SELECT * FROM inventory').all();
  }

  // Seed sample sales only if sales table is empty and skipSales is false
  if (!skipSales) {
    const salesCount = db.prepare('SELECT COUNT(*) as count FROM sales').get();
    if (!salesCount || salesCount.count === 0) {
      if (createdParts.length >= 3) {
        const { createSale } = require('./sales');
        // 1. GCash Sale
        createSale(db, {
          customer_name: 'Alice Repair Tech',
          customer_phone: '0917-888-1234',
          customer_type: 'technician',
          payment_method: 'gcash',
          payment_reference: '1002 9841 2291',
          items: [{ inventory_id: createdParts[0].id, quantity: 1, unit_price: createdParts[0].price_technician }],
          discount: 0.0,
          amount_paid: createdParts[0].price_technician
        });

        // 2. Active Utang / Credit Sale
        createSale(db, {
          customer_name: 'Mark Freelance Tech',
          customer_phone: '0918-999-5678',
          customer_type: 'technician',
          payment_method: 'credit',
          items: [{ inventory_id: createdParts[1].id, quantity: 2, unit_price: createdParts[1].price_technician }],
          discount: 100.0,
          amount_paid: 1000.0 // Leaves remaining balance as active credit
        });

        // 3. Cash Sale
        createSale(db, {
          customer_name: 'Walk-in Customer',
          customer_type: 'retail',
          payment_method: 'cash',
          items: [{ inventory_id: createdParts[2].id, quantity: 1, unit_price: createdParts[2].price_retail }],
          discount: 50.0,
          amount_paid: createdParts[2].price_retail
        });
        console.log('Seeded sample POS transactions and customer credit ledger!');
      }
    }
  }

  return createdParts.length;
}

function resetDemoData(db, ctx = {}) {
  txn(db, () => {
    // Deletions must reach the cloud as tombstones, or the mirror keeps the
    // demo rows forever and still pushes their queued snapshots. stock_movements
    // goes first: its rows die by CASCADE with inventory and get no hook of
    // their own.
    for (const table of ['cash_adjustments', 'day_reconciliations', 'shifts', 'stock_movements', 'warranty_returns', 'credit_payments', 'sale_items', 'sales', 'inventory']) {
      for (const { id } of db.prepare(`SELECT id FROM ${table}`).all()) enqueueDelete(db, table, id);
    }
    for (const { id } of db.prepare('SELECT rowid AS id FROM customer_profiles').all()) enqueueDelete(db, 'customer_profiles', id);
    db.exec('DELETE FROM cash_adjustments;');
    db.exec('DELETE FROM day_reconciliations;');
    db.exec('DELETE FROM shifts;');
    db.exec('DELETE FROM customer_profiles;');
    db.exec('DELETE FROM op_log;');
    db.exec('DELETE FROM stock_movements;');
    db.exec('DELETE FROM warranty_returns;');
    db.exec('DELETE FROM credit_payments;');
    db.exec('DELETE FROM sale_items;');
    db.exec('DELETE FROM sales;');
    db.exec('DELETE FROM inventory;');
    audit(db, ctx.actor, ctx.elevated, 'system', 'reset_demo', {});
  });
  return seedInitialParts(db);
}

if (require.main === module) {
  const db = initDb(DEFAULT_DB_PATH);
  seedInitialParts(db);
  db.close();
}

module.exports = { seedInitialParts, resetDemoData };
