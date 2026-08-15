# dao.ps1 — 本机目录接到仓内真相源
#
#   .\dao.ps1 link          把本机 Claude 项目 memory 接到 host/memory/
#   .\dao.ps1 link-memory   同上
#   .\dao.ps1 status        检查 Junction；断了就自愈
#
# 改这个文件前必须知道：
#   1. 目录级 Junction，不是逐文件 symlink。Junction 不需要 Developer Mode。
#   2. 首次切换（本机是真目录）先合并再替换：只在本机的拷进仓；同名先比内容，
#      不同再比「有效修改时间」——仓内文件用 git 提交时间（checkout 会刷新文件系统时间，
#      用文件系统 mtime 会让刚 clone 的副本永远压过本机旧文件）。
#   3. 删 Junction 用 item.Delete() / cmd rmdir，禁止 Remove-Item -Recurse
#      （老 PowerShell 会顺着 Junction 把仓内文件删掉）。
#   4. -RepoRoot / -LocalMemory 只给测试用，日常不要传。

param(
    [Parameter(Position = 0)]
    [string]$Action,

    [switch]$DryRun,

    [string]$RepoRoot,
    [string]$LocalMemory
)

$ErrorActionPreference = "Stop"
if (-not $RepoRoot) { $RepoRoot = $PSScriptRoot }

