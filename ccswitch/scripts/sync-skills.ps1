<#
.SYNOPSIS
    将 windsurf-dao skills 同步为 ~/.claude/skills/ 下的 junction
.DESCRIPTION
    扫描 ccswitch/skills/*/SKILL.md，对每个 skill 目录在目标目录创建 Junction。
    Junction 不需要管理员权限（与 commands 的文件 symlink 不同）。
    已存在的正确 Junction 跳过；目标错误时替换；不属于 windsurf-dao 的独立目录跳过。
.EXAMPLE
    powershell -File sync-skills.ps1
    powershell -File sync-skills.ps1 -DryRun
#>
param(
    [string]$SourceDir = (Join-Path $PSScriptRoot "..\skills"),
    [string]$TargetDir = (Join-Path $env:USERPROFILE ".claude\skills"),
    [switch]$DryRun
)

$SourceDir = (Resolve-Path $SourceDir).Path

if (-not (Test-Path $TargetDir)) {
    if ($DryRun) { Write-Host "[DRY] mkdir $TargetDir" }
    else { New-Item -ItemType Directory -Path $TargetDir -Force | Out-Null }
}

$skillDirs = Get-ChildItem -Path $SourceDir -Directory | Where-Object {
    Test-Path (Join-Path $_.FullName "SKILL.md")
}

$created = 0; $skipped = 0; $replaced = 0

foreach ($src in $skillDirs) {
    $linkPath = Join-Path $TargetDir $src.Name
    $targetPath = $src.FullName

    if (Test-Path $linkPath) {
        $existing = Get-Item $linkPath
        $isReparse = $existing.Attributes -band [IO.FileAttributes]::ReparsePoint
        if ($isReparse) {
            $currentTarget = $existing.Target
            if ($currentTarget -eq $targetPath) {
                Write-Host "  SKIP: $($src.Name) (junction OK)" -ForegroundColor DarkGray
                $skipped++
                continue
            }
        }
        if ($DryRun) { Write-Host "[DRY] REPLACE: $($src.Name)" -ForegroundColor Yellow }
        else {
            cmd /c "rmdir ""$linkPath"" 2>nul"
            cmd /c "mklink /J ""$linkPath"" ""$targetPath""" | Out-Null
            Write-Host "  REPLACE: $($src.Name)" -ForegroundColor Yellow
        }
        $replaced++
    } else {
        if ($DryRun) { Write-Host "[DRY] CREATE: $($src.Name)" -ForegroundColor Green }
        else {
            cmd /c "mklink /J ""$linkPath"" ""$targetPath""" | Out-Null
            Write-Host "  CREATE: $($src.Name)" -ForegroundColor Green
        }
        $created++
    }
}

Write-Host "`nDone: $created created, $replaced replaced, $skipped unchanged" -ForegroundColor Cyan
