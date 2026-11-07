// phone-repair-pos/scripts/build-license-exe.js
// Packages the vendor license generator as a standalone .exe (same Node SEA
// mechanism as build-exe.js). Vendor-only tool: the private key is NEVER
// bundled — the exe reads vendor-private-key.pem from its own folder at
// runtime (or TP_LICENSE_KEY_FILE). Keep this exe out of customer hands.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { copyExeWithRetry, generateLoaderBundle, writeBuildManifest } = require('./build-common');

const ROOT_DIR = path.join(__dirname, '..');
const DIST_DIR = process.env.BUILD_OUTPUT_DIR || path.join(ROOT_DIR, 'dist', '.staging-license');
const POSTJECT_CLI = require.resolve('postject/dist/cli.js');

console.log('======================================================');
console.log(' Building LicenseGenerator Standalone Executable (.exe)');
console.log('======================================================\n');

if (!fs.existsSync(DIST_DIR)) {
  fs.mkdirSync(DIST_DIR, { recursive: true });
}

const temporaryFiles = ['license-bundle.js', 'license-sea-config.json', 'license-sea-prep.blob'];

try {
// 1. Bundle src/license.js + scripts/generate-license.js
console.log('[1/3] Bundling license generator code...');
const licenseCode = fs.readFileSync(path.join(ROOT_DIR, 'src', 'license.js'), 'utf8');
const cliCode = fs.readFileSync(path.join(__dirname, 'generate-license.js'), 'utf8');

const bundleContent = generateLoaderBundle({
  banner: '// TechParts LicenseGenerator Standalone Executable Bundle',
  modules: {
    './license': licenseCode,
    './../src/license': licenseCode,
    './generate-license': cliCode
  },
  entryCode: "__require__('./generate-license');"
});

const bundlePath = path.join(DIST_DIR, 'license-bundle.js');
fs.writeFileSync(bundlePath, bundleContent, 'utf8');

// 2. Generate the SEA blob
console.log('[2/3] Generating Node Single Executable Application blob...');
const seaConfig = {
  main: bundlePath,
  output: path.join(DIST_DIR, 'license-sea-prep.blob'),
  disableExperimentalSEAWarning: true,
  useCodeCache: true
};
const seaConfigPath = path.join(DIST_DIR, 'license-sea-config.json');
fs.writeFileSync(seaConfigPath, JSON.stringify(seaConfig, null, 2), 'utf8');

execFileSync(process.execPath, ['--experimental-sea-config', seaConfigPath], { stdio: 'inherit', cwd: ROOT_DIR });

// 3. Copy node.exe to LicenseGenerator.exe and inject the blob
console.log('[3/3] Injecting code into standalone LicenseGenerator.exe binary...');
const targetExePath = path.join(DIST_DIR, 'LicenseGenerator.exe');

copyExeWithRetry('LicenseGenerator.exe', targetExePath);

execFileSync(process.execPath, [POSTJECT_CLI, targetExePath, 'NODE_SEA_BLOB', path.join(DIST_DIR, 'license-sea-prep.blob'), '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'], {
  stdio: 'inherit',
  cwd: ROOT_DIR
});
writeBuildManifest(DIST_DIR, 'LicenseGenerator.exe', [
  path.join(ROOT_DIR, 'package.json'),
  path.join(ROOT_DIR, 'package-lock.json'),
  process.execPath,
  require.resolve('postject/package.json'),
  POSTJECT_CLI,
  path.join(ROOT_DIR, 'src', 'license.js'),
  path.join(__dirname, 'build-common.js'),
  path.join(__dirname, 'build-license-exe.js'),
  path.join(__dirname, 'generate-license.js')
]);

console.log('\n======================================================');
console.log(' BUILD SUCCESSFUL!');
console.log(` Output Executable: ${targetExePath}`);
console.log(' Reads the vendor private key from next to the exe');
console.log(' (vendor-private-key.pem) or TP_LICENSE_KEY_FILE.');
console.log('======================================================\n');
} finally {
  for (const tmpFile of temporaryFiles) {
    try { fs.rmSync(path.join(DIST_DIR, tmpFile), { force: true }); } catch (_) {}
  }
}
