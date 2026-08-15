#!/usr/bin/env node
// scripts/dao.mjs —— 统一命令库 CLI（issue #482）
//
// 删「帅拼命令字符串」这一层。启动 / 编排走这里；查询类不在本单。
// CLI 还是约束载体：派工缺 --merge-policy / --model|--role / --reviewer 就跑不起来。
// 启动模板只从 docs/model-routing.toml 读，这里零硬编码。
// 逃生口 raw 必须留痕，否则库会因绕过而死亡。

import { spawnSync } from 'node:child_process';
import {
  ROOT,
  USAGE,
  argsTaskCreate,
  argsTerminalCreate,
  argsTerminalRead,
  argsTerminalSend,
  argsWorktreeCreate,
  argsWorktreeRm,
  argsWorkerStart,
  assessWorktreeLiveness,
  catalogUsedFlags,
  checkHelpLiveness,
  dispatchComment,
  extractHandleFromCreate,
  extractWorktreeId,
  fetchHelpPreferLive,
  loadRouting,
  parseArgs,
  recordEscape,
  resolveDispatchConstraints,
  resolveLaunch,
  reviewerCardName,
  waitAndVerify,
} from './lib/dao-cmd.mjs';

const ORCA_TIMEOUT_MS = 30000;

function errText(e) {
  if (e == null) return '';
  if (typeof e === 'string') return e;
  if (typeof e === 'object') return e.code ? `orca 报错 ${e.code}: ${e.message}` : String(e.message || e);
  return '';
}

function parseOrcaStdout(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return { ok: false, error: 'orca 无输出' };
  try {
    return { ok: true, json: JSON.parse(text) };
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try { return { ok: true, json: JSON.parse(text.slice(start, end + 1)) }; }
      catch { /* fall through */ }
    }
    return { ok: false, error: `orca 输出不是 JSON: ${text.slice(0, 160)}` };
  }
}

function orca(cmdArgs, timeout = ORCA_TIMEOUT_MS) {
  const r = spawnSync('orca', cmdArgs, { encoding: 'utf8', timeout, windowsHide: true });
  if (r.error || (r.status !== 0 && r.status != null)) {
    if (r.stdout) {
      const parsed = parseOrcaStdout(r.stdout);
      if (parsed.ok && parsed.json?.error) return { ok: false, error: parsed.json.error, json: parsed.json };
      if (parsed.ok && parsed.json?.ok === false) return { ok: false, error: parsed.json.error || parsed.json, json: parsed.json };
    }
    return { ok: false, error: String(r.error?.message || r.stderr || `exit ${r.status}`).trim().slice(0, 240) };
  }
  const parsed = parseOrcaStdout(r.stdout);
  if (!parsed.ok) return parsed;
  if (parsed.json?.ok === false) return { ok: false, error: parsed.json.error || parsed.json, json: parsed.json };
  return { ok: true, json: parsed.json };
}

function emit(payload, exit = 0) {
  console.log(JSON.stringify(payload));
  process.exit(exit);
}

function fail(error, extra = {}) {
  emit({ ok: false, error, ...extra }, 1);
}

function loadOrFail() {
  try { return loadRouting(); }
  catch (e) { fail(String(e.message || e)); }
}

function constrainDispatch(args, routing) {
  const gate = resolveDispatchConstraints({
    mergePolicy: args.mergePolicy,
    model: args.model,
    role: args.role,
    reviewer: args.reviewer,
    confirm: args.confirm,
    routing,
    now: args.now ? new Date(args.now) : new Date(),
  });
  if (!gate.ok) {
    fail(gate.error, {
      missing: gate.missing || [],
      needsConfirm: gate.needsConfirm || false,
      recommendation: gate.recommendation || null,
    });
  }
  return gate;
}

