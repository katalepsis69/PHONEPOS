# Code and System Audit Prompt (v9)

[v9, 2026-11-12, measured refresh 2026-11-13, supersedes v8 of 2026-11-09 (which superseded
v7 of 2026-11-05, v6 of 2026-11-02, v5 of 2026-10-14, v4 and v3 of 2026-10-02; a frozen v3
sits at backups/code-pre-fixbatch-2026-10-04/docs/code-audit-prompt.md). THIS EDITION IS
MEASURED ON 2026-11-13 at HEAD b55f517 (branch main, tag v1.1, 4 unpushed commits ahead of
origin/main):
npm test reports 642 tests across 52 tracked files (642/642 pass in about 30 s; the rerun
rule in GATES stands), and npm run build:css exits 0. Version is 1.1 across package.json:3,
CURRENT_VERSION (src/updater.js:11), and MyAppVersion (installer/TechPartsPOS.iss).]
POST-v2.8 LANDINGS ALREADY MERGED ON MAIN (94d1206..cf06069, first-look audit targets):
1) Universal POS & Cloud Hardening (113ebc2): store profiles (phone_repair / general_retail /
   pc_components), fractional quantities, wholesale price tiers, cloud/workstation analytics
   parity suite (tests/analytics-parity.test.js), EN/TL copy expansion (public/js/i18n.js),
   updater UI dialog polish, and cloud CSV formula hardening.
2) Protected Installer, SYSTEM Service, Manager PIN Recovery & USB Backup (783023a..533f07a):
   - Manager Recovery Password & "Forgot PIN?" (src/auth.js, src/settings.js, src/server.js,
     public/js/auth.js, public/js/views/backoffice.js, public/index.html): mandatory 8+ char
     PBKDF2 recovery password (PIN_NAMESPACES.recovery, independent 15m lockout),
     PRIVATE_SETTINGS redaction (recovery_password_hash, recovery_locked_until,
     recovery_failed_attempts), GET /api/auth/recovery-status, POST /api/auth/recovery-password
     (gated by elevated non-default PIN session), POST /api/auth/recover-pin, and inline
     "Forgot PIN?" local reset flow.
   - Program Files to ProgramData data routing & SYSTEM Background Service (src/db.js,
     src/server.js, src/updater.js, installer/TechPartsPOS.iss, scripts/build-installer.js,
     scripts/mirror-backups.js): isProgramFilesPath() routes Program Files installs to
     C:\ProgramData\TechPartsPOS; Inno Setup 7 compiles dist\installer\TechPartsPOS-Setup-2.8.exe
     creating scheduled task TechPartsPOS-Server running TechPartsPOS.exe --service as
     NT AUTHORITY\SYSTEM with icacls ACLs protecting ProgramData while leaving runtime\ readable;
     --service binds 127.0.0.1 only when HOST is unset, writes runtime/server.json and
     runtime/server.lock, and returns 400 on POST /api/system/shutdown ("Close POS" closes
     only the kiosk window); desktop shortcut invokes runInstalledLauncher() reading
     runtime/server.json (recovering via schtasks /Run if stopped); auto-updater routes
     service staging via defaultUpdateStagingDir(true) and relaunches TechPartsPOS-Server
     via schtasks in both :startnew and :restore branches.
   - USB Backup Download & Installer-Only Releases: GET /api/backup/download using shared
     resolveVerifiedBackup(backupDir, rawFile, action) ("Download copy" button in Settings);
     scripts/publish-release.ps1, scripts/generate-changelog.js, and RELEASE_NOTES.md
     publish TechPartsPOS-Setup-<ver>.exe, TechPartsPOS.exe, and .sha256 with zero .zip
     archives; tests/ui-fixes.test.js normalizes CRLF in source() for Windows Git checkouts.
3) Official releases v1.0 and v1.1 (e3bbe7e..cf06069, tags v1.0 and v1.1): the 2026-11-12
   second-pass fixes (version-skew command ack, wholesale tag) and refused-scan session
   review, then the release batch: Windows service installer expansion with branding
   assets and embedded exe icon (installer/TechPartsPOS.iss, installer/brand/,
   installer/license.txt), Dim and Paper themes (public/js/theme.js, public/styles.css),
   inventory UI batch (public/js/views/inventory.js), and the version renumber 2.8 -> 1.1
   across package.json, CURRENT_VERSION, and MyAppVersion; new tests appearance-tones
   .test.js and build-exe-icon.test.js.
GIT IS THE HISTORY NOW: 6834474 (2026-11-07) brought the full source tree under version
control. git log, git diff, and git blame are primary history; git status is the
interference detector (hazard (f) below survives on that point); never git --amend because
the release pipeline commits mid-session.
CLOUD TREE DUALITY: cloud/ and cloud-deploy/ both exist; as of 2026-11-13
their server.js (1929 lines), public/app.js (2009 lines) and public/index.html (1613 lines)
files are byte-identical and cloud/ additionally holds data/ (runtime state); re-verify at
audit time. DEPLOY DIRECTION, measured 2026-11-05 and contradicting the folder names:
scripts/deploy-cloud.js copies cloud/ INTO cloud-deploy/ and uploads the cloud/ copies to
POST /api/deploy, so cloud/ is the script's source of truth and cloud-deploy/ the mirror;
deploy-cloud.bat's own prompt says the reverse. Treat EITHER tree's server.js as the same
code only while byte-identical; verify hash parity first.
Companion: docs/refactoring-prompt.md (now v3) governs zero-behavior-change refactoring
passes; docs/remediation-prompt.md, docs/code-cleaning-prompt.md,
docs/test-hardening-prompt.md and docs/feature-batch-prompt.md complete the six-pass
system dispatched by the techparts-pass skill (.agents/skills/techparts-pass/SKILL.md).
WORKFLOW CHANGE SINCE v6: this prompt still reports before it fixes, but the operator has
granted STANDING BLANKET APPROVAL for the run that follows the report: every finding in the
report is fixed in the same run, one commit-style batch, each fix carrying a regression test
or an explicit test update, the suite green before delivery, and deliberate non-fixes
recorded. The report still lands first and is never edited after the fixes to look
prescient.]

ROLE
You are a senior code auditor. Your job is to FIND and REPORT problems before touching
anything. The deliverable is a report, and the report lands complete before the first fix.
Under the standing blanket approval recorded in the header, the same run then fixes every
finding; the report is never retro-fitted to the fixes.

OPERATING SCALE (judge every finding against THIS)
- One shop, one Windows PC, 1 to 3 cashier/manager seats. The UI is the vanilla
  ES-module SPA in public/, served locally by the Node process. In dev/direct runs, the
  process launches an Edge/Chrome window with --kiosk-printing and exits via its
  heartbeat watchdog when closed. In installed Program Files setups (--service mode via
  scheduled task TechPartsPOS-Server under NT AUTHORITY\SYSTEM), the server binds 127.0.0.1
  and persists shop data in C:\ProgramData\TechPartsPOS; the desktop shortcut launches an
  installed browser client reading runtime/server.json, and "Close POS" closes only the
  window (POST /api/system/shutdown returns 400). Look for loopback-only exposure unless
  configured explicitly in dev/LAN mode (docs/OPERATIONS_AND_DEPLOYMENT.md).
- Interface language and typography are machine-local browser state (the localStorage
  keys pos_lang and techparts_appearance), deliberately not server settings and
  deliberately not synced. Two seats showing a different language or a different font
  preset is expected behavior, not drift to report.
- Node.js 22.5+ standard library only (node:http, node:sqlite DatabaseSync,
  node:crypto, node:fs). Zero npm runtime packages by contract (package.json declares
  none); @tailwindcss/cli and postject are devDependencies used at build time only.
- One SQLite database file under data/ (WAL mode, foreign_keys ON, busy_timeout 5000;
  the cloud DB is held to the same bar). Roughly 20-100 sales/day, thousands of rows
  per year (adjust if your shop differs).
- Offline-first on the SALE path. The update check is a documented, deliberate exception
  and README.md:3 now says so out loud, so v5's "the docs do not admit this" framing is
  closed: public/js/main.js:847 fires checkForAppUpdates(true) at boot with no settings
  key gating it (no update-related key exists in EDITABLE_SETTINGS, src/settings.js:17)
  and src/updater.js:306 calls api.github.com. Judge the behavior, not the doc: what
  happens on a shop LAN with no route to GitHub, what the abort costs the counter,
  whether a failure is distinguishable from up to date, and whether an outbound call with
  no operator consent belongs in the posture docs at all now that it is documented in the
  customer README. On the shop LAN, report.html serves a read-only phone report with no
  cloud at all; a non-loopback bind must be acknowledged by the operator first
  (docs/OPERATIONS_AND_DEPLOYMENT.md section 5.6).
- WHEN CLOUD SYNC IS ENABLED, add this second profile: one VPS running cloud/server.js
  (cloud-deploy/server.js, 1191 lines) reachable from the public internet; the workstation
  pushes row snapshots out; the manager phone app logs in over the internet and watches
  Server-Sent Events for live updates. Treat every cloud route as internet-facing and
  every cloud finding as higher severity than its LAN equivalent.
- Distribution is an Inno Setup 7 installer (dist/installer/TechPartsPOS-Setup-1.1.exe)
  wrapping the Node SEA executable (release/customer/TechPartsPOS.exe; verified on disk
  2026-11-12, no portable .zip archive). GitHub Releases carry TechPartsPOS-Setup-<ver>.exe
  plus TechPartsPOS.exe and TechPartsPOS.exe.sha256 for in-app auto-updates. dist/ is the
  vendor workspace and never ships. NOTE FOR CATEGORY 3 AND 7: dist/ holds backups/,
  browser-profile/, data/, and pos-server.log from vendor workspace runs.
If a problem cannot manifest at this scale, it belongs in "Future Scale Notes", not
in the findings. Do not manufacture performance problems where they cannot occur.

