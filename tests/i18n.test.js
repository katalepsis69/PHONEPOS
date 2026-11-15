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

test('i18n: every en key is referenced somewhere in the frontend', () => {
  // The 2026-11-14 cleaning removed 24 dead lines (8 keys that survived three
  // passes because nothing pinned usage; inv.th_status was orphaned the day the
  // STATUS column left the inventory table). This guard keeps the dictionary
  // honest: a key nobody references is a bug in the table, not a reserve.
  const vm = require('node:vm');
  const context = { localStorage: { getItem: () => 'en', setItem: () => {} }, document: { documentElement: {} } };
  const loaded = vm.runInNewContext(`${i18nSource.replace(/^export /gm, '')}\n; ({ I18N, PROFILE_VOCAB })`, context);

  let corpus = '';
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith('.js') && entry.name !== 'i18n.js') corpus += fs.readFileSync(p, 'utf8');
    }
  })(path.join(__dirname, '../public/js'));
  corpus += fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  corpus += fs.readFileSync(path.join(__dirname, '../public/report.html'), 'utf8');

  // Two families are looked up with computed keys, so a literal grep cannot see
  // them: repairs.status_${s} (views/repairs.js) and title.${tab} (main.js).
  const dynamicPrefixes = ['repairs.status_', 'title.'];
  const dead = Object.keys(loaded.I18N.en).filter(key =>
    !corpus.includes(key) && !dynamicPrefixes.some(prefix => key.startsWith(prefix)));
  assert.deepStrictEqual(dead, [], `i18n keys referenced nowhere: ${dead.join(', ')}`);
});

test('i18n: PROFILE_VOCAB only overrides keys the main en table defines', () => {
  const vm = require('node:vm');
  const context = { localStorage: { getItem: () => 'en', setItem: () => {} }, document: { documentElement: {} } };
  const loaded = vm.runInNewContext(`${i18nSource.replace(/^export /gm, '')}\n; ({ I18N, PROFILE_VOCAB })`, context);
  const orphans = [];
  for (const [profile, vocab] of Object.entries(loaded.PROFILE_VOCAB)) {
    for (const key of Object.keys(vocab.en)) {
      if (!(key in loaded.I18N.en)) orphans.push(`${profile}:${key}`);
    }
  }
  assert.deepStrictEqual(orphans, [], `profile vocab keys with no base key: ${orphans.join(', ')}`);
});
