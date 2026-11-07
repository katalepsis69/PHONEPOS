# TechParts POS Remediation Plan (COMPLETED, 2026-11-06)

Source: audit v7 (docs/audit-2026-11-05.md), run per docs/code-audit-prompt.md v7
with the operator's standing blanket approval fixing every finding in the same
run. Suite: 511 tests in 44 files, 511/511 pass. Pre-fix snapshot:
backups/code-pre-v7-audit-2026-11-05/ (full tree), behind it
backups/code-pre-cloudsync-fixes-2026-11-05/.

## Fixed (all findings from the v7 report)

Workstation:
- Backup tick now takes a db getter, so restoring a backup no longer kills the
  hourly snapshot until restart (was HIGH).
- License: a deleted trial seal reseeds over a first-run floor taken from the
  shop.db file birth time and the oldest audit row; the highest clock ever seen
  is persisted and trial expiry is judged against it; licenseNow holds the
  highest seen on ANY rollback, closing the 23h59m daily crawl.
- Sync: an all-corrupt outbox window is quarantined instead of livelocking the
  drain every 2s; a failed push logs one line per failure streak to
  pos-server.log (the chip resets nightly, the log does not).
- Staff create/reset-pin/deactivate write and audit in one savepoint.
- customers.csv header renamed total_spent_paid; after-close exceptions skip
  voids that preceded the sign-off; replacement cost leaves the P&L when the
  parent sale is voided (all three analytics sites).
- Day-close comment now states the real rule (future days refused only).
- GET /api/system/update/progress got its own fixed-window budget (300/min).
- Installer/TechPartsPOS.iss: the 2.3MB mojibake comment line truncated to its first sentence.
- Updater: [update] log lines now route through the server logLine sink, so they reach pos-server.log in the packaged exe (console.log is discarded there).
- Updater: the 22.5k-char mojibake message and the dangling no-signing comment
  reference replaced; the handoff helper writes milestone lines to a log file
  the next boot prints (the swap outcome was invisible); a reap giveup keeps
  the staged exe and resume marker as retry material.
- Frontend: claim stub prints nothing during a sale in flight, formats money
  through the shared grouped/refusing formatter, and escapes verified by a new
  vm test; the hardcoded v2.3 fallbacks render unknown; the dev-mode release
  page opens with noopener; the success-path 400ms progress poll is stopped
  before the handoff screen replaces the DOM; the dead empty-URL pairing
  branch is gone (readonly managed URL documented); bulk.replayed i18n key
  added to both tables; the import auto-price tip states the real rule.

Cloud (cloud-deploy/, mirrored to cloud/):
- POST /api/deploy: login-class budget, durable deploy-log.jsonl with
  old/new SHA-256, and a .prev rollback copy of every replaced file.
- Login: process-global attempt budget behind the per-client one; the
  guess-once-try-all fallback is capped at 8 stores and skips empty hashes.
- create-store: first-run bootstrap stays open; once any claimed store exists,
  additional stores need the server manager PIN (403 otherwise), which also
  removes the 409 name-enumeration oracle.
- Credential values no longer print at boot (paths only; --rotate-pin keeps
  printing the PIN it was run to deliver).
- An empty heartbeat batch no longer broadcasts, so manager phones stop
  refetching the whole dashboard once a minute per shop.
- DELETE /api/shops/:id writes the credentials file before mutating memory,
  so a failed write can no longer resurrect a live credential.
- Top-products parity: the cloud now ports the workstation's per-line clamps,
  zero-subtotal allocation and all-time per-line refunds exactly.
- Manager app: the online badge counts shops heartbeating within 5 minutes;
  the SSE beacon keys to data freshness, not socket state; audit-banner counts
  are labeled recent (newest-500 window); the keypad accepts up to 12
  characters with an explicit Sign in key (rotation mints 8-digit PINs).

Pipeline:
- deploy-cloud.js direction fixed: cloud-deploy/ is the edit source (synced
  INTO cloud/ and uploaded), so edits are no longer reverted and stale mirror
  code is no longer pushed; non-HTTPS targets are refused except loopback.
