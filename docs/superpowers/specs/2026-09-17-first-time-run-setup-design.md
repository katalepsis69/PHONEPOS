# Technical Design Specification: Ultra-Lean First-Time Run Setup

**Date:** 2026-09-17  
**Status:** Approved (Ultra-Ponytail Mode)  
**Topic:** In-App Quick Shop Setup Card (Upgraded `#pin-setup-overlay`)

---

## 1. Executive Summary

Instead of adding complex multi-step wizards, state machines, and speculative database schemas, we adopt the **Ultra-Ponytail** architecture:
We upgrade the existing `#pin-setup-overlay` (which already triggers automatically when a shop is running on the default factory PIN `1234`) into a single, compact **Quick Shop Setup Card**.

In 15 seconds on a single form, the shop owner configures:
1. **Shop Name** (reusing existing `gcash_name` setting, which already renders as the receipt header).
2. **New Manager PIN** (reusing existing `/api/auth/change-pin`).
3. **Printer Width** (reusing existing `receipt_paper_width` setting: `80mm` vs `58mm`).
4. **Starter Inventory Checkbox** (optionally pre-loads standard 17 phone repair parts with 0 stock).

Zero new modals. Zero state machines. Zero schema migrations.

---

## 2. UI Specification: Quick Setup Card

### 2.1 Card Structure (`public/index.html`)
The existing `#pin-setup-overlay` is enhanced in-place:
* **Icon & Header**: Store icon (`ph-storefront`), *"Set Up Your Shop"*, subheading: *"Welcome to TechParts POS! Customize your shop name, secure your manager PIN, and get ready for sales."*
* **Field 1: Shop Name**:
  * Text input `#setup-shop-name`, placeholder: `e.g. FixZone Phone Repair`, pre-filled with current `gcash_name` (or blank).
* **Field 2: Manager PIN & Confirm**:
  * `#setup-pin-new` and `#setup-pin-confirm` (existing inputs, numeric password, min 4 digits, rejects `1234`).
* **Field 3: Receipt Printer Roll**:
  * Radio / Segmented pill buttons: `80mm Desktop (Default)` and `58mm Pocket`.
* **Field 4: Starter Parts Catalog**:
  * Checkbox `#setup-seed-parts` (checked by default): *"Pre-load 17 standard phone repair parts (LCDs & Batteries for iPhone, Samsung, Xiaomi) with 0 initial stock"*.
* **Actions**:
  * `[ Save & Launch Shop ]` (Primary button: `#setup-submit-btn`).
  * `[ Keep defaults / Skip ]` (Quiet link: `#setup-skip-btn`, keeps 1234 / defaults if owner insists).

---

## 3. Data & API Architecture

### 3.1 Reuse Existing Settings & APIs
* **Shop Name & Printer Width**: Handled by existing `POST /api/settings` with `{ gcash_name: shopName, receipt_paper_width: paperWidth }`.
* **PIN Rotation**: Handled by existing `POST /api/auth/change-pin` with `{ old_pin: '1234', new_pin: newPin }`.
* **Zero-Stock Starter Parts**:
  * Add a minimal endpoint `POST /api/inventory/seed-starter` (or parameter on seed):
    * If `inventory` table is empty, inserts the 17 items from `INITIAL_PARTS` with `stock_quantity = 0` and an initial movement with `delta = 0`.
    * If already populated, does nothing (idempotent).
* **Single Client Handler**:
  * `submitShopSetup()` in `public/js/auth.js`:
    1. Validates PIN match and length.
    2. Calls `change-pin`.
    3. Calls `POST /api/settings`.
    4. If checkbox checked, calls `seed-starter`.
    5. Refreshes shop settings & catalog, closes overlay, toasts `"Shop configured successfully!"`.

---

## 4. Files to Touch

1. **`src/seed.js`**:
   * Add optional `{ zeroStock = false }` to `seedInitialParts(db, opts)` so parts can be inserted with 0 quantity without sales history.
2. **`src/server.js`**:
   * Add lightweight `POST /api/inventory/seed-starter` endpoint (manager-elevated or allowed on first run).
3. **`public/index.html`**:
   * Update `#pin-setup-overlay` markup with the 4 fields (Shop Name, PIN, Printer Width, Starter Parts checkbox).
4. **`public/js/auth.js`**:
   * Update `submitPinSetup()` to read the additional fields, save settings, optionally seed starter parts, and dismiss overlay.

---

## 5. Verification Plan

1. **Automated Tests (`tests/setup.test.js` or in `tests/server.test.js`)**:
   * Verify `seedInitialParts(db, { zeroStock: true, skipSales: true })` creates 17 parts with `stock_quantity === 0`.
   * Verify `POST /api/inventory/seed-starter` is idempotent.
   * Run full test suite (`npm test`) — maintain 100% pass on all 163+ tests.
2. **Manual Smoke Check**:
   * Launch fresh database.
   * Verify the enhanced setup card renders with all 4 fields.
   * Fill out the form, submit, verify:
     * PIN changed from 1234.
     * Receipt header reflects new shop name.
     * Inventory catalog has 17 parts at 0 stock.
     * Counter is immediately usable.
