const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { spawn } = require('node:child_process');
const net = require('node:net');
const { DatabaseSync } = require('node:sqlite');
const { ROOT, CLOUD_SERVER, TOKEN_A, TOKEN_B, reservePort, startCloud, stopCloud, event, sync, login } = require('./cloud-hardening-harness');


test('cloud protocol binds credentials to shops and hardens manager reporting', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-cloud-hardening-'));
  fs.writeFileSync(path.join(dataDir, 'manager-pin.txt'), '2468\n');
  let child;
  try {
    const running = await startCloud(dataDir);
    child = running.child;
    const base = running.base;
    const now = new Date().toISOString();

    const headers = await fetch(`${base}/`);
    assert.strictEqual(headers.headers.get('x-content-type-options'), 'nosniff');
    assert.strictEqual(headers.headers.get('x-frame-options'), 'DENY');
    assert.strictEqual(headers.headers.get('referrer-policy'), 'no-referrer');
    assert.match(headers.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.strictEqual(headers.headers.get('cache-control'), 'no-store');
    assert.strictEqual((await fetch(`${base}/app.js`)).headers.get('cache-control'), 'no-store');

    const badTable = await sync(base, TOKEN_A, 'spoofed', [event(1, 'secrets', 1, { id: 1 })]);
    assert.strictEqual(badTable.status, 400);
    const badId = await sync(base, TOKEN_A, 'spoofed', [event(2, 'inventory', 0, { id: 0 })]);
    assert.strictEqual(badId.status, 400);
    const badSchema = await sync(base, TOKEN_A, 'spoofed', [event(3, 'sales', 1, { id: 1 })]);
    assert.strictEqual(badSchema.status, 400);
    assert.strictEqual((await sync(base, 'wrong', 'north', [])).status, 401);

    let outbox = 10;
    for (let start = 1; start <= 501; start += 100) {
      const events = [];
      for (let id = start; id < Math.min(start + 100, 502); id++) {
        events.push(event(outbox++, 'inventory', id, {
          id, brand: 'North', model_name: `M${id}`, part_type: 'LCD',
          cost_price: 0.5, price_retail: 1, stock_quantity: 1, archived: 0,
        }));
      }
      const res = await sync(base, TOKEN_A, 'body-id-is-not-authoritative', events);
      assert.strictEqual(res.status, 200);
      const ack = await res.json();
      assert.strictEqual(ack.shop_id, 'north');
      assert.strictEqual(ack.protocol, 2);
    }

    let res = await sync(base, TOKEN_B, 'north', [event(outbox++, 'inventory', 1, {
      id: 1, brand: 'South', model_name: 'M1', part_type: 'LCD',
      cost_price: 0.5, price_retail: 1, stock_quantity: 1, archived: 0,
    })]);
    assert.strictEqual((await res.json()).shop_id, 'south');

    const northRows = [
      event(outbox++, 'sales', 1, { id: 1, sale_code: 'N-CREDIT', customer_name: 'Ana', payment_method: 'credit', total_amount: 100, amount_paid: 20, change_amount: 0, credit_balance: 80, voided: 0, created_at: now }),
      event(outbox++, 'sales', 2, { id: 2, sale_code: 'N-VOID', customer_name: 'Void', payment_method: 'cash', total_amount: 999, amount_paid: 999, change_amount: 0, credit_balance: 500, voided: 1, created_at: now }),
      event(outbox++, 'sale_items', 1, { id: 1, sale_id: 1, inventory_id: 1, item_name: 'North LCD', item_type: 'part', quantity: 1, unit_cost: 40, total_price: 100 }),
      event(outbox++, 'credit_payments', 1, { id: 1, customer_name: 'Ana', amount_paid: 10, payment_method: 'cash', created_at: now }),
      event(outbox++, 'warranty_returns', 1, { id: 1, return_code: 'R-N', sale_id: 1, return_type: 'cash_refund', refund_amount: 5, created_at: now }),
    ];
    assert.strictEqual((await sync(base, TOKEN_A, 'ignored', northRows)).status, 200);
    const southRows = [
      event(outbox++, 'sales', 1, { id: 1, sale_code: 'S-CASH', customer_name: 'Ben', payment_method: 'cash', total_amount: 50, amount_paid: 50, change_amount: 0, credit_balance: 0, voided: 0, created_at: now }),
      event(outbox++, 'sale_items', 1, { id: 1, sale_id: 1, inventory_id: 1, item_name: 'South LCD', item_type: 'part', quantity: 1, unit_cost: 10, total_price: 50 }),
    ];
    assert.strictEqual((await sync(base, TOKEN_B, 'ignored', southRows)).status, 200);

    for (let i = 0; i < 5; i++) {
      const failed = await login(base, 'bad', '203.0.113.1');
      assert.ok(failed.res.status === 401 || failed.res.status === 429);
    }
    const otherClient = await login(base, '2468', '203.0.113.2');
    assert.strictEqual(otherClient.res.status, 200, 'one client must not globally lock out managers');
    assert.match(otherClient.res.headers.get('set-cookie'), /HttpOnly/i);
    assert.match(otherClient.res.headers.get('set-cookie'), /SameSite=Strict/i);
    assert.deepStrictEqual(await otherClient.res.json(), { ok: true });

    const auth = { Cookie: otherClient.cookie };
    assert.strictEqual((await fetch(`${base}/events?session=leaked-token`)).status, 401);
    const standing = await (await fetch(`${base}/api/standing`, { headers: auth })).json();
    assert.strictEqual(standing.inventory_retail_value, 502, 'standing aggregate must include rows beyond feed limit');
    assert.strictEqual(standing.outstanding_credit, 80, 'voided debt must be excluded');
    assert.strictEqual(standing.debtors, 1);

    const analytics = await (await fetch(`${base}/api/analytics?period=day`, { headers: auth })).json();
    assert.strictEqual(analytics.current.sale_count, 2);
    assert.strictEqual(analytics.current.revenue, 150);
    assert.strictEqual(analytics.current.cash_collected, 75);
    assert.strictEqual(analytics.current.credit_downpayments, 20);
    assert.strictEqual(analytics.current.credit_settled, 10);
    assert.strictEqual(analytics.current.refunded_total, 5);
    assert.strictEqual(analytics.current.gross_profit, 100);
    assert.strictEqual(analytics.current.net_profit, 95);
    assert.strictEqual(analytics.top_products.length, 2, 'same local inventory IDs from different shops must not merge');
    assert.deepStrictEqual(analytics.top_products.map(row => row.shop_id).sort(), ['north', 'south']);
    assert.strictEqual((await fetch(`${base}/api/rows?table=staff`, { headers: auth })).status, 400);

    const tombstone = event(outbox++, 'inventory', 501, null, { op: 'delete' });
    assert.strictEqual((await sync(base, TOKEN_A, 'ignored', [tombstone])).status, 200);
    const afterDelete = await (await fetch(`${base}/api/standing`, { headers: auth })).json();
    assert.strictEqual(afterDelete.inventory_retail_value, 501);

    await stopCloud(child);
    child = null;
    const db = new DatabaseSync(path.join(dataDir, 'cloud.db'));
    assert.strictEqual(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='shop_rows'").all().map(r => r.name);
    assert.ok(indexes.includes('idx_shop_rows_table_updated'));
    assert.ok(indexes.includes('idx_shop_rows_shop_table_updated'));
    const shops = db.prepare('SELECT shop_id FROM shops ORDER BY shop_id').all().map(r => r.shop_id);
    assert.deepStrictEqual(shops, ['north', 'south']);
    db.close();
  } finally {
    if (child) await stopCloud(child);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('remote plain HTTP bind fails closed without explicit acknowledgment', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-cloud-bind-'));
  try {
    const child = spawn(process.execPath, [CLOUD_SERVER], {
      cwd: ROOT,
      env: { ...process.env, HOST: '0.0.0.0', PORT: '0', DATA_DIR: dataDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stderr.on('data', chunk => { output += chunk; });
    const code = await new Promise(resolve => child.once('exit', resolve));
    assert.notStrictEqual(code, 0);
    assert.match(output, /Refusing remote plain-HTTP bind/);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('a partially invalid batch acks the valid rows and SSE delivers changes', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-cloud-partial-'));
  fs.writeFileSync(path.join(dataDir, 'manager-pin.txt'), '2468');
  let child;
  try {
    const running = await startCloud(dataDir);
    child = running.child;
    const base = running.base;

    // Valid row + invalid row in one batch: the valid one applies and acks,
    // the invalid one rides back with its reason instead of freezing the
    // shop's oldest-first outbox forever.
    const res = await sync(base, TOKEN_A, 'ignored', [
      event(1, 'inventory', 1, { id: 1, brand: 'North', model_name: 'OK', part_type: 'LCD', cost_price: 1, price_retail: 2, stock_quantity: 3, archived: 0 }),
      event(2, 'inventory', 2, { id: 2 }),
    ]);
    assert.strictEqual(res.status, 200);
    const ack = await res.json();
    assert.deepStrictEqual(ack.ok_ids, [1]);
    assert.strictEqual(ack.rejected.length, 1);
    assert.match(ack.rejected[0].error, /missing brand/);

    const { cookie } = await login(base, '2468', '203.0.113.9');
    const authH = { Cookie: cookie };
    const rows = await (await fetch(`${base}/api/rows?table=inventory`, { headers: authH })).json();
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].model_name, 'OK', 'the valid row applied despite its poisoned sibling');

    // A batch that is nothing but invalid rows still refuses outright.
    const bad = await sync(base, TOKEN_A, 'ignored', [event(3, 'inventory', 3, { id: 3 })]);
    assert.strictEqual(bad.status, 400);

    // The live feed the manager app depends on: hello on connect, then a
    // change event when a shop pushes. Nothing else in the suite covered this.
    const stream = await fetch(`${base}/events`, { headers: authH });
    assert.strictEqual(stream.status, 200);
    const reader = stream.body.getReader();
    const dec = new TextDecoder();
    const readWithin = async (ms) => {
      const timer = new Promise((_, rej) => setTimeout(() => rej(new Error('sse read timeout')), ms));
      const chunk = await Promise.race([reader.read(), timer]);
      return dec.decode(chunk.value);
    };
    assert.match(await readWithin(5000), /event: hello/);
    await sync(base, TOKEN_A, 'ignored', [event(4, 'inventory', 4, { id: 4, brand: 'North', model_name: 'Live', part_type: 'LCD', cost_price: 1, price_retail: 2, stock_quantity: 1, archived: 0 })]);
    assert.match(await readWithin(5000), /event: change/);
    await reader.cancel().catch(() => {});

    await stopCloud(child);
    child = null;
  } finally {
    if (child) await stopCloud(child);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('6-digit pairing code generation and counter pair handshake works end-to-end', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-cloud-pair-'));
  let child;
  try {
    const running = await startCloud(dataDir);
    child = running.child;
    const base = running.base;

    // 1. Virgin cloud auth state: no pin set, not logged in
    const authStateRes = await fetch(`${base}/api/auth-state`);
    assert.strictEqual(authStateRes.status, 200);
    const authState = await authStateRes.json();
    assert.strictEqual(authState.pin_set, false);
    assert.strictEqual(authState.logged_in, false);

    // 2. Setup master PIN
    const setupRes = await fetch(`${base}/api/setup-pin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: '7788' }),
    });
    assert.strictEqual(setupRes.status, 200);
    const setupData = await setupRes.json();
    assert.strictEqual(setupData.ok, true);
    const cookie = (setupRes.headers.get('set-cookie') || '').split(';')[0];
    assert.ok(cookie.includes('manager_session='));

    // Auth state now reflects pin is set and logged in
    const authState2 = await (await fetch(`${base}/api/auth-state`, { headers: { Cookie: cookie } })).json();
    assert.strictEqual(authState2.pin_set, true);
    assert.strictEqual(authState2.logged_in, true);

    // 3. Manager generates a 6-digit pairing code
    const genRes = await fetch(`${base}/api/pairing-code/generate`, {
      method: 'POST',
      headers: { Cookie: cookie },
    });
    assert.strictEqual(genRes.status, 200);
    const genData = await genRes.json();
    assert.strictEqual(genData.ok, true);
    assert.match(genData.code, /^\d{6}$/);
    assert.strictEqual(genData.expires_in_seconds, 600);

    // 4. Shop counter pairs using the 6-digit code
    const pairRes = await fetch(`${base}/api/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: genData.code, shop_name: 'Main Counter' }),
    });
    assert.strictEqual(pairRes.status, 200);
    const pairData = await pairRes.json();
    assert.strictEqual(pairData.ok, true);
    assert.strictEqual(typeof pairData.shop_id, 'string');
    assert.ok(pairData.shop_id.length > 0);
    assert.match(pairData.sync_token, /^[0-9a-f]{64}$/);

    // 5. Code cannot be reused
    const pairReuse = await fetch(`${base}/api/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: genData.code, shop_name: 'Counter 2' }),
    });
    assert.strictEqual(pairReuse.status, 400);

    // 6. Shop counter pushes data using the newly assigned sync_token
    const syncRes = await sync(base, pairData.sync_token, pairData.shop_id, [
      event(1, 'inventory', 101, { id: 101, brand: 'Samsung', model_name: 'S22', part_type: 'Screen', cost_price: 50, price_retail: 100, stock_quantity: 5, archived: 0 }),
    ]);
    assert.strictEqual(syncRes.status, 200);
    const syncAck = await syncRes.json();
    assert.deepStrictEqual(syncAck.ok_ids, [1]);

    // 7. Verify inventory row arrived in cloud DB
    const rowsRes = await fetch(`${base}/api/rows?table=inventory`, { headers: { Cookie: cookie } });
    assert.strictEqual(rowsRes.status, 200);
    const rows = await rowsRes.json();
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].model_name, 'S22');

    await stopCloud(child);
    child = null;
  } finally {
    if (child) await stopCloud(child);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('a legacy 48-hex manager PIN is rotated in place, never reopened for setup', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-cloud-legacy-pin-'));
  // The shape the old auto-generator wrote: 48 hex chars, untypeable on the keypad.
  const legacy = 'a1'.repeat(24);
  fs.writeFileSync(path.join(dir, 'manager-pin.txt'), legacy + '\n');
  let child;
  try {
    const running = await startCloud(dir);
    child = running.child;
    // Reading the PIN migrates it: the old code unlinked the file and reported
    // no PIN, which reopened unauthenticated POST /api/setup-pin on the boot.
    const state = await (await fetch(`${running.base}/api/auth-state`)).json();
    assert.strictEqual(state.pin_set, true, 'a legacy PIN file must keep setup closed');
    const rewritten = fs.readFileSync(path.join(dir, 'manager-pin.txt'), 'utf8').trim();
    assert.match(rewritten, /^\d{8}$/, `the legacy PIN must become keypad-typable, got "${rewritten}"`);
    assert.notStrictEqual(rewritten, legacy);

    const takeover = await fetch(`${running.base}/api/setup-pin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '203.0.113.30' },
      body: JSON.stringify({ pin: '9999' }),
    });
    assert.strictEqual(takeover.status, 403, 'setup must stay closed after the migration');

    const ok = await login(running.base, rewritten, '203.0.113.31');
    assert.strictEqual(ok.res.status, 200, 'the migrated PIN must log the manager in');

    await stopCloud(child);
    child = null;
  } finally {
    if (child) await stopCloud(child);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('--rotate-pin writes a keypad-typable PIN the next boot keeps', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-cloud-rotate-'));
  try {
    const child = spawn(process.execPath, [CLOUD_SERVER, '--rotate-pin'], {
      cwd: ROOT,
      env: { ...process.env, DATA_DIR: dir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    const code = await new Promise(resolve => child.once('exit', resolve));
    assert.strictEqual(code, 0);
    const written = fs.readFileSync(path.join(dir, 'manager-pin.txt'), 'utf8').trim();
    // The old rotation wrote 48 hex chars, which getManagerPin() treats as the
    // legacy shape and rewrites on the next boot: the "new" PIN never survived a
    // restart, and the rewrite used to be a delete that reopened setup.
    assert.match(written, /^\d{8}$/, `rotate-pin must write a typable PIN, got "${written}"`);
    assert.ok(output.includes(written), 'the rotated PIN must be printed once for the operator');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pairing guesses are budget-limited while a code is live', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-cloud-pair-budget-'));
  let child;
  try {
    const running = await startCloud(dir, { DEPLOY_DIR: dir });
    child = running.child;
    const base = running.base;
    // One client, 21 guesses: the 6-digit code carries 900k combinations, so an
    // unbudgeted route was a brute-force loop against an internet-facing door.
    const statuses = [];
    for (let i = 0; i < 21; i++) {
      const res = await fetch(`${base}/api/pair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '198.51.100.77' },
        body: JSON.stringify({ code: '000000', shop_name: 'Guess' }),
      });
      statuses.push(res.status);
    }
    assert.ok(statuses.includes(429), `expected the budget to trip, saw ${statuses.join(',')}`);
    assert.strictEqual(statuses[0], 400, 'the first guesses are simply invalid codes');
    // A different client is not punished for its neighbour's flood.
    const other = await fetch(`${base}/api/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '198.51.100.78' },
      body: JSON.stringify({ code: '000000', shop_name: 'Other' }),
    });
    assert.strictEqual(other.status, 400);
    await stopCloud(child);
    child = null;
  } finally {
    if (child) await stopCloud(child);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('setup-pin bootstraps once and can never take over a live PIN', async () => {
  const post = (base, pin, ip) => fetch(`${base}/api/setup-pin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify({ pin })
  });

  // A PIN is already on disk: the route must refuse, issue no session, and leave the
  // file untouched. This is the hole where any visitor to a public VPS could replace
  // the manager PIN and be handed the session cookie in the same response.
  const takenDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-cloud-pin-'));
  fs.writeFileSync(path.join(takenDir, 'manager-pin.txt'), '2468\n');
  let child;
  try {
    const running = await startCloud(takenDir);
    child = running.child;
    const res = await post(running.base, '9999', '203.0.113.20');
    assert.strictEqual(res.status, 403, 'a set PIN must refuse re-setup');
    assert.strictEqual(res.headers.get('set-cookie'), null, 'no session may be issued');
    assert.strictEqual(fs.readFileSync(path.join(takenDir, 'manager-pin.txt'), 'utf8').trim(), '2468');
    const kept = await login(running.base, '2468', '203.0.113.21');
    assert.strictEqual(kept.res.status, 200, 'the real PIN still works');
    await stopCloud(child);
    child = null;
  } finally {
    if (child) await stopCloud(child);
    fs.rmSync(takenDir, { recursive: true, force: true });
  }

  // Nothing set yet: the first call works, the second is refused, and the PIN it chose
  // is the one that logs in.
  const freshDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-cloud-nopin-'));
  try {
    const running = await startCloud(freshDir);
    child = running.child;
    assert.strictEqual((await post(running.base, '1357', '203.0.113.22')).status, 200);
    assert.strictEqual((await post(running.base, '9999', '203.0.113.23')).status, 403);
    const first = await login(running.base, '1357', '203.0.113.24');
    assert.strictEqual(first.res.status, 200);
    await stopCloud(child);
    child = null;
  } finally {
    if (child) await stopCloud(child);
    fs.rmSync(freshDir, { recursive: true, force: true });
  }
});


test('cloud login refuses while no manager PIN exists and never advertises a default', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-cloud-nopinlogin-'));
  let child;
  try {
    const running = await startCloud(dir, { DEPLOY_DIR: dir });
    child = running.child;
    const base = running.base;
    const state = await (await fetch(`${base}/api/auth-state`)).json();
    assert.strictEqual(state.pin_set, false);

    // The old posture handed a full manager session (and every shop's mirrored
    // sale rows, customer names and phones) to anyone who typed 1234 before the
    // operator's first login. setup-pin is the only bootstrap path now.
    const attempt = await login(base, '1234');
    assert.strictEqual(attempt.res.status, 403, 'no PIN must refuse login, not grant a session');
    assert.strictEqual(attempt.res.headers.get('set-cookie'), null, 'no session may be issued on the default');
    const rows = await fetch(`${base}/api/rows?table=sales`, { headers: { cookie: attempt.cookie } });
    assert.strictEqual(rows.status, 401, 'the refused login must not have authorized anything');

    const setup = await fetch(`${base}/api/setup-pin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: '4321' })
    });
    assert.strictEqual(setup.status, 200, 'setup-pin stays the bootstrap');
    assert.strictEqual((await login(base, '4321')).res.status, 200);

    // A wrong PIN never names a default either.
    const wrong = await login(base, '1234', '198.51.100.99');
    assert.strictEqual(wrong.res.status, 401);
    assert.ok(!/1234/.test(String((await wrong.res.json()).error)), 'the failure message still advertises a default PIN');
  } finally {
    if (child) await stopCloud(child);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cloud refuses to boot when MANAGER_PIN is present but blank', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-cloud-blankpin-'));
  try {
    const port = await reservePort();
    const child = spawn(process.execPath, [CLOUD_SERVER], {
      cwd: ROOT,
      env: {
        ...process.env,
        PORT: String(port),
        HOST: '127.0.0.1',
        DATA_DIR: dir,
        MANAGER_PIN: '',
        SHOP_SYNC_CREDENTIALS: JSON.stringify({ north: TOKEN_A })
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    child.stdout.on('data', c => { output += c; });
    child.stderr.on('data', c => { output += c; });
    const code = await new Promise(resolve => child.once('exit', resolve));
    assert.notStrictEqual(code, 0, 'a blank MANAGER_PIN must fail the boot, not fall open to setup-pin');
    assert.match(output, /MANAGER_PIN is set but blank/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cloud pairing cannot rotate an existing shop credential', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-cloud-paircollide-'));
  fs.writeFileSync(path.join(dir, 'manager-pin.txt'), '2468\n');
  let child;
  try {
    const running = await startCloud(dir, { DEPLOY_DIR: dir });
    child = running.child;
    const base = running.base;
    const { cookie } = await login(base);
    const newCode = async () => (await (await fetch(`${base}/api/pairing-code/generate`, { method: 'POST', headers: { cookie } })).json()).code;
    const pair = (code, shop_name) => fetch(`${base}/api/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, shop_name })
    });

    // 'north' already has a credential: a live pairing code must not overwrite
    // it (the real register's pushes would start 401ing and its outbox would
    // prune the backlog after 30 days).
    const gen = await newCode();
    assert.strictEqual((await pair(gen, 'north')).status, 409);
    assert.strictEqual((await sync(base, TOKEN_A, 'north', [event(90, 'inventory', 90, { id: 90, brand: 'A', model_name: 'B', part_type: 'C' })])).status, 200,
      'the existing credential must survive the collision');
    // The same code still pairs a fresh name (409 does not spend it)...
    assert.strictEqual((await pair(gen, 'counter-2')).status, 200);
    // ...and a second pairing under that same name is refused too (a name with
    // a space is not a valid shop id, so only id-shaped names can collide).
    assert.strictEqual((await pair(await newCode(), 'counter-2')).status, 409);
    assert.strictEqual((await pair(await newCode(), 'counter-3')).status, 200);
  } finally {
    if (child) await stopCloud(child);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cloud standing carries the whole open-debtor list, folded, beyond the row window', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-cloud-utang-'));
  fs.writeFileSync(path.join(dir, 'manager-pin.txt'), '2468\n');
  let child;
  try {
    const running = await startCloud(dir, { DEPLOY_DIR: dir });
    child = running.child;
    const base = running.base;
    const saleRow = (id, customer, balance) => ({
      id, sale_code: `S-${id}`, customer_name: customer, payment_method: 'credit',
      total_amount: 100, amount_paid: 0, change_amount: 0, credit_balance: balance,
      created_at: new Date().toISOString(), voided: 0
    });
    // 501 sales rows: the OLDEST carries the utang, and a re-cased spelling of
    // the same customer lands later owing nothing. 501 is one past the
    // /api/rows window, so a list built from that window would drop the debt.
    let outbox = 1;
    assert.strictEqual((await sync(base, TOKEN_A, 'north', [event(outbox++, 'sales', 1, saleRow(1, 'Jose Old', 250))])).status, 200);
    for (let start = 2; start <= 501; start += 100) {
      const events = [];
      for (let id = start; id < Math.min(start + 100, 502); id++) {
        events.push(event(outbox++, 'sales', id, saleRow(id, id === 501 ? 'JOSE OLD' : 'Walk-in', 0)));
      }
      assert.strictEqual((await sync(base, TOKEN_A, 'north', events)).status, 200);
    }

    const { cookie } = await login(base);
    const standing = await (await fetch(`${base}/api/standing`, { headers: { cookie } })).json();
    assert.strictEqual(standing.debtors, 1, 'Jose Old and JOSE OLD are one debtor');
    assert.strictEqual(standing.debtor_list.length, 1);
    assert.strictEqual(standing.debtor_list[0].balance, 250);
    assert.strictEqual(String(standing.debtor_list[0].name).toLowerCase(), 'jose old');
    // The window really is smaller than the mirror: the debt sits outside it.
    const window = await (await fetch(`${base}/api/rows?table=sales`, { headers: { cookie } })).json();
    assert.ok(window.length <= 500, 'the sales window is still capped');
  } finally {
    if (child) await stopCloud(child);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cloud analytics buckets by the declared shop offset, not the server clock', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-cloud-tz-'));
  fs.writeFileSync(path.join(dir, 'manager-pin.txt'), '2468\n');
  let child;
  try {
    const running = await startCloud(dir, { SHOP_TZ_OFFSET_MINUTES: '480' });
    child = running.child;
    const base = running.base;
    assert.match(String(child.outputTail || ''), /analytics bucket by UTC offset \+480 minutes/, 'the boot line must name the effective clock');

    // 10 shop-minutes past shop-midnight (UTC+8): in UTC that instant sits on
    // the PREVIOUS calendar day, so only the declared offset puts it in "today".
    const shopNow = new Date(Date.now() + 480 * 60000);
    const created = new Date(Date.UTC(shopNow.getUTCFullYear(), shopNow.getUTCMonth(), shopNow.getUTCDate(), 0, 10) - 480 * 60000).toISOString();
    const res = await sync(base, TOKEN_A, 'north', [event(1, 'sales', 1, {
      id: 1, sale_code: 'S-1', customer_name: 'Walk-in', payment_method: 'cash', total_amount: 100,
      amount_paid: 100, change_amount: 0, credit_balance: 0, created_at: created, voided: 0
    })]);
    assert.strictEqual(res.status, 200);

    const { cookie } = await login(base);
    const analytics = await (await fetch(`${base}/api/analytics?period=day`, { headers: { cookie } })).json();
    assert.strictEqual(analytics.current.sale_count, 1, 'the sale must land on shop-today, not the VPS day');
    const expectedBucket = `${shopNow.getUTCFullYear()}-${String(shopNow.getUTCMonth() + 1).padStart(2, '0')}-${String(shopNow.getUTCDate()).padStart(2, '0')}`;
    assert.strictEqual(analytics.trend.length, 1);
    assert.strictEqual(analytics.trend[0].bucket, expectedBucket, 'trend bucket must also use declared shop offset');
  } finally {
    if (child) await stopCloud(child);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cloud analytics deducts RMA replacement cost and sale discounts in net_profit and top_products', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-cloud-rma-'));
  fs.writeFileSync(path.join(dir, 'manager-pin.txt'), '2468\n');
  let child;
  try {
    const running = await startCloud(dir, { SHOP_TZ_OFFSET_MINUTES: '480' });
    child = running.child;
    const base = running.base;
    const nowIso = new Date().toISOString();

    const res = await sync(base, TOKEN_A, 'north', [
      event(1, 'inventory', 10, {
        id: 10, brand: 'Apple', model_name: 'iPhone 13', part_type: 'LCD',
        cost_price: 100, price_retail: 300, stock_quantity: 4, updated_at: nowIso
      }),
      event(2, 'sales', 1, {
        id: 1, sale_code: 'S-1', customer_name: 'Walk-in', payment_method: 'cash',
        subtotal: 600, discount_amount: 60, total_amount: 540,
        amount_paid: 540, change_amount: 0, credit_balance: 0, created_at: nowIso, voided: 0
      }),
      event(3, 'sale_items', 100, {
        id: 100, sale_id: 1, inventory_id: 10, item_type: 'part',
        item_name: 'Apple iPhone 13 LCD', quantity: 2, unit_price: 300, unit_cost: 100, total_price: 600
      }),
      event(4, 'warranty_returns', 50, {
        id: 50, return_code: 'RMA-50', sale_id: 1, sale_item_id: 100, return_type: 'replacement',
        quantity: 1, refund_amount: 0, replacement_inventory_id: 10, created_at: nowIso
      })
    ]);
    assert.strictEqual(res.status, 200);

    const { cookie } = await login(base);
    const analytics = await (await fetch(`${base}/api/analytics?period=day`, { headers: { cookie } })).json();
    assert.ok(analytics.generated_at, 'analytics payload must include generated_at');
    // Revenue = 540, original cost = 200, replacement cost = 100 -> gross = 340, net = 240
    assert.strictEqual(analytics.current.revenue, 540);
    assert.strictEqual(analytics.current.gross_profit, 340);
    assert.strictEqual(analytics.current.replacement_cost, 100);
    assert.strictEqual(analytics.current.net_profit, 240);
    assert.strictEqual(analytics.current.collected_total, 540);
    assert.strictEqual(analytics.top_products.length, 1);
    assert.strictEqual(analytics.top_products[0].units, 2);
    assert.strictEqual(analytics.top_products[0].revenue, 540);
    assert.strictEqual(analytics.top_products[0].profit, 240);
  } finally {
    if (child) await stopCloud(child);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cloud PWA removes infinite beacon pulse, renders net_profit and transfer badge, and supports 3-state freshness + desktop reflow', () => {
  const html = fs.readFileSync(path.join(ROOT, 'cloud', 'public', 'index.html'), 'utf8');
  const appJs = fs.readFileSync(path.join(ROOT, 'cloud', 'public', 'app.js'), 'utf8');

  assert.doesNotMatch(html, /animation:\s*pulse/);
  assert.doesNotMatch(html, /@keyframes\s+pulse/);
  assert.match(html, /\.badge\.transfer/);
  assert.match(html, /Profit After Returns/);
  assert.match(html, /@media \(min-width: 760px\)/);
  assert.match(html, /id="trend-card"/);
  assert.match(html, /id="audit-banner"/);
  assert.match(html, /id="shop-filter"/);
  assert.match(html, /id="feed-search"/);
  assert.match(html, /class="desktop-tabs"/);

  assert.match(appJs, /c\.net_profit/);
  assert.match(appJs, /s\.payment_method === 'transfer'/);
  assert.match(appJs, /STALE_MAX_MS = 300000/);
  assert.match(appJs, /visibilitychange/);
  assert.match(appJs, /day_reconciliations/);
  assert.match(appJs, /cash_adjustments/);
  assert.match(appJs, /parts_revenue/);
  assert.match(appJs, /labor_revenue/);
  assert.match(html, /id="paired-shops-list"/);
  assert.match(appJs, /data-unlink-shop/);
});

test('cloud manager can unlink and delete an unwanted shop registration', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-cloud-deleteshop-'));
  fs.writeFileSync(path.join(dir, 'manager-pin.txt'), '2468\n');
  let child;
  try {
    const running = await startCloud(dir, { DEPLOY_DIR: dir });
    child = running.child;
    const base = running.base;
    const { cookie } = await login(base);

    // Sync inventory into both north and south
    await sync(base, TOKEN_A, 'north', [event(1, 'inventory', 1, { id: 1, brand: 'A', model_name: 'N1', part_type: 'LCD' })]);
    await sync(base, TOKEN_B, 'south', [event(2, 'inventory', 2, { id: 2, brand: 'B', model_name: 'S1', part_type: 'Battery' })]);

    // Overview lists both shops
    const overview1 = await (await fetch(`${base}/api/overview`, { headers: { cookie } })).json();
    assert.strictEqual(overview1.shops.length, 2);
    assert.ok(overview1.shops.some(s => s.shop_id === 'north'));
    assert.ok(overview1.shops.some(s => s.shop_id === 'south'));

    // Scoped query checks
    const allInv = await (await fetch(`${base}/api/rows?table=inventory`, { headers: { cookie } })).json();
    assert.strictEqual(allInv.length, 2);
    const northInv = await (await fetch(`${base}/api/rows?table=inventory&shop=north`, { headers: { cookie } })).json();
    assert.strictEqual(northInv.length, 1);
    assert.strictEqual(northInv[0].model_name, 'N1');

    // Delete south
    const delRes = await fetch(`${base}/api/shops/south`, { method: 'DELETE', headers: { cookie } });
    assert.strictEqual(delRes.status, 200);
    const delData = await delRes.json();
    assert.strictEqual(delData.ok, true);
    assert.strictEqual(delData.deleted, 'south');

    // Overview now has only north
    const overview2 = await (await fetch(`${base}/api/overview`, { headers: { cookie } })).json();
    assert.strictEqual(overview2.shops.length, 1);
    assert.strictEqual(overview2.shops[0].shop_id, 'north');

    // All inventory now only contains north
    const remainingInv = await (await fetch(`${base}/api/rows?table=inventory`, { headers: { cookie } })).json();
    assert.strictEqual(remainingInv.length, 1);
    assert.strictEqual(remainingInv[0].model_name, 'N1');
  } finally {
    if (child) await stopCloud(child);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('multi-tenant store isolation: stores cannot view or modify each other data', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-cloud-multitenant-'));
  fs.writeFileSync(path.join(dir, 'manager-pin.txt'), '2468\n');
  let child;
  try {
    const running = await startCloud(dir, { DEPLOY_DIR: dir });
    child = running.child;
    const base = running.base;

    // 1. Create Store Alpha
    const resA = await fetch(`${base}/api/create-store`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ store_name: 'Store Alpha', pin: '1111', manager_pin: '2468' })
    });
    // A server with a manager PIN is claimed: even the first create needs the
    // owner PIN; an unauthenticated call answers 403.
    assert.strictEqual(resA.status, 200);
    const dataA = await resA.json();
    assert.strictEqual(dataA.store_name, 'Store Alpha');
    const cookieA = (resA.headers.get('set-cookie') || '').split(';')[0];

    // 2. Create Store Beta: after Alpha claimed the server, the route needs
    // the server manager PIN (the open-mint hole the 2026-11-06 audit closed).
    const resNoPin = await fetch(`${base}/api/create-store`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ store_name: 'Store Sneak', pin: '3333' })
    });
    assert.strictEqual(resNoPin.status, 403, 'an unauthenticated mint after first claim is refused');
    const resB = await fetch(`${base}/api/create-store`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ store_name: 'Store Beta', pin: '2222', manager_pin: '2468' })
    });
    assert.strictEqual(resB.status, 200);
    const dataB = await resB.json();
    assert.strictEqual(dataB.store_name, 'Store Beta');
    const cookieB = (resB.headers.get('set-cookie') || '').split(';')[0];

    // 3. Store Alpha generates pairing code and pairs Register Alpha
    const codeA = (await (await fetch(`${base}/api/pairing-code/generate`, { method: 'POST', headers: { Cookie: cookieA } })).json()).code;
    const pairA = await (await fetch(`${base}/api/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: codeA, shop_name: 'alpha-reg-1', register_name: 'Alpha Counter 1' })
    })).json();
    assert.strictEqual(pairA.ok, true);

    // 4. Store Beta generates pairing code and pairs Register Beta
    const codeB = (await (await fetch(`${base}/api/pairing-code/generate`, { method: 'POST', headers: { Cookie: cookieB } })).json()).code;
    const pairB = await (await fetch(`${base}/api/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: codeB, shop_name: 'beta-reg-1', register_name: 'Beta Counter 1' })
    })).json();
    assert.strictEqual(pairB.ok, true);

    // 5. Push data to both registers
    await sync(base, pairA.sync_token, pairA.shop_id, [
      event(1, 'inventory', 1, { id: 1, brand: 'Apple', model_name: 'iPhone 13 Screen', part_type: 'LCD', cost_price: 100, price_retail: 250, stock_quantity: 5, archived: 0 }),
      event(2, 'sales', 1, { id: 1, sale_code: 'SA-1', customer_name: 'John Alpha', payment_method: 'cash', total_amount: 250, amount_paid: 250, change_amount: 0, credit_balance: 0, created_at: new Date().toISOString() })
    ]);

    await sync(base, pairB.sync_token, pairB.shop_id, [
      event(1, 'inventory', 1, { id: 1, brand: 'Samsung', model_name: 'S22 Screen', part_type: 'LCD', cost_price: 120, price_retail: 300, stock_quantity: 3, archived: 0 }),
      event(2, 'sales', 1, { id: 1, sale_code: 'SB-1', customer_name: 'Mary Beta', payment_method: 'cash', total_amount: 300, amount_paid: 300, change_amount: 0, credit_balance: 0, created_at: new Date().toISOString() })
    ]);

    // 6. Verify Store Alpha sees ONLY Alpha data
    const overviewA = await (await fetch(`${base}/api/overview`, { headers: { Cookie: cookieA } })).json();
    assert.strictEqual(overviewA.shops.length, 1);
    assert.strictEqual(overviewA.shops[0].shop_id, pairA.shop_id);
    assert.strictEqual(overviewA.shops[0].shop_name, 'Alpha Counter 1');

    const invA = await (await fetch(`${base}/api/rows?table=inventory`, { headers: { Cookie: cookieA } })).json();
    assert.strictEqual(invA.length, 1);
    assert.strictEqual(invA[0].model_name, 'iPhone 13 Screen');

    const salesA = await (await fetch(`${base}/api/rows?table=sales`, { headers: { Cookie: cookieA } })).json();
    assert.strictEqual(salesA.length, 1);
    assert.strictEqual(salesA[0].sale_code, 'SA-1');

    // Alpha attempts to delete Beta's register -> 404 forbidden
    const rogueDel = await fetch(`${base}/api/shops/${pairB.shop_id}`, { method: 'DELETE', headers: { Cookie: cookieA } });
    assert.strictEqual(rogueDel.status, 404);

    // 7. Verify Store Beta sees ONLY Beta data
    const overviewB = await (await fetch(`${base}/api/overview`, { headers: { Cookie: cookieB } })).json();
    assert.strictEqual(overviewB.shops.length, 1);
    assert.strictEqual(overviewB.shops[0].shop_id, pairB.shop_id);
    assert.strictEqual(overviewB.shops[0].shop_name, 'Beta Counter 1');

    const invB = await (await fetch(`${base}/api/rows?table=inventory`, { headers: { Cookie: cookieB } })).json();
    assert.strictEqual(invB.length, 1);
    assert.strictEqual(invB[0].model_name, 'S22 Screen');

    // Store Beta can delete its own register
    const validDel = await fetch(`${base}/api/shops/${pairB.shop_id}`, { method: 'DELETE', headers: { Cookie: cookieB } });
    assert.strictEqual(validDel.status, 200);

    const postDelB = await (await fetch(`${base}/api/overview`, { headers: { Cookie: cookieB } })).json();
    assert.strictEqual(postDelB.shops.length, 0);

    // Store Alpha is completely unaffected
    const postDelA = await (await fetch(`${base}/api/overview`, { headers: { Cookie: cookieA } })).json();
    assert.strictEqual(postDelA.shops.length, 1);

    // 8. /api/deploy: non-default store cannot deploy (403); primary owner can deploy valid whitelisted files
    const forbiddenDeploy = await fetch(`${base}/api/deploy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookieA },
      body: JSON.stringify({ files: { 'public/app.js': '// valid js content over 32 bytes for test\nconst x = 1;\n' } })
    });
    assert.strictEqual(forbiddenDeploy.status, 403);

    const { cookie: ownerCookie } = await login(base, '2468');
    const badSyntaxDeploy = await fetch(`${base}/api/deploy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
      body: JSON.stringify({ files: { 'public/app.js': 'function broken( { // syntax error over 32 bytes\n' } })
    });
    assert.strictEqual(badSyntaxDeploy.status, 400);

    const goodDeploy = await fetch(`${base}/api/deploy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
      body: JSON.stringify({ files: { 'public/app.js': '// valid deployed app.js over 32 characters\nconsole.log("ok");\n' } })
    });
    assert.strictEqual(goodDeploy.status, 200);
    assert.deepStrictEqual((await goodDeploy.json()).updated, ['public/app.js']);
    assert.match(fs.readFileSync(path.join(dir, 'public', 'app.js'), 'utf8'), /valid deployed app\.js/);
  } finally {
    if (child) await stopCloud(child);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('opening cloud on phone includes pre-registered and migrated POS registers', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-cloud-registered-pos-'));
  // Create an existing legacy database where shops table exists without store_id
  const db = new DatabaseSync(path.join(dir, 'cloud.db'));
  db.exec(`
    CREATE TABLE shops (
      shop_id TEXT PRIMARY KEY,
      first_seen TEXT NOT NULL,
      last_seen TEXT NOT NULL
    );
    CREATE TABLE shop_rows (
      shop_id TEXT NOT NULL REFERENCES shops(shop_id),
      table_name TEXT NOT NULL,
      local_id INTEGER NOT NULL,
      row_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (shop_id, table_name, local_id)
    );
  `);
  db.prepare("INSERT INTO shops (shop_id, first_seen, last_seen) VALUES ('counter-pos-1', '2026-10-01', '2026-10-02')").run();
  db.prepare("INSERT INTO shop_rows (shop_id, table_name, local_id, row_json, updated_at) VALUES ('counter-pos-1', 'sales', 1, '{\"id\":1,\"sale_code\":\"S-101\",\"customer_name\":\"Alice\",\"payment_method\":\"cash\",\"total_amount\":750,\"amount_paid\":750,\"change_amount\":0,\"credit_balance\":0,\"created_at\":\"2026-10-02T10:00:00Z\"}', '2026-10-02T10:00:00Z')").run();
  db.close();

  fs.writeFileSync(path.join(dir, 'manager-pin.txt'), '1234\n');
  fs.writeFileSync(path.join(dir, 'sync-credentials.json'), JSON.stringify({ 'counter-pos-1': 'c'.repeat(64) }) + '\n');

  let child;
  try {
    const running = await startCloud(dir);
    child = running.child;
    const base = running.base;

    // Phone logs in with 1234
    const { res: loginRes, cookie } = await login(base, '1234');
    assert.strictEqual(loginRes.status, 200);

    // Overview on phone includes the registered POS
    const overviewRes = await fetch(`${base}/api/overview`, { headers: { Cookie: cookie } });
    assert.strictEqual(overviewRes.status, 200);
    const overview = await overviewRes.json();
    assert.ok(overview.shops.some(s => s.shop_id === 'counter-pos-1'), 'counter-pos-1 is present in overview');

    // Sales rows on phone include the registered POS's sales
    const salesRes = await fetch(`${base}/api/rows?table=sales`, { headers: { Cookie: cookie } });
    assert.strictEqual(salesRes.status, 200);
    const sales = await salesRes.json();
    assert.strictEqual(sales.length, 1);
    assert.strictEqual(sales[0].sale_code, 'S-101');
  } finally {
    if (child) await stopCloud(child);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});




test('an empty heartbeat batch stays quiet on the SSE stream', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-cloud-heartbeat-'));
  fs.writeFileSync(path.join(dataDir, 'manager-pin.txt'), '2468\n');
  let child;
  try {
    const running = await startCloud(dataDir);
    child = running.child;
    const base = running.base;

    // Manager session + one live SSE stream.
    const { cookie } = await login(base);
    const events = [];
    const { ClientRequest: _c } = {};
    const http = require('node:http');
    const sseDone = { resolve: null };
    const ssePromise = new Promise(r => { sseDone.resolve = r; });
    const req = http.request(`${base}/events`, { headers: { cookie } }, res => {
      res.setEncoding('utf8');
      let buf = '';
      res.on('data', chunk => {
        buf += chunk;
        if (buf.includes('event: hello') && !events.includes('hello')) events.push('hello');
        if (buf.includes('event: change')) {
          // The payload names its shop: the client's per-shop filter depends on it.
          const m = buf.split('\n\n').reverse().find(b => b.includes('event: change'));
          try { events.push(JSON.parse((m.match(/data: (.*)/) || [])[1]).shop_id); } catch (_) { events.push('unparseable'); }
        }
      });
    });
    req.end();

    // The shop's 60s heartbeat: an empty batch must NOT broadcast (every
    // manager phone would run a full refetch once a minute per shop).
    const hb = await sync(base, TOKEN_A, 'north', []);
    assert.strictEqual(hb.status, 200, 'the heartbeat itself is accepted');
    const hbBody = await hb.json();
    assert.deepStrictEqual(hbBody.ok_ids, [], 'an empty batch acks nothing');

    await new Promise(r => setTimeout(r, 1200));
    assert.ok(!events.includes('change'), 'an empty heartbeat broadcast nothing');

    // A real row still announces itself, so the guard did not mute the feed.
    const real = await sync(base, TOKEN_A, 'north', [event(1, 'sales', 11, { id: 11, sale_code: 'S-HEART', customer_name: 'x', payment_method: 'cash', subtotal: 10, total_amount: 10, created_at: new Date().toISOString() })]);
    assert.strictEqual(real.status, 200);
    await new Promise(r => setTimeout(r, 800));
    assert.ok(events.includes('north'), 'a real row still broadcasts, tagged with its shop');
    req.destroy();
  } finally {
    if (child) await stopCloud(child);
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (_) {}
  }
});

test('the manager app refetches only the shop a change event names', () => {
  // onSseChange is the whole refetch decision, extracted so a vm test can
  // drive it with real payloads instead of pinning source text.
  const src = fs.readFileSync(path.join(ROOT, 'cloud-deploy', 'public', 'app.js'), 'utf8');
  const start = src.indexOf('function onSseChange(');
  const end = src.indexOf('\n}', src.indexOf('scheduleRefresh();', start)) + 2;
  const vm = require('node:vm');
  let scheduled = 0;
  const ctx = vm.createContext({
    selectedShop: 'north',
    scheduleRefresh: () => { scheduled++; },
  });
  vm.runInContext(src.slice(start, end), ctx);
  const makeEvent = (shopId) => ({ data: JSON.stringify({ shop_id: shopId, count: 1 }) });

  ctx.onSseChange(makeEvent('north'));
  ctx.onSseChange({ data: '{}' });            // untagged payload: older server
  ctx.onSseChange({ data: 'not json' });      // hostile payload
  ctx.onSseChange();                          // missing event object
  assert.strictEqual(scheduled, 4, 'own-shop, untagged, broken and absent payloads all refresh');

  ctx.onSseChange(makeEvent('south'));
  assert.strictEqual(scheduled, 4, "another shop's change does not refetch the selected view");
});
