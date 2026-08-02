<#
.SYNOPSIS
    「同文件 24h 内被 N 个以上独立 PR 触碰」观察线（报告型·非硬闸，恒 exit 0）。

.DESCRIPTION
    ── 为什么住在 dao（2026-08-02 上移 · 自上而下审计第 11 件里最硬的一条）────
    **这条判据的原文本来就在 dao 的规则文件里**：
      · `ccswitch/rules/dao-dispatch.md` 派单契约门「近似判据类批加一问『语料从哪来』」
        的配套停手信号 —— **同一文件 24h 内第 3 次返工即转设计评审**；
      · `ccswitch/rules/dao-officer-clauses.md` 对抗验证官节同名条款重述一遍。
    而它的**机检半此前只挂在 mousse-cli/scripts/** ⇒ **判据在上、机器在下**，
    第二个项目照着 dao 的规则做事，却拿不到那条规则的执行装置。上移即修这一点。
    判定逻辑一行未动，改的是外壳：仓根指纹与主干分支名参数化。

    ── 它治的病 ────────────────────────────────────────────────────────────
    好实践收割第 4 轮量化半边（mousse-cli，Q2）实测：上面那条判据自 2026-07-27
    入库以来**从未被任何自动化验证过**——当时实测一窗内命中 3 组（`manager.rs`
    3 PR/6h9m、`TerminalPane.tsx` 4 PR/11h40m、i18n 三文件各 3 PR/10h46m），
    全部 0 次被人工在事发时发现，其中一组还是坐实的"B 修 A 遗留缺口"链条
    （PR body 原文自述）。这条判据此前的执行方式是"帅派单前人工 `git log
    --since=24h -- <file>`"（触发:派单契约门，需要帅在派单那一刻**想起来**查），
    本脚本把它接上一个每次跑验证都会打印一次的位置，不新开条款，是给
    已有判据接机检半。

    ── 数据源与判据 ────────────────────────────────────────────────────────
    用 `gh pr list --state merged --json number,files,mergedAt --limit <Limit>`
    拉取最近合并的 PR（PR 级颗粒度，非 commit 级——排除同一 PR 内部迭代 commit
    的噪音，与量化半边同一口径），按 `mergedAt` 落在 `-LookbackDays` 窗口内过滤，
    按文件聚合，对每个文件找**滚动 24 小时窗口**内触碰它的不同 PR 数，
    `-MinDistinctPRs`（默认 3）个以上即打印告警（文件名 + 涉及 PR 号 + 时间跨度）。

    ── 🔴 gh 降级路径：区分「未能检查」与「检查了但零命中」───────────────────
    与姊妹脚本（mousse-cli `check-real-machine-debt-age.ps1`，Q1）同一套硬约束（L31「它没说谎，
    它答的是另一个问题」+「零检出 ≠ 零存在」）：`gh` 不可用/查询失败时输出
    "⚠️ 未能检查（…）"，绝不与"检查了、当前 0 个文件命中"的"✅ 已检查：…"混同。

    ── 🔴 硬约束：检查器的输出不落在自己的扫描面内 ───────────────────────
    本脚本的"扫描面"是 GitHub 上的已合并 PR 元数据，不是任何仓里的文件；本脚本
    只打印到 stdout，不写任何文件——不存在自我放大的结构可能。

    ── 🔴 硬约束：自检那一半走独立实现，不复用主扫描逻辑 ─────────────────
    主逻辑解析 `gh pr list --json` 返回的 JSON（GitHub API 视角）。自检改用
    **`git log --merges`**（本地 git 历史视角，完全不同的数据源与解析路径）
    独立数一遍同一时间窗口内 `-MainBranch` 上的 merge commit 数，与 gh 返回的 PR
    数量级互相印证——如果 gh 说"这个窗口内 0 个 PR 合并"而 git log 明明看得到
    merge commit，说明 gh 这一路的查询/鉴权/网络出了问题，而不是"真的没有 PR
    合并"。两条路径分别数数、互不共享 JSON 解析器或 git log 解析器。

.PARAMETER LookbackDays
    往回看几天的已合并 PR，默认 3（覆盖"最近一批活动"，与量化半边实测的
    "本窗约 30 小时内"量级相近；调大能看到更长历史但 `gh pr list` 单次拉取
    上限与耗时也会上升）。

.PARAMETER MinDistinctPRs
    24 小时窗口内命中告警的最小独立 PR 数，默认 3——直接取自既有判据原文
    "同一文件 24h 内第 3 次返工"，不是本脚本另拍的数字。

.PARAMETER WindowHours
    滚动窗口宽度（小时），默认 24——同样直接取自既有判据原文，不是本脚本
    另拍的数字。

.PARAMETER Limit
    `gh pr list --limit` 传值，默认 200（出处仓量化半边用 60 已够覆盖约 30
    小时窗口；200 留更大余量以支持调大 `-LookbackDays` 时仍取全）。

.PARAMETER RepoRoot
    被检项目的仓根，缺省由 `$PSScriptRoot` 上推两级（即 dao 仓自己）。**跨仓调用必传。**

.PARAMETER RepoSignature
    目录守卫指纹，缺省 `@('.git')`。理由与代价同 `check-pr-body-mojibake.ps1` 同名参数。

.PARAMETER MainBranch
    自检那一半（`git log --merges`）比对的主干分支名，缺省 `main`。
    **它必须可传**：dao 自己的主干叫 `master`，写死 `main` 会让自检恒失败——
    而自检失败时它只打一行"自检不可用"、主逻辑照跑，**看起来完全正常**，
    正是这道观察线自己在治的那种"答的是另一个问题"。

.NOTES
    退出码恒为 0（观察线，报告型·非硬闸——"这里该不该转设计评审"是人该判断的
    事，不是代码对错，判据同 `ccswitch/rules/dao-officer-clauses.md`
    「新增机检项先判闸位」）。

    PS 5.1 兼容：不用 `& gh ... 2>$file` 捕获 native 输出（实测坐实仍会把
    stderr 包成 NativeCommandError 打印到控制台），改用 `Start-Process
    -RedirectStandardOutput/-RedirectStandardError` 到真实文件，同
    姊妹脚本与 mousse-cli `verify-all.ps1` 的 `Invoke-VerifyStep`
    一致路线。`ConvertFrom-Json` 的结果**先赋值给变量、再用 `@()` 包一次**，
    不要写成 `@(ConvertFrom-Json -InputObject $x)` 一步到位——实测坐实：
    后者会把整个反序列化数组当成"管道只输出了一个对象"，得到一个嵌套的
    1 元素数组，`.Count` 恒为 1，是姊妹脚本（Q1）踩过的真实坑，此处
    照抄修法而非重新踩一次。

    本文件含中文注释，须以 BOM UTF-8 存盘。
#>

param(
    [ValidateRange(1, 365)][int]$LookbackDays = 3,
    [ValidateRange(2, 100)][int]$MinDistinctPRs = 3,
    [ValidateRange(1, 720)][int]$WindowHours = 24,
    [ValidateRange(1, 1000)][int]$Limit = 200,
    [string]$RepoRoot = '',
    [string[]]$RepoSignature = @('.git'),
    [string]$MainBranch = 'main'
)

$ErrorActionPreference = 'Continue'

# 缺省仓根 = dao 仓自己（ccswitch/scripts → ccswitch → <dao根>）。跨仓调用必传 -RepoRoot。
if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
    $RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
}

# ---- 目录守卫 -----------------------------------------------------------------
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
$missingSig = @($sigParts | Where-Object { $_ -and -not (Test-Path (Join-Path $RepoRoot $_)) })
Write-Host ("FILEREWORK_CWD={0}" -f $RepoRoot)
if ($missingSig.Count -gt 0) {
    Write-Host ("[check-file-rework-frequency] 目录守卫拦下：{0} 不像目标仓根（缺 {1}）——不在错误的仓上报数字。" -f $RepoRoot, ($missingSig -join ', '))
    Write-Host '[check-file-rework-frequency] EXIT=0（观察线）'
    exit 0
}

Write-Host ''
Write-Host '======================================================='
Write-Host '  同文件 24h 内多 PR 返工 · 观察线'
Write-Host '======================================================='
Write-Host ("  窗口：{0} 小时滚动窗口内 >= {1} 个独立 PR 触碰同一文件；回看范围：最近 {2} 天已合并 PR。" -f $WindowHours, $MinDistinctPRs, $LookbackDays)
Write-Host ''

# ---- 分支一：gh 不可用 --------------------------------------------------------
$ghCmd = Get-Command gh -ErrorAction SilentlyContinue
if (-not $ghCmd) {
    Write-Host '  ⚠️ 未能检查（gh 不可用：命令未找到于 PATH，请安装 GitHub CLI 或跳过本项观察）。'
    Write-Host '  这不是「零命中」——是「本次根本没有查成」，两者在本脚本的输出里刻意分开措辞。'
    Write-Host '======================================================='
    Write-Host '[check-file-rework-frequency] EXIT=0（观察线，恒不阻断；本次未能检查）'
    exit 0
}

# ---- 拉取已合并 PR 元数据（Start-Process + 真实文件重定向，理由见 .NOTES）----
$scratchDir = Join-Path $env:TEMP 'dao-check-file-rework'
if (-not (Test-Path $scratchDir)) { New-Item -ItemType Directory -Force -Path $scratchDir | Out-Null }
$tag = ([guid]::NewGuid().ToString('N').Substring(0, 8))
$outFile = Join-Path $scratchDir ("out-{0}.txt" -f $tag)
$errFile = Join-Path $scratchDir ("err-{0}.txt" -f $tag)
$ghArgs = @('pr', 'list', '--state', 'merged', '--limit', "$Limit", '--json', 'number,files,mergedAt,title')
$exit = 1
try {
    $proc = Start-Process -FilePath $ghCmd.Source -ArgumentList $ghArgs -WorkingDirectory $RepoRoot `
        -NoNewWindow -Wait -PassThru -RedirectStandardOutput $outFile -RedirectStandardError $errFile
    $exit = $proc.ExitCode
    if ($null -eq $exit) { $exit = 1 }
} catch {
    $exit = 1
}
$out = ''
if (Test-Path $outFile) { $out = [System.IO.File]::ReadAllText($outFile, [System.Text.Encoding]::UTF8) }
$errText = ''
if (Test-Path $errFile) { $errText = [System.IO.File]::ReadAllText($errFile, [System.Text.Encoding]::UTF8).Trim() }
Remove-Item -Path $outFile, $errFile -ErrorAction SilentlyContinue

# ---- 分支二：gh 查询失败 ------------------------------------------------------
if ($exit -ne 0) {
    $summary = if ($errText) { $errText } else { ("gh 退出码 {0}（无 stderr 输出）" -f $exit) }
    Write-Host ("  ⚠️ 未能检查（gh 查询失败：{0}）" -f $summary)
    Write-Host '  这不是「零命中」——常见成因：未登录（gh auth login）/ 离线 / 触发限流。'
    Write-Host '======================================================='
    Write-Host '[check-file-rework-frequency] EXIT=0（观察线，恒不阻断；本次未能检查）'
    exit 0
}

$joined = $out.Trim()
$prList = @()
if ($joined) {
    try {
        # 两步写法（先赋值再 @() 包）——理由见脚本头 .NOTES，勿合成一行。
        $parsedRaw = ConvertFrom-Json -InputObject $joined
        $prList = @($parsedRaw)
    } catch {
        Write-Host ("  ⚠️ 未能检查（gh 返回内容无法解析为 JSON：{0}）" -f $_.Exception.Message)
        Write-Host '======================================================='
        Write-Host '[check-file-rework-frequency] EXIT=0（观察线，恒不阻断；本次未能检查）'
        exit 0
    }
}

# ---- 按 LookbackDays 过滤 ------------------------------------------------------
$cutoff = (Get-Date).ToUniversalTime().AddDays(-1 * $LookbackDays)
$inWindow = @()
foreach ($pr in $prList) {
    if (-not $pr.mergedAt) { continue }
    try {
        $merged = [datetime]::Parse($pr.mergedAt, [System.Globalization.CultureInfo]::InvariantCulture, `
            [System.Globalization.DateTimeStyles]::AdjustToUniversal -bor [System.Globalization.DateTimeStyles]::AssumeUniversal)
    } catch { continue }
    if ($merged -ge $cutoff) {
        $inWindow += [PSCustomObject]@{ Number = $pr.number; Title = $pr.title; MergedAt = $merged; Files = @($pr.files | ForEach-Object { $_.path }) }
    }
}

Write-Host ("  拉取 {0} 个已合并 PR（--limit {1}），落在最近 {2} 天窗口内的有 {3} 个。" -f $prList.Count, $Limit, $LookbackDays, $inWindow.Count)

# ---- 🔴 自检：git log --merges 独立复核（与 gh JSON 解析完全不同的代码路径）--
$gitMergeCount = $null
$selfCheckNote = ''
$gitLogOut = & git -C $RepoRoot log --merges ("--since={0} days ago" -f $LookbackDays) --oneline $MainBranch 2>$null
$gitLogExit = $LASTEXITCODE
if ($gitLogExit -ne 0) {
    $selfCheckNote = ("git log --merges {1} 本身失败（exit {0}）——自检不可用，不代表 gh 查询有问题，只是这一半没跑成。分支名不对时用 -MainBranch 传。" -f $gitLogExit, $MainBranch)
} else {
    $gitMergeCount = @($gitLogOut | Where-Object { $_ }).Count
    if ($gitMergeCount -eq 0 -and $inWindow.Count -gt 0) {
        $selfCheckNote = ("⚠️ git log 在本地看到 0 个 merge commit，而 gh 说这个窗口内有 {0} 个已合并 PR——两者不一致，可能本地主干落后于远端（先 git fetch）或 squash-merge 不产生 merge commit（用 --merge 合并才保留 merge commit，若某些 PR 走了 squash 路径这里会低估，属已知口径差异，不是 gh 的问题）。" -f $inWindow.Count)
    } elseif ($gitMergeCount -gt 0 -and $inWindow.Count -eq 0) {
        $selfCheckNote = ("⚠️ gh 说这个窗口内 0 个已合并 PR，而本地 git log 看到 {0} 个 merge commit——gh 侧疑似有问题（分页/鉴权/参数），不要把 gh 的 0 读成「真的没有活动」。" -f $gitMergeCount)
    } else {
        $selfCheckNote = ("git log --merges 独立复核：本地看到 {0} 个 merge commit，gh 报告 {1} 个已合并 PR——量级互相印证（两个数字不必相等：merge commit 计数与 PR 计数在 squash/rebase 策略下天然有别，这里只看「同为零」或「同不为零」这个粗粒度信号）。" -f $gitMergeCount, $inWindow.Count)
    }
}
Write-Host ("  扫描面自检（与主逻辑走两条独立代码路径，互不共享解析器）：{0}" -f $selfCheckNote)
Write-Host ''

# ---- 分支三：查询成功，按文件聚合 + 滑动窗口 ----------------------------------
if ($inWindow.Count -eq 0) {
    Write-Host ("  ✅ 已检查：最近 {0} 天内没有已合并 PR，无从谈「同文件多 PR 返工」。" -f $LookbackDays)
    Write-Host '======================================================='
    Write-Host '[check-file-rework-frequency] EXIT=0（观察线，恒不阻断）'
    exit 0
}

# 按文件聚合触碰记录：{File -> [(Number, MergedAt, Title), ...]}
$byFile = @{}
foreach ($pr in $inWindow) {
    foreach ($f in $pr.Files) {
        if (-not $f) { continue }
        if (-not $byFile.ContainsKey($f)) { $byFile[$f] = @() }
        $byFile[$f] += [PSCustomObject]@{ Number = $pr.Number; MergedAt = $pr.MergedAt; Title = $pr.Title }
    }
}

$flagged = @()
foreach ($f in $byFile.Keys) {
    $touches = @($byFile[$f] | Sort-Object MergedAt)
    if ($touches.Count -lt $MinDistinctPRs) { continue }

    # 滑动窗口：以每个触碰为起点，找 WindowHours 内的所有触碰，取窗口内最大的
    # 独立 PR 数（同一文件同一 PR 只会出现一次，因为 gh 的 files 数组本身按
    # 路径去重，故这里的"触碰数"与"独立 PR 数"天然相等，不需要额外去重）。
    $bestCount = 0
    $bestWindow = @()
    for ($i = 0; $i -lt $touches.Count; $i++) {
        $winStart = $touches[$i].MergedAt
        $winEnd = $winStart.AddHours($WindowHours)
        $inWin = @($touches | Where-Object { $_.MergedAt -ge $winStart -and $_.MergedAt -le $winEnd })
        if ($inWin.Count -gt $bestCount) {
            $bestCount = $inWin.Count
            $bestWindow = $inWin
        }
    }

    if ($bestCount -ge $MinDistinctPRs) {
        $span = $bestWindow[-1].MergedAt - $bestWindow[0].MergedAt
        $flagged += [PSCustomObject]@{
            File = $f
            Count = $bestCount
            Window = $bestWindow
            SpanHours = [math]::Round($span.TotalHours, 1)
        }
    }
}

$flagged = @($flagged | Sort-Object Count -Descending)

if ($flagged.Count -eq 0) {
    Write-Host ("  ✅ 已检查：{0} 个被触碰的文件中，没有文件在 {1} 小时窗口内被 >= {2} 个独立 PR 触碰。" -f $byFile.Keys.Count, $WindowHours, $MinDistinctPRs)
} else {
    Write-Host ("  ⚠️ 已检查：命中 {0} 个文件（{1} 小时窗口内 >= {2} 个独立 PR 触碰），按 PR 数降序：" -f $flagged.Count, $WindowHours, $MinDistinctPRs)
    Write-Host ''
    foreach ($fl in $flagged) {
        Write-Host ("    · {0}  —— {1} 个 PR / {2} 小时跨度" -f $fl.File, $fl.Count, $fl.SpanHours)
        foreach ($w in $fl.Window) {
            Write-Host ("        ↳ #{0,-4} {1}  {2}" -f $w.Number, $w.MergedAt.ToString('yyyy-MM-dd HH:mm'), $w.Title)
        }
    }
    Write-Host ''
    Write-Host '  按既有判据（dao-dispatch.md 派单契约门 / dao-officer-clauses.md 对抗验证官节的配套停手信号）：'
    Write-Host '  同一文件 24h 内第 3 次返工，建议转设计评审，不要继续在上一层刚写的行上打补丁。'
}

Write-Host ''
Write-Host '  该不该转设计评审是人该判断的事——本观察线只保证这份清单不再需要有人想起来才去查。'
Write-Host '======================================================='
Write-Host '[check-file-rework-frequency] EXIT=0（观察线，恒不阻断）'
exit 0
