$ErrorActionPreference = "Stop"

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$DaoScript = Join-Path $RepoRoot "dao.ps1"
$OriginalUserProfile = $env:USERPROFILE
$TmpRoot = Join-Path ([System.IO.Path]::GetTempPath()) "windsurf-dao-link-codex-test-$(Get-Random)"

function Assert-True {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) {
        throw "ASSERT FAILED: $Message"
    }
}

function Assert-Equal {
    param([object]$Expected, [object]$Actual, [string]$Message)
    if ($Expected -ne $Actual) {
        throw "ASSERT FAILED: $Message`nExpected: $Expected`nActual: $Actual"
    }
}

function New-TestSkill {
    param([string]$Name)
    $skillDir = Join-Path $TmpRoot ".claude\skills\$Name"
    New-Item -ItemType Directory -Path $skillDir -Force | Out-Null
    @"
---
name: $Name
description: Test skill $Name
---

# $Name
"@ | Set-Content -Path (Join-Path $skillDir "SKILL.md") -Encoding UTF8
    return $skillDir
}

try {
    New-Item -ItemType Directory -Path $TmpRoot -Force | Out-Null
    $env:USERPROFILE = $TmpRoot

    $claudeDir = Join-Path $TmpRoot ".claude"
    New-Item -ItemType Directory -Path (Join-Path $claudeDir "skills") -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $claudeDir "commands") -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $claudeDir "agents") -Force | Out-Null
    "sentinel claude md" | Set-Content -Path (Join-Path $claudeDir "CLAUDE.md") -Encoding UTF8
    '{"sentinel":true}' | Set-Content -Path (Join-Path $claudeDir "settings.json") -Encoding UTF8
    "sentinel command" | Set-Content -Path (Join-Path $claudeDir "commands\dao-test.md") -Encoding UTF8
    "sentinel agent" | Set-Content -Path (Join-Path $claudeDir "agents\dao-test.md") -Encoding UTF8

    $alphaSrc = New-TestSkill "alpha-skill"
    $larkSrc = New-TestSkill "lark-sample"
    $conflictSrc = New-TestSkill "real-conflict"

    $realConflict = Join-Path $TmpRoot ".codex\skills\real-conflict"
    New-Item -ItemType Directory -Path $realConflict -Force | Out-Null
    "do not replace" | Set-Content -Path (Join-Path $realConflict "SKILL.md") -Encoding UTF8

    $otherSrc = Join-Path $TmpRoot "other-source"
    New-Item -ItemType Directory -Path $otherSrc -Force | Out-Null
    "other" | Set-Content -Path (Join-Path $otherSrc "SKILL.md") -Encoding UTF8
    $overrideSrc = New-TestSkill "override-skill"
    $overrideLink = Join-Path $TmpRoot ".codex\skills\override-skill"
    New-Item -ItemType Directory -Path (Split-Path $overrideLink -Parent) -Force | Out-Null
    New-Item -ItemType Junction -Path $overrideLink -Target $otherSrc | Out-Null

    $sameTargetFileLinkSrc = New-TestSkill "same-target-file-link"
    $sameTargetFileLink = Join-Path $TmpRoot ".codex\skills\same-target-file-link"
    cmd /c "mklink `"$sameTargetFileLink`" `"$sameTargetFileLinkSrc`"" | Out-Null

    $claudeFileLinkTarget = Join-Path $TmpRoot "claude-file-link-target"
    New-Item -ItemType Directory -Path $claudeFileLinkTarget -Force | Out-Null
    "target" | Set-Content -Path (Join-Path $claudeFileLinkTarget "SKILL.md") -Encoding UTF8
    $claudeFileLink = Join-Path $TmpRoot ".claude\skills\claude-file-link-skill"
    cmd /c "mklink `"$claudeFileLink`" `"$claudeFileLinkTarget`"" | Out-Null

    $beforeClaudeMd = Get-Content -Path (Join-Path $claudeDir "CLAUDE.md") -Raw
    $beforeSettings = Get-Content -Path (Join-Path $claudeDir "settings.json") -Raw
    $beforeCommand = Get-Content -Path (Join-Path $claudeDir "commands\dao-test.md") -Raw
    $beforeAgent = Get-Content -Path (Join-Path $claudeDir "agents\dao-test.md") -Raw

    & powershell -NoProfile -ExecutionPolicy Bypass -File $DaoScript link-codex | Out-String | Write-Host
    Assert-Equal 0 $LASTEXITCODE "link-codex should exit successfully"

    foreach ($case in @(
        @{ Name = "alpha-skill"; Source = $alphaSrc },
        @{ Name = "lark-sample"; Source = $larkSrc },
        @{ Name = "override-skill"; Source = $overrideSrc },
        @{ Name = "same-target-file-link"; Source = $sameTargetFileLinkSrc },
        @{ Name = "claude-file-link-skill"; Source = $claudeFileLinkTarget }
    )) {
        $link = Join-Path $TmpRoot ".codex\skills\$($case.Name)"
        Assert-True (Test-Path $link) "$($case.Name) should be linked into Codex"
        $item = Get-Item $link -Force
        Assert-True ($item.LinkType -in @("SymbolicLink", "Junction")) "$($case.Name) should be a link"
        Assert-True $item.PSIsContainer "$($case.Name) should be a directory link, not a file link to a directory"
        Assert-Equal $case.Source $item.Target "$($case.Name) should point to the Claude skill source"
    }

    $conflictItem = Get-Item $realConflict -Force
    Assert-True ([string]::IsNullOrEmpty($conflictItem.LinkType)) "real Codex skill directory should be preserved"
    Assert-Equal "do not replace`r`n" (Get-Content -Path (Join-Path $realConflict "SKILL.md") -Raw) "real conflict content should remain"
    Assert-True ($conflictItem.FullName -ne $conflictSrc) "real conflict should not be replaced by the Claude skill source"

    Assert-Equal $beforeClaudeMd (Get-Content -Path (Join-Path $claudeDir "CLAUDE.md") -Raw) "link-codex must not edit Claude CLAUDE.md"
    Assert-Equal $beforeSettings (Get-Content -Path (Join-Path $claudeDir "settings.json") -Raw) "link-codex must not edit Claude settings"
    Assert-Equal $beforeCommand (Get-Content -Path (Join-Path $claudeDir "commands\dao-test.md") -Raw) "link-codex must not edit Claude commands"
    Assert-Equal $beforeAgent (Get-Content -Path (Join-Path $claudeDir "agents\dao-test.md") -Raw) "link-codex must not edit Claude agents"

    $repoOnlyDaoSkill = Join-Path $TmpRoot ".codex\skills\dao-boundary-probe"
    Assert-True (-not (Test-Path $repoOnlyDaoSkill)) "link-codex should mirror ~/.ccswitch/skills, not repo-only dao skills"

    & powershell -NoProfile -ExecutionPolicy Bypass -File $DaoScript unlink-codex | Out-String | Write-Host
    Assert-Equal 0 $LASTEXITCODE "unlink-codex should exit successfully"

    foreach ($name in @("alpha-skill", "lark-sample", "override-skill", "same-target-file-link", "claude-file-link-skill")) {
        Assert-True (-not (Test-Path (Join-Path $TmpRoot ".codex\skills\$name"))) "$name should be unlinked from Codex"
    }
    Assert-True (Test-Path $realConflict) "unlink-codex must preserve real Codex skill directories"
    Assert-Equal $beforeClaudeMd (Get-Content -Path (Join-Path $claudeDir "CLAUDE.md") -Raw) "unlink-codex must not edit Claude CLAUDE.md"

    Write-Host "PASS link-codex mirrors Claude skills without modifying Claude deployment files" -ForegroundColor Green
} finally {
    $env:USERPROFILE = $OriginalUserProfile
    if (Test-Path $TmpRoot) {
        Remove-Item -LiteralPath $TmpRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}
