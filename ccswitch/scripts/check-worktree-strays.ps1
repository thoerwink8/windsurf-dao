<#
.SYNOPSIS
    「此刻 `git add -A` 会额外收走什么」清单（观察线，恒 exit 0）。

.DESCRIPTION
    **canonical（2026-08-02 由 mousse-cli `scripts/check-worktree-strays.ps1` 上移 ·
    自上而下审计第 11 件）。为什么住在 dao：判据条款本身住在 dao，而且那条条款的
    正文里就写着这个脚本的路径**（`ccswitch/rules/dao-officer-clauses.md` 通用节
    「多官在途时收账一律 `git add <具体路径>`，禁 `-A` / `.`」，其「机检半是观察线
    不是闸」一句直指 `scripts/check-worktree-strays.ps1`）—— **一份全局规则文件
    指着一个项目里的脚本，就是「判据在上、机器在下」最直白的形态**。
    上移改的只是外壳（仓根指纹参数化），判定逻辑一行未动。

    ── 它治的病（收割 H2-3）──────────────────────────────────────────────
    2026-07-27 帅本人实证：多官并行期间收账用了 `git add -A`，把一个 89KB 的垃圾文件
    `et VTPROBE_HOST=mousse` 提交进 main 并推送。来源是某位在途官的 shell 命令
    `set VTPROBE_HOST=mousse` 被截断——`s` 被吃掉，剩下的成了重定向目标文件名，
    落在主仓工作树根。

    **这条本可以不发生**：同窗早些时候已有官给过警告「在共享仓用 `git add -A` 是真风险」，
    但那句话被接收方读成了「windsurf-dao 的问题」。**主仓在多官并行期间是同一种共享仓。**

    ── 它做什么 ──────────────────────────────────────────────────────────────
    只回答一个**没有歧义**的问题：**如果你现在跑 `git add -A`，会额外把哪些东西带进去？**
    答案分两段打印：

      · **A 段 · 未跟踪文件**（`git status --porcelain` 的 `??`）——`git add -A` 会**新增**它们。
        这是 H2-3 那个事故的精确形态。仓根层（无目录分隔符）单独高亮：截断的 shell
        重定向、误跑的命令、复制粘贴出来的临时文件，**落点几乎总是仓根**。
      · **B 段 · 已跟踪但工作区有改动的文件**——`git add -A` 会**一并暂存**它们，
        包括别人的半成品。

    B 段按「判『文件是否被改』用 `git diff --numstat`，不用 `git status` 的 ` M`」
    做二次判定：`--numstat` 为空的条目标注为 `stat 假象`（构建工具触碰 mtime
    导致的行尾归一化差异，内容级为零），**与真改动分开列**，免得把噪音喂给读的人。

    ── 为什么是观察线而不是硬闸（显式决定，不是漏了）────────────────────────
    按条款「新增机检项先判闸位：『代码错了』用硬闸，『人该判断一件事』用观察线」
    （`ccswitch/rules/dao-officer-clauses.md` 通用节，收割 H1-7）：

    「工作树里有未跟踪文件」**本身没有对错**——实现官正在写的新文件也长这样。
    有对错的是「这些该不该进**本次**提交」，而**本脚本不知道你这次要提交什么**
    （没有任何机器可读的「本次改动清单」，那个东西只存在于派单令和人的脑子里）。
    做成硬闸 ⇒ 任何人在写新文件时验证就红 ⇒ 立刻被 `-Skip` 掉 ⇒ 这道检查作废。

    **故本脚本恒 exit 0，任何情况下都不阻断调用方**（含 git 调用失败——
    此时打印醒目告警但仍退 0；观察线一旦能退非零，就会把整条验证流程判红，
    而典型验证入口的**失败判定**只看退出码）。

    ⚠ **2026-07-28 订正上一句的射程**（出处 mousse-cli verify-all）：那里的退出码判定自那天起**不再只看
    退出码**——多了一档「无失败但有硬闸被 -Skip 跳过 ⇒ exit 2」，那一档**要看
    IsGate**（判据见该仓 `scripts/lib/verify-exit.ps1` 文件头「边界①」）。对本脚本没有
    任何影响：**观察线被跳过不触发 2**，恰恰就是为了不让 `-Skip check-worktree-strays`
    这类常规操作产出非零码——那会把 2 变成噪音，进而废掉它对硬闸的作用，正是本文件
    上面那段「做成硬闸就会被 -Skip 掉」的同一条道理。原句在**失败判定**这一档上仍然
    准确，只是它当时是整个退出码的全部，现在只是其中一档。

    ── 射程边界（两个方向都写明，别把它当护栏读）──────────────────────────
    · **它不拦任何东西**，只打印。真正要执行的是那条条款：`git add <具体路径>`。
    · **被 .gitignore 覆盖的文件不出现在 A 段**——`git status --porcelain` 默认不列忽略项，
      而 `git add -A` 也不会加它们，**两者射程一致**，这是刻意的，不是漏。
      代价：`_tmp/` 之类里的东西本脚本一概看不见（它们也确实进不了提交）。
    · **它只看当前工作树**。别的 worktree、别的仓里的散落物看不见。
    · **它区分不了「别人的半成品」和「我自己还没 add 的文件」**——那是人的判断。
      本脚本能保证的只有一件事：**你在跑 `git add -A` 之前，这份清单在你眼前过过一遍。**
    · **时机不对齐**：验证入口通常在收尾时跑，而 `git add` 可能在那之后（也可能在之前）。
      本脚本**不是** pre-commit 钩子，不保证「加之前一定看到」。这是已知缺口，如实写。

