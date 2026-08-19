@echo off
rem regrok shim: proxy required (auth endpoint DNS-poisoned) + pin default model grok-4.6
rem real binary: edit GROK_REAL for this machine (example: C:\nvm4w\nodejs\grok.cmd)
rem explicit -m/--model passes through untouched
rem Do NOT use echo|findstr — that spawns a visible cmd window.
set "GROK_REAL=C:\nvm4w\nodejs\grok.cmd"
set HTTPS_PROXY=http://127.0.0.1:7890
set "GROK_ARGS=%*"
if not "%GROK_ARGS%"=="%GROK_ARGS:--model=%" goto :passthrough
if not "%GROK_ARGS%"=="%GROK_ARGS:-m =%" goto :passthrough
"%GROK_REAL%" -m grok-4.6 %*
exit /b %errorlevel%
:passthrough
"%GROK_REAL%" %*
exit /b %errorlevel%
