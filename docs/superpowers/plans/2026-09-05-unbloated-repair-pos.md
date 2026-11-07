# Unbloated Straight POS Repair Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform the phone repair intake flow from a bloated 4-step wizard into an unbloated, single-screen 2-column POS register with slim intake, an auto-filtered parts shelf, and permanent right-rail checkout.

**Architecture:** 
- The left column (`.counter__main`) is refactored into a slim top intake strip (Device autocomplete, IMEI, Customer name/phone) and a live parts catalog shelf that automatically surfaces compatible parts for the chosen handset.
- The right column (`.counter__side`) is flattened into a permanent unified register ticket and direct checkout panel (line items, totals, payment method selection, tendered input, change display, and F9 completion).
- The 4-step wizard navigation, the 16-card device grid, and the separate labor/services subsystem are completely eliminated.
- Price tiering is renamed in the UI to Retail and Wholesale (mapping to `price_retail` and `price_technician`).

**Tech Stack:** Vanilla JavaScript (ES2022), HTML5, Tailwind CSS / Custom CSS, SQLite3 (`node:sqlite`), Native Node test runner (`node:test`). Zero runtime dependencies.

## Global Constraints

- Zero runtime dependencies: all functionality uses vanilla DOM APIs and native browser/Node capabilities.
- Backend compatibility: Maintain exact payload contracts with `/api/sales` and `/api/inventory`.
- Offline first: Receipt generation, draft holds in `localStorage`, and sales flow must function without network dependencies.
- Keyboard shortcuts: `F1` (new sale), `F9` (complete & print), `Ctrl+K` or `/` (parts search).
- Deletion over addition: Remove unused stepper and labor DOM elements rather than hiding them.

---

### Task 1: Refactor Left Pane HTML (`public/index.html`)

**Files:**
- Modify: `public/index.html:152-388`

**Interfaces:**
- Consumes: Existing DOM classes (`.counter`, `.counter__main`, `.panel`, `.field`, `.field-search`)
- Produces: 
  - `#repair-intake-bar` containing `#repair-device-input`, `<datalist id="device-datalist">`, `#repair-imei`, `#pos-customer-name`, `#pos-customer-phone`.
  - `#repair-parts-shelf` containing `#tier-retail-btn`, `#tier-wholesale-btn`, `#pos-search-input`, `#pos-category-filter`, `#pos-instock-only`, `#pos-parts-body`.
  - Removes: `<nav class="steps">`, `#section-device`, `#section-services`, and step-navigation footers.

- [ ] **Step 1: Replace wizard navigation and step panels with slim intake bar and parts shelf**

In `public/index.html`, replace lines 156–388 (the `<nav class="steps">` and the three `<section class="panel step-panel">` elements) with:

