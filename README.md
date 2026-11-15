# TechParts POS

Offline-first Point of Sale, repair ticket workstation, and inventory system built for phone repair shops, parts wholesalers, and technician counters. Built entirely on the Node.js 22 standard library (`node:http`, `node:sqlite`, `node:crypto`, `node:fs`, `node:test`) with zero runtime npm dependencies (`dependencies: {}`).

Every sale, print job, credit ledger entry, and day-close report runs locally on the counter computer without an internet connection or cloud account. Only two features ever make outbound network requests: the boot-time GitHub Releases update check (silent when offline) and an optional self-hosted cloud sync server that stays disabled until configured.

## Why Zero Runtime Dependencies

Phone repair counters often run older Windows terminals on unstable connections. Keeping `dependencies` empty removes third-party supply-chain exposure, keeps memory usage low on legacy hardware, and makes Node.js Single Executable Application (`TechPartsPOS.exe`) builds deterministic without native C++ addon toolchains.

## Core Capabilities

- **Dual-tier pricing (`src/sales.js`)** switches instantly between Walk-in Retail (`price_retail`) and Technician/Wholesale (`price_technician`) rates in a single checkout.
- **Unified parts and labor checkout** combines physical inventory items (with automatic stock deduction and integer-cent math) alongside zero-COGS repair labor charges.
- **Repair ticket queue (`src/repairs.js`)** tracks every intake from `intake` to `in_repair`, `ready`, and `released` under `RO-` ticket references, with 58mm/80mm customer pickup slips.
- **FIFO customer credit ledger (`src/credits.js`)** manages unpaid counter balances ("utang") with oldest-first partial and full debt settlement.
- **Warranty and RMA handling (`src/returns.js`)** verifies claims against the shop warranty window, records stock replacements or refunds on the settlement date, and requires manager authorization for exceptions.
- **Supplier reorder and receiving (`src/inventory.js`)** turns low-stock parts into per-supplier reorder sheets with idempotent stock receiving and CSV/spreadsheet import validation.
- **Raw ESC/POS thermal printing (`src/printer.js`)** sends formatted 58mm and 80mm receipt bytes directly to Windows print queues, with automatic browser print fallback for slips and Z-reports.
- **Expenses, Z-reports, and drawer reconciliation (`src/analytics.js`, `src/reconcile.js`)** count cash drawers by payment method (Cash, GCash, transfer) and deduct shop operating expenses so net profit matches across workstation and phone reports.
- **Tamper-evident audit chain and PIN security (`src/audit.js`, `src/auth.js`)** hash-chain audit events with SHA-256 and protect manager actions using salted PBKDF2 (100,000 iterations) PINs with database-persisted lockouts.
- **Optional self-hosted cloud sync (`cloud/server.js`, `src/sync.js`)** mirrors sales, inventory, repair tickets, and open credit to your own zero-dependency Node server with live Server-Sent Events (SSE) for mobile owner dashboards.
- **Automated daily backups and SHA-256 self-updater (`src/updater.js`)** take verified (`PRAGMA integrity_check`) local SQLite snapshots with retention pruning and apply GitHub Releases updates only after SHA-256 verification.

## Architecture and Repository Layout

| Directory | Purpose |
|---|---|
| `src/` | HTTP router, SQLite WAL schema/migrations (`db.js`), sales, inventory, repairs, credit ledger, ESC/POS printer, auth, sync, and updater modules |
| `public/` | Vanilla JS SPA (no framework runtime), precompiled Tailwind CSS v4 styles, self-hosted Phosphor icons, and offline workstation UI |
| `cloud/` | Zero-dependency companion relay and mobile manager PWA using SSE for remote shop monitoring |
| `scripts/` | Build and release pipeline: Tailwind build, Node SEA packaging (`postject`), PE signature checks, Inno Setup installer, and Ed25519 keygen |
| `tests/` | Automated unit, integration, API, security, packaging, and UI regression tests running on `node --test` |
| `docs/` | Deep-dive engineering manuals covering architecture, SQLite schema, REST API, business rules, and counter deployment |

## Quick Start (Build and Run from Source)

### Prerequisites

- Node.js `>= 22.5.0` (required for built-in `node:sqlite`)
- Windows 10/11 (primary target for Windows Spooler printing and `.exe` packaging)

### Run Locally

```bash
git clone https://github.com/katalepsis69/PHONEPOS.git
cd PHONEPOS
npm install
npm start
```

On startup, the workstation initializes `data/shop.db` in WAL mode and opens `http://localhost:3000`. The first-run setup prompts for shop details, a manager PIN replacing the factory default (`1234`), and an offline recovery password.

### Run Tests and Build Artifacts

```bash
# Run the full automated test suite (node:test)
npm test

# Rebuild minified CSS
npm run build:css

# Build standalone Windows Single Executable Application and run smoke verification
npm run build:exe
```

## Download and Windows Installation

Pre-built Windows releases are published on the [Releases](https://github.com/katalepsis69/PHONEPOS/releases) page:

1. Download `TechPartsPOS-Setup-1.4.exe`.
2. Run the installer with Administrator permissions. TechParts POS installs to `C:\Program Files\TechPartsPOS` and registers `TechPartsPOS-Server` as a Windows background service under `NT AUTHORITY\SYSTEM`.
3. Open the desktop shortcut or Start Menu entry to launch the POS workstation in the browser.

## Shop PC Security Setup (Owner Admin and Cashier Standard Account)

For counter terminals shared across multiple shifts:

1. **Separate Windows accounts**: Keep one password-protected Windows Administrator account for the store owner (installs and updates) and one standard non-administrator Windows account for counter cashiers.
2. **NTFS-locked SQLite database**: The installer stores `shop.db` under `C:\ProgramData\TechPartsPOS\data\shop.db` with Full Control restricted to `NT AUTHORITY\SYSTEM`, blocking direct file inspection or tampering from standard cashier accounts.
3. **Printing under `SYSTEM`**: Running `TechPartsPOS-Server` as a `SYSTEM` service keeps USB, Bluetooth, and LAN ESC/POS receipt printers available regardless of which Windows user is logged in.
4. **Offline Manager PIN recovery**: After 5 consecutive wrong attempts the PIN lock engages. Use **Forgot PIN?** with the recovery password created during initial setup to reset the Manager PIN without database access.
5. **USB offsite backups**: Under **Settings > Data**, use **Download copy** on any verified snapshot to save an integrity-checked SQLite copy to an external flash drive.

## Documentation Suite

- [System Architecture Manual](docs/ARCHITECTURE.md)
- [Database Schema and Migration Reference](docs/DATABASE_SCHEMA.md)
- [REST API Reference](docs/API_REFERENCE.md)
- [Business Logic and Workflows](docs/BUSINESS_LOGIC_AND_WORKFLOWS.md)
- [Security and Cryptographic Licensing](docs/SECURITY_AND_LICENSING.md)
- [Operations, Thermal Printing, and Packaging](docs/OPERATIONS_AND_DEPLOYMENT.md)

## Contributing and Quality Invariants

Pull requests and issues are welcome. All changes must respect the repository invariants:

- Keep `dependencies` in `package.json` empty; prefer Node.js built-in modules.
- Parameterize all SQLite queries via `db.prepare(...)` and keep money math in integer cents / `round2`.
- Keep frontend code framework-free in vanilla JS and CSS/HTML under `public/`, and rebuild CSS (`npm run build:css`) when styles change.
- Include regression tests in `tests/*.test.js` and ensure `npm test` passes cleanly.

## License

Released under the [MIT License](LICENSE).
