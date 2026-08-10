// dao-rule-echo 两态自证 · 单元级（喂 PostToolUse 形态 JSON → 断言 stdout）
//
// 跑法：node tests/dao-rule-echo.tests.js   （全绿 exit 0，任一红 exit 1）
//
// 验的是哪一层：**hook 脚本自身的输入→输出契约**。它证明「命中判据即产出结构正确的
// additionalContext / 不命中即零输出 / 出错不静默」，**不证明**回灌真的进了模型上下文
// ——后者取决于 settings.json 注册与宿主投递，需另行以 --selfcheck 的心跳核验。
//
// 用 spawnSync 直接喂 stdin，绕开 PowerShell 引号/编码坑。
// 全部用例带 DAO_RULE_ECHO_SELFTEST=1，心跳标 synthetic，不污染 --selfcheck 的接线判定。
//
// ── 🔴 夹具隔离：共享位置的夹具名必须带进程唯一后缀（issue #82）─────────────────
// 本测试的 P2 段要往两个地方落**真文件**（hook 的 readScopeGlobs 刻意读盘而不是看载荷，
// 拿载荷断言等于验了另一条路径）：
//   ① `<本目录>/.fixtures-scope-<uniq>/`             —— 仓内，同一棵树里并行才会撞
//   ② `~/.claude/rules/zz-test-fixture-*-<uniq>.md`  —— **机器级共享，跨 worktree 也撞**
// ② 那一格曾用固定名，于是盘上多棵 worktree 并行跑测试时，A 的收尾 unlink 会删掉 B 正在
// 用的夹具，把 B 的 PR 染成看似「你弄坏了 rule-echo」。
// 实测（`node scripts/repro-fixture-isolation.mjs -c 6 -r 3`）：固定名时 33%–56% 的子进程
// 被染红，唯一后缀后零红。**改这两个路径之前先跑那个复现脚本** —— 它是这条约束唯一的机器侧守护。
//
// ── 🔴 夹具落点：① 那一格还继承「这棵树被 checkout 到哪」（issue #253）───────────
// 上面那段治的是**名字**撞车。还有一格治的是**位置**：`<本目录>` 从 `__dirname` 长出来，
// 于是整棵树在哪，夹具就在哪；而 hook 的 EXCLUDE 是对**整条绝对路径**求值的
// （`dao-rule-echo.js` 的 `classifyRuleFile()` 第一行）。把树 checkout 到一个名叫
// `_tmp` / `build` / `dist` / `coverage` / … 的目录**下面**，夹具就被判成「不是生效中的
// 规则文件」、hook 静默零输出 ⇒ P2 段确定性红 10 条。
// 实测（2026-08-10，同一份代码只换树的位置）：
//   主仓 · `%TEMP%/…` · `.claude/worktrees/…` · `.claude/worktrees/coverage-x/…`  ⇒ PASS=65
//   `.claude/worktrees/build/…` · `_tmp/…`                                        ⇒ PASS=55 FAIL=10
// **它不是环境敏感**（没有任何别人的活动参与，跑一百次都一样），故不标 `@dao-test-tier: env`
// —— 标了只是把一个位置决定的确定性红藏进合并前才跑的那一层。治法是下面的 `pickFixtureRoot()`。
// ⚠️ P2 段那几条**否定式**断言（「不误报为作用域」「不判为作用域」「exit 0」…）在 hook 全静默
// 时照绿。对抗实测（PR #263，H1/H2/H3/H5）把这一格量准了：全静默那一次**另有 35 条兄弟断言
// 全红**，而这几条各自对它名字上写的那个缺陷都**真的会红** ⇒ 它们是**弱断言，不是死断言**。
// 真正的洞在**输入类的正向覆盖**上：case ④（有 frontmatter 无 `paths` 键）此前只有一条否定式
// 守着，定向让 hook 只对这一形态静默 ⇒ **全套一条不红**（H7 零检出）。本批照那个实测补两条
// 正控（见下面 ④），不给否定式各配前置守卫 —— 后者动 5 处，却打不中这个洞。
//
// 本文件头注同批订正一处：原「①`<本目录>/.fixtures-scope-<uniq>/`」现已**不保证**落在仓内，
// 见 `pickFixtureRoot()`——树坐落在排除面里时它会退到系统临时目录，并在 stdout 打印实际落点。
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const HOOK = path.resolve(__dirname, "..", "ccswitch", "hooks", "dao-rule-echo.js");

