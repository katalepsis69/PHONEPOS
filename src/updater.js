// src/updater.js - GitHub Releases Updater for TechParts POS
// Checks katalepsis69/PHONEPOS for new releases and handles in-app updates.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { getBaseDir } = require('./db');

const REPO = 'katalepsis69/PHONEPOS';
const CURRENT_VERSION = '2.8';

/**
 * Parses a version string into an array of integers.
 * Supports "v1.0", "1.0.1", "v2.0.0-beta", etc.
 */
function parseVersionParts(v) {
  if (!v || typeof v !== 'string') return [0, 0, 0];
  const clean = v.trim().replace(/^[vV]/, '').split(/[+-]/)[0];
  const parts = clean.split('.').map(p => {
    const n = parseInt(p, 10);
    return Number.isFinite(n) ? n : 0;
  });
  while (parts.length < 3) parts.push(0);
  return parts;
}

/**
 * Returns true if remote version is strictly newer than local version.
 */
function isRemoteNewer(remoteV, localV) {
  const r = parseVersionParts(remoteV);
  const l = parseVersionParts(localV);
  const len = Math.max(r.length, l.length);
  for (let i = 0; i < len; i++) {
    const rv = r[i] || 0;
    const lv = l[i] || 0;
    if (rv > lv) return true;
    if (rv < lv) return false;
  }
  return false;
}

/**
 * Validates that download URL belongs strictly to official GitHub Release assets for this repo.
 */
function isTrustedReleaseUrl(url) {
  if (!url || typeof url !== 'string') return false;
  if (!url.startsWith('https://github.com/')) return false;
  return url.slice('https://github.com/'.length).startsWith(`${REPO}/releases/download/`);
}

/**
 * Validates that the release page URL is this repo's page on github.com, not
 * merely any github.com host: the banner link is a human click target, and a
 * lookalike repo's manual download skips every in-app trust gate.
 */
function isTrustedPageUrl(url) {
  if (!url || typeof url !== 'string') return false;
  let parsed;
  try { parsed = new URL(url); } catch (_) { return false; }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port) return false;
  if (parsed.hostname.toLowerCase() !== 'github.com') return false;
  const repoPath = `/${REPO.toLowerCase()}`;
  const p = parsed.pathname.toLowerCase();
  return p === repoPath || p.startsWith(`${repoPath}/`);
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
// The only legitimate asset URL shape: this repo's releases/download dir, one
// tag segment, and the exe. Anything else (another repo, another asset name) is
// not ours to run.
const RELEASE_ASSET_RE = new RegExp(
  `^https://github\\.com/${escapeRegExp(REPO)}/releases/download/[^/]+/TechPartsPOS\\.exe$`,
  'i'
);

/**
 * Resolves and validates a release asset URL. The raw string is never trusted:
 * fetch() parses the URL with WHATWG rules, which collapse dot segments, so
 * "https://github.com/<repo>/releases/download/../../attacker/x.exe" passes a
 * string prefix test but downloads from github.com/attacker/x.exe. Resolving
 * first and re-checking the resolved href closes that, and rejecting "%" closes
 * the encoded-slash variant that only the server side would ever decode.
 * Returns the normalized href, or '' when the URL is not a trusted asset.
 */
function resolveTrustedReleaseUrl(url) {
  const text = String(url || '').trim();
  if (!text || text.includes('%')) return '';
  let parsed;
  try { parsed = new URL(text); } catch (_) { return ''; }
  if (parsed.protocol !== 'https:') return '';
  if (parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash) return '';
  const href = parsed.href;
  if (!isTrustedReleaseUrl(href)) return '';
  if (!RELEASE_ASSET_RE.test(href)) return '';
  return href;
}

/**
 * Checks GitHub Releases API for the latest published release.
 */
// The release pipeline publishes the executable's SHA-256 as a sibling asset named
// "<exe>.sha256", so the digest is derived from the download URL rather than carried
// through the route, the request body or the UI: a caller cannot choose it.
function digestUrlFor(downloadUrl) {
  const url = String(downloadUrl || '').trim();
  return url ? `${url}.sha256` : '';
}

// Accepts either a bare 64 hex digest or the "hash  filename" form sha256sum
// writes, and nothing else: a loose prefix match used to accept a digest with
// arbitrary junk after the hex (or a 128-hex blob), so a malformed asset could
// still gate an install.
function digestMatches(buffer, digestText) {
  const found = String(digestText || '').trim().toLowerCase().match(/^([0-9a-f]{64})(?:\s+\*?\S.*)?$/);
  if (!found) return false;
  const actual = crypto.createHash('sha256').update(buffer).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(found[1], 'hex'));
}

