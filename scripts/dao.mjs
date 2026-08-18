#!/usr/bin/env node
// scripts/dao.mjs —— 统一命令库 CLI（issue #482）
//
// 删「帅拼命令字符串」这一层。启动 / 编排走这里；查询类不在本单。
// CLI 还是约束载体：派工缺 --merge-policy / --model|--role / --reviewer 就跑不起来。
// 启动模板只从 docs/model-routing.toml 读，这里零硬编码。
// 逃生口 raw 必须留痕，否则库会因绕过而死亡。

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { parseYaml } from './lib/yaml-min.mjs';
import { select } from './lib/dianjiangtai-core.mjs';
import {
  advanceLaunchState,
  classifyLaunchFailure,
  resolveDispatchSlate,
} from './lib/next-launch.mjs';
import { readLedgerEvents, queryLedger, describeUnclosedJobs } from './lib/ledger-query.mjs';
import {
  ROOT,
  USAGE,
  argsTaskCreate,
  argsTerminalClose,
  argsTerminalCreate,
  argsTerminalList,
  argsTerminalRead,
  argsTerminalSend,
  argsWorktreeCreate,
  argsWorktreeSet,
  argsWorktreeRm,
  argsWorktreePs,
  applyWorktreeRmPlan,
  prepareWorktreeRm,
  assembleCardName,
  argsWorkerStart,
  argsWorkerRelease,
  argsWorkerRead,
  argsWorkerShow,
  argsOrchestrationReply,
  argsOrchestrationCheck,
  argsOrchestrationInbox,
  argsOrchestrationSend,
  argsRunShow,
  argsRunCurrent,
  argsRunList,
  extractSentMessage,
  argsGateCreate,
  argsGateResolve,
  argsGateList,
  assessWorktreeLiveness,
  assertCodexLaunch,
  catalogUsedFlags,
  checkHelpLiveness,
  checkIssueDisambiguated,
  deliverMessage,
  dispatchComment,
  envProbeWorktree,
  extractHandleFromCreate,
  extractDispatchId,
  extractTaskId,
  extractTerminalText,
  extractWorktreeId,
  extractWorktreePath,
  findDispatchForWorktree,
  argsWorkerList,
  gitBranchName,
  isRunRequired,
  RUN_REQUIRED_HINT,
  rollbackErrorAlreadyGone,
  fetchHelpPreferLive,
  loadRouting,
  parseArgs,
  parseGhPullFiles,
  planDispatchRollback,
  probeWaitMs,
  recordEscape,
  resolveDispatchConstraints,
  resolveLaunch,
  reviewerCardName,
  rollbackReport,
  renderDispatchTemplate,
  buildSoldierInject,
  buildReviewerInject,
  assertInjectText,
  encodeSendText,
  runGh,
  stampIssueLabels,
  syncPrLabelsFromIssue,
  resolveReviewerFromPr,
  planWorkerDone,
  completeWorkerDoneNotify,
  pickWorkerDoneDispatchId,
  resolveReviewerReuse,
  postIssueComment,
  postPrComment,
  verifyInjection,
  verifyStartedPolling,
  verifyWorkerStarted,
  verifyReviewerFiles,
  verifyReviewerTree,
  assessPrMergeable,
  trialMergeMaster,
  waitAndVerify,
} from './lib/dao-cmd.mjs';
import { afterDispatchComment } from './lib/master-title.mjs';
import { applyGitIdentity } from './lib/gh.mjs';
import { parseOrcaStdout } from './lib/orca-stdout.mjs';
import {
  loadLedgerContext, beijingIsoFrom, dispatchJobId, reviewerJobId, writeJobDispatch,
  writeJobOverride, resolveAmendTarget, formatAmendComment, workerJobId,
  linkAliasesToSuccessor, resolveMainWorktreeRoot,
} from './lib/ledger-job.mjs';
import { orcaErrorText } from './lib/orca-error.mjs';
import {
  ASK_TIMEOUT_MARK,
  planRunGc,
  resolveRunsForWorktrees,
  planInboxCollect,
  classifyMailboxRead,
  findThreadReply,
  classifyAskPoll,
  planStationRetire,
  applyStationRetire,
  resolveReplySender,
  parseAskTimeoutMs,
  finalizeWorktreeRmLifecycle,
  partitionGcTargets,
  summarizeGcApply,
  resolveStationCloseTarget,
  previewHandlesForRun,
} from './lib/run-lifecycle.mjs';
import { defaultLogRel, leasePath, launchFilePath, parseLease, isProcessAlive } from './inbox-station.mjs';

const ORCA_TIMEOUT_MS = 30000;

