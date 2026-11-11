# TechParts POS Audit Report, 2026-11-11 (v8 brief, version 2.8 + uncommitted batch)

Baseline gates measured this run: `npm run build:css` exit 0; `npm test` 568/568 pass,
0 fail, exit 0, about 26 s, 49 test files (48 tracked + untracked tests/universal-pos.test.js).
HEAD 94d1206 (v2.8). Working tree carries the uncommitted 2026-11-11 batch
(+5271/-507, 46 files): universal POS, fractional quantities, cloud CSV export,
mobile touch, reorder list, receipt templates, i18n expansion, publish-release hardening.

Method: five read-only category sweeps, every HIGH and most MEDIUM findings re-verified
against the on-disk code by the lead before landing. Line numbers resolved against the
working tree, not the brief's stale coordinates. No browser automation: visual items are
code inspection plus layout math, stated as such. No server started, no network, no real
data touched, no update apply run.

Brief corrections found while verifying (the brief itself warns coordinates may move):
- The two named updater defects (mojibake message, dangling "no-signing note above"
  comment) are NOT present in the current code; both are clean ASCII / absent. Closed.
- Both update-UI window.open calls use noopener now. The brief's "one lacks noopener" is stale.
- Deploy direction reversed: scripts/deploy-cloud.js syncs cloud-deploy/ INTO cloud/ and
  uploads cloud-deploy/, so cloud-deploy/ is today's edit source. cloud/ and cloud-deploy/
  are byte-identical except cloud/data.
- SSE broadcast scope is mitigated: broadcast() filters by storeId, /events tags storeId,
  the app filters by selectedShop. Residual: the untagged deploy broadcast reaches every store.
- tests/analytics-parity.test.js now exists and compares cloud vs workstation formulas
  through the real /sync pipeline; it uses integer quantities only (no fractional case).
- The claim stub is no longer browser-only: src/printer.js renderClaimStubSlip exists and
  pos.js sends it queue-first with browser fallback.
- pos-server.log rotation EXISTS (server.js, 5 MB, one .1 generation); the root log is
  pre-fix test residue. The brief's "no rotation" finding is closed.

## 1. Executive summary (top 5)

1. F3/F4: cloud commands call importInventory and adjustStock with op_id/actor in the wrong
   argument position, so a redelivered cloud import doubles stock and a cloud stock adjust
   writes no audit row.
2. F19: an unauthenticated cloud /api/create-store adopts every unclaimed `default` shop into
   the attacker's store before the operator sets a PIN, exposing all mirrored trade data.
3. F1/F13: fractional quantities round differently on the client vs the server (4303 measured
   price/qty mismatches) and the cloud casts quantity to INTEGER, so register, paper and the
   manager phone disagree on the core money path.
4. F18: the trial seal uses a shipped constant salt and skips the evidence floor when the seal
   matches, so five SQL edits extend an expired trial indefinitely with no data loss.
5. F20: manager login with the factory PIN 1234 issues an elevation token that /api/auth/elevate
   refuses, opening manager control of a skipped-setup register from the shop LAN.

## 2. Findings by category

Severity: CRITICAL / HIGH / MEDIUM / LOW. Each: [SEV] [CONFIRMED|SUSPECTED] file:line.

### Category 1: Correctness / bugs

- F1 [HIGH] [CONFIRMED] public/js/views/pos.js:1236 vs src/sales.js:79,89 - Fractional line
  total rounds differently on client and server.
  What: client cartTotals does Math.round(toCents(unit) * qty); server does money(unit * qty).
  toCents(unit)*qty is a binary float product, so it rounds a centavo off on decimal halves.
  Trigger: 0.25 x 0.58: server 0.15, client 0.14 (brute force found 4303 mismatching pairs).
  Impact: when server > client a cash sale is rejected "Non-credit sales must be fully paid"
  although the customer tendered the displayed total; when lower, paper shows change the
  register never computed. Register and paper disagree on the core money path.
  Fix: client line cents = toCents(unit * qty) (round the product, exactly like src/money.js).

- F2 [HIGH] [CONFIRMED] public/js/views/pos.js:1187-1204,1220-1224,839 - Stale price_wholesale
  on cart lines.
  What: repriceCartLines refreshes price_retail and price_technician but never price_wholesale;
  unitPriceOf prefers price_wholesale, frozen at quickAddPart time. Server charges live
  inv.price_technician.
  Trigger: hold a wholesale draft, the technician price changes, resume/refresh the catalog.
  Impact: screen quotes the old wholesale price, register charges the new one; receipt
  contradicts the quote.
  Fix: refresh line.price_wholesale from inv.price_wholesale ?? inv.price_technician.

