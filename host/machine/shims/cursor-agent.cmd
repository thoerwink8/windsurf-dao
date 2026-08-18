@echo off
rem cursor-agent shim: Clash Party proxy required (CN IP hides GPT/Claude)
rem real binary: %LOCALAPPDATA%\cursor-agent\cursor-agent.cmd
set HTTPS_PROXY=http://127.0.0.1:7890
set HTTP_PROXY=http://127.0.0.1:7890
set ALL_PROXY=http://127.0.0.1:7890
set NODE_USE_ENV_PROXY=1
"%LOCALAPPDATA%\cursor-agent\cursor-agent.cmd" %*
