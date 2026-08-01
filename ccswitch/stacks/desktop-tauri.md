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

**这不是"CDP 不可用"——是端口争用。** 误判为 CDP 不可用而放弃直连、降级到位图截图类手段是错的（本条即由此教训而生；当年的降级目标 windows-mcp 现已弃用）。

**dogfood 前置检查 · 三判据（每次起 WebView2 调试前必过）**：

1. **不杀任何进程** —— 占用调试端口的**正常形态**就是用户自己正在用的装机实例，而
   `Stop-Process -Force` 对占用者不作区分。**端口被占的正解是换端口另起，不是清场。**
2. **独立 `WEBVIEW2_USER_DATA_FOLDER`** —— WebView2 的调试端口**按用户数据目录绑定，
   不按进程绑定**：与别的实例共用同一 user-data-dir 时，**光换端口号绑定仍会静默失败**。
   ⇒ 唯一端口是必要条件、**不是充分条件**，独立 user-data-dir 与它必须同时给。
3. **起完验端口归属，`/json` 的 title 不算证明** —— 决定性判据是**该端口 Listen 者的
   祖先链里含不含你刚起的那个 app PID**。`curl /json` 只看得出"上面挂着某个页面"，
   同形态的两个实例它分不开；祖先链回答的才是"这个端口是不是我的"。
   完整三关自验见下方「隔离启动器」节。

> 🔴 **本节 2026-08-01 重写，两个旧处方是错的，记在这里免得有人从旧快照里搬回来**：
> ①旧第 1 步逐字写着「有占用者则 `Stop-Process -Force`」——**那等于教人杀掉用户的生产实例**，
> 而 9222 的典型占用者恰恰就是它；②旧「根治：给每个 Tauri 项目分配唯一调试端口」
> ——**已被实证证伪**：共用 user-data-dir 时换到 9223 照样静默绑定失败
> （2026-07-26 mousse-cli 实证，判据即上面第 2 条）。**唯一端口治不了 user-data-dir 的病。**

### 隔离启动器 · canonical 契约（2026-08-01 立）

上面三条判据是**文字**，文字要求人在无标记时刻自己想起来——本体系实测那类规则携带率 9-24%。
把它们做成一个**项目自带的隔离启动脚本**，判据就变成起实例这个必经动作上的关卡（fail-closed）。

**本节是判据与约定的 canonical，不是脚本本体。** 各项目自实现（脚本语言、路径布局、
项目自己的隔离面各不相同），但下面四条硬要求、preflight、三关自验、退出码契约要对得上；
一份 1000 行量级的完整参考实现活在 mousse-cli `scripts/start-isolated-dev.ps1`
（Windows + WebView2 + Tauri），要抄形态去读它，**别把它整份搬进本文件**。

**四条硬要求**（逐条对应一个已知失败模式，不是设计偏好）：

1. **全程只起不杀** —— 脚本内只有"启动"动作；`-Stop`（收尾）**只杀自己状态文件里登记的那棵进程树**，
   **从不按进程名批杀**（用户的装机实例往往与 dev 产物同名）。
2. **独立用户数据目录** —— 起实例时显式给独立 `WEBVIEW2_USER_DATA_FOLDER`
   （Electron 对应 `--user-data-dir`），并**断言它不等于、也不位于生产标识目录之下**；
   违反即拒绝启动，不静默回落。目录名建议按 **worktree 全路径取哈希**，多 worktree 天然不相撞。
3. **备用端口 + 起前查占用** —— 默认端口刻意**避开 9222**（那是装机实例的典型落点）；
   起前查该端口有无 Listen 者，**查到占用即拒绝启动，"查不了"也拒绝**（fail-closed，
   不把"没查出来"当成"没被占"）。
4. **起完自验绑定** —— **绑定失败是静默的**，所以"起起来了"不等于"端口是我的"：
   三关全过才算成功，任一不过即**杀掉自己起的那个实例**并非零退出。

**preflight（`-PreflightOnly` 型开关）**：只跑起飞前检查后退出、不真启动。
它的价值有两层：①秒级自查环境（端口空不空、目录冲不冲突），不必等一次完整编译；
②**它是这些关卡自身的负控入口**——把目标端口占住再跑一次 preflight，
应当看到"拒绝启动"那一态。**两态都看到才叫负控成立**，只看到失败态不算
（可能本来就有别的东西占着）。

**三关自验（起完立即跑，顺序即强度递增）**：

| 关 | 判什么 | 为什么不够/够 |
|---|---|---|
| 关一 | `/json/version` 返回 200 且 JSON 可解析 | 只证明"这个端口上有个 CDP 在应答"，**不证明是谁的** |
| 关二 | 该端口 Listen 者的**祖先链含自己刚起的 app PID** | **决定性的一关**——它回答"这个端口是不是我的" |
| 关三 | Listen 者命令行同时含本次 `--user-data-dir` 与 `--remote-debugging-port` | 兜住"祖先链对但走了别的数据目录"的半隔离态 |

