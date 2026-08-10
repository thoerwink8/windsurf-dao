<#
.SYNOPSIS
    `ccswitch/rules/dao-workitem.md` §六「认领协议」三个核心函数（`Get-DaoMarks` /
    `Get-EffectiveClaim` / `Test-IsMySessionClaim`）的最小回归网。退出码 0 = 全部通过。

.DESCRIPTION
    ## 为什么有这个文件（issue #198 → PR #211 → issue #215 的第三棒）
    issue #198 修法批（PR #211）合并前过了独立对抗复核，结论「不可按现状合并」：
    FAIL-5/FAIL-6「现在怎么判」的宣称给不出实现——`Get-EffectiveClaim` 不是「逐机器
    判定」也没有「被 dao-takeover: 指名排除」；`Get-DaoMarks` 解出的 `session` 传一步
    就被丢。复核指出第 13 条弱处（F13）：**本协议零回归网**，改坏这两个函数没有任何
    东西会红。本文件最初补的是这个零——先钉住已知错误行为，算法修法归 issue #215（dao
    「撤宣称不抢修」）。**本次（issue #215 本批）算法修法已落地**：场景 5 原钉住的
    G3/G4「已知会判错」已翻转为「钉住正确答案」——它们钉的从来是当前真实返回值，算法
    一变期望值就跟着换，这是当初写下时就说好的规则，不是本文件走样。

    ## 判别力：行为型，不是文本匹配型
    两个函数**逐字节**从 `ccswitch/rules/dao-workitem.md` 提取跑（括号计数法，与
    PR #211 作者验收脚本、对抗复核官独立复核脚本同一手法——三方独立实现、结果一致，
    本身即一层交叉验证）。跑真函数、看真返回值，不是拿正则读文档散文描述。

    ## 覆盖什么 / 不覆盖什么 / 挂了哪些账 —— 正文在**下面 dot-source 之后**那一整段行注释里
    刻意放在那儿而不是这里：`tests/ps-console-encoding.tests.js` 有一条不变量，要求每套
    `.ps1` 测试在**头 80 行内** dot-source 解码钉子（`ccswitch/lib/console-utf8.ps1`），
    而这份头注一长就把那一行挤过去。**本批就是这么被咬的**：PR #264 往 `.DESCRIPTION` 里
    补场景 9 说明，把 dot-source 从第 73 行挤到第 92 行 ⇒ merge base 绿、PR head 红
    （复抗简报 ⑤ 实测），而在那之前的三份报告都写着绿——**一次纯文档编辑改红了一道无关守卫**。
    同型先例与同一句解释见 `tests/dao-secrets.tests.ps1` 头注。**别把覆盖面清单搬回这里**：
    头注每长一行，那道守卫的余量就少一行，而它红的时候报文指向的是别的东西。

.NOTES
    独立可运行：powershell -NoProfile -File tests/dao-workitem-claim-protocol.tests.ps1
    退出码：0 全部通过；1 存在失败。不碰机器级共享状态，留在默认层（无 env 标记）。
    PS 5.1 兼容：无三元运算符、无 && 链、禁 2>&1。本文件须以 BOM UTF-8 存盘（脚本文件
    本体，与用 `[IO.File]::ReadAllText` 读的「无 BOM 数据文件」不是一回事——见
    `ccswitch/rules/dao-officer-clauses.md` 通用节「编码铁律」）。
#>

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\ccswitch\lib\console-utf8.ps1')  # pin child-stdout decode to UTF-8（issue #131）

# ════════════════════════════════════════════════════════════════════════════
# 覆盖什么、不覆盖什么、挂了哪些账（照直写，别读成「协议现在全测了」）
# —— 这一整段本来住在上面的 .DESCRIPTION 里，PR #264 返修 D 批**原样搬到这里**，
#    理由见头注最后一段（80 行窗口）。搬动只改了下面三处内容，其余逐字未动：
#    ① 场景 9 覆盖面清单由单数改为非穷尽（复抗必修 3）② 「11 条全部双向」收一格（必修 5）
#    ③ 抠取射程限定在 §六 之后，那句"字节逐个来自文档"补上它原先没写出来的前提（必修 4）
# ════════════════════════════════════════════════════════════════════════════
#
# **覆盖**：幽灵拒绝四态（占位符/单引号/裸标记混散文/裸标记独立成行）· 3/4 字段解析 ·
# FAIL-2 场景复刻（现改为**原样喂 CRLF**，验 `Get-DaoMarks` 自身的 CRLF 容忍——issue
# #215 追加发现：合并链实拦，参考实现对带 `\r` 的行尾不健壮）· G1/G2 正例（接口改为
# Hashtable）· **F1/F2 修法验证**：G3 两机同时认领现在逐机器各自可见、可正确判定
# 让位；G4 被接管死机醒来重发的 claim 不再判有效 · 三方场景（issue #215 验收标准②）·
# G9 单条-claim 边界（B3③，钉 `for` 下界 `-ge 0`，防差一退化成 `-gt 0`）· F3 canary
# 翻转为"带上 session/hours/oldHost/oldRuntime" · B3①②：租期正则放松（`0h`）/
# runtime 字符集放松（`.`）两处此前零覆盖的负控 · B3④（M3 归因订正=F7 一例复现）：
# 裸标记独立成行正控，与 1c（混散文，真正挡它的是"独立成行"行锚而非 `$rest` 空值
# 检查）区分开 · **F3"参与比较"那半**（场景 7，四轮修法新增 `Test-IsMySessionClaim`）：
# 会话一致判"是我的" / 不一致判"不是我的"（同机同宿主两个并发会话不再互认对方的认领）
# / 任一没填会话 id 时按旧行为放行（自报字段忘填的兜底）/ `$my` 为 `$null` 时判"不是我的"。
# **7g 字典序错位负控**（PR #240 返修：对抗复核 M3 实测 `-eq`→`-ge` 判等改弱时场景 7 原六条
# 全绿、零判别力——7a/7b 恰好只用了 s1/s2 这对样本，"s1" -ge "s2" 也答 False，语料只夹住了
# 它恰好含有的那两个取值；本条改用字典序错位的 s1/s0 补上这个方向）。
#
# **不覆盖**（issue #215 弱处 F5-F13，F4 CRLF 已覆盖）：`·` 分隔符脆弱性（F5，含本批
# 新增 `oldHost` 解析同样依赖它）· 撤回不比宿主（F6）· F7 另两处未复核 · 代码块/注释
# 幽灵未灭（F8）· `/dao-resume` 缺"是否自己前任"判据（F9）· 字典序平局零实现（F10）·
# 命令④空集抛异常（F11）· **F12 已销**（PR #264 对抗复核实测 `D:/frank/mousse-cli`
# HEAD `6c3aef5`，`dao-claim` 与 `Get-EffectiveClaim` 双关键词零命中 ⇒ 那个仓根本没有
# 第三份副本，不欠一次跨仓同步）。**F3 现已补上"参与比较"
# 那半**（`Test-IsMySessionClaim`，场景 7）——`Get-EffectiveClaim` 的分组键**已由 issue
# #250 扩成 `<机器名>/<宿主>`**（场景 8 就是它的覆盖面），但仍**不按 `session` 再拆细**：
# §二「认领的单位是「机器 + 宿主」」那一条写明认领单位不是单个会话，新函数只
# 解决"这条已确认的有效认领是不是我自己会话发的"，不改变碰撞判定的分组粒度本身。
# ~~**本批顺带发现但未修的一格**：`Get-EffectiveClaim` 目前也不按 `runtime` 分组（只按
# `host`）……本文件不重复覆盖~~ **issue #250 已修，场景 8 就是它的覆盖面**（15 条）：
# 分组键从 `host` 扩到 `<机器名>/<宿主>`，A2/A3/A5/B3 四种危险答案（同机另一宿主的 yield
# 杀掉自己的 claim / 同桶后发覆盖先发 / 接管连坐除名 / 跨宿主冒领续命）逐条端到端从**评论
# 正文**喂入验证，另加除名 fail-safe 的反向夹击（8c 与 8d 一对，单独任一条都夹不住那个
# `-and`）、分隔符负控（8f，专治 `{0}/{1}` 被改成 `{0}{1}`）、三条调用侧源码 canary
# （8g-1/8g-2/8h——命令③④ 是内联脚本不在函数体内，括号计数法抽不到）。
# **场景 4/5 的期望 key 因此从裸机器名改成「机器/宿主」**，那是分组键变更的直接后果。
#
# 🔴 **场景 9（PR #264 对抗复核 C 项返修）—— 上面那句"三条调用侧源码 canary"别读成
# "内联区有人管了"**：对抗官两轮换靶对内联区投放 7 发**语义**变异（分隔符漂移 / 两格
# 顺序对调 / 排除键退回裸 host / 布尔算子弱化 / 比较方向反转 / 摘 `-not` / 上一行取值
# 来源被换），**7 发全部存活、51 条断言一条没红**——8g-*/8h 守的是"token 在不在"，
# 不是语义。场景 9 改用**把内联区原文从文档抠出来真跑一遍**（不是再写一份等价表达式），
# 抠取射程**限定在 §六 那一段**（`$sixText`，见场景 0 的 0e/0f——不限定就能被上游的同型
# 围栏劫持，PR #264 复抗 X12/X12b/X21 三发实测）。
# 🔴 **「11 条断言全部双向」这个说法收一格**（复抗必修 5，原文逐字写的是"全部双向"）：
# 逐字读**不成立**——9a（占位符替换计数）与 9b（组合键取值）是**单侧**断言，没有对位反例。
# 成立的说法是「**11 条覆盖 4 个行为维度，每个维度正反两侧都有**」：让位 9d/9e（夹 `-lt`）·
# "只报不接" 9j/9k（夹 `-not`）· `$my` 9c/9i · `holders` 9h/9i；另有单侧的 9a/9b（取值来源与
# 组合键值）与 9f（`$others` 不含自己）。**比"双向"更硬的一格实证**：实现官那 10 发与复抗官
# 那 22 发的红集取并集，**9a-9k 每一条都至少红过一次**——没有哪条是写了从没被验证能红的摆设。
# 返修复抗实测：**同样 10 发（7 发语义 + 负控 + 正控 + 一发已知存活），7 发全部由
# SURVIVED 翻为 KILLED**，负控存活、正控被杀、sha256 字节级复原核对通过。
# **8b-3 / 8g-1 / 8g-2 / 8h 一条都没删**——对抗官实测坐实它们是"同一件事的两个半拉子"，
# 场景 9 是补的第三块，不是替换品。
#
# ⚠️ **场景 9 覆盖不到的格子不止一个，而且下面这份清单本身不是穷尽的**
# （PR #264 复抗简报 ③④ 实测；**全部归 issue #250 跟进面，本批不修**）：
#   · **命令③ `$marks` 组装块**（X11，最重）——`runtime = $mk.runtime` 改一行 ⇒ 五个 fixture
#     **全部 `$my = NULL`、协议整体静默失效**，而 62 条断言全绿。场景 9 从 `$eff = …` 起抠、
#     组装步骤在它上游，测试走的是自写的 `Build-MarksFromComments`（逻辑副本）⇒ 盘上那个
#     组装循环**零行为覆盖**；A5 那个原缺陷就住在同一层。
#   · **命令④ `$last`**（X7）——本场景断言的是中间量 `$holderClaims`，**下游真正消费的 `$last`
#     那一行不在抠取范围内**；`Select-Object -Last 1` 改 `-First 1` ⇒ 租约锚点倒退、提前被接管。
#   · **`$others` 的排序段**（X1）——5 个 fixture 最多只有**一个**「别人」，`Sort-Object createdAt`
#     排不排序结果一样 ⇒ 三方场景下「最早的别人」变「最晚的别人」、该让位却不让，而这正是
#     issue #193 立项要的那件事。场景 8 有三方 fixture，**场景 9 一个都没有**。
#   · **让位判据的边界与平局**：X2（`$others.Count -gt 0` → `-ge 0`，无人竞争时也判自己该让位
#     ⇒ 认领凭空消失）· X8（`-lt` → `-le`，同秒平局两边同时让位＝活锁，§四 F10 已知零实现）。
#   · 命令④ 的 kind 过滤（X6，`-eq 'claim'` → `-ne 'yield'`）· 租期计算 `[math]::Round(…)` 那一行
#     不在抠取范围 · 命令①②⑤⑥ 与 ③ 的取数行是纯 `gh`/`git` 外部调用，无从端到端覆盖。
#   · **P1**：把撤回扫描的 `release` 换成同长度死字符串（`dao-release:` 从此撤不掉任何认领，
#     Δbytes=0）⇒ **返修后仍完全存活**。精确口径不是「撤回扫描零覆盖」，是 **`yield` 有 1 条
#     行为断言（4b）、`release` 有 0 条**——复抗官另打 X16（只摘 `yield` 保留 `release`）实测 4b 当场红。
#   · 覆盖率照直报（`[#官抗-调用点覆盖率]`，复抗官量）：§六 里**可端到端覆盖**的顶层可执行单元
#     **N=18 / 跑到 M=13 / 未跑到 5 = 72%**；分母外另有 **8 条**纯 `gh`/`git` 外部调用，
#     **不报百分比、照直写「无从端到端覆盖」**。
#   🔴 **这一段原本写的是单数「场景 9 仍不覆盖的那一格」，读起来像一份穷尽清单**——复抗判词
#   点名它与上一轮治的病逐字同型（当时是「M6/M7 只有源码 canary 打得死」——对，但把结论说小了），
#   **"把结论说小"在返修批里升了一层原样复发**。故这里连清单带口径一起写，并写明清单不穷尽。
#
# **A4/A8 本批不修**（互相接管 / 自我接管 ⇒ 有效认领集合被清空，连当下合法持有人一起
# 抹掉），按 issue #250 处置建议要额外的"接管环检测"、与"不支持合法复活"那条弱处一起
# 评审——8i/8j **钉住它们当前的错误返回值当退役触发器**，修好后那两条会红。
# 🔴 **8i/8j 指向的 issue #250 刻意保持 open**：修 A2/A3/A5/B3 的那个 PR 不带自动关闭
# 关键字（对抗复核 B 项：写了它就等于在合并那一刻关掉 A4/A8 唯一的家，而"接管环检测
# 那一批"经全量筛查零命中、根本不存在）。owner=帅，解冻条件=环检测与合法复活一起评审。
# 完整描述见 `ccswitch/rules/dao-workitem.md` 开篇的五轮修法说明。
# **F2 的"指名排除"是简化处理**——一旦被指名永久除名，不支持"合法复活"这个 issue 点名
# "值得设计评审"的边界，本批未做评审。别把「有这文件」读成「协议全测了」。
# ════════════════════════════════════════════════════════════════════════════

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
      （行尾归一化 LF 后 Get-DaoMarks=2773 字节 / Get-EffectiveClaim=1117 字节；本机
      core.autocrlf=true 检出下的原始 CRLF 值是 2813/1143——比较前归一化以免换机
      autocrlf 差异假红，出处 PR #211 复核评论 B1。issue #215 批重写了两个函数体，
      这两个数字随之从旧版的 1365/420 更新为当前实测值，方法不变，只是数字变了）。

      🔴 **锚点必须在射程内唯一命中**（PR #264 复抗必修 6）：`[regex]::Match` 返回的是
      **leftmost** 命中，命中不唯一时"抠的是哪一份"没有唯一答案——上游放一份同型的诱饵，
      抠取整体挪过去，而真代码可以随便改坏、断言全绿。所以这里数命中次数、≠1 即 throw，
      并且调用方喂进来的 $Text 是**截过段的 $sixText 而不是整份文档**（见场景 0 的 0e/0f）。
    #>
    param([string]$Text, [string]$AnchorRegex, [string]$Label)
    $ms = [regex]::Matches($Text, $AnchorRegex)
    if ($ms.Count -gt 1) { throw "提取失败：锚点在射程内命中 $($ms.Count) 处、不唯一（$Label）：$AnchorRegex" }
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

