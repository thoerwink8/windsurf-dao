#!/usr/bin/env node
// scripts/quick-fix.mjs —— 微通道原子脚本（#682）
//
// 主会话红线唯一例外：bot 身份（dao-worker[bot]）、原子操作、有闸（#679 同厂硬闸）。
// 一步完成：分支 → commit → push → 非 draft PR → label → 壳卡 → 异步 attach 异厂审官。
// 任一步失败整体回滚（删远端分支 / 关 PR / 删壳卡 / 回 master），不留半成品，非零退出留痕。
//
// 用法：
//   node scripts/quick-fix.mjs --issue <N> --model <主会话模型> \
//     [--reviewer <id>] [--message <文>] [--body-file <f>] [--yes] [--dry-run]
//   node scripts/quick-fix.mjs --attach --pr <N> --worktree <壳卡> --reviewer <id> \
//     --issue <N> --model <M> --log <文件>          ← 异步 attach 内部子命令，别手敲
//
// #679 闸：--model 必填（主会话模型，脚本不许猜）；审官 = --reviewer 或 issue 唯一 reviewer/*；
// 同厂 / 模型查不到 / issue model/* 与 --model 不一致 → 当场非零退出，不起审官。

import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import readline from 'node:readline';
import { ROLE_META, ghAs } from './lib/gh.mjs';
import { loadRoutingPolicy } from './lib/model-routing-json.mjs';
import { ensureRepoLabels, runGh } from './lib/dao-cmd.mjs';
import {
  QUICK_FIX_TYPE_LABEL,
  buildQuickFixPrBody,
  planIssueLabelStamps,
  planQuickFixGate,
  quickFixBranchName,
  quickFixCommitMessage,
  quickFixLabels,
  resolveQuickFixReviewer,
} from './lib/quick-fix.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const WORKER = ROLE_META.worker;
const DAO_CLI = join(ROOT, 'scripts', 'dao.mjs');
const QUICK_FIX_LOG_DIR = join(homedir(), '.dao', 'quickfix');
const ATTACH_TIMEOUT_MS = 600000;

const FLAGS = new Set([
  '--issue', '--model', '--reviewer', '--message', '--body-file',
  '--yes', '--dry-run', '--attach', '--pr', '--worktree', '--log', '--json', '--help', '-h',
]);
const BOOL = new Set(['yes', 'dry-run', 'attach', 'json', 'help']);

function camelFlag(s) {
  return s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

function parseArgs(argv) {
  const rest = argv.slice(2);
  const args = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    const flag = a.split('=')[0];
    if (flag === '--help' || flag === '-h') { args.help = true; continue; }
    if (!FLAGS.has(flag)) throw new Error(`未知参数: ${flag}`);
    const key = flag.slice(2);
    if (BOOL.has(key)) { args[camelFlag(key)] = true; continue; }
    const val = rest[++i];
    if (val == null || String(val).startsWith('--')) throw new Error(`参数 ${flag} 缺值`);
    args[camelFlag(key)] = val;
  }
  return args;
}

function emit(payload, exit = 0) {
  console.log(JSON.stringify(payload));
  process.exit(exit);
}

function fail(error, extra = {}, exit = 1) {
  emit({ ok: false, error, ...extra }, exit);
}

function ghRunner() {
  const fake = process.env.DAO_GH_FAKE;
  if (fake) {
    return (ghArgs) => {
      const r = spawnSync(process.execPath, [fake, ...ghArgs], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
      if (r.error || (r.status !== 0 && r.status != null)) {
        return { ok: false, error: String(r.error?.message || r.stderr || `exit ${r.status}`).trim().slice(0, 240) };
      }
      return { ok: true, out: String(r.stdout || '') };
    };
  }
  return (ghArgs) => runGh(ghArgs);
}

function workerGh(ghArgs) {
  const r = ghAs('worker', ghArgs, { cwd: ROOT });
  if (!r.ok && r.error && !r.status) return r;
  return { ok: !!r.ok, out: r.out || '', error: r.error || null, status: r.status ?? (r.ok ? 0 : 1) };
}

function git(args, { cwd = ROOT, timeout = 60000 } = {}) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, timeout });
  if (r.error || (r.status !== 0 && r.status != null)) {
    return {
      ok: false,
      out: String(r.stdout || '').trim(),
      error: String(r.error?.message || r.stderr || `git exit ${r.status}`).trim().slice(0, 240),
    };
  }
  return { ok: true, out: String(r.stdout || '').trim() };
}

