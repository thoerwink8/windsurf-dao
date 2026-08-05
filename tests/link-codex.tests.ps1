$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot '..\ccswitch\lib\console-utf8.ps1')  # pin child-stdout decode to UTF-8 -- see that file (issue #131)

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$DaoScript = Join-Path $RepoRoot "dao.ps1"
$OriginalUserProfile = $env:USERPROFILE
$TmpRoot = Join-Path ([System.IO.Path]::GetTempPath()) "windsurf-dao-link-codex-test-$(Get-Random)"

# Contract under test (user decision 2026-07-27, strong form):
#   ~/.codex/skills has exactly one writer -- the cc-switch store. dao.ps1 is out of that business.
#     * link-codex   : read-only report. Must not create, delete, repoint or repair ANY entry.
#     * unlink-codex : the only dao.ps1 write action left in that directory, delete-direction only.
#                      Removes links dao itself built (targets inside ~/.claude/skills) and prunes
#                      dangling links (dead target); leaves store links and real files alone.
#
# This file used to assert that link-codex CREATES links. Those assertions were not relaxed to make
# a failing test pass -- the behavior contract itself changed, so the assertions follow it: each
# "should be linked" case became a "must stay exactly as it was" case. The replacement is strictly
# harder to satisfy than what it replaced: a full before/after snapshot (name + link type + target +
# container-ness) must be identical, which fails on creation, deletion, repointing and repair alike.
#
# !! DISK REALITY DIVERGES FROM THE CONTRACT ABOVE -- READ BEFORE "FIXING" ANYTHING (2026-07-27) !!
#   ~/.codex/skills now contains 9 junctions -> D:\frank\windsurf-dao\ccswitch\skills\dao-*.
#   dao.ps1 did NOT create them and its write capability was NOT restored; the contract above and
#   every assertion in this file are untouched. They were placed by hand, ONCE, after the user was
#   explicitly told this conflicts with the single-writer decision recorded above and chose to
#   proceed anyway. Full record -- who, when, told what, chose what, why, plus rollback commands:
#     docs/ops/dao-ecosystem-audit.md  section 8   (this repo; moved here 2026-08-02 from
#     mousse-cli docs/ops/ -- the record was living in a project repo while the thing it
#     describes lives here, which is exactly what section 8.7 booked as an open debt)
#   Do NOT treat those 9 junctions as drift and do NOT "repair" them away. Note that
#   `dao.ps1 unlink-codex` classifies by target and WOULD delete the subset whose targets match
#   ~/.claude/skills entries -- that is a documented, user-typed command, not a silent risk,
#   but it does undo part of this. See section 8.3 for the mechanism.
#
# NOTE: keep this file ASCII-only. It has no UTF-8 BOM (unlike dao.ps1 and
# link-codex-prompts.tests.ps1), so PS 5.1 would decode non-ASCII comments as ANSI and
# corrupt parsing.

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

function Get-CodexEntries {
    $dir = Join-Path $TmpRoot ".codex\skills"
    if (-not (Test-Path $dir)) { return @() }
    return @(Get-ChildItem $dir -Force -ErrorAction SilentlyContinue)
}

function Test-CodexEntry {
    # Name-set membership read from the parent directory listing, so it also works for dangling
    # links (Test-Path on a link with a dead target does not answer "does the entry exist").
    param([string]$Name)
    return (@(Get-CodexEntries | Where-Object { $_.Name -eq $Name }).Count -eq 1)
}

function Get-CodexSnapshot {
    # One line per entry: name | link type | link target | is-container. Sorted for stability.
    $lines = Get-CodexEntries | Sort-Object Name | ForEach-Object {
        $target = if ($_.Target) { @($_.Target)[0] } else { "<none>" }
        $linkType = if ($_.LinkType) { $_.LinkType } else { "<real>" }
        "{0}|{1}|{2}|{3}" -f $_.Name, $linkType, $target, $_.PSIsContainer
    }
    return ($lines -join "`n")
}

