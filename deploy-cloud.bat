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
node "%~dp0scripts\deploy-cloud.js" "%PIN_ARG%"
if errorlevel 1 (
    echo.
    echo [ERROR] Cloud deploy failed. Check message above.
    pause
    exit /b 1
)

echo.
echo [SUCCESS] Cloud deploy complete.
pause
