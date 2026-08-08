<#
.SYNOPSIS
    `ccswitch/scripts/dao-pr-merge.ps1` 的行为级回归网（无 Pester 依赖）。退出码 0 = 全部通过。

.DESCRIPTION
    ## 本文件最要紧的那一条是场景 2（负控），别的都是它的陪衬

    issue #114：`gh pr merge --merge --delete-branch` 是**两个动作共用一个退出码** ——
    合并那半成功、删分支那半失败时 gh 退出非 0，而 PR 其实已经合了。脚本据此判「合并失败」
    并硬停 ⇒ **第 6 步（prune + 实查远程 + 删分支）一步都没跑**，远程分支反而残留。

    场景 2 就是把那一幕原样搭出来：**gh 退出 1、PR 实为 MERGED** ⇒ 断言脚本
    **不停在第 5 步**、走完第 6 步、并把远程分支真的清干净、退出码 0。
    没有这一条，「修好了」这句话没有任何东西撑着 —— 因为 `-DryRun` 结构上照不出这个缺口
    （它在第 5 步只打印不执行，那对分歧根本不发生），issue #114 正是 DryRun 全过之后撞上的。

    ## git 是真的，只有 gh 是桩 —— 为什么这么分

    **git 用真的**：fetch / merge / ls-remote / push --delete 全部打在一对**真的本地仓**上
    （`origin.git` 裸仓 + `work` 工作树）。这些命令的行为正是被测判据依赖的东西，
    桩掉它们等于把「远程分支到底还在不在」这个问题也一并桩掉，而那恰恰是要验的。
    连 exit 4 那一档都是真的：给裸仓设 `receive.denyDeletes=true`，`push --delete` 真的被拒。

    **gh 用桩**：`gh` 那一侧要模拟的是「退出码与真实状态不一致」，真去合一个 PR 既不可能
    也不该。桩的形态选了**PATH 前置一个假 `gh`**（沙盒里的 `bin/gh.cmd`），
    在三种可选形态里选它的理由：

      · **PATH 前置（选它）**：被测脚本**一个字都不用改** —— 不给生产脚本加任何测试专用开关。
        它把耦合建立在 `gh` 的**命令行契约**上（子命令、`--json` 字段名、退出码），
        而那正是脚本真实依赖的东西；`Get-Command gh` 与 `& gh` 走的也是同一条解析路径，
        所以连「脚本怎么找到 gh 的」都是真的。
      · 参数注入（给脚本加 `-GhExe`）：要在生产脚本上开一个只有测试用的口子。
      · 环境变量开关（脚本里 `if ($env:...)` 分支）：更糟 —— 生产行为从此依赖环境变量。

    **桩的局限照直写**：它把 `gh` 今天的行为**冻**在这里了。gh 若改了 `--json` 的字段名、
    或改了「合并成功但删分支失败」时的退出码，**本文件会继续全绿而现实已经变了**。
    这是所有桩的通病，没法在桩内部解决；能做的是让断言尽量打在**脚本的可观察行为**上
    （走没走到第 6 步、远程分支还在不在、退出码是几），而不是打在脚本的内部变量上 ——
    那样至少「gh 变了」会以别的方式暴露，而不是被一堆断言粉饰过去。

    ## gh 桩为什么要经 gh.cmd 转一道，而不是直接给 gh.ps1 传参

    `powershell -File x.ps1 pr view 42 --json state,mergedAt` 里的 `--json` 会被 PowerShell
    的参数绑定器当成参数名去匹配脚本的 `param()`，匹配不上就报错。故 `gh.cmd` 把整串参数
    塞进环境变量 `DAO_GH_STUB_ARGS`，`gh.ps1` 自己拆 —— 绕开绑定器。
    （本仓被测参数里没有含空格/引号的，简单按空白拆就够；真要有就得换成更重的转义方案。）

.NOTES
    独立可运行：powershell -NoProfile -ExecutionPolicy Bypass -File tests/dao-pr-merge.tests.ps1
    退出码：0 = 全部通过；1 = 存在失败。

    ## 沙盒路径：**随机化**，不落仓内 `_tmp/`（2026-08-08 · issue #187）

    夹具落 `%TEMP%/windsurf-dao-dao-pr-merge-test-<Get-Random>/`，收尾在 `finally` 里删掉，
    形态照 `tests/link-codex.tests.ps1` 的正解样板。**为什么改**：原先写死
    `_tmp/dao-pr-merge-test` 且启动即 `Remove-Item -Recurse -Force` ⇒ 两个实例并行时
    **后者开跑就把前者的沙盒删了**，那不是「结果不准」而是破坏性竞态；这一条也正是本套
    此前被标 `# @dao-test-tier: env`（整套只在 --env 跑）的理由之一。随机化之后标记已摘、
    本套回到默认层。
    ⚠ **随机化只解决「与自己/与别人并行」**，不解决「同一实例内部」的任何事；也别把它读成
    「现在可以随便并行跑测试了」—— 真 `git` 与 `powershell` 子进程照旧吃 CPU。

    PS 5.1 兼容：无三元运算符、无 && 链、禁 2>&1。本文件须以 BOM UTF-8 存盘。
    需要 PATH 上有真的 `git`（本文件只桩 gh，不桩 git）。