- F3 [HIGH] [CONFIRMED] src/sync.js:119-122 vs src/inventory.js:363,430 - Cloud import is not
  idempotent (op_id in the wrong argument).
  What: importInventory(db, rows, ctx, meta) reads op_id from the 4th arg; applyCloudCommands
  passes {op_id, actor} as the 3rd arg (ctx), so meta.op_id is undefined and the op_log gate
  never engages.
  Trigger: a cloud import_inventory command applies, the ack POST fails (swallowed at
  sync.js:147), the cloud redelivers on the next heartbeat.
  Impact: the whole CSV is received a second time; stock doubles for every row.
  Fix: pass {op_id} as the 4th arg, keep actor in the 3rd.

- F4 [HIGH] [CONFIRMED] src/sync.js:111-116 vs src/inventory.js:254,289 + src/audit.js:39 -
  Cloud stock adjustment writes no audit row (actor in the wrong argument).
  What: adjustStock(db, id, delta, meta, ctx) reads actor from the 5th arg; the call puts actor
  inside the 4th-arg meta, so ctx is {} and audit() returns early.
  Trigger: any cloud adjust_stock command.
  Impact: stock moves with a movement row but zero audit trail, breaking the append-only-trail
  coverage every local adjustment has. Non-negotiable violation, hence HIGH.
  Fix: move actor into a 5th-arg ctx object.

- F5 [MEDIUM] [CONFIRMED] src/inventory.js:395,398,416,419,497,502,522,523 - Bulk price edits
  and auto-pricing round to whole pesos.
  What: Math.round(curr + value) / Math.round(cost * (1 + markup/100)) produce integer prices
  although prices are REAL and money() supports cents.
  Trigger: bulk adjust_price +0.50 on a 10.25 part yields 11.00 not 10.75; CSV auto-price on
  cost 10.50 at 50% yields 16 not 15.75.
  Impact: systematic per-unit over/underpricing after every bulk edit or auto-priced import.
  Fix: use money() instead of Math.round in these spots.

- F6 [MEDIUM] [CONFIRMED] public/js/views/backoffice.js:285,190-196 + src/returns.js:85 -
  Fractional sale lines cannot be returned through the RMA UI.
  What: server added fractional RMA support, but the form input is min="1" and submit does
  Math.max(1, parseInt(...)); the modal clamps to >= 1.
  Trigger: sell 0.5 of a fractional part, file any RMA on that line; client sends 1, server cap
  alreadyReturned + qty > item.quantity throws.
  Impact: sub-unit lines are permanently unreturnable; the fractional batch is half-landed.
  Fix: let the RMA form accept decimals (step 0.001, max = remaining) and send the parsed float.

- F7 [MEDIUM] [CONFIRMED] public/js/receipts.js:988 + src/printer.js:647,651 - Claim stub lines
  do not sum to the stub total.
  What: browser stub line is (Math.round(unit*100)*qty)/100 (product not rounded); thermal stub
  line is money(qty*unit) while ESTIMATED TOTAL is money(job.total) from cartTotals.
  Trigger: 0.25 x 0.58: stub line 0.15 under a cart total of 0.14.
  Impact: estimate paper whose own lines contradict its total.
  Fix: one integer-cent line formula (the cartTotals one) in both stub renderers; derive the
  stub total from those lines.

- F8 [LOW] [CONFIRMED] src/sales.js:70-74 - Quantity validated before rounding.
  What: qty > 0 checked on the raw value, then cleanQty = Math.round(qty*1000)/1000 can be 0
  for 0 < qty < 0.0005.
  Trigger: POST a sale with quantity 0.0004 on a fractional part.
  Impact: a quantity-0, total-0 line and a delta-0 movement are stored; junk ledger rows, no
  money or stock loss. adjustStock already has the "too small" guard; sales lacks it.
  Fix: re-check cleanQty > 0 after rounding and reject.

- F9 [LOW] [CONFIRMED] src/returns.js:72 - Explicit null/empty quantity on a fractional line
  returns the entire line, not 1.
  What: the fractional branch defaults null/'' to item.quantity; the integer path floors at 1.
  Trigger: manager payload {quantity: null} on a 5-unit fractional line files a 5-unit RMA
  (still capped and refund-ceiled, so no corruption).
  Impact: surprising default inconsistent with the floor-at-1 contract.
  Fix: default null/empty to 1, matching the integer path.

- F10 [LOW] [CONFIRMED] src/returns.js:131-134,144-147 - Refund ceiling rounds the per-unit
  price before scaling by quantity.
  What: discountedUnit = money(total_price/quantity * total/subtotal) then money(unit * qty).
  Trigger: return all 3 units of a 100 line: unit rounds to 33.33, ceiling becomes 99.99.
  Impact: customer under-refunded a centavo or two per multi-unit line; never over-refunds.
  Fix: scale first, round once.