// 本进程的夹具唯一标识：PID 防跨进程撞名，随机段防 PID 复用（PID 回收很快，同一 PID
// 一秒内连跑两次测试并不罕见）。两者缺一，都还留着一格撞名可能。
const UNIQ = `${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
const USER_RULES_DIR = path.join(os.homedir(), ".claude", "rules");
const FIXTURE_PREFIX = "zz-test-fixture-";

// 唯一后缀自带的代价，同批还掉：进程被强杀（Ctrl-C / TaskStop / 宿主超时）时 finally 不跑，
// 夹具会留在**用户真实的规则目录**里，且因为名字每次都不同而越攒越多——固定名时代至少
// 还只留一个。故每次开跑先清一次陈旧残留。
// 判据刻意保守，三条同时满足才删：①正好这个前缀 ②`.md` ③ mtime 超 1 小时。
// 1 小时远大于本测试的整体耗时（~1.5s），故**绝不会删到正在跑的另一个进程的夹具**——
// 那样就把刚修好的互染原样造了回来。只碰自己这一族的名字，不碰用户任何真规则。
const STALE_FIXTURE_MS = 60 * 60 * 1000;
function sweepStaleFixtures() {
  const swept = [];
  let entries;
  try { entries = fs.readdirSync(USER_RULES_DIR); } catch (_) { return; }
  for (const f of entries) {
    if (!f.startsWith(FIXTURE_PREFIX) || !f.endsWith(".md")) continue;
    const p = path.join(USER_RULES_DIR, f);
    try {
      if (Date.now() - fs.statSync(p).mtimeMs < STALE_FIXTURE_MS) continue;
      fs.unlinkSync(p);
      swept.push(f);
    } catch (_) { /* 并发下被别人抢先删掉/占用都不是错误，跳过 */ }
  }
  if (swept.length) console.log(`  ⓘ 清掉 ${swept.length} 个超 1 小时的陈旧夹具残留：${swept.join(", ")}`);
}

// ── 夹具落点的挑选（issue #253）─────────────────────────────────────────────
// 这里的判据是**本测试自己维护的一份独立副本**，刻意不 require 那个 hook、也不复用它的
// 正则对象：守卫里「我是不是瞎了」那一半不许复用被守对象的解析（dao `[#守-自检不复用被守对象的解析]`），
// 而且那个 hook 在 require 的那一刻就去读 stdin，本来也 require 不动。
//
// 代价：**它会与 hook 的 EXCLUDE 漂移，而漂移会把本 issue 的修复整个撤销**。hook 那边新增一个
// 恰好出现在本树路径上的目录名 ⇒ 撞上的人看到的是与修复前**逐字相同**的 10 条业务红，而下面
// 那几条落点断言全绿、正指向反方向说「落点挑得没问题」（PR #263 对抗实测 D1，实录 FAIL=12）。
// 兜底是下面 `driftOfExcludeLiteral()` 那道**字面对账**（P2 段开头报两条）。
// 🔴 别把 P2 段开头那两条判别力自检（一正一负）当成这一格的兜底：它们喂的是硬编码字面串、
// 查的是**本测试自己这份副本**的两个极端态（什么都不拦 / 什么都拦），**从不读 hook 那一份**
// ⇒ 对「hook 改了、我这边没跟上」结构上失明。实测：hook 新增一个不在任何路径上的名字、
// 或摘掉一个名字（D2/D3），那两条**零检出**。本行原写「兜底是那两条」，与实测不符，已改真。
const EXCLUDED_DIR_NAMES = /(^|\/)(_tmp|_scratch|node_modules|\.git|dist|build|target|coverage|__pycache__)\//i;

// 与 hook 那份 EXCLUDE 的**字面对账**（issue #253 未尽处④，PR #263 对抗实测 D1/D2/D3 坐实）。
// 为什么这不违反 `[#守-自检不复用被守对象的解析]`：那条禁的是复用被守对象的**解析**——
// 这里把两份源码当**纯文本**读，各抽出 `const X = /…/flags;` 那一行的字面**逐字比**，
// 既不 require 那个 hook，也不把抽出来的串 `new RegExp` 回去当判据使，两边零共享分类逻辑。
// 抽不到字面（谁把声明的形状改了）**也判红、不静默** —— 否则这道对账会在退役日无声消失，
// 而「它没报」与「它瞎了」长得一模一样。两种失效各报一条，名字分得开。
// ⚠️ **代价照直写，别以为是你弄坏了什么**：它是**逐字**比对且对**声明的形状**敏感，复抗实测
// 三种「语义完全没变」的编辑都会把全套变红 —— 给那一行加个行尾注释、把常量改个名（声明与
// 用处一起改）、甚至只调换名单里两个名字的顺序。这是刻意的 fail-closed，detail 会直接打印
// 两份字面差在哪；**两份一起改，红就消失**。
// 🔴 **它证不到的那一格**：字面**逐字相同**、而「怎么用这个正则」被改了（复抗实测 G5：给
// `coverage/` 单独网开一面，对账两条全绿）。那一格归下面「负态·逐名」段的行为样本管，
// 不归这道对账管——**别把这道对账读成「应用点也有人守」**。
function driftOfExcludeLiteral() {
  const litOf = (src, name) => {
    const m = new RegExp(`^const ${name} = (/.*/)([a-z]*);\\s*$`, "m").exec(src);
    return m ? m[1] + m[2] : null;
  };
  let hookSrc, selfSrc;
  try {
    hookSrc = fs.readFileSync(HOOK, "utf8");
    selfSrc = fs.readFileSync(__filename, "utf8");
  } catch (e) {
    return { extracted: false, same: false, why: `读不到源码：${e && e.message}` };
  }
  const a = litOf(hookSrc, "EXCLUDE");
  const b = litOf(selfSrc, "EXCLUDED_DIR_NAMES");
  if (!a || !b) {
    return { extracted: false, same: false, why: `抽不到字面（hook 侧=${!!a} · 本测试侧=${!!b}）——声明的形状被改了，对账已失效` };
  }
  return { extracted: true, same: a === b, why: a === b ? "两份字面逐字相同" : `hook=${a} · test=${b}` };
}

// 按顺序挑第一个「**将来那个夹具文件的完整落点**都不命中排除面」的根。
//   ① 仓内（已 gitignore、与被测对象同树、跑完就地清）—— 正常位置下与改动前逐字相同；
//   ② 这棵树本身坐落在排除面里时，退到系统临时目录（它的路径与仓库位置无关）。
// ⚠️ ② 是**近似不是保证**：谁的 TMPDIR 落在 `…/build/tmp` 之类的位置，它照样命中。
//    那时本函数返回 null，由调用方红**一条**说清楚，而不是让 10 条业务断言各自红成一片
//    ——「工具坏了」与「被测对象坏了」必须分得开。
// 两个参数都只为可测（默认分别是本文件所在目录与真实 `os.tmpdir()`），别在生产路径上传值。
// 🔴 `tmpDir` 这一格是 2026-08-10 复抗返修补的，理由值得留下：此前只有 `baseDir` 可传，
// 于是那两条断言**一半合成一半真实**，两个方向都走不通 ——
//   · 谓词写 `.kind === "tmpdir"` ⇒ 被这台机器的 `%TEMP%` 绑架：谁的 TMPDIR 坐落在
//     `…/build/tmp` 之类的位置，候选② 也被排除、返回 `null`，**摆得完全正确的树照红**；
//   · 改成 `.kind !== "repo"` 治好了假红，却把 `null` 一起收了下来
//     （`(null || {}).kind` 是 `undefined`，而 `undefined !== "repo"` 为真）⇒ 把候选②
//     **整条删掉**全套一条不红（复抗实测 P1 零检出）——而候选② 正是树被摆进排除面时唯一的活路。
// **两个候选都参数化之后**，三种落点都用全合成输入钉死，零机器耦合、也不必把 `null` 放行。
function pickFixtureRoot(baseDir, tmpDir) {
  const base = baseDir || __dirname;
  const tmp = tmpDir || os.tmpdir();
  const candidates = [
    ["repo", "仓内 tests/", path.resolve(base, `.fixtures-scope-${UNIQ}`)],
    ["tmpdir", "系统临时目录", path.join(tmp, `dao-rule-echo-fixtures-${UNIQ}`)],
  ];
  for (const [kind, label, dir] of candidates) {
    // 判的是**夹具文件**的完整路径，不是根目录本身 —— hook 看到的是前者。
    const sample = path.join(dir, ".claude", "rules", "scoped.md").replace(/\\/g, "/");
    if (!EXCLUDED_DIR_NAMES.test(sample)) return { kind, label, dir };
  }
  return null;
}

function run(payload, env) {
  const input = typeof payload === "string" ? payload : JSON.stringify(payload);
  const r = spawnSync(process.execPath, [HOOK], {
    input,
    encoding: "utf8",
    env: Object.assign({}, process.env, { DAO_RULE_ECHO_SELFTEST: "1" }, env || {}),
  });
  let json = null;
  if (r.stdout && r.stdout.trim()) { try { json = JSON.parse(r.stdout); } catch (_) {} }
  return { code: r.status, out: r.stdout || "", err: r.stderr || "", json };
}

// 真实宿主 PostToolUse 输入形态
function ptu(tool, tool_input, extra) {
  return Object.assign({
    session_id: "test-session",
    transcript_path: "C:/fake/transcript.jsonl",
    cwd: "D:/frank/mousse-cli",
    hook_event_name: "PostToolUse",
    tool_name: tool,
    tool_input,
    tool_response: { filePath: tool_input.file_path, success: true },
  }, extra || {});
}

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? "  →  " + detail : ""}`); }
}
function ctx(r) {
  return (r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.additionalContext) || "";
}

const RULES = "D:/frank/mousse-cli/.claude/rules/dispatch-clauses.md";
const NEW_CLAUSE = "- 派复审 range 前必须实算,禁目测：用 `git merge-base` 求共同祖先,不凭「最近几个提交」估起点。";

console.log("\n=== 正态：规则文件写入必须回灌 ===");
{
  const r = run(ptu("Edit", { file_path: RULES, old_string: "OLD", new_string: NEW_CLAUSE }));
  check("Edit .claude/rules → 有 additionalContext", ctx(r).length > 0);
  check("Edit .claude/rules → 回灌含本次写入原文", ctx(r).includes(NEW_CLAUSE));
  check("Edit .claude/rules → hookEventName 正确",
    r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.hookEventName === "PostToolUse");
  check("Edit .claude/rules → 标注文件性质", /项目规则 \.claude\/rules/.test(ctx(r)));
  check("Edit .claude/rules → 声明全量回灌", /已全量回灌/.test(ctx(r)));
  check("Edit .claude/rules → exit 0", r.code === 0, "code=" + r.code);
}
{
  const r = run(ptu("Edit", { file_path: "D:/frank/windsurf-dao/ccswitch/dao.md", old_string: "a", new_string: "新授权条款 X" }));
  check("Edit ccswitch/dao.md（@import 常驻）→ 回灌", ctx(r).includes("新授权条款 X") && /dao 场域根/.test(ctx(r)));
}
{
  const r = run(ptu("Edit", { file_path: "C:/Users/Administrator/.claude/CLAUDE.md", old_string: "a", new_string: "全局条款 Y" }));
  check("Edit ~/.claude/CLAUDE.md → 回灌", ctx(r).includes("全局条款 Y") && /CLAUDE\.md/.test(ctx(r)));
}
{
  const r = run(ptu("Edit", { file_path: "D:/frank/mousse-cli/CLAUDE.md", old_string: "a", new_string: "项目铁律 Z" }));
  check("Edit 项目 CLAUDE.md → 回灌", ctx(r).includes("项目铁律 Z"));
}
{
  const r = run(ptu("Edit", { file_path: "C:/Users/Administrator/.claude/projects/D--frank-mousse-cli/memory/MEMORY.md", old_string: "a", new_string: "记忆条目 M" }));
  check("Edit auto-memory → 回灌", ctx(r).includes("记忆条目 M") && /auto-memory/.test(ctx(r)));
}
{
  const body = "# 测试规则\n\n- 条款一：测试用\n";
  const r = run(ptu("Write", { file_path: "D:/frank/mousse-cli/.claude/rules/zz-echo-probe.md", content: body }));
  check("Write 新建小规则文件 → 全量回灌", ctx(r).includes("条款一：测试用") && /全量 \d+ 字符/.test(ctx(r)));
}
{
  const big = "X".repeat(9000);
  const r = run(ptu("Write", { file_path: "D:/frank/windsurf-dao/ccswitch/dao.md", content: big }));
  const c = ctx(r);
  check("Write 大文件重写 → 转摘要模式", /大文件重写/.test(c) && /全文请 Read/.test(c));
  check("Write 大文件重写 → 正文不倾泻全文", c.length < 3000, "ctx len=" + c.length);
  check("Write 大文件重写 → 报真实规模 9000 字符", /9000 字符/.test(c));
}
{
  const big = "Y".repeat(6000);
  const r = run(ptu("Edit", { file_path: RULES, old_string: "a", new_string: big }));
  const c = ctx(r);
  check("Edit 超预算 → 截断并明示余量", /超 4000 字符预算/.test(c) && /余 2000 字符未回灌/.test(c));
  check("Edit 超预算 → 正文确被截到预算内", (c.match(/Y+/) || [""])[0].length === 4000);
}
{
  const r = run(ptu("MultiEdit", { file_path: RULES, edits: [
    { old_string: "a", new_string: "段一条款 A" },
    { old_string: "b", new_string: "段二条款 B" },
    { old_string: "c", new_string: "" },
  ] }));
  const c = ctx(r);
  check("MultiEdit → 各段 new_string 均回灌", c.includes("段一条款 A") && c.includes("段二条款 B"));
  check("MultiEdit → 空段标为删除/清空", /段 3：new_string 为空（删除\/清空）/.test(c));
  check("MultiEdit → 报段数", /共 3 段/.test(c));
}
{
  const r = run(ptu("Edit", { file_path: RULES, old_string: "被删掉的一整条条款", new_string: "" }));
  const c = ctx(r);
  check("Edit 纯删除 → 仍提示（删条款是危险操作，值得可见）", c.length > 0 && /删除\/清空条款/.test(c));
  check("Edit 纯删除 → 无 begin/end 正文块", !/本次写入内容 begin/.test(c));
}

// Windows 真实 tool_input 常给反斜杠路径 —— 归一化是承重逻辑，必须显式验
{
  const r = run(ptu("Edit", { file_path: "D:\\frank\\mousse-cli\\.claude\\rules\\dispatch-clauses.md", old_string: "a", new_string: "反斜杠路径条款 W" }));
  check("反斜杠路径（Windows 原生形态）→ 仍命中并回灌", ctx(r).includes("反斜杠路径条款 W"));
}
{
  const r = run(ptu("Edit", { file_path: "D:\\frank\\windsurf-dao\\ccswitch\\dao.md", old_string: "a", new_string: "反斜杠 dao.md 条款" }));
  check("反斜杠 ccswitch\\dao.md → 仍命中", ctx(r).includes("反斜杠 dao.md 条款") && /dao 场域根/.test(ctx(r)));
}
// worktree 里的规则副本对该 worktree 会话同样生效，不该被漏掉
{
  const r = run(ptu("Edit", { file_path: "D:/frank/mousse-cli/.claude/worktrees/agent-abc/.claude/rules/dispatch-clauses.md", old_string: "a", new_string: "worktree 条款 T" }));
  check("worktree 内 .claude/rules → 命中", ctx(r).includes("worktree 条款 T"));
}
{
  const r = run(ptu("Write", { file_path: "D:/frank/mousse-cli/.claude/worktrees/agent-abc/CLAUDE.md", content: "# worktree 项目铁律\n- 条款 V\n" }));
  check("worktree 内 CLAUDE.md → 命中", ctx(r).includes("条款 V"));
}

console.log("\n=== 负态：非规则文件一个字都不许输出 ===");
const NEG = [
  ["前端代码 .tsx", ptu("Edit", { file_path: "D:/frank/mousse-cli/src-ui/src/App.tsx", old_string: "a", new_string: "b" })],
  ["Rust 代码 .rs", ptu("Edit", { file_path: "D:/frank/mousse-cli/crates/mousse-core/src/lib.rs", old_string: "a", new_string: "b" })],
  ["_tmp 临时 md", ptu("Write", { file_path: "D:/frank/mousse-cli/_tmp/notes.md", content: "随手记" })],
  ["_tmp 下的同名 CLAUDE.md（排除面）", ptu("Write", { file_path: "D:/frank/mousse-cli/_tmp/fixture/CLAUDE.md", content: "假规则" })],
  ["node_modules 下的 CLAUDE.md", ptu("Edit", { file_path: "D:/x/node_modules/pkg/CLAUDE.md", old_string: "a", new_string: "b" })],
  ["AGENT_GUIDE.md（非 AGENTS.md，不该误命中）", ptu("Edit", { file_path: "D:/frank/windsurf-dao/AGENT_GUIDE.md", old_string: "a", new_string: "b" })],
  ["skills（调用时读盘，不受快照病影响）", ptu("Edit", { file_path: "D:/frank/windsurf-dao/ccswitch/skills/dao-loop/SKILL.md", old_string: "a", new_string: "b" })],
  ["docs/specs 普通文档", ptu("Write", { file_path: "D:/frank/mousse-cli/docs/specs/foo-plan.md", content: "计划" })],
  ["PROGRESS.md 账本", ptu("Edit", { file_path: "D:/frank/mousse-cli/PROGRESS.md", old_string: "a", new_string: "b" })],
  ["非写入类工具 Read", ptu("Read", { file_path: RULES })],
  ["Bash 工具", { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "ls" }, transcript_path: "x" }],
  ["规则文件但工具报失败", ptu("Edit", { file_path: RULES, old_string: "a", new_string: "c" }, { tool_response: { success: false, error: "no match" } })],
  ["缺 file_path", ptu("Edit", { old_string: "a", new_string: "b" })],
];
for (const [name, payload] of NEG) {
  const r = run(payload);
  check(name + " → stdout 全空", r.out === "", "out=" + JSON.stringify(r.out.slice(0, 160)));
  if (r.out !== "") check(name + " → （附）stderr", r.err === "", "err=" + r.err.slice(0, 160));
}

console.log("\n=== 负态·逐名：EXCLUDE 名单上每个名字都要有行为样本 ===");
// 为什么必须逐名（复抗实测 G5，2026-08-10）：hook 的 EXCLUDE 有 9 个名字，而上面那张负态表
// 的**行为样本**只覆盖其中 2 个（`_tmp` / `node_modules`）⇒ 任何只在另外 7 个名字上开口子的
// **应用点**偏差全套零检出——字面一字不改（`driftOfExcludeLiteral()` 那道对账两条全绿），
// 只改「怎么用这个正则」（实测那一个：`EXCLUDE.test(norm) && !/\/coverage\//i.test(norm)`），
// 74 条一条不红。**对账管的是「两份名单一样吗」，管不到「这份名单真的在拦人吗」。**
// 名单从**本测试这份副本的源码字面**里现拆，不手写第二份清单（手写的枚举必过期，本仓已被咬过
// 三次；dao `[#守-清单派生]`）；hook 那份与它逐字相同由上面那道对账保 ⇒ 派生链是
// hook 的 EXCLUDE →（对账）→ 本测试的副本 →（现拆）→ 逐名样本，中间没有一处手抄。
// 上面那张表里 `_tmp` / `node_modules` 两行**刻意留着**，不算冗余：它们是**零解析**的地板——
// 万一下面这段拆名字的正则哪天瞎了，还有两条不依赖任何解析的样本在。
const EXCLUDED_NAMES = (() => {
  const m = /\(\^\|\\\/\)\(([^)]+)\)\\\//.exec(EXCLUDED_DIR_NAMES.source);
  return m ? m[1].split("|").map((s) => s.replace(/\\/g, "")).filter(Boolean) : [];
})();
// 拆不出来 ⇒ 判红。否则这一整段会退化成「零个样本全过」，而那与「全都守住了」长得一模一样。
check("逐名负态·排除名单拆得出来（拆不出 ⇒ 这一段本次一个样本都没跑，不许静默）",
  EXCLUDED_NAMES.length > 0, `拆到 ${EXCLUDED_NAMES.length} 个 · source=${EXCLUDED_DIR_NAMES.source}`);