try {
    New-Item -ItemType Directory -Path $TmpRoot -Force | Out-Null
    $env:USERPROFILE = $TmpRoot

    $claudeDir = Join-Path $TmpRoot ".claude"
    New-Item -ItemType Directory -Path (Join-Path $claudeDir "skills") -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $claudeDir "commands") -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $claudeDir "agents") -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $TmpRoot ".codex\skills") -Force | Out-Null
    "sentinel claude md" | Set-Content -Path (Join-Path $claudeDir "CLAUDE.md") -Encoding UTF8
    '{"sentinel":true}' | Set-Content -Path (Join-Path $claudeDir "settings.json") -Encoding UTF8
    "sentinel command" | Set-Content -Path (Join-Path $claudeDir "commands\dao-test.md") -Encoding UTF8
    "sentinel agent" | Set-Content -Path (Join-Path $claudeDir "agents\dao-test.md") -Encoding UTF8

    # -- Case group A: names that exist in ~/.claude/skills with NO Codex-side entry.
    # Old contract: link-codex creates them. New contract: they stay absent.
    New-TestSkill "alpha-skill" | Out-Null
    New-TestSkill "lark-sample" | Out-Null

    # -- Case group B: Codex-side entries that the old link-codex would have written over.
    # real-conflict: a real directory (was preserved before, still preserved).
    $conflictSrc = New-TestSkill "real-conflict"
    $realConflict = Join-Path $TmpRoot ".codex\skills\real-conflict"
    New-Item -ItemType Directory -Path $realConflict -Force | Out-Null
    "do not replace" | Set-Content -Path (Join-Path $realConflict "SKILL.md") -Encoding UTF8

    # override-skill: a foreign link pointing outside the cc-switch store. This is the sharpest
    # behavior flip -- the old code overrode it, the weak form still overrode it (only store links
    # got a pass), the strong form must leave it alone because dao.ps1 writes nothing here at all.
    $otherSrc = Join-Path $TmpRoot "other-source"
    New-Item -ItemType Directory -Path $otherSrc -Force | Out-Null
    "other" | Set-Content -Path (Join-Path $otherSrc "SKILL.md") -Encoding UTF8
    New-TestSkill "override-skill" | Out-Null
    $overrideLink = Join-Path $TmpRoot ".codex\skills\override-skill"
    New-Item -ItemType Junction -Path $overrideLink -Target $otherSrc | Out-Null

    # ccswitch-owned: a cc-switch store link with a same-named ~/.claude/skills source.
    $ccSwitchStoreSkill = Join-Path $TmpRoot ".cc-switch\skills\ccswitch-owned"
    New-Item -ItemType Directory -Path $ccSwitchStoreSkill -Force | Out-Null
    "cc-switch store version" | Set-Content -Path (Join-Path $ccSwitchStoreSkill "SKILL.md") -Encoding UTF8
    New-TestSkill "ccswitch-owned" | Out-Null
    $ccSwitchLink = Join-Path $TmpRoot ".codex\skills\ccswitch-owned"
    New-Item -ItemType Junction -Path $ccSwitchLink -Target $ccSwitchStoreSkill | Out-Null

    # same-target-file-link: a FILE symlink pointing at a directory. The old code "repaired" it into
    # a directory link; the strong form must not repair anything either. Doubles as unlink coverage
    # for the non-container removal branch.
    $sameTargetFileLinkSrc = New-TestSkill "same-target-file-link"
    $sameTargetFileLink = Join-Path $TmpRoot ".codex\skills\same-target-file-link"
    cmd /c "mklink `"$sameTargetFileLink`" `"$sameTargetFileLinkSrc`"" | Out-Null

    # -- Case group C: entries that unlink-codex must still clean up.
    # managed-dir-link: exactly what an old link-codex run left behind (junction into ~/.claude/skills).
    $managedDirSrc = New-TestSkill "managed-dir-link"
    $managedDirLink = Join-Path $TmpRoot ".codex\skills\managed-dir-link"
    New-Item -ItemType Junction -Path $managedDirLink -Target $managedDirSrc | Out-Null

    # claude-file-link-skill: ~/.claude/skills entry is itself a file symlink to a directory, and the
    # Codex link points at the resolved directory -- covers unlink-codex's target-resolution path.
    $claudeFileLinkTarget = Join-Path $TmpRoot "claude-file-link-target"
    New-Item -ItemType Directory -Path $claudeFileLinkTarget -Force | Out-Null
    "target" | Set-Content -Path (Join-Path $claudeFileLinkTarget "SKILL.md") -Encoding UTF8
    $claudeFileLink = Join-Path $TmpRoot ".claude\skills\claude-file-link-skill"
    cmd /c "mklink `"$claudeFileLink`" `"$claudeFileLinkTarget`"" | Out-Null
    $claudeFileLinkCodex = Join-Path $TmpRoot ".codex\skills\claude-file-link-skill"
    New-Item -ItemType Junction -Path $claudeFileLinkCodex -Target $claudeFileLinkTarget | Out-Null

    # dangling-link: a grave from an older layout (target no longer exists). unlink-codex prunes it;
    # link-codex must not, because pruning is a write too.
    $deadTarget = Join-Path $TmpRoot "dead-target"
    New-Item -ItemType Directory -Path $deadTarget -Force | Out-Null
    $danglingLink = Join-Path $TmpRoot ".codex\skills\dangling-link"
    New-Item -ItemType Junction -Path $danglingLink -Target $deadTarget | Out-Null
    Remove-Item -LiteralPath $deadTarget -Recurse -Force
    Assert-True (-not (Test-Path -LiteralPath $deadTarget)) "dangling fixture: target must be gone before the run"

    $beforeClaudeMd = Get-Content -Path (Join-Path $claudeDir "CLAUDE.md") -Raw
    $beforeSettings = Get-Content -Path (Join-Path $claudeDir "settings.json") -Raw
    $beforeCommand = Get-Content -Path (Join-Path $claudeDir "commands\dao-test.md") -Raw
    $beforeAgent = Get-Content -Path (Join-Path $claudeDir "agents\dao-test.md") -Raw
    $beforeSnapshot = Get-CodexSnapshot

    # ============================ link-codex: writes nothing ============================
    $linkOutput = & powershell -NoProfile -ExecutionPolicy Bypass -File $DaoScript link-codex | Out-String
    Write-Host $linkOutput
    Assert-Equal 0 $LASTEXITCODE "link-codex should exit successfully"

    $afterSnapshot = Get-CodexSnapshot
    Assert-Equal $beforeSnapshot $afterSnapshot "link-codex must leave ~/.codex/skills identical (name set, link type, target, container-ness)"

    # Per-name assertions on top of the snapshot, so a regression names itself instead of dumping a diff.
    foreach ($absent in @("alpha-skill", "lark-sample")) {
        Assert-True (-not (Test-CodexEntry $absent)) "$absent must NOT be created: dao.ps1 no longer fills names the store lacks"
    }

    $overrideItem = Get-Item $overrideLink -Force
    Assert-Equal $otherSrc (@($overrideItem.Target)[0]) "override-skill must keep pointing at the foreign target: link-codex no longer overrides anything"

    $ccSwitchItem = Get-Item $ccSwitchLink -Force
    Assert-Equal $ccSwitchStoreSkill (@($ccSwitchItem.Target)[0]) "cc-switch store link must be untouched"
    Assert-Equal "cc-switch store version`r`n" (Get-Content -Path (Join-Path $ccSwitchLink "SKILL.md") -Raw) "cc-switch store content should be what Codex sees"

    $fileLinkItem = Get-Item $sameTargetFileLink -Force
    Assert-True (-not $fileLinkItem.PSIsContainer) "same-target-file-link must stay a file link: repairing it into a directory link would be a write"

    Assert-True (Test-CodexEntry "dangling-link") "dangling-link must survive link-codex: pruning is unlink-codex's job, not a read-only report's"

    $conflictItem = Get-Item $realConflict -Force
    Assert-True ([string]::IsNullOrEmpty($conflictItem.LinkType)) "real Codex skill directory should be preserved"
    Assert-Equal "do not replace`r`n" (Get-Content -Path (Join-Path $realConflict "SKILL.md") -Raw) "real conflict content should remain"
    Assert-True ($conflictItem.FullName -ne $conflictSrc) "real conflict should not be replaced by the Claude skill source"

    Assert-Equal $beforeClaudeMd (Get-Content -Path (Join-Path $claudeDir "CLAUDE.md") -Raw) "link-codex must not edit Claude CLAUDE.md"
    Assert-Equal $beforeSettings (Get-Content -Path (Join-Path $claudeDir "settings.json") -Raw) "link-codex must not edit Claude settings"
    Assert-Equal $beforeCommand (Get-Content -Path (Join-Path $claudeDir "commands\dao-test.md") -Raw) "link-codex must not edit Claude commands"
    Assert-Equal $beforeAgent (Get-Content -Path (Join-Path $claudeDir "agents\dao-test.md") -Raw) "link-codex must not edit Claude agents"

    # The action must still explain itself. Falling through to the generic help text (i.e. someone
    # deleted the switch branch) would leave a user typing the documented command with no answer.
    Assert-True ($linkOutput -match "read-only") "link-codex output must state that it is read-only"
    Assert-True ($linkOutput -match "cc-switch") "link-codex output must name the cc-switch store as the writer"

    # ======================= unlink-codex: cleanup capability intact =======================
    & powershell -NoProfile -ExecutionPolicy Bypass -File $DaoScript unlink-codex | Out-String | Write-Host
    Assert-Equal 0 $LASTEXITCODE "unlink-codex should exit successfully"

    foreach ($name in @("managed-dir-link", "same-target-file-link", "claude-file-link-skill")) {
        Assert-True (-not (Test-CodexEntry $name)) "$name should be unlinked from Codex (dao-built link)"
    }
    Assert-True (-not (Test-CodexEntry "dangling-link")) "unlink-codex must prune dangling links (the tool that clears old-generation graves)"

    Assert-True (Test-Path $realConflict) "unlink-codex must preserve real Codex skill directories"
    Assert-True (Test-CodexEntry "ccswitch-owned") "unlink-codex must preserve cc-switch store links"
    Assert-Equal $ccSwitchStoreSkill (@((Get-Item $ccSwitchLink -Force).Target)[0]) "unlink-codex must not repoint cc-switch store links"
    Assert-True (Test-CodexEntry "override-skill") "unlink-codex must preserve foreign links it did not build"
    Assert-Equal $otherSrc (@((Get-Item $overrideLink -Force).Target)[0]) "unlink-codex must not repoint foreign links"
    Assert-Equal $beforeClaudeMd (Get-Content -Path (Join-Path $claudeDir "CLAUDE.md") -Raw) "unlink-codex must not edit Claude CLAUDE.md"

    Write-Host "PASS link-codex reports without writing ~/.codex/skills; unlink-codex still clears dao links and dangling graves" -ForegroundColor Green
} finally {
    $env:USERPROFILE = $OriginalUserProfile
    if (Test-Path $TmpRoot) {
        Remove-Item -LiteralPath $TmpRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}
