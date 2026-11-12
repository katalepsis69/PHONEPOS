# Test Hardening Pass Prompt (v1)

[v1, 2026-11-09. Executes the audit's test-gap category (docs/code-audit-prompt.md).
Boundary rule: consolidation = refactoring (docs/refactoring-prompt.md), deletion =
cleaning (docs/code-cleaning-prompt.md), bug fixes = remediation
(docs/remediation-prompt.md). This pass adds tests ONLY.]

MISSION
Additive tests only, closing behaviors with code but no coverage. Source files in
src/, public/, cloud-deploy/, scripts/, installer/ are READ-ONLY in this pass. A test
that needs a source change becomes a remediation finding instead. That includes a
"tiny helper export": it is still a source change.

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
   reverted or truncated in this tree before. Re-verify a test file before editing it
   if it was read earlier in this run.

WHAT TO ADD (priority order)
1. Money paths: sale totals and change, dual-tier pricing, FIFO utang settlement,
   refund ceilings, shift reconciliation, day close.
2. Data integrity: transactions around multi-statement writes, op_id idempotency on
   every POST, stock guards, FK/UNIQUE constraints rejecting bad rows.
3. Auth: elevation tokens, the factory-PIN refusal on every manager path, lockout,
   session expiry, sync_url validation, Manager Recovery Password (PIN_NAMESPACES.recovery
   15m lockout, /api/auth/recovery-password elevation+non-default gate, /api/auth/recover-pin),
   and PRIVATE_SETTINGS exclusion.
4. Sync: outbox enqueue/ack/backoff, backfillMirror windows, heartbeat, row caps.
5. Printer: 58mm (32-col) and 80mm (48-col) wrap, drawer kick default, plain() ASCII
   dropping, layout versus encode split.
6. RMA caps, license verification (machine id, trial seal, anti-rollback, key
   fallback), the updater's pure parts (version compare, URL resolver, digest rule,
   serviceMode staging/schtasks handoff), i18n en/tl key parity, analytics formulas shared
   with the cloud.
7. Installed service & backup paths: Program Files to C:\ProgramData\TechPartsPOS routing,
   --service loopback binding (127.0.0.1) and shutdown 400 refusal, runtime/server.json
   launcher recovery, GET /api/backup/download integrity and traversal guards, and
   installer/TechPartsPOS.iss task lifecycle assertions.

HARD RULES
- Tests live in tests/*.test.js using node:test and ES modules; no new frameworks, no
  new dependencies, no mocks of node internals.
- Take the scratch env from tests/helper.js: temp-dir databases, the sentinel printer
  queue, the sendRaw patch. NEVER hand-roll createServer() in a test (the default
  dbPath resolves to the real data/shop.db and only the harness patches sendRaw). No
  test may print paper or touch real data/.
- Frontend logic follows the existing vm-slice pattern only where a region already has
  one; do not invent new extraction seams (that would force source edits). The
  static-grep regression pattern in tests/frontend-regressions.test.js is the fair
  fallback.
- Prove each new test asserts real behavior by reading the code path it pins; where
  practical, show the test can fail by inverting its key assertion in a scratch copy
  and reverting.
- A red suite at baseline is a stop condition: report it, fix nothing here.
- Never commit unless the user asks; never git --amend.

OUTPUT PROTOCOL
List tests added (file, the behavior each pins, why the gap mattered), the gate
result, gaps that became written remediation findings (file, line, what the test
needs), and categories judged adequately covered. CLEAN is an honest outcome.

STOP CONDITIONS
The baseline is red; a needed test cannot be written without a source change (write
the remediation finding and move on); the tree shows concurrent interference. Report
and stop.

TREE STATE (measured 2026-11-13; refresh to observed state on every run)
- HEAD: e86e347 (on main, tag v1.1, pushed: origin/main matches): the 2026-11-13
  audit-pass fixes, the refactoring CLEAN record, the dead-i18n deletion, and the
  verify/logout hardening tests). Full source is
  tracked in git (since 2026-11-07); the release pipeline commits mid-session, so
  never --amend.
- Gates: npm run build:css exit 0; npm test 661/661 pass, 0 fail, exit 0 across 55 test
  files (all tracked).
- Working tree: clean at measurement (`git status --short` empty).
