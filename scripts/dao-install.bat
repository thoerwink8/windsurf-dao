@echo off
chcp 65001 >nul
echo.
echo   dao - windsurf-dao installer
echo   ============================
echo.
echo   Press any key to start, or close window to cancel...
pause >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0_setup\install.ps1" "%~dp0_setup\"
echo.
pause