function errText(e) {
  return orcaErrorText(e);
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

/** gh 执行器。测试注入：DAO_GH_FAKE 指向假 gh 脚本时用它——
 * CI（check.yml）无 GH_TOKEN，CLI 级测试改走假 gh（tests/fixtures/fake-gh.mjs）。
 * 生产不设该变量。opts.role 在真 gh 路径透传给 runGh（#573 App 身份）。 */
function ghRunner(opts = {}) {
  const fake = process.env.DAO_GH_FAKE;
  if (!fake) return (args) => runGh(args, opts);
  return (args) => {
    const r = spawnSync(process.execPath, [fake, ...args], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
    if (r.error || (r.status !== 0 && r.status != null)) {
      return { ok: false, error: String(r.error?.message || r.stderr || `exit ${r.status}`).trim().slice(0, 240) };
    }
    return { ok: true, out: String(r.stdout || '') };
  };
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
    mergeReason: args.mergeReason,
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

function loadDispatchSlate({ model, role, routing, now, live }) {
  let selectOk = false;
  let selectError = null;
  let slateIds = null;
  if (live) {
    try {
      const models = parseYaml(readFileSync(join(ROOT, 'policy', 'models.yml'), 'utf8')).models;
      const bans = parseYaml(readFileSync(join(ROOT, 'policy', 'bans.yml'), 'utf8')).bans || [];
      const weights = parseYaml(readFileSync(join(ROOT, 'policy', 'weights.yml'), 'utf8'));
      const eventsDir = join(ROOT, 'ledger', 'events');
      const events = existsSync(eventsDir)
        ? readdirSync(eventsDir).filter(f => f.endsWith('.json')).map(f => JSON.parse(readFileSync(join(eventsDir, f), 'utf8')))
        : [];
      const result = select({
        ts: now instanceof Date ? now.toISOString() : String(now || new Date().toISOString()),
        jobId: 'dispatch-slate',
        identity: '工人',
        workType: role || '写码',
        events, models, bans, weights, routes: routing.routes || [],
      });
      selectOk = true;
      slateIds = Array.isArray(result.slate) ? result.slate : [];
    } catch (e) {
      selectOk = false;
      selectError = String(e.message || e);
    }
  }
  const packed = resolveDispatchSlate({
    live, selectOk, selectError, slateIds, routing, role, now, model,
  });
  if (!packed.ok) throw new Error(packed.error);
  return packed;
}

function closeWorkerHandle(handle) {
  if (!handle) return;
  const r = orca(argsTerminalClose({ terminal: handle, tab: true }));
  if (r.ok) return;
  orca(argsTerminalClose({ terminal: handle, tab: false }));
}

function startWorkerBySlate({ slate, startIndex, routing, worktreeId, title, created }) {
  let modelId = slate[startIndex].id;
  let pipeIndex = 0;
  let hardFailsOnThisPipe = 0;
  let transientFailsOnThisPipe = 0;
  const attempts = [];
  const maxSteps = 24;

  for (let step = 0; step < maxSteps; step++) {
    const entry = slate.find(s => s.id === modelId);
    if (!entry || !entry.pipes || !entry.pipes[pipeIndex]) {
      return { ok: false, error: `slate 缺 ${modelId} pipes[${pipeIndex}]`, attempts };
    }
    const pipe = entry.pipes[pipeIndex];
    let launch;
    try {
      launch = resolveLaunch({ model: modelId, pipe, routing, root: ROOT });
    } catch (e) {
      return { ok: false, error: String(e.message || e), attempts };
    }
    const cap = assertCodexLaunch({ command: launch.command });
    if (!cap.ok) return { ok: false, error: cap.error, attempts };

    const term = orca(argsTerminalCreate({
      worktree: worktreeId,
      title,
      command: launch.command,
    }));
    if (!term.ok) {
      const kind = classifyLaunchFailure({ error: errText(term.error) });
      attempts.push({ modelId, pipeIndex, provider: pipe.provider, kind, error: errText(term.error) });
      const next = advanceLaunchState({
        slate, modelId, pipeIndex, hardFailsOnThisPipe, transientFailsOnThisPipe, kind,
      });
      if (next.action === 'abort' || next.action === 'fail') {
        return { ok: false, error: `工人终端创建失败且名单走完: ${errText(term.error)}`, attempts, exhausted: true };
      }
      modelId = next.modelId;
      pipeIndex = next.pipeIndex;
      hardFailsOnThisPipe = next.hardFailsOnThisPipe;
      transientFailsOnThisPipe = next.transientFailsOnThisPipe;
      continue;
    }
    const handle = extractHandleFromCreate(term.json);
    if (!handle) return { ok: false, error: '工人终端没返回 handle', attempts };
    created.workerHandle = handle;

    const verify = waitAndVerify({
      readOnce: () => readOnceHandle(handle),
      timeoutMs: probeWaitMs(routing, launch.provider),
    });
    if (verify.ok) {
      return { ok: true, modelId, pipeIndex, pipe, launch, handle, attempts };
    }

    const kind = classifyLaunchFailure({
      error: verify.error,
      verifyReason: verify.reason,
      text: verify.text,
    });
    attempts.push({ modelId, pipeIndex, provider: pipe.provider, kind, reason: verify.reason });
    closeWorkerHandle(handle);
    created.workerHandle = undefined;

    if (kind === 'config') {
      return { ok: false, error: `工人 TUI 未就绪（配置）：${verify.reason}`, verify, attempts };
    }
    const next = advanceLaunchState({
      slate, modelId, pipeIndex, hardFailsOnThisPipe, transientFailsOnThisPipe, kind,
    });
    if (next.action === 'abort' || next.action === 'fail') {
      return { ok: false, error: '工人 TUI 未就绪且名单走完', verify, attempts, exhausted: true };
    }
    modelId = next.modelId;
    pipeIndex = next.pipeIndex;
    hardFailsOnThisPipe = next.hardFailsOnThisPipe;
    transientFailsOnThisPipe = next.transientFailsOnThisPipe;
  }
  return { ok: false, error: '启动序步数用尽', attempts };
}

function readOnceHandle(handle) {
  const read = orca(argsTerminalRead({ terminal: handle, limit: 80 }));
  if (!read.ok) return { error: errText(read.error) };
  return read.json;
}

/** 开工证明（#559 ⑥）：worker-read --source auto 官方 transcript 源优先。
 * 证明不了（source=terminal）不硬失败——verifyStartedPolling 降级到屏面稳定轮。
 * 没读成（unscanned）如实上报，不许当成「查过没事」。 */
function workerStartProof(dispatchId) {
  const r = orca(argsWorkerRead({ dispatch: dispatchId }));
  if (!r.ok) return { ok: false, unscanned: true, error: errText(r.error) };
  return verifyWorkerStarted(r.json);
}

/** 信箱台每轮 run-use 会抢走 coordinator。task-create 前当场夺回并带 --run，跟复用审官同一条重试。 */
function taskCreateOnRun(spec, runId) {
  let last = { ok: false, error: 'task-create 还没跑' };
  for (let i = 0; i < 3; i++) {
    if (runId) orca(['orchestration', 'run-use', '--id', runId, '--json']);
    last = orca(argsTaskCreate({ spec, run: runId || undefined }));
    if (last.ok) return last;
    const why = errText(last.error);
    if (!/run_required|consumer_fenced/i.test(why)) return last;
  }
  return last;
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function unwrapRuns(json) {
  return json?.result?.runs || json?.runs || null;
}

function unwrapWorkers(json) {
  return json?.result?.workers || null;
}

function stationFilesFor(runId) {
  const main = resolveMainWorktreeRoot({ from: ROOT });
  const base = main.ok ? main.root : ROOT;
  const logPath = join(base, defaultLogRel(runId));
  return [leasePath(logPath), launchFilePath(logPath), logPath];
}

function readStationLease(runId) {
  const files = stationFilesFor(runId);
  const [leaseFile] = files;
  try {
    if (!existsSync(leaseFile)) return { read: 'missing', lease: null, files };
    const lease = parseLease(readFileSync(leaseFile, 'utf8'));
    if (!lease) return { read: 'unscanned', lease: null, files, error: `租约坏了 ${leaseFile}` };
    return { read: 'ok', lease, files };
  } catch (e) {
    return { read: 'unscanned', lease: null, files, error: `租约没读成 ${leaseFile}：${e && e.message ? e.message : e}` };
  }
}

function retireOneRun(runId) {
  const shown = orca(argsRunShow({ id: runId }));
  if (!shown.ok) {
    const text = errText(shown.error);
    if (/run_not_found/i.test(text)) return { ok: false, state: 'run_not_found', runId, error: text };
    return { ok: false, unscanned: true, runId, error: text };
  }
  const listed = orca(argsTerminalList());
  if (!listed.ok) {
    return { ok: false, unscanned: true, runId, error: `terminal list 没查成：${errText(listed.error)}` };
  }
  const terminals = listed.json?.result?.terminals;
  if (!Array.isArray(terminals)) {
    return { ok: false, unscanned: true, runId, error: 'terminal list 结构不认识' };
  }
  const leaseInfo = readStationLease(runId);
  if (leaseInfo.read === 'unscanned') {
    return { ok: false, unscanned: true, runId, error: leaseInfo.error };
  }
  const lease = leaseInfo.lease;
  const pidAlive = lease && lease.pid ? isProcessAlive(lease.pid) : null;
  const target = resolveStationCloseTarget({
    runId,
    lease,
    leaseRead: leaseInfo.read,
    pidAlive,
    coordinatorHandle: shown.json?.result?.run?.coordinator_handle || null,
    terminals,
    previewHandles: previewHandlesForRun(terminals, runId),
  });
  if (!target.ok) {
    return { ok: false, unscanned: !!target.unscanned, runId, error: target.error };
  }
  const plan = planStationRetire({
    runId,
    closeHandle: target.closeHandle,
    files: leaseInfo.files,
  });
  return applyStationRetire(plan, {
    closeTerminal: (h) => orca(argsTerminalClose({ terminal: h, tab: true })),
    unlink: unlinkSync,
  });
}

function loadLifecycleInputs() {
  const listed = orca(argsWorktreePs());
  if (!listed.ok) return { ok: false, error: `盘面没查成: ${errText(listed.error)}` };
  const worktrees = listed.json?.result?.worktrees;
  if (!Array.isArray(worktrees)) return { ok: false, error: 'worktree ps 没有 result.worktrees' };
  const wl = orca(argsWorkerList());
  if (!wl.ok) return { ok: false, error: `worker-list 没查成: ${errText(wl.error)}` };
  const workers = unwrapWorkers(wl.json);
  if (!Array.isArray(workers)) return { ok: false, error: 'worker-list 没有 result.workers' };
  const rl = orca(argsRunList());
  if (!rl.ok) return { ok: false, error: `run-list 没查成: ${errText(rl.error)}` };
  const runs = unwrapRuns(rl.json);
  if (!Array.isArray(runs)) return { ok: false, error: 'run-list 没有 result.runs' };
  return { ok: true, worktrees, workers, runs };
}

function runIdFromDispatch(dispatchId) {
  if (!dispatchId) return null;
  const shown = orca(argsWorkerShow({ dispatch: dispatchId }));
  if (!shown.ok) return null;
  return shown.json?.result?.dispatch?.run_id
    || shown.json?.result?.dispatch?.runId
    || shown.json?.result?.worker?.run_id
    || null;
}

function cmdDispatch(args) {
  const routing = loadOrFail();
  const gate = constrainDispatch(args, routing);
  if (!args.spec && !args.task) fail('dispatch 要 --spec（工人任务书），或已有 --task');
  if (!args.name && !args.dryRun) fail('dispatch 要 --name');

  const now = args.now ? new Date(args.now) : new Date();
  let slatePack;
  try {
    slatePack = loadDispatchSlate({
      model: gate.model,
      role: gate.role,
      routing,
      now,
      live: !args.dryRun,
    });
  } catch (e) { fail(String(e.message || e)); }

  const startEntry = slatePack.slate[slatePack.startIndex];
  let workerLaunch;
  let reviewerLaunch;
  try {
    workerLaunch = resolveLaunch({ model: startEntry.id, pipe: startEntry.pipes[0], routing, root: ROOT });
    reviewerLaunch = resolveLaunch({ model: gate.reviewer, routing, root: ROOT });
  } catch (e) { fail(String(e.message || e)); }

  const workerCap = assertCodexLaunch({ command: workerLaunch.command });
  if (!workerCap.ok) fail(workerCap.error);
  const reviewerCap = assertCodexLaunch({ command: reviewerLaunch.command });
  if (!reviewerCap.ok) fail(reviewerCap.error);

  const plan = {
    mergePolicy: gate.mergePolicy,
    mergeReason: gate.mergeReason,
    model: startEntry.id,
    reviewer: gate.reviewer,
    issue: args.issue ? String(args.issue).trim() : null,
    workerCard: assembleCardName({ name: args.name, issue: args.issue, role: '工人', model: gate.model }),
    workerLaunch: workerLaunch.command,
    reviewerDeferred: true,
    reviewerLaunchChecked: reviewerLaunch.command,
    comment: dispatchComment(gate),
    slate: slatePack.slate,
    pipeIndex: 0,
  };

  // 消歧门（#565）：带 --issue 的**真派工**，目标 issue 必须已打「已消歧」label，读不到拒派（fail-close）。
  // #565 返工：dry-run 不实际派工，门控对预览无意义——disambiguation 字段只作报告保留，**不影响退出码**；
  // 真派工在一切建卡动作之前拦（被拦下时什么都不会创建）。gh 查失败单独报「没查成」，不许当有 label 放行。
  const disambiguation = checkIssueDisambiguated({ issue: args.issue, runGh: ghRunner() });

  if (args.dryRun) {
    emit({ ok: true, dryRun: true, ...plan, disambiguation });
  }
  if (!disambiguation.ok) {
    fail(disambiguation.error, { disambiguation, ...plan });
  }
  if (!args.name) fail('dispatch 要 --name');

  const created = {};

  const workerWt = orca(argsWorktreeCreate({
    name: plan.workerCard,
    noParent: true,
    setup: 'skip',
    issue: args.issue,
    comment: plan.comment,
  }));
  if (!workerWt.ok) fail(`工人卡创建失败: ${errText(workerWt.error)}`, plan);
  created.workerId = extractWorktreeId(workerWt.json);
  created.workerPath = extractWorktreePath(workerWt.json);
  if (!created.workerId) fail('工人卡没返回 id', plan);
  if (!created.workerPath) failCreated(created, '工人卡没返回 path', plan);

  const workerEnv = envProbeWorktree(created.workerPath);
  if (!workerEnv.ok) failCreated(created, `工人树环境自检失败: ${workerEnv.error}`, { probes: workerEnv, ...plan });

  // #573：commit author 跟身份走。token 只改 PR 页，git log 仍读 user.name——
  // 只改一半比不改更容易误判。写在 worktree 级 config，不碰共用 user.name。
  const workerIdent = applyGitIdentity('worker', { cwd: created.workerPath });
  if (!workerIdent.ok) failCreated(created, `工人 git 身份没设上：${workerIdent.error}`, plan);
  created.workerGitIdentity = `${workerIdent.name} <${workerIdent.email}>`;

  const workerBranch = gitBranchName(created.workerPath);
  if (!workerBranch.ok) failCreated(created, `工人树分支没查成: ${workerBranch.error}`, plan);

  const launched = startWorkerBySlate({
    slate: slatePack.slate,
    startIndex: slatePack.startIndex,
    routing,
    worktreeId: created.workerId,
    title: args.name,
    created,
  });
  if (!launched.ok) {
    failCreated(created, launched.error || '工人 TUI 未就绪', { verify: launched.verify, attempts: launched.attempts, ...plan });
  }
  workerLaunch = launched.launch;
  created.workerHandle = launched.handle;
  plan.model = launched.modelId;
  plan.pipeIndex = launched.pipeIndex;
  plan.workerLaunch = launched.launch.command;
  plan.launchAttempts = launched.attempts;

  // #602：注入只给一行指针 + spec + 参数。换行按 agent 转码（grok 转 ESC+CR），不禁换行；硬闸只有 UTF-8 字节 ≤500。
  let soldierBook = null;
  try {
    soldierBook = args.spec
      ? encodeSendText(buildSoldierInject({ spec: String(args.spec), issue: args.issue }), workerLaunch.provider)
      : null;
  } catch (e) {
    failCreated(created, `任务书模板渲染失败: ${String(e.message || e)}`, { ...plan, soldierBook: null });
  }

  let taskId = args.task || null;
  if (soldierBook) {
    const bound = orca(argsRunCurrent());
    const boundRun = bound.ok ? (bound.json?.result?.run?.id || null) : null;
    const task = taskCreateOnRun(soldierBook, boundRun);
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
  created.workerDispatchId = extractDispatchId(started.json);
  if (!created.workerDispatchId) {
    failCreated(created, 'worker-start 没拿到 dispatch id（没查成，不能把消息发进真空）', { ...plan, taskId });
  }

  // 开工验证：等 worker-read 证明。不再为折叠补回车（#602）。
  const workerInject = verifyStartedPolling({
    dispatchId: created.workerDispatchId,
    readOnce: () => readOnceHandle(created.workerHandle),
    proofOnce: workerStartProof,
    timeoutMs: probeWaitMs(routing, workerLaunch.provider),
    label: '工人',
  });
  if (!workerInject.ok) failCreated(created, `注入后开工验证失败: ${workerInject.reason}`, { inject: workerInject, ...plan, taskId });
  const workerProof = workerStartProof(created.workerDispatchId); // 成功后再取一次留档（emit 用）

  const comment = afterDispatchComment({
    name: args.name,
    issue: args.issue,
    worktreeId: created.workerId,
    runOrca: orca,
  });

  // #564 label 自动打：dispatch 成功时把 model/<模型> type/<角色> 打到目标 issue（best-effort，
  // 失败只报告不翻转派工结果——label 是校准数据源，但回滚一个成功的派工代价更大；帅合并时
  // 用 pr-sync-labels 从 issue 同步到 PR）。gh 没查成 != 查过没事：失败也要说清楚。
  // 身份走 marshal：这是帅进程里写 issue（#627），裸 gh 会记成 thoerwink8。
  const labels = stampIssueLabels({
    issue: args.issue,
    model: plan.model,
    role: gate.role,
    reviewer: gate.reviewer,
    runGh: ghRunner({ role: 'marshal' }),
  });
  if (!labels.ok && !labels.skipped) {
    console.error(`[dao] dispatch label 没打上（派工本身成功）：${labels.error}`);
  }

  // #581：派工当下只写工人 job.dispatch。审官那条在 reviewer-create（#586 换落点）。
  let ledger = null;
  try {
    const ctx = loadLedgerContext({ root: ROOT });
    const ts = beijingIsoFrom(new Date());
    ledger = writeJobDispatch({
      ...ctx,
      ts,
      jobId: dispatchJobId(created.workerDispatchId),
      model: plan.model,
      identity: '工人',
      workType: gate.role || '写码',
      terminal: workerLaunch.provider || 'dao',
      extra: {
      source: 'dao-dispatch',
      dispatch_id: created.workerDispatchId,
      pipe_index: plan.pipeIndex,
      pipe_provider: workerLaunch.provider,
      ...(args.issue ? { issue_number: Number(args.issue) || args.issue } : {}),
    },
    });
    if (!ledger.ok && !ledger.skipped) {
      console.error(`[dao] dispatch 账本没写上（派工本身成功）：${ledger.error}`);
    }
  } catch (e) {
    ledger = { ok: false, error: String(e.message || e) };
    console.error(`[dao] dispatch 账本没写上（派工本身成功）：${ledger.error}`);
  }

  emit({
    ok: true,
    ...plan,
    ...created,
    taskId,
    loop: {
      soldierBook: !!soldierBook,
      reviewerDeferred: true,
      soldierDoneVia: 'worker-done',
      archivedBy: '帅（归档动作帅做，审官不 rm 树）',
    },
    probes: { worker: workerEnv },
    inject: workerInject,
    startProof: workerProof,
    comment,
    labels,
    ledger,
  });
}

function cmdPrSyncLabels(args) {
  const r = syncPrLabelsFromIssue({ pr: args.pr, runGh: ghRunner() });
  if (!r.ok) fail(r.error, r);
  emit({ ok: true, ...r });
}

function invokeReviewerCreate({ pr, name, parentWorktree, soldierDispatch, issue, dryRun } = {}) {
  const argv = [process.argv[1], 'reviewer-create', '--pr', String(pr)];
  if (name) argv.push('--name', String(name));
  if (parentWorktree) argv.push('--parent-worktree', String(parentWorktree));
  if (soldierDispatch) argv.push('--soldier-dispatch', String(soldierDispatch));
  if (issue) argv.push('--issue', String(issue));
  if (dryRun) argv.push('--dry-run');
  const r = spawnSync(process.execPath, argv, {
    encoding: 'utf8',
    cwd: ROOT,
    env: process.env,
    windowsHide: true,
    timeout: dryRun ? 60000 : 180000,
  });
  let json = null;
  try { json = JSON.parse(String(r.stdout || '').trim().split(/\r?\n/).pop()); }
  catch { json = null; }
  if ((r.status !== 0 && r.status != null) || !json || json.ok !== true) {
    return {
      ok: false,
      invoked: true,
      dryRun: !!dryRun,
      error: (json && json.error) || String(r.stderr || '').trim() || `reviewer-create exit ${r.status}`,
    };
  }
  return {
    ok: true,
    invoked: true,
    dryRun: !!dryRun,
    verb: 'reviewer-create',
    pr: String(pr),
    reviewer: json.reviewer,
    reviewerSource: json.reviewerSource,
    reviewerId: json.reviewerId || null,
    reviewerDispatchId: json.reviewerDispatchId || null,
    reason: dryRun ? 'dry-run：只打印选型不建树' : '已调 reviewer-create 起审官',
  };
}

function currentWorktreeId() {
  const r = orca(['worktree', 'current', '--json']);
  if (!r.ok) return { ok: false, error: errText(r.error) };
  const id = r.json?.result?.worktree?.id;
  if (!id) return { ok: false, error: 'worktree current 没返回 id' };
  return { ok: true, id };
}

/** PR 开出来后把工人卡从 ISSUE-/#N 改成 PR-。挂在 worker-done，不靠人记得。 */
function promoteWorkerCardToPr({ parentId, worktrees, pr, model } = {}) {
  if (!parentId || !pr) return { ok: true, skipped: true, reason: '没给工人卡或 PR 号' };
  const wt = (worktrees || []).find(w => {
    const id = w && (w.id || w.worktreeId);
    return id && (id === parentId || String(id).endsWith(parentId) || String(parentId).endsWith(id));
  });
  if (!wt) return { ok: true, skipped: true, reason: '盘面找不到工人卡' };
  const current = String(wt.displayName || '');
  const next = assembleCardName({ name: current || '工人', pr, role: '工人', model });
  if (!next || next === current) return { ok: true, skipped: true, name: current };
  const r = orca(argsWorktreeSet({ worktree: parentId, displayName: next }));
  if (!r.ok) return { ok: false, error: `工人卡改名失败：${errText(r.error)}`, from: current, to: next };
  return { ok: true, from: current, to: next };
}

function loadReviewerReuseInputs() {
  const listed = orca(['worktree', 'list', '--json']);
  if (!listed.ok) return { ok: false, error: `worktree list 没查成：${errText(listed.error)}` };
  const worktrees = listed.json?.result?.worktrees || listed.json?.worktrees;
  if (!Array.isArray(worktrees)) return { ok: false, error: 'worktree list 结构不认识' };

  const wl = orca(argsWorkerList());
  if (!wl.ok) return { ok: false, error: `worker-list 没查成：${errText(wl.error)}` };
  const workers = wl.json?.result?.workers;
  if (!Array.isArray(workers)) return { ok: false, error: 'worker-list 结构不认识' };

  const tl = orca(argsTerminalList());
  if (!tl.ok) return { ok: false, error: `terminal list 没查成：${errText(tl.error)}` };
  const terminals = tl.json?.result?.terminals || tl.json?.terminals;
  if (!Array.isArray(terminals)) return { ok: false, error: 'terminal list 结构不认识' };

  return { ok: true, worktrees, workers, terminals };
}

function reuseReviewerOnTerminal({
  pr, reviewerWorktreeId, handle, parentWorktree, soldierDispatch, reviewer, dryRun,
} = {}) {
  if (dryRun) {
    return {
      ok: true,
      invoked: true,
      dryRun: true,
      reused: true,
      reviewerId: reviewerWorktreeId,
      reviewerHandle: handle,
      reason: 'dry-run：复用已有审官终端，不建卡',
    };
  }
  if (!reviewerWorktreeId || !handle) {
    return { ok: false, reused: true, error: '复用审官缺 worktree / handle' };
  }

  const gh = ghRunner({ role: 'reviewer' });
  const meta = gh(['pr', 'view', String(pr), '--json', 'headRefName,headRefOid,mergeable']);
  if (!meta.ok) return { ok: false, reused: true, error: `复用审官读 PR #${pr} 失败：${meta.error}` };
  let head;
  try { head = JSON.parse(meta.out); }
  catch { return { ok: false, reused: true, error: `复用审官读 PR #${pr} 返回不是 JSON` }; }
  const mergeable = assessPrMergeable(head?.mergeable);
  if (!mergeable.ok) return { ok: false, reused: true, error: mergeable.error, mergeable };

  let soldierDispatchId = soldierDispatch || null;
  let runId = null;
  if (parentWorktree) {
    const wl = orca(argsWorkerList());
    if (!wl.ok) return { ok: false, reused: true, error: `worker-list 没查成，给 --soldier-dispatch：${errText(wl.error)}` };
    const found = findDispatchForWorktree(wl.json, parentWorktree);
    if (!found.ok && !soldierDispatchId) {
      return { ok: false, reused: true, error: `找不到士兵 dispatch（${found.error}）。给 --soldier-dispatch` };
    }
    if (!soldierDispatchId && found.ok) soldierDispatchId = found.dispatchId;
    if (found.ok) runId = found.runId || null;
  }
  if (!soldierDispatchId) {
    return { ok: false, reused: true, error: '复用审官没拿到士兵 dispatch id（给 --soldier-dispatch 或 --parent-worktree）' };
  }
  if (!runId) {
    return { ok: false, reused: true, error: '复用审官没拿到士兵 run id，task-create 会 run_required（没查成）' };
  }

  let reviewerBook;
  try {
    reviewerBook = encodeSendText(buildReviewerInject({
      spec: `复用审官终端审 PR #${pr}`,
      pr: String(pr),
      soldierDispatchId: String(soldierDispatchId),
      mergePolicy: 'auto',
    }), reviewer);
  } catch (e) {
    return { ok: false, reused: true, error: `复用审官任务书渲染失败: ${String(e.message || e)}` };
  }

  let revTask = { ok: false, error: 'task-create 还没跑' };
  for (let i = 0; i < 3; i++) {
    orca(['orchestration', 'run-use', '--id', runId, '--json']);
    revTask = orca(argsTaskCreate({ spec: reviewerBook, run: runId }));
    if (revTask.ok) break;
    const why = errText(revTask.error);
    if (!/run_required|consumer_fenced/i.test(why)) break;
  }
  if (!revTask.ok) {
    if (isRunRequired(revTask.error) || /consumer_fenced/i.test(errText(revTask.error))) {
      return { ok: false, reused: true, error: `${RUN_REQUIRED_HINT}（${errText(revTask.error)}）` };
    }
    return { ok: false, reused: true, error: `复用审官 task-create 失败: ${errText(revTask.error)}` };
  }
  const reviewerTaskId = extractTaskId(revTask.json);
  if (!reviewerTaskId) {
    return { ok: false, reused: true, error: '复用审官 task-create 没拿到 taskId（要 result.task.id，不是最外层 id）' };
  }

  const revStarted = orca(argsWorkerStart({
    task: reviewerTaskId,
    worktree: reviewerWorktreeId,
    terminal: handle,
  }), 180000);
  if (!revStarted.ok) {
    return { ok: false, reused: true, error: `复用审官 worker-start 失败: ${errText(revStarted.error)}（必须带 --worktree 指审官树）` };
  }
  const reviewerDispatchId = extractDispatchId(revStarted.json);
  if (!reviewerDispatchId) {
    return { ok: false, reused: true, error: '复用审官 worker-start 没拿到 dispatch id（没查成，不是已开工）' };
  }

  let routing;
  try { routing = loadRouting(); }
  catch (e) { return { ok: false, reused: true, error: String(e.message || e) }; }
  let launch;
  try { launch = resolveLaunch({ model: reviewer, routing, root: ROOT }); }
  catch { launch = { provider: 'gpt' }; }

  const reviewerInject = verifyStartedPolling({
    dispatchId: reviewerDispatchId,
    readOnce: () => readOnceHandle(handle),
    proofOnce: workerStartProof,
    timeoutMs: probeWaitMs(routing, launch.provider),
    label: '审官',
  });
  if (!reviewerInject.ok) {
    return { ok: false, reused: true, error: `复用审官注入后开工验证失败: ${reviewerInject.reason}`, reviewerInject };
  }

  const identity = deliverMessage({
    to: `dispatch:${soldierDispatchId}`,
    subject: `审官身份：${reviewerDispatchId}`,
    body: `复用原审官终端。新 dispatch id = ${reviewerDispatchId}（士兵→审官 完工通知 --to dispatch:<这个 id>）。`,
    hop: 'worker-done→士兵（复用审官身份）',
    orca: (a) => orca(a),
  });
  if (!identity.ok) {
    return { ok: false, reused: true, error: `复用审官身份消息没送到士兵: ${identity.error}`, identity };
  }

  let ledger = null;
  try {
    const ctx = loadLedgerContext({ root: ROOT });
    ledger = writeJobDispatch({
      ...ctx,
      ts: beijingIsoFrom(new Date()),
      jobId: reviewerJobId(pr),
      model: reviewer,
      identity: '审官',
      workType: '审查',
      terminal: launch.provider || 'dao',
      prNumber: Number(pr),
      extra: { source: 'worker-done-reuse', worktreeId: reviewerWorktreeId, reused: true },
    });
  } catch (e) {
    ledger = { ok: false, error: String(e.message || e) };
  }

  return {
    ok: true,
    invoked: true,
    reused: true,
    reviewerId: reviewerWorktreeId,
    reviewerHandle: handle,
    reviewerDispatchId,
    reviewerTaskId,
    soldierDispatchId,
    inject: reviewerInject,
    identity,
    ledger,
    reason: '新 Task 注入老审官终端，不建卡',
  };
}

function cmdWorkerDone(args) {
  if (!args.pr) fail('worker-done 要 --pr');
  let body = args.body;
  if (args.bodyFile) {
    try { body = readFileSync(args.bodyFile, 'utf8'); }
    catch (e) { fail(`worker-done 读 --body-file 失败：${e.message || e}`); }
  }
  const gh = ghRunner({ role: 'worker' });
  const plan = planWorkerDone({ pr: args.pr, body, runGh: gh });
  if (!plan.ok) fail(plan.error, plan);

  let parentId = args.parentWorktree || null;
  if (!parentId && !args.dryRun) {
    const cur = currentWorktreeId();
    if (!cur.ok) fail(`worker-done 找不到当前工人卡：${cur.error}（给 --parent-worktree）`, plan);
    parentId = cur.id;
  }

  let reuse = {
    ok: true,
    action: null,
    reason: null,
  };
  let reuseInputs = { worktrees: [], workers: [], terminals: [] };
  if (args.dryRun && !parentId) {
    reuse = {
      ok: true,
      action: plan.shouldCreate ? 'create' : 'reuse',
      reason: plan.shouldCreate
        ? 'dry-run 未给 --parent-worktree，按首审预览建卡'
        : 'dry-run 未给 --parent-worktree，返工预览不建卡',
    };
  }
  if (parentId) {
    const inputs = loadReviewerReuseInputs();
    if (!inputs.ok) fail(`worker-done 查可复用审官失败：${inputs.error}`, plan);
    reuseInputs = inputs;
    reuse = resolveReviewerReuse({
      parentId,
      worktrees: inputs.worktrees,
      workers: inputs.workers,
      terminals: inputs.terminals,
    });
    if (!reuse.ok) fail(reuse.error, { ...plan, reuse });
  }

  let renamed = { ok: true, skipped: true };
  if (args.dryRun) {
    const wt = reuseInputs.worktrees.find(w => (w.id || w.worktreeId) === parentId);
    const preview = assembleCardName({
      name: (wt && wt.displayName) || '工人',
      pr: plan.pr,
      role: '工人',
      model: plan.workerModel,
    });
    renamed = { ok: true, dryRun: true, to: preview };
  } else if (parentId) {
    renamed = promoteWorkerCardToPr({
      parentId,
      worktrees: reuseInputs.worktrees,
      pr: plan.pr,
      model: plan.workerModel,
    });
    if (!renamed.ok) fail(renamed.error, { ...plan, renamed, reuse });
  }

  const shouldCreate = reuse.action === 'create';
  const shouldReuse = reuse.action === 'reuse';
  // #589：审官卡名用 PR 号。找卡走 parent+记账，不拿 issue 号去对名字。
  const createName = assembleCardName({
    name: reviewerCardName(plan.reviewer),
    pr: plan.pr,
    role: '审官',
    model: plan.reviewer,
  });
  let create = {
    invoked: false,
    skipped: !shouldCreate,
    reason: shouldReuse ? reuse.reason : (shouldCreate ? plan.reviewerCreate.reason : reuse.reason),
  };
  let reused = {
    invoked: false,
    skipped: !shouldReuse,
    reason: shouldReuse ? reuse.reason : '本轮不复用',
  };

  if (args.dryRun) {
    if (shouldCreate) {
      create = invokeReviewerCreate({
        pr: args.pr,
        name: createName,
        parentWorktree: parentId,
        soldierDispatch: args.soldierDispatch,
        issue: plan.issue,
        dryRun: true,
      });
      if (!create.ok) fail(create.error, { ...plan, reviewerCreate: create, reuse });
    } else if (shouldReuse && reuse.worktreeId && reuse.handle) {
      reused = reuseReviewerOnTerminal({
        pr: args.pr,
        reviewerWorktreeId: reuse.worktreeId,
        handle: reuse.handle,
        parentWorktree: parentId,
        soldierDispatch: args.soldierDispatch,
        reviewer: plan.reviewer,
        dryRun: true,
      });
    }
    emit({
      ok: true,
      dryRun: true,
      ...plan,
      shouldCreate,
      shouldReuse,
      reuse,
      renamed,
      reviewerCreate: create,
      reviewerReuse: reused,
    });
  }

  if (shouldCreate) {
    create = invokeReviewerCreate({
      pr: args.pr,
      name: createName,
      parentWorktree: parentId,
      soldierDispatch: args.soldierDispatch,
      issue: plan.issue,
      dryRun: false,
    });
    if (!create.ok) fail(create.error, { ...plan, reviewerCreate: create, reuse });
  } else if (shouldReuse) {
    reused = reuseReviewerOnTerminal({
      pr: args.pr,
      reviewerWorktreeId: reuse.worktreeId,
      handle: reuse.handle,
      parentWorktree: parentId,
      soldierDispatch: args.soldierDispatch,
      reviewer: plan.reviewer,
      dryRun: false,
    });
    // 续 capability 失败不能吞掉返工投递：审官要的是结构化消息，帅会另开复核 Task。
    if (!reused.ok) {
      reused = { ...reused, invoked: true, skipped: true, reuseFailed: true };
    }
  }

  let existingDispatchId = null;
  const needExisting = !((create && create.reviewerDispatchId) || (reused && reused.reviewerDispatchId));
  if (needExisting && reuse.worktreeId) {
    const wl = orca(argsWorkerList());
    if (!wl.ok) fail(`已有审官树但 worker-list 没查成：${errText(wl.error)}`, { ...plan, reviewerCreate: create, reviewerReuse: reused });
    const found = findDispatchForWorktree(wl.json, reuse.worktreeId);
    if (!found.ok) fail(`已有审官树但找不到 dispatch：${found.error}`, { ...plan, reviewerCreate: create, reviewerReuse: reused, found });
    existingDispatchId = found.dispatchId;
  }
  const picked = pickWorkerDoneDispatchId({ create, reused, existingDispatchId });
  if (!picked.ok) fail(picked.error, { ...plan, reviewerCreate: create, reviewerReuse: reused, reuse });

  const postedIssue = postIssueComment({ issue: plan.issue, body: plan.comment, runGh: gh });
  if (!postedIssue.ok) fail(postedIssue.error, { ...plan, postedIssue, reviewerCreate: create, reviewerReuse: reused });
  const postedPr = postPrComment({ pr: plan.pr, body: plan.comment, runGh: gh });
  if (!postedPr.ok) fail(postedPr.error, { ...plan, postedIssue, postedPr, reviewerCreate: create, reviewerReuse: reused });

  const reviewerDispatchId = picked.reviewerDispatchId;
  const notify = completeWorkerDoneNotify({
    round: plan.round,
    pr: plan.pr,
    comment: plan.comment,
    reviewerDispatchId,
    shouldCreate,
    deliver: deliverMessage,
    orca: (a) => orca(a),
  });
  if (!notify.ok) fail(notify.error, { ...plan, postedIssue, postedPr, notified: notify.notified, reviewerCreate: create, reviewerReuse: reused });
  const notified = notify.notified;

  let ledgerLink = null;
  try {
    const ctx = loadLedgerContext({ root: ROOT });
    const listed = readLedgerEvents(ctx.dir);
    const events = listed.unscanned ? [] : listed.events;
    ledgerLink = linkAliasesToSuccessor({
      ctx,
      ts: beijingIsoFrom(new Date()),
      events,
      successorJobId: workerJobId(Number(args.pr)),
      issueNumber: plan.issue ? Number(plan.issue) : null,
      prNumber: Number(args.pr),
      identity: '工人',
    });
  } catch (e) {
    ledgerLink = { ok: false, error: String(e.message || e) };
  }

  emit({
    ok: true,
    commentPosted: true,
    ...plan,
    shouldCreate,
    shouldReuse,
    reuse,
    renamed,
    postedIssue,
    postedPr,
    reviewerCreate: create,
    reviewerReuse: reused,
    notified,
    notifiedDispatchId: reviewerDispatchId,
    ledgerLink,
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
    timeoutMs: probeWaitMs(routing, launch.provider),
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

  emit({
    ok: true,
    handle,
    provider: launch.provider,
    command: launch.command,
    verify: { ok: true },
  });
}

function cmdWorktreeCreate(args) {
  if (!args.name && !args.issue) fail('worktree-create 要 --name（或 --issue 组装卡名）');
  const r = orca(argsWorktreeCreate({
    name: assembleCardName({ name: args.name, issue: args.issue, role: args.role, model: args.model }),
    noParent: args.noParent,
    setup: args.setup,
    parentWorktree: args.parentWorktree,
    baseBranch: args.baseBranch,
    issue: args.issue,
    comment: args.comment,
  }));
  if (!r.ok) fail(`worktree create 失败: ${errText(r.error)}`);
  emit({ ok: true, json: r.json });
}

function cmdLedgerQuery(args) {
  if (args.recent == null && args.issue == null && !args.unclosed) {
    fail('ledger-query 要 --recent <n> 或 --issue <号> 或 --unclosed');
  }
  const listed = readLedgerEvents(join(ROOT, 'ledger', 'events'));
  if (listed.unscanned) fail(`账本没查成：${listed.error}`);
  const r = queryLedger({
    events: listed.events,
    recent: args.recent,
    issue: args.issue,
    unclosed: !!args.unclosed,
  });
  if (r.kind === 'unscanned') fail(`账本没查成：${r.error}`);
  const unclosed = args.unclosed ? describeUnclosedJobs(listed.events) : undefined;
  emit({
    ok: true,
    kind: r.kind,
    count: r.count,
    line: r.line,
    ...(unclosed ? { unclosed } : {}),
    events: r.events.map(e => ({
      ts: e.ts || null,
      type: e.type || null,
      job_id: e.job_id || null,
      pr_number: e.pr_number ?? null,
      model: e.model || null,
    })),
  });
}

function cmdAmend(args) {
  if (!args.why || !String(args.why).trim()) fail('amend 要 --why <一句话>');
  const by = args.by || '帅';
  if (by !== '帅' && by !== '用户') fail('amend --by 只认 帅 或 用户');
  let ctx;
  try { ctx = loadLedgerContext({ root: ROOT }); }
  catch (e) { fail(`账本落点没查成：${e.message || e}`); }
  const listed = readLedgerEvents(ctx.dir);
  if (listed.unscanned) fail(`账本没查成：${listed.error}`);
  const target = resolveAmendTarget({ events: listed.events, issue: args.issue, pr: args.pr });
  if (!target.ok) fail(target.error);
  const model = args.model || target.model;
  if (!model) fail('amend 找不到该单模型——给 --model');
  const issue = args.issue || target.issueNumber;
  if (!issue) fail('amend 要 --issue（正文要发到 issue）');
  if (args.dryRun) {
    emit({
      ok: true,
      dryRun: true,
      jobId: target.jobId,
      prNumber: target.prNumber,
      issueNumber: Number(issue),
      model,
      why: String(args.why).trim(),
      triggeredBy: by,
    });
  }
  const written = writeJobOverride({
    ...ctx,
    ts: beijingIsoFrom(new Date()),
    jobId: target.jobId,
    model,
    identity: '帅',
    workType: target.workType || '写码',
    triggeredBy: by,
    why: String(args.why).trim(),
    prNumber: target.prNumber,
    issueNumber: Number(issue),
    extra: { source: 'dao-amend' },
  });
  if (!written.ok) fail(`job.override 没写上：${written.error}`);
  const body = formatAmendComment({
    triggeredBy: by,
    why: String(args.why).trim(),
    jobId: target.jobId,
    eventId: written.event && written.event.event_id,
  });
  // amend 是帅追加职责，评论走 marshal（#627）。
  const posted = postIssueComment({ issue, body, runGh: ghRunner({ role: 'marshal' }) });
  if (!posted.ok) fail(`override 已写入但 issue 评论没发出：${posted.error}`, { ledger: written, posted });
  emit({
    ok: true,
    skipped: Boolean(written.skipped),
    jobId: target.jobId,
    prNumber: target.prNumber,
    issueNumber: Number(issue),
    model,
    triggeredBy: by,
    why: String(args.why).trim(),
    eventId: written.event && written.event.event_id,
    path: written.path || null,
    posted,
  });
}

function cmdWorktreeRm(args) {
  if (!args.worktree) fail('worktree-rm 要 --worktree');
  const listed = orca(argsWorktreePs());
  if (!listed.ok) fail(`盘面没查成，未删任何树: ${errText(listed.error)}`);
  const wts = listed.json?.result?.worktrees;
  if (!Array.isArray(wts)) fail('worktree ps 没有 result.worktrees，未删任何树');
  const main = resolveMainWorktreeRoot({ from: ROOT });
  const plan = prepareWorktreeRm(wts, args.worktree, {
    mainEventsDir: main.ok ? join(main.root, 'ledger', 'events') : null,
  });
  if (!plan.ok) fail(plan.error, { occupied: plan.occupied || [], stray: plan.stray || [] });
  const wl = orca(argsWorkerList());
  if (!wl.ok) fail(`worker-list 没查成，未删任何树: ${errText(wl.error)}`);
  const workers = unwrapWorkers(wl.json);
  if (!Array.isArray(workers)) fail('worker-list 没有 result.workers，未删任何树');
  const rl = orca(argsRunList());
  if (!rl.ok) fail(`run-list 没查成，未删任何树: ${errText(rl.error)}`);
  const runs = unwrapRuns(rl.json);
  if (!Array.isArray(runs)) fail('run-list 没有 result.runs，未删任何树');
  const mapped = resolveRunsForWorktrees({
    workers,
    treeIds: plan.order.map(n => n.id),
    treePaths: plan.order.map(n => n.path).filter(Boolean),
  });
  if (!mapped.ok) fail(`Run 映射没查成，未删任何树: ${mapped.error}`);
  // 先按「删完之后还剩哪些树」算保护，再退役，最后才删树。
  // #601：#598 把退役排在删树之后，活着的 dispatch 仍保护本单 Run，台没关。
  const removing = new Set(plan.order.map(n => n.id));
  const remaining = wts.filter(w => {
    const id = w.worktreeId || w.id;
    return id && !removing.has(id);
  });
  const gc = planRunGc({ runs, workers, worktrees: remaining });
  if (!gc.ok) fail(`退役名单没查成，未删任何树: ${gc.error}`);
  const retireResults = [];
  for (const runId of mapped.runIds) {
    if (!gc.retire.some(r => r.id === runId)) continue;
    retireResults.push(retireOneRun(runId));
  }
  const life = finalizeWorktreeRmLifecycle({ mapped, gc, retireResults });
  if (!life.ok) {
    fail(life.error, { runs: life });
  }
  const applied = applyWorktreeRmPlan(plan, {
    rm: (node) => orca(argsWorktreeRm({ worktree: node.id, force: args.force })),
  });
  if (!applied.ok) fail(applied.error, { removed: applied.removed || [], runs: life });
  emit({
    ok: true,
    removed: applied.removed,
    runs: life,
  });
}

function cmdTaskCreate(args) {
  if (!args.spec) fail('task-create 要 --spec');
  const spec = encodeSendText(String(args.spec), args.agent);
  const gate = assertInjectText(spec, { label: 'task-create' });
  if (!gate.ok) fail(gate.error);
  const r = orca(argsTaskCreate({ spec }));
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
  if (!args.terminal) fail('worker-start 要 --terminal（不用 --agent，参数在启动模板里）');
  // 消歧门（#565）：worker-start 带 --issue 同样受门控（项化路径续派/换人时带号）。
  // 在碰 orca 之前拦：被拦下时不会起任何终端/任务。
  const disambiguation = checkIssueDisambiguated({ issue: args.issue, runGh: ghRunner() });
  if (!disambiguation.ok) fail(disambiguation.error, { disambiguation });
  // #559 ②：worker_done 后同一终端续 Dispatch 走 worker-start --task <next> --terminal <handle>，
  // 不用 --worktree（工作区由终端决定，官方：Reuse an existing agent only with --terminal <handle>）。
  // #615 缺口：retry-of 复用同一终端、同一条 launch，接不上 nextLaunch。
  // 启动期（建终端 / TUI 探针 / 屏上拒模）已走管子序；中途硬失败不会切管。
  const r = orca(argsWorkerStart({
    task: args.task,
    worktree: args.worktree || undefined,
    terminal: args.terminal,
    retryOf: args.retryOf,
  }));
  if (!r.ok) fail(`worker-start 失败: ${errText(r.error)}`);
  const dispatchId = extractDispatchId(r.json);
  if (!dispatchId) fail('worker-start 成功但没拿到 dispatch id——不是已开工，是没查成（续 Dispatch 需要新身份）', { json: r.json });
  const read = orca(argsTerminalRead({ terminal: args.terminal, limit: 80 }));
  if (!read.ok) fail(`worker-start 成功但读屏失败——不是已开工，是没查成: ${errText(read.error)}`);
  const injected = verifyInjection({ text: extractTerminalText(read.json) });
  if (!injected.ok) fail(`注入后开工验证失败: ${injected.reason}`, { inject: injected });
  emit({ ok: true, json: r.json, dispatchId, inject: injected });
}

function cmdWorkerRelease(args) {
  if (!args.dispatch) fail('worker-release 要 --dispatch');
  const r = orca(argsWorkerRelease({ dispatch: args.dispatch, retryRequest: args.retryRequest }));
  if (!r.ok) fail(`worker-release 失败: ${errText(r.error)}`);
  emit({ ok: true, json: r.json, dispatchId: args.dispatch });
}

function cmdWorkerRead(args) {
  if (!args.dispatch) fail('worker-read 要 --dispatch');
  const r = orca(argsWorkerRead({
    dispatch: args.dispatch,
    source: args.source,
    cursor: args.cursor,
    limit: args.limit,
  }));
  if (!r.ok) fail(`worker-read 失败: ${errText(r.error)}`);
  const proof = verifyWorkerStarted(r.json);
  emit({ ok: true, json: r.json, dispatchId: args.dispatch, proof });
}

function cmdReviewerCreate(args) {
  if (!args.pr) fail('reviewer-create 要 --pr');

  const gh = ghRunner({ role: 'reviewer' });
  const meta = gh(['pr', 'view', String(args.pr), '--json', 'headRefName,headRefOid,mergeable']);
  if (!meta.ok) fail(`gh 读 PR #${args.pr} 失败（不是没有 PR，是没查成）: ${meta.error}`);
  let head;
  try { head = JSON.parse(meta.out); }
  catch { fail(`gh 读 PR #${args.pr} 返回不是 JSON: ${String(meta.out).slice(0, 120)}`); }
  const baseBranch = head?.headRefName;
  const expectedOid = head?.headRefOid;
  if (!baseBranch || !expectedOid) fail(`gh 读 PR #${args.pr} 缺 headRefName/headRefOid`);
  // #575 ⑦：建树前查 mergeable。UNKNOWN 不是绿。rebase 会改 sha 让 APPROVED 失效，只能先对齐再审。
  const mergeable = assessPrMergeable(head?.mergeable);
  if (!mergeable.ok) fail(mergeable.error, { mergeable, pr: String(args.pr) });

  const fileList = gh(['api', `repos/{owner}/{repo}/pulls/${args.pr}/files`, '--paginate']);
  if (!fileList.ok) fail(`gh 读 PR #${args.pr} 文件列表失败（不是没有文件，是没查成）: ${fileList.error}`);
  let fileJson;
  try { fileJson = JSON.parse(fileList.out); }
  catch { fail(`gh 读 PR #${args.pr} 文件列表不是 JSON: ${String(fileList.out).slice(0, 120)}`); }
  const files = parseGhPullFiles(fileJson);
  if (!files) fail(`gh 读 PR #${args.pr} 文件列表形态不对`);

  // #586：不传 --reviewer 时自读署名 issue 的 reviewer/*。工人不传模型。
  const picked = resolveReviewerFromPr({ pr: args.pr, reviewer: args.reviewer, runGh: gh });
  if (!picked.ok) fail(picked.error, { reviewer: picked, pr: String(args.pr) });

  const revName = assembleCardName({
    name: args.name || reviewerCardName(picked.modelId),
    pr: args.pr,
    role: '审官',
    model: picked.modelId,
  });
  const plan = {
    pr: String(args.pr),
    baseBranch,
    expectedOid,
    files,
    name: revName,
    mergeable,
    reviewer: picked.modelId,
    reviewerSource: picked.source,
  };
  if (args.dryRun) emit({ ok: true, dryRun: true, ...plan });

  const created = orca(argsWorktreeCreate({
    name: revName,
    setup: 'skip',
    parentWorktree: args.parentWorktree,
    baseBranch,
    issue: args.issue,
    comment: args.comment,
  }));
  if (!created.ok) fail(`审官卡创建失败: ${errText(created.error)}`, plan);
  const reviewerId = extractWorktreeId(created.json);
  const reviewerPath = extractWorktreePath(created.json);
  if (!reviewerId || !reviewerPath) fail('审官卡没返回 id/path', { ...plan, reviewerId, reviewerPath });

  const env = envProbeWorktree(reviewerPath);
  if (!env.ok) {
    orca(argsWorktreeRm({ worktree: reviewerId, force: true }));
    fail(`审官树环境自检失败: ${env.error}`, { ...plan, reviewerId, reviewerPath, probes: env });
  }
  const heads = verifyReviewerTree({ reviewerPath, expectedOid });
  if (!heads.ok) {
    orca(argsWorktreeRm({ worktree: reviewerId, force: true }));
    fail(heads.error, { ...plan, reviewerId, reviewerPath, heads });
  }
  const filesOk = verifyReviewerFiles({ reviewerPath, files });
  if (!filesOk.ok) {
    orca(argsWorktreeRm({ worktree: reviewerId, force: true }));
    fail(filesOk.error, { ...plan, reviewerId, reviewerPath, files: filesOk });
  }
  const align = trialMergeMaster({ cwd: reviewerPath });
  if (!align.ok) {
    orca(argsWorktreeRm({ worktree: reviewerId, force: true }));
    fail(`对齐 master 试合失败: ${align.error}`, { ...plan, reviewerId, reviewerPath, align });
  }

  // #586 阶段二：既有坑（mergeable / HEAD / 试合）不动，后面补起终端 + 注入。
  const routing = loadOrFail();
  let reviewerLaunch;
  try {
    reviewerLaunch = resolveLaunch({ model: picked.modelId, routing, root: ROOT });
  } catch (e) {
    orca(argsWorktreeRm({ worktree: reviewerId, force: true }));
    fail(String(e.message || e), { ...plan, reviewerId, reviewerPath });
  }
  const cap = assertCodexLaunch({ command: reviewerLaunch.command });
  if (!cap.ok) {
    orca(argsWorktreeRm({ worktree: reviewerId, force: true }));
    fail(cap.error, { ...plan, reviewerId, reviewerPath });
  }

  const launched = { reviewerId, reviewerHandle: null };
  const revTerm = orca(argsTerminalCreate({
    worktree: reviewerId,
    title: revName,
    command: reviewerLaunch.command,
  }));
  if (!revTerm.ok) {
    orca(argsWorktreeRm({ worktree: reviewerId, force: true }));
    fail(`审官终端创建失败: ${errText(revTerm.error)}`, { ...plan, reviewerId, reviewerPath });
  }
  launched.reviewerHandle = extractHandleFromCreate(revTerm.json);
  if (!launched.reviewerHandle) {
    orca(argsWorktreeRm({ worktree: reviewerId, force: true }));
    fail('审官终端没返回 handle', { ...plan, reviewerId, reviewerPath });
  }

  const revVerify = waitAndVerify({
    readOnce: () => readOnceHandle(launched.reviewerHandle),
    timeoutMs: probeWaitMs(routing, reviewerLaunch.provider),
  });
  if (!revVerify.ok) {
    failCreated(launched, '审官 TUI 未就绪', { verify: revVerify, ...plan });
  }

  let soldierDispatchId = args.soldierDispatch || null;
  let soldierRunId = null;
  if (args.parentWorktree) {
    const wl = orca(argsWorkerList());
    if (!wl.ok && !soldierDispatchId) failCreated(launched, `worker-list 没查成，给 --soldier-dispatch：${errText(wl.error)}`, plan);
    if (wl.ok) {
      const found = findDispatchForWorktree(wl.json, args.parentWorktree);
      if (!found.ok && !soldierDispatchId) failCreated(launched, `找不到士兵 dispatch（${found.error}）。给 --soldier-dispatch`, { found, ...plan });
      if (found.ok) {
        if (!soldierDispatchId) soldierDispatchId = found.dispatchId;
        soldierRunId = found.runId || null;
      }
    }
  }
  if (!soldierDispatchId) {
    failCreated(launched, 'reviewer-create 没拿到士兵 dispatch id（给 --soldier-dispatch 或 --parent-worktree）', plan);
  }
  if (!soldierRunId) soldierRunId = runIdFromDispatch(soldierDispatchId);

  const policy = args.mergePolicy || 'auto';
  if (policy !== 'auto' && policy !== 'manual') failCreated(launched, `--merge-policy 只允许 auto|manual，实际 ${policy}`, plan);
  if (policy === 'manual' && !String(args.mergeReason || '').trim()) {
    failCreated(launched, '--merge-policy manual 必须给 --merge-reason', plan);
  }

  let reviewerBook = null;
  try {
    reviewerBook = encodeSendText(buildReviewerInject({
      spec: `按审官任务书审 PR #${args.pr}`,
      issue: args.issue,
      pr: String(args.pr),
      soldierDispatchId: String(soldierDispatchId),
      mergePolicy: policy,
      mergeReason: args.mergeReason,
    }), reviewerLaunch.provider);
  } catch (e) {
    failCreated(launched, `审官任务书渲染失败: ${String(e.message || e)}`, plan);
  }

  const revTask = taskCreateOnRun(reviewerBook, soldierRunId);
  if (!revTask.ok) {
    if (isRunRequired(revTask.error)) failCreated(launched, RUN_REQUIRED_HINT, plan);
    failCreated(launched, `审官 task-create 失败: ${errText(revTask.error)}`, plan);
  }
  const reviewerTaskId = extractTaskId(revTask.json);
  if (!reviewerTaskId) failCreated(launched, '审官 task-create 没拿到 taskId', plan);

  const revStarted = orca(argsWorkerStart({
    task: reviewerTaskId,
    worktree: reviewerId,
    terminal: launched.reviewerHandle,
  }));
  if (!revStarted.ok) failCreated(launched, `审官 worker-start 失败: ${errText(revStarted.error)}`, { ...plan, reviewerTaskId });
  const reviewerDispatchId = extractDispatchId(revStarted.json);
  if (!reviewerDispatchId) {
    failCreated(launched, '审官 worker-start 没拿到 dispatch id（没查成，不是已开工）', { ...plan, reviewerTaskId });
  }

  const reviewerInject = verifyStartedPolling({
    dispatchId: reviewerDispatchId,
    readOnce: () => readOnceHandle(launched.reviewerHandle),
    proofOnce: workerStartProof,
    timeoutMs: probeWaitMs(routing, reviewerLaunch.provider),
    label: '审官',
  });
  if (!reviewerInject.ok) {
    failCreated(launched, `审官注入后开工验证失败: ${reviewerInject.reason}`, {
      ...plan, reviewerTaskId, reviewerInject,
    });
  }
  const reviewerProof = workerStartProof(reviewerDispatchId);

  const identity = deliverMessage({
    to: `dispatch:${soldierDispatchId}`,
    subject: `审官身份：${reviewerDispatchId}`,
    body: `你的审官 dispatch id = ${reviewerDispatchId}（士兵→审官 完工通知 --to dispatch:<这个 id>）。
先收这封信记下它，再发完工通知；收不到就 escalation，不许手抄/猜。`,
    hop: 'reviewer-create→士兵（审官身份）',
    orca: (a) => orca(a),
  });
  if (!identity.ok) {
    failCreated(launched, `审官身份消息没送到士兵收件箱: ${identity.error}`, {
      ...plan, reviewerTaskId, identity,
    });
  }

  let ledger = null;
  try {
    const ctx = loadLedgerContext({ root: ROOT });
    ledger = writeJobDispatch({
      ...ctx,
      ts: beijingIsoFrom(new Date()),
      jobId: reviewerJobId(args.pr),
      model: picked.modelId,
      identity: '审官',
      workType: '审查',
      terminal: reviewerLaunch.provider || 'dao',
      prNumber: Number(args.pr),
      extra: { source: 'reviewer-create', worktreeId: reviewerId },
    });
    if (!ledger.ok && !ledger.skipped) {
      console.error(`[dao] reviewer-create 账本没写上（建卡本身成功）：${ledger.error}`);
    }
  } catch (e) {
    ledger = { ok: false, error: String(e.message || e) };
    console.error(`[dao] reviewer-create 账本没写上（建卡本身成功）：${ledger.error}`);
  }

  emit({
    ok: true,
    ...plan,
    reviewerId,
    reviewerPath,
    reviewerHandle: launched.reviewerHandle,
    reviewerDispatchId,
    reviewerTaskId,
    soldierDispatchId,
    heads,
    filesChecked: filesOk.checked,
    probes: env,
    align,
    inject: reviewerInject,
    startProof: reviewerProof,
    identity,
    ledger,
  });
}

/**
 * #575 ④：给已有、无审官的工人卡补派审官。一条命令走完 dispatch 里那段审官建法：
 * 建树 → 环境探针 → HEAD==PR head → 起终端 → 验 TUI → task+worker-start →
 * verifyStartedPolling（开工证明）。换行按 agent 转码，不禁换行；硬闸只有 UTF-8 字节 ≤500。
 * 不碰 raw，所以不会绕过开工验证。
 */
function cmdReviewerAttach(args) {
  if (!args.pr) fail('reviewer-attach 要 --pr');
  if (!args.worktree) fail('reviewer-attach 要 --worktree（工人卡）');
  if (!args.reviewer) fail('reviewer-attach 要 --reviewer（审官模型 id）');

  const policy = args.mergePolicy || 'auto';
  if (policy !== 'auto' && policy !== 'manual') fail(`--merge-policy 只允许 auto|manual，实际 ${policy}`);
  if (policy === 'manual' && !String(args.mergeReason || '').trim()) {
    fail('--merge-policy manual 必须给 --merge-reason');
  }

  const routing = loadOrFail();
  let reviewerLaunch;
  try {
    reviewerLaunch = resolveLaunch({ model: args.reviewer, routing, root: ROOT });
  } catch (e) { fail(String(e.message || e)); }
  const cap = assertCodexLaunch({ command: reviewerLaunch.command });
  if (!cap.ok) fail(cap.error);

  const meta = runGh(['pr', 'view', String(args.pr), '--json', 'headRefName,headRefOid,mergeable'], { role: 'reviewer' });
  if (!meta.ok) fail(`gh 读 PR #${args.pr} 失败（不是没有 PR，是没查成）: ${meta.error}`);
  let head;
  try { head = JSON.parse(meta.out); }
  catch { fail(`gh 读 PR #${args.pr} 返回不是 JSON: ${String(meta.out).slice(0, 120)}`); }
  const baseBranch = head?.headRefName;
  const expectedOid = head?.headRefOid;
  if (!baseBranch || !expectedOid) fail(`gh 读 PR #${args.pr} 缺 headRefName/headRefOid`);
  const mergeable = assessPrMergeable(head?.mergeable);
  if (!mergeable.ok) fail(mergeable.error, { mergeable, pr: String(args.pr) });

  const fileList = runGh(['api', `repos/{owner}/{repo}/pulls/${args.pr}/files`, '--paginate'], { role: 'reviewer' });
  if (!fileList.ok) fail(`gh 读 PR #${args.pr} 文件列表失败（不是没有文件，是没查成）: ${fileList.error}`);
  let fileJson;
  try { fileJson = JSON.parse(fileList.out); }
  catch { fail(`gh 读 PR #${args.pr} 文件列表不是 JSON: ${String(fileList.out).slice(0, 120)}`); }
  const files = parseGhPullFiles(fileJson);
  if (!files) fail(`gh 读 PR #${args.pr} 文件列表形态不对`);

  const revName = assembleCardName({
    name: args.name || reviewerCardName(args.reviewer),
    pr: args.pr,
    role: '审官',
    model: args.reviewer,
  });
  const plan = {
    pr: String(args.pr),
    worktree: args.worktree,
    reviewer: args.reviewer,
    name: revName,
    baseBranch,
    expectedOid,
    files,
    mergePolicy: policy,
    mergeReason: args.mergeReason || null,
    launch: reviewerLaunch.command,
    mergeable,
  };
  if (args.dryRun) emit({ ok: true, dryRun: true, ...plan });

  const created = {};
  const revWt = orca(argsWorktreeCreate({
    name: revName,
    setup: 'skip',
    parentWorktree: args.worktree,
    baseBranch,
    issue: args.issue,
    comment: args.comment,
  }));
  if (!revWt.ok) fail(`审官卡创建失败: ${errText(revWt.error)}`, plan);
  created.reviewerId = extractWorktreeId(revWt.json);
  created.reviewerPath = extractWorktreePath(revWt.json);
  if (!created.reviewerId || !created.reviewerPath) {
    failCreated(created, '审官卡没返回 id/path', plan);
  }

  const env = envProbeWorktree(created.reviewerPath);
  if (!env.ok) failCreated(created, `审官树环境自检失败: ${env.error}`, { probes: env, ...plan });

  const heads = verifyReviewerTree({ reviewerPath: created.reviewerPath, expectedOid });
  if (!heads.ok) failCreated(created, heads.error, { heads, ...plan });

  const filesOk = verifyReviewerFiles({ reviewerPath: created.reviewerPath, files });
  if (!filesOk.ok) failCreated(created, filesOk.error, { files: filesOk, ...plan });

  const align = trialMergeMaster({ cwd: created.reviewerPath });
  if (!align.ok) failCreated(created, `对齐 master 试合失败: ${align.error}`, { align, ...plan });

  const revTerm = orca(argsTerminalCreate({
    worktree: created.reviewerId,
    title: revName,
    command: reviewerLaunch.command,
  }));
  if (!revTerm.ok) failCreated(created, `审官终端创建失败: ${errText(revTerm.error)}`, plan);
  created.reviewerHandle = extractHandleFromCreate(revTerm.json);
  if (!created.reviewerHandle) failCreated(created, '审官终端没返回 handle', plan);

  const revVerify = waitAndVerify({
    readOnce: () => readOnceHandle(created.reviewerHandle),
    timeoutMs: probeWaitMs(routing, reviewerLaunch.provider),
  });
  if (!revVerify.ok) failCreated(created, '审官 TUI 未就绪', { verify: revVerify, ...plan });

  let soldierDispatchId = args.soldierDispatch || null;
  let soldierRunId = null;
  if (!soldierDispatchId && !args.spec) {
    const wl = orca(argsWorkerList());
    if (!wl.ok) failCreated(created, `worker-list 没查成，给 --soldier-dispatch：${errText(wl.error)}`, plan);
    const found = findDispatchForWorktree(wl.json, args.worktree);
    if (!found.ok) failCreated(created, `找不到士兵 dispatch（${found.error}）。给 --soldier-dispatch，或确认工人卡走过 worker-start`, { found, ...plan });
    soldierDispatchId = found.dispatchId;
    soldierRunId = found.runId || null;
  }
  if (!soldierRunId && soldierDispatchId) soldierRunId = runIdFromDispatch(soldierDispatchId);

  let reviewerBook = null;
  try {
    reviewerBook = encodeSendText(args.spec
      ? (() => {
        const gate = assertInjectText(String(args.spec), { label: '审官注入' });
        if (!gate.ok) throw new Error(gate.error);
        return String(args.spec);
      })()
      : buildReviewerInject({
        spec: `按审官任务书审 PR #${args.pr}`,
        issue: args.issue,
        pr: String(args.pr),
        soldierDispatchId: String(soldierDispatchId),
        mergePolicy: policy,
        mergeReason: args.mergeReason,
      }), reviewerLaunch.provider);
  } catch (e) {
    failCreated(created, `审官任务书渲染失败: ${String(e.message || e)}`, plan);
  }

  const revTask = taskCreateOnRun(reviewerBook, soldierRunId);
  if (!revTask.ok) {
    if (isRunRequired(revTask.error)) failCreated(created, RUN_REQUIRED_HINT, plan);
    failCreated(created, `审官 task-create 失败: ${errText(revTask.error)}`, plan);
  }
  const reviewerTaskId = extractTaskId(revTask.json);
  if (!reviewerTaskId) failCreated(created, '审官 task-create 没拿到 taskId', plan);

  const revStarted = orca(argsWorkerStart({
    task: reviewerTaskId,
    worktree: created.reviewerId,
    terminal: created.reviewerHandle,
  }));
  if (!revStarted.ok) failCreated(created, `审官 worker-start 失败: ${errText(revStarted.error)}`, { ...plan, reviewerTaskId });
  created.reviewerDispatchId = extractDispatchId(revStarted.json);
  if (!created.reviewerDispatchId) {
    failCreated(created, '审官 worker-start 没拿到 dispatch id（没查成，不是已开工）', { ...plan, reviewerTaskId });
  }

  const reviewerInject = verifyStartedPolling({
    dispatchId: created.reviewerDispatchId,
    readOnce: () => readOnceHandle(created.reviewerHandle),
    proofOnce: workerStartProof,
    timeoutMs: probeWaitMs(routing, reviewerLaunch.provider),
    label: '审官',
  });
  if (!reviewerInject.ok) {
    failCreated(created, `审官注入后开工验证失败: ${reviewerInject.reason}`, {
      ...plan, reviewerTaskId, reviewerInject,
    });
  }
  const reviewerProof = workerStartProof(created.reviewerDispatchId);

  let identity = null;
  if (soldierDispatchId && created.reviewerDispatchId) {
    identity = deliverMessage({
      to: `dispatch:${soldierDispatchId}`,
      subject: `审官身份：${created.reviewerDispatchId}`,
      body: `你的审官 dispatch id = ${created.reviewerDispatchId}（士兵→审官 完工通知 --to dispatch:<这个 id>）。
先收这封信记下它，再发完工通知；收不到就 escalation，不许手抄/猜。`,
      hop: '补派审官→士兵（审官身份）',
      orca: (a) => orca(a),
    });
    if (!identity.ok) {
      failCreated(created, `审官身份消息没送到士兵收件箱: ${identity.error}`, {
        ...plan, reviewerTaskId, identity,
      });
    }
  }

  emit({
    ok: true,
    ...plan,
    ...created,
    reviewerTaskId,
    soldierDispatchId,
    heads,
    filesChecked: filesOk.checked,
    probes: env,
    inject: reviewerInject,
    startProof: reviewerProof,
    identity,
    align,
  });
}

function cmdSend(args) {
  if (!args.terminal) fail('send 要 --terminal');
  if (args.text == null) fail('send 要 --text');
  const r = orca(argsTerminalSend({
    terminal: args.terminal,
    text: args.text,
    enter: args.enter,
    agent: args.agent,
  }));
  if (!r.ok) fail(`terminal send 失败: ${errText(r.error)}`);
  emit({ ok: true, json: r.json });
}

/**
 * 闭环发信口（#548 红项 1）。裸 orca orchestration send 对不存在的 handle 也 exit 0 + ok:true，
 * 从帅的视角「链断了」和「链走完了」都表现为没有消息——这里把断链变成当场非零 + 升级。
 *
 * 管的是投递，不管结算：ok:true = 消息进了对方信箱，不等于对面读了、也不等于任务变 completed。
 * 结算（worker_done 那类）另有 Dispatch 身份要求，本口不提供，见 issue #551。
 */
function cmdNotify(args) {
  const r = deliverMessage({
    to: args.to || null,
    subject: args.subject,
    body: args.body ?? '',
    type: args.type,
    outcome: args.outcome,
    hop: args.hop || '闭环通知',
    orca: (a) => orca(a),
  });
  if (!r.ok) {
    console.error(`[dao notify] 链断，没送到（${r.stage}）：${r.error}`);
    console.error('[dao notify] 别往下走：确认送达前不许进入下一步，修不好就升级给帅。');
    emit(r, 1);
  }
  emit(r);
}

function cmdReply(args) {
  if (!args.id) fail('reply 要 --id（被回答的消息 id）');
  if (args.body == null) fail('reply 要 --body');
  let sender;
  if (args.from && args.run) {
    sender = { ok: true, from: args.from, runId: args.run };
  } else {
    const inbox = orca(argsOrchestrationInbox({ limit: 80, full: true }));
    const rl = orca(argsRunList());
    sender = resolveReplySender({
      messageId: args.id,
      explicitFrom: args.from || null,
      explicitRun: args.run || null,
      inboxOk: inbox.ok,
      inboxMessages: inbox.ok ? (inbox.json?.result?.messages || []) : null,
      runListOk: rl.ok,
      runs: rl.ok ? unwrapRuns(rl.json) : null,
    });
  }
  if (!sender.ok) fail(`reply 定位失败: ${sender.error}`);
  if (!sender.from) fail('reply 没有信箱台 --from，不许裸发');
  const r = orca(argsOrchestrationReply({
    id: args.id, body: args.body, from: sender.from, run: sender.runId,
  }));
  if (!r.ok) fail(`reply 失败: ${errText(r.error)}`);
  emit({ ok: true, json: r.json, messageId: args.id, from: sender.from, run: sender.runId || null });
}

function cmdInboxCollect(args) {
  const src = loadLifecycleInputs();
  if (!src.ok) fail(src.error);
  const plan = planInboxCollect(src);
  if (!plan.ok) fail(plan.error);
  const inbox = orca(argsOrchestrationInbox({ limit: 100, full: true }));
  const inboxMessages = inbox.ok ? (inbox.json?.result?.messages || []) : null;
  const items = [];
  for (const it of plan.items) {
    if (it.state === 'run_not_found') {
      items.push(classifyMailboxRead({
        ok: false, error: { code: 'run_not_found', message: `Run ${it.runId} was not found.` }, runId: it.runId,
      }));
      continue;
    }
    let checked = { ok: false, error: 'no-coordinator' };
    if (it.coordinatorHandle) {
      checked = orca(argsOrchestrationCheck({
        run: it.runId,
        terminal: it.coordinatorHandle,
        peek: args.peek !== false,
      }));
    }
    const parsed = checked.ok ? (checked.json?.result || {}) : {};
    items.push(classifyMailboxRead({
      ok: checked.ok,
      error: checked.ok ? null : checked.error,
      messages: parsed.messages,
      inboxMessages,
      runId: it.runId,
    }));
  }
  emit({
    ok: true,
    items,
    inboxUnscanned: !inbox.ok,
    inboxError: inbox.ok ? undefined : errText(inbox.error),
  });
}

function cmdRunGc(args) {
  const src = loadLifecycleInputs();
  if (!src.ok) fail(src.error);
  const plan = planRunGc(src);
  if (!plan.ok) fail(plan.error);
  const parts = partitionGcTargets(plan.retire, {
    leaseExistsFor: (runId) => stationFilesFor(runId).some((f) => existsSync(f)),
  });
  if (!parts.ok) fail(parts.error);
  const summary = {
    pending: parts.pending.map(r => r.id),
    tombstones: parts.tombstones.map(r => r.id),
    keep: plan.keep.map(r => r.id),
    skippedLegacy: plan.skippedLegacy.map(r => r.id),
    pendingCount: parts.pending.length,
    tombstoneCount: parts.tombstones.length,
    keepCount: plan.keep.length,
    note: 'orca 没有 run-delete；tombstones = 已退但墓碑仍在 run-list。真关只认 terminal close 掉活台，不认删租约。',
  };
  if (!args.apply) {
    emit({ ok: true, dryRun: true, ...summary });
  }
  const results = parts.pending.map((r) => retireOneRun(r.id));
  const tallied = summarizeGcApply({ pendingResults: results, tombstones: parts.tombstones });
  emit({
    ok: tallied.failedCount === 0,
    closedCount: tallied.closedCount,
    alreadyGoneCount: tallied.alreadyGoneCount,
    failedCount: tallied.failedCount,
    tombstoneAlreadyGoneCount: tallied.tombstoneAlreadyGoneCount,
    closed: tallied.closed,
    alreadyGone: tallied.alreadyGone,
    failed: tallied.failed,
    ...summary,
  }, tallied.failedCount ? 1 : 0);
}

function cmdAsk(args) {
  if (!args.question) fail('ask 要 --question');
  const parsedTimeout = parseAskTimeoutMs(args.timeoutMs);
  if (!parsedTimeout.ok) fail(parsedTimeout.error);
  const timeoutMs = parsedTimeout.timeoutMs;
  let runId = args.run || null;
  if (!runId) {
    const cur = orca(argsRunCurrent());
    if (!cur.ok) fail(`run-current 没查成: ${errText(cur.error)}`);
    runId = cur.json?.result?.run?.id || null;
  }
  if (!runId) {
    fail('找不到上报 Run：给 --run <id>。工人从 worker-show 的 dispatch.run_id 取。不要用 run-current（工人终端经常是 null）');
  }
  const sent = orca(argsOrchestrationSend({
    to: `run:${runId}`,
    subject: String(args.question).slice(0, 80),
    body: args.options ? `${args.question}\n选项：${args.options}` : args.question,
    type: 'question',
  }));
  if (!sent.ok) fail(`ask 发出去失败: ${errText(sent.error)}`);
  const msg = extractSentMessage(sent.json);
  if (!msg) fail('ask 发出去了却没回执');
  const t0 = Date.now();
  for (;;) {
    const elapsed = Date.now() - t0;
    const inbox = orca(argsOrchestrationInbox({ limit: 80, full: true }));
    const poll = classifyAskPoll({
      reply: inbox.ok ? findThreadReply(inbox.json?.result?.messages, msg.id) : null,
      elapsedMs: elapsed,
      timeoutMs,
      unscanned: !inbox.ok,
      error: inbox.ok ? null : errText(inbox.error),
    });
    if (poll.state === 'answered') {
      emit({ ok: true, answer: poll.body, questionId: msg.id, replyId: poll.messageId, runId });
    }
    if (poll.state === 'unscanned') fail(`ask 收信没查成: ${poll.error}`);
    if (poll.state === 'timeout') {
      console.error(ASK_TIMEOUT_MARK);
      emit({ ok: false, error: ASK_TIMEOUT_MARK, mark: ASK_TIMEOUT_MARK, questionId: msg.id, runId }, 1);
    }
    sleepMs(1000);
  }
}

function cmdGateCreate(args) {
  if (!args.task) fail('gate-create 要 --task');
  if (!args.question) fail('gate-create 要 --question');
  const r = orca(argsGateCreate({ task: args.task, question: args.question, options: args.options, from: args.from }));
  if (!r.ok) fail(`gate-create 失败: ${errText(r.error)}`);
  emit({ ok: true, json: r.json });
}

function cmdGateResolve(args) {
  if (!args.id) fail('gate-resolve 要 --id');
  if (!args.resolution) fail('gate-resolve 要 --resolution');
  const r = orca(argsGateResolve({ id: args.id, resolution: args.resolution, from: args.from }));
  if (!r.ok) fail(`gate-resolve 失败: ${errText(r.error)}`);
  emit({ ok: true, json: r.json });
}

function cmdGateList(args) {
  const r = orca(argsGateList({ task: args.task, status: args.status, run: args.run }));
  if (!r.ok) fail(`gate-list 失败: ${errText(r.error)}`);
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
  // #575 ②：记账只走 stderr，且压成一行——多行 spec 不能把 JSON 拆碎。
  const oneLine = argv.map(a => String(a).replace(/\s+/g, ' ')).join(' ');
  console.error(`[dao raw] 已记账 ${logPath}: ${oneLine}`);
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
    case 'worker-release': return cmdWorkerRelease(args);
    case 'worker-read': return cmdWorkerRead(args);
    case 'reviewer-create': return cmdReviewerCreate(args);
    case 'worker-done': return cmdWorkerDone(args);
    case 'reviewer-attach': return cmdReviewerAttach(args);
    case 'send': return cmdSend(args);
    case 'notify': return cmdNotify(args);
    case 'reply': return cmdReply(args);
    case 'inbox-collect': return cmdInboxCollect(args);
    case 'run-gc': return cmdRunGc(args);
    case 'ask': return cmdAsk(args);
    case 'gate-create': return cmdGateCreate(args);
    case 'gate-resolve': return cmdGateResolve(args);
    case 'gate-list': return cmdGateList(args);
    case 'liveness': return cmdLiveness(args);
    case 'check-help': return cmdCheckHelp();
    case 'pr-sync-labels': return cmdPrSyncLabels(args);
    case 'ledger-query': return cmdLedgerQuery(args);
    case 'amend': return cmdAmend(args);
    case 'raw': return cmdRaw(args);
    default:
      console.error(`未知动词: ${args.verb}`);
      process.exit(1);
  }
}

main();
