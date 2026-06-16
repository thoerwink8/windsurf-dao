@echo off
chcp 65001 >nul
setx PYTHONUTF8 1 >nul 2>nul
where node >nul 2>nul
if errorlevel 1 (
  echo [预检] 缺少 Node.js，请安装：https://nodejs.org/
  echo.
  pause
  exit /b 1
)
where git >nul 2>nul
if errorlevel 1 (
  echo [预检] 缺少 Git，请安装：https://git-scm.com/download/win
  echo.
  pause
  exit /b 1
)
node "%~dp0config-sync\lib\sync.mjs" %*
echo.
pause
