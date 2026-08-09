# @dao-test-tier: env   # 整套只在 --env 跑：对真 %USERPROFILE%/%APPDATA% 做机器级不变量断言，逐字命中 --env 的定义
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

    ## 第三块靶：`-KeyLocation`（2026-08-06 补 · 用户拍板「先补网再切默认值」）

    上面两道是**守卫**，这一块是**分支**：私钥落在哪、谁的权限被收紧、不传参数时走哪条。
    它此前完全在网外（本文件首版自陈的原话见附一 ③，那句话里的理由已被证伪）。
    三个场景对应三格 —— 13 = Separate、14 = Portable（反向）、15 = **默认值**。
    **15 是唯一会因为「有人换了默认值」而变红的东西**，13/14 都显式传参、改默认值它们照绿。

    ## 第四块靶：**分档退出码 0 / 2 / 1**（2026-08-07 补 · 用户拍板 · issue #148）

    场景 19 = `2`（ACL 收不紧但主体成功）、20 = `-DryRun` **过了工具检查之后**恒 `0`、
    21 = **负控**（ACL 也没收紧但主体真失败 ⇒ 必须 `1`）。**21 是三档里唯一有安全后果的那条**：
    `2` 的定义是「主体成功」，分档若抢在主体之前，一次链路没验通的跑动会被报成「只是权限没收紧」。
    **2026-08-07 补 22 = 一成一败、23 = Portable 下的 2（issue #173 F5）** —— 那两格的理由、
    判别力与「全败那一格为什么覆盖不了它们」，都在下面 dot-source 之后那段行注释里。

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
#  ③ **-KeyLocation Separate 现在覆盖了**（2026-08-06 · issue #72 拍板「先补网再切默认值」）。
#     此前这里写的是「不覆盖，测它得重定向真实的 APPDATA，风险与收益不成比例」——
#     **那个理由里的前提是错的**：不需要重定向真实的 APPDATA。`$env:APPDATA` 是**进程级**
#     环境块里的一格，改它只影响本进程与它派生的子进程，**不写注册表、不碰用户级变量**
#     （本机实测：父进程改 → `powershell -NoProfile -Command '$env:AppData'` 子进程读到覆写值 →
#     父进程 finally 复原 → 真值原样）。而被测脚本读的正是 `$env:AppData`（init 第 113-120 行），
#     测试又本来就用 `& $psExe` 起子进程，所以覆写天然就传得过去。
#     ⇒ 场景 13/14/15 覆盖 Separate / Portable / 默认值三条，断言打在**私钥落在哪个盘上位置**
#     与**ACL 继承状态**（`AreAccessRulesProtected`）上，不打在屏幕文案上。
#     **它仍然不覆盖的**：真实 `%APPDATA%` 下的行为（刻意 —— 那等于往用户真机写私钥）、
#     `SOPS_AGE_KEY_FILE` 用户级环境变量那条分支（同理，写它就是写注册表）。
#     场景 18 有一条负控专门核「真 `%APPDATA%\sops\age\keys.txt` 的存在状态没被本次跑动改变」。
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
# 附三 · 判别力：四轮 mutation 记分板（历史实测记录，非常驻闸，不是每次跑都重新求值的东西）
#
# 2026-08-06～2026-08-07 期间对 G1/G2（9 变体）、Separate/默认值（9 变体）、分档退出码
# （8 变体）、19d 窗口上界 + 22/23 两个新场景（7 变体）四批各自的变体表（改法/exit/红的是）
# 与当时的判别力结论，已整段搬去 docs/evolution/comment-archive-20260809.md
# §dao-secrets.tests.ps1（本文件不自带 mutation 跑法，见下面附四末尾那段）。
# 迁走的内容含：K4 变体那次假私钥落进真 %APPDATA% 的实证、19d「订正的订正」（PR #170 对抗
# 验证证伪首次修复）全过程、22/23 两个新场景各自补的覆盖缺口说明——判据零删除，全文在归档里。
#
# 🔴 **本批自己踩了一次头 80 行那个闸，照记**（`tests/ps-console-encoding.tests.js`）：
# 往头注第四块靶写了 12 行说明 ⇒ 解码钉子被挤到第 86 行 ⇒ 那条不变量当场红，
# 报文是「缺的：dao-secrets.tests.ps1」。⇒ 处置：头注只留 5 行指针，说明全搬到这里
# （dot-source 之后没有行数配额）——下面附四的可复现操作指南同理留在此处。
#
# 附四 · 怎么复现
#
# 锚点（全是**单行**）：
#   G1  (?m)^([ \t]*)if \(\$encText\.Contains\(\$probeVal\)\) \{ Fail [^\r\n]*\}[ \t]*\r?$
#   G2  (?m)^([ \t]*)if \(\$srcKeys\.Count -eq 0\) \{ Fail [^\r\n]*\}[ \t]*\r?$
#   K   (?m)^([ \t]*)\$keyDir = Join-Path \$env:AppData 'sops\\age'[ \t]*\r?$
#   K反 (?m)^([ \t]*)\$keyDir = Join-Path \$SecretsDir 'age'[ \t]*\r?$
#   A   (?m)^([ \t]*)if \(\$KeyLocation -eq 'Separate'\) \{ \$aclTargets \+= \$keyDir \}[ \t]*\r?$
#   D   (?m)^([ \t]*)\[string\]\$KeyLocation = '(Portable|Separate)',[ \t]*\r?$
#   E   (?m)^([ \t]*)exit 2[ \t]*\r?$            ← 分档那一句（E2 移除用带 \r?\n 的那版整行删）
#   E反 (?m)^exit 0[ \t]*\r?$                    ← **顶格**那句才是文件末尾那个全成出口
#   DR  (?m)^([ \t]+)exit 0[ \t]*\r?$            ← **带缩进**的那句才是 -DryRun 块里的出口
#   P1  (?m)^([ \t]*)(\$aclFailed \+= \$t)[ \t]*\r?$        （替换成 `${1}${2}; exit 2`）
#   P2  (?m)^(function Fail\(\$m\) \{ [^\r\n]*); exit 1 \}[ \t]*\r?$   （替换成 `${1}; exit 2 }`）
#
# issue #173 那批（附三之四）用的是**整行字面锚点**，不是上面这些正则 —— 三条，含缩进：
#   点名行  `    foreach ($t in $aclFailed) { Write-Host "        $t" -ForegroundColor Red }`
#           （S19D/S19X 换占位符 · N1 换成遍历 $aclTargets · M0 原样写回）
#   上界行  `    Write-Host '     ⇒ 这台机器上的其他账户可能读得到它。' -ForegroundColor Red`
#           （S19X 在它**之后**插一行红字点名 · W1 把它整行文案换掉）
#   模式行  `    if ($KeyLocation -eq 'Portable') {`   ← **带缩进的那句才是第 7 节的**
#           PB1 用它。⚠ 这个条件在本脚本里出现 **3 次**（落点判定 / 第 7 节后果说明 /
#           换机提示），另两处**顶格**无缩进 ⇒ 靠那 4 个空格才唯一，与上面 K/K反、
#           E反/DR 那两格是同一个教训的第四、第五例。
#
# 🔴 **E反 / DR 是同一行正则的两半，别只写一个**：`exit 0` 在本脚本里出现 2 次 ——
# 一次在 -DryRun 块内（缩进 4 空格）、一次在文件最末尾（顶格）。带 `([ \t]*)` 的锚点会
# 一次改两处，而改掉 DryRun 那句会让「先跑 -DryRun」这条路也退 2，红集从此说明不了任何事。
# 顶格用 `^exit 0`、DryRun 用 `^[ \t]+exit 0`，两条实测命中数各为 1。
# （同一格教训的第三例：上面 K/K反 那两条也是为了唯一性才改的赋值行。）
#
# 🔴 **P1/P2 的替换串只用 `${n}` 组引用，一个裸 `$名字` 都没有**：.NET 的替换语义是
# 「认不出来的 `$xxx` 就当字面量留着」—— 那是**沉默**的，`$aclFailed` 究竟被当成组名
# 还是字面量，跑之前看不出来。跑手因此对每个变体多带一个 `Expect` 字面量，
# **替换后先核它真的落进去了**，再往盘上写（#官通-缓冲区校验 的同一路数）。
#
# 🔴 **那个 `\r?` 不是装饰，G1/G2 原先没有它、于是在本工作树上一次都匹配不上**
# （2026-08-06 实测：本仓是 CRLF，而 .NET 的多行 `$` 停在 `\n` **之前**，`\r` 没人吃 ⇒
# `[ \t]*$` 恒 0 命中）。本批首轮 7 个变体因此**全部报「锚点命中 0 次」** ——
# 幸好锚点自检写的是「命中数必须恰好为 1」而不是「替换一下试试」，
# 否则得到的会是 7 个 no-op 全绿，与「这套网密不透风」逐字节不可区分。
# ⇒ **写锚点时行尾要连 `\r` 一起考虑，别只考虑缩进**（#守-锚点行尾 的下一格）。
#
# 🔴 **只钉「锚点还在」不够，还要钉「它命中几次」**：`Portable` 那个条件行在本脚本里
# 出现 **2 次**（落点判定一次、第 7 节换机提示一次），拿它当锚点会一次改两处。
# 上表的 K / K反 因此改的是**赋值行**而不是条件行 —— 赋值行才唯一。
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

