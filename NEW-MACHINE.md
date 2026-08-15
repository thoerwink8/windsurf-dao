# 换机部署指南

一台新机器，把 windsurf-dao 的环境恢复到与旧机一致。按顺序做，几步就完。

## 1. 拿仓库

```bash
git clone git@github.com:thoerwink8/windsurf-dao.git
cd windsurf-dao
```

克隆完即得全部内容：AI 协作约定（`CLAUDE.md`）、项目模板（`templates/`）、自检命令（`scripts/dao-check.mjs`）、道德经源文本（`docs/classics/`）。

## 2. 装 Node

自检命令 `node scripts/dao-check.mjs` 需要 Node.js（20.11 或更高，它用了 `import.meta.dirname`）。装完验证：

```bash
node --version
```

## 3. 放全局协作约定

`docs/global-CLAUDE.md` 是用户级 `~/.claude/CLAUDE.md` 的真相源副本。换机时手动放置（git 不带机器配置）：

- Windows：把 `docs/global-CLAUDE.md` 的内容放到 `%USERPROFILE%\.claude\CLAUDE.md`
- macOS / Linux：放到 `~/.claude/CLAUDE.md`

以后要改全局约定，改仓库里的 `docs/global-CLAUDE.md`，再同步到各机器。

## 4. 密钥类文件手动带

任何不进 git 的密钥类文件（API key、脱敏前的真实配置等），换机都要手动复制，git 不会带它们。原则：**能进 git 的都进 git，不能进 git 的手动带**。本仓库当前没有这类文件；若未来有，放在这里说明位置。

## 5. 模型配置

pi / Codex 各自的模型配置（API key、模型列表、中转站等）跟本仓库无关，照各自官方文档在本地配置：

- pi CLI：见其官方文档
- Codex CLI：见其官方文档

Claude Code（帅位）装机必设：`autoCompactWindow=500k`（1M 窗口的 50%，低于 100k 不收），且 cc-switch DB `common_config_claude` 同落，防下发覆盖；effortLevel 基准 high（以 live 为准，2026-08-14 拍板，issue #443）。

## 6. pi 怎么配

pi 是 DeepSeek 系工人的 CLI。装与验：

- npm 包名 `@mariozechner/pi-coding-agent`，命令是 `pi`；`@mariozechner/pi` 是另一个 vLLM 管理工具，别装错。
- `models.json` / `settings.json` 在 `~/.pi/agent/` 下：网关地址写占位（api key 只留占位，不进 git）；`supportsDeveloperRole: false` 是兼容项要留。
- `contextWindow` 故意声明得更小：pi 没有百分比压缩阈值，触发公式是「已用 > contextWindow − reserveTokens」，声明太大等于把压缩触发点推远。
- `deepseek-v4-flash` 勿用 `--tools` 裁掉 bash：裁掉后模型仍会幻觉调用 bash，把模型的工具调用标记当文本吐。
- 两条验证命令：
  - `pi --list-models`：预期列出模型表。
  - `pi --no-tools --no-session -p "只回复：OK"`：预期回 OK；失败先查 `~/.pi/agent/models.json` 里的网关地址与 key。一次性连通性测试用 `--no-tools` 无妨，日常跑活别裁工具。

## 7. grok 怎么配

grok（Grok Build，X 系的官方 CLI）是本仓写码类峰时主选、查证/外网信息类的试用模型，路由见 `docs/model-routing.toml`。**grok 单统一走 Grok Build，pi-grok 已退役**（2026-08-14 拍板，issue #443）：pi 的 xai provider 走公网 api.x.ai + auth.x.ai 刷 OAuth，整链依赖本机 clash，点将台盲考两次断线；Grok Build 走专用端点 cli-chat-proxy.grok.com（带客户端头、给免费额度）。2026-08-15 起装 regrok shim 后，`--agent grok` 直接可用（shim 把代理前缀和默认模型 grok-4.6 都包进去了），装机三条：

