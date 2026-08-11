// dao-tool-nudge hook 回归网 — 每类提醒各留正控 + 误伤负控 + mutation 判别力
//
// 跑法：node tests/dao-tool-nudge.tests.js   （全绿 exit 0，任一红 exit 1）
//
// 判据是近似的（段首正则），别把全绿读成「分得清一切」：嵌套形态（`for r in …; do gh pr merge`）、
// 环境变量前缀、字符串字面量里的命令等盲区**刻意不补**——本 hook 是软提醒不是守卫，
// 误伤一次（污染一次 context）高于漏报一次。
//
// ④ 的去重状态落一份**测试专属**文件：用真状态会让「本机今天已经提醒过」把正控染绿。
// ⑤ 必须造真的 git 树（主仓 + 链接 worktree + 「判不了」夹具）：拿 mock 判不了
// `git rev-parse --git-dir --git-common-dir` 这个契约本身。「判不了」夹具不能是空目录
// （会一路向上找到本仓 .git），放一个格式非法的 `.git` 文件 ⇒ git 确定性 exit 128。

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const REPO = path.resolve(__dirname, "..");
const HOOK = path.join(REPO, "ccswitch", "hooks", "dao-tool-nudge.js");
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

function nudge(command, toolName = "Bash") {
  const input = JSON.stringify({ tool_name: toolName, tool_input: { command } });
  const r = spawnSync(process.execPath, [HOOK], { input, encoding: "utf8" });
  let out = {};
  try { out = JSON.parse(r.stdout || "{}"); } catch (_) {}
  const hs = out.hookSpecificOutput || {};
  return { code: r.status, ctx: String(hs.additionalContext || ""), raw: String(r.stdout || "") };
}

// ④ 专用：按工具名 + session_id 喂一次；可指定脚本副本（mutation）与状态文件。
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

// ⑤ 专用：带 cwd 的 Bash 调用。
function bash(command, cwd, script) {
  const r = spawnSync(process.execPath, [script || HOOK], {
    input: JSON.stringify({ tool_name: "Bash", cwd, tool_input: { command } }), encoding: "utf8",
  });
  let out = {};
  try { out = JSON.parse(r.stdout || "{}"); } catch (_) {}
  return { ctx: String((out.hookSpecificOutput || {}).additionalContext || ""), raw: String(r.stdout || "") };
}

console.log("\n──── ① 工具选择（正控 + 负控）────");
{
  const ctx = nudge("grep -rn foo src/").ctx;
  check("正控：grep 直接搜文件 → 建议内置 Grep", /内置 Grep/.test(ctx), JSON.stringify(ctx.slice(0, 80)));
  check("负控：管道下游过滤（ps | grep）内置工具替代不了 → 不提示",
    nudge("ps aux | grep node").ctx === "", JSON.stringify(nudge("ps aux | grep node").ctx.slice(0, 80)));
  check("负控：git grep 豁免", nudge("git grep -n foo").ctx === "");
}

console.log("\n──── ② PR 合并链（正控 + 负控）────");
{
  const ctx = nudge("gh pr merge 42 --merge --delete-branch").ctx;
  check("正控：裸手 gh pr merge → 提示走 canonical 脚本", /dao PR 合并链/.test(ctx) && /dao-pr-merge\.ps1/.test(ctx),
    JSON.stringify(ctx.slice(0, 80)));
  check("负控：走 canonical 脚本的正路不提示",
    !/dao PR 合并链/.test(nudge("pwsh -File ccswitch/scripts/dao-pr-merge.ps1 -PullRequest 42 -SkipVerify").ctx));
  check("负控：只读的 gh pr view 不提示", !/dao PR 合并链/.test(nudge("gh pr view 42 --json state").ctx));
}

console.log("\n──── ③ 共存 / 非 Bash 面 ────");
{
  const both = nudge("grep -rn foo src/ && gh pr merge 42").ctx;
  check("正控：同一条命令两类都命中 → 两段都注入",
    /dao 工具选择/.test(both) && /dao PR 合并链/.test(both), JSON.stringify(both.slice(0, 120)));
  check("负控：非 Bash 工具 → 零输出", nudge("gh pr merge 42", "Edit").raw.trim() === "");
  check("负控：普通命令 → 零输出（不滥报是第一原则）", nudge("npm run build").raw.trim() === "");
}

