#requires -Version 5.1
<#
.SYNOPSIS
    合并链收尾三连的 canonical 实现：差集核验（决定 -d / -D / 拒绝）→ worktree remove →
    worktree prune → 删分支 → pull。幂等可重跑。

.DESCRIPTION
    治的是什么病（issue #70 · 三层降耗方案 · 层2 件②）：`dao-pr-merge.ps1` 合并 PR 之后，
    若脚本正跑在**链接** worktree 里（本仓最常见的实现官工作方式：worktree + PR），它按设计
    **不拆自己所在的那棵树**（见该脚本 .DESCRIPTION 边界④），只打印两行可复制的收尾命令
    交给帅去主仓手跑。本脚本就是把那两行手跑动作**加上安全判定**后脚本化，省掉帅每次
    合并后手敲、且容易漏做（漏 prune、漏 pull、或在分支还没真的并入主干时就 `branch -D`
    强删导致工作丢失）。

    **必须从主仓（或任一不同于 -WorktreePath 的正常 worktree）跑，不能从 -WorktreePath
    自己里面跑**——同 `dao-pr-merge.ps1` 那条「不拆自己所在的 worktree」的病根一样：
    Windows 上进程 cwd 落在要删的目录里，目录删不掉；即便删得掉，脚本也会在自己被删掉的
    目录里接着跑完。

    ── 七步（0–6），逐条对应一个已知失效形态 ─────────────────────────────────────

      0) 前置检查              —— RepoPath 是 git 仓、WorktreePath 与 RepoPath 不是同一处、
                                   RepoPath 当前分支不是 -Branch（否则删分支这一步注定失败，
                                   与其等到第 4 步才报一个 git 原生错误，不如现在说清楚）、
                                   **`origin/<MainBranch>` 真的存在**（差集核验的参照系，
                                   fail-closed，见 .PARAMETER MainBranch）、**-WorktreePath
                                   那棵树此刻检出的分支就是 -Branch**（配对校验，见幂等探测段）。

      1) git fetch origin      —— 差集核验要拿 `origin/<MainBranch>` 当参照系，参照系必须新鲜。

      2) 差集核验（决定 -d / -D / 拒绝）——**这是本脚本的核心判断，也是「幂等可重跑」的
         安全阀**。派单令原文：「只剩 merge 壳或空才准 -D，否则报错停」。两层判据：
           ① `git rev-list origin/<MainBranch>..<Branch>` 为空 ⇒ 分支在**祖先关系**上已经
              完全并入主干（`gh pr merge --merge` 这种保留提交历史的合并策略走的正是这条），
              `git branch -d` 本来就安全，不需要 `-D`。
           ② 非空时改用 **`git cherry`**（patch-id 等价判定）：squash / rebase 一类合并策略
              会让主干上的提交是**新提交**、分支上的原始提交永远不会成为主干的祖先，纯祖先
              判定（`git branch -d` 内部用的就是这个）在这里必然误判为「未合并」——这正是
              `ccswitch/rules/dao-officer-clauses.md` 帅节 `[#Shell-patch-id]` 点名的坑：
              `--is-ancestor` 对等价提交结构性失明，只有内容比对认得出。`git cherry` 每行
              以 `-` 打头＝已有等价提交落在主干（只剩「合并壳」，没有真内容差异）；以 `+`
              打头＝主干里找不到等价物（真有未落地的改动）。**全部是 `-`（或零行）才安全用
              `-D`；只要出现一行 `+`，脚本报错并停在这一步，worktree 与分支原样不动**——
              这时多半是 PR 还没真的合并，或合并方式与预期不符，需要人核实，不许脚本替人
              拿主意去强删。
         **这条判定带两个前提，写在这里免得被读成无条件**（2026-08-10 返修补，出处：
         PR #252 对抗验证判词阻断 1）：①参照系 `origin/<MainBranch>` 必须真的存在——
         不存在时**第 0 步就停**（exit 1），根本走不到这条判定；②`rev-list` / `cherry`
         两条查询**本身必须成功**——失败时停在这一步（exit 4），**不把「命令失败、stdout
         为空」读成「零差异」**。补这两道之前：`-MainBranch` 打错一个字母（或缺省探测回落
         到一个不存在的 ref）⇒ `rev-list` fatal、stdout 为空 ⇒ 读到「零行」⇒ 判成「已完全
         并入」⇒ **真的删掉一个没合并的分支连同它的 worktree，退出码还是 0**。
         **数到 0 和没看到样本，输出一模一样**——这两道校验就是把这两种 0 分开。
         本脚本**不实现 `git patch-id --stable` 的手工逐提交比对**——`git cherry` 是 git
         自带的、内部同样基于 patch-id 等价判定的现成工具，语义与判据要求逐字对应，没有
         理由再手写一遍同样的算法（为道日损）。

      3) worktree remove       —— 只有第 2 步判定安全（或分支本就不存在/已被删过，见幂等段）
                                   才会走到这一步。删除前核 `git -C <WorktreePath> status
                                   --porcelain`：**工作树不干净就拒绝删除并停**，不強删、不
                                   吞掉可能还没提交的工作——这条比「派单令要的三连」更保守，
                                   是本脚本主动加的安全阀（干净的树才谈得上「收尾」，脏的树
                                   意味着有别的事没做完）。

      4) git worktree prune    —— 清理 `remove` 可能没清干净的残留登记（尤其是 worktree
                                   目录已被人手工删掉、但 git 的 administrative 记录还在指着
                                   它那种情形）；恒安全、恒幂等，不判断只执行。

      5) 删本地分支             —— 用第 2 步决定的 `-d` 或 `-D`，此时 worktree 已经不占着
                                   这个分支了。分支不存在（已被删过）⇒ 跳过，视为幂等已完成。

      6) git pull --ff-only    —— 让 RepoPath（通常是主仓）追上刚合并的主干。

    ── 幂等 ────────────────────────────────────────────────────────────────────
    每一步都先查「这件事是不是已经做过了」：**我在 `git worktree list` 里认不出这棵树** ⇒ 跳过
    第 3 步；分支不存在 ⇒ 跳过第 2/5 步（连差集核验都不必做，没有分支就没有什么好核的）；
    `git worktree prune` 与 `git pull --ff-only`（已是最新时）本身就是幂等操作。**重复跑
    一次已经清干净的现场，预期结果是「全跳过 + exit 0」，不是报错。**

    **认树的两种失效形态均已修**（出处：PR #252 第二轮对抗验证 X12 与 2026-08-10 返修补）：
      · **路径拼法**（尾杠 / 8.3 短名 / 大小写）——目录还在时靠 Resolve-Path 归一化 + 问
        `git -C <WorktreePath> rev-parse --show-toplevel`（与 `worktree list` 同源的写法）。
      · **目录被改名挪走或删掉**（#265 件 6，2026-08-10 复抗 X12 实测）——`Test-Path` 为假时
        上面那两条都用不上，改走**分隔符归一化后的字面比对**：porcelain 打印正斜杠、调用方
        多半是反斜杠，不归一化就比不中；登记还在 ⇒ 认得出 ⇒ 配对校验照常执行（`branch
        refs/heads/...` 行本来就在 porcelain 输出里，不依赖目录存在）。**「它没登记」与
        「我没认出它的登记」在输出上一模一样**——修法是让认树覆盖登记的全部拼法，而不是
        用一句话含糊带过。修法承重点在「问 git 自己」（`worktree list` 输出），字符串比对
        只是目录不在时的回落，不是主路。

    ── 不由本脚本兜住的边界（照直写）───────────────────────────────────────────
      ① **不判断「PR 到底该不该合」**——终审不可让渡，那是人（或 `dao-pr-merge.ps1` 第 4/5
         步）的事，本脚本只管合并之后的收尾。
      ② **第 2 步判定「不安全」时不会给出更细的诊断**（比如具体哪个 commit 缺内容对应）——
         报错信息会打印 `git cherry` 的原始输出，诊断本身留给人读。
      ③ **不做 `git fetch --prune`**（清理远程分支的引用）——那是 `dao-pr-merge.ps1` 第 6
         步已经做过的事，本脚本的 `prune` 单指 `git worktree prune`，不重复远程那一半。

