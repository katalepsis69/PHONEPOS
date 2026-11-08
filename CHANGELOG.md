# Changelog

All notable changes to TechParts POS and Phone Repair Management System are documented in this file.

The format is based on Keep a Changelog, and this project adheres to Semantic Versioning.

## [v2.7] - 2026-11-08

### Highlights & Changes
- Verified: Reorder UI: single copy button, editable quantities, i18n keys consistent
- Verified: Reorder footer: subtotal cells align with the column edges above
- Verified: sale retries retain one operation id and validate credit downpayments

## [v2.6] - 2026-11-08

### Highlights & Changes
- Verified: Reorder UI: single copy button, editable quantities, i18n keys consistent
- Verified: Reorder footer: subtotal cells align with the column edges above
- Verified: sale retries retain one operation id and validate credit downpayments


## [v2.5] - 2026-11-08

### Highlights & Changes
- LicenseGenerator builds again: no db import inside the SEA bundle
- Cloud test harness proves readiness before the first request
- Bring the source tree under version control; audit v7 fix batch
- Thermal Receipt Printing: Reliable 58mm and 80mm ESC/POS receipt generation, claim stubs, and automated cash drawer kick.


## [v2.4] - 2026-11-05

### Highlights & Changes
- Update v2.4 release notes with inventory capital and empty template highlights
- Inventory Capital & Blank Template: Standardized cost price to Capital across all screens and exports; download template is now completely empty with zero dummy rows.
- Wholesale Pricing & Catalog Transfer: Fixed CSV exports to use friendly Capital and Wholesale Price headers for clean multi-PC catalog updates.


## [v2.3] - 2026-11-05

### Highlights & Changes
- Workstation Typography & Themes: 5 shop color accents, 4 readable text scale presets (90% to 125%), locked clean sans display, and monospace tabular digits.
- Settings Navigation Revamp: 6 organized settings tabs (Store, Staff & Security, Printing, Appearance, Cloud Sync, Data) with threshold controls and unified cashier accounts.
- Manager Phone Reports: Secure token-authenticated mobile report endpoint (/api/report/*) for off-site till and revenue monitoring.
- Cloud Sync Hardening: Hardened multi-shop synchronization service with scoped bearer tokens and automated cloud deployment.
- Repair Counter: Fast job intake, checkout shortcuts, and payment handling improvements.


## [v2.2] - 2026-11-05

### Highlights & Changes
- Counter Ergonomics: Compact workstation spacing and enlarged typography (cells 14px, part names 14.5px bold, prices 15px tabular numbers, grand total 25px bold green) for 1366x768 and 1280x800 counter monitors.
- Automatic Rail Collapse: Navigation rail automatically collapses from 250px to 68px icon mode on screens 1366px wide or smaller, reclaiming 182px of horizontal table space.
- Responsive Font Scaling: Standardized badges, wholesale tags, customer status pills, and utang payment references to responsive scale-aware sizes.
- Software Updates: Safe offline update staging with strict SHA-256 verification and atomic binary installation.
- Security & Licensing: Cryptographic offline RSA license validation and salted PBKDF2 manager PIN protection.
- Automated Test Suite: Comprehensive test suite verification ensuring zero floating-point drift, database safety, and UI resilience.


## [v2.1] - 2026-11-02

### Added & Improved
- Cryptographic offline license verification (RSA machine-ID binding and LicenseGenerator.exe).
- End-of-day cash drawer reconciliation and drawer count verification.
- In-app updater checksum validation and staging resilience.

## [v2.0] - 2026-10-15

### Added & Improved
- Salted PBKDF2 manager PIN security with persistent lockout protection.
- Customer credit ("Utang") FIFO allocation and ledger settlement.
- Dual-tier pricing with walk-in retail and technician wholesale prices.

## [v1.2] - 2026-10-15

### Added & Improved
- Offline in-app software updater with automated SHA-256 verification.
- Automated daily SQLite database backups with integrity checks.

## [v1.1] - 2026-09-17

### Added & Improved
- Raw ESC/POS thermal printing for 58mm and 80mm printers with cash drawer kick pulse.
- Excel (.xlsx) and CSV inventory spreadsheet import with automated price markup calculation.
- Bilingual English and Tagalog counter guidance.

## [v1.0.0] - 2026-09-12

### Initial Release
- Standalone Single Executable Application (SEA) for offline phone repair counters.
- Zero runtime dependencies with local SQLite storage.
