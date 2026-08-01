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
      5) gh pr merge --delete-branch    —— 它的**沉默不可信**：本地分支被 worktree 占用时它整体
                                          失败，而错误信息**只提本地** ⇒ 远程分支也没删，
                                          而你以为只是本地没删。故本脚本合并前先探 worktree 占用，
                                          合并后再独立核一次远程。
      6) fetch --prune + ls-remote 复核 —— 远程还在就补 `git push origin --delete <branch>`；
                                          补完仍在 ⇒ 退出码 4（与「全清干净」严格区分）。

    **本脚本不做的事（照直写，别当它全包）**：
      · 不判「验证命令选得对不对」——它只跑你给的那条并看退出码。
      · 不判「这份改动该不该合」——终审不可让渡，这一步永远是人的。
      · 不做 `git patch-id` 那类**诊断**（判一份改动进没进主干）：那一条内里是取舍不是照做，
        刻意留在 dao.md 正文，不脚本化。
      · 用户在网页端自行点 merge 时本脚本不在场——那条路只能靠孤儿分支扫描回溯兜底。

.PARAMETER PullRequest
    要合并的 PR 号。必填。

.PARAMETER RepoPath
    仓库工作树路径。缺省当前目录。跨 workspace 时**务必显式传**，不要只依赖 cwd。

.PARAMETER MainBranch
    主干分支名。缺省从 `origin/HEAD` 探测，探不到时回落 main（再回落 master）。

.PARAMETER VerifyCommand
    合并后要重跑的验证命令（整串，交给 shell 之外的 `Invoke-Expression` 之前会原样打印）。
    **跨项目不可知，所以没有缺省值**：mousse 侧是 `scripts/verify-all.ps1`，dao 侧是
    `node scripts/run-tests.mjs`，别的项目又是别的。不传即必须显式 -SkipVerify。

.PARAMETER SkipVerify
    显式跳过第 4 步。跳了以后**最终退出码是 2 不是 0**——「没跑」与「跑过且过了」不许在
    唯一的机器可读通道上长得一样。

.PARAMETER NoMerge
    只跑 1-4 步（刷新基点 + 重跑验证），不合 PR、不删分支。用于「先看看合进去还绿不绿」。

.PARAMETER DryRun
    只做只读查询并逐条打印将要执行什么，不发起任何写操作（不 merge、不 push、不删分支、
    不跑验证命令）。**任何一次真跑之前先跑一遍这个。**

.EXAMPLE
    # 先看会做什么
    .\dao-pr-merge.ps1 -PullRequest 42 -RepoPath D:\frank\myrepo -VerifyCommand 'node scripts/run-tests.mjs' -DryRun

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
      2  跑到一半失败，或**有必经步骤被显式跳过**（fetch 失败 / merge 冲突 / 验证红 / PR 合并失败 /
         -SkipVerify）。**判「通过」一律写 `-eq 0`，别写 `-le 2`**——那个区间把 1 也放进来了。
      3  参数非法——一步都没做
      4  PR 合了，但**清理没干净**（远程分支仍在，补删也没删掉）。刻意与 0 分开：
         「删干净了」和「没删掉」在唯一的机器可读通道上长得一样，正是本脚本要治的那类病。

    PowerShell 5.1 兼容：不用 && / || / 三元 / ?? / ?.；成败一律看 $LASTEXITCODE 不看输出文案；
    不用 2>&1（会把 git/gh 的正常 stderr 包成 NativeCommandError）。

    真相源：windsurf-dao/ccswitch/scripts/dao-pr-merge.ps1
    判据正文：windsurf-dao/ccswitch/dao.md · Shell 独有项「PR 合并期的机械链走脚本」
              + 反·归「预算型护栏必须在合并态求值」两条
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][int]$PullRequest,
    [string]$RepoPath = (Get-Location).Path,
    [string]$MainBranch,
    [string]$VerifyCommand,
    [switch]$SkipVerify,
    [switch]$NoMerge,
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

# ── 5. 合 PR（先拆占用该分支的 worktree）─────────────────────────────────────
Write-Step "5. 合 PR #$PullRequest（--delete-branch 的沉默不可信，先拆 worktree）"

