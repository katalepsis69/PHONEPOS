# Design Specification: Unbloated Straight POS Repair Flow

**Date:** 2026-09-05  
**Topic:** Unbloated Straight POS Repair Flow (Unified 2-Column Register)  
**Status:** Validated & Approved  

---

## 1. Overview & Problem Statement

The previous repair intake flow functioned as a 4-step wizard:
`Step 1: Device` → `Step 2: Services` → `Step 3: Parts` → `Step 4: Review & Pay`

This structure created unnecessary page transitions, click barriers, and cognitive load for counter technicians. Furthermore, phone repairs in this shop do not require separate catalog services/labor fees—all billable lines are parts and hardware replacements from inventory.

The goal is to replace the multi-step wizard with a **pure, unbloated, single-screen 2-column POS register**:
- **Left Column**: Slim Device & Customer intake header + instant compatible parts shelf and search.
- **Right Column**: Live ticket line items + totals + direct payment panel with **Complete & Print (F9)**.
- **Tiers**: Simplified to **Retail** and **Wholesale** pricing.
- **Scope**: Parts only; separate labor subsystem completely removed.

---

## 2. Layout & UI Structure

### 2.1 Workspace Grid
The main POS counter (`#view-pos`) uses a fixed 2-column layout:
- **Left Pane (`.counter__main`)**: Intake strip on top, parts catalog shelf beneath.
- **Right Pane (`.counter__side`)**: Ticket summary and checkout panel, permanently visible.

```
┌──────────────────────────────────────────────────────────┬────────────────────────┐
│ LEFT: INTAKE & PARTS CATALOG                             │ RIGHT: TICKET & PAY    │
├──────────────────────────────────────────────────────────┤                        │
│ [ Slim Intake Bar ]                                      │ [ RO-###### ] [Hold]   │
│ Device: [ Search/type model ] [ IMEI (opt) ]             │ Device: iPhone 11      │
│ Customer: [ Name (opt) ] [ Phone (opt) ]                 │ Cust: Walk-in          │
├──────────────────────────────────────────────────────────┼────────────────────────┤
│ [ Tier: Retail | Wholesale ]  [ Search parts / barcode ] │ [ Ticket Line Items ]  │
│ [ Category Filter: All / LCD / Battery / Port ]          │ • iPhone 11 LCD   x1   │
│                                                          │   ₱1,400.00   [-] [+] [x]  │
│ Compatible Parts Shelf:                                  │                        │
│ ┌──────────────────────────────────────────────┐         ├────────────────────────┤
│ │ iPhone 11 Incell LCD Screen    Stock: 6  [+ Add] │     │ Subtotal:    ₱1,400.00 │
│ │ iPhone 11 Battery High Cap     Stock: 8  [+ Add] │     │ Discount (₱): [      0]│
│ │ iPhone 11 Charging Port Flex   Stock: 3  [+ Add] │     │ Total Due:   ₱1,400.00 │
│ └──────────────────────────────────────────────┘         ├────────────────────────┤
│                                                          │ [Cash] [GCash] [Utang] │
│                                                          │ Tendered: [ 1500.00 ]  │
│                                                          │ Change:     ₱100.00    │
│                                                          │ [Complete & Print (F9)]│
└──────────────────────────────────────────────────────────┴────────────────────────┘
```

### 2.2 Left Pane: Intake Strip (`#repair-intake-bar`)
A compact top bar occupying ~10-15% of vertical space:
- **Device Field**: `<input id="repair-device-input" list="device-datalist">`
  - Offers autocomplete suggestions from distinct `model_name` values in inventory.
  - Allows typing custom unlisted models directly without switching modes.
- **IMEI / Serial Field**: `<input id="repair-imei">` with barcode scan button. Optional.
- **Customer Name & Phone**: Inline fields (`#pos-customer-name`, `#pos-customer-phone`). Auto-populates existing customer balance badge if known. Optional.

### 2.3 Left Pane: Parts Shelf (`#repair-parts-shelf`)
- **Controls Row**:
  - Price Tier Segmented Toggle: **Retail** | **Wholesale** (updates unit prices immediately).
  - Search Input: Fast search by part name, SKU, or barcode scanner (`Enter` adds top match).
  - Category Select: Filter by part type (All, LCD, Battery, Charging Port, Accessories).
  - In-Stock Toggle: Checkbox to hide zero-stock items.
- **Parts Table / Grid**:
  - Displays compatible parts for the chosen device at the top.
  - Each item shows: Part Name, Category, Price (Retail or Wholesale based on active tier), Stock Count badge, and a prominent `+ Add` button.
  - If no device is selected, displays all inventory parts.

