<#
合并链的那条负控：gh 退出非 0，但 PR 实际已经 MERGED。

守的对象：ccswitch/scripts/dao-pr-merge.ps1 的第 5/6 步。
它失效的样子是**静默的**——gh 的一个退出码盖着「合并 PR」和「删分支」两个动作，
删分支那半失败会把整体退出码拉低（issue #114 实况）。脚本若据这个码判「合并失败」，
第 6 步的清理一步都不跑，而 PR 明明已经合并了；远端于是悄悄攒下已合并分支，全程零报错。

三个场景，少一个这套就证明不了什么：
  ① 正控     gh 退 0 + MERGED       ⇒ exit 0 且走到第 6 步（先证明夹具与桩本身是通的）
  ② 负控核心 gh 退 1 + 实查 MERGED  ⇒ 仍走完第 6 步、远端分支真的被删
  ③ 反向控   gh 退 1 + 实查 OPEN    ⇒ 必须停住。没有它，「干脆无视 gh 退出码」也能让 ② 变绿

不桩 git（被测脚本通篇是 git 编排，桩掉 git 就把要验的东西一并桩掉）；只桩 gh，
因为「PR 在 GitHub 上是什么状态」本地造不出来。沙盒随机化 ⇒ 可与别的测试并行跑。
#>

$ErrorActionPreference = 'Stop'
$repoRoot  = Split-Path -Parent $PSScriptRoot
# 编码钉在脚本自己身上：不这么做，中文断言名经管道回到调用方就是乱码，
# 而 dao check 摘的那一行「证据」正是从这里来的（判据见该文件头注）。
. (Join-Path $repoRoot 'ccswitch/lib/console-utf8.ps1')
$targetPs1 = Join-Path $repoRoot 'ccswitch/scripts/dao-pr-merge.ps1'
$psExe     = (Get-Command powershell).Source
$workRoot  = Join-Path $env:TEMP ("windsurf-dao-merge-chain-neg-" + (Get-Random))
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

if (-not (Test-Path $targetPs1)) { Write-Host "被测脚本不存在：$targetPs1"; exit 1 }
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Write-Host '找不到 git —— 本套用真 git 跑，不桩它'; exit 1 }
New-Item -ItemType Directory -Force -Path $workRoot | Out-Null

$pass = 0; $fail = 0
function Check([string]$Name, [bool]$Cond, [string]$Detail = '') {
    if ($Cond) { $script:pass++; Write-Host "  PASS  $Name" }
    else { $script:fail++; Write-Host "  FAIL  $Name  ->  $Detail" }
}
function Git0([string[]]$GitArgs) {
    $out = & git @GitArgs
    if ($LASTEXITCODE -ne 0) { throw ("夹具 git 失败（exit $LASTEXITCODE）：git " + ($GitArgs -join ' ')) }
    return $out
}

