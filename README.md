# TechParts POS & Phone Repair Management System

A commercial-grade Point of Sale and inventory management workstation built for phone repair shops, parts wholesalers, and technician counters. Every sale, print and report path runs on the local machine with no cloud account required; the two things that do reach out are optional and off until configured: the update check against GitHub at boot (silent when there is no route, amber text in Settings only) and the optional cloud sync plus manager app.

## Features

- **0 Runtime Dependencies:** Runs natively on Windows as a standalone single executable (`TechPartsPOS.exe`).
- **Dual-Tier Pricing:** Instant toggle between Walk-in Retail and Technician/Wholesale pricing.
- **Parts & Repair Labor Checkout:** Unified cart supporting physical phone parts and repair labor service charges.
- **Customer Credit & "Utang" Ledger:** Complete customer credit management with FIFO partial and full settlement tracking.
- **Warranty & RMA Management:** Shop warranty tracking, parts replacements, and audit-logged RMA adjustments.
- **Thermal Receipt Printing:** ESC/POS direct counter printing to standard 58mm and 80mm thermal receipt printers, with automatic browser print fallback for slips and reports.
- **GCash & Digital Payments:** GCash reference logging, on-screen shop QR code presentation, and daily cash drawer reconciliation.
- **Automated Backups & Day Close:** Hourly local SQLite database snapshots with automatic retention pruning.
- **Automatic In-App Updates:** In-app update checks against GitHub Releases; an update installs only after its published SHA-256 matches, is refused while the factory PIN is live, and restarts the app to finish the swap.

## Download & Installation

Download the latest pre-built Windows release from the [Releases](https://github.com/katalepsis69/PHONEPOS/releases) page.

1. Download `TechPartsPOS-v1.2.zip` (or `TechPartsPOS.exe`).
2. Extract the folder anywhere on your Windows PC.
3. Run `TechPartsPOS.exe` to launch the POS workstation (automatically opens your default browser to `http://localhost:3000`).
