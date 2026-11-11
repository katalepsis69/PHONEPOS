# Permanent Protected Installer, `SYSTEM` Service & Manager PIN Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver an installer-only Windows distribution (`TechPartsPOS-Setup-<version>.exe`) with an `NT AUTHORITY\SYSTEM` background server + locked `C:\ProgramData\TechPartsPOS` data home (supporting Owner Admin + Cashier Standard accounts), USB backup download, and mandatory Manager Recovery Password + `"Forgot PIN?"` reset flow.

**Architecture:** Split installed runtime in `C:\Program Files\TechPartsPOS` into two entry modes on the single SEA executable: `--service` runs the SQLite/HTTP engine headlessly on loopback `127.0.0.1` as `NT AUTHORITY\SYSTEM` under Task Scheduler (`BootTrigger` + all-users `LogonTrigger`), while clicking Desktop/Start Menu shortcuts runs a lightweight launcher that ensures the service is reachable and opens Edge/Chrome using each interactive user's `%LOCALAPPDATA%\TechPartsPOS\browser-profile`. Add PBKDF2-hashed Manager Recovery Password storage/endpoints, mandatory recovery setup before leaving starter PIN `1234`, `"Close POS"` window-only exit in `--service` mode, Manager-elevated `GET /api/backup/download` for USB backups, and Inno Setup 7/6 installer packaging.

**Tech Stack:** Node.js 22+ (`node:sqlite`, `node:crypto`, `node:http`, `node:fs`, `node:test`, `node:child_process`), zero runtime dependencies (`dependencies: {}`), vanilla ES modules + Tailwind CSS v4 (`npm run build:css`), native Windows `schtasks.exe` / `icacls.exe`, Inno Setup 7.1.1 / 6 (`ISCC.exe`).

**Spec:** [2026-11-11-pin-recovery-and-installer-design.md](../specs/2026-11-11-pin-recovery-and-installer-design.md)

## Global Constraints

- Zero runtime npm dependencies (`dependencies: {}` in `package.json`; Node 22+ built-ins only; devDependencies limited to `@tailwindcss/cli` and `postject`).
- Pure vanilla JS + HTML5 + Tailwind CSS v4 in `public/`; always run `npm run build:css` after UI class changes.
- `tests/db.test.js:193` explicitly asserts `if (isReleaseShaped(base) || !isDirWritable(base))` in `src/db.js`; keep that exact branch for non-Program-Files fallback.
- `tests/setup.test.js`, `tests/roles.test.js`, and `tests/server.test.js` call `POST /api/auth/change-pin` without setting a recovery password; keep `POST /api/auth/change-pin` API compatible while enforcing Recovery Password setup in the UI.
- Never delete `C:\ProgramData\TechPartsPOS` during installer upgrades or uninstalls; never ship an unauthenticated `--reset-pin` CLI flag; never break `scripts/verify-exe.js` (`POS_DB_PATH` + `dist/`) or dev mode (`node src/server.js`).

## Review Focus

1. **Isolated brute-force lockout & validation:** Five wrong `recover-pin` attempts trigger a 15-minute `429` lockout under the `recovery` namespace without locking counter Manager logins, and `setRecoveryPassword` rejects strings under 6 chars, blank-only padding, `'1234'`, or matching the current Manager PIN.
2. **No `!configured` dead-end on installed builds:** Add `id="pin-setup-skip"` to `[data-action="skip-pin-setup"]`, hide `#pin-setup-skip` (and disable `skipPinSetup()`) when `S.serviceMode` is true, require setting a Recovery Password in Settings when updating the Manager PIN while `!S.recoveryConfigured`, and never mention unshipped `scripts/set-pin.js` in `#login-gate-pin-row`.
3. **Auth gate safety (`sessionExempt` vs elevation):** Because `src/server.js:470` exempts `/api/auth/*` from global session checks, `POST /api/auth/recovery-password` MUST require `(session?.type !== 'staff' && elevated && !isDefaultPin(db))` internally (works cleanly in onboarding right after `change-pin` returns `token` + `elevationToken`), while `/api/auth/recovery-status` and `/api/auth/recover-pin` join `licenseExempt`.
4. **Standard cashier startup & non-disruptive exit:** `--service` binds loopback `127.0.0.1` (without `POS_LAN_REPORT_ACK=1`), rejects `POST /api/system/shutdown` with `400`, UI `[data-action="shutdown"]` closes only the browser window in `S.serviceMode`, and Task Scheduler registers both `<BootTrigger>` and an all-users `<LogonTrigger>` with `ExecutionTimeLimit=PT0S` + `IgnoreNew` so Fast Startup never strands Standard accounts.
5. **Launcher vs `verify-exe.js` separation:** Packaged launcher mode triggers only when `execPath` is not `node` (`!/^node(\.exe)?$/i`) AND `isProgramFilesPath(path.dirname(execPath))` AND `!env.POS_DB_PATH`, keeping `scripts/verify-exe.js` (`dist/TechPartsPOS.exe` + `POS_DB_PATH`) and `C:\Program Files\nodejs\node.exe` dev runs untouched.
6. **Authenticated USB backup download & Inno Setup 7/6 packaging:** `GET /api/backup/download` checks elevation + non-factory PIN + `verifyBackupFile` + basename allowlist (sharing validation with `/api/backup/restore`), `src/updater.js` shares `defaultUpdateStagingDir(serviceMode)` between `applyUpdate` and `consumeHandoffStatus` and restarts via `schtasks /Run` in both `:startnew` and `:restore`, and `scripts/build-installer.js` / `scripts/publish-release.ps1` detect `ISCC.exe` under Inno Setup 7/6 paths without generating or uploading `.zip` files.

