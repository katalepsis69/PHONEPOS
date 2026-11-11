const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { verifyPinHash } = require('../src/auth');

const ROOT_DIR = path.join(__dirname, '..');

function runNode(script, args, options = {}) {
  return spawnSync(process.execPath, [path.join(ROOT_DIR, script), ...args], {
    cwd: ROOT_DIR,
    encoding: 'utf8',
    ...options
  });
}

test('license CLI rejects unknown arguments and invalid durations without a key', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'license-cli-test-'));
  try {
    const env = { ...process.env, TP_LICENSE_KEY_FILE: path.join(temp, 'must-not-exist.pem') };
    const unknown = runNode('scripts/generate-license.js', ['--unknown'], { env });
    assert.notEqual(unknown.status, 0);
    assert.match(unknown.stderr, /Invalid arguments/);

    const positional = runNode('scripts/generate-license.js', ['unexpected'], { env });
    assert.notEqual(positional.status, 0);
    assert.match(positional.stderr, /Invalid arguments/);

    const invalidDays = runNode('scripts/generate-license.js', ['--machine', 'TP-WIN-TEST-0001', '--days', 'nope'], { env });
    assert.notEqual(invalidDays.status, 0);
    assert.match(invalidDays.stderr, /Validity days/);
    assert.doesNotMatch(invalidDays.stderr, /No vendor private key/);
    assert.equal(fs.existsSync(env.TP_LICENSE_KEY_FILE), false);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('set-pin requires an explicit target and updates only that database transactionally', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'set-pin-test-'));
  const firstPath = path.join(temp, 'first.db');
  const secondPath = path.join(temp, 'second.db');
  function createDb(dbPath, pinHash) {
    const db = new DatabaseSync(dbPath);
    db.exec('CREATE TABLE shop_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    db.prepare('INSERT INTO shop_settings (key, value) VALUES (?, ?)').run('manager_pin_hash', pinHash);
    db.prepare('INSERT INTO shop_settings (key, value) VALUES (?, ?)').run('pin_failed_attempts', '4');
    db.prepare('INSERT INTO shop_settings (key, value) VALUES (?, ?)').run('pin_lockout_until', '999');
    db.prepare('INSERT INTO shop_settings (key, value) VALUES (?, ?)').run('report_token', 'old');
    db.close();
  }
  try {
    createDb(firstPath, 'first-original');
    createDb(secondPath, 'second-original');
    const implicit = runNode('scripts/set-pin.js', ['5678']);
    assert.notEqual(implicit.status, 0);
    assert.match(implicit.stderr, /--db/);

    const explicit = runNode('scripts/set-pin.js', ['--db', firstPath, '5678']);
    assert.equal(explicit.status, 0, explicit.stderr);
    const first = new DatabaseSync(firstPath, { readOnly: true });
    const second = new DatabaseSync(secondPath, { readOnly: true });
    assert.equal(verifyPinHash(first.prepare("SELECT value FROM shop_settings WHERE key = 'manager_pin_hash'").get().value, '5678').ok, true);
    assert.equal(first.prepare("SELECT value FROM shop_settings WHERE key = 'pin_failed_attempts'").get().value, '0');
    assert.notEqual(first.prepare("SELECT value FROM shop_settings WHERE key = 'report_token'").get().value, 'old');
    assert.equal(second.prepare("SELECT value FROM shop_settings WHERE key = 'manager_pin_hash'").get().value, 'second-original');
    first.close();
    second.close();
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('packaging scripts use staged outputs, pinned local postject, and scoped process cleanup', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'));
  const buildExe = fs.readFileSync(path.join(ROOT_DIR, 'scripts', 'build-exe.js'), 'utf8');
  const buildLicense = fs.readFileSync(path.join(ROOT_DIR, 'scripts', 'build-license-exe.js'), 'utf8');
  const launcher = fs.readFileSync(path.join(ROOT_DIR, 'start.bat'), 'utf8');

  assert.equal(packageJson.engines.node, '>=22.5.0');
  assert.equal(packageJson.devDependencies.postject, '1.0.0-alpha.6');
  assert.equal(packageJson.scripts['build:exe:artifacts'], 'node scripts/build-artifacts.js');
  assert.equal(packageJson.scripts['build:license-exe'], 'node scripts/build-license-exe.js');
  assert.match(packageJson.scripts['build:exe'], /release:customer/);
  assert.match(buildExe, /require\.resolve\('postject\/dist\/cli\.js'\)/);
  assert.match(buildLicense, /require\.resolve\('postject\/dist\/cli\.js'\)/);
  assert.doesNotMatch(buildExe + buildLicense, /\bnpx\b|taskkill|while \(Date\.now/);
  assert.doesNotMatch(launcher, /taskkill/i);
  assert.match(launcher, /SERVER_EXIT/);
});

// publish.bat's running-executable guard pipes tasklist into `find /i`. On a box
// where PATH resolves a GNU findutils `find` before System32, /i is not a flag it
// understands: the pipe dies, errorlevel lands on the wrong branch, and the guard
// silently stops guarding while the build overwrites a live exe. The absolute path
// is the whole fix, so it is pinned here rather than left to a comment.
test('publish.bat calls the Windows find by absolute path', () => {
  const bat = fs.readFileSync(path.join(ROOT_DIR, 'publish.bat'), 'utf8');
  // The exact guard line: tasklist piped into %SystemRoot%\System32\find.exe.
  assert.ok(bat.includes('tasklist /fi "imagename eq TechPartsPOS.exe" 2>nul | "%SystemRoot%\\System32\\find.exe" /i "TechPartsPOS.exe"'),
    'the running-executable guard no longer calls Windows find by absolute path');
  assert.ok(!bat.includes('| find /i'), 'a bare `find` is back on the pipe, and a GNU findutils earlier on PATH defeats the guard');
  assert.match(bat, /--help/, 'publish.bat must support --help');
  assert.match(bat, /--skip-tests/, 'publish.bat must support --skip-tests');
  assert.match(bat, /--clean/, 'publish.bat must support --clean');
  assert.match(bat, /--dry-run/, 'publish.bat must support --dry-run');
  assert.match(bat, /--no-pause/, 'publish.bat must support --no-pause');
});

test('publish.bat CLI help and dry-run execution on Windows', (t) => {
  if (process.platform !== 'win32') {
    t.skip('Batch file execution requires Windows');
    return;
  }
  const help = spawnSync('cmd.exe', ['/c', 'publish.bat --help'], { cwd: ROOT_DIR, encoding: 'utf8' });
  assert.equal(help.status, 0, `publish.bat --help failed: ${help.stderr}`);
  assert.match(help.stdout, /Usage: publish\.bat \[options\]/);
  assert.match(help.stdout, /--skip-tests/);
  assert.match(help.stdout, /--clean/);

  const dryRun = spawnSync('cmd.exe', ['/c', 'publish.bat --dry-run'], { cwd: ROOT_DIR, encoding: 'utf8' });
  assert.equal(dryRun.status, 0, `publish.bat --dry-run failed: ${dryRun.stderr}`);
  assert.match(dryRun.stdout, /\[DRY RUN\] Pre-flight checks passed successfully/);
  assert.match(dryRun.stdout, /Dependencies:\s+node_modules verified/);
});

test('publish-release.bat CLI help and argument normalization on Windows', (t) => {
  const batPath = path.join(ROOT_DIR, 'publish-release.bat');
  const bat = fs.readFileSync(batPath, 'utf8');
  assert.match(bat, /--dry-run/, 'publish-release.bat must support --dry-run');
  assert.match(bat, /--version/, 'publish-release.bat must support --version');
  assert.match(bat, /--changelog/, 'publish-release.bat must support --changelog');
  assert.match(bat, /--non-interactive/, 'publish-release.bat must support --non-interactive');
  assert.match(bat, /--no-pause/, 'publish-release.bat must support --no-pause');
  assert.ok(bat.includes('tasklist /fi "imagename eq TechPartsPOS.exe" 2>nul | "%SystemRoot%\\System32\\find.exe" /i "TechPartsPOS.exe"'),
    'publish-release.bat must guard against running TechPartsPOS.exe');

  if (process.platform !== 'win32') {
    t.skip('Batch file execution requires Windows');
    return;
  }
  const help = spawnSync('cmd.exe', ['/c', 'publish-release.bat --help'], { cwd: ROOT_DIR, encoding: 'utf8' });
  assert.equal(help.status, 0, `publish-release.bat --help failed: ${help.stderr}`);
  assert.match(help.stdout, /Usage: publish-release\.bat \[options\]/);
  assert.match(help.stdout, /-d, --dry-run/);
  assert.match(help.stdout, /-v, --version/);
});

// The release pipeline had no test at all (grep: no match for publish-release
// in tests/). A full dry run needs a repo and a token, so the cheap gate is a
// real PowerShell parse plus pins on the sequencing that keeps a failed publish
// from advertising a partial release: nothing becomes "latest" until every
// asset (exe, zip, .sha256) has landed.
test('publish-release.ps1 parses and stays a draft until every asset is uploaded', (t) => {
  const ps1 = path.join(ROOT_DIR, 'scripts', 'publish-release.ps1');
  const source = fs.readFileSync(ps1, 'utf8');

  assert.match(source, /#define MyAppVersion/, 'the installer version is no longer rewritten');
  assert.match(source, /draft\s*=\s*\$true/, 'the release must be created (or re-opened) as a draft');
  assert.match(source, /draft\s*=\s*\$false/, 'the release must be published after the uploads');
  const lastUpload = source.lastIndexOf('Upload-ReleaseAsset');
  const publish = source.indexOf('draft = $false');
  assert.ok(lastUpload > 0 && publish > lastUpload, 'publishing must happen after the last asset upload');
  assert.match(source, /TechPartsPOS\.exe\.sha256/, 'the checksum asset the updater requires is gone');

  const probe = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0) {
    t.skip('PowerShell is not available on this machine');
    return;
  }
  const parse = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    `$null = [scriptblock]::Create((Get-Content -Raw -LiteralPath '${ps1.replace(/'/g, "''")}')); 'PARSE_OK'`
  ], { encoding: 'utf8' });
  assert.equal(parse.status, 0, `PowerShell could not parse publish-release.ps1: ${parse.stderr}`);
  assert.match(parse.stdout, /PARSE_OK/);
});

