@echo off
REM 把输入 helper 源码编译成 exe，安装到 %USERPROFILE%\.dao\bin\
REM 用 .NET Framework 自带的 csc.exe，无需安装任何东西，编译不触发 AMSI。
REM   dao_focus.exe  抬窗口到前台/最大化/还原（绕过前台锁）
REM   dao_click.exe  屏幕绝对坐标左键单击
setlocal
set DIR=%USERPROFILE%\.dao\bin
set CSC=C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe
if not exist "%CSC%" set CSC=C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe
if not exist "%DIR%" mkdir "%DIR%"
copy /Y "%~dp0dao_focus.cs" "%DIR%\dao_focus.cs" >nul
copy /Y "%~dp0dao_click.cs" "%DIR%\dao_click.cs" >nul
"%CSC%" /nologo /target:winexe /out:"%DIR%\dao_focus.exe" "%DIR%\dao_focus.cs"
echo FOCUS_EXIT=%errorlevel% OUT=%DIR%\dao_focus.exe
"%CSC%" /nologo /target:winexe /out:"%DIR%\dao_click.exe" "%DIR%\dao_click.cs"
echo CLICK_EXIT=%errorlevel% OUT=%DIR%\dao_click.exe
endlocal