.PARAMETER WorktreePath
    要清理的 worktree 目录（PR 分支曾经在里面开工的那棵树）。必填。
    **它与 -Branch 的配对会被校验**：那棵树此刻检出的分支必须就是 -Branch，否则停（exit 1）。
    （2026-08-10 返修补，出处：PR #252 对抗验证判词阻断 2 —— 此前差集核验核的是 -Branch、
    删的是 -WorktreePath，两者之间没有任何绑定 ⇒ 参数错配时会一路绿灯删掉**另一位官正在
    用的在途工作树**，退出码还是 0。校验用 `git worktree list --porcelain` 里那棵树自己的
    `branch refs/heads/...` 行，**大小写敏感比对**——git 的 ref 名是大小写敏感的，而
    PowerShell 的 `-ne` 默认不是。detached HEAD 的树同样拒绝：证不出它检出的是 -Branch。）
    **这条校验挂在「那棵树还登记着」之下，所以「认不认得出这棵树」与它同等承重**——
    认树不靠手工规范化路径：目录还在时问 `git -C <WorktreePath> rev-parse --show-toplevel`
    （与 `worktree list` 同源的写法）；目录被改名挪走/删掉时（#265 件 6）改走**分隔符归一化
    后的字面比对**认登记——porcelain 的 `branch refs/heads/...` 行本来就在输出里、不依赖
    目录存在，配对照常执行。见幂等探测段那条注释。

