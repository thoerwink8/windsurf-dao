<#
.SYNOPSIS
    好实践收割 · **账实状态**观察线（报告型·非硬闸，退出码恒为 0）。

.DESCRIPTION
    报告「上次收割是什么时候、此后合并了哪些 PR」这一**事实**。
    **canonical（2026-08-02 由 mousse-cli `scripts/check-harvest-status.ps1` 上移 ·
    自上而下审计第 11 件的第四个）。为什么住在 dao**：它守的那件事整个住在 dao——
    触发点是 `ccswitch/rules/dao-longwindow.md` ③「收官段必跑一次好实践收割」，
    收割器本身是 dao 的 `dao-harvest` workflow，连「机器报事实、人判该不该做」这句
    设计取舍都是那条规则的原文；**只有机检半住在一个项目里**。
    上移改的只是外壳（仓根指纹参数化 + 收官槽位里的仓路径不再写死）。
    **它不再判断「该不该收割了」** —— 那是人的判断，触发点已改挂长窗收官（见下）。

    ── 它治的病 ────────────────────────────────────────────────────────────
    坏经验有天然触发器——出事了、返工了、用户骂了，有痛感，于是会被记录（各仓
    条款库的条目几乎全是踩坑产物）。**好经验没有触发器**：做对的事做完就过去了，
    除非有人专门停下来说「这值得固化」，而那个人一直是用户，他说太累了。

    实证（2026-07-27 同日）：官们做对的三件事——拒绝编造派单令要求的错误映射
    （查码证其结构上不可达）／发现 `gh` 报 MERGEABLE 只证明无文本冲突所以合
    main 后重跑整套／把测试从「断言建链」改成 before/after 全量快照——**一条都
    没进 dao**，全停在项目层的 commit message 与工作面板里。

    ── 🔴 2026-07-27 触发点改版（用户拍板）──────────────────────────────
    **原设计**：三个触发点，其中本脚本是「机器可判」的那一个——「距上次收割 >= 20
    个 PR 就提示该收割了」。**用户拍板改为「每次干完一大段活收尾时」**，即长窗
    收官这一既有必经动作（`ccswitch/rules/dao-longwindow.md` ③ 原文：
    「**收官段必跑一次好实践收割**……收官是长窗里唯一必经的『停下来』时刻，
    不挂在这里就只能靠谁想起来」），落地形态是**收官简报里的一个两态固定槽位**。

    **那个 20 是拍的，无任何实证依据**（旧版脚本头自己已经自曝过：调参三问只答得出
    第①问，②③都答「无从判断」）。它是一个**精确地测量了错误的量**的判据——
    「攒够 20 个 PR」与「有没有攒下值得固化的好实践」之间没有任何已验证的关系。
    **一个精确但测错对象的数字，比没有数字更糟**：它让人以为有护栏。

    **诚实地说清这次改动的代价**：这是拿一个「机器可判但判错对象」的判据，换一个
    「判对了对象但机器判不了」的事件。补偿有两条，都写在这里以便日后检验：
      ① 新触发点**不是无标记时刻的自由裁量**——它挂在收官简报（必然被生产的产出物）
         的一个固定槽位上，即实测最强的非机检形态（`[cc]` 前缀 719/719、
         subagent 身份铁律 68/68，两者都是槽位档、都没有任何机器在判）。
      ② 机器这一侧**不撤，只降级为报事实**：本脚本继续每次跑验证时打印
         「上次收割在哪、此后合并了什么、marker 有多旧」，并把 marker 更新命令
         原样打出来。**机器报事实，人判该不该做**——不要让机器替人判「该做一件
         需要判断的事了」，那只会逼出为过闸而敷衍的执行（同 check-worktree-strays
         的闸位哲学）。
      **两条补偿都未经实测**：新形态 2026-07-27 才立，携带率无数据，不得宣称有效。

    ── 名字（2026-07-27 已由 check-harvest-due 改名为 check-harvest-status）──
    旧名里的 "due"（到期）正是 2026-07-27 那次改版删掉的语义 —— 脚本已不判
    「该不该收割了」，只报账实状态，故 "due" 是名实不符。当时没有当场改名，是因为
    出处仓 `docs/kit/` 下有引用旧文件名的在途文档，那一批不碰该路径
    （多官并行期的领地纪律），于是把改名连同引用面一并挂账给「下一次触到这一带的人」。
    本次（同日晚些，该 kit 已合并进 main、零 open PR、两位在途官的领地均不含此路径）
    兑现：`git mv` + 连带改该仓 `verify-all.ps1` 的 Name/LogName/Arguments 与头部清单，
    以及 `.harvest-marker` 与该仓引用面各文档、
    条款库与相邻检查器里的引用。
    **改名时逐文件保留了原有 BOM 状态**（.ps1 带 BOM / .md 与 marker 不带），
    并在写回后读回校验残留命中数为 0 —— 见条款库通用节「编码铁律」。

    ── 计数方式与它的近似边界（两个方向都写明）──────────────────────────
    数的是**「Merge pull request #N」形态的合并提交**，范围 `<marker commit>..HEAD`。
    这是「自上次收割以来合并了多少个 PR」的**近似**，两个方向都构造得出偏差：
      · **少数**：允许文档/配置微改直推主干的仓里，那些改动不产生
        合并提交 —— 但它们确实不是 PR，所以不计入是对的，不算偏差。
        真正的少数来源是 squash / rebase 合并（惯例走 `--merge` 时不发生，改了策略
        这里就会静默少数）。
      · **多数**：`Merge branch 'main' into <branch>`（实现官合入 main 的动作）
        不匹配本脚本的正则，已排除；但若将来有人手工写出以 "Merge pull request #"
        开头的非 PR 合并信息，会被误计。
    **不用 `gh pr list` 也不做 PR 号相减**：①`gh` 要网络与登录态，验证入口应当
    离线可跑 ②GitHub 的 issue 与 PR **共用同一个编号序列**，用 issue 的仓里
    「最新 PR 号 − marker PR 号」会把中间的 issue 也算成 PR（实测出处仓
    #234/#240/#242/#243/#245 均为 issue）——那是个看起来精确实则偏高的数字。

    **这个 PR 数现在是给人读的素材，不是判据**：它回答「自上次收割以来发生了多少事」，
    读它的人（收官时的帅）据此判断这一段有没有值得捞的东西。**没有阈值，没有建议。**

