// phone-repair-pos/tests/hardening-2026-11-13.test.js
// Test hardening pass 2026-11-13: the two API routes the route-coverage scan
// found with zero test references (/api/audit/verify, /api/auth/logout).
const assert = require('node:assert');
const { serverTest, ensurePinChanged } = require('./helper');

// The audit trail's hash chain is a project non-negotiable and the only tamper
// evidence the shop has, so the elevation-gated route that reads the verdict
// back must answer correctly in both directions. A function-level tamper test
// already exists; this pins the HTTP surface: 403 without a valid elevation
// token, the honest verdict, and end-to-end detection of a forged row.
serverTest('/api/audit/verify requires elevation and reports the chain honestly', async (base, db, auth) => {
  auth = await ensurePinChanged(base, auth);

  const denied = await fetch(`${base}/api/audit/verify`, { headers: { ...auth, 'X-Elevation': 'not-a-token' } });
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).code, 'elevation_required');

  const ok = await fetch(`${base}/api/audit/verify`, { headers: auth });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { ok: true, first_bad_id: null });

  // INSERT is allowed (the append-only trigger blocks UPDATE/DELETE), so the
  // realistic forgery is an added row with a made-up hash; the route must name
  // its id instead of answering ok.
  const forged = db.prepare(
    "INSERT INTO audit_log (created_at, actor_type, actor_name, category, action, detail, elevated, row_hash) VALUES (datetime('now'), 'manager', 'Forger', 'security', 'forged_action', '{}', 1, 'deadbeef')"
  ).run();
  const after = await fetch(`${base}/api/audit/verify`, { headers: auth });
  assert.equal(after.status, 200);
  const verdict = await after.json();
  assert.equal(verdict.ok, false);
  assert.equal(verdict.first_bad_id, Number(forged.lastInsertRowid));
});

// logout was the one auth route with zero coverage: every tab can reach it and
// it writes the security audit event the audit feed and chain verifier rely on.
serverTest('/api/auth/logout audits the session once and refuses anonymous calls', async (base, db, auth) => {
  const res = await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' } });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { success: true });

  const rows = db.prepare("SELECT actor_type, actor_name, category, action, elevated FROM audit_log WHERE action = 'logout'").all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].category, 'security');
  assert.equal(rows[0].elevated, 0);

  // The whole /api/auth/ namespace is sessionExempt, so a tab whose session
  // already expired can still log out cleanly: 200, and the route's
  // `if (session)` guard writes no audit row for it.
  const anon = await fetch(`${base}/api/auth/logout`, { method: 'POST' });
  assert.equal(anon.status, 200);
  assert.deepEqual(await anon.json(), { success: true });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'logout'").get().n, 1);
});