.PARAMETER Branch
    要清理的本地分支名（与上面那棵 worktree 对应）。必填。

.PARAMETER RepoPath
    主仓（或任一不同于 WorktreePath 的正常 worktree）路径。缺省当前目录。
    **不能与 WorktreePath 相同**——本脚本必须从要删除的那棵树外面跑。

.PARAMETER MainBranch
    主干分支名，差集核验用它当参照系。缺省从 `origin/HEAD` 探测，探不到回落 main（再回落
    master）；**回落链末端一律核 `origin/<MainBranch>` 真的存在，探不到就停（exit 1）**。
    回落链与那道 fail-closed 校验都与 `ccswitch/scripts/dao-pr-merge.ps1:322-323` 同一套。
    （2026-08-10 订正：此前这里只写「与 dao-pr-merge.ps1 同一套探测逻辑」，而**承重的
    fail-closed 那一步并没有抄过来** —— 回落链相同、校验缺席，那句话按当时的代码为假。）

.PARAMETER DryRun
    只做只读查询并打印将要执行什么，不发起任何写操作（不 remove、不删分支、不 pull）。

.EXAMPLE
    # 先看会做什么
    .\dao-merge-cleanup.ps1 -WorktreePath D:\frank\windsurf-dao\.claude\worktrees\agent-xxx -Branch fix/70-gates -RepoPath D:\frank\windsurf-dao -DryRun

.EXAMPLE
    # 真跑
    .\dao-merge-cleanup.ps1 -WorktreePath D:\frank\windsurf-dao\.claude\worktrees\agent-xxx -Branch fix/70-gates -RepoPath D:\frank\windsurf-dao