test('publish-release provides non-technical user release notes with zero em dashes', () => {
  const notesPath = path.join(ROOT_DIR, 'RELEASE_NOTES.md');
  assert.ok(fs.existsSync(notesPath), 'RELEASE_NOTES.md must exist in repo root');
  const notes = fs.readFileSync(notesPath, 'utf8');

  // Anti-slop: plain English, zero em dashes
  assert.doesNotMatch(notes, /—/, 'RELEASE_NOTES.md must not contain em dashes');

  // Must describe practical user features and how they work
  assert.match(notes, /Spreadsheet Import/i);
  assert.match(notes, /Automatic Price Calculation/i);
  assert.match(notes, /Helpful Tips/i);
  assert.match(notes, /Thermal Receipt Printing/i);
  assert.match(notes, /Offline/i);
  assert.match(notes, /Keyboard Shortcuts/i);
  assert.match(notes, /How to Update/i);

  // publish-release.ps1 must wire RELEASE_NOTES.md and default release notes
  const ps1 = fs.readFileSync(path.join(ROOT_DIR, 'scripts', 'publish-release.ps1'), 'utf8');
  assert.match(ps1, /RELEASE_NOTES\.md/, 'publish-release.ps1 must check for RELEASE_NOTES.md');
  assert.match(ps1, /Get-DefaultReleaseNotes/, 'publish-release.ps1 must define default non-technical release notes');
  assert.match(ps1, /Keyboard Shortcuts/i, 'publish-release.ps1 default notes must include shortcuts');
  assert.doesNotMatch(ps1, /—/, 'publish-release.ps1 must not contain em dashes');
});

