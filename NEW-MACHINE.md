# 换机部署指南

一台新机器，把 windsurf-dao 的环境恢复到与旧机一致。按顺序做，几步就完。

先读 `host/machine/INDEX.md`：A/B/C/D 告诉你装什么、不拷什么。本页只写装法，不另造第二份说明书。`host/machine/` 只装 B 类模板 + INDEX，**不镜像 `~`**。

## 0. 一条命令（先跑这个）

clone 完先跑：

```bash
node scripts/onboard.mjs            # 幂等接线：全局约定 / skills 链接 / memory；--dry-run 只看不动
```

它把 §3/§10/§11 的接线全代劳（能修的修、危险的拒绝并指路）；剩下只有**手动带凭据**（§4）。
日后哪根链接断了、约定漂移了，重跑同一条命令即修复；SessionStart 哨兵发现未接线会注入一行提醒
（绿=零输出）。来历见 docs/decisions/2026-08-31-local-guards-retire-with-server.md。

## 1. 拿仓库

```bash
git clone git@github.com:thoerwink8/windsurf-dao.git
cd windsurf-dao
```

克隆完即得全部内容：AI 协作约定（`CLAUDE.md`）、自检命令（`scripts/dao-check.mjs`）。历史文档（含旧项目模板、道德经源文本）2026-08-22 起归档在 memory 仓 `docs-archive/`，接上 memory（本文 §10）后即可读。

## 2. 装 Node

自检命令 `node scripts/dao-check.mjs` 需要 Node.js（20.11 或更高，它用了 `import.meta.dirname`）。装完验证：

```bash
node --version
```

## 3. 放全局协作约定

`docs/global-CLAUDE.md` 是用户级 `~/.claude/CLAUDE.md` 的真相源副本（git 不带机器配置）。§0 的 `onboard.mjs` 会把它拷到位（先备份现文件）；漂移时 SessionStart 哨兵报 `global-drift`，重跑 onboard 即修。

以后要改全局约定，只改仓库里的 `docs/global-CLAUDE.md`，各机器重跑 onboard 同步。

## 4. 密钥类文件手动带

任何不进 git 的密钥类文件（API key、脱敏前的真实配置等），换机都要手动复制，git 不会带它们。原则：**能进 git 的都进 git，不能进 git 的手动带**。

清单：

| 文件 | 里面是什么 | 不带的后果 |
|---|---|---|
| `~/.pi/agent/auth.json` | pi 各 provider 的 API key，含 **`opencode-go`**（opencode Go 订阅）与 `deepseek`（应急直连） | 派工选型见 `docs/model-routing.json`；走 og 通道的工人缺 key 一起手就挂 |
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

模型配置（API key、模型列表、网关地址、**代理分流**）不在本仓，真相源是 `ai-gateway-stack` 仓——
客户端怎么接、换 VPS 要改哪几处，都是它自带的手册。本页不复制那边的步骤，也不记会过期的网关地址。

- 各 CLI 的**工具本身**怎么装，见下面 §6 / §7；**连哪个模型、走哪个网关**归 `ai-gateway-stack`。
- 机器上开了梯子的话，网关必须配直连分流，否则流量会绕代理节点出海再绕回来（实测慢 35 倍，且不报错）。

Claude Code（帅位）装机必设：`autoCompactWindow=500k`（1M 窗口的 50%，低于 100k 不收），且 cc-switch DB `common_config_claude` 同落，防下发覆盖；effortLevel 基准 high（以 live 为准，2026-08-14 拍板，issue #443）。

## 6. pi 怎么配

pi 是 DeepSeek 系工人的 CLI。装与验：

- npm 包名 `@earendil-works/pi-coding-agent`（Mirasim 认的分支，`host/pi-extensions/test/e2e.mjs` 也只找它），命令是 `pi`。**别装上游 `@mariozechner/pi-coding-agent`**：两包争同一个 `pi` 命令，装了上游后 Mirasim 装分支必报 EEXIST，且上游版 `pi --version` 在 stdin 关闭时一个字不印，Mirasim 探测判「无法运行」（2026-09-02 本机实咬）。已装错就 `npm uninstall -g @mariozechner/pi-coding-agent` 再装分支。`@mariozechner/pi` 是另一个 vLLM 管理工具，同样别装。
- `models.json` / `settings.json` 在 `~/.pi/agent/` 下：网关地址写占位（api key 只留占位，不进 git）；`supportsDeveloperRole: false` 是兼容项要留。
- `contextWindow` 故意声明得更小：pi 没有百分比压缩阈值，触发公式是「已用 > contextWindow − reserveTokens」，声明太大等于把压缩触发点推远。
- `deepseek-v4-flash` 勿用 `--tools` 裁掉 bash：裁掉后模型仍会幻觉调用 bash，把模型的工具调用标记当文本吐。
- **ds-flash 写码通道走 gw-dspool**（选型顺位以 `docs/model-routing.json` 为准，2026-09-03 拍板）：派工写法 `pi --model gw-dspool/deepseek-v4-flash`（#602：裸 model 名跨 provider 歧义）。网关凭据与分组归 `ai-gateway-stack`（INDEX E 类，本仓不写装法）。`opencode-go` 因服务器 403 RegionError 降为顺位 2，凭据仍填 `~/.pi/agent/auth.json` 的 `opencode-go` 键（取 key 见 §4）；应急直连见 `docs/model-routing.toml` `[providers.deepseek]`。2026-08-22 起路由只登记 ds 与 `ox-alpha-free`（后者有工种 ban），kimi/glm 等不再走 og。
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

