# Technical Design Specification: POS Thermal Printing, Labor Fees & Warranty Returns

**Date:** 2026-08-26  
**Status:** In Review  
**Target:** Phone Repair & Parts POS (Production Business Deployment)  
**Architecture:** 0-Dependency Native Node.js (`node:http`) + SQLite (`node:sqlite`) + Vanilla JS Frontend  

---

## 1. Overview & Business Objectives

This specification covers three business-critical capabilities required for deployment in a live phone parts retail, wholesale, and repair workstation:

1. **Labor & Service Fee Line Items:** Charge repair installation/troubleshooting labor alongside parts at POS checkout, accounting for labor as 100% gross profit.
2. **Thermal Receipt Printing & Warranty Slips (58mm & 80mm):** High-density thermal printer formatting with customizable warranty policy text and customer credit acknowledgement signature lines.
3. **Defective Part Returns & Warranty Replacements (RMA):** Process warranty claims on past sales with inventory swaps (replacement screen) or credit balance adjustments.

---

## 2. Database Schema Changes

### 2.1 Modifications to `sale_items`
Support labor/service charges which do not decrement physical inventory stock.

```sql
ALTER TABLE sale_items ADD COLUMN item_type TEXT NOT NULL DEFAULT 'part'; -- 'part' | 'labor'
```
*Note: For `item_type = 'labor'`, `inventory_id` is `NULL` and `unit_cost` is `0.0`.*

### 2.2 New Table: `warranty_returns`
Tracks warranty return transactions, replacements, and defective RMA records.

```sql
CREATE TABLE IF NOT EXISTS warranty_returns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  return_code TEXT UNIQUE NOT NULL,
  sale_id INTEGER NOT NULL REFERENCES sales(id),
  sale_item_id INTEGER NOT NULL REFERENCES sale_items(id),
  customer_name TEXT NOT NULL,
  item_name TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1,
  return_type TEXT NOT NULL,         -- 'replacement' | 'credit_refund' | 'cash_refund'
  return_reason TEXT NOT NULL,       -- 'touch_dead_spots' | 'ghost_touch' | 'no_display' | 'battery_drain' | 'other'
  replacement_inventory_id INTEGER,  -- Linked inventory item if replacement was issued
  refund_amount REAL NOT NULL DEFAULT 0.0,
  technician_notes TEXT DEFAULT '',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### 2.3 Additions to `shop_settings`
New configurable keys seeded automatically:
- `receipt_paper_width`: `'80mm'` (options: `'58mm'`, `'80mm'`, `'auto'`)
- `warranty_days`: `'7'`
- `warranty_policy_text`: `'7 Days Test Warranty for LCDs & Batteries. Physical crack, flex tear, water damage, or removed warranty seal voids warranty.'`
- `shop_footer_note`: `'Thank you for your business! Please keep this receipt for warranty claims.'`

---

## 3. Component Details & Workflows

### 3.1 Labor & Service Fee (POS Counter)
- **UI:** A **"+ Add Labor / Service"** button in the POS Cart panel.
- **Input Modal / Row:**
  - Service preset buttons: `Screen Installation (₱300)`, `Battery Replacement (₱200)`, `Charging Port Fix (₱350)`, `Board Diagnostic (₱150)`, or Custom Title & Price.
- **Cart Handling:**
  - Rendered in cart with a distinct 🛠️ **Labor** badge.
  - Editable quantity and unit price.
- **Financial Calculation:**
  - `subtotal = sum(parts.total_price) + sum(labor.total_price)`
  - `profit = (subtotal - discount) - sum(parts.cost_price)` *(labor adds 0 cost, contributing 100% to profit)*.

### 3.2 Universal Thermal Printing (58mm / 80mm ESC/POS)
- **Printer Layout CSS (`@media print`):**
  - Dedicated thermal print container matching the selected paper width (`58mm` / `80mm`).
  - High-contrast black-and-white typography with crisp dividers (`- - - - -`).
  - Auto page margin zeroing: `@page { margin: 0; } body { margin: 0; }`.
- **Receipt Sections:**
  1. **Header:** Shop Name, Contact #, GCash Number, Receipt Number & Date/Time (local sync).
  2. **Customer Info:** Buyer Name, Contact, Price Tier (Retail / Technician).
  3. **Itemized Lines:** Distinguishes Parts vs. Labor.
  4. **Financials:** Subtotal, Discount, Total Due, Tendered / Paid, Change / Outstanding Utang.
  5. **GCash Reference #:** Displayed if paid via GCash.
  6. **Credit Agreement (Printed ONLY if payment is Credit / Utang):**
     ```text
     --------------------------------
          CREDIT ACKNOWLEDGEMENT
     I acknowledge receipt of goods and
     promise to pay the balance of:
     PHP [credit_balance] on or before:
     Date: ________________________
     Signature: ___________________
     --------------------------------
     ```
  7. **Warranty Policy Footer:**
     - Prints the shop's warranty terms and expiration date (`Purchase Date + warranty_days`).

### 3.3 Defective Returns & Warranty Replacement (RMA)
- **Initiation Points:**
  - Cashier clicks **"Warranty / Return"** on any invoice in **Sales History** or **Customer Ledger**.
- **Return Action Modal:**
  - Displays sale items with warranty eligibility badge (Calculates days elapsed vs. `warranty_days`).
  - Cashier selects item and selects **Action**:
    1. **🔄 Part Replacement:** Issues a fresh unit from inventory stock. Defective unit logged as defective for supplier RMA.
    2. **💰 Credit (Utang) Deduction:** Reduces customer's open credit balance by the returned item's value.
    3. **💵 Cash / GCash Refund:** Records cash payout for the return.
- **Slip Generation:**
  - Automatically generates and prints an itemized **Warranty Return & Replacement Slip**.

---

## 4. API Endpoints

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/sales/:id/returns` | Process a warranty return/replacement on a sale item |
| `GET` | `/api/returns` | List all warranty returns and supplier RMA logs |
| `GET` | `/api/returns/:id` | Get return slip details |
| `POST` | `/api/settings` | Save warranty policy, days, and paper width |

---

## 5. Analytics & Reporting Additions

The `/api/dashboard` analytics will include:
- **Parts Revenue vs. Labor Revenue** breakdown.
- **Total Warranty Returns Count & Replaced Value**.
- **Net Sales Revenue** after accounting for warranty refunds.

---

## 6. Testing & Quality Verification

1. **Labor Line Item Tests:** Verify labor creates sale with `item_type = 'labor'`, does not touch inventory stock, and yields 100% gross profit.
2. **Warranty Policy & Paper Width Settings:** Verify updating warranty days and 58mm/80mm preferences persist and render in thermal receipt HTML.
3. **Warranty Replacement Tests:** Verify replacing an LCD decrements 1 inventory stock and creates a warranty return record.
4. **Credit Return Deduction Tests:** Verify returning a part from a credit sale reduces the customer's credit balance properly.
5. **End-to-End Integration:** Full flow of POS counter sale (Part + Labor) -> Thermal Receipt -> 7-Day Warranty Return.