# ── 抠取射程：先把 §六 那一段截出来。本文件**所有**从文档抠原文的锚点都只在这一段里求值 ──
# 🔴 为什么必须截段（PR #264 复抗 X12 / X12b / X21 三发实测，三发**全部存活** = 潜伏 fail-open）：
#    每一处抠取用的都是 `[regex]::Match` 的 **leftmost 命中**。锚点若在整份 70 KB 文档上求值，
#    只要 §六 **之前**冒出一行同型的行首文本（这份文档到处是 ```powershell 围栏与代码引用，
#    插一段"举例说明用"的旧写法完全在射程内），抠取就整体挪到诱饵上——**而 §六 那份真代码
#    可以随便改坏，62 条断言一条不红**。三发实测的形态都是「§六 真行改坏 + 上游插同型围栏」。
#    截段关住的是**诱饵与真行同处一段**的那一半：诱饵插在 §六 之外时压根不在 $sixText 里；
#    诱饵与真行同在 §六 段内时锚点命中数变 2，两个抠取函数都会 throw（Get-BraceBlockSource /
#    Get-InlineSource 各自数了命中次数），单行 canary 则由各自断言里那个「段内唯一」的合取项判红。
# 🔴 **关不住的那一半，照直写**（此处此前写的是「截段之后这一态在**结构上**不可能发生」，
#    2026-08-10 第三轮独立复抗四发实测存活、那句话已被证伪）：截段的下界判据 `(?m)^### `
#    **看不见 Markdown 代码围栏**，而 §六 整段就是一个 ```powershell 围栏。于是——
#    ① 在围栏里写一行 `### 老写法` 这样的普通 PS 注释，§六 的**下界会被提前**：诱饵留在段内、
#      真行被切到段外，**段内命中数仍是 1**、0e/0f 双双全绿，三发窗口劫持原样复活、64 条一条不红；
#    ② 诱饵与真行**只差锚点锚定前缀里的一个空格**时，抠出来跑的是完好那份、文档顺跑到底真正
#      生效的是改坏那份，段内命中数也还是 1 —— 唯一性断言这时反而发出「射程已锁死」的绿信号。
#    两态都**不是本轮新开的**（同样两发打在修法前的 dfad24d 上一样存活 = 残余不是回归），
#    截段仍是净收益：攻击面从「全文任意上游」收窄到「§六 之内 + 一行 `### `」。
#    关闭条件与两条候选修法（全文命中数 / 剥围栏）挂在 **issue #250**，owner=帅，本批刻意不抢修。
# ⚠️ **这治的是「抠到了别处的同型行」，不治「抠出来是空串」**——后者由 Get-InlineSource 的
#    throw 与 9b 管。两件事分开记，别当成一件。
# ⚠️ **射程边界照直写**：截段的判据是 `^### 六、` 到下一个 `^### `。**改了那个小节标题**、
#    或**把 §六 的代码搬到别的小节**，抠取会当场 throw（0e/0f 先红），不会静默错抠——
#    这是刻意的 fail-closed，但它意味着**本文件与文档的小节编号绑在一起**，重排小节要同批改这里。
# ⚠️ **最容易撞上的那一种，单列出来**（写给下一个编辑 dao-workitem.md 的人）：**在 §六 的代码
#    围栏里写一行 `### 什么什么` 的 PowerShell 注释，这一整套当场红**（2026-08-10 复抗 Y2 实测：
#    exit 1，只跑 2 条断言就 throw）。围栏里本来就有十几行 `#` 开头的注释，多敲一个 `#` 完全不像
#    是在动测试，而报文只会指向「截段 / 抠取失败」，不指向你刚写的那行字。想写就少敲一个 `#`。
$sixHits = [regex]::Matches($docText, '(?m)^### 六、')
Assert-True '0e §六 小节标题在全文恰好一处（截段的前提：多于一处时"抠的是哪一份"没有唯一答案；零处说明标题改了、下面全部抠取的射程无从定义）' `
    ($sixHits.Count -eq 1) ("命中 {0} 处" -f $sixHits.Count)
if ($sixHits.Count -ne 1) { throw "§六 截段失败：小节标题命中 $($sixHits.Count) 处，抠取射程无从定义" }
$sixStart = $sixHits[0].Index
$sixTail = [regex]::Match($docText.Substring($sixStart + 1), '(?m)^### ')
$sixEnd = $docText.Length
if ($sixTail.Success) { $sixEnd = $sixStart + 1 + $sixTail.Index }
$sixText = $docText.Substring($sixStart, $sixEnd - $sixStart)
Assert-True '0f §六 截出来的是全文的一个**真子段**，且下界停在下一个 `### ` 标题之前（这条是 0e 的另一半：0e 只证标题唯一，本条证截出来的东西既不是空、也没把整份文档囫囵吞下——两条都绿才谈得上"射程被限定了"）' `
    (($sixText.Length -gt 0) -and ($sixText.Length -lt $docText.Length) -and ($sixText.StartsWith('### 六、')) -and (([regex]::Matches($sixText, '(?m)^### ')).Count -eq 1)) `
    ("六段 {0} 字节 / 全文 {1} 字节" -f $sixText.Length, $docText.Length)

$daoMarksSrc = Get-BraceBlockSource -Text $sixText -AnchorRegex 'function Get-DaoMarks \{' -Label 'Get-DaoMarks'
$effClaimSrc = Get-BraceBlockSource -Text $sixText -AnchorRegex 'function Get-EffectiveClaim \{' -Label 'Get-EffectiveClaim'
$mySessionSrc = Get-BraceBlockSource -Text $sixText -AnchorRegex 'function Test-IsMySessionClaim \{' -Label 'Test-IsMySessionClaim'

$daoMarksLfLen = ($daoMarksSrc -replace "`r`n", "`n").Length
$effClaimLfLen = ($effClaimSrc -replace "`r`n", "`n").Length
$mySessionLfLen = ($mySessionSrc -replace "`r`n", "`n").Length
Assert-True '0a Get-DaoMarks 提取长度（行尾归一化 LF 后 2938 字节；PR #240 返修 R2 订正 CRLF 归一化注释后的实测值，此前为 2773，CRLF/LF 工作区皆成立）' `
    ($daoMarksLfLen -eq 2938) ("实测归一化后 {0} 字节（原始 {1}）" -f $daoMarksLfLen, $daoMarksSrc.Length)
Assert-True '0b Get-EffectiveClaim 提取长度（行尾归一化 LF 后 1602 字节；issue #250 分组粒度修法后的实测值，此前为 1117（issue #215 重写），CRLF/LF 工作区皆成立）' `
    ($effClaimLfLen -eq 1602) ("实测归一化后 {0} 字节（原始 {1}）" -f $effClaimLfLen, $effClaimSrc.Length)