- publish-release.ps1 aborts before the tag force-push when a PUBLISHED
  release with that tag exists; -Version patch on a two-part base emits x.y.1
  instead of a disguised minor bump; publish.bat's banner says it stages
  locally and publishes nothing.

Docs:
- README states the boot update check is always on (was: optional and off).
- OPERATIONS 5.3/5.4 rewritten around the pair-code flow, the readonly managed
  URL, the 30-day backfill, the heartbeat and the chip's error state.
- API_REFERENCE gains the update-progress, create-store, deploy and
  delete-shop routes; DATABASE_SCHEMA gains the operational tables and the
  cloud mirror.
- docs/OPERATIONS printMoney call-site count moved to seventeen in lockstep
  with its pinning test.

Tests: 6 new behavioral tests (cart quantity editor vm, claim stub renderer
vm, backfill exclusion set, sync failure observability, heartbeat SSE quiet,
changelog currency) plus updated updater/cloud/backup tests for the changed
shapes; the tests/ sweeper and scrub now cover -journal files.

## Second pass (2026-11-07): the recorded non-fixes, done

- Inventory edit-modal stock set is now guarded: the modal stamps the shelf
  count it loaded (expected_stock) and one op key; the server refuses a save
  whose form has gone stale (409, the modal reopens with the fresh row) and
  dedups a retried PUT through op_log.
- The claim stub prints through the ESC/POS queue like every other slip:
  renderClaimStubSlip in src/printer.js, kind=claim_stub on POST /api/print,
  the browser render demoted to the fallback, with roll-budget, refusal and
  route tests.
- Shop-level SSE scoping: change events name their shop and the manager app's
  refetch now skips other shops' events (onSseChange, vm-tested).
- Cloud-versus-workstation parity harness (tests/analytics-parity.test.js):
  one dataset through getProductPerformance and the spawned cloud's
  /api/analytics, equal to the centavo. It caught two real defects in the
  earlier top-products port (a subquery outside its SUM correlating with an
  arbitrary group row, and a misplaced group paren).
- Bounded i18n: the update button/chip/banner states, drawer labels and claim
  stub toasts are keyed en+tl; the three full-screen handoff blocks stay
  self-contained English on purpose (dying DOM, no session to read a language
  from).
- seed.js seeds the starter catalog in one savepoint; the updater's :restore
  branch compares the .old twin against the size the parent recorded (a
  foreign twin is restored but flagged in the handoff log); the kiosk lockdown
  behavior is documented; the display path (sumline and stub rows) computes
  line totals in integer cents; the sync chip has a vm test; the port-race
  reserve-then-release in the spawned-cloud harnesses is gone (PORT=0, the
  boot line reports the bound port); and the tree is under version control
  (commit e08de69, local only, nothing pushed).
- Suite after the second pass: 520 tests in 45 files, 520/520.

## Deliberate non-fixes (recorded, not done)

- The claim stub stays browser-only (no ESC/POS encoder); its money and
  escaping are now pinned, but a queue-routed stub is a larger change.
- Inventory edit-modal absolute stock set stays a read-modify-write (one shop,
  1-3 seats; the movement trail is the trace).
- Shop-level SSE scoping: store-level scoping landed 11-02; per-shop remains
  open for a real multi-tenant fleet.
- Mass i18n of the update-UX, drawer and claim-stub strings (recorded split).
- A full cloud-versus-workstation analytics parity harness (top-products is
  now line-for-line; the rest is asserted per side).
- CHANGELOG.md gets its next entry at release time from the publish pipeline;
  this batch is recorded here and in docs/audit-2026-11-05.md.
- Concurrent editing sessions remain an operational hazard (two live agent
  sessions reverted files on 2026-11-05): one writer at a time, or adopt
  version control.

# TechParts POS Remediation Plan (COMPLETED, 2026-09-27)

Source: code and system audit v2 (2026-09-27) plus the runtime measurement pass
and a final 4-category sweep the same day. The user approved the whole queue in
one pass ("fix every remaining problem and leave nothing behind"). Every item
below is DONE and verified by `node --test` (268 tests, 268 pass, 0 fail).
Pre-edit snapshots of every touched file live in `backups/code-pre-final-fixes/`
(earlier batches: `backups/code-pre-*`), plus new behavioral coverage in
`tests/remediation-final.test.js` and static greps in
`tests/frontend-regressions.test.js`.