- 源码在仓内 `host/pi-extensions/go-fallback.ts` + 它 import 的 `go-fallback-core.mjs`（仓库资产，不留在本机自生自灭；**两个文件都要**——2026-09-02 前本节只叫拷 .ts，装上就是坏的）。装了 pi 的机器由 §0 的 `onboard.mjs` 拷到 `~/.pi/agent/extensions/`；仓里更新了没装、或本机手改，哨兵报 `pi-ext-drift`，重跑 onboard 重拷（手改的留 `.bak-<ts>`）。
  验证已生效（新开 pi 会话后扩展自动加载，对所有 pi 工人生效，不用改 orca 派工链路）：
  ```bash
  ls ~/.pi/agent/extensions/go-fallback.ts ~/.pi/agent/extensions/go-fallback-core.mjs   # 都在即生效（pi 每次启动扫 extensions/ 目录）
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

## 6c. pi 扩展 doorbell（冻结，新机不装）

doorbell 是给信箱台（§9）配的门铃：协调者 pi 空闲时代按一句「你有来信」。信箱台随 2026-08-31 本机守卫栈归零一起冻结，门铃没有信可响，**新机不装**。源码留仓 `host/pi-extensions/doorbell.ts` + `doorbell-core.mjs`（`node --test tests/doorbell.test.js` 照跑），去留随 §9 一起定。

## 7. grok 怎么配

grok（Grok Build，X 系的官方 CLI）是本仓写码类峰时主选、查证/外网信息类的试用模型，选型见 `docs/model-routing.json`，启动模板见 `docs/model-routing.toml` `[providers.grok].launch`。**grok 单统一走 Grok Build，pi-grok 已退役**（2026-08-14 拍板，issue #443）：pi 的 xai provider 走公网 api.x.ai + auth.x.ai 刷 OAuth，整链依赖本机 clash，点将台盲考两次断线；Grok Build 走专用端点 cli-chat-proxy.grok.com（带客户端头、给免费额度）。2026-08-15 起装 regrok shim 后，`--agent grok` 直接可用（shim 把代理前缀和默认模型 grok-4.6 都包进去了），装机三条：

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

Cursor CLI 是 Composer / Kimi / Gemini 的主路，也是 GPT 的支路（主路仍 Codex）。选型见 `docs/model-routing.json`，启动模板见 `docs/model-routing.toml` `[providers.cursor]`。**不装 pi-cursor-sdk**（官方无第三方 chat API；撞「pi 不写插件」）。

- 装机（Windows PowerShell）：`irm 'https://cursor.com/install?win32=true' | iex`。macOS / Linux / WSL：`curl https://cursor.com/install -fsS | bash`。验证：`cursor-agent --version`（`agent` 是同一套入口）。
- 登录必须真 TTY：`cursor-agent login`（浏览器交互，只能用户做）。验证：`cursor-agent status` / `cursor-agent whoami` 应回已登录。
- 代理 shim：Cursor 在国内 IP 下选择器只剩 Grok / Composer / Kimi / GLM（GPT / Claude / Gemini 被藏）。本机 Clash Party 在 `127.0.0.1:7890`（shim 默认回退此值，代理不同设环境变量 `DAO_PROXY` 覆盖）。把 `host/machine/shims/cursor-agent.cmd`、`cursor-agent`、`agent.cmd`、`agent` 拷到 `~/.local/bin/`（覆盖 PATH 第一位，包装 `%LOCALAPPDATA%\cursor-agent\` 下的真实二进制）。注释保持纯 ASCII。Windows `.cmd` 禁止 `for /f in ('dir')` 和 `findstr`（各弹一个可见 cmd；#633：版本目录写临时文件再 `for /f` 读，`--model` 用字符串替换判）。shim 在带 `--model` 时会补 `--trust`（#648：新 worktree 弹 Workspace Trust，`--force` 不管，Orca 报 agent_unconfigured）。验证：`where cursor-agent` 第一位是 `~/.local/bin`；无代理时选择器只有 Grok/Composer/Kimi/GLM，有代理才看得到 GPT/Claude/Gemini。
- 启动模板只信 `docs/model-routing.toml` `[providers.cursor].launch`（`cursor-agent --model {model} --force --trust`）。`--force` 是无人值守放行（等同 `--yolo`）；`--trust` 免弹 Workspace Trust（#648 返工补丁）。
- 模型 id 以路由表 `cli_model` 为准（`composer-2.5` / `kimi-k3-high` / `gemini-3.7-flash-high` / `gpt-5.6-sol-high`），不要另造映射。

## 7d. devin 怎么配

Devin CLI 的选型顺位见 `docs/model-routing.json`；启动模板只信 `docs/model-routing.toml` `[providers.devin].launch`。Orca 不认 `--agent devin`，派工走 `terminal create --command`。

- 装机：官方 Devin 安装器（本机二进制 `%LOCALAPPDATA%\devin\cli\bin\devin.exe`）。验证：`where.exe devin` 能找到；`devin models list` 含 `deepseek-v4-flash-max`。
- 登录只能用户做：`devin auth`。凭据在 `%LOCALAPPDATA%\devin\credentials.toml`（C 类，不进 git）。
- 非交互冒烟：`devin --print --model deepseek-v4-flash-max --respect-workspace-trust false --permission-mode dangerous -- "只回复：OK"`。未信任目录必须关 workspace trust 检查，否则没提示可弹、当场失败。`--print` 跑完即退，**不能**当 Orca 工人。
- 工人 TUI 起法只信路由表 launch（`--permission-mode dangerous` 全放行）。不要另造一份启动命令。

## 8. 本机工具坑

- playwright MCP 报 "Browser is already in use" 时：杀掉 `%LOCALAPPDATA%\ms-playwright-mcp\mcp-chrome-*` 对应的 chrome 进程，并删该目录下的 lockfile。
- `~/.claude/settings.json` 的 `statusLine.command` 指本仓 `host/statusline.js`，是这个 D 类文件里唯一一处本机绝对路径：仓搬了家、或换机克隆到别的盘，状态栏会**静默消失**（Claude Code 不报错）。onboard 哨兵报 `statusline-dangling`，只报不修——手改那一行，别整文件覆写（见下条红线）。
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

## 8f. Orca 桌面启动命令

派工启动 argv **只听仓内** `docs/model-routing.toml` 的 `[providers.*.launch]`。本机 `%APPDATA%\orca\profiles\local-default\orca-data.json`（可用 `ORCA_HOME` 或 `ORCA_DATA_JSON` 改路径）的 `settings.agentCmdOverrides` / `settings.agentDefaultArgs` 只拿来比较：桌面多的建议补进仓内，少的只报不删桌面。这是 D 类本机状态：**不要拷、不要改**（Orca 开着会回写冲掉）；新机装好 Orca Desktop 即可，派工不靠桌面旗标救命。

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

## 9. 信箱台 / 守卫保活 / Cursor 帅位挂载（冻结，新机不装）

这三节原来写本机守卫栈：信箱台 relay、看门狗 + flow 保活、盘面注入，以及 Cursor 侧的同一套挂载。**2026-08-31 拍板整体归零**（`docs/decisions/2026-08-31-local-guards-retire-with-server.md`）：它们是「Windows 冒充无人值守运行时」的脚手架，服务器上由 systemd + orca automations 原生顶替。当前状态：

- 挂点已摘：随仓 `.claude/settings.json` 只剩 PreToolUse 派工闸 + SessionStart onboard 哨兵；随仓 `.cursor/hooks.json` 只剩 beforeShellExecution 派工闸（2026-09-02 补摘——归零那天只摘了 Claude 面，Cursor 面还在拉守卫、注盘面）。
- 代码死缓：`scripts/inbox-station.mjs`、`watchdog.mjs`、`flow.mjs`、`guard-keepalive.mjs`、`scripts/lib/guard-*`、`board-hook.mjs`、`cursor-context-hook.mjs` 原样留仓、测试照跑，不修不加不移植；服务器落地后按 `docs/decisions/SERVER-LANDING-CHECKLIST.md` 第 4 步删。
- 想看当年怎么装：读 2026-09-02 之前版本的本文件（`git log --oneline -- NEW-MACHINE.md`）。
- 派工闸仍活着（停派工期防手滑）：Claude 面 exit 2 拦裸 `orca orchestration worker-start`；Cursor 面 `scripts/lib/cursor-dispatch-gate-hook.mjs` 以 stdout JSON 的 `permission: deny` 拦——Cursor 在 Windows 上用 PowerShell 包装钩子会吞子进程退出码，所以 Cursor 面 exit 恒 0，`failClosed: true` 兜超时与崩溃。验：

```bash
'{"hook_event_name":"beforeShellExecution","command":"orca orchestration worker-start --task t"}' | node scripts/lib/cursor-dispatch-gate-hook.mjs   # 应出 deny JSON、exit 0
```

## 9d. Linux 服务器起 Orca 无头运行时（2026-08-24 拍板）

拍板见 `docs/decisions/2026-08-24-linux-server-runtime-from-zero.md`：运行时搬 Linux 服务器，Windows 本机转人工派单。**下面每条都在 Ubuntu 24.04.4 + glibc 2.39 上真跑过**（orca 1.4.188 / Electron 43.1.0，AppImage 196MB，ready 契约 4～10s 出）。官方文档：`stablyai/orca` 的 `docs/reference/headless-linux-server.md`。

支持面：Ubuntu 20.04 / 22.04 / 24.04 与 Debian stable（glibc ≥ 2.31）。

```bash
# ① 前置。24.04 是 libfuse2t64，22.04 是 libfuse2
sudo apt-get update && sudo apt-get install -y curl file jq xvfb zlib1g-dev
sudo apt-get install -y libfuse2t64 || sudo apt-get install -y libfuse2

