#requires -Version 5.1
<#
.SYNOPSIS
    PR 合并后的本地收尾：worktree remove → worktree prune → pull → `git branch -d`。幂等可重跑。

.DESCRIPTION
    `dao-pr-merge.ps1` 合并 PR 之后，若它正跑在**链接** worktree 里（本仓最常见的实现官工作
    方式：worktree + PR），它按设计不拆自己脚下那棵树，只打印收尾命令交给人去主仓手跑。
    本脚本就是把那几步脚本化，省掉每次合并后手敲、且容易漏做（漏 prune、漏 pull）。

    **必须从主仓（或任一不同于 -WorktreePath 的树）跑，不能从 -WorktreePath 自己里面跑**：
    Windows 上进程 cwd 落在要删的目录里，目录删不掉。

    ── 四步，次序是承重的 ──────────────────────────────────────────────────────
      1) worktree remove   —— 删除前核 `git status --porcelain`，**工作树不干净就停**，
                              不替你决定丢弃还没提交的东西。
      2) worktree prune    —— 清 remove 没清干净的残留登记；恒幂等，不判断只执行。
      3) git pull --ff-only —— 让主仓追上刚合并的主干。
      4) git branch -d     —— **删本地分支，用小写 `-d`**。

    🔴 **为什么 pull 必须排在删分支前面**（这一条就是本脚本 2026-08-12 重写的全部理由）：
    `git branch -d` 自带「未完全合并就拒删」的核验，那是 git 的本职。但它比对的参照系是
    **本地**的主干——pull 之前本地主干还没有 PR 的合并结果，于是 `-d` **必然**误判成
    「没合并」。上一版脚本的应对是自己写一套差集核验（rev-list + git cherry）再升级成 `-D`
    强删，于是它同时**制造**了「可能强删未合并分支」这个风险、又要自己守住它，还得为那套
    自制核验配一整套回归网。**换个次序，这一层连同它的风险一起没有了。**

    ⚠ **pull 之后 `-d` 仍然拒删的那一格，照直写**：还有一种情形——本地那个合并壳没有推送到
    主干（比如在本地 merge 了却没 push）。**这时正确处置是把 `-d` 的原话打给用户去核实，
    不是升级成 `-D`**：脚本分不清「壳没推」与「这个分支真的还有活没并进去」，而这两者
    一个无害、一个是丢工作。本脚本因此在这一步停下并 exit 2，worktree 已清、分支留着，
    人核实后可安全重跑（幂等）。

    ── 幂等 ────────────────────────────────────────────────────────────────────
    每步先查「这件事是不是已经做过了」：worktree 不在登记里 ⇒ 跳过第 1 步；分支不存在 ⇒
    跳过第 4 步；prune 与已是最新的 pull 本身幂等。**重复跑一次已经清干净的现场，预期是
    「全跳过 + exit 0」，不是报错。**

    ── 不由本脚本兜住的边界 ────────────────────────────────────────────────────
      ① 不判断「PR 该不该合」——那是人与 `dao-pr-merge.ps1` 的事，本脚本只管合并之后。
      ② **不删远程分支**——那交给仓库设置「合并后自动删 head 分支」
         （GitHub 只删已合并的，PR 页可一键 Restore）。业界标准件，不自己实现一遍。

.PARAMETER WorktreePath
    要清理的 worktree 目录。必填。
    **它与 -Branch 的配对会被校验**：那棵树此刻检出的分支必须就是 -Branch，否则停（exit 1）。
    没有这道校验时，参数填错会删掉**另一位官正在用的在途工作树**而退出码照样是 0。
    认树三条路：目录还在 ⇒ 问 `git -C <WorktreePath> rev-parse --show-toplevel`（与
    `worktree list` 同源，路径拼法 / 8.3 短名 / 大小写差异在这一步全消）；目录被改名挪走
    或删掉 ⇒ 分隔符归一化后按字面认登记（porcelain 打正斜杠、调用方多半反斜杠）。
    **「它没登记」与「我没认出它的登记」输出一模一样**——所以认树要覆盖登记的全部拼法。

.PARAMETER Branch
    要清理的本地分支名（与那棵 worktree 对应）。必填。

.PARAMETER RepoPath
    主仓（或任一不同于 WorktreePath 的树）路径。缺省当前目录。**不能与 WorktreePath 相同**。

.PARAMETER DryRun
    只做只读查询并打印将要执行什么，不发起任何写操作。

