# Audit Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Execute Wave by Wave in Section 2; do not start Section 1 items until the matching decision is answered.

**Goal:** Close the defects found in the full-system audit of the TechParts POS, without regressing the 207-test suite or changing the offline-first, zero-runtime-dependency architecture.

**Architecture:** The audit produced 64 numbered findings (F1-F64) plus 10 UI rule findings (U1-U10). F64 is repo hygiene, added while compiling this plan. They split into two kinds. Most are local, provable fixes that can be batched and executed in order: these are **Section 2, no planning needed**. The rest are not really code problems, they are unanswered product questions whose code shape depends on the answer, so writing the fix first would be guessing: these are **Section 1, needs planning first**. Section 1 is listed first because nine of its decisions change what Section 2 items become.

**Tech Stack:** Node.js native (`node:http`, `node:sqlite`, `node:crypto`, `node:fs`), Vanilla JS ES6+ SPA, Tailwind CSS v4, native `node --test`.

**Evidence base:** Every finding below cites `file:line` and is labeled CONFIRMED (proven by reading or by running a probe against a throwaway database) or SUSPECTED (needs runtime verification). Nothing is fixed yet. The full audit report with measurements lives in the conversation that produced this plan; the numbers quoted here are from it.

## Global Constraints

- Zero external runtime npm dependencies. `node:*` stdlib only. Do not add a package to fix a finding.
- `npm test` must stay at 207/207 passing after every wave, and each fix in Section 2 adds the test that proves it.
- 100% backward compatibility for existing databases: any schema change goes through the guarded `PRAGMA table_info` + `ALTER TABLE` pattern already used at `src/db.js:262-269` and `src/db.js:296-316`, never a destructive migration.
- Offline-first is non-negotiable: no fix may put a network call on the sale path or make a cloud failure block or roll back a local transaction.
- The design envelope is one workstation per shop, 1-5 staff, under 500 SKUs, low thousands of sales per year. Do not add locking, pooling, caching or pagination for load the product will not see.
- Judge every change against that envelope. Performance findings are not in this plan because the audit measured the hot paths as clean (5000-row audit chain verify: 37-48 ms).
- Append-only audit history is a deliberate control (`src/db.js:179-182`). Do not add a delete path to fix size problems; change what gets written instead.
- No em dash characters in any user-facing string. `R-02` is a Hard Gate.

## Operating scale and what was measured

Pre-revenue product, dev databases hold 0-17 parts and 0-4 sales. Measured during the audit, so these are facts and not estimates:

| Probe | Result |
|---|---|
| Two-line carts where the client total disagrees with the server | 313 of 1176 (27%) |
| Carts where the client refuses exact cash | 48 of 1176 (4%) |
| `audit_log.detail` written by one GCash QR settings save | 6.5 MB, undeletable by design |
| `/api/audit` page size carrying that row | 6.5 MB |
| FIFO settlement (333.33 + 666.66 + 333.33, paid 500.01) | exact, 0 / 499.98 / 333.33, no drift |
| `isDefaultPin()` cost, before and after the PIN is changed | 30.7 ms and 31.7 ms (comment claims it is free after the change) |
| `verifyChain` over 5000 audit rows | 37, 43, 48 ms |
| Manual backups in `backups/` vs pruned daily backups | 216 files vs 6 files |
| Lines of production code unreachable from any route | about 150 (`src/reconcile.js`, `src/holds.js`, sql.js shim branches) |

---

# SECTION 1: NEEDS PLANNING FIRST

**These nine items are blocked on a decision, not on effort.** Each has an open question, numbered options, and a recommendation. Answer with the shortest form that works, for example `D1: 2, D2: 1, D3: 2, ...`, and this plan becomes executable end to end.

> ### **D1. Is day reconciliation a feature or dead code?**  ***BLOCKS: F46, F5, D2, F61***
> `src/reconcile.js` (62 lines), the `day_reconciliations` table (`src/db.js:235-245`) and its unique index are imported by **no route in `src/server.js`**. The table has 0 rows in every database in the tree. Meanwhile `getDayBuckets` (`src/reconcile.js:7-36`) contains the better of the two drawer implementations: per-method buckets, refunds, void count, and a documented fix for a real bug it once had. The live path uses the thinner `analytics.getExpectedCash` (`src/analytics.js:7-26`), which has no per-method breakdown.
> **Consequence of doing nothing:** two implementations of one rule, one of them rotting unseen, and the README's "daily payment reconciliation" claim (F61) is not true.
> 1. Delete `src/reconcile.js`, the table and the index. Accept that the product reconciles per shift, not per day, and correct the README.
> 2. **Recommended.** Wire it up: `POST /api/reconcile/close-day` and `GET /api/reconcile/:date`, elevation-gated, plus a day-close screen. Then make `analytics.getExpectedCash` call `getDayBuckets` so there is one rule, and the live shift math inherits the better version.
> 3. Keep the module as the single source of truth but never expose it; refactor `getExpectedCash` onto it and delete the dead HTTP-less surface.
> *Verify before choosing:* grep `require('./reconcile')` in `src/` (expect: no hits outside tests) and click every screen looking for a day-close control. If one exists I have misread the code and D2 becomes urgent.

