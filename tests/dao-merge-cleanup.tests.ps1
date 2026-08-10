<#
.SYNOPSIS
    `scripts/dao-merge-cleanup.ps1` 的行为级回归网（无 Pester 依赖）。退出码 0 = 全部通过。

.DESCRIPTION
    全部用**真 git**（真裸仓 `origin.git` + 真 `git worktree`），不桩任何东西——被测脚本
    通篇是 git 命令的编排，桩掉 git 就把要验的东西一并桩掉了。
    **一格例外，照直写**：场景 11/12 要验的是「git 查询**失败**时脚本怎么办」，而真 git 在
    正常夹具上不会失败 ⇒ 不注入就没有样本。注入面窄到一条 —— PATH 前置一个 `git.cmd`，
    只让指定的那**一个**子命令 exit 128（stdout 为空，fatal 的真实形态），其余原样转发给
    真 git（见 `New-FailingGitShim`）。判定路径本身一个字都没被桩掉。

    十六个场景，覆盖差集核验的两条安全路径、两类拒绝路径，以及幂等 / 前置校验 / DryRun：
      1. 祖先关系已并入（模拟 `git merge --no-ff`）⇒ rev-list 为空 ⇒ 用 `-d`
      2. 内容等价但非祖先（模拟 GitHub squash-merge：把同一份 diff 当新提交打进 main）
         ⇒ rev-list 非空、`git cherry` 全部 `-` ⇒ 用 `-D`
      3. 真没合并（main 上完全没有 feature 的内容）⇒ `git cherry` 出现 `+` ⇒ 拒绝，
         worktree 与分支原样不动，退出码 2
      4. worktree 有未提交改动 ⇒ 拒绝删除，退出码 4，worktree 与分支原样不动
      5. 幂等重跑：场景 1 成功清理一次之后，同样的命令再跑一次 ⇒ 全跳过、退出码 0
      6. 前置校验 A：`-WorktreePath` 与 `-RepoPath` 相同 ⇒ 退出码 1，零动作
      7. 前置校验 B：`-RepoPath` 当前就检出着 `-Branch` ⇒ 退出码 1，零动作
      8. `-DryRun`：只打印不执行，worktree 与分支原样不动，退出码 0
      9. 参照系 ref 不存在（`-MainBranch` 拼错一个字母）⇒ 第 0 步 fail-closed，退出码 1，
         那个**没合并**的分支与它的 worktree 一个都没动
     10. `-WorktreePath` 那棵树检出的不是 `-Branch`（别人的在途工作树）⇒ 退出码 1，零动作
     11. `git rev-list` 命令本身失败 ⇒ 退出码 4（「没查成」≠「零差异」），零动作
     12. `git cherry` 命令本身失败 ⇒ 退出码 4，零动作
     13. `-Branch` 与那棵树检出的分支只差大小写 ⇒ 退出码 1（钉住配对比对用的是 `-cne`）
     14. detached HEAD 的树 ⇒ 退出码 1，且断言那句**专属报文**（见该场景头上的归因说明）
     15. `git worktree list` 本身失败 ⇒ 退出码 1（探不到现场就不动手），零动作
     16. `-WorktreePath` 换成同一棵树的**另一种路径拼法**（尾杠 / 8.3 短名）⇒ 仍须认得出
         这棵树、仍须退出码 1 —— 认树只比字符串那一版这里是 0 且**真的把 -Branch 删了**
    9–15 是 2026-08-10 返修补的（PR #252 对抗验证判词阻断 1 / 阻断 2）：补之前 9 与 10 各自
    会**静默删掉一个没合并的分支 / 别人正在用的工作树**，而退出码是 0。
    16 是同日**复抗**补的，判词里没有这一条：它守的不是配对校验本身，而是配对校验的**前提**
    ——那道校验挂在「这棵树还登记着」之下，认不出树就等于整段没跑。9–15 全部只喂过一种
    路径拼法，所以这个洞对它们结构性不可见。
    十二/十三这两条的措辞刻意写「零动作」而不是「安全」——它们证的是这一批样本下没动手。

.NOTES
    独立可运行：powershell -NoProfile -ExecutionPolicy Bypass -File tests/dao-merge-cleanup.tests.ps1
    退出码：0 = 全部通过；1 = 存在失败。

    沙盒路径**随机化**（`%TEMP%/dao-merge-cleanup-test-<Get-Random>/`），不落仓内固定
    `_tmp/` 路径——issue #187 教训：固定共享路径在并行跑多个实例时，后开跑的会把先开跑
    那个的沙盒整棵删掉（`origin.git does not appear to be a git repository` 那个症状）。
    随机化只解决「与自己/与别人并行」不互踩，不代表可以无限并行——真 git 子进程照旧吃 CPU。

    PS 5.1 兼容：无三元运算符、无 && 链、禁 2>&1。本文件须以 BOM UTF-8 存盘。
    需要 PATH 上有真的 `git`。
