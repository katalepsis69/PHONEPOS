# Commercial Deployment, Licensing & Security Design Spec

## 1. Overview & Business Objectives
To transform the **Phone Repair POS & Inventory System** into a commercially viable, sellable product for repair shops and retail businesses, the system requires protection against unauthorized duplication, role-based privacy for the store owner, automated data safety, and easy remote access.

This design implements a **zero-dependency, offline-first commercial security suite** built with Node.js built-in modules (`node:crypto`, `node:os`, `node:fs`, `node:http`).

---

## 2. Core Modules & Architecture

### Module 1: Hardware-Bound Offline Licensing (`src/license.js` & `scripts/generate-license.js`)
- **Machine Identification:** Derives a stable, tamper-resistant Machine ID based on OS platform, hostname, CPU architecture, and machine network identifiers (e.g. `TP-WIN-8E29-B104`).
- **Cryptographic Signature Verification:** 
  - Uses HMAC-SHA256 with a master signing secret to verify license tokens without requiring an external server or internet connection.
  - License payload encodes `{ machine_id, plan_type: 'lifetime' | 'subscription', expires_at, customer_name }`.
- **License Generator Utility:** Standalone CLI script for the vendor to issue keys:
  ```bash
  node scripts/generate-license.js --machine TP-WIN-8E29-B104 --name "Dave Repair Shop" --days 365
  ```
- **Activation UI & Grace Period:** If unactivated, displays an Activation Screen showing the Machine ID and input field for the license key.

### Module 2: Role-Based Manager PIN Access Lock (`src/auth.js` / UI Security)
- **Problem:** Cashiers/technicians should not view cost prices, profit margins, or change store settings.
- **Implementation:**
  - Manager 4-Digit PIN stored hashed in `shop_settings` (default: `1234`).
  - Cashier view hides:
    - **Reports & Profit Tab** (locked behind PIN prompt).
    - **Inventory Cost Price** (masked as `••••` or hidden unless unlocked).
    - **Store & GCash Settings** (requires PIN).
    - **Credit / Debt manual wipe/voiding** (requires PIN).
  - PIN modal prompts with auto-lock timeout.

### Module 3: Automated Daily Rolling Backups
- Automatically creates a timestamped database snapshot `backups/shop-YYYY-MM-DD.db` upon the first server launch of each day.
- Keeps a rolling 14-day history, automatically pruning snapshots older than 14 days to conserve disk space.

### Module 4: Mobile PWA (Progressive Web App) Support
- Adds `public/manifest.json` and mobile app icons for seamless **"Add to Home Screen"** on Android and iPhone.
- Enables full-screen standalone mode without browser navigation bars for the boss's remote monitoring.

### Module 5: Single-File Executable Packaging & Startup Automation
- Script to bundle the application into a single standalone `.exe` using Node.js SEA (Single Executable Application) or `pkg`.
- Includes a 1-click Windows startup helper to auto-launch the POS on machine boot.

---

## 3. Database Schema Updates (`src/db.js`)

Add fields to `shop_settings` table:
- `license_key TEXT DEFAULT ''`
- `manager_pin_hash TEXT DEFAULT '03ac674216f3e15c761ee1a5e255f067953623c8b388b4459e13f978d7c846f4'` (SHA256 for `1234`)
- `last_backup_date TEXT DEFAULT ''`

---

## 4. API Endpoints

- `GET /api/license/status` &rarr; returns `{ activated, machine_id, plan_type, expires_at, days_left }`
- `POST /api/license/activate` &rarr; body `{ license_key }`, validates and saves to DB.
- `POST /api/auth/verify-pin` &rarr; body `{ pin }`, validates manager PIN.
- `POST /api/auth/change-pin` &rarr; body `{ old_pin, new_pin }`, updates manager PIN.

---

## 5. Verification & Testing Strategy

- `tests/license.test.js`: Verify Machine ID generation, valid token generation & verification, tampering detection, and expiry checking.
- `tests/auth.test.js`: Verify PIN verification, hash storage, and failure locks.
- `tests/backups.test.js`: Verify daily rolling auto-backup and retention pruning.
- `tests/e2e.test.js`: Full end-to-end commercial lifecycle test.
