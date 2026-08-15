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
  argsTerminalClose,
  argsTerminalCreate,
  argsTerminalRead,
  argsTerminalSend,
  argsWorktreeCreate,
  argsWorktreeRm,
  argsWorkerStart,
  assessWorktreeLiveness,
  assertCodexLaunch,
  catalogUsedFlags,
  checkHelpLiveness,
  dispatchComment,
  extractHandleFromCreate,
  extractTaskId,
  extractTerminalText,
  extractWorktreeId,
  extractWorktreePath,
  isRunRequired,
  RUN_REQUIRED_HINT,
  rollbackErrorAlreadyGone,
  fetchHelpPreferLive,
  loadRouting,
  parseArgs,
  planDispatchRollback,
  probeMarkFound,
  probeWaitMs,
  recordEscape,
  resolveDispatchConstraints,
  resolveLaunch,
  reviewerCardName,
  rollbackReport,
  runCapabilityProbes,
  sleepSync,
  terminalProbeExec,
  waitAndVerify,
} from './lib/dao-cmd.mjs';
import { afterDispatchComment } from './lib/master-title.mjs';

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

function rollbackCreated(created) {
  const rollback = [];
  for (const args of planDispatchRollback(created)) {
    let r = orca(args);
    const step = {
      cmd: args.join(' '),
      ok: !!r.ok,
      error: r.ok ? undefined : errText(r.error),
    };
    if (!r.ok && rollbackErrorAlreadyGone(r.error)) {
      step.ok = true;
      step.alreadyGone = true;
      step.error = undefined;
    } else if (!r.ok && args[0] === 'terminal' && args[1] === 'close' && args.includes('--tab')) {
      const retryArgs = args.filter(a => a !== '--tab');
      const retry = orca(retryArgs);
      step.retryWithoutTab = {
        cmd: retryArgs.join(' '),
        ok: !!retry.ok,
        error: retry.ok ? undefined : errText(retry.error),
      };
      if (retry.ok || rollbackErrorAlreadyGone(retry.error)) {
        step.ok = true;
        step.alreadyGone = !retry.ok;
        step.recovered = !!retry.ok;
        step.error = undefined;
        r = retry;
      }
    }
    rollback.push(step);
  }
  const report = rollbackReport(rollback);
  if (report.alarm) console.error(`[dao] ${report.alarm}`);
  return { rollback, rollbackFailed: report.rollbackFailed };
}

function failCreated(created, error, extra = {}) {
  const { rollback, rollbackFailed } = rollbackCreated(created);
  emit({ ok: false, error, rollback, rollbackFailed, ...created, ...extra }, 1);
}

function readOnceHandle(handle) {
  const read = orca(argsTerminalRead({ terminal: handle, limit: 80 }));
  if (!read.ok) return { error: errText(read.error) };
  return read.json;
}

function liveSendAndRead(handle, waitMs) {
  return (cmd, name) => {
    const sent = orca(argsTerminalSend({ terminal: handle, text: cmd, enter: true }));
    if (!sent.ok) return { error: errText(sent.error) };
    const deadline = Date.now() + waitMs;
    let last = { text: '' };
    while (Date.now() < deadline) {
      const read = orca(argsTerminalRead({ terminal: handle, limit: 80 }));
      if (!read.ok) return { error: errText(read.error) };
      const text = extractTerminalText(read.json);
      last = { text };
      if (probeMarkFound(name, text)) return { text };
      sleepSync(400);
    }
    return last;
  };
}

function runTerminalProbes(handle, waitMs) {
  return runCapabilityProbes({
    exec: terminalProbeExec({ sendAndRead: liveSendAndRead(handle, waitMs) }),
  });
}