#>

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\ccswitch\lib\console-utf8.ps1')  # pin child-stdout decode to UTF-8 -- see that file (issue #131)
$repoRoot  = Split-Path -Parent $PSScriptRoot
$targetPs1 = Join-Path $repoRoot 'scripts/dao-merge-cleanup.ps1'
$psExe     = (Get-Command powershell.exe).Source
$workRoot  = Join-Path ([System.IO.Path]::GetTempPath()) "dao-merge-cleanup-test-$(Get-Random)"
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

if (-not (Test-Path $targetPs1)) { Write-Host "被测脚本不存在：$targetPs1"; exit 1 }
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Write-Host '找不到 git —— 本回归网用真 git 跑，不桩它'; exit 1 }

New-Item -ItemType Directory -Force -Path $workRoot | Out-Null

# ⚠ 下面这个 try 块刻意不给整份正文重排缩进（同 dao-pr-merge.tests.ps1 的既有理由：
# 护栏类文件整体缩进会让 diff 淹掉真正的改动）。`exit` 在 try 里照样跑 finally 且退出码
# 原样保留（PS 5.1 实测）。兜不住的一格：进程被外部强杀（超时/Ctrl-C）不会走 finally，
# 那时 %TEMP% 下会留一个随机名目录——已知代价，不是疏漏。
try {

$results = New-Object System.Collections.Generic.List[object]

function Assert-True {
    param([string]$Name, [bool]$Condition, [string]$Detail = '')
    $status = 'FAIL'
    if ($Condition) { $status = 'PASS' }
    $script:results.Add([PSCustomObject]@{ Name = $Name; Status = $status; Detail = $Detail })
    Write-Host ("  [{0}] {1} {2}" -f $status, $Name, $Detail)
}

function Git0 {
    # 夹具搭建用：任何一步失败就地抛出（夹具搭歪了却继续跑，得到的绿是假的）
    param([string[]]$GitArgs)
    $out = & git @GitArgs
    if ($LASTEXITCODE -ne 0) {
        throw ("夹具 git 失败（exit $LASTEXITCODE）：git " + ($GitArgs -join ' ') + "`n" + (@($out) -join "`n"))
    }
    return $out
}

# ── 夹具：origin.git（裸仓）+ main（RepoPath，检出 main）+ wt（WorktreePath，检出 feature/x）
function New-Fixture {
    param([string]$Case)
    $dir    = Join-Path $workRoot $Case
    $origin = Join-Path $dir 'origin.git'
    $main   = Join-Path $dir 'main'
    $wt     = Join-Path $dir 'wt'
    New-Item -ItemType Directory -Force -Path $dir | Out-Null

    Git0 @('init', '--quiet', '--bare', $origin) | Out-Null
    Git0 @('init', '--quiet', $main) | Out-Null
    Git0 @('-C', $main, 'config', 'user.email', 'dao@example.invalid') | Out-Null
    Git0 @('-C', $main, 'config', 'user.name', 'dao-test') | Out-Null
    Git0 @('-C', $main, 'config', 'commit.gpgsign', 'false') | Out-Null

    [IO.File]::WriteAllText((Join-Path $main 'README.md'), "seed`n", $utf8NoBom)
    Git0 @('-C', $main, 'add', 'README.md') | Out-Null
    Git0 @('-C', $main, 'commit', '--quiet', '-m', 'seed') | Out-Null
    Git0 @('-C', $main, 'branch', '-M', 'main') | Out-Null
    Git0 @('-C', $main, 'remote', 'add', 'origin', $origin) | Out-Null
    Git0 @('-C', $main, 'push', '--quiet', '-u', 'origin', 'main') | Out-Null

    Git0 @('-C', $main, 'worktree', 'add', '--quiet', '-b', 'feature/x', $wt, 'main') | Out-Null
    Git0 @('-C', $wt, 'config', 'user.email', 'dao@example.invalid') | Out-Null
    Git0 @('-C', $wt, 'config', 'user.name', 'dao-test') | Out-Null
    Git0 @('-C', $wt, 'config', 'commit.gpgsign', 'false') | Out-Null
    [IO.File]::WriteAllText((Join-Path $wt 'feature.txt'), "feature`n", $utf8NoBom)
    Git0 @('-C', $wt, 'add', 'feature.txt') | Out-Null
    Git0 @('-C', $wt, 'commit', '--quiet', '-m', 'feature work') | Out-Null
    Git0 @('-C', $wt, 'push', '--quiet', '-u', 'origin', 'feature/x') | Out-Null

    return [PSCustomObject]@{ Dir = $dir; Origin = $origin; Main = $main; Wt = $wt; Branch = 'feature/x' }
}

function Invoke-Target {
    param([string[]]$ExtraArgs, [PSCustomObject]$Fixture, [string]$RepoPathOverride, [string]$BranchOverride,
          [string]$WorktreePathOverride, [string]$PathPrefix, [string]$FailingGitSubcommand)
    $repoPath = $Fixture.Main
    if ($RepoPathOverride) { $repoPath = $RepoPathOverride }
    $branch = $Fixture.Branch
    if ($BranchOverride) { $branch = $BranchOverride }
    $wtPath = $Fixture.Wt
    if ($WorktreePathOverride) { $wtPath = $WorktreePathOverride }
    $psArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $targetPs1,
        '-WorktreePath', $wtPath, '-Branch', $branch, '-RepoPath', $repoPath) + $ExtraArgs
    # PathPrefix / FailingGitSubcommand 只给「git 命令失败」那两个场景用，见 New-FailingGitShim
    $savedPath = $env:PATH
    $savedFail = $env:DAO_TEST_GIT_FAIL
    if ($PathPrefix) { $env:PATH = $PathPrefix + ';' + $savedPath }
    if ($FailingGitSubcommand) { $env:DAO_TEST_GIT_FAIL = $FailingGitSubcommand }
    try {
        $out = & $psExe @psArgs
        $code = $LASTEXITCODE
    } finally {
        $env:PATH = $savedPath
        if ($null -eq $savedFail) { Remove-Item Env:\DAO_TEST_GIT_FAIL -ErrorAction SilentlyContinue }
        else { $env:DAO_TEST_GIT_FAIL = $savedFail }
    }
    return [PSCustomObject]@{ ExitCode = $code; Text = (@($out) -join "`n") }
}

