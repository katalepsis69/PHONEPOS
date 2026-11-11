; ============================================================
; TechParts POS - Windows Installer (Inno Setup 7 / 6)
; ============================================================
; Packages the verified single-file portable exe produced by
; `npm run build:exe` into a Setup.exe.
;
; Build the installer:
;   1. npm run build:exe          (produces release\customer\TechPartsPOS.exe)
;   2. npm run build:installer    (or run ISCC.exe manually, see below)
;
; Inno Setup 7: https://jrsoftware.org/isinfo.php
; Default ISCC location: %LOCALAPPDATA%\Programs\Inno Setup 7\ISCC.exe
; ============================================================

#define MyAppName "TechParts POS & Repair System"
; Rewritten by scripts/publish-release.ps1 on every release; keep it equal to
; package.json's version and src/updater.js's CURRENT_VERSION.
#ifndef MyAppVersion
#define MyAppVersion "2.8"
#endif
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
DisableDirPage=yes
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
; Do not uninstall shop data: the app stores it in {commonappdata}\TechPartsPOS
; ({commonappdata}\TechPartsPOS\data\shop.db). It is never touched by the
; uninstaller (only {app} files are removed).
UninstallFilesDir={app}

[Dirs]
Name: "{commonappdata}\TechPartsPOS"; Flags: uninsneveruninstall
Name: "{commonappdata}\TechPartsPOS\data"; Flags: uninsneveruninstall
Name: "{commonappdata}\TechPartsPOS\backups"; Flags: uninsneveruninstall
Name: "{commonappdata}\TechPartsPOS\updates"; Flags: uninsneveruninstall
Name: "{commonappdata}\TechPartsPOS\runtime"; Flags: uninsneveruninstall