.NOTES
    退出码契约（四态；只有 0 叫「干净」，含「本来就已经干净，本次幂等空跑」这种情形）：
      0  全部完成且干净（DryRun 正常走完也是 0）
      1  前置条件不成立（RepoPath 不是 git 仓 / 缺 git / WorktreePath 与 RepoPath 相同 /
         RepoPath 当前分支就是 -Branch / 探不到 origin/<MainBranch> / -WorktreePath 那棵树
         检出的分支不是 -Branch / `git worktree list` 本身失败）——一步都没做
      2  差集核验判定「不安全」，拒绝删除——worktree 与分支均保持原样未动，等真正合并后
         重跑本脚本（本脚本可安全重跑，见幂等段）
      4  某个必要清理动作本该成功却失败（fetch 失败 / **差集核验的 git 查询本身失败——
         「没查成」不是「零差异」** / worktree remove 失败但不是因为"已经不在" /
         分支不干净被拒绝清理 / branch delete 失败但不是因为"已经不存在" / pull 失败）——
         没有干净收尾，需要人介入

    **没有 3，这是 2026-08-10 订正**：此前这里写着「3 参数非法」，而全文没有任何一处产出
    exit 3（PR #252 对抗验证判词问题 7 点名的死契约）。参数拼错由 PowerShell 的**参数绑定
    层**直接拒绝、脚本正文一行都没执行，退出码不由本脚本决定——本机实测 `-Bogus 1` 拿到的
    是 **exit 1** 而不是 3。死契约删掉，不为迁就一句已经写下的话去硬造一个产出点。
    （4 因此不与 3 连号，刻意不重编号：4 已被回归网与消费方读着，改号是拿真风险换整齐。）

    PowerShell 5.1 兼容：不用 && / || / 三元 / ?? / ?.；成败一律看 $LASTEXITCODE 不看输出
    文案；不用 2>&1（会把 git 的正常 stderr 包成 NativeCommandError）。

    回归网：windsurf-dao/tests/dao-merge-cleanup.tests.ps1（随机化沙盒路径，不用固定 _tmp——
    #187 教训：固定路径在并行跑多个实例时会互踩）。

    真相源：windsurf-dao/scripts/dao-merge-cleanup.ps1
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$WorktreePath,
    [Parameter(Mandatory = $true)][string]$Branch,
    [string]$RepoPath = (Get-Location).Path,
    [string]$MainBranch,
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
# 用于后续的「按路径比对」判断（git worktree list 打印的是它记录时的路径写法）。
$worktreePathResolved = $WorktreePath
if (Test-Path -LiteralPath $WorktreePath) { $worktreePathResolved = (Resolve-Path -LiteralPath $WorktreePath).Path }

if ($worktreePathResolved -eq $RepoPath) {
    Fail "WorktreePath 与 RepoPath 是同一处（$RepoPath）——本脚本必须从要清理的那棵树**外面**跑，同 dao-pr-merge.ps1 的『不拆自己所在的 worktree』同一个病根" 1
}

$repoBranch = GitLine -Cwd $RepoPath -GitArgs @('rev-parse', '--abbrev-ref', 'HEAD')
if ($repoBranch -eq $Branch) {
    Fail "RepoPath（$RepoPath）当前就检出着要清理的分支 $Branch——删分支这一步注定失败，先切到别的分支（通常是主干）再跑本脚本" 1
}

if (-not $MainBranch) {
    $originHead = GitLine -Cwd $RepoPath -GitArgs @('symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD')
    if ($originHead) { $MainBranch = $originHead -replace '^refs/remotes/origin/', '' }
}
if (-not $MainBranch) {
    $probe = Invoke-Git -Cwd $RepoPath -GitArgs @('rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main')
    if ($probe.Ok) { $MainBranch = 'main' } else { $MainBranch = 'master' }
}

Write-Info "VERIFY_CWD=$RepoPath"
Write-Info "VERIFY_WORKTREE=$WorktreePath"
Write-Info "VERIFY_BRANCH=$Branch"
Write-Info "VERIFY_MAIN=$MainBranch"