# ── 「某条 git 查询失败」的注入口（只在场景 11/12 用）─────────────────────────────
# 本文件的原则是**不桩 git**（被测脚本通篇是 git 编排，桩掉 git 就把要验的东西一并桩掉）。
# 这里有一格例外，理由照直写：要验的是「git 命令**失败**时脚本怎么办」，而真 git 在正常
# 夹具上不会失败——**不注入就没有样本，而零样本的校验与没有校验，输出一模一样**。
# 注入面窄到一条：PATH 前置一个 git.cmd，只让 %DAO_TEST_GIT_FAIL% 那一个子命令 exit 128
# （stdout 为空，正是 fatal 的真实形态），其余全部原样转发给真 git。
function New-FailingGitShim {
    param([string]$Dir)
    New-Item -ItemType Directory -Force -Path $Dir | Out-Null
    $realGit = (Get-Command git).Source
    $cmd = @"
@echo off
if /I "%~3"=="%DAO_TEST_GIT_FAIL%" exit 128
"$realGit" %*
"@
    [IO.File]::WriteAllText((Join-Path $Dir 'git.cmd'), $cmd, (New-Object System.Text.ASCIIEncoding))
    return $Dir
}

function Test-WorktreeRegistered {
    param([string]$RepoPath, [string]$WtPath)
    $list = & git -C $RepoPath worktree list --porcelain
    $resolved = $WtPath
    if (Test-Path -LiteralPath $WtPath) { $resolved = (Resolve-Path -LiteralPath $WtPath).Path }
    foreach ($line in $list) {
        if ($line -like 'worktree *') {
            $entry = $line.Substring(9)
            $entryResolved = $entry
            if (Test-Path -LiteralPath $entry) { $entryResolved = (Resolve-Path -LiteralPath $entry).Path }
            if ($entryResolved -eq $resolved) { return $true }
        }
    }
    return $false
}
function Test-BranchExists {
    param([string]$RepoPath, [string]$Branch)
    $null = & git -C $RepoPath rev-parse --verify --quiet ('refs/heads/' + $Branch)
    return ($LASTEXITCODE -eq 0)
}

# ── 场景 1：祖先关系已并入（真 --no-ff merge）⇒ 空 ⇒ -d ──────────────────────────
$f1 = New-Fixture -Case 'case1-ancestor'
Git0 @('-C', $f1.Main, 'merge', '--no-ff', '--quiet', '-m', 'merge feature/x', 'feature/x') | Out-Null
Git0 @('-C', $f1.Main, 'push', '--quiet', 'origin', 'main') | Out-Null
$r1 = Invoke-Target -Fixture $f1
Assert-True '场景1 祖先关系已并入：退出码 0' ($r1.ExitCode -eq 0) ("实际 $($r1.ExitCode)`n" + $r1.Text)
Assert-True '场景1：判定用了 -d（rev-list 为空的报文）' ($r1.Text -match '安全用 -d')
Assert-True '场景1：worktree 已从登记里清除' (-not (Test-WorktreeRegistered -RepoPath $f1.Main -WtPath $f1.Wt))
Assert-True '场景1：本地分支已删除' (-not (Test-BranchExists -RepoPath $f1.Main -Branch $f1.Branch))
Assert-True '场景1：worktree 目录本身也已被删（git worktree remove 的正常行为）' (-not (Test-Path -LiteralPath $f1.Wt))

