const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT_DIR = path.join(__dirname, '..');
const ISS_PATH = path.join(ROOT_DIR, 'installer', 'TechPartsPOS.iss');
const REQUIRED_INPUT = path.join(ROOT_DIR, 'release', 'customer', 'TechPartsPOS.exe');

// Common Inno Setup 7 and 6/5 install locations (standalone + chocolatey/scoop layouts).
const ISCC_CANDIDATES = [
  process.env.INNO_SETUP_ISCC, // explicit override via env var
  path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Inno Setup 7', 'ISCC.exe'),
  'C:\\Program Files\\Inno Setup 7\\ISCC.exe',
  'C:\\Program Files (x86)\\Inno Setup 7\\ISCC.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Inno Setup 6', 'ISCC.exe'),
  'C:\\Program Files\\Inno Setup 6\\ISCC.exe',
  'C:\\Program Files (x86)\\Inno Setup 6\\ISCC.exe',
  'C:\\Program Files (x86)\\Inno Setup 5\\ISCC.exe',
].filter(Boolean);

function findIscc() {
  for (const candidate of ISCC_CANDIDATES) {
    if (fs.existsSync(candidate)) return candidate;
  }
  try {
    const whereOut = execFileSync('where.exe', ['ISCC.exe'], { encoding: 'utf8' }).trim().split(/\r?\n/)[0];
    if (whereOut && fs.existsSync(whereOut)) return whereOut;
  } catch {}
  throw new Error(
    'Inno Setup 7/6 not found. Install Inno Setup 7 from https://jrsoftware.org/isinfo.php ' +
    'or set the INNO_SETUP_ISCC environment variable to the full path of ISCC.exe.'
  );
}

function getAppVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'));
    if (pkg.version) return pkg.version;
  } catch {}
  return process.env.npm_package_version || '1.0.0';
}

if (require.main === module) {
  try {
    if (!fs.existsSync(REQUIRED_INPUT)) {
      throw new Error(`release/customer/TechPartsPOS.exe is missing; run "npm run build:exe" first`);
    }
    const iscc = findIscc();
    const version = getAppVersion();
    console.log(`[*] Compiling installer v${version} with ${iscc} ...`);
    execFileSync(iscc, [`/Qp`, `/DMyAppVersion=${version}`, ISS_PATH], { cwd: ROOT_DIR, stdio: 'inherit' });
    const output = path.join(ROOT_DIR, 'dist', 'installer', `TechPartsPOS-Setup-${version}.exe`);
    console.log(`PASS installer: ${fs.existsSync(output) ? output : 'dist/installer/ (see ISCC output above)'}`);
  } catch (error) {
    console.error(`FAIL ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { findIscc, getAppVersion };
