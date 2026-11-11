# TechParts POS — Permanent Protected Installer, `SYSTEM` Service & Manager PIN Recovery Design

**Date:** 2026-11-11
**Status:** Approved (2026-11-11; ready for SDD execution)

---

## 1. Intent & Why

TechParts POS is an unreleased Windows workstation POS that currently distributes a loose portable executable/zip (`TechPartsPOS.exe` / `.zip`). That setup causes two structural problems:
1. Running or moving loose `.exe` copies splits `data/shop.db` across folders (`Downloads`, `Desktop`, `%LOCALAPPDATA%`), making saved PINs and data appear to "suddenly stop working," while a genuinely forgotten Manager PIN has no in-app recovery path without Node dev scripts (`scripts/set-pin.js`).
2. Running the database engine directly under the cashier's Windows session leaves `shop.db` and `backups/` unprotected in File Explorer.

This design establishes the **permanent installer-only architecture**:
- **Installer-only distribution** (`TechPartsPOS-Setup-<version>.exe` locked to `C:\Program Files\TechPartsPOS`, no portable `.zip`).
- **Owner (Windows Admin) + Cashier (Windows Standard account) architecture with `SYSTEM` isolation:** A native Windows Scheduled Task (`TechPartsPOS-Server`) runs `TechPartsPOS.exe --service` in the background as `NT AUTHORITY\SYSTEM`, and `C:\ProgramData\TechPartsPOS` grants access **only to `SYSTEM`** (`Users` and normal `Administrators` File Explorer/CMD sessions get **Access Denied** when trying to open, copy, edit, or delete `shop.db` or `backups/`). Daily cashiers use a Standard Windows user account (unable to take folder ownership in Security settings), while the owner retains the Windows Admin password for installs/uninstalls.
- **Direct counter shortcut launcher:** Double-clicking `TechPartsPOS` launches `TechPartsPOS.exe` in lightweight launcher mode, connects to the background service, and opens the Edge kiosk UI (with USB/Bluetooth/Wi-Fi IP printers and 1-click `Program Files` auto-updates continuing to work seamlessly).
- **Safe USB backup download & Cloud Sync:** Because `C:\ProgramData\TechPartsPOS\backups\` is locked in File Explorer, Settings → Data adds a Manager-PIN-protected **"Download copy"** button alongside existing Cloud Sync so an owner can save a verified `.db` backup onto a USB drive without unlocking Windows permissions.
- **Manager-only local PIN recovery:** A PBKDF2-hashed **Manager Recovery Password** set before leaving the factory `1234` PIN lets the manager reset a forgotten/locked PIN via **"Forgot PIN?"** on the login gate without losing sales, *utang*, inventory, or license activation.

---

## 2. Goals, Non-Goals, and Anti-Goals

### Goals
- Ship a single official Windows installer (`TechPartsPOS-Setup-<version>.exe`) locked (`DisableDirPage=yes`) to `C:\Program Files\TechPartsPOS` (`PrivilegesRequired=admin`) with Start Menu/Desktop shortcuts, `HKLM` Edge kiosk policies, and Windows Apps & Features uninstaller.
- Run the backend POS server permanently in the background as `NT AUTHORITY\SYSTEM` via native Windows Task Scheduler (`schtasks.exe`, zero external service wrappers), triggering on both system boot **and** any user logon (protecting Windows 10/11 Fast Startup and Standard user logins).
- Lock `C:\ProgramData\TechPartsPOS` (`data/`, `backups/`, `updates/`) so Standard Windows users and normal Admin-account File Explorer/CMD sessions receive **Access Denied** when trying to read, copy, edit, or delete `shop.db` or backups (only a read-only `runtime/` subfolder exposes the active port for the launcher).
- Keep 1-click GitHub auto-updates (`src/updater.js`) working automatically inside `C:\Program Files\TechPartsPOS` under `SYSTEM`.
- Keep USB, Bluetooth, and direct Wi-Fi/LAN IP printers working directly through Windows `winspool.drv` (`src/printer.js`).
- Provide a Manager-elevated **"Download copy"** backup action (`GET /api/backup/download`) in Settings → Data so owners can save backups to USB without touching Windows Security permissions.
- Add a Manager Recovery Password + `"Forgot PIN?"` login flow that resets the Manager PIN locally without losing shop data or license.

### Non-Goals
- Portable `.zip` distribution or migrating legacy `.zip` folders (product is unreleased).
- Opening LAN/Wi-Fi Phone Reports (`HOST=0.0.0.0` / Windows Firewall inbound rules) — skipped for now; `--service` stays safely bound to `127.0.0.1`.
- Creating Windows user accounts automatically inside the installer (handled cleanly by Windows standard account setup + an owner checklist).
- Supporting printers shared from *another* Windows PC over per-user SMB network shares (`\\OtherPC\Printer`).
- Encrypting live SQLite bytes on disk (not supported by Node 22 built-in `node:sqlite` under the 0-runtime-dependencies invariant).
- Changing Staff PIN reset flow or Cloud app (`cloud/server.js`) auth.

### Anti-Goals
- **Never delete `C:\ProgramData\TechPartsPOS` during uninstall or upgrade.**
- **Never add an unauthenticated `--reset-pin` flag or button in `TechPartsPOS.exe`.**
- **Never let `--service` shutdown be triggered from the counter UI** (which would strand Standard cashier accounts without Admin rights).
- **Never let the desktop shortcut launcher open `shop.db` directly** when installed in `Program Files`.
- **Never break dev mode (`node src/server.js` / `start.bat`) or existing `npm test` suites** (`tests/db.test.js`, `tests/setup.test.js`).

---

## 3. Constraints

- **Zero runtime dependencies** (`dependencies: {}` in `package.json`; Node 22+ built-ins only).
- **Vanilla JS + Tailwind CSS v4** in `public/` (`npm run build:css` required after UI edits).
- **Windows GUI-subsystem SEA binary** (`TechPartsPOS.exe` hides stdout/stderr console windows).
- **Single-instance & Task Scheduler constraints:**
  - Windows Task Scheduler defaults (`ExecutionTimeLimit=PT72H`, `StopIfGoingOnBatteries=true`) would kill a long-running POS server after 3 days or on laptop battery, and Windows 10/11 Fast Startup skips `<BootTrigger>` after Shut Down -> Power On; task XML MUST set BOTH `<BootTrigger>` AND an all-users `<LogonTrigger>`, plus `ExecutionTimeLimit=PT0S`, `DisallowStartIfOnBatteries=false`, `StopIfGoingOnBatteries=false`, `MultipleInstancesPolicy=IgnoreNew`, and `RestartOnFailure`.
  - `server.lock` and staging files used by `--service` must live under `C:\ProgramData\TechPartsPOS` (not `SYSTEM`'s `%LOCALAPPDATA%\systemprofile`), while the Edge `browser-profile/` MUST live in each interactive user's `%LOCALAPPDATA%\TechPartsPOS\browser-profile`.
- **Existing tests:** `tests/db.test.js` checks `if (isReleaseShaped(base) || !isDirWritable(base))` in `src/db.js`; `tests/setup.test.js` calls `POST /api/auth/change-pin` without setting a recovery password.
- **Build tooling:** Inno Setup 6 or 7 (`ISCC.exe`) must be installed on the build PC to compile `TechPartsPOS-Setup-<version>.exe`.

---

## 4. Approaches Considered

| Approach | Summary | Trade-offs | Verdict |
|---|---|---|---|
| **A. Per-user Installer (`%LOCALAPPDATA%\Programs\TechPartsPOS`)** | Non-admin install, standard-user writes. | Any user can delete installed program files, shop DB, and uninstall without Admin. | Dropped |
| **B. Single-process `Program Files` + `attrib +h` + NTFS `Deny Delete`** | Same process runs UI & DB under user login; `attrib +h` + `Deny Delete` on `shop.db`. | User account still needs Write permission on `shop.db` (can open/overwrite in Explorer), and `Program Files` auto-update fails for standard users. | Dropped (bandaid) |
| **C. `SYSTEM` Scheduled Task (`TechPartsPOS-Server`) + `SYSTEM`-only `C:\ProgramData\TechPartsPOS` + Launcher Mode + Recovery Password** | Splits installed runtime cleanly into `SYSTEM` DB/HTTP service (`--service`) + lightweight desktop launcher (`TechPartsPOS.exe`); `C:\ProgramData\TechPartsPOS` locked to `SYSTEM` only. | Per-user SMB shared printers from *other* PCs aren't visible to `SYSTEM` (USB/BT/Wi-Fi IP printers work); a Windows Admin who manually takes folder ownership can override NTFS, which is solved by Standard cashier accounts, Cloud Sync, and the in-app **Download copy** USB backup button. | **Picked** (permanent OS isolation + auto-updates + clean single DB) |

---

## 5. Detailed Design (Decided Parts)

### 5.1 Manager Recovery Password & Backup Download (`src/auth.js`, `src/settings.js`, `src/server.js`)

1. **Private Settings Keys (`src/settings.js`):**
   - Add `'recovery_password_hash'`, `'recovery_failed_attempts'`, and `'recovery_lockout_until'` to `PRIVATE_SETTINGS` so `GET /api/settings` never exposes hashes or lockout state.

2. **Auth Logic (`src/auth.js`):**
   - Reuse `hashPin()` / `verifyPinHash()` (PBKDF2-SHA256, 100k iterations, 16-byte random salt).
   - `hasRecoveryPassword(db)`: returns `Boolean(getSetting(db, 'recovery_password_hash'))`.
   - `setRecoveryPassword(db, recoveryPassword)`:
     - Rejects non-strings or `< 6` chars (`typeof recoveryPassword !== 'string' || recoveryPassword.length < 6 || recoveryPassword.trim().length < 6`), rejects `'1234'`, and rejects matching the current Manager PIN (`verifyPinHash(getManagerPinHash(db), recoveryPassword).ok`).
     - Writes `recovery_password_hash` and resets `recovery_failed_attempts` / `recovery_lockout_until` to `0`.
   - Add `recovery: { attempts: 'recovery_failed_attempts', lockout: 'recovery_lockout_until', ms: 15 * 60 * 1000, what: 'PIN recovery' }` to `PIN_NAMESPACES` so recovery attempts cannot freeze counter logins.
   - `recoverManagerPin(db, recoveryPassword, newPin)`:
     1. If `!hasRecoveryPassword(db)`, throw Error (`statusCode = 400`, `'No recovery password is set on this workstation.'`).
     2. Check `recovery` lockout (`429` if locked).
     3. Verify `recoveryPassword` against `recovery_password_hash`; on mismatch increment attempts (`429` after 5 tries for 15 min) and return `{ ok: false }` (or throw `403` in route).
     4. Validate `newPin` (`^\d{4,}$` and not `'1234'`).
     5. Update `manager_pin_hash = hashPin(newPin)`, clear `pin_failed_attempts`, `pin_lockout_until`, `report_pin_failed_attempts`, `report_pin_lockout_until`, `recovery_failed_attempts`, `recovery_lockout_until`, clear `_defaultPinCache.delete(db)`, and rotate `report_token` + `report_token_expires_at`.

3. **HTTP Routes (`src/server.js`):**
   - Add `/api/auth/recovery-status` and `/api/auth/recover-pin` to `licenseExempt` (both already match `sessionExempt` via `pathname.startsWith('/api/auth/')`).
   - `GET /api/license/status`: also include `service_mode: isServiceMode`.
   - `GET /api/auth/recovery-status`: returns `200 { configured: hasRecoveryPassword(db) }`.
   - `POST /api/auth/recovery-password`:
     - Guard: `if (session?.type === 'staff' || (!elevated && !isDefaultPin(db))) return elevationDenied();`
     - Validates `{ recovery_password }` is a string; runs `setRecoveryPassword(db, body.recovery_password)` inside `txn(db, ...)` with `audit(db, actor, true, 'security', 'set_recovery_password', {})`; returns `200 { success: true, recovery_password_configured: true }`.
   - `POST /api/auth/recover-pin`:
     - Validates `{ recovery_password, new_pin }` are both strings (`400` otherwise).
     - Runs `recoverManagerPin(...)`. On wrong recovery password: audits `pin_recover_failed` and returns `403 { error: 'Incorrect recovery password' }` (or `429` on lockout).
     - On success: audits `pin_recovered` and returns `200 { success: true, token: issueSessionToken(...), actor: { type: 'manager', id: null, name: 'Manager' }, elevationToken, expiresAt }`.
   - `GET /api/settings` & `POST /api/settings`: include `recovery_password_configured: hasRecoveryPassword(db)`.
   - `GET /api/backup/download`:
     - Guards: `if (!elevated) return elevationDenied();` and `if (isDefaultPin(db)) return factoryPinDenied();`.
     - Reads optional `?file=<name>`; validates same strict basename regex (`/^(shop-|shop_backup_).*\.db$/` + `path.basename(name) === name`) as `/api/backup/restore` (or defaults to newest valid `.db` snapshot in `backupDir`; `404` if none exist), checks `verifyBackupFile(source)`, logs `audit(db, session, true, 'system', 'backup_download', { file: name })`, and serves bytes with `Content-Type: application/octet-stream`, `Content-Disposition: attachment; filename="<name>"`, `Cache-Control: no-store`.
   - `POST /api/system/shutdown`: when `isServiceMode` is true, refuse shutdown (`400 { error: 'Background server stays active in installed mode. Close the POS window instead.' }`).

### 5.2 Frontend UI (`public/index.html`, `public/js/auth.js`, `public/js/main.js`, `public/js/views/backoffice.js`)

1. **First-Run Shop Setup (`#pin-setup-overlay`):**
   - Add `Recovery Password *` and `Confirm Recovery Password *` masked inputs (`minlength="6"`).
   - Required on `Save & Launch Shop` (`submitPinSetup()`). After `change-pin` succeeds and returns `token` + `elevationToken`, `submitPinSetup()` calls `POST /api/auth/recovery-password` (guarded by `pinSetupRecoverySaved` flag for clean retries).
   - When running in `service_mode` (installed workstation), hide `Keep factory PIN (1234) / Skip` so installed shops cannot skip into `!configured`; keep `Skip` visible only in non-service dev/test runs.

