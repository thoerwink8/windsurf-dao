<#
.SYNOPSIS
    `ccswitch/scripts/dao-secrets-init.ps1` 与 `dao-secrets-migrate.ps1` 的行为级回归网
    （无 Pester 依赖）。退出码 0 = 全部通过。

.DESCRIPTION
    ## 这个文件为什么存在

    PR #138 的乙路对抗验证官用 mutation 量出来一件事：那两个脚本合计 522 行、**操作真凭据、
    会删真文件**，而全仓 `tests/` 里对它们**零命中** —— `node scripts/run-tests.mjs --env`
    报的 `files=32 pass=2531 red=0` 是真的，但那个绿**对这两个脚本结构上是瞎的**。
    他把两道承重守卫按三形态换靶（删 / 注释 / 结果不被消费），**四个变体的末行契约与未变异
    基线逐字节相同**，调用点覆盖率 0/2。

    失败模式不是「覆盖率低了点」：**是删掉用户唯一一份明文 GitHub 账号口令。**

    ⚠ **清偿动作是「落成文件」不是「补写」**：真 sops 全链、负控、三形态 mutation 在 PR #138
    第二轮里**已经跑过**，只是没提交成回归网。本文件把那些一次性实跑变成常驻断言。

    ## 两道承重守卫（本文件的靶，乙路点名的就是这两道）

    - **G1** `dao-secrets-init.ps1` 第 6 步
      `if ($encText.Contains($probeVal)) { Fail '密文里能看到明文探针值 —— 加密没真的发生，停' }`
      —— **它是唯一证明「加密真的发生了」的那一句。** 没有它，一个把内容原样抄过去的实现
      也会 exit 0 而自证全绿，用户拿到一个「加密根」里装的全是明文。
      靶在场景 2：sops 桩置为 `passthrough`（encrypt 就是复制）。
      **判别力从哪来**：passthrough 下 decrypt 也照样回得来、值也对得上 ⇒ **除了 G1，没有
      任何一条断言会不高兴**。G1 一没，init 就 exit 0。

    - **G2** `dao-secrets-migrate.ps1` 复核段
      `if ($srcKeys.Count -eq 0) { Fail '源文件一个键都没解析出来 —— 判为异常，原件**不删**' }`
      —— 它守的是「解析器瞎了 ⇒ 空集比空集 ⇒ `$missing` 与 `$mismatch` 双双为空 ⇒ 全过
      ⇒ **删原件**」。靶在场景 6：源文件是一份 **JSON 形态**的凭据文件（真实场景：有人把
      migrate 指向一个不是 dotenv 的凭据文件），`Read-DotEnvMap` 解析出 0 个键。

    ## 为什么断言全打在行为上，一条文本匹配都没有

    本文件**刻意不含**「源码里还有没有那一行 `if`」这类断言。判据是 `#官抗-改坏多形态`：
    **文本匹配型守护对「注释掉」这一形态天然失明** —— 而那正是乙路 T2 / M2 用的改法。
    行为断言（退出码 + 文件在不在 + 屏幕上说了什么）对删 / 注释 / `$false -and` 三形态一视同仁，
    因为三者产生的**可观察行为完全相同**：那道判断不再拦人。

    ## 桩、判别力记分板、复现步骤

    都在下面 dot-source 之后那一整段行注释里。**刻意放在那儿而不是这里**：
    `tests/ps-console-encoding.tests.js` 有一条不变量要求每套 `.ps1` 测试在**头 80 行内**
    dot-source 解码钉子（`ccswitch/lib/console-utf8.ps1`），而这份头注一长就把它挤过了 80 行。
    （首版就是这么红的 —— 而那一红是对的：钉子晚一行，前面所有捕获中文的断言就都不作数。）

.NOTES
    独立可运行：powershell -NoProfile -ExecutionPolicy Bypass -File tests/dao-secrets.tests.ps1
    退出码：0 = 全部通过；1 = 存在失败。
    夹具落 `_tmp/dao-secrets-test/`（运行期生成、不入库，`_tmp/` 已在 .gitignore 第 1 行）。
    PS 5.1 兼容：无三元运算符、无 && 链、禁 2>&1。**本文件须以 BOM UTF-8 存盘**
    （少了 BOM，PS 5.1 会按 CP936 重读中文，整套报废而报文指向别处）。

    🔴 **凭据面纪律**：本文件只造假串（`sk-FAKE-*` / `AGE-SECRET-KEY-1FAKE...`），
    **不读、不写、不删任何真凭据**；`-SecretsDir` 全部指向 `_tmp/`，
    **绝不传 `-SetUserEnvVar`**（那会真的写用户级环境变量）。
    收尾有一条断言专门核「真凭据根 `%USERPROFILE%\.dao-secrets` 的存在状态没被本次跑动过」。
#>

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\ccswitch\lib\console-utf8.ps1')  # pin child-stdout decode to UTF-8 -- see that file (issue #131)

