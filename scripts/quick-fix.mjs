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
import { assembleCardName, ensureRepoLabels, runGh } from './lib/dao-cmd.mjs';
import { runOrca } from './lib/orca-run.mjs';
import { orcaErrorText } from './lib/orca-error.mjs';
import {
  QUICK_FIX_TYPE_LABEL,
  buildQuickFixPrBody,
  planAttachFailureRollback,
  planIssueLabelStamps,
  planQuickFixGate,
  quickFixBranchName,
  quickFixCommitMessage,
  quickFixLabels,
  resolveQuickFixReviewer,
  runAttachFailureRollback,
} from './lib/quick-fix.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const WORKER = ROLE_META.worker;
const DAO_CLI = join(ROOT, 'scripts', 'dao.mjs');
const QUICK_FIX_LOG_DIR = join(homedir(), '.dao', 'quickfix');
const ATTACH_TIMEOUT_MS = 600000;

const FLAGS = new Set([
  '--issue', '--model', '--reviewer', '--message', '--body-file', '--branch',
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

/** 本地分支是否存在（残留/在用都算）。 */
function branchExists(name) {
  const r = git(['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]);
  return r.ok;
}

/** 远端分支是否存在（真碰撞：上次没回滚干净或别人在用）。 */
function remoteBranchExists(name) {
  const r = git(['ls-remote', 'origin', `refs/heads/${name}`], { timeout: 30000 });
  if (!r.ok) return { ok: false, unscanned: true, error: `ls-remote 没查成：${r.error}` };
  return { ok: true, exists: String(r.out || '').trim().length > 0 };
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
    // porcelain 行 = 一到两位状态列 + 空格 + 路径（实测有 "M host" 与 " M host" 两种形态）；
    // 重命名是 "R  old -> new"，展示层保留。
    files: lines.map((l) => l.replace(/^[ MADRCU?!]{1,2} /, '').trim()).filter(Boolean),
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

/** 信箱台 ensure：确认收信中继活着（完工/红项信靠它落 _flow/inbox.log）。
 * 2026-08-23 起台是 detached 后台进程，没有终端 handle——微通道的 Run 协调终端
 * 改为壳卡上的哑终端（见 cmdAttach 第 3 步），不再 --from 信箱台。
 * 台在重启/忙时 ensure 可能超过 60s（实测掐断），重试三次兜住偶发。 */
function ensureStation() {
  let last = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'inbox-station.mjs'), 'ensure'], {
      encoding: 'utf8', cwd: ROOT, windowsHide: true, timeout: 120000,
    });
    let json = null;
    try { json = JSON.parse(String(r.stdout || '').trim().split(/\r?\n/).pop()); }
    catch { json = null; }
    if ((r.status !== 0 && r.status != null) || !json || json.ok !== true) {
      last = { ok: false, error: (json && json.error) || String(r.stderr || '').trim() || `inbox-station ensure exit ${r.status}` };
      if (attempt < 3) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000);
      continue;
    }
    return { ok: true, pid: json.pid ?? null };
  }
  return last || { ok: false, error: 'inbox-station ensure 三次都失败（没查成）' };
}

function attachLog(issue) {
  mkdirSync(QUICK_FIX_LOG_DIR, { recursive: true });
  return join(QUICK_FIX_LOG_DIR, `quickfix-${issue}.log`);
}

function logLine(file, line) {
  try { appendFileSync(file, `${new Date().toISOString()} ${line}\n`); }
  catch { /* 日志写不上不阻塞主流程 */ }
}

