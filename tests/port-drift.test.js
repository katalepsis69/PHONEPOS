// phone-repair-pos/tests/port-drift.test.js
// Regression: Windows reports "port held by another program" as EACCES at least
// as often as EADDRINUSE (a 0.0.0.0 holder blocks a 127.0.0.1 bind, Hyper-V/WSL
// reserve ranges). The old drift loop only handled EADDRINUSE, so the app died
// instantly whenever anything else owned port 3000 — "the app doesn't even open".
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

// Real port numbers, not listen(0): the point is the collision itself. 39991
// sits outside the 1024-15000 dynamic range where some ports refuse fetch().
const HELD_PORT = 39991;
const DRIFT_PORT = HELD_PORT + 1;

async function bodyOn(port, pathname = '/') {
  try {
    const res = await fetch(`http://127.0.0.1:${port}${pathname}`, { signal: AbortSignal.timeout(1500) });
    return { status: res.status, body: await res.text() };
  } catch (_) { return null; }
}

test('server survives a held preferred port (EACCES) by drifting to the next port', async () => {
  // bun.exe-style holder: bound on 0.0.0.0, so the POS's 127.0.0.1 bind on the
  // same port surfaces as EACCES on Windows (the exact field failure).
  const holder = http.createServer((_req, res) => res.end('not the pos'));
  await new Promise(resolve => holder.listen(HELD_PORT, '0.0.0.0', resolve));

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 't_port_drift-'));
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(HELD_PORT),
      NO_AUTO_BROWSER: '1',
      NO_AUTO_EXIT: '1',
      NODE_ENV: 'test',
      POS_DB_PATH: path.join(tmp, 'shop.db'),
      POS_BACKUP_DIR: path.join(tmp, 'backups')
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', d => { output += d; });
  child.stderr.on('data', d => { output += d; });

  try {
    // The holder must NOT answer as the POS, and the drifted server must.
    const held = await bodyOn(HELD_PORT);
    assert.strictEqual(held.status, 200);
    assert.match(held.body, /not the pos/); // sanity: it is the holder, not a POS on 39991

    let drift = null;
    for (let i = 0; i < 40 && (drift === null || !/<!DOCTYPE html/i.test(drift.body)); i++) {
      await new Promise(r => setTimeout(r, 250));
      drift = await bodyOn(DRIFT_PORT);
    }
    // The POS serves the counter SPA on the drifted port; the holder never can.
    assert.ok(drift, 'nothing answered on the drifted port');
    assert.match(drift.body, /<!DOCTYPE html/i);
    assert.match(output, /busy or blocked/);
    assert.doesNotMatch(output, /Fatal Server Error/);
  } finally {
    child.kill();
    await new Promise(resolve => holder.close(resolve));
    for (const f of [path.join(tmp, 'shop.db'), `${path.join(tmp, 'shop.db')}-shm`, `${path.join(tmp, 'shop.db')}-wal`]) {
      try { fs.rmSync(f, { force: true, maxRetries: 3 }); } catch (_) {}
    }
    try { fs.rmSync(path.join(tmp, 'backups'), { recursive: true, force: true }); } catch (_) {}
    try { fs.rmdirSync(tmp); } catch (_) {}
  }
});