# ════════════════════════════════════════════════════════════════════════════
# 附一 · 桩的形态：PATH 前置假 sops / 假 age-keygen —— 为什么这么选
#
# 与 tests/dao-pr-merge.tests.ps1 同一路数，理由也一样：
#   · **PATH 前置（选它）**：被测脚本**一个字都不用改** —— 不给生产脚本开任何测试专用口子。
#     耦合建立在 sops 的**命令行契约**上（子命令、--config 的全局位、--output、退出码），
#     而那正是脚本真实依赖的东西；Get-Command sops 与 & sops 走同一条解析路径。
#   · 参数注入 / 环境变量开关：都要在生产脚本上留一个只有测试用的分支，更糟。
#
# **为什么必须桩掉 sops 而不是用真的**：真 sops + 真 age 是 250 MB 的外部二进制，
# 装它等于把回归网的前置条件变成「这台机器上得有 sops」—— 那样它在多数环境下会被跳过，
# 而**被跳过的回归网与不存在的回归网在退出码上不可区分**。桩让这一套在任何
# Windows + PS 5.1 上都真的跑。
#
# **桩的局限照直写**（所有桩的通病，桩内部解决不了）：
#  ① 它把 sops **今天的命令行契约**冻在这里了。sops 若改了 --config 的位置语义、
#     改了 dotenv 存储里 sops_* 元数据键的形态，**本文件会继续全绿而现实已经变了**。
#     ⇒ 真 sops 那一层的验证仍然只能靠人跑一次（PR #138 第二轮跑过，记在 PR body 里）。
#  ② 它**不验加密的密码学性质**。桩的「加密」是 base64 —— 对 G1 来说这恰好够用
#     （G1 问的是「密文里还看得见明文吗」，不是「这个密文安全吗」），
#     但别读成「加密被验过了」。
#  ③ **不覆盖 -KeyLocation Separate**：那条路径写 %AppData%\sops\age\，要测它得重定向
#     真实的 APPDATA，风险与收益不成比例。Separate 那半的 ACL 行为由 PR #138 第二轮
#     真 age 实查覆盖，本文件不碰。
#
# 附二 · 桩为什么要经 .cmd 转一道，以及 argv 为什么落文件
#
# `powershell -File x.ps1 --config <路径> encrypt ...` 里的 --config 会被 PowerShell 的
# 参数绑定器当成参数名去匹配脚本的 param()，匹配不上就报错。故 sops.cmd 负责转发。
# 转发方式**与 gh 桩不同，刻意的**：gh 桩用 `set "ARGS=%*"` 再按空白拆，那条路对
# **含空格的参数**结构上无解（gh 桩的头注自己写了这个限制）。本桩改成「逐个 %~1 写进
# 一个 argv 文件、一行一个」—— 参数里的空格因此不会把一个参数劈成两个。
# ⚠ **它换来的边界**：echo 按控制台代码页写字节，所以 **argv 只保证 ASCII 无损**。
# 本仓路径与本文件的夹具路径全是 ASCII；真表里那条含中文的 P4 路径**不走这套桩**
# （那条只在真跑时出现，PR #138 已用真 sops 的 -DryRun 覆盖过）。
#
# 附三 · 判别力：9 个变体的实测记分板（2026-08-06 · 未变异基线 PASS=60 FAIL=0 exit=0）
#
#   变体        改法                                suite exit   红的是
#   M0 canary   G1 原样写回（no-op）                     0        无 —— **靶还活着**，不是被写坏了
#   T1          G1 整段删掉                             1        2a/2b/2c/2d（4 条）
#   T2          G1 注释掉                               1        同上 4 条
#   T3          G1 跑但结果不被消费（$false -and）         1        同上 4 条
#   M1          G2 整段删掉                             1        6a/6b/6c/6d（5 条）
#   M2          G2 注释掉  ← 乙路点名那一个                1        同上 5 条
#   M3          G2 跑但结果不被消费                       1        同上 5 条
#   R1          **反向** G1 改成恒真（$true -or）          1        1a/1b/1c…（5 条，**正控那一侧**）
#   R2          **反向** G2 改成恒真                      1        5a/5b/5d/5e（4 条，**正控那一侧**）
#
# 每个变体跑前都验过 BOM=True / ParseErrors=0；收尾两个脚本的 SHA256 与开跑前逐字节相同。
#
# **R1 / R2 是刻意加的，别当凑数**：前七个全在「让门变松」这一侧，那样验不到「正控断言
# 会不会红」—— 一套只在松侧被验过的网，可以是「恒判失败」也照样绿（#官抗-改坏多形态
# 第四件事）。R1/R2 把门改成恒真，红的换成了场景 1 / 场景 5 那一批 ⇒ **正控不是摆设。**
# 九个变体的红集**互不相同**，这本身也是判别力的证据：全部变体给出同一个最大红集时，
# 那多半是靶被弄死了而不是网密（#官抗-变异体存活）。
#
# 附四 · 怎么复现
#
# 锚点（两处都是**单行**，行尾差异结构上咬不到 —— #守-锚点行尾 ①）：
#   G1  (?m)^([ \t]*)if \(\$encText\.Contains\(\$probeVal\)\) \{ Fail [^\r\n]*\}[ \t]*$
#   G2  (?m)^([ \t]*)if \(\$srcKeys\.Count -eq 0\) \{ Fail [^\r\n]*\}[ \t]*$
#
# 改完必须复核脚本仍带 BOM、[Parser]::ParseFile 零错误 —— **变异体丢了 BOM 会被 CP936
# 重读、整个脚本报废，那时全部断言都红，看起来正好像「这套网密不透风」**。
# 复原一律用**字节级备份**还原，**不要 git checkout --**（那会连同工作区里未提交的改动
# 一起冲掉，#官通-复原前确认基线）。
#
# ⚠ **本文件不自带 mutation 跑法，那是刻意的**：一个把自己的 mutation 结果写进 footer 的
# 守护，验的是「我当时跑过」而不是「现在还成立」，而 PR #312 实证过那种 footer 会只记下
# 唯一有效的那一种改法、并据此宣告判别力已坐实。上面那张表是**当时的实测记录**，
# 不是每次跑都会重新求值的东西 —— **别把它读成一道闸。**
# ════════════════════════════════════════════════════════════════════════════

$repoRoot   = Split-Path -Parent $PSScriptRoot
$initPs1    = Join-Path $repoRoot 'ccswitch/scripts/dao-secrets-init.ps1'
$migratePs1 = Join-Path $repoRoot 'ccswitch/scripts/dao-secrets-migrate.ps1'
$psExe      = (Get-Command powershell.exe).Source
$workRoot   = Join-Path $repoRoot '_tmp/dao-secrets-test'
$utf8NoBom  = New-Object System.Text.UTF8Encoding($false)
$utf8Bom    = New-Object System.Text.UTF8Encoding($true)

foreach ($p in @($initPs1, $migratePs1)) {
    if (-not (Test-Path $p)) { Write-Host "被测脚本不存在：$p"; exit 1 }
}

# 真凭据根的存在状态：开跑前记一次，收尾核一次。本文件**不许**动它。
$realSecretsDir    = Join-Path $env:USERPROFILE '.dao-secrets'
$realSecretsBefore = Test-Path $realSecretsDir

if (Test-Path $workRoot) { Remove-Item -Path $workRoot -Recurse -Force }
New-Item -ItemType Directory -Force -Path $workRoot | Out-Null

$results = New-Object System.Collections.Generic.List[object]

function Assert-True {
    param([string]$Name, [bool]$Condition, [string]$Detail = '')
    $status = 'FAIL'
    if ($Condition) { $status = 'PASS' }
    $script:results.Add([PSCustomObject]@{ Name = $Name; Status = $status; Detail = $Detail })
    Write-Host ("  [{0}] {1} {2}" -f $status, $Name, $Detail)
}

# ── 桩：PATH 前置一个假 sops + 假 age-keygen ─────────────────────────────────
$binDir = Join-Path $workRoot 'bin'
New-Item -ItemType Directory -Force -Path $binDir | Out-Null