// 误伤反例（`[#官实-误伤反例]`）：同一形状、只把目录名换成不在名单里的 ⇒ hook 必须开口。
// 它同时证明下面那些「全空」不是因为这个形状本身就不像规则文件（否则整段是废话）。
{
  const r = run(ptu("Write", { file_path: "D:/frank/mousse-cli/zz-not-excluded/pkg/CLAUDE.md", content: "# 项目铁律\n- 逐名负态的误伤反例\n" }));
  check("逐名负态·误伤反例：同形状但目录名不在排除面 → 仍命中并回灌",
    ctx(r).includes("逐名负态的误伤反例"), ctx(r).slice(0, 200));
}
for (const dirName of EXCLUDED_NAMES) {
  const p = `D:/frank/mousse-cli/${dirName}/pkg/CLAUDE.md`;
  const r = run(ptu("Write", { file_path: p, content: "# 假规则\n- 不该被回灌\n" }));
  check(`逐名负态·\`${dirName}/\` 下的 CLAUDE.md → stdout 全空`, r.out === "",
    `path=${p} · out=${JSON.stringify(r.out.slice(0, 160))}`);
}

console.log("\n=== 错误可见性：出错必须留痕，且不取阻断语义 ===");
{
  const r = run("这不是 JSON{{{");
  check("坏 stdin → stderr 有痕", /\[dao-rule-echo\].*失败/.test(r.err), "err=" + JSON.stringify(r.err));
  check("坏 stdin → systemMessage 用户可见", !!(r.json && r.json.systemMessage), "out=" + r.out.slice(0, 200));
  check("坏 stdin → 不阻断（exit 0）", r.code === 0, "code=" + r.code);
  check("坏 stdin → 不冒充回灌", !(r.json && r.json.hookSpecificOutput));
}
{
  const r = run(ptu("Edit", { file_path: RULES, old_string: "a", new_string: NEW_CLAUSE }), { DAO_RULE_ECHO_FORCE_ERROR: "1" });
  check("内部故障闸 → stderr 有痕", /\[dao-rule-echo\].*失败/.test(r.err), "err=" + JSON.stringify(r.err));
  check("内部故障闸 → systemMessage 用户可见", !!(r.json && r.json.systemMessage));
  check("内部故障闸 → exit 0 不阻断", r.code === 0, "code=" + r.code);
  check("内部故障闸 → 未静默（stdout+stderr 至少一处有内容）", r.out !== "" || r.err !== "");
}