---

### Task 1: Manager Recovery Password Core & Settings Protection

**Files:**
- Modify: `src/settings.js:5`
- Modify: `src/auth.js:88-180,308-326`
- Test: `tests/auth.test.js`

**Interfaces:**
- Consumes: existing `hashPin`, `verifyPinHash`, `getSetting`, `setSetting`, `getManagerPinHash`, `updateManagerPin`, `_defaultPinCache` in `src/auth.js`, `dbTest` from `tests/helper.js`.
- Produces: `hasRecoveryPassword(db): boolean`, `setRecoveryPassword(db, recoveryPassword): void`, `recoverManagerPin(db, recoveryPassword, newPin): boolean` (throws `400`/`429` Errors on invalid state/input/lockout; clears login/report/recovery lockouts and rotates `report_token` on success; returns `false` on password mismatch after incrementing recovery failure count).

- [ ] **Step 1: Add failing recovery password tests to `tests/auth.test.js`**

```js
const {
  verifyManagerPin, updateManagerPin, isDefaultPin, hashPin,
  hasRecoveryPassword, setRecoveryPassword, recoverManagerPin,
  getReportToken, verifyReportToken
} = require('../src/auth');
const { getShopSettings } = require('../src/settings');

dbTest('recovery password validation, independent 15m lockout, and Manager PIN reset', (db) => {
  assert.strictEqual(hasRecoveryPassword(db), false);
  assert.throws(() => recoverManagerPin(db, 'secret1', '5678'), /No recovery password/);

  for (const bad of ['', '12345', '      ', '1234']) {
    assert.throws(() => setRecoveryPassword(db, bad));
  }
  updateManagerPin(db, '1234', '2580');
  assert.throws(() => setRecoveryPassword(db, '2580'), /different|6/);
  updateManagerPin(db, '2580', '258099');
  assert.throws(() => setRecoveryPassword(db, '258099'), /Manager PIN/i);

  setRecoveryPassword(db, 'shop-owner-99');
  assert.strictEqual(hasRecoveryPassword(db), true);
  const pub = getShopSettings(db);
  assert.strictEqual('recovery_password_hash' in pub, false);
  assert.strictEqual('recovery_lockout_until' in pub, false);
  assert.strictEqual('recovery_failed_attempts' in pub, false);

  // 5 wrong recovery tries lock recovery only, leaving Manager PIN login working
  for (let i = 0; i < 4; i++) assert.strictEqual(recoverManagerPin(db, 'wrong-pw', '4321'), false);
  assert.throws(() => recoverManagerPin(db, 'wrong-pw', '4321'), err => err.statusCode === 429);
  assert.strictEqual(verifyManagerPin(db, '258099'), true);

  // Reset recovery lockout timestamp cleanly in test DB, then recover PIN to 7788
  db.prepare("UPDATE shop_settings SET value = '0' WHERE key IN ('recovery_failed_attempts','recovery_lockout_until')").run();
  const prevReport = getReportToken(db);
  assert.strictEqual(recoverManagerPin(db, 'shop-owner-99', '7788'), true);
  assert.strictEqual(verifyManagerPin(db, '7788'), true);
  assert.strictEqual(verifyReportToken(db, prevReport), false);
});
```

- [ ] **Step 2: Run `node --test tests/auth.test.js` to confirm failure**

Expected: FAIL with `hasRecoveryPassword is not a function` / undefined export.

