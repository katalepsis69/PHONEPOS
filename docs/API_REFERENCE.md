# REST API Reference & Specifications

This document defines the complete HTTP REST API interface exposed by [`src/server.js`](file:///c:/Users/sloth/Downloads/phone-repair-pos/src/server.js).

> Completeness disclaimer: this reference covers the main commerce, auth, settings and system routes by intent, but it is not an exhaustive enumeration of every literal path and dynamic matcher in `src/server.js` (for example the update-check/progress routes and parameterized staff, sale and inventory sub-paths). When in doubt, the router in `src/server.js` is the source of truth.

---

## 1. Overview & Conventions

- **Base URL**: `http://localhost:3000/api` (or dynamic port if 3000 is occupied).
- **Format**: All endpoints accept and return `application/json; charset=utf-8`.
- **Standard Error Response**:
  ```json
  {
    "error": "Detailed error explanation message"
  }
  ```
- **HTTP Status Codes**:
  - `200 OK`: Request succeeded.
  - `201 Created`: Resource successfully created.
  - `400 Bad Request`: Validation failure or business logic error.
  - `401 Unauthorized`: Invalid manager PIN or authentication failed.
  - `404 Not Found`: Entity or route not found.
  - `402 Payment Required`: Trial expired and the workstation is not activated.
  - `403 Forbidden`: Session lacks manager elevation (or the factory-PIN gate).
  - `409 Conflict`: Duplicate SKU or an already-signed day/sale.
  - `411 Length Required`: Chunked request bodies are not accepted.
  - `413 Payload Too Large`: Body over the 10MB cap.
  - `429 Too Many Requests`: PIN lockout or rate budget exceeded.
  - `500 Internal Server Error`: Server fault; details only in `pos-server.log`.
  - `502 Bad Gateway`: The Windows print spooler could not be queried.

- **Scope**: sections 2-8 give the commerce core in prose. **Appendix A** below is
  the complete route index: every pattern `src/server.js` matches, with its
  method, gate and a one-line purpose. Where a section above describes a route,
  the appendix row is the index entry, not a second specification; the printing
  and backup chapters of `OPERATIONS_AND_DEPLOYMENT.md` carry the operator-facing
  detail those two areas need.

---

## 2. Inventory Endpoints

### `GET /api/inventory`
Returns a list of inventory items matching optional filters.

**Query Parameters:**
| Parameter | Type | Default | Description |
|---|---|---|---|
| `search` | `string` | `""` | Matches `brand`, `model_name`, `part_type`, or `sku_barcode` |
| `brand` | `string` | `""` | Filters by exact brand name (e.g. `'Apple'`, `'Samsung'`) |
| `low_stock` | `string` | `"false"` | When `"true"`, returns only items where `stock_quantity <= min_stock_alert` |

**Response `200 OK`:**
```json
[
  {
    "id": 1,
    "brand": "Apple",
    "model_name": "iPhone 11",
    "part_type": "LCD (Incell)",
    "sku_barcode": null,
    "cost_price": 650.0,
    "price_retail": 1400.0,
    "price_technician": 1100.0,
    "stock_quantity": 6,
    "min_stock_alert": 2,
    "created_at": "2026-08-27T10:00:00.000Z",
    "updated_at": "2026-08-27T10:00:00.000Z"
  }
]
```

---

### `POST /api/inventory`
Creates a new inventory item in the catalog.

**Request Body:**
```json
{
  "brand": "Samsung",
  "model_name": "Galaxy S21",
  "part_type": "LCD (OLED)",
  "sku_barcode": "SAM-S21-LCD",
  "cost_price": 2200.0,
  "price_retail": 4500.0,
  "price_technician": 3800.0,
  "stock_quantity": 5,
  "min_stock_alert": 2
}
```

**Response `201 Created`:** Returns created inventory object.

---

### `PUT /api/inventory/:id`
Updates fields of an existing inventory item.

**Response `200 OK`:** Returns updated item.

---

### `POST /api/inventory/:id/adjust-stock`
Adjusts inventory stock quantity atomically.

**Request Body:**
```json
{
  "delta": 3
}
```
*Note: `delta` can be positive (restocking) or negative (shrinkage/manual removal).*

**Response `200 OK`:** Returns updated inventory record.

---

### `DELETE /api/inventory/:id`
Deletes an inventory item from the catalog.

**Response `200 OK`:**
```json
{
  "success": true
}
```

---

## 3. Sales & Checkout Endpoints

### `GET /api/sales`
Lists historical sales with pagination and search.

**Query Parameters:**
| Parameter | Type | Default | Description |
|---|---|---|---|
| `limit` | `number` | `50` | Maximum items to return |
| `offset` | `number` | `0` | Offset for pagination |
| `search` | `string` | `""` | Searches sale code, customer name, phone, or payment reference |
| `payment_method` | `string` | `""` | Filter: `'cash'`, `'gcash'`, `'transfer'`, `'credit'` |

**Response `200 OK`:** Array of sale summary objects.

---

### `POST /api/sales`
Part lines are priced by the server from the catalog (dual-tier by `customer_type`);
a client `unit_price` on a `part` line is display state and is ignored. Labor lines
are priced from the client `unit_price`.

Processes a checkout transaction atomically. Checks and decrements inventory, computes totals, and writes line items.

**Request Body:**
```json
{
  "customer_name": "John Doe",
  "customer_phone": "0917-000-0000",
  "customer_type": "retail",
  "payment_method": "gcash",
  "payment_reference": "GC-88392102",
  "discount": 50.0,
  "amount_paid": 1400.0,
  "items": [
    {
      "inventory_id": 1,
      "item_type": "part",
      "quantity": 1
    },
    {
      "inventory_id": null,
      "item_type": "labor",
      "item_name": "Screen Replacement Service",
      "quantity": 1,
      "unit_price": 300.0
    }
  ]
}
```

**Response `201 Created`:**
```json
{
  "id": 12,
  "sale_code": "SALE-3A9B8F1C",
  "customer_name": "John Doe",
  "customer_phone": "0917-000-0000",
  "customer_type": "retail",
  "payment_method": "gcash",
  "payment_reference": "GC-88392102",
  "subtotal": 1700.0,
  "discount": 50.0,
  "total_amount": 1650.0,
  "amount_paid": 1400.0,
  "change_amount": 0.0,
  "credit_balance": 250.0,
  "created_at": "2026-08-27T10:15:00.000Z",
  "items": [
    {
      "id": 20,
      "sale_id": 12,
      "inventory_id": 1,
      "item_type": "part",
      "item_name": "Apple iPhone 11 - LCD (Incell)",
      "unit_cost": 650.0,
      "unit_price": 1400.0,
      "quantity": 1,
      "total_price": 1400.0
    },
    {
      "id": 21,
      "sale_id": 12,
      "inventory_id": null,
      "item_type": "labor",
      "item_name": "Screen Replacement Service",
      "unit_cost": 0.0,
      "unit_price": 300.0,
      "quantity": 1,
      "total_price": 300.0
    }
  ]
}
```

---

### `GET /api/sales/:id`
Fetches full details and line items for a specific sale.

**Response `200 OK`:** Full sale object with `items` array.

---

## 4. Customer Credit Ledger ("Utang") Endpoints

### `GET /api/customers`
Retrieves customer balances, total orders, and debt status.

**Query Parameters:**
| Parameter | Type | Default | Description |
|---|---|---|---|
| `search` | `string` | `""` | Search by customer name or phone |
| `filter` | `string` | `""` | Filter: `'credit'` (active debtors only) or `'clean'` |

**Response `200 OK`:**
```json
[
  {
    "customer_name": "Mark Freelance Tech",
    "customer_phone": "0918-999-5678",
    "sales_count": 4,
    "total_purchases": 8400.0,
    "total_spent_paid": 6000.0,
    "total_credit_balance": 2400.0,
    "last_order_date": "2026-08-27T08:30:00.000Z",
    "credit_date": "2026-08-25T14:20:00.000Z",
    "status": "active_credit"
  }
]
```

---

### `GET /api/customers/:name`
Retrieves detailed profile, complete sale history, and settlement ledger for a specific customer.

---

### `POST /api/customers/:name/settle-credit`
Records a payment towards a customer's debt balance and liquidates open sales in **FIFO order** (oldest first).

**Request Body:**
```json
{
  "amount_paid": 1500.0,
  "payment_method": "cash",
  "payment_reference": "",
  "notes": "Partial settlement for LCD credit"
}
```

**Rules:**
- `payment_reference` is required whenever `payment_method` is `gcash` or `transfer`. A non-cash collection leaves no cash in the drawer, so without a ref there is nothing to check it against.
- Amounts above the shop's `settle_elevation_threshold` (default `500`, set in Settings to Security) require manager elevation.

**Response `200 OK`:** Returns updated customer details object.
**Response `403`:** `{ "error": "Manager authorization required", "code": "elevation_required" }` when the amount is above the threshold and the session is not elevated. The client answers this by prompting for the manager PIN and retrying.

---

### `GET /api/customers/name-variants`
Manager-gated. Lists customer names recorded with more than one spelling (case-insensitive). Reads treat the spellings as one debtor, so this is a review list for the owner, not something the software merges on its own.

**Response `200 OK`:**
```json
[{ "key": "ana lim", "spellings": 2, "variants": ["Ana Lim", "ANA LIM"], "debt": 400.0, "orders": 2 }]
```

## 5. Warranty & RMA Endpoints

### `POST /api/sales/:id/returns`
Processes a warranty return or defect claim against a line item.

**Request Body:**
```json
{
  "sale_item_id": 20,
  "return_type": "replacement",
  "return_reason": "Ghost touch on bottom digitizer",
  "replacement_inventory_id": 1,
  "refund_amount": 0.0,
  "technician_notes": "Tested on bench; defective IC batch"
}
```
*`return_type` options: `'replacement'` (auto-decrements replacement stock), `'cash_refund'` (records cash refund), `'credit_refund'` (reduces sale credit balance).*

**Response `201 Created`:** Returns created warranty return object.

---

### `GET /api/returns`
Lists warranty return claims. Supports `search` and `return_type` query filters.

### `GET /api/returns/:id`
Retrieves return details including linked sale information.

---

## 6. Settings, Backup & Analytics Endpoints

### `GET /api/settings`
Returns public shop settings (GCash details, warranty terms, receipt width, and PIN change indicator).
*Sensitive fields (`manager_pin_hash`, `license_key`, lockout states) are stripped.*

### `POST /api/settings`
Updates shop configuration keys. Protected settings cannot be modified here.

### `GET /api/dashboard`
Manager-gated (elevated) analytics for the Reports & profit tab.
Query: `?period=day|3d|7d|30d|365d` (trailing local calendar-day windows, default `day`) and `?date=YYYY-MM-DD` to pin the daily view to a picked day.
Returns: `current` KPIs (revenue, sale count, avg ticket, gross/net profit, parts vs labor, collections per method), `previous` equal-window KPIs plus percent `deltas`, a per-day `trend` series (per-month for 365d), `products` (per-part units/revenue/profit/margin plus labor totals), `dead_stock` (zero-sale shelf capital with aging), `reorder` (min-stock breaches and low days-of-cover), and `standing` (inventory value + utang book, not window-scoped).

### `GET /api/sync/status`
Cloud-sync agent state: pending/synced outbox counts, last push time, last error, backoff window. Meaningful only when a `sync_url` is configured (Settings → Data tab).

### `GET /api/reconcile/:date`
Manager-gated. `:date` must be a real calendar day in `YYYY-MM-DD`; a shaped-but-impossible date such as `2026-02-30` is refused with `400` because SQLite would otherwise roll it over and report the wrong day.

**Response `200 OK`:** the day's per-method buckets, refund and void totals, and any stored close.
```json
{
  "day": "2026-09-24",
  "buckets": { "cash": { "collected": 500.0, "count": 2 }, "gcash": { "collected": 120.0, "count": 1 } },
  "refund_total": 0.0, "void_count": 0, "gross_sales": 620.0, "expected_cash": 500.0,
  "stored": null
}
```

### `POST /api/reconcile/close-day`
Manager-gated. Signs one calendar day: counts the drawer against `expected_cash` and stores the result. A day can only be signed once.

**Request Body:** `{ "date": "2026-09-24", "counted_cash": 480.0 }` (`date` defaults to today in shop time; `counted_cash` is required and may be zero.)

**Response `201 Created`:** the buckets plus `counted_cash`, `variance` and `status` (`balanced` or `flagged`).
**Response `400`:** missing count, negative amount, bad date, or a day that is already reconciled.

### `GET /api/shifts/:id/breakdown`
Manager-gated. Rolls one drawer's takings up per cashier, so a signed variance can be attributed to who rang the sales rather than to whoever opened the drawer.

**Response `200 OK`:**
```json
[{ "staff_id": 2, "staff_name": "Ben", "sales": 1, "cash_collected": 100.0, "gross": 100.0 }]
```

---

---

### `POST /api/backup`
Creates an immediate timestamped backup of `shop.db` in `backups/`.

### Cloud service (`cloud/server.js`, separate process on a VPS)
- `POST /sync` — shop push, `x-sync-token` header, idempotent upserts keyed by `(shop_id, table, local_id)`.
- `POST /api/login` — manager PIN → 12h session token.
- `GET /api/overview` — shops and mirrored row counts.
- `GET /api/rows?table=X[&shop=Y]` — last 500 mirrored rows of a table.
- `GET /api/analytics?period=day|7d|30d[&shop=Y]` — server-side period analytics over the mirror (same metric formulas as the shop's `/api/dashboard`).
- `GET /events?session=TOKEN` — SSE stream; `change` events on every accepted batch, 25s keep-alive pings.

---

## 7. Security, Auth & Licensing Endpoints

### `GET /api/license/status`
Returns offline license validation status, machine ID, plan type, and days remaining.

### `POST /api/license/activate`
Activates the installation using a vendor-signed cryptographic key (`{ "license_key": "..." }`).

### `POST /api/auth/login`
Authenticates the manager (`{ "pin": "..." }`) or a cashier (`{ "staffId": 1, "pin": "..." }`).
A wrong PIN answers `200 { "valid": false }`; a burned lockout counter answers `400` with
its message. A manager login returns `token`, `actor`, `elevationToken` and `expiresAt`.

### `POST /api/auth/elevate`
Exchanges a fresh manager PIN entry for a signed 15-minute elevation token, which
privileged routes read from the `X-Elevation` header. Refused outright with `403`
while the factory PIN is live. (The old `verify-pin` route no longer exists.)

### `POST /api/auth/change-pin`
Updates manager PIN (`{ "old_pin": "1234", "new_pin": "5678" }`).

### `POST /api/settings/reset-demo`
Manager-elevated action that clears transactions and reseeds initial stock. Every
deleted row is written to the sync outbox as a deletion tombstone, so a
cloud-sync-enabled mirror follows the wipe instead of keeping ghost rows. Like
every destructive manager route (inventory import and bulk-edit, backup restore,
system shutdown, the self-update apply), it refuses while the factory PIN is
live: `403 { "code": "elevation_required" }`.

---

## 8. Self-Update Endpoints

Read and applied by the Settings → Updates panel (and by a silent boot check).
Both routes stay reachable while the trial is expired so a locked workstation
can still be updated.

### `GET /api/system/update/check`
Session-exempt. Asks GitHub for the latest release of `katalepsis69/PHONEPOS` and
returns `{ hasUpdate, currentVersion, latestVersion, notes, downloadUrl, zipUrl,
htmlUrl, expectedBytes, checkError }`. Every URL it returns is re-validated by
`resolveTrustedReleaseUrl` before it is used. Budgeted per client (10 requests
per minute, `429` beyond) so a LAN caller cannot drive outbound GitHub fetches in
a loop.

### `POST /api/system/update/apply`
Manager-elevated, and refused while the factory PIN is live. Body:
`{ "downloadUrl": "https://github.com/katalepsis69/PHONEPOS/releases/download/<tag>/TechPartsPOS.exe", "expectedBytes": 123456 }`.
The download URL must resolve to this repo's release asset (`..` segments,
percent-encoded paths, other repos and other file names are refused), and the
downloaded bytes must hash to `<downloadUrl>.sha256`, fetched over the same
trusted prefix, before anything is written to the staging path. One apply may be
in flight at a time. On success the process exits shortly after answering so the
detached helper can replace the executable and restart it; the audit row
(`system update_apply`) records the outcome, the version and the resolved URL,
never the caller's raw string.

---

## Appendix A: Complete route index

Every pattern `src/server.js` matches, in the order the dispatcher tests them.
**Gate** is what the route requires on top of a valid session:
`session` = any staff or manager session, `elevated` = manager elevation,
`+PIN` = also refuses while the factory PIN is live, `exempt` = reachable
without a session (login screen and the licensed update path), `token` = the
separate read-only report token.

| Method | Route | Gate | Purpose |
|---|---|---|---|
| POST | `/api/report/login` | exempt | Exchange the report PIN for a read-only report token |
| GET | `/api/report/stats` | token | KPI payload for the external report page |
| GET | `/api/report/sales` | token | Sale list for the external report page |
| GET | `/api/inventory` | session | List/search parts (cost columns stripped for staff) |
| POST | `/api/inventory` | elevated | Create a part |
| POST | `/api/inventory/import` | elevated +PIN | CSV import, idempotent by `op_id` |
| POST | `/api/inventory/bulk-edit` | elevated +PIN | Bulk price/markup/field/archive edit, idempotent by `op_id` |
| POST | `/api/inventory/seed-starter` | elevated +PIN | Seed the starter catalog |
| GET | `/api/inventory/barcode/:code` | session | Barcode/SKU lookup |
| POST | `/api/inventory/:id/adjust-stock` | elevated | Stock adjustment, idempotent by `op_id` |
| GET | `/api/inventory/:id/movements` | session | Stock movement ledger for one part |
| POST | `/api/inventory/:id/(archive\|unarchive)` | elevated | Archive or restore a part |
| PUT | `/api/inventory/:id` | elevated | Update a part (409 on a duplicate SKU) |
| DELETE | `/api/inventory/:id` | elevated | Delete a part that has never been sold |
| GET | `/api/sales` | session | List/search sales with paging |
| POST | `/api/sales` | session | Create a sale (transactional; idempotent by `op_id`) |
| GET | `/api/sales/:id` | session | One sale with items |
| POST | `/api/sales/:id/void` | elevated | Void a sale (refuses after refunds or settlement) |
| POST | `/api/sales/:id/reprint` | session | Audited reprint marker |
| POST | `/api/sales/:id/returns` | session | Record a warranty return/RMA |
| GET | `/api/returns` | session | List warranty returns |
| GET | `/api/returns/:id` | session | One return with details |
| GET | `/api/shifts` | session | List shifts (display lanes) |
| POST | `/api/shifts/open` | session | Open a drawer shift |
| POST | `/api/shifts/:id/close` | session | Close a shift with a counted cash figure |
| GET | `/api/shifts/:id/breakdown` | elevated | Per-shift cash breakdown |
| GET | `/api/audit` | elevated | Audit log view |
| GET | `/api/audit/verify` | elevated | Verify the audit hash chain |
| GET | `/api/exceptions` | elevated | Exceptions report |
| GET | `/api/sync/status` | session | Outbox state, pending count, last error |
| GET | `/api/customers` | session | Customer/debtor list |
| GET | `/api/customers/name-variants` | elevated | Same-person name spellings review |
| POST | `/api/customers/:name/settle-credit` | session (elevated above the threshold) | Record a collection |
| GET | `/api/customers/:name` | session | Customer ledger (costs stripped for staff) |
| POST | `/api/customers/:name/limit` | elevated | Set a credit limit |
| GET | `/api/settings` | session | Shop settings (sync URL hidden from staff) |
| POST | `/api/settings` | elevated +PIN | Save settings (validated; `op_id`-free, synchronous save) |
| POST | `/api/settings/pair-cloud` | elevated +PIN | Pair this register with a cloud service |
| POST | `/api/settings/reset-demo` | elevated +PIN | Wipe and reseed demo data |
| GET | `/api/printers` | session | Enumerate print queues (502 when the lookup breaks) |
| POST | `/api/print` | session | Render and send a slip (dedup window; `drawer_kick` override) |
| GET | `/api/dashboard` | elevated | Dashboard KPIs and ranges |
| POST | `/api/reconcile/close-day` | elevated +PIN | Day close |
| GET | `/api/reconcile/:date` | elevated | Reconciliation detail for one date |
| POST | `/api/backup` | elevated | Take a database backup now |
| GET | `/api/backup/list` | elevated | List snapshots with sizes and ages |
| POST | `/api/backup/restore` | elevated +PIN | Restore a snapshot (pre-restore safety snapshot first) |
| GET | `/api/inventory/export` | elevated | Inventory CSV |
| GET | `/api/export/sales.csv` | elevated | Sales CSV |
| GET | `/api/export/customers.csv` | elevated | Customers CSV |
| GET | `/api/license/status` | exempt | Trial/license state |
| POST | `/api/license/activate` | exempt | Activate a license key |
| GET | `/api/auth/staff` | session | Staff list |
| POST | `/api/auth/staff` | elevated | Create a staff account |
| POST | `/api/auth/staff/:id/reset-pin` | elevated | Reset a staff PIN (audited) |
| POST | `/api/auth/staff/:id/deactivate` | elevated | Deactivate a staff account (audited) |
| POST | `/api/auth/login` | exempt | Manager/staff login |
| POST | `/api/auth/elevate` | session | Elevate a session to manager (refused while the factory PIN is live) |
| GET | `/api/auth/session` | session | Current session information |
| POST | `/api/auth/logout` | session | End the session |
| POST | `/api/auth/change-pin` | exempt | Change the manager PIN |
| POST | `/api/system/heartbeat` | exempt | Kiosk heartbeat that feeds the auto-exit watchdog |
| POST | `/api/system/shutdown` | elevated +PIN | Clean shutdown |
| GET | `/api/system/update/check` | exempt (budgeted 10/min per client) | GitHub release check |
| GET | `/api/system/update/progress` | exempt (budgeted 300/min per client) | Read-only update state machine snapshot |
| POST | `/api/system/update/apply` | elevated +PIN | Download, verify and stage an update |

Anything else under `/api/` answers `404 {"error":"Endpoint not found"}`.

### Cloud service (`cloud/server.js`)

| Method | Route | Gate | Purpose |
|---|---|---|---|
| POST | `/sync` | per-shop sync token (120/min) | Idempotent row push-up; the credential selects the tenant |
| GET | `/api/auth-state` | exempt | `pin_set` and `logged_in` for the login screen |
| POST | `/api/setup-pin` | exempt, first run only | Bootstrap the manager PIN (refuses once one exists) |
| POST | `/api/login` | exempt (30/min) | Manager login; refuses while no PIN is set |
| POST | `/api/logout` | exempt | Clear the session cookie |
| POST | `/api/pair` | live pairing code (20/min) | Mint a shop credential; refuses an existing `shop_id` |
| GET | `/events` | manager session | SSE change stream |
| POST | `/api/pairing-code/generate` | manager session | Mint a 6-digit pairing code |
| POST | `/api/create-store` | exempt (30/min), first run only | Bootstrap the first store account; refuses once any claimed store exists |
| GET | `/api/overview` | manager session | Shops, row counts, backup age |
| GET | `/api/standing` | manager session | Outstanding utang, debtor list, inventory value |
| GET | `/api/rows` | manager session | Mirror rows per table (capped at 500) |
| GET | `/api/analytics` | manager session | Period analytics over the mirror |
| DELETE | `/api/shops/:id` | manager session (own store) | Unlink a shop: purge its mirror rows, shops row and credential |
| POST | `/api/deploy` | manager session, default store only (30/min) | Push cloud-deploy source to the running server; writes a deploy log and `.prev` rollback copies |