// ── P2 作用域档：`paths:` 规则不得被说成「常驻注入」──────────────────────────
// 为什么必须落盘造夹具：readScopeGlobs 刻意**读盘**而不是看本次写入载荷——Edit 只带改动段，
// frontmatter 多半不在里面。拿载荷断言等于验了另一条路径，会对真实缺陷失明。
// 夹具落点由 `pickFixtureRoot()` 挑（**不能落在 hook 的 EXCLUDE 面里**：`_tmp` / `build` /
// `coverage` / … 这些目录名下的文件会被直接判为「非规则文件」，测试变成永远为真的废话）。
// 🔴 那个约束**不只管相对位置，也管整棵树坐落在哪** —— 本行原先只写了「不能放 `_tmp/`」，
// 于是把树 checkout 到 `<repo>/_tmp/xxx` 就原样重演了同一个坑（issue #253）。
// 目录名与下面两个用户级夹具名都带 UNIQ 后缀，理由见文件头「夹具隔离」段。
console.log("\n=== P2 作用域档：有 paths ⇒ 作用域注入，无 paths ⇒ 常驻 ===");
// 前置自检（issue #253）：先证明「我挑落点的那把尺子」两个方向都有判别力，再证明「我真挑到了
// 一个 hook 看得见的落点」。分三条报，是为了让「树摆错地方」与「hook 被改坏了」长得不一样。
check("落点判据·正控：排除面下的夹具路径被拒",
  EXCLUDED_DIR_NAMES.test("D:/frank/windsurf-dao/_tmp/wt/tests/.fixtures-scope-1/.claude/rules/scoped.md"));
