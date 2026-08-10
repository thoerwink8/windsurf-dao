// dao-design-sync-gate hook 回归网 — 正负控 + once-latch 两态 + fail-open + 双向 mutation
//
// 跑法：node tests/design-sync-gate.tests.js   （全绿 exit 0，任一红 exit 1）
//
// ── 这份回归网在防什么 ──────────────────────────────────────────────────────
// 被测对象是一个**会 block 的 Stop hook**，而宿主侧**没有连续 block 的上限**
// （cli.js 2.1.76 实读：blockingErrors 非空即 `continue`，裸 `while(!0)`，无计数器）。
// ⇒ 这里最贵的两类错是对称的：
//   · **该拦没拦**（漏报）——门控退回文字层，等于这次改造白做；
//   · **不该拦却拦了 / 拦了不止一次**（滥报）——最坏后果是会话卡死。
// 所以每一条正控都配一条形似的负控，且 once-latch 的**两态**（第一次拦、第二次不拦）
// 都单独断言 —— 只测「能拦」不算完成。
//
// ── 判据是近似的，别把全绿读成「它分得清一切」──────────────────────────────
// 已知两侧盲区（源码头注同款，此处只列会影响读断言的那几条）：
//   · JSX 检测是正则：模板字符串里的假 JSX 会误判为真；`React.createElement` 写法会漏。
//   · 「已同步」的判据是「本轮改动里有没有 design/**」，是代理不是判定：
//     为别的原因动 design/ ⇒ 漏报；上个会话已同步并入主干 ⇒ 可能多响一次。
//   · dao.md 写的是 `.tsx`，本 hook 就只认 `.tsx`；`.jsx`/`.vue`/`.svelte` 明知在射程外。
// 这些**刻意不补**：本批是把 dao.md 那段判据搬到 agent 之外，不是改判据。
//
// ── 一条测试卫生：所有用例强制 DAO_DESIGN_SYNC_GATE_SELFTEST=1 ───────────────
// 否则本文件喂进去的每一次调用都会在 hook 的 fired.log 里写一条**非 synthetic** 心跳，
// 把 `--selfcheck` 的第二段染绿（它据此宣称「已被宿主真实调用过」）。
// 那正是 hook-selfcheck.js 头注点名要防的那种假绿，而制造它的最容易的人就是这份测试。

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const REPO = path.resolve(__dirname, "..");
const HOOK = path.join(REPO, "ccswitch", "hooks", "dao-design-sync-gate.js");
const LIB = path.join(REPO, "ccswitch", "lib", "hook-selfcheck.js");
const TMP = path.join(REPO, "_tmp", "design-sync-gate-tests");

fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? "  →  " + detail : ""}`); }
}

// ── 夹具：真 git 仓 ─────────────────────────────────────────────────────────
// 用真 git 而不是 mock：被测判据整段建立在 `git diff` / `git ls-files` 的真实语义上
// （尤其「git diff <主干> 比的是主干树 vs 工作区」与「--others 才看得见未跟踪文件」这两条），
// mock 掉它们等于把要验的东西换成自己的假设。
function g(dir, args, allowFail) {
  const r = spawnSync("git", ["-C", dir].concat(args), { encoding: "utf8", windowsHide: true });
  if (!allowFail && r.status !== 0) {
    throw new Error(`git ${args.join(" ")} @${dir} → exit ${r.status}\n${r.stdout}\n${r.stderr}`);
  }
  return String(r.stdout || "");
}

function writeFiles(dir, files) {
  for (const [rel, content] of Object.entries(files || {})) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, "utf8");
  }
}

/**
 * @param {object} spec
 *   base        {rel: content}  基线文件，提交到 main
 *   branch      string|null     非空则切到该分支（Loop/worktree 场景）
 *   then        {rel: content}  基线之后的改动
 *   commitThen  boolean         then 是否提交（false ⇒ 留在工作区/未跟踪）
 *   noGit       boolean         不 git init（测「不是 git 仓」）
 */
function mkRepo(name, spec) {
  const dir = path.join(TMP, "repo-" + name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  writeFiles(dir, spec.base || {});
  if (spec.noGit) return dir;

  g(dir, ["init", "-b", "main", "-q"]);
  g(dir, ["config", "user.email", "t@example.invalid"]);
  g(dir, ["config", "user.name", "test"]);
  g(dir, ["config", "commit.gpgsign", "false"]);
  g(dir, ["add", "-A"]);
  g(dir, ["commit", "-q", "-m", "base"]);

  if (spec.branch) g(dir, ["checkout", "-q", "-b", spec.branch]);
  writeFiles(dir, spec.then || {});
  if (spec.commitThen) {
    g(dir, ["add", "-A"]);
    g(dir, ["commit", "-q", "-m", "work"]);
  }
  return dir;
}

// ── 跑一次 hook ────────────────────────────────────────────────────────────
const EMPTY_OD_BASE = path.join(TMP, "od-base-empty");
fs.mkdirSync(EMPTY_OD_BASE, { recursive: true });

// ── 子进程 cwd 必须钉死（issue #144 普查命中的那一处，2026-08-08 修）───────────────
// 本文件绝大多数用例靠 payload 里的 `cwd` 决定被测目录，**但 `opts.rawInput` 那几路绕开了
// payload**（尤其「缺字段 fail-open」那条：payload 只有 `hook_event_name`）。此时 hook 走
// `input.cwd || process.cwd()` 退到**跑测试的那个目录** ⇒ 断言的红绿由「在哪个目录敲命令」决定。
// 2026-08-08 实测坐实（探针 `_tmp/probe-144.mjs`，两条件都满足的沙箱仓 vs 空目录）：
//     bare payload + 子进程 cwd = 空目录  ⇒ decision 不 block（今天绿）
//     bare payload + 子进程 cwd = 热仓    ⇒ **decision:block**（同一条断言当场红）
// ⇒ 钉一个**结构上恒不满足触发条件**的中立目录：非 git 仓、无 design/**、无 .tsx。
// **刻意不钉仓根**：仓根今天恰好也不满足，但那是「碰巧」不是「结构」——而 #144 讲的正是
// 「危害通道随时可能被打开，打开的那一刻不需要碰这些站点一个字」。
const NEUTRAL_CWD = path.join(TMP, "neutral-cwd");
fs.mkdirSync(NEUTRAL_CWD, { recursive: true });

let stateSeq = 0;
function run(dir, opts = {}) {
  const payload = Object.assign({
    session_id: opts.session || "s-default",
    transcript_path: path.join(TMP, "fake-transcript.jsonl"),
    cwd: dir,
    permission_mode: "default",
    hook_event_name: "Stop",
    stop_hook_active: opts.reentry === true,
    last_assistant_message: "done",
  }, opts.extra || {});

  const env = Object.assign({}, process.env, {
    DAO_DESIGN_SYNC_GATE_SELFTEST: "1",
    DAO_DESIGN_SYNC_GATE_STATE: opts.state || path.join(TMP, "latch-" + (stateSeq++) + ".json"),
    DAO_DESIGN_SYNC_GATE_OD_BASE: opts.odBase || EMPTY_OD_BASE,
  }, opts.env || {});
  delete env.DAO_DESIGN_SYNC_GATE_FORCE_ERROR;
  if (opts.forceError) env.DAO_DESIGN_SYNC_GATE_FORCE_ERROR = opts.forceError; // "1"=parse 阶段 / "main"=外层 catch

  const r = spawnSync(process.execPath, [opts.script || HOOK], {
    input: opts.rawInput !== undefined ? opts.rawInput : JSON.stringify(payload),
    encoding: "utf8", env, windowsHide: true,
    cwd: opts.spawnCwd || NEUTRAL_CWD,   // ← issue #144：见上面 NEUTRAL_CWD 那段
  });
  const raw = String(r.stdout || "");
  let out = null;
  try { out = raw.trim() ? JSON.parse(raw) : null; } catch (_) { out = null; }
  return { code: r.status, out, raw, err: String(r.stderr || "") };
}

const blocked = (res) => !!(res.out && res.out.decision === "block");
const silent = (res) => res.raw.trim() === "";

const HTML = "<!doctype html><html><body><main>proto</main></body></html>";
const TSX_JSX = "export const Card = () => <div className=\"c\">hi</div>;\n";
const TSX_NOJSX = "export const n: number = 1;\nexport function f(a: number) { return a + 1; }\n";

console.log("\n──── ① 正控：两条件都满足 → block 一次 ────");
{
  // (a) Loop/worktree 场景：分支上提交了一个含 JSX 的 .tsx（不在 components/ 下）
  const a = mkRepo("pos-branch-tsx", {
    base: { "design/pages/home.html": HTML, "README.md": "x" },
    branch: "feat/ui", commitThen: true,
    then: { "src/ui/Card.tsx": TSX_JSX },
  });
  const ra = run(a, { session: "s-a" });
  check("分支上改 .tsx(含 JSX) + 有 design/**/*.html → decision:block", blocked(ra), JSON.stringify(ra.raw.slice(0, 200)));
  check("reason 里给得出证据（命中了哪些文件）", blocked(ra) && /src\/ui\/Card\.tsx/.test(ra.out.reason), JSON.stringify((ra.out || {}).reason || "").slice(0, 200));
  check("reason 里给得出下一步（同步原型 / /dao-design sync）",
    blocked(ra) && /dao-design sync/.test(ra.out.reason) && /CONTEXT\.md/.test(ra.out.reason));
  check("reason 里自陈「只拦这一次」（否则读者会以为撞上了死循环）",
    blocked(ra) && /只拦这一次/.test(ra.out.reason));
  check("退出码恒 0（block 走 stdout 的 decision，不走 exit 2）", ra.code === 0, `exit=${ra.code}`);
  check("block 时不越权带 continue:false（那会中止整轮，不是本门要的语义）",
    blocked(ra) && ra.out.continue === undefined);

  // (b) 主干工作区场景：未跟踪的新组件文件（git diff 看不见，只有 --others 看得见）
  const b = mkRepo("pos-main-untracked", {
    base: { "design/pages/home.html": HTML, "README.md": "x" },
    branch: null, commitThen: false,
    then: { "src/ui/New.tsx": TSX_JSX },
  });
  check("主干上新建未跟踪 .tsx → 照样 block（--others 那一路真的在起作用）",
    blocked(run(b, { session: "s-b" })));

  // (c) components/ 段命中（与扩展名无关，照 dao.md 字面）
  const c = mkRepo("pos-components-dir", {
    base: { "design/pages/home.html": HTML, "README.md": "x" },
    branch: "feat/c", commitThen: true,
    then: { "src/components/thing.ts": "export const t = 1;\n" },
  });
  check("components/ 段命中（.ts 无 JSX 也算，dao.md 字面如此）", blocked(run(c, { session: "s-c" })));

  // (d) 递归遍历这一路够不着、但 index 里有 → fallback `git ls-files` 那一路
  //
  // ⚠ 这个夹具换过一次，换的理由值得记：**第一版用「把盘上的 .html 删掉」来制造
  // 「只有 index 里有」，而那样构造不出来** —— 删除本身就是一次 `design/` 改动，
  // 于是「已同步」判据先命中，门根本不会响。**在这个 hook 里，「design/*.html 从盘上
  // 消失」这个场景永远走不到 block**，因为那个消失自己就是 design/ 的改动。
  // ⇒ fallback 真正的用武之地是**遍历侧因为别的原因看不见它**：这里用的是
  // `design/dist/`（`dist` 在 WALK_SKIP 里，为性能跳过），此外还有深度超 WALK_MAX_DEPTH、
  // design/ 读权限不足、design 是个符号链接等。这条断言同时钉住两件事：
  // ①fallback 这条路真的可达 ②跳过 `dist` 造成的盲区确实被 fallback 兜住了。
  const d = mkRepo("pos-fallback-lsfiles", {
    base: { "design/dist/index.html": HTML, "README.md": "x" },
    branch: "feat/d", commitThen: true,
    then: { "src/ui/Card.tsx": TSX_JSX },
  });
  check("递归遍历跳过了 design/dist/ 但 index 里有 → fallback `git ls-files 'design/*.html'` 命中（pathspec 跨子目录）",
    blocked(run(d, { session: "s-d" })));
}

console.log("\n──── ② 负控：形似但不该拦 ────");
{
  const negatives = [];

  negatives.push(["没有 design/ 目录 → 零输出（最便宜的判别器，绝大多数仓走这条）",
    mkRepo("neg-no-design", {
      base: { "README.md": "x" }, branch: "feat/x", commitThen: true,
      then: { "src/ui/Card.tsx": TSX_JSX },
    })]);

  negatives.push(["有 design/ 但零 .html（只有 md）→ 零输出",
    mkRepo("neg-no-html", {
      base: { "design/notes.md": "# 设计笔记", "README.md": "x" }, branch: "feat/x", commitThen: true,
      then: { "src/ui/Card.tsx": TSX_JSX },
    })]);

  negatives.push(["有设计稿但本轮没改 UI（只改 README）→ 零输出",
    mkRepo("neg-no-ui", {
      base: { "design/pages/home.html": HTML, "README.md": "x" }, branch: "feat/x", commitThen: true,
      then: { "README.md": "changed" },
    })]);

  negatives.push([".tsx 但里面没有 JSX → 不算 UI 组件 → 零输出",
    mkRepo("neg-tsx-no-jsx", {
      base: { "design/pages/home.html": HTML, "README.md": "x" }, branch: "feat/x", commitThen: true,
      then: { "src/ui/util.tsx": TSX_NOJSX },
    })]);

  negatives.push(["改了 UI 但同轮也动了 design/ → 判为已同步 → 零输出",
    mkRepo("neg-already-synced", {
      base: { "design/pages/home.html": HTML, "README.md": "x" }, branch: "feat/x", commitThen: true,
      then: { "src/ui/Card.tsx": TSX_JSX, "design/pages/home.html": HTML + "<!-- synced -->" },
    })]);

  negatives.push(["不是 git 仓 → 零输出",
    mkRepo("neg-not-git", { noGit: true, base: { "design/pages/home.html": HTML } })]);

  negatives.push(["零改动的干净仓 → 零输出",
    mkRepo("neg-clean", { base: { "design/pages/home.html": HTML, "src/ui/Card.tsx": TSX_JSX } })]);

  let i = 0;
  for (const [name, dir] of negatives) {
    const r = run(dir, { session: "s-neg-" + (i++) });
    check("负控：" + name, silent(r) && r.code === 0, `exit=${r.code} raw=${JSON.stringify(r.raw.slice(0, 160))}`);
  }

  // subagent：正常走 SubagentStop 收不到，真收到也要放行
  const sub = mkRepo("neg-subagent", {
    base: { "design/pages/home.html": HTML, "README.md": "x" }, branch: "feat/x", commitThen: true,
    then: { "src/ui/Card.tsx": TSX_JSX },
  });
  check("负控：输入带 agent_id（subagent）→ 零输出，绝不拦 subagent 收尾",
    silent(run(sub, { session: "s-sub", extra: { agent_id: "ag-1", agent_type: "general-purpose" } })));
  check("对照：同一个仓不带 agent_id 就会 block（证明上一条不是因为夹具本来就不响）",
    blocked(run(sub, { session: "s-sub-2" })));
}

console.log("\n──── ③ once-latch 两态 + stop_hook_active 官方锁 ────");
{
  const dir = mkRepo("latch", {
    base: { "design/pages/home.html": HTML, "README.md": "x" }, branch: "feat/x", commitThen: true,
    then: { "src/ui/Card.tsx": TSX_JSX },
  });
  const state = path.join(TMP, "latch-shared.json");

  const first = run(dir, { session: "s-latch", state });
  check("态一：同会话第一次 → block", blocked(first), JSON.stringify(first.raw.slice(0, 120)));

  const second = run(dir, { session: "s-latch", state });
  check("态二：同会话第二次 → **不** block（once-latch 生效）", !blocked(second), JSON.stringify(second.raw.slice(0, 160)));
  check("态二：降级到 stderr 并说明降级原因", /降级为不阻断/.test(second.err) && /once-latch/.test(second.err),
    JSON.stringify(second.err.slice(0, 200)));
  check("态二：stderr 里照直说这段话到不了模型（Stop 无 additionalContext 通道）",
    /到不了模型上下文/.test(second.err), JSON.stringify(second.err.slice(-160)));
  check("态三：同会话第三次仍不 block（不是只压了一次）", !blocked(run(dir, { session: "s-latch", state })));

  const other = run(dir, { session: "s-latch-other", state });
  check("换一个 session → 重新 block（latch 的粒度是「每会话每门」）", blocked(other));

  check("latch 真的落了盘，且两个 session 各记一条",
    (() => {
      try {
        const j = JSON.parse(fs.readFileSync(state, "utf8"));
        const keys = Object.keys(j);
        return keys.length === 2 && keys.every((k) => k.endsWith("::design-sync"));
      } catch (_) { return false; }
    })());

  // 官方 loop 锁：宿主在「上一轮是被 Stop hook 拦回来的」时置真
  const re = run(dir, { session: "s-reentry", reentry: true });
  check("stop_hook_active=true → 绝不 block（官方那把锁，与 latch 互相独立）", !blocked(re));
  check("stop_hook_active 降级时 stderr 点名是这把锁", /stop_hook_active=true/.test(re.err),
    JSON.stringify(re.err.slice(0, 200)));
  check("对照：同一 session 不置 stop_hook_active 就会 block（证明上一条不是夹具本来就不响）",
    blocked(run(dir, { session: "s-reentry-2" })));

  // latch 写不成 ⇒ 降级为不 block（与 dao-tool-nudge 的选择相反，见源码头注）
  {
    const badState = path.join(TMP, "latch-as-a-dir"); // 指向一个**目录**：读写必 EISDIR，跨平台稳定
    fs.mkdirSync(badState, { recursive: true });
    const r = run(dir, { session: "s-badstate", state: badState });
    check("latch 读/写不动 → **降级为不 block**（重复 block 会卡死会话，而宿主没有连续 block 上限）",
      !blocked(r) && r.code === 0, JSON.stringify(r.raw.slice(0, 160)));
    check("latch 坏掉时 stderr 自陈（否则本门就是静默失效）",
      /降级为不阻断/.test(r.err) && /latch/.test(r.err), JSON.stringify(r.err.slice(0, 200)));
  }
}

console.log("\n──── ④ fail-open：喂坏输入 / 注入故障都不许砖会话 ────");
{
  const dir = mkRepo("failopen", {
    base: { "design/pages/home.html": HTML, "README.md": "x" }, branch: "feat/x", commitThen: true,
    then: { "src/ui/Card.tsx": TSX_JSX },
  });

  const cases = [
    ["非 JSON 垃圾输入", { rawInput: "this is not json {{{" }],
    ["空 stdin", { rawInput: "" }],
    ["JSON 但不是对象", { rawInput: "\"a string\"" }],
    ["JSON 是数组", { rawInput: "[1,2,3]" }],
    // 两个注入点走的是**两条不同的路**，都要验（见源码里那段注释）：
    ["注入故障@parse 阶段（=1，走脚手架 fail()）", { forceError: "1" }],
    ["注入故障@主流程（=main，走文件末尾那个外层 catch）", { forceError: "main" }],
  ];
  for (const [name, opts] of cases) {
    const r = run(dir, Object.assign({ session: "s-fo" }, opts));
    check(`fail-open：${name} → exit 0`, r.code === 0, `exit=${r.code}`);
    check(`fail-open：${name} → 不产生 decision:block`, !blocked(r), JSON.stringify(r.raw.slice(0, 160)));
    check(`fail-open：${name} → 出错要出声（systemMessage 留痕，不静默吞）`,
      !!(r.out && typeof r.out.systemMessage === "string" && r.out.systemMessage.length > 0),
      JSON.stringify(r.raw.slice(0, 200)));
  }

  // 缺字段（宿主协议若变）不该崩：只给最小 payload
  const BARE = JSON.stringify({ hook_event_name: "Stop" });
  const bare = run(dir, { rawInput: BARE });
  check("fail-open：payload 只有 hook_event_name（无 cwd/session_id）→ 不崩、不 block",
    bare.code === 0 && !blocked(bare), `exit=${bare.code} raw=${JSON.stringify(bare.raw.slice(0, 120))}`);

  // 🔴 issue #144：上面那条断言**曾经**由「在哪个目录敲命令」决定红绿 —— payload 里没有 cwd，
  //    hook 退到 `process.cwd()`，而子进程 cwd 此前是继承来的。现在钉在 NEUTRAL_CWD 上。
  //    下面这条是它的**活的负控**：把子进程 cwd 换成一个两条件都满足的仓，同一份 bare payload
  //    **必须 block** —— 它同时证明两件事：㈠上面那条不是恒真 ㈡「退到 process.cwd()」是真的发生的，
  //    所以钉住 cwd 是承重的，不是装饰。
  //
  //    ~~（把 `cwd: opts.spawnCwd || NEUTRAL_CWD` 摘掉 ⇒ 这一条照旧绿、而上面那条的绿从此只是运气
  //    —— 这一格照直写：**没有断言能替你守住「别把 pin 删了」**。）~~
  //    🔴 **上面这句划掉的话指错了位置**（2026-08-08 PR #204 对抗验证实测订正）。写它的人跑过
  //    「摘 pin + 热仓」，却把「在仓根会怎样」**写成了断言而没跑**。对抗官把「摘掉」的三种读法都跑了：
  //      ①**整行删掉**（字面读法）        ⇒ 仓根 `exit=1 PASS=91 FAIL=1` · 热仓同 ⇒ **原句为假**
  //         为什么会红：这一行**同时是 `opts.spawnCwd` 的管道**，整行没了，下面那条活的负控
  //         自己就够不到热仓了 —— 红的是负控自己。
  //      ②**只摘兜底**（`cwd: opts.spawnCwd,`）⇒ 仓根 `exit=0 PASS=92 FAIL=0` · 热仓 `FAIL=1`
  //      ③**只打订正面**（`cwd: opts.spawnCwd || process.cwd()`）⇒ 仓根 **全绿 92/0，一条都不响**
  //    ⇒ **精确的说法**：没人守得住的不是「**这一行在不在**」，而是「**它钉的是不是一个结构上
  //    恒不满足触发条件的目录**」。把 `NEUTRAL_CWD` 换成 `process.cwd()`，全套 92 条一条都不响。
  //    ⇒ 要动这一行的人记住：**能动的是那半个兜底，不能动的是兜底指向哪。**
  const hotCwd = mkRepo("bare-cwd-fallback-hot", {
    base: { "design/pages/home.html": HTML, "README.md": "x" },
    branch: "feat/ui", commitThen: true,
    then: { "src/ui/Card.tsx": TSX_JSX },
  });
  const bareHot = run(dir, { rawInput: BARE, spawnCwd: hotCwd, state: path.join(TMP, "latch-bare-hot.json") });
  check("🔴 #144 活的负控：同一份无 cwd 的 payload，子进程 cwd 换成热仓 ⇒ 当场 block（退 process.cwd() 是真的）",
    blocked(bareHot), `exit=${bareHot.code} raw=${JSON.stringify(bareHot.raw.slice(0, 200))}`);
}

console.log("\n──── ⑤ OD 面板快照同步（附属分支，与 ①②③ 独立判）────");
{
  function odRepo(name, odCfg, extraThen) {
    const base = { "design/pages/home.html": HTML, "README.md": "x" };
    if (odCfg !== null) base["design/.od-sync.json"] = odCfg;
    return mkRepo(name, {
      base, branch: "feat/d", commitThen: true,
      then: Object.assign({ "design/pages/home.html": HTML + "<!-- v2 -->" }, extraThen || {}),
    });
  }

  // (a) 正路：项目目录存在 → robocopy 增量同步，文件真的落地
  {
    const odBase = path.join(TMP, "od-a");
    fs.mkdirSync(path.join(odBase, "proj-a"), { recursive: true });
    const dir = odRepo("od-ok", JSON.stringify({ odProjectId: "proj-a" }));
    fs.mkdirSync(path.join(dir, "design", "sub"), { recursive: true });
    fs.writeFileSync(path.join(dir, "design", "sub", "deep.html"), HTML, "utf8");
    fs.writeFileSync(path.join(dir, "design", "page.artifact.json"), "{}", "utf8");
    const r = run(dir, { session: "s-od-a", odBase });
    check("OD 正控：design/ 有改动 + 有 .od-sync.json → 跑同步且报成功",
      /OD 快照已同步/.test(r.err), JSON.stringify(r.err.slice(0, 200)));
    check("OD 正控：子目录文件真的落地了（/E 递归）",
      fs.existsSync(path.join(odBase, "proj-a", "design", "sub", "deep.html")));
    check("OD 正控：*.artifact.json 被排除（/XF，否则会覆盖 OD 自己的元数据）",
      !fs.existsSync(path.join(odBase, "proj-a", "design", "page.artifact.json")));
    check("OD 正控：静默无感 —— 成功时不往 stdout 写任何东西（不打断收尾）", silent(r), JSON.stringify(r.raw.slice(0, 120)));
    check("OD 正控：exit 0", r.code === 0);
  }

  // (b) targetSubdir 自定义
  {
    const odBase = path.join(TMP, "od-b");
    fs.mkdirSync(path.join(odBase, "proj-b"), { recursive: true });
    const dir = odRepo("od-subdir", JSON.stringify({ odProjectId: "proj-b", targetSubdir: "MyDesign" }));
    run(dir, { session: "s-od-b", odBase });
    check("OD：targetSubdir 被采用（默认 design，此处改成 MyDesign）",
      fs.existsSync(path.join(odBase, "proj-b", "MyDesign", "pages", "home.html")));
  }

  // (c) 项目目录不存在 → 跳过且**不创建**（od-panel-sync.md §6 反模式 4）
  {
    const odBase = path.join(TMP, "od-c");
    fs.mkdirSync(odBase, { recursive: true });
    const dir = odRepo("od-missing", JSON.stringify({ odProjectId: "proj-nope" }));
    const r = run(dir, { session: "s-od-c", odBase });
    check("OD：项目目录不存在 → 报跳过", /OD 项目目录不存在/.test(r.err), JSON.stringify(r.err.slice(0, 200)));
    check("OD：**不盲建**那个目录（ID 错了就该报错，不是替它造一个）",
      !fs.existsSync(path.join(odBase, "proj-nope")));
    check("OD：跳过不算失败 → 不往 stdout 报 systemMessage", silent(r), JSON.stringify(r.raw.slice(0, 120)));
  }

  // (d) robocopy 真失败（>=8）→ 必须让人看见
  {
    const odBase = path.join(TMP, "od-d");
    fs.mkdirSync(path.join(odBase, "proj-d"), { recursive: true });
    fs.writeFileSync(path.join(odBase, "proj-d", "design"), "我是个文件不是目录", "utf8");
    const dir = odRepo("od-fail", JSON.stringify({ odProjectId: "proj-d" }));
    const r = run(dir, { session: "s-od-d", odBase });
    check("OD 失败：robocopy exit>=8 → 报失败（退出码判成败，不看输出文字）",
      /OD 快照同步失败/.test(r.err), JSON.stringify(r.err.slice(0, 240)));
    check("OD 失败：浮到 systemMessage 让人看见（静默滞后正是这个管线当初存在的理由）",
      !!(r.out && /OD 面板快照同步失败/.test(String(r.out.systemMessage || ""))), JSON.stringify(r.raw.slice(0, 240)));
    check("OD 失败：仍然 exit 0，不拿附属分支去砖收尾", r.code === 0);
  }

  // (e) 负控：design/ 没改动 → 附属分支根本不该跑
  {
    const odBase = path.join(TMP, "od-e");
    fs.mkdirSync(path.join(odBase, "proj-e"), { recursive: true });
    const dir = mkRepo("od-untouched", {
      base: { "design/pages/home.html": HTML, "design/.od-sync.json": JSON.stringify({ odProjectId: "proj-e" }), "README.md": "x" },
      branch: "feat/x", commitThen: true, then: { "src/ui/Card.tsx": TSX_JSX },
    });
    const r = run(dir, { session: "s-od-e", odBase });
    check("OD 负控：本轮没碰 design/ → 不跑同步", !/OD 快照/.test(r.err), JSON.stringify(r.err.slice(0, 200)));
    check("OD 负控：目标目录里什么都没多出来",
      !fs.existsSync(path.join(odBase, "proj-e", "design")));
    check("OD 负控：同一轮里设计同步门控照常 block（两个分支互不干扰）", blocked(r));
  }

  // (f) 负控：没有 .od-sync.json → 静默，没这回事
  {
    const odBase = path.join(TMP, "od-f");
    fs.mkdirSync(odBase, { recursive: true });
    const dir = odRepo("od-nocfg", null);
    const r = run(dir, { session: "s-od-f", odBase });
    check("OD 负控：没有 .od-sync.json → 一个字都不说", !/OD/.test(r.err) && silent(r), JSON.stringify(r.err.slice(0, 160)));
  }

  // (g) .od-sync.json 坏掉 / 缺 odProjectId → 说出来，不静默
  {
    const odBase = path.join(TMP, "od-g");
    fs.mkdirSync(odBase, { recursive: true });
    const broken = run(odRepo("od-broken", "{ 这不是 json "), { session: "s-od-g1", odBase });
    check("OD：.od-sync.json 解析失败 → 报出来", /解析失败/.test(broken.err), JSON.stringify(broken.err.slice(0, 200)));
    const noId = run(odRepo("od-noid", JSON.stringify({ targetSubdir: "x" })), { session: "s-od-g2", odBase });
    check("OD：缺 odProjectId → 报出来", /缺 odProjectId/.test(noId.err), JSON.stringify(noId.err.slice(0, 200)));
  }
}

console.log("\n──── ⑥ mutation · 双向判别力（含「变异体还活着」canary）────");
{
  // 变异体放 TMP 而不是 hooks/：不往源码目录扔临时文件（跑挂了会留在盘上，
  // 而 hooks/ 目录是 check-dead-gates 的孤儿扫描面，一个残留文件会被报成孤儿 hook）。
  // 代价是相对 require 失效 ⇒ 同批把它改写成绝对路径。
  const REQ_FROM = 'require("../lib/hook-selfcheck.js")';
  const REQ_TO = "require(" + JSON.stringify(LIB.replace(/\\/g, "/")) + ")";

  function mkMutant(name, from, to) {
    const src = fs.readFileSync(HOOK, "utf8");
    const hits = src.split(from).length - 1;
    check(`mutation 靶点「${name}」在源码里唯一存在`, hits === 1, `出现 ${hits} 次`);
    if (hits !== 1) return null;
    let out = src.replace(REQ_FROM, REQ_TO).replace(from, to);
    const p = path.join(TMP, "mutant-" + name + ".js");
    fs.writeFileSync(p, out, "utf8");
    return p;
  }

  // 夹具：JSX 那条路（.tsx，不在 components/ 下）与 components/ 那条路，两个独立仓
  const jsxRepo = mkRepo("mut-jsx", {
    base: { "design/pages/home.html": HTML, "README.md": "x" }, branch: "feat/x", commitThen: true,
    then: { "src/ui/Card.tsx": TSX_JSX },
  });
  const compRepo = mkRepo("mut-comp", {
    base: { "design/pages/home.html": HTML, "README.md": "x" }, branch: "feat/x", commitThen: true,
    then: { "src/components/thing.ts": "export const t = 1;\n" },
  });
  const syncedRepo = mkRepo("mut-synced", {
    base: { "design/pages/home.html": HTML, "README.md": "x" }, branch: "feat/x", commitThen: true,
    then: { "src/ui/Card.tsx": TSX_JSX, "design/pages/home.html": HTML + "<!-- synced -->" },
  });

  // 先确认变异前的基线（比较基线必须先验证它自己是活的）
  check("基线：JSX 仓在真 hook 上 block", blocked(run(jsxRepo, { session: "s-base-1" })));
  check("基线：components 仓在真 hook 上 block", blocked(run(compRepo, { session: "s-base-2" })));
  check("基线：已同步仓在真 hook 上静默", silent(run(syncedRepo, { session: "s-base-3" })));

  // ── 方向一「让门变松」：JSX 判据永不命中 ⇒ 正控必须从 block 掉成静默 ──
  {
    const m = mkMutant("jsx-never",
      "const JSX_RE = /<[A-Za-z][A-Za-z0-9._:-]*[\\s/>]|<\\/[A-Za-z]|<>/;",
      "const JSX_RE = /__NEVER_MATCHES__/;");
    if (m) {
      const after = run(jsxRepo, { session: "s-mut-1", script: m });
      check("mutation①(松)：JSX 判据改坏 → 正控从 block 掉成静默 ⇒ 那批断言真的在测这段判据",
        silent(after), JSON.stringify(after.raw.slice(0, 160)));
      // canary：变异体本身还活着（不是整个 hook 崩了 ⇒ 那样也会「静默」）
      const canary = run(compRepo, { session: "s-mut-1c", script: m });
      check("mutation① canary：变异体仍能对 components/ 那条路 block ⇒ 上一条的静默是判据变了，不是靶被弄死",
        blocked(canary), JSON.stringify(canary.raw.slice(0, 160)));
    }
  }

  // ── 方向二「让门变紧」：「已同步」判据永不命中 ⇒ 负控必须从静默翻成 block ──
  {
    const m = mkMutant("synced-never",
      'const isDesignPath = (rel) => rel === "design" || rel.startsWith("design/");',
      "const isDesignPath = (rel) => false && !!rel;");
    if (m) {
      const after = run(syncedRepo, { session: "s-mut-2", script: m });
      check("mutation②(紧)：「已同步」判据改坏 → 负控从静默翻成 block ⇒ 负控不是「反正它什么都不说」",
        blocked(after), JSON.stringify(after.raw.slice(0, 160)));
      const canary = run(mkRepo("mut-canary-nodesign", {
        base: { "README.md": "x" }, branch: "feat/x", commitThen: true, then: { "src/ui/Card.tsx": TSX_JSX },
      }), { session: "s-mut-2c", script: m });
      check("mutation② canary：变异体对「没有 design/ 目录」仍然静默 ⇒ 它没有退化成无条件 block",
        silent(canary), JSON.stringify(canary.raw.slice(0, 160)));
    }
  }

  // ── 方向三「结果不被消费」：latch 照写，但读的时候不看它 ──
  // 这一向验的不是「门在不在」，是「门的答案有没有人听」——latch 仍然落盘、
  // 仍然被 persist，只是判定时不消费，人工读码/看盘上状态都看不出异常。
  {
    const m = mkMutant("latch-ignored",
      "const latched = latch !== null && Object.prototype.hasOwnProperty.call(latch, key);",
      "const latched = (latch !== null && Object.prototype.hasOwnProperty.call(latch, key)) && false;");
    if (m) {
      const st = path.join(TMP, "latch-mut3.json");
      const first = run(jsxRepo, { session: "s-mut-3", state: st, script: m });
      const second = run(jsxRepo, { session: "s-mut-3", state: st, script: m });
      check("mutation③(结果不被消费)：latch 照写不照读 → 第二次又 block ⇒ once-latch 那两条断言真的在测判定，不只是在测「文件写没写」",
        blocked(first) && blocked(second), `first=${blocked(first)} second=${blocked(second)}`);
      check("mutation③ canary：变异体的 latch 文件仍然落了盘 ⇒ 它坏的是「读」不是「写」（这正是本向要证的：状态看着完全正常）",
        (() => { try { return Object.keys(JSON.parse(fs.readFileSync(st, "utf8"))).length === 1; } catch (_) { return false; } })());
    }
  }

  // ── 方向四：OD 退出码分界改松 ⇒ 失败用例必须从「失败」翻成「成功」──
  {
    const m = mkMutant("od-exit-loose",
      "function odExitOk(code) { return typeof code === \"number\" && code < 8; }",
      "function odExitOk(code) { return typeof code === \"number\" && code < 100; }");
    if (m) {
      const odBase = path.join(TMP, "od-mut");
      fs.mkdirSync(path.join(odBase, "proj-m"), { recursive: true });
      fs.writeFileSync(path.join(odBase, "proj-m", "design"), "file-not-dir", "utf8");
      const dir = mkRepo("od-mut-repo", {
        base: { "design/pages/home.html": HTML, "design/.od-sync.json": JSON.stringify({ odProjectId: "proj-m" }), "README.md": "x" },
        branch: "feat/d", commitThen: true, then: { "design/pages/home.html": HTML + "<!-- v2 -->" },
      });
      const after = run(dir, { session: "s-mut-4", odBase, script: m });
      check("mutation④：把 >=8 的分界改松 → 真实的 robocopy 16 被误报成成功 ⇒ 那条失败断言真的在测这个分界",
        /OD 快照已同步/.test(after.err) && !/同步失败/.test(after.err), JSON.stringify(after.err.slice(0, 200)));
    }
  }

  // ── 方向五：把 fail-open 的最终兜底摘掉 ⇒ 注入故障必须从 exit 0 变成崩 ──
  // 这一向验的是「④ 那批 fail-open 断言不是白写的」：如果没有外层 catch，
  // 一个主流程异常就会让 Stop hook 以非 0 退出码收场。**而那正是最危险的形态** ——
  // 一道每回合都跑、又会因自身 bug 报错的闸，没有任何逃生通道。
  {
    // 改法取「把 catch 里那个动作换成重抛」而不是「把 try/catch 整块删掉」：
    // 后者首版试过，`finally { if (false) {` 拼出来的括号对不上 ⇒ 变异体是**语法坏**的，
    // 于是 canary 也红。**那种红与「兜底被摘掉」在退出码上长得一模一样**，
    // 正是「先验变异体还活着」这条要防的：读红集之前先回答「这一版还跑得起来吗」。
    const m = mkMutant("no-failopen",
      'H.fail("设计同步门控主流程", e);',
      "throw e;");
    if (m) {
      const dir = mkRepo("mut-failopen", { base: { "README.md": "x" } });
      const after = run(dir, { session: "s-mut-5", script: m, forceError: "main" });
      check("mutation⑤：摘掉外层 catch → 注入故障后进程真的崩（exit≠0）⇒ fail-open 那批断言真的在测这个兜底",
        after.code !== 0, `exit=${after.code}`);
      const canary = run(dir, { session: "s-mut-5c", script: m });
      check("mutation⑤ canary：不注入故障时变异体仍正常 exit 0 ⇒ 上一条的崩是注入的那个异常，不是变异体本身语法坏了",
        canary.code === 0 && silent(canary), `exit=${canary.code} raw=${JSON.stringify(canary.raw.slice(0, 120))}`);
    }
  }
}

console.log("\n──── ⑦ --selfcheck：注册态与射程说明必须能被独立问一次 ────");
{
  // 这里**不断言本机是绿还是红** —— 那取决于用户注册了没有（注册是用户动作），
  // 而这份测试要在两种状态下都成立。断言的是**自检自身自洽**。
  const r = spawnSync(process.execPath, [HOOK, "--selfcheck"], { encoding: "utf8", windowsHide: true });
  const out = String(r.stdout || "");
  check("自检结论与退出码一致（有 ✗ 即 exit 1，全 ✓ 即 exit 0）",
    (/✗/.test(out) ? r.status === 1 : r.status === 0), `exit=${r.status} out=${JSON.stringify(out.slice(0, 200))}`);
  check("自检报注册面（hooks.Stop）", /hooks\.Stop|已注册于 Stop/.test(out), JSON.stringify(out.slice(0, 200)));
  check("自检点明 matcher 对 Stop 无效（别照 PostToolUse 的经验去担心）",
    /matcher 对 Stop 无效/.test(out), JSON.stringify(out.slice(-400)));
  check("自检点明收不到 subagent（SubagentStop 是另一个事件）", /SubagentStop/.test(out));
  check("自检点明 block 射程与 latch 路径", /每会话每门至多一次/.test(out) && /latch/.test(out));
  check("自检点明 Stop 没有 additionalContext 通道（降级路径够不到模型）",
    /additionalContext/.test(out) && /够不到模型/.test(out));
  check("自检不读 stdin，也不会因为没有 stdin 而挂住", typeof r.status === "number");
}

console.log(`\n=== 汇总: PASS=${pass} FAIL=${fail} ===`);
process.exit(fail ? 1 : 0);
