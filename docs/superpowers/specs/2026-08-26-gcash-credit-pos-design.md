# Design Specification: GCash Payment Flow & Customer Credit (Utang) Management System

**Date:** 2026-08-26  
**Status:** Approved  
**Project:** Phone Parts POS & Credit Management (`phone-repair-pos`)

---

## 1. Overview & Objective

This specification details the transition of the offline POS system from a repair-ticket-focused system into a streamlined **Parts POS with Customer Credit (Utang) & GCash Flow**.

Key goals:
1. **GCash Payment Flow:** Seamless counter payment via QR code display, account detail presentation, and GCash transaction reference number recording.
2. **Customer / Buyer Name & Discount at POS:** Capture the buyer's name (with auto-completion) and discount directly at the POS counter before completing a sale.
3. **Credit (Utang) Management:** Replace the Repair Tickets module with a comprehensive Credit / Customer Ledger that tracks outstanding debts, partial downpayments, purchase history, and payment settlements (via Cash/GCash).
4. **Zero-Dependency & Offline-First:** Maintain the 100% dependency-free Node.js + SQLite architecture.

---

## 2. Database Schema Design

### 2.1 Modifications to `sales` Table
Add customer tracking, GCash reference, and credit balance columns:
```sql
CREATE TABLE IF NOT EXISTS sales (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_code TEXT UNIQUE NOT NULL,
  customer_name TEXT NOT NULL DEFAULT 'Walk-in Customer',
  customer_phone TEXT DEFAULT '',
  customer_type TEXT NOT NULL DEFAULT 'retail', -- 'retail' or 'technician'
  payment_method TEXT NOT NULL DEFAULT 'cash', -- 'cash', 'gcash', 'credit', 'transfer'
  payment_reference TEXT DEFAULT '', -- GCash/Transfer reference number
  subtotal REAL NOT NULL,
  discount REAL NOT NULL DEFAULT 0.0,
  total_amount REAL NOT NULL,
  amount_paid REAL NOT NULL,
  change_amount REAL NOT NULL DEFAULT 0.0,
  credit_balance REAL NOT NULL DEFAULT 0.0, -- max(0, total_amount - amount_paid)
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### 2.2 New `credit_payments` Table
Records payments made by customers to settle outstanding credit balances:
```sql
CREATE TABLE IF NOT EXISTS credit_payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_name TEXT NOT NULL,
  amount_paid REAL NOT NULL,
  payment_method TEXT NOT NULL DEFAULT 'cash', -- 'cash', 'gcash', 'transfer'
  payment_reference TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### 2.3 New `shop_settings` Table
Key-value configuration for GCash and shop branding:
```sql
CREATE TABLE IF NOT EXISTS shop_settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
```

### 2.4 Removal of Repair Tables
The tables `repair_tickets` and `repair_parts` are retired and removed from active use.

---

## 3. Backend API Architecture

### 3.1 Sales Endpoints (`/api/sales`)
- `POST /api/sales`:
  - Payload: `{ customer_name, customer_phone, customer_type, payment_method, payment_reference, items, discount, amount_paid }`
  - Validates stock and calculates subtotal, total after discount, change amount, and credit balance (`Math.max(0, total_amount - amount_paid)`).
  - Deducts inventory stock atomically inside an SQLite transaction.
  - Inserts sale and sale items.
- `GET /api/sales`:
  - Returns sales history with customer names, payment methods, reference numbers, and credit balances.

### 3.2 Customer & Credit Endpoints (`/api/customers`)
- `GET /api/customers`:
  - Aggregates unique customer names across sales and credit payments.
  - Returns for each customer:
    - `customer_name`, `customer_phone`
    - `total_purchases` (sum of total_amount across all sales)
    - `total_spent_paid` (sum of amount_paid + total credit_payments)
    - `total_credit_balance` (sum of remaining credit balances)
    - `status`: `'active_credit'` if total_credit_balance > 0 else `'clean'`
- `GET /api/customers/:name`:
  - Returns detailed history:
    - Summary stats
    - Sales list (receipts, items bought, payment method, initial credit)
    - Credit payments list (settlements made)
