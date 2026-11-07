@echo off
setlocal enabledelayedexpansion
title TechParts POS ^- Stage Customer Build (local only)
cls

:: One-command vendor publish: tests, build + verify, then stage a dated copy of
:: the customer executable with its SHA-256. Everything it writes is regenerable
:: build output; live data\ and backups\ are never read.
::
:: Close the POS and stop any `node src/server.js` first: the app is
:: single-instance, so a live one makes the verification boot defer and exit.
::
::   publish.bat                 tests + build + stage
::   publish.bat --installer     also compile the Inno Setup installer

cd /d "%~dp0"

set "WITH_INSTALLER=0"
if /i "%~1"=="--installer" set "WITH_INSTALLER=1"

echo ======================================================
echo   TechParts POS - Stage Customer Build (local only, no release goes out)
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

:: A running exe can be renamed but not replaced; say so before the build starts.
:: find.exe is given by absolute path on purpose. This box has GNU findutils
:: earlier on PATH than C:\Windows\System32, and `find` then resolves to the Unix
:: one, whose /i is not a flag it understands: the pipe dies, errorlevel lands on
:: the wrong branch and the running-executable guard silently stops guarding.
tasklist /fi "imagename eq TechPartsPOS.exe" 2>nul | "%SystemRoot%\System32\find.exe" /i "TechPartsPOS.exe" >nul
if not errorlevel 1 (
    echo [ERROR] TechPartsPOS.exe is running on this machine. Close the POS first
    echo         ^(or run: taskkill /im TechPartsPOS.exe^).
    set "REASON=The executable was still running."
    goto :fail
)

:: ---- publish --------------------------------------------------------------
echo [1/4] Test suite
call npm test
if %errorlevel% neq 0 (
    set "REASON=Tests failed. Nothing was published."
    goto :fail
)

echo.
echo [2/4] Build and verify artifacts
call npm run build:exe
if %errorlevel% neq 0 (
    set "REASON=build:exe failed. Nothing was published."
    goto :fail
)
if not exist "release\customer\TechPartsPOS.exe" (
    set "REASON=release\customer\TechPartsPOS.exe is missing after a green build."
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
:: Version, timestamp, copy and checksum all in one node call: a for /f cannot
:: expand !NODE_BIN! without breaking its own quoting, and this box may have no
:: PowerShell at all.
"!NODE_BIN!" -e "const fs=require('node:fs'),cp=require('node:crypto'),pa=require('node:path');const ver=JSON.parse(fs.readFileSync('package.json','utf8')).version;const d=new Date(),p=n=>String(n).padStart(2,'0');const dst='publish'+pa.sep+'TechPartsPOS-'+ver+'-'+d.getFullYear()+p(d.getMonth()+1)+p(d.getDate())+'-'+p(d.getHours())+p(d.getMinutes())+'.exe';fs.mkdirSync('publish',{recursive:true});fs.copyFileSync('release'+pa.sep+'customer'+pa.sep+'TechPartsPOS.exe',dst);const h=cp.createHash('sha256').update(fs.readFileSync(dst)).digest('hex');fs.writeFileSync(dst+'.sha256.txt',h+'  '+pa.basename(dst)+'\n');console.log('       Staged:    '+dst);console.log('       Checksum:  '+dst+'.sha256.txt');console.log('       SHA-256:   '+h)"
if errorlevel 1 (
    set "REASON=Could not stage the publish copy."
    goto :fail
)

echo.
echo ======================================================
echo   PUBLISHED
echo ======================================================
echo.
echo   Never send dist\ - it holds LicenseGenerator.exe, the vendor private
echo   key and possibly live data. Install steps: docs\OPERATIONS_AND_DEPLOYMENT.md
echo   Activation: docs\SECURITY_AND_LICENSING.md
exit /b 0

:need_install
set "REASON=devDependencies are missing. Run: npm install"
goto :fail

:fail
echo.
echo [FAILED] !REASON!
pause
exit /b 1
