'use strict';

// Changelog generator for TechParts POS.
// Uses Git history and the complete diff from the previous release tag to the
// current working tree, including committed, staged, unstaged, and untracked files.
// Runtime dependencies: Node.js built-ins only.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT_DIR = path.resolve(__dirname, '..');
const MAX_DIFF_BUFFER = 50 * 1024 * 1024;
const AUTO_START = '<!-- AUTO-GENERATED:START -->';
const AUTO_END = '<!-- AUTO-GENERATED:END -->';

function runGit(args, cwd = ROOT_DIR, options = {}) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      input: options.input,
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: MAX_DIFF_BUFFER,
      windowsHide: true
    });
  } catch (error) {
    if (options.allowFailure) return '';
    const detail = error.stderr ? String(error.stderr).trim() : error.message;
    throw new Error(`Git command failed (${args.join(' ')}): ${detail}`);
  }
}

function hasHead(cwd = ROOT_DIR) {
  return Boolean(runGit(['rev-parse', '--verify', 'HEAD'], cwd, { allowFailure: true }).trim());
}

function getPackageVersion(repoDir = ROOT_DIR) {
  const packagePath = path.join(repoDir, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  if (!pkg.version || typeof pkg.version !== 'string') {
    throw new Error('package.json does not contain a valid version string.');
  }
  return pkg.version.replace(/^v/i, '');
}

function parseVersionParts(version) {
  const match = String(version || '').trim().replace(/^v/i, '').match(/^(\d+(?:\.\d+){0,2})(?:[-+].*)?$/);
  if (!match) return null;
  const parts = match[1].split('.').map(Number);
  while (parts.length < 3) parts.push(0);
  return parts;
}

function compareVersions(left, right) {
  const a = parseVersionParts(left);
  const b = parseVersionParts(right);
  if (!a || !b) return null;
  for (let i = 0; i < 3; i += 1) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return 0;
}

function isPriorVersion(candidateVersion, targetVersion) {
  return compareVersions(candidateVersion, targetVersion) === -1;
}

function tagExistsInGit(tag, cwd = ROOT_DIR) {
  if (!tag) return false;
  return Boolean(runGit(['rev-parse', '--verify', `${tag}^{commit}`], cwd, { allowFailure: true }).trim());
}

function isAncestorOfHead(ref, cwd = ROOT_DIR) {
  if (!ref || !hasHead(cwd)) return false;
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', ref, 'HEAD'], {
      cwd,
      stdio: 'ignore',
      windowsHide: true
    });
    return true;
  } catch {
    return false;
  }
}

function getPreviousTag(currentVersion, cwd = ROOT_DIR) {
  if (!hasHead(cwd)) return '';
  const target = String(currentVersion || '').replace(/^v/i, '');

  // Use the newest reachable release tag, not simply the newest tag whose
  // version is numerically lower than package.json. Local customer builds can
  // have a stale package version; restricting by version would then compare
  // against the empty tree and treat the entire repository as a new release.
  const tags = runGit(['tag', '--list'], cwd)
    .split(/\r?\n/)
    .map(tag => tag.trim())
    .filter(Boolean)
    .filter(tag => parseVersionParts(tag) && compareVersions(tag, target) !== 0)
    .filter(tag => tagExistsInGit(tag, cwd) && isAncestorOfHead(tag, cwd));

  tags.sort((a, b) => compareVersions(b, a));
  return tags[0] || '';
}

function getGitCommitsSinceTag(tag, cwd = ROOT_DIR) {
  if (!hasHead(cwd)) return [];
  const range = tag ? `${tag}..HEAD` : 'HEAD';
  return runGit(['log', '--no-merges', '--format=%s', range], cwd)
    .split(/\r?\n/)
    .map(subject => subject.trim())
    .filter(Boolean)
    .filter(subject => !/^(?:merge\b|release\s+v?\d|chore\(release\)|bump\s+version\b)/i.test(subject));
}