[Files]
; Ship the verified customer release exe (built by scripts/release-customer.js).
Source: "..\release\customer\{#MyAppExeName}"; DestDir: "{app}"; Flags: ignoreversion; AfterInstall: WriteServiceTaskXml

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{group}\Uninstall {#MyAppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[Run]
Filename: "{sys}\icacls.exe"; Parameters: """{commonappdata}\TechPartsPOS"" /inheritance:r /grant:r ""*S-1-5-18:(OI)(CI)F"""; Flags: runhidden waituntilterminated
; The three data subdirs above are created by [Dirs] BEFORE this section runs,
; and icacls without /T does not re-ACL existing children, so each one needs
; its own SYSTEM-only grant or it keeps ProgramData's Users read inheritance.
Filename: "{sys}\icacls.exe"; Parameters: """{commonappdata}\TechPartsPOS\data"" /inheritance:r /grant:r ""*S-1-5-18:(OI)(CI)F"""; Flags: runhidden waituntilterminated
Filename: "{sys}\icacls.exe"; Parameters: """{commonappdata}\TechPartsPOS\backups"" /inheritance:r /grant:r ""*S-1-5-18:(OI)(CI)F"""; Flags: runhidden waituntilterminated
Filename: "{sys}\icacls.exe"; Parameters: """{commonappdata}\TechPartsPOS\updates"" /inheritance:r /grant:r ""*S-1-5-18:(OI)(CI)F"""; Flags: runhidden waituntilterminated
Filename: "{sys}\icacls.exe"; Parameters: """{commonappdata}\TechPartsPOS\runtime"" /inheritance:r /grant:r ""*S-1-5-18:(OI)(CI)F"" /grant ""*S-1-5-32-545:(OI)(CI)R"""; Flags: runhidden waituntilterminated
Filename: "{sys}\attrib.exe"; Parameters: "+h +s ""{commonappdata}\TechPartsPOS"""; Flags: runhidden waituntilterminated
Filename: "{sys}\schtasks.exe"; Parameters: "/Create /TN ""TechPartsPOS-Server"" /XML ""{tmp}\TechPartsPOS-Server.xml"" /F"; Flags: runhidden waituntilterminated
Filename: "{sys}\schtasks.exe"; Parameters: "/Run /TN ""TechPartsPOS-Server"""; Flags: runhidden waituntilterminated
Filename: "{app}\{#MyAppExeName}"; Description: "{cm:LaunchProgram,{#StringChange(MyAppName, '&', '&&')}}"; Flags: nowait postinstall skipifsilent

[UninstallRun]
Filename: "{sys}\schtasks.exe"; Parameters: "/End /TN ""TechPartsPOS-Server"""; Flags: runhidden; RunOnceId: "EndServerTask"
Filename: "{sys}\schtasks.exe"; Parameters: "/Delete /TN ""TechPartsPOS-Server"" /F"; Flags: runhidden; RunOnceId: "DeleteServerTask"

[UninstallDelete]
; Never delete shop database or backups.

[Registry]
; Enforce Edge kiosk policies on the POS machine so OS account sync & first-run nag screens never trigger
Root: HKLM; Subkey: "SOFTWARE\Policies\Microsoft\Edge"; ValueType: dword; ValueName: "ImplicitSignInEnabled"; ValueData: "0"; Flags: uninsdeletevalue
Root: HKLM; Subkey: "SOFTWARE\Policies\Microsoft\Edge"; ValueType: dword; ValueName: "SyncDisabled"; ValueData: "1"; Flags: uninsdeletevalue
Root: HKLM; Subkey: "SOFTWARE\Policies\Microsoft\Edge"; ValueType: dword; ValueName: "HideFirstRunExperience"; ValueData: "1"; Flags: uninsdeletevalue
Root: HKLM; Subkey: "SOFTWARE\Policies\Microsoft\Edge"; ValueType: dword; ValueName: "ShowRecommendationsEnabled"; ValueData: "0"; Flags: uninsdeletevalue
Root: HKLM; Subkey: "SOFTWARE\Policies\Microsoft\Edge"; ValueType: dword; ValueName: "PasswordManagerEnabled"; ValueData: "0"; Flags: uninsdeletevalue
Root: HKLM; Subkey: "SOFTWARE\Policies\Microsoft\Edge"; ValueType: dword; ValueName: "TranslateEnabled"; ValueData: "0"; Flags: uninsdeletevalue
Root: HKLM; Subkey: "SOFTWARE\Policies\Microsoft\Edge"; ValueType: dword; ValueName: "DeveloperToolsAvailability"; ValueData: "0"; Flags: uninsdeletevalue
Root: HKLM; Subkey: "SOFTWARE\Policies\Microsoft\Edge"; ValueType: dword; ValueName: "QuickSearchShowMiniMenu"; ValueData: "0"; Flags: uninsdeletevalue
Root: HKLM; Subkey: "SOFTWARE\Policies\Microsoft\Edge"; ValueType: dword; ValueName: "WebWidgetAllowed"; ValueData: "0"; Flags: uninsdeletevalue
Root: HKLM; Subkey: "SOFTWARE\Policies\Microsoft\Edge"; ValueType: dword; ValueName: "HubsSidebarEnabled"; ValueData: "0"; Flags: uninsdeletevalue
Root: HKLM; Subkey: "SOFTWARE\Policies\Microsoft\Edge"; ValueType: dword; ValueName: "AutofillAddressEnabled"; ValueData: "0"; Flags: uninsdeletevalue
Root: HKLM; Subkey: "SOFTWARE\Policies\Microsoft\Edge"; ValueType: dword; ValueName: "AutofillCreditCardEnabled"; ValueData: "0"; Flags: uninsdeletevalue

[Code]
function XmlEscape(const S: String): String;
begin
  Result := S;
  StringChangeEx(Result, '&', '&amp;', True);
  StringChangeEx(Result, '<', '&lt;', True);
  StringChangeEx(Result, '>', '&gt;', True);
  StringChangeEx(Result, '"', '&quot;', True);
  StringChangeEx(Result, '''', '&apos;', True);
end;

procedure WriteServiceTaskXml();
var
  XmlPath: String;
  ExePath: String;
  AppDir: String;
  Lines: TArrayOfString;
begin
  XmlPath := ExpandConstant('{tmp}\TechPartsPOS-Server.xml');
  ExePath := XmlEscape(ExpandConstant('{app}\TechPartsPOS.exe'));
  AppDir := XmlEscape(ExpandConstant('{app}'));

  SetArrayLength(Lines, 42);
  Lines[0] := '<?xml version="1.0" encoding="UTF-8"?>';
  Lines[1] := '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">';
  Lines[2] := '  <RegistrationInfo>';
  Lines[3] := '    <Description>TechParts POS Background Service</Description>';
  Lines[4] := '  </RegistrationInfo>';
  Lines[5] := '  <Triggers>';
  Lines[6] := '    <BootTrigger>';
  Lines[7] := '      <Enabled>true</Enabled>';
  Lines[8] := '    </BootTrigger>';
  Lines[9] := '    <LogonTrigger>';
  Lines[10] := '      <Enabled>true</Enabled>';
  Lines[11] := '    </LogonTrigger>';
  Lines[12] := '  </Triggers>';
  Lines[13] := '  <Principals>';
  Lines[14] := '    <Principal id="Author">';
  Lines[15] := '      <UserId>S-1-5-18</UserId>';
  Lines[16] := '      <RunLevel>HighestAvailable</RunLevel>';
  Lines[17] := '    </Principal>';
  Lines[18] := '  </Principals>';
  Lines[19] := '  <Settings>';
  Lines[20] := '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>';
  Lines[21] := '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>';
  Lines[22] := '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>';
  Lines[23] := '    <AllowHardTerminate>true</AllowHardTerminate>';
  Lines[24] := '    <StartWhenAvailable>true</StartWhenAvailable>';
  Lines[25] := '    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>';
  Lines[26] := '    <AllowStartOnDemand>true</AllowStartOnDemand>';
  Lines[27] := '    <Enabled>true</Enabled>';
  Lines[28] := '    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>';
  Lines[29] := '    <RestartOnFailure>';
  Lines[30] := '      <Interval>PT1M</Interval>';
  Lines[31] := '      <Count>999</Count>';
  Lines[32] := '    </RestartOnFailure>';
  Lines[33] := '  </Settings>';
  Lines[34] := '  <Actions Context="Author">';
  Lines[35] := '    <Exec>';
  Lines[36] := '      <Command>' + ExePath + '</Command>';
  Lines[37] := '      <Arguments>--service</Arguments>';
  Lines[38] := '      <WorkingDirectory>' + AppDir + '</WorkingDirectory>';
  Lines[39] := '    </Exec>';
  Lines[40] := '  </Actions>';
  Lines[41] := '</Task>';

  SaveStringsToUTF8File(XmlPath, Lines, False);
end;

procedure StopRunningServiceAndWait();
var
  ResultCode: Integer;
  I: Integer;
  Running: Boolean;
begin
  Exec(ExpandConstant('{sys}\schtasks.exe'), '/End /TN "TechPartsPOS-Server"', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Running := True;
  for I := 1 to 20 do
  begin
    Exec(ExpandConstant('{cmd}'), '/c tasklist /FI "IMAGENAME eq TechPartsPOS.exe" 2>nul | "%SystemRoot%\System32\find.exe" /I "TechPartsPOS.exe" >nul', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    if ResultCode <> 0 then
    begin
      Running := False;
      Break;
    end;
    Sleep(250);
  end;
  if Running then
  begin
    Exec(ExpandConstant('{sys}\taskkill.exe'), '/F /IM TechPartsPOS.exe', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    Sleep(500);
  end;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  StopRunningServiceAndWait();
  Result := '';
end;

function InitializeUninstall(): Boolean;
begin
  StopRunningServiceAndWait();
  Result := True;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  XmlFile: String;
begin
  if CurStep = ssDone then
  begin
    XmlFile := ExpandConstant('{tmp}\TechPartsPOS-Server.xml');
    if FileExists(XmlFile) then
      DeleteFile(XmlFile);
  end;
end;
