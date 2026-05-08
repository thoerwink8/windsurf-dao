# dao.ps1 — windsurf-dao 工具脚本
#
# Usage:
#   .\dao.ps1 status                  查看状态
#   .\dao.ps1 link-global             链接 global_rules.md 到 Windsurf 全局配置
#
# 部署模式：Sidecar workspace（windsurf-dao 与目标项目同时打开）
# 前提：Windows Developer Mode（link-global 需要 symlink 权限）

param(
    [Parameter(Position=0)]
    [string]$Action,

    [Parameter(Position=1)]
    [string]$TargetPath
)

$ErrorActionPreference = "Stop"
$DaoRoot = $PSScriptRoot
$DaoWindsurf = Join-Path $DaoRoot ".windsurf"

# ── 工具函数 ──

function Test-SymlinkSupport {
    $testLink = Join-Path $env:TEMP "dao-test-link-$(Get-Random)"
    $testTarget = Join-Path $env:TEMP "dao-test-target-$(Get-Random)"
    try {
        "" | Set-Content $testTarget
        cmd /c "mklink `"$testLink`" `"$testTarget`"" 2>&1 | Out-Null
        if (Test-Path $testLink) {
            $item = Get-Item $testLink
            if ($item.LinkType -eq "SymbolicLink") {
                Remove-Item $testLink, $testTarget -Force
                $script:SymlinkMethod = "cmd"
                return $true
            }
        }
        New-Item -ItemType SymbolicLink -Path $testLink -Target $testTarget -ErrorAction Stop | Out-Null
        Remove-Item $testLink, $testTarget -Force
        $script:SymlinkMethod = "pwsh"
        return $true
    } catch {
        Remove-Item $testLink -Force -ErrorAction SilentlyContinue
        Remove-Item $testTarget -Force -ErrorAction SilentlyContinue
        return $false
    }
}

function New-Symlink {
    param([string]$Link, [string]$Target)
    if ($script:SymlinkMethod -eq "cmd") {
        cmd /c "mklink `"$Link`" `"$Target`"" | Out-Null
    } else {
        New-Item -ItemType SymbolicLink -Path $Link -Target $Target | Out-Null
    }
}

function Ensure-Dir {
    param([string]$Path)
    if (!(Test-Path $Path)) {
        New-Item -ItemType Directory -Path $Path -Force | Out-Null
    }
}

function Resolve-TargetPath {
    param([string]$Path)
    if (!(Test-Path $Path)) {
        Write-Host "  [error] Path not found: $Path" -ForegroundColor Red
        exit 1
    }
    return (Resolve-Path $Path).Path
}

# ── 核心操作 ──

function Invoke-Status {
    # 源仓库信息
    Write-Host "`n  Source: $DaoRoot" -ForegroundColor Cyan
    $rCount = (Get-ChildItem (Join-Path $DaoWindsurf "rules") -Filter "*.md").Count
    $sCount = (Get-ChildItem (Join-Path $DaoWindsurf "skills") -Directory).Count
    $wCount = (Get-ChildItem (Join-Path $DaoWindsurf "workflows") -Filter "*.md").Count
    $stCount = (Get-ChildItem (Join-Path $DaoWindsurf "stacks") -Filter "*.md" -ErrorAction SilentlyContinue).Count
    Write-Host "  Files: ${rCount} rules, ${sCount} skills, ${wCount} workflows, ${stCount} stacks"

    # 全局链接状态
    $globalPath = Join-Path (Join-Path (Join-Path (Join-Path $env:USERPROFILE ".codeium") "windsurf") "memories") "global_rules.md"
    if (Test-Path $globalPath) {
        $g = Get-Item $globalPath
        $gStatus = if ($g.LinkType -eq "SymbolicLink") { "linked" } else { "copy" }
        $gColor = if ($gStatus -eq "linked") { "Green" } else { "Yellow" }
        Write-Host "  Global: $gStatus" -ForegroundColor $gColor
    } else {
        Write-Host "  Global: not installed (run: dao.ps1 link-global)" -ForegroundColor Red
    }

    Write-Host "`n  Mode: Sidecar workspace" -ForegroundColor Cyan
}

function Invoke-LinkGlobal {
    $globalDir = Join-Path (Join-Path (Join-Path $env:USERPROFILE ".codeium") "windsurf") "memories"
    $globalFile = Join-Path $globalDir "global_rules.md"
    $sourceFile = Join-Path $DaoRoot "global_rules.md"

    Ensure-Dir $globalDir

    if (Test-Path $globalFile) {
        $item = Get-Item $globalFile
        if ($item.LinkType -eq "SymbolicLink") {
            Write-Host "  [skip] Already linked -> $($item.Target)" -ForegroundColor DarkGray
            return
        }
        Copy-Item $globalFile "$globalFile.bak" -Force
        Remove-Item $globalFile -Force
        Write-Host "  [backup] Existing -> global_rules.md.bak" -ForegroundColor Yellow
    }

    if (!(Test-SymlinkSupport)) {
        Write-Host "  [!] Symlinks unavailable for global link." -ForegroundColor Red
        return
    }
    New-Symlink -Link $globalFile -Target $sourceFile
    Write-Host "  [link] global_rules.md -> $sourceFile" -ForegroundColor Green
}

# ── 入口 ──

switch ($Action) {
    "status" {
        Invoke-Status
    }
    "link-global" {
        if (!(Test-SymlinkSupport)) {
            Write-Host "  [!] Symlinks unavailable. Enable Developer Mode." -ForegroundColor Red
            exit 1
        }
        Write-Host "`n  Linking global_rules.md..." -ForegroundColor Cyan
        Invoke-LinkGlobal
    }
    default {
        Write-Host @"

  windsurf-dao tool

  Usage:
    .\dao.ps1 status          Show dao source info and global link status
    .\dao.ps1 link-global     Link global_rules.md to Windsurf config

  Deploy: Open windsurf-dao as a Sidecar workspace alongside your project.

"@
    }
}
