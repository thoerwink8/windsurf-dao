#!/usr/bin/env node
// dao-label-hooks.mjs — label 体系的确定性巡检钩子集合（issue #373，落地 #360 拍板 2-A 剩余 6 条）
//
// 用户拍板两件：①补齐 #360 设计稿 §1.1 终表「自动化钩子」栏里还没建的 6 条巡检
// ②判定与产出全部代码化——agent 只剩「跑一条命令 + 失败上报」，省 token 省树。
// 本文件就是那「一条命令」：七个子命令，每个都是纯 gh 调用 + 确定性判定，零 agent 判断。
//
// 子命令：
//   inbox-refresh      待拍板/需用户/候选 三类 open 单 → 重写 #70/#71/#69 正文表格（唯一直接写 GitHub 的子命令）
//   relay-check        接力 label open 计数 != 1 → 异常
//   guard-audit        守卫类 open 单关联的 open PR 缺「对抗」记录 → 告警
//   defect-unassigned  缺陷 open 且无 assignee 且无「已派」评论标记 → 清单
//   task-stale         任务 open 且 >30 天无评论 → 降级候选/关单提请清单
//   debt-thaw          欠账 open 且正文引用的 PR 已合并 → 解冻提请清单
//   candidate-sweep    候选 open 且 >60 天无动静 → 关单提请清单
//
// 退出码约定（automation 的 agent 层只认这个）：
//   0 = 无事，什么都不用做
//   1 = 有产出，stdout 就是给人看的报告（inbox-refresh 例外：它的「产出」是三张单正文本身）
//   ≥2 = 脚本自身错（用法/环境/gh 调用失败）——不是「巡检结果」，是「巡检没查成」，两者不能混
//
// gh 调用层可注入：每个子命令拆成 fetchXxx（真打 gh，唯一含副作用的部分）+ buildXxx（纯函数，
// 判定与成文）。测试只喂 buildXxx 用真实 gh 输出改造的 fixture，不 mock 内生结构。
//
// 用法：node scripts/dao-label-hooks.mjs <子命令> [--repo owner/name]
import { spawnSync } from "node:child_process";
import { writeFileSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const EXIT = { QUIET: 0, REPORT: 1, GH_FAIL: 2, USAGE: 3 };
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_REPO = "thoerwink8/windsurf-dao";

const SUBCOMMANDS = [
  "inbox-refresh", "relay-check", "guard-audit", "defect-unassigned",
  "task-stale", "debt-thaw", "candidate-sweep",
];

// ── gh 调用层（唯一含副作用的部分，可注入 runner） ──────────────────────
export function gh(args, runner = spawnSync) {
  const r = runner("gh", args, { encoding: "utf8", windowsHide: true });
  return { code: r.status, out: String(r.stdout || ""), err: String(r.stderr || "") };
}

export function ghJson(args, runner = spawnSync) {
  const r = gh(args, runner);
  if (r.code !== 0) {
    throw new Error(`gh ${args.join(" ")} 失败（exit ${r.code}）：${r.err.trim().slice(0, 200)}`);
  }
  try {
    return JSON.parse(r.out || "[]");
  } catch (e) {
    throw new Error(`gh ${args.join(" ")} 输出不是合法 JSON：${String(e.message)}`);
  }
}

function issueList(repo, label, fields, runner) {
  return ghJson(
    ["issue", "list", "--repo", repo, "--label", label, "--state", "open", "--json", fields.join(",")],
    runner,
  );
}

function fmtDate(iso) {
  return String(iso || "").slice(5, 10) || "??-??";
}

function ageDays(iso, now) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return Infinity;
  return (now - t) / DAY_MS;
}

// ══════════════════════════════════════════════════════════════════════
// 1) inbox-refresh —— 待拍板/需用户/候选 三张收件箱单正文表格重写
//    唯一允许直接写 GitHub 的子命令：它的「产出」就是三张单的正文。
// ══════════════════════════════════════════════════════════════════════

const INBOX_ISSUE_FIELDS = ["number", "title", "url", "updatedAt", "labels"];

export function fetchInboxBucket(repo, label, runner) {
  return issueList(repo, label, INBOX_ISSUE_FIELDS, runner);
}

function agingLine(issues, now) {
  if (issues.length === 0) return null;
  const aged = issues.filter((i) => ageDays(i.updatedAt, now) > 7);
  if (aged.length === 0) {
    const oldest = issues.reduce((a, b) => (ageDays(a.updatedAt, now) > ageDays(b.updatedAt, now) ? a : b));
    return `无老化行（全部单 7 天内有更新，最旧 ${fmtDate(oldest.updatedAt)}）`;
  }
  return `⚠ ${aged.length} 条老化（>7 天无更新）：${aged.map((i) => `#${i.number}`).join(" ")}`;
}

