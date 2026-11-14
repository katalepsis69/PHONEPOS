# Changelog

All notable changes to TechParts POS and Phone Repair Management System are documented in this file.

The format is based on Keep a Changelog, and this project adheres to Semantic Versioning.

## [v1.3] - 2026-11-14

### Highlights & Changes
- Counter UI: Applying UpdateΓÇª, The register has not come back (index.html, main.js, backoffice.js)
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
