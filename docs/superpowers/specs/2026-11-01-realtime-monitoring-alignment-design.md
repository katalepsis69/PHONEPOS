# Real-time monitoring alignment: design (updated after full workspace rescan)

Date: 2026-11-02
Status: draft, awaiting owner review

## Goal

Align all **three** manager monitoring surfaces in TechParts POS so they agree on financial formulas (including the 2026-11-02 RMA replacement-cost and proportional discount updates), wording, freshness/connection states (`Live` / `Stale` / `Offline`), theme support, and responsive layout from phone to desktop:

1. **Desk Dashboard ("Reports & profit" tab)**: [public/index.html](file:///C:/Users/sloth/Downloads/phone-repair-pos/public/index.html), [public/js/views/backoffice.js](file:///C:/Users/sloth/Downloads/phone-repair-pos/public/js/views/backoffice.js), [src/analytics.js](file:///C:/Users/sloth/Downloads/phone-repair-pos/src/analytics.js)
2. **Local Phone Report PWA**: [public/report.html](file:///C:/Users/sloth/Downloads/phone-repair-pos/public/report.html), [public/js/report.js](file:///C:/Users/sloth/Downloads/phone-repair-pos/public/js/report.js), [src/server.js](file:///C:/Users/sloth/Downloads/phone-repair-pos/src/server.js) (`/api/report/*`)
3. **Cloud Live Telemetry PWA**: [cloud/server.js](file:///C:/Users/sloth/Downloads/phone-repair-pos/cloud/server.js), [cloud/public/index.html](file:///C:/Users/sloth/Downloads/phone-repair-pos/cloud/public/index.html), [cloud/public/app.js](file:///C:/Users/sloth/Downloads/phone-repair-pos/cloud/public/app.js)

*(Note: `src/`, `public/`, `cloud/`, `tests/`, and `docs/` are listed in `.gitignore` because the public repository tracks release binaries only. The rescan inspected the filesystem directly and picked up both `cloud/` and the 2026-11-02 changes.)*

---

## Findings from Rescan (New Additions & Drift Across the 3 Surfaces)

### A. 2026-11-02 Updates Already Landed in `src/analytics.js` & `public/js/views/backoffice.js`
1. **RMA Replacement Cost in Profit (`src/analytics.js`)**:
   - `getDashboardStats(db)` and `windowKpis(db, w)` now join `inventory` on `wr.replacement_inventory_id`, compute `replacement_cost` (`wr.quantity * COALESCE(i.cost_price, 0.0)` for `return_type = 'replacement'`), subtract it from `netProfit` (`grossProfit - total_refunded - replacement_cost`), and return `today_replacement_cost` / `replacement_cost`.
   - `getPeriodStats(db, ...)` now deducts replacement part costs inside the daily/monthly `trend[].profit` buckets.
   - `getProductPerformance(db, ...)` now allocates sale-level discounts proportionally (`s.total_amount / s.subtotal`), subtracts `lineRefunds` and `refundedUnits`, and subtracts `repCost` from per-part `profit`.
2. **Specialist Rules & Docs Added**:
   - `AGENTS.md`, `GEMINI.md`, `SKILL.md`, and `RELEASE_NOTES.md` added at the repo root.

### B. Drift Discovered in `cloud/` (Cloud Live Telemetry) vs `src/analytics.js`
1. **Missing RMA replacement cost in `/api/analytics` (`cloud/server.js:676-772`)**:
   - `cloud/server.js` computes `net_profit: r2(sales.revenue - items.cost - refunds.total)` without subtracting warranty replacement part cost (`wr.quantity * i.cost_price`), so Cloud Live overstates net profit whenever a warranty replacement swap occurs.
2. **Top-selling parts formula drift (`cloud/server.js:701-716`)**:
   - `cloud/server.js` sums raw `i.total_price` and `i.total_price - quantity * unit_cost` without proportional sale discount allocation (`s.total_amount / s.subtotal`), without subtracting refunded units/amounts, and without subtracting replacement cost (`repCost`).
3. **Timezone bug in trend bucket query (`cloud/server.js:719`)**:
   - Line 719 uses hardcoded `'localtime'` (`date(json_extract(r.row_json,'$.created_at'),'localtime') AS bucket`) while every other query in `cloud/server.js` uses `${TZ_MODIFIER}` (`SHOP_TZ_OFFSET_MINUTES`). On a UTC VPS with `SHOP_TZ_OFFSET_MINUTES=480`, the trend buckets split days at UTC midnight instead of shop midnight.
4. **Missing fields on `/api/analytics` (`cloud/server.js:753-775`)**:
   - Missing `collected_total`, `replacement_cost`, `return_replacements`, and `generated_at`.
5. **UI & Anti-Slop issues in `cloud/public/index.html` & `cloud/public/app.js`**:
   - **Endless pulse loop (R-19 violation)**: `.beacon` in `cloud/public/index.html:107` runs `animation: pulse 2.5s infinite`.
   - **Bank Transfer badge bug**: `cloud/public/app.js:289` maps `s.payment_method === 'transfer'` to the green `cash` badge because it only checks `s.payment_method === 'gcash' ? 'gcash' : 'cash'`.
   - **Profit card mismatch**: `cloud/public/index.html:743` and `app.js:240-245` display `Gross Profit` (`c.gross_profit`) without showing `net_profit` after refunds and replacements, whereas the phone report shows net profit and the desk dashboard shows both.
   - **Desktop/tablet squeeze (R-03 violation)**: `.phone-frame` and `nav.bottom-nav` are locked to `max-width: 480px` at every viewport width instead of reflowing into a two-column layout at `>=760px`.
   - **SSE / Stale recovery**: When SSE drops (`es.onerror`) or the tab returns from background (`visibilitychange`), there is no fallback poll timer (`POLL_MS = 20000`) to keep data and the freshness state (`Live` / `Stale` / `Offline`) accurate.

### C. Drift Between Local Phone Report (`public/report.html` + `public/js/report.js`) and Desk Dashboard (`public/js/views/backoffice.js`)
1. **Parity test missing**: `getDashboardStats(db)` and `getPeriodStats(db, 'day').current` now both include `replacement_cost`, but no test asserts full field-for-field parity across sales, credit downpayments/settlements, cash adjustments, refunds, and replacement swaps.
2. **Desk dashboard never refreshes while open**: `public/js/views/backoffice.js` loads once per tab switch, has no 20s silent poll when viewing a live window (ending today), and has no freshness indicator (`Live` / `Stale` / `Offline`).
3. **Phone report freshness is binary (`Live` / `Offline`)**: No `Stale` state when a poll fails while recent data (<5 min old) is still on screen.
4. **Phone report theme is locked to dark (`<html class="dark">`)**: Unlike the desk app and cloud app, `report.html` has no light/dark theme toggle or `localStorage` persistence (R-21 / R-34).
5. **Phone report layout is locked to `max-width: 560px`**: Needs `clamp()` typography protection below 360px and a two-column reflow at `>=760px` (summary + collections on left, latest sales on right).
6. **Wording & replacement-cost visibility**:
   - Phone report `#st-profit` says `"Net profit"` while `#st-refunded` meta says `"cash + credit refunds"` without surfacing `today_replacement_cost` when replacements occurred.
   - Desk dashboard `#dash-profit-meta` says `Net ₱X after refunds` (should reflect `after refunds & replacements` when `c.replacement_cost > 0`).

---

## Design

### 1. Financial & API Parity (`src/analytics.js`, `src/server.js`, `cloud/server.js`, `tests/`)
- **Shop `/api/dashboard` (`src/server.js`)**: Add `generated_at: new Date().toISOString()` to the response payload so the desk dashboard and phone report share an authoritative server timestamp.
- **Cloud `/api/analytics` (`cloud/server.js`)**:
  - Fix line 719 trend bucket to use `${TZ_MODIFIER}` instead of hardcoded `'localtime'`.
  - Compute `replacement_cost` and `return_replacements` on `warranty_returns` by joining mirrored `inventory` rows (`table_name = 'inventory'` on `shop_id` and `local_id = replacement_inventory_id`), and subtract `replacement_cost` from `net_profit` (`sales.revenue - items.cost - refunds.total - refunds.replacement_cost`), matching `src/analytics.js`.
  - Update `tops` (top products) in `cloud/server.js` to allocate sale-level discounts proportionally (`s.total_amount / s.subtotal`), subtract refunded units/amounts, and subtract replacement part cost (`repCost`), matching `getProductPerformance` in `src/analytics.js`.
  - Include `collected_total`, `replacement_cost`, `return_replacements`, and `generated_at` in the response.
- **Automated Parity Tests**:
  - In `tests/analytics.test.js`: assert that `getDashboardStats(db)` and `getPeriodStats(db, 'day').current` produce identical numbers across cash/GCash/transfer/credit sales, credit settlements, cash refunds, credit refunds, RMA replacements, and voided sales.
  - In `tests/cloud-hardening.test.js`: assert that cloud `/api/analytics` matches shop analytics for RMA replacement cost, discounted top-product revenue/profit, and `SHOP_TZ_OFFSET_MINUTES` trend bucketing.

### 2. Unified Freshness Contract (`Live` / `Stale` / `Offline`) Across All 3 Surfaces
- Shared constants (`POLL_MS = 20000`, `STALE_MAX_MS = 300000` / 5 min):
  - **Live** (`data-state="live"`): last fetch succeeded (and on Cloud, SSE is open or last poll succeeded). Static green dot — **zero infinite pulse animations** (antislop R-19).
  - **Stale** (`data-state="stale"`): last fetch failed, but `lastOkAt` is `< 5 min` ago. Amber warning state (`var(--warn)`), keeps figures on screen, displays `"Stale · data Xm old"`.
  - **Offline** (`data-state="offline"`): last fetch failed and `lastOkAt` is `>= 5 min` ago (or never loaded). Danger state (`var(--danger)`), keeps figures on screen, shows offline banner.

### 3. Desk Dashboard Live Polling (`public/index.html`, `public/js/views/backoffice.js`)
- Add `#dash-freshness` status chip in `#dash-period-bar` next to `#dash-range`.
- Support `loadDashboardData({ silent: true })`:
  - Re-renders KPI cards, trend, collections mix, standing stats, top products, dead stock, and reorder list only when the payload changed.
  - **Never** touches `loadExceptions` or `loadDayClose` on a silent poll so a manager typing a cash count is never interrupted.
  - Suppresses error toasts on silent polls and updates `#dash-freshness` (`Live` / `Stale` / `Offline`) instead.
- Poll every `20s` when `S.currentTab === 'dashboard'`, `!document.hidden`, `hasElevation()`, and the selected window ends today (`!dashState.date || dashState.date === localToday()`). Pause when hidden; refresh immediately on tab/visibility return.

### 4. Local Phone Report Alignment (`public/report.html`, `public/js/report.js`)
- **Theme support (R-21 / R-34)**: Add a compact 44x44px light/dark theme toggle button in `.rpt-top` (reading/writing the shared `theme` / light-dark class on `<html>` so both modes work with full WCAG AA contrast).
- **Freshness states**: Upgrade `#status-pill` and `report.js` to support `live`, `stale` (amber, keeps figures, shows data age), and `offline` (red + offline banner).
- **Wording & RMA clarity**:
  - Label `#st-profit` as `"Profit after returns"` (and show replacement cost in `#st-refunded` meta when `today_replacement_cost > 0`).
  - Actionable empty state on `#sales-list`: `"No sales recorded yet. Sales appear here automatically as the counter rings them up."`
- **Responsive reflow (R-03)**:
  - `< 360px`: fluid `clamp()` font sizing on `.rpt-hero .rpt-value` (`clamp(22px, 7vw, 30px)`) and `.rpt-value` (`clamp(17px, 5.2vw, 21px)`) so large peso amounts never clip.
  - `>= 760px`: `.rpt-wrap` expands to `max-width: 960px` with a 2-column layout (summary grid + collections on the left column, latest 20 sales feed on the right column).
  - Raise `.rpt-sale__method` from `10.5px` to `11.5px`.

### 5. Cloud Live Telemetry Alignment (`cloud/public/index.html`, `cloud/public/app.js`)
- **Remove AI-slop pulse (R-19)**: Remove `animation: pulse 2.5s infinite` from `.beacon`. Use a static status pill/beacon with explicit `live`, `stale`, and `offline` states.
- **Fix payment method badge & transfer display**: Add `.badge.transfer` styling so Bank Transfer sales render as `TRANSFER` with distinct info/cyan styling instead of `cash`.
- **Align profit card**: Show `Net Profit` (`c.net_profit`, after refunds & replacements) as the primary figure on `#card-profit` with `Gross ₱X · Y% margin` in `#card-margin`, matching the phone report and desk dashboard.
- **SSE + Fallback Polling & Visibility**: Add a 20s fallback poll when SSE is disconnected (`es.readyState !== 1`) and refresh on `visibilitychange` when returning to the tab.
- **Responsive reflow (R-03)**: Allow `.phone-frame` to expand to `max-width: 960px` at `>= 760px` with a two-column grid (metrics on left, live tabbed feed on right) and a responsive navigation bar that doesn't trap desktop/tablet views in a 480px column.

---

## Verification Plan
- Run `npm test` (including new unit/integration tests in `tests/analytics.test.js` and `tests/cloud-hardening.test.js`, plus existing `tests/report.test.js`, `tests/reports-behavior.test.js`, `tests/reports-http.test.js`, `tests/dash-scope.test.js`, `tests/dash-scope-ui.test.js`).
- Build CSS (`npm run build:css`) if any utility classes change.
- Verify all 3 surfaces across viewports (320px, 375px, 768px, 1280px) and both themes (light and dark), recording the R-35 click-through evidence and the antislop Delivery Gate table.
