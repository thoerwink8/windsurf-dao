@echo off
REM GitHub MCP v3: direct node execution (bypasses npx to avoid NODE_OPTIONS infection)
REM Token loaded from environment variable GITHUB_PERSONAL_ACCESS_TOKEN
if "%GITHUB_PERSONAL_ACCESS_TOKEN%"=="" echo ERROR: Set GITHUB_PERSONAL_ACCESS_TOKEN env var first && exit /b 1

REM Pre-check: Clash proxy must be running for GitHub API access in China
powershell -NoProfile -Command "exit ([int](-not (Test-NetConnection -ComputerName 127.0.0.1 -Port 7890 -WarningAction SilentlyContinue -InformationLevel Quiet)))"
if %ERRORLEVEL% NEQ 0 (
    echo WARNING: Clash proxy not detected on 127.0.0.1:7890, GitHub API may fail
)

REM Route through Clash proxy for GitHub API access
set HTTPS_PROXY=http://127.0.0.1:7890
set HTTP_PROXY=http://127.0.0.1:7890
REM Resolve global npm root dynamically (works with nvm4w and standard npm)
for /f "delims=" %%i in ('npm root -g') do set "NPM_ROOT=%%i"
REM Allow require() to find global modules (undici for proxy bootstrap)
set NODE_PATH=%NPM_ROOT%
REM Run server directly with proxy bootstrap (only this process gets fetch patch)
node --require "%~dp0github-proxy-bootstrap.js" "%NPM_ROOT%\@modelcontextprotocol\server-github\dist\index.js" %*