# .cmd 必须是**纯 ASCII 且无 BOM** —— cmd.exe 见到 BOM 会把第一行读成乱码命令。
# 实现体不能叫 sops.ps1：PowerShell 解析裸名 `sops` 时把 .ps1 排在 PATHEXT 的 .cmd 前面，
# 转发那一层会被整个绕过（gh 桩踩过，见 tests/dao-pr-merge.tests.ps1 头注）。
# ⚠ %~dp0 必须在 shift 循环**之前**存进变量：cmd 的 shift 连 %0 一起移，
# 循环跑完 %~dp0 已经不是脚本自己的目录了。首版就死在这里 —— 症状是
# 「找不到 sops-stub-impl.ps1」，而报出的路径是当前目录，看着像路径拼错了。
$sopsCmd = @'
@echo off
setlocal
set "DAO_STUB_DIR=%~dp0"
if not defined DAO_SOPS_ARGV exit /b 93
if exist "%DAO_SOPS_ARGV%" del "%DAO_SOPS_ARGV%"
:sopsloop
if "%~1"=="" goto sopsdone
>>"%DAO_SOPS_ARGV%" echo(%~1
shift
goto sopsloop
:sopsdone
powershell -NoProfile -ExecutionPolicy Bypass -File "%DAO_STUB_DIR%sops-stub-impl.ps1"
exit /b %ERRORLEVEL%
'@
[IO.File]::WriteAllText((Join-Path $binDir 'sops.cmd'), ($sopsCmd -replace "`r?`n", "`r`n"), (New-Object System.Text.ASCIIEncoding))

$ageCmd = @'
@echo off
setlocal
set "DAO_STUB_DIR=%~dp0"
if not defined DAO_AGE_ARGV exit /b 93
if exist "%DAO_AGE_ARGV%" del "%DAO_AGE_ARGV%"
:ageloop
if "%~1"=="" goto agedone
>>"%DAO_AGE_ARGV%" echo(%~1
shift
goto ageloop
:agedone
powershell -NoProfile -ExecutionPolicy Bypass -File "%DAO_STUB_DIR%age-keygen-stub-impl.ps1"
exit /b %ERRORLEVEL%
'@
[IO.File]::WriteAllText((Join-Path $binDir 'age-keygen.cmd'), ($ageCmd -replace "`r?`n", "`r`n"), (New-Object System.Text.ASCIIEncoding))

# sops 实现体：单引号 here-string，里面的 $ 一律不插值（要在**子进程**里求值）
$sopsImpl = @'
$ErrorActionPreference = 'Stop'
$enc = New-Object System.Text.UTF8Encoding($false)

$argv = @()
if ($env:DAO_SOPS_ARGV -and (Test-Path $env:DAO_SOPS_ARGV)) {
    $argv = @([IO.File]::ReadAllLines($env:DAO_SOPS_ARGV) | Where-Object { $_ -ne '' })
}
if ($env:DAO_SOPS_LOG) { [IO.File]::AppendAllText($env:DAO_SOPS_LOG, (($argv -join ' ') + "`r`n"), $enc) }

if (-not $env:DAO_SOPS_CONFIG -or -not (Test-Path $env:DAO_SOPS_CONFIG)) {
    Write-Output 'sops stub: 没有配置文件'; exit 90
}
$cfg = [IO.File]::ReadAllText($env:DAO_SOPS_CONFIG, [Text.Encoding]::UTF8) | ConvertFrom-Json

if ($argv -contains '--version') { Write-Output ([string]$cfg.versionText); exit 0 }

function Get-OptValue([string[]]$a, [string]$name) {
    $i = [array]::IndexOf($a, $name)
    if ($i -ge 0 -and $a.Count -gt ($i + 1)) { return $a[$i + 1] }
    return $null
}

$sub = ''
if ($argv -contains 'encrypt') { $sub = 'encrypt' }
elseif ($argv -contains 'decrypt') { $sub = 'decrypt' }
else { Write-Output ('sops stub: 未预期的调用 ' + ($argv -join ' ')); exit 97 }

# 桩**不判** --config 对不对，只如实记进调用日志 —— 判据留给测试里的断言。
# 桩替被测脚本判对错，等于把判据搬进桩里，那样断言验的就是桩而不是脚本了。
$outPath = Get-OptValue $argv '--output'
$inPath  = $argv[$argv.Count - 1]
if (-not $outPath) { Write-Output 'sops stub: 缺 --output'; exit 96 }
if (-not (Test-Path $inPath)) { Write-Output ('sops stub: 输入文件不存在 ' + $inPath); exit 95 }

$text = [IO.File]::ReadAllText($inPath, [Text.Encoding]::UTF8)

if ($sub -eq 'encrypt') {
    if ([int]$cfg.encryptExit -ne 0) { Write-Output 'sops stub: encrypt 按配置失败'; exit ([int]$cfg.encryptExit) }
    if ($cfg.mode -eq 'passthrough') {
        # 「加密」= 原样抄过去。密文里看得见明文 —— 这正是 init 第 6 步 G1 要抓的东西。
        [IO.File]::WriteAllText($outPath, $text, $enc); exit 0
    }
    $sb = New-Object System.Text.StringBuilder
    foreach ($raw in ($text -split "`r?`n")) {
        $line = $raw.Trim()
        if (-not $line -or $line.StartsWith('#')) { continue }
        $i = $line.IndexOf('=')
        if ($i -le 0) { continue }
        $k = $line.Substring(0, $i).Trim()
        $v = $line.Substring($i + 1).Trim()
        $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($v))
        [void]$sb.AppendLine($k + '=ENC[AES256_GCM,data:' + $b64 + ',type:str]')
    }
    # 真 sops 的 dotenv 存储会带一组 sops_* 元数据键，解密回来时仍在 ——
    # 复核段那句 -notlike 'sops_*' 过滤就是为它写的，桩照样吐出来，让那一格也被跑到。
    [void]$sb.AppendLine('sops_version=3.13.3-stub')
    [void]$sb.AppendLine('sops_mac=FAKE-MAC-NOT-A-REAL-MAC')
    [void]$sb.AppendLine('sops_unencrypted_suffix=_unencrypted')
    [IO.File]::WriteAllText($outPath, $sb.ToString(), $enc)
    exit 0
}

if ([int]$cfg.decryptExit -ne 0) { Write-Output 'sops stub: decrypt 按配置失败'; exit ([int]$cfg.decryptExit) }
if ($cfg.mode -eq 'passthrough') { [IO.File]::WriteAllText($outPath, $text, $enc); exit 0 }

$sb = New-Object System.Text.StringBuilder
foreach ($raw in ($text -split "`r?`n")) {
    $line = $raw.Trim()
    if (-not $line) { continue }
    $i = $line.IndexOf('=')
    if ($i -le 0) { continue }
    $k = $line.Substring(0, $i).Trim()
    $v = $line.Substring($i + 1).Trim()
    if ($k -like 'sops_*') { [void]$sb.AppendLine($k + '=' + $v); continue }
    if ($cfg.dropKey -and ($k -ceq [string]$cfg.dropKey)) { continue }
    $m = [regex]::Match($v, '^ENC\[AES256_GCM,data:([A-Za-z0-9+/=]+),type:str\]$')
    if (-not $m.Success) { Write-Output ('sops stub: 这不是本桩加密出来的：' + $k); exit 94 }
    $plain = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($m.Groups[1].Value))
    if ($cfg.mutateKey -and ($k -ceq [string]$cfg.mutateKey)) {
        if ($cfg.mutateMode -eq 'case') { $plain = $plain.ToUpperInvariant() }
        else { $plain = $plain + '-TAMPERED' }
    }
    [void]$sb.AppendLine($k + '=' + $plain)
}
[IO.File]::WriteAllText($outPath, $sb.ToString(), $enc)
exit 0
'@
[IO.File]::WriteAllText((Join-Path $binDir 'sops-stub-impl.ps1'), $sopsImpl, $utf8Bom)