Assert-True '0d Test-IsMySessionClaim 提取长度（行尾归一化 LF 后 905 字节；issue #250 返修把函数头注里"分组键仍然只按 host、这是刻意的"那句假话改真，注释在函数体内 ⇒ 字节数随之从 859 变 905。**这一格是长度 canary 的反向激励实例，照直记**：把盘上文字改真要付一次改测试期望值的代价，PR #264 对抗复核 A-1 已点名）' `
    ($mySessionLfLen -eq 905) ("实测归一化后 {0} 字节（原始 {1}）" -f $mySessionLfLen, $mySessionSrc.Length)

. ([scriptblock]::Create($daoMarksSrc))
. ([scriptblock]::Create($effClaimSrc))
. ([scriptblock]::Create($mySessionSrc))

Assert-True '0c 三个函数提取后成功定义（Get-Command 找得到）' `
    ((Get-Command Get-DaoMarks -ErrorAction SilentlyContinue) -and (Get-Command Get-EffectiveClaim -ErrorAction SilentlyContinue) -and (Get-Command Test-IsMySessionClaim -ErrorAction SilentlyContinue)) ''

# ============================================================================
# 场景 1：幽灵拒绝四态（前三态 PR #211 body 验收表已证为真；第四态 issue #215-B3④ 新增）
# ============================================================================
Write-Host '场景 1：幽灵拒绝四态'

$ghostPlaceholder = @(Get-DaoMarks -Body 'dao-claim: <HOST>/<RT>/<N>h')
Assert-True '1a 占位符幽灵（尖括号）0 命中' `
    (@($ghostPlaceholder).Count -eq 0) ("命中 {0} 条" -f @($ghostPlaceholder).Count)

$ghostQuote = @(Get-DaoMarks -Body ('dao-claim: ' + [char]39 + '/cc/4h'))
Assert-True '1b 单引号机器名幽灵 0 命中（止血复发的第三条幽灵）' `
    (@($ghostQuote).Count -eq 0) ("命中 {0} 条" -f @($ghostQuote).Count)

$ghostBare = @(Get-DaoMarks -Body ('这是一句人话，提到了裸标记 `dao-claim:` 本身，不带任何字段。'))
Assert-True '1c 裸标记混在散文里 0 命中（真正挡住它的是"独立成行"这道行锚，见 1e 的归因区分）' `
    (@($ghostBare).Count -eq 0) ("命中 {0} 条" -f @($ghostBare).Count)

$ghostTable = @(Get-DaoMarks -Body ('| 示例 | `dao-claim: <H>/<R>/<N>h` | 说明 |'))
Assert-True '1d 表格单元格里的占位符引用 0 命中（不是独立成行）' `
    (@($ghostTable).Count -eq 0) ("命中 {0} 条" -f @($ghostTable).Count)

$ghostBareLine = @(Get-DaoMarks -Body '`dao-claim:`')
Assert-True '1e [issue #215-B3④，M3 归因订正=F7 一例复现] 裸标记独立成行时才真正触地"$rest 为空"那道守卫——1c 的输入从未走到这道检查（字段计数校验对空 rest 同样会拒，是它先挡的），本例把裸标记单独放一行，两道门都会拦，是当前唯一同时覆盖这道门的正控' `
    (@($ghostBareLine).Count -eq 0) ("命中 {0} 条" -f @($ghostBareLine).Count)

# ============================================================================
# 场景 2：字段解析（3 字段 / 4 字段含会话 id）+ B3①②两处变异盲区负控
# ============================================================================
Write-Host '场景 2：字段解析 + B3①②负控'

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

$badHours = @(Get-DaoMarks -Body 'dao-claim: HOST1/cc/0h')
Assert-True '2d [issue #215-B3①] 租期字段 "0h" 被拒——正则 `^[1-9][0-9]?h$` 首位不含 0，这条负控守住"租期字段正则放松零红"这个此前的变异盲区' `
    (@($badHours).Count -eq 0) ("命中 {0} 条" -f @($badHours).Count)

$badRuntime = @(Get-DaoMarks -Body 'dao-claim: HOST1/c.c/4h')
Assert-True '2e [issue #215-B3②] runtime 字段 "c.c" 被拒——字符集正则 `^[A-Za-z0-9_-]{1,20}$` 不含 `.`，这条负控守住"runtime 字符集放松零红"这个此前的变异盲区' `
    (@($badRuntime).Count -eq 0) ("命中 {0} 条" -f @($badRuntime).Count)

# ============================================================================
# 场景 3：FAIL-2 验收场景复刻 + CRLF 正控（issue #215 追加评论：合并链实拦发现）
# ============================================================================
Write-Host '场景 3：FAIL-2 验收场景（真认领与裸引用同处一条评论体，只应命中真认领）+ CRLF 原样喂入正控'

$mixedBody = @'
先说一句人话：我现在开始干这张单。

dao-claim: REALBOX/cc/4h

<details>
<summary>协议格式提醒（点开看）</summary>
认领格式是首行那个 `dao-claim:`，别写错了。
</details>
'@
# issue #215 追加评论（合并链实拦发现）：参考实现原本对 CRLF 输入不健壮，行尾带 `\r` 时
# 字段校验把真认领挡掉；旧版测试靠"测试侧先归一化"止血，掩盖了这个缺陷。`Get-DaoMarks`
# 现在自己在入口做 CRLF/裸 CR 归一化（split 前），所以这里改为**原样喂 CRLF、不做任何
# 预处理**——这是对函数自身 CRLF 容忍的正控，不是对"测试侧写得够小心"的正控。显式构造
# CRLF（先收敛已有换行到 LF，再统一展开成 CRLF）而不是依赖本文件在磁盘上的行尾约定，
# 这样换一台 autocrlf 设置不同的机器也不会让这条正控悄悄失去意义。
$mixedBodyCRLF = ($mixedBody -replace "`r`n", "`n") -replace "`n", "`r`n"
$mixed = @(Get-DaoMarks -Body $mixedBodyCRLF)
Assert-True '3a [issue #215 CRLF 容忍修法] 混合评论体（CRLF 原样喂入）只命中 1 条（真认领），裸引用被字段校验挡住' `
    (@($mixed).Count -eq 1) ("命中 {0} 条：{1}" -f @($mixed).Count, (($mixed | ForEach-Object { $_.host }) -join ','))
Assert-True '3b 命中的那一条确实是真认领（host=REALBOX）' `
    (($mixed.Count -eq 1) -and ($mixed[0].host -eq 'REALBOX')) ''

# ============================================================================
# 场景 4：「当前有效认领」正例回归（G1 合法接管 / G2 yield 后置空）——接口已改为 Hashtable
# ============================================================================
Write-Host '场景 4：Get-EffectiveClaim 正例（G1 合法接管 / G2 yield 后置空，Hashtable 接口）'

$marksG1 = @(
    [pscustomobject]@{ kind = 'claim';    host = 'DEAD'; runtime = 'cc' },
    [pscustomobject]@{ kind = 'takeover'; host = 'NEW';  runtime = 'cc'; oldHost = 'DEAD'; oldRuntime = 'cc' },
    [pscustomobject]@{ kind = 'claim';    host = 'NEW';  runtime = 'cc' }
)
$g1 = Get-EffectiveClaim -Marks $marksG1
Assert-True '4a G1：claim(DEAD)→takeover(NEW,指名 DEAD/cc)→claim(NEW) ⇒ 有效认领集合只剩 NEW/cc 一个 key（DEAD/cc 因被指名除名，F2 修法；issue #250 后 key 是「机器/宿主」不再是裸机器名）' `
    (($g1.Count -eq 1) -and $g1.ContainsKey('NEW/cc') -and ($g1['NEW/cc'].kind -eq 'claim')) ("keys={0}" -f (@($g1.Keys) -join ','))

