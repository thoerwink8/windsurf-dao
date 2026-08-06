// dao tool-nudge hook — 六类软提醒:①绕道 Bash 跑 grep/cat/find ②PR 合并期机械链裸手跑 ③直推主干
//                                  ④浏览器 MCP 首调 → 去读 GUI 验证细则
//                                  ⑤热重载 dev server 起在主仓树而非专用 worktree
//                                  ⑥推送触及条款索引的源文件 → 去跑 gen-clause-index.mjs --check
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
// 🔴 **它此刻大概率投递不到,照直写**:本 hook 在 live settings.json 里注册的 PostToolUse
// **matcher 是 `Bash`**,而 `mcp__chrome-devtools__take_screenshot` 不匹配 `Bash`
// ⇒ **第 ④ 类的代码在这里、投递为零**,而「没跑的闸」与「跑了且没意见的闸」在任何日志里
// 长得一样。要它真响,需要用户把那个 matcher 扩到覆盖两个 MCP 前缀(写入面是 cc-switch DB
// 的 providers.settings_config,AI 侧被权限分类器全路径拦截 ⇒ 属用户动作)。
// **别凭记忆判断它通没通**,跑:  node ccswitch/hooks/dao-tool-nudge.js --selfcheck
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
// ── ⑥ 推送触及条款索引的源文件(2026-08-07 加,issue #162 用户拍板「塞指针 + 加提醒」的后半)──
// `ccswitch/clause-index.json` 是**派生物**:改了条款源而不 regen,索引就过期;而
// `render-clauses.mjs` 对过期索引是 fail-closed ⇒ SubagentStart 那条投递通道从「投条款」
// 降成「投指针」,**每个新派的官都少收一份条款,且没有任何面向帅的报警**。
// 这个病 2026-08-05~07 三天内发生两次,两次都是**直推 docs 微改**——而唯一的既有防线
// `tests/clause-index.tests.js` 只在有人跑测试时红,直推那条路恰恰不跑测试。⑥ 就是那一格。
//
// 命中形态:段首 `git push`(排除 `--delete`/`-d`,那是删远程分支、不动 `@{u}`),**且**这次推送
// 真的动了条款索引的源文件之一,**且**同一次推送里没带上 `ccswitch/clause-index.json`
// (带了 ⇒ regen 多半跑过了,`--check` 本来就绿,再提醒纯属噪音)。
//
// 🔴 **源清单现场从 `ccswitch/lib/clause-parser.mjs` 的 `defaultSources()` 读,本文件不留副本**
// (索引路径与 regen 命令同样取自它的 `DEFAULT_INDEX_REL` / `REGEN_CMD`,一次 import 三个值全拿)。
// 硬编码一份的话,下次往清单里加源,这道提醒会**静默地**对那个源失明 ——
// 而它要治的病本身就是「派生物没跟上真相源」,自己再犯一次太难看。
// 那份是 ESM 而本文件是 CJS,故走一次 `node --input-type=module -e "import …"` 子进程取值;
// 只在**真的看见 push 段且它确实动了文件**时才付这次进程开销。
//
// 「这次推送送出去了什么」用**上游远程跟踪分支的 reflog 区间** `<up>@{1}..<up>` 判。
// ⚠ 这里有个坑,首版差点踩:本 hook 是 PostToolUse,跑到这里时 push **已经成功**、
// `@{u}` 已经等于 HEAD ⇒ 拿 `@{u}..HEAD` 判**恒为空**,这道提醒会一次都不响而看起来完全正常。
//
// 已知盲区照直写,一律**宁漏勿滥**(判不出就不提醒):没有上游(首次推新分支)· reflog 里没有
// 上一条 · `git push origin HEAD:main` 这类推的不是 `@{u}` 的形态 · 非 git 仓 · git 超时。
// 反过来的一格也照直写:**空推(Everything up-to-date)或推别的分支时,`<up>@{1}..<up>` 仍是上一次
// 推送的区间** ⇒ 可能就同一笔改动**再提醒一次**。那不是误报(条件字面上仍成立、索引可能真的还没跟上),
// 是重复;重复的代价是噪音,而静默的代价是这道提醒不存在,取前者。
//
// 配在 PostToolUse(复刻 dao-glob-gate 已验证的 additionalContext 注入路径)。始终 exit 0,只提醒不阻断。
// ⚠ 它是**事后**提醒:PostToolUse 在命令跑完之后才触发,所以第 ② 类命中时 PR 多半已经合了——
// 提醒的实际作用是「补做合并后那两步复核」与「下次走脚本」,不是拦截。这一点别读成守卫。
// 第 ④ 类同理:提醒到达时那次截图已经拍完了,它买的是**这一次走查剩下的部分**和下一次的选型。
//
// 回归网:tests/dao-tool-nudge.tests.js(正控+误伤负控双向)。
// 真相源:windsurf-dao/ccswitch/hooks/dao-tool-nudge.js
// 由 settings.json 的 PostToolUse hook 调用(当前注册 matcher: Bash,见上方 ④ 的射程说明)。

