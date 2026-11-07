# POS Thermal Printing, Labor Fees & Warranty Returns Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement Labor/Service Fees at POS checkout, 58mm/80mm Universal Thermal Receipt Printing with Credit Agreement signature lines, and Defective Part Returns & Warranty Replacements (RMA) with 0 external dependencies.

**Architecture:** Native Node.js `node:http` REST API with built-in SQLite `node:sqlite` storage. Frontend uses vanilla JS and responsive `@media print` thermal formatting.

**Tech Stack:** Node.js (v22+), SQLite (`node:sqlite`), HTML5/TailwindCSS (CDN), Lucide Icons.

## Global Constraints
- 0 runtime dependencies (Node.js standard library only).
- Clean native SQL transactions (`BEGIN TRANSACTION;` / `COMMIT;`).
- Offline-first operation.

---

### Task 1: Database Schema Expansion (`src/db.js`)

**Files:**
- Modify: `src/db.js`
- Test: `tests/db.test.js`

**Interfaces:**
- `initDb(dbPath)`: adds `item_type` to `sale_items`, creates `warranty_returns` table, seeds default settings for `receipt_paper_width`, `warranty_days`, `warranty_policy_text`, `shop_footer_note`.

- [ ] **Step 1: Write failing schema tests in `tests/db.test.js`**
- [ ] **Step 2: Run `node --test tests/db.test.js` to verify failure**
- [ ] **Step 3: Update `src/db.js` schema definitions and settings defaults**
- [ ] **Step 4: Run `node --test tests/db.test.js` to verify PASS**

---

### Task 2: Labor Line Items in Sales Module (`src/sales.js`)

**Files:**
- Modify: `src/sales.js`
- Test: `tests/sales.test.js`

**Interfaces:**
- `createSale(db, { customer_name, customer_type, payment_method, items, discount, amount_paid })`:
  - If `item.item_type === 'labor'`, sets `unit_cost = 0.0`, `inventory_id = null`, does NOT deduct inventory stock.
  - If `item.item_type === 'part'`, deducts inventory stock as usual.

- [ ] **Step 1: Write failing test in `tests/sales.test.js` for Labor line items**
- [ ] **Step 2: Run `node --test tests/sales.test.js` to verify failure**
- [ ] **Step 3: Update `createSale` in `src/sales.js` to handle `item_type: 'labor'`**
- [ ] **Step 4: Run `node --test tests/sales.test.js` to verify PASS**

---

### Task 3: Warranty Returns & Defective RMA Module (`src/returns.js`)

**Files:**
- Create: `src/returns.js`
- Test: `tests/returns.test.js`

**Interfaces:**
- `createWarrantyReturn(db, { sale_id, sale_item_id, return_type, return_reason, replacement_inventory_id, notes })`:
  - Validates sale and item.
  - If `return_type === 'replacement'`, deducts 1 fresh item from inventory stock.
  - If `return_type === 'credit_refund'`, reduces customer's open credit balance.
  - Inserts into `warranty_returns`.
- `listWarrantyReturns(db, { search })`: lists all returns with customer & item info.
- `getWarrantyReturnDetails(db, id)`: returns full return slip info.

- [ ] **Step 1: Write tests in `tests/returns.test.js` for replacements and credit refunds**
- [ ] **Step 2: Run `node --test tests/returns.test.js` to verify failure**
- [ ] **Step 3: Implement `src/returns.js`**
- [ ] **Step 4: Run `node --test tests/returns.test.js` to verify PASS**

---

### Task 4: Analytics & Dashboard Update (`src/analytics.js`)

**Files:**
- Modify: `src/analytics.js`
- Test: `tests/analytics.test.js`

**Interfaces:**
- `getDashboardStats(db)`:
  - Adds `today_parts_revenue`, `today_labor_revenue`.
  - Adds `today_warranty_returns_count`, `today_refunded_total`.

- [ ] **Step 1: Update `tests/analytics.test.js` with assertions for parts vs labor revenue**
- [ ] **Step 2: Run `node --test tests/analytics.test.js` to verify failure**
- [ ] **Step 3: Update `src/analytics.js`**
- [ ] **Step 4: Run `node --test tests/analytics.test.js` to verify PASS**

---

### Task 5: Server REST Endpoints (`src/server.js`)

**Files:**
- Modify: `src/server.js`
- Test: `tests/server.test.js`

**Interfaces:**
- `POST /api/sales/:id/returns` -> `createWarrantyReturn`
- `GET /api/returns` -> `listWarrantyReturns`
- `GET /api/returns/:id` -> `getWarrantyReturnDetails`

- [ ] **Step 1: Write failing server route tests in `tests/server.test.js`**
- [ ] **Step 2: Run `node --test tests/server.test.js` to verify failure**
- [ ] **Step 3: Add routes in `src/server.js`**
- [ ] **Step 4: Run `node --test tests/server.test.js` to verify PASS**

---

### Task 6: Thermal Receipt & Slip Engine (`public/styles.css`, `public/index.html`)

**Files:**
- Modify: `public/styles.css`
- Modify: `public/index.html`

**Features:**
- Responsive `@media print` CSS supporting 58mm, 80mm, and auto paper widths.
- Itemized Parts vs. Labor display.
- Credit acknowledgement signature box (printed only when `credit_balance > 0`).
- Warranty policy footer with expiration date.
- Settings modal inputs for Warranty Days, Warranty Policy Text, and Receipt Width (58mm/80mm).

- [ ] **Step 1: Add thermal print CSS in `public/styles.css`**
- [ ] **Step 2: Add Settings modal fields in `public/index.html` for Warranty Policy & Paper Width**
- [ ] **Step 3: Add "+ Add Labor / Service" modal and "Warranty Return" modal in `public/index.html`**

---

### Task 7: Frontend Application Logic (`public/app.js`)

**Files:**
- Modify: `public/app.js`

**Features:**
- Quick "+ Add Labor / Service" popup with preset buttons (Screen install ₱300, Battery replace ₱200, Charging port ₱350, Diagnostics ₱150).
- Warranty eligibility checking (days elapsed vs `shopSettings.warranty_days`).
- Return / Replacement modal submission and Warranty Slip printout.
- High-contrast thermal print preview rendering.

- [ ] **Step 1: Implement Labor line item addition in Cart**
- [ ] **Step 2: Implement Thermal receipt rendering with signature line and warranty policy**
- [ ] **Step 3: Implement Warranty Return modal and submission**

---

### Task 8: End-to-End Test Verification (`tests/e2e.test.js`)

**Files:**
- Modify: `tests/e2e.test.js`

- [ ] **Step 1: Write complete end-to-end integration test (POS Part+Labor sale -> Thermal receipt -> Warranty Return)**
- [ ] **Step 2: Run `npm test` across all test suites**
- [ ] **Step 3: Verify all test suites pass with 100% success**