$marksG2 = @(
    [pscustomobject]@{ kind = 'claim'; host = 'A'; runtime = 'cc' },
    [pscustomobject]@{ kind = 'yield'; host = 'A'; runtime = 'cc' }
)
$g2 = Get-EffectiveClaim -Marks $marksG2
Assert-True '4b G2：claim(A)→yield(A) ⇒ 有效认领集合为空（不活锁）' `
    ($g2.Count -eq 0) ("count={0}" -f $g2.Count)

# ============================================================================
# 场景 5：F1/F2 算法修法验证——原 G3/G4「已知缺陷锚点」翻转为正例 + G9 边界 + 三方场景
# ============================================================================
# 这三条钉住的是修好之后的**正确返回值**。它们的前身（issue #215 立项时的 5a/5b）钉住的是
# 当时的**错误返回值**，且当初就写明"算法修好后这两条会变红，那是该更新的信号"——现在正是
# 那个更新动作：期望值换成正确答案，断言的名字与出处标注保留，方便追溯这条测试的历史。
Write-Host '场景 5：F1/F2 修法验证（G3/G4 翻转为正例）+ G9 单条-claim 边界 + 三方场景'

$marksG3 = @(
    [pscustomobject]@{ kind = 'claim'; host = 'BOXA'; runtime = 'cc'; createdAt = '2026-08-09T01:00:00Z' },
    [pscustomobject]@{ kind = 'claim'; host = 'BOXB'; runtime = 'cc'; createdAt = '2026-08-09T01:00:30Z' }
)
$g3 = Get-EffectiveClaim -Marks $marksG3
Assert-True '5a [issue #215-F1 已修，原缺陷锚点翻转] G3：两机同时认领（A 早/B 晚），函数现在逐桶分别返回——两个「机器/宿主」桶都在结果集合里，各自都能看到"我自己的有效认领"' `
    (($g3.Count -eq 2) -and $g3.ContainsKey('BOXA/cc') -and $g3.ContainsKey('BOXB/cc')) ("keys={0}" -f (@($g3.Keys) -join ','))
Assert-True '5a-2 [issue #215-F1] G3 补证：调用方拿这份逐桶结果做跨机比较，能正确判定 BOXA 更早（该让位的是 BOXB，不再是"两边都留着"或"都判不出"）' `
    ($g3['BOXA/cc'].createdAt -lt $g3['BOXB/cc'].createdAt) ("BOXA/cc={0} BOXB/cc={1}" -f $g3['BOXA/cc'].createdAt, $g3['BOXB/cc'].createdAt)

$marksG4 = @(
    [pscustomobject]@{ kind = 'claim';    host = 'DEAD'; runtime = 'cc' },
    [pscustomobject]@{ kind = 'takeover'; host = 'NEW';  runtime = 'cc'; oldHost = 'DEAD'; oldRuntime = 'cc' },
    [pscustomobject]@{ kind = 'claim';    host = 'NEW';  runtime = 'cc' },
    [pscustomobject]@{ kind = 'claim';    host = 'DEAD'; runtime = 'cc' }
)
$g4 = Get-EffectiveClaim -Marks $marksG4
Assert-True '5b [issue #215-F2 已修，原缺陷锚点翻转] G4：被接管的死机醒来后又发一条 claim，函数不再把它判成有效——结果集合只剩 NEW/cc 一个 key，DEAD/cc 除名' `
    (($g4.Count -eq 1) -and $g4.ContainsKey('NEW/cc') -and (-not $g4.ContainsKey('DEAD/cc'))) ("keys={0}" -f (@($g4.Keys) -join ','))

$marksG9 = @([pscustomobject]@{ kind = 'claim'; host = 'SOLO'; runtime = 'cc' })
$g9 = Get-EffectiveClaim -Marks $marksG9
Assert-True '5c [issue #215-B3③] G9 单条-claim 边界：只有一条标记时函数仍要找到它——钉住内层 for 循环下界 `-ge 0`，防止"差一"退化成 `-gt 0`（那样单条数组的循环体会一次都不执行，此前回归网里没有任何断言能抓这个差异，唯独这个单条场景能）' `
    (($g9.Count -eq 1) -and $g9.ContainsKey('SOLO/cc') -and ($g9['SOLO/cc'].host -eq 'SOLO')) ("keys={0}" -f (@($g9.Keys) -join ','))

$marksG7 = @(
    [pscustomobject]@{ kind = 'claim'; host = 'X'; runtime = 'cc'; createdAt = '2026-08-09T01:00:00Z' },
    [pscustomobject]@{ kind = 'claim'; host = 'Y'; runtime = 'cc'; createdAt = '2026-08-09T01:00:10Z' },
    [pscustomobject]@{ kind = 'claim'; host = 'Z'; runtime = 'cc'; createdAt = '2026-08-09T01:00:20Z' }
)
$g7 = Get-EffectiveClaim -Marks $marksG7
Assert-True '5d [issue #215 验收标准②「至少补一个三方场景」] 三台机各自的有效认领同时可见，不只两台机时才成立' `
    (($g7.Count -eq 3) -and $g7.ContainsKey('X/cc') -and $g7.ContainsKey('Y/cc') -and $g7.ContainsKey('Z/cc')) ("keys={0}" -f (@($g7.Keys) -join ','))

# ============================================================================
# 场景 6：F3 源码文本 canary——`$marks +=` 组装行现在带上 session/hours/oldHost/oldRuntime
# ============================================================================
# 这不是行为测试，是**源码文本**测试：`Get-DaoMarks` 本身能解出 session（场景 2b 已证），
# 此前 §六 命令③把结果重新组装进 `$marks` 时只拼了 4 个字段，session/hours 被丢在半路
# （原缺陷）。issue #215 本批把组装行补上了 session/hours（F3），以及 F2 需要的
# oldHost/oldRuntime——这条 canary 现在钉住"这些字段都在"，是原断言的翻转版本。
# 用括号计数抽函数体在这里不适用（这行代码不在任何函数里，是 §六 命令③的内联脚本），
# 改用锚定单行的正则直接抓这一行原文，逐字核对它到底拼了哪些字段。
Write-Host '场景 6：F3 源码文本 canary（$marks 组装行现在带上 session/hours/oldHost/oldRuntime）'

$assemblyPat = '(?m)^\s*\$marks \+= \[pscustomobject\]@\{[^\r\n]*\}'
$assemblyMatch = [regex]::Match($sixText, $assemblyPat)
Assert-True '6a `$marks +=` 组装行在 §六 里找得到、且**段内恰好一处**（找不到说明命令③的实现形态已经变了，本断言需要跟着重写；不止一处则"抠的是哪一份"没有唯一答案——射程与唯一性两件事见 0e/0f，PR #264 复抗必修 6）' `
    ($assemblyMatch.Success -and (([regex]::Matches($sixText, $assemblyPat)).Count -eq 1)) ("段内命中 {0} 处" -f ([regex]::Matches($sixText, $assemblyPat)).Count)

if ($assemblyMatch.Success) {
    $assemblyLine = $assemblyMatch.Value
    Assert-True '6b [issue #215-F3 已修，原缺陷锚点翻转] 组装行现在带上了 session 字段（解析出来的会话 id 不再半路被扔）' `
        ($assemblyLine -match 'session') ("原文：{0}" -f $assemblyLine.Trim())
    Assert-True '6c [issue #215-F3 已修] 组装行现在带上了 hours 字段（同一个缺口，租期字段一并补回）' `
        ($assemblyLine -match 'hours') ''
    Assert-True '6d 组装行确实拼了 createdAt/kind/host/runtime 四个原有字段（新增字段没有挤掉旧字段）' `
        (($assemblyLine -match 'createdAt') -and ($assemblyLine -match 'kind') -and `
         ($assemblyLine -match 'host') -and ($assemblyLine -match 'runtime')) ''
    Assert-True '6e [issue #215-F2；issue #250 已补上消费侧] 组装行带上了 oldHost/oldRuntime。~~两个字段命运不同：`oldRuntime` 全仓 0 个消费点，除名逻辑只看 oldHost~~ **issue #250 修法后两格都被读了**：除名键是 `oldHost/oldRuntime` 拼出来的桶名，缺任一格都不除名（见 8c/8d 两条行为断言）。这条 canary 仍然只证明"两个字段都拼进了组装行"，**不证明"两个字段都被下游用到"**——证那件事的是 8c/8d，别拿这条顶替' `
        (($assemblyLine -match 'oldHost') -and ($assemblyLine -match 'oldRuntime')) ''
}

# ============================================================================
# 场景 7：Test-IsMySessionClaim（issue #215-F3 四轮修法——"参与比较"那半的实现）
# ============================================================================
# F3 前三轮只做到"session/hours 数据不丢"（场景 6），dao-resume.md「先比对会话 id」依旧没有
# 代码可跑。本场景测的是补上的那半：给定 Get-EffectiveClaim 算出的某个 host 的有效认领 $my
# 与本会话自报的 $MySession，函数要答"这条有效认领是不是我自己这个会话发的"。
Write-Host '场景 7：Test-IsMySessionClaim（F3"参与比较"实现）'

$claimWithSession = [pscustomobject]@{ kind = 'claim'; host = 'HOST1'; runtime = 'cc'; session = 's1'; createdAt = '2026-08-09T01:00:00Z' }
$claimNoSession = [pscustomobject]@{ kind = 'claim'; host = 'HOST1'; runtime = 'cc'; session = $null; createdAt = '2026-08-09T01:00:00Z' }

Assert-True '7a 会话 id 一致 ⇒ 判定为"是我自己的"' `
    (Test-IsMySessionClaim -my $claimWithSession -MySession 's1') ''

Assert-True '7b 会话 id 不一致 ⇒ 判定为"另一个并发会话的"，不是我自己的（这正是 F3 要堵的洞：同机同宿主两个会话不再互相把对方的认领当自己的）' `
    (-not (Test-IsMySessionClaim -my $claimWithSession -MySession 's2')) ''

