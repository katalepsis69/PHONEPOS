'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const changelog = require('../scripts/generate-changelog.js');

function git(cwd, args) {
  return execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8' }).trim();
}

function createRepo(t) {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'techparts-changelog-'));
  t.after(() => fs.rmSync(repoDir, { recursive: true, force: true }));

  fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repoDir, 'package.json'), '{\n  "name": "fixture",\n  "version": "1.0.0"\n}\n');
  fs.writeFileSync(path.join(repoDir, 'src', 'pos.js'), 'function checkout() { return "old"; }\n');
  git(repoDir, ['init', '-q']);
  git(repoDir, ['config', 'user.name', 'Changelog Test']);
  git(repoDir, ['config', 'user.email', 'changelog-test@example.com']);
  git(repoDir, ['add', '.']);
  git(repoDir, ['commit', '-m', 'feat: create initial counter']);
  git(repoDir, ['tag', 'v1.0.0']);
  return repoDir;
}

test('includes committed, unstaged, and untracked changes since the previous release tag', t => {
  const repoDir = createRepo(t);
  fs.writeFileSync(path.join(repoDir, 'src', 'pos.js'), 'function checkout() { return "fixed"; }\nfunction finishSale() { return true; }\n');
  git(repoDir, ['add', 'src/pos.js']);
  git(repoDir, ['commit', '-m', 'fix(pos): fix checkout flow']);

  fs.writeFileSync(path.join(repoDir, 'src', 'pos.js'), 'function checkout() { return "fixed"; }\nfunction finishSale() { return true; }\nfunction printReceipt() { return true; }\n');
  fs.mkdirSync(path.join(repoDir, 'src', 'inventory'), { recursive: true });
  fs.writeFileSync(path.join(repoDir, 'src', 'inventory', 'importer.js'), 'function importSpreadsheet() { return true; }\n');

  const highlights = changelog.generateReleaseHighlights({ version: '1.1.0', repoDir });
  const combined = highlights.join('\n').toLowerCase();
  assert.match(combined, /fixed checkout flow/);
  assert.match(combined, /src\/pos\.js/);
  assert.match(combined, /src\/inventory\/importer\.js/);
});

test('uses all history as the baseline when a repository has no release tags', t => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'techparts-first-release-'));
  t.after(() => fs.rmSync(repoDir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repoDir, 'package.json'), '{\n  "version": "0.1.0"\n}\n');
  fs.writeFileSync(path.join(repoDir, 'src', 'app.js'), 'function firstScreen() { return true; }\n');
  git(repoDir, ['init', '-q']);
  git(repoDir, ['config', 'user.name', 'Changelog Test']);
  git(repoDir, ['config', 'user.email', 'changelog-test@example.com']);
  git(repoDir, ['add', '.']);
  git(repoDir, ['commit', '-m', 'feat: add first app screen']);

  const highlights = changelog.generateReleaseHighlights({ version: '0.1.0', repoDir });
  const combined = highlights.join('\n').toLowerCase();
  assert.match(combined, /added first app screen/);
  assert.match(combined, /src\/app\.js/);
});

test('updates a version section idempotently and preserves older release history', t => {
  const repoDir = createRepo(t);
  const changelogPath = path.join(repoDir, 'CHANGELOG.md');
  fs.writeFileSync(changelogPath, [
    '# Changelog',
    '',
    '## [v1.0.0] - 2026-01-01',
    '',
    '### Highlights & Changes',
    '- Original release highlight',
    ''
  ].join('\n'));

  changelog.updateChangelogFile('v1.1.0', ['Added a new counter feature'], changelogPath);
  changelog.updateChangelogFile('v1.1.0', ['Fixed a counter issue'], changelogPath);
  const result = fs.readFileSync(changelogPath, 'utf8');

  assert.equal((result.match(/AUTO-GENERATED:START/g) || []).length, 1);
  assert.equal((result.match(/## \[v1\.1\.0\]/g) || []).length, 1);
  assert.match(result, /Fixed a counter issue/);
  assert.doesNotMatch(result, /Added a new counter feature/);
  assert.match(result, /Original release highlight/);
});

test('ignores newer version tags that are not on the current branch', t => {
  const repoDir = createRepo(t);
  const primaryBranch = git(repoDir, ['branch', '--show-current']);
  git(repoDir, ['checkout', '-q', '-b', 'side-history']);
  fs.writeFileSync(path.join(repoDir, 'src', 'side.js'), 'module.exports = true;\n');
  git(repoDir, ['add', '.']);
  git(repoDir, ['commit', '-m', 'feat: add unrelated side branch change']);
  git(repoDir, ['tag', 'v1.9.0']);
  git(repoDir, ['checkout', '-q', primaryBranch]);

  assert.equal(changelog.getPreviousTag('2.0.0', repoDir), 'v1.0.0');
});


test('uses the newest reachable release tag when package.json is behind', t => {
  const repoDir = createRepo(t);
  assert.equal(changelog.getPreviousTag('0.9.0', repoDir), 'v1.0.0');
});

test('does not treat release version bumps as customer-facing changes', t => {
  const repoDir = createRepo(t);
  const packagePath = path.join(repoDir, 'package.json');
  const updaterPath = path.join(repoDir, 'src', 'updater.js');
  fs.writeFileSync(updaterPath, "const CURRENT_VERSION = '1.0.0';\n");
  git(repoDir, ['add', 'src/updater.js']);
  git(repoDir, ['commit', '-m', 'chore: add updater version constant']);
  git(repoDir, ['tag', 'v1.0.1']);

  fs.writeFileSync(packagePath, fs.readFileSync(packagePath, 'utf8').replace('1.0.0', '1.1.0'));
  fs.writeFileSync(updaterPath, "const CURRENT_VERSION = '1.1.0';\n");
  const highlights = changelog.generateReleaseHighlights({ version: '1.1.0', repoDir });
  assert.equal(highlights.length, 1);
  assert.match(highlights[0], /No source changes detected/);
});