## Ground rules that were followed

- No git. Every edited file was snapshotted to `backups/code-pre-*/` first;
  test-file copies carry a `.bak` suffix so `node --test` never scans them.
- `node --test` green after each group; every non-trivial fix has a behavioral
  test (see `tests/remediation-final.test.js`).
- Phase 2 items were decision-blocked; the blanket approval answered them.
  Each chosen default is written below next to its item.

## Phase 1: the problems (all DONE)

1. **Workstation security headers** [MEDIUM] DONE (earlier batch). CSP,
   nosniff, frame and opener-policy headers set once at the top of the
   `src/server.js` request handler; `report.html`'s inline script extracted
   verbatim to `public/js/report.js` so strict CSP holds.
2. **Backup failure visibility + static stream error handler** [MEDIUM/LOW]
   DONE (earlier batch). Failure branch routes through `logLine`;
   `fs.createReadStream(...).on('error', () => res.destroy())`.
3. **Settlement slip placeholder print gate** [LOW] DONE (earlier batch).
   Hard gate before `printSettlementReceiptById`, soft gate in
   `submitCreditSettlement`.
4. **GCash and transfer sales require a reference number** [LOW] DONE.
   `src/sales.js` rejects a gcash/transfer sale without `payment_reference`,
   mirroring the credits.js wording and message style. Behavioral test:
   `remediation-final.test.js` ("gcash and transfer sales require ...").
   Existing e2e payloads already carried refs; four test fixtures were
   updated to model the requirement.
5. **Deleting a sold part answers 409, not a generic 500** [LOW] DONE.
   `src/inventory.js` `deleteInventoryItem` pre-checks `sale_items` and throws
   `statusCode 409` with an archive suggestion. Behavioral test included.
6. **report.html lockout copy** [LOW] DONE. Footer now says the report page
   locks for 15 minutes and the counter is never affected.
7. **Void after a warranty credit refund names the RMA** [LOW] DONE.
   `src/sales.js` `voidSale` rejects with the RMA's return code before the
   settled-balance check can misfire. Behavioral test asserts the code is
   named and the word "settled" is not.
8. **sync_url hidden from staff sessions** [LOW] DONE. The `GET /api/settings`
   route omits `sync_url` and `sync_shop_id` for staff sessions.
9. **Documentation drift** [LOW] DONE. Five edits: ops doc HOST default is
   `127.0.0.1` and the setup text now matches per-shop credentials;
   `TRUST_TLS_PROXY` documented in the TLS-proxy step; DATABASE_SCHEMA.md
   section 4 rewritten from the fictional `user_version` system to the real
   guarded-ALTER approach; `public/app.js` references in the ops doc and
   ARCHITECTURE.md repointed at the `public/js/` module layout;
   SECURITY_AND_LICENSING.md `PRIVATE_SETTINGS` sample now lists all ten keys.
10. **ACTION_LABELS re-keyed; demo reset documented** [LOW] DONE. The label
    map in `public/js/auth.js` was rebuilt from the actions the server
    actually emits (staff_create, staff_reset_pin, receipt reprint,
    inventory adjust_stock/archive/unarchive/delete/export/seed_starter,
    report_login(+failed), day_close close, system export/shutdown,
    reset_demo; dead keys removed). Demo reset divergence documented in
    `docs/API_REFERENCE.md`.

Also DONE in this batch:
- **Dead dispatcher entries** (`public/js/main.js` `reprint-sale`,
  `refresh-exceptions`) removed; they had no call sites. The tested
  `reprintSale` wrapper and the audited `/api/sales/:id/reprint` route remain
  (pinned by `tests/server.test.js`).
- **429 dead code wired through** (the plan's "explicitly not fixing" note,
  swept up under the blanket approval): the report login route now forwards
  the auth layer's 429 instead of flattening it to 400; the report client
  already rendered `data.error` for any non-OK status. `tests/report.test.js`
  updated to expect 429.
- **Stale backup artifact test** renamed to
  `backups/code-pre-licensegen-2026-09-27/license.test.js.bak` so the suite
  is fully green with no pre-existing failures.

