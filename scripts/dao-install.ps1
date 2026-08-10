# dao-install.ps1 — windsurf-dao 零前置安装器
#
# 在一台全新 Windows 机器上，从零安装 Node.js + Claude Code + dao 规则体系。
# 由 install.bat 调用，不要直接运行。
#
# 前提：Windows 10/11（内置 PowerShell 5.1 + winget）

param(
    [string]$TargetDir
)

$ErrorActionPreference = 'Stop'
$ScriptDir = $PSScriptRoot
$DaoSrc = Join-Path $ScriptDir 'dao'
if ($TargetDir) {
    $ClaudeDir = $TargetDir
} else {
    $ClaudeDir = Join-Path $env:USERPROFILE '.claude'
}

# ── 工具函数 ──

function Write-Step($num, $total, $msg) {
    Write-Host "`n[$num/$total] $msg" -ForegroundColor Cyan
}

function Write-Ok($msg) {
    Write-Host "  [OK] $msg" -ForegroundColor Green
}

function Write-Skip($msg) {
    Write-Host "  [跳过] $msg" -ForegroundColor DarkGray
}

function Write-Warn($msg) {
    Write-Host "  [提醒] $msg" -ForegroundColor Yellow
}

function Write-Fail($msg) {
    Write-Host "  [失败] $msg" -ForegroundColor Red
}

function Test-Command($name) {
    try { Get-Command $name -ErrorAction Stop | Out-Null; return $true } catch { return $false }
}

function Copy-DaoFiles($srcDir, $dstDir, $filter, $label) {
    if (-not (Test-Path $srcDir)) { return }
    if (-not (Test-Path $dstDir)) { New-Item -ItemType Directory -Path $dstDir -Force | Out-Null }
    $files = Get-ChildItem $srcDir -File -Filter $filter -ErrorAction SilentlyContinue
    foreach ($f in $files) {
        Copy-Item $f.FullName (Join-Path $dstDir $f.Name) -Force
        Write-Host "    $label/$($f.Name)" -ForegroundColor DarkGray
    }
    if ($files.Count -gt 0) { Write-Ok "$($files.Count) 个 $label 文件" }
}

# ── 预检 ──

Write-Host ''
Write-Host '  ══════════════════════════════════════' -ForegroundColor DarkCyan
Write-Host '   道 · windsurf-dao 一键安装器  v3' -ForegroundColor White
Write-Host '   道法自然 · 从零到可用' -ForegroundColor DarkGray
Write-Host '  ══════════════════════════════════════' -ForegroundColor DarkCyan
Write-Host ''

if (-not (Test-Path (Join-Path $DaoSrc 'dao.md'))) {
    Write-Fail "找不到 dao 源文件。请确保 install.bat 和 dao/ 目录在同一位置。"
    exit 1
}

$totalSteps = 6

# ── Step 1: Node.js ──

Write-Step 1 $totalSteps '检查 Node.js...'

if (Test-Command 'node') {
    $nodeVer = & node --version 2>$null
    Write-Ok "已安装 Node.js $nodeVer"
} else {
    Write-Warn '未找到 Node.js，尝试安装...'

    if (Test-Command 'winget') {
        Write-Host '  正在通过 winget 安装 Node.js LTS...' -ForegroundColor DarkGray
        & winget install OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements 2>$null
        if ($LASTEXITCODE -ne 0) {
            Write-Fail 'winget 安装 Node.js 失败。请手动安装: https://nodejs.org/'
            exit 1
        }
        # 刷新 PATH（winget 安装后当前进程不会自动更新 PATH）
        $machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
        $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
        $env:Path = "$machinePath;$userPath"

        if (Test-Command 'node') {
            Write-Ok "Node.js 已安装: $(& node --version 2>$null)"
        } else {
            Write-Warn 'Node.js 已安装但需重启终端使 PATH 生效。'
            Write-Warn '请关闭此窗口，打开新的命令提示符，重新运行 install.bat。'
            exit 0
        }
    } else {
        Write-Fail '未找到 winget。请手动安装 Node.js: https://nodejs.org/'
        exit 1
    }
}

# ── Step 2: Claude Code ──

Write-Step 2 $totalSteps '检查 Claude Code...'

