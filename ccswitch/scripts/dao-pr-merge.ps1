#requires -Version 5.1
<#
.SYNOPSIS
    PR 合并期机械链的 canonical 实现：fetch → 核 rev-parse 真的动了 → merge 主干 → 重跑验证
    → 合 PR → prune → 核远程分支真的没了。

.DESCRIPTION
    这条链在 dao.md 里长期只以**文字**形态存在，而它每一步都是零判断祈使句
    （跑哪个命令、按什么顺序、核哪个输出），属「照做档」——照做档该做成脚本，不该做成要记的规矩。

    链上每一步防的是一个**已实证的静默失败**，逐条对应：

      1) git fetch                     —— 它会**静默失败**：网络错误后 fetch 报错，而后续
                                          `merge origin/main` 照跑并报 `Already up to date`，
                                          又一个「语法层面的绿」。故必须看 fetch 自己的退出码。
      2) 核 rev-parse origin/<主干>     —— 打印 before/after 让人能核。**注意「没动」不等于失败**
                                          （主干本来就是最新时它就是不动），本步的价值是把
                                          「fetch 到底跑成没有」变成可见的两行，不是断言它必须变。
      3) merge 主干进当前分支           —— 预算型护栏（单文件 LOC / 复杂度 / 依赖数 / 包体积 /
                                          覆盖率下限）对**总量**设限，而 PR 是按**增量**审的
                                          ⇒ 两边各自都没越线、合起来越线。`gh pr view --json
                                          mergeable` 回答的是「两份文本能不能自动合到一起」，
                                          不是「合到一起之后还成不成立」。
      4) 重跑验证                       —— 必须在**合并后的树**上跑。跨项目不可知，故命令由
                                          -VerifyCommand 传入；不传就必须显式 -SkipVerify，
                                          且那时退出码是 2 不是 0（见 .NOTES 退出码契约）。
      5) gh pr merge（**只合，不删分支**）—— 判据是随后 `gh pr view --json state` 实查到的
                                          **PR 状态**，不是 gh 的退出码。理由见下面
                                          「为什么第 5 步不看 gh 的退出码」。
      6) 删远程分支 + prune + ls-remote  —— 删分支是**独立的一步**、判它自己的退出码；
                                          删完实查 `ls-remote` 仍在 ⇒ 退出码 4
                                          （与「全清干净」严格区分）。

    **为什么第 5 步不看 gh 的退出码，也不再传 --delete-branch（2026-08-04，issue #114）**

    `gh pr merge --merge --delete-branch` 是**两个动作共用一个退出码**：合并那半成功、删分支
    那半失败时，gh 退出非 0，而 PR 其实已经合了。本脚本原先据此判「合并失败」并硬停 ⇒
    **第 6 步（prune + 独立实查远程 + 补删）一步都没跑**，远程分支反而残留下来 ——
    **它预判对了现象、处方也对（末尾独立实查），但那个处方跑不到**，因为同一个退出码
    先被用来判「合并成没成」了。这正是本脚本通篇要治的那类病，打在了它自己身上。

    而在**多 worktree 工作流下这一步是结构性必失败**，不是偶发：`--delete-branch` 要切到
    主干才能删本地分支，而主干总是被主仓占着（`fatal: 'master' is already used by
    worktree at ...`）。⇒ 从 PR 分支的 worktree 里跑，原实现每一次都会误判。

    两条修法一起做：
      · **止血**：合并成败一律以 `gh pr view <n> --json state,mergedAt` **实查**为准 ——
        问「PR 现在是什么状态」，不问「刚才那条命令返回了几」。gh 非 0 而状态为 MERGED 时
        照常走第 6 步（那才是清理的正路），非 MERGED 才判失败。
      · **根治**：`--merge` 与删分支拆成两个动作，各判各的退出码。删远程分支归第 6 步
        （`git push origin --delete`，那本来就是它的活），删本地分支也在第 6 步单独判。
        **两个动作本来就不该共用一个退出码。**

    **四个不由脚本兜住的边界（照直写，别当它全包）** —— dao.md Shell 节只留一句指针，
    **这里是这四条的正文与唯一真相源**（成因见 rationales §Shell-1）：

      ① 用户在**网页端**自行点 merge 时 agent 不在场，本脚本一步都跑不到 —— 那条路只能靠
         `dao-verify` 的孤儿分支扫描**回溯式**兜底（事后捞，不是防住）。
      ② 本脚本**不判「验证命令选得对不对」**（它只跑你给的那条并看退出码），
         也**不判「这份改动该不该合」** —— 终审不可让渡，这一步永远是人的。
      ③ **实查本身读不到时，脚本 fail-closed 停在 2，清理归人**：`gh pr view` 连试 3 次
         （间隔 -StateProbeDelaySeconds）仍读不到状态时，本脚本**不猜** —— 既不拿 gh 的
         退出码顶替，也不继续删分支（删掉一个未合 PR 的远程分支代价更高）。这一档退出 2
         并把该核什么打在屏幕上。**「不确定」不许长得像「干净」**，这是退出码契约的本意。
      ④ **本脚本不拆自己所在的 worktree**（issue #114 方向 3，实现时判定为不做）：进程的
         cwd 就在那棵树里，Windows 上目录被占用删不掉；即便删得掉，脚本也会在自己被删掉的
         目录里接着跑完。故这一步仍归人 —— 但第 6 步会把**带真实路径、可直接复制**的两行
         收尾命令打出来，不再只说一句「请在主仓跑」。
         ⚠ **顺带修掉的一个隐性死码（2026-08-04 写回归网时发现，不在 issue #114 里）**：
         第 6 步的本地清理原先由 `if (-not $selfWt)` 守着，而 `$selfWt` **恒为真** ——
         第 0 步的 `$branch` 就是 `$RepoPath` 的当前分支，git 又不许同一分支在两棵树上被
         检出 ⇒ `$RepoPath` 必然在占用列表里。于是**那一段代码从来没跑过**，普通仓里直接跑
         也只会看到「请到主仓收尾」。现改用 `$selfIsMainWorktree`（本树是不是主工作树）判：
         主工作树切得到主干 ⇒ 真做本地清理；链接工作树切不到（主干被主仓占着，正是 #114
         那条 fatal 的成因）⇒ 打收尾命令给人。

    **诊断：判「这份改动进没进主干」（dao.md 只留一句判据，展开在这里）**
    本脚本**不做** `git patch-id` 那类诊断：它内里是取舍不是照做，脚本化会把一个需要人看的
    判断压成一个退出码。但判据必须有个家，就放在这里 —— 因为问出这个问题的时刻
    （孤儿分支扫描报「某分支未并入」、或本脚本第 6 步复核后远程分支还在）与本脚本同域。

      三个判据答的是**三个不同的问题**，极易被当成同一个：
        · `gh pr list --head <branch>` 空   ⇒ 只说明「这个**分支名**下没开过 PR」，
                                              内容可能早经另一条路进去了。
        · `git merge-base --is-ancestor`    ⇒ 判「这个 **commit 对象**在不在主干历史里」，
                                              对 cherry-pick / 重复推送 / rebase 后的
                                              **等价提交结构性失明**。
        · `git patch-id --stable`           ⇒ 才是「**这份改动**在不在」。

      ⇒ **看到「未并入」先用 patch-id 复核再动作**；分支上已有等价内容时，**开 PR 反而有害**
        （照令开 PR 会提议回滚一个已发布版本，经过见 rationales §Shell-2）。这一条的价值不在删分支，在于它是
        「**一个信号诚实地回答了另一个问题**」在 git 上的实例。

      **它自己的订正史一并留着，别让它日后被读成一次救火**：2026-07-29 立条时的原始叙述把
      一条孤儿分支写成「102 行测试遗失三天无人知晓」并据此立论，**当晚派官核实即被证伪**
      ——本窗唯一一次「疑似遗失工作」经 patch-id 复核后是误判（基线 1/1）。

