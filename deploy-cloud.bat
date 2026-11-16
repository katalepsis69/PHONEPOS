@echo off
setlocal
cd /d "%~dp0"

echo ======================================================
echo   TechParts Live - Deploy Cloud Update
echo ======================================================
echo.

set "PIN_ARG=%~1"
if "%PIN_ARG%"=="" set "PIN_ARG=%CLOUD_PIN%"
if "%PIN_ARG%"=="" (
    set /p "PIN_ARG=Enter Cloud Owner PIN (press Enter to sync local cloud-deploy\ only): "
)

echo.
rem The PIN rides stdin, not the command line: argv is visible in the Windows
rem process list while the deploy runs. echo is a cmd builtin, so the value
rem never reaches a child process command line.
echo %PIN_ARG%| node "%~dp0scripts\deploy-cloud.js"
if errorlevel 1 (
    echo.
    echo [ERROR] Cloud deploy failed. Check message above.
    pause
    exit /b 1
)

echo.
echo [SUCCESS] Cloud deploy complete.
pause
