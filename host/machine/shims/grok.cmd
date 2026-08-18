@echo off
rem regrok shim: proxy required (auth endpoint DNS-poisoned) + pin default model grok-4.6
rem real binary: edit GROK_REAL for this machine (example: C:\nvm4w\nodejs\grok.cmd)
rem explicit -m/--model passes through untouched
set "GROK_REAL=C:\nvm4w\nodejs\grok.cmd"
set HTTPS_PROXY=http://127.0.0.1:7890
echo %* | findstr /C:"-m " /C:"--model" >nul
if %errorlevel%==0 (
  "%GROK_REAL%" %*
) else (
  "%GROK_REAL%" -m grok-4.6 %*
)
