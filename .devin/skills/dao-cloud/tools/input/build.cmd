@echo off
REM Compile input helper sources to exe, install into %USERPROFILE%\.dao\bin\
REM Uses the .NET Framework built-in csc.exe (no install needed, no AMSI trigger).
REM ASCII-only on purpose: cmd.exe parses .cmd in the OEM codepage, so non-ASCII
REM comments here would be mis-parsed as commands and break the build.
REM   dao_focus.exe  raise/maximize/restore a window (bypass foreground lock)
REM   dao_click.exe  left-click at absolute screen coordinates
REM   dao_idle.exe   print system idle milliseconds (etiquette idle gate)
setlocal
set DIR=%USERPROFILE%\.dao\bin
set CSC=C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe
if not exist "%CSC%" set CSC=C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe
if not exist "%DIR%" mkdir "%DIR%"
copy /Y "%~dp0dao_focus.cs" "%DIR%\dao_focus.cs" >nul
copy /Y "%~dp0dao_click.cs" "%DIR%\dao_click.cs" >nul
copy /Y "%~dp0dao_idle.cs" "%DIR%\dao_idle.cs" >nul
"%CSC%" /nologo /target:winexe /out:"%DIR%\dao_focus.exe" "%DIR%\dao_focus.cs"
echo FOCUS_EXIT=%errorlevel% OUT=%DIR%\dao_focus.exe
"%CSC%" /nologo /target:winexe /out:"%DIR%\dao_click.exe" "%DIR%\dao_click.cs"
echo CLICK_EXIT=%errorlevel% OUT=%DIR%\dao_click.exe
REM dao_idle uses console exe (/target:exe) so its stdout can be captured
"%CSC%" /nologo /target:exe /out:"%DIR%\dao_idle.exe" "%DIR%\dao_idle.cs"
echo IDLE_EXIT=%errorlevel% OUT=%DIR%\dao_idle.exe
endlocal
