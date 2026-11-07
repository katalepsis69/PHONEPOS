# TechParts POS & Phone Repair Management System

> **Commercial-Grade, 100% Offline, Zero-Runtime-Dependency Point of Sale & Inventory Management System for Phone Repair Shops & Parts Wholesalers.**

---

## ⚡ Highlights & Key Capabilities

- **🚀 0 Runtime Dependencies**: Runs entirely on the native Node.js standard library (`node:http`, `node:sqlite`, `node:crypto`, `node:fs`). Zero third-party npm production packages.
- **🏷️ Dual-Tier Pricing**: Automatic pricing toggles between Walk-in Retail (`price_retail`) and Technician/Wholesale (`price_technician`).
- **🔧 Parts & Service Labor Checkout**: Unified cart supporting physical phone parts (auto-decrements stock) and custom repair labor charges (zero COGS, pure service margin).
- **📒 "Utang" / Customer Credit Ledger**: Complete debt tracking with FIFO (First-In, First-Out) partial and full debt liquidation.
- **🛡️ Warranty & RMA Management**: Claims are checked against the shop's warranty window and the exact purchased line. A replacement is the same part unless a manager authorizes a like-for-like swap inside the same part type; an expired claim needs a manager, and every decision is written to the append-only audit trail. Cash refunds and credit reductions are recorded on the day they happen.
- **📱 GCash & Digital Payments Integration**: Embedded GCash payment reference capture, shop QR display, and a day close that counts the drawer against the day's takings per payment method (Reports tab, `POST /api/reconcile/close-day`). Collections by GCash or transfer require a ref number, and above a shop-set amount a manager must authorize them.
- **🖨️ Thermal Receipt Printing**: Counter slips (sale, credit settlement, test receipt) are laid out and encoded as ESC/POS by the server and written straight to the Windows queue picked in Settings, so the counter never touches a print dialog. The cash drawer and the paper cut stay with the driver: no drawer-kick or auto-cut command is ever sent. The Z-report and the period summary still print through the browser path on purpose, and if the queue refuses a slip the tab falls back to browser printing (@media print) so the customer still leaves with a receipt.
- **🔒 Anti-Brute-Force Manager Security**: Manager PIN stored as PBKDF2 with a per-hash salt and 100,000 iterations (legacy SHA-256 hashes are upgraded on first use), timing-safe verification, and database-persisted lockout counters. The phone report has its own attempt counter and a longer lockout, so guessing from a device on the LAN cannot freeze the register.
- **☁️ Optional Cloud Sync + Live Manager App**: One-way push of sales, stock and utang to your own VPS (`cloud/server.js`, zero dependencies) with a live manager phone app — period reports, top parts, utang and low stock over Server-Sent Events. The workstation stays fully offline-first: no cloud URL configured, nothing ever leaves the shop. On the shop LAN, `report.html` also serves a lightweight read-only phone report with no cloud at all; a non-loopback bind has to be acknowledged by the operator first (see `docs/OPERATIONS_AND_DEPLOYMENT.md` section 5.6). See [`docs/OPERATIONS_AND_DEPLOYMENT.md`](file:///c:/Users/sloth/Downloads/phone-repair-pos/docs/OPERATIONS_AND_DEPLOYMENT.md) §5.
- **🔑 Ed25519 Offline Cryptographic Licensing**: Hardware-fingerprinted offline commercial licensing with lifetime and subscription key generation.
- **⏳ 14-Day Full-Function Trial**: Every workstation runs the complete product free for 14 days from first run, then activates with a **lifetime license per seat** (one-time purchase; activation restores access instantly and customer data is never deleted).
- **💾 Automated Backups and Day Close**: Database snapshots run at startup and then once an hour (one per calendar day), each verified with `PRAGMA integrity_check` before it is allowed to replace the previous good copy. Retention prunes both automatic and manual snapshots older than 14 days. Snapshots share the disk with the live database, so `scripts/mirror-backups.js` copies them to a second disk or a share, and the Reports tab warns when the newest snapshot goes stale.
- **📦 Windows Standalone Executable (.exe)**: Packaged as a single standalone executable for deployment on any Windows machine without requiring Node.js to be pre-installed.

---

## 🛠️ Technology Stack

| Layer | Technology | Key Details |
|---|---|---|
| **Runtime** | **Node.js (v22.5.0+)** | Native standard library modules (`node:http`, `node:crypto`, `node:fs`) |
| **Database** | **Embedded SQLite (`node:sqlite`)** | `DatabaseSync` engine with `PRAGMA foreign_keys = ON` and `WAL` mode |
| **Frontend** | **Vanilla JS (ES6+) SPA** | Semantic HTML5, reactive client state, and self-hosted Phosphor icon font |
| **Styling** | **Tailwind CSS v4** | Standalone pre-compiled CSS (`@tailwindcss/cli`) with Dark/Light themes |
| **Packaging** | **Node.js SEA (Single Executable App)** | Windows standalone `.exe` bundling with embedded in-memory fallback assets |
| **Testing** | **Native Node Test Runner** | `node --test` test suite across all modules in `tests/` |

---

## 📚 Complete Documentation Suite

Comprehensive deep-dive manuals are available in the [`docs/`](file:///c:/Users/sloth/Downloads/phone-repair-pos/docs/) directory:

- 🏛️ [**System Architecture Manual**](file:///c:/Users/sloth/Downloads/phone-repair-pos/docs/ARCHITECTURE.md): Process lifecycle, port auto-hunting, SEA asset fallback, and crash handlers.
- 🗄️ [**Database Schema & Migration Reference**](file:///c:/Users/sloth/Downloads/phone-repair-pos/docs/DATABASE_SCHEMA.md): Column-level data dictionary for the money tables, relations, and transactional migration rules (the audit, staffing, sync and ledger tables follow the same conventions and are defined in `src/db.js`).
- 🌐 [**REST API Reference & Specifications**](file:///c:/Users/sloth/Downloads/phone-repair-pos/docs/API_REFERENCE.md): Full HTTP endpoints, payload definitions, query parameters, and status codes.
- 💼 [**Business Logic & Workflows Manual**](file:///c:/Users/sloth/Downloads/phone-repair-pos/docs/BUSINESS_LOGIC_AND_WORKFLOWS.md): Dual-tier pricing rules, FIFO debt settlement, RMA handling, and gross profit math.
- 🔐 [**Security & Cryptographic Licensing Manual**](file:///c:/Users/sloth/Downloads/phone-repair-pos/docs/SECURITY_AND_LICENSING.md): Manager PIN protections, hardware fingerprinting, and Ed25519 offline license verification.
- 🖨️ [**Operations, Thermal Printing & Packaging**](file:///c:/Users/sloth/Downloads/phone-repair-pos/docs/OPERATIONS_AND_DEPLOYMENT.md): ESC/POS print queue setup, 58mm/80mm thermal receipt widths, SEA build pipeline, daily backups, and disaster recovery.

---

## 🚀 Quickstart Guide

### Prerequisites
- [Node.js (v22.5.0 or higher)](https://nodejs.org)

### Installation & Starting
1. Clone or extract the repository:
   ```bash
   cd phone-repair-pos
   ```
2. Start the application:
   - **On Windows**: Double-click [`start.bat`](file:///c:/Users/sloth/Downloads/phone-repair-pos/start.bat) or run:
     ```bash
     npm start
     ```
3. The POS system will initialize the SQLite database at `data/shop.db`, seed the standard phone repair parts catalog (if empty), and automatically open your default browser to:
   ```
   http://localhost:3000
   ```

### Default Credentials
- **Default Manager PIN**: `1234`
- *(First run opens a setup screen for the shop details and a new manager PIN. The prompt can be deferred for the session, but while the factory PIN `1234` is live the app refuses manager elevation: shop settings, starter seeding and the day close stay unavailable until the PIN is replaced).*

---

## 🧪 Running Automated Tests

Run the built-in test suite:
```bash
npm test
```

---

## 📦 Building Standalone Windows Executable

To compile and verify the vendor artifacts, then atomically publish a customer-safe release containing only `TechPartsPOS.exe`:
```bash
npm run build:exe
```

Distribute `release/customer/`, never `dist/`. The `dist/` directory is a vendor workspace and may contain `LicenseGenerator.exe`; live `data/`, `backups/`, and `vendor-private-key.pem` are explicitly excluded from the customer release.

---

## 🔑 License Generation (Vendor Tooling)

**Commercial model:** 14-day full-function trial from first run, then a lifetime license
per workstation (₱2,999–₱4,999/seat, vendor-tunable). Subscription keys remain supported
by the keygen (`--days`) but are unmarketed.

Generate hardware-locked license keys using the vendor keygen CLI:
```bash
# 1. Initialize vendor keypair (first time only):
node scripts/generate-license.js --init

# 2. Issue Lifetime License for a client Machine ID:
node scripts/generate-license.js --machine TP-WIN-XXXX-XXXX --name "Shop Name"

# 3. Issue 1-Year Subscription License:
node scripts/generate-license.js --machine TP-WIN-XXXX-XXXX --name "Shop Name" --days 365
```

---

## 📄 License
Commercial License &copy; 2026. All rights reserved.