.PARAMETER MarkerPath
    收割标记文件路径，缺省 `<repo>/.harvest-marker`。
    格式是 `key=value` 纯文本（UTF-8 无 BOM），键：
      LAST_HARVEST_DATE / LAST_HARVEST_COMMIT / LAST_HARVEST_PR / LAST_HARVEST_NOTE
    **收割之后要手动更新它**（这是本机制的已知薄弱环节：更新动作本身是「无标记
    时刻的自由裁量」，即实测携带率 9-24% 的那一类形态。缓解手段是本脚本在
    `-Closing` 模式下把更新命令原样打出来，让它至少是「照抄一行」而不是「回忆
    格式」；根治要等收割 workflow 能自己写 marker，那是另一次显式改动）。

.PARAMETER RepoRoot
    被检项目的仓根，缺省由 `$PSScriptRoot` 上推两级（即 dao 仓自己）。**跨仓调用必传。**

.PARAMETER RepoSignature
    目录守卫指纹，缺省 `@('.git')`。理由与代价同 `check-pr-body-mojibake.ps1` 同名参数。

.PARAMETER Closing
    收官模式。额外打印**收官简报的收割槽位模板**（那一行两态恰选其一，见
    `ccswitch/rules/dao-longwindow.md` ③）与 marker 更新命令。验证入口里不带此开关，跑的是简短状态行；
    长窗收官时手动带上它。

.NOTES
    退出码恒为 0（报告型，非硬闸）。任何内部异常也吞掉并报告，绝不让观察线
    成为验证流程的新故障点。
    PS 5.1 兼容：只看 $LASTEXITCODE 判 git 成败、无 && 链、不用 2>&1。

    **本脚本 2026-07-27 起不再有 `-Threshold` 参数**（那就是被删掉的判据本身；留着一个
    可传的阈值等于给「悄悄把到期判定加回来」留了个不留痕的口子）。
#>

param(
    [string]$MarkerPath = '',
    [string]$RepoRoot = '',
    [string[]]$RepoSignature = @('.git'),
    [switch]$Closing
)

# 观察线绝不能自己把验证流程搞红：内部一律 Continue，末尾恒 exit 0。
$ErrorActionPreference = 'Continue'

# 缺省仓根 = dao 仓自己（ccswitch/scripts → ccswitch → <dao根>）。跨仓调用必传 -RepoRoot。
if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
    $repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
} else {
    $repoRoot = $RepoRoot
}

