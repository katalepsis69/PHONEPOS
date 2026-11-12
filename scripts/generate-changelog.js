// phone-repair-pos/scripts/generate-changelog.js
// Plain English, cashier-friendly automated changelog generator for TechParts POS.
// Zero runtime dependencies (Node 22 stdlib only: node:fs, node:path, node:child_process).

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT_DIR = path.resolve(__dirname, '..');

function getPackageVersion() {
  try {
    return (require('../package.json').version || '1.0.0').replace(/^v/i, '');
  } catch {
    return '1.0.0';
  }
}

function parseVersionParts(v) {
  if (!v || typeof v !== 'string') return [0, 0, 0];
  const clean = v.trim().replace(/^[vV]/, '').split(/[+-]/)[0];
  const parts = clean.split('.').map(p => {
    const n = parseInt(p, 10);
    return Number.isFinite(n) ? n : 0;
  });
  while (parts.length < 3) parts.push(0);
  return parts;
}

function isPriorVersion(candidateVer, targetVer) {
  const c = parseVersionParts(candidateVer);
  const t = parseVersionParts(targetVer);
  const len = Math.max(c.length, t.length);
  for (let i = 0; i < len; i++) {
    const cv = c[i] || 0;
    const tv = t[i] || 0;
    if (cv < tv) return true;
    if (cv > tv) return false;
  }
  return false;
}

function getPriorReleaseBullets(currentVersion, changelogPath = path.join(ROOT_DIR, 'CHANGELOG.md')) {
  if (!fs.existsSync(changelogPath)) return new Set();
  try {
    const content = fs.readFileSync(changelogPath, 'utf8');
    const cleanCurrent = (currentVersion || '').replace(/^v/i, '');
    const bullets = new Set();
    const sections = content.split(/(?=^##\s*\[)/m);
    for (const sec of sections) {
      const headerMatch = sec.match(/^##\s*\[v?([^\]]+)\]/m);
      if (headerMatch) {
        const secVer = headerMatch[1].trim().replace(/^v/i, '');
        if (isPriorVersion(secVer, cleanCurrent)) {
          const lines = sec.split('\n');
          for (const line of lines) {
            const m = line.trim().match(/^-\s+(.+)$/);
            if (m) {
              bullets.add(m[1].trim());
              const prefixMatch = m[1].match(/^([^:]+):/);
              if (prefixMatch) {
                bullets.add(prefixMatch[1].trim().toLowerCase());
              }
            }
          }
        }
      }
    }
    return bullets;
  } catch {
    return new Set();
  }
}

function runGit(args, cwd = ROOT_DIR) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 10 * 1024 * 1024
    }).trimEnd();
  } catch {
    return '';
  }
}

function tagExistsInGit(tag, cwd = ROOT_DIR) {
  if (!tag) return false;
  return Boolean(runGit(['rev-parse', '--verify', `${tag}^{commit}`], cwd));
}

/**
 * Find the newest git tag strictly older than `currentVersion`.
 * Never returns the current release tag itself.
 */
function getPreviousTag(currentVersion, cwd = ROOT_DIR) {
  const cleanCurrent = (currentVersion || '').replace(/^v/i, '');
  const tags = runGit(['tag', '--sort=-v:refname'], cwd)
    .split('\n')
    .map(t => t.trim())
    .filter(Boolean);

  for (const tag of tags) {
    const cleanTag = tag.replace(/^v/i, '');
    if (isPriorVersion(cleanTag, cleanCurrent)) {
      return tag;
    }
  }
  return '';
}

function getGitCommitsSinceTag(tag, cwd = ROOT_DIR) {
  if (!tagExistsInGit(tag, cwd)) return [];
  const raw = runGit(['log', `${tag}..HEAD`, '--pretty=format:%s'], cwd);
  if (!raw) return [];
  return raw
    .split('\n')
    .map(l => l.trim())
    .filter(msg => {
      if (!msg) return false;
      if (/^(merge|chore|bump|publish|test(\(.*\))?:)/i.test(msg)) return false;
      if (/publish-release/i.test(msg)) return false;
      if (/^Release\s+v/i.test(msg)) return false;
      return true;
    })
    .map(msg => {
      let clean = msg;
      const match = msg.match(/^(feat|fix|refactor|docs)(\([^)]+\))?:\s*(.+)$/i);
      if (match) clean = match[3];
      return clean.charAt(0).toUpperCase() + clean.slice(1);
    });
}

