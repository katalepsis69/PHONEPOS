// Workstation appearance: base theme, brand accent, text scale, and table density.
// Saved per machine in localStorage; numbers stay locked to tabular monospace.
import { applyTheme, applyThemeVisual, showToast } from './ui.js';

// Each accent clears >= 4.5:1 contrast across dark (hi) and light (lo) surfaces.
const ACCENTS = {
  blue:     { hi: '#5b86f5', base: '#3e6de7', lo: '#2f52ad', ink: '#ffffff' },
  emerald:  { hi: '#63cf90', base: '#4bc982', lo: '#1f7a4c', ink: '#04231a' },
  amber:    { hi: '#e6b671', base: '#e0a458', lo: '#9a6a2f', ink: '#1a1206' },
  teal:     { hi: '#5cbcda', base: '#46b0d3', lo: '#256f8b', ink: '#06222c' },
  graphite: { hi: '#8a8a8a', base: '#3a3a3a', lo: '#1f1f1f', ink: '#f5f5f5' },
};

const VALID_SCALES = ['0.9', '1', '1.1', '1.25'];
const VALID_DENSITIES = ['compact', 'cozy', 'roomy'];

const DEFAULTS = { mode: 'dark', accent: 'blue', fontScale: '1', density: 'cozy', numFont: 'mono', fontStyle: 'workstation' };

export function readAppearance() {
  try {
    const saved = JSON.parse(localStorage.getItem('techparts_appearance') || '{}');
    const legacyTheme = localStorage.getItem('techparts_theme');
    if (saved.mode !== 'auto' && (legacyTheme === 'light' || legacyTheme === 'dark')) {
      saved.mode = legacyTheme;
    }
    const merged = { ...DEFAULTS, ...saved };
    if (!ACCENTS[merged.accent]) merged.accent = DEFAULTS.accent;
    if (!VALID_SCALES.includes(String(merged.fontScale))) merged.fontScale = DEFAULTS.fontScale;
    if (!VALID_DENSITIES.includes(merged.density)) merged.density = DEFAULTS.density;
    merged.numFont = 'mono';
    merged.fontStyle = 'workstation';
    return merged;
  } catch (_) {
    return { ...DEFAULTS };
  }
}

function writeAppearance(app) {
  try { localStorage.setItem('techparts_appearance', JSON.stringify(app)); } catch (_) {}
}

export function applyAppearance(app = readAppearance()) {
  const root = document.documentElement;

  if (app.mode === 'auto') {
    applyThemeVisual(window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  } else {
    applyTheme(app.mode === 'light' ? 'light' : 'dark');
  }

  const a = ACCENTS[app.accent] || ACCENTS.blue;
  const light = !root.classList.contains('dark');
  root.style.setProperty('--accent', light ? a.lo : a.base);
  root.style.setProperty('--accent-hi', light ? `color-mix(in oklab, ${a.lo} 80%, #000)` : a.hi);
  root.style.setProperty('--accent-lo', a.lo);
  root.style.setProperty('--accent-ink', light ? '#ffffff' : a.ink);
  root.style.setProperty('--accent-vivid', a.base);
  const tint = light ? a.lo : a.base;
  root.style.setProperty('--accent-soft', `color-mix(in oklab, ${tint} 14%, transparent)`);
  root.style.setProperty('--accent-line', `color-mix(in oklab, ${tint} 42%, transparent)`);

  const scale = VALID_SCALES.includes(String(app.fontScale)) ? String(app.fontScale) : '1';
  root.style.setProperty('--font-scale', scale);

  root.dataset.density = VALID_DENSITIES.includes(app.density) ? app.density : 'cozy';
  root.dataset.numFont = 'mono';
  root.dataset.fontStyle = 'workstation';
}

export function initAppearance() {
  applyAppearance();
}

let inited = false;
export function initAppearanceModal() {
  if (inited) return;
  inited = true;

  document.addEventListener('click', e => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const act = el.dataset.action;
    const app = readAppearance();

    if (act === 'theme-mode') {
      app.mode = el.dataset.mode;
    } else if (act === 'set-accent') {
      if (ACCENTS[el.dataset.accent]) app.accent = el.dataset.accent;
    } else if (act === 'set-density') {
      if (VALID_DENSITIES.includes(el.dataset.density)) app.density = el.dataset.density;
    } else if (act === 'set-font-scale') {
      if (VALID_SCALES.includes(String(el.dataset.scale))) app.fontScale = String(el.dataset.scale);
    } else if (act === 'appearance-reset') {
      Object.assign(app, DEFAULTS);
      writeAppearance(app);
      applyAppearance(app);
      syncAppearanceModal(app);
      showToast('Appearance reset to defaults', 'info');
      return;
    } else {
      return;
    }

    writeAppearance(app);
    applyAppearance(app);
    syncAppearanceModal(app);
  });

  const darkMq = window.matchMedia('(prefers-color-scheme: dark)');
  const onSchemeChange = () => {
    if (readAppearance().mode === 'auto') applyAppearance();
  };
  if (darkMq.addEventListener) darkMq.addEventListener('change', onSchemeChange);
  else if (darkMq.addListener) darkMq.addListener(onSchemeChange);
}

export function syncAppearanceModal(app = readAppearance()) {
  const accent = ACCENTS[app.accent] ? app.accent : 'blue';
  const scale = VALID_SCALES.includes(String(app.fontScale)) ? String(app.fontScale) : '1';
  const density = VALID_DENSITIES.includes(app.density) ? app.density : 'cozy';
  document.querySelectorAll('[data-action="theme-mode"]').forEach(b =>
    b.classList.toggle('is-active', b.dataset.mode === app.mode));
  document.querySelectorAll('[data-action="set-density"]').forEach(b =>
    b.classList.toggle('is-active', b.dataset.density === density));
  document.querySelectorAll('.accent-dot').forEach(b =>
    b.classList.toggle('is-active', b.dataset.accent === accent));
  document.querySelectorAll('[data-action="set-font-scale"]').forEach(b =>
    b.classList.toggle('is-active', String(b.dataset.scale) === scale));
}