.PARAMETER PullRequest
    要合并的 PR 号。必填。

.PARAMETER RepoPath
    仓库工作树路径。缺省当前目录。跨 workspace 时**务必显式传**，不要只依赖 cwd。

.PARAMETER MainBranch
    主干分支名。缺省从 `origin/HEAD` 探测，探不到时回落 main（再回落 master）。

.PARAMETER VerifyCommand
    合并后要重跑的验证命令（整串，交给 shell 之外的 `Invoke-Expression` 之前会原样打印）。
    **跨项目不可知，所以没有缺省值**：mousse 侧是 `scripts/verify-all.ps1`，dao 侧是
    `node scripts/run-tests.mjs --env`，别的项目又是别的。不传即必须显式 -SkipVerify。
    ⚠ **dao 侧那个 `--env` 不是可选的**（2026-08-04 · issue #116）：`run-tests.mjs` 分了两层，
    **默认层恒返回 2**（「本次没跑完」——环境敏感断言被 defer 掉了），只有 `--env` 才拿得到 0。
    本步的判据是 `-ne 0` 即停，所以不带 `--env` 的那一串会在这里当场停住合并链。
    这是有意的：合并前是本仓唯一一个「必然发生 + 必然要求 exit 0」的时刻，环境敏感层就挂在这。