#>

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\ccswitch\lib\console-utf8.ps1')  # pin child-stdout decode to UTF-8 -- see that file (issue #131)
$repoRoot  = Split-Path -Parent $PSScriptRoot
$targetPs1 = Join-Path $repoRoot 'ccswitch/scripts/dao-pr-merge.ps1'
$psExe     = (Get-Command powershell.exe).Source
$workRoot  = Join-Path ([System.IO.Path]::GetTempPath()) "windsurf-dao-dao-pr-merge-test-$(Get-Random)"
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$utf8Bom   = New-Object System.Text.UTF8Encoding($true)

if (-not (Test-Path $targetPs1)) { Write-Host "被测脚本不存在：$targetPs1"; exit 1 }
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Write-Host '找不到 git —— 本回归网用真 git 跑，不桩它'; exit 1 }

# 沙盒随机化之后**开跑不再先删**（2026-08-08 · issue #187）：原先那句
# `if (Test-Path $workRoot) { Remove-Item -Recurse -Force }` 本意是「清上次的残渣」，
# 而它同时就是并行互踩的凶器 —— 后开跑的实例把先开跑那个的整棵沙盒删掉，
# 症状是前者的夹具凭空消失、报文指向被测脚本。随机路径每次唯一 ⇒ 没有残渣可清。
New-Item -ItemType Directory -Force -Path $workRoot | Out-Null

