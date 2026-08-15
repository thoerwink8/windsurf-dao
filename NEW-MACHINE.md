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

## 自检

做完跑一遍：

```bash
node scripts/dao-check.mjs
```

退出码 0 = 环境就绪。
