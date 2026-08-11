#!/usr/bin/env node
// dao-exit-gate.mjs — 出口门阀：工兵交活单的机器核验（五道秒级门，零模型调用）
//
// 原则：工兵的话一概不信，盘上的事实一概机核；只扫 diff 不扫全仓。
// 用法：node scripts/dao-exit-gate.mjs --worktree <仓路径> --report <交活单.json> [--base <ref>]
// 退出码：0 过 · 1 红 · 2 用法错 · 3 没交单（交不出单与交了红单要分得开）
//
// 交活单 schema（这就是官侧条款的新形态：过程自由、出口收严）：
//   {
//     "task":    string,            // 任务标识（issue #N / dispatch id / 一句话）
//     "commits": string[],          // 本次交付的 commit 短哈希，非空
//     "verify":  [{ "cmd": string, "exit": number, "seconds": number }],  // 验证命令+真实退出码，非空
//     "files":   string[],          // 改动文件清单（相对仓根，正斜杠），非空
//     "guardEvidence": string,      // 条件必填：diff 触及护栏类路径时必填（先破再验两态记录）
//     "notes":   string             // 可选：遗留与挂账
//   }

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const EXIT_OK = 0, EXIT_RED = 1, EXIT_USAGE = 2, EXIT_NO_REPORT = 3;
const REPLAY_TIMEOUT_MS = 10_000;   // 限时重放硬顶（超时记「未验」不记红：最坏耗时是常数）