// #70 待拍板：| # | 一句话 | 其他标签 | 最近更新 |
export function buildInboxSection70(issues, now) {
  const heading = `## 当前清单（快照 ${new Date(now).toISOString().slice(0, 10)} · 按 \`label:待拍板\` 实况复核，共 ${issues.length} 张）`;
  const aging = agingLine(issues, now);
  const rows = issues.length === 0
    ? ["| — | *（当前无待拍板单——`label:待拍板` 筛出 0 张 open）* | | |"]
    : issues.map((i) => {
        const other = (i.labels || []).map((l) => l.name).filter((n) => n !== "待拍板").join(" · ") || "—";
        const aged = ageDays(i.updatedAt, now) > 7 ? " ⚠老化" : "";
        return `| [#${i.number}](${i.url}) | ${i.title} | ${other} | ${fmtDate(i.updatedAt)}${aged} |`;
      });
  return [heading, "", aging, "", "| # | 一句话 | 其他标签 | 最近更新 |", "|---|---|---|---|", ...rows]
    .filter((l) => l !== null).join("\n");
}

// #71 需用户：| # | 一句话 | 最近更新 |
export function buildInboxSection71(issues, now) {
  const heading = `## 当前清单（快照 ${new Date(now).toISOString().slice(0, 10)} · 按 \`label:需用户\` 实况复核，共 ${issues.length} 张）`;
  const aging = agingLine(issues, now);
  const rows = issues.length === 0
    ? ["| — | *（当前无需用户单——`label:需用户` 筛出 0 张 open）* | |"]
    : issues.map((i) => {
        const aged = ageDays(i.updatedAt, now) > 7 ? " ⚠老化" : "";
        return `| [#${i.number}](${i.url}) | ${i.title} | ${fmtDate(i.updatedAt)}${aged} |`;
      });
  return [heading, "", aging, "", "| # | 一句话 | 最近更新 |", "|---|---|---|", ...rows]
    .filter((l) => l !== null).join("\n");
}

// #69 候选：| # | 一句话 | AI 背后逻辑（为什么还是候选 + promote 条件） |
// AI背后逻辑列需要判断力，脚本给不出——如实留占位，不假装有判断。
export function buildInboxSection69(issues, now) {
  const heading = `## 当前清单（快照 ${new Date(now).toISOString().slice(0, 10)} · 按 \`label:候选\` 实况复核，共 ${issues.length} 张）`;
  const rows = issues.length === 0
    ? ["| — | *（当前无候选单——`label:候选` 筛出 0 张 open）* | |"]
    : issues.map((i) => `| [#${i.number}](${i.url}) | ${i.title} | （机械生成，无判断依据——需人工/agent 补一句） |`);
  return [heading, "", "| # | 一句话 | AI 背后逻辑（为什么还是候选 + promote 条件） |", "|---|---|---|", ...rows].join("\n");
}

