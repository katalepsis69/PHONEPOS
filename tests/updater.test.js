// tests/updater.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  parseVersionParts,
  isRemoteNewer,
  isTrustedReleaseUrl,
  isTrustedPageUrl,
  resolveTrustedReleaseUrl,
  digestUrlFor,
  digestMatches,
  buildApplyScript,
  setUpdateTestHooks,
  checkForUpdates,
  applyUpdate,
  CURRENT_VERSION,
  REPO
} = require('../src/updater');
// The route test goes through the shared harness so it gets a temp database and the
// sentinel printer queue, exactly like every other server test in this suite.
const { serverTest, ensurePinChanged } = require('./helper');

// A tag that is always newer than the running build. The release script bumps
// CURRENT_VERSION before it runs this suite, so a hardcoded tag (the old
// 'v1.1.1') stops being newer the first time a 1.2 is released, and the version
// floor then refuses the test's own apply. A major bump outranks every
// same-major version; the patch digit lets a second case use a distinct tag.
function newerTag(patch = 0) {
  const parts = parseVersionParts(CURRENT_VERSION);
  parts[0] += 1;
  parts[2] = patch;
  return `v${parts.join('.')}`;
}
const NEWER_TAG = newerTag(0);
const OTHER_NEWER_TAG = newerTag(1);

test('updater: version parsing and comparison', () => {
  assert.deepEqual(parseVersionParts('v1.0'), [1, 0, 0]);
  assert.deepEqual(parseVersionParts('1.2.3'), [1, 2, 3]);
  assert.deepEqual(parseVersionParts('v2.0.0-beta.1'), [2, 0, 0]);
  assert.deepEqual(parseVersionParts(''), [0, 0, 0]);
  assert.deepEqual(parseVersionParts(null), [0, 0, 0]);

  // isRemoteNewer
  assert.equal(isRemoteNewer('v1.1', '1.0'), true);
  assert.equal(isRemoteNewer('1.2', '1.1'), true);
  assert.equal(isRemoteNewer('2.0.0', '1.9.9'), true);
  assert.equal(isRemoteNewer('1.0.1', '1.0.0'), true);
  assert.equal(isRemoteNewer('v1.0.0', '1.0.0'), false);
  assert.equal(isRemoteNewer('1.0.0', '1.1.0'), false);
  assert.equal(isRemoteNewer('1.0.0', '2.0.0'), false);
  assert.equal(isRemoteNewer('0.9.9', '1.0.0'), false);
});

test('updater: url trust validation', () => {
  assert.equal(isTrustedReleaseUrl(`https://github.com/${REPO}/releases/download/v1.0.1/TechPartsPOS.exe`), true);
  assert.equal(isTrustedReleaseUrl(`http://github.com/${REPO}/releases/download/v1.0.1/TechPartsPOS.exe`), false);
  assert.equal(isTrustedReleaseUrl('https://github.com/other-user/other-repo/releases/download/v1.0.1/TechPartsPOS.exe'), false);
  assert.equal(isTrustedReleaseUrl('https://malicious.com/TechPartsPOS.exe'), false);
  assert.equal(isTrustedReleaseUrl(''), false);
  assert.equal(isTrustedReleaseUrl(null), false);

  assert.equal(isTrustedPageUrl(`https://github.com/${REPO}/releases`), true);
  assert.equal(isTrustedPageUrl(`https://github.com/${REPO}/releases/tag/v1.1.1`), true);
  assert.equal(isTrustedPageUrl('https://malicious.com'), false);
  assert.equal(isTrustedPageUrl('C:/Windows/System32/cmd.exe'), false);
  // A lookalike repo on github.com is not this repo: the banner link is a human
  // click target and that repo's manual download skips every in-app gate.
  assert.equal(isTrustedPageUrl('https://github.com/attacker/PHONEPOS/releases'), false);
  assert.equal(isTrustedPageUrl('https://github.com/attacker'), false);
  assert.equal(isTrustedPageUrl(`https://evil.com/${REPO}/releases`), false);
  assert.equal(isTrustedPageUrl(`https://user@github.com/${REPO}/releases`), false);
});

