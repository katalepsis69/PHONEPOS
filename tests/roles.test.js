// phone-repair-pos/tests/roles.test.js
// Roles, session/elevation tokens, and the append-only audit log.
const assert = require('node:assert');
const { dbTest, serverTest, ensurePinChanged } = require('./helper');
const {
  createStaff, listActiveStaff, deactivateStaff, resetStaffPin, verifyStaffPin,
  issueSessionToken, verifySessionToken, issueElevationToken, verifyElevationToken,
  updateManagerPin
} = require('../src/auth');

const j = (r) => r.json();
const post = (url, body, headers = {}) => fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body)
});

async function managerLogin(baseUrl) {
  const res = await post(`${baseUrl}/api/auth/login`, { pin: '1234' });
  return { res, data: await j(res) };
}

async function staffLogin(baseUrl, staffId, pin) {
  const res = await post(`${baseUrl}/api/auth/login`, { staffId, pin });
  return { res, data: await j(res) };
}

// -------------------------------------------------------------
// STAFF MODULE
// -------------------------------------------------------------
dbTest('Staff: create, list, verify; weak PIN and duplicate names rejected', (db) => {
  const jun = createStaff(db, 'Jun', '4321');
  assert.strictEqual(jun.name, 'Jun');
  assert.strictEqual(jun.active, 1);

  createStaff(db, 'Ana', '5555');
  assert.deepStrictEqual(listActiveStaff(db).map(s => s.name), ['Ana', 'Jun']);

  assert.throws(() => createStaff(db, 'Jun', '9999'), /already taken/i);
  assert.throws(() => createStaff(db, 'Jun2', '123'), /at least 4 digits/i);
  assert.throws(() => createStaff(db, 'Jun2', '1234'), /factory default/i);
  assert.throws(() => createStaff(db, '  ', '9999'), /name is required/i);

  assert.strictEqual(verifyStaffPin(db, jun.id, '4321'), true);
  assert.strictEqual(verifyStaffPin(db, jun.id, '0000'), false);
});

dbTest('Staff: PIN reset revokes sessions and clears lockout; deactivation kills login', (db) => {
  const jun = createStaff(db, 'Jun', '4321');
  const token = issueSessionToken(db, { type: 'staff', id: jun.id, name: 'Jun' });
  assert.ok(verifySessionToken(db, token));

  // Burn the per-staff lockout, then reset the PIN: lockout must clear too.
  for (let i = 0; i < 4; i++) verifyStaffPin(db, jun.id, '0000');
  assert.throws(() => verifyStaffPin(db, jun.id, '0000'), /Locked for/i);
  assert.ok(resetStaffPin(db, jun.id, '6789'));
  assert.strictEqual(verifyStaffPin(db, jun.id, '6789'), true);

  // Old session died with the old PIN (cred fingerprint no longer matches).
  assert.strictEqual(verifySessionToken(db, token), null);
  const fresh = issueSessionToken(db, { type: 'staff', id: jun.id, name: 'Jun' });
  assert.ok(verifySessionToken(db, fresh));

  // Deactivation: no login, no valid session.
  assert.ok(deactivateStaff(db, jun.id));
  assert.strictEqual(verifyStaffPin(db, jun.id, '6789'), false);
  assert.strictEqual(verifySessionToken(db, fresh), null);
  assert.deepStrictEqual(listActiveStaff(db), []);
});

dbTest('Staff lockout is per-person: one locked staff does not lock another', (db) => {
  const jun = createStaff(db, 'Jun', '4321');
  const ana = createStaff(db, 'Ana', '5555');
  for (let i = 0; i < 4; i++) verifyStaffPin(db, jun.id, '0000');
  assert.throws(() => verifyStaffPin(db, jun.id, '0000'), /Locked for/i);
  assert.strictEqual(verifyStaffPin(db, ana.id, '5555'), true); // unaffected
});