Assert-True '7c $my 没有 session（3 字段旧格式，单会话场景）⇒ 无数据可比，按旧行为放行（不拦）——这不是新洞，是把旧洞的边界从"完全没有判据"改成"有判据但要求自报配合"' `
    (Test-IsMySessionClaim -my $claimNoSession -MySession 's1') ''

Assert-True '7d 调用方没传 $MySession（空串/未填）⇒ 同样无数据可比，按旧行为放行' `
    (Test-IsMySessionClaim -my $claimWithSession -MySession '') ''

Assert-True '7e $my 为 $null（这台 host 没有有效认领，如 §六 $eff[$MyHost] 查不到）⇒ 不是"我的"，返回 $false' `
    (-not (Test-IsMySessionClaim -my $null -MySession 's1')) ''

Assert-True '7f 两边都没有会话 id（纯单会话协议场景，历史行为）⇒ 放行，不因为新函数的存在就要求所有场景都填会话 id' `
    (Test-IsMySessionClaim -my $claimNoSession -MySession '') ''

Assert-True '7g 字典序错位负控（PR #240 对抗复核 M3：判等 `-eq` 被悄悄改弱成 `-ge` 时，7a/7b 只用 s1/s2 这一对样本、恰好使 `-ge` 也答对，34/34 全绿、零判别力——存活探针实测 s1-vs-s0 时 `-ge` 答 True 而正确答案是 False，方向 fail-open：会替别的会话续命）。my.session="s1"、MySession="s0"（字典序 s0 < s1）⇒ 不相等，判定不是我的；若判等被换成 `-ge`，"s1" -ge "s0" 为真，会被误判成"是我的"，这条断言专治这个方向' `
    (-not (Test-IsMySessionClaim -my $claimWithSession -MySession 's0')) ''

# ============================================================================
# 场景 8：issue #250 —— 分组粒度从 host 扩到「机器+宿主」（双栈同机 cc/codex 并桶）
# ============================================================================
# 本仓自己声明是双栈仓（CLAUDE.md：cc 与 Codex 共存），同机两个 AI 宿主认领同一张单是真实
# 形态。§二 早就写明「认领的单位是「机器 + 宿主」」，而 `Get-EffectiveClaim` 此前只按 host
# 分组 —— **实现与它自己已经写下的判据不一致**，这是本场景的性质：不是新立一条规矩，是把
# 实现拉回已声明的单位（照做档）。
# 8a-8c 刻意**从评论正文端到端喂**（Get-DaoMarks → 组装 → Get-EffectiveClaim），不是手搭
# 对象：手搭对象绕过解析层，而 A5 的 oldHost/oldRuntime 恰恰产在解析层。
Write-Host '场景 8：issue #250 分组粒度（机器+宿主）'

function Build-MarksFromComments {
    # §六 命令③ 的组装步骤同构：一条评论可产出多个机器面标记，按 GitHub 盖的时间戳排序
    param($Comments)
    $out = @()
    foreach ($cm in $Comments) {
        foreach ($mk in (Get-DaoMarks -Body $cm.body)) {
            $out += [pscustomobject]@{ createdAt = $cm.createdAt; kind = $mk.kind; host = $mk.host; runtime = $mk.runtime; session = $mk.session; hours = $mk.hours; oldHost = $mk.oldHost; oldRuntime = $mk.oldRuntime }
        }
    }
    return @($out | Sort-Object createdAt)
}

# --- A2：同机另一个宿主的 dao-yield: 不得撤销自己的 claim ---------------------
$marksA2 = Build-MarksFromComments @(
    [pscustomobject]@{ createdAt = '2026-08-09T01:00:00Z'; body = "开始干这单。`n`ndao-claim: HOST1/cc/4h" },
    [pscustomobject]@{ createdAt = '2026-08-09T01:01:00Z'; body = "codex 那边的活收了。`n`ndao-yield: HOST1/codex" }
)
$a2 = Get-EffectiveClaim -Marks $marksA2
Assert-True '8a [issue #250-A2] HOST1/cc 认领后 HOST1/codex 撤回 ⇒ cc 的认领仍然有效（修法前：两个宿主并进同一个 host 桶，codex 的 yield 把 cc 的 claim 一起杀掉，有效认领集合变空 —— 方向是"认领凭空消失"，比误报更危险）' `
    (($a2.Count -eq 1) -and $a2.ContainsKey('HOST1/cc') -and ($a2['HOST1/cc'].runtime -eq 'cc')) ("keys={0}" -f (@($a2.Keys) -join ','))

# --- A3：同机两个宿主各认领一次 ⇒ 两个独立的桶，先发的那个胜 -----------------
$marksA3 = Build-MarksFromComments @(
    [pscustomobject]@{ createdAt = '2026-08-09T01:00:00Z'; body = 'dao-claim: HOST1/cc/4h' },
    [pscustomobject]@{ createdAt = '2026-08-09T01:03:00Z'; body = 'dao-claim: HOST1/codex/4h' }
)
$a3 = Get-EffectiveClaim -Marks $marksA3
Assert-True '8b [issue #250-A3] 同机 cc/codex 各认领一次 ⇒ 两个桶都在，谁都没被对方覆盖（修法前：并进一个 host 桶、后发的 codex 覆盖先发的 cc，cc 的租约凭空消失）' `
    (($a3.Count -eq 2) -and $a3.ContainsKey('HOST1/cc') -and $a3.ContainsKey('HOST1/codex')) ("keys={0}" -f (@($a3.Keys) -join ','))
Assert-True '8b-2 [issue #250-A3] 补证：两个桶可比较，cc 更早 ⇒ 该让位的是 codex（§四「谁该让位」在同机跨宿主这一格现在也答得出来，不再是"看不见另一半"）' `
    ($a3['HOST1/cc'].createdAt -lt $a3['HOST1/codex'].createdAt) ("cc={0} codex={1}" -f $a3['HOST1/cc'].createdAt, $a3['HOST1/codex'].createdAt)

# --- A3 后半：命令④ 的租期锚点也要按「机器+宿主」过滤 -----------------------
$myHostA3 = 'HOST1'; $myRuntimeA3 = 'cc'
$holderClaimsA3 = @($marksA3 | Where-Object { $_.kind -eq 'claim' -and $_.host -eq $myHostA3 -and $_.runtime -eq $myRuntimeA3 })
Assert-True '8b-3 [issue #250-A3 后半] 命令④ 租期锚点按「机器+宿主」过滤后取到的是 cc 自己那条（01:00），不是同机 codex 后发的那条（01:03）——只按 host 过滤时租期会从别人那条算起' `
    ((($holderClaimsA3 | Select-Object -Last 1).createdAt) -eq '2026-08-09T01:00:00Z') ("锚点={0}" -f ($holderClaimsA3 | Select-Object -Last 1).createdAt)

# --- A5：接管指名 BOXA/codex ⇒ 只除名那一个桶，BOXA/cc 不连坐 ---------------
$marksA5 = Build-MarksFromComments @(
    [pscustomobject]@{ createdAt = '2026-08-09T01:00:00Z'; body = 'dao-claim: BOXA/cc/4h' },
    [pscustomobject]@{ createdAt = '2026-08-09T01:01:00Z'; body = 'dao-claim: BOXA/codex/4h' },
    [pscustomobject]@{ createdAt = '2026-08-09T01:05:00Z'; body = ('dao-takeover: NEW/cc ' + [char]0x00B7 + ' 原认领 BOXA/codex 静默 9h') },
    [pscustomobject]@{ createdAt = '2026-08-09T01:06:00Z'; body = 'dao-claim: NEW/cc/4h' }
)
Assert-True '8c-0 [前提] 接管评论的 oldHost/oldRuntime 两格都从解析层拿到了（拿不到则 8c 恒绿而无判别力——除名压根没发生也会让 BOXA/cc 活着）' `
    ((@($marksA5 | Where-Object { $_.kind -eq 'takeover' })[0].oldHost -eq 'BOXA') -and (@($marksA5 | Where-Object { $_.kind -eq 'takeover' })[0].oldRuntime -eq 'codex')) ''
$a5 = Get-EffectiveClaim -Marks $marksA5
Assert-True '8c [issue #250-A5] 接管指名 BOXA/codex ⇒ 只有 BOXA/codex 被除名，BOXA/cc 保住自己的认领、NEW/cc 是新持有人（修法前：除名逻辑只读 oldHost，整台 BOXA 连坐除名，把一个合法持有人一起抹掉）' `
    (($a5.Count -eq 2) -and $a5.ContainsKey('BOXA/cc') -and $a5.ContainsKey('NEW/cc') -and (-not $a5.ContainsKey('BOXA/codex'))) ("keys={0}" -f (@($a5.Keys) -join ','))

# --- 除名的 fail-safe 方向：缺一格就不除名 -----------------------------------
$marksA5b = @(
    [pscustomobject]@{ kind = 'claim';    host = 'BOXA'; runtime = 'codex'; createdAt = '2026-08-09T01:00:00Z' },
    [pscustomobject]@{ kind = 'takeover'; host = 'NEW';  runtime = 'cc'; oldHost = 'BOXA'; oldRuntime = $null; createdAt = '2026-08-09T01:05:00Z' }
)
$a5b = Get-EffectiveClaim -Marks $marksA5b
Assert-True '8d [issue #250 除名 fail-safe] 接管只解出 oldHost、oldRuntime 缺失时**不除名**（宁可漏排除不误排除，与 §三"拿不准就当它还被持有"同向）。这条同时是 8c 的反向夹击：若把除名判据写成"只要 oldHost 命中就整台除名"，8c 会红；若写成"两格都不看、从不除名"，本条绿而 8c 红 —— 两条一起才夹得住那个 `-and`' `
    (($a5b.Count -eq 2) -and $a5b.ContainsKey('BOXA/codex') -and $a5b.ContainsKey('NEW/cc')) ("keys={0}" -f (@($a5b.Keys) -join ','))

