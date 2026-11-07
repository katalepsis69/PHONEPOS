@echo off
setlocal enabledelayedexpansion
title TechParts POS ^& Repair System
cls

:: Ensure current working directory is the script directory
cd /d "%~dp0"

echo ======================================================
echo   TechParts Phone Repair POS - Commercial Edition
echo ======================================================
echo.

:: Detect Node.js binary
set "NODE_BIN=node"
where node >nul 2>nul
if %errorlevel% neq 0 (
    if exist "%ProgramFiles%\nodejs\node.exe" (
        set "NODE_BIN=%ProgramFiles%\nodejs\node.exe"
    ) else if exist "%ProgramFiles(x86)%\nodejs\node.exe" (
        set "NODE_BIN=%ProgramFiles(x86)%\nodejs\node.exe"
    ) else if exist "%LocalAppData%\Programs\node\node.exe" (
        set "NODE_BIN=%LocalAppData%\Programs\node\node.exe"
    ) else (
        echo [ERROR] Node.js is not installed or not in PATH!
        echo Please install Node.js v22.5.0 or newer to run this POS system.
        echo Download: https://nodejs.org
        echo.
        pause
        exit /b 1
    )
)

:: Check Node.js version (requires v22.5+ for node:sqlite APIs used here)
for /f "usebackq" %%v in (`"%NODE_BIN%" -v`) do set "RAW_NODE_VER=%%v"
if defined RAW_NODE_VER (
    set "CLEAN_NODE_VER=!RAW_NODE_VER:v=!"
    for /f "delims=." %%a in ("!CLEAN_NODE_VER!") do set "NODE_MAJOR=%%a"
    if defined NODE_MAJOR (
        for /f "tokens=2 delims=." %%b in ("!CLEAN_NODE_VER!") do set "NODE_MINOR=%%b"
        if !NODE_MAJOR! LSS 22 goto :node_too_old
        if !NODE_MAJOR! EQU 22 goto :node_ok
        if !NODE_MINOR! LSS 5 goto :node_too_old
    )
)
:node_ok

echo [*] Starting POS Server on http://localhost:3000...
echo [*] Machine ID for Activation:
"%NODE_BIN%" -e "console.log('    ' + require('./src/license').getMachineId())"
echo.

:: Run server in foreground (it creates data/ + backups/ and opens the browser itself)
:: ponytail: no NO_AUTO_EXIT — watchdog + SIGINT/SIGBREAK handlers handle X-close/heartbeat
if not defined HOST set "HOST=0.0.0.0"
if not defined POS_LAN_REPORT_ACK set "POS_LAN_REPORT_ACK=1"
"%NODE_BIN%" src/server.js
set "SERVER_EXIT=%errorlevel%"

if not "!SERVER_EXIT!"=="0" (
    echo.
    echo [ERROR] Server exited with code !SERVER_EXIT!.
    echo Check pos-crash.log for details.
    echo.
    pause
)
exit /b !SERVER_EXIT!

:node_too_old
echo [ERROR] Detected Node.js !RAW_NODE_VER!, but Node.js v22.5.0 or newer is required.
echo Please update Node.js at https://nodejs.org
pause
exit /b 1