// Fetches the published SHA-256 for a trusted release asset. This is the
// integrity gate for both a fresh download and a resumed stage. Integrity
// only: nothing in this module verifies who built the binary, only what its
// bytes hash to.
async function fetchPublishedDigest(targetUrl) {
  const digestUrl = digestUrlFor(targetUrl);
  if (!isTrustedReleaseUrl(digestUrl)) {
    throw new Error('Untrusted checksum URL.');
  }
  try {
    const digestRes = await updateFetch(digestUrl, {
      headers: {
        'User-Agent': 'TechPartsPOS-Updater',
        'Accept': 'text/plain'
      },
      signal: AbortSignal.timeout(15000)
    });
    if (!digestRes.ok) {
      throw new Error(`published checksum missing (HTTP ${digestRes.status})`);
    }
    return await digestRes.text();
  } catch (err) {
    updateLog(`apply refused: checksum could not be fetched (${err && err.message ? err.message : err})`);
    throw new Error(`Could not verify this update against a published SHA-256 (${err && err.message ? err.message : err}). Nothing was installed.`);
  }
}

// One update at a time, process-wide: two concurrent applies stage over the
// same TechPartsPOS_update.exe and the same apply_update.cmd, and the raced
// copy can promote a half-written exe.
let applyInFlight = false;

let updateProgress = {
  active: false,
  phase: 'idle',
  downloadedBytes: 0,
  totalBytes: 0,
  percent: 0,
  attempt: 1,
  version: ''
};

function setProgress(patch) {
  updateProgress = { ...updateProgress, ...patch };
  if (updateProgress.totalBytes > 0 && updateProgress.downloadedBytes >= 0) {
    updateProgress.percent = Math.min(100, Math.round((updateProgress.downloadedBytes / updateProgress.totalBytes) * 100));
  }
}

function getUpdateProgress() {
  return { ...updateProgress };
}

// Streams the release binary with a per-chunk inactivity timer and automatic
// HTTP Range resume if the CDN closes the TLS socket mid-transfer.
async function downloadReleaseWithResume(targetUrl, targetBytes, stagingDir) {
  const partFile = stagingDir ? path.join(stagingDir, 'TechPartsPOS_update.part') : '';
  const partMeta = stagingDir ? path.join(stagingDir, 'TechPartsPOS_update.part.json') : '';
  let chunks = [];
  let received = 0;

  if (partFile && fs.existsSync(partFile) && fs.existsSync(partMeta)) {
    try {
      const meta = JSON.parse(fs.readFileSync(partMeta, 'utf8'));
      const prev = fs.readFileSync(partFile);
      if (meta && meta.url === targetUrl && prev.length > 0 && (!targetBytes || prev.length < targetBytes)) {
        chunks = [prev];
        received = prev.length;
        setProgress({ downloadedBytes: received, totalBytes: targetBytes || meta.totalBytes || 0 });
        updateLog(`apply: resuming partial download from ${received} bytes`);
      }
    } catch (_) {}
  }

  const maxAttempts = (testHooks && testHooks.maxAttempts) || (testHooks && testHooks.fetchImpl ? 2 : 5);
  let lastErr = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    setProgress({ phase: 'downloading', attempt, downloadedBytes: received });
    const headers = {
      'User-Agent': 'TechPartsPOS-Updater',
      'Accept': 'application/octet-stream'
    };
    if (received > 0) {
      headers['Range'] = `bytes=${received}-`;
    }

    const ctrl = new AbortController();
    let stallTimer = setTimeout(() => ctrl.abort(new Error('download stalled')), 45000);
    const resetStall = () => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => ctrl.abort(new Error('download stalled')), 45000);
    };

    try {
      const res = await updateFetch(targetUrl, {
        headers,
        redirect: 'follow',
        signal: ctrl.signal
      });
      resetStall();

      if (res.status === 200 && received > 0) {
        // Server ignored Range header; restart from byte 0
        chunks = [];
        received = 0;
      } else if (res.status !== 200 && res.status !== 206) {
        clearTimeout(stallTimer);
        updateLog(`apply: download failed with HTTP ${res.status}`);
        throw new Error(`Failed to download update from GitHub (HTTP ${res.status})`);
      }

      const contentLen = Number(res.headers && res.headers.get ? res.headers.get('content-length') : 0) || 0;
      const expectedTotal = targetBytes || (res.status === 206 ? received + contentLen : contentLen);
      if (expectedTotal > 0) setProgress({ totalBytes: expectedTotal });

      if (res.body && typeof res.body[Symbol.asyncIterator] === 'function') {
        for await (const part of res.body) {
          resetStall();
          const buf = Buffer.isBuffer(part) ? part : Buffer.from(part);
          chunks.push(buf);
          received += buf.length;
          setProgress({ downloadedBytes: received });
        }
      } else {
        const ab = await res.arrayBuffer();
        resetStall();
        const buf = Buffer.from(ab);
        chunks.push(buf);
        received += buf.length;
        setProgress({ downloadedBytes: received });
      }
      clearTimeout(stallTimer);

      const full = Buffer.concat(chunks);
      if (partFile) {
        try { fs.rmSync(partFile, { force: true }); } catch (_) {}
        try { fs.rmSync(partMeta, { force: true }); } catch (_) {}
      }
      return full;
    } catch (err) {
      clearTimeout(stallTimer);
      lastErr = err;
      if (/^Failed to download update from GitHub \(HTTP/.test(String(err && err.message))) {
        throw err;
      }
      updateLog(`apply: download attempt ${attempt}/${maxAttempts} interrupted at ${received} bytes (${err && err.message ? err.message : err})`);
      if (partFile && received > 0) {
        try {
          fs.writeFileSync(partFile, Buffer.concat(chunks));
          fs.writeFileSync(partMeta, JSON.stringify({ url: targetUrl, totalBytes: updateProgress.totalBytes }), 'utf8');
        } catch (_) {}
      }
      if (attempt < maxAttempts) {
        await new Promise(r => setTimeout(r, 800 * attempt));
      }
    }
  }

  const msg = lastErr && lastErr.message ? lastErr.message : String(lastErr || 'connection closed');
  throw new Error(`Download interrupted (${msg}). ${received > 0 ? `Saved ${(received / (1024 * 1024)).toFixed(1)} MB. Click Update Now to resume.` : 'Check your internet connection and try again.'}`);
}