.PARAMETER SkipVerify
    显式跳过第 4 步。跳了以后**最终退出码是 2 不是 0**——「没跑」与「跑过且过了」不许在
    唯一的机器可读通道上长得一样。

.PARAMETER NoMerge
    只跑 1-4 步（刷新基点 + 重跑验证），不合 PR、不删分支。用于「先看看合进去还绿不绿」。

.PARAMETER StateProbeDelaySeconds
    第 5 步实查 PR 状态失败后的重试间隔（秒），缺省 2、共试 3 次。**存在的第一个理由是
    回归网**（把它压到 0 才能在秒级里测「实查读不到 ⇒ fail-closed 退 2」这一档）；
    网络慢的环境调大也是正当用法。**它不影响任何判据**，只影响等多久。

.PARAMETER DryRun
    只做只读查询并逐条打印将要执行什么，不发起任何写操作（不 merge、不 push、不删分支、
    不跑验证命令）。**任何一次真跑之前先跑一遍这个。**
    ⚠ **DryRun 照不出第 5 步的判据**（issue #114 就是 DryRun 全过之后才撞上的）：
    它在第 5 步只打印不执行，于是「gh 说什么」与「PR 实际是什么状态」这对分歧根本不发生。
    那一档的判别力在回归网 `tests/dao-pr-merge.tests.ps1`，不在 DryRun。

.EXAMPLE
    # 先看会做什么
    .\dao-pr-merge.ps1 -PullRequest 42 -RepoPath D:\frank\myrepo -VerifyCommand 'node scripts/run-tests.mjs --env' -DryRun

.EXAMPLE
    # 真跑
    .\dao-pr-merge.ps1 -PullRequest 42 -RepoPath D:\frank\myrepo -VerifyCommand 'pwsh -File scripts/verify-all.ps1'

.EXAMPLE
    # 只想确认「合进主干后还绿不绿」，先不合 PR
    .\dao-pr-merge.ps1 -PullRequest 42 -VerifyCommand 'npm test' -NoMerge

.NOTES
    退出码契约（五态；只有 0 叫「全链跑完且干净」）：
      0  全链完成（DryRun 正常走完也是 0）
      1  前置条件不成立（不是 git 仓 / git 或 gh 缺失 / PR 读不到）——一步都没做
      2  跑到一半失败，或**有必经步骤被显式跳过**（fetch 失败 / merge 冲突 / 验证红 /
         PR 实查为未合并 / PR 状态实查不到 / -SkipVerify）。
         **判「通过」一律写 `-eq 0`，别写 `-le 2`**——那个区间把 1 也放进来了。
      3  参数非法——一步都没做
      4  PR 合了，但**清理没干净**（远程分支仍在，删了也没删掉）。刻意与 0 分开：
         「删干净了」和「没删掉」在唯一的机器可读通道上长得一样，正是本脚本要治的那类病。

    ⚠ **2026-08-04（issue #114）只改了「哪些情形落进 2」，五态的语义一个字没动**：
    「gh pr merge 退出非 0」此前直接落 2，现在它**不再是判据** —— 落不落 2 由实查到的
    PR 状态决定。新增落进 2 的只有一档：状态实查不到（见 .DESCRIPTION 边界 ③）。

    PowerShell 5.1 兼容：不用 && / || / 三元 / ?? / ?.；成败一律看 $LASTEXITCODE 不看输出文案；
    不用 2>&1（会把 git/gh 的正常 stderr 包成 NativeCommandError）。

    回归网：windsurf-dao/tests/dao-pr-merge.tests.ps1（`gh` 走 PATH 前置的桩，git 是真的；
            核心是那条负控：gh 非 0 而 PR 实为 MERGED ⇒ 脚本必须走完第 6 步）。
            **改本脚本的第 5/6 步就去改它**——那里的断言是本文件这段判据的可执行形态。

    真相源：windsurf-dao/ccswitch/scripts/dao-pr-merge.ps1
    判据正文：windsurf-dao/ccswitch/dao.md · Shell 独有项「PR 合并期的机械链走脚本」
              + 反·归「预算型护栏必须在合并态求值」两条
              ⚠ 其中**不由脚本兜住的边界**与**patch-id 三判据**的正文已于 2026-08-02
              （dao.md 瘦身批 #6）迁进本文件 .DESCRIPTION，dao.md 那两处只剩判据一句 + 指针。
              改这两段时**同批回头看一眼 dao.md 那两行**，别让两边各说各话。
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][int]$PullRequest,
    [string]$RepoPath = (Get-Location).Path,
    [string]$MainBranch,
    [string]$VerifyCommand,
    [switch]$SkipVerify,
    [switch]$NoMerge,
    [ValidateRange(0, 60)][int]$StateProbeDelaySeconds = 2,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