- F11 [LOW] [CONFIRMED] src/inventory.js:576 - Reorder window uses a raw string compare.
  What: s.created_at >= datetime('now', ?) compares ISO 'T' stamps against space-shaped
  datetime; 'T' > ' ' pulls in the whole boundary UTC day. audit.js:97 and sync.js:209 already
  fixed this exact pattern with datetime(created_at).
  Trigger: any reorder report; qty_sold includes extra boundary-day sales.
  Impact: slightly inflated reorder suggestions only; no stock or money moves.
  Fix: wrap created_at in datetime().

- F12 [LOW] [CONFIRMED] src/server.js:688 - RMA route lets body.sale_id override the path id.
  What: { sale_id: Number(match[1]), ...body } spreads body last; the settle route deliberately
  does the opposite (URL name wins).
  Trigger: manager payload carrying a different sale_id.
  Impact: none across a privilege boundary (elevation-gated), but the identity rule is
  inconsistent between the two money routes.
  Fix: spread body first, path sale_id last.

### Category 2: Concurrency / data integrity

- F15 [LOW] [CONFIRMED] src/db.js:384-388,400-411 - Boot repair writes enqueue after COMMIT.
  What: SKU-rename enqueues (388) and opening-balance enqueues (409-411) run outside the
  transaction that committed the rows.
  Trigger: power loss between COMMIT and the enqueue loop during boot on an already-paired shop.
  Impact: renamed SKUs / opening balances never reach the cloud mirror until the next live
  write to that row. Local data intact.
  Fix: move the enqueue loops inside the same transaction.

- F16 [MEDIUM] [CONFIRMED] cloud-deploy/server.js:1641 + src/inventory.js:132 - Cloud CSV
  import lands min_stock_alert 0 on the register.
  What: for new parts without a Min Stock Alert column the command row carries
  min_stock_alert: ''; shop validateInventory does Number('' ?? 3) = 0 ('' is not nullish),
  while the cloud preview shows 2 and the shop's own importer defaults 3.
  Trigger: import such a CSV via the manager app.
  Impact: new parts settle at min 0, so low-stock alerts never fire; three different defaults.
  Fix: send the resolved minAlert (or omit the key) in cleanRows.

- F17 [LOW] [CONFIRMED] src/credits.js:249 - Duplicate profile deletion has no tombstone.
  What: case-variant customer_profiles rows are deleted locally without enqueueDelete;
  backfill only adds.
  Trigger: save a limit under a re-cased name.
  Impact: dead profile rows persist in the cloud mirror and feed the standing phone subquery.
  Fix: enqueueDelete each removed rowid in the same txn.

### Category 3: Performance (scale-judged)

CLEAN at this scale. listInventory unbounded is deliberate (<500 SKUs); 14 indexes cover the
queries actually run; the boot update check is not awaited (10 s abort, SPA interactive);
the 400 ms /progress poll is ~150 req/min against a 300/60 s budget, free on loopback; the
outbox is bounded while sync off (30-day prune); the PowerShell spawn per slip is 20-100/day.
publish/ growth is vendor disk only (F50). Nothing a 20-100 sale/day shop notices.

### Category 4: Security

- F18 [HIGH] [CONFIRMED] src/license.js:186-243 - Trial seal forgeable with the shipped salt.
  What: TRIAL_SEAL_SALT is a constant in shipped source; the seal covers only
  machineId|firstRunStr|compromised, not last_seen_ts or trial_max_seen_ts. When
  storedSeal === expectedSeal no evidence floor runs (the floor is only in the !storedSeal
  branch).
  Trigger: with the POS closed, UPDATE first_run_ts/last_seen_ts/trial_max_seen_ts to now,
  trial_compromised='0', and trial_seal = HMAC(salt, machineId|now|0). Restart: fresh 14 days.
  Impact: any user who reads the source extends an expired trial indefinitely, repeatably,
  preserving all sales data. Related: license_seen_ts has no seal; workstation_machine_id has
  no hardware check, so one lifetime key activates unlimited PCs by copying its machine_id.
  Fix: run the evidence floor unconditionally (not just when the seal is missing) and seal
  trial_max_seen_ts so a recomputed seal over edited inputs is still floored to the oldest
  audit row / db birthtime. Residual (wipe audit log + move the db file + recompute) is
  unblockable offline; document it rather than implying the seal stops a determined local user.

