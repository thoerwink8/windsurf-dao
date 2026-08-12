<#
分支删除前的差集核验。

守的对象：scripts/dao-merge-cleanup.ps1 的第 2 步（决定 -d / -D / 拒绝）。
它失效的样子是**静默的**——核验一旦判错，脚本照常往下走、照常打印「已删」并 exit 0，
而被删的是一个**还没并入主干**的分支。屏幕上看不出任何异常，要等有人回头找那些提交才发现。
（reflog 能捞回来，但那是「事后有人想起来去捞」，不是保证。）

两个场景，缺任何一个这套都证明不了什么：
  ① 正控     分支有未并入的提交 ⇒ exit 2，worktree 与分支**原样未动**
  ② 判别力   分支真的已并入     ⇒ exit 0，分支删掉
     没有 ②，把核验改成「恒拒绝」也能让 ① 变绿——那是把功能砸了而不是守住它。

不桩 git：被测脚本通篇是 git 编排，桩掉 git 就把要验的东西一并桩掉。
沙盒随机化 ⇒ 可与别的测试并行跑。
#>

$ErrorActionPreference = 'Stop'
$repoRoot  = Split-Path -Parent $PSScriptRoot
# 编码钉在脚本自己身上（理由见该文件头注）：否则中文断言名经管道回来是乱码。
. (Join-Path $repoRoot 'ccswitch/lib/console-utf8.ps1')
$targetPs1 = Join-Path $repoRoot 'scripts/dao-merge-cleanup.ps1'
$psExe     = (Get-Command powershell).Source
$workRoot  = Join-Path $env:TEMP ("windsurf-dao-branch-guard-" + (Get-Random))
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

if (-not (Test-Path $targetPs1)) { Write-Host "被测脚本不存在：$targetPs1"; exit 1 }
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Write-Host '找不到 git —— 本套用真 git 跑，不桩它'; exit 1 }
New-Item -ItemType Directory -Force -Path $workRoot | Out-Null

$pass = 0; $fail = 0
function Check([string]$Name, [bool]$Cond, [string]$Detail = '') {
    if ($Cond) { $script:pass++; Write-Host "  PASS  $Name" }
    else { $script:fail++; Write-Host "  FAIL  $Name  ->  $Detail" }
}
function Git0([string[]]$GitArgs) {
    $out = & git @GitArgs
    if ($LASTEXITCODE -ne 0) { throw ("夹具 git 失败（exit $LASTEXITCODE）：git " + ($GitArgs -join ' ')) }
    return $out
}

try {

# ── 夹具：origin.git（裸仓）+ main（RepoPath）+ wt（WorktreePath，检出 feature/x）──
function New-Fixture([string]$Case) {
    $dir = Join-Path $workRoot $Case
    $origin = Join-Path $dir 'origin.git'
    $main = Join-Path $dir 'main'
    $wt = Join-Path $dir 'wt'
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    Git0 @('init', '--quiet', '--bare', $origin) | Out-Null
    Git0 @('init', '--quiet', $main) | Out-Null
    foreach ($kv in @(@('user.email', 'dao@example.invalid'), @('user.name', 'dao-test'), @('commit.gpgsign', 'false'))) {
        Git0 @('-C', $main, 'config', $kv[0], $kv[1]) | Out-Null
    }
    [IO.File]::WriteAllText((Join-Path $main 'README.md'), "seed`n", $utf8NoBom)
    Git0 @('-C', $main, 'add', 'README.md') | Out-Null
    Git0 @('-C', $main, 'commit', '--quiet', '-m', 'seed') | Out-Null
    Git0 @('-C', $main, 'branch', '-M', 'main') | Out-Null
    Git0 @('-C', $main, 'remote', 'add', 'origin', $origin) | Out-Null
    Git0 @('-C', $main, 'push', '--quiet', '-u', 'origin', 'main') | Out-Null
    Git0 @('-C', $main, 'worktree', 'add', '--quiet', '-b', 'feature/x', $wt, 'main') | Out-Null
    foreach ($kv in @(@('user.email', 'dao@example.invalid'), @('user.name', 'dao-test'), @('commit.gpgsign', 'false'))) {
        Git0 @('-C', $wt, 'config', $kv[0], $kv[1]) | Out-Null
    }
    [IO.File]::WriteAllText((Join-Path $wt 'feature.txt'), "feature`n", $utf8NoBom)
    Git0 @('-C', $wt, 'add', 'feature.txt') | Out-Null
    Git0 @('-C', $wt, 'commit', '--quiet', '-m', 'feature work') | Out-Null
    Git0 @('-C', $wt, 'push', '--quiet', '-u', 'origin', 'feature/x') | Out-Null
    return [PSCustomObject]@{ Dir = $dir; Origin = $origin; Main = $main; Wt = $wt; Branch = 'feature/x' }
}

function Invoke-Target($Fixture) {
    $out = & $psExe @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $targetPs1,
        '-WorktreePath', $Fixture.Wt, '-Branch', $Fixture.Branch, '-RepoPath', $Fixture.Main)
    return [PSCustomObject]@{ ExitCode = $LASTEXITCODE; Text = (@($out) -join "`n") }
}

function Test-BranchExists([string]$RepoPath, [string]$Branch) {
    $null = & git -C $RepoPath rev-parse --verify --quiet ('refs/heads/' + $Branch)
    return ($LASTEXITCODE -eq 0)
}
function Test-WorktreeRegistered([string]$RepoPath, [string]$WtPath) {
    $list = & git -C $RepoPath worktree list --porcelain
    $norm = ($WtPath -replace '\\', '/')
    foreach ($line in $list) {
        if ($line -like 'worktree *') {
            if (($line.Substring(9) -replace '\\', '/') -eq $norm) { return $true }
        }
    }
    return $false
}

Write-Host "`n=== ① 正控：分支还没并入主干 ⇒ 必须拒绝删除 ==="
$f1 = New-Fixture 'not-merged'
$r1 = Invoke-Target $f1
Check '退出码 2（差集核验判定不安全）' ($r1.ExitCode -eq 2) "实际 $($r1.ExitCode)`n$($r1.Text)"
Check '本地分支原样还在（没被 -D 掉）' (Test-BranchExists $f1.Main $f1.Branch)
Check 'worktree 登记原样未动' (Test-WorktreeRegistered $f1.Main $f1.Wt)
Check 'worktree 目录本身还在' (Test-Path -LiteralPath $f1.Wt)

Write-Host "`n=== ② 判别力：真的并入了 ⇒ 必须删得掉 ==="
# 没有这一条，把核验改成「恒拒绝」也能让 ① 变绿——那是把功能砸了，不是守住它。
$f2 = New-Fixture 'merged'
Git0 @('-C', $f2.Main, 'merge', '--no-ff', '--quiet', '-m', 'merge feature/x', 'feature/x') | Out-Null
Git0 @('-C', $f2.Main, 'push', '--quiet', 'origin', 'main') | Out-Null
$r2 = Invoke-Target $f2
Check '退出码 0' ($r2.ExitCode -eq 0) "实际 $($r2.ExitCode)`n$($r2.Text)"
Check '本地分支已删除' (-not (Test-BranchExists $f2.Main $f2.Branch))
Check 'worktree 已从登记里清除' (-not (Test-WorktreeRegistered $f2.Main $f2.Wt))

Write-Host "`n=== 汇总: PASS=$pass FAIL=$fail ==="

} finally {
    Remove-Item -Recurse -Force $workRoot -ErrorAction SilentlyContinue
}

if ($fail -gt 0) { exit 1 }
exit 0