# ── 输出 ─────────────────────────────────────────────────────────────────────
$script:Skipped = 0
function Write-Step([string]$t) { Write-Host ''; Write-Host ("=== $t ===") -ForegroundColor Cyan }
function Write-Ok([string]$t) { Write-Host ("  [完成] $t") -ForegroundColor Green }
function Write-Plan([string]$t) { Write-Host ("  [将做] $t") -ForegroundColor Yellow }
function Write-Note([string]$t) { Write-Host ("  [注意] $t") -ForegroundColor Yellow }
function Write-Info([string]$t) { Write-Host ("         $t") -ForegroundColor DarkGray }
function Write-Skip([string]$t) { $script:Skipped++; Write-Host ("  [跳过] $t") -ForegroundColor DarkGray }
function Fail([string]$t, [int]$code) {
    Write-Host ("  [失败] $t") -ForegroundColor Red
    Write-Host ''
    Write-Host ("VERIFY_EXIT=$code") -ForegroundColor Red
    exit $code
}

# ── git / gh 调用（不 2>&1；成败只看 $LASTEXITCODE）──────────────────────────
function Invoke-Git {
    param([string[]]$GitArgs)
    $out = & git -C $RepoPath @GitArgs
    return [pscustomobject]@{ Ok = ($LASTEXITCODE -eq 0); Code = $LASTEXITCODE; Out = $out }
}
function Invoke-Gh {
    param([string[]]$GhArgs)
    $out = & gh @GhArgs
    return [pscustomobject]@{ Ok = ($LASTEXITCODE -eq 0); Code = $LASTEXITCODE; Out = $out }
}
function GitLine {
    param([string[]]$GitArgs)
    $r = Invoke-Git -GitArgs $GitArgs
    if (-not $r.Ok) { return $null }
    return (($r.Out | Select-Object -First 1) -as [string])
}

function Get-PrMergeState {
    <#
      实查 PR 当前状态 —— **第 5 步唯一的判据**（issue #114）。
      问的是「PR 现在是什么状态」，不是「刚才那条命令返回了几」。

      连试 3 次（间隔 -StateProbeDelaySeconds），仍读不到就返回 Unknown=$true，
      由调用方 fail-closed。**刻意不拿 gh pr merge 的退出码顶替**：那正是要治的病。
      为什么允许重试：`gh pr create` 撞 5xx 是本体系记过的实例，而 merge 刚发生过、
      这一刻的 5xx 是最典型的瞬时故障；重试把「fail-closed」的代价压到只剩真故障。
    #>
    param([int]$Number)
    $attempts = 3
    $lastCode = $null
    for ($i = 1; $i -le $attempts; $i++) {
        Push-Location $RepoPath
        try { $q = Invoke-Gh -GhArgs @('pr', 'view', "$Number", '--json', 'state,mergedAt') } finally { Pop-Location }
        $lastCode = $q.Code
        if ($q.Ok) {
            $obj = $null
            try { $obj = ($q.Out -join "`n") | ConvertFrom-Json } catch { $obj = $null }
            if ($obj -and $obj.state) {
                return [pscustomobject]@{ Unknown = $false; State = [string]$obj.state; MergedAt = [string]$obj.mergedAt; Attempts = $i; Code = $q.Code }
            }
        }
        if ($i -lt $attempts) {
            Write-Note "PR 状态实查第 $i/$attempts 次未果（gh exit $($q.Code)）—— $StateProbeDelaySeconds 秒后重试"
            if ($StateProbeDelaySeconds -gt 0) { Start-Sleep -Seconds $StateProbeDelaySeconds }
        }
    }
    return [pscustomobject]@{ Unknown = $true; State = $null; MergedAt = $null; Attempts = $attempts; Code = $lastCode }
}