function cmdDispatch(args) {
  const routing = loadOrFail();
  const gate = constrainDispatch(args, routing);
  let workerLaunch;
  let reviewerLaunch;
  try {
    workerLaunch = resolveLaunch({ model: gate.model, routing, root: ROOT });
    reviewerLaunch = resolveLaunch({ model: gate.reviewer, routing, root: ROOT });
  } catch (e) { fail(String(e.message || e)); }

  const plan = {
    mergePolicy: gate.mergePolicy,
    model: gate.model,
    reviewer: gate.reviewer,
    workerLaunch: workerLaunch.command,
    reviewerLaunch: reviewerLaunch.command,
    reviewerCard: reviewerCardName(gate.reviewer),
    comment: dispatchComment(gate),
  };

  if (args.dryRun) {
    emit({ ok: true, dryRun: true, ...plan });
  }
  if (!args.name) fail('dispatch 要 --name');

  const workerWt = orca(argsWorktreeCreate({
    name: args.name,
    noParent: true,
    setup: 'skip',
    comment: plan.comment,
  }));
  if (!workerWt.ok) fail(`工人卡创建失败: ${errText(workerWt.error)}`, plan);
  const workerId = extractWorktreeId(workerWt.json);
  if (!workerId) fail('工人卡没返回 id', plan);

  const workerTerm = orca(argsTerminalCreate({
    worktree: workerId,
    title: args.name,
    command: workerLaunch.command,
  }));
  if (!workerTerm.ok) fail(`工人终端创建失败: ${errText(workerTerm.error)}`, { ...plan, workerId });
  const workerHandle = extractHandleFromCreate(workerTerm.json);
  if (!workerHandle) fail('工人终端没返回 handle', { ...plan, workerId });
  const workerVerify = waitAndVerify({
    readOnce: () => {
      const read = orca(argsTerminalRead({ terminal: workerHandle, limit: 80 }));
      if (!read.ok) return { error: errText(read.error) };
      return read.json;
    },
  });
  if (!workerVerify.ok) {
    emit({ ok: false, error: '工人验开工失败', verify: workerVerify, ...plan, workerId, workerHandle }, 1);
  }

  const revName = reviewerCardName(gate.reviewer);
  const revWt = orca(argsWorktreeCreate({
    name: revName,
    setup: 'skip',
    parentWorktree: workerId,
    comment: plan.comment,
  }));
  if (!revWt.ok) fail(`审官子卡创建失败: ${errText(revWt.error)}`, { ...plan, workerId, workerHandle });
  const reviewerId = extractWorktreeId(revWt.json);
  if (!reviewerId) fail('审官子卡没返回 id', { ...plan, workerId, workerHandle });

  const revTerm = orca(argsTerminalCreate({
    worktree: reviewerId,
    title: revName,
    command: reviewerLaunch.command,
  }));
  if (!revTerm.ok) fail(`审官终端创建失败: ${errText(revTerm.error)}`, { ...plan, workerId, workerHandle, reviewerId });
  const reviewerHandle = extractHandleFromCreate(revTerm.json);
  if (!reviewerHandle) fail('审官终端没返回 handle', { ...plan, workerId, workerHandle, reviewerId });
  const revVerify = waitAndVerify({
    readOnce: () => {
      const read = orca(argsTerminalRead({ terminal: reviewerHandle, limit: 80 }));
      if (!read.ok) return { error: errText(read.error) };
      return read.json;
    },
  });
  if (!revVerify.ok) {
    emit({ ok: false, error: '审官验开工失败', verify: revVerify, ...plan, workerId, workerHandle, reviewerId, reviewerHandle }, 1);
  }

  let taskId = args.task || null;
  if (args.spec) {
    const task = orca(argsTaskCreate({ spec: args.spec }));
    if (!task.ok) fail(`task-create 失败: ${errText(task.error)}`, { ...plan, workerId });
    taskId = task.json?.result?.id || task.json?.id || taskId;
  }
  if (taskId) {
    const started = orca(argsWorkerStart({
      task: taskId,
      worktree: workerId,
      terminal: workerHandle,
    }));
    if (!started.ok) fail(`worker-start 失败: ${errText(started.error)}`, { ...plan, workerId, workerHandle, taskId });
  }

  emit({
    ok: true,
    ...plan,
    workerId,
    workerHandle,
    reviewerId,
    reviewerHandle,
    taskId,
  });
}

function cmdStart(args) {
  let routing;
  try { routing = loadRouting(); }
  catch (e) { fail(String(e.message || e)); }
  let launch;
  try {
    launch = resolveLaunch({
      provider: args.provider,
      model: args.model,
      routing,
      root: ROOT,
    });
  } catch (e) { fail(String(e.message || e)); }

  if (args.dryRun) {
    emit({ ok: true, dryRun: true, provider: launch.provider, command: launch.command, template: launch.template });
  }

  if (!args.worktree) fail('start 要 --worktree');
  const created = orca(argsTerminalCreate({
    worktree: args.worktree,
    title: args.title,
    command: launch.command,
  }));
  if (!created.ok) fail(`terminal create 失败: ${errText(created.error)}`, { command: launch.command });
  const handle = extractHandleFromCreate(created.json);
  if (!handle) fail('terminal create 没返回 handle', { command: launch.command });

  const verified = waitAndVerify({
    readOnce: () => {
      const read = orca(argsTerminalRead({ terminal: handle, limit: 80 }));
      if (!read.ok) return { error: errText(read.error) };
      return read.json;
    },
  });
  if (!verified.ok) {
    emit({
      ok: false,
      handle,
      provider: launch.provider,
      command: launch.command,
      verify: verified,
    }, 1);
  }
  emit({
    ok: true,
    handle,
    provider: launch.provider,
    command: launch.command,
    verify: { ok: true },
  });
}

