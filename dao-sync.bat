@echo off
chcp 65001 >nul
where node >nul 2>nul
if errorlevel 1 (
  echo 请安 Node.js，后新行脚。
  echo.
  pause
  exit /b 1
)
node "%~dp0config-sync\lib\sync.mjs" %*
echo.
pause