function cmdDispatch(args) {
  const routing = loadOrFail();
  const gate = constrainDispatch(args, routing);
  if (!args.spec && !args.task) fail('dispatch 要 --spec（工人任务书），或已有 --task');
  if (!args.name && !args.dryRun) fail('dispatch 要 --name');

  let workerLaunch;
  let reviewerLaunch;
  try {
    workerLaunch = resolveLaunch({ model: gate.model, routing, root: ROOT });
    reviewerLaunch = resolveLaunch({ model: gate.reviewer, routing, root: ROOT });
  } catch (e) { fail(String(e.message || e)); }

  const workerCap = assertCodexLaunch({ command: workerLaunch.command });
  if (!workerCap.ok) fail(workerCap.error);
  const reviewerCap = assertCodexLaunch({ command: reviewerLaunch.command });
  if (!reviewerCap.ok) fail(reviewerCap.error);

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

  const created = {};

  const workerWt = orca(argsWorktreeCreate({
    name: args.name,
    noParent: true,
    setup: 'skip',
    comment: plan.comment,
  }));
  if (!workerWt.ok) fail(`工人卡创建失败: ${errText(workerWt.error)}`, plan);
  created.workerId = extractWorktreeId(workerWt.json);
  created.workerPath = extractWorktreePath(workerWt.json);
  if (!created.workerId) fail('工人卡没返回 id', plan);

  const workerTerm = orca(argsTerminalCreate({
    worktree: created.workerId,
    title: args.name,
    command: workerLaunch.command,
  }));
  if (!workerTerm.ok) failCreated(created, `工人终端创建失败: ${errText(workerTerm.error)}`, plan);
  created.workerHandle = extractHandleFromCreate(workerTerm.json);
  if (!created.workerHandle) failCreated(created, '工人终端没返回 handle', plan);

  const workerVerify = waitAndVerify({ readOnce: () => readOnceHandle(created.workerHandle) });
  if (!workerVerify.ok) failCreated(created, '工人验开工失败', { verify: workerVerify, ...plan });

  const workerProbes = runTerminalProbes(created.workerHandle, probeWaitMs(routing, workerLaunch.provider));
  if (!workerProbes.ok) failCreated(created, workerProbes.error, { probes: workerProbes, ...plan });

  const revName = reviewerCardName(gate.reviewer);
  const revWt = orca(argsWorktreeCreate({
    name: revName,
    setup: 'skip',
    parentWorktree: created.workerId,
    comment: plan.comment,
  }));
  if (!revWt.ok) failCreated(created, `审官子卡创建失败: ${errText(revWt.error)}`, plan);
  created.reviewerId = extractWorktreeId(revWt.json);
  created.reviewerPath = extractWorktreePath(revWt.json);
  if (!created.reviewerId) failCreated(created, '审官子卡没返回 id', plan);

  const revTerm = orca(argsTerminalCreate({
    worktree: created.reviewerId,
    title: revName,
    command: reviewerLaunch.command,
  }));
  if (!revTerm.ok) failCreated(created, `审官终端创建失败: ${errText(revTerm.error)}`, plan);
  created.reviewerHandle = extractHandleFromCreate(revTerm.json);
  if (!created.reviewerHandle) failCreated(created, '审官终端没返回 handle', plan);

  const revVerify = waitAndVerify({ readOnce: () => readOnceHandle(created.reviewerHandle) });
  if (!revVerify.ok) failCreated(created, '审官验开工失败', { verify: revVerify, ...plan });

  const revProbes = runTerminalProbes(created.reviewerHandle, probeWaitMs(routing, reviewerLaunch.provider));
  if (!revProbes.ok) failCreated(created, revProbes.error, { probes: revProbes, ...plan });

  let taskId = args.task || null;
  if (args.spec) {
    const task = orca(argsTaskCreate({ spec: args.spec }));
    if (!task.ok) {
      if (isRunRequired(task.error)) failCreated(created, RUN_REQUIRED_HINT, plan);
      failCreated(created, `task-create 失败: ${errText(task.error)}`, plan);
    }
    taskId = extractTaskId(task.json) || taskId;
  }
  if (!taskId) failCreated(created, 'dispatch 没拿到 taskId', plan);

  const started = orca(argsWorkerStart({
    task: taskId,
    worktree: created.workerId,
    terminal: created.workerHandle,
  }));
  if (!started.ok) failCreated(created, `worker-start 失败: ${errText(started.error)}`, { ...plan, taskId });

  const comment = afterDispatchComment({
    name: args.name,
    worktreeId: created.workerId,
    runOrca: orca,
  });

  emit({
    ok: true,
    ...plan,
    ...created,
    taskId,
    probes: { worker: workerProbes, reviewer: revProbes },
    comment,
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

  const startCap = assertCodexLaunch({ command: launch.command });
  if (!startCap.ok) fail(startCap.error);

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
    readOnce: () => readOnceHandle(handle),
  });
  if (!verified.ok) {
    orca(argsTerminalClose({ terminal: handle, tab: true }));
    emit({
      ok: false,
      handle,
      provider: launch.provider,
      command: launch.command,
      verify: verified,
    }, 1);
  }

  const probes = runTerminalProbes(handle, probeWaitMs(routing, launch.provider));
  if (!probes.ok) {
    orca(argsTerminalClose({ terminal: handle, tab: true }));
    fail(probes.error, { handle, command: launch.command, probes });
  }

  emit({
    ok: true,
    handle,
    provider: launch.provider,
    command: launch.command,
    verify: { ok: true },
    probes,
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
  if (!r.ok) {
    if (isRunRequired(r.error)) fail(RUN_REQUIRED_HINT);
    fail(`task-create 失败: ${errText(r.error)}`);
  }
  emit({ ok: true, json: r.json, taskId: extractTaskId(r.json) });
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