2. **Settings → Staff & Security (`data-settings-pane="staff"`):**
   - Add a **Manager Recovery Password** section showing status (`Configured` / `Not set`), masked `New Recovery Password` + `Confirm Recovery Password` inputs, and a `Save Recovery Password` button (uses `requireManagerPin` if elevation lapsed).
   - If the manager saves a new Manager PIN in Settings while `!recoveryConfigured`, require setting the Recovery Password in the Settings UI before completing (leaving backend `POST /api/auth/change-pin` compatible with API tests).

3. **Manager Login Gate (`#login-gate-pin-row`):**
   - Show a `"Forgot PIN?"` button only when Manager role is selected (`!S.loginGateTarget.isManual && S.loginGateTarget.staffId === null`).
   - Clicking `"Forgot PIN?"` calls `GET /api/auth/recovery-status`:
     - If `configured`: switches to inline recovery inputs (`Recovery Password`, `New Manager PIN`, `Confirm New PIN`, `Reset PIN`, `Cancel`), calls `POST /api/auth/recover-pin`, stores returned `sessionToken` + `elevationToken`, closes login gate, and logs Manager in.
     - If `!configured`: shows plain-English notice (`No recovery password is saved on this workstation yet. Contact TechParts support with the shop's Windows Administrator.`) — never references missing local `scripts/set-pin.js`.

