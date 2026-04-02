# dao.ps1 — windsurf-dao 链接管理工具
# 符号链接消除同步问题：只有一份物理文件，所有项目指向它。
#
# Usage:
#   .\dao.ps1 link <project-path>     链接 dao 文件到目标项目（并注册）
#   .\dao.ps1 unlink <project-path>   移除链接（并取消注册）
#   .\dao.ps1 sync                    同步所有已注册项目（新增文件后执行）
#   .\dao.ps1 status [project-path]   查看链接状态
#   .\dao.ps1 link-global             链接 global_rules.md 到 Windsurf 全局配置
#
# 前提：Windows Developer Mode（文件符号链接需要）
#       目录联接(Junction)不需要特殊权限

param(
    [Parameter(Position=0)]
    [string]$Action,

    [Parameter(Position=1)]
    [string]$TargetPath
)

$ErrorActionPreference = "Stop"
$DaoRoot = $PSScriptRoot
$DaoWindsurf = Join-Path $DaoRoot ".windsurf"
$RegistryFile = Join-Path $DaoRoot ".dao-targets"

# ── 工具函数 ──

function Test-SymlinkSupport {
    $testLink = Join-Path $env:TEMP "dao-test-link-$(Get-Random)"
    $testTarget = Join-Path $env:TEMP "dao-test-target-$(Get-Random)"
    try {
        "" | Set-Content $testTarget
        # Try cmd /c mklink first (works without admin on many Windows setups)
        cmd /c "mklink `"$testLink`" `"$testTarget`"" 2>&1 | Out-Null
        if (Test-Path $testLink) {
            $item = Get-Item $testLink
            if ($item.LinkType -eq "SymbolicLink") {
                Remove-Item $testLink, $testTarget -Force
                $script:SymlinkMethod = "cmd"
                return $true
            }
        }
        # Fallback: PowerShell New-Item
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

function Resolve-TargetPath {
    param([string]$Path)
    if (!(Test-Path $Path)) {
        Write-Host "  [error] Path not found: $Path" -ForegroundColor Red
        exit 1
    }
    return (Resolve-Path $Path).Path
}

function Ensure-Dir {
    param([string]$Path)
    if (!(Test-Path $Path)) {
        New-Item -ItemType Directory -Path $Path -Force | Out-Null
    }
}

function Write-LinkResult {
    param([string]$Type, [string]$Name, [string]$Status, [string]$Detail)
    $color = switch ($Status) {
        "link"    { "Green" }
        "replace" { "Yellow" }
        "backup"  { "Magenta" }
        "skip"    { "DarkGray" }
        "unlink"  { "Yellow" }
        default   { "White" }
    }
    $msg = "  [$Status] $Type/$Name"
    if ($Detail) { $msg += " ($Detail)" }
    Write-Host $msg -ForegroundColor $color
}

function Test-FileDiff {
    param([string]$Source, [string]$Copy)
    $srcHash = (Get-FileHash $Source -Algorithm SHA256).Hash
    $cpHash = (Get-FileHash $Copy -Algorithm SHA256).Hash
    return $srcHash -ne $cpHash
}

function Test-DirDiff {
    param([string]$Source, [string]$Copy)
    $srcFiles = Get-ChildItem $Source -Recurse -File | ForEach-Object {
        @{ Rel = $_.FullName.Substring($Source.Length); Hash = (Get-FileHash $_.FullName -Algorithm SHA256).Hash }
    }
    foreach ($f in $srcFiles) {
        $cpFile = Join-Path $Copy $f.Rel
        if (!(Test-Path $cpFile)) { return $true }
        if ((Get-FileHash $cpFile -Algorithm SHA256).Hash -ne $f.Hash) { return $true }
    }
    return $false
}

function Backup-Item {
    param([string]$ItemPath, [string]$BackupRoot, [string]$RelPath)
    $backupDest = Join-Path $BackupRoot $RelPath
    $backupDir = Split-Path $backupDest -Parent
    Ensure-Dir $backupDir
    if (Test-Path $ItemPath -PathType Container) {
        Copy-Item $ItemPath $backupDest -Recurse -Force
    } else {
        Copy-Item $ItemPath $backupDest -Force
    }
}

# ── 注册表 ──

function Get-RegisteredTargets {
    if (!(Test-Path $RegistryFile)) { return @() }
    return (Get-Content $RegistryFile | Where-Object { $_.Trim() -ne "" } | ForEach-Object { $_.Trim() })
}

function Register-Target {
    param([string]$Path)
    $targets = Get-RegisteredTargets
    if ($Path -notin $targets) {
        $Path | Add-Content $RegistryFile
    }
}

function Unregister-Target {
    param([string]$Path)
    if (!(Test-Path $RegistryFile)) { return }
    $targets = Get-RegisteredTargets | Where-Object { $_ -ne $Path }
    if ($targets.Count -eq 0) {
        Remove-Item $RegistryFile -Force
    } else {
        $targets | Set-Content $RegistryFile
    }
}

# ── 核心操作 ──

function Invoke-Link {
    param([string]$Target)

    $Target = Resolve-TargetPath $Target
    $tw = Join-Path $Target ".windsurf"
    $script:CanSymlink = Test-SymlinkSupport

    # 确保目标目录存在
    "rules", "skills", "workflows", "references" | ForEach-Object { Ensure-Dir (Join-Path $tw $_) }

    $linked = 0; $copied = 0; $skipped = 0; $backed = 0
    $backupRoot = Join-Path $Target "_dao_backup"

    # Rules: 符号链接（降级为复制）
    Get-ChildItem (Join-Path $DaoWindsurf "rules") -Filter "dao-*.md" | ForEach-Object {
        $dest = Join-Path (Join-Path $tw "rules") $_.Name
        if (Test-Path $dest) {
            $item = Get-Item $dest
            if ($item.LinkType -eq "SymbolicLink") {
                Write-LinkResult "rules" $_.Name "skip"; $skipped++; return
            }
            # 副本存在：检查是否有修改
            if (Test-FileDiff $_.FullName $dest) {
                Backup-Item $dest $backupRoot "rules\$($_.Name)"
                Write-LinkResult "rules" $_.Name "backup" "modified copy saved"
                $backed++
            }
            Remove-Item $dest -Force
        }
        if ($script:CanSymlink) {
            New-Symlink -Link $dest -Target $_.FullName
            Write-LinkResult "rules" $_.Name "link"; $linked++
        } else {
            Copy-Item $_.FullName $dest -Force
            Write-LinkResult "rules" $_.Name "copy" "symlink unavailable"; $copied++
        }
    }

    # Skills: 目录联接（无需 admin）
    Get-ChildItem (Join-Path $DaoWindsurf "skills") -Directory -Filter "dao-*" | ForEach-Object {
        $dest = Join-Path (Join-Path $tw "skills") $_.Name
        if (Test-Path $dest) {
            $item = Get-Item $dest
            if ($item.LinkType -eq "Junction") {
                Write-LinkResult "skills" "$($_.Name)/" "skip"; $skipped++; return
            }
            # 副本存在：检查是否有修改
            if (Test-DirDiff $_.FullName $dest) {
                Backup-Item $dest $backupRoot "skills\$($_.Name)"
                Write-LinkResult "skills" "$($_.Name)/" "backup" "modified copy saved"
                $backed++
            }
            Remove-Item $dest -Recurse -Force
        }
        New-Item -ItemType Junction -Path $dest -Target $_.FullName | Out-Null
        Write-LinkResult "skills" "$($_.Name)/" "link"; $linked++
    }

    # Workflows: 符号链接（降级为复制）
    Get-ChildItem (Join-Path $DaoWindsurf "workflows") -Filter "dao-*.md" | ForEach-Object {
        $dest = Join-Path (Join-Path $tw "workflows") $_.Name
        if (Test-Path $dest) {
            $item = Get-Item $dest
            if ($item.LinkType -eq "SymbolicLink") {
                Write-LinkResult "workflows" $_.Name "skip"; $skipped++; return
            }
            # 副本存在：检查是否有修改
            if (Test-FileDiff $_.FullName $dest) {
                Backup-Item $dest $backupRoot "workflows\$($_.Name)"
                Write-LinkResult "workflows" $_.Name "backup" "modified copy saved"
                $backed++
            }
            Remove-Item $dest -Force
        }
        if ($script:CanSymlink) {
            New-Symlink -Link $dest -Target $_.FullName
            Write-LinkResult "workflows" $_.Name "link"; $linked++
        } else {
            Copy-Item $_.FullName $dest -Force
            Write-LinkResult "workflows" $_.Name "copy" "symlink unavailable"; $copied++
        }
    }

    # References: 符号链接（降级为复制）
    $refsSource = Join-Path $DaoRoot "references"
    if (Test-Path $refsSource) {
        Get-ChildItem $refsSource -File | ForEach-Object {
            $dest = Join-Path (Join-Path $tw "references") $_.Name
            if (Test-Path $dest) {
                $item = Get-Item $dest
                if ($item.LinkType -eq "SymbolicLink") {
                    Write-LinkResult "references" $_.Name "skip"; $skipped++; return
                }
                if (Test-FileDiff $_.FullName $dest) {
                    Backup-Item $dest $backupRoot "references\$($_.Name)"
                    Write-LinkResult "references" $_.Name "backup" "modified copy saved"
                    $backed++
                }
                Remove-Item $dest -Force
            }
            if ($script:CanSymlink) {
                New-Symlink -Link $dest -Target $_.FullName
                Write-LinkResult "references" $_.Name "link"; $linked++
            } else {
                Copy-Item $_.FullName $dest -Force
                Write-LinkResult "references" $_.Name "copy" "symlink unavailable"; $copied++
            }
        }
    }

    # 配置 .git/info/exclude
    $excludeFile = Join-Path (Join-Path (Join-Path $Target ".git") "info") "exclude"
    $gitInfoDir = Split-Path $excludeFile -Parent
    if ((Test-Path (Join-Path $Target ".git")) -and -not (Test-Path $excludeFile)) {
        if (-not (Test-Path $gitInfoDir)) { New-Item -ItemType Directory -Path $gitInfoDir -Force | Out-Null }
        New-Item -ItemType File -Path $excludeFile -Force | Out-Null
    }
    if (Test-Path $excludeFile) {
        $content = Get-Content $excludeFile -Raw -ErrorAction SilentlyContinue
        if (-not $content -or $content -notmatch "windsurf-dao") {
            @"

# windsurf-dao linked files (local only)
.windsurf/rules/dao-*
.windsurf/skills/dao-*
.windsurf/workflows/dao-*
.windsurf/references/
"@ | Add-Content $excludeFile
            Write-Host "`n  [config] .git/info/exclude updated" -ForegroundColor Cyan
        }
    }

    # 注册目标
    Register-Target $Target

    # 汇报
    $summary = "Done: $linked linked"
    if ($copied -gt 0) { $summary += ", $copied copied" }
    $summary += ", $skipped unchanged"
    Write-Host "`n  $summary" -ForegroundColor White
    if ($copied -gt 0) {
        Write-Host "  [info] Copies used (no symlink support). Run 'dao.ps1 sync' after editing dao files." -ForegroundColor Yellow
    }
    if ($backed -gt 0) {
        Write-Host "  Backup: $backed modified copies saved to _dao_backup/" -ForegroundColor Magenta
        Write-Host "  Review backups, merge improvements back to windsurf-dao, then delete _dao_backup/" -ForegroundColor Magenta
    }
}

function Invoke-Unlink {
    param([string]$Target)

    $Target = Resolve-TargetPath $Target
    $tw = Join-Path $Target ".windsurf"
    $removed = 0

    # Rules
    Get-ChildItem (Join-Path $tw "rules") -Filter "dao-*.md" -ErrorAction SilentlyContinue |
        Where-Object { $_.LinkType -eq "SymbolicLink" } | ForEach-Object {
            Remove-Item $_.FullName -Force
            Write-LinkResult "rules" $_.Name "unlink"; $removed++
        }

    # Skills
    Get-ChildItem (Join-Path $tw "skills") -Directory -Filter "dao-*" -ErrorAction SilentlyContinue |
        Where-Object { $_.LinkType -eq "Junction" } | ForEach-Object {
            Remove-Item $_.FullName -Force
            Write-LinkResult "skills" "$($_.Name)/" "unlink"; $removed++
        }

    # Workflows
    Get-ChildItem (Join-Path $tw "workflows") -Filter "dao-*.md" -ErrorAction SilentlyContinue |
        Where-Object { $_.LinkType -eq "SymbolicLink" } | ForEach-Object {
            Remove-Item $_.FullName -Force
            Write-LinkResult "workflows" $_.Name "unlink"; $removed++
        }

    # References
    Get-ChildItem (Join-Path $tw "references") -File -ErrorAction SilentlyContinue |
        Where-Object { $_.LinkType -eq "SymbolicLink" } | ForEach-Object {
            Remove-Item $_.FullName -Force
            Write-LinkResult "references" $_.Name "unlink"; $removed++
        }

    # 取消注册
    Unregister-Target $Target

    Write-Host "`n  Done: $removed unlinked" -ForegroundColor White
}

function Invoke-Status {
    param([string]$Target)

    # 源仓库信息
    Write-Host "`n  Source: $DaoRoot" -ForegroundColor Cyan
    $rCount = (Get-ChildItem (Join-Path $DaoWindsurf "rules") -Filter "dao-*.md").Count
    $sCount = (Get-ChildItem (Join-Path $DaoWindsurf "skills") -Directory -Filter "dao-*").Count
    $wCount = (Get-ChildItem (Join-Path $DaoWindsurf "workflows") -Filter "dao-*.md").Count
    $refSource = Join-Path $DaoRoot "references"
    $refCount = if (Test-Path $refSource) { (Get-ChildItem $refSource -File).Count } else { 0 }
    Write-Host "  Files: ${rCount} rules, ${sCount} skills, ${wCount} workflows, ${refCount} references"

    # 全局链接状态
    $globalPath = Join-Path (Join-Path (Join-Path (Join-Path $env:USERPROFILE ".codeium") "windsurf") "memories") "global_rules.md"
    if (Test-Path $globalPath) {
        $g = Get-Item $globalPath
        $gStatus = if ($g.LinkType -eq "SymbolicLink") { "linked" } else { "copy" }
        $gColor = if ($gStatus -eq "linked") { "Green" } else { "Yellow" }
        Write-Host "  Global: $gStatus" -ForegroundColor $gColor
    } else {
        Write-Host "  Global: not installed" -ForegroundColor Red
    }

    # 注册项目健康状态矩阵（无目标参数时显示）
    if (!$Target) {
        $allTargets = Get-RegisteredTargets
        if ($allTargets.Count -gt 0) {
            Write-Host "`n  Registered projects health:" -ForegroundColor Cyan
            foreach ($t in $allTargets) {
                $hasTodo  = Test-Path (Join-Path $t "TODO.md")
                $hasGuide = Test-Path (Join-Path $t "AGENT_GUIDE.md")
                $tMark = if ($hasTodo)  { "[Y]" } else { "[X]" }
                $gMark = if ($hasGuide) { "[Y]" } else { "[X]" }
                $tColor = if ($hasTodo)  { "Green" } else { "Red" }
                $gColor = if ($hasGuide) { "Green" } else { "Red" }
                Write-Host "    $t" -ForegroundColor White
                Write-Host "      " -NoNewline
                Write-Host "$tMark TODO.md        " -ForegroundColor $tColor -NoNewline
                Write-Host "$gMark AGENT_GUIDE.md" -ForegroundColor $gColor
            }
        }
    }

    # 目标项目状态
    if ($Target) {
        $Target = Resolve-TargetPath $Target
        $tw = Join-Path $Target ".windsurf"
        Write-Host "`n  Target: $Target" -ForegroundColor Cyan

        "rules", "skills", "workflows" | ForEach-Object {
            $dir = Join-Path $tw $_
            if (!(Test-Path $dir)) { Write-Host "    $_/: not found" -ForegroundColor Red; return }

            $filter = if ($_ -eq "skills") { "dao-*" } else { "dao-*.md" }
            $items = if ($_ -eq "skills") {
                Get-ChildItem $dir -Directory -Filter $filter -ErrorAction SilentlyContinue
            } else {
                Get-ChildItem $dir -Filter $filter -ErrorAction SilentlyContinue
            }

            foreach ($item in $items) {
                $status = if ($item.LinkType -in @("SymbolicLink", "Junction")) { "linked" } else { "copy" }
                $color = if ($status -eq "linked") { "Green" } else { "Yellow" }
                $suffix = if ($_ -eq "skills") { "/" } else { "" }
                Write-Host "    $_/$($item.Name)$suffix $status" -ForegroundColor $color
            }
        }

        # References（无 dao-* 前缀限制）
        $refDir = Join-Path $tw "references"
        if (Test-Path $refDir) {
            Get-ChildItem $refDir -File -ErrorAction SilentlyContinue | ForEach-Object {
                $status = if ($_.LinkType -eq "SymbolicLink") { "linked" } else { "copy" }
                $color = if ($status -eq "linked") { "Green" } else { "Yellow" }
                Write-Host "    references/$($_.Name) $status" -ForegroundColor $color
            }
        }
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

function Invoke-Sync {
    $targets = Get-RegisteredTargets
    if ($targets.Count -eq 0) {
        Write-Host "`n  No registered targets. Use 'dao.ps1 link <path>' first." -ForegroundColor Yellow
        exit 0
    }
    Write-Host "`n  Syncing $($targets.Count) registered target(s)..." -ForegroundColor Cyan
    foreach ($t in $targets) {
        if (!(Test-Path $t)) {
            Write-Host "`n  [warn] $t not found, skipping" -ForegroundColor Yellow
            continue
        }
        Write-Host "`n  >> $t" -ForegroundColor Cyan
        Invoke-Link -Target $t
    }

    # 变更摘要：显示源文件本次未提交的变更（即本次传播的内容）
    $diffStat = git -C $DaoRoot diff --stat HEAD -- ".windsurf/" "global_rules.md" 2>$null
    if ($diffStat) {
        Write-Host "`n  -- Changes propagated --" -ForegroundColor Cyan
        $diffStat | ForEach-Object { Write-Host "  $_" -ForegroundColor White }
    } else {
        $lastCommit = (git -C $DaoRoot log --oneline -1 -- ".windsurf/" "global_rules.md" 2>$null)
        if ($lastCommit) {
            Write-Host "`n  [synced] latest: $lastCommit" -ForegroundColor DarkGray
        }
    }
}

# ── 入口 ──

switch ($Action) {
    "link" {
        if (!$TargetPath) { Write-Host "Usage: .\dao.ps1 link <project-path>"; exit 1 }
        Write-Host "`n  Linking to: $TargetPath" -ForegroundColor Cyan
        Write-Host ""
        Invoke-Link -Target $TargetPath
    }
    "unlink" {
        if (!$TargetPath) { Write-Host "Usage: .\dao.ps1 unlink <project-path>"; exit 1 }
        Write-Host "`n  Unlinking from: $TargetPath" -ForegroundColor Cyan
        Write-Host ""
        Invoke-Unlink -Target $TargetPath
    }
    "status" {
        Invoke-Status -Target $TargetPath
    }
    "sync" {
        Write-Host "`n  Syncing..." -ForegroundColor Cyan
        Invoke-Sync
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

  windsurf-dao link tool

  Usage:
    .\dao.ps1 link <project-path>     Link dao files to target project
    .\dao.ps1 unlink <project-path>   Remove links from target project
    .\dao.ps1 sync                    Re-link all registered targets + show change summary
    .\dao.ps1 status [project-path]   Show link status; omit path to see health matrix for all registered projects
    .\dao.ps1 link-global             Link global_rules.md to Windsurf config

  Requires: Windows Developer Mode (for file symlinks)
            Directory junctions work without special permissions.

"@
    }
}