$ageImpl = @'
$ErrorActionPreference = 'Stop'
$enc = New-Object System.Text.UTF8Encoding($false)
$argv = @()
if ($env:DAO_AGE_ARGV -and (Test-Path $env:DAO_AGE_ARGV)) {
    $argv = @([IO.File]::ReadAllLines($env:DAO_AGE_ARGV) | Where-Object { $_ -ne '' })
}
$i = [array]::IndexOf($argv, '-o')
if ($i -lt 0 -or $argv.Count -le ($i + 1)) { Write-Output 'age-keygen stub: 缺 -o'; exit 91 }
$out = $argv[$i + 1]
$dir = Split-Path -Parent $out
if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
# 公钥要能被 init 那条正则 '^#\s*public key:\s*(age1[0-9a-z]+)\s*$' 认出来。
# 私钥行是**假的**，不是任何真钥匙 —— 本桩不生成、也不需要真密码学材料。
$body = "# created: 2026-01-01T00:00:00Z`n# public key: age1faketstubkey00000000000000000000000000000000000000000000`nAGE-SECRET-KEY-1FAKESTUBNOTAREALKEY`n"
[IO.File]::WriteAllText($out, $body, $enc)
exit 0
'@
[IO.File]::WriteAllText((Join-Path $binDir 'age-keygen-stub-impl.ps1'), $ageImpl, $utf8Bom)

# 桩自证：PATH 前置之后，裸名必须解析到我们那两个 .cmd 上。
# 这不是形式主义 —— 一旦解析落到别处（有人往 bin 里丢了别的 sops.*、或机器上真装了 sops
# 而前置没生效），全部场景会以「被测脚本行为不对」的形态集体变红，而那个症状指向被测脚本。
$stubResolveOk = $true
$stubResolveDetail = ''
$oldPathProbe = $env:PATH
$env:PATH = $binDir + ';' + $oldPathProbe
try {
    foreach ($pair in @(@('sops', 'sops.cmd'), @('age-keygen', 'age-keygen.cmd'))) {
        $c = Get-Command $pair[0] -ErrorAction SilentlyContinue
        $want = Join-Path $binDir $pair[1]
        if (-not $c -or $c.Source -ne $want) {
            $stubResolveOk = $false
            $got = '<无>'
            if ($c) { $got = $c.Source }
            $stubResolveDetail += ("{0} -> {1}；" -f $pair[0], $got)
        }
    }
} finally { $env:PATH = $oldPathProbe }
if (-not $stubResolveOk) {
    Write-Host "桩自证失败：$stubResolveDetail 期望落在 $binDir 下"
    exit 1
}

# ── 夹具与调用外壳 ───────────────────────────────────────────────────────────
function New-Case {
    param([string]$Name)
    $dir = Join-Path $workRoot $Name
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    return $dir
}

function New-SopsCfg {
    param(
        [string]$Mode = 'real',
        [int]$EncryptExit = 0,
        [int]$DecryptExit = 0,
        [string]$DropKey = '',
        [string]$MutateKey = '',
        [string]$MutateMode = 'value'
    )
    return @{
        mode = $Mode; encryptExit = $EncryptExit; decryptExit = $DecryptExit
        dropKey = $DropKey; mutateKey = $MutateKey; mutateMode = $MutateMode
        versionText = 'sops 3.13.3-stub (dao regression net)'
    }
}

function Invoke-Target {
    param([string]$ScriptPath, [string[]]$ScriptArgs, [string]$CaseDir, [hashtable]$SopsCfg)
    $cfgPath = Join-Path $CaseDir 'sops-stub.json'
    [IO.File]::WriteAllText($cfgPath, (ConvertTo-Json $SopsCfg -Depth 5), $utf8NoBom)
    $logPath = Join-Path $CaseDir 'sops-calls.log'
    if (Test-Path $logPath) { Remove-Item $logPath -Force }

    $oldPath = $env:PATH
    $env:PATH = $binDir + ';' + $oldPath
    $env:DAO_SOPS_CONFIG = $cfgPath
    $env:DAO_SOPS_LOG    = $logPath
    $env:DAO_SOPS_ARGV   = Join-Path $CaseDir 'sops-argv.txt'
    $env:DAO_AGE_ARGV    = Join-Path $CaseDir 'age-argv.txt'
    $out = $null
    $code = $null
    try {
        $psArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $ScriptPath) + $ScriptArgs
        $out = & $psExe @psArgs
        $code = $LASTEXITCODE
    } finally {
        $env:PATH = $oldPath
        foreach ($v in @('DAO_SOPS_CONFIG', 'DAO_SOPS_LOG', 'DAO_SOPS_ARGV', 'DAO_AGE_ARGV')) {
            if (Test-Path ('Env:' + $v)) { Remove-Item ('Env:' + $v) }
        }
    }
    $log = ''
    if (Test-Path $logPath) { $log = [IO.File]::ReadAllText($logPath, [Text.Encoding]::UTF8) }
    return [PSCustomObject]@{ ExitCode = $code; Text = (@($out) -join "`n"); SopsLog = $log }
}

# 「--config 钉在全局位（子命令之前）」是 B1 那个阻断项的行为契约。
# 断言打在**真实发出的命令行**上，不打在源码文本上。
function Test-ConfigBeforeSubcommand {
    param([string]$Log, [string]$Subcommand)
    $lines = @(($Log -split "`r?`n") | Where-Object { $_ -match ('(^|\s)' + $Subcommand + '(\s|$)') })
    if (-not $lines.Count) { return $false }
    foreach ($l in $lines) {
        $toks = @($l -split '\s+')
        $ci = [array]::IndexOf($toks, '--config')
        $si = [array]::IndexOf($toks, $Subcommand)
        if ($ci -lt 0 -or $si -lt 0 -or $ci -gt $si) { return $false }
    }
    return $true
}

