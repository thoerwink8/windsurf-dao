// dao-tool-nudge hook 回归网 — 两类提醒的正控 + 误伤负控
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

const path = require("path");
const { spawnSync } = require("child_process");

const REPO = path.resolve(__dirname, "..");
const HOOK = path.join(REPO, "ccswitch", "hooks", "dao-tool-nudge.js");

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

console.log(`\n=== 汇总: PASS=${pass} FAIL=${fail} ===`);
process.exit(fail ? 1 : 0);