- [ ] **Step 3: Implement `PRIVATE_SETTINGS` additions in `src/settings.js` and recovery helpers in `src/auth.js`**

  - In `src/settings.js:5`, add `'recovery_password_hash'`, `'recovery_failed_attempts'`, and `'recovery_lockout_until'` to `PRIVATE_SETTINGS`.
  - In `src/auth.js`, add `recovery: { attempts: 'recovery_failed_attempts', lockout: 'recovery_lockout_until', ms: 15 * 60 * 1000, what: 'PIN recovery' }` to `PIN_NAMESPACES`.
  - Implement `hasRecoveryPassword(db)`, `setRecoveryPassword(db, recoveryPassword)` (validate `typeof recoveryPassword === 'string'`, `.length >= 6`, `.trim().length >= 6`, `!== '1234'`, `!verifyPinHash(getManagerPinHash(db), recoveryPassword).ok`, store `hashPin(recoveryPassword)` and reset recovery attempt/lockout keys), and `recoverManagerPin(db, recoveryPassword, newPin)` (check configured -> lockout -> `verifyPinHash` with `recordPinFailure(db, 'recovery')` -> validate `newPin` against `/^\d{4,}$/` and `!== '1234'` -> write `hashPin(newPin)`, reset all 3 lockout/attempt key pairs, clear `_defaultPinCache.delete(db)`, rotate `report_token` + `report_token_expires_at`). Export all three from `src/auth.js`.

- [ ] **Step 4: Run `node --test tests/auth.test.js`**

Expected: PASS.

- [ ] **Step 5: Commit Task 1**

```bash
git add src/settings.js src/auth.js tests/auth.test.js
git commit -m "feat: add PBKDF2 manager recovery password and PIN reset auth"
```

---

### Task 2: Backend HTTP Routes (`recovery-*`, `service_mode`, `/api/backup/download`)

**Files:**
- Modify: `src/server.js:450-458,740-750,1270-1305,1376-1381,1500-1565`
- Test: `tests/setup.test.js`, `tests/backup-restore.test.js`

**Interfaces:**
- Consumes: `hasRecoveryPassword`, `setRecoveryPassword`, `recoverManagerPin` from `src/auth.js`; `verifyBackupFile` and `isServiceMode` in `src/server.js`.
- Produces:
  - `GET /api/license/status` returns `{ ...getLicenseStatus(db), version: CURRENT_VERSION, service_mode: isServiceMode }`
  - `GET /api/auth/recovery-status` (`licenseExempt`) -> `{ configured: boolean }`
  - `POST /api/auth/recovery-password` -> `{ success: true, recovery_password_configured: true }`
  - `POST /api/auth/recover-pin` (`licenseExempt`) -> `{ success: true, token, actor, elevationToken, expiresAt }` or `403`/`429`
  - `GET /api/settings` & `POST /api/settings` include `recovery_password_configured`
  - `GET /api/backup/download?file=...` -> binary SQLite file download (`application/octet-stream`)
  - `POST /api/system/shutdown` -> refuses with `400` when `isServiceMode` is true

- [ ] **Step 1: Add failing HTTP route tests to `tests/setup.test.js` and `tests/backup-restore.test.js`**

  - In `tests/setup.test.js`: test unconfigured `GET /api/auth/recovery-status` -> `{ configured: false }`, staff session rejected (`403`) on `POST /api/auth/recovery-password`, Manager/setup `POST /api/auth/recovery-password` -> `200`, `GET /api/settings` returns `recovery_password_configured: true` without hash fields, `POST /api/auth/recover-pin` wrong password -> `403`, valid recovery password -> `200` returning fresh session `token` + `elevationToken` able to access elevated endpoints, and verify works even when trial is expired (`licenseExempt` check -> not `402`). Also assert `GET /api/license/status` includes boolean `service_mode` and `POS_SERVICE_MODE` / `--service` test hook makes `POST /api/system/shutdown` answer `400`.
  - In `tests/backup-restore.test.js`: test `GET /api/backup/download` rejects unauthenticated (`401`), non-elevated staff (`403`), factory `1234` PIN (`403`), traversal filename `../shop.db` (`400`), corrupt file (`400`), and downloads valid backup SQLite bytes (`SQLite format 3` header) + records `backup_download` audit row; omit `?file=` downloads the latest verified snapshot.

- [ ] **Step 2: Run `node --test tests/setup.test.js tests/backup-restore.test.js` to confirm failure**

Expected: FAIL on 404/missing route assertions.