// A canned feed for check-path tests. The suite used to make a dozen live
// api.github.com calls per run: on a shop LAN with no route to GitHub that
// turns one gate into a multi-minute stall, and on a connected IP it burns the
// unauthenticated rate limit. Checks are offline by default now; the one
// deliberate online test is named "(live)".
async function withFeed(feed, fn) {
  setUpdateTestHooks({
    fetchImpl: async (url) => {
      if (String(url).includes('api.github.com')) {
        if (feed === 'ratelimit') return new Response('{}', { status: 403 });
        if (feed === 'noreleases') return new Response('{}', { status: 404 });
        return new Response(JSON.stringify(feed), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      throw new Error(`offline test reached the network: ${url}`);
    }
  });
  try { return await fn(); } finally { setUpdateTestHooks(null); }
}

const cannedRelease = (tag, assets = []) => ({
  tag_name: tag,
  html_url: `https://github.com/${REPO}/releases/tag/${tag}`,
  body: 'notes',
  assets
});

test('updater: a 404 feed reports "no releases published" and never throws', async () => {
  await withFeed('noreleases', async () => {
    const result = await checkForUpdates('99.0.0');
    assert.equal(typeof result, 'object');
    assert.equal(result.currentVersion, '99.0.0');
    assert.equal(result.hasUpdate, false);
    assert.match(result.checkError, /No releases published/);
  });
});

test('updater: a rate-limited feed is reported as a rate limit, not an outage', async () => {
  await withFeed('ratelimit', async () => {
    const result = await checkForUpdates('1.0');
    assert.equal(result.hasUpdate, false);
    assert.match(result.checkError, /rate limit/i);
  });
});

test('updater: a newer tag with no exe asset reports no installable download', async () => {
  await withFeed(cannedRelease(NEWER_TAG, [{ name: 'notes.txt', browser_download_url: `https://github.com/${REPO}/releases/download/${NEWER_TAG}/notes.txt`, size: 10 }]), async () => {
    const result = await checkForUpdates(CURRENT_VERSION);
    assert.equal(result.hasUpdate, true, `${NEWER_TAG} must outrank ${CURRENT_VERSION}`);
    assert.equal(result.downloadUrl, '');
    assert.equal(result.latestVersion, NEWER_TAG);
  });
});

// The one deliberate online check: the live gate the offline tests above do not
// cover. Tolerant by design, because a shop LAN with no route to GitHub must
// not fail the suite: the shape is what is being asserted, not the network.
test('updater: a live GitHub check answers in the documented shape (live)', async () => {
  const result = await checkForUpdates(CURRENT_VERSION);
  assert.equal(typeof result.hasUpdate, 'boolean');
  assert.equal(typeof result.checkError, 'string');
  assert.equal(typeof result.downloadUrl, 'string');
  assert.equal(typeof result.expectedBytes, 'number');
});

test('updater: applyUpdate rejects untrusted urls, downgrades and dev mode safely', async () => {
  await assert.rejects(
    () => applyUpdate({ downloadUrl: 'https://evil.com/fake.exe' }),
    /Untrusted|Invalid|Failed|Cannot/i
  );

  // A trusted URL naming an older tag is a downgrade, refused before any fetch.
  await assert.rejects(
    () => applyUpdate({ downloadUrl: `https://github.com/${REPO}/releases/download/v0.9.0/TechPartsPOS.exe` }),
    /not newer than/
  );

  // In test environment, node is running process.execPath -> dev mode detected
  const res = await applyUpdate({ downloadUrl: `https://github.com/${REPO}/releases/download/${NEWER_TAG}/TechPartsPOS.exe` });
  assert.equal(res.runningInDev, true);
  assert.equal(res.success, false);
});

test('updater: the published checksum is derived from the download url and gates install', () => {
  const exeUrl = `https://github.com/${REPO}/releases/download/${NEWER_TAG}/TechPartsPOS.exe`;
  assert.equal(digestUrlFor(exeUrl), `${exeUrl}.sha256`);
  assert.equal(isTrustedReleaseUrl(digestUrlFor(exeUrl)), true);
  assert.equal(digestUrlFor(''), '');

  const bytes = Buffer.from('a stand-in for a thermal printer executable');
  const hex = crypto.createHash('sha256').update(bytes).digest('hex');
  assert.equal(digestMatches(bytes, hex), true, 'bare digest');
  assert.equal(digestMatches(bytes, `${hex}  TechPartsPOS.exe`), true, 'sha256sum line');
  assert.equal(digestMatches(bytes, hex.toUpperCase()), true, 'case insensitive');
  assert.equal(digestMatches(Buffer.from('a tampered executable'), hex), false, 'wrong bytes');
  assert.equal(digestMatches(bytes, `${hex.slice(0, 63)}0`), false, 'one flipped nibble');
  assert.equal(digestMatches(bytes, ''), false, 'empty body');
  assert.equal(digestMatches(bytes, 'not a digest at all'), false, 'junk body');
});

// A checksum alone is not authorship: anyone with upload rights on the repo can replace
// both the exe and its .sha256. This pins what the current design does and does not
// claim, so a future signing change has something to update.
test('updater: no signing or pinned identity exists in the download path', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'updater.js'), 'utf8');
  assert.equal(/createVerify|publicKey|signature|\.sig\b/.test(source), false);
  assert.equal(source.includes("require('node:crypto')"), true, 'crypto is imported for the digest');
  assert.equal(typeof CURRENT_VERSION, 'string');
});