# ── 场景 2：内容等价但非祖先（模拟 squash-merge：cherry-pick 同一份 diff 到 main）⇒ -D ──
# 关键：cherry-pick 前先让 main 独立前进一个不相关的提交，否则 main 与 feature/x 共享同一个
# 父提交（都是 seed），cherry-pick 出来的新提交可能与 feature/x 原提交树/父/日期全部相同，
# 被 git 判成**同一个commit 对象**（rev-list 恰好为空，等价于场景1，不是本场景要测的分支）。
# main 先各自前进一步，保证父提交不同、cherry-pick 出来的一定是新 SHA，才是真正的
# 「非祖先但内容等价」——GitHub squash-merge 的真实形态。
$f2 = New-Fixture -Case 'case2-squash-equivalent'
[IO.File]::WriteAllText((Join-Path $f2.Main 'main-progress.txt'), "unrelated main progress`n", $utf8NoBom)
Git0 @('-C', $f2.Main, 'add', 'main-progress.txt') | Out-Null
Git0 @('-C', $f2.Main, 'commit', '--quiet', '-m', 'unrelated main progress') | Out-Null
Git0 @('-C', $f2.Main, 'cherry-pick', 'feature/x') | Out-Null
Git0 @('-C', $f2.Main, 'push', '--quiet', 'origin', 'main') | Out-Null
$r2 = Invoke-Target -Fixture $f2
Assert-True '场景2 squash 等价：退出码 0' ($r2.ExitCode -eq 0) ("实际 $($r2.ExitCode)`n" + $r2.Text)
Assert-True '场景2：判定用了 -D（git cherry 全部等价的报文）' ($r2.Text -match '只剩 merge 壳.*安全用 -D')
Assert-True '场景2：worktree 已从登记里清除' (-not (Test-WorktreeRegistered -RepoPath $f2.Main -WtPath $f2.Wt))
Assert-True '场景2：本地分支已删除（用 -D 强删成功）' (-not (Test-BranchExists -RepoPath $f2.Main -Branch $f2.Branch))

# ── 场景 3：真没合并（main 上完全没有 feature 的内容）⇒ git cherry 出现 + ⇒ 拒绝 ──────
$f3 = New-Fixture -Case 'case3-not-merged'
# 不改 origin/main，feature/x 的内容确实还没落进主干
$r3 = Invoke-Target -Fixture $f3
Assert-True '场景3 真没合并：退出码 2（差集核验判不安全）' ($r3.ExitCode -eq 2) ("实际 $($r3.ExitCode)`n" + $r3.Text)
Assert-True '场景3：报文提到判定不安全' ($r3.Text -match '判定不安全')
Assert-True '场景3：worktree 原样未动' (Test-WorktreeRegistered -RepoPath $f3.Main -WtPath $f3.Wt)
Assert-True '场景3：本地分支原样未动' (Test-BranchExists -RepoPath $f3.Main -Branch $f3.Branch)
Assert-True '场景3：worktree 目录本身也还在' (Test-Path -LiteralPath $f3.Wt)

# ── 场景 4：worktree 有未提交改动 ⇒ 拒绝删除 ─────────────────────────────────────
$f4 = New-Fixture -Case 'case4-dirty'
Git0 @('-C', $f4.Main, 'merge', '--no-ff', '--quiet', '-m', 'merge feature/x', 'feature/x') | Out-Null
Git0 @('-C', $f4.Main, 'push', '--quiet', 'origin', 'main') | Out-Null
[IO.File]::WriteAllText((Join-Path $f4.Wt 'uncommitted.txt'), "still working`n", $utf8NoBom)
$r4 = Invoke-Target -Fixture $f4
Assert-True '场景4 worktree 不干净：退出码 4' ($r4.ExitCode -eq 4) ("实际 $($r4.ExitCode)`n" + $r4.Text)
Assert-True '场景4：报文提到不干净/拒绝删除' ($r4.Text -match '不干净，拒绝删除')
Assert-True '场景4：worktree 原样未动（含未提交文件还在）' (Test-Path -LiteralPath (Join-Path $f4.Wt 'uncommitted.txt'))
Assert-True '场景4：本地分支原样未动（差集核验本身是安全的，只是 worktree 那一步拒绝了）' (Test-BranchExists -RepoPath $f4.Main -Branch $f4.Branch)

# ── 场景 5：幂等重跑（复用场景 1 已清理完的现场）─────────────────────────────────
$r5 = Invoke-Target -Fixture $f1
Assert-True '场景5 幂等重跑：退出码 0' ($r5.ExitCode -eq 0) ("实际 $($r5.ExitCode)`n" + $r5.Text)
Assert-True '场景5：报文里两处都打了跳过（worktree 与分支各自「已清理」）' (
    ($r5.Text -match '视为已清理') -and ([regex]::Matches($r5.Text, '视为已清理').Count -ge 2)
) $r5.Text

# ── 场景 6：前置校验 A —— WorktreePath 与 RepoPath 相同 ⇒ 退出码 1 ────────────────
$f6 = New-Fixture -Case 'case6-same-path'
$r6 = Invoke-Target -Fixture $f6 -RepoPathOverride $f6.Wt
Assert-True '场景6 WorktreePath==RepoPath：退出码 1' ($r6.ExitCode -eq 1) ("实际 $($r6.ExitCode)`n" + $r6.Text)
Assert-True '场景6：worktree 原样未动（前置校验没做任何写操作）' (Test-WorktreeRegistered -RepoPath $f6.Main -WtPath $f6.Wt)

# ── 场景 7：前置校验 B —— RepoPath 当前就检出着 -Branch ⇒ 退出码 1 ──────────────────
$f7 = New-Fixture -Case 'case7-repopath-on-branch'
$r7 = Invoke-Target -Fixture $f7 -BranchOverride 'main'
Assert-True '场景7 RepoPath 当前分支===Branch：退出码 1' ($r7.ExitCode -eq 1) ("实际 $($r7.ExitCode)`n" + $r7.Text)

