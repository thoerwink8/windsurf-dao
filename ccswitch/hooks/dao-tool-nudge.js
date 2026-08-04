// dao tool-nudge hook — 五类软提醒 + 一个**动作**:
//                                  ①绕道 Bash 跑 grep/cat/find ②PR 合并期机械链裸手跑 ③直推主干
//                                  ④浏览器 MCP 首调 → 去读 GUI 验证细则
//                                  ⑤热重载 dev server 起在主仓树而非专用 worktree
//                                  ⑥`_tmp/` 新落盘工件里的裸凭据 → **就地脱敏**(唯一会改盘的一类)
//
// ── ① 工具选择(本 hook 的原始职责)────────────────────────────────────────────
// 背景:Claude Code 同时允许内置 Grep(ripgrep)/Glob/Read 与 Bash(*),
// 两条路都零摩擦,模型常习惯性写 shell 一行(grep -nE "..." file | head)绕过内置工具。
// 内置工具更快(自动跳过 .git/node_modules/二进制)、结果可点击跳转、不撑爆主上下文。
//
// 本 hook 在 Bash 执行后,检测命令是否"直接搜文件/读文件",是则注入软提醒,纠正后续行为。
//   - grep/egrep/fgrep 直接搜文件(带 -r/-l/--include 或 文件路径参数)→ 建议 Grep
//   - find ... -name/-path/-type/-exec  → 建议 Glob / Explore
//   - cat/head/tail/less/more 直接读文件 → 建议 Read
//
// 关键豁免(降噪):管道下游的过滤(`ps | grep x`、`cmd | head`)内置工具替代不了 → 不提示。
//   只有"段首 + 带文件特征"才算绕道。git grep / --grep / ripgrep / zgrep 一律豁免。
//
// ── ② PR 合并期机械链(2026-08-01 加,dao 重塑批 C · C5)──────────────────────
// dao.md Shell 节那条链(fetch → 核 rev-parse 真的动了 → merge 主干 → 重跑验证 → 合 PR
// → prune → 实查远程分支真的没了)每一步都是零判断祈使句,却长期只以**文字**形态存在。
// canonical 实现是 ccswitch/scripts/dao-pr-merge.ps1;本 hook 是它的**触发点**——
// 载体挂这里而不是 scaffold-manifest,因为后者是存在性检查(只保证脚本在,不保证被调用)。
//
// 命中形态:段首 `gh pr merge`。**刻意只认这一个**——它是整条链上唯一不可省的写操作,
// 而 `git fetch` / `git merge` 单独出现时提示只会是噪音(它们有大量与 PR 无关的正当用法)。
// 已带 `-File ...dao-pr-merge` 的调用不提示(那就是正路)。
//
// 两侧代价都是真的:漏报=这次合并没被提醒;滥报=每次合 PR 都插一段废话然后被无视。
// 故取高精度低召回,与本 hook 既有的降噪原则一致。
//
// ── ③ 直推主干(2026-08-01 加,P1 门控出文本层 · 乙类)────────────────────────
// dao.md Shell 节「PR-first 节律」**明写「非禁令」**:代码类改动默认走 PR,
// **文档/配置微改可直推**。⇒ 它有真实的合法例外,机器判不出这次是哪一种
// (hook 看得见 `git push origin main`,看不见这次改的是 CHANGELOG 还是 auth 模块),
// 故它归**乙类:软提醒**,不进 ccswitch/hooks/dao-hard-gates.js 那道 exit 2 的闸。
// 判定表与三档分档理由见 P1 批 PR body。
//
// 命中形态:段首 `git push` 且**参数里显式点名 main/master**(含 `HEAD:main` 形式)。
// **裸 `git push` 刻意不认**——那时目标分支写在 upstream 配置里、命令串看不见,
// 认它只能靠猜当前分支,而猜错的代价是每次推特性分支都插一段废话然后被无视。
// 这是同一条高精度低召回原则的第三次应用,漏报面已知且写在这里。
//
// ── ④ 浏览器 MCP 首调(2026-08-02 加,dao.md 瘦身批 · #5)──────────────────────
// dao.md 动·目·观 的「GUI 工具决策树 + 防断路规则」正文迁去 ccswitch/rules/dao-gui-verify.md
// 后,dao.md 只剩一行存根「每次截图/GUI 交互前 Read 那份文件」。**「必经动作」这四个字
// 本身没有任何机器投递**(本仓实测无标记时刻的自由裁量携带率 9-24%),故这里给它一个投递:
// 本会话**第一次**调到 mcp__chrome-devtools__* / mcp__playwright__* 时,把那句话送到眼前。
//
// **只提醒一次**:同一 session 内后续调用一律静默。GUI 走查动辄几十次截图,每次插一段
// 等于把这个 hook 的第一原则(宁可漏报不可滥报)亲手废掉。去重状态落
// <repo>/_tmp/tool-nudge/browser-mcp-seen.json,按 session_id 记;测试用 DAO_TOOL_NUDGE_STATE 覆写。
// 状态**写不动时仍然提醒**(可能因此重复):一个状态目录坏掉就静默零投递,正是本 hook
// 头注反复在说的那种死法;重复的代价是噪音,静默的代价是这条规则不存在。重复时提醒里会自陈。
//
// 🟢 **2026-08-02 订正:这一格已经通了,原文写的是它通之前的状态**。本段此前写着
// 「matcher 是 `Bash` ⇒ 第 ④ 类投递为零」——**那句话现在是假的**:实跑
// `node ccswitch/hooks/dao-tool-nudge.js --selfcheck` 对 live settings.json 求值,得到
// matcher = `"Bash|mcp__chrome-devtools__.*|mcp__playwright__.*"`、两个 MCP 面均覆盖、exit 0。
// 用户在此期间把它扩了,而**本文件作为「被描述者」自己没跟上** —— 正是官侧条款
// 「改一条关于某个对象的陈述时,Grep 面要含那个对象自己的源文件与头注」讲的那个形态,
// 只是这次反过来:对象变了而它的自述没变。**always-on / 头注里的假保障比没有保障更危险**,
// 故订正而不是删除。⚠ **别把这次订正读成「以后不用查了」**:注册面是 cc-switch DB 的
// providers.settings_config、**每个 provider 各存一份**,切 provider 会被目标 provider 的
// 配置整体覆盖 ⇒ 它**随时可能再次漂移**,而漂移是静默的。
// **判它通没通的唯一办法仍然是跑那个 --selfcheck,别凭记忆、也别凭本段。**
// 那个自检逐面核对 matcher 覆盖不覆盖 ①②③⑤ 的 Bash 面与 ④ 的两个 MCP 面,缺一即 exit 1。
//
// ── ⑤ 热重载 dev server 起在主仓树(2026-08-02 加,dao 整体重写批 1-D)───────────
// dao.md 帅节:「热重载型验证(真机 / dev server / watch 编译)从专用 worktree 起,不从主仓树
// ——『冻结 main』靠纪律守不住,隔离构建才是彻底解」(用户点名事故后固化 2026-08-01,
// 基线:同窗真机 wave4 被并发的主仓瞬时编辑触发 dev 重启 3 次,观测建立在污染构建上需重跑)。
// 那条判据此前只有文字形态,而它的触发时刻**极其确定**:你正要敲那条起 dev server 的命令。
//
// 命中形态:段首是热重载型启动命令(pnpm/npm/yarn/bun/npx 的 dev 脚本 · tauri dev · vite
// 不带子命令 · webpack serve/--watch),**且**那一刻所在目录经 `git rev-parse --git-dir
// --git-common-dir` 判定为**主仓工作树**(两者相等)。链接 worktree 里两者不等 ⇒ 静默,
// 那正是正路。目录取 hook 输入的 `cwd`,并按命令里出现过的 `cd <路径>` 段逐段推进
// (`cd ../repo-wt-x && pnpm dev` 是常见正路形态,不推进 cwd 就会对它误报)。
//
// 判不出来时一律不提醒(不是 git 仓 / 没有 git / 目录不存在 / 超时):**漏报一次的代价是
// 这次没被提醒,误报一次的代价是每次起 dev 都插一段废话然后被无视**——同本 hook 既有的
// 高精度低召回原则。已知盲区照直写:`pnpm --dir <path> dev` / `npm --prefix` 这类**不靠 cd
// 换树**的形态不认;`cd -` 无从推进;经 .ps1/.sh 包装脚本间接起的 dev server 不认
// (如 mousse-cli 的 start-isolated-dev.ps1 —— 顺带一提,那个脚本隔离的是 WebView2 用户数据
// 目录与 app 数据库,**不隔离工作树**,两件事别混,本类提醒对它依然成立)。
//
// 与 ②③ 同为**事后**提醒:PostToolUse 触发时 dev server 已经起来了,提醒买的是「现在换树重起」
// 或「在交付里写明这次观察建立在共享树上」,不是拦截。
//
// ── ⑥ `_tmp/` 新落盘工件的凭据脱敏(2026-08-02 加,issue #101)──────────────────
// **本类与上面五类不同:它会改盘,不只是说话。** 判据、四条设计约束与射程全文在
// ccswitch/lib/tmp-redact-sweep.js 的头注(**唯一真相源**),此处只说为什么挂在这个 hook 上。
//
// 病:PR #98 把脱敏防线做成了库,但库只保护**调用它**的链。而实际产出真凭据的,是住在
// `_tmp/` 里、**根本不在仓内**的一次性 ops 脚本(2026-08-02 摸底:22 处 provider live dump
// 含 `ANTHROPIC_AUTH_TOKEN` 与 JWT)—— 它们永远不会去 import 那个库,也进不了任何清单。
//
// 收口点:那些脚本不在仓内,但**全都经由一次工具调用被跑起来**。所以唯一对所有产出者都成立
// 的位置不是产出者,而是**它们跑完之后那一刻** —— 也就是这里。产出者不需要合作。
//
// 为什么挂在本 hook 而不新起一个:新 hook 要注册,注册面是 cc-switch DB 的
// providers.settings_config,**属用户动作**(AI 侧被权限分类器拦截)⇒ 新 hook 大概率变成
// 「代码写好了但从没被调用过」,而那与不存在在任何日志里长得一样(第 ④ 类刚吃过这个亏)。
// 挂在**已注册且实测覆盖 Bash 面**的本 hook 上,是当前唯一投递得到的形态。
// ⚠ 连带射程:matcher 不含 `Write` ⇒ 用 Write 工具直接写出的 dump 要等**下一次任意 Bash 调用**
// 才被扫到。这是已知缺口,不是疏忽 —— 扩 matcher 属用户动作。
//
// 配在 PostToolUse(复刻 dao-glob-gate 已验证的 additionalContext 注入路径)。始终 exit 0,只提醒不阻断。
// ⚠ 它是**事后**提醒:PostToolUse 在命令跑完之后才触发,所以第 ② 类命中时 PR 多半已经合了——
// 提醒的实际作用是「补做合并后那两步复核」与「下次走脚本」,不是拦截。这一点别读成守卫。
// 第 ④ 类同理:提醒到达时那次截图已经拍完了,它买的是**这一次走查剩下的部分**和下一次的选型。
// 第 ⑥ 类是这句话唯一的例外:它**不只是提醒**,当场就把裸凭据擦掉了 —— 事后性在这里体现为
// 「那份 dump 在盘上真实存在过一小段时间」,而不是「只能靠人补做」。
//
// 回归网:tests/dao-tool-nudge.tests.js(正控+误伤负控双向)· tests/tmp-redact-sweep.tests.js(⑥)。
// 真相源:windsurf-dao/ccswitch/hooks/dao-tool-nudge.js
// 由 settings.json 的 PostToolUse hook 调用(注册 matcher 以 --selfcheck 实测为准,别凭本行)。

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
// ⑥ 的实现体。**加载失败不许让整个 hook 崩**：它挂在 PostToolUse 上,一个抛异常的 hook
// 会把另外五类提醒一起带走,而那五类与 ⑥ 毫无关系。但**也不许静默降级** —— 静默失效正是
// 本文件头注反复在说的那种死法,故失败时把加载错误一路带到输出里(见下方 ⑥ 段)。
// (顺带:本仓的 mutation 测试会把本文件复制到别处再跑,那时 `__dirname` 变了、这个 require
//  必然失败 —— 那条路径走的就是这里的降级分支,它同时也是这段容错的第一个真实用例。)
let TMP_SWEEP = null;
let TMP_SWEEP_LOAD_ERR = null;
try {
  TMP_SWEEP = require(path.resolve(__dirname, "..", "lib", "tmp-redact-sweep.js"));
} catch (e) {
  TMP_SWEEP_LOAD_ERR = String((e && e.message) || e);
}

