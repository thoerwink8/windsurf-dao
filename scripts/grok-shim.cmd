@echo off
REM grok 启动 shim：强制带代理。装机与坑见 NEW-MACHINE §7；命令库只读本脚本路径。
REM proxy: set DAO_PROXY to override (default keeps legacy 7890 behavior)
if not defined DAO_PROXY set "DAO_PROXY=http://127.0.0.1:7890"
set "HTTPS_PROXY=%DAO_PROXY%"
grok %*