.PARAMETER RepoRoot
    被检项目的仓根，缺省由 `$PSScriptRoot` 上推两级（即 dao 仓自己）。**跨仓调用必传。**

.PARAMETER RepoSignature
    目录守卫的「这确实是那个仓」指纹：一组相对 `-RepoRoot` 的路径，缺一即拒绝报数。
    缺省 `@('.git')` —— **刻意取最弱的那一档**，理由与代价同
    `check-pr-body-mojibake.ps1` 的同名参数（canonical 不该猜调用方是什么项目；
    要真守卫强度就由调用方传自己的指纹）。**本脚本的守卫尤其不能省**：它读的是
    `git status`，跑错仓时输出**看起来完全正常**——那正是「答的是另一个问题」。

.PARAMETER MaxList
    每段最多列出多少条（默认 40）。超出只打计数与提示，避免一屏刷满。

.NOTES
    退出码：**恒 0**。理由见 .DESCRIPTION「为什么是观察线」。
    PS 5.1 兼容：无 && 链、无三元、不用 2>&1（native stderr 会被包成 NativeCommandError）；
    成败只看 $LASTEXITCODE。
#>

param(
    [string]$RepoRoot = '',
    [string[]]$RepoSignature = @('.git'),
    [ValidateRange(1, 10000)][int]$MaxList = 40
)

$ErrorActionPreference = 'Continue'

# 缺省仓根 = dao 仓自己（ccswitch/scripts → ccswitch → <dao根>）。跨仓调用必传 -RepoRoot。
if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
    $RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
}

# ---- 目录守卫（dao 血泪：切目录跑脚本会静默跑错仓）--------------------------
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
Write-Host ("STRAYS_CWD={0}" -f $RepoRoot)
if ($missingSig.Count -gt 0) {
    Write-Host ("[check-worktree-strays] 目录守卫拦下：{0} 不像目标仓根（缺 {1}）。" -f $RepoRoot, ($missingSig -join ', '))
    Write-Host '[check-worktree-strays] EXIT=0（观察线恒不阻断；但本次没扫到任何东西，别把它读成「干净」）'
    exit 0
}

Write-Host ''
Write-Host '======================================================='
Write-Host '  此刻 `git add -A` 会额外收走什么（观察线 · 恒不阻断）'
Write-Host '======================================================='

