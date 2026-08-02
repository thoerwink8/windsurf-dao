// dao-hard-gates.js — 门控出文本层（PreToolUse · exit 2 阻断）
//
// ── 为什么存在这个文件 ───────────────────────────────────────────────────────
// arxiv 2607.26819（RepoComplianceBench，49 仓 / 106 issue / 4 前沿模型）实测：
//   · Refuse（禁止 X）类规则       无干预 0%，引原文仍 0%（最好 10%）
//   · Handoff（关键步骤交人）类     无干预 0%，引原文 0%，一轮反馈 0%
//   · agent 仅 3.5% 的运行打开过策略文件；97.6% 的违规发生在策略文件从未被打开时
// 原文结论："Bans and human gates need enforcement **outside** the agent."
// Anthropic 官方同句："A real guardrail needs to be deterministic, and the
// enforcement methods are hooks and permissions."
// ⇒ dao.md 里的「🚫 禁令 / 一票否决 / 永不 / 必须先问用户」写成文字 = 等于不存在。
//    本文件把其中**机器判得了、且没有合法例外**的那几条搬到 agent 之外。
//
// ── 这里只放「甲类」：可机械判定 + 无合法例外 ────────────────────────────────
// 有合法例外的（如 push 主干——文档微改允许直推）走 ccswitch/hooks/dao-tool-nudge.js
// 的软提醒分支；机器根本判不了的（审美拍板 / 打磨到位 / 不许留空未尽处）**留在文本里**，
// 判定表与逐条理由见本批 PR body 与 docs/specs/dao-arch-optimization-202608.md P1 行。
//
// ── 六道闸（逐条的判据出处写在各自的 GATES 条目里）──────────────────────────
//   G1 windows-mcp 全面禁令          dao.md「目·观」§windows-mcp 禁令（一票否决）
//   G2 live ~/.claude/settings.json  dao.md Shell 节「确认门禁」+「改配置先认源与投影」
//   G3 对外发布类命令                dao.md 帅节留守判据 ㈣自主边界「对外发布 / 需用户在场」
//                                    （正文 2026-08-02 迁 ccswitch/rules/dao-longwindow.md §心跳对账节 · 丁）
//   G4 浏览器 MCP 截图落盘路径        dao.md Shell 节「截图路径强制」
//   G5 只读载体未勾待办               dao.md「言·名之则」§只读载体禁写待办
//   G6 心跳 prompt 缺 `[dao-heartbeat]` 签名  docs/specs/dao-rewrite-202608.md 分流表第 3 类
//                                    「心跳投递机器化」（2026-08-02 新增 · **呈批项**，见下）
//
// ── 各闸的判据全文（2026-08-02 dao.md 瘦身批 #7 迁入；dao.md 那三段已压成一行指针）──
// 迁入前逐段核对过：dao.md 当时写着「全文见该 hook 头注，本行不复述」，而**头注里其实没有**
// —— 一个指向空气的指针比没有指针更糟（读者以为有兜底）。下面补的就是那几句。
// 拦截判定逻辑（各 gate 的 test()）与 stderr 文案（why / how）**#7 那一批**一字未动，只加注释。
// ⚠️ 后续动过的照直记：**瘦身批 #1（2026-08-02）改了 G3 的 why 与 how 里的三处指针文字**——
// 「dao.md 帅节 ⑤自主边界」在 #1 之后已不是 dao.md 里的编号（⑤ 随正文迁去
// ccswitch/rules/dao-longwindow.md §心跳对账节 · 丁，dao.md 只剩留守判据 ㈣）。
// **test() 的 matcher 与判定分支仍未动过一个字符**，改的只有指向哪里的那几句话。
// ⚠️ **第二次改文案（2026-08-02，issue #63）：G2 的 why 与 how ② 教的是一条已被证伪的路径**——
// 原文写「正路是改 git 快照层 `config-sync/common/settings.json`，再由用户跑 `dao.bat
// --direction=down`」，而 #49 的下发链实测证明快照层与 `common_config_claude` 镜像层**都不在
// 下发路径上**，照它做改动**永不生效**（PR #43 即如此：写满两层而 live 始终未注册）。
// **一道闸给出走不通的合法路径，比不给更糟**：被拦的人会照做，然后以为自己已经做完了。
// 现改为指向真实下发源 `providers.settings_config`（每个 provider 都要改）。
// **G2 的 tools/matcher 与 test() 判定分支同样一个字符未动**，改的只有被拦时打给人看的那段话。