# ── 场景 8：DryRun 只打印不执行 ───────────────────────────────────────────────────
$f8 = New-Fixture -Case 'case8-dryrun'
Git0 @('-C', $f8.Main, 'merge', '--no-ff', '--quiet', '-m', 'merge feature/x', 'feature/x') | Out-Null
Git0 @('-C', $f8.Main, 'push', '--quiet', 'origin', 'main') | Out-Null
$r8 = Invoke-Target -Fixture $f8 -ExtraArgs @('-DryRun')
Assert-True '场景8 DryRun：退出码 0' ($r8.ExitCode -eq 0) ("实际 $($r8.ExitCode)`n" + $r8.Text)
Assert-True '场景8：worktree 没有被真的删除' (Test-WorktreeRegistered -RepoPath $f8.Main -WtPath $f8.Wt)
Assert-True '场景8：本地分支没有被真的删除' (Test-BranchExists -RepoPath $f8.Main -Branch $f8.Branch)

# ── 场景 9：参照系 ref 不存在（-MainBranch 拼错一个字母）⇒ fail-closed，一步都不做 ──────
# 对抗验证判词阻断 1（PR #252，沙盒 E6）的逐条复现：feature/x 事前**确实没合并**且已 push，
# 补校验之前 `git rev-list origin/mian..feature/x` fatal、stdout 为空 ⇒ 零行被读成「零差异」
# ⇒ 打印「已完全并入主干，安全用 -d」并**真的删掉 worktree + 删掉这个没合并的分支**，exit 0。
$f9 = New-Fixture -Case 'case9-bad-mainbranch'
$cherryBefore = & git -C $f9.Main cherry origin/main feature/x
Assert-True '场景9 前提：feature/x 事前确实没并入 origin/main（git cherry 报 +）' (
    (@($cherryBefore | Where-Object { $_ -ne '' }) | Where-Object { $_.StartsWith('+') }).Count -ge 1
) ((@($cherryBefore) -join '; '))
$r9 = Invoke-Target -Fixture $f9 -ExtraArgs @('-MainBranch', 'mian')
Assert-True '场景9 origin/mian 不存在：退出码 1（fail-closed；fail-open 那一版这里是 0）' ($r9.ExitCode -eq 1) ("实际 $($r9.ExitCode)`n" + $r9.Text)
Assert-True '场景9：报文点名探不到 origin/mian（不是含糊地报别的错）' ($r9.Text -match '探不到 origin/mian')
Assert-True '场景9：没有打印过「安全用 -d」（压根没走到差集核验）' (-not ($r9.Text -match '安全用'))
Assert-True '场景9：worktree 仍在登记里' (Test-WorktreeRegistered -RepoPath $f9.Main -WtPath $f9.Wt)
Assert-True '场景9：worktree 目录还在' (Test-Path -LiteralPath $f9.Wt)
Assert-True '场景9：那个没合并的分支还在（这正是 fail-open 会丢掉的东西）' (Test-BranchExists -RepoPath $f9.Main -Branch $f9.Branch)

# ── 场景 10：worktree 与 -Branch 配对不符 ⇒ 拒绝，别人的在途工作树原样不动 ────────────
# 对抗验证判词阻断 2（沙盒 E3）的复现：-Branch 传一个**已并入主干**的分支（差集核验会一路
# 绿灯判「安全用 -d」），而 -WorktreePath 指着另一位官检出 other/unmerged 的那棵在途的树。
$f10 = New-Fixture -Case 'case10-pair-mismatch'
Git0 @('-C', $f10.Main, 'merge', '--no-ff', '--quiet', '-m', 'merge feature/x', 'feature/x') | Out-Null
Git0 @('-C', $f10.Main, 'push', '--quiet', 'origin', 'main') | Out-Null
$otherWt = Join-Path $f10.Dir 'wt-other'
Git0 @('-C', $f10.Main, 'worktree', 'add', '--quiet', '-b', 'other/unmerged', $otherWt, 'main') | Out-Null
Git0 @('-C', $otherWt, 'config', 'user.email', 'dao@example.invalid') | Out-Null
Git0 @('-C', $otherWt, 'config', 'user.name', 'dao-test') | Out-Null
Git0 @('-C', $otherWt, 'config', 'commit.gpgsign', 'false') | Out-Null
[IO.File]::WriteAllText((Join-Path $otherWt 'in-flight.txt'), "别人正在做的活`n", $utf8NoBom)
Git0 @('-C', $otherWt, 'add', 'in-flight.txt') | Out-Null
Git0 @('-C', $otherWt, 'commit', '--quiet', '-m', 'in-flight work') | Out-Null
$r10 = Invoke-Target -Fixture $f10 -WorktreePathOverride $otherWt
Assert-True '场景10 配对不符：退出码 1（fail-closed；配对零校验那一版这里是 0）' ($r10.ExitCode -eq 1) ("实际 $($r10.ExitCode)`n" + $r10.Text)
Assert-True '场景10：报文点名配对不符并报出两个分支名' (
    ($r10.Text -match '配对不符') -and ($r10.Text -match 'other/unmerged')
) $r10.Text
Assert-True '场景10：别人的在途工作树目录还在' (Test-Path -LiteralPath $otherWt)
Assert-True '场景10：别人的在途工作树仍在登记里' (Test-WorktreeRegistered -RepoPath $f10.Main -WtPath $otherWt)
Assert-True '场景10：别人的分支 other/unmerged 还在' (Test-BranchExists -RepoPath $f10.Main -Branch 'other/unmerged')
Assert-True '场景10：-Branch 给的 feature/x 也没被删（一步都没做）' (Test-BranchExists -RepoPath $f10.Main -Branch $f10.Branch)

