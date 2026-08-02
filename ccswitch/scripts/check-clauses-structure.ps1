<#
.SYNOPSIS
    条款库结构完整性硬闸（canonical）。检查一份「带元字段的规则集」自身有没有静默腐坏。
    缺省被检对象是 `ccswitch/dao.md`；项目可用 -TargetFile 指向自己的条款库全文。

.DESCRIPTION
    ── 这份 canonical 从哪来、为什么现在才有 ──────────────────────────────────
    「规则集只增不减是结构必然」那条自带 `触发:verify-all/check-clauses-structure`（**2026-08-01 起
    该条正文迁 ccswitch/rules/dao-guard-writing.md**，dao.md 反·归只留存根+条款名，故按名字仍搜得到），
    而那个检查器**只存在于 mousse-cli/scripts/**（2026-08-01 审计实证：ccswitch/scripts/ 下
    只有 dao-config-sync.ps1，windsurf-dao/tests/ 无一条款库相关用例）⇒ **dao.md 这个规则集
    本身从未被它守过**，「立法者不受自己的法约束」的又一实例（同 scaffold-manifest 取消元仓库
    整体豁免那次）。本文件是把那个检查器搬进共享层。

    ── 搬运时被证伪的一件事：不能只参数化路径 ─────────────────────────────────
    审计官原方案是「路径参数化即可」。对抗验证官证伪：mousse 版的条款判据是
    **「零缩进 `- ` 行一律是条款，必须带元字段」**，而 dao.md 的顶层 bullet 大量是
    散文分点 —— 2026-08-01 实测 dao.md 有 65 个零缩进 `- ` 行、其中**只有 10 个**带元字段
    ⇒ 直接指过去会喷 55 条假 FAIL，第一次跑就会被当噪音关掉。
    更硬的一层（实测才发现，原方案与对抗官都没说到）：dao.md 的条款**不止住在列表项里**——
    20 条带元字段的行分布为 顶层 `- ` 10 条 / **缩进** `- ` 7 条 / **纯散文段落** 3 条。
    ⇒ 对 dao.md 而言，「行的形态」根本不是条款的签名，**元字段本身才是**。
    故本脚本把「哪些行算条款」提成显式参数（见 -ClauseSelector），两种语义各自成立、
    各自有射程，**不做自动猜测**（猜错的方向是静默少扫，正是检查 5 要防的病）。

    ── 各道检查（**刻意不写"共 N 道"**：加检查时没人回来改那个数）──────────────
      1. 焊接签名 `。：`（句号紧跟冒号）—— 出处是一次真实事故：一条降级条款被一个多余的
         「：」焊在上一条末尾，没有 bullet 没有标题，检索时根本找不到它。扫全部非围栏内容，
         **含 blockquote**（这个标点组合在任何正常中文行文里都反常，不因所在容器而改变）。
         与 -ClauseSelector 无关，两种模式都跑。
         **近似声明**：只覆盖「中文句号+中文冒号」这一种焊接形态；「；：」「.:」等尚无实例
         出处，不为假想敌加判据。
      2. 孤儿条款 —— 以 `**` 开头但不以 `- ` 开头的顶层段落。正常条款是 `- **标题**：…`，
         孤儿段落意味着按 `^- ` 检索会跳过它。
         **只在 -ClauseSelector AllTopLevel 下跑**：Marked 模式的被检文件（dao.md 型）本来就
         大量使用加粗散文段落，那是合法形态，跑它等于给自己造 55 条噪音。跳过时会打印一行
         说明 —— **不打印的跳过与"跑了且零违例"输出相同**，那正是检查 5 讲的那个病。
      3. 元字段完整性 —— 每条被选中的条款必须带 `[n=<次数|?> @<月日> 触发:<触发点>]`；
         `触发:无` 的还须同行带 `[仅判据·无触发]`。
         **两种模式的射程不同，这是本参数最大的代价，照直写**：
           · AllTopLevel：「零缩进 `- ` 行」即条款 ⇒ **整条丢掉元字段也检得出**（真硬闸）。
           · Marked：选择器就是 `[n=` ⇒ **整条丢掉元字段的行根本不会被选中，检不出**。
             它只保证「自称是条款的行，字段格式完整」（`[n=1 触发:x]` 少个 `@` 照样红）。
             补偿是统计段会打印「本模式排除了多少行」——那个数字异常时人看得见。
      4. 观察区标记错位 —— `## 观察区…` 节内的条目必须带 `[观察中]`，节外的必须不带。
         这不是为假想敌立的判据，是**定义的两半**：`[观察中]` 就是「这条还不是条款」在行粒度
         上的标签，与它所在的节等价。被检文件没有观察区节时本检查自然零条（dao.md 即如此）。
      5. 扫描面塌陷（下限断言）—— **把「本次到底看到了几个样本」变成一条被断言的量**。
         病灶的一般形式：**检测器数到 0 个违例，和检测器根本没看到任何样本，输出一模一样**。
         mousse 侧实测过最毒的形态：给一个节标题加个装饰 emoji ⇒ 70 条静默缩到 34 条，
         而「触发:无」占比反而从 54.3%「改善」到 38.2% —— 同一个动作既关掉一半闸、
         又让最承重的指标变好看，退出码全程干净。
         判据是**集合差不是数字阈值**：分母由一个**不共享节状态机**的独立普查函数产出。
         复用状态机会让两边一起错、集合差恒为 0，闸退化成永远为真的废话
         （＝「拿被测对象自己当基线」）。
         子信号：
           a) `zero-sample`          —— 一条都没选中（整份扫描面为空）。
           b) `swallowed-by-section` —— 带条款签名的行不在检出集合里 ⇒ 它落在某个 📌 节内，
              要么节判定错了、要么有人把条款写进了 📌 节。
           c) `indented-clause`      —— **仅 AllTopLevel 模式**：带完整元字段的缩进列表项。
              该模式的顶层判据是 `^- `，缩进子项永远看不见 ⇒ 存在即脱闸。
              Marked 模式**不报这一条**：那里缩进条款是合法且真实存在的形态（dao.md 7 条）。
         **它证不了什么**（照直写）：只保证「带签名的行没被吞掉」，**不保证该有的条款都在**——
         有人整条删掉，两侧同时少一行、集合差仍为 0。那一面靠 git diff 与人。
         **v2 补一句**：这个盲区被检查 6 的 `orphan-ledger` **部分**补上了 —— 整条删掉时台账里
         那一条会变成孤儿而现形。**只是部分**：删条款的同时把台账条目一并删掉，两边仍然静默一致。
         台账把「悄悄删一条」的成本从 0 抬到 1 次额外编辑，没有抬到不可能。
      6. 正文 slug ↔ 台账（`ccswitch/clause-ledger.json`）双向对账 —— **v2（批 2 · 台账搬家）**。
         台账字段的真相源搬进 JSON，正文只持一个行内 slug `[#<域>-<短名>]`。命中形态
         （`missing-slug` / `dup-slug` / `orphan-slug` / `orphan-ledger` / `ledger-file-mismatch` /
         `ledger-mismatch`，外加台账本身读不了的 `ledger-unreadable`）**全是结构错**，
         没有一种需要现场取舍 ⇒ 硬闸。
         **激活判据**：本文件有 slug，**或**台账里有条目指着本文件。两样都没有 ⇒ 打印一行
         「不适用」并跳过（回归网夹具、别的仓的条款库属这一类）。**不静默跳过** ——
         而无条件激活的话，每份夹具都会被整本台账判成一堆 orphan-ledger。
         **双轨对账只比行内确实写着的字段**：行内没写的不参与（那不是「不等」，是「正文没这一栏」），
         此时台账侧应为 null；台账反而有值 ⇒ 台账替正文编了一个值，同样判红。
         **判不了的**：台账里的**数字对不对**（同 `触发:` 取值真伪那一格）—— 本闸只保证两边
         说的是同一句话，不保证那句话是真的。

    ── 与 mousse-cli/scripts/check-clauses-structure.ps1 的关系 ────────────────
    那份是本文件的**先行实现**，判据（尤其检查 5 的集合差形态、n 归桶、日期宽限窗）
    出自它踩过的四个真实缺陷（issue #285 节判定匹配任意位置 / #286 归桶用字符串相等 /
    零宽限年份回退报 365 天 / 退役区只扫 n=1 漏掉 30% 的 n=?）。本文件继承那些判据，
    **不继承「零缩进 `- ` 即条款」这个隐含前提**（见上）。
    ⚠ 两份现在是**双写**：mousse 那份未改动、仍是它 verify-all 的那一道。收敛成
    「项目侧调 canonical」是另一件事（跨仓改动进不了同一个 PR），**本批不做，照直记**。

.PARAMETER TargetFile
    被检文件路径。缺省 = 本仓 `ccswitch/dao.md`。相对路径按**当前 PowerShell 位置**解析
    （不这么做的话 .NET 的 CurrentDirectory 与 Set-Location 不同步，会静默读到别的仓的同名
    文件并报 OK —— mousse 侧 2026-07-27 实测撞到过）。

.PARAMETER ClauseSelector
    **「哪些行算条款」的选择器。** 这是本 canonical 相对 mousse 版新增的那个参数，
    理由见 .DESCRIPTION「不能只参数化路径」。恰两个取值，没有自动模式：

      Marked（缺省）—— 含任一台账字段（`[n=` / `[基线:` / `[自定@`）**或** slug `[#…]` 的行即
        条款候选，**不论缩进、不论是不是列表项**；行内代码 span 里的一律不算。
        适用于「条款与散文混装」的文件（dao.md 型）。
        **v1 判据只有 `[n=`**，于是「带基线或自定标记却没有完整签名」的行结构上看不见 ——
        可达性矩阵实测漏 5 条真条款（dao.md 3 · dao-longwindow.md 2），全是承重条款。
        代价：整条丢掉元字段**且**没有 slug 者仍检不出（检查 3 的射程说明）。
      AllTopLevel —— 零缩进 `- ` 行即条款（mousse 版语义）。
        适用于「整份文件就是条款列表」的文件（dispatch-clauses.md 型）。
        代价：对散文型文件会喷一片假 FAIL。

    **缺省取 Marked 是刻意选的失败方向**：指错文件时 Marked 少报（安静但弱），
    AllTopLevel 多报（吵但假）。少报本来更危险，**故用统计段的「选择器排除了 N 行」
    这一行把它显式化** —— 一份真正的条款库若显示排除了几十行，那就是选错模式了。

.PARAMETER LedgerFile
    条款台账路径，缺省 = 本仓 `ccswitch/clause-ledger.json`。它是台账字段的**真相源**，
    正文只持行内 slug。检查 6 用它做双向对账；本文件与台账都没有 slug 关系时自动不适用
    （打印一行说明，不静默）。

.PARAMETER SectionPattern
    可选的**节白名单**正则（匹配 `##` 标题行）。缺省空 = 全部节都扫。
    与 ClauseSelector 正交、可组合：想只查 dao.md 某几节，传如 `'^##\s*(帅|反)'`。
    ⚠ 本参数**天然是个减少扫描面的旋钮**，而减少扫描面正是检查 5 要防的事。闸位取舍：
      · **主动**缩面是操作者的选择、不是代码错 ⇒ 走**观察线**：统计段打印
        「节白名单排除了 N 条带签名的条款（行 …）」+ 一句代价说明，**不进退出码**。
        （若做成硬闸，这个参数就没法用了 —— 一个用了就必红的参数等于不存在。）
      · **📌 节吞没条款**是结构错 ⇒ 仍走硬闸，**白名单命中的区间里照样判红**
        （回归网有这一条：「缩面不等于关闸」）。
    ⚠ **代价照直写**：被白名单排除的那段区间里，「📌 吞没」检不出来（两者在那里合并成同一类）。
    **默认路径（不传本参数）不受影响、硬闸完整** —— 而 hook 与 CI 走的正是默认路径。

.PARAMETER RetireAgeDays
    「候选退役区」年龄门槛（天），缺省 21（判据是 `-gt` ⇒ 实际需满 22 天）。
    超龄条款进统计段清单：**不自动删、不影响退出码**，只让它每次都在人眼前过一遍
    —— 立法有触发器（刚踩坑、正在写复盘），**退役没有**，这一段就是那个触发器。
    扫描面按 `n` 分**三栏**（`n=0` / `n=1` / `n=?`），三栏要用**不同的眼光**读：
      · `n=0` ⇒ **已知**零次，问「它防的事从没发生过，为什么还在」（最强退役信号；
        若其实是"没数过"，正确写法是 `n=?`——这层歧义只有单独一栏说得清）。
      · `n=1` ⇒ 单例立法，问「这条还有用吗」，处置是退役或留着。
      · `n=?` ⇒ 次数未知，问「它到底踩过几次」，处置是**先回填 n**，不是删。
        直接对 `n=?` 判退役与直接排除它是同一个错的两面：都在替未知下结论。
    `n>=2` 不进扫描面，这是**范围克制不是「那面已验干净」**：`n` 是人手填的、
    从没被校验过，也没有任何机制在复发时真的去 +1 ⇒ `n>=2` 只证明有人写下了一个 ≥2 的字符。

.PARAMETER FutureGraceDays
    月日解析的**未来宽限窗**（天），缺省 2。`@` 字段只有月日没有年份，零宽限时
    「比本机时钟早一天」的正常入库日（全球时区跨度约 26 小时 > 1 天；作者按自己认知
    填了明天）会被翻成**去年**同月日、瞬间显示 364-365 天并落进候选退役区（mousse 侧实测过）。
    调参三问：①0 = 现状 bug，1 天盖不住 26 小时时区跨度叠加"填了明天"；②2 天同时盖住
    这两个已知来源；③2 天以上无真实需求 —— `@` 的语义是**已入库**日期，落在那段的只能是
    笔误，让它翻成去年、以「入库 36x 天」现形正是想要的行为。

.PARAMETER RetireListMax
    每栏最多打印几条明细，缺省 3；`0` = 全打。超限按**日期确定性轮转**取窗口
    （同一天多次运行结果完全相同、可复现；跨天换一批），**条数与最大年龄始终全量打印**，
    折叠的只是明细行。理由：这些成员是**成批同日越线**的（`@` 日期取值很少），
    不限量会在某天之后变成一段稳定的几十行清单，而「生下来就吵的检查一定会被静音」。
    ⚠ 轮转的代价照直写：①放弃「最老优先」（过门槛后年龄不再有判别力，排序基底取正文更稳）
    ②**不承诺严格全覆盖周期** —— 起始位是 `dayIndex*Max mod n`，`n` 一变（增删条款）相位就跳。

.NOTES
    退出码 0 = 结构完整；非 0 = 命中至少一种已知失效形态（硬闸）。
    统计段（触发点分布 / n 分布 / 基线标注率 / 候选退役区 / 观察区 / AI 自定回溯面）
    **只打印，恒不参与退出码**。唯一例外是「扫描面自检」那一行 —— 它长在统计段里却是硬闸，
    因为它报的不是「你该判断一件事」，而是「这一段统计本身是不是在数一个被吃掉的样本集」。
    把它印在统计段抬头是刻意的：**数字与它的分母必须在同一屏。**

    闸位取舍（新增机检项先判闸位）：「代码/结构错了」用硬闸，「人该判断一件事」用观察线
    （恒 exit 0、只打印）。候选退役区 / 待升格 / AI 自定回溯面全是后者 ——
    做成硬闸只会逼出「为过闸而敷衍地退役/升格」，那比不做更糟。

    **本闸判不了的（别把 OK 读成「条款库没问题」）**：
      · `触发:` 的**取值真伪**完全盲 —— 编一个不存在的载体写进去，闸照样放行，
        那个假载体还会在「触发点分布」里自成一桶。挂错只能靠人复核。
      · `[自定@…]` 只认标记在不在，判不出这条**该不该**自定。
      · 整条条款被删掉时两侧同时少一行，检查 5 看不见（v2 起检查 6 的 orphan-ledger
        补上了一半：正文删了而台账还在会现形；两边一起删仍然静默）。
      · **台账里的数字对不对本闸同样判不了**：检查 6 只保证正文与台账说的是同一句话。
        两边一起写错、或搬录时一起搬错，闸全绿。
      · 🔴 **检查 5 的「自检」那一半与检出复用同一个 `Get-MaskedLine`（已知缺口，本批未修）**。
        dao-guard-writing「自检那一半绝不能复用被守对象的解析逻辑」讲的正是这个：
        普查（Get-ClauseCensus）与检出（Get-ClauseRecords）各走各的**节状态机**（那一层是
        独立的、刻意的），但**遮罩这一层两边共用** ⇒ 遮罩错了两边一起瞎、集合差恒为 0。
        2026-08-02 实测坐实：未闭合反引号缺陷期，Marked 模式下 census 与检出**同时**
        少数同一行（85→86 那一行），检查 5b 全程不响、退出码干净。
        **本批只修了遮罩本身，没有拆掉这个共用** —— 拆它要给普查另写一套遮罩，
        而「两套遮罩该不该允许结论不同」是判断不是照做（两套都对时集合差恒 0，
        那就白写；两套不同时以谁为准又是新问题）。故此处只把缺口写明，
        处置交下一批/派单方裁。**别把本批的绿读成「这一层现在有自检了」。**
#>

# `[CmdletBinding()]` 不是装饰：没有它，PowerShell script 会把**认不出的具名参数**
# 静默吞进 $args ⇒ `-Path <某文件>`（把参数名记错）不报错、`$TargetFile` 保持缺省值
# ⇒ **本闸转头去扫 dao.md 并报 OK**，而操作者以为扫的是他给的那个文件。
# 2026-08-02 实测：`... -Path D:\...\mousse-cli\docs\rules\dispatch-clauses.md` ⇒ exit 0、
# 输出里「目标：」那一行写着 ccswitch/dao.md —— 一次「看起来干净」的**假绿**，
# 而它恰好就是本批缺陷被误判为「已修好」的那条路径。
# 加上之后：参数名打错 ⇒ 绑定错误、非零退出。属本闸自己在治的那类病（扫错对象 = 零样本
# 的另一种形态），故一并 fail-closed。
[CmdletBinding()]
param(
    [string]$TargetFile = '',
    [ValidateSet('Marked', 'AllTopLevel')][string]$ClauseSelector = 'Marked',
    [string]$SectionPattern = '',
    [int]$RetireAgeDays = 21,
    [int]$FutureGraceDays = 2,
    [ValidateRange(0, 1000)][int]$RetireListMax = 3,
    [string]$LedgerFile = ''
)

$ErrorActionPreference = 'Stop'

# stdout 被重定向时（被 hook / CI 以子进程方式调用），PS 5.1 按**本机 ANSI 代码页**写出，
# 中文到了消费方那边是乱码 —— 2026-08-01 实测：dao-scaffold-check.js 用
# `execFileSync(..., {encoding:'utf8'})` 读回来的违规明细是 `�� 343������`。
# 纯 ASCII 的 marker 行不受影响，**恰恰因此这个缺陷极易被漏掉**：机器读的那一行永远是对的，
# 只有人读的那半是坏的。这里在源头统一成 UTF-8。
# try/catch：无控制台可附着的宿主里赋值会抛，那时保持默认即可（marker 仍是 ASCII、仍可解析）。
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

# 本文件在 ccswitch/scripts/ ⇒ 仓根是上两层。
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
if ([string]::IsNullOrWhiteSpace($TargetFile)) {
    $targetFile = Join-Path $repoRoot 'ccswitch/dao.md'
} else {
    $targetFile = if ([System.IO.Path]::IsPathRooted($TargetFile)) { $TargetFile }
                  else { Join-Path (Get-Location).Path $TargetFile }
}
if ([string]::IsNullOrWhiteSpace($LedgerFile)) {
    $ledgerFile = Join-Path $repoRoot 'ccswitch/clause-ledger.json'
} else {
    $ledgerFile = if ([System.IO.Path]::IsPathRooted($LedgerFile)) { $LedgerFile }
                  else { Join-Path (Get-Location).Path $LedgerFile }
}

# ── 字面判据（提成 script 级常量：同一判据抄两处，迟早只改一处）────────────────
# 元字段字面：[n=<数字|?> @<MM-DD> 触发:<非右方括号串>]
$script:MetaFieldPattern = '\[n=(\d+|\?) @(\d{2}-\d{2}) 触发:([^\]]+)\]'
# 条款签名（Marked 模式的选择器）：**刻意比完整元字段弱** —— 用 `[n=` 开头即算"自称条款"，
# 于是「字段写坏了」的行仍进得了扫描面、被检查 3 判红。若这里也用完整 pattern，
# 检查 3 就成了一句永远为真的废话（选择器与判据同一个东西）。
$script:ClauseSignaturePattern = '\[n='
# **v2 的选择器判据**（批 2 · 台账搬家）：`[n=` 之外，`[基线:` / `[自定@` / 行内 slug 同样算
# 「这一行自称是条款」。v1 只认 `[n=`，于是「带基线或自定标记却没有完整签名」的行**结构上看不见**
# —— 可达性矩阵实测 dao.md 3 条、dao-longwindow.md 2 条，全是承重条款。
$script:LedgerSignaturePattern = '\[n=|\[基线:|\[自定@'
# 行内 slug：条款与 clause-ledger.json 的关联键。取值允许中文（`[#帅-热重载]` 是给人看的），
# 唯一形式约束是不含空白与右方括号 —— 否则「一行两个 slug」与「一个带空格的 slug」分不开。
$script:SlugPattern = '\[#([^\]\s]+)\]'
# 行内代码 span：`` `…` ``。正文里写 `[自定@<月日>]` 是在讲**格式**，不是一个标记；
# 不遮罩会给立法存根凭空造一个台账条目（矩阵实测的那个假阳性）。
$script:CodeSpanPattern = '`[^`]*`'
# 节标题判据：**锚到行首**。mousse 侧原写法是 `-match '📌'`（匹配任意位置）⇒ 正文里任何一行
# 出现这个装饰字符，从那行起整段被当特殊节跳过，实测 70 条静默缩到 34 条（issue #285）。
$script:SpecialSectionPattern  = '^##\s*📌'
$script:ObservationZonePattern = '^##\s*观察区'
$script:BaselinePattern     = '\[基线:([^\]]+)\]'
$script:SelfAuthoredPattern = '\[自定@(\d{2}-\d{2})\]'
$script:JudgeOnlyMark  = '[仅判据·无触发]'
$script:ObservingMark  = '[观察中]'

function Get-BacktickRuns {
    <#
      把一行里的**反引号游程**扫出来（起点 + 长度）。单独成函数是因为遮罩与
      「未闭合游程」观察线都要它，而判据只该写一遍。
      返回 [PSCustomObject]@{ Start; Len } 序列，按出现次序；调用方一律 `@(...)` 收。

      ⚠ **返回值别写成 `return ,@($runs)`**：那样调用方再套一层 `@()` 会得到
        「一个元素、该元素是数组」的嵌套结构 ⇒ `.Count` 恒为 1、`.Len` 恒为 $null
        ⇒ 配对循环一次都进不去、**整行一个字都不遮罩**。本函数初版就是这么写的，
        表现是「目标用例修好了」（元字段不再被吃）而**闭合 span 的遮罩全线失效**，
        靠逐行 A/B 老新两版才现形 —— 一个「看起来修好了」的假绿。
    #>
    param([string]$Raw)

    $runs = @()
    $i = 0
    while ($i -lt $Raw.Length) {
        if ($Raw[$i] -eq '`') {
            $start = $i
            while ($i -lt $Raw.Length -and $Raw[$i] -eq '`') { $i++ }
            $runs += [PSCustomObject]@{ Start = $start; Len = ($i - $start) }
        } else {
            $i++
        }
    }
    return $runs
}

function Get-BacktickSpans {
    <#
      按 **CommonMark 的游程配对规则**把游程配成代码 span：
      一个长度为 L 的开启游程，由**其后第一个长度恰为 L** 的游程闭合；中间的游程都在
      span 内部（不再单独参与配对）。找不到等长游程的开启游程是**普通文本**，
      而扫描**继续往后走** —— 后面的游程照样能开新 span。

      返回 @{ Spans = @(@{From;To}); Unmatched = @(游程起点…) }。
    #>
    param([string]$Raw)

    $runs = @(Get-BacktickRuns -Raw $Raw)
    $spans = @()
    $unmatched = @()
    $r = 0
    while ($r -lt $runs.Count) {
        $open = $runs[$r]
        $closeIdx = -1
        for ($k = $r + 1; $k -lt $runs.Count; $k++) {
            if ($runs[$k].Len -eq $open.Len) { $closeIdx = $k; break }
        }
        if ($closeIdx -lt 0) {
            # 没有等长游程闭合它 ⇒ 这串反引号是字面文本，不是分隔符。
            $unmatched += $open.Start
            $r++
            continue
        }
        $close = $runs[$closeIdx]
        $spans += [PSCustomObject]@{ From = $open.Start; To = ($close.Start + $close.Len - 1) }
        $r = $closeIdx + 1
    }
    return @{ Spans = @($spans); Unmatched = @($unmatched) }
}

function Get-MaskedLine {
    <#
      把行内代码 span 换成**等长空格**。等长是硬要求不是讲究：下游拿遮罩串上的
      `Groups[k].Index/.Length` 回**原始串**切值，长度一变下标就错位。

      为什么必须回原始串切值、不能直接用遮罩串：合法的基线正文里就带反引号
      （`归-根路径消歧` 那条的基线写着「本文件 9 处裸 `docs/`」），直接取遮罩串会把
      那段吃成空格，写进台账就成了一句缺字的话。

      ── 未闭合反引号：2026-08-02 反转了处置，理由照直写 ──────────────────────
      **旧行为**：从未闭合的那个反引号起，到行尾一律当代码。头注当时写的理由是
      「刻意选的失败方向 —— 多认一个标记会凭空造出台账条目，少认一个会被
      orphan-ledger 从另一侧报出来」。**那个理由经不起实测，两半都不成立**：
        ① 「少认一个」的实际后果不是漏报，是**对一条完全合法的条款判红**。
           实测锚：mousse `docs/rules/dispatch-clauses.md` 行 147（正文写了一处
           ```bash 的写法示例 ⇒ 21 个反引号、游程未闭合）行尾元字段完整，
           `-ClauseSelector AllTopLevel` 下被整段遮成空格 ⇒ `missing-meta-field`、exit 1。
        ② 「会被另一侧报出来」只在**接了台账的文件**上成立。没接台账的条款库
           （mousse 那份、任何项目自己的规则集）**根本没有另一侧**；而 Marked 模式下
           后果更坏 —— 选择器本身读的就是遮罩串，签名被吃掉 ⇒ 该行**整条退出扫描面**，
           检查器**静默转绿**（同一份夹具实测：AllTopLevel exit 1 / Marked exit 0）。
           这正是本脚本检查 5 要防的那个病，发生在它自己的解析层里。
        ③ 检查 5b 抓不到 ②，因为普查（Get-ClauseCensus）与检出走的是**同一个**
           Get-MaskedLine ⇒ 两半一起瞎、集合差恒为 0。
           照 dao-guard-writing「自检那一半绝不能复用被守对象的解析逻辑」，
           这是那条规则在本文件里的一个现存缺口 —— **本批未修**（见 .NOTES）。

      **新行为**：按 CommonMark 的游程配对（见 Get-BacktickSpans）——
      未闭合的游程是**普通文本**，不遮罩。判据取舍：**「合法条款不许被误判」
      优先于「代码 span 假阳性」**（派单方定的优先级），且新行为与**人在渲染页面上
      看到的东西一致** —— 未闭合的反引号在 GitHub 上就是显示为字面反引号，
      那里的 `[自定@…]` 读者看着是真标记，检查器也就该当它是真标记。

      **新行为让出的那一格，照直写**：一行里有**未闭合**游程、其后又跟着一个
      模板字面量（`[自定@<月日>]` 之类）时，那个字面量现在会被当成真标记 ⇒
      可能凭空多出一个 `[自定]` 计数或一个 orphan-slug。两点补偿：
        · 它要求正文本身是**坏 markdown**（未闭合 span），渲染出来也是坏的；
        · 失败是**响的**（多一条 violation / 统计里多一个数），不是静默的 —— 而旧行为
          在 Marked 模式下的失败是静默转绿。
        · 统计段另加一行观察线，把「未闭合游程 + 该行带条款签名」这个模糊地带打印出来
          （实测全域分布：dao.md 0 行、7 份真实规则文件合计 1 行，噪音极低）。
      **闭合的**代码 span 照旧遮罩 —— 原先要防的那个假阳性（反引号里的模板字面量）
      **防护不变**，回归网两侧都有断言。
    #>
    param([string]$Raw)

    $info = Get-BacktickSpans -Raw $Raw
    if ($info.Spans.Count -eq 0) { return $Raw }

    # 等长保证：只把 span 覆盖的字符换成空格，不增删任何字符。
    $out = $Raw.ToCharArray()
    foreach ($s in $info.Spans) {
        for ($p = $s.From; $p -le $s.To; $p++) { $out[$p] = ' ' }
    }
    return (-join $out)
}

function Get-GroupValue {
    <# 在遮罩串上定位、回原始串取值。组没参与匹配时返回 $null。 #>
    param([string]$Raw, [System.Text.RegularExpressions.Group]$Group)
    if ($null -eq $Group -or -not $Group.Success) { return $null }
    return $Raw.Substring($Group.Index, $Group.Length)
}

function Get-ClauseNBucket {
    <#
      `n` 取值 → 归桶。**数值判定，不是字符串相等**。
      mousse 侧原写法三处各写一遍字符串比较（`-eq '1'` / `-eq '?'` / 补集 `-ne '1' -and -ne '?'`），
      于是 `n=0`、`n=01` 两个退役栏都进不去、还被补集**假报成 `n>=2`**（issue #286）——
      「已知零次」被归进「有复发证据、退出审查面」那一栏。
      根因不是少写一个分支，是**补集判据**：所有没想到的取值都被倒进最后一个桶，
      而那个桶恰好叫「有复发证据」。凡「其余都算 X」型归桶，都要问一句"倒进来的到底是什么"。

      返回值恰为四者之一（调用点可穷举，不需要 else 兜底）：
        'unknown' `?`：未标次数，无从推断（≠ 零次，也 ≠ 多次）
        'zero'    0：已知零次
        'one'     1：单例立法
        'multi'   >=2
      $null 输入（该行压根没有完整元字段）返回 $null —— 由检查 3 负责报它，本函数不替它编一个桶。
    #>
    param([string]$N)

    if ([string]::IsNullOrEmpty($N)) { return $null }
    if ($N -eq '?') { return 'unknown' }
    # `-as [long]` 而非 [int]：正则放行 `\d+`、位数不设上限。转换失败只可能是十进制位数
    # 超出 Int64 ⇒ 真实数值必然远大于 2，归 'multi' 是正确归位而非兜底。
    # [int] 在同样输入下会抛，且 $ErrorActionPreference='Stop' 下直接炸掉整个守卫——
    # 一个荒谬的取值不该让守卫本身停摆。
    $v = $N -as [long]
    if ($null -eq $v) { return 'multi' }
    if ($v -le 0) { return 'zero' }
    if ($v -eq 1) { return 'one' }
    return 'multi'
}

function Test-ClauseLineSelected {
    <#
      选择器的**唯一判据源**（检出与普查两侧都读它，判据只写一遍）。
      Marked      ⇒ 行内含任一台账字段（`[n=` / `[基线:` / `[自定@`）**或** slug，不论形态；
                    行内代码 span 里的一律不算（调用方传的 $Masked 已遮罩）。
      AllTopLevel ⇒ 零缩进 `- ` 行，不论有没有字段（这样才检得出「整条丢字段」）。
    #>
    param([string]$Raw, [string]$Masked, [string]$Selector)

    if ($Selector -eq 'AllTopLevel') { return $Raw.StartsWith('- ') }
    return ([regex]::IsMatch($Masked, $script:LedgerSignaturePattern) -or
            [regex]::IsMatch($Masked, $script:SlugPattern))
}

function Get-LineShape {
    param([string]$Raw)
    if ($Raw.StartsWith('- ')) { return 'top' }
    if ($Raw -match '^\s+-\s')  { return 'indent' }
    return 'prose'
}

function Get-ClauseRecords {
    <#
      抽出全部条款记录（行号 / 原文 / 形态 / 所属区 / 元字段解析结果）。
      本函数是检查 3/4 与统计段的**单一判据源** —— 多处各写一遍判据，迟早出现
      「闸放行了但统计没算它」这类自相矛盾。

      Zone：'clause'（正式条款）/ 'observation'（观察区候选）。
      📌 特殊节**整节跳过**（不产出记录）；观察区**照常产出**但打 Zone 标 ——
      观察区条目要被检查 4 与「⬆ 待升格」看见，只是不进条款统计。

      $SectionPattern 非空时另加一层节白名单：不匹配的 `##` 节内一律不产出记录
      （被排除的行数由普查函数单独数出来并打印，见检查 5）。
    #>
    param([string[]]$Lines, [string]$Selector, [string]$SectionFilter)

    $records = @()
    $inFence = $false
    $inSpecialSection = $false
    $inObservationZone = $false
    # 白名单未启用时恒 true；启用时在遇到第一个 `##` 之前（前言区）视为**不在白名单内**——
    # 白名单的语义是"只看这几节"，前言不是节。
    $sectionAllowed = [string]::IsNullOrWhiteSpace($SectionFilter)

    for ($i = 0; $i -lt $Lines.Count; $i++) {
        $raw = $Lines[$i]
        $t = $raw.Trim()
        if ($t -match '^```') { $inFence = -not $inFence; continue }
        if ($inFence) { continue }
        if ($t -match '^##\s') {
            $inSpecialSection  = ($t -match $script:SpecialSectionPattern)
            $inObservationZone = ($t -match $script:ObservationZonePattern)
            if (-not [string]::IsNullOrWhiteSpace($SectionFilter)) {
                $sectionAllowed = ($t -match $SectionFilter)
            }
            continue
        }
        if ($inSpecialSection) { continue }
        if (-not $sectionAllowed) { continue }
        $masked = Get-MaskedLine -Raw $raw
        if (-not (Test-ClauseLineSelected -Raw $raw -Masked $masked -Selector $Selector)) { continue }

        $rec = [PSCustomObject]@{
            LineNo    = $i + 1
            Text      = $t
            Shape     = (Get-LineShape -Raw $raw)
            Zone      = $(if ($inObservationZone) { 'observation' } else { 'clause' })
            HasField  = $false
            N         = $null
            NBucket   = $null
            MonthDay  = $null
            Trigger   = $null
            JudgeOnly = $masked.Contains($script:JudgeOnlyMark)
            Observing = $masked.Contains($script:ObservingMark)
            Baseline  = $null
            SelfDate  = $null
            SelfDates = @()
            Slug      = $null
            SlugCount = 0
        }
        $m = [regex]::Match($masked, $script:MetaFieldPattern)
        if ($m.Success) {
            $rec.HasField = $true
            $rec.N        = Get-GroupValue -Raw $raw -Group $m.Groups[1]
            # 归桶在这里算一次、存在记录上；**所有消费方一律读 NBucket，不再自己比字符串**
            # （issue #286 的根因之一正是同一份归桶判据被抄了三处）。
            $rec.NBucket  = Get-ClauseNBucket -N $rec.N
            $rec.MonthDay = Get-GroupValue -Raw $raw -Group $m.Groups[2]
            $rec.Trigger  = Get-GroupValue -Raw $raw -Group $m.Groups[3]
        }
        $b = [regex]::Match($masked, $script:BaselinePattern)
        if ($b.Success) { $rec.Baseline = (Get-GroupValue -Raw $raw -Group $b.Groups[1]).Trim() }
        # 自定标记**观察区也解析**：那里的候选同样可能是 AI 自定放进去的，
        # 而回溯面的价值恰恰在于「AI 未经批准写进规则集的东西，一条都不能不可见」。
        # **收全部不只收第一个**：dao.md 有一行写着 `[自定@07-29] [自定@07-30]`，只取第一个
        # 会静默丢掉一个日期，而那个日期正是「按日期整批撤回」这份授权对价的抓手。
        $selfAll = @()
        foreach ($sm in [regex]::Matches($masked, $script:SelfAuthoredPattern)) {
            $selfAll += (Get-GroupValue -Raw $raw -Group $sm.Groups[1])
        }
        $rec.SelfDates = $selfAll
        if ($selfAll.Count -gt 0) { $rec.SelfDate = $selfAll[0] }
        $slugAll = @()
        foreach ($sg in [regex]::Matches($masked, $script:SlugPattern)) {
            $slugAll += (Get-GroupValue -Raw $raw -Group $sg.Groups[1])
        }
        $rec.SlugCount = $slugAll.Count
        # 一行多个 slug 是结构错（关联键必须唯一）⇒ 这里**不替它挑一个**，留 $null 由检查 6 判红。
        if ($slugAll.Count -eq 1) { $rec.Slug = $slugAll[0] }
        $records += $rec
    }
    return $records
}

function Get-ClauseCensus {
    <#
      **扫描面的分母**（检查 5 用）：不看节、不看区、不做任何状态跟踪，只回答
      「这份文件里，长得像条款的行一共有几行、分别在哪」。

      刻意与 Get-ClauseRecords **不共享任何状态机**（除代码围栏——围栏内是文档样例，
      两边必须一致地不算数）。这是本函数存在的全部意义：它是那个状态机的**独立第二意见**。
      若它复用 $inSpecialSection / $sectionAllowed，节判定一错两边一起错、集合差恒为 0，
      检查 5 就变成一句永远为真的废话 ——「拿被测对象自己当基线」。

      三个集合：
        Selected —— 按当前选择器算，**且带完整元字段**的行。它应与 Get-ClauseRecords 的
                    检出逐行相等；少了谁 ⇒ 被节状态（📌 节 / 节白名单）吞掉了。
                    ⚠ 这里用**完整**元字段而非 `[n=` 签名，是为了让「字段写坏」只由检查 3
                    报一次，不在检查 5 里再报一次同一行（同一个缺陷两处报会让人以为是两件事）。
        Indented —— `^\s+- ` 且带完整元字段。仅 AllTopLevel 模式下算违规。
        AllTop   —— 零缩进 `- ` 行总数（不论有无字段）。只用于统计段打印「选择器排除了几行」，
                    不参与任何断言。它是 Marked 模式弱射程的可见面。
    #>
    param([string[]]$Lines, [string]$Selector)

    $selected = @()
    $indented = @()
    $allTop = 0
    $inFence = $false
    for ($i = 0; $i -lt $Lines.Count; $i++) {
        $raw = $Lines[$i]
        $t = $raw.Trim()
        if ($t -match '^```') { $inFence = -not $inFence; continue }
        if ($inFence) { continue }
        if ($raw.StartsWith('- ')) { $allTop++ }
        $masked = Get-MaskedLine -Raw $raw
        # **v2 的分母判据**：完整元字段**或** slug。加 slug 是必须的 —— 批 2 之后一条条款
        # 可以只有 slug 而无行内元字段（台账在 ledger 里），只按完整字段数分母的话，
        # 那批条款一旦被 📌 节吞掉，检查 5b 完全看不见（分母里本来就没有它们）。
        # 仍**不用**弱签名 `[n=`：那样「字段写坏」会被检查 3 与检查 5 各报一次，同一个缺陷
        # 报成两件事，人会去找两个 bug。
        $hasFull = [regex]::IsMatch($masked, $script:MetaFieldPattern)
        $hasSlug = [regex]::IsMatch($masked, $script:SlugPattern)
        $shaped  = $hasFull -or $hasSlug
        if ($shaped -and (Test-ClauseLineSelected -Raw $raw -Masked $masked -Selector $Selector)) {
            $selected += [PSCustomObject]@{ LineNo = ($i + 1); Text = $t }
        }
        if ($shaped -and ($raw -match '^\s+-\s')) {
            $indented += [PSCustomObject]@{ LineNo = ($i + 1); Text = $t }
        }
    }
    return [PSCustomObject]@{ Selected = @($selected); Indented = @($indented); AllTop = $allTop }
}

function Get-ClauseLedger {
    <#
      读台账（`ccswitch/clause-ledger.json`）。返回 @{ Ok; Why; Entries（slug → 条目）}。

      **刻意不 import node 侧那份解析**：两套实现对同一份数据各读一遍，才有 `--reconcile` 的
      判别力（同本文件与 clause-parser.mjs 的既有关系）。共享的是 JSON 这个**外部契约**，
      不是实现。
      PS 5.1 的 ConvertFrom-Json 给的是 PSCustomObject（没有 -AsHashtable），
      故这里自己转成 Hashtable —— 下游一律按 key 取，不做属性名反射。
    #>
    param([string]$Path)

    if (-not (Test-Path $Path)) { return @{ Ok = $false; Why = '不存在'; Entries = @{} } }
    try {
        $doc = [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
    } catch {
        return @{ Ok = $false; Why = ('不是合法 JSON：' + $_.Exception.Message); Entries = @{} }
    }
    if ($null -eq $doc -or $null -eq $doc.clauses) {
        return @{ Ok = $false; Why = '缺 clauses 字段'; Entries = @{} }
    }
    $entries = @{}
    foreach ($p in $doc.clauses.PSObject.Properties) { $entries[$p.Name] = $p.Value }
    return @{ Ok = $true; Why = ''; Entries = $entries }
}

function Test-LedgerFileMatch {
    <#
      台账条目的 `file`（仓内相对路径，正斜杠）是不是指着当前被检文件。
      判据是**后缀匹配**：守卫可以被从任意 cwd、用绝对路径调起来，写死相对路径必然对不上。
      两侧都归一成正斜杠再比；只比后缀的代价照直写 —— 两份同名文件在不同目录时会误判为同一份，
      本仓无此形态（11 个源文件名互不相同），有了再收紧。
    #>
    param([string]$LedgerPath, [string]$ActualPath)
    if ([string]::IsNullOrWhiteSpace($LedgerPath)) { return $false }
    $a = $ActualPath.Replace('\', '/')
    $b = $LedgerPath.Replace('\', '/')
    return $a.EndsWith($b)
}

function Resolve-ClauseDate {
    <#
      `@` 字段只有月日没有年份 ⇒ 要挑一个年份。判据：**在 {去年, 今年, 明年} 三个候选里，
      取「不超过未来宽限窗」的那些当中离今天最近的一个**。

      —— 为什么不是「不在未来就取今年，否则减一年」——
      mousse 侧 2026-07-27 实测的假阳性：一条 `@07-28` 的新条款（写它的人按 07-28 记日期，
      本机时钟走到 07-27）被报成「入库 **365** 天」并进了候选退役区。两个缺陷叠加：
        ① 年份判定**零宽限** —— 差一秒就整整回退一年。
        ② 年龄用 `[int](...)` 对**带时分秒**的差值取整 —— `[int]` 是四舍五入不是截断，
           364.5 → 365；且「今天入库」的条款在午后会显示成「入库 1 天」，`>21` 的门实际
           在 20.5 天就开。修法：两侧都取 `.Date` 后相减，差值是精确整数天。

      已知近似（两向都构造得出反例，不声称穷尽）：
        · 跨年超过 12 个月的条款仍会被低估年龄（候选年份只取三个）。
        · `@02-29` 只在三个候选年份里恰有闰年时才解析得出，否则返回 $null 被跳过。
    #>
    param([string]$MonthDay, [datetime]$Now, [int]$FutureGraceDays = 2)
    $parts = $MonthDay -split '-'
    if ($parts.Count -ne 2) { return $null }
    $graceLimit = $Now.Date.AddDays($FutureGraceDays)
    $best = $null
    foreach ($y in @(($Now.Year - 1), $Now.Year, ($Now.Year + 1))) {
        $c = $null
        try {
            $c = Get-Date -Year $y -Month ([int]$parts[0]) -Day ([int]$parts[1]) `
                -Hour 0 -Minute 0 -Second 0 -Millisecond 0
        } catch {
            $c = $null   # 2 月 30 日 / 平年 2 月 29 日：不猜，这个候选年直接弃
        }
        if ($null -eq $c) { continue }
        if ($c.Date -gt $graceLimit) { continue }
        if ($null -eq $best -or $c -gt $best) { $best = $c }
    }
    return $best
}

function Get-ClauseAgeDays {
    param([datetime]$Now, [datetime]$Entered)
    $days = [int]($Now.Date - $Entered.Date).TotalDays
    if ($days -lt 0) { return 0 }
    return $days
}

function Get-AgedRecords {
    <#
      从一批记录里捞出「入库超过 Threshold 天」的，附上年龄。
      **单一判据源**：候选退役区三栏 + 观察区久未复发三栏共六处都走这里，年龄门槛的语义
      （`-gt` ⇒ 满 Threshold+1 天）只写一遍。mousse 侧原实现把这段内联在退役区的 foreach 里，
      而那个 foreach **只遍历 `n=1`** —— 抽成函数正是为了让「喂哪一批进来」变成调用点的
      显式选择，而不是藏在一个变量名里。
    #>
    param([object[]]$Records, [datetime]$Now, [int]$Threshold, [int]$Grace)
    $out = @()
    foreach ($c in @($Records)) {
        $d = Resolve-ClauseDate -MonthDay $c.MonthDay -Now $Now -FutureGraceDays $Grace
        if ($null -eq $d) { continue }
        $age = Get-ClauseAgeDays -Now $Now -Entered $d
        if ($age -gt $Threshold) {
            $out += [PSCustomObject]@{ LineNo = $c.LineNo; Age = $age; Text = $c.Text }
        }
    }
    return $out
}

function Write-AgedBucket {
    <#
      打印一栏「够老了，去看一眼」：条数 + 最大年龄（**始终全量**）+ 至多 Max 条明细
      （超了按日期确定性轮转折叠）。恒不返回、恒不影响退出码 —— 观察线的输出面。
      轮转基底取 `Text` 而不是年龄：拿每天都在变的字段做基底，覆盖面无从谈起；
      且过门槛后年龄不再有判别力（26 天与 30 天同样是"够老了"）。
    #>
    param([string]$Header, [object[]]$Items, [int]$Max, [string]$Note)

    $all = @($Items)
    if ($all.Count -eq 0) {
        Write-Host ("  {0}：0 条" -f $Header)
        return
    }
    $maxAge = 0
    foreach ($it in $all) { if ($it.Age -gt $maxAge) { $maxAge = $it.Age } }
    Write-Host ("  {0}：{1} 条（最久 {2} 天）—— {3}" -f $Header, $all.Count, $maxAge, $Note)

    $ordered = @($all | Sort-Object Text)
    $shown   = $ordered
    $rotated = $false
    if ($Max -gt 0 -and $ordered.Count -gt $Max) {
        $rotated = $true
        $n = $ordered.Count
        # 固定纪元 + 取模：同一天多次运行结果完全相同（可复现、可对账），跨天前进 Max 个。
        $dayIndex = [int]((Get-Date).Date - ([datetime]'2026-01-01')).TotalDays
        $start = ((($dayIndex * $Max) % $n) + $n) % $n
        $shown = @()
        for ($k = 0; $k -lt $Max; $k++) { $shown += $ordered[(($start + $k) % $n)] }
    }
    foreach ($r in $shown) {
        Write-Host ("    · 行 {0}（入库 {1} 天）：{2}" -f `
            $r.LineNo, $r.Age, $r.Text.Substring(0, [Math]::Min(56, $r.Text.Length)))
    }
    if ($rotated) {
        $cycle = [int][Math]::Ceiling($ordered.Count / [double]$Max)
        # ⚠️ 「约 N 天」只在**成员恒定**时成立；起始位是 `dayIndex*Max mod n`，n 一变相位就跳
        #    ⇒ 覆盖被拉长（mousse 侧实测最坏 81~132 天）。不带限定语地打印这个数字，
        #    正是「禁笃定措辞」要防的形态 —— 人只读输出，不读 .PARAMETER。
        # ⚠️ 刻意先拼成变量再 `-f`：PowerShell 里 `"a" + "b" -f $x` 被解析成 `"a" + ("b" -f $x)`，
        #    前半段的 {0}/{1} 不会被替换、输出字面的 "{0}"，且**不报错、退出码干净**。
        $rotateNote = "      ↳ 今日只列 {0}/{1} 条（按日期确定性轮转；成员恒定时约 {2} 天轮完一遍，" +
            "增删条款会让相位跳变、覆盖被拉长；同一天多次运行结果相同）。全量：-RetireListMax 0"
        Write-Host ($rotateNote -f $Max, $ordered.Count, $cycle)
    }
}

function Format-Summary {
    <#
      末行 marker：**纯 ASCII 键值**，给程序读。理由见下方 $script:SumRetire 那段注释。
      恒定输出（通过与失败都打）—— marker 缺席本身就是消费方可判的异常状态。
    #>
    param([int]$ExitCode, [int]$Clauses, [int]$Violations)
    # v2 三个新字段一律**追加在末尾**：消费方（dao-scaffold-check.js / gen-clause-index.mjs）
    # 的正则不锚定行尾，追加不会让它们匹配失败 —— 而插在中间会。
    return ('CLAUSE_STRUCTURE_SUMMARY exit={0} clauses={1} violations={2} notrigger={3} retire={4} promote={5} slugs={6} ledger={7} ledgerviol={8}' `
        -f $ExitCode, $Clauses, $Violations, $script:SumNoTrig, $script:SumRetire, $script:SumPromote,
           $script:SumSlugs, $script:SumLedgerState, $script:SumLedgerViol)
}

function Test-ClausesStructure {
    param([string[]]$Lines, [object[]]$Records, [object]$Census, [string]$Selector,
          [hashtable]$WhitelistExcluded, [hashtable]$Ledger, [bool]$LedgerActive, [string]$TargetPath)

    $violations = @()

    # ---- 检查 1：焊接签名（。：）—— 全文（含 blockquote），围栏内除外 ----------
    $inFence = $false
    for ($i = 0; $i -lt $Lines.Count; $i++) {
        $t = $Lines[$i].Trim()
        if ($t -match '^```') { $inFence = -not $inFence; continue }
        if ($inFence) { continue }
        if ($Lines[$i].Contains('。：')) {
            $violations += [PSCustomObject]@{ Type = 'welded-signature'; LineNo = ($i + 1); Content = $t }
        }
    }

    # ---- 检查 2：孤儿条款 —— 仅 AllTopLevel 模式（理由见 .DESCRIPTION）--------
    if ($Selector -eq 'AllTopLevel') {
        $inFence = $false
        $inSpecialSection = $false
        $paragraphOpen = $false
        for ($i = 0; $i -lt $Lines.Count; $i++) {
            $raw = $Lines[$i]
            $t = $raw.Trim()
            if ($t -match '^```') { $inFence = -not $inFence; $paragraphOpen = $false; continue }
            if ($inFence) { continue }
            if ($t -match '^##\s') {
                # 与 Get-ClauseRecords 走同一个 $script:SpecialSectionPattern ——
                # issue #285 那个 bug 在 mousse 版里是**两处**同样的写法，「一类错不是一处错」。
                $inSpecialSection = ($t -match $script:SpecialSectionPattern)
                $paragraphOpen = $false
                continue
            }
            if ($t -match '^#\s') { $paragraphOpen = $false; continue }   # H1
            if ($t -eq '')        { $paragraphOpen = $false; continue }   # 空行 = 段落边界
            if ($t -match '^>')   { $paragraphOpen = $false; continue }   # 引用块整体豁免
            if (-not $paragraphOpen) {
                $paragraphOpen = $true
                if ((-not $inSpecialSection) -and $t.StartsWith('**') -and (-not $t.StartsWith('- '))) {
                    $violations += [PSCustomObject]@{ Type = 'orphan-clause'; LineNo = ($i + 1); Content = $t }
                }
            }
        }
    }

    # ---- 检查 3/4：元字段缺失 / [仅判据·无触发] 缺失 / [观察中] 标记错位 -------
    foreach ($c in $Records) {
        $snippet = $c.Text.Substring(0, [Math]::Min(48, $c.Text.Length))
        if (-not $c.HasField) {
            # **v2 双轨期的例外**：带 slug 且台账里确有这一条 ⇒ n/首次入库/触发点由台账供，
            # 行内没有它们不是缺陷。台账里没有 ⇒ 由检查 6 的 orphan-slug 报（不在这里重复报）。
            if ($c.Slug -and $LedgerActive -and $Ledger.ContainsKey($c.Slug)) { continue }
            $violations += [PSCustomObject]@{
                Type = 'missing-meta-field'; LineNo = $c.LineNo
                Content = ('缺 [n=… @… 触发:…] 字段（或字段格式不合法），且没有可回落的台账 slug → ' + $snippet)
            }
            continue
        }
        if ($c.Zone -eq 'observation') {
            # 观察区：必须带 [观察中]；豁免 [仅判据·无触发]（两个标签表达同一件事，并列只是噪音）
            if (-not $c.Observing) {
                $violations += [PSCustomObject]@{
                    Type = 'observation-missing-tag'; LineNo = $c.LineNo
                    Content = ('观察区条目缺 [观察中] 标记（会被当成正式条款摘走）→ ' + $snippet)
                }
            }
            continue
        }
        if ($c.Trigger -eq '无' -and -not $c.JudgeOnly) {
            $violations += [PSCustomObject]@{
                Type = 'missing-judge-only-tag'; LineNo = $c.LineNo
                Content = ('触发:无 但缺 [仅判据·无触发] 标记 → ' + $snippet)
            }
        }
        if ($c.Observing) {
            $violations += [PSCustomObject]@{
                Type = 'stray-observing-tag'; LineNo = $c.LineNo
                Content = ('观察区外残留 [观察中] 标记（升格时只搬位置没撕标签？）→ ' + $snippet)
            }
        }
    }

    # ---- 检查 5：扫描面塌陷（下限断言）----------------------------------------
    # a) 零样本：一条都没选中。此时上面所有检查都会"零违例"，而那个绿是空的。
    if ($Records.Count -eq 0) {
        # ⚠️ 先拼模板再 `-f`：`"a{0}" -f $x + "b"` 会被解析成 `"a{0}" -f ($x + "b")`
        #    （`+` 比 `-f` 结合得紧），静默给出错的输出。
        $zeroMsg = '整份扫描面为空：一条条款都没选中（选择器 {0}；文件内带完整元字段且合选择器的行 {1} 行）。' +
                   '「零违例」在这种状态下与「没看见」不可区分，故判红。'
        $violations += [PSCustomObject]@{
            Type = 'zero-sample'; LineNo = 0
            Content = ($zeroMsg -f $Selector, $Census.Selected.Count)
        }
    }

    # b) 被节状态吞掉：带条款签名的行不在检出集合里 ⇒ 落在某个 📌 节内。
    #
    # **`-SectionPattern` 主动排除的那些不算违规，但也不许静默**（2026-08-01 定，本条是本脚本
    # 里唯一一处"闸位取舍"，写清楚免得下一个人以为是漏判）：
    #   · 📌 节吞掉条款 ⇒ **代码/结构错了**（没人打算让它消失）⇒ 硬闸。
    #   · 操作者显式传 `-SectionPattern` 把某几节排除在外 ⇒ **那是他自己要的**，不是错误 ⇒
    #     观察线：由统计段打印「节白名单排除了 N 条带签名的行」，人看得见就行。
    # ⚠ **代价照直写**：传了 `-SectionPattern` 之后，被排除区间里的 📌 吞没**就检不出来了**
    #   （两者在这里合并成同一类）。默认路径（不传该参数）**不受影响**、硬闸完整——
    #   而默认路径正是 hook 与 CI 走的那一条。
    # $WhitelistExcluded 的算法：拿同一个 Get-ClauseRecords **再跑一遍、只把 SectionFilter 清空**，
    # 两次检出的差即"被白名单排除的"。刻意复用同一个函数而不另写一份节遍历：
    # 判据只写一遍，不制造第二处可以单独腐坏的副本。
    # ⚠ 检出集合的判据必须与普查（Get-ClauseCensus）**同口径**：那边 v2 起数「完整元字段**或**
    #   slug」，这边只数 HasField 的话，三条「只有 slug」的真条款会被算成「普查看得见而检出没有」
    #   ⇒ 报成 swallowed-by-section 假阳性（本次改造当场踩到，实测 dao.md 3 条）。
    #   **两半判据不同才有判别力，口径不同只有假警报** —— 独立的是「怎么走扫描面」，不是「什么算样本」。
    $detected = @{}
    foreach ($r in $Records) { if ($r.HasField -or $r.SlugCount -gt 0) { $detected[$r.LineNo] = $true } }
    foreach ($line in $Census.Selected) {
        if ($detected.ContainsKey($line.LineNo)) { continue }
        if ($WhitelistExcluded -and $WhitelistExcluded.ContainsKey($line.LineNo)) { continue }
        $violations += [PSCustomObject]@{
            Type = 'swallowed-by-section'; LineNo = $line.LineNo
            Content = ('该行带完整元字段或 slug 且合当前选择器（＝条款签名），却未被检出 → 它落在某个 📌 节内。' +
                       '要么节判定错了，要么条款被写进了 📌 节。' +
                       '样例请包进 ``` 围栏或把取值写成 <占位符> 形态 → ' +
                       $line.Text.Substring(0, [Math]::Min(40, $line.Text.Length)))
        }
    }

    # c) 缩进错位 —— **仅 AllTopLevel 模式**：该模式顶层判据是 `^- `，缩进子项永远看不见
    #    ⇒ 存在即脱闸。Marked 模式下缩进条款是合法形态（dao.md 实测 7 条），不报。
    if ($Selector -eq 'AllTopLevel') {
        foreach ($line in $Census.Indented) {
            $violations += [PSCustomObject]@{
                Type = 'indented-clause'; LineNo = $line.LineNo
                Content = ('带元字段的**缩进**列表项：AllTopLevel 的顶层判据是 `^- `（零缩进），此行永远进不了任何' +
                           '检查与统计（要收编它请改用 -ClauseSelector Marked）→ ' +
                           $line.Text.Substring(0, [Math]::Min(40, $line.Text.Length)))
            }
        }
    }

    # ---- 检查 6：正文 slug ↔ 台账（clause-ledger.json）双向对账 ----------------
    # 四种命中形态全是**结构错**（指针指向空气 / 台账指着已删条款 / 条款进不了台账 /
    # 同一个字段两边说的不一样），没有一种需要现场取舍 ⇒ 硬闸。
    #
    # **激活判据（不激活时打印一行，不静默跳过）**：本文件有 slug，或台账里有指着本文件的条目。
    # 两样都没有 ⇒ 这份语料压根不在台账体系里（回归网夹具、别的仓的条款库），此时「零违例」
    # 是正常态。做成无条件激活的话，每个夹具都会被整本台账判成 orphan-ledger。
    if ($LedgerActive) {
        $seen = @{}
        foreach ($c in $Records) {
            if ($c.SlugCount -gt 1) {
                $violations += [PSCustomObject]@{
                    Type = 'dup-slug'; LineNo = $c.LineNo
                    Content = ('同一行出现 ' + $c.SlugCount + ' 个 slug —— 关联键必须唯一，否则台账指不到唯一一条')
                }
                continue
            }
            if (-not $c.Slug) {
                $violations += [PSCustomObject]@{
                    Type = 'missing-slug'; LineNo = $c.LineNo
                    Content = ('本文件已接入台账，而这一条没有 [#<域>-<短名>] ⇒ 台账对它失明 → ' +
                               $c.Text.Substring(0, [Math]::Min(40, $c.Text.Length)))
                }
                continue
            }
            if ($seen.ContainsKey($c.Slug)) {
                $violations += [PSCustomObject]@{
                    Type = 'dup-slug'; LineNo = $c.LineNo
                    Content = ('slug [#' + $c.Slug + '] 与行 ' + $seen[$c.Slug] + ' 重名')
                }
                continue
            }
            $seen[$c.Slug] = $c.LineNo
            if (-not $Ledger.ContainsKey($c.Slug)) {
                $violations += [PSCustomObject]@{
                    Type = 'orphan-slug'; LineNo = $c.LineNo
                    Content = ('正文写着 [#' + $c.Slug + ']，而台账里没有这一条 —— 指向空气的指针')
                }
                continue
            }
            $e = $Ledger[$c.Slug]
            if (-not (Test-LedgerFileMatch -LedgerPath $e.file -ActualPath $TargetPath)) {
                $violations += [PSCustomObject]@{
                    Type = 'ledger-file-mismatch'; LineNo = $c.LineNo
                    Content = ('[#' + $c.Slug + '] 台账记的 file 是 "' + $e.file + '"，而它实际出现在 ' + $TargetPath)
                }
            }
            # ── 双轨对账：**只比行内确实写着的那些字段** ──────────────────────
            # 行内没写的不参与（那不是「不等」，是「正文没这一栏」）；此时台账侧应为 null，
            # 台账反而有值 ⇒ 台账替正文编了一个值，同样判红。
            $pairs = @(
                @{ Name = 'n';          Mine = $c.N;        Theirs = $e.n },
                @{ Name = 'first_seen'; Mine = $c.MonthDay; Theirs = $e.first_seen },
                @{ Name = 'trigger';    Mine = $c.Trigger;  Theirs = $e.trigger },
                @{ Name = 'baseline';   Mine = $c.Baseline; Theirs = $e.baseline }
            )
            foreach ($p in $pairs) {
                $mine = $p.Mine; $theirs = $p.Theirs
                if ($null -eq $theirs) { $theirs = $null }
                if ([string]$mine -ne [string]$theirs) {
                    $violations += [PSCustomObject]@{
                        Type = 'ledger-mismatch'; LineNo = $c.LineNo
                        Content = ('[#' + $c.Slug + '] ' + $p.Name + ' 两轨不等：正文="' + $mine + '" 台账="' + $theirs + '"')
                    }
                }
            }
            $mineJO = [bool]$c.JudgeOnly
            $theirJO = [bool]$e.judge_only
            if ($mineJO -ne $theirJO) {
                $violations += [PSCustomObject]@{
                    Type = 'ledger-mismatch'; LineNo = $c.LineNo
                    Content = ('[#' + $c.Slug + '] judge_only 两轨不等：正文=' + $mineJO + ' 台账=' + $theirJO)
                }
            }
            $mineSelf  = (@($c.SelfDates) -join ',')
            $theirSelf = (@($e.self_authored) -join ',')
            if ($mineSelf -ne $theirSelf) {
                $violations += [PSCustomObject]@{
                    Type = 'ledger-mismatch'; LineNo = $c.LineNo
                    Content = ('[#' + $c.Slug + '] self_authored 两轨不等：正文="' + $mineSelf + '" 台账="' + $theirSelf + '"')
                }
            }
        }
        # 反向：台账有条目、正文找不到它的 slug。**只看指着本文件的那些条目** ——
        # 守卫一次只看一份文件，拿整本台账去对一份文件必然把别的文件的条款全报成孤儿。
        foreach ($slug in $Ledger.Keys) {
            $e = $Ledger[$slug]
            if ($e.status -eq 'retired') { continue }   # 已退役：正文本就该没有它
            if (-not (Test-LedgerFileMatch -LedgerPath $e.file -ActualPath $TargetPath)) { continue }
            if (-not $seen.ContainsKey($slug)) {
                $violations += [PSCustomObject]@{
                    Type = 'orphan-ledger'; LineNo = 0
                    Content = ('台账里有 [#' + $slug + ']（它说自己在 ' + $e.file + '），而正文里找不到这个 slug ' +
                               '—— 条款被删/改名而台账没跟上；确实要退役请把 status 改成 retired')
                }
            }
        }
    }

    return $violations
}

# ══════════════════════════════════════════════════════════════════════════════
if (-not (Test-Path $targetFile)) {
    Write-Host "目标文件不存在：$targetFile"
    exit 1
}

Write-Host '== 条款库结构完整性硬闸（canonical）=='
Write-Host ("   目标：{0}" -f $targetFile)
Write-Host ("   选择器：{0}{1}" -f $ClauseSelector,
    $(if ([string]::IsNullOrWhiteSpace($SectionPattern)) { '' } else { "　节白名单：$SectionPattern" }))

# ── 机器可读汇总（末行 marker）─────────────────────────────────────────────────
# 消费方（dao-scaffold-check.js hook）**只解析这一行**，不去正则匹配上面那些中文正文 ——
# 两个文件之间用中文文案当契约，正是「改被引用方一改、引用方静默失效」的现成温床。
# 纯 ASCII 键值、恒定输出（**通过与失败都打**）：marker 缺席本身就是一个可判的异常
# （消费方据此报「跑了但没拿到 summary」，而不是把"没解析到"当成"没问题"）。
$script:SumRetire  = 0   # 候选退役区三栏合计（观察线）
$script:SumPromote = 0   # ⬆ 待升格（观察线）
$script:SumNoTrig  = 0
$script:SumSlugs   = 0   # 本文件检出的 slug 数（--reconcile 的第三个对账量）
$script:SumLedgerState = 'na'   # ok | missing | bad | na（不适用）
$script:SumLedgerViol  = 0      # 检查 6 命中数（是硬闸的一部分，此处只是它的机器读出端）

$lines = [System.IO.File]::ReadAllLines($targetFile, [System.Text.Encoding]::UTF8)
# @() 强制数组化：函数输出恰好 1 个对象时 PowerShell 会自动解包成裸标量，裸标量的 .Count
# 静默返回 $null（`$null -gt 0` 恒 false）⇒ 单条违规被误判为"无违规"从而放行 ——
# 那正是本脚本要根治的静默失败同一种病，故自身必须先免疫。
$allRecords = @(Get-ClauseRecords -Lines $lines -Selector $ClauseSelector -SectionFilter $SectionPattern)
$census     = Get-ClauseCensus   -Lines $lines -Selector $ClauseSelector

# 节白名单排除面（只在传了 -SectionPattern 时才算）：同一个函数再跑一遍、SectionFilter 清空，
# 差集即"被白名单挡在外面的条款"。判据见 Test-ClausesStructure 检查 5b 那段注释。
$whitelistExcluded = @{}
if (-not [string]::IsNullOrWhiteSpace($SectionPattern)) {
    $detectedNow = @{}
    foreach ($r in $allRecords) { $detectedNow[$r.LineNo] = $true }
    foreach ($r in @(Get-ClauseRecords -Lines $lines -Selector $ClauseSelector -SectionFilter '')) {
        if (-not $detectedNow.ContainsKey($r.LineNo)) { $whitelistExcluded[$r.LineNo] = $true }
    }
}

# ── 台账（v2）：读 + 判激活 ────────────────────────────────────────────────────
# 激活判据两条**或**关系（见检查 6 注释）：本文件有 slug，或台账里有条目指着本文件。
# 「台账文件不在」而本文件确有 slug ⇒ 那些 slug 全是指向空气的指针，必须判红（不是跳过）。
$ledgerDoc = Get-ClauseLedger -Path $ledgerFile
$ledgerEntries = $ledgerDoc.Entries
$slugsHere = @($allRecords | Where-Object { $_.SlugCount -gt 0 }).Count
$script:SumSlugs = @($allRecords | Where-Object { $null -ne $_.Slug }).Count
$pointedHere = 0
foreach ($k in $ledgerEntries.Keys) {
    if (Test-LedgerFileMatch -LedgerPath $ledgerEntries[$k].file -ActualPath $targetFile) { $pointedHere++ }
}
$ledgerActive = ($slugsHere -gt 0) -or ($pointedHere -gt 0)
if (-not $ledgerActive) {
    $script:SumLedgerState = 'na'
} elseif ($ledgerDoc.Ok) {
    $script:SumLedgerState = 'ok'
} else {
    $script:SumLedgerState = $(if ($ledgerDoc.Why -eq '不存在') { 'missing' } else { 'bad' })
}

$violations = @(Test-ClausesStructure -Lines $lines -Records $allRecords -Census $census `
    -Selector $ClauseSelector -WhitelistExcluded $whitelistExcluded `
    -Ledger $ledgerEntries -LedgerActive ($ledgerActive -and $ledgerDoc.Ok) -TargetPath $targetFile)

# 台账在场却读不了：上面那句把 LedgerActive 关成了 $false（否则整批 slug 会被报成 orphan-slug，
# 制造一堆假的「条款不存在」）。**但不许因此变绿** —— 这里单独补一条硬闸，说的是真正的病：
# 台账本身坏了/不在，而正文里有 N 个 slug 正指着它。
if ($ledgerActive -and -not $ledgerDoc.Ok) {
    $violations += [PSCustomObject]@{
        Type = 'ledger-unreadable'; LineNo = 0
        Content = ('台账读不了：' + $ledgerFile + '（' + $ledgerDoc.Why + '）—— 而正文里有 ' + $slugsHere +
                   ' 行带 slug 指着它。「读不了」不等于「没问题」。')
    }
}
$script:SumLedgerViol = @($violations | Where-Object {
    $_.Type -in @('missing-slug', 'orphan-slug', 'orphan-ledger', 'dup-slug', 'ledger-mismatch', 'ledger-file-mismatch', 'ledger-unreadable')
}).Count

# ---- 统计段（只打印，恒不参与退出码；唯一例外是扫描面自检那一行的三个信号走硬闸）----
$now = Get-Date
# 观察区条目**不进条款统计**：它们尚未成为条款，混进去会稀释「触发:无 占比」——
# 而那个数字正是观察区存在的理由。
$clauses   = @($allRecords | Where-Object { $_.Zone -eq 'clause' })
$observing = @($allRecords | Where-Object { $_.Zone -eq 'observation' })
# **v2 起「是不是一条条款」与「有没有行内元字段」是两件事**：台账搬进 ledger 之后，
# 一条条款可以只有 slug。marker 的 `clauses=` 报的是前者（与 node 侧 stats.clauses 同口径，
# 否则 --reconcile 恒不一致）；下面那一大段分布统计的基底仍是后者（它们读的是行内字段）。
# 两个数都打出来，且**先报分母** —— 分母静默变化正是这套检查在治的病。
$formal    = @($clauses | Where-Object { $_.HasField -or $_.SlugCount -gt 0 })
$withField = @($clauses | Where-Object { $_.HasField })

Write-Host ''
Write-Host '---- 条款元字段统计（报告型，不影响退出码；观察区条目不计入本段）----'
# **先报分母，再报比例。** mousse 侧实测教训：分母从 70 掉到 34 时，「触发:无」占比会从
# 54.3%「改善」到 38.2%，而当时没有任何一行输出提到分母变了。
# ⚠ 分子与分母必须同口径。v2 把普查（分母）改成「完整元字段**或** slug」之后，分子若还只数
#   HasField，两个数就架在不同定义上 —— 而这一行存在的全部意义是**先报分母**。
#   本次改造当场踩到：只有 slug 的那条让分子比分母少 1，看起来像「有一条被吞了」。
Write-Host ('  扫描面自检：带完整元字段或 slug 且合选择器的行 {0} 行 → 本次检出 {1} 条（条款区 {2} · 观察区 {3}）' `
    -f $census.Selected.Count,
       @($allRecords | Where-Object { $_.HasField -or $_.SlugCount -gt 0 }).Count,
       $formal.Count,
       @($observing | Where-Object { $_.HasField -or $_.SlugCount -gt 0 }).Count)
$shapeGroups = @($allRecords | Group-Object -Property Shape | Sort-Object Count -Descending)
Write-Host ('  行形态分布：' + (($shapeGroups | ForEach-Object { "$($_.Name)=$($_.Count)" }) -join ' · ') +
            '　（top=零缩进列表项 · indent=缩进列表项 · prose=散文段落）')

# ── 未闭合反引号游程的可见面（观察线，恒不进退出码）────────────────────────────
# 2026-08-02 起未闭合游程按**字面文本**处理（判据与反转理由见 Get-MaskedLine 头注）。
# 那是遮罩规则**唯一**的模糊地带：这类行上的 `[自定@…]` 之类模板字面量会被当成真标记。
# 旧规则把这一地带处理成「静默吃掉整条」，代价是条款数少一条而退出码不变；新规则把代价
# 换成「可能多认一个标记」，而多认是**响的**。这一行是那个取舍的显式补偿面 ——
# 换掉的不该是「一种静默换另一种静默」。
#
# **只报同时带条款签名的行**（闸位取舍）：全域分布实测（7 份真实规则文件）——
# 未闭合游程共 9 行，其中同时带条款签名的只有 1 行 ⇒ 光按「有未闭合游程」报会把
# 8 行纯散文拖进来，而「生下来就吵的检查一定会被静音」。
# 走观察线不走硬闸：markdown 写成什么样是作者的判断，不是结构错。
# 只打行号不打正文：检查器的输出不该落进它自己的扫描面（同 dao-guard-writing 那条）。
$ambiguousLines = @()
$inFenceAmb = $false
for ($i = 0; $i -lt $lines.Count; $i++) {
    $tAmb = $lines[$i].Trim()
    if ($tAmb -match '^```') { $inFenceAmb = -not $inFenceAmb; continue }
    if ($inFenceAmb) { continue }
    if ((Get-BacktickSpans -Raw $lines[$i]).Unmatched.Count -eq 0) { continue }
    if (-not ([regex]::IsMatch($lines[$i], $script:LedgerSignaturePattern) -or
              [regex]::IsMatch($lines[$i], $script:SlugPattern))) { continue }
    $ambiguousLines += ($i + 1)
}
if ($ambiguousLines.Count -gt 0) {
    Write-Host ('  ⚠ 未闭合反引号游程 + 条款签名同现：{0} 行（行 {1}）' -f `
        $ambiguousLines.Count, (($ambiguousLines | Sort-Object) -join ', '))
    Write-Host '     ⇒ 这些行的未闭合反引号按**字面文本**处理；其后若写着 [自定@…]/[基线:…] 形态的'
    Write-Host '        模板字面量，会被当成真标记计入统计。渲染出来同样是坏 markdown，建议补齐配对或包进围栏。'
}
if ($ClauseSelector -eq 'Marked') {
    # Marked 模式弱射程的**可见面**：选择器排除了多少零缩进 bullet。
    # 一份真正的条款库若显示排除了几十行，说明模式选错了（该用 AllTopLevel）。
    $selectedTop = @($allRecords | Where-Object { $_.Shape -eq 'top' }).Count
    Write-Host ('  ⚠ Marked 模式射程：零缩进 `- ` 行共 {0}，其中 {1} 行被选中、{2} 行因不含 `[n=` 而**未纳入检查**。' `
        -f $census.AllTop, $selectedTop, ($census.AllTop - $selectedTop))
    Write-Host '     ⇒ 本模式检不出「整条丢掉元字段」；这个数字异常偏大时说明该改用 -ClauseSelector AllTopLevel。'
    Write-Host '     ⇒ 「孤儿条款」（检查 2）本模式不跑：加粗散文段落是该类文件的合法形态。'
}
if ($census.Indented.Count -gt 0 -and $ClauseSelector -eq 'Marked') {
    Write-Host ('  缩进条款 {0} 条（Marked 模式下合法，已纳入检查；AllTopLevel 模式下会判红）' -f $census.Indented.Count)
}
if ($whitelistExcluded.Count -gt 0) {
    # 观察线（不进退出码）：主动缩小扫描面是操作者的选择，不是错误 —— 但**不许静默**。
    # 见 Test-ClausesStructure 检查 5b 的闸位取舍段。
    Write-Host ('  ⚠ 节白名单排除了 {0} 条带签名的条款（行 {1}）—— 这是 -SectionPattern 的预期效果，' `
        -f $whitelistExcluded.Count, ((@($whitelistExcluded.Keys) | Sort-Object) -join ', '))
    Write-Host '     但它同时让被排除区间里的「📌 节吞没」检不出来。不传 -SectionPattern 时硬闸完整。'
}

if ($withField.Count -eq 0) {
    Write-Host '  （零条带元字段的正式条款，无可统计）'
} else {
    $noTrigger = @($withField | Where-Object { $_.Trigger -eq '无' })
    $script:SumNoTrig = $noTrigger.Count
    $pct = [Math]::Round($noTrigger.Count * 100.0 / $withField.Count, 1)
    Write-Host ("  正式条款 {0} 条（行内元字段 {1} 条 · 仅 slug、台账在 ledger 里 {2} 条）" `
        -f $formal.Count, $withField.Count, ($formal.Count - $withField.Count))
    Write-Host ("  ↓ 下面各项分布的分母是**行内元字段那 {0} 条**（它们读的是行内字段，读不到 ledger）" -f $withField.Count)
    Write-Host ("  触发:无 {0} 条（{1}%）—— 这批只提供判据、不提供触发点，不宜计入'条款有效性'" `
        -f $noTrigger.Count, $pct)

    $byTrigger = $withField | Group-Object -Property Trigger | Sort-Object Count -Descending
    Write-Host ('  触发点分布：' + (($byTrigger | ForEach-Object { "$($_.Name)=$($_.Count)" }) -join ' · '))
    Write-Host '     ⚠ 本闸对 `触发:` 的**取值真伪完全盲**：编一个不存在的载体照样放行，还会在这里自成一桶。'

    # 归桶一律读 NBucket（Get-ClauseNBucket 是唯一判据源）。
    $n0     = @($withField | Where-Object { $_.NBucket -eq 'zero' })
    $n1     = @($withField | Where-Object { $_.NBucket -eq 'one' })
    $nq     = @($withField | Where-Object { $_.NBucket -eq 'unknown' })
    $nMulti = @($withField | Where-Object { $_.NBucket -eq 'multi' })
    Write-Host ("  n 分布：n=0 {0} 条（已知零次，最该被退役审查） · n=1 {1} 条 · n=? {2} 条（未标次数，不等于零次） · n>=2 {3} 条" `
        -f $n0.Count, $n1.Count, $nq.Count, $nMulti.Count)

    $withBase     = @($withField | Where-Object { $null -ne $_.Baseline -and $_.Baseline -ne '未测' })
    $baseUntested = @($withField | Where-Object { $_.Baseline -eq '未测' })
    $noBase       = @($withField | Where-Object { $null -eq $_.Baseline })
    Write-Host ("  基线标注：带数字 {0} 条 · 显式「未测」{1} 条（诚实声明，允许） · 未标字段 {2} 条（有效性无从判定，不得被引用为'有效'）" `
        -f $withBase.Count, $baseUntested.Count, $noBase.Count)

    # 未来日期可见性（观察线）：宽限窗把"比本机时钟早一两天的入库日"按 0 天处理，
    # 代价是**真笔误**（7 月里写下 @08-15）也被一并按 0 天静默吞掉。这一行是那个静默面的补偿。
    $future = @()
    foreach ($c in $withField) {
        $fd = Resolve-ClauseDate -MonthDay $c.MonthDay -Now $now -FutureGraceDays $FutureGraceDays
        if ($null -eq $fd) { continue }
        if ($fd.Date -gt $now.Date) { $future += [PSCustomObject]@{ LineNo = $c.LineNo; MonthDay = $c.MonthDay } }
    }
    if ($future.Count -gt 0) {
        Write-Host ("  入库日晚于本机时钟（宽限窗 {0} 天内，按 0 天计）：{1} 条 —— {2}；请核对是不是笔误" `
            -f $FutureGraceDays, $future.Count,
               (($future | ForEach-Object { "行 $($_.LineNo)@$($_.MonthDay)" }) -join ' · '))
    }

    # ---- 候选退役区：n=0 / n=1 / n=? 三栏分开（理由见 .PARAMETER RetireAgeDays）----
    $retireN0 = @(Get-AgedRecords -Records $n0 -Now $now -Threshold $RetireAgeDays -Grace $FutureGraceDays)
    $retireN1 = @(Get-AgedRecords -Records $n1 -Now $now -Threshold $RetireAgeDays -Grace $FutureGraceDays)
    $retireNq = @(Get-AgedRecords -Records $nq -Now $now -Threshold $RetireAgeDays -Grace $FutureGraceDays)
    $script:SumRetire = $retireN0.Count + $retireN1.Count + $retireNq.Count
    Write-AgedBucket -Max $RetireListMax -Items $retireN0 `
        -Header ("候选退役区（n=0 且入库 >{0} 天）" -f $RetireAgeDays) `
        -Note '已知零次 ⇒ 标注之后它防的事一次都没发生，比 n=1 更该问「还留着干嘛」；若其实是没数过，改写 n=?'
    Write-AgedBucket -Max $RetireListMax -Items $retireN1 `
        -Header ("候选退役区（n=1 且入库 >{0} 天）" -f $RetireAgeDays) `
        -Note '单例立法 ⇒ 可能是一次过度反应。不自动删，只请人扫一眼还有没有用'
    Write-AgedBucket -Max $RetireListMax -Items $retireNq `
        -Header ("候选退役区（n=? 且入库 >{0} 天）" -f $RetireAgeDays) `
        -Note 'n=? 是「未标次数、不等于零次」⇒ 第一步是**回填 n** 不是删；回填后它会落回 n=0/n=1 或 n>=2'
}

# ---- 台账对账统计（v2 · 观察线；判红那部分由检查 6 走硬闸）--------------------
Write-Host '---- 条款台账（clause-ledger.json；报告型，判红部分见上面的硬闸）----'
if (-not $ledgerActive) {
    Write-Host ('  台账对账不适用：本文件零 slug，台账里也没有指着它的条目（台账 {0}）。' -f `
        $(if ($ledgerDoc.Ok) { '可读' } else { $ledgerDoc.Why }))
    Write-Host '  （这一行刻意存在：静默跳过与「查了且没事」在输出上不可区分。）'
} elseif (-not $ledgerDoc.Ok) {
    Write-Host ('  ✗ 台账读不了：{0}（{1}）—— 正文里有 {2} 行带 slug 指着它，已判红。' -f $ledgerFile, $ledgerDoc.Why, $slugsHere)
} else {
    Write-Host ('  本文件 slug {0} 个 · 台账里指向本文件的条目 {1} 条 · 台账总条数 {2}' -f `
        $script:SumSlugs, $pointedHere, $ledgerEntries.Count)
    # 台账不全（有 slug、缺 n/首次入库/触发点）：**观察线不是闸**。回填还是承认未知是判断，
    # 做成硬闸只会逼出「为过闸而编一个数字」，比不填更糟。
    $incomplete = @()
    foreach ($k in ($ledgerEntries.Keys | Sort-Object)) {
        $e = $ledgerEntries[$k]
        if ($e.status -eq 'retired') { continue }
        if (-not (Test-LedgerFileMatch -LedgerPath $e.file -ActualPath $targetFile)) { continue }
        if ([string]::IsNullOrEmpty([string]$e.n) -or [string]::IsNullOrEmpty([string]$e.first_seen) -or
            [string]::IsNullOrEmpty([string]$e.trigger)) { $incomplete += $k }
    }
    if ($incomplete.Count -gt 0) {
        Write-Host ('  ⓘ 台账不全 {0} 条（有 slug、缺 n/首次入库/触发点）：{1}' -f $incomplete.Count, ($incomplete -join ' · '))
        Write-Host '     这批正是 v1 选择器结构上看不见的那种（带 [基线:]/[自定@] 却无 [n= @ 触发:] 签名）。'
        Write-Host '     搬录时**刻意不替未知编一个值**；处置是回填还是承认未知，那是判断，故走观察线。'
    } else {
        Write-Host '  台账不全：0 条'
    }
    Write-Host '  ⚠ 本闸判不了台账里的**数字对不对**（同 `触发:` 取值真伪），只保证两边说的是同一句话。'
}

# ---- 观察区统计（观察线）----------------------------------------------------
$obsWithField = @($observing | Where-Object { $_.HasField })
Write-Host '---- 观察区（判断类候选 · 复发即升格；报告型，不影响退出码）----'
if ($observing.Count -eq 0) {
    Write-Host '  （本文件无观察区条目）'
} else {
    # 升格门槛 n>=2 来自协议（「第二次复发才升格」），**刻意不做成 param()** ——
    # 做成参数等于给"悄悄放宽门槛"开了个不留痕的口子。要改就改协议并同步改这里。
    # n='?' 显式排除：无从推断次数 ≠ 复发两次，把它算进待升格是拿未知当已知。
    $due = @($obsWithField | Where-Object { $_.NBucket -eq 'multi' })
    $script:SumPromote = $due.Count
    Write-Host ("  观察中 {0} 条（缺元字段 {1} 条——那几条已由硬闸报出）" -f `
        $observing.Count, ($observing.Count - $obsWithField.Count))
    if ($due.Count -eq 0) {
        Write-Host '  ⬆ 待升格（n>=2）：0 条'
    } else {
        Write-Host ("  ⬆ 待升格（n>=2）：{0} 条 —— 移进对应正式节，并在同一次编辑里回答「这次能挂在哪个必经动作上」；答不出仍要移，触发: 如实填 无" `
            -f $due.Count)
        # 排序键避开 `[int]`（超长数字会抛）；`-as [long]` 失败得 $null，排在末尾即可。
        foreach ($d in ($due | Sort-Object { $_.N -as [long] } -Descending)) {
            Write-Host ("    · 行 {0}（n={1}）：{2}" -f $d.LineNo, $d.N, $d.Text.Substring(0, [Math]::Min(56, $d.Text.Length)))
        }
    }
    # ⏳ 久未复发：观察区的年龄面，与条款区**严格对称**分三栏。
    # 对称是硬要求不是整齐癖 —— 条款区有而观察区没有的那一栏，就是下一个「结构性失明」的藏身处。
    # **刻意不叫"退役"**：观察区条目不是条款，它们要回答的是另一个问题——
    # 「这条还是个真问题吗？还是它其实复发过、只是没人回来把 n 改成 2？」
    # 本栏**不能证明**它复发过（机器数不了），只能保证那个问题周期性地被端到眼前一次。
    $obsN0 = @($obsWithField | Where-Object { $_.NBucket -eq 'zero' })
    $obsN1 = @($obsWithField | Where-Object { $_.NBucket -eq 'one' })
    $obsNq = @($obsWithField | Where-Object { $_.NBucket -eq 'unknown' })
    Write-AgedBucket -Max $RetireListMax -Note '已知零次且放了这么久 ⇒ 这条候选大概率不是个真问题，撤掉的证据比留下的强' `
        -Header ("⏳ 久未复发（n=0 且入库 >{0} 天）" -f $RetireAgeDays) `
        -Items @(Get-AgedRecords -Records $obsN0 -Now $now -Threshold $RetireAgeDays -Grace $FutureGraceDays)
    Write-AgedBucket -Max $RetireListMax -Note '放了这么久没复发 ⇒ 要么它不是个真问题（撤掉），要么复发过而没人改 n（回填）' `
        -Header ("⏳ 久未复发（n=1 且入库 >{0} 天）" -f $RetireAgeDays) `
        -Items @(Get-AgedRecords -Records $obsN1 -Now $now -Threshold $RetireAgeDays -Grace $FutureGraceDays)
    Write-AgedBucket -Max $RetireListMax -Note 'n=? 在观察区两头都判不了（既不算待升格也不算未复发）⇒ 先回填 n' `
        -Header ("⏳ 久未复发（n=? 且入库 >{0} 天）" -f $RetireAgeDays) `
        -Items @(Get-AgedRecords -Records $obsNq -Now $now -Threshold $RetireAgeDays -Grace $FutureGraceDays)
}

# ---- AI 自定回溯面（观察线）--------------------------------------------------
# 用户把「小的你自己定」这份授权交出来时附了一句自陈：「我可能把不该自主的归成自主」。
# **这一段就是那句话的对价** —— 自定条款必须能被一条命令翻出来，否则那份授权在结构上
# 不可撤销（撤回的前提是知道有哪些）。
$selfAuthored = @($allRecords | Where-Object { $null -ne $_.SelfDate })
Write-Host '---- AI 自定（未送用户批 · 回溯面；报告型，不影响退出码）----'
if ($selfAuthored.Count -eq 0) {
    Write-Host '  带 [自定@…] 标记：0 条'
    Write-Host '  ⚠ 0 有两种读法，本脚本分不开：①确实没有 AI 自定项 ②有人自定了却没打标记。'
    Write-Host '     后者无护栏（分档与打标都是判断），这一行只保证「有标记的一定看得见」。'
} else {
    $inClause = @($selfAuthored | Where-Object { $_.Zone -eq 'clause' })
    $inObs    = @($selfAuthored | Where-Object { $_.Zone -eq 'observation' })
    Write-Host ("  带 [自定@…] 标记：{0} 条（条款区 {1} · 观察区 {2}）—— 用户可随时抽查/整批撤回，撤回不需要理由" `
        -f $selfAuthored.Count, $inClause.Count, $inObs.Count)
    foreach ($g in ($selfAuthored | Group-Object -Property SelfDate | Sort-Object Name -Descending)) {
        Write-Host ("    @{0}：{1} 条" -f $g.Name, $g.Count)
        foreach ($c in ($g.Group | Sort-Object LineNo)) {
            Write-Host ("      · 行 {0}（{1}）：{2}" -f $c.LineNo, $c.Zone, $c.Text.Substring(0, [Math]::Min(52, $c.Text.Length)))
        }
    }
    Write-Host '  ⇢ 撤回一整批：说「<月日> 之后你自定的全撤」即可，按上面的日期分组删。'
}
Write-Host '----------------------------------------------'
Write-Host ''

if ($violations.Count -gt 0) {
    Write-Host ("FAIL：命中 {0} 处已知失效形态：" -f $violations.Count)
    foreach ($v in $violations) {
        Write-Host ("  - [{0}] 行 {1}：{2}" -f $v.Type, $v.LineNo, $v.Content)
    }
    Write-Host (Format-Summary -ExitCode 1 -Clauses $formal.Count -Violations $violations.Count)
    exit 1
}

Write-Host ('OK：焊接签名零命中、条款元字段零缺失、[观察中] 标记与所在区一致、扫描面无塌陷（零吞没·样本非空）' +
            $(if ($ledgerActive -and $ledgerDoc.Ok) { '、正文 slug 与台账双向零孤儿且双轨零不等。' } else { '。' }))
Write-Host '     未覆盖面（照直写，别把这行 OK 读成"条款库没问题"）：`触发:` 取值真伪本闸判不了；'
Write-Host '     台账里的数字对不对同样判不了（检查 6 只保证两边说的是同一句话）；'
Write-Host '     条款与台账条目**一起**被删掉时两侧同时少一行、集合差仍为 0，检查 5/6 都看不见；'
Write-Host '     Marked 模式另检不出「整条丢字段且无 slug」。'
Write-Host (Format-Summary -ExitCode 0 -Clauses $formal.Count -Violations 0)
