#!/usr/bin/env node
// dao-orch.mjs — Orca 派单薄封装：一条命令完成「拼 spec → 建 Task → 起 worker」
//
// 为什么需要它：派单书模板靠人记，实测携带率分裂（跟着固定模板走 100%，要现场判断的只有个位数）。
// 把模板搬进脚本 = 每次派单强制走同一形态。
//
// 2026-08-12（issue #324 B 批）改了一件事：**不再把条款渲染进 spec**。
// 原来那半靠一条渲染管线按工人类型现切条款，管线随条款元数据链整体退役；
// 现在 spec 第一行让工人**自己去 Read 那份便签**——现场读到的永远是盘上最新版，
// 而渲染进 spec 的是派单那一刻的快照。少一个会过期的中间层。
//
// 2026-08-13（issue #405）再削一刀：开工三步的正文也搬出去了（dao-worker-preamble.md），
// spec 首行只剩一句指针。骨架换成 dao-dispatch.md §四 的四格——
// 【边界】那一格由调用方写进 --spec-file 正文，本脚本只保证首行、【任务】、【验收】、【审计锚】就位。
//
// 用法：
//   node scripts/dao-orch.mjs dispatch --role <官种> --spec-file <任务正文.md>
//     [--worktree current] [--agent pi] [--model <id>] [--issue <N>] [--dry-run]
//
// --dry-run 只打印拼装结果与将执行的命令，不碰 Orca（测试与预览用）。
// 真跑要求：orchestration 已绑定 Run（orca orchestration run-create / run-use 先做）。
// 退出码：0 成 · 1 执行失败 · 2 用法错

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
// 首行指到 PREAMBLE，PREAMBLE 再指到 NOTES —— 两跳都得真在盘上，缺哪一跳都是「指向空气的指针」。
const PREAMBLE = "ccswitch/rules/dao-worker-preamble.md";
const NOTES = "ccswitch/rules/dao-officer-clauses.md";
const ROLES = ["general", "reviewer", "implementer", "adversary", "scout", "dogfood"];
const ORCA = process.env.ORCA_BIN || "orca";

const EXIT_OK = 0, EXIT_FAIL = 1, EXIT_USAGE = 2;

export function buildSpec({ role, taskBody, issue, preamblePath = PREAMBLE }) {
  return [
    `开工先 Read \`<dao 仓根>/${preamblePath}\`，照做（你这一类工人是 ${role}）。`,
    ``,
    `【任务】`,
    taskBody.trim(),
    ``,
    `【验收】完成时发一次 worker_done（--outcome succeeded|failed --files-modified ... --report-path ...），并把交活单 JSON 落盘为 report 文件：`,
    `{"task":"${issue ? `issue #${issue}` : "<任务标识>"}","commits":["<短哈希>"],"verify":[{"cmd":"<命令>","exit":0,"seconds":N}],"files":["<相对路径>"],"guardEvidence":"<仅护栏类改动必填：先破再验两态记录>","notes":"<可选>"}`,
    `交活单会被 scripts/dao-exit-gate.mjs 机核（格式/凭据/边界/卫生/限时重放五道秒级门）；缺字段或与盘上对不上会被自动打回，最多两轮。`,
    ``,
    issue
      ? `【审计锚】争议以 issue #${issue} 的拍板评论为准；完工回写 issue 由协调者做，你只管把交活单写真。`
      : `【审计锚】争议以派你来的那条通道里的原话为准。`,
    // 空行保留：四格靠空行分隔才读得出是四格，压掉就成一坨。
  ].join("\n");
}

