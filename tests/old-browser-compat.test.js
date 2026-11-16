// Shop PCs arrive with frozen factory browsers (offline Win10 LTSC, Edge ~2021)
// and never update. Every layout/contrast-critical declaration must therefore
// ship a plain-CSS fallback on the line before the modern one, and decorative
// backdrop-filter blur must stay out: on driverless machines it is recomposited
// in software on every paint. This test fails the build if either regresses.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { compatTransform, oklchToCss } = require('../scripts/compat-css');

const root = path.join(__dirname, '..');
const css = fs.readFileSync(path.join(root, 'public', 'styles.css'), 'utf8').split(/\r?\n/);

// [modern declaration, required plain fallback on the previous line]
const PROTECTED = [
  [/background: color-mix\(in oklab, #050b15/, /background: rgba\(5, 11, 21, 0\.\d+\);/],
  [/background: color-mix\(in oklab, var\(--app-bg\)/, /background: var\(--app-bg\);/],
  [/background: color-mix\(in oklab, var\(--surface\) 92%/, /background: var\(--surface\);/],
  [/box-shadow: 0 0 0 3px color-mix.*!important/, /box-shadow: 0 0 0 3px var\(--[a-z-]+\) !important;/],
  [/outline: 2px solid color-mix/, /outline: 2px solid var\(--[a-z-]+\);/],
  [/color: color-mix\(in oklab, var\(--danger\) 75%/, /color: var\(--danger\);/],
];

test('no backdrop-filter blur ships (software compositing tax on weak GPUs)', () => {
  const hits = css.map((l, i) => [i + 1, l]).filter(([, l]) => /backdrop-filter/.test(l));
  assert.deepStrictEqual(hits, [], `backdrop-filter at lines ${hits.map(h => h[0]).join(', ')}`);
});

test('every dvh declaration has a vh fallback on the previous line', () => {
  css.forEach((line, i) => {
    const m = line.match(/:\s*(\d+(?:\.\d+)?)dvh/);
    if (!m) return;
    const prev = css[i - 1] || '';
    assert.ok(
      prev.includes(`${m[1]}vh;`) && !prev.includes('dvh'),
      `line ${i + 1} (${line.trim()}) lacks a plain ${m[1]}vh fallback on line ${i}`
    );
  });
});

test('contrast/layout-critical color-mix declarations carry a plain fallback', () => {
  css.forEach((line, i) => {
    for (const [modern, fallback] of PROTECTED) {
      if (!modern.test(line)) continue;
      assert.ok(
        fallback.test(css[i - 1] || ''),
        `line ${i + 1} (${line.trim()}) lacks its plain fallback on line ${i}`
      );
    }
  });
});

test('brand chips fall back to the phone template, not clothing retail', () => {
  const pos = fs.readFileSync(path.join(root, 'public', 'js', 'views', 'pos.js'), 'utf8');
  assert.match(pos, /TEMPLATE_BRANDS\?\.\[mode\] \|\| TEMPLATE_BRANDS\?\.phone/);
});

test('no view wears the generic "server didn\'t answer" sentence', () => {
  const dir = path.join(root, 'public', 'js');
  const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => {
    const p = path.join(d, e.name);
    return e.isDirectory() ? walk(p) : (p.endsWith('.js') ? [p] : []);
  });
  for (const file of walk(dir)) {
    const src = fs.readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    assert.ok(
      !/The server didn't answer/.test(src),
      `${path.relative(root, file)} still renders the generic failure sentence; use describeLoadFailure`
    );
  }
});

test('catalog load failure carries the real cause into the empty state', () => {
  const pos = fs.readFileSync(path.join(root, 'public', 'js', 'views', 'pos.js'), 'utf8');
  assert.match(pos, /S\.catalogLoadError = await describeLoadFailure\(err, res\)/);
  assert.match(pos, /escHtml\(S\.catalogLoadError \|\|/);
});

test('every color-mix declaration in styles.css carries a plain fallback on the line above', () => {
  css.forEach((line, i) => {
    if (!/color-mix\(/.test(line)) return;
    const prop = line.trim().split(':')[0];
    const prev = (css[i - 1] || '').trim();
    assert.ok(
      prev.startsWith(`${prop}:`) && !/color-mix\(/.test(prev),
      `line ${i + 1} (${line.trim()}) lacks a plain ${prop} fallback on line ${i}`
    );
  });
});

test('tailwind.build.css compiles without @layer, oklch(), or bare rotate properties', () => {
  const tw = fs.readFileSync(path.join(root, 'public', 'tailwind.build.css'), 'utf8');
  assert.strictEqual((tw.match(/@layer\b/g) || []).length, 0, 'built CSS must unwrap @layer for Edge < 99');
  assert.strictEqual((tw.match(/oklch\(/gi) || []).length, 0, 'built CSS must resolve oklch() for Edge < 111');
  const strippedTransforms = tw.replace(/transform:rotate\((\d+(?:\.\d+)?deg)\);rotate:\1/g, '');
  const bareRotate = strippedTransforms.match(/(?:^|[;{])rotate:\d/g) || [];
  assert.deepStrictEqual(bareRotate, [], 'rotate properties must be preceded by transform:rotate(...)');
  assert.match(tw, /transform:rotate\(90deg\);rotate:90deg/);

  const out = compatTransform('@layer utilities{.a{color:oklch(76.9% .188 70.08);rotate:90deg}}@layer components;');
  assert.ok(!/@layer/.test(out));
  assert.match(out, /#fe9a00/);
  assert.match(out, /transform:rotate\(90deg\);rotate:90deg/);
  assert.strictEqual(oklchToCss('60% 0.15 240 / 50%'), 'rgba(0,137,208,0.5)');
  assert.strictEqual(oklchToCss('76.9% .188 70.08'), '#fe9a00');
});

test('styles.css provides explicit overlay z-index, [inert] lock, and non-:has print rule', () => {
  const styles = css.join('\n');
  assert.match(styles, /\[inert\]\s*\{\s*pointer-events:\s*none;\s*user-select:\s*none;\s*\}/);
  assert.match(styles, /\.modal-backdrop\s*\{\s*position:\s*fixed;\s*inset:\s*0;\s*z-index:\s*50;/);
  assert.match(styles, /\.gate\s*\{\s*position:\s*fixed;\s*inset:\s*0;\s*z-index:\s*85;/);
  assert.match(styles, /#pin-setup-overlay\s*\{\s*z-index:\s*95;\s*\}/);
  assert.match(styles, /#license-overlay\s*\{\s*z-index:\s*100;\s*\}/);
  assert.match(styles, /#server-down-overlay\s*\{\s*z-index:\s*120;\s*\}/);
  assert.match(styles, /body\[data-tab\]\s*>\s*\*:not\(#printable-receipt\)/);
  assert.match(styles, /\.check--pill input:checked \+ span/);
});

test('syncAppInert sets DOM inert attribute and blurs focus trapped in inert containers', () => {
  const ui = fs.readFileSync(path.join(root, 'public', 'js', 'ui.js'), 'utf8');
  const start = ui.indexOf('export function syncAppInert()');
  const end = ui.indexOf('export function showGate(');
  const fnCode = ui.slice(start, end).replace(/export /g, '');

  const attrs = (init = {}) => {
    const map = new Set();
    return {
      ...init,
      attrs: map,
      classList: { contains: c => c === 'hidden' && !!init.hidden },
      toggleAttribute(name, force) {
        if (force) map.add(name);
        else map.delete(name);
      }
    };
  };
  let blurred = false;
  const app = attrs({ hidden: false });
  const gate = attrs({ hidden: false });
  const modal = attrs({ id: 'm1', hidden: true });
  const ctx = vm.createContext({
    S: { modalStack: [] },
    document: {
      body: {},
      activeElement: { closest: sel => (sel === '[inert]' ? app : null), blur() { blurred = true; } },
      querySelector: sel => (sel === '.app' ? app : null),
      querySelectorAll: sel => (sel.startsWith('.modal-backdrop') ? [modal] : []),
      getElementById: id => (id === 'login-gate' ? gate : null)
    }
  });
  vm.runInContext(fnCode, ctx);
  ctx.syncAppInert();
  assert.strictEqual(app.inert, true);
  assert.ok(app.attrs.has('inert'), 'inert attribute synced for Edge < 102 CSS rule');
  assert.strictEqual(blurred, true, 'active element inside inert container blurred');
});

test('api.js polyfills missing crypto.randomUUID and opens login gate on unauthenticated 401', async () => {
  const apiSrc = fs.readFileSync(path.join(root, 'public', 'js', 'api.js'), 'utf8')
    .replace(/^import .*$/gm, '');
  const S = {
    sessionToken: null,
    elevationToken: null,
    elevationExpiresAt: 0,
    licenseCheckInFlight: false,
    loginGateRendering: false
  };
  let gateCalls = [];
  const overlayHidden = {
    'server-down-overlay': true,
    'license-overlay': true,
    'pin-setup-overlay': true,
    'login-gate': true
  };
  const makeOverlay = id => ({ classList: { contains: c => c === 'hidden' && overlayHidden[id] } });
  const cryptoStub = {
    getRandomValues: arr => {
      for (let i = 0; i < arr.length; i++) arr[i] = i + 1;
      return arr;
    }
  };
  let status = 401;
  const ctx = vm.createContext({
    S,
    Headers: class {},
    Uint8Array,
    Date,
    crypto: cryptoStub,
    checkLicenseStatus: async () => {},
    clearSession: () => { S.sessionToken = null; },
    renderLoginGate: async (msg) => { gateCalls.push(msg); },
    document: { getElementById: id => makeOverlay(id) },
    window: { fetch: async () => ({ status }) }
  });
  vm.runInContext(apiSrc, ctx);

  assert.strictEqual(typeof cryptoStub.randomUUID, 'function');
  assert.match(cryptoStub.randomUUID(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

  await ctx.window.fetch('/api/customers');
  assert.strictEqual(gateCalls.length, 1);
  assert.match(gateCalls[0], /Login required/);

  // Do not reset an already open setup or login overlay on background 401s.
  overlayHidden['pin-setup-overlay'] = false;
  await ctx.window.fetch('/api/inventory');
  assert.strictEqual(gateCalls.length, 1);
});