@echo off
chcp 65001 >nul
echo.
echo   道 · windsurf-dao 安装器
echo   ════════════════════════
echo.
echo   本脚本将在此电脑上安装:
echo     - Node.js (如未安装)
echo     - Claude Code CLI (如未安装)
echo     - dao 规则体系 (skills/commands/agents/hooks)
echo.
echo   按任意键开始，或关闭窗口取消...
pause >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" "%~dp0"
echo.
pause
