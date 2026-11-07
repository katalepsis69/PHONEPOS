# Native ESC/POS Printing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route the four customer-facing counter slips through native ESC/POS written straight to the printer queue by the Node server, keeping the browser print path as an explicit fallback.

**Architecture:** `src/printer.js` owns a pure column model (`renderSlip` -> line records -> `encode` -> bytes) plus a winspool transport driven through PowerShell. The browser stops rendering receipts for the printer; it POSTs a job kind and an id, and the server loads the sale from SQLite, lays out the slip, and writes bytes.

**Tech Stack:** Node 22.5+ stdlib only (`node:http`, `node:sqlite`, `node:child_process`), vanilla ESM frontend, `node --test`, Windows SEA build.

**Spec:** `docs/superpowers/specs/2026-09-30-native-escpos-printing-design.md`

## Global Constraints

- Zero runtime dependencies. `devDependencies` stay `@tailwindcss/cli` and `postject` only. No npm install in any task.
- Node `>=22.5.0` (`package.json` engines). No syntax newer than the shipped V8.
- Windows-only for the transport path. Every other module stays platform-neutral.
- The offline sale path is untouchable: a failed print must never block or roll back a completed sale.
- Printer bytes are ASCII printable only (`0x20`-`0x7e` plus LF). No high-bit bytes.
- Columns come from `receipt_paper_width`: `58mm` -> 32, `80mm` -> 48. No new capability setting.
- User-facing copy has no em dashes. Money on paper is `P1,234.56`.
- **No git in this repository.** Each task ends with the full suite green instead of a commit. Do not `git init` to make a step work.
- **Automated tests must never reach `sendRaw`.** This development machine is the shop printer, so every test asserts on pure functions or on route branches that return before the send. Hardware checks are explicit manual steps.

## File Structure

| File | Responsibility |
|---|---|
| Create `src/printer.js` | Column model, line builders, slip renderers, ESC/POS encoder, winspool transport, queue enumeration |
| Create `tests/printer.test.js` | Byte-exact encoder tests, column invariants, transport-job safety |
| Modify `src/server.js` | Require printer module; `GET /api/printers`, `POST /api/print` |
| Modify `src/settings.js:17-21` | Add `printer_name` to `EDITABLE_SETTINGS` |
| Modify `public/js/receipts.js` | `printSlip()` helper; test slip and reprint go through it |
| Modify `public/js/views/pos.js:1264` | Auto-print branch uses `printSlip` |
| Modify `public/js/views/backoffice.js:625,785` | Settlement and reprint branches use `printSlip` |
| Modify `public/index.html:1315-1322` | Printer picker field with its three states |
| Modify `public/js/auth.js:541,592` | Populate picker on open; include `printer_name` on save |
| Modify `public/js/main.js:237-256` | `refresh-printers` action |
| Modify `README.md:15`, `docs/OPERATIONS_AND_DEPLOYMENT.md:28` | Correct the "no raw ESC/POS" claim |

---

### Task 1: Column model and encoder

**Files:**
- Create: `src/printer.js`
- Test: `tests/printer.test.js`

**Interfaces:**
- Consumes: nothing
- Produces: `colsFor(paperWidth) -> number`, `wrap(value, cols) -> string[]`, `row(label, value, cols) -> string`, `rule(cols) -> string`, `encode(lines) -> Buffer` where lines are `[{ text, wide?, centered? }]`, `renderTestSlip(settings) -> lines`

- [ ] **Step 1: Write the failing tests**

Create `tests/printer.test.js`:

```js
const assert = require('node:assert/strict');
const test = require('node:test');
const { colsFor, wrap, row, rule, encode, renderTestSlip, localStamp } = require('../src/printer');

test('columns follow the roll width, defaulting to 80mm', () => {
  assert.equal(colsFor('58mm'), 32);
  assert.equal(colsFor('80mm'), 48);
  assert.equal(colsFor(undefined), 48);
});

test('wrap breaks at spaces and keeps every word', () => {
  const src = 'Physical crack, flex tear, water damage voids warranty.';
  const lines = wrap(src, 32);
  assert.ok(lines.every(l => l.length <= 32));
  assert.equal(lines.join(' '), src);
});

test('wrap hard-breaks a word longer than the roll', () => {
  assert.deepEqual(wrap('ABCDEFGHIJKLMNOPQRSTUVWX YZ', 20), ['ABCDEFGHIJKLMNOPQRST', 'UVWX YZ']);
});

test('row pads so the value ends in the final column', () => {
  const r = row('Subtotal', 'P1,250.00', 32);
  assert.equal(r.length, 32);
  assert.ok(r.startsWith('Subtotal'));
  assert.ok(r.endsWith('P1,250.00'));
});

test('row truncates the label and never the value', () => {
  const r = row('Warranty valid until this date for the item listed', 'P12,345.67', 32);
  assert.equal(r.length, 32);
  assert.ok(r.endsWith('P12,345.67'));
});

test('encode emits init, one LF per line, then a three-line feed', () => {
  assert.deepEqual([...encode([{ text: 'AB' }])], [0x1b, 0x40, 0x41, 0x42, 0x0a, 0x1b, 0x64, 0x03]);
});

test('encode brackets a wide centered line with its own commands', () => {
  assert.deepEqual([...encode([{ text: 'AB', wide: true, centered: true }])], [
    0x1b, 0x40,
    0x1b, 0x61, 0x01, 0x1d, 0x21, 0x11,
    0x41, 0x42, 0x0a,
    0x1d, 0x21, 0x00, 0x1b, 0x61, 0x00,
    0x1b, 0x64, 0x03,
  ]);
});

test('a 58mm slip never exceeds its column budget', () => {
  const slip = renderTestSlip({
    receipt_paper_width: '58mm',
    gcash_name: 'TECHPARTS REPAIR & POS',
    shop_address: 'Rizal Street, Cabanatuan City, Nueva Ecija',
    gcash_number: '0917-123-4567',
  });
  for (const line of slip) {
    const budget = line.wide ? 16 : 32;
    assert.ok(line.text.length <= budget, `over ${budget}: ${JSON.stringify(line.text)}`);
  }
});

test('nothing but printable ASCII reaches the printer', () => {
  const slip = renderTestSlip({ receipt_paper_width: '58mm', gcash_name: 'Shop ✓ “₱”' });
  for (const line of slip) assert.match(line.text, /^[\x20-\x7e]*$/);
});

test('the slip stamp is shop time, not a UTC slice', () => {
  const slip = renderTestSlip({ receipt_paper_width: '58mm' });
  const stamp = slip.find((l) => /^\d{4}-\d{2}-\d{2} /.test(l.text)).text;
  assert.equal(stamp.slice(0, 13), localStamp().slice(0, 13));
});

test('a name of only unsupported characters still prints a header', () => {
  const slip = renderTestSlip({ receipt_paper_width: '58mm', gcash_name: '“₱”' });
  assert.equal(slip[0].text, 'TECHPARTS POS');
  assert.equal(slip[0].wide, true);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/printer.test.js`