- [ ] **Step 3: Implement routes and `isServiceMode` flag in `src/server.js`**

  - Derive `isServiceMode` inside `createServer({ serviceMode } = {})` / module scope cleanly (`Boolean(serviceMode ?? (process.argv.includes('--service') || process.env.POS_TEST_SERVICE_MODE === '1'))`).
  - Add `/api/auth/recovery-status` and `/api/auth/recover-pin` to `licenseExempt` (note `sessionExempt` already covers `pathname.startsWith('/api/auth/')`).
  - Add `service_mode: isServiceMode` to `/api/license/status` payload, and guard `POST /api/system/shutdown` when `isServiceMode` is true (`sendJson(res, 400, { error: 'Background server stays active in installed mode. Close the POS window instead.' })`).
  - Implement:
    - `GET /api/auth/recovery-status` -> `{ configured: hasRecoveryPassword(db) }`
    - `POST /api/auth/recovery-password` -> guard `if (session?.type === 'staff' || !elevated) return elevationDenied(); if (isDefaultPin(db)) return factoryPinDenied();`, validate `typeof body?.recovery_password === 'string'`, wrap `setRecoveryPassword` + `audit(db, session || actor, true, 'security', 'set_recovery_password', {})` in `txn(db, ...)`, return `{ success: true, recovery_password_configured: true }`
    - `POST /api/auth/recover-pin` -> validate `recovery_password` + `new_pin` strings, call `recoverManagerPin(db, body.recovery_password, body.new_pin)`; on `false` audit `pin_recover_failed` and return `403`; on `true` issue Manager session token + `issueElevationToken(db)`, audit `pin_recovered`, return `200 { success: true, token: sessionToken, actor, elevationToken, expiresAt }`
    - Include `recovery_password_configured: hasRecoveryPassword(db)` on `GET /api/settings` and `POST /api/settings` responses.
  - Add `GET /api/backup/download` with `if (!elevated) return elevationDenied(); if (isDefaultPin(db)) return factoryPinDenied();`, sharing a `resolveVerifiedBackupFile(backupDir, name)` / `latestVerifiedBackupFile(backupDir)` helper with `POST /api/backup/restore` (return `400` on invalid basename or failed integrity check, `404` when no backup exists, audit `backup_download`, send raw bytes with `Content-Type: application/octet-stream`, `Content-Disposition: attachment; filename="<name>"`, `Cache-Control: no-store`).

- [ ] **Step 4: Run `node --test tests/setup.test.js tests/backup-restore.test.js`**

Expected: PASS.

- [ ] **Step 5: Commit Task 2**

```bash
git add src/server.js tests/setup.test.js tests/backup-restore.test.js
git commit -m "feat: add PIN recovery, service_mode, and backup download endpoints"
```

---

### Task 3: Frontend Setup, Login `"Forgot PIN?"`, Settings & USB Download UI

**Files:**
- Modify: `public/index.html:135,1532-1600,1850-1861,2447-2550`
- Modify: `public/js/state.js:46-74`
- Modify: `public/js/auth.js:83-100,204-260,1080-1160,1325-1350,1489-1665`
- Modify: `public/js/main.js:264-272,511-535`
- Modify: `public/js/views/backoffice.js:1665-1780,2142-2158`
- Build: `npm run build:css`
- Test: `tests/ui-fixes.test.js`

**Interfaces:**
- Consumes: Task 2 routes (`/api/auth/recovery-status`, `/api/auth/recovery-password`, `/api/auth/recover-pin`, `/api/backup`, `/api/backup/download`, `/api/license/status` `service_mode`), existing `downloadCsvFile(url, filename)` in `public/js/main.js:216`.
- Produces: `#pin-setup-recovery` / `#pin-setup-recovery-confirm` inputs, Settings Staff Recovery Password section (and mandatory recovery password validation when updating Manager PIN while unconfigured), `#login-gate-forgot-pin` inline recovery panel (Manager-only, clean `!configured` message without `scripts/set-pin.js`), `data-action="download-backup"` button + `downloadBackup()`, and `S.serviceMode` UI adaptations (`#pin-setup-skip` hidden in service mode, `[data-action="shutdown"]` closes window without API call).

- [ ] **Step 1: Add UI structure/contract tests to `tests/ui-fixes.test.js`**

  - Assert `public/index.html` contains `#pin-setup-recovery`, `#pin-setup-recovery-confirm`, `#settings-recovery-status`, `#settings-recovery-new`, `#settings-recovery-confirm`, `#settings-recovery-btn`, `#login-gate-forgot-pin`, and `[data-action="download-backup"]`.
  - Assert zero `scripts/set-pin.js` references remain anywhere in `public/js/auth.js` or `public/index.html`.
  - Assert `[data-action="shutdown"]` relabels and bypasses `/api/system/shutdown` when `S.serviceMode` is true (`public/js/auth.js` + `public/js/views/backoffice.js`).

- [ ] **Step 2: Run `node --test tests/ui-fixes.test.js` to confirm failure**

Expected: FAIL on missing element IDs / actions.

