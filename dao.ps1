# dao.ps1 — windsurf-dao 统一工具脚本
#
# 主入口：dao.bat（双击即用，自动路由）
#   dao.bat                                   配置同步交互菜单（= 原 dao-sync.bat）
#   dao.bat --direction=down                  下行恢复
#   dao.bat status                            查看状态（→ dao.ps1 status）
#   dao.bat codegraph                         安装/修复 CodeGraph（→ dao.ps1 codegraph）
#   dao.bat link-claude                       部署到 Claude Code（→ dao.ps1 link-claude）
#
# 直接调用 dao.ps1 也可以：
#   .\dao.ps1 status / link-claude / codegraph / ...
#
# 前提：Windows Developer Mode（symlink 权限）

param(
    [Parameter(Position=0)]
    [string]$Action,

    [Parameter(Position=1)]
    [string]$TargetPath,

    [Parameter(Position=2)]
    [string]$SubArg,

    [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$DaoRoot = $PSScriptRoot

# ── 工具函数 ──

function Get-FileMD5($Path) {
    $bytes = [System.IO.File]::ReadAllBytes($Path)
    $md5 = [System.Security.Cryptography.MD5]::Create()
    [System.BitConverter]::ToString($md5.ComputeHash($bytes)).Replace('-','')
}

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
    Write-Host "`n  Source: $DaoRoot" -ForegroundColor Cyan

    # ── Claude Code 侧部署状态 ──
    $claudeSrc = Join-Path $DaoRoot "ccswitch"
    if (Test-Path $claudeSrc) {
        $cSkills = (Get-ChildItem (Join-Path $claudeSrc "skills") -Directory -ErrorAction SilentlyContinue).Count
        $cCmds = (Get-ChildItem (Join-Path $claudeSrc "commands") -Filter "*.md" -ErrorAction SilentlyContinue).Count
        $cAgents = (Get-ChildItem (Join-Path $claudeSrc "agents") -Filter "*.md" -ErrorAction SilentlyContinue).Count
        Write-Host "`n  Claude Code source: ${cSkills} skills, ${cCmds} commands, ${cAgents} agents" -ForegroundColor Cyan

        $userClaude = Join-Path $env:USERPROFILE ".claude"
        $linkedSkills = (Get-ChildItem (Join-Path $userClaude "skills") -ErrorAction SilentlyContinue | Where-Object { $_.Name -like "dao-*" -and $_.LinkType -in "SymbolicLink", "Junction" }).Count
        $userClaudeMd = Join-Path $userClaude "CLAUDE.md"
        $importOk = (Test-Path $userClaudeMd) -and ((Get-Content $userClaudeMd -Raw -ErrorAction SilentlyContinue) -match "(claude|ccswitch)/dao\.md")

        if ($linkedSkills -gt 0 -and $importOk) {
            Write-Host "  Claude Code deploy: linked ($linkedSkills dao skills) + dao.md @import OK" -ForegroundColor Green
        } elseif ($linkedSkills -gt 0 -or $importOk) {
            Write-Host "  Claude Code deploy: partial (run: dao.ps1 link-claude)" -ForegroundColor Yellow
        } else {
            Write-Host "  Claude Code deploy: not installed (run: dao.ps1 link-claude)" -ForegroundColor Red
        }

        # ── Persona 注入状态 ──
        $personaState = "$env:USERPROFILE\.claude\persona\.current-mode"
        $personaActive = "$env:USERPROFILE\.claude\persona\active-system-prompt.md"
        if (Test-Path $personaState) {
            $pMode = (Get-Content $personaState -Raw).Trim()
            $pSize = if (Test-Path $personaActive) { "$([math]::Round((Get-Item $personaActive).Length / 1024, 1))KB" } else { "n/a" }
            Write-Host "  Persona inject: $pMode ($pSize)" -ForegroundColor Green
        } else {
            Write-Host "  Persona inject: off (run: dao.ps1 persona install)" -ForegroundColor Gray
        }

        # ── CodeGraph 状态 ──
        $cgDir = Join-Path $env:LOCALAPPDATA "codegraph\current"
        $cgNode = Join-Path $cgDir "node.exe"
        $cgEntry = Join-Path $cgDir "lib\dist\bin\codegraph.js"
        if ((Test-Path $cgNode) -and (Test-Path $cgEntry)) {
            Write-Host "  CodeGraph: installed" -ForegroundColor Green
        } elseif (Test-Path $cgNode) {
            Write-Host "  CodeGraph: incomplete (run: dao.ps1 codegraph)" -ForegroundColor Yellow
        } else {
            Write-Host "  CodeGraph: not installed (run: dao.ps1 codegraph)" -ForegroundColor Red
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

function Invoke-LinkClaude {
    # 把 ccswitch/{skills,commands,agents} 下的 dao-* 项 symlink 到 ~/.claude，
    # 复制 docs/classics/*.md 经文到 ~/.claude/references/，
    # 并幂等追加 dao.md 的 @import 到 ~/.claude/CLAUDE.md。
    param([bool]$IsDryRun = $false)

    $claudeSrc = Join-Path $DaoRoot "ccswitch"
    if (!(Test-Path $claudeSrc)) {
        Write-Host "  [error] ccswitch/ source not found: $claudeSrc" -ForegroundColor Red
        exit 1
    }

    $userClaude = Join-Path $env:USERPROFILE ".claude"
    Ensure-Dir $userClaude

    $linked = 0; $skipped = 0; $conflict = 0; $err = 0

    # ── 清理悬空 Junction（cc-switch 旧版残留，自愈）──
    $skillsDst = Join-Path $userClaude "skills"
    if (Test-Path $skillsDst) {
        $broken = @(Get-ChildItem $skillsDst -Directory -ErrorAction SilentlyContinue |
            Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint } |
            Where-Object { (Get-ChildItem $_.FullName -File -ErrorAction SilentlyContinue | Measure-Object).Count -eq 0 })
        if ($broken.Count -gt 0) {
            Write-Host "  [cleanup] 清理 $($broken.Count) 个悬空 Junction" -ForegroundColor Yellow
            foreach ($b in $broken) {
                if ($IsDryRun) {
                    Write-Host "    [DRYRUN] remove $($b.Name)" -ForegroundColor Cyan
                } else {
                    cmd /c "rmdir `"$($b.FullName)`"" 2>&1 | Out-Null
                    Write-Host "    [remove] $($b.Name)" -ForegroundColor Yellow
                }
            }
        }
    }

    # ── 三类目录 symlink（skills/agents 链目录，commands 链文件）──
    $specs = @(
        @{ Name = "skills";   Kind = "dir";  Filter = "dao-*" },
        @{ Name = "commands"; Kind = "file"; Filter = "*.md" },
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
                if ($existing.LinkType -in "SymbolicLink", "Junction") {
                    if ($existing.Target -eq $it.FullName) {
                        Write-Host "    [skip ] $($it.Name)  (already linked)" -ForegroundColor DarkGray
                        $skipped++
                        continue
                    }
                    # 指向错误目标 → 自愈：删旧建新
                    $oldTarget = $existing.Target
                    if ($IsDryRun) {
                        Write-Host "    [DRYRUN] fix $($it.Name)  ($oldTarget -> $($it.FullName))" -ForegroundColor Yellow
                        $linked++
                    } else {
                        try {
                            if ($existing.PSIsContainer) { $existing.Delete() } else { Remove-Item $linkPath -Force }
                            New-Symlink -Link $linkPath -Target $it.FullName
                            Write-Host "    [fix  ] $($it.Name)  ($oldTarget -> $($it.FullName))" -ForegroundColor Yellow
                            $linked++
                        } catch {
                            Write-Host "    [error] $($it.Name) : $_" -ForegroundColor Red
                            $err++
                        }
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

    # ── 清理源里已不存在的废弃 dao-* symlink（精简后残留自愈）──
    $oldClaudeSrc = Join-Path $DaoRoot "claude"
    foreach ($spec in $specs) {
        $dstDir = Join-Path $userClaude $spec.Name
        if (!(Test-Path $dstDir)) { continue }
        $srcDir = Join-Path $claudeSrc $spec.Name
        $srcNames = @()
        if (Test-Path $srcDir) {
            $srcNames = @(if ($spec.Kind -eq "dir") {
                Get-ChildItem $srcDir -Directory -Filter $spec.Filter -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name
            } else {
                Get-ChildItem $srcDir -File -Filter $spec.Filter -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name
            })
        }
        Get-ChildItem $dstDir -Filter $spec.Filter -Force -ErrorAction SilentlyContinue | ForEach-Object {
            if ($_.LinkType -notin "SymbolicLink", "Junction") { return }
            if ($_.Target -and ($_.Target -like "$claudeSrc*" -or $_.Target -like "$oldClaudeSrc*") -and $_.Name -notin $srcNames) {
                if ($IsDryRun) {
                    Write-Host "    [DRYRUN] prune $($_.Name)  (source removed)" -ForegroundColor Yellow
                } else {
                    try {
                        if ($_.PSIsContainer) { $_.Delete() } else { Remove-Item $_.FullName -Force }
                        Write-Host "    [prune] $($_.Name)  (source removed)" -ForegroundColor Yellow
                    } catch {
                        Write-Host "    [error] prune $($_.Name) : $_" -ForegroundColor Red
                        $err++
                    }
                }
            }
        }
    }

    # ── hooks 已单路径化:settings.json 注册直指 ccswitch/hooks/ 仓库路径,不再复制到
    # ~/.claude/hooks/(fortify2-20260726 D1;旧拷贝层曾 12/13 死、无 prune、2 份 MD5 DIFF)。

    # ── settings.json 路径(后续 outputStyle / hook / 通用配置固化共用,提前定义避免未赋值引用)──
    $settingsPath = Join-Path $userClaude "settings.json"

    # ── 复制 docs/classics/ 经文到 ~/.claude/references/ ──
    $refSrc = Join-Path (Join-Path $DaoRoot "docs") "classics"
    if (Test-Path $refSrc) {
        $refDst = Join-Path $userClaude "references"
        if (-not $IsDryRun) { Ensure-Dir $refDst }
        Write-Host "  [references]" -ForegroundColor Cyan
        $refFiles = Get-ChildItem $refSrc -File -Filter "*.md" -ErrorAction SilentlyContinue
        foreach ($ref in $refFiles) {
            $dstFile = Join-Path $refDst $ref.Name
            if (Test-Path $dstFile) {
                # 对比文件内容，如果不同则更新
                $srcHash = Get-FileMD5 $ref.FullName
                $dstHash = Get-FileMD5 $dstFile
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
                $srcHash = Get-FileMD5 $style.FullName
                $dstHash = Get-FileMD5 $dstFile
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

    # ── 复制 themes/ 到 ~/.claude/themes/ ──
    $themesSrc = Join-Path $claudeSrc "themes"
    if (Test-Path $themesSrc) {
        $themesDst = Join-Path $userClaude "themes"
        if (-not $IsDryRun) { Ensure-Dir $themesDst }
        Write-Host "  [themes]" -ForegroundColor Cyan
        $themeFiles = Get-ChildItem $themesSrc -File -Filter "*.json" -ErrorAction SilentlyContinue
        foreach ($tf in $themeFiles) {
            $dstFile = Join-Path $themesDst $tf.Name
            if (Test-Path $dstFile) {
                $srcHash = Get-FileMD5 $tf.FullName
                $dstHash = Get-FileMD5 $dstFile
                if ($srcHash -eq $dstHash) {
                    Write-Host "    [skip ] $($tf.Name)  (same content)" -ForegroundColor DarkGray
                    $skipped++
                } else {
                    if ($IsDryRun) {
                        Write-Host "    [DRYRUN] update $($tf.Name)" -ForegroundColor Cyan
                        $linked++
                    } else {
                        Copy-Item $tf.FullName -Destination $dstFile -Force
                        Write-Host "    [update] $($tf.Name)" -ForegroundColor Yellow
                        $linked++
                    }
                }
            } else {
                if ($IsDryRun) {
                    Write-Host "    [DRYRUN] copy $($tf.Name)" -ForegroundColor Cyan
                    $linked++
                } else {
                    Copy-Item $tf.FullName -Destination $dstFile
                    Write-Host "    [copy ] $($tf.Name)" -ForegroundColor Green
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
                [System.IO.File]::WriteAllText($settingsPath, ($settings | ConvertTo-Json -Depth 20), (New-Object System.Text.UTF8Encoding($false)))
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
            if ($content -match [regex]::Escape("ccswitch/dao.md")) { $hasImport = $true }
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
    # 编辑代码/dao 文件后注入 dao-quality / dao-meta 提醒
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
                [System.IO.File]::WriteAllText($settingsPath, ($settings | ConvertTo-Json -Depth 20), (New-Object System.Text.UTF8Encoding($false)))
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
                [System.IO.File]::WriteAllText($settingsPath, ($settings | ConvertTo-Json -Depth 20), (New-Object System.Text.UTF8Encoding($false)))
                Write-Host "    [add  ] UserPromptSubmit hook -> dao-cn-title.js" -ForegroundColor Green
                $linked++
            } catch {
                Write-Host "    [error] title hook register failed: $_" -ForegroundColor Red
                $err++
            }
        }
    }

    # ── 通用配置已退役 dao-settings-sync 自愈机制 ──
    # 现以 cc-switch 为唯一下发引擎:common_config_claude 完整覆盖 env/permissions/model/
    # hooks/statusLine/enabledPlugins/theme/enableWorkflows/includeCoAuthoredBy/outputStyle。
    # 版本化备份/恢复改由 windsurf-dao/config-sync 模块负责(导出/恢复/体检 .bat)。
    # 旧机器若仍残留 SessionStart 自愈 hook 或登录任务,运行 `.\dao.ps1 unlink-claude` 清理。

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

function Invoke-UnlinkClaude {
    # 卸载 Claude Code 侧部署:移除 ~/.claude 下的 dao symlink、references/ 经文、@import 行、hook 注册。
    # 只删 dao 引入的链接/条目,不碰用户自有 skill/command/agent,不碰 env/token。
    # 与 link-claude 对称。源文件 ccswitch/ 不受影响。
    param([bool]$IsDryRun = $false)

    $userClaude = Join-Path $env:USERPROFILE ".claude"
    $claudeSrc = Join-Path $DaoRoot "ccswitch"
    $removed = 0; $skipped = 0; $err = 0

    # ── 移除 dao symlink(skills 目录链 / commands·agents 文件链)──
    $oldClaudeSrc = Join-Path $DaoRoot "claude"   # 兼容旧路径(重构前 claude/ → ccswitch/)
    $specs = @(
        @{ Name = "skills";   Filter = "dao-*" },
        @{ Name = "commands"; Filter = "*.md" },
        @{ Name = "agents";   Filter = "dao-*.md" }
    )
    foreach ($spec in $specs) {
        $dstDir = Join-Path $userClaude $spec.Name
        if (!(Test-Path $dstDir)) { continue }
        Write-Host "  [$($spec.Name)]" -ForegroundColor Cyan
        Get-ChildItem $dstDir -Filter $spec.Filter -Force -ErrorAction SilentlyContinue | ForEach-Object {
            # 只删 symlink,且 target 指向本 dao 源(新旧路径均匹配);真实文件/他处链接不动
            if ($_.LinkType -eq "SymbolicLink" -and $_.Target -and ($_.Target -like "$claudeSrc*" -or $_.Target -like "$oldClaudeSrc*")) {
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
            if ($ln -match "windsurf-dao Tao field" -or ($ln -match "^@.*(claude|ccswitch)/dao\.md")) {
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
                    [System.IO.File]::WriteAllText($settingsPath, ($settings | ConvertTo-Json -Depth 20), (New-Object System.Text.UTF8Encoding($false)))
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
                    [System.IO.File]::WriteAllText($settingsPath, ($settings | ConvertTo-Json -Depth 20), (New-Object System.Text.UTF8Encoding($false)))
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
                    [System.IO.File]::WriteAllText($settingsPath, ($settings | ConvertTo-Json -Depth 20), (New-Object System.Text.UTF8Encoding($false)))
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

# ── CodeGraph 安装与自愈 ──

function Invoke-Codegraph {
    # 完整自愈：检测 → 下载 → 解压 → 注册 MCP → init 当前项目
    param([bool]$IsDryRun = $false)

    $repo = "colbymchenry/codegraph"
    $installBase = Join-Path $env:LOCALAPPDATA "codegraph"
    $installDir = Join-Path $installBase "current"
    $binNode = Join-Path $installDir "node.exe"
    $binEntry = Join-Path $installDir "lib\dist\bin\codegraph.js"
    $linked = 0; $skipped = 0; $err = 0

    # ── 1. 检测安装完整性 ──
    Write-Host "  [check]" -ForegroundColor Cyan
    $needInstall = $false
    if (!(Test-Path $binNode)) {
        Write-Host "    node.exe 不存在" -ForegroundColor Yellow
        $needInstall = $true
    } elseif (!(Test-Path $binEntry)) {
        Write-Host "    lib/dist/bin/codegraph.js 缺失（安装不完整）" -ForegroundColor Yellow
        $needInstall = $true
    } else {
        Write-Host "    [skip ] 安装完整" -ForegroundColor DarkGray
        $skipped++
    }

    # ── 2. 安装（停占用进程 → 清理 → 下载 → 解压）──
    if ($needInstall) {
        if ($IsDryRun) {
            Write-Host "    [DRYRUN] 将下载并安装 codegraph" -ForegroundColor Cyan
            $linked++
        } else {
            # 停掉占用 codegraph node.exe 的进程
            $cgProcs = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$installDir*" }
            if ($cgProcs) {
                Write-Host "    停止 $($cgProcs.Count) 个占用进程..." -ForegroundColor Yellow
                $cgProcs | Stop-Process -Force -Confirm:$false -ErrorAction SilentlyContinue
                Start-Sleep -Milliseconds 500
            }

            # 清理旧目录
            if (Test-Path $installDir) {
                Remove-Item -Recurse -Force $installDir -Confirm:$false -ErrorAction SilentlyContinue
            }
            Ensure-Dir $installDir

            # 获取最新版本号
            Write-Host "    获取最新版本..." -ForegroundColor Cyan
            $version = $null
            try {
                $r = Invoke-WebRequest -Uri "https://github.com/$repo/releases/latest" -MaximumRedirection 0 -ErrorAction Stop
            } catch {
                $loc = $_.Exception.Response.Headers.Location
                if ($loc) { $version = ($loc.AbsolutePath -split '/')[-1] }
            }
            if (-not $version) {
                Write-Host "    [error] 无法获取版本号（GitHub 可能限流）" -ForegroundColor Red
                $err++
            } else {
                # 判断架构
                $arch = if ([Environment]::Is64BitOperatingSystem) { "x64" } else { "x86" }
                $zipName = "codegraph-win32-$arch.zip"
                $url = "https://github.com/$repo/releases/download/$version/$zipName"
                $zipPath = Join-Path $env:TEMP $zipName

                Write-Host "    下载 $version ($zipName)..." -ForegroundColor Cyan
                try {
                    Invoke-WebRequest -Uri $url -OutFile $zipPath -UseBasicParsing
                } catch {
                    Write-Host "    [error] 下载失败: $_" -ForegroundColor Red
                    $err++
                    $zipPath = $null
                }

                if ($zipPath -and (Test-Path $zipPath)) {
                    Write-Host "    解压..." -ForegroundColor Cyan
                    Expand-Archive -Path $zipPath -DestinationPath $installDir -Force

                    # 处理可能的嵌套目录（zip 内有一层 codegraph-win32-x64/）
                    $nested = Join-Path $installDir "codegraph-win32-$arch"
                    if ((Test-Path $nested) -and !(Test-Path $binEntry)) {
                        Get-ChildItem $nested | Move-Item -Destination $installDir -Force
                        Remove-Item $nested -Force -Confirm:$false -ErrorAction SilentlyContinue
                    }

                    Remove-Item $zipPath -Force -ErrorAction SilentlyContinue

                    if (Test-Path $binEntry) {
                        Write-Host "    [done ] 安装成功 $version" -ForegroundColor Green
                        $linked++
                    } else {
                        Write-Host "    [error] 解压后仍缺 codegraph.js" -ForegroundColor Red
                        $err++
                    }
                }
            }
        }
    }

    # ── 3. 注册 Claude Code MCP ──
    Write-Host "  [mcp]" -ForegroundColor Cyan
    if (!(Test-Path $binEntry)) {
        Write-Host "    [skip ] codegraph 未安装，跳过 MCP 注册" -ForegroundColor DarkGray
    } else {
        $mcpRegistered = $false
        try {
            $mcpOut = & claude mcp get codegraph 2>&1
            if ($LASTEXITCODE -eq 0 -and ($mcpOut -match 'codegraph\.js')) {
                $mcpRegistered = $true
            }
        } catch {}

        if ($mcpRegistered) {
            Write-Host "    [skip ] MCP 已注册" -ForegroundColor DarkGray
            $skipped++
        } elseif ($IsDryRun) {
            Write-Host "    [DRYRUN] 将注册 codegraph MCP" -ForegroundColor Cyan
            $linked++
        } else {
            try {
                $nodeExe = $binNode -replace '\\', '/'
                $entryJs = $binEntry -replace '\\', '/'
                & claude mcp add codegraph -s user -- cmd /c "$nodeExe --liftoff-only $entryJs serve --mcp" 2>&1 | Out-Null
                Write-Host "    [add  ] MCP codegraph 已注册" -ForegroundColor Green
                $linked++
            } catch {
                Write-Host "    [error] MCP 注册失败: $_" -ForegroundColor Red
                $err++
            }
        }
    }

    # ── 4. init 当前项目（如有 $TargetPath 或 cwd 是 git 仓库）──
    $initTarget = if ($TargetPath -and (Test-Path $TargetPath)) { (Resolve-Path $TargetPath).Path } else { $null }
    if (-not $initTarget) {
        $cwd = (Get-Location).Path
        if (Test-Path (Join-Path $cwd ".git")) { $initTarget = $cwd }
    }

    if ($initTarget -and (Test-Path $binEntry)) {
        $cgDir = Join-Path $initTarget ".codegraph"
        Write-Host "  [init] $initTarget" -ForegroundColor Cyan
        if (Test-Path $cgDir) {
            Write-Host "    [skip ] .codegraph/ 已存在" -ForegroundColor DarkGray
            $skipped++
        } elseif ($IsDryRun) {
            Write-Host "    [DRYRUN] codegraph init $initTarget" -ForegroundColor Cyan
            $linked++
        } else {
            try {
                & $binNode $binEntry init $initTarget 2>&1 | Out-Null
                if (Test-Path $cgDir) {
                    Write-Host "    [done ] codegraph init 完成" -ForegroundColor Green
                    $linked++
                } else {
                    Write-Host "    [warn ] init 未生成 .codegraph/（可能项目太小）" -ForegroundColor Yellow
                }
            } catch {
                Write-Host "    [error] init 失败: $_" -ForegroundColor Red
                $err++
            }
        }
    }

    Write-Host ""
    Write-Host "  summary: done=$linked skipped=$skipped error=$err" -ForegroundColor Cyan
    return ($err -eq 0)
}

# ── IDE 终端配置 ──

function Invoke-SetTerminal {
    # 将 IDE 集成终端默认 profile 从 cmd.exe 切换为 Git Bash
    # 支持 Windsurf / Devin Desktop / VS Code / Cursor
    $gitBash = "C:\Program Files\Git\bin\bash.exe"
    if (!(Test-Path $gitBash)) {
        Write-Host "  [error] Git Bash not found: $gitBash" -ForegroundColor Red
        return
    }

    # 按优先级检测 IDE settings 目录
    $candidates = @(
        @{ Name = "Windsurf / Devin Desktop"; Dir = (Join-Path $env:APPDATA "Windsurf\User") },
        @{ Name = "VS Code";                  Dir = (Join-Path $env:APPDATA "Code\User") },
        @{ Name = "Cursor";                   Dir = (Join-Path $env:APPDATA "Cursor\User") }
    )

    $touched = 0
    foreach ($c in $candidates) {
        if (!(Test-Path $c.Dir)) { continue }
        $settingsFile = Join-Path $c.Dir "settings.json"
        Write-Host "  [$($c.Name)] $settingsFile" -ForegroundColor Cyan

        # 已经是 Git Bash？
        if ((Test-Path $settingsFile) -and
            (Get-Content $settingsFile -Raw -Encoding UTF8) -match '"terminal\.integrated\.defaultProfile\.windows"\s*:\s*"Git Bash"') {
            Write-Host "    [skip ] already Git Bash" -ForegroundColor DarkGray
            continue
        }

        # 用 node 安全处理 JSONC（settings.json 可能含注释/尾逗号）
        $nodeCode = @'
const fs=require("fs"),f=process.argv[1];
let t=fs.existsSync(f)?fs.readFileSync(f,"utf8"):"{}";
if(t.charCodeAt(0)===0xFEFF)t=t.slice(1);
t=t.replace(/\/\/.*$/gm,"").replace(/\/\*[\s\S]*?\*\//g,"").replace(/,(\s*[}\]])/g,"$1");
let o;try{o=JSON.parse(t)}catch(e){process.stderr.write("parse: "+e.message);process.exit(1)}
const prev=o["terminal.integrated.defaultProfile.windows"]||"(none)";
o["terminal.integrated.defaultProfile.windows"]="Git Bash";
fs.writeFileSync(f,JSON.stringify(o,null,4)+"\n","utf8");
console.log(prev);
'@
        $tmp = Join-Path $env:TEMP "dao-set-term-$([guid]::NewGuid().ToString('N').Substring(0,8)).cjs"
        try {
            $nodeCode | Out-File -Encoding utf8 $tmp
            $prev = (& node $tmp $settingsFile 2>&1)
            if ($LASTEXITCODE -ne 0) {
                Write-Host "    [error] $prev" -ForegroundColor Red
            } else {
                Write-Host "    [done ] $prev -> Git Bash" -ForegroundColor Green
                $touched++
            }
        } finally {
            Remove-Item $tmp -Force -ErrorAction SilentlyContinue
        }
    }

    if ($touched -eq 0 -and ($candidates | Where-Object { Test-Path $_.Dir }).Count -eq 0) {
        Write-Host "  [error] No IDE settings directory found" -ForegroundColor Red
        Write-Host "  Checked: $($candidates.Dir -join ', ')" -ForegroundColor Red
    }

    Write-Host ""
    Write-Host "  Restart IDE terminal (or open a new one) to apply." -ForegroundColor DarkGray
}

# ── 入口 ──

switch ($Action) {
    "status" {
        Invoke-Status
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
    "set-terminal" {
        Write-Host "`n  Setting IDE default terminal to Git Bash ..." -ForegroundColor Cyan
        Invoke-SetTerminal
    }
    "codegraph" {
        Write-Host "`n  CodeGraph: 检测 / 安装 / 注册 MCP ..." -ForegroundColor Cyan
        $ok = Invoke-Codegraph -IsDryRun:$DryRun.IsPresent
        if (-not $ok -and -not $DryRun.IsPresent) { exit 1 }
    }
    "sync" {
        Write-Host "  请直接运行 dao.bat（不带参数）进入配置同步菜单。" -ForegroundColor Yellow
        Write-Host "  dao.bat                      交互菜单" -ForegroundColor Gray
        Write-Host "  dao.bat --direction=down      下行恢复" -ForegroundColor Gray
        Write-Host "  dao.bat --deploy              重新部署" -ForegroundColor Gray
        Write-Host "  dao.bat --doctor              配置体检" -ForegroundColor Gray
        Write-Host "  dao.bat --persona             人设切换" -ForegroundColor Gray
    }
    "persona" {
        Write-Host "  请运行 dao.bat（不带参数）→ 选 persona 切换" -ForegroundColor Yellow
        Write-Host "  或: dao.bat --persona" -ForegroundColor Gray
    }
    default {
        Write-Host @"

  windsurf-dao tool

  Primary entry: dao.bat (double-click or CLI)
    dao.bat                                   Config sync interactive menu
    dao.bat --direction=down                  Sync: origin -> local
    dao.bat --deploy                          Redeploy skills/commands/hooks
    dao.bat --doctor                          Config health check
    dao.bat --persona                         Persona mode switch

  Actions (via dao.bat <action> or .\dao.ps1 <action>):
    status                                    Show dao source info and global link status
    codegraph [-DryRun]                       Install/repair CodeGraph + register MCP + init project
    codegraph <project-path>                  Install + init specified project
    link-claude [-DryRun]                     Deploy dao to Claude Code (~/.claude)
    unlink-claude [-DryRun]                   Remove dao from Claude Code
    link-codex [-DryRun]                      Mirror ~/.claude/skills into ~/.codex/skills
    unlink-codex [-DryRun]                    Remove Codex skill links
    link-codex-prompts [-DryRun]              Write dao prompts into ~/.codex/prompts
    unlink-codex-prompts [-DryRun]            Remove managed dao prompts
    set-terminal                              Set IDE terminal to Git Bash

  Examples:
    dao.bat                                   config sync (interactive menu)
    dao.bat status                            show deployment status
    dao.bat codegraph                         install/repair CodeGraph
    dao.bat link-claude                       deploy dao to Claude Code
    dao.bat link-claude -DryRun               preview deploy

"@
    }
}
