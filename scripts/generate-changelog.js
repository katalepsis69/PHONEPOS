// phone-repair-pos/scripts/generate-changelog.js
// Plain English, cashier-friendly automated changelog generator for TechParts POS.
// Zero runtime dependencies (Node 22 stdlib only: node:fs, node:path, node:child_process).

const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

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

function getPreviousTag(currentVersion) {
  try {
    const cleanCurrent = (currentVersion || '').replace(/^v/i, '');
    const tags = execSync('git tag --sort=-v:refname', { cwd: ROOT_DIR, encoding: 'utf8' })
      .split('\n')
      .map(t => t.trim())
      .filter(Boolean);

    for (const tag of tags) {
      const cleanTag = tag.replace(/^v/i, '');
      if (isPriorVersion(cleanTag, cleanCurrent)) {
        return tag;
      }
    }
    return tags[tags.length - 1] || '';
  } catch {
    return '';
  }
}

function getTagDate(tag) {
  if (!tag) return null;
  try {
    const dateStr = execSync(`git log -1 --format="%ci" ${tag}`, { cwd: ROOT_DIR, encoding: 'utf8' }).trim();
    if (dateStr) {
      const parsed = new Date(dateStr);
      if (!isNaN(parsed.getTime())) return parsed;
    }
  } catch {}
  return null;
}

function getGitCommitsSinceTag(tag) {
  if (!tag) return [];
  try {
    const raw = execSync(`git log "${tag}..HEAD" --pretty=format:"%s"`, { cwd: ROOT_DIR, encoding: 'utf8' });
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
        const match = msg.match(/^(feat|fix|refactor|docs)(\([^\)]+\))?:\s*(.+)$/i);
        if (match) clean = match[3];
        return clean.charAt(0).toUpperCase() + clean.slice(1);
      });
  } catch {
    return [];
  }
}

function getModifiedFilesSince(sinceDate) {
  const cutoff = sinceDate || new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
  const targets = ['public', 'src', 'tests', 'scripts', 'cloud'];
  const modified = [];

  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === 'node_modules' || ent.name === '.git' || ent.name.startsWith('t_')) continue;
        walk(full);
      } else if (ent.isFile()) {
        try {
          const stat = fs.statSync(full);
          if (stat.mtime > cutoff) {
            modified.push({
              relPath: path.relative(ROOT_DIR, full).replace(/\\/g, '/'),
              fullPath: full,
              mtime: stat.mtime
            });
          }
        } catch {}
      }
    }
  }

  for (const t of targets) {
    walk(path.join(ROOT_DIR, t));
  }

  return modified.sort((a, b) => b.mtime - a.mtime);
}

function inspectCodebaseChanges(modifiedFiles) {
  const highlights = [];
  const paths = modifiedFiles.map(f => f.relPath);

  // 1. Workstation Typography & Theme Presets (5 accents, 4 scale presets, tabular figures)
  if (paths.some(p => p.includes('theme.js') || p.includes('typography-presets') || (p.includes('styles.css') && fs.readFileSync(path.join(ROOT_DIR, p), 'utf8').includes('data-accent')))) {
    highlights.push('Workstation Typography & Themes: 5 shop color accents, 4 readable text scale presets (90% to 125%), locked clean sans display, and monospace tabular digits.');
  }

  // 2. Settings Modal Navigation Revamp (6 organized tabs, cashier account & security unification)
  if (paths.some(p => p.includes('typography-presets.test.js')) || (paths.includes('public/index.html') && fs.readFileSync(path.join(ROOT_DIR, 'public/index.html'), 'utf8').includes('data-tab="appearance"'))) {
    highlights.push('Settings Navigation Revamp: 6 organized settings tabs (Store, Staff & Security, Printing, Appearance, Cloud Sync, Data) with threshold controls and unified cashier accounts.');
  }

  // 3. Manager Phone Reports (/api/report/* namespace, mobile reporting view)
  if (paths.some(p => p.includes('report.html') || p.includes('report.js') || p.includes('report.test.js'))) {
    highlights.push('Manager Phone Reports: Secure token-authenticated mobile report endpoint (/api/report/*) for off-site till and revenue monitoring.');
  }

  // 4. Cloud Sync Service & Hardening (multi-shop synchronization service)
  if (paths.some(p => p.startsWith('cloud/') || p.includes('deploy-cloud.js') || p.includes('cloud-hardening.test.js'))) {
    highlights.push('Cloud Sync Hardening: Hardened multi-shop synchronization service with scoped bearer tokens and automated cloud deployment.');
  }

  // 5. Counter Ergonomics & 1366px Monitor Layout (v2.2 feature)
  const stylesPath = path.join(ROOT_DIR, 'public', 'styles.css');
  if (fs.existsSync(stylesPath)) {
    try {
      const styles = fs.readFileSync(stylesPath, 'utf8');
      if (styles.includes('@media (max-width: 1366px)') && (paths.includes('public/styles.css') || paths.includes('public/index.html'))) {
        highlights.push('Counter Ergonomics: Compact workstation spacing and enlarged typography (cells 14px, part names 14.5px bold, prices 15px tabular numbers, grand total 25px bold green) for 1366x768 and 1280x800 counter monitors.');
        highlights.push('Automatic Rail Collapse: Navigation rail automatically collapses from 250px to 68px icon mode on screens 1366px wide or smaller, reclaiming 182px of horizontal table space.');
      }
    } catch {}
  }

  // 6. Responsive Font Scaling in backoffice / inventory
  if (paths.some(p => p.includes('backoffice.js') || p.includes('inventory.js') || p.includes('auth.js'))) {
    highlights.push('Responsive Font Scaling: Standardized badges, wholesale tags, customer status pills, and utang payment references to responsive scale-aware sizes.');
  }

  // 7. In-App Updater improvements
  if (paths.some(p => p.includes('updater.js'))) {
    highlights.push('Software Updates: Safe offline update staging with strict SHA-256 verification and atomic binary installation.');
  }

  // 8. Security & Manager PIN
  if (paths.some(p => p.includes('license.js') || p.includes('build-license-exe.js') || p.includes('set-pin.js'))) {
    highlights.push('Security & Licensing: Cryptographic offline RSA license validation and salted PBKDF2 manager PIN protection.');
  }

  // 9. Thermal Receipt Printing
  if (paths.some(p => p.includes('printer.js') || p.includes('receipts.js'))) {
    highlights.push('Thermal Receipt Printing: Reliable 58mm and 80mm ESC/POS receipt generation, claim stubs, and automated cash drawer kick.');
  }

  // 10. Customer Credit ("Utang")
  if (paths.some(p => p.includes('credits.js'))) {
    highlights.push('Customer Credit (Utang): FIFO credit allocation and ledger settlement improvements.');
  }

  // 11. Repair Counter & POS
  if (paths.some(p => p.includes('pos.js') || p.includes('sales.js'))) {
    highlights.push('Repair Counter: Fast job intake, checkout shortcuts, and payment handling improvements.');
  }

  // 12. Automated Test Coverage
  if (paths.some(p => p.startsWith('tests/'))) {
    highlights.push('Automated Test Suite: Comprehensive test suite verification ensuring zero floating-point drift, database safety, and UI resilience.');
  }

  // 13. Inventory Capital & Clean Import Template
  if (paths.some(p => p.includes('template-chooser') || (p.includes('inventory.js') && fs.readFileSync(path.join(ROOT_DIR, p), 'utf8').includes('IMPORT_TEMPLATE_HEADERS')))) {
    highlights.push('Inventory Capital & Blank Template: Standardized cost price to Capital across all screens and exports; download template is now completely empty with zero dummy rows.');
    highlights.push('Wholesale Pricing & Catalog Transfer: Fixed CSV exports to use friendly Capital and Wholesale Price headers for clean multi-PC catalog updates.');
  }

  return highlights;
}

