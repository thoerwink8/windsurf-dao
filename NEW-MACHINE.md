# 换机部署指南

一台新机器，把 windsurf-dao 的环境恢复到与旧机一致。按顺序做，几步就完。

先读 `host/machine/INDEX.md`：A/B/C/D 告诉你装什么、不拷什么。本页只写装法，不另造第二份说明书。`host/machine/` 只装 B 类模板 + INDEX，**不镜像 `~`**。

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

任何不进 git 的密钥类文件（API key、脱敏前的真实配置等），换机都要手动复制，git 不会带它们。原则：**能进 git 的都进 git，不能进 git 的手动带**。

清单：

| 文件 | 里面是什么 | 不带的后果 |
|---|---|---|
| `~/.pi/agent/auth.json` | pi 各 provider 的 API key，含 **`opencode-go`**（opencode Go 订阅）与 `deepseek`（应急直连） | 写码/判断类派工的主通道是 opencode Go（`docs/model-routing.toml`），缺 key 时工人一起手就挂 |
| `~/.dao/apps/*.{pem,json}` | 四个 GitHub App 的私钥和安装号（**不进 git**，只此一份） | `gh-as` 报「这台机器没装」：审官 approve、工人开 PR、帅合并、看门狗报事故全断。详 §4b |

新机拿到 key 的路径：登录 https://opencode.ai/auth → 订阅 Go → 复制 key，填进 `~/.pi/agent/auth.json` 的 `opencode-go` 键（**不是 `opencode`**，那是 Zen，两个是独立 provider，填错会路由到 Zen 且 Go 额度用不上）。

## 4b. GitHub App 身份凭据（#573）

四个 App 的 private key 只此一份，丢了要回 GitHub 重新生成。换机把 `~/.dao/apps/` 整目录拷过来，**不要**进 git。

| 文件 | 角色 | App ID | Installation ID |
|---|---|---|---|
| `reviewer.{pem,json}` | `dao-reviewer[bot]` 审官 | 4616659 | 154244051 |
| `worker.{pem,json}` | `dao-worker[bot]` 工人 | 4616929 | 154249581 |
| `marshal.{pem,json}` | `dao-marshal[bot]` 帅 / 合并 | 4616953 | 154249976 |
| `watchdog.{pem,json}` | `dao-watchdog[bot]` 事故观察 | 人建完填 json | 人建完填 json |

`*.json` 形态（数字不要加引号）：

```json
{ "appId": 4616659, "installationId": 154244051, "slug": "dao-reviewer" }
```

查号（密钥丢了或换机对不上时）：

- App ID：GitHub → Settings → Developer settings → GitHub Apps → `dao-reviewer` / `dao-worker` / `dao-marshal` / `dao-watchdog` 页顶的 App ID。
- Installation ID：同一 App 页 → Install App → 点进这条安装，URL 末段就是；或用 App JWT 调 `GET /app/installations`。

`dao-watchdog` 要人在 GitHub 建（Settings → Developer settings → GitHub Apps → New GitHub App），工人**不**在 GitHub 上创建 App。装到本仓。权限只要能写评论：**Issues: Read and write**、**Pull requests: Read and write**、**Contents: Read-only**、**Checks: Read-only**。不要 Contents: Write（狗不许推码）。pem + json 放到 `~/.dao/apps/`。

验（按文档在一台没有 `~/.dao` 的环境上：先建目录、拷这八份文件，再跑）：

```bash
node scripts/gh-as.mjs reviewer --whoami
node scripts/gh-as.mjs worker --whoami
node scripts/gh-as.mjs marshal --whoami
node scripts/gh-as.mjs watchdog --whoami
```

缺文件会报 `缺凭据: ...（不是没配好，是这台机器没装——见 NEW-MACHINE）`，退出码 2。这和 json 缺字段的「配置错了」不是一回事。

打印出的 `permissions` 应与 issue #573 表逐字一致（GitHub 还会多一个自动加的 `metadata:read`，不算我们声明的权限）。已有工人树若 git log 还是本人，补一句：

```bash
node scripts/gh-as.mjs worker --set-git-identity
git log -1 --format="%an <%ae>"    # 应回 dao-worker[bot] <4616929+dao-worker[bot]@users.noreply.github.com>
```

`dao-worker` 的 `pull_requests` 现在是 write，因为自动开 PR 的 workflow 还没写（#480）。workflow 上线后降回 read——不做这一步，权限隔离是装饰。

## 4c. 账本事件（~/.dao/ledger/events/）

点将台事件账**不进 git**：每台机器写自己的 `~/.dao/ledger/events/`（一事件一文件，只增不改）。新机不用手动建目录——任何账本命令（`dao.mjs` / `flow.mjs` / `event-write.mjs` / `select.mjs` / `calibrate.mjs` 等）第一次跑会自动建目录，并把仓内 `ledger/events/` 里已合并的历史事件复制过去当种子（幂等，同名跳过，再跑不重复）。