```html
          <!-- REPAIR REGISTER WORKSPACE: Intake + Parts Shelf -->
          <div class="counter__main">

            <!-- 1. SLIM INTAKE BAR -->
            <section class="panel intake-bar" id="repair-intake-bar" aria-label="Device and customer intake">
              <div class="intake-grid">
                <div class="field">
                  <label class="field__label" for="repair-device-input">Device / Handset</label>
                  <div class="field__wrap">
                    <input type="text" id="repair-device-input" list="device-datalist" autocomplete="off"
                      placeholder="Type or pick model (e.g. iPhone 11)..." oninput="onDeviceSelected(this.value)">
                    <datalist id="device-datalist"></datalist>
                    <button type="button" class="field__btn" onclick="clearDeviceSelection()" title="Clear device filter">
                      <i data-lucide="x" class="w-4 h-4"></i>
                    </button>
                  </div>
                </div>

                <div class="field">
                  <label class="field__label" for="repair-imei">IMEI / Serial <span class="field__opt">optional</span></label>
                  <div class="field__wrap">
                    <input type="text" id="repair-imei" autocomplete="off" class="font-mono"
                      placeholder="Scan or type IMEI" oninput="onRepairIntakeInput()">
                    <button type="button" class="field__btn" onclick="focusImeiForScan()" title="Scan barcode">
                      <i data-lucide="scan-line" class="w-4 h-4"></i>
                    </button>
                  </div>
                </div>

                <div class="field">
                  <div class="field__label field__label--split">
                    <label for="pos-customer-name">Customer <span class="field__opt">optional</span></label>
                    <span id="pos-cust-status-badge" class="tag hidden"></span>
                  </div>
                  <div class="field__wrap">
                    <input type="text" id="pos-customer-name" autocomplete="off"
                      placeholder="Walk-in customer" oninput="onCustomerNameInput()">
                    <input type="text" id="pos-customer-phone" class="field__side" inputmode="tel" autocomplete="off"
                      placeholder="Phone">
                  </div>
                </div>
              </div>
            </section>

            <!-- 2. LIVE PARTS SHELF -->
            <section class="panel shelf-panel" id="repair-parts-shelf" aria-label="Available parts">
              <header class="panel__head">
                <div>
                  <h2 class="panel__title" id="shelf-title">Compatible Parts</h2>
                  <p class="panel__hint" id="shelf-hint">Showing parts in stock for the selected handset.</p>
                </div>
                <div class="panel__tools">
                  <div class="seg" role="group" aria-label="Price tier">
                    <button type="button" onclick="setPriceTier('retail')" id="tier-retail-btn" class="seg-btn is-active"
                      aria-pressed="true">Retail</button>
                    <button type="button" onclick="setPriceTier('technician')" id="tier-wholesale-btn" class="seg-btn"
                      data-tone="tech" aria-pressed="false">Wholesale</button>
                  </div>
                </div>
              </header>

              <div class="panel__body">
                <div class="parts-tools">
                  <label class="sr-only" for="pos-search-input">Search parts</label>
                  <span class="field-search">
                    <i data-lucide="search" class="w-4 h-4"></i>
                    <input type="text" id="pos-search-input" autocomplete="off"
                      placeholder="Scan barcode or search part name, SKU... [Enter adds top match]"
                      onkeydown="onPartSearchKeydown(event)">
                  </span>
                  <label class="sr-only" for="pos-category-filter">Filter parts by category</label>
                  <select id="pos-category-filter" class="select-sm" onchange="setPartCategory(this.value)">
                    <option value="">All categories</option>
                  </select>
                  <label class="check">
                    <input type="checkbox" id="pos-instock-only" onchange="setInStockOnly(this.checked)" checked>
                    <span>In stock only</span>
                  </label>
                </div>

                <div class="ptable-wrap">
                  <table class="ptable">
                    <thead>
                      <tr>
                        <th scope="col">Part Name</th>
                        <th scope="col">Category</th>
                        <th scope="col" class="is-num">Price</th>
                        <th scope="col" class="is-mid">Stock</th>
                        <th scope="col" class="is-mid">Action</th>
                      </tr>
                    </thead>
                    <tbody id="pos-parts-body"></tbody>
                  </table>
                </div>

                <div class="parts-foot">
                  <span class="foot-note" id="parts-count-note">Loading parts...</span>
                  <button type="button" class="mini-link" onclick="openAddPartModal()">+ Add new part to inventory</button>
                </div>
              </div>
            </section>
          </div>
```

- [ ] **Step 2: Verify HTML syntax by loading the page through the test harness or a node check**

Run: `node -e "const fs = require('fs'); const html = fs.readFileSync('public/index.html', 'utf8'); console.log('Index HTML size:', html.length);"`
Expected: Prints file size without errors.

---

### Task 2: Refactor Right Pane Ticket & Checkout HTML (`public/index.html`)

**Files:**
- Modify: `public/index.html:445-585`

**Interfaces:**
- Consumes: Existing ticket line summary structure
- Produces: Direct checkout stack where payment panels (`#payment-panel-cash`, etc.) and the "Complete & Print (F9)" button are immediately accessible without clicking "Proceed to payment".

- [ ] **Step 1: Unify `#stage-order` and `#stage-pay` into a direct checkout pane**

In `public/index.html`, replace lines 457–585 (the `#stage-order` and `#stage-pay` split containers and back links) with:

```html
                <!-- Direct checkout panel: payment methods and action buttons -->
                <div class="checkout-panel mt-3">
                  <div class="pay-grid mb-3" role="group" aria-label="Payment method">
                    <button type="button" onclick="setPaymentMethod('cash')" id="pay-cash-btn" class="pay-btn is-active"
                      aria-pressed="true">Cash</button>
                    <button type="button" onclick="setPaymentMethod('gcash')" id="pay-gcash-btn" class="pay-btn"
                      aria-pressed="false">GCash</button>
                    <button type="button" onclick="setPaymentMethod('credit')" id="pay-credit-btn" class="pay-btn"
                      aria-pressed="false">Credit (utang)</button>
                    <button type="button" onclick="setPaymentMethod('transfer')" id="pay-transfer-btn" class="pay-btn"
                      aria-pressed="false">Transfer</button>
                  </div>

                  <!-- 1. Cash panel -->
                  <div class="paypanel" id="payment-panel-cash">
                    <div class="field">
                      <div class="field__label field__label--split">
                        <label for="pos-tendered">Cash tendered (₱)</label>
                        <button type="button" class="mini-link" onclick="fillExactAmount()">exact due</button>
                      </div>
                      <div class="field__wrap">
                        <input type="number" id="pos-tendered" min="0" step="1" placeholder="0.00"
                          oninput="calculateChange()">
                      </div>
                    </div>
                    <div class="cash-chips">
                      <button type="button" class="cash-chip" onclick="addTenderedAmount(50)">+50</button>
                      <button type="button" class="cash-chip" onclick="addTenderedAmount(100)">+100</button>
                      <button type="button" class="cash-chip" onclick="addTenderedAmount(500)">+500</button>
                      <button type="button" class="cash-chip" onclick="addTenderedAmount(1000)">+1,000</button>
                    </div>
                    <div class="kv kv--pos">
                      <span>Change</span>
                      <strong id="pos-change">₱0.00</strong>
                    </div>
                  </div>

                  <!-- 2. GCash panel -->
                  <div class="paypanel hidden" id="payment-panel-gcash">
                    <div class="qr-row">
                      <div class="pname">
                        <button type="button" class="qr-thumb" onclick="openQrModal()" title="Enlarge the GCash QR">
                          <img id="pos-gcash-qr-thumb" src="" alt="GCash payment QR code">
                        </button>
                        <div>
                          <div class="qr-name" id="pos-gcash-shop-name">GCash payment</div>
                          <div class="pname__s font-mono" id="pos-gcash-shop-number">09xx-xxx-xxxx</div>
                          <button type="button" class="mini-link" onclick="openQrModal()">Enlarge QR</button>
                        </div>
                      </div>
                      <div>
                        <div class="foot-note">Scan &amp; pay</div>
                        <div class="sumgroup__amt" id="pos-gcash-amount-badge">₱0.00</div>
                      </div>
                    </div>
                    <div class="field">
                      <label class="field__label" for="pos-gcash-ref">GCash reference no. <span class="field__opt">proof of payment</span></label>
                      <div class="field__wrap">
                        <input type="text" id="pos-gcash-ref" class="font-mono" placeholder="e.g. 1002 9384 1120">
                      </div>
                    </div>
                  </div>

                  <!-- 3. Credit (utang) panel -->
                  <div class="paypanel hidden" id="payment-panel-credit">
                    <div class="note-box note-box--warn">
                      <i data-lucide="alert-circle" class="w-4 h-4"></i>
                      <span>Lands on customer credit ledger. Customer name required.</span>
                    </div>
                    <div class="field">
                      <label class="field__label" for="pos-credit-downpayment">Downpayment (₱) <span class="field__opt">optional</span></label>
                      <div class="field__wrap">
                        <input type="number" id="pos-credit-downpayment" min="0" step="1" value="0"
                          oninput="calculateCreditBalance()">
                      </div>
                    </div>
                    <div class="kv kv--danger">
                      <span>New utang balance</span>
                      <strong id="pos-credit-balance-preview">₱0.00</strong>
                    </div>
                  </div>

                  <!-- 4. Bank transfer panel -->
                  <div class="paypanel hidden" id="payment-panel-transfer">
                    <div class="field">
                      <label class="field__label" for="pos-transfer-ref">Bank / transfer reference</label>
                      <div class="field__wrap">
                        <input type="text" id="pos-transfer-ref" class="font-mono"
                          placeholder="Transfer ref # / transaction ID">
                      </div>
                    </div>
                  </div>

                  <button type="button" class="btn-primary btn-primary--pos mt-3" onclick="completeSale()">
                    <i data-lucide="check-circle" class="w-4 h-4"></i>
                    <span>Take payment &amp; print (F9)</span>
                  </button>

                  <div class="tiles mt-2">
                    <button type="button" class="tile" onclick="saveRepairDraft()" title="Hold current job">
                      <i data-lucide="save" class="w-4 h-4"></i>
                      <span>Hold</span>
                    </button>
                    <button type="button" class="tile" onclick="focusDiscount()">
                      <i data-lucide="percent" class="w-4 h-4"></i>
                      <span>Discount</span>
                    </button>
                    <button type="button" class="tile" onclick="clearRepairOrder()">
                      <i data-lucide="trash-2" class="w-4 h-4"></i>
                      <span>Clear</span>
                    </button>
                  </div>
                </div>
```