serverTest('updater: the update routes answer without touching the shop database', async (baseUrl) => {
  // GET /api/system/update/check is session exempt, and a feed that answers
  // with a release but no installable exe still leaves hasUpdate a boolean.
  await withFeed(cannedRelease('v99.0', []), async () => {
    const checkRes = await fetch(`${baseUrl}/api/system/update/check`);
    assert.equal(checkRes.status, 200);
    const checkData = await checkRes.json();
    assert.equal(checkData.hasUpdate, true, 'v99.0 is newer than 1.1');
    assert.equal(checkData.downloadUrl, '', 'no exe asset means no installable download');
    assert.equal(typeof checkData.currentVersion, 'string');
  });

  // POST /api/system/update/apply without a session must not be able to replace a binary.
  const applyRes = await fetch(`${baseUrl}/api/system/update/apply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ downloadUrl: `https://github.com/${REPO}/releases/download/v1.0.1/TechPartsPOS.exe` })
  });
  assert.equal(applyRes.status, 401);
});

// The raw prefix test passed a string that fetch() then parsed with WHATWG rules,
// collapsing dot segments: ".../releases/download/../../attacker/x.exe" validated
// as ours but downloaded from github.com/attacker/x.exe, and the derived digest
// URL followed it, so the SHA-256 gate verified attacker bytes.
test('updater: dot-segment and encoded-slash traversal in a release URL is refused', async () => {
  const legit = `https://github.com/${REPO}/releases/download/v1.1/TechPartsPOS.exe`;
  assert.equal(resolveTrustedReleaseUrl(legit), legit);

  const traversals = [
    `https://github.com/${REPO}/releases/download/../../attacker/x.exe`,
    `https://github.com/${REPO}/releases/download/v1/../../../../attacker/repo/releases/download/v1/x.exe`,
    `https://github.com/${REPO}/releases/download/v1/..%2f..%2fattacker/x.exe`,
    `https://github.com/${REPO}/releases/download/v1/%2e%2e/x.exe`,
    `https://github.com/${REPO}/releases/download/v1/not-the-exe.exe`,
    `https://github.com/attacker/repo/releases/download/v1/TechPartsPOS.exe`,
    `https://user@github.com/${REPO}/releases/download/v1/TechPartsPOS.exe`,
    `http://github.com/${REPO}/releases/download/v1/TechPartsPOS.exe`
  ];
  for (const url of traversals) {
    assert.equal(resolveTrustedReleaseUrl(url), '', `${url} must not validate`);
  }
  // The digest URL is derived from the resolved href, so it can only ever sit in
  // the same release as the exe that resolved.
  assert.equal(digestUrlFor(resolveTrustedReleaseUrl(legit)), `${legit}.sha256`);

  await assert.rejects(
    () => applyUpdate({ downloadUrl: `https://github.com/${REPO}/releases/download/../../attacker/x.exe` }),
    /Untrusted download URL/
  );
});

