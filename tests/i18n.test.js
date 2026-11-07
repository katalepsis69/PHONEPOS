const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// Read i18n module source
const i18nSource = fs.readFileSync(path.join(__dirname, '../public/js/i18n.js'), 'utf8');

test('i18n: zero em dashes in translation dictionaries', () => {
  assert.doesNotMatch(i18nSource, /—/, 'i18n.js contains no em dashes');
});

test('i18n: strictly uses Retail and Wholesale terminology', () => {
  assert.match(i18nSource, /Retail/);
  assert.match(i18nSource, /Wholesale/);
  // Ensure no technician pricing in labels
  assert.doesNotMatch(i18nSource, /technician/i);
});

test('i18n: en and tl dictionaries have identical keys', () => {
  // Evaluated, not regexed: the old /en:\s*\{([^}]+)\}/ match stopped at the
  // first closing brace, so it would silently compare a truncated dictionary
  // (and passed with both dictionaries emptied). Loading the module's real
  // object is the parity check.
  const vm = require('node:vm');
  const context = { localStorage: { getItem: () => 'en', setItem: () => {} }, document: { documentElement: {} } };
  // The module's `const I18N` is not a global, so the value is taken from the
  // script's completion value instead of a context property.
  const I18N = vm.runInNewContext(`${i18nSource.replace(/^export /gm, '')}\n; I18N`, context);
  assert.ok(I18N && I18N.en && I18N.tl, 'both dictionaries must exist');

  const enKeys = Object.keys(I18N.en).sort();
  const tlKeys = Object.keys(I18N.tl).sort();
  assert.deepStrictEqual(enKeys, tlKeys, 'en and tl key sets must be identical');

  // Not merely present: a non-trivial, fully populated dictionary.
  assert.ok(enKeys.length > 50, `the English dictionary is suspiciously small (${enKeys.length} keys)`);
  for (const [lang, dict] of Object.entries(I18N)) {
    for (const [key, value] of Object.entries(dict)) {
      assert.strictEqual(typeof value, 'string', `${lang}.${key} must be a string`);
      assert.ok(value.trim().length > 0, `${lang}.${key} is empty`);
    }
  }
});

test('i18n: index.html has language toggle button and data-i18n tags', () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  assert.match(html, /id="lang-toggle-btn"/, 'lang-toggle-btn exists in topbar');
  assert.match(html, /data-action="toggle-lang"/, 'toggle-lang action wired');
  assert.match(html, /data-i18n="nav\.pos"/, 'data-i18n attributes present on nav items');
  assert.match(html, /data-i18n="bulk\.title"/, 'bulk edit modal title has data-i18n');
  assert.match(html, /data-i18n="bulk\.opt_adjust_price"/, 'bulk edit action options have data-i18n');
  assert.match(html, /data-i18n="part\.add_title"/, 'add part modal has data-i18n');
  assert.match(html, /data-i18n="part\.edit_title"/, 'edit part modal has data-i18n');
  assert.match(html, /data-i18n="stock\.adjust_title"/, 'adjust stock modal has data-i18n');
});