# 8d 单独夹不住除名条件里的 `-and $mk.oldRuntime` 那一格：oldRuntime 为 $null 时拼出来的
# 键是 "BOXA/"，而**解析层产出的桶键第二格恒非空**（§二 字符集要求 runtime 至少一个字符），
# 所以有没有那道守卫，8d 的结果一模一样 —— 变异体存活。要真夹住它，得让一个桶的键恰好
# 就是 "BOXA/"，也就是 runtime 为空的那种（手搭对象才造得出，Get-DaoMarks 产不出来）。
# 这条因此是**防御性守卫的判别力测试**，不是真实输入形态；照直标注，别读成"这是会发生的"。
$marksA5c = @(
    [pscustomobject]@{ kind = 'claim';    host = 'BOXA'; runtime = ''; createdAt = '2026-08-09T01:00:00Z' },
    [pscustomobject]@{ kind = 'takeover'; host = 'NEW';  runtime = 'cc'; oldHost = 'BOXA'; oldRuntime = $null; createdAt = '2026-08-09T01:05:00Z' }
)
$a5c = Get-EffectiveClaim -Marks $marksA5c
Assert-True '8d-2 [issue #250 除名守卫的判别力] runtime 为空的桶（键恰好是 "BOXA/"）遇上只有 oldHost 的接管：有 `-and $mk.oldRuntime` 这道守卫时不除名，去掉它就会被 "BOXA/" 这个拼串误伤除名。8d 覆盖的是**结果**，本条覆盖的是**那个 `-and` 本身**——两条缺一，去掉守卫的变异体就活着' `
    (($a5c.Count -eq 2) -and $a5c.ContainsKey('BOXA/') -and $a5c.ContainsKey('NEW/cc')) ("keys={0}" -f (@($a5c.Keys) -join ','))

# --- B3：跨宿主冒领 ------------------------------------------------------------
$marksB3 = Build-MarksFromComments @(
    [pscustomobject]@{ createdAt = '2026-08-09T01:00:00Z'; body = 'dao-claim: HOST1/codex/4h' }
)
$b3 = Get-EffectiveClaim -Marks $marksB3
$myKeyB3 = '{0}/{1}' -f 'HOST1', 'cc'
$myB3 = $b3[$myKeyB3]
Assert-True '8e [issue #250-B3] codex 用 3 字段旧格式持有该单，cc 按「机器+宿主」组合键查自己的桶 ⇒ 查不到（$null）⇒ Test-IsMySessionClaim 答"不是我的"。修法前 cc 用裸 $MyHost 查会查到 codex 那条并判 True，替别人的认领续命——F3 号称堵住的"互认"洞在跨宿主这一格原样重现' `
    ((-not $myB3) -and (-not (Test-IsMySessionClaim -my $myB3 -MySession 's1'))) ("my={0}" -f $myB3)
Assert-True '8e-2 [issue #250 残留弱处锚点，钉住的是**现状不是理想态**] Test-IsMySessionClaim 自身仍不比对 runtime：直接把 codex 那条有效认领喂给它，它照旧答 True（无 session 可比 ⇒ 按旧行为放行）。本批的修法落在**查表那一步**（组合键），不在这个函数里 —— 哪天它自己也比对 runtime 了，这条会变红，那正是该更新的信号，不是回归' `
    (Test-IsMySessionClaim -my $b3['HOST1/codex'] -MySession 's1') ''

# --- 分隔符负控：`/` 不是可有可无的装饰 ---------------------------------------
$marksSep = @(
    [pscustomobject]@{ kind = 'claim'; host = 'AB'; runtime = 'C';  createdAt = '2026-08-09T01:00:00Z' },
    [pscustomobject]@{ kind = 'claim'; host = 'A';  runtime = 'BC'; createdAt = '2026-08-09T01:01:00Z' }
)
$sep = Get-EffectiveClaim -Marks $marksSep
Assert-True '8f [issue #250 分隔符负控] 组合键必须带分隔符：`AB`+`C` 与 `A`+`BC` 裸拼都是 "ABC" ⇒ 会被并成一个桶（同 A3 的病换个马甲）。带 `/` 时是 "AB/C" 与 "A/BC" 两个桶。这条专治"把 `{0}/{1}` 悄悄改成 `{0}{1}`"这一类变异——§二 字符集把 `/` 挡在两格之外，所以 `/` 做分隔符反解唯一，这条断言正是那个前提的落地检验' `
    (($sep.Count -eq 2) -and $sep.ContainsKey('AB/C') -and $sep.ContainsKey('A/BC')) ("keys={0}" -f (@($sep.Keys) -join ','))

# --- 源码文本 canary：§六 命令③④ 的调用侧（不在函数里，抽不出函数体） --------
# 三条 canary 的行尾锚刻意写成 `[^\r\n]*` 而**不带** `$`：本仓 core.autocrlf=true，工作区是
# CRLF，而 .NET 的 `(?m)$` 只在 `\n` 之前命中、在 `\r` 之前不命中 ⇒ 带 `$` 的版本在 CRLF 检出
# 下三条全部落空（本批实测：先写成带 `$`，三条同时 FAIL 且 `原文：` 打印为空）。
# 这正是 dao `[#守-锚点行尾]` 说的那一格——落空的锚在别的写法里会静默 PASS，这里因为断言
# 同时要求 `.Success`，落空即红，故是"响了"而不是"瞎了"。
# 🔴 三条同时改为**在 $sixText（§六 截段）里求值 + 段内唯一**（PR #264 复抗必修 6）：此前三条
# 都在整份文档上做 leftmost 命中 —— X12b 那一发（命令④ 真行摘掉 runtime 一格 + 上游插一段
# 带正确写法的围栏）**8h 与场景 9 一起全绿**，坐实这三条与场景 9 犯的是同一个错。
$myKeyPat = '(?m)^\$MyKey = [^\r\n]*'
$myKeyLine = [regex]::Match($sixText, $myKeyPat)
Assert-True '8g-1 §六 命令③ 定义了组合键 $MyKey，且它由 $MyHost 与 $MyRuntime 两格拼成（这一行不在任何函数体内，括号计数法抽不到，只能锚单行原文）；**锚点在 §六 段内唯一**' `
    ($myKeyLine.Success -and (([regex]::Matches($sixText, $myKeyPat)).Count -eq 1) -and ($myKeyLine.Value -match '\$MyHost') -and ($myKeyLine.Value -match '\$MyRuntime')) ("原文：{0}（段内命中 {1} 处）" -f $myKeyLine.Value, ([regex]::Matches($sixText, $myKeyPat)).Count)

$lookupPat = '(?m)^\$my = \$eff\[[^\r\n]*'
$lookupLine = [regex]::Match($sixText, $lookupPat)
Assert-True '8g-2 §六 命令③ 查自己那个桶用的是 $MyKey，不是裸 $MyHost（裸 $MyHost 查表就是 B3 冒领的落点——函数改对了而调用侧没改，缺陷原样还在）；**锚点在 §六 段内唯一**' `
    ($lookupLine.Success -and (([regex]::Matches($sixText, $lookupPat)).Count -eq 1) -and ($lookupLine.Value -match '\$eff\[\$MyKey\]')) ("原文：{0}（段内命中 {1} 处）" -f $lookupLine.Value, ([regex]::Matches($sixText, $lookupPat)).Count)

$holderPat = '(?m)^\$holderClaims = @\(\$marks \| Where-Object \{[^\r\n]*'
$holderLine = [regex]::Match($sixText, $holderPat)
Assert-True '8h §六 命令④ 的租期锚点过滤同时带 host 与 runtime 两格（8b-3 用等价表达式验了行为，这条钉住盘上那一行真的这么写——两条分工：行为断言证"这么写是对的"，canary 证"盘上就是这么写的"）；**锚点在 §六 段内唯一**——X12b 那一发正是靠上游诱饵让本条与场景 9 一起失明的' `
    ($holderLine.Success -and (([regex]::Matches($sixText, $holderPat)).Count -eq 1) -and ($holderLine.Value -match '\$_\.host -eq \$MyHost') -and ($holderLine.Value -match '\$_\.runtime -eq \$MyRuntime')) ("原文：{0}（段内命中 {1} 处）" -f $holderLine.Value, ([regex]::Matches($sixText, $holderPat)).Count)

# --- A4 / A8：本批**不修**，钉住当前的错误返回值当退役触发器 -----------------
# issue #250 处置建议明写这两条要额外的"接管环检测"、设计面更大，与"不支持合法复活"那条
# 已知弱处一起评审。这里钉住它们**现在的错误行为**：哪天有人做了环检测，这两条会变红，
# 那正是该更新期望值的信号（同场景 5 G3/G4 的历史：先钉错值，修好后翻转）。
# 不钉的话，这两个形态在盘上没有任何触发器，只活在 issue 正文里。
# 🔴 **这两条指向的 issue #250 刻意保持 open**：修 A2/A3/A5/B3 的那个 PR 不带 `Closes #250`
# （PR #264 对抗复核 B 项：写了 Closes 就等于在合并那一刻关掉 A4/A8 唯一的家，而"接管环检测
# 那一批"当时并不存在——全量筛查零命中）。owner=帅，解冻条件=环检测与合法复活一起过设计评审。
$marksA4 = Build-MarksFromComments @(
    [pscustomobject]@{ createdAt = '2026-08-09T01:00:00Z'; body = ('dao-takeover: AAA/cc ' + [char]0x00B7 + ' 原认领 BBB/cc 静默 9h') },
    [pscustomobject]@{ createdAt = '2026-08-09T01:01:00Z'; body = ('dao-takeover: BBB/cc ' + [char]0x00B7 + ' 原认领 AAA/cc 静默 9h') }
)
$a4 = Get-EffectiveClaim -Marks $marksA4
Assert-True '8i [issue #250-A4 已知缺陷锚点，本批不修] 互相接管（A 接管 B、B 再接管 A）⇒ 两个桶互相除名，有效认领集合为空：连当下合法持有它的那台机也被抹掉，两边都以为这单没人认领。钉住的是**错误值**，修好后本条会红' `
    ($a4.Count -eq 0) ("keys={0}" -f (@($a4.Keys) -join ','))

$marksA8 = Build-MarksFromComments @(
    [pscustomobject]@{ createdAt = '2026-08-09T01:00:00Z'; body = 'dao-claim: BOXA/cc/4h' },
    [pscustomobject]@{ createdAt = '2026-08-09T01:05:00Z'; body = ('dao-takeover: BOXA/cc ' + [char]0x00B7 + ' 原认领 BOXA/cc 静默 9h') }
)
$a8 = Get-EffectiveClaim -Marks $marksA8
Assert-True '8j [issue #250-A8 已知缺陷锚点，本批不修] 自我接管（同一台机重启后接管自己的陈旧认领）⇒ 把自己除名，集合为空。这不是"旧机复活不了"（已知弱处覆盖的那种），是"现任合法持有人被抹掉"，严重度不同。钉住的是**错误值**，修好后本条会红' `
    ($a8.Count -eq 0) ("keys={0}" -f (@($a8.Keys) -join ','))