- F19 [HIGH] [CONFIRMED] cloud-deploy/server.js:567-599 - Unauthenticated /api/create-store
  adopts existing unclaimed shops.
  What: the claimedStore guard only counts stores with a non-empty pin_hash. A VPS bootstrapped
  with shops in the `default` store but no MANAGER_PIN has default.pin_hash = ''. The adoption
  UPDATE moves every default shop into any newly created store while default has no PIN.
  Trigger: before the operator sets a PIN, an internet client POSTs /api/create-store with its
  own name/PIN, then logs in. All previously paired shops are now in the attacker's store;
  /api/rows, /api/standing, /api/analytics serve the full mirror.
  Impact: internet-facing breach of every mirrored shop's trade data plus write access via
  adjust-stock/import. Window stays open until setup-pin or --rotate-pin.
  Fix: drop the store_id='default' adoption clause; create-store adopts only NULL/'' shops.

- F20 [MEDIUM] [CONFIRMED] src/server.js:1461-1464 vs 1470 - Factory-PIN login issues elevation.
  What: manager login with 1234 issues an elevation token with no isDefaultPin guard, unlike
  /api/auth/elevate which refuses. Elevation-gated routes without their own factory refusal
  (void, returns, inventory PUT, credit limit, staff create, backup) are then open.
  Trigger: a skipped-setup install; a LAN device POSTs /api/auth/login {pin:"1234"} and gets
  session + elevation.
  Impact: full manager control of a fresh register from any shop-LAN device; contradicts the
  documented "elevation refused while the factory PIN is live".
  Fix: guard login elevation issuance with isDefaultPin (change-pin stays reachable without
  elevation during first run, so setup still works). The exe auto-setting HOST=0.0.0.0 and
  POS_LAN_REPORT_ACK=1 (server.js:2108-2109) is deliberate LAN design for the phone report;
  recorded as a doc clarification, not a code change.

- F21 [LOW] [CONFIRMED] cloud-deploy/server.js:384-388,634-682 - /api/pair has no global budget.
  What: 20 req/min per clientKey, code life 600 s, space 900k; per client per code ~200 guesses
  (~0.022% success). clientKey takes the last X-Forwarded-For entry, spoofable without an
  appending proxy. No global cap unlike /api/login.
  Trigger: a non-appending proxy or botnet rotates client keys.
  Impact: a guessed code mints a rogue register under the victim's store (integrity, not
  confidentiality; the sync token cannot read other shops).
  Fix: add a global pair budget mirroring LOGIN_GLOBAL_BUDGET_LIMIT.

XSS, print transport, i18n, scanner consumers, localStorage prefs, cloud bootstrap remainder,
updater trust model (URL resolver, digest fail-closed, reuse re-hash, downgrade refusal),
update-route posture, and the auth/authz remainder verified CLEAN (see section 5 notes).

### Category 5: Stability / resilience

- F22 [MEDIUM] [SUSPECTED] src/updater.js:258-274 - Torn .part resume may rot the update.
  What: on a failed download the .part is written non-atomically; power loss mid-write leaves a
  corrupt prefix. The .part is deleted on a completed download (259), so the rot path needs a
  resume that never completes cleanly. Needs runtime verification of the resume + digest flow.
  Trigger: power cut during a failed-download .part write, then Update Now.
  Impact: if reproducible, update refused until someone manually deletes the .part; no message
  names the file.
  Fix: delete .part/.part.json on digest mismatch, or hash the resumed prefix before Range.
  Check: read the staging/reuse path (updater.js ~520-660) and drive a torn-prefix resume in a
  scratch dir; listed in the manual update steps.

- F23 [MEDIUM] [CONFIRMED] public/js/views/pos.js:359-367 vs 385-392 - pendingScan flush
  bypasses modal/gate/tab suppression.
  What: keydown returns early when a modal/gate is open or the tab is not POS, but
  flushPendingScan fires on a 100 ms timer with no such guard.
  Trigger: scan Enter schedules the settle; within 100 ms a modal opens or the tab switches.
  Impact: handleBarcodeScan mutates S.cart behind an open overlay or on another tab,
  contradicting the documented "don't mutate the cart behind an open overlay".
  Fix: re-check the overlay/tab guard inside flushPendingScan and drop the scan when suppressed.

Update handoff failure windows, watchdog, WAL crash safety, and the kiosk fallbacks verified
by inspection; the real install/resume/rollback/Mark-of-the-Web halves are manual (section 5).

### Category 6: Efficiency / simplification (report only)

- F24 [LOW] [CONFIRMED] src/server.js:589-596 + src/inventory.js:62-68 - Barcode route dead.
  Zero frontend callers; only tests/server.test.js and tests/roles.test.js call it. POS resolves
  scans against its fetched catalog. Cleaning-pass candidate (delete route + helper + tests, or
  point POS at it). Not fixed in remediation (deletion belongs to cleaning).