function main(argv) {
  const arg = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
  const sub = argv[0];
  const role = arg("--role"), specFile = arg("--spec-file");
  const worktree = arg("--worktree") || "current";
  const agent = arg("--agent") || "pi";
  const model = arg("--model");
  const issue = arg("--issue") ? Number(arg("--issue")) : null;
  const dryRun = argv.includes("--dry-run");
  if (sub !== "dispatch" || !role || !specFile) {
    process.stderr.write("用法：node scripts/dao-orch.mjs dispatch --role <官种> --spec-file <文件> [--worktree current] [--agent pi] [--model id] [--issue N] [--dry-run]\n");
    return EXIT_USAGE;
  }
  if (!ROLES.includes(role)) {
    process.stderr.write(`✗ 非法官种「${role}」。合法取值：${ROLES.join(" / ")}\n`);
    return EXIT_USAGE;
  }
  let taskBody;
  try { taskBody = fs.readFileSync(specFile, "utf8"); }
  catch (e) { process.stderr.write(`✗ 读不到任务正文：${specFile}（${e.code || e.message}）\n`); return EXIT_USAGE; }
  // 便签链必须真的在盘上，否则派出去的第一行就是一个指向空气的指针。
  for (const rel of [PREAMBLE, NOTES]) {
    if (!fs.existsSync(path.join(ROOT, rel))) {
      process.stderr.write(`✗ 工人便签不在：${rel} —— 派单书第一行会指向空气，先补回它再派\n`);
      return EXIT_FAIL;
    }
  }
  const spec = buildSpec({ role, taskBody, issue });
  const orcaArgs = [
    ["orchestration", "task-create", "--spec", spec, "--json"],
  ];
  if (dryRun) {
    process.stdout.write("──── DRY-RUN：以下是拼装好的 spec ────\n" + spec + "\n");
    process.stdout.write("──── DRY-RUN：将执行（未执行）────\n");
    process.stdout.write(`orca ${orcaArgs[0].join(" ").slice(0, 80)}...\n`);
    process.stdout.write(`orca orchestration worker-start --task <task_id> --worktree ${worktree} --agent ${agent}${model ? ` --model ${model}` : ""} --json\n`);
    process.stdout.write("DAO_ORCH_SUMMARY exit=0 mode=dry-run\n");
    return EXIT_OK;
  }
  const tc = spawnSync(ORCA, orcaArgs[0], { encoding: "utf8", cwd: ROOT });
  if (tc.status !== 0) {
    process.stderr.write(`✗ task-create 失败：${String(tc.stderr || tc.stdout).slice(0, 400)}\nDAO_ORCH_SUMMARY exit=${EXIT_FAIL} mode=live\n`);
    return EXIT_FAIL;
  }
  let taskId = null;
  try { taskId = JSON.parse(String(tc.stdout)).result.task.id; } catch (_) { /* 下面兜底 */ }
  if (!taskId) {
    process.stderr.write(`✗ task-create 回包里没有 task id：${String(tc.stdout).slice(0, 300)}\nDAO_ORCH_SUMMARY exit=${EXIT_FAIL} mode=live\n`);
    return EXIT_FAIL;
  }
  const wsArgs = ["orchestration", "worker-start", "--task", taskId, "--worktree", worktree, "--agent", agent, ...(model ? ["--model", model] : []), "--json"];
  const ws = spawnSync(ORCA, wsArgs, { encoding: "utf8", cwd: ROOT, timeout: 120_000 });
  const out = String(ws.stdout || "");
  let dispatchId = null;
  try { const j = JSON.parse(out); dispatchId = (j.result && (j.result.dispatch?.id || j.result.dispatchId)) || null; } catch (_) {}
  if (ws.status !== 0) {
    process.stderr.write(`✗ worker-start 失败（task 已建：${taskId}，可按收据手工恢复）：${String(ws.stderr || out).slice(0, 400)}\nDAO_ORCH_SUMMARY exit=${EXIT_FAIL} mode=live task=${taskId}\n`);
    return EXIT_FAIL;
  }
  process.stdout.write(`✓ 已派单：task=${taskId}${dispatchId ? ` dispatch=${dispatchId}` : ""} role=${role} agent=${agent}${model ? ` model=${model}` : ""} worktree=${worktree}\n`);
  process.stdout.write(`DAO_ORCH_SUMMARY exit=0 mode=live task=${taskId}${dispatchId ? ` dispatch=${dispatchId}` : ""}\n`);
  return EXIT_OK;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  process.exit(main(process.argv.slice(2)));
}