// ── ④ 的常量与状态 ─────────────────────────────────────────────────────────
const ROOT = path.resolve(__dirname, "..", ".."); // 本文件在 <root>/ccswitch/hooks/
const HOME = process.env.USERPROFILE || process.env.HOME || os.homedir();
const LIVE_SETTINGS = path.join(HOME, ".claude", "settings.json");
const BROWSER_MCP_RE = /^mcp__(chrome-devtools|playwright)__/;
const SEEN_FILE = process.env.DAO_TOOL_NUDGE_STATE ||
  path.join(ROOT, "_tmp", "tool-nudge", "browser-mcp-seen.json");
// 去重表的条目上限:session 只增不减,不封顶就会长成一个没人看的大 JSON。
// 超限时保留最近的一半(与 hook-selfcheck 的日志轮转同形态)。
const SEEN_MAX = 200;

// ── ⑤ 的判据 ───────────────────────────────────────────────────────────────
// 段首的热重载型启动命令。**刻意逐形态列举而不写通配**:`npm start` / 任意 `pnpm <script>`
// 这类"可能是 dev server 也可能不是"的形态一概不认——认了就得靠猜,而猜错的代价见头注⑤。
const DEV_SERVER_RE = new RegExp(
  "^(?:" +
    // pnpm dev / npm run dev / yarn dev / bun dev:debug / pnpm run dev:ui
    "(?:pnpm|npm|yarn|bun|npx)\\s+(?:run\\s+)?dev(?::[\\w.-]+)?\\b" +
    "|" +
    // tauri dev(cargo tauri dev / pnpm tauri dev / npm run tauri dev / 裸 tauri dev)
    "(?:(?:pnpm|npm|yarn|bun|npx|cargo)\\s+(?:run\\s+)?)?tauri\\s+dev\\b" +
    "|" +
    // vite 不带子命令或带 dev。`vite build` / `vite preview` 由后面的否定环视排除
    "(?:(?:pnpm|npm|yarn|bun|npx)\\s+(?:run\\s+)?)?vite(?:\\s+dev)?\\b(?!\\s+[a-z])" +
    "|" +
    // webpack serve / webpack ... --watch
    "(?:(?:pnpm|npm|yarn|bun|npx)\\s+(?:run\\s+)?)?webpack(?:\\s+serve\\b|\\s+[^\\n]*--watch\\b)" +
  ")"
);
// 帮助信息不起进程
const DEV_SERVER_EXEMPT_RE = /\s(?:--help|-h|--version|-v)\b/;