function New-SecretsRoot {
    # migrate 的前置只要「目录在 + .sops.yaml 在」。这里直接造，不跑 init ——
    # 让 migrate 的场景与 init 的场景互不牵连（init 坏了不该把 migrate 的断言一起染红）。
    param([string]$CaseDir)
    $d = Join-Path $CaseDir 'secrets'
    New-Item -ItemType Directory -Force -Path $d | Out-Null
    [IO.File]::WriteAllText((Join-Path $d '.sops.yaml'), "creation_rules:`n  - age: age1faketstubkey00000000000000000000000000000000000000000000`n", $utf8NoBom)
    return $d
}

function New-ItemsJson {
    param([string]$CaseDir, [string]$Slug, [string]$SourcePath)
    $p = Join-Path $CaseDir 'items.json'
    $obj = @(@{ Id = 'P1'; Slug = $Slug; Source = $SourcePath; Dest = ($Slug + '.env'); After = '（自测夹具的 After 文案，不含任何值）' })
    [IO.File]::WriteAllText($p, (ConvertTo-Json $obj -Depth 5), $utf8NoBom)
    return $p
}

# 夹具里的「凭据」全是假串。收尾有一条断言核脚本输出里一个都没出现过。
$FAKE_A = 'sk-FAKE-alpha-001'
$FAKE_B = 'sk-FAKE-bravo-002'

function New-DotEnvFixture {
    param([string]$CaseDir, [string]$Name = 'src.env')
    $p = Join-Path $CaseDir $Name
    [IO.File]::WriteAllText($p, ("# 夹具`nA_KEY=" + $FAKE_A + "`nB_KEY=" + $FAKE_B + "`n"), $utf8NoBom)
    return $p
}

Write-Host ''
Write-Host '== dao-secrets 回归测试（init G1 / migrate G2 两道承重守卫 + 复核段全分支）=='
Write-Host ''

# ============================================================================
# 场景 1：init 正控 —— 桩正常「加密」⇒ 全链 exit 0
# ============================================================================
# 没有这一条，下面所有「该失败时失败」的断言都可能只是「恒失败」也照样绿。
Write-Host '场景 1：init 正控（桩真做变换 ⇒ exit 0、自证通过、探针清干净）'

$c1 = New-Case 'init-ok'
$s1 = Join-Path $c1 'secrets'
$r1 = Invoke-Target -ScriptPath $initPs1 -CaseDir $c1 -SopsCfg (New-SopsCfg) `
        -ScriptArgs @('-SecretsDir', $s1)

Assert-True '1a init 全链 exit 0' ($r1.ExitCode -eq 0) ("exit={0}" -f $r1.ExitCode)
Assert-True '1b 第 6 步自证走完了（屏幕上说「加密链路整条通了」）' `
    ($r1.Text -match '加密链路整条通了') ''
Assert-True '1c G1 那一格给出的是肯定结论，不是沉默' `
    ($r1.Text -match '密文里搜不到明文探针值') ''
Assert-True '1d 私钥与 .sops.yaml 都落盘了' `
    ((Test-Path (Join-Path $s1 'age\keys.txt')) -and (Test-Path (Join-Path $s1 '.sops.yaml'))) ''
Assert-True '1e `_selftest` 目录被 finally 清干净（探针明文不许留在盘上）' `
    (-not (Test-Path (Join-Path $s1 '_selftest'))) ''
Assert-True '1f B1 契约：encrypt 调用把 --config 钉在**子命令之前**（全局位）' `
    (Test-ConfigBeforeSubcommand -Log $r1.SopsLog -Subcommand 'encrypt') `
    ("日志：{0}" -f ($r1.SopsLog -replace "`r?`n", ' | '))
Assert-True '1g B1 契约：decrypt 调用同样钉了 --config（不必要但刻意钉，见脚本 .NOTES）' `
    (Test-ConfigBeforeSubcommand -Log $r1.SopsLog -Subcommand 'decrypt') ''
Assert-True '1h 没碰用户级环境变量（本文件绝不传 -SetUserEnvVar）' `
    ($r1.Text -match '没自动设') ''

# ============================================================================
# 场景 2：**G1 靶** —— 「加密」其实只是复制 ⇒ 必须当场停
# ============================================================================
# 判别力从哪来：passthrough 下 decrypt 也回得来、值也对得上 ⇒ 除了 G1，
# 没有任何一条断言会不高兴。G1 一没（删 / 注释 / $false -and），init 就 exit 0。
Write-Host '场景 2：**G1 靶** —— 桩的 encrypt 原样复制 ⇒ 密文里看得见明文 ⇒ 必须 exit 1'

$c2 = New-Case 'init-passthrough'
$s2 = Join-Path $c2 'secrets'
$r2 = Invoke-Target -ScriptPath $initPs1 -CaseDir $c2 -SopsCfg (New-SopsCfg -Mode 'passthrough') `
        -ScriptArgs @('-SecretsDir', $s2)

Assert-True '2a exit 1（「加密没真的发生」不许长得像一切正常）' `
    ($r2.ExitCode -eq 1) ("exit={0}" -f $r2.ExitCode)
Assert-True '2b 屏幕上点名了这件事' ($r2.Text -match '密文里能看到明文探针值') ''
Assert-True '2c **没有**打出「加密链路整条通了」（这是 G1 缺席时最先冒出来的假绿）' `
    (-not ($r2.Text -match '加密链路整条通了')) ''
Assert-True '2d 停在 G1，没往下走到解密那一步' `
    (-not ($r2.Text -match '解密：值原样回来了')) ''
Assert-True '2e 失败路径上 `_selftest` 照样被清干净（探针明文不许因失败留在盘上）' `
    (-not (Test-Path (Join-Path $s2 '_selftest'))) ''

# ============================================================================
# 场景 3：init —— sops encrypt 自己失败 ⇒ fail-closed
# ============================================================================
Write-Host '场景 3：init 负控 —— encrypt 退 1 ⇒ exit 1、不宣告自证通过'

