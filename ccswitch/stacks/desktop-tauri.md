---
name: dao-stack-desktop-tauri
description: 桌面端技术栈处方 · Tauri 特有面:两进程架构与 HMR 铁律、custom-protocol feature、GUI 工具能力对比表、分层测试策略。WebView 调试端口与隔离启动器等框架无关面见 desktop-webview.md。
---

# Tauri 桌面端处方 · 框架特有层

> 天下之至柔，驰骋天下之至坚。无有入无间。——WebView 是柔（Web），Rust 是坚（Native）。

## 触发

- 项目使用 Tauri 2
- GUI 调试/截图/自动化验证场景（**先读 `desktop-webview.md`**，见下）

## 🔗 框架无关的那一半在 `stacks/desktop-webview.md`（2026-08-02 提级）

**调试端口怎么开 / 端口归属怎么验 / 隔离启动器的 canonical 契约（四条硬要求 + preflight +
三关自验 + 退出码契约 + 项目自定义隔离面）**，2026-08-02 起住在 `stacks/desktop-webview.md`，
**那里是唯一真相源，本文件不复述**。

**为什么迁**：那两节一个字都不涉及 Tauri —— 调试端口是 **WebView2 运行时**读的环境变量
（`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` / `WEBVIEW2_USER_DATA_FOLDER` 都是 Microsoft 文档化的
Loader 级变量），任何 WebView2 宿主（含 **Wails**）吃的是同一套。留在框架文件里的代价已经现形：
2026-08-02 三仓审计实测，同一底座的第二生态（Wails）整个不在桌面端机检的指纹里，
这两节对它**结构上不可达**。

**留在本文件的判据**：换一个 WebView 宿主（Wails / Electron / CEF）就不成立的，才是 Tauri 特有面。

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

## windows-mcp 已弃用（用户拍板 2026-07-25，一票否决）

**任何场景不得使用 windows-mcp 任何工具**——该 MCP 已从用户机器卸载，禁令见 `dao.md` §目·观
（并由 `ccswitch/hooks/dao-hard-gates.js` G1 在 PreToolUse `exit 2` 硬闸阻断）。
弃用理由：Screenshot 切换窗口焦点污染被测状态、全屏截图含任务栏、无 DOM 访问、位图证据不如
DOM 文本可复核且更烧 token。替代分工：DOM 与截图 → chrome-devtools / playwright；进程与注册表
→ 内置 PowerShell 工具；文件读写搜索 → 内置 Read / Grep / Glob；纯 Win32 无 Web 层 →
PowerShell + .NET 截图脚本，不行则诚实挂账「需用户目视」。

**下方能力对比表的 windows-mcp 列仅作历史存档**，不再是可选项。

### 无 MCP 的原生桌面能力兜底（2026-07-25 实测通过，替代 windows-mcp 的两项能力）

真遇到「必须截桌面」或「必须操控原生窗口」的小概率场景，走 PowerShell 原生路径，**不要为此装回 windows-mcp**。

**① 截图（比 windows-mcp 更好：不切换窗口焦点、可指定区域、可裁掉任务栏）**：
`Add-Type -AssemblyName System.Windows.Forms,System.Drawing` → 取 `[System.Windows.Forms.SystemInformation]::VirtualScreen` 得真实画布尺寸 → `New-Object System.Drawing.Bitmap` + `[System.Drawing.Graphics]::FromImage($bmp)` → `$g.CopyFromScreen($vs.X,$vs.Y,0,0,$bmp.Size)` → `$bmp.Save(path, Png)` → **务必 `Dispose()` 释放 GDI 句柄**。截区域只需换 `CopyFromScreen` 的源坐标与 `$bmp` 尺寸。产物落项目 `_tmp/qa/`；**含用户桌面隐私内容的探针截图用完即删**。

**② 原生窗口操控（比坐标点击更可靠：按控件而非像素）**：
`Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes` → `[System.Windows.Automation.AutomationElement]::RootElement` → `FindAll/FindFirst` + `PropertyCondition`（按 `NameProperty`/`ClassNameProperty`/`AutomationIdProperty` 定位）→ 取 `InvokePattern`（点按）/`ValuePattern`（填值）/`ExpandCollapsePattern` 等执行。元素级操作不依赖屏幕坐标，不会误点到邻居窗口——这正是 windows-mcp 坐标盲操作反复出事的地方。

**能力等价性结论**：windows-mcp 无任何不可替代能力。截图、GUI 操控、进程、注册表、文件读写六项各有等质或更优替代（后四项走内置 PowerShell 与 Read/Grep/Glob）。因此它是**可移除项**而非必需依赖。

## GUI 工具能力对比（自 dao.md 下沉，2026-07-07）

| 能力 | chrome-devtools | playwright | windows-mcp |
|---|---|---|---|
| DOM 查询 | ✅ | ✅ (snapshot) | ❌ |
| JS 执行 | ✅ | ✅ (evaluate) | ❌ |
| 元素级截图 | ✅ | ✅ | ❌（全窗口） |
| 表单交互 | ✅ | ✅ | ⚠（坐标点击） |
| 需要调试端口 | ✅ CDP | ❌ 自管 | ❌ |
| 连 WebView2 | ✅（设环境变量，见 `desktop-webview.md` §一） | ❌ | ❌ |
| 窗口切换/焦点 | 无 | 无 | ⚠ 有 |

选型走 `ccswitch/rules/dao-gui-verify.md` 的三器决策树；本表只做能力细节备查。

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
**更彻底的解**：让 watch 编译的那棵树是**专用 worktree**，主仓树怎么改都不进它的 watch 面
（dao.md 帅节「热重载型验证从专用 worktree 起」）。

## 会话纪律

- 进程管理在**会话最开头做一次**，不在中途反复杀重启
- 同一会话只用一个浏览器 MCP 工具，不中途换
- MCP 连接失败 2 次 → 检查端口/进程，不盲目重试
- **chrome-devtools 连到错的应用 ≠ CDP 不可用**：先按 `desktop-webview.md` §一「端口争用」
  三判据换端口另起并验端口归属，**不要**因此降级到 windows-mcp（L14；windows-mcp 已一票否决
  弃用，任何场景都不是选项，见 `dao.md` §目·观）
- 截图路径遵循 dao.md 截图路径强制规则