function daoRun(verbArgs, { timeout = 60000 } = {}) {
  const r = spawnSync(process.execPath, [DAO_CLI, ...verbArgs], {
    encoding: 'utf8', cwd: ROOT, windowsHide: true, timeout,
  });
  let json = null;
  try { json = JSON.parse(String(r.stdout || '').trim().split(/\r?\n/).pop()); }
  catch { json = null; }
  if ((r.status !== 0 && r.status != null) || !json || json.ok !== true) {
    return {
      ok: false,
      error: (json && json.error) || String(r.stderr || '').trim() || `dao ${verbArgs[0]} exit ${r.status}`,
    };
  }
  return { ok: true, ...json };
}

function readIssueLabels(gh, issue) {
  const r = gh(['issue', 'view', String(issue), '--json', 'labels']);
  if (!r.ok) {
    return { ok: false, unscanned: true, error: `gh 读 issue #${issue} labels 失败——不是查过没事，是没查成：${r.error}` };
  }
  let labels = [];
  try {
    const parsed = JSON.parse(r.out);
    labels = Array.isArray(parsed?.labels) ? parsed.labels : [];
  } catch {
    return { ok: false, unscanned: true, error: `gh 读 issue #${issue} labels 返回不是 JSON——没查成` };
  }
  return { ok: true, labels };
}

function currentBranch() {
  const r = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!r.ok) return { ok: false, error: `当前分支没查成：${r.error}` };
  if (!r.out || r.out === 'HEAD') return { ok: false, error: '工作区处于 detached HEAD，微修从 master 起' };
  return { ok: true, branch: r.out };
}

function branchExists(name) {
  const r = git(['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]);
  return r.ok;
}

function workingTreeFiles() {
  const r = git(['status', '--porcelain']);
  if (!r.ok) return { ok: false, error: `git status 没查成：${r.error}` };
  const lines = String(r.out || '').split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) {
    return { ok: false, error: '工作区没有改动（微修要带几行改动，先改再跑）' };
  }
  return {
    ok: true,
    // porcelain 行 = 两位状态列 + 空格 + 路径；重命名是 "R  old -> new"，展示层保留。
    files: lines.map((l) => l.slice(3).trim()).filter(Boolean),
    raw: lines,
  };
}

function confirmPlan(plan, { yes } = {}) {
  if (yes) return { ok: true };
  const lines = [
    'quick-fix 微通道计划：',
    `  issue    #${plan.issue}`,
    `  模型     ${plan.model}（主会话，脚本显式声明）`,
    `  审官     ${plan.reviewer}（${plan.reviewerSource}）`,
    `  分支     ${plan.branch}`,
    `  PR       [qf] ${plan.message}（非 draft，base master）`,
    `  label    ${plan.labels.join(' ')}`,
    `  改动文件 ${plan.files.length} 个：`,
    ...plan.files.map((f) => `    ${f}`),
    '将用 dao-worker[bot] 身份 commit + push，并异步起审官。',
    '继续？[y/N] ',
  ];
  console.error(lines.join('\n'));
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    rl.question('', (ans) => {
      rl.close();
      resolve({ ok: /^y(es)?$/i.test(String(ans || '').trim()) });
    });
  });
}

function rollback(created) {
  const steps = [];
  const log = (ok, cmd, extra) => steps.push({ ok, cmd, ...(extra ? { extra } : {}) });
  if (created.worktreeId) {
    const r = daoRun(['worktree-rm', '--worktree', created.worktreeId, '--force']);
    log(r.ok, `worktree-rm ${created.worktreeId}`, r.ok ? undefined : r.error);
  }
  if (created.pr) {
    const r = workerGh(['pr', 'close', String(created.pr), '--delete-branch', '--comment', 'quick-fix 后续步骤失败，整体回滚']);
    log(r.ok, `pr close ${created.pr} --delete-branch`, r.ok ? undefined : r.error);
  } else if (created.pushed) {
    const r = git(['push', 'origin', '--delete', created.branch]);
    log(r.ok, `push origin --delete ${created.branch}`, r.ok ? undefined : r.error);
  }
  if (created.branchCreated) {
    const back = git(['checkout', created.origBranch]);
    log(back.ok, `checkout ${created.origBranch}`, back.ok ? undefined : back.error);
    const del = git(['branch', '-D', created.branch]);
    log(del.ok, `branch -D ${created.branch}`, del.ok ? undefined : del.error);
  }
  return steps;
}

