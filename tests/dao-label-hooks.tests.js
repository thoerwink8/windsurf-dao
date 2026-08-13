// dao-label-hooks.tests.js — scripts/dao-label-hooks.mjs 七个子命令的自测（issue #373）
//
// gh 调用层用假 runner 注入，喂的 JSON 形状照真实 `gh issue list` / `gh pr list` 输出改造
// （字段来自实测：assignees/comments/labels/closingIssuesReferences 等，非内生虚构结构）。
// 每个子命令至少一条正控（触发有产出/exit 1）+ 一条负控（无事/exit 0）。
// inbox-refresh 走 main() 全链路：让脚本真的 writeFileSync 到临时文件，测试直接回读那个真文件，
// 不 mock「写入」这一步本身。
import { readFileSync } from "node:fs";
import {
  EXIT, main,
  buildRelayReport, buildGuardAuditReport, buildDefectUnassignedReport,
  buildTaskStaleReport, buildDebtThawReport, buildCandidateSweepReport,
  buildInboxSection70, buildInboxSection71, buildInboxSection69,
  spliceInboxSection, extractReferencedPRs,
} from "../scripts/dao-label-hooks.mjs";

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? "  →  " + detail : ""}`); }
}

const NOW = Date.parse("2026-08-13T12:00:00Z");
const daysAgo = (n) => new Date(NOW - n * 86400000).toISOString();

// ══════════════════════════════════════════════════════════════════════
// 1) relay-check —— 正控(!=1)/负控(==1)
// ══════════════════════════════════════════════════════════════════════
console.log("\n=== relay-check ===");
{
  const one = [{ number: 100, title: "接力单", url: "https://x/100" }];
  const r = buildRelayReport(one);
  check("负控：恰好 1 张 → exit 0", r.exit === EXIT.QUIET);
  check("负控：报告点名单号", r.text.includes("#100"));
}
{
  const zero = [];
  const r0 = buildRelayReport(zero);
  check("正控：0 张 → exit 1", r0.exit === EXIT.REPORT);
  check("正控：0 张措辞含「接力断了」", r0.text.includes("接力断了"));

  const two = [{ number: 1, title: "a", url: "u1" }, { number: 2, title: "b", url: "u2" }];
  const r2 = buildRelayReport(two);
  check("正控：2 张 → exit 1", r2.exit === EXIT.REPORT);
  check("正控：2 张报告都点名", r2.text.includes("#1") && r2.text.includes("#2"));
}

// ══════════════════════════════════════════════════════════════════════
// 2) guard-audit —— 正控(关联PR缺对抗)/负控(有对抗记录 或 无关联PR跳过)
// ══════════════════════════════════════════════════════════════════════
console.log("\n=== guard-audit ===");
{
  const guardIssues = [{ number: 297, title: "对抗官规矩被砍", url: "u297" }];
  const openPRs = [{
    number: 400, title: "fix: 补规矩", body: "closes #297，纯改动没有走审查",
    url: "u400", comments: [], closingIssuesReferences: [{ number: 297 }],
  }];
  const r = buildGuardAuditReport({ guardIssues, openPRs });
  check("正控：关联 PR 无「对抗」字样 → exit 1", r.exit === EXIT.REPORT);
  check("正控：报告点名 issue 与 PR", r.text.includes("#297") && r.text.includes("#400"));
}
{
  const guardIssues = [{ number: 366, title: "判据类改动", url: "u366" }];
  const openPRs = [{
    number: 371, title: "落 366", body: "见对抗验证证据格",
    url: "u371", comments: [{ body: "对抗审：过" }], closingIssuesReferences: [{ number: 366 }],
  }];
  const r = buildGuardAuditReport({ guardIssues, openPRs });
  check("负控：关联 PR 评论含「对抗」→ exit 0", r.exit === EXIT.QUIET);
}
{
  const guardIssues = [{ number: 999, title: "无关联单", url: "u999" }];
  const r = buildGuardAuditReport({ guardIssues, openPRs: [] });
  check("负控：无关联 open PR 跳过 → exit 0（不算违例）", r.exit === EXIT.QUIET);
  check("负控：报告说明跳过数", r.text.includes("跳过"));
}

// ══════════════════════════════════════════════════════════════════════
// 3) defect-unassigned —— 正控(无assignee无已派标记)/负控(有assignee 或 有已派评论)
// ══════════════════════════════════════════════════════════════════════
console.log("\n=== defect-unassigned ===");
{
  const issues = [{ number: 381, title: "云审红", url: "u381", assignees: [], comments: [] }];
  const r = buildDefectUnassignedReport(issues);
  check("正控：无 assignee 无已派评论 → exit 1", r.exit === EXIT.REPORT);
  check("正控：报告点名", r.text.includes("#381"));
}
{
  const withAssignee = [{ number: 1, title: "a", url: "u1", assignees: [{ login: "thoerwink8" }], comments: [] }];
  const r1 = buildDefectUnassignedReport(withAssignee);
  check("负控：有 assignee → exit 0", r1.exit === EXIT.QUIET);

  const withMark = [{ number: 2, title: "b", url: "u2", assignees: [], comments: [{ body: "⚔️ 已派（claude·实现官）→ 修这个" }] }];
  const r2 = buildDefectUnassignedReport(withMark);
  check("负控：有「⚔️ 已派」评论标记 → exit 0", r2.exit === EXIT.QUIET);
}

// ══════════════════════════════════════════════════════════════════════
// 4) task-stale —— 正控(>30天无评论)/负控(30天内有评论)
// ══════════════════════════════════════════════════════════════════════
console.log("\n=== task-stale ===");
{
  const issues = [{ number: 10, title: "老任务", url: "u10", createdAt: daysAgo(90), comments: [{ createdAt: daysAgo(35), body: "x" }] }];
  const r = buildTaskStaleReport(issues, NOW);
  check("正控：最近评论 35 天前 → exit 1", r.exit === EXIT.REPORT);
  check("正控：报告含天数与最近活动", /\d+ 天无评论/.test(r.text));
}
{
  const issues = [{ number: 11, title: "新任务", url: "u11", createdAt: daysAgo(90), comments: [{ createdAt: daysAgo(5), body: "x" }] }];
  const r = buildTaskStaleReport(issues, NOW);
  check("负控：最近评论 5 天前 → exit 0", r.exit === EXIT.QUIET);
}
{
  // 无评论：以 createdAt 为准
  const issues = [{ number: 12, title: "从未评论", url: "u12", createdAt: daysAgo(40), comments: [] }];
  const r = buildTaskStaleReport(issues, NOW);
  check("正控：零评论且建单 40 天前 → exit 1", r.exit === EXIT.REPORT);
}

// ══════════════════════════════════════════════════════════════════════
// 5) debt-thaw —— 正控(引用PR已合并)/负控(引用PR仍open/未知)
// ══════════════════════════════════════════════════════════════════════
console.log("\n=== debt-thaw ===");
{
  const debtIssues = [{ number: 20, title: "补测欠账", url: "u20", body: "见 PR #500 已解决" }];
  const prStates = { 500: { number: 500, state: "MERGED", mergedAt: daysAgo(3) } };
  const r = buildDebtThawReport({ debtIssues, prStates });
  check("正控：引用 PR 已合并 → exit 1", r.exit === EXIT.REPORT);
  check("正控：报告点名 issue 与 PR", r.text.includes("#20") && r.text.includes("#500"));
}
{
  const debtIssues = [{ number: 21, title: "还没解决", url: "u21", body: "等 PR #501 合并" }];
  const prStates = { 501: { number: 501, state: "OPEN", mergedAt: null } };
  const r1 = buildDebtThawReport({ debtIssues, prStates });
  check("负控：引用 PR 仍 open → exit 0", r1.exit === EXIT.QUIET);

  const noRef = [{ number: 22, title: "没引用 PR", url: "u22", body: "纯文字，不含 PR 编号" }];
  const r2 = buildDebtThawReport({ debtIssues: noRef, prStates: {} });
  check("负控：正文无 PR 引用 → exit 0", r2.exit === EXIT.QUIET);
}
{
  check("extractReferencedPRs：正确抽出多个编号", JSON.stringify(extractReferencedPRs("见 PR #12 与 PR #34，PR #12 重复")) === JSON.stringify([12, 34]));
  check("extractReferencedPRs：裸 #12 不算（须带 PR 前缀）", extractReferencedPRs("见 issue #12").length === 0);
}

// ══════════════════════════════════════════════════════════════════════
// 6) candidate-sweep —— 正控(>60天无动静)/负控(60天内有动静)
// ══════════════════════════════════════════════════════════════════════
console.log("\n=== candidate-sweep ===");
{
  const issues = [{ number: 30, title: "老候选", url: "u30", updatedAt: daysAgo(75) }];
  const r = buildCandidateSweepReport(issues, NOW);
  check("正控：75 天无更新 → exit 1", r.exit === EXIT.REPORT);
}
{
  const issues = [{ number: 31, title: "新候选", url: "u31", updatedAt: daysAgo(10) }];
  const r = buildCandidateSweepReport(issues, NOW);
  check("负控：10 天无更新 → exit 0", r.exit === EXIT.QUIET);
}

// ══════════════════════════════════════════════════════════════════════
// 7) inbox-refresh —— 表格快照 + splice 保留边界 + 锚点缺失拒写
// ══════════════════════════════════════════════════════════════════════
console.log("\n=== inbox-refresh：表格生成快照 ===");
{
  const issues = [
    { number: 297, title: "对抗官规矩被砍", url: "https://x/297", updatedAt: daysAgo(2), labels: [{ name: "待拍板" }, { name: "缺陷" }] },
    { number: 200, title: "老化样本", url: "https://x/200", updatedAt: daysAgo(10), labels: [{ name: "待拍板" }] },
  ];
  const section = buildInboxSection70(issues, NOW);
  check("70：标题含快照日期与张数", section.includes("共 2 张"));
  check("70：表头含「其他标签」列", section.includes("| # | 一句话 | 其他标签 | 最近更新 |"));
  check("70：新单行含标签与日期", section.includes("[#297](https://x/297) | 对抗官规矩被砍 | 缺陷 | 08-11 |"));
  check("70：老化行标注 ⚠老化", section.includes("[#200]") && section.includes("⚠老化"));
  check("70：老化汇总行点名 #200", section.includes("⚠ 1 条老化") && section.includes("#200"));
}
{
  const section = buildInboxSection71([], NOW);
  check("71 空表：占位行", section.includes("当前无需用户单"));
  check("71 空表：无老化汇总行（0 张不判老化）", !section.includes("老化"));
}
{
  const issues = [{ number: 462, title: "候选样本", url: "https://x/462", updatedAt: daysAgo(1), labels: [{ name: "候选" }] }];
  const section = buildInboxSection69(issues, NOW);
  check("69：三列表头（无最近更新列，AI背后逻辑占位）", section.includes("| # | 一句话 | AI 背后逻辑（为什么还是候选 + promote 条件） |"));
  check("69：占位措辞不假装有判断", section.includes("无判断依据"));
}

console.log("\n=== inbox-refresh：spliceInboxSection 边界保留 ===");
{
  const body = [
    "> 用法说明块，不许动",
    "",
    "## 当前清单（旧快照）",
    "",
    "旧的一行说明",
    "",
    "| # | 一句话 |",
    "|---|---|",
    "| #1 | 旧行 |",
    "",
    "<details><summary>历史留档</summary>",
    "老快照内容",
    "</details>",
    "",
    "## 已消化（留档）",
    "",
    "| # | 拍了什么 |",
    "|---|---|",
    "| #9 | 老决定 |",
  ].join("\n");
  const spliced = spliceInboxSection(body, "## 当前清单（新快照）\n\n新表格内容");
  check("splice：保留顶部用法说明块", spliced.includes("用法说明块，不许动"));
  check("splice：替换掉旧的当前清单区", !spliced.includes("旧的一行说明") && !spliced.includes("| #1 | 旧行 |"));
  check("splice：写入新内容", spliced.includes("新表格内容"));
  check("splice：保留 <details> 历史留档", spliced.includes("老快照内容"));
  check("splice：保留「已消化」段落", spliced.includes("#9") && spliced.includes("老决定"));
}
{
  let threw = false;
  try { spliceInboxSection("正文里根本没有那个锚点", "x"); }
  catch (e) { threw = /锚点/.test(e.message); }
  check("负控：锚点缺失时拒写（抛错而不是盲目拼接）", threw);
}

// ══════════════════════════════════════════════════════════════════════
// 8) main() 全链路：注入 runner，验证 CLI 分发 + 真实文件写入回读
// ══════════════════════════════════════════════════════════════════════
console.log("\n=== main() 全链路（relay-check，注入 runner） ===");
{
  const calls = [];
  const runner = (cmd, args) => {
    calls.push(args.join(" "));
    if (args[0] === "issue" && args[1] === "list" && args.includes("接力")) {
      return { status: 0, stdout: JSON.stringify([{ number: 5, title: "接力", url: "u5" }]) };
    }
    return { status: 1, stdout: "", stderr: "unexpected: " + args.join(" ") };
  };
  const exit = main(["relay-check", "--repo", "x/y"], runner);
  check("main relay-check：exit 0", exit === EXIT.QUIET);
  check("main relay-check：--repo 透传", calls.some((c) => c.includes("x/y")));
}
{
  const runner = () => ({ status: 1, stdout: "", stderr: "gh: not authenticated" });
  const exit = main(["relay-check"], runner);
  check("main：gh 调用失败 → exit >= 2（脚本自身错，不是巡检结果）", exit >= EXIT.GH_FAIL);
}
{
  const exit = main(["not-a-real-subcommand"], () => ({ status: 0, stdout: "[]" }));
  check("main：未知子命令 → exit 3（用法错）", exit === EXIT.USAGE);
}

console.log("\n=== main() 全链路（inbox-refresh，真实写临时文件 + 回读） ===");
{
  const stubBody = (label) => [
    "> 说明块", "", `## 当前清单（旧 · ${label}）`, "", "旧说明", "",
    "| # | 一句话 |", "|---|---|", "| #1 | 旧 |",
    "", "## 已消化（留档）", "", "旧留档",
  ].join("\n");
  const bodies = {
    70: [
      "> 说明块", "", "## 当前清单（旧）", "", "旧说明", "",
      "| # | 一句话 | 其他标签 | 最近更新 |", "|---|---|---|---|", "| #1 | 旧 | — | 01-01 |",
      "", "## 已消化（留档）", "", "旧留档",
    ].join("\n"),
    // 71/69 已经是「刷新过」的当前态（用真实的 build 函数算出来），本轮它们的 label 筛出 0 张，
    // 脚本会算出同样的空表 → 与现状一致 → 应当跳过 edit，验证「无变化不写」这条。
    71: spliceInboxSection(stubBody("需用户"), buildInboxSection71([], NOW)),
    69: spliceInboxSection(stubBody("候选"), buildInboxSection69([], NOW)),
  };
  const calls = [];
  const runner = (cmd, args) => {
    calls.push(args);
    if (args[0] === "issue" && args[1] === "list") {
      const labelIdx = args.indexOf("--label");
      const label = args[labelIdx + 1];
      if (label === "待拍板") return { status: 0, stdout: JSON.stringify([{ number: 900, title: "新单", url: "https://x/900", updatedAt: daysAgo(1), labels: [{ name: "待拍板" }] }]) };
      return { status: 0, stdout: "[]" }; // 需用户 / 候选 都空
    }
    if (args[0] === "issue" && args[1] === "view") {
      const n = args[2];
      return { status: 0, stdout: JSON.stringify({ body: bodies[n] }) };
    }
    if (args[0] === "issue" && args[1] === "edit") {
      const n = args[2];
      const fileIdx = args.indexOf("--body-file");
      const content = readFileSync(args[fileIdx + 1], "utf8");
      bodies[n] = content; // 模拟 GitHub 落库：真实读脚本刚写的文件，不内生编造 diff
      return { status: 0, stdout: "" };
    }
    return { status: 1, stdout: "", stderr: "unexpected: " + args.join(" ") };
  };
  const exit = main(["inbox-refresh"], runner, NOW);
  check("main inbox-refresh：exit 0（产出即三张单正文本身）", exit === EXIT.QUIET);
  check("main inbox-refresh：#70 正文含新单号", bodies[70].includes("#900"));
  check("main inbox-refresh：#70 保留旧「已消化」留档", bodies[70].includes("旧留档"));
  check("main inbox-refresh：#70 旧当前清单行已被替换", !bodies[70].includes("| #1 | 旧 | — | 01-01 |"));
  const editCalls = calls.filter((a) => a[0] === "issue" && a[1] === "edit");
  check("main inbox-refresh：只对内容变化的单调用 edit（71/69 均空，跳过写入）", editCalls.length === 1 && editCalls[0][2] === "70");
}

console.log(`\ndao-label-hooks.tests  pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