- 仓内 `ledger/events/` 只保留已合并历史，**不要再往那里写新事件**；`LEDGER_EVENTS_DIR=<目录>` 可临时改落点（测试用，覆盖时不播种子）。
- 本机产生的新事件只在本机。跨机汇聚的方向是 dao-hub 按需拉取（已拍板，机制未实现）；汇聚上线前要带走旧机事件，就手动拷 `~/.dao/ledger/events/`——文件名由事件内容决定，同名即同一事件，直接合并拷贝安全。

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
- **opencode Go 是 ds-flash/pro 的主通道**（2026-08-16 起，见 `docs/model-routing.toml`）：凭据填 `~/.pi/agent/auth.json` 的 `opencode-go` 键，取 key 的路径见 §4。派工写法 `pi --model opencode-go/deepseek-v4-flash`（#602：裸 model 名跨 provider 歧义）；应急直连见 `docs/model-routing.toml` `[providers.deepseek]`。
  - Go 是账户级共享的美元额度硬顶，撞顶 pi 当场报错、工人挂掉（自动降级见 issue #520），并发派多个工人前先掂量。
- **models-store.json 的 `-direct` 止血（#569，换机必做）**：本机 `~/.pi/agent/models-store.json` 里 `deepseek` provider 的两条 model id 已改成 `-direct` 后缀（`deepseek-v4-flash-direct` / `deepseek-v4-pro-direct`），**换机后 pi 重新拉取会覆盖，要再改一次**。用途：断掉 pi 内置「同 model id 找别的 provider」的 fallback 去路——opencode Go 瞬时报错时 pi 会在 1ms 内静默切到 deepseek 直连（2026-08-16 实证：og 503 → ds 直连，成本从 ¥0.05 级跃到 $10 级，除账单外零信号）。验证（不是「已改过」，是实测生效）：`pi --list-models` 里 deepseek provider 只剩 `-direct` 两条。
  - 这条止血本身没被验证过——`scripts/watchdog.mjs` 的 model-change 检测（#569 ②，扫 `~/.pi/agent/sessions/**/*.jsonl` 的 model_change 事件）就是验证手段：下次真 503 是当场报错（止血生效）还是又切了（止血失效，检测会报出诱因）。
  - 与 go-fallback 扩展的交互（#569 核对）：扩展的降级查找 `modelRegistry.find("deepseek", model.id)` 与兜底 `find("deepseek", "deepseek-v4-flash")` 现在都找不到 `-direct` 改名后的模型 → 扩展明确报「无可用模型，无法降级」而不是悄悄切走。**这是止血想要的形态**（错误上浮有人看见），不是故障；将来若想让扩展能切直连，把 `PI_GO_FALLBACK_MODEL` 设成 `deepseek-v4-flash-direct` 即可（同时失去「静默切换」的保护，慎重）。
  - 将来 deepseek 充值后要走直连：模型名是带 `-direct` 的那个，`pi --provider deepseek --model deepseek-v4-flash-direct`（`cli_model` 字段表达不了这条通道差异的坑见 `docs/model-routing.toml`）。
- 三条验证命令：
  - `pi --list-models`：预期列出模型表（配好 Go 后会多出 20 个 `opencode-go` 模型）。
  - `pi auth check --provider opencode-go --json`：预期 `{"status":"ready",...}`；回 `credentials_not_configured` 就是 §4 的 key 没带。
  - `pi --no-tools --no-session -p "只回复：OK"`：预期回 OK；失败先查 `~/.pi/agent/models.json` 里的网关地址与 key。一次性连通性测试用 `--no-tools` 无妨，日常跑活别裁工具。

## 6b. pi 扩展怎么配（go-fallback，issue #520）

go-fallback 扩展：opencode Go 通道限流/额度顶时自动切直连 DeepSeek，当前会话接着把活做完（不是重启、不是从头来）。

- 源码在仓内 `host/pi-extensions/go-fallback.ts`（仓库资产，不留在本机自生自灭），换机一条命令装上：
  ```bash
  cp host/pi-extensions/go-fallback.ts "$HOME/.pi/agent/extensions/"
  ```
  验证已生效（新开 pi 会话后扩展自动加载，对所有 pi 工人生效，不用改 orca 派工链路）：
  ```bash
  ls ~/.pi/agent/extensions/go-fallback.ts   # 文件在即生效（pi 每次启动扫 extensions/ 目录）
  ```
- 行为：只在主通道（`opencode-go`）上动作；命中额度耗尽类错误（`GoUsageLimitError` / `FreeUsageLimitError` / `Monthly usage limit` / quota / billing 等）首次失败即切；命中瞬时类错误（429 / rate limit / overloaded / 5xx）连续第 2 次失败才切（给 pi 内置 auto-retry 一次机会）。切到直连后 `pi.setModel` + followUp 续跑，会话上下文完整保留。直连凭据缺失时明确报错，不静默降级。切换有可见记录（appendEntry 会话条目 + TUI 提示 + 上下文消息 + stderr 日志）。
- 可配置环境变量（默认即生产值，一般不用动）：`PI_GO_FALLBACK_PRIMARY`（主通道，默认 `opencode-go`）、`PI_GO_FALLBACK_PROVIDER`（直连目标，默认 `deepseek`）、`PI_GO_FALLBACK_MODEL`（兜底模型，默认 `deepseek-v4-flash`）、`PI_GO_FALLBACK_TRANSIENT_AFTER`（瞬时错误连续几次后切，默认 2）。
- 回归验收（构造真实限流响应，看着工人被切走并把活做完）：
  ```bash
  node host/pi-extensions/test/e2e.mjs            # 硬限流（quota）场景
  node host/pi-extensions/test/e2e.mjs rate-limit # 瞬时限流场景
  node host/pi-extensions/test/e2e.mjs no-creds   # 凭据缺失场景
  ```
  三个场景全绿才算生效；测试用一次性 pi 环境 + 随机端口 fake 上游，不碰本机 `~/.pi/agent`。