.EXAMPLE
    .\dao-merge-cleanup.ps1 -WorktreePath C:\frank\wt-dao-325 -Branch fix/issue-325 -RepoPath C:\frank\windsurf-dao -DryRun

.EXAMPLE
    .\dao-merge-cleanup.ps1 -WorktreePath C:\frank\wt-dao-325 -Branch fix/issue-325 -RepoPath C:\frank\windsurf-dao

.NOTES
    退出码契约（四态；只有 0 叫「干净」，含「本来就已经干净，本次幂等空跑」）：
      0  全部完成且干净（DryRun 正常走完也是 0）
      1  前置条件不成立（RepoPath 不是 git 仓 / 缺 git / WorktreePath 与 RepoPath 相同 /
         RepoPath 当前分支就是 -Branch / 那棵树检出的分支不是 -Branch / worktree list 失败）
      2  **pull 之后 `git branch -d` 仍拒删**——git 判定该分支未完全合并。worktree 已清、
         分支原样留着，人核实后可安全重跑。不升级 `-D`（理由见 .DESCRIPTION 那段 ⚠）
      4  某个必要动作本该成功却失败（worktree 不干净 / remove 失败 / prune 失败 / pull 失败）

    （没有 3：参数拼错由 PowerShell 参数绑定层拒绝，脚本正文一行都没执行，退出码不由本脚本
    决定——本机实测 `-Bogus 1` 拿到的是 exit 1。4 刻意不改号：它已被消费方读着。）

    PowerShell 5.1 兼容：不用 && / || / 三元 / ?? / ?.；成败一律看 `$LASTEXITCODE` 不看输出
    文案；不用 2>&1（会把 git 的正常 stderr 包成 NativeCommandError）。

    **没有回归网**（2026-08-12 起，issue #325 二次终审）：这个脚本现在只是四条 git 命令的
    固定次序，判断那一半交回给 git 自己（`-d` 的核验、`worktree remove` 的占用检查）。
    它出错的形态是可见且可逆的（分支/worktree 还在，重跑即可），够不上「必须配自测」那条线。
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$WorktreePath,
    [Parameter(Mandatory = $true)][string]$Branch,
    [string]$RepoPath = (Get-Location).Path,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

function Write-Step([string]$t) { Write-Host ''; Write-Host ("=== $t ===") -ForegroundColor Cyan }
function Write-Ok([string]$t) { Write-Host ("  [完成] $t") -ForegroundColor Green }
function Write-Plan([string]$t) { Write-Host ("  [将做] $t") -ForegroundColor Yellow }
function Write-Note([string]$t) { Write-Host ("  [注意] $t") -ForegroundColor Yellow }
function Write-Info([string]$t) { Write-Host ("         $t") -ForegroundColor DarkGray }
function Write-Skip([string]$t) { Write-Host ("  [跳过] $t") -ForegroundColor DarkGray }
function Fail([string]$t, [int]$code) {
    Write-Host ("  [失败] $t") -ForegroundColor Red
    Write-Host ''
    Write-Host ("MERGE_CLEANUP_EXIT=$code") -ForegroundColor Red
    exit $code
}

function Invoke-Git {
    param([string]$Cwd, [string[]]$GitArgs)
    $out = & git -C $Cwd @GitArgs
    return [pscustomobject]@{ Ok = ($LASTEXITCODE -eq 0); Code = $LASTEXITCODE; Out = $out }
}
function GitLine {
    param([string]$Cwd, [string[]]$GitArgs)
    $r = Invoke-Git -Cwd $Cwd -GitArgs $GitArgs
    if (-not $r.Ok) { return $null }
    return (($r.Out | Select-Object -First 1) -as [string])
}

# ── 0. 前置检查 ──────────────────────────────────────────────────────────────
Write-Step '0. 前置检查'

if (-not (Test-Path -LiteralPath $RepoPath)) { Fail "RepoPath 不存在：$RepoPath" 1 }
$RepoPath = (Resolve-Path -LiteralPath $RepoPath).Path

if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Fail '找不到 git' 1 }
$insideWorkTree = GitLine -Cwd $RepoPath -GitArgs @('rev-parse', '--is-inside-work-tree')
if ($insideWorkTree -ne 'true') { Fail "不是 git 工作树：$RepoPath" 1 }

# WorktreePath 可能已经被删掉（幂等场景），存在时才 Resolve-Path；不存在就保留原样字符串
# 用于后续按路径比对（git worktree list 打印的是它记录时的路径写法）。
$worktreePathResolved = $WorktreePath
if (Test-Path -LiteralPath $WorktreePath) { $worktreePathResolved = (Resolve-Path -LiteralPath $WorktreePath).Path }

