#!/usr/bin/env node
// scripts/dao.mjs —— 统一命令库 CLI（issue #482）
//
// 删「帅拼命令字符串」这一层。启动 / 编排走这里；查询类不在本单。
// CLI 还是约束载体：派工缺 --split / --model|--role / --reviewer 就跑不起来。
// 启动模板只从 docs/model-routing.toml 读，这里零硬编码。
// 逃生口 raw 必须留痕，否则库会因绕过而死亡。

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { parseYaml } from './lib/yaml-min.mjs';
import { select } from './lib/dianjiangtai-core.mjs';
import { nextInjection } from './lib/board-hook.mjs';
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
  argsRunUse,
  argsRunList,
  argsRunCreateSelf,
  planCallerRun,
  extractRunId,
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
  extractHandleFromWorkerStart,
  extractDispatchId,
  extractTaskId,
  extractTerminalText,
  findReusableDefaultTerminal,
  isReusableDefaultTerminal,
  planLaunchFallback,
  agentStartSpec,
  inspectConsumerFence,
  planFenceHeal,
  extractWorktreeId,
  extractWorktreePath,
  findDispatchForWorktree,
  verifyReviewerAttachTree,
  planAttachSoldierDispatch,
  isLiveDispatchRecipient,
  argsWorkerList,
  gitBranchName,
  isRunRequired,
  RUN_REQUIRED_HINT,

  fetchHelpPreferLive,
  loadRouting,
  parseArgs,
  parseGhPullFiles,
  loadDispatchBatchFile,
  planDispatchBatch,
  runDispatchBatch,
  applyDispatchRollback,
  probeWaitMs,
  recordEscape,
  resolveDispatchConstraints,
  resolveSplitConstraint,
  resolveSliceAssignments,
  planSplitCards,
  buildSplitRoleSpec,
  startSplitChildren,
  resolveLaunch,
  reviewerCardName,

  renderDispatchTemplate,
  buildSoldierInject,
  buildReviewerInject,
  assertInjectText,
  encodeSendText,
  runGh,
  stampIssueLabels,
  syncPrLabelsFromIssue,
  resolveReviewerFromPr,
  resolveWorkerFromPr,
  planWorkerDone,
  completeWorkerDoneNotify,
  pickWorkerDoneDispatchId,
  resolveReviewerReuse,
  postIssueComment,
  postPrComment,
  classifyReviewerSpawnError,
  reviewerSpawnFailComment,
  verifyStartedPolling,
  verifyWorkerStarted,
  verifyReviewerFiles,
  verifyReviewerTree,
  assessPrMergeable,
  trialMergeMaster,
  waitAndVerify,
} from './lib/dao-cmd.mjs';
import { afterDispatchComment, repoPrefixOf, syncMasterTicketZone, worktreesFromPs } from './lib/master-title.mjs';
import { applyGitIdentity } from './lib/gh.mjs';
import { runOrca as sharedRunOrca } from './lib/orca-run.mjs';
import {
  loadLedgerContext, beijingIsoFrom, dispatchJobId, reviewerJobId, writeJobDispatch,
  writeJobOverride, resolveAmendTarget, formatAmendComment, workerJobId,
  linkAliasesToSuccessor, resolveMainWorktreeRoot,
} from './lib/ledger-job.mjs';
import { ensureLocalLedger } from './lib/ledger-home.mjs';
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
  partitionCoordinatorRuns,
  summarizeGcApply,
  resolveStationCloseTarget,
  previewHandlesForRun,
} from './lib/run-lifecycle.mjs';
import {
  defaultLogRel, leasePath, launchFilePath, parseLease,
  GC_THRESHOLD, gcSummaryFromPlan, gcThresholdLine,
} from './inbox-station.mjs';
import { assertCrossVendor, filterSlateSameVendor } from './lib/reviewer-vendor-gate.mjs';
import { nextReviewerAfter } from './lib/dianjiangtai-reviewer-slot.mjs';

const ORCA_TIMEOUT_MS = 30000;

function errText(e) {
  return orcaErrorText(e);
}

