// dao-tool-nudge hook 回归网 — 五类提醒的正控 + 误伤负控
//
// 跑法：node tests/dao-tool-nudge.tests.js   （全绿 exit 0，任一红 exit 1）
//
// ── 为什么现在才有这个文件 ───────────────────────────────────────────────────
// 这个 hook 从建立起**一直零测试**。2026-08-01（dao 重塑批 C · C5）给它加了第二类命中
// （`gh pr merge` 裸用 → 提示走 canonical 脚本），而「往拦截/提示清单里加词条」正是本体系
// 明令要求配误伤负控的那类改动：**只证明「能命中」不算完成，护栏两侧的代价都是真代价。**
// 顺手把原有的三类工具选择提醒也补上双向断言——它们此前同样没有任何东西盯着。
//
// ── 判据是近似的，别把全绿读成「这个 hook 分得清一切」──────────────────────
// 命中判据是**段首正则**，已知两侧盲区：
//   · 漏报：`for r in $(...); do gh pr merge $r; done` 之类嵌套形态，段首不是 gh ⇒ 不提示；
//     环境变量前缀（`FOO=1 gh pr merge 1`）同理不提示。
//   · 误报：字符串字面量里出现的命令（`echo "gh pr merge 1"`）会被切成段后段首匹配失败，
//     所以这一例是负控；但 `x() { gh pr merge 1; }` 这种会命中。
// 这些盲区**刻意不补**：补它们要把 shell 语法真解析一遍，而本 hook 的定位是软提醒不是守卫，
// 误伤一次的代价（污染一次 context）高于漏报一次。写在这里是为了别让读者以为覆盖是完备的。

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const REPO = path.resolve(__dirname, "..");
const HOOK = path.join(REPO, "ccswitch", "hooks", "dao-tool-nudge.js");
// ④ 的去重状态落一份**测试专属**文件：用真状态会让「本机今天已经提醒过」把正控染绿，
// 而「结论取决于机器当时的状态」正是这份回归网要防的东西。每次开跑清空。
const TMP = path.join(REPO, "_tmp", "tool-nudge-tests");
const STATE = path.join(TMP, "browser-mcp-seen.json");
// maxRetries：⑤ 的夹具里有真的 .git 对象（Windows 下是只读文件），一次 rm 可能撞 EPERM。
fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
fs.mkdirSync(TMP, { recursive: true });

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? "  →  " + detail : ""}`); }
}

// 喂一次 PostToolUse 输入，返回注入的 additionalContext（没注入则空串）
function nudge(command, toolName = "Bash") {
  const input = JSON.stringify({ tool_name: toolName, tool_input: { command } });
  const r = spawnSync(process.execPath, [HOOK], { input, encoding: "utf8" });
  if (r.status !== 0) return { code: r.status, ctx: "", raw: r.stdout };
  let out = {};
  try { out = JSON.parse(r.stdout || "{}"); } catch (_) { /* 无输出即无提醒 */ }
  const hs = out.hookSpecificOutput || {};
  return { code: r.status, ctx: String(hs.additionalContext || ""), raw: r.stdout };
}

// ④ 专用：按工具名 + session_id 喂一次；可指定跑哪个脚本副本（mutation 用）与哪份状态文件
function mcpCall(toolName, sessionId, opts = {}) {
  const input = JSON.stringify({ tool_name: toolName, session_id: sessionId, tool_input: {} });
  const r = spawnSync(process.execPath, [opts.script || HOOK], {
    input, encoding: "utf8",
    env: Object.assign({}, process.env, { DAO_TOOL_NUDGE_STATE: opts.state || STATE }),
  });
  let out = {};
  try { out = JSON.parse(r.stdout || "{}"); } catch (_) {}
  const hs = out.hookSpecificOutput || {};
  return { code: r.status, ctx: String(hs.additionalContext || ""), raw: String(r.stdout || "") };
}

console.log("\n──── ① 工具选择提醒（既有职责，此前零测试）────");
{
  const cases = [
    ["grep -rn foo src/", /内置 Grep/],
    ["grep -n pattern ccswitch/dao.md", /内置 Grep/],
    ["find . -name '*.js'", /内置 Glob/],
    ["cat ccswitch/dao.md", /内置 Read/],
    ["head -n 50 scripts/run-tests.mjs", /内置 Read/],
  ];
  for (const [cmd, re] of cases) {
    check(`正控：${cmd}`, re.test(nudge(cmd).ctx), JSON.stringify(nudge(cmd).ctx.slice(0, 80)));
  }
  const negatives = [
    ["管道下游过滤不该提示", "ps aux | grep node"],
    ["git grep 豁免", "git grep -n foo"],
    ["管道下游 head 不该提示", "git log --oneline | head -20"],
    ["无文件参数的 find 不该提示", "find"],
  ];
  for (const [name, cmd] of negatives) {
    check(`负控：${name}`, nudge(cmd).ctx === "", JSON.stringify(nudge(cmd).ctx.slice(0, 80)));
  }
}

console.log("\n──── ② PR 合并链提醒（C5 新增）────");
{
  const positives = [
    ["裸用", "gh pr merge 42 --merge --delete-branch"],
    ["无参数", "gh pr merge"],
    ["多空格", "gh   pr   merge 7"],
    ["在 && 链的后一段", "git fetch && gh pr merge 42 --merge"],
    ["在 ; 链的后一段", "cd /d/repo; gh pr merge 42"],
  ];
  for (const [name, cmd] of positives) {
    const ctx = nudge(cmd).ctx;
    check(`正控：${name}`, /dao PR 合并链/.test(ctx) && /dao-pr-merge\.ps1/.test(ctx), JSON.stringify(ctx.slice(0, 80)));
  }

  const negatives = [
    ["走 canonical 脚本的正路不该提示", "pwsh -File ccswitch/scripts/dao-pr-merge.ps1 -PullRequest 42 -SkipVerify"],
    ["只读的 gh pr view 不该提示", "gh pr view 42 --json state"],
    ["gh pr list 不该提示", "gh pr list --state open"],
    ["gh pr create 不该提示", "gh pr create --title x --body-file b.md"],
    ["裸 git merge 不该提示（正当用法太多，刻意不认）", "git merge --no-edit origin/main"],
    ["裸 git fetch 不该提示", "git fetch --prune"],
    ["字符串字面量里的命令不该提示", 'echo "gh pr merge 1"'],
  ];
  for (const [name, cmd] of negatives) {
    const ctx = nudge(cmd).ctx;
    check(`负控：${name}`, !/dao PR 合并链/.test(ctx), JSON.stringify(ctx.slice(0, 80)));
  }
}

console.log("\n──── ③ 两类提醒共存 / 非 Bash 一律不响 ────");
{
  const both = nudge("grep -rn foo src/ && gh pr merge 42");
  check("同一条命令两类都命中 → 两段都注入",
    /dao 工具选择/.test(both.ctx) && /dao PR 合并链/.test(both.ctx),
    JSON.stringify(both.ctx.slice(0, 120)));

  check("非 Bash 工具 → 零输出", nudge("gh pr merge 42", "Edit").raw.trim() === "");
  check("空命令 → 零输出", nudge("", "Bash").raw.trim() === "");
  check("普通命令 → 零输出（不滥报是这个 hook 的第一原则）", nudge("npm run build").raw.trim() === "");
}

console.log("\n──── ④ 浏览器 MCP 首调提醒（瘦身批 #5 新增）────");
{
  // 正控：两个 MCP 前缀各来一次（不同 session，避免互相把对方去重掉）
  const a = mcpCall("mcp__chrome-devtools__take_screenshot", "s-cdp");
  check("正控：chrome-devtools 首调 → 注入 GUI 验证提醒",
    /dao GUI 验证/.test(a.ctx) && /dao-gui-verify\.md/.test(a.ctx), JSON.stringify(a.ctx.slice(0, 100)));
  const b = mcpCall("mcp__playwright__browser_click", "s-pw");
  check("正控：playwright 首调 → 注入 GUI 验证提醒",
    /dao GUI 验证/.test(b.ctx) && /dao-gui-verify\.md/.test(b.ctx), JSON.stringify(b.ctx.slice(0, 100)));
  // 提醒里必须带上两组要点的可辨识锚，否则它只是一个「去读文件」的空指针
  check("正控：提醒里给得出决策树三支与防断路三条的锚",
    /chrome-devtools/.test(a.ctx) && /playwright/.test(a.ctx) && /_tmp\/qa/.test(a.ctx) &&
    /只用一个浏览器工具/.test(a.ctx) && /失败 2 次/.test(a.ctx), JSON.stringify(a.ctx.slice(0, 160)));
  check("正控：提醒里点明 windows-mcp 不是选项（免得读者以为还有第三器）",
    /windows-mcp/.test(a.ctx));

  // 首调语义：同一 session 第二次起静默；换 session 重新提醒
  check("同一 session 第二次调用 → 零输出（首调语义，不是每次都插一段）",
    mcpCall("mcp__chrome-devtools__take_snapshot", "s-cdp").raw.trim() === "");
  check("同一 session 第三次仍静默", mcpCall("mcp__playwright__browser_snapshot", "s-cdp").raw.trim() === "");
  check("换一个 session → 重新提醒", /dao GUI 验证/.test(mcpCall("mcp__chrome-devtools__click", "s-other").ctx));
  check("去重状态真的落了盘且三个 session 都记着",
    (() => { try { return Object.keys(JSON.parse(fs.readFileSync(STATE, "utf8"))).length === 3; } catch (_) { return false; } })());

  // 状态写不动时：仍然提醒 + 自陈可能重复（静默零投递是这个 hook 头注点名要防的死法）
  {
    // 把状态文件指向一个**目录**：读写都必 EISDIR，跨平台稳定，不靠权限/路径怪招
    const r = mcpCall("mcp__chrome-devtools__take_screenshot", "s-badstate", { state: TMP });
    check("状态写不动 → 仍然提醒，且自陈可能重复", /dao GUI 验证/.test(r.ctx) && /可能重复/.test(r.ctx),
      JSON.stringify(r.ctx.slice(-120)));
  }

  // 负控：别的 MCP 服务器、windows-mcp（归 PreToolUse 硬闸 G1，不归本 hook）、Bash 面
  const negatives = [
    ["windows-mcp 归硬闸 G1 拦，本 hook 不该多嘴", "mcp__windows-mcp__Screenshot"],
    ["非浏览器 MCP 不该提醒", "mcp__context7__query-docs"],
    ["名字里含 playwright 但不是该服务器前缀，不该提醒", "mcp__fs__read_playwright_config"],
    ["内置工具不该走 ④ 分支", "Read"],
  ];
  for (const [name, tool] of negatives) {
    check(`负控：${name}`, mcpCall(tool, "s-neg-" + tool).raw.trim() === "");
  }
  check("负控：Bash 命令不该混进 GUI 提醒", !/dao GUI 验证/.test(nudge("grep -rn foo src/").ctx));

  // mutation · 判别力：把 ④ 的工具名判据改成永不命中 → 正控必须从「提醒」掉成「零输出」，
  // 而 ①②③ 的 Bash 面必须不受影响（否则「变哑」可能只是整个 hook 崩了）
  {
    const src = fs.readFileSync(HOOK, "utf8");
    const from = "const BROWSER_MCP_RE = /^mcp__(chrome-devtools|playwright)__/;";
    check("mutation 靶点在源码里唯一存在", src.split(from).length === 2, `出现 ${src.split(from).length - 1} 次`);
    const mutant = path.join(TMP, "mutant-browser-re.js");
    fs.writeFileSync(mutant, src.replace(from, "const BROWSER_MCP_RE = /^__NEVER_MATCHES__/;"), "utf8");
    const before = mcpCall("mcp__chrome-devtools__take_screenshot", "s-mut", { state: path.join(TMP, "mut-a.json") });
    const after = mcpCall("mcp__chrome-devtools__take_screenshot", "s-mut", { script: mutant, state: path.join(TMP, "mut-b.json") });
    check("mutation：真文件提醒、改坏后不提醒 ⇒ 上面那批断言真的在测这段判据",
      /dao GUI 验证/.test(before.ctx) && after.raw.trim() === "",
      `before=${before.ctx.slice(0, 40)} after=${JSON.stringify(after.raw.slice(0, 40))}`);
    const stillBash = spawnSync(process.execPath, [mutant], {
      input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "gh pr merge 42" } }), encoding: "utf8",
    });
    check("mutation：改坏 ④ 之后 ② 仍然响（证明不是整个 hook 崩了）",
      /dao PR 合并链/.test(String(stillBash.stdout || "")));
  }
}

console.log("\n──── ⑤ 热重载 dev server 起在主仓树（批 1-D 新增）────");
{
  // 判据是「那一刻所在目录是不是链接 worktree」，所以必须造真的 git 树 —— 拿 mock 判不了
  // `git rev-parse --git-dir --git-common-dir` 这个契约本身对不对。
  const G = path.join(TMP, "g");
  const MAIN = path.join(G, "mainrepo");
  const WT = path.join(G, "wt");
  const NOTREPO = path.join(G, "notrepo");

  fs.mkdirSync(MAIN, { recursive: true });
  // 「git 判不了」的夹具：**不能只建一个空目录**——它坐落在本仓工作树里，`git -C` 会一路
  // 向上找到本仓的 .git，于是那条负控会以「这是个链接 worktree」的理由通过，测的根本不是
  // null 分支。（这条是被下面的反向 mutation 当场抓出来的，原写法是空目录。）
  // 放一个格式非法的 `.git` 文件 ⇒ git 确定性地 exit 128，走的才是真正的「判不了」。
  fs.mkdirSync(NOTREPO, { recursive: true });
  fs.writeFileSync(path.join(NOTREPO, ".git"), "not a gitfile\n", "utf8");
  let fixtureErr = "";
  for (const [name, args] of [
    ["init", ["-c", "init.defaultBranch=main", "init", "-q", MAIN]],
    ["commit", ["-C", MAIN, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"]],
    ["worktree", ["-C", MAIN, "worktree", "add", "-q", WT, "-b", "feat/x"]],
  ]) {
    const r = spawnSync("git", args, { encoding: "utf8" });
    if (r.status !== 0) { fixtureErr = `${name} exit=${r.status} ${String(r.stderr || "").slice(0, 120)}`; break; }
  }
  // 造不出夹具 ≠ 这一节通过。零样本要**红**着说出来，否则「没跑」与「跑了且全过」长得一样。
  check("夹具就位（真 git 主仓 + 真链接 worktree）", fixtureErr === "", fixtureErr);

  // 走 Bash 面并带上 cwd（既有 nudge() 不传 cwd，故这里另开一个 helper，不动它）
  function bash(command, cwd, script) {
    const r = spawnSync(process.execPath, [script || HOOK], {
      input: JSON.stringify({ tool_name: "Bash", cwd, tool_input: { command } }), encoding: "utf8",
    });
    let out = {};
    try { out = JSON.parse(r.stdout || "{}"); } catch (_) {}
    return { ctx: String((out.hookSpecificOutput || {}).additionalContext || ""), raw: String(r.stdout || "") };
  }
  const hits = (cmd, cwd) => /dao 热重载隔离/.test(bash(cmd, cwd).ctx);

  if (fixtureErr) {
    check("⑤ 全部断言（夹具缺失，无从判定）", false, "夹具未就位 ⇒ 本节零样本，不按通过计");
  } else {
    const positives = [
      "pnpm tauri dev", "pnpm dev", "npm run dev", "pnpm dev:debug",
      "vite", "npx vite --port 5173", "cargo tauri dev", "webpack serve",
      "pnpm run dev", "yarn dev", "bun dev", "webpack --config w.js --watch",
    ];
    for (const cmd of positives) check(`正控：主仓树里 \`${cmd}\` → 提醒`, hits(cmd, MAIN));

    const negatives = [
      ["专用 worktree 里起 dev 是正路，不该提醒", "pnpm tauri dev", WT],
      ["专用 worktree 里 pnpm dev 同理", "pnpm dev", WT],
      ["git 判不了（rev-parse 非零退出）→ 静默，不猜", "pnpm dev", NOTREPO],
      ["vite build 不是 dev server", "vite build", MAIN],
      ["vite preview 不是 dev server", "vite preview", MAIN],
      ["pnpm build 不该提醒", "pnpm build", MAIN],
      ["pnpm test 不该提醒", "pnpm test", MAIN],
      ["npm start 形态可能不是 dev server，刻意不认", "npm start", MAIN],
      ["--help 不起进程", "pnpm dev --help", MAIN],
      ["字符串字面量里的命令不该提醒", 'echo "pnpm dev"', MAIN],
      ["devtools 不是 dev（词边界）", "pnpm run devtools", MAIN],
      ["dev 出现在别的脚本名里不该命中", "pnpm test:dev", MAIN],
    ];
    for (const [name, cmd, cwd] of negatives) {
      check(`负控：${name}`, !hits(cmd, cwd), JSON.stringify(bash(cmd, cwd).ctx.slice(0, 80)));
    }

    // cd 跟踪：`cd ../wt && pnpm dev` 是正路形态，不跟踪 cd 就会对它误报
    check("cd 跟踪：cd 进 worktree 再起 dev → 不提醒（相对路径）", !hits("cd ../wt && pnpm dev", MAIN));
    check("cd 跟踪：cd 进 worktree 再起 dev → 不提醒（绝对路径）", !hits(`cd "${WT}" && pnpm tauri dev`, MAIN));
    check("cd 跟踪：从 worktree cd 回主仓再起 dev → 提醒", hits("cd ../mainrepo && pnpm dev", WT));
    check("cd 跟踪：`cd -` 无从推进 ⇒ 放弃判定而不是按旧目录判", !hits("cd - && pnpm dev", MAIN));
    check("cd 跟踪：裸 `cd`（回 home）同理放弃判定", !hits("cd && pnpm dev", MAIN));

    // 提醒里必须给得出可执行的出路与判据句，否则它只是一句「你错了」
    const ctx = bash("pnpm tauri dev", MAIN).ctx;
    check("正控：提醒里给得出专用树的建法 + 判据句 + 事后二选一",
      /git worktree add/.test(ctx) && /watch 的是哪棵树/.test(ctx) && /并发写入污染/.test(ctx),
      JSON.stringify(ctx.slice(0, 120)));
    check("正控：提醒里点明「实例隔离 ≠ 工作树隔离」（免得被 start-isolated-dev 类脚本读成已解决）",
      /实例隔离/.test(ctx) && /start-isolated-dev/.test(ctx));
    check("正控：提醒里带上判定所用的那个目录（否则无从复核它判的是哪棵树）",
      ctx.includes(MAIN) || ctx.includes(MAIN.replace(/\\/g, "/")), JSON.stringify(ctx.slice(0, 160)));

    // mutation：把 ⑤ 的豁免正则改成恒真 ⇒ 每条启动命令都被豁免 ⇒ ⑤ 整类哑掉。
    // 正控必须掉成静默，而 ② 的 Bash 面必须不受影响（否则「变哑」可能只是整个 hook 崩了）。
    {
      const src = fs.readFileSync(HOOK, "utf8");
      const from = "const DEV_SERVER_EXEMPT_RE = /\\s(?:--help|-h|--version|-v)\\b/;";
      check("mutation 靶点在源码里唯一存在", src.split(from).length === 2, `出现 ${src.split(from).length - 1} 次`);
      const mutant = path.join(TMP, "mutant-devserver-re.js");
      fs.writeFileSync(mutant, src.replace(from, "const DEV_SERVER_EXEMPT_RE = /(?:)/;"), "utf8");
      const before = bash("pnpm tauri dev", MAIN);
      const after = bash("pnpm tauri dev", MAIN, mutant);
      check("mutation：真文件提醒、改坏后不提醒 ⇒ 上面那批断言真的在测这段判据",
        /dao 热重载隔离/.test(before.ctx) && !/dao 热重载隔离/.test(after.ctx),
        `after=${JSON.stringify(after.ctx.slice(0, 60))}`);
      check("mutation：改坏 ⑤ 之后 ② 仍然响（证明不是整个 hook 崩了）",
        /dao PR 合并链/.test(bash("gh pr merge 42", MAIN, mutant).ctx));

      // 反向 mutation（**这一条是给上面那批负控验判别力的**）：上面 12 次 mutation 全在
      // 「让它变哑」这一侧，那样「worktree 里静默」的负控一次都不会红 —— 它们可能只是因为
      // 整类哑了才通过的。故把 worktree 判定改成恒返回「主仓树」，负控必须当场红。
      const from2 = "return norm(lines[0]) !== norm(lines[1]);";
      check("反向 mutation 靶点在源码里唯一存在", src.split(from2).length === 2, `出现 ${src.split(from2).length - 1} 次`);
      const loose = path.join(TMP, "mutant-worktree-blind.js");
      fs.writeFileSync(loose, src.replace(from2, "return false;"), "utf8");
      check("反向 mutation：判定改成「一律算主仓树」后，worktree 负控真的红了 ⇒ 那批负控有判别力",
        /dao 热重载隔离/.test(bash("pnpm tauri dev", WT, loose).ctx));
      check("反向 mutation：git 判不了那条仍然静默（它在 return 之前就退出了，与本次改动无关）",
        !/dao 热重载隔离/.test(bash("pnpm dev", NOTREPO, loose).ctx));
    }
  }
}

