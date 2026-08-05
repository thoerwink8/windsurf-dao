$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot '..\ccswitch\lib\console-utf8.ps1')  # pin child-stdout decode to UTF-8 -- see that file (issue #131)

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

    foreach ($name in @("dao-superpowers", "dao-dev", "dao-evolve", "dao-commit")) {
        @"
---
description: 测试命令 $name
argument-hint: "[ARG]"
---

# 测试 $name

用户输入：`$ARGUMENTS
"@ | Set-Content -Path (Join-Path $claudeDir "commands\$name.md") -Encoding UTF8
    }

    $realConflict = Join-Path $TmpRoot ".codex\prompts\dao-dev.md"
    New-Item -ItemType Directory -Path (Split-Path $realConflict -Parent) -Force | Out-Null
    "do not replace" | Set-Content -Path $realConflict -Encoding UTF8

    # ── prune 用的两个 fixture（2026-07-27 加）──────────────────────────────
    # ① 我们写过、但名字已离开 Get-CodexPromptNames（退役残留）⇒ 应被 prune
    # ② 用户自己写的同名类文件，无 managed 标记 ⇒ 绝不能碰
    $retiredManaged = Join-Path $TmpRoot ".codex\prompts\dao-retired-xyz.md"
    @"
---
description: 已退役的 dao prompt
---

<!-- codex-managed: windsurf-dao -->

# 已退役
"@ | Set-Content -Path $retiredManaged -Encoding UTF8
    $userOwned = Join-Path $TmpRoot ".codex\prompts\my-own-prompt.md"
    "user's own prompt, no managed marker" | Set-Content -Path $userOwned -Encoding UTF8

    $beforeClaudeMd = Get-Content -Path (Join-Path $claudeDir "CLAUDE.md") -Raw
    $beforeSettings = Get-Content -Path (Join-Path $claudeDir "settings.json") -Raw
    $beforeAgent = Get-Content -Path (Join-Path $claudeDir "agents\dao-test.md") -Raw

    & powershell -NoProfile -ExecutionPolicy Bypass -File $DaoScript link-codex-prompts | Out-String | Write-Host
    Assert-Equal 0 $LASTEXITCODE "link-codex-prompts should exit successfully"

    foreach ($name in @("dao-superpowers", "dao-commit")) {
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

    # 负控（2026-07-27 加）：夹子的两侧不对称，这一侧此前是空的。
    # 上面那条 dao-thread-tree 验的是「~/.claude/commands 里压根没有这个文件」——
    # 它不区分「不在管理清单」与「文件不存在」两种原因。本条补的是**文件在、但不在
    # Get-CodexPromptNames 里**：fixture 上面确实写了 dao-evolve.md 这个命令文件
    # （该命令 2026-07-27 退役、同批移出管理清单）。若有人把它加回清单、或把清单改成
    # 「扫目录全量镜像」，本条会变红。
    Assert-True (-not (Test-Path (Join-Path $TmpRoot ".codex\prompts\dao-evolve.md"))) "a command file that is NOT in Get-CodexPromptNames must not be mirrored into Codex"

    # prune 双侧（2026-07-27 加，出处：dao-evolve 退役后 ~/.codex/prompts/dao-evolve.md
    # 带着 managed 标记留在本机——link 按清单写、unlink 按清单删，两个方向都不碰
    # 一个已离开清单的名字）：managed 残留必须被清掉，用户自有文件必须原样保留。
    Assert-True (-not (Test-Path $retiredManaged)) "a managed prompt whose name left Get-CodexPromptNames must be pruned"
    Assert-True (Test-Path $userOwned) "a prompt without the managed marker must never be pruned"
    Assert-Equal "user's own prompt, no managed marker`r`n" (Get-Content -Path $userOwned -Raw) "user-owned prompt content must be untouched"

    # fortify2-20260726 D6：dao-philosophy 特判（New-ManagedCodexPrompt 里唯一的生成式条目，
    # 对应的 skill 早已不存在）已从 Get-CodexPromptNames 移除，New-ManagedCodexPrompt 现恒返回
    # $null——本测试原「dao-philosophy generated prompt should exist」一段随之移除，不再有
    # 无 Claude command 源文件也能生成 prompt 的路径需要覆盖。

    Assert-Equal $beforeClaudeMd (Get-Content -Path (Join-Path $claudeDir "CLAUDE.md") -Raw) "link-codex-prompts must not edit Claude CLAUDE.md"
    Assert-Equal $beforeSettings (Get-Content -Path (Join-Path $claudeDir "settings.json") -Raw) "link-codex-prompts must not edit Claude settings"
    Assert-Equal $beforeAgent (Get-Content -Path (Join-Path $claudeDir "agents\dao-test.md") -Raw) "link-codex-prompts must not edit Claude agents"

    & powershell -NoProfile -ExecutionPolicy Bypass -File $DaoScript unlink-codex-prompts | Out-String | Write-Host
    Assert-Equal 0 $LASTEXITCODE "unlink-codex-prompts should exit successfully"

    foreach ($name in @("dao-superpowers", "dao-commit")) {
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

