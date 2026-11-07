# Workstation Typography Presets Design Specification

**Date:** 2026-10-13  
**Status:** Approved  
**Related Skills & Philosophies:** `/ponytail` (minimal diff, 0 runtime dependencies), `/antislop` (craftsmanship, purposeful design, human ergonomics), `/antislop-ui`, `/antislop-code`, `/antislop-human` (high legibility, WCAG 2.2 contrast AA, touch targets >= 44px), `/ui-design-spec` (all-scope design engineering, optical tracking and optical weight math).

---

## 1. Problem Statement & Motivation

The TechParts POS application currently hardcodes its display and heading font (`--font-display`) to **Newsreader** (`"Newsreader", Georgia, serif`), a high-contrast editorial serif bundled locally in `public/fonts/newsreader-latin-wght-normal.woff2`.

While aesthetically stylized for editorial layouts, in a fast-paced retail POS and repair management environment:
1. High-contrast serif letterforms (thin vertical/horizontal stroke contrast) cause visual vibration and optical fatigue when viewed on workstation monitors over 8-12 hour technician shifts.
2. Headings, modal titles, panel headers, and table titles are difficult to scan rapidly.
3. Users currently have no mechanism in **Settings -> Appearance** to adjust typography style, despite having controls for text size, table density, numeric fonts, and accent colors.

---

## 2. Goals & Non-Goals

### Goals
- Relieve cashier and technician eye fatigue immediately by defaulting to an ultra-crisp, neutral **Clean Workstation Sans** font stack.
- Provide a curated **Font Style** selector in **Settings -> Appearance** with 4 distinct, cohesive typography personalities:
  - **Workstation (Default):** Clean, modern system sans with uniform stroke width.
  - **Humanist:** Taller x-height, open apertures, engineered for maximum digital legibility.
  - **Grotesk:** Compact neo-grotesque for dense ticket lists and narrow counter terminals.
  - **Editorial:** Retains the original Newsreader serif brand as a user choice.
- Adhere strictly to **0 runtime dependencies**, 0 network downloads, and 100% offline functionality.
- Seamlessly persist the user's choice in `localStorage` (`techparts_appearance`) per workstation.
- Meet WCAG 2.2 AA accessibility standards (contrast ratio >= 4.5:1 for body copy and >= 3:1 for large display headers; touch targets >= 44px; keyboard operability with visible focus indicators).

### Non-Goals
- Introducing external web font CDNs or online requests (the application is completely offline).
- Altering the tabular numeric font system (`--font-numeric` with `tabular-nums` for prices, barcodes, and dates), which already functions properly.
- Unnecessary large-scale refactoring of unaffected components or stylesheets.

---

## 3. Architecture & Token System

### 3.1 CSS Custom Properties (`public/styles.css`)
We decouple the hardcoded serif and define four preset scopes using the `data-font-style` attribute on `document.documentElement` (`<html>`):

```css
/* 1. Default: Clean Workstation (Zero eye strain) */
:root,
html[data-font-style="workstation"] {
  --font-display: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
  --font-text: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
  --font-display-weight: 600;
  --font-display-tracking: -0.02em;
}

/* 2. Humanist / High-Legibility */
html[data-font-style="humanist"] {
  --font-display: "Segoe UI Variable Display", "Aptos Display", "Segoe UI", "SF Pro Display", sans-serif;
  --font-text: "Segoe UI Variable Text", "Aptos", "Segoe UI", "SF Pro Text", sans-serif;
  --font-display-weight: 600;
  --font-display-tracking: -0.015em;
}

/* 3. Modern Grotesk (Compact Counter Density) */
html[data-font-style="grotesk"] {
  --font-display: "SF Pro Display", "Segoe UI", "Helvetica Neue", Arial, sans-serif;
  --font-text: "SF Pro Text", "Segoe UI", "Helvetica Neue", Arial, sans-serif;
  --font-display-weight: 650;
  --font-display-tracking: -0.025em;
}

/* 4. Classic Editorial (Preserves Original Newsreader Serif) */
html[data-font-style="editorial"] {
  --font-display: "Newsreader", Georgia, serif;
  --font-text: system-ui, -apple-system, "Segoe UI", sans-serif;
  --font-display-weight: 650;
  --font-display-tracking: -0.03em;
}
```

### 3.2 Optical Hierarchy Rules
- **Headings (`h1`, `h2`, `h3`):**
  ```css
  h1, h2, h3 {
    font-family: var(--font-display);
    font-weight: var(--font-display-weight, 600);
    letter-spacing: var(--font-display-tracking, -0.02em);
    line-height: 1.15;
    text-wrap: balance;
  }
  ```
- **Interface Titles (`.topbar__title`, `.panel__title`, `.modal-card__title`, `.rail-word`, `.gate__role-title`):**
  Inherit `var(--font-display)` with responsive size scales.