$c3 = New-Case 'init-encrypt-fail'
$s3 = Join-Path $c3 'secrets'
$r3 = Invoke-Target -ScriptPath $initPs1 -CaseDir $c3 -SopsCfg (New-SopsCfg -EncryptExit 1) `
        -ScriptArgs @('-SecretsDir', $s3)

Assert-True '3a exit 1' ($r3.ExitCode -eq 1) ("exit={0}" -f $r3.ExitCode)
Assert-True '3b 报的是 encrypt 的退出码，不是别的' ($r3.Text -match 'sops encrypt 退出码 1') ''
Assert-True '3c 没宣告链路通' (-not ($r3.Text -match '加密链路整条通了')) ''

# ============================================================================
# 场景 4：init —— 私钥已存在时**绝不覆盖**
# ============================================================================
# 这是 init 里代价最高的一格：覆盖私钥 = 此前所有加密文件永久打不开，没有任何补救。
Write-Host '场景 4：init —— 私钥已存在 ⇒ 不覆盖（覆盖 = 全部密文永久打不开）'

$c4 = New-Case 'init-key-exists'
$s4 = Join-Path $c4 'secrets'
$keyDir4 = Join-Path $s4 'age'
New-Item -ItemType Directory -Force -Path $keyDir4 | Out-Null
$keyFile4 = Join-Path $keyDir4 'keys.txt'
$preExisting = "# created: 2020-01-01T00:00:00Z`n# public key: age1preexistingfakekey0000000000000000000000000000000000000`nAGE-SECRET-KEY-1PREEXISTINGFAKE`n"
[IO.File]::WriteAllText($keyFile4, $preExisting, $utf8NoBom)
$hashBefore = (Get-FileHash -LiteralPath $keyFile4 -Algorithm SHA256).Hash

$r4 = Invoke-Target -ScriptPath $initPs1 -CaseDir $c4 -SopsCfg (New-SopsCfg) `
        -ScriptArgs @('-SecretsDir', $s4)
$hashAfter = (Get-FileHash -LiteralPath $keyFile4 -Algorithm SHA256).Hash

Assert-True '4a exit 0（已有私钥不是错误）' ($r4.ExitCode -eq 0) ("exit={0}" -f $r4.ExitCode)
Assert-True '4b 私钥文件**逐字节没变**（断言打在哈希上，不打在屏幕文案上）' `
    ($hashAfter -eq $hashBefore) ("before={0} after={1}" -f $hashBefore.Substring(0, 8), $hashAfter.Substring(0, 8))
Assert-True '4c 屏幕上明说了「不覆盖」' ($r4.Text -match '不覆盖') ''
$yaml4 = ''
if (Test-Path (Join-Path $s4 '.sops.yaml')) { $yaml4 = [IO.File]::ReadAllText((Join-Path $s4 '.sops.yaml'), [Text.Encoding]::UTF8) }
Assert-True '4d 用的是既有私钥里的公钥（.sops.yaml 指向 age1preexisting…）' `
    ($yaml4 -match 'age1preexistingfakekey') ''

# ============================================================================
# 场景 5：migrate 正控 —— 加密 → 复核 → 备份 → 删原件，四步都真的发生
# ============================================================================
Write-Host '场景 5：migrate 正控（全链 exit 0，原件删掉、备份在、密文里没有明文）'

$c5 = New-Case 'migrate-ok'
$s5 = New-SecretsRoot -CaseDir $c5
$src5 = New-DotEnvFixture -CaseDir $c5
$items5 = New-ItemsJson -CaseDir $c5 -Slug 'fixture-ok' -SourcePath $src5
$r5 = Invoke-Target -ScriptPath $migratePs1 -CaseDir $c5 -SopsCfg (New-SopsCfg) `
        -ScriptArgs @('-SecretsDir', $s5, '-ItemsJson', $items5)

$dest5 = Join-Path $s5 'fixture-ok.env'
$bak5 = @(Get-ChildItem -Path (Join-Path $s5 '_backup') -Recurse -File -ErrorAction SilentlyContinue)

Assert-True '5a exit 0' ($r5.ExitCode -eq 0) ("exit={0}" -f $r5.ExitCode)
# ⚠ 判据刻意是「复核通过：<n> 个键全部原样回来」整句，不是「复核通过」四个字 ——
# 脚本在**进循环之前**就打过一行「备份目录（复核通过后才往里写）」，光搜四个字，
# 这条与场景 6d 都会因为那句**无关的**横幅而绿。首版就是这么绿的，靠 6d 红出来才发现。
Assert-True '5b 复核段真的跑过并通过' ($r5.Text -match '复核通过：\d+ 个键全部原样回来') ''
Assert-True '5c 加密文件落盘，且里面**搜不到明文**' `
    ((Test-Path $dest5) -and (-not ([IO.File]::ReadAllText($dest5, [Text.Encoding]::UTF8).Contains($FAKE_A)))) ''
Assert-True '5d 项目里的原件已删' (-not (Test-Path $src5)) ''
Assert-True '5e 备份恰好 1 个文件，且**内容与原件一致**（它是删除动作的回滚材料）' `
    ((@($bak5).Count -eq 1) -and ([IO.File]::ReadAllText($bak5[0].FullName, [Text.Encoding]::UTF8).Contains($FAKE_A))) `
    ("备份文件数={0}" -f @($bak5).Count)
Assert-True '5f 复核用的临时文件没残留（`*.verify.env`）' `
    (-not (@(Get-ChildItem -Path $s5 -Recurse -File -Filter '*.verify.env' -ErrorAction SilentlyContinue).Count)) ''
Assert-True '5g B1 契约：encrypt / decrypt 两条调用都把 --config 钉在子命令之前' `
    ((Test-ConfigBeforeSubcommand -Log $r5.SopsLog -Subcommand 'encrypt') -and `
     (Test-ConfigBeforeSubcommand -Log $r5.SopsLog -Subcommand 'decrypt')) ''

# ============================================================================
# 场景 6：**G2 靶** —— 源文件一个键都解析不出来 ⇒ 必须停、必须不删原件
# ============================================================================
# 夹具是一份 **JSON 形态**的凭据文件（真实场景：有人把 migrate 指向一个不是 dotenv 的
# 凭据文件）。Read-DotEnvMap 解析出 0 个键 ⇒ $missing 与 $mismatch **双双为空** ⇒
# 前两道判断全部沉默 ⇒ 只有 G2 拦得住。G2 一没，原件就被删了。
Write-Host '场景 6：**G2 靶** —— 0 个键解析得出 ⇒ 空集比空集必须判异常，且**不删原件**'

$c6 = New-Case 'migrate-zero-keys'
$s6 = New-SecretsRoot -CaseDir $c6
$src6 = Join-Path $c6 'creds.json'
[IO.File]::WriteAllText($src6, ('{' + "`n" + '  "apiKey": "sk-FAKE-jsonshape-001",' + "`n" + '  "token": "sk-FAKE-jsonshape-002"' + "`n" + '}' + "`n"), $utf8NoBom)
$items6 = New-ItemsJson -CaseDir $c6 -Slug 'fixture-zero' -SourcePath $src6
$r6 = Invoke-Target -ScriptPath $migratePs1 -CaseDir $c6 -SopsCfg (New-SopsCfg) `
        -ScriptArgs @('-SecretsDir', $s6, '-ItemsJson', $items6)

$bak6 = @(Get-ChildItem -Path (Join-Path $s6 '_backup') -Recurse -File -ErrorAction SilentlyContinue)

Assert-True '6a exit 1（0 个键不许被当成「全部一致」）' ($r6.ExitCode -eq 1) ("exit={0}" -f $r6.ExitCode)
Assert-True '6b **原件还在** —— 这是本场景真正要守的东西' (Test-Path $src6) ''
Assert-True '6c 屏幕上点名了这件事' ($r6.Text -match '源文件一个键都没解析出来') ''
Assert-True '6d 没打出「复核通过：<n> 个键全部原样回来」（判据见 5b 那段注释）' `
    (-not ($r6.Text -match '复核通过：\d+ 个键全部原样回来')) ''
