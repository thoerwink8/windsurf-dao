<#
.SYNOPSIS
    `ccswitch/rules/dao-workitem.md` §六「认领协议」两个核心函数（`Get-DaoMarks` /
    `Get-EffectiveClaim`）的最小回归网。退出码 0 = 全部通过。

.DESCRIPTION
    ## 为什么有这个文件（issue #198 → PR #211 → issue #215 的第三棒）

    issue #198 修法批（PR #211）合并前过了一轮独立对抗复核，结论是「不可按现状合并」：
    表格里 FAIL-5/FAIL-6 两行的「现在怎么判」宣称，实现给不出——`Get-EffectiveClaim`
    并不是「逐机器判定」，也没有「被 dao-takeover: 指名排除」；`Get-DaoMarks` 解出的
    `session` 字段传一步就被丢了。复核当时指出的第 13 条弱处（F13）是**本协议零回归网**：
    `tests/` 里没有一条断言碰过这两个函数，下一次有人改这段正则，没有任何东西会红。

    本文件补的就是这个零。**不是先把算法修好再补测试**——判据类改动铁律是「先过对抗
    复核再合并」，本批只把盘上文字改真、把已知的错误行为**钉住**（dao「撤宣称不抢修」：
    合并前只改文字撤宣称，真正的算法修法归 issue #215）。

    ## 判别力：本测试是**行为型**，不是文本匹配型

    两个被测函数**逐字节**从 `ccswitch/rules/dao-workitem.md` 提取出来跑（括号计数法，
    与 PR #211 body 里作者自己的验收脚本、以及对抗复核官自己写的独立复核脚本用的是
    同一套提取手法——三方各自实现、结果一致，这本身就是一层交叉验证）。跑的是**真函数**、
    看**真返回值**，不是拿正则去读文档的散文描述。

    ## 本文件覆盖什么、不覆盖什么（照直写，别读成「协议现在全测了」）

    **覆盖**（正例回归 + 已知缺陷的行为锚点）：
      - 幽灵拒绝三态（占位符 / 单引号机器名 / 裸标记）——PR #211 body 验收表已证为真，
        本文件把它们钉成回归，防止将来悄悄改坏
      - 3 字段 / 4 字段（含会话 id）格式解析
      - FAIL-2 验收场景复刻（真认领 + 同一条评论体里潜伏一个裸引用，只应命中真认领）
      - 「当前有效认领」两个**正确**的既有场景（G1 合法接管 / G2 yield 后置空）
      - 🔴 **已知会判错**的两个场景（G3 两机同时认领撞车判不出 / G4 被接管的死机醒来
        重发一条又被判成有效）——这两条断言的是**当前的错误返回值**，不是期望值；
        算法修好后这两条会变红，那正是「该更新这条测试了」的信号，不是本测试写错了
      - F3 源码文本 canary：`$marks +=` 组装行不含 `session`/`hours`，钉住「解析支持了，
        下一步就被扔掉」这个具体缺陷

    **不覆盖**（issue #215 弱处清单 F4-F12，本批刻意不追）：CRLF 正文致命中归零（F4）·
    `·`（U+00B7）非 ASCII 分隔符的脆弱性（F5）· 撤回只比机器名不比宿主（F6）· 三处
    「挡在门 X」归因错误（F7）· 代码块具体值示例 / HTML 注释里的幽灵未灭（F8）·
    `/dao-resume` 判断"是不是自己前任"缺判据（F9）· 字典序平局规则零实现（F10）·
    命令④空集抛异常（F11）· mousse-cli 第三份副本未同步（F12）。**别把「有了这个文件」
    读成「协议现在被测全了」**——这正是本文件自己在开头就要说清楚的事。