- **Numbers & Math:**
  Continue to use `var(--font-numeric)` with `font-variant-numeric: tabular-nums` to maintain vertical decimal alignment in POS receipts and price tables.

---

## 4. UI & Component Design

### 4.1 Appearance Settings Card (`public/index.html`)
Inside `<section class="settings-pane hidden" data-settings-pane="appearance">`:
Place a wide card (`.apcard.apcard--wide`) containing 4 selectable option buttons (`.apchoice`):

```html
<div class="apcard apcard--wide">
  <span class="apcard__label">
    <i class="ph ph-text-t w-4 h-4 mr-1 inline-block align-middle"></i>Font style <span class="field__opt">workstation typography</span>
  </span>
  <div class="apcard__row font-style-row" role="group" aria-label="Font style">
    <button type="button" class="apchoice" data-action="set-font-style" data-fontstyle="workstation">
      <span class="apmock-font" style="font-family: system-ui, sans-serif; font-weight: 600;">Ag</span>
      <span class="apchoice__name">Workstation</span>
      <span class="apchoice__sub">Clean Sans</span>
    </button>
    <button type="button" class="apchoice" data-action="set-font-style" data-fontstyle="humanist">
      <span class="apmock-font" style="font-family: 'Segoe UI Variable', 'Segoe UI', sans-serif; font-weight: 600;">Ag</span>
      <span class="apchoice__name">Humanist</span>
      <span class="apchoice__sub">Legible</span>
    </button>
    <button type="button" class="apchoice" data-action="set-font-style" data-fontstyle="grotesk">
      <span class="apmock-font" style="font-family: 'SF Pro Display', Arial, sans-serif; font-weight: 700;">Ag</span>
      <span class="apchoice__name">Grotesk</span>
      <span class="apchoice__sub">Compact</span>
    </button>
    <button type="button" class="apchoice" data-action="set-font-style" data-fontstyle="editorial">
      <span class="apmock-font" style="font-family: 'Newsreader', Georgia, serif; font-weight: 600;">Ag</span>
      <span class="apchoice__name">Editorial</span>
      <span class="apchoice__sub">Serif</span>
    </button>
  </div>
  <span class="apcard__hint">Select the typography stack most comfortable for your screen and shift length.</span>
</div>
```

### 4.2 Styling & Ergonomics (`public/styles.css`)
- Glyph preview (`.apmock-font`):
  ```css
  .apmock-font {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 1.125rem;
    line-height: 1;
    height: 24px;
    margin-bottom: 2px;
    color: var(--txt);
  }
  ```
- Choice button bounding boxes satisfy the minimum 44px tap/click target.
- Zero deadzones: internal padding handles interactive click area.
- Focused state: `:focus-visible` with high-contrast outline (`--accent`).

---

## 5. State Management & Persistence (`public/js/theme.js`)

### 5.1 Defaults & Schema
Update `DEFAULTS`:
```javascript
const VALID_FONT_STYLES = ['workstation', 'humanist', 'grotesk', 'editorial'];

const DEFAULTS = {
  mode: 'dark',
  accent: 'blue',
  fontScale: '1',
  density: 'cozy',
  numFont: 'mono',
  fontStyle: 'workstation'
};
```

### 5.2 Application Routine (`applyAppearance`)
```javascript
const fontStyle = VALID_FONT_STYLES.includes(app.fontStyle) ? app.fontStyle : 'workstation';
root.dataset.fontStyle = fontStyle;
```

### 5.3 User Interaction (`initAppearanceModal`)
```javascript
} else if (act === 'set-font-style') {
  app.fontStyle = el.dataset.fontstyle;
}
```

### 5.4 Sync UI Highlights (`syncAppearanceModal`)
```javascript
document.querySelectorAll('[data-action="set-font-style"]').forEach(b =>
  b.classList.toggle('is-active', b.dataset.fontstyle === (app.fontStyle || 'workstation')));
```

### 5.5 Defaults Reset
When `appearance-reset` triggers, `Object.assign(app, DEFAULTS)` naturally resets `fontStyle` back to `'workstation'` and calls `applyAppearance(app)`.

---

## 6. Verification & Accessibility Checklist

1. **Visual Ergonomics:** Headings and text render with clean, uniform sans strokes by default with no blurry or high-contrast serif fatigue.
2. **Preset Switching:** Clicking each of the 4 options instantly updates headings and body text without page reload or layout shift.
3. **Contrast:** WCAG 2.2 AA verified >= 4.5:1 for body and >= 3:1 for headings across both Light and Dark modes.
4. **Keyboard Accessibility:** Full Tab and Shift-Tab navigation with visible focus rings.
5. **Persistence:** Refreshing the browser or restarting the application preserves the selected `fontStyle`.
6. **Reset Verification:** Clicking "Reset to defaults" properly restores `'workstation'`.
7. **Regression Testing:** Run existing test suites (`node --test tests/*.test.js`) and build commands to confirm zero breakages.
