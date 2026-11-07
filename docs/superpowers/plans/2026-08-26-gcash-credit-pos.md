# Implementation Plan: GCash Payment Flow & Customer Credit (Utang) Management

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement GCash QR payment & reference tracking, replace Repair Tickets with a Customer Credit (Utang) ledger system, and add Buyer Name tracking & prominent Discounts at POS checkout.

**Architecture:** Node.js built-in HTTP server with zero external dependencies and SQLite database (`node:sqlite`). Enhanced `sales` schema to track buyer names, reference numbers, and credit balances; new `credit_payments` and `shop_settings` tables; new `credits.js` ledger module; and an interactive vanilla JS/Tailwind UI for POS GCash QR modals and Customer Credit management.

**Tech Stack:** Node.js (v22+ with `node:sqlite`), Vanilla JavaScript (ES6+), Tailwind CSS, Lucide Icons.

## Global Constraints

- Zero external runtime npm dependencies (keep package.json 0-dep, using Node.js built-in modules).
- 100% offline-first functionality.
- Atomic SQLite transactions for stock adjustments and credit settlements.
- Clean removal of `repairs.js` and repair ticket UI/tests.

---

### Task 1: Database Schema Migration (`src/db.js`)

**Files:**
- Modify: `src/db.js`
- Test: `tests/db.test.js`

**Interfaces:**
- `initDb(dbFilePath)`: Creates updated `inventory`, `sales`, `sale_items`, `credit_payments`, and `shop_settings` tables. Removes `repair_tickets` and `repair_parts`.

- [ ] **Step 1: Write the updated database schema test**

Create/update `tests/db.test.js` to assert `sales` has `customer_name`, `customer_phone`, `payment_reference`, `credit_balance` and that `credit_payments` and `shop_settings` tables exist.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/db.test.js`
Expected: FAIL due to missing columns/tables.

- [ ] **Step 3: Update `src/db.js` schema**

Update `initDb` in `src/db.js` with new columns in `sales`, new tables `credit_payments` and `shop_settings`, and remove `repair_tickets`/`repair_parts`. Seed default shop settings (`gcash_name`, `gcash_number`, `gcash_qr_url`).

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/db.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/db.js tests/db.test.js
git commit -m "feat(db): update schema for sales credit, credit_payments, and shop_settings"
```

---

### Task 2: Sales Module Enhancement (`src/sales.js`)

**Files:**
- Modify: `src/sales.js`
- Test: `tests/sales.test.js`

**Interfaces:**
- `createSale(db, { customer_name, customer_phone, customer_type, payment_method, payment_reference, items, discount, amount_paid })`
- `listSales(db, { limit, offset, search, payment_method })`
- `getSaleDetails(db, saleId)`

- [ ] **Step 1: Write tests for enhanced sales with GCash & Credit**

Update `tests/sales.test.js` to test:
1. Cash sale with discount.
2. GCash sale with `payment_reference`.
3. Credit sale with partial downpayment, verifying `credit_balance = total_amount - amount_paid`.
4. Full credit sale with ₱0 downpayment.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/sales.test.js`
Expected: FAIL

- [ ] **Step 3: Update `src/sales.js`**

Support `customer_name`, `customer_phone`, `payment_reference`, `credit_balance`, `discount` in `createSale` and `listSales`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/sales.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/sales.js tests/sales.test.js
git commit -m "feat(sales): add customer name, gcash ref, discount, and credit balance to sales"
```

---

### Task 3: Customer Credit (Utang) Ledger Module (`src/credits.js`)

**Files:**
- Create: `src/credits.js`
- Create: `tests/credits.test.js`

**Interfaces:**
- `listCustomers(db, { search = '', filter = '' })`: returns customer summaries (total_purchases, total_paid, credit_balance, status).
- `getCustomerDetails(db, customerName)`: returns sales list, payment history, and credit balance.
- `settleCustomerCredit(db, { customer_name, amount_paid, payment_method, payment_reference, notes })`: records credit payment and reduces open sales' `credit_balance` via FIFO.
- `getShopSettings(db)` & `updateShopSettings(db, key, value)`

- [ ] **Step 1: Write unit tests in `tests/credits.test.js`**

