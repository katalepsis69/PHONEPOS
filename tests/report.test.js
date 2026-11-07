// phone-repair-pos/tests/report.test.js
// Manager phone reports: /api/report/* namespace — token auth, gate rework,
// and license coverage. Fresh DB per test ships with the default PIN 1234.
const assert = require('node:assert');
const http = require('node:http');
const { serverTest } = require('./helper');

// undici's fetch silently drops forbidden headers (Host is one), so the
// gate tests need a raw node:http request that can spoof it.
function httpRequest(baseUrl, { path, method = 'GET', headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl);
    const opts = {
      hostname: u.hostname,
      port: u.port,
      path,
      method,
      headers: { ...headers }
    };
    const payload = body === null ? null : JSON.stringify(body);
    if (payload !== null) {
      opts.headers['Content-Type'] = opts.headers['Content-Type'] || 'application/json';
      opts.headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = http.request(opts, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { raw += c; });
      res.on('end', () => resolve({ status: res.statusCode, text: raw, json: () => JSON.parse(raw) }));
    });
    req.on('error', reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

async function login(baseUrl, pin) {
  const res = await fetch(`${baseUrl}/api/report/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin })
  });
  return { status: res.status, data: await res.json() };
}

serverTest('Report login: correct PIN issues a token, wrong PIN returns valid:false', async (baseUrl) => {
  const ok = await login(baseUrl, '1234');
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(ok.data.valid, true);
  assert.ok(ok.data.token);
  assert.match(ok.data.token, /^[0-9a-f]{64}$/); // 32 random bytes, hex

  const bad = await login(baseUrl, '9999');
  assert.strictEqual(bad.status, 200);
  assert.strictEqual(bad.data.valid, false);
  assert.strictEqual(bad.data.token, undefined);

  // Same token on re-login (persisted, not minted per request).
  const again = await login(baseUrl, '1234');
  assert.strictEqual(again.data.token, ok.data.token);

  // The token is private material: /api/settings must not leak it to the POS UI.
  const settings = await (await fetch(`${baseUrl}/api/settings`)).json();
  assert.strictEqual(settings.report_token, undefined);
});

serverTest('Report data routes are Bearer-token gated', async (baseUrl) => {
  // Without a token: 401 even though the request is localhost-sourced.
  const noToken = await fetch(`${baseUrl}/api/report/stats`);
  assert.strictEqual(noToken.status, 401);

  const { data } = await login(baseUrl, '1234');
  const auth = { Authorization: `Bearer ${data.token}` };

  // Wrong token: 401.
  const wrongToken = await fetch(`${baseUrl}/api/report/stats`, {
    headers: { Authorization: 'Bearer ' + '0'.repeat(64) }
  });
  assert.strictEqual(wrongToken.status, 401);

  // Correct token: full stats payload.
  const statsRes = await fetch(`${baseUrl}/api/report/stats`, { headers: auth });
  assert.strictEqual(statsRes.status, 200);
  const stats = await statsRes.json();
  assert.ok('today_sales_count' in stats);
  assert.ok('total_credit_outstanding' in stats);
  assert.ok(stats.generated_at);

  // Sales list: bare array.
  const salesRes = await fetch(`${baseUrl}/api/report/sales`, { headers: auth });
  assert.strictEqual(salesRes.status, 200);
  const sales = await salesRes.json();
  assert.ok(Array.isArray(sales));
  // No token → 401 on sales too.
  const salesNoToken = await fetch(`${baseUrl}/api/report/sales`);
  assert.strictEqual(salesNoToken.status, 401);
});

serverTest('Report tokens expire server-side and re-login rotates them', async (baseUrl, db) => {
  const first = await login(baseUrl, '1234');
  db.prepare("UPDATE shop_settings SET value = ? WHERE key = 'report_token_expires_at'").run(String(Date.now() - 1));
  const expired = await fetch(`${baseUrl}/api/report/stats`, {
    headers: { Authorization: `Bearer ${first.data.token}` }
  });
  assert.strictEqual(expired.status, 401);

  const renewed = await login(baseUrl, '1234');
  assert.ok(renewed.data.token);
  assert.notStrictEqual(renewed.data.token, first.data.token);
  assert.ok(Number(db.prepare("SELECT value FROM shop_settings WHERE key = 'report_token_expires_at'").get().value) > Date.now());
  assert.strictEqual((await fetch(`${baseUrl}/api/report/stats`, {
    headers: { Authorization: `Bearer ${renewed.data.token}` }
  })).status, 200);
});

serverTest('Host gate: report routes answer a ts.net Host, other APIs stay 403', async (baseUrl) => {
  const { data } = await login(baseUrl, '1234');
  const spoofedHost = 'pos.example.ts.net';

  // Spoofed Host on a regular commerce route: still confined to localhost.
  const confined = await httpRequest(baseUrl, {
    path: '/api/inventory',
    headers: { Host: spoofedHost }
  });
  assert.strictEqual(confined.status, 403);
  assert.match(confined.json().error, /Host/i);

  // Same spoofed Host on the report namespace: 200 with the Bearer token —
  // this is exactly what a reverse-proxied Host header looks like.
  const report = await httpRequest(baseUrl, {
    path: '/api/report/stats',
    headers: { Host: spoofedHost, Authorization: `Bearer ${data.token}` }
  });
  assert.strictEqual(report.status, 200);
  assert.ok('today_sales_count' in report.json());
});

serverTest('Report namespace enforces a same-origin POST gate', async (baseUrl) => {
  const body = { pin: '1234' };

  // Cross-origin POST (what a malicious website's form POST looks like):
  // browsers always attach Origin — burn-the-lockout attempts die here.
  const evil = await httpRequest(baseUrl, {
    path: '/api/report/login',
    method: 'POST',
    headers: { Origin: 'https://evil.com' },
    body
  });
  assert.strictEqual(evil.status, 403);

  // Same-origin Origin (built from the test's own base URL): passes.
  const sameOrigin = await httpRequest(baseUrl, {
    path: '/api/report/login',
    method: 'POST',
    headers: { Origin: baseUrl },
    body
  });
  assert.strictEqual(sameOrigin.status, 200);
  assert.ok(sameOrigin.json().token);

  // No Origin at all (curl, native apps): passes.
  const noOrigin = await httpRequest(baseUrl, {
    path: '/api/report/login',
    method: 'POST',
    body
  });
  assert.strictEqual(noOrigin.status, 200);
  assert.ok(noOrigin.json().token);
});

serverTest('PIN change revokes issued report tokens', async (baseUrl, db, auth) => {
  const first = await login(baseUrl, '1234');
  assert.ok(first.data.token);

  // change-pin requires manager elevation; the helper's login headers carry it.
  const changed = await fetch(`${baseUrl}/api/auth/change-pin`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ old_pin: '1234', new_pin: '5678' })
  });
  assert.strictEqual(changed.status, 200);
  const changeJson = await changed.json();
  assert.strictEqual(changeJson.success, true);
  assert.ok(changeJson.token, 'fresh session token handed back');

  // Old token: dead.
  const stale = await fetch(`${baseUrl}/api/report/stats`, {
    headers: { Authorization: `Bearer ${first.data.token}` }
  });
  assert.strictEqual(stale.status, 401);

  // New login works and mints a different token.
  const relogin = await login(baseUrl, '5678');
  assert.ok(relogin.data.token);
  assert.notStrictEqual(relogin.data.token, first.data.token);
  const fresh = await fetch(`${baseUrl}/api/report/stats`, {
    headers: { Authorization: `Bearer ${relogin.data.token}` }
  });
  assert.strictEqual(fresh.status, 200);
});

serverTest('License gate covers every /api/report/* route, login included', async (baseUrl, db) => {
  const { data } = await login(baseUrl, '1234');
  const auth = { Authorization: `Bearer ${data.token}` };

  // Force the 14-day trial into "ended" (15 days since first run).
  const fifteenDaysAgo = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString();
  db.prepare("INSERT OR REPLACE INTO shop_settings (key, value) VALUES ('first_run_ts', ?)").run(fifteenDaysAgo);

  const lockedLogin = await fetch(`${baseUrl}/api/report/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin: '1234' })
  });
  assert.strictEqual(lockedLogin.status, 402);
  assert.match((await lockedLogin.json()).error, /Trial ended/);

  const lockedStats = await fetch(`${baseUrl}/api/report/stats`, { headers: auth });
  assert.strictEqual(lockedStats.status, 402);

  const lockedSales = await fetch(`${baseUrl}/api/report/sales`, { headers: auth });
  assert.strictEqual(lockedSales.status, 402);
});

