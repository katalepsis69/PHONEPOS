// Mirror the workstation backup folder to a second disk or a network share.
// Automatic backups land beside the database, so they survive a bad day but
// not a dead disk. Windows-only by design (robocopy). Schedule it daily:
//   schtasks /Create /SC DAILY /TN TechPartsMirror ^
//     /TR "node C:\\TechParts\\scripts\\mirror-backups.js" /ST 21:00
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { getBaseDir } = require('../src/db');

// The packaged exe relocates data to %LOCALAPPDATA%\TechPartsPOS while this
// script (running under node) would otherwise resolve the project folder, so
// on an exe install it mirrored stale files while the live backups sat in
// LOCALAPPDATA. Prefer the exe home whenever its live database exists;
// POS_BACKUP_DIR still wins for explicit setups.
const exeHome = path.join(process.env.LOCALAPPDATA || '', 'TechPartsPOS');
const src = process.env.POS_BACKUP_DIR
  || (fs.existsSync(path.join(exeHome, 'data', 'shop.db')) ? path.join(exeHome, 'backups') : path.join(getBaseDir(), 'backups'));
const dest = process.env.POS_BACKUP_MIRROR;
// A zip-extract install (the README's own instruction) keeps its data beside
// the exe, so the repo-resolution above can land on the CHECKOUT's backups and
// mirror unrelated snapshots while printing PASS. The off-machine copy the
// operator trusts is the data-loss path, so a source without a recent snapshot
// fails loudly instead of reporting success.
const MAX_AGE_HOURS = Number(process.env.POS_BACKUP_MAX_AGE_HOURS) > 0
  ? Number(process.env.POS_BACKUP_MAX_AGE_HOURS)
  : 30;

function newestSnapshotMs(dir) {
  let newest = 0;
  for (const f of fs.readdirSync(dir)) {
    if (!/^shop(_backup)?_.*\.db$/.test(f)) continue;
    const m = fs.statSync(path.join(dir, f)).mtimeMs;
    if (m > newest) newest = m;
  }
  return newest;
}

if (!dest) {
  console.error('FAIL set POS_BACKUP_MIRROR to a folder on a second disk or share, e.g. \\\\nas\\pos-backups');
  process.exitCode = 2;
} else if (!fs.existsSync(src)) {
  console.error(`FAIL backup folder not found: ${src}. Point POS_BACKUP_DIR at the live install's backups folder.`);
  process.exitCode = 2;
} else if (!(newestSnapshotMs(src) > Date.now() - MAX_AGE_HOURS * 3600000)) {
  const newest = newestSnapshotMs(src);
  console.error(`FAIL ${src} holds no snapshot newer than ${MAX_AGE_HOURS}h (newest: ${newest ? new Date(newest).toISOString() : 'none'}). `
    + 'This is probably not the live install: set POS_BACKUP_DIR to its backups folder.');
  process.exitCode = 2;
} else {
  // Args array, never a shell string: a path with spaces or quotes must not
  // become a command line.
  const r = spawnSync('robocopy', [src, dest, 'shop-*.db', 'shop_backup_*.db', '/NJH', '/NJS', '/R:2', '/W:5'], { encoding: 'utf8' });
  if (r.error) {
    console.error(`FAIL robocopy could not run: ${r.error.message}`);
    process.exitCode = 1;
  } else if (r.status > 7) {
    // robocopy reports success as 0-7, not 0.
    console.error(`FAIL robocopy exited with ${r.status}`);
    process.exitCode = 1;
  } else {
    console.log(`PASS mirrored ${src} to ${dest}`);
  }
}