function Get-FullPath([string]$Path) {
    return [IO.Path]::GetFullPath($Path.TrimEnd('\', '/'))
}

function Get-ClaudeProjectDirName([string]$RepoPath) {
    $full = Get-FullPath $RepoPath
    return ($full -replace ':', '-' -replace '[\\/]', '-')
}

function Get-HostMemory {
    return Join-Path $RepoRoot "host\memory"
}

function Get-LocalMemory {
    if ($LocalMemory) { return $LocalMemory }
    $encoded = Get-ClaudeProjectDirName $RepoRoot
    return Join-Path $env:USERPROFILE ".claude\projects\$encoded\memory"
}

function Ensure-Dir([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) {
        New-Item -ItemType Directory -Path $Path -Force | Out-Null
    }
}

function Get-RelPath([string]$Root, [string]$Full) {
    $prefix = (Get-FullPath $Root) + [IO.Path]::DirectorySeparatorChar
    $full = Get-FullPath $Full
    if (-not $full.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { return $null }
    return $full.Substring($prefix.Length) -replace '\\', '/'
}

function Get-ReparseItem([string]$Path) {
    return Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
}

function Test-Reparse([string]$Path) {
    $item = Get-ReparseItem $Path
    if (-not $item) { return $false }
    return [bool]($item.Attributes -band [IO.FileAttributes]::ReparsePoint)
}

function Get-ReparseTarget([string]$Path) {
    $item = Get-ReparseItem $Path
    if (-not $item) { return $null }
    $t = $item.Target
    if ($null -eq $t) { return $null }
    if ($t -is [array]) { $t = $t[0] }
    if (-not $t) { return $null }
    try { return Get-FullPath ([string]$t) } catch { return [string]$t }
}

function Remove-Reparse([string]$Path) {
    $item = Get-ReparseItem $Path
    if (-not $item) { return }
    try {
        $item.Delete()
    } catch {
        cmd /c "rmdir `"$Path`"" | Out-Null
    }
}

function Get-FileSha256([string]$Path) {
    # 不用 Get-FileHash：嵌套 powershell -NoProfile 时 Utility 模块可能没加载。
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $fs = [IO.File]::OpenRead($Path)
        try {
            return [BitConverter]::ToString($sha.ComputeHash($fs)).Replace("-", "")
        } finally { $fs.Dispose() }
    } finally { $sha.Dispose() }
}

function Get-HostEffectiveTime([string]$HostFile, [string]$RelFromRepo) {
    # 只在 RepoRoot 自己就是 git 根时才用提交时间。测试沙箱落在仓内 _tmp/，
    # git 会往上走到真仓库，把别人的 host/memory 提交时间套到沙箱文件上。
    $top = & git -C $RepoRoot rev-parse --show-toplevel 2>$null
    if ($LASTEXITCODE -eq 0 -and $top -and ((Get-FullPath "$top") -eq (Get-FullPath $RepoRoot))) {
        $raw = & git -C $RepoRoot log -1 --format=%ct -- $RelFromRepo 2>$null
        if ($LASTEXITCODE -eq 0 -and $raw) {
            $sec = 0L
            if ([int64]::TryParse(("$raw").Trim(), [ref]$sec) -and $sec -gt 0) {
                return [DateTimeOffset]::FromUnixTimeSeconds($sec).LocalDateTime
            }
        }
    }
    return (Get-Item -LiteralPath $HostFile).LastWriteTime
}

function Get-MemoryState {
    $hostDir = Get-HostMemory
    $localDir = Get-LocalMemory
    if (-not (Test-Path -LiteralPath $hostDir)) { return "no-source" }
    if (-not (Test-Path -LiteralPath $localDir) -and -not (Test-Reparse $localDir)) { return "missing" }
    if (Test-Reparse $localDir) {
        $target = Get-ReparseTarget $localDir
        $want = Get-FullPath $hostDir
        if (-not $target) { return "broken" }
        if (-not (Test-Path -LiteralPath $target)) { return "broken" }
        if ((Get-FullPath $target) -ne $want) { return "wrong-target" }
        return "ok"
    }
    return "real-dir"
}

function Merge-LocalIntoHost {
    $hostDir = Get-HostMemory
    $localDir = Get-LocalMemory
    $copied = 0
    $kept = 0
    $same = 0
    $files = @(Get-ChildItem -LiteralPath $localDir -File -Recurse -ErrorAction SilentlyContinue)
    foreach ($f in $files) {
        $rel = Get-RelPath $localDir $f.FullName
        if (-not $rel) { continue }
        $dest = Join-Path $hostDir ($rel -replace '/', '\')
        if (-not (Test-Path -LiteralPath $dest)) {
            if ($DryRun) {
                Write-Host "    [DRYRUN] copy $rel  (local-only)"
            } else {
                Ensure-Dir (Split-Path -Parent $dest)
                Copy-Item -LiteralPath $f.FullName -Destination $dest -Force
                Write-Host "    [copy ] $rel  (local-only)"
            }
            $copied++
            continue
        }
        if ((Get-FileSha256 $f.FullName) -eq (Get-FileSha256 $dest)) {
            $same++
            continue
        }
        $localTime = $f.LastWriteTime
        $hostTime = Get-HostEffectiveTime $dest ("host/memory/$rel")
        if ($localTime -gt $hostTime) {
            if ($DryRun) {
                Write-Host "    [DRYRUN] copy $rel  (local newer $localTime > $hostTime)"
            } else {
                Copy-Item -LiteralPath $f.FullName -Destination $dest -Force
                Write-Host "    [copy ] $rel  (local newer)"
            }
            $copied++
        } else {
            Write-Host "    [keep ] $rel  (host newer or equal)"
            $kept++
        }
    }
    Write-Host "    merge: copied=$copied kept=$kept identical=$same"
}

function New-MemoryJunction {
    $hostDir = Get-FullPath (Get-HostMemory)
    $localDir = Get-LocalMemory
    Ensure-Dir (Split-Path -Parent $localDir)
    if ($DryRun) {
        Write-Host "    [DRYRUN] Junction $localDir -> $hostDir"
        return
    }
    New-Item -ItemType Junction -Path $localDir -Target $hostDir | Out-Null
    Write-Host "    [link ] $localDir -> $hostDir"
}

function Invoke-LinkMemory {
    $hostDir = Get-HostMemory
    $localDir = Get-LocalMemory
    if (-not (Test-Path -LiteralPath $hostDir)) {
        Write-Host "  [error] host/memory 不在: $hostDir" -ForegroundColor Red
        exit 1
    }
    Write-Host "  memory source: $hostDir"
    Write-Host "  memory local : $localDir"
    $state = Get-MemoryState
    switch ($state) {
        "ok" {
            Write-Host "  memory Junction: ok"
            return
        }
        "real-dir" {
            Write-Host "  memory: real directory, merging then replacing"
            Merge-LocalIntoHost
            if (-not $DryRun) {
                Remove-Item -LiteralPath $localDir -Recurse -Force
            } else {
                Write-Host "    [DRYRUN] remove real dir $localDir"
            }
            New-MemoryJunction
        }
        "wrong-target" {
            $old = Get-ReparseTarget $localDir
            Write-Host "  memory Junction: wrong target ($old), fixing"
            if (-not $DryRun) { Remove-Reparse $localDir }
            New-MemoryJunction
        }
        "broken" {
            Write-Host "  memory Junction: broken, healing"
            if (-not $DryRun) { Remove-Reparse $localDir }
            New-MemoryJunction
        }
        "missing" {
            Write-Host "  memory: missing, creating Junction"
            New-MemoryJunction
        }
        default {
            Write-Host "  [error] unexpected state: $state" -ForegroundColor Red
            exit 1
        }
    }
    if ($DryRun) { return }
    $after = Get-MemoryState
    if ($after -ne "ok") {
        Write-Host "  [error] link 之后状态是 $after，不是 ok" -ForegroundColor Red
        exit 1
    }
    Write-Host "  memory Junction: ok"
}

function Invoke-Status {
    $hostDir = Get-HostMemory
    $localDir = Get-LocalMemory
    Write-Host "  Source: $RepoRoot"
    Write-Host "  memory source: $hostDir"
    Write-Host "  memory local : $localDir"
    $state = Get-MemoryState
    switch ($state) {
        "ok" {
            Write-Host "  memory Junction: ok" -ForegroundColor Green
        }
        "no-source" {
            Write-Host "  memory: host/memory 不在（本次没查成）" -ForegroundColor Red
            exit 1
        }
        "real-dir" {
            Write-Host "  memory: real directory, not a Junction (run: dao.ps1 link)" -ForegroundColor Yellow
        }
        "missing" {
            Write-Host "  memory Junction: missing — self-healing" -ForegroundColor Yellow
            Invoke-LinkMemory
        }
        "broken" {
            Write-Host "  memory Junction: broken — self-healing" -ForegroundColor Yellow
            Invoke-LinkMemory
        }
        "wrong-target" {
            Write-Host "  memory Junction: wrong target — self-healing" -ForegroundColor Yellow
            Invoke-LinkMemory
        }
        default {
            Write-Host "  memory: unknown state $state" -ForegroundColor Red
            exit 1
        }
    }
}

function Show-Usage {
    Write-Host @"
dao.ps1 — attach local Claude project memory to host/memory/

  .\dao.ps1 link          First-run merge (if needed) + Junction
  .\dao.ps1 link-memory   Same as link
  .\dao.ps1 status        Check Junction; heal if broken
"@
}

switch ($Action) {
    { $_ -in "link", "link-memory" } { Invoke-LinkMemory }
    "status" { Invoke-Status }
    default { Show-Usage; if ($Action) { exit 1 } }
}
