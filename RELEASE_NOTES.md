# What is New in TechParts POS (v2.6)

Here is a simple summary of all the new features and improvements in this release, written for shop owners and cashiers.

### Highlights in this update:
- Verified: system-wide ergonomics: visual comfort tokens, panel & stat elevation
- Verified: repair counter: tactile in-stock filter pill and stock badges
- Verified: repair counter: unit icon badge and checkout CTA calm idle state

---

### 1. Simple Spreadsheet Import (Excel & CSV)
Import your phone parts catalog in seconds without having to manually match columns.

* **How it works:**
  - Go to **Inventory** and click **Import**.
  - Choose any Excel (.xlsx) or CSV file. The system automatically detects your column headers (Brand, Model, Part Type, Cost, Prices, Stock, Supplier, Location).
  - Preview the parts on screen to make sure everything looks right, then click **Import**.

* **Automatic Price Calculation:**
  - If you only have your purchase or cost price, you can leave the Retail and Wholesale price columns blank in your spreadsheet.
  - The system will automatically calculate selling prices using your store markup percentages (for example: 50% retail and 20% wholesale).
  - Calculated prices are clearly marked with an **auto** badge in the preview so you can double-check them before saving.

* **Where to Adjust Markups:**
  - You can change your default markup percentages anytime. Click the **Settings > Store** button directly inside the import preview, or open the **Settings** gear icon on the left menu and select the **Store** tab.

* **1-Click Spreadsheet Template:**
  - Click **Template** on the Inventory screen to download a ready-to-fill CSV file.
  - Includes clear example rows showing both manual prices and auto-calculated prices.

---

### 2. Helpful Tips Across Counter & Screens (Bilingual)
We added friendly explanations across the workstation so you and your staff always know what every button and feature does.

* **Clear Guidance:** Helpful tips next to parts search, customer search, retail vs wholesale price tier pills, claim stubs, returns, and bulk editing.
* **English & Tagalog:** Switch languages anytime with a single click in the top navigation bar. Every hint is written in plain, everyday language.

---

### 3. Bulk Parts Editor
Need to change prices or update multiple parts at the same time?

* **How it works:**
  - In **Inventory**, check the boxes next to the parts you want to change.
  - Use the bulk toolbar at the bottom to adjust prices by a fixed amount or percentage, recalculate prices from cost, change storage bins, or archive old parts in one click.

---

### 4. Fast Counter & Thermal Receipt Printing
* **Receipts & Claim Stubs:** Prints clear customer slips on standard 58mm and 80mm thermal receipt printers.
* **Automatic Cash Drawer Kick:** Connected cash drawers open automatically when completing a cash transaction.
* **Print Backup:** If the thermal printer is ever unplugged or out of paper, receipts smoothly fall back to your standard computer print dialog.

---

### 5. 100% Offline with Automatic Daily Backups
* **Zero Internet Required:** Ring up sales, look up inventory, and manage repair jobs completely offline.
* **Automatic Peace of Mind:** Your database automatically backs up locally every day you use the system. You can also export full backups anytime from **Settings > Data**.

---

### 6. Repair Counter Keyboard Shortcuts (For Fast Checkout)
Cashiers can ring up sales and handle repair jobs rapidly using keyboard shortcuts without touching the mouse:

* **Tab Navigation:**
  - `F1`: Switch to Repair Counter (POS) / New Repair
  - `F2`: Switch to Customer Credit ("Utang") Ledger
  - `F3`: Switch to Inventory
  - `F4`: Switch to Warranty & Returns
  - `F8`: Switch to Sales History
  - `F7`: Switch to Audit Log (Manager only)

* **Finding Parts & Customers:**
  - `/`: Jump directly to the parts search and barcode box
  - `Ctrl + K` or `Ctrl + F`: Open global search palette
  - `Alt + C`: Jump to Customer Name field
  - `Alt + T`: Toggle Retail vs Wholesale price tier
  - `Alt + N`: Add or open Job Note (faults, unlock code, physical condition)
  - `Alt + A`: Add a brand new part to inventory

* **Payment & Checkout:**
  - `Alt + 1`: Select Cash payment (jumps to Tendered Amount)
  - `Alt + 2`: Select GCash payment (jumps to GCash Reference #)
  - `Alt + 3`: Select Customer Credit / Utang (jumps to Downpayment)
  - `Alt + 4`: Select Bank Transfer (jumps to Transfer Reference #)
  - `Alt + E`: Exact Amount (automatically enters the exact total due)
  - `F9`: Complete Sale and Print Receipt (or finalize repair order)

* **Holding Jobs & Stubs:**
  - `Alt + P`: Print Claim Stub before the repair starts
  - `Alt + H`: Hold current job as a draft (frees counter for the next customer)
  - `Alt + R`: Resume previously held job
  - `Alt + X`: Clear cart / cancel current order
  - `Escape`: Close any open window or confirmation dialog

---

### How to Update

* **If you already have TechParts POS:**
  1. Open the system and go to **Settings** (gear icon) > **Data**.
  2. Click **Check for updates**.
  3. When the new version appears, click **Update Now**. The system safely updates itself and restarts with all your shop data preserved.

* **If this is a fresh installation:**
  1. Download `TechPartsPOS-v2.6.zip` below.
  2. Extract the folder to your computer (e.g. `C:\TechPartsPOS`).
  3. Double-click `TechPartsPOS.exe` to start.