check("落点判据·负控：形似而不该拒的放行（`coverage-x` 不是 `coverage`）",
  !EXCLUDED_DIR_NAMES.test("D:/frank/windsurf-dao/.claude/worktrees/coverage-x/wt/tests/.fixtures-scope-1/.claude/rules/scoped.md"));
// 上面两条只查**本测试自己这份副本**，读不到 hook 那一份 ⇒ 漂移由下面两条对账管（见 `driftOfExcludeLiteral()` 头注）。
{
  const d = driftOfExcludeLiteral();
  check("落点判据·两份 EXCLUDE 副本的字面都还抽得出来（声明形状没被改）", d.extracted, d.why);
  check("落点判据·hook 的 EXCLUDE 与本测试的副本逐字相同（没漂移）", d.same, d.why);
}
// ⚠️ 下面三条喂的是**全合成输入**（`baseDir` 与 `tmpDir` 都是硬编码），因此可以直接问
// 「挑中了哪一个候选」，而与这台机器的 `%TEMP%` 落在哪彻底无关——参数化的来龙去脉见
// `pickFixtureRoot()` 头注。三条各管一件事：退得出去 / 退不出去时老实认 / 不为了保险一律外挂。
// 🔴 **只查 `kind` 不够**（复抗实测 P4「名实脱节」：标签照报 `tmpdir`、`dir` 却仍留在排除面内
// ⇒ 全套零红）。真出事时的后果是夹具又落回排除面、10 条业务红原样回来，而断言查的只是标签。
// 故 `rootOk()` 同时查两件事：**名实相符**（`dir` 真在给定的那个根下）与**真的逃出来了**
// （拿 `dir` 拼出的完整夹具路径不命中排除面——那才是本函数唯一的承诺）。
const rootOk = (r, expectKind, expectUnder) => {
  if (!r || r.kind !== expectKind) return false;
  const dir = r.dir.replace(/\\/g, "/");
  const under = expectUnder.replace(/\\/g, "/").replace(/\/+$/, "") + "/";
  const fixture = path.join(r.dir, ".claude", "rules", "scoped.md").replace(/\\/g, "/");
  return dir.startsWith(under) && !EXCLUDED_DIR_NAMES.test(fixture);
};
const pickExcluded = pickFixtureRoot("D:/x/_tmp/wt/tests", "C:/Temp");
const pickBothOut = pickFixtureRoot("D:/x/_tmp/wt/tests", "C:/build/tmp");
const pickNormal = pickFixtureRoot("D:/x/tests", "C:/Temp");
check("落点挑选·树坐落在排除面里 ⇒ 退到临时目录（kind 与 dir 名实相符、落点真的不在排除面里）",
  rootOk(pickExcluded, "tmpdir", "C:/Temp"), JSON.stringify(pickExcluded));