Assert-True '6e 备份一个字节都没写（次序是「加密→复核→备份→删」，复核没过就轮不到备份）' `
    (@($bak6).Count -eq 0) ("备份文件数={0}" -f @($bak6).Count)

# ============================================================================
# 场景 7：复核段 —— 解密回来少一个键 ⇒ 停、不删原件
# ============================================================================
Write-Host '场景 7：复核段 —— 解密少一个键 ⇒ exit 1、不删原件'

$c7 = New-Case 'migrate-missing-key'
$s7 = New-SecretsRoot -CaseDir $c7
$src7 = New-DotEnvFixture -CaseDir $c7
$items7 = New-ItemsJson -CaseDir $c7 -Slug 'fixture-missing' -SourcePath $src7
$r7 = Invoke-Target -ScriptPath $migratePs1 -CaseDir $c7 -SopsCfg (New-SopsCfg -DropKey 'B_KEY') `
        -ScriptArgs @('-SecretsDir', $s7, '-ItemsJson', $items7)

Assert-True '7a exit 1' ($r7.ExitCode -eq 1) ("exit={0}" -f $r7.ExitCode)
Assert-True '7b 原件还在' (Test-Path $src7) ''
Assert-True '7c 报的是「少了这些键」并列出键名（只列键名，不列值）' `
    (($r7.Text -match '解密回来少了这些键') -and ($r7.Text -match 'B_KEY')) ''

# ============================================================================
# 场景 8：复核段 —— 值被改了 ⇒ 停、不删原件
# ============================================================================
Write-Host '场景 8：复核段 —— 有一个值对不上 ⇒ exit 1、不删原件'

$c8 = New-Case 'migrate-value-mismatch'
$s8 = New-SecretsRoot -CaseDir $c8
$src8 = New-DotEnvFixture -CaseDir $c8
$items8 = New-ItemsJson -CaseDir $c8 -Slug 'fixture-mismatch' -SourcePath $src8
$r8 = Invoke-Target -ScriptPath $migratePs1 -CaseDir $c8 -SopsCfg (New-SopsCfg -MutateKey 'A_KEY' -MutateMode 'value') `
        -ScriptArgs @('-SecretsDir', $s8, '-ItemsJson', $items8)

Assert-True '8a exit 1' ($r8.ExitCode -eq 1) ("exit={0}" -f $r8.ExitCode)
Assert-True '8b 原件还在' (Test-Path $src8) ''
Assert-True '8c 报的是「值对不上」' ($r8.Text -match '这些键的值对不上') ''

# ============================================================================
# 场景 9：复核段 —— **只差大小写**也算对不上（W4 那处 -ne → -cne 的判别力）
# ============================================================================
# 甲路点名的 W4：PowerShell 的 -ne / -notcontains 默认忽略大小写，'AbC' -ne 'abc' 得 False
# ⇒ 只差大小写的值会被判成「一致」，而凭据里 base64 token 大小写敏感是常态。
# 这一条与场景 8 是一对：把 -cne 退回 -ne，场景 8 照样绿，只有这一条会红。
Write-Host '场景 9：复核段 —— 值只差大小写 ⇒ 仍判对不上（-cne 的判别力，退回 -ne 时只有这条会红）'

$c9 = New-Case 'migrate-case-only'
$s9 = New-SecretsRoot -CaseDir $c9
$src9 = New-DotEnvFixture -CaseDir $c9
$items9 = New-ItemsJson -CaseDir $c9 -Slug 'fixture-case' -SourcePath $src9
$r9 = Invoke-Target -ScriptPath $migratePs1 -CaseDir $c9 -SopsCfg (New-SopsCfg -MutateKey 'A_KEY' -MutateMode 'case') `
        -ScriptArgs @('-SecretsDir', $s9, '-ItemsJson', $items9)

Assert-True '9a exit 1（大小写敏感比对）' ($r9.ExitCode -eq 1) ("exit={0}" -f $r9.ExitCode)
Assert-True '9b 原件还在' (Test-Path $src9) ''
Assert-True '9c 报的是「值对不上」而不是「少了键」（键名没变，只有值变了）' `
    (($r9.Text -match '这些键的值对不上') -and (-not ($r9.Text -match '解密回来少了这些键'))) ''

# ============================================================================
# 场景 10：负控 —— 加密失败时，磁盘上**一个字节的明文都不许多**
# ============================================================================
# 这是 B1 的连带项：原次序「先明文备份 → 再加密」下，任何一次失败的迁移都会在
# _backup 里多留一份明文口令，而用户只看到一行红字。现次序「加密 → 复核 → 备份 → 删」
# 保证搬不成功就不多写。断言打在**备份目录里的文件数**上。
Write-Host '场景 10：负控 —— 加密失败 ⇒ exit 1、原件在、备份目录里 0 个文件'

$c10 = New-Case 'migrate-encrypt-fail'
$s10 = New-SecretsRoot -CaseDir $c10
$src10 = New-DotEnvFixture -CaseDir $c10
$items10 = New-ItemsJson -CaseDir $c10 -Slug 'fixture-encfail' -SourcePath $src10
$r10 = Invoke-Target -ScriptPath $migratePs1 -CaseDir $c10 -SopsCfg (New-SopsCfg -EncryptExit 1) `
        -ScriptArgs @('-SecretsDir', $s10, '-ItemsJson', $items10)

$bak10 = @(Get-ChildItem -Path (Join-Path $s10 '_backup') -Recurse -File -ErrorAction SilentlyContinue)

Assert-True '10a exit 1' ($r10.ExitCode -eq 1) ("exit={0}" -f $r10.ExitCode)
Assert-True '10b 原件还在' (Test-Path $src10) ''
Assert-True '10c **备份目录里 0 个文件** —— 失败的迁移不许在磁盘上多留一份明文' `
    (@($bak10).Count -eq 0) ("备份文件数={0}" -f @($bak10).Count)
Assert-True '10d 加密目标没落盘' (-not (Test-Path (Join-Path $s10 'fixture-encfail.env'))) ''

