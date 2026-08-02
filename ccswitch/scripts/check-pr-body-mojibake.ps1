<#
.SYNOPSIS
    PR / issue 正文乱码 + 未填占位符 · **观察线**（报告型·非硬闸，退出码恒为 0）。
    打印「本次扫了几个正文/回读记录、里面有没有乱码签名字」这一**事实**。

.DESCRIPTION
    ── 它是哪条条款的机检半 ──────────────────────────────────────────────
    `ccswitch/rules/dao-officer-clauses.md` 通用节「**PR body / comment 正文永不经过
    PowerShell 字符串，一律走 `--body-file`，发出后回读核一次**」（`n=4`）。
    该条第③步要求发出后回读 + Grep 扫 `[锛銆馃鈥]`，而它自己在「射程与弱处」里
    挂着账：**「这是槽位档不是机检档，没有任何程序在核你回读了没有」**，并写明
    「做成观察线档的 `check-*.ps1` 是可行的……挂账未做、是已知缺口不是疏漏」。
    本脚本就是那笔挂账（2026-07-29 落地 mousse-cli，2026-08-02 上移 dao）。

    判据全文（两组信号 A/B、各自出处、两向失效形态）在 `ccswitch/lib/pr-body-scan.ps1`
    文件头——**那里是唯一真相源，此处不复述**（复述必过期，已有多处一句话三处
    过期的实证）。

    ── 为什么住在 dao（2026-08-02 上移 · 自上而下审计第 11 件）──────────
    **判据在上、机器在下**是全部理由：被守的那条条款自 2026-08-02 条款库拆分起
    住在 `ccswitch/rules/dao-officer-clauses.md`（跨项目通用节），而机检半只存在于
    mousse-cli/scripts/ ⇒ 第二个项目拿不到，只能从零重新发明同一套判据。
    判据侧零项目耦合是实测结论（21KB 判据库不含任何仓名/技术栈假设）；
    **有耦合的是调用外壳**——一行写死的仓根指纹。故上移形态是
    「判据整体搬 + 外壳参数化」。
    ⚠ **刻意不写「零改动搬走」**：原审计条目按零成本估过，被核验官打掉——同批
    上移的脚本各有一行活代码带项目指纹，参数化即那笔成本。

    ── 它**不能**做到的事（先说这个，别把下面的 OK 读成保证）────────────
      · **`n=4` 里有两例它结构上看不见**：第 3 例（bash 双引号里的命令替换吃掉
        `` `gh pr edit` ``）与第 4 例（不带引号的 heredoc 吃掉反引号内容）——那两次
        的后果是**正文被静默删掉**，删掉的东西不留签名。本脚本只覆盖「变成乱码」
        与「占位符没替换」两类。
      · **它核不到「你到底回读了没有」**，只核得到「回读记录在不在扫描面里」。
        没有记录时它分不开「本批没发 PR」与「发了但没回读」，输出里已写明。
      · 它**不联网、不调 `gh`**（`verify-all` 不该新增网络依赖）——正文得先落到
        磁盘上它才看得见。

    ── 怎么在正确的时刻用它（这才是它的主用法，verify-all 那一道只是提醒）──
    条款第③步的完整做法，两条命令：

        # ① 回读（用 **Bash 工具** 跑：重定向是字节直落，不经任何 shell 的编码层）
        gh pr view <n> --json body -q .body > _tmp/pr-<n>-readback.md

        # ② 扫（本脚本，替掉条款里那句手工 Grep）
        powershell -NoProfile -File <dao根>/ccswitch/scripts/check-pr-body-mojibake.ps1 `
            -RepoRoot <项目根> -RepoSignature <项目根下必然存在的一两个路径>

    ── 为什么是观察线不是硬闸（照 dao-officer-clauses.md「新增机检项先判闸位」，收割 H1-7）──
    **判据的最后一步在人手里**：条款自己写着「零命中，**或命中处是你有意引用的
    样例**」——#175 的 body 是好的，只因引用了一段乱码样例而命中一次。一个带
    正当假阳性场景的近似判据做成硬闸，第一次撞上合法引用就会变红，随即被 `-Skip`
    掉，顺带把它平时的作用一并废掉。同 `check-worktree-strays` / `check-harvest-status`
    的闸位取舍。

    ── 安静度（观察线的另一半设计要求）────────────────────────────────
    「生下来就吵的检查一定会被静音」已有先例，故：**零命中时只打 3 行、
    零样本时只打 2 行**，明细行受 `-MaxListPerSignal` 限量。
    但**零样本那一行不能省**——它报的是「本次未扫任何样本」，而那与「通过」是
    两件事（mousse-cli issue #285 已实证：检测器数到 0 个违例，和检测器根本没看到样本，
    输出可以逐字节相同）。

.PARAMETER ScanRoot
    扫描面根目录，缺省 `<RepoRoot>/_tmp`（`_tmp/` 是 dao 级约定，见 dao.md Shell 节
    「临时文件归项目 `<项目根>/_tmp/`」，不是某个项目的私货）。
    **只扫它的顶层、只扫 `.md`、不递归**——判据与代价见
    `ccswitch/lib/pr-body-scan.ps1` 的 `Get-PrBodyScanFiles`。
    本参数同时是**测试注入点**（`tests/pr-body-scan.tests.ps1` 喂临时夹具目录），
    形态照抄 `check-clauses-structure.ps1` 的 `-TargetFile`：测试不覆写任何真实文件。

.PARAMETER RepoRoot
    被检项目的仓根，缺省由 `$PSScriptRoot` 上推两级（即 dao 仓自己）。
    **跨仓调用必传**：项目侧的调用外壳传自己的仓根。

.PARAMETER RepoSignature
    目录守卫的「这确实是那个仓」指纹：一组相对 `-RepoRoot` 的路径，缺一即拒绝报数。
    缺省 `@('.git')` —— **刻意取最弱的那一档**：canonical 不知道调用它的是什么项目，
    编一个更强的默认值等于把某个项目的形态写进共享层（那正是本次上移要治的病）。
    **代价照直写**：默认值下守卫几乎只挡得住「压根不是 git 仓」这一种走错。
    要真正的守卫强度，调用方必须传自己的指纹（如 mousse 传
    `scripts/verify-all.ps1,Cargo.toml,crates/mousse-app`）——**参数化把「守卫多强」
    的决定权交给了知道答案的那一方**，而不是让共享层猜。

.PARAMETER MaxListPerSignal
    每个信号最多打印几条明细，默认 5；`0` = 不限量。**条数始终全量打印**，
    折叠的只是明细行（同 check-clauses-structure 的 `-RetireListMax` 取舍）。

.PARAMETER MaxFileKB
    单文件体积上限，默认 2048（2MB）。超限的**照样列出来只是不读**——
    静默跳过正是这类检查要防的病。观察线绝不能成为验证流程的新故障点。

.NOTES
    退出码**恒为 0**（观察线）。有命中时打 `⚠` 并逐条列出，但不阻断。
    PS 5.1 兼容：不看输出文案判成败、无 `&&` 链、禁 `2>&1`。
    本文件含中文注释，必须以 **BOM UTF-8** 存盘。
#>

param(
    [string]$ScanRoot = '',
    [string]$RepoRoot = '',
    [string[]]$RepoSignature = @('.git'),
    [ValidateRange(0, 1000)][int]$MaxListPerSignal = 5,
    [ValidateRange(1, 1048576)][int]$MaxFileKB = 2048
)

# 观察线绝不能自己把验证流程搞红：内部一律 Continue，末尾恒 exit 0。
$ErrorActionPreference = 'Continue'

# 缺省仓根 = dao 仓自己（ccswitch/scripts → ccswitch → <dao根>）。跨仓调用必传 -RepoRoot。
if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
    $repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
} else {
    $repoRoot = $RepoRoot
}
# 判据库与本脚本同属 ccswitch/，走 ../lib —— **dot-source 不是可选的**：
# 判据被抄成第二份正是这次上移要治的病，抄一份就等于把 mousse 的双写搬到了 dao。
. (Join-Path (Split-Path -Parent $PSScriptRoot) 'lib/pr-body-scan.ps1')

# ---- 扫描面定位 --------------------------------------------------------------
# 相对路径显式按**当前 PowerShell 位置**解析。不这么做的话 .NET API 会拿它自己的
# CurrentDirectory（`Set-Location` 不同步它）去解析 ⇒ 在 worktree 里传相对路径
# 实际读的是**主仓**同名目录，而那边恰好存在时会静默扫错对象并报 OK。
# 判据与实证照抄 check-clauses-structure.ps1 同一段（属"静默跑错仓"同族）。
if ([string]::IsNullOrWhiteSpace($ScanRoot)) {
    $scanRootPath = Join-Path $repoRoot '_tmp'
    $usingDefault = $true
} else {
    $scanRootPath = if ([System.IO.Path]::IsPathRooted($ScanRoot)) { $ScanRoot }
                    else { Join-Path (Get-Location).Path $ScanRoot }
    $usingDefault = $false
}

# ---- 目录守卫（dao 血泪：切目录跑脚本会静默跑错仓）--------------------------
# 只在走默认扫描面时才守：显式传 -ScanRoot 的是测试注入，那时"仓根像不像目标仓"
# 与被扫对象无关。
Write-Host ("PRBODY_CWD={0}" -f $repoRoot)
if ($usingDefault) {
    # ---- 仓根指纹归一化（**跨进程调用必需**）--------------------------------
    # `powershell.exe -File x.ps1 -RepoSignature a,b,c` 里那串**整个**是一个字符串
    # （`-File` 的参数按字面串传，不走 PowerShell 的数组字面量解析）⇒ 直接当数组用
    # 会得到一个「路径叫 `a,b,c`」的元素，守卫于是**必然报缺、必然拦下**，而拦下的
    # 措辞与真的跑错仓一模一样。2026-08-02 首次跨仓冒烟当场撞到。
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
    if ($missingSig.Count -gt 0) {
        Write-Host ("[check-pr-body-mojibake] 目录守卫拦下：{0} 不像目标仓根（缺 {1}）——不在错误的仓上报数字。" `
            -f $repoRoot, ($missingSig -join ', '))
        Write-Host '[check-pr-body-mojibake] EXIT=0（观察线）'
        exit 0
    }
}

