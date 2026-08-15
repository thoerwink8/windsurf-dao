# dao.ps1 link-memory 回归：合并规则 + Junction + 断链自愈
# 跑法：powershell -NoProfile -File tests/dao-link-memory.tests.ps1
# dao-check 会扫到本文件。

$ErrorActionPreference = "Stop"
$Repo = Split-Path -Parent $PSScriptRoot
$Dao = Join-Path $Repo "dao.ps1"
$Sandbox = Join-Path $Repo "_tmp\dao-link-memory"
$pass = 0
$fail = 0

function Check([string]$Name, [bool]$Cond, [string]$Detail = "") {
    if ($Cond) {
        $script:pass++
        Write-Host "  PASS  $Name"
    } else {
        $script:fail++
        $extra = if ($Detail) { "  →  $Detail" } else { "" }
        Write-Host "  FAIL  $Name$extra"
    }
}

function New-Sandbox {
    if (Test-Path -LiteralPath $Sandbox) {
        Get-ChildItem -LiteralPath $Sandbox -Recurse -Force -ErrorAction SilentlyContinue |
            Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint } |
            ForEach-Object { $_.Delete() }
        Remove-Item -LiteralPath $Sandbox -Recurse -Force -ErrorAction SilentlyContinue
    }
    $hostMem = Join-Path $Sandbox "repo\host\memory"
    $local = Join-Path $Sandbox "local-memory"
    New-Item -ItemType Directory -Path $hostMem -Force | Out-Null
    New-Item -ItemType Directory -Path $local -Force | Out-Null
    return @{ HostDir = $hostMem; Local = $local; RepoRoot = (Join-Path $Sandbox "repo") }
}

function Invoke-Dao([string]$Action, [string]$RepoRoot, [string]$LocalMemory, [switch]$DryRun) {
    $argList = "-NoProfile -ExecutionPolicy Bypass -File `"$Dao`" $Action -RepoRoot `"$RepoRoot`" -LocalMemory `"$LocalMemory`""
    if ($DryRun) { $argList += " -DryRun" }
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = (Get-Command powershell.exe).Source
    $psi.Arguments = $argList
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.CreateNoWindow = $true
    $psi.WorkingDirectory = $Repo
    $proc = [Diagnostics.Process]::Start($psi)
    $stdout = $proc.StandardOutput.ReadToEnd()
    $stderr = $proc.StandardError.ReadToEnd()
    $proc.WaitForExit()
    return @{ Code = $proc.ExitCode; Out = $stdout; Err = $stderr }
}

function Get-LinkType([string]$Path) {
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
    if (-not $item) { return $null }
    return $item.LinkType
}

function Get-LinkTarget([string]$Path) {
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
    if (-not $item) { return $null }
    $t = $item.Target
    if ($t -is [array]) { $t = $t[0] }
    if (-not $t) { return $null }
    return [IO.Path]::GetFullPath([string]$t)
}

if (-not (Test-Path -LiteralPath $Dao)) {
    Write-Host "FAIL dao.ps1 missing"
    exit 1
}

# 1. local-only file is copied into host
$s = New-Sandbox
Set-Content -LiteralPath (Join-Path $s.HostDir "MEMORY.md") -Value "host-memory" -Encoding utf8
Set-Content -LiteralPath (Join-Path $s.Local "MEMORY.md") -Value "host-memory" -Encoding utf8
Set-Content -LiteralPath (Join-Path $s.Local "only-local.md") -Value "from-local" -Encoding utf8
$r = Invoke-Dao link $s.RepoRoot $s.Local
Check "local-only copied" (Test-Path (Join-Path $s.HostDir "only-local.md"))
$onlyLocal = Join-Path $s.HostDir "only-local.md"
$onlyBody = if (Test-Path $onlyLocal) { (Get-Content $onlyLocal -Raw).Trim() } else { "<missing>" }
Check "local-only content" ($onlyBody -eq "from-local") $onlyBody
Check "link exit 0 (local-only)" ($r.Code -eq 0) "exit=$($r.Code)"
Check "local is Junction after merge" ((Get-LinkType $s.Local) -eq "Junction")
Check "Junction target is host" ((Get-LinkTarget $s.Local) -eq [IO.Path]::GetFullPath($s.HostDir))

# 2. identical content is not overwritten
$s = New-Sandbox
Set-Content -LiteralPath (Join-Path $s.HostDir "MEMORY.md") -Value "same-body" -Encoding utf8
Set-Content -LiteralPath (Join-Path $s.Local "MEMORY.md") -Value "same-body" -Encoding utf8
(Get-Item (Join-Path $s.HostDir "MEMORY.md")).LastWriteTime = (Get-Date).AddDays(-10)
(Get-Item (Join-Path $s.Local "MEMORY.md")).LastWriteTime = Get-Date
$r = Invoke-Dao link $s.RepoRoot $s.Local
Check "identical content kept" ((Get-Content (Join-Path $s.HostDir "MEMORY.md") -Raw).Trim() -eq "same-body")
Check "identical still Junction" ((Get-LinkType $s.Local) -eq "Junction")