//
// G1 · windows-mcp 禁令 —— **弃用理由**：用户 2026-07-25 一票否决，该 MCP 已从机器卸载
//   （完整因果链见 docs/evolution/dao-clause-rationales.md §动-2）。**替代分工**见下方 G1 的
//   `how`（DOM 与截图 → chrome-devtools / playwright；进程与注册表 → 内置 PowerShell 工具；
//   文件读写搜索 → 内置 Read / Grep / Glob；纯 Win32 且脚本也不可行 → 诚实挂账「需用户目视」）。
//   ⚠ **仍归文本、本闸拦不到的那半**：dao.md、各 skill、各 stacks 里**提到 windows-mcp 的历史
//   段落**，一律读作「已弃用，不得选用」—— 那是一种**读法**不是一个动作，没有任何工具调用
//   与之对应，所以它只能靠文字。别把「G1 已上闸」读成「这条已经全被兜住了」。
//
// G2 · live settings.json —— **为什么不是「小心点就行」**：改 live 那一份的已知风险是
//   **可能触发 `401 device was revoked` 强制登出**（会话当场断，且不是把文件改回去就能恢复的）。
//   三条合法路径的全文在下方 G2 的 `how`。⚠ **config-sync 同理**：它写的也是配置面，
//   动它之前同样先问用户授权 —— **问了就做**，不必来回请示，卡住不动不是谨慎是停摆。
//
// G4 · 浏览器 MCP 截图路径 —— ⚠ **射程只到浏览器 MCP 这一种工具调用**：
//   PowerShell / .NET 的截图脚本（System.Drawing CopyFromScreen 那条路）走的**不是工具调用**，
//   本闸看不见它，那一半仍然只是判据。同样别把「G4 已上闸」读成「截图路径已经有人管了」。
//
// G6 · 心跳签名（2026-08-02 新增，dao 重写批 1-C）——**它拦的不是一个坏动作，是一个坏格式**，
//   这在本文件里是头一遭，所以理由要写清楚：
//   ㈠ **它是另一件事的前置条件，本身不是禁令**。dao-rhythm.js（UserPromptSubmit）新增的
//      WAKEUP 信号靠 `[dao-heartbeat]` 这个前缀认出「这一轮是心跳唤醒」，据此注入长窗留守四句
//      + 「Read dao-longwindow.md §心跳对账节」。**没有签名 ⇒ 那一轮什么都不注入**，而心跳轮
//      恰恰是留守四句唯一的投递时刻（dao.md 帅节长窗存根：「投递通道 = 开窗仪式 Read（第一轮）
//      + 心跳 prompt 载荷（后续每一轮）」）。⇒ 漏一次签名 = 那一轮的留守判据静默缺席，
//      而「缺席」与「注入了但没照做」在任何日志里长得一样。
//   ㈡ **为什么不能靠「记得写签名」这句话**：写签名这个动作发生在**每一轮心跳**，是典型的
//      「无标记时刻的自由裁量」——本仓实测这类携带率 9-24%。跟着模板走的才是 100%。
//   ㈢ **stop:true 豁免**：收窗那一次调用没有 prompt、也不会产生下一轮，签它没有意义。
//      真实语料里 `{"stop":true}` 是**唯一**的无 prompt 形态（993 次调用里 31 次，prompt 缺失 0 次）。
//   ㈣ **误伤面：实测为零，但不等于不存在**。全量语料普查（`~/.claude/projects/**/*.jsonl`，
//      2026-08-02，993 次 ScheduleWakeup tool_use）：非 stop 的 962 次**全部**是 dao 自主窗心跳，
//      零次来自 `/loop` 或其他非 dao 用途。**「零观察」不是「零存在」**——若将来内置 `/loop`
//      或别的功能自己构造 ScheduleWakeup 的 prompt（调用方拿不到那段文字），本闸会拦下它。
//      故 G6 **给逃生阀**（G4 不给，因为 G4 拦错顶多少一张截图；G6 拦的是驱动自主循环的那个
//      工具，两侧代价不对称）。逃生阀仍然只有用户设得了 —— 见下方设计取舍①。
//   ㈤ **本闸未经用户拍板**（spec 里标着「呈批项」）。**它现在是惰性的**：live settings 的
//      PreToolUse matcher 不含 `ScheduleWakeup` ⇒ 宿主根本不会为这个工具调本 hook。
//      **注册那一下就是用户的批准动作**；在那之前 `--selfcheck` 会把它报成
//      「✗ G6：matcher 覆盖不到 ScheduleWakeup ⇒ 这道闸静默零覆盖」并 exit 1 —— 刻意如此，
//      「没接上」要在机器通道上说出来，而不是安静地等着。
//
// ── 三条设计取舍，别读成疏漏 ────────────────────────────────────────────────
// ① **逃生阀一律是环境变量，不是 agent 能创建的哨兵文件**。理由就是上面那份实证：
//    凡 agent 自己够得着的旁路，禁令即退化回 0%。env 只有用户能在启动会话前设，
//    agent 在 Bash 里 export 影响不到 hook 进程（hook 的 env 继承自 Claude Code 本体）。
//    G1/G4 连 env 都不给——G1 是用户一票否决且工具已卸载，G4 的正路只是换个路径。
// ② **本 hook 自己崩掉时是放行的（fail-open），不是拦截**。一道会因自身 bug 把
//    Edit/Write 全部拦死的闸没有任何逃生通道 = 会话直接砖掉。代价是「放行」与
//    「通过」在退出码上长得一样 —— 故 catch 里必打一行显眼 stderr，且 `--selfcheck`
//    专门用来把「它到底有没有接上」摆出来（见下）。这是明知的两害相权，不是没想到。
// ③ **判据是近似的，两侧都有反例**。命中判据基本是段首正则 + 路径归一，已知：
//    漏报——`for x in ...; do npm publish; done` 段首不是 npm；`$(...)` 里的命令。
//    误报——`echo "npm publish"` 这类字面量（已上负控断言，见回归网）。
//    刻意不去真解析 shell 语法：那会把一道守卫变成一个解析器，而解析器错了会
//    「违例数与样本数一起归零」（dao-guard-writing.md ②）。
//
// ── 自检 ────────────────────────────────────────────────────────────────────
//   node ccswitch/hooks/dao-hard-gates.js --selfcheck
// 打印：①它在 live settings.json 的 PreToolUse 里注册了没有 ②注册用的 matcher 是什么
// ③**逐闸核对该 matcher 覆不覆盖这道闸要拦的工具名**（matcher 写窄一格 = 那道闸静默
// 零覆盖，而零覆盖与零违例在任何日志里都长得一模一样）。未注册或有闸失覆盖 → exit 1。
//
// 回归网：tests/hard-gates.tests.js（每闸正控+负控双向 + mutation 判别力 + canary 恒等）。
// 真相源：windsurf-dao/ccswitch/hooks/dao-hard-gates.js
// 注册：live `~/.claude/settings.json` 的 PreToolUse（matcher 见 REQUIRED_MATCHER_COVERAGE）。
//       ⚠ **2026-08-02 新增 G6 后，现役 matcher 还差一格**：它当前是
//       `Bash|PowerShell|Edit|Write|MultiEdit|NotebookEdit|mcp__windows.*|mcp__chrome-devtools__take_screenshot|mcp__playwright__browser_take_screenshot`，
//       **不含 `ScheduleWakeup`** ⇒ G6 此刻零覆盖（`--selfcheck` 会明说并 exit 1）。
//       补法：在该正则末尾追加 `|ScheduleWakeup`（一处追加，不新增 hook 组）。**属用户动作**，
//       且那一下**同时就是对 G6 的批准**（spec 里 G6 标着「呈批项」）。
//       **注册的写入面是 cc-switch DB `providers` 表各 provider 的 `settings_config`，且每个
//       provider 都要写**（切 provider 时 live 被目标 provider 的配置整体覆盖 ⇒ 只写一个等于没写；
//       判据见 dao.md「改配置先认源与投影」，长期对齐机制挂 issue #50）。**属用户动作**——
//       AI 侧写 DB 被权限分类器全路径拦截，这是「AI 不得改自己 hook 注册」的意图级保护。
//       ⚠ `config-sync/common/settings.json`（快照层）与 DB 的 `common_config_claude` 键（镜像层）
//       **都不在下发路径上**：2026-08-02 已注册完毕（#49），此前 PR #43 把注册写满这两层而 live
//       始终未注册，正是这个原因。别再据此建议跑 `dao.bat --direction=down` 来「让它生效」。

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const HOME = process.env.USERPROFILE || process.env.HOME || os.homedir();
const LIVE_SETTINGS = path.join(HOME, ".claude", "settings.json");

