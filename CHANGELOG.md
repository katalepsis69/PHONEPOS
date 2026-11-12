# Changelog

All notable changes to TechParts POS and Phone Repair Management System are documented in this file.

The format is based on Keep a Changelog, and this project adheres to Semantic Versioning.

## [v1.1] - 2026-11-12

### Highlights & Changes
- General: Updated README.md
- Updater & Packaging: generateReleaseHighlights summarizes real git diff and ignores untouched features; generate-changelog CLI --stdout outputs notes without writing CHANGELOG.md or RELEASE_NOTES.md (TechPartsPOS.iss, publish.bat, generate-changelog.js)
- Counter UI: Low-stock alert threshold, Min Stock Alert, Min. Stock Alert (index.html, i18n.js)
- Inventory & Import: openImportPreview displays Min Stock Alert and swaps Brand/Model when clicked; inventory table renders an explicit Min Stock Alert column; Brand and Model look swapped, Swap Brand & Model, Download template (importer.js, inventory.js)
- Repair Counter (POS): renderBrandChips skips out-of-stock brands when posInStockOnly is on and CSS bounds chip height; isInstanceLockLive rejects prior-boot locks and recycled non-POS Windows PIDs (pos.js, styles.css)
- Server & Database: Updated currentBootEpochMs, isPosProcessPidAlive, isInstanceLockLive (server.js)


## [v1.0] - 2026-11-12

### Official Release
- Windows background service installer (`TechPartsPOS-Setup-1.0.exe`) storing protected shop data in `C:\ProgramData\TechPartsPOS` with isolated counter browser launcher.
- Offline Manager PIN setup and Recovery Password ("Forgot PIN?") reset flow, plus USB flash drive backup exports in Settings > Data.
- Appearance choices in Settings > Appearance: Dark, Dim, Light, Paper, and Auto themes, plus accent colors, table density, and workstation text sizing.
- Store-profile inventory forms (Phone Repair, PC Components, General Retail, Services, Grocery, and Hybrid) with aligned Unit of Measure controls and Excel/CSV bulk import.
- Dual-tier Retail and Wholesale pricing, FIFO Customer Credit ("Utang") ledger, Warranty & RMA tracking, 58mm/80mm ESC/POS thermal receipt printing, and SHA-256 verified in-app updates.
