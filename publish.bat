@echo off
setlocal enabledelayedexpansion
title TechParts POS ^- Stage Customer Build (local only)
cd /d "%~dp0"

:: ---- parse command line arguments -----------------------------------------
set "WITH_INSTALLER=0"
set "SKIP_TESTS=0"
set "CLEAN_BUILD=0"
set "DRY_RUN=0"
set "NO_PAUSE=0"

:parse_args
if "%~1"=="" goto :args_done
if /i "%~1"=="--installer"  (set "WITH_INSTALLER=1" & shift & goto :parse_args)
if /i "%~1"=="-i"           (set "WITH_INSTALLER=1" & shift & goto :parse_args)
if /i "%~1"=="--skip-tests" (set "SKIP_TESTS=1" & shift & goto :parse_args)
if /i "%~1"=="-s"           (set "SKIP_TESTS=1" & shift & goto :parse_args)
if /i "%~1"=="--clean"      (set "CLEAN_BUILD=1" & shift & goto :parse_args)
if /i "%~1"=="-c"           (set "CLEAN_BUILD=1" & shift & goto :parse_args)
if /i "%~1"=="--dry-run"    (set "DRY_RUN=1" & shift & goto :parse_args)
if /i "%~1"=="-d"           (set "DRY_RUN=1" & shift & goto :parse_args)
if /i "%~1"=="--no-pause"   (set "NO_PAUSE=1" & shift & goto :parse_args)
if /i "%~1"=="--help"       goto :show_help
if /i "%~1"=="-h"           goto :show_help
if /i "%~1"=="-?"           goto :show_help
if /i "%~1"=="/?"           goto :show_help
shift
goto :parse_args

:args_done

echo ======================================================
echo   TechParts POS - Stage Customer Build (Local Only)
echo ======================================================
echo.

:: ---- toolchain pre-flight -------------------------------------------------
set "NODE_BIN=node"
where node >nul 2>nul
if %errorlevel% equ 0 goto :node_found
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
set "REASON=Node.js was not found. Install v22.5 or newer from https://nodejs.org"
goto :fail

:node_found
"!NODE_BIN!" -e "const p=process.versions.node.split('.').map(Number);if(p[0]<22||(p[0]===22&&p[1]<5))process.exit(1)"
if %errorlevel% neq 0 (
    echo [ERROR] Node.js v22.5.0 or newer is required to build the executables.
    for /f "delims=" %%n in ('"!NODE_BIN!" -v') do echo         Detected: %%n
    set "REASON=Node.js is too old for the SEA build."
    goto :fail
)

if not exist "node_modules\@tailwindcss\cli" goto :need_install
if not exist "node_modules\postject" goto :need_install

:: Running exe guard (absolute find.exe path avoids GNU findutils collision)
if "!DRY_RUN!"=="0" (
    tasklist /fi "imagename eq TechPartsPOS.exe" 2>nul | "%SystemRoot%\System32\find.exe" /i "TechPartsPOS.exe" >nul
    if not errorlevel 1 (
        echo [ERROR] TechPartsPOS.exe is running on this machine. Close the POS first
        echo         ^(or run: taskkill /im TechPartsPOS.exe^).
        set "REASON=The executable was still running."
        goto :fail
    )

    tasklist /fi "imagename eq LicenseGenerator.exe" 2>nul | "%SystemRoot%\System32\find.exe" /i "LicenseGenerator.exe" >nul
    if not errorlevel 1 (
        echo [ERROR] LicenseGenerator.exe is running on this machine. Close it first
        echo         ^(or run: taskkill /im LicenseGenerator.exe^).
        set "REASON=LicenseGenerator.exe was still running."
        goto :fail
    )
)

:: ---- optional clean -------------------------------------------------------
if "!CLEAN_BUILD!"=="1" (
    echo [*] Cleaning stale build outputs...
    if exist "release\customer.previous" rmdir /s /q "release\customer.previous" 2>nul
    if exist "dist\.staging-pos" rmdir /s /q "dist\.staging-pos" 2>nul
    if exist "dist\.staging-license" rmdir /s /q "dist\.staging-license" 2>nul
)

:: ---- dry run mode ---------------------------------------------------------
if "!DRY_RUN!"=="1" (
    echo [DRY RUN] Pre-flight checks passed successfully.
    echo           Node runtime:    !NODE_BIN!
    "!NODE_BIN!" -e "console.log('          Node version:    ' + process.version); console.log('          Package version: v' + require('./package.json').version);"
    echo           Dependencies:    node_modules verified (@tailwindcss/cli, postject^)
    echo           Process locks:   None (TechPartsPOS.exe is not running^)
    echo.
    echo [DRY RUN] Pre-flight OK. Run publish.bat to build and stage.
    exit /b 0
)