console.log("\n──── ④ 浏览器 MCP 首调 ────");
{
  const a = mcpCall("mcp__chrome-devtools__take_screenshot", "s-cdp");
  check("正控：首调 → 注入 GUI 验证提醒，含决策树/防断路/windows-mcp 不是选项 的锚",
    /dao GUI 验证/.test(a.ctx) && /dao-gui-verify\.md/.test(a.ctx) && /windows-mcp/.test(a.ctx) &&
    /只用一个浏览器工具/.test(a.ctx), JSON.stringify(a.ctx.slice(0, 160)));
  check("首调语义：同一 session 第二次起静默", mcpCall("mcp__chrome-devtools__take_snapshot", "s-cdp").raw.trim() === "");
  check("状态写不动（指向目录）→ 仍然提醒且自陈可能重复：重复是噪音，静默是规则消失",
    (() => {
      const r = mcpCall("mcp__chrome-devtools__take_screenshot", "s-bad", { state: TMP });
      return /dao GUI 验证/.test(r.ctx) && /可能重复/.test(r.ctx);
    })());
  check("负控：非浏览器 MCP / windows-mcp（归硬闸 G1）不提醒",
    mcpCall("mcp__context7__query-docs", "s-neg").raw.trim() === "" &&
    mcpCall("mcp__windows-mcp__Screenshot", "s-neg2").raw.trim() === "");

  // mutation：把 BROWSER_MCP_RE 改成永不命中 → 正控掉成零输出，② Bash 面不受影响
  {
    const src = fs.readFileSync(HOOK, "utf8");
    const from = "const BROWSER_MCP_RE = /^mcp__(chrome-devtools|playwright)__/;";
    check("mutation 靶点唯一存在", src.split(from).length === 2, `出现 ${src.split(from).length - 1} 次`);
    const mutant = path.join(TMP, "mutant-browser-re.js");
    fs.writeFileSync(mutant, src.replace(from, "const BROWSER_MCP_RE = /^__NEVER_MATCHES__/;"), "utf8");
    const before = mcpCall("mcp__chrome-devtools__take_screenshot", "s-mut", { state: path.join(TMP, "a.json") });
    const after = mcpCall("mcp__chrome-devtools__take_screenshot", "s-mut", { script: mutant, state: path.join(TMP, "b.json") });
    check("mutation：真文件提醒、改坏后不提醒 ⇒ 上面正控真在测这段判据",
      /dao GUI 验证/.test(before.ctx) && after.raw.trim() === "");
    check("mutation：改坏 ④ 后 ② 仍然响（不是整个 hook 崩了）",
      /dao PR 合并链/.test(bash("gh pr merge 42", REPO, mutant).ctx));
  }
}

