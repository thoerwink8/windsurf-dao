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

## 调试通道 · WebView2 远程调试

在 Windows 上，WebView2 支持 Chrome DevTools Protocol。设环境变量后 chrome-devtools MCP 可直连 Tauri 窗口内的 WebView：

```powershell
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9222"
pnpm tauri dev
```

**项目固化**：应在 `package.json` 添加 `dev:debug` 脚本，而非每次手动设环境变量。

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

## 分层测试策略

| 验证什么 | 工具 | Claude Code 能力 | 环境完整度 |
|---|---|---|---|
| 逻辑/状态机 | Vitest + happy-dom | 写 + 跑，全自动 | 无 UI |
| UI 渲染/交互 | Vite only + playwright MCP | 截图 + 操作 | 无 SQLite/IPC |
| Tauri 原生功能 | WebView2 CDP + chrome-devtools MCP | 截图 + JS 执行 | **完整** |
| 完整回归 | WebdriverIO + tauri-driver | 写测试 + 跑结果 | **完整** |

**选择原则**：能用轻量层验证的不用重量层。改了 CSS → Vitest 快照或 playwright；改了 Rust migration → 必须 WebView2 CDP。

## 会话纪律

- 进程管理在**会话最开头做一次**，不在中途反复杀重启
- 同一会话只用一个浏览器 MCP 工具，不中途换
- MCP 连接失败 2 次 → 检查端口/进程，不盲目重试
- 截图路径遵循 dao.md 截图路径强制规则
