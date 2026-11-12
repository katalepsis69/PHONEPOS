# Feature Batch Pass Prompt (v1)

[v1, 2026-11-09. The build pass: the only pass that adds behavior. It hands off to the
quality passes at the end. Boundary rule: consolidation = refactoring
(docs/refactoring-prompt.md), deletion = cleaning (docs/code-cleaning-prompt.md), bug
fixes = remediation (docs/remediation-prompt.md); a "feature" that is really a bug
fix goes to remediation with a written finding.]

MISSION
Implement the user's requested items as a batch: one item at a time, gate-verified,
invariants held, handed to the standing quality order at the end.

INTAKE DISCIPLINE (before any code)
1. Restate every requested item in one line each, numbered. The restate is the
   contract; if the user's list and the restate differ, they correct it now.
2. Route honest: flag items that are really bug fixes (write a remediation finding),
   really deletions (cleaning pass), or really restructures (refactoring pass). Ask
   before absorbing them into the batch.
3. Ambiguity gets ONE question with the proposed default, up front. Do not stall on
   an answer you can default; state the default and proceed.

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
   reverted or truncated in this tree before. Re-verify any file before editing if it
   was read earlier in this run.

PER-ITEM LOOP
- Build the smallest complete version of the item first (Ponytail ladder: does it
  need to exist; is it already in src/; does Node 22 stdlib cover it; does the native
  platform cover it; shortest working diff; deletion over addition).
- New behavior carries tests in tests/*.test.js (node:test, scratch env from
  tests/helper.js; never hand-roll createServer(); no test can print paper).
- The item lands only with the gates green: npm test at or above the baseline count,
  npm run build:css if any Tailwind class changed.
- Report per item: what changed, files touched, gate result. Then the next item.

INVARIANTS HELD DURING WORK (AGENTS.md, restated as build rules)
- Zero runtime dependencies: node:sqlite, node:http, node:crypto, node:fs, node:test
  only; devDependencies stay @tailwindcss/cli and postject.
- Frontend is vanilla JS in public/: no React/Vue/Electron; escHtml on every
  interpolation; 44px touch targets; keyboard-first shortcuts and barcode autofocus;
  tabular money figures; no AI aesthetic (no purple glows, no buzzwords, no
  decorative emojis in UI headings, no sluggish animations).
- Money: integer cents through money(); REAL money columns; dual-tier pricing
  (walk-in vs technician); FIFO utang liquidation.
- SQL: prepared statements (db.prepare); one transaction per multi-statement write;
  WAL, foreign_keys ON, busy_timeout; guard SQLITE_BUSY and Windows EBUSY/EPERM.
- Printing: ESC/POS bytes in src/printer.js, 58mm (32-col) and 80mm (48-col)
  auto-wrap, drawer kick, browser print fallback when the queue is unavailable; never
  send a cut command.
- New manager-facing routes: session plus elevation plus factory-PIN refusal where
  existing sensitive routes have it; an audit row for state-changing actions.
- isReleaseShaped(): never write into release/ or publish/. Program Files installs route
  runtime data to C:\ProgramData\TechPartsPOS; releases ship Inno Setup 7
  TechPartsPOS-Setup-<ver>.exe plus TechPartsPOS.exe and .sha256 (never portable .zip).
- vm-slice test regions (banner-comment extraction in tests/) stay intact, or their
  extractors are updated in the same step and the gate re-run.
- Never git --amend (the release pipeline commits mid-session); never commit unless
  the user asks.

HANDOFF (end of batch)
The batch is not done at the last item. Close by pointing at the standing quality
order through the dispatcher skill (.agents/skills/techparts-pass/SKILL.md): audit
first, then remediation on approved findings, then refactoring, cleaning and test
hardening as the user directs. Final report: items landed, gate numbers, known gaps,
suggested first audit focus.

STOP CONDITIONS
A gate stays red on rerun; an item turns out to need a dependency or a framework
(refuse: that violates the core invariants; propose the stdlib version); the tree
shows concurrent interference. Report and stop.

TREE STATE (measured 2026-11-13; refresh to observed state on every run)
- HEAD: e86e347 (on main, tag v1.1, pushed: origin/main matches); the 2026-11-12
  full order, the official v1.0/v1.1 releases, and the 2026-11-13 five-pass night landed
  before this measurement). Full source is
  tracked in git (since 2026-11-07); the release pipeline commits mid-session, so
  never --amend.
- Gates: npm run build:css exit 0; npm test 661/661 pass, 0 fail, exit 0 across 55 test
  files (all tracked).
- Working tree: clean at measurement (`git status --short` empty).