const IGNORED_DIFF_PATHS = [
  /^CHANGELOG\.md$/i,
  /^RELEASE_NOTES\.md$/i,
  /^public\/tailwind\.build\.css$/i,
  /^(?:dist|release|publish|updates|node_modules|\.git)\//i,
  /^scripts\/generate-changelog\.js$/i,
  /\.(?:exe|dll|pdb|db|sqlite|sqlite3|sha256|zip)$/i
];

function isRelevantRepoPath(relPath) {
  const normalized = String(relPath || '').replace(/\\/g, '/').trim();
  return Boolean(normalized) && !IGNORED_DIFF_PATHS.some(pattern => pattern.test(normalized));
}

function isVersionOnlyChange(entry) {
  const file = String(entry.path || '').replace(/\\/g, '/').toLowerCase();
  const changedLines = [...(entry.addedLines || []), ...(entry.removedLines || [])]
    .map(line => line.trim())
    .filter(Boolean);
  if (changedLines.length === 0) return false;

  if (file === 'package.json' || file === 'package-lock.json') {
    return changedLines.every(line => /^"version"\s*:/.test(line));
  }
  if (file === 'src/updater.js') {
    return changedLines.every(line => /^const CURRENT_VERSION\s*=/.test(line));
  }
  if (/\.iss$/i.test(file)) {
    return changedLines.every(line => /^#define MyAppVersion\s+/.test(line));
  }
  return false;
}

function getEmptyTreeHash(cwd) {
  // Write only the canonical empty tree object into .git/objects. This gives
  // first-release repositories a real baseline, rather than looking only at
  // uncommitted changes in the current checkout.
  return runGit(['hash-object', '-t', 'tree', '-w', '--stdin'], cwd, { input: '' }).trim();
}

function parseNameStatus(raw) {
  const tokens = String(raw || '').split('\0');
  const result = new Map();
  for (let i = 0; i < tokens.length;) {
    const status = tokens[i++];
    if (!status) continue;
    const firstPath = tokens[i++];
    if (!firstPath) continue;
    // --no-renames is used by the caller, so each status has one path.
    result.set(firstPath, status[0]);
  }
  return result;
}

function parseUnifiedDiffByFile(rawDiff, statuses = new Map()) {
  const byFile = new Map();
  let current = null;

  for (const line of String(rawDiff || '').split(/\r?\n/)) {
    const fileMatch = line.match(/^diff --git a\/(.+) b\/(.+)$/);
    if (fileMatch) {
      const relPath = fileMatch[2].replace(/\\/g, '/');
      current = {
        path: relPath,
        status: statuses.get(relPath) || 'M',
        addedLines: [],
        removedLines: [],
        hunkContexts: []
      };
      byFile.set(relPath, current);
      continue;
    }
    if (!current) continue;

    if (line.startsWith('new file mode')) current.status = 'A';
    if (line.startsWith('deleted file mode')) current.status = 'D';
    if (line.startsWith('@@')) {
      const context = line.match(/^@@[^@]+@@\s*(.*)$/);
      if (context && context[1].trim()) current.hunkContexts.push(context[1].trim());
    } else if (line.startsWith('+') && !line.startsWith('+++')) {
      current.addedLines.push(line.slice(1));
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      current.removedLines.push(line.slice(1));
    }
  }

  return byFile;
}

function collectDiffEntries(baseRef, cwd = ROOT_DIR) {
  if (!hasHead(cwd)) return [];

  const base = baseRef && tagExistsInGit(baseRef, cwd) ? baseRef : getEmptyTreeHash(cwd);
  const statuses = parseNameStatus(runGit(
    ['diff', '--name-status', '--no-renames', '-z', base, '--'], cwd
  ));
  const changedPaths = [...statuses.keys()].filter(isRelevantRepoPath);
  const patch = runGit(
    ['diff', '--no-color', '--no-ext-diff', '--no-renames', '--unified=0', base, '--'], cwd
  );
  const parsed = parseUnifiedDiffByFile(patch, statuses);
  const byPath = new Map();

  // Use Git's NUL-delimited file list as the source of truth. This also keeps
  // binary, deleted, and otherwise unparsable paths visible in the summary.
  for (const relPath of changedPaths) {
    const entry = parsed.get(relPath) || {
      path: relPath,
      status: statuses.get(relPath) || 'M',
      addedLines: [],
      removedLines: [],
      hunkContexts: []
    };
    entry.status = statuses.get(relPath) || entry.status;
    if (!isVersionOnlyChange(entry)) byPath.set(relPath, entry);
  }

  // `git diff` intentionally does not include untracked files.
  const untracked = runGit(
    ['ls-files', '--others', '--exclude-standard', '-z'], cwd
  ).split('\0').filter(Boolean).filter(isRelevantRepoPath);

  for (const relPath of untracked) {
    if (byPath.has(relPath)) continue;
    try {
      const filePath = path.join(cwd, relPath);
      const stat = fs.statSync(filePath);
      if (!stat.isFile() || stat.size > 1024 * 1024) continue;
      const content = fs.readFileSync(filePath, 'utf8');
      if (content.includes('\0')) continue;
      byPath.set(relPath, {
        path: relPath,
        status: 'A',
        addedLines: content.split(/\r?\n/),
        removedLines: [],
        hunkContexts: []
      });
    } catch {
      // Ignore files that disappear or become unreadable during collection.
    }
  }

  return [...byPath.values()];
}

function extractSignals(entry) {
  const tests = [];
  const labels = [];
  const symbols = [];
  const seen = new Set();

  const add = (list, value, maxLength = 100) => {
    const clean = String(value || '').replace(/\s+/g, ' ').trim();
    const key = clean.toLowerCase();
    if (!clean || clean.length < 3 || clean.length > maxLength || seen.has(key)) return;
    seen.add(key);
    list.push(clean);
  };

  for (const line of entry.addedLines || []) {
    const testMatch = line.match(/^\s*(?:test|it|describe)\s*\(\s*(['"`])(.+?)\1/);
    if (testMatch) add(tests, testMatch[2], 140);

    const translationMatch = line.match(/['"][a-z][a-z0-9_.-]*['"]\s*:\s*['"]([^'"]+)['"]/i);
    if (translationMatch) add(labels, translationMatch[1], 70);

    const attrMatch = line.match(/\b(?:title|aria-label|placeholder)="([^"\n]{4,70})"/i);
    if (attrMatch) add(labels, attrMatch[1], 70);

    for (const match of line.matchAll(/<(?:button|strong|th|h[1-6])[^>]*>([^<$]{3,60})<\//gi)) {
      if (!match[1].includes('{')) add(labels, match[1].replace(/&amp;/g, '&'), 70);
    }

    const functionMatch = line.match(/^\s*(?:export\s+)?(?:async\s+)?function\s+([a-zA-Z0-9_]+)/);
    if (functionMatch) add(symbols, functionMatch[1], 55);

    const routeMatch = line.match(/['"](\/api\/[a-z0-9_/:.-]+)['"]/i);
    if (routeMatch) add(symbols, routeMatch[1], 70);

    const cssMatch = line.match(/^\s*\.([a-z][a-z0-9_-]{2,})\s*\{/i);
    if (cssMatch) add(symbols, `.${cssMatch[1]}`, 50);
  }

  for (const context of entry.hunkContexts || []) {
    const functionContext = context.match(/\bfunction\s+([a-zA-Z0-9_]+)/);
    if (functionContext) add(symbols, functionContext[1], 55);
  }

  return { tests, labels, symbols };
}

function classifyFileArea(relPath) {
  const file = String(relPath || '').replace(/\\/g, '/').toLowerCase();
  const base = path.posix.basename(file);

  if (file.startsWith('tests/')) return 'Quality & Tests';
  if (/pos\.js$|pos-helpers|checkout|cart|payment/.test(file)) return 'Repair Counter (POS)';
  if (/inventory|importer|catalog|parts-template|bulk-edit/.test(file)) return 'Inventory & Import';
  if (/credit|utang|ledger/.test(file)) return 'Customer Credit (Utang)';
  if (/printer|receipt|escpos|claim-stub/.test(file)) return 'Thermal Printing';
  if (/report|dashboard|analytics|sales-history/.test(file)) return 'Reports & Analytics';
  if (/cloud|sync/.test(file)) return 'Cloud Sync';
  if (/auth|license|security|pin|recovery/.test(file)) return 'Security & Licensing';
  if (/updater|installer|publish|changelog|package(-lock)?\.json|tailwind/.test(file) || file.startsWith('scripts/')) return 'Build & Release';
  if (file.startsWith('src/')) return 'Server & Database';
  if (file.startsWith('public/')) return 'Counter UI';
  if (/readme|\.md$/i.test(base)) return 'Documentation';
  return 'General';
}

function summarizeDiffEntries(entries) {
  if (!entries || entries.length === 0) return [];

  const buckets = new Map();
  for (const entry of entries) {
    const area = classifyFileArea(entry.path);
    if (!buckets.has(area)) {
      buckets.set(area, { files: new Set(), tests: [], labels: [], symbols: [], statuses: [] });
    }
    const bucket = buckets.get(area);
    bucket.files.add(entry.path);
    bucket.statuses.push(entry.status || 'M');

    const signals = extractSignals(entry);
    for (const item of signals.tests) if (!bucket.tests.includes(item)) bucket.tests.push(item);
    for (const item of signals.labels) if (!bucket.labels.includes(item)) bucket.labels.push(item);
    for (const item of signals.symbols) if (!bucket.symbols.includes(item)) bucket.symbols.push(item);
  }

  const bullets = [];
  for (const [area, bucket] of buckets) {
    const files = [...bucket.files].sort();
    const fileSummary = files.slice(0, 4).join(', ') + (files.length > 4 ? ` and ${files.length - 4} more` : '');
    const allAdded = bucket.statuses.every(status => status === 'A');
    const allDeleted = bucket.statuses.every(status => status === 'D');
    let detail = '';

    if (bucket.tests.length) {
      detail = `Updated test coverage for ${bucket.tests.slice(0, 3).join('; ')}`;
    } else if (bucket.labels.length) {
      detail = `Updated interface text for ${bucket.labels.slice(0, 3).map(label => `"${label}"`).join(', ')}`;
    } else if (bucket.symbols.length) {
      detail = `Updated ${bucket.symbols.slice(0, 3).join(', ')}`;
    } else if (allAdded) {
      detail = `Added ${files.length === 1 ? 'a new file' : 'new files'}`;
    } else if (allDeleted) {
      detail = `Removed ${files.length === 1 ? 'a file' : 'files'}`;
    } else {
      detail = 'Updated';
    }

    bullets.push(`${area}: ${detail} (${fileSummary})`);
  }

  return bullets;
}

function normalizeCommitSubject(subject) {
  const clean = String(subject || '').replace(/\s+/g, ' ').trim();
  if (!clean) return '';

  const match = clean.match(/^(feat|fix|perf|refactor|docs|build|chore|test|ci|style|security)(?:\([^)]*\))?(!)?:\s*(.+)$/i);
  if (!match) return clean.charAt(0).toUpperCase() + clean.slice(1);

  const type = match[1].toLowerCase();
  let summary = match[3].trim().replace(/[.!?]+$/, '');
  const redundantLead = {
    feat: /^(?:add|create|introduce)\s+/i,
    fix: /^(?:fix|resolve|prevent)\s+/i,
    perf: /^(?:improve|optimi[sz]e)\s+/i,
    refactor: /^(?:refactor|rework|clean up)\s+/i,
    docs: /^(?:update|add|document)\s+/i,
    build: /^(?:update|add|configure)\s+/i,
    chore: /^(?:update|clean up|remove)\s+/i,
    test: /^(?:add|update|expand)\s+/i,
    ci: /^(?:update|fix|add)\s+/i,
    style: /^(?:update|fix|adjust)\s+/i,
    security: /^(?:improve|fix|harden)\s+/i
  }[type];
  if (redundantLead) summary = summary.replace(redundantLead, '');
  const lowerSummary = summary.charAt(0).toLowerCase() + summary.slice(1);
  const verb = {
    feat: 'Added',
    fix: 'Fixed',
    perf: 'Improved performance for',
    refactor: 'Refined',
    docs: 'Updated documentation for',
    build: 'Updated build tooling for',
    chore: 'Updated',
    test: 'Expanded tests for',
    ci: 'Updated release automation for',
    style: 'Updated styling for',
    security: 'Improved security for'
  }[type];
  return `${verb} ${lowerSummary}`;
}

function generateReleaseHighlights({ version, prevTag, customNote, repoDir } = {}) {
  const cwd = repoDir || ROOT_DIR;
  const targetVersion = (version || getPackageVersion(cwd)).replace(/^v/i, '');
  if (!hasHead(cwd)) {
    throw new Error('This project has no Git commit yet. Commit the project before generating a release changelog.');
  }

  const previousTag = prevTag !== undefined ? prevTag : getPreviousTag(targetVersion, cwd);
  const commits = getGitCommitsSinceTag(previousTag, cwd);
  // This is deliberately a diff from the previous release tag, not from HEAD.
  // It therefore includes all committed changes in the release plus working-tree edits.
  const diffEntries = collectDiffEntries(previousTag, cwd);
  const rawBullets = [];

  if (customNote && String(customNote).trim()) {
    rawBullets.push(String(customNote).trim());
  }
  rawBullets.push(...commits.map(normalizeCommitSubject).filter(Boolean));
  rawBullets.push(...summarizeDiffEntries(diffEntries));

  const seen = new Set();
  const bullets = [];
  for (const item of rawBullets) {
    const clean = String(item || '').replace(/\s+/g, ' ').trim();
    const key = clean.toLowerCase();
    if (!clean || seen.has(key)) continue;
    seen.add(key);
    bullets.push(clean);
  }

  if (bullets.length === 0) {
    bullets.push(`No source changes detected since ${previousTag || 'the beginning of Git history'}.`);
  }

  return bullets.slice(0, 15);
}

function buildReleaseNotesMarkdown(versionTag, highlights) {
  const tag = /^v/i.test(versionTag) ? versionTag : `v${versionTag}`;
  const cleanVer = tag.replace(/^v/, '');
  const bulletLines = highlights.map(item => `- ${item}`).join('\n');

  return `# What is New in TechParts POS (${tag})

Here is a simple summary of all the new features and improvements in this release, written for shop owners and cashiers.

### Highlights in this update:
${bulletLines}

---

### 1. Simple Spreadsheet Import (Excel & CSV)
Import your phone parts catalog in seconds without having to manually match columns.

* **How it works:**
  - Go to **Inventory** and click **Import**.
  - Choose any Excel (.xlsx) or CSV file. The system automatically detects your column headers (Brand, Model, Part Type, Cost, Prices, Stock, Supplier, Location).
  - Preview the parts on screen to make sure everything looks right, then click **Import**.

* **Automatic Price Calculation:**
  - If you only have your purchase or cost price, you can leave the Retail and Wholesale price columns blank in your spreadsheet.
  - The system will automatically calculate selling prices using your store markup percentages (for example: 50% retail and 20% wholesale).
  - Calculated prices are clearly marked with an **auto** badge in the preview so you can double-check them before saving.

* **Where to Adjust Markups:**
  - You can change your default markup percentages anytime. Click the **Settings > Store** button directly inside the import preview, or open the **Settings** gear icon on the left menu and select the **Store** tab.

* **1-Click Spreadsheet Template:**
  - Click **Template** on the Inventory screen to download a ready-to-fill CSV file.
  - Includes clear example rows showing both manual prices and auto-calculated prices.

---

### 2. Helpful Tips Across Counter & Screens (Bilingual)
We added friendly explanations across the workstation so you and your staff always know what every button and feature does.

* **Clear Guidance:** Helpful tips next to parts search, customer search, retail vs wholesale price tier pills, claim stubs, returns, and bulk editing.
* **English & Tagalog:** Switch languages anytime with a single click in the top navigation bar. Every hint is written in plain, everyday language.

---

### 3. Bulk Parts Editor
Need to change prices or update multiple parts at the same time?

* **How it works:**
  - In **Inventory**, check the boxes next to the parts you want to change.
  - Use the bulk toolbar at the bottom to adjust prices by a fixed amount or percentage, recalculate prices from cost, change storage bins, or archive old parts in one click.

---

### 4. Fast Counter & Thermal Receipt Printing
* **Receipts & Claim Stubs:** Prints clear customer slips on standard 58mm and 80mm thermal receipt printers.
* **Automatic Cash Drawer Kick:** Connected cash drawers open automatically when completing a cash transaction.
* **Print Backup:** If the thermal printer is ever unplugged or out of paper, receipts smoothly fall back to your standard computer print dialog.

---

### 5. 100% Offline with Automatic Daily Backups
* **Zero Internet Required:** Ring up sales, look up inventory, and manage repair jobs completely offline.
* **Automatic Peace of Mind:** Your database automatically backs up locally every day you use the system. You can also export full backups anytime from **Settings > Data**.

---

### 6. Repair Counter Keyboard Shortcuts (For Fast Checkout)
Cashiers can ring up sales and handle repair jobs rapidly using keyboard shortcuts without touching the mouse:

* **Tab Navigation:**
  - \`F1\`: Switch to Repair Counter (POS) / New Repair
  - \`F2\`: Switch to Customer Credit ("Utang") Ledger
  - \`F3\`: Switch to Inventory
  - \`F4\`: Switch to Warranty & Returns
  - \`F8\`: Switch to Sales History
  - \`F7\`: Switch to Audit Log (Manager only)

* **Finding Parts & Customers:**
  - \`/\`: Jump directly to the parts search and barcode box
  - \`Alt + C\`: Jump to Customer Name field
  - \`Alt + T\`: Toggle Retail vs Wholesale price tier
  - \`Alt + N\`: Add or open Job Note (faults, unlock code, physical condition)
  - \`Alt + A\`: Add a brand new part to inventory

* **Payment & Checkout:**
  - \`Alt + 1\`: Select Cash payment (jumps to Tendered Amount)
  - \`Alt + 2\`: Select GCash payment (jumps to GCash Reference #)
  - \`Alt + 3\`: Select Customer Credit / Utang (jumps to Downpayment)
  - \`Alt + 4\`: Select Bank Transfer (jumps to Transfer Reference #)
  - \`Alt + E\`: Exact Amount (automatically enters the exact total due)
  - \`F9\`: Complete Sale and Print Receipt (or finalize repair order)

* **Holding Jobs & Stubs:**
  - \`Alt + P\`: Print Claim Stub before the repair starts
  - \`Alt + H\`: Hold current job (files a repair ticket and frees the counter for the next customer)
  - \`Alt + R\`: Resume previously held job
  - \`Alt + X\`: Clear cart / cancel current order
  - \`Escape\`: Close any open window or confirmation dialog

---

### How to Update

* **If you already have TechParts POS:**
  1. Open the system and go to **Settings** (gear icon) > **Data**.
  2. Click **Check for updates**.
  3. When the new version appears, click **Update Now**. The system safely updates itself and restarts with all your shop data preserved.

* **If this is a fresh installation:**
  1. Download \`TechPartsPOS-Setup-${cleanVer}.exe\` below.
  2. Run the installer to install TechParts POS as a protected background service.
  3. Launch TechParts POS from the Start Menu or Desktop shortcut.
`;
}

function localDateString(date = new Date()) {
  const pad = value => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function getVersionSectionBounds(content, versionTag) {
  const normalizedTag = String(versionTag).replace(/^v/i, '').toLowerCase();
  const headings = [...content.matchAll(/^##\s+\[([^\]]+)\].*$/gm)];
  const index = headings.findIndex(match => match[1].replace(/^v/i, '').toLowerCase() === normalizedTag);
  if (index < 0) return null;
  const start = headings[index].index;
  const end = index + 1 < headings.length ? headings[index + 1].index : content.length;
  return { start, end };
}

function makeAutoBlock(highlights) {
  const bullets = highlights.map(item => `- ${item}`).join('\n');
  return `${AUTO_START}\n${bullets}\n${AUTO_END}`;
}

// Starter history for a brand-new CHANGELOG.md, kept from the v2.x era of the
// product so a fresh install still shows where the features came from.
const HISTORICAL_CHANGELOG = `## [v2.1] - 2026-11-02

### Added & Improved
- Cryptographic offline license verification (RSA machine-ID binding and LicenseGenerator.exe).
- End-of-day cash drawer reconciliation and drawer count verification.
- In-app updater checksum validation and staging resilience.

## [v2.0] - 2026-10-15

### Added & Improved
- Salted PBKDF2 manager PIN security with persistent lockout protection.
- Customer credit ("Utang") FIFO allocation and ledger settlement.
- Dual-tier pricing with walk-in retail and technician wholesale prices.

## [v1.2] - 2026-10-15

### Added & Improved
- Offline in-app software updater with automated SHA-256 verification.
- Automated daily SQLite database backups with integrity checks.

## [v1.1] - 2026-09-17

### Added & Improved
- Raw ESC/POS thermal printing for 58mm and 80mm printers with cash drawer kick pulse.
- Excel (.xlsx) and CSV inventory spreadsheet import with automated price markup calculation.
- Bilingual English and Tagalog counter guidance.

## [v1.0.0] - 2026-09-12

### Initial Release
- Standalone Single Executable Application (SEA) for offline phone repair counters.
- Zero runtime dependencies with local SQLite storage.
`;

function updateChangelogFile(versionTag, highlights, changelogPath = path.join(ROOT_DIR, 'CHANGELOG.md')) {
  const tag = /^v/i.test(versionTag) ? versionTag : `v${versionTag}`;
  const date = localDateString();
  const autoBlock = makeAutoBlock(highlights);
  const entry = `## [${tag}] - ${date}\n\n### Highlights & Changes\n${autoBlock}\n`;
  const header = '# Changelog\n\nAll notable changes to TechParts POS and Phone Repair Management System are documented in this file.\n\nThe format is based on Keep a Changelog, and this project adheres to Semantic Versioning.\n\n';

  let content = fs.existsSync(changelogPath) ? fs.readFileSync(changelogPath, 'utf8').replace(/^\uFEFF/, '') : '';
  content = content.replace(/\r\n/g, '\n');

  if (!content.trim()) {
    content = header + entry + '\n' + HISTORICAL_CHANGELOG;
  } else {
    if (!/^# Changelog\b/m.test(content)) content = header + content.replace(/^\s+/, '');
    const bounds = getVersionSectionBounds(content, tag);

    if (!bounds) {
      const firstVersion = content.search(/^##\s+\[/m);
      if (firstVersion >= 0) {
        content = content.slice(0, firstVersion) + entry + '\n' + content.slice(firstVersion);
      } else {
        content = content.trimEnd() + '\n\n' + entry;
      }
    } else {
      let section = content.slice(bounds.start, bounds.end);
      const markerStart = section.indexOf(AUTO_START);
      const markerEnd = section.indexOf(AUTO_END);

      if (markerStart >= 0 && markerEnd > markerStart) {
        section = section.slice(0, markerStart) + autoBlock + section.slice(markerEnd + AUTO_END.length);
      } else {
        const heading = /^###\s+Highlights\s*&\s*Changes\s*$/m.exec(section);
        if (heading) {
          const bodyStart = heading.index + heading[0].length;
          const nextHeadingMatch = /^###\s+/gm;
          nextHeadingMatch.lastIndex = bodyStart;
          const nextHeading = nextHeadingMatch.exec(section);
          const bodyEnd = nextHeading ? nextHeading.index : section.length;
          section = section.slice(0, bodyStart) + '\n' + autoBlock + '\n' + section.slice(bodyEnd);
        } else {
          section = section.trimEnd() + '\n\n### Highlights & Changes\n' + autoBlock + '\n';
        }
      }

      // Refresh the displayed date while preserving the rest of this release section.
      section = section.replace(/^(##\s+\[[^\]]+\]\s+-\s+)\d{4}-\d{2}-\d{2}/m, `$1${date}`);
      content = content.slice(0, bounds.start) + section + content.slice(bounds.end);
    }
  }

  const normalized = content.replace(/\n+$/g, '\n').replace(/(?<!\r)\n/g, '\r\n');
  fs.mkdirSync(path.dirname(changelogPath), { recursive: true });
  fs.writeFileSync(changelogPath, normalized, 'utf8');
  return normalized;
}

function updateReleaseNotesFile(versionTag, highlights, notesPath = path.join(ROOT_DIR, 'RELEASE_NOTES.md')) {
  const markdown = buildReleaseNotesMarkdown(versionTag, highlights);
  const normalized = markdown.replace(/\n+$/g, '\n').replace(/(?<!\r)\n/g, '\r\n');
  fs.mkdirSync(path.dirname(notesPath), { recursive: true });
  fs.writeFileSync(notesPath, normalized, 'utf8');
  return normalized;
}

function parseArgs(args) {
  const options = {
    version: getPackageVersion(),
    customNote: '',
    dryRun: false,
    stdoutOnly: false,
    changelogOnly: false,
    help: false
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h' || arg === '/?') options.help = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--stdout') options.stdoutOnly = true;
    else if (arg === '--changelog-only') options.changelogOnly = true;
    else if (arg === '--version' && args[i + 1]) options.version = args[++i];
    else if (arg.startsWith('--version=')) options.version = arg.slice('--version='.length);
    else if (arg === '--note' && args[i + 1]) options.customNote = args[++i];
    else if (arg.startsWith('--note=')) options.customNote = arg.slice('--note='.length);
    else throw new Error(`Unknown or incomplete option: ${arg}`);
  }

  options.version = String(options.version).replace(/^v/i, '');
  if (!parseVersionParts(options.version)) {
    throw new Error(`Invalid release version: ${options.version}`);
  }
  return options;
}

function runCli(args = process.argv.slice(2)) {
  try {
    const options = parseArgs(args);
    if (options.help) {
      console.log('Usage: node scripts/generate-changelog.js [options]\n');
      console.log('  --version <version>  Generate for a release version (defaults to package.json).');
      console.log('  --note <text>        Add a custom release highlight.');
      console.log('  --dry-run            Preview without writing files.');
      console.log('  --stdout             Print release notes only; never write files.');
      console.log('  --changelog-only     Update CHANGELOG.md without changing RELEASE_NOTES.md.');
      console.log('  --help               Show this help.');
      return 0;
    }

    const tag = `v${options.version}`;
    const highlights = generateReleaseHighlights({ version: options.version, customNote: options.customNote });

    if (options.stdoutOnly) {
      process.stdout.write(buildReleaseNotesMarkdown(tag, highlights));
      return 0;
    }

    console.log(`[generate-changelog] ${options.dryRun ? 'Previewing' : 'Updating'} changelog for ${tag}...`);
    for (const highlight of highlights) console.log(`  - ${highlight}`);

    if (options.dryRun) {
      console.log('[generate-changelog] Dry run: no files were changed.');
      return 0;
    }

    updateChangelogFile(tag, highlights);
    if (!options.changelogOnly) updateReleaseNotesFile(tag, highlights);
    console.log(`[generate-changelog] Updated CHANGELOG.md${options.changelogOnly ? '' : ' and RELEASE_NOTES.md'}.`);
    return 0;
  } catch (error) {
    console.error(`[generate-changelog] ERROR: ${error.message}`);
    return 1;
  }
}

if (require.main === module) {
  process.exitCode = runCli();
}

module.exports = {
  generateReleaseHighlights,
  buildReleaseNotesMarkdown,
  updateChangelogFile,
  updateReleaseNotesFile,
  getPackageVersion,
  getPreviousTag,
  getGitCommitsSinceTag,
  collectDiffEntries,
  summarizeDiffEntries,
  isVersionOnlyChange,
  parseVersionParts,
  isPriorVersion
};