// 归一化：反斜杠转正斜杠 + 去掉末尾斜杠。**不做大小写折叠**——只在比较时按需 toLowerCase，
// 因为要原样回显给被拦的人看（回显一个被改过大小写的路径会让人以为拦错了对象）。
function norm(p) {
  return String(p || "").replace(/\\/g, "/").replace(/\/+$/, "");
}

// 把命令拆成"命令段"，让段首判据成立。切分符与 dao-tool-nudge.js 相同（; 换行 && || |），
// **但这里是引号感知的，nudge 那边是裸 split** —— 这处分歧是被一次实测逼出来的，不是随手写的：
// nudge 的裸 `split(/;|\n|&&|\|\|?/)` 碰上多行正文会把正文本身切开，于是
//   git commit -m "[cc] feat: x
//   - [ ] 随后补测试"
// 被切成两段，第二段段首不是 `git commit` ⇒ G5 **对最常见的那种形态直接漏报**
// （回归网首跑当场红，见 tests/hard-gates.tests.js G5 正控）。
// nudge 那边不改：它只认段首命令、不看正文内容，裸 split 对它够用，
// 而两个 hook 的判据本就该各自演进（同 hook-selfcheck 库「只抽形态不抽判据」）。
//
// 这不是一个 shell 解析器，也刻意不做成解析器：只跟踪单/双引号与反斜杠转义，
// 认不出 `$(...)`、heredoc、嵌套引号里的引号。已知漏报面写在头注③。
function shellSegments(cmd) {
  const src = String(cmd || "");
  const out = [];
  let cur = "";
  let quote = null; // null | '"' | "'"
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      // 单引号里反斜杠不转义（POSIX 语义）
      if (c === "\\" && quote === '"' && i + 1 < src.length) { cur += c + src[++i]; continue; }
      if (c === quote) quote = null;
      cur += c;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; cur += c; continue; }
    if (c === "\\" && i + 1 < src.length) { cur += c + src[++i]; continue; }
    if (c === "\n" || c === ";") { out.push(cur); cur = ""; continue; }
    if ((c === "&" && src[i + 1] === "&") || (c === "|" && src[i + 1] === "|")) {
      out.push(cur); cur = ""; i++; continue;
    }
    if (c === "|") { out.push(cur); cur = ""; continue; }
    cur += c;
  }
  out.push(cur);
  return out
    .map((s) => s.trim())
    // 去掉前导 `cd <path> ` 与 `VAR=x ` 形式的环境变量前缀，让段首露出来
    .map((s) => s.replace(/^cd\s+\S+\s+/, "").replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, ""))
    .filter(Boolean);
}

