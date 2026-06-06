# dao.ps1 — windsurf-dao 工具脚本
#
# Usage:
#   .\dao.ps1 status                          查看状态
#   .\dao.ps1 link-global                     链接 global_rules.md 到 Windsurf 全局配置
#   .\dao.ps1 link-rules <project>            把 dao .windsurf/rules/*.md 全部 symlink 到 <project>/.windsurf/rules
#   .\dao.ps1 link-rules-all [-Root <dir>]    扫 <Root>（默认: dao 父目录）下所有 git/.windsurf 项目，批量 symlink
#                                              -AlwaysOnOnly  仅 link always_on 类（5 个）
#                                              -DryRun        只打印不执行
#
# 部署模式：Sidecar workspace 不再是必需。link-rules-all 后 dao rules 在所有项目都跨载。
# 前提：Windows Developer Mode（symlink 权限）

param(
    [Parameter(Position=0)]
    [string]$Action,

    [Parameter(Position=1)]
    [string]$TargetPath,

    [string]$Root,

    [switch]$AlwaysOnOnly,

    [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$DaoRoot = $PSScriptRoot
$DaoWindsurf = Join-Path $DaoRoot ".windsurf"

# ── 工具函数 ──

function Test-SymlinkSupport {
    $testLink = Join-Path $env:TEMP "dao-test-link-$(Get-Random)"
    $testTarget = Join-Path $env:TEMP "dao-test-target-$(Get-Random)"
    try {
        "" | Set-Content $testTarget
        cmd /c "mklink `"$testLink`" `"$testTarget`"" 2>&1 | Out-Null
        if (Test-Path $testLink) {
            $item = Get-Item $testLink
            if ($item.LinkType -eq "SymbolicLink") {
                Remove-Item $testLink, $testTarget -Force
                $script:SymlinkMethod = "cmd"
                return $true
            }
        }
        New-Item -ItemType SymbolicLink -Path $testLink -Target $testTarget -ErrorAction Stop | Out-Null
        Remove-Item $testLink, $testTarget -Force
        $script:SymlinkMethod = "pwsh"
        return $true
    } catch {
        Remove-Item $testLink -Force -ErrorAction SilentlyContinue
        Remove-Item $testTarget -Force -ErrorAction SilentlyContinue
        return $false
    }
}

function New-Symlink {
    param([string]$Link, [string]$Target)
    $isDirectoryTarget = (Test-Path -LiteralPath $Target -PathType Container)
    if ($script:SymlinkMethod -eq "cmd") {
        $dirFlag = if ($isDirectoryTarget) { "/D " } else { "" }
        cmd /c "mklink $dirFlag`"$Link`" `"$Target`"" | Out-Null
    } else {
        New-Item -ItemType SymbolicLink -Path $Link -Target $Target | Out-Null
    }
}

function Ensure-Dir {
    param([string]$Path)
    if (!(Test-Path $Path)) {
        New-Item -ItemType Directory -Path $Path -Force | Out-Null
    }
}

function Resolve-TargetPath {
    param([string]$Path)
    if (!(Test-Path $Path)) {
        Write-Host "  [error] Path not found: $Path" -ForegroundColor Red
        exit 1
    }
    return (Resolve-Path $Path).Path
}

# ── 核心操作 ──

function Invoke-Status {
    # 源仓库信息
    Write-Host "`n  Source: $DaoRoot" -ForegroundColor Cyan
    $rCount = (Get-ChildItem (Join-Path $DaoWindsurf "rules") -Filter "*.md").Count
    $sCount = (Get-ChildItem (Join-Path $DaoWindsurf "skills") -Directory).Count
    $wCount = (Get-ChildItem (Join-Path $DaoWindsurf "workflows") -Filter "*.md").Count
    $stCount = (Get-ChildItem (Join-Path $DaoWindsurf "stacks") -Filter "*.md" -ErrorAction SilentlyContinue).Count
    Write-Host "  Files: ${rCount} rules, ${sCount} skills, ${wCount} workflows, ${stCount} stacks"

    # 全局链接状态
    $globalPath = Join-Path (Join-Path (Join-Path (Join-Path $env:USERPROFILE ".codeium") "windsurf") "memories") "global_rules.md"
    if (Test-Path $globalPath) {
        $g = Get-Item $globalPath
        $gStatus = if ($g.LinkType -eq "SymbolicLink") { "linked" } else { "copy" }
        $gColor = if ($gStatus -eq "linked") { "Green" } else { "Yellow" }
        Write-Host "  Global: $gStatus" -ForegroundColor $gColor
    } else {
        Write-Host "  Global: not installed (run: dao.ps1 link-global)" -ForegroundColor Red
    }

    Write-Host "`n  Mode: Sidecar workspace (Windsurf)" -ForegroundColor Cyan

    # ── Claude Code 侧部署状态 ──
    $claudeSrc = Join-Path $DaoRoot "claude"
    if (Test-Path $claudeSrc) {
        $cSkills = (Get-ChildItem (Join-Path $claudeSrc "skills") -Directory -ErrorAction SilentlyContinue).Count
        $cCmds = (Get-ChildItem (Join-Path $claudeSrc "commands") -Filter "*.md" -ErrorAction SilentlyContinue).Count
        $cAgents = (Get-ChildItem (Join-Path $claudeSrc "agents") -Filter "*.md" -ErrorAction SilentlyContinue).Count
        Write-Host "`n  Claude Code source: ${cSkills} skills, ${cCmds} commands, ${cAgents} agents" -ForegroundColor Cyan

        $userClaude = Join-Path $env:USERPROFILE ".claude"
        $linkedSkills = (Get-ChildItem (Join-Path $userClaude "skills") -ErrorAction SilentlyContinue | Where-Object { $_.Name -like "dao-*" -and $_.LinkType -eq "SymbolicLink" }).Count
        $userClaudeMd = Join-Path $userClaude "CLAUDE.md"
        $importOk = (Test-Path $userClaudeMd) -and ((Get-Content $userClaudeMd -Raw -ErrorAction SilentlyContinue) -match "claude/dao.md")

        if ($linkedSkills -gt 0 -and $importOk) {
            Write-Host "  Claude Code deploy: linked ($linkedSkills dao skills) + dao.md @import OK" -ForegroundColor Green
        } elseif ($linkedSkills -gt 0 -or $importOk) {
            Write-Host "  Claude Code deploy: partial (run: dao.ps1 link-claude)" -ForegroundColor Yellow
        } else {
            Write-Host "  Claude Code deploy: not installed (run: dao.ps1 link-claude)" -ForegroundColor Red
        }

        # ── Codex 侧部署状态(镜像 ~/.claude/skills 源)──
        $userCodex = Join-Path $env:USERPROFILE ".codex"
        $codexSkillsDir = Join-Path $userCodex "skills"
        $userClaudeSkillsDir = Join-Path $userClaude "skills"
        $repoClaudeSkillsDir = Join-Path $claudeSrc "skills"
        $codexLinked = (Get-ChildItem $codexSkillsDir -ErrorAction SilentlyContinue | Where-Object {
            ($_.LinkType -in "SymbolicLink", "Junction") -and ($_.Target -like "$userClaudeSkillsDir*" -or $_.Target -like "$repoClaudeSkillsDir*")
        }).Count
        if ($codexLinked -gt 0) {
            Write-Host "  Codex deploy: linked ($codexLinked Claude user skills)" -ForegroundColor Green
        } else {
            Write-Host "  Codex deploy: not installed (run: dao.ps1 link-codex)" -ForegroundColor Red
        }
    }
}

function Find-DaoProjects {
    # 扫 $Root 下两层深的 git 仓库 / .windsurf 项目（跳过 windsurf-dao 自身、node_modules 等噪音）
    param([string]$ScanRoot, [int]$MaxDepth = 2)

    $exclude = @('node_modules', '_tmp', '.tmp', 'dist', 'build', '.git', '.windsurf',
                 '.dao-autopilot', '.superpowers', '.worktrees', '.playwright-mcp', '.turbo',
                 '.codeium', '.cache')

    $projects = New-Object System.Collections.ArrayList
    $stack = New-Object System.Collections.Stack
    $stack.Push(@{ Path = $ScanRoot; Depth = 0 })

    while ($stack.Count -gt 0) {
        $item = $stack.Pop()
        $dir = $item.Path
        $depth = $item.Depth

        $name = Split-Path $dir -Leaf
        if ($name -in $exclude) { continue }
        if ($depth -gt $MaxDepth) { continue }

        # 跳过 dao 自身（它是 source）
        if ((Resolve-Path -LiteralPath $dir -ErrorAction SilentlyContinue).Path -eq $DaoRoot) { continue }

        # 判定：
        #   有 .git → 明确是 git 项目，加入并止步（避免 monorepo 内部 .git 误报）
        #   只有 .windsurf 没 .git → 可能是 group dir（如 d:\frank\道），加入也继续深入找子项目
        #   都没有 → 继续深入
        $hasGit = Test-Path (Join-Path $dir ".git")
        $hasWindsurf = Test-Path (Join-Path $dir ".windsurf")

        if ($hasGit) {
            [void]$projects.Add($dir)
            continue
        }
        if ($hasWindsurf) {
            [void]$projects.Add($dir)
            # 不 continue，继续深入
        }

        # 递归子目录
        try {
            Get-ChildItem -LiteralPath $dir -Directory -Force -ErrorAction SilentlyContinue | ForEach-Object {
                $stack.Push(@{ Path = $_.FullName; Depth = $depth + 1 })
            }
        } catch {}
    }

    return @($projects)
}

function Invoke-LinkRules {
    # 把 dao .windsurf/rules/*.md（默认全部 13 个，可 -AlwaysOnOnly）symlink 到 <project>/.windsurf/rules
    param([string]$ProjectPath, [bool]$OnlyAlwaysOn = $false, [bool]$IsDryRun = $false)

    $proj = Resolve-TargetPath $ProjectPath
    Write-Host "  [project] $proj" -ForegroundColor Cyan

    $targetRulesDir = Join-Path $proj ".windsurf\rules"
    if (-not $IsDryRun) { Ensure-Dir $targetRulesDir }

    $sourceRulesDir = Join-Path $DaoWindsurf "rules"
    $sourceFiles = Get-ChildItem $sourceRulesDir -Filter "*.md" | Where-Object { $_.Name -ne "README.md" }
    if ($OnlyAlwaysOn) {
        $sourceFiles = $sourceFiles | Where-Object {
            $head = Get-Content $_.FullName -TotalCount 5 -ErrorAction SilentlyContinue | Out-String
            $head -match 'trigger:\s*always_on'
        }
    }

    $linked = 0; $skipped = 0; $conflict = 0; $err = 0
    foreach ($f in $sourceFiles) {
        $linkPath = Join-Path $targetRulesDir $f.Name
        $shortName = $f.Name

        if (Test-Path $linkPath) {
            $existing = Get-Item $linkPath -Force
            if ($existing.LinkType -eq "SymbolicLink") {
                $currentTarget = $existing.Target
                if ($currentTarget -eq $f.FullName -or $currentTarget -eq $f.Name) {
                    Write-Host "    [skip ] $shortName  (already linked)" -ForegroundColor DarkGray
                    $skipped++
                } else {
                    Write-Host "    [diff ] $shortName  symlink -> $currentTarget" -ForegroundColor Yellow
                    $conflict++
                }
            } else {
                Write-Host "    [keep ] $shortName  (project's own file, preserved)" -ForegroundColor Yellow
                $conflict++
            }
            continue
        }

        if ($IsDryRun) {
            Write-Host "    [DRYRUN] $shortName  -> $($f.FullName)" -ForegroundColor Cyan
            $linked++
        } else {
            try {
                New-Symlink -Link $linkPath -Target $f.FullName
                Write-Host "    [link ] $shortName" -ForegroundColor Green
                $linked++
            } catch {
                Write-Host "    [error] $shortName : $_" -ForegroundColor Red
                $err++
            }
        }
    }
    Write-Host "    summary: linked=$linked skipped=$skipped conflict=$conflict error=$err" -ForegroundColor Cyan
    Write-Host ""
    return @{ Linked = $linked; Skipped = $skipped; Conflict = $conflict; Error = $err }
}

function Invoke-LinkRulesAll {
    # 扫 $ScanRoot 下所有项目，逐一 Invoke-LinkRules
    param([string]$ScanRoot, [bool]$OnlyAlwaysOn = $false, [bool]$IsDryRun = $false)

    if (-not $ScanRoot) {
        $ScanRoot = Split-Path $DaoRoot -Parent  # 默认: dao 的父目录（如 d:\frank）
    }
    $ScanRoot = (Resolve-Path $ScanRoot).Path

    Write-Host "`n  scan root: $ScanRoot" -ForegroundColor Cyan
    $projects = Find-DaoProjects -ScanRoot $ScanRoot
    Write-Host "  found $($projects.Count) project(s):" -ForegroundColor Cyan
    foreach ($p in $projects) {
        Write-Host "    - $((Split-Path $p -Parent | Split-Path -Leaf))\$(Split-Path $p -Leaf)"
    }
    Write-Host ""

    $total = @{ Linked = 0; Skipped = 0; Conflict = 0; Error = 0 }
    foreach ($p in $projects) {
        $r = Invoke-LinkRules -ProjectPath $p -OnlyAlwaysOn $OnlyAlwaysOn -IsDryRun $IsDryRun
        $total.Linked += $r.Linked
        $total.Skipped += $r.Skipped
        $total.Conflict += $r.Conflict
        $total.Error += $r.Error
    }

    Write-Host "  ============================================" -ForegroundColor Cyan
    Write-Host "  ALL DONE: $($projects.Count) project(s) processed" -ForegroundColor Cyan
    Write-Host "  total: linked=$($total.Linked) skipped=$($total.Skipped) conflict=$($total.Conflict) error=$($total.Error)" -ForegroundColor Cyan
    if ($total.Conflict -gt 0) {
        Write-Host "  note: 'conflict' = project has its own file/symlink with same name. Not overwritten." -ForegroundColor Yellow
    }
}

function Invoke-LinkClaude {
    # 把 claude/{skills,commands,agents} 下的 dao-* 项 symlink 到 ~/.claude，
    # 复制 references/*.md 经文到 ~/.claude/references/，
    # 并幂等追加 dao.md 的 @import 到 ~/.claude/CLAUDE.md。
    # 这是 Claude Code 侧的部署入口（对应 Windsurf 侧 link-rules-all + link-global）。
    param([bool]$IsDryRun = $false)

    $claudeSrc = Join-Path $DaoRoot "claude"
    if (!(Test-Path $claudeSrc)) {
        Write-Host "  [error] claude/ source not found: $claudeSrc" -ForegroundColor Red
        exit 1
    }

    $userClaude = Join-Path $env:USERPROFILE ".claude"
    Ensure-Dir $userClaude

    $linked = 0; $skipped = 0; $conflict = 0; $err = 0

    # ── 三类目录 symlink（skills/agents 链目录，commands 链文件）──
    $specs = @(
        @{ Name = "skills";   Kind = "dir";  Filter = "dao-*" },
        @{ Name = "commands"; Kind = "file"; Filter = "dao-*.md" },
        @{ Name = "agents";   Kind = "file"; Filter = "dao-*.md" }
    )
    foreach ($spec in $specs) {
        $srcDir = Join-Path $claudeSrc $spec.Name
        if (!(Test-Path $srcDir)) { continue }
        $dstDir = Join-Path $userClaude $spec.Name
        if (-not $IsDryRun) { Ensure-Dir $dstDir }

        Write-Host "  [$($spec.Name)]" -ForegroundColor Cyan
        $items = if ($spec.Kind -eq "dir") {
            Get-ChildItem $srcDir -Directory -Filter $spec.Filter -ErrorAction SilentlyContinue
        } else {
            Get-ChildItem $srcDir -File -Filter $spec.Filter -ErrorAction SilentlyContinue
        }

        foreach ($it in $items) {
            $linkPath = Join-Path $dstDir $it.Name
            if (Test-Path $linkPath) {
                $existing = Get-Item $linkPath -Force
                if ($existing.LinkType -eq "SymbolicLink") {
                    if ($existing.Target -eq $it.FullName) {
                        Write-Host "    [skip ] $($it.Name)  (already linked)" -ForegroundColor DarkGray
                        $skipped++
                    } else {
                        Write-Host "    [diff ] $($it.Name)  -> $($existing.Target)" -ForegroundColor Yellow
                        $conflict++
                    }
                } else {
                    Write-Host "    [keep ] $($it.Name)  (real file, preserved)" -ForegroundColor Yellow
                    $conflict++
                }
                continue
            }
            if ($IsDryRun) {
                Write-Host "    [DRYRUN] $($it.Name)  -> $($it.FullName)" -ForegroundColor Cyan
                $linked++
            } else {
                try {
                    New-Symlink -Link $linkPath -Target $it.FullName
                    Write-Host "    [link ] $($it.Name)" -ForegroundColor Green
                    $linked++
                } catch {
                    Write-Host "    [error] $($it.Name) : $_" -ForegroundColor Red
                    $err++
                }
            }
        }
    }

    # ── settings.json 路径(后续 outputStyle / hook / 通用配置固化共用,提前定义避免未赋值引用)──
    $settingsPath = Join-Path $userClaude "settings.json"

    # ── 复制 references/ 经文到 ~/.claude/references/ ──
    $refSrc = Join-Path $DaoRoot "references"
    if (Test-Path $refSrc) {
        $refDst = Join-Path $userClaude "references"
        if (-not $IsDryRun) { Ensure-Dir $refDst }
        Write-Host "  [references]" -ForegroundColor Cyan
        $refFiles = Get-ChildItem $refSrc -File -Filter "*.md" -ErrorAction SilentlyContinue
        foreach ($ref in $refFiles) {
            $dstFile = Join-Path $refDst $ref.Name
            if (Test-Path $dstFile) {
                # 对比文件内容，如果不同则更新
                $srcHash = (Get-FileHash $ref.FullName -Algorithm MD5).Hash
                $dstHash = (Get-FileHash $dstFile -Algorithm MD5).Hash
                if ($srcHash -eq $dstHash) {
                    Write-Host "    [skip ] $($ref.Name)  (same content)" -ForegroundColor DarkGray
                    $skipped++
                } else {
                    if ($IsDryRun) {
                        Write-Host "    [DRYRUN] update $($ref.Name)" -ForegroundColor Cyan
                        $linked++
                    } else {
                        Copy-Item $ref.FullName -Destination $dstFile -Force
                        Write-Host "    [update] $($ref.Name)" -ForegroundColor Yellow
                        $linked++
                    }
                }
            } else {
                if ($IsDryRun) {
                    Write-Host "    [DRYRUN] copy $($ref.Name)" -ForegroundColor Cyan
                    $linked++
                } else {
                    Copy-Item $ref.FullName -Destination $dstFile
                    Write-Host "    [copy ] $($ref.Name)" -ForegroundColor Green
                    $linked++
                }
            }
        }
    }

    # ── 复制 styles/ 到 ~/.claude/styles/ ──
    $stylesSrc = Join-Path $claudeSrc "styles"
    if (Test-Path $stylesSrc) {
        $stylesDst = Join-Path $userClaude "styles"
        if (-not $IsDryRun) { Ensure-Dir $stylesDst }
        Write-Host "  [styles]" -ForegroundColor Cyan
        $styleFiles = Get-ChildItem $stylesSrc -File -Filter "*.md" -ErrorAction SilentlyContinue
        foreach ($style in $styleFiles) {
            $dstFile = Join-Path $stylesDst $style.Name
            if (Test-Path $dstFile) {
                $srcHash = (Get-FileHash $style.FullName -Algorithm MD5).Hash
                $dstHash = (Get-FileHash $dstFile -Algorithm MD5).Hash
                if ($srcHash -eq $dstHash) {
                    Write-Host "    [skip ] $($style.Name)  (same content)" -ForegroundColor DarkGray
                    $skipped++
                } else {
                    if ($IsDryRun) {
                        Write-Host "    [DRYRUN] update $($style.Name)" -ForegroundColor Cyan
                        $linked++
                    } else {
                        Copy-Item $style.FullName -Destination $dstFile -Force
                        Write-Host "    [update] $($style.Name)" -ForegroundColor Yellow
                        $linked++
                    }
                }
            } else {
                if ($IsDryRun) {
                    Write-Host "    [DRYRUN] copy $($style.Name)" -ForegroundColor Cyan
                    $linked++
                } else {
                    Copy-Item $style.FullName -Destination $dstFile
                    Write-Host "    [copy ] $($style.Name)" -ForegroundColor Green
                    $linked++
                }
            }
        }
    }

    # ── 幂等设置 outputStyle 到 ~/.claude/settings.json ──
    if (Test-Path $settingsPath) {
        Write-Host "  [outputStyle]" -ForegroundColor Cyan
        $sraw = Get-Content $settingsPath -Raw -ErrorAction SilentlyContinue
        $hasOutputStyle = $false
        if ($sraw -match '"outputStyle"\s*:\s*"dao-field"') { $hasOutputStyle = $true }
        if ($hasOutputStyle) {
            Write-Host "    [skip ] outputStyle already set to dao-field" -ForegroundColor DarkGray
            $skipped++
        } elseif ($IsDryRun) {
            Write-Host "    [DRYRUN] set outputStyle: dao-field" -ForegroundColor Cyan
            $linked++
        } else {
            try {
                $settings = $sraw | ConvertFrom-Json
                $settings | Add-Member -NotePropertyName outputStyle -NotePropertyValue "dao-field" -Force
                $settings | ConvertTo-Json -Depth 20 | Set-Content $settingsPath -Encoding UTF8
                Write-Host "    [set  ] outputStyle: dao-field" -ForegroundColor Green
                $linked++
            } catch {
                Write-Host "    [error] outputStyle set failed: $_" -ForegroundColor Red
                $err++
            }
        }
    }

    # ── 幂等追加 dao.md 的 @import 到 ~/.claude/CLAUDE.md ──
    $daoMd = Join-Path $claudeSrc "dao.md"
    $userClaudeMd = Join-Path $userClaude "CLAUDE.md"
    $importLine = "@$($daoMd -replace '\\', '/')"

    if (Test-Path $daoMd) {
        Write-Host "  [import]" -ForegroundColor Cyan
        $hasImport = $false
        if (Test-Path $userClaudeMd) {
            $content = Get-Content $userClaudeMd -Raw -ErrorAction SilentlyContinue
            if ($content -match [regex]::Escape("claude/dao.md")) { $hasImport = $true }
        }
        if ($hasImport) {
            Write-Host "    [skip ] dao.md @import already present" -ForegroundColor DarkGray
            $skipped++
        } elseif ($IsDryRun) {
            Write-Host "    [DRYRUN] append: $importLine" -ForegroundColor Cyan
            $linked++
        } else {
            $block = "`n# windsurf-dao Tao field (always_on root, single source of truth)`n$importLine`n"
            Add-Content -Path $userClaudeMd -Value $block -Encoding UTF8
            Write-Host "    [add  ] $importLine" -ForegroundColor Green
            $linked++
        }
    }

    # ── 幂等注册 dao-glob-gate PostToolUse hook 到 ~/.claude/settings.json ──
    # 补 Windsurf glob trigger 缺口:编辑代码/dao 文件后注入 dao-quality / dao-meta 提醒
    $hookScript = (Join-Path (Join-Path $claudeSrc "hooks") "dao-glob-gate.js") -replace '\\', '/'
    if (Test-Path $hookScript) {
        Write-Host "  [hook]" -ForegroundColor Cyan
        $hookCmd = "node `"$hookScript`""
        $alreadyHooked = $false
        if (Test-Path $settingsPath) {
            $sraw = Get-Content $settingsPath -Raw -ErrorAction SilentlyContinue
            if ($sraw -match [regex]::Escape("dao-glob-gate.js")) { $alreadyHooked = $true }
        }
        if ($alreadyHooked) {
            Write-Host "    [skip ] dao-glob-gate hook already registered" -ForegroundColor DarkGray
            $skipped++
        } elseif ($IsDryRun) {
            Write-Host "    [DRYRUN] register PostToolUse hook -> $hookScript" -ForegroundColor Cyan
            $linked++
        } else {
            try {
                if (Test-Path $settingsPath) {
                    $settings = Get-Content $settingsPath -Raw | ConvertFrom-Json
                } else {
                    $settings = [PSCustomObject]@{}
                }
                $hookEntry = [PSCustomObject]@{
                    matcher = "Edit|Write|MultiEdit"
                    hooks   = @([PSCustomObject]@{ type = "command"; command = $hookCmd; timeout = 10 })
                }
                if (-not $settings.PSObject.Properties['hooks']) {
                    $settings | Add-Member -NotePropertyName hooks -NotePropertyValue ([PSCustomObject]@{})
                }
                if (-not $settings.hooks.PSObject.Properties['PostToolUse']) {
                    $settings.hooks | Add-Member -NotePropertyName PostToolUse -NotePropertyValue @()
                }
                $settings.hooks.PostToolUse = @($settings.hooks.PostToolUse) + $hookEntry
                $settings | ConvertTo-Json -Depth 20 | Set-Content $settingsPath -Encoding UTF8
                Write-Host "    [add  ] PostToolUse hook -> dao-glob-gate.js" -ForegroundColor Green
                $linked++
            } catch {
                Write-Host "    [error] hook register failed: $_" -ForegroundColor Red
                $err++
            }
        }
    }

    # ── 幂等注册 dao-cn-title UserPromptSubmit hook 到 ~/.claude/settings.json ──
    # 会话标题中文化:发首条消息时调 Claude 生成简体中文短标题,经 hookSpecificOutput.sessionTitle 注入
    $titleHookScript = (Join-Path (Join-Path $claudeSrc "hooks") "dao-cn-title.js") -replace '\\', '/'
    if (Test-Path $titleHookScript) {
        $titleHookCmd = "node `"$titleHookScript`""
        $titleHooked = $false
        if (Test-Path $settingsPath) {
            $sraw2 = Get-Content $settingsPath -Raw -ErrorAction SilentlyContinue
            if ($sraw2 -match [regex]::Escape("dao-cn-title.js")) { $titleHooked = $true }
        }
        if ($titleHooked) {
            Write-Host "    [skip ] dao-cn-title hook already registered" -ForegroundColor DarkGray
            $skipped++
        } elseif ($IsDryRun) {
            Write-Host "    [DRYRUN] register UserPromptSubmit hook -> $titleHookScript" -ForegroundColor Cyan
            $linked++
        } else {
            try {
                if (Test-Path $settingsPath) {
                    $settings = Get-Content $settingsPath -Raw | ConvertFrom-Json
                } else {
                    $settings = [PSCustomObject]@{}
                }
                $titleHookEntry = [PSCustomObject]@{
                    hooks = @([PSCustomObject]@{ type = "command"; command = $titleHookCmd; timeout = 12 })
                }
                if (-not $settings.PSObject.Properties['hooks']) {
                    $settings | Add-Member -NotePropertyName hooks -NotePropertyValue ([PSCustomObject]@{})
                }
                if (-not $settings.hooks.PSObject.Properties['UserPromptSubmit']) {
                    $settings.hooks | Add-Member -NotePropertyName UserPromptSubmit -NotePropertyValue @()
                }
                $settings.hooks.UserPromptSubmit = @($settings.hooks.UserPromptSubmit) + $titleHookEntry
                $settings | ConvertTo-Json -Depth 20 | Set-Content $settingsPath -Encoding UTF8
                Write-Host "    [add  ] UserPromptSubmit hook -> dao-cn-title.js" -ForegroundColor Green
                $linked++
            } catch {
                Write-Host "    [error] title hook register failed: $_" -ForegroundColor Red
                $err++
            }
        }
    }

    # ── 通用配置固化:以 claude/settings.base.json 为真相源,幂等合并回 settings.json ──
    # env 段子键合并(护住 cc-switch 注入的 token/base_url/模型),其余顶层键基线强制覆盖。
    # 这一步会顺带补齐 SessionStart 自愈 hook(base.json 已声明),实现每次启动 CC 自动复原。
    $syncScript = (Join-Path (Join-Path $claudeSrc "hooks") "dao-settings-sync.js")
    $baseSettings = Join-Path $claudeSrc "settings.base.json"
    if ((Test-Path $syncScript) -and (Test-Path $baseSettings)) {
        Write-Host "  [settings-base]" -ForegroundColor Cyan
        if ($IsDryRun) {
            Write-Host "    [DRYRUN] merge settings.base.json -> settings.json (env 保留凭证, 通用键强制覆盖)" -ForegroundColor Cyan
            $linked++
        } else {
            try {
                & node $syncScript $baseSettings $settingsPath 2>&1 | Out-Null
                if ($LASTEXITCODE -eq 0) {
                    Write-Host "    [sync ] 通用配置已对齐基线 (token/base_url 保留)" -ForegroundColor Green
                    $linked++
                } else {
                    Write-Host "    [error] settings sync exited $LASTEXITCODE" -ForegroundColor Red
                    $err++
                }
            } catch {
                Write-Host "    [error] settings sync failed: $_" -ForegroundColor Red
                $err++
            }
        }
    }

    # ── 第二层兜底:Windows 登录计划任务,每次登录静默重建通用配置 ──
    # 应对升级把整个 settings.json 删光(连 SessionStart hook 一起没)的极端场景:
    # 登录任务独立于 settings.json 存在,开机即把通用配置 + hook 一起重建,闭合自举缺口。
    $taskName = "dao-settings-sync"
    if (Test-Path $syncScript) {
        Write-Host "  [logon-task]" -ForegroundColor Cyan
        $nodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source
        if (-not $nodeExe) {
            Write-Host "    [skip ] node not found on PATH, 跳过登录任务注册" -ForegroundColor DarkGray
            $skipped++
        } elseif ($IsDryRun) {
            Write-Host "    [DRYRUN] register logon scheduled task '$taskName'" -ForegroundColor Cyan
            $linked++
        } else {
            try {
                $existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
                if ($existing) {
                    Write-Host "    [skip ] logon task '$taskName' already registered" -ForegroundColor DarkGray
                    $skipped++
                } else {
                    $taskArg = "`"$syncScript`" `"$baseSettings`" `"$settingsPath`""
                    $action = New-ScheduledTaskAction -Execute $nodeExe -Argument $taskArg
                    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
                    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
                    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Description "dao: 登录时把 claude/settings.base.json 通用配置幂等合并回 ~/.claude/settings.json(护住 cc-switch 凭证)" -Force | Out-Null
                    Write-Host "    [add  ] logon task '$taskName' -> node dao-settings-sync.js" -ForegroundColor Green
                    $linked++
                }
            } catch {
                # 登录任务触发器在部分机器(组策略/非管理员)会"拒绝访问"。
                # 这是预期内的环境约束,非脚本错误:第一层 SessionStart hook 已覆盖
                # 升级/重启/cc-switch 冲突等绝大多数场景。降级为提示,不计 error。
                Write-Host "    [skip ] 登录任务需管理员权限,跳过(第一层 SessionStart hook 已生效)" -ForegroundColor DarkGray
                Write-Host "           如需第二层兜底:以管理员身份跑一次 .\dao.ps1 link-claude" -ForegroundColor DarkGray
                $skipped++
            }
        }
    }

    Write-Host ""
    Write-Host "  summary: linked=$linked skipped=$skipped conflict=$conflict error=$err" -ForegroundColor Cyan
    Write-Host "  Claude Code: restart session (or /clear) to pick up new skills/commands/agents." -ForegroundColor DarkGray
}

function Invoke-LinkCodex {
    # 把 ~/.claude/skills 下的 Claude 用户侧 skill 镜像到 ~/.codex/skills。
    # codex 侧不需要 commands/agents/hooks/@import；commands 单独由 link-codex-prompts 生成 prompt。
    # 撞名处理:若已存在的同名是指向别处(如 cc-switch)的软链,按 Claude 用户侧单源原则覆盖;
    #          若是用户真实文件,保留不动。
    param([bool]$IsDryRun = $false)

    $userClaude = Join-Path $env:USERPROFILE ".claude"
    $srcDir = Join-Path $userClaude "skills"
    if (!(Test-Path $srcDir)) {
        Write-Host "  [error] ~/.claude/skills source not found: $srcDir" -ForegroundColor Red
        exit 1
    }

    $userCodex = Join-Path $env:USERPROFILE ".codex"
    $dstDir = Join-Path $userCodex "skills"
    if (-not $IsDryRun) { Ensure-Dir $dstDir }

    $linked = 0; $skipped = 0; $conflict = 0; $err = 0
    Write-Host "  [~/.claude/skills -> ~/.codex/skills]" -ForegroundColor Cyan

    $items = Get-ChildItem $srcDir -Force -ErrorAction SilentlyContinue | Where-Object {
        $_.PSIsContainer -or (Test-Path (Join-Path $_.FullName "SKILL.md") -PathType Leaf)
    }
    foreach ($it in $items) {
        $linkPath = Join-Path $dstDir $it.Name
        $skillTarget = $it.FullName
        if (($it.LinkType -in "SymbolicLink", "Junction") -and $it.Target) {
            $targetPath = @($it.Target)[0]
            if (Test-Path -LiteralPath $targetPath -PathType Container) {
                $skillTarget = $targetPath
            }
        }
        if (Test-Path $linkPath) {
            $existing = Get-Item $linkPath -Force
            if ($existing.LinkType -in "SymbolicLink", "Junction") {
                if ($existing.Target -eq $skillTarget -and $existing.PSIsContainer) {
                    Write-Host "    [skip ] $($it.Name)  (already linked)" -ForegroundColor DarkGray
                    $skipped++
                    continue
                }
                # 指向别处的软链/联接(如 cc-switch 外部版):覆盖为 Claude 用户侧源
                if ($IsDryRun) {
                    Write-Host "    [DRYRUN] override $($it.Name)  (was $($existing.LinkType) -> $($existing.Target))" -ForegroundColor Yellow
                    $linked++
                    continue
                }
                try {
                    $oldLinkType = $existing.LinkType
                    $oldTarget = $existing.Target
                    if ($existing.PSIsContainer) { $existing.Delete() } else { Remove-Item $linkPath -Force }
                    New-Symlink -Link $linkPath -Target $skillTarget
                    Write-Host "    [override] $($it.Name)  (was $oldLinkType -> $oldTarget)" -ForegroundColor Yellow
                    $linked++
                } catch {
                    Write-Host "    [error] $($it.Name) : $_" -ForegroundColor Red
                    $err++
                }
                continue
            }
            # 用户真实文件/目录:不动
            Write-Host "    [keep ] $($it.Name)  (real file, preserved)" -ForegroundColor Yellow
            $conflict++
            continue
        }
        if ($IsDryRun) {
            Write-Host "    [DRYRUN] $($it.Name)  -> $skillTarget" -ForegroundColor Cyan
            $linked++
        } else {
            try {
                New-Symlink -Link $linkPath -Target $skillTarget
                Write-Host "    [link ] $($it.Name)" -ForegroundColor Green
                $linked++
            } catch {
                Write-Host "    [error] $($it.Name) : $_" -ForegroundColor Red
                $err++
            }
        }
    }

    Write-Host ""
    Write-Host "  summary: linked=$linked skipped=$skipped conflict=$conflict error=$err" -ForegroundColor Cyan
    Write-Host "  Codex: restart session to pick up new skills. Source is ~/.claude/skills; Claude deployment files are untouched." -ForegroundColor DarkGray
}

function Invoke-UnlinkCodex {
    # 卸载 codex 侧 Claude skill 软链。只删指向 ~/.claude/skills 管理源的软链,不碰用户真实文件。
    param([bool]$IsDryRun = $false)

    $userClaude = Join-Path $env:USERPROFILE ".claude"
    $srcDir = Join-Path $userClaude "skills"
    $userCodex = Join-Path $env:USERPROFILE ".codex"
    $dstDir = Join-Path $userCodex "skills"
    $removed = 0; $skipped = 0; $err = 0

    if (!(Test-Path $dstDir)) {
        Write-Host "  [skip ] ~/.codex/skills not found" -ForegroundColor DarkGray
        return
    }
    Write-Host "  [skills]" -ForegroundColor Cyan
    $managedTargets = @{}
    if (Test-Path $srcDir) {
        Get-ChildItem $srcDir -Force -ErrorAction SilentlyContinue | Where-Object {
            $_.PSIsContainer -or (Test-Path (Join-Path $_.FullName "SKILL.md") -PathType Leaf)
        } | ForEach-Object {
            $target = $_.FullName
            if (($_.LinkType -in "SymbolicLink", "Junction") -and $_.Target) {
                $targetPath = @($_.Target)[0]
                if (Test-Path -LiteralPath $targetPath -PathType Container) {
                    $target = $targetPath
                }
            }
            $managedTargets[$target] = $true
        }
    }
    Get-ChildItem $dstDir -Force -ErrorAction SilentlyContinue | ForEach-Object {
        $target = if ($_.Target) { @($_.Target)[0] } else { $null }
        if (($_.LinkType -in "SymbolicLink", "Junction") -and $target -and ($_.Target -like "$srcDir*" -or $managedTargets.ContainsKey($target))) {
            if ($IsDryRun) {
                Write-Host "    [DRYRUN] unlink $($_.Name)" -ForegroundColor Cyan
                $removed++
            } else {
                try {
                    if ($_.PSIsContainer) { $_.Delete() } else { Remove-Item $_.FullName -Force }
                    Write-Host "    [unlink] $($_.Name)" -ForegroundColor Green
                    $removed++
                } catch {
                    Write-Host "    [error] $($_.Name) : $_" -ForegroundColor Red
                    $err++
                }
            }
        } else {
            Write-Host "    [keep ] $($_.Name)  (not a dao symlink)" -ForegroundColor DarkGray
            $skipped++
        }
    }
    Write-Host ""
    Write-Host "  summary: removed=$removed skipped=$skipped error=$err" -ForegroundColor Cyan
    Write-Host "  Codex: restart session to apply. ~/.claude/skills and Claude deployment files are untouched." -ForegroundColor DarkGray
}

function Get-CodexPromptNames {
    return @(
        "dao-superpowers",
        "dao-cycle",
        "dao-dev",
        "dao-philosophy",
        "dao-evolve",
        "dao-commit"
    )
}

function New-ManagedCodexPrompt {
    param([string]$Name)
    if ($Name -eq "dao-philosophy") {
        return @"
---
description: 深度哲学反思 / 质疑规则根基时调用 dao-philosophy skill
argument-hint: "[问题/主题]"
---

<!-- codex-managed: windsurf-dao -->

`$dao-philosophy

用户输入：`$ARGUMENTS
"@
    }
    return $null
}

function ConvertTo-CodexManagedPrompt {
    param([string]$SourcePath, [string]$Name)
    $raw = Get-Content -LiteralPath $SourcePath -Raw -Encoding UTF8
    $marker = "<!-- codex-managed: windsurf-dao -->"
    if ($raw -match '(?s)^---\s*\r?\n.*?\r?\n---\s*\r?\n') {
        $regex = [regex]::new('(?s)^---\s*\r?\n.*?\r?\n---\s*\r?\n')
        return $regex.Replace($raw, { param($m) "$($m.Value.TrimEnd())`n`n$marker`n`n" }, 1)
    }
    return @"
---
description: windsurf-dao prompt $Name
---

$marker

$raw
"@
}

function Invoke-LinkCodexPrompts {
    # 将高频手动 dao workflow 写入 ~/.codex/prompts 的实体 Markdown 文件。
    # Codex 入口是 /prompts:<name>；此操作不修改 Claude commands 或部署文件。
    param([bool]$IsDryRun = $false)

    $userClaude = Join-Path $env:USERPROFILE ".claude"
    $srcDir = Join-Path $userClaude "commands"
    $userCodex = Join-Path $env:USERPROFILE ".codex"
    $dstDir = Join-Path $userCodex "prompts"
    if (-not $IsDryRun) { Ensure-Dir $dstDir }

    $linked = 0; $skipped = 0; $conflict = 0; $err = 0
    Write-Host "  [dao manual entries -> ~/.codex/prompts]" -ForegroundColor Cyan

    foreach ($name in Get-CodexPromptNames) {
        $dstFile = Join-Path $dstDir "$name.md"
        $srcFile = Join-Path $srcDir "$name.md"
        $hasSource = Test-Path $srcFile -PathType Leaf
        $promptText = if ($hasSource) { ConvertTo-CodexManagedPrompt -SourcePath $srcFile -Name $name } else { New-ManagedCodexPrompt -Name $name }
        if ($null -eq $promptText) {
            Write-Host "    [skip ] $name  (no Claude command or generated prompt)" -ForegroundColor DarkGray
            $skipped++
            continue
        }

        if (Test-Path $dstFile) {
            $existing = Get-Item $dstFile -Force
            $isLink = $existing.LinkType -in "SymbolicLink", "Junction"
            $existingText = if (-not $isLink) { Get-Content $dstFile -Raw -Encoding UTF8 -ErrorAction SilentlyContinue } else { $null }
            if (-not $isLink -and $existingText -eq $promptText) {
                Write-Host "    [skip ] $name  (already written)" -ForegroundColor DarkGray
                $skipped++
                continue
            }
            $isLegacyManagedPhilosophy = $name -eq "dao-philosophy" -and -not $isLink -and $existingText -match '\$dao-philosophy'
            $isManagedFile = -not $isLink -and ($existingText -match 'codex-managed:\s*windsurf-dao' -or $existingText -match '<!--\s*codex-managed:\s*windsurf-dao\s*-->' -or $isLegacyManagedPhilosophy)
            if ($isLink -or $isManagedFile) {
                if ($IsDryRun) {
                    $oldLabel = if ($isLink) { "$($existing.LinkType) -> $($existing.Target)" } else { "managed file" }
                    Write-Host "    [DRYRUN] update $name  (was $oldLabel)" -ForegroundColor Yellow
                    $linked++
                    continue
                }
                try {
                    $oldLabel = if ($isLink) { "$($existing.LinkType) -> $($existing.Target)" } else { "managed file" }
                    Remove-Item $dstFile -Force
                    $promptText | Set-Content -Path $dstFile -Encoding UTF8
                    Write-Host "    [update] $name  (was $oldLabel)" -ForegroundColor Yellow
                    $linked++
                } catch {
                    Write-Host "    [error] $name : $_" -ForegroundColor Red
                    $err++
                }
                continue
            }
            Write-Host "    [keep ] $name  (real prompt, preserved)" -ForegroundColor Yellow
            $conflict++
            continue
        }

        if ($IsDryRun) {
            Write-Host "    [DRYRUN] write $name" -ForegroundColor Cyan
            $linked++
        } else {
            try {
                $promptText | Set-Content -Path $dstFile -Encoding UTF8
                Write-Host "    [write] $name" -ForegroundColor Green
                $linked++
            } catch {
                Write-Host "    [error] $name : $_" -ForegroundColor Red
                $err++
            }
        }
    }

    Write-Host ""
    Write-Host "  summary: linked=$linked skipped=$skipped conflict=$conflict error=$err" -ForegroundColor Cyan
    Write-Host "  Codex: restart session to see /prompts:<name> slash entries. Claude deployment files are untouched." -ForegroundColor DarkGray
}

function Invoke-UnlinkCodexPrompts {
    # 只删除本脚本生成/管理的高频 dao Codex prompts，不碰用户自有 prompt。
    param([bool]$IsDryRun = $false)

    $userClaude = Join-Path $env:USERPROFILE ".claude"
    $srcDir = Join-Path $userClaude "commands"
    $userCodex = Join-Path $env:USERPROFILE ".codex"
    $dstDir = Join-Path $userCodex "prompts"
    $removed = 0; $skipped = 0; $err = 0

    if (!(Test-Path $dstDir)) {
        Write-Host "  [skip ] ~/.codex/prompts not found" -ForegroundColor DarkGray
        return
    }
    Write-Host "  [prompts]" -ForegroundColor Cyan

    foreach ($name in Get-CodexPromptNames) {
        $dstFile = Join-Path $dstDir "$name.md"
        $srcFile = Join-Path $srcDir "$name.md"
        if (!(Test-Path $dstFile)) { continue }
        $existing = Get-Item $dstFile -Force
        $isManagedLink = ($existing.LinkType -in "SymbolicLink", "Junction") -and $existing.Target -eq $srcFile
        $existingPromptText = if (-not ($existing.LinkType -in "SymbolicLink", "Junction")) { Get-Content $dstFile -Raw -Encoding UTF8 -ErrorAction SilentlyContinue } else { $null }
        $isLegacyManagedPhilosophy = $name -eq "dao-philosophy" -and -not ($existing.LinkType -in "SymbolicLink", "Junction") -and $existingPromptText -match '\$dao-philosophy'
        $isManagedFile = -not ($existing.LinkType -in "SymbolicLink", "Junction") -and ($existingPromptText -match 'codex-managed:\s*windsurf-dao' -or $existingPromptText -match '<!--\s*codex-managed:\s*windsurf-dao\s*-->' -or $isLegacyManagedPhilosophy)
        if ($isManagedLink -or $isManagedFile) {
            if ($IsDryRun) {
                Write-Host "    [DRYRUN] unlink $name" -ForegroundColor Cyan
                $removed++
            } else {
                try {
                    Remove-Item $dstFile -Force
                    Write-Host "    [unlink] $name" -ForegroundColor Green
                    $removed++
                } catch {
                    Write-Host "    [error] $name : $_" -ForegroundColor Red
                    $err++
                }
            }
        } else {
            Write-Host "    [keep ] $name  (not a managed Codex prompt)" -ForegroundColor DarkGray
            $skipped++
        }
    }

    Write-Host ""
    Write-Host "  summary: removed=$removed skipped=$skipped error=$err" -ForegroundColor Cyan
    Write-Host "  Codex: restart session to apply. Claude deployment files are untouched." -ForegroundColor DarkGray
}

function Invoke-LinkGlobal {
    $globalDir = Join-Path (Join-Path (Join-Path $env:USERPROFILE ".codeium") "windsurf") "memories"
    $globalFile = Join-Path $globalDir "global_rules.md"
    $sourceFile = Join-Path $DaoRoot "global_rules.md"

    Ensure-Dir $globalDir

    if (Test-Path $globalFile) {
        $item = Get-Item $globalFile
        if ($item.LinkType -eq "SymbolicLink") {
            Write-Host "  [skip] Already linked -> $($item.Target)" -ForegroundColor DarkGray
            return
        }
        Copy-Item $globalFile "$globalFile.bak" -Force
        Remove-Item $globalFile -Force
        Write-Host "  [backup] Existing -> global_rules.md.bak" -ForegroundColor Yellow
    }

    if (!(Test-SymlinkSupport)) {
        Write-Host "  [!] Symlinks unavailable for global link." -ForegroundColor Red
        return
    }
    New-Symlink -Link $globalFile -Target $sourceFile
    Write-Host "  [link] global_rules.md -> $sourceFile" -ForegroundColor Green
}

function Invoke-UnlinkClaude {
    # 卸载 Claude Code 侧部署:移除 ~/.claude 下的 dao symlink、references/ 经文、@import 行、hook 注册。
    # 只删 dao 引入的链接/条目,不碰用户自有 skill/command/agent,不碰 env/token。
    # 与 link-claude 对称。源文件 claude/ 不受影响。
    param([bool]$IsDryRun = $false)

    $userClaude = Join-Path $env:USERPROFILE ".claude"
    $claudeSrc = Join-Path $DaoRoot "claude"
    $removed = 0; $skipped = 0; $err = 0

    # ── 移除 dao symlink(skills 目录链 / commands·agents 文件链)──
    $specs = @(
        @{ Name = "skills";   Filter = "dao-*" },
        @{ Name = "commands"; Filter = "dao-*.md" },
        @{ Name = "agents";   Filter = "dao-*.md" }
    )
    foreach ($spec in $specs) {
        $dstDir = Join-Path $userClaude $spec.Name
        if (!(Test-Path $dstDir)) { continue }
        Write-Host "  [$($spec.Name)]" -ForegroundColor Cyan
        Get-ChildItem $dstDir -Filter $spec.Filter -Force -ErrorAction SilentlyContinue | ForEach-Object {
            # 只删 symlink,且 target 指向本 dao 源;真实文件/他处链接不动
            if ($_.LinkType -eq "SymbolicLink" -and $_.Target -and $_.Target -like "$claudeSrc*") {
                if ($IsDryRun) {
                    Write-Host "    [DRYRUN] unlink $($_.Name)" -ForegroundColor Cyan
                    $removed++
                } else {
                    try {
                        # symlink 用 Remove-Item;目录 symlink 加 -Recurse 仅删链不删源
                        if ($_.PSIsContainer) { $_.Delete() } else { Remove-Item $_.FullName -Force }
                        Write-Host "    [unlink] $($_.Name)" -ForegroundColor Green
                        $removed++
                    } catch {
                        Write-Host "    [error] $($_.Name) : $_" -ForegroundColor Red
                        $err++
                    }
                }
            } else {
                Write-Host "    [keep ] $($_.Name)  (not a dao symlink)" -ForegroundColor DarkGray
                $skipped++
            }
        }
    }

    # ── 移除 ~/.claude/references/ 下的经文文件 ──
    $refDst = Join-Path $userClaude "references"
    if (Test-Path $refDst) {
        Write-Host "  [references]" -ForegroundColor Cyan
        Get-ChildItem $refDst -File -Filter "*.md" -ErrorAction SilentlyContinue | ForEach-Object {
            # 只删明确由 dao 引入的经文（帛书老子、阴符经、道德经）
            if ($_.Name -match "^(帛书老子|阴符经|道德经)\.md$") {
                if ($IsDryRun) {
                    Write-Host "    [DRYRUN] remove $($_.Name)" -ForegroundColor Cyan
                    $removed++
                } else {
                    try {
                        Remove-Item $_.FullName -Force
                        Write-Host "    [remove] $($_.Name)" -ForegroundColor Green
                        $removed++
                    } catch {
                        Write-Host "    [error] $($_.Name) : $_" -ForegroundColor Red
                        $err++
                    }
                }
            } else {
                Write-Host "    [keep ] $($_.Name)  (not a dao file)" -ForegroundColor DarkGray
                $skipped++
            }
        }
    }

    # ── 移除 ~/.claude/CLAUDE.md 里的 dao.md @import 块 ──
    $userClaudeMd = Join-Path $userClaude "CLAUDE.md"
    if (Test-Path $userClaudeMd) {
        Write-Host "  [import]" -ForegroundColor Cyan
        $lines = Get-Content $userClaudeMd
        $kept = New-Object System.Collections.ArrayList
        $dropped = $false
        for ($i = 0; $i -lt $lines.Count; $i++) {
            $ln = $lines[$i]
            if ($ln -match "windsurf-dao Tao field" -or ($ln -match "^@.*claude/dao\.md")) {
                $dropped = $true
                continue
            }
            [void]$kept.Add($ln)
        }
        if ($dropped) {
            if ($IsDryRun) {
                Write-Host "    [DRYRUN] remove dao.md @import block" -ForegroundColor Cyan
                $removed++
            } else {
                # 去掉因删块残留的连续空行尾巴
                ($kept -join "`n").TrimEnd() + "`n" | Set-Content $userClaudeMd -Encoding UTF8
                Write-Host "    [remove] dao.md @import block" -ForegroundColor Green
                $removed++
            }
        } else {
            Write-Host "    [skip ] no dao.md @import found" -ForegroundColor DarkGray
            $skipped++
        }
    }

    # ── 移除 settings.json 里的 dao-glob-gate hook ──
    $settingsPath = Join-Path $userClaude "settings.json"
    if (Test-Path $settingsPath) {
        Write-Host "  [hook]" -ForegroundColor Cyan
        $sraw = Get-Content $settingsPath -Raw -ErrorAction SilentlyContinue
        if ($sraw -match "dao-glob-gate") {
            if ($IsDryRun) {
                Write-Host "    [DRYRUN] remove dao-glob-gate hook" -ForegroundColor Cyan
                $removed++
            } else {
                try {
                    $settings = $sraw | ConvertFrom-Json
                    if ($settings.hooks -and $settings.hooks.PostToolUse) {
                        $keptPostToolUse = @()
                        foreach ($entry in @($settings.hooks.PostToolUse)) {
                            $commands = @($entry.hooks | ForEach-Object { $_.command })
                            if (-not ($commands -like "*dao-glob-gate*")) {
                                $keptPostToolUse += $entry
                            }
                        }
                        $settings.hooks.PostToolUse = $keptPostToolUse
                        if ($settings.hooks.PostToolUse.Count -eq 0) {
                            $settings.hooks.PSObject.Properties.Remove('PostToolUse')
                        }
                        if (-not $settings.hooks.PSObject.Properties.Name) {
                            $settings.PSObject.Properties.Remove('hooks')
                        }
                    }
                    $settings | ConvertTo-Json -Depth 20 | Set-Content $settingsPath -Encoding UTF8
                    Write-Host "    [remove] dao-glob-gate hook" -ForegroundColor Green
                    $removed++
                } catch {
                    Write-Host "    [error] hook removal failed: $_" -ForegroundColor Red
                    $err++
                }
            }
        } else {
            Write-Host "    [skip ] no dao-glob-gate hook found" -ForegroundColor DarkGray
            $skipped++
        }

        # ── 移除 settings.json 里的 dao-cn-title hook(重读,因上方可能已改写)──
        $sraw = Get-Content $settingsPath -Raw -ErrorAction SilentlyContinue
        if ($sraw -match "dao-cn-title") {
            if ($IsDryRun) {
                Write-Host "    [DRYRUN] remove dao-cn-title hook" -ForegroundColor Cyan
                $removed++
            } else {
                try {
                    $settings = $sraw | ConvertFrom-Json
                    if ($settings.hooks -and $settings.hooks.UserPromptSubmit) {
                        $keptUserPromptSubmit = @()
                        foreach ($entry in @($settings.hooks.UserPromptSubmit)) {
                            $commands = @($entry.hooks | ForEach-Object { $_.command })
                            if (-not ($commands -like "*dao-cn-title*")) {
                                $keptUserPromptSubmit += $entry
                            }
                        }
                        $settings.hooks.UserPromptSubmit = $keptUserPromptSubmit
                        if ($settings.hooks.UserPromptSubmit.Count -eq 0) {
                            $settings.hooks.PSObject.Properties.Remove('UserPromptSubmit')
                        }
                        if (-not $settings.hooks.PSObject.Properties.Name) {
                            $settings.PSObject.Properties.Remove('hooks')
                        }
                    }
                    $settings | ConvertTo-Json -Depth 20 | Set-Content $settingsPath -Encoding UTF8
                    Write-Host "    [remove] dao-cn-title hook" -ForegroundColor Green
                    $removed++
                } catch {
                    Write-Host "    [error] title hook removal failed: $_" -ForegroundColor Red
                    $err++
                }
            }
        } else {
            Write-Host "    [skip ] no dao-cn-title hook found" -ForegroundColor DarkGray
            $skipped++
        }

        # ── 移除 settings.json 里的 dao-settings-sync SessionStart hook(重读,因上方可能已改写)──
        $sraw = Get-Content $settingsPath -Raw -ErrorAction SilentlyContinue
        if ($sraw -match "dao-settings-sync") {
            if ($IsDryRun) {
                Write-Host "    [DRYRUN] remove dao-settings-sync SessionStart hook" -ForegroundColor Cyan
                $removed++
            } else {
                try {
                    $settings = $sraw | ConvertFrom-Json
                    if ($settings.hooks -and $settings.hooks.SessionStart) {
                        $keptSessionStart = @()
                        foreach ($entry in @($settings.hooks.SessionStart)) {
                            $commands = @($entry.hooks | ForEach-Object { $_.command })
                            if (-not ($commands -like "*dao-settings-sync*")) {
                                $keptSessionStart += $entry
                            }
                        }
                        $settings.hooks.SessionStart = $keptSessionStart
                        if ($settings.hooks.SessionStart.Count -eq 0) {
                            $settings.hooks.PSObject.Properties.Remove('SessionStart')
                        }
                        if (-not $settings.hooks.PSObject.Properties.Name) {
                            $settings.PSObject.Properties.Remove('hooks')
                        }
                    }
                    $settings | ConvertTo-Json -Depth 20 | Set-Content $settingsPath -Encoding UTF8
                    Write-Host "    [remove] dao-settings-sync SessionStart hook" -ForegroundColor Green
                    $removed++
                } catch {
                    Write-Host "    [error] sync hook removal failed: $_" -ForegroundColor Red
                    $err++
                }
            }
        } else {
            Write-Host "    [skip ] no dao-settings-sync hook found" -ForegroundColor DarkGray
            $skipped++
        }
    }

    # ── 反注册登录计划任务 ──
    $taskName = "dao-settings-sync"
    Write-Host "  [logon-task]" -ForegroundColor Cyan
    $existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($existing) {
        if ($IsDryRun) {
            Write-Host "    [DRYRUN] unregister logon task '$taskName'" -ForegroundColor Cyan
            $removed++
        } else {
            try {
                Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
                Write-Host "    [remove] logon task '$taskName'" -ForegroundColor Green
                $removed++
            } catch {
                Write-Host "    [error] logon task unregister failed: $_" -ForegroundColor Red
                $err++
            }
        }
    } else {
        Write-Host "    [skip ] no logon task '$taskName' found" -ForegroundColor DarkGray
        $skipped++
    }

    Write-Host ""
    Write-Host "  summary: removed=$removed skipped=$skipped error=$err" -ForegroundColor Cyan
    Write-Host "  Claude Code: restart session to apply. Source claude/ untouched (git-tracked)." -ForegroundColor DarkGray
}

# ── 入口 ──

switch ($Action) {
    "status" {
        Invoke-Status
    }
    "link-global" {
        if (!(Test-SymlinkSupport)) {
            Write-Host "  [!] Symlinks unavailable. Enable Developer Mode." -ForegroundColor Red
            exit 1
        }
        Write-Host "`n  Linking global_rules.md..." -ForegroundColor Cyan
        Invoke-LinkGlobal
    }
    "link-rules" {
        if (-not $TargetPath) {
            Write-Host "  [!] Missing project path. Usage: .\dao.ps1 link-rules <project>" -ForegroundColor Red
            exit 1
        }
        if (!(Test-SymlinkSupport)) {
            Write-Host "  [!] Symlinks unavailable. Enable Developer Mode." -ForegroundColor Red
            exit 1
        }
        Write-Host "`n  Linking dao rules into project..." -ForegroundColor Cyan
        [void](Invoke-LinkRules -ProjectPath $TargetPath -OnlyAlwaysOn:$AlwaysOnOnly.IsPresent -IsDryRun:$DryRun.IsPresent)
    }
    "link-rules-all" {
        if (!(Test-SymlinkSupport)) {
            Write-Host "  [!] Symlinks unavailable. Enable Developer Mode." -ForegroundColor Red
            exit 1
        }
        Write-Host "`n  Bulk linking dao rules into all projects..." -ForegroundColor Cyan
        Invoke-LinkRulesAll -ScanRoot $Root -OnlyAlwaysOn:$AlwaysOnOnly.IsPresent -IsDryRun:$DryRun.IsPresent
    }
    "link-claude" {
        if (!(Test-SymlinkSupport)) {
            Write-Host "  [!] Symlinks unavailable. Enable Developer Mode." -ForegroundColor Red
            exit 1
        }
        Write-Host "`n  Linking dao claude/ config into ~/.claude ..." -ForegroundColor Cyan
        Invoke-LinkClaude -IsDryRun:$DryRun.IsPresent
    }
    "unlink-claude" {
        Write-Host "`n  Unlinking dao claude/ config from ~/.claude ..." -ForegroundColor Cyan
        Invoke-UnlinkClaude -IsDryRun:$DryRun.IsPresent
    }
    "link-codex" {
        if (!(Test-SymlinkSupport)) {
            Write-Host "  [!] Symlinks unavailable. Enable Developer Mode." -ForegroundColor Red
            exit 1
        }
        Write-Host "`n  Linking Claude user skills into ~/.codex/skills ..." -ForegroundColor Cyan
        Invoke-LinkCodex -IsDryRun:$DryRun.IsPresent
    }
    "unlink-codex" {
        Write-Host "`n  Unlinking Claude user skill links from ~/.codex/skills ..." -ForegroundColor Cyan
        Invoke-UnlinkCodex -IsDryRun:$DryRun.IsPresent
    }
    "link-codex-prompts" {
        Write-Host "`n  Linking high-frequency dao prompts into ~/.codex/prompts ..." -ForegroundColor Cyan
        Invoke-LinkCodexPrompts -IsDryRun:$DryRun.IsPresent
    }
    "unlink-codex-prompts" {
        Write-Host "`n  Unlinking high-frequency dao prompts from ~/.codex/prompts ..." -ForegroundColor Cyan
        Invoke-UnlinkCodexPrompts -IsDryRun:$DryRun.IsPresent
    }
    default {
        Write-Host @"

  windsurf-dao tool

  Usage:
    .\dao.ps1 status                          Show dao source info and global link status
    .\dao.ps1 link-global                     Link global_rules.md to Windsurf config
    .\dao.ps1 link-rules <project>            Symlink dao .windsurf/rules/*.md into <project>/.windsurf/rules
    .\dao.ps1 link-rules-all [-Root <dir>]    Bulk scan & symlink all projects under <Root>
                                               -AlwaysOnOnly  only link always_on rules (5 files)
                                               -DryRun        print without doing anything
    .\dao.ps1 link-claude [-DryRun]           Symlink dao claude/{skills,commands,agents} into ~/.claude,
                                               copy references/*.md to ~/.claude/references/,
                                               and append dao.md @import to ~/.claude/CLAUDE.md (Claude Code)
    .\dao.ps1 unlink-claude [-DryRun]         Remove dao symlinks, references/, dao.md @import, and hooks
                                               from ~/.claude (reverse of link-claude; source claude/ untouched)
    .\dao.ps1 link-codex [-DryRun]            Mirror ~/.claude/skills into ~/.codex/skills
    .\dao.ps1 unlink-codex [-DryRun]          Remove Codex skill links that point into ~/.claude/skills
    .\dao.ps1 link-codex-prompts [-DryRun]    Write high-frequency dao manual entries into ~/.codex/prompts
    .\dao.ps1 unlink-codex-prompts [-DryRun]  Remove managed dao prompt files

  Examples:
    .\dao.ps1 link-claude                     deploy dao to Claude Code (global)
    .\dao.ps1 link-claude -DryRun             preview Claude Code deploy
    .\dao.ps1 link-codex                      deploy Claude user skills to Codex
    .\dao.ps1 link-codex -DryRun              preview Codex deploy
    .\dao.ps1 link-codex-prompts              expose /prompts:dao-dev style entries in Codex
    .\dao.ps1 unlink-claude -DryRun           preview Claude Code uninstall
    .\dao.ps1 link-rules-all                  scan default root (dao's parent dir)
    .\dao.ps1 link-rules-all -DryRun          preview without writing
    .\dao.ps1 link-rules d:\frank\TraceyU     single project

"@
    }
}

