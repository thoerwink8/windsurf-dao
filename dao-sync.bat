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
where gh >nul 2>nul
if errorlevel 1 (
  echo [提醒] 缺少 GitHub CLI ^(gh^)，上行/下行不可用。安装：winget install GitHub.cli
) else (
  gh auth status >nul 2>nul
  if errorlevel 1 (
    echo [提醒] gh 未登录，上行/下行不可用。运行：gh auth login
  )
)
where uvx >nul 2>nul
if errorlevel 1 (
  echo [提醒] 缺少 uvx ^(uv^)，MCP 同步不可用。安装：powershell -c "irm https://astral.sh/uv/install.ps1 ^| iex"
)
node "%~dp0config-sync\lib\sync.mjs" %*
echo.
pause
