@echo off
chcp 65001 >nul
where node >nul 2>nul
if errorlevel 1 (
  echo 请先安装 Node.js，然后重新运行本脚本。
  echo.
  pause
  exit /b 1
)
node "%~dp0lib\desktop-mcp.mjs"
echo.
pause