- F25 [LOW] [CONFIRMED] src/updater.js:505-513 - Second feed call on the no-URL apply path.
  applyUpdateInner re-calls checkForUpdates when downloadUrl is falsy; reachable when the check
  found a newer tag with no exe asset. One extra api.github.com call against the 10/min budget.
  Fix: refuse early when the prior check yielded no downloadUrl.

### Category 7: Observability / operations

- F26 [MEDIUM] [CONFIRMED] src/db.js:381 + src/server.js logLine sink - SKU collision rename
  invisible in the packaged exe.
  What: the single "[init] renamed" line uses console.log, which the packaged exe discards
  (only updateLog is sunk to logLine). Scan lookup is exact-match, so the loser's printed old
  label resolves to the winner.
  Trigger: two parts shared a case-insensitive SKU pre-migration; cashier scans the loser's
  shelf label.
  Impact: wrong part added at the wrong price; no trace of the rename in pos-server.log.
  Fix: route the [init] line through the logLine sink so the rename is diagnosable. Surfacing
  renamed codes in the catalog is a feature, recorded as a non-fix.

- F27 [LOW] [CONFIRMED] src/server.js:980-995 - Pairing failures leave no server trace.
  pair-cloud returns 4xx/5xx via sendJson directly (not thrown), so the outer catch's logLine
  never fires; only success writes an audit row. The toast distinguishes the failure but
  pos-server.log holds nothing afterwards.
  Fix: logLine on each pair-cloud failure branch.

- F28 [LOW] [CONFIRMED] src/updater.js:421-427,464-472 + src/server.js:1999 - Handoff stall
  evidence is disk-only and boot-gated; the 300 ms exit kills in-flight work.
  The :reap giveup branch launches anyway; the handoff log is consumed only at next boot. If the
  old process never exits there is no next boot, so the stall is visible only on the tab. WAL is
  crash-safe and sale op_id dedup covers a retried POST, but an in-flight print may have kicked
  the drawer.
  Fix: name the handoff log path in the stall screen; tail it during the restarting phase.

- F41 [MEDIUM] [CONFIRMED] docs/OPERATIONS_AND_DEPLOYMENT.md:215,266 + ARCHITECTURE.md:72 -
  "read-only replica / strictly one-way / nothing flows back down" is false.
  cloud_commands push adjust_stock and import_inventory down to the shop
  (cloud-deploy/server.js, src/sync.js:101-132 applyCloudCommands).
  Fix: rewrite 5.1/5.5 and the ARCHITECTURE one-liner to describe the command down-channel,
  its auth and its ack/idempotency.

- F42 [MEDIUM] [CONFIRMED] docs/OPERATIONS_AND_DEPLOYMENT.md:221 - "multi-tenant ... does not
  exist" is false. stores table, shops.store_id, per-store PBKDF2 PINs and scoping clauses exist.
  Fix: describe store accounts and the scoping rule.

- F44 [MEDIUM] [CONFIRMED] README.md:3 vs public/js/views/backoffice.js update modal -
  "amber text in Settings only" is false when an update exists. The hasUpdate branch ignores
  silent and unhides the banner, the chip, and opens modal-update at boot.
  Fix: gate banner/chip/modal on !silent, or correct the README sentence to name the boot modal.

- F45 [LOW] [CONFIRMED] docs/API_REFERENCE.md:3 vs :5 - ":3 claims complete" contradicts the
  completeness disclaimer at :5. /api/system/update/progress IS documented (:529). 35 documented
  pairs vs 47 literal + 18 dynamic matchers; the gap is disclosed but the "complete" word is not.
  Fix: drop the "complete" claim at :3.

- F48 [LOW] [CONFIRMED] public/index.html:1196 + docs/superpowers spec - total_spent_paid is
  refund-netted and floored (credits.js) but the ledger label reads "Total paid".
  Fix: relabel to "Net paid" (or similar) so the label matches the refund-netted figure.

### Category 8: Test quality

568 tests, 49 files. Split: behavioral 22 files / 192 tests; hybrid 16 / 321; vm-eval 5 / 28;
pure static 6 / 27. Money/ledger/stock/warranty/print/sync are NOT happy-path-only (failure
markers: sales 19, returns 21, inventory 20, printer 44, credits 8, sync 2 + 5 hardening).
Harness scratch-env verified: helper.js temp DBs, sentinel queue, sendRaw patch;
remediation-final.test.js no longer touches the real shop.db; createServer exceptions audited
by grep (cloud-hardening temp DATA_DIR + PORT:'0', port-drift temp POS_DB_PATH). No test prints
paper or touches real data/.