// spawn/归一化唯一真源在 scripts/lib/orca-run.mjs（#695 windowsHide、结构化错误透传都在那）。
function orca(cmdArgs, timeout = ORCA_TIMEOUT_MS) {
  return sharedRunOrca(cmdArgs, { timeout });
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

/** #684：事件点把在途单号全量重写进 master 卡定界区。失败显形，不翻转主动作。 */
function rewriteMasterZone(worktrees) {
  const loaded = Array.isArray(worktrees)
    ? { ok: true, worktrees }
    : worktreesFromPs(orca);
  if (!loaded.ok) {
    console.error(`[dao] 帅位定界区没查成：${loaded.error}`);
    return { ok: false, action: 'warn', unscanned: true, reason: loaded.error };
  }
  const main = resolveMainWorktreeRoot({ from: ROOT });
  // repoId 优先：master 卡与主树不同盘位时 pathHint 失配（#684 余量实测）。
  const cur = currentRepoId();
  return syncMasterTicketZone({
    worktrees: loaded.worktrees,
    repoId: cur.ok ? cur.repoId : undefined,
    pathHint: main.ok ? main.root : ROOT,
    runOrca: orca,
  });
}

function loadOrFail() {
  try { return loadRouting(); }
  catch (e) { fail(String(e.message || e)); }
}

function reviewerPasserIds(routing) {
  return (routing?.models || [])
    .filter(m => m && Array.isArray(m.roles) && m.roles.some(r => r === '审查' || r === '审读'))
    .filter(m => !m.reviewerDisabled)
    .map(m => m.id);
}

function reviewerOrderOf(routing) {
  return routing?.reviewerOrder || [];
}

function formatVendorGateError(gate, next) {
  if (!gate || gate.ok) return null;
  if (next && next.ok && next.next) return `${gate.error}；下一位 ${next.next}`;
  if (next && next.error) return `${gate.error}；${next.error}`;
  return gate.error;
}

function refuseIfSameVendor({ workerId, reviewerId, routing }) {
  const models = routing?.models || [];
  const gate = assertCrossVendor({ workerId, reviewerId, models });
  if (gate.ok) return gate;
  const next = nextReviewerAfter({
    currentId: reviewerId,
    models,
    passerIds: reviewerPasserIds(routing),
    workerId,
    order: reviewerOrderOf(routing),
  });
  fail(formatVendorGateError(gate, next), {
    vendorGate: { ...gate, next: next.ok ? next.next : null, exhausted: !!next.exhausted },
  });
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
  const result = applyDispatchRollback(created, { exec: orca });
  // #614 验收③：本次派工新建的 Run 一并回收（关台+删租约），堵僵尸来源 1。
  // 只退「本次新建」的：复用已有 Run（runCreated 非 true）时它还有别的在途单，不许动。
  if (created && created.runCreated === true && created.runId) {
    const r = retireOneRun(created.runId);
    const alreadyGone = r.ok || r.state === 'run_not_found';
    result.rollback.push({
      cmd: `retire run ${created.runId}`,
      ok: alreadyGone,
      runId: created.runId,
      error: alreadyGone ? undefined : r.error,
    });
    if (!alreadyGone) result.rollbackFailed = true;
  }
  if (result.alarm) console.error(`[dao] ${result.alarm}`);
  return result;
}

function snapshotHandleScreen(handle) {
  if (!handle) return { skipped: true, reason: 'no-handle' };
  const read = orca(argsTerminalRead({ terminal: handle, limit: 80 }));
  if (!read.ok) return { ok: false, handle, error: errText(read.error) };
  return { ok: true, handle, text: extractTerminalText(read.json) };
}

function failCreated(created, error, extra = {}) {
  const screen = extra.screen || snapshotHandleScreen(created.reviewerHandle || created.workerHandle);
  const { rollback, rollbackFailed } = rollbackCreated(created);
  emit({ ok: false, error, screen, rollback, rollbackFailed, ...created, ...extra }, 1);
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

/** #633：建卡默认空壳只拿来关。认识的 agent 走 worker-start --agent；特殊 argv / reclaude 走 --command。禁止 send 进 pwsh。 */
function findDefaultTerminalForLaunch(worktreeId) {
  for (let i = 0; i < 10; i++) {
    const listed = orca(argsTerminalList({ worktree: worktreeId }));
    if (listed.ok) {
      const found = findReusableDefaultTerminal(listed.json, { worktreeId });
      if (found.ok && found.handle) return found;
    }
    sleepMs(250);
  }
  return { handle: null };
}

function findAgentTerminalHandle(worktreeId) {
  const listed = orca(argsTerminalList({ worktree: worktreeId }));
  if (!listed.ok) return null;
  const terms = listed.json?.result?.terminals;
  if (!Array.isArray(terms)) return null;
  const agents = terms.filter(t => t && t.handle && !isReusableDefaultTerminal(t));
  return agents[0]?.handle || null;
}

function launchAgentInWorktree({ worktreeId, title, command, launch, forceCommand }) {
  const spec = agentStartSpec(launch || { command });
  const found = findDefaultTerminalForLaunch(worktreeId);
  const plan = planLaunchFallback({ foundHandle: found.handle || null });
  if (plan.closeHandle) closeWorkerHandle(plan.closeHandle);
  if (spec.mode === 'agent' && !forceCommand) {
    return {
      ok: true,
      handle: null,
      reused: false,
      deferred: true,
      mode: 'agent',
      agentId: spec.agentId,
      model: spec.model,
    };
  }
  const created = orca(argsTerminalCreate({
    worktree: worktreeId,
    title,
    command,
  }));
  if (!created.ok) {
    return { ok: false, error: `terminal create 失败: ${errText(created.error)}`, reused: false };
  }
  const handle = extractHandleFromCreate(created.json);
  if (!handle) return { ok: false, error: 'terminal create 没返回 handle', reused: false };
  return { ok: true, handle, reused: false, mode: 'command' };
}

/** worker-start 失败时把 result.lastError/failedStage 带进错误话面（实测 exit 1 + ok:true + lastError 藏在 JSON 里）。 */
function workerStartFailText(r) {
  const base = errText(r?.error);
  const last = r?.json?.result?.lastError || r?.json?.lastError || null;
  const stage = r?.json?.result?.failedStage || null;
  if (!last && !stage) return base;
  const hint = [stage, last].filter(Boolean).join(' / ');
  return base.includes(hint) ? base : `${base}（${hint}）`;
}

function startOrcaWorker({ task, worktree, launched, run, timeoutMs }) {
  if (launched?.deferred) {
    const r = orca(argsWorkerStart({
      task,
      worktree,
      agent: launched.agentId,
      model: launched.model || undefined,
      run,
      timeoutMs,
    }), 180000);
    if (!r.ok) return { ok: false, error: workerStartFailText(r), json: r.json };
    const handle = extractHandleFromWorkerStart(r.json) || findAgentTerminalHandle(worktree);
    if (!handle) {
      return { ok: false, error: 'worker-start --agent 成功但没拿到终端 handle（没查成）', json: r.json };
    }
    return { ok: true, json: r.json, handle, dispatchId: extractDispatchId(r.json) };
  }
  if (!launched?.handle) return { ok: false, error: 'worker-start 要 --terminal 或 --agent' };
  const r = orca(argsWorkerStart({ task, worktree, terminal: launched.handle, run, timeoutMs }));
  if (!r.ok) return { ok: false, error: workerStartFailText(r), json: r.json, handle: launched.handle };
  return { ok: true, json: r.json, handle: launched.handle, dispatchId: extractDispatchId(r.json) };
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

    const term = launchAgentInWorktree({
      worktreeId,
      title,
      command: launch.command,
      launch,
    });
    if (!term.ok) {
      const kind = classifyLaunchFailure({ error: term.error });
      attempts.push({ modelId, pipeIndex, provider: pipe.provider, kind, error: term.error });
      const next = advanceLaunchState({
        slate, modelId, pipeIndex, hardFailsOnThisPipe, transientFailsOnThisPipe, kind,
      });
      if (next.action === 'abort' || next.action === 'fail') {
        return { ok: false, error: `工人终端创建失败且名单走完: ${term.error}`, attempts, exhausted: true };
      }
      modelId = next.modelId;
      pipeIndex = next.pipeIndex;
      hardFailsOnThisPipe = next.hardFailsOnThisPipe;
      transientFailsOnThisPipe = next.transientFailsOnThisPipe;
      continue;
    }
    if (term.deferred) {
      return {
        ok: true, deferred: true, modelId, pipeIndex, pipe, launch,
        handle: null, agentId: term.agentId, model: term.model, attempts,
      };
    }
    const handle = term.handle;
    if (!handle) return { ok: false, error: '工人终端没返回 handle', attempts };
    created.workerHandle = handle;

    const verify = waitAndVerify({
      readOnce: () => readOnceHandle(handle),
      timeoutMs: probeWaitMs(routing, launch.provider),
    });
    if (verify.ok) {
      return { ok: true, modelId, pipeIndex, pipe, launch, handle, attempts, reused: !!term.reused };
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

/** #661/#679：开工只认外部证据——worker-read 真 session 或屏上 agent 真在干活。
 * 看见未提交粘贴继续等到 timeoutMs 或指纹消失且在干活；超时仍在框里才红并回滚。
 * 禁止补回车。散步到 worker-start / reviewer-attach / 复用审官。
 * #680：cursor 通道忽略 [Pasted text] 残留，改认 Working/输出在动。 */
function finishWorkerInject({ handle, dispatchId, label, timeoutMs, provider }) {
  return verifyStartedPolling({
    dispatchId,
    readOnce: () => readOnceHandle(handle),
    proofOnce: workerStartProof,
    timeoutMs,
    label,
    provider,
  });
}

/** 开工证明（#559 ⑥）：worker-read --source auto 官方 transcript 源优先。
 * 证明不了（source=terminal）不硬失败——verifyStartedPolling 降级到屏面稳定轮。
 * 没读成（unscanned）如实上报，不许当成「查过没事」。 */
function workerStartProof(dispatchId) {
  const r = orca(argsWorkerRead({ dispatch: dispatchId }));
  if (!r.ok) return { ok: false, unscanned: true, error: errText(r.error) };
  return verifyWorkerStarted(r.json);
}

/**
 * #667：帅窗派工不 run-use。
 * `--from <信箱台>` 不能冒充（orca 校验证书）。
 * 工人侧起审官：本终端已不绑 Run 时，允许 run-use 绑自己（不是帅窗、不是冒充台）。
 */
function taskCreateOnRun(spec, runId, { rebindSelf = false } = {}) {
  let last = orca(argsTaskCreate({ spec, run: runId || undefined }));
  if (last.ok) return last;
  const why = errText(last.error);
  if (!rebindSelf || !runId || !/consumer_fenced|run_required|no longer bound/i.test(why)) {
    return last;
  }
  orca(argsRunUse({ id: runId, self: true }));
  return orca(argsTaskCreate({ spec, run: runId }));
}

/** 保活信箱台（它轮询 inbox 落盘，不靠横幅）。
 * Run：调用方已有的用已有的；run-current 为 null 时本 TUI 自己开（#675 工人 TUI 例外：不 --from 冒充台）。
 * 只许工人 TUI 走这条；帅窗 run-current 为 null 时不许靠它把自己绑成 coordinator（#667）。
 * run-current 没查成 ≠ 没有 Run。
 * #614：自开的 Run 打身份标记（objective 前缀 coordinator:/dispatch:）。帅窗派工（cmdDispatch/
 * cmdDispatchBatch）传 runRole='coordinator'（派工协调 Run 永不自动退役）；其余（工人 TUI）默认
 * 'dispatch'。 */
function bindStation({ runRole = 'dispatch' } = {}) {
  const ensured = ensureInboxStation();
  if (!ensured.ok) return { ok: false, error: `信箱台 ensure 失败: ${ensured.error}` };
  const cur = orca(argsRunCurrent());
  const plan = planCallerRun({
    currentOk: cur.ok,
    currentJson: cur.json,
    currentError: cur.ok ? null : errText(cur.error),
  });
  if (!plan.ok) return { ok: false, unscanned: !!plan.unscanned, error: plan.error };
  if (!plan.needCreate) {
    return { ok: true, handle: ensured.handle || null, runId: plan.runId };
  }
  const created = orca(argsRunCreateSelf({ objective: `${runRole}: dao dispatch` }));
  if (!created.ok) return { ok: false, error: `本窗开 Run 失败：${errText(created.error)}` };
  const runId = extractRunId(created.json);
  if (!runId) return { ok: false, error: 'run-create 没拿到 result.run.id（没查成）' };
  return { ok: true, handle: ensured.handle || null, runId, created: true, runRole };
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
  const target = resolveStationCloseTarget({
    runId,
    lease,
    leaseRead: leaseInfo.read,
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
  // #614 验收⑤：run-list 分页扫全（nextCursor 循环）。分页失败 = 没扫全，不许当全量。
  const rl = listAllRuns();
  if (!rl.ok) return { ok: false, error: rl.error };
  return { ok: true, worktrees, workers, runs: rl.runs };
}

/** #614 验收⑤：run-list 分页扫全。游标不前进 / 超页数 = 没扫成（unscanned）。 */
function listAllRuns(limit = 100) {
  const all = [];
  const seen = new Set();
  let cursor = null;
  for (let page = 0; page < 20; page++) {
    const args = ['orchestration', 'run-list', '--limit', String(limit)];
    if (cursor) args.push('--cursor', cursor);
    args.push('--json');
    const r = orca(args);
    if (!r.ok) {
      return { ok: false, unscanned: true, error: `run-list 分页没查成: ${errText(r.error)}` };
    }
    const runs = unwrapRuns(r.json);
    if (!Array.isArray(runs)) {
      return { ok: false, unscanned: true, error: 'run-list 分页结构不认识（缺 runs 数组）' };
    }
    for (const run of runs) {
      if (run && run.id && !seen.has(run.id)) {
        seen.add(run.id);
        all.push(run);
      }
    }
    const next = r.json?.result?.nextCursor || null;
    if (!next) return { ok: true, runs: all, pages: page + 1 };
    if (next === cursor) {
      return { ok: false, unscanned: true, error: 'run-list 游标不前进，分页扫全失败（没扫成）' };
    }
    cursor = next;
  }
  return { ok: false, unscanned: true, error: 'run-list 分页超过 20 页，放弃（没扫成）' };
}

/** #614 验收④：只读 gc 扫描（不 --apply，不关台）。没查成 → unscanned，不许报 0。
 * zombieCount 只数活僵尸（有租约 pending）：墓碑清不掉（orca 无 run-delete），
 * 计入会让提示行永远响（狼来了）。 */
function runGcReadonlyScan(threshold = GC_THRESHOLD) {
  const src = loadLifecycleInputs();
  if (!src.ok) return { ok: false, unscanned: true, error: src.error, threshold };
  const plan = planRunGc({
    runs: src.runs,
    workers: src.workers,
    worktrees: src.worktrees,
  });
  if (!plan.ok) return { ok: false, unscanned: true, error: plan.error, threshold };
  const parts = partitionGcTargets(plan.retire, {
    leaseExistsFor: (runId) => stationFilesFor(runId).some((f) => existsSync(f)),
  });
  if (!parts.ok) return { ok: false, unscanned: true, error: parts.error, threshold };
  return {
    ok: true,
    unscanned: false,
    zombieCount: parts.pending.length,
    keepCount: plan.keep.length,
    tombstoneCount: parts.tombstones.length,
    threshold,
  };
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
  if (args.batch) return cmdDispatchBatch(args);
  const routing = loadOrFail();
  const gate = constrainDispatch(args, routing);
  if (!args.spec && !args.task) fail('dispatch 要 --spec（工人任务书），或已有 --task');
  if (!args.name && !args.dryRun) fail('dispatch 要 --name');

  const splitGate = resolveSplitConstraint({ split: args.split, splitReason: args.splitReason });
  if (!splitGate.ok) fail(splitGate.error, { missing: splitGate.missing || [] });
  const sliceGate = resolveSliceAssignments({ childCount: splitGate.childCount, slices: args.slice });
  if (!sliceGate.ok) fail(sliceGate.error, { missing: sliceGate.missing || [] });

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

  const filteredSlate = filterSlateSameVendor({
    slate: slatePack.slate,
    startIndex: slatePack.startIndex,
    reviewerId: gate.reviewer,
    models: routing.models,
  });
  if (!filteredSlate.ok) fail(filteredSlate.error, { vendorGate: filteredSlate });
  slatePack = {
    ...slatePack,
    slate: filteredSlate.slate,
    startIndex: filteredSlate.startIndex,
  };

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

  const cards = planSplitCards({
    name: args.name,
    issue: args.issue,
    role: '工人',
    model: gate.model,
    childCount: splitGate.childCount,
  });
  const headSpec = splitGate.childCount > 0
    ? buildSplitRoleSpec({ spec: args.spec, role: 'head', total: splitGate.childCount })
    : String(args.spec || '');
  const childCards = cards.children.map((c, i) => ({
    ...c,
    willStart: true,
    slice: sliceGate.slices[i],
    spec: buildSplitRoleSpec({
      spec: args.spec, role: 'child', index: i + 1, total: splitGate.childCount, slice: sliceGate.slices[i],
    }),
  }));

  const plan = {
    mergePolicy: gate.mergePolicy,
    mergeReason: gate.mergeReason,
    model: startEntry.id,
    reviewer: gate.reviewer,
    issue: args.issue ? String(args.issue).trim() : null,
    split: splitGate.split,
    splitReason: splitGate.splitReason,
    workerCard: cards.parent.name,
    parentCard: { ...cards.parent, role: splitGate.childCount > 0 ? '头工人' : '工人', spec: headSpec },
    childCards,
    workerLaunch: workerLaunch.command,
    reviewerDeferred: true,
    reviewerLaunchChecked: reviewerLaunch.command,
    comment: dispatchComment({
      ...gate,
      split: splitGate.split,
      splitReason: splitGate.splitReason,
    }),
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

  const created = { childIds: [], childHandles: [], children: [], dispatchIds: [], taskIds: [] };

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

  if (splitGate.childCount > 0) {
    const baseBranch = workerBranch.branch;
    for (const child of cards.children) {
      const childWt = orca(argsWorktreeCreate({
        name: child.name,
        setup: 'skip',
        parentWorktree: created.workerId,
        baseBranch,
        issue: args.issue,
        comment: plan.comment,
      }));
      if (!childWt.ok) failCreated(created, `子卡 ${child.name} 创建失败: ${errText(childWt.error)}`, plan);
      const childId = extractWorktreeId(childWt.json);
      if (!childId) failCreated(created, `子卡 ${child.name} 没返回 id`, plan);
      const childPath = extractWorktreePath(childWt.json);
      created.childIds.push(childId);
      created.children.push({ id: childId, path: childPath, name: child.name });
    }
  }

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

  // #679：闸在 dispatch。slate fallback 之后必须按实际 launched.modelId 再过同厂闸。
  const launchedGate = assertCrossVendor({
    workerId: launched.modelId,
    reviewerId: gate.reviewer,
    models: routing.models,
  });
  if (!launchedGate.ok) {
    const next = nextReviewerAfter({
      currentId: gate.reviewer,
      models: routing.models,
      passerIds: reviewerPasserIds(routing),
      workerId: launched.modelId,
      order: reviewerOrderOf(routing),
    });
    failCreated(created, formatVendorGateError(launchedGate, next), {
      vendorGate: { ...launchedGate, next: next.ok ? next.next : null, exhausted: !!next.exhausted },
      ...plan,
    });
  }

  // #602：注入只给一行指针 + spec + 参数。换行按 agent 转码（grok 转 ESC+CR），不禁换行；硬闸只有 UTF-8 字节 ≤500。
  let soldierBook = null;
  try {
    soldierBook = args.spec
      ? encodeSendText(buildSoldierInject({ spec: headSpec || String(args.spec), issue: args.issue }), workerLaunch.provider)
      : null;
  } catch (e) {
    failCreated(created, `任务书模板渲染失败: ${String(e.message || e)}`, { ...plan, soldierBook: null });
  }

  // #614：帅窗派工的协调 Run 打 coordinator 标记（永不自动退役）；失败回滚时回收本次新建的 Run。
  const station = bindStation({ runRole: 'coordinator' });
  if (!station.ok) failCreated(created, station.error, plan);
  created.runId = station.runId || null;
  created.runCreated = station.created === true;

  let taskId = args.task || null;
  if (soldierBook) {
    const task = taskCreateOnRun(soldierBook, station.runId);
    if (!task.ok) {
      if (isRunRequired(task.error)) failCreated(created, RUN_REQUIRED_HINT, plan);
      failCreated(created, `task-create 失败: ${errText(task.error)}`, plan);
    }
    taskId = extractTaskId(task.json) || taskId;
  }
  if (!taskId) failCreated(created, 'dispatch 没拿到 taskId', plan);

  const started = startOrcaWorker({
    task: taskId,
    worktree: created.workerId,
    launched,
    run: station.runId,
  });
  if (!started.ok) failCreated(created, `worker-start 失败: ${started.error}`, { ...plan, taskId });
  created.workerHandle = started.handle;
  created.workerDispatchId = started.dispatchId;
  if (!created.workerDispatchId) {
    failCreated(created, 'worker-start 没拿到 dispatch id（没查成，不能把消息发进真空）', { ...plan, taskId });
  }
  created.dispatchIds.push(created.workerDispatchId);
  created.taskIds.push(taskId);

  // 开工验证：#661/#679 开工只认外部证据。粘贴后等 timeout 或发出去，超时仍在框里才回滚。
  const workerInject = finishWorkerInject({
    handle: created.workerHandle,
    dispatchId: created.workerDispatchId,
    label: '工人',
    timeoutMs: probeWaitMs(routing, workerLaunch.provider),
    provider: workerLaunch.provider,
  });
  if (!workerInject.ok) failCreated(created, `注入后开工验证失败: ${workerInject.reason}`, { inject: workerInject, ...plan, taskId });
  const workerProof = workerStartProof(created.workerDispatchId); // 成功后再取一次留档（emit 用）

  if (splitGate.childCount > 0) {
    const splitKids = startSplitChildren({
      children: created.children,
      spec: String(args.spec || ''),
      slices: sliceGate.slices,
      startOne: ({ worktreeId, path: childPath, title, spec: childSpec }) => {
        if (!childPath) return { ok: false, error: `子卡 ${title} 没返回 path` };
        const env = envProbeWorktree(childPath);
        if (!env.ok) return { ok: false, error: `子树环境自检失败: ${env.error}` };
        const ident = applyGitIdentity('worker', { cwd: childPath });
        if (!ident.ok) return { ok: false, error: `子树 git 身份没设上：${ident.error}` };
        const scratch = {};
        const childLaunch = startWorkerBySlate({
          slate: slatePack.slate,
          startIndex: slatePack.startIndex,
          routing,
          worktreeId,
          title,
          created: scratch,
        });
        if (!childLaunch.ok) {
          return { ok: false, error: childLaunch.error || '子工人 TUI 未就绪', handle: scratch.workerHandle };
        }
        const childVendor = assertCrossVendor({
          workerId: childLaunch.modelId,
          reviewerId: gate.reviewer,
          models: routing.models,
        });
        if (!childVendor.ok) {
          return {
            ok: false,
            error: childVendor.error,
            handle: childLaunch.handle,
          };
        }
        let childBook;
        try {
          childBook = encodeSendText(buildSoldierInject({ spec: childSpec, issue: args.issue }), childLaunch.launch.provider);
        } catch (e) {
          return { ok: false, error: `子任务书渲染失败: ${String(e.message || e)}`, handle: childLaunch.handle };
        }
        const childTask = taskCreateOnRun(childBook, station.runId);
        if (!childTask.ok) {
          return { ok: false, error: `子 task-create 失败: ${errText(childTask.error)}`, handle: childLaunch.handle };
        }
        const childTaskId = extractTaskId(childTask.json);
        if (!childTaskId) return { ok: false, error: '子 task-create 没拿到 taskId', handle: childLaunch.handle };
        const childStarted = startOrcaWorker({
          task: childTaskId,
          worktree: worktreeId,
          launched: childLaunch,
            run: station.runId,
        });
        if (!childStarted.ok) {
          return { ok: false, error: `子 worker-start 失败: ${childStarted.error}`, handle: childStarted.handle || childLaunch.handle };
        }
        const childDispatchId = childStarted.dispatchId;
        const childHandle = childStarted.handle || childLaunch.handle;
        if (!childDispatchId) {
          return { ok: false, error: '子 worker-start 没拿到 dispatch id', handle: childHandle };
        }
        const childInject = verifyStartedPolling({
          dispatchId: childDispatchId,
          readOnce: () => readOnceHandle(childHandle),
          proofOnce: workerStartProof,
          timeoutMs: probeWaitMs(routing, childLaunch.launch.provider),
          label: `子工人 ${title}`,
          provider: childLaunch.launch.provider,
        });
        if (!childInject.ok) {
          return {
            ok: false,
            error: `子工人开工验证失败: ${childInject.reason}`,
            handle: childHandle,
            dispatchId: childDispatchId,
            taskId: childTaskId,
          };
        }
        return {
          ok: true,
          handle: childHandle,
          dispatchId: childDispatchId,
          taskId: childTaskId,
        };
      },
    });
    created.childHandles = (splitKids.started || []).map(s => s.handle).filter(Boolean);
    created.childDispatchIds = (splitKids.started || []).map(s => s.dispatchId).filter(Boolean);
    created.childTaskIds = (splitKids.started || []).map(s => s.taskId).filter(Boolean);
    created.childWorkers = splitKids.started || [];
    created.dispatchIds = [created.workerDispatchId, ...created.childDispatchIds].filter(Boolean);
    created.taskIds = [taskId, ...created.childTaskIds].filter(Boolean);
    if (!splitKids.ok) failCreated(created, splitKids.error, { ...plan, taskId, splitKids });
  }

  const comment = afterDispatchComment({
    name: args.name,
    issue: args.issue,
    worktreeId: created.workerId,
    runOrca: orca,
  });
  const masterZone = rewriteMasterZone();

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
      split: splitGate.split,
      split_reason: splitGate.splitReason,
      ...(created.childDispatchIds && created.childDispatchIds.length
        ? { child_dispatch_ids: created.childDispatchIds }
        : {}),
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

  // #614 验收④：dispatch 成功后顺带只读 run-gc 扫描，僵尸数超阈值在 stdout 打一行；
  // 扫描没查成也打 stderr（不许把「没扫成」当「查过没事」）。派工本身已成功，扫描失败不翻转。
  const gc = runGcReadonlyScan();
  const gcLine = gcThresholdLine({ zombieCount: gc.zombieCount, threshold: gc.threshold, scanned: gc.ok });
  if (gcLine) console.log(gcLine);
  else if (!gc.ok) console.error(`[dao] dispatch 后 run-gc 只读扫描没查成（派工成功）：${gc.error}`);

  emit({
    ok: true,
    ...plan,
    ...created,
    taskId,
    gc,
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
    masterZone,
    labels,
    ledger,
  });
}

function cmdDispatchBatch(args) {
  if (args.spec) fail('dispatch --batch 时不要再给 --spec（spec 在 JSON 里）');
  if (!args.name) fail('dispatch --batch 要 --name（批卡名）');
  if (!args.issue) fail('dispatch --batch 要 --issue（整批共享）');
  if (!args.model) fail('dispatch --batch 要 --model');

  const loaded = loadDispatchBatchFile(args.batch);
  if (!loaded.ok) fail(loaded.error);

  const plan = planDispatchBatch({
    name: args.name,
    issue: args.issue,
    model: args.model,
    items: loaded,
  });
  if (!plan.ok) fail(plan.error);

  const routing = loadOrFail();
  let launch;
  try {
    launch = resolveLaunch({ model: args.model, routing, root: ROOT });
  } catch (e) { fail(String(e.message || e)); }
  const cap = assertCodexLaunch({ command: launch.command });
  if (!cap.ok) fail(cap.error);
  plan.workerLaunch = launch.command;

  const disambiguation = checkIssueDisambiguated({ issue: args.issue, runGh: ghRunner() });
  if (args.dryRun) {
    emit({ ok: true, dryRun: true, ...plan, disambiguation });
  }
  if (!disambiguation.ok) {
    fail(disambiguation.error, { disambiguation, ...plan });
  }

  // #614：批派工的协调 Run 也打 coordinator 标记；失败回滚时回收本次新建的 Run。
  const station = bindStation({ runRole: 'coordinator' });
  if (!station.ok) fail(station.error, { ...plan });
  const batchRun = { runId: station.runId || null, runCreated: station.created === true };

  const effects = {
    createWorktree({ name, issue }) {
      const r = orca(argsWorktreeCreate({
        name,
        issue,
        setup: 'skip',
        comment: `batch · model:${plan.model} · reviewer:skipped · n=${plan.workers.length}`,
      }));
      if (!r.ok) return { ok: false, error: errText(r.error) };
      const id = extractWorktreeId(r.json);
      const wtPath = extractWorktreePath(r.json);
      if (!id) return { ok: false, error: '工人卡没返回 id' };
      if (!wtPath) return { ok: false, id, error: '工人卡没返回 path' };
      const env = envProbeWorktree(wtPath);
      if (!env.ok) return { ok: false, id, path: wtPath, error: `工人树环境自检失败: ${env.error}` };
      const ident = applyGitIdentity('worker', { cwd: wtPath });
      if (!ident.ok) return { ok: false, id, path: wtPath, error: `工人 git 身份没设上：${ident.error}` };
      return { ok: true, id, path: wtPath };
    },
    startTerminal({ worktree, title }) {
      // #654/#633：batch 起终端也走 launchAgentInWorktree（空壳先关再 create --command），
      // 与 start / dispatch / 审官起动同一条路径，不再直接 argsTerminalCreate。
      const term = launchAgentInWorktree({
        worktreeId: worktree,
        title,
        command: launch.command,
        launch,
      });
      if (!term.ok) return { ok: false, error: term.error };
      if (term.deferred) {
        return { ok: true, handle: null, deferred: true, agentId: term.agentId, model: term.model };
      }
      const handle = term.handle;
      const verify = waitAndVerify({
        readOnce: () => readOnceHandle(handle),
        timeoutMs: probeWaitMs(routing, launch.provider),
      });
      if (!verify.ok) {
        return { ok: false, handle, error: `工人 TUI 未就绪: ${verify.reason}` };
      }
      return { ok: true, handle, reused: term.reused === true };
    },
    createTask({ spec }) {
      const specText = encodeSendText(spec, launch.provider);
      const task = taskCreateOnRun(specText, station.runId);
      if (!task.ok) {
        if (isRunRequired(task.error)) return { ok: false, error: RUN_REQUIRED_HINT };
        return { ok: false, error: errText(task.error) };
      }
      const taskId = extractTaskId(task.json);
      if (!taskId) return { ok: false, error: 'task-create 没拿到 taskId' };
      return { ok: true, taskId };
    },
    startWorker({ task, terminal, worktree, agent, model, deferred }) {
      const started = startOrcaWorker({
        task,
        worktree,
        launched: deferred
          ? { deferred: true, agentId: agent, model }
          : { handle: terminal, launch },
        run: station.runId,
      });
      if (!started.ok) return { ok: false, error: started.error };
      const dispatchId = started.dispatchId;
      if (!dispatchId) return { ok: false, error: 'worker-start 没拿到 dispatch id' };
      const inject = verifyStartedPolling({
        dispatchId,
        readOnce: () => readOnceHandle(started.handle),
        proofOnce: workerStartProof,
        timeoutMs: probeWaitMs(routing, launch.provider),
        label: '工人',
        provider: launch.provider,
      });
      if (!inject.ok) return { ok: false, dispatchId, error: `注入后开工验证失败: ${inject.reason}` };
      return { ok: true, dispatchId, handle: started.handle };
    },
  };

  const result = runDispatchBatch({ plan, effects });
  if (!result.ok) {
    // #614 验收③：批派工失败同样回收本次新建的 Run（created 在 runDispatchBatch 内部，这里注入）
    result.created.runId = batchRun.runId;
    result.created.runCreated = batchRun.runCreated;
    failCreated(result.created, result.error, { ...plan, workers: result.workers });
  }

  // #614 验收④：批派工成功后同样顺带只读 gc 扫描（不翻转派工结果）
  const gc = runGcReadonlyScan();
  const gcLine = gcThresholdLine({ zombieCount: gc.zombieCount, threshold: gc.threshold, scanned: gc.ok });
  if (gcLine) console.log(gcLine);
  else if (!gc.ok) console.error(`[dao] dispatch --batch 后 run-gc 只读扫描没查成（派工成功）：${gc.error}`);

  const comment = afterDispatchComment({
    name: plan.cardName,
    issue: plan.issue,
    worktreeId: result.created.workerId,
    runOrca: orca,
  });
  const masterZone = rewriteMasterZone();

  emit({
    ok: true,
    ...plan,
    ...result.created,
    workers: result.workers,
    reviewerCreate: false,
    gc,
    comment,
    masterZone,
  });
}

function cmdPrSyncLabels(args) {
  const r = syncPrLabelsFromIssue({ pr: args.pr, runGh: ghRunner() });
  if (!r.ok) fail(r.error, r);
  emit({ ok: true, ...r });
}

function soldierRunId({ soldierDispatch, parentId } = {}) {
  if (soldierDispatch) {
    const shown = orca(argsWorkerShow({ dispatch: soldierDispatch }));
    if (shown.ok) {
      const id = shown.json?.result?.dispatch?.run_id || null;
      if (id) return { ok: true, runId: id };
    }
  }
  if (parentId) {
    const wl = orca(argsWorkerList());
    if (!wl.ok) return { ok: false, error: `worker-list 没查成：${errText(wl.error)}` };
    const found = findDispatchForWorktree(wl.json, parentId);
    if (found.ok && found.runId) return { ok: true, runId: found.runId };
    return { ok: false, error: found.error || '工人卡没有 run id' };
  }
  return { ok: false, error: '没 soldier dispatch / 工人卡，找不到 Run' };
}

function ensureInboxStation() {
  // 超时是防挂死闸不是性能闸：ensure 内部 run-list 分页 + worker-list + ps + gc 多次
  // orca 调用。帅方现场记录最慢样本 ~210s（#684 审官），300s = 210s + 余量；
  // 低于现场耗时的常量等于没修（dao.test.js 有超时边界回归钉）。
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'inbox-station.mjs'), 'ensure'], {
    encoding: 'utf8',
    cwd: ROOT,
    windowsHide: true,
    timeout: 300000,
  });
  let json = null;
  try { json = JSON.parse(String(r.stdout || '').trim().split(/\r?\n/).pop()); }
  catch { json = null; }
  if ((r.status !== 0 && r.status != null) || !json || json.ok !== true) {
    return { ok: false, error: (json && json.error) || String(r.stderr || '').trim() || `inbox-station ensure exit ${r.status}` };
  }
  return { ok: true, ...json };
}

function healReviewerCreateAfterFence(first, opts) {
  const inspect = inspectConsumerFence(first.ok ? '' : first.error);
  if (inspect.unscanned) {
    return { ...first, fenceHeal: inspect };
  }
  if (opts.dryRun || first.ok || !inspect.fenced) {
    return { ...first, fenceHeal: { ...inspect, action: 'none' } };
  }
  const run = soldierRunId({
    soldierDispatch: opts.soldierDispatch,
    parentId: opts.parentWorktree,
  });
  const retired = run.ok ? retireOneRun(run.runId) : { ok: false, error: run.error };
  const retried = invokeReviewerCreate(opts);
  const ensured = ensureInboxStation();
  const plan = planFenceHeal({
    error: first.error,
    runId: run.ok ? run.runId : null,
    retired,
    retried,
    ensured,
  });
  if (!plan.ok) {
    return {
      ok: false,
      invoked: true,
      dryRun: !!opts.dryRun,
      error: plan.error,
      fenceHeal: { ...inspect, ...plan, retired, retried, ensured },
    };
  }
  return { ...retried, fenceHeal: { ...inspect, ...plan, retired, ensured } };
}

function invokeReviewerCreateHealed(opts) {
  return healReviewerCreateAfterFence(invokeReviewerCreate(opts), opts);
}

function invokeReviewerCreate({ pr, name, parentWorktree, soldierDispatch, issue, dryRun, reviewer } = {}) {
  const argv = [process.argv[1], 'reviewer-create', '--pr', String(pr)];
  if (name) argv.push('--name', String(name));
  if (parentWorktree) argv.push('--parent-worktree', String(parentWorktree));
  if (soldierDispatch) argv.push('--soldier-dispatch', String(soldierDispatch));
  if (issue) argv.push('--issue', String(issue));
  if (reviewer) argv.push('--reviewer', String(reviewer));
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

/** 本仓 repoId（worktreeId 的 :: 前缀，实测为 uuid）：定界区多仓盘面认本仓的权威源（#684 余量）。 */
function currentRepoId() {
  const r = orca(['worktree', 'current', '--json']);
  if (!r.ok) return { ok: false, error: errText(r.error) };
  const wt = r.json?.result?.worktree;
  const repoId = wt && (wt.repoId || repoPrefixOf(wt.id));
  if (!repoId) return { ok: false, error: 'worktree current 没返回 repoId' };
  return { ok: true, repoId };
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

  const station = bindStation();
  if (!station.ok) return { ok: false, reused: true, error: station.error };
  const revTask = taskCreateOnRun(reviewerBook, runId, { rebindSelf: true });
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

  const revStarted = startOrcaWorker({
    task: reviewerTaskId,
    worktree: reviewerWorktreeId,
    launched: { handle },
    run: runId,
  });
  if (!revStarted.ok) {
    return { ok: false, reused: true, error: `复用审官 worker-start 失败: ${revStarted.error}（必须带 --worktree 指审官树）` };
  }
  const reviewerDispatchId = revStarted.dispatchId;
  if (!reviewerDispatchId) {
    return { ok: false, reused: true, error: '复用审官 worker-start 没拿到 dispatch id（没查成，不是已开工）' };
  }

  let routing;
  try { routing = loadRouting(); }
  catch (e) { return { ok: false, reused: true, error: String(e.message || e) }; }
  let launch;
  try { launch = resolveLaunch({ model: reviewer, routing, root: ROOT }); }
  catch { launch = { provider: 'gpt' }; }

  const reviewerInject = finishWorkerInject({
    handle,
    dispatchId: reviewerDispatchId,
    label: '审官',
    timeoutMs: probeWaitMs(routing, launch.provider),
    provider: launch.provider,
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
  // #677：本命令只交 GitHub 卷 + 起审官。Orca 结算（notify --type worker_done）不走这里。
  // 成功退出后士兵 Dispatch 必须仍是 ready/waiting，不许 completed。失败不得假装已下班。
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
  const routingDone = shouldCreate ? loadOrFail() : null;
  if (shouldCreate) {
    refuseIfSameVendor({
      workerId: plan.workerModel, reviewerId: plan.reviewer, routing: routingDone,
    });
  }
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
      create = invokeReviewerCreateHealed({
        pr: args.pr,
        name: createName,
        parentWorktree: parentId,
        soldierDispatch: args.soldierDispatch,
        issue: plan.issue,
        reviewer: plan.reviewer,
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
      settled: false,
      ...plan,
      shouldCreate,
      shouldReuse,
      reuse,
      renamed,
      reviewerCreate: create,
      reviewerReuse: reused,
    });
  }

  // #675：交卷证据必须先落到 GitHub。起审官失败不能把完工评论抹掉。
  const postedIssue = postIssueComment({ issue: plan.issue, body: plan.comment, runGh: gh });
  if (!postedIssue.ok) fail(postedIssue.error, { ...plan, postedIssue, reuse });
  const postedPr = postPrComment({ pr: plan.pr, body: plan.comment, runGh: gh });
  if (!postedPr.ok) fail(postedPr.error, { ...plan, postedIssue, postedPr, reuse });

  if (shouldCreate) {
    const models = routingDone?.models || [];
    const passerIds = reviewerPasserIds(routingDone);
    const seen = new Set();
    let currentReviewer = plan.reviewer;
    while (currentReviewer && !seen.has(currentReviewer)) {
      seen.add(currentReviewer);
      const createOpts = {
        pr: args.pr,
        name: assembleCardName({
          name: reviewerCardName(currentReviewer),
          pr: plan.pr,
          role: '审官',
          model: currentReviewer,
        }),
        parentWorktree: parentId,
        soldierDispatch: args.soldierDispatch,
        issue: plan.issue,
        reviewer: currentReviewer,
        dryRun: false,
      };
      create = invokeReviewerCreate(createOpts);
      create = healReviewerCreateAfterFence(create, createOpts);
      if (create.ok) {
        create = { ...create, reviewer: currentReviewer };
        break;
      }
      const nxt = nextReviewerAfter({
        currentId: currentReviewer, models, passerIds, workerId: plan.workerModel,
        order: reviewerOrderOf(routingDone),
      });
      if (!nxt.ok) {
        create = { ...create, exhausted: true, nextError: nxt.error, retried: true };
        break;
      }
      create = { ...create, switchedFrom: currentReviewer, firstError: create.error };
      currentReviewer = nxt.next;
    }
    if (!create.ok) {
      const cls = classifyReviewerSpawnError(create.error);
      const failBody = reviewerSpawnFailComment({
        error: create.nextError ? `${create.error}；${create.nextError}` : create.error,
        retried: true,
      });
      postIssueComment({ issue: plan.issue, body: failBody, runGh: gh });
      postPrComment({ pr: plan.pr, body: failBody, runGh: gh });
      if (parentId) {
        orca(argsWorktreeSet({ worktree: parentId, comment: '交卷了，审官没起来' }));
      }
      fail(create.nextError ? `${create.error}；${create.nextError}` : create.error, {
        ...plan, commentPosted: true, postedIssue, postedPr,
        reviewerCreate: create, reuse, spawnKind: cls.kind,
      });
    }
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
    const reuseFence = inspectConsumerFence(reused.ok ? '' : reused.error);
    if (!reused.ok && reuseFence.fenced) {
      const run = soldierRunId({ soldierDispatch: args.soldierDispatch, parentId });
      const retired = run.ok ? retireOneRun(run.runId) : { ok: false, error: run.error };
      const retried = reuseReviewerOnTerminal({
        pr: args.pr,
        reviewerWorktreeId: reuse.worktreeId,
        handle: reuse.handle,
        parentWorktree: parentId,
        soldierDispatch: args.soldierDispatch,
        reviewer: plan.reviewer,
        dryRun: false,
      });
      const ensured = ensureInboxStation();
      const planHeal = planFenceHeal({
        error: reused.error,
        runId: run.ok ? run.runId : null,
        retired,
        retried,
        ensured,
      });
      if (planHeal.ok) {
        reused = { ...retried, fenceHeal: { ...reuseFence, ...planHeal, retired, ensured } };
      } else {
        reused = { ...reused, invoked: true, skipped: true, reuseFailed: true, fenceHeal: { ...reuseFence, ...planHeal, retired, retried, ensured } };
      }
    }
    if (!reused.ok) {
      const retriedReuse = reuseReviewerOnTerminal({
        pr: args.pr,
        reviewerWorktreeId: reuse.worktreeId,
        handle: reuse.handle,
        parentWorktree: parentId,
        soldierDispatch: args.soldierDispatch,
        reviewer: plan.reviewer,
        dryRun: false,
      });
      if (retriedReuse.ok) {
        reused = { ...retriedReuse, retried: true };
      } else {
        const cls = classifyReviewerSpawnError(reused.error);
        const failBody = reviewerSpawnFailComment({ error: reused.error, retried: true });
        postIssueComment({ issue: plan.issue, body: failBody, runGh: gh });
        postPrComment({ pr: plan.pr, body: failBody, runGh: gh });
        if (parentId) {
          orca(argsWorktreeSet({ worktree: parentId, comment: '交卷了，审官没起来' }));
        }
        fail(`复用审官失败，禁止回退已结算 dispatch（#552）：${reused.error}`, {
          ...plan, commentPosted: true, postedIssue, postedPr,
          reviewerCreate: create, reviewerReuse: { ...reused, invoked: true, reuseFailed: true, retried: true }, reuse,
          spawnKind: cls.kind,
        });
      }
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
  if (!picked.ok) fail(picked.error, { ...plan, reviewerCreate: create, reviewerReuse: reused, reuse, commentPosted: true, postedIssue, postedPr });

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

  if (parentId) {
    orca(argsWorktreeSet({ worktree: parentId, comment: '待终审' }));
  }

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
    settled: false,
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
  const created = launchAgentInWorktree({
    worktreeId: args.worktree,
    title: args.title,
    command: launch.command,
    launch,
    forceCommand: true, // 裸起 TUI 无 task，不能 --agent
  });
  if (!created.ok) fail(created.error, { command: launch.command });
  const handle = created.handle;
  if (!handle) fail('没拿到终端 handle', { command: launch.command });

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
    reused: !!created.reused,
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
  const listed = readLedgerEvents(ensureLocalLedger({ root: ROOT }).dir);
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
  // 账本孤本闸的对照集合 = 本机账本（~/.dao/ledger/events，ledger 本机化后事件不进任何 git 树）
  const plan = prepareWorktreeRm(wts, args.worktree, {
    mainEventsDir: ensureLocalLedger({ root: ROOT }).dir,
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
  const masterZone = rewriteMasterZone(remaining);
  emit({
    ok: true,
    removed: applied.removed,
    runs: life,
    masterZone,
  });
}

function cmdTaskCreate(args) {
  if (!args.spec) fail('task-create 要 --spec');
  const spec = encodeSendText(String(args.spec), args.agent);
  const gate = assertInjectText(spec, { label: 'task-create' });
  if (!gate.ok) fail(gate.error);
  const station = bindStation();
  if (!station.ok) fail(station.error);
  const r = orca(argsTaskCreate({ spec, run: station.runId }));
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
  const station = bindStation();
  if (!station.ok) fail(station.error);
  const r = orca(argsWorkerStart({
    task: args.task,
    worktree: args.worktree || undefined,
    terminal: args.terminal,
    retryOf: args.retryOf,
    run: station.runId,
  }));
  if (!r.ok) fail(`worker-start 失败: ${errText(r.error)}`);
  const dispatchId = extractDispatchId(r.json);
  if (!dispatchId) fail('worker-start 成功但没拿到 dispatch id——不是已开工，是没查成（续 Dispatch 需要新身份）', { json: r.json });
  let startProvider;
  if (args.model) {
    try { startProvider = resolveLaunch({ model: args.model, routing, root: ROOT }).provider; }
    catch { startProvider = undefined; }
  }
  const injected = finishWorkerInject({
    handle: args.terminal,
    dispatchId,
    label: '续派',
    timeoutMs: probeWaitMs(routing, startProvider),
    provider: startProvider,
  });
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

  const worker = resolveWorkerFromPr({ pr: args.pr, runGh: gh });
  if (!worker.ok) fail(worker.error, { worker, pr: String(args.pr) });
  const routing = loadOrFail();
  const vendorGate = refuseIfSameVendor({
    workerId: worker.modelId, reviewerId: picked.modelId, routing,
  });

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
    workerModel: worker.modelId,
    vendorGate,
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
  const revTerm = launchAgentInWorktree({
    worktreeId: reviewerId,
    title: revName,
    command: reviewerLaunch.command,
    launch: reviewerLaunch,
  });
  if (!revTerm.ok) {
    orca(argsWorktreeRm({ worktree: reviewerId, force: true }));
    fail(`审官终端创建失败: ${revTerm.error}`, { ...plan, reviewerId, reviewerPath });
  }
  launched.reviewerHandle = revTerm.handle;
  if (!revTerm.deferred && !launched.reviewerHandle) {
    orca(argsWorktreeRm({ worktree: reviewerId, force: true }));
    fail('审官终端没返回 handle', { ...plan, reviewerId, reviewerPath });
  }

  if (!revTerm.deferred) {
    const revVerify = waitAndVerify({
      readOnce: () => readOnceHandle(launched.reviewerHandle),
      timeoutMs: probeWaitMs(routing, reviewerLaunch.provider),
    });
    if (!revVerify.ok) {
      failCreated(launched, '审官 TUI 未就绪', { verify: revVerify, ...plan });
    }
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

  const station = bindStation();
  if (!station.ok) failCreated(launched, station.error, plan);
  const reviewerRunId = soldierRunId || station.runId;
  const revTask = taskCreateOnRun(reviewerBook, reviewerRunId, { rebindSelf: true });
  if (!revTask.ok) {
    if (isRunRequired(revTask.error)) failCreated(launched, RUN_REQUIRED_HINT, plan);
    failCreated(launched, `审官 task-create 失败: ${errText(revTask.error)}`, plan);
  }
  const reviewerTaskId = extractTaskId(revTask.json);
  if (!reviewerTaskId) failCreated(launched, '审官 task-create 没拿到 taskId', plan);

  const revStarted = startOrcaWorker({
    task: reviewerTaskId,
    worktree: reviewerId,
    launched: revTerm.deferred
      ? { deferred: true, agentId: revTerm.agentId, model: revTerm.model, launch: reviewerLaunch }
      : { handle: launched.reviewerHandle, launch: reviewerLaunch },
    run: reviewerRunId,
  });
  if (!revStarted.ok) failCreated(launched, `审官 worker-start 失败: ${revStarted.error}`, { ...plan, reviewerTaskId });
  launched.reviewerHandle = revStarted.handle;
  const reviewerDispatchId = revStarted.dispatchId;
  if (!reviewerDispatchId) {
    failCreated(launched, '审官 worker-start 没拿到 dispatch id（没查成，不是已开工）', { ...plan, reviewerTaskId });
  }

  const reviewerInject = finishWorkerInject({
    handle: launched.reviewerHandle,
    dispatchId: reviewerDispatchId,
    label: '审官',
    timeoutMs: probeWaitMs(routing, reviewerLaunch.provider),
    provider: reviewerLaunch.provider,
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
 * finishWorkerInject（验开工证明）。换行按 agent 转码，不禁换行；硬闸只量我们那一半。
 * 不碰 raw，所以不会绕过开工验证。#661/#679：未提交粘贴不补回车；等 timeout 仍在框里才失败并删审官树。
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

  const gh = ghRunner({ role: 'reviewer' });
  const meta = gh(['pr', 'view', String(args.pr), '--json', 'headRefName,headRefOid,mergeable']);
  if (!meta.ok) fail(`gh 读 PR #${args.pr} 失败（不是没有 PR，是没查成）: ${meta.error}`);
  let head;
  try { head = JSON.parse(meta.out); }
  catch { fail(`gh 读 PR #${args.pr} 返回不是 JSON: ${String(meta.out).slice(0, 120)}`); }
  const baseBranch = head?.headRefName;
  const expectedOid = head?.headRefOid;
  if (!baseBranch || !expectedOid) fail(`gh 读 PR #${args.pr} 缺 headRefName/headRefOid`);
  const mergeable = assessPrMergeable(head?.mergeable);
  if (!mergeable.ok) fail(mergeable.error, { mergeable, pr: String(args.pr) });

  const fileList = gh(['api', `repos/{owner}/{repo}/pulls/${args.pr}/files`, '--paginate']);
  if (!fileList.ok) fail(`gh 读 PR #${args.pr} 文件列表失败（不是没有文件，是没查成）: ${fileList.error}`);
  let fileJson;
  try { fileJson = JSON.parse(fileList.out); }
  catch { fail(`gh 读 PR #${args.pr} 文件列表不是 JSON: ${String(fileList.out).slice(0, 120)}`); }
  const files = parseGhPullFiles(fileJson);
  if (!files) fail(`gh 读 PR #${args.pr} 文件列表形态不对`);

  const worker = resolveWorkerFromPr({ pr: args.pr, runGh: gh });
  if (!worker.ok) fail(worker.error, { worker, pr: String(args.pr) });

  // #631：树→PR 归属校验。树↔dispatch 是 issue 派工时绑死的，PR 号是后开出来的——
  // issue 号 ≠ PR 号是常态（issue #N 派工 → PR #M），所以校验的是「这棵树是不是这个 PR 的工人树」
  // （树的 issue 号 ∈ PR 署名 + 树分支 == PR head），不是「dispatch 关联号 == --pr」。
  // 对不上当场拒，不许硬塞——串号会让审官等错 id 烧 600s 再误诊「实属别的单」（#631）。
  // dry-run 不建资源，worktree list 没查成只记进 plan 不拦（CI 无 orca 时 dry-run 仍能出计划）。
  const wtList = orca(['worktree', 'list', '--json']);
  const treeVerified = (() => {
    if (!wtList.ok) {
      const err = `worktree list 没查成，树→PR 归属校验做不了: ${errText(wtList.error)}`;
      if (args.dryRun) return { ok: true, verified: false, unscanned: true, error: err };
      fail(err, { worker, pr: String(args.pr) });
    }
    const v = verifyReviewerAttachTree({
      prIssueNumbers: worker.refs,
      headRefName: baseBranch,
      worktrees: wtList.json?.result?.worktrees || wtList.json?.worktrees,
      worktreeSel: args.worktree,
    });
    if (!v.ok && !args.dryRun) fail(v.error, { worker, treeVerified: v, pr: String(args.pr) });
    return v;
  })();

  const vendorGate = refuseIfSameVendor({
    workerId: worker.modelId, reviewerId: args.reviewer, routing,
  });

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
    workerModel: worker.modelId,
    vendorGate,
    treeVerified,
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

  const revTerm = launchAgentInWorktree({
    worktreeId: created.reviewerId,
    title: revName,
    command: reviewerLaunch.command,
    launch: reviewerLaunch,
  });
  if (!revTerm.ok) failCreated(created, `审官终端创建失败: ${revTerm.error}`, plan);
  created.reviewerHandle = revTerm.handle;
  if (!revTerm.deferred && !created.reviewerHandle) failCreated(created, '审官终端没返回 handle', plan);

  if (!revTerm.deferred) {
    const revVerify = waitAndVerify({
      readOnce: () => readOnceHandle(created.reviewerHandle),
      timeoutMs: probeWaitMs(routing, reviewerLaunch.provider),
    });
    if (!revVerify.ok) failCreated(created, '审官 TUI 未就绪', { verify: revVerify, ...plan });
  }

  // #631：树→dispatch 映射是 issue 派工时写的（dispatch 绑 issue 树），
  // 它「是谁的工人」没问题，但「还会不会发完工」要另验——#625 事故里 worker-list 还显示活、
  // worker-show 已结算（capability 已吊销），审官按树映射的 id 等完工白烧 600s 再误诊「实属 #625」。
  // 注入前用 worker-show 真读复核活性；已结算禁止当收件人（#552）；worker-done 失败后补审官
  // 不再等完工 → --skip-wait（跳过等待，d 有就给红项去处，没有就红项上帅）。
  let soldierDispatchId = args.soldierDispatch || null;
  let soldierRunId = null;
  let soldierPlan = null;
  // --spec 是帅自定义整条注入，士兵 dispatch 与等待契约都不适用，不拦
  if (!args.spec) {
    let foundDispatch = null;
    if (!soldierDispatchId) {
      const wl = orca(argsWorkerList());
      if (!wl.ok && !args.skipWait) failCreated(created, `worker-list 没查成，给 --soldier-dispatch 或 --skip-wait：${errText(wl.error)}`, plan);
      if (wl.ok) foundDispatch = findDispatchForWorktree(wl.json, args.worktree);
    }
    const probeId = soldierDispatchId || (foundDispatch?.ok ? foundDispatch.dispatchId : null);
    let dispatchLive = null;
    if (probeId) {
      const shown = orca(argsWorkerShow({ dispatch: probeId }));
      if (shown.ok) {
        const d = shown.json?.result?.dispatch || {};
        const w = shown.json?.result?.worker || {};
        dispatchLive = isLiveDispatchRecipient({ workerState: w.state || d.status, dispatchStatus: d.status });
      }
    }
    soldierPlan = planAttachSoldierDispatch({
      explicitDispatch: soldierDispatchId,
      found: foundDispatch,
      dispatchLive,
      skipWait: !!args.skipWait,
    });
    if (!soldierPlan.ok) failCreated(created, soldierPlan.error, { found: foundDispatch, soldierPlan, ...plan });
    soldierDispatchId = soldierPlan.soldierDispatchId || null;
    if (soldierPlan.runId) soldierRunId = soldierPlan.runId;
    if (!soldierRunId && soldierDispatchId) soldierRunId = runIdFromDispatch(soldierDispatchId);
    if (soldierPlan.deadWarning) console.error(`[dao] 注意：${soldierPlan.deadWarning}`);
  }

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
        // #631：skip-wait 无收件人时传 ''（渲染成 d=，任务书认空 = 红项上帅），不许传 null（渲染硬闸）
        soldierDispatchId: soldierDispatchId ? String(soldierDispatchId) : '',
        mergePolicy: policy,
        mergeReason: args.mergeReason,
        skipWait: soldierPlan?.skipWait || false,
      }), reviewerLaunch.provider);
  } catch (e) {
    failCreated(created, `审官任务书渲染失败: ${String(e.message || e)}`, plan);
  }

  // #682 微通道：quick-fix 的异步 attach 是 detached 进程，bindStation 自开的 Run 没有
  // coordinator 终端，worker-start 会 consumer_fenced。微通道子进程显式 --run（--from 信箱台
  // 建的 Run，coordinator 是常驻信箱台）；其余路径照旧走 bindStation。
  let reviewerRunId = args.run ? String(args.run).trim() : null;
  if (!reviewerRunId) {
    const station = bindStation();
    if (!station.ok) failCreated(created, station.error, plan);
    reviewerRunId = station.runId;
  }
  const revTask = taskCreateOnRun(reviewerBook, reviewerRunId, { rebindSelf: true });
  if (!revTask.ok) {
    if (isRunRequired(revTask.error)) failCreated(created, RUN_REQUIRED_HINT, plan);
    failCreated(created, `审官 task-create 失败: ${errText(revTask.error)}`, plan);
  }
  const reviewerTaskId = extractTaskId(revTask.json);
  if (!reviewerTaskId) failCreated(created, '审官 task-create 没拿到 taskId', plan);

  const revStarted = startOrcaWorker({
    task: reviewerTaskId,
    worktree: created.reviewerId,
    launched: revTerm.deferred
      ? { deferred: true, agentId: revTerm.agentId, model: revTerm.model, launch: reviewerLaunch }
      : { handle: created.reviewerHandle, launch: reviewerLaunch },
    run: reviewerRunId,
    // #682 微通道：Codex TUI 冷启动（MCP 初始化 ~84s）会超默认 60s 的 dispatch_input 窗口
    // 报 agent_prompt_stalled，微通道子进程显式放宽到 180s。
    timeoutMs: args.startTimeoutMs ? Number(args.startTimeoutMs) : undefined,
  });
  if (!revStarted.ok) failCreated(created, `审官 worker-start 失败: ${revStarted.error}`, { ...plan, reviewerTaskId });
  created.reviewerHandle = revStarted.handle;
  created.reviewerDispatchId = revStarted.dispatchId;
  if (!created.reviewerDispatchId) {
    failCreated(created, '审官 worker-start 没拿到 dispatch id（没查成，不是已开工）', { ...plan, reviewerTaskId });
  }

  const reviewerInject = finishWorkerInject({
    handle: created.reviewerHandle,
    dispatchId: created.reviewerDispatchId,
    label: '审官',
    timeoutMs: probeWaitMs(routing, reviewerLaunch.provider),
    provider: reviewerLaunch.provider,
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
    soldierPlan,
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
 * 普通通知管投递：ok:true = 消息进了对方信箱。
 * --type worker_done 管结算（#551）：带身份、省略 --to，核 Dispatch 变 completed；
 * 落库无结算效力 / 缺身份 / 错 pane 一律非零并报「未结算」。
 */
function cmdNotify(args) {
  const r = deliverMessage({
    to: args.to || null,
    subject: args.subject,
    body: args.body ?? '',
    type: args.type,
    outcome: args.outcome,
    taskId: args.taskId,
    dispatchId: args.dispatchId,
    dispatchCapability: args.dispatchCapability,
    from: args.from,
    filesModified: args.filesModified,
    reportPath: args.reportPath,
    hop: args.hop || '闭环通知',
    orca: (a) => orca(a),
  });
  if (!r.ok) {
    if (r.stage === '结算' || /未结算/.test(r.error || '')) {
      console.error(`[dao notify] 未结算（${r.stage}）：${r.error}`);
    } else {
      console.error(`[dao notify] 链断，没送到（${r.stage}）：${r.error}`);
    }
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
  const plan = planRunGc({
    runs: src.runs,
    workers: src.workers,
    worktrees: src.worktrees,
  });
  if (!plan.ok) fail(plan.error);
  const leaseExistsFor = (runId) => stationFilesFor(runId).some((f) => existsSync(f));
  const parts = partitionGcTargets(plan.retire, { leaseExistsFor });
  if (!parts.ok) fail(parts.error);
  // #614：coordinator 豁免分桶（永不自动退役，显示分真假）。判据 = 在途单 / 协调终端还在盘面
  // （#638 全局台后无 per-run 租约，租约判据会把活协调 Run 误判墓碑）。查不成 → unscanned。
  const listed = orca(argsTerminalList());
  if (!listed.ok) fail(`terminal list 没查成（coordinator 活性判不了）: ${errText(listed.error)}`);
  const terminals = listed.json?.result?.terminals;
  if (!Array.isArray(terminals)) fail('terminal list 结构不认识（coordinator 活性判不了）');
  const onBoard = new Set(terminals.map(t => t && t.handle).filter(Boolean));
  const coordParts = partitionCoordinatorRuns(plan.coordinator, {
    protectedIds: new Set(plan.protected),
    handleOnBoard: (h) => onBoard.has(h),
  });
  if (!coordParts.ok) fail(coordParts.error);
  const keepCoord = coordParts.keep;
  const tombCoord = coordParts.tombstones;
  const summary = {
    pending: parts.pending.map(r => r.id),
    tombstones: [...parts.tombstones.map(r => r.id), ...tombCoord.map(r => r.id)],
    keep: [...plan.keep.map(r => r.id), ...keepCoord.map(r => r.id)],
    coordinatorKeep: keepCoord.map(r => r.id),
    coordinatorTombstones: tombCoord.map(r => r.id),
    skippedLegacy: plan.skippedLegacy.map(r => r.id),
    pendingCount: parts.pending.length,
    tombstoneCount: parts.tombstones.length + tombCoord.length,
    keepCount: plan.keep.length + keepCoord.length,
    note: 'orca 没有 run-delete；tombstones = 已退但墓碑仍在 run-list。真关只认 terminal close 掉活台，不认删租约。coordinator 标记的 Run 永不自动退役，只能显式 retire --run。',
  };
  if (!args.apply) {
    emit({ ok: true, dryRun: true, ...summary });
  }
  const results = parts.pending.map((r) => retireOneRun(r.id));
  const tallied = summarizeGcApply({ pendingResults: results, tombstones: [...parts.tombstones, ...tombCoord] });
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

/** #576：盘面动作候选一行（只读本地文件，零 GitHub；永不拦 exit 0）。 */
function cmdNext() {
  try {
    process.stdout.write(`${nextInjection()}\n`);
  } catch (e) {
    process.stdout.write(`[盘] 没查成：${String(e.message || e).slice(0, 120)}（≠ 扫完是空的）\n`);
  }
  process.exit(0);
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
    case 'next': return cmdNext(args);
    case 'raw': return cmdRaw(args);
    default:
      console.error(`未知动词: ${args.verb}`);
      process.exit(1);
  }
}

main();
