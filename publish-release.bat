@echo off
setlocal
cd /d "%~dp0"

echo ======================================================
echo   TechParts POS - Publish Release to GitHub
echo ======================================================
echo.
echo Packaging TechPartsPOS.exe, running tests, and publishing
echo the release to GitHub with simple, easy-to-understand
echo release notes for shop owners and cashiers.
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\publish-release.ps1" %*
if errorlevel 1 (
    echo.
    echo [ERROR] Release publishing encountered an error. Check output above.
    pause
    exit /b 1
)

echo.
echo [SUCCESS] Release published successfully!
pause