check("落点挑选·两个候选都在排除面里 ⇒ 老实返回 null（不硬凑一个落在排除面的落点）",
  pickBothOut === null, JSON.stringify(pickBothOut));
check("落点挑选·树在正常位置 ⇒ 仍优先仓内根（不为了保险一律外挂）",
  rootOk(pickNormal, "repo", "D:/x/tests"), JSON.stringify(pickNormal));

const PICKED = pickFixtureRoot();
check("挑得到一个不落在 hook 排除面里的夹具根", PICKED !== null,
  `__dirname=${__dirname} · os.tmpdir()=${os.tmpdir()} —— 两个候选根都命中排除面，P2 段本次整段未跑`);
if (PICKED) {
  if (PICKED.kind !== "repo") {
    console.log(`  ⓘ 本棵树坐落在 hook 的排除面内，夹具根改用${PICKED.label}：${PICKED.dir}`);
  }
  const FIX_ROOT = PICKED.dir;
  const FIX = path.join(FIX_ROOT, ".claude", "rules");
  const userFix = path.join(USER_RULES_DIR, `${FIXTURE_PREFIX}userlevel-${UNIQ}.md`);
  sweepStaleFixtures();
  fs.mkdirSync(FIX, { recursive: true });

  const write = (name, body) => { const p = path.join(FIX, name); fs.writeFileSync(p, body, "utf8"); return p.replace(/\\/g, "/"); };

  try {
    // ① 块式 paths
    const scoped = write("scoped.md", '---\npaths:\n  - "**/*.ps1"\n  - "**/check-*.mjs"\n---\n\n正文\n');
    let r = run(ptu("Edit", { file_path: scoped, old_string: "a", new_string: "作用域条款 A" }));
    check("有 paths → 文案出现「作用域注入」", /作用域注入/.test(ctx(r)), ctx(r).slice(0, 300));
    // 注意断言写法：不能直接 `!/常驻注入/`——正文里写着「**不常驻注入**」，
    // 那样写会把「正确地否认了常驻」误判为「仍在宣称常驻」。要测的是**主张**不是字串：
    check("有 paths → 明确否认常驻", /\*\*不常驻注入\*\*/.test(ctx(r)), ctx(r).slice(0, 300));
    check("有 paths → 不再挂 always-on 快照那套说辞",
      !/always-on 规则是会话启动时快照注入的/.test(ctx(r)));
    check("有 paths → 列出匹配面 glob", /\*\*\/\*\.ps1/.test(ctx(r)) && /check-\*\.mjs/.test(ctx(r)));
    check("有 paths → 提示需部署才被宿主扫描", /dao-rules-deploy/.test(ctx(r)));
    check("有 paths → 仍回灌本次写入原文", ctx(r).includes("作用域条款 A"));
    check("有 paths → exit 0", r.code === 0, "code=" + r.code);

    // ② 行内数组式 paths
    const inline = write("inline.md", '---\npaths: ["src/**", "docs/**"]\n---\n\n正文\n');
    r = run(ptu("Write", { file_path: inline, content: "行内数组 B" }));
    check("行内数组 paths → 也判为作用域", /作用域注入/.test(ctx(r)));
    check("行内数组 paths → glob 去引号后列出", /src\/\*\*/.test(ctx(r)) && /docs\/\*\*/.test(ctx(r)));

    // ③ 无 paths 的项目规则 —— 原文案必须原样保留（防「一改就全改」的过度收割）
    const plain = write("plain.md", "# 无 frontmatter 的项目规则\n\n正文\n");
    r = run(ptu("Edit", { file_path: plain, old_string: "a", new_string: "常驻条款 C" }));
    check("无 paths → 仍说「常驻注入」", /常驻注入/.test(ctx(r)), ctx(r).slice(0, 200));
    check("无 paths → 不误报为作用域", !/作用域注入/.test(ctx(r)));
    check("无 paths → 仍回灌原文", ctx(r).includes("常驻条款 C"));

    // ④ frontmatter 存在但没有 paths 键（只有别的键）⇒ 不算作用域
    const other = write("otherfm.md", "---\ndescription: 某说明\n---\n\n正文\n");
    r = run(ptu("Edit", { file_path: other, old_string: "a", new_string: "条款 D" }));
    check("frontmatter 无 paths 键 → 不判为作用域", !/作用域注入/.test(ctx(r)));
    // 上面那条是**否定式**，hook 对这一形态静默时它照绿。这一整类输入此前只有它一条守着
    // ⇒ 让 hook **只**对 case ④ 静默，全套一条不红（PR #263 对抗实测 H7，零检出）。
    // 补两条正控把那个洞关掉——比给全部否定式各配前置守卫便宜，且打的是真洞。
    check("frontmatter 无 paths 键 → 仍说「常驻注入」（正控：hook 确实开口了）", /常驻注入/.test(ctx(r)), ctx(r).slice(0, 200));
    check("frontmatter 无 paths 键 → 仍回灌原文（正控）", ctx(r).includes("条款 D"), ctx(r).slice(0, 200));

    // ⑤ 文件读不到（已删）⇒ 降级为原文案，且**不得吞掉回灌本身**
    const ghost = path.join(FIX, "ghost.md").replace(/\\/g, "/");
    r = run(ptu("Edit", { file_path: ghost, old_string: "a", new_string: "幽灵条款 E" }));
    check("读盘失败 → 降级不崩", r.code === 0, "code=" + r.code);
    check("读盘失败 → 回灌仍在", ctx(r).includes("幽灵条款 E"));

    // ⑥ 用户级 ~/.claude/rules 且无 paths ⇒ 必须告知「实测 subagent 3/3 未收到」
    fs.mkdirSync(path.dirname(userFix), { recursive: true });
    fs.writeFileSync(userFix, "# 用户级无 paths 夹具\n", "utf8");
    r = run(ptu("Edit", { file_path: userFix.replace(/\\/g, "/"), old_string: "a", new_string: "用户级条款 F" }));
    check("用户级无 paths → 给出未送达警告", /3\/3/.test(ctx(r)), ctx(r).slice(0, 300));
    check("用户级无 paths → 不谎称常驻注入", !/常驻注入/.test(ctx(r)));
    check("用户级无 paths → 仍回灌原文", ctx(r).includes("用户级条款 F"));

    // ⑦ 用户级但**有** paths ⇒ 走作用域分支（优先级：scoped 高于 userLevel）
    const userScoped = path.join(USER_RULES_DIR, `${FIXTURE_PREFIX}userscoped-${UNIQ}.md`);
    fs.writeFileSync(userScoped, '---\npaths:\n  - "**/*.ps1"\n---\n\n正文\n', "utf8");
    try {
      r = run(ptu("Edit", { file_path: userScoped.replace(/\\/g, "/"), old_string: "a", new_string: "用户级作用域 G" }));
      check("用户级有 paths → 走作用域分支而非未送达警告", /作用域注入/.test(ctx(r)) && !/3\/3/.test(ctx(r)));
    } finally { try { fs.unlinkSync(userScoped); } catch (_) {} }
  } finally {
    // 夹具必须清干净：残留在 ~/.claude/rules/ 下的文件会被宿主当真规则扫描。
    // 只删自己这一份（名字带 UNIQ）——绝不按前缀批删，那正是 issue #82 的病根。
    try { fs.unlinkSync(userFix); } catch (_) {}
    try { fs.rmSync(FIX_ROOT, { recursive: true, force: true }); } catch (_) {}
  }
}

console.log(`\n=== 汇总: PASS=${pass} FAIL=${fail} ===`);
process.exit(fail ? 1 : 0);