- [ ] **Step 3: Update HTML, state, JS modules, and rebuild CSS (`npm run build:css`)**

  - Add `serviceMode: false` and `recoveryConfigured: false` to `public/js/state.js` and sync `S.serviceMode` + `syncServiceModeUi()` (set `id="pin-setup-skip"` hidden when `S.serviceMode`, set `[data-action="shutdown"]` `#counter-exit-btn` title/aria-label `"Close POS Window"` / label `"Close POS"`) inside `probeServer()` and `checkLicenseStatus()` in `public/js/auth.js`.
  - Update `#pin-setup-overlay` + `submitPinSetup()` (track `pinSetupRecoverySaved` for safe retries, save recovery password via `POST /api/auth/recovery-password` right after `change-pin`); update `skipPinSetup()` to refuse when `S.serviceMode` is true.
  - Update Settings -> Staff & Security (`public/index.html`, `public/js/auth.js`) with Recovery Password card (`#settings-recovery-status`, `#settings-recovery-new`, `#settings-recovery-confirm`, `#settings-recovery-btn`, `#settings-recovery-msg`), sync `S.recoveryConfigured` when loading/saving settings, and prompt/require recovery password when changing the Manager PIN in Settings while `!S.recoveryConfigured`.
  - Update `#login-gate-pin-row` in `public/index.html` + `public/js/auth.js` + `public/js/main.js` `ACTIONS` for Manager-only `"Forgot PIN?"` inline reset flow (`GET /api/auth/recovery-status` -> inline reset form `#login-gate-forgot-pin` -> `POST /api/auth/recover-pin` -> store `sessionToken` + `setElevation` + finish Manager login cleanly) and clean `#login-gate-no-recovery` message naming Shop Owner / Windows Administrator instead of `scripts/set-pin.js`.
  - Add `"Download copy"` (`data-action="download-backup"`) in Settings -> Data wired via `ACTIONS` in `public/js/main.js` to `downloadBackup()` in `public/js/views/backoffice.js` (requires Manager PIN elevation, calls `POST /api/backup`, downloads via `downloadCsvFile`).
  - Update `shutdownServer()` in `public/js/views/backoffice.js` for `S.serviceMode` (skip Manager PIN + `/api/system/shutdown`, render `"POS Window Closed"` screen, call `window.close()`), and adjust `showUpdateHandoffStalled` log path tip when `S.serviceMode` is true (`C:\ProgramData\TechPartsPOS\updates\TechPartsPOS_update.handoff.log`).
  - Keep `>=44px` touch targets, high contrast, zero purple glows/buzzwords per `AGENTS.md`, and run `npm run build:css`.

- [ ] **Step 4: Run `node --test tests/ui-fixes.test.js tests/setup.test.js`**

Expected: PASS and CSS compiled cleanly.

- [ ] **Step 5: Commit Task 3**

```bash
git add public/index.html public/css public/js/state.js public/js/auth.js public/js/main.js public/js/views/backoffice.js tests/ui-fixes.test.js
git commit -m "feat: add recovery password UI, USB backup download, and Close POS mode"
```

---

### Task 4: `Program Files` Data Routing (`src/db.js` & `scripts/mirror-backups.js`)

**Files:**
- Modify: `src/db.js:16-80,458`
- Modify: `scripts/mirror-backups.js:16-19`
- Test: `tests/db.test.js`

