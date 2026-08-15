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

grok（Grok Build，X 系的官方 CLI）是本仓写码类峰时主选、查证/外网信息类的试用模型，路由见 `docs/model-routing.toml`。**grok 单统一走 Grok Build，pi-grok 已退役**（2026-08-14 拍板，issue #443）：pi 的 xai provider 走公网 api.x.ai + auth.x.ai 刷 OAuth，整链依赖本机 clash，点将台盲考两次断线；Grok Build 走专用端点 cli-chat-proxy.grok.com（带客户端头、给免费额度）。装机三条：

- npm 必须钉版本：`npm install -g @xai-official/grok@1.0.1`——`latest` 标签停在仅 macOS 的 0.1.4，不钉版本会装错。验证：`grok --version` 应回 `1.0.1`。
- 启动命令必须带代理前缀：`HTTPS_PROXY=http://127.0.0.1:7890 grok ...`——grok CLI 不认 Windows 系统代理，auth.x.ai 有 DNS 污染，不带前缀连不上。PowerShell 写法：`$env:HTTPS_PROXY = 'http://127.0.0.1:7890'; grok ...`。
- auto 模式会硬拦 git push（对外发布闸），协调者授权词是往终端回一句「推」——与「工人自称被拦先令重试」的判据并列：假拦（网络抖动）=重试即过，真拦（宿主策略）=需授权词。

## 8. 本机工具坑

- playwright MCP 报 "Browser is already in use" 时：杀掉 `%LOCALAPPDATA%\ms-playwright-mcp\mcp-chrome-*` 对应的 chrome 进程，并删该目录下的 lockfile。
- 不可逆红线：覆写正在使用的 `~/.claude/settings.json` 可能触发 401 强制登出，把文件改回去也恢复不了——改它前先备份，AI 不得整文件覆写。

## 9. 信箱台

Orca 未读横幅会强制接管输入框（issue #464）。新机一条命令重建哑终端 + 中继 + coordinator 归属：

```bash
node scripts/inbox-station.mjs ensure
```

全活着秒退，stdout 一行 JSON（runId / handle / 日志路径，默认 `_flow/inbox.log`）。缺任何一环自动重建。帅的派工序是「run-use → 派工 → ensure 归还」——run-use 会夺走 coordinator，ensure 必须再跑一次把横幅交回信箱台。

## 10. 接上 memory

本机 Claude 项目 memory 写在 `~/.claude/projects/<编码后的仓库路径>/memory/`。编码规则：路径里**所有非 `[a-zA-Z0-9]` 字符一律换成 `-`**（点、空格、下划线、中文都算），不是只换盘符和斜杠。反例：`...\468-审官-gpt-5.6-sol` → `...-468----gpt-5-6-sol`（本机 `~/.claude/projects/` 下有这条真目录）。仓内 `host/memory/` 是真相源。

先关掉所有 Claude Code 窗口再跑（它可能占着 `memory/` 句柄，改名会失败）。在**主仓根**执行下面这段——只接你正在跑命令的那份克隆，Orca worktree 各有自己的 `projects/<编码>` 目录，不会一起接上。

**事前拦截**：本机是真目录时，脚本先核对仓内 `host/memory/` 是不是本机文件的超集。本机有、仓内没有的文件会直接 throw，**不会改名、不会建 Junction**。先把缺的拷进 `host/memory/` 再跑。已是正确 Junction 则什么都不做。接上之后 Claude 每写一条 memory，主仓 `git status` 就会多一条未提交变更，随手提交，别攒，也别 `git stash` 把记忆藏起来。

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
    $missing = @(Get-ChildItem -LiteralPath $local -File | Where-Object {
      -not (Test-Path -LiteralPath (Join-Path $hostMem $_.Name))
    } | ForEach-Object { $_.Name })
    if ($missing.Count -gt 0) {
      throw "仓内不是本机超集，先把这些拷进 host/memory/ 再接: $($missing -join ', ')"
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

skills 同样是逐个 SymbolicLink 直连 `host/skills/<name>`，没有自愈脚本（`dao.ps1` 已随 #425 退役）。

## 11. Orca 快捷命令：从零拷问

换机后在 Orca 里重建一条智能体提示（Claude），按「不对劲就按我」触发：

- 标签：`从零拷问（不对劲就按我）`
- 类型：智能体提示（Claude）
- 提示词全文：

```
用户觉得当前做法不对劲，触发本令。立即停下手头动作，按清单自查并逐条回答：
1) 第一性原理：剥掉全部现状与已有实现，这件事的本质需求是什么？从零推，最佳实践长什么样？
2) 补丁链检查：你现在的方案是不是在给现状做兼容、打补丁？画出补丁链——每一层在修谁的副作用。补丁已到第二层即触发「同一种办法连错两次就换路」（反者道之动），必须停手从零重推，不许在原方向打第三层。
3) 马斯克五步法按序过一遍且顺序不可换：质疑需求→删除（必须含「删掉整层」选项）→简化→加速→自动化。
4) 把「从零方案」与「现状方案」的差异和代价表摆出来，用 AskUserQuestion 交用户拍板，禁止替用户默认取舍。
5) 判制度：这次偏差是制度缺失还是执行失守？执行失守则写判例进 memory；确属制度缺失才提议改协作约定。
```

## 自检

做完跑一遍：

```bash
node scripts/dao-check.mjs
```

退出码 0 = 环境就绪。