## 6c. pi 扩展怎么配（doorbell，issue #645）

doorbell 扩展：协调者（帅）的 pi 会话空闲（输入框空、没在打字）时，工人发完工/上报能叫醒协调者开一轮处理（代按一句「你有来信」再回车）；人在打字绝不占输入框，信的正文本不进输入框、只在对话里。

- 源码在仓内 `host/pi-extensions/doorbell.ts` + `doorbell-core.mjs`（仓库资产，不留在本机自生自灭），换机两条命令装上（两个文件都要，`doorbell.ts` 依赖同目录的 `doorbell-core.mjs`）：
  ```bash
  cp host/pi-extensions/doorbell.ts "$HOME/.pi/agent/extensions/"
  cp host/pi-extensions/doorbell-core.mjs "$HOME/.pi/agent/extensions/"
  ```
  验证已生效（新开 pi 会话后扩展自动加载；只对「cwd 下有 `_flow/inbox-*.log`」的会话动作，普通工人树天然不动作）：
  ```bash
  ls ~/.pi/agent/extensions/doorbell.ts ~/.pi/agent/extensions/doorbell-core.mjs
  ```
- 行为：被动盯信箱台 relay 写入的 `_flow/inbox-*.log`（不加第二个 `check --wait` waiter，不拆信箱台——#525 一个 run 只一个等信者），新消息到达且 pi 空闲 + 输入框空 → `pi.sendUserMessage("你有来信")`。输入框非空（打字中）不响；正文不进输入框，协调者按 dispatch skill 自己 tail 日志 / 查信箱。
- 可配置环境变量（默认即生产值，一般不用动）：`PI_DOORBELL_LOG_DIR`（日志目录，默认 `<cwd>/_flow`）、`PI_DOORBELL_POLL_MS`（轮询间隔，默认 2000）、`PI_DOORBELL_COOLDOWN_MS`（两次门铃最短间隔，默认 10000）、`PI_DOORBELL_TEXT`（门铃短句，默认「你有来信」）。
- 回归验收：
  ```bash
  node --test tests/doorbell.test.js   # 纯逻辑回归（node 22/24 都过）
  ```
  纯逻辑在 `doorbell-core.mjs`（node 22 CI 可直接测），`doorbell.ts` 只做 pi 运行时接线。

## 7. grok 怎么配

grok（Grok Build，X 系的官方 CLI）是本仓写码类峰时主选、查证/外网信息类的试用模型，路由见 `docs/model-routing.toml`。**grok 单统一走 Grok Build，pi-grok 已退役**（2026-08-14 拍板，issue #443）：pi 的 xai provider 走公网 api.x.ai + auth.x.ai 刷 OAuth，整链依赖本机 clash，点将台盲考两次断线；Grok Build 走专用端点 cli-chat-proxy.grok.com（带客户端头、给免费额度）。2026-08-15 起装 regrok shim 后，`--agent grok` 直接可用（shim 把代理前缀和默认模型 grok-4.6 都包进去了），装机三条：

- npm 必须钉版本：`npm install -g @xai-official/grok@1.0.1`——`latest` 标签停在仅 macOS 的 0.1.4，不钉版本会装错。验证：`grok --version` 应回 `1.0.1`。
- regrok shim：把 `host/machine/shims/grok.cmd` 和 `host/machine/shims/grok` 拷到 `~/.local/bin/`（覆盖 PATH 第一位）。打开模板改 `GROK_REAL`（真实二进制因机而异，例：`C:\nvm4w\nodejs\grok.cmd`）。行为与现机一致：内置 `HTTPS_PROXY=http://127.0.0.1:7890`（grok CLI 不认 Windows 系统代理，auth.x.ai 有 DNS 污染；代理地址可设环境变量 `DAO_PROXY` 覆盖，不设回退 7890），默认追加 `-m grok-4.6`，显式传 `-m/--model` 时原样透传。Windows `.cmd` 禁止 `findstr`（#633：用字符串替换判 `-m` / `--model`，不弹可见 cmd）。`--agent grok` 不带 launch 旗标时，shim 补 `--effort xhigh --always-approve`。验证：`where grok` 第一位应是 `~/.local/bin`，裸起 `grok` 服务端确认默认 4.6。注释保持纯 ASCII。命令库 `docs/model-routing.toml` 的 `[providers.grok].launch` 走这层 PATH。默认旗标只信那一处 launch，本节不复制。
- 宿主对外发布闸仍会硬拦 git push，协调者授权词是往终端回一句「推」——与「工人自称被拦先令重试」的判据并列：假拦（网络抖动）=重试即过，真拦（宿主策略）=需授权词。这和 TUI 确认框不是一层。