# ② 取 AppImage（目录 root 拥有，服务用户只许读+执行，不许替换）
sudo mkdir -p /opt/orca
sudo curl -fL https://github.com/stablyai/orca/releases/latest/download/orca-linux.AppImage \
  -o /opt/orca/orca-linux.AppImage
sudo chmod +x /opt/orca/orca-linux.AppImage

# ③ 无 FUSE（容器常见）走解包路。解包出来是 0700 root，要放开读+执行位
cd /opt/orca && sudo ./orca-linux.AppImage --appimage-extract
sudo chmod -R a+rX /opt/orca/squashfs-root

# ④ 先前台起一次拿 ready 契约（**非 root**）。无 DISPLAY 时 orca 自起 Xvfb
LIBGL_ALWAYS_SOFTWARE=1 /opt/orca/squashfs-root/AppRun serve --port 6768 --json
# 期望：一行 {"type":"orca_server_ready","schemaVersion":1,...}

# ⑤ serve 会自己装 CLI，PATH 必须带上（否则 dao.mjs 调 orca 全 ENOENT）
export PATH="$HOME/.local/bin:$PATH"   # 落进 ~/.bashrc
command -v orca                        # → ~/.local/bin/orca

# ⑥ 注册本仓，否则 worktree create 报 Missing repo selector（#762 同款坑）
orca repo add --path /path/to/windsurf-dao --json