# 3. same name, different content: newer local wins
$s = New-Sandbox
Set-Content -LiteralPath (Join-Path $s.HostDir "MEMORY.md") -Value "old-host" -Encoding utf8
Set-Content -LiteralPath (Join-Path $s.Local "MEMORY.md") -Value "new-local" -Encoding utf8
(Get-Item (Join-Path $s.HostDir "MEMORY.md")).LastWriteTime = (Get-Date).AddDays(-10)
(Get-Item (Join-Path $s.Local "MEMORY.md")).LastWriteTime = Get-Date
$r = Invoke-Dao link $s.RepoRoot $s.Local
Check "newer local wins" ((Get-Content (Join-Path $s.HostDir "MEMORY.md") -Raw).Trim() -eq "new-local")

# 4. same name, different content: newer host wins
$s = New-Sandbox
Set-Content -LiteralPath (Join-Path $s.HostDir "MEMORY.md") -Value "new-host" -Encoding utf8
Set-Content -LiteralPath (Join-Path $s.Local "MEMORY.md") -Value "old-local" -Encoding utf8
(Get-Item (Join-Path $s.HostDir "MEMORY.md")).LastWriteTime = Get-Date
(Get-Item (Join-Path $s.Local "MEMORY.md")).LastWriteTime = (Get-Date).AddDays(-10)
$r = Invoke-Dao link $s.RepoRoot $s.Local
Check "newer host wins" ((Get-Content (Join-Path $s.HostDir "MEMORY.md") -Raw).Trim() -eq "new-host")

# 5. already-correct Junction is a no-op
$s = New-Sandbox
Set-Content -LiteralPath (Join-Path $s.HostDir "MEMORY.md") -Value "keep" -Encoding utf8
Remove-Item -LiteralPath $s.Local -Recurse -Force
New-Item -ItemType Junction -Path $s.Local -Target $s.HostDir | Out-Null
$r = Invoke-Dao link $s.RepoRoot $s.Local
Check "already-ok link exit 0" ($r.Code -eq 0) "exit=$($r.Code)"
Check "already-ok stays Junction" ((Get-LinkType $s.Local) -eq "Junction")
Check "already-ok target unchanged" ((Get-LinkTarget $s.Local) -eq [IO.Path]::GetFullPath($s.HostDir))

# 6. wrong-target Junction: status heals
$s = New-Sandbox
Set-Content -LiteralPath (Join-Path $s.HostDir "MEMORY.md") -Value "canon" -Encoding utf8
$other = Join-Path $Sandbox "other-target"
New-Item -ItemType Directory -Path $other -Force | Out-Null
Set-Content -LiteralPath (Join-Path $other "MEMORY.md") -Value "wrong" -Encoding utf8
Remove-Item -LiteralPath $s.Local -Recurse -Force
New-Item -ItemType Junction -Path $s.Local -Target $other | Out-Null
$r = Invoke-Dao status $s.RepoRoot $s.Local
Check "wrong-target status heals" ((Get-LinkTarget $s.Local) -eq [IO.Path]::GetFullPath($s.HostDir))
Check "wrong-target status exit 0" ($r.Code -eq 0) "exit=$($r.Code)"

# 7. dangling Junction: status heals
$s = New-Sandbox
Set-Content -LiteralPath (Join-Path $s.HostDir "MEMORY.md") -Value "canon" -Encoding utf8
$ghost = Join-Path $Sandbox "ghost-target"
New-Item -ItemType Directory -Path $ghost -Force | Out-Null
Remove-Item -LiteralPath $s.Local -Recurse -Force
New-Item -ItemType Junction -Path $s.Local -Target $ghost | Out-Null
Remove-Item -LiteralPath $ghost -Recurse -Force
$r = Invoke-Dao status $s.RepoRoot $s.Local
Check "broken Junction heals to host" ((Get-LinkTarget $s.Local) -eq [IO.Path]::GetFullPath($s.HostDir))
Check "broken heal exit 0" ($r.Code -eq 0) "exit=$($r.Code)"

# 8. missing local dir: link creates Junction
$s = New-Sandbox
Set-Content -LiteralPath (Join-Path $s.HostDir "MEMORY.md") -Value "canon" -Encoding utf8
Remove-Item -LiteralPath $s.Local -Recurse -Force
$r = Invoke-Dao link $s.RepoRoot $s.Local
Check "missing creates Junction" ((Get-LinkType $s.Local) -eq "Junction")
Check "missing target is host" ((Get-LinkTarget $s.Local) -eq [IO.Path]::GetFullPath($s.HostDir))
Check "missing link exit 0" ($r.Code -eq 0) "exit=$($r.Code)"

# 9. discriminant: missing host source must fail status
$s = New-Sandbox
Remove-Item -LiteralPath $s.HostDir -Recurse -Force
$r = Invoke-Dao status $s.RepoRoot $s.Local
Check "no-source status is red" ($r.Code -ne 0) "exit=$($r.Code) (expected non-zero)"

# 清理悬空链，避免 _tmp 留下死 Junction
if (Test-Path -LiteralPath $Sandbox) {
    Get-ChildItem -LiteralPath $Sandbox -Recurse -Force -ErrorAction SilentlyContinue | Where-Object {
        $_.Attributes -band [IO.FileAttributes]::ReparsePoint
    } | ForEach-Object { $_.Delete() }
    Remove-Item -LiteralPath $Sandbox -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "dao-link-memory: $pass passed, $fail failed"
if ($fail -gt 0) { exit 1 } else { exit 0 }
