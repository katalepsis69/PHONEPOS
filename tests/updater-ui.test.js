const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const styles = fs.readFileSync(path.join(ROOT, 'public/styles.css'), 'utf8');
const indexHtml = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const backofficeJs = fs.readFileSync(path.join(ROOT, 'public/js/views/backoffice.js'), 'utf8');

test('updater antislop iconography: ph-sparkle eliminated in favor of purposeful arrow-circle-up', () => {
  // Hard Gate / Antislop tell: sparkles are generic AI decoration
  assert.ok(!indexHtml.includes('ph-sparkle'), 'index.html must not contain generic ph-sparkle icons');
  
  // Status chip in header
  assert.match(
    indexHtml,
    /<button[^>]*id="update-status-chip"[^>]*>[\s\S]*?<i class="ph ph-arrow-circle-up/
  );

  // Top notification banner
  assert.match(
    indexHtml,
    /<div[^>]*id="update-notification-banner"[\s\S]*?<i class="ph ph-arrow-circle-up text-emerald-400 w-4 h-4"><\/i>/
  );
});

test('updater DOM ergonomics: banner control IDs, span wrappers, and aria-live announcements', () => {
  // Banner apply and dismiss buttons have dedicated IDs
  assert.match(indexHtml, /id="btn-banner-apply-update"/);
  assert.match(indexHtml, /id="btn-banner-dismiss-update"/);

  // Status message has polite live region
  assert.match(indexHtml, /<p id="update-status-msg"[^>]*aria-live="polite">/);

  // Button text is wrapped in span for icon-safe text manipulation
  assert.match(indexHtml, /<button[^>]*id="btn-check-updates"[^>]*>[\s\S]*?<span>Check for updates<\/span>/);
  assert.match(indexHtml, /<button[^>]*id="btn-apply-update"[^>]*>[\s\S]*?<span>Update Now<\/span>/);
  assert.match(indexHtml, /<button[^>]*id="btn-banner-apply-update"[^>]*>[\s\S]*?<span>Update Now<\/span>/);
});

test('updater motion ergonomics: spin animation with reduced-motion compliance', () => {
  // Spin keyframes & utility class in styles.css
  assert.match(styles, /@keyframes spin\s*\{[\s\S]*?to\s*\{[\s\S]*?transform:\s*rotate\(360deg\);/);
  assert.match(styles, /\.animate-spin\s*\{[\s\S]*?animation:\s*spin 0\.8s linear infinite;/);

  // Reduced motion support (ui-design-spec / antislop-human)
  assert.match(
    styles,
    /@media \(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*?\.animate-spin\s*\{[\s\S]*?animation:\s*none;/
  );
});

test('updater backoffice controller: in-flight state tracking and loading synchronization', () => {
  // Guards against concurrent in-flight checks and downloads
  assert.match(backofficeJs, /let _updateCheckInFlight = false;/);
  assert.match(backofficeJs, /let _updateApplyInFlight = false;/);

  // Synchronized button states during check phase
  assert.match(backofficeJs, /function setCheckLoading\(loading\)/);
  assert.match(backofficeJs, /icon\.className = 'ph ph-arrows-clockwise w-3\.5 h-3\.5 animate-spin';/);
  assert.match(backofficeJs, /label\.textContent = 'Checking…';/);

  // Synchronized button states during apply/download phase
  assert.match(backofficeJs, /function setApplyLoading\(loading\)/);
  assert.match(backofficeJs, /icon\.className = 'ph ph-circle-notch w-3\.5 h-3\.5 animate-spin';/);
  assert.match(backofficeJs, /label\.textContent = t\('update\.downloading_btn', 'Downloading…'\);/);

  // Banner dismiss disabled while update is in flight
  assert.match(backofficeJs, /if \(_updateApplyInFlight\) return;/);

  // Checks and applies wrap in try/finally to guarantee release
  assert.match(backofficeJs, /finally\s*\{[\s\S]*?if \(!silent\) setCheckLoading\(false\);/);
});

test('software updates settings card styling: clean theme tokens, zero muddy dark background slop', () => {
  // Anti-slop / contrast fix: settings card must not hardcode muddy slate-800/40 over light theme
  const cardMatch = indexHtml.match(/<div class="[^"]*rounded-lg[^"]*"[\s\S]*?Software Updates[\s\S]*?id="btn-check-updates"/);
  assert.ok(cardMatch, 'updates card should exist');
  const cardSnippet = cardMatch[0];
  assert.ok(!cardSnippet.includes('bg-slate-800/40'), 'updates card must not use bg-slate-800/40');
  assert.ok(!cardSnippet.includes('text-slate-200'), 'updates card must not use text-slate-200');

  // Must use theme-aware surface and text tokens
  assert.match(cardSnippet, /border-\[var\(--line\)\]/);
  assert.match(cardSnippet, /bg-\[var\(--surface-2\)\]/);
  assert.match(cardSnippet, /text-\[var\(--txt\)\]/);
});

test('software update modal ergonomics: popup dialog on available update with actionable controls', () => {
  // Dedicated update modal in index.html
  assert.match(indexHtml, /<div[^>]*id="modal-update"[^>]*class="[^"]*modal-backdrop/);
  assert.match(indexHtml, /id="modal-update-version"/);
  assert.match(indexHtml, /id="modal-update-current"/);
  assert.match(indexHtml, /id="btn-modal-apply-update"/);
  assert.match(indexHtml, /data-modal="modal-update"/);

  // Controller triggers openModal('modal-update') when hasUpdate is true
  assert.match(backofficeJs, /openModal\(['"]modal-update['"]\)/);
  assert.match(backofficeJs, /btn-modal-apply-update/);
});

test('automatic update detection: topbar chip, banner, and periodic background timer', () => {
  const mainJs = fs.readFileSync(path.join(ROOT, 'public/js/main.js'), 'utf8');

  // Background timer checks every 30m and on network reconnect
  assert.match(mainJs, /setInterval\(\(\)\s*=>\s*\{[\s\S]*?checkForAppUpdates\(true\);\s*\}, 30 \* 60 \* 1000\);/);
  assert.match(mainJs, /window\.addEventListener\('online',\s*\(\)\s*=>\s*checkForAppUpdates\(true\)\);/);

  // Status chip is revealed automatically when update is ready without requiring manual !silent
  assert.match(backofficeJs, /if \(chip\) \{\s*if \(chipIcon\) chipIcon\.className/);

  // Top banner is revealed unless explicitly dismissed without requiring manual !silent
  assert.match(backofficeJs, /if \(banner && !_bannerDismissed\) \{/);

  // Session-scoped modal prompt key
  assert.match(backofficeJs, /const sessionPromptKey = `tp_update_prompted_\$\{data\.latestVersion\}`;/);
  assert.match(backofficeJs, /if \(!silent \|\| !sessionStorage\.getItem\(sessionPromptKey\)\) \{/);
});