if (Test-Command 'claude') {
    $claudeVer = & claude --version 2>$null
    Write-Ok "已安装 Claude Code $claudeVer"
} else {
    Write-Warn '未找到 Claude Code，正在安装...'

    if (-not (Test-Command 'npm')) {
        Write-Fail 'npm 不可用（Node.js 可能未完整安装）。请重启终端后重试。'
        exit 1
    }

    & npm install -g @anthropic-ai/claude-code 2>$null
    if ($LASTEXITCODE -ne 0) {
        Write-Fail 'Claude Code 安装失败。请手动运行: npm install -g @anthropic-ai/claude-code'
        exit 1
    }

    $machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = "$machinePath;$userPath"

    if (Test-Command 'claude') {
        Write-Ok "Claude Code 已安装"
    } else {
        Write-Ok 'Claude Code 已安装（可能需重启终端）'
    }
}

# ── Step 3: 创建目录 ──

Write-Step 3 $totalSteps '创建目录结构...'

$dirs = @('skills', 'commands', 'agents', 'hooks', 'references', 'styles', 'themes', 'persona')
foreach ($d in $dirs) {
    $p = Join-Path $ClaudeDir $d
    if (-not (Test-Path $p)) { New-Item -ItemType Directory -Path $p -Force | Out-Null }
}
Write-Ok "~/.claude/ 目录就绪"

# ── Step 4: 部署 dao 文件 ──

Write-Step 4 $totalSteps '部署 dao 文件...'

Copy-Item (Join-Path $DaoSrc 'dao.md') (Join-Path $ClaudeDir 'dao.md') -Force
Write-Ok 'dao.md（核心规则场域）'

$skillsSrc = Join-Path $DaoSrc 'skills'
$skillsDst = Join-Path $ClaudeDir 'skills'
if (Test-Path $skillsSrc) {
    $skillDirs = Get-ChildItem $skillsSrc -Directory -Filter 'dao-*' -ErrorAction SilentlyContinue
    foreach ($sd in $skillDirs) {
        $dst = Join-Path $skillsDst $sd.Name
        if (Test-Path $dst) { Remove-Item $dst -Recurse -Force }
        Copy-Item $sd.FullName $dst -Recurse -Force
        Get-ChildItem $dst -Recurse -Directory -Filter '__pycache__' -ErrorAction SilentlyContinue |
            Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
        Write-Host "    skills/$($sd.Name)" -ForegroundColor DarkGray
    }
    Write-Ok "$($skillDirs.Count) 个技能"
}

Copy-DaoFiles (Join-Path $DaoSrc 'commands') (Join-Path $ClaudeDir 'commands') '*.md' 'commands'

Copy-DaoFiles (Join-Path $DaoSrc 'agents') (Join-Path $ClaudeDir 'agents') 'dao-*.md' 'agents'

$hooksSrc = Join-Path $DaoSrc 'hooks'
$hooksDst = Join-Path $ClaudeDir 'hooks'
if (Test-Path $hooksSrc) {
    if (-not (Test-Path $hooksDst)) { New-Item -ItemType Directory -Path $hooksDst -Force | Out-Null }
    $hooks = Get-ChildItem $hooksSrc -File -Filter 'dao-*' -ErrorAction SilentlyContinue
    foreach ($h in $hooks) {
        Copy-Item $h.FullName (Join-Path $hooksDst $h.Name) -Force
        Write-Host "    hooks/$($h.Name)" -ForegroundColor DarkGray
    }
    if ($hooks.Count -gt 0) { Write-Ok "$($hooks.Count) 个 hooks 文件" }
}

Copy-DaoFiles (Join-Path $DaoSrc 'references') (Join-Path $ClaudeDir 'references') '*.md' 'references'

Copy-DaoFiles (Join-Path $DaoSrc 'styles') (Join-Path $ClaudeDir 'styles') '*.md' 'styles'

Copy-DaoFiles (Join-Path $DaoSrc 'themes') (Join-Path $ClaudeDir 'themes') '*.json' 'themes'

Copy-DaoFiles (Join-Path $DaoSrc 'persona') (Join-Path $ClaudeDir 'persona') '*' 'persona'

# ── Step 5: 配置 CLAUDE.md ──

Write-Step 5 $totalSteps '配置 CLAUDE.md...'

$claudeMd = Join-Path $ClaudeDir 'CLAUDE.md'
$importLine = '@dao.md'
$importBlock = @"

# windsurf-dao Tao field (always_on root, single source of truth)
$importLine
"@