# ── 0. 参数与前置 ────────────────────────────────────────────────────────────
Write-Step '0. 前置检查'

if ($PullRequest -le 0) { Fail "PR 号非法：$PullRequest" 3 }
if ($SkipVerify -and $VerifyCommand) { Fail '-SkipVerify 与 -VerifyCommand 互斥，二选一' 3 }
if (-not $SkipVerify -and -not $VerifyCommand) {
    Fail '必须传 -VerifyCommand（合并后要重跑什么，跨项目不可知），或显式 -SkipVerify（那时退出码为 2）' 3
}

if (-not (Test-Path -LiteralPath $RepoPath)) { Fail "RepoPath 不存在：$RepoPath" 1 }
$RepoPath = (Resolve-Path -LiteralPath $RepoPath).Path

if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Fail '找不到 git' 1 }
$insideWorkTree = GitLine @('rev-parse', '--is-inside-work-tree')
if ($insideWorkTree -ne 'true') { Fail "不是 git 工作树：$RepoPath" 1 }

$branch = GitLine @('rev-parse', '--abbrev-ref', 'HEAD')
if (-not $branch -or $branch -eq 'HEAD') { Fail 'HEAD 处于 detached 状态，先 checkout 到分支' 1 }

if (-not $MainBranch) {
    $originHead = GitLine @('symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD')
    if ($originHead) { $MainBranch = $originHead -replace '^refs/remotes/origin/', '' }
}
if (-not $MainBranch) {
    $probe = Invoke-Git -GitArgs @('rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main')
    if ($probe.Ok) { $MainBranch = 'main' } else { $MainBranch = 'master' }
}

$verifyMain = Invoke-Git -GitArgs @('rev-parse', '--verify', '--quiet', "refs/remotes/origin/$MainBranch")
if (-not $verifyMain.Ok) { Fail "探不到 origin/$MainBranch（可用 -MainBranch 显式指定）" 1 }

# 目录守卫 marker：切目录跑脚本静默跑错仓是本体系实证过的病，把落点打出来供复核
Write-Info "VERIFY_CWD=$RepoPath"
Write-Info "VERIFY_BRANCH=$branch"
Write-Info "VERIFY_MAIN=$MainBranch"
Write-Ok "git 工作树就绪（当前分支 $branch，主干 $MainBranch）"

if ($branch -eq $MainBranch) { Fail "当前就在主干 $MainBranch 上——本脚本要从 PR 分支跑" 1 }

$needGh = (-not $NoMerge)
if ($needGh) {
    if (-not (Get-Command gh -ErrorAction SilentlyContinue)) { Fail '找不到 gh（合 PR 需要它；只想刷新基点+验证可加 -NoMerge）' 1 }
    # 在仓库目录内调用，让 gh 自己按 cwd 推仓库（不传 --repo，避免 owner/name 猜错）
    $pr = $null
    Push-Location $RepoPath
    try {
        $pr = Invoke-Gh -GhArgs @('pr', 'view', "$PullRequest", '--json', 'number,headRefName,state,title')
    } finally { Pop-Location }
    if (-not $pr.Ok) { Fail "读不到 PR #$PullRequest（gh exit $($pr.Code)）" 1 }
    $prObj = ($pr.Out -join "`n") | ConvertFrom-Json
    if ($prObj.state -ne 'OPEN') { Fail "PR #$PullRequest 状态是 $($prObj.state)，不是 OPEN" 1 }
    if ($prObj.headRefName -ne $branch) {
        Fail "PR #$PullRequest 的 head 是 $($prObj.headRefName)，而当前分支是 $branch——基点核对不上，不动" 1
    }
    Write-Ok "PR #$PullRequest 就绪：$($prObj.title)"
}