.NOTES
    独立可运行：powershell -NoProfile -File tests/dao-workitem-claim-protocol.tests.ps1
    退出码：0 = 全部通过；1 = 存在失败。

    不需要网络、不碰任何机器级共享状态（不读真实 `~/.claude/settings.json`、不起
    `gh` 子进程），故留在默认层（无 `@dao-test-tier: env` 标记）。

    PS 5.1 兼容：无三元运算符、无 && 链、禁 2>&1。本文件须以 BOM UTF-8 存盘（脚本文件
    本体，与下面用 `[IO.File]::ReadAllText` 读的「无 BOM 数据文件」不是同一件事，
    两者编码目标不同——见 `ccswitch/rules/dao-officer-clauses.md` 通用节「编码铁律」）。
#>

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\ccswitch\lib\console-utf8.ps1')  # pin child-stdout decode to UTF-8（issue #131）

$repoRoot = Split-Path -Parent $PSScriptRoot
$docPath  = Join-Path $repoRoot 'ccswitch/rules/dao-workitem.md'

if (-not (Test-Path $docPath)) { Write-Host "被测文档不存在：$docPath"; exit 1 }

$results = New-Object System.Collections.Generic.List[object]

function Assert-True {
    param([string]$Name, [bool]$Condition, [string]$Detail = '')
    $status = 'FAIL'
    if ($Condition) { $status = 'PASS' }
    $script:results.Add([PSCustomObject]@{ Name = $Name; Status = $status; Detail = $Detail })
    Write-Host ("  [{0}] {1} {2}" -f $status, $Name, $Detail)
}

function Get-BraceBlockSource {
    <#
      从 $Text 里找 $AnchorRegex 命中的位置，从命中位置后第一个 `{` 开始做括号计数，
      配对闭合时截断——与 PR #211 作者验收脚本、对抗复核官独立复核脚本同一手法。
      不解析字符串上下文，纯字符级计数；本文件两个被测函数体内所有花括号都在正则
      量词字面量（如 `{0,62}`）里成对出现，纯计数法足够、已实测比对字节数吻合
      （行尾归一化 LF 后 Get-DaoMarks=1365 字节 / Get-EffectiveClaim=420 字节；PR #211 body
      记录的 1386/430 是 CRLF 工作区值——入库 blob 是纯 LF，本机靠 core.autocrlf=true 才成
      CRLF，比较前归一化以免换机 autocrlf 差异假红，出处 PR #211 复核评论 B1）。
    #>
    param([string]$Text, [string]$AnchorRegex, [string]$Label)
    $m = [regex]::Match($Text, $AnchorRegex)
    if (-not $m.Success) { throw "提取失败：锚点未命中（$Label）：$AnchorRegex" }
    $braceStart = $Text.IndexOf('{', $m.Index)
    if ($braceStart -lt 0) { throw "提取失败：找不到起始花括号（$Label）" }
    $depth = 0
    for ($i = $braceStart; $i -lt $Text.Length; $i++) {
        $ch = $Text[$i]
        if ($ch -eq '{') { $depth++ }
        elseif ($ch -eq '}') {
            $depth--
            if ($depth -eq 0) { return $Text.Substring($m.Index, $i - $m.Index + 1) }
        }
    }
    throw "提取失败：花括号未闭合（$Label）"
}

Write-Host ''
Write-Host '== dao-workitem 认领协议（Get-DaoMarks / Get-EffectiveClaim）回归测试 =='
Write-Host ''

# ============================================================================
# 场景 0：提取本身（提取失败时后面全部场景都没有意义，先单独证明这一步没坏）
# ============================================================================
Write-Host '场景 0：从文档逐字节提取两个函数'

$docText = [System.IO.File]::ReadAllText($docPath, [System.Text.Encoding]::UTF8)
$daoMarksSrc = Get-BraceBlockSource -Text $docText -AnchorRegex 'function Get-DaoMarks \{' -Label 'Get-DaoMarks'
$effClaimSrc = Get-BraceBlockSource -Text $docText -AnchorRegex 'function Get-EffectiveClaim \{' -Label 'Get-EffectiveClaim'

