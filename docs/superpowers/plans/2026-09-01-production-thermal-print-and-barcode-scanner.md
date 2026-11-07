# Production Thermal Printing & Barcode Scanner Integration Plan (Revised)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement production-grade thermal printing optimizations (zero-margin `@page` print rules, 58mm/80mm layout fix, silent kiosk auto-printing launcher in `server.js`) and seamless USB barcode scanner integration (instant exact-match scan-to-cart, out-of-stock guards, synthetic Web Audio beeps, global POS scanner listener, and handset IMEI fast-scanning).

**Architecture:** 
- **Thermal Printing & Kiosk Mode:** Fix `#printable-receipt` CSS so `.thermal-58mm` and `.thermal-80mm` properly control receipt width. Set valid `@page { margin: 0mm; size: auto; }` (no `!important`). In `src/server.js`, upgrade workstation auto-open to launch Microsoft Edge / Chrome in app mode with silent kiosk printing (`start "" msedge --kiosk-printing --app=http://localhost:${currentPort}`), automatically supporting dynamic ports, dev, `start.bat`, and the packaged `TechPartsPOS.exe`.
- **Barcode Scanner Integration:** USB barcode scanners act as HID keyboard wedges typing barcodes rapidly (< 50ms keystroke intervals) and pressing `Enter`. Backend exposes `getInventoryByBarcode()` in `src/inventory.js` and route `GET /api/inventory/barcode/:code` in `src/server.js`. Frontend implements `handleBarcodeScan(code)` with strict exact-match `sku_barcode` equality, zero-asset Web Audio synthetic POS beeps (`AudioContext`), out-of-stock validation, `pos-search-input` listener, a global POS keydown scanner buffer, and `#repair-imei` intake scanning.

**Tech Stack:** Node.js (built-in SQLite `node:sqlite`), Vanilla JS (ES6+), Vanilla CSS, Web Audio API (`AudioContext`), Windows `cmd.exe` process spawning.

## Global Constraints
- Zero runtime npm dependencies (pure Node.js standard library and native browser APIs).
- Must preserve SQLite database transactions and integrity.
- All existing 68 tests across the test suite must continue to pass using `tests/helper.js` (`dbTest`, `serverTest`).
- Audio feedback must use native Web Audio API (zero `.mp3`/`.wav` assets required).
- No git commits required (clean local file modifications).

---

### Task 1: Backend Barcode Lookup & Route

