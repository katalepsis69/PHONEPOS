// phone-repair-pos/tests/changelog.test.js
// Automated regression tests for changelog and release notes generation.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { execFileSync } = require('node:child_process');
const {
  generateReleaseHighlights,
  buildReleaseNotesMarkdown,
  updateChangelogFile,
  updateReleaseNotesFile,
  getPreviousTag
} = require('../scripts/generate-changelog');

const ROOT_DIR = path.resolve(__dirname, '..');

test('generateReleaseHighlights summarizes real git diff and ignores untouched features', () => {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'changelog-repo-'));
  const git = (args) => execFileSync('git', args, { cwd: tmpRepo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

  try {
    git(['init']);
    git(['config', 'user.email', 'test@example.com']);
    git(['config', 'user.name', 'Test User']);

    fs.mkdirSync(path.join(tmpRepo, 'public', 'js', 'views'), { recursive: true });
    fs.mkdirSync(path.join(tmpRepo, 'tests'), { recursive: true });
    fs.writeFileSync(path.join(tmpRepo, 'public', 'index.html'), '<button data-tab="appearance">Appearance</button>\n<table><th>Stock</th></table>\n', 'utf8');
    fs.writeFileSync(path.join(tmpRepo, 'public', 'js', 'views', 'pos.js'), 'export function renderBrandChips() {}\n', 'utf8');
    git(['add', '.']);
    git(['commit', '-m', 'Initial release']);
    git(['tag', 'v1.0']);

    // Edit an unrelated line in index.html + uncommitted fix in pos.js + test
    fs.writeFileSync(path.join(tmpRepo, 'public', 'index.html'), '<button data-tab="appearance">Appearance</button>\n<table><th>Stock</th><th title="Low-stock threshold">Min Stock Alert</th></table>\n', 'utf8');
    fs.writeFileSync(path.join(tmpRepo, 'public', 'js', 'views', 'pos.js'), 'export function renderBrandChips(inStock) { return inStock; }\n', 'utf8');
    fs.writeFileSync(path.join(tmpRepo, 'tests', 'pos.test.js'), "test('brand chips hide zero-stock items when In stock only is checked', () => {});\n", 'utf8');

    const isolatedChangelog = path.join(tmpRepo, 'CHANGELOG.md');
    const highlights = generateReleaseHighlights({
      version: '1.1',
      prevTag: 'v1.0',
      changelogPath: isolatedChangelog,
      repoDir: tmpRepo
    });

    assert.ok(Array.isArray(highlights) && highlights.length >= 2, 'must return highlights for each changed area');
    const joined = highlights.join('\n');
    assert.doesNotMatch(joined, /Settings Navigation Revamp/i, 'must not emit untouched Appearance tab feature');
    assert.doesNotMatch(joined, /1366x768/, 'must not emit unrelated 1366 ergonomics milestone');
    assert.match(joined, /Min Stock Alert/, 'must surface actual added UI label from diff');
    assert.match(joined, /brand chips hide zero-stock items/i, 'must surface newly added test summary from diff');
    for (const h of highlights) {
      assert.doesNotMatch(h, /—/, `Highlight must not contain em dash: ${h}`);
    }
    assert.equal(getPreviousTag('1.0', tmpRepo), '', 'getPreviousTag must not return v1.0 as prior to 1.0');
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});

test('generate-changelog CLI --stdout outputs notes without writing CHANGELOG.md or RELEASE_NOTES.md', () => {
  const clBefore = fs.readFileSync(path.join(ROOT_DIR, 'CHANGELOG.md'), 'utf8');
  const rnBefore = fs.readFileSync(path.join(ROOT_DIR, 'RELEASE_NOTES.md'), 'utf8');
  const out = execFileSync(process.execPath, ['scripts/generate-changelog.js', '--version', 'v1.1', '--stdout'], {
    cwd: ROOT_DIR,
    encoding: 'utf8'
  });
  assert.match(out, /# What is New in TechParts POS \(v1\.1\)/);
  assert.doesNotMatch(out, /Settings Navigation Revamp/i);
  assert.doesNotMatch(out, /—/);
  assert.equal(fs.readFileSync(path.join(ROOT_DIR, 'CHANGELOG.md'), 'utf8'), clBefore);
  assert.equal(fs.readFileSync(path.join(ROOT_DIR, 'RELEASE_NOTES.md'), 'utf8'), rnBefore);
});

test('updateChangelogFile writes Keep a Changelog structure and is idempotent', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'changelog-test-'));
  const testChangelog = path.join(tmpDir, 'CHANGELOG.md');

  try {
    const highlights = [
      'Counter Ergonomics: Compact spacing for 1366x768 screens.',
      'Automatic Rail Collapse: 68px icon rail saving 182px width.'
    ];

    // First write initializes file
    updateChangelogFile('2.2', highlights, testChangelog);
    assert.ok(fs.existsSync(testChangelog), 'CHANGELOG.md was created');
    let content = fs.readFileSync(testChangelog, 'utf8');

    assert.match(content, /^# Changelog/m, 'must have top-level # Changelog header');
    assert.match(content, /## \[v2\.2\] - \d{4}-\d{2}-\d{2}/, 'must have version and date');
    assert.match(content, /### Highlights & Changes/, 'must have Highlights & Changes subsection');
    assert.match(content, /Compact spacing for 1366x768 screens/, 'must include first highlight');
    assert.match(content, /## \[v2\.1\]/, 'must include historical release entries');
    assert.doesNotMatch(content, /—/, 'CHANGELOG.md must contain zero em dashes');

    // Second write with updated bullet should update in-place without duplicate header
    const updatedHighlights = [
      'Counter Ergonomics: Compact spacing for 1366x768 screens (updated).',
      'Automatic Rail Collapse: 68px icon rail saving 182px width.'
    ];
    updateChangelogFile('2.2', updatedHighlights, testChangelog);
    content = fs.readFileSync(testChangelog, 'utf8');

    const matches = content.match(/## \[v2\.2\]/g);
    assert.equal(matches.length, 1, 'idempotent update must not duplicate version header');
    assert.match(content, /\(updated\)/, 'must reflect updated bullet');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('updateReleaseNotesFile generates required sections and zero em dashes', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relnotes-test-'));
  const testNotes = path.join(tmpDir, 'RELEASE_NOTES.md');

  try {
    const highlights = ['Custom feature highlight for shop cashiers'];
    updateReleaseNotesFile('2.2', highlights, testNotes);
    assert.ok(fs.existsSync(testNotes), 'RELEASE_NOTES.md was created');
    const content = fs.readFileSync(testNotes, 'utf8');

    // Check required sections (tested by packaging-workflows as well)
    assert.match(content, /# What is New in TechParts POS \(v2\.2\)/);
    assert.match(content, /Custom feature highlight for shop cashiers/);
    assert.match(content, /Spreadsheet Import/i);
    assert.match(content, /Automatic Price Calculation/i);
    assert.match(content, /Helpful Tips/i);
    assert.match(content, /Thermal Receipt Printing/i);
    assert.match(content, /Offline/i);
    assert.match(content, /Keyboard Shortcuts/i);
    assert.match(content, /How to Update/i);
    assert.doesNotMatch(content, /—/, 'RELEASE_NOTES.md must contain zero em dashes');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('publish-release.ps1 stages both RELEASE_NOTES.md and CHANGELOG.md', () => {
  const ps1Path = path.join(ROOT_DIR, 'scripts', 'publish-release.ps1');
  const ps1 = fs.readFileSync(ps1Path, 'utf8');

  assert.match(ps1, /CHANGELOG\.md/, 'publish-release.ps1 must track CHANGELOG.md');
  assert.match(ps1, /RELEASE_NOTES\.md/, 'publish-release.ps1 must track RELEASE_NOTES.md');
  assert.match(ps1, /generate-changelog\.js/, 'publish-release.ps1 must invoke automated changelog generator');
  assert.doesNotMatch(ps1, /—/, 'publish-release.ps1 must not contain em dashes');
});

test('CHANGELOG.md is current: its newest heading matches package.json', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.join(__dirname, '..');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const md = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
  const newest = md.match(/^## \[v([^\]]+)\]/m);
  assert.ok(newest, 'CHANGELOG.md has at least one ## [vX] heading');
  assert.strictEqual(newest[1], pkg.version, `CHANGELOG.md newest heading (v${newest[1]}) must match package.json (v${pkg.version})`);
});