const fs = require("fs");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");
const { spawnSync } = require("child_process");

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

// ── ⑥ 的判据 ───────────────────────────────────────────────────────────────
// 条款解析器所在处。**它是唯一真相源**:12 个源、索引路径、regen 命令三样都从它现场读。
const CLAUSE_PARSER = process.env.DAO_TOOL_NUDGE_CLAUSE_PARSER ||
  path.join(ROOT, "ccswitch", "lib", "clause-parser.mjs");

// 现场取三个值。任何一步不顺(文件不在 / import 失败 / 输出不是预期形状)一律返回 null ⇒ 本类静默。
// **刻意不给默认值兜底**:兜底就是在这里偷偷存了一份副本,而副本会漂移到没人发现。
function clauseIndexFacts() {
  try { if (!fs.existsSync(CLAUSE_PARSER)) return null; } catch (_) { return null; }
  const url = pathToFileURL(CLAUSE_PARSER).href;
  const code =
    `import { defaultSources, DEFAULT_INDEX_REL, REGEN_CMD } from ${JSON.stringify(url)};` +
    "process.stdout.write(JSON.stringify({" +
    "sources: defaultSources().map((s) => s.file), index: DEFAULT_INDEX_REL, regen: REGEN_CMD }));";
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    encoding: "utf8", timeout: 8000, windowsHide: true,
  });
  if (r.status !== 0) return null;
  try {
    const o = JSON.parse(String(r.stdout || ""));
    if (!o || !Array.isArray(o.sources) || o.sources.length === 0) return null;
    if (typeof o.index !== "string" || !o.index) return null;
    return o;
  } catch (_) { return null; }
}

// 「这次 push 究竟送出去了哪些文件」。判不出一律返回 null(见头注⑥ 的盲区清单)。
// 走的是**上游远程跟踪分支的 reflog 上一位**,不是 `@{u}..HEAD`——理由见头注那个坑。
function pushedFiles(dir) {
  const up = spawnSync("git", ["-C", dir, "rev-parse", "--abbrev-ref", "@{u}"], {
    encoding: "utf8", timeout: 4000, windowsHide: true,
  });
  if (up.status !== 0) return null; // 没有上游 / 不是 git 仓 / git 不在 ⇒ 判不出
  const upstream = String(up.stdout || "").trim().split(/\r?\n/)[0].trim();
  if (!upstream) return null;
  const d = spawnSync("git", ["-C", dir, "diff", "--name-only", `${upstream}@{1}..${upstream}`], {
    encoding: "utf8", timeout: 6000, windowsHide: true,
  });
  if (d.status !== 0) return null; // reflog 里没有上一条(首次推该分支)⇒ 判不出
  return String(d.stdout || "").split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
}

