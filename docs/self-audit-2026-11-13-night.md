# Self-audit of the 2026-11-13 night window (b55f517..079c157)

Scoped re-audit of tonight's own commits, per docs/code-audit-prompt.md v9 rules
(report first, standing blanket approval fixes every finding in the same run).
Window: the concurrent session's 2 classifier commits + 5 feature commits
(expenses d926ae7, market doc baee93b, receiving 421888d, badge 270c4e3,
repairs 079c157). Suite measured 656/656 at 079c157.

## Findings

1. **HIGH - Expense double-booking has no idempotency key.** `POST /api/expenses`
   is a money write but `addExpense` accepts no `op_id`, unlike sales, stock
   adjustments, and imports, which all dedup through `op_log`/`op_id`. A
   double-click on the panel's Add button (or a retried request) books the
   same rent twice, and net profit shrinks twice. Fix: accept `op_id`, replay
   through the shared `op_log`, and disable the submit button while in flight.

2. **MEDIUM - Receiving has no idempotency key.** `receiveInventory` never
   passes `op_id` into `adjustStock`, so a retried receive request adds the
   stock twice (oversell protection hides nothing here: stock grows). Fix:
   accept a per-request id, derive per-line ids, pass them through
   `adjustStock`'s existing `meta.op_id`, and have the UI send one.

3. **MEDIUM - Four toasts use a tone the stylesheet does not define.**
   `showToast(..., 'pos')` was used for "Stock received.", "Expense
   recorded.", "Expense removed.", and repairs "Status saved."; ui.js only
   styles `success`/`error`/`warning`/`info`, so these render as unstyled
   toasts. Fix: use `success`.

4. **LOW - Empty customer_name stores an empty string on ticket insert.**
   `cleanField(body,'customer_name') ?? 'Walk-in Customer'` keeps `''` (the
   nullish coalescer does not catch empty strings), unlike the sale path's
   `|| 'Walk-in Customer'`. The queue then shows a blank customer. Fix: use
   `||`.

## Deliberate non-fixes (recorded, not defects)

- **Repair device PII mirrors to the cloud** (device, IMEI, issue_note). Same
  posture as sales rows (customer name/phone already mirror); the 2026-09-27
  redaction contract covered customer_profiles notes only. Documented here;
  revisit only if a shop asks for device-data redaction.
- **`expenses_total` in Z_REQUIRED_KEYS breaks the legacy flat fallback
  shape.** Unreachable: printZReport always receives the `current` shape from
  `/api/dashboard`; the flat branch is vestigial.
- **Expenses list capped at 200 display rows** while totals cover the whole
  window; documented in API_REFERENCE.
- **Two seats upserting the same ref concurrently** can hit the UNIQUE
  constraint (500) in the insert race window. Refs are per-machine time-based;
  at 1-3 seats this is a Future Scale Note, not a finding.
- **Cloud deploy not run.** `npm run deploy:cloud -- <pin>` remains the
  owner's action; the mirror changes ride the next deploy.

## Fixes (same run, each with a test)

- Finding 1: `addExpense` op_id dedup + expense form submit disabled in
  flight; regression test replays the same op_id and asserts one row.
- Finding 2: receive op_id per line through adjustStock; UI sends one;
  regression test replays and asserts stock moves once.
- Finding 3: four toast tones corrected; no behavioral test (visual-only).
- Finding 4: `|| 'Walk-in Customer'`; regression test asserts the default.
