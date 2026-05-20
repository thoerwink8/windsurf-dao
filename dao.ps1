# dao.ps1 — windsurf-dao 工具脚本
#
# Usage:
#   .\dao.ps1 status                          查看状态
#   .\dao.ps1 link-global                     链接 global_rules.md 到 Windsurf 全局配置
#   .\dao.ps1 link-rules <project>            把 dao .windsurf/rules/*.md 全部 symlink 到 <project>/.windsurf/rules
#   .\dao.ps1 link-rules-all [-Root <dir>]    扫 <Root>（默认: dao 父目录）下所有 git/.windsurf 项目，批量 symlink
#                                              -AlwaysOnOnly  仅 link always_on 类（5 个）
#                                              -DryRun        只打印不执行
#
# 部署模式：Sidecar workspace 不再是必需。link-rules-all 后 dao rules 在所有项目都跨载。
# 前提：Windows Developer Mode（symlink 权限）

param(
    [Parameter(Position=0)]
    [string]$Action,

    [Parameter(Position=1)]
    [string]$TargetPath,

    [string]$Root,

    [switch]$AlwaysOnOnly,

    [switch]$DryRun
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

function Find-DaoProjects {
    # 扫 $Root 下两层深的 git 仓库 / .windsurf 项目（跳过 windsurf-dao 自身、node_modules 等噪音）
    param([string]$ScanRoot, [int]$MaxDepth = 2)

    $exclude = @('node_modules', '_tmp', '.tmp', 'dist', 'build', '.git', '.windsurf',
                 '.dao-autopilot', '.superpowers', '.worktrees', '.playwright-mcp', '.turbo',
                 '.codeium', '.cache')

    $projects = New-Object System.Collections.ArrayList
    $stack = New-Object System.Collections.Stack
    $stack.Push(@{ Path = $ScanRoot; Depth = 0 })

    while ($stack.Count -gt 0) {
        $item = $stack.Pop()
        $dir = $item.Path
        $depth = $item.Depth

        $name = Split-Path $dir -Leaf
        if ($name -in $exclude) { continue }
        if ($depth -gt $MaxDepth) { continue }

        # 跳过 dao 自身（它是 source）
        if ((Resolve-Path -LiteralPath $dir -ErrorAction SilentlyContinue).Path -eq $DaoRoot) { continue }

        # 判定：
        #   有 .git → 明确是 git 项目，加入并止步（避免 monorepo 内部 .git 误报）
        #   只有 .windsurf 没 .git → 可能是 group dir（如 d:\frank\道），加入也继续深入找子项目
        #   都没有 → 继续深入
        $hasGit = Test-Path (Join-Path $dir ".git")
        $hasWindsurf = Test-Path (Join-Path $dir ".windsurf")

        if ($hasGit) {
            [void]$projects.Add($dir)
            continue
        }
        if ($hasWindsurf) {
            [void]$projects.Add($dir)
            # 不 continue，继续深入
        }

        # 递归子目录
        try {
            Get-ChildItem -LiteralPath $dir -Directory -Force -ErrorAction SilentlyContinue | ForEach-Object {
                $stack.Push(@{ Path = $_.FullName; Depth = $depth + 1 })
            }
        } catch {}
    }

    return @($projects)
}

function Invoke-LinkRules {
    # 把 dao .windsurf/rules/*.md（默认全部 13 个，可 -AlwaysOnOnly）symlink 到 <project>/.windsurf/rules
    param([string]$ProjectPath, [bool]$OnlyAlwaysOn = $false, [bool]$IsDryRun = $false)

    $proj = Resolve-TargetPath $ProjectPath
    Write-Host "  [project] $proj" -ForegroundColor Cyan

    $targetRulesDir = Join-Path $proj ".windsurf\rules"
    if (-not $IsDryRun) { Ensure-Dir $targetRulesDir }

    $sourceRulesDir = Join-Path $DaoWindsurf "rules"
    $sourceFiles = Get-ChildItem $sourceRulesDir -Filter "*.md" | Where-Object { $_.Name -ne "README.md" }
    if ($OnlyAlwaysOn) {
        $sourceFiles = $sourceFiles | Where-Object {
            $head = Get-Content $_.FullName -TotalCount 5 -ErrorAction SilentlyContinue | Out-String
            $head -match 'trigger:\s*always_on'
        }
    }

    $linked = 0; $skipped = 0; $conflict = 0; $err = 0
    foreach ($f in $sourceFiles) {
        $linkPath = Join-Path $targetRulesDir $f.Name
        $shortName = $f.Name

        if (Test-Path $linkPath) {
            $existing = Get-Item $linkPath -Force
            if ($existing.LinkType -eq "SymbolicLink") {
                $currentTarget = $existing.Target
                if ($currentTarget -eq $f.FullName -or $currentTarget -eq $f.Name) {
                    Write-Host "    [skip ] $shortName  (already linked)" -ForegroundColor DarkGray
                    $skipped++
                } else {
                    Write-Host "    [diff ] $shortName  symlink -> $currentTarget" -ForegroundColor Yellow
                    $conflict++
                }
            } else {
                Write-Host "    [keep ] $shortName  (project's own file, preserved)" -ForegroundColor Yellow
                $conflict++
            }
            continue
        }

        if ($IsDryRun) {
            Write-Host "    [DRYRUN] $shortName  -> $($f.FullName)" -ForegroundColor Cyan
            $linked++
        } else {
            try {
                New-Symlink -Link $linkPath -Target $f.FullName
                Write-Host "    [link ] $shortName" -ForegroundColor Green
                $linked++
            } catch {
                Write-Host "    [error] $shortName : $_" -ForegroundColor Red
                $err++
            }
        }
    }
    Write-Host "    summary: linked=$linked skipped=$skipped conflict=$conflict error=$err" -ForegroundColor Cyan
    Write-Host ""
    return @{ Linked = $linked; Skipped = $skipped; Conflict = $conflict; Error = $err }
}

function Invoke-LinkRulesAll {
    # 扫 $ScanRoot 下所有项目，逐一 Invoke-LinkRules
    param([string]$ScanRoot, [bool]$OnlyAlwaysOn = $false, [bool]$IsDryRun = $false)

    if (-not $ScanRoot) {
        $ScanRoot = Split-Path $DaoRoot -Parent  # 默认: dao 的父目录（如 d:\frank）
    }
    $ScanRoot = (Resolve-Path $ScanRoot).Path

    Write-Host "`n  scan root: $ScanRoot" -ForegroundColor Cyan
    $projects = Find-DaoProjects -ScanRoot $ScanRoot
    Write-Host "  found $($projects.Count) project(s):" -ForegroundColor Cyan
    foreach ($p in $projects) {
        Write-Host "    - $((Split-Path $p -Parent | Split-Path -Leaf))\$(Split-Path $p -Leaf)"
    }
    Write-Host ""

    $total = @{ Linked = 0; Skipped = 0; Conflict = 0; Error = 0 }
    foreach ($p in $projects) {
        $r = Invoke-LinkRules -ProjectPath $p -OnlyAlwaysOn $OnlyAlwaysOn -IsDryRun $IsDryRun
        $total.Linked += $r.Linked
        $total.Skipped += $r.Skipped
        $total.Conflict += $r.Conflict
        $total.Error += $r.Error
    }

    Write-Host "  ============================================" -ForegroundColor Cyan
    Write-Host "  ALL DONE: $($projects.Count) project(s) processed" -ForegroundColor Cyan
    Write-Host "  total: linked=$($total.Linked) skipped=$($total.Skipped) conflict=$($total.Conflict) error=$($total.Error)" -ForegroundColor Cyan
    if ($total.Conflict -gt 0) {
        Write-Host "  note: 'conflict' = project has its own file/symlink with same name. Not overwritten." -ForegroundColor Yellow
    }
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
    "link-rules" {
        if (-not $TargetPath) {
            Write-Host "  [!] Missing project path. Usage: .\dao.ps1 link-rules <project>" -ForegroundColor Red
            exit 1
        }
        if (!(Test-SymlinkSupport)) {
            Write-Host "  [!] Symlinks unavailable. Enable Developer Mode." -ForegroundColor Red
            exit 1
        }
        Write-Host "`n  Linking dao rules into project..." -ForegroundColor Cyan
        [void](Invoke-LinkRules -ProjectPath $TargetPath -OnlyAlwaysOn:$AlwaysOnOnly.IsPresent -IsDryRun:$DryRun.IsPresent)
    }
    "link-rules-all" {
        if (!(Test-SymlinkSupport)) {
            Write-Host "  [!] Symlinks unavailable. Enable Developer Mode." -ForegroundColor Red
            exit 1
        }
        Write-Host "`n  Bulk linking dao rules into all projects..." -ForegroundColor Cyan
        Invoke-LinkRulesAll -ScanRoot $Root -OnlyAlwaysOn:$AlwaysOnOnly.IsPresent -IsDryRun:$DryRun.IsPresent
    }
    default {
        Write-Host @"

  windsurf-dao tool

  Usage:
    .\dao.ps1 status                          Show dao source info and global link status
    .\dao.ps1 link-global                     Link global_rules.md to Windsurf config
    .\dao.ps1 link-rules <project>            Symlink dao .windsurf/rules/*.md into <project>/.windsurf/rules
    .\dao.ps1 link-rules-all [-Root <dir>]    Bulk scan & symlink all projects under <Root>
                                               -AlwaysOnOnly  only link always_on rules (5 files)
                                               -DryRun        print without doing anything

  Examples:
    .\dao.ps1 link-rules-all                  scan default root (dao's parent dir)
    .\dao.ps1 link-rules-all -DryRun          preview without writing
    .\dao.ps1 link-rules d:\frank\TraceyU     single project

"@
    }
}
