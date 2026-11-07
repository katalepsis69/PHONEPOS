# TechParts Live: Swiss Editorial Ledger & Owner Audit Cockpit Design Spec

**Date:** 2026-11-05  
**Target Surfaces:**
- **Flagship Paid Subscription:** `cloud/public/index.html` + `cloud/public/app.js` (backed by existing routes in `cloud/server.js`)
- **In-Shop Local Wi-Fi Teaser:** `public/report.html` + `public/js/report.js`

---

## 1. Executive Summary & Business Packaging Comparison (For Decision Makers)

To help management decide how to package remote monitoring, here are the three commercial models with their pros, cons, and recommended path:

| Packaging Model | How It Works | Pros | Cons | Verdict |
|---|---|---|---|---|
| **Model A: Tiered "Local Teaser + Cloud Executive Suite" (Recommended)** | Built-in `/report` works on local shop Wi-Fi as a **Today-Only Snapshot** (today's cash/GCash, open utang, last 25 tickets). Paid **TechParts Live Cloud** unlocks 24/7 off-site access, 7d/30d trend charts, Parts vs. Labor margin split, Anti-Theft Cashier Audit tab, Supplier Restock Budget planner, and off-site backups. | 1. Owners get an instant taste of phone monitoring inside the shop via QR code.<br>2. Clear, undeniable reason to pay for Cloud (checking the shop from home, catching drawer shortages/voids, checking restock lists while at the supplier, and protecting data off-site).<br>3. Zero wasted engineering: local `/report` acts as the built-in upsell funnel. | Local-only users do not get 7d/30d mobile charts or mobile restock lists unless they use the desktop register PC or subscribe to Cloud. | **Best for recurring subscription revenue.** Gives a great free taste while keeping high-leverage owner tools exclusive to subscribers. |
| **Model B: Full Parity on Both Local & Cloud** | Both local `/report` and Cloud Live get the exact same 5-tab cockpit. The only difference is local works on shop Wi-Fi while Cloud works from anywhere. | 1. Easy to demo every feature locally on a laptop without internet.<br>2. Maximum goodwill for offline-only buyers. | Weakens subscription conversion for single-shop owners who stay inside their store all day and feel local Wi-Fi is "good enough." | Good only if sold as a high-ticket one-time license where Cloud is purely for multi-branch owners. |
| **Model C: Cloud-Only (Remove Local `/report`)** | Disable local `/report` completely; require a Cloud subscription for any phone view. | Forces 100% of phone monitoring onto the subscription plan. | Removes the "aha moment" inside the shop where an owner scans the counter QR code and sees live numbers on their phone for the first time. | Too aggressive; loses the built-in trial funnel. |

---

## 2. `/ui-design-spec` Checkpoint & Craft Rules Applied

Every visual and structural decision is derived from the `/ui-design-spec` library (`02-layout-and-containers.md`, `03-surfaces-and-elevation.md`, `04-typography-color-and-copy.md`, `06-interface-and-dashboard-craft.md`) and `/antislop`:

### 2.1 Intent & Product Domain (`interface-design`)
- **Human:** Repair shop owner away from the counter (at home at 9 PM verifying shift close, or at a wholesale parts supplier buying replacement LCDs).
- **Task:** Verify cash/GCash collections, spot cashier voids or drawer shortages, check parts vs. repair labor margins, and see which parts are out of stock with an exact restock budget.
- **Feel:** **Swiss Editorial Ledger** (`ENERGY 1 / RHYTHM 2 / MOTION 1`). Warm archival bone paper in daylight, carbon workbench obsidian at night, serif editorial display titles paired with tabular monospace accounting figures.
- **Signature Element:** **The Closing Drawer & Margin Anatomy Ledger** paired with the **Cashier Watch Strip** (surfacing drawer reconciliation variance, voided sales, petty cash adjustments, and RMA returns in one glance).

### 2.2 Surface Elevation & Color Tokens (`smooth-shadow-ring` + `beautiful-shadows` + `R-20`)
- **Daylight Ledger (`.light`):**
  - `--bg`: `#F0EFEA` (Archival Bone Canvas, matching `public/styles.css`)
  - `--surface`: `#FAF9F5` (Warm Card Sheet)
  - `--surface-elevated`: `#E8E6DF` (Inset / Secondary Well)
  - `--surface-interactive`: `#DDDAD0` (Hover / Active Well)
  - `--text`: `#14171A` (Deep Charcoal Ink, contrast 15.6:1 on `#FAF9F5`)
  - `--text-muted`: `#4A5056` (Secondary Label Ink, contrast 7.4:1 on `#FAF9F5`)
  - `--text-dim`: `#5C636A` (Metadata Ink, contrast 5.5:1 on `#FAF9F5`)
  - `--accent`: `#0369A1` (Ledger Cobalt)
  - `--cash`: `#047857` (Banknote Emerald, contrast 5.2:1 on `#FAF9F5`)
  - `--gcash`: `#0369A1` (Digital Settlement Blue, contrast 5.8:1 on `#FAF9F5`)
  - `--alert`: `#B91C1C` (Ledger Deficit / Stockout Crimson, contrast 6.1:1 on `#FAF9F5`)
  - `--warn`: `#92400E` (Reorder Amber, contrast 6.4:1 on `#FAF9F5`)
  - `--card-shadow`: `0 0 0 1px rgba(20, 23, 26, 0.08), 0 1px 2px -1px rgba(20, 23, 26, 0.06), 0 4px 10px -2px rgba(20, 23, 26, 0.04)` (from `smooth-shadow-ring`)
- **Workbench Dark (`:root` default):**
  - `--bg`: `#0D0F12` (Carbon Obsidian Canvas)
  - `--surface`: `#14181F` (Elevated Slate-Carbon Card)
  - `--surface-elevated`: `#1C222B` (Secondary Well)
  - `--surface-interactive`: `#252D3A` (Interactive Control Surface)
  - `--text`: `#F2F0EA` (Warm Alabaster Ink, contrast 15.4:1 on `#14181F`)
  - `--text-muted`: `#A0AAB8` (Secondary Ink, contrast 7.1:1 on `#14181F`)
  - `--text-dim`: `#8C98A8` (Metadata Ink, contrast 5.4:1 on `#14181F`)
  - `--accent`: `#38BDF8` (Signal Cyan)
  - `--cash`: `#34D399` (Emerald Signal)
  - `--gcash`: `#38BDF8` (Digital Cyan)
  - `--alert`: `#FB7185` (Rose Alert)
  - `--warn`: `#FBBF24` (Amber Warning)
  - `--card-shadow`: `0 0 0 1px rgba(255, 255, 255, 0.08)`

### 2.3 Optical Geometry, Typography & Motion (`better-ui` + `rad-spacing`)
- **Typography:**
  - `--display`: `'Newsreader', Georgia, 'Times New Roman', serif` for editorial section headers and modal titles (`letter-spacing: -0.02em`).
  - `--sans`: `'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif` for dense UI labels and controls.
  - `--mono`: `'JetBrains Mono', 'Cascadia Code', Consolas, monospace` with `font-variant-numeric: tabular-nums` on every monetary figure, counter, percentage, and timestamp.
- **Concentric Border Radii ($R_{\text{outer}} = R_{\text{inner}} + \text{padding}$):**
  - Outer cards: `16px` radius with `16px` padding; nested split boxes / wells: `10px` radius (`16px - 6px` visual inset).
  - Period & desktop tab switcher bar: `12px` outer radius, `3px` padding, `9px` inner button radius (`9 + 3 = 12`).
- **Gestalt Spacing Scale (`rad-spacing`):**
  - `4px` micro gap -> `8px` intra-card gap -> `12px` metric grid gap -> `16px` section gap -> `20px` desktop two-column gap.
- **Motion Restraint & Theme Snap (`better-ui`):**
  - Zero infinite animations (`R-19`).
  - Tactile button feedback: `transform: scale(0.96)` on `:active` with explicit `transition-property: transform, background-color, border-color, color` (`120ms ease-out`).
  - Theme toggle injects a 1-frame `transition: none !important` style rule before flipping `.light` so colors snap cleanly without smearing.

---

## 3. Ponytail Architecture Check (Rung 1 to Rung 6)

Every subscription feature in this spec is powered **100% by data already returned by `cloud/server.js`** (`GET /api/overview`, `GET /api/standing`, `GET /api/analytics`, and `GET /api/rows`):

1. **Zero New Backend Endpoints or Dependencies:**
   - `MANAGER_ROW_TABLES` in `cloud/server.js` (line 303) already exposes `inventory`, `sales`, `credit_payments`, `warranty_returns`, `day_reconciliations`, `cash_adjustments`, and `customer_profiles`.
   - `GET /api/analytics`, `GET /api/standing`, and `GET /api/rows` in `cloud/server.js` already accept `?shop=<shop_id>` for multi-register filtering.
   - `GET /api/standing` already returns both `inventory_retail_value` and `inventory_cost_value`.
   - `GET /api/analytics` already returns `trend`, `avg_ticket`, `parts_revenue`, `labor_revenue`, `collected_total`, `credit_downpayments`, `credit_settled`, `warranty_returns`, `return_replacements`, `refunded_total`, and `replacement_cost`.
2. **Coalesced Network Fetching:**
   - `refresh()` in `cloud/public/app.js` fetches `day_reconciliations` and `cash_adjustments` alongside the existing parallel `Promise.all` batch (all scoped to the selected `shopFilter` when a specific register is chosen).

---

## 4. Detailed Feature & Layout Specification

### 4.1 Responsive Desktop & Tablet Reflow (`>= 760px`)
- **Sticky Left Executive Column:**
  - `.cloud-col-left` uses `position: sticky; top: 84px` on viewports `>= 760px` so the owner's financial summary stays anchored while scrolling through long feeds on the right.
- **Docked Desktop Workspace Tabs:**
  - On `< 760px`, the 5 workspace tabs (`Sales`, `Utang`, `Stock`, `Top Parts`, `Audit`) live in the thumb-friendly fixed `nav.bottom-nav` (`min-height: 48px` per button).
  - On `>= 760px`, `nav.bottom-nav` hides (`display: none`) and a docked segmented tab bar (`.desktop-tabs`) appears at the top of the right-hand feed card.

### 4.2 Multi-Register Switcher & Heartbeat Bar
- In `<header>`, alongside the live connection beacon and `#shops-badge`, a `<select id="shop-filter">` (`min-height: 44px`) appears whenever 1 or more registers are paired (`All Registers (N)` + each `shop_id` with its `last_seen` age).
- Selecting a register scopes `/api/analytics`, `/api/standing`, and `/api/rows` to `?shop=<shop_id>`.

### 4.3 Left Column: Executive Financial Telemetry
1. **Hero Card: Takings & Drawer Split:**
   - Editorial `Newsreader` title (`Takings · Today / 7 Days / 30 Days`) + off-site backup freshness badge (`Backup: Xh ago`).
   - Hero figure (`c.net_revenue ?? c.revenue`) + inline summary pill showing `Avg Ticket ₱X` and `Total Collected ₱Y` (including Utang settlements).
   - 2-column split: **Cash in Drawer** (`c.cash_collected`, sale count) and **GCash & Transfers** (`c.gcash_collected + c.transfer_collected`, breakdown of GCash vs. Bank Transfer).
2. **Revenue Mix & Period Trend Card (`#trend-card`):**
   - **Parts vs. Repair Labor Bar:** Visual proportional bar + peso figures for `parts_revenue` vs. `labor_revenue` (highlighting 100%-margin repair labor share).
   - **Daily Revenue Trend Chart (`analytics.trend`):** Clean SVG/CSS bar strip showing daily buckets across the selected window (`Today`, `7 Days`, `30 Days`) with peak day callout and tabular values on hover/focus.
3. **2x2 Standing & Margin Matrix:**
   - **Utang Uncollected:** `standing.outstanding_credit`, open debtor count, plus `₱X collected in period` (`c.credit_settled`).
   - **Critical Stock Radar:** Low/out-of-stock count, broken down into `X stockout · Y low` + **Estimated Restock Cost** (`₱Z to restock`).
   - **Profit After Returns:** `c.net_profit`, `Gross ₱X · Y% margin`, and RMA deduction note when returns/swaps exist.
   - **Shelf Capital & Markup:** `standing.inventory_retail_value` with subtitle `Cost ₱X · Markup +₱Y` (`retail - cost`).
4. **Cashier Watch Banner (`#audit-banner`):**
   - Compact high-signal strip that surfaces any active exceptions in the period:
     - Latest shift drawer reconciliation status (`Balanced` vs. `Short -₱X` / `Over +₱X` from `day_reconciliations`).
     - Count of **Voided Tickets**, **Petty Cash Payouts/Drops** (`cash_adjustments`), and **RMA Returns/Swaps** (`warranty_returns`).
   - Clicking the banner jumps directly to the **Audit** tab.

### 4.4 Right Column: Actionable Feed with Search, Filter Chips & 5th `Audit` Tab
- **Feed Toolbar:**
  - Instant client-side search input (`#feed-search`, `min-height: 44px`, clears on Escape) to filter by customer name, ticket code, brand/model, or reason.
  - Context-sensitive filter chips (`#feed-filters`, `min-height: 36px` visual with `>= 44px` hit target):
    - **Sales:** `All`, `Cash`, `GCash/Transfer`, `Utang`, `Voided`
    - **Utang:** `All Debtors`, `Largest (>= ₱1,000)`, `Recent Payments` (shows synced `credit_payments` rows!)
    - **Stock:** `All Alerts`, `Stockout (0 left)`, `Low Stock (1+)` + displays per-item restock deficit and unit cost
    - **Top Parts:** `By Revenue`, `By Net Profit` + displays unit count and margin %
    - **Audit (New 5th Tab):** `All Events`, `Drawer Counts` (`day_reconciliations`), `Voids`, `Cash In/Out` (`cash_adjustments`), `RMA Returns` (`warranty_returns`)

### 4.5 Local In-Shop Teaser Alignment (`public/report.html`)
- Make the left column sticky on desktop/tablet (`@media (min-width: 760px)`) so `/report` also eliminates any scroll void.
- Add a quiet, informative footer banner on `/report` (`Local Wi-Fi View · Today Snapshot`) that notes off-site backup, 7d/30d trends, supplier restock planner, and full audit history are available in **TechParts Live Cloud**.
