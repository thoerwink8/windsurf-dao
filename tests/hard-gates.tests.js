// dao-hard-gates 回归网 — 每闸正控 + 误伤负控 + mutation 判别力 + canary 恒等
//
// 跑法：node tests/hard-gates.tests.js   （全绿 exit 0，任一红 exit 1）
//
// ── 为什么这份测试的形态是这样 ──────────────────────────────────────────────
// 被测对象是**一道会 exit 2 拦人的闸**，它的两侧代价都是真代价：
//   · 漏报 → 那条禁令仍然只是文字，而文字禁令的实测遵守率是 0%（arxiv 2607.26819）
//   · 误报 → 合法动作被拦死，而甲类闸的逃生阀只有用户设得了 ⇒ 会话当场卡住
// 故每闸都是**双向断言**：违例必 exit 2 且 stderr 里给得出合法路径；合法输入必 exit 0。
// 只证明「能拦住」不算完成 —— 这是 dispatch-clauses 实现官节点名要求的那一条。
//
// ── mutation 为什么写进回归网而不是手工跑一次 ───────────────────────────────
// 「测试存在」不等于「测试有判别力」。手工 mutation 只发生一次，判据却会被反复编辑。
// 故本文件把 mutation 做成常驻断言：把某一闸的判定**改坏**（写进 _tmp/ 的副本，
// 从不碰真文件），断言原本 exit 2 的那条用例变成 exit 0；再断言真文件在整个过程中
// 逐字节没动过（canary 恒等）。任何一天有人把某条判据写成永假，这里会红。
//
// ── 已知不覆盖（照直写，别读成全覆盖）──────────────────────────────────────
// · matcher 覆盖面只由 `--selfcheck` 自查，本文件只断言它的**输出形态**——
//   真实注册状态取决于用户的 live settings.json，锚死会让测试随用户配置变红。
// · fail-open 路径用「注入一个必抛的判定」构造，证的是「崩了会放行且会喊」，
//   证不了「所有崩法都能被 catch 到」（catch 不住的崩法：进程级 OOM/被杀）。
// · G5 的 `--body-file` 只测真实可读文件；「文件读不到 ⇒ 放行」这个漏报面
//   有一条负控钉着，但那是**有意为之**（见 hook 内注释），不是待修的洞。

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

const REPO = path.resolve(__dirname, "..");
const HOOK = path.join(REPO, "ccswitch", "hooks", "dao-hard-gates.js");
const NUDGE = path.join(REPO, "ccswitch", "hooks", "dao-tool-nudge.js");
const TMP = path.join(REPO, "_tmp", "hard-gates-tests");

fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