$wtRaw = Invoke-Git -GitArgs @('worktree', 'list', '--porcelain')
$occupying = @()
$curWt = $null
foreach ($line in $wtRaw.Out) {
    if ($line -like 'worktree *') { $curWt = $line.Substring(9) }
    if ($line -eq "branch refs/heads/$branch") { $occupying += $curWt }
}
$selfWt = $null
foreach ($w in $occupying) {
    $resolved = $null
    if (Test-Path -LiteralPath $w) { $resolved = (Resolve-Path -LiteralPath $w).Path }
    if ($resolved -eq $RepoPath) { $selfWt = $w }
}
foreach ($w in $occupying) {
    $resolved = $null
    if (Test-Path -LiteralPath $w) { $resolved = (Resolve-Path -LiteralPath $w).Path }
    if ($resolved -eq $RepoPath) { continue }
    if ($DryRun) { Write-Plan "git worktree remove `"$w`""; continue }
    $rm = Invoke-Git -GitArgs @('worktree', 'remove', $w)
    if ($rm.Ok) { Write-Ok "已拆 worktree $w" } else { Write-Note "拆不掉 worktree $w（exit $($rm.Code)）——本地分支删除会失败，末尾会补删远程" }
}
if ($selfWt) {
    Write-Note "本脚本自己就跑在占用 $branch 的 worktree 里（$selfWt）—— --delete-branch 的本地那半必然失败；末尾的远程复核与补删就是为这种情况准备的"
}

if ($DryRun) {
    Write-Plan "gh pr merge $PullRequest --merge --delete-branch"
} else {
    Push-Location $RepoPath
    try { $mg = Invoke-Gh -GhArgs @('pr', 'merge', "$PullRequest", '--merge', '--delete-branch') } finally { Pop-Location }
    if (-not $mg.Ok) {
        Write-Info ($mg.Out -join "`n")
        Fail "gh pr merge 失败（exit $($mg.Code)）" 2
    }
    Write-Ok "PR #$PullRequest 已合并"
}

# ── 6. prune + 独立复核远程分支真的没了 ──────────────────────────────────────
Write-Step '6. fetch --prune → 独立核一眼远程分支真的没了'

$exitCode = 0
if ($DryRun) {
    Write-Plan "git fetch --prune；随后 git ls-remote --heads origin $branch 应为空"
    Write-Plan "git checkout $MainBranch；git branch -d $branch"
} else {
    $p = Invoke-Git -GitArgs @('fetch', '--prune')
    if (-not $p.Ok) { Write-Note "git fetch --prune 失败（exit $($p.Code)）" }

    $ls = Invoke-Git -GitArgs @('ls-remote', '--heads', 'origin', $branch)
    if ($ls.Out) {
        Write-Note "远程分支 $branch 仍在 —— --delete-branch 的沉默正是本脚本要防的那件事，补删"
        $del = Invoke-Git -GitArgs @('push', 'origin', '--delete', $branch)
        if ($del.Ok) { Write-Ok "已补删远程分支 $branch" }
        $ls2 = Invoke-Git -GitArgs @('ls-remote', '--heads', 'origin', $branch)
        if ($ls2.Out) {
            Write-Host ("  [失败] 远程分支 $branch 补删后仍在") -ForegroundColor Red
            $exitCode = 4
        }
    } else {
        Write-Ok "远程分支 $branch 已不存在（实查 ls-remote，不信 --delete-branch 的沉默）"
    }

    if (-not $selfWt) {
        $co = Invoke-Git -GitArgs @('checkout', $MainBranch)
        if ($co.Ok) {
            $null = Invoke-Git -GitArgs @('pull', '--ff-only')
            $bd = Invoke-Git -GitArgs @('branch', '-d', $branch)
            if ($bd.Ok) { Write-Ok "已删本地分支 $branch" } else { Write-Note "本地分支 $branch 未删（exit $($bd.Code)）——多半仍被别的 worktree 占用" }
        } else {
            Write-Note "切回 $MainBranch 失败（exit $($co.Code)）"
        }
    } else {
        Write-Note "跳过本地清理：本脚本正跑在 $branch 的 worktree 里。收尾请在主仓跑 git worktree remove 与 git branch -d $branch"
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
