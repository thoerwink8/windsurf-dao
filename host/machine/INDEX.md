# 换机路径地图

夹只装 **B 类模板** + 本页 + `ignore.md`。不镜像 `~`。

装法只信 `NEW-MACHINE.md`，本页不复制步骤、不复制会过期的值。

## 类

| 类 | 意思 |
|---|---|
| A | 仓内真相源：clone 即得，本机只接或同步 |
| B | 本机模板：从 `host/machine/` 拷出去，再改本机路径 |
| C | 密钥 / 凭据：不进 git，换机手动带 |
| D | 禁拷：不要拷、不要进 git、不要整文件覆写 |
| E | 他仓真相源：本仓不写装法，只登记「这个落点归哪个仓」。**只写仓名不写文件路径**——文件会挪，仓名不会，跨仓的指针本仓也配不了报警 |

## 路径

闸把仓外路径收到「家目录下两段」（`AppData` 三段）。本表按同一把钥匙写。

| 类 | 路径 | 看 |
|---|---|---|
| A | ~/.claude | 产品根。子项见下行，不要整目录镜像 |
| A | ~/.claude/CLAUDE.md | NEW-MACHINE §3。真相源 `docs/global-CLAUDE.md` |
| A | ~/.claude/projects | NEW-MACHINE §10。memory 是指向独立仓的 Junction |
| D | ~/.claude/settings.json | NEW-MACHINE §8。覆写可能 401，禁整文件进 git。其中 `statusLine.command` 指本仓 `host/statusline.js` 的**本机绝对路径**（仓搬家/换机要手改）——onboard 哨兵 `statusline-dangling` 报断 |
| D | ~/.claude/settings.local.json | 用户级 hooks 段宿主不读。不要当装机源 |
| A | ~/.claude/skills | NEW-MACHINE §11。链到 `host/skills` |
| D | ~/.claude/state.json | dao-mode 状态。不要手改，不要当配置拷 |
| D | ~/.claude.json | MCP 服务器清单等。NEW-MACHINE §13（装 MCP 别用 `npx @latest`）。改走 `claude mcp` 子命令，手改会被内存态覆写 |
| D | ~/.codex/rules | 本机批准过的 prefix_rule。不进 git |
| C | ~/.commandcode/auth.json | NEW-MACHINE §7b。登录态，只能用户在真 TTY 登 |
| D | ~/.config/orca | NEW-MACHINE §9d。Linux 上 Orca 的 userData profile（单实例锁 / daemon socket / 日志）。Orca 开着会回写，不要拷、不要改；Windows 同物是 %APPDATA%\orca |
| C | ~/.dao | GitHub App 凭据根 |
| C | ~/.dao/apps | NEW-MACHINE §4b。六份 pem/json，丢了要回 GitHub 再生成 |
| D | ~/.dao/guard-mirror | NEW-MACHINE §9。守卫只读镜像，启动 fetch + reset --hard origin/master，不要手拷 |
| D | ~/.dao/guard | NEW-MACHINE §9b。保活日志 / 自停留痕。换机重建，不要拷 |
| C | ~/.dao/ledger | NEW-MACHINE §4c。点将台事件账本机落点（不进 git）。新机自动从仓内历史种子；本机新增事件要带走就手动拷（同名即同一事件，合并拷安全） |
| D | ~/.dao/board-archive | 盘面存档本机落点（`dao.mjs board-archive` / `board-reset` 自动建）。清盘前的历史记录，换机不拷 |
| B | ~/.local/bin | shim。模板在 `host/machine/shims/` |
| E | ~/.ssh | 归 `ai-gateway-stack`（装机脚本要登 VPS；`deploy/machine-check.mjs` 查 `Host myserver` 条目、私钥、连接层配置）。本仓不写装法 |
| E | ~/.mirasim | 归 `ai-gateway-stack`。模型供应商配置，以及 `setting.json` 的 `networkProxy`（代理分流，不配会慢 35 倍）。本仓不写装法 |
| E | ~/.mirasim/keys | 归 `ai-gateway-stack`。飞书 App 凭据（feishu-app.json，#801）与 grok key（grok.key）落点，600 不进 git/聊天；本仓不写装法 |
| C/D | ~/.pi/agent | NEW-MACHINE §4 / §6。auth.json 是 C；sessions 不拷；models-store 止血换机要再做 |
| B | ~/AppData/Local/cursor-agent | cursor 真实二进制。shim 包装它，路径因机而异 |
| B/C | ~/AppData/Local/devin | NEW-MACHINE「devin 怎么配」。cli/bin 是二进制；credentials.toml 是 C，不进 git |
| D | ~/AppData/Local/ms-playwright-mcp | 浏览器锁 / 缓存。不拷；坏了按 NEW-MACHINE §8 清 |
| B | ~/.orca/agent-hooks | Orca 状态 hook。模板 `host/machine/hooks/` |
| D | ~/AppData/Roaming/orca | Orca Desktop 本机画像。派工启动听仓内 launch；这份文件只拿来比较，禁拷、禁改、不进 git |
| D | ~/AppData/Roaming/Devin | Devin 桌面端 user-data-dir。派工走 CLI 非交互形态，桌面端不参与 |
| E | ~/AppData/Roaming/mihomo-party | 归 `ai-gateway-stack`。Clash Party 覆写里有按 IP 写死的网关直连规则，换 VPS 要跟着改；覆写只在启动时读盘，改完必须重启 |
| A | ~/.cursor/skills | NEW-MACHINE §11.2。链到 `host/skills`（Cursor Desktop；与 `~/.claude/skills` 对称） |
| D | ~/.cursor/skills-cursor | Cursor 系统内置 skills，禁手写；装机只链 `~/.cursor/skills` |
| B | ~/.cursor/hooks.json | 用户级 hook 登记。必须 `conhost --headless`，禁止 EncodedCommand |
