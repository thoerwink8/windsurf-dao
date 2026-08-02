# 条款库结构闸 · 合成夹具回归网（ccswitch/scripts/check-clauses-structure.ps1）
#
# 跑法：powershell -NoProfile -ExecutionPolicy Bypass -File tests/clause-structure.tests.ps1
#       全绿 exit 0，任一红 exit 1。
#
# ── 为什么全部用合成夹具，而不是拿真实条款库当被测对象 ────────────────────────
# ① 年龄相关的判据（候选退役区门槛、未来日期宽限窗）在真实数据上**要等三周**才第一次
#    有真命中 —— 等它等于这段代码三周零回归网。夹具用 `Get-Date` 现算偏移，把三周压成一次运行。
# ② 更硬的理由：真实条款库**此刻恰好不触发**大部分失效形态（dao.md 实测零违例）。
#    「当前数据跑不出红」与「判据是活的」是两件事，只有故意造红才分得开
#    —— 这就是「比较基线必须先验证它自己是活的」在测试侧的形态。
#
# ── 断言策略 ───────────────────────────────────────────────────────────────
# 每个判据**给正反两例**：单向断言夹不住「判据被放宽」那个方向。
# 尤其是三组「同一份夹具、两个 -ClauseSelector、结论相反」的场景（孤儿条款 / 缩进条款 /
# 丢字段）—— 那三组不是凑数，它们是**两种模式各自射程的可执行定义**：
# 没有它们，「Marked 模式检不出整条丢字段」就只是文档里的一句自陈，没人验过。

$ErrorActionPreference = 'Stop'

$RepoRoot  = Resolve-Path (Join-Path $PSScriptRoot '..')
$Checker   = Join-Path $RepoRoot 'ccswitch/scripts/check-clauses-structure.ps1'
$TmpRoot   = Join-Path ([System.IO.Path]::GetTempPath()) "windsurf-dao-clause-structure-test-$(Get-Random)"

$script:Pass = 0
$script:Fail = 0
$script:FixtureSeq = 0

function Check {
    param([string]$Name, [bool]$Cond, [string]$Detail)
    if ($Cond) { $script:Pass++; Write-Host "  PASS  $Name" }
    else { $script:Fail++; Write-Host ("  FAIL  {0}{1}" -f $Name, $(if ($Detail) { "  ->  $Detail" } else { '' })) }
}

function New-Fixture {
    <# 把夹具正文写进临时文件（UTF-8 **无 BOM**：被检对象是数据文件，
       脚本用 ReadAllLines(..., UTF8) 显式解码，不走 PS 5.1 的 ANSI 猜测）。 #>
    param([string]$Body)
    $script:FixtureSeq++
    $p = Join-Path $TmpRoot ("fx-{0}.md" -f $script:FixtureSeq)
    [System.IO.File]::WriteAllText($p, $Body, (New-Object System.Text.UTF8Encoding($false)))
    return $p
}

function Invoke-Checker {
    <# 跑一次守卫，返回 @{ Exit; Text }。**判成败只看 $LASTEXITCODE**，不看输出文案
       （中文 ErrorRecord 的「所在位置 行:X」不是真错）。 #>
    param([string]$File, [string]$Selector = 'Marked', [string]$Section = '', [int]$RetireAgeDays = 21,
          [int]$RetireListMax = 3, [string]$Ledger = '')
    $args = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $Checker,
              '-TargetFile', $File, '-ClauseSelector', $Selector,
              '-RetireAgeDays', $RetireAgeDays, '-RetireListMax', $RetireListMax)
    if (-not [string]::IsNullOrWhiteSpace($Section)) { $args += @('-SectionPattern', $Section) }
    if (-not [string]::IsNullOrWhiteSpace($Ledger)) { $args += @('-LedgerFile', $Ledger) }
    $out = & powershell @args
    return @{ Exit = $LASTEXITCODE; Text = ($out -join "`n") }
}

function New-LedgerFile {
    <# 写一份合成台账（UTF-8 无 BOM，同 New-Fixture 的理由：被读方显式按 UTF8 解码）。
       $Entries 是 slug → hashtable；file 字段由调用方给（守卫按**后缀**匹配，给文件名即可）。 #>
    param([hashtable]$Entries)
    $script:FixtureSeq++
    $p = Join-Path $TmpRoot ("ledger-{0}.json" -f $script:FixtureSeq)
    $doc = [ordered]@{ schema_version = 1; clauses = [ordered]@{} }
    foreach ($k in $Entries.Keys) { $doc.clauses[$k] = $Entries[$k] }
    # ConvertTo-Json 的 -Depth 默认 2，嵌套两层就会被截成 "System.Collections.Hashtable" 字符串
    # 而**不报错** —— 那正好是这套东西在治的静默失败，故显式给 6。
    [System.IO.File]::WriteAllText($p, ($doc | ConvertTo-Json -Depth 6), (New-Object System.Text.UTF8Encoding($false)))
    return $p
}

function New-LedgerEntry {
    param([string]$File, $N = $null, $FirstSeen = $null, $Trigger = $null,
          [bool]$JudgeOnly = $false, [string[]]$SelfAuthored = @(), $Baseline = $null, [string]$Status = 'active')
    return [ordered]@{
        file = $File; n = $N; first_seen = $FirstSeen; trigger = $Trigger
        judge_only = $JudgeOnly; self_authored = $SelfAuthored; baseline = $Baseline
        source_refs = @(); status = $Status
    }
}

# ⚠ 别把这个函数叫 `MD` —— `md` 是 PowerShell 内置的 `mkdir` 别名，`Get-MonthDay 3` 会去建一个名叫
#   `3` 的目录并把它的路径当返回值塞进夹具（本文件初版实测踩到：夹具里出现
#   `[n=1 @D:\frank\...]`，报了一堆看不懂的 missing-meta-field）。
function Get-MonthDay { param([int]$DaysAgo) return (Get-Date).Date.AddDays(-$DaysAgo).ToString('MM-dd') }

# 合法基线夹具（各场景在它之上做**单点**改动 —— 一次只动一个变量，否则红了不知道是谁红的）
function Base-Body {
    param([string]$Extra = '')
    $md = Get-MonthDay 3
    return @"
# 测试条款库

## 通用节

- **一条正常条款**：判据正文。 [n=1 @$md 触发:PR流程] [基线:合成夹具]
- **另一条**：判据正文。 [n=? @$md 触发:无] [仅判据·无触发]
$Extra
"@
}