- npm 必须钉版本：`npm install -g @xai-official/grok@1.0.1`——`latest` 标签停在仅 macOS 的 0.1.4，不钉版本会装错。验证：`grok --version` 应回 `1.0.1`。
- regrok shim：在 `~/.local/bin/` 下放两个文件（覆盖 PATH 第一位，包装真实二进制 `C:\nvm4w\nodejs\grok.cmd`；真实二进制路径因机而异，shim 里改对即可）。shim 内置 `HTTPS_PROXY=http://127.0.0.1:7890`（grok CLI 不认 Windows 系统代理，auth.x.ai 有 DNS 污染，不带前缀连不上）并默认追加 `-m grok-4.6`；显式传 `-m/--model` 时原样透传不覆盖。验证：`where grok` 第一位应是 `~/.local/bin`，裸起 `grok` 服务端确认默认 4.6。
  - `~/.local/bin/grok.cmd`（Windows cmd 版）：
    ```bat
    @echo off
    rem regrok shim: proxy required (auth endpoint DNS-poisoned) + pin default model grok-4.6
    rem real binary: C:\nvm4w\nodejs\grok.cmd ; explicit -m/--model passes through untouched
    set HTTPS_PROXY=http://127.0.0.1:7890
    echo %* | findstr /C:"-m " /C:"--model" >nul
    if %errorlevel%==0 (
      "C:\nvm4w\nodejs\grok.cmd" %*
    ) else (
      "C:\nvm4w\nodejs\grok.cmd" -m grok-4.6 %*
    )
    ```
  - `~/.local/bin/grok`（Git Bash 版）：
    ```sh
    #!/bin/sh
    # regrok shim (Git Bash): proxy required (auth endpoint DNS-poisoned) + pin default model grok-4.6
    # real binary: C:/nvm4w/nodejs/grok.cmd ; explicit -m/--model passes through untouched
    export HTTPS_PROXY=http://127.0.0.1:7890
    case " $* " in
      *" -m "*|" --model"*) exec "C:/nvm4w/nodejs/grok.cmd" "$@" ;;
      *) exec "C:/nvm4w/nodejs/grok.cmd" -m grok-4.6 "$@" ;;
    esac
    ```
    注释保持纯 ASCII（两文件都是，勿写中文注释）。shim 装好后无需再手动加代理前缀——那是 regrok 之前的旧姿势。命令库 `docs/model-routing.toml` 的 `[providers.grok].launch` 走这层 PATH。
- auto 模式会硬拦 git push（对外发布闸），协调者授权词是往终端回一句「推」——与「工人自称被拦先令重试」的判据并列：假拦（网络抖动）=重试即过，真拦（宿主策略）=需授权词。

## 7b. command-code 怎么配

command-code（Command Code 官方 CLI）本仓用途 = **非交互查证/测速**（2026-08-16 帅·A 裁定：当前不能承载需进 git 的 Orca 工人，见 dispatch SKILL）。npm 包名就是 `command-code`，可执行文件 `command-code` 与别名 `cmdc` 同包两个入口；**没有 `cmd`**（会撞 Windows cmd.exe）。

- 装机：`npm i -g command-code`；验证：`command-code --version`（本机 v1.26.0）。
- **登录必须在真 TTY 里跑**（Ink raw mode）：`command-code login` 是浏览器交互流程，只能用户做；无 TTY 报 "Raw mode is not supported on the current process.stdin"。登录态落在 `~/.commandcode/auth.json`。验证：`command-code status` 应回 `Authenticated as <用户名>`。
- 模型列表（无需登录）：`command-code --list-models`（55 个模型，`deepseek/deepseek-v4-flash`、`deepseek/deepseek-v4-pro` 都在）；模型 id 两段式 `deepseek/deepseek-v4-flash`，`-m` 直传。
- 非交互契约：`command-code -p "问" --max-turns N --skip-onboarding` 输出纯文本、退出码 0；`--output-format json` 出 NDJSON 事件流 + 末尾 result 行。
- 自动化调用一律 `--skip-onboarding`（非交互撞 onboarding 会静默挂住，同 #500 型坑）；交互 TUI 启动后需补一记空回车才执行。

## 8. 本机工具坑

- playwright MCP 报 "Browser is already in use" 时：杀掉 `%LOCALAPPDATA%\ms-playwright-mcp\mcp-chrome-*` 对应的 chrome 进程，并删该目录下的 lockfile。
- 不可逆红线：覆写正在使用的 `~/.claude/settings.json` 可能触发 401 强制登出，把文件改回去也恢复不了——改它前先备份，AI 不得整文件覆写。

## 8b. git 编辑器/分页器兑底（#500，新机必做）

工人跑 `git rebase --continue` / `git commit`（无 -m）等命令时，git 会拉起编辑器——默认落到 vim 等 stdin，挂死 27 分钟无人叫（#500 实证：pi 工人 rebase 冲突全解后 git 拉起 vim，永远等不到输入）。帅的会话 shell 自带 `GIT_EDITOR=true`，工人的 pi 终端没有。**在仓库主 checkout 执行一次，worktrees 共享 .git/config 全覆盖：**