**Files:**
- Modify: [`src/inventory.js`](file:///c:/Users/sloth/Downloads/phone-repair-pos/src/inventory.js)
- Modify: [`src/server.js`](file:///c:/Users/sloth/Downloads/phone-repair-pos/src/server.js)
- Test: [`tests/inventory.test.js`](file:///c:/Users/sloth/Downloads/phone-repair-pos/tests/inventory.test.js)
- Test: [`tests/server.test.js`](file:///c:/Users/sloth/Downloads/phone-repair-pos/tests/server.test.js)

**Interfaces:**
- Consumes: SQLite `db` connection.
- Produces: `getInventoryByBarcode(db, barcode)` returning single inventory row or `null`. Endpoint `GET /api/inventory/barcode/:code` returning `200 JSON` or `404 JSON`.

- [ ] **Step 1: Write the failing tests using existing test helpers**

In [`tests/inventory.test.js`](file:///c:/Users/sloth/Downloads/phone-repair-pos/tests/inventory.test.js):
```javascript
const { createInventoryItem, getInventoryByBarcode } = require('../src/inventory');

dbTest('getInventoryByBarcode retrieves part by exact barcode or SKU', (db) => {
  const created = createInventoryItem(db, {
    brand: 'Apple',
    model_name: 'iPhone 13',
    part_type: 'OLED Screen',
    sku_barcode: 'IP13-OLED-001',
    cost_price: 1500,
    price_retail: 3200,
    price_technician: 2800,
    stock_quantity: 5,
    min_stock_alert: 2
  });

  const found = getInventoryByBarcode(db, 'IP13-OLED-001');
  assert.ok(found, 'Should find item by exact barcode');
  assert.strictEqual(found.id, created.id);
  assert.strictEqual(found.model_name, 'iPhone 13');

  // Case-insensitive check
  const foundLower = getInventoryByBarcode(db, 'ip13-oled-001');
  assert.ok(foundLower, 'Should find item case-insensitively');
  assert.strictEqual(foundLower.id, created.id);

  const notFound = getInventoryByBarcode(db, 'NON-EXISTENT-BARCODE');
  assert.strictEqual(notFound, null, 'Should return null for unknown barcode');
});
```

In [`tests/server.test.js`](file:///c:/Users/sloth/Downloads/phone-repair-pos/tests/server.test.js):
```javascript
const { createInventoryItem } = require('../src/inventory');

serverTest('GET /api/inventory/barcode/:code returns item or 404', async (baseUrl, db) => {
  const created = createInventoryItem(db, {
    brand: 'Samsung',
    model_name: 'Galaxy S21',
    part_type: 'LCD Assembly',
    sku_barcode: 'SAM-S21-LCD',
    cost_price: 1200,
    price_retail: 2500,
    price_technician: 2200,
    stock_quantity: 4,
    min_stock_alert: 1
  });

  const resFound = await fetch(`${baseUrl}/api/inventory/barcode/SAM-S21-LCD`);
  assert.strictEqual(resFound.status, 200);
  const foundItem = await resFound.json();
  assert.strictEqual(foundItem.id, created.id);
  assert.strictEqual(foundItem.sku_barcode, 'SAM-S21-LCD');

  const resNotFound = await fetch(`${baseUrl}/api/inventory/barcode/UNKNOWN-999`);
  assert.strictEqual(resNotFound.status, 404);
  const notFoundJson = await resNotFound.json();
  assert.strictEqual(notFoundJson.error, 'Item not found');
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `node --test tests/inventory.test.js tests/server.test.js`
Expected: FAIL with `getInventoryByBarcode is not a function` or 404.

- [ ] **Step 3: Implement `getInventoryByBarcode` and server route**

In [`src/inventory.js`](file:///c:/Users/sloth/Downloads/phone-repair-pos/src/inventory.js):
```javascript
function getInventoryByBarcode(db, barcode) {
  if (!barcode || typeof barcode !== 'string') return null;
  const clean = barcode.trim();
  if (!clean) return null;
  return db.prepare('SELECT * FROM inventory WHERE sku_barcode = ? COLLATE NOCASE').get(clean) || null;
}
```
Export `getInventoryByBarcode` in `module.exports` of [`src/inventory.js`](file:///c:/Users/sloth/Downloads/phone-repair-pos/src/inventory.js).

In [`src/server.js`](file:///c:/Users/sloth/Downloads/phone-repair-pos/src/server.js):
Import `getInventoryByBarcode` from `./inventory.js` and add route in the inventory routing block using existing `pathname.match()` style:
```javascript
        const invBarcodeMatch = pathname.match(/^\/api\/inventory\/barcode\/(.+)$/);
        if (invBarcodeMatch && method === 'GET') {
          const barcode = decodeURIComponent(invBarcodeMatch[1]);
          const item = getInventoryByBarcode(db, barcode);
          if (!item) return sendJson(res, 404, { error: 'Item not found' });
          return sendJson(res, 200, item);
        }
```

- [ ] **Step 4: Run tests to verify pass**

Run: `node --test tests/inventory.test.js tests/server.test.js`
Expected: PASS.

---

### Task 2: Frontend Barcode Scanning (Exact Scan-to-Cart, Audio Feedback, Global Scanner & IMEI)

**Files:**
- Modify: [`public/app.js`](file:///c:/Users/sloth/Downloads/phone-repair-pos/public/app.js)
- Modify: [`public/index.html`](file:///c:/Users/sloth/Downloads/phone-repair-pos/public/index.html)

**Interfaces:**
- Consumes: `inventoryItems`, `cart`, `setPartQty(itemId, delta)`, `showToast(msg, type)`
- Produces: `playScanSound(isSuccess)`, `handleBarcodeScan(code)`, `pos-search-input` keydown listener, `#repair-imei` keydown listener, and global POS keydown scanner buffer.

- [ ] **Step 1: Implement Web Audio scan sound generator in `public/app.js`**

Add zero-dependency Web Audio sound feedback in [`public/app.js`](file:///c:/Users/sloth/Downloads/phone-repair-pos/public/app.js):
```javascript
// Web Audio Context for instant cashier audio feedback without external audio files
let audioCtx = null;
function playScanSound(isSuccess = true) {
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    if (!audioCtx) audioCtx = new AudioContext();
    if (audioCtx.state === 'suspended') audioCtx.resume();

    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);

    if (isSuccess) {
      // Crisp high-pitch POS beep: 1760Hz (A6) for 70ms
      osc.type = 'sine';
      osc.frequency.setValueAtTime(1760, audioCtx.currentTime);
      gain.gain.setValueAtTime(0.12, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.07);
      osc.start();
      osc.stop(audioCtx.currentTime + 0.07);
    } else {
      // Low warning buzz: 220Hz for 160ms
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(220, audioCtx.currentTime);
      gain.gain.setValueAtTime(0.18, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.16);
      osc.start();
      osc.stop(audioCtx.currentTime + 0.16);
    }
  } catch (_) {}
}
```

- [ ] **Step 2: Implement strict exact-match `handleBarcodeScan` and add-to-cart in `public/app.js`**

In [`public/app.js`](file:///c:/Users/sloth/Downloads/phone-repair-pos/public/app.js):
```javascript
function handleBarcodeScan(scannedCode) {
  const code = (scannedCode || '').trim();
  if (!code) return false;

  // Strict exact match on sku_barcode (case-insensitive)
  const item = inventoryItems.find(it => 
    it.sku_barcode && it.sku_barcode.toLowerCase() === code.toLowerCase()
  );

  if (!item) {
    playScanSound(false);
    showToast(`Unknown barcode / SKU: "${code}"`, 'warning');
    return false;
  }

  if (item.stock_quantity <= 0) {
    playScanSound(false);
    showToast(`Cannot add "${item.brand} ${item.model_name}" — Out of stock!`, 'error');
    return false;
  }

  const currentQty = cartQtyFor(item.id);
  if (currentQty >= item.stock_quantity) {
    playScanSound(false);
    showToast(`Max stock reached for "${item.brand} ${item.model_name}" (${item.stock_quantity} available)`, 'warning');
    return false;
  }

  // setPartQty automatically adds the line or increments quantity, and advances repairStep to 3 (checkout)
  setPartQty(item.id, 1);
  playScanSound(true);
  showToast(`Scanned: ${item.brand} ${item.model_name} (${item.part_type})`, 'success');

  // Reset search input and re-render parts table
  const searchInput = document.getElementById('pos-search-input');
  if (searchInput) {
    searchInput.value = '';
    renderPartsTable();
  }
  return true;
}
```

- [ ] **Step 3: Wire up `pos-search-input`, global scanner listener, and `#repair-imei` intake**

1. **`pos-search-input` Enter key handler**:
```javascript
document.getElementById('pos-search-input')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    const val = e.target.value.trim();
    if (val) {
      handleBarcodeScan(val);
    }
  }
});
```

2. **Global POS scanner listener** (captures hardware scanner rapid keystrokes `< 50ms` when POS tab is active):
```javascript
let scanBuffer = '';
let lastKeyTime = 0;

window.addEventListener('keydown', (e) => {
  // Only capture global scans when on the POS / Counter tab
  if (currentTab !== 'pos') return;

  const now = Date.now();
  const target = e.target;
  const isInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT';

  // If focused on an intake text field other than pos-search-input (e.g. customer name/notes), let standard typing pass
  if (isInput && target.id !== 'pos-search-input') {
    return;
  }

  // Hardware scanners type characters rapidly (< 50ms between keys)
  if (now - lastKeyTime > 100) {
    scanBuffer = '';
  }
  lastKeyTime = now;

  if (e.key === 'Enter') {
    if (scanBuffer.length >= 2) {
      e.preventDefault();
      const code = scanBuffer.trim();
      scanBuffer = '';
      handleBarcodeScan(code);
    }
  } else if (e.key.length === 1) {
    scanBuffer += e.key;
  }
});
```

3. **Handset IMEI Scanner support on `#repair-imei`**:
```javascript
document.getElementById('repair-imei')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    const imeiVal = e.target.value.trim();
    if (imeiVal) {
      playScanSound(true);
      showToast(`IMEI recorded: ${imeiVal}`, 'info');
      document.getElementById('repair-note')?.focus();
    }
  }
});
```

- [ ] **Step 4: Update `public/index.html` placeholders and tooltips**

In [`public/index.html`](file:///c:/Users/sloth/Downloads/phone-repair-pos/public/index.html):
Update the search input placeholder to indicate barcode scanner readiness:
```html
<input type="text" id="pos-search-input" autocomplete="off"
  placeholder="Scan barcode or search brand, model, SKU... [Enter]"
  class="w-full bg-slate-900/90 border border-slate-700/80 rounded-xl pl-9 pr-8 py-2 text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:border-cyan-500/70 focus:ring-2 focus:ring-cyan-500/20 transition-all font-mono" />
```

---

### Task 3: Thermal Receipt CSS Fixes & Zero-Margin `@page`

**Files:**
- Modify: [`public/styles.css`](file:///c:/Users/sloth/Downloads/phone-repair-pos/public/styles.css#L3303-L3359)

**Interfaces:**
- Consumes: `@media print`
- Produces: Valid `@page { margin: 0mm; size: auto; }` and fixes 58mm/80mm receipt width specificity bug.

- [ ] **Step 1: Fix print styles in `public/styles.css`**

In [`public/styles.css`](file:///c:/Users/sloth/Downloads/phone-repair-pos/public/styles.css#L3303-L3359):
- Set valid `@page` rule: `@page { margin: 0mm; size: auto; }` (no invalid `!important`).
- Remove `width: 100% !important;` from `#printable-receipt` so that `.thermal-58mm` and `.thermal-80mm` properly constrain the receipt width.
- Ensure `#printable-receipt` has `margin: 0 auto !important;` and `word-break: break-word;`.

```css
/* --------------------------------------- 9. thermal printing (58mm / 80mm) */
@page {
  margin: 0mm;
  size: auto;
}

@media print {
  body {
    background: #fff !important;
    color: #000 !important;
  }

  body::before,
  .grain {
    display: none !important;
  }

  body * {
    visibility: hidden;
  }

  #printable-receipt,
  #printable-receipt * {
    visibility: visible;
  }

  #printable-receipt {
    display: block !important;
    position: absolute;
    left: 0;
    top: 0;
    margin: 0 auto !important;
    padding: 2mm 3mm !important;
    background: #fff !important;
    color: #000 !important;
    font-family: "Courier New", Courier, monospace !important;
    font-size: 11px !important;
    line-height: 1.25 !important;
    word-break: break-word;
  }

  .no-print {
    display: none !important;
  }
}

.thermal-58mm {
  width: 48mm !important;
  max-width: 48mm !important;
}

.thermal-80mm {
  width: 72mm !important;
  max-width: 72mm !important;
}
```

---

### Task 4: Server Workstation Kiosk Auto-Launch & Operations Manual

**Files:**
- Modify: [`src/server.js`](file:///c:/Users/sloth/Downloads/phone-repair-pos/src/server.js#L461-L467)
- Modify: [`docs/OPERATIONS_AND_DEPLOYMENT.md`](file:///c:/Users/sloth/Downloads/phone-repair-pos/docs/OPERATIONS_AND_DEPLOYMENT.md)

**Interfaces:**
- Consumes: `process.platform === 'win32'`, `currentPort`
- Produces: Kiosk printing app launch on startup without hardcoded ports; documentation for thermal printing, RJ11 cash drawers, and barcode guns.

- [ ] **Step 1: Update auto-browser launch in `src/server.js`**

In [`src/server.js`](file:///c:/Users/sloth/Downloads/phone-repair-pos/src/server.js#L461-L467):
Replace the plain `start http://localhost:${currentPort}` with an Edge / Chrome kiosk-printing app launch that falls back cleanly:
```javascript
    // Auto open browser on Windows in dedicated app mode with silent kiosk printing
    try {
      if (process.platform === 'win32' && !process.env.NO_AUTO_BROWSER) {
        const url = `http://localhost:${currentPort}`;
        // Launches Edge in standalone app window with silent thermal receipt printing; falls back to Chrome or default browser
        const cmd = `start "" msedge --kiosk-printing --app=${url} || start "" chrome --kiosk-printing --app=${url} || start ${url}`;
        require('node:child_process').exec(cmd);
      }
    } catch (_) {}
```

- [ ] **Step 2: Update `docs/OPERATIONS_AND_DEPLOYMENT.md`**

Add a dedicated **Cashier Hardware Setup (Printers, Cash Drawers & Barcode Scanners)** section covering:
1. **Thermal Receipt Printer**: Driver setup, 58mm vs 80mm continuous paper selection, browser print preferences (Margins: None, Headers/Footers: Off).
2. **Kiosk Silent Printing**: Explaining how `--kiosk-printing` automatically suppresses the browser print preview dialog on checkout.
3. **Electronic Cash Drawer**: RJ11/RJ12 cable connection into the printer's DK port; configuring "Open Before/After Printing" in printer driver properties (noting driver capability nuances).
4. **USB Barcode Scanner**: Plug-and-play HID keyboard wedge mode, automatic `Enter` (`CR/LF`) suffix, and scan-to-cart workflow.

---

### Task 5: Automated & Manual Verification

**Files:**
- Test: `tests/*.test.js`

- [ ] **Step 1: Run complete automated test suite**

Run: `npm test`
Expected: All 68 existing tests + new barcode tests pass (total 70 tests, 0 failures).

- [ ] **Step 2: Manual Frontend Verification Checklist**
1. Start server with `npm start` (or `start.bat`).
2. Verify browser opens in standalone app window with `--kiosk-printing`.
3. Open POS screen, type `SAM-S21-LCD` in the search bar, press `Enter`:
   - Verify confirmation beep plays.
   - Verify cart quantity increments to 1.
   - Verify search input clears.
4. Scan or type an out-of-stock item's barcode:
   - Verify warning buzz plays and error toast appears.
5. In Repair Intake, enter or scan an IMEI into `#repair-imei` and press `Enter`:
   - Verify intake beep plays and focus advances to notes.
6. Open Receipt Modal and trigger Print:
   - Verify 58mm and 80mm receipt widths format properly with zero side margins.