# fail-closed：参照系 ref 必须真的存在。逐字对位 dao-pr-merge.ps1:322-323 —— 本脚本此前只
# 抄了上面那条回落链，漏了这一步（那一步才是承重的）：ref 名错一个字母时第 2 步的 rev-list
# 会 fatal 且 stdout 为空，而「零行」被读成「零差异」⇒ 宣布已并入主干并真的删。
$verifyMain = Invoke-Git -Cwd $RepoPath -GitArgs @('rev-parse', '--verify', '--quiet', "refs/remotes/origin/$MainBranch")
if (-not $verifyMain.Ok) {
    Fail ("探不到 origin/$MainBranch（可用 -MainBranch 显式指定）—— 差集核验没有参照系就判不准，" +
          "停在这里，worktree 与分支一个都没动") 1
}

Write-Ok "前置检查通过（主仓 $RepoPath，主干 $MainBranch）"

if ($DryRun) { Write-Note 'DryRun：以下写操作一律只打印不执行' }

# ── 幂等探测：worktree 与分支现在各自处于什么状态 ────────────────────────────
Write-Step '幂等探测：worktree 是否还挂着、分支是否还在'

$wtList = Invoke-Git -Cwd $RepoPath -GitArgs @('worktree', 'list', '--porcelain')
if (-not $wtList.Ok) {
    Fail "git worktree list --porcelain 失败（exit $($wtList.Code)）—— 探不到现场就不敢动手，什么都没做" 1
}
# 认这棵树**不靠手工规范化路径**：先问 git 它自己怎么写这棵树的根，而 `worktree list
# --porcelain` 打印的正是同一个写法，两边同源，比对因此不受调用方的路径拼法影响。
# 病根（2026-08-10 复抗实测，PR #252 返修后自查出来的漏网，判词里没有这一条）：
# `Resolve-Path` **不展开 8.3 短名、也不吃掉结尾那个反斜杠**——传 `C:\Users\ADMINI~1\…\wt`
# （`%TEMP%` 展开出来的常见形态）或 `…\wt\`（shell 补全习惯加的尾杠），与 git 打印的
# `C:/Users/Administrator/…/wt` 两边 Resolve-Path 之后仍不相等 ⇒ 判「这棵树没登记」⇒
# **下面那道配对校验整段被跳过**（它挂在 `if ($worktreeStillRegistered)` 里），第 3 步还会
# 打印「视为已清理」这句假话，第 5 步照删分支、exit 0。
# **「它没登记」与「我没认出它的登记」输出一模一样**——与第 2 步要治的那个病同族，
# 所以修法也同族：别自己数，去问那个知道答案的。
$worktreeGitTop = $null
if (Test-Path -LiteralPath $WorktreePath) {
    # 目录还在：问 git 自己这棵树怎么写（与 `worktree list` 同源）——路径拼法 / 8.3 短名 /
    # 大小写差异在这一步全部消掉，认树的承重点在这里（2026-08-10 返修补，PR #252 复抗实测）。
    $worktreeGitTop = GitLine -Cwd $WorktreePath -GitArgs @('rev-parse', '--show-toplevel')
}
# 目录被改名挪走/删掉时上面那步跑不了（Test-Path 为假），但 git 登记还在——`worktree list
# --porcelain` 打印的正是登记里的原样路径，与调用方拿到的路径只差分隔符（porcelain 打正斜杠、
# 调用方多半反斜杠）。下面第三道比对把分隔符归一化后按字面认登记：登记在就认得出 ⇒ 配对校验
# 照常执行。#265 件 6（2026-08-10 复抗 X12 用长名路径独立复现，危害上限见 .DESCRIPTION 幂等段）。
# --porcelain 的每条记录形如：worktree <路径> / HEAD <sha> / branch refs/heads/<名>（或 detached）。
# 分支行本来就在那份输出里，顺手记下来给下面的配对校验用（不用另跑一条 git）。
$worktreeStillRegistered = $false
$worktreeCheckedOutBranch = $null   # 目标那棵树检出的分支；detached 或没打印 branch 行 ⇒ 保持 $null
$inTargetEntry = $false
foreach ($line in $wtList.Out) {
    if ($line -like 'worktree *') {
        $wtEntry = $line.Substring(9)
        $wtEntryResolved = $wtEntry
        if (Test-Path -LiteralPath $wtEntry) { $wtEntryResolved = (Resolve-Path -LiteralPath $wtEntry).Path }
        $inTargetEntry = ($wtEntryResolved -eq $worktreePathResolved)
        # 字符串比对没认出来时，改用 git 自己的写法再比一次（目录还在时的承重路，见上面注释）。
        if ((-not $inTargetEntry) -and $worktreeGitTop -and ($wtEntry -eq $worktreeGitTop)) { $inTargetEntry = $true }
        # 目录已不在时上面两条都用不上（$worktreeGitTop 为 $null、两边都过不了 Resolve-Path）：
        # 分隔符归一化后按字面认登记——porcelain 打正斜杠、调用方多半反斜杠（#265 件 6）。
        if ((-not $inTargetEntry) -and (($wtEntry -replace '\\', '/') -eq ($worktreePathResolved -replace '\\', '/'))) { $inTargetEntry = $true }
        if ($inTargetEntry) { $worktreeStillRegistered = $true }
    } elseif ($inTargetEntry -and ($line -like 'branch refs/heads/*')) {
        $worktreeCheckedOutBranch = $line.Substring(18)   # 'branch refs/heads/'.Length = 18
    }
}
$branchStillExists = (Invoke-Git -Cwd $RepoPath -GitArgs @('rev-parse', '--verify', '--quiet', "refs/heads/$Branch")).Ok