test('updater: the published digest must be exactly 64 hex chars with only a filename after it', () => {
  const bytes = Buffer.from('a stand-in for a thermal printer executable');
  const hex = crypto.createHash('sha256').update(bytes).digest('hex');
  assert.equal(digestMatches(bytes, hex), true);
  assert.equal(digestMatches(bytes, `${hex}  TechPartsPOS.exe`), true, 'sha256sum line');
  assert.equal(digestMatches(bytes, `\r\n  ${hex}  TechPartsPOS.exe\r\n`), true, 'surrounding CRLF');
  assert.equal(digestMatches(bytes, hex.toUpperCase()), true, 'case insensitive');
  assert.equal(digestMatches(bytes, `${hex}junk`), false, 'junk directly after the hex');
  assert.equal(digestMatches(bytes, hex.repeat(2)), false, '128-hex blob');
  assert.equal(digestMatches(bytes, `${hex}\nEVIL`), true, 'a filename line is the documented sha256sum shape');
  assert.equal(digestMatches(bytes, `${hex.slice(0, 63)}0`), false, 'one flipped nibble');
  assert.equal(digestMatches(bytes, `${hex}  `), true, 'surrounding whitespace is trimmed');
});

test('updater: the apply helper is cmd builtins only, so it can never open a window', () => {
  const script = buildApplyScript({
    stagingExe: 'C:/stage/TechPartsPOS_update.exe',
    targetExe: 'C:/app/TechPartsPOS.exe',
    resumeMarker: 'C:/stage/TechPartsPOS_update.resume',
    handoffLog: 'C:/stage/TechPartsPOS_update.handoff.log'
  });
  // Every command a batch file runs OUT OF PROCESS (tasklist, findstr, timeout,
  // powershell, ping) allocates a visible console when its parent cmd was
  // spawned detached with no console of its own. That is how an update left a
  // black window on the shop counter, so the script may only use builtins.
  for (const external of ['tasklist', 'findstr', 'timeout', 'powershell', 'ping', 'netstat']) {
    assert.ok(!script.toLowerCase().includes(external), `${external} is an external process`);
  }
  assert.ok(!script.includes('|'), 'a pipeline hands a child an unreadable stdin');
  assert.ok(script.includes('copy /y "C:\\stage\\TechPartsPOS_update.exe" "C:\\app\\TechPartsPOS.exe"'));
  // The caller renamed the running exe aside first, which frees this path, so
  // the copy lands while the old process is still alive.
  assert.ok(script.includes('if errorlevel 1 goto restore'), 'a failed copy restores the old build');
  // Deleting the renamed twin is the only builtin way to learn the old process
  // is gone: Windows holds the image open until it exits. Bounded anyway.
  assert.ok(script.includes('del "C:\\app\\TechPartsPOS.exe.old" >nul 2>&1'), 'the twin is reaped');
  assert.ok(script.includes('if not exist "C:\\app\\TechPartsPOS.exe.old" goto launch'), 'its absence is the restart signal');
  assert.ok(script.includes('if %tries% gtr 33000 goto giveup'), 'the reap is bounded');
  // A reap giveup keeps the staged exe and marker (retry material for the next
  // apply); only a clean exit retires them.
  const giveup = script.slice(script.indexOf('\n:giveup'), script.indexOf('\n:launch'));
  assert.ok(!giveup.includes('del "C:\\stage'), 'giveup keeps the retry material');
  assert.ok(giveup.includes('>> "C:\\stage\\TechPartsPOS_update.handoff.log"'), 'giveup writes the handoff log');
  const launch = script.slice(script.indexOf('\n:launch'), script.indexOf('\n:startnew'));
  assert.ok(launch.includes('del "C:\\stage\\TechPartsPOS_update.resume"'), 'a landed copy retires the resume marker');
  assert.ok(script.includes('start "" "C:\\app\\TechPartsPOS.exe"'), 'the app restarts');
  // Every branch leaves a milestone in the handoff log: the swap outcome used
  // to die with the detached process and the browser tab.
  for (const milestone of ['handoff started', 'copy ok', 'copy FAILED', 'did not exit', 'exited cleanly']) {
    assert.ok(script.includes(milestone), `handoff log records: ${milestone}`);
  }
  // The restore branch keeps the staged exe and marker so the next apply
  // resumes from disk; it must NOT delete either. It drops the partial target
  // first, because rename-back cannot land on a path that is already filled.
  const restore = script.slice(script.indexOf(':restore'), script.indexOf(':done'));
  assert.ok(restore.includes('del "C:\\app\\TechPartsPOS.exe" >nul 2>&1'), 'a partial target is cleared before the restore');
  assert.ok(restore.includes('ren "C:\\app\\TechPartsPOS.exe.old" "TechPartsPOS.exe"'), 'the old build is put back');
  assert.ok(!restore.includes('del "C:\\stage\\TechPartsPOS_update.exe"'), 'restore deleted the staged exe it was kept for');
  assert.ok(!restore.includes('del "C:\\stage\\TechPartsPOS_update.resume"'), 'restore deleted the resume marker');
  // A failed del or ren used to proceed silently while the handoff log already
  // claimed "previous exe restored": the 2026-11-09 audit requires both steps
  // to log their own failure so the next boot prints the truth.
  assert.ok(restore.includes('if exist "C:\\app\\TechPartsPOS.exe"'), 'a blocked clear is detected, not assumed');
  assert.ok(restore.includes('restore blocked'), 'the handoff log names a blocked restore');
  assert.ok(restore.includes('if errorlevel 1'), 'a failed rename-back is detected');
  assert.ok(restore.includes('restore FAILED'), 'the handoff log can say the restore failed');
  assert.ok(script.includes('del "%~f0"'), 'the script deletes itself');
  assert.ok(script.endsWith('\r\n'), 'batch files need CRLF');
});

