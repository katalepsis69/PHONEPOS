const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const css = read('public/styles.css');
const html = read('public/index.html');
const themeSrc = read('public/js/theme.js');

const rgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
const lum = h => {
  const [r, g, b] = rgb(h).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
const mix = (a, b, t) => '#' + rgb(a).map((v, i) => Math.round(v * t + rgb(b)[i] * (1 - t)).toString(16).padStart(2, '0')).join('');

function tokens(selector) {
  const body = css.match(new RegExp(selector + '\\s*\\{([^}]*)\\}'))[1];
  return Object.fromEntries([...body.matchAll(/--([\w-]+):\s*(#[0-9A-Fa-f]{6})/g)].map(m => [m[1], m[2]]));
}

test('Dim and Paper are offered in Settings, Appearance and saved as their own modes', () => {
  assert.match(html, /data-action="theme-mode" data-mode="dim"/);
  assert.match(html, /data-action="theme-mode" data-mode="paper"/);
  assert.match(themeSrc, /const TONES = \{ dim: 'dark', paper: 'light' \}/);
  // The legacy light/dark key must not overwrite a saved Dim or Paper choice.
  assert.match(themeSrc, /!TONES\[saved\.mode\]/);
});

test('Dim and Paper text clears WCAG AA on every panel and every accent', () => {
  const accentHi = [...themeSrc.matchAll(/hi: '(#[0-9a-f]{6})'/g)].map(m => m[1]);
  const accentLo = [...themeSrc.matchAll(/lo: '(#[0-9a-f]{6})'/g)].map(m => m[1]);
  assert.equal(accentHi.length, 5);

  for (const [name, selector] of [['dim', 'html\\.dark\\[data-tone="dim"\\]'], ['paper', 'html\\.light\\[data-tone="paper"\\]']]) {
    const t = tokens(selector);
    for (const panel of ['app-bg', 'surface', 'surface-2', 'surface-3']) {
      for (const ink of ['txt', 'txt-2', 'txt-3', 'txt-4']) {
        const r = ratio(t[ink], t[panel]);
        assert.ok(r >= 4.5, `${name} ${ink} on ${panel} is ${r.toFixed(2)}:1`);
      }
    }
    for (const panel of ['app-bg', 'surface', 'surface-3']) {
      accentHi.forEach((hi, i) => {
        // Same formulas as applyAppearance in theme.js.
        const text = name === 'dim' ? mix(hi, '#ffffff', 0.65) : mix(accentLo[i], '#000000', 0.8);
        const r = ratio(text, t[panel]);
        assert.ok(r >= 4.5, `${name} accent ${i} text on ${panel} is ${r.toFixed(2)}:1`);
      });
    }
  }
});

test('Dim body text is softer than Dark, Paper panels are not plain white', () => {
  const dark = tokens('html\\.dark,\\s*body\\.dark');
  const dim = tokens('html\\.dark\\[data-tone="dim"\\]');
  const paper = tokens('html\\.light\\[data-tone="paper"\\]');
  assert.ok(ratio(dim.txt, dim.surface) < ratio(dark.txt, dark.surface) - 3, 'Dim must be clearly lower glare than Dark');
  assert.notEqual(paper.surface.toLowerCase(), '#ffffff');
});

test('applyAppearance puts Dim and Paper on the right base theme and keeps the choice', async () => {
  const dataset = {};
  const classes = new Set();
  const props = {};
  const store = { techparts_appearance: JSON.stringify({ mode: 'dim' }), techparts_theme: 'light' };
  global.document = {
    documentElement: {
      dataset,
      style: { setProperty: (k, v) => { props[k] = v; } },
      classList: {
        contains: c => classes.has(c),
        toggle: (c, on) => { if (on) classes.add(c); else classes.delete(c); },
        add: c => classes.add(c), remove: c => classes.delete(c),
      },
    },
    getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener: () => {},
  };
  global.window = { matchMedia: () => ({ matches: false, addEventListener: () => {} }) };
  global.localStorage = { getItem: k => store[k] ?? null, setItem: (k, v) => { store[k] = v; } };

  const { readAppearance, applyAppearance } = await import('../public/js/theme.js');

  assert.equal(readAppearance().mode, 'dim', 'a stale light/dark key must not undo Dim');
  applyAppearance(readAppearance());
  assert.ok(classes.has('dark') && !classes.has('light'));
  assert.equal(dataset.tone, 'dim');
  assert.match(props['--accent-hi'], /#fff/);
  assert.equal(JSON.parse(store.techparts_appearance).mode, 'dim', 'applying Dim must not rewrite it to dark');

  store.techparts_appearance = JSON.stringify({ mode: 'paper' });
  applyAppearance(readAppearance());
  assert.ok(classes.has('light') && !classes.has('dark'));
  assert.equal(dataset.tone, 'paper');
  assert.equal(JSON.parse(store.techparts_appearance).mode, 'paper');

  store.techparts_appearance = JSON.stringify({ mode: 'light' });
  store.techparts_theme = 'light';
  applyAppearance(readAppearance());
  assert.equal(dataset.tone, '', 'plain Light clears the tone');
});