## Phase 2: needs-careful-planning items (all DONE, decisions recorded)

1. **cloud.db backup and re-seed path** [HIGH] DONE. Decision: the cloud view
   is disposable-in-disaster. `cloud/server.js` now snapshots cloud.db daily
   (VACUUM INTO a temp file, integrity_check gate, atomic rename, 14-day
   retention) into `DATA_DIR/backups/cloud-<date>.db`, first run at startup
   plus an hourly tick. No re-push-history mode was built; if durability of
   the mirror itself ever becomes the product promise, that is the upgrade
   path.
2. **Idempotency keys for settlement and returns** [MEDIUM] DONE. Decision:
   same contract as sales. Client-generated `op_id` (UUID) on both paths;
   guarded `ALTER TABLE` + partial UNIQUE index in `src/db.js`; replay
   returns the existing record so a timeout retry looks seamless
   (settlement replay returns the refreshed customer, return replay the
   original RMA). The backoffice client mints a key when the intent starts,
   reuses it across retries and PIN prompts, and clears it on confirmed
   success.
3. **Cloud mirror completeness** [MEDIUM] DONE with a privacy carve-out.
   Decision: `day_reconciliations`, `cash_adjustments`, and
   `customer_profiles` now enqueue and are whitelisted on both sides
   (workstation `ALLOWED_SYNC_TABLES`, cloud `ALLOWED_TABLES` +
   `MANAGER_ROW_TABLES`), so the manager app can see day closes, drawer
   adjustments, and credit limits via `/api/rows`. `customer_profiles.notes`
   is owner free text and never leaves the shop: the profile snapshot is
   built explicitly without it (`enqueueCustomerProfile` keys on rowid).
   Pre-upgrade history for these tables does not backfill.
4. **Split data home: instance lock and mirror target** [MEDIUM] DONE.
   Decision: one machine, one register. The single-instance lock now lives
   machine-wide at `%LOCALAPPDATA%\TechPartsPOS\server.lock` (tests never
   read or write it), so the packaged exe and a dev instance hand off port
   3000 instead of racing. `scripts/mirror-backups.js` prefers the exe home
   whenever `%LOCALAPPDATA%\TechPartsPOS\data\shop.db` exists;
   `POS_BACKUP_DIR` still wins for explicit setups. Documented in the ops
   doc, section 3.3. A manual run against a real installed exe remains a
   recommended field check before the next customer build.
5. **/sync request budget** [MEDIUM] DONE. Decision: auth before readBody
   (header-only credential check; unauthenticated requests get 401 before a
   byte is parsed), plus a fixed-window per-client budget of 120
   requests/minute that answers 429 into the agent's existing backoff. The
   opt-in legacy shared token still works (it needs the body for the claimed
   shop id). Behavioral test floods a live cloud server and asserts 429.
6. **Outbox policy while sync is off** [MEDIUM] DONE. Decision: keep
   enqueuing (so enabling sync later backfills the recent month) and prune
   unsent rows older than 30 days while off, in the drain's no-URL path.
   Documented in the ops doc, section 5.1.
7. **UTC-anchored backup date** [LOW] DONE. Decision: the guard and filename
   key on `date('now','localtime')`. One extra snapshot fires on the first
   run after the change (accepted). Installer checklist needs no change.
8. **validateSyncUrl DNS resolution** [LOW] DONE. Decision: resolve at save
   time only, never in the drain. A public hostname that resolves to a
   private address is rejected; a failed lookup saves with a warning the
   response carries (`warning` field) instead of blocking. Behavioral test
   uses an RFC 6761 `.invalid` hostname for the warning path.

## Standing reminders

- License generator: RESOLVED 2026-09-27. The pem lives in `dist/`
  (vendor-only; back it up offline) and the matching public key is baked into
  `src/license.js`. Rebuilds fail fast if the POS exe is running.
- Audit artifacts that must not ride along in any handed-off copy:
  `smoke.db` and its `-wal`/`-shm`, `scripts/probe2.db`, `pos-crash.log`,
  `pos-server.log`, live `data/`, and the `backups/` tree.
- Before the next customer build: close the POS, run `npm run build:exe`, and
  manually smoke the exe (lock hand-off, mirror resolution, backup cadence).
