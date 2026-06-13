@echo off
REM Compile screenshot helper sources to exe, install into %USERPROFILE%\.dao\bin\
REM Uses the .NET Framework built-in csc.exe (no install needed, no AMSI trigger).
REM ASCII-only on purpose: cmd.exe parses .cmd in the OEM codepage, so non-ASCII
REM comments here would be mis-parsed as commands and break the build.
REM   dao_shot.exe    full-screen capture (VirtualScreen -> JPEG)
REM   dao_winshot.exe per-window capture (PrintWindow, does not steal focus)
setlocal
set DIR=%USERPROFILE%\.dao\bin
set CSC=C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe
if not exist "%CSC%" set CSC=C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe
if not exist "%DIR%" mkdir "%DIR%"
copy /Y "%~dp0dao_shot.cs" "%DIR%\dao_shot.cs" >nul
copy /Y "%~dp0dao_winshot.cs" "%DIR%\dao_winshot.cs" >nul
"%CSC%" /nologo /target:winexe /out:"%DIR%\dao_shot.exe" /reference:System.Drawing.dll /reference:System.Windows.Forms.dll "%DIR%\dao_shot.cs"
echo SHOT_EXIT=%errorlevel% OUT=%DIR%\dao_shot.exe
"%CSC%" /nologo /target:winexe /out:"%DIR%\dao_winshot.exe" /reference:System.Drawing.dll "%DIR%\dao_winshot.cs"
echo WINSHOT_EXIT=%errorlevel% OUT=%DIR%\dao_winshot.exe
endlocal