## 7b. command-code 怎么配

command-code（Command Code 官方 CLI）本仓用途 = **非交互查证/测速**（2026-08-16 帅·A 裁定：当前不能承载需进 git 的 Orca 工人，见 dispatch SKILL）。npm 包名就是 `command-code`，可执行文件 `command-code` 与别名 `cmdc` 同包两个入口；**没有 `cmd`**（会撞 Windows cmd.exe）。

- 装机：`npm i -g command-code`；验证：`command-code --version`（本机 v1.26.0）。
- **登录必须在真 TTY 里跑**（Ink raw mode）：`command-code login` 是浏览器交互流程，只能用户做；无 TTY 报 "Raw mode is not supported on the current process.stdin"。登录态落在 `~/.commandcode/auth.json`。验证：`command-code status` 应回 `Authenticated as <用户名>`。
- 模型列表（无需登录）：`command-code --list-models`（55 个模型，`deepseek/deepseek-v4-flash`、`deepseek/deepseek-v4-pro` 都在）；模型 id 两段式 `deepseek/deepseek-v4-flash`，`-m` 直传。
- 非交互契约：`command-code -p "问" --max-turns N --skip-onboarding` 输出纯文本、退出码 0；`--output-format json` 出 NDJSON 事件流 + 末尾 result 行。
- 自动化调用一律 `--skip-onboarding`（非交互撞 onboarding 会静默挂住，同 #500 型坑）；交互 TUI 启动后需补一记空回车才执行。

## 7c. cursor 怎么配

Cursor CLI 是 Composer / Kimi / Gemini 的主路，也是 GPT 的支路（主路仍 Codex）。路由与管子见 `docs/model-routing.toml` `[providers.cursor]`。**不装 pi-cursor-sdk**（官方无第三方 chat API；撞「pi 不写插件」）。

