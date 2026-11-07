# Commercial Licensing, Manager PIN & Security Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn Phone Repair POS into a secure, commercially protectable software product with offline hardware licensing, role-based manager PIN lock, automatic daily database backups, and mobile PWA support.

**Architecture:** 
- Node.js built-in `node:crypto` and `node:os` for offline HMAC-SHA256 hardware-bound licensing and SHA-256 PIN hashing.
- SQLite `shop_settings` table expansion for storing license status and manager PIN.
- Role-based frontend gating for Reports, Cost Prices, and Settings.
- Zero external runtime npm dependencies.

**Tech Stack:** Node.js (v20+), SQLite (`node:sqlite`), HTML5/Tailwind CSS, Lucide icons.

---

### Task 1: Offline Hardware-Bound Licensing Module

**Files:**
- Create: `src/license.js`
- Create: `scripts/generate-license.js`
- Create: `tests/license.test.js`

**Interfaces:**
- `getMachineId()`: returns string `TP-WIN-XXXX-XXXX`
- `generateLicenseKey({ machine_id, plan_type, expires_at, customer_name })`: returns base64 token
- `verifyLicenseKey(licenseKey)`: returns `{ valid: boolean, machine_id, plan_type, expires_at, customer_name, is_expired: boolean, days_left: number }`
- `getLicenseStatus(db)`: returns current activation details.
- `activateLicense(db, licenseKey)`: updates `shop_settings` with valid license.

- [ ] **Step 1: Write the failing tests**
- [ ] **Step 2: Run tests to verify failure**
- [ ] **Step 3: Implement `src/license.js` and `scripts/generate-license.js`**
- [ ] **Step 4: Run tests to verify they pass**

---

### Task 2: Manager PIN Authentication & Role Protection

**Files:**
- Create: `src/auth.js`
- Create: `tests/auth.test.js`

**Interfaces:**
- `hashPin(pin)`: returns SHA256 string
- `verifyManagerPin(db, pin)`: returns `boolean`
- `updateManagerPin(db, oldPin, newPin)`: updates `manager_pin_hash` in `shop_settings`

- [ ] **Step 1: Write the failing tests**
- [ ] **Step 2: Run tests to verify failure**
- [ ] **Step 3: Implement `src/auth.js`**
- [ ] **Step 4: Run tests to verify they pass**

---

### Task 3: Automated Daily Rolling Backups & Auto-Pruning

**Files:**
- Modify: `src/server.js`
- Modify: `tests/analytics.test.js`

**Interfaces:**
- `runDailyBackup(db, dbPath, backupDir)`: creates `backups/shop-YYYY-MM-DD.db` once per calendar day and removes snapshots older than 14 days.

- [ ] **Step 1: Write the failing test**
- [ ] **Step 2: Run test to verify failure**
- [ ] **Step 3: Implement `runDailyBackup` in `src/server.js`**
- [ ] **Step 4: Run test to verify it passes**

---

### Task 4: Server Endpoints & Database Schema Expansion

**Files:**
- Modify: `src/db.js`
- Modify: `src/server.js`
- Modify: `tests/server.test.js`

**Endpoints:**
- `GET /api/license/status`
- `POST /api/license/activate`
- `POST /api/auth/verify-pin`
- `POST /api/auth/change-pin`

- [ ] **Step 1: Write failing server tests**
- [ ] **Step 2: Run tests to verify failure**
- [ ] **Step 3: Update `src/db.js` and `src/server.js`**
- [ ] **Step 4: Run tests to verify they pass**

---

### Task 5: Frontend Security, Activation Modal & Manager Lock

**Files:**
- Modify: `public/index.html`
- Modify: `public/app.js`
- Modify: `public/styles.css`

**UI Features:**
- Unactivated / Trial banner with "Activate License" modal displaying Machine ID.
- Manager PIN prompt modal when clicking "Reports & Profit", "Store & Print Settings", or revealing cost prices.
- Masked cost prices (`••••`) for cashier mode.
- Change Manager PIN tab in Settings.

- [ ] **Step 1: Update `public/index.html` with security modals**
- [ ] **Step 2: Update `public/app.js` with PIN lock & license logic**
- [ ] **Step 3: Update `public/styles.css`**

---

### Task 6: Mobile PWA Support (Progressive Web App)

**Files:**
- Create: `public/manifest.json`
- Create: `public/icon.svg`
- Modify: `public/index.html`

- [ ] **Step 1: Create `public/manifest.json` and app icon**
- [ ] **Step 2: Link `manifest.json` and Apple mobile meta tags in `public/index.html`**

---

### Task 7: Single Executable Packaging & Startup Automation

**Files:**
- Modify: `package.json`
- Modify: `start.bat`

- [ ] **Step 1: Add build scripts to `package.json`**
- [ ] **Step 2: Update `start.bat` for seamless local launch**

---

### Task 8: End-to-End Commercial Test Verification

**Files:**
- Modify: `tests/e2e.test.js`

- [ ] **Step 1: Update e2e test with license activation, PIN verification, daily backup, and sales flow**
- [ ] **Step 2: Run `npm test` across all 14+ test suites to ensure 100% pass**