// Git Bash 的 MSYS 路径(`/d/frank/x`)在 win32 下直接 resolve 会落到错误的盘符(`D:\d\frank\x`),
// 先翻译成 `D:/frank/x`。本仓的 Bash 工具就是 Git Bash,这是最常见的 cd 参数形态。
function fromMsys(p) {
  const m = /^\/([a-zA-Z])\/(.*)$/.exec(String(p || ""));
  return (process.platform === "win32" && m) ? `${m[1].toUpperCase()}:/${m[2]}` : p;
}

// 判定「这个目录是不是链接 worktree」。true=专用 worktree · false=主仓工作树 ·
// null=判不了(不是 git 仓 / 没有 git / 目录不存在 / 超时)——null 一律静默,见头注⑤。
function isLinkedWorktree(dir) {
  try {
    const r = spawnSync("git", ["-C", dir, "rev-parse", "--git-dir", "--git-common-dir"], {
      encoding: "utf8", timeout: 4000, windowsHide: true,
    });
    if (r.status !== 0) return null;
    const lines = String(r.stdout || "").trim().split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    if (lines.length < 2) return null;
    // git 在主仓树里返回相对路径(`.git` / `.git`),在链接 worktree 里返回绝对路径且两者不等。
    // 两侧都 resolve 一次再比,免得把「相对 vs 绝对」的写法差异读成「不同的树」。
    const norm = (p) => path.normalize(path.resolve(dir, p)).replace(/[\\/]+$/, "").toLowerCase();
    return norm(lines[0]) !== norm(lines[1]);
  } catch (_) {
    return null;
  }
}

