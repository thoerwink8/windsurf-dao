@echo off
rem regrok shim: proxy required (auth endpoint DNS-poisoned) + pin default model grok-4.6
rem real binary: edit GROK_REAL for this machine (example: C:\nvm4w\nodejs\grok.cmd)
rem explicit -m/--model passes through untouched
rem --agent grok 不带 launch 旗标，这里补 --effort xhigh --always-approve
rem Do NOT use echo|findstr — that spawns a visible cmd window.
set "GROK_REAL=C:\nvm4w\nodejs\grok.cmd"
rem proxy: set DAO_PROXY to override (default keeps legacy 7890 behavior)
if not defined DAO_PROXY set "DAO_PROXY=http://127.0.0.1:7890"
set "HTTPS_PROXY=%DAO_PROXY%"
set "GROK_ARGS=%*"
set "GROK_EXTRA="
if "%GROK_ARGS%"=="%GROK_ARGS:--effort=%" set "GROK_EXTRA=%GROK_EXTRA% --effort xhigh"
if "%GROK_ARGS%"=="%GROK_ARGS:--always-approve=%" set "GROK_EXTRA=%GROK_EXTRA% --always-approve"
if not "%GROK_ARGS%"=="%GROK_ARGS:--model=%" goto :passthrough
if not "%GROK_ARGS%"=="%GROK_ARGS:-m =%" goto :passthrough
"%GROK_REAL%" -m grok-4.6%GROK_EXTRA% %*
exit /b %errorlevel%
:passthrough
"%GROK_REAL%"%GROK_EXTRA% %*
exit /b %errorlevel%
