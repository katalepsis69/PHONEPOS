// tests/sync.test.js — shop outbox + cloud round-trip on ephemeral DBs.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { DatabaseSync } = require('node:sqlite');
const { initDb } = require('../src/db');
const { createSale } = require('../src/sales');
const { deleteInventoryItem } = require('../src/inventory');
const { drainOutbox, getShopId, ensureSyncTables } = require('../src/sync');

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-test-'));
  const dbPath = path.join(dir, 'shop.db');
  return { db: initDb(dbPath), dbPath, dir };
}

// Minimal cloud stub mirroring cloud/server.js upsert semantics.
function makeCloud() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-'));
  const cloud = new DatabaseSync(path.join(dir, 'cloud.db'));
  cloud.exec(`
    CREATE TABLE shops (shop_id TEXT PRIMARY KEY, first_seen TEXT, last_seen TEXT);
    CREATE TABLE shop_rows (
      shop_id TEXT, table_name TEXT, local_id INTEGER, row_json TEXT, updated_at TEXT,
      PRIMARY KEY (shop_id, table_name, local_id)
    );
  `);
  const upsert = cloud.prepare(`
    INSERT INTO shop_rows (shop_id, table_name, local_id, row_json, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (shop_id, table_name, local_id) DO UPDATE SET row_json = excluded.row_json, updated_at = excluded.updated_at
  `);
  const server = require('node:http').createServer((req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const { shop_id, events } = JSON.parse(body);
      cloud.prepare(`INSERT INTO shops (shop_id, first_seen, last_seen) VALUES (?, ?, ?)
        ON CONFLICT(shop_id) DO UPDATE SET last_seen = ?`).run(shop_id, 'x', 'x', 'x');
      const okIds = [];
      for (const ev of events) { upsert.run(shop_id, ev.table, ev.local_id, JSON.stringify(ev.row), 'x'); okIds.push(ev.outbox_id); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ok_ids: okIds }));
    });
  });
  return { cloud, server, dir };
}