// ── --selfcheck:把「④ 到底投递得到吗」摆出来 ───────────────────────────────
// 形态照抄 dao-hard-gates.js 的 selfcheck(逐面核 matcher 覆盖),**判据各自独立**:
// 那边核的是各道硬闸要拦的工具名(闸数以那边的 GATES 为准,此处刻意不写死——原写「五道闸」,
// 2026-08-02 加 G6 时才发现这个数字散在三处),这边核的是本 hook 各类提醒要看见的工具名
// (类数同理不写死,以下面的 REQUIRED_COVERAGE 为准——本行原写「四类」,同日加第 ⑤ 类即过期,
//  与那边的「五道闸」是同一个病的两侧,一并治掉)。
// 只抽形态不抽判据 —— 与 ccswitch/lib/hook-selfcheck.js 的抽取原则一致。
const REQUIRED_COVERAGE = [
  { face: "①②③⑤ Bash 面(工具选择 / PR 合并链 / 直推主干 / 热重载树隔离)", tools: ["Bash"] },
  {
    face: "④ 浏览器 MCP 面(GUI 验证细则首调提醒)",
    tools: ["mcp__chrome-devtools__take_screenshot", "mcp__playwright__browser_click"],
  },
];

function matcherCovers(matcher, tool) {
  if (matcher === "*" || matcher === "") return true;
  try {
    // 宿主对 matcher 是全串匹配还是子串匹配未被文档担保,两种都试过才算覆盖
    const re = new RegExp(matcher);
    if (re.test(tool)) return true;
    return new RegExp("^(?:" + matcher + ")$").test(tool);
  } catch (_) {
    return false;
  }
}

function selfcheck() {
  const lines = [];
  let bad = 0;
  const matchers = [];
  try {
    const s = JSON.parse(fs.readFileSync(LIVE_SETTINGS, "utf8"));
    for (const grp of (s.hooks && s.hooks.PostToolUse) || []) {
      const cmds = (grp.hooks || []).map((h) => String(h.command || ""));
      if (cmds.some((c) => /dao-tool-nudge\.js/.test(c))) {
        matchers.push(grp.matcher == null ? "*" : String(grp.matcher));
      }
    }
    if (matchers.length) {
      lines.push(`✓ 已注册于 PostToolUse，matcher=${matchers.map((m) => JSON.stringify(m)).join(" , ")}`);
    } else {
      bad++;
      lines.push(`✗ 未注册：${LIVE_SETTINGS} 的 hooks.PostToolUse 里没有引用 dao-tool-nudge.js 的 command ⇒ 四类提醒此刻一条都不生效。`);
    }
  } catch (e) {
    bad++;
    lines.push(`✗ 读不到 live settings.json（${LIVE_SETTINGS}）：${e.message} —— 无从判定是否注册，按未注册计。`);
  }

  for (const { face, tools } of REQUIRED_COVERAGE) {
    if (!matchers.length) { lines.push(`  · ${face}：未注册 ⇒ 覆盖面无从谈起`); continue; }
    const uncovered = tools.filter((t) => !matchers.some((m) => matcherCovers(m, t)));
    if (uncovered.length) {
      bad++;
      lines.push(`  ✗ ${face}：matcher 覆盖不到 ${uncovered.join(" , ")} ⇒ **这一类提醒静默零投递**`);
    } else {
      lines.push(`  ✓ ${face}：matcher 覆盖 ${tools.length} 个工具名样本`);
    }
  }

  lines.push(
    "覆盖不足的修法：把 PostToolUse 里 dao-tool-nudge.js 那组的 matcher 扩成 " +
    '"Bash|mcp__chrome-devtools__.*|mcp__playwright__.*"。' +
    "写入面是 cc-switch DB 的 providers.settings_config（**每个 provider 都要改**，" +
    "切 provider 会被目标 provider 的配置整体覆盖）——**属用户动作**，AI 侧被权限分类器拦截。"
  );
  process.stdout.write(lines.join("\n") + "\n");
  process.exit(bad ? 1 : 0);
}