**Interfaces:**
- Consumes: `ProgramData` / `ALLUSERSPROFILE` / `LOCALAPPDATA` env vars, `isReleaseShaped`, `isDirWritable`.
- Produces: `isProgramFilesPath(dir): boolean` exported from `src/db.js`; `getBaseDir({ execDir, programData }?)` routing `\Program Files\` / `\Program Files (x86)\` installs strictly to `C:\ProgramData\TechPartsPOS` while leaving `if (isReleaseShaped(base) || !isDirWritable(base))` intact for `tests/db.test.js`.

- [ ] **Step 1: Add failing `Program Files` path tests in `tests/db.test.js`**

  - Test `isProgramFilesPath('C:\\Program Files\\TechPartsPOS') === true`, `isProgramFilesPath('C:\\Program Files (x86)\\TechPartsPOS') === true`, `isProgramFilesPath('C:\\Users\\sloth\\Desktop\\dist') === false`, `isProgramFilesPath('C:\\TechPartsPOS') === false`.
  - Test `getBaseDir` resolves `ProgramData\TechPartsPOS` when `execDir` is under `Program Files` (even when writable), while preserving existing `tests/db.test.js` assertions verbatim (`if (isReleaseShaped(base) || !isDirWritable(base))` match).

- [ ] **Step 2: Run `node --test tests/db.test.js` to confirm failure**

Expected: FAIL with `isProgramFilesPath is not a function`.

- [ ] **Step 3: Implement `isProgramFilesPath` in `src/db.js` and update `scripts/mirror-backups.js`**

  - Add case-insensitive segment check `isProgramFilesPath(dir)` (`/(^|[\\/])program files( \(x86\))?([\\/]|$)/i`) in `src/db.js`, check it *before* `if (isReleaseShaped(base) || !isDirWritable(base))` inside `getBaseDir`, returning `path.join(process.env.ProgramData || process.env.ALLUSERSPROFILE || 'C:\\ProgramData', 'TechPartsPOS')`, and export `isProgramFilesPath`.
  - Update `scripts/mirror-backups.js` so `src` checks `C:\ProgramData\TechPartsPOS\data\shop.db` -> `%LOCALAPPDATA%\TechPartsPOS\data\shop.db` -> `path.join(getBaseDir(), 'backups')` when `POS_BACKUP_DIR` is unset.

- [ ] **Step 4: Run `node --test tests/db.test.js`**

Expected: PASS.

- [ ] **Step 5: Commit Task 4**

```bash
git add src/db.js scripts/mirror-backups.js tests/db.test.js
git commit -m "feat: route Program Files installs to ProgramData\TechPartsPOS"
```

---

### Task 5: Service Mode Runtime Isolation, Installed Launcher Mode & Browser Profile Paths

**Files:**
- Modify: `src/server.js:1795-1948,2008-2134`
- Test: `tests/port-drift.test.js` or `tests/server.test.js`

**Interfaces:**
- Consumes: `getBaseDir`, `isProgramFilesPath` from `src/db.js`.
- Produces: exported pure helpers/hooks (`resolveLaunchMode({ execPath, argv, env })`, `browserProfileDir(env)`, `runtimeStatePath()`, `runInstalledLauncher(hooks)`) so unit tests exercise `--service`, direct dev/verify-exe (`dist/` or `POS_DB_PATH` or `node.exe`), and installed Launcher Mode without spawning Edge or `schtasks.exe`.
  - `resolveLaunchMode({ execPath, argv, env })`: returns `'service'` if `(argv || []).includes('--service')`; `'launcher'` if `!/^node(\.exe)?$/i.test(path.basename(execPath || '')) && isProgramFilesPath(path.dirname(execPath || '')) && !env?.POS_DB_PATH`; otherwise `'direct'`.
  - `browserProfileDir(env = process.env)` resolves `path.join(env.LOCALAPPDATA, 'TechPartsPOS', 'browser-profile')` whenever `env.LOCALAPPDATA` exists, falling back to `path.join(getBaseDir(), 'browser-profile')` otherwise.
  - `instanceLockPath()` and `runtimeStatePath()` use `path.join(getBaseDir(), 'runtime', ...)` in `--service` mode (`server.json`: `{ pid, port, started_at }` written on listen & cleaned up on exit when matching `process.pid`).
  - Top-level entrypoint (`src/server.js:2128-2132`): switches cleanly on `resolveLaunchMode(...)`: `'launcher'` calls `runInstalledLauncher()` without setting `HOST` / `POS_LAN_REPORT_ACK` or opening DB; `'service'` defaults `HOST = '127.0.0.1'` (no `POS_LAN_REPORT_ACK=1`), sets `NO_AUTO_BROWSER=1` & `NO_AUTO_EXIT=1`, calls `startServer(undefined, process.env.HOST)`; `'direct'` keeps existing `HOST='0.0.0.0'`, `POS_LAN_REPORT_ACK='1'`, `startServer()`.
  - Installed `.exe` without `--service` (`launcher`): skips DB/server startup, reads `ProgramData\TechPartsPOS\runtime\server.json` (fallback ports `3000..3005`), probes `GET /api/license/status`, polls up to ~1.5s then tries `schtasks /Run /TN "TechPartsPOS-Server"` once and polls up to 8s -> launches browser at `http://localhost:<port>` and exits `0`, or shows PowerShell `MessageBox` on timeout and exits `1`.

- [ ] **Step 1: Add failing launcher/service mode tests to `tests/server.test.js`**

  - Test `resolveLaunchMode` across 4 cases: dev (`node.exe`), `verify-exe.js` (`dist/TechPartsPOS.exe` + `POS_DB_PATH`), `--service` (`Program Files\TechPartsPOS\TechPartsPOS.exe --service`), and installed desktop shortcut (`Program Files\TechPartsPOS\TechPartsPOS.exe` with no args).
  - Test `runInstalledLauncher` with mocked `fetch`, `launchBrowser`, `runTask`, and `showErrorBox`:
    - Answers `200` on port from `runtime/server.json` -> calls `launchBrowser('http://localhost:' + port)` and never calls `runTask` or opens SQLite.
    - Answers unreachable then `200` after `runTask('TechPartsPOS-Server')` -> succeeds cleanly.
    - Never answers `200` (e.g. Standard user + task down) -> calls `showErrorBox` and exits `1`.
  - Test `--service` sets loopback `127.0.0.1` default when `HOST` is unset.