# ============================================================================
# 场景 11：解密失败 ⇒ 停、不删原件
# ============================================================================
# 与场景 10 成对：加密那半绿了、解密那半红，同样一个字节都不许删。
Write-Host '场景 11：解密失败 ⇒ exit 1、原件在、备份 0 个文件'

$c11 = New-Case 'migrate-decrypt-fail'
$s11 = New-SecretsRoot -CaseDir $c11
$src11 = New-DotEnvFixture -CaseDir $c11
$items11 = New-ItemsJson -CaseDir $c11 -Slug 'fixture-decfail' -SourcePath $src11
$r11 = Invoke-Target -ScriptPath $migratePs1 -CaseDir $c11 -SopsCfg (New-SopsCfg -DecryptExit 1) `
        -ScriptArgs @('-SecretsDir', $s11, '-ItemsJson', $items11)

$bak11 = @(Get-ChildItem -Path (Join-Path $s11 '_backup') -Recurse -File -ErrorAction SilentlyContinue)

Assert-True '11a exit 1' ($r11.ExitCode -eq 1) ("exit={0}" -f $r11.ExitCode)
Assert-True '11b 原件还在' (Test-Path $src11) ''
Assert-True '11c 屏幕上说清了「加密文件打不开，原件不删」' ($r11.Text -match 'sops decrypt 退出码 1') ''
Assert-True '11d 备份 0 个文件' (@($bak11).Count -eq 0) ("备份文件数={0}" -f @($bak11).Count)

# ============================================================================
# 场景 12：-DryRun 一个写操作都不做
# ============================================================================
# 「先跑 -DryRun」是这两个脚本印在文档里、要用户照做的第一步，那句话得有人守着。
Write-Host '场景 12：migrate -DryRun 零写操作'

$c12 = New-Case 'migrate-dryrun'
$s12 = New-SecretsRoot -CaseDir $c12
$src12 = New-DotEnvFixture -CaseDir $c12
$items12 = New-ItemsJson -CaseDir $c12 -Slug 'fixture-dry' -SourcePath $src12
$r12 = Invoke-Target -ScriptPath $migratePs1 -CaseDir $c12 -SopsCfg (New-SopsCfg) `
        -ScriptArgs @('-SecretsDir', $s12, '-ItemsJson', $items12, '-DryRun')

Assert-True '12a exit 0' ($r12.ExitCode -eq 0) ("exit={0}" -f $r12.ExitCode)
Assert-True '12b 原件原封不动' (Test-Path $src12) ''
Assert-True '12c 加密目标没建、备份目录没建（真·零写操作）' `
    ((-not (Test-Path (Join-Path $s12 'fixture-dry.env'))) -and (-not (Test-Path (Join-Path $s12 '_backup')))) ''
Assert-True '12d **一次 sops 都没调**（DryRun 若真调了 sops，「不执行」就是假的）' `
    (-not ($r12.SopsLog -match 'encrypt')) ("日志：{0}" -f ($r12.SopsLog -replace "`r?`n", ' | '))
Assert-True '12e 键名照常列出（DryRun 的用处就是让人先看一眼）' ($r12.Text -match 'A_KEY') ''

# ============================================================================
# 场景 13：全程**一个凭据值都没印到屏幕上**
# ============================================================================
# 两个脚本的 .NOTES 都写着「从不打印任何凭据的值、片段、长度或哈希」。
# 这条断言把那句话变成可执行的：把上面所有场景的输出连起来搜假串。
Write-Host '场景 13：所有场景的输出里，一个凭据值都没出现过'

$allText = @($r1.Text, $r2.Text, $r3.Text, $r4.Text, $r5.Text, $r6.Text, $r7.Text,
             $r8.Text, $r9.Text, $r10.Text, $r11.Text, $r12.Text) -join "`n"
Assert-True '13a 屏幕输出里搜不到任何一个假凭据值（键名可以有、值一个都不许有）' `
    ((-not $allText.Contains($FAKE_A)) -and (-not $allText.Contains($FAKE_B)) -and `
     (-not $allText.Contains('sk-FAKE-jsonshape-001'))) ''

# ============================================================================
# 场景 14：两个被测脚本自身可解析、且带 BOM
# ============================================================================
# BOM 不是形式：PS 5.1 读无 BOM 的中文脚本会按 CP936 重读，整个脚本报废 ——
# 而那时**本文件的全部断言都会红**，看起来正好像「这套网密不透风」。先把它钉住。
Write-Host '场景 14：被测脚本零语法错误 + 带 BOM'

foreach ($pair in @(@('dao-secrets-init.ps1', $initPs1), @('dao-secrets-migrate.ps1', $migratePs1))) {
    $tokens = $null
    $errors = $null
    $null = [System.Management.Automation.Language.Parser]::ParseFile($pair[1], [ref]$tokens, [ref]$errors)
    Assert-True ("14 {0} 零语法错误" -f $pair[0]) (@($errors).Count -eq 0) ("ParseErrors={0}" -f @($errors).Count)
    $head = [byte[]]::new(3)
    $fs = [IO.File]::OpenRead($pair[1])
    try { $null = $fs.Read($head, 0, 3) } finally { $fs.Dispose() }
    Assert-True ("14 {0} 带 UTF-8 BOM" -f $pair[0]) `
        (($head[0] -eq 0xEF) -and ($head[1] -eq 0xBB) -and ($head[2] -eq 0xBF)) `
        ("首三字节={0:X2} {1:X2} {2:X2}" -f $head[0], $head[1], $head[2])
}

# ============================================================================
# 场景 15：本次跑动没有碰真凭据根
# ============================================================================
Write-Host '场景 15：真凭据根的存在状态没被本次跑动改变'

Assert-True '15a %USERPROFILE%\.dao-secrets 的存在状态与开跑前一致（本文件不许碰它）' `
    ((Test-Path $realSecretsDir) -eq $realSecretsBefore) `
    ("before={0} after={1}" -f $realSecretsBefore, (Test-Path $realSecretsDir))

# ---- 汇总 -------------------------------------------------------------------
Write-Host ''
Write-Host '=============================================='
Write-Host '          dao-secrets 汇总'
Write-Host '=============================================='
$failing = @($results | Where-Object { $_.Status -ne 'PASS' })
foreach ($r in $results) { Write-Host ("  {0,-6} {1}" -f $r.Status, $r.Name) }
Write-Host '=============================================='
Write-Host ("=== 汇总: PASS={0} FAIL={1} ===" -f ($results.Count - $failing.Count), $failing.Count)
if ($failing.Count -gt 0) {
    Write-Host ("dao-secrets 失败：{0}/{1} 项未通过" -f $failing.Count, $results.Count)
    exit 1
}
Write-Host ("dao-secrets 全部通过（{0} 项）。" -f $results.Count)
exit 0