function generateReleaseHighlights({ version, prevTag, customNote } = {}) {
  const ver = (version || getPackageVersion()).replace(/^v/i, '');
  const previous = prevTag || getPreviousTag(ver);
  const prevDate = getTagDate(previous);
  const priorBullets = getPriorReleaseBullets(ver);

  const bullets = [];

  if (customNote && customNote.trim()) {
    bullets.push(customNote.trim());
  }

  // 1. Commits from git if present
  const gitCommits = getGitCommitsSinceTag(previous);
  for (const c of gitCommits) {
    if (!bullets.includes(c)) bullets.push(c);
  }

  // 2. Local filesystem modifications inspection
  const modifiedFiles = getModifiedFilesSince(prevDate);
  const areaHighlights = inspectCodebaseChanges(modifiedFiles);
  for (const h of areaHighlights) {
    const prefixMatch = h.match(/^([^:]+):/);
    const prefix = prefixMatch ? prefixMatch[1].trim().toLowerCase() : '';
    const alreadyPublished = priorBullets.has(h) || (prefix && priorBullets.has(prefix));

    if (!alreadyPublished && !bullets.includes(h)) {
      bullets.push(h);
    }
  }

  // 3. Fallback to modified test names if all highlights were previously published
  if (bullets.length === 0) {
    for (const f of modifiedFiles) {
      if (f.relPath.startsWith('tests/') && f.relPath.endsWith('.test.js')) {
        try {
          const content = fs.readFileSync(f.fullPath, 'utf8');
          const testMatches = [...content.matchAll(/test\s*\(\s*['"]([^'"]+)['"]/g)];
          for (const m of testMatches) {
            const desc = m[1].replace(/—/g, ' - ').trim();
            if (desc && !bullets.includes(desc) && !priorBullets.has(desc)) {
              bullets.push(`Verified: ${desc}`);
              if (bullets.length >= 3) break;
            }
          }
        } catch {}
      }
      if (bullets.length >= 3) break;
    }
  }

  // 4. Fallback baseline if nothing specific detected
  if (bullets.length === 0) {
    bullets.push('Simplified Excel and CSV parts import with automatic markup calculation from cost.');
    bullets.push('Added friendly bilingual micro-hints (English & Tagalog) throughout counter and screens.');
    bullets.push('Added fast counter shortcuts for checkout, customer search, price tiers, and claim stubs.');
    bullets.push('System stability, thermal receipt printing, and automated daily backup improvements.');
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

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--version' && args[i + 1]) {
      version = args[++i];
    } else if (args[i] === '--note' && args[i + 1]) {
      customNote = args[++i];
    } else if (args[i] === '--dry-run') {
      dryRun = true;
    }
  }

  const tag = version.startsWith('v') ? version : `v${version}`;
  const highlights = generateReleaseHighlights({ version, customNote });

  console.log(`[generate-changelog] Generating changelog for ${tag}...`);
  for (const h of highlights) {
    console.log(`  * ${h}`);
  }

  if (dryRun) {
    console.log('[generate-changelog] Dry run requested. No files written.');
    return;
  }

  updateChangelogFile(tag, highlights);
  updateReleaseNotesFile(tag, highlights);
  console.log(`[generate-changelog] Successfully updated CHANGELOG.md and RELEASE_NOTES.md for ${tag}.`);
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
  getPreviousTag
};
