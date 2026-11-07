# Database Schema & Migration Reference

This document provides the data dictionary (the money tables in full, the operational tables in abbreviated form below), the relational model, PRAGMA configuration, and schema migration mechanics for the embedded SQLite database ([`src/db.js`](file:///c:/Users/sloth/Downloads/phone-repair-pos/src/db.js)) plus the cloud mirror ([`cloud-deploy/server.js`](file:///c:/Users/sloth/Downloads/phone-repair-pos/cloud-deploy/server.js)).

---

## 1. Engine Configuration & Storage

- **Database Engine**: Native SQLite embedded via Node.js `node:sqlite` (`DatabaseSync`).
- **File Location**: `data/shop.db` (resolved relative to the executable path or application root).
- **PRAGMAs Applied**:
  - `PRAGMA foreign_keys = ON;` (Enforces referential integrity and cascading deletes).
  - `PRAGMA journal_mode = WAL;` (Enables Write-Ahead Logging for high-concurrency read operations and atomic transactions).

---

## 2. Entity Relationship Diagram

```mermaid
erDiagram
    inventory ||--o{ sale_items : "referenced by"
    sales ||--|{ sale_items : "contains"
    sales ||--o{ warranty_returns : "originates"
    sale_items ||--o{ warranty_returns : "claims against"
    sales ||--o{ credit_payments : "settled via customer_name"

    inventory {
        INTEGER id PK
        TEXT brand
        TEXT model_name
        TEXT part_type
        TEXT sku_barcode UK (COLLATE NOCASE, partial: WHERE NOT NULL)
        REAL cost_price
        REAL price_retail
        REAL price_technician
        INTEGER stock_quantity
        INTEGER min_stock_alert
        DATETIME created_at
        DATETIME updated_at
    }

    sales {
        INTEGER id PK
        TEXT sale_code UK
        TEXT customer_name
        TEXT customer_phone
        TEXT customer_type
        TEXT payment_method
        TEXT payment_reference
        REAL subtotal
        REAL discount
        REAL total_amount
        REAL amount_paid
        REAL change_amount
        REAL credit_balance
        DATETIME created_at
    }

    sale_items {
        INTEGER id PK
        INTEGER sale_id FK
        INTEGER inventory_id FK
        TEXT item_type
        TEXT item_name
        REAL unit_cost
        REAL unit_price
        INTEGER quantity
        REAL total_price
    }

    warranty_returns {
        INTEGER id PK
        TEXT return_code UK
        INTEGER sale_id FK
        INTEGER sale_item_id FK
        TEXT customer_name
        TEXT item_name
        INTEGER quantity
        TEXT return_type
        TEXT return_reason
        INTEGER replacement_inventory_id FK
        REAL refund_amount
        TEXT technician_notes
        DATETIME created_at
    }

    credit_payments {
        INTEGER id PK
        TEXT customer_name
        REAL amount_paid
        TEXT payment_method
        TEXT payment_reference
        TEXT notes
        DATETIME created_at
    }

    shop_settings {
        TEXT key PK
        TEXT value
    }
```

---

## 3. Data Dictionary

### 3.1 `inventory`
Stores the phone repair parts catalog, barcode mapping, dual-tier pricing, and stock levels.

| Column | Type | Constraints | Default | Description |
|---|---|---|---|---|
| `id` | `INTEGER` | `PRIMARY KEY AUTOINCREMENT` | - | Unique part record ID |
| `brand` | `TEXT` | `NOT NULL` | - | Manufacturer/Brand (e.g., Apple, Samsung, Xiaomi) |
| `model_name` | `TEXT` | `NOT NULL` | - | Phone model (e.g., iPhone 11, Galaxy A12) |
| `part_type` | `TEXT` | `NOT NULL` | - | Part classification (e.g., LCD (OLED), Battery, Incell) |
| `sku_barcode` | `TEXT` | `UNIQUE COLLATE NOCASE` (partial index: `WHERE NOT NULL`) | `NULL` | Optional barcode or internal SKU. The index is case-insensitive, so `abc` and `ABC` collide; at boot a legacy duplicate is renamed to `<SKU>-<row id>` (in one transaction, probing for a free suffix) instead of refusing to open, and every stored value is upper-cased and trimmed |
| `cost_price` | `REAL` | `NOT NULL` | `0.0` | Acquisition/supplier cost in PHP |
| `price_retail` | `REAL` | `NOT NULL` | `0.0` | Standard walk-in customer price in PHP |
| `price_technician` | `REAL` | `NOT NULL` | `0.0` | Discounted wholesale/technician price in PHP |
| `stock_quantity` | `INTEGER` | `NOT NULL` | `0` | Current available on-hand stock |
| `min_stock_alert` | `INTEGER` | `NOT NULL` | `3` | Threshold to trigger low-stock warning |
| `supplier` | `TEXT` | `NOT NULL` | `''` | Supplier name (free text) |
| `location` | `TEXT` | `NOT NULL` | `''` | Physical location (shelf or bin label) |
| `archived` | `INTEGER` | `NOT NULL` | `0` | `1` when archived: hidden from the shelf, kept for history |
| `created_at` | `DATETIME` | - | `CURRENT_TIMESTAMP` | Initial creation timestamp |
| `updated_at` | `DATETIME` | - | `CURRENT_TIMESTAMP` | Timestamp of last modification/stock adjustment |

---

### 3.2 `sales`
Header records for POS checkouts, payment breakdowns, and credit balances.

| Column | Type | Constraints | Default | Description |
|---|---|---|---|---|
| `id` | `INTEGER` | `PRIMARY KEY AUTOINCREMENT` | - | Unique sale ID |
| `sale_code` | `TEXT` | `UNIQUE NOT NULL` | - | Human-readable identifier (e.g., `SALE-A1B2C3D4`) |
| `customer_name` | `TEXT` | `NOT NULL` | `'Walk-in Customer'` | Customer or technician name |
| `customer_phone` | `TEXT` | - | `''` | Contact number for updates/warranty |
| `customer_type` | `TEXT` | `NOT NULL` | `'retail'` | Customer tier: `'retail'` or `'technician'` |
| `payment_method` | `TEXT` | `NOT NULL` | `'cash'` | Method: `'cash'`, `'gcash'`, `'transfer'`, `'credit'` |
| `payment_reference`| `TEXT` | - | `''` | Reference ID for GCash or Bank Transfer |
| `staff_id` | `INTEGER` | - | `NULL` | Cashier who rang the sale; `NULL` for a manager session |
| `voided` | `INTEGER` | `NOT NULL` | `0` | `1` once voided: excluded from all takings, stock already restored |
| `void_reason` | `TEXT` | - | `''` | Manager's reason, required at void time |
| `op_id` | `TEXT` | `UNIQUE` where not null | `NULL` | Client idempotency key; a retry with the same key replays the original sale |
| `subtotal` | `REAL` | `NOT NULL` | - | Gross total of all line items before discount |
| `discount` | `REAL` | `NOT NULL` | `0.0` | Order-level discount amount |
| `total_amount` | `REAL` | `NOT NULL` | - | Net payable amount (`subtotal - discount`) |
| `amount_paid` | `REAL` | `NOT NULL` | - | Amount tendered/paid at checkout |
| `change_amount` | `REAL` | `NOT NULL` | `0.0` | Cash change returned to customer |
| `credit_balance` | `REAL` | `NOT NULL` | `0.0` | Outstanding debt balance (`total_amount - amount_paid`) |
| `created_at` | `DATETIME` | - | `CURRENT_TIMESTAMP` | Checkout timestamp |

---

### 3.3 `sale_items`
Individual line items attached to a sale. Supports both physical inventory parts and service labor.

| Column | Type | Constraints | Default | Description |
|---|---|---|---|---|
| `id` | `INTEGER` | `PRIMARY KEY AUTOINCREMENT` | - | Unique line item ID |
| `sale_id` | `INTEGER` | `NOT NULL REFERENCES sales(id) ON DELETE CASCADE` | - | Parent sale reference |
| `inventory_id` | `INTEGER` | `REFERENCES inventory(id)` | `NULL` | Linked inventory item (`NULL` for service labor) |
| `item_type` | `TEXT` | `NOT NULL` | `'part'` | `'part'` (physical stock) or `'labor'` (service) |
| `item_name` | `TEXT` | `NOT NULL` | - | Snapshot description of the item/service |
| `unit_cost` | `REAL` | `NOT NULL` | - | Part cost at time of sale (0.0 for labor) |
| `unit_price` | `REAL` | `NOT NULL` | - | Price charged per unit |
| `quantity` | `INTEGER` | `NOT NULL` | - | Quantity sold |
| `total_price` | `REAL` | `NOT NULL` | - | Line total (`unit_price * quantity`) |

---

### 3.4 `warranty_returns`
RMA claims, defect replacements, and refund audits.

| Column | Type | Constraints | Default | Description |
|---|---|---|---|---|
| `id` | `INTEGER` | `PRIMARY KEY AUTOINCREMENT` | - | Unique return record ID |
| `return_code` | `TEXT` | `UNIQUE NOT NULL` | - | Identifier (e.g., `RMA-8F9E0D1A`) |
| `sale_id` | `INTEGER` | `NOT NULL REFERENCES sales(id)` | - | Original sale ID |
| `sale_item_id` | `INTEGER` | `NOT NULL REFERENCES sale_items(id)` | - | Line item claimed under warranty |
| `customer_name` | `TEXT` | `NOT NULL` | - | Customer name |
| `item_name` | `TEXT` | `NOT NULL` | - | Name of returned part |
| `quantity` | `INTEGER` | `NOT NULL` | `1` | Returned quantity |
| `return_type` | `TEXT` | `NOT NULL` | - | `'replacement'`, `'cash_refund'`, `'credit_refund'` |
| `return_reason` | `TEXT` | `NOT NULL` | - | Defect description (ghost touch, lines, dead) |
| `replacement_inventory_id` | `INTEGER` | - | `NULL` | Inventory ID of replacement stock issued |
| `refund_amount` | `REAL` | `NOT NULL` | `0.0` | Monies refunded or credit balance reduced |
| `technician_notes`| `TEXT` | - | `''` | Diagnostic observations & bench test notes |
| `op_id` | `TEXT` | `UNIQUE` where not null | `NULL` | Client idempotency key; a retry with the same key replays the original RMA |
| `created_at` | `DATETIME` | - | `CURRENT_TIMESTAMP` | Return creation timestamp |

---

### 3.5 `credit_payments`
Customer debt settlement ledger entries ("Utang" payments).

| Column | Type | Constraints | Default | Description |
|---|---|---|---|---|
| `id` | `INTEGER` | `PRIMARY KEY AUTOINCREMENT` | - | Payment record ID |
| `customer_name` | `TEXT` | `NOT NULL` | - | Debtor customer name |
| `amount_paid` | `REAL` | `NOT NULL` | - | Amount paid towards outstanding debt |
| `payment_method` | `TEXT` | `NOT NULL` | `'cash'` | Payment method (`'cash'`, `'gcash'`, `'transfer'`) |
| `payment_reference`| `TEXT` | - | `''` | Transaction reference ID |
| `notes` | `TEXT` | - | `''` | Settlement remarks |
| `op_id` | `TEXT` | `UNIQUE` where not null | `NULL` | Client idempotency key; a retry with the same key replays the original payment |
| `created_at` | `DATETIME` | - | `CURRENT_TIMESTAMP` | Payment timestamp |

---

### 3.6 `shop_settings`
Key-value store for shop branding, thermal receipt config, manager auth hash, and license keys.

| Key | Default Value | Description |
|---|---|---|
| `gcash_name` | `'TechParts Repair & POS'` | Account name for GCash QR payments |
| `gcash_number` | `'0917-123-4567'` | GCash mobile number |
| `gcash_qr_url` | `''` | Optional custom GCash QR image URL |
| `receipt_paper_width` | `'80mm'` | Thermal printer width (`'58mm'` or `'80mm'`) |
| `warranty_days` | `'7'` | Default warranty duration |
| `warranty_policy_text`| `'7 Days Test Warranty for LCDs & Batteries...'` | Terms printed at bottom of receipt |
| `shop_footer_note` | `'Thank you for your business!...'` | Receipt footer message |
| `license_key` | `''` | Ed25519 cryptographic activation key |
| `manager_pin_hash` | PBKDF2-HMAC-SHA-256 record | Salted manager security PIN; legacy SHA-256 rows upgrade after login |
| `settle_elevation_threshold` | `'500'` | Collections above this amount need manager elevation |

---

### 3.7 `cash_adjustments`
Money that moves today against a period somebody already signed: a void of a sale inside a closed drawer or a reconciled day. The signed period is never rewritten, so today's count absorbs the payout and the exceptions panel flags both ends.

| Column | Type | Constraints | Default | Description |
|---|---|---|---|---|
| `id` | `INTEGER` | `PRIMARY KEY AUTOINCREMENT` | - | Adjustment ID |
| `amount` | `REAL` | `NOT NULL` | - | Signed cash effect on the drawer (negative pays cash out) |
| `reason` | `TEXT` | `NOT NULL` | - | Human-readable cause, e.g. `Void of SALE-… after shift close` |
| `ref` | `TEXT` | - | `''` | Sale code that triggered the adjustment |
| `source_kind` | `TEXT` | - | `''` | Origin type (`sale_void`) |
| `source_id` | `INTEGER` | - | `NULL` | Origin row ID |
| `created_at` | `TEXT` | `NOT NULL` | - | ISO-Z timestamp of the movement, i.e. today |

*Not profiled here:* `staff`, `audit_log`, `shifts`, `stock_movements`, `customer_profiles`, `day_reconciliations` and `sync_outbox`. This dictionary covers the money tables in full and the operational tables in abbreviated form in 3.8; all follow the same conventions (ISO-Z timestamps, guarded migrations). The three rows below are `shop_settings` keys, not columns of the table that follows.
| `last_backup_date` | `''` | ISO date of last automatic daily backup |
| `pin_lockout_until` | `0` | Epoch timestamp of anti-brute-force lockout |
| `pin_failed_attempts` | `0` | Counter of sequential failed PIN entries |

### 3.8 Operational tables (abbreviated)

Defined in `src/db.js`; read `src/sync.js` and `src/server.js` for the write paths.

- `stock_movements` - append-only stock ledger: `inventory_id`, `delta`, `reason` (receive, sale, void, correction, ...), `note`, `ref` (sale code), `created_at`. Indexed by `(inventory_id, id)`.
- `customer_profiles` - one row per customer, `customer_name` `PRIMARY KEY COLLATE NOCASE`, `credit_limit`, `phone`, `notes` (never leaves the shop), `created_at`/`updated_at`. Synced by folded name with the implicit rowid as `local_id`.
- `shifts` - drawer shifts: `staff_id` (no FK on purpose), `staff_name`, `opened_at`, `opening_float`, `closed_at`, `counted_cash`, `expected_cash`, `variance`, `status`.
- `day_reconciliations` - one signed row per local day (`day` `UNIQUE`): per-method `buckets` JSON, `counted_cash`, `expected_cash`, `variance`, `status`, `signed_by`, `created_at`. A day close refuses a re-close.
- `staff` - cashier accounts: `name` (`COLLATE NOCASE`), `pin_hash` (PBKDF2), `active`, timestamps.
- `audit_log` - append-only trail with a hash chain: `category`, `action`, `actor_json`, `ok`, `detail`, `row_hash`, `prev_hash`. Verified paged by `src/audit.js`.
- `op_log` - write-dedup keys for inventory mutations (adjustments, CSV rows, part creation, bulk edits), pruned after 2 days.
- `sync_outbox` - the push queue: `table_name`, `local_id`, `payload` (full row JSON), `created_at`, `synced_at` (null until the cloud acks). Partial index on unsynced rows; pruned 30 days after sync, and 30 days after creation while sync is off.

### 3.9 Cloud mirror (`cloud-deploy/server.js`)

The VPS holds its own SQLite database (`cloud.db`) with two tables:

- `shops` - one row per paired register: `shop_id` (the workstation's stable id), `store_id` (tenant), `shop_name`, `first_seen`, `last_seen` (refreshed by every push and by the empty-batch heartbeat).
- `shop_rows` - the mirror itself, keyed `PRIMARY KEY (shop_id, table_name, local_id)`: `table_name` (the ten whitelisted tables), `local_id` (the workstation's row id), `row_json` (full row snapshot), `updated_at`. Upserts are idempotent, so retries and a full re-pair backfill are safe. Manager routes read it with `json_extract`; per-tenant scoping comes from the session's `store_id`.

---

## 4. Migration & Versioning Strategy

Schema changes ship as **guarded `ALTER TABLE` statements** in `src/db.js`, run on every open. There is no `PRAGMA user_version` migration list; `CREATE TABLE IF NOT EXISTS` cannot extend an existing table, so each new column is added conditionally:

1. **Fresh Database Initialization**: the full schema runs as-is; every guarded ALTER is a no-op because the columns already exist.
2. **Existing Databases (Field Upgrades)**:
   - `PRAGMA table_info(<table>)` lists the columns the database actually has.
   - Any missing column is added with `ALTER TABLE <table> ADD COLUMN ...` (e.g. `sales.voided`, `sales.op_id`, `warranty_returns.op_id`, `credit_payments.op_id`, `inventory.archived`).
   - Follow-up statements (`CREATE UNIQUE INDEX IF NOT EXISTS ... WHERE ...`, hash backfills) are all idempotent, so opening the same database twice changes nothing.
   - A failing step aborts initialization and the error surfaces before the server listens.