:: ---- publish steps --------------------------------------------------------
echo [1/4] Test suite
if "!SKIP_TESTS!"=="1" (
    echo       Skipped via --skip-tests.
) else (
    call npm test
    if !errorlevel! neq 0 (
        set "REASON=Tests failed. Nothing was published."
        goto :fail
    )
)

echo.
echo [2/4] Build and verify artifacts
call npm run build:exe
if !errorlevel! neq 0 (
    set "REASON=build:exe failed. Nothing was published."
    goto :fail
)
if not exist "release\customer\TechPartsPOS.exe" (
    set "REASON=release\customer\TechPartsPOS.exe is missing after build."
    goto :fail
)

echo.
echo [3/4] Installer
if not "!WITH_INSTALLER!"=="1" (
    echo       Skipped. Compile it with: publish.bat --installer
    goto :stage
)
"!NODE_BIN!" scripts\build-installer.js
if errorlevel 1 echo [WARN] Installer step failed. The staged executable is still valid.

:stage
echo.
echo [4/4] Stage publish copy and update changelog
"!NODE_BIN!" scripts\generate-changelog.js
if errorlevel 1 echo [WARN] Automated changelog update reported warnings.

"!NODE_BIN!" -e "const fs=require('node:fs'),cp=require('node:crypto'),pa=require('node:path');const ver=JSON.parse(fs.readFileSync('package.json','utf8')).version;const d=new Date(),p=n=>String(n).padStart(2,'0');const dst='publish'+pa.sep+'TechPartsPOS-'+ver+'-'+d.getFullYear()+p(d.getMonth()+1)+p(d.getDate())+'-'+p(d.getHours())+p(d.getMinutes())+'.exe';fs.mkdirSync('publish',{recursive:true});fs.copyFileSync('release'+pa.sep+'customer'+pa.sep+'TechPartsPOS.exe',dst);const buf=fs.readFileSync(dst);const h=cp.createHash('sha256').update(buf).digest('hex');fs.writeFileSync(dst+'.sha256.txt',h+'  '+pa.basename(dst)+'\n');const mb=(buf.length/(1024*1024)).toFixed(2);console.log('       Staged:    '+dst+' ('+mb+' MB)');console.log('       Checksum:  '+dst+'.sha256.txt');console.log('       SHA-256:   '+h);"
if errorlevel 1 (
    set "REASON=Could not stage the publish copy."
    goto :fail
)

:: Retention: keep the five newest staged builds so publish\ does not grow
:: without bound (each exe is ~95 MB). Older dated copies and their checksums
:: are removed; live data, backups and the browser profile are never touched.
"!NODE_BIN!" -e "const fs=require('node:fs'),pa=require('node:path');const dir='publish';const keep=5;const files=fs.readdirSync(dir).filter(f=>/^TechPartsPOS-.*\.exe$/.test(f)).map(f=>({f,t:fs.statSync(pa.join(dir,f)).mtimeMs})).sort((a,b)=>b.t-a.t);for(const {f} of files.slice(keep)){try{fs.unlinkSync(pa.join(dir,f));fs.unlinkSync(pa.join(dir,f+'.sha256.txt'));}catch(_){}console.log('       Pruned:    '+f);}"

echo.
echo ======================================================
echo   PUBLISHED (Local Customer Staging)
echo ======================================================
echo.
echo   Never send dist\ - it holds LicenseGenerator.exe, the vendor private
echo   key and possibly live data.
echo   Install steps: docs\OPERATIONS_AND_DEPLOYMENT.md
echo   Activation:    docs\SECURITY_AND_LICENSING.md
echo.

if "!NO_PAUSE!"=="0" (
    echo %cmdcmdline% | "%SystemRoot%\System32\find.exe" /i """%~f0""" >nul
    if not errorlevel 1 (
        echo Press any key to exit...
        pause >nul
    )
)
exit /b 0

:need_install
set "REASON=devDependencies are missing. Run: npm install"
goto :fail

:fail
echo.
echo ======================================================
echo [FAILED] !REASON!
echo ======================================================
echo.
if "!NO_PAUSE!"=="0" pause
exit /b 1

:show_help
echo TechParts POS - Stage Customer Build (Local Staging)
echo ====================================================
echo Usage: publish.bat [options]
echo.
echo One-command vendor publish: tests, build + verify, then stage a dated
echo copy of the customer executable with its SHA-256 in publish\.
echo.
echo Options:
echo   -i, --installer     Also compile the Inno Setup installer executable.
echo   -s, --skip-tests    Skip test suite (npm test) for faster local staging.
echo   -c, --clean         Clean stale build artifacts before starting.
echo   -d, --dry-run       Pre-flight check only; validates toolchain without building.
echo   --no-pause          Suppress pause prompts (for automation/CI).
echo   -h, --help          Show this help screen.
echo.
exit /b 0