try {
    New-Item -ItemType Directory -Path $TmpRoot -Force | Out-Null

    # ══════════════════════════════════════════════════════════════════════
    Write-Host "`n=== 负控：合法夹具两种选择器都绿（先证明基线是活的）==="
    {
        $f = New-Fixture (Base-Body)
        $m = Invoke-Checker -File $f -Selector Marked
        $a = Invoke-Checker -File $f -Selector AllTopLevel
        Check 'Marked：合法夹具 exit 0' ($m.Exit -eq 0) "exit=$($m.Exit)"
        Check 'AllTopLevel：合法夹具 exit 0' ($a.Exit -eq 0) "exit=$($a.Exit)"
        Check 'Marked：检出 2 条' ($m.Text -match '本次检出 2 条') $m.Text
        Check 'AllTopLevel：检出 2 条' ($a.Text -match '本次检出 2 条') $a.Text
    }.Invoke()

    Write-Host "`n=== 检查 1：焊接签名 。：（正例 + 围栏内负控）==="
    {
        $bad = New-Fixture (Base-Body '- **焊接的一条**。：判据正文。 [n=1 @07-27 触发:PR流程]')
        $r = Invoke-Checker -File $bad
        Check '正例：。：命中即 exit 1' ($r.Exit -eq 1) "exit=$($r.Exit)"
        Check '正例：报 welded-signature 且带行号' ($r.Text -match 'welded-signature') $r.Text

        # 负控：同样的字面写在代码围栏里（文档样例）不该误伤
        $fenced = New-Fixture (Base-Body "``````text`n反面样例：这里有一个。：焊接`n``````")
        $r2 = Invoke-Checker -File $fenced
        Check '负控：围栏内的 。： 不误伤' ($r2.Exit -eq 0) "exit=$($r2.Exit) / $($r2.Text)"
    }.Invoke()

    Write-Host "`n=== 检查 3：元字段（两种模式的射程差异 —— 本组是两种模式的可执行定义）==="
    {
        # ① 字段**写坏**（少个 @）：两种模式都该红 —— Marked 的选择器刻意用弱签名 `[n=`
        #    正是为了让这种行仍进得了扫描面。若这里 Marked 绿了，说明选择器被写成了完整字段。
        $broken = New-Fixture (Base-Body '- **字段写坏的一条**：判据。 [n=1 触发:PR流程]')
        $bm = Invoke-Checker -File $broken -Selector Marked
        $ba = Invoke-Checker -File $broken -Selector AllTopLevel
        Check 'Marked：字段写坏 → exit 1（选择器用弱签名才夹得住）' ($bm.Exit -eq 1) "exit=$($bm.Exit)"
        Check 'Marked：报 missing-meta-field' ($bm.Text -match 'missing-meta-field') $bm.Text
        Check 'AllTopLevel：字段写坏 → exit 1' ($ba.Exit -eq 1) "exit=$($ba.Exit)"

        # ② 整条**丢掉**字段：AllTopLevel 红、Marked 绿。
        #    Marked 那一半是**已知缺口的负控**——它证明脚本头注写的那句射程自陈是真的，
        #    不是客套话。哪天有人把 Marked 的选择器改强了，这一条会变红提醒他射程变了。
        $missing = New-Fixture (Base-Body '- **完全没有元字段的一条**：判据正文。')
        $ma = Invoke-Checker -File $missing -Selector AllTopLevel
        $mm = Invoke-Checker -File $missing -Selector Marked
        Check 'AllTopLevel：整条丢字段 → exit 1（真硬闸）' ($ma.Exit -eq 1) "exit=$($ma.Exit)"
        Check 'Marked：整条丢字段 → exit 0（已知缺口，射程自陈的负控）' ($mm.Exit -eq 0) "exit=$($mm.Exit)"
        Check 'Marked：把该缺口打印出来（排除行数可见）' ($mm.Text -match '未纳入检查') $mm.Text

        # ③ 触发:无 缺 [仅判据·无触发]
        $noTag = New-Fixture (Base-Body '- **缺仅判据标记**：判据。 [n=1 @07-27 触发:无]')
        $r = Invoke-Checker -File $noTag
        Check '触发:无 缺 [仅判据·无触发] → exit 1' ($r.Exit -eq 1) "exit=$($r.Exit)"
        Check '报 missing-judge-only-tag' ($r.Text -match 'missing-judge-only-tag') $r.Text
    }.Invoke()

    Write-Host "`n=== 检查 4：[观察中] 标记与所在区一致（两侧各一例）==="
    {
        $md = Get-MonthDay 3
        $inZoneNoTag = New-Fixture (@"
# 测试条款库

## 通用节

- **正常条款**：判据。 [n=1 @$md 触发:PR流程]

## 观察区（判断类候选 · 复发即升格）

- **观察区候选缺标记**：判据。 [n=1 @$md 触发:无]
"@)
        $r = Invoke-Checker -File $inZoneNoTag
        Check '观察区内缺 [观察中] → exit 1' ($r.Exit -eq 1) "exit=$($r.Exit)"
        Check '报 observation-missing-tag' ($r.Text -match 'observation-missing-tag') $r.Text

        $strayTag = New-Fixture (Base-Body "- **节外残留观察中标记**：判据。 [n=1 @$md 触发:PR流程] [观察中]")
        $r2 = Invoke-Checker -File $strayTag
        Check '观察区外残留 [观察中] → exit 1' ($r2.Exit -eq 1) "exit=$($r2.Exit)"
        Check '报 stray-observing-tag' ($r2.Text -match 'stray-observing-tag') $r2.Text

        # 负控：观察区内**带**标记且 触发:无 而**不带** [仅判据·无触发] ⇒ 合法（两标签表达同一件事）
        $ok = New-Fixture (@"
# 测试条款库

## 通用节

- **正常条款**：判据。 [n=1 @$md 触发:PR流程]

## 观察区（判断类候选 · 复发即升格）

- **合法候选**：判据。 [n=1 @$md 触发:无] [观察中]
"@)
        $r3 = Invoke-Checker -File $ok
        Check '负控：观察区带 [观察中]、豁免 [仅判据·无触发] → exit 0' ($r3.Exit -eq 0) "exit=$($r3.Exit) / $($r3.Text)"
        Check '观察区计数与条款区分开统计' ($r3.Text -match '观察中 1 条') $r3.Text
    }.Invoke()

    Write-Host "`n=== 检查 5：扫描面塌陷（这一组是整套里最承重的 —— 它防「绿得是空的」）==="
    {
        # a) zero-sample：一条都没选中
        $empty = New-Fixture "# 空条款库`n`n## 通用节`n`n没有任何条款。`n"
        $r = Invoke-Checker -File $empty
        Check 'zero-sample：零条选中 → exit 1（不许静默报绿）' ($r.Exit -eq 1) "exit=$($r.Exit)"
        Check '报 zero-sample' ($r.Text -match 'zero-sample') $r.Text

        # b) swallowed-by-section：条款被写进 📌 特殊节 ⇒ 检出集合少了它，普查看得见
        $md = Get-MonthDay 3
        $swallowed = New-Fixture (@"
# 测试条款库

## 通用节

- **正常条款**：判据。 [n=1 @$md 触发:PR流程]

## 📌 特殊节

- **被吞掉的条款**：判据。 [n=1 @$md 触发:PR流程]
"@)
        $r2 = Invoke-Checker -File $swallowed
        Check 'swallowed-by-section：📌 节内的条款签名 → exit 1' ($r2.Exit -eq 1) "exit=$($r2.Exit)"
        Check '报 swallowed-by-section' ($r2.Text -match 'swallowed-by-section') $r2.Text

        # b′) 节判定必须**锚到行首**（issue #285 的同型复发防线）：
        #     普通节标题里带装饰 📌 不该让整节脱闸。原写法 `-match '📌'` 会在这里塌陷。
        $decor = New-Fixture (@"
# 测试条款库

## 通用节 📌 重点

- **正常条款甲**：判据。 [n=1 @$md 触发:PR流程]
- **正常条款乙**：判据。 [n=2 @$md 触发:PR流程]
"@)
        $r3 = Invoke-Checker -File $decor
        Check '节标题里的装饰 📌 不该吞掉整节（锚定判据）' ($r3.Exit -eq 0) "exit=$($r3.Exit) / $($r3.Text)"
        Check '两条都检出（样本量没塌）' ($r3.Text -match '本次检出 2 条') $r3.Text

        # c) indented-clause：AllTopLevel 报、Marked 不报（同一份夹具两态）
        $indented = New-Fixture (Base-Body "  - **缩进的条款**：判据。 [n=1 @$md 触发:PR流程]")
        $ia = Invoke-Checker -File $indented -Selector AllTopLevel
        $im = Invoke-Checker -File $indented -Selector Marked
        Check 'AllTopLevel：缩进条款 → exit 1（该模式下它永远脱闸）' ($ia.Exit -eq 1) "exit=$($ia.Exit)"
        Check '报 indented-clause' ($ia.Text -match 'indented-clause') $ia.Text
        Check 'Marked：缩进条款 → exit 0 且被纳入检查（dao.md 实测 7 条这种形态）' ($im.Exit -eq 0) "exit=$($im.Exit)"
        Check 'Marked：缩进条款计入检出（3 条）' ($im.Text -match '本次检出 3 条') $im.Text
    }.Invoke()

    Write-Host "`n=== 检查 2：孤儿条款（AllTopLevel 跑 / Marked 不跑）==="
    {
        $orphan = New-Fixture (Base-Body "`n**这是一个加粗开头的孤儿段落**：它不是列表项。")
        $oa = Invoke-Checker -File $orphan -Selector AllTopLevel
        $om = Invoke-Checker -File $orphan -Selector Marked
        Check 'AllTopLevel：孤儿段落 → exit 1' ($oa.Exit -eq 1) "exit=$($oa.Exit)"
        Check '报 orphan-clause' ($oa.Text -match 'orphan-clause') $oa.Text
        Check 'Marked：孤儿段落 → exit 0（散文是该类文件的合法形态）' ($om.Exit -eq 0) "exit=$($om.Exit)"
        Check 'Marked：明说本模式不跑检查 2（不打印的跳过 = 又一个静默面）' ($om.Text -match '本模式不跑') $om.Text
    }.Invoke()

    Write-Host "`n=== 日期解析：零宽限年份回退（曾把新条款报成入库 365 天）==="
    {
        # 未来日期（比本机时钟早 1 天）：宽限窗内 ⇒ 按 0 天计，**不得**落进候选退役区
        $tomorrow = (Get-Date).Date.AddDays(1).ToString('MM-dd')
        $f = New-Fixture (@"
# 测试条款库

## 通用节

- **明天入库的条款**：判据。 [n=1 @$tomorrow 触发:PR流程]
"@)
        $r = Invoke-Checker -File $f
        Check '未来 1 天的入库日 → exit 0' ($r.Exit -eq 0) "exit=$($r.Exit)"
        Check '未来入库日不落进候选退役区（n=1 栏为 0 条）' ($r.Text -match 'n=1 且入库 >21 天）：0 条') $r.Text
        Check '未来入库日被显式打印（宽限窗吞掉真笔误的补偿面）' ($r.Text -match '入库日晚于本机时钟') $r.Text

        # 远未来（宽限窗外）：翻成去年 ⇒ 应以「入库 36x 天」现形，落进候选退役区
        $far = (Get-Date).Date.AddDays(40).ToString('MM-dd')
        $f2 = New-Fixture (@"
# 测试条款库

## 通用节

- **远未来（笔误）**：判据。 [n=1 @$far 触发:PR流程]
"@)
        $r2 = Invoke-Checker -File $f2 -RetireListMax 0
        Check '宽限窗外的未来日期翻成去年、以高龄现形' ($r2.Text -match 'n=1 且入库 >21 天）：1 条') $r2.Text
    }.Invoke()

    Write-Host "`n=== 候选退役区：门槛两态 + n=? / n=0 分栏（治「只扫 n=1 漏掉 30% 的 n=?」）==="
    {
        $d21 = Get-MonthDay 21; $d22 = Get-MonthDay 22
        $f = New-Fixture (@"
# 测试条款库

## 通用节

- **恰好 21 天（不该进）**：判据。 [n=1 @$d21 触发:PR流程]
- **满 22 天（该进）**：判据。 [n=1 @$d22 触发:PR流程]
- **n=? 且 22 天（旧实现结构性失明的那批）**：判据。 [n=? @$d22 触发:无] [仅判据·无触发]
- **n=0 且 22 天（旧实现假报成 n>=2 的那批）**：判据。 [n=0 @$d22 触发:PR流程]
- **n=2 且 22 天（不进扫描面）**：判据。 [n=2 @$d22 触发:PR流程]
"@)
        $r = Invoke-Checker -File $f -RetireListMax 0
        Check '门槛：21 天不进、22 天进 ⇒ n=1 栏恰 1 条' ($r.Text -match 'n=1 且入库 >21 天）：1 条') $r.Text
        Check 'n=? 栏 1 条（旧实现这一栏永远是 0）' ($r.Text -match 'n=\? 且入库 >21 天）：1 条') $r.Text
        Check 'n=0 栏 1 条（旧实现把它假报成 n>=2）' ($r.Text -match 'n=0 且入库 >21 天）：1 条') $r.Text
        Check 'n 分布把 n=0 与 n>=2 分开数' ($r.Text -match 'n=0 1 条' -and $r.Text -match 'n>=2 1 条') $r.Text
        Check '这些都是观察线：不影响退出码' ($r.Exit -eq 0) "exit=$($r.Exit)"

        # 门槛可调：把门槛调到 30 天，两条都不该进（证明它读的是参数不是写死的 21）
        $r2 = Invoke-Checker -File $f -RetireAgeDays 30 -RetireListMax 0
        Check '-RetireAgeDays 30 ⇒ n=1 栏 0 条（门槛真的是参数）' ($r2.Text -match 'n=1 且入库 >21 天）：0 条|n=1 且入库 >30 天）：0 条') $r2.Text
    }.Invoke()

    Write-Host "`n=== 观察区：待升格 + 久未复发三栏对称 ==="
    {
        $d22 = Get-MonthDay 22; $d3 = Get-MonthDay 3
        $f = New-Fixture (@"
# 测试条款库

## 通用节

- **正常条款**：判据。 [n=1 @$d3 触发:PR流程]

## 观察区（判断类候选 · 复发即升格）

- **复发两次，该升格了**：判据。 [n=2 @$d3 触发:无] [观察中]
- **放了 22 天没复发**：判据。 [n=1 @$d22 触发:无] [观察中]
- **次数未知且放了 22 天**：判据。 [n=? @$d22 触发:无] [观察中]
"@)
        $r = Invoke-Checker -File $f -RetireListMax 0
        Check '⬆ 待升格（n>=2）1 条' ($r.Text -match '⬆ 待升格（n>=2）：1 条') $r.Text
        Check '⏳ 久未复发 n=1 栏 1 条' ($r.Text -match '久未复发（n=1 且入库 >21 天）：1 条') $r.Text
        Check '⏳ 久未复发 n=? 栏 1 条（与条款区严格对称）' ($r.Text -match '久未复发（n=\? 且入库 >21 天）：1 条') $r.Text
        Check '⏳ 久未复发 n=0 栏也在（对称是硬要求：缺的那栏就是下一个失明处）' ($r.Text -match '久未复发（n=0 且入库 >21 天）：0 条') $r.Text
        Check '观察区条目不进条款统计（正式条款仍为 1 条）' ($r.Text -match '正式条款 1 条') $r.Text
        Check '观察线不影响退出码' ($r.Exit -eq 0) "exit=$($r.Exit)"
    }.Invoke()

    Write-Host "`n=== -SectionPattern 节白名单（正反两态）==="
    {
        $d3 = Get-MonthDay 3
        $f = New-Fixture (@"
# 测试条款库

## 甲节

- **甲节条款**：判据。 [n=1 @$d3 触发:PR流程]

## 乙节

- **乙节条款**：判据。 [n=1 @$d3 触发:PR流程]
"@)
        $all = Invoke-Checker -File $f
        Check '不传白名单 ⇒ 两节都扫（检出 2 条）' ($all.Text -match '本次检出 2 条') $all.Text
        # 闸位取舍（脚本 Test-ClausesStructure 检查 5b 那段是真相源）：**主动**缩小扫描面
        # 是操作者的选择，不是代码错 ⇒ 观察线（打印，不进退出码）；而 📌 节吞没条款是结构错
        # ⇒ 硬闸。两者在这里必须分得开，否则要么这个参数没法用、要么硬闸被静默削弱。
        $one = Invoke-Checker -File $f -Section '^##\s*甲节'
        Check '白名单只扫甲节 ⇒ 仍 exit 0（主动缩面不是错误）' ($one.Exit -eq 0) "exit=$($one.Exit) / $($one.Text)"
        Check '白名单排除面被显式打印（不许静默缩面）' ($one.Text -match '节白名单排除了 1 条') $one.Text
        Check '白名单排除面附带代价说明（那段区间的 📌 吞没检不出来）' ($one.Text -match '检不出来') $one.Text
        Check '白名单命中的那一节仍正常检出（检出 1 条）' ($one.Text -match '本次检出 1 条') $one.Text
        # 判别力：白名单不该顺手把 📌 吞没那道硬闸也关掉 —— 白名单**命中**的节里放一个
        # 📌 子节，它仍须判红（否则「传了 -SectionPattern 就全绿」）。
        $d3b = Get-MonthDay 3
        $f2 = New-Fixture (@"
# 测试条款库

## 甲节

- **甲节条款**：判据。 [n=1 @$d3b 触发:PR流程]

## 📌 甲节附属

- **被 📌 吞掉的**：判据。 [n=1 @$d3b 触发:PR流程]
"@)
        $mix = Invoke-Checker -File $f2 -Section '^##\s*(甲节|📌)'
        Check '白名单内的 📌 吞没仍判红（缩面不等于关闸）' `
            ($mix.Exit -eq 1 -and $mix.Text -match 'swallowed-by-section') "exit=$($mix.Exit) / $($mix.Text)"
    }.Invoke()

    Write-Host "`n=== AI 自定回溯面（有标记 / 零条两态）==="
    {
        $d3 = Get-MonthDay 3
        $f = New-Fixture (Base-Body "- **AI 自定的一条**：判据。 [n=1 @$d3 触发:PR流程] [自定@$d3]")
        $r = Invoke-Checker -File $f
        Check '带 [自定@…] 的条款被列出' ($r.Text -match '带 \[自定@…\] 标记：1 条') $r.Text
        $r2 = Invoke-Checker -File (New-Fixture (Base-Body))
        Check '零条时打印「0 有两种读法」（不把 0 说成"确实没有"）' `
            ($r2.Text -match '0 有两种读法') $r2.Text
    }.Invoke()

    Write-Host "`n=== 末行 marker（hook 的机器可读契约；两态都必须打）==="
    {
        # 这一组守的是**跨文件契约**：dao-scaffold-check.js 只解析这一行、不解析中文正文。
        # marker 一旦停打，消费方那边不会静默变绿 —— 它会报「跑了但没拿到 summary」，
        # 而这组断言保证的是「本脚本这一侧不会先毁约」。
        $ok = Invoke-Checker -File (New-Fixture (Base-Body))
        Check '通过时也打 marker（缺席即消费方可判的异常，不能只在失败时打）' `
            ($ok.Text -match 'CLAUSE_STRUCTURE_SUMMARY exit=0 clauses=2 violations=0') $ok.Text
        $bad = Invoke-Checker -File (New-Fixture (Base-Body '- **没有元字段**：判据。')) -Selector AllTopLevel
        Check '失败时 marker 的 exit/violations 与真退出码一致' `
            ($bad.Exit -eq 1 -and $bad.Text -match 'CLAUSE_STRUCTURE_SUMMARY exit=1 clauses=2 violations=1') "exit=$($bad.Exit) / $($bad.Text)"
        # 观察线计数也进 marker：hook 据此决定「有没有东西要端到人眼前」
        $d22 = Get-MonthDay 22
        $aged = Invoke-Checker -File (New-Fixture (@"
# 测试条款库

## 通用节

- **老条款**：判据。 [n=1 @$d22 触发:PR流程]

## 观察区（判断类候选 · 复发即升格）

- **该升格了**：判据。 [n=2 @$d22 触发:无] [观察中]
"@))
        Check 'marker 带 retire/promote 计数（观察线的机器读出端）' `
            ($aged.Text -match 'retire=1 promote=1') $aged.Text
    }.Invoke()

    Write-Host "`n=== 消费方视角：stdout 被重定向时中文不能变乱码 ==="
    {
        # 为什么单独测这一格：PS 5.1 在 stdout 被重定向时按**本机 ANSI 代码页**写出。
        # 本文件其余断言全走 PowerShell→PowerShell 捕获，那条路**恰好是好的** ⇒ 它们全绿也
        # 证明不了 node 侧读回来是对的。2026-08-01 实测：hook 用 execFileSync 读到的违规明细是
        # `�� 343������`，而**同一次运行的纯 ASCII marker 行完全正确** ——
        # 机器读的那半永远对、只有人读的那半坏掉，这正是它极易被漏掉的原因。
        $probe = Join-Path $TmpRoot 'probe-encoding.js'
        $fixture = New-Fixture (Base-Body '- **焊接的一条**。：判据正文。 [n=1 @07-27 触发:PR流程]')
        $js = @"
const { execFileSync } = require('child_process');
let out = '', code = 0;
try {
  out = execFileSync('powershell', ['-NoProfile','-ExecutionPolicy','Bypass','-File', process.argv[2],
    '-TargetFile', process.argv[3]], { encoding: 'utf8', windowsHide: true });
} catch (e) { out = (e && typeof e.stdout === 'string') ? e.stdout : ''; code = e && e.status; }
const marker = /CLAUSE_STRUCTURE_SUMMARY exit=(\d+)/.exec(out);
console.log('MARKER=' + (marker ? marker[1] : 'MISSING'));
console.log('CJK_OK=' + (out.indexOf('已知失效形态') !== -1 && out.indexOf('判据正文') !== -1));
console.log('MOJIBAKE=' + /[�]|锛|銆|馃|鈥/.test(out));
"@
        [System.IO.File]::WriteAllText($probe, $js, (New-Object System.Text.UTF8Encoding($false)))
        $probeOut = (& node $probe $Checker $fixture) -join "`n"
        Check 'node 侧拿得到 marker（exit=1）' ($probeOut -match 'MARKER=1') $probeOut
        # 断言取 FAIL 路径上**必然出现**的两段中文：脚本自己的「已知失效形态」+ 夹具正文回显。
        # 别拿只在 OK 路径出现的词当靶（初版拿「焊接签名」当靶，而 FAIL 时压根不打那行 ⇒ 恒 false）。
        Check 'node 侧读回的中文完好（FAIL 头 + 夹具正文回显都能找到）' ($probeOut -match 'CJK_OK=true') $probeOut
        Check 'node 侧无 CP936 乱码签名字（锛/銆/馃/鈥/U+FFFD）' ($probeOut -match 'MOJIBAKE=false') $probeOut
    }.Invoke()

    Write-Host "`n=== 检查 6（v2）：正文 slug ↔ 台账双向对账 ==="
    {
        # 夹具：三条条款，各覆盖一种形态 —— 双轨齐全 / 只有 slug（台账在 ledger 里）/
        # 正文里带一个**写在反引号内**的模板字面量（代码 span 假阳性的靶）。
        $md = Get-MonthDay 3
        $body = @"
# 测试条款库

## 通用节

- **甲条**：双轨齐全。 [n=1 @$md 触发:PR流程] [基线:合成甲] [#测-甲]
- **乙条**：只有 slug。 [基线:合成乙] [#测-乙]
- **丙条**：正文里写着 ``[自定@<月日>]`` 这个模板字面量（在反引号内，不该被当成真标记）。 [n=2 @$md 触发:无] [仅判据·无触发] [#测-丙]
"@
        $f = New-Fixture $body
        $leaf = Split-Path -Leaf $f
        $mkLedger = {
            param([hashtable]$Override)
            $e = [ordered]@{
                '测-甲' = New-LedgerEntry -File $leaf -N '1' -FirstSeen $md -Trigger 'PR流程' -Baseline '合成甲'
                '测-乙' = New-LedgerEntry -File $leaf -Baseline '合成乙'
                '测-丙' = New-LedgerEntry -File $leaf -N '2' -FirstSeen $md -Trigger '无' -JudgeOnly $true
            }
            if ($Override) { foreach ($k in $Override.Keys) { if ($null -eq $Override[$k]) { $e.Remove($k) } else { $e[$k] = $Override[$k] } } }
            return (New-LedgerFile -Entries $e)
        }

        # ── 负控先行：干净态必须绿，否则下面每个红都不算数 ──
        $okLedger = & $mkLedger $null
        $r = Invoke-Checker -File $f -Ledger $okLedger
        Check '负控：干净态 exit 0' ($r.Exit -eq 0) "exit=$($r.Exit) / $($r.Text)"
        Check '负控：marker 报 slugs=3 ledger=ok ledgerviol=0' ($r.Text -match 'slugs=3 ledger=ok ledgerviol=0') $r.Text
        Check '负控：只有 slug 的那条不再被判 missing-meta-field（台账可回落）' ($r.Text -notmatch 'missing-meta-field') $r.Text
        Check '正式条款 3 条（行内元字段 2 条 · 仅 slug 1 条）—— 先报分母' `
            ($r.Text -match '正式条款 3 条（行内元字段 2 条 · 仅 slug、台账在 ledger 里 1 条）') $r.Text
        Check '代码 span 假阳性负控：反引号里的 [自定@<月日>] 没被当成真标记' `
            ($r.Text -match '带 \[自定@…\] 标记：0 条') $r.Text
        Check 'v1 盲区已修：只带 [基线:] 的行进得了扫描面（本次检出 3 条）' ($r.Text -match '本次检出 3 条') $r.Text

        # ── 方向一：正文删一个 slug ⇒ missing-slug + orphan-ledger 各一 ──
        $noSlug = New-Fixture ($body -replace ' \[#测-甲\]', '')
        # 台账仍指着原夹具文件名 ⇒ 换个文件就对不上；故这一态单独造一份指向新文件名的台账。
        $leaf2 = Split-Path -Leaf $noSlug
        $l2 = New-LedgerFile -Entries ([ordered]@{
            '测-甲' = New-LedgerEntry -File $leaf2 -N '1' -FirstSeen $md -Trigger 'PR流程' -Baseline '合成甲'
            '测-乙' = New-LedgerEntry -File $leaf2 -Baseline '合成乙'
            '测-丙' = New-LedgerEntry -File $leaf2 -N '2' -FirstSeen $md -Trigger '无' -JudgeOnly $true
        })
        $r2 = Invoke-Checker -File $noSlug -Ledger $l2
        Check '正文删一个 slug ⇒ exit 1' ($r2.Exit -eq 1) "exit=$($r2.Exit)"
        Check '报 missing-slug（这一条进不了台账）' ($r2.Text -match 'missing-slug') $r2.Text
        Check '同时报 orphan-ledger（台账那条指着一个找不到的 slug）—— 两个方向各说各的' `
            ($r2.Text -match 'orphan-ledger') $r2.Text

        # ── 方向二：台账里少一条 ⇒ orphan-slug ──
        $l3 = & $mkLedger @{ '测-乙' = $null }
        $r3 = Invoke-Checker -File $f -Ledger $l3
        Check '台账删一条 ⇒ exit 1 且报 orphan-slug（指向空气的指针）' `
            ($r3.Exit -eq 1 -and $r3.Text -match 'orphan-slug') "exit=$($r3.Exit) / $($r3.Text)"

        # ── 方向三：台账值被改 ⇒ ledger-mismatch。**逐字段各验一次** ──
        foreach ($case in @(
            @{ Name = 'n';          Entry = (New-LedgerEntry -File $leaf -N '9'  -FirstSeen $md -Trigger 'PR流程' -Baseline '合成甲') },
            @{ Name = 'first_seen'; Entry = (New-LedgerEntry -File $leaf -N '1'  -FirstSeen '12-31' -Trigger 'PR流程' -Baseline '合成甲') },
            @{ Name = 'trigger';    Entry = (New-LedgerEntry -File $leaf -N '1'  -FirstSeen $md -Trigger '改配置' -Baseline '合成甲') },
            @{ Name = 'baseline';   Entry = (New-LedgerEntry -File $leaf -N '1'  -FirstSeen $md -Trigger 'PR流程' -Baseline '被改过的基线') },
            @{ Name = 'self_authored'; Entry = (New-LedgerEntry -File $leaf -N '1' -FirstSeen $md -Trigger 'PR流程' -Baseline '合成甲' -SelfAuthored @('07-09')) }
        )) {
            $lm = & $mkLedger @{ '测-甲' = $case.Entry }
            $rm = Invoke-Checker -File $f -Ledger $lm
            Check ("台账改 {0} ⇒ exit 1 且报 ledger-mismatch" -f $case.Name) `
                ($rm.Exit -eq 1 -and $rm.Text -match 'ledger-mismatch') "exit=$($rm.Exit) / $($rm.Text)"
        }
        {
            $lj = & $mkLedger @{ '测-丙' = (New-LedgerEntry -File $leaf -N '2' -FirstSeen $md -Trigger '无' -JudgeOnly $false) }
            $rj = Invoke-Checker -File $f -Ledger $lj
            Check '台账改 judge_only ⇒ 红（布尔字段也在对账面里）' `
                ($rj.Exit -eq 1 -and $rj.Text -match 'ledger-mismatch') "exit=$($rj.Exit) / $($rj.Text)"
            # 行内没写的字段而台账有值：台账替正文编了一个值，同样判红。
            $lb = & $mkLedger @{ '测-乙' = (New-LedgerEntry -File $leaf -N '3' -Baseline '合成乙') }
            $rb = Invoke-Checker -File $f -Ledger $lb
            Check '行内没写的字段而台账有值 ⇒ 红（「正文没这一栏」不等于「台账可以随便填」）' `
                ($rb.Exit -eq 1 -and $rb.Text -match 'ledger-mismatch') "exit=$($rb.Exit) / $($rb.Text)"
        }.Invoke()

        # ── 方向四：file 指错 / 一行两个 slug / status=retired / 台账不在 ──
        {
            $lf = & $mkLedger @{ '测-甲' = (New-LedgerEntry -File 'ccswitch/根本不存在的文件.md' -N '1' -FirstSeen $md -Trigger 'PR流程' -Baseline '合成甲') }
            $rf = Invoke-Checker -File $f -Ledger $lf
            Check '台账 file 指错 ⇒ 红（orphan-slug 或 ledger-file-mismatch 至少一个响）' `
                ($rf.Exit -eq 1 -and ($rf.Text -match 'ledger-file-mismatch' -or $rf.Text -match 'orphan-ledger')) "exit=$($rf.Exit) / $($rf.Text)"

            $dupFix = New-Fixture ($body -replace ' \[#测-甲\]', ' [#测-甲] [#测-又甲]')
            $leafD = Split-Path -Leaf $dupFix
            $ld = New-LedgerFile -Entries ([ordered]@{
                '测-甲' = New-LedgerEntry -File $leafD -N '1' -FirstSeen $md -Trigger 'PR流程' -Baseline '合成甲'
                '测-乙' = New-LedgerEntry -File $leafD -Baseline '合成乙'
                '测-丙' = New-LedgerEntry -File $leafD -N '2' -FirstSeen $md -Trigger '无' -JudgeOnly $true
            })
            $rd = Invoke-Checker -File $dupFix -Ledger $ld
            Check '一行两个 slug ⇒ 红且报 dup-slug（关联键必须唯一）' `
                ($rd.Exit -eq 1 -and $rd.Text -match 'dup-slug') "exit=$($rd.Exit) / $($rd.Text)"

            $lr = & $mkLedger @{ '测-已退役' = (New-LedgerEntry -File $leaf -N '1' -FirstSeen $md -Trigger '无' -JudgeOnly $true -Status 'retired') }
            $rr = Invoke-Checker -File $f -Ledger $lr
            Check 'status=retired 的条目不判孤儿（退役的定义就是正文里没有它）' `
                ($rr.Exit -eq 0 -and $rr.Text -notmatch 'orphan-ledger') "exit=$($rr.Exit) / $($rr.Text)"

            $rmiss = Invoke-Checker -File $f -Ledger (Join-Path $TmpRoot 'no-such-ledger.json')
            Check '台账不在而正文有 slug ⇒ 红 + ledger-unreadable + marker ledger=missing' `
                ($rmiss.Exit -eq 1 -and $rmiss.Text -match 'ledger-unreadable' -and $rmiss.Text -match 'ledger=missing') `
                "exit=$($rmiss.Exit) / $($rmiss.Text)"
            Check '台账不在时**不**顺带把每个 slug 都报成 orphan-slug（一个病报成三个会掩埋真因）' `
                ($rmiss.Text -notmatch 'orphan-slug') $rmiss.Text
        }.Invoke()

        # ── 不适用：零 slug 且台账里没有它 ⇒ 打印「不适用」且 exit 0（负控：不是恒红）──
        {
            $plain = New-Fixture (Base-Body)
            $rp = Invoke-Checker -File $plain -Ledger $okLedger
            Check '零 slug 语料 ⇒ exit 0 且 marker ledger=na' ($rp.Exit -eq 0 -and $rp.Text -match 'ledger=na') "exit=$($rp.Exit) / $($rp.Text)"
            Check '不适用要**打印出来**（静默跳过与「查了且没事」不可区分）' ($rp.Text -match '台账对账不适用') $rp.Text
        }.Invoke()

        # ── 台账不全（观察线，不进退出码）──
        {
            $ri = Invoke-Checker -File $f -Ledger $okLedger
            Check '台账不全 1 条被打印成观察线（[#测-乙] 缺 n/首次入库/触发点）' ($ri.Text -match '台账不全 1 条') $ri.Text
            Check '台账不全是观察线不是闸（exit 仍为 0）' ($ri.Exit -eq 0) "exit=$($ri.Exit)"
        }.Invoke()
    }.Invoke()

    # ══════════════════════════════════════════════════════════════════════
    # 遮罩规则：未闭合反引号游程（2026-08-02 反转处置）
    #
    # 缺陷原貌：旧规则「未闭合反引号 ⇒ 从它到行尾一律当代码」，于是正文里写一处
    # ```bash 这样的**写法示例**（游程长 3、无等长游程闭合）就会把**行尾元字段**遮成空格。
    # 两个后果，第二个更险：
    #   ① AllTopLevel 下该行仍被选中 ⇒ 报 missing-meta-field **假阳性**（合法条款被判红）。
    #   ② Marked 下选择器读的就是遮罩串 ⇒ 该行**整条退出扫描面**，条款数静默少一条而
    #      **退出码不变**（实测 mousse 条款库：clauses=75，实际 76，两次都 exit 0）。
    # dao.md 自己一条都不响，因为它零行含未闭合游程 —— 「守卫看不到样本」的又一实例，
    # 故下面全部用合成夹具把样本造出来。
    # ══════════════════════════════════════════════════════════════════════
    Write-Host "`n=== 遮罩：未闭合反引号游程（正控 · 两种选择器 · 两种后果）==="
    {
        $md = Get-MonthDay 3
        # 5 个字面反引号：``````bash → 3 个（游程长 3，无等长游程闭合）；``a`` → 2 个（合法 span）。
        # here-string 里反引号是转义字符，故源码里数量翻倍。
        $oddLine = "- **奇数反引号条款**：正文写了一处 ``````bash 这样的写法示例，还有 ``a`` 这种。 [n=1 @$md 触发:无] [仅判据·无触发]"

        # ── 后果①：假阳性方向（AllTopLevel）──────────────────────────────
        $f1 = New-Fixture (Base-Body $oddLine)
        $a1 = Invoke-Checker -File $f1 -Selector AllTopLevel
        Check '正控①：奇数反引号 + 行尾完整元字段，AllTopLevel 不许判红' ($a1.Exit -eq 0) "exit=$($a1.Exit) / $($a1.Text)"
        Check '正控①：不得报 missing-meta-field' ($a1.Text -notmatch 'missing-meta-field') $a1.Text

        # ── 后果②：静默少一条方向（Marked）── 断言的是**计数**不是退出码 ──
        # 这一条是本批最承重的断言：旧实现在这里 exit 也是 0，只有条款数少一条。
        # 光断言 exit 就等于没验 ——「合规」与「覆盖率在跌」正是靠这种断言区分开的。
        $m1 = Invoke-Checker -File $f1 -Selector Marked
        Check '正控②：Marked 下 exit 0' ($m1.Exit -eq 0) "exit=$($m1.Exit)"
        Check '正控②：奇数反引号那条**进得了扫描面**（检出 3 条，旧实现只有 2 条）' `
            ($m1.Text -match '本次检出 3 条') $m1.Text
        Check '正控②：marker 报 clauses=3（退出码看不出的那个差别）' ($m1.Text -match 'clauses=3') $m1.Text

        # ── 隔离态：奇数反引号那条是**唯一**一条 ⇒ 旧实现整份扫描面为空（zero-sample 红）──
        $solo = @"
# 测试条款库

## 通用节

$oddLine
"@
        $f2 = New-Fixture $solo
        foreach ($sel in @('Marked', 'AllTopLevel')) {
            $r2 = Invoke-Checker -File $f2 -Selector $sel
            Check "隔离态（$sel）：唯一一条条款仍被看见，exit 0" ($r2.Exit -eq 0) "exit=$($r2.Exit) / $($r2.Text)"
            Check "隔离态（$sel）：不得报 zero-sample" ($r2.Text -notmatch 'zero-sample') $r2.Text
            Check "隔离态（$sel）：检出 1 条" ($r2.Text -match '本次检出 1 条') $r2.Text
        }

        # ── 观察线：模糊地带要被打印出来（换掉的不该是「一种静默换另一种静默」）──
        Check '观察线：未闭合游程 + 条款签名同现被打印' `
            ($m1.Text -match '未闭合反引号游程 \+ 条款签名同现：1 行') $m1.Text
        Check '观察线是观察线不是闸（exit 仍 0）' ($m1.Exit -eq 0) "exit=$($m1.Exit)"
    }.Invoke()

    Write-Host "`n=== 遮罩：负控 —— 原本要防的代码 span 假阳性，防护必须仍在 ==="
    {
        $md = Get-MonthDay 3
        # 这一组钉的是**反转不许把旧防护一起扔掉**：闭合 span 里的模板字面量照旧不算真标记。
        # 单向断言（只验「合法条款不再被误判」）夹不住「遮罩被整个关掉」——
        # 本批实现初版正是那样：一个 return 写法把遮罩全线关成 no-op，而正控全绿。
        $body = @"
# 测试条款库

## 通用节

- **甲条**：正文写着 ``[自定@<月日>]`` 这个模板字面量（闭合 span 内，不该被当成真标记）。 [n=1 @$md 触发:PR流程] [基线:合成甲]
- **乙条**：正文写着 ``[n=9 @01-01 触发:胡编]`` 这个假元字段（闭合 span 内，不该被当成真字段）。 [n=2 @$md 触发:PR流程] [基线:合成乙]
- **丙条**：正文写着 ``[#测-不存在]`` 这个假 slug（闭合 span 内，不该被当成真 slug）。 [n=3 @$md 触发:PR流程] [基线:合成丙]
"@
        $f = New-Fixture $body
        foreach ($sel in @('Marked', 'AllTopLevel')) {
            $r = Invoke-Checker -File $f -Selector $sel
            Check "负控（$sel）：exit 0" ($r.Exit -eq 0) "exit=$($r.Exit) / $($r.Text)"
            Check "负控（$sel）：反引号里的 [自定@…] 未被当成真标记（0 条）" `
                ($r.Text -match '带 \[自定@…\] 标记：0 条') $r.Text
            Check "负控（$sel）：检出恰 3 条（假元字段没把行数撑大）" ($r.Text -match '本次检出 3 条') $r.Text
            Check "负控（$sel）：反引号里的假 slug 未进台账面（slugs=0）" ($r.Text -match 'slugs=0') $r.Text
            Check "负控（$sel）：n 分布按**行尾真字段**算（n=1/n=2/n>=2 各 1，非 n=9）" `
                ($r.Text -notmatch 'n=9') $r.Text
            Check "负控（$sel）：无未闭合游程 ⇒ 不打那条观察线" `
                ($r.Text -notmatch '未闭合反引号游程 \+ 条款签名同现') $r.Text
        }
    }.Invoke()

    Write-Host "`n=== 遮罩：让出的那一格（未闭合游程之后的模板字面量会被当真）==="
    {
        # 这不是缺陷，是**明写的取舍**：新规则让未闭合游程当字面文本，于是它之后的
        # `[自定@…]` 会被计入。把它钉成断言，是为了让这一格**将来被改动时会响** ——
        # 一个没有断言的取舍，与一个没人知道的缺陷没有区别。
        $md = Get-MonthDay 3
        $line = "- **让格条款**：一个未闭合的 ``a 之后跟着 [自定@$md] 形态的字面量。 [n=1 @$md 触发:PR流程] [基线:合成让格]"
        $f = New-Fixture (Base-Body $line)
        $r = Invoke-Checker -File $f -Selector Marked
        Check '让格：exit 0（多认一个标记不判红，只进统计）' ($r.Exit -eq 0) "exit=$($r.Exit)"
        Check '让格：该字面量被计入 [自定@…]（明写的代价，非静默）' `
            ($r.Text -match '带 \[自定@…\] 标记：1 条') $r.Text
        Check '让格：观察线把这一行指出来了（代价可见）' `
            ($r.Text -match '未闭合反引号游程 \+ 条款签名同现') $r.Text
    }.Invoke()

    Write-Host "`n=== 边界：目标文件不存在 ==="
    {
        $r = Invoke-Checker -File (Join-Path $TmpRoot 'no-such-file.md')
        Check '文件不存在 → exit 1（不静默报绿）' ($r.Exit -eq 1) "exit=$($r.Exit)"
    }.Invoke()

    Write-Host "`n=== 边界：参数名打错必须响（曾经是静默扫错对象）==="
    {
        # 没有 [CmdletBinding()] 时，PS 会把认不出的具名参数吞进 $args ⇒ -TargetFile 保持缺省
        # ⇒ 本闸转头去扫 dao.md 并报 OK。2026-08-02 实测：这正是本批缺陷一度被误判为
        # 「已修好」的那条路径 —— 扫错对象与零样本是同一类病（绿得不是那份文件）。
        $f = New-Fixture (Base-Body)
        # ⚠ 这里**不能**用 `2>&1` 收 native 命令的 stderr：PS 会把它包成 NativeCommandError，
        #   而本文件开头是 $ErrorActionPreference='Stop' ⇒ 整个测试当场中断（本条初版实测踩到）。
        #   照通用节那条的处方走 Start-Process + 真实文件重定向。
        $oFile = Join-Path $TmpRoot 'wrongparam-out.txt'
        $eFile = Join-Path $TmpRoot 'wrongparam-err.txt'
        $proc = Start-Process -FilePath 'powershell' -NoNewWindow -Wait -PassThru `
            -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $Checker, '-Path', $f) `
            -RedirectStandardOutput $oFile -RedirectStandardError $eFile
        $code = $proc.ExitCode
        # 判成败只看 ExitCode；下面读 stderr 只为断言"报了哪个参数"，不拿文案判成败。
        $errText = if (Test-Path $eFile) { [System.IO.File]::ReadAllText($eFile) } else { '' }
        $outText = if (Test-Path $oFile) { [System.IO.File]::ReadAllText($oFile) } else { '' }
        Check '参数名打错 → 非零退出（不许静默落回缺省目标）' ($code -ne 0) "exit=$code"
        Check '参数名打错 → 说清是哪个参数不认识' ($errText -match "parameter name 'Path'") $errText
        Check '参数名打错 → 压根没产出扫描报告（不是"扫了别的文件还报 OK"）' `
            ($outText -notmatch 'CLAUSE_STRUCTURE_SUMMARY') $outText
        # 负控：正确参数名照常工作（否则上面那条可以靠「什么都跑不了」蒙混过关）
        $ok = Invoke-Checker -File $f
        Check '负控：正确参数名 -TargetFile 仍 exit 0' ($ok.Exit -eq 0) "exit=$($ok.Exit)"
        Check '负控：且扫的确实是夹具（检出 2 条，不是 dao.md 的十几条）' `
            ($ok.Text -match '本次检出 2 条') $ok.Text
    }.Invoke()

    Write-Host "`n=== 真实对象冒烟：缺省目标 ccswitch/dao.md 必须绿 ==="
    {
        $out = & powershell -NoProfile -ExecutionPolicy Bypass -File $Checker
        $code = $LASTEXITCODE
        $text = ($out -join "`n")
        Check '缺省跑 dao.md → exit 0' ($code -eq 0) "exit=$code"
        Check 'dao.md 检出非零条（防「绿得是空的」）' ($text -notmatch '本次检出 0 条') $text
    }.Invoke()

} finally {
    Remove-Item -Recurse -Force $TmpRoot -ErrorAction SilentlyContinue
}

Write-Host ''
Write-Host ("==== clause-structure: {0} passed, {1} failed ====" -f $script:Pass, $script:Fail)
if ($script:Fail -gt 0) { exit 1 }
exit 0