# 配对校验（fail-closed）：差集核验核的是 -Branch，第 3 步删的是 -WorktreePath —— 两者之间
# 此前没有任何绑定，于是参数错配时会核验一个已合并的分支、删掉另一棵在途的工作树。
# `-cne` 是大小写敏感比对：git 的 ref 名大小写敏感，而 PowerShell 的 `-ne` 默认不敏感。
if ($worktreeStillRegistered) {
    # ⚠ 这一支是**报文归因**不是第二道安全网，照直写：把它去掉，下面 `-cne` 那道照样拦得住
    # （`$null -cne 'feature/x'` 为真），退出码一个字不变，变的只是报文会笼统成「检出的是 」。
    # 回归网场景 14 断言的因此是那句归因报文本身，不是「它拦住了」——两者不是一回事。
    if (-not $worktreeCheckedOutBranch) {
        Fail ("worktree $WorktreePath 没有检出任何分支（detached HEAD 或 git 没报 branch 行）—— " +
              "证不出它检出的就是 $Branch，拒绝删；要清理它请手动核实后自己跑 git worktree remove") 1
    }
    if ($worktreeCheckedOutBranch -cne $Branch) {
        Fail ("配对不符：worktree $WorktreePath 检出的是 $worktreeCheckedOutBranch，不是 -Branch 给的 $Branch —— " +
              "核验的分支与要删的树不是同一件事，很可能是参数填错（那棵树多半是别人正在用的）。" +
              "什么都没动") 1
    }
}

if (-not $worktreeStillRegistered) {
    # 三道认树路径（Resolve-Path 精确比对 / git 同源写法 / 分隔符归一化字面比对）全都没命中
    # ⇒ 这棵树确实不在登记里，这句话才成立（#265 件 6 修完后不再是「推断」）。
    Write-Skip ("我在 ``git worktree list`` 里认不出这棵树 —— 视为已清理。" +
                "（三道认树路径均已试过：精确路径 / git 同源写法 / 分隔符归一化比对）")
}
if (-not $branchStillExists) { Write-Skip "本地分支 $Branch 已不存在 —— 视为已清理" }
if (-not $worktreeStillRegistered -and -not $branchStillExists) {
    Write-Ok '两样都已清理干净，本次是幂等空跑——仍会继续跑 prune + pull（两者恒幂等）'
}