- [ ] **Step 2: Run the new test assertions in `tests/server.test.js` to confirm failure**

Expected: FAIL with missing exported helpers.

- [ ] **Step 3: Implement `resolveLaunchMode`, `runtime/server.json`, launcher mode, and user `LOCALAPPDATA` browser profile in `src/server.js`**

- [ ] **Step 4: Run `node --test tests/server.test.js tests/port-drift.test.js`**

Expected: PASS.

- [ ] **Step 5: Commit Task 5**

```bash
git add src/server.js tests/server.test.js
git commit -m "feat: add --service loopback isolation and installed launcher mode"
```

---

### Task 6: Service-Aware Auto-Updater (`src/updater.js`)

**Files:**
- Modify: `src/updater.js:395-472,565-695`
- Modify: `src/server.js:1575-1635` (confirm `serviceMode` passed cleanly / `consumeHandoffStatus`)
- Test: `tests/updater.test.js`

**Interfaces:**
- Consumes: `getBaseDir` from `src/db.js`.
- Produces: `defaultUpdateStagingDir(serviceMode = process.argv.includes('--service'))` returning `serviceMode ? path.join(getBaseDir(), 'updates') : path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'TechPartsPOS')`; `buildApplyScript({ stagingExe, targetExe, resumeMarker, handoffLog, oldSizePath, serviceMode = false })` restarting `TechPartsPOS-Server` via `schtasks /Run /TN "TechPartsPOS-Server"` in BOTH `:startnew` and `:restore` when `serviceMode` is true; `consumeHandoffStatus(stagingDir = defaultUpdateStagingDir())`; and `applyUpdate({ downloadUrl, expectedBytes, serviceMode })` using `defaultUpdateStagingDir(serviceMode)` when `testHooks?.stagingDir` is unset (called from `src/server.js:1593` with `serviceMode: isServiceMode`).

- [ ] **Step 1: Add failing `serviceMode` updater tests to `tests/updater.test.js`**

  - Assert `buildApplyScript({ ..., serviceMode: true })` emits `schtasks /Run /TN "TechPartsPOS-Server"` (in both normal and restore branches) and omits `start ""`, while `serviceMode: false` preserves `start ""`.
  - Assert `applyUpdate` with mocked `serviceMode: true` (`stagingDir` default / `defaultUpdateStagingDir(true)`) stages update files inside `path.join(getBaseDir(), 'updates')` (or resolved service staging dir) and passes `serviceMode: true` into `buildApplyScript`.

- [ ] **Step 2: Run `node --test tests/updater.test.js` to confirm failure**

Expected: FAIL because `buildApplyScript` still outputs `start ""` regardless of `serviceMode`.

- [ ] **Step 3: Implement `serviceMode` staging directory and Task Scheduler relaunch in `src/updater.js` and `src/server.js`**

- [ ] **Step 4: Run `node --test tests/updater.test.js`**

Expected: PASS.

- [ ] **Step 5: Commit Task 6**

```bash
git add src/updater.js src/server.js tests/updater.test.js
git commit -m "feat: restart TechPartsPOS-Server scheduled task on service auto-updates"
```

---

### Task 7: Inno Setup 7/6 Installer Script, Release Pipeline, Docs & Full Verification

**Files:**
- Modify: `installer/TechPartsPOS.iss`
- Modify: `scripts/build-installer.js:1-44`
- Modify: `scripts/publish-release.ps1`
- Modify: `scripts/generate-changelog.js:417-421`
- Modify: `RELEASE_NOTES.md`
- Modify: `README.md`
- Modify: `docs/OPERATIONS_AND_DEPLOYMENT.md`
- Test: `tests/packaging-workflows.test.js`

**Interfaces:**
- Consumes: Inno Setup 7 (`%LOCALAPPDATA%\Programs\Inno Setup 7\ISCC.exe`, `C:\Program Files\Inno Setup 7\ISCC.exe`, `C:\Program Files (x86)\Inno Setup 7\ISCC.exe`) or Inno Setup 6/5, `release/customer/TechPartsPOS.exe`.
- Produces: Locked `Program Files` installer (`TechPartsPOS-Setup-<version>.exe`), installer-only GitHub asset workflow (`Setup.exe` + `TechPartsPOS.exe` + `.sha256`, zero `.zip`), updated Owner Admin + Cashier Standard documentation.