if ($worktreePathResolved -eq $RepoPath) {
    Fail "WorktreePath 与 RepoPath 是同一处（$RepoPath）——本脚本必须从要清理的那棵树**外面**跑" 1
}

$repoBranch = GitLine -Cwd $RepoPath -GitArgs @('rev-parse', '--abbrev-ref', 'HEAD')
if ($repoBranch -eq $Branch) {
    Fail "RepoPath（$RepoPath）当前就检出着要清理的分支 $Branch——删分支这一步注定失败，先切到主干再跑" 1
}

Write-Info "VERIFY_CWD=$RepoPath"
Write-Info "VERIFY_WORKTREE=$WorktreePath"
Write-Info "VERIFY_BRANCH=$Branch"

Write-Ok "前置检查通过（主仓 $RepoPath）"

if ($DryRun) { Write-Note 'DryRun：以下写操作一律只打印不执行' }

# ── 幂等探测：worktree 还挂着吗、分支还在吗 ──────────────────────────────────
Write-Step '幂等探测：worktree 是否还挂着、分支是否还在'

$wtList = Invoke-Git -Cwd $RepoPath -GitArgs @('worktree', 'list', '--porcelain')
if (-not $wtList.Ok) {
    Fail "git worktree list --porcelain 失败（exit $($wtList.Code)）—— 探不到现场就不敢动手，什么都没做" 1
}
# 认树的承重点是「问 git 自己」，字符串比对只是目录不在时的回落（判据见 .PARAMETER WorktreePath）。
$worktreeGitTop = $null
if (Test-Path -LiteralPath $WorktreePath) {
    $worktreeGitTop = GitLine -Cwd $WorktreePath -GitArgs @('rev-parse', '--show-toplevel')
}
# --porcelain 每条记录形如：worktree <路径> / HEAD <sha> / branch refs/heads/<名>（或 detached）。
# 分支行本来就在输出里，顺手记下来给下面的配对校验用（不用另跑一条 git）。
$worktreeStillRegistered = $false
$worktreeCheckedOutBranch = $null   # detached 或没打印 branch 行 ⇒ 保持 $null
$inTargetEntry = $false
foreach ($line in $wtList.Out) {
    if ($line -like 'worktree *') {
        $wtEntry = $line.Substring(9)
        $wtEntryResolved = $wtEntry
        if (Test-Path -LiteralPath $wtEntry) { $wtEntryResolved = (Resolve-Path -LiteralPath $wtEntry).Path }
        $inTargetEntry = ($wtEntryResolved -eq $worktreePathResolved)
        if ((-not $inTargetEntry) -and $worktreeGitTop -and ($wtEntry -eq $worktreeGitTop)) { $inTargetEntry = $true }
        if ((-not $inTargetEntry) -and (($wtEntry -replace '\\', '/') -eq ($worktreePathResolved -replace '\\', '/'))) { $inTargetEntry = $true }
        if ($inTargetEntry) { $worktreeStillRegistered = $true }
    } elseif ($inTargetEntry -and ($line -like 'branch refs/heads/*')) {
        $worktreeCheckedOutBranch = $line.Substring(18)   # 'branch refs/heads/'.Length = 18
    }
}
$branchStillExists = (Invoke-Git -Cwd $RepoPath -GitArgs @('rev-parse', '--verify', '--quiet', "refs/heads/$Branch")).Ok

# 配对校验（fail-closed）：删的是 -WorktreePath，而参数填错时它可能是别人在用的那棵树。
# `-cne` 是大小写敏感比对：git 的 ref 名大小写敏感，PowerShell 的 `-ne` 默认不敏感。
if ($worktreeStillRegistered) {
    if (-not $worktreeCheckedOutBranch) {
        Fail ("worktree $WorktreePath 没有检出任何分支（detached HEAD 或 git 没报 branch 行）—— " +
              "证不出它检出的就是 $Branch，拒绝删；要清理它请手动核实后自己跑 git worktree remove") 1
    }
    if ($worktreeCheckedOutBranch -cne $Branch) {
        Fail ("配对不符：worktree $WorktreePath 检出的是 $worktreeCheckedOutBranch，不是 -Branch 给的 $Branch —— " +
              "要删的树与要删的分支不是同一件事，很可能是参数填错（那棵树多半是别人正在用的）。什么都没动") 1
    }
}