// Test seam, same shape as src/license.js setVerifyKeyForTests: the suite points
// the download at a local server and the staging dir at a temp folder, and skips
// the detached spawn (which must never run under test). Production never calls it.
let testHooks = null;
function setUpdateTestHooks(hooks) { testHooks = hooks || null; }
const updateFetch = (...args) => (testHooks && testHooks.fetchImpl ? testHooks.fetchImpl(...args) : fetch(...args));
// The update path is otherwise silent in pos-server.log; these lines are what
// let an operator tell a timeout from a checksum refusal after the fact.
// The packaged GUI exe throws console output away, so once the server is up
// these lines go through its logLine sink instead and land in pos-server.log.
let updateLogSink = null;
function setUpdateLogSink(fn) { updateLogSink = typeof fn === 'function' ? fn : null; }
const updateLog = (msg) => {
  const line = `[update] ${msg}`;
  if (updateLogSink) { try { updateLogSink(line); return; } catch (_) {} }
  console.log(line);
};

async function checkForUpdates(currentVer = CURRENT_VERSION) {
  const result = await checkForUpdatesInner(currentVer);
  updateLog(result.checkError
    ? `check: ${result.checkError}`
    : (result.hasUpdate
      ? `check: version ${result.latestVersion} is available (running ${result.currentVersion})`
      : `check: up to date (${result.currentVersion})`));
  return result;
}