# ⑦ 挂 skills（Linux 软链不需要开发者模式，这是搬家红利之一）
mkdir -p ~/.claude/skills
for d in host/skills/*/; do n=$(basename "$d"); ln -sfn "$PWD/host/skills/$n" ~/.claude/skills/"$n"; done

# ⑧ 上账号（没账号派工起得来终端也登不上）
orca account add --help

# ⑨ 常驻交给 systemd —— 单元在 host/machine/systemd/orca-serve.service，装法见文件头注释
```

### 两条部署前必须先定的（踩过就晚了）

**① checkout 必须落在服务用户的家目录，不是 root 家目录。** orca 拒绝以 root 运行（Electron 直接 `FATAL: Running as root without --no-sandbox is not supported`），所以常驻服务跑在专用用户下；而 `/root` 默认 0700，服务用户读不进去。落点用 `/home/<服务用户>/windsurf-dao`——**目录名必须以 `windsurf-dao` 结尾**，否则 `ledger.test.js` 的主树断言恒红。

```bash
sudo useradd --system --create-home --shell /bin/bash orca   # 要能跑 agent CLI，别用 nologin
sudo -u orca git clone https://github.com/thoerwink8/windsurf-dao.git /home/orca/windsurf-dao
```

**② `serve` 的监听绑 `0.0.0.0`，`--pairing-address` 只是「广告给客户端的地址」，不改绑定。** 公网 IP 的机器上等于把一个能控制这台机器的 WebSocket 挂到公网。配对有设备令牌，但不要拿它当边界。两条路选一条：

```bash
# A（推荐）：Tailscale，pairing 用 100.x 地址，6768 只对 tailscale0 开
sudo tailscale up && tailscale ip -4
sudo ufw allow in on tailscale0 to any port 6768 proto tcp
sudo ufw deny 6768/tcp

# B：只走 SSH 隧道，6768 一律不对外；客户端本地转发后 pairing 广告 ws://127.0.0.1:6768
sudo ufw deny 6768/tcp
ssh -N -L 6768:127.0.0.1:6768 <用户>@<服务器>
```

### 无头机上的交互式登录（各家 CLI 首登）

`orca account add` 与 Grok / Devin / OpenCode / cursor-agent 首登都要浏览器，无头机上这是最容易卡整晚的一步（#708 的「新 worktree 弹信任目录对话框」是同类）。两种流程分开对付：

- **device-code 流**（CLI 打印一个 URL + 配对码）：在**任何**有浏览器的地方打开那个 URL 认证即可，令牌回落到服务器上的 CLI。
- **localhost-callback 流**（CLI 在服务器上监听某端口等回调）：浏览器必须能访问到**服务器的** localhost。从带浏览器的机器开隧道再在本地开：

```bash
ssh -N -L <回调端口>:127.0.0.1:<回调端口> <用户>@<服务器>   # 然后浏览器开 http://localhost:<回调端口>
```

判据：CLI 提示里出现配对码 = device-code 流；提示 "waiting for browser" 且给的是 `http://localhost:...` = callback 流，要隧道。这一步只能由能操作浏览器、且持有用户登录态的执行体做——无头 agent 只会在这儿空转。

### 验收：一条命令

```bash
node scripts/server-check.mjs           # 人读
node scripts/server-check.mjs --json    # 给循环/差分
```

退出码三态，**没查成不许当通过**：`0` 全通 / `1` 有真红 / `2` 有没查成。调通期整晚侦测：

```bash
while :; do node scripts/server-check.mjs --json --out; sleep 300; done
# 落 ~/.dao/server-check/checks.jsonl（仓外，不会成为下一轮输入）
```

### 坑（都是实测踩的，别重踩）

- **进程名是 `orca-ide`，不是 `orca`**（裸 `orca` 在 Linux 与屏幕阅读器撞名，orca 另装一个 dispatcher）。所以 `pkill -f 'orca-id[e]'`——按 `AppRun` 或 `orca` 去 pkill 会全打空，残留进程占着单实例锁。
- **不要用 `orca --version` 探活**：它会拉起整个 app 并占住 userData profile 的单实例锁，后续 `serve` 直接 exit 3。探活用 `orca status --json`。
- **exit 3 = 单实例锁冲突**，重启无用（单元里 `RestartPreventExitStatus=3` 就为这个）。清法：先 `pkill -f 'orca-id[e]'`，再删 `~/.config/orca/SingletonLock`（连带 `SingletonSocket` / `SingletonCookie`）。
- **必须非 root**：root 跑 Electron 直接 `FATAL: Running as root without --no-sandbox is not supported`。用专用服务用户，不要加 `--no-sandbox` 绕。
- **`orca status --json` 恒返回 `ok:true`**，真信号在 `result.runtime.reachable`。只看 `ok` 会在 orca 已经死掉时报绿（2026-08-24 故意样本当场抓到）。
- **`ok:false` 时退出码仍是 0**——退出码不是信号，只认 JSON。
- orca 停掉时各面返回 `error.code=runtime_unavailable`：这是**没查成**，不是真红。混成红会把「orca 没起」这个根因埋进一片假红里。
- 日志里这两类报错**无害**：`Failed to connect to the bus`（文档明说不需要独立 D-Bus session）、`[codex-trust-grant] ... spawn codex ENOENT`（没装 codex CLI）。
- **2026-09-02 Contabo 实测续坑**（命令、包名、env 路径全文在 PR #796，当时未合；本条不抄值）：
  1. **systemd drop-in 注入 agent 的网关 env 与 PATH**。Orca `terminal create` 的壳不继承服务环境；`worktree create --agent` 起的 agent 继承。只改单元 drop-in，值不进仓（`host/skills/server-ops/SKILL.md`，INDEX E 类）。
  2. **Claude Code 无头信任框**：`IS_SANDBOX=1` 这版不认。要在 `~/.claude.json` 的 `projects` 里给工位树**父目录**写信任标记——它会向上找祖先，预置一次即可。
  3. **Orca 终端不吃 login shell 的 `~/.profile` / `~/.bashrc`**。人开的壳要自己补 PATH；agent 靠上一条 drop-in。

### 搬过去之后本仓的红项变化（实测）

orca 一进 PATH，AGENTS.md 记的那批「云上注定红」当场少一半：完整测试套从 4 条红降到 1 条 leaf（`resolveMainWorktreeRoot 认出本仓主树`，断言 checkout 目录名以 `windsurf-dao` 结尾；服务器上目录名对了就自己绿）。`dao-check` 挂上 skills 软链后到 85 绿 / 2 红，剩的两条是「没有托管账号」和上面那条 ledger 环境红。

## 10. 接上 memory

memory 住在**独立仓** `thoerwink8/windsurf-dao-memory`（私有，clone 需有权限）。本机 Claude 项目 memory 写在 `~/.claude/projects/<编码后的仓库路径>/memory/`，是一个指向那个仓 clone 的 Junction。编码规则：路径里**所有非 `[a-zA-Z0-9]` 字符一律换成 `-`**（点、空格、下划线、中文都算），不是只换盘符和斜杠。反例：`...\468-审官-gpt-5.6-sol` → `...-468----gpt-5-6-sol`（本机 `~/.claude/projects/` 下有这条真目录）。

**第一步：clone 一次 memory 仓**（本机任意位置，例：`D:\frank\windsurf-dao-memory`）：

```bash
git clone git@github.com:thoerwink8/windsurf-dao-memory.git
```

先关掉所有 Claude Code 窗口再跑下面的命令（它可能占着 `memory/` 句柄，改名会失败）。在**主仓根**执行下面这段——只接你正在跑命令的那份克隆，Orca worktree 各有自己的 `projects/<编码>` 目录，不会一起接上。**把 `$memRepo` 换成你 clone 的位置。**

**事前拦截**（含一层子目录，`-Recurse`）：本机是真目录时，脚本先核对本机每个文件是否都在 memory 仓里。本机有、memory 仓没有的文件会直接 throw，**不会改名、不会建 Junction**。同名但内容不同的只警告列出，仍会接上——接上后本机这几条变成仓内版本，旧内容留在改名备份目录里，需要就去比对。已是正确 Junction（目标 = 你的 memory 仓）则什么都不做、原地返回。接上之后 Claude 每写一条 memory，memory 仓 `git status` 就会多一条未提交变更，随手提交，别攒，也别 `git stash` 把记忆藏起来。

**自动同步**（2026-08-22 起）：`guard-keepalive --once` 尾部顺带跑 `scripts/memory-sync.mjs --once`——有未提交改动自动 commit、有未推送自动 push、远端领先先 `pull --rebase`（冲突只报不合、push 被拒不强推）。时间门 30 分钟，高频触发无害；手动立刻同步用 `node scripts/memory-sync.mjs --force`。新机不用额外装东西，接上 memory + 守卫保活后就自动有了。

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

Claude 侧由 §0 的 `onboard.mjs` 接（node 原生 junction，无需管理员/开发者模式）：缺的补、悬空的重建；本机同名的**真目录**（插件自带的 skill，如 `orca-cli`）只报 `skills-not-link` 不动——脚本绝不删本机目录，要换成仓内版本得自己先移走。Cursor 侧 onboard 不管，按 §11.2 手动接。

### 11.1 Claude Code：`~/.claude/skills`

`node scripts/onboard.mjs` 即可。验证：`ls ~/.claude/skills` 里每个仓内 skill 都在（`grill-ai` / `admit-push` / `pr-fast` / `dao-project` / `dao-mode` / `server-ops` / `feishu-ops` 都是这一步带上的）；哨兵报 `skills-partial` / `skills-dangling` 就重跑。桌面 `webview-debug` 已删（#808），不要从旧快照搬回。

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

## 12b. 专注/值守态注入（hook + `/dao-mode` skill）

三态开关（常态 / 专注 / 值守）靠两件东西：`/dao-mode` skill 负责切，UserPromptSubmit hook 负责**每轮把当前态注入上下文**。
承重的是 hook——skill 的字只在调用那一轮进上下文，不装 hook 等于「我说我专注了」。设计与拍板记录见 issue #488。

**① 一条链接，装完就齐**。`host/skills/dao-mode/` 同时是一个 Claude Code 插件（自带
`.claude-plugin/plugin.json` 与 `hooks/hooks.json`），链到 `~/.claude/skills/` 下之后宿主会自动加载成
`dao-mode@skills-dir`，skill 和 hook 一起生效。这条链接由 §0 的 `onboard.mjs` 随其它 skill 一起建
（node 原生 junction，Windows PowerShell 5.1 / pwsh 7 都不需要管理员），不用单独动手。
下次开 Claude Code 生效（当前会话里可以 `/reload-plugins`）。

**② 不要去改 `settings.json`**。2026-08-15 实测过三条路，结论：

- **插件面（上面这条 link）生效，且完全不碰 `settings.json`** —— 装完 `enabledPlugins` 与 `hooks` 段一个字没变，新会话第一轮就拿到态文本。
- 用户级 `~/.claude/settings.local.json` 的 `hooks` 段**宿主根本不读**（注册在那儿，新会话上下文里一个字都没有；同一条注册放进项目级 `.claude/settings.local.json` 立刻生效）。
- `~/.claude/settings.json` 能生效，但它是本页第 8 条那条红线文件（覆写可能触发 401 强制登出，改回去也恢复不了），且被 cc-switch 下发 / Orca 写 hooks / CC 本体重置三方互相覆盖。既然插件面够用，就不碰它。

**③ 验**：`node scripts/dao-check.mjs` 第 ⑧ 项会把装载面上那条命令真跑四次（四种状态文件各一次：读到且常态 /
读到且非常态 / 文件不在 / 文件坏了），四种输出两两同形、跑不动、或哪个装载面都点不到，都报红。
链接断了（比如仓库换了位置、worktree 被删）就是这么被抓出来的——重跑 `node scripts/onboard.mjs` 即可。

状态文件是 `~/.claude/state.json`，跨会话跨工作区唯一，由 `dao-mode.mjs` 独家读写，不要手改。

## 13. MCP 服务器：别用 `npx ...@latest` 装

MCP 服务器的命令行**每开一个会话就执行一次**。写成 `npx -y 某包@latest` 意味着每次都去
npm registry 现场解析 + 解包：2026-09-01 本机实测三个这样的服务器，冷启动多花约 19 秒
（playwright 6.6s、chrome-devtools 7.0s、context7 5.4s）。用户看到的症状是「模型好慢」，
而实际上请求根本还没发出去——网关侧计时里看不到这段，很难往这儿想。

**装法**：先装到本地，再让配置指向本地命令。

```powershell
npm install -g @playwright/mcp @upstash/context7-mcp chrome-devtools-mcp
$bin = npm prefix -g            # 例：C:\Users\<you>\AppData\Local\Programs\nodejs
claude mcp remove context7 -s user
claude mcp add context7 -s user -- cmd /c "$bin\context7-mcp.cmd"
```

装出来的 bin 名不等于包名，装完 `ls $bin\*.cmd` 对一眼再写路径
（`@playwright/mcp` → `playwright-mcp.cmd`，`chrome-devtools-mcp` → 同名）。

两个执行坑（2026-09-01 本机各栽一次）：

- **`claude mcp add` 必须在 PowerShell 里跑，别在 Git Bash**。Git Bash 会把 `/c`
  当路径转成 `C:/`，命令行照样"添加成功"，装出来的却是坏的。
- **子进程 flag 以 `--` 开头时 `claude mcp add` 收不了**（`--browserUrl=...` 会被它
  当成自己的选项报 `unknown option`，`--` 分隔符也挡不住）。改用 `claude mcp add-json`：

  ```powershell
  $json = '{"type":"stdio","command":"cmd","args":["/c","<bin>\\chrome-devtools-mcp.cmd","--browserUrl=http://127.0.0.1:9222"]}'
  claude mcp add-json chrome-devtools -s user $json
  ```

三条要点：

- **改配置走 `claude mcp add/remove`，别手改 `~/.claude.json`** —— 那是宿主自有文件，
  手改会被运行实例的内存态覆写（同第 8 条那类坑）。
- **只在全局放到处都用的**（本机是 codegraph / fetch / context7）；浏览器类
  （playwright、chrome-devtools）用 `-s project` 放进真正用它的项目，其余项目的会话不必付这份钱。
- 代价：版本钉住不自动追新，升级手动 `npm update -g`。

**省多少要看本机 registry 快不快**：2026-09-01 两台机同样钉三个包，一台省 19s
（registry 每包 5~7s），另一台只省 1.5s（`claude mcp list` 3.08s → 1.54s，registry 每包
0.4s，四个 server 摊下来一个约 0.4s，剩下的是进程启动+握手，钉不掉）。所以别拿别人的
数字当预期，钉之前先量一次 `claude mcp list` 的中位数，钉完再量一次。

**验**：`node scripts/onboard.mjs --dry-run` 的第 ④ 项会扫 `~/.claude.json`，发现 `npx`/`uvx`
现场解包型就报 `mcp-slow-boot`（只报不修——那是用户自己的文件）。测单个 server 的启动耗时别用
`Measure-Command { ... --help }`：flag 不识别时 server 会起来等 stdin，量出来是假大数；
真判据是 `claude mcp list` 的握手耗时。

## 13.1 「模型好慢」先分段，别先查网络

2026-09-01 两台机同一天各栽一次：用户报「模型好慢」，两边都先去查网关、查 Clash、查节点，
查了几个小时才发现**请求根本还没发出去**——慢在本地 harness 冷启动。网关侧计时看不到这段，
Mirasim 的 turn timing 也只给一个笼统的 `prep`。没有分段数字就只能猜，方向一错就是半天。

```bash
node scripts/agent-latency.mjs --cwd <项目目录> -n 4 --ab
```

四段：`init`（会话就绪＝CLI＋MCP 握手＋skills/CLAUDE.md）→ `msgStart`（上游开始回包）
→ `firstTok`（真首字）→ `done`。`init` 大 = 本机的事（回 §13 钉 MCP）；`firstTok - msgStart`
大 = 上游思考（`effortLevel` 买的），本机压不动。

**`msgStart - init` 两边都占**，别一看它大就判给网络：它 = 链路 RTT + 上游处理提示词，
而提示词多大是本机决定的。本机实测挂 4 个 MCP 时 92 个工具、上下文 70k tok，
关掉全部 MCP 掉到 33 个工具、52k tok——**首字快 1.6s**，其中只有 0.6s 是 init，
另外 1s 就落在这一段。多出来的工具定义即便全是 `cache_read`，上游读它照样要时间。
所以浏览器类 MCP 用 `-s project`（§13 第二条）省的不只是启动，是每一轮的首字。

四条测量纪律（都是踩出来的）：

- **stdin 必须关掉**。`claude -p` 没有 TTY 时会等管道输入干等 3 秒——不关就凭空多出 3s，
  会被误判成「本地慢」。脚本里 `stdio[0]='ignore'`；命令行手测要 `< /dev/null`。
- **n 至少 5**。上游抖动 ±1.5s：同一个 A/B，n=3 测出「MCP 只花 60ms」，n=5 测出 1614ms——
  小样本会把真实差异整个淹掉，然后你据此做出错误的「不用优化」判断。
- **报中位并把每次原值打出来**，均值会把离群点糊进结论。
- **`duration_api_ms` 不是首字**，那是整段 API。真首字要 `--output-format stream-json
  --include-partial-messages`，取第一个 `content_block_delta` 的时刻。

本机基线（2026-09-01，opus + effort high，n=5，仅供对照——各机链路不同，别照搬）：
首字 6.1s = 本地就绪 1.47s + 上游首包 2.88s + 思考 1.76s；本地占 24%。

## 13.2 分完段还剩一段「关不掉的等待」——挖到这儿就停手

2026-09-02 本机（Windows / i5-10400）：MCP 已按 §13 全部钉本地，`init` 中位仍是 **20.5s**。
按 §13.1 分完段继续往下挖了一整轮，结论是**本机配置层面没有任何东西能再压它**。
把已排除的写在这里，下次别再挖第二遍。

`init` 20.5s 的构成（进程级 IO/CPU 采样 + 自建代理探针，两者互证）：

| 段 | 时长 | 特征 |
|---|---|---|
| 加载 | ~11s | 读入 195MB、烧 5.9s CPU——真在干活 |
| MCP 握手 | ~3.2s | 20530ms → 17352ms（`--strict-mcp-config` 空配置） |
| **固定等待** | **~6–7s** | 不读盘、不烧 CPU、无代理流量、无子进程动静 |

那段固定等待的关键性质：**长度不随前面的负载伸缩**。带 MCP 与不带 MCP 两轮，加载阶段差 3.3s，
等待段却是 11.6s vs 12.8s——它是等出来的，不是算出来的。**换更快的 CPU 大概率也压不掉它。**

已实测排除的（别重跑）：

| 怀疑对象 | 怎么判的 | 结果 |
|---|---|---|
| MCP | `--strict-mcp-config` 空配置对照 | 全部只值 3.2s |
| 项目 CLAUDE.md / 项目钩子 | 换到空目录测 | 空目录一样慢，甚至更慢 |
| 全局钩子 / 插件 / statusline | `--settings` 覆写全关 | 无变化 |
| Defender 实时扫描 | 启动全程采 MsMpEng 的 CPU | **+0 秒** |
| 磁盘 | SSD 健康、`readdir` 1ms | 无罪 |
| CPU 被抢占 | 进程提到 High 优先级重测 | 无变化 |
| 被墙的域名 | 逐个测直连/代理往返 | 上报域名全部 0.5–2.8s |
| 90+ 个 `DISABLE_*` 开关 | 从 218MB 二进制里挖出来全关 | 差异全在 ±2s 噪声内 |

（`downloads.claude.ai` 和 `raw.githubusercontent.com` 直连确实各挂 21s，但 CLI 走代理，没踩到。
所以「有域名被墙」和「CLI 因此变慢」是两件事，别看到前者就结案。）

**唯一有效的杠杆是别冷启动。** `claude --resume` 接续会话，这 20 秒一天只付一次，
而不是每开一个终端付一次。

### 钉 MCP 还值不值：值，但买的是方差不是速度

本机缓存热时，钉本地 vs `npx @latest` 只差 **1.3s**（19753 vs 21052ms，n=3），
而且这个差值**小于 npx 组自身的跨度**（18079/21052/21971，跨度 3.9s）——方向对，数值不准。
§13 记的 19 秒是缓存冷、registry 现场解包时的量级。

所以：**照钉不误**（它剪掉的是长尾，不是均值），但**别再往 MCP 方向要时间**——那条路总共只有 3.2s。

### 一条自证：§13.1 第一条纪律是真的

这轮排查里我自己踩了它——探针 spawn 时用默认 stdio 没关 stdin，`init` 凭空多了 3–4s，
一度把 20.5s 报成 24–26s，差点据此对「加载阶段」下错判断。**`stdio[0]='ignore'` 不是可选项。**

### 别拿别人的基线当预期

§13.1 末尾那条「本地就绪 1.47s」是另一台机的。本机单核基准（3e8 次取模）**708ms**，
现代机 250–400ms，**慢约 2 倍**；测的时候还有 34 个 Chrome 进程占 6GB、CPU 常驻 60–87%。
同一份配置在两台机上能差一个数量级——量之前先跑一次基准，别照搬。

## 统一命令库

起终端和编排不要手拼 orca 命令（手打 `codex -a never` 会把 gh/node 拦死、写不存在的 `--submit` 都在这里栽过）。走：

```bash
node scripts/dao.mjs --help
node scripts/dao.mjs start --provider gpt --worktree active --dry-run
node scripts/dao.mjs dispatch --name "卡名" --merge-policy auto --model grok-4.6 --reviewer gpt-5.6-sol --split no --split-reason "新机自检单卡" --spec "短摘要" --dry-run
```

派工默认 `merge-policy: auto`（#511 拍板：帅只感知不再是关口）；选 `manual` 必须带 `--merge-reason <理由>`（只限改协作约定 / 改 model-routing.json 决策字段 / 花钱三类），理由写进任务卡 comment 留痕。另必须带 `--model` 或 `--role`、`--reviewer`、`--spec`、`--split`，缺一就停。`--split no` 必须带 `--split-reason`；`--split N` 必须带 N 个 `--slice`。启动模板只在 `docs/model-routing.toml` 的 `[providers.*].launch`。

派工闸挂在**随仓 `.claude/settings.json`**（#553 从 plugin 换挂法，`host/skills/dispatch/` 已不再自带插件层）：`PreToolUse` 指向 `scripts/lib/dispatch-gate-hook.mjs`（逻辑在 `scripts/lib/dispatch-gate.mjs` 唯一一份）。**闸门随仓生效，无需装机动作**——clone 即带上，cc-switch 覆盖不到；已开着的会话重开一次才加载新 hook。裸 `orca orchestration worker-start` / `task-create` 会被 exit 2 拦住（#546 #517）。dao-check 第 ⑬ 项每次重跑闸门：装载面在、脚本在、旁路必须拦、逃生口必须过、崩了必须也拦。逃生口 `node scripts/dao.mjs raw -- <命令>` 会记一笔到 `_flow/cmd-escape.jsonl`（记账走 stderr，stdout 保持子进程原样）。给已有 PR 补审官用 `node scripts/dao.mjs reviewer-attach --pr <N> --worktree <工人卡> --reviewer <模型>`（一条命令：建树 + 起终端 + 注入 + 验开工）。`reviewer-create --pr <N>` 只建树。

微通道（#682）：几行改动走 `node scripts/quick-fix.mjs --issue <N> --model <主会话模型> [--yes]`——一条命令原子完成 分支 → dao-worker[bot] commit → push → 非 draft PR → label → 异步审官，20 秒内落地；任一步失败整体回滚。`--model` 必须显式声明（#679 同厂闸），审官默认读 issue 的 `reviewer/*` label。异步审官日志在 `~/.dao/quickfix/quickfix-<issue>.log`。无新装依赖（复用 gh / orca / 三身份凭据）。

### 分支卫生：一条命令，不设规矩

**日常收工直接用 `node scripts/land.mjs`**（2026-08-31 起，本节两条命令 + 推主分支 + 拆已合并 worktree 已合成它的一部分，带六道安全闸，任何 git 仓可用；决策见 `docs/decisions/2026-08-31-land-check-slim-review-standard.md`）。下面保留原始命令，供 land 不可用或在别的机器上手搓时用。

**先知道哪些是自动的，别重复造**：GitHub 的 `delete_branch_on_merge` 已开，**PR 合并后远端分支自动删**（2026-08-31 抽查最近 6 个 merged PR，分支全没了）。它**只认 merge**——PR 被 close、或压根没开过 PR 的分支不触发；本地分支引用 git 也从不自动删。所以残留只有这两种，量很小（790+ PR 沉了 27 条，3.4%），不值得为它立规矩或加检查（2026-08-31 拍板：不立制度，只留命令）。

想起来就跑，任何时候都安全：

```bash
git fetch --prune                                                   # 清掉指向已删远端的本地引用
git branch --merged master --format='%(refname:short)' \
  | grep -v '^master$' | xargs -r git branch -d                     # 删已合并的本地分支
```

`-d`（不是 `-D`）是安全网：未合并的、别的 worktree 正签出的，它会拒绝而不是照删。

远端残留只**列出来给人看**，不自动删——删掉后那些 PR 页的 diff 会失效：

```bash
gh pr list --state open --json headRefName --jq '.[].headRefName' > /tmp/open.txt
git ls-remote --heads origin | sed 's|.*refs/heads/||' \
  | grep -vxF -f /tmp/open.txt | grep -v '^master$'                 # 无开放 PR 的远端分支
```

删本地前先看一眼有没有**只在本地**的活（`git branch -vv` 里没有上游、或 `未推 > 0`）——那种删了就真没了，`-d` 拦不住已合并但未推的情况。


## 自检

做完跑一遍：

```bash
node scripts/dao-check.mjs
```

退出码 0 = 环境就绪。