# --untracked-files=all：默认的 normal 模式对未跟踪目录只打一行目录名，
# 而 `git add -A` 收的是里面每个文件——射程要对齐，故用 all。
# -z 会把输出变成 NUL 分隔，PS 5.1 处理起来更麻烦；绝大多数仓的文件名不含换行，用行模式。
# -c core.quotepath=false：否则中文/非 ASCII 文件名会被 git 转成八进制转义
# （`"\346\226\207"`），本脚本不解码 ⇒ 路径拼不出来、体积显示成 `?`。中文文档常见，
# 这条不是假想输入。**残余边界**：文件名里含 `"` 或反斜杠时 git 仍会 C 转义，
# 那种情况下条目照样列出（不丢），只是体积显示为 `?`——**丢条目才是本脚本最要防的失败**。
$porcelain = @(& git -C $RepoRoot -c core.quotepath=false status --porcelain --untracked-files=all)
if ($LASTEXITCODE -ne 0) {
    Write-Host '  ⚠ git status 调用失败——本次拿不到工作树状态。'
    Write-Host '  **这不等于「工作树干净」**：拿不到就是不知道，别据此判断可以 `git add -A`。'
    Write-Host '[check-worktree-strays] EXIT=0（观察线恒不阻断，失败也不例外——理由见脚本头）'
    exit 0
}

$untracked = @()
$modified  = @()

foreach ($line in $porcelain) {
    if ([string]::IsNullOrEmpty($line) -or $line.Length -lt 4) { continue }
    $code = $line.Substring(0, 2)
    $path = $line.Substring(3)
    # 重命名形态 `R  old -> new`：取箭头右侧那个（`git add -A` 关心的是新路径）。
    $arrow = $path.IndexOf(' -> ')
    if ($arrow -ge 0) { $path = $path.Substring($arrow + 4) }
    # 带空格的文件名会被 git 加引号（正是 H2-3 那个 `et VTPROBE_HOST=mousse` 的形态）——
    # 去引号只为显示与 depth 计算；原样也一并留着，让人看得见引号本身就是个信号。
    $display = $path
    $clean   = $path.Trim('"')

    if ($code -eq '??') {
        $untracked += [PSCustomObject]@{ Path = $clean; Display = $display }
    } elseif ($code.Substring(1, 1) -ne ' ' -and $code -ne '!!') {
        # 第二列非空 = 工作区侧有改动（未暂存），正是 `git add -A` 会顺手带走的那些。
        $modified += [PSCustomObject]@{ Path = $clean; Display = $display; Code = $code }
    }
}

# ---- A 段 · 未跟踪文件 --------------------------------------------------------
Write-Host ''
Write-Host '  ── A 段 · 未跟踪文件（`git add -A` 会**新增**它们）──'
if ($untracked.Count -eq 0) {
    Write-Host '  [无] 工作树没有未跟踪文件（被 .gitignore 覆盖的不算，它们也进不了提交）。'
} else {
    # 仓根层 = 路径里没有 '/'。H2-3 那个垃圾文件正是落在这一层：
    # 被截断的 shell 重定向、误跑的命令、粘贴出来的临时文件，落点几乎总在仓根。
    $atRoot = @($untracked | Where-Object { $_.Path.IndexOf('/') -lt 0 })
    $inDirs = @($untracked | Where-Object { $_.Path.IndexOf('/') -ge 0 })

    Write-Host ("  共 {0} 个（仓根层 {1} · 子目录 {2}）" -f $untracked.Count, $atRoot.Count, $inDirs.Count)

    if ($atRoot.Count -gt 0) {
        Write-Host ''
        Write-Host '  ⚠ **仓根层**（H2-3 事故的精确落点，逐个确认是不是你自己建的）：'
        foreach ($u in ($atRoot | Select-Object -First $MaxList)) {
            $sizeTag = '?'
            $full = Join-Path $RepoRoot $u.Path
            if (Test-Path -LiteralPath $full -PathType Leaf) {
                $len = (Get-Item -LiteralPath $full).Length
                $sizeTag = ("{0} B" -f $len)
            } elseif (Test-Path -LiteralPath $full -PathType Container) {
                $sizeTag = '(目录)'
            }
            Write-Host ("    · {0}  [{1}]" -f $u.Display, $sizeTag)
        }
        if ($atRoot.Count -gt $MaxList) {
            Write-Host ("    …… 另有 {0} 个未列出（-MaxList 调）" -f ($atRoot.Count - $MaxList))
        }
    }
    if ($inDirs.Count -gt 0) {
        Write-Host ''
        Write-Host '  子目录下：'
        foreach ($u in ($inDirs | Select-Object -First $MaxList)) {
            Write-Host ("    · {0}" -f $u.Display)
        }
        if ($inDirs.Count -gt $MaxList) {
            Write-Host ("    …… 另有 {0} 个未列出（-MaxList 调）" -f ($inDirs.Count - $MaxList))
        }
    }
}