> ### **D2. What happens when money moves across a closed till?**  ***BLOCKS: F5, depends on D1***
> CONFIRMED by running it. A shift closed at `expected_cash 1000, variance 0`, then the sale inside it is voided with no error. The stored shift row is unchanged while the drawer is now 500 short. `getExceptions` reads the *stored* variance (`src/analytics.js:500`), so it reports clean on a wrong number, in both directions at once. The seeded reason label for this is literally "Wrong item / clerk error" (`src/db.js:349`), so it is an intended workflow.
> 1. Block: reject a void or refund whose `created_at` falls inside a closed shift or reconciled day, and tell the user to file a warranty return instead (which does produce a dated cash entry).
> 2. **Recommended.** Compensate: allow it, but write a cash adjustment dated *today* so the current drawer absorbs it, and flag both periods in the exceptions panel. Preserves the real workflow, keeps history honest, and makes the second exception visible instead of silent.
> 3. Allow with a recompute: re-open and recompute any touched closed shift. Simplest, but it rewrites numbers a human already signed, which is the thing a till report exists to prevent.
> *Decision shape:* this is "can the shop edit the past", which only the owner can answer.

> ### **D3. One customer or two when the typing differs?**  ***BLOCKS: F4, F19***
> CONFIRMED by running it. Settlement and FIFO allocation match `customer_name` **case-sensitively** (`src/credits.js:125-129`, column has no collation, `src/db.js:95`), while the credit-limit check matches **case-insensitively** (`src/sales.js:90,93` uses `COLLATE NOCASE`) and `customer_profiles` is `PRIMARY KEY COLLATE NOCASE`. Result: "JOHN DOE" and "John Doe" become two debtors of 1000 each; settling "John Doe" for 1200 is refused because that spelling only owes 1000; the limit block sums both. The customer's real debt cannot be cleared under the name being typed.
> 1. Add `COLLATE NOCASE` to `sales.customer_name` and `credit_payments.customer_name`. SQLite cannot add a collation to an existing column, so this means table rebuild in a guarded migration.
> 2. **Recommended.** Normalize on write and backfill once: one case rule applied in `str()`/`trim()` at insert, plus a guarded `UPDATE` backfill, plus a duplicate-name report the shop reviews *before* the backfill runs. Then all three call sites agree by construction and no table rebuild is needed.
> 3. Full fix: introduce a `customers` table with a surrogate id and make name a display attribute. Correct long term and the only real answer to F19 (two different people, same name), but it is the largest schema change in this plan.
> *Do not skip the pre-backfill report.* Auto-merging names silently consolidates one person's debt onto another's.

> ### **D4. Can a cashier write off a debt without a manager?**  ***BLOCKS: F23, F24***
> CONFIRMED by reading. `POST /api/customers/:name/settle-credit` needs only a session (`src/server.js:535-540`) while void (`:444`), cash refund (`:462`), credit limit (`:551`) and every inventory write all require elevation. The limit is gated, the collection is not. Worse, `getExpectedCash` counts settlements only when `payment_method = 'cash'` (`src/analytics.js:18`), and `SETTLE_METHODS` accepts gcash and transfer (`src/credits.js:105`), so a fictitious settlement recorded as **gcash** reduces the debt while expected cash is unchanged. The drawer balances perfectly. That is the classic utang-book embezzlement, and it is invisible to the only automated check.
> 1. Require elevation for every settlement. Safest, and slows the counter down for something that happens constantly.
> 2. **Recommended.** Require elevation above a shop-set amount threshold, and make `payment_reference` mandatory whenever the method is gcash or transfer. Closes the invisible path (a reference can be checked) without taxing small routine payments.
> 3. No gate, but report it: add a "settlements with no reference, by staff, by day" panel to the exceptions view. Detective rather than preventive, which is weaker than what every neighbouring operation already gets.
> *Also decide:* whether `replacement` and `credit_refund` RMAs need elevation independent of D4 (F24 is the same question about stock instead of debt; Section 2 Wave 1 assumes yes).

> ### **D5. Where does the app put its data, and what ships to a customer?**  ***BLOCKS: F38***
> CONFIRMED by direct observation. `getBaseDir()` resolves to `dirname(process.execPath)` (`src/db.js:26-41`), so the exe creates `data/` and `backups/` beside itself. `release/customer/data/shop.db` and `release/customer/backups/` exist in this tree right now, created after the last build, and that database opens and holds real rows. The release hygiene check runs at build time only, and the deployment doc says "copy only `release/customer/`".
> 1. Add a copy-time re-check in `scripts/release-customer.js` and refuse to copy a dirty folder. Cheap, but the next local smoke run silently re-dirties it.
> 2. **Recommended.** 1 plus: when the exe starts from a folder that looks like a release dir, fall back to `%LOCALAPPDATA%\TechPartsPOS`. The writable-fallback already exists at `src/db.js:36-39`; it just only triggers on read-only bases today.
> 3. Always store data in `%LOCALAPPDATA%`, never beside the exe. Cleanest, and the honest answer for a per-seat commercial product, **but it changes where every existing install's database lives**, so it needs a one-time move plus a "your data moved here" screen.
> *Why this needs you and not me:* option 3 can strand a shop's data if the migration is wrong. That risk is a product call.