function attachLog(issue) {
  mkdirSync(QUICK_FIX_LOG_DIR, { recursive: true });
  return join(QUICK_FIX_LOG_DIR, `quickfix-${issue}.log`);
}

function logLine(file, line) {
  try { appendFileSync(file, `${new Date().toISOString()} ${line}\n`); }
  catch { /* 日志写不上不阻塞主流程 */ }
}

/** 异步子命令：真调 reviewer-attach，失败清理壳卡 + PR 留痕。 */
function cmdAttach(args) {
  const log = String(args.log || '').trim() || attachLog(args.issue);
  logLine(log, `attach 开始 pr=${args.pr} worktree=${args.worktree} reviewer=${args.reviewer}`);
  const r = spawnSync(process.execPath, [
    DAO_CLI, 'reviewer-attach',
    '--pr', String(args.pr),
    '--worktree', String(args.worktree),
    '--reviewer', String(args.reviewer),
    '--issue', String(args.issue),
    '--skip-wait',
    '--merge-policy', 'auto',
  ], { encoding: 'utf8', cwd: ROOT, windowsHide: true, timeout: ATTACH_TIMEOUT_MS });
  let json = null;
  try { json = JSON.parse(String(r.stdout || '').trim().split(/\r?\n/).pop()); }
  catch { json = null; }
  if ((r.status !== 0 && r.status != null) || !json || json.ok !== true) {
    const error = (json && json.error) || String(r.stderr || '').trim() || `reviewer-attach exit ${r.status}`;
    logLine(log, `attach 失败: ${error}`);
    const rm = daoRun(['worktree-rm', '--worktree', String(args.worktree), '--force']);
    logLine(log, `壳卡清理: ${rm.ok ? 'ok' : `失败 ${rm.error}`}`);
    const body = [
      `微修审官没起来（quick-fix 异步 attach 失败）：${error.slice(0, 400)}`,
      '',
      `壳卡已清理：${rm.ok ? '是' : `否（${rm.error}）`}。日志：${log}`,
      '红项按审官任务书上帅；本 PR 无审官，需人工处置。',
    ].join('\n');
    // Windows 上多行 --body 会被拆（#573 坑 1），评论一律走 --body-file。
    const commentFile = join(ROOT, '_tmp', `quickfix-attach-fail-${args.pr}.md`);
    mkdirSync(join(ROOT, '_tmp'), { recursive: true });
    writeFileSync(commentFile, body, 'utf8');
    const posted = workerGh(['pr', 'comment', String(args.pr), '--body-file', commentFile]);
    rmSync(commentFile, { force: true });
    logLine(log, `PR 留痕: ${posted.ok ? 'ok' : `失败 ${posted.error}`}`);
    emit({ ok: false, error, attachLog: log, cleaned: rm.ok, posted: posted.ok });
  }
  logLine(log, `attach 成功 reviewerDispatchId=${json.reviewerDispatchId || '?'} reviewerId=${json.reviewerId || '?'}`);
  emit({ ok: true, pr: Number(args.pr), reviewerDispatchId: json.reviewerDispatchId, attachLog: log });
}