# ⚠ **下面这个 try 块刻意不给整份正文重排缩进**：本文件是护栏类文件，为了加两行收尾清理
# 而把 480 行整体缩进一格，会让 diff 淹掉真正的改动（审查看不见等于没审）。
# PowerShell 不靠缩进断句，`exit` 在 try 里照样会跑 finally 且**退出码原样保留**
# （PS 5.1 本机实测：`try { exit 7 } finally { … }` ⇒ finally 跑了、$LASTEXITCODE=7）。
# 照直写它兜不住的那一格：`$ErrorActionPreference='Stop'` 下的意外抛出会走 finally，
# 但**进程被外部杀掉**（宿主超时、Ctrl-C、run-tests 的 spawnSync 超时）不会 ⇒ 那时
# `%TEMP%` 下会留一个随机名目录。那是已知代价，不是疏漏（旧形态是**每次**都留一个）。
try {

$results = New-Object System.Collections.Generic.List[object]

function Assert-True {
    param([string]$Name, [bool]$Condition, [string]$Detail = '')
    $status = 'FAIL'
    if ($Condition) { $status = 'PASS' }
    $script:results.Add([PSCustomObject]@{ Name = $Name; Status = $status; Detail = $Detail })
    Write-Host ("  [{0}] {1} {2}" -f $status, $Name, $Detail)
}

function Git0 {
    # 夹具搭建用：任何一步失败就地抛出（夹具搭歪了却继续跑，得到的绿是假的）
    param([string[]]$GitArgs)
    $out = & git @GitArgs
    if ($LASTEXITCODE -ne 0) {
        throw ("夹具 git 失败（exit $LASTEXITCODE）：git " + ($GitArgs -join ' ') + "`n" + (@($out) -join "`n"))
    }
    return $out
}

function Test-RemoteBranch {
    # 直接问裸仓「这个 ref 还在不在」—— 不经被测脚本、不经它的任何缓存
    param([string]$OriginDir, [string]$Branch)
    $null = & git ('--git-dir=' + $OriginDir) show-ref --verify --quiet ('refs/heads/' + $Branch)
    return ($LASTEXITCODE -eq 0)
}

function Get-RemoteTip {
    param([string]$OriginDir, [string]$Branch)
    $out = & git ('--git-dir=' + $OriginDir) rev-parse ('refs/heads/' + $Branch)
    if ($LASTEXITCODE -ne 0) { return $null }
    return ([string](@($out)[0])).Trim()
}

# ── gh 桩：PATH 前置一个假 gh（形态选型的理由见文件头 .DESCRIPTION）─────────────
$binDir = Join-Path $workRoot 'bin'
New-Item -ItemType Directory -Force -Path $binDir | Out-Null

# gh.cmd 必须是**纯 ASCII 且无 BOM** —— cmd.exe 见到 BOM 会把第一行读成乱码命令。
#
# ⚠ 实现体**不能**叫 `gh.ps1`（2026-08-04 实测踩到，首版就死在这里）：PowerShell 解析裸名
# `gh` 时把 `.ps1` 排在 PATHEXT 的 `.cmd` **前面** ⇒ `& gh` 会直接命中 `gh.ps1`，
# 转发那一层（连同它设的 DAO_GH_STUB_ARGS）被整个绕过，桩收到空参数、一律回 97。
# 症状是被测脚本前置检查失败退 1，看上去像被测脚本坏了 —— 排一遍才知道是桩自己的解析问题。
# 故实现体改名 `gh-stub-impl.ps1`，同目录下 `gh` 只可能解析到 gh.cmd。
$ghCmd = @"
@echo off
set "DAO_GH_STUB_ARGS=%*"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0gh-stub-impl.ps1"
exit /b %ERRORLEVEL%
"@
[IO.File]::WriteAllText((Join-Path $binDir 'gh.cmd'), ($ghCmd -replace "`r?`n", "`r`n"), (New-Object System.Text.ASCIIEncoding))

# gh.ps1：单引号 here-string，里面的 $ 一律不插值（它要在**子进程**里求值）
$ghPs1 = @'
$ErrorActionPreference = 'Stop'
$enc = New-Object System.Text.UTF8Encoding($false)

$argv = @()
if ($env:DAO_GH_STUB_ARGS) { $argv = @(($env:DAO_GH_STUB_ARGS -split '\s+') | Where-Object { $_ -ne '' }) }
if ($env:DAO_GH_STUB_LOG) { [IO.File]::AppendAllText($env:DAO_GH_STUB_LOG, (($argv -join ' ') + "`r`n"), $enc) }

$cfgPath = $env:DAO_GH_STUB_CONFIG
$cfg = [IO.File]::ReadAllText($cfgPath, [Text.Encoding]::UTF8) | ConvertFrom-Json

function Emit {
    param([string]$Text, [int]$Code)
    if ($Text) { Write-Output $Text }
    exit $Code
}

if ($argv.Count -ge 2 -and $argv[0] -eq 'pr' -and $argv[1] -eq 'view') {
    $jsonIdx = [array]::IndexOf($argv, '--json')
    $fields = ''
    if ($jsonIdx -ge 0 -and $argv.Count -gt ($jsonIdx + 1)) { $fields = $argv[$jsonIdx + 1] }

    # 第 0 步的前置读取（--json 里有 headRefName）：恒成功、恒 OPEN，不参与本桩的队列
    if ($fields -like '*headRefName*') {
        $o = New-Object psobject -Property @{
            number      = [int]$argv[2]
            headRefName = [string]$cfg.headRefName
            state       = 'OPEN'
            title       = 'stub pr'
        }
        Emit (ConvertTo-Json $o -Compress) 0
    }

    # 第 5 步的状态实查：按队列消费（数组用完后重复最后一项）
    $countFile = $cfgPath + '.viewcount'
    $n = 0
    if (Test-Path $countFile) { $n = [int]([IO.File]::ReadAllText($countFile, [Text.Encoding]::UTF8)) }
    [IO.File]::WriteAllText($countFile, [string]($n + 1), $enc)

    $codes  = @($cfg.probeExitCodes)
    $states = @($cfg.probeStates)
    $i = $n; if ($i -ge $codes.Count)  { $i = $codes.Count - 1 }
    $j = $n; if ($j -ge $states.Count) { $j = $states.Count - 1 }

    $code = [int]$codes[$i]
    if ($code -ne 0) { Emit 'stub: pr view failed' $code }
    $o = New-Object psobject -Property @{ state = [string]$states[$j]; mergedAt = '2026-08-04T00:00:00Z' }
    Emit (ConvertTo-Json $o -Compress) 0
}

if ($argv.Count -ge 2 -and $argv[0] -eq 'pr' -and $argv[1] -eq 'merge') {
    # ff-main：把裸仓的主干快进到 PR 分支尖端 —— 一次**真的**合并，不需要工作树
    if ($cfg.mergeAction -eq 'ff-main') {
        $gd = '--git-dir=' + $cfg.originDir
        $tip = & git $gd rev-parse ('refs/heads/' + $cfg.headRefName)
        if ($LASTEXITCODE -eq 0) {
            $null = & git $gd update-ref ('refs/heads/' + $cfg.mainBranch) ([string](@($tip)[0])).Trim()
        }
    }
    Emit ([string]$cfg.mergeStdout) ([int]$cfg.mergeExit)
}

Emit ('gh stub: 未预期的调用 ' + ($argv -join ' ')) 97
'@
[IO.File]::WriteAllText((Join-Path $binDir 'gh-stub-impl.ps1'), $ghPs1, $utf8Bom)

# 桩自证：解析裸名 `gh` 必须落在 gh.cmd 上。这一条不是形式主义 —— 上面那个注释里的坑
# 一旦复发（有人把实现体改回 gh.ps1、或往 bin 里丢了别的 gh.*），全部场景会以「被测脚本
# 前置检查退 1」的形态集体变红，而那个症状指向的是被测脚本，不是桩。先在这里说清楚。
$ghResolvedPath = $null
$oldPathProbe = $env:PATH
$env:PATH = $binDir + ';' + $oldPathProbe
try {
    $ghResolved = Get-Command gh -ErrorAction SilentlyContinue
    if ($ghResolved) { $ghResolvedPath = $ghResolved.Source }
} finally { $env:PATH = $oldPathProbe }
if (-not $ghResolvedPath -or ($ghResolvedPath -notlike (Join-Path $binDir 'gh.cmd'))) {
    Write-Host "桩自证失败：PATH 前置后 `gh` 解析到了 $ghResolvedPath，不是 $binDir\gh.cmd"
    exit 1
}

# ── 夹具：一对真的本地仓（裸仓当 origin + 工作树当 PR 分支所在地）───────────────
function New-Fixture {
    param([string]$Case, [switch]$DenyDeletes)
    $dir    = Join-Path $workRoot $Case
    $origin = Join-Path $dir 'origin.git'
    $work   = Join-Path $dir 'work'
    New-Item -ItemType Directory -Force -Path $dir | Out-Null

    Git0 @('init', '--quiet', '--bare', $origin) | Out-Null
    # ⚠ 括号不可省：PowerShell 的 `,` 比 `+` 结合更紧，写成 `@('--git-dir=' + $origin, 'config', …)`
    # 会被解析成 `'--git-dir=' + ($origin,'config',…)` ⇒ 四个参数被拼成**一个**，git 只回一页 usage。
    if ($DenyDeletes) { Git0 @(('--git-dir=' + $origin), 'config', 'receive.denyDeletes', 'true') | Out-Null }

    Git0 @('init', '--quiet', $work) | Out-Null
    Git0 @('-C', $work, 'config', 'user.email', 'dao@example.invalid') | Out-Null
    Git0 @('-C', $work, 'config', 'user.name', 'dao-test') | Out-Null
    Git0 @('-C', $work, 'config', 'commit.gpgsign', 'false') | Out-Null

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

function New-StubConfig {
    param(
        [PSCustomObject]$Fixture,
        [int]$MergeExit = 0,
        [string]$MergeStdout = '',
        [string]$MergeAction = 'ff-main',
        [int[]]$ProbeExitCodes = @(0),
        [string[]]$ProbeStates = @('MERGED')
    )
    return @{
        headRefName    = $Fixture.Branch
        originDir      = $Fixture.Origin
        mainBranch     = 'main'
        mergeExit      = $MergeExit
        mergeStdout    = $MergeStdout
        mergeAction    = $MergeAction
        probeExitCodes = $ProbeExitCodes
        probeStates    = $ProbeStates
    }
}

function Invoke-Target {
    param(
        [PSCustomObject]$Fixture,
        [hashtable]$Cfg,
        [string]$RepoPath,
        [string[]]$ExtraArgs = @('-VerifyCommand', 'cmd /c exit 0')
    )
    if (-not $RepoPath) { $RepoPath = $Fixture.Work }
    $cfgPath = Join-Path $Fixture.Dir 'gh-stub.json'
    $logPath = Join-Path $Fixture.Dir 'gh-calls.log'
    [IO.File]::WriteAllText($cfgPath, (ConvertTo-Json $Cfg -Depth 5), $utf8NoBom)
    foreach ($stale in @(($cfgPath + '.viewcount'), $logPath)) {
        if (Test-Path $stale) { Remove-Item $stale -Force }
    }

    $oldPath = $env:PATH
    $env:PATH = $binDir + ';' + $oldPath
    $env:DAO_GH_STUB_CONFIG = $cfgPath
    $env:DAO_GH_STUB_LOG = $logPath
    $out = $null
    $code = $null
    try {
        $psArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $targetPs1,
                    '-PullRequest', '42', '-RepoPath', $RepoPath, '-MainBranch', 'main',
                    '-StateProbeDelaySeconds', '0') + $ExtraArgs
        $out = & $psExe @psArgs
        $code = $LASTEXITCODE
    } finally {
        $env:PATH = $oldPath
        if (Test-Path Env:DAO_GH_STUB_CONFIG) { Remove-Item Env:DAO_GH_STUB_CONFIG }
        if (Test-Path Env:DAO_GH_STUB_LOG) { Remove-Item Env:DAO_GH_STUB_LOG }
    }
    $log = ''
    if (Test-Path $logPath) { $log = [IO.File]::ReadAllText($logPath, [Text.Encoding]::UTF8) }
    return [PSCustomObject]@{ ExitCode = $code; Text = (@($out) -join "`n"); GhLog = $log }
}

# 「走到第 6 步了吗」是本文件反复要问的那一句，抽成一个判据免得各处各写一版
function Test-ReachedStep6 { param([string]$Text) return ($Text -match '===\s*6\.') }

Write-Host ''
Write-Host '== dao-pr-merge 回归测试 =='
Write-Host ''

# ============================================================================
# 场景 1：正控 —— 正常合并全链 exit 0
# ============================================================================
# 没有这一条，下面所有"该失败时失败"的断言都可能只是"恒失败"也照样绿。
Write-Host '场景 1：正控（gh 退 0 + PR 实为 MERGED ⇒ 全链 exit 0）'

$f1 = New-Fixture -Case 'ok'
$r1 = Invoke-Target -Fixture $f1 -Cfg (New-StubConfig -Fixture $f1)

Assert-True '1a 全链 exit 0' ($r1.ExitCode -eq 0) ("exit={0}" -f $r1.ExitCode)
Assert-True '1b 汇总行打出 VERIFY_EXIT=0（唯一的机器可读通道）' `
    ($r1.Text -match 'VERIFY_EXIT=0') ''
Assert-True '1c 第 5 步的判据是实查到的状态，不是 gh 的退出码' `
    ($r1.Text -match '已合并（实查 state=MERGED') ''
Assert-True '1d 走到了第 6 步' (Test-ReachedStep6 $r1.Text) ''
Assert-True '1e 远程分支真的没了（直接问裸仓，不信脚本的自述）' `
    (-not (Test-RemoteBranch -OriginDir $f1.Origin -Branch $f1.Branch)) ''
# 1f 钉的是一段**此前从来没跑过**的代码：本地清理原先由 `if (-not $selfWt)` 守着，
# 而 $selfWt 恒为真（见被测脚本 .DESCRIPTION 边界 ④ 那段⚠）。改判据为「本树是不是主工作树」
# 之后它才第一次真的执行。与场景 8c 是一对：那边是链接工作树，必须**不**执行。
Assert-True '1f 主工作树里跑 ⇒ 本地分支真的删掉了（原实现这一段是死码，从来没跑过）' `
    (($r1.Text -match '已删本地分支 feature/x') -and (-not ($r1.Text -match '本地那半跳过'))) ''

# 根治那一半的断言：两个动作不再共用一个退出码 ⇒ 第 5 步不许再传 --delete-branch。
# 这一条打在**真实发出的命令行**上（gh 桩的调用日志），不是打在源码文本上。
$mergeCalls = @(($r1.GhLog -split "`r?`n") | Where-Object { $_ -match '^pr merge' })
Assert-True '1g 第 5 步只发 `gh pr merge --merge`，**不带** --delete-branch（根治：删分支归第 6 步）' `
    ((@($mergeCalls).Count -eq 1) -and ($mergeCalls[0] -notmatch '--delete-branch') -and ($mergeCalls[0] -match '--merge')) `
    ("实发：{0}" -f ($mergeCalls -join ' | '))
Assert-True '1h 第 5 步确实发了状态实查（--json state,mergedAt）' `
    ($r1.GhLog -match 'pr view 42 --json state,mergedAt') ''

# ============================================================================
# 场景 2：**负控（本单核心）** —— gh 非 0，但 PR 实为 MERGED
# ============================================================================
# issue #114 的原样复刻：gh 的一个退出码盖着两个动作，删分支那半失败拉低了整体退出码。
# 旧实现在这里判「合并失败」并硬停 ⇒ 第 6 步一步都没跑 ⇒ 远程分支残留。
# 断言分三层，缺一层都留着病：①不停在第 5 步 ②真走到第 6 步 ③远程分支真被清干净。
Write-Host '场景 2：负控 —— gh pr merge 退 1 而 PR 实为 MERGED（issue #114 原样）'

$f2 = New-Fixture -Case 'gh-nonzero-but-merged'
$ghErr = "fatal: 'master' is already used by worktree at 'D:/frank/windsurf-dao'"
$r2 = Invoke-Target -Fixture $f2 -Cfg (New-StubConfig -Fixture $f2 -MergeExit 1 -MergeStdout $ghErr)

Assert-True '2a **不停在第 5 步**：exit 0（旧实现在这里是 2）' `
    ($r2.ExitCode -eq 0) ("exit={0}" -f $r2.ExitCode)
Assert-True '2b 真的走到了第 6 步（清理才是这时候的正路）' (Test-ReachedStep6 $r2.Text) ''
Assert-True '2c 远程分支真被清干净（直接问裸仓 —— 旧实现在这里会残留）' `
    (-not (Test-RemoteBranch -OriginDir $f2.Origin -Branch $f2.Branch)) ''
Assert-True '2d 屏幕上说清了「gh 退非 0 但状态为 MERGED，以状态为准」' `
    (($r2.Text -match '以状态为准') -and ($r2.Text -match 'gh pr merge 退出 1')) ''
Assert-True '2e gh 的原始 stderr 文案照样打出来（不吞掉证据）' `
    ($r2.Text -match 'already used by worktree') ''
Assert-True '2f 合并确实发生过：裸仓 main 已前进到 PR 分支尖端（证明本场景不是"什么都没做也绿"）' `
    ((Get-RemoteTip -OriginDir $f2.Origin -Branch 'main') -ne $null) ''

# ============================================================================
# 场景 3：负控的反面 —— gh 非 0 且 PR 真的没合
# ============================================================================
# 场景 2 若被实现成「gh 非 0 一律当合成了」，本场景会红。两条一起才夹得住。
Write-Host '场景 3：gh pr merge 退 1 且 PR 实为 OPEN ⇒ 判失败、不动分支'

$f3 = New-Fixture -Case 'gh-nonzero-open'
$r3 = Invoke-Target -Fixture $f3 -Cfg (New-StubConfig -Fixture $f3 -MergeExit 1 -MergeAction 'none' -ProbeStates @('OPEN'))

Assert-True '3a exit 2（跑到一半失败）' ($r3.ExitCode -eq 2) ("exit={0}" -f $r3.ExitCode)
Assert-True '3b **不**走第 6 步（没合的 PR 不许进清理）' (-not (Test-ReachedStep6 $r3.Text)) ''
Assert-True '3c 远程分支原封不动（删掉一个未合 PR 的分支代价更高）' `
    (Test-RemoteBranch -OriginDir $f3.Origin -Branch $f3.Branch) ''
Assert-True '3d 失败信息里带实查到的状态，不只带 gh 的退出码' `
    ($r3.Text -match 'state=OPEN') ''

# ============================================================================
# 场景 4：gh 退 0 但 PR 实为 OPEN —— 退出码 0 同样不是判据
# ============================================================================
# 「别问刚才那条命令返回了几」是双向的：非 0 不等于失败，0 也不等于成功。
Write-Host '场景 4：gh pr merge 退 0 而 PR 实为 OPEN ⇒ 仍判失败（0 也不是判据）'

$f4 = New-Fixture -Case 'gh-zero-open'
$r4 = Invoke-Target -Fixture $f4 -Cfg (New-StubConfig -Fixture $f4 -MergeExit 0 -MergeAction 'none' -ProbeStates @('OPEN'))

Assert-True '4a exit 2' ($r4.ExitCode -eq 2) ("exit={0}" -f $r4.ExitCode)
Assert-True '4b 不走第 6 步' (-not (Test-ReachedStep6 $r4.Text)) ''
Assert-True '4c 远程分支原封不动' (Test-RemoteBranch -OriginDir $f4.Origin -Branch $f4.Branch) ''

# ============================================================================
# 场景 5：边界 —— 合了但远程分支删不掉 ⇒ exit 4（与 0 严格区分）
# ============================================================================
# 裸仓 `receive.denyDeletes=true`：push --delete 真的被拒，不是桩出来的。
Write-Host '场景 5：合了但远程分支删不掉 ⇒ exit 4'

$f5 = New-Fixture -Case 'delete-denied' -DenyDeletes
$r5 = Invoke-Target -Fixture $f5 -Cfg (New-StubConfig -Fixture $f5)

Assert-True '5a exit 4（不是 0 —— 「删干净了」与「没删掉」不许长得一样）' `
    ($r5.ExitCode -eq 4) ("exit={0}" -f $r5.ExitCode)
Assert-True '5b 走到了第 6 步并实查过（这一档的前提是合并成功）' (Test-ReachedStep6 $r5.Text) ''
Assert-True '5c 屏幕上明说「删完仍在」' ($r5.Text -match '删完仍在') ''
Assert-True '5d 远程分支确实还在（断言打在裸仓上，证明 exit 4 不是凭空来的）' `
    (Test-RemoteBranch -OriginDir $f5.Origin -Branch $f5.Branch) ''

# ============================================================================
# 场景 6：状态实查读不到 ⇒ fail-closed 退 2，且**不动分支**
# ============================================================================
Write-Host '场景 6：状态实查连试 3 次读不到 ⇒ fail-closed exit 2'

$f6 = New-Fixture -Case 'probe-unreadable'
$r6 = Invoke-Target -Fixture $f6 -Cfg (New-StubConfig -Fixture $f6 -ProbeExitCodes @(1, 1, 1))

Assert-True '6a exit 2（不确定不许长得像干净）' ($r6.ExitCode -eq 2) ("exit={0}" -f $r6.ExitCode)
Assert-True '6b 明说「状态实查不到」并给出人该跑什么' `
    (($r6.Text -match '状态实查不到') -and ($r6.Text -match 'gh pr view 42 --json state,mergedAt')) ''
Assert-True '6c 不走第 6 步、远程分支原封不动（不猜 ⇒ 不动）' `
    ((-not (Test-ReachedStep6 $r6.Text)) -and (Test-RemoteBranch -OriginDir $f6.Origin -Branch $f6.Branch)) ''
$probeCalls = @(($r6.GhLog -split "`r?`n") | Where-Object { $_ -match 'state,mergedAt' })
Assert-True '6d 真的试满 3 次（不是试 1 次就放弃）' (@($probeCalls).Count -eq 3) `
    ("实发 {0} 次" -f @($probeCalls).Count)

# ============================================================================
# 场景 7：实查第一次失败、第二次成功 ⇒ 重试救回来，全链 exit 0
# ============================================================================
# 没有这一条，场景 6 的实现可以是「第一次失败就判 Unknown」也照样绿。
Write-Host '场景 7：实查首次失败、次次成功 ⇒ 重试救回，exit 0'

$f7 = New-Fixture -Case 'probe-retry'
$r7 = Invoke-Target -Fixture $f7 -Cfg (New-StubConfig -Fixture $f7 -ProbeExitCodes @(1, 0) -ProbeStates @('MERGED', 'MERGED'))

Assert-True '7a exit 0' ($r7.ExitCode -eq 0) ("exit={0}" -f $r7.ExitCode)
Assert-True '7b 报出「第 2 次读到」（重试次数是可见的，不是黑箱）' `
    ($r7.Text -match '第 2 次读到') ''
Assert-True '7c 远程分支已清干净' `
    (-not (Test-RemoteBranch -OriginDir $f7.Origin -Branch $f7.Branch)) ''

# ============================================================================
# 场景 8：worktree 场景（issue #114 的真实身位）
# ============================================================================
# 从 PR 分支的 worktree 里跑：本地那半归人，但远程那半必须清干净、退出码必须是 0。
Write-Host '场景 8：从 PR 分支的 worktree 里跑（#114 的真实身位）'

$f8 = New-Fixture -Case 'from-worktree'
Git0 @('-C', $f8.Work, 'checkout', '--quiet', 'main') | Out-Null
$wt8 = Join-Path $f8.Dir 'wt'
Git0 @('-C', $f8.Work, 'worktree', 'add', '--quiet', $wt8, 'feature/x') | Out-Null
$r8 = Invoke-Target -Fixture $f8 -Cfg (New-StubConfig -Fixture $f8) -RepoPath $wt8

Assert-True '8a exit 0（旧实现在这里是结构性必失败，每一次都误判）' `
    ($r8.ExitCode -eq 0) ("exit={0}" -f $r8.ExitCode)
Assert-True '8b 远程分支清干净了' `
    (-not (Test-RemoteBranch -OriginDir $f8.Origin -Branch $f8.Branch)) ''
Assert-True '8c 认出「我在**链接**工作树里」并跳过本地清理（与 1f 成对：那边必须真删）' `
    (($r8.Text -match '链接\*\* worktree 里') -and ($r8.Text -match '本地那半跳过') -and `
     (-not ($r8.Text -match '已删本地分支'))) ''
Assert-True '8d 打出**带真实路径、可直接复制**的两行收尾命令（边界 ④：脚本不拆自己脚下的树）' `
    (($r8.Text -match 'git -C "[^"]+" worktree remove "[^"]+"') -and `
     ($r8.Text -match 'git -C "[^"]+" branch -d feature/x')) ''

# ============================================================================
# 场景 9：-DryRun 一个写操作都不做
# ============================================================================
# 「改完自己跑一次 -DryRun 冒烟」是本脚本的使用铁律，那条铁律得有人守着。
Write-Host '场景 9：-DryRun 零写操作'

$f9 = New-Fixture -Case 'dryrun'
$tip9before = Get-RemoteTip -OriginDir $f9.Origin -Branch 'main'
$r9 = Invoke-Target -Fixture $f9 -Cfg (New-StubConfig -Fixture $f9) `
        -ExtraArgs @('-VerifyCommand', 'cmd /c exit 0', '-DryRun')

Assert-True '9a exit 0' ($r9.ExitCode -eq 0) ("exit={0}" -f $r9.ExitCode)
Assert-True '9b **没有**发出 gh pr merge（日志里只该有第 0 步那次 pr view）' `
    (($r9.GhLog -notmatch 'pr merge') -and ($r9.GhLog -match 'pr view 42 --json number')) `
    ("日志：{0}" -f ($r9.GhLog -replace "`r?`n", ' / '))
Assert-True '9c 远程分支没被动、主干没被推进（真·零写操作）' `
    ((Test-RemoteBranch -OriginDir $f9.Origin -Branch $f9.Branch) -and `
     ((Get-RemoteTip -OriginDir $f9.Origin -Branch 'main') -eq $tip9before)) ''
Assert-True '9d 前置检查与各步打印都还在（0/1-2/3/4/5/6 六个步骤标题）' `
    (($r9.Text -match '===\s*0\.') -and ($r9.Text -match '===\s*1-2\.') -and `
     ($r9.Text -match '===\s*3\.') -and ($r9.Text -match '===\s*4\.') -and `
     ($r9.Text -match '===\s*5\.') -and (Test-ReachedStep6 $r9.Text)) ''
Assert-True '9e DryRun 自陈它照不出第 5 步的判据（#114 就是 DryRun 全过之后撞上的）' `
    ($r9.Text -match 'DryRun 照不出第 5 步的判据') ''

# ============================================================================
# 场景 10：退出码契约的其余四态没被这次改动碰过
# ============================================================================
# 本次只该改「哪些情形落进 2」，五态语义一个字不许动。这里把另外几态钉住。
Write-Host '场景 10：退出码契约五态（1 / 2 / 3 / 0 各自还在原位）'

$f10 = New-Fixture -Case 'contract'

$r10a = Invoke-Target -Fixture $f10 -Cfg (New-StubConfig -Fixture $f10) `
          -ExtraArgs @('-SkipVerify', '-NoMerge')
Assert-True '10a -SkipVerify ⇒ exit 2（「没跑」不许长得像「跑过且过了」）' `
    ($r10a.ExitCode -eq 2) ("exit={0}" -f $r10a.ExitCode)

$r10b = Invoke-Target -Fixture $f10 -Cfg (New-StubConfig -Fixture $f10) `
          -ExtraArgs @('-VerifyCommand', 'cmd /c exit 0', '-NoMerge')
Assert-True '10b -NoMerge + 验证过 ⇒ exit 0（且没发出任何 gh pr merge）' `
    (($r10b.ExitCode -eq 0) -and ($r10b.GhLog -notmatch 'pr merge')) ("exit={0}" -f $r10b.ExitCode)

$r10c = Invoke-Target -Fixture $f10 -Cfg (New-StubConfig -Fixture $f10) `
          -ExtraArgs @('-VerifyCommand', 'cmd /c exit 7')
Assert-True '10c 验证红 ⇒ exit 2 且不合 PR（分支态的绿不构成合并态的证据）' `
    (($r10c.ExitCode -eq 2) -and ($r10c.GhLog -notmatch 'pr merge')) ("exit={0}" -f $r10c.ExitCode)

$r10d = Invoke-Target -Fixture $f10 -Cfg (New-StubConfig -Fixture $f10) `
          -ExtraArgs @('-VerifyCommand', 'cmd /c exit 0', '-SkipVerify')
Assert-True '10d -SkipVerify 与 -VerifyCommand 互斥 ⇒ exit 3（参数非法）' `
    ($r10d.ExitCode -eq 3) ("exit={0}" -f $r10d.ExitCode)

$oldPath10 = $env:PATH
$env:PATH = $binDir + ';' + $oldPath10
try {
    $out10e = & $psExe @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $targetPs1,
                         '-PullRequest', '42', '-RepoPath', (Join-Path $workRoot 'never-created'),
                         '-VerifyCommand', 'cmd /c exit 0')
    $code10e = $LASTEXITCODE
} finally { $env:PATH = $oldPath10 }
Assert-True '10e RepoPath 不存在 ⇒ exit 1（前置不成立，一步都没做）' `
    ($code10e -eq 1) ("exit={0}" -f $code10e)
Assert-True '10f exit 1 那一档确实一步都没做（输出停在第 0 步）' `
    (-not ((@($out10e) -join "`n") -match '===\s*1-2\.')) ''

# ============================================================================
# 场景 11：被测脚本自身可解析（白拿的一条，防"改崩了但没人跑到那一行"）
# ============================================================================
Write-Host '场景 11：被测脚本零语法错误'

$tokens11 = $null
$errors11 = $null
$null = [System.Management.Automation.Language.Parser]::ParseFile($targetPs1, [ref]$tokens11, [ref]$errors11)
Assert-True '11a dao-pr-merge.ps1 能被 PowerShell 解析器解析（零语法错误）' `
    (@($errors11).Count -eq 0) ("ParseErrors={0}" -f @($errors11).Count)

# ---- 汇总 -------------------------------------------------------------------
Write-Host ''
Write-Host '=============================================='
Write-Host '          dao-pr-merge 汇总'
Write-Host '=============================================='
$failing = @($results | Where-Object { $_.Status -ne 'PASS' })
foreach ($r in $results) { Write-Host ("  {0,-6} {1}" -f $r.Status, $r.Name) }
Write-Host '=============================================='
Write-Host ("=== 汇总: PASS={0} FAIL={1} ===" -f ($results.Count - $failing.Count), $failing.Count)
if ($failing.Count -gt 0) {
    Write-Host ("dao-pr-merge 失败：{0}/{1} 项未通过" -f $failing.Count, $results.Count)
    exit 1
}
Write-Host ("dao-pr-merge 全部通过（{0} 项）。" -f $results.Count)
exit 0

} finally {
    # 随机沙盒的收尾（issue #187）。`-ErrorAction SilentlyContinue`：清理失败不该把一次
    # 通过的回归网翻成红 —— 清不掉最坏结果是 %TEMP% 里多一个目录，而把绿改成红会训练人
    # 无视这道闸。git 在 .git 里留只读对象文件，`-Force` 是为它准备的。
    Remove-Item -LiteralPath $workRoot -Recurse -Force -ErrorAction SilentlyContinue
}
