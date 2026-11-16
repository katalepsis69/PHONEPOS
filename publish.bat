@echo off
setlocal EnableExtensions EnableDelayedExpansion
title TechParts POS - Stage Customer Build
rem Manual staging channel: builds a versioned exe + checksum into publish\
rem for hand delivery. The GitHub release pipeline is publish-release.bat;
rem the in-app updater only consumes TechPartsPOS.exe + TechPartsPOS.exe.sha256
rem from a GitHub release, never these staged copies.
cd /d "%~dp0"

set "SKIP_TESTS=0"
set "CLEAN_BUILD=0"
set "DRY_RUN=0"
set "NO_PAUSE=0"

:parse_args
if "%~1"=="" goto :args_done
if /i "%~1"=="--skip-tests" (set "SKIP_TESTS=1"&shift&goto :parse_args)
if /i "%~1"=="-s"           (set "SKIP_TESTS=1"&shift&goto :parse_args)
if /i "%~1"=="--clean"      (set "CLEAN_BUILD=1"&shift&goto :parse_args)
if /i "%~1"=="-c"           (set "CLEAN_BUILD=1"&shift&goto :parse_args)
if /i "%~1"=="--dry-run"    (set "DRY_RUN=1"&shift&goto :parse_args)
if /i "%~1"=="-d"           (set "DRY_RUN=1"&shift&goto :parse_args)
if /i "%~1"=="--no-pause"   (set "NO_PAUSE=1"&shift&goto :parse_args)
if /i "%~1"=="--help" goto :show_help
if /i "%~1"=="-h" goto :show_help
if /i "%~1"=="-?" goto :show_help
if /i "%~1"=="/?" goto :show_help
echo [ERROR] Unknown option: %~1
goto :show_help

:args_done
echo ======================================================
echo   TechParts POS - Stage Customer Build
echo ======================================================
echo.

rem ---- Preflight -----------------------------------------------------------
where node >nul 2>&1
if not errorlevel 1 (
    set "NODE_BIN=node"
    goto :node_found
)
if exist "%ProgramFiles%\nodejs\node.exe" (
    set "NODE_BIN=%ProgramFiles%\nodejs\node.exe"
    goto :node_found
)
if exist "%ProgramFiles(x86)%\nodejs\node.exe" (
    set "NODE_BIN=%ProgramFiles(x86)%\nodejs\node.exe"
    goto :node_found
)
if exist "%LocalAppData%\Programs\node\node.exe" (
    set "NODE_BIN=%LocalAppData%\Programs\node\node.exe"
    goto :node_found
)
set "REASON=Node.js was not found. Install Node.js v22.5 or newer."
goto :fail

:node_found
"!NODE_BIN!" -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=5)?0:1)"
if errorlevel 1 (
    for /f "delims=" %%V in ('"!NODE_BIN!" -v') do echo [ERROR] Detected Node.js %%V; v22.5.0 or newer is required.
    set "REASON=Node.js is too old for the SEA build."
    goto :fail
)

if not exist "node_modules\@tailwindcss\cli" (
    set "REASON=Dependencies are missing. Run npm install."
    goto :fail
)
if not exist "node_modules\postject" (
    set "REASON=Dependencies are missing. Run npm install."
    goto :fail
)

if not exist "package.json" (
    set "REASON=package.json was not found in the project directory."
    goto :fail
)

if "!CLEAN_BUILD!"=="1" if "!DRY_RUN!"=="0" (
    echo [*] Removing known temporary build outputs...
    if exist "release\customer.previous" rmdir /s /q "release\customer.previous"
    if exist "dist\.staging-pos" rmdir /s /q "dist\.staging-pos"
    if exist "dist\.staging-license" rmdir /s /q "dist\.staging-license"
)

if "!DRY_RUN!"=="1" (
    echo [DRY RUN] Pre-flight checks passed successfully.
    "!NODE_BIN!" -e "console.log('Node: '+process.version);console.log('Package: v'+require('./package.json').version)"
    echo           Dependencies:    node_modules verified (@tailwindcss/cli, postject^)
    echo [DRY RUN] No tests, build, changelog, or staging changes were made.
    exit /b 0
)

rem Close running executables before replacing packaged files.
taskkill /f /im TechPartsPOS.exe >nul 2>&1
if not errorlevel 1 echo [*] Closed TechPartsPOS.exe
taskkill /f /im TechPartsPOS_update.exe >nul 2>&1
taskkill /f /im LicenseGenerator.exe >nul 2>&1
if not errorlevel 1 echo [*] Closed LicenseGenerator.exe