// -------------------------------------------------------------
// TOKENS
// -------------------------------------------------------------
dbTest('Session tokens: verify round-trip; tampering rejected; manager PIN change kills session', (db) => {
  const token = issueSessionToken(db, { type: 'manager', id: null, name: 'Manager' });
  const actor = verifySessionToken(db, token);
  assert.strictEqual(actor.type, 'manager');
  assert.strictEqual(actor.name, 'Manager');

  // Forged signature.
  const [body] = token.split('.');
  assert.strictEqual(verifySessionToken(db, `${body}.Zm9yZ2Vk`), null);
  // Garbage / missing token.
  assert.strictEqual(verifySessionToken(db, 'not-a-token'), null);
  assert.strictEqual(verifySessionToken(db, ''), null);

  // Wrong token type: an elevation token is not a session token.
  const elev = issueElevationToken(db);
  assert.strictEqual(verifySessionToken(db, elev.token), null);

  // Manager PIN change revokes the session (cred fingerprint).
  updateManagerPin(db, '1234', '5678');
  assert.strictEqual(verifySessionToken(db, token), null);
});

// M6: PBKDF2 hashing with legacy-format acceptance and transparent upgrade.
dbTest('PIN hashing: PBKDF2 format, legacy rows still verify and upgrade on login', (db) => {
  const { hashPin, legacyHashPin, verifyPinHash } = require('../src/auth');

  // New hashes are salted PBKDF2 and never collide for the same PIN.
  const h1 = hashPin('5678');
  const h2 = hashPin('5678');
  assert.match(h1, /^pbkdf2\$100000\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
  assert.notStrictEqual(h1, h2, 'salt makes PIN hashes unique');
  assert.strictEqual(verifyPinHash(h1, '5678').ok, true);
  assert.strictEqual(verifyPinHash(h1, '5679').ok, false);

  // Legacy single-sha256 rows (pre-PBKDF2 DBs) verify and flag an upgrade
  // (salted, so equality with a fresh hashPin() is impossible — check format).
  const legacy = legacyHashPin('1234');
  const res = verifyPinHash(legacy, '1234');
  assert.strictEqual(res.ok, true);
  assert.match(res.upgrade, /^pbkdf2\$100000\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
  assert.strictEqual(verifyPinHash(legacy, '9999').ok, false);

  // The default-PIN DB row (legacy format, seeded by db.js) upgrades on login.
  const { verifyManagerPin } = require('../src/auth');
  assert.strictEqual(verifyManagerPin(db, '1234'), true);
  assert.match(db.prepare("SELECT value FROM shop_settings WHERE key = 'manager_pin_hash'").get().value, /^pbkdf2\$/);
  // Upgraded hash still verifies (post-upgrade login).
  assert.strictEqual(verifyManagerPin(db, '1234'), true);
});

// H2: audit rows and stock movements carry ISO-with-Z timestamps (SQLite's
// bare CURRENT_TIMESTAMP is zone-less UTC; V8 reads it as local time).
dbTest('Audit and movement timestamps are ISO 8601 with a Z suffix', (db) => {
  const { audit } = require('../src/audit');
  const { createInventoryItem } = require('../src/inventory');
  audit(db, { type: 'manager', id: null, name: 'M' }, false, 'system', 'probe', {});
  const ts = db.prepare('SELECT created_at FROM audit_log ORDER BY id DESC LIMIT 1').get().created_at;
  assert.match(ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

  createInventoryItem(db, { brand: 'A', model_name: 'B', part_type: 'C', stock_quantity: 1 });
  const mv = db.prepare('SELECT created_at FROM stock_movements ORDER BY id DESC LIMIT 1').get().created_at;
  assert.match(mv, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

dbTest('Elevation tokens: valid now, dead after 15 minutes and after PIN change', (db) => {
  const elev = issueElevationToken(db);
  assert.strictEqual(verifyElevationToken(db, elev.token), true);
  assert.ok(elev.expiresAt - Date.now() <= 15 * 60 * 1000 + 1000);
  assert.ok(elev.expiresAt > Date.now());

  // Travel 16 minutes into the future: expired.
  const realNow = Date.now;
  Date.now = () => realNow() + 16 * 60 * 1000;
  try {
    assert.strictEqual(verifyElevationToken(db, elev.token), false);
  } finally {
    Date.now = realNow;
  }

  // A PIN change revokes outstanding elevation tokens too.
  updateManagerPin(db, '1234', '5678');
  assert.strictEqual(verifyElevationToken(db, elev.token), false);
});

// -------------------------------------------------------------
// AUDIT LOG
// -------------------------------------------------------------
dbTest('audit_log is append-only: UPDATE and DELETE both throw', (db) => {
  db.prepare(`
    INSERT INTO audit_log (actor_type, actor_name, category, action, detail, elevated)
    VALUES ('manager', 'Manager', 'system', 'test', '{}', 0)
  `).run();
  assert.throws(() => db.exec('UPDATE audit_log SET action = \'hacked\''), /append-only/);
  assert.throws(() => db.exec('DELETE FROM audit_log'), /append-only/);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS c FROM audit_log').get().c, 1);
});

serverTest('Permission matrix: 401 without session, 403 for staff without elevation, 200 with elevation', async (baseUrl, db, auth) => {
  // Create a part to mutate later.
  const mk = await post(`${baseUrl}/api/inventory`, { brand: 'Apple', model_name: 'X', part_type: 'LCD', cost_price: 1, price_retail: 2, stock_quantity: 5 }, auth);
  const part = await j(mk);
  // A cash sale to refund against.
  const sale = await j(await post(`${baseUrl}/api/sales`, {
    customer_name: 'Refund Test', items: [{ inventory_id: part.id, quantity: 1, unit_price: 2 }], amount_paid: 2
  }, auth));

  // 1. No session at all → 401 (login namespace exempt).
  assert.strictEqual((await fetch(`${baseUrl}/api/inventory`)).status, 401);
  assert.strictEqual((await post(`${baseUrl}/api/sales`, { items: [{ item_type: 'labor', item_name: 'x', unit_price: 1, quantity: 1 }] })).status, 401);

  // 2. Staff session. (Roster fetch is session-gated since M4.)
  createStaff(db, 'Jun', '4321');
  const staffList = await j(await fetch(`${baseUrl}/api/auth/staff`, { headers: auth }));
  const sLogin = await staffLogin(baseUrl, staffList[0].id, '4321');
  assert.strictEqual(sLogin.res.status, 200);
  assert.strictEqual(sLogin.data.actor.type, 'staff');
  const sAuth = { Authorization: `Bearer ${sLogin.data.token}` };
  const jBody = { 'Content-Type': 'application/json' };

  // Staff allowed...
  assert.strictEqual((await fetch(`${baseUrl}/api/inventory`, { headers: sAuth })).status, 200);

  // Staff blocked: elevation_required (403 + code).
  const blocked = [
    post(`${baseUrl}/api/sales/${sale.id}/returns`, { sale_item_id: sale.items[0].id, return_type: 'replacement', return_reason: 'other' }, { ...sAuth, ...jBody }),
    post(`${baseUrl}/api/sales/${sale.id}/returns`, { sale_item_id: sale.items[0].id, return_type: 'credit_refund' }, { ...sAuth, ...jBody }),
    post(`${baseUrl}/api/sales/${sale.id}/returns`, { sale_item_id: sale.items[0].id, return_type: 'cash_refund' }, { ...sAuth, ...jBody }),
    post(`${baseUrl}/api/inventory/${part.id}/adjust-stock`, { delta: 1, reason: 'receive' }, { ...sAuth, ...jBody }),
    post(`${baseUrl}/api/inventory`, { brand: 'A', model_name: 'B', part_type: 'C' }, { ...sAuth, ...jBody }),
    fetch(`${baseUrl}/api/inventory/${part.id}`, { method: 'PUT', headers: { ...sAuth, ...jBody }, body: JSON.stringify({ price_retail: 9 }) }),
    fetch(`${baseUrl}/api/inventory/${part.id}`, { method: 'DELETE', headers: sAuth }),
    fetch(`${baseUrl}/api/inventory/${part.id}/archive`, { method: 'POST', headers: sAuth }),
    post(`${baseUrl}/api/inventory/import`, { rows: [{ brand: 'A', model_name: 'B', part_type: 'C', stock_quantity: 1 }] }, { ...sAuth, ...jBody }),
    fetch(`${baseUrl}/api/inventory/export`, { headers: sAuth }),
    fetch(`${baseUrl}/api/dashboard`, { headers: sAuth }),
    post(`${baseUrl}/api/settings`, { gcash_name: 'Hijack' }, { ...sAuth, ...jBody }),
    post(`${baseUrl}/api/settings/reset-demo`, {}, { ...sAuth, ...jBody }),
    fetch(`${baseUrl}/api/backup`, { method: 'POST', headers: sAuth }),
    fetch(`${baseUrl}/api/export/sales.csv`, { headers: sAuth }),
    fetch(`${baseUrl}/api/export/customers.csv`, { headers: sAuth }),
    fetch(`${baseUrl}/api/audit`, { headers: sAuth }),
    fetch(`${baseUrl}/api/system/shutdown`, { method: 'POST', headers: sAuth }), // must NOT shut the server down
    post(`${baseUrl}/api/auth/change-pin`, { old_pin: '1234', new_pin: '9999' }, { ...sAuth, ...jBody })
  ];
  for (const p of blocked) {
    const res = await p;
    assert.strictEqual(res.status, 403, `${res.url} should be elevation-gated for staff`);
    assert.strictEqual((await j(res)).code, 'elevation_required');
  }

  // Cash refund and credit refund both blocked for staff: every RMA type
  // moves stock or money.
  const sale2 = await j(await post(`${baseUrl}/api/sales`, {
    customer_name: 'Cash Refund Test', items: [{ inventory_id: part.id, quantity: 1, unit_price: 2 }], amount_paid: 2
  }, auth));
  assert.strictEqual((await post(`${baseUrl}/api/sales/${sale2.id}/returns`, { sale_item_id: sale2.items[0].id, return_type: 'cash_refund', return_reason: 'other' }, { ...sAuth, ...jBody })).status, 403);
  const creditSale = await j(await post(`${baseUrl}/api/sales`, {
    customer_name: 'Credit Refund Test', payment_method: 'credit', items: [{ inventory_id: part.id, quantity: 1, unit_price: 2 }], amount_paid: 0
  }, auth));
  assert.strictEqual((await post(`${baseUrl}/api/sales/${creditSale.id}/returns`, { sale_item_id: creditSale.items[0].id, return_type: 'credit_refund', return_reason: 'other' }, { ...sAuth, ...jBody })).status, 403);

  // 3. Manager with elevation: everything unblocked (except change-pin's PIN
  // rules, not retested here).
  assert.strictEqual((await fetch(`${baseUrl}/api/dashboard`, { headers: auth })).status, 200);
  assert.strictEqual((await fetch(`${baseUrl}/api/audit`, { headers: auth })).status, 200);
  assert.strictEqual((await post(`${baseUrl}/api/sales/${sale2.id}/returns`, { sale_item_id: sale2.items[0].id, return_type: 'cash_refund', return_reason: 'other' }, { ...auth, ...jBody })).status, 201);

  // 4. Manager session WITHOUT elevation: 403, and a staff session is not enough.
  const mLogin = await managerLogin(baseUrl);
  const mNoElev = { Authorization: `Bearer ${mLogin.data.token}` };
  assert.strictEqual((await fetch(`${baseUrl}/api/dashboard`, { headers: mNoElev })).status, 403);
});

serverTest('Elevate endpoint: refused on the factory PIN, then correct PIN issues a token, wrong PIN is valid:false, lockout is 400', async (baseUrl, db) => {
  // 1234 is printed in the manual, so elevation granted against it is a
  // formality: the endpoint refuses the whole path until it is replaced.
  const factory = await post(`${baseUrl}/api/auth/elevate`, { pin: '1234' });
  assert.strictEqual(factory.status, 403);
  assert.strictEqual((await j(factory)).code, 'elevation_required');

  // Leave the factory state through the self-authenticating change-pin route.
  const changed = await post(`${baseUrl}/api/auth/change-pin`, { old_pin: '1234', new_pin: '4321' });
  assert.strictEqual(changed.status, 200);
  await j(changed);

  const bad = await post(`${baseUrl}/api/auth/elevate`, { pin: '9999' });
  assert.strictEqual(bad.status, 200);
  assert.strictEqual((await j(bad)).valid, false);

  const ok = await post(`${baseUrl}/api/auth/elevate`, { pin: '4321' });
  assert.strictEqual(ok.status, 200);
  const data = await j(ok);
  assert.strictEqual(data.valid, true);
  assert.ok(data.elevationToken);
  assert.ok(data.expiresAt > Date.now());

  // The elevation token actually authorizes.
  const login = await post(`${baseUrl}/api/auth/login`, { pin: '4321' });
  assert.strictEqual((await fetch(`${baseUrl}/api/dashboard`, { headers: { 'X-Elevation': data.elevationToken, Authorization: `Bearer ${(await j(login)).token}` } })).status, 200);

  // Burn the manager lockout: 400 with the lockout message (same shapes as
  // /api/report/login), and login matches.
  for (let i = 0; i < 5; i++) await post(`${baseUrl}/api/auth/elevate`, { pin: '0000' });
  const locked = await post(`${baseUrl}/api/auth/elevate`, { pin: '4321' });
  assert.strictEqual(locked.status, 400);
  assert.match((await j(locked)).error, /locked for/i);
});

serverTest('Login audits success and failure; audit rows carry the server-derived actor', async (baseUrl, db, auth) => {
  createStaff(db, 'Jun', '4321');
  const staffList = await j(await fetch(`${baseUrl}/api/auth/staff`, { headers: auth }));

  // Failed staff login (wrong PIN) is audited with the attempted identity.
  const fail = await staffLogin(baseUrl, staffList[0].id, '0000');
  assert.strictEqual(fail.res.status, 200);
  assert.strictEqual(fail.data.valid, false);
  assert.strictEqual(fail.data.token, undefined);

  // Unknown staff id: valid:false, nothing audited under a name.
  const unknown = await staffLogin(baseUrl, 999, '4321');
  assert.strictEqual(unknown.res.status, 200);
  assert.strictEqual(unknown.data.valid, false);

  // Wrong manager PIN → valid:false.
  const mgrBad = await post(`${baseUrl}/api/auth/login`, { pin: '0000' });
  assert.strictEqual((await j(mgrBad)).valid, false);

  // Manager login succeeds and auto-elevates.
  const mgr = await managerLogin(baseUrl);
  assert.ok(mgr.data.elevationToken, 'manager login counts as a fresh PIN entry');
  assert.ok(mgr.data.token);

  // A staff sale through the API: audit row names the staff actor, not the client.
  const part = await j(await post(`${baseUrl}/api/inventory`, { brand: 'A', model_name: 'B', part_type: 'C', stock_quantity: 5 }, auth));
  const sLogin = await staffLogin(baseUrl, staffList[0].id, '4321');
  const sAuth = { Authorization: `Bearer ${sLogin.data.token}`, 'Content-Type': 'application/json' };
  const sale = await post(`${baseUrl}/api/sales`, {
    customer_name: 'Attributed', items: [{ inventory_id: part.id, quantity: 1, unit_price: 2 }], amount_paid: 2
  }, sAuth);
  assert.strictEqual(sale.status, 201);

  const auditRes = await fetch(`${baseUrl}/api/audit?days=0`, { headers: auth });
  assert.strictEqual(auditRes.status, 200);
  const { rows, total } = await j(auditRes);
  assert.ok(total >= 5);

  const saleRow = rows.find(r => r.category === 'sale' && r.action === 'create');
  assert.ok(saleRow, 'sale audit row exists');
  assert.strictEqual(saleRow.actor_name, 'Jun');
  assert.strictEqual(saleRow.actor_type, 'staff');
  assert.strictEqual(saleRow.elevated, 0);
  assert.match(saleRow.detail, /Attributed/);

  const failedRows = rows.filter(r => r.action === 'login_failed');
  assert.ok(failedRows.length >= 2); // staff wrong-pin + manager wrong-pin
  assert.ok(failedRows.some(r => r.actor_name === 'Jun' && /staff_id/.test(r.detail)));

  const mgrLoginRow = rows.find(r => r.action === 'login' && r.actor_name === 'Manager');
  assert.ok(mgrLoginRow);
  assert.strictEqual(mgrLoginRow.elevated, 1);
});

serverTest('Audit filters: category and days narrow the view', async (baseUrl, db, auth) => {
  await post(`${baseUrl}/api/inventory`, { brand: 'A', model_name: 'B', part_type: 'C', stock_quantity: 1 }, auth);
  await fetch(`${baseUrl}/api/backup`, { method: 'POST', headers: auth });

  const all = await j(await fetch(`${baseUrl}/api/audit?days=0`, { headers: auth }));
  assert.ok(all.total >= 2);
  const inv = await j(await fetch(`${baseUrl}/api/audit?category=inventory&days=0`, { headers: auth }));
  assert.ok(inv.total >= 1);
  assert.ok(inv.rows.every(r => r.category === 'inventory'));
  // "days=1" still includes today's rows (SQLite day granularity).
  const today = await j(await fetch(`${baseUrl}/api/audit?days=1`, { headers: auth }));
  assert.strictEqual(today.total, all.total);
});

serverTest('Mutation failure leaves no audit row (atomicity at the API layer)', async (baseUrl, db, auth) => {
  auth = await ensurePinChanged(baseUrl, auth);
  const before = (await j(await fetch(`${baseUrl}/api/audit?days=0`, { headers: auth }))).total;
  const invBefore = (await j(await fetch(`${baseUrl}/api/inventory`, { headers: auth }))).length;

  // Invalid part (negative price): 400, no inventory row, no audit row.
  const bad = await post(`${baseUrl}/api/inventory`, { brand: 'A', model_name: 'B', part_type: 'C', price_retail: -5 }, auth);
  assert.strictEqual(bad.status, 400);

  // Invalid setting key mid-loop: whole settings POST rolls back.
  const badSettings = await post(`${baseUrl}/api/settings`, { gcash_name: 'Half', nope_unknown: 'x' }, auth);
  assert.strictEqual(badSettings.status, 400);
  const settingsNow = await j(await fetch(`${baseUrl}/api/settings`, { headers: auth }));
  assert.notStrictEqual(settingsNow.gcash_name, 'Half');

  const after = (await j(await fetch(`${baseUrl}/api/audit?days=0`, { headers: auth }))).total;
  const invAfter = (await j(await fetch(`${baseUrl}/api/inventory`, { headers: auth }))).length;
  assert.strictEqual(after, before);
  assert.strictEqual(invAfter, invBefore);
});

serverTest('Report routes keep working with only the report token (no session needed)', async (baseUrl) => {
  const login = await post(`${baseUrl}/api/report/login`, { pin: '1234' });
  const { token } = await j(login);
  const auth = { Authorization: `Bearer ${token}` };
  assert.strictEqual((await fetch(`${baseUrl}/api/report/stats`, { headers: auth })).status, 200);
  assert.strictEqual((await fetch(`${baseUrl}/api/report/sales`, { headers: auth })).status, 200);
  // Heartbeat stays open (no session): the auto-exit watchdog depends on it.
  assert.strictEqual((await post(`${baseUrl}/api/system/heartbeat`, {})).status, 200);
});

serverTest('Trial-locked workstation: /api/auth/login answers 200, commerce stays 402', async (baseUrl, db) => {
  db.prepare("INSERT OR REPLACE INTO shop_settings (key, value) VALUES ('first_run_ts', ?)")
    .run(new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString());

  const login = await managerLogin(baseUrl);
  assert.strictEqual(login.res.status, 200, 'login must stay reachable so the manager can activate/quit');
  assert.strictEqual((await fetch(`${baseUrl}/api/license/status`)).status, 200);
  assert.strictEqual((await fetch(`${baseUrl}/api/inventory`, { headers: { Authorization: `Bearer ${login.data.token}` } })).status, 402);
});

// M4: the staff roster requires a session.
serverTest('Staff roster is session-gated (no pre-login name oracle)', async (baseUrl, db, auth) => {
  createStaff(db, 'Jun', '4321');
  assert.strictEqual((await fetch(`${baseUrl}/api/auth/staff`)).status, 401);
  const list = await j(await fetch(`${baseUrl}/api/auth/staff`, { headers: auth }));
  assert.deepStrictEqual(list.map(s => s.name), ['Jun']);
});

// M3: elevation success/failure audited.
serverTest('Elevation attempts land in the audit log', async (baseUrl, db, auth) => {
  // Elevate refuses the factory PIN, so leave that state first. The change
  // rotates the elevation token, so re-login before reading the log back.
  await post(`${baseUrl}/api/auth/change-pin`, { old_pin: '1234', new_pin: '4321' });
  await post(`${baseUrl}/api/auth/elevate`, { pin: '9999' }); // failure
  await post(`${baseUrl}/api/auth/elevate`, { pin: '4321' }); // success
  const fresh = await j(await post(`${baseUrl}/api/auth/login`, { pin: '4321' }));
  const { rows } = await j(await fetch(`${baseUrl}/api/audit?category=security&days=0`, {
    headers: { Authorization: `Bearer ${fresh.token}`, 'X-Elevation': fresh.elevationToken }
  }));
  assert.ok(rows.some(r => r.action === 'elevate_failed' && r.elevated === 0), 'failed elevate audited');
  assert.ok(rows.some(r => r.action === 'elevate' && r.elevated === 1), 'successful elevate audited');
});

// M2: cost prices stripped from sale details for non-elevated staff.
serverTest('Sale details hide unit_cost from staff, show it to elevated sessions', async (baseUrl, db, auth) => {
  const part = await j(await post(`${baseUrl}/api/inventory`, { brand: 'A', model_name: 'B', part_type: 'C', cost_price: 12.5, price_retail: 30, stock_quantity: 2 }, auth));
  const sale = await j(await post(`${baseUrl}/api/sales`, {
    customer_name: 'Cost Strip', items: [{ inventory_id: part.id, quantity: 1, unit_price: 30 }], amount_paid: 30
  }, auth));
  assert.strictEqual(sale.items[0].unit_cost, 12.5, 'creating session is elevated: cost present');

  createStaff(db, 'Jun', '4321');
  const staffList = await j(await fetch(`${baseUrl}/api/auth/staff`, { headers: auth }));
  const sLogin = await staffLogin(baseUrl, staffList[0].id, '4321');
  const sAuth = { Authorization: `Bearer ${sLogin.data.token}` };

  const staffView = await j(await fetch(`${baseUrl}/api/sales/${sale.id}`, { headers: sAuth }));
  assert.strictEqual(staffView.items[0].unit_cost, null, 'staff sees no unit_cost');

  const mgrView = await j(await fetch(`${baseUrl}/api/sales/${sale.id}`, { headers: auth }));
  assert.strictEqual(mgrView.items[0].unit_cost, 12.5, 'manager keeps unit_cost');
});

// M2b: the same strip must cover the OTHER routes that carry sale items —
// the POST /api/sales response and the customer ledger's embedded sales.
serverTest('Sale creation response and customer ledger also hide unit_cost from staff', async (baseUrl, db, auth) => {
  const part = await j(await post(`${baseUrl}/api/inventory`, { brand: 'A', model_name: 'B', part_type: 'C', cost_price: 12.5, price_retail: 30, stock_quantity: 2 }, auth));

  createStaff(db, 'Jun', '4321');
  const staffList = await j(await fetch(`${baseUrl}/api/auth/staff`, { headers: auth }));
  const sLogin = await staffLogin(baseUrl, staffList[0].id, '4321');
  const sAuth = { Authorization: `Bearer ${sLogin.data.token}` };

  const sale = await j(await post(`${baseUrl}/api/sales`, {
    customer_name: 'Cost Strip 2', items: [{ inventory_id: part.id, quantity: 1, unit_price: 30 }], amount_paid: 30
  }, sAuth));
  assert.strictEqual(sale.items[0].unit_cost, null, 'sale creation response carries no unit_cost for staff');

  const ledger = await j(await fetch(`${baseUrl}/api/customers/${encodeURIComponent('Cost Strip 2')}`, { headers: sAuth }));
  assert.strictEqual(ledger.sales[0].items[0].unit_cost, null, 'customer ledger carries no unit_cost for staff');
});

serverTest('Staff inventory reads hide cost and checkout cannot forge a part price', async (baseUrl, db, auth) => {
  const part = await j(await post(`${baseUrl}/api/inventory`, {
    brand: 'Server', model_name: 'Priced', part_type: 'LCD', sku_barcode: 'SAFE-PRICE-1',
    cost_price: 12.5, price_retail: 30, price_technician: 24, stock_quantity: 3
  }, auth));
  createStaff(db, 'Price Clerk', '4321');
  const staffList = await j(await fetch(`${baseUrl}/api/auth/staff`, { headers: auth }));
  const clerk = staffList.find(s => s.name === 'Price Clerk');
  const sLogin = await staffLogin(baseUrl, clerk.id, '4321');
  const sAuth = { Authorization: `Bearer ${sLogin.data.token}` };

  const inventory = await j(await fetch(`${baseUrl}/api/inventory`, { headers: sAuth }));
  assert.strictEqual(inventory.find(i => i.id === part.id).cost_price, null);
  const barcode = await j(await fetch(`${baseUrl}/api/inventory/barcode/SAFE-PRICE-1`, { headers: sAuth }));
  assert.strictEqual(barcode.cost_price, null);

  const sale = await j(await post(`${baseUrl}/api/sales`, {
    customer_name: 'No Forgery', customer_type: 'retail', payment_method: 'cash',
    items: [{ inventory_id: part.id, quantity: 1, unit_price: 0.01 }], amount_paid: 30
  }, sAuth));
  assert.strictEqual(sale.total_amount, 30);
  assert.strictEqual(sale.items[0].unit_price, 30);
  assert.strictEqual(sale.items[0].unit_cost, null);

  const managerInventory = await j(await fetch(`${baseUrl}/api/inventory`, { headers: auth }));
  assert.strictEqual(managerInventory.find(i => i.id === part.id).cost_price, 12.5);
});

// M1: CSV import writes per-row before/after audit detail.
serverTest('CSV import audits per-row price and stock changes', async (baseUrl, db, auth) => {
  auth = await ensurePinChanged(baseUrl, auth); // import refuses the factory PIN
  await post(`${baseUrl}/api/inventory`, { brand: 'Oppo', model_name: 'A78', part_type: 'LCD', sku_barcode: 'MP-1', cost_price: 40, price_retail: 90, stock_quantity: 3 }, auth);
  await post(`${baseUrl}/api/inventory/import`, {
    rows: [
      { sku_barcode: 'MP-1', price_retail: '95', stock_quantity: '2' },
      { brand: 'Vivo', model_name: 'Y27', part_type: 'LCD', stock_quantity: '4' }
    ]
  }, auth);

  const { rows } = await j(await fetch(`${baseUrl}/api/audit?category=inventory&days=0`, { headers: auth }));
  // Row 1 updated via SKU: adjust_stock row (stock 3→5) and update row (retail 90→95).
  const upd = rows.find(r => r.action === 'update');
  assert.ok(upd, 'import update audited with before/after');
  const detail = JSON.parse(upd.detail);
  assert.strictEqual(detail.before.price_retail, 90);
  assert.strictEqual(detail.after.price_retail, 95);
  const adj = rows.find(r => r.action === 'adjust_stock');
  assert.ok(adj, 'import stock delta audited');
  assert.strictEqual(JSON.parse(adj.detail).delta, 2);
});
