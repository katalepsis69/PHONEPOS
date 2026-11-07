# Streamlined Import and Bilingual System Hints Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Simplify inventory import by eliminating the 11 dropdown selects, auto-calculating blank prices from store markup, offering 1-click template download, and embedding simple bilingual (EN / TL) micro-hints across the POS.

**Architecture:** 
Client-side auto-matching using canonical header aliases (`importer.js`), pre-calculation of blank prices from store settings (`inventory.js`), zero-dropdown confirmation card with 3-row preview showing final prices, 1-click template download with educational sample rows, and centralized bilingual string dictionary in `public/js/i18n.js`.

**Tech Stack:** Vanilla JavaScript (ES modules), HTML5, Tailwind CSS tokens, Node.js built-in test runner (`node:test`, `node:assert`).

## Global Constraints
- Zero runtime dependencies.
- No em dashes (`—`) in UI copy or documentation (per `/antislop-copywriting`).
- No decorative emoji in headers or badges (per `/antislop-ui`).
- Text contrast must meet WCAG AA $\ge$ 4.5:1 (per `/antislop-human`).
- Concise, sentence-case code comments explaining non-obvious constraints only; no decorative separators (per `/antislop-code`).
- Shortest working diff and deletion over addition (per `/ponytail`).

---

### Task 1: 1-Click Direct Template Download

**Files:**
- Modify: `public/js/views/inventory.js:809-855`
- Test: `tests/template-chooser.test.js`

**Interfaces:**
- Consumes: `IMPORT_COLUMNS`, `IMPORT_TEMPLATE_HEADERS`
- Produces: `downloadImportTemplate()`: directly triggers browser download of `inventory-import-template.csv` with 2 sample rows (one with prices, one blank).

- [ ] **Step 1: Write failing test in `tests/template-chooser.test.js`**

Update `tests/template-chooser.test.js` to assert that `downloadImportTemplate()` directly initiates the download with the updated sample rows without creating `#modal-import-template`.

```javascript
test('downloadImportTemplate: downloads standard template with educational sample rows directly', async () => {
  // Assert direct download without modal
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/template-chooser.test.js`
Expected: FAIL due to modal references.

- [ ] **Step 3: Update `downloadImportTemplate()` in `public/js/views/inventory.js`**

Remove the modal-building DOM logic from `downloadImportTemplate()`. Generate CSV with headers and two clear rows:
1. Sample manual price row (`Apple`, `iPhone 15`, `LCD Screen`, `850`, `1250`, `1100`, `5`...)
2. Sample auto-price row with blank selling prices (`Samsung`, `Galaxy S23`, `Battery`, `300`, ``, ``, `10`...)
Trigger immediate blob download.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/template-chooser.test.js`
Expected: PASS.

---

### Task 2: Zero-Dropdown Import Confirmation & Smart Pricing Preview

**Files:**
- Modify: `public/js/views/inventory.js:600-795`
- Test: `tests/importer.test.js`

**Interfaces:**
- Consumes: `matchHeaders(header)`, `S.shopSettings.default_retail_markup_pct`, `S.shopSettings.default_wholesale_markup_pct`
- Produces: `openImportPreview(rows)`: displays compact modal with summary counts, calculated prices preview, and clean error handling.

- [ ] **Step 1: Add unit tests for auto-matching and row extraction without manual mapping**

Add tests to `tests/importer.test.js` testing header extraction when headers match standard aliases.

- [ ] **Step 2: Update `ensureImportPreviewModal()` and `openImportPreview()` in `public/js/views/inventory.js`**

- Remove the `#import-map-grid` 11-dropdown container and `#import-markup-inputs` from `#modal-import-preview`.
- In `openImportPreview(rows)`:
  - Match headers automatically via `matchHeaders(header)`.
  - Check required columns: `brand`, `model_name`, `part_type`. If missing, display a clear warning banner with a "Download sample template" button.
  - For rows with missing/blank `price_retail` or `price_technician`, calculate prices from `cost_price` using store markup settings (`default_retail_markup_pct` / `default_wholesale_markup_pct`).
  - Render a clean 3-row preview table showing calculated prices with an "(auto)" tag when calculated.
  - In `applyImport()`: send the mapped rows directly with `auto_price: true` and shop settings markup.

- [ ] **Step 3: Run importer and inventory tests**

Run: `node --test tests/importer.test.js tests/inventory.test.js tests/server.test.js`
Expected: PASS.

---

### Task 3: Bilingual System Micro-Hints (EN / TL)

**Files:**
- Modify: `public/js/i18n.js`
- Modify: `public/index.html`
- Modify: `public/js/views/pos.js`
- Modify: `public/js/views/inventory.js`
- Test: `tests/frontend-regressions.test.js`

**Interfaces:**
- Consumes: `t(key, fallback)` from `public/js/i18n.js`, `applyLanguage(lang)`
- Produces: Data-i18n attributes and updated placeholders/tooltips across POS, Inventory, Customers, Returns, and Settings.

- [ ] **Step 1: Add new keys to `I18N.en` and `I18N.tl` in `public/js/i18n.js`**

Register the keys:
- `inv.import_tt`, `inv.import_note`, `inv.import_auto_note`, `inv.bulk_hint`, `inv.delete_has_sales`, `part.gen_barcode`
- `pos.tier_retail_tt`, `pos.tier_tech_tt`, `pos.cust_search_ph`, `pos.credit_require_name`, `pos.claim_stub_tt`, `pos.search_ph`
- `credit.settle_partial_note`, `credit.pin_needed`
- `returns.search_ph`, `returns.restock_note`
- `settings.markup_note`

- [ ] **Step 2: Wire attributes in `public/index.html` and view scripts**

- Update Inventory toolbar buttons (`import-csv`, `import-template`) with tooltips and subtitles.
- Update POS part search placeholder: `data-i18n-ph="pos.search_ph"`.
- Update customer input placeholder: `data-i18n-ph="pos.cust_search_ph"`.
- Update Returns search placeholder: `data-i18n-ph="returns.search_ph"`.
- Update Settings markup footnote: `data-i18n="settings.markup_note"`.

- [ ] **Step 3: Verify language toggle updates all hints**

Run: `node --test tests/*.test.js`
Expected: PASS with 0 regression errors.

---

### Task 4: Accessibility and Full Verification

**Files:**
- Verify: `public/index.html`, `public/styles.css`
- Run: Full test suite

- [ ] **Step 1: Check contrast of hint texts**
Verify all newly added footnotes and hints use `--txt-3` or `--txt-2` with contrast ratio $\ge 4.5:1$ against backgrounds.

- [ ] **Step 2: Run full regression test suite**
Run: `npm test`
Expected: All suites pass cleanly.