# ── 1. fetch origin（差集核验要新鲜的参照系）──────────────────────────────────
Write-Step "1. git fetch origin（刷新 origin/$MainBranch 作差集核验的参照系）"

if ($DryRun) {
    Write-Plan 'git fetch origin'
} elseif ($branchStillExists) {
    $f = Invoke-Git -Cwd $RepoPath -GitArgs @('fetch', 'origin')
    if (-not $f.Ok) { Fail "git fetch 失败（exit $($f.Code)）——差集核验没有新鲜参照系，不敢继续" 4 }
    Write-Ok 'fetch 完成'
} else {
    Write-Skip '分支已不存在，差集核验没有意义，跳过 fetch'
}

# ── 2. 差集核验：决定 -d / -D / 拒绝 ──────────────────────────────────────────
Write-Step '2. 差集核验（只剩 merge 壳或空才准 -D，否则报错停）'

$deleteFlag = $null   # '-d' 或 '-D'；$null 表示尚未判定（或分支已不存在，无需判定）
if ($branchStillExists) {
    if ($DryRun) {
        Write-Plan "git rev-list origin/$MainBranch..$Branch（祖先关系判定）"
        Write-Plan "不空时改用 git cherry origin/$MainBranch $Branch（patch-id 等价判定）"
        Write-Note 'DryRun 不落判定结果，真跑时这一步会决定用 -d 还是 -D，或直接停在这里'
    } else {
        # 查 .Ok：「命令失败」与「零差异」必须分得开——不查的话 fatal 时 stdout 为空，
        # 零行会被读成「已完全并入」。数到 0 和没看到样本，输出一模一样。
        $revList = Invoke-Git -Cwd $RepoPath -GitArgs @('rev-list', "origin/$MainBranch..$Branch")
        if (-not $revList.Ok) {
            Fail ("差集核验没查成：git rev-list origin/$MainBranch..$Branch 失败（exit $($revList.Code)）—— " +
                  "「命令失败」不是「零差异」，不据此判定已合并。worktree 与分支原样未动") 4
        }
        $ahead = $revList.Out
        $aheadCount = @($ahead | Where-Object { $_ -ne '' }).Count
        if ($aheadCount -eq 0) {
            $deleteFlag = '-d'
            Write-Ok "祖先关系上 $Branch 已完全并入 origin/$MainBranch（rev-list 为空）—— 空，安全用 -d"
        } else {
            Write-Info "祖先关系上还有 $aheadCount 个提交没被判为主干祖先 —— 改用 git cherry 做内容等价判定（squash/rebase 合并后这是正常的）"
            # 同上：cherry 失败时 stdout 也是空，而「零行」在下面被判为「只剩 merge 壳，安全用 -D」
            $cherryR = Invoke-Git -Cwd $RepoPath -GitArgs @('cherry', "origin/$MainBranch", $Branch)
            if (-not $cherryR.Ok) {
                Fail ("差集核验没查成：git cherry origin/$MainBranch $Branch 失败（exit $($cherryR.Code)）—— " +
                      "「命令失败」不是「零差异」，不据此判定已合并。worktree 与分支原样未动") 4
            }
            $cherry = $cherryR.Out
            $cherryLines = @($cherry | Where-Object { $_ -ne '' })
            $unresolved = @($cherryLines | Where-Object { $_.StartsWith('+') })
            if ($cherryLines.Count -eq 0 -or $unresolved.Count -eq 0) {
                $deleteFlag = '-D'
                Write-Ok "git cherry：全部 $($cherryLines.Count) 个提交在主干上都有等价内容（只剩 merge 壳）—— 安全用 -D"
            } else {
                Write-Info ($cherryLines -join "`n")
                Fail ("差集核验判定不安全：$($unresolved.Count) 个提交在 origin/$MainBranch 上找不到等价内容（git cherry 报 + 号）—— " +
                      "分支可能还没真的合并，或合并方式与预期不符。worktree 与分支原样未动，人核实后重跑本脚本（可安全重跑）") 2
            }
        }
    }
} else {
    Write-Skip '分支已不存在，跳过差集核验（第 5 步删分支也会因此跳过）'
}