```bash
git config core.editor true    # 编辑器变 no-op：rebase --continue 用预填信息直接提交；裸 commit 空信息快速中止（不挂死）
git config core.pager cat      # 分页器变 cat：git log 等不再拉 less 等输入
```

验证（不是「已配置」，是实测不挂）：

```bash
git var GIT_EDITOR   # 应回 true
git -C <任意 worktree> var GIT_EDITOR   # worktree 继承主仓配置
# 构造一次会拉起编辑器的命令：rebase 造冲突→解完→rebase --continue，应在 1 秒内完成且保留提交信息
```

取舍说明：仓库级配置影响真人在同一仓库的手工 git 操作——无 `-m` 的 `git commit` 会快速中止而不是进编辑器（想要编辑器时显式 `git -c core.editor=... commit` 或设 `GIT_EDITOR` 临时覆盖）。本机是 AI 协作机器，挂死比空中止贵得多，选仓库级全覆盖；同域命令一并扫过：`git commit`（无 `-m`）、`git merge`、`git tag -a`、`git rebase -i`（todo 表用默认 pick 直接执行）、`gh pr create`（无 `--body`）都不再挂死。

## 9. 信箱台

Orca 未读横幅会强制接管输入框（issue #464）。新机一条命令重建哑终端 + 中继 + coordinator 归属：

```bash
node scripts/inbox-station.mjs ensure
```

全活着秒退，stdout 一行 JSON（runId / handle / 日志路径 / action）。身份判据（issue #493 返工）：归属从 `run-show` 的 `coordinator_handle` 取，**标题只出不进**——标题仍带 run 后缀（`信箱台·<run后缀>（勿关）`）但只是给人看，改名/被重置成 pwsh.exe 也不影响认台；默认日志按 run 隔离（`_flow/inbox-<run后缀>.log`，不传 `--log` 也天然安全）。本 run 的台 = coordinator_handle 对应的终端且租约新鲜（活不活看租约+PID）；本 run 台死了是 `action:restart`，撞上别的 run 的台（本 run coordinator 被别的 run 的活台占着）是 `action:reject`（报对方 run id）。帅的派工序是「run-use → 派工 → ensure 归还」——run-use 会夺走 coordinator，中继每轮自夺回，ensure 再跑一次把横幅交回信箱台。

## 10. 接上 memory

本机 Claude 项目 memory 写在 `~/.claude/projects/<编码后的仓库路径>/memory/`。编码规则：路径里**所有非 `[a-zA-Z0-9]` 字符一律换成 `-`**（点、空格、下划线、中文都算），不是只换盘符和斜杠。反例：`...\468-审官-gpt-5.6-sol` → `...-468----gpt-5-6-sol`（本机 `~/.claude/projects/` 下有这条真目录）。仓内 `host/memory/` 是真相源。

先关掉所有 Claude Code 窗口再跑（它可能占着 `memory/` 句柄，改名会失败）。在**主仓根**执行下面这段——只接你正在跑命令的那份克隆，Orca worktree 各有自己的 `projects/<编码>` 目录，不会一起接上。

**事前拦截**（含一层子目录，`-Recurse`）：本机是真目录时，脚本先核对本机每个文件是否都在仓内。本机有、仓内没有的文件会直接 throw，**不会改名、不会建 Junction**。同名但内容不同的只警告列出，仍会接上——接上后本机这几条变成仓内版本，旧内容留在改名备份目录里，需要就去比对。已是正确 Junction 则什么都不做。接上之后 Claude 每写一条 memory，主仓 `git status` 就会多一条未提交变更，随手提交，别攒，也别 `git stash` 把记忆藏起来。

