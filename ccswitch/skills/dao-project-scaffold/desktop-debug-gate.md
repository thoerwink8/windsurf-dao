# 桌面端调试基建门控 · desktop-debug-gate

> 一次 scaffold 省百次重试。

**触发条件**：检测到 `apps/*/src-tauri/` 或 `src-tauri/`（Tauri 项目），或 `electron` / `electron-builder` 依赖（Electron 项目）。

## 跨层一致性：SQL 迁移 ↔ Rust 注册

若检测到 `apps/*/src-tauri/migrations/` 或 `src-tauri/migrations/`：

1. 检查 `scripts/check-migrations.ts` 存在
2. 检查 `scripts/__tests__/check-migrations.spec.ts` 存在
3. 检查 `package.json` 含 `check:migrations` 脚本
4. 缺项 → 建议创建，提供 TraceyU 参考模板

## 调试基建检测

若检测到 Tauri 项目：

1. 检查 `package.json` 含 `dev:debug` 脚本（设 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222`）
2. 检查 `.claude/rules/desktop-debugging.md` 存在（含工具选择铁律 + 启动命令表）
3. 检查 `CLAUDE.md` 记录了 `dev:debug` 命令
4. 缺项 → 建议创建，参考 `stacks/desktop-tauri.md` 处方

**为什么必须在 scaffold 阶段就位**：桌面端调试工具选择（chrome-devtools vs playwright，windows-mcp 已弃用见 `dao.md` §目·观）是高频决策。没有规则文件 → AI 每次会话自行判断 → 选错工具 → 排障循环 → 烧 context + 烧钱。一次 scaffold 省百次重试。

模板（`dev:debug` 脚本内容，Windows cmd.exe 语法）：
```
"dev:debug": "set WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222&& pnpm tauri dev"
```

若检测到 Electron 项目，同理检测 `dev:debug` 脚本，但环境变量不同：
```
"dev:debug": "set ELECTRON_EXTRA_LAUNCH_ARGS=--remote-debugging-port=9222&& electron ."
```

## 检查清单

- [ ] `package.json` 含 `dev:debug` 脚本（WebView2 远程调试端口）
- [ ] `.claude/rules/desktop-debugging.md` 存在（MCP 工具选择 + 启动命令）
- [ ] `CLAUDE.md` 记录了 `dev:debug` 命令及说明
- [ ] （若有 `migrations/`）跨层一致性检查脚手架就位（见上方）

缺项不自动创建，建议用户创建并说明理由。