- [ ] **Step 1: Update `tests/packaging-workflows.test.js` with failing installer & release-script checks**

  - Assert `installer/TechPartsPOS.iss` contains `DisableDirPage=yes`, `*S-1-5-18:(OI)(CI)F`, `*S-1-5-32-545:(OI)(CI)R`, `<BootTrigger>`, `<LogonTrigger>`, `PT0S`, `IgnoreNew`, `TechPartsPOS-Server`, `PrepareToInstall`, `InitializeUninstall`, and does NOT delete `ProgramData\TechPartsPOS` in `[UninstallDelete]`.
  - Assert `scripts/build-installer.js` checks Inno Setup 7 paths (`%LOCALAPPDATA%\Programs\Inno Setup 7\ISCC.exe` and `C:\Program Files\Inno Setup 7\ISCC.exe`) and reads `package.json` version cleanly even outside `npm run`.
  - Assert `scripts/publish-release.ps1` builds/uploads `TechPartsPOS-Setup-` installer without `.zip` archive creation/upload and still parses cleanly via `[scriptblock]::Create(...)`.

- [ ] **Step 2: Run `node --test tests/packaging-workflows.test.js` to confirm failure**

Expected: FAIL on missing assertions in `.iss`, `build-installer.js`, and `publish-release.ps1`.

- [ ] **Step 3: Implement `installer/TechPartsPOS.iss`, `scripts/build-installer.js`, `scripts/publish-release.ps1`, `scripts/generate-changelog.js`, `RELEASE_NOTES.md`, `README.md`, and `docs/OPERATIONS_AND_DEPLOYMENT.md`**

  - In `installer/TechPartsPOS.iss`: add `DisableDirPage=yes`; add `[Code]` helpers (`PrepareToInstall`, `InitializeUninstall`) calling `{sys}\schtasks.exe /End /TN "TechPartsPOS-Server"` and waiting up to 5s via `tasklist | find.exe` (falling back to `taskkill /F /IM TechPartsPOS.exe` only if still locked after 5s); add `AfterInstall: WriteServiceTaskXml` on `{app}\TechPartsPOS.exe` writing `%TEMP%\TechPartsPOS-Server.xml` (`S-1-5-18`, `<BootTrigger>`, all-users `<LogonTrigger>`, `PT0S`, battery disabled, `IgnoreNew`, `RestartOnFailure` 999x, `--service`) and delete that temp XML in `CurStepChanged(ssPostInstall)`; configure `[Dirs]` (`uninsneveruninstall`) + `[Run]` (`icacls` locking `{commonappdata}\TechPartsPOS` to `*S-1-5-18:(OI)(CI)F`, granting `runtime` `*S-1-5-32-545:(OI)(CI)R`, `attrib +h +s`, importing & starting `TechPartsPOS-Server`, followed by optional postinstall launch `{app}\TechPartsPOS.exe`); configure `[UninstallRun]` to end & delete `TechPartsPOS-Server` without touching `ProgramData`.
  - In `scripts/build-installer.js`: read `package.json` version directly when `npm_package_version` is absent, and add Inno Setup 7 install locations (including `%LOCALAPPDATA%\Programs\Inno Setup 7\ISCC.exe`) ahead of Inno Setup 6/5.
  - In `scripts/publish-release.ps1`: remove `.zip` packaging, upload, and `README.md` zip rewrite; run `node scripts/build-installer.js` (or fail clearly if Inno Setup missing); upload `TechPartsPOS-Setup-<cleanVer>.exe` + `TechPartsPOS.exe` + `TechPartsPOS.exe.sha256` (updating `Get-DefaultReleaseNotes` to name `TechPartsPOS-Setup-<version>.exe`).
  - Update `scripts/generate-changelog.js` and `RELEASE_NOTES.md` fresh-install steps to name `TechPartsPOS-Setup-<version>.exe` (no `.zip`), and update `README.md` and `docs/OPERATIONS_AND_DEPLOYMENT.md` for installer-only setup + plain-English **Owner (Admin) + Cashier (Standard Windows Account)** instructions + **"Download copy"** USB backups.

- [ ] **Step 4: Run full verification pipeline**

  - Run `npm test` (all unit & integration tests across `tests/*.test.js`).
  - Run `npm run build:exe` (rebuilds CSS, SEA artifacts, runs `scripts/verify-exe.js` smoke checks).
  - Run `npm run build:installer` using installed `C:\Users\sloth\AppData\Local\Programs\Inno Setup 7\ISCC.exe` to compile `dist/installer/TechPartsPOS-Setup-2.8.exe` and inspect compiler exit `0` + file size.

- [ ] **Step 5: Commit Task 7**

```bash
git add installer/TechPartsPOS.iss scripts/build-installer.js scripts/publish-release.ps1 scripts/generate-changelog.js RELEASE_NOTES.md README.md docs/OPERATIONS_AND_DEPLOYMENT.md tests/packaging-workflows.test.js
git commit -m "build: upgrade Inno Setup 7 installer to SYSTEM background service"
```