# ── 3. worktree remove（工作树不干净就拒绝删除并停）───────────────────────────
Write-Step '3. worktree remove'

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
                  "         —— 这意味着有工作还没提交，收尾脚本不替你决定丢弃它；处理完再重跑本脚本") 4
        }
    }
    $rm = Invoke-Git -Cwd $RepoPath -GitArgs @('worktree', 'remove', $WorktreePath)
    if ($rm.Ok) {
        Write-Ok "已删 worktree $WorktreePath"
    } else {
        Fail "git worktree remove 失败（exit $($rm.Code)）：`n$($rm.Out -join "`n")" 4
    }
}

# ── 4. git worktree prune（清理 remove 可能没清干净的残留登记；恒幂等）────────
Write-Step '4. git worktree prune'

if ($DryRun) {
    Write-Plan 'git worktree prune'
} else {
    $p = Invoke-Git -Cwd $RepoPath -GitArgs @('worktree', 'prune')
    if ($p.Ok) { Write-Ok 'prune 完成' } else { Fail "git worktree prune 失败（exit $($p.Code)）" 4 }
}

# ── 5. 删本地分支（用第 2 步决定的 -d / -D）───────────────────────────────────
Write-Step '5. 删本地分支'

if (-not $branchStillExists) {
    Write-Skip "分支 $Branch 已不存在，跳过"
} elseif ($DryRun) {
    Write-Plan "git branch <-d 或 -D，由第 2 步判定> $Branch"
} else {
    if (-not $deleteFlag) {
        # 理论上到不了这里（第 2 步不安全时已经 Fail 退出），留一道防御性硬停，不悄悄用 -d 兜底
        Fail '内部状态异常：分支仍存在但差集核验没有给出删除方式，拒绝猜测，停' 4
    }
    $bd = Invoke-Git -Cwd $RepoPath -GitArgs @('branch', $deleteFlag, $Branch)
    if ($bd.Ok) {
        Write-Ok "已删本地分支 $Branch（$deleteFlag）"
        # 机器可读行：给回归网钉「实际选中的 flag」（#260 件2 —— 此前两条断言只盯中文报文、
        # PowerShell -match 还大小写不敏感，-d/-D 互换两向皆绿）。值域只有 -d / -D 两个字面。
        Write-Info "DELETE_FLAG=$deleteFlag"
    } else {
        Fail "git branch $deleteFlag $Branch 失败（exit $($bd.Code)）：`n$($bd.Out -join "`n")" 4
    }
}

# ── 6. pull（让 RepoPath 追上刚合并的主干）────────────────────────────────────
Write-Step '6. git pull --ff-only'

if ($DryRun) {
    Write-Plan 'git pull --ff-only'
} else {
    $pull = Invoke-Git -Cwd $RepoPath -GitArgs @('pull', '--ff-only')
    if ($pull.Ok) {
        Write-Ok 'pull 完成'
        Write-Info ($pull.Out -join "`n")
    } else {
        Fail "git pull --ff-only 失败（exit $($pull.Code)）：`n$($pull.Out -join "`n")" 4
    }
}

Write-Host ''
Write-Host '──── 汇总 ────'
Write-Host "  worktree $WorktreePath / 分支 $Branch / 主仓 $RepoPath / 主干 $MainBranch"
if ($DryRun) { Write-Host '  DryRun：以上均未执行' }
Write-Host 'MERGE_CLEANUP_EXIT=0'
exit 0
