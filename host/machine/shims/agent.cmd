@echo off
rem agent shim: same Clash Party proxy as cursor-agent
set HTTPS_PROXY=http://127.0.0.1:7890
set HTTP_PROXY=http://127.0.0.1:7890
set ALL_PROXY=http://127.0.0.1:7890
set NODE_USE_ENV_PROXY=1
"%LOCALAPPDATA%\cursor-agent\agent.cmd" %*
