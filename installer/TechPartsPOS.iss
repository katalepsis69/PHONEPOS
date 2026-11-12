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
#define MyAppVersion "1.1"
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
DisableWelcomePage=no
; The exe carries its own icon; no extra files to ship.
OutputDir=..\dist\installer
OutputBaseFilename=TechPartsPOS-Setup-{#MyAppVersion}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
; Brand art is committed static assets; source vector lives in brand/mark.svg.
SetupIconFile=TechPartsPOS.ico
WizardImageFile=wizard-large.bmp
WizardSmallImageFile=wizard-small.bmp
UninstallDisplayIcon={app}\TechPartsPOS.ico
LicenseFile=license.txt
; Setup.exe Properties > Details, so the installer reads as a published product.
VersionInfoVersion={#MyAppVersion}
VersionInfoCompany=TechParts
VersionInfoDescription=TechParts POS & Repair System Setup
VersionInfoProductName=TechParts POS & Repair System
VersionInfoProductVersion={#MyAppVersion}
VersionInfoCopyright=Copyright (c) 2026 TechParts
VersionInfoOriginalFileName=TechPartsPOS-Setup-{#MyAppVersion}.exe
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
Source: "TechPartsPOS.ico"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; IconFilename: "{app}\TechPartsPOS.ico"
Name: "{group}\Uninstall {#MyAppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon; IconFilename: "{app}\TechPartsPOS.ico"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[Messages]
SetupAppTitle=TechParts POS Setup
SetupWindowTitle=Setup - TechParts POS and Repair System
UninstallAppTitle=Uninstall TechParts POS
UninstallAppFullTitle=TechParts POS and Repair System Uninstall
WelcomeLabel1=Welcome to TechParts POS
WelcomeLabel2=This will install TechParts POS and Repair System [version] on this computer.%n%nTechParts POS runs offline as a local background service and opens in your web browser. Your shop records stay on this computer.%n%nIt is recommended that you close all other applications before continuing.
WizardLicense=License and Usage Terms
LicenseLabel=TechParts POS and Repair System, version [version].
LicenseLabel3=You must accept these terms before installing.
LicenseAccepted=I &accept the terms
LicenseNotAccepted=I &do not accept the terms
FinishedHeadingLabel=Completing TechParts POS Setup
FinishedLabel=TechParts POS is installed once for every Windows account on this computer. Do not install it again on a cashier's Windows profile.%n%nIt starts automatically with Windows and opens in your web browser. Your shop database and backups stay on this computer.
FinishedLabelNoIcons=TechParts POS is installed once for every Windows account on this computer. Do not install it again on a cashier's Windows profile.%n%nIt starts automatically with Windows and opens in your web browser. Your shop database and backups stay on this computer.

[Run]
; Lock child folders BEFORE the parent folder so the elevated installer retains
; list/traverse access to ProgramData\TechPartsPOS while configuring children
; and running attrib. Remove temporary Administrators grants from upgrades.
Filename: "{sys}\icacls.exe"; Parameters: """{commonappdata}\TechPartsPOS\data"" /inheritance:r /grant:r ""*S-1-5-18:(OI)(CI)F"" /remove ""*S-1-5-32-544"""; Flags: runhidden waituntilterminated
Filename: "{sys}\icacls.exe"; Parameters: """{commonappdata}\TechPartsPOS\backups"" /inheritance:r /grant:r ""*S-1-5-18:(OI)(CI)F"" /remove ""*S-1-5-32-544"""; Flags: runhidden waituntilterminated
Filename: "{sys}\icacls.exe"; Parameters: """{commonappdata}\TechPartsPOS\updates"" /inheritance:r /grant:r ""*S-1-5-18:(OI)(CI)F"" /remove ""*S-1-5-32-544"""; Flags: runhidden waituntilterminated
Filename: "{sys}\icacls.exe"; Parameters: """{commonappdata}\TechPartsPOS\runtime"" /inheritance:r /grant:r ""*S-1-5-18:(OI)(CI)F"" /grant ""*S-1-5-32-545:(OI)(CI)RX"" /remove ""*S-1-5-32-544"""; Flags: runhidden waituntilterminated
Filename: "{sys}\attrib.exe"; Parameters: "+h +s ""{commonappdata}\TechPartsPOS"""; Flags: runhidden waituntilterminated
Filename: "{sys}\icacls.exe"; Parameters: """{commonappdata}\TechPartsPOS"" /inheritance:r /grant:r ""*S-1-5-18:(OI)(CI)F"" /remove ""*S-1-5-32-544"""; Flags: runhidden waituntilterminated
Filename: "{sys}\schtasks.exe"; Parameters: "/Create /TN ""TechPartsPOS-Server"" /XML ""{tmp}\TechPartsPOS-Server.xml"" /F"; Flags: runhidden waituntilterminated
Filename: "{sys}\schtasks.exe"; Parameters: "/Run /TN ""TechPartsPOS-Server"""; Flags: runhidden waituntilterminated
Filename: "{app}\{#MyAppExeName}"; Description: "{cm:LaunchProgram,{#StringChange(MyAppName, '&', '&&')}}"; Flags: nowait postinstall skipifsilent
Filename: "{win}\explorer.exe"; Parameters: "ms-settings:otherusers"; Description: "Open Windows Account Settings (to add a Cashier Standard User)"; Flags: nowait postinstall skipifsilent unchecked runasoriginaluser; Check: NeedsStandardUserSetup

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
  Lines[0] := '<?xml version="1.0"?>';
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

  SaveStringsToUTF8FileWithoutBOM(XmlPath, Lines, False);
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

procedure GrantTempAdminsAccessIfPresent(const TargetDir: String);
var
  ResultCode: Integer;
begin
  if DirExists(TargetDir) then
  begin
    Exec(ExpandConstant('{sys}\takeown.exe'), '/F "' + TargetDir + '" /A', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    Exec(ExpandConstant('{sys}\icacls.exe'), '"' + TargetDir + '" /grant "*S-1-5-32-544:F"', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  end;
end;

procedure UnlockExistingDataDirForUpgrade();
var
  BaseDir: String;
  ServerStateFile: String;
begin
  BaseDir := ExpandConstant('{commonappdata}\TechPartsPOS');
  if not DirExists(BaseDir) then
    Exit;

  GrantTempAdminsAccessIfPresent(BaseDir);
  GrantTempAdminsAccessIfPresent(BaseDir + '\data');
  GrantTempAdminsAccessIfPresent(BaseDir + '\backups');
  GrantTempAdminsAccessIfPresent(BaseDir + '\updates');
  GrantTempAdminsAccessIfPresent(BaseDir + '\runtime');

  ServerStateFile := BaseDir + '\runtime\server.json';
  if FileExists(ServerStateFile) then
    DeleteFile(ServerStateFile);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  StopRunningServiceAndWait();
  UnlockExistingDataDirForUpgrade();
  Result := '';
end;

function InitializeUninstall(): Boolean;
begin
  StopRunningServiceAndWait();
  Result := True;
end;

var
  StandardUserChecked: Boolean;
  StandardUserExists: Boolean;

function NeedsStandardUserSetup(): Boolean;
var
  PsExe: String;
  Params: String;
  ResultCode: Integer;
begin
  if WizardSilent() then
  begin
    Result := False;
    Exit;
  end;

  if not StandardUserChecked then
  begin
    StandardUserChecked := True;
    StandardUserExists := False;
    PsExe := ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe');
    if FileExists(PsExe) then
    begin
      Params := '-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "' +
        'try { ' +
          '$admins = @((Get-LocalGroupMember -SID ''S-1-5-32-544'' -ErrorAction Stop | Where-Object { $_.SID } | ForEach-Object { $_.SID.Value })); ' +
          '$std = @(Get-LocalUser -ErrorAction Stop | Where-Object { $_.Enabled -and $_.SID -and ($admins -notcontains $_.SID.Value) -and ($_.SID.Value -notmatch ''-(500|501|503|504)$'') }); ' +
          'if ($std.Count -gt 0) { exit 0 } else { exit 1 } ' +
        '} catch { exit 2 }"';
      if Exec(PsExe, Params, '', SW_HIDE, ewWaitUntilTerminated, ResultCode) and (ResultCode = 0) then
        StandardUserExists := True;
    end;
  end;

  Result := not StandardUserExists;
end;

procedure CurPageChanged(CurPageID: Integer);
begin
  if (CurPageID = wpFinished) and (not WizardSilent()) then
  begin
    if NeedsStandardUserSetup() then
    begin
      WizardForm.FinishedLabel.Caption :=
        'TechParts POS is installed once for every Windows account on this computer. Do not install it again on another Windows profile.' + #13#10 + #13#10 +
        'No Standard (non-admin) Windows account was found on this PC. Set one up for cashiers so staff cannot change Windows settings or delete shop files:' + #13#10 +
        '1. Check "Open Windows Account Settings" below, then click Finish (or open Start > Settings > Accounts > Other users).' + #13#10 +
        '2. Add a local account named "Cashier" with account type Standard User.' + #13#10 +
        '3. Sign cashiers into that account and open TechParts POS from the Start menu or Desktop.';
    end
    else
    begin
      WizardForm.FinishedLabel.Caption :=
        'TechParts POS is installed once for every Windows account on this computer. Do not install it again on another Windows profile.' + #13#10 + #13#10 +
        'A Standard (non-admin) Windows account is already on this PC. Cashiers can sign into that account and open TechParts POS from the Start menu or Desktop.' + #13#10 + #13#10 +
        'It starts automatically with Windows, and your shop database and backups stay on this computer.';
    end;

    WizardForm.FinishedLabel.AdjustHeight;
    WizardForm.RunList.Top := WizardForm.FinishedLabel.Top + WizardForm.FinishedLabel.Height + ScaleY(12);
    if WizardForm.FinishedPage.ClientHeight - WizardForm.RunList.Top > ScaleY(44) then
      WizardForm.RunList.Height := WizardForm.FinishedPage.ClientHeight - WizardForm.RunList.Top;
  end;
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
