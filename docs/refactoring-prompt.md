# Refactoring Pass Prompt (v3)

[v3, 2026-11-09, supersedes v2 of 2026-10-14. v3 exists because three of v2's facts
died: the baseline moved (423 to 536 tests), git now tracks the full source tree
(6834474, 2026-11-07), and every file size in v2's inspection order grew. Companion:
docs/code-audit-prompt.md (now v8) governs find-and-report audits and carries the
verified-behavior list; this prompt carries structure only. Refactoring is dispatched
by the techparts-pass skill (.agents/skills/techparts-pass/SKILL.md) alongside
remediation, cleaning, test hardening and feature batch. Never fold audit findings
into this pass, and never fix anything inside this pass. Refactoring and auditing stay
separate passes.]

MISSION
Improve internal code quality with ZERO behavior change. In scope:
- CHOPPING for readability: Extract Function/Method and Extract Module (big
  multi-responsibility files split into cohesive pieces). These are the primary
  techniques.
- CLEANUP: rename toward domain language, remove duplication, inline useless
  indirection, delete dead code.
In-scope code: src/ (except db.js), cloud/ (server.js and its manager app), and
tests/ (the *.test.js files and helper.js; the gate is node --test). cloud/ is in
scope because behavioral tests exist for it (tests/cloud-hardening.test.js spawns a real
cloud process and tests/remediation-final.test.js runs live server tests).
src/updater.js is in scope (719 lines now, still cohesive); expect few candidates, but
note the hard constraint in MUST-PRESERVE: the release script rewrites its version line
by regex.
OUT of scope: public/ (its tests are worse than static greps: seven files, including
barcode-scan, ui-fixes, frontend-regressions, cart-recovery, audit-regressions,
reports-behavior and template-chooser, slice a source region out of the file and execute
it in node:vm, so a refactor that moves or renames a function there breaks the harness
that extracts it, and no test exercises the real browser anyway. UI behavior cannot be
verified in this environment, so a "verified" frontend refactor is impossible: report
candidates separately instead), db.js (schema and guarded ALTERs are behavior), scripts/
(the SEA build pipeline, the license tooling and, since 2026-10-14, publish-release.ps1
are behavior; nothing tests the .ps1, so nothing can tell you a refactor of it broke),
installer/,
package.json, the settings whitelist shape in src/settings.js (the whitelist object
is behavior; the rest of that small file is fair game). Bug fixes, features,
behavior tweaks, dependency additions (the zero-runtime-dependency contract is
absolute: no npm runtime package ever enters src/ or cloud/), styling/format-only
churn. If you find a bug, STOP and report it separately, never fix it inside this
pass.