> ### **D6. How much disaster recovery is the product's job?**  ***BLOCKS: F39, F41***
> CONFIRMED by reading. `runDailyBackup` has exactly one production call site, inside the `listen` callback (`src/server.js:1017-1023`); the only `setInterval`s in the file are sync and the exit watchdog. So on a workstation left running for days, which is the normal posture, **the data-loss window grows with uptime, not 24 hours**. Backups land in `backups/` on the same physical disk as `data/shop.db`. Zero `integrity_check` or `quick_check` anywhere in the tree, and no restore drill. Manual backups (`shop_backup_*`, `src/server.js:858`) are never pruned because retention matches `startsWith('shop-')` (`:885`) and the underscore never matches: 216 files against 6.
> 1. Fix only the cheap halves: hourly timer on the already date-idempotent guard, prune both filename prefixes, and `PRAGMA integrity_check` the temp backup before the rename.
> 2. **Recommended.** 1 plus a documented, scripted off-machine step (robocopy to a second disk or a network share) and an in-app "last successful backup" age warning on the dashboard when it exceeds a threshold.
> 3. 2 plus automatic offsite: also push the backup to the configured cloud endpoint. Best protection, and it expands what leaves the shop, which cuts against the offline-first promise.
> *Worth stating plainly:* option 1 leaves a shop one disk failure from losing everything, because copy and original share the disk.

> ### **D7. What is the exposure posture for anything reachable off the box?**  ***BLOCKS: F22, F26, F28***
> Three related facts. The factory PIN `1234` is only prompted against, never required, and while it is live the elevation requirement is *relaxed* on `POST /api/settings` and `change-pin` (`src/server.js:564,766`, the `(!elevated && !isDefaultPin(db))` short-circuit). Blast radius is bounded by the `EDITABLE_SETTINGS` allowlist (`src/settings.js:17-21`), so the private keys are safe and what an attacker at the machine can do is reset the PIN to 1234 and rewrite the shop name, GCash number and warranty text that print on customers' receipts. The manager-PIN lockout is global and shared with `/api/report/login` (`src/auth.js:4-5`, `src/server.js:302-320`), so once `HOST=0.0.0.0` is set for the phone report any LAN client can lock the manager out of the register indefinitely: 5 posts, 60 seconds, repeat, and the cross-origin guard passes legitimately because it is same-origin. And the workstation is plaintext `http.createServer` (`src/server.js:202`) while `/api/report/sales` returns up to 500 rows of customer names, phone numbers and debt balances for a 24-hour rotating bearer token.
> 1. Minimum: reject elevation while the factory PIN is live, and give the report namespace its own attempt counter and a longer lockout.
> 2. **Recommended.** 1 plus: the LAN report requires an explicit operator acknowledgement env var or per-namespace token with a short TTL, mirroring how `cloud/server.js` refuses a non-loopback bind without `CLOUD_HTTP_DEPLOYMENT_ACK`. Document a Tailscale-serve or reverse-proxy TLS path, and scope the report token to `/api/report/` only.
> 3. 2 plus: make the phone report cloud-only, and stop serving read-from-LAN HTML from the register. Closes the plaintext surface entirely, and removes a feature the README markets for shops that will never run a VPS.
> *Honest bound:* all three need LAN adjacency or physical access. The default bind is loopback. This is about the documented "live manager phone app" feature, not a remote hole.

> ### **D8. Does the product do per-cashier accountability?**  ***BLOCKS: F18, F63***
> CONFIRMED by reading. There is no `staff_id` on `sales` at all (`src/db.js:92-107`, and the INSERT at `src/sales.js:109-111` writes none). Only one shift may be open at a time (`src/shifts.js:10-11`), and a staff member cannot close a shift they did not open without a manager (`:29-31`). So with two cashiers on one register, cashier B's takings land in cashier A's drawer and A's signed variance is attributed on that basis. Receipts name nobody. The attribution data already exists in `audit_log` per sale, so the fix is schema and wiring, not invention.
> 1. Nothing. Declare the product single-drawer per workstation and document that a shift is a drawer, not a person.
> 2. **Recommended.** Add `staff_id` to `sales`, populate from the session, and make the shift report roll up by person. Keep one open shift per workstation if that is the physical reality, but then title it "drawer" everywhere so no one reads a person's name onto it.
> 3. Full: per-cashier concurrent shifts and per-cashier expected cash, which means each person gets their own session-gated open and close. Right for a shop with two registers; needs a drawer or till concept and is the biggest change in this plan.
> *Decide by asking:* how many staff actually share one register at peak? One means 2 is enough; three means 3.

> ### **D9. Whose arithmetic is authoritative in the cart?**  ***BLOCKS: F3, F12, F13, F14, F16***
> CONFIRMED by measurement. `cartTotals()` accumulates raw binary floats (`public/js/views/pos.js:993`) while the server rounds per line (`src/sales.js:60-73`). 27% of realistic two-line carts disagree and 4% refuse exact cash with a self-contradictory toast. Separately, `unitPriceOf()` prices from a snapshot taken when the line was added while the server re-prices from the live catalog row, so every displayed figure including the GCash amount due and the `amount_paid` sent is advisory (`pos.js:690-692,1150-1152` vs `src/sales.js:67-69`). A held or crash-recovered cart re-hydrates without re-pricing (`pos.js:1023-1031`).
> 1. **Recommended.** Fix the arithmetic in place: sum in integer centavos or apply the same half-up cents rule per line and running, compare tender with a one-cent tolerance, and re-price every cart line against the catalog after each `loadPosCatalog()`. Small, local, testable, keeps the counter fast.
> 2. 1 plus a totals-preview round trip: the client shows nothing as final until the server echoes it, via a cheap `POST /api/sales/preview`. Also kills the price-drift class entirely and adds a round trip to the hottest screen.
> 3. Move all cart math to the server and make the SPA a dumb renderer. Most correct, and it makes the POS unusable during a brief local stall, which is the wrong trade for a register that must keep selling.
> *Rides along whatever you pick:* F12 cap the discount at the subtotal, F13 reset the price tier between jobs, F14 require a billable line, F16 keep `op_id` until the receipt has rendered.