# ── 场景 11：rev-list 命令失败（不是零差异）⇒ 停，不据此判「已合并」───────────────────
# 夹具本身是「祖先关系已并入」——即 rev-list 正常跑时会判「安全用 -d」并真的删。注入让
# rev-list exit 128（stdout 为空），若不查 .Ok 就与「零差异」不可区分。
$f11 = New-Fixture -Case 'case11-revlist-fails'
Git0 @('-C', $f11.Main, 'merge', '--no-ff', '--quiet', '-m', 'merge feature/x', 'feature/x') | Out-Null
Git0 @('-C', $f11.Main, 'push', '--quiet', 'origin', 'main') | Out-Null
$shim11 = New-FailingGitShim -Dir (Join-Path $f11.Dir 'gitshim')
$r11 = Invoke-Target -Fixture $f11 -PathPrefix $shim11 -FailingGitSubcommand 'rev-list'
Assert-True '场景11 rev-list 失败：退出码 4（没查成 ≠ 零差异）' ($r11.ExitCode -eq 4) ("实际 $($r11.ExitCode)`n" + $r11.Text)
Assert-True '场景11：报文说的是「没查成」而不是判定结果' ($r11.Text -match '差集核验没查成') $r11.Text
Assert-True '场景11：没有打印过「安全用 -d」' (-not ($r11.Text -match '安全用')) $r11.Text
Assert-True '场景11：worktree 原样未动' (Test-WorktreeRegistered -RepoPath $f11.Main -WtPath $f11.Wt)
Assert-True '场景11：本地分支原样未动' (Test-BranchExists -RepoPath $f11.Main -Branch $f11.Branch)

# ── 场景 12：cherry 命令失败（不是零差异）⇒ 停 ─────────────────────────────────────
# 夹具同场景 2（squash 等价）：rev-list 非空 ⇒ 走到 git cherry 这一半，注入让它 exit 128。
# 不查 .Ok 时空输出会被判成「全部等价，只剩 merge 壳 —— 安全用 -D」，那是强删。
$f12 = New-Fixture -Case 'case12-cherry-fails'
[IO.File]::WriteAllText((Join-Path $f12.Main 'main-progress.txt'), "unrelated main progress`n", $utf8NoBom)
Git0 @('-C', $f12.Main, 'add', 'main-progress.txt') | Out-Null
Git0 @('-C', $f12.Main, 'commit', '--quiet', '-m', 'unrelated main progress') | Out-Null
Git0 @('-C', $f12.Main, 'cherry-pick', 'feature/x') | Out-Null
Git0 @('-C', $f12.Main, 'push', '--quiet', 'origin', 'main') | Out-Null
$shim12 = New-FailingGitShim -Dir (Join-Path $f12.Dir 'gitshim')
$r12 = Invoke-Target -Fixture $f12 -PathPrefix $shim12 -FailingGitSubcommand 'cherry'
Assert-True '场景12 cherry 失败：退出码 4（没查成 ≠ 零差异）' ($r12.ExitCode -eq 4) ("实际 $($r12.ExitCode)`n" + $r12.Text)
Assert-True '场景12：报文说的是「没查成」' ($r12.Text -match '差集核验没查成') $r12.Text
Assert-True '场景12：没有打印过「安全用 -D」' (-not ($r12.Text -match '安全用')) $r12.Text
Assert-True '场景12：worktree 原样未动' (Test-WorktreeRegistered -RepoPath $f12.Main -WtPath $f12.Wt)
Assert-True '场景12：本地分支原样未动' (Test-BranchExists -RepoPath $f12.Main -Branch $f12.Branch)

# ── 场景 13：配对比对必须大小写敏感（钉住 -cne，不是 -ne）────────────────────────────
# 为什么这一格需要专属样本：PowerShell 的 `-ne` / `-match` 默认**大小写不敏感**，而 git 的
# ref 名是大小写敏感的。本机实测（Windows，大小写不敏感的文件系统）：
# `git rev-parse --verify refs/heads/Feature/X` 与 `refs/heads/feature/x` 返回**同一个 sha**
# ⇒ `$branchStillExists` 那道探测拦不住大小写变体，配对校验若用 `-ne` 就整条形同虚设。
# 夹具是「祖先关系已并入」，所以放过去的话会真的删——这条断言分得开 `-cne` 与 `-ne`。
$f13 = New-Fixture -Case 'case13-branch-case-variant'
Git0 @('-C', $f13.Main, 'merge', '--no-ff', '--quiet', '-m', 'merge feature/x', 'feature/x') | Out-Null
Git0 @('-C', $f13.Main, 'push', '--quiet', 'origin', 'main') | Out-Null
$r13 = Invoke-Target -Fixture $f13 -BranchOverride 'Feature/X'
Assert-True '场景13 -Branch 只有大小写不同：退出码 1（-ne 那一版这里是 0 并真的删）' ($r13.ExitCode -eq 1) ("实际 $($r13.ExitCode)`n" + $r13.Text)
Assert-True '场景13：报文点名配对不符' ($r13.Text -match '配对不符') $r13.Text
Assert-True '场景13：worktree 原样未动' (Test-WorktreeRegistered -RepoPath $f13.Main -WtPath $f13.Wt)
Assert-True '场景13：本地分支原样未动' (Test-BranchExists -RepoPath $f13.Main -Branch $f13.Branch)