console.log("\n──── ⑥ 推送触及条款索引源（issue #162 新增）────");
{
  // 判据是「这次 push 到底送出去了哪些文件」，而它靠**上游远程跟踪分支的 reflog 区间**反推 ——
  // 拿 mock 判不了这个契约本身对不对，所以这里造真的 bare remote + 真的 push。
  const G = path.join(TMP, "clause");
  const REMOTE = path.join(G, "remote.git");
  const LOCAL = path.join(G, "local");
  const NOUP = path.join(G, "noupstream");

  const git = (args, cwd) => spawnSync("git", args, { encoding: "utf8", cwd });
  let fixtureErr = "";
  const step = (name, args, cwd) => {
    if (fixtureErr) return;
    const r = git(args, cwd);
    if (r.status !== 0) fixtureErr = `${name} exit=${r.status} ${String(r.stderr || "").slice(0, 160)}`;
  };
  const write = (repo, rel, text) => {
    const p = path.join(repo, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text, "utf8");
  };
  const commitPush = (msg) => {
    step("add", ["add", "-A"], LOCAL);
    step("commit", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", msg], LOCAL);
    step("push", ["push", "-q"], LOCAL);
  };

  fs.mkdirSync(G, { recursive: true });
  step("init-bare", ["init", "-q", "--bare", REMOTE]);
  step("init-local", ["-c", "init.defaultBranch=main", "init", "-q", LOCAL]);
  write(LOCAL, "README.md", "seed\n");
  step("add0", ["add", "-A"], LOCAL);
  step("commit0", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "seed"], LOCAL);
  step("remote", ["remote", "add", "origin", REMOTE.replace(/\\/g, "/")], LOCAL);
  step("push0", ["push", "-q", "-u", "origin", "main"], LOCAL);
  // 没有上游的那一棵（`git push` 判不出推了什么 ⇒ 必须静默）
  step("init-noup", ["-c", "init.defaultBranch=main", "init", "-q", NOUP]);
  check("夹具就位（真 bare remote + 真 push，reflog 里有上一位）", fixtureErr === "", fixtureErr);

  // 假解析器：源清单/索引路径/regen 命令**全部换掉**。它是「源清单现场读、本文件不留副本」
  // 这条要求**唯一有判别力的证据** —— 若 hook 里偷偷硬编了一份，下面两条会同时反过来。
  const FAKE_PARSER = path.join(G, "fake-parser.mjs");
  fs.writeFileSync(FAKE_PARSER, [
    'export function defaultSources() { return [{ file: "odd/dir/only-source.md" }]; }',
    'export const DEFAULT_INDEX_REL = "odd/dir/only-index.json";',
    'export const REGEN_CMD = "node odd/dir/regen.mjs";',
    "",
  ].join("\n"), "utf8");

  function push(command, cwd, opts = {}) {
    const env = Object.assign({}, process.env);
    if (opts.parser !== undefined) env.DAO_TOOL_NUDGE_CLAUSE_PARSER = opts.parser;
    const r = spawnSync(process.execPath, [opts.script || HOOK], {
      input: JSON.stringify({ tool_name: "Bash", cwd, tool_input: { command } }),
      encoding: "utf8", env,
    });
    let out = {};
    try { out = JSON.parse(r.stdout || "{}"); } catch (_) {}
    return { ctx: String((out.hookSpecificOutput || {}).additionalContext || ""), raw: String(r.stdout || "") };
  }
  const fires = (cmd, cwd, opts) => /dao 条款索引/.test(push(cmd, cwd, opts).ctx);

  if (fixtureErr) {
    check("⑥ 全部断言（夹具缺失，无从判定）", false, "夹具未就位 ⇒ 本节零样本，不按通过计");
  } else {
    // ── 正控一：真语料。推的是**真 defaultSources() 里那 12 个源之一** ────────────
    write(LOCAL, "ccswitch/dao.md", "# 假装这是条款源\n");
    commitPush("touch a real clause source");
    check("夹具第二推成功", fixtureErr === "", fixtureErr);
    const real = push("git push", LOCAL);
    check("正控：推送动了真源清单里的 ccswitch/dao.md ⇒ 提醒",
      /dao 条款索引/.test(real.ctx), JSON.stringify(real.ctx.slice(0, 120)));
    check("正控：提醒点名了到底是哪个源（不点名就无从复核它判的是什么）",
      /ccswitch\/dao\.md/.test(real.ctx), JSON.stringify(real.ctx.slice(0, 200)));
    check("正控：提醒给得出 --check 命令与索引文件名（两者都取自解析器，不是本文件写死的）",
      /gen-clause-index\.mjs --check/.test(real.ctx) && /ccswitch\/clause-index\.json/.test(real.ctx),
      JSON.stringify(real.ctx.slice(0, 300)));
    check("正控：提醒自陈是近似判据且两侧都有反例（禁笃定措辞）",
      /近似/.test(real.ctx) && /静默/.test(real.ctx) && /重复提醒/.test(real.ctx),
      JSON.stringify(real.ctx.slice(-300)));

    // ── 单一真相源：换一份解析器，命中面必须跟着换 ────────────────────────────
    check("单一真相源：换成假解析器后，ccswitch/dao.md 不再是源 ⇒ 同一次推送不提醒",
      !fires("git push", LOCAL, { parser: FAKE_PARSER }),
      JSON.stringify(push("git push", LOCAL, { parser: FAKE_PARSER }).ctx.slice(0, 160)));
    check("单一真相源：解析器读不到（路径指空气）⇒ 静默，不拿一份内置副本兜底",
      !fires("git push", LOCAL, { parser: path.join(G, "no-such-parser.mjs") }));

    // ── 负控：--delete 形态（它不动 @{u}，reflog 区间还停在上一次推送上）──────────
    check("负控：git push --delete 不该提醒（删远程分支不动上游，区间是上一次的，认了就是误报）",
      !fires("git push origin --delete feat/x", LOCAL));
    check("负控：非 push 命令一律不该走 ⑥", !fires("git status", LOCAL) && !fires("git fetch --prune", LOCAL));
    check("负控：没有上游的仓里 git push ⇒ 判不出，静默（宁漏勿滥）", !fires("git push", NOUP));

    // ── 正控二：假解析器下，推它声明的那个源 ⇒ 提醒，且修法命令也来自它 ──────────
    write(LOCAL, "odd/dir/only-source.md", "x\n");
    commitPush("touch the fake parser's source");
    const fake = push("git push", LOCAL, { parser: FAKE_PARSER });
    check("正控：假解析器声明的源被推 ⇒ 提醒，且 regen 命令是它给的那条",
      /dao 条款索引/.test(fake.ctx) && /node odd\/dir\/regen\.mjs --check/.test(fake.ctx),
      JSON.stringify(fake.ctx.slice(0, 200)));
    check("负控：同一次推送在真解析器眼里不含任何源 ⇒ 不提醒（两个方向都验过才叫现场读）",
      !fires("git push", LOCAL));

    // ── 负控：索引同批推上去了 ⇒ 静默（regen 多半跑过，再提醒纯属噪音）──────────
    write(LOCAL, "ccswitch/rules/dao-legislation.md", "# 另一个真源\n");
    write(LOCAL, "ccswitch/clause-index.json", "{}\n");
    commitPush("source + index together");
    check("负控：源与索引同批推 ⇒ 不提醒（regen 跟上了，--check 本来就绿）",
      !fires("git push", LOCAL), JSON.stringify(push("git push", LOCAL).ctx.slice(0, 160)));

    // ── 负控：跟条款无关的推送 ──────────────────────────────────────────────
    write(LOCAL, "README.md", "seed 2\n");
    commitPush("unrelated");
    check("负控：普通推送不该被误伤（这是本 hook 最贵的错误方向）",
      !fires("git push", LOCAL) && !fires("git push origin main", LOCAL),
      JSON.stringify(push("git push origin main", LOCAL).ctx.slice(0, 160)));
    check("负控：普通推送时 ③ 直推主干那一类照常响（证明不是整段 Bash 面哑了）",
      /dao PR-first/.test(push("git push origin main", LOCAL).ctx));
    check("夹具全程无 git 报错", fixtureErr === "", fixtureErr);

    // ── mutation 三形态 + 反向 ────────────────────────────────────────────────
    // 三形态的红集**刻意分开报**：①②同为行为型改坏，红集相同是意料之中（dao 条款明写
    // 「行为型测试对①②通常都敏感」）；③换的是「答案有没有人听」，它红的是**另一条负控**。
    {
      const src = fs.readFileSync(HOOK, "utf8").replace(/\r\n/g, "\n"); // 行尾归一化：本仓 autocrlf=true，跨行锚点用 \n 会找不到
      const mut = (tag, from, to) => {
        const p = path.join(TMP, `mutant-clause-${tag}.js`);
        fs.writeFileSync(p, src.replace(from, to), "utf8");
        return p;
      };
      // 先把区间恢复成「只推了一个真源、没带索引」那一态，正控才有得测
      write(LOCAL, "ccswitch/rules/dao-dispatch.md", "# 第三个真源\n");
      commitPush("source only again");
      check("mutation 前置：真文件在这一态下确实提醒（对照面是活的，不是靶已经死了）",
        fires("git push", LOCAL));

      const t1 = "      const hit = files.filter((f) => facts.sources.includes(f));";
      check("N1 靶点唯一", src.split(t1).length === 2, `出现 ${src.split(t1).length - 1} 次`);
      const n1 = mut("removed", t1, "      const hit = [];");
      check("N1（①移除）：命中判据拿掉后正控哑掉 ⇒ 那批正控真的在测这段",
        !fires("git push", LOCAL, { script: n1 }));
      check("N1：改坏 ⑥ 之后 ③ 仍然响（证明不是整个 hook 崩了）",
        /dao PR-first/.test(push("git push origin main", LOCAL, { script: n1 }).ctx));

      const t2 = 'if (clauseHit) flows.add("clause-source-push");';
      check("N2 靶点唯一", src.split(t2).length === 2, `出现 ${src.split(t2).length - 1} 次`);
      const n2 = mut("dead-branch", t2, 'if (false && clauseHit) flows.add("clause-source-push");');
      check("N2（②保留字面但不执行）：判据照算、分支永不进 ⇒ 正控照样哑（文本匹配型检查对这形态失明）",
        !fires("git push", LOCAL, { script: n2 }));

      // ③：`files.includes(facts.index)` 照算（副作用与开销都在），只是**答案不被消费**。
      //    它红的不是正控，是「索引同批推上去就该静默」那条负控 —— 红集与 ①② 不同。
      const t3 = "      if (hit.length && !files.includes(facts.index)) clauseHit = { hit, facts };";
      check("N3 靶点唯一", src.split(t3).length === 2, `出现 ${src.split(t3).length - 1} 次`);
      const n3 = mut("unconsumed", t3,
        "      if (hit.length && (files.includes(facts.index), true)) clauseHit = { hit, facts };");
      const n3PositiveStillGreen = fires("git push", LOCAL, { script: n3 });
      write(LOCAL, "ccswitch/rules/dao-guard-writing.md", "# 第四个真源\n");
      write(LOCAL, "ccswitch/clause-index.json", "{ }\n");
      commitPush("source + index, for N3");
      const n3NegativeRed = fires("git push", LOCAL, { script: n3 });
      const n3RealStillSilent = !fires("git push", LOCAL);
      check("N3（③结果不被消费）：正控仍绿，而「源与索引同批推」那条负控当场红 ⇒ 红集与 ①② 不同",
        n3PositiveStillGreen && n3NegativeRed && n3RealStillSilent,
        `正控=${n3PositiveStillGreen} 负控变红=${n3NegativeRed} 真文件仍静默=${n3RealStillSilent}`);

      // 反向：源匹配改成恒真 ⇒ 「普通推送不该被误伤」那条负控必须当场红。
      // 上面三次全在「让它变哑」这一侧，不做这一次的话，那批负控可能只是因为整类哑了才通过的。
      write(LOCAL, "README.md", "seed 3\n");
      commitPush("unrelated again");
      const t4 = "facts.sources.includes(f)";
      check("R2 靶点唯一", src.split(t4).length === 2, `出现 ${src.split(t4).length - 1} 次`);
      const r2 = mut("always-hit", t4, "true");
      check("R2（反向）：源匹配恒真后，「普通推送不该被误伤」那条负控真的红了 ⇒ 那批负控有判别力",
        !fires("git push", LOCAL) && fires("git push", LOCAL, { script: r2 }));
      check("⑥ 的夹具与变异体都在 _tmp/ 下（ccswitch/ 里不留残骸）",
        fs.existsSync(n1) && n1.startsWith(TMP) && r2.startsWith(TMP));
    }
  }
}

