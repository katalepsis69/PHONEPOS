// tests/cloud-hardening-harness.js — the spawned-cloud fixture shared by the
// cloud-hardening suite and the analytics parity harness. Extracted so the
// parity test drives the REAL cloud implementation instead of a copy of it.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const CLOUD_SERVER = path.join(ROOT, 'cloud', 'server.js');
const TOKEN_A = 'a'.repeat(64);
const TOKEN_B = 'b'.repeat(64);

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(err => err ? reject(err) : resolve(port));
    });
  });
}

function waitForServer(child) {
  return new Promise((resolve, reject) => {
    let output = '';
    // Keep the child's whole stdout/stderr on the child object too: tests
    // asserting on boot-time log lines need output from before "listening".
    child.outputTail = '';
    const timer = setTimeout(() => reject(new Error(`cloud server timeout: ${output}`)), 8000);
    const onData = chunk => {
      output += chunk;
      child.outputTail += String(chunk);
      const m = output.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/);
      if (output.includes('Cloud sync service listening') && m) {
        clearTimeout(timer);
        resolve(`http://127.0.0.1:${m[1]}`);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', code => {
      clearTimeout(timer);
      reject(new Error(`cloud server exited ${code}: ${output}`));
    });
  });
}

async function startCloud(dataDir, extraEnv = {}) {
  // PORT=0: the kernel picks a free port and the child reports the real one on
  // its listening line, which removes the reserve-then-release race entirely.
  const child = spawn(process.execPath, [CLOUD_SERVER], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: '0',
      HOST: '127.0.0.1',
      DATA_DIR: dataDir,
      SHOP_SYNC_CREDENTIALS: JSON.stringify({ north: TOKEN_A, south: TOKEN_B }),
      TRUST_PROXY: '1',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { child, base: await waitForServer(child) };
}

function stopCloud(child) {
  return new Promise(resolve => {
    if (child.exitCode !== null) return resolve();
    child.once('exit', resolve);
    child.kill();
    setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 2000).unref();
  });
}

function event(outboxId, table, localId, row, extra = {}) {
  return { outbox_id: outboxId, table, local_id: localId, row, ...extra };
}

async function sync(base, token, shopId, events) {
  // Name the URL on failure: a base with a bad port is invisible otherwise.
  return fetch(`${base}/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-sync-token': token },
    body: JSON.stringify({ shop_id: shopId, events }),
  }).catch(err => { throw new Error(`sync to ${base}/sync failed: ${err.cause ? err.cause.code : err.message}`); });
}

async function login(base, pin = '2468', forwardedFor = '198.51.100.10') {
  const res = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': forwardedFor },
    body: JSON.stringify({ pin }),
  });
  return { res, cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
}

module.exports = { ROOT, CLOUD_SERVER, TOKEN_A, TOKEN_B, reservePort, waitForServer, startCloud, stopCloud, event, sync, login };
