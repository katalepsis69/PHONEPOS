// scripts/deploy-cloud.js
// cloud-deploy/ is the edit source: it is synced INTO cloud/ (the local runtime
// mirror, which also holds data/) and pushed live to TechParts Live over HTTPS
// using the primary store owner's PIN.
// Usage: npm run deploy:cloud -- <owner-pin>   (or set CLOUD_PIN env var)
// With no argument the PIN is read from stdin (the bat pipes it): a PIN on the
// command line is visible in the Windows process list while the deploy runs.
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const ROOT = path.resolve(__dirname, '..');
const CLOUD_SRC = path.join(ROOT, 'cloud-deploy');
const CLOUD_MIRROR = path.join(ROOT, 'cloud');
const FILES = ['public/index.html', 'public/app.js', 'server.js'];

// 1. Always sync cloud-deploy/ -> cloud/ on disk, then upload the same bytes.
// The old direction copied cloud/ over cloud-deploy/ first, so an edit made in
// cloud-deploy/ was silently reverted and stale mirror code was pushed live.
fs.mkdirSync(path.join(CLOUD_MIRROR, 'public'), { recursive: true });
for (const rel of [...FILES, 'package.json']) {
  const src = path.join(CLOUD_SRC, rel);
  const dst = path.join(CLOUD_MIRROR, rel);
  if (fs.existsSync(src)) fs.copyFileSync(src, dst);
}
console.log('[deploy:cloud] Synced cloud-deploy/ -> cloud/ (mirror), uploading cloud-deploy/');

const pin = (process.argv[2] || process.env.CLOUD_PIN || '').trim();
const baseUrl = (process.env.CLOUD_URL || 'https://repairsync.bot-keep.xyz').replace(/\/+$/, '');

function readStdinPin() {
  return new Promise(resolve => {
    if (process.stdin.isTTY) {
      console.log('[deploy:cloud] Enter Cloud Owner PIN (or press Enter to sync local cloud-deploy/ only):');
    }
    const rl = readline.createInterface({ input: process.stdin, terminal: false });
    let line = '';
    rl.once('line', l => { line = l; rl.close(); });
    rl.once('close', () => resolve(line.trim()));
  });
}

// The override exists for testing against a local cloud instance; anything
// else rides HTTPS, because the body carries the owner PIN and full source.
{
  const host = (() => { try { return new URL(baseUrl).hostname; } catch (_) { return ''; } })();
  const loopback = ['localhost', '127.0.0.1', '::1'].includes(host);
  if (!loopback && !baseUrl.startsWith('https:')) {
    console.error(`[deploy:cloud] Refusing non-HTTPS target "${baseUrl}" (loopback http is allowed for local testing).`);
    process.exit(1);
  }
}

(async () => {
  const ownerPin = pin || await readStdinPin();
  if (!ownerPin) {
    console.log('[deploy:cloud] Local cloud-deploy/ synced. To push live over HTTPS, pass your Owner PIN:');
    console.log('  npm run deploy:cloud -- <your-pin>');
    return;
  }
  // Connection: close + exitCode instead of process.exit: exiting with a live
  // undici keep-alive socket fail-fasts on Windows (0xC0000409).
  const loginRes = await fetch(`${baseUrl}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Connection: 'close' },
    body: JSON.stringify({ pin: ownerPin })
  });
  const loginBody = await loginRes.json().catch(() => ({}));
  if (!loginRes.ok) {
    console.error(`[deploy:cloud] Login failed (${loginRes.status}): ${loginBody.error || 'wrong PIN'}`);
    process.exitCode = 1;
    return;
  }
  const cookie = (loginRes.headers.get('set-cookie') || '').split(';')[0];
  const files = {};
  for (const rel of FILES) {
    files[rel] = fs.readFileSync(path.join(CLOUD_SRC, rel), 'utf8');
  }
  const depRes = await fetch(`${baseUrl}/api/deploy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie, Connection: 'close' },
    body: JSON.stringify({ files })
  });
  const depBody = await depRes.json().catch(() => ({}));
  if (!depRes.ok) {
    if (depRes.status === 404) {
      console.error('[deploy:cloud] Server on Botkeep is still running the old server.js (404 /api/deploy).');
      console.error('  -> One-time step: upload cloud-deploy\\server.js to Botkeep and click Restart.');
      console.error('  -> Every update after that will push automatically via deploy-cloud.bat.');
    } else {
      console.error(`[deploy:cloud] Push failed (${depRes.status}): ${depBody.error || 'request rejected'}`);
    }
    process.exitCode = 1;
    return;
  }
  const changed = depBody.updated && depBody.updated.length ? depBody.updated.join(', ') : 'already up to date';
  console.log(`[deploy:cloud] Live push to ${baseUrl} succeeded (${changed})${depBody.restarting ? ' [restarting server]' : ''}`);
})().catch(err => {
  console.error(`[deploy:cloud] Error: ${err.message}`);
  process.exitCode = 1;
});