$scan = Invoke-PrBodyScan -Root $scanRootPath -MaxFileKB $MaxFileKB

function Write-HitBucket {
    <#
      打印一个信号：条数**始终全量** + 至多 Max 条明细。
      与 check-clauses-structure.ps1 的 Write-AgedBucket 同型（限量不藏问题，
      只折叠明细），但**不做日期轮转**——那边折叠的是一份长期稳定的清单，
      这边的命中要么很少、要么就是正在流血的现场，轮转只会让人看不全一次事故。
    #>
    param([string]$Header, [object[]]$Hits, [int]$Max, [string]$Note)

    $all = @($Hits)
    if ($all.Count -eq 0) { return }
    Write-Host ("  ⚠ {0}：命中 {1} 处 —— {2}" -f $Header, $all.Count, $Note)
    $shown = $all
    if ($Max -gt 0 -and $all.Count -gt $Max) { $shown = @($all[0..($Max - 1)]) }
    foreach ($h in $shown) {
        # 摘录**以命中为中心**，不从行首截（真实数据实测：乱码常在长行中后段，
        # 从行首截 72 字的摘录里一个异常字符都看不到 ⇒ 等于没指出问题在哪）。
        $excerpt = Get-PrBodyExcerpt -Line $h.Line -Index $h.Index
        Write-Host ("      · {0}:{1}  〔命中「{2}」〕{3}" -f $h.File, $h.LineNo, $h.Hit, $excerpt)
    }
    if ($shown.Count -lt $all.Count) {
        # ⚠ 先拼模板再 -f：PowerShell 里 `"a{0}" -f $x + "b"` 会被解析成
        #    `"a{0}" -f ($x + "b")`（`+` 比 `-f` 结合得紧），静默给出错的输出。
        #    同一个坑 check-clauses-structure.ps1 里踩过并留了注释，此处照办。
        $more = '      ↳ 只列前 {0}/{1} 条（不轮转：命中是现场不是长期清单，要看全用 -MaxListPerSignal 0）'
        Write-Host ($more -f $shown.Count, $all.Count)
    }
}