# ============================================================================
# 场景 9：§六 内联区（命令③④⑦）的**语义**守护 —— PR #264 对抗复核 C 项返修
# ============================================================================
# 对抗官两轮换靶，对内联区投放 7 发语义变异（N2/N3/N4/N5/P2/P3/P4），**7 发全部存活**，
# 51 条断言一条没红。根因不是"少写了几条断言"，是**那一整片只有 token 级 canary**：
# 8g-1/8g-2/8h 守的是"这个变量名还在不在"，守不住分隔符漂移 / 操作数顺序对调 / 布尔算子
# 弱化 / 上一行取值来源被换。最重的两发：
#   · P2：让位比较 `-lt` -> `-gt`（Δbytes=0）⇒ **该让位的不让、不该让的让**。这一行是本
#     协议**用户可见行为的本体**（"两台机撞上了，谁退"，issue #193 立项要的就是它），
#     而回归网此前只覆盖它的**输入**（分组、桶键、除名）、不覆盖它的**输出**。
#   · P4：`$MyKey` 那行一个字不动，只改**上一行** `$MyRuntime` 的取值来源 ⇒ 键第二格漂掉
#     ⇒ `$my` 恒 $null ⇒ 让位判据整条不触发（fail-open）。
#     **canary 守的是那一行在不在，不是那个值从哪来。**
#
# 修法不是再补几条 token canary，是**把内联区原文从文档里抠出来真跑一遍**。
# 与 8b-3 那种"测试文件里自己写一份等价表达式"的**逻辑副本**是两回事：这里执行的字节逐个
# 来自 dao-workitem.md **§六 那一段**（`$sixText`），盘上 §六 那一行漂了，跑出来的答案就跟着变。
# 🔴 **"§六 那一段"这个限定词是 PR #264 复抗必修 4 补上的，它此前是一个没写出来的前提**：
#   原文只写「字节逐个来自 dao-workitem.md」，而当时抠取用的是**整份文档的 leftmost 命中**
#   ⇒ 在 §六 上游插一段同型的 ```powershell 围栏，抠取整体挪到诱饵上，§六 真行随便改坏
#   而 62 条断言全绿（X12/X12b/X21 三发实测全部存活）。现在射程由场景 0 的 0e/0f 截段限定、
#   锚点在段内不唯一即 throw ⇒ **上游插诱饵那一类是真的关上了**（2026-08-10 第三轮复抗换靶
#   X1/X2 两发实测 KILLED）。🔴 **但这句限定词此处此前写作「那句话才真的成立」，说大了**：
#   它现在只到「字节来自**截段结果**」这一步，而截段结果**可能只是 §六 的前半截**——围栏里
#   一行 `### ` 开头的注释就把下界提前了（形态与关闭条件见场景 0 头注那段 🔴，归 issue #250）。
#   **别把这段限定词删掉去恢复原来那句更漂亮的话。**
# 🔴 **8b-3 / 8g-1 / 8g-2 / 8h 一条都不删**：对抗官实测坐实它们"不是同一件事的两份拷贝，
# 是同一件事的两个半拉子"（N5 那一发两条都没拦住）。本场景补的是第三块，不是替换品。
#
# 判别力自证（防"抠出来是空串 ⇒ 断言全部真空通过"）——这三条是这个场景能不能信的前提：
#   ① 锚点不命中 ⇒ Get-InlineSource 当场 throw，整套红，**绝不静默返回空串**；
#   ② 占位符替换次数逐个断言（9a）——文档要求"跑之前自己填"的正是那三格，
#      而 P4 那一类变异改的就是这三格里某一格的取值来源，替换数当场从 1 掉到 0；
#   ③ 每条行为断言都**双向**：正例证"该发生的发生了"，反例证"不该发生的没发生"。
#      单向断言对 `-lt` -> `-gt` 这种**反转**是零判别力（正例反例同时翻，只查一侧仍然绿）。
Write-Host '场景 9：§六 内联区（命令③④⑦）语义守护'

function Get-InlineSource {
    <#
      §六 命令③④⑦ 是**内联脚本**、不在任何函数体内，Get-BraceBlockSource 的括号计数法抽不到
      ——那正是它们此前只有 token canary 的结构性原因。本函数按锚点截取原文。
      锚点里的换行一律写 `\r?\n`：本仓 core.autocrlf=true、工作区是 CRLF，写死 `\n` 的锚点在
      CRLF 检出下恒不命中，而"锚点落空"与"守卫扛住"在报文上逐字节相同（dao `[#守-锚点行尾]`）。
      **命中失败即 throw，不返回空串**：静默返回空会让下面每一条断言都在空输入上"通过"。
      🔴 **命中不唯一同样 throw**（PR #264 复抗必修 6）：`[regex]::Match` 给的是 leftmost，
      有第二处同型文本时它默默抠前面那一份 —— 而"抠到了别处的同型行"与"抠对了"在报文上
      逐字节相同。调用方喂进来的 $Text 是**截过段的 $sixText**（见场景 0 的 0e/0f），
      两道合起来才把 X12/X12b/X21 那一类窗口劫持关掉。
    #>
    param([string]$Text, [string]$Pattern, [string]$Label)
    $ms = [regex]::Matches($Text, $Pattern)
    if ($ms.Count -gt 1) { throw "内联区提取失败：锚点在射程内命中 $($ms.Count) 处、不唯一（$Label）：$Pattern" }
    $m = [regex]::Match($Text, $Pattern)
    if (-not $m.Success) { throw "内联区提取失败：锚点未命中（$Label）：$Pattern" }
    if (-not $m.Groups['src'].Success) { throw "内联区提取失败：命中但捕获组 src 不存在（$Label）" }
    if ($m.Groups['src'].Value.Trim().Length -eq 0) { throw "内联区提取失败：捕获到空串（$Label）" }
    return $m.Groups['src'].Value
}

function Get-SubstringCount {
    param([string]$Text, [string]$Sub)
    $n = 0; $i = 0
    while (($i = $Text.IndexOf($Sub, $i)) -ge 0) { $n++; $i += $Sub.Length }
    return $n
}

# 命令③ 前置段：$eff 那行起，到"让位判据"那一行之前（含 $MyHost/$MyRuntime/$MySession/$MyKey/$my/$others）
# 🔴 四处 -Text 一律喂 $sixText（§六 截段）而不是 $docText：射程与唯一性的理由见场景 0 的 0e/0f。
$cmd3Prelude = Get-InlineSource -Text $sixText -Label '命令③ 前置段' `
    -Pattern '(?s)(?<src>\$eff = Get-EffectiveClaim -Marks \$marks.*?)\r?\nif \(\$my -and \$others'

# 让位判据行（命令③ 的**输出**侧）。锚点刻意只锚到 `if ($my -and $others`，**不含比较算子**
# ——含了的话 `-lt` -> `-gt` 就变成"提取失败"，红的理由会指向锚点而不指向语义。
$yieldIfLine = Get-InlineSource -Text $sixText -Label '命令③ 让位判据行' `
    -Pattern '(?m)^(?<src>if \(\$my -and \$others[^\r\n]*)'
$yieldCondM = [regex]::Match($yieldIfLine, '^if\s*\((?<c>.+)\)\s*\{\s*$')
if (-not $yieldCondM.Success) { throw "内联区提取失败：让位判据行剥不出条件表达式：$yieldIfLine" }
$yieldCond = $yieldCondM.Groups['c'].Value

# 命令⑦ 判据行（/dao-resume「只报不接」）。锚点同理**刻意不含 `-not`**：P3 那一发摘的就是
# `-not`，锚点含了它 ⇒ 提取失败；不含 ⇒ 条件照样抠得出来、跑出来的布尔值翻转，9j/9k 当场红。
$resumeIfLine = Get-InlineSource -Text $sixText -Label '命令⑦ 判据行' `
    -Pattern '(?m)^(?<src>if \(\$my -and [^\r\n]*Test-IsMySessionClaim[^\r\n]*)'
$resumeCondM = [regex]::Match($resumeIfLine, '^if\s*\((?<c>.+)\)\s*\{\s*$')
if (-not $resumeCondM.Success) { throw "内联区提取失败：命令⑦ 判据行剥不出条件表达式：$resumeIfLine" }
$resumeCond = $resumeCondM.Groups['c'].Value

# 命令④ 租期锚点行
$cmd4HolderLine = Get-InlineSource -Text $sixText -Label '命令④ 租期锚点行' `
    -Pattern '(?m)^(?<src>\$holderClaims = @\(\$marks \|[^\r\n]*)'

# 三个占位符：文档逐字写着"跑之前自己填"，本测试就是那个"填"的动作。
# 替换按**字面串**（String.Replace 不是正则），且只替换带引号的那一份 —— 注释里那些不带引号的
# `<机器名>` 原样留着，改了它们不该让本场景红。
$phHostLit = "'<机器名>'"; $phRuntimeLit = "'<宿主>'"; $phSessionLit = "'<会话短id>'"
$phHostN = Get-SubstringCount -Text $cmd3Prelude -Sub $phHostLit
$phRuntimeN = Get-SubstringCount -Text $cmd3Prelude -Sub $phRuntimeLit
$phSessionN = Get-SubstringCount -Text $cmd3Prelude -Sub $phSessionLit

Assert-True '9a [PR #264 对抗 P4 类：值来源被换] 命令③ 三个"跑之前自己填"的占位符各恰好一处：$MyHost 取自 `<机器名>`、$MyRuntime 取自 `<宿主>`、$MySession 取自 `<会话短id>`。P4 那一发不碰 $MyKey 那行、只把上一行 $MyRuntime 的取值来源换掉（Δbytes=0），token canary 8g-1 照绿；本条直接盯**值从哪来**，替换数当场从 1 掉到 0' `
    (($phHostN -eq 1) -and ($phRuntimeN -eq 1) -and ($phSessionN -eq 1)) ("host={0} runtime={1} session={2}" -f $phHostN, $phRuntimeN, $phSessionN)

$cmd3Runnable = $cmd3Prelude.Replace($phHostLit, "'HOSTX'").Replace($phRuntimeLit, "'cc'").Replace($phSessionLit, "'sessA'")

function Invoke-InlineSection {
    <#
      把从文档抠出来的四段原文拼起来真跑一遍，返回观测对象。
      **抠出来的字节一个不改**（除上面那三个占位符换成测试值——那正是文档要求填的三格，
      9a 已断言它们真被填掉）；观测行只**追加在尾部**，不插进去、不改写。
      内联区原文引用的变量名是 $marks；PowerShell 变量名大小写不敏感，参数 $Marks 就是它。
    #>
    param($Marks)
    $src = $cmd3Runnable + "`n" +
        '$__yield = ' + $yieldCond + "`n" +
        '$__resume = ' + $resumeCond + "`n" +
        $cmd4HolderLine + "`n" +
        '[pscustomobject]@{ key = $MyKey; my = $my; others = @($others); yield = [bool]$__yield; resume = [bool]$__resume; holders = @($holderClaims) }'
    return (& ([scriptblock]::Create($src)))
}

