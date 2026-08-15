@echo off
REM grok 启动 shim：强制带代理。装机与坑见 NEW-MACHINE §7；命令库只读本脚本路径。
set "HTTPS_PROXY=http://127.0.0.1:7890"
grok %*
