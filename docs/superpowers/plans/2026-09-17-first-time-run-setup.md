# Ultra-Lean First-Time Run Setup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provide an intuitive, zero-bloat first-time setup experience for new phone repair shops by upgrading the existing `#pin-setup-overlay` into a 1-screen Quick Shop Setup card that configures Shop Name, Manager PIN, Printer Width, and optional starter parts catalog.

**Architecture:** We avoid complex multi-step state machines and new database tables. We enhance the existing `#pin-setup-overlay` in `public/index.html` (which already triggers automatically when running on the factory PIN `1234`). On submission, `public/js/auth.js` rotates the PIN via `POST /api/auth/change-pin`, updates shop name and receipt width via `POST /api/settings`, and optionally triggers an idempotent zero-stock starter parts catalog seed via a new lightweight `POST /api/inventory/seed-starter` route.

**Tech Stack:** Node.js native (`node:http`, `node:sqlite`), Vanilla JS (ES6+), Tailwind CSS v4.

## Global Constraints
- Zero external runtime npm dependencies (`node:*` only).
- Do not break or alter existing test suites (`npm test` must maintain 100% pass rate across all 163+ existing tests).
- 100% backward compatibility: existing databases without new fields continue to work seamlessly.
- Shop Name reuses `gcash_name` in `shop_settings` so it immediately displays on receipt headers without migration.
- Starter parts are seeded with `stock_quantity = 0` so shop owners can stock-in their own inventory without fake sales history.

---

### Task 1: Extend Starter Catalog Seeding in `src/seed.js`

**Files:**
- Modify: `src/seed.js:34-89`
- Test: `tests/setup.test.js`

**Interfaces:**
- Produces: `seedInitialParts(db, { zeroStock = false, skipSales = false })`
- Consumes: `initDb` from `src/db.js`, `createInventoryItem` from `src/inventory.js`

- [ ] **Step 1: Write the failing test for zero-stock starter parts seeding**

Create `tests/setup.test.js`:
```javascript
const test = require('node:test');
const assert = require('node:assert');
const { DatabaseSync } = require('node:sqlite');
const { initDb } = require('../src/db');
const { seedInitialParts } = require('../src/seed');

test('seedInitialParts with zeroStock: true creates 17 parts with 0 stock and no sales', () => {
  const db = initDb(':memory:', new DatabaseSync(':memory:'));
  const count = seedInitialParts(db, { zeroStock: true, skipSales: true });
  assert.strictEqual(count, 17);

  const parts = db.prepare('SELECT stock_quantity FROM inventory').all();
  assert.strictEqual(parts.length, 17);
  for (const part of parts) {
    assert.strictEqual(part.stock_quantity, 0);
  }

  const salesCount = db.prepare('SELECT COUNT(*) as count FROM sales').get().count;
  assert.strictEqual(salesCount, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/setup.test.js`  
Expected: FAIL because `seedInitialParts` currently does not accept options and seeds non-zero stock with sample sales.

- [ ] **Step 3: Update `seedInitialParts` in `src/seed.js`**

