# Design: Streamlined Import and Bilingual System Hints

**Date:** 2026-11-01  
**Project:** phone-repair-pos  
**Status:** Approved  

---

## 1. Overview & Goals

1. **Fix Import Pricing:** When importing parts from Excel (`.xlsx`) or `.csv`, if selling prices (`price_retail`, `price_technician`) are blank or omitted, auto-calculate them from `cost_price` using the store's configured markup percentages (`default_retail_markup_pct`, `default_wholesale_markup_pct`). If prices are present in the sheet, keep them.
2. **Remove Import Friction (Zero Dropdowns):** Eliminate the 11 dropdown selects currently shown in `modal-import-preview`. Use the existing alias matcher to auto-match standard headers (`Brand`, `Model Name`, `Part Type`, `Cost Price`, `Retail Price`, `Wholesale Price`, `Stock Qty`, `SKU / Barcode`, `Supplier`, `Location`). If required headers are missing, show a clean error with a direct template download button.
3. **1-Click Preview & Confirmation:** Show a compact modal with total part counts, restock count vs new part count, and a preview of the first 3 rows displaying calculated prices (highlighted if calculated).
4. **1-Click Template Download:** Remove the column chooser modal (`modal-import-template`). Clicking "Download template" immediately downloads a clean, standard CSV template containing explanatory sample rows.
5. **System-Wide Discoverability Hints:** Add clear, simple, human micro-hints across the POS to surface non-obvious features (pricing tiers, debt search, bulk edit, warranty returns, claim stubs).
6. **Bilingual Translation (EN / TL):** Every user-facing hint and label must be available in both English and Tagalog in `public/js/i18n.js`.

---

## 2. Architecture & Data Flow

### A. Importer Flow (`public/js/views/inventory.js`, `public/js/importer.js`)
1. User selects `.xlsx` or `.csv` file via `#inv-import-file`.
2. File is parsed into row arrays (`parseXlsx` or `parseCsv`).
3. Client runs `matchHeaders(headerRow)`:
   - Required columns: `brand`, `model_name`, `part_type`, `stock_quantity`.
   - If missing required columns: open modal displaying missing column names and a "Download template" button.
   - If valid: map rows into part objects. If retail/wholesale price is empty or missing, pre-calculate it client-side using `S.shopSettings.default_retail_markup_pct || 50` and `default_wholesale_markup_pct || 20`.
4. Modal displays:
   - Summary: filename, total rows count, new vs restock parts.
   - Friendly notice: "Blank prices are calculated using store markup (50% retail, 20% wholesale)."
   - Compact 3-row preview table showing calculated prices.
   - Two buttons: `Cancel` and `Import N parts`.
5. On confirm:
   - POST to `/api/inventory/import` with mapped rows and `auto_price: true`.
   - Server processes import transaction and responds with created/updated count.
   - Toast displays: `"Import complete: N parts imported (X created, Y restocked)"`.

### B. Template Download
1. Clicking `#inv-import-template` or `[data-action="import-template"]` creates and downloads `inventory-import-template.csv` directly.
2. Template includes:
   - Headers: `Brand,Model Name,Part Type,SKU / Barcode,Cost Price,Retail Price,Wholesale Price,Stock Qty,Min Stock Alert,Supplier,Location`
   - Row 1 (Manual prices sample): `Apple,iPhone 15,LCD Screen,IPC15LCD,850,1250,1100,5,2,Supplier X,Shelf A`
   - Row 2 (Auto-price sample): `Samsung,Galaxy S23,Battery,SAMS23BAT,300,,,10,2,Supplier Y,Shelf B`

### C. Bilingual i18n Dictionary (`public/js/i18n.js`)
All new hints, placeholders, and labels are registered in `I18N.en` and `I18N.tl`.

---

## 3. Micro-Hints & Text Specifications

All copy adheres to `/antislop-copywriting` (no buzzwords, no passive voice, no em dashes, short sentences) and `/antislop-human` (high contrast, accessible).

| Key | English (EN) | Tagalog (TL) | Context |
| :--- | :--- | :--- | :--- |
| `inv.import_tt` | Import parts from Excel or CSV | Mag-import ng piyesa mula sa Excel o CSV | Toolbar tooltip |
| `inv.import_note` | Upload Excel or CSV. Blank prices are calculated from cost using store markup. | Mag-upload ng Excel o CSV. Ang blangkong presyo ay kukuwentahin mula sa puhunan. | Settings / Inventory note |
| `inv.import_auto_note` | Blank prices are calculated using store markup (%s% retail, %s% wholesale). | Ang blangkong presyo ay kukuwentahin gamit ang markup ng tindahan (%s% retail, %s% wholesale). | Import modal note |
| `inv.bulk_hint` | Check parts to edit prices, recalculate markup, or change location. | Lagyan ng tsek ang mga piyesa para magbago ng presyo, magkuwenta ng tubo, o magpalit ng pwesto. | Inventory bulk hint |
| `inv.delete_has_sales` | Parts with sales history cannot be deleted. Archive the part instead to hide it from the counter. | Hindi maaaring burahin ang piyesang may benta na. I-archive ito para maitago sa counter. | Delete modal alert |
| `part.gen_barcode` | Create barcode | Gumawa ng barcode | Add/edit part SKU button |
| `pos.tier_retail_tt` | Regular retail price | Karaniwang presyo sa retail | Counter price tier |
| `pos.tier_tech_tt` | Wholesale price for technicians | Presyong wholesale para sa technician | Counter price tier |
| `pos.cust_search_ph` | Customer name or phone (shows unpaid balance) | Pangalan o cellphone (makikita ang utang) | Counter customer input |
| `pos.credit_require_name` | Requires a customer name and phone number. | Kailangan ng pangalan at numero ng customer. | Credit payment subtext |
| `pos.claim_stub_tt` | Print claim stub before repair starts | Mag-print ng stub bago simulan ang repair | Counter claim stub button |
| `pos.search_ph` | Scan barcode or type part (press Enter to add) | I-scan ang barcode o i-type ang piyesa (Enter para idagdag) | Counter part search |
| `credit.settle_partial_note` | Enter amount to pay. Partial payments are accepted. | Ilagay ang ibabayad. Pwedeng magbayad nang hulugan. | Settle credit modal |
| `credit.pin_needed` | Payments over %s require Manager PIN. | Ang bayad na higit sa %s ay kailangan ng Manager PIN. | Credit settlement threshold |
| `returns.search_ph` | Search by receipt number, customer name, or barcode | Maghanap gamit ang resibo, pangalan, o barcode | Returns search input |
| `returns.restock_note` | Returning a part puts it back into inventory stock. | Ang isinauling piyesa ay ibabalik sa stock ng imbentaryo. | Returns action note |
| `settings.markup_note` | Markup applied when importing parts with blank prices or recalculating in bulk. | Tubong idaragdag kapag nag-import ng blangkong presyo o nagkuwenta nang maramihan. | Settings store markup |

---

## 4. Verification & Testing

1. **Unit & API Tests:**
   - Verify import with missing price columns auto-prices new parts according to store settings.
   - Verify import with existing prices keeps existing prices.
   - Verify template generation outputs the sample rows and headers.
   - Run existing test suites (`tests/importer.test.js`, `tests/inventory.test.js`, `tests/server.test.js`).
2. **UI & Accessibility Checks:**
   - Contrast check on all newly added hint text (`>= 4.5:1`).
   - Language toggle (EN <-> TL) translates every newly added hint immediately.
   - Modal focus and keyboard navigation (Escape closes preview modal).
