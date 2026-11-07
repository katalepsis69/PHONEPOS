// scripts/deploy-cloud.js
// cloud-deploy/ is the edit source: it is synced INTO cloud/ (the local runtime
// mirror, which also holds data/) and pushed live to TechParts Live over HTTPS
// using the primary store owner's PIN.
// Usage: npm run deploy:cloud -- <owner-pin>   (or set CLOUD_PIN env var)
const fs = require('node:fs');
const path = require('node:path');

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

if (!pin) {
  console.log('[deploy:cloud] Local cloud-deploy/ synced. To push live over HTTPS, pass your Owner PIN:');
  console.log('  npm run deploy:cloud -- <your-pin>');
  process.exit(0);
}

(async () => {
  const loginRes = await fetch(`${baseUrl}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin })
  });
  const loginBody = await loginRes.json().catch(() => ({}));
  if (!loginRes.ok) {
    console.error(`[deploy:cloud] Login failed (${loginRes.status}): ${loginBody.error || 'wrong PIN'}`);
    process.exit(1);
  }
  const cookie = (loginRes.headers.get('set-cookie') || '').split(';')[0];
  const files = {};
  for (const rel of FILES) {
    files[rel] = fs.readFileSync(path.join(CLOUD_SRC, rel), 'utf8');
  }
  const depRes = await fetch(`${baseUrl}/api/deploy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
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
    process.exit(1);
  }
  const changed = depBody.updated && depBody.updated.length ? depBody.updated.join(', ') : 'already up to date';
  console.log(`[deploy:cloud] Live push to ${baseUrl} succeeded (${changed})${depBody.restarting ? ' [restarting server]' : ''}`);
})().catch(err => {
  console.error(`[deploy:cloud] Error: ${err.message}`);
  process.exit(1);
});
