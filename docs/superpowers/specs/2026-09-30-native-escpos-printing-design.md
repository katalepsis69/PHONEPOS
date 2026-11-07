# Native ESC/POS printing - design

Date: 2026-09-30
Status: awaiting owner review
Decided by: owner, after a physical transport test on the shop printer

## Decision

Counter printing moves from the browser print path to native ESC/POS: the Node
server writes printer commands straight to the queue, bypassing the Windows
driver's page rendering.

Reasons, one line each:

- **Text quality.** The driver rasterizes the page and dithers antialiased edges
  into gray. ESC/POS uses the printer's own font: one dot on or off. Verified on
  paper, see Evidence.
- **Alignment.** A page can be centered by a driver; a character grid cannot.
  Column 0 is always the left edge of the head.
- **Universality.** Driver settings live on one queue on one machine, and this
  product is sold per seat. ESC/POS is a de facto standard that printer clones
  implement.
- **The print dialog disappears.** Owner dropped it deliberately: manual now
  means nothing reaches paper until a click in the receipt modal.

## Scope

In: the four customer-facing slips. Sale receipt, credit settlement receipt,
reprint from Sales history, and the Settings test slip.

Out, staying on the browser path unchanged:

- Z-report and period summary. Wide tables, operator-read, migrate only if asked.
- The on-screen receipt preview. It is a preview, not the print source.
- Bluetooth transport. USB first; Bluetooth is its own change later.
- Cash drawer kick, paper cut, NV logo. This unit has no cutter.

The existing `window.print()` path is **not deleted**. It becomes the fallback,
which costs no new code because it is already written.

## Architecture

```
operator clicks Print in the receipt modal
  -> POST /api/print { kind: 'sale' | 'settlement' | 'test', sale_code? }
     -> server loads the sale from SQLite (never from the client)
        -> renderSlip(data, settings) -> [{ text, wide?, centered? }]
           -> encode(slip) -> bytes
              -> sendRaw(printerName, bytes)
              -> audit(db, actor, elevated, 'print', kind, {...})
  <- { ok, error? }   on error the UI offers the browser path for the same slip
```

Rendering lives server-side for three reasons: the sale is already authoritative
in SQLite, printing survives a dead browser tab, and the printer name never
travels through markup.

`GET /api/printers` returns the queue list for the picker. Those two routes are
the whole new surface.

## Module: src/printer.js

One file, two halves: a pure layout half and a transport half.

- `listPrinters()` -> `{ printers: [{ name, port, driver, isDefault, offline }], error }`,
  where `error` is a non-empty string only when the lookup itself failed. An empty
  `printers` with `error: null` genuinely means "no queues installed", and the picker
  must say those two things differently.
- `renderSlip(data, settings)` -> `[{ text, wide?, centered? }]`, pure, no I/O, no
  control bytes. Each `text` is already laid out to the column budget; the two
  optional flags are the only emphasis the slips actually need, chosen by the
  printer's own capability rather than a styling vocabulary.
- `encode(slip)` -> bytes, internal to the module
- `sendRaw(name, bytes)` -> resolves with `{ ok, error? }` and never rejects, so an
  awaiting route always gets an answer it can show

`encode` is separate from `renderSlip` so the layout can be tested without any
command bytes in the assertions.

## Slip model

Columns come from the existing setting, no new one:

| Roll | Printable | Columns | Double-width chars |
|---|---|---|---|
| 58mm | 48mm | 32 | 16 |
| 80mm | 72mm | 48 | 24 |

Three helpers, all plain string operations:

- `wrap(text, cols)`: word-aware, never splits a word that fits on its own line
- `row(left, right, cols)`: pads so the right operand's last character lands in
  the final column
- `rule(cols)`: `'-'` repeated

Invariants, each with a test:

1. No emitted line exceeds `cols`.
2. `row()` output is exactly `cols` wide when both operands fit.
3. A double-width line never exceeds `cols / 2` characters.

Invariant 3 is not theoretical. The transport test sent a 20-character
double-width banner to a 32-column printer and it wrapped mid-word at exactly 16
characters. Correct behaviour, careless caller.

Money on paper stays `P1,234.56`, which is what it prints today. The screen keeps
the ₱ that `fmtMoney` produces. Encoding is ASCII-only so no clone firmware can
produce mojibake.

ponytail: no per-model capability table. Columns and the absence of a cutter are
the only facts this design depends on, and both hold for the unit in the shop.
Add a profile row the day a second printer model behaves differently.

## Transport and security

`child_process.spawn('powershell.exe', ['-NoProfile','-NonInteractive',
'-EncodedCommand', <base64 UTF-16LE script>])`. The printer name and the base64
payload travel **only as environment variables**. Nothing user-entered is
interpolated into a command line or a script literal.

