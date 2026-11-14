@echo off
setlocal
title TechParts POS ^- Publish Release to GitHub
cd /d "%~dp0"

:: Help and --no-pause check
set "NO_PAUSE="
for %%a in (%*) do (
    if "%%~a"=="--help" goto :show_help
    if "%%~a"=="-h"     goto :show_help
    if "%%~a"=="/?"     goto :show_help
    if "%%~a"=="-?"     goto :show_help
    if "%%~a"=="--no-pause" set "NO_PAUSE=1"
)

echo ======================================================
echo   TechParts POS - Publish Release to GitHub
echo ======================================================
echo.
echo Packaging TechPartsPOS.exe, running tests, and publishing
echo the release to GitHub with simple release notes.
echo.

:: Close any running POS executables instead of refusing: publish must win
:: over a live exe. A settle beat follows so Windows releases the image lock.
taskkill /f /im TechPartsPOS.exe >nul 2>&1 && echo [*] Closed running TechPartsPOS.exe
taskkill /f /im TechPartsPOS_update.exe >nul 2>&1
taskkill /f /im LicenseGenerator.exe >nul 2>&1 && echo [*] Closed running LicenseGenerator.exe
ping -n 3 127.0.0.1 >nul

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\publish-release.ps1" %*
set "EXIT_CODE=%errorlevel%"

if %EXIT_CODE% neq 0 (
    echo.
    echo [ERROR] Release publishing failed ^(exit code %EXIT_CODE%^). Check output above.
    if not defined NO_PAUSE pause
    exit /b %EXIT_CODE%
)

echo.
echo [SUCCESS] Release workflow completed successfully.
if not defined NO_PAUSE (
    echo %cmdcmdline% | "%SystemRoot%\System32\find.exe" /i """%~f0""" >nul
    if not errorlevel 1 pause
)
exit /b 0

:show_help
echo TechParts POS - Publish Release to GitHub
echo =========================================
echo Usage: publish-release.bat [options]
echo.
echo Options:
echo   -d, --dry-run          Validate build, tests, and packaging end-to-end
echo                          without committing, tagging, or publishing to GitHub.
echo   -v, --version ^<ver^>    Specify release version (e.g. 2.9, 3.0.0, patch, minor).
echo   -c, --changelog ^<text^> Specify custom release note or summary text.
echo   -n, --non-interactive  Run in automated batch mode without interactive prompts.
echo   --no-pause             Suppress pause prompts (for automation/CI).
echo   -h, --help             Show this help screen.
echo.
exit /b 0