**退出码契约**（真退出码，不看输出文案有没有 "error" 字样）：

| 码 | 含义 |
|---|---|
| 0 | 成功启动且三关自验通过（`-Stop` 正常收尾、`-PreflightOnly` 全过同样是 0） |
| 1 | 启动器进程提前退出 / 其他启动失败 |
| 2 | 调试端口已被占用，**或无法证明它空闲**（fail-closed） |
| 3 | **绑定自验未过——不要连这个端口**（自己起的实例已被杀掉） |
| 4 | 等待"进程出现 + 端口应答"超时 |
| 5 | 用户数据目录与生产标识目录冲突（会导致静默绑定失败），拒绝启动 |
| 6 | 前端 dev server 端口被占（`strictPort` 下 fail-closed，不带着必然白屏往下走） |
| 7 | `-Stop` 有进程杀不掉且仍存活（状态文件保留，可重跑） |
| 8 | 本 worktree 已有一个由本脚本起的实例在跑（先跑 `-Stop`） |
| 9 | 目录守卫未过（不在预期的仓库根下） |
| ≥10 | **留给项目自定义的隔离面**（见下） |

**项目自定义隔离环境变量（≥10 段的用途）**：调试端口与用户数据目录只隔离了 **WebView 这一层**；
应用自己的数据库、OS keyring 命名空间、读写用户 home 的那些路径，**一概不受它管**——
不额外处理的话，"隔离实例"照样会写用户的真数据。故启动器应把这类落点经**环境变量**注入应用，
每新增一面就占一个 ≥10 的退出码作它的冲突断言。三条配套约定：

- **应用侧对这类变量必须 fail-closed** —— 取值非法（相对路径 / 指回默认落点 / 指回用户真 home）
  一律**拒绝启动**，绝不静默回落。回落 = 静默取消隔离，而调用方以为隔离了，正是这一族缺陷的形态。
- **能合的合进一个变量，合不了的显式记为破例并打半隔离警告** —— 落点推导得出来的面
  （产出目录之类）只要一个布尔，应挂在同一个变量下；只有"需要操作者往里放 fixture、
  值推导不出来"的面才值得另开一个变量，代价是它可能被漏设 ⇒ 启动期须对"只设了一部分"打警告。
- **枚举共用面时按写入动作枚举，不按目录枚举** —— 按"哪些目录不带应用标识"去找，
  结构上看不见 OS keyring（不走路径）与 home 拼接出来的路径；再补一问：
  **哪些面此刻根本没办法验？**（只读面往往就藏在这一问里）

**射程边界，照直写**：①脚本只管它自己起的那个实例——绕开它手起 `dev:debug`，以上关卡**一个都不生效**；
②三关自验证明的是"**它给你的那个端口**上是它自己的实例"，**管不到"你的调试工具实际连了哪个端口"**
（MCP 端口写死在用户配置里时尤其危险）⇒ **连上之后核对 PID / 版本号与自起实例是否一致这一步永远不能省**，
而这一步没有任何机检兜底。

### 为什么不用 Chrome 做代理

```
❌ 旧路径（4 进程，每个都是断点）：
  Vite → Tauri → Chrome(--remote-debugging-port) → chrome-devtools MCP
  问题：Chrome 连接失败 / 端口冲突 / browser lock / SQLite 不可用

✅ 新路径（2 进程，直连）：
  Vite → Tauri(WebView2 --remote-debugging-port) → chrome-devtools MCP
  优势：真实环境（SQLite/IPC 全可用）、少两个进程、无连接中间人
```

### windows-mcp 已弃用（用户拍板 2026-07-25，一票否决）

**任何场景不得使用 windows-mcp 任何工具**——该 MCP 已从用户机器卸载，禁令见 `dao.md` §目·观。
弃用理由：Screenshot 切换窗口焦点污染被测状态、全屏截图含任务栏、无 DOM 访问、位图证据不如
DOM 文本可复核且更烧 token。替代分工：DOM 与截图 → chrome-devtools / playwright；进程与注册表
→ 内置 PowerShell 工具；文件读写搜索 → 内置 Read / Grep / Glob；纯 Win32 无 Web 层 →
PowerShell + .NET 截图脚本，不行则诚实挂账「需用户目视」。

**下方能力对比表的 windows-mcp 列仅作历史存档**，不再是可选项。

#### 无 MCP 的原生桌面能力兜底（2026-07-25 实测通过，替代 windows-mcp 的两项能力）

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
- **chrome-devtools 连到错的应用 ≠ CDP 不可用**：先按上方「端口争用」三判据换端口另起并验端口归属，**不要**因此降级到 windows-mcp（L14；windows-mcp 已一票否决弃用，任何场景都不是选项，见 `dao.md` §目·观）
- 截图路径遵循 dao.md 截图路径强制规则