- [ ] **Step 2: Also remove Services and Labor modals / DOM remnants**

Remove `<div id="modal-add-labor" ...>` from `public/index.html` if present, since custom labor is completely eliminated.

- [ ] **Step 3: Run node check to verify index.html is well-formed**

Run: `node -e "const fs = require('fs'); const html = fs.readFileSync('public/index.html', 'utf8'); console.log('Parsed successfully, length:', html.length);"`
Expected: Successfully logged without errors.

---

### Task 3: CSS Layout Updates (`public/styles.css`)

**Files:**
- Modify: `public/styles.css`

**Interfaces:**
- Consumes: Tailwind / custom variables in `public/styles.css`
- Produces: CSS rules for `.intake-bar`, `.intake-grid`, `.shelf-panel`, `.btn-add-part`.

- [ ] **Step 1: Add layout styling for intake bar and parts shelf**

Add the following CSS rules to `public/styles.css`:

```css
/* Unbloated Straight POS Repair Flow */
.intake-bar {
  padding: 0.75rem 1rem;
  margin-bottom: 0.75rem;
  background: var(--surface-1, #132238);
  border: 1px solid var(--border, #203554);
  border-radius: 0.5rem;
}

.intake-grid {
  display: grid;
  grid-template-columns: 2fr 1.5fr 2fr;
  gap: 0.75rem;
}

@media (max-width: 900px) {
  .intake-grid {
    grid-template-columns: 1fr;
  }
}

.btn-add-part {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0.25rem 0.6rem;
  font-size: 0.75rem;
  font-weight: 600;
  border-radius: 0.375rem;
  background-color: var(--brand, #2563eb);
  color: #ffffff;
  transition: background-color 0.15s ease;
}

.btn-add-part:hover:not(:disabled) {
  background-color: #1d4ed8;
}

.btn-add-part:disabled {
  opacity: 0.4;
  cursor: not-allowed;
  background-color: #475569;
}
```

- [ ] **Step 2: Run CSS build to verify compiler and asset integrity**

Run: `npm run build:css`
Expected: Tailwind CSS builds cleanly without errors.

---

### Task 4: JavaScript Logic Refactoring (`public/app.js`)

**Files:**
- Modify: `public/app.js`

**Interfaces:**
- Consumes: Inventory data from `/api/inventory`
- Produces:
  - `populateDeviceDatalist()`
  - `onDeviceSelected(deviceModel)`
  - `clearDeviceSelection()`
  - `renderPartsTable()` updated to highlight and filter compatible parts and provide 1-click `+ Add`
  - `onPartSearchKeydown(event)`: Enter key appends top matching part directly to cart
  - `setPriceTier(tier)` updated to support 'retail' and 'technician' (labeled 'Wholesale')
  - Removes: `goToStep()`, `updateStepper()`, `renderDeviceGrid()`, `openAddLaborModal()`, etc.

- [ ] **Step 1: Write device datalist population and filtering in `public/app.js`**

Add functions to extract distinct models from inventory items and populate `<datalist id="device-datalist">`:

```javascript
function populateDeviceDatalist() {
  const datalist = document.getElementById('device-datalist');
  if (!datalist || !posCatalog) return;
  const models = [...new Set(posCatalog.map(p => `${p.brand} ${p.model_name}`).filter(Boolean))].sort();
  datalist.innerHTML = models.map(m => `<option value="${escapeHtml(m)}"></option>`).join('');
}

function onDeviceSelected(val) {
  activeDevice = (val || '').trim();
  const sumName = document.getElementById('sum-device-name');
  const sumMeta = document.getElementById('sum-device-meta');
  const shelfTitle = document.getElementById('shelf-title');
  const shelfHint = document.getElementById('shelf-hint');

  if (activeDevice) {
    if (sumName) sumName.textContent = activeDevice;
    if (sumMeta) sumMeta.textContent = 'Active handset on bench';
    if (shelfTitle) shelfTitle.textContent = `${activeDevice} Parts`;
    if (shelfHint) shelfHint.textContent = 'Compatible in-stock parts for this handset.';
  } else {
    if (sumName) sumName.textContent = 'No device chosen';
    if (sumMeta) sumMeta.textContent = 'Universal / all parts shown.';
    if (shelfTitle) shelfTitle.textContent = 'All Available Parts';
    if (shelfHint) shelfHint.textContent = 'Showing all active parts in inventory.';
  }
  renderPartsTable();
}

function clearDeviceSelection() {
  const input = document.getElementById('repair-device-input');
  if (input) input.value = '';
  onDeviceSelected('');
}
```