/** 回滚执行器：把计划步骤映射到真实命令。测试注入假执行器验计划本身。 */
function rollbackExec(cmd) {
  if (cmd.startsWith('worktree-rm ')) {
    const m = cmd.match(/--worktree (\S+)/);
    const r = daoRun(['worktree-rm', '--worktree', m ? m[1] : '', '--force']);
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  }
  if (cmd.startsWith('pr close ')) {
    const m = cmd.match(/pr close (\d+)/);
    const r = m ? workerGh(['pr', 'close', m[1], '--delete-branch', '--comment', 'quick-fix attach 失败，整体回滚']) : { ok: false, error: 'pr close 参数没查成' };
    return r.ok ? { ok: true } : { ok: false, error: r.error || `pr close exit ${r.status}` };
  }
  if (cmd.startsWith('push origin --delete ')) {
    const name = cmd.slice('push origin --delete '.length);
    const r = git(['push', 'origin', '--delete', name]);
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  }
  if (cmd.startsWith('branch -D ')) {
    const name = cmd.slice('branch -D '.length);
    const exists = git(['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]);
    if (!exists.ok) return { ok: true, skipped: true, error: '本地分支已不在（gh pr close 或前面步骤已删）' };
    const r = git(['branch', '-D', name]);
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  }
  return { ok: false, error: `回滚计划步骤不认识: ${cmd}` };
}

/**
 * attach 失败的整体处置：先执行回滚计划（删壳卡 → 关 PR+删远端分支 → 删本地分支），
 * 再在 PR 上留痕（回滚结果显式写进评论），最后非零退出。任何一步回滚失败也照发留痕。
 */
function failAttach(error, { pr, branch, worktreeId, log } = {}) {
  logLine(log, `attach 失败: ${error}`);
  const plan = planAttachFailureRollback({ pr, branch, worktreeId });
  const rolled = runAttachFailureRollback(plan, {
    exec: rollbackExec,
    log: (line) => logLine(log, line),
  });
  logLine(log, `回滚结论: ${rolled.ok ? 'ok' : rolled.error}`);
  const body = [
    `微修审官没起来（quick-fix 异步 attach 失败）：${String(error || '').slice(0, 400)}`,
    '',
    '整体回滚结果：',
    ...(rolled.results || []).map((s) => `- ${s.cmd}：${s.ok ? 'ok' : `失败 ${s.error}`}`),
    '',
    `回滚${rolled.ok ? '完成' : `失败（${rolled.error}）`}。日志：${log}`,
    '红项按审官任务书上帅；如需重试，清理残留后重跑 quick-fix。',
  ].join('\n');
  // Windows 上多行 --body 会被拆（#573 坑 1），评论一律走 --body-file。
  const commentFile = join(ROOT, '_tmp', `quickfix-attach-fail-${pr}.md`);
  mkdirSync(join(ROOT, '_tmp'), { recursive: true });
  writeFileSync(commentFile, body, 'utf8');
  const posted = pr ? workerGh(['pr', 'comment', String(pr), '--body-file', commentFile]) : { ok: false, error: '没 PR 号' };
  rmSync(commentFile, { force: true });
  logLine(log, `PR 留痕: ${posted.ok ? 'ok' : `失败 ${posted.error}`}`);
  emit({ ok: false, error, attachLog: log, rollback: rolled, posted: posted.ok });
}

function cmdAttach(args) {
  const log = String(args.log || '').trim() || attachLog(args.issue);
  const branch = String(args.branch || '').trim();
  logLine(log, `attach 开始 pr=${args.pr} reviewer=${args.reviewer} branch=${branch}`);

  // 1. 壳卡（审官父卡，供 reviewer-attach 树→PR 归属校验）。
  //    前台已删本地微修分支，orca 见本地缺失会从远端建本地分支并直接 checkout。
  const shellCardName = assembleCardName({ name: '微修壳卡', issue: args.issue, role: '工人', model: args.model });
  const wt = daoRun([
    'worktree-create',
    '--issue', String(args.issue),
    '--name', shellCardName,
    '--no-parent',
    '--setup', 'skip',
    '--base-branch', branch,
    '--comment', `微修 #${args.issue} 壳卡：quick-fix 起审官用，无工人终端`,
  ]);
  const worktreeId = wt.ok ? (wt.json?.result?.worktree?.id || wt.json?.worktreeId || null) : null;
  const worktreePath = wt.ok ? (wt.json?.result?.worktree?.path || wt.json?.worktreePath || null) : null;
  if (!wt.ok || !worktreeId) {
    failAttach(`壳卡创建失败：${wt.error || '没返回 worktree id（没查成）'}`, {
      pr: args.pr, branch, log,
    });
  }
  logLine(log, `壳卡已建 worktree=${worktreeId}`);

  // 2. 验壳卡真的挂在微修分支上（orca 元数据可能滞后，以 live git 为准）。
  if (worktreePath) {
    const cur = git(['branch', '--show-current'], { cwd: worktreePath });
    if (!cur.ok || cur.out !== branch) {
      failAttach(`壳卡分支没切成 ${branch}（实际 ${cur.out || cur.error}）——reviewer-attach 的树→PR 归属校验会拒`, {
        pr: args.pr, branch, worktreeId, log,
      });
    }
  }

  // 3. detached 进程自开 Run 没有 coordinator 终端，worker-start 会 consumer_fenced（#682）。
  //    2026-08-23：信箱台改 detached 后台进程（没有终端 handle 了）——微通道协调改为
  //    在壳卡上起一个哑终端当 Run coordinator（随壳卡收树一起关，不多开）。
  //    先 ensure 信箱台（确认收信中继活着），再建协调终端，再建 Run。
  const station = ensureStation();
  if (!station.ok) {
    failAttach(`信箱台 ensure 失败：${station.error}`, { pr: args.pr, branch, worktreeId, log });
  }
  const coord = runOrca(['terminal', 'create', '--worktree', worktreeId, '--title', '微通道协调（勿关）', '--json'], { timeout: 60000 });
  const coordHandle = coord.ok
    ? (coord.json?.result?.handle || coord.json?.result?.terminal?.handle || null)
    : null;
  if (!coord.ok || !coordHandle) {
    failAttach(`微通道协调终端没建成：${orcaErrorText(coord.error) || '没返回 handle（没查成）'}`, {
      pr: args.pr, branch, worktreeId, log,
    });
  }
  const runCreated = runOrca(['orchestration', 'run-create', '--objective', `dispatch: quick-fix PR #${args.pr}`, '--from', coordHandle, '--json'], { timeout: 60000 });
  const runId = runCreated.ok ? (runCreated.json?.result?.run?.id || null) : null;
  if (!runCreated.ok || !runId) {
    failAttach(`审官 Run 没建成（--from 壳卡哑终端）：${orcaErrorText(runCreated.error) || '没返回 run id（没查成）'}`, {
      pr: args.pr, branch, worktreeId, log,
    });
  }
  logLine(log, `审官 Run 已建 run=${runId}（coordinator=壳卡哑终端 ${coordHandle}）`);

  // 4. 真调 reviewer-attach（--skip-wait：微修没有士兵 dispatch，审官跳过等完工直接开审）。
  //    Codex TUI 冷启动时 orca 的注入会落在「model: loading」窗口里，paste 未提交 → agent_prompt_stalled
  //    （实测 1/8 成功，成功的那次是 codex 就绪后才收到注入）。每次重试 = 全新 codex TUI，缓存渐热；
  //    间隔 30s 给上一条 TUI 留出就绪时间。非 stall 类失败不重试（那是结构性问题）。
  let r = null;
  let json = null;
  for (let attempt = 1; attempt <= 5; attempt++) {
    r = spawnSync(process.execPath, [
      DAO_CLI, 'reviewer-attach',
      '--pr', String(args.pr),
      '--worktree', worktreeId,
      '--reviewer', String(args.reviewer),
      '--issue', String(args.issue),
      '--run', runId,
      '--skip-wait',
      '--merge-policy', 'auto',
      '--start-timeout-ms', '180000',
    ], { encoding: 'utf8', cwd: ROOT, windowsHide: true, timeout: ATTACH_TIMEOUT_MS });
    json = null;
    try { json = JSON.parse(String(r.stdout || '').trim().split(/\r?\n/).pop()); }
    catch { json = null; }
    if ((r.status !== 0 && r.status != null) || !json || json.ok !== true) {
      const error = (json && json.error) || String(r.stderr || '').trim() || `reviewer-attach exit ${r.status}`;
      const stalled = /stalled|agent_prompt/i.test(error) || /stalled|agent_prompt/i.test(String(r.stdout || ''));
      logLine(log, `attach 第 ${attempt} 次失败: ${error}${stalled ? '（agent_prompt_stalled，codex 冷启动注入未提交，重试）' : ''}`);
      if (!stalled || attempt === 5) break;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000);
      continue;
    }
    break;
  }
  if ((r.status !== 0 && r.status != null) || !json || json.ok !== true) {
    const error = (json && json.error) || String(r.stderr || '').trim() || `reviewer-attach exit ${r.status}`;
    const rawTail = String(r.stdout || '').trim().split(/\r?\n/).slice(-3).join(' | ');
    if (rawTail && !error.includes(rawTail)) logLine(log, `reviewer-attach 输出尾部: ${rawTail.slice(0, 300)}`);
    failAttach(error, { pr: args.pr, branch, worktreeId, log });
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
    if (!args.pr || !args.reviewer || !args.issue || !args.model || !args.branch) {
      fail('--attach 要 --pr --reviewer --issue --model --branch', {}, 2);
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
  const remoteHit = remoteBranchExists(branch);
  if (!remoteHit.ok) fail(remoteHit.error);
  if (remoteHit.exists) fail(`远端已有分支 ${branch}（同题已有微修或上次没回滚干净）——先处理旧 PR，或换 --message 起新分支`);
  if (branchExists(branch)) fail(`本地残留分支 ${branch}（远端没有，可能是中断残留）——先 git branch -D 清理`);
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
  // 壳卡要由 orca 直接 checkout 微修分支：本地分支在场时 orca 会改建同名派生分支（树→PR 归属校验不过）。
  // 删本地 ref（提交与远端都在），orca 见本地缺失会从远端建本地分支并直接 checkout。
  const dropLocal = git(['branch', '-D', branch]);
  if (!dropLocal.ok) failWithRollback(`删本地分支失败：${dropLocal.error}`);

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

  // 3. 非 draft PR（dao-worker[bot]）。本机 gh 的 pr create 不支持 --json，从输出的 URL 取 PR 号。
  const prCreate = workerGh(['pr', 'create', '--title', `[qf] ${message}`, '--body-file', bodyFile, '--head', branch, '--base', 'master']);
  let prNumber = null;
  const urlMatch = String(prCreate.out || '').match(/pull\/(\d+)/);
  if (prCreate.ok && urlMatch) prNumber = Number(urlMatch[1]);
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

  // 5. 异步 attach 异厂审官（#679 闸已过；壳卡 + reviewer-attach 全在后台跑，不阻塞 20 秒主线）
  const attachLogFile = attachLog(issue);
  const child = spawn(process.execPath, [
    process.argv[1],
    '--attach',
    '--pr', String(prNumber),
    '--reviewer', reviewer.modelId,
    '--issue', issue,
    '--model', model,
    '--branch', branch,
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
    labels: labelNames,
    issueStampAdd: stamps.add,
    attachLog: attachLogFile,
    seconds: (Date.now() - t0) / 1000,
    gate: { state: gate.state, workerProvider: gate.workerProvider, reviewerProvider: gate.reviewerProvider },
  });
}

main(process.argv).catch((e) => fail(`quick-fix 崩了：${String(e.message || e)}`));