# ── 场景 14：detached HEAD 的树 ⇒ 拒绝，且报文要**指得准** ───────────────────────────
# ⚠ 这条断言钉的是**归因报文**，不是安全性——照直写，免得被读成两道安全网：把被测脚本里
# 那道 `-not $worktreeCheckedOutBranch` 去掉，下面 `-cne` 那道照样拦得住（`$null -cne
# 'feature/x'` 为真），退出码一个字不变。所以这里额外断言那句 detached 专属报文：报文变
# 笼统就是判别信号。（判词问题 5 记的正是「两道门只有一道有专属样本」那个形态。）
$f14 = New-Fixture -Case 'case14-detached-worktree'
$detachedWt = Join-Path $f14.Dir 'wt-detached'
Git0 @('-C', $f14.Main, 'worktree', 'add', '--quiet', '--detach', $detachedWt, 'main') | Out-Null
$r14 = Invoke-Target -Fixture $f14 -WorktreePathOverride $detachedWt
Assert-True '场景14 detached HEAD 的树：退出码 1' ($r14.ExitCode -eq 1) ("实际 $($r14.ExitCode)`n" + $r14.Text)
Assert-True '场景14：报文说的是「没有检出任何分支」（归因指得准，不是笼统的配对不符）' ($r14.Text -match '没有检出任何分支') $r14.Text
Assert-True '场景14：那棵 detached 的树原样未动' (Test-Path -LiteralPath $detachedWt)

# ── 场景 15：连 `git worktree list` 都失败 ⇒ 探不到现场就不动手 ──────────────────────
# 夹具是「祖先关系已并入」：不查 .Ok 的话，空输出 ⇒ 判「worktree 已不在登记里」⇒ 一路走到
# 底（后面 prune 也会踩同一个失败，落到 exit 4）。这条断言分得开 exit 1 与 exit 4。
$f15 = New-Fixture -Case 'case15-worktree-list-fails'
Git0 @('-C', $f15.Main, 'merge', '--no-ff', '--quiet', '-m', 'merge feature/x', 'feature/x') | Out-Null
Git0 @('-C', $f15.Main, 'push', '--quiet', 'origin', 'main') | Out-Null
$shim15 = New-FailingGitShim -Dir (Join-Path $f15.Dir 'gitshim')
$r15 = Invoke-Target -Fixture $f15 -PathPrefix $shim15 -FailingGitSubcommand 'worktree'
Assert-True '场景15 git worktree list 失败：退出码 1（探不到现场，一步都不做）' ($r15.ExitCode -eq 1) ("实际 $($r15.ExitCode)`n" + $r15.Text)
Assert-True '场景15：报文点名是 worktree list 失败' ($r15.Text -match 'worktree list --porcelain 失败') $r15.Text
Assert-True '场景15：worktree 原样未动' (Test-WorktreeRegistered -RepoPath $f15.Main -WtPath $f15.Wt)
Assert-True '场景15：本地分支原样未动' (Test-BranchExists -RepoPath $f15.Main -Branch $f15.Branch)

