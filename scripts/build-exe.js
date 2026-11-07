// phone-repair-pos/scripts/build-exe.js
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { copyExeWithRetry, generateLoaderBundle, setWindowsGuiSubsystem, writeBuildManifest } = require('./build-common');

const ROOT_DIR = path.join(__dirname, '..');
const DIST_DIR = process.env.BUILD_OUTPUT_DIR || path.join(ROOT_DIR, 'dist', '.staging-pos');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const POSTJECT_CLI = require.resolve('postject/dist/cli.js');

console.log('======================================================');
console.log(' Building TechParts POS Standalone Executable (.exe)');
console.log('======================================================\n');

fs.mkdirSync(DIST_DIR, { recursive: true });

const temporaryFiles = ['bundle.js', 'sea-config.json', 'sea-prep.blob'];

try {
// 1. Read static assets to embed as in-memory fallback
console.log('[1/4] Embedding public/ static assets...');
const staticFiles = {};
const publicInputFiles = [];
// Embed by extension, not a hand-kept list: a forgotten entry ships an unstyled .exe.
// Recurses into subdirectories (public/js/, public/js/views/): index.html loads the
// frontend as ES modules from /js/*, so a flat scan ships a broken app.
// tailwind.css is source for the CSS build, not served. Binaries (user-dropped QR
// PNGs) stay on disk — the embedded fallback is utf8-only, except woff2 fonts
// which embed as Buffers (served binary by server.js's static branch).
(function walk(dir, prefix) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'tailwind.css') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, `${prefix}/${entry.name}`);
      continue;
    }
    if (!/\.(html|css|js|json|svg|woff2)$/.test(entry.name)) continue;
    publicInputFiles.push(full);
    staticFiles[`${prefix}/${entry.name}`] = entry.name.endsWith('.woff2')
      ? fs.readFileSync(full)
      : fs.readFileSync(full, 'utf8');
  }
})(PUBLIC_DIR, '');

// 2. Read and bundle backend source files using CommonJS micro-loader
console.log('[2/4] Bundling backend source code into dist/bundle.js...');

const srcDir = path.join(ROOT_DIR, 'src');
const srcFileNames = fs.readdirSync(srcDir).filter(f => f.endsWith('.js'));

const modules = {};
for (const fname of srcFileNames) {
  const modName = fname.replace(/\.js$/, '');
  modules[`./${modName}`] = fs.readFileSync(path.join(srcDir, fname), 'utf8');
}

const bundleContent = generateLoaderBundle({
  banner: '// TechParts POS Standalone Executable Bundle',
  staticFiles,
  modules,
  entryCode: "__require__('./server');"
});

const bundlePath = path.join(DIST_DIR, 'bundle.js');
fs.writeFileSync(bundlePath, bundleContent, 'utf8');

// 3. Generate sea-config.json and sea-prep.blob
console.log('[3/4] Generating Node Single Executable Application blob...');
const seaConfig = {
  main: path.join(DIST_DIR, 'bundle.js'),
  output: path.join(DIST_DIR, 'sea-prep.blob'),
  disableExperimentalSEAWarning: true,
  useCodeCache: true
};
const seaConfigPath = path.join(DIST_DIR, 'sea-config.json');
fs.writeFileSync(seaConfigPath, JSON.stringify(seaConfig, null, 2), 'utf8');

execFileSync(process.execPath, ['--experimental-sea-config', seaConfigPath], { stdio: 'inherit', cwd: ROOT_DIR });

// 4. Copy node.exe to TechPartsPOS.exe and inject blob
console.log('[4/4] Injecting code into standalone TechPartsPOS.exe binary...');
const targetExePath = path.join(DIST_DIR, 'TechPartsPOS.exe');

copyExeWithRetry('TechPartsPOS.exe', targetExePath);

execFileSync(process.execPath, [POSTJECT_CLI, targetExePath, 'NODE_SEA_BLOB', path.join(DIST_DIR, 'sea-prep.blob'), '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'], {
  stdio: 'inherit',
  cwd: ROOT_DIR
});

// Patch PE header subsystem to GUI (2) to hide the console window when double-clicked on Windows
console.log('Setting TechPartsPOS.exe to Windows GUI subsystem (no console window)...');
if (!setWindowsGuiSubsystem(targetExePath)) {
  throw new Error('Failed to set TechPartsPOS.exe Windows GUI subsystem');
}
writeBuildManifest(DIST_DIR, 'TechPartsPOS.exe', [
  path.join(ROOT_DIR, 'package.json'),
  path.join(ROOT_DIR, 'package-lock.json'),
  process.execPath,
  require.resolve('postject/package.json'),
  POSTJECT_CLI,
  path.join(__dirname, 'build-common.js'),
  path.join(__dirname, 'build-exe.js'),
  ...publicInputFiles,
  ...srcFileNames.map(file => path.join(srcDir, file))
]);

console.log('\n======================================================');
console.log(' BUILD SUCCESSFUL!');
console.log(` Output Executable: ${targetExePath}`);
console.log('======================================================\n');
} finally {
  for (const tmpFile of temporaryFiles) {
    try { fs.rmSync(path.join(DIST_DIR, tmpFile), { force: true }); } catch (_) {}
  }
}
