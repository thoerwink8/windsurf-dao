#!/usr/bin/env node
// scripts/dao.mjs —— 统一命令库 CLI（issue #482）
//
// 删「帅拼命令字符串」这一层。启动 / 编排走这里；查询类不在本单。
// CLI 还是约束载体：派工缺 --split / --model|--role / --reviewer 就跑不起来。
// 起 agent：派工只听仓内 launch；Orca 桌面只比较不盖 argv。
// 这里零硬编码。
// 逃生口 raw 必须留痕，否则库会因绕过而死亡。
//
// 2026-08-23 fire-and-forget 拍板：派工不再等 worker-start 认账。
// 2026-08-23 async-launch 拍板：删同步脊整层——dispatch 热路只做
//   参数校验 → 写派工单到 _flow/queue/ → spawn detached 执行体（dispatch-exec，信箱台同款）→
//   <1s 返回「已受理」。
// 执行体流程 = 重建计划（--role 选型打分在这；显式 --model 路由表序 + bans 门闩过滤，不打分）→
//   消歧门 → 账本索引查重 + 队列在途查重 → 建卡 + git 身份 → 起终端 → task-create →
//   worker-start 送字（fire-and-forget：传输错误报错回滚，agent_prompt_stalled 类认账假阴性
//   当「已送未确认」）→ 打 label → 落 dispatch 记录，结果写 _flow/queue/<id>.out.json。
// 开工/死亡确认不在派工路做，交给 watchdog（非 spinner 真实内容 / git 证据 / token）
// 与 inbox.log 完工信。758-763 实证：dao 加的认账钟误杀能干活的工人（假阴性）。

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseYaml } from './lib/yaml-min.mjs';
import { checkGates, select } from './lib/dianjiangtai-core.mjs';
import { nextInjection } from './lib/board-hook.mjs';
import {
  advanceLaunchState,
  classifyLaunchFailure,
  resolveDispatchSlate,
} from './lib/next-launch.mjs';
import { readLedgerEvents, readDispatchEventsIndexed, queryLedger, describeUnclosedJobs, recentDispatchDup } from './lib/ledger-query.mjs';
import {
  dispatchQueueDir,
  dispatchOrderPaths,
  listDispatchOrders,
  newDispatchOrderId,
  readDispatchOrder,
  recentQueueDup,
  spawnDispatchExecutor,
  writeDispatchOrder,
} from './lib/dispatch-queue.mjs';
import {
  ROOT,
  USAGE,
  argsTaskCreate,
  argsTerminalClose,
  argsTerminalCreate,
  argsTerminalList,
  argsTerminalRead,
  argsTerminalSend,
  argsTerminalWait,
  argsWorktreeCreate,
  argsWorktreeSet,
  argsWorktreeRm,
  argsWorktreePs,
  argsRepoList,
  resolveRepoSelector,
  applyWorktreeRmPlan,
  prepareWorktreeRm,
  resolveWorktreeSelector,
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
  argsRunCreate,
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
  classifyAgentScreen,
  launchAttempt,
  pickAgentTerminal,
  terminalHandles,
  planDeferredRepair,
  inspectConsumerFence,
  planFenceHeal,
  extractWorktreeId,
  extractWorktreePath,
  findDispatchForWorktree,
  findWorktreeBySel,
  verifyReviewerAttachTree,
  planAttachSoldierDispatch,
  planCreateSoldierDispatch,
  parseDispatchComment,
  progressDispatchComment,
  pickMergePolicyFromLedger,
  resolveReviewerMergePolicy,
  isLiveDispatchRecipient,
  argsWorkerList,
  gitBranchName,
  gitRemoteOriginUrl,
  isRunRequired,
  RUN_REQUIRED_HINT,
  collectReviewerCardsForPr,
  planReviewerAttachReuse,
  prepareReviewerOriginRef,
  checkoutOriginRef,
  pickDispatchAgentTerminal,
  resolveSendTarget,
  resolveIdentitySender,
  planIdentityKeep,
  reviewPendingDir,
  buildReviewPendingTicket,
  writeReviewPending,
  listReviewPending,
  drainReviewPending,

  fetchHelpPreferLive,
  loadRouting,
  parseArgs,
  parseGhPullFiles,
  loadDispatchBatchFile,
  planDispatchBatch,
  runDispatchBatch,
  applyDispatchRollback,
  probeWaitMs,
  WORKER_START_SEND_TIMEOUT_MS,
  classifyWorkerStartSend,
  findDispatchForTask,
  recordEscape,
  resolveDispatchConstraints,
  resolveSplitConstraint,
  resolveSliceAssignments,
  planSplitCards,
  buildSplitRoleSpec,
  startSplitChildren,
  resolveLaunch,
  preflightWorkerSlate,
  preflightReviewer,
  DEFAULT_DAO_REPO,
  shouldPrefixDaoTrace,
  applyDaoTraceToLaunch,
  formatDesktopLaunchNotes,
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
  planReviewerDone,
  resolveReviewerReuse,
  gateReviewerCreate,
  assertReviewerSeat,
  planReviewerCreateAfterFail,
  postIssueComment,
  postPrComment,
  postCommentOnce,
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
import { runPreflightCommand, loadDispatchPolicy } from './lib/preflight.mjs';
import { prNumberFromWorktree } from './lib/card-identity.mjs';
import { repoPrefixOf, syncMasterTicketZone, worktreesFromPs, mutateWorktreeComment } from './lib/master-title.mjs';
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
} from './inbox-station.mjs';
import { assertCrossVendor } from './lib/reviewer-vendor-gate.mjs';
import { nextReviewerAfter } from './lib/dianjiangtai-reviewer-slot.mjs';
import { planBoardTargets, formatBoardArchiveMd, boardResetVerdict } from './lib/board-reset.mjs';

const ORCA_TIMEOUT_MS = 30000;

function errText(e) {
  return orcaErrorText(e);
}