console.log("\n──── ⑦ --selfcheck：matcher 覆盖面必须能被独立问一次 ────");
{
  // 这里**不断言本机是绿还是红** —— 那取决于用户有没有扩 matcher，而这份测试要在两种状态下
  // 都成立。断言的是**自检自身自洽**：它逐面报了、报的结论与退出码一致、并给得出修法。
  const r = spawnSync(process.execPath, [HOOK, "--selfcheck"], { encoding: "utf8" });
  const out = String(r.stdout || "");
  check("自检逐面打印（Bash 面 + 浏览器 MCP 面）",
    /Bash 面/.test(out) && /浏览器 MCP 面/.test(out), JSON.stringify(out.slice(0, 160)));
  check("自检结论与退出码一致（有 ✗ 即 exit 1，全 ✓ 即 exit 0）",
    (/✗/.test(out) ? r.status === 1 : r.status === 0), `exit=${r.status} out=${JSON.stringify(out.slice(0, 200))}`);
  check("自检给得出修法（扩 matcher 的确切串 + 写入面归谁）",
    /mcp__chrome-devtools__\.\*/.test(out) && /providers\.settings_config/.test(out), JSON.stringify(out.slice(-200)));
  check("自检不读 stdin，也不会因为没有 stdin 而挂住", typeof r.status === "number");
}

console.log(`\n=== 汇总: PASS=${pass} FAIL=${fail} ===`);
process.exit(fail ? 1 : 0);