# --- F1：别的「机器+宿主」比我早 ⇒ 我该让位；且我自己的会话 id 对得上 ⇒ 不走"只报不接" ---
$inlineF1 = Invoke-InlineSection -Marks (Build-MarksFromComments @(
    [pscustomobject]@{ createdAt = '2026-08-09T01:00:00Z'; body = 'dao-claim: HOSTY/cc/4h' },
    [pscustomobject]@{ createdAt = '2026-08-09T01:05:00Z'; body = 'dao-claim: HOSTX/cc/sessA/4h' }
))

Assert-True '9b [PR #264 对抗 N2/N3 类：分隔符漂移与两格顺序对调] 命令③ 拼出来的组合键就是 "HOSTX/cc"。N2（`/` 改成 `-`）与 N3（两格对调）都是 Δbytes=0、token 一个不少 ⇒ 8g-1 照绿，而键与桶键永不相等 ⇒ $my 恒 $null ⇒ 让位判据整条不触发（fail-open，A3 原病换个入口复活）。**本条同时是场景 9 的真空自检，但只管两态**：抠出来是空串 / 跑不动，这条第一个红。**第三态「抠到了 §六 之外的同型行」本条管不着**（诱饵里的键照样是 HOSTX/cc，它满意得很）——那一态由 0e/0f 的截段与锚点段内唯一性**只关掉了段外诱饵那一半**（诱饵与真行被围栏里一行 ### 注释隔开时仍关不住，2026-08-10 三抗四发实测存活，归 issue #250；此处此前写作「在结构上排除」，已证伪），PR #264 复抗判词点名过这句自陈说大了' `
    ($inlineF1.key -eq 'HOSTX/cc') ("key={0}" -f $inlineF1.key)

Assert-True '9c 命令③ 查到的是**我自己那个桶**（host=HOSTX 且 runtime=cc），不是同机另一个宿主的' `
    (($null -ne $inlineF1.my) -and ($inlineF1.my.host -eq 'HOSTX') -and ($inlineF1.my.runtime -eq 'cc')) ("my={0}/{1}" -f $inlineF1.my.host, $inlineF1.my.runtime)

Assert-True '9d [PR #264 对抗 P2 类：比较方向反转 · 正例] 别的桶（HOSTY/cc @01:00）比我（@01:05）早 ⇒ 让位判据为**真**，该发 dao-yield: 让位。这一行是本协议用户可见行为的本体，此前 51 条断言里一条都不覆盖它的输出' `
    ($inlineF1.yield -eq $true) ("yield={0}" -f $inlineF1.yield)

Assert-True '9f [PR #264 对抗 N4 类：排除自己那格退回裸 $MyHost] $others 里不含我自己那条——桶键是 "HOSTX/cc"、与裸 "HOSTX" 永不相等，写成 `$_ -ne $MyHost` 时自己的认领也会落进 $others，变成自己跟自己比早晚' `
    (($inlineF1.others.Count -eq 1) -and (@($inlineF1.others | Where-Object { $_.host -eq 'HOSTX' -and $_.runtime -eq 'cc' }).Count -eq 0)) ("others={0}" -f (@($inlineF1.others | ForEach-Object { "{0}/{1}" -f $_.host, $_.runtime }) -join ','))

Assert-True '9k [PR #264 对抗 P3 类：命令⑦ 摘 `-not` · 反例] 我自己那条认领的会话 id 与 $MySession 一致（都是 sessA）⇒ "只报不接"判据为**假**，这是我自己前任留下的单，照常接' `
    ($inlineF1.resume -eq $false) ("resume={0}" -f $inlineF1.resume)

# --- F2：我比别人早 ⇒ 不让位（P2 的另一侧，单向断言对"反转"是零判别力）-------------
$inlineF2 = Invoke-InlineSection -Marks (Build-MarksFromComments @(
    [pscustomobject]@{ createdAt = '2026-08-09T01:00:00Z'; body = 'dao-claim: HOSTX/cc/sessA/4h' },
    [pscustomobject]@{ createdAt = '2026-08-09T01:05:00Z'; body = 'dao-claim: HOSTY/cc/4h' }
))
Assert-True '9e [PR #264 对抗 P2 类：比较方向反转 · 反例] 我（@01:00）比别的桶（HOSTY/cc @01:05）早 ⇒ 让位判据为**假**，先到者留着接着干。9d 与本条合起来才夹得住 `-lt`：只写正例时 `-lt` 换成 `-gt` 会让两条同时翻，而只查一侧的网仍然全绿' `
    ($inlineF2.yield -eq $false) ("yield={0}" -f $inlineF2.yield)

# --- F3：同机另一个宿主（A3 后半 + 命令④ 租期锚点）---------------------------------
$inlineF3 = Invoke-InlineSection -Marks (Build-MarksFromComments @(
    [pscustomobject]@{ createdAt = '2026-08-09T01:00:00Z'; body = 'dao-claim: HOSTX/cc/sessA/4h' },
    [pscustomobject]@{ createdAt = '2026-08-09T01:03:00Z'; body = 'dao-claim: HOSTX/codex/4h' }
))
Assert-True '9g 同机 codex 后到 ⇒ 我查到的仍是自己那条（cc @01:00），且让位判据为假（后到者才该让）——B3 冒领在调用侧的正面形态' `
    (($null -ne $inlineF3.my) -and ($inlineF3.my.runtime -eq 'cc') -and ($inlineF3.my.createdAt -eq '2026-08-09T01:00:00Z') -and ($inlineF3.yield -eq $false)) ("my={0}/{1}@{2} yield={3}" -f $inlineF3.my.host, $inlineF3.my.runtime, $inlineF3.my.createdAt, $inlineF3.yield)

Assert-True '9h [PR #264 对抗 N5 类：命令④ 的 `-and` 弱化成 `-or`] 租期锚点只取我自己「机器+宿主」那条（cc @01:00），同机 codex 后发的 @01:03 不得混进来。`-and` 变 `-or` 时 codex 那条重新落回候选集、租期从别人那条算起（A3 后半原样复发），而 8b-3（测试文件里的等价表达式副本）与 8h（token canary）**两条都拦不住**——对抗官 N5 实测坐实' `
    (($inlineF3.holders.Count -eq 1) -and ($inlineF3.holders[0].runtime -eq 'cc') -and ($inlineF3.holders[0].createdAt -eq '2026-08-09T01:00:00Z')) ("holders={0}" -f (@($inlineF3.holders | ForEach-Object { "{0}/{1}@{2}" -f $_.host, $_.runtime, $_.createdAt }) -join ','))

# --- F4：B3 负控 —— 只有同机 codex 持有 ⇒ 我压根查不到自己的桶，不冒领 ---------------
$inlineF4 = Invoke-InlineSection -Marks (Build-MarksFromComments @(
    [pscustomobject]@{ createdAt = '2026-08-09T01:00:00Z'; body = 'dao-claim: HOSTX/codex/4h' }
))
Assert-True '9i [误伤反例 · B3 负控] 同机只有 codex 持有该单时，cc 用组合键查 ⇒ $my 为 $null，让位与"只报不接"两条判据都不触发，租期锚点也取不到任何东西。修法前用裸 $MyHost 查会查到 codex 那条并当成自己的、替别人的认领续命' `
    (($null -eq $inlineF4.my) -and ($inlineF4.yield -eq $false) -and ($inlineF4.resume -eq $false) -and ($inlineF4.holders.Count -eq 0)) ("my={0} yield={1} resume={2} holders={3}" -f $inlineF4.my, $inlineF4.yield, $inlineF4.resume, $inlineF4.holders.Count)

# --- F5：命令⑦ 正例 —— 同机同宿主另一个并发会话持有 ⇒ 只报不接 ---------------------
$inlineF5 = Invoke-InlineSection -Marks (Build-MarksFromComments @(
    [pscustomobject]@{ createdAt = '2026-08-09T01:00:00Z'; body = 'dao-claim: HOSTX/cc/sessB/4h' }
))
Assert-True '9j [PR #264 对抗 P3 类：命令⑦ 摘 `-not` · 正例] 桶里那条认领的会话 id 是 sessB、而我是 sessA ⇒ "只报不接"判据为**真**：这是同机同宿主另一个并发会话的单，不是我自己前任的。摘掉 `-not` 时 9j/9k 同时翻向危险的一侧（把别人的单当成自己的接着干）' `
    ($inlineF5.resume -eq $true) ("resume={0} session={1}" -f $inlineF5.resume, $inlineF5.my.session)

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
