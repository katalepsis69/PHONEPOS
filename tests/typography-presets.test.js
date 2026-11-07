const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const styles = fs.readFileSync(path.join(ROOT, 'public/styles.css'), 'utf8');
const indexHtml = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');

test('workstation typography: styles.css locks clean sans display/text and tabular mono figures', () => {
  assert.match(styles, /--font-display:\s*system-ui/);
  assert.match(styles, /--font-text:\s*system-ui/);
  assert.match(styles, /--font-numeric:\s*ui-monospace/);
  assert.match(styles, /--font-display-weight:\s*600/);
  assert.match(styles, /--font-display-tracking:\s*-0\.02em/);
  assert.match(styles, /html\[data-font-style="workstation"\]/);

  // Dead font-picker and sans-number overrides are removed
  assert.doesNotMatch(styles, /html\[data-font-style="humanist"\]/);
  assert.doesNotMatch(styles, /html\[data-font-style="grotesk"\]/);
  assert.doesNotMatch(styles, /html\[data-font-style="editorial"\]/);
  assert.doesNotMatch(styles, /html\[data-num-font='sans'\]/);
});

test('settings revamp: 6 clean tabs, separated uneditable cloud sync, and zero em-dashes in modal-settings', () => {
  const modalMatch = indexHtml.match(/<div id="modal-settings"[\s\S]*?<\/form>\s*<\/div>\s*<\/div>\s*<\/div>/);
  assert.ok(modalMatch, '#modal-settings should exist');
  const modalHtml = modalMatch[0];

  // Zero em-dashes in #modal-settings (antislop R-02)
  assert.doesNotMatch(modalHtml, /—/, '#modal-settings must not contain em-dashes');

  // 6 tabs: store, staff (Staff & Security), printing, appearance, cloud (Cloud Sync), data
  const tabs = [...modalHtml.matchAll(/data-action="settings-tab"\s+data-tab="([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(tabs, ['store', 'staff', 'printing', 'appearance', 'cloud', 'data']);
  assert.doesNotMatch(modalHtml, /data-settings-pane="security"/);

  // Store tab holds thresholds so Save changes persists them
  const storePane = modalHtml.match(/<section[^>]*data-settings-pane="store"[\s\S]*?<\/section>/)[0];
  assert.match(storePane, /id="settings-settle-threshold"/);
  assert.match(storePane, /id="settings-shift-variance"/);
  assert.match(storePane, /type="hidden"\s+id="settings-gcash-qr"/);
  assert.match(storePane, /data-action="clear-qr"/);

  // Staff & Security tab holds both manager PIN and cashier accounts
  const staffPane = modalHtml.match(/<section[^>]*data-settings-pane="staff"[\s\S]*?<\/section>/)[0];
  assert.match(staffPane, /id="settings-current-pin"/);
  assert.match(staffPane, /id="settings-new-pin"/);
  assert.match(staffPane, /id="settings-pin-btn"/);
  assert.match(staffPane, /id="staff-list"/);
  assert.match(staffPane, /id="staff-new-name"/);

  // Appearance tab has 5 shop accents and 4 readable text scales, no font/numfont pickers
  const appPane = modalHtml.match(/<section[^>]*data-settings-pane="appearance"[\s\S]*?<\/section>/)[0];
  const accents = [...appPane.matchAll(/data-accent="([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(accents, ['blue', 'emerald', 'amber', 'teal', 'graphite']);
  const scales = [...appPane.matchAll(/data-scale="([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(scales, ['0.9', '1', '1.1', '1.25']);
  assert.doesNotMatch(appPane, /set-font-style/);
  assert.doesNotMatch(appPane, /set-numfont/);

  // Cloud Sync tab is separated and holds uneditable URL and pairing
  const cloudPane = modalHtml.match(/<section[^>]*data-settings-pane="cloud"[\s\S]*?<\/section>/)[0];
  assert.match(cloudPane, /id="settings-sync-url"/);
  assert.match(cloudPane, /id="settings-pair-code"/);
  assert.match(cloudPane, /id="btn-pair-cloud"/);
  assert.match(cloudPane, /https:\/\/repairsync\.bot-keep\.xyz/);
  assert.match(cloudPane, /readonly/);

  // Data tab cuts reset-demo, duplicate inventory import, and does not hold sync-url
  const dataPane = modalHtml.match(/<section[^>]*data-settings-pane="data"[\s\S]*?<\/section>/)[0];
  assert.doesNotMatch(dataPane, /reset-demo/);
  assert.doesNotMatch(dataPane, /import-csv/);
  assert.doesNotMatch(dataPane, /open-audit/);
  assert.doesNotMatch(dataPane, /id="settings-sync-url"/);
  // #inv-import-file still exists in #view-inventory so Inventory toolbar Import works
  assert.match(indexHtml, /id="inv-import-file"/);

  // Dashboard has cloud discovery banner
  assert.match(indexHtml, /id="dash-cloud-banner"/);
  assert.match(indexHtml, /https:\/\/repairsync\.bot-keep\.xyz\//);
});

test('appearance module: locks mono numbers and workstation font, normalizes accents and scales', async () => {
  const mockDataset = {};
  const mockStyle = { setProperty: () => {} };
  global.document = {
    documentElement: {
      dataset: mockDataset,
      style: mockStyle,
      classList: { contains: () => false, toggle: () => {}, add: () => {}, remove: () => {} },
    },
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
  };
  global.window = {
    matchMedia: () => ({ matches: false, addEventListener: () => {} }),
  };
  global.localStorage = {
    getItem: () => JSON.stringify({ accent: 'violet', fontScale: '0.85', numFont: 'sans', fontStyle: 'editorial' }),
    setItem: () => {},
  };

  const { readAppearance, applyAppearance } = await import('../public/js/theme.js');
  const pref = readAppearance();
  assert.equal(pref.accent, 'blue');
  assert.equal(pref.fontScale, '1');
  assert.equal(pref.numFont, 'mono');
  assert.equal(pref.fontStyle, 'workstation');

  applyAppearance(pref);
  assert.equal(mockDataset.numFont, 'mono');
  assert.equal(mockDataset.fontStyle, 'workstation');
});