```powershell
& {
  $ErrorActionPreference = 'Stop'
  $repo = (Resolve-Path .).Path
  $hostMem = Join-Path $repo 'host\memory'
  if (-not (Test-Path -LiteralPath $hostMem)) { throw "host/memory 不在: $hostMem" }
  $encoded = $repo -replace '[^a-zA-Z0-9]', '-'
  $local = Join-Path $env:USERPROFILE ".claude\projects\$encoded\memory"
  $want = [IO.Path]::GetFullPath($hostMem)
  $item = Get-Item -LiteralPath $local -Force -ErrorAction SilentlyContinue
  if ($item -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    $t = $item.Target; if ($t -is [array]) { $t = $t[0] }
    $got = if ($t) { try { [IO.Path]::GetFullPath([string]$t) } catch { [string]$t } } else { $null }
    if ($got -eq $want) { Write-Host "memory already linked: $local -> $want"; return }
    $item.Delete()
  } elseif ($item) {
    $norm = { param($p) ((Get-Content -LiteralPath $p -Raw -Encoding UTF8) -replace "`r`n", "`n").TrimEnd() }
    $relOf = {
      param($root, $full)
      $prefix = [IO.Path]::GetFullPath($root).TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
      return ([IO.Path]::GetFullPath($full).Substring($prefix.Length) -replace '\\', '/')
    }
    $missing = @(); $diverged = @()
    foreach ($f in Get-ChildItem -LiteralPath $local -File -Recurse) {
      $rel = & $relOf $local $f.FullName
      $peer = Join-Path $hostMem ($rel -replace '/', '\')
      if (-not (Test-Path -LiteralPath $peer)) { $missing += $rel }
      elseif ((& $norm $f.FullName) -cne (& $norm $peer)) { $diverged += $rel }
    }
    if ($missing.Count -gt 0) {
      throw "仓内不是本机超集，先把这些拷进 host/memory/ 再接: $($missing -join ', ')"
    }
    if ($diverged.Count -gt 0) {
      Write-Warning "同名但内容不同（接上后本机这几条会变成仓内版本，旧内容留在备份目录里，需要就去比对）: $($diverged -join ', ')"
    }
    $bak = "$local.bak-$(Get-Date -Format yyyyMMddHHmmss)"
    Rename-Item -LiteralPath $local -NewName (Split-Path $bak -Leaf)
    Write-Host "backed up $local -> $bak"
  }
  New-Item -ItemType Directory -Path (Split-Path $local -Parent) -Force | Out-Null
  New-Item -ItemType Junction -Path $local -Target $want | Out-Null
  Write-Host "linked $local -> $want"
}
```

本机若有比仓新的条目，先从改名备份里拷进 `host/memory/` 再提交。

接上后跑 `node scripts/dao-check.mjs` 自检：第 ⑨ 项「本机 memory 断链检查」应变绿——本机 memory 是普通目录/指向别处/链接悬空都会报红，CI 无本机目录则出 SKIP（不是绿）。

## 11. 接上 skills

skills 是逐个 SymbolicLink 直连 `host/skills/<name>`，没有自愈脚本（`dao.ps1` 已随 #425 退役）。在**主仓根**执行，把仓内每个 skill 接到 `~/.claude/skills/`：

建 SymbolicLink 需要开发者模式或管理员权限（Windows）。本机同名的**真目录**（插件自带的 skill，如 `orca-cli`）只警告不动——脚本绝不删本机目录，要换成仓内版本得自己先移走。

```powershell
& {
  $ErrorActionPreference = 'Stop'
  $src = Join-Path (Resolve-Path .).Path 'host\skills'
  if (-not (Test-Path -LiteralPath $src)) { throw "host/skills 不在: $src" }
  $dstRoot = Join-Path $env:USERPROFILE '.claude\skills'
  New-Item -ItemType Directory -Path $dstRoot -Force | Out-Null
  foreach ($s in Get-ChildItem -LiteralPath $src -Directory) {
    $want = $s.FullName
    $dst = Join-Path $dstRoot $s.Name
    $item = Get-Item -LiteralPath $dst -Force -ErrorAction SilentlyContinue
    if ($item -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
      $t = $item.Target; if ($t -is [array]) { $t = $t[0] }
      $got = if ($t) { try { [IO.Path]::GetFullPath([string]$t) } catch { [string]$t } } else { $null }
      if ($got -eq $want) { Write-Host "ok   $($s.Name)"; continue }
      $item.Delete()
    } elseif ($item) {
      Write-Warning "跳过 $($s.Name)：本机是真目录（可能是插件自带），先移走再重跑"
      continue
    }
    New-Item -ItemType SymbolicLink -Path $dst -Target $want | Out-Null
    Write-Host "link $($s.Name) -> $want"
  }
}
```

验证：`ls ~/.claude/skills` 里每个仓内 skill 都在；`grill-ai` 在 = 从零拷问兜底令随机器带走了。

## 12. Orca 快捷命令：从零拷问

清单本体已随 `grill-ai` skill 入仓（第 11 节接上即得），Orca 按钮只留一个触发器，**不再复制清单正文**——两处维护必然分叉。换机后在 Orca 里重建一条智能体提示（Claude）：

- 标签：`从零拷问（不对劲就按我）`
- 类型：智能体提示（Claude）
- 提示词全文：

```
用户觉得当前做法不对劲。立即停下手头动作，读 grill-ai skill 并按它的五条清单逐条自查回答。
```

## 12. 专注/值守态注入（hook + `/dao-mode` skill）

三态开关（常态 / 专注 / 值守）靠两件东西：`/dao-mode` skill 负责切，UserPromptSubmit hook 负责**每轮把当前态注入上下文**。
承重的是 hook——skill 的字只在调用那一轮进上下文，不装 hook 等于「我说我专注了」。设计与拍板记录见 issue #488。

**① 一条 SymbolicLink，装完就齐**。`host/skills/dao-mode/` 同时是一个 Claude Code 插件（自带
`.claude-plugin/plugin.json` 与 `hooks/hooks.json`），链到 `~/.claude/skills/` 下之后宿主会自动加载成
`dao-mode@skills-dir`，skill 和 hook 一起生效：

```powershell
$repo = 'D:\frank\windsurf-dao'   # 换成本机主仓路径
New-Item -ItemType SymbolicLink -Force -Path "$env:USERPROFILE\.claude\skills\dao-mode" -Target "$repo\host\skills\dao-mode" | Out-Null
```

下次开 Claude Code 生效（当前会话里可以 `/reload-plugins`）。

**这条命令必须用 PowerShell 7（`pwsh`）跑**：同一条 `New-Item -ItemType SymbolicLink` 在 Windows PowerShell 5.1
（`powershell.exe`，双击默认打开的那个）会报 `Administrator privilege required for this operation` 而失败，pwsh 7 下正常。
2026-08-15 实测，装机脚本里也别用 5.1 建这条链。

**② 不要去改 `settings.json`**。2026-08-15 实测过三条路，结论：

- **插件面（上面这条 link）生效，且完全不碰 `settings.json`** —— 装完 `enabledPlugins` 与 `hooks` 段一个字没变，新会话第一轮就拿到态文本。
- 用户级 `~/.claude/settings.local.json` 的 `hooks` 段**宿主根本不读**（注册在那儿，新会话上下文里一个字都没有；同一条注册放进项目级 `.claude/settings.local.json` 立刻生效）。
- `~/.claude/settings.json` 能生效，但它是本页第 8 条那条红线文件（覆写可能触发 401 强制登出，改回去也恢复不了），且被 cc-switch 下发 / Orca 写 hooks / CC 本体重置三方互相覆盖。既然插件面够用，就不碰它。

**③ 验**：`node scripts/dao-check.mjs` 第 ⑧ 项会把装载面上那条命令真跑四次（四种状态文件各一次：读到且常态 /
读到且非常态 / 文件不在 / 文件坏了），四种输出两两同形、跑不动、或哪个装载面都点不到，都报红。
链接断了（比如仓库换了位置、worktree 被删）就是这么被抓出来的——重跑 ① 即可。

状态文件是 `~/.claude/state.json`，跨会话跨工作区唯一，由 `dao-mode.mjs` 独家读写，不要手改。

## 统一命令库

起终端和编排不要手拼 orca 命令（手打 `codex -a never` 会把 gh/node 拦死、写不存在的 `--submit` 都在这里栽过）。走：

```bash
node scripts/dao.mjs --help
node scripts/dao.mjs start --provider gpt --worktree active --dry-run
node scripts/dao.mjs dispatch --name "卡名" --merge-policy auto --model grok-4.6 --reviewer gpt-5.6-sol --spec "短摘要" --dry-run
```

派工默认 `merge-policy: auto`（#511 拍板：帅只感知不再是关口）；选 `manual` 必须带 `--merge-reason <理由>`（只限改协作约定 / 改 model-routing.toml 决策字段 / 花钱三类），理由写进任务卡 comment 留痕。另必须带 `--model` 或 `--role`、`--reviewer`、`--spec`，缺一就停。启动模板只在 `docs/model-routing.toml` 的 `[providers.*].launch`。逃生口 `node scripts/dao.mjs raw -- <命令>` 会记一笔到 `_flow/cmd-escape.jsonl`。
## 自检

做完跑一遍：

```bash
node scripts/dao-check.mjs
```

退出码 0 = 环境就绪。