Expected: FAIL, `Cannot find module '../src/printer'`

- [ ] **Step 3: Write the column model and encoder**

Create `src/printer.js`:

```js
// ESC/POS counter printing. Layout is pure and byte output is isolated so both
// can be tested with no printer attached.
const COLUMNS_BY_ROLL = { '58mm': 32, '80mm': 48 };

function colsFor(paperWidth) {
  return COLUMNS_BY_ROLL[paperWidth] || COLUMNS_BY_ROLL['80mm'];
}

// Thermal clones disagree about high-bit code pages, so anything outside
// printable ASCII is dropped rather than risked as mojibake.
function plain(value) {
  return String(value ?? '').replace(/[^\x20-\x7e]/g, '');
}

// Shop time, always. The audit rows and SQLite store UTC, so a slice of
// toISOString() prints a receipt eight hours behind the counter clock and can
// push a warranty expiry onto the wrong day. src/reconcile.js documents the
// same trap.
function localStamp(value) {
  const d = value ? new Date(value) : new Date();
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function localDate(value) {
  return localStamp(value).slice(0, 10);
}

// Word-aware: a word that fits a line of its own is never split. Only a single
// word wider than the roll is hard-broken, which is what the while loop is for.
function wrap(value, cols) {
  const lines = [];
  let line = '';
  for (const word of plain(value).split(/\s+/).filter(Boolean)) {
    if (line && `${line} ${word}`.length > cols) {
      lines.push(line);
      line = '';
    }
    line = line ? `${line} ${word}` : word;
    while (line.length > cols) {
      lines.push(line.slice(0, cols));
      line = line.slice(cols);
    }
  }
  if (line) lines.push(line);
  return lines;
}

function row(label, value, cols) {
  const right = plain(value);
  if (right.length >= cols) return right.slice(0, cols);
  const head = plain(label).slice(0, Math.max(1, cols - right.length - 1));
  return head + ' '.repeat(cols - head.length - right.length) + right;
}

function rule(cols) {
  return '-'.repeat(cols);
}

// plain() can empty a name made entirely of unsupported characters, which would
// print a blank header instead of falling back.
function nameLines(value, budget) {
  const lines = wrap(value || '', budget);
  return lines.length ? lines : wrap('TECHPARTS POS', budget);
}

function ruler(cols) {
  return Array.from({ length: cols }, (_, i) => (i + 1) % 10).join('');
}

function encode(lines) {
  const out = [0x1b, 0x40]; // ESC @ initialize
  for (const line of lines) {
    if (line.centered) out.push(0x1b, 0x61, 0x01);
    if (line.wide) out.push(0x1d, 0x21, 0x11); // GS ! double width + height
    out.push(...Buffer.from(plain(line.text), 'ascii'), 0x0a);
    if (line.wide) out.push(0x1d, 0x21, 0x00);
    if (line.centered) out.push(0x1b, 0x61, 0x00);
  }
  out.push(0x1b, 0x64, 0x03); // ESC d 3 print and feed
  return Buffer.from(out);
}

function renderTestSlip(settings) {
  const cols = colsFor(settings.receipt_paper_width);
  const slip = [];
  const push = (text, opts) => slip.push({ text, ...opts });
  for (const line of nameLines(settings.gcash_name, Math.floor(cols / 2))) {
    push(line, { wide: true, centered: true });
  }
  push('TEST RECEIPT', { centered: true });
  push(localStamp());
  push(rule(cols));
  push('<' + '-'.repeat(cols - 2) + '>');
  push(ruler(cols));
  push('ABCDEFGHIJKLMNOPQRSTUVWXYZ012345'.slice(0, cols));
  push(row('Sample row:', 'P1,234.56', cols));
  push(ruler(cols));
  push('<' + '-'.repeat(cols - 2) + '>');
  push(rule(cols));
  for (const line of wrap('If both ruler lines touch both edges, the width matches the roll.', cols)) push(line);
  push('*** Test only, not a receipt ***', { centered: true });
  return slip;
}

module.exports = { colsFor, plain, localStamp, localDate, wrap, nameLines, row, rule, ruler, encode, renderTestSlip };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/printer.test.js`
Expected: PASS, 11 tests

- [ ] **Step 5: Verify the whole suite is still green**

Run: `npm test`
Expected: `pass 285`, `fail 0` (274 existing + 11 new)

---

### Task 2: Winspool transport and queue enumeration