if (process.argv.includes("--selfcheck")) selfcheck();

// ── 输入 ────────────────────────────────────────────────────────────────────
let raw = "";
try { raw = fs.readFileSync(0, "utf8"); } catch (_) {}

let input = {};
try { input = JSON.parse(raw); } catch (_) {}

const toolName = input.tool_name || "";
const cmd = (input.tool_input && input.tool_input.command) || "";

// ── ④ 浏览器 MCP 首调 ───────────────────────────────────────────────────────
// 走在 Bash 分支之前:它与命令串无关,提前返回免得被下面那个 `!cmd` 早退吃掉。
if (BROWSER_MCP_RE.test(toolName)) {
  const sessionId = String(input.session_id || "unknown-session");
  let seen = null;          // null = 读不动(与「空表」分开:前者要自陈,后者是常态)
  try {
    seen = JSON.parse(fs.readFileSync(SEEN_FILE, "utf8"));
    if (!seen || typeof seen !== "object" || Array.isArray(seen)) seen = {};
  } catch (e) {
    seen = e && e.code === "ENOENT" ? {} : null;
  }

  if (seen && Object.prototype.hasOwnProperty.call(seen, sessionId)) process.exit(0); // 本会话已提醒过

  let persisted = false;
  try {
    const next = seen || {};
    next[sessionId] = new Date().toISOString();
    const keys = Object.keys(next);
    if (keys.length > SEEN_MAX) {
      // 按记录时间排序后留后半。时间戳坏掉的条目排在最前、优先被丢,不影响判定语义。
      keys.sort((a, b) => String(next[a]).localeCompare(String(next[b])));
      for (const k of keys.slice(0, keys.length - Math.floor(SEEN_MAX / 2))) delete next[k];
    }
    fs.mkdirSync(path.dirname(SEEN_FILE), { recursive: true });
    fs.writeFileSync(SEEN_FILE, JSON.stringify(next, null, 2) + "\n", "utf8");
    persisted = true;
  } catch (_) { persisted = false; }

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext:
        "【dao GUI 验证】本会话首次调用浏览器 MCP（" + toolName + "）。" +
        "GUI 工具选型与防断路的正文在 `ccswitch/rules/dao-gui-verify.md`，dao.md 只留了一行存根 ⇒ " +
        "**现在 Read 那份文件全文**，再继续这次走查。两组要点：" +
        "①**三器决策树**——有 WebView 层且远程调试端口开着走 chrome-devtools（DOM 级精度），" +
        "纯 Web / Vite dev server 走 playwright，原生 Win32 无 Web 层只能 PowerShell + .NET 截图脚本落 `_tmp/qa/`；" +
        "**windows-mcp 任何场景都不是选项**（已一票否决并卸载，PreToolUse 硬闸 G1 会当场 exit 2）。" +
        "②**防断路三条**——同一会话只用一个浏览器工具不中途换（换工具＝端口/锁冲突＝排障循环＝烧 context）；" +
        "启动 dev server / 开调试端口在会话最开头做一次，不在中途反复杀重启；" +
        "MCP 连接失败 2 次就停下查端口与进程状态，不盲目重试。" +
        "另：截图落盘路径由硬闸 G4 强制在 `<项目根>/_tmp/qa/<context>/`，落别处会被 exit 2 拦下。" +
        (persisted ? "" :
          "（⚠ 去重状态没写成——`" + SEEN_FILE + "` 写不动，本会话后续调用可能重复看到这段提醒。" +
          "重复是噪音，而静默是这条规则直接消失，故取前者；顺手看一眼那个目录的权限。）"),
    },
  }));
  process.exit(0);
}

if (toolName !== "Bash" || !cmd) process.exit(0);

// 把命令拆成"命令段":按 ; \n && || 以及单管道 | 切分。
// 切分后,被管道喂入的命令独立成段(段首即 grep/head 等),且不带源文件参数 → 天然豁免。
const segments = cmd.split(/;|\n|&&|\|\|?/);

const hints = new Set();
const flows = new Set();

// ⑤ 用:逐段推进「此刻在哪个目录」。起点是宿主给的 cwd,`cd <路径>` 段推进它。
let curDir = String((input && input.cwd) || process.cwd() || ".");
let devServerDir = null;