# ---- 目录守卫（dao 血泪：切目录跑脚本会静默跑错仓）--------------------------
# 若 -RepoRoot 指的不是目标仓（worktree 误建、脚本被复制到别处、
# Set-Location 失败后落在别的目录），特征文件就缺 —— 此时直接说清楚并退出，
# 不要在错误的仓上报出一个看起来正常的数字。
# ---- 仓根指纹归一化（**跨进程调用必需**）------------------------------------
# `powershell.exe -File x.ps1 -RepoSignature a,b,c` 里那串**整个**是一个字符串
# （`-File` 的参数按字面串传，不走 PowerShell 的数组字面量解析）⇒ 直接当数组用会
# 得到一个「路径叫 `a,b,c`」的元素，守卫于是**必然报缺、必然拦下**，而拦下的措辞
# 与真的跑错仓一模一样。2026-08-02 首次跨仓冒烟当场撞到。
# 故：既接受真数组，也接受逗号串，逐段裁空后合并。
$sigParts = @()
foreach ($s in @($RepoSignature)) {
    if ($null -eq $s) { continue }
    foreach ($x in ([string]$s -split ',')) {
        $x = $x.Trim()
        if ($x) { $sigParts += $x }
    }
}
$missingSig = @($sigParts | Where-Object { $_ -and -not (Test-Path (Join-Path $repoRoot $_)) })
Write-Host ("HARVEST_CWD={0}" -f $repoRoot)
if ($missingSig.Count -gt 0) {
    Write-Host ("[check-harvest-status] 目录守卫拦下：{0} 不像目标仓根（缺 {1}）——不在错误的仓上报数字。" `
        -f $repoRoot, ($missingSig -join ', '))
    Write-Host '[check-harvest-status] 观察线不阻断验证，EXIT=0。'
    exit 0
}

if ([string]::IsNullOrWhiteSpace($MarkerPath)) {
    $MarkerPath = Join-Path $repoRoot '.harvest-marker'
}

function Get-MarkerValue {
    param([string[]]$Lines, [string]$Key)
    foreach ($line in $Lines) {
        $t = $line.Trim()
        if ($t.StartsWith('#') -or -not $t.Contains('=')) { continue }
        $idx = $t.IndexOf('=')
        if ($t.Substring(0, $idx).Trim() -eq $Key) { return $t.Substring($idx + 1).Trim() }
    }
    return $null
}

function Write-TriggerNote {
    <#
      每条退出路径都要带上这句——本脚本最容易被误读的地方就是「它没提示，所以
      不用收割」。它从来不提示，判断在人那边。
    #>
    Write-Host ''
    Write-Host '  -- 该不该收割：本线不判 --'
    Write-Host '  触发点是**长窗收官**（用户 2026-07-27 拍板，取代原「每 20 个 PR」的拍脑袋阈值）。'
    Write-Host '  判据正文：ccswitch/rules/dao-longwindow.md ③「收官段必跑一次好实践收割」。'
    Write-Host '  本线只报事实（上次收割在哪 / 此后合并了什么 / marker 有多旧），不给建议、无阈值。'
    Write-Host '  收官时带 -Closing 跑一次，可拿到简报槽位模板与 marker 更新命令。'
}

function Write-ClosingSlot {
    param([string]$HeadShort)
    Write-Host ''
    Write-Host '  -- 收官简报槽位（两态恰选其一，没有第三态）--'
    Write-Host '  🌾 收割：已跑（候选 N 条 / 入库 M 条 / 落点 <文件>）  |  未跑（<一句理由>）'
    Write-Host ''
    Write-Host ("  跑收割：dao-harvest workflow，args 至少给 {{`"repoPath`":`"{0}`"}}；" -f ($repoRoot -replace '\\','/'))
    Write-Host '  收完把通过核验的候选按 layer 粘进对应文件，然后更新 .harvest-marker 三个字段：'
    Write-Host ("    LAST_HARVEST_DATE=<今天>  LAST_HARVEST_COMMIT={0}  LAST_HARVEST_PR=<当时最新 PR 号>" -f $HeadShort)
}

Write-Host ''
Write-Host '======================================================='
Write-Host '  好实践收割 · 账实状态（报告型·非硬闸，EXIT 恒 0）'
Write-Host '======================================================='

$headShort = '<HEAD>'
$headProbe = (& git -C $repoRoot rev-parse --short HEAD 2>$null)
if ($LASTEXITCODE -eq 0 -and $headProbe) { $headShort = $headProbe }

# ---- 读 marker -------------------------------------------------------------
if (-not (Test-Path $MarkerPath)) {
    Write-Host ("  marker 不存在：{0}" -f $MarkerPath)
    Write-Host '  ⇒ 「上次收割之后发生了什么」**无从计算**（这不等于「从未收割」，只等于「没有记录」）。'
    Write-Host '  首次使用请落一份 marker，格式见本脚本的 .PARAMETER MarkerPath。'
    Write-TriggerNote
    if ($Closing) { Write-ClosingSlot -HeadShort $headShort }
    Write-Host '[check-harvest-status] EXIT=0（观察线）'
    exit 0
}