In `src/seed.js`, modify `seedInitialParts`:
```javascript
function seedInitialParts(db, opts = {}) {
  const { zeroStock = false, skipSales = false } = opts;
  const existing = db.prepare('SELECT COUNT(*) as count FROM inventory').get();
  let createdParts = [];
  if (!existing || existing.count === 0) {
    console.log(`Seeding ${INITIAL_PARTS.length} standard phone LCDs and parts...`);
    for (const part of INITIAL_PARTS) {
      const partData = zeroStock ? { ...part, stock_quantity: 0 } : part;
      createdParts.push(createInventoryItem(db, partData));
    }
    console.log('Seeding inventory complete!');
  } else {
    createdParts = db.prepare('SELECT * FROM inventory').all();
  }

  // Seed sample sales only if sales table is empty and skipSales is false
  if (!skipSales) {
    const salesCount = db.prepare('SELECT COUNT(*) as count FROM sales').get();
    if (!salesCount || salesCount.count === 0) {
      if (createdParts.length >= 3) {
        const { createSale } = require('./sales');
        createSale(db, {
          customer_name: 'Alice Repair Tech',
          customer_phone: '0917-888-1234',
          customer_type: 'technician',
          payment_method: 'gcash',
          payment_reference: '1002 9841 2291',
          items: [{ inventory_id: createdParts[0].id, quantity: 1, unit_price: createdParts[0].price_technician }],
          discount: 0.0,
          amount_paid: createdParts[0].price_technician
        });
        createSale(db, {
          customer_name: 'Mark Freelance Tech',
          customer_phone: '0918-999-5678',
          customer_type: 'technician',
          payment_method: 'credit',
          items: [{ inventory_id: createdParts[1].id, quantity: 2, unit_price: createdParts[1].price_technician }],
          discount: 100.0,
          amount_paid: 1000.0
        });
        createSale(db, {
          customer_name: 'Walk-in Customer',
          customer_type: 'retail',
          payment_method: 'cash',
          items: [{ inventory_id: createdParts[2].id, quantity: 1, unit_price: createdParts[2].price_retail }],
          discount: 50.0,
          amount_paid: createdParts[2].price_retail
        });
        console.log('Seeded sample POS transactions and customer credit ledger!');
      }
    }
  }

  return createdParts.length;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/setup.test.js`  
Expected: PASS

---

### Task 2: Add `POST /api/inventory/seed-starter` in `src/server.js`

**Files:**
- Modify: `src/server.js:520-560`
- Test: `tests/setup.test.js`

**Interfaces:**
- Produces: `POST /api/inventory/seed-starter` endpoint
- Consumes: `seedInitialParts` from `src/seed.js`, `isDefaultPin` from `src/auth.js`

- [ ] **Step 1: Write test for `POST /api/inventory/seed-starter`**