# ---- B 段 · 已跟踪但工作区有改动 ---------------------------------------------
# `` M`` 不是「内容被改」的证据，构建工具触碰 mtime 后 git 重新 stat
# 会报出内容级为零的差异。故此处对每条再跑一次 `git diff --numstat` 二次判定，
# 把 stat 假象与真改动分开列——不这么做，这一段在跑过任何 watch 型构建之后会全是噪音。
Write-Host ''
Write-Host '  ── B 段 · 已跟踪且工作区有改动（`git add -A` 会**一并暂存**）──'
if ($modified.Count -eq 0) {
    Write-Host '  [无] 没有未暂存的工作区改动。'
} else {
    $realChanged = @()
    $statOnly    = @()
    foreach ($m in $modified) {
        $numstat = @(& git -C $RepoRoot diff --numstat -- $m.Path)
        if ($LASTEXITCODE -ne 0) {
            # 判不出来就当真改动列出——宁可多报，不静默漏报。
            $realChanged += $m
            continue
        }
        if ($numstat.Count -eq 0) { $statOnly += $m } else { $realChanged += $m }
    }
    Write-Host ("  共 {0} 个（内容确有差异 {1} · stat 假象 {2}）" -f $modified.Count, $realChanged.Count, $statOnly.Count)
    if ($realChanged.Count -gt 0) {
        Write-Host ''
        Write-Host '  内容确有差异（`git diff --numstat` 非空）：'
        foreach ($m in ($realChanged | Select-Object -First $MaxList)) {
            Write-Host ("    · [{0}] {1}" -f $m.Code, $m.Display)
        }
        if ($realChanged.Count -gt $MaxList) {
            Write-Host ("    …… 另有 {0} 个未列出" -f ($realChanged.Count - $MaxList))
        }
    }
    if ($statOnly.Count -gt 0) {
        Write-Host ''
        Write-Host '  stat 假象（`--numstat` 为空，内容级零差异；构建触碰 mtime 所致）：'
        foreach ($m in ($statOnly | Select-Object -First $MaxList)) {
            Write-Host ("    · [{0}] {1}" -f $m.Code, $m.Display)
        }
        if ($statOnly.Count -gt $MaxList) {
            Write-Host ("    …… 另有 {0} 个未列出" -f ($statOnly.Count - $MaxList))
        }
    }
}

# ---- 结语 ---------------------------------------------------------------------
Write-Host ''
Write-Host '  ── 该拿它怎么办 ──'
Write-Host '  条款（`ccswitch/rules/dao-officer-clauses.md` 通用节）：**多官在途时，收账一律'
Write-Host '  `git add <具体路径>`，禁 `-A` / `.`。** 上面两段就是「`-A` 与「具体路径」'
Write-Host '  之间的差集」——差集里每一条你都答得出「这是我这次要提交的东西」才算过。'
Write-Host '  本脚本**不拦**，也不知道你这次要提交什么（没有机器可读的「本次改动清单」）。'
Write-Host '  它只保证：你在敲那条命令之前，这份差集在你眼前过过一遍。'
Write-Host '======================================================='
Write-Host '[check-worktree-strays] EXIT=0（观察线，恒不阻断——多少条都不变红）'
exit 0
