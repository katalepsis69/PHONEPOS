# Complete System Documentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create a comprehensive, production-grade technical and operational documentation suite for the Phone Repair POS & Inventory Management system.

**Architecture:** The documentation is structured into seven modular, highly-focused reference manuals in `docs/` and root `README.md`. Each document details a core subsystem (Architecture, Database Schema, REST API, Domain Business Logic, Security & Licensing, Operations/Deployment, and System Overview) with exact schemas, formulas, endpoints, and workflows.

**Tech Stack:** Markdown (GitHub Flavored Markdown), Node.js (v22+ standard library), SQLite (`node:sqlite`), Ed25519 Cryptography (`node:crypto`), Vanilla JS SPA, Tailwind CSS v4.

## Global Constraints

- Zero external runtime dependencies: Everything in the documentation must reflect the native Node.js standard library architecture.
- Document exact field names, table names, HTTP routes, status codes, and cryptographic specifications from the active codebase.
- No placeholders, "TODO", or pseudo-code in documentation tasks; provide complete, verifiable documentation text.
- Follow the senior developer / ponytail philosophy: concise, accurate, structural, high-signal information without repetitive fluff.

---

### Task 1: Architecture & Zero-Dependency System Design Manual

**Files:**
- Create: `docs/ARCHITECTURE.md`

