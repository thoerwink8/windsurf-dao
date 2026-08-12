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

function Test-CcSwitchStoreTarget {
    # ~/.codex/skills 的**写入方归属判据**(用户 2026-07-27 拍板:归 cc-switch store)。
    #
    # 治的病:该目录此前有两个写入方按不同真相源争夺——cc-switch 链到 ~/.cc-switch/skills/,
    # link-codex 链到 ~/.claude/skills/,而 link-codex 的 override 分支会**主动覆盖**前者。
    # 谁最后跑谁赢 ⇒ 同一个 skill 名在 Codex 里指向什么,取决于运行顺序而非任何声明。
    #
    # 强形态落地后(见 Invoke-CodexSkillsReport 头注),dao.ps1 已不再往该目录写任何东西,
    # 本判据因此只剩**报告用途**:在 status / link-codex 报告里把条目归到「store 所有」一栏。
    # 它不再决定任何写动作的去留——写动作只剩 unlink-codex 的删除方向,那边按
    # 「dao 自己建的链 + 悬空链」判定,不看本函数。
    #
    # 判据是**前缀匹配**,不是等值:store 下每个 skill 各占一个子目录。
    # 近似性说明:仅按路径前缀认定归属,不校验链是否真由 cc-switch 所建——
    # 用户手工在 store 下建的链同样会被算作 store 所有(这是预期,store 即归属地);
    # 反方向,cc-switch 若改用别的 store 路径,本判据认不出来,那些条目会在报告里落到「其他」一栏。
    param([object]$Target)
    if (-not $Target) { return $false }
    $t = @($Target)[0]
    if ([string]::IsNullOrWhiteSpace($t)) { return $false }
    $store = (Join-Path $env:USERPROFILE ".cc-switch\skills") -replace '/', '\'
    $store = $store.TrimEnd('\').ToLowerInvariant()
    $norm = ([string]$t -replace '/', '\').TrimEnd('\').ToLowerInvariant()
    return $norm.StartsWith($store + '\')
}

function Get-ClaudeSkillTargets {
    # ~/.claude/skills 下每个 skill 条目的**解析后目标**集合(条目本身是软链时取其目标)。
    # 用途:判定 ~/.codex/skills 里某条链是不是 dao 自己建的——dao 建链时写的是解析后的目标,
    # 所以光比对 ~/.claude/skills 路径前缀会漏掉「~/.claude/skills/x 是软链、codex 侧直指其目标」那一类。
    param([string]$SrcDir)
    $targets = @{}
    if (-not (Test-Path $SrcDir)) { return $targets }
    Get-ChildItem $SrcDir -Force -ErrorAction SilentlyContinue | Where-Object {
        $_.PSIsContainer -or (Test-Path (Join-Path $_.FullName "SKILL.md") -PathType Leaf)
    } | ForEach-Object {
        $target = $_.FullName
        if (($_.LinkType -in "SymbolicLink", "Junction") -and $_.Target) {
            $targetPath = @($_.Target)[0]
            if (Test-Path -LiteralPath $targetPath -PathType Container) {
                $target = $targetPath
            }
        }
        $targets[$target] = $true
    }
    return $targets
}

function Get-CodexLinkClass {
    # ~/.codex/skills 单个条目的归类。**判据单一源**:unlink-codex 按此决定删/留,
    # status 与 link-codex 报告按此计数——报告说「会被清掉几条」和 unlink 真会清掉几条因此不分叉。
    # (此前报告按路径前缀数、unlink 按解析目标数,同一条链两处归类不同。)
    #   dao      : dao 自己建的链(目标落在 ~/.claude/skills 下,或等于其条目的解析目标)
    #   dangling : 目标已不存在的坟(旧代目录改名遗留)
    #   store    : cc-switch store 拥有的链(见 Test-CcSwitchStoreTarget 的近似性说明)
    #   other    : 其他软链——用户或第三方所建,dao 一概不碰
    #   real     : 真实文件/目录,不是链
    # 顺序即优先级,与 unlink-codex 原有行为一致:dao 判定先于 dangling(dao 自建链即使目标没了
    # 也按 dao 清),dangling 先于 store(目标已死的 store 链同样按坟清掉)。
    param([object]$Entry, [string]$SrcDir, [hashtable]$ManagedTargets)
    if ($Entry.LinkType -notin "SymbolicLink", "Junction") { return "real" }
    $t = if ($Entry.Target) { @($Entry.Target)[0] } else { $null }
    if (-not $t) { return "other" }
    if (($t -like "$SrcDir*") -or $ManagedTargets.ContainsKey($t)) { return "dao" }
    if (-not (Test-Path -LiteralPath $t)) { return "dangling" }
    if (Test-CcSwitchStoreTarget $t) { return "store" }
    return "other"
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

        # ── Codex 侧 skills 现状(只报告,不催跑:该目录的写入方是 cc-switch store)──
        # dao.ps1 已退出 ~/.codex/skills 的写入业务,故这一栏不再是「dao 的部署状态」,
        # 而是「一个外部拥有的目录当前长什么样」。唯一还指向 dao 动作的提示是清理方向的
        # unlink-codex(清 dao 早年自己建的链 + 悬空坟),不存在任何催跑建链的话术。
        $userCodex = Join-Path $env:USERPROFILE ".codex"
        $codexSkillsDir = Join-Path $userCodex "skills"
        $userClaudeSkillsDir = Join-Path $userClaude "skills"
        $codexManagedTargets = Get-ClaudeSkillTargets $userClaudeSkillsDir
        $codexClasses = @(Get-ChildItem $codexSkillsDir -Force -ErrorAction SilentlyContinue | ForEach-Object {
            Get-CodexLinkClass -Entry $_ -SrcDir $userClaudeSkillsDir -ManagedTargets $codexManagedTargets
        })
        $codexCcSwitch = @($codexClasses | Where-Object { $_ -eq "store" }).Count
        # 「可清」= unlink-codex 会删的那些(dao 自建链 + 悬空坟),用同一判据算,
        # 免得这行报了个数而 unlink 实际清出另一个数。
        $codexRemovable = @($codexClasses | Where-Object { $_ -in "dao", "dangling" }).Count
        if ($codexCcSwitch -gt 0 -and $codexRemovable -gt 0) {
            Write-Host "  Codex skills: cc-switch store owns it ($codexCcSwitch skills); $codexRemovable dao/dangling links left (clear: dao.ps1 unlink-codex)" -ForegroundColor Yellow
        } elseif ($codexCcSwitch -gt 0) {
            Write-Host "  Codex skills: cc-switch store owns it ($codexCcSwitch skills)" -ForegroundColor Green
        } elseif ($codexRemovable -gt 0) {
            Write-Host "  Codex skills: $codexRemovable dao/dangling links, no cc-switch store entry (clear: dao.ps1 unlink-codex; deploy via cc-switch)" -ForegroundColor Yellow
        } else {
            # 不判红:dao.ps1 不写这个目录,「没有 dao 链」不是 dao 侧的缺件。
            Write-Host "  Codex skills: no dao/store links detected (this directory is deployed by cc-switch, not dao.ps1)" -ForegroundColor Gray
        }
    }
}

function Get-InternalOnlySkills {
    # **不部署为用户 `/` 命令**的 skill（2026-07-27 用户拍板的生态减法）。
    #
    # 它们仍留在 ccswitch/skills/ 原地、内容一字未动，仍由 dao-superpowers / dao-loop
    # 与 dao-plan-writer / dao-reviewer 等 subagent 人格**按路径 Read**（那些人格的 ⭐
    # 方法论真相源就指着这几个 SKILL.md），只是不再 symlink 进 ~/.claude/skills/。
    #
    # 判据是**使用面不是引用面**：这四个在 ~/.claude/history.jsonl（用户键盘全史）里
    # 零调用，在 ~/.claude/projects/**/*.jsonl 里仅 dao-brainstorm 有 1 次 AI 发起的
    # Skill 调用。把它们摆在用户命令表上只是噪音。
    #
    # ⚠ **本清单只管「部署与否」，不管「存在与否」**——往这里加名字 = 从用户面收起来，
    # 不等于删除；真要删除必须先查使用面并过用户（本仓两次误删实证，见 README 退役纪律）。
    return @(
        "dao-worktree",
        "dao-plan",
        "dao-review",
        "dao-brainstorm"
    )
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

    # ── 收起「AI 内部件」的旧链接（自愈，幂等）────────────────────────────
    # **只处理这一类**：源文件还在、只是不再部署（Get-InternalOnlySkills）。
    # 「源文件已删」那一类不在这里——本函数每个 spec 循环末尾已有 prune 段
    # （`$_.Name -notin $srcNames` → [prune] source removed），退役一个 command
    # 的链接由它负责；两处各管一半，别重复实现（重复的那版会先删一次、prune 再
    # 空跑一次，输出里出现两行看起来像两件事的日志）。
    $internalSkills = Get-InternalOnlySkills
    $internalDst = Join-Path $userClaude "skills"
    if (Test-Path $internalDst) {
        foreach ($entry in @(Get-ChildItem $internalDst -Force -ErrorAction SilentlyContinue |
                Where-Object { $_.LinkType -in "SymbolicLink", "Junction" } |
                Where-Object { $internalSkills -contains $_.Name })) {
            if ($IsDryRun) {
                Write-Host "    [DRYRUN] unlink $($entry.Name)  (AI 内部件，不再部署为用户命令)" -ForegroundColor Yellow
                continue
            }
            try {
                if ($entry.PSIsContainer) { $entry.Delete() } else { Remove-Item $entry.FullName -Force }
                Write-Host "    [unlink] $($entry.Name)  (AI 内部件，不再部署为用户命令)" -ForegroundColor Yellow
            } catch {
                Write-Host "    [error] unlink $($entry.Name) : $_" -ForegroundColor Red
                $err++
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
            # AI 内部件不部署（判据与理由见 Get-InternalOnlySkills）。
            if ($spec.Name -eq "skills" -and ($internalSkills -contains $it.Name)) {
                Write-Host "    [inner] $($it.Name)  (AI 内部件，按路径 Read，不进用户命令表)" -ForegroundColor DarkGray
                $skipped++
                continue
            }
            $linkPath = Join-Path $dstDir $it.Name
            if (Test-Path $linkPath) {
                $existing = Get-Item $linkPath -Force
                if ($existing.LinkType -in "SymbolicLink", "Junction") {
                    if ($existing.Target -eq $it.FullName) {
                        Write-Host "    [skip ] $($it.Name)  (already linked)" -ForegroundColor DarkGray
                        $skipped++
                        continue
                    }
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

    # ── 复制 styles/ 到 ~/.claude/output-styles/（Claude Code 真实加载位；
    # 旧版误写 ~/.claude/styles/ 是送错门，fortify2-20260726 D2 订正）──
    $stylesSrc = Join-Path $claudeSrc "styles"
    if (Test-Path $stylesSrc) {
        $stylesDst = Join-Path $userClaude "output-styles"
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

    # ── settings.json 键位（outputStyle/hooks/permissions 等）统一归 cc-switch 单引擎 ──
    # dao.ps1 不再直接写 ~/.claude/settings.json（fortify2-20260726 D3 退役：原 outputStyle
    # 直写段 + dao-glob-gate/dao-cn-title 两段 hook 注册段共 ~140 行，均是 common_config_claude
    # 快照早已完整覆盖的键位——env/permissions/model/hooks/statusLine/enabledPlugins/theme/
    # enableWorkflows/includeCoAuthoredBy/outputStyle 全部由 cc-switch 下发，版本化备份/恢复
    # 由 config-sync 模块负责）。裸机场景（未装 cc-switch）只提示，不代写。
    if (-not (Test-Path $settingsPath)) {
        Write-Host "  [settings] 未检测到 ~/.claude/settings.json —— 请运行 cc-switch 下发配置（outputStyle/hooks 等键位统一由其管理）" -ForegroundColor Yellow
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

    Write-Host ""
    Write-Host "  summary: linked=$linked skipped=$skipped conflict=$conflict error=$err" -ForegroundColor Cyan
    Write-Host "  Claude Code: restart session (or /clear) to pick up new skills/commands/agents." -ForegroundColor DarkGray
    # fortify2-20260726 D4：部署有失败不许静默退出 0——调用方（sync.mjs/dao.bat）靠退出码
    # 判断是否要把「🟢 完成」降级成「⚠ 部署有 N 处失败」。
    if ($err -gt 0) { exit 1 }
}

function Invoke-CodexSkillsReport {
    # link-codex 的**强形态**(用户 2026-07-27 拍板):dao.ps1 退出 ~/.codex/skills 的写入业务。
    # 本函数只读:不建链、不删链、不改任何文件——一次调用后该目录应当逐字节不变。
    #
    # 三态沿革:
    #   ① 争夺态:link-codex 主动覆盖 cc-switch 建的链。两个写入方按不同真相源写同一目录,
    #      同名 skill 在 Codex 里指向什么取决于谁最后跑,而不取决于任何声明。
    #   ② 补位态(3722bab):撞名让行,只补 store 没有的名字。仍是第二个写入方——
    #      让行只是不抢已占的名字,新名字照写,目录的内容依旧由「跑没跑过 link-codex」决定。
    #   ③ 本形态:一行不写。写入方只剩 cc-switch store 一个。
    #
    # 为什么保留动作名而不是删掉 switch 分支:link-codex 在用户记忆和历史文档里 = 「把 skills 弄进 Codex」。
    # 删掉分支会让这条命令掉进通用 help,读不到「为什么没了」,可能转而手工建链——那正是要消灭的第二写入方。
    # 故降级为只读诊断:声明归属 + 报告现状 + 明写本次退出所放弃的能力(store 未覆盖的名字),不藏代价。
    #
    # 清理归 unlink-codex(dao 自建链 + 悬空坟),那是 dao.ps1 在该目录仅存的写动作,方向只有删。
    $userClaude = Join-Path $env:USERPROFILE ".claude"
    $srcDir = Join-Path $userClaude "skills"
    $storeDir = Join-Path $env:USERPROFILE ".cc-switch\skills"
    $dstDir = Join-Path (Join-Path $env:USERPROFILE ".codex") "skills"

    Write-Host "  [read-only] dao.ps1 does not write ~/.codex/skills (writer: cc-switch store)" -ForegroundColor Yellow
    Write-Host "  Deploy Codex skills through cc-switch -> $storeDir" -ForegroundColor DarkGray
    Write-Host ""

    if (!(Test-Path $dstDir)) {
        Write-Host "  ~/.codex/skills: not present ($dstDir)" -ForegroundColor DarkGray
        return
    }

    $entries = @(Get-ChildItem $dstDir -Force -ErrorAction SilentlyContinue)
    $managedTargets = Get-ClaudeSkillTargets $srcDir
    $classes = @($entries | ForEach-Object { Get-CodexLinkClass -Entry $_ -SrcDir $srcDir -ManagedTargets $managedTargets })
    $countOf = { param($c) @($classes | Where-Object { $_ -eq $c }).Count }
    $legacyCount = & $countOf "dao"
    $danglingCount = & $countOf "dangling"

    Write-Host "  ~/.codex/skills: $($entries.Count) entries" -ForegroundColor Cyan
    Write-Host "    cc-switch store links : $(& $countOf 'store')" -ForegroundColor DarkGray
    Write-Host "    legacy dao links      : $legacyCount  (dao built these before the retirement)" -ForegroundColor DarkGray
    Write-Host "    dangling (dead target): $danglingCount" -ForegroundColor DarkGray
    Write-Host "    other links           : $(& $countOf 'other')  (someone else's; dao does not touch them)" -ForegroundColor DarkGray
    Write-Host "    real files/dirs       : $(& $countOf 'real')" -ForegroundColor DarkGray
    if ($legacyCount -gt 0 -or $danglingCount -gt 0) {
        Write-Host "  Clear those $($legacyCount + $danglingCount) with: dao.ps1 unlink-codex" -ForegroundColor Yellow
    }

    # 本次退出所放弃的能力,明写不藏:~/.claude/skills 里有、~/.codex/skills 里没有同名条目的那些。
    # 这是**名字集差集**,不是「Codex 看不见它们」的判定——同一能力可能经别的机制到达 Codex。
    if (Test-Path $srcDir) {
        $present = @{}
        foreach ($e in $entries) { $present[$e.Name] = $true }
        $gap = @(Get-ChildItem $srcDir -Force -ErrorAction SilentlyContinue | Where-Object {
            $_.PSIsContainer -or (Test-Path (Join-Path $_.FullName "SKILL.md") -PathType Leaf)
        } | Where-Object { -not $present.ContainsKey($_.Name) } | ForEach-Object { $_.Name })
        Write-Host ""
        if ($gap.Count -eq 0) {
            Write-Host "  Every ~/.claude/skills name has a ~/.codex/skills entry." -ForegroundColor DarkGray
        } else {
            $shown = if ($gap.Count -gt 8) { (($gap[0..7]) -join ", ") + ", ... (+$($gap.Count - 8) more)" } else { $gap -join ", " }
            Write-Host "  $($gap.Count) name(s) in ~/.claude/skills have no ~/.codex/skills entry:" -ForegroundColor DarkGray
            Write-Host "    $shown" -ForegroundColor DarkGray
            Write-Host "  Filling these used to be link-codex's job; add them to the cc-switch store if Codex needs them." -ForegroundColor DarkGray
        }
    }
}

function Invoke-UnlinkCodex {
    # 卸载 codex 侧 Claude skill 软链。只删指向 ~/.claude/skills 管理源的软链,不碰用户真实文件。
    # 强形态落地后这是 dao.ps1 在 ~/.codex/skills 仅存的写动作,且方向只有删:
    # 清 dao 自己早年建的链(managed)+ 清悬空坟(dangling)。cc-switch store 的链两条都不命中,保留。
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
    $managedTargets = Get-ClaudeSkillTargets $srcDir
    Get-ChildItem $dstDir -Force -ErrorAction SilentlyContinue | ForEach-Object {
        $target = if ($_.Target) { @($_.Target)[0] } else { $null }
        # 归类走 Get-CodexLinkClass 单一判据源(status / link-codex 报告用的是同一个)。
        # fortify2-20260726 D7：dangling 类 = readlink 目标不存在即删——只清坟，不动写入方取舍。
        # 旧代目录改名（windsurf-dao/claude/ → ccswitch/）后遗留的悬空链既不匹配当前 $srcDir 前缀
        # 也不在 managedTargets 里，此前会被误判「not a dao symlink」永久保留（60 个悬空链实证：
        # readlink 目标全部指向早已不存在的 windsurf-dao/claude/skills/ 旧路径）。
        $class = Get-CodexLinkClass -Entry $_ -SrcDir $srcDir -ManagedTargets $managedTargets
        if ($class -in "dao", "dangling") {
            $label = if ($class -eq "dao") { "unlink" } else { "prune " }
            $suffix = if ($class -eq "dangling") { "  (dangling target: $target)" } else { "" }
            if ($IsDryRun) {
                Write-Host "    [DRYRUN] $label $($_.Name)$suffix" -ForegroundColor Cyan
                $removed++
            } else {
                try {
                    if ($_.PSIsContainer) { $_.Delete() } else { Remove-Item $_.FullName -Force }
                    Write-Host "    [$label] $($_.Name)$suffix" -ForegroundColor Green
                    $removed++
                } catch {
                    Write-Host "    [error] $($_.Name) : $_" -ForegroundColor Red
                    $err++
                }
            }
        } else {
            Write-Host "    [keep ] $($_.Name)  (not a dao link: $class)" -ForegroundColor DarkGray
            $skipped++
        }
    }
    Write-Host ""
    Write-Host "  summary: removed=$removed skipped=$skipped error=$err" -ForegroundColor Cyan
    Write-Host "  Codex: restart session to apply. ~/.claude/skills and Claude deployment files are untouched." -ForegroundColor DarkGray
}

function Get-CodexPromptNames {
    # 高频手动 dao 入口在 Codex 侧的镜像。**名字必须有对应的 ~/.claude/commands/<name>.md**，
    # 否则 Invoke-LinkCodexPrompts 只会每次打印一行 [skip]（静默失效，没人会注意到）。
    # 2026-07-27：`dao-evolve` 退役（正文并入 dao-evolution/system-review.md），同批移出本表；
    # 同域的手动入口 `dao-distill` 保留在 Claude 侧，是否要镜像进 Codex 未有需求出处，不预先加。
    return @(
        "dao-superpowers",
        "dao-dev",
        "dao-commit"
    )
}

function New-ManagedCodexPrompt {
    # 扩展点：为没有对应 ~/.claude/commands/<name>.md 源文件的条目生成 Codex prompt 内容。
    # fortify2-20260726 D6 移除了 dao-philosophy 特判（该 skill 已死，死 prompt 一并清理）；
    # 当前 Get-CodexPromptNames 里的条目均有真实 Claude command 源文件，故本函数恒返回 $null。
    param([string]$Name)
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
            $isManagedFile = -not $isLink -and ($existingText -match 'codex-managed:\s*windsurf-dao' -or $existingText -match '<!--\s*codex-managed:\s*windsurf-dao\s*-->')
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

    # ── prune：清掉「我们写过、但已不在管理清单里」的 Codex prompt ──────────
    # 病灶（2026-07-27 实测）：`dao-evolve` 退役后，~/.codex/prompts/dao-evolve.md
    # 仍带着 codex-managed 标记躺在那里——link 只按清单写、unlink 也只按清单删，
    # **两个方向都不会碰一个已经离开清单的名字**，于是用户在 Codex 侧仍能敲出
    # 一个已死的流程，且没有任何机制会报出来。与 link-claude 的 [prune] 段同形。
    # 判据刻意收窄为「带 managed 标记」：用户自己写的同名 prompt 不归我们删。
    $managedNames = @(Get-CodexPromptNames)
    if (Test-Path $dstDir) {
        foreach ($f in @(Get-ChildItem $dstDir -File -Filter "*.md" -ErrorAction SilentlyContinue)) {
            $base = [System.IO.Path]::GetFileNameWithoutExtension($f.Name)
            if ($managedNames -contains $base) { continue }
            $body = Get-Content -LiteralPath $f.FullName -Raw -Encoding UTF8 -ErrorAction SilentlyContinue
            if ($null -eq $body -or -not ($body -match 'codex-managed:\s*windsurf-dao')) { continue }
            if ($IsDryRun) {
                Write-Host "    [DRYRUN] prune $base  (managed but no longer in Get-CodexPromptNames)" -ForegroundColor Yellow
                continue
            }
            try {
                Remove-Item $f.FullName -Force
                Write-Host "    [prune] $base  (managed but no longer in Get-CodexPromptNames)" -ForegroundColor Yellow
            } catch {
                Write-Host "    [error] prune $base : $_" -ForegroundColor Red
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
        $isManagedFile = -not ($existing.LinkType -in "SymbolicLink", "Junction") -and ($existingPromptText -match 'codex-managed:\s*windsurf-dao' -or $existingPromptText -match '<!--\s*codex-managed:\s*windsurf-dao\s*-->')
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

    $settingsPath = Join-Path $userClaude "settings.json"
    if (Test-Path $settingsPath) {
        Write-Host "  [hook]" -ForegroundColor Cyan

        # ── 移除 settings.json 里的 dao-cn-title hook ──
        # 2026-08-12（issue #324 B 批）删掉了这上面同型的 dao-glob-gate 摘除段：
        # 那个 hook 本身已随 A 批退役、仓里与下发快照里都没有了，那 7 处代码从此永远走 else 分支。
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

            if (Test-Path $installDir) {
                Remove-Item -Recurse -Force $installDir -Confirm:$false -ErrorAction SilentlyContinue
            }
            Ensure-Dir $installDir

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
    "check" {
        # 全系统唯一体检命令。二值退出（0 好 / 1 坏），契约在 scripts/dao-check.mjs 头注。
        & node (Join-Path $DaoRoot "scripts/dao-check.mjs")
        exit $LASTEXITCODE
    }
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
        # 强形态(2026-07-27 拍板):本动作不再写 ~/.codex/skills,只报告归属与现状。
        # 不再有 Test-SymlinkSupport 前置——只读诊断不需要 symlink 权限。
        Write-Host "`n  ~/.codex/skills ownership report (dao.ps1 writes nothing here) ..." -ForegroundColor Cyan
        Invoke-CodexSkillsReport
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
    check                                     体检：这套系统现在是好的吗（exit 0 好 / 1 坏）
    status                                    Show dao source info and global link status
    codegraph [-DryRun]                       Install/repair CodeGraph + register MCP + init project
    codegraph <project-path>                  Install + init specified project
    link-claude [-DryRun]                     Deploy dao to Claude Code (~/.claude)
    unlink-claude [-DryRun]                   Remove dao from Claude Code
    link-codex                                Report ~/.codex/skills ownership (read-only; cc-switch store owns it)
    unlink-codex [-DryRun]                    Remove dao-built Codex skill links + prune dangling ones
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