WHAT TO AUDIT (and what to skip)
Audit: src/ (server.js 2477, printer.js 974, updater.js 728, analytics.js 593,
inventory.js 610, license.js 483, db.js 474, auth.js 398, sync.js 356, credits.js 310,
sales.js 295, returns.js 235, settings.js 149, seed.js 133, reconcile.js 123,
audit.js 112, shifts.js 86, names.js 43, money.js 35; 8614 lines total across 19 files),
public/ sources (js/ including views/ (backoffice.js 2213, inventory.js 1822, pos.js 1689),
auth.js 2591, receipts.js 1031, main.js 1036, i18n.js 1039, ui.js 545, report.js 395,
importer.js 154, theme.js 138, search.js 116, chart.js 84, state.js 77, api.js 58,
cart-recovery.js 11, index.html 2719, report.html 483, styles.css 5828, report-sw.js,
the manifests; skip fonts/ and the generated tailwind.build.css), cloud-deploy/
(server.js 1929, public/app.js 2009, public/index.html 1613, byte-identical to cloud/ at
measurement time; the manager app), scripts/ (generate-license.js 421, set-pin.js 67,
mirror-backups.js 70, build-artifacts.js 90, build-exe.js 123, build-common.js 193,
build-license-exe.js 89, build-installer.js 60, verify-exe.js 275, release-customer.js 58,
check-repair-ui.js 110, deploy-cloud.js 82, generate-changelog.js 669, publish-release.ps1
662), installer/TechPartsPOS.iss (379 lines), tests/ (52 tracked *.test.js files plus
helper.js and cloud-hardening-harness.js), and the docs:
README.md, RELEASE_NOTES.md, ARCHITECTURE.md,
DATABASE_SCHEMA.md, API_REFERENCE.md, BUSINESS_LOGIC_AND_WORKFLOWS.md,
SECURITY_AND_LICENSING.md, OPERATIONS_AND_DEPLOYMENT.md, README-DEV.md. REMEDIATION_PLAN.md
is a dated completion record, docs/superpowers/ specs and plans are project history, and
AGENTS.md / GEMINI.md / SKILL.md are tone-and-rules files; treat all of them as history,
not as spec.
Skip contents of: node_modules/, scratch/, dist/, release/, publish/, backups/,
browser-profile/, gui-test-screenshots/, .superpowers/, .zcode/, .kilo/, .freebuff, cloud/
(runtime mirror of cloud-deploy/, plus its data/; audit cloud-deploy/ instead). You may
note on-disk artifacts that should not ship without auditing their contents:
publish/ (~4.67 GB), pos-server.log at the root (~3.3 KB, unrotated), data/ and
cloud/data/ contents, the live-runtime state inside dist/, and the root .bat entry points
(publish.bat, publish-release.bat, deploy-cloud.bat). (cloud-deploy.zip is gone.)
CLOSED, do not re-report: the tests/ t_*.db litter (verify still zero). smoke.db,
scripts/probe2.db and pos-crash.log stay gone.
Allowed: reading files, greps, read-only commands, npm test. Not allowed: editing or
creating files, any write against the real data/ shop.db or the real cloud.db,
starting long-running servers, and NEVER sending real shop data, sync tokens, manager
PINs, or the vendor key to any network target. To exercise sync or cloud paths, use
localhost or a local throwaway instance only, never the real VPS.
Read README.md first, then the docs listed above. Those docs are the spec. The
codebase states intent in long comments by convention; where a comment states
deliberate behavior, verify the code matches the comment; do not flag the comment.
Where code and doc disagree, that is a finding.

METHOD FOR SEEING WHAT CHANGED (git is the history since 2026-11-07)
Primary tools: git log --oneline, git log --stat, git diff v1.0 (tags are now v1.0 =
e875978 and v1.1 = cf06069),
git blame for a line's history, git status as the interference detector. For changes
older than 6834474 the snapshots are the secondary record:
backups/code-pre-v6fixes-2026-10-15/ is the last FULL pre-git snapshot (use
code-pre-v5fixes-2026-10-14/ for the 10-14 evening), and
backups/code-pre-cloudsync-fixes-2026-11-05/ holds five files just before the 11-05 sync
batch. A snapshot shows what changed; only the live code shows what is true. Never cite a
snapshot as spec, and never conclude a feature is absent because a snapshot lacks it.

HONESTY RULES (these override thoroughness)
- Every finding must cite file + line/function and describe a concrete failure
  scenario: what triggers it, what goes wrong, what the consequence is.
- Label every finding CONFIRMED (provable by reading the code) or SUSPECTED (needs
  runtime verification). For SUSPECTED, name the exact check that would confirm it;
  the Measurement List will use these.
- Do not invent findings to seem thorough. If a category is clean, write CLEAN and
  move on. A short honest report beats a long padded one.
- Where a comment states deliberate behavior, verify the code matches the comment; do
  not flag the comment. A violation of a documented non-negotiable (parameterized
  statements, one transaction per multi-statement write, append-only audit trail, no
  secrets in sync payloads) is automatically at least HIGH.
- An item marked CLOSED below is a claim to VERIFY, not a claim to trust. Re-open it as a
  finding if the code says otherwise; do not re-report it as new if the code agrees.

KNOWN DESIGN DECISIONS AND VERIFIED HARDENING (do not flag as problems; spot-check
that the implementation still matches, then move on)
- Printing: counter slips (sale, credit settlement, test receipt) are laid out and
  ESC/POS-encoded server-side in src/printer.js and written straight to the Windows
  queue picked in Settings, no print dialog. The cash drawer kick IS sent and is ON by
  default, UNCHANGED since v5: DRAWER_KICK at src/printer.js:90, pushed at :94 inside
  encode(lines, { drawerKick }) :92, and src/server.js:971 still defaults it true for
  the sale, settlement and test jobs unless body.drawer_kick overrides - so a send the
  queue later refuses can still have opened the drawer. The paper cut is still never
  sent: encode emits only ESC @, ESC a, GS !, LF and ESC d 3 (src/printer.js:93-102). A
  default-on kick is NOT a protected decision, take it to category 4 and category 9. A
  NEW slip joined the counter on 2026-10-31, the claim stub, and it is BROWSER-PATH ONLY:
  public/js/views/pos.js:1484-1516 calls renderClaimStub (public/js/receipts.js:878-928)
  then window.print(), and grep for "claim" in src/printer.js returns nothing. So a
  thermal counter gets its sale slip from the queue and its claim stub through the browser
  route; that asymmetry is the finding to test, not a protected decision. The stub does
  respect the placeholder-identity gate (pos.js:1485-1488) and escapes every field through
  escHtml (receipts.js:891-910).
  Layout is pure and byte output is isolated (sendRaw), so the suite runs with no printer
  attached: tests/helper.js seeds a dead queue name (SENTINEL_PRINTER_NAME :21, seeded at
  :44) and patches sendRaw to refuse every other name (:34-39), so no automated test can
  reach a live queue. Non-ASCII is dropped by plain() rather than risked as mojibake
  (this also strips control bytes such as ESC from user text); hold that rule against the
  updater error string named in BRAND NEW SURFACE. Receipt stamps are shop-local
  (localStamp/localDate) because the DB stores UTC. 58mm is 32 columns, 80mm is 48.
  A refused queue falls back to browser printing (@media print) so the customer still
  leaves with a receipt; the Z-report and the period summaries deliberately stay on
  the browser path. The print transport passes the queue name and payload to the
  PowerShell helper by environment variables (TP_PRINTER, base64 TP_PAYLOAD), never
  through the command line; stderr is drained with a bounded tail and the send is
  timed. The receipt modal's print button is locked for the whole send and handed
  back on every exit.
- Money: REAL columns end to end with integer-cent client math through money();
  dual-tier retail/technician pricing; FIFO utang liquidation verified exact.
- Transactions and idempotency: multi-statement writes are wrapped in one transaction
  with guarded stock UPDATEs; op_id idempotency exists on sales, returns, and credit
  settlements (client mints the key per intent; guarded ALTERs plus partial UNIQUE
  indexes; a replayed POST returns the existing record). op_log (src/db.js:392, written
  and read by src/inventory.js, pruned after 2 days) extends the same dedup to inventory
  writes: stock adjustments, CSV import rows and part creation. Since 2026-10-15 the
  bulk-edit route threads the client key through as well (src/server.js:526,
  { op_id: body?.op_id }).
- Auth: manager PIN and the 8+ char Manager Recovery Password (PIN_NAMESPACES.recovery,
  src/auth.js:88+) use PBKDF2 with 100,000 iterations and per-hash salt; legacy SHA-256
  PIN hashes upgrade on first use; verification is timing-safe; lockout counters persist in
  the database with independent 15m recovery lockout. Manager actions need elevation tokens.
  While factory PIN 1234 is live, manager elevation and POST /api/auth/recovery-password
  are refused (installed setups require setting the recovery password alongside replacing
  1234 and disable "Skip" in the UI). The phone report has its own attempt counter and
  429 lockout. PRIVATE_SETTINGS (src/settings.js:5) keeps sync_token,
  recovery_password_hash, recovery_locked_until, and recovery_failed_attempts out of
  /api/settings.
- Audit trail: append-only with a hash chain; ACTION_LABELS is re-keyed to the real
  action set. src/audit.js itself is unchanged since before v5 (hashRow, one INSERT
  carrying the predicted id and the previous hash, paged verifyChain, the row_hash
  guarded ALTER at src/db.js:299 with the backfill at :302-315). The 2026-10-14 render
  work in public/js/auth.js (the v7 path public/js/views/auth.js no longer exists) is presentation only; a layout complaint about that
  list is not a trail-integrity finding.