const IGNORED_DIFF_PATHS = [
  /^CHANGELOG\.md$/i,
  /^RELEASE_NOTES\.md$/i,
  /^package(-lock)?\.json$/i,
  /^public\/tailwind\.build\.css$/,
  /^(dist|release|publish|updates|node_modules|\.git)\//,
  /^tests\/t_/
];

function isRelevantRepoPath(relPath) {
  const normalized = String(relPath || '').replace(/\\/g, '/').trim();
  if (!normalized) return false;
  return !IGNORED_DIFF_PATHS.some(re => re.test(normalized));
}

const AREA_RULES = [
  { area: 'Repair Counter (POS)', match: p => /pos\.js$|pos-helpers|^public\/styles\.css$/.test(p) },
  { area: 'Inventory & Import', match: p => /inventory|importer|catalog/.test(p) },
  { area: 'Customer Credit (Utang)', match: p => /credits?\.js$/.test(p) },
  { area: 'Thermal Printing', match: p => /printer\.js$|receipts\.js$/.test(p) },
  { area: 'Reports & Analytics', match: p => /reports?\.|dashboard/.test(p) },
  { area: 'Cloud Sync', match: p => /^cloud/.test(p) },
  { area: 'Security & Licensing', match: p => /auth\.js$|license/.test(p) },
  { area: 'Updater & Packaging', match: p => /updater\.js$|^scripts\/|^installer\/|publish\.bat$/.test(p) },
  { area: 'Server & Database', match: p => /^src\//.test(p) },
  { area: 'Counter UI', match: p => /^public\//.test(p) }
];

function classifyFileArea(relPath) {
  for (const rule of AREA_RULES) {
    if (rule.match(relPath)) return rule.area;
  }
  return 'General';
}

function parseUnifiedDiffByFile(rawDiff) {
  const byFile = new Map();
  let current = null;
  for (const line of String(rawDiff || '').split(/\r?\n/)) {
    const fileMatch = line.match(/^diff --git a\/.+ b\/(.+)$/);
    if (fileMatch) {
      const file = fileMatch[1].replace(/\\/g, '/');
      current = { path: file, addedLines: [], hunkContexts: [] };
      byFile.set(file, current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith('@@')) {
      const ctxMatch = line.match(/^@@[^@]+@@\s*(.+)$/);
      if (ctxMatch && ctxMatch[1].trim()) current.hunkContexts.push(ctxMatch[1].trim());
      continue;
    }
    if (line.startsWith('+') && !line.startsWith('+++')) {
      current.addedLines.push(line.slice(1));
    }
  }
  return byFile;
}

/**
 * Collect actual git diff hunks and untracked files relative to `baseRef`
 * (or working tree against HEAD when no base tag exists).
 */
function collectDiffEntries(baseRef, cwd = ROOT_DIR) {
  const ref = tagExistsInGit(baseRef, cwd) ? baseRef : (tagExistsInGit('HEAD', cwd) ? 'HEAD' : '');
  const byFile = new Map();

  if (ref) {
    const changed = runGit(['diff', '--name-only', ref], cwd)
      .split(/\r?\n/)
      .map(s => s.trim())
      .filter(isRelevantRepoPath);
    if (changed.length > 0) {
      const rawDiff = runGit(['diff', '-U0', '--no-color', ref, '--', ...changed], cwd);
      for (const [k, v] of parseUnifiedDiffByFile(rawDiff)) {
        byFile.set(k, v);
      }
    }
  }

  const untracked = runGit(['ls-files', '--others', '--exclude-standard'], cwd)
    .split(/\r?\n/)
    .map(s => s.trim())
    .filter(isRelevantRepoPath);
  for (const rel of untracked) {
    try {
      const content = fs.readFileSync(path.join(cwd, rel), 'utf8');
      byFile.set(rel, { path: rel, addedLines: content.split(/\r?\n/).slice(0, 120), hunkContexts: [] });
    } catch {}
  }

  return [...byFile.values()];
}

function extractAddedSignals(entry) {
  const tests = [];
  const uiLabels = [];
  const symbols = [];
  const seen = new Set();
  const pushUnique = (arr, val, maxLen = 80) => {
    const clean = String(val || '').replace(/—/g, ' - ').replace(/\s+/g, ' ').trim();
    if (!clean || clean.length < 3 || clean.length > maxLen) return;
    if (seen.has(clean.toLowerCase())) return;
    seen.add(clean.toLowerCase());
    arr.push(clean);
  };

  for (const line of entry.addedLines) {
    const testMatch = line.match(/^\s*(?:test|it)\s*\(\s*(['"`])(.+?)\1/);
    if (testMatch) {
      pushUnique(tests, testMatch[2], 140);
      continue;
    }

    const i18nMatch = line.match(/['"][a-z]+\.[a-z0-9_]+['"]\s*:\s*['"]([^'"]+)['"]/i);
    if (i18nMatch) pushUnique(uiLabels, i18nMatch[1], 60);

    const htmlTitle = line.match(/\btitle="([^"]{4,60})"/i);
    if (htmlTitle) pushUnique(uiLabels, htmlTitle[1], 60);

    for (const m of line.matchAll(/<(?:button|strong|th|h[1-6])[^>]*>([^<$]{3,50})<\//gi)) {
      if (!m[1].includes('{')) {
        pushUnique(uiLabels, m[1].replace(/&amp;/g, '&'), 60);
      }
    }

    const fnMatch = line.match(/^\s*(?:export\s+)?(?:async\s+)?function\s+([a-zA-Z0-9_]+)/);
    if (fnMatch) pushUnique(symbols, fnMatch[1], 50);

    const routeMatch = line.match(/['"](\/api\/[a-z0-9_\/:-]+)['"]/i);
    if (routeMatch) pushUnique(symbols, routeMatch[1], 60);

    const cssMatch = line.match(/^\s*\.([a-z][a-z0-9_-]{2,})\s*\{/i);
    if (cssMatch) pushUnique(symbols, `.${cssMatch[1]}`, 40);
  }

  for (const ctx of entry.hunkContexts) {
    const fnCtx = ctx.match(/(?:function\s+)([a-zA-Z0-9_]+)/);
    if (fnCtx) pushUnique(symbols, fnCtx[1], 50);
  }

  return { tests, uiLabels, symbols };
}

function matchTestArea(testDesc, testPath) {
  const hay = `${testPath} ${testDesc}`.toLowerCase();
  if (/brandchip|brand chips|posinstock|repair counter|\bpos\b/.test(hay)) return 'Repair Counter (POS)';
  if (/import|min stock|min_stock|inventory|template|wholesale|capital/.test(hay)) return 'Inventory & Import';
  if (/utang|credit/.test(hay)) return 'Customer Credit (Utang)';
  if (/print|receipt|esc\/pos|drawer/.test(hay)) return 'Thermal Printing';
  if (/report|dashboard|analytics|profit/.test(hay)) return 'Reports & Analytics';
  if (/cloud/.test(hay)) return 'Cloud Sync';
  if (/pin|license|recovery|auth/.test(hay)) return 'Security & Licensing';
  if (/updater|installer|changelog|publish/.test(hay)) return 'Updater & Packaging';
  return '';
}

/**
 * Summarize actual changed files and added diff hunks into plain-English bullets.
 */
function summarizeDiffEntries(entries) {
  if (!entries || entries.length === 0) return [];

  const areaBuckets = new Map();
  const areaTests = new Map();
  const unassignedTests = [];

  for (const entry of entries) {
    const sig = extractAddedSignals(entry);
    if (entry.path.startsWith('tests/')) {
      for (const td of sig.tests) {
        const area = matchTestArea(td, entry.path);
        if (area) {
          if (!areaTests.has(area)) areaTests.set(area, []);
          areaTests.get(area).push(td);
        } else {
          unassignedTests.push(td);
        }
      }
      continue;
    }

    const area = classifyFileArea(entry.path);
    if (!areaBuckets.has(area)) {
      areaBuckets.set(area, { files: new Set(), uiLabels: [], symbols: [] });
    }
    const bucket = areaBuckets.get(area);
    bucket.files.add(path.basename(entry.path));
    for (const lbl of sig.uiLabels) {
      if (!bucket.uiLabels.includes(lbl)) bucket.uiLabels.push(lbl);
    }
    for (const sym of sig.symbols) {
      if (!bucket.symbols.includes(sym)) bucket.symbols.push(sym);
    }
  }

  const bullets = [];
  for (const [area, bucket] of areaBuckets.entries()) {
    const files = [...bucket.files].slice(0, 3);
    const tests = (areaTests.get(area) || []).slice(0, 2);
    const details = [];
    if (tests.length > 0) details.push(tests.join('; '));
    const labels = bucket.uiLabels.slice(0, 3);
    if (labels.length > 0) details.push(labels.join(', '));
    else if (tests.length === 0 && bucket.symbols.length > 0) details.push(`Updated ${bucket.symbols.slice(0, 3).join(', ')}`);

    const summary = details.length > 0
      ? `${details.join('; ')} (${files.join(', ')})`
      : `Updated ${files.join(', ')}`;
    bullets.push(`${area}: ${summary}`.replace(/—/g, ' - '));
  }

  if (bullets.length === 0 && unassignedTests.length > 0) {
    for (const td of unassignedTests.slice(0, 3)) {
      bullets.push(`Verified: ${td}`.replace(/—/g, ' - '));
    }
  }

  return bullets;
}

/**
 * Generate release highlight bullets from custom notes, git commits since `prevTag`,
 * and actual working-tree/branch git diff hunks.
 */
function generateReleaseHighlights({ version, prevTag, customNote, changelogPath, repoDir } = {}) {
  const cwd = repoDir || ROOT_DIR;
  const ver = (version || getPackageVersion()).replace(/^v/i, '');
  const previous = prevTag !== undefined ? prevTag : getPreviousTag(ver, cwd);
  const priorBullets = getPriorReleaseBullets(ver, changelogPath);

  const bullets = [];
  const pushBullet = (text) => {
    const clean = String(text || '').replace(/—/g, ' - ').trim();
    if (!clean) return;
    if (priorBullets.has(clean) || bullets.includes(clean)) return;
    bullets.push(clean);
  };

  if (customNote && customNote.trim()) {
    pushBullet(customNote.trim());
  }

  const gitCommits = getGitCommitsSinceTag(previous, cwd);
  for (const c of gitCommits) {
    pushBullet(c);
  }

  // Always inspect uncommitted changes; when no new commits exist since `previous`,
  // inspect the full diff from `previous` (covering both branch commits and working tree).
  const hasDirtyFiles = Boolean(runGit(['status', '--porcelain'], cwd));
  if (gitCommits.length === 0 || hasDirtyFiles) {
    const diffBase = gitCommits.length === 0 ? previous : 'HEAD';
    const diffEntries = collectDiffEntries(diffBase, cwd);
    for (const b of summarizeDiffEntries(diffEntries)) {
      pushBullet(b);
    }
  }

  if (bullets.length === 0) {
    pushBullet('Maintenance and stability improvements across POS counter, inventory, and backups.');
  }

  return bullets;
}

function buildReleaseNotesMarkdown(versionTag, highlights) {
  const tag = versionTag.startsWith('v') ? versionTag : `v${versionTag}`;
  const cleanVer = tag.replace(/^v/, '');
  const bulletLines = highlights.map(b => `- ${b}`).join('\n');

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
  - \`Ctrl + K\` or \`Ctrl + F\`: Open global search palette
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
  - \`Alt + H\`: Hold current job as a draft (frees counter for the next customer)
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
  const tag = versionTag.startsWith('v') ? versionTag : `v${versionTag}`;
  const today = new Date().toISOString().split('T')[0];

  const bulletLines = highlights.map(b => `- ${b}`).join('\n');
  const newEntry = `## [${tag}] - ${today}

### Highlights & Changes
${bulletLines}
`;

  let currentContent = '';
  if (fs.existsSync(changelogPath)) {
    currentContent = fs.readFileSync(changelogPath, 'utf8');
  }

  let finalContent = '';
  const header = `# Changelog

All notable changes to TechParts POS and Phone Repair Management System are documented in this file.

The format is based on Keep a Changelog, and this project adheres to Semantic Versioning.

`;

  if (!currentContent || !currentContent.includes('# Changelog')) {
    finalContent = header + newEntry + '\n' + HISTORICAL_CHANGELOG;
  } else {
    // If the version header already exists, replace its block to keep it idempotent
    const escapedTag = tag.replace(/\./g, '\\.');
    const sectionRegex = new RegExp(`##\\s*\\[${escapedTag}\\][\\s\\S]*?(?=\\n##\\s*\\[|$)`, 'i');

    if (sectionRegex.test(currentContent)) {
      finalContent = currentContent.replace(sectionRegex, newEntry.trim() + '\n\n');
    } else {
      // Insert after top header
      const headerIndex = currentContent.indexOf('## [');
      if (headerIndex !== -1) {
        finalContent = currentContent.slice(0, headerIndex) + newEntry + '\n' + currentContent.slice(headerIndex);
      } else {
        finalContent = currentContent.trimEnd() + '\n\n' + newEntry;
      }
    }
  }

  // Anti-slop normalization (zero em dashes, standard windows line endings)
  const normalized = finalContent.replace(/—/g, ' - ').replace(/(?<!\r)\n/g, '\r\n');
  fs.writeFileSync(changelogPath, normalized, 'utf8');
  return normalized;
}

function updateReleaseNotesFile(versionTag, highlights, notesPath = path.join(ROOT_DIR, 'RELEASE_NOTES.md')) {
  const tag = versionTag.startsWith('v') ? versionTag : `v${versionTag}`;
  const markdown = buildReleaseNotesMarkdown(tag, highlights);
  const normalized = markdown.replace(/—/g, ' - ').replace(/(?<!\r)\n/g, '\r\n');
  fs.writeFileSync(notesPath, normalized, 'utf8');
  return normalized;
}

function runCli() {
  const args = process.argv.slice(2);
  let version = getPackageVersion();
  let customNote = '';
  let dryRun = false;
  let stdoutOnly = false;
  let changelogOnly = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--version' && args[i + 1]) {
      version = args[++i];
    } else if (args[i] === '--note' && args[i + 1]) {
      customNote = args[++i];
    } else if (args[i] === '--dry-run') {
      dryRun = true;
    } else if (args[i] === '--stdout') {
      stdoutOnly = true;
    } else if (args[i] === '--changelog-only') {
      changelogOnly = true;
    }
  }

  const tag = version.startsWith('v') ? version : `v${version}`;
  const highlights = generateReleaseHighlights({ version, customNote });

  if (stdoutOnly) {
    process.stdout.write(buildReleaseNotesMarkdown(tag, highlights).replace(/—/g, ' - '));
    return;
  }

  console.log(`[generate-changelog] Generating changelog for ${tag}...`);
  for (const h of highlights) {
    console.log(`  * ${h}`);
  }

  if (dryRun) {
    console.log('[generate-changelog] Dry run requested. No files written.');
    return;
  }

  updateChangelogFile(tag, highlights);
  if (!changelogOnly) {
    updateReleaseNotesFile(tag, highlights);
  }
  console.log(`[generate-changelog] Successfully updated CHANGELOG.md${changelogOnly ? '' : ' and RELEASE_NOTES.md'} for ${tag}.`);
}

if (require.main === module) {
  runCli();
}

module.exports = {
  generateReleaseHighlights,
  buildReleaseNotesMarkdown,
  updateChangelogFile,
  updateReleaseNotesFile,
  getPackageVersion,
  getPreviousTag,
  summarizeDiffEntries
};