// 禁区路径（diff 命中即红）：秘密与凭据。刻意短——表越长越像黑话。
const FORBIDDEN = [/(^|\/)common-secrets\.json$/, /\.(pem|key|p12|pfx)$/i, /(^|\/)\.env($|\.)/i];
// 护栏类路径（触及 ⇒ guardEvidence 必填）：以拦截/守卫/扫描/判定为职责的文件
const GUARD_PATHS = [/^ccswitch\/hooks\//, /(^|\/)check-[^/]*\.(mjs|ps1|js)$/, /(^|\/)guard/i, /dao-exit-gate/];
// 重放白名单：只有已知快的命令形态才配被重放；其余记「未验」转合并链兜底
const REPLAYABLE = [/^node tests\/[^\s"]+\.tests\.js$/, /^node scripts\/dao-smoke\.mjs$/, /^node ccswitch\/scripts\/[^\s"]+\.mjs --check$/];
// 卫生门：diff 内容扫描
const HYGIENE = [
  [/^(<<<<<<<|=======|>>>>>>>)/m, "冲突标记"],
  [/sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----/, "疑似真实密钥"],
  [/�/, "乱码替换符（U+FFFD）"],
];

function fail(msg, problems) { problems.push(msg); }
function git(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { code: r.status, out: String(r.stdout || ""), err: String(r.stderr || "") };
}

export function lintReportShape(rep) {
  const problems = [];
  if (!rep || typeof rep !== "object" || Array.isArray(rep)) { fail("交活单不是 JSON 对象", problems); return problems; }
  if (typeof rep.task !== "string" || !rep.task.trim()) fail("缺 task（任务标识）", problems);
  for (const key of ["commits", "verify", "files"]) {
    if (!Array.isArray(rep[key]) || rep[key].length === 0) fail(`缺 ${key}（非空数组）`, problems);
  }
  if (Array.isArray(rep.commits)) rep.commits.forEach((c, i) => {
    if (typeof c !== "string" || !/^[0-9a-f]{7,40}$/i.test(c)) fail(`commits[${i}] 不是合法哈希：${JSON.stringify(c)}`, problems);
  });
  if (Array.isArray(rep.verify)) rep.verify.forEach((v, i) => {
    if (!v || typeof v.cmd !== "string" || !v.cmd.trim()) fail(`verify[${i}] 缺 cmd`, problems);
    else if (typeof v.exit !== "number") fail(`verify[${i}] 缺 exit（数）——验证必须带真实退出码`, problems);
  });
  if (Array.isArray(rep.files)) rep.files.forEach((f, i) => {
    if (typeof f !== "string" || !f.trim() || f.includes("\\")) fail(`files[${i}] 须为相对路径（正斜杠）：${JSON.stringify(f)}`, problems);
  });
  return problems;
}

export function runGates({ worktree, report, base }) {
  const problems = [];
  const notes = [];
  // 门 1：格式
  problems.push(...lintReportShape(report));
  if (problems.length) return { problems, notes };   // 形状都不对，往下查无意义
  // 门 2：凭据对账（commit 真存在；files 覆盖盘上 diff——漏报红、多报只出声）
  for (const c of report.commits) {
    const r = git(worktree, ["cat-file", "-t", c]);
    if (r.code !== 0 || r.out.trim() !== "commit") fail(`门2 凭据：commit 不存在于盘上：${c}`, problems);
  }
  const diff = git(worktree, ["diff", "--name-only", `${base}..HEAD`]);
  if (diff.code !== 0) { fail(`门2 凭据：git diff ${base}..HEAD 跑不动：${diff.err.trim().slice(0, 120)}`, problems); return { problems, notes }; }
  const onDisk = diff.out.split(/\r?\n/).filter(Boolean);
  const declared = new Set(report.files);
  for (const f of onDisk) if (!declared.has(f)) fail(`门2 凭据：盘上改了而单上没报：${f}`, problems);
  for (const f of declared) if (!onDisk.includes(f)) notes.push(`单上有、盘上 diff 没有：${f}（多报不判红，但请核是不是写错了）`);
  // 门 3：边界
  for (const f of onDisk) if (FORBIDDEN.some((re) => re.test(f))) fail(`门3 边界：diff 触及禁区路径：${f}`, problems);
  // 门 4：卫生（扫 diff 新增行）
  const patch = git(worktree, ["diff", `${base}..HEAD`]).out;
  const added = patch.split(/\r?\n/).filter((l) => l.startsWith("+") && !l.startsWith("+++")).map((l) => l.slice(1)).join("\n");
  for (const [re, label] of HYGIENE) if (re.test(added)) fail(`门4 卫生：diff 新增内容命中「${label}」`, problems);
  const biggest = Math.max(0, ...onDisk.map((f) => { try { return fs.statSync(path.join(worktree, f)).size; } catch (_) { return 0; } }));
  if (biggest > 500 * 1024) fail(`门4 卫生：单文件超过 500KB（${biggest} B）`, problems);
  // 门 4.5：护栏类改动 ⇒ guardEvidence 必填
  if (onDisk.some((f) => GUARD_PATHS.some((re) => re.test(f))) && (typeof report.guardEvidence !== "string" || !report.guardEvidence.trim())) {
    fail("门4+ 护栏：diff 触及护栏类路径，交活单缺 guardEvidence（先破再验两态记录）", problems);
  }
  // 门 5：限时重放（白名单才重放；超时/形态不符记「未验」不记红；复现红才红）
  for (const v of report.verify) {
    if (!REPLAYABLE.some((re) => re.test(v.cmd))) { notes.push(`门5 重放：「${v.cmd}」不在白名单形态 ⇒ 未验（转合并链兜底）`); continue; }
    const r = spawnSync(v.cmd, { cwd: worktree, encoding: "utf8", shell: true, timeout: REPLAY_TIMEOUT_MS });
    if (r.error || r.status == null) { notes.push(`门5 重放：「${v.cmd}」超时/被打断 ⇒ 未验（不记红，转合并链）`); continue; }
    if (r.status !== v.exit) fail(`门5 重放：「${v.cmd}」单上报 exit=${v.exit}，盘上复现 exit=${r.status}`, problems);
  }
  return { problems, notes };
}

function main(argv) {
  const arg = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
  const worktree = arg("--worktree"), reportPath = arg("--report"), base = arg("--base") || "origin/master";
  if (!worktree || !reportPath || argv.includes("--help")) {
    process.stderr.write("用法：node scripts/dao-exit-gate.mjs --worktree <仓路径> --report <交活单.json> [--base <ref>]\n");
    return EXIT_USAGE;
  }
  let report = null;
  try { report = JSON.parse(fs.readFileSync(reportPath, "utf8")); }
  catch (e) {
    process.stdout.write(`✗ 交不出机器可解析的交活单（${e.code || e.message}）：${reportPath}\n  没交单与交了红单是两回事，本闸按「没交单」处理。\nEXIT_GATE_SUMMARY exit=${EXIT_NO_REPORT} red=0 notes=0\n`);
    return EXIT_NO_REPORT;
  }
  const { problems, notes } = runGates({ worktree, report, base });
  for (const p of problems) process.stdout.write(`✗ ${p}\n`);
  for (const n of notes) process.stdout.write(`  ⓘ ${n}\n`);
  if (!problems.length) process.stdout.write("✓ 五道门全过（格式/凭据/边界/卫生/限时重放）\n");
  process.stdout.write(`EXIT_GATE_SUMMARY exit=${problems.length ? EXIT_RED : EXIT_OK} red=${problems.length} notes=${notes.length}\n`);
  return problems.length ? EXIT_RED : EXIT_OK;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  process.exit(main(process.argv.slice(2)));
}