# 无 BOM UTF-8 文件用 PS 5.1 默认编码读会把中文读成乱码（dao 编码铁律），
# 故显式 UTF8 读取；marker 的 NOTE 字段允许中文。
$markerLines = @()
try {
    $markerLines = [System.IO.File]::ReadAllLines($MarkerPath, [System.Text.Encoding]::UTF8)
} catch {
    Write-Host ("  marker 读取失败：{0}" -f $_.Exception.Message)
    Write-TriggerNote
    Write-Host '[check-harvest-status] EXIT=0（观察线）'
    exit 0
}

$lastCommit = Get-MarkerValue -Lines $markerLines -Key 'LAST_HARVEST_COMMIT'
$lastDate   = Get-MarkerValue -Lines $markerLines -Key 'LAST_HARVEST_DATE'
$lastPr     = Get-MarkerValue -Lines $markerLines -Key 'LAST_HARVEST_PR'
$lastNote   = Get-MarkerValue -Lines $markerLines -Key 'LAST_HARVEST_NOTE'

# PS 5.1 没有三元运算符，且 `(if ...)` 不是合法表达式（要 `$(if ...)`）——
# 这里用最朴素的赋值，可读性也更好。
$showDate   = '?'; if ($lastDate)   { $showDate   = $lastDate }
$showCommit = '?'; if ($lastCommit) { $showCommit = $lastCommit }
$showPr     = '?'; if ($lastPr)     { $showPr     = $lastPr }
Write-Host ("  上次收割：{0}（commit {1}，当时最新 PR #{2}）" -f $showDate, $showCommit, $showPr)
if ($lastNote) { Write-Host ("  备注：{0}" -f $lastNote) }

# marker 有多旧：日期解析失败就说解析失败，不猜。
if ($lastDate) {
    $parsed = [datetime]::MinValue
    if ([datetime]::TryParse($lastDate, [ref]$parsed)) {
        $ageDays = [int]((Get-Date).Date - $parsed.Date).TotalDays
        Write-Host ("  marker 年龄：{0} 天（只是事实，不是「该收割了」的信号）" -f $ageDays)
    } else {
        Write-Host ("  marker 年龄：无从计算（LAST_HARVEST_DATE 解析不出日期：{0}）" -f $lastDate)
    }
}

if ([string]::IsNullOrWhiteSpace($lastCommit)) {
    Write-Host '  ⇒ marker 缺 LAST_HARVEST_COMMIT，无从列出此后的 PR（PR 号相减不可靠，见脚本头 .DESCRIPTION）。'
    Write-TriggerNote
    if ($Closing) { Write-ClosingSlot -HeadShort $headShort }
    Write-Host '[check-harvest-status] EXIT=0（观察线）'
    exit 0
}

# ---- marker commit 必须是 HEAD 的祖先，否则列表无意义 ----------------------
& git -C $repoRoot merge-base --is-ancestor $lastCommit HEAD 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Host ("  ⇒ marker 记的 commit {0} 不是当前 HEAD 的祖先（分支/worktree/rebase 后常见）。" -f $lastCommit)
    Write-Host '     这一状态下列表没有意义，如实报「无从计算」而不给一个看似合理的数字。'
    Write-TriggerNote
    if ($Closing) { Write-ClosingSlot -HeadShort $headShort }
    Write-Host '[check-harvest-status] EXIT=0（观察线）'
    exit 0
}

# ---- 列自上次收割以来的 PR 合并提交（事实，不是判据）-----------------------
$subjects = @(& git -C $repoRoot log --merges --format=%s ("{0}..HEAD" -f $lastCommit))
if ($LASTEXITCODE -ne 0) {
    Write-Host '  ⇒ git log 失败，无从列出。'
    Write-TriggerNote
    Write-Host '[check-harvest-status] EXIT=0（观察线）'
    exit 0
}
# 只认 "Merge pull request #<数字>" 这一形态；`Merge branch 'main' into x`（实现官
# 合入 main 的动作）不计入 —— 那不是一个新 PR。
$prMerges = @($subjects | Where-Object { $_ -match '^Merge pull request #(\d+)' })
$n = $prMerges.Count

Write-Host ''
Write-Host ("  自上次收割以来合并了 **{0} 个 PR**（近似口径见脚本头；这是素材不是判据）" -f $n)
if ($n -gt 0) {
    $shown = @($prMerges | Select-Object -First 8)
    foreach ($s in $shown) { Write-Host ("    · {0}" -f $s) }
    if ($n -gt $shown.Count) { Write-Host ("    · …… 另 {0} 个（完整列表：git log --merges {1}..HEAD）" -f ($n - $shown.Count), $lastCommit) }
}

Write-TriggerNote
if ($Closing) { Write-ClosingSlot -HeadShort $headShort }
Write-Host '======================================================='
Write-Host '[check-harvest-status] EXIT=0（观察线，恒不阻断）'

exit 0