if ($DryRun) { Write-Note 'DryRun：以下写操作一律只打印不执行' }

# ── 1-2. fetch + 核 rev-parse 真的动了 ───────────────────────────────────────
Write-Step "1-2. git fetch → 核 origin/$MainBranch 真的动了"

$before = GitLine @('rev-parse', "refs/remotes/origin/$MainBranch")
Write-Info "before: $before"

if ($DryRun) {
    Write-Plan "git fetch origin（随后重新核 rev-parse，比对 before/after）"
} else {
    $f = Invoke-Git -GitArgs @('fetch', 'origin')
    if (-not $f.Ok) {
        Fail "git fetch 失败（exit $($f.Code)）——这一步失败后 merge 会照跑并报 Already up to date，是个语法层面的绿，故此处硬停" 2
    }
    $after = GitLine @('rev-parse', "refs/remotes/origin/$MainBranch")
    Write-Info "after : $after"
    if ($before -eq $after) {
        Write-Ok "fetch 成功；origin/$MainBranch 未变（主干本来就是最新——「没动」不等于失败）"
    } else {
        Write-Ok "fetch 成功；origin/$MainBranch 前进了（$before → $after）"
    }
}

# ── 3. merge 主干进当前分支 ──────────────────────────────────────────────────
Write-Step "3. merge origin/$MainBranch 进 $branch（预算型护栏要在合并态求值）"

$dirty = Invoke-Git -GitArgs @('status', '--porcelain')
if ($dirty.Out) {
    Fail "工作树不干净，先提交或 stash：`n$($dirty.Out -join "`n")" 2
}

if ($DryRun) {
    Write-Plan "git merge --no-edit origin/$MainBranch"
} else {
    $m = Invoke-Git -GitArgs @('merge', '--no-edit', "origin/$MainBranch")
    if (-not $m.Ok) {
        Write-Info ($m.Out -join "`n")
        Fail "merge 冲突或失败（exit $($m.Code)）——人来解，解完重跑本脚本" 2
    }
    Write-Ok "已合入 origin/$MainBranch"
}

# ── 4. 在合并后的树上重跑验证 ────────────────────────────────────────────────
Write-Step '4. 在合并后的树上重跑验证'

$verifySkipped = $false
if ($SkipVerify) {
    $verifySkipped = $true
    Write-Skip '验证被显式 -SkipVerify 跳过 —— 最终退出码将是 2，不是 0'
} elseif ($DryRun) {
    Write-Plan "在 $RepoPath 下执行：$VerifyCommand"
} else {
    Write-Info "执行：$VerifyCommand"
    Push-Location $RepoPath
    try {
        $global:LASTEXITCODE = 0
        Invoke-Expression $VerifyCommand
        $vcode = $LASTEXITCODE
    } finally { Pop-Location }
    if ($vcode -ne 0) { Fail "验证命令退出码 $vcode（非 0）——分支态的绿不构成合并态的证据，停" 2 }
    Write-Ok "验证通过（退出码 0）"
}

if ($NoMerge) {
    Write-Step '收尾（-NoMerge：只刷新基点 + 验证，不合 PR）'
    $code = 0
    if ($verifySkipped) { $code = 2 }
    Write-Host ''
    Write-Host ("VERIFY_EXIT=$code")
    exit $code
}

# ── 5. 合 PR（只合，不删分支——删分支归第 6 步，两个动作不共用一个退出码）────
Write-Step "5. 合 PR #$PullRequest（只 merge；成败以实查 PR 状态为准，不看 gh 退出码）"

$wtRaw = Invoke-Git -GitArgs @('worktree', 'list', '--porcelain')
$occupying = @()
$curWt = $null
$mainWt = $null
foreach ($line in $wtRaw.Out) {
    if ($line -like 'worktree *') {
        $curWt = $line.Substring(9)
        # `git worktree list` 第一条恒为主工作树 —— 第 6 步要拿它拼「到主仓跑这两行」的收尾命令
        if (-not $mainWt) { $mainWt = $curWt }
    }
    if ($line -eq "branch refs/heads/$branch") { $occupying += $curWt }
}
$selfWt = $null
foreach ($w in $occupying) {
    $resolved = $null
    if (Test-Path -LiteralPath $w) { $resolved = (Resolve-Path -LiteralPath $w).Path }
    if ($resolved -eq $RepoPath) { $selfWt = $w }
}

