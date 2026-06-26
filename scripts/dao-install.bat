@echo off
chcp 65001 >nul
echo.
echo   dao - windsurf-dao installer
echo   ============================
echo.
if not exist "%~dp0_setup\install.ps1" (
echo   ERROR: _setup folder not found.
echo.
echo   You are running this inside the zip file.
echo   Please EXTRACT the zip first:
echo     Right-click the zip file -- Extract All -- then run install.bat
echo.
pause
exit /b 1
)
echo   Press any key to start, or close window to cancel...
pause >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0_setup\install.ps1" "%~dp0_setup"
echo.
pause
