@echo off
REM 把截屏 helper 源码编译成 exe，安装到 %USERPROFILE%\.dao\bin\
REM 用 .NET Framework 自带的 csc.exe，无需安装任何东西，编译不触发 AMSI。
REM   dao_shot.exe    全屏截图（VirtualScreen -> JPEG）
REM   dao_winshot.exe 按窗口截图（PrintWindow，不抢焦点）
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