async function checkForUpdatesInner(currentVer = CURRENT_VERSION) {
  const url = `https://api.github.com/repos/${REPO}/releases/latest`;
  const result = {
    hasUpdate: false,
    currentVersion: currentVer,
    latestVersion: '',
    notes: '',
    downloadUrl: '',
    zipUrl: '',
    htmlUrl: '',
    expectedBytes: 0,
    checkError: ''
  };

  try {
    const res = await updateFetch(url, {
      headers: {
        'User-Agent': 'TechPartsPOS-Updater',
        'Accept': 'application/vnd.github+json'
      },
      signal: AbortSignal.timeout(10000)
    });

    if (res.status === 404) {
      result.checkError = 'No releases published on GitHub yet.';
      return result;
    }

    if (res.status === 403 || res.status === 429) {
      result.checkError = 'GitHub is not answering right now (rate limit).';
      return result;
    }

    if (!res.ok) {
      result.checkError = `Could not reach GitHub (HTTP ${res.status}).`;
      return result;
    }

    const data = await res.json();
    const tag = (data.tag_name || '').trim();
    if (!tag) {
      result.checkError = "GitHub's reply had no version in it.";
      return result;
    }

    result.latestVersion = tag;
    result.htmlUrl = isTrustedPageUrl(data.html_url) ? data.html_url : `https://github.com/${REPO}/releases`;
    result.notes = typeof data.body === 'string' ? data.body : '';

    if (Array.isArray(data.assets)) {
      for (const a of data.assets) {
        const name = (a.name || '').toLowerCase();
        const dl = a.browser_download_url || '';
        if (name === 'techpartspos.exe' && isTrustedReleaseUrl(dl)) {
          result.downloadUrl = dl;
          result.expectedBytes = Number(a.size) || 0;
        } else if (name.endsWith('.zip') && isTrustedReleaseUrl(dl) && !result.zipUrl) {
          result.zipUrl = dl;
        }
      }
    }

    result.hasUpdate = isRemoteNewer(result.latestVersion, currentVer);
    return result;
  } catch (err) {
    // The low-level cause goes to the log only (no-route vs rate limit vs TLS),
    // while the operator-facing sentence stays one generic line.
    const cause = err && err.cause ? ` (${err.cause.code || err.cause.message || err.cause})` : '';
    updateLog(`check: could not reach GitHub: ${err && err.message ? err.message : err}${cause}`);
    result.checkError = 'Could not reach GitHub. Check your internet connection.';
    return result;
  }
}

/**
 * The apply_update.cmd helper: lands the staged exe, restarts the register and
 * deletes itself. Builtins only, because any out-of-process command in a batch
 * run this way opens a console window on the shop counter. The caller renames
 * the running exe to "<exe>.old" first, which frees the target path and leaves
 * behind the twin whose deletion tells the helper this process is gone.
 */
function defaultUpdateStagingDir(serviceMode = process.argv.includes('--service')) {
  return serviceMode
    ? path.join(getBaseDir(), 'updates')
    : path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'TechPartsPOS');
}