$daoMarksLfLen = ($daoMarksSrc -replace "`r`n", "`n").Length
$effClaimLfLen = ($effClaimSrc -replace "`r`n", "`n").Length
Assert-True '0a Get-DaoMarks 提取长度（行尾归一化 LF 后 1365 字节；CRLF/LF 工作区皆成立）' `
    ($daoMarksLfLen -eq 1365) ("实测归一化后 {0} 字节（原始 {1}）" -f $daoMarksLfLen, $daoMarksSrc.Length)
Assert-True '0b Get-EffectiveClaim 提取长度（行尾归一化 LF 后 420 字节；CRLF/LF 工作区皆成立）' `
    ($effClaimLfLen -eq 420) ("实测归一化后 {0} 字节（原始 {1}）" -f $effClaimLfLen, $effClaimSrc.Length)

. ([scriptblock]::Create($daoMarksSrc))
. ([scriptblock]::Create($effClaimSrc))

Assert-True '0c 两个函数提取后成功定义（Get-Command 找得到）' `
    ((Get-Command Get-DaoMarks -ErrorAction SilentlyContinue) -and (Get-Command Get-EffectiveClaim -ErrorAction SilentlyContinue)) ''

# ============================================================================
# 场景 1：幽灵拒绝三态（PR #211 body 验收表已证为真，钉成回归防止悄悄改坏）
# ============================================================================
Write-Host '场景 1：幽灵拒绝三态'

$ghostPlaceholder = @(Get-DaoMarks -Body 'dao-claim: <HOST>/<RT>/<N>h')
Assert-True '1a 占位符幽灵（尖括号）0 命中' `
    (@($ghostPlaceholder).Count -eq 0) ("命中 {0} 条" -f @($ghostPlaceholder).Count)

$ghostQuote = @(Get-DaoMarks -Body ('dao-claim: ' + [char]39 + '/cc/4h'))
Assert-True '1b 单引号机器名幽灵 0 命中（止血复发的第三条幽灵）' `
    (@($ghostQuote).Count -eq 0) ("命中 {0} 条" -f @($ghostQuote).Count)

$ghostBare = @(Get-DaoMarks -Body ('这是一句人话，提到了裸标记 `dao-claim:` 本身，不带任何字段。'))
Assert-True '1c 裸标记（无字段）0 命中' `
    (@($ghostBare).Count -eq 0) ("命中 {0} 条" -f @($ghostBare).Count)