- F29 [HIGH] [CONFIRMED] src/updater.js:395-459 + tests/updater.test.js:254-308 - The exe swap
  has zero execution coverage, and the string test passes no oldSizePath.
  What: buildApplyScript is asserted only as a string; the seam fakes fetch, staging, the
  packaged-binary guard and the spawn. The test calls buildApplyScript without oldSizePath, so
  String(undefined) yields the literal path "undefined" in the restore set /p line; production
  passes oldsize.txt. The identity compare is never asserted.
  Trigger: a failed copy /y on a real counter enters :restore.
  Impact: the only path that can leave the shop with no executable is the only path never run.
  Fix: run the generated script against a scratch dir with a fake target and a locked .old twin,
  asserting restore and giveup by filesystem effects; pass oldSizePath in the string test.
  (Test-hardening pass work; source read-only there.)

- F30 [MEDIUM] [CONFIRMED] tests/updater-ui.test.js:1-101 - All 6 tests are text regex.
  Three readFileSync calls and regex assertions; imports nothing from helper.js. Gutting the
  controller bodies while leaving IDs/classes passes all 6.
  Fix: keep as a markup gate, add one behavioral test driving the controller against stubbed
  fetch. (Test-hardening pass.)

- F31 [LOW] [CONFIRMED] src/updater.js:197 + tests/updater.test.js:197 - Seam halves the retry
  count (maxAttempts = testHooks.fetchImpl ? 2 : 5); attempts 3-5 and the backoff never run.
  Fix: let the seam set maxAttempts so one test drives the full ladder. (Test-hardening pass.)

### Category 9: Workstation-specific

- F32 [MEDIUM] [CONFIRMED] public/js/views/pos.js (stock-ceiling toast, qty-validation toasts,
  filter empty states, checkout label, "Processing payment...") - New POS counter strings
  untranslated in tl mode; t() never called and i18n.js holds no keys.
  Fix: route these literals through t() with tl mirrors.

- F33 [MEDIUM] [CONFIRMED] public/js/views/backoffice.js:1134-1170 - renderDashboard bypasses
  t() (Parts/Labor, no returns/cash refunded/off utang, Collected, Net after refunds,
  Drawer/shortage/overage/Adj, "Per day, hover a bar for detail.").
  Fix: route through t() with keys in both en and tl.

- F34 [MEDIUM] [SUSPECTED] public/js/views/pos.js:401-431 + docs/OPERATIONS_AND_DEPLOYMENT.md:133
  - A fast human is misread as a scan and the field is wiped; the docs claim "never".
  What: the only discriminator is sub-100 ms gaps plus 6 chars; a fast typist in a non-exempt
  field who presses Enter gets the burst hijacked and the field restored to its pre-burst value.
  The mechanism is provable by code; the human-speed trigger needs a manual test.
  Impact: typed customer name erased, scan refused.
  Fix: the scan gates are a protected decision; re-tuning SCAN_TEXT_FIELDS is behavior work.
  Correct the docs' "never" overclaim; the gate tuning is a deliberate non-fix pending operator
  decision. Manual step 1.

- F35 [LOW] [CONFIRMED] public/js/views/pos.js:400-406 - Stuck modifier keeps the burst buffer
  alive. Auto-repeating modifier keydowns (e.key length > 1) update lastScanKeyTime without
  appending, so the slow-typing reset never fires and stale chars concatenate onto the next scan.
  Fix: update lastScanKeyTime only for printable keys.

Money/ledger/stock/RMA/day-close math, FIFO utang, void-after-close gate, capped() truncation,
dual-tier server-authoritative pricing, locale/appearance cosmetic safety, kiosk lockdown, and
the claim-stub escaping verified CLEAN by the src sweep (RMA caps, atomic stock decrement,
savepoint-wrapped writes, op_log dedup, no centavo drift in integer paths).

### Category 10: Cloud sync / manager app

- F13 [HIGH] [CONFIRMED] cloud-deploy/server.js:971,1110,1124,1215,1228,1261,1294,1360,1371,
  1382,1736,1742 - Fractional quantities truncated to INTEGER in cloud analytics.
  What: cloud casts quantity/stock_quantity/delta AS INTEGER; the workstation keeps fractions.
  Trigger: sell 0.5 of a fractional part (cost 100, price 30): cloud cost CAST(0.5)=0, profit 15;
  workstation profit -35.
  Impact: manager phone profit, units and cover-days wrong for every fractional sale; the
  parity test uses integers only.
  Fix: CAST AS REAL for quantity/stock_quantity/delta (keep voided/archived/id as INTEGER); add
  a fractional case to tests/analytics-parity.test.js.

