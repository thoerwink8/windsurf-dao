@echo off
chcp 65001 >nul
setx PYTHONUTF8 1 >nul 2>nul

set "a=%~1"

REM No args or dashed args → sync path (config-sync interactive menu)
if "%a%"=="" goto sync
if "%a:~0,1%"=="-" goto sync

REM Named action → delegate to dao.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0dao.ps1" %*
set "ACTION_EXIT=%ERRORLEVEL%"
exit /b %ACTION_EXIT%

:sync
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
if not exist "%LOCALAPPDATA%\codegraph\current\lib\dist\bin\codegraph.js" (
  echo [预检] CodeGraph 未安装或不完整，自动安装...
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0dao.ps1" codegraph
)
node "%~dp0config-sync\lib\sync.mjs" %*
set "SYNC_EXIT=%ERRORLEVEL%"
echo.
pause
exit /b %SYNC_EXIT%
