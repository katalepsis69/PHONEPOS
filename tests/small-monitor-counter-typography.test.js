const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const styles = fs.readFileSync(path.join(ROOT, 'public/styles.css'), 'utf8');
const indexHtml = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');

test('smaller monitor counter ergonomics: compact spacing and large typography', () => {
  // Query covers standard smaller POS displays (1366x768, 1280x800, 1024x768, height <= 860px)
  assert.match(styles, /@media \(max-width: 1366px\), \(max-height: 860px\) \{/);

  // Compact layout: less dead space around workstation chrome
  assert.match(styles, /\.workspace \{\s*padding: 8px 10px 10px !important;/);
  assert.match(styles, /\.topbar \{\s*padding: 6px 14px !important;/);
  assert.match(styles, /\.counter \{\s*gap: 8px 10px !important;/);

  // Big letters and numbers on data tables
  assert.match(styles, /\.ptable thead th \{[\s\S]*?font-size: 0\.78125rem !important;/);
  assert.match(styles, /\.ptable tbody td \{[\s\S]*?font-size: 0\.875rem !important;/);
  assert.match(styles, /\.pname__t \{[\s\S]*?font-size: 0\.90625rem !important;[\s\S]*?font-weight: 700 !important;/);
  assert.match(styles, /\.ptable td\.is-num,[\s\S]*?\.money \{[\s\S]*?font-size: 0\.9375rem !important;[\s\S]*?font-weight: 750 !important;/);

  // Big numbers in checkout totals, change box, and stat panels
  assert.match(styles, /\.tgrand__v \{[\s\S]*?font-size: 1\.5625rem !important;[\s\S]*?font-weight: 800 !important;/);
  assert.match(styles, /\.pay-change-box strong \{[\s\S]*?font-size: 1\.125rem !important;/);
  assert.match(styles, /\.stat__value \{[\s\S]*?font-size: 1\.375rem !important;[\s\S]*?font-weight: 800 !important;/);

  // Prominent checkout touch CTA (>= 44px height)
  assert.match(styles, /\.btn-primary--pos \{[\s\S]*?font-size: 0\.9375rem !important;[\s\S]*?min-height: 46px !important;/);
});

test('narrow screen rail: collapses to 68px icon rail at 1366px width to free 182px space', () => {
  assert.match(styles, /@media \(max-width: 1366px\) \{\s*:root \{\s*--rail-w: 68px;\s*\}/);
});

test('anti-slop copy hygiene: zero em dashes in smaller monitor styles and markup', () => {
  const smallMonitorBlock = styles.slice(
    styles.indexOf('@media (max-width: 1366px), (max-height: 860px) {'),
    styles.indexOf('@media (max-width: 1280px) {')
  );
  assert.doesNotMatch(smallMonitorBlock, /—/, 'smaller monitor styles must have no em dashes');
  assert.doesNotMatch(indexHtml, /text-\[10\.5px\]/, 'no hardcoded 10.5px micro-text in index.html');
});