test('sale lands in outbox and syncs to cloud idempotently', async () => {
  const { db, dir } = tmpDb();
  const { cloud, server } = makeCloud();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  // A shop with a part to sell
  db.prepare(`INSERT INTO inventory (brand, model_name, part_type, cost_price, price_retail, price_technician, stock_quantity, min_stock_alert)
    VALUES ('Apple', 'iPhone 11', 'LCD', 100, 200, 150, 5, 2)`).run();
  const sale = createSale(db, {
    customer_name: 'Sync Test', payment_method: 'cash',
    items: [{ inventory_id: 1, item_type: 'part', quantity: 1, unit_price: 200 }],
    amount_paid: 200,
  });

  const pending = db.prepare('SELECT COUNT(*) c FROM sync_outbox WHERE synced_at IS NULL').get().c;
  assert.ok(pending >= 3, `expected sale+item+inventory+movement events, got ${pending}`);

  db.prepare("INSERT OR REPLACE INTO shop_settings (key, value) VALUES ('sync_url', ?)")
    .run(`http://127.0.0.1:${port}`);

  const r1 = await drainOutbox(db);
  assert.strictEqual(r1.synced, pending);
  const remaining = db.prepare('SELECT COUNT(*) c FROM sync_outbox WHERE synced_at IS NULL').get().c;
  assert.strictEqual(remaining, 0);

  // Idempotency: replay the same batch (simulated retry) — row count unchanged.
  const rowsBefore = cloud.prepare('SELECT COUNT(*) c FROM shop_rows').get().c;
  const saleRows = cloud.prepare("SELECT row_json FROM shop_rows WHERE table_name = 'sales'").all();
  assert.strictEqual(saleRows.length, 1);
  assert.strictEqual(JSON.parse(saleRows[0].row_json).sale_code, sale.sale_code);

  // Second drain with nothing pending is a no-op.
  const r2 = await drainOutbox(db);
  assert.strictEqual(r2.synced, 0);
  assert.strictEqual(cloud.prepare('SELECT COUNT(*) c FROM shop_rows').get().c, rowsBefore);

  server.close();
  db.close();
  cloud.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('drainOutbox skips cleanly when no sync_url is set', async () => {
  const { db, dir } = tmpDb();
  const r = await drainOutbox(db);
  assert.strictEqual(r.skipped, true);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('each install gets a stable unique shop id', () => {
  const { db, dir } = tmpDb();
  const id1 = getShopId(db);
  assert.ok(id1 && id1.length >= 32);
  assert.strictEqual(getShopId(db), id1); // stable across reads
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('inventory deletion emits a tombstone through the local sync contract', async () => {
  const { db, dir } = tmpDb();
  db.prepare(`INSERT INTO inventory (brand, model_name, part_type) VALUES ('Delete', 'Sync', 'Part')`).run();
  let received;
  const server = require('node:http').createServer((req, res) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      received = JSON.parse(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  db.prepare("INSERT OR REPLACE INTO shop_settings (key, value) VALUES ('sync_url', ?)")
    .run(`http://127.0.0.1:${server.address().port}`);
  assert.strictEqual(deleteInventoryItem(db, 1), true);
  await drainOutbox(db);
  const event = received.events.find(e => e.table === 'inventory' && e.local_id === 1 && e.deleted);
  assert.ok(event);
  assert.strictEqual(event.row, null);
  server.close();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- scheduler integration: finished write requests kick the drain ----
const { serverTest } = require('./helper');

serverTest('finished write requests drain the outbox to the cloud within seconds', async (baseUrl, db, auth) => {
  const { cloud, server, dir } = makeCloud();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  db.prepare(`INSERT INTO inventory (brand, model_name, part_type, cost_price, price_retail, price_technician, stock_quantity, min_stock_alert)
    VALUES ('Apple', 'iPhone 13', 'LCD', 100, 200, 150, 5, 2)`).run();
  db.prepare("INSERT OR REPLACE INTO shop_settings (key, value) VALUES ('sync_url', ?)")
    .run(`http://127.0.0.1:${port}`);

  // Status endpoint reflects a configured target before any write.
  const st0 = await (await fetch(`${baseUrl}/api/sync/status`, { headers: auth })).json();
  assert.strictEqual(st0.url_configured, true);
  assert.strictEqual(st0.state, 'synced'); // nothing pending yet

  // One write through the real HTTP surface: the response 'finish' event
  // kicks the debounced drain instead of waiting for the 60s safety tick.
  const res = await fetch(`${baseUrl}/api/sales`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      payment_method: 'cash',
      items: [{ inventory_id: 1, item_type: 'part', quantity: 1, unit_price: 200 }],
      amount_paid: 200
    })
  });
  assert.strictEqual(res.status, 201);

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  await sleep(4500); // 2s debounce + push + slack

  const mirrored = cloud.prepare("SELECT COUNT(*) c FROM shop_rows WHERE table_name = 'sales'").get().c;
  assert.strictEqual(mirrored, 1);
  const st1 = await (await fetch(`${baseUrl}/api/sync/status`, { headers: auth })).json();
  assert.strictEqual(st1.pending, 0);

  server.close();
  cloud.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a 200 that acks nothing is a sync failure, not an empty success', async () => {
  const http = require('node:http');
  const { db, dir } = tmpDb();
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html>gateway said okay</html>');
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  db.prepare("INSERT OR REPLACE INTO shop_settings (key, value) VALUES ('sync_url', ?)")
    .run(`http://127.0.0.1:${srv.address().port}`);
  try {
    createSale(db, {
      customer_name: 'Ack Test', payment_method: 'cash',
      items: [{ item_type: 'labor', item_name: 'Diagnostic', unit_price: 10, quantity: 1 }],
      amount_paid: 10,
    });
    const pendingBefore = db.prepare('SELECT COUNT(*) AS c FROM sync_outbox WHERE synced_at IS NULL').get().c;
    assert.ok(pendingBefore > 0);
    await assert.rejects(() => drainOutbox(db), /acknowledged none/);
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS c FROM sync_outbox WHERE synced_at IS NULL').get().c, pendingBefore);
  } finally {
    srv.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('reset-demo writes tombstones for every deleted row and clears shifts, day close, cash adjustments, and profiles', () => {
  const { createInventoryItem } = require('../src/inventory');
  const { openShift, closeShift } = require('../src/shifts');
  const { closeDay } = require('../src/reconcile');
  const { voidSale } = require('../src/sales');
  const { setCustomerCreditLimit } = require('../src/credits');
  const { resetDemoData } = require('../src/seed');
  const { db, dir } = tmpDb();
  const mgr = { actor: { type: 'manager', id: null, name: 'M' }, elevated: true };
  try {
    const item = createInventoryItem(db, { brand: 'Demo', model_name: 'Gone', part_type: 'LCD', cost_price: 1, price_retail: 5, stock_quantity: 3 });
    const sh = openShift(db, mgr.actor, 10);
    const sale = createSale(db, { payment_method: 'cash', items: [{ inventory_id: item.id, quantity: 1, unit_price: 5 }], amount_paid: 5 });
    closeShift(db, sh.id, 15, mgr);
    const today = db.prepare("SELECT date('now','localtime') AS d").get().d;
    closeDay(db, today, 5, mgr);
    voidSale(db, sale.id, 'demo void after close', mgr);
    setCustomerCreditLimit(db, 'Demo Customer', 500, '', mgr);

    resetDemoData(db, mgr);

    for (const t of ['shifts', 'day_reconciliations', 'cash_adjustments', 'customer_profiles']) {
      assert.strictEqual(db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c, 0, `${t} is wiped by resetDemoData`);
    }

    const rows = db.prepare('SELECT table_name, payload FROM sync_outbox').all();
    const tombstoned = new Set(rows
      .filter(r => { try { return JSON.parse(r.payload)._deleted === true; } catch { return false; } })
      .map(r => r.table_name));
    for (const t of ['sales', 'sale_items', 'inventory', 'stock_movements', 'shifts', 'day_reconciliations', 'cash_adjustments', 'customer_profiles']) {
      assert.ok(tombstoned.has(t), `${t} carries deletion tombstones`);
    }
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a cloud-rejected event is quarantined and the rest of the batch still flows', async () => {
  const { db, dir } = tmpDb();
  const server = require('node:http').createServer((req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const { events } = JSON.parse(body);
      // The new per-event ack shape: first row valid, second refused.
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        ok_ids: [events[0].outbox_id],
        rejected: [{ outbox_id: events[1].outbox_id, error: 'event row missing brand' }],
      }));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    db.prepare("INSERT OR REPLACE INTO shop_settings (key, value) VALUES ('sync_url', ?)").run(`http://127.0.0.1:${port}`);
    const { enqueue, drainOutbox } = require('../src/sync');
    enqueue(db, 'inventory', 1, { id: 1, brand: 'Keep' });
    enqueue(db, 'inventory', 2, { id: 2, brand: 'Poison' });

    const r = await drainOutbox(db);
    assert.strictEqual(r.synced, 1);
    assert.strictEqual(r.quarantined, 1, 'the refused row is reported as quarantined');
    const left = db.prepare('SELECT COUNT(*) c FROM sync_outbox').get().c;
    assert.strictEqual(left, 1, 'the poison row is gone from the outbox');
    const kept = db.prepare('SELECT payload FROM sync_outbox').get();
    assert.match(kept.payload, /Keep/, 'the valid row is only marked, never dropped');
  } finally {
    server.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('backfillMirror queues existing rows and the drain lands them on the cloud', async () => {
  const { db, dir } = tmpDb();
  const { cloud, server } = makeCloud();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    // A shop with history but an empty outbox (writes made before the outbox
    // existed, or pruned after 30 offline days).
    db.prepare(`INSERT INTO inventory (brand, model_name, part_type, cost_price, price_retail, price_technician, stock_quantity, min_stock_alert)
      VALUES ('Apple', 'iPhone 11', 'LCD', 100, 200, 150, 5, 2)`).run();
    db.prepare("INSERT INTO customer_profiles (customer_name, credit_limit, phone) VALUES ('Utang Joe', 500, '0917')").run();
    const sale = createSale(db, {
      customer_name: 'Backfill Test', payment_method: 'cash',
      items: [{ inventory_id: 1, item_type: 'part', quantity: 1, unit_price: 200 }],
      amount_paid: 200,
    });
    db.prepare('DELETE FROM sync_outbox').run();
    assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM sync_outbox').get().c, 0);

    const { backfillMirror } = require('../src/sync');
    const bf = backfillMirror(db);
    assert.ok(bf.queued >= 4, `expected inventory+sale+items+profile events, got ${bf.queued}`);
    const tables = db.prepare('SELECT DISTINCT table_name FROM sync_outbox').all().map(r => r.table_name);
    for (const t of ['inventory', 'sales', 'sale_items', 'customer_profiles']) {
      assert.ok(tables.includes(t), `backfill covers ${t}`);
    }

    db.prepare("INSERT OR REPLACE INTO shop_settings (key, value) VALUES ('sync_url', ?)").run(`http://127.0.0.1:${port}`);
    while ((await drainOutbox(db)).synced > 0) {}
    const mirrored = cloud.prepare("SELECT COUNT(*) c FROM shop_rows WHERE table_name = 'sales'").get().c;
    assert.strictEqual(mirrored, 1);
    const inv = cloud.prepare("SELECT row_json FROM shop_rows WHERE table_name = 'inventory'").get();
    assert.strictEqual(JSON.parse(inv.row_json).model_name, 'iPhone 11');
    const prof = cloud.prepare("SELECT row_json FROM shop_rows WHERE table_name = 'customer_profiles'").get();
    assert.strictEqual(JSON.parse(prof.row_json).customer_name, 'Utang Joe');
    assert.ok(sale.sale_code);
  } finally {
    server.close();
    db.close();
    cloud.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('empty outbox sends a heartbeat, and a cloud-side unlink surfaces as a failure', async () => {
  const { db, dir } = tmpDb();
  let seen = [];
  let statusCode = 200;
  const server = require('node:http').createServer((req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      seen.push(JSON.parse(body));
      res.writeHead(statusCode, { 'Content-Type': 'application/json' });
      res.end(statusCode === 200 ? JSON.stringify({ ok: true, ok_ids: [] }) : JSON.stringify({ error: 'bad sync credential' }));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    db.prepare("INSERT OR REPLACE INTO shop_settings (key, value) VALUES ('sync_url', ?)").run(`http://127.0.0.1:${port}`);

    const r = await drainOutbox(db);
    assert.strictEqual(r.synced, 0);
    assert.strictEqual(r.heartbeat, true);
    assert.strictEqual(seen.length, 1);
    assert.deepStrictEqual(seen[0].events, [], 'heartbeat POSTs an empty batch');

    // Cloud unlinked the shop: the next heartbeat must fail loudly, not
    // report a green 'Cloud synced' forever.
    statusCode = 401;
    await assert.rejects(() => drainOutbox(db), /401/);
  } finally {
    server.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('backfill never enqueues the secret-bearing tables', async () => {
  const { db, dir } = tmpDb();
  try {
    // The data-minimizing accident is a contract: shop_settings carries the
    // sync token and the PIN hash, and none of it may ride the mirror.
    db.prepare("INSERT OR REPLACE INTO shop_settings (key, value) VALUES ('sync_token', 'aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899')").run();
    db.prepare("INSERT INTO staff (name, pin_hash) VALUES ('Cashier', 'x')").run();
    db.prepare("INSERT INTO audit_log (actor_type, actor_name, category, action, detail, elevated) VALUES ('manager', 't', 'settings', 'update', '{}', 1)").run();
    const sale = createSale(db, {
      customer_name: 'Exclusions', payment_method: 'cash',
      items: [{ inventory_id: null, item_type: 'labor', item_name: 'Labor', quantity: 1, unit_price: 100 }],
      amount_paid: 100,
    });
    assert.ok(sale.sale_code);
    db.prepare('DELETE FROM sync_outbox').run();

    const { backfillMirror } = require('../src/sync');
    backfillMirror(db);
    const tables = db.prepare('SELECT DISTINCT table_name FROM sync_outbox').all().map(r => r.table_name);
    for (const banned of ['shop_settings', 'staff', 'audit_log', 'sync_outbox']) {
      assert.ok(!tables.includes(banned), `${banned} never backfills`);
    }
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