rem ---- Build ---------------------------------------------------------------
if "!SKIP_TESTS!"=="1" (
    echo [1/4] Tests skipped by request.
) else (
    echo [1/4] Running tests...
    call npm test
    if errorlevel 1 (
        set "REASON=Tests failed. Nothing was staged."
        goto :fail
    )
)

echo.
echo [2/4] Building and verifying customer executable...
call npm run build:exe
if errorlevel 1 (
    set "REASON=npm run build:exe failed."
    goto :fail
)
if not exist "release\customer\TechPartsPOS.exe" (
    set "REASON=Build output release\customer\TechPartsPOS.exe is missing."
    goto :fail
)

echo.
echo [3/4] Building installer...
"!NODE_BIN!" "scripts\build-installer.js"
if errorlevel 1 (
    set "REASON=Installer compilation failed."
    goto :fail
)

rem Generate/update the changelog. Do NOT use --dry-run here: that only previews.
echo.
echo [4/4] Updating changelog and staging customer build...
if not exist "scripts\generate-changelog.js" (
    set "REASON=scripts\generate-changelog.js is missing."
    goto :fail
)
"!NODE_BIN!" "scripts\generate-changelog.js"
if errorlevel 1 (
    set "REASON=Changelog generation failed. Build was not staged."
    goto :fail
)

"!NODE_BIN!" -e "const fs=require('node:fs'),crypto=require('node:crypto'),path=require('node:path');const version=JSON.parse(fs.readFileSync('package.json','utf8')).version;const d=new Date();const pad=n=>String(n).padStart(2,'0');const name='TechPartsPOS-'+version+'-'+d.getFullYear()+pad(d.getMonth()+1)+pad(d.getDate())+'-'+pad(d.getHours())+pad(d.getMinutes())+'.exe';const dir='publish';const dest=path.join(dir,name);fs.mkdirSync(dir,{recursive:true});fs.copyFileSync(path.join('release','customer','TechPartsPOS.exe'),dest);const hash=crypto.createHash('sha256').update(fs.readFileSync(dest)).digest('hex');fs.writeFileSync(dest+'.sha256.txt',hash+'  '+name+'\n');console.log('Staged: '+dest+' ('+(fs.statSync(dest).size/1048576).toFixed(2)+' MB)');console.log('SHA-256: '+hash)"
if errorlevel 1 (
    set "REASON=Could not stage the customer executable."
    goto :fail
)

rem Keep the five newest staged executables and their matching checksum files.
"!NODE_BIN!" -e "const fs=require('node:fs'),p=require('node:path');const dir='publish';const files=fs.readdirSync(dir).filter(f=>/^TechPartsPOS-.*\.exe$/.test(f)).map(f=>({name:f,time:fs.statSync(p.join(dir,f)).mtimeMs})).sort((a,b)=>b.time-a.time);for(const x of files.slice(5)){fs.rmSync(p.join(dir,x.name),{force:true});fs.rmSync(p.join(dir,x.name+'.sha256.txt'),{force:true});console.log('Pruned: '+x.name)}"

echo.
echo ======================================================
echo   CUSTOMER BUILD STAGED
echo ======================================================
echo.
echo   Customer executable: publish\TechPartsPOS-*.exe
echo   Checksum:            matching .sha256.txt file
echo   Installer:           dist\installer\TechPartsPOS-Setup-*.exe
echo.
echo   Do not distribute dist\; it may contain vendor-only files or live data.
echo   See docs\OPERATIONS_AND_DEPLOYMENT.md for installation instructions.
echo.

if "!NO_PAUSE!"=="0" (
    echo %CMDCMDLINE% | "%SystemRoot%\System32\find.exe" /i """%~f0""" >nul
    if not errorlevel 1 pause
)
exit /b 0

:fail
echo.
echo ======================================================
echo [FAILED] !REASON!
echo ======================================================
if "!NO_PAUSE!"=="0" pause
exit /b 1

:show_help
echo TechParts POS - Stage Customer Build
echo Usage: publish.bat [options]
echo.
echo   -s, --skip-tests  Skip npm test.
echo   -c, --clean       Remove known temporary build outputs.
echo   -d, --dry-run     Run preflight checks only.
echo   --no-pause        Suppress pause prompts.
echo   -h, --help        Show this help.
exit /b 0