/** 桌面 vs 仓内差异只报：少的不删桌面，多的建议补仓内，启动已按仓内。 */
function noteDroppedFlags(launch) {
  for (const line of formatDesktopLaunchNotes(launch)) {
    console.error(`[dao] ${line}`);
  }
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

// async-launch（2026-08-23 拍板）：dispatch-exec 执行体进程里，emit 的每个出口
// （含 fail / failCreated 回滚路径）都先把结果落 <id>.out.json、删掉 running 标记，
// 再印 stdout 退出。热路（cmdDispatch）不设槽，行为不变。
let dispatchResultSink = null;
function setDispatchResultSink(sink) {
  dispatchResultSink = sink && sink.resultPath ? sink : null;
}

function emit(payload, exit = 0) {
  if (dispatchResultSink) {
    try {
      writeFileSync(dispatchResultSink.resultPath, JSON.stringify(payload, null, 2), 'utf8');
    } catch (e) {
      console.error(`[dispatch-exec] 结果文件写不了 ${dispatchResultSink.resultPath}：${String(e?.message || e)}`);
    }
    if (dispatchResultSink.runningPath) {
      try { unlinkSync(dispatchResultSink.runningPath); } catch { /* 标记不在也算收尾 */ }
    }
  }
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
  // #752 留现场验证闸：DAO_DISPATCH_KEEP_ON_FAIL=1 时失败不回滚，终端/worktree 保留供人工亲验。
  if (process.env.DAO_DISPATCH_KEEP_ON_FAIL === '1') {
    return {
      rollback: [{ cmd: 'keep-on-fail', ok: true, skipped: true, reason: 'DAO_DISPATCH_KEEP_ON_FAIL=1' }],
      rollbackFailed: false,
    };
  }
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

/** #823：起 pi 时要带的溯源头。Orca terminal create 不支持 Unix env，只能拼在 launch 命令前。 */
function daoTraceFor({ role, model, issue, pr, run, fallback } = {}) {
  const r = String(role || '').trim().toLowerCase();
  return {
    repo: DEFAULT_DAO_REPO,
    issue,
    pr,
    role,
    model,
    run,
    fallback: fallback || (r === 'shuai' || r === '帅' ? 'start' : 'dispatch'),
  };
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

function findAgentTerminalHandle(worktreeId, wantAgentId) {
  const listed = orca(argsTerminalList({ worktree: worktreeId }));
  if (!listed.ok) return null;
  const picked = pickAgentTerminal(listed.json?.result?.terminals, { worktreeId, wantAgentId });
  if (!picked.ok || picked.unscanned) return null;
  return picked.handle || null;
}

function launchAgentInWorktree({ worktreeId, title, command, launch, forceCommand, daoTrace }) {
  // #823：Orca terminal create 不支持 Unix env。pi 网关扩展读 DAO_*，
  // 只能拼在 --command 前；--agent pi 由 Orca 起进程，带不上。
  // 不改 toml start=agent（#802）；只在本跳有溯源头且目标是 pi 时走 command。
  if (daoTrace && shouldPrefixDaoTrace(launch || { command })) {
    const traced = applyDaoTraceToLaunch(launch || { command }, daoTrace);
    command = traced.command;
    if (launch) {
      launch.command = traced.command;
      launch.daoTrace = traced.daoTrace;
    }
  }
  const spec = agentStartSpec(launch || { command });
  const found = findDefaultTerminalForLaunch(worktreeId);
  const plan = planLaunchFallback({ foundHandle: found.handle || null });
  if (plan.closeHandle) closeWorkerHandle(plan.closeHandle);
  const mustCommand = forceCommand || !!(launch && launch.daoTrace);
  if (spec.mode === 'agent' && !mustCommand) {
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

/** stalled 响应没带 dispatchId 时按 taskId 从 worker-list 找回（763 实证记账已落）。 */
function recoverDispatchIdByTask(taskId) {
  const wl = orca(argsWorkerList());
  if (!wl.ok) return { ok: false, unscanned: true, error: `worker-list 没查成：${errText(wl.error)}` };
  return findDispatchForTask(wl.json, taskId);
}

/**
 * fire-and-forget 送字（2026-08-23 拍板）：直接 worker-start，无就绪探针、无认账钟。
 * 结果三分类（classifyWorkerStartSend）：
 *   confirmed        → ok，confirmed:true；
 *   sent-unconfirmed → ok，confirmed:false（字已进，认账是假阴性，确认交 watchdog）；
 *   transport-failed → 同步报错（调用方回滚）。
 * 两档成功都必须有 dispatchId：响应没带就按 taskId 从 worker-list 找回；
 * 找不回 = 没查成（没记账的工人 watchdog 看不见），报错回滚，不把消息发进真空。
 */
function startOrcaWorker({ task, worktree, launched, run, timeoutMs, from, book, attempts }) {
  const rows = Array.isArray(attempts) ? attempts : [];
  const sendTimeout = Number(timeoutMs) > 0 ? Number(timeoutMs) : WORKER_START_SEND_TIMEOUT_MS;
  let startArgs = null;
  if (launched?.deferred) {
    startArgs = argsWorkerStart({
      task, worktree, agent: launched.agentId, model: launched.model || undefined, run, timeoutMs: sendTimeout, from,
    });
  } else if (launched?.handle) {
    startArgs = argsWorkerStart({ task, worktree, terminal: launched.handle, run, timeoutMs: sendTimeout, from });
  } else {
    return { ok: false, error: 'worker-start 要 --terminal 或 --agent', attempts: rows };
  }
  // #802 批派工：同树多张相同 identity 时，用启动前 handle 集合做差集认新终端。
  // 快照没查成 → 直接 fail-loud，不启动；缺差集基线不许用启动后唯一匹配放行。
  let knownHandles = null;
  if (launched?.deferred) {
    if (!worktree) {
      return { ok: false, error: 'worker-start --agent 缺 worktree，无法做启动前快照（缺差集基线，不启动）', attempts: rows };
    }
    const listedBefore = orca(argsTerminalList({ worktree }));
    if (!listedBefore.ok) {
      rows.push(launchAttempt({
        provider: launched?.launch?.provider, mode: 'agent', kind: 'need-baseline',
        agentId: launched.agentId, error: errText(listedBefore.error),
      }));
      return {
        ok: false,
        error: `worker-start 前 terminal list 没查成，缺差集基线，不启动：${errText(listedBefore.error)}`,
        attempts: rows,
      };
    }
    const snap = terminalHandles(listedBefore.json?.result?.terminals, { worktreeId: worktree });
    if (!snap.ok) {
      rows.push(launchAttempt({
        provider: launched?.launch?.provider, mode: 'agent', kind: 'need-baseline',
        agentId: launched.agentId, error: snap.error,
      }));
      return { ok: false, error: `worker-start 前终端快照没查成，缺差集基线，不启动：${snap.error}`, attempts: rows };
    }
    knownHandles = snap.handles;
  }
  // orca 进程级调用上限比 --timeout-ms 宽 15s：stall 到点是 orca 正常返回，不是调用挂死。
  const r = orca(startArgs, sendTimeout + 15000);
  const send = classifyWorkerStartSend({ ok: r.ok, error: r.error, json: r.json });
  if (send.kind === 'transport-failed') {
    // 传输失败也可能已落记账（worker-start 先建 dispatch 再注入）——带上让回滚能 worker-stop，
    // 不留 workerState=failed 的僵尸记账（762 残留实证）。
    return {
      ok: false, error: workerStartFailText(r), json: r.json, handle: launched?.handle, send,
      dispatchId: extractDispatchId(r.json) || null, attempts: rows,
    };
  }

  let dispatchId = extractDispatchId(r.json);
  let dispatchIdRecovered = false;
  if (!dispatchId) {
    const found = recoverDispatchIdByTask(task);
    if (found.ok && found.dispatchId) {
      dispatchId = found.dispatchId;
      dispatchIdRecovered = true;
    }
  }
  if (!dispatchId) {
    return {
      ok: false,
      error: 'worker-start 没拿到 dispatch id（响应与 worker-list 都没查成，不能把消息发进真空）',
      json: r.json,
      handle: launched?.handle,
      send,
      attempts: rows,
    };
  }

  let handle = launched?.handle || null;
  let fellBackToCommand = false;
  if (launched?.deferred) {
    // #802：worker-start --agent 起的是另一张 agent 终端，回的 handle 常是空壳。
    // 只认 list 的 agentIdentity，不认 title。校准后把任务书送到 agent 终端。
    const listed = orca(argsTerminalList({ worktree }));
    const terms = listed.ok ? listed.json?.result?.terminals : null;
    const claimed = extractHandleFromWorkerStart(r.json);
    const repairArgs = {
      claimedHandle: claimed,
      terminals: terms,
      worktreeId: worktree,
      wantAgentId: launched.agentId,
      book,
      command: launched?.launch?.command,
      knownHandles,
    };
    let plan = planDeferredRepair(repairArgs);
    handle = plan.handle || claimed || null;
    rows.push(launchAttempt({
      provider: launched?.launch?.provider, mode: 'agent',
      kind: plan.kind || plan.action,
      agentId: launched.agentId, error: plan.error || plan.reason,
    }));
    if (!plan.ok) {
      return { ok: false, error: plan.error, json: r.json, handle, send, dispatchId, attempts: rows };
    }
    if (plan.action === 'unscanned' && !handle) {
      handle = findAgentTerminalHandle(worktree, launched.agentId);
    }
    if (!handle) {
      return { ok: false, error: 'worker-start --agent 成功但没拿到终端 handle（没查成）', json: r.json, send, attempts: rows };
    }

    if (plan.needsScreen) {
      const pre = orca(argsTerminalRead({ terminal: handle, limit: 40 }));
      const screen = pre.ok
        ? classifyAgentScreen(extractTerminalText(pre.json))
        : { kind: 'unread', reason: errText(pre.error) };
      if (plan.action === 'unscanned') {
        rows.push(launchAttempt({
          provider: launched?.launch?.provider, mode: 'agent', kind: screen.kind,
          agentId: launched.agentId, error: screen.kind === 'agent-ready' ? undefined : screen.reason,
        }));
      }
      plan = planDeferredRepair({ ...repairArgs, screen });
      if (!plan.ok) {
        rows.push(launchAttempt({
          provider: launched?.launch?.provider, mode: 'command',
          kind: plan.kind || 'repair-fail',
          agentId: launched.agentId, error: plan.error,
        }));
        return { ok: false, error: plan.error, json: r.json, handle, send, dispatchId, attempts: rows };
      }
    }

    if (plan.action === 'calibrate') {
      handle = plan.handle;
      const injected = orca(argsTerminalSend({
        terminal: handle, text: plan.book, enter: true,
        agent: launched.agentId || launched?.launch?.provider,
      }));
      rows.push(launchAttempt({
        provider: launched?.launch?.provider, mode: 'agent',
        kind: injected.ok ? 'resend-ok' : 'resend-fail',
        agentId: launched.agentId, error: injected.ok ? undefined : errText(injected.error),
      }));
      if (!injected.ok) {
        return { ok: false, error: `校准到 agent 终端后重送任务书失败：${errText(injected.error)}`, json: r.json, handle, send, dispatchId, attempts: rows };
      }
      send.kind = 'confirmed';
      send.reason = `已校准到 agentIdentity=${plan.agentIdentity} 并重送任务书`;
    } else if (plan.action === 'fallback') {
      const sentCmd = orca(argsTerminalSend({ terminal: handle, text: plan.command, enter: true }));
      if (!sentCmd.ok) {
        rows.push(launchAttempt({
          provider: launched?.launch?.provider, mode: 'command', kind: 'fallback-send-fail',
          agentId: launched.agentId, error: errText(sentCmd.error),
        }));
        return { ok: false, error: `没有目标 agent 终端，回退 --command 失败：${errText(sentCmd.error)}`, json: r.json, handle, send, dispatchId, attempts: rows };
      }
      const waitMs = Number(timeoutMs) > 0 ? Number(timeoutMs) : 120000;
      const ready = orca(argsTerminalWait({ terminal: handle, for: 'tui-idle', timeoutMs: waitMs }));
      if (!ready.ok) {
        rows.push(launchAttempt({
          provider: launched?.launch?.provider, mode: 'command', kind: 'fallback-wait-fail',
          agentId: launched.agentId, error: errText(ready.error),
        }));
        return { ok: false, error: `回退 --command 后 TUI 未就绪：${errText(ready.error)}`, json: r.json, handle, send, dispatchId, attempts: rows };
      }
      const injected = orca(argsTerminalSend({
        terminal: handle, text: plan.book, enter: true,
        agent: launched.agentId || launched?.launch?.provider,
      }));
      if (!injected.ok) {
        rows.push(launchAttempt({
          provider: launched?.launch?.provider, mode: 'command', kind: 'fallback-inject-fail',
          agentId: launched.agentId, error: errText(injected.error),
        }));
        return { ok: false, error: `回退 --command 后重送任务书失败：${errText(injected.error)}`, json: r.json, handle, send, dispatchId, attempts: rows };
      }
      rows.push(launchAttempt({
        provider: launched?.launch?.provider, mode: 'command', kind: 'fallback-ok',
        agentId: launched.agentId,
      }));
      send.kind = 'confirmed';
      send.reason = `没有目标 agentIdentity 终端，已回退 --command（${plan.command}）并重送任务书`;
      fellBackToCommand = true;
    }
  }

  // 回退已经重送任务书，不要再走下面的补粘/补回车（会打进刚起来的 TUI）。
  if (fellBackToCommand) {
    return {
      ok: true, json: r.json, handle, dispatchId,
      confirmed: true, send, dispatchIdRecovered, attempts: rows, fallback: 'command',
    };
  }

  // codex 坑 2 修复（2026-08-26 实测，#785 兜底加宽）：worker-start --agent codex 的任务书显示
  // [Pasted Content] 停在输入框（粘贴不自动提交，codex.md 坑 1 同现象）。原来只在
  // send.kind === 'sent-unconfirmed' 时补，但审官复用路 worker-start 可能返回 confirmed 而
  // [Pasted Content] 仍停输入框（2026-08-27 实测两次审官卡住）。改成不依赖 send.kind：只要
  // provider=gpt 且 handle 存在，先读屏查 [Pasted Content]，有才补回车（屏面干净不补，避免
  // confirmed 时误触发）。devin 不走这里（任务书已由 --prompt-file 送达，补回车会误触发；
  // devin 的 stalled 是假阴性，工人实际在跑）。provider 取 launched.launch.provider，
  // 兜底 launched.provider（复用路只传 handle+launch 或 handle+provider）。
  const codexProvider = launched?.launch?.provider || launched?.provider;
  if (codexProvider === 'gpt' && handle) {
    const preRead = orca(argsTerminalRead({ terminal: handle, limit: 5 }));
    if (preRead.ok) {
      const preText = extractTerminalText(preRead.json);
      if (preText && /\[Pasted Content/i.test(preText)) {
        const sent = orca(argsTerminalSend({ terminal: handle, text: '', enter: true }));
        if (sent.ok) {
          sleepMs(3000);
          const read = orca(argsTerminalRead({ terminal: handle, limit: 5 }));
          if (read.ok) {
            const text = extractTerminalText(read.json);
            if (text && !/\[Pasted Content/i.test(text)) {
              send.kind = 'confirmed';
              send.reason = 'codex [Pasted Content] 补回车已提交';
            }
          }
        }
      }
    }
  }
  // devin 交互形态修复（2026-08-26 实测）：worker-start --agent devin 的注入根本不送达
  // （任务书没进输入框，屏面停在 Ask Devin to build...，dispatch 报 agent_prompt_stalled），
  // 补回车无效——需要补粘任务书 + 回车两步提交。非交互形态（--prompt-file）不补（任务书已由文件送达）。
  if (send.kind === 'sent-unconfirmed' && launched?.launch?.provider === 'devin' && handle && book) {
    const pasted = orca(argsTerminalSend({ terminal: handle, text: book, agent: 'devin' }));
    if (pasted.ok) {
      sleepMs(2000);
      const entered = orca(argsTerminalSend({ terminal: handle, text: '', enter: true }));
      if (entered.ok) {
        sleepMs(5000);
        const read = orca(argsTerminalRead({ terminal: handle, limit: 8 }));
        if (read.ok) {
          const text = extractTerminalText(read.json);
          if (text && !/Ask Devin to build/.test(text)) {
            send.kind = 'confirmed';
            send.reason = 'devin 补粘任务书+回车已提交';
          }
        }
      }
    }
  }
  return {
    ok: true,
    json: r.json,
    handle,
    dispatchId,
    confirmed: send.kind === 'confirmed',
    send,
    dispatchIdRecovered,
    attempts: rows,
  };
}

function startWorkerBySlate({ slate, startIndex, routing, worktreeId, title, created, promptFile, daoTrace }) {
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
      launch = resolveLaunch({ model: modelId, pipe, routing, root: ROOT, promptFile });
    } catch (e) {
      return { ok: false, error: String(e.message || e), attempts };
    }
    noteDroppedFlags(launch);
    const cap = assertCodexLaunch({ command: launch.command });
    if (!cap.ok) return { ok: false, error: cap.error, attempts };

    const term = launchAgentInWorktree({
      worktreeId,
      title,
      command: launch.command,
      launch,
      daoTrace: daoTrace ? { ...daoTrace, model: modelId } : undefined,
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
      attempts.push(launchAttempt({
        modelId, pipeIndex, provider: pipe.provider, mode: 'agent', kind: 'deferred',
        agentId: term.agentId,
      }));
      return {
        ok: true, deferred: true, modelId, pipeIndex, pipe, launch,
        handle: null, agentId: term.agentId, model: term.model, attempts,
      };
    }
    const handle = term.handle;
    if (!handle) return { ok: false, error: '工人终端没返回 handle', attempts };
    created.workerHandle = handle;
    attempts.push(launchAttempt({
      modelId, pipeIndex, provider: pipe.provider, mode: 'command', kind: 'created',
    }));

    // fire-and-forget（2026-08-23）：terminal create 成功即收，不再跑 TUI 就绪探针。
    // 探针误杀能干活的工人（758-763 实证）；起没起来的确认交 watchdog。
    // 传输层失败（终端死 / agent 未配置）由 startOrcaWorker 同步报错兜底。
    // #762/#753：command 型 TUI（devin）起法 = create → wait tui-idle → worker-start。
    // wait 就绪即返回（不是固定睡满），timeoutMs 只是上限兜底；不等就绪就送字会
    // agent_prompt_stalled（devin 未就绪不接受 dispatch_input）。agent 型由 orca 管就绪。
    if (launch.provider !== 'devin' && (launch?.start === 'command' || launch?.daoTrace)) {
      const ready = orca(argsTerminalWait({ terminal: handle, for: 'tui-idle', timeoutMs: probeWaitMs(routing, pipe.provider) }));
      if (!ready.ok) {
        return { ok: false, error: `工人 TUI 等就绪失败：${errText(ready.error)}`, handle, attempts };
      }
    }
    return { ok: true, modelId, pipeIndex, pipe, launch, handle, attempts, reused: !!term.reused };
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
 * #680：cursor 通道忽略 [Pasted text] 残留，改认 Working/输出在动。
 * #762：expect 是任务书指纹，降级判绿前必须见它（否则 PS 提示符也会被当成开工）。 */
function finishWorkerInject({ handle, dispatchId, label, timeoutMs, provider, expect }) {
  return verifyStartedPolling({
    dispatchId,
    readOnce: () => readOnceHandle(handle),
    proofOnce: workerStartProof,
    timeoutMs,
    label,
    provider,
    expect,
  });
}

/** #762：任务书指纹（纯函数）。取 spec 前 24 个非空白字符——任务书进屏面必现，用于降级判绿前校验注入真发生。 */
function reviewerExpectFingerprint(spec) {
  const s = String(spec ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  return s.slice(0, 24);
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
function taskCreateOnRun(spec, runId, { rebindSelf = false, from } = {}) {
  let last = orca(argsTaskCreate({ spec, run: runId || undefined, from }));
  if (last.ok) return last;
  const why = errText(last.error);
  if (!rebindSelf || !runId || !/consumer_fenced|run_required|no longer bound/i.test(why)) {
    return last;
  }
  orca(argsRunUse({ id: runId, self: true }));
  return orca(argsTaskCreate({ spec, run: runId, from }));
}

/** 绑 orchestration Run（供 task-create / worker-start）。
 * Run：调用方已有的用已有的；run-current 为 null 时本 TUI 自己开（#675 工人 TUI 例外：不 --from 冒充台）。
 * 只许工人 TUI 走这条；帅窗 run-current 为 null 时不许靠它把自己绑成 coordinator（#667）。
 * run-current 没查成 ≠ 没有 Run。
 * #614：自开的 Run 打身份标记（objective 前缀 coordinator:/dispatch:）。帅窗派工（cmdDispatch/
 * cmdDispatchBatch）传 runRole='coordinator'（派工协调 Run 永不自动退役）；其余（工人 TUI）默认
 * 'dispatch'。
 * 2026-08-23 拍板：信箱台 ensure 挪出派工路——这里不再 ensure（一次 ensure 最慢 300s，
 * 是派工分钟级耗时的大头）。台的保活归 guard-keepalive（detached relay + 租约心跳）。 */
function bindStation({ runRole = 'dispatch' } = {}) {
  const cur = orca(argsRunCurrent());
  const plan = planCallerRun({
    currentOk: cur.ok,
    currentJson: cur.json,
    currentError: cur.ok ? null : errText(cur.error),
  });
  if (!plan.ok) return { ok: false, unscanned: !!plan.unscanned, error: plan.error };
  if (!plan.needCreate) {
    // #762 P2：复用前校验 Run 还活着（coordinator 终端在）。退役的 Run coordinator 变 null，
    // 复用会让 worker-start consumer_fenced（2026-08-24 前台重跑复用已退役 Run 实测）。
    // run-show 没查成 ≠ 没有 Run：报出来，不许静默当 0。
    const shown = orca(argsRunShow({ id: plan.runId }));
    if (!shown.ok) {
      return { ok: false, unscanned: true, runId: plan.runId, error: `复用前 run-show ${plan.runId} 没查成：${errText(shown.error)}` };
    }
    if (shown.json?.result?.run?.coordinator_handle) {
      return { ok: true, runId: plan.runId, reused: true };
    }
    // coordinator 为空（退役/墓碑）→ 不当复用，走自开。
  }
  const created = orca(argsRunCreateSelf({ objective: `${runRole}: dao dispatch` }));
  if (!created.ok) return { ok: false, error: `本窗开 Run 失败：${errText(created.error)}` };
  const runId = extractRunId(created.json);
  if (!runId) return { ok: false, error: 'run-create 没拿到 result.run.id（没查成）' };
  return { ok: true, runId, created: true, runRole };
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

/**
 * 派工去重事前查（2026-08-23 delete-all-ceremony 拍板，防 #759 重复建卡）：
 * 账本读 job.dispatch，同一 issue（无 issue 时同终端+同卡名）10 分钟内已有未结派工 → 拒派。
 * 查不成不拦路（事后证据哲学）：stderr 显形 + dup.unscanned 透出，派工照走。
 * --allow-dup 显式跳过拦截（命中仍透出，不静默）。
 * async-launch（2026-08-23）：账本读取走索引增量（readDispatchEventsIndexed），
 * 不再全量解析 441+ 事件文件；判定逻辑（recentDispatchDup）不变。执行位置在执行体。
 */
function precheckDispatchDup({ issue, terminal, name, allowDup, now } = {}) {
  let events;
  try {
    const ctx = loadLedgerContext({ root: ROOT });
    const listed = readDispatchEventsIndexed(ctx.dir, { now });
    if (listed.unscanned) {
      console.error(`[dao] 派工去重没查成（不拦路，开工/死亡证据交 watchdog）：${listed.error}`);
      return { ok: true, unscanned: true, clear: true, hit: null, error: listed.error };
    }
    events = listed.events;
  } catch (e) {
    const error = String(e.message || e);
    console.error(`[dao] 派工去重没查成（不拦路，开工/死亡证据交 watchdog）：${error}`);
    return { ok: true, unscanned: true, clear: true, hit: null, error };
  }
  const r = recentDispatchDup(events, { issue, terminal, name, now });
  if (!r.ok) {
    console.error(`[dao] 派工去重没查成（不拦路，开工/死亡证据交 watchdog）：${r.error}`);
    return { ...r, unscanned: true, clear: true, hit: null };
  }
  if (r.hit && !allowDup) {
    const h = r.hit;
    const what = h.issue_number != null ? `issue #${h.issue_number}` : `卡「${h.card_name}」`;
    return {
      ...r,
      blocked: true,
      error: `短时重复派工（防 #759 重复建卡）：${h.ts} 已派过 ${what}（job ${h.job_id}，模型 ${h.model}，至今未结）。`
        + ' 确要重派加 --allow-dup；上一单死活问 watchdog，不要靠再派一单试。',
    };
  }
  if (r.hit && allowDup) {
    console.error(`[dao] 派工去重命中但 --allow-dup 显式放行：${r.hit.job_id}（${r.hit.ts}）`);
  }
  return r;
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

/**
 * 派工计划（纯计算，零 orca/gh/账本 I/O）：热路校验用它，执行体重建也用它。
 * 返回 { ok, plan, workerLaunch, reviewerLaunch, cards, headSpec } 或 { ok:false, error }。
 */
function buildDispatchPlan({ args, gate, splitGate, sliceGate, slatePack, routing }) {
  // 同厂闸已删（2026-08-23 delete-all-ceremony 拍板）：dispatch 时审官不存在，闸是查空气；
  // slate 不再按审官厂商预剔。真闸在审官落地时（reviewer-create / reviewer-attach / worker-done）。
  const startEntry = slatePack.slate[slatePack.startIndex];
  let workerLaunch;
  let reviewerLaunch;
  try {
    workerLaunch = resolveLaunch({
      model: startEntry.id,
      pipe: startEntry.pipes[0],
      routing,
      root: ROOT,
      promptFile: startEntry.id === 'devin-deepseek-v4-flash-max' ? '_prompt.txt' : undefined,
    });
    reviewerLaunch = resolveLaunch({ model: gate.reviewer, routing, root: ROOT });
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
  noteDroppedFlags(workerLaunch);
  noteDroppedFlags(reviewerLaunch);

  const workerCap = assertCodexLaunch({ command: workerLaunch.command });
  if (!workerCap.ok) return { ok: false, error: workerCap.error };
  const reviewerCap = assertCodexLaunch({ command: reviewerLaunch.command });
  if (!reviewerCap.ok) return { ok: false, error: reviewerCap.error };

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
  return { ok: true, plan, workerLaunch, reviewerLaunch, cards, headSpec };
}

/**
 * 派工热路（2026-08-23 async-launch 拍板）：删同步脊整层——不再同步做 建卡→终端→送字。
 * 只做四步，<1s 返回：
 *   1. 参数校验（routing/约束/split/launch/名单预览，全内存或单小文件，不读账本不碰 gh/orca）
 *   2. 写派工单到 _flow/queue/<id>.json
 *   3. spawn detached 执行体（dao.mjs dispatch-exec，信箱台同款 detached 模式）
 *   4. 返回「已受理」（结果落 _flow/queue/<id>.out.json；开工/死亡确认交 watchdog 与 inbox.log）
 * 消歧门、账本查重、建 worktree、terminal create、送字、记账全在执行体（判断逻辑不变，只换执行位置）。
 */
async function cmdDispatch(args) {
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
  // 显式 --model 的全量 slate 打分已删（async-launch）：热路一律 live:false 按路由表序，
  // 不读 441+ 账本文件；role 选型打分挪进执行体（后台读得起），显式 --model 的 bans 过滤也在执行体。
  let slatePack;
  try {
    slatePack = loadDispatchSlate({
      model: gate.model,
      role: gate.role,
      routing,
      now,
      live: false,
    });
  } catch (e) { fail(String(e.message || e)); }

  const built = buildDispatchPlan({ args, gate, splitGate, sliceGate, slatePack, routing });
  if (!built.ok) fail(built.error);
  const { plan, workerLaunch } = built;

  if (args.dryRun) {
    // dry-run 预览保留消歧报告与查重透出（查重走索引增量读，不扫全量账本）；
    // 门控对预览无意义——disambiguation/dup 只作报告，不影响退出码（#565 返工）。
    const disambiguation = checkIssueDisambiguated({ issue: args.issue, runGh: ghRunner() });
    const dup = precheckDispatchDup({
      issue: args.issue,
      terminal: workerLaunch.provider,
      name: plan.workerCard,
      allowDup: args.allowDup === true,
      now,
    });
    // #842 派前探一针预览：起终端前按健康表排序 + 逐位真探（红换下一位 / 全红报帅停手）。
    let preflight = null;
    try {
      preflight = await preflightWorkerSlate({
        slate: slatePack.slate, startIndex: slatePack.startIndex,
        noPreflight: args.noPreflight === true, dispatchId: null, now,
      });
    } catch (e) { preflight = { ok: false, error: String(e.message || e) }; }
    emit({ ok: true, dryRun: true, ...plan, disambiguation, dup, preflight });
  }

  const queueDir = dispatchQueueDir({ root: ROOT });
  const id = newDispatchOrderId({ now });
  const written = writeDispatchOrder({
    dir: queueDir,
    id,
    now,
    args: {
      name: args.name,
      issue: args.issue,
      spec: args.spec,
      task: args.task,
      model: args.model,
      role: args.role,
      reviewer: args.reviewer,
      confirm: args.confirm === true,
      mergePolicy: args.mergePolicy,
      mergeReason: args.mergeReason,
      split: args.split,
      splitReason: args.splitReason,
      slice: Array.isArray(args.slice) ? args.slice : undefined,
      allowDup: args.allowDup === true,
      noPreflight: args.noPreflight === true,
      now: args.now,
    },
    plan,
    dedup: {
      issue: args.issue ? String(args.issue).trim() : null,
      terminal: workerLaunch.provider || null,
      name: plan.workerCard,
    },
  });
  if (!written.ok) fail(written.error);

  const queued = {
    ok: true,
    queued: true,
    async: true,
    orderId: id,
    orderPath: written.paths.order,
    resultPath: written.paths.result,
    logPath: written.paths.log,
    ...plan,
    confirmation: {
      confirmed: false,
      note: '已受理，后台执行体派工中（消歧门/查重/建卡/送字/记账都在后台）。结果落 resultPath（ok:false=拒派或已回滚）；开工/死亡确认交 watchdog 与 inbox.log',
    },
  };

  if (process.env.DAO_DISPATCH_NO_SPAWN === '1') {
    // 测试口（同 DAO_GH_FAKE 的隔离思路）：只写单不起执行体，热路时延可测。
    emit({ ...queued, pid: null, spawnSkipped: true });
  }
  const spawned = spawnDispatchExecutor({
    scriptPath: fileURLToPath(import.meta.url),
    orderPath: written.paths.order,
    logPath: written.paths.log,
    cwd: ROOT,
  });
  if (!spawned.ok) {
    fail(`派工执行体没拉起来：${spawned.error}（派工单已留 ${written.paths.order}，重派请用 dispatch，不要手动 dispatch-exec 重跑——复用旧 Run 会 consumer_fenced，见 #762）`, { orderId: id, orderPath: written.paths.order });
  }
  emit({ ...queued, pid: spawned.pid });
}

/**
 * 派工执行体入口（内部动词）：dispatch 热路拉起的 detached 后台进程跑这里。
 * 不要手动前台重跑（#762：detached 自开 Run 无 coordinator，重跑复用旧 Run 也 consumer_fenced；
 * 失败就重派 dispatch，别拿 dispatch-exec 当兜底）。
 * emit 结果槽保证每个出口（含 failCreated 回滚路径）都落结果文件、删 running 标记；
 * 崩在 emit 之外的补一份 crashed 结果，不让单卡死成 pending 假象。
 */
async function cmdDispatchExec(args) {
  if (!args.order) fail('dispatch-exec 要 --order <派工单路径>');
  const read = readDispatchOrder(args.order);
  if (!read.ok) fail(read.error);
  const order = read.order;
  const queueDir = dirname(args.order);
  const paths = dispatchOrderPaths(queueDir, order.id);
  setDispatchResultSink({ resultPath: paths.result, runningPath: paths.running });
  try {
    writeFileSync(paths.running, JSON.stringify({ pid: process.pid, ts: new Date().toISOString() }), 'utf8');
  } catch (e) {
    fail(`执行体开工标记写不了：${String(e.message || e)}`, { orderId: order.id });
  }
  try {
    await runDispatchExecution(order, { queueDir });
  } catch (e) {
    try {
      writeFileSync(paths.result, JSON.stringify({
        ok: false, orderId: order.id, crashed: true,
        error: `执行体崩溃：${String(e?.message || e)}`,
      }, null, 2), 'utf8');
      try { unlinkSync(paths.running); } catch { /* 标记不在也算收尾 */ }
    } catch { /* 结果也写不动，留 running 标记显形 */ }
    console.error(`[dispatch-exec] 崩溃：${String(e?.stack || e)}`);
    process.exit(1);
  }
}

/**
 * 队列在途查重（async-launch 后 #759 防重复建卡的第二道）：账本 job.dispatch 要等
 * 送字成功才落，两单间隔几秒时账本还看不见第一单——但派工单是热路同步写的，
 * 第二单的执行体一定能看见。命中（在窗同 issue / 同终端+同卡名的 pending/running/done 单）拒派；
 * 查不成不拦路（stderr 显形）。--allow-dup 显式跳过。
 */
function precheckQueueDup({ queueDir, selfId, issue, terminal, name, allowDup, now } = {}) {
  let listed;
  try {
    listed = listDispatchOrders(queueDir, {
      readResult: (p) => JSON.parse(readFileSync(p, 'utf8')),
    });
  } catch (e) {
    const error = String(e.message || e);
    console.error(`[dao] 队列查重没查成（不拦路）：${error}`);
    return { ok: true, unscanned: true, clear: true, hit: null, error };
  }
  if (!listed.ok) {
    console.error(`[dao] 队列查重没查成（不拦路）：${listed.error}`);
    return { ok: true, unscanned: true, clear: true, hit: null, error: listed.error };
  }
  const r = recentQueueDup(listed.orders, { issue, terminal, name, now, selfId });
  if (!r.ok) {
    console.error(`[dao] 队列查重没查成（不拦路）：${r.error}`);
    return { ...r, unscanned: true, clear: true, hit: null };
  }
  if (r.hit && !allowDup) {
    const h = r.hit;
    const what = h.issue != null ? `issue #${h.issue}` : `卡「${h.name}」`;
    return {
      ...r,
      blocked: true,
      error: `短时重复派工（防 #759 重复建卡）：派工单 ${h.order_id}（${h.ts}，${h.status}）已在队列/在途，同 ${what}。`
        + ' 确要重派加 --allow-dup；上一单死活问 watchdog，不要靠再派一单试。',
    };
  }
  if (r.hit && allowDup) {
    console.error(`[dao] 队列查重命中但 --allow-dup 显式放行：${r.hit.order_id}（${r.hit.ts}）`);
  }
  return r;
}

/**
 * 执行体本体：原 cmdDispatch 同步脊整段平移（判断逻辑不变，只换执行位置）。
 * 流程 = 重建计划（--role 选型打分在这，后台读全量账本；显式 --model 路由表序 + bans 门闩过滤）
 * → 消歧门 → 账本索引查重 + 队列在途查重 → 建卡 + git 身份 → 起终端 → task-create →
 * worker-start 送字（fire-and-forget 三分类不变）→ 打 label → 落账本。
 */
async function runDispatchExecution(order, { queueDir } = {}) {
  const args = { ...order.args };
  const routing = loadOrFail();
  const gate = constrainDispatch(args, routing);
  if (!args.spec && !args.task) fail('dispatch 要 --spec（工人任务书），或已有 --task', { orderId: order.id });
  if (!args.name) fail('dispatch 要 --name', { orderId: order.id });

  const splitGate = resolveSplitConstraint({ split: args.split, splitReason: args.splitReason });
  if (!splitGate.ok) fail(splitGate.error, { missing: splitGate.missing || [], orderId: order.id });
  const sliceGate = resolveSliceAssignments({ childCount: splitGate.childCount, slices: args.slice });
  if (!sliceGate.ok) fail(sliceGate.error, { missing: sliceGate.missing || [], orderId: order.id });

  const now = args.now ? new Date(args.now) : new Date(order.ts);
  let slatePack;
  try {
    slatePack = loadDispatchSlate({
      model: gate.model,
      role: gate.role,
      routing,
      now,
      live: !gate.model,
    });
  } catch (e) { fail(String(e.message || e), { orderId: order.id }); }
  if (gate.model) {
    // 显式 --model 不打分，但 bans 硬禁令仍过滤回退链（点将台最上层硬门闩，单小文件读得起）。
    let bans = [];
    try {
      bans = parseYaml(readFileSync(join(ROOT, 'policy', 'bans.yml'), 'utf8')).bans || [];
    } catch (e) {
      fail(`bans.yml 读不了（显式 --model 的回退链过滤靠它，没查成不派）：${String(e.message || e)}`, { orderId: order.id });
    }
    const workType = gate.role || '写码';
    const kept = slatePack.slate.filter(s => !checkGates({ model: { id: s.id }, identity: '工人', workType, bans }).rejected);
    const startIndex = kept.findIndex(s => s.id === gate.model);
    if (startIndex < 0) {
      fail(`模型 ${gate.model} 命中 bans 硬禁令（${workType}），拒派——换模型或先改 bans.yml`, { orderId: order.id });
    }
    slatePack = { ...slatePack, slate: kept, startIndex };
  }

  const built = buildDispatchPlan({ args, gate, splitGate, sliceGate, slatePack, routing });
  if (!built.ok) fail(built.error, { orderId: order.id });
  const { plan, cards, headSpec } = built;
  let { workerLaunch } = built;

  // 消歧门（#565）：带 --issue 的派工，目标 issue 必须已打「已消歧」label，读不到拒派（fail-close）。
  // 在一切建卡动作之前拦（被拦下时什么都不会创建）。gh 查失败单独报「没查成」，不许当有 label 放行。
  const disambiguation = checkIssueDisambiguated({ issue: args.issue, runGh: ghRunner() });
  if (!disambiguation.ok) {
    fail(disambiguation.error, { disambiguation, orderId: order.id, ...plan });
  }

  // 派工去重（#759）：账本索引查重 + 队列在途查重，都在一切建卡动作之前拦。
  const dup = precheckDispatchDup({
    issue: args.issue,
    terminal: workerLaunch.provider,
    name: plan.workerCard,
    allowDup: args.allowDup === true,
    now,
  });
  const queueDup = precheckQueueDup({
    queueDir,
    selfId: order.id,
    issue: args.issue,
    terminal: workerLaunch.provider,
    name: plan.workerCard,
    allowDup: args.allowDup === true,
    now,
  });
  if (dup.blocked) {
    fail(dup.error, { dup, queueDup, disambiguation, orderId: order.id, ...plan });
  }
  if (queueDup.blocked) {
    fail(queueDup.error, { dup, queueDup, disambiguation, orderId: order.id, ...plan });
  }

  const created = { childIds: [], childHandles: [], children: [], dispatchIds: [], taskIds: [] };

  // #762：worktree create 一律带 --repo id:<本仓>，避免从外部主树建卡报 Missing repo selector。
  // 匹配按 git remote URL（执行体可能跑在任意 worktree，路径匹配会失配）；remote 没查成再 fallback 路径。
  // repo list 没查成 / 0 条 / 多条 → 分开报（不许把「没查成」当「没注册」）。
  const repoListed = orca(argsRepoList());
  const repoRemote = gitRemoteOriginUrl(ROOT);
  const repoResolved = repoListed.ok
    ? resolveRepoSelector({
        repos: repoListed.json?.result?.repos,
        remoteUrl: repoRemote.ok ? repoRemote.url : undefined,
      })
    : { ok: false, unscanned: true, error: `orca repo list 没查成：${errText(repoListed.error)}` };
  if (!repoResolved.ok) {
    fail(`本仓 repo 选择符没解析成：${repoResolved.error}`, { orderId: order.id, ...plan, repoResolved, repoRemote: repoRemote.ok ? repoRemote.url : repoRemote.error });
  }
  created.repoSelector = repoResolved.selector;

  const workerWt = orca(argsWorktreeCreate({
    name: plan.workerCard,
    noParent: true,
    setup: 'skip',
    issue: args.issue,
    comment: plan.comment,
    repo: repoResolved.selector,
  }));
  if (!workerWt.ok) fail(`工人卡创建失败: ${errText(workerWt.error)}`, { orderId: order.id, ...plan });
  created.workerId = extractWorktreeId(workerWt.json);
  created.workerPath = extractWorktreePath(workerWt.json);
  if (!created.workerId) fail('工人卡没返回 id', { orderId: order.id, ...plan });
  if (!created.workerPath) failCreated(created, '工人卡没返回 path', { orderId: order.id, ...plan });

  // 每单环境自检已删（2026-08-23 delete-all-ceremony 拍板）：建树后不再跑 shell 探针，
  // 环境类毛病的证据归 watchdog / 工人开工报。

  // #573：commit author 跟身份走。token 只改 PR 页，git log 仍读 user.name——
  // 只改一半比不改更容易误判。写在 worktree 级 config，不碰共用 user.name。
  const workerIdent = applyGitIdentity('worker', { cwd: created.workerPath });
  if (!workerIdent.ok) failCreated(created, `工人 git 身份没设上：${workerIdent.error}`, { orderId: order.id, ...plan });
  created.workerGitIdentity = `${workerIdent.name} <${workerIdent.email}>`;

  const workerBranch = gitBranchName(created.workerPath);
  if (!workerBranch.ok) failCreated(created, `工人树分支没查成: ${workerBranch.error}`, { orderId: order.id, ...plan });

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
        repo: created.repoSelector,
      }));
      if (!childWt.ok) failCreated(created, `子卡 ${child.name} 创建失败: ${errText(childWt.error)}`, { orderId: order.id, ...plan });
      const childId = extractWorktreeId(childWt.json);
      if (!childId) failCreated(created, `子卡 ${child.name} 没返回 id`, { orderId: order.id, ...plan });
      const childPath = extractWorktreePath(childWt.json);
      created.childIds.push(childId);
      created.children.push({ id: childId, path: childPath, name: child.name });
    }
  }

  // devin 交互形态（2026-08-26 拍板）：worker-start --agent devin 起 TUI，注入不送达，
  // startOrcaWorker 补粘任务书 + 回车（book 参数）。_prompt.txt 仍写进工人卡（devin 干活可参考；
  // 非交互形态 -p --prompt-file 时 launch 的 {prompt_file} 占位符引用它，备用通道保留）。
  const isDevinWorker = slatePack.slate[slatePack.startIndex]?.id === 'devin-deepseek-v4-flash-max';
  let promptFile = null;
  let injectText = null;
  if (args.spec) {
    injectText = buildSoldierInject({ spec: headSpec || String(args.spec), issue: args.issue });
  }
  if (isDevinWorker && injectText) {
    try {
      promptFile = join(created.workerPath, '_prompt.txt');
      writeFileSync(promptFile, `${injectText}\n完成后运行：node scripts/dao.mjs worker-done --pr <PR号> --body-file <完工说明文件>（PR 号用 gh pr view --json number -q .number 查）`, 'utf8');
    } catch (e) {
      failCreated(created, `devin 任务书写文件失败: ${String(e.message || e)}`, { orderId: order.id, ...plan });
    }
  }

  // #842 派前探一针：起终端前按健康表排序 + 逐位真探。红换下一位（改 startIndex）；
  // 全红/全拦 → 报帅停手，一个 agent 都不起（回滚已建的工人卡）。--no-preflight 跳过且记账。
  try {
    const pf = await preflightWorkerSlate({
      slate: slatePack.slate, startIndex: slatePack.startIndex,
      noPreflight: args.noPreflight === true, dispatchId: order.id, now,
    });
    if (pf.stop) {
      failCreated(created, `派前探一针：工人候选全红/全拦，停手不起 agent。\n${pf.report || ''}`, { orderId: order.id, preflight: pf, ...plan });
    }
    if (pf.chosen && Number.isInteger(pf.startIndex) && pf.startIndex >= 0) {
      slatePack = { ...slatePack, startIndex: pf.startIndex };
    }
  } catch (e) {
    // 探针框架自身抛错不拦派工（fail-open 到原路起，不因探针 bug 停摆）；留痕。
    console.error(`[dao] 派前探一针异常（放行原路起）：${String(e.message || e)}`);
  }

  const launched = startWorkerBySlate({
    slate: slatePack.slate,
    startIndex: slatePack.startIndex,
    routing,
    worktreeId: created.workerId,
    title: args.name,
    created,
    promptFile,
    daoTrace: daoTraceFor({ role: 'worker', model: plan.model, issue: args.issue }),
  });
  if (!launched.ok) {
    failCreated(created, launched.error || '工人 TUI 未就绪', { verify: launched.verify, attempts: launched.attempts, orderId: order.id, ...plan });
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
      ? encodeSendText(injectText, workerLaunch.provider)
      : null;
  } catch (e) {
    failCreated(created, `任务书模板渲染失败: ${String(e.message || e)}`, { orderId: order.id, ...plan, soldierBook: null });
  }

  // #762：detached 执行体自开 Run 没有 coordinator 终端，worker-start 会 consumer_fenced
  // （2026-08-24 三连败实证）。照 #682 微通道已验证方案：在工人卡上起一个「派工协调（勿关）」
  // 哑终端当 Run coordinator，run-create --from 它，worker-start 用这个 Run。
  // 哑终端随 worker 卡收树一起关（handles 登记），不多开；失败回滚时回收本次新建的 Run。
  const coordTerm = orca(argsTerminalCreate({
    worktree: created.workerId,
    title: '派工协调（勿关）',
  }));
  if (!coordTerm.ok) failCreated(created, `派工协调终端没建成：${errText(coordTerm.error)}`, { orderId: order.id, ...plan });
  const coordHandle = extractHandleFromCreate(coordTerm.json);
  if (!coordHandle) failCreated(created, '派工协调终端没返回 handle（没查成）', { orderId: order.id, ...plan });
  created.coordHandle = coordHandle;
  created.handles = [...(Array.isArray(created.handles) ? created.handles : []), coordHandle];
  const coordRun = orca(argsRunCreate({
    objective: 'coordinator: dao dispatch',
    from: coordHandle,
  }));
  if (!coordRun.ok) failCreated(created, `派工协调 Run 没建成（--from 哑终端）：${errText(coordRun.error)}`, { orderId: order.id, ...plan });
  const runId = extractRunId(coordRun.json);
  if (!runId) failCreated(created, '派工协调 Run 没拿到 id（没查成）', { orderId: order.id, ...plan });
  created.runId = runId;
  created.runCreated = true;

  let taskId = args.task || null;
  if (soldierBook) {
    const task = taskCreateOnRun(soldierBook, runId, { from: coordHandle });
    if (!task.ok) {
      if (isRunRequired(task.error)) failCreated(created, RUN_REQUIRED_HINT, { orderId: order.id, ...plan });
      failCreated(created, `task-create 失败: ${errText(task.error)}`, { orderId: order.id, ...plan });
    }
    taskId = extractTaskId(task.json) || taskId;
  }
  if (!taskId) failCreated(created, 'dispatch 没拿到 taskId', { orderId: order.id, ...plan });

  // fire-and-forget（2026-08-23 拍板）：送字后不等认账。传输错误同步报错回滚；
  // agent_prompt_stalled 类认账假阴性当「已送未确认」（763 实证），开工/死亡确认交 watchdog。
  // #762：--timeout-ms 是 orca 等 dispatch_input 的窗口（command 型 TUI 冷启动要几十秒），
  // 不是帅等 2 分钟——热路已返回，执行体在后台等。窗口不够 codex/devin 会 agent_prompt_stalled。
  const started = startOrcaWorker({
    task: taskId,
    worktree: created.workerId,
    launched,
    run: runId,
    from: coordHandle,
    timeoutMs: probeWaitMs(routing, workerLaunch.provider),
    book: injectText,
    attempts: launched.attempts,
  });
  if (Array.isArray(started.attempts)) plan.launchAttempts = started.attempts;
  if (!started.ok) {
    // 失败但记账已落的（响应里带出 dispatchId）：记进 created，回滚先 worker-stop 不留僵尸。
    if (started.dispatchId) created.dispatchIds.push(started.dispatchId);
    failCreated(created, `worker-start 失败: ${started.error}`, { orderId: order.id, ...plan, taskId, send: started.send });
  }
  created.workerHandle = started.handle;
  created.workerDispatchId = started.dispatchId;
  if (!created.workerDispatchId) {
    failCreated(created, 'worker-start 没拿到 dispatch id（没查成，不能把消息发进真空）', { orderId: order.id, ...plan, taskId });
  }
  const wrAgent = orca(argsWorkerRead({ dispatch: created.workerDispatchId, source: 'auto' }));
  const agentTerminal = pickDispatchAgentTerminal({
    workerHandle: created.workerHandle,
    workerReadJson: wrAgent.ok ? wrAgent.json : null,
  });
  created.agentTerminalHandle = agentTerminal.ok ? agentTerminal.agentTerminalHandle : null;
  created.agentTerminal = agentTerminal;
  created.dispatchIds.push(created.workerDispatchId);
  created.taskIds.push(taskId);
  const workerConfirmation = {
    confirmed: started.confirmed === true,
    note: started.confirmed === true
      ? 'orca 报 ready（认账到了）'
      : '已派，未确认。开工/死亡确认交给 watchdog（非 spinner 真实内容 / git 证据 / token）与 inbox.log 完工信',
  };

  if (splitGate.childCount > 0) {
    const splitKids = startSplitChildren({
      children: created.children,
      spec: String(args.spec || ''),
      slices: sliceGate.slices,
      startOne: ({ worktreeId, path: childPath, title, spec: childSpec }) => {
        if (!childPath) return { ok: false, error: `子卡 ${title} 没返回 path` };
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
          daoTrace: daoTraceFor({ role: 'worker', model: plan.model, issue: args.issue }),
        });
        if (!childLaunch.ok) {
          return { ok: false, error: childLaunch.error || '子工人 TUI 未就绪', handle: scratch.workerHandle };
        }
        let childBook;
        try {
          childBook = encodeSendText(buildSoldierInject({ spec: childSpec, issue: args.issue }), childLaunch.launch.provider);
        } catch (e) {
          return { ok: false, error: `子任务书渲染失败: ${String(e.message || e)}`, handle: childLaunch.handle };
        }
        const childTask = taskCreateOnRun(childBook, runId, { from: coordHandle });
        if (!childTask.ok) {
          return { ok: false, error: `子 task-create 失败: ${errText(childTask.error)}`, handle: childLaunch.handle };
        }
        const childTaskId = extractTaskId(childTask.json);
        if (!childTaskId) return { ok: false, error: '子 task-create 没拿到 taskId', handle: childLaunch.handle };
        // 子工人同主路：fire-and-forget，不等认账。
        const childStarted = startOrcaWorker({
          task: childTaskId,
          worktree: worktreeId,
          launched: childLaunch,
          run: runId,
          from: coordHandle,
          book: childBook,
        });
        if (!childStarted.ok) {
          return { ok: false, error: `子 worker-start 失败: ${childStarted.error}`, handle: childStarted.handle || childLaunch.handle };
        }
        const childDispatchId = childStarted.dispatchId;
        const childHandle = childStarted.handle || childLaunch.handle;
        if (!childDispatchId) {
          return { ok: false, error: '子 worker-start 没拿到 dispatch id', handle: childHandle };
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
    if (!splitKids.ok) failCreated(created, splitKids.error, { orderId: order.id, ...plan, taskId, splitKids });
  }

  // 同步看板已删（2026-08-23 delete-all-ceremony 拍板）：派工热路不再写卡 comment 定界区、
  // 不再全量重写 master 卡。建卡时 --issue 已带进 linkedIssue，归属证据够看板扫；
  // master 定界区仍在 worktree-rm / 合并时重写（#684 清卡同钩保留）。

  // #564 label 自动打：dispatch 成功时把 model/<模型> type/<角色> 打到目标 issue（best-effort，
  // 失败只报告不翻转派工结果——label 是校准数据源，但回滚一个成功的派工代价更大；帅合并时
  // 用 pr-sync-labels 从 issue 同步到 PR）。gh 没查成 != 查过没事：失败也要说清楚。
  // 身份走 marshal：这是帅进程里写 issue（#627），裸 gh 会记成 thoerwink8。
  // async-launch：打 label 挪进执行体（事后），不在热路。
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
      merge_policy: plan.mergePolicy,
      ...(plan.mergeReason ? { merge_reason: plan.mergeReason } : {}),
      ...(created.childDispatchIds && created.childDispatchIds.length
        ? { child_dispatch_ids: created.childDispatchIds }
        : {}),
      ...(args.issue ? { issue_number: Number(args.issue) || args.issue } : {}),
      card_name: plan.workerCard,
    },
    });
    if (!ledger.ok && !ledger.skipped) {
      console.error(`[dao] dispatch 账本没写上（派工本身成功）：${ledger.error}`);
    }
  } catch (e) {
    ledger = { ok: false, error: String(e.message || e) };
    console.error(`[dao] dispatch 账本没写上（派工本身成功）：${ledger.error}`);
  }

  // gc 顺车已删（2026-08-23 delete-all-ceremony 拍板）：派工热路不再顺带只读 run-gc。
  // 自动扫描仍在 inbox-station ensure（#614 顺车在那保留）；手动清用 dao.mjs run-gc。

  emit({
    ok: true,
    orderId: order.id,
    ...plan,
    ...created,
    taskId,
    dup,
    queueDup,
    loop: {
      soldierBook: !!soldierBook,
      reviewerDeferred: true,
      soldierDoneVia: 'worker-done',
      archivedBy: '帅（归档动作帅做，审官不 rm 树）',
    },
    confirmation: workerConfirmation,
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
  noteDroppedFlags(launch);
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
      // 每单环境自检已删（2026-08-23 delete-all-ceremony 拍板），证据归 watchdog。
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
        daoTrace: daoTraceFor({ role: 'worker', model: plan.model, issue: args.issue }),
      });
      if (!term.ok) return { ok: false, error: term.error };
      if (term.deferred) {
        return { ok: true, handle: null, deferred: true, agentId: term.agentId, model: term.model };
      }
      const handle = term.handle;
      // fire-and-forget（2026-08-23）：起终端成功即收，不就绪探针；确认交 watchdog。
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
      return { ok: true, taskId, specText };
    },
    startWorker({ task, terminal, worktree, agent, model, deferred, book }) {
      // fire-and-forget（2026-08-23）：送字即收，不等认账；确认交 watchdog。
      const started = startOrcaWorker({
        task,
        worktree,
        launched: deferred
          ? { deferred: true, agentId: agent, model, launch }
          : { handle: terminal, launch },
        run: station.runId,
        book,
      });
      if (!started.ok) return { ok: false, error: started.error, dispatchId: started.dispatchId || null };
      const dispatchId = started.dispatchId;
      if (!dispatchId) return { ok: false, error: 'worker-start 没拿到 dispatch id' };
      return { ok: true, dispatchId, handle: started.handle, confirmed: started.confirmed === true };
    },
  };

  const result = runDispatchBatch({ plan, effects });
  if (!result.ok) {
    // #614 验收③：批派工失败同样回收本次新建的 Run（created 在 runDispatchBatch 内部，这里注入）
    result.created.runId = batchRun.runId;
    result.created.runCreated = batchRun.runCreated;
    failCreated(result.created, result.error, { ...plan, workers: result.workers });
  }

  // gc 顺车 + 同步看板已删（2026-08-23 delete-all-ceremony 拍板）：批派工热路同样不背。
  // 自动 gc 扫描在 inbox-station ensure；master 定界区在 worktree-rm / 合并时重写。

  emit({
    ok: true,
    ...plan,
    ...result.created,
    workers: result.workers,
    reviewerCreate: false,
  });
}

function cmdPrSyncLabels(args) {
  const r = syncPrLabelsFromIssue({ pr: args.pr, runGh: ghRunner() });
  if (!r.ok) fail(r.error, r);
  emit({ ok: true, ...r });
}

/** #781：worker-list 项没有 last_failure 字段，findDispatchForWorktree 对 failed 候选
 * 用这个回调调 worker-show 取真实 last_failure（result.dispatch.last_failure）。
 * 没查成返回 null → 调用方 fail-close 判死（不许因没查成当活人，#552）。 */
function resolveDispatchLastFailure(dispatchId) {
  if (!dispatchId) return null;
  const r = orca(argsWorkerShow({ dispatch: dispatchId }));
  if (!r.ok) return null;
  return r.json?.result?.dispatch?.last_failure ?? null;
}

/** #799：审官 create/attach/reuse 继承派工 merge-policy。账本没查成 ≠ 没有字段，都回退 auto 并写原因。 */
function lookupReviewerMergePolicy({
  explicitPolicy, explicitReason, issue, pr, dispatchId, worktreeSel, worktrees,
} = {}) {
  let ledger = { ok: false, unscanned: true, state: 'unscanned', error: '账本未读' };
  try {
    const ctx = loadLedgerContext({ root: ROOT });
    const listed = readLedgerEvents(ctx.dir);
    if (listed.unscanned) {
      ledger = { ok: false, unscanned: true, state: 'unscanned', error: listed.error };
    } else {
      ledger = pickMergePolicyFromLedger({
        events: listed.events,
        issue,
        pr,
        dispatchId,
      });
    }
  } catch (e) {
    ledger = { ok: false, unscanned: true, state: 'unscanned', error: String(e.message || e) };
  }
  let trees = worktrees;
  if (worktreeSel && !Array.isArray(trees)) {
    const listed = orca(['worktree', 'list', '--json']);
    if (listed.ok) trees = listed.json?.result?.worktrees || listed.json?.worktrees;
  }
  const wt = worktreeSel && Array.isArray(trees) ? findWorktreeBySel(trees, worktreeSel) : null;
  const comment = parseDispatchComment(wt && wt.comment);
  return resolveReviewerMergePolicy({
    explicitPolicy,
    explicitReason,
    ledger,
    comment,
  });
}

/** #799：写人话进度时保留卡上 merge-policy 前缀。show 失败则用盘面列表里的旧 comment 兜底。 */
function setWorkerCardProgress(parentId, progress, worktrees) {
  if (!parentId) return { ok: true, skipped: true };
  const mutated = mutateWorktreeComment({
    worktreeId: parentId,
    runOrca: (a) => orca(a),
    mutate: (comment) => progressDispatchComment(comment, progress),
  });
  if (mutated.ok) return mutated;
  const wt = Array.isArray(worktrees) ? findWorktreeBySel(worktrees, parentId) : null;
  const next = progressDispatchComment(wt && wt.comment, progress);
  return orca(argsWorktreeSet({ worktree: parentId, comment: next }));
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
    const found = findDispatchForWorktree(wl.json, parentId, resolveDispatchLastFailure);
    if (found.ok && found.runId) return { ok: true, runId: found.runId };
    return { ok: false, error: found.error || '工人卡没有 run id' };
  }
  return { ok: false, error: '没 soldier dispatch / 工人卡，找不到 Run' };
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
  // 2026-08-23 拍板：信箱台 ensure 挪出 dao 全路（含 fence 自愈）——保活归 guard-keepalive。
  const ensured = { ok: true, skipped: true, reason: 'ensure 已挪出 dao（信箱台保活归 guard-keepalive）' };
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

function invokeReviewerCreate({ pr, name, parentWorktree, soldierDispatch, issue, dryRun, reviewer, from } = {}) {
  const argv = [process.argv[1], 'reviewer-create', '--pr', String(pr)];
  if (name) argv.push('--name', String(name));
  if (parentWorktree) argv.push('--parent-worktree', String(parentWorktree));
  if (soldierDispatch) argv.push('--soldier-dispatch', String(soldierDispatch));
  if (issue) argv.push('--issue', String(issue));
  if (reviewer) argv.push('--reviewer', String(reviewer));
  if (from) argv.push('--from', String(from));
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
      outcome: (json && json.outcome) || 'failed',
      error: (json && json.error) || String(r.stderr || '').trim() || `reviewer-create exit ${r.status}`,
    };
  }
  return {
    ok: true,
    invoked: true,
    dryRun: !!dryRun,
    outcome: json.outcome || (json.reused ? 'reused' : 'created'),
    reused: !!json.reused,
    verb: 'reviewer-create',
    pr: String(pr),
    reviewer: json.reviewer,
    reviewerSource: json.reviewerSource,
    reviewerId: json.reviewerId || null,
    reviewerDispatchId: json.reviewerDispatchId || null,
    reason: json.reason || (dryRun ? 'dry-run：只打印选型不建树' : '已调 reviewer-create 起审官'),
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

function writeReviewPendingOnFail({
  pr, parentId, reviewer, issue, round, error, workerModel, soldierDispatch, runGh,
} = {}) {
  try {
    let head = { name: null, oid: null };
    if (typeof runGh === 'function') {
      const meta = runGh(['pr', 'view', String(pr), '--json', 'headRefName,headRefOid']);
      if (meta.ok) {
        try {
          const parsed = JSON.parse(meta.out);
          head = { name: parsed.headRefName || null, oid: parsed.headRefOid || null };
        } catch { /* drain 自己再读 PR */ }
      }
    }
    const built = buildReviewPendingTicket({
      pr, head, workerWorktree: parentId, reviewer, issue, round, error, workerModel, soldierDispatch,
    });
    if (!built.ok) return built;
    return writeReviewPending({ dir: reviewPendingDir({ root: ROOT }), ticket: built.ticket });
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

function reviewerFetchCwd({ parentSel, worktrees } = {}) {
  if (parentSel && Array.isArray(worktrees)) {
    const wt = findWorktreeBySel(worktrees, parentSel);
    if (wt?.path) return wt.path;
  }
  return ROOT;
}

/** #826：身份消息带 --from；失败不回滚，只记红项。 */
function deliverReviewerIdentity({ soldierDispatchId, reviewerDispatchId, hop, body, from, fallbackHandle, worktreeId } = {}) {
  if (!soldierDispatchId) {
    return { ok: true, skipped: true, reason: '士兵 dispatch 已结算或不在，跳过身份投递（#799）' };
  }
  let terminals = null;
  let listedOk = true;
  let listedError = null;
  if (!String(from || '').trim() && !String(fallbackHandle || '').trim()) {
    const listed = orca(argsTerminalList({ worktree: worktreeId }));
    listedOk = listed.ok;
    listedError = listed.ok ? null : errText(listed.error);
    terminals = listed.ok ? (listed.json?.result?.terminals || listed.json?.terminals) : null;
  }
  const sender = listedOk
    ? resolveIdentitySender({ explicitFrom: from, fallbackHandle, terminals, worktreeId })
    : { ok: false, unscanned: true, error: `terminal list 没查成：${listedError}` };
  const identity = deliverMessage({
    to: `dispatch:${soldierDispatchId}`,
    subject: `审官身份：${reviewerDispatchId}`,
    body: body || `你的审官 dispatch id = ${reviewerDispatchId}（士兵→审官 完工通知 --to dispatch:<这个 id>）。
先收这封信记下它，再发完工通知；收不到就 escalation，不许手抄/猜。`,
    hop,
    from: sender.ok ? sender.from : undefined,
    orca: (a) => orca(a),
  });
  if (identity.ok) return { ...identity, sender };
  const keep = planIdentityKeep({ identityOk: false, identityError: identity.error });
  console.error(`[dao] ${keep.warning}`);
  return {
    ok: false,
    identityFailed: true,
    keep: true,
    rollback: false,
    warning: keep.warning,
    error: identity.error,
    sender,
    hop,
  };
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
  pr, reviewerWorktreeId, handle, parentWorktree, soldierDispatch, reviewer, dryRun, issue, from,
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

  let foundDispatch = null;
  let runId = null;
  if (parentWorktree) {
    const wl = orca(argsWorkerList());
    if (!wl.ok) {
      foundDispatch = { ok: false, unscanned: true, error: `worker-list 没查成：${errText(wl.error)}` };
    } else {
      foundDispatch = findDispatchForWorktree(wl.json, parentWorktree, resolveDispatchLastFailure);
      if (foundDispatch.ok) runId = foundDispatch.runId || null;
    }
  } else if (!soldierDispatch) {
    foundDispatch = { ok: false, error: '没给 --soldier-dispatch 或 --parent-worktree' };
  }
  const probeId = String(soldierDispatch || '').trim()
    || (foundDispatch && foundDispatch.ok ? String(foundDispatch.dispatchId || '').trim() : '');
  let dispatchLive = null;
  if (probeId) {
    const shown = orca(argsWorkerShow({ dispatch: probeId }));
    if (shown.ok) {
      const d = shown.json?.result?.dispatch || {};
      const w = shown.json?.result?.worker || {};
      dispatchLive = isLiveDispatchRecipient({
        workerState: w.state || d.status,
        dispatchStatus: d.status,
        lastFailure: d.last_failure,
      });
      if (!runId) runId = d.run_id || d.runId || null;
    }
  }
  const soldierPlan = planCreateSoldierDispatch({
    explicitDispatch: soldierDispatch,
    found: foundDispatch,
    dispatchLive: probeId ? dispatchLive : undefined,
  });
  if (!soldierPlan.ok) {
    return { ok: false, reused: true, error: soldierPlan.error, found: foundDispatch, soldierPlan };
  }
  const soldierDispatchId = soldierPlan.soldierDispatchId || '';
  if (soldierPlan.deadWarning) console.error(`[dao] 注意：${soldierPlan.deadWarning}`);

  const policyPlan = lookupReviewerMergePolicy({
    issue,
    pr,
    dispatchId: soldierDispatchId || probeId || null,
    worktreeSel: parentWorktree,
  });
  if (!policyPlan.ok) return { ok: false, reused: true, error: policyPlan.error, policyPlan };

  let reviewerBook;
  try {
    reviewerBook = encodeSendText(buildReviewerInject({
      spec: `复用审官终端审 PR #${pr}`,
      pr: String(pr),
      soldierDispatchId,
      mergePolicy: policyPlan.mergePolicy,
      mergeReason: policyPlan.mergeReason,
      fallbackReason: policyPlan.fallbackReason,
    }), reviewer);
  } catch (e) {
    return { ok: false, reused: true, error: `复用审官任务书渲染失败: ${String(e.message || e)}` };
  }

  const station = bindStation();
  if (!station.ok) return { ok: false, reused: true, error: station.error };
  if (!runId) runId = station.runId || null;
  if (!runId) {
    return { ok: false, reused: true, error: '复用审官没拿到士兵 run id，task-create 会 run_required（没查成）' };
  }
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

  // routing/launch 提前解析：startOrcaWorker 的 codex 补回车兜底（#785）要靠 launch.provider
  // 判断走不走，复用路原来只传 { handle }，provider 拿不到 → codex 审官卡 [Pasted Content] 不补。
  let routing;
  try { routing = loadRouting(); }
  catch (e) { return { ok: false, reused: true, error: String(e.message || e) }; }
  let launch;
  try { launch = resolveLaunch({ model: reviewer, routing, root: ROOT }); }
  catch { launch = { provider: 'gpt' }; }

  const revStarted = startOrcaWorker({
    task: reviewerTaskId,
    worktree: reviewerWorktreeId,
    launched: { handle, launch },
    run: runId,
    book: reviewerBook,
  });
  if (!revStarted.ok) {
    return { ok: false, reused: true, error: `复用审官 worker-start 失败: ${revStarted.error}（必须带 --worktree 指审官树）` };
  }
  const reviewerDispatchId = revStarted.dispatchId;
  if (!reviewerDispatchId) {
    return { ok: false, reused: true, error: '复用审官 worker-start 没拿到 dispatch id（没查成，不是已开工）' };
  }

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

  const identity = deliverReviewerIdentity({
    soldierDispatchId,
    reviewerDispatchId,
    hop: 'worker-done→士兵（复用审官身份）',
    body: `复用原审官终端。新 dispatch id = ${reviewerDispatchId}（士兵→审官 完工通知 --to dispatch:<这个 id>）。`,
    from,
    worktreeId: reviewerWorktreeId,
  });

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
      pr: plan.pr,
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
        from: args.from,
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
        issue: plan.issue,
        from: args.from,
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
  // PR #758：完工评论幂等——重试不重发（同款已发过就跳过），每个副作用先查「做过了没」。
  const postedIssue = postCommentOnce({ kind: 'issue', number: plan.issue, body: plan.comment, runGh: gh });
  if (!postedIssue.ok) fail(postedIssue.error, { ...plan, postedIssue, reuse });
  const postedPr = postCommentOnce({ kind: 'pr', number: plan.pr, body: plan.comment, runGh: gh });
  if (!postedPr.ok) fail(postedPr.error, { ...plan, postedIssue, postedPr, reuse });

  if (shouldCreate) {
    const seat = assertReviewerSeat({ reviewerId: plan.reviewer, routing: routingDone });
    if (!seat.ok) fail(seat.error, { reviewerSeat: seat, ...plan, reuse });
    const createOpts = {
      pr: args.pr,
      name: createName,
      parentWorktree: parentId,
      soldierDispatch: args.soldierDispatch,
      issue: plan.issue,
      reviewer: plan.reviewer,
      from: args.from,
      dryRun: false,
    };
    create = invokeReviewerCreate(createOpts);
    create = healReviewerCreateAfterFence(create, createOpts);
    if (create.ok) {
      create = { ...create, reviewer: plan.reviewer };
    } else {
      const stop = planReviewerCreateAfterFail({ error: create.error });
      const cls = classifyReviewerSpawnError(create.error);
      const failBody = reviewerSpawnFailComment({ error: create.error, retried: true });
      postIssueComment({ issue: plan.issue, body: failBody, runGh: gh });
      postPrComment({ pr: plan.pr, body: failBody, runGh: gh });
      if (parentId) {
        setWorkerCardProgress(parentId, '交卷了，审官没起来', reuseInputs.worktrees);
      }
      const reviewPending = writeReviewPendingOnFail({
        pr: plan.pr, parentId, reviewer: plan.reviewer, issue: plan.issue,
        round: plan.round, error: create.error, workerModel: plan.workerModel,
        soldierDispatch: args.soldierDispatch, runGh: gh,
      });
      fail(stop.error, {
        ...plan, commentPosted: true, postedIssue, postedPr,
        reviewerCreate: create, reuse, spawnKind: cls.kind,
        switchVendor: false, outcome: 'stop', reviewPending,
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
      issue: plan.issue,
      from: args.from,
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
        issue: plan.issue,
        from: args.from,
        dryRun: false,
      });
      // 2026-08-23 拍板：信箱台 ensure 挪出 dao 全路——保活归 guard-keepalive。
      const ensured = { ok: true, skipped: true, reason: 'ensure 已挪出 dao（信箱台保活归 guard-keepalive）' };
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
        issue: plan.issue,
        from: args.from,
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
          setWorkerCardProgress(parentId, '交卷了，审官没起来', reuseInputs.worktrees);
        }
        const reviewPending = writeReviewPendingOnFail({
          pr: plan.pr, parentId, reviewer: plan.reviewer, issue: plan.issue,
          round: plan.round, error: reused.error, workerModel: plan.workerModel,
          soldierDispatch: args.soldierDispatch, runGh: gh,
        });
        fail(`复用审官失败，禁止回退已结算 dispatch（#552）：${reused.error}`, {
          ...plan, commentPosted: true, postedIssue, postedPr,
          reviewerCreate: create, reviewerReuse: { ...reused, invoked: true, reuseFailed: true, retried: true }, reuse,
          spawnKind: cls.kind, reviewPending,
        });
      }
    }
  } else if (reuse.action === 'refuse') {
    const refuseErr = reuse.error || reuse.reason || '已有审官树/审官卡，拒绝新建';
    const failBody = reviewerSpawnFailComment({ error: refuseErr, retried: false });
    postIssueComment({ issue: plan.issue, body: failBody, runGh: gh });
    postPrComment({ pr: plan.pr, body: failBody, runGh: gh });
    if (parentId) {
      setWorkerCardProgress(parentId, '交卷了，审官没起来', reuseInputs.worktrees);
    }
    const reviewPending = writeReviewPendingOnFail({
      pr: plan.pr, parentId, reviewer: plan.reviewer, issue: plan.issue,
      round: plan.round, error: refuseErr, workerModel: plan.workerModel,
      soldierDispatch: args.soldierDispatch, runGh: gh,
    });
    fail(refuseErr, {
      ...plan, commentPosted: true, postedIssue, postedPr,
      outcome: 'refused-existing', reuse, reviewerCreate: create, reviewPending,
    });
  }

  let existingDispatchId = null;
  const needExisting = !((create && create.reviewerDispatchId) || (reused && reused.reviewerDispatchId));
  if (needExisting && reuse.worktreeId) {
    const wl = orca(argsWorkerList());
    if (!wl.ok) fail(`已有审官树但 worker-list 没查成：${errText(wl.error)}`, { ...plan, reviewerCreate: create, reviewerReuse: reused });
    const found = findDispatchForWorktree(wl.json, reuse.worktreeId, resolveDispatchLastFailure);
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
    setWorkerCardProgress(parentId, '待终审', reuseInputs.worktrees);
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
  noteDroppedFlags(launch);
  const startTrace = daoTraceFor({ role: 'shuai', model: args.model || launch.provider, fallback: 'start' });
  if (shouldPrefixDaoTrace(launch)) {
    launch = applyDaoTraceToLaunch(launch, startTrace);
  }

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
    daoTrace: startTrace,
  });
  if (!created.ok) fail(created.error, { command: launch.command });
  const handle = created.handle;
  if (!handle) fail('没拿到终端 handle', { command: launch.command });

  // dao start = 裸起 TUI 的调试命令，存在意义就是验就绪：保留通用 waitAndVerify 探针。
  // （派工主路已 fire-and-forget，不走这里。）
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

/** #826：PR 已合 + 审官已 approve → worktree-rm 豁免 working 占用。没查成 ≠ 可归档。 */
function lookupArchiveWaiver(worktrees, selector) {
  const found = resolveWorktreeSelector(worktrees, selector);
  if (!found.ok) return { ok: false, unscanned: false, merged: false, approved: false, error: found.error };
  const pr = prNumberFromWorktree(found.worktree);
  if (!pr) return { ok: false, unscanned: false, merged: false, approved: false, error: '卡上读不到 PR 号，占用豁免不做' };
  const gh = ghRunner();
  const view = gh(['pr', 'view', String(pr), '--json', 'state,reviews']);
  if (!view.ok) {
    return { ok: false, unscanned: true, merged: false, approved: false, error: `gh 读 PR #${pr} 失败：${view.error}` };
  }
  let json;
  try { json = JSON.parse(view.out); }
  catch {
    return { ok: false, unscanned: true, merged: false, approved: false, error: `gh 读 PR #${pr} 不是 JSON` };
  }
  const merged = String(json?.state || '').toUpperCase() === 'MERGED';
  const reviews = Array.isArray(json?.reviews) ? json.reviews : null;
  if (!Array.isArray(json?.reviews)) {
    return { ok: false, unscanned: true, merged, approved: false, error: `gh 读 PR #${pr} 缺 reviews 数组` };
  }
  const approved = reviews.some((r) => {
    const s = String(r?.state || r?.verdict || '').toUpperCase();
    return s === 'APPROVED' || s === 'APPROVE';
  });
  return { ok: true, unscanned: false, pr, merged, approved };
}

function cmdWorktreeRm(args) {
  if (!args.worktree) fail('worktree-rm 要 --worktree');
  const listed = orca(argsWorktreePs());
  if (!listed.ok) fail(`盘面没查成，未删任何树: ${errText(listed.error)}`);
  const wts = listed.json?.result?.worktrees;
  if (!Array.isArray(wts)) fail('worktree ps 没有 result.worktrees，未删任何树');
  const archive = lookupArchiveWaiver(wts, args.worktree);
  // 账本孤本闸的对照集合 = 本机账本（~/.dao/ledger/events，ledger 本机化后事件不进任何 git 树）
  const plan = prepareWorktreeRm(wts, args.worktree, {
    mainEventsDir: ensureLocalLedger({ root: ROOT }).dir,
    archive,
  });
  if (!plan.ok) fail(plan.error, { occupied: plan.occupied || [], stray: plan.stray || [], archive });
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

async function cmdReviewerCreate(args) {
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
  const seat = assertReviewerSeat({ reviewerId: picked.modelId, routing });
  if (!seat.ok) fail(seat.error, { reviewerSeat: seat, vendorGate, pr: String(args.pr) });

  // #842 派前探一针：审官起终端前，按顺位（同厂闸不放宽）逐位真探，红换下一位，全红报帅停手。
  // 换位由探红授权（顺位内换、异厂），下游用 reviewerModel；seat 锁只管「请求位=Codex」。
  // dry-run 是纯规划（只打印选型不建树），不探网络——审官 preflight 只在真起时生效（判据是工人侧）。
  let reviewerModel = picked.modelId;
  let reviewerPreflight = null;
  if (!args.dryRun) {
    try {
      reviewerPreflight = await preflightReviewer({
        order: routing.reviewerOrder || [], models: routing.models || [],
        workerId: worker.modelId, noPreflight: args.noPreflight === true, dispatchId: null,
      });
      if (reviewerPreflight.stop) {
        fail(`派前探一针：审官候选全红/全拦，停手报帅（一个审官都不起）。\n${reviewerPreflight.report || ''}`, { reviewerPreflight, vendorGate, pr: String(args.pr) });
      }
      if (reviewerPreflight.chosen) reviewerModel = reviewerPreflight.chosen;
    } catch (e) {
      console.error(`[dao] 审官派前探异常（放行原路起）：${String(e.message || e)}`);
    }
  }

  const revName = assembleCardName({
    name: args.name || reviewerCardName(reviewerModel),
    pr: args.pr,
    role: '审官',
    model: reviewerModel,
  });
  const plan = {
    pr: String(args.pr),
    baseBranch,
    expectedOid,
    files,
    name: revName,
    mergeable,
    reviewer: reviewerModel,
    reviewerRequested: picked.modelId,
    reviewerSource: picked.source,
    workerModel: worker.modelId,
    vendorGate,
    reviewerSeat: seat,
    reviewerPreflight,
  };

  const inputs = loadReviewerReuseInputs();
  const oneReviewerGate = inputs.ok
    ? gateReviewerCreate({
      pr: args.pr,
      parentId: args.parentWorktree,
      worktrees: inputs.worktrees,
      workers: inputs.workers,
      terminals: inputs.terminals,
    })
    : { ok: false, outcome: 'unscanned', unscanned: true, error: inputs.error };

  if (args.dryRun) emit({ ok: true, dryRun: true, ...plan, oneReviewerGate });

  if (oneReviewerGate.outcome === 'unscanned') {
    fail(oneReviewerGate.error, { outcome: 'unscanned', oneReviewerGate, ...plan });
  }
  if (oneReviewerGate.outcome === 'reused') {
    emit({
      ok: true,
      outcome: 'reused',
      reused: true,
      reviewerId: oneReviewerGate.worktreeId,
      reviewerHandle: oneReviewerGate.handle,
      oneReviewerGate,
      reason: oneReviewerGate.reason,
      ...plan,
    });
  }
  // PR #758：半成功卡（建了卡没起成、终端已关）不再「拒绝新建」死循环——复用该卡续跑：
  // 跳过 worktree create，校验/起终端/注入照跑。续跑失败不删已有卡（只关本次起的终端）。
  let resumedFromExisting = false;
  let reviewerId = null;
  let reviewerPath = null;
  if (oneReviewerGate.outcome === 'refused-existing') {
    if (!oneReviewerGate.worktreeId || !oneReviewerGate.worktreePath) {
      fail(oneReviewerGate.error, {
        outcome: 'refused-existing',
        oneReviewerGate,
        reviewerId: oneReviewerGate.worktreeId,
        ...plan,
      });
    }
    resumedFromExisting = true;
    reviewerId = oneReviewerGate.worktreeId;
    reviewerPath = oneReviewerGate.worktreePath;
  }

  const fetchCwd = reviewerFetchCwd({
    parentSel: args.parentWorktree,
    worktrees: inputs.ok ? inputs.worktrees : null,
  });
  let originRef = prepareReviewerOriginRef({ branch: baseBranch, expectedOid, cwd: fetchCwd });
  if (!originRef.ok) fail(originRef.error, { originRef, ...plan });
  plan.baseBranch = originRef.baseBranch;
  plan.originOid = originRef.originOid;

  if (!resumedFromExisting) {
    const created = orca(argsWorktreeCreate({
      name: revName,
      setup: 'skip',
      parentWorktree: args.parentWorktree,
      baseBranch: originRef.baseBranch,
      issue: args.issue,
      comment: args.comment,
    }));
    if (!created.ok) fail(`审官卡创建失败: ${errText(created.error)}`, plan);
    reviewerId = extractWorktreeId(created.json);
    reviewerPath = extractWorktreePath(created.json);
    if (!reviewerId || !reviewerPath) fail('审官卡没返回 id/path', { ...plan, reviewerId, reviewerPath });
  } else {
    originRef = checkoutOriginRef({ cwd: reviewerPath, branch: baseBranch, expectedOid });
    if (!originRef.ok) fail(originRef.error, { originRef, reviewerId, reviewerPath, ...plan });
    plan.originOid = originRef.originOid;
  }

  // PR #758：续跑已有卡时，校验/启动失败不删卡（卡是半成功的现场，删了下轮还是
  // 「已有但起不来」；留着才能再续）。新建卡失败照旧删（不留半成品）。
  const rmReviewerCard = () => {
    if (!resumedFromExisting) orca(argsWorktreeRm({ worktree: reviewerId, force: true }));
  };

  const env = envProbeWorktree(reviewerPath);
  if (!env.ok) {
    rmReviewerCard();
    fail(`审官树环境自检失败: ${env.error}`, { ...plan, reviewerId, reviewerPath, probes: env, resumedFromExisting });
  }
  const heads = verifyReviewerTree({ reviewerPath, expectedOid, originOid: originRef.originOid });
  if (!heads.ok) {
    rmReviewerCard();
    fail(heads.error, { ...plan, reviewerId, reviewerPath, heads, originRef, resumedFromExisting });
  }
  const filesOk = verifyReviewerFiles({ reviewerPath, files });
  if (!filesOk.ok) {
    rmReviewerCard();
    fail(filesOk.error, { ...plan, reviewerId, reviewerPath, files: filesOk, resumedFromExisting });
  }
  const align = trialMergeMaster({ cwd: reviewerPath });
  if (!align.ok) {
    rmReviewerCard();
    fail(`对齐 master 试合失败: ${align.error}`, { ...plan, reviewerId, reviewerPath, align, resumedFromExisting });
  }

  // #586 阶段二：既有坑（mergeable / HEAD / 试合）不动，后面补起终端 + 注入。
  let reviewerLaunch;
  try {
    reviewerLaunch = resolveLaunch({ model: reviewerModel, routing, root: ROOT });
  } catch (e) {
    rmReviewerCard();
    fail(String(e.message || e), { ...plan, reviewerId, reviewerPath });
  }
  noteDroppedFlags(reviewerLaunch);
  const cap = assertCodexLaunch({ command: reviewerLaunch.command });
  if (!cap.ok) {
    rmReviewerCard();
    fail(cap.error, { ...plan, reviewerId, reviewerPath });
  }

  // 续跑：launched 不带 reviewerId——failCreated 的回滚只关本次起的终端，不删已有卡。
  const launched = resumedFromExisting
    ? { reviewerHandle: null }
    : { reviewerId, reviewerHandle: null };
  const revTerm = launchAgentInWorktree({
    worktreeId: reviewerId,
    title: revName,
    command: reviewerLaunch.command,
    launch: reviewerLaunch,
    daoTrace: daoTraceFor({
      role: 'reviewer',
      model: reviewerModel,
      issue: args.issue || (Array.isArray(worker.refs) && worker.refs[0]) || null,
      pr: args.pr,
    }),
  });
  if (!revTerm.ok) {
    rmReviewerCard();
    fail(`审官终端创建失败: ${revTerm.error}`, { ...plan, reviewerId, reviewerPath, resumedFromExisting });
  }
  launched.reviewerHandle = revTerm.handle;
  if (!revTerm.deferred && !launched.reviewerHandle) {
    rmReviewerCard();
    fail('审官终端没返回 handle', { ...plan, reviewerId, reviewerPath, resumedFromExisting });
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

  let foundDispatch = null;
  let soldierRunId = null;
  if (args.parentWorktree) {
    const wl = orca(argsWorkerList());
    if (!wl.ok) {
      foundDispatch = { ok: false, unscanned: true, error: `worker-list 没查成：${errText(wl.error)}` };
    } else {
      foundDispatch = findDispatchForWorktree(wl.json, args.parentWorktree, resolveDispatchLastFailure);
      if (foundDispatch.ok) soldierRunId = foundDispatch.runId || null;
    }
  } else if (!args.soldierDispatch) {
    foundDispatch = { ok: false, error: '没给 --soldier-dispatch 或 --parent-worktree' };
  }
  const probeId = String(args.soldierDispatch || '').trim()
    || (foundDispatch && foundDispatch.ok ? String(foundDispatch.dispatchId || '').trim() : '');
  let dispatchLive = null;
  if (probeId) {
    const shown = orca(argsWorkerShow({ dispatch: probeId }));
    if (shown.ok) {
      const d = shown.json?.result?.dispatch || {};
      const w = shown.json?.result?.worker || {};
      dispatchLive = isLiveDispatchRecipient({
        workerState: w.state || d.status,
        dispatchStatus: d.status,
        lastFailure: d.last_failure,
      });
      if (!soldierRunId) soldierRunId = d.run_id || d.runId || null;
    }
  }
  const soldierPlan = planCreateSoldierDispatch({
    explicitDispatch: args.soldierDispatch,
    found: foundDispatch,
    dispatchLive: probeId ? dispatchLive : undefined,
  });
  if (!soldierPlan.ok) failCreated(launched, soldierPlan.error, { found: foundDispatch, soldierPlan, ...plan });
  const soldierDispatchId = soldierPlan.soldierDispatchId || '';
  if (soldierPlan.deadWarning) console.error(`[dao] 注意：${soldierPlan.deadWarning}`);
  if (!soldierRunId && soldierDispatchId) soldierRunId = runIdFromDispatch(soldierDispatchId);

  const policyPlan = lookupReviewerMergePolicy({
    explicitPolicy: args.mergePolicy,
    explicitReason: args.mergeReason,
    issue: args.issue,
    pr: args.pr,
    dispatchId: soldierDispatchId || probeId || null,
    worktreeSel: args.parentWorktree,
    worktrees: inputs.ok ? inputs.worktrees : undefined,
  });
  if (!policyPlan.ok) failCreated(launched, policyPlan.error, { policyPlan, ...plan });

  let reviewerBook = null;
  try {
    reviewerBook = encodeSendText(buildReviewerInject({
      spec: `按审官任务书审 PR #${args.pr}`,
      issue: args.issue,
      pr: String(args.pr),
      soldierDispatchId,
      mergePolicy: policyPlan.mergePolicy,
      mergeReason: policyPlan.mergeReason,
      fallbackReason: policyPlan.fallbackReason,
    }), reviewerLaunch.provider);
  } catch (e) {
    failCreated(launched, `审官任务书渲染失败: ${String(e.message || e)}`, plan);
  }

  // #762：detached 起审官同工人路——起「派工协调（勿关）」哑终端当 coordinator，
  // run-create --from 它，worker-start 带 --from + wait tui-idle（command 型 TUI 就绪即送）。
  // bindStation 自开 Run 在 detached 无 coordinator 终端，worker-start 会 no_active_sender/consumer_fenced。
  const revCoordTerm = orca(argsTerminalCreate({ worktree: reviewerId, title: '派工协调（勿关）' }));
  if (!revCoordTerm.ok) failCreated(launched, `审官协调终端没建成：${errText(revCoordTerm.error)}`, plan);
  const revCoordHandle = extractHandleFromCreate(revCoordTerm.json);
  if (!revCoordHandle) failCreated(launched, '审官协调终端没返回 handle（没查成）', plan);
  launched.reviewerCoordHandle = revCoordHandle;
  launched.handles = [...(Array.isArray(launched.handles) ? launched.handles : []), revCoordHandle];
  const revCoordRun = orca(argsRunCreate({ objective: 'coordinator: dao review', from: revCoordHandle }));
  if (!revCoordRun.ok) failCreated(launched, `审官协调 Run 没建成（--from 哑终端）：${errText(revCoordRun.error)}`, plan);
  const revRunId = extractRunId(revCoordRun.json);
  if (!revRunId) failCreated(launched, '审官协调 Run 没拿到 id（没查成）', plan);

  // #762：wait 按「实际 command 型起的」（revTerm 非 deferred 且给了 handle），不按 launch.start——
  // codex 配 start=agent 但 launchAgentInWorktree 常退成 command 型（有 handle），冷启动要等就绪。
  if (!revTerm.deferred && launched.reviewerHandle) {
    const ready = orca(argsTerminalWait({ terminal: launched.reviewerHandle, for: 'tui-idle', timeoutMs: probeWaitMs(routing, reviewerLaunch.provider) }));
    if (!ready.ok) failCreated(launched, `审官 TUI 等就绪失败：${errText(ready.error)}`, plan);
  }

  const revTask = taskCreateOnRun(reviewerBook, revRunId, { rebindSelf: true, from: revCoordHandle });
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
    run: revRunId,
    from: revCoordHandle,
    book: reviewerBook,
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

  const identity = deliverReviewerIdentity({
    soldierDispatchId,
    reviewerDispatchId,
    hop: 'reviewer-create→士兵（审官身份）',
    from: args.from,
    fallbackHandle: launched.reviewerCoordHandle || revCoordHandle,
    worktreeId: reviewerId,
  });

  let ledger = null;
  try {
    const ctx = loadLedgerContext({ root: ROOT });
    ledger = writeJobDispatch({
      ...ctx,
      ts: beijingIsoFrom(new Date()),
      jobId: reviewerJobId(args.pr),
      model: reviewerModel,
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
    outcome: resumedFromExisting ? 'resumed' : 'created',
    resumedFromExisting,
    ...plan,
    reviewerId,
    reviewerPath,
    reviewerHandle: launched.reviewerHandle,
    reviewerDispatchId,
    reviewerTaskId,
    soldierDispatchId,
    soldierPlan,
    mergePolicy: policyPlan.mergePolicy,
    mergeReason: policyPlan.mergeReason,
    mergePolicySource: policyPlan.source,
    heads,
    filesChecked: filesOk.checked,
    probes: env,
    align,
    inject: reviewerInject,
    startProof: reviewerProof,
    identity,
    identityFailed: !!identity.identityFailed,
    ledger,
    oneReviewerGate,
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

  const routing = loadOrFail();
  let reviewerLaunch;
  try {
    reviewerLaunch = resolveLaunch({ model: args.reviewer, routing, root: ROOT });
  } catch (e) { fail(String(e.message || e)); }
  noteDroppedFlags(reviewerLaunch);
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

  const worker = resolveWorkerFromPr({ pr: args.pr, runGh: gh, model: args.model });
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

  const trees = wtList.ok ? (wtList.json?.result?.worktrees || wtList.json?.worktrees) : undefined;
  const policyPlan = lookupReviewerMergePolicy({
    explicitPolicy: args.mergePolicy,
    explicitReason: args.mergeReason,
    issue: args.issue || (Array.isArray(worker.refs) ? worker.refs[0] : null),
    pr: args.pr,
    dispatchId: args.soldierDispatch || null,
    worktreeSel: args.worktree,
    worktrees: trees,
  });
  if (!policyPlan.ok) fail(policyPlan.error, { policyPlan, pr: String(args.pr) });

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
    mergePolicy: policyPlan.mergePolicy,
    mergeReason: policyPlan.mergeReason || null,
    mergePolicySource: policyPlan.source,
    fallbackReason: policyPlan.fallbackReason || null,
    launch: reviewerLaunch.command,
    mergeable,
    workerModel: worker.modelId,
    vendorGate,
    treeVerified,
  };
  const wlReuse = orca(argsWorkerList());
  const workersForReuse = wlReuse.ok ? unwrapWorkers(wlReuse.json) : null;
  const parentWt = Array.isArray(trees) ? findWorktreeBySel(trees, args.worktree) : null;
  const cardsForReuse = collectReviewerCardsForPr({
    pr: args.pr,
    parentId: parentWt?.id || args.worktree,
    worktrees: trees,
    workers: workersForReuse,
  });
  let reusePlan = planReviewerAttachReuse({
    cards: cardsForReuse,
    workers: workersForReuse,
    workerRead: null,
  });
  if (reusePlan.action === 'probe') {
    const wrReuse = orca(argsWorkerRead({ dispatch: reusePlan.dispatchId, source: 'auto' }));
    reusePlan = planReviewerAttachReuse({
      cards: cardsForReuse,
      workers: workersForReuse,
      workerRead: wrReuse.ok ? wrReuse : { ok: false, unscanned: true, error: errText(wrReuse.error) },
    });
  }
  plan.reusePlan = reusePlan;
  if (args.dryRun) emit({ ok: true, dryRun: true, ...plan });

  if (!reusePlan.ok) fail(reusePlan.error, { reusePlan, ...plan });

  if (reusePlan.action === 'reuse') {
    const reused = reuseReviewerOnTerminal({
      pr: args.pr,
      reviewerWorktreeId: reusePlan.worktreeId,
      handle: reusePlan.handle,
      parentWorktree: args.worktree,
      soldierDispatch: args.soldierDispatch,
      reviewer: args.reviewer,
      issue: args.issue || (Array.isArray(worker.refs) ? worker.refs[0] : null),
      from: args.from,
      dryRun: false,
    });
    if (!reused.ok) fail(reused.error, { reused, reusePlan, ...plan });
    emit({ ok: true, reused: true, reusePlan, ...plan, ...reused });
  }

  // #815：不活或已结算 → 新建树。建树前 fetch origin/<分支>，按远端检出。
  const originRef = prepareReviewerOriginRef({
    branch: baseBranch,
    expectedOid,
    cwd: reviewerFetchCwd({ parentSel: args.worktree, worktrees: trees }),
  });
  if (!originRef.ok) fail(originRef.error, { originRef, ...plan });
  plan.baseBranch = originRef.baseBranch;
  plan.originOid = originRef.originOid;

  const created = {};
  const revWt = orca(argsWorktreeCreate({
    name: revName,
    setup: 'skip',
    parentWorktree: args.worktree,
    baseBranch: originRef.baseBranch,
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

  const heads = verifyReviewerTree({
    reviewerPath: created.reviewerPath,
    expectedOid,
    originOid: originRef.originOid,
  });
  if (!heads.ok) failCreated(created, heads.error, { heads, originRef, ...plan });

  const filesOk = verifyReviewerFiles({ reviewerPath: created.reviewerPath, files });
  if (!filesOk.ok) failCreated(created, filesOk.error, { files: filesOk, ...plan });

  const align = trialMergeMaster({ cwd: created.reviewerPath });
  if (!align.ok) failCreated(created, `对齐 master 试合失败: ${align.error}`, { align, ...plan });

  const revTerm = launchAgentInWorktree({
    worktreeId: created.reviewerId,
    title: revName,
    command: reviewerLaunch.command,
    launch: reviewerLaunch,
    daoTrace: daoTraceFor({
      role: 'reviewer',
      model: args.reviewer,
      issue: args.issue || (Array.isArray(worker.refs) && worker.refs[0]) || null,
      pr: args.pr,
    }),
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
      if (wl.ok) foundDispatch = findDispatchForWorktree(wl.json, args.worktree, resolveDispatchLastFailure);
    }
    const probeId = soldierDispatchId || (foundDispatch?.ok ? foundDispatch.dispatchId : null);
    let dispatchLive = null;
    if (probeId) {
      const shown = orca(argsWorkerShow({ dispatch: probeId }));
      if (shown.ok) {
        const d = shown.json?.result?.dispatch || {};
        const w = shown.json?.result?.worker || {};
        dispatchLive = isLiveDispatchRecipient({ workerState: w.state || d.status, dispatchStatus: d.status, lastFailure: d.last_failure });
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
        mergePolicy: policyPlan.mergePolicy,
        mergeReason: policyPlan.mergeReason,
        fallbackReason: policyPlan.fallbackReason,
        skipWait: soldierPlan?.skipWait || false,
      }), reviewerLaunch.provider);
  } catch (e) {
    failCreated(created, `审官任务书渲染失败: ${String(e.message || e)}`, plan);
  }

  // #682 微通道：quick-fix 的异步 attach 是 detached 进程，bindStation 自开的 Run 没有
  // coordinator 终端，worker-start 会 consumer_fenced/no_active_sender。微通道子进程显式
  // --run（--from 信箱台建的 Run，coordinator 是常驻信箱台）已通；没给 --run 的 detached
  // 补审官照 #762 起哑终端 + run-create --from（与工人路同源）。
  let reviewerRunId = args.run ? String(args.run).trim() : null;
  let reviewerFrom = null;
  if (!reviewerRunId) {
    const revCoordTerm = orca(argsTerminalCreate({ worktree: created.reviewerId, title: '派工协调（勿关）' }));
    if (!revCoordTerm.ok) failCreated(created, `审官协调终端没建成：${errText(revCoordTerm.error)}`, plan);
    const revCoordHandle = extractHandleFromCreate(revCoordTerm.json);
    if (!revCoordHandle) failCreated(created, '审官协调终端没返回 handle（没查成）', plan);
    created.reviewerCoordHandle = revCoordHandle;
    created.handles = [...(Array.isArray(created.handles) ? created.handles : []), revCoordHandle];
    const revCoordRun = orca(argsRunCreate({ objective: 'coordinator: dao review', from: revCoordHandle }));
    if (!revCoordRun.ok) failCreated(created, `审官协调 Run 没建成（--from 哑终端）：${errText(revCoordRun.error)}`, plan);
    reviewerRunId = extractRunId(revCoordRun.json);
    if (!reviewerRunId) failCreated(created, '审官协调 Run 没拿到 id（没查成）', plan);
    reviewerFrom = revCoordHandle;
  }
  // #762：wait 按「实际 command 型起的」（revTerm 非 deferred 且给了 handle），不按 launch.start——
  // codex 配 start=agent 但 launchAgentInWorktree 常退成 command 型（有 handle），冷启动要等就绪。
  if (!revTerm.deferred && created.reviewerHandle && !args.skipWait) {
    const ready = orca(argsTerminalWait({ terminal: created.reviewerHandle, for: 'tui-idle', timeoutMs: probeWaitMs(routing, reviewerLaunch.provider) }));
    if (!ready.ok) failCreated(created, `审官 TUI 等就绪失败：${errText(ready.error)}`, plan);
  }
  const revTask = taskCreateOnRun(reviewerBook, reviewerRunId, { rebindSelf: true, from: reviewerFrom });
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
    from: reviewerFrom,
    book: reviewerBook,
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
    expect: reviewerExpectFingerprint(reviewerBook),
  });
  if (!reviewerInject.ok) {
    failCreated(created, `审官注入后开工验证失败: ${reviewerInject.reason}`, {
      ...plan, reviewerTaskId, reviewerInject,
    });
  }
  const reviewerProof = workerStartProof(created.reviewerDispatchId);

  const identity = deliverReviewerIdentity({
    soldierDispatchId,
    reviewerDispatchId: created.reviewerDispatchId,
    hop: '补派审官→士兵（审官身份）',
    from: args.from,
    fallbackHandle: created.reviewerCoordHandle || reviewerFrom,
    worktreeId: created.reviewerId,
  });

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
    identityFailed: !!(identity && identity.identityFailed),
    align,
  });
}

function cmdReviewerDone(args) {
  if (!args.pr) fail('reviewer-done 要 --pr');
  const gh = ghRunner({ role: 'reviewer' });
  const view = gh(['pr', 'view', String(args.pr), '--json', 'state,reviews']);
  if (!view.ok) fail(`gh 读 PR #${args.pr} 失败：${view.error}`);
  let json;
  try { json = JSON.parse(view.out); }
  catch { fail(`gh 读 PR #${args.pr} 不是 JSON`); }
  const prState = json?.state == null
    ? { ok: false, unscanned: true, error: `PR #${args.pr} 没给 state` }
    : { ok: true, state: json.state };
  const reviews = Array.isArray(json?.reviews)
    ? { ok: true, reviews: json.reviews, count: json.reviews.length }
    : { ok: false, unscanned: true, error: `PR #${args.pr} 缺 reviews 数组` };
  const plan = planReviewerDone({ pr: args.pr, prState, reviews });
  if (!plan.ok) fail(plan.error, plan);
  if (args.dryRun) emit({ ok: true, dryRun: true, ...plan });
  emit({
    ok: true,
    ...plan,
    settled: true,
    needsRunId: false,
    reason: plan.reason,
  });
}

function cmdReviewPendingDrain(args) {
  const dir = reviewPendingDir({ root: ROOT });
  const listed = listReviewPending(dir);
  if (!listed.ok) fail(listed.error, listed);
  const tickets = args.pr
    ? listed.tickets.filter(t => String(t.pr) === String(args.pr))
    : listed.tickets;
  if (args.dryRun) {
    emit({
      ok: true,
      dryRun: true,
      scanned: tickets.length,
      tickets,
      dir,
    });
  }
  const self = fileURLToPath(import.meta.url);
  const drained = drainReviewPending({
    dir,
    tickets,
    attach: (plan) => {
      const spawned = spawnSync(process.execPath, [self, ...plan.argv, '--json'], {
        encoding: 'utf8',
        cwd: ROOT,
        windowsHide: true,
        timeout: 600000,
      });
      let json = null;
      try { json = JSON.parse(String(spawned.stdout || '').trim().split(/\r?\n/).pop()); } catch { /* 非 JSON */ }
      if (spawned.error || (spawned.status !== 0 && spawned.status != null) || !json || json.ok !== true) {
        return {
          ok: false,
          error: (json && json.error)
            || String(spawned.stderr || spawned.error?.message || `reviewer-attach exit ${spawned.status}`).trim().slice(0, 400),
          json,
        };
      }
      return { ok: true, json };
    },
  });
  if (!drained.ok) fail(drained.error || 'review-pending-drain 未全部成功', drained);
  emit(drained);
}

function cmdSend(args) {
  if (args.text == null) fail('send 要 --text');
  let terminal = args.terminal || null;
  let resolved = null;
  if (args.dispatch) {
    const wr = orca(argsWorkerRead({ dispatch: args.dispatch, source: 'auto' }));
    resolved = resolveSendTarget({
      terminal: args.terminal,
      dispatch: args.dispatch,
      workerReadJson: wr.ok ? wr.json : null,
    });
    if (!resolved.ok) fail(resolved.error, { resolved, dispatch: args.dispatch });
    terminal = resolved.terminal;
  } else if (!terminal) {
    fail('send 要 --terminal 或 --dispatch');
  }
  const r = orca(argsTerminalSend({
    terminal,
    text: args.text,
    enter: args.enter,
    agent: args.agent,
  }));
  if (!r.ok) fail(`terminal send 失败: ${errText(r.error)}`);
  emit({ ok: true, json: r.json, terminal, dispatch: args.dispatch || null, resolved });
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

// ── 盘面存档 / 清盘（重测派单前用；存档只留本机，不进 git）──────────────

/** 全量采盘面：卡片/终端/workers/Run（分页扫全）/信箱。每节独立标 ok/没查成。 */
function collectBoardSnapshot() {
  const sections = {};
  const listed = orca(argsWorktreePs());
  if (!listed.ok) sections.worktrees = { ok: false, error: errText(listed.error) };
  else {
    const wts = listed.json?.result?.worktrees;
    sections.worktrees = Array.isArray(wts) ? { ok: true, data: wts } : { ok: false, error: 'worktree ps 没有 result.worktrees' };
  }
  const tl = orca(argsTerminalList());
  if (!tl.ok) sections.terminals = { ok: false, error: errText(tl.error) };
  else {
    const terms = tl.json?.result?.terminals;
    sections.terminals = Array.isArray(terms) ? { ok: true, data: terms } : { ok: false, error: 'terminal list 没有 result.terminals' };
  }
  const wl = orca(argsWorkerList());
  if (!wl.ok) sections.workers = { ok: false, error: errText(wl.error) };
  else {
    const workers = unwrapWorkers(wl.json);
    sections.workers = Array.isArray(workers) ? { ok: true, data: workers } : { ok: false, error: 'worker-list 没有 result.workers' };
  }
  const rl = listAllRuns();
  sections.runs = rl.ok ? { ok: true, data: rl.runs } : { ok: false, error: rl.error };
  const ib = orca(argsOrchestrationInbox({ limit: 80 }));
  if (!ib.ok) sections.inbox = { ok: false, error: errText(ib.error) };
  else {
    const messages = ib.json?.result?.messages;
    sections.inbox = Array.isArray(messages) ? { ok: true, data: messages } : { ok: false, error: 'inbox 没有 result.messages' };
  }
  const ok = Object.values(sections).every((s) => s.ok);
  return { ok, ts: new Date().toISOString(), sections };
}

function sectionCounts(sections) {
  return Object.fromEntries(Object.entries(sections).map(([k, s]) => [
    k, s.ok ? (Array.isArray(s.data) ? s.data.length : 0) : `没查成: ${s.error}`,
  ]));
}

function boardArchivePaths(args, ts) {
  const dir = String(args.out || '').trim() || join(homedir(), '.dao', 'board-archive');
  const stamp = String(ts).replace(/[:.]/g, '-');
  return { dir, jsonPath: join(dir, `board-${stamp}.json`), mdPath: join(dir, `board-${stamp}.md`) };
}

function writeBoardArchive(snap, args) {
  const paths = boardArchivePaths(args, snap.ts);
  mkdirSync(paths.dir, { recursive: true });
  writeFileSync(paths.jsonPath, JSON.stringify(snap, null, 2), 'utf8');
  writeFileSync(paths.mdPath, formatBoardArchiveMd(snap), 'utf8');
  return paths;
}

function cmdBoardArchive(args) {
  const snap = collectBoardSnapshot();
  let paths;
  try { paths = writeBoardArchive(snap, args); }
  catch (e) { fail(`存档写盘失败：${e.message || e}`); }
  const bad = Object.entries(snap.sections).filter(([, s]) => !s.ok).map(([k, s]) => `${k}: ${s.error}`);
  emit({
    ok: snap.ok,
    ...paths,
    sections: sectionCounts(snap.sections),
    ...(snap.ok ? {} : { error: `有 ${bad.length} 节没查成（存档已写并标 unscanned，≠ 扫完是空的）：${bad.join('；')}` }),
  }, snap.ok ? 0 : 1);
}

/** 清盘收尾 run-gc：卡删完后无在途树保护的 Run 退役。复用 cmdRunGc 的纯函数，不碰 coordinator（永不自动退）。 */
function boardResetGc() {
  const src = loadLifecycleInputs();
  if (!src.ok) return { ok: false, error: `收尾 run-gc 盘面没查成: ${src.error}` };
  const plan = planRunGc({ runs: src.runs, workers: src.workers, worktrees: src.worktrees });
  if (!plan.ok) return { ok: false, error: `收尾 run-gc 名单没查成: ${plan.error}` };
  const leaseExistsFor = (runId) => stationFilesFor(runId).some((f) => existsSync(f));
  const parts = partitionGcTargets(plan.retire, { leaseExistsFor });
  if (!parts.ok) return { ok: false, error: `收尾 run-gc 分桶没查成: ${parts.error}` };
  const results = parts.pending.map((r) => retireOneRun(r.id));
  const tallied = summarizeGcApply({ pendingResults: results, tombstones: parts.tombstones });
  return { ok: tallied.failedCount === 0, ...tallied };
}

function cmdBoardReset(args) {
  const snap = collectBoardSnapshot();
  if (!snap.ok) {
    const bad = Object.entries(snap.sections).filter(([, s]) => !s.ok).map(([k, s]) => `${k}: ${s.error}`);
    fail(`盘面没查成，未删任何树（${bad.join('；')}）`, { sections: sectionCounts(snap.sections) });
  }
  const planned = planBoardTargets(snap.sections.worktrees.data);
  if (!planned.ok) fail(planned.error);
  const mainEventsDir = ensureLocalLedger({ root: ROOT }).dir;
  // 逐卡过既有闸（占用 / 账本孤本 / 子卡齐不齐），dry-run 同样只读不改态
  const entries = planned.targets.map((t) => {
    const plan = prepareWorktreeRm(snap.sections.worktrees.data, t.id, { mainEventsDir });
    return plan.ok
      ? { id: t.id, name: t.name, plan }
      : { id: t.id, name: t.name, plan: null, reason: plan.error };
  });
  if (!args.apply) {
    emit({
      ok: true,
      dryRun: true,
      guarded: planned.guarded,
      remove: entries.filter((e) => e.plan).map((e) => ({ id: e.id, name: e.name, trees: e.plan.order.map((n) => n.id) })),
      skip: entries.filter((e) => !e.plan).map((e) => ({ id: e.id, name: e.name, reason: e.reason })),
    });
  }
  // --apply：先存档（写盘失败一张都不删），再逐卡整树删，最后收尾 run-gc
  let archive;
  try { archive = writeBoardArchive(snap, args); }
  catch (e) { fail(`清盘前存档写盘失败，未删任何树：${e.message || e}`); }
  const removed = [];
  const skipped = [];
  for (const e of entries) {
    if (!e.plan) { skipped.push({ id: e.id, name: e.name, reason: e.reason }); continue; }
    const applied = applyWorktreeRmPlan(e.plan, {
      rm: (node) => orca(argsWorktreeRm({ worktree: node.id, force: true })),
    });
    if (applied.ok) removed.push({ id: e.id, name: e.name, trees: applied.removed.map((n) => n.id) });
    else skipped.push({ id: e.id, name: e.name, reason: applied.error, partialRemoved: (applied.removed || []).map((n) => n.id) });
  }
  const gc = boardResetGc();
  const verdict = boardResetVerdict({ removed, skipped, gc });
  emit({ ok: verdict.ok, archive, removed, skipped, gc, line: verdict.line }, verdict.ok ? 0 : 1);
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

/** #842 派前探只读动词：探一个模型（同路径流式），输出与 ndjson 同形。一行分发到 lib/preflight.mjs。 */
async function cmdPreflight(args) {
  const routing = loadOrFail();
  const r = await runPreflightCommand(args, { routingModels: routing.models });
  if (!r.ok) fail(r.error, { model: args.model || null });
  emit({ ok: true, ...r });
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
    case 'dispatch-exec': return cmdDispatchExec(args);
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
    case 'reviewer-done': return cmdReviewerDone(args);
    case 'review-pending-drain': return cmdReviewPendingDrain(args);
    case 'send': return cmdSend(args);
    case 'notify': return cmdNotify(args);
    case 'reply': return cmdReply(args);
    case 'inbox-collect': return cmdInboxCollect(args);
    case 'run-gc': return cmdRunGc(args);
    case 'board-archive': return cmdBoardArchive(args);
    case 'board-reset': return cmdBoardReset(args);
    case 'ask': return cmdAsk(args);
    case 'gate-create': return cmdGateCreate(args);
    case 'gate-resolve': return cmdGateResolve(args);
    case 'gate-list': return cmdGateList(args);
    case 'liveness': return cmdLiveness(args);
    case 'check-help': return cmdCheckHelp();
    case 'pr-sync-labels': return cmdPrSyncLabels(args);
    case 'ledger-query': return cmdLedgerQuery(args);
    case 'preflight': return cmdPreflight(args);
    case 'amend': return cmdAmend(args);
    case 'next': return cmdNext(args);
    case 'raw': return cmdRaw(args);
    default:
      console.error(`未知动词: ${args.verb}`);
      process.exit(1);
  }
}

main();
