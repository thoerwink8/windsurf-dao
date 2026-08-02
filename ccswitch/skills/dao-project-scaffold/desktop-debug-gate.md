# 桌面端调试基建门控 · desktop-debug-gate

> 一次 scaffold 省百次重试。

**触发条件**：检测到 `apps/*/src-tauri/` 或 `src-tauri/` 或任意 `tauri.conf.json`（Tauri 项目），
或 `go.mod` 含 `wailsapp/wails`（**Wails 项目，2026-08-02 补**——同一个 WebView2 底座的第二生态，
此前整个不在指纹里），或 `electron` / `electron-builder` 依赖（Electron 项目）。

## 跨层一致性：SQL 迁移 ↔ Rust 注册

若检测到 `apps/*/src-tauri/migrations/` 或 `src-tauri/migrations/`：

1. 检查 `scripts/check-migrations.ts` 存在
2. 检查 `scripts/__tests__/check-migrations.spec.ts` 存在
3. 检查 `package.json` 含 `check:migrations` 脚本
4. 缺项 → 建议创建，提供 TraceyU 参考模板

## 调试基建检测

若检测到桌面端项目（Tauri / Wails / Electron）：

1. 检查有没有**调试入口**，两态任一即算有——优劣不同，msg 要说清：
   - ✅ **正解**：隔离启动脚本 `scripts/start-isolated-dev.*`（四条硬要求 + preflight +
     三关自验 + 退出码契约，见 `stacks/desktop-webview.md`「隔离启动器 · canonical 契约」）
   - ⚠️ **最低形态**：`package.json` 含 `dev:debug` 脚本。**通行的那种写法（写死 9222 +
     不给独立 user-data-dir）已被实证为不足**：9222 的典型占用者就是用户自己的装机实例，
     且调试端口按 user-data-dir 绑定，共用目录时**光换端口号仍会静默失败**（2026-07-26 实证）
     ⇒ 检到只有 `dev:debug` 时，顺带看它**给没给独立用户数据目录**、**端口是不是写死的 9222**
2. 检查 `.claude/rules/desktop-debugging.md` 存在（canonical 骨架见下方「模板去哪拿」）
3. 检查 `CLAUDE.md` 记录了调试实例的起法
4. 缺项 → 从 canonical 派生，见下

**为什么必须在 scaffold 阶段就位**：桌面端调试工具选择（chrome-devtools vs playwright，
windows-mcp 已一票否决弃用见 `dao.md` §目·观 与 `ccswitch/rules/dao-gui-verify.md`）是高频决策。
没有规则文件 → AI 每次会话自行判断 → 选错工具 → 排障循环 → 烧 context + 烧钱。一次 scaffold 省百次重试。

## 模板去哪拿（2026-08-02 起有 canonical，不再让人现场重写）

| 缺什么 | canonical | 怎么落地 |
|---|---|---|
| `.claude/rules/desktop-debugging.md` | `ccswitch/templates/desktop-debugging-rule.md` | 由 `scaffold-manifest.json` 的 `desktop-debugging-rule` 条目**自动给出零编辑复制指令**；复制后只填「三、项目实况」各槽位，一二两节整段照抄不改写 |
| 调试入口（隔离启动器） | **无脚本本体 canonical**（深度绑定项目自身的隔离面与 OS） | 照 `stacks/desktop-webview.md`「隔离启动器 · canonical 契约」自实现：四条硬要求 + preflight + 三关自验 + 退出码契约要对得上 |

🔴 **本节 2026-08-02 撤掉了两段 `dev:debug` 模板片段**（Tauri 的
`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222` 与 Electron 的
`ELECTRON_EXTRA_LAUNCH_ARGS=--remote-debugging-port=9222`）。**它们写死 9222 且不给独立
用户数据目录，正是本文件上方检测逻辑 1 自己判为「已被实证为不足」的那种写法**——
一边把它标成"最低形态、已被实证不足"，一边在同一个文件里把它当模板发下去。
实测代价：某项目的那行缺陷脚本与本处旧模板**逐字节相同**，是忠实照抄不是自己写歪的。
⇒ **母版先对，副本才有对的可抄。** 需要开端口的写法见 `stacks/desktop-webview.md` §一那张
「各框架怎么开」的表（它同时给出 WebView2 / Electron / WKWebView 三路，并明写"禁止写死端口"）。

## 检查清单

- [ ] 🤖 有调试入口：`scripts/start-isolated-dev.*`（正解）**或** `package.json` 含 `dev:debug`（最低形态）——机检只判「有没有」，形态优劣见上方检测逻辑 1
- [ ] 🤖 `.claude/rules/desktop-debugging.md` 存在（**有 canonical，可一键物化**）
- [ ] `CLAUDE.md` 记录了起隔离实例的命令及说明
- [ ] （若有 `migrations/`）跨层一致性检查脚手架就位（见上方）

缺项处置见 SKILL.md §缺项怎么处置。
**分档（2026-08-02 更新）**：`.claude/rules/desktop-debugging.md` 有 canonical ⇒ **甲档可物化**
（复制指令由清单 `template` 字段生成）；**隔离启动器仍是乙档**——脚本本体与项目自身的隔离面
深度耦合，可迁移的只有硬要求与退出码约定（见 `stacks/desktop-webview.md`），可代写但要逐条说清依据。