Append to `tests/setup.test.js`:
```javascript
const { createServer } = require('../src/server');

test('POST /api/inventory/seed-starter seeds 17 parts when catalog is empty', async (t) => {
  const { server, db } = createServer();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  t.after(() => { server.close(); db.close(); });

  // Get session
  const loginRes = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'manager', pin: '1234' })
  });
  const { token } = await loginRes.json();

  const seedRes = await fetch(`http://127.0.0.1:${port}/api/inventory/seed-starter`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}` }
  });
  assert.strictEqual(seedRes.status, 200);
  const data = await seedRes.json();
  assert.strictEqual(data.ok, true);
  assert.strictEqual(data.count, 17);

  const invCount = db.prepare('SELECT COUNT(*) as c FROM inventory').get().c;
  assert.strictEqual(invCount, 17);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/setup.test.js`  
Expected: FAIL (404 Not Found)

- [ ] **Step 3: Implement `POST /api/inventory/seed-starter` in `src/server.js`**

In `src/server.js`, import `seedInitialParts` (already in `src/seed.js`), and in the router under inventory/settings endpoints:
```javascript
if (pathname === '/api/inventory/seed-starter' && method === 'POST') {
  // Allow if elevated OR if the shop is still on the factory PIN during initial setup
  if (!elevated && !isDefaultPin(db)) return elevationDenied();
  const count = seedInitialParts(db, { zeroStock: true, skipSales: true });
  audit(db, session, elevated, 'inventory', 'seed_starter', { count });
  return sendJson(res, 200, { ok: true, count });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/setup.test.js`  
Expected: PASS

---

### Task 3: Upgrade `#pin-setup-overlay` into Quick Shop Setup Card in `public/index.html`

**Files:**
- Modify: `public/index.html:1700-1730`
- Test: Manual check + browser reload

**Interfaces:**
- Produces: Form elements `#setup-shop-name`, `#setup-paper-width-80`, `#setup-paper-width-58`, `#setup-seed-parts`, `#pin-setup-new`, `#pin-setup-confirm`

- [ ] **Step 1: Update HTML markup in `public/index.html`**

Replace `#pin-setup-overlay` in `public/index.html`:
```html
  <!-- 8b. QUICK SHOP SETUP OVERLAY (First-time shop configuration & PIN change) -->
  <div id="pin-setup-overlay" class="gate z-[95] hidden">
    <div class="gate__card" style="max-width: 440px;">
      <button type="button" data-action="skip-pin-setup" class="gate__close" aria-label="Close" title="Keep 1234 for now">
        <i class="ph ph-x"></i>
      </button>
      <div
        class="w-14 h-14 rounded-2xl bg-gradient-to-tr from-amber-500 to-orange-400 flex items-center justify-center text-slate-950 shadow-lg shadow-amber-500/30 mb-1">
        <i class="ph ph-storefront w-7 h-7"></i>
      </div>
      <h2 class="text-lg font-bold">Set Up Your Shop</h2>
      <p class="text-xs text-slate-400 text-center -mt-1 mb-2">
        Welcome to TechParts POS! Customize your shop name, secure your manager PIN, and get ready for sales.
      </p>

      <form id="form-shop-setup" class="w-full space-y-3 text-left">
        <div class="field">
          <label class="field__label" for="setup-shop-name">Shop Name *</label>
          <input type="text" id="setup-shop-name" required placeholder="e.g. FixZone Phone Repair"
            class="w-full px-3 py-2 text-xs font-medium gate__input" style="text-align:left; letter-spacing:normal;">
        </div>

        <div class="grid grid-cols-2 gap-2">
          <div class="field">
            <label class="field__label" for="pin-setup-new">Manager PIN *</label>
            <input type="password" id="pin-setup-new" maxlength="8" inputmode="numeric" pattern="[0-9]*" autocomplete="new-password"
              class="w-full px-3 py-2 text-xs gate__input" placeholder="••••">
          </div>
          <div class="field">
            <label class="field__label" for="pin-setup-confirm">Confirm PIN *</label>
            <input type="password" id="pin-setup-confirm" maxlength="8" inputmode="numeric" pattern="[0-9]*" autocomplete="new-password"
              class="w-full px-3 py-2 text-xs gate__input" placeholder="Confirm">
          </div>
        </div>

        <div class="field">
          <label class="field__label">Receipt Printer Width</label>
          <div class="seg w-full grid grid-cols-2 mt-0.5" role="group">
            <button type="button" class="seg-btn is-active text-xs" data-setup-width="80mm">80mm Desktop</button>
            <button type="button" class="seg-btn text-xs" data-setup-width="58mm">58mm Mobile</button>
          </div>
        </div>

        <label class="flex items-start gap-2.5 p-2.5 rounded-lg border border-[var(--line-soft)] bg-[var(--surface-muted)] cursor-pointer select-none">
          <input type="checkbox" id="setup-seed-parts" checked class="mt-0.5 rounded border-slate-700 text-amber-500 focus:ring-0">
          <div class="text-xs">
            <div class="font-medium text-slate-200">Load 17 standard phone repair parts</div>
            <div class="text-[11px] text-slate-400">Common iPhone, Samsung & Xiaomi LCDs and batteries with 0 initial stock, ready to price and receive.</div>
          </div>
        </label>

        <p id="pin-setup-error" class="gate__err hidden text-center"></p>

        <button type="button" data-action="save-pin-setup" class="gate__btn gate__btn--warn w-full mt-1">Save &amp; Launch Shop</button>
        <button type="button" data-action="skip-pin-setup" class="gate__link w-full text-center" style="margin-top: 4px;">
          Keep defaults / Skip for now
        </button>
      </form>
    </div>
  </div>
```

---

### Task 4: Enhance Form Wiring and Submission in `public/js/auth.js`

**Files:**
- Modify: `public/js/auth.js:700-765`
- Test: Manual check + automated tests

**Interfaces:**
- Produces: Updated `enforcePinSetup()` and `submitPinSetup()` in `public/js/auth.js`
- Consumes: `/api/auth/change-pin`, `/api/settings`, `/api/inventory/seed-starter`

- [ ] **Step 1: Update `enforcePinSetup()` and width selector wiring**

In `public/js/auth.js`:
- In `enforcePinSetup()`: Pre-populate `#setup-shop-name` with `S.shopSettings.gcash_name || ''`.
- Ensure segment buttons for `data-setup-width` toggle the active state:
```javascript
document.querySelectorAll('[data-setup-width]').forEach(btn => {
  btn.addEventListener('click', (e) => {
    document.querySelectorAll('[data-setup-width]').forEach(b => b.classList.remove('is-active'));
    e.currentTarget.classList.add('is-active');
  });
});
```

- [ ] **Step 2: Update `submitPinSetup()` to handle full shop setup**

In `public/js/auth.js`, update `submitPinSetup()`:
```javascript
export async function submitPinSetup() {
  const shopName = (document.getElementById('setup-shop-name')?.value || '').trim();
  const newPin = (document.getElementById('pin-setup-new')?.value || '').trim();
  const confirmPin = (document.getElementById('pin-setup-confirm')?.value || '').trim();
  const activeWidthBtn = document.querySelector('[data-setup-width].is-active');
  const paperWidth = activeWidthBtn?.dataset?.setupWidth || '80mm';
  const shouldSeedParts = document.getElementById('setup-seed-parts')?.checked ?? false;
  const errorEl = document.getElementById('pin-setup-error');

  if (errorEl) errorEl.classList.add('hidden');
  const fail = msg => {
    if (errorEl) { errorEl.textContent = msg; errorEl.classList.remove('hidden'); }
  };

  if (shopName.length === 0) return fail('Please enter your shop name.');
  if (!/^\d{4,}$/.test(newPin)) return fail('PIN must be at least 4 digits.');
  if (newPin === '1234') return fail('Choose a PIN other than 1234, or click "Keep defaults / Skip" below.');
  if (newPin !== confirmPin) return fail('The two PINs do not match.');

  try {
    // 1. Change Manager PIN
    const pinRes = await fetch('/api/auth/change-pin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ old_pin: '1234', new_pin: newPin })
    });
    const pinData = await pinRes.json();
    if (!pinRes.ok) return fail(pinData.error || 'Could not change PIN.');

    // Update tokens returned by server
    if (pinData.token) {
      S.sessionToken = pinData.token;
      try { sessionStorage.setItem('pos_session', S.sessionToken); } catch (_) {}
    }
    if (pinData.elevationToken) setElevation(pinData.elevationToken, pinData.expiresAt);

    // 2. Save Shop Settings (Shop Name + Receipt Width)
    const settingsHeaders = { 'Content-Type': 'application/json' };
    if (S.elevationToken) settingsHeaders['X-Manager-Elevation'] = S.elevationToken;
    if (S.sessionToken) settingsHeaders['Authorization'] = `Bearer ${S.sessionToken}`;

    await fetch('/api/settings', {
      method: 'POST',
      headers: settingsHeaders,
      body: JSON.stringify({
        gcash_name: shopName,
        receipt_paper_width: paperWidth
      })
    });

    // 3. Seed starter catalog if checked
    if (shouldSeedParts) {
      await fetch('/api/inventory/seed-starter', {
        method: 'POST',
        headers: settingsHeaders
      });
    }

    await loadShopSettings();
    await loadPosCatalog();

    document.getElementById('pin-setup-overlay')?.classList.add('hidden');
    syncAppInert();
    showToast('Shop configured successfully! Ready for sales.', 'success');
  } catch (err) {
    fail('Could not reach the server.');
  }
}
```

- [ ] **Step 3: Test and verify full integration**

Run tests: `npm test`  
Verify all tests pass with zero regressions.

---

### Task 5: Full Regression Testing & Verification

**Files:**
- Run: `tests/setup.test.js`
- Run: `npm test`

- [ ] **Step 1: Execute test suite**

Run: `npm test`  
Expected: All 164+ tests pass.

- [ ] **Step 2: Manual Smoke Verification**
- Open app with fresh database or reset database.
- Confirm setup card appears with Shop Name, PIN inputs, 80mm/58mm selector, and Starter Parts checkbox.
- Enter shop name "FixZone Repair", PIN "7788", select 80mm, and click "Save & Launch Shop".
- Confirm PIN is changed, shop name is saved, 17 items appear in inventory with 0 stock, and counter is ready.
