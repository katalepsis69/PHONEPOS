# Remediation Pass Prompt (v1)

[v1, 2026-11-09. Companion to docs/code-audit-prompt.md (finds and reports) and the
dispatcher skill .agents/skills/techparts-pass/SKILL.md. Boundary rule: consolidation
= refactoring (docs/refactoring-prompt.md), deletion = cleaning
(docs/code-cleaning-prompt.md), bug fixes = remediation (THIS FILE). This is the only
pass allowed to change behavior, and only for findings the user approved by number.]

ROLE
Fix user-approved findings from the latest audit report, ONE at a time. The unit of
work is one finding, not one category, not "the rest of the list".

BASELINE RITUAL (first, no exceptions)
1. Read the TREE STATE block below. If it is stale (HEAD, gate counts, or dirty files
   differ from observed), refresh the block to today's observed state and say so in
   one line. Re-measure, do not copy a number you did not see.
2. Run the gates and record exact results BEFORE the first change:
   - npm test (node --test tests/*.test.js): all pass, exit 0 (610/610 on 2026-11-12,
     about 24 s; today's count becomes the run baseline).
   - npm run build:css: exit 0.
   A hung run is a rerun, not a regression; rerun once before concluding anything.
3. git status is the interference detector: files edited mid-session have been found
   reverted or truncated in this tree before. If a file you are about to edit differs
   from what you read earlier in this run, re-read it and re-verify before editing.

SCOPE RULES
- Fix ONLY the finding numbers the user approved in this invocation. If the invocation
  names no numbers, ask for them; never start from the report on your own.
- Every fix ships a regression test that FAILS on the unfixed code and PASSES after
  (node:test, in the matching tests/*.test.js file). If the failure cannot be
  expressed in node:test, say so and name the evidence that replaces it.
- One finding at a time: edit, add the test, run the gate, report, then move on.
  Never batch unverified fixes.
- A fix that would exceed the finding's scope (files the finding did not name,
  documented behavior it did not cover) STOPS and asks.
- Dependencies are never the fix: the zero-runtime-dependency contract in AGENTS.md
  is absolute.
- Deliberate non-fixes are recorded in the final report with one line of why.

NON-NEGOTIABLES WHILE FIXING (AGENTS.md, restated as fix constraints)
- Prepared statements only (db.prepare); one transaction per multi-statement write;
  the append-only audit trail and its hash chain stay intact; no secrets in sync
  payloads.
- money() integer-cent math; REAL money columns; dual-tier pricing; FIFO utang
  liquidation; the change and drawer math.
- WAL, foreign_keys ON, busy_timeout; guard SQLITE_BUSY and Windows EBUSY/EPERM.
- Tests never print paper and never touch real data/: tests/helper.js owns the
  sentinel printer queue and the sendRaw patch; never hand-roll createServer() in a
  test (the default dbPath resolves to the real data/shop.db).
- escHtml on every interpolation in public/; 44px touch targets; npm run build:css
  after any utility class change.
- isReleaseShaped(): never write into release/ or publish/. On Program Files installs,
  getBaseDir() routes runtime data and backups into C:\ProgramData\TechPartsPOS; --service
  binds 127.0.0.1 only and returns 400 on POST /api/system/shutdown.
- PRIVATE_SETTINGS keys (sync_token, recovery_password_hash, recovery_locked_until,
  recovery_failed_attempts) must never leave via /api/settings, and POST /api/auth/recovery-password
  keeps its elevated non-default-PIN guard.
- Releases ship Inno Setup 7 TechPartsPOS-Setup-<ver>.exe plus TechPartsPOS.exe and
  TechPartsPOS.exe.sha256 (no portable .zip). The updater version line stays exactly
  `const CURRENT_VERSION = 'x.y';` on one line (scripts/publish-release.ps1 rewrites it by regex).
- vm-slice tests (frontend-regressions, barcode-scan, ui-fixes, cart-recovery,
  audit-regressions, reports-behavior, template-chooser) extract source regions by
  banner comment; if a fix moves or renames such a region, update the extractor in
  tests/ in the same step and re-run the gate.
- Never git --amend (the release pipeline commits mid-session); never commit unless
  the user asks.

OUTPUT PROTOCOL
Per finding: the finding ID, the root cause (not the symptom), the minimal diff, the
regression test with its failing-before and passing-after runs quoted, the gate result
after. Final report: findings fixed, findings deliberately not fixed with why, final
gate numbers.

STOP CONDITIONS
A gate goes red and stays red on rerun; a fix would change behavior the finding did
not cover; the approved list is exhausted; or the tree shows signs of concurrent
interference (see baseline step 3). Report and stop.

TREE STATE (measured 2026-11-12; refresh to observed state on every run)
- HEAD: c8a2751 (on main, 12 commits ahead of origin/main 94d1206; 533f07a plus the v9
  audit batch: report docs/audit-2026-11-12.md, cloud command taxonomy, installer ACLs,
  fractional money display, API_REFERENCE coverage). Full source is tracked in git
  (since 2026-11-07); the release pipeline commits mid-session, so never --amend.
- Gates: npm run build:css exit 0; npm test 614/614 pass, 0 fail, exit 0 across 49 test
  files (all tracked; 610 baseline plus the four audit regression tests).
- Working tree: clean at measurement (`git status --short` empty).