# ── 场景 16：配对校验不许被「同一棵树的另一种路径拼法」绕过 ────────────────────────
# 2026-08-10 复抗实测出来的漏网（**判词里没有这一条**，是返修批自己的洞）：认这棵树此前
# 靠 `Resolve-Path` 两边规范化后比字符串，而 `Resolve-Path` **不展开 8.3 短名、也不吃掉
# 结尾那个反斜杠** ⇒ 传 `<wt>\` 或 `C:\Users\ADMINI~1\…\wt` 时与 git 打印的长名正斜杠形态
# 比不上 ⇒ `$worktreeStillRegistered` 判假 ⇒ **场景 10/13/14 守的那道配对校验整段被跳过**，
# 脚本打印「视为已清理」（假话，它还登记着）并把 -Branch 给的分支删掉，exit 0。
# 夹具与场景 10 同形，只把 -WorktreePath 换成带尾杠的写法。
# **为什么用尾杠而不是 8.3 短名做触发器**：8dot3name 可以被逐卷关掉（关了之后短名==长名，
# 这条场景会静默退化成场景 10 的重复 ⇒ 零样本却照常绿），尾杠在任何机器上都构造得出。
#
# ⚠ **-Branch 刻意用 `merged/orphan` 这个「没被任何树检出的已合并分支」，不用 feature/x**，
# 理由是实测出来的、值得记（M8 变异第一版就栽在这里）：feature/x 被夹具自己那棵 wt 检出着，
# 于是修前那一版走到第 5 步会被 **git 自己**的「分支正被别的工作树检出」保护挡下 ⇒ exit 4、
# 分支还在。那个 4 让人误以为「有东西拦住了」，其实拦住它的不是本脚本的任何一道校验。
# 换成没被检出的分支，修前那一版就是**真的删掉它并 exit 0**——这才是这条场景要钉的那个后果。
$f16 = New-Fixture -Case 'case16-path-spelling-bypass'
Git0 @('-C', $f16.Main, 'merge', '--no-ff', '--quiet', '-m', 'merge feature/x', 'feature/x') | Out-Null
Git0 @('-C', $f16.Main, 'push', '--quiet', 'origin', 'main') | Out-Null
# 已并入主干、且没有任何 worktree 检出它 ⇒ `git branch -d` 会痛快删掉
Git0 @('-C', $f16.Main, 'branch', 'merged/orphan', 'main') | Out-Null
$otherWt16 = Join-Path $f16.Dir 'wt-other'
Git0 @('-C', $f16.Main, 'worktree', 'add', '--quiet', '-b', 'other/unmerged', $otherWt16, 'main') | Out-Null
Git0 @('-C', $otherWt16, 'config', 'user.email', 'dao@example.invalid') | Out-Null
Git0 @('-C', $otherWt16, 'config', 'user.name', 'dao-test') | Out-Null
Git0 @('-C', $otherWt16, 'config', 'commit.gpgsign', 'false') | Out-Null
[IO.File]::WriteAllText((Join-Path $otherWt16 'in-flight.txt'), "别人正在做的活`n", $utf8NoBom)
Git0 @('-C', $otherWt16, 'add', 'in-flight.txt') | Out-Null
Git0 @('-C', $otherWt16, 'commit', '--quiet', '-m', 'in-flight work') | Out-Null
$otherWt16Slash = $otherWt16 + '\'
# 前提断言：这个「另一种拼法」经 Resolve-Path 之后**确实**还是另一个字符串。它若哪天被
# 归一化掉，本场景就退化成场景 10 的重复 —— 那时这条会红，红得对（提醒换触发器），
# 而不是让一条零判别力的场景继续挂在网上装数。
Assert-True '场景16 前提：尾杠写法经 Resolve-Path 后与原写法确实不同（否则本场景退化成场景10）' (
    ((Resolve-Path -LiteralPath $otherWt16Slash).Path) -ne ((Resolve-Path -LiteralPath $otherWt16).Path)
) ("[$((Resolve-Path -LiteralPath $otherWt16Slash).Path)] vs [$((Resolve-Path -LiteralPath $otherWt16).Path)]")
Assert-True '场景16 前提：merged/orphan 事前存在（它就是修前那一版会被删掉的那个东西）' (Test-BranchExists -RepoPath $f16.Main -Branch 'merged/orphan')
$r16 = Invoke-Target -Fixture $f16 -WorktreePathOverride $otherWt16Slash -BranchOverride 'merged/orphan'
Assert-True '场景16 换个路径拼法：退出码 1（认树只比字符串那一版这里是 0）' ($r16.ExitCode -eq 1) ("实际 $($r16.ExitCode)`n" + $r16.Text)
Assert-True '场景16：报文点名配对不符并报出别人那个分支名（＝配对校验真的跑到了）' (
    ($r16.Text -match '配对不符') -and ($r16.Text -match 'other/unmerged')
) $r16.Text
Assert-True '场景16：没有打印过「视为已清理」（那句在认不出这棵树时是假话）' (-not ($r16.Text -match '视为已清理')) $r16.Text
Assert-True '场景16：merged/orphan 没被删（认不出树那一版它会被真的删掉，exit 还是 0）' (Test-BranchExists -RepoPath $f16.Main -Branch 'merged/orphan')
Assert-True '场景16：别人的在途工作树目录还在' (Test-Path -LiteralPath $otherWt16)
Assert-True '场景16：别人的分支 other/unmerged 还在' (Test-BranchExists -RepoPath $f16.Main -Branch 'other/unmerged')

# ── 语法自检：被测脚本本身能被 PowerShell parser 干净解析（BOM/中文字面量坑同款）───────
$tokens = $null
$errors = $null
$null = [System.Management.Automation.Language.Parser]::ParseFile($targetPs1, [ref]$tokens, [ref]$errors)
Assert-True '被测脚本 parser 零语法错误（含中文字面量，须 BOM 才解得对）' ($errors.Count -eq 0) `
    ((@($errors) | ForEach-Object { $_.Message }) -join '; ')

# ── 汇总 ──────────────────────────────────────────────────────────────────────
$fail = @($results | Where-Object { $_.Status -eq 'FAIL' }).Count
$pass = @($results | Where-Object { $_.Status -eq 'PASS' }).Count
Write-Host ''
Write-Host ("PASS=$pass FAIL=$fail")
if ($fail -gt 0) { exit 1 } else { exit 0 }

} finally {
    Remove-Item -Recurse -Force -LiteralPath $workRoot -ErrorAction SilentlyContinue
}