- `POST /api/customers/:name/settle-credit`:
  - Payload: `{ amount_paid, payment_method, payment_reference, notes }`
  - Records a settlement in `credit_payments`.
  - Distributes the payment across open sales with `credit_balance > 0` in FIFO order (oldest debt paid first) until the amount is exhausted.

### 3.3 Settings Endpoints (`/api/settings`)
- `GET /api/settings`: Returns current shop configuration (GCash name, GCash number, QR image path).
- `POST /api/settings`: Updates shop configuration keys.

---

## 4. Frontend UI/UX Design

### 4.1 Header Navigation
Replace the **Repair Tickets** tab with **Customer Credits**:
1. **POS Counter** (`tab-pos`)
2. **Customer Credits** (`tab-credits`) — displays a badge showing total active debtor count (e.g. `🔴 3`)
3. **Inventory** (`tab-inventory`)
4. **Sales History** (`tab-sales`)
5. **Reports** (`tab-dashboard`)

### 4.2 POS Counter (Main Tab)
1. **Buyer Name Input:**
   - Text input `Buyer / Customer Name` (default placeholder: `Walk-in Customer`).
   - Integrated datalist / dropdown autocomplete showing existing customer names.
2. **Pricing Tier & Discount:**
   - Retail vs. Wholesale/Technician toggle button.
   - Prominent Discount input field (₱ currency amount).
3. **Payment Method Selector:**
   - `Cash` | `GCash` | `Credit (Utang)` | `Transfer`.
4. **GCash Scan Card & Reference Field:**
   - When `GCash` is selected, an on-screen preview card appears showing:
     - Shop GCash QR image (clickable for full-screen modal).
     - GCash Account Name & Mobile Number.
     - Exact Amount Due in bold emerald font.
   - Input for `GCash Reference #` (e.g., `1002 9384 1920`).
5. **Credit (Utang) Flow:**
   - When `Credit (Utang)` is selected, `Cash Tendered` changes to `Initial Downpayment (₱)` (default ₱0).
   - Display shows `Credit to Record: ₱X,XXX.00`.
   - Buyer name is required when buying on credit (prevents anonymous credit).

### 4.3 Customer Credits (Utang) Tab
1. **Metric Overview Cards:**
   - Total Outstanding Utang (₱)
   - Customers with Active Debt
   - Total Debt Collected Today (₱)
2. **Customer Directory & Search:**
   - Search bar by name/phone.
   - Filter chips: `All Customers`, `Has Credit Only`, `Fully Paid`.
   - Card / Table layout showing Customer Name, Total Sales, Current Debt Balance, and Status Badge (🔴 Active Credit / 🟢 No Credit).
3. **Customer Ledger Modal (History & Settlement):**
   - Click customer to open ledger modal:
     - Header: Customer Name, Phone, and Current Balance in large font.
     - **Tab 1: Purchases:** Chronological list of all sales, items purchased, totals, and initial payment methods.
     - **Tab 2: Payment History:** All settlement payments made against credit balances.
     - **"Accept Payment / Settle Utang" Action Box:**
       - Quick Pay Full Balance button.
       - Custom Amount input.
       - Payment method selector (`Cash` or `GCash` with Reference #).
       - Instantly reduces balance and generates settlement receipt.

### 4.4 Settings & GCash QR Management
- Settings modal to update:
  - GCash Name (e.g., *TechParts Repair & Parts*)
  - GCash Mobile Number (e.g., *0917-888-9999*)
  - Upload or select GCash QR image.

---

## 5. Verification & Testing Plan

1. **Unit & Integration Tests:**
   - `tests/sales.test.js`: Create sales with Cash, GCash (with reference #), and Credit (full utang and partial downpayment).
   - `tests/credits.test.js`: Customer balance aggregation, FIFO debt settlement, partial credit payments, and multi-sale reconciliation.
2. **UI End-to-End Flow Validation:**
   - Complete a POS sale with GCash, verify QR preview and reference number saving.
   - Complete a POS sale on Credit for "John Doe" with ₱500 downpayment on a ₱2,000 order.
   - Open Customer Credits tab, verify "John Doe" appears with ₱1,500 active credit.
   - Settle ₱1,500 with GCash (Ref # 998877), verify status changes to 🟢 "No Credit / Paid in full".
   - Verify Sales History and Dashboard accurately reflect cash/gcash totals and credit collections.
