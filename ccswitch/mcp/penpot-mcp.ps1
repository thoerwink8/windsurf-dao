<#
.SYNOPSIS
  Penpot MCP (SSE) 安装脚本 — 连接 Penpot 官方内置 MCP Server

.DESCRIPTION
  Penpot 自带 MCP Server (Beta)，使用 SSE 协议直连云端。
  Token 在 Penpot Settings > Integrations 页面创建，不可恢复。

  工作流定位：
    - Penpot MCP → 操作（创建/修改设计元素）
    - Chrome DevTools MCP → 观察（截图确认状态）

.EXAMPLE
  # 首次安装（交互式输入 Token）
  .\penpot-mcp.ps1 install

  # 带 Token 安装（从备份恢复）
  .\penpot-mcp.ps1 install -Token "eyJhbGci..."

  # 卸载
  .\penpot-mcp.ps1 uninstall

  # 查看状态
  .\penpot-mcp.ps1 status
#>

param(
    [Parameter(Position = 0)]
    [ValidateSet("install", "uninstall", "status", "help")]
    [string]$Action = "help",

    [Parameter()]
    [string]$Token
)

$ErrorActionPreference = "Stop"
$McpName = "penpot"
$BaseUrl = "https://design.penpot.app/mcp/stream?userToken="

switch ($Action) {
    "install" {
        if (-not $Token) {
            Write-Host "`n=== Penpot MCP 安装 ===" -ForegroundColor Magenta
            Write-Host "  1. 打开 https://design.penpot.app/#/settings/integrations" -ForegroundColor Cyan
            Write-Host "  2. 启用 MCP Server (Disabled -> Enabled)" -ForegroundColor Cyan
            Write-Host "  3. 点击 CREATE NEW ACCESS TOKEN" -ForegroundColor Cyan
            Write-Host "  4. 复制完整的 Server URL（含 userToken=...）" -ForegroundColor Cyan
            Write-Host ""

            $fullUrl = Read-Host "粘贴 Server URL 或仅 Token"

            if ($fullUrl.StartsWith("https://")) {
                $Token = $fullUrl -replace "^.*userToken=", ""
            } else {
                $Token = $fullUrl
            }
        }

        if (-not $Token -or $Token.Length -lt 20) {
            Write-Host "Token 无效（太短）" -ForegroundColor Red
            return
        }

        $url = "${BaseUrl}${Token}"

        # 先尝试删除已有的
        try { claude mcp remove $McpName -s user 2>$null } catch {}

        claude mcp add -s user --transport sse $McpName $url

        Write-Host "`n  Penpot MCP 已添加到全局配置" -ForegroundColor Green
        Write-Host "  重启 Claude Code 生效" -ForegroundColor Gray
        Write-Host ""
    }

    "uninstall" {
        claude mcp remove $McpName -s user
        Write-Host "  Penpot MCP 已移除" -ForegroundColor Green
    }

    "status" {
        Write-Host "`n=== Penpot MCP 状态 ===" -ForegroundColor Magenta
        $json = Get-Content "$env:USERPROFILE\.claude.json" -Raw | ConvertFrom-Json
        $penpot = $json.mcpServers.penpot
        if ($penpot) {
            Write-Host "  已配置: $($penpot.type) 方式" -ForegroundColor Green
            $masked = $penpot.url -replace "(userToken=).{10}", '$1**********'
            Write-Host "  URL: $masked..." -ForegroundColor Gray
        } else {
            Write-Host "  未配置" -ForegroundColor Yellow
            Write-Host "  运行: .\penpot-mcp.ps1 install" -ForegroundColor Gray
        }
        Write-Host ""
    }

    "help" {
        Write-Host @"

  penpot-mcp.ps1 — Penpot 官方 MCP Server (SSE) 管理

  用法:
    .\penpot-mcp.ps1 install [-Token <token>]  安装（交互式或带 Token）
    .\penpot-mcp.ps1 uninstall                 卸载
    .\penpot-mcp.ps1 status                    查看当前配置
    .\penpot-mcp.ps1 help                      帮助

  Token 获取:
    Penpot Settings > Integrations > MCP Server > CREATE NEW ACCESS TOKEN
    Token 唯一且不可恢复，请妥善备份

  跨机器同步:
    1. clone windsurf-dao
    2. 运行: .\ccswitch\mcp\penpot-mcp.ps1 install
    3. 按提示输入 Token（或用 -Token 参数传入备份的 Token）
    4. 重启 Claude Code

"@ -ForegroundColor Cyan
    }
}