> ### **D10. What is allowed into the undeleteable audit log?**  ***BLOCKS: F52***
> CONFIRMED by measurement. `src/server.js:569-572` copies full before and after values for every settings key, with `sync_token` the only redaction, and `gcash_qr_url` arrives as a base64 data URL (`public/js/auth.js:533,573`). One save of a 3.2 MB QR wrote a **6.5 MB `audit_log.detail` value**, and `listAuditLog({limit:100})` shipped a 6.5 MB page to the browser. The append-only triggers (`src/db.js:179-182`) make it permanent, and every subsequent save grows it again. The 10 MB body cap exists on purpose for this payload (`src/server.js:66-70`).
> 1. **Recommended.** Never log value bodies over a threshold: store `[sha256:xxxx, sha256:yyyy]` for anything over about 200 bytes and keep full text for everything small. Preserves the "did it change and to what shape" answer, drops the payload.
> 2. Treat a fixed set of keys as opaque blobs (hash always), which is more explicit but needs maintaining as keys are added.
> 3. 1 plus a size ceiling and rotation story for `audit_log` itself, which is currently forever-growth by design. Honest, and it forces a second decision about whether append-only means "never prune" or "never edit".
> *Not a bug in intent:* recording what changed is exactly right. Only the byte count is the problem.

> ### **D11. Do the README claims describe this build?**  ***BLOCKS: F61***
> Three claims do not survive contact with the code. "daily payment reconciliation" is unreachable (D1). "Automated Daily Backups: ... 14-day rolling retention" is startup-only and false for the manual family (D6). "The application will prompt for a PIN change on initial setup to ensure shop security" prompts and does not require (D7). "Full defect tracking with instant replacement" describes a control with no warranty window behind it (F1, F62, Section 2).
> 1. **Recommended.** Fix the code where it is cheap (Waves 1-2 do most of it) and correct the copy where it is not, so the README describes the product a customer receives.
> 2. Deliver all four features to match the copy first, then ship. More work before the first sale, and it is the right call if the copy is already in front of buyers.
> *Why this matters commercially:* each of these is a refund or a support ticket with a shop's books attached.

### Section 1 decision summary

| # | Question | Recommendation | Blocks |
|---|---|---|---|
| D1 | Reconcile: feature or dead code? | 2, wire it up | F46, F5, D2, F61 |
| D2 | Money moving across a closed till | 2, compensate | F5 |
| D3 | Same customer spelled differently | 2, normalize on write plus report | F4, F19 |
| D4 | Cashier writing off a debt | 2, threshold plus mandatory reference | F23, F24 |
| D5 | Where the exe stores data | 2, refuse release dir plus LOCALAPPDATA | F38 |
| D6 | How much DR is the product's job | 2, add off-machine step and age warning | F39, F41 |
| D7 | Off-box exposure posture | 2, ack gate and short-TTL scoped token | F22, F26, F28 |
| D8 | Per-cashier accountability | 2, `staff_id` on sales, drawer wording | F18, F63 |
| D9 | Authoritative cart math | 1, centavos in place plus re-price | F3, F12-F14, F16 |
| D10 | What enters the audit log | 1, hash values over a threshold | F52 |
| D11 | Do the README claims hold | 1, fix cheap, correct the rest | F61 |

---

# SECTION 2: NO PLANNING NEEDED

Local, provable, no open question. Execute Wave by Wave; each wave ends with `npm test` green. Every item adds the test that proves it. Where an item shares a root cause with a Section 1 decision it says so, and the Wave keeps it independent of that answer.

### Section 1 decision outcomes (executed 2026-09-24)

The recommendations were approved as a batch and implemented in the plan's risk order. Suite went 207 to 241 tests, zero failures.

| # | Chosen | What shipped | Deviation from the written recommendation |
|---|---|---|---|
| D9 | 1 | Cent-quantized cart totals matching `src/money.js`, half-cent tender tolerance, re-price of every cart line against the live catalog on each render | none |
| D10 | 1 | Settings audit digests any value over 200 bytes as `[NB sha256:xxxx]`, small values keep full text | none |
| D7 | 2 | Elevation refused while the factory PIN is live, settings and starter-seed relaxations removed, report namespace gets its own counter and a 15-minute lockout, `POS_LAN_REPORT_ACK` gate on a non-loopback bind, TLS paths documented | none |
| D5 | 2 | Copy-time check was already present and tested; runtime now refuses any release-shaped base and uses `%LOCALAPPDATA%\TechPartsPOS` | none |
| D6 | 2 | Hourly backup tick, `getBackupStatus` age on the dashboard with a Standing warning row, `scripts/mirror-backups.js` plus docs section 3.3 | none |
| D4 | 2 | Ref number mandatory for gcash and transfer collections, elevation required above the shop-set `settle_elevation_threshold` (default 500), PIN prompt before the POST plus a 403 retry | none |
| D3 | 2 variant | Whitespace-and-control normalization on every name write, `COLLATE NOCASE` on the reads that were still case-sensitive, debtor count de-duplicated, and a name-variants report in the Customers toolbar | the one-way name backfill was **not** run: the plan's own warning about merging two people applies, and case-insensitive reads make it unnecessary |
| D1 | 2 | `GET /api/reconcile/:date` and `POST /api/reconcile/close-day`, elevation-gated, Day close panel in Reports, and `analytics.getExpectedCash` now calls `reconcile.bucketsFor` so one rule owns drawer math | none |
| D2 | 2 | New `cash_adjustments` ledger, voids across a signed period pay out of today (same-day voids skipped so money is not paid twice), signed numbers never rewritten, "Moved after close" row in exceptions | none |
| D8 | 2 | Guarded `sales.staff_id` plus index, populated from the session, `getShiftBreakdown` rolled up per person on close and at `GET /api/shifts/:id/breakdown`, and the shift is called a drawer everywhere | none |
| D11 | 1 | Four README claims corrected (reconciliation, backups, PIN change, warranty/RMA) plus the PIN hashing claim, which said SHA-256 where the code does PBKDF2 | one claim added to the fix list because it was wrong in the same way |