4. **Service-Mode Window Exit & USB Backup Download (`public/index.html`, `public/js/main.js`, `public/js/views/backoffice.js`):**
   - Store `service_mode` boolean from `/api/license/status`. When `service_mode` is true:
     - Relabel the counter exit button (`[data-action="shutdown"]`) to **"Close POS"**; clicking `shutdownServer()` skips Manager PIN / `/api/system/shutdown`, shows a clean *"POS Window Closed (background server stays active; use the TechParts POS desktop shortcut to reopen)"* screen, and calls `window.close()`.
     - Update stalled update log tip in `showUpdateHandoffStalled` so it doesn't send users hunting in `%LOCALAPPDATA%` when updates stage in `ProgramData`.
   - In Settings → Data (`public/index.html`), add `<button type="button" class="btn-mini" data-action="download-backup">Download copy</button>` beside `Back up now` & `Restore from backup`. `downloadBackup()` requires Manager PIN elevation, triggers `POST /api/backup` for a fresh snapshot, and downloads it via `downloadCsvFile('/api/backup/download?file=...', file)`.

### 5.3 Service Mode, Launcher Mode & Data Paths (`src/db.js`, `src/server.js`, `src/updater.js`, `scripts/mirror-backups.js`)

1. **Data Home Resolution (`src/db.js`):**
   - Keep `if (isReleaseShaped(base) || !isDirWritable(base))` intact for `tests/db.test.js` and dev (`node src/server.js`) runs.
   - Add `isProgramFilesPath(dir)` (matches `\Program Files\` / `\Program Files (x86)\` segments).
   - When `isProgramFilesPath(base)` is true (even if run as Admin where `isDirWritable` would be true), force fallback to `C:\ProgramData\TechPartsPOS` (`path.join(process.env.ProgramData || process.env.ALLUSERSPROFILE || 'C:\\ProgramData', 'TechPartsPOS')`).
   - Keep `isReleaseShaped(base) || !isDirWritable(base)` falling back to `%LOCALAPPDATA%\TechPartsPOS` for non-`Program Files` portable/release tests.

2. **`--service` Mode vs Desktop Launcher Mode (`src/server.js`):**
   - Detect `const isServiceMode = process.argv.includes('--service');` and `const isInstalledExe = process.argv[1]?.toLowerCase().endsWith('.exe') && isProgramFilesPath(path.dirname(process.execPath));`.
   - **When `isServiceMode` is true:**
     - Run headless (`NO_AUTO_BROWSER=1`, `NO_AUTO_EXIT=1`) on safe loopback default `HOST = process.env.HOST || '127.0.0.1'` (no `0.0.0.0` / LAN report exposure).
     - Write runtime info to `path.join(getBaseDir(), 'runtime', 'server.json')` (`{ pid: process.pid, port: currentPort }`) once listening, and remove/clear on clean exit (`SIGINT`, `SIGTERM`, `SIGBREAK`, `exit`).
     - Place `server.lock` in `path.join(getBaseDir(), 'runtime', 'server.lock')` (not `SYSTEM`'s `%LOCALAPPDATA%`).
   - **When running as an installed `.exe` WITHOUT `--service` (Desktop / Start Menu shortcut = Launcher Mode):**
     - Do **not** call `createServer()`, `initDb()`, or `startServer()` (never touch `shop.db` from the interactive user session).
     - Read `port` from `C:\ProgramData\TechPartsPOS\runtime\server.json` (fallback `3000..3005`) and probe `http://127.0.0.1:<port>/api/license/status`.
     - Wait briefly (~1.5s if just booted/signing in), and if still unreachable attempt `schtasks /Run /TN "TechPartsPOS-Server"` once (works for Admins; harmless on Standard accounts), polling up to 8 seconds total for `GET /api/license/status` to answer `200`.
     - Once reachable, call `launchBrowser('http://localhost:' + port)` using the interactive user's `%LOCALAPPDATA%\TechPartsPOS\browser-profile`, then exit `0`.
     - If still unreachable after timeout, display a clean Windows MessageBox (via `powershell.exe` `MessageBox`) telling the user to restart Windows or ask the shop's Windows Administrator to check `TechPartsPOS-Server`, and exit `1`.
   - **Browser Profile Path (`src/server.js` `launchBrowser`):**
     - Always store `browser-profile` in `path.join(process.env.LOCALAPPDATA || getBaseDir(), 'TechPartsPOS', 'browser-profile')` when `process.env.LOCALAPPDATA` exists (in dev/test or launcher mode), keeping Edge's cache/profile in each Windows user's own folder and out of `SYSTEM`'s locked `ProgramData` directory.

3. **Service-Aware In-App Auto-Updater (`src/updater.js`):**
   - Pass `isServiceMode` (`process.argv.includes('--service')`) awareness into `applyUpdateInner`:
     - Use `path.join(getBaseDir(), 'updates')` as `stagingDir` in `--service` mode (and `consumeHandoffStatus` reads from the same `updates` dir at boot).
     - In `buildApplyScript`, when `serviceMode` is true, after swapping `TechPartsPOS.exe` and waiting for `.old` deletion, restart via `schtasks /Run /TN "TechPartsPOS-Server"` (instead of `start "" "${winExe}"`).
     - In `server.js` `/api/system/update/apply`, exit normally once `apply_update.cmd` is spawned so Task Scheduler / the helper completes the swap and relaunches `TechPartsPOS-Server` (even when requested from a Standard cashier's browser UI after Manager PIN elevation inside the POS app).

4. **Backup Mirroring (`scripts/mirror-backups.js`):**
   - Check `C:\ProgramData\TechPartsPOS\data\shop.db` first, then `%LOCALAPPDATA%\TechPartsPOS\data\shop.db`, then `getBaseDir()` (unless `POS_BACKUP_DIR` is set).

### 5.4 Windows Installer & Release Pipeline (`installer/TechPartsPOS.iss`, `scripts/build-installer.js`, `scripts/publish-release.ps1`, `README.md`)

1. **`installer/TechPartsPOS.iss`:**
   - `DefaultDirName={autopf}\TechPartsPOS`, **`DisableDirPage=yes`** (always install in `Program Files` so `isProgramFilesPath()` protection never breaks), `PrivilegesRequired=admin`, `HKLM` Edge policies kept, empty `[UninstallDelete]` on `ProgramData` (never removes `C:\ProgramData\TechPartsPOS`).
   - **Pre-install / Pre-uninstall stop:** In `[Code]` (`PrepareToInstall` / `InitializeUninstall`), stop `TechPartsPOS-Server` (`schtasks /End /TN "TechPartsPOS-Server"`) and wait cleanly up to 5s for `TechPartsPOS.exe` to exit before copying or deleting files (with fallback cleanup only if still stuck after 5s).
   - **Create & Lock `C:\ProgramData\TechPartsPOS`:**
     - Create `C:\ProgramData\TechPartsPOS\{data,backups,updates,runtime}`.
     - Lock root folder with `icacls "{commonappdata}\TechPartsPOS" /inheritance:r /grant:r *S-1-5-18:(OI)(CI)F` (`NT AUTHORITY\SYSTEM` Full Control ONLY—removes `Users` and `Administrators` ACEs so Explorer/CMD sessions get **Access Denied**).
     - Grant read-only on `runtime\` for launcher discovery: `icacls "{commonappdata}\TechPartsPOS\runtime" /inheritance:r /grant:r *S-1-5-18:(OI)(CI)F /grant *S-1-5-32-545:(OI)(CI)R`.
     - Mark `C:\ProgramData\TechPartsPOS` hidden+system (`attrib +h +s "{commonappdata}\TechPartsPOS"`) as an extra visual layer.
   - **Register & Start Native Scheduled Task (`TechPartsPOS-Server`):**
     - Write a temporary Task Scheduler XML file configuring:
       - Principal: `<UserId>S-1-5-18</UserId>` (`NT AUTHORITY\SYSTEM`), `<RunLevel>HighestAvailable</RunLevel>`.
       - Triggers: **BOTH** `<BootTrigger><Enabled>true</Enabled></BootTrigger>` **AND** `<LogonTrigger><Enabled>true</Enabled></LogonTrigger>` (no `<UserId>` filter so Windows 10/11 Fast Startup and Standard cashier logins still ensure `TechPartsPOS-Server` is running).
       - Settings: `<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>`, `<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>`, `<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>`, `<RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure>`, `<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>`.
       - Action: `"{app}\TechPartsPOS.exe"` with arguments `--service`.
     - Import via `schtasks /Create /TN "TechPartsPOS-Server" /XML "<xml>" /F`, delete the temp XML, and start immediately via `schtasks /Run /TN "TechPartsPOS-Server"`.
   - **Uninstaller:** Stop & remove `TechPartsPOS-Server` (`schtasks /End` + `schtasks /Delete /TN "TechPartsPOS-Server" /F`) and remove `{app}` (`C:\Program Files\TechPartsPOS`) only—leaving `C:\ProgramData\TechPartsPOS` completely untouched.
   - **Desktop / Start Menu `[Icons]`:** Launch `{app}\TechPartsPOS.exe` (launcher mode; does NOT launch `--service`).
   - **Post-install `[Run]`:** Launch `{app}\TechPartsPOS.exe` (launcher mode, waits for `TechPartsPOS-Server` and opens the POS UI).

2. **Build & Publish Scripts (`scripts/build-installer.js`, `scripts/publish-release.ps1`, `README.md`):**
   - `scripts/build-installer.js`: read version from `package.json` instead of defaulting to `1.0.0`, and detect **Inno Setup 7** (`C:\Program Files\Inno Setup 7\ISCC.exe`, `C:\Program Files (x86)\Inno Setup 7\ISCC.exe`, `%LOCALAPPDATA%\Programs\Inno Setup 7\ISCC.exe`) in addition to Inno Setup 6/5.
   - `scripts/publish-release.ps1`: build `TechPartsPOS-Setup-<version>.exe` (using Inno Setup 7 or 6; fail clearly if missing), remove `.zip` packaging/upload, and upload `TechPartsPOS-Setup-<version>.exe` alongside `TechPartsPOS.exe` and `TechPartsPOS.exe.sha256` (still used by in-app auto-updater).
   - `README.md`: update Download & Installation to point strictly to `TechPartsPOS-Setup-<version>.exe` (no portable `.zip`), and add a concise **Shop PC Security Setup (Owner Admin + Cashier Standard Account)** section.

---

## 6. What's Left to the Builder

- Exact HTML/CSS markup for Recovery Password fields in `#pin-setup-overlay`, Settings → Staff & Security, `#login-gate-pin-row`, and `Download copy` button in Settings → Data (following `AGENTS.md` industrial UI guidelines + `npm run build:css`).
- Exact PowerShell/MessageBox fallback string if launcher cannot reach `TechPartsPOS-Server`.
- Comprehensive unit & integration tests covering:
  - `src/auth.js` & `src/settings.js`: recovery password hashing, validation, 5-try/15-min lockout isolation, `recoverManagerPin` resets, `PRIVATE_SETTINGS` hiding.
  - `src/server.js`: `/api/auth/recovery-status`, `/api/auth/recovery-password`, `/api/auth/recover-pin`, `/api/backup/download` (elevation + factory-PIN gate + traversal/validation + audit), `--service` mode (`service_mode: true`, shutdown refusal, `127.0.0.1` loopback default) vs launcher discovery behavior (mocked/hooked without spawning real `schtasks`/Edge in tests).
  - `src/updater.js`: `serviceMode` staging directory + `buildApplyScript` `schtasks /Run` command generation + `consumeHandoffStatus`.
  - `src/db.js`: `isProgramFilesPath` routing to `C:\ProgramData\TechPartsPOS` while keeping `tests/db.test.js` invariants intact.
  - Verification of `installer/TechPartsPOS.iss` (`DisableDirPage=yes`, `<LogonTrigger>`, Task Scheduler XML/icacls) & `scripts/build-installer.js` / `scripts/publish-release.ps1` updates (plus installing Inno Setup 7 on this build PC before compiling `Setup.exe`).
