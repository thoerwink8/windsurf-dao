@echo off
REM 把 dao_shot.cs 编译成 dao_shot.exe，安装到 %USERPROFILE%\.dao\bin\
REM 用 .NET Framework 自带的 csc.exe，无需安装任何东西，编译不触发 AMSI。
setlocal
set DIR=%USERPROFILE%\.dao\bin
set SRC=%~dp0dao_shot.cs
set CSC=C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe
if not exist "%CSC%" set CSC=C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe
if not exist "%DIR%" mkdir "%DIR%"
copy /Y "%SRC%" "%DIR%\dao_shot.cs" >nul
"%CSC%" /nologo /target:winexe /out:"%DIR%\dao_shot.exe" /reference:System.Drawing.dll /reference:System.Windows.Forms.dll "%DIR%\dao_shot.cs"
echo BUILD_EXIT=%errorlevel% OUT=%DIR%\dao_shot.exe
endlocal