BASELINE RITUAL (first, no exceptions)
1. The gates are fixed for this project; do not re-detect them:
   - Suite: npm test (node --test tests/*.test.js). Measured 2026-11-11: 568 tests,
     568 pass, 0 fail, about 25 seconds (560/560 on 2026-11-10, 536/536 on 2026-11-09,
     505/505 on 2026-11-05, 423/423 on 2026-10-14). There is no JS compile step in dev;
     npm run build:css rebuilds public/tailwind.build.css after Tailwind changes, and
     the suite is the main automated gate. node --check on touched files is a fair
     extra, nothing more. npm run verify:exe is the read-only gate, and
     tests/packaging-workflows.test.js directly tests scripts/publish-release.ps1
     and the batch publishing entry points.
2. Run the gate. Record the exact result INCLUDING failures. IDENTICAL before and
   after means the same set of pass and fail, not all-green. Pre-existing reds:
   none known (568/568 on 2026-11-11, 560/560 on 2026-11-10, 536/536 on 2026-11-09,
   505/505 on 2026-11-05, 423/423 on 2026-10-14). A new red is a stop condition, not a baseline entry. A hung run is
   a rerun, not a regression. One standing rule the suite re-learned on 2026-10-14: never hand-roll
   createServer() in a test, always take helper.js's serverTest, because the default
   dbPath resolves to the real data/shop.db (src/server.js:279) and sendRaw is only
   patched by the harness. If you find a test doing it, report it, do not quietly
   rewrite it in a refactor pass.
3. SNAPSHOT FIRST, with git doing the work now: the full source tree is tracked since
   6834474 (2026-11-07), so git diff and git checkout -- <file> are the real undo
   path, and git status is the interference detector (files edited by one session
   have been found reverted or truncated while another session was live; re-verify a
   file before editing it if it was read earlier in this run). Never git --amend: the
   release pipeline commits mid-session. Keep the
   backups/code-pre-refactor-YYYY-MM-DD/ convention as belt-and-braces for
   multi-file steps, preserving relative paths (the established code-pre-* pattern).
   To find what is new and therefore where the structure is still soft: git log
   --stat and git diff v2.8 (v2.8 = 94d1206) instead of guessing.
4. The suite must never print paper: tests/helper.js enforces the sentinel printer
   queue and a sendRaw patch that refuses every other queue. A refactor step that
   makes any test open a real queue is a stop condition.
UI-visible behavior has no automated check in this environment (no browser
automation): proofs for UI-facing seams are code inspection plus layout math,
stated as such. Never claim a click-through that did not happen.

RULES OF ENGAGEMENT
- One refactoring at a time. Run the gate. Only then continue. Do not commit unless
  asked (full source is tracked since 6834474, and never git --amend because the
  release pipeline commits mid-session).
- If a step has to touch a banner comment or a terminating function that one of the
  vm-slice tests extracts (the BARCODE SCANNING region of public/js/views/pos.js is the
  clearest case), update the extractor in tests/ in the SAME step and re-run the gate; a
  slice that silently stops matching what it meant to run is worse than no refactor,
  because the test keeps passing while testing nothing.
- Split by RESPONSIBILITY, never by line count. New seams follow the existing ones
  (module-per-concern in src/, the pure-layout versus transport split in
  src/printer.js). If total line count goes UP after an extract, that is fine and
  expected; readability is the metric, not brevity.
- Thresholds: act on functions over ~40 lines or with more than one nesting level;
  act on logic duplicated in 2+ places. Mechanical blocks (route registrations,
  schema, seed catalogs) are conventionally long and repetitive: do not split them
  for line count; extract only behavioral code buried in them.
- Honesty clause: this codebase was built deliberately. The ESC/POS build restructured
  the print path, the 2026-10-14 build added src/updater.js and the release pipeline, and
  both were done with tests written alongside. If a file is already readable and cohesive,
  write CLEAN and move on. Manufactured work is the failure mode here, not missed
  refactors.
- No new frameworks, libraries, or architectural layers. Code lives in its existing
  layer (server routes, then domain modules, then db). If a helper exists, move code
  INTO it; never create a parallel structure.
- Follow the project's conventions: ES modules; long intent comments are load-bearing
  and move with the code they explain, and new comments state constraints the code
  cannot show, never narrate changes (antislop-code); escHtml for every
  interpolation; money() for every amount; no em dashes anywhere.
- PROTECTED STRUCTURE (do NOT re-inline, merge away, or flag as duplication): the
  pure-layout versus byte-output versus transport split in src/printer.js (wrap,
  plain, localStamp, localDate, nameLines, colsFor and the render* functions are
  pure; encode owns bytes; buildSendJob, runCommand, sendRaw, parseSendResult,
  parsePrinters own the transport); tests/helper.js scratch-env (temp-dir databases,
  the sentinel queue seed, the sendRaw patch); money() and the integer-cent client
  math; FIFO settlement; op_id idempotency on sales, returns, and settlements plus the
  op_log table (src/db.js:392, read and written by src/inventory.js:81-85) that extends
  the same dedup to stock adjustments, import rows and part creation;
  the append-only audit trail with its hash chain and the ACTION_LABELS keys;
  the outbox (enqueue sites, acked-only marking, backoff to the 300s cap, 30-day
  prune, validateSyncUrl); the route-to-frontend action match; the static-grep test
  pattern in tests/frontend-regressions.test.js and friends (deliberate here; do not
  convert greps to behavioral tests inside a refactor pass); the lifecycle pieces
  (machine lock, bounded port retry, heartbeat watchdog, SIGINT/SIGBREAK/SIGTERM
  handlers); the scan-burst block in public/js/views/pos.js:167-384 as one extractable
  region, because tests/barcode-scan.test.js slices it out by its banner comment and its
  terminating function and runs that slice in node:vm (splitting it, renaming the banner,
  or moving a function out of the slice breaks the test, not the feature); the same
  extract-and-execute pattern in ui-fixes, frontend-regressions, cart-recovery,
  audit-regressions, reports-behavior and template-chooser; the pure check versus staged
  apply split in src/updater.js (parseVersionParts, isRemoteNewer, isTrustedReleaseUrl
  and isTrustedPageUrl are pure, checkForUpdates is fetch only, applyUpdate owns the
  staging, the size compare and the cmd handoff: do not collapse them, that split is what
  lets tests/updater.test.js run at all); the route-group and lifecycle split buried in
  src/server.js; the appearance and language modules (theme.js whitelist at :23 applied at
  :95, i18n.js t and applyLanguage) as browser-local cosmetic state that must never
  acquire a server-side effect.

MUST-PRESERVE INVARIANTS
- All public APIs / exports other code or tests call.
- Documented non-negotiables: parameterized statements only (node:sqlite prepare);
  one transaction per multi-statement write; append-only audit trail with UTC
  timestamps; no secrets in sync payloads; validateSyncUrl behavior; PBKDF2
  parameters and timing-safe compares; the factory-PIN elevation gate; busy_timeout,
  WAL, and foreign_keys ON.
- Offline core semantics: the outbox row shape; acked-only marking; the confused-
  endpoint guard; the backoff curve; the prune rule; the PullAfterWrite-free
  one-way design (no pull must appear).
- Lifecycle behavior: the %LOCALAPPDATA%\TechPartsPOS\server.lock machine lock (tests
  never touch it); the bounded port retry; the watchdog heartbeat; the crash log.
- Print behavior: sendRaw reachable only through the sentinel in tests; the
  environment-variable transport (TP_PRINTER, TP_DOC, base64 TP_PAYLOAD, plus the
  -EncodedCommand script at src/printer.js:476-478); the drawer kick is now real and
  defaults ON for the sale, settlement and test jobs (encode(lines, { drawerKick }) at
  src/printer.js:92-94, defaulted at src/server.js:928-929), so removing or defaulting
  it off is a behavior change, not a cleanup; no cut command is ever sent; the browser
  fallback contract.
- Settings and file formats that are behavior: the settings whitelist, the license
  token format, the outbox and audit row shapes.
- Update mechanics, all of them load-bearing outside this file: the version line must
  stay exactly `const CURRENT_VERSION = 'x.y';` on one line, because
  scripts/publish-release.ps1 rewrites it by that regex (the 2026-11-08 rewrite moved
  line numbers; find the substitution, do not trust a stale coordinate) and any reformatting
  (double quotes, a template string, a destructure, a shared constants module) makes the
  release silently stop bumping; the staged file names
  TechPartsPOS_update.exe and apply_update.cmd under %LOCALAPPDATA%\TechPartsPOS, which
  .gitignore lists; the node.exe dev guard (src/updater.js:183-193) is what keeps tests
  from replacing a real binary; the two route strings
  GET /api/system/update/check and POST /api/system/update/apply appear in the session
  exempt list (src/server.js:402) and the license exempt list (:384-385) and must be
  edited in all four places at once; the asset names the pipeline uploads
  (TechPartsPOS.exe and the zip) are what src/updater.js:132 matches; and the
  sibling checksum asset is named exactly TechPartsPOS.exe.sha256, because digestUrlFor
  derives it by appending .sha256 to the executable URL, digestMatches gates the stage
  write on it, and scripts/publish-release.ps1 produces it with Get-FileHash and uploads
  it as text/plain. Renaming either asset, moving the digest fetch after the write, or
  letting a missing digest pass is a behavior change that strands an installed shop
  mid-update. Keep both helpers pure and exported: tests/updater.test.js can only prove
  the pure pair, because the node.exe dev guard means the download path never executes
  under test.
- Deliberately simple (leave as-is; changing any of these is behavior work): the
  stdlib HTTP routing with no framework; the synchronous single-process SQLite
  model; REAL money columns end to end (the integer-cent client math is the guard);
  the browser print path for the Z-report and period summaries; start.bat's plain
  foreground run with the watchdog.
- Security-relevant structure may be touched only if the guarantee provably
  survives; when in doubt, report instead of restructure.

PRIORITY INSPECTION ORDER
1. God files: src/server.js (2113 lines: about 70 routes, lifecycle, print wiring,
   static serving, the instance lock and the update routes in one file) and
   cloud-deploy/server.js (1887 lines, byte-identical to cloud/server.js at
   measurement). Assess honestly; extract cohesive route groups or lifecycle seams
   only when it does not create parallel structures. The largest single block inside
   src/server.js is the route chain itself: split by resource (inventory, sales, auth,
   system), never by arbitrary line number, and remember that the session and license
   exempt lists must travel with their routes. In public/, the four biggest files are
   auth.js (2349), backoffice.js (2168), views/inventory.js (1700) and pos.js (1616):
   out of scope, but report them as the honest candidates they are. src/printer.js
   (970, grown from 631 by the receipt-template line layer that the new paper-preview
   route shares) and src/updater.js (719) are newer and cohesive; expect few
   candidates there.
2. Long functions (>40 lines, deep nesting), exempting mechanical blocks as above.
3. Duplicated blocks NOT in the protected list. One known REPORT-only case: slip
   formatting exists twice by design (src/printer.js and public/js/receipts.js);
   report drift between them, do not merge across the public/ boundary.
4. Misleading or generic names; rename toward the domain vocabulary (slip,
   settlement, utang, drawer, outbox, RMA, elevation).
5. Dead code, unused parameters, unused settings keys; remove only when behavior
   preservation is provable, otherwise report.
6. Tangled coupling between modules: REPORT only, do not act.

OUTPUT PROTOCOL
- PHASE 1: Propose the full refactor list before touching anything: file,
  technique, why, risk level, ranked by value. WAIT for approval.
- PHASE 2: Execute one approved step at a time. After each: what changed, the gate
  result, and one line on why behavior is preserved (inspection for UI-facing
  steps, stated as inspection).
- FINAL: Summary: steps completed, net line delta (up or down is fine), what you
  flagged but deliberately left alone and why, and any pre-existing reds that
  remain untouched.

STOP CONDITIONS
Revert (git checkout -- <file>, or copy back from the newest backups/code-pre-refactor-*/
snapshot) and report if: the
gate result changes beyond the recorded baseline, a step would break a preserved
invariant, the suite cannot verify a step, a test would open a real printer queue,
or a "refactor" would alter observable behavior. Also stop and propose separately
any step that would require editing public/, db.js, scripts/, installer/,
package.json, or the settings whitelist: they are out of scope.