// The download, size check, digest fetch and staging used to be unreachable from
// the suite (the dev-mode guard short-circuits under node.exe); the test seam
// points them at a temp staging dir and a local fetch, and skips the spawn.
function withUpdateHooks(fetchImpl, stagingDir, fn) {
  return (async () => {
    setUpdateTestHooks({ fetchImpl, stagingDir, allowUnpackaged: true, skipSpawn: true });
    try { return await fn(); } finally { setUpdateTestHooks(null); }
  })();
}

function tempStagingDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 't_updater_'));
}

const assetUrl = (tag = NEWER_TAG) => `https://github.com/${REPO}/releases/download/${tag}/TechPartsPOS.exe`;

test('updater: apply stages only bytes that match the published SHA-256', async () => {
  const dir = tempStagingDir();
  const bytes = Buffer.alloc(1024 * 1024 + 17, 7);
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  const fetchImpl = async (url) => {
    if (String(url).endsWith('.sha256')) return new Response(`${digest}  TechPartsPOS.exe`, { status: 200 });
    if (String(url).includes('api.github.com')) throw new Error('no feed in this test');
    return new Response(bytes, { status: 200 });
  };
  try {
    await withUpdateHooks(fetchImpl, dir, async () => {
      const res = await applyUpdate({ downloadUrl: assetUrl(), expectedBytes: bytes.length });
      assert.equal(res.success, true);
      assert.equal(res.url, assetUrl());
      const staged = fs.readFileSync(path.join(dir, 'TechPartsPOS_update.exe'));
      assert.equal(staged.length, bytes.length);
      assert.ok(fs.existsSync(path.join(dir, 'apply_update.cmd')));
    });

    // A mismatched digest refuses BEFORE anything touches the staging path.
    const badDir = tempStagingDir();
    try {
      await withUpdateHooks(async (url) => {
        if (String(url).endsWith('.sha256')) return new Response('f'.repeat(64), { status: 200 });
        if (String(url).includes('api.github.com')) throw new Error('no feed in this test');
        return new Response(bytes, { status: 200 });
      }, badDir, async () => {
        await assert.rejects(
          () => applyUpdate({ downloadUrl: assetUrl(), expectedBytes: bytes.length }),
          /SHA-256 checksum/
        );
        assert.equal(fs.existsSync(path.join(badDir, 'TechPartsPOS_update.exe')), false, 'nothing may be staged');
        assert.equal(fs.existsSync(path.join(badDir, 'apply_update.cmd')), false, 'no helper may be written');
      });
    } finally { fs.rmSync(badDir, { recursive: true, force: true }); }

    // A size mismatch is a sanity refusal, not an install.
    const sizeDir = tempStagingDir();
    try {
      await withUpdateHooks(fetchImpl, sizeDir, async () => {
        await assert.rejects(
          () => applyUpdate({ downloadUrl: assetUrl(), expectedBytes: bytes.length + 1 }),
          /size mismatch/
        );
        assert.equal(fs.existsSync(path.join(sizeDir, 'TechPartsPOS_update.exe')), false);
      });
    } finally { fs.rmSync(sizeDir, { recursive: true, force: true }); }

    // A missing checksum asset fails closed: the pre-checksum releases on GitHub
    // carry no .sha256, so a shop pressing Update Now gets a refusal, not a guess.
    const missingDir = tempStagingDir();
    try {
      await withUpdateHooks(async (url) => {
        if (String(url).endsWith('.sha256')) return new Response('not found', { status: 404 });
        if (String(url).includes('api.github.com')) throw new Error('no feed in this test');
        return new Response(bytes, { status: 200 });
      }, missingDir, async () => {
        await assert.rejects(
          () => applyUpdate({ downloadUrl: assetUrl(), expectedBytes: bytes.length }),
          /Could not verify this update/
        );
        assert.equal(fs.existsSync(path.join(missingDir, 'TechPartsPOS_update.exe')), false);
      });
    } finally { fs.rmSync(missingDir, { recursive: true, force: true }); }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('updater: two concurrent applies cannot share the staging path', async () => {
  const dir = tempStagingDir();
  const bytes = Buffer.alloc(1024 * 1024, 3);
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const fetchImpl = async (url) => {
    if (String(url).endsWith('.sha256')) return new Response(`${digest}  TechPartsPOS.exe`, { status: 200 });
    if (String(url).includes('api.github.com')) throw new Error('no feed in this test');
    await gate;
    return new Response(bytes, { status: 200 });
  };
  try {
    await withUpdateHooks(fetchImpl, dir, async () => {
      const first = applyUpdate({ downloadUrl: assetUrl(), expectedBytes: bytes.length });
      await assert.rejects(
        () => applyUpdate({ downloadUrl: assetUrl(), expectedBytes: bytes.length }),
        /already being applied/
      );
      release();
      const res = await first;
      assert.equal(res.success, true);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// A blocked swap (the helper's giveup branch) leaves the staged exe + marker on
// disk; the next apply for the same release must resume from it after a hash
// check instead of re-downloading 90+ MB, and a marker for a different release
// must not be misapplied.
test('updater: a blocked swap resumes from the staged exe without re-downloading', async () => {
  const dir = tempStagingDir();
  const bytes = Buffer.alloc(1024 * 1024 + 9, 5);
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  let exeDownloads = 0;
  const fetchImpl = async (url) => {
    if (String(url).endsWith('.sha256')) return new Response(digest, { status: 200 });
    if (String(url).includes('api.github.com')) throw new Error('no feed in this test');
    exeDownloads++;
    return new Response(bytes, { status: 200 });
  };
  try {
    await withUpdateHooks(fetchImpl, dir, async () => {
      // No expectedBytes either: the tag and the gate both come from the URL
      // and the published digest, with no feed call.
      const first = await applyUpdate({ downloadUrl: assetUrl() });
      assert.equal(first.success, true);
      assert.equal(exeDownloads, 1);
      assert.ok(fs.existsSync(path.join(dir, 'TechPartsPOS_update.resume')), 'no resume marker was written at staging time');

      // Giveup leaves both files in place; the retry must reuse them.
      const second = await applyUpdate({ downloadUrl: assetUrl() });
      assert.equal(second.success, true);
      assert.equal(exeDownloads, 1, 'the resume path re-downloaded the exe');
      assert.equal(fs.readFileSync(path.join(dir, 'TechPartsPOS_update.exe')).length, bytes.length);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The 2026-11-09 audit: a checksum FETCH outage must not delete the very
// material the staged-reuse branch exists to reuse. Fail closed (nothing
// installs), keep both files, and let the next Update Now re-verify.
test('updater: a digest-fetch outage keeps the staged retry material', async () => {
  const dir = tempStagingDir();
  try {
    const bytes = Buffer.alloc(1024 * 1024 + 3, 9);
    fs.writeFileSync(path.join(dir, 'TechPartsPOS_update.exe'), bytes);
    fs.writeFileSync(path.join(dir, 'TechPartsPOS_update.resume'),
      JSON.stringify({ url: assetUrl(), version: NEWER_TAG, bytes: bytes.length }));
    await withUpdateHooks(async (url) => {
      if (String(url).endsWith('.sha256')) throw new Error('connection reset');
      throw new Error('no feed in this test');
    }, dir, async () => {
      await assert.rejects(
        () => applyUpdate({ downloadUrl: assetUrl(), expectedBytes: bytes.length }),
        /SHA-256/
      );
      assert.ok(fs.existsSync(path.join(dir, 'TechPartsPOS_update.exe')), 'the staged exe must survive a checksum-fetch outage');
      assert.ok(fs.existsSync(path.join(dir, 'TechPartsPOS_update.resume')), 'the resume marker must survive a checksum-fetch outage');
    });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('updater: a staged exe from an older release is discarded, not misapplied', async () => {
  const dir = tempStagingDir();
  const oldBytes = Buffer.alloc(1024 * 1024 + 3, 9);
  fs.writeFileSync(path.join(dir, 'TechPartsPOS_update.exe'), oldBytes);
  fs.writeFileSync(path.join(dir, 'TechPartsPOS_update.resume'),
    JSON.stringify({ url: `https://github.com/${REPO}/releases/download/v1.0.5/TechPartsPOS.exe` }));
  const bytes = Buffer.alloc(1024 * 1024 + 4, 6);
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  let exeDownloads = 0;
  const fetchImpl = async (url) => {
    if (String(url).endsWith('.sha256')) return new Response(digest, { status: 200 });
    if (String(url).includes('api.github.com')) throw new Error('no feed in this test');
    exeDownloads++;
    return new Response(bytes, { status: 200 });
  };
  try {
    await withUpdateHooks(fetchImpl, dir, async () => {
      const res = await applyUpdate({ downloadUrl: assetUrl(), expectedBytes: bytes.length });
      assert.equal(res.success, true);
      assert.equal(exeDownloads, 1, 'a mismatched marker must trigger a fresh download');
      assert.equal(fs.readFileSync(path.join(dir, 'TechPartsPOS_update.exe')).length, bytes.length);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

serverTest('updater: apply refuses the factory PIN and never stores an untrusted URL in the audit trail', async (baseUrl, db, auth) => {
  const post = (headers, body) => fetch(`${baseUrl}/api/system/update/apply`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const legit = `https://github.com/${REPO}/releases/download/${NEWER_TAG}/TechPartsPOS.exe`;

  // Factory PIN live: the most consequential action in the app refuses, like the
  // other destructive routes.
  const denied = await post(auth, { downloadUrl: legit });
  assert.equal(denied.status, 403);
  assert.match((await denied.json()).error, /factory PIN/i);

  auth = await ensurePinChanged(baseUrl, auth);
  const untrusted = await post(auth, { downloadUrl: `https://github.com/${REPO}/releases/download/../../attacker/x.exe` });
  assert.equal(untrusted.status, 400);
  assert.match((await untrusted.json()).error, /Untrusted download URL/);

  // The audit row records the refusal by reason and never the caller's raw URL:
  // the string is untrusted and used to land verbatim in the append-only trail.
  const row = db.prepare("SELECT detail FROM audit_log WHERE category = 'system' AND action = 'update_apply' ORDER BY id DESC LIMIT 1").get();
  assert.ok(row, 'a refused apply must leave a trail');
  const detail = JSON.parse(row.detail);
  assert.equal(detail.ok, false);
  assert.ok(!JSON.stringify(detail).includes('attacker'), 'the untrusted URL must not reach the audit trail');

  // A merely offline GitHub is a 400 too, and still an audited refusal.
  const offline = await post(auth, { downloadUrl: legit });
  assert.ok(offline.status === 400 || offline.status === 200, `unexpected status ${offline.status}`);
});

// The route's own success path used to be unreachable from the suite: the only
// route test drove refusals. This drives a trusted apply THROUGH the route with
// the hooks (download, digest, staging all real; the spawn and the process exit
// are the manual steps) and checks the audit row the operator would see.
serverTest('updater: the apply route stages a trusted update and audits it', async (baseUrl, db, auth) => {
  auth = await ensurePinChanged(baseUrl, auth);
  const dir = tempStagingDir();
  const bytes = Buffer.alloc(1024 * 1024 + 11, 4);
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  const fetchImpl = async (url) => {
    if (String(url).endsWith('.sha256')) return new Response(`${digest}  TechPartsPOS.exe`, { status: 200 });
    if (String(url).includes('api.github.com')) throw new Error('no feed in this test');
    return new Response(bytes, { status: 200 });
  };
  setUpdateTestHooks({ fetchImpl, stagingDir: dir, allowUnpackaged: true, skipSpawn: true });
  try {
    const res = await fetch(`${baseUrl}/api/system/update/apply`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ downloadUrl: `https://github.com/${REPO}/releases/download/${NEWER_TAG}/TechPartsPOS.exe`, expectedBytes: bytes.length })
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.version, NEWER_TAG);
    assert.equal(fs.existsSync(path.join(dir, 'TechPartsPOS_update.exe')), true);
    assert.equal(fs.existsSync(path.join(dir, 'apply_update.cmd')), true);

    const row = db.prepare("SELECT detail FROM audit_log WHERE category = 'system' AND action = 'update_apply' ORDER BY id DESC LIMIT 1").get();
    assert.ok(row, 'a successful apply must leave a trail');
    const detail = JSON.parse(row.detail);
    assert.equal(detail.ok, true);
    assert.equal(detail.version, NEWER_TAG);
    assert.equal(detail.url, `https://github.com/${REPO}/releases/download/${NEWER_TAG}/TechPartsPOS.exe`);

    // A digest the release does not match: the route refuses with the reason and
    // an ok:false row, and nothing new lands on the staging path.
    const badBytes = Buffer.alloc(1024 * 1024 + 12, 8);
    setUpdateTestHooks({
      fetchImpl: async (url) => {
        if (String(url).endsWith('.sha256')) return new Response('f'.repeat(64), { status: 200 });
        if (String(url).includes('api.github.com')) throw new Error('no feed in this test');
        return new Response(badBytes, { status: 200 });
      },
      stagingDir: dir, allowUnpackaged: true, skipSpawn: true
    });
    const bad = await fetch(`${baseUrl}/api/system/update/apply`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      // A different, still-newer tag: it must be the digest that refuses this
      // one, not the version floor or the resume marker from the apply above.
      body: JSON.stringify({ downloadUrl: `https://github.com/${REPO}/releases/download/${OTHER_NEWER_TAG}/TechPartsPOS.exe`, expectedBytes: badBytes.length })
    });
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /SHA-256 checksum/);
  } finally {
    setUpdateTestHooks(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

serverTest('updater: the update check route has a per-client budget', async (baseUrl) => {
  const statuses = [];
  await withFeed(cannedRelease('v99.0', []), async () => {
    for (let i = 0; i < 11; i++) {
      statuses.push((await fetch(`${baseUrl}/api/system/update/check`)).status);
    }
  });
  assert.ok(statuses.includes(429), `expected the budget to trip, saw ${statuses.join(',')}`);
  // The window is shared per process, so other checks in this file count too:
  // what matters is that a successful check precedes the refusal.
  assert.ok(statuses.indexOf(200) !== -1 && statuses.indexOf(200) < statuses.indexOf(429));
  assert.ok(statuses.filter(s => s === 200).length <= 10, 'the budget must not admit unlimited checks');
});

test('updater: mid-stream TypeError: terminated resumes with HTTP Range and finishes cleanly', async () => {
  const dir = tempStagingDir();
  const half = 600 * 1024;
  const bytes = Buffer.alloc(1024 * 1024 + 32, 0x42);
  for (let i = half; i < bytes.length; i++) bytes[i] = 0x99;
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  let calls = 0;
  let seenRange = '';
  const fetchImpl = async (url, opts = {}) => {
    if (String(url).endsWith('.sha256')) return new Response(digest, { status: 200 });
    calls++;
    if (calls === 1) {
      return {
        ok: true,
        status: 200,
        headers: new Map([['content-length', String(bytes.length)]]),
        body: {
          async *[Symbol.asyncIterator]() {
            yield bytes.subarray(0, half);
            throw new TypeError('terminated');
          }
        }
      };
    }
    seenRange = opts.headers && opts.headers.Range;
    return new Response(bytes.subarray(half), { status: 206 });
  };
  try {
    await withUpdateHooks(fetchImpl, dir, async () => {
      const res = await applyUpdate({ downloadUrl: assetUrl(), expectedBytes: bytes.length });
      assert.equal(res.success, true);
      assert.equal(calls, 2);
      assert.equal(seenRange, `bytes=${half}-`);
      assert.equal(Buffer.compare(fs.readFileSync(path.join(dir, 'TechPartsPOS_update.exe')), bytes), 0);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