Test customer aggregation, credit balance calculation, FIFO debt settlement, and full vs partial payments.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/credits.test.js`
Expected: FAIL (module missing)

- [ ] **Step 3: Implement `src/credits.js`**

Implement `listCustomers`, `getCustomerDetails`, `settleCustomerCredit`, `getShopSettings`, `updateShopSettings`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/credits.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/credits.js tests/credits.test.js
git commit -m "feat(credits): add customer credit ledger and settlement logic"
```

---

### Task 4: Analytics & Server REST API Updates (`src/analytics.js`, `src/server.js`)

**Files:**
- Modify: `src/analytics.js`
- Modify: `src/server.js`
- Delete: `src/repairs.js`, `tests/repairs.test.js`
- Modify: `tests/analytics.test.js`, `tests/server.test.js`, `tests/e2e.test.js`

**Interfaces:**
- Endpoints:
  - `GET /api/customers`
  - `GET /api/customers/:name`
  - `POST /api/customers/:name/settle-credit`
  - `GET /api/settings`
  - `POST /api/settings`
- Analytics: `totalCreditOutstanding`, `totalDebtorsCount`, `gcashSalesTotal`, `cashSalesTotal`.

- [ ] **Step 1: Write failing tests for analytics & API endpoints**

Update `tests/analytics.test.js`, `tests/server.test.js`, `tests/e2e.test.js`.

- [ ] **Step 2: Run tests to verify failure**

Run: `node --test tests/analytics.test.js tests/server.test.js`
Expected: FAIL

- [ ] **Step 3: Implement analytics and server routes, delete repairs**

Update `src/analytics.js` and `src/server.js`. Remove `src/repairs.js` and `tests/repairs.test.js`.

- [ ] **Step 4: Run all backend tests**

Run: `npm test`
Expected: PASS (all tests passing)

- [ ] **Step 5: Commit**

```bash
git add src/analytics.js src/server.js tests/ src/credits.js
git rm src/repairs.js tests/repairs.test.js
git commit -m "feat(api): connect credit endpoints, analytics, and remove repairs module"
```

---

### Task 5: Frontend UI - POS GCash QR & Buyer Name Integration (`public/index.html`, `public/app.js`)

**Files:**
- Modify: `public/index.html`
- Modify: `public/app.js`

**Interfaces:**
- POS Counter UI with Buyer Name input, Discount field, Payment Method toggle (`Cash`, `GCash`, `Credit`, `Transfer`).
- GCash QR Preview Card & Reference Number input.
- Credit / Utang calculation display.

- [ ] **Step 1: Update HTML for POS counter & Payment Methods**

Add Buyer Name input (with `<datalist>` for customer autocomplete), payment method selector buttons (`cash`, `gcash`, `credit`, `transfer`), GCash scan panel + reference field, and credit downpayment indicator in `public/index.html`.

- [ ] **Step 2: Implement POS JS logic in `public/app.js`**

Implement payment method switching, GCash QR preview rendering with shop settings, reference number validation, credit mode handling, and customer datalist auto-refresh.

- [ ] **Step 3: Verify POS sale with Cash, GCash, and Credit**

Manually/programmatically test creating sales with various payment modes.

---

### Task 6: Frontend UI - Customer Credits (Utang) Ledger & Settings Modal (`public/index.html`, `public/app.js`)

**Files:**
- Modify: `public/index.html`
- Modify: `public/app.js`

**Interfaces:**
- Customer Credits Tab (replaces Repairs tab) with overview metrics, customer search & filters, customer status badges.
- Customer Ledger Modal: Purchase history, credit payment history, and "Settle Credit" payment form (Cash / GCash).
- Shop Settings Modal: GCash Name, Mobile Number, QR image URL.

- [ ] **Step 1: Replace Repairs Tab with Customer Credits Tab in HTML**

Build credit metrics cards, customer list table/cards, customer ledger modal, and payment settings modal in `public/index.html`.

- [ ] **Step 2: Implement Credits JS logic in `public/app.js`**

Add `loadCustomers()`, `openCustomerLedger(name)`, `settleCredit()`, `openSettingsModal()`, `saveSettings()`, and active debtors badge counter.

- [ ] **Step 3: Test complete end-to-end user experience**

Run `npm test` and launch server to test UI workflows end-to-end.

- [ ] **Step 4: Commit**

```bash
git add public/index.html public/app.js
git commit -m "feat(ui): implement GCash QR flow, customer credit ledger tab, and settings"
```