console.log("\n──── ⑤ 热重载 dev server 树隔离 ────");
{
  const G = path.join(TMP, "g");
  const MAIN = path.join(G, "mainrepo");
  const WT = path.join(G, "wt");
  const NOTREPO = path.join(G, "notrepo");

  fs.mkdirSync(MAIN, { recursive: true });
  fs.mkdirSync(NOTREPO, { recursive: true });
  fs.writeFileSync(path.join(NOTREPO, ".git"), "not a gitfile\n", "utf8");
  let fixtureErr = "";
  for (const [name, args] of [
    ["init", ["-c", "init.defaultBranch=main", "init", "-q", MAIN]],
    ["commit", ["-C", MAIN, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"]],
    ["worktree", ["-C", MAIN, "worktree", "add", "-q", WT, "-b", "feat/x"]],
  ]) {
    const r = spawnSync("git", args, { encoding: "utf8" });
    if (r.status !== 0) { fixtureErr = `${name} exit=${r.status}`; break; }
  }
  // 造不出夹具 ≠ 这一节通过：零样本要红着说出来，否则「没跑」与「全过」长得一样。
  check("夹具就位（真 git 主仓 + 真链接 worktree）", fixtureErr === "", fixtureErr);

  if (fixtureErr) {
    check("⑤ 全部断言（夹具缺失，无从判定）", false, "夹具未就位 ⇒ 本节零样本，不按通过计");
  } else {
    const hits = (cmd, cwd, script) => /dao 热重载隔离/.test(bash(cmd, cwd, script).ctx);
    check("正控：主仓树里 pnpm dev → 提醒", hits("pnpm dev", MAIN));
    check("负控：专用 worktree 里起 dev 是正路 → 静默", !hits("pnpm tauri dev", WT));
    check("负控：git 判不了（非法 .git → rev-parse 非零）→ 静默不猜", !hits("pnpm dev", NOTREPO));
    check("负控：vite build / pnpm test 不是 dev server → 静默", !hits("vite build", MAIN) && !hits("pnpm test", MAIN));
    check("cd 跟踪：cd 进 worktree 再起 dev → 不提醒；cd - 无从推进 → 放弃判定",
      !hits("cd ../wt && pnpm dev", MAIN) && !hits("cd - && pnpm dev", MAIN));
    const ctx = bash("pnpm tauri dev", MAIN).ctx;
    check("正控：提醒给得出专用树建法 + 判据句 + 实例隔离≠工作树隔离",
      /git worktree add/.test(ctx) && /watch 的是哪棵树/.test(ctx) && /实例隔离/.test(ctx),
      JSON.stringify(ctx.slice(0, 120)));

    // 正向 mutation：豁免正则改成恒真 ⇒ ⑤ 整类哑掉；反向 mutation：worktree 判定改恒 false
    // ⇒ worktree 负控必须红（证明那批负控有判别力，不是整类哑了才通过）。
    {
      const src = fs.readFileSync(HOOK, "utf8");
      const from = "const DEV_SERVER_EXEMPT_RE = /\\s(?:--help|-h|--version|-v)\\b/;";
      const from2 = "return norm(lines[0]) !== norm(lines[1]);";
      check("mutation 靶点各唯一存在", src.split(from).length === 2 && src.split(from2).length === 2);
      const m1 = path.join(TMP, "mutant-devserver-re.js");
      fs.writeFileSync(m1, src.replace(from, "const DEV_SERVER_EXEMPT_RE = /(?:)/;"), "utf8");
      check("mutation：豁免改恒真 ⇒ 主仓树正控哑掉，② 仍响",
        !hits("pnpm tauri dev", MAIN, m1) && /dao PR 合并链/.test(bash("gh pr merge 42", MAIN, m1).ctx));
      const m2 = path.join(TMP, "mutant-worktree-blind.js");
      fs.writeFileSync(m2, src.replace(from2, "return false;"), "utf8");
      check("反向 mutation：判定恒「主仓树」⇒ worktree 负控真的红了（负控有判别力）",
        hits("pnpm tauri dev", WT, m2));
    }
  }
}

console.log("\n──── ⑦ PowerShell 面：2>&1 混流 / Bash heredoc ────");
{
  const ps = (command) => nudge(command, "PowerShell");
  check("正控：2>&1 → 禁 2>&1 提醒", /禁 2>&1/.test(ps("cargo build 2>&1 | Out-File log.txt").ctx));
  check("正控：Bash heredoc → 禁 Bash heredoc 提醒", /禁 Bash heredoc/.test(ps("cat <<EOF\ntext\nEOF").ctx));
  check("正控：两类同一条命令都命中 → 两段都注入",
    (() => { const c = ps("cargo build 2>&1 | Out-File $(cat <<'EOF'\nx\nEOF\n)").ctx; return /禁 2>&1/.test(c) && /禁 Bash heredoc/.test(c); })());
  check("负控：普通命令不提示；PS here-string 不是 Bash heredoc；普通 >> 不误判",
    ps("git status").ctx === "" && ps("$body = @'\ntext\n'@").ctx === "" && ps("git log >> out.txt").ctx === "");
  check("负控：Bash 工具里的 2>&1 不触发 PowerShell 专属提醒", !/禁 2>&1/.test(nudge("cargo build 2>&1").ctx));

  // mutation 双向：2>&1 判据改永不命中 → 正控哑掉而 heredoc 仍响；改恒真 → 普通命令负控红
  {
    const src = fs.readFileSync(HOOK, "utf8");
    const from = 'if (/2>&1/.test(cmd)) {';
    check("mutation 靶点唯一存在", src.split(from).length === 2);
    const m1 = path.join(TMP, "mutant-ps-2to1.js");
    fs.writeFileSync(m1, src.replace(from, 'if (/__NEVER_MATCHES__/.test(cmd)) {'), "utf8");
    const m1out = spawnSync(process.execPath, [m1], {
      input: JSON.stringify({ tool_name: "PowerShell", tool_input: { command: "git status 2>&1" } }), encoding: "utf8",
    });
    const m1her = spawnSync(process.execPath, [m1], {
      input: JSON.stringify({ tool_name: "PowerShell", tool_input: { command: "cat <<EOF\nx\nEOF" } }), encoding: "utf8",
    });
    check("mutation：2>&1 判据改坏 ⇒ 正控哑掉而 heredoc 仍响（两段互不牵连）",
      !/禁 2>&1/.test(String(m1out.stdout || "")) && /禁 Bash heredoc/.test(String(m1her.stdout || "")));
    const m2 = path.join(TMP, "mutant-ps-2to1-rev.js");
    fs.writeFileSync(m2, src.replace(from, 'if (/(?:)/.test(cmd)) {'), "utf8");
    const m2out = spawnSync(process.execPath, [m2], {
      input: JSON.stringify({ tool_name: "PowerShell", tool_input: { command: "git status" } }), encoding: "utf8",
    });
    check("反向 mutation：判据恒真 ⇒ 普通命令负控红了（负控有判别力）",
      /禁 2>&1/.test(String(m2out.stdout || "")));
  }
}

console.log("\n──── ⑧ --selfcheck 自洽 ────");
{
  // 不断言本机是绿是红（取决于用户 matcher），断言的是自检自身自洽：逐面报、结论与退出码一致、给修法。
  const r = spawnSync(process.execPath, [HOOK, "--selfcheck"], { encoding: "utf8" });
  const out = String(r.stdout || "");
  check("自检逐面打印（Bash/PowerShell/浏览器 MCP 三面）+ 结论与退出码一致",
    /Bash 面/.test(out) && /PowerShell 面/.test(out) && /浏览器 MCP 面/.test(out) &&
    (/✗/.test(out) ? r.status === 1 : r.status === 0), `exit=${r.status}`);
  check("自检给得出修法（扩 matcher 的确切串）", /Bash\|PowerShell\|mcp__chrome-devtools__\.\*/.test(out));
}

console.log(`\n=== 汇总: PASS=${pass} FAIL=${fail} ===`);
process.exit(fail ? 1 : 0);
