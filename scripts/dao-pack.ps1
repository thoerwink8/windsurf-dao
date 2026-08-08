# dao-pack.ps1 — 打包 dao 分发安装包
#
# 在开发机上运行，把当前 dao 规则体系打包成一个 zip，
# 发给任何 Windows 用户双击 install.bat 即可从零安装。
#
# 用法：
#   .\scripts\dao-pack.ps1              # 输出到 _tmp/dao-setup-YYYYMMDD.zip
#   .\scripts\dao-pack.ps1 -DryRun      # 只列出会打包的文件，不创建 zip

param(
    [switch]$DryRun,
    # 测试专用：把输出定向到隔离目录，别用默认的仓根 _tmp（回归网需要一个不与真实
    # 打包产物、也不与并行跑的别的官互踩的落点）。缺省行为一字不变。
    [string]$OutputRoot
)

$ErrorActionPreference = 'Stop'
$DaoRoot = Split-Path $PSScriptRoot -Parent
$date = Get-Date -Format 'yyyyMMdd'
$outDir = $OutputRoot
if (-not $outDir) { $outDir = Join-Path $DaoRoot '_tmp' }
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

$daoDir = Join-Path $packDir '_setup\dao'
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

# Hooks 注册模板（issue #65：dao-install.ps1 第 6 步此前手工维护一份 hooks 注册 JSON，
# 与 hooks/ 目录各自独立、无人对账 —— 数到落后 5 个才被发现（考古批 2026-08-08 实测已
# 落后到 9 个）。修法不是把清单补全（补全只会让"它是全的"错觉更像真的，下次照样悄悄
# 落后），而是让 dao-install.ps1 不再持有第二份清单：这里从本仓当前唯一真相源
# （config-sync/common/settings.json 的 common_config_claude.hooks，随 `dao.bat
# --direction=up` 与真实 ~/.claude/settings.json 保持同步）派生出安装用模板，
# 换机安装从此拿到的永远是打包这一刻的真实注册状态。
$hooksSnapshotPath = Join-Path $DaoRoot 'config-sync\common\settings.json'
if (Test-Path $hooksSnapshotPath) {
    # `Get-Content` 读无 BOM UTF-8 文件会按本机 ANSI 代码页解码、当场把中文毁成乱码
    # （dao-powershell.md 第二条），本文件确实无 BOM 且含中文（"note" 字段）——
    # 故走 [IO.File]::ReadAllText 显式钉 UTF-8，不用 Get-Content。
    $snapshotRaw = [System.IO.File]::ReadAllText($hooksSnapshotPath, [System.Text.Encoding]::UTF8)
    $snapshot = $snapshotRaw | ConvertFrom-Json
    $claudeRow = $snapshot.rows | Where-Object { $_.key -eq 'common_config_claude' } | Select-Object -First 1
    if ($claudeRow -and $claudeRow.value) {
        $claudeCfg = $claudeRow.value | ConvertFrom-Json
        if ($claudeCfg.hooks) {
            # 序列化回字符串做路径替换 —— 比逐层遍历事件/matcher/hooks 三层数组
            # 更不容易漏一处（新事件类型加进来也自动跟着走，不用同步改这段代码）。
            $hooksJsonText = $claudeCfg.hooks | ConvertTo-Json -Depth 20
            $hooksJsonText = $hooksJsonText.Replace('${PROJECT_ROOT}/ccswitch/hooks', '__HOOKS_DIR__')
            $hooksJsonText = $hooksJsonText.Replace('${PROJECT_ROOT}\ccswitch\hooks', '__HOOKS_DIR__')
            $hooksJsonText = $hooksJsonText.Replace('${PROJECT_ROOT}\\ccswitch\\hooks', '__HOOKS_DIR__')

            if ($DryRun) {
                Write-Host '  [pack] dao/hooks-template.json（从 config-sync 当前 hooks 配置派生）' -ForegroundColor DarkGray
            } else {
                if (-not (Test-Path $daoDir)) { New-Item -ItemType Directory -Path $daoDir -Force | Out-Null }
                $templateDst = Join-Path $daoDir 'hooks-template.json'
                [System.IO.File]::WriteAllText($templateDst, $hooksJsonText, (New-Object System.Text.UTF8Encoding($false)))
            }
            $script:counts.files++

            # 自查（不是硬闸，只打印）：ccswitch/hooks/ 里有没有文件一个引用都没进这份
            # 模板 —— 若有，说明"文件已存在但没人往 config-sync 里注册它"，是同一枚
            # 硬币的另一面（本条修的是"注册了但清单没跟上"，这条治不了"压根没注册"，
            # 刻意照直打印而不是吞掉）。
            $allHookFiles = Get-ChildItem (Join-Path $DaoRoot 'ccswitch\hooks') -File -Filter 'dao-*.js' -ErrorAction SilentlyContinue
            $unreferenced = @()
            foreach ($hf in $allHookFiles) {
                if ($hooksJsonText.IndexOf($hf.Name) -lt 0) { $unreferenced += $hf.Name }
            }
            if ($unreferenced.Count -gt 0) {
                Write-Host ("  [提醒] ccswitch/hooks/ 有 {0} 个文件不在 config-sync 的 hooks 配置里（安装包会复制文件，但不会注册）：{1}" -f $unreferenced.Count, ($unreferenced -join ', ')) -ForegroundColor Yellow
            }
        } else {
            Write-Host '  [提醒] config-sync/common/settings.json 的 common_config_claude 没有 hooks 字段，本次未生成 hooks-template.json' -ForegroundColor Yellow
        }
    } else {
        Write-Host '  [提醒] config-sync/common/settings.json 里找不到 common_config_claude 行，本次未生成 hooks-template.json' -ForegroundColor Yellow
    }
} else {
    Write-Host '  [提醒] 找不到 config-sync/common/settings.json，本次未生成 hooks-template.json（dao-install.ps1 第 6 步会跳过 hooks 注册并说明原因）' -ForegroundColor Yellow
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
Pack-File (Join-Path $DaoRoot 'scripts\dao-install.ps1') (Join-Path $packDir '_setup\install.ps1') '_setup/install.ps1'

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