The original design passed the script on stdin with `-Command -`. That is broken
on Windows PowerShell 5.1: a multi-line `try`/`if` body never completes, so the
script emits nothing and still exits 0, which would have made every print fail
with "PowerShell returned nothing". Verified during Task 2 by piping exactly such
a body. `-EncodedCommand` replaces it and the security property is unchanged.

This matters because the printer name comes from a Settings field, which makes it
an injection surface. Passing it as data closes it by construction.

The script calls `winspool.drv`: `OpenPrinter` -> `StartDocPrinter(datatype RAW)`
-> `StartPagePrinter` -> `WritePrinter` -> `EndPagePrinter` -> `EndDocPrinter` ->
`ClosePrinter`. Proven non-elevated, so no admin prompt and no printer sharing.

ponytail: one PowerShell child process per print job. If job volume ever makes
that a bottleneck, keep one process alive on a named pipe. It is not a bottleneck
at a receipt counter.

## Settings and picker UI

One new editable key, `printer_name`, added to `EDITABLE_SETTINGS` in
`src/settings.js`. It reuses the existing settings GET/POST and the Settings modal's
pattern, so no new plumbing. The `/api/settings` POST validates it against
`listPrinters()` before storing, so a hand-crafted POST cannot save a queue that
does not exist. Validation sits in the route, not `settings.js`, so that module
stays free of child processes.

Settings -> Printing gains a **Printer** select, populated from
`GET /api/printers`, plus a Refresh button, next to the existing Print test
receipt button which now exercises the real path.

States, because a select with no options is a dead control:

- **Loading**: the select is disabled and reads `Detecting printers...`
- **Empty**: `No printers found. Check the cable, then Refresh.` and the browser
  fallback stays offered
- **Error**: the fetch failure text is shown inline, not only as a toast
- Each option label is `POS-58 (USB002, default)` style, and queues reporting
  offline are marked `offline` rather than hidden, because hiding the printer the
  user expects is worse than showing it as offline

If the saved queue is gone at print time, the response says so, the toast says
which name it looked for, and the browser fallback is offered. Never a silent
substitution.

## Failure behaviour

A print failure must never block handing a receipt to a customer.

- `sendRaw` resolves with `{ ok: false, error }` carrying the reason PowerShell or the
  spooler actually gave, translated to words an operator can act on
- The modal's existing Print button switches to the browser path for that same
  slip, so the operator retries with one click and no new control appears
- Every attempt, successful or not, is audited under category `print`

## Testing

- `tests/printer.test.js`: `renderSlip` and `encode` are pure, so tests assert
  exact byte sequences and the three column invariants. No printer required.
- Route tests in the existing style: unauthenticated request refused, unknown
  `sale_code` refused, `printer_name` rejected when not an installed queue.
- One manual hardware check, the throwaway probe promoted into
  `scripts/print-ruler.js`: prints the 32-column ruler slip through the real path
  so any shop machine can be calibrated with one command.

## Rollout

1. Test slip through the new path. Proves the chain with no sale at risk.
2. Sale receipt, including reprint.
3. Credit settlement receipt.
4. Stop and reassess with the owner before touching reports.

## Known unknowns

Deliberately unresolved, each with a cheap way to answer it during
implementation:

- **Peso glyph.** Whether a code page gives a real peso sign. Answer with a
  one-line probe. Default is `P`, which is what ships today.
- **QR.** Hardware QR would replace the printed GCash image. Command variants
  differ across clones; probe before promising it.
- **Dialect variance.** Only POS-58 has been tested. Claims about other models
  are expectations, not results.

## Evidence

From 2026-09-30, on the shop machine:

- `Get-Printer`: `POS-58` on USB002, driver `POS-58 11.3.0.0`, Windows default;
  `Xprinter XP-58` on USB001, `WorkOffline=True`.
- Driver paper form decoded from devmode: `ZPrinter Paper(58 x 3276mm)`, so the
  page is 58mm wide. This is why a 48mm page gets centered and shifts right.
- Driver Device Settings showed `Print Mode: Print as image`, which explains the
  gray. Switching to the printer's font mode produced a beep and blank paper, so
  the driver's font path is broken with this firmware.
- `OpenPrinter` on both queues succeeded from a **non-elevated** process.
- A 186-byte RAW job written to `POS-58` printed and the queue drained with no
  error state. Owner confirmed the text was as crisp as the printer's self-test,
  and that the 20-character double-width banner wrapped at 16 characters.
- Maximum resolution 203 dpi, which is the basis for the 12-dot cell and the
  column counts above.