Write-Host ''
Write-Host '---- PR 正文乱码 / 未填占位符观察线（报告型，不影响退出码）----'

if (-not $scan.RootExists) {
    # 新 worktree 里 `_tmp/` 常常压根不存在（`.gitignore` 掉了，不随 checkout 出现）。
    # **这不是错误，但也绝不是"通过"** —— 已记过一例：某检查因 `_tmp/` 不存在
    # 而重定向失败、一行没跑，通知层却报 completed (exit code 0)。故这里显式说清。
    Write-Host ("  ⚪ 零样本：扫描面目录不存在（{0}）—— **本次未扫任何样本，这不是「通过」**。" -f $scan.Root)
    Write-Host '     （新 worktree 里 _tmp/ 尚未生成属正常；它一旦有回读记录，这里就会开始报数。）'
} elseif ($scan.ZeroSample) {
    Write-Host ("  ⚪ 零样本：{0} 顶层成功扫完 0 个 .md —— **本次未扫任何样本，这不是「通过」**；分不开「本批没发 PR/评论」与「发了但没回读」。" -f $scan.Root)
    Write-Host '     产出回读记录（用 Bash 工具跑，重定向字节直落）：gh pr view <n> --json body -q .body > _tmp/pr-<n>-readback.md'
    if (@($scan.Oversized).Count -gt 0) {
        Write-Host ("     另有 {0} 个 .md 因超过 {1}KB 被跳过（列出而非静默）：{2}" `
            -f @($scan.Oversized).Count, $MaxFileKB, ((@($scan.Oversized) | ForEach-Object { $_.Name }) -join ' · '))
    }
    if (@($scan.Unreadable).Count -gt 0) {
        # **这一档最要命**：目录里有正文、却一个都没扫成 ⇒ 上面那句"零样本"是对的，
        # 但原因不是"本批没发 PR"，而是**检测器坏了**。必须把原因贴出来，否则这行
        # 零样本会被读成"没什么事"，而实际上守卫已经全盲。
        Write-Host ("     ⚠ 其中 {0} 个是**扫描失败**（不是没有正文，是检测器没跑成）：" -f @($scan.Unreadable).Count)
        foreach ($u in @($scan.Unreadable)) { Write-Host ("       · {0}：{1}" -f $u.Name, $u.Error) }
    }
} else {
    # 文件名清单折叠，但**三个计数始终全量**（分母不许被折叠——「样本量静默塌陷
    # 而指标变好看」是 mousse-cli issue #285 的实测形态）。
    $scannedNames = @($scan.Scanned)
    $names = ($scannedNames -join ' · ')
    if ($scannedNames.Count -gt 8) {
        $names = (($scannedNames[0..7]) -join ' · ') + ('（…等共 {0} 个）' -f $scannedNames.Count)
    }
    Write-Host ("  扫描面：{0} 顶层（非递归）{1} 个 .md，成功扫完 {2} 个，其中 {3} 个像 PR 正文/回读记录 —— {4}" `
        -f $scan.Root, @($scan.Files).Count, $scannedNames.Count, $scan.ArtifactCount, $names)
    if ($scan.ArtifactCount -eq 0) {
        Write-Host '     ⚠ 一个都不像回读记录 ⇒ 条款第③步的产物不在这里（下面扫的是别的 md）。'
    }

    Write-HitBucket -Max $MaxListPerSignal -Hits $scan.Signature4 `
        -Header '乱码签名字 A1 [锛銆馃鈥]（条款原文四字）' `
        -Note '真是乱码就按条款重发：改正文文件 → gh pr edit <n> --body-file <文件> → 再回读一次'
    Write-HitBucket -Max $MaxListPerSignal -Hits $scan.EuroAdjCjk `
        -Header '乱码签名字 A2（€ 紧贴汉字）' `
        -Note 'CP936 把 UTF-8 第三字节 0x80 读成 €；A1 对短正文是哑的，这一条补那一档'
    Write-HitBucket -Max $MaxListPerSignal -Hits $scan.Placeholder `
        -Header '未替换占位符 B1 <ALLCAPS>' `
        -Note '#269 实证：字符串已成乱码后 -replace 不命中且不报错，<PLACEHOLDER> 原样上线'
    Write-HitBucket -Max $MaxListPerSignal -Hits $scan.Evidence `
        -Header '📸 证据行 B2（待补/TBD/随后补）' `
        -Note 'PR 真机证据三态（母版 ccswitch/templates/pr-evidence-rule.md）：第三态必须填真实 issue 编号，这三个词都不成立'

    $total = @($scan.Signature4).Count + @($scan.EuroAdjCjk).Count + `
             @($scan.Placeholder).Count + @($scan.Evidence).Count
    if ($total -eq 0) {
        Write-Host '  A1/A2 乱码签名字、B1 占位符、B2 证据行：均零命中。'
    } else {
        Write-Host '  ⚠ 判据是近似：**零命中，或命中处是你有意引用的样例**——#175 的 body 是好的，只因引用了一段乱码样例而命中。最后一步人判。'
    }
    # 这一行**每次都打**（不只在零命中时）：它防的是把本检查读成保证。
    Write-Host '  射程：零命中 ≠ 编码一定对。「正文被 shell 静默删掉」那两例（条款 n=4 中的第 3、4 例）不留签名，本检查看不见。'

    if (@($scan.Oversized).Count -gt 0) {
        Write-Host ("  跳过（>{0}KB，列出而非静默）：{1}" `
            -f $MaxFileKB, ((@($scan.Oversized) | ForEach-Object { $_.Name }) -join ' · '))
    }
    if (@($scan.Unreadable).Count -gt 0) {
        # 部分文件扫失败：**上面那几行「零命中」的分母因此小于扫描面**，必须说出来。
        # 「样本量静默塌陷而指标变好看」是 mousse-cli issue #285 已实证过的形态。
        Write-Host ("  ⚠ 扫描失败 {0} 个（上面各信号的分母因此只有 {1}/{2}）：" `
            -f @($scan.Unreadable).Count, @($scan.Scanned).Count, @($scan.Files).Count)
        foreach ($u in @($scan.Unreadable)) { Write-Host ("      · {0}：{1}" -f $u.Name, $u.Error) }
    }
}

Write-Host '----------------------------------------------'
Write-Host ''
Write-Host '[check-pr-body-mojibake] EXIT=0（观察线，恒不阻断）'
exit 0
