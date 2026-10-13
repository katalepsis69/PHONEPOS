# TechParts POS & Phone Repair Management System

A commercial-grade, 100% offline Point of Sale and inventory management workstation built for phone repair shops, parts wholesalers, and technician counters.

## Features

- **0 Runtime Dependencies:** Runs natively on Windows as a standalone single executable (`TechPartsPOS.exe`).
- **Dual-Tier Pricing:** Instant toggle between Walk-in Retail and Technician/Wholesale pricing.
- **Parts & Repair Labor Checkout:** Unified cart supporting physical phone parts and repair labor service charges.
- **Customer Credit & "Utang" Ledger:** Complete customer credit management with FIFO partial and full settlement tracking.
- **Warranty & RMA Management:** Shop warranty tracking, parts replacements, and audit-logged RMA adjustments.
- **Thermal Receipt Printing:** ESC/POS direct counter printing to standard 58mm and 80mm thermal receipt printers, with automatic browser print fallback for slips and reports.
- **GCash & Digital Payments:** GCash reference logging, on-screen shop QR code presentation, and daily cash drawer reconciliation.
- **Automated Backups & Day Close:** Hourly local SQLite database snapshots with automatic retention pruning.
- **Automatic In-App Updates:** One-click checks and seamless updates via GitHub Releases.

## Download & Installation

Download the latest pre-built Windows release from the [Releases](https://github.com/katalepsis69/PHONEPOS/releases) page.

1. Download `TechPartsPOS-vX.X.X.zip` (or `TechPartsPOS.exe`).
2. Extract the folder anywhere on your Windows PC.
3. Run `TechPartsPOS.exe` to launch the POS workstation (automatically opens your default browser to `http://localhost:3000`).