**Files:**
- Modify: `src/printer.js` (append)
- Test: `tests/printer.test.js` (append)

**Interfaces:**
- Consumes: `encode(lines)` from Task 1
- Produces: `buildSendJob(printerName, bytes) -> { args, env, script }`, `parseSendResult(stdout) -> { ok, error? }`, `parsePrinters(stdout) -> [{ name, port, driver, isDefault, offline }]`, `parsePrinterLookup(stdout, transportError) -> { printers, error }`, `sendRaw(name, bytes) -> Promise<{ok, error?}>` (never rejects), `listPrinters() -> Promise<{ printers, error }>`, `defaultPrinter(rows) -> name`

- [ ] **Step 1: Write the failing tests**

Append to `tests/printer.test.js`:

```js
const { buildSendJob, parseSendResult, parsePrinters, defaultPrinter } = require('../src/printer');

test('the printer name never reaches the command line', () => {
  const evil = `X"; Remove-Item C:\\ -Recurse; #`;
  const job = buildSendJob(evil, Buffer.from('hello'));
  assert.ok(!JSON.stringify(job.args).includes(evil));
  assert.ok(!job.script.includes(evil));
  assert.equal(job.env.TP_PRINTER, evil);
  assert.equal(Buffer.from(job.env.TP_PAYLOAD, 'base64').toString(), 'hello');
});

test('send result parsing covers success and both failure shapes', () => {
  assert.deepEqual(parseSendResult('{"ok":true}'), { ok: true });
  assert.deepEqual(parseSendResult('{"ok":false,"error":"no queue"}'), { ok: false, error: 'no queue' });
  assert.deepEqual(parseSendResult('boom\nnot json'), { ok: false, error: 'not json' });
});

test('printer rows parse one object or a list, and keep offline queues', () => {
  const one = parsePrinters('{"Name":"POS-58","PortName":"USB002","DriverName":"POS-58","Default":true,"WorkOffline":false}');
  assert.deepEqual(one, [{ name: 'POS-58', port: 'USB002', driver: 'POS-58', isDefault: true, offline: false }]);
  const many = parsePrinters('[{"Name":"A","WorkOffline":true},{"Name":"B","WorkOffline":false}]');
  assert.deepEqual(many.map(p => p.name), ['A', 'B']);
  assert.equal(many[0].offline, true);
});

test('parsing an empty or garbage listing yields no printers, not a throw', () => {
  assert.deepEqual(parsePrinters(''), []);
  assert.deepEqual(parsePrinters('ConvertTo-Json exploded'), []);
});

test('defaultPrinter prefers the flagged queue, then the first online one', () => {
  const rows = [{ name: 'X', offline: true, isDefault: false }, { name: 'Y', offline: false, isDefault: false }];
  assert.equal(defaultPrinter(rows), 'Y');
  assert.equal(defaultPrinter([]), null);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/printer.test.js`
Expected: FAIL, `buildSendJob is not a function`

- [ ] **Step 3: Implement the transport**

Append to `src/printer.js`, above `module.exports`, and add the new names to that export list:

```js
const { spawn } = require('node:child_process');

// Data reaches PowerShell only through env vars. Nothing user-entered is
// interpolated into a command line or a script literal, which is what keeps a
// Settings-supplied queue name from ever becoming code.
const SEND_SCRIPT = `$ErrorActionPreference = 'Stop'
$sig = @'
using System;
using System.Runtime.InteropServices;
public class W {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct D { public string n; public IntPtr f; public string t; }
  [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool OpenPrinter(string n, out IntPtr h, IntPtr z);
  [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool StartDocPrinter(IntPtr h, int l, ref D d);
  [DllImport("winspool.drv", SetLastError = true)]
  public static extern bool StartPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)]
  public static extern bool WritePrinter(IntPtr h, byte[] b, int c, out int w);
  [DllImport("winspool.drv", SetLastError = true)]
  public static extern bool EndPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)]
  public static extern bool EndDocPrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)]
  public static extern bool ClosePrinter(IntPtr h);
}
'@
Add-Type -TypeDefinition $sig
$b = [Convert]::FromBase64String($env:TP_PAYLOAD)
$h = [IntPtr]::Zero
if (-not [W]::OpenPrinter($env:TP_PRINTER, [ref]$h, [IntPtr]::Zero)) {
  ConvertTo-Json -Compress -InputObject @{ ok = $false; error = 'the printer queue could not be opened' }
  exit
}
$d = New-Object W+D
$d.n = $env:TP_DOC
$d.f = [IntPtr]::Zero
$d.t = 'RAW'
if (-not [W]::StartDocPrinter($h, 1, [ref]$d)) {
  [void][W]::ClosePrinter($h)
  ConvertTo-Json -Compress -InputObject @{ ok = $false; error = 'the print job could not be started' }
  exit
}
[void][W]::StartPagePrinter($h)
$w = 0
$ok = [W]::WritePrinter($h, $b, $b.Length, [ref]$w)
[void][W]::EndPagePrinter($h)
[void][W]::EndDocPrinter($h)
[void][W]::ClosePrinter($h)
if ($ok -and $w -eq $b.Length) {
  ConvertTo-Json -Compress -InputObject @{ ok = $true }
} else {
  ConvertTo-Json -Compress -InputObject @{ ok = $false; error = ('the printer took only ' + $w + ' of ' + $b.Length + ' bytes') }
}`;

const LIST_SCRIPT = `$ErrorActionPreference = 'Stop'
try {
  Get-CimInstance Win32_Printer |
    Select-Object Name,PortName,DriverName,Default,WorkOffline |
    ConvertTo-Json -Compress
} catch { '' }`;

function runPowerShell(script, env) {
  return new Promise((resolve) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '-'], {
      env: { ...process.env, ...env },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.on('error', () => resolve(''));
    child.on('close', () => resolve(out.trim()));
    // The script is delivered via -EncodedCommand in argv, not stdin: see R20.
  });
}

function buildSendJob(printerName, bytes) {
  return {
    args: ['-NoProfile', '-NonInteractive', '-Command', '-'],
    env: {
      TP_PRINTER: String(printerName),
      TP_DOC: 'TechParts POS',
      TP_PAYLOAD: Buffer.from(bytes).toString('base64'),
    },
    script: SEND_SCRIPT,
  };
}

function parseSendResult(stdout) {
  const line = String(stdout).trim().split('\n').pop() || '';
  try {
    const parsed = JSON.parse(line);
    return parsed.ok ? { ok: true } : { ok: false, error: String(parsed.error || 'the printer refused the job') };
  } catch {
    return { ok: false, error: line.slice(0, 200) || 'PowerShell returned nothing' };
  }
}

function parsePrinters(stdout) {
  const raw = String(stdout).trim();
  if (!raw) return [];
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return []; }
  return (Array.isArray(parsed) ? parsed : [parsed]).map((p) => ({
    name: String(p.Name ?? ''),
    port: String(p.PortName ?? ''),
    driver: String(p.DriverName ?? ''),
    isDefault: p.Default === true,
    offline: p.WorkOffline === true,
  })).filter((p) => p.name);
}

