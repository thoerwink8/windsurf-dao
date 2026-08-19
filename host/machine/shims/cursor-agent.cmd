@echo off
rem cursor-agent shim: proxy + skip official .cmd (that file launches visible powershell)
rem real binary: %LOCALAPPDATA%\cursor-agent\versions\<latest>\node.exe + index.js
rem Do NOT use for /f in ('dir') or echo|findstr — those spawn a visible cmd window.
rem #648: append --trust when --model given (Workspace Trust prompt blocks new worktrees)
set HTTPS_PROXY=http://127.0.0.1:7890
set HTTP_PROXY=http://127.0.0.1:7890
set ALL_PROXY=http://127.0.0.1:7890
set NODE_USE_ENV_PROXY=1
set "CURSOR_INVOKED_AS=%~nx0"
if not defined NODE_COMPILE_CACHE set "NODE_COMPILE_CACHE=%LOCALAPPDATA%\cursor-compile-cache"
set "CURSOR_HOME=%LOCALAPPDATA%\cursor-agent"
if not exist "%CURSOR_HOME%\versions\" (
  echo cursor-agent: missing "%CURSOR_HOME%\versions" >&2
  exit /b 1
)
set "CURSOR_NODE="
set "CURSOR_INDEX="
dir /b /ad /o-n "%CURSOR_HOME%\versions" > "%TEMP%\cursor-agent-ver.txt" 2>nul
if errorlevel 1 (
  echo cursor-agent: cannot list "%CURSOR_HOME%\versions" >&2
  exit /b 1
)
for /f "usebackq delims=" %%i in ("%TEMP%\cursor-agent-ver.txt") do (
  if exist "%CURSOR_HOME%\versions\%%i\node.exe" if exist "%CURSOR_HOME%\versions\%%i\index.js" (
    set "CURSOR_NODE=%CURSOR_HOME%\versions\%%i\node.exe"
    set "CURSOR_INDEX=%CURSOR_HOME%\versions\%%i\index.js"
    goto :found
  )
)
:found
if not defined CURSOR_NODE (
  echo cursor-agent: no node.exe+index.js under "%CURSOR_HOME%\versions" >&2
  exit /b 1
)
set "CURSOR_ARGS=%*"
if "%CURSOR_ARGS%"=="%CURSOR_ARGS:--model=%" (
  "%CURSOR_NODE%" "%CURSOR_INDEX%" %*
  exit /b %errorlevel%
)
"%CURSOR_NODE%" "%CURSOR_INDEX%" %* --trust
exit /b %errorlevel%