function buildApplyScript({ stagingExe, targetExe, resumeMarker, handoffLog, oldSizePath, serviceMode = false }) {
  const winStaging = String(stagingExe).replace(/\//g, '\\');
  const winExe = String(targetExe).replace(/\//g, '\\');
  const winOld = `${winExe}.old`;
  const winResume = String(resumeMarker).replace(/\//g, '\\');
  const winHandoff = String(handoffLog).replace(/\//g, '\\');
  const winOldSize = String(oldSizePath).replace(/\//g, '\\');
  const exeName = path.basename(winExe);
  const relaunchLines = serviceMode
    ? ['schtasks /Run /TN "TechPartsPOS-Server" >nul 2>&1']
    : ['set NO_LAUNCH_BROWSER=1', `start "" "${winExe}"`];
  // Every milestone appends one line to the handoff log: the helper runs with
  // stdio ignored and dies with the old process, so this file is the only
  // durable record of what the swap actually did. The next boot reads it.
  return [
    '@echo off',
    `>> "${winHandoff}" echo(%date% %time% handoff started`,
    `copy /y "${winStaging}" "${winExe}" >nul`,
    'if errorlevel 1 goto restore',
    `>> "${winHandoff}" echo copy ok`,
    'set tries=0',
    ':reap',
    // The delete only succeeds once the register lets go of the image, so it is
    // the exit signal. Cap is about 20s at the measured 1600 polls/second.
    `del "${winOld}" >nul 2>&1`,
    `if not exist "${winOld}" goto launch`,
    'set /a tries+=1',
    'if %tries% gtr 33000 goto giveup',
    'goto reap',
    ':giveup',
    // The old register never let go. Launch anyway (the machine lock sorts the
    // collision out) but KEEP the staged exe and marker: they are the retry
    // material for the next Update Now, and this attempt cannot prove the new
    // binary is the one that will win.
    `>> "${winHandoff}" echo old register did not exit; retry material kept`,
    'goto startnew',
    ':launch',
    `>> "${winHandoff}" echo old register exited cleanly`,
    `del "${winStaging}" >nul 2>&1`,
    `del "${winResume}" >nul 2>&1`,
    ':startnew',
    ...relaunchLines,
    'goto done',
    ':restore',
    // A failed copy can leave a partial file at the target path, and a rename
    // cannot land on a path that is already filled. The staged exe and its
    // marker stay on disk here so the next apply retries without re-downloading.
    // Identity check: the parent recorded the twin's size before launching this
    // script, so a foreign or truncated .old is restored but flagged in the
    // handoff log for the next boot to print.
    `set /p RESTORE_EXPECTED= < "${winOldSize}"`,
    `for %%A in ("${winOld}") do set RESTORE_ACTUAL=%%~zA`,
    `if not "%RESTORE_ACTUAL%"=="%RESTORE_EXPECTED%" >> "${winHandoff}" echo restore size mismatch: .old is %%RESTORE_ACTUAL%% bytes, expected %%RESTORE_EXPECTED%%`,
    `>> "${winHandoff}" echo copy FAILED; previous exe restored`,
    `del "${winExe}" >nul 2>&1`,
    // A failed del leaves the partial target in the way, and a rename cannot
    // land on a filled path: log it instead of reporting a restore that never
    // happened.
    `if exist "${winExe}" >> "${winHandoff}" echo restore blocked: the partial target could not be cleared`,
    `ren "${winOld}" "${exeName}"`,
    `if errorlevel 1 (>> "${winHandoff}" echo restore FAILED: the previous exe could not be renamed back)`,
    ...relaunchLines,
    ':done',
    '(goto) 2>nul & del "%~f0"'
  ].join('\r\n') + '\r\n';
}

// The detached helper cannot log anywhere the next process will read through
// console transports, so it appends to this file instead. The next boot prints
// and clears it: one line per milestone, newest last.
function consumeHandoffStatus(stagingDir = defaultUpdateStagingDir()) {
  const handoffLog = path.join(stagingDir, 'TechPartsPOS_update.handoff.log');
  try {
    if (!fs.existsSync(handoffLog)) return;
    const lines = fs.readFileSync(handoffLog, 'utf8').split(/\r?\n/).filter(Boolean);
    for (const line of lines) updateLog(`handoff: ${line}`);
    fs.unlinkSync(handoffLog);
  } catch (_) {}
}

/**
 * Downloads the update and triggers the Windows helper script to swap TechPartsPOS.exe.
 * One apply at a time: concurrent calls would stage over each other's files.
 */
async function applyUpdate(options = {}) {
  if (applyInFlight) throw new Error('An update is already being applied. Wait for it to finish before trying again.');
  applyInFlight = true;
  setProgress({
    active: true,
    phase: 'checking',
    downloadedBytes: 0,
    totalBytes: Number(options.expectedBytes) || 0,
    percent: 0,
    attempt: 1,
    version: ''
  });
  try {
    return await applyUpdateInner(options);
  } finally {
    applyInFlight = false;
    setProgress({ active: false, phase: 'idle' });
  }
}

async function applyUpdateInner({ downloadUrl, expectedBytes = 0, currentVer = CURRENT_VERSION, serviceMode = process.argv.includes('--service') } = {}) {
  // If no downloadUrl passed, fetch latest
  let targetUrl = downloadUrl;
  let targetBytes = expectedBytes;
  let htmlUrl = `https://github.com/${REPO}/releases`;
  let targetVersion = '';

  if (!targetUrl) {
    const check = await checkForUpdates(currentVer);
    if (check.checkError) throw new Error(check.checkError);
    if (!check.hasUpdate) throw new Error('Already on the latest version.');
    targetUrl = check.downloadUrl;
    targetBytes = check.expectedBytes;
    htmlUrl = check.htmlUrl;
    targetVersion = check.latestVersion;
  }

  // The URL is untrusted input: resolve it first and validate the RESOLVED href,
  // because fetch() collapses dot segments (".../download/../../attacker/x.exe"
  // passes a raw prefix test but downloads from github.com/attacker/x.exe). The
  // digest URL below is derived from the resolved form, so the exe and its
  // checksum can never point at different repos.
  const resolved = resolveTrustedReleaseUrl(targetUrl);
  if (!resolved) {
    if (!downloadUrl) {
      // No caller URL: the feed simply had no installable exe asset this time.
      updateLog('apply: no installable executable asset in the latest release');
      return {
        success: false,
        runningInDev: false,
        openedBrowser: true,
        htmlUrl,
        version: targetVersion,
        message: 'No direct executable download found. Opening release page.'
      };
    }
    throw new Error('Untrusted download URL: must be an official release asset from ' + REPO);
  }
  targetUrl = resolved;

  // The resolved URL already names its release, so the tag comes from the path
  // instead of a second feed call the UI made seconds earlier. Bytes stay 0
  // when the caller sent none: the size check is a sanity gate, the digest
  // below is the integrity gate.
  if (!targetVersion) {
    const m = new URL(targetUrl).pathname.match(/\/releases\/download\/([^/]+)\//);
    targetVersion = m ? decodeURIComponent(m[1]) : '';
  }
  // No caller-supplied URL installs an old tag: every apply must move forward
  // from the running version.
  if (!isRemoteNewer(targetVersion, currentVer)) {
    updateLog(`apply refused: release ${targetVersion || '(unknown)'} is not newer than ${currentVer}`);
    throw new Error(`That release (${targetVersion || 'unknown'}) is not newer than the version you are running (${currentVer}).`);
  }
  setProgress({ version: targetVersion, totalBytes: targetBytes || 0 });
  updateLog(`apply: downloading ${targetUrl}${targetVersion ? ` (version ${targetVersion})` : ''}`
    + `${targetBytes > 0 ? `, expecting ${targetBytes} bytes` : ''}`);

  // Running via node.exe directly (development mode): do not overwrite node.exe
  const currentExe = process.execPath;
  const isPackaged = testHooks && testHooks.allowUnpackaged
    ? true
    : !path.basename(currentExe).toLowerCase().endsWith('node.exe');

  if (!isPackaged) {
    updateLog('apply refused: running in development mode (node.exe)');
    return {
      success: false,
      runningInDev: true,
      openedBrowser: false,
      htmlUrl,
      version: targetVersion,
      message: 'Running in development mode (node.exe). Cannot overwrite node runtime. Please download the release executable from GitHub.'
    };
  }

  // Staging folder in %LOCALAPPDATA%\TechPartsPOS (or getBaseDir()/updates in service mode)
  const stagingDir = (testHooks && testHooks.stagingDir)
    || defaultUpdateStagingDir(serviceMode);
  fs.mkdirSync(stagingDir, { recursive: true });
  const stagingExe = path.join(stagingDir, 'TechPartsPOS_update.exe');
  const resumeMarker = path.join(stagingDir, 'TechPartsPOS_update.resume');

  // A leftover staged exe + marker means the previous swap could not overwrite
  // the running exe (the helper's giveup branch keeps both). Reuse it for the
  // same release after re-verifying its hash, so the retry is a hash check
  // instead of a full re-download; anything else is cleaned out.
  let buffer = null;
  if (fs.existsSync(stagingExe) && fs.existsSync(resumeMarker)) {
    // A checksum FETCH failure is the network's fault, not the staged bytes':
    // deleting the retry material over a transient outage would force a full
    // re-download on the next attempt. A verified MISMATCH is the bytes'
    // fault and cleans both files.
    let digestFetchError = null;
    try {
      const marker = JSON.parse(fs.readFileSync(resumeMarker, 'utf8'));
      const staged = fs.readFileSync(stagingExe);
      const sameRelease = marker && marker.url === targetUrl;
      const sizeOk = !(targetBytes > 0) || staged.length === targetBytes;
      if (sameRelease && staged.length >= 1024 * 1024 && sizeOk) {
        let digestText;
        try {
          digestText = await fetchPublishedDigest(targetUrl);
        } catch (err) {
          digestFetchError = err;
        }
        if (!digestFetchError && digestMatches(staged, digestText)) {
          buffer = staged;
          setProgress({ phase: 'verifying', downloadedBytes: buffer.length, totalBytes: buffer.length, percent: 100 });
          updateLog(`apply: reusing the staged update from the blocked swap (${buffer.length} bytes)`);
        }
      }
    } catch (_) {}
    if (digestFetchError) {
      updateLog(`apply: could not fetch the published checksum to verify the staged update (${digestFetchError && digestFetchError.message ? digestFetchError.message : digestFetchError}); keeping the staged bytes for the next attempt`);
      throw new Error('Could not verify the staged update against its published SHA-256. Nothing was installed. Try again once the connection is back.');
    }
    if (!buffer) {
      try { fs.rmSync(stagingExe, { force: true }); } catch (_) {}
      try { fs.rmSync(resumeMarker, { force: true }); } catch (_) {}
    }
  }

  if (!buffer) {
    buffer = await downloadReleaseWithResume(targetUrl, targetBytes, stagingDir);

    if (buffer.length < 1024 * 1024) {
      updateLog(`apply refused: download is only ${buffer.length} bytes`);
      throw new Error('Downloaded update is incomplete or corrupt (too small).');
    }

    if (targetBytes > 0 && buffer.length !== targetBytes) {
      updateLog(`apply refused: size mismatch (${buffer.length} vs expected ${targetBytes} bytes)`);
      throw new Error(`Downloaded update size mismatch (${buffer.length} vs expected ${targetBytes} bytes).`);
    }

    setProgress({ phase: 'verifying', downloadedBytes: buffer.length, totalBytes: buffer.length, percent: 100 });
    // The byte size above can be chosen by the caller, so it is not an integrity
    // check. This one is: the published SHA-256 must match the downloaded bytes
    // before anything touches the disk.
    if (!digestMatches(buffer, await fetchPublishedDigest(targetUrl))) {
      updateLog('apply refused: the download does not match the published SHA-256');
      throw new Error('Downloaded update failed its SHA-256 checksum. Nothing was installed.');
    }

    fs.writeFileSync(stagingExe, buffer);
    updateLog(`apply: checksum verified, ${buffer.length} bytes staged at ${stagingExe}`);
  }
  setProgress({ phase: 'restarting', percent: 100 });
  // The marker's presence is what makes a blocked swap resumable; the helper
  // deletes it only after the copy lands.
  fs.writeFileSync(resumeMarker, JSON.stringify({ url: targetUrl, version: targetVersion, bytes: buffer.length }), 'utf8');

  // Write apply_update.cmd helper script
  const scriptPath = path.join(stagingDir, 'apply_update.cmd');
  const handoffLog = path.join(stagingDir, 'TechPartsPOS_update.handoff.log');
  const oldSizePath = path.join(stagingDir, 'oldsize.txt');
  fs.writeFileSync(scriptPath, buildApplyScript({
    stagingExe, targetExe: currentExe, resumeMarker, handoffLog, oldSizePath, serviceMode
  }), 'utf8');

  // Detached and unref'd below. Tests never reach here: they set skipSpawn so a
  // test run can never move a real executable or spawn the swap.
  if (!(testHooks && testHooks.skipSpawn)) {
    // Windows refuses to overwrite a running image but lets it be renamed, and
    // the rename is what frees the path for the helper's first copy. The twin
    // it leaves behind is also the exit signal the helper polls.
    const oldExe = `${currentExe}.old`;
    try {
      fs.rmSync(oldExe, { force: true });
      fs.renameSync(currentExe, oldExe);
    } catch (err) {
      updateLog(`apply refused: the running executable could not be moved aside (${err.code || err.message})`);
      throw new Error('Could not move the running program aside, so nothing was installed. Close TechParts POS and copy the release download over it.');
    }
    // Record the twin's size for :restore: a rollback that renames back a
    // foreign or truncated .old otherwise starts a binary nobody staged.
    try {
      fs.writeFileSync(path.join(stagingDir, 'oldsize.txt'), String(fs.statSync(oldExe).size), 'utf8');
    } catch (_) {}
    try {
      const helper = spawn('cmd.exe', ['/c', scriptPath], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true
      });
      helper.unref();
    } catch (err) {
      try { fs.renameSync(oldExe, currentExe); } catch (_) {}
      updateLog(`apply refused: the swap helper could not be started (${err.code || err.message})`);
      throw new Error('The update could not be handed over, so nothing was installed and the program was left where it was.');
    }
    updateLog('apply: helper launched, restarting to finish the swap');
  }

  return {
    success: true,
    runningInDev: false,
    url: targetUrl,
    version: targetVersion,
    message: 'Update downloaded. Restarting TechParts POS...'
  };
}

module.exports = {
  REPO,
  CURRENT_VERSION,
  parseVersionParts,
  isRemoteNewer,
  isTrustedReleaseUrl,
  isTrustedPageUrl,
  resolveTrustedReleaseUrl,
  digestUrlFor,
  digestMatches,
  buildApplyScript,
  defaultUpdateStagingDir,
  consumeHandoffStatus,
  setUpdateLogSink,
  setUpdateTestHooks,
  checkForUpdates,
  applyUpdate,
  getUpdateProgress
};