## Wave 1: money-integrity gates (one file each, no schema change)

- [x] **F24, W6 (U4/R-26): gate the remaining RMA types.** `src/server.js:462` gates only `cash_refund`. Require elevation for `replacement` and `credit_refund` too, matching void at `:444`. Independent of D4's threshold decision: this one is about stock, not cash. Test: staff session, `replacement` RMA, expect 403 `elevation_required`.
- [x] **F1, F62, W1 (U1/R-02): enforce the warranty window.** `src/returns.js:14-126` never compares `sale.created_at` to `warranty_days`; verified accepting a return on a sale backdated to 2023 with the setting at 7. Add the date check against the setting with an elevation-override path, and record an `out_of_window` flag in the audit detail. Test: return on a 90-day-old sale throws; succeeds with elevation; the flag appears.
- [x] **F2: constrain the replacement part.** `src/returns.js:52-62` takes `replacement_inventory_id` from the client and only checks existence and stock. Verified: an RMA against a "Samsung J2 LCD" line deducted one *iPhone X battery*. Require the target to equal the returned line's `inventory_id` unless elevated, and require the same `part_type` on an elevation override. Test: cross-SKU replacement throws for staff, succeeds for elevated.
- [x] **F6: stop a typed comma closing a shift at zero.** `public/js/views/pos.js:1228-1231` posts `Number(v)` from a free-text `prompt()`; `Number('1,250')` is `NaN`, `JSON.stringify` emits `null`, and `src/shifts.js:22`'s `money(Number(null))` is `0`, which the `isNaN` guard at `:23` lets through. Verified. Use `inputModal` with `inputType: 'number'`, reject non-finite or negative, echo the parsed value back, and have the server reject a `null` `counted_cash`. Test: server-side rejection of `null` and of a comma string.
- [x] **F12: cap the discount at the subtotal.** `public/js/views/pos.js:995-996,1119` sends the raw discount; `src/sales.js:77-79` rejects negatives but not over-subtotal. Verified consequence: `discount=5000, total_amount=0` on a 1200 peso job with no warning anywhere. Clamp in the client, reject in `createSale`. Test: over-subtotal discount throws.
- [x] **F13: reset the price tier between jobs.** `public/js/views/pos.js:862-904` clears every field but not `S.currentPriceTier`, which is what the server prices with. The confirm guard at `:109-112` protects the current job only. Reset to `retail` in `resetRepairCounter()`. Test: two sequential carts, second prices at retail.
- [x] **F14: require a billable line.** `public/js/views/pos.js:1089-1092` only tests `S.cart.length === 0`, and a blank device/note line becomes a zero-price labour item, so a zero peso sale commits and prints a receipt. Require one billable line or `total > 0`. Test: empty-price cart rejected.
- [x] **F10: stop the audit-chain check failing open.** `src/analytics.js:503-504` initializes `auditChain = { ok: true }` and swallows the throw, so "could not verify" renders as "verified clean". Initialize to an explicit `unknown` and render it distinctly. Test: force a throw in `verifyChain`, expect `unknown`.
- [x] **F8: 404 instead of success-no-op.** `src/inventory.js:170-174` returns `null` for a missing part and `src/server.js:383` answers 200 with `null` and no audit row. Mirror the archive route at `:397`. Test: adjust a deleted part, expect 404.
- [x] **F30: stop leaking internals.** `src/server.js:849` returns raw `err.message` (including SQLite constraint text) on every path, including the LAN-reachable `/api/report/*`, and reports all unexpected errors as 400 so a server bug looks like bad input. Generic message when `err.statusCode` is absent, real one logged by F31. Test: force a non-domain error, expect no internal text in the body.
- [x] **F11, U1 (R-02 Hard Gate): one part label, plain hyphen.** `src/inventory.js:117` `partLabel` joins brand, model and part type with an em dash; `src/sales.js:74` persists the same three fields joined with a hyphen into `sale_items.item_name`. So the same part reads two ways, and one of them is a three-byte non-ASCII glyph on a path that ends in a Windows thermal printer driver where it can print as a box. One shared helper, hyphen, both call sites. Test: `partLabel` equals the persisted `item_name` shape. Also clear the other user-facing em dash at `src/returns.js:25`; the remaining 28 are comments and Wave 5 handles them.

## Wave 2: observability (makes everything after this diagnosable)