const HOME = process.env.USERPROFILE || process.env.HOME;

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? "  →  " + detail : ""}`); }
}

function sha(p) {
  return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}

// 喂一次 PreToolUse 输入。script 缺省=真 hook；env 用于测逃生阀。
function gate(payload, { script = HOOK, env = {} } = {}) {
  const r = spawnSync(process.execPath, [script], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { code: r.status, err: String(r.stderr || ""), out: String(r.stdout || "") };
}

function nudge(command, toolName = "Bash") {
  const r = spawnSync(process.execPath, [NUDGE], {
    input: JSON.stringify({ tool_name: toolName, tool_input: { command } }),
    encoding: "utf8",
  });
  let out = {};
  try { out = JSON.parse(r.stdout || "{}"); } catch (_) {}
  return String((out.hookSpecificOutput || {}).additionalContext || "");
}

const bash = (command, cwd) => ({ tool_name: "Bash", tool_input: { command }, cwd });
const edit = (file_path) => ({ tool_name: "Edit", tool_input: { file_path } });

// 每闸的一条"承重正控"，mutation 与 canary 都拿它当靶
const CANARY = {
  "G1-windows-mcp": { tool_name: "mcp__windows-mcp__Screenshot", tool_input: {} },
  "G2-live-settings": edit(path.join(HOME, ".claude", "settings.json")),
  "G3-publish": bash("npm publish --access public"),
  "G4-screenshot-path": {
    tool_name: "mcp__chrome-devtools__take_screenshot",
    tool_input: { filePath: "D:/frank/mousse-cli/shot.png" },
  },
  "G5-readonly-todo": bash('gh pr create --title x --body "做完了\n- [ ] 还没跑测试"'),
};

const PRISTINE_SHA = sha(HOOK);
const canaryBefore = {};
for (const [id, p] of Object.entries(CANARY)) canaryBefore[id] = gate(p).code;

console.log("\n──── G1 · windows-mcp 全面禁令（一票否决，无逃生阀）────");
{
  for (const t of ["mcp__windows-mcp__Screenshot", "mcp__windows-mcp__Click", "mcp__windows_mcp__PowerShell"]) {
    const r = gate({ tool_name: t, tool_input: {} });
    check(`正控：${t} → exit 2`, r.code === 2, `code=${r.code}`);
    check(`正控：${t} stderr 给得出替代工具`, /chrome-devtools|playwright/.test(r.err), r.err.slice(0, 120));
  }
  // 无逃生阀：即便把别的闸的 env 全设上也拦
  check("无逃生阀：设了所有已知 env 仍 exit 2",
    gate(CANARY["G1-windows-mcp"], {
      env: { DAO_SETTINGS_EDIT_APPROVED: "1", DAO_PUBLISH_APPROVED: "1", DAO_ALLOW_READONLY_TODO: "1" },
    }).code === 2);

  const negatives = [
    ["chrome-devtools 截图（无路径）不该拦", { tool_name: "mcp__chrome-devtools__take_screenshot", tool_input: {} }],
    ["playwright 点击不该拦", { tool_name: "mcp__playwright__browser_click", tool_input: {} }],
    ["名字里含 windows 但非 windows-mcp 服务器不该拦", { tool_name: "mcp__fs__read_windows_file", tool_input: {} }],
    ["内置 PowerShell 工具不该被当成 windows-mcp", bash("Get-Process node")],
  ];
  for (const [name, p] of negatives) check(`负控：${name}`, gate(p).code === 0, `code=${gate(p).code}`);
}

console.log("\n──── G2 · live ~/.claude/settings.json（投影，非源）────");
{
  for (const n of ["settings.json", "settings.local.json"]) {
    const r = gate(edit(path.join(HOME, ".claude", n)));
    check(`正控：Edit ${n} → exit 2`, r.code === 2, `code=${r.code}`);
    check(`正控：${n} stderr 指出 config-sync 快照层这条正路`,
      /config-sync\/common\/settings\.json/.test(r.err) && /direction=down/.test(r.err), r.err.slice(0, 200));
    check(`正控：${n} stderr 点名不要建议 --direction=up`, /不要建议 `--direction=up`/.test(r.err));
  }
  check("正控：Write（整份覆写）同样拦",
    gate({ tool_name: "Write", tool_input: { file_path: path.join(HOME, ".claude", "settings.json") } }).code === 2);
  check("正控：反斜杠路径同样拦（Windows 原生形态）",
    gate({ tool_name: "Write", tool_input: { file_path: `${HOME}\\.claude\\settings.json` } }).code === 2);
  check("逃生阀：DAO_SETTINGS_EDIT_APPROVED=1 → 放行",
    gate(CANARY["G2-live-settings"], { env: { DAO_SETTINGS_EDIT_APPROVED: "1" } }).code === 0);
  check("逃生阀只认 '1'，不认 'true'（免得随手设个值就等于关掉闸）",
    gate(CANARY["G2-live-settings"], { env: { DAO_SETTINGS_EDIT_APPROVED: "true" } }).code === 2);

  const negatives = [
    ["改 git 快照层是正路，不该拦", edit(path.join(REPO, "config-sync", "common", "settings.json"))],
    ["改项目级 .claude/settings.json 不该拦（那不是 cc-switch 投影）",
      edit("D:/frank/mousse-cli/.claude/settings.json")],
    ["改 ~/.claude 下的别的文件不该拦", edit(path.join(HOME, ".claude", "CLAUDE.md"))],
    ["写 _tmp/settings-patch.json 是 dao 指定的降级路径，不该拦",
      edit(path.join(REPO, "_tmp", "settings-patch.json"))],
    ["Read 不该拦（本闸只管写）", { tool_name: "Read", tool_input: { file_path: path.join(HOME, ".claude", "settings.json") } }],
  ];
  for (const [name, p] of negatives) check(`负控：${name}`, gate(p).code === 0, `code=${gate(p).code}`);
}

console.log("\n──── G3 · 对外发布（⑤自主边界：不可逆 + 需用户在场）────");
{
  const positives = [
    "npm publish --access public",
    "pnpm publish",
    "yarn publish",
    "cargo publish",
    "gh release create v1.2.3 --notes x",
    "gh release delete v1.0.0",
    "cd /d/frank/mousse-cli && npm publish",
    "VERSION=1.2.3 cargo publish",
  ];
  for (const c of positives) {
    const r = gate(bash(c));
    check(`正控：${c} → exit 2`, r.code === 2, `code=${r.code} ${r.err.slice(0, 80)}`);
  }
  check("正控：stderr 给得出三条合法路径（说明+dry-run+用户设 env）",
    /--dry-run/.test(gate(bash("npm publish")).err) && /DAO_PUBLISH_APPROVED/.test(gate(bash("npm publish")).err));
  check("正控：PowerShell 工具同样受管", gate({ tool_name: "PowerShell", tool_input: { command: "cargo publish" } }).code === 2);
  check("逃生阀：DAO_PUBLISH_APPROVED=1 → 放行",
    gate(CANARY["G3-publish"], { env: { DAO_PUBLISH_APPROVED: "1" } }).code === 0);

  const negatives = [
    ["--dry-run 是真演练，放行", "npm publish --dry-run"],
    ["cargo publish --dry-run 放行", "cargo publish --dry-run"],
    ["gh release list 只读，放行", "gh release list"],
    ["gh release view 只读，放行", "gh release view v1.0.0"],
    ["npm run build 放行", "npm run build"],
    ["npm install 放行", "npm install"],
    ["带 publish 字样但不是发布命令，放行", "node scripts/publish-notes.mjs"],
    ["字符串字面量里的命令，放行（段首不是它）", 'echo "npm publish"'],
    ["git push 归乙类软提醒，本闸放行", "git push origin main"],
  ];
  for (const [name, c] of negatives) check(`负控：${name}`, gate(bash(c)).code === 0, `code=${gate(bash(c)).code}`);
}

console.log("\n──── G4 · 浏览器 MCP 截图落盘路径（无逃生阀，正路只是换路径）────");
{
  const positives = [
    ["chrome-devtools 落项目根", { tool_name: "mcp__chrome-devtools__take_screenshot", tool_input: { filePath: "D:/frank/mousse-cli/shot.png" } }],
    ["playwright 落 _tmp 但不在 qa 下", { tool_name: "mcp__playwright__browser_take_screenshot", tool_input: { filename: "_tmp/shot.png" } }],
    ["落系统 temp", { tool_name: "mcp__playwright__browser_take_screenshot", tool_input: { filename: "C:/Users/x/AppData/Local/Temp/a.png" } }],
    ["反斜杠路径", { tool_name: "mcp__chrome-devtools__take_screenshot", tool_input: { filePath: "D:\\frank\\mousse-cli\\qa\\a.png" } }],
  ];
  for (const [name, p] of positives) {
    const r = gate(p);
    check(`正控：${name} → exit 2`, r.code === 2, `code=${r.code}`);
  }
  check("正控：stderr 给得出规范路径形态", /_tmp\/qa\/<context>/.test(gate(positives[0][1]).err));
  check("无逃生阀：设满 env 仍拦",
    gate(positives[0][1], { env: { DAO_SETTINGS_EDIT_APPROVED: "1", DAO_PUBLISH_APPROVED: "1", DAO_ALLOW_READONLY_TODO: "1" } }).code === 2);

  const negatives = [
    ["不给路径=内联返回不落盘，放行", { tool_name: "mcp__chrome-devtools__take_screenshot", tool_input: { fullPage: true } }],
    ["绝对路径落 _tmp/qa 下，放行", { tool_name: "mcp__chrome-devtools__take_screenshot", tool_input: { filePath: "D:/frank/mousse-cli/_tmp/qa/pr-1/a.png" } }],
    ["相对路径落 _tmp/qa 下，放行", { tool_name: "mcp__playwright__browser_take_screenshot", tool_input: { filename: "_tmp/qa/run/a.png" } }],
    ["反斜杠的 _tmp\\qa 也认，放行", { tool_name: "mcp__playwright__browser_take_screenshot", tool_input: { filename: "D:\\repo\\_tmp\\qa\\c\\a.png" } }],
    ["非截图工具带路径，放行", { tool_name: "mcp__playwright__browser_navigate", tool_input: { filename: "x.png" } }],
  ];
  for (const [name, p] of negatives) check(`负控：${name}`, gate(p).code === 0, `code=${gate(p).code}`);
}

console.log("\n──── G5 · 只读载体未勾待办（PR body / commit message）────");
{
  const bodyFile = path.join(TMP, "pr-body.md");
  fs.writeFileSync(bodyFile, "## 为什么改\n修了个洞。\n\n## 合并前自检\n- [ ] 验证跑了且过了\n", "utf8");
  const cleanFile = path.join(TMP, "pr-body-clean.md");
  fs.writeFileSync(cleanFile, "## 为什么改\n修了个洞。\n\n- [x] 验证跑了且过了（exit 0）\n", "utf8");

  const positives = [
    ["gh pr create 内联 body 含未勾框", bash('gh pr create --title x --body "- [ ] 还没跑"')],
    ["gh pr edit 内联 body 含未勾框", bash('gh pr edit 42 --body "- [ ] 待补"')],
    ["gh pr create --body-file 指向含未勾框的文件", bash(`gh pr create --title x --body-file ${bodyFile}`, TMP)],
    ["git commit -m 含未勾框", bash('git commit -m "[cc] feat: x\n- [ ] 随后补测试"')],
  ];
  for (const [name, p] of positives) {
    const r = gate(p);
    check(`正控：${name} → exit 2`, r.code === 2, `code=${r.code} ${r.err.slice(0, 80)}`);
    check(`正控：${name} stderr 给得出三选一`, /- \[x\]/.test(r.err) && /可编辑/.test(r.err), r.err.slice(0, 160));
  }
  check("正控：--body-file 用相对路径 + cwd 也能读到",
    gate(bash("gh pr create --title x --body-file pr-body.md", TMP)).code === 2);
  check("逃生阀：DAO_ALLOW_READONLY_TODO=1 → 放行",
    gate(CANARY["G5-readonly-todo"], { env: { DAO_ALLOW_READONLY_TODO: "1" } }).code === 0);

  const negatives = [
    ["已勾的 - [x] 是陈述过去，放行", bash('gh pr create --body "- [x] 跑过了"')],
    ["gh issue create 是可编辑载体，放行", bash('gh issue create --title x --body "- [ ] 待办"')],
    ["gh pr comment 不在本条射程内，放行", bash('gh pr comment 42 --body "- [ ] x"')],
    ["gh pr view 只读，放行", bash("gh pr view 42 --json body")],
    ["--body-file 指向干净文件，放行", bash(`gh pr create --title x --body-file ${cleanFile}`, TMP)],
    ["--body-file 指向不存在的文件 → 放行（明写的漏报面，不是洞）",
      bash("gh pr create --title x --body-file /nope/nothing.md", TMP)],
    ["普通 commit 无待办框，放行", bash('git commit -m "[cc] fix: 修一个 off-by-one"')],
    ["正文里出现减号但不是待办框，放行", bash('git commit -m "[cc] docs: a - b [ok]"')],
    // ↓ 这三条是「检查器把自己数进扫描面」的负控：讨论**本条规则**的正文必然引用那个记号，
    //   裸匹配会让每一份解释本闸的 PR body 都被本闸拦下（本批首稿实测命中）。
    ["散文里反引号引用该记号，放行（否则解释本规则的 PR 永远发不出去）",
      bash('gh pr create --title x --body "本闸拦的是只读载体里的 `- [ ]`，`- [x]` 放行"')],
    ["中文句子中间提到该记号，放行", bash('git commit -m "[cc] feat(gates): 拦未勾的 - [ ] 记号"')],
    ["--body-file 正文里只是引用该记号，放行",
      bash(`gh pr create --title x --body-file ${path.join(TMP, "pr-body-prose.md")}`, TMP)],
  ];
  fs.writeFileSync(path.join(TMP, "pr-body-prose.md"),
    "## 改了什么\n新闸拦的是只读载体里的 `- [ ]` 记号（`- [x]` 放行）。\n", "utf8");
  for (const [name, p] of negatives) check(`负控：${name}`, gate(p).code === 0, `code=${gate(p).code} ${gate(p).err.slice(0, 80)}`);
}

console.log("\n──── 乙类 · dao-tool-nudge 直推主干分支（提醒不阻断，两态）────");
{
  const positives = [
    ["git push origin main", "git push origin main"],
    ["git push origin master", "git push origin master"],
    ["git push -u origin main", "git push -u origin main"],
    ["git push origin HEAD:main", "git push origin HEAD:main"],
    ["git push --force origin main", "git push --force origin main"],
    ["在 && 链后一段", "npm test && git push origin main"],
  ];
  for (const [name, c] of positives) {
    const ctx = nudge(c);
    check(`正控：${name} → 注入 PR-first 提醒`,
      /dao PR-first/.test(ctx) && /dao-pr-merge\.ps1/.test(ctx), JSON.stringify(ctx.slice(0, 80)));
  }
  check("正控：提醒里说明它是默认节律不是禁令（免得被读成硬闸）",
    /非禁令|默认节律/.test(nudge("git push origin main")));

  const negatives = [
    ["推特性分支不该提醒", "git push origin feat/x"],
    ["裸 git push 刻意不认（目标分支看不见）", "git push"],
    ["git push -u origin feature 不该提醒", "git push -u origin feature/abc"],
    ["删远程分支不是直推，不该提醒", "git push origin --delete main"],
    ["git pull 不该提醒", "git pull origin main"],
    ["字面量里的命令不该提醒", 'echo "git push origin main"'],
    ["分支名里含 main 但不是 main，不该提醒", "git push origin domain-fix"],
  ];
  for (const [name, c] of negatives) {
    check(`负控：${name}`, !/dao PR-first/.test(nudge(c)), JSON.stringify(nudge(c).slice(0, 80)));
  }
  check("乙类只提醒不阻断：nudge hook 恒 exit 0",
    spawnSync(process.execPath, [NUDGE], { input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "git push origin main" } }), encoding: "utf8" }).status === 0);
}

console.log("\n──── mutation · 判别力（改坏一处，对应正控必须从红变绿）────");
{
  // 每条：把 hook 源码里的一段判据改成永假，断言那一闸的承重正控由 exit 2 掉成 exit 0。
  // 改的是 _tmp/ 里的副本，真文件全程不碰（下面 canary 段验证这一点）。
  const src = fs.readFileSync(HOOK, "utf8");
  const MUTANTS = [
    ["G1-windows-mcp", "/^mcp__windows[-_]?mcp?[-_]*__/i", "/^__NEVER_MATCHES__/"],
    ["G2-live-settings", '["settings.json", "settings.local.json"]', '["__no-such-file.json"]'],
    ["G3-publish", "/^(npm|pnpm|yarn|bun)\\s+publish\\b/.test(seg) ? seg :", "/^__nope\\b/.test(seg) ? seg :"],
    ["G4-screenshot-path", "if (/(^|\\/)_tmp\\/qa\\//i.test(p)) return null;", "if (true) return null;"],
    // 靶点取赋值左侧而非正则字面量本身：判据被收窄过一次（见 hook 里 UNCHECKED_TODO 的注释），
    // 把整条正则抄进测试会让「判据一改、mutation 靶点失配」变成一个静默失效面。
    ["G5-readonly-todo", "const UNCHECKED_TODO = ", "const UNCHECKED_TODO = /__NEVER_MATCH_TODO__/; const _deadPattern = "],
  ];
  for (const [id, from, to] of MUTANTS) {
    check(`mutation 靶点在源码里唯一存在（${id}）`, src.split(from).length === 2,
      `出现 ${src.split(from).length - 1} 次`);
    const mutantPath = path.join(TMP, `mutant-${id}.js`);
    fs.writeFileSync(mutantPath, src.replace(from, to), "utf8");
    const before = gate(CANARY[id]).code;
    const after = gate(CANARY[id], { script: mutantPath }).code;
    check(`${id}：真文件拦（exit 2）而改坏后不拦（exit 0）⇒ 这条断言真的在测那段判据`,
      before === 2 && after === 0, `before=${before} after=${after}`);
    // 改坏一闸不该顺手把别的闸也弄哑（否则上面那条"变绿"可能是整个 hook 崩了）
    const otherId = id === "G1-windows-mcp" ? "G3-publish" : "G1-windows-mcp";
    check(`${id}：改坏它之后其他闸仍然拦（证明不是整个 hook 崩了）`,
      gate(CANARY[otherId], { script: mutantPath }).code === 2);
  }

  // fail-open 路径：注入一个必抛的判定，断言"放行 + 大声喊"
  const boom = path.join(TMP, "mutant-throw.js");
  fs.writeFileSync(boom, src.replace(
    'if (!/^mcp__windows[-_]?mcp?[-_]*__/i.test(input.tool_name || "")) return null;',
    'throw new Error("injected");'
  ), "utf8");
  const r = gate(CANARY["G3-publish"], { script: boom });
  check("fail-open：守卫自身抛异常 → exit 0（放行，不砖掉会话）", r.code === 0, `code=${r.code}`);
  check("fail-open 不静默：stderr 明说「本次放行」+ 指向 --selfcheck",
    /守卫自身出错/.test(r.err) && /放行/.test(r.err) && /--selfcheck/.test(r.err), r.err.slice(0, 200));
}

console.log("\n──── canary 恒等（mutation 全程没碰过真文件）────");
{
  check("真 hook 文件 sha256 与开跑前一致", sha(HOOK) === PRISTINE_SHA);
  for (const [id, p] of Object.entries(CANARY)) {
    const after = gate(p).code;
    check(`${id}：mutation 前后真文件行为一致（before=${canaryBefore[id]} after=${after}）`,
      after === canaryBefore[id] && after === 2);
  }
}

console.log("\n──── --selfcheck（只断言形态，真实注册状态取决于用户配置）────");
{
  const r = spawnSync(process.execPath, [HOOK, "--selfcheck"], { encoding: "utf8" });
  const out = String(r.stdout || "");
  const shapeOk = /^✓ 已注册于 PreToolUse，matcher=/.test(out) ||
                  /^✗ 未注册：/.test(out) ||
                  /^✗ 读不到 live settings\.json/.test(out);
  check("首行为三种既定形态之一", shapeOk, JSON.stringify(out.split("\n")[0]));
  check("逐闸都各打印一行覆盖面结论", (out.match(/· G\d-|✓ G\d-|✗ G\d-/g) || []).length >= 5, out.slice(0, 400));
  check("末行报闸数与逃生阀清单", /共 5 道闸/.test(out) && /DAO_SETTINGS_EDIT_APPROVED/.test(out), out.slice(-200));
  check("未注册 / 有闸失覆盖 → 退出码非 0（不许把「没接上」报成通过）",
    /^✗/.test(out) ? r.status !== 0 : r.status === 0, `code=${r.status}`);
}

console.log("\n──── 兜底：无关输入一律不拦 ────");
{
  const harmless = [
    ["Read", { tool_name: "Read", tool_input: { file_path: "D:/x/a.md" } }],
    ["Grep", { tool_name: "Grep", tool_input: { pattern: "npm publish" } }],
    ["空输入", {}],
    ["普通 Bash", bash("node scripts/run-tests.mjs")],
    ["普通 Edit", edit("D:/frank/windsurf-dao/ccswitch/dao.md")],
  ];
  for (const [name, p] of harmless) check(`负控：${name} → exit 0`, gate(p).code === 0, `code=${gate(p).code}`);
  const r = spawnSync(process.execPath, [HOOK], { input: "这不是 JSON{{{", encoding: "utf8" });
  check("负控：喂垃圾输入 → exit 0（放行，不因解析失败拦人）", r.status === 0, `code=${r.status}`);
}

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}

console.log(`\n=== 汇总: PASS=${pass} FAIL=${fail} ===`);
process.exit(fail ? 1 : 0);