$ghostTable = @(Get-DaoMarks -Body ('| 示例 | `dao-claim: <H>/<R>/<N>h` | 说明 |'))
Assert-True '1d 表格单元格里的占位符引用 0 命中（不是独立成行）' `
    (@($ghostTable).Count -eq 0) ("命中 {0} 条" -f @($ghostTable).Count)

# ============================================================================
# 场景 2：字段解析（3 字段 / 4 字段含会话 id）
# ============================================================================
Write-Host '场景 2：字段解析'

$p3 = @(Get-DaoMarks -Body 'dao-claim: HOST1/cc/4h')
Assert-True '2a 3 字段：host/runtime/hours 解析正确、session 为 null' `
    ((@($p3).Count -eq 1) -and ($p3[0].host -eq 'HOST1') -and ($p3[0].runtime -eq 'cc') -and `
     ($p3[0].hours -eq '4h') -and ($null -eq $p3[0].session)) `
    ("host={0} runtime={1} hours={2} session={3}" -f $p3[0].host, $p3[0].runtime, $p3[0].hours, $p3[0].session)

$p4 = @(Get-DaoMarks -Body 'dao-claim: HOST1/cc/s1/4h')
Assert-True '2b 4 字段：session 解析出来（FAIL-6 判据要求的会话短 id）' `
    ((@($p4).Count -eq 1) -and ($p4[0].session -eq 's1') -and ($p4[0].hours -eq '4h')) `
    ("session={0} hours={1}" -f $p4[0].session, $p4[0].hours)

$pYield = @(Get-DaoMarks -Body 'dao-yield: HOST1/cc')
Assert-True '2c yield 只要求机器/宿主两格' `
    ((@($pYield).Count -eq 1) -and ($pYield[0].kind -eq 'yield')) ''

# ============================================================================
# 场景 3：FAIL-2 验收场景复刻——真认领 + 同一条评论体里潜伏一个裸引用
# ============================================================================
Write-Host '场景 3：FAIL-2 验收场景（真认领与裸引用同处一条评论体，只应命中真认领）'

$mixedBody = @'
先说一句人话：我现在开始干这张单。

dao-claim: REALBOX/cc/4h

<details>
<summary>协议格式提醒（点开看）</summary>
认领格式是首行那个 `dao-claim:`，别写错了。
</details>
'@
# 行尾归一化后再喂：本文件被 CRLF 检出时 here-string 行尾是 `r`n，dao-claim 行尾随 `r 会被
# 字段校验挡掉（真实输入 gh api 是 LF；参考实现对 CRLF 输入的健壮性缺口另记 issue #215）。
$mixed = @(Get-DaoMarks -Body ($mixedBody -replace "`r`n", "`n"))
Assert-True '3a 混合评论体只命中 1 条（真认领），裸引用被字段校验挡住' `
    (@($mixed).Count -eq 1) ("命中 {0} 条：{1}" -f @($mixed).Count, (($mixed | ForEach-Object { $_.host }) -join ','))
Assert-True '3b 命中的那一条确实是真认领（host=REALBOX）' `
    (($mixed.Count -eq 1) -and ($mixed[0].host -eq 'REALBOX')) ''

# ============================================================================
# 场景 4：「当前有效认领」正例回归（PR #211 body 宣称 PASS 的两个场景）
# ============================================================================
Write-Host '场景 4：Get-EffectiveClaim 正例（G1 合法接管 / G2 yield 后置空）'

$marksG1 = @(
    [pscustomobject]@{ kind = 'claim';    host = 'DEAD'; runtime = 'cc' },
    [pscustomobject]@{ kind = 'takeover'; host = 'NEW';  runtime = 'cc' },
    [pscustomobject]@{ kind = 'claim';    host = 'NEW';  runtime = 'cc' }
)
$g1 = Get-EffectiveClaim -Marks $marksG1
Assert-True '4a G1：claim(DEAD)→takeover(NEW)→claim(NEW) ⇒ 有效认领是 NEW' `
    (($null -ne $g1) -and ($g1.host -eq 'NEW')) ("实测 host={0}" -f $(if ($g1) { $g1.host } else { '<null>' }))

$marksG2 = @(
    [pscustomobject]@{ kind = 'claim'; host = 'A'; runtime = 'cc' },
    [pscustomobject]@{ kind = 'yield'; host = 'A'; runtime = 'cc' }
)
$g2 = Get-EffectiveClaim -Marks $marksG2
Assert-True '4b G2：claim(A)→yield(A) ⇒ 有效认领为 null（不活锁）' `
    ($null -eq $g2) ("实测 {0}" -f $(if ($g2) { $g2.host } else { '<null>' }))

# ============================================================================
# 场景 5：🔴 已知缺陷的行为锚点（issue #215 F1/F2）——断言的是「当前会判错的值」
# ============================================================================
# 这两条钉住的是**症状**，不是**期望**：算法按 issue #215 的方向修好之后，这两条会变红，
# 那正是「该来更新这条测试了」的信号——把断言的期望值换成修好后的正确答案，
# 不要读成「这个测试本身写错了」。
Write-Host '场景 5：🔴 已知缺陷回归锚点（issue #215，算法修好后这两条要更新）'

$marksG3 = @(
    [pscustomobject]@{ kind = 'claim'; host = 'BOXA'; runtime = 'cc' },
    [pscustomobject]@{ kind = 'claim'; host = 'BOXB'; runtime = 'cc' }
)
$g3 = Get-EffectiveClaim -Marks $marksG3
Assert-True '5a [issue #215-F1] G3：两机同时认领（A 早/B 晚），函数只返回全局最近一条（B）——不是逐机器判定，两边各自比较时都判不出该让位' `
    (($null -ne $g3) -and ($g3.host -eq 'BOXB')) ("实测 host={0}（这就是 bug：函数没有「这是另一台机的认领」这个视角）" -f $(if ($g3) { $g3.host } else { '<null>' }))

$marksG4 = @(
    [pscustomobject]@{ kind = 'claim';    host = 'DEAD'; runtime = 'cc' },
    [pscustomobject]@{ kind = 'takeover'; host = 'NEW';  runtime = 'cc' },
    [pscustomobject]@{ kind = 'claim';    host = 'NEW';  runtime = 'cc' },
    [pscustomobject]@{ kind = 'claim';    host = 'DEAD'; runtime = 'cc' }
)
$g4 = Get-EffectiveClaim -Marks $marksG4
Assert-True '5b [issue #215-F2] G4：被接管的死机醒来后又发一条 claim，函数把它重新判成有效（应为 NEW，"被 takeover 指名排除"没有实现）' `
    (($null -ne $g4) -and ($g4.host -eq 'DEAD')) ("实测 host={0}（这就是 bug：takeover 没有留下「谁被谁接管过」的记忆）" -f $(if ($g4) { $g4.host } else { '<null>' }))

# ============================================================================
# 场景 6：F3 源码文本 canary——`$marks +=` 组装行不含 session/hours
# ============================================================================
# 这不是行为测试，是**源码文本**测试：`Get-DaoMarks` 本身能解出 session（场景 2b 已证），
# 但 §六 命令③把结果重新组装进 `$marks` 时只拼了 4 个字段，session/hours 被丢在半路。
# 用括号计数抽函数体在这里不适用（这行代码不在任何函数里，是 §六 命令③的内联脚本），
# 改用锚定单行的正则直接抓这一行原文，逐字核对它到底拼了哪些字段。
Write-Host '场景 6：F3 源码文本 canary（$marks 组装行缺 session/hours）'

$assemblyMatch = [regex]::Match($docText, '(?m)^\s*\$marks \+= \[pscustomobject\]@\{[^\r\n]*\}')
Assert-True '6a `$marks +=` 组装行在文档里找得到（找不到说明命令③的实现形态已经变了，本断言需要跟着重写）' `
    $assemblyMatch.Success ''

if ($assemblyMatch.Success) {
    $assemblyLine = $assemblyMatch.Value
    Assert-True '6b [issue #215-F3] 组装行确实不含 session 字段（解析出来的会话 id 在这一步被扔了）' `
        (-not ($assemblyLine -match 'session')) ("原文：{0}" -f $assemblyLine.Trim())
    Assert-True '6c 组装行确实不含 hours 字段（同一个缺口，租期字段一并被扔）' `
        (-not ($assemblyLine -match 'hours')) ''
    Assert-True '6d 组装行确实拼了 createdAt/kind/host/runtime 四个字段（不是整行都没了，只是少了两个）' `
        (($assemblyLine -match 'createdAt') -and ($assemblyLine -match 'kind') -and `
         ($assemblyLine -match 'host') -and ($assemblyLine -match 'runtime')) ''
}

# ---- 汇总 -------------------------------------------------------------------
Write-Host ''
Write-Host '=============================================='
Write-Host '     dao-workitem-claim-protocol 汇总'
Write-Host '=============================================='
$failing = @($results | Where-Object { $_.Status -ne 'PASS' })
foreach ($r in $results) { Write-Host ("  {0,-6} {1}" -f $r.Status, $r.Name) }
Write-Host '=============================================='
if ($failing.Count -gt 0) {
    Write-Host ("dao-workitem-claim-protocol 失败：{0}/{1} 项未通过" -f $failing.Count, $results.Count)
    exit 1
}
Write-Host ("dao-workitem-claim-protocol 全部通过（{0} 项）。" -f $results.Count)
exit 0