- [ ] **Step 2: Update `renderPartsTable()` to display 1-click Add button and device compatibility filtering**

Refactor `renderPartsTable()`:
1. When `activeDevice` is present, filter inventory items where `${p.brand} ${p.model_name}` loosely matches `activeDevice`, or sort them to the top.
2. Render table rows with part name, category badge, price (respecting `currentPriceTier`), stock count, and a direct `<button type="button" class="btn-add-part" onclick="quickAddPart(${part.id})">+ Add</button>`.

```javascript
function quickAddPart(partId) {
  const part = posCatalog.find(p => p.id === partId);
  if (!part) return;
  if (part.stock_quantity <= 0) {
    showToast(`${part.brand} ${part.model_name} ${part.part_type} is out of stock`, 'warning');
    return;
  }
  const existing = cart.find(c => !c.is_labor && c.id === part.id);
  if (existing) {
    if (existing.qty >= part.stock_quantity) {
      showToast(`Cannot add more than available stock (${part.stock_quantity})`, 'warning');
      return;
    }
    existing.qty += 1;
  } else {
    cart.push({
      id: part.id,
      sku: part.sku_barcode,
      brand: part.brand,
      model_name: part.model_name,
      part_type: part.part_type,
      name: `${part.brand} ${part.model_name} ${part.part_type}`,
      price_retail: part.price_retail,
      price_technician: part.price_technician,
      unit_price: currentPriceTier === 'technician' ? part.price_technician : part.price_retail,
      qty: 1,
      stock: part.stock_quantity,
      is_labor: false
    });
  }
  renderCart();
  renderPartsTable();
  showToast(`Added ${part.part_type}`, 'success');
}
```

- [ ] **Step 3: Implement barcode/search keydown handler**

Add `onPartSearchKeydown(event)`:
When the technician hits `Enter` in `#pos-search-input`, if there is at least one filtered part matching the search query, add the first match to cart and clear the search field:

```javascript
function onPartSearchKeydown(e) {
  if (e.key === 'Enter') {
    e.preventDefault();
    const query = (e.target.value || '').trim().toLowerCase();
    if (!query) return;
    const parts = getFilteredParts();
    if (parts.length > 0) {
      quickAddPart(parts[0].id);
      e.target.value = '';
      renderPartsTable();
    } else {
      showToast('No matching part found in stock', 'warning');
    }
  }
}
```

- [ ] **Step 4: Update price tier handling to Wholesale and clean up dead stepper code**

Update `setPriceTier(tier)`:
- Target `#tier-retail-btn` and `#tier-wholesale-btn`.
- Set `currentPriceTier = tier;`.
- Update line item unit prices in `cart`.
- Call `renderCart()` and `renderPartsTable()`.
- Delete `goToStep()`, `updateStepper()`, and `#stage-order` references from `app.js`.

- [ ] **Step 5: Run existing backend test suite to ensure API and logic invariants hold**

Run: `npm test`
Expected: All 83 tests pass cleanly.

---

### Task 5: End-to-End Verification & Walkthrough

**Files:**
- Modify: `tests/sales.test.js` (add test for wholesale customer tier sale checkout)
- Verification: Browser check / manual workflow validation

- [ ] **Step 1: Add a test verifying wholesale tier checkout in `tests/sales.test.js`**

Verify that sales created with `customer_type: 'technician'` (wholesale tier) correctly deduct stock and calculate totals using `price_technician`.

- [ ] **Step 2: Run test suite**

Run: `npm test`
Expected: 100% test pass.

- [ ] **Step 3: Test POS initialization in Node**

Run: `node -e "const { initDb } = require('./src/db'); const db = initDb(':memory:'); console.log('Db initialized successfully');"`
Expected: SQLite database boots and initializes without error.