async function main(argv) {
  let args;
  try { args = parseArgs(argv); }
  catch (e) { fail(String(e.message || e), {}, 2); }
  if (args.help) {
    console.log(`用法: node scripts/quick-fix.mjs --issue <N> --model <主会话模型> [--reviewer <id>] [--message <文>] [--body-file <f>] [--yes] [--dry-run]`);
    process.exit(0);
  }
  if (args.attach) {
    if (!args.pr || !args.worktree || !args.reviewer || !args.issue) {
      fail('--attach 要 --pr --worktree --reviewer --issue', {}, 2);
    }
    cmdAttach(args);
    return;
  }

  const t0 = Date.now();
  const issue = String(args.issue ?? '').trim();
  const model = String(args.model ?? '').trim();
  if (!issue) fail('要 --issue <已有单号>（账本：待办进 issue）', {}, 2);
  if (!/^\d+$/.test(issue)) fail(`--issue 必须是 issue 号，实际「${issue}」`, {}, 2);
  if (!model) fail('主会话模型未声明：要 --model <主会话模型>（脚本不许猜）', {}, 2);

  let policy;
  try { policy = loadRoutingPolicy(); }
  catch (e) { fail(`选型 JSON 没查成：${String(e.message || e)}`); }
  if (!Array.isArray(policy.models) || policy.models.length === 0) {
    fail('选型 JSON 的模型登记没查成（0 条 = 本次等于没查）');
  }

  const gh = ghRunner();

  // #679 闸尽量在 gh 读取之前（CI 无 GH_TOKEN 也能拦同厂样本）：显式 --reviewer 时连 label 都不用读。
  let reviewer;
  let labels = null;
  if (args.reviewer && String(args.reviewer).trim()) {
    reviewer = resolveQuickFixReviewer({ explicit: args.reviewer });
  } else {
    const read = readIssueLabels(gh, issue);
    if (!read.ok) fail(read.error);
    labels = read.labels;
    reviewer = resolveQuickFixReviewer({ labels });
  }
  if (!reviewer.ok) fail(reviewer.error);

  const gate = planQuickFixGate({ workerModel: model, reviewerId: reviewer.modelId, models: policy.models });
  if (!gate.ok) fail(gate.error, { gate });

  if (!labels) {
    const read = readIssueLabels(gh, issue);
    if (!read.ok) fail(read.error);
    labels = read.labels;
  }
  const stamps = planIssueLabelStamps({ labels, model, reviewer: reviewer.modelId });
  if (!stamps.ok) fail(stamps.error, { stamps });

  let message = String(args.message ?? '').trim();
  let customBody = null;
  if (args.bodyFile) {
    let text = null;
    try { text = String(readFileSync(args.bodyFile, 'utf8')); }
    catch (e) { fail(`--body-file 读不到：${String(e.message || e)}`); }
    if (!message) message = text.split(/\r?\n/).map((l) => l.trim()).find(Boolean) || '';
    customBody = text;
  }
  if (!message) message = '微修';

  const branch = quickFixBranchName({ issue, slug: message });
  const plan = {
    issue: Number(issue),
    model,
    reviewer: reviewer.modelId,
    reviewerSource: reviewer.source,
    message,
    branch,
    labels: quickFixLabels({ model, reviewer: reviewer.modelId }),
    files: [],
    issueStampAdd: stamps.add,
    dryRun: !!args.dryRun,
  };

  if (args.dryRun) {
    const probe = workingTreeFiles();
    emit({
      ok: true,
      dryRun: true,
      gate: { state: gate.state, workerProvider: gate.workerProvider, reviewerProvider: gate.reviewerProvider },
      ...plan,
      files: probe.ok ? probe.files : [],
      gitNote: probe.ok ? null : probe.error,
    });
  }

  const filesCheck = workingTreeFiles();
  if (!filesCheck.ok) fail(filesCheck.error);
  plan.files = filesCheck.files;
  if (branchExists(branch)) fail(`分支已存在：${branch}（同题已有微修？先合掉旧 PR 再开）`);
  const cur = currentBranch();
  if (!cur.ok) fail(cur.error);
  if (cur.branch !== 'master') {
    fail(`微修从 master 起，当前在 ${cur.branch}——先回 master，或走标准派工`);
  }

  const asked = await confirmPlan(plan, { yes: !!args.yes });
  if (!asked.ok) fail('未确认，退出（--yes 跳过确认）', { plan });

  const created = { origBranch: cur.branch, branch, pushed: false, pr: null, worktreeId: null, branchCreated: false };
  const failWithRollback = (error, extra = {}) => {
    const rolledBack = rollback(created);
    fail(error, { ...extra, rolledBack });
  };

  // 1. 分支 + dao-worker[bot] commit
  const co = git(['checkout', '-b', branch]);
  if (!co.ok) failWithRollback(`建分支失败：${co.error}`);
  created.branchCreated = true;
  const add = git(['add', '-A']);
  if (!add.ok) failWithRollback(`git add 失败：${add.error}`);
  const commit = git(['-c', `user.name=${WORKER.name}`, '-c', `user.email=${WORKER.email}`, 'commit', '-m', quickFixCommitMessage({ issue, message })]);
  if (!commit.ok) failWithRollback(`commit 失败：${commit.error}`);
  const push = git(['push', '-u', 'origin', 'HEAD'], { timeout: 120000 });
  if (!push.ok) failWithRollback(`push 失败：${push.error}`);
  created.pushed = true;
  const back = git(['checkout', created.origBranch]);
  if (!back.ok) failWithRollback(`回 master 失败：${back.error}`);

  // 2. PR 正文（三段式 + 署名 issue）
  const bodyPlan = buildQuickFixPrBody({
    issue,
    message,
    files: filesCheck.files,
    seconds: (Date.now() - t0) / 1000,
    custom: customBody,
  });
  if (!bodyPlan.ok) failWithRollback(bodyPlan.error);
  const bodyFile = join(ROOT, '_tmp', `quickfix-pr-${issue}-${process.pid}.md`);
  mkdirSync(join(ROOT, '_tmp'), { recursive: true });
  writeFileSync(bodyFile, bodyPlan.body, 'utf8');

  // 3. 非 draft PR（dao-worker[bot]）
  const prCreate = workerGh(['pr', 'create', '--title', `[qf] ${message}`, '--body-file', bodyFile, '--head', branch, '--base', 'master', '--json', 'number']);
  let prNumber = null;
  try { prNumber = prCreate.ok ? JSON.parse(prCreate.out)?.number : null; }
  catch { prNumber = null; }
  rmSync(bodyFile, { force: true });
  if (!prCreate.ok || !prNumber) failWithRollback(`开 PR 失败：${prCreate.error || '没返回 PR 号（没查成）'}`);
  created.pr = prNumber;

  // 4. label（校准数据源 #564）：PR 打 model/* type/微修 reviewer/*；issue 只补缺
  const labelNames = quickFixLabels({ model, reviewer: reviewer.modelId });
  const ensured = ensureRepoLabels({ names: labelNames, runGh: workerGh });
  if (!ensured.ok) failWithRollback(`label 没查成/没建成：${ensured.error}`);
  const prEdit = workerGh(['pr', 'edit', String(prNumber), ...labelNames.flatMap((n) => ['--add-label', n])]);
  if (!prEdit.ok) failWithRollback(`PR #${prNumber} 打 label 失败：${prEdit.error}`);
  if (stamps.add.length > 0) {
    const ensuredIssue = ensureRepoLabels({ names: stamps.add, runGh: workerGh });
    if (!ensuredIssue.ok) failWithRollback(`issue label 没查成/没建成：${ensuredIssue.error}`);
    const issueEdit = workerGh(['issue', 'edit', issue, ...stamps.add.flatMap((n) => ['--add-label', n])]);
    if (!issueEdit.ok) failWithRollback(`issue #${issue} 打 label 失败：${issueEdit.error}`);
  }

  // 5. 壳卡（审官父卡，挂在 PR 分支上，供 reviewer-attach 树→PR 归属校验）
  const wt = daoRun([
    'worktree-create',
    '--issue', issue,
    '--role', '工人',
    '--model', model,
    '--name', '微修壳卡',
    '--no-parent',
    '--setup', 'skip',
    '--base-branch', branch,
    '--comment', `微修 #${issue} 壳卡：quick-fix 起审官用，无工人终端`,
  ]);
  const worktreeId = wt.ok ? (wt.json?.result?.worktree?.id || wt.json?.worktreeId || null) : null;
  const worktreePath = wt.ok ? (wt.json?.result?.worktree?.path || wt.json?.worktreePath || null) : null;
  if (!wt.ok || !worktreeId) failWithRollback(`壳卡创建失败：${wt.error || '没返回 worktree id（没查成）'}`);
  created.worktreeId = worktreeId;
  // orca 建树会给新卡起同名分支；reviewer-attach 的树→PR 归属校验要求壳卡分支 == PR head，
  // 所以在壳卡内切到微修分支（git 不许两棵 worktree 同分支，源树已回 master，这里能切）。
  if (worktreePath) {
    const wtCheckout = git(['checkout', branch], { cwd: worktreePath });
    if (!wtCheckout.ok) failWithRollback(`壳卡切到微修分支失败：${wtCheckout.error}`);
  }

  // 6. 异步 attach 异厂审官（#679 闸已过；后台起，不阻塞 20 秒主线）
  const attachLogFile = attachLog(issue);
  const child = spawn(process.execPath, [
    process.argv[1],
    '--attach',
    '--pr', String(prNumber),
    '--worktree', worktreeId,
    '--reviewer', reviewer.modelId,
    '--issue', issue,
    '--model', model,
    '--log', attachLogFile,
  ], { cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();

  emit({
    ok: true,
    pr: prNumber,
    issue: Number(issue),
    reviewer: reviewer.modelId,
    reviewerSource: reviewer.source,
    branch,
    worktreeId,
    labels: labelNames,
    issueStampAdd: stamps.add,
    attachLog: attachLogFile,
    seconds: (Date.now() - t0) / 1000,
    gate: { state: gate.state, workerProvider: gate.workerProvider, reviewerProvider: gate.reviewerProvider },
  });
}

main(process.argv).catch((e) => fail(`quick-fix 崩了：${String(e.message || e)}`));