test('cloud rotate-pin writes the new manager PIN only to its 0600 file, never stdout', () => {
  // The PIN must not land in a systemd journal or tmux pane: the mint paths
  // print the credential file's PATH only. Both copies of the cloud server
  // (cloud/ is the deploy mirror of cloud-deploy/) must obey the same rule.
  for (const rel of ['cloud-deploy/server.js', 'cloud/server.js']) {
    const src = fs.readFileSync(path.join(ROOT_DIR, ...rel.split('/')), 'utf8');
    const block = src.slice(src.indexOf("--rotate-pin'"));
    assert.ok(block.length > 0 && block.length < src.length, `${rel} must contain the rotate-pin block`);
    assert.doesNotMatch(block, /Manager PIN: \$\{pin\}/, `${rel} must not echo the rotated PIN to stdout`);
    assert.match(block, /MANAGER_PIN_PATH/, `${rel} must name the file the PIN was saved to`);
  }
});

test('publish-release.ps1 parses --version and --changelog flags without positional collision', (t) => {
  const probe = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0) {
    t.skip('PowerShell is not available on this machine');
    return;
  }
  const ps1Path = path.join(ROOT_DIR, 'scripts', 'publish-release.ps1');
  const src = fs.readFileSync(ps1Path, 'utf8');
  // Extract param block + CLI argument loop only (up to $ErrorActionPreference)
  const header = src.slice(0, src.indexOf('$ErrorActionPreference'));
  const runner = `${header}\nWrite-Output ("VER=" + $Version + "|NOTE=" + $Changelog + "|DRY=" + [bool]$DryRun + "|NON=" + [bool]$NonInteractive)`;
  const wrapped = `& { ${runner} } --version 2.9 --changelog "Test Note" --dry-run --non-interactive`;
  const res = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', wrapped], { encoding: 'utf8' });
  assert.equal(res.status, 0, `publish-release param parser failed: ${res.stderr}`);
  assert.match(res.stdout, /VER=2\.9\|NOTE=Test Note\|DRY=True\|NON=True/);

  assert.match(src, /if \(-not \[string\]::IsNullOrWhiteSpace\(\$Version\)\)/, 'publish-release.ps1 must apply non-empty -Version overrides');
});