// ── --selfcheck:把「④ 到底投递得到吗」摆出来 ───────────────────────────────
// 形态照抄 dao-hard-gates.js 的 selfcheck(逐面核 matcher 覆盖),**判据各自独立**:
// 那边核的是各道硬闸要拦的工具名(闸数以那边的 GATES 为准,此处刻意不写死——原写「五道闸」,
// 2026-08-02 加 G6 时才发现这个数字散在三处),这边核的是本 hook 各类提醒要看见的工具名
// (类数同理不写死,以下面的 REQUIRED_COVERAGE 为准——本行原写「四类」,同日加第 ⑤ 类即过期,
//  与那边的「五道闸」是同一个病的两侧,一并治掉)。
// 只抽形态不抽判据 —— 与 ccswitch/lib/hook-selfcheck.js 的抽取原则一致。
const REQUIRED_COVERAGE = [
  { face: "①②③⑤⑥ Bash 面(工具选择 / PR 合并链 / 直推主干 / 热重载树隔离 / 条款源推送)", tools: ["Bash"] },
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
      // 此处刻意**不写类数**：本行原写「四类」，加第 ⑤ 类时即过期，加第 ⑥ 类时又要改一次——
      // 与本文件头注点名的那个病同型（散在三处的硬编码计数）。类数以下面 REQUIRED_COVERAGE 逐面打印为准。
      lines.push(`✗ 未注册：${LIVE_SETTINGS} 的 hooks.PostToolUse 里没有引用 dao-tool-nudge.js 的 command ⇒ 本 hook 的提醒此刻一条都不生效。`);
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
// ⑥ 用:命中过 push 段的那一刻在哪个目录(git 判定同样放循环外做一次)。
let pushDir = null;

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
    // ⑥:**任何**推送都记下(不只主干)——条款源住在 dao 仓,而 dao 仓的改动走不走 PR 都可能漏 regen。
    if (curDir !== null) pushDir = curDir;
  }
}

// ⑤ 的 git 判定放在循环外做一次:spawn 一个子进程比正则贵得多,只在真命中过启动命令时才付。
if (devServerDir !== null && isLinkedWorktree(devServerDir) === false) {
  flows.add("dev-server-main-tree");
}

// ⑥ 同理:两次 git + 一次 node,只在真看见 push 段、且那次推送确实动了文件时才付。
let clauseHit = null;
if (pushDir !== null) {
  const files = pushedFiles(pushDir);
  if (files && files.length) {
    const facts = clauseIndexFacts();
    if (facts) {
      const hit = files.filter((f) => facts.sources.includes(f));
      // 索引同批推上去了 ⇒ regen 多半跑过,`--check` 本来就绿 ⇒ 静默(见头注⑥)。
      if (hit.length && !files.includes(facts.index)) clauseHit = { hit, facts };
    }
  }
}
if (clauseHit) flows.add("clause-source-push");

if (hints.size === 0 && flows.size === 0) process.exit(0);

const blocks = [];

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

if (flows.has("clause-source-push")) {
  const { hit, facts } = clauseHit;
  blocks.push(
    "【dao 条款索引】本次推送动了条款索引的**源文件**(" + hit.join(" , ") + ")," +
    "而同一次推送里**没有** `" + facts.index + "`。那个索引是**派生物**:源变了它不会自己跟上。" +
    "索引一过期,`render-clauses.mjs` 就 fail-closed ⇒ SubagentStart 那条通道从「投条款」降成「投指针」," +
    "**此后每个新派的 subagent 都少收一份条款,而帅这边没有任何报警**——" +
    "「数到 0 和没看到样本,输出一模一样」。这个病 2026-08-05~07 三天内发生过两次,两次都是直推改源没 regen。" +
    "⇒ **现在跑一次**:`" + facts.regen + " --check`(exit 1 就跑掉 `--check` 的那条重新生成," +
    "把 `" + facts.index + "` 一起提交)。" +
    "本提醒是**事后**的(PostToolUse),推已经发出去了 ⇒ 买的是「补一个提交」,不是拦截。" +
    "⚠ 判据是近似的,两侧都构造得出反例:靠上游远程跟踪分支的 reflog 区间反推「这次推了什么」," +
    "首次推新分支、`HEAD:main` 这类形态一律判不出而**静默**;反过来空推或推别的分支时," +
    "可能就同一笔改动重复提醒一次。**别把「它没响」读成「索引是新鲜的」**——那个问题只有 `--check` 答得准。"
  );
}

const context = blocks.join("\n\n");

process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: "PostToolUse",
    additionalContext: context
  }
}));

process.exit(0);
