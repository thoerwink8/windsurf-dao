# dao-pack.ps1 — 打包 dao 分发安装包
#
# 在开发机上运行，把当前 dao 规则体系打包成一个 zip，
# 发给任何 Windows 用户双击 install.bat 即可从零安装。
#
# 用法：
#   .\scripts\dao-pack.ps1              # 输出到 _tmp/dao-setup-YYYYMMDD.zip
#   .\scripts\dao-pack.ps1 -DryRun      # 只列出会打包的文件，不创建 zip

param(
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$DaoRoot = Split-Path $PSScriptRoot -Parent
$date = Get-Date -Format 'yyyyMMdd'
$outDir = Join-Path $DaoRoot '_tmp'
$packDir = Join-Path $outDir "dao-setup-$date"
$zipPath = "$packDir.zip"

Write-Host ''
Write-Host '  dao-pack: 打包分发安装包' -ForegroundColor Cyan
Write-Host "  源: $DaoRoot" -ForegroundColor DarkGray
Write-Host ''

# ── 准备临时目录 ──

if (-not $DryRun) {
    if (Test-Path $packDir) { Remove-Item $packDir -Recurse -Force }
    New-Item -ItemType Directory -Path $packDir -Force | Out-Null
}

$daoDir = Join-Path $packDir 'dao'
$counts = @{ files = 0; skills = 0 }

function Pack-File($src, $dst, $label) {
    if (-not (Test-Path $src)) { return }
    if ($DryRun) {
        Write-Host "  [pack] $label" -ForegroundColor DarkGray
    } else {
        $dstDir = Split-Path $dst -Parent
        if (-not (Test-Path $dstDir)) { New-Item -ItemType Directory -Path $dstDir -Force | Out-Null }
        Copy-Item $src $dst -Force
    }
    $script:counts.files++
}

function Pack-Dir($src, $dst, $label) {
    if (-not (Test-Path $src)) { return }
    if ($DryRun) {
        Write-Host "  [pack] $label/" -ForegroundColor DarkGray
    } else {
        if (Test-Path $dst) { Remove-Item $dst -Recurse -Force }
        Copy-Item $src $dst -Recurse -Force
        Get-ChildItem $dst -Recurse -Directory -Filter '__pycache__' -ErrorAction SilentlyContinue |
            Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
    }
    $script:counts.skills++
}

function Pack-Glob($srcDir, $dstDir, $filter, $label) {
    if (-not (Test-Path $srcDir)) { return }
    $files = Get-ChildItem $srcDir -File -Filter $filter -ErrorAction SilentlyContinue
    foreach ($f in $files) {
        Pack-File $f.FullName (Join-Path $dstDir $f.Name) "$label/$($f.Name)"
    }
}

# ── 收集文件 ──

Write-Host '  收集 dao 文件...' -ForegroundColor Cyan

# 核心规则
Pack-File (Join-Path $DaoRoot 'ccswitch\dao.md') (Join-Path $daoDir 'dao.md') 'dao.md'

# Skills（目录）
$skillsSrc = Join-Path $DaoRoot 'ccswitch\skills'
$skillsDst = Join-Path $daoDir 'skills'
if (Test-Path $skillsSrc) {
    Get-ChildItem $skillsSrc -Directory -Filter 'dao-*' -ErrorAction SilentlyContinue | ForEach-Object {
        Pack-Dir $_.FullName (Join-Path $skillsDst $_.Name) "skills/$($_.Name)"
    }
}

# Commands
Pack-Glob (Join-Path $DaoRoot 'ccswitch\commands') (Join-Path $daoDir 'commands') '*.md' 'commands'

# Agents
Pack-Glob (Join-Path $DaoRoot 'ccswitch\agents') (Join-Path $daoDir 'agents') 'dao-*.md' 'agents'

# Hooks
$hooksSrc = Join-Path $DaoRoot 'ccswitch\hooks'
$hooksDst = Join-Path $daoDir 'hooks'
if (Test-Path $hooksSrc) {
    Get-ChildItem $hooksSrc -File -Filter 'dao-*' -ErrorAction SilentlyContinue | ForEach-Object {
        Pack-File $_.FullName (Join-Path $hooksDst $_.Name) "hooks/$($_.Name)"
    }
}

# References（经文）
Pack-Glob (Join-Path $DaoRoot 'docs\classics') (Join-Path $daoDir 'references') '*.md' 'references'

# Styles
Pack-Glob (Join-Path $DaoRoot 'ccswitch\styles') (Join-Path $daoDir 'styles') '*.md' 'styles'

# Themes
Pack-Glob (Join-Path $DaoRoot 'ccswitch\themes') (Join-Path $daoDir 'themes') '*.json' 'themes'

# Persona
$personaSrc = Join-Path $DaoRoot 'ccswitch\persona'
$personaDst = Join-Path $daoDir 'persona'
if (Test-Path $personaSrc) {
    Get-ChildItem $personaSrc -File -ErrorAction SilentlyContinue | ForEach-Object {
        Pack-File $_.FullName (Join-Path $personaDst $_.Name) "persona/$($_.Name)"
    }
}

# ── 安装脚本 ──

Pack-File (Join-Path $DaoRoot 'scripts\dao-install.bat') (Join-Path $packDir 'install.bat') 'install.bat'
Pack-File (Join-Path $DaoRoot 'scripts\dao-install.ps1') (Join-Path $packDir 'install.ps1') 'install.ps1'

# ── 打包 ──

Write-Host ''

if ($DryRun) {
    Write-Host "  [DryRun] 共 $($counts.files) 个文件 + $($counts.skills) 个技能目录" -ForegroundColor Yellow
    Write-Host "  [DryRun] 实际运行时输出到: $zipPath" -ForegroundColor Yellow
} else {
    Write-Host '  压缩中...' -ForegroundColor DarkGray
    if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
    Compress-Archive -Path "$packDir\*" -DestinationPath $zipPath -CompressionLevel Optimal

    # 清理临时目录
    Remove-Item $packDir -Recurse -Force

    $size = [math]::Round((Get-Item $zipPath).Length / 1024, 1)
    Write-Host ''
    Write-Host '  ══════════════════════════════════════' -ForegroundColor DarkCyan
    Write-Host "  打包完成！" -ForegroundColor Green
    Write-Host "  输出: $zipPath" -ForegroundColor White
    Write-Host "  大小: ${size} KB" -ForegroundColor DarkGray
    Write-Host "  内容: $($counts.files) 个文件 + $($counts.skills) 个技能目录" -ForegroundColor DarkGray
    Write-Host '  ══════════════════════════════════════' -ForegroundColor DarkCyan
    Write-Host ''
    Write-Host '  分享方式：' -ForegroundColor White
    Write-Host '    把 zip 发给用户 → 解压 → 双击 install.bat' -ForegroundColor DarkGray
    Write-Host ''
}