test('Inno Setup installer script configures SYSTEM service, ACLs, and preserves data', () => {
  const issPath = path.join(ROOT_DIR, 'installer', 'TechPartsPOS.iss');
  assert.ok(fs.existsSync(issPath), 'installer/TechPartsPOS.iss must exist');
  const iss = fs.readFileSync(issPath, 'utf8');

  assert.match(iss, /DisableDirPage\s*=\s*yes/i, 'installer must lock installation directory via DisableDirPage=yes');
  assert.match(iss, /\*S-1-5-18:\(OI\)\(CI\)F/, 'installer must lock ProgramData to SYSTEM via S-1-5-18:(OI)(CI)F');
  assert.match(iss, /\*S-1-5-32-545:\(OI\)\(CI\)R/, 'installer must grant standard users read access to runtime via S-1-5-32-545:(OI)(CI)R');
  assert.match(iss, /<BootTrigger>/, 'service task XML must include BootTrigger');
  assert.match(iss, /<LogonTrigger>/, 'service task XML must include LogonTrigger');
  assert.match(iss, /PT0S/, 'service task XML must set ExecutionTimeLimit to PT0S');
  assert.match(iss, /IgnoreNew/, 'service task XML must set MultipleInstancesPolicy to IgnoreNew');
  assert.match(iss, /TechPartsPOS-Server/, 'scheduled task name must be TechPartsPOS-Server');
  assert.match(iss, /PrepareToInstall/, 'installer must implement PrepareToInstall to stop service');
  assert.match(iss, /InitializeUninstall/, 'installer must implement InitializeUninstall to stop service');

  const uninstallDeleteSection = iss.split(/\[UninstallDelete\]/i)[1]?.split(/\[/)[0] || '';
  assert.doesNotMatch(uninstallDeleteSection, /\{commonappdata\}\\TechPartsPOS|ProgramData\\TechPartsPOS/i, 'UninstallDelete must never delete ProgramData/TechPartsPOS');
});

test('build-installer.js checks Inno Setup 7 locations and reads package.json version', () => {
  const scriptPath = path.join(ROOT_DIR, 'scripts', 'build-installer.js');
  assert.ok(fs.existsSync(scriptPath), 'scripts/build-installer.js must exist');
  const content = fs.readFileSync(scriptPath, 'utf8');

  assert.match(content, /Inno Setup 7.*ISCC\.exe/, 'build-installer.js must check Inno Setup 7');
  assert.match(content, /LOCALAPPDATA.*Programs.*Inno Setup 7/i, 'build-installer.js must check Inno Setup 7 in LOCALAPPDATA');
  assert.match(content, /Program Files.*Inno Setup 7/i, 'build-installer.js must check Inno Setup 7 in Program Files');
  assert.match(content, /package\.json/, 'build-installer.js must read version from package.json');
});

test('publish-release.ps1 builds and uploads Setup installer without zip packaging', () => {
  const ps1Path = path.join(ROOT_DIR, 'scripts', 'publish-release.ps1');
  const ps1 = fs.readFileSync(ps1Path, 'utf8');

  assert.match(ps1, /TechPartsPOS-Setup-/, 'publish-release.ps1 must build and upload Setup installer');
  assert.doesNotMatch(ps1, /Compress-Archive/, 'publish-release.ps1 must not create zip archives');
  assert.doesNotMatch(ps1, /application\/zip/, 'publish-release.ps1 must not upload zip archives');
  assert.doesNotMatch(ps1, /TechPartsPOS-\$tag\.zip/, 'publish-release.ps1 must not reference zip releases');
  assert.doesNotMatch(ps1, /—/, 'publish-release.ps1 must contain zero em dashes');
});

