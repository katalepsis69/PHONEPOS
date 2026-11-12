# TechParts POS & Phone Repair Management System

A commercial-grade Point of Sale and inventory management workstation built for phone repair shops, parts wholesalers, and technician counters. Every sale, print and report path runs on the local machine with no cloud account required. Two things reach out to the internet: the boot-time update check against GitHub, which is always on but silent when there is no route and visible as amber text in Settings only, and the optional cloud sync plus manager app, which stay off until an operator configures them.

## Features

- **0 Runtime Dependencies:** Runs natively on Windows as a standalone single executable (`TechPartsPOS.exe`).
- **Protected Windows Background Service:** Runs reliably in the background under `NT AUTHORITY\SYSTEM` with automatic startup and recovery.
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

1. Download `TechPartsPOS-Setup-1.1.exe`.
2. Run the installer (Administrator permissions required). TechParts POS installs to `C:\Program Files\TechPartsPOS` and automatically registers and starts `TechPartsPOS-Server` as a protected Windows background service.
3. Open the desktop shortcut or Start Menu entry to launch the POS workstation interface (automatically connects to the local service and opens your browser).

## Shop PC Security Setup (Owner Admin + Cashier Standard Account)

For maximum store security and tamper prevention on counter computers:

1. **Windows Accounts:**
   - **Store Owner (Administrator):** Keep one Windows Administrator account for shop management, system updates, and installer runs. Protect this account with a strong password.
   - **Counter Staff (Standard User):** Create a standard, non-administrator Windows account for cashiers and counter staff.
2. **Locked Database Protection:**
   - The installer stores the live shop database in `C:\ProgramData\TechPartsPOS\data\shop.db` and configures strict NTFS permissions giving Full Control exclusively to `NT AUTHORITY\SYSTEM`.
   - Cashiers logging in with a standard Windows account cannot view, copy, modify, or delete `shop.db` in File Explorer or PowerShell, preventing tampering or unauthorized data extraction.
3. **Receipt & Label Printers (`SYSTEM` Background Service):**
   - The `TechPartsPOS-Server` background service runs as `SYSTEM`, ensuring all counter printing (USB, Bluetooth, and Wi-Fi thermal receipt printers via Windows Spooler) continues seamlessly regardless of which Windows user signs in.
4. **Manager PIN Recovery ("Forgot PIN?"):**
   - During initial setup, the store owner creates a Manager PIN and an optional offline Recovery Password.
   - If a Manager PIN is forgotten or locked out after 5 consecutive incorrect attempts, click **Forgot PIN?** on the PIN entry dialog and enter the recovery password to immediately reset the Manager PIN without requiring database access or server restarts.
5. **USB Flash Drive Backups ("Download copy"):**
   - In addition to automated hourly snapshots stored securely on disk, shop owners can plug in any USB flash drive or external drive and navigate to **Settings > Data**.
   - Click **Download copy** next to any backup in the list to export an instant, verified database copy directly to your USB drive for offsite disaster recovery.