function defaultPrinter(rows) {
  return (rows.find((r) => r.isDefault) || rows.find((r) => !r.offline) || {}).name || null;
}

async function sendRaw(printerName, bytes) {
  const job = buildSendJob(printerName, bytes);
  return parseSendResult(await runPowerShell(job.script, job.env));
}

async function listPrinters() {
  return parsePrinters(await runPowerShell(LIST_SCRIPT, {}));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/printer.test.js`
Expected: PASS, 16 tests

- [ ] **Step 5: Verify the transport against real hardware**

Run: `node -e "const p=require('./src/printer');p.listPrinters().then(async ({printers, error})=>{console.log({printers, error});if(error)return;const s=p.renderTestSlip({receipt_paper_width:'58mm',gcash_name:'TECHPARTS'});console.log(await p.sendRaw(p.defaultPrinter(printers),p.encode(s)))})"`
Expected: the `POS-58` row listed, `{ ok: true }` printed, and a 32-column ruler slip on paper with both `<` and `>` visible. If a marker is missing, stop and report the paper: the column model is right but the roll assumption is not.

- [ ] **Step 6: Verify the whole suite is still green**

Run: `npm test`
Expected: `pass 290`, `fail 0`

#### Amendments after implementation (Task 2)

The transport as originally briefed did not work and was replaced during
implementation. The spec's "Transport and security" section is the authority.

- **R20 - `-EncodedCommand`, not stdin.** `-Command -` silently yields empty output for
  multi-line bodies on PowerShell 5.1, so as briefed every print would have failed with
  "PowerShell returned nothing". Data still moves only through env vars.
- **R21 - `runPowerShell` must be bounded.** A hung spooler would stall the HTTP route that
  awaits it, and the counter would sit on a spinner. Add a timeout that kills the child and
  resolves with empty output, so callers get the ordinary failure path.
- **R22 - "no printers" and "PowerShell is broken" must not look the same.** `listPrinters()`
  returning `[]` is ambiguous, and Task 4's copy is required to fall back *loudly*. Change the
  return to `{ printers, error }`, where `error` is a non-empty string only when the lookup
  itself failed. Task 4 consumes this shape.
- **R23 - never default to an offline queue.** `defaultPrinter()` preferred the Windows default
  even when it reported offline. Prefer an online default, then any online queue, then the
  default as a last resort, because sending to a dead queue is indistinguishable from a
  successful print at this layer.

---

### Task 3: `printer_name` setting and the two routes

**Files:**
- Modify: `src/settings.js:17-21`
- Modify: `src/server.js:53` (require), `src/server.js:663` (insert routes after the settings POST)
- Test: `tests/printer.test.js` (append route tests via the existing `serverTest` helper)

**Interfaces:**
- Consumes: `listPrinters`, `defaultPrinter`, `encode`, `renderTestSlip`, `sendRaw` from Tasks 1-2; `getShopSettings`, `updateShopSettings`, `audit`, `getSaleDetails`
- Produces: `GET /api/printers -> { printers: [...] }`, `POST /api/print { kind, sale_id? } -> { ok, error?, fallback: true }`, setting key `printer_name`

- [ ] **Step 1: Write the failing route tests**

Append to `tests/printer.test.js`:

```js
const { serverTest } = require('./helper');

serverTest('GET /api/printers needs a session', async (baseUrl) => {
  const res = await fetch(`${baseUrl}/api/printers`);
  assert.equal(res.status, 401);
});

serverTest('POST /api/print rejects an unknown kind', async (baseUrl, db, auth) => {
  const res = await fetch(`${baseUrl}/api/print`, {
    method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'everything' }),
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /Unknown print job/);
});

serverTest('POST /api/print rejects a sale that does not exist', async (baseUrl, db, auth) => {
  const res = await fetch(`${baseUrl}/api/print`, {
    method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'sale', sale_id: 999999 }),
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /not found/);
});

