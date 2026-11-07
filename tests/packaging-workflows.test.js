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
