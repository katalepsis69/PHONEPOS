# Real-Time Monitoring Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align all three TechParts POS monitoring surfaces (Desk Dashboard, Local Phone Report PWA, and Cloud Live Telemetry PWA) on financial formulas, freshness states (`Live` / `Stale` / `Offline`), 20s polling behavior, light/dark themes, and phone-to-desktop responsive layout.

**Architecture:** Keep the existing zero-dependency Node.js 22 + SQLite architecture. Bring `cloud/server.js` `/api/analytics` into exact formula parity with `src/analytics.js` (RMA replacement cost, proportional sale discount on top products, and `TZ_MODIFIER` trend bucketing), add a shared 3-state freshness model (`live`, `stale`, `offline`) across all three frontends, add silent 20s live polling to the desk dashboard when viewing a window ending today, and apply `antislop` + `ui-design-spec` responsive/theme/contrast fixes to `public/report.html` and `cloud/public/index.html`.

**Tech Stack:** Node.js 22 (`node:http`, `node:sqlite`, `node:test`), Vanilla JS, HTML5, Tailwind CSS v4 (`npm run build:css`).

## Global Constraints

- Zero runtime dependencies (`dependencies: {}` in `package.json`).
- Pure Vanilla JS + HTML5 + CSS (no React, Vue, or JSX).
- Design Read: Shop-counter & remote manager telemetry for repair shop owners, in the TechParts industrial counter style (`public/styles.css`), dials `ENERGY 1 / RHYTHM 1 / MOTION 1`.
- No em dashes (`—` / `\u2014`) in any new or edited UI copy or code comments (`antislop` R-02).
- No infinite pulse animations on status dots (`antislop-ui` R-19).
- Minimum 44x44px touch targets and WCAG AA contrast (4.5:1 normal text, 3:1 large text / UI boundaries) in both light and dark modes (`antislop-human` R-25, R-32, R-34; `antislop-layoutmobile` R-03).

---

### Task 1: Backend Financial & Timestamp Parity (`src/server.js`, `cloud/server.js`, `tests/analytics.test.js`, `tests/cloud-hardening.test.js`)

**Files:**
- Modify: `src/server.js:1054-1064`
- Modify: `cloud/server.js:651-776`
- Test: `tests/analytics.test.js`
- Test: `tests/cloud-hardening.test.js`

**Interfaces:**
- Produces:
  - `GET /api/dashboard` includes `generated_at: string` (ISO 8601).
  - `GET /api/analytics` on `cloud/server.js` includes `generated_at: string`, `current.collected_total: number`, `current.replacement_cost: number`, `current.return_replacements: number`, deducts `replacement_cost` from `current.net_profit`, applies proportional discount + RMA deductions in `top_products`, and buckets `trend` by `${TZ_MODIFIER}`.

- [ ] **Step 1: Add parity tests in `tests/analytics.test.js` and `tests/cloud-hardening.test.js`**
- [ ] **Step 2: Run tests to verify new assertions fail before implementation**
- [ ] **Step 3: Implement `generated_at` in `src/server.js` and formula/timezone parity in `cloud/server.js`**
- [ ] **Step 4: Run `node --test tests/analytics.test.js tests/cloud-hardening.test.js` to verify PASS**

---

### Task 2: Desk Dashboard Live Polling & Freshness Chip (`public/index.html`, `public/js/views/backoffice.js`, `public/styles.css`, `tests/reports-behavior.test.js`)

**Files:**
- Modify: `public/index.html:660-685`
- Modify: `public/js/views/backoffice.js:1100-1435`
- Modify: `public/styles.css`
- Test: `tests/reports-behavior.test.js`

**Interfaces:**
- Consumes: `GET /api/dashboard` (`generated_at`, `current.replacement_cost`, `range.to`)
- Produces:
  - `#dash-freshness` chip in `#dash-period-bar` with `data-state="live|stale|offline"`.
  - `loadDashboardData({ silent = false })` in `public/js/views/backoffice.js` that skips `loadExceptions` and `loadDayClose` when `silent: true`, suppresses error toasts on silent polls, and updates `#dash-freshness`.
  - 20s poll interval active when `S.currentTab === 'dashboard'`, `!document.hidden`, `hasElevation()`, and the window ends today.

- [ ] **Step 1: Add unit test in `tests/reports-behavior.test.js` for silent poll and freshness chip**
- [ ] **Step 2: Update `public/index.html`, `public/js/views/backoffice.js`, and `public/styles.css`**
- [ ] **Step 3: Run `node --test tests/reports-behavior.test.js tests/dash-scope-ui.test.js tests/dash-scope.test.js`**

---

### Task 3: Local Phone Report PWA Alignment (`public/report.html`, `public/js/report.js`, `tests/report.test.js`)

**Files:**
- Modify: `public/report.html`
- Modify: `public/js/report.js`
- Test: `tests/report.test.js`

**Interfaces:**
- Consumes: `GET /api/report/stats` (`today_sales_profit`, `today_replacement_cost`, `generated_at`) and `GET /api/report/sales`
- Produces:
  - 3-state `#status-pill` (`live`, `stale`, `offline`) keeping figures on screen when stale/offline and showing data age.
  - Light/dark theme toggle (`#btn-theme-toggle`, 44x44px) persisting to `localStorage` (`techparts_report_theme`) and updating `<html class="dark|light">`.
  - Wording alignment: `"Profit after returns"`, replacement cost shown in `#st-refunded-meta` when `today_replacement_cost > 0`, actionable empty state in `#sales-list`.
  - Responsive reflow: `clamp()` type scaling below 360px, 2-column layout (`max-width: 960px`) at `>= 760px`.

- [ ] **Step 1: Add UI & state tests in `tests/report.test.js`**
- [ ] **Step 2: Update `public/report.html` and `public/js/report.js`**
- [ ] **Step 3: Run `node --test tests/report.test.js`**

---

### Task 4: Cloud Live Telemetry PWA Alignment (`cloud/public/index.html`, `cloud/public/app.js`, `tests/cloud-hardening.test.js`)

**Files:**
- Modify: `cloud/public/index.html`
- Modify: `cloud/public/app.js`
- Test: `tests/cloud-hardening.test.js`

**Interfaces:**
- Consumes: `GET /api/analytics`, `GET /api/standing`, `GET /api/overview`, `GET /api/rows`, `GET /events`
- Produces:
  - Static `#conn-beacon` (no infinite pulse animation, `antislop-ui` R-19) + `#stale-badge` supporting `live`, `stale` (<5 min), and `offline` (>=5 min).
  - `.badge.transfer` styling for `payment_method === 'transfer'`.
  - `#card-profit` displaying `Profit After Returns` (`c.net_profit`) with `Gross ₱X · Y% margin` in `#card-margin`.
  - 20s fallback poll when SSE is disconnected + `visibilitychange` refresh.
  - Responsive reflow at `>= 760px` (`max-width: 960px`, 2-column dashboard layout).

- [ ] **Step 1: Add assertions in `tests/cloud-hardening.test.js`**
- [ ] **Step 2: Update `cloud/public/index.html` and `cloud/public/app.js`**
- [ ] **Step 3: Run `node --test tests/cloud-hardening.test.js`**

---

### Task 5: CSS Build, Contrast Verification & Full Test Suite

**Files:**
- Modify: `public/tailwind.build.css` (via `npm run build:css`)

- [ ] **Step 1: Run `npm run build:css`**
- [ ] **Step 2: Verify contrast ratios with `contrast-check.py` and run `npm test`**
- [ ] **Step 3: Record click-through and antislop Delivery Gate report**