- Sync: one-way push-only outbox (no pull, no conflict resolution); the cloud mirror is
  keyed by (shop_id, table, local_id) for idempotent upserts; only acked rows are marked
  synced, and a 200 that acks nothing feeds the failure backoff; backoff doubles from 30s
  to a 300s cap; the outbox is pruned after 30 days even while sync is off.
  shop_settings, staff, and audit_log are whitelisted but have no enqueue call sites, so
  no secrets leave; customer_profiles sync keyed on rowid and notes never leave the shop.
  validateSyncUrl is https-only, rejects private targets, and resolves DNS at save time
  (a failed lookup saves with a warning); the SYNC_URL env override is validated at call
  time; a loopback target is carved out of the private-target refusal on purpose (the
  isLoopbackHost carve-out in src/settings.js plus the resolve() retry) so a shop can
  point at its own machine. Body caps: 10MB workstation with chunked bodies rejected
  (411), 5MB cloud. validateEvents caps at 100 events per batch, whitelisted tables,
  required fields, 100KB rows. Cloud shop auth is timing-safe per-shop tokens and the
  tenant comes from the credential, never the body (legacy shared token is opt-in).
  /sync authenticates before readBody and enforces a 120 req/min per-client budget (429).
  New since 2026-10-15: a rejected sync row no longer echoes the SQLite constraint text
  back to the workstation (cloud-deploy/server.js, the per-event rejected array), which
  closes an information leak v5 did not name.
  Protected decisions added 2026-11-05 (the cloud-sync fix batch; audit that they hold,
  do not flag them as design): backfillMirror (src/sync.js, called inside the pair-cloud
  transaction in src/server.js) enqueues existing rows at pair time, inventory and
  customer_profiles in full and the event tables (sales, sale_items, stock_movements,
  credit_payments, warranty_returns, shifts, day_reconciliations, cash_adjustments) over
  a trailing 30-day window matched to the outbox prune contract; it deliberately does NOT
  enqueue shop_settings, staff or audit_log, keeping the data-minimizing accident intact.
  The pair audit row now records backfill_rows. An empty outbox no longer short-circuits
  before the fetch: drainOutbox POSTs a heartbeat batch (events: []) whenever a sync URL
  is configured, which keeps the cloud shops.last_seen truthful (the dashboard's "shop
  online") and turns a cloud-side unlink into a 401 on the next tick; the heartbeat
  returns { synced: 0, heartbeat: true } and is exempt from the "acked none" throw. The
  topbar chip (public/js/main.js refreshSyncChip) shows "Cloud sync error" when the state
  is synced but last_error is set, so a refused credential overrides the green label.
- Cloud ops: a daily integrity-checked cloud.db backup lands in DATA_DIR/backups;
  node cloud/server.js --rotate-pin rotates the manager PIN and a restart evicts all
  manager sessions. There is a pairing route flow: POST /api/setup-pin and POST /api/pair
  with 6-digit pairing codes, and /api/pair answers the per-shop token in the
  authenticated body. POST /api/setup-pin is a first-run bootstrap only: it answers 429
  through loginBudgetExceeded (cloud/server.js:500) then 403 whenever getManagerPin() is
  truthy, before it reads the body, and tests/cloud-hardening.test.js proves a refused
  attempt leaves both the file and the working PIN untouched. The update download is
  guarded: nothing is staged until the bytes match the release's published SHA-256.
- Headers and posture: CSP, nosniff, HSTS behind the TLS proxy; TRUST_PROXY and
  TRUST_TLS_PROXY are opt-in; a plain-HTTP non-loopback bind is refused without an
  explicit ack.
- Backups and restore: snapshots run at startup and then once an hour (one per
  calendar day), each verified with PRAGMA integrity_check before it may replace the
  previous good copy; retention prunes automatic and manual snapshots older than 14
  days; scripts/mirror-backups.js copies snapshots to a second disk or share and prefers
  the resolved data dir (C:\ProgramData\TechPartsPOS for Program Files installs); the
  Reports tab warns when the newest snapshot goes stale; restore is in-process, rebinds
  the db handle, and takes a pre-restore safety snapshot; GET /api/backup/download ("Download
  copy" in Settings) shares resolveVerifiedBackup() for safe USB export.
- Lifecycle: direct/dev runs keep %LOCALAPPDATA%\TechPartsPOS\server.lock with the
  silence-driven watchdog; Program Files installs run TechPartsPOS-Server (--service,
  127.0.0.1 loopback bind, C:\ProgramData\TechPartsPOS\runtime\server.lock and server.json,
  POST /api/system/shutdown returns 400); desktop shortcut calls runInstalledLauncher() to
  open or restart the background service; SIGINT, SIGBREAK, and SIGTERM are handled; crash
  handlers write pos-crash.log.
- Payments: GCash and transfer sales require a payment_reference; collections above a
  shop-set amount need manager authorization; the day close reconciles the drawer per
  payment method; shift_variance_threshold is now a real Settings field with a reader
  (public/js/auth.js:450, :701-724, consumed by src/settings.js:47).
- RMA: warranty claims are checked against the shop's window and the exact purchased
  line; a replacement is the same part unless a manager authorizes a like-for-like swap;
  every decision is audited; deleting a sold part answers 409 with an archive hint;
  voiding after a credit refund names the RMA. Multi-unit claims (src/returns.js): the
  quantity parameter is floored at 1 (:22, :67), the cap is alreadyReturned plus
  quantity against the line quantity (:75-76), a replacement needs stock_quantity at
  least quantity (:104-105), labor lines cannot be replaced, refund ceilings scale by
  quantity, notes cap at 500. Both the return and the settlement path enqueue the parent
  sale row (src/returns.js:132 and :151) so a return reaches the cloud mirror.
- Frontend: escHtml on every interpolation (verified zero XSS on 2026-09-27); toasts sit
  top-right; the dashboard supports a custom range (period=custom&from). showToast
  escapes (public/js/ui.js:7-9, interpolation at :72, both intact), so a toast that
  echoes raw scanner text is not an injection vector.
- Barcode scanning (public/js/views/pos.js, 1630 lines; documented as live behavior
  in docs/OPERATIONS_AND_DEPLOYMENT.md section 2.5 item 4): a USB HID keyboard-wedge
  burst on the POS tab is read as a part code wherever the caret sits. The gates are
  deliberate and must not be re-tuned as bugs: SCAN_BURST_MS 100 (pos.js:178),
  SCAN_FIELD_MIN 6, POS tab only, suppressed while a modal OR a gate is open
  (.gate:not(.hidden)), SCAN_TEXT_FIELDS (:187: repair-device-input, repair-imei,
  repair-note, pos-tendered, pos-discount) because a phone carton carries the device IMEI
  as a barcode and a money box never means a part code. Characters hijacked from a field
  are put back to what the field held. Lookup is strict exact match on sku_barcode,
  case-insensitive, against the catalog copy the tab already holds (:234-236); unknown,
  out-of-stock and over-quantity codes buzz and are refused, and the old "Enter adds the
  top match" fallback is gone for a detected burst by decision, not by accident. The
  2026-10-15 rework is part of the protected list now: Enter settles through
  scheduleScan/pendingScan because a CR can land mid-payload, slow typing clears a
  pending scan, and a paste voids burstStart so pasted text survives a burst. Beep and
  buzz are synthesized Web Audio, no assets and no feature flag; a suspended AudioContext
  is now warned about once instead of failing silently (scanAudioWarned pos.js:186,
  the resume catch :194-200). A new repair leaves the caret in the parts search so a
  trigger pull works immediately. The data side: sku_barcode is COLLATE NOCASE UNIQUE
  (src/db.js:85) and a migration uppercases and trims every value (:341-363), renames a
  case-insensitive collision to ${sku}-${id} with an [init] renamed log line rather than
  aborting startup, and adds the partial nocase unique index; a duplicate on write
  answers 409 (isSkuDupError src/server.js:194, raised at :505 and :577); CSV import maps
  sku, barcode, upc, ean and similar aliases and refuses a scientific-notation-mangled
  code (public/js/importer.js, 154 lines).
- Interface language: public/js/i18n.js (1001 lines) holds an en and a tl table, getLang,
  t(key, fallback), applyLanguage(lang) rewriting [data-i18n] textContent and
  [data-i18n-ph] placeholders, and toggleLanguage wired at data-action toggle-lang. Every call site still passes a literal key and a literal English
  fallback, and there is no locale key in the server settings whitelist. A string that
  survives untranslated in tl mode is a finding; a language that differs per seat is not.
- Workstation typography: four presets (workstation, humanist, grotesk, editorial)
  validated against a whitelist (public/js/theme.js:23), default workstation, stored in
  localStorage techparts_appearance, applied as html[data-font-style] with a whitelist
  fallback and four style blocks in public/styles.css:175-201 (still :175-201 on
  2026-11-02). The :root default is the sans stack and Newsreader appears only under
  editorial; --font-numeric is untouched on purpose. theme.js is byte-identical to the
  2026-10-15 snapshot.
- Audit log presentation (public/js/auth.js; the v7 views/auth.js path is gone): date-grouped rows, a middot day
  separator, a dash placeholder cell for entries with no detail, an entry count foot-note,
  an empty state, hover isolation in styles.css. Presentation only; the trail it renders
  is unchanged. ACTION_LABELS now carries 'system update_apply' (public/js/auth.js:1428),
  which v5 listed as a gap.
- License continuity: the 2026-10-14 public-key rotation no longer 402-locks existing
  seats. src/license.js keeps the pre-rotation key as VENDOR_PUBLIC_KEY_PREVIOUS_B64
  (:16, rationale :12-15), vendorVerifyKeyB64s() (:22-28) returns current-then-previous
  and matchVendorKey (:149-160) tries each. Both are verify-only SPKI, so no signing
  power was added; :15 documents the condition for dropping the old key. This closes the
  v5 KNOWN OPEN item about sold seats stopping validating on update. The rest of the
  license surface (machine id, trial seal, anti-rollback) is NEW and unaudited, see below.

GATES (recount and rerun at audit time; report the current numbers)
- npm test (node --test tests/*.test.js). Measured 2026-11-13 at b55f517: 642 tests across
  52 tracked files; 642/642 on a parallel run, about 30 s (tests/ui-fixes.test.js
  normalizes CRLF line endings inside source()). The 11-05 history stands: one parallel run that
  day produced no output for over ten minutes and was killed; the immediate rerun was
  green, so a HANG is also a rerun, not a regression. The v6
  reserve-then-release flake was moved to PORT: '0' in
  tests/cloud-hardening-harness.js (`reservePort` remains at :14 only for the blank
  MANAGER_PIN early-exit spawn in tests/cloud-hardening.test.js:472); re-verify if new
  spawns call `reservePort`. Do not report a red suite as a code regression without
  rerunning and then separating the flake from a real defect, and do report the flake
  itself: a gate that goes red on a green tree trains the shop to ignore red. If the
  suite cannot run at all, stop and report instead of proceeding.
- The suite is scratch-env by construction: tests/helper.js points every test database at
  temp directories and enforces the sentinel printer queue (see the Printing bullet), so
  tests cannot corrupt a real cache or database and cannot print paper. Verify rather
  than trust: no test may hand-roll createServer(). Two files still call it
  (tests/cloud-hardening.test.js, which spawns a whole separate cloud process with its own
  temp DATA_DIR, and tests/remediation-final.test.js). Check whether the latter still
  resolves RUNTIME_DB_PATH to the real data/shop.db (src/server.js:211 area) with sendRaw
  unpatched, which is the exact exception v5 recorded as closed for the updater route test.
  tests/updater-ui.test.js imports nothing from helper.js at all; find out what it
  touches instead of assuming it touches nothing.
- npm test is the only automated gate. There is no compile step in dev. If you change UI
  styles, npm run build:css regenerates public/tailwind.build.css.
- The exe pipeline (npm run build:exe, and the newer npm run build:installer) is
  packaging, not a gate; do not run it in an audit. npm run verify:exe is a read-only
  artifact check and is allowed; npm run test:verifier runs its own suite.
- There is no browser automation in this environment: any visual finding is verified by
  code inspection and layout math, and the report says so instead of claiming a
  click-through.

KNOWN OPEN (report status only; do not re-derive as new discoveries)
STILL OPEN:
- Multi-shop SSE broadcast scope: unchanged and still open. sseClients is an untagged Set
  and broadcast() iterates every client with no shop filter (cloud/server.js:194-200,
  byte-identical to the version v5 cited at :135-140); payloads do carry shop_id
  (:420, :495); /events still stores the response with no shop tag; the manager app still
  refetches on any change event regardless of shop.
- Console exposure of cloud secrets: STILL OPEN, relocated not removed. v5 recorded the
  boot-time first mint as silent and three prints as surviving. Today they are at
  cloud/server.js:108 (the token, `${label}: ${token}`), :124 (the per-shop sync token),
  and :165 (the --rotate-pin manager PIN). A systemd journal or a tmux pane on the VPS
  holds a credential.
- Cloud analytics versus the workstation: the class of drift CHANGED.
  Through 2026-10-14 the cloud read json_extract over row_json blobs with fields the
  workstation no longer emitted. The 2026-11-02 alignment batch instead made the cloud
  compute the same numbers the workstation does: RMA replacement cost, proportional
  discount allocation, cash_adjustments, collected_total, generated_at
  (cloud/server.js:643-800), plus a debtor_list on /api/summary (:579-619).
  tests/analytics-parity.test.js now verifies top_products, standing, reorder/dead
  stock, period analytics, and fractional quantities against one dataset; still check for
  newly added fields (for example wholesale tiers or multi-industry items) drifting
  between the two implementations.
- The self-update path has still never been exercised for real, and the surface it must
  cover grew to 728 lines with a resume, a sidecar, a rename-aside, a rollback
  branch, and the --service schtasks restart branch. tests/updater.test.js now includes
  serviceMode handoff/staging tests using a test-seam hook
  (setUpdateTestHooks / updateFetch, src/updater.js), so more of the module runs
  under test than v5 claimed; the real cmd.exe handoff is still unreachable. Nobody has
  run the replace-and-restart on a machine holding TechPartsPOS.exe with a sale in
  progress. Treat the whole apply path as unproven until it is.
- Releases published before the checksum rule carry no TechPartsPOS.exe.sha256 asset and
  the updater fails closed without one. v2.5 and v2.6 shipped with every asset live;
  CHECK WHICH OLDER TAGS (v1.x through v2.4) ACTUALLY CARRY THE ASSET before telling a
  shop on one of them to press Update Now, and check what such a seat sees when the
  release it wants has no digest. Do not assume the newest tag is safe, and do not
  assume the old ones are unreachable from the client.
- Source control: RESOLVED 2026-11-07 (6834474 tracks the full tree, package.json and
  .gitignore included). Verify the remote is current at audit time (git status, and
  compare local main against origin) and move on.
- Barcode scanning has never been proven against a physical reader. The suite replays
  keydowns inside a node:vm context, which proves the classification logic and proves
  nothing about a real scanner's keystroke interval, its suffix key, or whether an IMEI
  barcode lands cleanly in the IMEI box. The 2026-10-15 Enter-settle rework makes this
  MORE important, not less: a CR arriving mid-payload is now handled by a pending-scan
  timer, and no vm test can measure a real wedge's timing. Missing evidence is a handful
  of real scans at the counter; ask for them instead of treating the feature as verified.
  Same standing rule as the printed slip: browser evidence is self-consistency, not proof.
- Release pipeline idempotency: REWRITTEN 2026-11-08 (640 lines now, installer-only) with idempotent version
  derivation, a whole-tree release commit and a zero-mutation DryRun mode, which answers
  the v7 hazard (reruns bumping the version into gitignored files, tag pushed before the
  assets upload). That is the rewrite's claim, not a verified fact: run the DryRun on a
  scratch copy or read Get-NextVersion and the commit set and prove a rerun is a no-op.
  Standing rule: list releases through Get-GithubReleases, because PowerShell 5.1
  transposes the /releases listing on this box.
- Docs completeness, reported ONCE per v5's own rule and now much smaller: the three
  claims in v5 are FIXED (ARCHITECTURE.md:56-75 lists all 19 src modules including
  updater, printer, settings, sync, shifts, reconcile, audit, money, names; README.md:15
  now states that an update installs only after its published SHA-256 matches and is
  refused while the factory PIN is live; API_REFERENCE.md grew from about 30 to 35
  documented method+path pairs). What remains is one finding, not ten: API_REFERENCE.md
  still under-documents the routed surface (roughly 28 unique documented paths against
  about 43 literal routes plus 8 dynamic matchers in src/server.js) and carries no
  completeness disclaimer. The new /api/system/update/progress route is a live example of
  an endpoint with no doc entry.
CLEARED SINCE v5, VERIFY AND MOVE ON (each was a v5 open item; do not re-report as new):
- License rotation stranding sold seats: fixed by the previous-key fallback above.
- tests/ t_*.db litter (v5 counted 81 files, about 50 from one restore-test defect): zero
  such files on disk today.
- installer/TechPartsPOS.iss drifting from package.json (v5: .iss said 1.0.0 and the .ps1
  never rewrote it): .iss says 2.1 (:19) and publish-release.ps1 rewrites it at :356-360,
  along with package.json, CURRENT_VERSION in src/updater.js, package-lock.json,
  README.md and RELEASE_NOTES.md (:341-379).
- The PAT written to %TEMP%\git_cred_out.txt outside a finally: now inside a finally
  (:471-487).
- src/updater.js "has not one console.log": false now, see BRAND NEW SURFACE.
- htmlUrl "settable by anyone who can name a GitHub URL": isTrustedPageUrl (:57) now
  pins the hostname to github.com AND requires this repo's path (:62-63).
- The duplicate 'reload-returns' key in the main.js action map: gone, one entry at :299.
- The cloud manager app accepting the default PIN 1234 when none is set: the hardcoded
  grant is removed; /api/login 403s with a pointer to --rotate-pin when no PIN exists
  (cloud/server.js:507-513), and a blank MANAGER_PIN now fails the boot (:24-29). The
  follow-up question is new, not this item: the operator must now set the PIN out of band
  on the server, so check whether cloud/public/app.js can strand a first-run operator on a
  form that can never succeed (it opens the setup screen only while pin_set is false).
- pos-server.log at the root (v5: 525KB): 576KB and NOT growing, because nothing has been
  run from the repo root since 2026-10-14 20:51. The no-rotation finding stands; the size
  figure does not.

BRAND NEW SURFACE, FIRST LOOK (including the 2026-11-11/12 Universal POS, Inno Setup 7
SYSTEM service, PIN Recovery & USB backup merges, plus earlier unaudited post-v5 changes)
- SYSTEM service, Program Files redirect, PIN Recovery & USB Backup Download (783023a..533f07a):
  - installer/TechPartsPOS.iss & scripts/build-installer.js: Inno Setup 7 script creating
    scheduled task TechPartsPOS-Server running TechPartsPOS.exe --service as NT AUTHORITY\SYSTEM,
    setting icacls ACLs locking C:\ProgramData\TechPartsPOS (with runtime\ readable so the
    Standard Cashier shortcut can read runtime/server.json), and deleting temporary XML only
    in CurStep = ssDone after [Run]. Audit privilege separation, Windows Admin ownership
    boundary (documented Non-Goal), upgrade/uninstall task cleanup, and service startup latency.
  - src/db.js (isProgramFilesPath, resolveBaseDir) & src/server.js (resolveLaunchMode,
    runInstalledLauncher): check runtime/server.json race/stale-port handling when launcher
    re-triggers schtasks /Run, loopback 127.0.0.1 bind in --service mode, and POST
    /api/system/shutdown returning 400 in service mode while UI shows "Close POS".
  - src/auth.js (PIN_NAMESPACES.recovery, setRecoveryPassword, recoverManagerPin) &
    src/settings.js (PRIVATE_SETTINGS): check /api/auth/recovery-status and /api/auth/recover-pin
    on licenseExempt + sessionExempt lists (src/server.js:455-488), POST /api/auth/recovery-password
    guard (session?.type !== 'staff' && elevated && !isDefaultPin), independent 15m lockout,
    and setup order when replacing factory PIN 1234.
  - GET /api/backup/download (resolveVerifiedBackup(backupDir, rawFile, 'downloaded')): check
    elevation/session gates, traversal blocking, and integrity refusal messaging.
  - Universal POS & Store Profiles (113ebc2): store_profile filtering, allow_fractional
    quantities across sales/returns/adjustments/CSV/reorder/cloud, wholesale tier pricing,
    and expanded EN/TL i18n keys.
- Updater rewrite, 269 to 728 lines. The trust model: isTrustedReleaseUrl (:46-50) is
  still a string prefix test, and the real enforcement is RELEASE_ASSET_RE (:74-77) plus
  resolveTrustedReleaseUrl (:88-99), which collapses WHATWG dot segments and rejects
  percent-escapes, userinfo, port, search and hash - the docblock at :79-87 names the
  exact bypass it kills (a prefix-valid ../../attacker/x.exe URL that resolves to a
  different repo). Digest handling moved into fetchPublishedDigest (:126-147) and
  digestMatches keeps the anchored 64-hex plus timingSafeEqual rule; the digest is now
  re-checked on a REUSED staged file (:541) and enforced on a fresh download (:570) before
  the staging write (:575). New behaviour to audit as a whole: a resume-capable download
  (downloadReleaseWithResume :177-283) with a 45s per-chunk stall timer, Range requests,
  5 attempts and .part / .part.json sidecars; staged-exe reuse gated on a
  TechPartsPOS_update resume marker (:527, :533-551, :581); a version-downgrade refusal
  (:496-499) with the release tag now parsed straight out of the URL path (:490-493); a
  rewritten handoff script (buildApplyScript :386-420) that dropped tasklist, findstr,
  timeout and powershell Unblock-File for cmd builtins, busy-polls an <exe>.old reap
  (:397-404) and carries a :restore rollback branch (:410-416); an exe rename-aside before
  the spawn (:595-602) with the spawn failure reverting it (:611); the spawn itself
  (:604-609); and a progress state object (:154-173, getUpdateProgress exported :641).
  Logging exists: updateLog at :293 prints [update] lines from roughly 20 call sites, so
  the v5 claim of total silence is obsolete - now check what those lines LEAK into
  pos-server.log. No code signing and no authorship check anywhere: only a SHA-256 fetched
  from the same release as the exe, which is integrity and not provenance. TWO CONCRETE
  DEFECTS TO CONFIRM OR EXPLAIN, both already visible: the download-interrupted message at
  :282 contains double-encoded mojibake where an em dash was intended, and it reaches the
  cashier through textContent in the Settings panel and the handoff screen, which is the
  plain() rule the Printing bullet holds for printer text applied to UI text; and :125
  cross-references "the no-signing note above", a comment that does not exist in the file.
- A NEW UNAUTHENTICATED ROUTE. GET /api/system/update/progress (src/server.js:1376-1378)
  sits on BOTH exempt lists: sessionExempt (:426-432) and licenseExempt (:406-414). Along
  with GET /check (:1368) that is three update routes reachable with no session, and
  POST /apply (:1380) is the only one that needs a session plus elevation, refuses the
  factory PIN, audits system update_apply and exits about 300 ms after a success response.
  Name what an unauthenticated LAN peer can learn from /progress (phase, percent, MB,
  retry count) and whether driving it can perturb the state machine or the applyInFlight
  latch (src/updater.js:152).
- Update UX rewrite (public/js/views/backoffice.js:1717-2075, the file is now 2075 lines).
  v5's "the UI shows no progress for up to 15 minutes" is obsolete: setApplyLoading polls
  /progress every 400 ms (:1787-1793) and renderUpdateProgressState (:1723-1760) shows
  phase, percent, MB and retry #N in the button, chip, banner and status line; the handoff
  screens carry a live elapsed clock (:1982, :2008) and a stalled state with keep-waiting,
  open-the-release-page and retry guidance (:2046-2075). checkError still renders amber
  (:1868-1874), htmlUrl still lands in hrefs (:1884, :1894) and window.open (:1966) - and
  :1966 opens WITHOUT noopener while :2066 uses it, so the two screens disagree. Three
  document.body.innerHTML writes exist in this block (:1974, :2018, :2048); v5's "every
  write is textContent" is only true of the VALUES: all three are static markup with no
  remote interpolation, which is the claim to test, not the sentence to repeat.
- License surface beyond the key fallback. getActiveMachineId (:69-96) with a persisted
  workstation_machine_id, an HMAC trial-tamper seal (:168-224, TRIAL_SEAL_SALT :171), and
  a rewritten licenseNow anti-rollback (:246-266) whose own comment admits the previous
  legs were dead code. Judge the seal and the rollback clock against a shop PC with a
  wrong or drifting system time, and against a user who edits the persisted machine id:
  the trial seal is app security, so a bypass is HIGH by this brief's own rubric.
- Release pipeline rewritten to 640 lines (scripts/publish-release.ps1, installer-only, root
  publish-release.bat new on 2026-11-02 while the older publish.bat from 2026-10-01 is
  still on disk). Version base is max(tag, package.json) (:18-58) with Get-NextVersion
  (:59) and an interactive prompt (:93-96); version sites rewritten at :341-379; the
  commit set is README.md, RELEASE_NOTES.md and .gitignore only (:388-407, which is why
  the version rewrites land nowhere); the checksum asset is written at :458-460; the token
  path is at :471-487; a guard at :542-570 tries not to leave a tag pointing at a partial
  release. Audit the ORDER, because it is where the money is: npm test and build:exe run
  after the version commit, the tag is force-pushed, and the upload comes last, so a
  failure between the push and the asset upload is the shop-facing outage.
- Realtime monitoring alignment (2026-11-01 design doc, executed 2026-11-02; the plan
  names src/server.js and cloud/server.js:651-776 as its parity targets). Cloud:
  SHOP_TZ_OFFSET_MINUTES and a TZ_MODIFIER (:31-40, :96-99), namefold debtor folding
  (:79-93), /api/summary debtor_list (:579-619), analytics parity (:643-800), the new
  pairing-code-mints-existing-shop 409 (:460-469), an attempt budget on /api/pair
  (pairBudgetExceeded :454), and idle eviction for PIN attempt entries (:186-189,
  PIN_ATTEMPT_IDLE_MS :233). Workstation: public/js/report.js (270 to 326 lines) gained a
  persisted theme and a freshness model - STALE_MAX_MS 300000, lastOkAt, setFreshness()
  driving a Live / Stale / Offline pill and the offline banner, recolor through
  style.color and text through textContent; report.html grew 370 to 413; report-sw.js is
  unchanged at 7 lines; cloud/public/app.js and index.html gained the same freshness and
  theme treatment. The question is agreement, not appearance: three surfaces now compute
  "is this number current" and "what is net profit" on their own.
- Counter ergonomics batch (2026-10-31, in public/js/views/pos.js): an inline cart
  quantity editor (editCartQtyPrompt :1019-1051 plus the sumline qty button :1075), the
  shift-open prompt moved off window.prompt() onto inputModal (:1421-1428, with
  ui.js:484-499 gaining defaultValue and input.select()), and a printable claim stub
  (:1484-1516, ALT+P on the POS tab via main.js:689-693 inside the altKey-only branch
  opened at :624, the browser render in public/js/receipts.js:878-928, the index.html
  button :454). Two things need judging
  here: the quantity editor is a money and stock path that did not exist in v5's protected
  list, and the claim stub is a NEW print surface with NO ESC/POS encoder at all, so its
  fidelity at real paper widths is untested by anything.
- Kiosk lockdown drift (public/js/main.js, block :503 to :704): F3 is no longer hijacked
  for in-page find (only Ctrl+F routes to the palette, :539-544, with a comment calling
  the old rail binding dead code) and ALT+P on the POS tab now prints a claim stub
  (:689-693). F12 (:517-520), F5 and Ctrl+R (:523) and F11 (:569) still fall. v5's "Ctrl+P
  is blocked and is the only route to the browser print fallback" needs re-checking
  against the claim-stub binding that now occupies that key on the busiest tab.

- THE PARALLEL SESSION'S BATCHES, 2026-11-03 through 2026-11-05 (all unaudited by v6 and
  first-look here; the mtime ladder is the only inventory because there is no git): src/
  side, updater.js (+2 lines since v6), inventory.js (453 to 490); public/ side,
  views/pos.js (1516 to 1532), views/inventory.js (to 1094), views/backoffice.js (2075 to
  2162), auth.js (1840 to 1930), theme.js (164 SHRUNK to 129), report.js (326), importer.js
  (154), i18n.js (416), index.html (2291 to 2343), report.html (413 to 476); cloud side,
  cloud-deploy/server.js (951 to 1191, a 240-line growth v6 never saw) and
  cloud-deploy/public/app.js (1084); tests side, template-chooser and changelog are new
  files and six more were rewritten. The brief's protected list above was written against
  the 11-02 tree, so EVERY line-number citation in it is suspect where these files are
  named; resolve symbols, do not trust coordinates. Audit the DELTAS as new surface: what
  does theme.js losing 35 lines mean (a preset dropped? validation weakened?), what are
  the 240 new cloud lines (routes? budgets? another posture change?), and did the
  backoffice/pos/auth growth import any new print, money or elevation path. The
  reversion incidents of 2026-11-05 (header item f) happened while this session was live;
  treat concurrent-edit hazards as an operations finding, not a code bug.
- The 2026-11-05 cloud-sync fix batch (first look at the auditor's own fresh code, which
  is exactly why it needs an adversarial pass): backfillMirror's 30-day window uses
  datetime(created_at) comparisons against datetime('now','-30 days') inside SQL, so a
  shop whose clock is wrong backfills the wrong month; the window deliberately excludes
  older paid sales (they are outside every dashboard window) but customer_profiles and
  inventory go in full, so a pre-window sale with an open credit balance would surface an
  utang whose parent sale row is missing on the cloud (judge /api/standing against that
  shape); re-pairing after a cloud-side unlink re-enqueues everything and relies on the
  (shop_id, table, local_id) upsert for idempotency; a second pair under a different
  cloud URL re-points the mirror wholesale while the old shop_id's rows stay on the old
  VPS; the heartbeat fires on every debounced drain (write actions plus the 60s tick), so
  measure worst-case heartbeat frequency against the cloud's 120/min budget when the
  outbox is empty AND when it is draining a backfill; and the heartbeat runs even while
  a backfill is mid-flight (verify the two POST paths cannot interleave badly inside
  syncInFlight). The chip's "Cloud sync error" reads last_error, which the server clears
  on the next successful drain: verify a TRANSIENT failure (VPS restart, one 401 from a
  redeploy) does not flap the label in a way a cashier learns to ignore, and that a
  stale chip (fetch of /api/sync/status fails, catch keeps the last state) cannot show
  green across a reconnect.

AUDIT CATEGORIES (cover all ten; report per category)

1. CORRECTNESS / BUGS
   Logic errors, inverted conditions, off-by-one, wrong operators. Null handling,
   uninitialized values, edge cases (empty input, zero, max lengths, special
   characters in names, notes, item and intake text). Swallowed or empty catch blocks,
   and callers of Boolean helpers that ignore the False result. Date/time bugs: UTC
   storage versus shop-local day boundaries (the Z-report, warranty expiry, and day
   close all depend on it); printer.js has localStamp/localDate for receipt stamps, so
   verify every render path uses them and nothing prints a toISOString slice. toFixed
   rounding paths. printer.js internals: colsFor() silently maps an unrecognized width to
   48 columns (the settings whitelist is the only guard), wrap() word-aware splitting,
   nameLines() fallback, calculateWarrantyExpiry, and the parsing of PowerShell output
   (parsePrinters, parseSendResult, parsePrinterLookup, defaultPrinter). What happens on
   every failure path.
   New surface, audit these: the mojibake string at src/updater.js:282 and any sibling
   message built the same way; the dangling "no-signing note above" reference at :125; the
   tag parsed out of the URL path (:490-493) versus CURRENT_VERSION (:10) in the
   downgrade check (:496-499), where an off-by-one or a v-prefix mismatch either blocks a
   legitimate update or permits a stale one; the .part.json sidecar and whether a
   resumed download trusts the byte count recorded in it (a wrong offset yields a corrupt
   exe that then has to be caught by the digest re-check at :541); getUpdateProgress
   state transitions, whether a retry resets percent, and whether the 400 ms client poll
   can read a state from a previous attempt; the new /progress route's view of applyInFlight.
   Money and ledger: the inline cart quantity editor (pos.js:1019-1051) against the cart
   total, the dual-tier price and the stock ceiling, including a non-integer, a zero and
   a negative entry; the claim stub's totals and its warranty block. Time and locale: the
   cloud SHOP_TZ_OFFSET_MINUTES modifier (cloud/server.js:31-40, :96-99) against the
   workstation's shop-local day boundaries, a fixed offset across a DST change, and a
   half-hour zone such as Asia/Manila versus a shop that travels; namefold (:79-93)
   folding two different debtors into one bucket, or failing to fold the same debtor.
   Analytics parity: the RMA replacement-cost and proportional-discount allocation
   arithmetic in cloud/server.js:643-800 versus the same formula in src/analytics.js,
   where a rounding difference is a real disagreement on the manager's phone.
   Carried forward from v5, still to verify: the scan burst classifier's post-10-15 shape
   (can a fast human be misread as a scan now that Enter settles through pendingScan, is a
   hijacked burst really restored, does a 13-digit EAN with a leading zero survive as text,
   can one code resolve to two parts after a migration renamed a collision to
   ${sku}-${id}, and is the renamed code then findable by a cashier holding the printed
   label); onPartSearchKeydown, where a typed search and a scan share one box and one
   Enter handler and the element listener runs before the window one; the multi-unit RMA
   caps in src/returns.js; total_spent_paid, which subtracts cash refunds and floors at
   zero (src/credits.js:35, :73, :140), so any doc or report still describing it as money
   paid is stale; the void-after-close drawer gate rewritten from a same-day test to
   counted (src/sales.js:262, :267), where counted means closed and the sale instant is at
   or before closed.signed_at; capped() truncation of labor name, phone and
   payment_reference (src/sales.js:15-17, :72, :126); the default markup and variance
   helpers and their 50 and 20 defaults (src/settings.js:24-47); the audit-log render path
   in public/js/auth.js (the v7 path public/js/views/auth.js no longer exists).

2. CONCURRENCY & DATA INTEGRITY
   The DB is synchronous and single-process, so classic DB-thread races are rare: the
   real risks here are (a) multi-statement writes NOT wrapped in one transaction: sales,
   returns, and settlements are verified wrapped and op_id-deduped; audit the REMAINING
   paths (day close, reconcile, stock adjustments, shifts, staff edits, settings saves):
   what state a crash leaves between statements, (b) double-submit: double-click, retry,
   or a reprint creating a second sale, payment, or slip (the receipt modal print button
   is verified locked for the whole send; verify the others, now including the cart
   quantity editor and the claim-stub button), (c) read-modify-write across HTTP round
   trips (stock check then sell, credit balance check then settle), (d) idempotency of
   every POST, (e) FK, UNIQUE and CHECK constraints actually declared so bad data cannot
   get in, (f) the in-process restore window: requests in flight during a restore, the db
   handle rebind, and the pre-restore safety snapshot, (g) the auto-print path: the tab
   fires POST /api/print after a sale when auto-print is on, so a retry or a lost response
   can double-print, and the print audit write happens after delivery.
   Added since v5, audit these too: (h) the op_log dedup across every bulk-edit row,
   adjustment, import row and part creation, and what a bulk edit that fails on row 7 of
   20 leaves behind (POST /api/inventory/bulk-edit, src/server.js:522, key threaded at
   :526); (i) the multi-unit RMA, two claims racing the same line for the last units of
   stock, and whether the replacement debit, the refund and the return row land in one
   transaction; (j) the cloud pairing flow, a pairing code redeemed twice, a code redeemed
   after expiry, a token issued whose response the workstation lost, and the new
   pairing-code-mints-existing-shop 409 (cloud/server.js:460-469) - does the rejection
   happen before or after any state mutation; (k) THE UPDATE WINDOW, which is now the
   largest multi-step non-transactional sequence in the product: the rename-aside of the
   running exe (:595-602), the detached cmd.exe, the :reap busy-poll on <exe>.old
   (:397-404), the :restore branch (:410-416), and the 300 ms exit after a success
   response (src/server.js:1380 area). Two update attempts must not interleave; check the
   applyInFlight latch (:152) against a second POST and against a /progress poll that
   arrives between the response and the exit. (l) the staged sidecars: a
   .part / .part.json pair left by a killed download, then reused by a next attempt whose
   release asset changed underneath it.

3. PERFORMANCE & BOTTLENECKS (judged against the stated scale ONLY)
   Full-table loads where a filtered query or LIMIT would do, missing indexes for the
   queries actually run, repeated computation per request, work inside loops that could
   be one prepared statement, unbounded client state, the PowerShell spawn per slip, the
   outbox growing while sync is off, pos-server.log growth. At 20-100 sales/day most of
   this is fine; say so when it is.
   Worth measuring instead of assuming. The boot update check performs an outbound fetch
   to api.github.com on every start (src/updater.js:306) on a LAN that may have no route;
   name the abort cost at the counter and whether the failure is distinguishable from up
   to date (it is, but only in amber text at backoffice.js:1868-1874, and the boot call
   passes silent=true at main.js:847). A 400 ms poll against /progress for the whole of a
   multi-minute download: count the requests and say whether that is free on this box.
   publish/ at 2.2GB and 51 entries, which any mirror or backup script will happily copy,
   plus live runtime state (pos-server.log, data/, backups/, browser-profile/) sitting
   inside dist/. pos-server.log at the root: 576KB, no rotation; name which line dominates
   it (the heartbeat posting every 5s, per-request logging, the hourly backup tick, or the
   new [update] lines from :293) and how long a shop has before the disk matters. State
   which of these a 20-100 sale/day shop will never notice.

4. SECURITY
   XSS: every template literal in public/js interpolates into innerHTML; escHtml is the
   only defense. Verify EVERY interpolation of user- or customer-controlled data (names,
   phones, notes, item names, unit/intake text, settings values) in the POS, backoffice,
   receipts, report.html, and the cloud manager app. The session token lives in
   sessionStorage: trace the XSS-to-session-theft path. Auth/authz: does every sensitive
   route check the session AND elevation where required, with expiry enforced
   server-side? Is the factory-PIN elevation gate honored on every manager path, not just
   the menu? report.html token strength, rotation, and lockout. Secrets in the repo or
   logs (sync tokens, PIN hashes, the vendor pem; dist/ never ships: verify the release
   verifier still enforces it - scripts/verify-exe.js checks BOTH TechPartsPOS.exe and
   LicenseGenerator.exe in dist/ at :189-192, and release-customer.js decides what
   actually lands in release/customer/, so audit that boundary, not the verifier's list).
   Path traversal in any file serving (backups, QR path handling). Audit log: append-only
   in practice, hash chain intact? Fail-open versus fail-closed when a security check
   itself errors.
   Print surface: queue name and payload travel by environment variables to the
   PowerShell helper; verify no spawn path embeds external strings into a command line,
   that printer_name passes the settings whitelist, and that no renderer path bypasses
   plain() into raw slip bytes. The claim stub is browser-only, so its exposure is the
   other direction: it builds printable.innerHTML from intake text (receipts.js:896),
   verify nothing in that interpolation escapes escHtml. Cloud: verify auth-before-readBody and the 120 req/min budget
   on every route that needs it, not just /sync, and that nothing new leaks into logs
   (the three surviving prints in cloud/server.js are listed as STILL OPEN above; check
   for a fourth).
   i18n: t() output and the data-i18n rewrite path must never receive HTML; verify no call
   site can route user text through a key or a fallback, and that a translation cannot
   smuggle markup into textContent. The 11-01 batch added 27 mirrored hint keys, so re-sweep.
   Scanner: raw scanned bytes reach a toast, the cart, the claim stub and the receipt;
   showToast escapes, verify the other consumers. Machine-local localStorage preferences
   as a tamper surface (pos_lang and techparts_appearance must never gate money, stock,
   elevation or printing); add the new report PWA theme key to that check.
   Cloud bootstrap, where the shape changed: POST /api/setup-pin is budgeted and 403s once
   a PIN exists, and /api/login no longer grants a session on the hardcoded 1234. Your job
   is to break what is left. Try a MANAGER_PIN of whitespace only (the boot now fails at
   cloud/server.js:24-29 - confirm that is a refusal and not a fallback). Ask what
   pairBudgetExceeded (:454) actually bounds: a 6-digit code is 10^6 space, the code lives
   600 s, the 60 s cleaner bounds how many are alive at once, and a budget that resets per
   key still permits a distributed crawl - so measure guesses-per-code and
   codes-per-lifetime, not just the counter. Confirm a token returned by /api/pair never
   reaches a log. On the workstation, POST /api/settings/pair-cloud (src/server.js:843)
   requires elevation, refuses the factory PIN, runs validateSyncUrl on the submitted
   target and now aborts at 15 s (:872) - confirm no path skips any of the three, and note
   the 2026-10-31 change that the cloud identity sent is getShopId(db) rather than
   owner_name (:854-866): verify a shop cannot pair as a different tenant, and that an
   operator who renamed the shop does not silently re-point at another one.
   Self-update is still the largest attack surface here. The trust model, restated against
   today's code: it trusts whatever api.github.com releases/latest returns; the download
   URL must clear the RELEASE_ASSET_RE name pattern (TechPartsPOS.exe) and the
   dot-segment-hardened resolver (:88-99); nothing stages until the bytes hash to the
   SHA-256 fetched from the same release (digest re-check :541, enforcement :570); the
   published byte length is still compared as a sanity check and skipped when the caller
   sends 0; there is still no signature, so authorship is unprotected and anyone with
   upload rights on the repo can replace the exe and its checksum together. Attack the
   gates specifically: can the digest URL be steered anywhere the exe URL could not go,
   what does a redirect on the asset or digest endpoint follow, does a digest asset that
   exists but is empty or padded still parse, and does the digest fetch timeout fail
   closed (it must; "nothing was installed" is the only acceptable answer). Then the
   resume path, which is new and has no threat model: a .part file and its .part.json are
   both on disk in the staging dir (C:\ProgramData\TechPartsPOS\updates in --service mode
   or %LOCALAPPDATA% otherwise), the offset comes from the sidecar and the resume
   decision from a marker file, so say what an attacker with write access to that one
   directory gains, and whether the digest re-check at :541 covers every reuse branch.
   And the rollback branch (:410-416): a scripted process that renames and overwrites the
   executable and restarts it is a primitive worth naming on its own, so describe the
   worst case if :restore runs against a .old file that is not the one it saved.
   Judge whether signing is worth its cost at one shop and one vendor, and say plainly what
   the checksum bought (integrity, not authorship). Also: GET /check and GET /progress
   need no session and no license (src/server.js:406-432), so anyone on the shop LAN can
   drive api.github.com from the register on a loop and read the update state machine;
   verify POST /apply cannot be reached by a staff session that never elevated, that the
   factory-PIN refusal holds, that the audit row records WHICH VERSION was installed and
   from what URL, and that exiting about 300 ms after the response cannot strand an
   in-flight sale, an open drawer count, or an unsettled print job. Check the htmlUrl path:
   it is now repo-scoped, but the client still puts it in an href (:1884, :1894) and in
   window.open (:1966) without noopener while the newer screen uses noopener (:2066), so
   name what an operator can be tricked into clicking and what the opened page can reach.
   Positive finding to confirm rather than assume: no remote value reaches innerHTML in the
   update UI (the three body writes at :1974, :2018, :2048 are static), so this surface did
   not import an XSS.
   New to this edition: the license tamper surface. The HMAC trial seal
   (src/license.js:168-224), the persisted workstation_machine_id (:69-96) and the
   anti-rollback clock (:246-266) are all app-side security against a user who owns the
   machine. By this brief's own rubric a bypass that extends an expired trial is a finding;
   report the cheapest bypass you can prove from the code and say what it costs the shop.

5. STABILITY & RESILIENCE
   Crash consistency: power loss or kill mid-sale, mid-close, mid-restore, or mid-print
   job; WAL state; whether the next startup recovers cleanly. Unhandled promise
   rejections or a throw inside a route leaving a response hanging. Disk-full behavior for
   the database, the snapshots, and the log. Backup: state the actual data-loss window
   (startup plus hourly one-per-day snapshots, integrity_check, 14-day retention, mirror
   script) and whether a failed snapshot is noticed. The print transport: the PowerShell
   timeout, a hung queue, an orphaned PowerShell process, and what the counter sees while a
   send is stuck. Kiosk browser crash recovery and the heartbeat watchdog (does a hung
   browser look like an idle user? the closing beacons are gone, so the answer is yes).
   SEA exe behavior: embedded in-memory asset fallback and port retry under a fresh boot.
   Carried from v5, still open: the burst buffer S.scanBuffer as machine state (what a
   scanner with no Enter suffix, a stuck modifier, a tab switch or a modal opening
   mid-burst leaves in it, and whether the next burst starts clean now that pendingScan
   also holds state), and the pairing round trip when the VPS is unreachable or the code
   expires in flight. The AudioContext case is partly answered by the resume catch at
   pos.js:194-200; check the warning is not the only signal a cashier gets.
   The update handoff is the most dangerous failure window in the shop and the list of
   steps grew. Trace it as if the power goes out at each one: a half-written .part with a
   sidecar that claims a different offset; a digest fetch that succeeds but returns an
   asset the exe does not match; the staged file reused because of a resume marker while
   the release moved; the rename-aside succeeding and the spawn then failing (:611 says it
   reverts - verify the revert works when the exe is running from Program Files and from a
   user profile); the detached cmd.exe starting while the parent still holds the handle;
   the :reap poll giving up; the :restore branch running against a missing or partial .old;
   the restarted exe being the old binary because the copy never landed; the new binary
   being corrupt. For each, state what the operator sees, whether any recovery path exists
   besides reinstalling, whether the staged files are retried or rot, and what happens to
   data/shop.db across the swap. On ProgramData (--service) installs, verify
   defaultUpdateStagingDir(true) writes under C:\ProgramData\TechPartsPOS\updates and
   buildApplyScript's schtasks /Run /TN "TechPartsPOS-Server" restarts in both :startnew
   and :restore branches cleanly. Note also that Unblock-File was dropped from
   buildApplyScript so Mark-of-the-Web behavior on browser-downloaded binaries (now that
   Inno Setup installers replace portable .zip archives) warrants checking. Two
   windows v5 already named and both still real: the process exits about 300 ms after a
   success response (src/server.js:1380 area), so anything in flight is killed mid-write,
   and the kiosk lockdown still eats Ctrl+P (public/js/main.js:537-540, comment "POS uses
   ESC/POS thermal pipeline") and F5 plus Ctrl+R (:523). v5's premise that the browser
   print shortcut is the only route to the fallback is now demonstrably wrong in one
   direction and still true in the other: the claim stub calls window.print() itself
   (pos.js:1516) so a browser slip IS reachable on the POS tab through ALT+P, while an
   operator whose ESC/POS queue hangs still cannot refresh a stuck tab. Name which
   fallbacks are reachable by a keypress and which need a button the app is willing to
   render.

6. EFFICIENCY & SIMPLIFICATION (report only, do NOT execute)
   Dead code, unused parameters, unused settings keys, duplication that is NOT the
   deliberate structure listed above, complex logic with a provably simpler equivalent.
   Refactor candidates only.
   Resolved from the v5 handover, verify and stop there: the duplicate 'reload-returns'
   action key is gone (one entry, main.js:299); 'system update_apply' now has an
   ACTION_LABELS entry (public/js/auth.js:1428, humanized fallback at :1451); the .iss
   version drift and the .ps1 not rewriting it are fixed; shift_variance_threshold now
   reaches both a settings screen and a code path. Still to check: GET
   /api/inventory/barcode/:code (route into src/inventory.js) is implemented and tested
   with no frontend caller, because the POS tab resolves a scan against the catalog copy
   it already fetched - is it still dead?; default_retail_markup_pct and
   default_wholesale_markup_pct each reaching both a settings screen and a code path after
   the 11-01 import auto-pricing landed; strings inside a translated surface that bypass
   t(), including the middot day separator, the dash placeholder in the audit list and
   every label still hardcoded in English; and duplicated scanner or SKU logic split
   between the client catalog match and the server route.
   New candidates from this edition: the same download-and-verify feed reachable through
   both checkForUpdates and applyUpdate when no downloadUrl is passed, unchanged from v5;
   updater.js at 728 lines with two progress representations (the state object and the
   polled route) and a buildApplyScript that is now a string template of a batch file;
   the profit and freshness formulas now existing three times (src/analytics.js,
   cloud/server.js:643-800, public/js/report.js and cloud/public/app.js), which is the
   single biggest duplication introduced since v5 and the direct cause of the category 10
   parity risk; the 27 new i18n keys duplicated key-for-key between the en and tl tables;
   two release entry-point scripts at the root (publish.bat from 2026-10-01,
   publish-release.bat from 2026-11-02) doing overlapping work; and src/updater.js:125's
   reference to a comment that no longer exists, which is a documentation wart that will
   mislead the next person to read the trust model.

7. OBSERVABILITY & OPERATIONS
   Can a production failure be diagnosed from pos-server.log and the audit trail alone
   (pos-server.log is the only diagnostic surface the packaged exe has)? Trace and
   console-only diagnostics that nobody sees. Silent failures that vanish without a trace:
   a print send that fails (does the fallback plus logging leave a trail?), a settlement
   slip gate, a sync drift (can the operator SEE syncLastError, the last attempt and
   outbox depth, or does drift stay invisible until someone opens the manager app?), a
   stale-snapshot warning that never fires. What the day close does when it fails halfway.
   Hardcoded values that should be settings.
   Carried from v5, unchanged: a refused scan (unknown code, out of stock, over quantity)
   leaves no trace but a toast the cashier may not read at speed, so reconstructing why a
   part did not land on a ticket afterwards is impossible; a bulk edit that answers 409 on
   one row of twenty; the pairing failure states (expired code, wrong PIN, unreachable
   VPS, code already redeemed) and whether the operator can tell which one happened; the
   startup SKU collision rename, which prints one [init] renamed line to pos-server.log
   and then never mentions the suffixed code again.
   The update picture changed direction: src/updater.js now logs, roughly 20 updateLog
   calls from :293. So the question is no longer "is there silence" but "is there signal
   and is it safe": verify which of those lines land in pos-server.log in the packaged exe,
   whether a timed-out check, a size mismatch, a refused dev-mode apply and a digest
   mismatch are distinguishable from each other afterwards, whether any line prints a URL,
   a version or a path that reads like a credential, and whether an operator can tell after
   the fact which version is installed and where it came from. The audit row names the
   actor; check whether it names the version and the URL. Also new and unreliably visible:
   the stalled-handoff screen (backoffice.js:2046-2075) is the operator's only signal when
   the detached cmd.exe stops answering - so ask whether anything on the server side
   records that the handoff stalled, or whether the evidence dies with the browser tab.
   The release pipeline is the other silent half: whether a failed publish (test red,
   build red, upload refused after the tag was force-pushed) leaves a tag pointing at a
   missing or partial release that every shop then fails to check against, now that the
   script claims a guard at :542-570; and whether the version bump that lands only in
   gitignored files is visible anywhere but a git tag.

8. TEST QUALITY
   642 tests across 52 tracked files (measured 2026-11-13 at b55f517; the cf06069 same-day
   refresh counted 638 across 51, v9 counted 610 across
   49 at 533f07a, v8 counted 568 across 49 files including untracked universal-pos, v7
   counted 505 in 44), with mix of
   behavioral, hybrid vm-slice, and static greps. Recount per file, keep the
   behavioral / hybrid / pure-static split as the useful axis, and name what each group can
   actually detect. Recent additions: tests/setup.test.js, tests/backup-restore.test.js,
   tests/analytics-parity.test.js, tests/universal-pos.test.js, tests/receipt-choices.test.js,
   tests/reorder.test.js, tests/port-drift.test.js, and tests/packaging-workflows.test.js
   (covering installer/TechPartsPOS.iss task XML, ssDone cleanup, installer-only releases
   without .zip, and publish-release.ps1 ordering), plus the v1.0-release additions
   tests/appearance-tones.test.js and tests/build-exe-icon.test.js. Also verify tests/ui-fixes.test.js CRLF
   normalization in source() keeps the suite deterministic on Windows checkouts. Files added
   since v6: tests/template-chooser.test.js and
   tests/changelog.test.js (both from the parallel 11-03/05 session; the latter is a new
   KIND of gate, verify what it actually asserts). Files materially changed by that
   session: typography-presets, report, cloud-hardening, updater-ui, importer, inventory.
   The 11-05 sync batch added two behavioral tests to tests/sync.test.js (backfill round
   trip, heartbeat plus 401), extended the pair-cloud test in tests/server.test.js with a
   backfill assertion, and rewrote two tests/sync-hardening.test.js cases that assumed an
   empty outbox never touches the network. tests/updater.test.js runs through a test seam
   (setUpdateTestHooks / updateFetch) rather than only the pure helpers - say precisely how
   much of the download and verify path that seam makes reachable and what it fakes. For
   the hybrid and static groups, say which of them would still pass if the feature they
   name were deleted outright, and name the money, ledger, stock, warranty, print, sync
   and update paths that have only a happy-path or assert-nothing test. The scanner suite
   remains the strongest vm harness and still cannot say anything about a physical
   reader. Verify the harness scratch-env claim (helper.js temp dirs, the sentinel queue,
   the sendRaw patch) and audit the exceptions by grepping for createServer() rather than
   trusting this file.
   Check determinism on its merits: `startCloud` in tests/cloud-hardening-harness.js now
   binds `PORT: '0'` rather than `reservePort` (only the blank MANAGER_PIN failure test
   at tests/cloud-hardening.test.js:472 still calls `reservePort`). Two historical gaps
   from v5: `tests/packaging-workflows.test.js` now parses scripts/publish-release.ps1 and
   pins draft-before-publish ordering (only live release execution lacks an automated run),
   while the detached cmd.exe handoff in src/updater.js has still never executed under
   test - now including the resume, the sidecar, the rename-aside and the :restore branch.

9. WORKSTATION-SPECIFIC CONCERNS
   a. Money is stored as REAL (binary float) end to end. Audit centavo drift across
      subtotal, discount, total, change, dual-tier pricing (retail vs technician), FIFO
      partial settlements summing back to the stored credit balance, and the printed slip:
      paper must never disagree with the register. Add the inline cart quantity editor: a
      quantity changed after the line price was computed is a fresh rounding path.
   b. Utang ledger integrity: can credit_balance and the payments rows ever disagree (sale
      voided after partial settlement, refund while utang is outstanding, settlement
      exceeding the balance)?
   c. Stock atomicity: sales creation is verified; verify returns, credit settlements and
      stock adjustments decrement and enqueue atomically too. Two cashier screens selling
      the last unit of a part?
   d. Warranty/RMA: expiry math, replacement versus refund effects on stock and ledger,
      manager authorization recorded in the audit trail for every decision, and the
      per-unit math: a partial claim on a multi-unit line, the refund ceiling for that
      subset, and whether the slip and Sales history show the quantity actually returned.
   e. Day close: reconciliation math per payment method, double close, GCash refs
      required, manager threshold for GCash/transfer collections, and the variance line
      now driven by shift_variance_threshold.
   f. Printing: every print path honors the gate that refuses to print while shop identity
      is still the placeholder; slip fidelity (item lines, dual-tier price, change, utang,
      warranty block) matches the register at 32 and 48 columns; the browser fallback
      prints a readable receipt; the counter never faces a dialog in the normal path. The
      CLAIM STUB is the gap here: it has NO ESC/POS encoder at all, so a thermal counter
      gets it through the browser path while every other counter slip comes from the queue.
      Say whether that is acceptable, and check what the stub's browser CSS does to a
      58mm paper width it was never sized for.
   g. Dual-path coherence: slip formatting exists twice by design (src/printer.js ESC/POS
      and public/js/receipts.js browser fallback). Find drift between them (a field one
      path shows and the other drops, a rounding difference). Extend the same question to
      the number itself, not just the paper: net profit and the freshness pill now exist
      in src/analytics.js, public/js/report.js, cloud/server.js and cloud/public/app.js.
   h. Barcode scanner at the counter: the reader must be in HID keyboard-wedge mode with an
      Enter or CR/LF suffix. Exercise, with a real scanner and a real part: a retail code,
      a custom SKU shorter than 6 characters, a code whose first digit is a zero, an
      unregistered code, a code for an out-of-stock part, the same code twice until stock
      runs out, and a trigger pull with the caret parked in each of the five exempt fields.
      Add the 2026-10-15 logic to the list: a burst whose CR arrives before the last digit
      settles, a paste into a field that the classifier is mid-burst on, and typing at a
      speed that should NOT arm a pending scan. Confirm the buzz is audible over shop noise,
      that a refused scan adds nothing to the cart, and that a hijacked burst leaves the
      field holding what it held before. Manual evidence the suite cannot produce.
   i. Locale and appearance presets: two seats, one tl and one en, each font preset open at
      once. Anywhere a value is formatted, parsed, sorted or compared on locale-sensitive
      rules is where a machine-local preset could disagree with the register; the presets
      are meant to be cosmetic only, so prove that or report the leak. Now widen it: the
      report PWA has a persisted theme, the cloud has a fixed TZ_MODIFIER offset instead of
      a real zone, and namefold folds debtor names for matching - all three are cosmetic in
      intent and must not reach money, stock or a ledger key.
   j. Cash drawer and the update, both only provable by hand at the counter. Drawer: the
      kick is still default-on for sale, settlement and test (src/server.js:971), so with a
      real drawer or a paper clip in the kickout confirm a slip the queue REFUSES (bad
      printer name, printer offline, fallback to the browser path) does not pulse the
      drawer on a sale that was never taken, that a reprint does not ring it a second time,
      and now that the claim stub does not ring it at all. Update: run the whole flow on a
      machine that actually holds TechPartsPOS.exe and note that the UI now shows live
      progress; confirm the version badge and the Settings Data panel after the restart,
      confirm shop.db survived the swap, time how long the counter is unusable, then do the
      destructive halves deliberately: kill the app mid-download and confirm the resume
      picks up correctly rather than installing a corrupt exe; confirm the rollback branch
      actually restores the previous binary; confirm the Inno Setup installer and any
      browser-downloaded update binaries launch without Mark-of-the-Web blocking now that
      portable .zip downloads are gone. Neither is testable
      here, so list both as numbered manual steps in the measurement list rather than
      reasoning them closed.

10. CLOUD SYNC AND REAL-TIME MANAGER APP (open items only; the mechanism itself is
    verified, see the hardening block)
   a. Remaining enqueue sweep: day_reconciliations, cash_adjustments and customer_profiles
      sync (verified 2026-09-27) and the RMA path enqueues the parent sale
      (src/returns.js:132, :151). Sweep every write path (shifts, staff, the cart quantity
      restatement, the claim stub, the 11-03/05 parallel batch's inventory and updater
      edits, anything newer) for writes that never enqueue: such rows silently never reach
      the cloud, and this is the worst failure this design can have. Above all POST
      /api/inventory/bulk-edit with its inventory rows and op_log entries, and a credit
      restatement of total_spent_paid. Settings saves stay un-enqueued by design. The
      11-05 backfill closes the "paired shop never syncs its existing rows" hole for the
      tables it covers; verify the pair of lists agrees (everything backfillMirror covers
      is a table the cloud accepts, and everything the cloud accepts and the shop writes
      is either live-enqueued or backfilled).
   b. The data-minimizing accident: shop_settings, staff and audit_log are whitelisted but
      have no enqueue call sites, so no secrets leave today. Flag any NEW call site that
      would push sync tokens, PIN hashes or owner PII to the VPS.
   c. Schema and formula drift: the 11-02 alignment batch made the cloud compute the
      workstation's numbers and tests/analytics-parity.test.js now pins parity across
      top_products, standing, reorder/dead stock, period analytics, and fractional
      quantities. Find any newer workstation row shapes (wholesale tiers, multi-industry
      items) the cloud queries still do not expect or where the two implementations can
      disagree.
   d. Exposure posture: /sync is authenticated, idempotent and budget-limited (verified).
      Assess whether the newer routes need the same budget (the pairing and setup routes
      now have one each; check what /events and the report route do), verify the legacy
      shared token path is genuinely off in the real deployment, and settle the SSE
      broadcast scope (STILL OPEN: no shop filter in broadcast at cloud/server.js:194-200,
      no shop tag on /events, so does a change event leak another shop's activity or
      trigger its refetch for every logged-in manager?).
   e. Manager app: the reconnect refetch is implemented; check what remains (any view
      relying on SSE alone without an initial fetch, the session cookie Secure flag behind
      the TLS proxy, the shop-blind refetch) plus the new freshness and theme work: does a
      Live pill ever display over stale data, does STALE_MAX_MS agree with the workstation
      report's own rule, and does the theme key gate anything it should not. The
      console-print item is STILL OPEN in part, see KNOWN OPEN.
   f. Cloud ops: the daily integrity-checked cloud.db backup exists (verified 2026-09-27);
      state the remaining window and what a failed cloud backup does. Do the claims in
      OPERATIONS_AND_DEPLOYMENT.md and README.md match reality for the bundled,
      office-LAN and VPS postures - README.md:3 now asserts the update check is "silent
      when there is no route, amber text in Settings only", so verify that sentence is
      true of the code, since it is now a customer-facing promise.
   g. Pairing versus hand-editing: the workstation gained POST /api/settings/pair-cloud
      (src/server.js:843, which builds the target and calls /api/pair, now with a 15 s
      abort at :872). It runs validateSyncUrl on the submitted url, so establish what that
      validator now allows it to reach, including the loopback carve-out, and then
      establish what it writes: does a successful pair replace, shadow or contradict a shop
      configured the older way (the SYNC_URL env override, a hand-set sync_url and
      sync_shop_id), and can a shop end up pushing rows to a target the operator never
      approved? Trace the failure paths too: a 400 invalid or expired code, a network error
      mid-request, a code typed with spaces (the workstation strips whitespace before
      sending), and now a 15 s abort landing mid-pair after the cloud already spent the
      code - which side holds the truth.

OUTPUT FORMAT
Per finding:
  [SEV] [CONFIRMED|SUSPECTED] File:line - Short title
  What: plain-language explanation, assuming the reader is not an expert
  Trigger: the exact scenario that makes it happen
  Impact: consequence at this project's stated scale
  Fix sketch: 1-3 sentences of direction (do not implement)
Severity rubric: CRITICAL (data loss/corruption, security breach, crash) /
HIGH (breaks a core workflow) / MEDIUM (measurably degrades quality or performance) /
LOW (hygiene, polish).

FINAL DELIVERABLES (in this order)
1. Executive summary: top 5 issues, one line each
2. Full findings by category (or CLEAN)
3. Future Scale Notes: what would matter at 10-100x the volume (more seats, more
   shops, a real multi-tenant cloud, a busier counter with printers on two desks)
4. Ranked remediation plan: safe quick wins versus needs-careful-planning, ordered by
   severity divided by effort
5. Measurement list: findings needing runtime verification, with the exact command
   or manual steps for how I can verify each one yourself. Ground rules: the suite is
   npm test, and because it is not deterministic a single red run proves nothing - rerun
   and report which files moved. For anything needing a live server, copy src/ and public/
   (or cloud/) to a temp directory and run there with NODE_ENV=test NO_AUTO_BROWSER=1
   NO_AUTO_EXIT=1 on a high loopback port; use localhost, never 127.0.0.1 literals. The
   suite must never print paper: the sentinel queue in tests/helper.js is the mechanism, do
   not bypass it. Cloud checks run against a local throwaway instance on localhost, never
   the real VPS, never with real tokens. NEVER run the update apply flow against the
   working tree: point a copy of the exe at a temp directory, or an interrupted handoff
   renames the binary you are auditing. There is no browser automation in this
   environment: any visual finding is verified by code inspection and layout math, and the
   report says so. Three surfaces can only be closed by hand at the counter: the physical
   scanner exercise in category 9 item h, the printed slip including the claim stub, and
   the real update install with its resume, rollback and Mark-of-the-Web checks in category
   9 item j. List them as numbered steps I perform, never as a command, and never mark them
   verified from browser evidence.

Zero em dashes anywhere in the report. Then, under the standing blanket approval recorded
in the header: fix every finding in the same run, ordered by the remediation plan, each
fix with a regression test or an explicit test update, the full suite green before
delivery, the deliberate non-fixes recorded, and the report file left untouched after it
lands.
