---
name: techparts-pass
description: "Single entry point for the six standing quality passes. Routes one word to its prompt in docs/: audit, remediation (fix findings), refactoring, cleaning (dead code/debris), test hardening, feature batch, or the full pipeline in the standing order. Use when the user asks to audit, fix findings, clean, refactor, add tests, run a batch, or run everything."
---

# techparts-pass

Router for the six standing passes. This skill holds NO rules of its own: each
pass is governed by its prompt file in `docs/`, and that file is read and
followed EXACTLY as written. Never run a pass from memory of its prompt; read
the file at dispatch time. Any qualifiers in the invocation (finding numbers,
item lists, file scopes) pass through to the pass verbatim.

## Dispatch table (match the user's word; ask when a word maps to two)

| User says | Pass | Prompt file |
|---|---|---|
| audit, find problems, check the code, review pass | Audit | `docs/code-audit-prompt.md` |
| fix findings, remediate, apply fixes (+ finding numbers) | Remediation | `docs/remediation-prompt.md` |
| refactor, restructure, split files, extract | Refactoring | `docs/refactoring-prompt.md` |
| clean, delete dead code, remove debris, scrub | Cleaning | `docs/code-cleaning-prompt.md` |
| add tests, harden, close coverage gaps | Test hardening | `docs/test-hardening-prompt.md` |
| batch, implement these items (+ item list) | Feature batch | `docs/feature-batch-prompt.md` |
| full, pipeline, everything, the whole order | Standing order below | all six, in order |

Ambiguous words get ONE question with the two candidate passes before
anything starts ("clean up the code" could be cleaning or refactoring).

## Standing order (full pipeline)

Run the project-instruction pass order: audit -> remediation -> refactoring ->
cleaning -> test hardening. A feature batch joins only at the front, and only
when the user supplies items to build. Hard boundaries between passes:
- The audit pass STOPS at its report. Nothing is fixed until the user approves
  specific numbered findings. (This project's audit prompt records a standing
  blanket-approval workflow; the audit prompt itself governs, not this line.)
- Remediation fixes only the approved numbers, one at a time, gates after each.
- Refactoring and cleaning each WAIT for approval of their PHASE 1 proposal
  lists before touching anything.
- Test hardening adds tests only; source stays read-only in that pass.
- Each pass reads its own prompt and runs its own baseline ritual before its
  first change. Never fold two passes into one stretch of work.

## Rules that hold in every dispatch

- Read the named prompt first; its STOP conditions and output protocol govern.
- Gates before any change: `npm run build:css` exits 0 (regenerates
  public/tailwind.build.css after any Tailwind class change), and `npm test`
  (node --test tests/*.test.js) passes at the recorded baseline with exit 0
  (536/536 measured 2026-11-09, about 22 s; a hang is a rerun, not a
  regression). Each pass's baseline ritual re-measures and records the count.
- Never commit unless the user asks.
- Zero em dashes in any report.
- If a prompt's tree-state block is stale (HEAD, counts, dirty files), update
  the block to today's observed state before running, and say so in one line.
  Prompts that carry measured-gate sections instead of the compact block
  (docs/code-audit-prompt.md, docs/refactoring-prompt.md) get their numbers
  re-measured against the same rule at run time.
