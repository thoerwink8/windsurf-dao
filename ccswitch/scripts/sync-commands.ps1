<#
.SYNOPSIS
    将 windsurf-dao commands 同步为 ~/.claude/commands/ 下的 symlink
.DESCRIPTION
    扫描 ccswitch/commands/*.md，对每个文件在目标目录创建符号链接。
    已存在的非 symlink 文件会被替换；已存在的正确 symlink 跳过。
    跳过目标目录中不属于 windsurf-dao 的独立文件。
.EXAMPLE
    powershell -File sync-commands.ps1
    powershell -File sync-commands.ps1 -DryRun
#>
param(
    [string]$SourceDir = (Join-Path $PSScriptRoot "..\commands"),
    [string]$TargetDir = (Join-Path $env:USERPROFILE ".claude\commands"),
    [switch]$DryRun
)

$SourceDir = (Resolve-Path $SourceDir).Path

if (-not (Test-Path $TargetDir)) {
    if ($DryRun) { Write-Host "[DRY] mkdir $TargetDir" }
    else { New-Item -ItemType Directory -Path $TargetDir -Force | Out-Null }
}

$sourceFiles = Get-ChildItem "$SourceDir\*.md"
$created = 0; $skipped = 0; $replaced = 0

foreach ($src in $sourceFiles) {
    $linkPath = Join-Path $TargetDir $src.Name
    $targetPath = $src.FullName

    if (Test-Path $linkPath) {
        $existing = Get-Item $linkPath
        if ($existing.Attributes -band [IO.FileAttributes]::ReparsePoint) {
            $currentTarget = $existing.Target
            if ($currentTarget -eq $targetPath) {
                Write-Host "  SKIP: $($src.Name) (symlink OK)" -ForegroundColor DarkGray
                $skipped++
                continue
            }
        }
        if ($DryRun) { Write-Host "[DRY] REPLACE: $($src.Name)" -ForegroundColor Yellow }
        else {
            cmd /c "del ""$linkPath"" 2>nul"
            cmd /c "mklink ""$linkPath"" ""$targetPath""" | Out-Null
            Write-Host "  REPLACE: $($src.Name)" -ForegroundColor Yellow
        }
        $replaced++
    } else {
        if ($DryRun) { Write-Host "[DRY] CREATE: $($src.Name)" -ForegroundColor Green }
        else {
            cmd /c "mklink ""$linkPath"" ""$targetPath""" | Out-Null
            Write-Host "  CREATE: $($src.Name)" -ForegroundColor Green
        }
        $created++
    }
}

Write-Host "`nDone: $created created, $replaced replaced, $skipped unchanged" -ForegroundColor Cyan