serverTest('Report login burns its own lockout window, never the register counter PIN', async (baseUrl, db) => {
  const reportLogin = pin => fetch(`${baseUrl}/api/report/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin })
  });
  for (let i = 0; i < 4; i++) {
    const r = await reportLogin('0000');
    assert.strictEqual(r.status, 200, 'wrong PIN answers valid:false until the window burns');
    await r.json();
  }
  const fifth = await reportLogin('0000');
  assert.strictEqual(fifth.status, 429, 'the fifth guess burns the window (lockout now surfaces as 429)');
  await fifth.json();
  const locked = await reportLogin('1234');
  assert.strictEqual(locked.status, 429);
  assert.match((await locked.json()).error, /locked for 900s/i, 'report namespace carries the long window');

  // Five guesses from a phone must not freeze the register's own PIN gate.
  // (The helper's login() targets /api/report/login, so post at the counter.)
  const counter = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: '1234' })
  });
  const counterData = await counter.json();
  assert.strictEqual(counter.status, 200);
  assert.ok(counterData.token, 'counter namespace unaffected');
});

serverTest('Report namespace refuses an off-box bind until the operator acknowledges it', async (baseUrl) => {
  const prevHost = process.env.HOST, prevAck = process.env.POS_LAN_REPORT_ACK;
  try {
    process.env.HOST = '0.0.0.0';
    delete process.env.POS_LAN_REPORT_ACK;
    const denied = await fetch(`${baseUrl}/api/report/stats`);
    assert.strictEqual(denied.status, 403);
    assert.match((await denied.json()).error, /POS_LAN_REPORT_ACK/);

    process.env.POS_LAN_REPORT_ACK = '1';
    const login = await fetch(`${baseUrl}/api/report/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: '1234' })
    });
    assert.strictEqual(login.status, 200);
    assert.ok((await login.json()).token, 'acknowledged bind serves reports as before');
  } finally {
    if (prevHost === undefined) delete process.env.HOST; else process.env.HOST = prevHost;
    if (prevAck === undefined) delete process.env.POS_LAN_REPORT_ACK; else process.env.POS_LAN_REPORT_ACK = prevAck;
  }
});

serverTest('Report PWA HTML and JS support 3-state freshness, replacement cost disclosure, light/dark toggle, and responsive layout', async (baseUrl) => {
  const fs = require('node:fs');
  const path = require('node:path');
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'report.html'), 'utf8');
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'report.js'), 'utf8');
  const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

  const shortRoute = await fetch(`${baseUrl}/report`);
  assert.strictEqual(shortRoute.status, 200);
  const fullRoute = await fetch(`${baseUrl}/report.html`);
  assert.strictEqual(fullRoute.status, 200);

  assert.match(html, /data-state="stale"/);
  assert.match(html, /id="btn-theme-toggle"/);
  assert.match(html, /Profit after returns/);
  assert.match(html, /id="st-refunded-meta"/);
  assert.match(html, /@media \(min-width: 760px\)/);
  assert.match(html, /id="rpt-tier-compare"/);
  assert.match(indexHtml, /id="settings-cloud-comparison"/);

  assert.match(js, /STALE_MAX_MS = 300000/);
  assert.match(js, /today_replacement_cost/);
  assert.match(js, /Sales appear here as the counter rings them up\./);
});
