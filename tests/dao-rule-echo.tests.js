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
const { spawnSync } = require("child_process");
const path = require("path");

const HOOK = path.resolve(__dirname, "..", "ccswitch", "hooks", "dao-rule-echo.js");

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
// 夹具放 tests/ 下自建目录（**不能放 `_tmp/`**：那个前缀在 hook 的 EXCLUDE 里，
// 放进去会让被测文件直接被判为「非规则文件」，测试变成永远为真的废话）。
console.log("\n=== P2 作用域档：有 paths ⇒ 作用域注入，无 paths ⇒ 常驻 ===");
{
  const fs = require("fs");
  const os = require("os");
  const FIX = path.resolve(__dirname, ".fixtures-scope", ".claude", "rules");
  const userFix = path.join(os.homedir(), ".claude", "rules", "zz-test-fixture-userlevel.md");
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
    const userScoped = path.join(os.homedir(), ".claude", "rules", "zz-test-fixture-userscoped.md");
    fs.writeFileSync(userScoped, '---\npaths:\n  - "**/*.ps1"\n---\n\n正文\n', "utf8");
    try {
      r = run(ptu("Edit", { file_path: userScoped.replace(/\\/g, "/"), old_string: "a", new_string: "用户级作用域 G" }));
      check("用户级有 paths → 走作用域分支而非未送达警告", /作用域注入/.test(ctx(r)) && !/3\/3/.test(ctx(r)));
    } finally { try { fs.unlinkSync(userScoped); } catch (_) {} }
  } finally {
    // 夹具必须清干净：残留在 ~/.claude/rules/ 下的文件会被宿主当真规则扫描
    try { fs.unlinkSync(userFix); } catch (_) {}
    try { fs.rmSync(path.resolve(__dirname, ".fixtures-scope"), { recursive: true, force: true }); } catch (_) {}
  }
}

console.log(`\n=== 汇总: PASS=${pass} FAIL=${fail} ===`);
process.exit(fail ? 1 : 0);