serverTest('printer_name refuses a queue that is not installed', async (baseUrl, db, auth) => {
  const res = await fetch(`${baseUrl}/api/settings`, {
    method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ printer_name: 'Not A Real Printer' }),
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /Not A Real Printer/);
  assert.equal(db.prepare("SELECT value FROM shop_settings WHERE key='printer_name'").get(), undefined);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/printer.test.js`
Expected: FAIL, 404 on `/api/printers` and the settings POST accepted

- [ ] **Step 3: Accept the setting**

In `src/settings.js`, extend the allowlist:

```js
const EDITABLE_SETTINGS = new Set([
  'gcash_name', 'gcash_number', 'gcash_qr_url', 'receipt_paper_width', 'printer_name',
  'warranty_days', 'warranty_policy_text', 'shop_footer_note',
  'owner_name', 'shop_address', 'settle_elevation_threshold'
]);
```

- [ ] **Step 4: Wire the module and the routes**

In `src/server.js`, add next to the other module requires (after line 53):

```js
const { listPrinters, defaultPrinter, sendRaw, encode, renderTestSlip, renderSaleSlip } = require('./printer');
```

Insert after the `/api/settings` POST block:

```js
        // PRINTING (ESC/POS). The browser never lays out a printed slip: the
        // server loads the sale from SQLite so a dead tab cannot corrupt one.
        // The catch mirrors the 400 style at src/server.js:892; an uncaught
        // throw here would surface as a 500 and a generic message.
        if (pathname === '/api/printers' && method === 'GET') {
          const { printers, error } = await listPrinters();
          return sendJson(res, error ? 502 : 200, error ? { error } : { printers });
        }

        if (pathname === '/api/print' && method === 'POST') {
          const body = await parseBody(req);
          const settings = getShopSettings(db);
          const kind = String(body.kind || '');
          try {
            let slip;
            if (kind === 'test') {
              slip = renderTestSlip(settings);
            } else if (kind === 'sale') {
              const sale = getSaleDetails(db, Number(body.sale_id));
              if (!sale) throw new Error('Sale not found');
              slip = renderSaleSlip(sale, settings);
            } else {
              throw new Error(`Unknown print job '${kind}'`);
            }
            const { printers } = await listPrinters();
            const target = settings.printer_name || defaultPrinter(printers);
            if (!target) throw new Error('No printer found. Check the cable, then Refresh in Settings.');
            const result = await sendRaw(target, encode(slip));
            audit(db, session, false, 'print', kind, { printer: target, ...result });
            return sendJson(res, 200, { ...result, fallback: !result.ok });
          } catch (err) {
            audit(db, session, false, 'print', kind || 'unknown', { ok: false, error: err.message });
            return sendJson(res, 400, { error: err.message, fallback: true });
          }
        }
```

Note the shape the client relies on: a rejected job answers **400 with `fallback: true`**, and a job the printer refused answers **200 with `ok: false, fallback: true`**. `printSlip` in Task 5 treats both the same way.

Validate `printer_name` at save time inside the existing `/api/settings` POST, before `txn`:

```js
          if (typeof body.printer_name === 'string' && body.printer_name) {
            const { printers: known } = await listPrinters();
            if (!known.some((p) => p.name === body.printer_name)) {
              return sendJson(res, 400, { error: `Printer '${body.printer_name}' is not installed on this machine` });
            }
          }
```

- [ ] **Step 5: Add the sale renderer**

Append to `src/printer.js` and export it. `renderSaleSlip` mirrors what the HTML receipt carries, in the same order:

```js
function money(n) {
  return 'P' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function renderSaleSlip(sale, settings) {
  const cols = colsFor(settings.receipt_paper_width);
  const slip = [];
  const push = (text, opts) => slip.push({ text, ...opts });
  const lines = (v, wide) => wrap(v, wide ? Math.floor(cols / 2) : cols).forEach((t) => push(t, wide ? { wide: true, centered: true } : {}));
  for (const line of nameLines(settings.gcash_name, Math.floor(cols / 2))) push(line, { wide: true, centered: true });
  lines(settings.shop_address || 'Phone Parts, LCDs & Repair Service');
  lines(`Tel/GCash: ${settings.gcash_number || ''}`);
  push(rule(cols));
  push('OFFICIAL RECEIPT', { centered: true });
  push(`Invoice #: ${sale.sale_code}`);
  push(`Date: ${localStamp(sale.created_at)}`);
  push(row('Customer:', sale.customer_name, cols));
  if (sale.customer_phone) push(row('Phone:', sale.customer_phone, cols));
  push(row('Payment:', `${String(sale.payment_method || '').toUpperCase()} ${(sale.payment_reference || '').trim()}`, cols));
  push(rule(cols));
  for (const item of sale.items || []) {
    for (const name of wrap(`${item.item_type === 'labor' ? '[LABOR] ' : ''}${item.item_name}`, cols)) push(name);
    push(row(`  ${item.quantity} x ${money(item.unit_price)}`, money(item.total_price), cols));
  }
  push(rule(cols));
  push(row('Subtotal:', money(sale.subtotal), cols));
  if (Number(sale.discount) > 0) push(row('Discount:', '-' + money(sale.discount), cols));
  push(row('TOTAL DUE:', money(sale.total_amount), cols));
  push(row('Amount Paid:', money(sale.amount_paid), cols));
  if (Number(sale.change_amount) > 0) push(row('CHANGE:', money(sale.change_amount), cols));
  if (Number(sale.credit_balance) > 0) push(row('BALANCE (UTANG):', money(sale.credit_balance), cols));
  push(rule(cols));
  push(`WARRANTY (${plain(settings.warranty_days) || '7'} DAYS):`, { centered: true });
  for (const line of wrap(settings.warranty_policy_text, cols)) push(line);
  push(`Valid Until: ${calculateWarrantyExpiry(sale.created_at, settings.warranty_days)}`);
  push(plain(settings.shop_footer_note || '*** Thank you for your business! ***'), { centered: true });
  return slip;
}

function calculateWarrantyExpiry(created, days) {
  const d = new Date(created || Date.now());
  if (Number.isNaN(d.getTime())) return '--';
  d.setDate(d.getDate() + (Number(days) || 0));
  return localDate(d);
}
```

> As shipped: the `lines(v, wide)` helper in this snippet, and in the Task 6 settlement snippet, is only ever called with one argument, for the shop address and the `Tel/GCash:` line. Its `wide` branch is dead in the module that landed; the double-width lines come from the `nameLines` loop above it. Two more deltas from Task 7, both in the shipped file rather than here: `money()` now refuses an amount that is not a finite number instead of printing `PNaN`, and the footer line is framed as `*** note ***` and wrapped, the way the screen frames it. The snippets are left as planned rather than rewritten, and `src/printer.js` is the reference.

- [ ] **Step 6: Run tests to verify they pass**

Run: `node --test tests/printer.test.js`
Expected: PASS. The `kind: 'sale'` happy path is exercised in Task 5; here only the guards run.

- [ ] **Step 7: Verify the whole suite is still green**

Run: `npm test`
Expected: `pass 292+`, `fail 0`

---

### Task 4: Printer picker in Settings

**Files:**
- Modify: `public/index.html:1315-1322`
- Modify: `public/js/auth.js:541` (populate on open), `:592` (include on save)
- Modify: `public/js/main.js:237-256` (refresh action)
- Test: `tests/ui-fixes.test.js` (append source assertions, matching that file's existing style)

**Interfaces:**
- Consumes: `GET /api/printers` from Task 3; the settings POST's `printer_name` validation
- Produces: `#settings-printer` select, `loadPrinters()` in `auth.js`, `refresh-printers` action

- [ ] **Step 1: Write the failing assertions**

Append to `tests/ui-fixes.test.js`:

```js
test('the printer picker lists queues and says so when there are none', () => {
  const index = source('public/index.html');
  const auth = source('public/js/auth.js');
  assert.match(index, /id="settings-printer"/);
  assert.match(index, /data-action="refresh-printers"/);
  assert.match(auth, /fetch\('\/api\/printers'\)/);
  assert.match(auth, /No printers found/);
  assert.match(auth, /Detecting printers/);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/ui-fixes.test.js`
Expected: FAIL on `id="settings-printer"`

- [ ] **Step 3: Add the field**

In `public/index.html`, insert above the `Thermal printer width` field:

```html
              <div class="field">
                <label class="field__label" for="settings-printer">Receipt printer</label>
                <select id="settings-printer" class="w-full px-3 py-1.5 text-xs" disabled>
                  <option value="">Detecting printers...</option>
                </select>
                <p id="settings-printer-note" class="foot-note" role="status"></p>
                <button type="button" class="btn-mini mt-1" data-action="refresh-printers">Refresh list</button>
                <p class="foot-note">Receipts print straight to this queue, no dialog. If nothing is listed,
                  check the cable and click Refresh.</p>
              </div>
```

- [ ] **Step 4: Populate it, with all three states**

In `public/js/auth.js`, add the loader and call it from `openSettingsModal` next to the existing auto-print mirror (line 541):

```js
export async function loadPrinters() {
  const select = document.getElementById('settings-printer');
  const note = document.getElementById('settings-printer-note');
  if (!select) return;
  select.disabled = true;
  select.innerHTML = '<option value="">Detecting printers...</option>';
  let printers = [];
  try {
    const res = await fetch('/api/printers');
    if (!res.ok) throw new Error(`printer lookup failed (${res.status})`);
    printers = (await res.json()).printers || [];
  } catch (err) {
    note.textContent = err.message;
    select.innerHTML = '<option value="">Printer list unavailable</option>';
    return;
  }
  if (!printers.length) {
    note.textContent = 'No printers found. Check the cable, then Refresh.';
    select.innerHTML = '<option value="">No printers found</option>';
    return;
  }
  note.textContent = '';
  const saved = S.shopSettings.printer_name || '';
  const usable = printers.some((p) => p.name === saved);
  const missing = saved && !usable;
  const anyOnline = printers.some((p) => !p.offline);
  // fallback = online default, then any online queue, then offline default,
  // then the first row. Mirrors defaultPrinter in src/printer.js; pinned
  // against drift by a source-order test in tests/ui-fixes.test.js.
  const fallback = ...;
  select.innerHTML = printers.map((p) => {
    const tags = [p.port, p.isDefault && 'default', anyOnline && p.offline && 'offline'].filter(Boolean).join(', ');
    const chosen = usable ? p.name === saved : p.name === fallback;
    return `<option value="${escHtml(p.name)}"${chosen ? ' selected' : ''}>${escHtml(p.name)} (${escHtml(tags)})</option>`;
  }).join('');
  select.disabled = false;
  if (missing) note.textContent = `Saved printer "${saved}" is not installed here. Pick one and save.`;
}
```

Add `loadPrinters();` beside the `autoprintOn` mirror in `openSettingsModal`.

- [ ] **Step 5: Save it and wire Refresh**

In `public/js/auth.js`, the save handler reads each field into a const around lines 588-598 and lists them in one object literal at 604-617. Follow that shape: add beside `receipt_paper_width` (line 592):

```js
  const printer_name = document.getElementById('settings-printer')?.value || '';
```

and inside the `JSON.stringify({...})` body, next to the existing conditional spread for `sync_token`, so an unset picker never overwrites a saved queue:

```js
        ...(printer_name && printer_name !== (S.shopSettings.printer_name || '') ? { printer_name } : {})
```

Send the queue name only when the operator actually changed it. An unconditional spread makes
every unrelated settings save depend on a live queue enumeration that can fail or time out.

In `public/js/main.js`, add to `ACTIONS`:

```js
  'refresh-printers': () => loadPrinters(),
```

and extend the existing `auth.js` import in `main.js` to include `loadPrinters`.

- [ ] **Step 6: Run to verify it passes**

Run: `node --test tests/ui-fixes.test.js` then `npm test`
Expected: PASS both

- [ ] **Step 7: Click it in a browser**

Start the dev server against a temp DB, open Settings -> Printing, and confirm: the select fills with `POS-58 (USB002, default)`, Refresh re-populates, and the note stays empty. Then rename nothing and confirm a saved-but-missing name shows the "not installed here" note rather than silently selecting.

---

### Task 5: Move the sale receipt and reprint onto the new path

**Files:**
- Modify: `public/js/receipts.js` (add `printSlip`, rewire `reprintLastReceipt`, `printTestReceipt`)
- Modify: `public/js/views/pos.js:1264-1270`
- Modify: `public/js/views/backoffice.js:785`
- Test: `tests/printer.test.js` (append a sale happy-path route test)

**Interfaces:**
- Consumes: `POST /api/print` from Task 3, `renderSaleSlip`
- Produces: `printSlip(payload) -> Promise<boolean>` in `receipts.js`, where `false` means the caller should fall back to `window.print()`

- [ ] **Step 1: Write the failing renderer test**

Pure, no DB, and deliberately **not** through the route: a POST that reaches
`sendRaw` feeds real paper, and this development box is the shop printer.

Append to `tests/printer.test.js`:

```js
const { renderSaleSlip } = require('../src/printer');

test('a 58mm sale slip stays inside 32 columns and lands totals at the edge', () => {
  const slip = renderSaleSlip({
    sale_code: 'S-1', created_at: '2026-09-30 08:00:00', customer_name: 'Carlos Tech',
    payment_method: 'cash', payment_reference: '', subtotal: 1250, discount: 0,
    total_amount: 1250, amount_paid: 1000, change_amount: 250, credit_balance: 0,
    items: [{ item_type: 'part', item_name: 'iPhone 11 LCD Screen Original', quantity: 1, unit_price: 1250, total_price: 1250 }],
  }, { receipt_paper_width: '58mm', gcash_name: 'TECHPARTS', warranty_days: '7', warranty_policy_text: '7 Days Test Warranty for LCDs & Batteries.' });
  for (const line of slip) {
    assert.ok(line.text.length <= (line.wide ? 16 : 32), `over budget: ${line.text}`);
  }
  const total = slip.find((l) => l.text.startsWith('TOTAL DUE:'));
  assert.equal(total.text.length, 32);
  assert.ok(total.text.endsWith('P1,250.00'));
  assert.ok(slip.some((l) => l.text.includes('iPhone 11 LCD Screen Original'.slice(0, 20))));
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/printer.test.js`
Expected: FAIL, `renderSaleSlip is not a function`

- [ ] **Step 3: Add the client helper**

In `public/js/receipts.js`:

```js
// Ask the server to print. true means paper moved; false means the caller must
// fall back to window.print() so a sale is never left without a receipt.
export async function printSlip(payload) {
  try {
    const res = await fetch('/api/print', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.ok) return true;
    showToast(data.error || 'The printer refused the job, using browser print', 'warning');
  } catch (err) {
    showToast(`Printing failed: ${err.message}. Using browser print`, 'warning');
  }
  return false;
}
```

- [ ] **Step 4: Rewire the three sale-side triggers**

`reprintLastReceipt` in `receipts.js`:

```js
  renderReceipt(S.lastSaleForReprint);
  if (!(await printSlip({ kind: 'sale', sale_id: S.lastSaleForReprint.id }))) window.print();
```

`printTestReceipt` in `receipts.js`: keep the existing `printable.className` / `innerHTML` / `applyPrintPageSize()` lines (they still drive the browser fallback and the on-screen copy), then replace its `window.print()` with:

```js
  if (!(await printSlip({ kind: 'test' }))) window.print();
```

The auto-print branch in `public/js/views/pos.js:1264`:

```js
    } else if (autoPrintEnabled()) {
      const sale = S.lastSaleForReprint;
      printSlip({ kind: 'sale', sale_id: sale.id }).then((ok) => { if (!ok) window.print(); });
      if (sessionStorage.getItem('pos_kiosk') !== '1' && !autoPrintHintShown) {
        autoPrintHintShown = true;
        showToast('Auto-print fell back to the print dialog: this window was opened manually. Reopen the POS from its desktop icon for one-touch printing.', 'info');
      }
    }
```

The kiosk hint now only fires on the fallback, so keep the existing condition and move it inside the `!ok` branch if you prefer the tighter version.

`reprintSale` in `public/js/views/backoffice.js:785`:

```js
    openModal('modal-receipt');
    if (!(await printSlip({ kind: 'sale', sale_id: sale.id }))) window.print();
```

- [ ] **Step 5: Run to verify it passes**

Run: `node --test tests/printer.test.js` then `npm test`
Expected: PASS. If the suite reports a stale assertion about `window.print()` in the sale flow, update that assertion to the new call, do not delete the test.

- [ ] **Step 6: Print a real sale**

Ring up a test sale at 58mm and confirm the slip carries the header, items, totals, and warranty block, with the totals column ending at the right edge.

---

### Task 6: Move the credit settlement slip

**Files:**
- Modify: `src/printer.js` (add `renderSettlementSlip`)
- Modify: `src/server.js` (the `settlement` branch in `POST /api/print`)
- Modify: `public/js/views/backoffice.js:625`
- Test: `tests/printer.test.js` (append)

**Interfaces:**
- Consumes: `getCustomerDetails(db, name)` from `src/credits.js`, which already returns `{ payments, ... }`
- Produces: `POST /api/print { kind: 'settlement', payment_id, customer_name }`, `renderSettlementSlip(payment, customer, settings)`

- [ ] **Step 1: Write the failing test**

Append to `tests/printer.test.js`:

```js
serverTest('a settlement slip fits the roll and refuses an unknown payment', async (baseUrl, db, auth) => {
  const bad = await fetch(`${baseUrl}/api/print`, {
    method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'settlement', payment_id: 424242, customer_name: 'Nobody' }),
  });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /not found/);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/printer.test.js`
Expected: FAIL, the route answers `Unknown print job`

- [ ] **Step 3: Add the renderer**

Append to `src/printer.js` and export it:

```js
function renderSettlementSlip(payment, customer, settings) {
  const cols = colsFor(settings.receipt_paper_width);
  const slip = [];
  const push = (text, opts) => slip.push({ text, ...opts });
  const lines = (v, wide) => wrap(v, wide ? Math.floor(cols / 2) : cols).forEach((t) => push(t, wide ? { wide: true, centered: true } : {}));
  for (const line of nameLines(settings.gcash_name, Math.floor(cols / 2))) push(line, { wide: true, centered: true });
  push(rule(cols));
  push('SETTLEMENT RECEIPT', { centered: true });
  push(`Date: ${localStamp(payment.created_at)}`);
  push(row('Customer:', customer.customer_name, cols));
  if (customer.customer_phone) push(row('Phone:', customer.customer_phone, cols));
  push(row('Payment:', `${String(payment.payment_method || '').toUpperCase()} ${(payment.payment_reference || '').trim()}`, cols));
  if (payment.notes) for (const line of wrap(`Notes: ${payment.notes}`, cols)) push(line);
  push(rule(cols));
  push(row('Payment received:', money(payment.amount_paid), cols));
  push(row('Remaining balance:', money(customer.total_credit_balance), cols));
  push(rule(cols));
  push(plain(settings.shop_footer_note || '*** Thank you for your payment! ***'), { centered: true });
  return slip;
}
```

> As shipped: same two notes as the sale renderer in Task 3. The `lines(v, wide)` helper's `wide` branch is dead, nothing calls it with a second argument; `money()` refuses a non-finite amount; and the footer is framed as `*** note ***` and wrapped so paper and screen agree. `src/printer.js` is the reference, this snippet stays as planned.

- [ ] **Step 4: Add the route branch**

In `src/server.js`, inside `POST /api/print`, before the `else`:

```js
          } else if (kind === 'settlement') {
            const customer = getCustomerDetails(db, String(body.customer_name || ''));
            const payment = (customer?.payments || []).find((p) => p.id === Number(body.payment_id));
            if (!payment) throw new Error('Settlement payment not found');
            slip = renderSettlementSlip(payment, customer, settings);
```

Add `renderSettlementSlip` to the require line and `getCustomerDetails` to the existing `credits` require.

- [ ] **Step 5: Rewire the client**

`public/js/views/backoffice.js:625`, mirroring the sale branch:

```js
      } else if (autoPrintEnabled()) {
        printSlip({ kind: 'settlement', payment_id: payment.id, customer_name: customerName })
          .then((ok) => { if (!ok) window.print(); });
      }
```

- [ ] **Step 6: Run to verify it passes**

Run: `node --test tests/printer.test.js` then `npm test`
Expected: PASS

---

### Task 7: Fallback clarity and the docs that now lie

**Files:**
- Modify: `README.md:15`
- Modify: `docs/OPERATIONS_AND_DEPLOYMENT.md:22-35`
- Modify: `public/js/auth.js:520` (kiosk status copy, which describes a dialog that mostly no longer appears)
- Test: `tests/ui-fixes.test.js` (append)

- [ ] **Step 1: Write the failing assertions**

Append to `tests/ui-fixes.test.js`:

```js
test('the docs describe ESC/POS printing, not a browser-only path', () => {
  const readme = source('README.md');
  const ops = source('docs/OPERATIONS_AND_DEPLOYMENT.md');
  assert.match(readme, /ESC\/POS/);
  assert.ok(!/no raw ESC\/POS/.test(readme), 'README still claims raw ESC/POS is absent');
  assert.match(ops, /\/api\/print/);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/ui-fixes.test.js`
Expected: FAIL

- [ ] **Step 3: Correct the claims**

`README.md:15`, replace the parenthetical that says the app has no raw ESC/POS:

```md
- **🖨️ Thermal Receipt Printing**: Counter slips print as native ESC/POS straight to the queue from the server (no print dialog). Reports still print through the browser path.
```

`docs/OPERATIONS_AND_DEPLOYMENT.md`: add a step to the pipeline list at 1.2 noting that `npm run build:exe` also bundles `src/printer.js`, and document the counter flow: Settings -> Printing -> pick the queue -> Print test receipt, and that a failed ESC/POS job falls back to the browser path.

`public/js/auth.js:520`, the "Not active" branch, replace the sentence promising a print dialog with:

```js
      : 'Not active: this window was opened manually, so a fallback print would show the dialog. Reopen the POS from its desktop icon for one-touch printing.';
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test tests/ui-fixes.test.js` then `npm test`
Expected: PASS, full suite green

- [ ] **Step 5: Publish and verify on hardware**

Run: `publish.bat`
Expected: tests pass, build verifies, one dated artifact in `publish\`. Then at the counter: print the test slip (ruler touches both edges), ring one cash sale, one GCash sale with a credit balance, and one settlement, and confirm each prints without a dialog and without a fallback toast.

---

## Out of scope

Z-report and period summary migration, Bluetooth transport, hardware QR and barcode, cash-drawer kick, paper cut, and the ₱ code-page probe. Each is named in the spec's Known unknowns or Out sections.
