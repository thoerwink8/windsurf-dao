<#
.SYNOPSIS
    `scripts/dao-merge-cleanup.ps1` 的行为级回归网（无 Pester 依赖）。退出码 0 = 全部通过。

.DESCRIPTION
    全部用**真 git**（真裸仓 `origin.git` + 真 `git worktree`），不桩任何东西——被测脚本
    通篇是 git 命令的编排，桩掉 git 就把要验的东西一并桩掉了。

    八个场景，覆盖差集核验的两条安全路径、一条拒绝路径，以及幂等 / 前置校验 / DryRun：
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
    param([string[]]$ExtraArgs, [PSCustomObject]$Fixture, [string]$RepoPathOverride, [string]$BranchOverride)
    $repoPath = $Fixture.Main
    if ($RepoPathOverride) { $repoPath = $RepoPathOverride }
    $branch = $Fixture.Branch
    if ($BranchOverride) { $branch = $BranchOverride }
    $psArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $targetPs1,
        '-WorktreePath', $Fixture.Wt, '-Branch', $branch, '-RepoPath', $repoPath) + $ExtraArgs
    $out = & $psExe @psArgs
    $code = $LASTEXITCODE
    return [PSCustomObject]@{ ExitCode = $code; Text = (@($out) -join "`n") }
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
