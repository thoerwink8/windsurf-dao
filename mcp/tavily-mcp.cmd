@echo off
REM Tavily MCP: Web search without VPN (China direct access)
REM Free tier: 1000 searches/month — https://app.tavily.com/
if "%TAVILY_API_KEY%"=="" echo ERROR: Set TAVILY_API_KEY env var (get free key at https://app.tavily.com/) && exit /b 1
node "%APPDATA%\npm\node_modules\tavily-mcp\build\index.js" %*