# 真 %APPDATA% 那一侧同理（场景 13/15 会把 APPDATA 覆写到 _tmp/ 下的假目录）。
# 记两样：变量本身的值、以及 sops 私钥默认落点的存在状态。收尾各核一次。
$realAppDataBefore = [Environment]::GetEnvironmentVariable('APPDATA', 'Process')
$realAgeKeyPath    = Join-Path $realAppDataBefore 'sops\age\keys.txt'
$realAgeKeyBefore  = Test-Path $realAgeKeyPath

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

# ── 第二个桩目录：一个**失败版 icacls**，只在显式点名的场景里才上 PATH ────────
# 🔴 为什么单独一个目录，而不是丢进上面那个 binDir：binDir 对**每一个**场景都上 PATH。
# 把它放进去，13e/13f/14d/15e 那四条 ACL 断言读到的就不再是真 NTFS 说的话了 ——
# 它们会因为「谁也没收紧」而集体转成负控，而那正是它们要守的东西。
# 本目录只有 Invoke-Target -ExtraPathDir 显式传进来时才排在最前，其余场景照旧解析到
# 系统真 icacls（`%SystemRoot%\System32\icacls.exe`）。
# 退出码取 5 是**随手挑的一个非零值**，不假装是真 icacls 在非 NTFS 卷上的那个码 ——
# 被测脚本判的是 `$LASTEXITCODE -ne 0`，它判的就是「非 0」这件事本身；
# 挑一个具体值只是为了让断言能核「这 5 真的是从桩里出来的」。
$aclFailBin = Join-Path $workRoot 'bin-aclfail'
New-Item -ItemType Directory -Force -Path $aclFailBin | Out-Null
$icaclsFailCmd = @'
@echo off
exit /b 5
'@
[IO.File]::WriteAllText((Join-Path $aclFailBin 'icacls.cmd'), ($icaclsFailCmd -replace "`r?`n", "`r`n"), (New-Object System.Text.ASCIIEncoding))

