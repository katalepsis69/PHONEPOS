; ============================================================
; TechParts POS - Windows Installer (Inno Setup 6)
; ============================================================
; Packages the verified single-file portable exe produced by
; `npm run build:exe` into a Setup.exe.
;
; Build the installer:
;   1. npm run build:exe          (produces release\customer\TechPartsPOS.exe)
;   2. npm run build:installer    (or run ISCC.exe manually, see below)
;
; Inno Setup 6: https://jrsoftware.org/isinfo.php
; Default ISCC location: C:\Program Files (x86)\Inno Setup 6\ISCC.exe
; Command line: "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" installer\TechPartsPOS.iss
; ============================================================

#define MyAppName "TechParts POS & Repair System"
; Rewritten by scripts/publish-release.ps1 on every release; keep it equal to
; package.json's version and src/updater.js's CURRENT_VERSION.
#define MyAppVersion "2.7"
#define MyAppPublisher "TechParts"
#define MyAppExeName "TechPartsPOS.exe"

[Setup]
; A real GUID: the old value carried non-hex characters and was replaced (mojibake comment truncated 2026-11-06).
; Inno treated as an opaque string so installs worked, but GUID-parsing tooling
; saw a malformed value. Changing it now would orphan an existing registration,
; which is why it happens before wide distribution.
AppId={{6F3A9D2C-4B18-47E5-9A21-8C7D5E4B1F63}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={autopf}\TechPartsPOS
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
; The exe carries its own icon; no extra files to ship.
OutputDir=..\dist\installer
OutputBaseFilename=TechPartsPOS-Setup-{#MyAppVersion}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
; Target: any Windows 10/11 x64 machine (Edge is preinstalled there).
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequired=admin
; Do not uninstall shop data: the app stores it next to the exe when
; writable, otherwise in %LOCALAPPDATA%\TechPartsPOS. Neither is touched
; by the uninstaller (only {app} files are removed).
UninstallFilesDir={app}

[Files]
; Ship the verified customer release exe (built by scripts/release-customer.js).
Source: "..\release\customer\{#MyAppExeName}"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{group}\Uninstall {#MyAppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "{cm:LaunchProgram,{#StringChange(MyAppName, '&')}}"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
; Nothing: keep data\ and backups\ so uninstalling never deletes shop data.

[Registry]
; Enforce Edge kiosk policies on the POS machine so OS account sync & first-run nag screens never trigger
Root: HKLM; Subkey: "SOFTWARE\Policies\Microsoft\Edge"; ValueType: dword; ValueName: "ImplicitSignInEnabled"; ValueData: "0"; Flags: uninsdeletevalue
Root: HKLM; Subkey: "SOFTWARE\Policies\Microsoft\Edge"; ValueType: dword; ValueName: "SyncDisabled"; ValueData: "1"; Flags: uninsdeletevalue
Root: HKLM; Subkey: "SOFTWARE\Policies\Microsoft\Edge"; ValueType: dword; ValueName: "HideFirstRunExperience"; ValueData: "1"; Flags: uninsdeletevalue
Root: HKLM; Subkey: "SOFTWARE\Policies\Microsoft\Edge"; ValueType: dword; ValueName: "ShowRecommendationsEnabled"; ValueData: "0"; Flags: uninsdeletevalue
Root: HKLM; Subkey: "SOFTWARE\Policies\Microsoft\Edge"; ValueType: dword; ValueName: "PasswordManagerEnabled"; ValueData: "0"; Flags: uninsdeletevalue
Root: HKLM; Subkey: "SOFTWARE\Policies\Microsoft\Edge"; ValueType: dword; ValueName: "TranslateEnabled"; ValueData: "0"; Flags: uninsdeletevalue
Root: HKLM; Subkey: "SOFTWARE\Policies\Microsoft\Edge"; ValueType: dword; ValueName: "DeveloperToolsAvailability"; ValueData: "2"; Flags: uninsdeletevalue
Root: HKLM; Subkey: "SOFTWARE\Policies\Microsoft\Edge"; ValueType: dword; ValueName: "QuickSearchShowMiniMenu"; ValueData: "0"; Flags: uninsdeletevalue
Root: HKLM; Subkey: "SOFTWARE\Policies\Microsoft\Edge"; ValueType: dword; ValueName: "WebWidgetAllowed"; ValueData: "0"; Flags: uninsdeletevalue
Root: HKLM; Subkey: "SOFTWARE\Policies\Microsoft\Edge"; ValueType: dword; ValueName: "HubsSidebarEnabled"; ValueData: "0"; Flags: uninsdeletevalue
Root: HKLM; Subkey: "SOFTWARE\Policies\Microsoft\Edge"; ValueType: dword; ValueName: "AutofillAddressEnabled"; ValueData: "0"; Flags: uninsdeletevalue
Root: HKLM; Subkey: "SOFTWARE\Policies\Microsoft\Edge"; ValueType: dword; ValueName: "AutofillCreditCardEnabled"; ValueData: "0"; Flags: uninsdeletevalue

