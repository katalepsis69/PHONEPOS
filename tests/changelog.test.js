// phone-repair-pos/tests/changelog.test.js
// Automated regression tests for changelog and release notes generation.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  generateReleaseHighlights,
  buildReleaseNotesMarkdown,
  updateChangelogFile,
  updateReleaseNotesFile
} = require('../scripts/generate-changelog');

const ROOT_DIR = path.resolve(__dirname, '..');

test('generateReleaseHighlights discovers actual codebase changes with zero em dashes', () => {
  // Isolate from live CHANGELOG.md so resetting repo version below 2.2 never suppresses 2.2's own check.
  const isolatedChangelog = path.join(os.tmpdir(), `changelog-isolated-${process.pid}.md`);
  const highlights = generateReleaseHighlights({ version: '2.2', changelogPath: isolatedChangelog });
  assert.ok(Array.isArray(highlights), 'highlights must be an array');
  assert.ok(highlights.length > 0, 'highlights must not be empty');

  // Anti-slop: zero em dashes across all generated highlights
  for (const h of highlights) {
    assert.doesNotMatch(h, /—/, `Highlight must not contain em dash: ${h}`);
  }

  // Must detect smaller monitor counter ergonomics for v2.2
  const hasErgonomics = highlights.some(h => /Ergonomics|monitors|typography|1366/i.test(h));
  assert.ok(hasErgonomics, 'highlights must include smaller monitor counter ergonomics');

  // Must also generate clean highlights for current version
  const currentHighlights = generateReleaseHighlights();
  assert.ok(Array.isArray(currentHighlights), 'current highlights must be an array');
  assert.ok(currentHighlights.length > 0, 'current highlights must not be empty');
  for (const h of currentHighlights) {
    assert.doesNotMatch(h, /—/, `Current highlight must not contain em dash: ${h}`);
  }
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
