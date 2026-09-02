@echo off
rem agent shim: same Clash Party proxy as cursor-agent
rem proxy: set DAO_PROXY to override (default keeps legacy 7890 behavior)
if not defined DAO_PROXY set "DAO_PROXY=http://127.0.0.1:7890"
set "HTTPS_PROXY=%DAO_PROXY%"
set "HTTP_PROXY=%DAO_PROXY%"
set "ALL_PROXY=%DAO_PROXY%"
set NODE_USE_ENV_PROXY=1
"%LOCALAPPDATA%\cursor-agent\agent.cmd" %*
