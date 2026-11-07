const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT_DIR = path.join(__dirname, '..');
const DIST_DIR = path.join(ROOT_DIR, 'dist');
const RELEASE_DIR = path.join(ROOT_DIR, 'release', 'customer');
const ALLOWED_FILES = new Set(['TechPartsPOS.exe']);
const FORBIDDEN_NAMES = /(^|[\\/])(data|backups|vendor-private-key\.pem|LicenseGenerator\.exe)([\\/]|$)/i;

function verifyCustomerRelease(releaseDir = RELEASE_DIR) {
  if (!fs.existsSync(releaseDir)) throw new Error(`customer release does not exist: ${releaseDir}`);
  const entries = fs.readdirSync(releaseDir, { withFileTypes: true });
  if (entries.some(entry => !entry.isFile())) throw new Error('customer release must contain regular files only');
  const names = entries.map(entry => entry.name);
  if (names.some(name => FORBIDDEN_NAMES.test(name))) throw new Error('customer release contains private or live-state material');
  if (names.length !== ALLOWED_FILES.size || names.some(name => !ALLOWED_FILES.has(name))) {
    throw new Error(`customer release must contain only: ${[...ALLOWED_FILES].join(', ')}`);
  }
  const exe = path.join(releaseDir, 'TechPartsPOS.exe');
  if (!fs.statSync(exe).isFile() || fs.statSync(exe).size === 0) throw new Error('customer executable is missing or empty');
  return names;
}

function createCustomerRelease() {
  const source = path.join(DIST_DIR, 'TechPartsPOS.exe');
  if (!fs.existsSync(source)) throw new Error('dist/TechPartsPOS.exe is missing; build and verify artifacts first');
  const releaseRoot = path.dirname(RELEASE_DIR);
  fs.mkdirSync(releaseRoot, { recursive: true });
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'techparts-customer-release-'));
  const previous = `${RELEASE_DIR}.previous`;
  try {
    fs.copyFileSync(source, path.join(stage, 'TechPartsPOS.exe'));
    verifyCustomerRelease(stage);
    fs.rmSync(previous, { recursive: true, force: true });
    if (fs.existsSync(RELEASE_DIR)) fs.renameSync(RELEASE_DIR, previous);
    try {
      fs.renameSync(stage, RELEASE_DIR);
    } catch (error) {
      if (fs.existsSync(previous)) fs.renameSync(previous, RELEASE_DIR);
      throw error;
    }
    fs.rmSync(previous, { recursive: true, force: true });
    verifyCustomerRelease(RELEASE_DIR);
    console.log(`PASS customer-release: ${RELEASE_DIR} contains TechPartsPOS.exe only`);
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

if (require.main === module) {
  try { createCustomerRelease(); } catch (error) {
    console.error(`FAIL ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { ALLOWED_FILES, FORBIDDEN_NAMES, verifyCustomerRelease, createCustomerRelease };
