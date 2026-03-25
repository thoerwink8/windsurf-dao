@echo off
REM Gitee MCP: GitHub alternative without VPN (China direct access)
REM 29 tools: repos, PRs, issues, users, notifications
REM Get token: https://gitee.com/profile/personal_access_tokens
if "%GITEE_ACCESS_TOKEN%"=="" echo ERROR: Set GITEE_ACCESS_TOKEN env var (get token at https://gitee.com/profile/personal_access_tokens) && exit /b 1
node "%APPDATA%\npm\node_modules\@gitee\mcp-gitee\bin\index.js" %*