try {

# ── gh 桩：PATH 前置一个假 gh ────────────────────────────────────────────────
# 实现体**不能**叫 gh.ps1：PowerShell 解析裸名 `gh` 时把 .ps1 排在 PATHEXT 的 .cmd 前面，
# 转发那一层连同它设的 DAO_GH_STUB_ARGS 会被整个绕过，桩收到空参数。故实现体另起名。
# gh.cmd 必须纯 ASCII 无 BOM —— cmd.exe 见到 BOM 会把第一行读成乱码命令。
$binDir = Join-Path $workRoot 'bin'
New-Item -ItemType Directory -Force -Path $binDir | Out-Null
$ghCmd = @"
@echo off
set "DAO_GH_STUB_ARGS=%*"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0gh-stub-impl.ps1"
exit /b %ERRORLEVEL%
"@
[IO.File]::WriteAllText((Join-Path $binDir 'gh.cmd'), ($ghCmd -replace "`r?`n", "`r`n"), (New-Object System.Text.ASCIIEncoding))

$ghPs1 = @'
$ErrorActionPreference = 'Stop'
$enc = New-Object System.Text.UTF8Encoding($false)
$argv = @()
if ($env:DAO_GH_STUB_ARGS) { $argv = @(($env:DAO_GH_STUB_ARGS -split '\s+') | Where-Object { $_ -ne '' }) }
$cfg = [IO.File]::ReadAllText($env:DAO_GH_STUB_CONFIG, [Text.Encoding]::UTF8) | ConvertFrom-Json
function Emit([string]$Text, [int]$Code) { if ($Text) { Write-Output $Text }; exit $Code }

if ($argv.Count -ge 2 -and $argv[0] -eq 'pr' -and $argv[1] -eq 'view') {
    $jsonIdx = [array]::IndexOf($argv, '--json')
    $fields = ''
    if ($jsonIdx -ge 0 -and $argv.Count -gt ($jsonIdx + 1)) { $fields = $argv[$jsonIdx + 1] }
    # 第 0 步的前置读取恒成功、恒 OPEN，不参与状态队列
    if ($fields -like '*headRefName*') {
        Emit (ConvertTo-Json (New-Object psobject -Property @{
            number = [int]$argv[2]; headRefName = [string]$cfg.headRefName; state = 'OPEN'; title = 'stub pr' }) -Compress) 0
    }
    Emit (ConvertTo-Json (New-Object psobject -Property @{
        state = [string]$cfg.probeState; mergedAt = '2026-08-12T00:00:00Z' }) -Compress) 0
}
if ($argv.Count -ge 2 -and $argv[0] -eq 'pr' -and $argv[1] -eq 'merge') {
    # ff-main：把裸仓主干快进到 PR 分支尖端 —— 一次**真的**合并，好让「实查 MERGED」名副其实
    if ($cfg.mergeAction -eq 'ff-main') {
        $gd = '--git-dir=' + $cfg.originDir
        $tip = & git $gd rev-parse ('refs/heads/' + $cfg.headRefName)
        if ($LASTEXITCODE -eq 0) { $null = & git $gd update-ref ('refs/heads/' + $cfg.mainBranch) ([string](@($tip)[0])).Trim() }
    }
    Emit ([string]$cfg.mergeStdout) ([int]$cfg.mergeExit)
}
Emit ('gh stub: 未预期的调用 ' + ($argv -join ' ')) 97
'@
[IO.File]::WriteAllText((Join-Path $binDir 'gh-stub-impl.ps1'), $ghPs1, (New-Object System.Text.UTF8Encoding($true)))

# 桩自证：PATH 前置后裸名 gh 必须解析到 gh.cmd。不自证的话，桩自己坏掉会以
# 「被测脚本前置检查退 1」的形态变红，而那个症状指向的是被测脚本。
$oldProbe = $env:PATH
$env:PATH = $binDir + ';' + $oldProbe
$ghResolved = (Get-Command gh -ErrorAction SilentlyContinue).Source
$env:PATH = $oldProbe
if (-not $ghResolved -or ($ghResolved -ne (Join-Path $binDir 'gh.cmd'))) {
    Write-Host "桩自证失败：gh 解析到 $ghResolved"; exit 1
}

# ── 夹具：裸仓当 origin + 一个工作树检出 PR 分支 ─────────────────────────────
function New-Fixture([string]$Case) {
    $dir = Join-Path $workRoot $Case
    $origin = Join-Path $dir 'origin.git'
    $work = Join-Path $dir 'work'
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    Git0 @('init', '--quiet', '--bare', $origin) | Out-Null
    Git0 @('init', '--quiet', $work) | Out-Null
    foreach ($kv in @(@('user.email', 'dao@example.invalid'), @('user.name', 'dao-test'), @('commit.gpgsign', 'false'))) {
        Git0 @('-C', $work, 'config', $kv[0], $kv[1]) | Out-Null
    }
    [IO.File]::WriteAllText((Join-Path $work 'README.md'), "seed`n", $utf8NoBom)
    Git0 @('-C', $work, 'add', 'README.md') | Out-Null
    Git0 @('-C', $work, 'commit', '--quiet', '-m', 'seed') | Out-Null
    Git0 @('-C', $work, 'branch', '-M', 'main') | Out-Null
    Git0 @('-C', $work, 'remote', 'add', 'origin', $origin) | Out-Null
    Git0 @('-C', $work, 'push', '--quiet', '-u', 'origin', 'main') | Out-Null
    Git0 @('-C', $work, 'checkout', '--quiet', '-b', 'feature/x') | Out-Null
    [IO.File]::WriteAllText((Join-Path $work 'feature.txt'), "feature`n", $utf8NoBom)
    Git0 @('-C', $work, 'add', 'feature.txt') | Out-Null
    Git0 @('-C', $work, 'commit', '--quiet', '-m', 'feature work') | Out-Null
    Git0 @('-C', $work, 'push', '--quiet', '-u', 'origin', 'feature/x') | Out-Null
    return [PSCustomObject]@{ Dir = $dir; Origin = $origin; Work = $work; Branch = 'feature/x' }
}

function Invoke-Target($Fixture, [int]$MergeExit, [string]$ProbeState) {
    $cfgPath = Join-Path $Fixture.Dir 'gh-stub.json'
    [IO.File]::WriteAllText($cfgPath, (ConvertTo-Json @{
        headRefName = $Fixture.Branch; originDir = $Fixture.Origin; mainBranch = 'main'
        mergeExit = $MergeExit; mergeStdout = 'stub merge output'; mergeAction = 'ff-main'
        probeState = $ProbeState } -Depth 5), $utf8NoBom)
    $oldPath = $env:PATH
    $env:PATH = $binDir + ';' + $oldPath
    $env:DAO_GH_STUB_CONFIG = $cfgPath
    try {
        $out = & $psExe @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $targetPs1,
            '-PullRequest', '42', '-RepoPath', $Fixture.Work, '-MainBranch', 'main',
            '-StateProbeDelaySeconds', '0', '-VerifyCommand', 'cmd /c exit 0')
        $code = $LASTEXITCODE
    } finally {
        $env:PATH = $oldPath
        Remove-Item Env:\DAO_GH_STUB_CONFIG -ErrorAction SilentlyContinue
    }
    return [PSCustomObject]@{ ExitCode = $code; Text = (@($out) -join "`n") }
}