- [x] **F31, W2: log request failures.** `src/server.js:844-850` only calls `sendJson`; `logLine` has eight call sites in the file and all eight are startup, browser-launch, port-hunting or exit. Evidence: `pos-server.log` in this tree holds exactly one line across a multi-week dev history. Log `err.stack` when `!err.statusCode`, with method, pathname and session actor. Highest diagnostic value per line changed in this plan; do it before chasing anything SUSPECTED. Test: assert a thrown handler writes to the log path.
- [x] **F53: stop printing a fake shop identity.** `public/js/auth.js:368-380` has no else branch and a console-only catch, so a failed settings fetch leaves `S.shopSettings` on the built-in placeholders at `public/js/state.js:19-28`: "TechParts Repair & POS" and "0917-123-4567". A real receipt then prints a phone number that is not the shop's, and a customer paying by GCash from that screen sends money nowhere. Persistent banner when settings cannot be read, and refuse to print an identity-bearing slip while it is placeholder. Test: banner renders when the fetch resolves non-ok.
- [x] **F54, U2 (R-27 Hard Gate): real error states on four views.** `public/js/views/backoffice.js:188,200-204` and `:600,612-616` paint skeletons whose `catch` only does `console.error` plus a 3.2 s toast, and `.skel` animates forever (`public/styles.css:1668-1672`); `public/js/auth.js:1048-1056` wraps the roster fetch in `catch (_) {}` and then renders `staff.length === 0` as "No staff yet", so a failure invites the manager to re-add existing cashiers. The correct pattern already exists at `public/js/views/inventory.js:85-95`. Copy it into all four. Test: each view renders a Retry affordance when the fetch rejects.
- [x] **F55: refuse to print a zero Z-report.** `public/js/receipts.js:258-307` tolerates a wrong shape with `stats.current || stats` and `Number(v || 0)` per row, so the document a human signs prints all-zero revenue as a quiet day. Require the expected keys and refuse with a stated reason. Test: partial payload refuses rather than prints.
- [x] **F37: treat "200 with nothing acked" as failure.** `src/sync.js:102-103` swallows a non-JSON body so `marked` is 0, `src/server.js:171-173` resets the backoff, and `:191-193` re-kicks on `pending > 0`: the same 50 rows POST every 2 seconds forever against a confused endpoint, with no error surfaced. Test: fake 200-with-HTML server, expect backoff applied and `syncLastError` set.

## Wave 3: backup and release hygiene

- [x] **F40, W3: prune both backup filename families.** `src/server.js:885` matches `startsWith('shop-')` while manual files are `shop_backup_*` (`:858`); the underscore never matches. Counted in this tree: **216 manual files against 6 daily**. Matches SECURITY-SETUP.md's "14-day rolling retention" claim being false. Prune both prefixes, cap manual backups per day. Test: fabricated mtimes, expect both families pruned and an unrelated file kept.
- [x] **F41: verify a backup before publishing it.** `src/server.js:856-871` does `VACUUM INTO` then rename with no `PRAGMA integrity_check` or `quick_check` anywhere in the tree and no restore drill. Check the temp file, refuse the rename on failure, surface it on the dashboard. Test: corrupt the temp file, expect the previous backup untouched and an error surfaced.
- [x] **F56: test the DR path at all.** `runDailyBackup` and its prune are executed by **no** test; only `createDbBackup` is. This is where F39 and F40 live, and `npm test` stays green through either. Test: today's file exists, an old one is gone, an unrelated file survives, a second same-day call returns null.
- [x] **F59: stop leaking a database per test run.** `tests/db.test.js:146-165` bypasses `dbTest`, names the file from `process.pid`, and `initDb` throws from the audit backfill at `src/db.js:293` without `close()`, so on Windows the `finally` scrub fails with EBUSY into an inline `catch {}`. 26 `tests/t_audit_failure_*.db` have accumulated. Close the handle in a `finally` inside `initDb`'s throw path, or use the helper. Test: `t_audit_failure_*` count is 0 after a run.
- [x] **F60: delete the stdout dump.** `tests/reports-http.test.js:17,51` prints the whole dashboard JSON every run.

## Wave 4: UI rule violations with no open question