if (-not (Test-Path $claudeMd)) {
    $importBlock.TrimStart() | Set-Content $claudeMd -Encoding utf8
    Write-Ok '创建 CLAUDE.md + @import dao.md'
} else {
    $content = Get-Content $claudeMd -Raw -ErrorAction SilentlyContinue
    if ($content -and $content -match '@dao\.md') {
        Write-Skip 'CLAUDE.md 已包含 @import dao.md'
    } else {
        Add-Content $claudeMd $importBlock -Encoding utf8
        Write-Ok '追加 @import dao.md 到已有 CLAUDE.md'
    }
}

# ── Step 6: 注册 hooks 到 settings.json ──

Write-Step 6 $totalSteps '注册 hooks...'

$settingsPath = Join-Path $ClaudeDir 'settings.json'
$hooksPath = $ClaudeDir.Replace('\', '/')

# issue #65：这里此前手工维护一份 hooks 注册 JSON 字面量，与 ccswitch/hooks/ 目录各自
# 独立、没有任何对账 —— 数到落后 5 个才被发现（2026-08-08 考古复测：已落后到 9 个）。
# 修法不是把清单补全（补全只会让"它是全的"错觉更像真的，下次照样悄悄落后），而是
# 让本文件不再持有第二份清单：注册内容改由 dao-pack.ps1 从本仓 config-sync 快照
# （随 `dao.bat --direction=up` 与真实 ~/.claude/settings.json 保持同步的那一份）
# 派生并打包进 dao/hooks-template.json，本步只做「读模板 → 替换安装目标路径」。
$hooksTemplatePath = Join-Path $DaoSrc 'hooks-template.json'

if (-not (Test-Path $hooksTemplatePath)) {
    Write-Warn 'hooks-template.json 不存在——本次未注册任何 hook（不是"注册了但落后"，是压根没做这一步）。'
    Write-Warn '多半是用旧版 install.bat/dao-pack.ps1 打的包；请用最新版 dao-pack.ps1 重新打包，或手动跑一遍 ~/.claude/settings.json 的 hooks 段。'
} else {
    $hooksTemplateRaw = [System.IO.File]::ReadAllText($hooksTemplatePath, [System.Text.Encoding]::UTF8)
    $hooksJson = $hooksTemplateRaw.Replace('__HOOKS_DIR__', ($hooksPath + '/hooks'))

    $tempHooksFile = Join-Path $env:TEMP 'dao-hooks-config.json'
    [System.IO.File]::WriteAllText($tempHooksFile, $hooksJson)

    $mergeScript = @'
const fs = require('fs');
const settingsPath = process.argv[2];
const hooksFile = process.argv[3];
let settings = {};
if (fs.existsSync(settingsPath)) {
  try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch(e) { settings = {}; }
}
if (settings.hooks) {
  console.log('SKIP');
  process.exit(0);
}
settings.hooks = JSON.parse(fs.readFileSync(hooksFile, 'utf8'));
fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
console.log('OK');
'@

    $tempMerge = Join-Path $env:TEMP 'dao-merge-hooks.js'
    [System.IO.File]::WriteAllText($tempMerge, $mergeScript)

    $result = & node $tempMerge $settingsPath $tempHooksFile 2>$null
    Remove-Item $tempMerge, $tempHooksFile -Force -ErrorAction SilentlyContinue

    if ($result -eq 'SKIP') {
        Write-Skip 'settings.json 已有 hooks 配置，保留原有设置'
    } elseif ($result -eq 'OK') {
        Write-Ok 'hooks 已注册到 settings.json'
    } else {
        Write-Warn "hooks 注册异常: $result"
    }
}

# ── 完成 ──

Write-Host ''
Write-Host '  ══════════════════════════════════════' -ForegroundColor DarkCyan
Write-Host '   安装完成！' -ForegroundColor Green
Write-Host '  ══════════════════════════════════════' -ForegroundColor DarkCyan
Write-Host ''
Write-Host "  部署位置: $ClaudeDir" -ForegroundColor DarkGray
Write-Host ''
Write-Host '  下一步：' -ForegroundColor White
Write-Host '    1. 打开终端，运行 claude 启动 Claude Code' -ForegroundColor DarkGray
Write-Host '    2. 首次使用需登录 Anthropic 账号' -ForegroundColor DarkGray
Write-Host '    3. 开始使用 dao 技能和命令（如 /dao-brainstorm）' -ForegroundColor DarkGray
Write-Host ''
