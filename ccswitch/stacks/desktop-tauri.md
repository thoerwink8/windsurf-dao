---
name: dao-stack-desktop-tauri
description: 桌面端技术栈处方:Tauri 2 + WebView2 调试 + 分层测试策略。桌面项目开发/调试工作流基建。
---

# Tauri 桌面端处方

> 天下之至柔，驰骋天下之至坚。无有入无间。——WebView 是柔（Web），Rust 是坚（Native），调试通道是"无间"。

## 触发

- 项目使用 Tauri 2 + WebView2
- GUI 调试/截图/自动化验证场景

## 核心架构认知

Tauri dev 由**两个独立进程**组成：

| 层 | 进程 | 热更新 | 变更示例 |
|---|---|---|---|
| 前端 (React/TS) | Vite dev server | HMR 即时生效 | `.tsx` / `.ts` / `.css` |
| 后端 (Rust) | Tauri 二进制 | **需要重编译** | `lib.rs` / `migrations/*.sql` / `Cargo.toml` |

**铁律**：修改 Rust 侧后必须重启 `pnpm tauri dev`。HMR 只覆盖前端。

## 真机验证构建 · custom-protocol feature 是必需项（L18 血泪，2026-07-13）

plain `cargo build --release`（不带 `--features tauri/custom-protocol`）不会把 `frontendDist` 嵌入产物——产物里的 `devUrl`（如 `http://localhost:5173`）仍生效，启动后加载的是**别人正在跑的 Vite dev server**，且与之共享同一应用 DB，验证结果全部作废（险些验证了错误代码）。

- **正解**：真机验证构建必须 `cargo build -p <app> --release --features tauri/custom-protocol`
- **信号**：`chrome-devtools list_pages` 若看到 `localhost:5173` 而非 `tauri.localhost` 即中招，立即停止验证、重新按上述命令构建

## 调试通道 · WebView2 远程调试

在 Windows 上，WebView2 支持 Chrome DevTools Protocol。设环境变量后 chrome-devtools MCP 可直连 Tauri 窗口内的 WebView：

```powershell
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9222"
pnpm tauri dev
```

**项目固化**：应在 `package.json` 添加 `dev:debug` 脚本，而非每次手动设环境变量。
跨平台用 `cross-env`：`"dev:debug": "cross-env WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 tauri dev"`。

### ⚠ 端口争用 · chrome-devtools 连到"错的应用"（L14 血泪，2026-07-10）

**关键认知**：`chrome-devtools` MCP 若无 `--browser-url` 参数（默认配置就没有），会连**固定 9222 端口**的 CDP。9222 是**全局独占**资源——多个 Tauri 应用（或残留的 `msedgewebview2` 僵尸进程）抢同一端口，**谁先绑定谁拥有**。后启动的应用 `--remote-debugging-port=9222` 静默失败（端口已占）→ 拿不到调试端口 → chrome-devtools 连到的是**先占住 9222 的那个应用**。

**症状**：`list_pages` 显示的是**别的 Tauri 应用**（如 TraceyU）而非你正在调试的应用。

**这不是"CDP 不可用"——是端口争用。** 误判为 CDP 不可用而降级到 windows-mcp 是错的（本条即由此教训而生）。

**dogfood 前置检查（每次起 WebView2 调试前必做）**：
1. **清端口**：`Get-NetTCPConnection -LocalPort 9222 -State Listen` → 有占用者则 `Stop-Process -Force`（含残留 msedgewebview2 僵尸 + 其他 Tauri 应用的调试进程）
2. **独占启动**：`pnpm dev:debug`，只让目标应用占 9222
3. **验证归属**：`curl -s http://localhost:9222/json` → 确认返回的 `title`/`url` 是**你的应用**（如 mousse/localhost:5173），不是别的
4. **再连 MCP**：`chrome-devtools list_pages` 应显示你的应用。若仍是别的 → 回步骤 1 端口没清干净

**根治（可选，避免每次清端口）**：给每个 Tauri 项目分配**唯一调试端口**（mousse=9222、TraceyU=9223…），并为需要连非默认端口的应用配一个带 `--browser-url http://127.0.0.1:<port>` 的专用 chrome-devtools MCP 条目。默认 9222 留给"当前主调试应用"。

### 为什么不用 Chrome 做代理

```
❌ 旧路径（4 进程，每个都是断点）：
  Vite → Tauri → Chrome(--remote-debugging-port) → chrome-devtools MCP
  问题：Chrome 连接失败 / 端口冲突 / browser lock / SQLite 不可用

✅ 新路径（2 进程，直连）：
  Vite → Tauri(WebView2 --remote-debugging-port) → chrome-devtools MCP
  优势：真实环境（SQLite/IPC 全可用）、少两个进程、无连接中间人
```

### 为什么不用 windows-mcp

windows-mcp 的 Screenshot 会切换窗口焦点、全屏截图含任务栏、无 DOM 访问能力。对有 WebView 的应用是降级方案，不是首选。仅在 WebView 远程调试完全不可用时作为最后手段。

## GUI 工具能力对比（自 dao.md 下沉，2026-07-07）

| 能力 | chrome-devtools | playwright | windows-mcp |
|---|---|---|---|
| DOM 查询 | ✅ | ✅ (snapshot) | ❌ |
| JS 执行 | ✅ | ✅ (evaluate) | ❌ |
| 元素级截图 | ✅ | ✅ | ❌（全窗口） |
| 表单交互 | ✅ | ✅ | ⚠（坐标点击） |
| 需要调试端口 | ✅ CDP | ❌ 自管 | ❌ |
| 连 WebView2 | ✅（设环境变量） | ❌ | ❌ |
| 窗口切换/焦点 | 无 | 无 | ⚠ 有 |

选型走 dao.md「目·观」决策树；本表只做能力细节备查。

## 分层测试策略

| 验证什么 | 工具 | Claude Code 能力 | 环境完整度 |
|---|---|---|---|
| 逻辑/状态机 | Vitest + happy-dom | 写 + 跑，全自动 | 无 UI |
| UI 渲染/交互 | Vite only + playwright MCP | 截图 + 操作 | 无 SQLite/IPC |
| Tauri 原生功能 | WebView2 CDP + chrome-devtools MCP | 截图 + JS 执行 | **完整** |
| 完整回归 | WebdriverIO + tauri-driver | 写测试 + 跑结果 | **完整** |

**选择原则**：能用轻量层验证的不用重量层。改了 CSS → Vitest 快照或 playwright；改了 Rust migration → 必须 WebView2 CDP。

## 实机长任务 · 源码冻结窗口（L9，血泪）

实机 E2E / 长生成任务运行期间**禁止编辑前端源码**——保存即触发 Vite HMR 全页 reload：

- 运行中的流式任务被杀，早期中断连 partial 都没有，无从续传
- 更隐蔽：被杀的流平台照计费但拿不到 usage chunk = 账单结构性盲区（对完成调用精确、对中断流失明）

**判据**：触发实机 E2E / 长生成前声明「源码冻结窗口」；确需编辑先确认无实机任务在跑。

## 会话纪律

- 进程管理在**会话最开头做一次**，不在中途反复杀重启
- 同一会话只用一个浏览器 MCP 工具，不中途换
- MCP 连接失败 2 次 → 检查端口/进程，不盲目重试
- **chrome-devtools 连到错的应用 ≠ CDP 不可用**：先按上方「端口争用」前置检查清端口独占，**不要**因此降级到 windows-mcp（L14）。windows-mcp 仅在 WebView2 CDP **物理不可用**（非 Windows / WebView2 不支持 CDP）时才用
- 截图路径遵循 dao.md 截图路径强制规则