- [x] **U3 (R-25 Hard Gate): archived rows fail contrast.** `public/styles.css:2250-2252` uses `opacity: 0.45` on rows that still carry live controls (`public/js/views/inventory.js:227,243-253`), computing to 3.03:1 for row text and 1.88:1 for the location line in light mode. Replace the opacity fade with a token pair clearing 4.5:1. Verify with `python "C:/Users/sloth/.agents/skills/antislop-human/contrast-check.py"` in both themes rather than trusting my numbers.
- [x] **U5 (R-03 Hard Gate): tap targets are 20-24 px.** The tender keypad (`+₱100`, `+₱500`, `+₱1,000`, "Exact", `public/index.html:1267-1270`), `+ Add`, `Adj`, the line-remove `x` and `.linkish` all fall under 44 px, and the floor exists only inside `@media (pointer: coarse)` (`public/styles.css:3721-3729,3345-3355`), while the stated primary deployment is a shop PC with a mouse. `public/report.html:65-68` also leaves the manager phone's sign-out under 44 px on a phone. Apply the floor to that control set unconditionally in the POS column.
- [x] **U6 (R-32 Hard Gate): a focusable control marked `aria-hidden`.** `public/index.html:855-856` puts `aria-hidden="true"` on `<select class="sr-only">` that drives a real filter, so keyboard focus lands on an invisible control nothing announces (WCAG 4.1.2, 2.4.7). Hold the value in `S` and drop the DOM select, or add `disabled`/`inert`. Also: the three blocking gates (`#license-overlay`, `#login-gate`, `#server-down-overlay`, `public/js/auth.js:186-206`) have no `role`, no `aria-modal`, and receive no focus while `ui.js:208-221` makes everything else inert; give them `role="alertdialog"` and move focus in, as `#pin-setup-overlay` already attempts (and fails, F15).
- [x] **U7 (R-26 Hard Gate): dialogs with no accessible name, PIN field with no label.** `openModal` sets `role="dialog"` and `aria-modal` but never `aria-labelledby` (`public/js/ui.js:158-159`), and no static modal in `public/index.html` carries it although the title ids exist (`:915,1131,1190,1775,1790`), so on the destructive Confirm dialogs the user cannot hear what they are approving. `#input-value` (used for "New PIN for <name>", type swapped at `ui.js:417-418`) and `#license-key-input` have only a placeholder that vanishes on typing (`public/index.html:1792,1819`). Set `aria-labelledby` from the dialog's `h3` id and add real labels.
- [x] **U8 (R-27 Hard Gate): the utang badge is color and emoji only.** `public/js/views/pos.js:38-48` swaps class and text on a plain span (`index.html:215`) with no `role="status"` or `aria-live`, and leads with a red or green emoji. The most consequential fact at the counter, "this customer still owes X", is never announced and unreadable by a color-blind cashier. Add `aria-live="polite"`, put the state in words, drop the emoji (also an R-04 tell).
- [x] **U9 (R-33 adjacent): CSV formula injection on export.** `public/js/views/inventory.js:576-586` validates prices and barcodes but passes `supplier`, `location`, `part_type` and the other text fields through `String(v).trim()` only, with no length bound and no leading `=`/`+`/`-`/`@` handling, and `src/server.js:606-609` quotes but does not neutralize on export. `=HYPERLINK("https://...","Click")` in a supplier cell executes in Excel when the owner opens the accounting export. Cap lengths, strip control characters, prefix or reject on import, and mirror the rule in the writer.
- [x] **F15: undeclared identifier strands first-run setup.** `public/js/auth.js:802` reads `shopNameInput`, never declared anywhere; the id is `setup-shop-name` (used correctly at `:780` and `:827`). Short-circuit `&&` does not help, the reference itself throws. Inside `setTimeout` it becomes an uncaught `ReferenceError`, so the mandatory overlay never receives focus while the rest of the app is inert. One line: `const shopNameInput = document.getElementById('setup-shop-name')`.
- [x] **F9: fix a comment that lies about cost.** `src/auth.js:72-78` claims the PBKDF2 round happens "only while the factory PIN is actually in use". Measured: **30.7 ms with the factory PIN, 31.7 ms after changing it**, because `verifyPinHash` runs the full 100k-iteration KDF whenever the stored hash is pbkdf2 format, which is always after the first set. Called from `src/server.js:560` on every `GET /api/settings`, awaited at boot (`public/js/main.js:462`). Memoize on the stored-hash value and correct the comment. The comment is the actual hazard: it invites this call onto a hotter path.
- [x] **U10 (Quality Lock): a promise the code makes a toast cannot keep.** `public/js/views/inventory.js:561,605-614` enables Import against a 3-row preview of a sheet that may hold thousands of rows, and returns row-numbered failures only into a 3.2 s self-dismissing toast, contradicting the modal's own comment at `:491-493`. Render row errors into the modal body with the row count and per-column type checks.

## Wave 5: deletions, safe without a decision

