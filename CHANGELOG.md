# Changelog

All notable changes to TechParts POS and Phone Repair Management System are documented in this file.

The format is based on Keep a Changelog, and this project adheres to Semantic Versioning.

## [v1.5] - 2026-11-18

### Highlights & Changes
<!-- AUTO-GENERATED:START -->
- Documentation: Updated (README.md)
- Cloud Sync: Updated interface text for "Export reorder sheet as CSV with blank Stock Count", "Export CSV" (cloud-deploy/public/app.js, cloud-deploy/public/index.html, cloud-deploy/server.js, cloud/public/app.js and 3 more)
- Counter UI: Updated interface text for "Switch active shop profile", "Set order quantities to replace all units sold in this window", "Receive the ordered quantities above into inventory stock" (public/index.html, public/js/i18n.js, public/js/main.js, public/js/search.js and 2 more)
- Security & Licensing: Updated interface text for "application/json" (public/js/auth.js)
- Inventory & Import: Updated interface text for "items", "application/json", "Low-stock alert threshold" (public/js/importer.js, public/js/views/inventory.js, src/inventory.js)
- Thermal Printing: Updated defaultShopSubtitle (public/js/receipts.js, src/printer.js)
- Repair Counter (POS): Updated lookupBarcode, renderBrandChips, renderCategoryOptions (public/js/views/pos.js)
- Reports & Analytics: Updated getStandingStats, getProductPerformance, getDeadStock (src/analytics.js)
- Server & Database: Updated initDb, seedInitialParts, createServer (src/db.js, src/seed.js, src/server.js)
- Quality & Tests: Updated test coverage for openImportPreview displays Low Stock Alert and swaps Brand/Model when clicked; inventory table renders an explicit Low Stock Alert column (tests/analytics-parity.test.js, tests/audit-regressions.test.js, tests/frontend-regressions.test.js, tests/perf-optimizations.test.js and 7 more)
<!-- AUTO-GENERATED:END -->

## [v1.4] - 2026-11-18

### Highlights & Changes
<!-- AUTO-GENERATED:START -->
- Updated documentation for expand README for open-source contributors and add MIT license
- Fixed inventory import applies good rows and states every refused row
- Expanded tests for soak spawns must never open a browser window
- Fixed quarantine unreadable outbox rows on first sync window
- Expanded tests for sync soak harness (env-gated)
- Documentation: Updated .grain (.agents/skills/techparts-pass/SKILL.md, AGENTS.md, GEMINI.md, README.md and 15 more)
- Security & Licensing: Updated interface text for "application/json" (LICENSE, public/js/auth.js, src/license.js)
- Cloud Sync: Updated interface text for "Over", "warn", "Copy" (cloud-deploy/public/app.js, cloud-deploy/public/index.html, cloud-deploy/server.js, cloud/public/app.js and 6 more)
- Build & Release: Updated interface text for "1.4" (package.json, publish-release.bat, publish.bat, scripts/compat-css.js and 3 more)
- Counter UI: Updated interface text for "Log out or switch user", "Switch active shop profile", "Previous page" (public/index.html, public/js/api.js, public/js/chart.js, public/js/i18n.js and 8 more)
- Repair Counter (POS): Updated interface text for "application/json" (public/js/cart-recovery.js, public/js/views/pos.js)
- Inventory & Import: Updated interface text for "items", "application/json", "Low-stock alert threshold" (public/js/importer.js, public/js/views/inventory.js, src/inventory.js)
- Thermal Printing: Updated interface text for "application/json", "thermal-80mm", "Customer:" (public/js/receipts.js, src/printer.js)
- Reports & Analytics: Updated interface text for "day" (public/js/report.js, src/analytics.js)
- Server & Database: Updated interface text for "application/json" (src/audit.js, src/db.js, src/reconcile.js, src/returns.js and 5 more)
<!-- AUTO-GENERATED:END -->

## [v1.3] - 2026-11-14

### Highlights & Changes
- Counter UI: Applying Update…, The register has not come back (index.html, main.js, backoffice.js)
- Repair Counter (POS): Updated styles.css


## [v1.2] - 2026-11-14

### Highlights & Changes
- Maintenance and stability improvements across POS counter, inventory, and backups.


## [v1.1] - 2026-11-14

### Highlights & Changes
- README feature list catches up to the shipped product
- Final night verification, prompts re-anchored to c91f354
- Receiving flow and P&L one-number claim verified, no findings
- Document the pickup slip in the repair ticket lifecycle
- Independent audit of the feature window (clean) and flake runs recorded
- Close the old-tag sha256 question, add section 6.5 for 2.x-numbered seats
- Refresh the six pass prompts to the night end state (661/661 across 55 files, HEAD e86e347, landing log entry)
- Pickup-ready slip, the no-SMS notification the ticket queue was missing
- Self-audit of the night window (b55f517..079c157), 4 findings fixed
- Repair ticket lifecycle, the server side the intake flow never had
- Low-stock rail badge mirrors the standing KPI count
- Reorder-to-receiving, the smallest honest version of a PO flow
- Market analysis 2026-11-13, competitor pricing and gap map (desk research, sources linked)
- Operating expenses, the P&L leg the sales ledger cannot see
- Clean: delete 12 provably dead i18n keys (40 lines)
- Refactor pass 2026-11-13: CLEAN, evidence recorded, no code touched
- Audit-2026-11-13: report, poison-loop constraint acks, lock-staleness ceiling note, prompt tree-state refresh
- General: Updated AGENTS.md, GEMINI.md, README.md
- Updater & Packaging: publish.bat closes running executables instead of refusing (TechPartsPOS.iss, wizard-small.bmp, publish.bat)
- Counter UI: Customer name (Alt+C), Customer Profile, Orders / Spent (index.html, chart.js, i18n.js)
- Inventory & Import: Edit part / set stock, Adjust / receive with reason, Stock movement history (inventory.js)
- Repair Counter (POS): customers & utang view: 5-column industrial layout, dynamic card state, and ledger triggers; inventory view: honest metric copy, screen tech badges, and action hit areas (pos.js, styles.css)
- Server & Database: Updated getPeriodStats (analytics.js)


## [v1.0] - 2026-11-12

### Official Release
- Windows background service installer (`TechPartsPOS-Setup-1.0.exe`) storing protected shop data in `C:\ProgramData\TechPartsPOS` with isolated counter browser launcher.
- Offline Manager PIN setup and Recovery Password ("Forgot PIN?") reset flow, plus USB flash drive backup exports in Settings > Data.
- Appearance choices in Settings > Appearance: Dark, Dim, Light, Paper, and Auto themes, plus accent colors, table density, and workstation text sizing.
- Store-profile inventory forms (Phone Repair, PC Components, General Retail, Services, Grocery, and Hybrid) with aligned Unit of Measure controls and Excel/CSV bulk import.
- Dual-tier Retail and Wholesale pricing, FIFO Customer Credit ("Utang") ledger, Warranty & RMA tracking, 58mm/80mm ESC/POS thermal receipt printing, and SHA-256 verified in-app updates.