// 未勾选的待办框：行首（或紧跟引号 / 字面 `\n` 转义）的 `- [ ]` / `* [ ]` / `+ [ ]`。
// 已勾的 `- [x]` 是陈述过去，允许。
//
// **为什么要加这个前缀约束，而不是裸匹配** —— 这是把 dao-guard-writing.md ③「检查器的
// 输出不能落在它自己的扫描面内」拿来照自己一遍时发现的：本闸的**判据本身**要被写进 PR body、
// 写进 dao.md、写进 commit message 去解释它拦什么，而那些正文里必然出现反引号包着的
// 那个记号。裸匹配 ⇒ **每一份讨论本条规则的 PR body 都会被本条规则拦下**，而拦下的理由
// 恰恰是「它提到了自己」。这不是理论风险：本批 PR body 首稿当场命中。
//
// 于是判据收窄成「它出现在**待办项该出现的位置**」：真的 checklist 项永远在行首
// （markdown 列表语法要求），而散文里的引用永远跟在反引号/汉字/括号后面。
// 允许的前缀里加引号与字面 `\n`，是因为单行 `--body "- [ ] x"` 这种形态里正文的
// 第一行紧跟在引号后，没有真换行 —— 漏掉它就漏掉了最常见的那种写法。
// **两侧仍有反例**：`echo '- [ ] x'` 之类会误报（但它不在 gh pr / git commit 段里，够不着）；
// 正文里用 HTML 实体或全角写的复选框会漏报。近似，不是判定。
const UNCHECKED_TODO = /(^|\n|\\n|["'])[ \t]*[-*+][ \t]+\[[ \t]\]/;

// 心跳签名：ScheduleWakeup 的 prompt 必须以 `[dao-heartbeat]` 开头（trim 之后，大小写敏感）。
//
// **判据刻意写得死板，因为它两边各有一份**：这里一份，dao-rhythm.js 的 WAKEUP 信号一份。
// 两份必须**逐字节同判**——闸放行的每一个 prompt，rhythm 都要认得出来，否则会出现
// 「过了闸却没注入」这种最难查的静默失败（闸绿、注入无，两者各自看都正常）。
// 故：①同一条正则字面量 ②两边都只对 `String(prompt).trim()` 求值，不做别的归一
// ③回归网 tests/hard-gates.tests.js 有一组**跨文件一致性**断言，把同一批 prompt 同时喂给
// 两个 hook，钉「G6 放行 ⇔ rhythm 注入 WAKEUP」这个双向等价。判据一改而只改一边，那组当场红。
//
// **一处本来会不对齐的地方，是怎么消掉的**：rhythm 有几道前置早退（`^/` 开头的纯 slash 命令、
// strip 后 <4 字符），本闸没有。原可以论证「`[dao-heartbeat]` 开头的 prompt 既不以 `/` 开头
// 也不短于 4 字符 ⇒ 恒不触发」——但那是**推出来的**，不是测出来的，且会随那几道早退被改而失效。
// 故 rhythm 侧把 WAKEUP 判定**排在所有早退之前**、且同样只对 `String(prompt).trim()` 求值，
// 直接不给不对齐留机会。别把那个位置当成随手放的：它是判据对齐的一部分。
const HEARTBEAT_SIG = /^\[dao-heartbeat\]/;

// ── 各道闸（数量以 GATES.length 为准，此处刻意不写死数字）──────────────────
// 每条 gate：
//   id / why（判据出处，进 stderr）/ escapeEnv（null=无逃生阀）
//   tools（本闸要拦的工具名样本，供 --selfcheck 核对 matcher 覆盖面）
//   test(input) → null 放行 / { what, how } 阻断（what=拦了什么，how=合法路径）

const GATES = [
  {
    id: "G1-windows-mcp",
    why: "dao.md「目·观 · GUI 工具决策树」§🚫 windows-mcp 禁令（用户 2026-07-25 拍板，一票否决；该 MCP 已从用户机器卸载）",
    escapeEnv: null, // 用户一票否决，不给旁路
    tools: ["mcp__windows-mcp__Screenshot", "mcp__windows-mcp__Click", "mcp__windows_mcp__PowerShell"],
    test(input) {
      if (!/^mcp__windows[-_]?mcp?[-_]*__/i.test(input.tool_name || "")) return null;
      return {
        what: `调用了 windows-mcp 工具 \`${input.tool_name}\``,
        how:
          "改走替代分工（dao.md 决策树）：DOM 与截图 → chrome-devtools MCP（WebView 应用）" +
          "或 playwright MCP（纯 Web）；进程与注册表 → 内置 PowerShell 工具；" +
          "文件读写搜索 → 内置 Read / Grep / Glob。" +
          "纯 Win32/无 Web 层且脚本也不可行时，诚实挂账「需用户目视」——**不得为此复活 windows-mcp**。",
      };
    },
  },

  {
    id: "G2-live-settings",
    why: "dao.md Shell 节「settings.json 运行时改动 · 确认门禁」+「改配置先认源与投影」（`~/.claude/settings.json` 是 cc-switch 下发的**投影**——真实下发源是 DB `providers` 表各 provider 的 `settings_config`，下发只挂在 GUI「切换 provider」这个动作上；改投影立即生效但不持久、下次切 provider 即被整体覆盖且无告警）",
    escapeEnv: "DAO_SETTINGS_EDIT_APPROVED",
    tools: ["Edit", "Write", "MultiEdit", "NotebookEdit"],
    test(input) {
      if (!/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(input.tool_name || "")) return null;
      const fp = norm((input.tool_input || {}).file_path || (input.tool_input || {}).notebook_path);
      if (!fp) return null;
      const home = norm(HOME).toLowerCase();
      const low = fp.toLowerCase();
      const hit = ["settings.json", "settings.local.json"].some(
        (n) => low === `${home}/.claude/${n}`
      );
      if (!hit) return null;
      return {
        what: `要写用户级 live 配置 \`${fp}\``,
        how:
          "三条正路，按你到底想要什么三选一：" +
          "①**未获用户明确授权** → 不要动它。把改动写成 `_tmp/settings-patch.json`，" +
          "并把会话外的执行命令交给用户（dao.md Shell 节原文即此路）。" +
          "②**只是要让改动持久** → 改的对象错了：这个文件是 cc-switch 下发的投影，" +
          "真实下发源是 **cc-switch DB `providers` 表各 provider 自带的 `settings_config`**。" +
          "正路：请用户在 cc-switch GUI 里编辑 provider 配置（或由用户执行 SQL）写进那一列，" +
          "**且每个 provider 都要改**——切 provider 时 live 会被目标 provider 的配置整体覆盖，" +
          "只改一个等于没改（per-provider 漂移，长期对齐机制挂 issue #50）。" +
          "写 DB 属**用户动作**：AI 侧被权限分类器全路径拦截，这是「AI 不得改自己 hook 注册」的意图级保护。" +
          "⚠ **改 `config-sync/common/settings.json`（git 快照层）或 DB 的 `common_config_*` 键（镜像层）都不会生效**——" +
          "两者都不在下发路径上（#49 实测；PR #43 曾把 hooks 注册写满这两层而 live 始终未注册），" +
          "所以也**不要建议跑 `dao.bat --direction=down/up` 来让它生效**。判据见 dao.md「改配置先认源与投影」。" +
          "③用户已当面授权、且确实要改 live 那一份 → 由**用户**设 `DAO_SETTINGS_EDIT_APPROVED=1` 后重开会话（agent 自己 export 影响不到本 hook）。",
      };
    },
  },

  {
    id: "G3-publish",
    why: "dao.md 帅节留守判据 ㈣「自主边界（永不进自主窗）」（正文见 ccswitch/rules/dao-longwindow.md §心跳对账节 · 丁）——对外发布属不可逆决策 + 需用户在场件",
    escapeEnv: "DAO_PUBLISH_APPROVED",
    tools: ["Bash", "PowerShell"],
    test(input) {
      if (!/^(Bash|PowerShell)$/.test(input.tool_name || "")) return null;
      const cmd = (input.tool_input || {}).command || "";
      for (const seg of shellSegments(cmd)) {
        // --dry-run / -WhatIf 是真演练，放行（负控在回归网里钉着）
        if (/--dry-run\b|-WhatIf\b/i.test(seg)) continue;
        const m =
          /^gh\s+release\s+(create|delete|upload)\b/.test(seg) ? seg :
          /^(npm|pnpm|yarn|bun)\s+publish\b/.test(seg) ? seg :
          /^cargo\s+publish\b/.test(seg) ? seg :
          null;
        if (m) {
          return {
            what: `要跑对外发布命令 \`${m.slice(0, 80)}\``,
            how:
              "对外发布是不可逆的、且是「需用户在场」件：" +
              "①先向用户说明要发什么版本、发到哪、怎么回滚，拿到当场同意；" +
              "②要先演练就加 `--dry-run`（本闸对 `--dry-run` 放行）；" +
              "③用户同意后由**用户**设 `DAO_PUBLISH_APPROVED=1` 再跑，或直接由用户执行该命令。" +
              "自主窗内一律不发布——`自主边界` 的原文是「永不进自主窗」。",
          };
        }
      }
      return null;
    },
  },

  {
    id: "G4-screenshot-path",
    why: "dao.md Shell 节「截图路径强制」：浏览器 MCP 截图**必须**落 `<项目根>/_tmp/qa/<context>/`，禁项目根或其他非 `_tmp/` 位置",
    escapeEnv: null, // 正路只是换个路径，给逃生阀等于把规则删了
    tools: [
      "mcp__chrome-devtools__take_screenshot",
      "mcp__playwright__browser_take_screenshot",
    ],
    test(input) {
      if (!/take_screenshot$/.test(input.tool_name || "")) return null;
      const ti = input.tool_input || {};
      // 不给路径 = 内联返回图片、不落盘 ⇒ 与本条无关，放行
      const raw = ti.filePath || ti.filename || ti.path || "";
      if (!raw) return null;
      const p = norm(raw);
      if (/(^|\/)_tmp\/qa\//i.test(p)) return null;
      return {
        what: `截图要落到 \`${p}\`，不在 \`_tmp/qa/\` 下`,
        how:
          "改成 `<项目根>/_tmp/qa/<context>/<type>-<description>.png`。" +
          "`<项目根>` 指**被操作的目标项目**（不是会话 cwd），`<context>` 是本次走查的名字；" +
          "命名规格见 dao-design standards.md §截图规格。项目 `.gitignore` 里 `**/_tmp/` 已兜住，" +
          "落别处的截图会进版本库或散在系统 temp 里找不回来。",
      };
    },
  },

  {
    id: "G5-readonly-todo",
    why: "dao.md「言 · 名之则」§只读载体禁写待办：PR body / commit message 等**事实只读**的载体禁用 `- [ ]`（`- [x]` 允许，它陈述过去）——复选框承诺「以后有人来勾」，而那个账本没有写入端",
    escapeEnv: "DAO_ALLOW_READONLY_TODO",
    tools: ["Bash", "PowerShell"],
    test(input) {
      if (!/^(Bash|PowerShell)$/.test(input.tool_name || "")) return null;
      const cmd = (input.tool_input || {}).command || "";
      const cwd = input.cwd || process.cwd();
      for (const seg of shellSegments(cmd)) {
        const isPrBody = /^gh\s+pr\s+(create|edit)\b/.test(seg);
        const isCommit = /^git\s+commit\b/.test(seg);
        if (!isPrBody && !isCommit) continue; // issue / comment 是可编辑载体，不在射程内

        // ① 正文直接写在命令里
        if (UNCHECKED_TODO.test(seg)) {
          return mk(seg, "命令里的正文");
        }
        // ② 正文在文件里（gh --body-file/-F、git commit -F/--file）
        const fm = seg.match(/(?:--body-file|--file|\s-F)\s+(?:"([^"]+)"|'([^']+)'|(\S+))/);
        if (fm) {
          const rel = fm[1] || fm[2] || fm[3];
          const abs = path.isAbsolute(rel) ? rel : path.join(cwd, rel);
          let body = null;
          try { body = fs.readFileSync(abs, "utf8"); } catch (_) { body = null; }
          // 读不到就放行：拿「我没读到」当「它违规了」是本体系点名的那种错
          // （L31「我没看到 ≠ 它不存在」）。这是明写的漏报面，不是遗漏。
          if (body != null && UNCHECKED_TODO.test(body)) {
            return mk(seg, `正文文件 \`${rel}\``);
          }
        }
      }
      return null;

      function mk(seg, where) {
        return {
          what: `${where}里有未勾选的 \`- [ ]\`，而目标载体（${/^git/.test(seg) ? "commit message" : "PR body"}）是只读的`,
          how:
            "三选一：①这几项**你已经做了** → 改成 `- [x]`（陈述过去，允许）；" +
            "②**还没做** → 从这里删掉，写进一个**可编辑**的账本（issue / TODO.md / 问题树面板），" +
            "只读载体里只留指针（`见 <文件>#<锚点>` 或 `#<issue 编号>`）；" +
            "③**这一项本批不适用** → 直接删行，别留个没人会来勾的框。" +
            "（确有理由要原样保留——例如正文在引用一段模板样例——由用户设 `DAO_ALLOW_READONLY_TODO=1`。）",
        };
      }
    },
  },

  {
    id: "G6-heartbeat-signature",
    why:
      "docs/specs/dao-rewrite-202608.md 分流表第 3 类「心跳投递机器化」——" +
      "心跳 prompt 必须以 `[dao-heartbeat]` 开头，这是 dao-rhythm.js 的 WAKEUP 信号**唯一**的识别面；" +
      "没有签名 ⇒ 那一轮不注入长窗留守四句 + `Read dao-longwindow.md §心跳对账节`，" +
      "而心跳轮是这份载荷唯一的投递时刻（dao.md 帅节长窗存根「投递通道」）",
    escapeEnv: "DAO_WAKEUP_UNSIGNED_OK", // 见头注 G6 ㈣：误伤面实测为零但不等于不存在
    tools: ["ScheduleWakeup"],
    test(input) {
      if ((input.tool_name || "") !== "ScheduleWakeup") return null;
      const ti = input.tool_input || {};
      // 收窗调用豁免：`{"stop":true}` 没有 prompt、也不产生下一轮，签它没有意义。
      // **只认布尔 true**，不认 "true"/1 —— 放宽这一格等于给出一个 agent 自己够得着的旁路
      // （设计取舍①：凡 agent 自己够得着的旁路，禁令即退化回 0%）。
      if (ti.stop === true) return null;
      const p = String(ti.prompt == null ? "" : ti.prompt).trim();
      if (HEARTBEAT_SIG.test(p)) return null;
      return {
        what:
          p
            ? `ScheduleWakeup 的 prompt 没有以 \`[dao-heartbeat]\` 开头（现在开头是 \`${p.slice(0, 40)}…\`）`
            : "ScheduleWakeup 既没有 `stop:true`，也没有 prompt —— 这一轮唤醒无从签名、也无从对账",
        how:
          "把 `[dao-heartbeat]` 原样加在 prompt 最前面（大小写敏感，前面不要有别的字符），" +
          "例如：`[dao-heartbeat] 高性能目标窗心跳。对账：① …`。" +
          "**它不是装饰**：dao-rhythm.js 靠这个前缀认出「这一轮是心跳唤醒」，" +
          "据此把长窗留守四句 + 「醒来第一动作 Read `ccswitch/rules/dao-longwindow.md` §心跳对账节」" +
          "注入到你醒来的那一轮；漏了签名，那一轮就什么都收不到，而「没收到」和「收到了没照做」" +
          "在日志上长得一模一样。" +
          "真要收窗就调 `ScheduleWakeup{stop:true}`（本闸对它放行）——" +
          "但别拿它绕开签名：dao.md 续力节的原话是「除了那一轮明确 stop:true，每一轮都要有心跳」。" +
          "（若确有一个**不由你构造 prompt** 的合法调用方——如内置 `/loop`——由**用户**设 " +
          "`DAO_WAKEUP_UNSIGNED_OK=1`；实测语料里这种形态出现 0 次，见本文件头注 G6 ㈣。）",
      };
    },
  },
];

// --selfcheck 要核对的覆盖面：闸 id → 该闸要拦的工具名样本
const REQUIRED_MATCHER_COVERAGE = GATES.map((g) => ({ id: g.id, tools: g.tools }));

// ── --selfcheck：把「它到底接上没有」摆出来 ─────────────────────────────────
// 「一道没跑的闸」与「一道跑了且零违例的闸」在任何日志里都长得一样，
// 所以覆盖面必须能被独立问一次，而不是靠「没报错」推断。
function selfcheck() {
  const lines = [];
  let bad = 0;

  let matchers = [];
  let regNote = "";
  try {
    const s = JSON.parse(fs.readFileSync(LIVE_SETTINGS, "utf8"));
    const pre = (s.hooks && s.hooks.PreToolUse) || [];
    for (const grp of pre) {
      const cmds = (grp.hooks || []).map((h) => String(h.command || ""));
      if (cmds.some((c) => /dao-hard-gates\.js/.test(c))) {
        matchers.push(grp.matcher == null ? "*" : String(grp.matcher));
      }
    }
    regNote = matchers.length
      ? `✓ 已注册于 PreToolUse，matcher=${matchers.map((m) => JSON.stringify(m)).join(" , ")}`
      : `✗ 未注册：${LIVE_SETTINGS} 的 hooks.PreToolUse 里没有引用 dao-hard-gates.js 的 command。` +
        `本 hook 此刻**一道闸都不生效**。修法：请用户把这组 PreToolUse 注册写进 cc-switch DB ` +
        `\`providers\` 表**每个** provider 的 \`settings_config\`（GUI 编辑 provider 配置或执行 SQL）——` +
        `切 provider 会用目标 provider 的配置整体覆盖 live，只写一个 provider 会在下次切换时静默失效（issue #50）。` +
        `⚠ 写 git 快照层 config-sync/common/settings.json 或 DB 的 common_config_* 镜像层**不会让它生效**（两层都不在下发路径上，#49 实测）。`;
    if (!matchers.length) bad++;
  } catch (e) {
    regNote = `✗ 读不到 live settings.json（${LIVE_SETTINGS}）：${e.message} —— 无从判定是否注册，按未注册计。`;
    bad++;
  }
  lines.push(regNote);

  // 逐闸核 matcher 覆盖面。matcher 是正则串，宿主侧按正则匹配工具名。
  for (const { id, tools } of REQUIRED_MATCHER_COVERAGE) {
    const uncovered = tools.filter((t) => !matchers.some((m) => matcherCovers(m, t)));
    if (!matchers.length) {
      lines.push(`  · ${id}：未注册 ⇒ 覆盖面无从谈起`);
    } else if (uncovered.length) {
      bad++;
      lines.push(`  ✗ ${id}：matcher 覆盖不到 ${uncovered.join(" , ")} ⇒ **这道闸静默零覆盖**`);
    } else {
      lines.push(`  ✓ ${id}：matcher 覆盖 ${tools.length} 个工具名样本`);
    }
  }

  lines.push(`共 ${GATES.length} 道闸；逃生阀（仅用户可设）：` +
    GATES.filter((g) => g.escapeEnv).map((g) => g.escapeEnv).join(" , ") + "。");

  process.stdout.write(lines.join("\n") + "\n");
  process.exit(bad ? 1 : 0);
}

function matcherCovers(matcher, tool) {
  if (matcher === "*" || matcher === "") return true;
  try {
    // 宿主对 matcher 是全串匹配还是子串匹配未被文档担保，两种都试过才算覆盖
    const re = new RegExp(matcher);
    if (re.test(tool)) return true;
    return new RegExp("^(?:" + matcher + ")$").test(tool);
  } catch (_) {
    return false;
  }
}

// ── 主流程 ──────────────────────────────────────────────────────────────────
if (process.argv.includes("--selfcheck")) selfcheck();

let input = {};
try {
  input = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
} catch (_) {
  process.exit(0); // 读不到/解析不了输入 → 放行（见头注②）
}

try {
  for (const gate of GATES) {
    const hit = gate.test(input);
    if (!hit) continue;
    if (gate.escapeEnv && process.env[gate.escapeEnv] === "1") continue;

    process.stderr.write(
      `\n🔒 [dao-hard-gates ${gate.id}] 这一步被拦下了。\n\n` +
      `拦的是什么：${hit.what}\n\n` +
      `判据出处：${gate.why}\n\n` +
      `合法路径：${hit.how}\n\n` +
      (gate.escapeEnv
        ? `逃生阀：环境变量 ${gate.escapeEnv}=1（**只有用户设得了**——你在 Bash 里 export 影响不到本 hook 进程）。\n`
        : `本闸无逃生阀：它拦的事没有合法例外。\n`) +
      `为什么是一道闸而不是一句提醒：禁令类规则写在文本里的实测遵守率是 0%（arxiv 2607.26819），` +
      `所以这一条被搬到了 agent 之外。别绕它——绕过去就等于这条规则不存在。\n`
    );
    process.exit(2);
  }
} catch (e) {
  // fail-open（见头注②）：一道会因自身 bug 拦死一切的闸没有逃生通道。
  // 但绝不静默——放行与通过在退出码上长得一样，这行 stderr 是唯一的区分。
  process.stderr.write(
    `[dao-hard-gates] ⚠ 守卫自身出错，本次**放行**（fail-open）：${e && e.stack ? e.stack : e}\n` +
    `⇒ 这一刻它没有在守。跑 \`node ccswitch/hooks/dao-hard-gates.js --selfcheck\` 看接线，并修掉这个错。\n`
  );
  process.exit(0);
}

process.exit(0);