- [x] **F47: delete the parked-cart module nobody uses.** `src/holds.js` is 50 lines required by nothing in `src/`, `tests/`, `public/` or `cloud/`; no route reaches it and the `held_sales` table (`src/db.js:218-226`) is never written. The live park-a-job feature is a localStorage draft (`public/js/views/pos.js:1023-1031`). Two implementations of one feature, one dead and untested. Delete the module and the table, **or** migrate the draft onto it and delete the localStorage path. One implementation either way; the deletion is the lazy one and no decision blocks it.
- [x] **F48: delete the sql.js / APK shim abstraction that outlived its implementation.** `src/shim/` does not exist and `sql.js` is neither installed nor declared in `package.json`, yet `src/db.js:52-59` documents and defensively wraps for it (the `try/catch` around WAL plus a `ponytail` note about a build that cannot occur), `initDb`'s second parameter exists only for it and no production caller passes it, `src/settings.js:3` cites a `src/shim/router.js`, `src/license.js:18-21` adds `machineIdSource`/`setMachineIdSource` for a WebView that cannot exist, and `tests/helper.js:27,35` requires both. So **`SHIM_DB=1 npm test` dies immediately with `MODULE_NOT_FOUND`**, meaning a documented test mode is broken, and a phantom dependency sits in front of the "0 runtime dependencies" claim. Delete the branches, the parameter, the source hook and the `SHIM_DB` path. Re-add with the APK build if that product returns.
- [x] **F49: the reason-code control is inert end to end.** One row seeded (`src/db.js:349`), `reasons.js:11-14` `listReasonCodes` is unrouted, no add-code route exists, and a grep of `public/js/` finds **zero** `reason_code` references so the client never sends one and `validateReason` always takes its early return. The comment at `src/db.js:347-348` describes a validation that never runs, and voids are free text with no categorization, so `getExceptions` cannot group a bad void pattern. Either expose the codes (one GET plus a select in the void dialog, which makes F5's exceptions panel more useful) or drop the table, the module and the parameter. Deletion is safe and reversible; flag which way you want it in passing.
- [x] **F50: small dead branches.** `public/js/main.js:515-527` is unreachable behind the Escape branch at `:486`. `src/inventory.js:121-126`, `src/sales.js:117-125` and `src/returns.js` each re-implement "insert movement, then re-select by `last_insert_rowid()` to enqueue" as three statements where the insert could return the id once. `src/analytics.js:504` re-`require`s `./audit` inline although it is already loadable. `warranty_returns.quantity` is a multi-unit column that `returns.js:42,107` always pins to 1, so `src/sales.js:144-149` carries a generalization nothing uses.
- [x] **F64: repo hygiene.** `smoke.db`, `smoke.db-shm`, `smoke.db-wal` at the root and `scripts/probe2.db` match no ignore rule (`.gitignore:18-20` only covers `tests/t_*`), so test databases with synthetic POS rows ride along in any archive of the tree. Add the patterns.

## Wave 6: the one remaining clean bill

**Category 3 (Performance) is CLEAN and has no tasks, deliberately.** The audit measured the candidates instead of assuming them: `verifyChain` at 37-48 ms over 5000 rows, `audit()` at 1.3 ms per write, `getLicenseStatus` sub-millisecond per request with `cachedMachineId` (`src/license.js:17`) already showing the one real cost was fixed. Query shapes are right: `listCustomers` pushes search and filter into SQL (`src/credits.js:8-9`), `createSale` batch-fetches parts in one query instead of N (`src/sales.js:47-53`), `getCustomerDetails` replaces an N+1 with one `IN` pass (`:64-74`), the five date and lookup indexes cover the hot paths (`src/db.js:189-200`), and the daily-aggregate narrowing trick at `src/analytics.js:65-70` is mathematically sound and load-bearing. Adding a cache, a pool or pagination here would be slop, not a fix.

---

## Execution order and dependencies

1. **Answer D1 through D11.** Nine of them change what a Section 2 item becomes, and D1 plus D2 are mutually entangled: whichever way day-close goes decides how a cross-period void is fixed.
2. **Section 2 Waves 1-5 in order.** Nothing in Wave 1-5 depends on any decision except the notes marked "depends on D" (F46 waits for D1; the em-dash comment cleanup in F11 spans both).
3. **Then Section 1 implementations**, cheapest per unit of risk first: D9, then D10, then D7's option 1, then D5, then D6, then D4, then D3, then D1 and D2 together, then D8, then D11.
4. **SUSPECTED items are not in either section yet.** See below.

## SUSPECTED: verify before scheduling

Labelled honestly. These came from delegated agents with line citations, or from a probe I did not re-run. Each is one command from CONFIRMED; do not schedule a fix until it is one.

| Finding | How to check it yourself |
|---|---|
| F31, cloud: `readOrCreate` accepts an existing-but-empty secret file, so `pin: ""` authenticates | `wc -c state/manager-pin.txt`, truncate to zero, restart, then `curl -s -X POST https://host/api/login -d '{"pin":""}'` and look for `Set-Cookie` |
| F32, cloud: `ALLOW_LEGACY_SYNC_TOKEN=1` takes the tenant from the request body | With the flag set, POST `/sync` with another `shop_id` and read `/api/rows?shop=` |
| F33, cloud: SSE clients authorized only at connect, not evicted on logout | Open `/events`, log out in another tab, confirm whether events keep arriving |
| F34, sync token in plaintext in `shop.db` | `SELECT value FROM shop_settings WHERE key='sync_token'` on a synced install |
| F35, cloud: first-run minting prints tokens and the PIN to stdout | `grep -c 'sync token' ` your pm2 or journald log |
| F36, sync drain hangs forever on a stalled body (`src/sync.js:91-103`) | Point `sync_url` at a listener that sends 200 headers and never ends; watch whether the chip keeps claiming healthy and `pos-server.log` records nothing |
| F16, client clears `op_id` before the receipt renders | Complete a sale with devtools open and a deliberately broken field in `renderReceipt`; confirm the failure toast arrives *after* the row is committed |
| F20, F21, settlement and `op_id` replay are read-then-write | Not reachable single-process. Only check it if you enable `POS_ALLOW_MULTI=1` |
| F25, no session expiry | Read `src/auth.js:265-277`: `iat` is set and never checked. Then decide if that is acceptable; it is D7's scope |
| U10 latent XSS on server-integer fields interpolated raw | Safe today because the columns are integers. Only becomes live with a schema or payload change |
| Contrast figures in U3 | Re-run `contrast-check.py` against the composited colors; do not trust my 3.03:1 and 1.88:1 |

## What this plan does not do

No new dependency, no abstraction, no cache, no lock manager, no pagination, no test framework, no config layer. Nothing is added for load the product will not see, and nothing that already works is rewritten: the savepoint transaction discipline, the atomic `WHERE stock_quantity >= ?` decrements, parameterized SQL with escaped `LIKE` at all four sites, the `Origin` plus `Host` CSRF and rebinding defense, `timingSafeEqual` on every secret, the per-row-snapshot cloud contract that makes re-delivery non-double-counting, the retry backoff that provably caps a dead VPS at one request per five minutes, the exact verified FIFO settlement math, the focus trap with `inert` background and single-layer Escape, the ARIA-correct comboboxes with all 91 id references resolving, no `outline: none` without a replacement, and the absence of every landing-page slop pattern. Those are correct as built and touching them would be the actual defect.