function cmdWorktreeCreate(args) {
  if (!args.name) fail('worktree-create 要 --name');
  const r = orca(argsWorktreeCreate({
    name: args.name,
    noParent: args.noParent,
    setup: args.setup,
    parentWorktree: args.parentWorktree,
    baseBranch: args.baseBranch,
    comment: args.comment,
  }));
  if (!r.ok) fail(`worktree create 失败: ${errText(r.error)}`);
  emit({ ok: true, json: r.json });
}

function cmdWorktreeRm(args) {
  if (!args.worktree) fail('worktree-rm 要 --worktree');
  const r = orca(argsWorktreeRm({ worktree: args.worktree, force: args.force }));
  if (!r.ok) fail(`worktree rm 失败: ${errText(r.error)}`);
  emit({ ok: true, json: r.json });
}

function cmdTaskCreate(args) {
  if (!args.spec) fail('task-create 要 --spec');
  const r = orca(argsTaskCreate({ spec: args.spec }));
  if (!r.ok) fail(`task-create 失败: ${errText(r.error)}`);
  emit({ ok: true, json: r.json });
}

function cmdWorkerStart(args) {
  const routing = loadOrFail();
  constrainDispatch(args, routing);
  if (!args.task) fail('worker-start 要 --task');
  if (!args.worktree) fail('worker-start 要 --worktree');
  if (!args.terminal) fail('worker-start 要 --terminal（不用 --agent，参数在启动模板里）');
  const r = orca(argsWorkerStart({
    task: args.task,
    worktree: args.worktree,
    terminal: args.terminal,
    retryOf: args.retryOf,
  }));
  if (!r.ok) fail(`worker-start 失败: ${errText(r.error)}`);
  emit({ ok: true, json: r.json });
}

function cmdSend(args) {
  if (!args.terminal) fail('send 要 --terminal');
  if (args.text == null) fail('send 要 --text');
  const r = orca(argsTerminalSend({
    terminal: args.terminal,
    text: args.text,
    enter: args.enter,
  }));
  if (!r.ok) fail(`terminal send 失败: ${errText(r.error)}`);
  emit({ ok: true, json: r.json });
}

function cmdLiveness(args) {
  const path = args.path || process.cwd();
  try {
    const r = assessWorktreeLiveness(path);
    const ok = r.verdict === 'working' || r.verdict === 'thinking';
    emit({ ok, ...r }, ok ? 0 : 1);
  } catch (e) {
    fail(String(e.message || e));
  }
}

function cmdCheckHelp() {
  const sources = new Set();
  const report = checkHelpLiveness({
    catalog: catalogUsedFlags(),
    fetchHelp: (cmd) => {
      const r = fetchHelpPreferLive(cmd);
      sources.add(r.source);
      return r.text;
    },
  });
  if (report.unscanned) fail(report.error || '命令库 --help 自检没查成');
  if (!report.ok) {
    fail(`库参数已不在 orca --help：${report.missing.join(' ')}`, { missing: report.missing, scanned: report.scanned });
  }
  emit({ ok: true, scanned: report.scanned, source: [...sources] });
}

function cmdRaw(args) {
  const argv = args.cmd;
  const logPath = recordEscape({ argv, cwd: process.cwd() });
  console.error(`[dao raw] 已记账 ${logPath}: ${argv.join(' ')}`);
  const r = spawnSync(argv[0], argv.slice(1), { stdio: 'inherit', windowsHide: true });
  process.exit(r.status == null ? 1 : r.status);
}

function main() {
  let args;
  try { args = parseArgs(process.argv); }
  catch (e) {
    console.error(String(e.message || e));
    process.exit(1);
  }
  if (args.verb === 'help' || args.help) {
    process.stdout.write(USAGE);
    process.exit(0);
  }
  switch (args.verb) {
    case 'dispatch': return cmdDispatch(args);
    case 'start': return cmdStart(args);
    case 'worktree-create': return cmdWorktreeCreate(args);
    case 'worktree-rm': return cmdWorktreeRm(args);
    case 'task-create': return cmdTaskCreate(args);
    case 'worker-start': return cmdWorkerStart(args);
    case 'send': return cmdSend(args);
    case 'liveness': return cmdLiveness(args);
    case 'check-help': return cmdCheckHelp();
    case 'raw': return cmdRaw(args);
    default:
      console.error(`未知动词: ${args.verb}`);
      process.exit(1);
  }
}

main();