function Test-RemoteBranch([string]$OriginDir, [string]$Branch) {
    $null = & git ('--git-dir=' + $OriginDir) show-ref --verify --quiet ('refs/heads/' + $Branch)
    return ($LASTEXITCODE -eq 0)
}
function Test-ReachedStep6([string]$Text) { return ($Text -match '===\s*6\.') }

Write-Host "`n=== ① 正控：gh 退 0 + 实查 MERGED ==="
$f1 = New-Fixture 'ok'
$r1 = Invoke-Target $f1 0 'MERGED'
Check '全链 exit 0' ($r1.ExitCode -eq 0) "实际 $($r1.ExitCode)`n$($r1.Text)"
Check '走到第 6 步' (Test-ReachedStep6 $r1.Text)
Check '远端分支已删' (-not (Test-RemoteBranch $f1.Origin $f1.Branch))

Write-Host "`n=== ② 负控（本套核心 · issue #114 原样）：gh 退 1 而实查 MERGED ==="
$f2 = New-Fixture 'gh-nonzero-but-merged'
$r2 = Invoke-Target $f2 1 'MERGED'
Check '不停在第 5 步，走完第 6 步' (Test-ReachedStep6 $r2.Text) $r2.Text
Check '远端分支真的被删（清理没被那个非 0 退出码吃掉）' (-not (Test-RemoteBranch $f2.Origin $f2.Branch))
Check '屏幕上说清了「以状态为准」' ($r2.Text -match '以状态为准') $r2.Text

Write-Host "`n=== ③ 反向控：gh 退 1 且实查 OPEN ⇒ 必须停 ==="
# 没有这一条，「干脆无视 gh 的退出码」也能让 ② 变绿——那是把一道闸拆了而不是修好。
$f3 = New-Fixture 'gh-nonzero-and-open'
$r3 = Invoke-Target $f3 1 'OPEN'
Check '真失败时不许放过（退出码非 0）' ($r3.ExitCode -ne 0) "实际 $($r3.ExitCode)"
Check '真失败时不许走到第 6 步' (-not (Test-ReachedStep6 $r3.Text))
Check '远端分支原样还在' (Test-RemoteBranch $f3.Origin $f3.Branch)

Write-Host "`n=== 汇总: PASS=$pass FAIL=$fail ==="

} finally {
    Remove-Item -Recurse -Force $workRoot -ErrorAction SilentlyContinue
}

if ($fail -gt 0) { exit 1 }
exit 0