// 只替换「## 当前清单」标题到下一个「## 」/「<details>」之间的区段，
// 前面的用法说明块与后面的「已消化」历史留档一律原样保留——不碰现有正文格式约定。
export function spliceInboxSection(body, newSection) {
  const lines = String(body || "").split(/\r?\n/);
  const startIdx = lines.findIndex((l) => /^## 当前清单/.test(l));
  if (startIdx === -1) {
    throw new Error('正文里找不到 "## 当前清单" 锚点，格式已变，脚本不敢盲写——先人工核对');
  }
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (/^<details>/.test(lines[i]) || /^## /.test(lines[i])) { endIdx = i; break; }
  }
  const before = lines.slice(0, startIdx).join("\n").replace(/\s+$/, "");
  const after = lines.slice(endIdx).join("\n").replace(/^\s+/, "");
  return `${before}\n\n${newSection}\n\n${after}`.trimEnd() + "\n";
}

function writeIssueBody(repo, issueNumber, body, runner) {
  const tmp = join(tmpdir(), `dao-label-hooks-${issueNumber}-${process.pid}.md`);
  writeFileSync(tmp, body, "utf8");
  try {
    const r = gh(["issue", "edit", String(issueNumber), "--repo", repo, "--body-file", tmp], runner);
    if (r.code !== 0) throw new Error(`gh issue edit #${issueNumber} 失败：${r.err.trim().slice(0, 200)}`);
    // 官方铁律：正文写完必须回读一次，核对没有被 shell 通道改写。
    const back = ghJson(["issue", "view", String(issueNumber), "--repo", repo, "--json", "body"], runner);
    if (!back || typeof back.body !== "string" || !back.body.includes(newSectionMarker(body))) {
      throw new Error(`#${issueNumber} 回读校验失败：写入内容与预期不符`);
    }
  } finally {
    try { unlinkSync(tmp); } catch { /* 临时文件清理失败不影响主流程 */ }
  }
}
function newSectionMarker(body) {
  const m = String(body).match(/^## 当前清单.*$/m);
  return m ? m[0] : "## 当前清单";
}

function runInboxRefresh(repo, runner, now = Date.now()) {
  const buckets = [
    { issue: 70, label: "待拍板", build: buildInboxSection70 },
    { issue: 71, label: "需用户", build: buildInboxSection71 },
    { issue: 69, label: "候选", build: buildInboxSection69 },
  ];
  const report = [];
  for (const b of buckets) {
    // 三张收件箱单自己也挂着对应桶的 label（实测 #70/#71/#69 皆如此）——
    // 不过滤会让单子在自己的表里列出自己，读者会看到「#71 需要 #71 处理」这种自指怪话。
    const issues = fetchInboxBucket(repo, b.label, runner).filter((i) => i.number !== b.issue);
    const section = b.build(issues, now);
    const currentBody = ghJson(["issue", "view", String(b.issue), "--repo", repo, "--json", "body"], runner).body;
    const newBody = spliceInboxSection(currentBody, section);
    if (newBody === currentBody) {
      report.push(`#${b.issue}（${b.label}）：内容无变化，跳过写入`);
      continue;
    }
    writeIssueBody(repo, b.issue, newBody, runner);
    report.push(`#${b.issue}（${b.label}）：已刷新，共 ${issues.length} 张 open`);
  }
  process.stdout.write(report.join("\n") + "\n");
  return EXIT.QUIET; // inbox-refresh 的产出就是三张单正文本身，自身不再需要 agent 二次落 GitHub
}

// ══════════════════════════════════════════════════════════════════════
// 2) relay-check —— 接力单唯一性
// ══════════════════════════════════════════════════════════════════════

export function fetchRelayIssues(repo, runner) {
  return issueList(repo, "接力", ["number", "title", "url"], runner);
}

export function buildRelayReport(issues) {
  if (issues.length === 1) {
    return { exit: EXIT.QUIET, text: `接力单唯一：#${issues[0].number}` };
  }
  const list = issues.map((i) => `#${i.number} ${i.title} ${i.url}`).join("\n");
  const head = issues.length === 0
    ? "接力单异常：0 张 open（接力断了，/dao-resume 找不到接力单）"
    : `接力单异常：${issues.length} 张 open（应恰好 1 张，/dao-resume 会读错）`;
  return { exit: EXIT.REPORT, text: issues.length === 0 ? head : `${head}\n${list}` };
}

function runRelayCheck(repo, runner) {
  const r = buildRelayReport(fetchRelayIssues(repo, runner));
  process.stdout.write(r.text + "\n");
  return r.exit;
}

// ══════════════════════════════════════════════════════════════════════
// 3) guard-audit —— 守卫类 open 单关联的 open PR 缺「对抗」记录
// ══════════════════════════════════════════════════════════════════════

const GUARD_ISSUE_FIELDS = ["number", "title", "url"];
const GUARD_PR_FIELDS = ["number", "title", "body", "url", "comments", "closingIssuesReferences"];

export function fetchGuardAuditData(repo, runner) {
  const guardIssues = issueList(repo, "守卫类", GUARD_ISSUE_FIELDS, runner);
  const openPRs = ghJson(
    ["pr", "list", "--repo", repo, "--state", "open", "--json", GUARD_PR_FIELDS.join(",")],
    runner,
  );
  return { guardIssues, openPRs };
}

function prReferencesIssue(pr, issueNumber) {
  if ((pr.closingIssuesReferences || []).some((r) => r.number === issueNumber)) return true;
  const hay = `${pr.title || ""}\n${pr.body || ""}`;
  return new RegExp(`#${issueNumber}\\b`).test(hay);
}

function prHasAdversaryRecord(pr) {
  if (/对抗/.test(pr.body || "")) return true;
  return (pr.comments || []).some((c) => /对抗/.test(c.body || ""));
}

export function buildGuardAuditReport({ guardIssues, openPRs }) {
  const violations = [];
  const skippedNoPR = [];
  for (const issue of guardIssues) {
    const linked = openPRs.filter((pr) => prReferencesIssue(pr, issue.number));
    if (linked.length === 0) { skippedNoPR.push(issue.number); continue; }
    const covered = linked.some((pr) => prHasAdversaryRecord(pr));
    if (!covered) {
      violations.push(`#${issue.number} ${issue.title}（关联 PR ${linked.map((p) => "#" + p.number).join(",")} 无「对抗」字样）`);
    }
  }
  if (violations.length === 0) {
    return { exit: EXIT.QUIET, text: `守卫类无违例（${guardIssues.length} 张 open，${skippedNoPR.length} 张无关联 open PR 跳过）` };
  }
  return { exit: EXIT.REPORT, text: `守卫类缺对抗记录 ${violations.length} 条：\n${violations.join("\n")}` };
}

function runGuardAudit(repo, runner) {
  const r = buildGuardAuditReport(fetchGuardAuditData(repo, runner));
  process.stdout.write(r.text + "\n");
  return r.exit;
}

// ══════════════════════════════════════════════════════════════════════
// 4) defect-unassigned —— 缺陷 open 且无 assignee 且无「已派」评论标记
// ══════════════════════════════════════════════════════════════════════

const DEFECT_FIELDS = ["number", "title", "url", "assignees", "comments"];
const DISPATCHED_MARK = /⚔️\s*已派/;

export function fetchDefectIssues(repo, runner) {
  return issueList(repo, "缺陷", DEFECT_FIELDS, runner);
}

export function buildDefectUnassignedReport(issues) {
  const violations = issues.filter((i) => {
    const hasAssignee = (i.assignees || []).length > 0;
    const hasDispatchMark = (i.comments || []).some((c) => DISPATCHED_MARK.test(c.body || ""));
    return !hasAssignee && !hasDispatchMark;
  });
  if (violations.length === 0) {
    return { exit: EXIT.QUIET, text: `缺陷无未派单（${issues.length} 张 open 全部有 assignee 或已派标记）` };
  }
  const list = violations.map((i) => `#${i.number} ${i.title} ${i.url}`).join("\n");
  return { exit: EXIT.REPORT, text: `未派单的缺陷 ${violations.length} 条（无 assignee 也无「⚔️ 已派」评论）：\n${list}` };
}

function runDefectUnassigned(repo, runner) {
  const r = buildDefectUnassignedReport(fetchDefectIssues(repo, runner));
  process.stdout.write(r.text + "\n");
  return r.exit;
}

// ══════════════════════════════════════════════════════════════════════
// 5) task-stale —— 任务 open 且 >30 天无评论
// ══════════════════════════════════════════════════════════════════════

const TASK_FIELDS = ["number", "title", "url", "createdAt", "comments"];
const STALE_DAYS = 30;

export function fetchTaskIssues(repo, runner) {
  return issueList(repo, "任务", TASK_FIELDS, runner);
}

function lastActivityAt(issue) {
  const comments = issue.comments || [];
  if (comments.length === 0) return issue.createdAt;
  return comments.reduce((latest, c) => (Date.parse(c.createdAt) > Date.parse(latest) ? c.createdAt : latest), comments[0].createdAt);
}

export function buildTaskStaleReport(issues, now) {
  const stale = issues
    .map((i) => ({ i, last: lastActivityAt(i), days: ageDays(lastActivityAt(i), now) }))
    .filter((x) => x.days > STALE_DAYS);
  if (stale.length === 0) {
    return { exit: EXIT.QUIET, text: `任务无 >${STALE_DAYS} 天无评论的（${issues.length} 张 open）` };
  }
  const list = stale.map((x) => `#${x.i.number} ${x.i.title}（${Math.floor(x.days)} 天无评论，最近活动 ${fmtDate(x.last)}）${x.i.url}`).join("\n");
  return { exit: EXIT.REPORT, text: `>${STALE_DAYS} 天无评论的任务 ${stale.length} 条，提请降候选或关单：\n${list}` };
}

function runTaskStale(repo, runner) {
  const r = buildTaskStaleReport(fetchTaskIssues(repo, runner), Date.now());
  process.stdout.write(r.text + "\n");
  return r.exit;
}

// ══════════════════════════════════════════════════════════════════════
// 6) debt-thaw —— 欠账 open 且正文引用的 PR 已合并
// ══════════════════════════════════════════════════════════════════════

const DEBT_FIELDS = ["number", "title", "url", "body"];
const PR_REF_RE = /PR\s*#(\d+)/g;

export function extractReferencedPRs(body) {
  const nums = new Set();
  for (const m of String(body || "").matchAll(PR_REF_RE)) nums.add(Number(m[1]));
  return [...nums];
}

export function fetchDebtThawData(repo, runner) {
  const debtIssues = issueList(repo, "欠账", DEBT_FIELDS, runner);
  const prNumbers = [...new Set(debtIssues.flatMap((i) => extractReferencedPRs(i.body)))];
  const prStates = {};
  for (const n of prNumbers) {
    try {
      prStates[n] = ghJson(["pr", "view", String(n), "--repo", repo, "--json", "number,state,mergedAt"], runner);
    } catch {
      prStates[n] = null; // 引用号可能不是 PR（正则近似），查不到就当「未知」不当「已合并」
    }
  }
  return { debtIssues, prStates };
}

export function buildDebtThawReport({ debtIssues, prStates }) {
  const thawable = [];
  for (const issue of debtIssues) {
    const refs = extractReferencedPRs(issue.body);
    const merged = refs.filter((n) => prStates[n] && prStates[n].state === "MERGED");
    if (merged.length > 0) {
      thawable.push(`#${issue.number} ${issue.title}（引用 PR ${merged.map((n) => "#" + n).join(",")} 已合并）${issue.url}`);
    }
  }
  if (thawable.length === 0) {
    return { exit: EXIT.QUIET, text: `欠账无可解冻的（${debtIssues.length} 张 open，引用判据是近似正则 /PR\\s*#(\\d+)/）` };
  }
  return { exit: EXIT.REPORT, text: `可解冻欠账 ${thawable.length} 条（引用的 PR 已合并，判据近似见脚本头注）：\n${thawable.join("\n")}` };
}

function runDebtThaw(repo, runner) {
  const r = buildDebtThawReport(fetchDebtThawData(repo, runner));
  process.stdout.write(r.text + "\n");
  return r.exit;
}

// ══════════════════════════════════════════════════════════════════════
// 7) candidate-sweep —— 候选 open 且 >60 天无动静
// ══════════════════════════════════════════════════════════════════════

const CANDIDATE_FIELDS = ["number", "title", "url", "updatedAt"];
const CANDIDATE_STALE_DAYS = 60;

export function fetchCandidateIssues(repo, runner) {
  return issueList(repo, "候选", CANDIDATE_FIELDS, runner);
}

export function buildCandidateSweepReport(issues, now) {
  const stale = issues.filter((i) => ageDays(i.updatedAt, now) > CANDIDATE_STALE_DAYS);
  if (stale.length === 0) {
    return { exit: EXIT.QUIET, text: `候选无 >${CANDIDATE_STALE_DAYS} 天无动静的（${issues.length} 张 open）` };
  }
  const list = stale.map((i) => `#${i.number} ${i.title}（${Math.floor(ageDays(i.updatedAt, now))} 天无更新）${i.url}`).join("\n");
  return { exit: EXIT.REPORT, text: `>${CANDIDATE_STALE_DAYS} 天无动静的候选 ${stale.length} 条，提请关单：\n${list}` };
}

function runCandidateSweep(repo, runner) {
  const r = buildCandidateSweepReport(fetchCandidateIssues(repo, runner), Date.now());
  process.stdout.write(r.text + "\n");
  return r.exit;
}

// ── CLI 分发 ─────────────────────────────────────────────────────────

function usage() {
  process.stderr.write(
    `用法：node scripts/dao-label-hooks.mjs <子命令> [--repo owner/name]\n` +
    `子命令：${SUBCOMMANDS.join(" / ")}\n` +
    `退出码：0=无事 · 1=有产出(stdout即报告) · ≥2=脚本自身错\n`,
  );
}

export function main(argv, runner = spawnSync, now = Date.now()) {
  const sub = argv[0];
  let repo = DEFAULT_REPO;
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === "--repo") repo = argv[++i] || repo;
  }
  if (!sub || !SUBCOMMANDS.includes(sub)) {
    usage();
    return EXIT.USAGE;
  }
  try {
    switch (sub) {
      case "inbox-refresh": return runInboxRefresh(repo, runner, now);
      case "relay-check": return runRelayCheck(repo, runner);
      case "guard-audit": return runGuardAudit(repo, runner);
      case "defect-unassigned": return runDefectUnassigned(repo, runner);
      case "task-stale": return runTaskStale(repo, runner);
      case "debt-thaw": return runDebtThaw(repo, runner);
      case "candidate-sweep": return runCandidateSweep(repo, runner);
      default: usage(); return EXIT.USAGE;
    }
  } catch (e) {
    process.stderr.write(`dao-label-hooks ${sub} 脚本自身错：${String(e.message || e)}\n`);
    return EXIT.GH_FAIL;
  }
}

if (process.argv[1] && process.argv[1].endsWith("dao-label-hooks.mjs")) {
  process.exit(main(process.argv.slice(2)));
}
