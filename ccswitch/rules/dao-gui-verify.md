# GUI 验证工具选型 · 细则正文（dao.md「动 · 三才之机」目·观存根的展开面）

> **必经动作**：**每次截图 / GUI 交互之前 = Read 本文件全文**。触发时刻很具体——
> 你正要对一个跑着的界面做一次观察（截图 / 点一下 / 读 DOM / 走一遍流程）。
> 与 `dao-powershell.md` / `dao-guard-writing.md` / `dao-dispatch.md` / `dao-longwindow.md`
> 同型存根化：always-on 每轮注入的配额只该付给「每轮都要用」的东西，而下面这两组
> **只在「我正要看一眼界面」那一刻**用得上；现场 Read 拿到的永远是最新版。

> **刻意不迁进本文件、留在 dao.md 正文的**：
> **目·观 本身那半句**（「先截图看实际状态再行动，不只看代码猜」——它是天·觉/地·行/人·验
> 同级的动作原则，每轮都要用）· **🚫 windows-mcp 禁令**（已出文本层，由
> `ccswitch/hooks/dao-hard-gates.js` G1 在 PreToolUse `exit 2` 阻断，dao.md 只留一行指针）·
> **`stacks/` 的根路径约定**（被「知识归位」节的根路径消歧条引用，是全文性约定不是本节专属）·
> **桌面端基建自检**（已并入 `ccswitch/scaffold-manifest.json`，SessionStart 自动核对）。

---

## 一、三器决策树（每次截图/交互前走一遍，不凭习惯选工具）

> 绝利一源，用师十倍。三器不争，各归其位。

桌面端 GUI 验证有**两个** MCP 工具可用（windows-mcp 已弃用，见 dao.md 动节那一行禁令指针
与 `dao-hard-gates.js` G1 头注）：

```
应用有 WebView 层吗？（Tauri / Electron / CEF / WebView2）
├─ 是 → 远程调试端口开了吗？
│   ├─ 是 → chrome-devtools MCP（直连 WebView，DOM 级精度）   ← 首选
│   └─ 否 → 开端口（各框架怎么开、为什么禁止写死 9222、起完怎么验端口归属：
│           见 `stacks/desktop-webview.md` §一），再用 chrome-devtools
├─ 否（纯 Web 应用 / Vite dev server）
│   └─ playwright MCP（自管浏览器，E2E 流程最佳）              ← Web 首选
└─ 否（原生 Win32 / WPF / 无 Web 层）
    └─ 无 MCP 工具 → PowerShell + .NET 截图脚本（System.Drawing
       CopyFromScreen 落 _tmp/qa/）；脚本也不可行时诚实挂账「需用户目视」，
       不得为此复活 windows-mcp
```

**工具能力对比**：细节矩阵已下沉 `stacks/desktop-tauri.md`（含分层测试策略），
选型只走上面这棵树。**直连原理与端口归属判据 2026-08-02 提级到 `stacks/desktop-webview.md`**
（那两节与框架无关——调试端口是 WebView2 运行时读的环境变量，不是 Tauri 读的）。
`stacks/` 的根路径约定见 dao.md 动节「工具能力对比」那一段
（`D:/frank/windsurf-dao/ccswitch/stacks/`，跨项目会话中不与目标项目自身的 `stacks/` 混淆）。

## 二、防断路规则

- 同一会话内**只用一个浏览器工具**，不中途换（换工具 = 端口/锁冲突 = 排障循环 = 烧 context）
- 进程管理（启动 dev server / 开调试端口）在会话最开头做一次，不在中途反复杀重启
- MCP 连接失败 2 次 → 停下检查端口/进程状态，不盲目重试（反者道之动）

---

## 射程边界（照直写，别读成全包）

**触发器是 `ccswitch/hooks/dao-tool-nudge.js` 的浏览器 MCP 首调提醒**（PostToolUse，
提醒型不阻断，同该 hook 既有的三类软提醒）：本会话内**第一次**调用
`mcp__chrome-devtools__*` / `mcp__playwright__*` 时，把「去读本文件」这句话送到眼前。

~~🔴 **它此刻大概率还没真的送达，照直写**：该 hook 在 `~/.claude/settings.json` 里注册的
PostToolUse **matcher 是 `Bash`**，而浏览器 MCP 的工具名（`mcp__chrome-devtools__…`）
不在这个 matcher 的覆盖面内 ⇒ **代码就位、投递为零**。**要它真的响，需要用户把那个 matcher
扩到覆盖两个 MCP 前缀**（写入面是 cc-switch DB 的 `providers.settings_config`）。
**未扩之前，本文件与 dao.md 那行存根是纯文字兜底**。~~
**2026-08-10 订正（用户当日拍板第 14 件 · issue #269 ㈠）：那段已被证伪，matcher 早就扩过了，
它真的会送达。** 「没跑的闸」与「跑了且没意见的闸」在日志里长得一样这句仍然成立——**正因为
如此，上面那个错结论才在盘上躺到有人真去撞了一次才被发现**。

**它实际在什么时刻送达**：本会话内**第一次**调到 `mcp__chrome-devtools__*` /
`mcp__playwright__*` 里任意一个工具，那一跳的 PostToolUse 把「去读本文件」打进上下文——
**首调之后、当场**。三件容易读错的，照直写：

- **触发它的不必是截图**。两次实测都是 `browser_navigate` 这类**导航**工具触发的；
  matcher 认的是工具名前缀，不是「你在截图」。
- **同一 session 只响一次**，后续调用一律静默（去重机制见该 hook 头注第 ④ 段）。
- **它是事后提醒，不是拦截**：PostToolUse 在那次调用**跑完之后**才触发 ⇒ 它救不回
  「第一次就选错了工具」，只买得到这次走查剩下的部分和下一次的选型（与下面那半射程缺口同一件事）。

**两次实测的出处**（各自独立的两位 dogfood 官，不是同一次观察被引用了两遍）：
issue #238 的 comment 5233416743「顺带记：这一支路上的三个卡点」第 1 条，与
comment 5236999300 第 11 条（接力第三位官独立复现）。两位都写明这是**自我证伪**——
他们照着本文件那句「投递为零」去做，结果提醒当场出现在眼前。

**别拿本段当此刻的实况读**，它同样会过期（上面那段划掉的话就是这么烂在盘上的）。当前状态随时可查：

```
node ccswitch/hooks/dao-tool-nudge.js --selfcheck
```

**投递到了也不等于这两组规则「有人管了」**：nudge 是软提醒、不阻断，读不读、读完照不照做
都没有任何东西在核（本仓实测无标记时刻的自由裁量携带率 9-24%）。真有闸的只有截图落盘路径
那一格——`dao-hard-gates.js` 的 `G4-screenshot-path` 在 PreToolUse `exit 2` 拦，
两支的参数名不同（chrome-devtools 是 `filePath`，playwright 是 `filename`），
**playwright 省掉 `filename` 不是「内联返回」而是落进仓根 `.playwright-mcp/`，同样会被拦**
（2026-08-10 随本次订正一并改的，出处同上 issue #269 ㈡）。

**另一半射程缺口，与 `dao-powershell.md` 同型**：nudge 挂在「你已经调了浏览器 MCP」
这个动作上，所以它覆盖**第二次及以后**的选型，**覆盖不了第一次那个选择本身**——
你可能一上来就选错了工具，而它只会在你选完之后才出声。这一半只有 dao.md 那行存根兜底。
