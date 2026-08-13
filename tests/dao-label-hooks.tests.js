// dao-label-hooks.tests.js — scripts/dao-label-hooks.mjs 七个子命令的自测（issue #373）
//
// gh 调用层用假 runner 注入，喂的 JSON 形状照真实 `gh issue list` / `gh pr list` 输出改造
// （字段来自实测：assignees/comments/labels/closingIssuesReferences 等，非内生虚构结构）。
// 每个子命令至少一条正控（触发有产出/exit 1）+ 一条负控（无事/exit 0）。
// inbox-refresh 走 main() 全链路：让脚本真的 writeFileSync 到临时文件，测试直接回读那个真文件，
// 不 mock「写入」这一步本身。
import { readFileSync } from "node:fs";
import {
  EXIT, main, escapeMdCell,
  buildRelayReport, buildGuardAuditReport, buildDefectUnassignedReport,
  buildTaskStaleReport, buildDebtThawReport, buildCandidateSweepReport,
  buildInboxSection70, buildInboxSection71, buildInboxSection69,
  spliceInboxSection, extractReferencedPRs,
  fetchInboxBucket, fetchRelayIssues, fetchGuardAuditData, fetchDefectIssues,
  fetchTaskIssues, fetchDebtThawData, fetchCandidateIssues,
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

console.log("\n=== main() 全链路（inbox-refresh：过滤单子对自己的自指） ===");
{
  // 真机 dry-run 发现的真实 bug：#70/#71/#69 三张收件箱单自己也挂着对应的桶 label
  // （实测确认），不过滤就会出现「#70 需要 #70 处理」这种自指——这里回归它。
  const stubBody70 = spliceInboxSection(
    ["> 说明块", "", "## 当前清单（旧）", "", "## 已消化（留档）", ""].join("\n"),
    "## 当前清单（占位）\n\n占位",
  );
  const bodies = { 70: stubBody70, 71: stubBody70, 69: stubBody70 };
  const runner = (cmd, args) => {
    if (args[0] === "issue" && args[1] === "list") {
      const label = args[args.indexOf("--label") + 1];
      if (label === "待拍板") {
        return {
          status: 0,
          stdout: JSON.stringify([
            { number: 70, title: "📌 待拍板总览", url: "u70", updatedAt: daysAgo(1), labels: [{ name: "待拍板" }] },
            { number: 500, title: "真实待拍板单", url: "u500", updatedAt: daysAgo(1), labels: [{ name: "待拍板" }] },
          ]),
        };
      }
      return { status: 0, stdout: "[]" };
    }
    if (args[0] === "issue" && args[1] === "view") return { status: 0, stdout: JSON.stringify({ body: bodies[args[2]] }) };
    if (args[0] === "issue" && args[1] === "edit") {
      const content = readFileSync(args[args.indexOf("--body-file") + 1], "utf8");
      bodies[args[2]] = content;
      return { status: 0, stdout: "" };
    }
    return { status: 1, stdout: "", stderr: "unexpected" };
  };
  main(["inbox-refresh"], runner, NOW);
  check("自指过滤：#70 不出现在自己的表格数据行里", !bodies[70].includes("[#70]"));
  check("自指过滤：真实单 #500 正常出现", bodies[70].includes("[#500]"));
  check("自指过滤：标题张数按过滤后计（共 1 张，不是 2 张）", bodies[70].includes("共 1 张"));
}

// ══════════════════════════════════════════════════════════════════════
// 9) R1 · 分页：gh 默认 --limit 30 会静默截断，超 30 的部分判定看不见
//    （PR #383 对抗审必修项 R1）。假 runner 精确模拟这个真实行为：
//    不带足够大 --limit 时只吐前 30 条，带了才吐全量——这样「删掉分页参数」
//    这个 mutation 会让下面的断言真的读到红，不是摆设。
// ══════════════════════════════════════════════════════════════════════
console.log("\n=== R1：分页（>30 条不许静默漏单） ===");
function limitAwareRunner(fullList) {
  return (cmd, args) => {
    if (args[0] !== "issue" && args[0] !== "pr") return { status: 1, stdout: "", stderr: "unexpected: " + args.join(" ") };
    const limitIdx = args.indexOf("--limit");
    const limit = limitIdx === -1 ? 30 : Number(args[limitIdx + 1]); // gh 真实默认值：不传就是 30
    const capped = limit >= fullList.length ? fullList : fullList.slice(0, Math.min(limit, 30));
    return { status: 0, stdout: JSON.stringify(capped) };
  };
}
{
  // 候选：35 张，5 张过期（>60 天），其中一张故意放在第 33 条（索引 32，越过默认 30 条截断线）。
  const full = Array.from({ length: 35 }, (_, idx) => ({
    number: 1000 + idx,
    title: `候选样本 ${idx}`,
    url: `u${idx}`,
    updatedAt: idx === 32 ? daysAgo(90) : daysAgo(5), // 只有 #1032 过期，且它排在第 30 条之后
  }));
  const runner = limitAwareRunner(full);

  const truncated = fetchCandidateIssues("x/y", (cmd, args) => {
    // 复现「删掉分页参数」这个 mutation 的效果：把调用方传来的 --limit 连同其值一起剥掉，
    // 让下面这个假 runner 看到的就是「没传 --limit」，从而按 gh 真实默认值截断到 30 条。
    const limitIdx = args.indexOf("--limit");
    const stripped = limitIdx === -1 ? args : [...args.slice(0, limitIdx), ...args.slice(limitIdx + 2)];
    return runner(cmd, stripped);
  });
  check("R1 修前红态复现：不传 --limit 时 gh 只回 30 条（模拟真实截断）", truncated.length === 30);
  const truncatedReport = buildCandidateSweepReport(truncated, NOW);
  check("R1 修前红态复现：截断后看不见 #1032，误报「无事」exit 0", truncatedReport.exit === EXIT.QUIET);

  const full35 = fetchCandidateIssues("x/y", runner); // 脚本真实调用（当前代码已带 --limit 1000）
  check("R1 修后绿：脚本真实调用拿到全部 35 条，不截断", full35.length === 35);
  const fullReport = buildCandidateSweepReport(full35, NOW);
  check("R1 修后绿：#1032 被判定命中，exit 1", fullReport.exit === EXIT.REPORT && fullReport.text.includes("#1032"));
}
{
  // 结构覆盖：所有 issue/pr list 调用点都必须带足够大的 --limit，逐个扫描调用记录，
  // 不止测一条子命令——漏掉任何一个调用点这条都会红。
  const calls = [];
  const recorder = (cmd, args) => {
    calls.push(args);
    if (args[0] === "issue" && args[1] === "list") return { status: 0, stdout: "[]" };
    if (args[0] === "pr" && args[1] === "list") return { status: 0, stdout: "[]" };
    if (args[0] === "issue" && args[1] === "view") return { status: 0, stdout: JSON.stringify({ body: "## 当前清单\n\n## 已消化" }) };
    return { status: 1, stdout: "", stderr: "unexpected" };
  };
  fetchInboxBucket("x/y", "待拍板", recorder);
  fetchRelayIssues("x/y", recorder);
  fetchGuardAuditData("x/y", recorder);
  fetchDefectIssues("x/y", recorder);
  fetchTaskIssues("x/y", recorder);
  fetchDebtThawData("x/y", recorder); // body 为空，不会触发 pr view 调用
  fetchCandidateIssues("x/y", recorder);

  const listCalls = calls.filter((a) => (a[0] === "issue" || a[0] === "pr") && a[1] === "list");
  // 8 = inbox(1) + relay(1) + guard 的 issue list(1) + guard 的 pr list(1) + defect(1) + task(1) + debt(1) + candidate(1)
  check(`R1 结构覆盖：抓到 ${listCalls.length} 条 list 调用（应为 8）`, listCalls.length === 8);
  const missingLimit = listCalls.filter((a) => {
    const i = a.indexOf("--limit");
    return i === -1 || Number(a[i + 1]) < 1000;
  });
  check("R1 结构覆盖：每一条 list 调用都带 --limit >= 1000（零遗漏）", missingLimit.length === 0, JSON.stringify(missingLimit));
}

// ══════════════════════════════════════════════════════════════════════
// 10) R2 · Markdown 转义：标题/标签名含 | ` 换行 时不许拆坏表格列结构
//     （PR #383 对抗审必修项 R2）
// ══════════════════════════════════════════════════════════════════════
console.log("\n=== R2：Markdown 特殊字符转义 ===");
{
  check("escapeMdCell 负控：普通文本原样返回（不过度转义）", escapeMdCell("普通标题") === "普通标题");
  check("escapeMdCell 正控：| 转义", escapeMdCell("危险 | 标题") === "危险 \\| 标题");
  check("escapeMdCell 正控：反引号转义", escapeMdCell("带`code`的标题") === "带\\`code\\`的标题");
  check("escapeMdCell 正控：换行替换成空格（不许拆行）", escapeMdCell("第一行\n第二行\r\n第三行") === "第一行 第二行 第三行");
  check("escapeMdCell 正控：反斜杠先转义（不然后续转义会双重）", escapeMdCell("反\\斜杠") === "反\\\\斜杠");
}
{
  const dangerTitle = "危险标题 | 带`反引号`\n换行";
  const issues = [{
    number: 900, title: dangerTitle, url: "https://x/900", updatedAt: daysAgo(1),
    labels: [{ name: "待拍板" }, { name: "缺陷 | 假注入" }],
  }];
  const section70 = buildInboxSection70(issues, NOW);
  check("R2 #70 正控：标题里的 | 已转义，原始未转义串不出现", !section70.includes("危险标题 | 带`反引号`") && section70.includes("危险标题 \\| 带\\`反引号\\` 换行"));
  check("R2 #70 正控：其他标签列里的 | 也已转义", section70.includes("缺陷 \\| 假注入"));
  const titleLines = section70.split("\n").filter((l) => l.includes("危险标题"));
  check("R2 #70 正控：该行不因换行被拆成两行（表格行必须单行）", titleLines.length === 1 && titleLines[0].includes("换行 |"));

  const section71 = buildInboxSection71(issues, NOW);
  check("R2 #71 正控：标题转义同样生效", section71.includes("危险标题 \\| 带\\`反引号\\` 换行"));

  const section69 = buildInboxSection69(issues, NOW);
  check("R2 #69 正控：标题转义同样生效", section69.includes("危险标题 \\| 带\\`反引号\\` 换行"));
}

console.log(`\ndao-label-hooks.tests  pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