# ── 第三个桩目录：**按目标路径分支**的 icacls（一成一败）───────────────────────
# 🔴 为什么不能拿上面那个恒 5 的桩凑：`2` 这一档的现实形态里，**「两个目标全败」与
# 「一成一败」是两件事** —— 后者才是 Separate 模式下最可能真实发生的那一种
# （凭据根在 NTFS 上收得紧，私钥目录在别的卷上收不紧），而它同时是唯一能验出
# 「点名列表里只该有失败的那个」的场景。恒 5 的桩结构上造不出这一格：
# 它让 $aclFailed 恒等于 $aclTargets，「点名列表」与「ACL 目标列表」永远不可区分。
#
# 形态：`DAO_ICACLS_FAIL_MATCH` 命中目标路径 ⇒ 退 5；**否则原样转交系统真 icacls**。
# 「否则转交真的」这一半不是省事，是判据来源：22d 要断言成功那一侧的目录
# `AreAccessRulesProtected` 真的变成了 True（判据取自 NTFS 不取自屏幕文案），
# 而那只有真 icacls 做得到 —— 顺带它也自证了「这个桩没有把两侧都吃掉」。
#
# ⚠ 三条实现约束，都是 cmd 的：
#  ① 用 `%*` 原样转发，**不重新拼参数** —— `(OI)(CI)F` 里的括号与用户名里的空格
#     一旦经过重新拼装就可能被 cmd 的分词吃掉（本仓 gh 桩的头注记的就是这个坑）。
#  ② 子串判断用 `!T:xxx=!` 需要 `enabledelayedexpansion`，**代价是路径里不能有 `!`**；
#     本文件的夹具路径全在 `_tmp/dao-secrets-test/` 下、纯 ASCII 无 `!`，故可用。
#  ③ 转交必须写**绝对路径** `%SystemRoot%\System32\icacls.exe`，否则解析回本桩自己 ⇒ 无限递归。
$aclPartialBin = Join-Path $workRoot 'bin-aclpartial'
New-Item -ItemType Directory -Force -Path $aclPartialBin | Out-Null
$icaclsPartialCmd = @'
@echo off
setlocal enabledelayedexpansion
set "T=%~1"
if defined DAO_ICACLS_FAIL_MATCH if not "!T:%DAO_ICACLS_FAIL_MATCH%=!"=="!T!" exit /b 5
"%SystemRoot%\System32\icacls.exe" %*
exit /b !ERRORLEVEL!
'@
[IO.File]::WriteAllText((Join-Path $aclPartialBin 'icacls.cmd'), ($icaclsPartialCmd -replace "`r?`n", "`r`n"), (New-Object System.Text.ASCIIEncoding))

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
    # -EnvOverrides：只改**本进程**环境块里的那几格，子进程继承之。
    # 用它而不是 [Environment]::SetEnvironmentVariable(..., 'User')：后者写注册表、跨进程持久，
    # 那才是「动用户真实环境」。收尾按「原来有没有值」分别复原 —— 原来没有的要**删掉**，
    # 复原成空串会留下一格假存在。
    # -ExtraPathDir：再往 PATH **最前**塞一个目录，只有点名的场景才传（当前唯一用处是
    # 那个失败版 icacls，见它的建法那一段）。默认不传 ⇒ 其余场景的解析面一个字都没变。
    param([string]$ScriptPath, [string[]]$ScriptArgs, [string]$CaseDir, [hashtable]$SopsCfg,
          [hashtable]$EnvOverrides, [string]$ExtraPathDir)
    $cfgPath = Join-Path $CaseDir 'sops-stub.json'
    [IO.File]::WriteAllText($cfgPath, (ConvertTo-Json $SopsCfg -Depth 5), $utf8NoBom)
    $logPath = Join-Path $CaseDir 'sops-calls.log'
    if (Test-Path $logPath) { Remove-Item $logPath -Force }

    $oldPath = $env:PATH
    $env:PATH = $binDir + ';' + $oldPath
    if ($ExtraPathDir) { $env:PATH = $ExtraPathDir + ';' + $env:PATH }
    $env:DAO_SOPS_CONFIG = $cfgPath
    $env:DAO_SOPS_LOG    = $logPath
    $env:DAO_SOPS_ARGV   = Join-Path $CaseDir 'sops-argv.txt'
    $env:DAO_AGE_ARGV    = Join-Path $CaseDir 'age-argv.txt'
    $envSaved = @{}
    if ($EnvOverrides) {
        foreach ($k in @($EnvOverrides.Keys)) {
            $envSaved[$k] = [Environment]::GetEnvironmentVariable($k, 'Process')
            [Environment]::SetEnvironmentVariable($k, $EnvOverrides[$k], 'Process')
        }
    }
    $out = $null
    $code = $null
    try {
        $psArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $ScriptPath) + $ScriptArgs
        $out = & $psExe @psArgs
        $code = $LASTEXITCODE
    } finally {
        $env:PATH = $oldPath
        foreach ($k in @($envSaved.Keys)) {
            [Environment]::SetEnvironmentVariable($k, $envSaved[$k], 'Process')
        }
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

# ACL 断言探针。**刻意读文件系统而不是读屏幕文案**：那行「权限已收成…」是脚本自己说的，
# `AreAccessRulesProtected` 是 NTFS 说的 —— 前者证明「代码走到了这一行」，只有后者证明
# 「继承真的断了」。本机实测：icacls /inheritance:r 之后为 True，纯继承的子目录为 False。
# 路径不存在时返回 $null（与 True/False 都不相等 ⇒ 断言不会因为"目录没建"而假绿）。
function Get-AclProtected {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    return (Get-Acl -LiteralPath $Path).AreAccessRulesProtected
}

function Measure-Occurrence {
    param([string]$Text, [string]$Pattern)
    return @([regex]::Matches($Text, $Pattern)).Count
}

# ── 「最后一屏点名块」的窗口 ────────────────────────────────────────────────
# init 第 7 节在 $aclFailed 非空时打一屏红字，其中**只有一行**是点名：
#   `foreach ($t in $aclFailed) { Write-Host "        $t" }`
# 「哪几个目录被点名了」这件事只能在那一行的产物里问。所以窗口**两端都要钉**：
#   下界 = 那句红字标记（'有目录的权限没收紧'）
#   上界 = 点名块闭合的那一行（'这台机器上的其他账户可能读得到它'）
#
# 🔴 **上界为什么是这一行，而不是 issue #173 原文建议的「本脚本不为这个退出 1」**：
# 那句话之前还隔着一段**按模式分岔的后果说明**，而 Separate 那一支里有一句
# `"上面若含 $keyDir，那是**私钥目录** …"` —— 它在该分支里**无条件打印**且含 $keyDir，
# 场景 19 走的正是 Separate ⇒ 上界截到那里的话，19d 的 keyDir 半边**仍然恒真**，
# 只是恒真的来源从收尾屏换成了后果说明。上界取「其他账户可能读得到它」那一行，
# 才是 `foreach` 点名块的真实闭合处（照 issue 原文照抄会修出半失明，本批实测确认）。
#
# 🔴 **两端任一端找不到就返回空串（fail-closed）**：锚点被改掉/被删掉时断言该**红**，
# 不该悄悄退化成「搜全篇」—— 那正是 #173 要治的那个病的成因。
$RED_BLOCK_BEGIN = '有目录的权限没收紧'
$RED_BLOCK_END   = '这台机器上的其他账户可能读得到它'
function Get-RedBlockWindow {
    param([string]$Text)
    if (-not $Text) { return '' }
    $i = $Text.IndexOf($RED_BLOCK_BEGIN)
    if ($i -lt 0) { return '' }
    $j = $Text.IndexOf($RED_BLOCK_END, $i)
    if ($j -lt 0) { return '' }
    return $Text.Substring($i, $j - $i)
}

# 🔴 **凡是调 init 的场景都必须配一个假 APPDATA + 一个显式的 -KeyLocation**，
# 哪怕这个场景测的根本不是私钥落点。这不是防御性编程，是本批实测撞出来的：
# mutation 的 K4 变体（把 Portable 那条也指向 %AppData%）跑完之后，
# **一把（桩造的假）私钥真的出现在了操作者的 `%APPDATA%\sops\age\keys.txt`** ——
# 因为场景 1-4 当时既没覆写 APPDATA、也没显式钉模式，init 就照着真环境变量写了。
# 抓住它的是场景 18c 那条负控（它是本批新加的，加之前这件事会静默发生）。
# ⇒ 两条规矩，绑在一起：
#   ① 调 init ⇒ 传 -EnvOverrides @{ APPDATA = (New-FakeAppData …) }
#   ② 断言与私钥落点无关的场景 ⇒ **显式钉 -KeyLocation**，别吃默认值 ——
#      否则改一次默认值，这些场景的语义会跟着悄悄换掉（场景 15 才是专门守默认值的那一条）。
function New-FakeAppData {
    param([string]$CaseDir)
    $d = Join-Path $CaseDir 'fake-appdata'
    New-Item -ItemType Directory -Force -Path $d | Out-Null
    return $d
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
$a1 = New-FakeAppData -CaseDir $c1
$r1 = Invoke-Target -ScriptPath $initPs1 -CaseDir $c1 -SopsCfg (New-SopsCfg) `
        -ScriptArgs @('-SecretsDir', $s1, '-KeyLocation', 'Portable') `
        -EnvOverrides @{ APPDATA = $a1 }

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
Assert-True '1i 假 APPDATA 下零写入（Portable 一个字节都不该往那边写）' `
    (-not (Test-Path (Join-Path $a1 'sops'))) ''

# ============================================================================
# 场景 2：**G1 靶** —— 「加密」其实只是复制 ⇒ 必须当场停
# ============================================================================
# 判别力从哪来：passthrough 下 decrypt 也回得来、值也对得上 ⇒ 除了 G1，
# 没有任何一条断言会不高兴。G1 一没（删 / 注释 / $false -and），init 就 exit 0。
Write-Host '场景 2：**G1 靶** —— 桩的 encrypt 原样复制 ⇒ 密文里看得见明文 ⇒ 必须 exit 1'

$c2 = New-Case 'init-passthrough'
$s2 = Join-Path $c2 'secrets'
$a2 = New-FakeAppData -CaseDir $c2
$r2 = Invoke-Target -ScriptPath $initPs1 -CaseDir $c2 -SopsCfg (New-SopsCfg -Mode 'passthrough') `
        -ScriptArgs @('-SecretsDir', $s2, '-KeyLocation', 'Portable') `
        -EnvOverrides @{ APPDATA = $a2 }

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
$a3 = New-FakeAppData -CaseDir $c3
$r3 = Invoke-Target -ScriptPath $initPs1 -CaseDir $c3 -SopsCfg (New-SopsCfg -EncryptExit 1) `
        -ScriptArgs @('-SecretsDir', $s3, '-KeyLocation', 'Portable') `
        -EnvOverrides @{ APPDATA = $a3 }

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

$a4 = New-FakeAppData -CaseDir $c4
$r4 = Invoke-Target -ScriptPath $initPs1 -CaseDir $c4 -SopsCfg (New-SopsCfg) `
        -ScriptArgs @('-SecretsDir', $s4, '-KeyLocation', 'Portable') `
        -EnvOverrides @{ APPDATA = $a4 }
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
# 场景 13：**Separate 靶** —— 私钥落 %AppData%，凭据根里一个 age\ 都没有
# ============================================================================
# 这条分支此前**完全在网外**（本文件首版头注自陈「测它要重定向真实的 APPDATA」）。
# 治法：把 APPDATA 覆写到 _tmp/ 下一个假目录，**只改本进程的环境块**，子进程继承 ——
# 真实 %APPDATA% 一个字节都不碰（场景 18 有负控核这一点）。
#
# 判别力从哪来：init 里控制这件事的是**两处**，且它们各管一半 ——
#   ㈠ `if ($KeyLocation -eq 'Portable') { $keyDir = …\age } else { $keyDir = $env:AppData\sops\age }`
#      决定私钥**落在哪**；
#   ㈡ `if ($KeyLocation -eq 'Separate') { $aclTargets += $keyDir }`
#      决定私钥目录的**权限收不收** —— Portable 时私钥在凭据根里、靠继承即可，
#      Separate 时私钥在凭据根**之外**，不单独收就完全没人管它，
#      而它恰恰是全套东西里唯一不可再生的那一个。
# ㈡ 坏掉时 ㈠ 的断言全绿（私钥照样落对地方），所以 13e 那条 ACL 断言不是锦上添花，
# 它是唯一咬得到 ㈡ 的东西。
Write-Host '场景 13：**Separate 靶** —— 私钥落 %AppData%\sops\age、凭据根里没有 age\、私钥目录 ACL 单独收紧'

$c13 = New-Case 'init-separate'
$s13 = Join-Path $c13 'secrets'
$appData13 = New-FakeAppData -CaseDir $c13
$r13 = Invoke-Target -ScriptPath $initPs1 -CaseDir $c13 -SopsCfg (New-SopsCfg) `
        -ScriptArgs @('-SecretsDir', $s13, '-KeyLocation', 'Separate') `
        -EnvOverrides @{ APPDATA = $appData13 }

$sepKeyDir13  = Join-Path $appData13 'sops\age'
$sepKeyFile13 = Join-Path $sepKeyDir13 'keys.txt'

Assert-True '13a exit 0' ($r13.ExitCode -eq 0) ("exit={0}" -f $r13.ExitCode)
Assert-True '13b 私钥落在 %AppData%\sops\age\keys.txt（sops 在 Windows 上的默认位置）' `
    (Test-Path $sepKeyFile13) ("期望={0}" -f $sepKeyFile13)
Assert-True '13c 凭据根里**没有** age\ 目录 —— 这是 Separate 买到的那一格' `
    (-not (Test-Path (Join-Path $s13 'age'))) ''
Assert-True '13d .sops.yaml 仍在凭据根，且里面写明私钥去了 %AppData% 那一侧' `
    ((Test-Path (Join-Path $s13 '.sops.yaml')) -and `
     ([IO.File]::ReadAllText((Join-Path $s13 '.sops.yaml'), [Text.Encoding]::UTF8).Contains($sepKeyFile13))) ''
Assert-True '13e **私钥目录的 ACL 真的被收紧了**（断了继承，判据取自 NTFS 不取自屏幕文案）' `
    ((Get-AclProtected $sepKeyDir13) -eq $true) ("AreAccessRulesProtected={0}" -f (Get-AclProtected $sepKeyDir13))
Assert-True '13f 凭据根本身照旧也收紧了（两个目标都收，不是拿私钥目录换掉了凭据根）' `
    ((Get-AclProtected $s13) -eq $true) ''
Assert-True '13g 屏幕上「权限已收成」出现 2 次，且其中一次点名私钥目录' `
    (((Measure-Occurrence -Text $r13.Text -Pattern '权限已收成') -eq 2) -and `
     ($r13.Text.Contains($sepKeyDir13))) `
    ("次数={0}" -f (Measure-Occurrence -Text $r13.Text -Pattern '权限已收成'))
Assert-True '13h 明说「不需要环境变量」，且**没有**走 Portable 那条「没自动设」的提示' `
    (($r13.Text -match '不需要环境变量') -and (-not ($r13.Text -match '没自动设'))) ''
Assert-True '13i 换机提示说的是「要搬**两处**」（Separate 的代价，必须当面讲）' `
    ($r13.Text -match '要搬\*\*两处\*\*') ''
Assert-True '13j 第 6 步自证照常走完（exit 0 不等于自证跑过）' `
    ($r13.Text -match '加密链路整条通了') ''

# ============================================================================
# 场景 14：**Portable 反向** —— 私钥落凭据根，假 APPDATA 下一个字节都没写
# ============================================================================
# 与场景 13 成对。没有这一条，13 的全部断言可以在「两种模式都走 Separate」下照样绿。
Write-Host '场景 14：Portable 反向 —— 私钥落凭据根\age、假 APPDATA 下没有 sops\age、ACL 只收凭据根'

$c14 = New-Case 'init-portable'
$s14 = Join-Path $c14 'secrets'
$appData14 = New-FakeAppData -CaseDir $c14
$r14 = Invoke-Target -ScriptPath $initPs1 -CaseDir $c14 -SopsCfg (New-SopsCfg) `
        -ScriptArgs @('-SecretsDir', $s14, '-KeyLocation', 'Portable') `
        -EnvOverrides @{ APPDATA = $appData14 }

Assert-True '14a exit 0' ($r14.ExitCode -eq 0) ("exit={0}" -f $r14.ExitCode)
Assert-True '14b 私钥落凭据根 age\keys.txt' `
    (Test-Path (Join-Path $s14 'age\keys.txt')) ''
Assert-True '14c 假 APPDATA 下**没有** sops\age —— Portable 不该往那边写一个字节' `
    (-not (Test-Path (Join-Path $appData14 'sops'))) ''
Assert-True '14d 私钥目录**靠继承**拿权限（不单独断继承：对子目录再断一次会把父目录刚传下来的 ACE 断掉）' `
    ((Get-AclProtected (Join-Path $s14 'age')) -eq $false) `
    ("AreAccessRulesProtected={0}" -f (Get-AclProtected (Join-Path $s14 'age')))
Assert-True '14e 屏幕上「权限已收成」只出现 1 次（ACL 目标不含私钥目录）' `
    ((Measure-Occurrence -Text $r14.Text -Pattern '权限已收成') -eq 1) `
    ("次数={0}" -f (Measure-Occurrence -Text $r14.Text -Pattern '权限已收成'))
Assert-True '14f 需要 SOPS_AGE_KEY_FILE：走的是「没自动设」那条提示，不是「不需要环境变量」' `
    (($r14.Text -match '没自动设') -and (-not ($r14.Text -match '不需要环境变量'))) ''
Assert-True '14g 换机提示说的是「整个 <凭据根> 文件夹拷过去」' `
    ($r14.Text -match '文件夹拷过去') ''

# ============================================================================
# 场景 15：**默认值** —— 不传 -KeyLocation 时走哪一条
# ============================================================================
# 这一条守的是**一个字面量**：`[string]$KeyLocation = 'Separate'`。
# 它是本文件里唯一会因为「有人改了默认值」而变红的东西 —— 场景 13/14 都显式传了参数，
# 默认值怎么改它们都绿。
#
# 🔴 **改默认值的人必须同时改这一条断言**，那正是它存在的理由：把「换个默认值」
# 从一次静默的单词替换，变成一次需要当面写进测试的决定。
# 现值 **Separate** 的出处：用户 2026-08-06 拍板（issue #72「最近拍板」节）——
# 他在乎的只有「密钥不要混在程序代码里」，而那一件两种模式都已满足；私钥丢了不要紧
# （重新生成 + 重填即可）⇒ Portable「一个文件夹拷走即换机」的卖点归零，
# 而 Separate 白得一格（专门拷 .dao-secrets 的人拿不到钥匙）。
# 上一版这里钉的是 Portable（2026-08-05「能带走优先」），同批改的。
Write-Host '场景 15：默认值（不传 -KeyLocation）⇒ 与 Separate 逐格一致'

$c15 = New-Case 'init-default'
$s15 = Join-Path $c15 'secrets'
$appData15 = New-FakeAppData -CaseDir $c15
$r15 = Invoke-Target -ScriptPath $initPs1 -CaseDir $c15 -SopsCfg (New-SopsCfg) `
        -ScriptArgs @('-SecretsDir', $s15) `
        -EnvOverrides @{ APPDATA = $appData15 }

Assert-True '15a exit 0' ($r15.ExitCode -eq 0) ("exit={0}" -f $r15.ExitCode)
Assert-True '15b **默认 = Separate**：私钥落假 APPDATA\sops\age\keys.txt' `
    (Test-Path (Join-Path $appData15 'sops\age\keys.txt')) ''
Assert-True '15c **默认 = Separate**：凭据根里没有 age\ 目录' `
    (-not (Test-Path (Join-Path $s15 'age'))) ''
Assert-True '15d 屏幕上把模式印出来了，印的是 Separate（用户看得见自己走的是哪条）' `
    ($r15.Text -match '私钥落点模式：Separate') ''
Assert-True '15e 默认路径下私钥目录的 ACL 被**单独**收紧（它在凭据根之外，没人管它就真没人管）' `
    ((Get-AclProtected (Join-Path $appData15 'sops\age')) -eq $true) ''

# ============================================================================
# 场景 19：**ACL 收不紧 ⇒ exit 2**（分档退出码 · 用户 2026-08-07 拍板 · issue #148）
# ============================================================================
# 🔴 **编号 19 却排在 16 前面，是刻意的**：16/17/18 是三条**收尾**断言（跨场景搜凭据值、
# 被测脚本自身可解析、真环境没被碰），语义上必须留在最后，而 16 又要把本场景的输出
# 一起扫一遍 ⇒ 位置只能在它前面。**不重新编号**：记分板（2026-08-09 已迁 docs/evolution/
# comment-archive-20260809.md §dao-secrets.tests.ps1）与本文件那条 18c 负控的说明都逐条引用了
# 13e / 15b / 18c 这些名字，改编号会把它们全部指向空气（#官通-同批查引用 讲的那种静默失效）。
#
# 这一格治的病：ACL 收不紧时脚本此前**退出码 0** —— 「权限没收紧」与「一切正常」
# 在唯一的机器可读通道上逐字节相同。第 7 节那一屏红字治的是**人眼**，
# 退出码治的是**消费方**，两半各治一半、缺哪半都漏。
#
# 怎么造出「ACL 收不紧」：PATH 最前塞一个恒 exit 5 的 icacls 桩（只对本场景生效，
# 见它的建法那一段）。**不是**去找一张真的非 NTFS 卷 —— 那要求这台机器上插着 U 盘，
# 而「要有 U 盘才跑得起来」的断言与不存在的断言在退出码上不可区分。
#
# 判别力从哪来（数字取自实测，见头注附三之三）：把被测脚本末尾那句 `exit 2` 改回
# `exit 0`，红的是 **19a 与 19h 两条**，19b~19g 全绿 —— 因为那六条说的是
# 「icacls 真失败了」「ACL 真没收紧」「屏幕上真说了」「主体真成了」，
# 那几件事在 exit 0 下**全部照旧成立**。⇒ 咬得到「分档」本身的只有 19a（本档取值）
# 与 19h（三态互不相同），其余六条是它们的对照组，不是重复。
# 反过来，19b/19c 是它的**对照组自验**：没有它们，本场景可以在「桩根本没生效、
# 脚本照常收紧了权限、只是碰巧退了 2」的情况下全绿（#官通-对照组自验）。
Write-Host '场景 19：**分档退出码** —— icacls 失败 ⇒ exit 2（不是 0、也不是 1）'

$c19 = New-Case 'init-acl-fail'
$s19 = Join-Path $c19 'secrets'
$appData19 = New-FakeAppData -CaseDir $c19
$r19 = Invoke-Target -ScriptPath $initPs1 -CaseDir $c19 -SopsCfg (New-SopsCfg) `
        -ScriptArgs @('-SecretsDir', $s19, '-KeyLocation', 'Separate') `
        -EnvOverrides @{ APPDATA = $appData19 } `
        -ExtraPathDir $aclFailBin

$keyDir19 = Join-Path $appData19 'sops\age'

Assert-True '19a **exit 2**（0 = 全成 / 2 = 主体成功但权限没收紧 / 1 = 真失败）' `
    ($r19.ExitCode -eq 2) ("exit={0}" -f $r19.ExitCode)
Assert-True '19b 对照组自验①：icacls 桩真的被调用且真的失败了（屏幕上是它那个 5）' `
    ($r19.Text -match 'icacls 退出码 5') ''
Assert-True '19c 对照组自验②：凭据根的 ACL **确实没被收紧**（判据取自 NTFS，不取自屏幕文案）' `
    ((Get-AclProtected $s19) -eq $false) ("AreAccessRulesProtected={0}" -f (Get-AclProtected $s19))
# 🔴 「最后一屏」这四个字必须真的**只看最后一屏**（2026-08-07 接手官订正，出处是 P1 变体）：
# 原版写的是 `$r19.Text.Contains($s19)` —— 整篇输出里搜路径。而这两个路径在**第 1 节
# 「现状（只读）」里就已经原样打过一次**了 ⇒ 那个断言即使在「最后一屏根本没打印」时也照绿。
# P1-early 变体（icacls 一失败就当场退 2、后面几屏全不执行）把它当场量了出来：
# 19b/19f/19g 全红，**唯独 19d 绿** —— 它的名字说的事，它没在验。
# 治法：只在「有目录的权限没收紧」那句红字**之后**的文本里搜。
# 🔴 ~~而这个治法**不成立**（2026-08-07 · PR #170 对抗验证，账 #173）：红字之后的窗口
# 仍含无条件打印的收尾屏（init 脚本第 384 行 $keyFile / 第 395 行 $SecretsDir），
# 两个 Contains 恒真——S19D/S19X 实测全绿。修法（截窗口上界或按区间计数）归 #173，
# 本行先把「已修好」的宣称撤回：下面断言名里「两个目录都被点名」当前没在被验。~~
# **上界补齐后成立（2026-08-07 · issue #173 本批）**：窗口改为**两端都钉**，
# 取法与「为什么上界不是 issue 原文那一行」写在 `Get-RedBlockWindow` 的头注里。
# 判别力照直写（本批实测，记分板见头注附三之四）：S19D / S19X 两个变体下 19d **红**；
# **同样两个变体拿订正前那版测试跑，19d 绿、整套 exit 0** ⇒ 这两条红的唯一原因就是本次修法。
# 窗口任一端锚点被改掉 ⇒ 窗口取空 ⇒ 本条红（W1 变体实测，fail-closed）。
$lastScreen19 = Get-RedBlockWindow -Text $r19.Text
Assert-True '19d 私钥目录同样没收紧，且**两个目录都被点名**在最后一屏（只搜那一屏，不搜全篇）' `
    (((Get-AclProtected $keyDir19) -eq $false) -and $lastScreen19.Contains($s19) -and $lastScreen19.Contains($keyDir19)) `
    ("窗口长度={0} 含凭据根={1} 含私钥目录={2}" -f $lastScreen19.Length, $lastScreen19.Contains($s19), $lastScreen19.Contains($keyDir19))
Assert-True '19e 「权限已收成」一次都没出现（两个目标全败）' `
    ((Measure-Occurrence -Text $r19.Text -Pattern '权限已收成') -eq 0) `
    ("次数={0}" -f (Measure-Occurrence -Text $r19.Text -Pattern '权限已收成'))
# 这一条是「2 不是 1」的实质判据：2 的定义是**主体成功**，不是「失败得轻一点」。
Assert-True '19f 主体真的成功了：私钥落盘 + .sops.yaml 落盘 + 第 6 步自证走完' `
    ((Test-Path (Join-Path $keyDir19 'keys.txt')) -and `
     (Test-Path (Join-Path $s19 '.sops.yaml')) -and `
     ($r19.Text -match '加密链路整条通了')) ''
Assert-True '19g 最后一屏把退出码 2 的含义说给人看了（用户读的是最后几行）' `
    (($r19.Text -match '退出码 \*\*2\*\*') -and ($r19.Text -match '权限没收紧')) ''
# 分档这件事的定义就是「三个值分得开」。三态各取一个真实场景比对，而不是只验其中一格：
#   0 ← 场景 13（同样 Separate、同样两个 ACL 目标，只是 icacls 真的成了）
#   2 ← 本场景（主体成功、ACL 没收紧）
#   1 ← 场景 3（sops encrypt 自己失败 = 真失败）
Assert-True '19h **三态互不相同**：13 → 0、19 → 2、3 → 1' `
    (($r13.ExitCode -eq 0) -and ($r19.ExitCode -eq 2) -and ($r3.ExitCode -eq 1)) `
    ("13={0} 19={1} 3={2}" -f $r13.ExitCode, $r19.ExitCode, $r3.ExitCode)

# ============================================================================
# 场景 20：**-DryRun 过了工具前置检查之后恒 0**，哪怕 icacls 注定会失败（分档契约里那句话的守卫）
# ============================================================================
# 被测脚本的 .NOTES「退出码分档」里原本写着一句 `-DryRun 恒 0`，而在本场景之前
# **那句话一条断言都没有**。
# ~~它当时之所以为真，只是因为 DryRun 的 `exit 0` 排在第 2 节（收权限）**之前**，
# 是个**位置上的巧合**，没有任何东西钉住这个位置。~~
# **订正（2026-08-07 · issue #173 F2）**：那句话**当时也不是无条件为真的** ——
# 第 0 步「sops / age 装了没」排在 -DryRun 块**前面**，缺任何一个都直接 exit 1。
# 所以要分两截说：**①「过了工具检查之后恒 0」才是真命题**（`.NOTES` 已同批收窄为这一句）；
# ②「过了之后」那一截为真，靠的是 DryRun 的 `exit 0` 排在收权限之前这个**位置**，
# 而没有任何东西钉住那个位置 —— **本场景钉的是 ②，不是整句**。
# ⚠ **① 那一截本场景不覆盖**（缺工具 ⇒ -DryRun 也退 1）：本文件的调用外壳无条件把桩目录
# 前置进 PATH，两个工具因此总在；要测它得给外壳开一个「不上桩」的口子。照直记为缺口。
#
# 这一格为什么值得单独占一条：`-DryRun` 是 `docs/USER-ACTIONS.md` 教用户敲的**第一条命令**。
# 哪天有人把分档那一段往前挪、或给 DryRun 也加上 ACL 预演，用户的第一步就会返回 2 ——
# 而屏幕上什么异常都没有（DryRun 本来就不打印 ACL 结果）。
#
# 判别力从哪来：本场景**故意带上那个恒失败的 icacls 桩**。它绿，证明的是
# 「DryRun 压根没走到收权限那一步」，不只是「这次 icacls 碰巧成了」。
# 换靶见头注附三之三的 D1 变体（把 DryRun 块里那句 `exit 0` 改成 `exit 2`）⇒ 20a 变红。
Write-Host '场景 20：-DryRun 过了工具检查后恒 0（带着恒失败的 icacls 桩也一样）+ 零写操作'

$c20 = New-Case 'init-dryrun'
$s20 = Join-Path $c20 'secrets'
$appData20 = New-FakeAppData -CaseDir $c20
$r20 = Invoke-Target -ScriptPath $initPs1 -CaseDir $c20 -SopsCfg (New-SopsCfg) `
        -ScriptArgs @('-SecretsDir', $s20, '-KeyLocation', 'Separate', '-DryRun') `
        -EnvOverrides @{ APPDATA = $appData20 } `
        -ExtraPathDir $aclFailBin

Assert-True '20a **-DryRun exit 0**（分档不许把用户的第一条命令染成 2）' `
    ($r20.ExitCode -eq 0) ("exit={0}" -f $r20.ExitCode)
Assert-True '20b 零写操作：凭据根没被建出来' `
    (-not (Test-Path $s20)) ''
Assert-True '20c 零写操作：假 APPDATA 下也没有 sops\age' `
    (-not (Test-Path (Join-Path $appData20 'sops'))) ''
Assert-True '20d 对照组自验：那个恒失败的 icacls 桩**一次都没被调到**（DryRun 没走到第 2 节）' `
    ((Measure-Occurrence -Text $r20.Text -Pattern 'icacls 退出码') -eq 0) `
    ("次数={0}" -f (Measure-Occurrence -Text $r20.Text -Pattern 'icacls 退出码'))

# ============================================================================
# 场景 21：**真失败压过 2** —— ACL 也没收紧，但主体失败了 ⇒ 必须是 1，不是 2
# ============================================================================
# 🔴 这是分档的**负控**，也是三档里唯一有安全后果的那一格：`2` 的定义是
# **「主体成功」**。如果分档被实现成「先看 aclFailed，有就退 2」，那么一次
# **加密链路根本没验通**的跑动会被报成「密钥主体成功，只是权限没收紧」——
# 用户据此往下走第 3 步搬凭据，而那个凭据根其实是坏的。
# ⇒ 「1 压过 2」不是措辞问题，它决定了 `2` 这个值还能不能被信。
#
# 造法：**两个故障同时上** —— 恒失败的 icacls 桩（⇒ aclFailed 非空）+ encrypt 退 1
# （⇒ 主体真失败）。21b 是对照组自验：没有它，本条可以在「icacls 桩压根没生效、
# aclFailed 是空的、所以当然退 1」的情况下全绿，那样它就一个字都没验到（#官通-对照组自验）。
Write-Host '场景 21：**负控** —— ACL 失败 **且** 主体失败 ⇒ exit 1（真失败压过 2）'

$c21 = New-Case 'init-acl-fail-and-encrypt-fail'
$s21 = Join-Path $c21 'secrets'
$appData21 = New-FakeAppData -CaseDir $c21
$r21 = Invoke-Target -ScriptPath $initPs1 -CaseDir $c21 -SopsCfg (New-SopsCfg -EncryptExit 1) `
        -ScriptArgs @('-SecretsDir', $s21, '-KeyLocation', 'Separate') `
        -EnvOverrides @{ APPDATA = $appData21 } `
        -ExtraPathDir $aclFailBin

Assert-True '21a **exit 1**（主体没成，就不许报成「2 = 主体成功但权限没收紧」）' `
    ($r21.ExitCode -eq 1) ("exit={0}" -f $r21.ExitCode)
Assert-True '21b 对照组自验：2 的触发条件**确实成立**（icacls 真失败了），退 1 不是因为它没触发' `
    ($r21.Text -match 'icacls 退出码 5') ''
Assert-True '21c 真失败的原因被说出来了（报的是 encrypt 的退出码）' `
    ($r21.Text -match 'sops encrypt 退出码 1') ''
Assert-True '21d 没宣告链路通，也没打出那句「本次退出码 **2**」' `
    ((-not ($r21.Text -match '加密链路整条通了')) -and (-not ($r21.Text -match '本次退出码 \*\*2\*\*'))) ''

# ============================================================================
# 场景 22：**一成一败也是 2**（issue #173 F5 —— `2` 档的第一个覆盖缺口）
# ============================================================================
# 场景 19 造的是「两个 ACL 目标**全败**」。而 Separate 模式下更可能真实发生的是
# **一成一败**：凭据根在 NTFS 上收得紧，私钥目录落在别的卷（U 盘 / 网络盘）上收不紧。
# 全败那一格覆盖不了它 —— 恒 5 的桩让 `$aclFailed` 恒等于 `$aclTargets`，于是
# 「点名列表」与「ACL 目标列表」在观察上**完全不可区分**，一条断言也分不开这两件事。
#
# 造法：按目标路径分支的 icacls 桩（`$aclPartialBin`，见它的建法那一段）——
# 命中 `sops\age` 的那个目标退 5，另一个**原样转交系统真 icacls**。
#
# 判别力从哪来：
#  · 22d 断言成功那一侧的目录 `AreAccessRulesProtected` 真的是 True、失败那一侧是 False
#    —— 判据取自 NTFS 不取自屏幕文案，同时它自证了「这个桩没把两侧一起吃掉」。
#  · 22e 是本场景最值钱的一条，也是 **19d 之外第二条独立咬住窗口上界的断言**：
#    点名列表里**只该有失败的那个**。收尾屏第 395 行无条件打印 `$SecretsDir`
#    （「要搬**两处**：… 和 …」）⇒ 拿订正前那个「红字标记之后全篇」的窗口跑，
#    22e **必红**。它与 19d 不同型：19d 问「该出现的出现了吗」，22e 问
#    「**不该出现的没出现吧**」—— 恒真型缺陷只对前者失明，对后者不失明。
Write-Host '场景 22：**一成一败** —— 凭据根收紧了、私钥目录没收紧 ⇒ 仍是 exit 2，且只点名失败的那个'

$c22 = New-Case 'init-acl-partial'
$s22 = Join-Path $c22 'secrets'
$appData22 = New-FakeAppData -CaseDir $c22
$r22 = Invoke-Target -ScriptPath $initPs1 -CaseDir $c22 -SopsCfg (New-SopsCfg) `
        -ScriptArgs @('-SecretsDir', $s22, '-KeyLocation', 'Separate') `
        -EnvOverrides @{ APPDATA = $appData22; DAO_ICACLS_FAIL_MATCH = 'sops\age' } `
        -ExtraPathDir $aclPartialBin

$keyDir22 = Join-Path $appData22 'sops\age'
$lastScreen22 = Get-RedBlockWindow -Text $r22.Text

Assert-True '22a **exit 2**（一成一败同样是「主体成功但权限没收紧」，不是 0 也不是 1）' `
    ($r22.ExitCode -eq 2) ("exit={0}" -f $r22.ExitCode)
Assert-True '22b 对照组自验①：**恰好一个**目标失败了（icacls 退出码 5 只出现 1 次）' `
    ((Measure-Occurrence -Text $r22.Text -Pattern 'icacls 退出码 5') -eq 1) `
    ("次数={0}" -f (Measure-Occurrence -Text $r22.Text -Pattern 'icacls 退出码 5'))
Assert-True '22c 对照组自验②：**恰好一个**目标成功了，且成功的那次点名的是凭据根' `
    (((Measure-Occurrence -Text $r22.Text -Pattern '权限已收成') -eq 1) -and `
     ($r22.Text.Contains('权限已收成「只有') -and $r22.Text.Contains($s22))) `
    ("次数={0}" -f (Measure-Occurrence -Text $r22.Text -Pattern '权限已收成'))
Assert-True '22d NTFS 实况一成一败：凭据根 Protected=True、私钥目录 Protected=False（桩的转交路径真的调到了真 icacls）' `
    (((Get-AclProtected $s22) -eq $true) -and ((Get-AclProtected $keyDir22) -eq $false)) `
    ("凭据根={0} 私钥目录={1}" -f (Get-AclProtected $s22), (Get-AclProtected $keyDir22))
Assert-True '22e 最后一屏的点名列表里**只有失败的那个**（含私钥目录、不含凭据根）' `
    ($lastScreen22.Contains($keyDir22) -and (-not $lastScreen22.Contains($s22))) `
    ("窗口长度={0} 含私钥目录={1} 含凭据根={2}" -f $lastScreen22.Length, $lastScreen22.Contains($keyDir22), $lastScreen22.Contains($s22))
Assert-True '22f 主体真的成功了（2 的前提）：私钥落盘 + .sops.yaml 落盘 + 第 6 步自证走完' `
    ((Test-Path (Join-Path $keyDir22 'keys.txt')) -and `
     (Test-Path (Join-Path $s22 '.sops.yaml')) -and `
     ($r22.Text -match '加密链路整条通了')) ''

# ============================================================================
# 场景 23：**Portable 下的 2**（issue #173 F5 —— `2` 档的第二个覆盖缺口）
# ============================================================================
# 19/21/22 三条全是 Separate。而 `2` 这一档在 Portable 下走的**不是同一段代码**：
#  ① ACL 目标只有**一个**（私钥目录在凭据根里、靠继承，不单独收）；
#  ② 第 7 节的后果说明**按模式分岔** —— Portable 那一支说的是
#     「私钥也在凭据根里 ⇒ 读得到就等于解得开」，那是**比 Separate 更重**的后果，
#     而它此前一条断言都没有：把那个 `if ($KeyLocation -eq 'Portable')` 翻面，
#     Portable 的用户会读到 Separate 的说法（「若只是凭据根没收紧，别人拿到的
#     还只是打不开的密文」）—— **一句在 Portable 下是假话的安慰**。
# ⇒ 23d 是唯一咬得到那个分岔的断言；23f 咬的是 ①。
Write-Host '场景 23：**Portable 下的 2** —— 只有一个 ACL 目标、后果说明走 Portable 那一支'

$c23 = New-Case 'init-acl-fail-portable'
$s23 = Join-Path $c23 'secrets'
$appData23 = New-FakeAppData -CaseDir $c23
$r23 = Invoke-Target -ScriptPath $initPs1 -CaseDir $c23 -SopsCfg (New-SopsCfg) `
        -ScriptArgs @('-SecretsDir', $s23, '-KeyLocation', 'Portable') `
        -EnvOverrides @{ APPDATA = $appData23 } `
        -ExtraPathDir $aclFailBin

$lastScreen23 = Get-RedBlockWindow -Text $r23.Text

Assert-True '23a **exit 2**（Portable 同样分档，不是只有 Separate 才退 2）' `
    ($r23.ExitCode -eq 2) ("exit={0}" -f $r23.ExitCode)
Assert-True '23b 对照组自验：icacls 桩真失败了，且「权限已收成」一次都没有' `
    (($r23.Text -match 'icacls 退出码 5') -and `
     ((Measure-Occurrence -Text $r23.Text -Pattern '权限已收成') -eq 0)) ''
Assert-True '23c 凭据根的 ACL **确实没被收紧**（判据取自 NTFS）' `
    ((Get-AclProtected $s23) -eq $false) ("AreAccessRulesProtected={0}" -f (Get-AclProtected $s23))
Assert-True '23d 后果说明走的是 **Portable 那一支**（「私钥也在凭据根里」），没走 Separate 那一支' `
    ($r23.Text.Contains('私钥也在凭据根里') -and (-not $r23.Text.Contains('钥匙裸着比密文裸着更糟'))) ''
Assert-True '23e 主体真的成功了：私钥落凭据根 age\keys.txt + .sops.yaml + 自证走完' `
    ((Test-Path (Join-Path $s23 'age\keys.txt')) -and `
     (Test-Path (Join-Path $s23 '.sops.yaml')) -and `
     ($r23.Text -match '加密链路整条通了')) ''
# Portable 的 ACL 目标只有凭据根一个 ⇒ 点名列表里它恰好出现 1 次。
# 若哪天 Portable 也把 `<凭据根>\age` 加进 $aclTargets，那个子路径同样含凭据根这个前缀，
# 计数会变成 2 ⇒ 本条红。这就是它比「含不含」强的地方。
Assert-True '23f 点名列表里凭据根**恰好出现 1 次**（Portable 只有一个 ACL 目标）' `
    ((Measure-Occurrence -Text $lastScreen23 -Pattern ([regex]::Escape($s23))) -eq 1) `
    ("窗口长度={0} 次数={1}" -f $lastScreen23.Length, (Measure-Occurrence -Text $lastScreen23 -Pattern ([regex]::Escape($s23))))

# ============================================================================
# 场景 16：全程**一个凭据值都没印到屏幕上**
# ============================================================================
# 两个脚本的 .NOTES 都写着「从不打印任何凭据的值、片段、长度或哈希」。
# 这条断言把那句话变成可执行的：把上面所有场景的输出连起来搜假串。
Write-Host '场景 16：所有场景的输出里，一个凭据值都没出现过'

$allText = @($r1.Text, $r2.Text, $r3.Text, $r4.Text, $r5.Text, $r6.Text, $r7.Text,
             $r8.Text, $r9.Text, $r10.Text, $r11.Text, $r12.Text,
             $r13.Text, $r14.Text, $r15.Text, $r19.Text, $r20.Text, $r21.Text,
             $r22.Text, $r23.Text) -join "`n"
Assert-True '16a 屏幕输出里搜不到任何一个假凭据值（键名可以有、值一个都不许有）' `
    ((-not $allText.Contains($FAKE_A)) -and (-not $allText.Contains($FAKE_B)) -and `
     (-not $allText.Contains('sk-FAKE-jsonshape-001'))) ''

# ============================================================================
# 场景 17：两个被测脚本自身可解析、且带 BOM
# ============================================================================
# BOM 不是形式：PS 5.1 读无 BOM 的中文脚本会按 CP936 重读，整个脚本报废 ——
# 而那时**本文件的全部断言都会红**，看起来正好像「这套网密不透风」。先把它钉住。
Write-Host '场景 17：被测脚本零语法错误 + 带 BOM'

foreach ($pair in @(@('dao-secrets-init.ps1', $initPs1), @('dao-secrets-migrate.ps1', $migratePs1))) {
    $tokens = $null
    $errors = $null
    $null = [System.Management.Automation.Language.Parser]::ParseFile($pair[1], [ref]$tokens, [ref]$errors)
    Assert-True ("17 {0} 零语法错误" -f $pair[0]) (@($errors).Count -eq 0) ("ParseErrors={0}" -f @($errors).Count)
    $head = [byte[]]::new(3)
    $fs = [IO.File]::OpenRead($pair[1])
    try { $null = $fs.Read($head, 0, 3) } finally { $fs.Dispose() }
    Assert-True ("17 {0} 带 UTF-8 BOM" -f $pair[0]) `
        (($head[0] -eq 0xEF) -and ($head[1] -eq 0xBB) -and ($head[2] -eq 0xBF)) `
        ("首三字节={0:X2} {1:X2} {2:X2}" -f $head[0], $head[1], $head[2])
}

# ============================================================================
# 场景 18：本次跑动没有碰用户的真实环境（凭据根 + %APPDATA% 两侧）
# ============================================================================
# 18b/18c 是场景 13/15 那个 APPDATA 覆写的负控：**覆写只该活在本进程、且用完就还**。
# 这两条没有的话，「覆写」与「把用户的 APPDATA 改了」在退出码上不可区分。
Write-Host '场景 18：真凭据根与真 %APPDATA% 的状态没被本次跑动改变'

Assert-True '18a %USERPROFILE%\.dao-secrets 的存在状态与开跑前一致（本文件不许碰它）' `
    ((Test-Path $realSecretsDir) -eq $realSecretsBefore) `
    ("before={0} after={1}" -f $realSecretsBefore, (Test-Path $realSecretsDir))
Assert-True '18b APPDATA 变量已复原成开跑前那个值（覆写只活在本进程，且用完就还）' `
    ([Environment]::GetEnvironmentVariable('APPDATA', 'Process') -eq $realAppDataBefore) `
    ("after={0}" -f [Environment]::GetEnvironmentVariable('APPDATA', 'Process'))
Assert-True '18c 真 %APPDATA%\sops\age\keys.txt 的存在状态没变（一把真私钥都没写出去）' `
    ((Test-Path $realAgeKeyPath) -eq $realAgeKeyBefore) `
    ("before={0} after={1}" -f $realAgeKeyBefore, (Test-Path $realAgeKeyPath))

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