# ⚠ `$selfWt` **恒为真**，别拿它当「我在不在 worktree 里」的判据（2026-08-04 实测，
# 本次写回归网时才发现）：第 0 步的 $branch 就是 $RepoPath 的当前分支，而 git 不许同一分支
# 在两棵树上被检出 ⇒ $RepoPath 必然出现在 $occupying 里 ⇒ $selfWt 必然被赋值。
# 原第 6 步用 `if (-not $selfWt)` 守着本地清理那一段，于是**那一段从来没跑过**（连普通仓
# 直接跑也不跑），末尾恒打「请到主仓收尾」。—— 又一个「守卫在场、却对所有输入给同一个答案」。
# 真正要分的是**主工作树 vs 链接工作树**：前者 `git checkout <主干>` 做得了，
# 后者做不了（主干正被主仓占着，这就是 issue #114 那条 fatal 的成因）。
$selfIsMainWorktree = $true
if ($mainWt) {
    $mainResolved = $mainWt
    if (Test-Path -LiteralPath $mainWt) { $mainResolved = (Resolve-Path -LiteralPath $mainWt).Path }
    $selfIsMainWorktree = ($mainResolved -eq $RepoPath)
}
foreach ($w in $occupying) {
    $resolved = $null
    if (Test-Path -LiteralPath $w) { $resolved = (Resolve-Path -LiteralPath $w).Path }
    if ($resolved -eq $RepoPath) { continue }
    if ($DryRun) { Write-Plan "git worktree remove `"$w`""; continue }
    $rm = Invoke-Git -GitArgs @('worktree', 'remove', $w)
    if ($rm.Ok) { Write-Ok "已拆 worktree $w" } else { Write-Note "拆不掉 worktree $w（exit $($rm.Code)）——第 6 步删本地分支会失败，但删远程与实查照走" }
}
if (-not $selfIsMainWorktree) {
    Write-Note "本脚本自己就跑在占用 $branch 的**链接** worktree 里（$selfWt）—— 本地那一半归人，第 6 步会打出可复制的收尾命令"
}

if ($DryRun) {
    Write-Plan "gh pr merge $PullRequest --merge      （**不带** --delete-branch：删分支是第 6 步的活）"
    Write-Plan "gh pr view $PullRequest --json state,mergedAt   （实查 —— 这才是合并成败的判据）"
    Write-Note "DryRun 照不出第 5 步的判据：这里只打印，「gh 说什么」与「PR 实际是什么状态」的分歧根本不发生（issue #114 就是 DryRun 全过之后撞上的）"
} else {
    Push-Location $RepoPath
    try { $mg = Invoke-Gh -GhArgs @('pr', 'merge', "$PullRequest", '--merge') } finally { Pop-Location }
    if (-not $mg.Ok) { Write-Info ($mg.Out -join "`n") }

    # ── 判据在下面这一句，不在上面那个退出码 ──────────────────────────────
    $st = Get-PrMergeState -Number $PullRequest
    if ($st.Unknown) {
        Fail ("PR #$PullRequest 的状态实查不到（gh pr view 连试 $($st.Attempts) 次，末次 exit $($st.Code)；gh pr merge exit $($mg.Code)）" + [Environment]::NewLine +
              "         —— 本脚本不猜：不拿 merge 的退出码顶替，也不动分支。人来核 ``gh pr view $PullRequest --json state,mergedAt``，" + [Environment]::NewLine +
              "         已合就在主仓补 ``git push origin --delete $branch``；没合就重跑本脚本") 2
    }
    if ($st.State -eq 'MERGED') {
        if (-not $mg.Ok) {
            Write-Note "gh pr merge 退出 $($mg.Code)，而实查 PR 状态为 MERGED —— **以状态为准**，继续走第 6 步的清理"
            Write-Info "（这正是 issue #114：gh 的一个退出码盖着两个动作，据它判「合并失败」会让清理一步都跑不到）"
        }
        Write-Ok "PR #$PullRequest 已合并（实查 state=MERGED，mergedAt=$($st.MergedAt)，第 $($st.Attempts) 次读到）"
    } else {
        Fail "PR #$PullRequest 未合并：实查 state=$($st.State)（gh pr merge exit $($mg.Code)）—— 不动分支" 2
    }
}

# ── 6. 清理：删远程分支（独立动作、独立判） + prune + 实查复核 ───────────────
Write-Step '6. 清理：prune → 实查远程分支 → 删它 → 再实查一眼真的没了'

$exitCode = 0
if ($DryRun) {
    Write-Plan "git fetch --prune"
    Write-Plan "git ls-remote --heads origin $branch  （实查；非空则下一行）"
    Write-Plan "git push origin --delete $branch      （删分支是**这里**的独立动作，判它自己的退出码）"
    Write-Plan "git ls-remote --heads origin $branch  （删完再实查一眼；仍在 ⇒ 退出码 4）"
    if ($selfIsMainWorktree) {
        Write-Plan "git checkout $MainBranch；git pull --ff-only；git branch -d $branch"
    } else {
        Write-Plan "（本地那半跳过：本脚本正跑在 $branch 的链接 worktree 里，收尾命令会打在这里）"
    }
} else {
    $p = Invoke-Git -GitArgs @('fetch', '--prune')
    if (-not $p.Ok) { Write-Note "git fetch --prune 失败（exit $($p.Code)）" }

    $ls = Invoke-Git -GitArgs @('ls-remote', '--heads', 'origin', $branch)
    if ($ls.Out) {
        Write-Info "远程分支 $branch 还在（第 5 步刻意没让 gh 代劳）—— 删它"
        $del = Invoke-Git -GitArgs @('push', 'origin', '--delete', $branch)
        if (-not $del.Ok) { Write-Note "git push origin --delete $branch 失败（exit $($del.Code)）—— 下面这一眼会说清结果" }
        # 无论删的那一步说什么，都再实查一次：**不信任何一步的沉默**，这是整个第 6 步的理由
        $ls2 = Invoke-Git -GitArgs @('ls-remote', '--heads', 'origin', $branch)
        if ($ls2.Out) {
            Write-Host ("  [失败] 远程分支 $branch 删完仍在（实查 ls-remote）") -ForegroundColor Red
            $exitCode = 4
        } else {
            Write-Ok "已删远程分支 $branch（删完实查 ls-remote 确认为空）"
        }
    } else {
        Write-Ok "远程分支 $branch 已不存在（实查 ls-remote；仓库开了自动删分支，或已有人删过）"
    }

    if ($selfIsMainWorktree) {
        $co = Invoke-Git -GitArgs @('checkout', $MainBranch)
        if ($co.Ok) {
            $null = Invoke-Git -GitArgs @('pull', '--ff-only')
            $bd = Invoke-Git -GitArgs @('branch', '-d', $branch)
            if ($bd.Ok) { Write-Ok "已删本地分支 $branch" } else { Write-Note "本地分支 $branch 未删（exit $($bd.Code)）——多半仍被别的 worktree 占用" }
        } else {
            Write-Note "切回 $MainBranch 失败（exit $($co.Code)）"
        }
    } else {
        # 本脚本不拆自己所在的 worktree（.DESCRIPTION 边界 ④）——但把可复制的两行打出来，
        # 别再只说一句「请在主仓跑」（那句话每次都要人自己去查路径）
        Write-Note "本地那半跳过：本脚本正跑在 $branch 的链接 worktree 里，切不到主干、也删不掉自己脚下的目录。到主仓跑这两行收尾（可直接复制）："
        if ($mainWt) {
            Write-Info "  git -C `"$mainWt`" worktree remove `"$selfWt`""
            Write-Info "  git -C `"$mainWt`" branch -d $branch"
        } else {
            Write-Info "  git worktree remove `"$selfWt`""
            Write-Info "  git branch -d $branch"
        }
    }
}

if ($verifySkipped -and $exitCode -eq 0) { $exitCode = 2 }

Write-Host ''
Write-Host '──── 汇总 ────'
Write-Host "  PR #$PullRequest / 分支 $branch / 主干 $MainBranch"
if ($DryRun) { Write-Host '  DryRun：以上均未执行' }
if ($verifySkipped) { Write-Host '  验证被显式跳过 ⇒ 退出码 2（「没跑」不许长得像「跑过且过了」）' }
Write-Host ("VERIFY_EXIT=$exitCode")
exit $exitCode