### 2.4 Right Pane: Ticket & Direct Checkout
- **Header**: Order reference (`RO-######`), active device chip, and `Hold Job` button.
- **Line Items List**:
  - Compact row per item: Part name, unit price, quantity with `[-]` and `[+]` touch/click targets, line total, and delete `[x]`.
- **Totals**:
  - Subtotal (sum of line totals).
  - Discount input (flat pesos).
  - Total Due.
- **Embedded Payment Block**:
  - Method selector tabs: **Cash** (default), **GCash**, **Credit (Utang)**, **Transfer**.
  - Cash panel: Cash tendered input, quick increment chips (`+50`, `+100`, `+500`, `+1000`, `Exact`), and live Change calculation.
  - GCash panel: QR code modal launcher, GCash phone/name, and reference number field.
  - Credit panel: Utang note, downpayment input, remaining balance calculation.
  - Action button: **Complete & Print (F9)**.

---

## 3. Data Flow & State Transitions

### 3.1 State Representation
```javascript
const posState = {
  ref: "RO-260905-001",
  tier: "retail", // "retail" | "wholesale"
  device: "", // Model name string
  imei: "",
  customer: {
    name: "",
    phone: "",
    customerId: null
  },
  note: "",
  cart: [
    // { id, sku, name, brand, model_name, part_type, price, qty, stock_quantity }
  ],
  discount: 0,
  payment: {
    method: "cash", // "cash" | "gcash" | "credit" | "transfer"
    tendered: 0,
    reference: "",
    downpayment: 0
  }
};
```

### 3.2 Price Tier Logic
- `tier === 'retail'`: Prices drawn from `inventory.price_retail`.
- `tier === 'wholesale'`: Prices drawn from `inventory.price_technician` (existing backend database column).
- Changing tier recalculates both the shelf display prices and existing cart items in real time.

### 3.3 Adding & Updating Cart Items
- Adding an item: If item already exists in `cart`, increment `qty` (bounded by available stock if enforced). Otherwise, push item with `qty = 1`.
- Removing an item: Click `[x]` or decrement `qty` to 0.
- Live Totals: Recomputed on every cart modification and discount input event.

### 3.4 Checkout Flow
1. Counter clerk presses `F9` or clicks `Complete & Print`.
2. Validation:
   - `cart.length > 0` (cannot submit empty ticket).
   - If `cash`: `tendered >= totalDue` (unless explicitly allowed partial).
   - If `credit`: `customer.name.trim().length > 0` required.
3. Payload sent to `POST /api/sales`:
   - `customer_type`: `'retail'` or `'technician'` (for wholesale tier).
   - `items`: `[{ inventory_id, quantity, unit_price }]`.
   - `payment_method`, `amount_paid`, `reference_no`, `notes`.
4. Backend deducts inventory stock, updates sales records and customer credit if applicable.
5. Frontend prints thermal receipt and resets the register state for the next customer.

---

## 4. Deletions & Refactoring (Ponytail / YAGNI Principle)

The following components and code paths are deleted:
1. `<nav class="steps">` (#step-btn-1 through #step-btn-4) and stepper progress indicator.
2. `goToStep()` and `updateStepper()` functions.
3. Giant 16-card device grid (`#device-grid`) and brand filter pills.
4. `#section-services` panel, labor lists (`#svc-list`), service tab filters (`popular`, `all`, `checks`), and custom labor modal (`openAddLaborModal()`).
5. Stage switching logic between `#stage-order` and `#stage-pay`.
6. Navigation footers ("Continue to Services", "Continue to Parts", "Review & Proceed").
7. Internal references to "tech" pricing updated to "wholesale" across the UI.

---

## 5. Keyboard & POS Hardware Integration
- **F1**: Reset register / Start new repair order.
- **F9**: Complete sale and trigger thermal receipt print.
- **Ctrl+K / / (slash)**: Focus parts search bar.
- **Barcode Scanner**: Scanner inputs with trailing Enter key directly match SKU/barcode in the search field and append the item to cart.

---

## 6. Verification Plan

### 6.1 Functional Testing
1. **Device Autocomplete**: Type "iPhone 11", verify shelf displays iPhone 11 parts first.
2. **Parts Search & 1-Click Add**: Search "battery", click `+ Add`, verify line item appears in cart with correct retail price.
3. **Wholesale Tier Toggle**: Click "Wholesale", verify shelf prices and cart item prices switch to technician/wholesale rates.
4. **Checkout (Cash)**: Enter tendered cash, verify change calculation, hit `F9`, verify sale completes and receipt prints.
5. **Checkout (Utang)**: Select Credit, verify validation blocks checkout without customer name, enter name and verify credit recorded.
6. **Held Jobs**: Click "Hold job", start new order, verify "Held job" chip restores cart and customer details.

### 6.2 Regression Testing
- Verify inventory management view (`F3`), customer credits view, sales history (`F8`), and reports remain fully functional.
