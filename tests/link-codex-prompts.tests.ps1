$ErrorActionPreference = "Stop"

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$DaoScript = Join-Path $RepoRoot "dao.ps1"
$OriginalUserProfile = $env:USERPROFILE
$TmpRoot = Join-Path ([System.IO.Path]::GetTempPath()) "windsurf-dao-link-codex-prompts-test-$(Get-Random)"

function Assert-True {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw "ASSERT FAILED: $Message" }
}

function Assert-Equal {
    param([object]$Expected, [object]$Actual, [string]$Message)
    if ($Expected -ne $Actual) {
        throw "ASSERT FAILED: $Message`nExpected: $Expected`nActual: $Actual"
    }
}

try {
    New-Item -ItemType Directory -Path $TmpRoot -Force | Out-Null
    $env:USERPROFILE = $TmpRoot

    $claudeDir = Join-Path $TmpRoot ".claude"
    New-Item -ItemType Directory -Path (Join-Path $claudeDir "commands") -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $claudeDir "skills") -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $claudeDir "agents") -Force | Out-Null
    "sentinel claude md" | Set-Content -Path (Join-Path $claudeDir "CLAUDE.md") -Encoding UTF8
    '{"sentinel":true}' | Set-Content -Path (Join-Path $claudeDir "settings.json") -Encoding UTF8
    "sentinel agent" | Set-Content -Path (Join-Path $claudeDir "agents\dao-test.md") -Encoding UTF8

    foreach ($name in @("dao-superpowers", "dao-cycle", "dao-dev", "dao-evolve", "dao-commit")) {
        @"
---
description: 测试命令 $name
argument-hint: "[ARG]"
---

# 测试 $name

用户输入：`$ARGUMENTS
"@ | Set-Content -Path (Join-Path $claudeDir "commands\$name.md") -Encoding UTF8
    }

    "low frequency" | Set-Content -Path (Join-Path $claudeDir "commands\dao-thread-tree.md") -Encoding UTF8

    $realConflict = Join-Path $TmpRoot ".codex\prompts\dao-dev.md"
    New-Item -ItemType Directory -Path (Split-Path $realConflict -Parent) -Force | Out-Null
    "do not replace" | Set-Content -Path $realConflict -Encoding UTF8

    $beforeClaudeMd = Get-Content -Path (Join-Path $claudeDir "CLAUDE.md") -Raw
    $beforeSettings = Get-Content -Path (Join-Path $claudeDir "settings.json") -Raw
    $beforeAgent = Get-Content -Path (Join-Path $claudeDir "agents\dao-test.md") -Raw

    & powershell -NoProfile -ExecutionPolicy Bypass -File $DaoScript link-codex-prompts | Out-String | Write-Host
    Assert-Equal 0 $LASTEXITCODE "link-codex-prompts should exit successfully"

    foreach ($name in @("dao-superpowers", "dao-cycle", "dao-evolve", "dao-commit")) {
        $prompt = Join-Path $TmpRoot ".codex\prompts\$name.md"
        Assert-True (Test-Path $prompt) "$name prompt should be written into Codex"
        $item = Get-Item $prompt -Force
        Assert-True ([string]::IsNullOrEmpty($item.LinkType)) "$name prompt should be a real Markdown file because Codex does not list prompt symlinks reliably"
        $text = Get-Content -Path $prompt -Raw
        Assert-True ($text -match '<!--\s*codex-managed:\s*windsurf-dao\s*-->') "$name prompt should carry the managed marker outside frontmatter"
        Assert-True (-not ($text -match '(?s)^---.*?codex-managed:\s*windsurf-dao.*?---')) "$name prompt should not put the managed marker in frontmatter because Codex prompt parsing is strict"
        Assert-True ($text -match "# 测试 $name") "$name prompt should include UTF-8 Claude command content"
        Assert-True ($text -match "用户输入") "$name prompt should preserve Chinese text without mojibake"
        Assert-True (-not ($text -match "杞|鐢|鈥")) "$name prompt should not contain obvious mojibake"
    }

    Assert-Equal "do not replace`r`n" (Get-Content -Path $realConflict -Raw) "real prompt conflict should be preserved"
    Assert-True (-not (Test-Path (Join-Path $TmpRoot ".codex\prompts\dao-thread-tree.md"))) "low-frequency commands should not be linked by default"

    $philosophyPrompt = Join-Path $TmpRoot ".codex\prompts\dao-philosophy.md"
    Assert-True (Test-Path $philosophyPrompt) "dao-philosophy generated prompt should exist"
    $philosophyText = Get-Content -Path $philosophyPrompt -Raw
    Assert-True ($philosophyText -match '<!--\s*codex-managed:\s*windsurf-dao\s*-->') "dao-philosophy prompt should carry the managed marker outside frontmatter"
    Assert-True (-not ($philosophyText -match '(?s)^---.*?codex-managed:\s*windsurf-dao.*?---')) "dao-philosophy prompt should not put the managed marker in frontmatter"
    Assert-True ($philosophyText -match '\$dao-philosophy') "dao-philosophy prompt should invoke the skill"

    Assert-Equal $beforeClaudeMd (Get-Content -Path (Join-Path $claudeDir "CLAUDE.md") -Raw) "link-codex-prompts must not edit Claude CLAUDE.md"
    Assert-Equal $beforeSettings (Get-Content -Path (Join-Path $claudeDir "settings.json") -Raw) "link-codex-prompts must not edit Claude settings"
    Assert-Equal $beforeAgent (Get-Content -Path (Join-Path $claudeDir "agents\dao-test.md") -Raw) "link-codex-prompts must not edit Claude agents"

    & powershell -NoProfile -ExecutionPolicy Bypass -File $DaoScript unlink-codex-prompts | Out-String | Write-Host
    Assert-Equal 0 $LASTEXITCODE "unlink-codex-prompts should exit successfully"

    foreach ($name in @("dao-superpowers", "dao-cycle", "dao-evolve", "dao-commit", "dao-philosophy")) {
        Assert-True (-not (Test-Path (Join-Path $TmpRoot ".codex\prompts\$name.md"))) "$name prompt should be unlinked from Codex"
    }
    Assert-True (Test-Path $realConflict) "unlink-codex-prompts must preserve real prompt files"
    Assert-Equal $beforeClaudeMd (Get-Content -Path (Join-Path $claudeDir "CLAUDE.md") -Raw) "unlink-codex-prompts must not edit Claude CLAUDE.md"

    Write-Host "PASS link-codex-prompts installs high-frequency dao prompts without modifying Claude deployment files" -ForegroundColor Green
} finally {
    $env:USERPROFILE = $OriginalUserProfile
    if (Test-Path $TmpRoot) {
        Remove-Item -LiteralPath $TmpRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}

