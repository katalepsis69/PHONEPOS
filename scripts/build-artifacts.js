const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT_DIR = path.join(__dirname, '..');
const DIST_DIR = path.join(ROOT_DIR, 'dist');
const artifacts = ['TechPartsPOS.exe', 'LicenseGenerator.exe'];
const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'techparts-build-'));

// A running exe can be renamed but not deleted or overwritten, which used to
// detonate mid-promotion with a raw EPERM stack. Check before any build work.
function assertTargetsUnlocked() {
  for (const name of artifacts) {
    const target = path.join(DIST_DIR, name);
    if (!fs.existsSync(target)) continue;
    try {
      fs.accessSync(target, fs.constants.W_OK);
    } catch {
      throw new Error(
        `${name} is locked, it is probably still running. Close the POS ` +
        `(or run: taskkill /im TechPartsPOS.exe), then rebuild.`
      );
    }
  }
}

// Leftover .previous backups can still be running-process images. Deleting one
// is housekeeping, not a build result: warn and leave it for the next run.
function removeBackup(file) {
  try {
    fs.rmSync(file, { force: true });
  } catch (err) {
    if (!['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) throw err;
    console.warn(`Warning: could not remove ${file} (${err.code}); left in place, the next build will retry.`);
  }
}

function assertSupportedNode() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 5)) {
    throw new Error(`Node.js >=22.5.0 is required to build; found ${process.version}`);
  }
}

function promoteStagedArtifacts() {
  fs.mkdirSync(DIST_DIR, { recursive: true });
  const promotions = [];
  try {
    for (const name of artifacts.flatMap(name => [name, `${name}.manifest.json`])) {
      const staged = path.join(stageDir, name);
      if (!fs.existsSync(staged)) throw new Error(`staged output missing: ${name}`);
      const target = path.join(DIST_DIR, name);
      const backup = `${target}.previous`;
      removeBackup(backup);
      const hadTarget = fs.existsSync(target);
      if (hadTarget) {
        fs.renameSync(target, backup);
      }
      promotions.push([target, backup, hadTarget]);
      fs.renameSync(staged, target);
    }
    for (const [, backup] of promotions) removeBackup(backup);
  } catch (error) {
    for (const [target, backup, hadTarget] of promotions.slice().reverse()) {
      if (fs.existsSync(target)) fs.renameSync(target, `${target}.failed`);
      if (hadTarget && fs.existsSync(backup)) fs.renameSync(backup, target);
      try { fs.rmSync(`${target}.failed`, { force: true }); } catch (_) {}
    }
    if (['EPERM', 'EBUSY'].includes(error.code)) {
      throw new Error(
        `Promotion failed (${error.code}) on ${error.path}. One of the exes is ` +
        `probably still running; close the POS and rebuild.`, { cause: error }
      );
    }
    throw error;
  }
}

try {
  assertSupportedNode();
  assertTargetsUnlocked();
  const env = { ...process.env, BUILD_OUTPUT_DIR: stageDir };
  execFileSync(process.execPath, [path.join(__dirname, 'build-exe.js')], { cwd: ROOT_DIR, env, stdio: 'inherit' });
  execFileSync(process.execPath, [path.join(__dirname, 'build-license-exe.js')], { cwd: ROOT_DIR, env, stdio: 'inherit' });
  execFileSync(process.execPath, [path.join(__dirname, 'verify-exe.js')], { cwd: ROOT_DIR, env, stdio: 'inherit' });
  promoteStagedArtifacts();
} finally {
  fs.rmSync(stageDir, { recursive: true, force: true });
}
