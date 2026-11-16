# Performance & Low-End Compatibility Optimization Pass Prompt (v1)

[v1, 2026-11-16. Companion inside the seven-pass pipeline dispatched by
.agents/skills/techparts-pass/SKILL.md.
Boundary rule: pure bug fixes live in remediation (docs/remediation-prompt.md), pure structural
splits live in refactoring (docs/refactoring-prompt.md), pure deletions live in cleaning
(docs/code-cleaning-prompt.md), performance and low-end hardware / legacy-browser compatibility
improvements live HERE (this pass).]

MISSION
Keep TechParts POS fast, responsive, and visually intact on entry-level shop hardware and frozen
Windows Embedded / IoT builds without adding runtime dependencies or regressions in money, security,
or printing accuracy. Every change must be justified by a real bottleneck on the target profile,
verified by measurement or layout math, and guarded by a regression test where testable in node:test.

TARGET HARDWARE & BROWSER ENVELOPE
1. Field workstation PC: dual- or quad-core CPU (i5-3570T class or slower Celeron/Pentium counter
   boxes), 4 to 8 GB RAM, SATA/128 GB SSD, integrated or driverless basic GPU.
2. Small counter monitors: 1366x768, 1280x800, 1280x720, 1024x768, plus Windows Edge `--app`
   kiosk mode with taskbar leaving <= 700 px viewport height (`<= 860px` and `<= 700px` media bands).
3. Frozen legacy browser baseline: Windows 10 IoT Enterprise LTSC (2021) / Edge ~92:
   - No reliable CSS `@layer` cascade in Edge < 99.
   - No `oklch(...)` or `color-mix(...)` support in Edge < 111.
   - No `dvh` viewport units or native DOM `[inert]` attribute (pre-Edge 102).
   - No bare `rotate: 90deg` CSS property (pre-Edge 104).
   - No CSS `:has()` selector (pre-Edge 105).
   - No `crypto.randomUUID()` on plain HTTP or older Edge builds.
4. Shop scale: 1 to 3 seats, 20 to 100+ sales/day, 1,000 to 5,000+ inventory SKUs, multiple years
   of append-only `audit_log` and `sales` rows, optional Cloud Sync over slow/intermittent store Wi-Fi.
5. Non-negotiable invariant: zero runtime npm dependencies (Node 22+ stdlib only; `dependencies: {}`),
   vanilla JS + HTML5 + Tailwind v4 compiled via `npm run build:css`.

BASELINE RITUAL (first, no exceptions)
1. Read the TREE STATE block below. If it is stale (HEAD, gate counts, or working-tree state differ
   from observed), refresh it to today's observed state and say so in one line.
2. Run and record both gates BEFORE any change:
   - `npm run build:css` (`@tailwindcss/cli` + `scripts/compat-css.js`), exit 0.
   - `npm test` (`node --test tests/*.test.js`), all tests pass at or above recorded baseline (a single
     hang on parallel spawns is a rerun, not a regression).
3. Check `git status --short` as an interference detector and verify file contents before editing.

PRIORITY AUDIT & OPTIMIZATION SURFACE
1. **SQLite & Server Hot Paths (`src/db.js`, `src/analytics.js`, `src/audit.js`, `src/credits.js`, `src/server.js`, `src/sync.js`):**
   - Preserve tuned WAL pragmas (`journal_mode = WAL`, `synchronous = NORMAL`, `busy_timeout = 5000`,
     `temp_store = MEMORY`, `cache_size = -16000`).
   - Check slow routes (`Server-Timing` >= 100ms in `src/server.js`), N+1 SQL queries inside loops,
     unindexed `WHERE`/`ORDER BY`/`JOIN` predicates on growing tables (`sales`, `sale_items`,
     `audit_log`, `cash_adjustments`, `shifts`, `op_log`, `sync_outbox`), and SQLite 32,766 parameter
     limits (chunk large `IN (...)` clauses in batches <= 500).
   - Preserve incremental audit verification (`verifyChainIncremental` keyset paging + `PRAGMA data_version`
     anchor check), `getSyncStatus` unconfigured fast-path, `os.networkInterfaces()` 30s TTL cache,
     `/api/dashboard?lite=1` polling skips, and deferred initial boot backup (`2500ms` timeout).
   - Avoid unnecessary write transactions on clean boots (e.g., conditional SKU normalization).
2. **Counter POS & Backoffice DOM / JS (`public/js/`):**
   - Preserve 100-row pagination (`POS_PAGE_SIZE = 100`, `INV_PAGE_SIZE = 100`, `BACKOFFICE_PAGE_SIZE = 100`
     via `updateTablePager`), `O(1)` `lookupBarcode()` `Map` index, debounced search inputs (`150ms`),
     and `table-layout: fixed` column sizing so page switches and filter keystrokes never stall the UI thread.
   - Avoid redundant `window.fetch` wrappers, unbounded `PerformanceObserver` allocations, un-debounced
     filter listeners, or polling heavy endpoints when tabs are hidden or un-elevated.
