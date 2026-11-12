# Code Cleaning Pass Prompt (v1)

[v1, 2026-11-09. Boundary rule: consolidation = refactoring
(docs/refactoring-prompt.md), deletion = cleaning (THIS FILE), bug fixes =
remediation (docs/remediation-prompt.md). This pass deletes; it never fixes, never
consolidates, never changes behavior.]

MISSION
Subtraction only: dead code, stray files, rot. Every deletion is proven unused first.
Deletion over addition is this project's stated engineering value; manufactured work
is the failure mode, so a short honest pass beats a long padded one.

BASELINE RITUAL (first, no exceptions)
1. Read the TREE STATE block below. If it is stale (HEAD, gate counts, or dirty files
   differ from observed), refresh the block to today's observed state and say so in
   one line. Re-measure, do not copy a number you did not see.
2. Run the gates and record exact results BEFORE the first change:
   - npm test (node --test tests/*.test.js): all pass, exit 0 (661/661 on 2026-11-13,
     about 30 s; today's count becomes the run baseline).
   - npm run build:css: exit 0.
   A hung run is a rerun, not a regression; rerun once before concluding anything.
3. git status is the interference detector: files edited mid-session have been found
   reverted or truncated in this tree before. Re-verify anything you are about to
   delete matches what you read earlier in this run.

PROOF RULE (a thing is deletable only when all three hold)
1. Zero references: grep the whole tree (src/, public/, cloud-deploy/, tests/,
   scripts/, installer/, docs/) for every name it exports, every call site, and every
   string key that might reach it dynamically (action maps, data-action attributes,
   settings whitelist, i18n keys, route strings).
2. Build holds: npm run build:css still exits 0 (matters for public/ styles).
3. Suite holds: npm test passes at the recorded baseline after the deletion.
If any proof is missing, the item moves to the report, not the delete list.

TRAPS (look dead, are deliberately kept; ask before touching ANY of these)
- The browser print fallback (@media print paths, the window.print claim stub in
  public/): the documented fallback when the ESC/POS queue refuses; AGENTS.md
  invariant 4. The Z-report and period summaries are on the browser path by design.
- VENDOR_PUBLIC_KEY_PREVIOUS_B64 in src/license.js: the verify-only pre-rotation
  key; the comment above it states the condition for dropping it. Dropping it early
  strands sold seats on update.
- The legacy SHA-256 PIN hash upgrade leg in src/auth.js: the migration path for
  installed seats; deleting it bricks their logins.
- isReleaseShaped() guards: they stop data writes into release/ and publish/.
- The scan-burst gates in public/js/views/pos.js (SCAN_BURST_MS, SCAN_FIELD_MIN,
  SCAN_TEXT_FIELDS, modal/gate suppression): documented deliberate gates in
  docs/OPERATIONS_AND_DEPLOYMENT.md section 2.5; re-tuning them is behavior work.
- The literal English fallback on every i18n t() call: deliberate contract (key plus
  literal), not duplication.
- .part / .part.json sidecar handling in src/updater.js: download resume state, not
  litter.
- cloud/ versus cloud-deploy/: scripts/deploy-cloud.js copies cloud/ INTO
  cloud-deploy/ and uploads the cloud/ copies, so cloud/ is the deploy source of
  truth; deleting either tree is a deploy outage.
- SIGINT/SIGBREAK/SIGTERM handlers, the watchdog, the machine lock, the bounded port
  retry: lifecycle, not dead code.
- The updater's session/license route exemptions and the dual cloud analytics
  implementations: documented surfaces under active audit, not debris.
- The SYSTEM service and PIN recovery wiring: TechPartsPOS-Server task setup in
  installer/TechPartsPOS.iss, --service loopback mode and runInstalledLauncher in
  src/server.js, isProgramFilesPath in src/db.js, schtasks restart in src/updater.js,
  PIN_NAMESPACES.recovery in src/auth.js, PRIVATE_SETTINGS recovery keys in
  src/settings.js, and GET /api/backup/download.

STRAY FILES (report, ask before deleting)
pos-server.log at the repo root, publish/ contents, dist/installer/ build artifacts, live
runtime state inside dist/ (data/, backups/, browser-profile/, pos-server.log),
tests/ t_*.db litter (must be zero; verify). Note: publish.bat and
publish-release.bat are active, tested release entry points; do not delete. (cloud-deploy.zip
no longer exists at the root; report only if re-introduced.)
NEVER delete: data/ (the shop database), backups/ (shop snapshots), the
backups/code-pre-* trees (the diff history), dist/vendor-private-key.pem (vendor
signing key; loss is unrecoverable and it must never ship either).

ROT (report, then act only with approval)
Stale comments contradicting code, unused exports, dead branches, doc drift against
the current tree. A comment stating deliberate behavior that the code no longer
matches is a REMEDIATION finding, not a cleanup.

OUTPUT PROTOCOL
PHASE 1: propose the full deletion list (item, the proof it is unused, lines or bytes
saved) and WAIT for approval. PHASE 2: delete one approved item at a time, run the
gates after each. FINAL: deleted items with proof, items declined by the TRAPS list,
final gate numbers.

STOP CONDITIONS
A gate goes red after a deletion and stays red on rerun (restore the item, report);
the user declines an item; the tree shows concurrent interference. Report and stop.

TREE STATE (measured 2026-11-13; refresh to observed state on every run)
- HEAD: c91f354 (4 unpushed docs commits above origin/main 4e7d19b; measured facts unchanged from e86e347)). Full source is tracked
  in git (since 2026-11-07); the release pipeline commits mid-session, so never --amend.
- Gates: npm run build:css exit 0; npm test 661/661 pass, 0 fail, exit 0 across 55 test
  files (all tracked).
- Working tree: clean at measurement (`git status --short` empty).