- 装机（Windows PowerShell）：`irm 'https://cursor.com/install?win32=true' | iex`。macOS / Linux / WSL：`curl https://cursor.com/install -fsS | bash`。验证：`cursor-agent --version`（`agent` 是同一套入口）。
- 登录必须真 TTY：`cursor-agent login`（浏览器交互，只能用户做）。验证：`cursor-agent status` / `cursor-agent whoami` 应回已登录。
- 代理 shim：Cursor 在国内 IP 下选择器只剩 Grok / Composer / Kimi / GLM（GPT / Claude / Gemini 被藏）。本机 Clash Party 在 `127.0.0.1:7890`（shim 默认回退此值，代理不同设环境变量 `DAO_PROXY` 覆盖）。把 `host/machine/shims/cursor-agent.cmd`、`cursor-agent`、`agent.cmd`、`agent` 拷到 `~/.local/bin/`（覆盖 PATH 第一位，包装 `%LOCALAPPDATA%\cursor-agent\` 下的真实二进制）。注释保持纯 ASCII。Windows `.cmd` 禁止 `for /f in ('dir')` 和 `findstr`（各弹一个可见 cmd；#633：版本目录写临时文件再 `for /f` 读，`--model` 用字符串替换判）。shim 在带 `--model` 时会补 `--trust`（#648：新 worktree 弹 Workspace Trust，`--force` 不管，Orca 报 agent_unconfigured）。验证：`where cursor-agent` 第一位是 `~/.local/bin`；无代理时选择器只有 Grok/Composer/Kimi/GLM，有代理才看得到 GPT/Claude/Gemini。
- 启动模板只信 `docs/model-routing.toml` `[providers.cursor].launch`（`cursor-agent --model {model} --force --trust`）。`--force` 是无人值守放行（等同 `--yolo`）；`--trust` 免弹 Workspace Trust（#648 返工补丁）。
- 模型 id 以路由表 `cli_model` 为准（`composer-2.5` / `kimi-k3-high` / `gemini-3.7-flash-high` / `gpt-5.6-sol-high`），不要另造映射。

## 7d. devin 怎么配

Devin CLI 是写码类主通道（#688：优先级 devin > opencode-go > 直连）。路由与启动模板只信 `docs/model-routing.toml` `[providers.devin].launch`。Orca 不认 `--agent devin`，派工走 `terminal create --command`。

- 装机：官方 Devin 安装器（本机二进制 `%LOCALAPPDATA%\devin\cli\bin\devin.exe`）。验证：`where.exe devin` 能找到；`devin models list` 含 `deepseek-v4-flash-max`。
- 登录只能用户做：`devin auth`。凭据在 `%LOCALAPPDATA%\devin\credentials.toml`（C 类，不进 git）。
- 非交互冒烟：`devin --print --model deepseek-v4-flash-max --respect-workspace-trust false --permission-mode dangerous -- "只回复：OK"`。未信任目录必须关 workspace trust 检查，否则没提示可弹、当场失败。`--print` 跑完即退，**不能**当 Orca 工人。
- 工人 TUI 起法只信路由表 launch（`--permission-mode dangerous` 全放行）。不要另造一份启动命令。

## 8. 本机工具坑

- playwright MCP 报 "Browser is already in use" 时：杀掉 `%LOCALAPPDATA%\ms-playwright-mcp\mcp-chrome-*` 对应的 chrome 进程，并删该目录下的 lockfile。
- 不可逆红线：覆写正在使用的 `~/.claude/settings.json` 可能触发 401 强制登出，把文件改回去也恢复不了——改它前先备份，AI 不得整文件覆写。

## 8c. 什么不能拷

INDEX 里 D 类一律不拷：`~/.claude/settings.json`、`~/.claude/settings.local.json`、cc-switch DB、`~/.claude/state.json`、本机绝对路径、密钥形态文件。C 类只手带，不进 git。没写进仓库的本机私货闸看不见——新 CLI 只要写进仓就会被扫到，记得补 INDEX。

## 8d. Orca hook 闪屏（禁默认 cursor hook install）

**不要**对 cursor 跑 Orca 默认 `agent hooks on` / cursor hook install。默认会写 PowerShell `EncodedCommand`，每次 hook 闪一个控制台。

正确装法：

1. 把 `host/machine/hooks/orca-cursor-hook.cmd` 拷到 `~/.orca/agent-hooks/orca-cursor-hook.cmd`
2. 把 `host/machine/hooks/orca-cursor.hooks.json` 的内容合进用户级 `~/.cursor/hooks.json`
3. 命令行必须是 `conhost.exe --headless ...`，**禁止 EncodedCommand**

Claude / Codex / grok 已装的 `~/.orca/agent-hooks/*.cmd` 保持现状；本条只挡 cursor 那条闪屏默认装法。

## 8e. Cursor 帅缺口

帅位三件套（Run / 收信 / hook）只在 Claude Code 上齐。Cursor 现在缺盘注入（board-hook）、信箱台归属、三态 hook。**不改「帅=CC」政策**——Cursor 只做工人，不要把 dispatch / CLAUDE.md 改成任意终端都能当帅。

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

#667 起不再靠 coordinator 横幅给帅收信：人用窗口永不当 coordinator，真信进 `_flow/inbox.log` 和 GitHub。新机一条命令重建哑终端 + 中继（#638：**全机只保活一台**，不再一 Run 一台）：

```bash
node scripts/inbox-station.mjs ensure
```

全活着秒退，stdout 最后一行 JSON（handle / 日志路径 / action / closedExtra / gc）。身份不认标题（#493 返工）：台 = 全局租约 `_flow/inbox.lease`（新鲜 + PID 在 + handle 在盘面）。`action` 三态：`ok`（all-alive 秒退 / closed-extra 顺手关掉旧模型多余活台）、`rebuild`（no-station 无台新建 / no-global-station 只有旧台，全关重建全局台 / stale-guard 启动串不是镜像脚本）。旧模型 per-run 台（`_flow/inbox-<run>.lease`）被杀出局，跑一次 ensure 后顶栏只剩 1 个信箱台页签。relay 不 run-use 抢 waiter（#634 已证 consumer_fenced），每轮只读 `orchestration inbox` 收全部在途 Run（keep 集 ∪ 活 coordinator 的 Run）的信，去重落盘 `_flow/inbox.log`，跑可归档加速闸 + MERGED 扫描收树（#665：可归档不是门）。

**守卫必须跑 origin/master（#665）**：信箱台 / 看门狗 / flow 启动时把代码 sync 到 `%USERPROFILE%\.dao\guard-mirror`（`git fetch` + `reset --hard origin/master`）再 exec，主树落后不影响关卡。启动或每轮若仍落后 / 查不成 → 非零退出（落后自停），不许继续跑旧代码。日志 / 租约仍落主树 `_flow/`（`resolveLogPath` 认主卡）。合入本改动后**重启一次**信箱台（`node scripts/inbox-station.mjs ensure`）和看门狗 / flow，之后落后会自停、ensure 按镜像重建。归档失败写 GitHub PR 评论（marshal），不只进 orchestration 信箱。ensure 成功后顺手只读 run-gc（#614）：僵尸 Run 数超阈值（默认 5）在 stdout 最前面打一行，`--apply` 仍手动。#667：ensure/派工都不 `run-use`（`--from` 不能冒充信箱台，会 consumer_fenced）。人用窗口不当 coordinator：闸门拦裸 `run-use`/`run-create`。`dao.mjs dispatch` 不 `run-use`。例外（#675）：工人 TUI `bindStation` 在 `run-current` 为 null 时对本窗 `run-create`（不 `--from` 信箱台）；帅窗不许触发。心跳不准发到 Run。帅读 `_flow/inbox.log` 和 GitHub 知道完工/升级，不靠输入框横幅。#593 / #601：归档走 `dao.mjs worktree-rm`（先退役 Run+关台，再删树）；关台身份看租约 TTL/runId/handle（过期直接 alreadyGone，未过期且证不出就失败，不拿 coordinator_handle 当台）；存量用 `dao.mjs run-gc`（默认只列 pending/tombstones，`--apply` 才关，真关只认 terminal close，墓碑计入本已关）；跨单收信 `dao.mjs inbox-collect`。

## 9b. 守卫保活：帥位触发（#693）

不要靠人记得 Monitor 挂 watchdog / flow，也不要再造 OS 级定时器或自研循环（#683 的计划任务 + #693 前身的 resident 循环都已拍板删除：schtasks 被拒后长出的自研保活层死了 5.5 小时无人知，见 #693）。

新机制**随仓生效，无装机动作**（clone 即带，cc-switch 覆盖不到；已开着的会话重开一次才加载新 hook）：

- 随仓 `.claude/settings.json` 的 SessionStart hook：会话启动时机械判定 cwd 是主树（`git worktree list` 第一棵）且分支是 master（=帥位），是则幂等跑 `node scripts/guard-keepalive.mjs --once`——查 watchdog/flow 进程，缺才从 `~/.dao/guard-mirror` 拉起（detached + windowsHide）；进程在但心跳停更超阈值（watchdog 5 分钟 / flow 10 分钟，#699「活但卡死」）杀掉再拉起。watchdog 自身心跳写 `%USERPROFILE%\.dao\guard\watchdog-heartbeat.json`，flow 心跳写主树 `_flow/heartbeat.json`。
- 同一份 settings.json 的 board-hook（UserPromptSubmit）在帥位会话里每轮顺手再 ensure 一遍：会话中途守卫死了，帅下一轮提示时拉起。
- 帥位判不出来（git 失败 / detached HEAD / 分支读不出）不猜、不静默：hook 往上下文注入醒目行，由帅问用户后再手动拉起。

验（不是「已装」，是 kill 后会回来）：

```bash
# 主树 master 的 cwd 下手动模拟一次 SessionStart hook：
node scripts/lib/guard-session-hook.mjs
# 故意 kill 后立刻重跑，pid 应变新：
#   记下 watchdog pid → taskkill /PID <pid> /F → node scripts/lib/guard-session-hook.mjs
```

手动拉起/排查：`node scripts/guard-keepalive.mjs --once`（幂等；进程列表没查成不许当 0 个、不乱拉起；心跳没查成不乱杀）。

自停 / 查不成写 `%USERPROFILE%\.dao\guard\halt.jsonl`，并经 `dao-watchdog[bot]` 在 GitHub 开/评「【看门狗】守卫自停」台账（同一事故键不刷）。没装 watchdog 凭据会在 jsonl 里记「这台机器没装」，不许当报成功——凭据装法见 §4b。`~/.dao/guard` 换机重建，不要拷。

## 9c. Cursor 帅位挂载与派工闸口（#707）

帅位搬进 Cursor 后，保活 / 盘面 / 派工闸在 Cursor 侧由随仓 `.cursor/hooks.json` 挂载（**随仓生效，无装机动作**；Cursor 对 hooks.json 有文件 watcher，保存即自动重载，已开着的会话不用重开；clone 即带）：

- `sessionStart` → `node scripts/lib/cursor-context-hook.mjs guard-session-hook.mjs`：会话启动判定帥位并 ensure 守卫（逻辑与 §9b 的 SessionStart 同一份 `guard-session-hook.mjs`）。
- `beforeSubmitPrompt` → `node scripts/lib/cursor-context-hook.mjs board-hook.mjs`：每轮盘面 + 信箱台自愈 + 守卫兜底（同一份 `board-hook.mjs`）。
- `beforeShellExecution` → `node scripts/lib/cursor-dispatch-gate-hook.mjs`（timeout 8 + `failClosed: true`）：派工闸，判定逻辑唯一一份在 `dispatch-gate.mjs`，本文件只做协议翻译。

**为什么盘面/守卫要包一层适配层（#707 实测）**：Cursor 钩子只认 stdout JSON——纯文本输出被当 invalid JSON 丢弃，`[盘]`/`[卫]` 行进不了会话上下文。适配层把子脚本输出原样包进 JSON 的 `additional_context` 字段（Cursor 唯一能注入上下文的通道），永远 `continue: true`（只报不拦）。**为什么派工闸也要适配层**：Cursor 在 Windows 上用 PowerShell 包装执行钩子（`Get-Content payload -Raw | & { $input | <hook> }`），脚本块调用会把子进程退出码吞成 0——exit 2 语义到不了宿主；且 `failClosed: true` + 空 stdout 会把「放行」也拦掉。所以 Cursor 面必须 exit 恒 0，拦/放全靠 stdout JSON 的 `permission`（deny/allow），`failClosed: true` 兜超时与崩溃。

**Cursor 帅位的派工闸口**：`dao.mjs dispatch` / `worker-start` 要求调用进程有 Orca 终端身份（worker-start 校验 Task Run 的 coordinator 终端，非 Orca 终端报 `consumer_fenced`）。Cursor 的 shell 不是 Orca 终端，所以 Cursor 帅位派工要经 **master 卡的「派工闸口（勿关）」哑终端**：`orca terminal send --terminal <闸口 handle> --text '<dispatch 命令>' --enter`，结果用 `orca terminal read` 读回。闸口与信箱台/看门狗哑终端同 pattern，不跑 AI、不花 token。其余帅位动作（notify 发信、收信、关单、监控）Cursor 直接做，不需要闸口。

Cursor 面验（进程级，等于宿主协议的一次复刻）：

```bash
# 派工闸：Cursor 形 stdin 载荷 → 拦裸 worker-start（deny JSON、exit 0）
'{"hook_event_name":"beforeShellExecution","command":"orca orchestration worker-start --task t"}' | node scripts/lib/cursor-dispatch-gate-hook.mjs
# 盘面适配层：输出应是一行 {"continue":true,"additional_context":"[盘] ..."} 的 JSON
node scripts/lib/cursor-context-hook.mjs board-hook.mjs
```

## 10. 接上 memory

memory 住在**独立仓** `thoerwink8/windsurf-dao-memory`（私有，clone 需有权限）。本机 Claude 项目 memory 写在 `~/.claude/projects/<编码后的仓库路径>/memory/`，是一个指向那个仓 clone 的 Junction。编码规则：路径里**所有非 `[a-zA-Z0-9]` 字符一律换成 `-`**（点、空格、下划线、中文都算），不是只换盘符和斜杠。反例：`...\468-审官-gpt-5.6-sol` → `...-468----gpt-5-6-sol`（本机 `~/.claude/projects/` 下有这条真目录）。

**第一步：clone 一次 memory 仓**（本机任意位置，例：`D:\frank\windsurf-dao-memory`）：

```bash
git clone git@github.com:thoerwink8/windsurf-dao-memory.git
```

先关掉所有 Claude Code 窗口再跑下面的命令（它可能占着 `memory/` 句柄，改名会失败）。在**主仓根**执行下面这段——只接你正在跑命令的那份克隆，Orca worktree 各有自己的 `projects/<编码>` 目录，不会一起接上。**把 `$memRepo` 换成你 clone 的位置。**

**事前拦截**（含一层子目录，`-Recurse`）：本机是真目录时，脚本先核对本机每个文件是否都在 memory 仓里。本机有、memory 仓没有的文件会直接 throw，**不会改名、不会建 Junction**。同名但内容不同的只警告列出，仍会接上——接上后本机这几条变成仓内版本，旧内容留在改名备份目录里，需要就去比对。已是正确 Junction（目标 = 你的 memory 仓）则什么都不做、原地返回。接上之后 Claude 每写一条 memory，memory 仓 `git status` 就会多一条未提交变更，随手提交，别攒，也别 `git stash` 把记忆藏起来。

```powershell
& {
  $ErrorActionPreference = 'Stop'
  $memRepo = 'D:\frank\windsurf-dao-memory'   # ← 换成你 clone windsurf-dao-memory 的位置
  if (-not (Test-Path -LiteralPath $memRepo)) { throw "memory 仓不在: $memRepo（先 clone thoerwink8/windsurf-dao-memory）" }
  $repo = (Resolve-Path .).Path
  $want = [IO.Path]::GetFullPath($memRepo)
  $encoded = $repo -replace '[^a-zA-Z0-9]', '-'
  $local = Join-Path $env:USERPROFILE ".claude\projects\$encoded\memory"
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
      $peer = Join-Path $memRepo ($rel -replace '/', '\')
      if (-not (Test-Path -LiteralPath $peer)) { $missing += $rel }
      elseif ((& $norm $f.FullName) -cne (& $norm $peer)) { $diverged += $rel }
    }
    if ($missing.Count -gt 0) {
      throw "memory 仓不是本机超集，先把这些拷进 $memRepo 再接: $($missing -join ', ')"
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

本机若有比仓新的条目，先从改名备份里拷进 `$memRepo` 再提交。

接上后跑 `node scripts/dao-check.mjs` 自检：第 ⑨ 项「本机 memory 断链检查」应变绿——判据是 Junction 目标是一个 git 仓、且它的 `origin` remote 指向 `thoerwink8/windsurf-dao-memory`（SSH / HTTPS 两种 URL 形式都认）；普通目录/链接悬空/目标不是 memory 仓/origin 不对（含搬家前指向主仓旧 memory 目录的形态）都会报红，CI 无本机目录则出 SKIP（不是绿）。

## 11. 接上 skills

仓内真相源是 `host/skills/<name>/SKILL.md`。**Cursor Desktop 不会读 `host/skills`**，也不读 Claude 的 `~/.claude/skills`；各自宿主只扫自己的目录：

| 宿主 | 发现路径 | 备注 |
| --- | --- | --- |
| Claude Code | `~/.claude/skills/<name>/` | 本机 symlink → 仓内 `host/skills/<name>` |
| Cursor Desktop | `~/.cursor/skills/<name>/`（用户级）或项目 `.cursor/skills/<name>/` | 同上；**不要**往 `~/.cursor/skills-cursor/` 写（系统内置区） |

skills 是逐个 SymbolicLink 直连 `host/skills/<name>`，没有自愈脚本（`dao.ps1` 已随 #425 退役）。建 SymbolicLink 需要开发者模式或管理员权限（Windows）。本机同名的**真目录**（插件自带的 skill，如 `orca-cli`）只警告不动——脚本绝不删本机目录，要换成仓内版本得自己先移走。

### 11.1 Claude Code：`~/.claude/skills`

在**主仓根**执行，把仓内每个 skill 接到 `~/.claude/skills/`：

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

验证：`ls ~/.claude/skills` 里每个仓内 skill 都在；`grill-ai` 在 = 从零拷问兜底令随机器带走了。`admit-push` 在 = 承认即派入口随机器带走了（#583：用户调用后走 issue / dispatch / park，不加账本）。`pr-fast` 在 = 快速/极速模式入口随机器带走了。

`dao-project`（项化派工，含消歧门）由上面循环自动接上，无需单独动作；要单条建链（或循环没覆盖时手动补）：

```powershell
$repo = 'D:\frank\windsurf-dao'   # 换成本机主仓路径
New-Item -ItemType SymbolicLink -Force -Path "$env:USERPROFILE\.claude\skills\dao-project" -Target "$repo\host\skills\dao-project" | Out-Null
```

建链是本机动作、不进 git（#565 消歧记录：symlink 归帅建）；验证 `ls ~/.claude/skills/dao-project` 能看到 `SKILL.md`。

### 11.2 Cursor Desktop：`~/.cursor/skills`

同一套循环，把 `$dstRoot` 换成 Cursor 用户级目录即可（也可整段重跑，只改这一行）：

```powershell
& {
  $ErrorActionPreference = 'Stop'
  $src = Join-Path (Resolve-Path .).Path 'host\skills'
  if (-not (Test-Path -LiteralPath $src)) { throw "host/skills 不在: $src" }
  $dstRoot = Join-Path $env:USERPROFILE '.cursor\skills'   # Cursor，不是 .claude
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
      Write-Warning "跳过 $($s.Name)：本机是真目录，先移走再重跑"
      continue
    }
    New-Item -ItemType SymbolicLink -Path $dst -Target $want | Out-Null
    Write-Host "link $($s.Name) -> $want"
  }
}
```

只补 `pr-fast` 一条时：

```powershell
$repo = 'D:\frank\windsurf-dao'   # 换成本机主仓路径
New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\.cursor\skills" | Out-Null
New-Item -ItemType SymbolicLink -Force -Path "$env:USERPROFILE\.cursor\skills\pr-fast" -Target "$repo\host\skills\pr-fast" | Out-Null
```

验证：`Test-Path $env:USERPROFILE\.cursor\skills\pr-fast\SKILL.md` 为 True。

**怎么触发（Cursor）**：slash 菜单靠 frontmatter 的 `name`（如 `pr-fast` → 可出现 `/pr-fast`）；口语触发词以 skill 正文为准——`快速模式` / `极速模式` / `pr-fast` / `直开PR` / `快单`。装完 symlink 后**新开 Agent 会话**再试（已开会话不一定立刻扫到新链）。项目级 `.cursor/skills/` 亦可，但本仓默认用用户级 symlink，与 Claude 装法对称、不进 git。

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
node scripts/dao.mjs dispatch --name "卡名" --merge-policy auto --model grok-4.6 --reviewer gpt-5.6-sol --split no --split-reason "新机自检单卡" --spec "短摘要" --dry-run
```

派工默认 `merge-policy: auto`（#511 拍板：帅只感知不再是关口）；选 `manual` 必须带 `--merge-reason <理由>`（只限改协作约定 / 改 model-routing.toml 决策字段 / 花钱三类），理由写进任务卡 comment 留痕。另必须带 `--model` 或 `--role`、`--reviewer`、`--spec`、`--split`，缺一就停。`--split no` 必须带 `--split-reason`；`--split N` 必须带 N 个 `--slice`。启动模板只在 `docs/model-routing.toml` 的 `[providers.*].launch`。

派工闸挂在**随仓 `.claude/settings.json`**（#553 从 plugin 换挂法，`host/skills/dispatch/` 已不再自带插件层）：`PreToolUse` 指向 `scripts/lib/dispatch-gate-hook.mjs`（逻辑在 `scripts/lib/dispatch-gate.mjs` 唯一一份）。**闸门随仓生效，无需装机动作**——clone 即带上，cc-switch 覆盖不到；已开着的会话重开一次才加载新 hook。裸 `orca orchestration worker-start` / `task-create` 会被 exit 2 拦住（#546 #517）。dao-check 第 ⑬ 项每次重跑闸门：装载面在、脚本在、旁路必须拦、逃生口必须过、崩了必须也拦。逃生口 `node scripts/dao.mjs raw -- <命令>` 会记一笔到 `_flow/cmd-escape.jsonl`（记账走 stderr，stdout 保持子进程原样）。给已有 PR 补审官用 `node scripts/dao.mjs reviewer-attach --pr <N> --worktree <工人卡> --reviewer <模型>`（一条命令：建树 + 起终端 + 注入 + 验开工）。`reviewer-create --pr <N>` 只建树。

同一份随仓 `.claude/settings.json` 还挂 `UserPromptSubmit` → `scripts/lib/board-hook.mjs`（#564，#588 扩容）：每轮往上下文注入一行 `[盘]` 摘要（带单号和做中/审中，orca 本地状态 + 60s TTL 缓存，不打 GitHub），并顺手跑 `inbox-station.mjs ensure` 自愈信箱台（只报不拦，永远 exit 0）。随仓生效，无需装机动作。
## 自检

做完跑一遍：

```bash
node scripts/dao-check.mjs
```

退出码 0 = 环境就绪。