- F14 [MEDIUM] [CONFIRMED] cloud-deploy/server.js:1458 vs src/inventory.js:582 - Two different
  suggested_qty formulas behind the same /api/inventory/reorder name.
  What: cloud max(sold, deficit, 1); workstation max(sold - stock, 0).
  Trigger: part sold 10, stock 8, min 2: counter sheet says order 2, phone says 10.
  Impact: systematic over-ordering from the phone; the two surfaces disagree.
  Fix: adopt one formula on both sides; add parity coverage.

- F36 [MEDIUM] [CONFIRMED] src/sync.js:180 + cloud-deploy/server.js /api/standing - Backfill
  drops pre-window sales that still carry debt.
  What: backfillMirror pushes only 30-day sales; /api/standing sums credit_balance over mirrored
  sales only.
  Trigger: pair a shop with a 60-day-old unpaid utang.
  Impact: phone outstanding_credit and debtor_list understate the counter until a settlement or
  void happens to enqueue the old sale.
  Fix: add OR credit_balance > 0 to the backfill sales selection.

- F37 [LOW] [CONFIRMED] cloud-deploy/server.js:943-947 vs src/credits.js - debtor_list phone is
  permanently empty. Cloud reads customer_profiles.phone, which no write path sets; the
  workstation shows sales.customer_phone.
  Fix: source MAX(sales.customer_phone) like the workstation.

- F38 [LOW] [CONFIRMED] cloud-deploy/public/app.js:1285-1288 - Keyboard login auto-submits at 4
  digits; rotated PINs are 8. The hardware-keyboard path cannot log in (keypad GO and text input
  still work).
  Fix: submit on Enter only.

- F39 [LOW] [CONFIRMED] src/server.js:948-1015 + src/sync.js:41-52 - Pairing cannot see env
  overrides. SYNC_URL/SYNC_TOKEN env wins at drain; pairing while SYNC_URL is exported pushes to
  the env target with the fresh token (401 loop, UI reports success). Documented deliberate at
  OPERATIONS:252, so this is a missing UI warning, not a code bug.
  Fix: warn when env overrides are present; name old-VPS residue in the re-pair flow.

- F40 [LOW] [SUSPECTED] src/money.js vs cloud-deploy/server.js:1062 r2 - Rounding tie rules
  differ (money half away from zero; Math.round ties toward +Infinity; r2 coerces non-finite to
  0). One-centavo disagreement on rare negative ties.
  Check: compare net_profit on a dataset engineered to -x.xx5. Fix: port money()'s tie rule.

KNOWN OPEN status: SSE broadcast scope mitigated (residual untagged deploy broadcast); console
secrets no new prints (setup logs name file paths only); analytics parity now has a test but no
fractional case (F13) and no /api/inventory/reorder parity (F14); self-update apply still never
exercised for real (manual). Enqueue sweep, list agreement, exposure budgets, cadence, chip and
freshness, cloud backup, pairing failure paths verified CLEAN.

### Schema / settings

- F43 [MEDIUM] [CONFIRMED] docs/DATABASE_SCHEMA.md:120,168,184 - Fractional quantities absent
  from the schema spec; allow_fractional undocumented; columns declared INTEGER while the code
  writes 3-decimal reals.
  Fix: add allow_fractional, note the 3-decimal rounding and that INTEGER affinity stores
  fractions as REAL.

- F46 [LOW] [CONFIRMED] src/settings.js:30-56 - Cleared numeric settings read as 0, not the
  default. Number('') and Number(null) are 0, passing the isFinite && >= 0 guard; the route
  comment claims the read side keeps its default. warrantyDays has the correct blank guard;
  these four do not. The official UI masks it.
  Fix: treat blank/null as missing in the four helpers, mirroring warrantyDays.

- F47 [LOW] [CONFIRMED] src/db.js:94,106,139,150 - Fractional quantities live in INTEGER-declared
  columns. SQLite INTEGER affinity is NUMERIC, so non-integral reals store as REAL; runtime is
  correct and the cloud mirror stores JSON blobs. The declared schema lies to future tooling.
  Fix: document the affinity reliance (F43) rather than rebuild columns; recorded as a
  deliberate non-fix (a column rebuild is risk than value at this scale).

### Release pipeline / stray files

- F49 [LOW] [CONFIRMED] scripts/publish-release.ps1:525 - main pushed before the already-published
  guard (536). A re-run lands a "Release vX" commit and version rewrites on main, then throws.
  Fix: move the guard above the push.

- F50 [LOW] [CONFIRMED] publish/ = 4.6 GB, never pruned, with live runtime state (data/, backups/,
  browser-profile/, pos-server.log); dist/ = 241 MB with vendor-private-key.pem. All gitignored;
  the release zip is built from a temp dir holding only the exe + README, so nothing leaks.
  Vendor disk only. Stray-file cleanup; report-only, ask before deleting (cleaning pass).