**Interfaces:**
- Consumes: [src/server.js](file:///c:/Users/sloth/Downloads/phone-repair-pos/src/server.js), [src/db.js](file:///c:/Users/sloth/Downloads/phone-repair-pos/src/db.js), [scripts/build-exe.js](file:///c:/Users/sloth/Downloads/phone-repair-pos/scripts/build-exe.js)
- Produces: Complete architectural specification including runtime constraints, process lifecycle, fallback asset serving, port auto-hunting, and crash logging.

- [x] **Step 1: Write `docs/ARCHITECTURE.md`**

Create `docs/ARCHITECTURE.md` covering:
1. Architectural Philosophy: Zero-runtime dependencies (`node:http`, `node:sqlite`, `node:crypto`, `node:fs`), 100% offline-first operations.
2. System Directory Structure: Root, `src/`, `public/`, `scripts/`, `data/`, `backups/`, `dist/`, `tests/`.
3. Process Lifecycle & Server Bootstrap (`startServer`): Port conflict resolution (`EADDRINUSE` auto-hunting up to +20 ports), Windows auto-launch (`start http://...`), uncaught exception/rejection crash handling (`pos-crash.log`).
4. Dual-Mode Asset Resolution: File system serving via MIME table during development vs In-memory fallback (`global.__EMBEDDED_STATIC__`) when compiled into a Node.js Single Executable Application (SEA).
5. Data flow diagram between Browser Client, HTTP Router, Domain Logic Services, and Embedded SQLite Engine.

- [x] **Step 2: Verify document formatting and references**

Verify that all internal file links in `docs/ARCHITECTURE.md` are valid and accurately describe `src/server.js` and `scripts/build-exe.js`.

- [x] **Step 3: Commit**

```bash
git add docs/ARCHITECTURE.md
git commit -m "docs: add comprehensive system architecture manual"
```

---

### Task 2: Database Schema & Transactional Migration Reference

**Files:**
- Create: `docs/DATABASE_SCHEMA.md`

**Interfaces:**
- Consumes: [src/db.js](file:///c:/Users/sloth/Downloads/phone-repair-pos/src/db.js), [src/seed.js](file:///c:/Users/sloth/Downloads/phone-repair-pos/src/seed.js)
- Produces: Complete database dictionary, table schemas, column types, default values, foreign key cascades, PRAGMA configurations, and append-only migration mechanics.

- [x] **Step 1: Write `docs/DATABASE_SCHEMA.md`**

Create `docs/DATABASE_SCHEMA.md` detailing:
1. SQLite Database Configuration: `PRAGMA foreign_keys = ON`, `PRAGMA journal_mode = WAL`, `DEFAULT_DB_PATH` resolution (`data/shop.db` relative to binary or workspace).
2. Data Dictionary for all 6 tables:
   - `inventory`: id, brand, model_name, part_type, sku_barcode, cost_price, price_retail, price_technician, stock_quantity, min_stock_alert, created_at, updated_at.
   - `sales`: id, sale_code, customer_name, customer_phone, customer_type, payment_method, payment_reference, subtotal, discount, total_amount, amount_paid, change_amount, credit_balance, created_at.
   - `sale_items`: id, sale_id (FK cascade), inventory_id (FK nullable), item_type ('part' | 'labor'), item_name, unit_cost, unit_price, quantity, total_price.
   - `warranty_returns`: id, return_code, sale_id (FK), sale_item_id (FK), customer_name, item_name, quantity, return_type ('replacement' | 'cash_refund' | 'credit_refund'), return_reason, replacement_inventory_id, refund_amount, technician_notes, created_at.
   - `credit_payments`: id, customer_name, amount_paid, payment_method, payment_reference, notes, created_at.
   - `shop_settings`: key (PK), value (stores GCash config, receipt format, warranty text, manager PIN hash, license, backup date).
3. Migration & Versioning Strategy: `PRAGMA user_version` tracking, append-only `MIGRATIONS` array, atomic transaction rollback on failure, `isFreshDb` fast-path initialization.
4. Default Seeds: Factory settings and initial standard repair catalog (`INITIAL_PARTS`).

- [x] **Step 2: Verify schema accuracy against `src/db.js`**

Confirm every constraint, data type, and index in `docs/DATABASE_SCHEMA.md` matches `src/db.js:56-150`.

- [x] **Step 3: Commit**

```bash
git add docs/DATABASE_SCHEMA.md
git commit -m "docs: add complete database schema and migration reference"
```

---

### Task 3: REST API Reference & Specification

**Files:**
- Create: `docs/API_REFERENCE.md`

**Interfaces:**
- Consumes: [src/server.js](file:///c:/Users/sloth/Downloads/phone-repair-pos/src/server.js)
- Produces: Complete HTTP API specification with paths, verbs, query parameters, request bodies, response shapes, and error status codes.

- [x] **Step 1: Write `docs/API_REFERENCE.md`**

Create `docs/API_REFERENCE.md` documenting all endpoints:
1. Inventory Endpoints:
   - `GET /api/inventory` (params: `search`, `brand`, `low_stock`)
   - `POST /api/inventory` (payload: brand, model_name, part_type, sku_barcode, cost_price, price_retail, price_technician, stock_quantity, min_stock_alert)
   - `PUT /api/inventory/:id`
   - `POST /api/inventory/:id/adjust-stock` (payload: `{ delta: number }`)
   - `DELETE /api/inventory/:id`
2. Sales Endpoints:
   - `GET /api/sales` (params: `limit`, `offset`, `search`, `payment_method`)
   - `POST /api/sales` (payload: customer_name, customer_phone, customer_type, payment_method, payment_reference, discount, amount_paid, items: [{ inventory_id, item_type, item_name, unit_price, quantity }])
   - `GET /api/sales/:id`
3. Customer & Credit Endpoints:
   - `GET /api/customers` (params: `search`, `filter`)
   - `GET /api/customers/:name`
   - `POST /api/customers/:name/settle-credit` (payload: amount_paid, payment_method, payment_reference, notes)
4. Warranty & Returns Endpoints:
   - `POST /api/sales/:id/returns` (payload: sale_item_id, return_type, return_reason, replacement_inventory_id, refund_amount, technician_notes)
   - `GET /api/returns` (params: `search`, `return_type`)
   - `GET /api/returns/:id`
5. Settings, Auth & Dashboard:
   - `GET /api/settings`, `POST /api/settings`
   - `GET /api/dashboard`
   - `POST /api/backup`
   - `GET /api/license/status`, `POST /api/license/activate`
   - `POST /api/auth/verify-pin`, `POST /api/auth/change-pin`
   - `POST /api/settings/reset-demo`

- [x] **Step 2: Verify request/response signatures against `src/server.js`**

Validate that all parameter names, route regexes, and JSON envelopes match `src/server.js:61-214`.

- [x] **Step 3: Commit**

```bash
git add docs/API_REFERENCE.md
git commit -m "docs: add REST API reference and endpoint specifications"
```

---

### Task 4: Core Domain Logic & Business Workflows Manual

**Files:**
- Create: `docs/BUSINESS_LOGIC_AND_WORKFLOWS.md`

**Interfaces:**
- Consumes: [src/sales.js](file:///c:/Users/sloth/Downloads/phone-repair-pos/src/sales.js), [src/credits.js](file:///c:/Users/sloth/Downloads/phone-repair-pos/src/credits.js), [src/returns.js](file:///c:/Users/sloth/Downloads/phone-repair-pos/src/returns.js), [src/inventory.js](file:///c:/Users/sloth/Downloads/phone-repair-pos/src/inventory.js), [src/analytics.js](file:///c:/Users/sloth/Downloads/phone-repair-pos/src/analytics.js)
- Produces: Comprehensive breakdown of business rules, pricing tiers, FIFO debt settlement, RMA stock/refund logic, and financial reporting formulas.

- [x] **Step 1: Write `docs/BUSINESS_LOGIC_AND_WORKFLOWS.md`**

Create `docs/BUSINESS_LOGIC_AND_WORKFLOWS.md` detailing:
1. POS Sales & Pricing Engine:
   - Pricing Tiers: Retail (`price_retail`) vs Technician / Wholesale (`price_technician`).
   - Line Item Types: Physical Part (decrements inventory in atomic transaction) vs Service Labor (`unit_cost = 0`, no stock decrement).
   - Discounts & Subtotal: `totalAmount = Math.max(0, subtotal - discount)`.
   - Payment Methods (`cash`, `gcash`, `transfer`, `credit`) & Change / Credit balance calculation.
2. Credit Ledger & Utang Settlement (FIFO):
   - Debt generation on partial or credit checkout.
   - Settle Credit Algorithm: Iterating open sales in ascending order of sale ID (`ORDER BY id ASC`), deducting amount until payment exhausted, atomic updates.
3. Warranty Claims & RMA Workflow:
   - Replacement: stock validation and decrement of replacement part ID.
   - Cash Refund vs Credit Refund (reducing customer's credit balance on the specific sale).
4. Analytics & Daily Metrics Math:
   - Exact calculation of `today_sales_profit = today_revenue - parts_cogs` (labor has 0 COGS).
   - Reconciliation of Cash Collected (POS cash paid + Credit Cash settled).
   - Inventory Valuation: Total Cost vs Total Retail Value.

- [x] **Step 2: Verify calculations against test cases in `tests/`**

Verify edge cases (e.g. overpayment, partial FIFO deduction, zero-cost labor) against `tests/sales.test.js`, `tests/credits.test.js`, and `tests/analytics.test.js`.

- [x] **Step 3: Commit**

```bash
git add docs/BUSINESS_LOGIC_AND_WORKFLOWS.md
git commit -m "docs: add business logic, pricing tiers, and financial workflows manual"
```

---

### Task 5: Security Architecture & Cryptographic Licensing Manual

**Files:**
- Create: `docs/SECURITY_AND_LICENSING.md`

**Interfaces:**
- Consumes: [src/auth.js](file:///c:/Users/sloth/Downloads/phone-repair-pos/src/auth.js), [src/license.js](file:///c:/Users/sloth/Downloads/phone-repair-pos/src/license.js), [scripts/generate-license.js](file:///c:/Users/sloth/Downloads/phone-repair-pos/scripts/generate-license.js)
- Produces: Complete guide on manager authentication, timing-safe equality, anti-brute-force state persistence, Ed25519 asymmetric signature licensing, machine fingerprinting, and vendor key management.

- [x] **Step 1: Write `docs/SECURITY_AND_LICENSING.md`**

Create `docs/SECURITY_AND_LICENSING.md` covering:
1. Manager PIN Security:
   - Default PIN policy (`1234` SHA-256 hash), mandatory PIN change indicator (`pin_change_required`).
   - Anti-Brute-Force Mechanism: 5 max attempts, 60-second lockout stored in `shop_settings` (`pin_lockout_until`, `pin_failed_attempts`), resilient across app restarts.
   - Timing-safe validation (`crypto.timingSafeEqual`).
   - Protected Settings Filter: `PRIVATE_SETTINGS` isolation preventing setting mutation or PIN extraction via `/api/settings`.
2. Offline Cryptographic Licensing:
   - Ed25519 Asymmetric Signatures: Public SPKI DER base64 embedded in client build; Private key stays exclusively with vendor.
   - Machine Fingerprinting: Platform, Hostname, Arch, CPU Model hashed to `TP-XXX-XXXX-XXXX`.
   - License Format: `<Base64URL(Payload)>.<Base64URL(Ed25519Signature)>`.
   - Plan Types: `lifetime` vs `subscription` (with `expires_at` date validation and `days_left` countdown).
3. Vendor Licensing CLI (`scripts/generate-license.js`):
   - Keypair generation (`--init`).
   - Key issuance (`--machine <ID> --name <NAME> [--days <N>]`).
   - Signature verification against the embedded public key before delivery.

- [x] **Step 2: Cross-check against `src/auth.js` and `src/license.js`**

Confirm parameter requirements and cryptographic algorithms match implementation.

- [x] **Step 3: Commit**

```bash
git add docs/SECURITY_AND_LICENSING.md
git commit -m "docs: add security architecture and cryptographic licensing manual"
```

---

### Task 6: Operations, Thermal Printing, Backups & SEA Packaging

**Files:**
- Create: `docs/OPERATIONS_AND_DEPLOYMENT.md`

**Interfaces:**
- Consumes: [src/server.js](file:///c:/Users/sloth/Downloads/phone-repair-pos/src/server.js), [scripts/build-exe.js](file:///c:/Users/sloth/Downloads/phone-repair-pos/scripts/build-exe.js), [public/app.js](file:///c:/Users/sloth/Downloads/phone-repair-pos/public/app.js)
- Produces: Operational documentation covering Single Executable Application (SEA) Windows packaging, thermal receipt rendering (58mm/80mm), ESC/POS considerations, automated daily backup schedule, 14-day retention, manual backup/restore, and emergency recovery.

- [x] **Step 1: Write `docs/OPERATIONS_AND_DEPLOYMENT.md`**

Create `docs/OPERATIONS_AND_DEPLOYMENT.md` detailing:
1. Windows Standalone Executable Packaging (`scripts/build-exe.js`):
   - SEA generation flow: Tailwind CSS build $\rightarrow$ Static asset embedding $\rightarrow$ SEA blob preparation with `postject` $\rightarrow$ Standalone executable output.
2. Thermal Receipt Printing System:
   - 58mm vs 80mm paper width configuration.
   - CSS Print media query styling (`@media print`), monochrome high-contrast formatting, GCash QR code embedding, warranty clause printing.
3. Database Backups & Disaster Recovery:
   - Automated Daily Startup Backup (`runDailyBackup`): One backup per day (`shop-YYYY-MM-DD.db`), 14-day automatic retention pruning.
   - On-Demand Backup API (`POST /api/backup`).
   - Database restore procedure from `backups/*.db` to `data/shop.db`.
4. Troubleshooting & Logging:
   - `pos-crash.log` diagnostic tracing.
   - Port conflicts and workstation firewall allowances.

- [x] **Step 2: Verify build script arguments and paths**

Check against `scripts/build-exe.js` and `src/server.js:241-268`.

- [x] **Step 3: Commit**

```bash
git add docs/OPERATIONS_AND_DEPLOYMENT.md
git commit -m "docs: add operations, thermal printing, backup and packaging manual"
```

---

### Task 7: Root System Documentation & Project README

**Files:**
- Create: `README.md`

**Interfaces:**
- Consumes: All `docs/*.md` documents created in Tasks 1-6.
- Produces: Clean, modern, comprehensive root documentation for developers, operators, and shop owners.

- [x] **Step 1: Write `README.md`**

Create root `README.md` containing:
1. Project title, badge summary, and core tagline ("Zero-dependency, offline-first Phone Repair POS & Parts Management").
2. Key Feature Highlights (POS, Technician Pricing, Utang Credit Ledger, Warranty RMA, GCash QR, Thermal Printing, Manager PIN, Ed25519 Offline Licensing).
3. Technology Stack Breakdown (Runtime, Database, Frontend, Build & Test).
4. Quickstart Guide (Prerequisites, installation, starting dev server, running tests).
5. Build & Distribution Guide (Building Windows `.exe`, generating licenses).
6. Directory & Documentation Sitemap linking directly to `docs/ARCHITECTURE.md`, `docs/DATABASE_SCHEMA.md`, `docs/API_REFERENCE.md`, `docs/BUSINESS_LOGIC_AND_WORKFLOWS.md`, `docs/SECURITY_AND_LICENSING.md`, and `docs/OPERATIONS_AND_DEPLOYMENT.md`.

- [x] **Step 2: Verify all markdown links in `README.md`**

Ensure every link points to existing, correctly capitalized markdown files in `docs/`.

- [x] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: create comprehensive project README and documentation hub"
```

---

## Self-Review Checklist

1. **Spec Coverage:** Covers every subsystem in the repository: Architecture, Database, REST API, Domain Rules, Security/PIN, Licensing, Thermal Printing/Operations, and Root README.
2. **Placeholder Scan:** Zero instances of "TBD", "TODO", "implement later", or ambiguous steps.
3. **Type and Route Consistency:** Exact names matched across `src/server.js`, `src/db.js`, `src/sales.js`, `src/credits.js`, `src/returns.js`, `src/license.js`, `src/auth.js`.