3. **GPU, Compositor & Small-Screen Layout (`public/styles.css`, `public/index.html`):**
   - Zero `backdrop-filter: blur(...)` anywhere in CSS (`tests/old-browser-compat.test.js`).
   - Keep `.grain { display: none; }` (no full-viewport SVG `feTurbulence` + `mix-blend-mode`).
   - Keep `@media (max-width: 1366px)` 68px collapsed icon rail (`overflow-x: hidden`, 2-column footer grids)
     and `@media (max-height: 700px)` vertical space reclamation without shrinking money-path touch
     targets below 44px.
   - Keep zero em dashes inside the small-monitor media block and no `text-[10.5px]` in `public/index.html`
     (`tests/small-monitor-counter-typography.test.js`).
4. **Legacy Chromium / Win10 LTSC Compatibility (`scripts/compat-css.js`, `public/`):**
   - Every `color-mix(...)` in `public/styles.css` MUST carry a plain hex/rgba/`var(...)` fallback on
     the immediately preceding line.
   - Every `dvh` unit in `public/styles.css` MUST carry a `vh` fallback on the immediately preceding line.
   - `npm run build:css` MUST run `scripts/compat-css.js` so `public/tailwind.build.css` contains zero
     `@layer`, zero `oklch(...)`, and pairs every bare `rotate:<deg>` with `transform:rotate(<deg>)`.
   - Maintain `syncAppInert()` DOM `inert` attribute toggling (`public/js/ui.js`), `body[data-tab]` print
     hiding (alongside `:has()`), `.check--pill input:checked + span`, and `crypto.randomUUID()` polyfill
     (`public/js/api.js`) + `execCommand('copy')` clipboard fallbacks.
5. **Cloud Mirror & Mobile Payload Hygiene (`cloud/`, `cloud-deploy/`):**
   - Keep `cloud/` and `cloud-deploy/` byte-identical, avoid unbounded SSE fan-out or redundant full-table
     reads when a compact query or cap holds.

PROTECTED PERF & COMPAT CONTRACTS (do NOT strip or weaken)
- `tests/perf-optimizations.test.js`: SQLite pragmas/indexes, keyset `verifyChain` + `verifyChainIncremental`,
  `getCustomerDetails` chunking, `getSyncStatus` short-circuit, `Server-Timing` header + `/api/dashboard?lite=1`,
  `.grain` compositor removal, `updateTablePager`, `POS_PAGE_SIZE = 100` + `O(1)` `lookupBarcode` `Map`.
- `tests/old-browser-compat.test.js`: zero `backdrop-filter`, `vh` before `dvh`, plain fallback before
  `color-mix()`, `scripts/compat-css.js` transform invariants, `[inert]` + focus blur, `crypto.randomUUID()`
  polyfill, `TEMPLATE_BRANDS?.phone` fallback, `describeLoadFailure`.
- `tests/small-monitor-counter-typography.test.js`: `@media (max-width: 1366px), (max-height: 860px)`
  ergonomics, 68px icon rail at `<= 1366px`, 640px setup grid, zero em dashes in small-monitor block.
- `tests/printer.test.js` & `tests/ui-fixes.test.js`: VM slice boundaries and exact `printMoney(` count
  synced with `docs/OPERATIONS_AND_DEPLOYMENT.md` must stay green.

PROCESS & OUTPUT PROTOCOL
1. **PHASE 1 (Measure & Propose: wait for approval unless user asked for immediate fix-and-finalize):**
   List each confirmed bottleneck or compatibility gap with: `[IMPACT: HIGH|MED|LOW]`, `File:line`,
   exact hardware/browser cost, and minimal fix sketch. Reject speculative micro-optimizations that add
   complexity without measurable benefit (Ponytail ladder).
2. **PHASE 2 (One optimization at a time):**
   Apply the smallest working diff, rebuild CSS if `public/index.html` / `public/styles.css` changed
   (`npm run build:css`), add or update tests in `tests/perf-optimizations.test.js`,
   `tests/old-browser-compat.test.js`, or `tests/small-monitor-counter-typography.test.js`, and run
   `npm test` after each cohesive step.
3. **FINAL REPORT:**
   List measured optimizations applied, files changed, before/after test and build gate numbers, any
   residual hardware/manual counter checks needed, and zero em dashes anywhere in the report.

STOP CONDITIONS
A test gate turns red and stays red on rerun; an optimization alters financial/money rounding,
security checks, or sync durability; or a fix requires an external runtime dependency. Report and stop.

TREE STATE (measured 2026-11-16; refresh to observed state on every run)
- HEAD: `81a31fe` (1 commit past tag `v1.4` at `f8bd979`; version `1.4` across `package.json`,
  `CURRENT_VERSION` in `src/updater.js`, and `MyAppVersion` in `installer/TechPartsPOS.iss`).
- Gates: `npm run build:css` exits `0` (tailwindcss v4.3.3 + `scripts/compat-css.js`); `npm test`
  (`node --test tests/*.test.js`) reports `772` tests across `59` test files (`771` pass, `0` fail,
  `1` skipped env-gated `tests/sync-soak.test.js` without `SYNC_SOAK=1`, about `22 s`).
- Scope state: includes uncommitted Low-End Optimization, Edge 92 Compatibility (`compat-css.js`),
  Table Density/Chart/Ergonomics, and Must-Have Bundle (#1-#5 with `#tab-btn-repairs` kept `hidden`
  and technician commissions excluded). Verify with `git status --short` before starting.