Release order verified: npm test and build:exe run before any git mutation;
ErrorActionPreference=Stop makes Write-Error terminating; commit -> push main -> published guard
-> tag -f -> draft -> uploads -> publish. A death between tag push and upload leaves a draft
(/releases/latest ignores drafts), so shops keep seeing the prior release; the guard works.
Get-NextVersion reuses the staged version after an abort (idempotent for the abort case); after a
successful publish it derives the next minor (correct). Get-GithubReleases used at all listings.

## 3. Future Scale Notes (not findings at this scale)

- Multi-shop SSE: the untagged deploy broadcast forces a refetch for every store; fine at one
  shop, noisy at many.
- listInventory unbounded and the 500-row RMA cap: paginate past ~2000 customers / years of RMAs.
- The two independent profit implementations (workstation + cloud) are a parity maintenance tax
  that grows with every new field; a shared formula module would matter at multi-tenant scale.
- publish/ retention: a vendor staging many builds will want a prune; a shop never notices.

## 4. Ranked remediation plan (severity / effort)

Quick wins (low effort, high value): F3, F4 (argument position), F2 (one line), F11 (datetime
wrap), F8 (re-check), F12 (spread order), F46 (blank guard), F17 (tombstone), F37 (phone source),
F38 (Enter only), F49 (move guard), F45/F48 (doc/label words).
Money path (careful, tested): F1, F7 (one line formula), F5 (money()), F10 (scale first), F13
(REAL casts), F14 (one formula), F16 (min alert), F36 (backfill debt).
Security (careful): F19 (drop adoption), F20 (login guard), F18 (unconditional floor + seal),
F21 (global budget).
Frontend behavior: F6 (fractional RMA form), F23 (flush guard), F32/F33 (i18n), F35 (modifier).
Observability: F26 (logLine), F27 (pair log), F28 (stall screen), F44 (boot modal/README).
Docs: F41, F42, F43.
Routed to later passes: F24 (cleaning), F29/F30/F31 (test hardening), F50 (cleaning, ask first).
Deliberate non-fixes: F34 gate tuning (protected decision; doc corrected), F47 column rebuild
(document affinity), F20 exe LAN auto-ack (deliberate design; doc note), F22 pending runtime
proof, F40 pending runtime proof.

## 5. Measurement list (runtime / manual verification)

Suite: npm test (rerun a red before concluding; a hang is a rerun). Live server checks: copy
src/ + public/ (or cloud-deploy/) to a temp dir, run with NODE_ENV=test NO_AUTO_BROWSER=1
NO_AUTO_EXIT=1 on a high loopback port; use localhost, never the real VPS or real tokens; the
sentinel queue in tests/helper.js is the print mechanism, do not bypass it. NEVER run the update
apply against the working tree.

1. F1/F7: print a fractional sale (0.25 x 0.58) on 58mm and 80mm; compare cart total, thermal
   slip, browser fallback and claim stub lines vs total. (Code fix verified numerically; paper
   proof is manual.)
2. F22: in a scratch dir, drive a torn-prefix .part resume and a digest mismatch; confirm whether
   the .part rots across retries and whether the message names the file.
3. F40: compare cloud net_profit vs workstation on a dataset engineered to a negative half-centavo.
4. F34: type a 6+ char customer name at <100 ms/key then Enter; confirm whether the burst hijacks
   and wipes the field. Scan a retail code, a <6-char SKU, a leading-zero EAN-13, an unknown code,
   an out-of-stock code, and the same code until stock runs out, with the caret in each of the five
   exempt fields; confirm a hijacked burst restores the field; pull the trigger with no Enter suffix
   and with a stuck Shift (F35).
5. F18: with the POS closed, apply the five-row trial edit and restart; confirm the floor now
   catches it (after fix) and that the residual (wipe audit log + move db file) still bypasses.
6. Update install (manual, on a machine holding TechPartsPOS.exe): run the full apply; confirm the
   version badge and shop.db survival; kill mid-download and confirm resume; force a digest
   mismatch; block the old process's exit to force :reap giveup and read
   %LOCALAPPDATA%\TechPartsPOS\TechPartsPOS_update.handoff.log; confirm a browser-zip-downloaded exe
   (Mark-of-the-Web) still launches after a manual swap (the in-app path writes bytes via fs with
   no Zone.Identifier, so it carries no MOTW).
7. Drawer (manual): confirm a refused queue does not pulse the drawer on a sale never taken, a
   reprint does not ring it twice, and the claim stub does not ring it.

These three surfaces close only by hand at the counter: the physical scanner exercise, the printed
slip including the claim stub, and the real update install. They are never marked verified from
browser evidence.