if (-not $worktreeStillRegistered) {
    Write-Skip ("我在 ``git worktree list`` 里认不出这棵树 —— 视为已清理。" +
                "（三道认树路径均已试过：精确路径 / git 同源写法 / 分隔符归一化比对）")
}
if (-not $branchStillExists) { Write-Skip "本地分支 $Branch 已不存在 —— 视为已清理" }

# ── 1. worktree remove（工作树不干净就拒绝删除并停）──────────────────────────
Write-Step '1. worktree remove'

if (-not $worktreeStillRegistered) {
    Write-Skip 'worktree 已不在登记里，跳过'
} elseif ($DryRun) {
    Write-Plan "先核 git -C `"$WorktreePath`" status --porcelain（不干净就拒绝）"
    Write-Plan "git worktree remove `"$WorktreePath`""
} else {
    if (Test-Path -LiteralPath $WorktreePath) {
        $dirty = (Invoke-Git -Cwd $WorktreePath -GitArgs @('status', '--porcelain')).Out
        if ($dirty) {
            Fail ("worktree 不干净，拒绝删除：`n$($dirty -join "`n")`n" +
                  "         —— 有工作还没提交，收尾脚本不替你决定丢弃它；处理完再重跑本脚本") 4
        }
    }
    $rm = Invoke-Git -Cwd $RepoPath -GitArgs @('worktree', 'remove', $WorktreePath)
    if ($rm.Ok) { Write-Ok "已删 worktree $WorktreePath" }
    else { Fail "git worktree remove 失败（exit $($rm.Code)）：`n$($rm.Out -join "`n")" 4 }
}

# ── 2. git worktree prune（清残留登记；恒幂等）───────────────────────────────
Write-Step '2. git worktree prune'

if ($DryRun) {
    Write-Plan 'git worktree prune'
} else {
    $p = Invoke-Git -Cwd $RepoPath -GitArgs @('worktree', 'prune')
    if ($p.Ok) { Write-Ok 'prune 完成' } else { Fail "git worktree prune 失败（exit $($p.Code)）" 4 }
}

# ── 3. pull（**必须排在删分支前面**，理由见 .DESCRIPTION）────────────────────
Write-Step '3. git pull --ff-only'

if ($DryRun) {
    Write-Plan 'git pull --ff-only'
} else {
    $pull = Invoke-Git -Cwd $RepoPath -GitArgs @('pull', '--ff-only')
    if ($pull.Ok) {
        Write-Ok 'pull 完成（本地主干现在含 PR 的合并结果，下一步 git 自己判得准了）'
        Write-Info ($pull.Out -join "`n")
    } else {
        Fail "git pull --ff-only 失败（exit $($pull.Code)）：`n$($pull.Out -join "`n")" 4
    }
}

# ── 4. 删本地分支：`git branch -d`，核验交给 git ─────────────────────────────
Write-Step '4. git branch -d（未完全合并时由 git 自己拒绝）'

if (-not $branchStillExists) {
    Write-Skip "分支 $Branch 已不存在，跳过"
} elseif ($DryRun) {
    Write-Plan "git branch -d $Branch"
} else {
    $bd = Invoke-Git -Cwd $RepoPath -GitArgs @('branch', '-d', $Branch)
    if ($bd.Ok) {
        Write-Ok "已删本地分支 $Branch"
    } else {
        # 不升级 -D：脚本分不清「本地合并壳没推送」与「这个分支真的还有活没并进去」，
        # 一个无害、一个是丢工作。把 git 的原话给人，让人来分。
        Write-Info ($bd.Out -join "`n")
        Fail ("git 拒绝删除分支 $Branch（exit $($bd.Code)）—— pull 已经做过了，所以这不是参照系陈旧。" +
              "上面是 git 的原话，请核实：若确认它的改动都已进主干（比如合并壳只在本地没推送），" +
              "自己跑 ``git branch -D $Branch``；本脚本不替你做这个判断。worktree 已清、分支原样留着，可安全重跑") 2
    }
}

Write-Host ''
Write-Host '──── 汇总 ────'
Write-Host "  worktree $WorktreePath / 分支 $Branch / 主仓 $RepoPath"
if ($DryRun) { Write-Host '  DryRun：以上均未执行' }
else {
    # 只提醒不自动删（2026-08-13 用户拍板）：会话与 PR 非一一对应，且 commit 的
    # Claude-Session trailer 靠会话档追溯出处——删不删是人的判断，不是流程。
    Write-Note '这单已收尾。本会话的结论若都已落盘（commit/issue），可敲 /dao-remove 丢弃会话；拿不准就留着'
}
Write-Host 'MERGE_CLEANUP_EXIT=0'
exit 0