for (let seg of segments) {
  seg = seg.trim();
  if (!seg) continue;

  // 段首 `cd <路径>`:推进 ⑤ 的目录游标。`cd`(回 home)与 `cd -`(回上一个)无从推进,
  // 此时把游标置 null ⇒ 本次放弃 ⑤ 判定。**不保持旧值**:旧值若恰是主仓树就会误报,
  // 而误报正是这个 hook 最贵的错误方向。绝对路径可以把游标救回来。
  if (/^cd(\s|$)/.test(seg)) {
    const m = seg.match(/^cd\s+("[^"]*"|'[^']*'|[^\s;&|]+)/);
    const raw = fromMsys((m ? m[1] : "").replace(/^["']|["']$/g, ""));
    if (!raw || raw === "-") curDir = null;
    else if (path.isAbsolute(raw)) curDir = path.resolve(raw);
    else if (curDir !== null) curDir = path.resolve(curDir, raw);
  }

  // 去掉前导 `cd <path>` 残留(`cd x && grep` 已被 && 拆开,这里兜底 `cd x; grep` 同段情况)
  const s = seg.replace(/^\s*cd\s+[^\s]+\s+/, "");

  // ── ⑤ 热重载 dev server(段首;记下命中那一刻的目录,git 判定放在循环外做一次)──
  if (curDir !== null && DEV_SERVER_RE.test(s) && !DEV_SERVER_EXEMPT_RE.test(s)) {
    devServerDir = curDir;
  }

  // ── grep 搜文件:排除 ripgrep/zgrep/--grep(git);要求段首是 grep 且带文件搜索特征 ──
  if (/^(e?grep|fgrep)\b/.test(s) && !/--grep|\bripgrep\b|\bzgrep\b/.test(s)) {
    const hasFlag = /\s-[a-zA-Z]*[rRl][a-zA-Z]*(\s|$)|\s--(include|exclude|recursive)/.test(s);
    // 文件型参数:含 / 的路径,或形如 name.ext 的文件名(.go/.js/.ts...)
    const hasFileArg = /\s[^\s-][^\s]*\/[^\s]*|\s[^\s-][^\s]*\.[a-zA-Z0-9]{1,6}(\s|$)/.test(s);
    if (hasFlag || hasFileArg) hints.add("grep");
  }

  // ── find 搜文件 ──
  if (/^find\b/.test(s) && /-(name|path|iname|type|exec|maxdepth)\b/.test(s)) {
    hints.add("find");
  }

  // ── cat/head/tail/less/more 直接读文件(段首 + 跟一个文件名,非管道下游)──
  if (/^(cat|head|tail|less|more)\b/.test(s)) {
    const hasFileArg = /\s[^\s-][^\s]*\/[^\s]*|\s[^\s-][^\s]*\.[a-zA-Z0-9]{1,6}(\s|$)/.test(s);
    if (hasFileArg) hints.add("read");
  }

  // ── gh pr merge 裸手跑(段首;走 canonical 脚本的那条路豁免)──
  if (/^gh\s+pr\s+merge\b/.test(s) && !/dao-pr-merge/.test(s)) {
    flows.add("pr-merge");
  }

  // ── 直推主干(段首 git push + 参数里显式点名 main/master;裸 push 不认,见头注③)──
  // `--delete` 刻意排除:那是删远程分支,与"直推主干"是两件事(且删主干由 git 侧安全网管)。
  if (/^git\s+push\b/.test(s) && !/\s--delete\b|\s-d\b/.test(s)) {
    const args = s.split(/\s+/).slice(2);
    const hitsTrunk = args.some((a) =>
      /^\+?(main|master)$/.test(a) || /^\+?HEAD:(main|master)$/.test(a) || /^\+?(main|master):(main|master)$/.test(a)
    );
    if (hitsTrunk) flows.add("push-trunk");
  }
}

// ⑤ 的 git 判定放在循环外做一次:spawn 一个子进程比正则贵得多,只在真命中过启动命令时才付。
if (devServerDir !== null && isLinkedWorktree(devServerDir) === false) {
  flows.add("dev-server-main-tree");
}

// ── ⑥ `_tmp/` 凭据脱敏(唯一会改盘的一类;判据全文在 lib 头注)────────────────
// **必须走在上面那个早退之前**:它与 hints/flows 无关 —— 绝大多数命中它的命令
// (`node _tmp/dump.mjs`)一条提醒都不触发,若放在早退之后就永远轮不到它跑。
// 逃生阀 DAO_TMP_SWEEP_OFF=1 只有用户设得了(agent 在 Bash 里 export 影响不到本进程)。
let sweepNotice = null;
let sweepUserMessage = null;
// 🔴 **没有 cwd 就不扫**(2026-08-04 立)。旧写法 `input.cwd || process.cwd()` 在**调用方
// 没给 cwd** 时退到本进程的 cwd。对生产调用没问题(宿主一直给),但对**任何 spawn 它的测试**
// 就是灾难:cwd 变成开发者的真仓 ⇒「跑一次测试」= 对真 `_tmp/` 做一次真实改盘,而那套测试
// 自己是绿的。实测三次独立复发,一次比一次远:
//   ① tests/dao-tool-nudge.tests.js  改坏官自己的三个探针(其一成语法错误)+ 一份 PR 评论草稿
//   ② tests/subagent-clauses.tests.js 红绿取决于在哪个目录敲命令
//   ③ tests/hard-gates.tests.js:64   本批实测:它吃掉了本 worktree `_tmp/dump/` 里的一个 canary
// **三次都在「谁调用我」那一侧,所以修在那一侧永远修不完** —— ①② 修好之后 ③ 照样发作,
// 而 ③ 归另一路官的在途 PR 管、本批碰不得 ⇒ 收口到这里:**拿不到显式 cwd 就不改盘**。
// 失败方向与扫描面白名单一致——**朝窄**:最坏是「某次 dump 没被自动脱敏」(#108 之前的常态),
// 不是「静默改坏别人的源码」。
// **为什么只进 stderr 不进 additionalContext**:这一格报的是「我没做事」而不是「我改了盘」,
// 每次无 cwd 调用都往模型上下文塞一段是拿噪音换可见性;改盘那一格照旧三重留痕。
const explicitCwd = input && typeof input.cwd === "string" && input.cwd ? input.cwd : null;
if (process.env.DAO_TMP_SWEEP_OFF !== "1" && !explicitCwd) {
  try {
    process.stderr.write(
      "[dao 凭据脱敏] 本次调用的 payload 里没有 cwd ⇒ 跳过 `_tmp/` 自动脱敏" +
      "(不拿 process.cwd() 兜底:那会让任何 spawn 本 hook 的测试改到开发者真仓的 _tmp/,已实测三次复发)。\n"
    );
  } catch (_) { }
}
if (process.env.DAO_TMP_SWEEP_OFF !== "1" && explicitCwd) {
  try {
    if (!TMP_SWEEP) throw new Error("ccswitch/lib/tmp-redact-sweep.js 加载失败：" + TMP_SWEEP_LOAD_ERR);
    const root = TMP_SWEEP.findRepoRoot(explicitCwd);
    if (root) {
      const sweepRes = TMP_SWEEP.sweep({ root });
      sweepNotice = TMP_SWEEP.renderNotice(sweepRes, root);
      // 🔴 真改了用户的盘 ⇒ 必须走**用户可见**通道,不能只进 additionalContext(模型侧,
      // 一轮就过去了)。本仓自己的约定写在 `dao-rule-echo.js:29`:出错要 stderr +
      // systemMessage + 落盘三重留痕;而 ⑥ 是全仓**唯一会改用户盘**的一类,比"出错"更该出声。
      // 用户 2026-08-03 拍板接受误伤时附的义务:「既然接受误伤,误伤就必须是可发现的」。
      // 三重留痕在本类里的落点:stderr(这里)+ systemMessage(下面 emit)+ 追加式台账(lib 判据 ⑧)。
      sweepUserMessage = TMP_SWEEP.renderUserMessage(sweepRes, root);
      if (sweepUserMessage) { try { process.stderr.write(sweepUserMessage + "\n"); } catch (_) { } }
    }
  } catch (e) {
    // 不吞:一个静默失败的脱敏器与没有脱敏器一样,而后者至少不会让人以为有兜底。
    sweepNotice =
      "⚠【dao 凭据脱敏】`_tmp/` 自动脱敏这一步**自己出错了**(" + (e && e.code ? e.code + " " : "") +
      String((e && e.message) || e).slice(0, 200) + ")。⇒ 本次落盘的工件**没有**过这道过滤," +
      "把 `_tmp/` 内容贴进 PR / issue / 报告之前先手动跑 " +
      "`node ccswitch/scripts/dao-redact.mjs --scan _tmp`。";
    // 出错同样走三重留痕(dao-rule-echo.js:29 的既有约定):stderr + systemMessage + 上面那段。
    sweepUserMessage = "[dao 凭据脱敏] `_tmp/` 自动脱敏出错,本次未生效 —— " +
      String((e && e.message) || e).slice(0, 160);
    try { process.stderr.write(sweepUserMessage + "\n"); } catch (_) { }
  }
}

if (hints.size === 0 && flows.size === 0 && !sweepNotice && !sweepUserMessage) process.exit(0);

const blocks = [];
if (sweepNotice) blocks.push(sweepNotice);

if (hints.size) {
  const parts = [];
  if (hints.has("grep")) parts.push("grep 直接搜文件 → 用内置 Grep(底层 ripgrep,自动跳过 .git/node_modules/二进制,可 glob/type 过滤)");
  if (hints.has("find")) parts.push("find 搜文件名 → 用内置 Glob(如 **/*.go);大范围扫荡派 Explore subagent");
  if (hints.has("read")) parts.push("cat/head/tail 读文件 → 用内置 Read(可点击跳转,带行号)");
  blocks.push(
    "【dao 工具选择】本次 Bash 命令绕过了内置工具:" + parts.join("；") + "。" +
    "内置工具更快、结果可点击、不会把搜索原文撑爆主上下文。下次优先用内置工具;" +
    "仅当内置确实做不到(管道过滤如 `ps | grep`、find -exec、流式处理)才用 shell。"
  );
}

if (flows.has("pr-merge")) {
  blocks.push(
    "【dao PR 合并链】本次裸手跑了 gh pr merge。canonical 实现是 " +
    "`ccswitch/scripts/dao-pr-merge.ps1`(参数化 repo/验证命令/PR 号,先 -DryRun),它按序做完并逐步核验:" +
    "git fetch → 核 rev-parse origin/<主干> 真的动了 → merge 主干进本分支 → 在**合并后的树**上重跑验证 → " +
    "gh pr merge --merge(**不带** --delete-branch) → 实查 gh pr view --json state 判合并成败(不看 gh 退出码) → " +
    "git fetch --prune → git push origin --delete <branch> → 实查 git ls-remote --heads origin <branch> 真的空了。" +
    "本提醒是**事后**的(PostToolUse),PR 多半已经合了 ⇒ 现在至少补最后两步复核:" +
    "①你刚才那条若带了 `--delete-branch`:它在本地分支被 worktree 占用时**整体失败且错误只提本地**,远程可能还在," +
    "补 `git push origin --delete <branch>`;更麻烦的是那个非零退出码**盖着两个动作**,别据它判「合并失败」——" +
    "问 `gh pr view <n> --json state`(issue #114 实证:据退出码判失败会让整个清理一步都跑不到);" +
    "②预算型护栏(单文件 LOC/包体积/覆盖率下限)是按**和**判的而 PR 按**增量**审,`MERGEABLE` 只是语法层面的绿——" +
    "合并后的主干上重跑一次全套才算数。"
  );
}

if (flows.has("push-trunk")) {
  blocks.push(
    "【dao PR-first】本次直推了主干(main/master)。dao.md Shell 节的 PR-first 是**默认节律不是禁令**——" +
    "文档/配置微改直推是允许的,所以这里只提醒不阻断。**若本次推的是代码类改动**,正路是:" +
    "开分支 → `gh pr create` → `pwsh -File ccswitch/scripts/dao-pr-merge.ps1`(它按序做完 fetch/核 rev-parse/" +
    "合并态重跑验证/合 PR/prune/实查远程分支真的空了)。" +
    "PR 的价值不是质量门(质量门是测试+dogfood),是给用户留**异步审查锚点 + 独立回滚点**——" +
    "直推进去的改动,用户事后想 revert 时没有一个干净的粒度可撤。" +
    "另:产品型项目可在自己的 `.claude/rules/` 把它强化为强制,那时本条就不是「可直推」了,以项目侧为准。"
  );
}

if (flows.has("dev-server-main-tree")) {
  blocks.push(
    "【dao 热重载隔离】本次在**主仓工作树**里起了热重载型 dev server(" + devServerDir + ")。" +
    "dao.md 帅节:「热重载型验证(真机 / dev server / watch 编译)从专用 worktree 起,不从主仓树」——" +
    "那个进程 watch 的就是这棵树,而主仓树是**共享**的:你后续的每一次 Edit、另一路在途官的提交、" +
    "一次 git pull,都会触发重编译或整页重载,**被观察的状态在你没看见的时候被重建了**,此后所有观察都可疑。" +
    "「冻结 main」是纪律型约束(实测同一窗内被违反 ≥3 次,违反者含帅自己),**隔离构建才是彻底解**:" +
    "`git worktree add ../<repo>-wt-<slug>` 起一棵专用树,从那里跑 dev,主仓怎么改都不进它的 watch 面,连 freeze 都不需要。" +
    "判据一句话:**我的验证进程 watch 的是哪棵树?那棵树此刻只有它一个人写吗?**" +
    "本提醒是**事后**的(PostToolUse),进程已经起来了 ⇒ 二选一:要么停掉换专用树重起," +
    "要么在交付里写明「本次观察建立在共享工作树上,可能被并发写入污染」,别让它默认读成干净观测。" +
    "⚠ 隔离**实例**的脚本(WebView2 user-data-dir / app 数据库那类,如 mousse-cli 的 " +
    "`start-isolated-dev.ps1`)解的不是这个问题——那是实例隔离,这是**工作树**隔离,两件事。"
  );
}

const context = blocks.join("\n\n");

// systemMessage 是**顶层**字段(与 hookSpecificOutput 平级),同 dao-design-sync-gate.js 的用法。
// 只有 ⑥ 真改了盘(或它自己出错)时才挂 —— 其余几类都是纯提醒,不该占用户的视野。
const payload = {
  hookSpecificOutput: {
    hookEventName: "PostToolUse",
    additionalContext: context
  }
};
if (sweepUserMessage) payload.systemMessage = sweepUserMessage;

process.stdout.write(JSON.stringify(payload));

process.exit(0);
