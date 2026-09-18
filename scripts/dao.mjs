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
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { cpus, homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
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
import { withWorktreeLockSync, withWorktreeLock, defaultLockPath } from './lib/dispatch-lock.mjs';
import { scanSessionProcs } from './lib/dispatch/lease.mjs';
import {
  ROOT,
  USAGE,
  argsTaskCreate,
  argsTerminalClose,
  argsTerminalCreate,
  argsTerminalList,
  argsTerminalRead,
  argsTerminalSend,
  argsTerminalStop,
  argsTerminalWait,
  argsWorktreeCreate,
  argsWorktreeSet,
  argsWorktreeRm,
  argsWorktreePs,
  argsRepoList,
  resolveRepoSelector,
  parseOwnerNameRepo,
  ownerNameFromRemoteUrl,
  assertRepoAuthorized,
  splitRepoTarget,
  resolveLocalCheckout,
  repoPrKey,
  applyWorktreeRmPlan,
  prepareWorktreeRm,
  resolveWorktreeSelector,
  reapWorktreeAgents,
  verifyWorktreeTerminalsGone,
  pidsOnTreePath,
  unwrapTerminalList,
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
  unsignedIssueMergePolicy,
  isLiveDispatchRecipient,
  argsWorkerList,
  gitBranchName,
  gitRemoteOriginUrl,
  isRunRequired,
  RUN_REQUIRED_HINT,
  collectReviewerCardsForPr,
  planReviewerAttachReuse,
  planReviewerKeepOnFail,
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
  attachReceiptFromSpawn,
  REVIEW_PENDING_SOURCE_WORKER_DONE_FAIL,
  REVIEW_PENDING_SOURCE_WORKER_DONE_HANDOFF,
  countLiveReviewers,
  planReviewAdmission,
  resolveReviewerCap,
  reviewerIdsForCap,

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
  assertDispatchInjectPlan,
  mirasimVerbGuard,
  encodeSendText,
  runGh,
  stampIssueLabels,
  stampPrLabelsFromDispatch,
  ensureRepoLabels,
  resolveReviewerFromPr,
  resolveWorkerFromPr,
  listPrReviews,
  planWorkerDone,
  completeWorkerDoneNotify,
  pickWorkerDoneDispatchId,
  planReviewerDone,
  resolveReviewerReuse,
  gateReviewerCreate,
  planFastPathReviewer,
  fastPathStandInCreateArgs,
  assertReviewerSeat,
  postIssueComment,
  postPrComment,
  postCommentOnce,
  reviewerSpawnFailComment,
  reviewerSpawnQueuedComment,
  planWorkerDoneAfterSpawnFail,
  planReuseExistingLiveDispatch,
  planAfterWorkerStartActiveDispatch,
  verifyStartedPolling,
  verifyWorkerStarted,
  piSessionProof,
  proofUnavailableReason,
  verifyReviewerFiles,
  verifyReviewerTree,
  assessPrMergeable,
  fetchPrMergeable,
  resolveMergeable,
  trialMergeMaster,
  waitAndVerify,
} from './lib/dao-cmd.mjs';
import { runPreflightCommand, loadDispatchPolicy } from './lib/preflight.mjs';
import {
  loadReviewRoundsBudgetFile, judgeNextReviewRound, reviewRoundsExceededError,
  reviewRoundsUnscannedError, nextReviewRoundBlocked,
  HALT_CODE as REVIEW_ROUNDS_HALT, UNSCANNED_CODE as REVIEW_ROUNDS_UNSCANNED,
  POLICY_REL as RELEASE_POLICY_REL,
} from './lib/review-rounds-budget.mjs';
import {
  loadDispatchDayBudgetFile, judgeDispatchDay, nextDispatchDayBlocked,
  dispatchDayExceededError, dispatchDayUnscannedError,
} from './lib/dispatch-day-budget.mjs';
import { runBreakerCommand } from './lib/provider-breaker.mjs';
import { ROUTING_POLICY_FILE } from './lib/dispatch/constants.mjs';
import { resolveModelChannel } from './lib/channel-concurrency.mjs';
import { loadRoutingJsonRaw, modelsFromJson, reviewerSelectOrder, usableReviewerOrder, orderForCapacityFailover } from './lib/model-routing-json.mjs';
import { loadExecutionProfiles } from './lib/execution-runtime.mjs';
import { loadBreaker } from './lib/provider-health.mjs';
import { healthRedIds } from './lib/model-admission.mjs';
import { prNumberFromWorktree } from './lib/card-identity.mjs';
import { scanMirasimTrees, probeDir } from './lib/mirasim-trees.mjs';
import { checkTreeLease } from './lib/dispatch/lease.mjs';
import { applyGitIdentity, whoami } from './lib/gh.mjs';
import { applyIssueWrite } from './lib/issue-gateway.mjs';
import { writeStdoutAndExit } from './lib/stdout-exit.mjs';

import {
  loadLedgerContext, beijingIsoFrom, dispatchJobId, reviewerJobId, writeJobDispatch,
  writeJobOpened,
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
import { assertCrossVendor } from './lib/reviewer-vendor-gate.mjs';
import { nextReviewerAfter, planReviewerOnCapacityDeath } from './lib/dianjiangtai-reviewer-slot.mjs';
import { verdictOnHead } from './lib/review-state.mjs';
import { judgeLegDown } from './lib/leg-liveness.mjs';
import { readLegRecords } from './lib/leg-liveness-io.mjs';

/** 这条腿最近跑得怎么样——换厂的第二条凭证（判据 lib/leg-liveness.mjs）。取不到就如实说没查成。 */
function legEvidenceFor(modelId) {
  const got = readLegRecords(modelId);
  if (!got.scanned) return { down: false, scanned: false, why: got.error };
  return judgeLegDown(got.records);
}

import { planBoardTargets, formatBoardArchiveMd, boardResetVerdict } from './lib/board-reset.mjs';
import {
  bindExecutor, readExecutorPolicy, judgeExecutorName, judgeAgentRoute,
} from './lib/executor-binding.mjs';
import { judgeTestExecutorIsolation, enableRealExecutorUnlessTest } from './lib/mirasim-runtime.mjs';
import { ensureControlPlaneHooksPath } from './lib/control-plane-write.mjs';


function errText(e) {
  return orcaErrorText(e);
}

/** 桌面 vs 仓内差异只报：少的不删桌面，多的建议补仓内，启动已按仓内。 */
function noteDroppedFlags(launch) {
  for (const line of formatDesktopLaunchNotes(launch)) {
    console.error(`[dao] ${line}`);
  }
}

// gh 假身走 DAO_GH_FAKE；真路径 runGh。orca CLI spawn 已随执行体退役。
function ghRunner(opts = {}) {
  const fake = process.env.DAO_GH_FAKE;
  if (!fake) return (args) => runGh(args, opts);
  return (args) => {
    const r = spawnSync(process.execPath, [fake, ...args], { windowsHide: true, encoding: 'utf8', timeout: 30000 });
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

// ── 进程内调用（TIA 第二刀，2026-09-06）─────────────────────────────────
// 测试原本每断言一次就 spawn 一个 `node dao.mjs <动词>`，一次 ~225ms；
// 光启动费就占了 dao.test.js 的四成。进程内跑同一条 argv→输出 的路，
// 省掉的只有进程边界，**契约覆盖一个字节都不少**。
//
// 为什么敢把 emit 的 process.exit 换成抛异常（改之前逐条查过）：
//   · 300 处 emit/fail 全走这一个出口，exit 只有 12 处且集中；
//   · 只有 2 个 finally 块，且不在 emit 可达路径上；
//   · 空 catch 虽多，但都是 `try{unlinkSync}catch{}` 这种小块，不包业务逻辑。
// process.exit 不跑 finally 而 throw 会跑——这是唯一的语义差，上面第 2 条已经核过。
// CLI 形态（IN_PROCESS=false）行为一个字不变，抛出的信号在 main 顶层转回 process.exit。
export class ExitSignal extends Error {
  constructor(payload, code) { super('dao-cli-exit'); this.payload = payload; this.code = code; }
}
let IN_PROCESS = false;

function emit(payload, exit = 0) {
  if (IN_PROCESS) throw new ExitSignal(payload, exit);
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

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function killPidTerm(pid) {
  try {
    process.kill(pid, 0);
  } catch (e) {
    if (e && (e.code === 'ESRCH' || e.errno === 3)) return { ok: true, alreadyGone: true, pid };
    return { ok: false, pid, error: String(e && e.message ? e.message : e) };
  }
  try {
    process.kill(pid, 'SIGTERM');
    return { ok: true, pid };
  } catch (e) {
    if (e && (e.code === 'ESRCH' || e.errno === 3)) return { ok: true, alreadyGone: true, pid };
    return { ok: false, pid, error: String(e && e.message ? e.message : e) };
  }
}

function killPidHard(pid) {
  try {
    process.kill(pid, 'SIGKILL');
    return { ok: true, pid, forced: true };
  } catch (e) {
    if (e && (e.code === 'ESRCH' || e.errno === 3)) return { ok: true, alreadyGone: true, pid, forced: true };
    return { ok: false, pid, error: String(e && e.message ? e.message : e), forced: true };
  }
}

function normFsPath(p) {
  return String(p || '').replace(/\\/g, '/').replace(/\/+$/, '');
}

/**
 * stop 回执之后再核实 OS：mirasim 有时只把会话标成 interrupted，
 * app-server/code-mode 子进程仍留在原 worktree，继续占租约。
 * 只杀 mirasim-server 后代且 cwd 精确命中的进程，禁止按名称/全局误杀。
 */
export function reapMirasimSessionProcesses(workdir, {
  scan = scanSessionProcs,
  kill = killPidTerm,
  forceKill = killPidHard,
  maxPasses = 4,
} = {}) {
  const want = normFsPath(workdir);
  if (!want) return { ok: false, error: '没有 workdir，无法核实会话进程' };
  const allReaped = [];
  for (let pass = 0; pass < maxPasses; pass += 1) {
    const observed = scan();
    if (!observed || observed.ok !== true) {
      return { ok: false, unscanned: true, error: observed?.error || '会话进程没查成', reaped: allReaped };
    }
    const holders = (observed.procs || []).filter((p) => normFsPath(p?.cwd) === want);
    if (!holders.length) return { ok: true, reaped: allReaped, remaining: 0 };
    const reaped = holders.map((p) => {
      const gentle = kill(p.pid);
      if (gentle?.ok !== true) return gentle;
      // stop 已经被服务端接受，仍存活的会话进程不能继续占住租约。
      // 对精确 worktree 命中的 mirasim 后代强制收尾，避免 app-server 吞掉 TERM。
      return forceKill(p.pid);
    });
    allReaped.push(...reaped);
    const failed = reaped.filter((r) => r?.ok !== true);
    if (failed.length) {
      return { ok: false, error: `有 ${failed.length} 个会话进程没清掉`, reaped: allReaped };
    }
  }
  return { ok: false, error: `会话进程反复重生，${maxPasses} 次核实后仍未清空`, reaped: allReaped, remaining: true };
}

export async function stopSessionAndReap(runtime, sessionKey, { workdir = null } = {}) {
  let target = workdir;
  if (!target) {
    if (!runtime || typeof runtime.listSessions !== 'function') {
      return { ok: false, unscanned: true, why: 'runtime 没有 listSessions，无法核实会话 worktree' };
    }
    let listed;
    try { listed = await runtime.listSessions(); }
    catch (e) {
      return { ok: false, unscanned: true, why: `会话清单没查成：${String(e?.message || e)}` };
    }
    if (!listed || listed.ok !== true) {
      return { ok: false, unscanned: true, why: listed?.error || listed?.why || '会话清单没查成' };
    }
    const hit = (listed.sessions || []).find((s) => String(s?.sessionKey || s?.key || s?.id || '') === String(sessionKey));
    if (!hit) {
      return { ok: false, unscanned: true, why: `会话 ${sessionKey} 不在会话清单，无法核实 worktree` };
    }
    target = hit.cwd || hit.workdir || hit.worktree || null;
    if (!target) {
      return { ok: false, unscanned: true, why: `会话 ${sessionKey} 没有 worktree，无法核实残留进程` };
    }
  }
  const stopped = await runtime.stopSession(sessionKey, { workdir: target });
  if (!stopped || stopped.ok !== true) return stopped || { ok: false, why: 'stop 没回成功' };
  // stop 是异步的，给服务端一个很短的退出窗口，再核实并回收残留子进程。
  await new Promise((resolve) => setTimeout(resolve, 250));
  const reaped = reapMirasimSessionProcesses(target);
  if (!reaped.ok) return { ok: false, why: reaped.error, reaped: reaped.reaped || [] };
  return { ...stopped, reaped: reaped.reaped || [] };
}

/** #835：占用闸过后再收该树 agent。收不掉就停，不许先删树留下孤儿。 */
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
// ── mirasim 派工（#880 卡 B 的实现，按主干 executor-binding 重写）──────────────
//
// 为什么没有 `--executor` 旗标：卡 B 原设计是双轨（旗标选 orca/mirasim），但旗标要每个
// 调用方记得传，而 commander 的 execAction 从来没传过——代码合了两天，自动派工一次都没
// 走过 mirasim（2026-09-06 查实）。旗标式切换在这里等于没有切换。所以按用户拍板走
// 「一步到位」：dispatch 只有 mirasim 这一条路，orca 那条脊留给在途存量自然流干。
//
// 下面这两条判据是 #884 审官三轮实咬换来的，重写时逐条搬过来了，别当样板注释删掉。

/**
 * mirasim 侧不接 --task（#884 审官 P1，二轮 + 三轮两次实咬）。
 *
 * --task 是 orca 那条脊的语义：卡已经在编排里，起个工人接上去。mirasim「会话即卡」，
 * 没有可接的既有 task。两种走法都得拦死，少拦一种就是两个洞：
 *   ① --task 单飞 → spec:undefined 冲进 buildSoldierInject，崩在模板占位符上。
 *   ② --task 与 --spec 同传 → 只判 !args.spec 的话会返回 ok 并把 task 默默丢掉，
 *      按 spec 派了一单调用方没要的活。
 * 判据因此不看 spec：**只要 args.task 出现就结构化拒派**。公开参数不许静默忽略。
 */
function assertMirasimNoTask(args, verb) {
  if (!args.task) return;
  fail(`mirasim 执行体不接 --task（会话即卡，没有可接的既有 task）：${verb} 只给 --spec`, {
    executor: 'mirasim', refused: true, unsupported: '--task', verb, task: args.task,
    specGiven: !!args.spec,   // 三轮实咬：spec 也给了照样拒
  });
}

/** 读执行体策略 + 定名字。任一环不成立当场拒派。 */
function resolveExecutorOrFail(args, routing) {
  const policy = readExecutorPolicy(routing);
  const named = judgeExecutorName(args.executor, policy);
  if (!named.ok) fail(named.error, { executor: { requested: args.executor || null } });
  return { policy, executor: named.executor, source: named.source };
}

/** 现役工人 git push 前要问控制面闸。挂不上 = 建树/开工失败，不许声称已接线（#1165 审官 P1）。 */
function attachControlPlaneHooksOrFail(cwd, extra = {}) {
  const h = ensureControlPlaneHooksPath({ cwd });
  if (!h.ok) fail(`控制面闸没挂上：${h.why}`, { cwd, ...extra });
  return h;
}

/** mirasim 侧要一个具体分支名。给不出就拒派，不猜——猜错会把两张卡塞进同一棵树。 */
function mirasimBranchOrFail(args) {
  const explicit = String(args.branch || '').trim();
  if (explicit) return explicit;
  const issue = String(args.issue || '').trim().replace(/^#/, '');
  if (/^\d+$/.test(issue)) return `dao-${issue}`;
  fail('mirasim 执行体要 --branch（没 --issue 就推不出默认分支名）；同一 issue 派第二张卡也要显式给，否则会撞同一棵树');
}

/**
 * #1024 返工：mirasim 路把 GitHub owner/name 和 runtime 本地路径拆开。
 * owner/name → 授权闸 + gh --repo；本地路径才给 ensureWorkspace。
 * 不传 --repo = 本仓（gh 不钉仓，本地 ROOT）。路径仍给 #880 卡 B 建树用。
 */
function resolveMirasimRepoTarget(args, { role = 'worker', where = 'dispatch', defaultLocal } = {}) {
  const split = splitRepoTarget(args && args.repo, { root: defaultLocal || ROOT });
  if (!split.ok) fail(split.error);
  if (split.kind === 'path') {
    const localPath = String(split.localPath || '').trim();
    if (!localPath) fail('mirasim 执行体要 --repo（仓路径）');
    return { ok: true, omitted: false, ownerName: null, localPath, kind: 'path' };
  }
  if (split.omitted) {
    return { ok: true, omitted: true, ownerName: null, localPath: defaultLocal || ROOT, kind: 'omitted' };
  }
  const gated = assertCrossRepoOrFail(split.ownerName, { role, where });
  const checkout = resolveLocalCheckout({ ownerName: gated.ownerName });
  if (!checkout.ok) fail(checkout.error, { repo: gated.ownerName, role });
  return {
    ok: true,
    omitted: false,
    ownerName: gated.ownerName,
    localPath: checkout.localPath,
    kind: 'ownerName',
    authorized: true,
    role: gated.role,
  };
}

/** 兼容旧调用点：只返回 runtime 本地路径。跨仓 owner/name 不再原样返回。 */
function mirasimRepoOrFail(args, opts) {
  return resolveMirasimRepoTarget(args, opts).localPath;
}

function ghRunnerForTarget(target, opts = {}) {
  return ghRunner({ ...opts, repo: target && target.ownerName ? target.ownerName : undefined });
}

/**
 * #1024：跨仓闸。不传 --repo 直接放行（本仓路径一字不变）。
 * 传了：格式非法当场拒；installation 没授权拒；名单没扫成报「没查成」。
 * dry-run 也拦格式，授权闸 dry-run 同样拦（回落会让人以为派出了）。
 */
function assertCrossRepoOrFail(raw, { role = 'worker', where = 'dispatch' } = {}) {
  const parsed = parseOwnerNameRepo(raw);
  if (!parsed.ok) fail(parsed.error);
  if (parsed.omitted) return { ok: true, omitted: true, ownerName: null };
  let info;
  try {
    info = whoami(role);
  } catch (e) {
    fail(`${where}：目标仓 ${parsed.ownerName} 没查成（不是「这个仓不存在」）：whoami 抛了 ${String(e?.message || e)}`);
  }
  if (!info || info.ok !== true) {
    fail(`${where}：目标仓 ${parsed.ownerName} 没查成（不是「这个仓不存在」）：${(info && info.error) || 'whoami 没回 ok'}`);
  }
  const gate = assertRepoAuthorized({
    ownerName: parsed.ownerName,
    role,
    repositories: info.repositories,
    repoScan: info.repoScan,
  });
  if (!gate.ok) fail(gate.error, { repo: parsed.ownerName, role, repoScan: info.repoScan });
  return { ok: true, omitted: false, ownerName: parsed.ownerName, authorized: true, role };
}

/** dao 的 --model → mirasim 的族/执行体 agent/腿。缺配置报警拒派，不静默降级。 */
function mirasimRouteOrFail(args, routing, policy, runtime) {
  if (!args.model) {
    fail('mirasim 执行体要显式 --model（族路由按模型族认，--role 打分选型这条路还没接进来——见 #880 卡 B PR 正文）');
  }
  const hit = (routing?.models || []).find(m => m && m.id === args.model);
  if (!hit) fail(`模型 ${args.model} 不在路由表`);
  const profile = runtime?.profileForModel?.(hit.id);
  if (profile) return { ok: true, family: profile.modelFamily, agent: profile.agent, model: hit.id,
    provider: profile.provider, backend: profile.backend, profileId: profile.id, mode: profile.route, leg: profile.route, via: 'execution profile' };
  const route = judgeAgentRoute({ policy, model: hit.id, provider: hit.provider });
  if (!route.ok) fail(route.error, { route: { model: hit.id, provider: hit.provider || null, family: route.family ?? null } });
  return { ...route, model: hit.id, provider: hit.provider || null };
}

/**
 * mirasim 派一单：建树 + 起会话，同步返回。
 *
 * 不走派工单队列——orca 那条脊的异步是因为起 TUI 要等屏、要探针；mirasim 的 prompt
 * 收到 accepted 就返回，本来就是异步的，再套一层队列只是多一个失败面。
 * 会话即卡：观察面是用户自己的 Mirasim 客户端直连本服务器（#880 拍板）。
 */
async function cmdDispatchMirasim(args, routing, gate) {
  assertMirasimNoTask(args, 'dispatch');
  // #1024 返工：owner/name 走授权闸并解析成本地 checkout；路径仍给建树；不传 = 本仓。
  const targetRepo = resolveMirasimRepoTarget(args, { role: 'worker', where: 'dispatch' });
  // 治理三闸照旧：拆块约束、分块指派、注入字节。少调一道就等于换执行体顺手关了它。
  const splitGate = resolveSplitConstraint({ split: args.split, splitReason: args.splitReason });
  if (!splitGate.ok) fail(splitGate.error, { missing: splitGate.missing || [] });
  const sliceGate = resolveSliceAssignments({ childCount: splitGate.childCount, slices: args.slice });
  if (!sliceGate.ok) fail(sliceGate.error, { missing: sliceGate.missing || [] });
  if (splitGate.childCount > 0) fail('mirasim 还不接拆块（父子树 + 多会话编排归 #880 卡 D/E）：本单请 --split no');

  // executor 必须传进闸——闸靠渲染目标任务书来量字节，不传就是按 orca 书量 mirasim 的单
  // （两本书前缀差 8 字节，边界上会放过真正超限的 spec）。渲染与闸必须同一本书。
  const injectGate = assertDispatchInjectPlan({ spec: args.spec, issue: args.issue, executor: 'mirasim' });
  if (!injectGate.ok) fail(injectGate.error, { injectGate });

  const bind = bindExecutor({ executor: 'mirasim', routing });
  if (!bind.ok) fail(bind.error, { executor: 'mirasim' });
  const repo = targetRepo.localPath;
  const ghRepo = targetRepo.ownerName || undefined;
  const branch = mirasimBranchOrFail(args);
  const route = mirasimRouteOrFail(args, routing, bind.policy, bind.runtime);
  const prompt = buildSoldierInject({ spec: args.spec, issue: args.issue, executor: 'mirasim' });
  const cardName = assembleCardName({ name: args.name, issue: args.issue, role: args.role, model: args.model });
  const disambiguation = args.issue
    ? checkIssueDisambiguated({ issue: args.issue, runGh: ghRunnerForTarget(targetRepo, { role: 'worker' }) })
    : { ok: true, gated: false };
  const dup = precheckDispatchDup({
    issue: args.issue, name: cardName, allowDup: args.allowDup, now: args.now,
  });

  // --dry-run 在碰执行体之前返回：预览一针都不许烧（额度撤不回来）。
  // 消歧 / 查重只作报告，不拦预览——真派才 fail-close。
  if (args.dryRun) {
    emit({
      ok: true, dryRun: true, executor: 'mirasim',
      card: cardName, workerCard: cardName, issue: args.issue ?? null, repo, ghRepo: ghRepo || null, branch,
      agent: route.agent, family: route.family, leg: route.leg, mode: route.mode, via: route.via,
      daoModel: args.model, model: args.model,
      reviewer: args.reviewer ?? null, reviewerDeferred: true, reviewerCard: null,
      prompt, split: splitGate.split,
      mergePolicy: (gate && gate.mergePolicy) || 'auto',
      ...(gate && gate.mergeReason ? { mergeReason: gate.mergeReason } : {}),
      disambiguation, dup,
      dispatchDay: judgeLiveDispatchDay(args.now),
      preflight: { skipped: true, why: 'dry-run 默认不探' },
      note: '预览不碰 mirasim：没建树、没起会话、没烧额度',
    });
    return;
  }

  if (!disambiguation.ok) fail(disambiguation.error, { disambiguation });
  if (dup.blocked) fail(dup.error, { dup });

  const dispatchDay = judgeLiveDispatchDay(args.now);
  if (nextDispatchDayBlocked(dispatchDay)) {
    fail(
      dispatchDay.state === 'exceeded'
        ? dispatchDayExceededError(dispatchDay)
        : dispatchDayUnscannedError(dispatchDay),
      { dispatchDay },
    );
  }

  // #1152：测试环境结构性够不着真执行体。拒派闸失手时这一道仍拦住建树/起会话。
  const isolation = judgeTestExecutorIsolation(process.env);
  if (!isolation.ok) fail(isolation.error, { isolation, executor: 'mirasim' });

  // The Mirasim path bypasses legacy post-launch label stamping. Fill the
  // selected task type before starting, otherwise a later pr-sync-labels
  // refuses to merge a fully reviewed PR. Existing declared types win.
  if (args.issue && !(disambiguation.labels || []).some(n => n.startsWith('type/'))) {
    const labels = stampIssueLabels({ issue: args.issue, role: gate?.role,
      preserveType: true, runGh: ghRunnerForTarget(targetRepo, { role: 'marshal' }),
      writeIssue: applyIssueWrite, repo: ghRepo || 'thoerwink8/windsurf-dao', host: 'dispatch-mirasim' });
    if (!labels.ok) fail(`派工类型未写入，暂不起工人：${labels.error}`, { executor: 'mirasim' });
  }

  let tree;
  try { tree = await bind.runtime.ensureWorkspace(repo, branch); }
  catch (e) { fail(`mirasim 建树失败: ${String(e?.message || e)}`, { executor: 'mirasim', repo, ghRepo: ghRepo || null, branch }); }
  if (!tree || !tree.path) fail('mirasim 建树没返回 path', { executor: 'mirasim', repo, branch });
  attachControlPlaneHooksOrFail(tree.path, { executor: 'mirasim', repo, branch });

  let sess;
  try {
    const dispatchIssue = Number(args.issue);
    sess = await bind.runtime.startSession({
      agent: route.agent, workdir: tree.path, prompt,
      model: args.model, clientRef: `dao-dispatch-${args.issue ?? 'x'}-${Date.now()}`,
      ...(Number.isInteger(dispatchIssue) && dispatchIssue > 0 ? { issue: dispatchIssue } : {}),
    });
  } catch (e) {
    // 租约被占是**背压**不是失败：树里有人在干活，排队下一轮就行。busy 原样透出去，
    // 指挥官据此不开待拍板单（不标它就会每轮开一张噪音单，见 lease.mjs 的 LEASE_BUSY_REASON）。
    fail(`mirasim 起会话失败: ${String(e?.message || e)}`, {
      executor: 'mirasim', repo, branch, path: tree.path, card: cardName, agent: route.agent,
      ...(e?.detail?.busy === true ? { busy: true, reason: e.detail.reason, holders: e.detail.holders } : {}),
    });
  }

  // merge-policy 必须落账本：审官侧 lookupReviewerMergePolicy 按 flag > ledger > comment >
  // fallback('auto') 恢复。不写这条，审官对每张单都拿 fallback 的 auto——**显式派成 manual
  // 的单会被自动合并**（#886 审官第 4 条明令不许硬编码 auto，fallback 虽有 source 标注但结果一样）。
  // 复用 orca 那条脊同一个写口，字段对齐：审官按 job.dispatch + identity=工人 + issue_number 找。
  let ledger = null;
  try {
    const ctx = loadLedgerContext({ root: ROOT });
    ledger = writeJobDispatch({
      ...ctx,
      ts: beijingIsoFrom(new Date()),
      jobId: dispatchJobId(sess.sessionKey),
      model: args.model,
      identity: '工人',
      workType: (gate && gate.role) || '写码',
      terminal: 'mirasim',
      extra: {
        source: 'dao-dispatch-mirasim',
        dispatch_id: sess.sessionKey,
        executor: 'mirasim',
        agent: route.agent,
        merge_policy: (gate && gate.mergePolicy) || 'auto',
        ...((gate && gate.mergeReason) ? { merge_reason: gate.mergeReason } : {}),
        ...(args.issue ? { issue_number: Number(args.issue) || args.issue } : {}),
        card_name: cardName,
        branch,
        reviewer: args.reviewer ?? null,
        repo: resolveDispatchRepo(ghRepo) || null,
      },
    });
    if (!ledger.ok && !ledger.skipped) console.error(`[dao] mirasim 派工账本没写上（派工本身成功）：${ledger.error}`);
  } catch (e) {
    ledger = { ok: false, error: String(e.message || e) };
    console.error(`[dao] mirasim 派工账本没写上（派工本身成功）：${ledger.error}`);
  }

  emit({
    ok: true, executor: 'mirasim',
    card: cardName, issue: args.issue ?? null,
    repo, ghRepo: ghRepo || null, branch, path: tree.path, treeCreated: tree.created,
    sessionKey: sess.sessionKey, taskId: sess.taskId ?? null, startedAt: sess.startedAt,
    agent: route.agent, family: route.family, mode: route.mode, daoModel: args.model,
    reviewer: args.reviewer ?? null,
    mergePolicy: (gate && gate.mergePolicy) || 'auto',
    ledgerWritten: !!(ledger && ledger.ok),
    note: '有署名的任务在开工前核实类型；交卷仍需 PR 和验证结果，启动成功不等于完成',
  });
}

async function cmdDispatch(args) {
  if (args.batch) return cmdDispatchBatch(args);
  const routing = loadOrFail();
  const gate = constrainDispatch(args, routing);
  if (!args.spec && !args.task) fail('dispatch 要 --spec（工人任务书），或已有 --task');
  if (!args.name && !args.dryRun) fail('dispatch 要 --name');

  // 执行体只剩 mirasim（#1150：orca 墓碑与死调用点整层删）。routeToMirasim 遇 --executor orca 当场拒。
  if (routeToMirasim(args)) {
    return cmdDispatchMirasim(args, routing, gate);
  }

  fail('orca 已退役，执行体只剩 mirasim');
}

async function cmdDispatchExec() {
  fail('orca 已退役，dispatch-exec 随 orca 异步派工脊一起删了');
}

function cmdDispatchBatch() {
  fail('orca 已退役，dispatch --batch 随 orca 编排一起删了');
}

function loadDispatchEventsForStamp() {
  try {
    const ctx = loadLedgerContext({ root: ROOT });
    const listed = readLedgerEvents(ctx.dir);
    if (listed.unscanned) return { ok: false, unscanned: true, error: listed.error, events: [] };
    return { ok: true, events: listed.events || [] };
  } catch (e) {
    return { ok: false, unscanned: true, error: String(e.message || e), events: [] };
  }
}

/**
 * 打标/落账用的 GitHub owner/name：显式 --repo 优先，否则从本仓 origin 推。推不出就没查成。
 *
 * 不传 --repo = 本仓（与 resolveMirasimRepoTarget 同口径），所以「省略」这一路必须真去问 origin，
 * 不能落 null：账本 repo 是选型打标的匹配键（#1116），写 null 等于这条派工链事后查不回来。
 * 本仓 origin 探不到时退到 ROOT——同机另一个 checkout 上看不到 origin 不代表派工不是本仓的。
 */
function resolveDispatchRepoName(explicit) {
  const parsed = parseOwnerNameRepo(explicit);
  if (parsed.ok && !parsed.omitted) return { ok: true, ownerName: parsed.ownerName };
  const root = thisCheckoutRoot();
  const tried = root === ROOT ? [root] : [root, ROOT];
  let lastError = '';
  for (const dir of tried) {
    const remote = gitRemoteOriginUrl(dir);
    if (!remote.ok) { lastError = remote.error; continue; }
    const resolved = ownerNameFromRemoteUrl(remote.url);
    if (resolved.ok) return resolved;
    lastError = resolved.error;
  }
  return { ok: false, unscanned: true, error: `本仓 GitHub owner/name 没查成：${lastError}` };
}

/** 落账用：解析不出就 null。派工不许因为「仓名没查成」而拒绝——本仓 origin 正常时永远拿得到。 */
function resolveDispatchRepo(explicit) {
  const r = resolveDispatchRepoName(explicit);
  return r.ok ? r.ownerName : null;
}

/** #1116：仓 + PR head 分支 → 账本 dispatch → 打标。查不到完整记录不猜。 */
function stampPrFromLedger({ pr, runGh, repo } = {}) {
  const listed = loadDispatchEventsForStamp();
  if (!listed.ok) return listed;
  const resolved = resolveDispatchRepoName(repo);
  if (!resolved.ok) return resolved;
  return stampPrLabelsFromDispatch({
    pr,
    runGh,
    events: listed.events,
    ensureLabels: ensureRepoLabels,
    repo: resolved.ownerName,
  });
}

/**
 * 打标失败后还许不许继续只读已有 PR 标签。
 * 没查成（unscanned）→ 继续；不是派工链（skipped + none）→ 打不上不挡。
 * 已查成的冲突/歧义（conflict / many）和已查成坏账（invalid：缺 model、非法 identity）
 * 必须 fail-closed，不许再猜、不许当「不是这条链」绕过。
 */
function warnOrFailLedgerStamp(stamped, pr) {
  if (!stamped || stamped.ok) return;
  if (stamped.unscanned) {
    console.error(`[dao] PR #${pr} 账本打标没查成（选型仍只读 PR label）：${stamped.error}`);
    return;
  }
  if (stamped.skipped && stamped.state === 'none') return;
  fail(stamped.error, stamped);
}

function cmdPrSyncLabels(args) {
  const targetRepo = resolveMirasimRepoTarget(args, { role: 'worker', where: 'pr-sync-labels', defaultLocal: thisCheckoutRoot() });
  const r = stampPrFromLedger({
    pr: args.pr,
    runGh: ghRunnerForTarget(targetRepo, { role: 'worker' }),
    repo: targetRepo.ownerName,
  });
  if (!r.ok) fail(r.error, r);
  emit({ ok: true, ...r });
}

/**
 * 帅位自开 PR：开 draft + 落账 + 打标（#1214 缺口 A）。
 *
 * ## 为什么要有这个动词
 *
 * 帅位自己开 PR 是**合法**动作（`host/skills/pr-fast/SKILL.md`：快路不收 issue，
 * PR 正文三段式、作者是 marshal）。但它此前**没有任何落账动作**，于是打标路
 * （`pickWorkerDispatchByBranch`：认 `job.dispatch` + 身份 + model + reviewer）永远查不到这条链，
 * 这类 PR 一律卡在「需人工打标」——指挥官合不了，审官也叫不动。
 *
 * 用户 2026-09-13 拍板（#1214 评论 `1214-decision-20260913-a2-1`）：走一条**显式打标入口**
 * 先把卡住的解开，自动化补标留到解环之后再单独谈。本动词就是那条入口的写侧。
 *
 * ## 为什么不放宽判据
 *
 * 缺口不在「判据太严」，在于**这类 PR 从来没落过账**。补上落账，判据一个字都不用改，
 * 也就不必去动 `identity === '工人'` 那道闸——那道闸仍然只放行「真有派工决定」的链。
 * 帅位自开这条链落的账本身是**诚实的**：model 与 reviewer 都是当场给的（都必填，
 * 且必须是 registry 里的 id，reviewer 还要与 model 换厂商），不是从 commit 前缀反推出来的。
 *
 * ## 失败方向
 *
 * 落账在开 PR **之后**：先拿到 PR 号才能把 `pr_number` 写进事件，而 PR 号是这条账的用处所在。
 * 落账失败 ⇒ 报失败（但 PR 已开，回执里带 pr 号与 URL）——**不许静默**：
 * 静默正是本缺口原来那副样子，一张开出来却打不上标的 PR 看起来与正常 PR 毫无区别。
 */
function cmdPrOpen(args) {
  const targetRepo = resolveMirasimRepoTarget(args, { role: 'marshal', where: 'pr-open', defaultLocal: thisCheckoutRoot() });
  // 先查「参数齐不齐」，再查「参数对不对」：缺参数是调用方还没写全，报错要指那一处。
  const head = String(args.head || args.branch || '').trim();
  if (!head) fail('pr-open 要 --head <分支>（分支名是打标路的匹配键之一，不能靠猜）');
  if (!args.title) fail('pr-open 要 --title');
  const routing = loadOrFail();
  const model = String(args.model || '').trim();
  if (!model) fail('pr-open 要 --model（帅位自开也得说清是哪条腿交付的，否则这张 PR 进不了选型账）');
  const knownIds = (routing.models || []).map((m) => m && m.id).filter(Boolean);
  if (!knownIds.includes(model)) {
    fail(`pr-open 的 --model ${model} 不在 registry（不落幽灵账）：可用 ${knownIds.join('、')}`);
  }
  const reviewer = String(args.reviewer || '').trim();
  // reviewer 也必填（2026-09-14 审官判红第 1 条）：打标路的判据是这条 `job.dispatch` 里
  // `model` 与 `reviewer` **都在**（worker-done.mjs:274），缺 reviewer 一样回「需人工打标」。
  // 原来写成「不给也行，稍后 pr-sync-labels 补齐」是错的——`pr-sync-labels` 只把账里**已有**
  // 的字段打成标，它既不选审官也不写账（这是 memory `dispatched-label-alone-never-dispatches` 的同一形状：
  // 少一个标，整条链静默卡住，而现场看起来像「已经交出去了」）。
  if (!reviewer) fail('pr-open 要 --reviewer（打标路要求 model 与 reviewer 同时在账上；缺一个就永远「需人工打标」）');
  // 「在 registry 里」不够——还得是**能当审官**的那个（有「审查」职责、没被 reviewerDisabled）。
  // 同一个模型 id 既可能在工人侧也可能在审官侧，只查 id 存在就放行，落下去的是一条
  // 「账上写着审官、实际起不来审官会话」的账——那是比缺字段更难查的坏账。
  const reviewerIds = reviewerPasserIds(routing);
  if (!reviewerIds.includes(reviewer)) {
    fail(`pr-open 的 --reviewer ${reviewer} 不是可用审官（要 roles 含「审查」且没被 reviewerDisabled）：可用 ${reviewerIds.join('、')}`);
  }
  // 审查换厂商：这条链落账后审官就是定死的，开 PR 这一刻是唯一能拦住同厂的点。
  refuseIfSameVendor({ workerId: model, reviewerId: reviewer, routing });
  const ghRepo = targetRepo.ownerName || DEFAULT_DAO_REPO;
  let body = args.body;
  if (args.bodyFile) {
    try { body = readFileSync(args.bodyFile, 'utf8'); }
    catch (e) { fail(`pr-open 读 --body-file 失败：${e.message || e}`); }
  }
  if (!body || !String(body).trim()) fail('pr-open 要 --body 或 --body-file（PR 正文三段式：目标/验收标准/进展）');

  const gh = ghRunnerForTarget(targetRepo, { role: 'marshal' });
  // 正文经**临时文件**给 gh，不走 argv：正文里有换行、引号、反引号，
  // 而这条命令的每一层中转都会再吃一次转义（本仓判例 `shell-escape-into-file`）。
  // 临时文件写完就删，路径里的内容一个字节都不进命令行。
  const bodyFile = join(tmpdir(), `dao-pr-open-${process.pid}-${Date.now()}.md`);
  try { writeFileSync(bodyFile, String(body), 'utf8'); }
  catch (e) { fail(`pr-open 写正文临时文件失败：${e.message || e}`); }
  const argv = ['pr', 'create', '--draft', '--title', String(args.title), '--body-file', bodyFile, '--head', head, '--base', args.base || 'master'];
  let created;
  try { created = runPrCreate({ gh, argv }); }
  finally { try { unlinkSync(bodyFile); } catch { /* 删不掉不影响结果，临时目录会被回收 */ } }
  if (!created.ok) fail(`pr-open 开 PR 失败：${created.error}`, { pr: created.pr });
  const prNumber = created.pr;
  const url = created.url || `https://github.com/${ghRepo}/pull/${prNumber}`;

  const ctx = loadLedgerContext({ root: ROOT });
  const ts = beijingIsoFrom(new Date());
  const jobId = workerJobId(prNumber);
  const opened = writeJobOpened({
    ...ctx, ts, jobId, model, identity: '工人', workType: args.workType || '写码',
    candidateModels: [model], prNumber,
    why: `帅位自开 PR（pr-open）：${String(args.title).trim()}`,
    extra: { source: 'dao-pr-open', branch: head, repo: ghRepo, ...(reviewer ? { reviewer } : {}) },
  });
  if (!opened.ok && !opened.skipped) {
    fail(`PR #${prNumber} 已开（${url}），但账本没写上：${opened.error}——这张 PR 现在打不上标，补账前不要指望自动推进`,
      { pr: prNumber, url, ledger: opened });
  }
  const dispatched = writeJobDispatch({
    ...ctx, ts, jobId, model, identity: '工人', workType: args.workType || '写码',
    terminal: 'marshal', prNumber,
    extra: {
      source: 'dao-pr-open', branch: head, repo: ghRepo,
      ...(reviewer ? { reviewer } : {}),
      ...(args.mergePolicy ? { merge_policy: args.mergePolicy } : {}),
      ...(args.mergeReason ? { merge_reason: args.mergeReason } : {}),
      ...(args.issue ? { issue_number: Number(args.issue) || args.issue } : {}),
    },
  });
  if (!dispatched.ok && !dispatched.skipped) {
    fail(`PR #${prNumber} 已开（${url}），job.dispatch 没写上：${dispatched.error}——打标路读的正是这一条`,
      { pr: prNumber, url, ledger: dispatched });
  }

  // 打标是**记账**不是门（与 commander 合并路同一口径）：打不上要说清，但不把已开出来的 PR 判失败。
  const stamped = stampPrFromLedger({ pr: prNumber, runGh: gh, repo: ghRepo });
  emit({
    ok: true, pr: prNumber, url, branch: head, repo: ghRepo,
    model, reviewer, draft: true,
    ledgerWritten: !!(opened.ok && dispatched.ok),
    ledgerSkipped: !!(opened.skipped || dispatched.skipped),
    stamped: stamped.ok ? { ok: true, labels: stamped.labels || stamped.added || null } : { ok: false, error: stamped.error },
    note: stamped.ok
      ? 'draft PR 已开、账已落、标已打；交卷前记得 pr ready'
      : 'draft PR 已开、账已落，但这次没打上标（记账不算失败）：' + stamped.error,
  });
}

/** 开 PR 并取回执；`gh pr create` 的回执是 URL，从 URL 尾段取号（取不到就只报 URL，不编号）。 */
function runPrCreate({ gh, argv }) {
  const r = gh(argv);
  if (!r.ok) return { ok: false, error: r.error || 'gh pr create 失败' };
  return parsePrCreateOut(String(r.out || ''));
}

/** gh pr create 回执是 URL；从 URL 尾段取号。取不到只报 URL，不编号。 */
function parsePrCreateOut(out) {
  const url = (out.match(/https:\/\/github\.com\/[^\s]+\/pull\/(\d+)/) || [])[0] || null;
  const n = url ? Number(url.split('/').pop()) : null;
  if (!n) return { ok: false, error: `gh pr create 回执里取不到 PR 号：${out.trim().slice(0, 200)}` };
  return { ok: true, pr: n, url };
}

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
  const trees = Array.isArray(worktrees) ? worktrees : null;
  const wt = worktreeSel && Array.isArray(trees) ? findWorktreeBySel(trees, worktreeSel) : null;
  const comment = parseDispatchComment(wt && wt.comment);
  return resolveReviewerMergePolicy({
    explicitPolicy,
    explicitReason,
    ledger,
    comment,
    issue,
  });
}

function writeReviewPendingOnFail({
  pr, parentId, reviewer, issue, round, error, workerModel, soldierDispatch, runGh, source, repo,
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
      source: source || REVIEW_PENDING_SOURCE_WORKER_DONE_FAIL, repo,
    });
    if (!built.ok) return built;
    return writeReviewPending({ dir: reviewPendingDir({ root: ROOT }), ticket: built.ticket });
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

function executorFromCwd(cwd) {
  const p = String(cwd || '').replace(/\\/g, '/');
  return /(^|\/)mirasim-worktrees\//.test(p) ? 'mirasim' : null;
}

// ── 切流量开关（#880 卡 E，2026-09-06 翻）─────────────────────────────────────
// 一步到位换 mirasim = 把这个 false 改成 true，删掉 orca 那几段。回退一行：改回 false。
// 验收判据「v2 真实派单一轮无人工干预」已达成：issue #1003 → mirasim 派工 → 工人开出
// PR #1025 → 交卷 → 审官 APPROVED → 已合并，全程 orca 侧零参与。
// 判据不靠人记：tests/dao-dispatch-gate.test.js「mirasim 单轨派工硬闸」那套跟着这行走。
//
// **必须是模块级、必须三个动词共用**（2026-09-06 实咬）：它原来是 cmdDispatch 里的局部常量，
// 于是这个开关只翻了 dispatch 一处——`reviewer-create` 仍要求显式 `--executor` 才走 mirasim，
// 帅位在主树里起审官就永远落回 orca 老脊，被那条脊的 `orca worktree list` fail-close 拒掉，
// **所有 PR 都判不了绿**。这是 memory fix-landed-at-one-call-site-only 的标准形状：
// 切换动作只接了一个调用点，另一条路照旧坏着，而「我已经切过了」这个念头让人更查不到。
// 再加动词时用 routeToMirasim，不要就地再写一遍条件。
const MIRASIM_IS_ONLY_PATH = true;

/** 执行体只剩 mirasim。显式 `--executor orca` 当场拒，不留第三态。 */
function routeToMirasim(args = {}) {
  if (args.executor === 'orca') fail('orca 已退役，执行体只剩 mirasim');
  return true;
}

function cmdWorkerDone(args) {
  // cwd 兜底留着：工人在 mirasim 树里漏了 --executor 也要走对（#880 卡 E 验收当场咬过）。
  // 但它只是兜底，不是判据——真正的默认由 routeToMirasim 给，否则帅位在主树里替工人交卷
  // 会静默落回 orca 老脊。
  if (routeToMirasim(args)) {
    return cmdWorkerDoneMirasim({ ...args, executor: args.executor || executorFromCwd(process.cwd()) || 'mirasim' });
  }
  fail('orca 已退役，执行体只剩 mirasim');
}

async function cmdWorktreeCreate(args) {
  // 参数校验按执行体分岔（#884 审官 P1）：卡名是 orca 建树的必填项（树名就是卡名），mirasim
  // 建树只吃 repo/branch。共享入口若再拿 orca 的必填项拦一道，dao-cmd.mjs USAGE 写的
  // `worktree-create --executor mirasim --branch <分支>` 就永远进不了 mirasim 路径——
  // 所以这道闸必须落在分岔之后、各自的分支里。
  const ex = resolveExecutorOrFail(args, loadOrFail());
  if (ex.executor === 'mirasim') return cmdWorktreeCreateMirasim(args, ex);
  fail('orca 已退役，执行体只剩 mirasim');
}

async function cmdWorktreeCreateMirasim(args, { policy }) {
  const targetRepo = resolveMirasimRepoTarget(args, { role: 'worker', where: 'worktree-create' });
  const repo = targetRepo.localPath;
  const branch = mirasimBranchOrFail(args);
  const isolation = judgeTestExecutorIsolation(process.env);
  if (!isolation.ok) fail(isolation.error, { isolation, executor: 'mirasim', repo, branch });
  const binding = bindExecutor({ executor: 'mirasim', policy });
  let r;
  try { r = await binding.worktreeCreate({ repo, branch }); }
  catch (e) { fail(`mirasim 建树失败: ${String(e?.message || e)}`, { executor: 'mirasim', repo, branch }); }
  if (!r.ok) fail(`mirasim 建树失败: ${r.error}`, { executor: 'mirasim', repo, branch });
  emit({
    ok: true, executor: 'mirasim', repo, ghRepo: targetRepo.ownerName || null, branch,
    path: r.path, created: r.created, verified: r.verified,
  });
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
  // amend 是帅追加职责，Issue 评论走网关（#792），身份固定 marshal。
  const posted = postIssueComment({
    issue, body, runGh: ghRunner({ role: 'marshal' }),
    writeIssue: applyIssueWrite, host: 'dao-amend',
    idempotency_key: `dao-amend:${issue}:${written.event && written.event.event_id || target.jobId}`,
  });
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

function gitRemoveWorktree(node) {
  const p = node && node.path;
  if (!p) return { ok: false, error: `卡 ${(node && (node.name || node.id)) || '?'} 缺 path，未删` };
  const lease = checkTreeLease({ workdir: p });
  if (!lease.ok) return { ok: false, error: `租约没查成：${lease.error}` };
  if (lease.verdict === 'held') return { ok: false, error: lease.why };
  const rm = spawnSync('git', ['-C', ROOT, 'worktree', 'remove', '--force', p], {
    encoding: 'utf8', timeout: 60000, windowsHide: true,
  });
  if (rm.status === 0) return { ok: true };
  try {
    rmSync(p, { force: true, recursive: true });
    return { ok: true, note: `git worktree remove 失败后直接删目录：${String(rm.stderr || rm.stdout || '').trim().slice(0, 80)}` };
  } catch (e) {
    return { ok: false, error: `删不掉 ${p}：${String(e && e.message || e).slice(0, 160)}` };
  }
}

function cmdWorktreeRm(args) {
  if (!args.worktree) fail('worktree-rm 要 --worktree');
  const trees = scanMirasimTrees({
    readdir: (p) => readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name),
    stat: statSync,
    join,
  });
  if (!trees.scanned) fail(`盘面没查成，未删任何树: ${trees.error}`);
  const wts = Array.isArray(trees.worktrees) ? trees.worktrees : [];
  const archive = lookupArchiveWaiver(wts, args.worktree);
  const plan = prepareWorktreeRm(wts, args.worktree, {
    mainEventsDir: ensureLocalLedger({ root: ROOT }).dir,
    archive,
  });
  if (!plan.ok) fail(plan.error, { occupied: plan.occupied || [], stray: plan.stray || [], archive });
  const applied = applyWorktreeRmPlan(plan, {
    rm: (node) => gitRemoveWorktree(node),
  });
  if (!applied.ok) fail(applied.error, { removed: applied.removed || [] });
  emit({
    ok: true,
    removed: applied.removed,
    executor: 'git',
  });
}

function cmdTaskCreate(args) {
  fail('orca 已退役，task-create 随 orca 编排一起删了');
}

async function cmdWorkerStart(args) {
  const routing = loadOrFail();
  constrainDispatch(args, routing);
  // 消歧门（#565）：两条脊共用，必须在分岔 / --task 闸之前。
  // #1071 把默认执行体翻成 mirasim 之后，这道门若留在 orca 分支里，
  // 带 --issue 的 worker-start 会先被 「不接 --task」拦下——治理门被执行体闸掩盖（#880：只换执行体，不动治理）。
  const disambiguation = checkIssueDisambiguated({ issue: args.issue, runGh: ghRunner() });
  if (!disambiguation.ok) fail(disambiguation.error, { disambiguation });
  const ex = resolveExecutorOrFail(args, routing);
  if (ex.executor === 'mirasim') return cmdWorkerStartMirasim(args, routing, ex);
  fail('orca 已退役，执行体只剩 mirasim');
}

async function cmdWorkerStartMirasim(args, routing, { policy }) {
  const workdir = String(args.worktree || '').trim();
  if (!workdir) fail('mirasim worker-start 要 --worktree <树的绝对路径>（mirasim 侧没有终端 handle 这回事）');
  // 同 dispatch：--task 是 orca 语义，出现就拒，不许静默丢（#884 审官 P1，三轮）。
  assertMirasimNoTask(args, 'worker-start');
  if (!args.spec) fail('mirasim worker-start 要 --spec（任务书）');
  // 消歧门在 cmdWorkerStart 入口（分岔前）已拦过一遍。
  // #884 审官 P1#3（四轮）：超长 --spec 必须在渲染前结构化拒派，不许 buildSoldierInject 甩栈。
  const injectGate = assertDispatchInjectPlan({ spec: args.spec, issue: args.issue, executor: 'mirasim' });
  if (!injectGate.ok) fail(injectGate.error, { injectGate, executor: 'mirasim' });
  // bindExecutor 要提到选路之前：runtime 带着执行目录，没有它 profileForModel 恒空，
  // ACP 腿（cursor/devin）会掉回模型前缀兜底被判成 pi。dispatch 那侧一直传着，
  // 这侧漏了——同一个修法只接一个调用点，判例 fix-landed-at-one-call-site-only。
  const binding = bindExecutor({ executor: 'mirasim', policy, routing });
  const route = mirasimRouteOrFail(args, routing, policy, binding.runtime);
  // 同 dispatch：不传 executor 就把 orca 任务书发进 mirasim 会话（#884 审官 P1，三轮）。
  const prompt = buildSoldierInject({ spec: args.spec, issue: args.issue, executor: 'mirasim' });
  let r;
  try { r = await binding.workerStart({ workdir, prompt, model: route.model, provider: route.provider }); }
  catch (e) { fail(`mirasim 起会话失败: ${String(e?.message || e)}`, { executor: 'mirasim', workdir }); }
  if (!r.ok) fail(`mirasim 起会话失败: ${r.error}`, { executor: 'mirasim', refused: !!r.refused, workdir });
  emit({
    ok: true, executor: 'mirasim', workdir,
    sessionKey: r.sessionKey, taskId: r.taskId, startedAt: r.startedAt,
    agent: r.agent, family: r.family, leg: r.leg, daoModel: r.daoModel,
  });
}

function cmdWorkerRelease(args) {
  fail('orca 已退役，worker-release 随 orca 编排一起删了');
}

function cmdWorkerRead(args) {
  fail('orca 已退役，worker-read 随 orca 编排一起删了');
}

async function cmdReviewerCreate(args) {
  if (routeToMirasim(args)) return cmdReviewerCreateMirasim(args);
  fail('orca 已退役，执行体只剩 mirasim');
}

function cmdReviewerAttach() {
  fail('orca 已退役，reviewer-attach 随 orca 卡一起删了。补派审官走 reviewer-create（review-pending-drain 已接这条）');
}

function cmdReviewerDone(args) {
  if (!args.pr) fail('reviewer-done 要 --pr');
  const targetRepo = assertCrossRepoOrFail(args.repo, { role: 'reviewer', where: 'reviewer-done' });
  const gh = ghRunnerForTarget(targetRepo, { role: 'reviewer' });
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

/**
 * 这一轮能拉几张（#1125）。IO 都在这儿，判据在 review-pending.mjs 的两个纯函数里。
 *
 * 「在役几个」只认**会话名单**里的 runState：登记文件满地都是「登记还在、会话早死」（#1121），
 * 进程也不算数——会话死后 mirasim 会把进程重新拉起来，那一针永远不动（残壳）。
 * 名单读不到 ⇒ 没查成 ⇒ 这一轮拉 0 张，票留在队列，不许当成「0 个在跑」去拉满。
 */
async function admitReviewPull(tickets) {
  // 上限不再是手打常量：机器那层按核数，上游那层按**本轮票实际会用的审官**所落渠道取严。
  // 全部可用候选里那条没用到的 cap=1 腿不许拖住整队。
  // 有限渠道上限始终是最终上界；保底只在没有任何有限渠道约束时生效。
  const usable = usableReviewerIds();
  // DAO_REVIEWER_CAP 也走同一个函数（只收紧不放宽）——这里不许再出现「有环境值就整段跳过取严」的平级分支。
  const limit = resolveReviewerCap({
    cores: (() => { try { return cpus()?.length ?? null; } catch { return null; } })(),
    reviewerIds: reviewerIdsForCap(tickets, usable),
    channelOf: reviewerChannelCap,
    envCap: process.env.DAO_REVIEWER_CAP,
  });
  let sessions = null;
  try {
    const routing = loadRouting();
    const bind = bindExecutor({ executor: 'mirasim', routing });
    if (bind.ok) {
      const listed = await bind.runtime.listSessions();
      if (listed && Array.isArray(listed.sessions)) sessions = listed.sessions;
    }
  } catch { sessions = null; }   // 读不到就是没查成，下面按没查成处理

  const records = mirasimRegistry().listAll ? mirasimRegistry().listAll() : null;
  const counted = countLiveReviewers({ records, sessions });
  return planReviewAdmission({ tickets, liveReviewers: counted.count, cap: limit });
}

/**
 * 「现在起得来的审官顺位」——票上写死的那一位死了时，drain 靠它换人。
 *
 * 与指挥官**同一份判据**（`commander.mjs:592` 那三行）：顺位表 × 执行目录可用性。
 * 这里自己再写一遍就会跟那边分叉——分叉那天两边的「可用审官」不一样，
 * 而票读侧与选官侧的分歧正是本单要治的病。
 *
 * 读不到任何一份（路由表 / 执行目录）⇒ 回 `null`，调用方**不换人**：
 * 「没查到依据」不等于「票上那个不能用」，拿它去换人是猜。
 */
function usableReviewerIds() {
  try {
    const raw = loadRoutingJsonRaw();
    const profiles = loadExecutionProfiles();
    // #1342：与指挥官同一个判据（healthRedIds）——目录里 available 的腿真实 turn 可以 25% 成功率，
    // 熔断 open 的模型不许再被票上写着就照派。判红名单算不出（表没查成）= 不据此剔，只按目录。
    let redIds = [];
    try { redIds = healthRedIds({ models: modelsFromJson(raw), profiles, breaker: loadBreaker() }); } catch { redIds = []; }
    return usableReviewerOrder(reviewerSelectOrder(raw), { profiles, redIds }).usable;
  } catch { return null; }
}

/**
 * 容量换人候选顺位：与默认选型同一把尺（#1233 / usableReviewerIds）。
 *
 * 病（#1359 审官 P1）：`planReviewerOnCapacityDeath` 拿裸 `reviewerOrder` 当候选，
 * sol 满载就落到 `gpt-5.6-terra`（availability=unverified），`resolveExecutionProfile`
 * 拒启动，自动复审继续失败。策略顺位纯函数仍认全表；过滤只发生在这里。
 *
 * 执行目录读得到 → 只用 usable；没查成 → 不据此剔除。
 * usable 为空数组 = 查成了但一个能起的都没有 → 空候选，换人显式失败。
 */
function capacityFailoverReviewerOrder(routing) {
  try {
    return orderForCapacityFailover(reviewerOrderOf(routing), { profiles: loadExecutionProfiles() });
  } catch {
    return reviewerOrderOf(routing);
  }
}

function capacityFailoverCtx({ failover, workerId, routing }) {
  if (!failover || !failover.deadError) return null;
  const order = capacityFailoverReviewerOrder(routing);
  return {
    deadModelId: failover.deadModelId,
    deadError: failover.deadError,
    workerId,
    models: routing.models || [],
    passerIds: order,
    order,
    legEvidence: legEvidenceFor(failover.deadModelId),
  };
}

/**
 * 一位审官落在哪条渠道、那条渠道的上限是几（`resolveReviewerCap` 的渠道那层）。
 *
 * 走 `resolveModelChannel`（#1145 的正典），不自己按 provider 拼渠道键——自己拼那天，
 * 「同一个模型算哪条渠道」在这里和指挥官里就会给出两个答案。
 * 认不出 / 不限 ⇒ 回 null，调用方据此**不拿它去收紧**（不限不是 0）。
 */
function reviewerChannelCap(id) {
  try {
    const raw = loadRoutingJsonRaw();
    const hit = resolveModelChannel({ model: id, legs: raw['腿'], models: raw['模型'] });
    return hit && Number.isFinite(hit.cap) ? hit.cap : null;
  } catch { return null; }
}

/**
 * 当前 head 上有没有审官判定（三态：true / false / null=没查成）。
 * 读不到一律 null——复用判据只在**确认没有**时才另起，不许拿「读不到」去重复烧额度。
 *
 * 对账目标是 reviewer 角色从 GitHub 读到的 PR **当前** headRefOid，不是登记里的
 * expectedOid（#1293 审官 P1 实咬）：登记可能钉着旧提交（审官树/登记没跟上新 push），
 * 旧提交上的 APPROVED / CHANGES_REQUESTED 会被误认作当前 head 已判定，
 * 终态会话因此被复用，新提交永远没人审。
 *
 * head 与 reviews 必须同一次 `gh pr view --json headRefOid,reviews` 快照里读。
 * 分两次读的话，第一次拿到旧 OID `H`、两次之间 PR 推到 `N`、第二次仍返回 `H`
 * 上的票，函数会得出 true，而 `N` 没有审官（#1293 三审 P1）。
 *
 * runGh 可注入（测试）；默认走 reviewer 角色的 gh。
 */
export function judgeVerdictOnHead(pr, record, targetRepo, { runGh } = {}) {
  if (!record || !record.sessionKey) return null;   // 没有在役登记，复用判据走不到这一步
  const gh = runGh || ghRunnerForTarget(targetRepo, { role: 'reviewer' });
  const snap = gh(['pr', 'view', String(pr), '--json', 'headRefOid,reviews']);
  if (!snap || !snap.ok) return null;
  let parsed;
  try {
    parsed = JSON.parse(snap.out);
  } catch { return null; }
  const head = String((parsed && parsed.headRefOid) || '').trim();
  if (!head) return null;
  const reviews = parsed && parsed.reviews;
  if (!Array.isArray(reviews)) return null;
  return verdictOnHead(reviews, head);
}

async function cmdReviewPendingDrain(args) {
  const targetRepo = assertCrossRepoOrFail(args.repo, { role: 'reviewer', where: 'review-pending-drain' });
  const ghRepo = targetRepo.ownerName || undefined;
  const dir = reviewPendingDir({ root: ROOT });
  const listed = listReviewPending(dir);
  if (!listed.ok) fail(listed.error, listed);
  const scoped = listed.tickets.filter(t => {
    if (args.pr && String(t.pr) !== String(args.pr)) return false;
    const ticketRepo = t.repo ? String(t.repo).trim() : '';
    // 2026-09-12 实咬：`--pr` 分支原来是 `return !ticketRepo`（有仓字段就当成别仓的票），
    // 但**本仓**的票也带 repo 字段——worker-done 入队那条路一律写 GitHub owner/name
    // （见 cmdWorkerDone 的 enqueueHandoff）。于是 `review-pending-drain --pr 1159`
    // 报「队列共 0 张」：票在队列里，被这一行筛掉了，而 --pr 恰恰是 #1104 说的
    // 「毒票不许拖死整队」的唯一出口——出口自己把真票挡在外面。
    // 判据换成「票仓与本仓不一致才算别仓」，两边都有且不同才剔；跟上面 ghRepo 分支同一把尺。
    const home = ghRepo
      ? String(ghRepo).trim().toLowerCase()
      : resolveDispatchRepo(null)?.toLowerCase() || null;
    if (!ticketRepo) return true;   // 无仓旧票：本仓路径的票，照吃
    // home 推不出（不在 GitHub 仓里跑）时不在筛选上再加一层否决——这里的活是挑票，
    // 不是鉴权；判错方向的代价（真票被静默挡在出口外）比多试一张大得多。
    return !home || ticketRepo.toLowerCase() === home;
  });

  // #1125：闸放在这里而不是指挥官里——`review-pending-drain` 是唯一的拉取入口，
  // 手工跑和指挥官跑必须受同一道闸。放到调用方就会有第二条绕过去的路。
  // --pr 只隔离这一张（#1104 毒票不许拖死整队），仍过容量闸。
  // 不过上限只认 --force，只许人手；指挥官自动化不许带。
  const admit = args.force
    ? { ok: true, pull: scoped, held: [], why: `--force 人手逃生口，不过并发上限` }
    : await admitReviewPull(scoped);
  if (!admit.ok) {
    // 没查成不放行，但也不是失败：票都还在队列，下一轮再来。
    emit({ ok: true, drained: 0, held: admit.held.length, unscanned: true, why: admit.why, dir });
    return;
  }
  const tickets = admit.pull;
  if (args.dryRun) {
    emit({
      ok: true,
      dryRun: true,
      scanned: tickets.length,
      held: admit.held.length,
      why: admit.why,
      tickets,
      dir,
    });
    return;
  }
  const self = fileURLToPath(import.meta.url);
  const drained = drainReviewPending({
    dir,
    tickets,
    // 票上那位起不来时照顺位换人（判据与指挥官同源，见 usableReviewerIds 注释）。
    // `--force` 是**人手**逃生口，人手跑时同样换——人手更不该拿一个已知死掉的模型去试。
    usableReviewers: usableReviewerIds(),
    attach: (plan) => {
      const argv = [...plan.argv];
      if (ghRepo && !argv.includes('--repo')) argv.push('--repo', ghRepo);
      const spawned = spawnSync(process.execPath, [self, ...argv, '--json'], { windowsHide: true,
        encoding: 'utf8',
        cwd: ROOT,
        timeout: 600000,
      });
      // 无 JSON / 超时 / 信号：完整 stderr 进比较键，不在这里截 400 字。
      return attachReceiptFromSpawn(spawned);
    },
  });
  if (!drained.ok) fail(drained.error || 'review-pending-drain 未全部成功', drained);
  emit({ ...drained, held: admit.held.length, why: admit.why, dir });
}

function cmdSend(args) {
  const mira = mirasimVerbGuard('send', { executor: args.executor });
  if (mira.refuse) fail(mira.error, { mirasim: true, pointTo: mira.pointTo });
  fail('orca 已退役，send 随 orca 编排一起删了');
}
function cmdNotify(args) {
  const mira = mirasimVerbGuard('notify', { executor: args.executor, type: args.type });
  if (mira.refuse) fail(mira.error, { mirasim: true, pointTo: mira.pointTo });
  fail('orca 已退役，notify 随 orca 编排一起删了。mirasim 通知走 GitHub 评论 + 飞书 hub');
}

function cmdReply() {
  fail('orca 已退役，reply 随 orca 编排一起删了');
}

function cmdInboxCollect() {
  fail('orca 已退役，inbox-collect 随 orca 编排一起删了');
}

function cmdRunGc() {
  fail('orca 已退役，run-gc 随 orca Run 一起删了');
}

// ── 盘面存档 / 清盘（重测派单前用；存档只留本机，不进 git）──────────────

/** 全量采盘面：卡片/终端/workers/Run（分页扫全）/信箱。每节独立标 ok/没查成。 */

function cmdBoardArchive() {
  fail('orca 已退役，board-archive 不再采 orca 盘面。僵尸卡清扫走 board-gc');
}

function cmdBoardReset() {
  fail('orca 已退役，board-reset 不再采 orca 盘面。僵尸卡清扫走 board-gc --apply');
}

function cmdAsk(args) {
  const mira = mirasimVerbGuard('ask', { executor: args.executor });
  if (mira.refuse) fail(mira.error, { mirasim: true, pointTo: mira.pointTo });
  fail('orca 已退役，ask 随 orca Run 信箱一起删了。mirasim 会话问帅＝直接在回复正文提问');
}

function cmdGateCreate() {
  fail('orca 已退役，gate-create 随 orca 编排一起删了');
}

function cmdGateResolve() {
  fail('orca 已退役，gate-resolve 随 orca 编排一起删了');
}

function cmdGateList() {
  fail('orca 已退役，gate-list 随 orca 编排一起删了');
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

/**
 * 现状盘面（用户 2026-09-04 亲口要的：「一直没反应，就没卡住了还是什么情况」）。
 * 三段（已落地 / 在途 / 待你拍）+ 每段末尾列没查成的源。只读、零副作用。
 * 判据全在 lib/now-board.mjs 的 renderNow（纯函数，机器人问现状将来直接调它）；
 * 取数全在 lib/now-collect.mjs。本函数只负责把两边接起来 + 选人看还是机器看。
 */
/**
 * `commander-act` runs as the service owner (usually `orca`), while an operator
 * may inspect the board as root. Pick the newest readable snapshot source so
 * `dao now` does not silently report the operator's stale ~/.dao directory.
 * An explicit PROGRESS_WATCH_DIR always wins.
 */
export function resolveProgressSnapshotDir({ home = homedir(), list = readdirSync } = {}) {
  const configured = process.env.PROGRESS_WATCH_DIR;
  if (configured) return configured;
  const candidates = [join(home, '.dao', 'commander')];
  if (process.getuid?.() === 0) candidates.push('/home/orca/.dao/commander');
  const ranked = candidates.map((dir) => {
    try {
      const latest = list(dir).filter((n) => /^situation-.*\.json$/i.test(n)).sort().at(-1) || '';
      return { dir, latest };
    } catch {
      return { dir, latest: '' };
    }
  });
  return ranked.sort((a, b) => b.latest.localeCompare(a.latest))[0]?.dir || candidates[0];
}

async function cmdNow(args) {
  const { collectNow } = await import('./lib/now-collect.mjs');
  const { renderNow, formatNow, DEFAULT_WINDOW_HOURS, DEFAULT_MAX_LINES } = await import('./lib/now-board.mjs');
  const { collectProgressStalls } = await import('./progress-watch.mjs');
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const hours = args.hours != null && /^\d+$/.test(String(args.hours)) ? Number(args.hours) : DEFAULT_WINDOW_HOURS;
  const host = args.noServer === true ? null : (args.host || 'contabo');
  const raw = await collectNow({ cwd: root, host, windowHours: hours, now: Date.now() });
  const progressDir = resolveProgressSnapshotDir();
  const progressStalls = collectProgressStalls({ dir: progressDir });
  const board = renderNow({ ...raw, progressStalls, windowHours: hours });
  if (args.json === true) {
    writeStdoutAndExit(`${JSON.stringify({ ok: true, elapsedMs: raw.elapsedMs, progressStateDir: progressDir, board }, null, 2)}\n`);
    return;
  }
  writeStdoutAndExit(`推进记录源：${progressDir}\n${formatNow(board, { maxLines: DEFAULT_MAX_LINES })}\n`);
}

/**
 * 看板 v0（#818）：一张表。判据在 lib/board-v0.mjs，取数在 lib/board-collect.mjs。
 * 总控群「状态」走同一张表，不另造判据。
 */
async function cmdBoard(args) {
  const { collectBoard } = await import('./lib/board-collect.mjs');
  const { formatBoardTable } = await import('./lib/board-v0.mjs');
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const { board, elapsedMs } = await collectBoard({ cwd: root, root, now: new Date().toISOString() });
  if (args.json === true) {
    writeStdoutAndExit(`${JSON.stringify({ ok: true, elapsedMs, updatedAt: board.updatedAt, board }, null, 2)}\n`);
    return;
  }
  writeStdoutAndExit(`${formatBoardTable(board)}\n`);
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
  const r = spawnSync(argv[0], argv.slice(1), { windowsHide: true, stdio: 'inherit' });
  process.exit(r.status == null ? 1 : r.status);
}

/** #842 派前探只读动词：探一个模型（同路径流式），输出与 ndjson 同形。一行分发到 lib/preflight.mjs。 */
async function cmdPreflight(args) {
  const routing = loadOrFail();
  const r = await runPreflightCommand(args, { routingModels: routing.models });
  if (!r.ok) fail(r.error, { model: args.model || null });
  emit({ ok: true, ...r });
}

/** #843 熔断后台动作：reset / trip。ingest-* 给指挥官周期面调，不进 USAGE 主路径。 */
function cmdBreaker(args) {
  const policy = loadDispatchPolicy({});
  const r = runBreakerCommand(args, { now: Date.now(), policy: policy.breaker, dryRun: args.dryRun === true });
  if (!r.ok) fail(r.error, { action: args.action || null, key: args.key || null });
  emit({ ok: true, ...r });
}

/** §73 四轴腿表：status / drop / restore。drop 联动职责树禁用（引擎只读树）。 */
async function cmdLeg(args) {
  const { validateLegs, crossCheckLegsTree, nPlusOneReport, dropImpact, applyLegDrop, applyLegRestore, readLegs } =
    await import('./lib/legs.mjs');
  const file = ROUTING_POLICY_FILE;
  const text = readFileSync(file, 'utf8');
  const doc = JSON.parse(text);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const writeDoc = (nextDoc) => {
    const out = JSON.stringify(nextDoc, null, 2).replace(/\n/g, eol) + eol;
    JSON.parse(out); // 写前自证
    writeFileSync(file, out, 'utf8');
  };
  const selector = args.key
    ? { legIds: [args.key] }
    : args.supplier ? { axis: '供应商', value: args.supplier }
      : args.executor ? { axis: '执行侧', value: args.executor }
        : args.family ? { axis: '族', value: args.family }
          : args.model ? { axis: '模型', value: args.model }
            : null;

  const action = args.action || 'status';
  if (action === 'status') {
    const r = readLegs(doc);
    if (!r.ok) fail(r.error);
    const v = validateLegs(doc);
    const c = crossCheckLegsTree(doc);
    const n = nPlusOneReport(doc);
    emit({
      ok: v.ok && c.ok,
      legs: r.legs.map(l => ({ id: l.id, 状态: l.状态, 族: l.族, 供应商: l.供应商, 执行侧: l.执行侧, ...(l.停用原因 ? { 停用原因: l.停用原因 } : {}) })),
      errors: [...v.errors, ...c.errors],
      warnings: [...v.warnings, ...c.warnings],
      单轴裸奔: n.exposures,
    }, v.ok && c.ok ? 0 : 1);
    return;
  }
  if (action === 'drop') {
    if (!selector) fail('drop 要指名腿（leg drop <腿id>）或轴（--supplier/--executor/--family/--model <值>）');
    const impact = dropImpact(doc, selector);
    if (!impact.ok) fail(impact.error || '影响面没算成');
    if (args.dryRun) {
      emit({ ok: true, dryRun: true, ...impact });
      return;
    }
    if (impact.anyBlack && args.force !== true) {
      fail('拆了会有工种全黑，拒拆（确要拆加 --force，并先想好谁顶上）', { impact });
    }
    const r = applyLegDrop(doc, selector, { why: args.why });
    if (!r.ok) fail(r.error, { impact: r.impact });
    writeDoc(r.doc);
    emit({ ok: true, ...r.changes, impact: r.impact });
    return;
  }
  if (action === 'restore') {
    if (!args.key) fail('restore 要指名腿 id（leg restore <腿id>）');
    const r = applyLegRestore(doc, args.key);
    if (!r.ok) fail(r.error);
    writeDoc(r.doc);
    emit({ ok: true, ...r.changes });
    return;
  }
  fail(`leg 只认 status / drop / restore，实际 ${action}`);
}

// ── #880 卡 C：审官流的 mirasim 执行体路径 ─────────────────────────────────────
// reviewer-create / worker-done 带 --executor mirasim 时走这里：不建 Orca 树/终端，改用
// mirasim-runtime 五动词起审官会话。判定仍落 GitHub review（gh-as reviewer），不发明第二种。
// 合并归一：executor-binding.mjs / docs/model-routing.json「执行体」节 与卡 B 归一（见 PR 正文）。
import {
  mirasimReviewerCreate, mirasimWorkerDone, defaultReviewerRegistry,
  buildMirasimReviewerPrompts, peekReviewerSession,
  reviewerMustReplaceDead,
  decideReviewerCreateStart, decideReworkReviewerHandoff, treeExistsFromProbe, runLockedReviewerCreate,
  readPrHead,
  mustRecheckVerdictUnderLock,
} from './lib/dispatch/reviewer-mirasim.mjs';

function reviewRoundsBudgetOf(root = ROOT) {
  return loadReviewRoundsBudgetFile(join(root, RELEASE_POLICY_REL));
}

function judgeLiveDispatchDay(now) {
  let listed;
  try {
    listed = readLedgerEvents(loadLedgerContext({ root: ROOT }).dir);
  } catch (e) {
    listed = { unscanned: true, error: String(e.message || e), events: [] };
  }
  return judgeDispatchDay({
    events: listed.unscanned ? null : listed.events,
    budget: loadDispatchDayBudgetFile(join(ROOT, RELEASE_POLICY_REL)),
    now: now || new Date(),
  });
}

/** 本仓主 clone 根：由本树 git-common-dir 推。跨仓不走这里，走 resolveMirasimRepoTarget。 */
function thisCheckoutRoot() {
  const r = spawnSync('git', ['-C', ROOT, 'rev-parse', '--git-common-dir'], { windowsHide: true, encoding: 'utf8' });
  if (r.status === 0) {
    let g = String(r.stdout || '').trim();
    if (g) {
      if (!g.startsWith('/')) g = join(ROOT, g);
      if (g.endsWith('/.git')) return dirname(g);
      return g;
    }
  }
  return ROOT;
}

/** 主 clone 根（PR 分支所在的 git 仓）：跨仓解析本地 checkout，否则本树。 */
function mirasimRepoRoot(args, opts) {
  return resolveMirasimRepoTarget(args, opts).localPath || thisCheckoutRoot();
}

/** 读回某树 HEAD 的 sha（读回自证的那一读；读不到抛，交判官判「没查成」）。 */
function gitHeadOf(treePath) {
  const r = spawnSync('git', ['-C', treePath, 'rev-parse', 'HEAD'], { windowsHide: true, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(String(r.stderr || '').trim() || `git rev-parse 失败 exit ${r.status}`);
  return String(r.stdout || '').trim();
}

/**
 * 把复用的审官树推到 PR 新 head（返工轮）。fail-visible：
 *  - 树里有未提交改动 → 拒硬 reset（reset --hard 会吞掉别人的活），报错让人看见；
 *  - 目标 oid 本地没有 → 报错（调用方在这之前已 fetch 过，走到这说明 fetch 没生效）。
 * 写完读回自证：reset 后自己再 rev-parse 一次，对不上就说没同步成，不打假 ✓。
 */
function gitSyncTreeTo(treePath, oid) {
  const want = String(oid || '').trim();
  if (!want) return { ok: false, error: '没给要同步到的 oid（没查成）' };
  const st = spawnSync('git', ['-C', treePath, 'status', '--porcelain'], { windowsHide: true, encoding: 'utf8' });
  if (st.status !== 0) {
    return { ok: false, error: `读审官树 ${treePath} 状态失败（没查成）：${String(st.stderr || '').trim().slice(0, 200)}` };
  }
  const dirty = String(st.stdout || '').trim();
  if (dirty) {
    return {
      ok: false,
      error: `审官树 ${treePath} 有未提交改动，拒硬同步（怕吞活）：${dirty.split('\n').slice(0, 3).join(' | ')}`,
      dirty: dirty.split('\n').slice(0, 10),
    };
  }
  const has = spawnSync('git', ['-C', treePath, 'cat-file', '-e', `${want}^{commit}`], { windowsHide: true, encoding: 'utf8' });
  if (has.status !== 0) return { ok: false, error: `审官树里没有 ${want.slice(0, 12)} 这个 commit（fetch 没生效？没查成）` };
  const rs = spawnSync('git', ['-C', treePath, 'reset', '--hard', want], { windowsHide: true, encoding: 'utf8' });
  if (rs.status !== 0) {
    return { ok: false, error: `reset --hard ${want.slice(0, 12)} 失败：${String(rs.stderr || '').trim().slice(0, 200)}` };
  }
  let after;
  try { after = gitHeadOf(treePath); }
  catch (e) { return { ok: false, error: `同步后读回 HEAD 失败（没查成）：${String(e?.message || e)}` }; }
  if (after !== want && !after.startsWith(want) && !want.startsWith(after)) {
    return { ok: false, error: `reset 报成功但读回 HEAD 还是 ${after.slice(0, 12)}（不打假 ✓）`, treeHead: after };
  }
  return { ok: true, treeHead: after, from: null, to: want };
}

/**
 * 把 origin/<PR 分支> 取到本地，并把审官分支 reviewBranch 建/移到 PR head OID（等同 orca
 * 「新树停在 PR head」，避开 PR 分支已被别的树 checkout 的撞车）。失败返回 {ok:false}。
 *
 * 该审官分支已被某棵树 checkout 时 git 不让 `branch -f`，这里如实跳过并回 checkedOut:true——
 * 推那棵树的活归 gitSyncTreeTo（返工轮由编排层在 HEAD 闸上调），不是这里静默算完。
 */
function gitFetchRef(repo, prBranch, expectedOid, reviewBranch) {
  const fe = spawnSync('git', ['-C', repo, 'fetch', 'origin', prBranch], { windowsHide: true, encoding: 'utf8', timeout: 90000 });
  if (fe.status !== 0) return { ok: false, error: `git fetch origin ${prBranch} 失败：${String(fe.stderr || '').trim().slice(0, 200)}` };
  const branch = reviewBranch || prBranch;
  const target = expectedOid || `origin/${prBranch}`;
  let checkedOut = false;
  if (branch !== prBranch) {
    // 该审官分支已被某树 checkout 就别硬移（git 不让）；推那棵树归 gitSyncTreeTo。
    const wl = spawnSync('git', ['-C', repo, 'worktree', 'list', '--porcelain'], { windowsHide: true, encoding: 'utf8' });
    const lines = wl.status === 0 ? String(wl.stdout || '').split('\n').map(x => x.trim()) : [];
    checkedOut = lines.includes(`branch refs/heads/${branch}`);
    if (!checkedOut) {
      const br = spawnSync('git', ['-C', repo, 'branch', '-f', branch, target], { windowsHide: true, encoding: 'utf8' });
      if (br.status !== 0) return { ok: false, error: `建审官分支 ${branch}@${String(target).slice(0, 12)} 失败：${String(br.stderr || '').trim().slice(0, 200)}` };
    }
  }
  return { ok: true, branch, checkedOut, target: String(target) };
}

/** mirasim 审官路径的 merge-policy：走与 orca 同一条 lookupReviewerMergePolicy（不硬编码 auto）。
 * 无署名且没有显式旗标：取不到 human_holds，直接 manual，不翻账本（账本缺字段会 fallback auto）。 */
function mirasimMergePolicy(args, { issue, pr, dispatchId } = {}) {
  const hasIssue = issue != null && String(issue).trim() !== '';
  if (!hasIssue && !String(args.mergePolicy || '').trim()) {
    return unsignedIssueMergePolicy();
  }
  return lookupReviewerMergePolicy({
    explicitPolicy: args.mergePolicy,
    explicitReason: args.mergeReason,
    issue,
    pr,
    dispatchId: dispatchId || null,
    // mirasim 路径没有 orca 卡，不给 worktreeSel（免得 lookup 去 orca 捞盘面）。
  });
}

/**
 * PR → 审官会话登记。落点必须**跨树共享**，不能跟着 ROOT 走。
 *
 * 2026-09-06 实咬：原来是 `join(ROOT, '_flow', 'mirasim')`，而 ROOT 是「谁在跑这条命令」
 * 那棵树。主树里跑 `reviewer-create --pr 1040` 读到登记 → 判 reused；换一棵 worktree 跑
 * 同一条命令 → 目录是空的 → 判「没有审官」→ 重复起会话。这既烧额度，也直接破掉
 * 「一 PR 一审官」（memory one-pr-one-reviewer）。
 *
 * 同时它本来就该在 `~/.dao/` 下：CLAUDE.md「派生数据不进 git（影响地图、账本、健康表都落
 * ~/.dao/）」。`_flow/` 虽然被 .gitignore 挡住了，但落在仓内就一定跟着树分叉。
 */
/**
 * 一 PR 一把锁。**登记本身不是互斥**（审官 PR #1071 判红第 2 条实咬）：
 * `read → 起会话 → write` 之间没有原子 claim，两棵树并发跑 reviewer-create 时
 * 都能在对方写盘前读到 missing，于是各起一个 session，后写覆盖前写——
 * 登记看着只有一条，额度已经烧了两份，「一 PR 一审官」名存实亡。
 * 锁文件按仓+PR 分（本仓仍是 reviewer-<pr>.lock），复用既有的 O_EXCL 原语
 * （持锁进程死了自动拆），不另造一套。两个仓的同号 PR 不许共用一把锁。
 */
function reviewerLockPath(pr, repo) {
  const keyed = repoPrKey({ repo, pr });
  // 键没做成不许回落到纯 PR 号（两个仓同号会共用一把锁）。
  const stem = keyed.ok ? keyed.stem : `.invalid-${String(pr ?? '').trim()}`;
  return join(dirname(defaultLockPath()), `reviewer-${stem}.lock`);
}

function mirasimRegistry() {
  return defaultReviewerRegistry({
    readFile: p => readFileSync(p, 'utf8'),
    writeFile: (p, c) => writeFileSync(p, c, 'utf8'),
    mkdir: d => mkdirSync(d, { recursive: true }),
    readdir: d => readdirSync(d),
    join,
    flowDir: join(homedir(), '.dao', 'mirasim'),
  });
}

/**
 * 取「上一位审官是谁、死于什么」——#1122 换厂凭证的唯一来源。
 *
 * 读不到一律回空死因：那样 assertReviewerSeat 会走老规矩（只许同厂换顺位），
 * 也就是**没查成时不放宽**。把「读不到」当成「死于满载」会让换厂变成常开的后门。
 */
async function readReviewerDeathNote(runtime, args, ownerName) {
  if (args.dryRun) return { deadModelId: null, deadError: '' };
  try {
    const rec = mirasimRegistry().read(args.pr, ownerName);
    const key = rec && rec.ok && rec.record ? rec.record.sessionKey : '';
    if (!key) return { deadModelId: null, deadError: '' };
    const peek = await peekReviewerSession(runtime, key);
    const view = peek && peek.view;
    // 只有终态会话的死因才算数：还在跑的那个不是「死了」，是「没审完」。
    if (!view || view.missing === true || String(view.phase || '').toLowerCase() === 'running') {
      return { deadModelId: null, deadError: '' };
    }
    return {
      deadModelId: rec.record.reviewer || null,
      deadError: view.error == null ? '' : String(view.error).trim(),
    };
  } catch {
    return { deadModelId: null, deadError: '' };
  }
}

async function cmdReviewerCreateMirasim(args) {
  enableRealExecutorUnlessTest(process.env);
  if (!args.pr) fail('reviewer-create 要 --pr');
  const targetRepo = resolveMirasimRepoTarget(args, { role: 'reviewer', where: 'reviewer-create', defaultLocal: thisCheckoutRoot() });
  const gh = ghRunnerForTarget(targetRepo, { role: 'reviewer' });
  const routing = loadOrFail();
  const execPolicy = readExecutorPolicy(routing);
  const named = judgeExecutorName(args.executor, execPolicy);
  if (!named.ok) fail(named.error, { executor: args.executor });
  const bind = bindExecutor({ executor: named.name, routing });
  if (!bind.ok) fail(bind.error, { executor: named.name });

  // #1116：先按 PR head 分支从账本打标，再只读 PR label。
  // 没查成 / 不是派工链：打不上不挡，PR 上已有标就认。
  // 已查成的冲突/歧义（账本 vs 标签不一致、多个 reviewer/*）和已查成坏账
  // （缺 model、非法 identity）：直接 fail-closed，不许再猜。
  const stamped = stampPrFromLedger({ pr: args.pr, runGh: gh, repo: targetRepo.ownerName });
  warnOrFailLedgerStamp(stamped, args.pr);

  const picked = resolveReviewerFromPr({ pr: args.pr, reviewer: args.reviewer, runGh: gh });
  if (!picked.ok) fail(picked.error, { reviewer: picked, pr: String(args.pr) });
  const worker = resolveWorkerFromPr({ pr: args.pr, runGh: gh });
  if (!worker.ok) fail(worker.error, { worker, pr: String(args.pr) });
  // #1122 换厂凭证：只有「上一位审官的会话死于满载/看门狗」才配得上跨厂。
  // 证据从登记在案的那个会话上取——不是一个调用方能自己声明的旗标。
  const failover = await readReviewerDeathNote(bind.runtime, args, targetRepo.ownerName || null);
  const failoverCtx = capacityFailoverCtx({ failover, workerId: worker.modelId, routing });
  // 标签还钉着刚死的那位时，按顺位取下一位——否则闸口永远卡在「请求的必须等于下一位」。
  const planned = planReviewerOnCapacityDeath({
    requested: picked.modelId, capacityFailover: failoverCtx,
  });
  if (!planned.ok) fail(planned.error, { capacityPlan: planned, pr: String(args.pr) });
  picked.modelId = planned.reviewerId;
  // #679 同厂硬闸：orca 路一直有，mirasim 路原来没有。2026-09-06 把默认执行体翻成 mirasim
  // 的那一刻，不补这一句就等于顺手关掉了这道闸——切流量必须把闸一起搬过去，
  // 否则「闸还在代码里」和「闸还在这条路上」是两回事（memory bypassing-wrapper-loses-its-checks）。
  // 闸在选人之后：换厂前标签上的死人可能与工人同厂，先闸会把退路自己砍掉。
  const listedRounds = listPrReviews({ pr: args.pr, runGh: gh });
  if (!listedRounds.ok) fail(listedRounds.error, { pr: String(args.pr) });
  const reviewRounds = judgeNextReviewRound({
    reviews: listedRounds.reviews, budget: reviewRoundsBudgetOf(targetRepo.localPath),
  });
  if (nextReviewRoundBlocked(reviewRounds)) {
    const haltError = reviewRounds.state === 'exceeded'
      ? reviewRoundsExceededError({
        pr: args.pr, rounds: reviewRounds.rounds, max: reviewRounds.max,
      })
      : reviewRoundsUnscannedError({ pr: args.pr, error: reviewRounds.error });
    fail(haltError, { pr: String(args.pr), reviewRounds });
  }
  const vendorGate = refuseIfSameVendor({
    workerId: worker.modelId, reviewerId: picked.modelId, routing,
  });
  const seat = assertReviewerSeat({
    reviewerId: picked.modelId, routing,
    capacityFailover: failoverCtx,
  });
  if (!seat.ok) fail(seat.error, { reviewerSeat: seat, vendorGate, capacityPlan: planned, pr: String(args.pr) });
  const routeDbg = judgeAgentRoute(picked.modelId, bind.mirasim);
  if (!routeDbg.ok) fail(routeDbg.error, { route: routeDbg, reviewer: picked.modelId });

  const issueRef = args.issue || (Array.isArray(worker.refs) && worker.refs[0]) || null;
  // #886 审官第 4 条：merge-policy 从原派工恢复（显式旗标 > 账本 > 卡备注），不许硬编码 auto。
  // 快路无署名单：取不到 human_holds，走与 worker-done 同一条 no-issue manual，不许 fallback auto。
  const policyPlan = mirasimMergePolicy(args, {
    issue: issueRef, pr: args.pr, dispatchId: args.soldierDispatch || null,
  });
  if (!policyPlan.ok) fail(policyPlan.error, { policyPlan, pr: String(args.pr) });
  const books = buildMirasimReviewerPrompts({
    pr: String(args.pr), issue: issueRef,
    soldierDispatchId: args.soldierDispatch != null ? String(args.soldierDispatch) : '',
    policyPlan, render: buildReviewerInject,
  });
  if (!books.ok) fail(books.error, { policyPlan, pr: String(args.pr) });

  const registry = mirasimRegistry();
  const ownerName = targetRepo.ownerName || null;
  // 撞满载必须另起：登记里还是刚死的那位，不带 force 会被一 PR 一审官闸当成「已有」复用。
  // 不绑 planned.switched：点名正好是下一位时 switched=false，但死会话仍必须另起。
  // #1024：键是仓+PR，跨仓同号不复用别仓的会话。
  const existing = registry.read(args.pr, ownerName);
  if (existing && existing.ok !== true && existing.missing !== true) {
    fail(`审官登记没查成，不起第二个审官：${existing.why || '没给原因'}`, {
      executor: 'mirasim', stage: 'registry', pr: String(args.pr),
    });
  }
  const existingRecord = existing.ok ? existing.record : null;
  const peek = args.dryRun || !existingRecord || !existingRecord.sessionKey
    ? { view: null, why: args.dryRun ? 'dry-run 不探会话' : null }
    : await peekReviewerSession(bind.runtime, existingRecord.sessionKey);
  // #1289：复用还要问一句「它真的交了判定吗」。会话 phase=done 只说明会话结束了，
  // 不说明活干完了——实测审官把结论写在会话文本里却从没调 gh pr review，
  // 下一轮复用它，PR 就永久冻着。判据是 GitHub 上当前 head 有没有判定，三态。
  const verdict = judgeVerdictOnHead(args.pr, existingRecord, targetRepo);
  const outerHead = existingRecord && existingRecord.sessionKey
    ? readPrHead(gh, args.pr)
    : { ok: false };
  const outerLiveHead = outerHead.ok === true ? outerHead.expectedOid : null;
  const decided = decideReviewerCreateStart({
    force: args.force, switched: planned.switched, deadError: failover.deadError,
    record: existingRecord, view: peek.view, verdictOnHead: verdict, liveHead: outerLiveHead,
  });
  const forceNew = decided.forceNew;
  // #886 审官第 2 条：一 PR 一审官。登记里已有在役会话就复用/返回，不再起第二个烧额度。
  // #1293 二审 P1：终态 reuse 的判定快照会过期。锁外 true 若在这里 emit 退出，
  // 下面 lockedVerdict 重读根本跑不到——等锁期间推了新 head，新提交就没有审官。
  // dry-run 仍按锁外快照预览（本来就不进锁）。
  if (decided.reuse.reuse && (args.dryRun || !mustRecheckVerdictUnderLock({
    reuse: true, view: peek.view,
  }))) {
    emit({
      ok: true, executor: 'mirasim', outcome: 'reused', pr: String(args.pr),
      reviewer: picked.modelId, worker: worker.modelId, sessionKey: decided.reuse.sessionKey,
      agent: existingRecord.agent || null, treePath: existingRecord.treePath || null,
      expectedOid: existingRecord.expectedOid || null,
      liveHead: outerLiveHead,
      mergePolicy: books.mergePolicy, mergePolicySource: books.source,
      reuse: { reuse: true, checked: decided.reuse.checked, why: decided.reuse.why, peekWhy: peek.why || null },
      why: `${decided.reuse.why}（要另起加 --force）`,
    });
  }


  const repo = targetRepo.localPath;
  if (args.dryRun) {
    emit({
      ok: true, dryRun: true, executor: 'mirasim', pr: String(args.pr), reviewer: picked.modelId,
      reviewerSource: picked.source || null,
      worker: worker.modelId, workerModel: worker.modelId, agent: routeDbg.agent, mode: routeDbg.mode, repo,
      ghRepo: targetRepo.ownerName || null,
      vendorGate, reviewerSeat: seat,
      mergePolicy: books.mergePolicy, mergeReason: books.mergeReason, mergePolicySource: books.source,
    });
    return;
  }

  // 起会话 + 写登记必须在同一把 per-PR 锁里，并在锁内**再读一次登记**（double-check）：
  // 上面那次 read 在锁外，只挡得住「已经起过的」，挡不住「正在起的」。
  // 复用结果发出前必须在锁内重读 PR head：锁外快照在等锁期间会过期，沿用它会把旧
  // head 上的会话报成 reused（本闸要修的竞态）。新建路径同样只用这次锁内读取。
  const guarded = await withWorktreeLock(async () => {
    const again = registry.read(args.pr, ownerName);
    if (again && again.ok !== true && again.missing !== true) {
      return {
        res: {
          ok: false,
          stage: 'registry',
          error: `锁内复查审官登记没查成，不起第二个审官：${again.why || '没给原因'}`,
        },
        w: null,
      };
    }
    const againRecord = again.ok ? again.record : null;
    // 锁内复查走同一套 reuse 判据：满载死会话不算 raced。只看 sessionKey 会把刚死的那位当并发已起。
    const racePeek = (againRecord && againRecord.sessionKey)
      ? await peekReviewerSession(bind.runtime, againRecord.sessionKey)
      : { view: null };
    const lockedHead = readPrHead(gh, args.pr);
    const lockedLiveHead = lockedHead.ok === true ? lockedHead.expectedOid : null;
    // #1293 审官 P1（第二轮实咬）：锁外那份 verdict 在等锁期间可能已过期——
    // 锁外快照是「旧 head 有判定（true）」，等锁期间 PR 推了新 head 而新 head 还没判定，
    // 拿旧值判 race 会把终态会话误报 reused，新提交就没有审官。
    // 复用判定必须在持锁后重读当前 headRefOid + reviews（同一次快照），用这份锁内快照。
    // forceNew 为真时 judgeReviewerCreateRace 短路、根本不看 verdictOnHead，省掉这次 gh 快照。
    const lockedVerdict = (!forceNew && againRecord && againRecord.sessionKey)
      ? judgeVerdictOnHead(args.pr, againRecord, targetRepo)
      : null;
    const decided = decideReviewerCreateStart({
      force: args.force, switched: planned.switched, deadError: failover.deadError,
      record: againRecord, view: racePeek.view, liveHead: lockedLiveHead, verdictOnHead: lockedVerdict,
    });
    const locked = await runLockedReviewerCreate({
      forceNew, record: againRecord, view: racePeek.view, verdictOnHead: lockedVerdict, liveHead: lockedLiveHead,
      create: async () => {
        const created = await mirasimReviewerCreate({
          runtime: bind.runtime, gh, readTreeHead: gitHeadOf,
          prepareRef: (r, b, oid, rb) => gitFetchRef(r, b, oid, rb),
          syncTree: (p, oid) => gitSyncTreeTo(p, oid),
          pr: String(args.pr), repo, reviewerModel: picked.modelId, workerModel: worker.modelId,
          models: routing.models, mirasimPolicy: bind.mirasim, prompt: books.prompt,
          reviewBranch: `dao-review-pr-${args.pr}`,
        });
        if (!created.ok) return created;
        // #886 审官第 3 条：登记写失败 fail-closed——不许在没持久化时报 created（重试会起第二个会话）。
        return {
          ...created,
          registryWrite: registry.write(args.pr, {
            pr: String(args.pr), repo: ownerName, sessionKey: created.sessionKey, agent: created.agent, treePath: created.treePath,
            // reviewer 这一栏是 #1122 换厂链能不能往前走的前提：不记下**这一位是谁**，
            // 下一轮只能拿审官位顶位（luna）当「上一位」，于是 luna→sol 之后永远还是算出 sol，
            // 链子卡在第一格。实咬：sol 也撞满载后，换厂仍报「按顺位该换 gpt-5.6-sol」。
            reviewer: picked.modelId,
            round: 'first', headRefName: created.headRefName, expectedOid: created.expectedOid,
            treeHead: created.treeHead || null, ts: Date.now(),
          }),
        };
      },
    });
    if (locked.raced) {
      return {
        raced: true,
        record: againRecord,
        why: locked.why,
        checked: decided.reuse.checked,
        peekWhy: racePeek.why || null,
        liveHead: lockedLiveHead,
      };
    }
    const created = locked.res;
    if (!created || !created.ok) return { res: created };
    return { res: created, w: created.registryWrite };
  }, { lockPath: reviewerLockPath(args.pr, ownerName) });

  // 锁没拿到 = 没查成，不是「可以起」。硬失败，别在没有互斥的情况下烧第二份额度。
  if (guarded && guarded.ok === false && guarded.locked === false) {
    fail(`审官锁没拿到（${guarded.error}）——不在没有互斥的情况下起会话`, {
      executor: 'mirasim', stage: 'lock', pr: String(args.pr),
    });
  }
  if (guarded.raced) {
    const reuseWhy = guarded.why || '锁内复查：这个 PR 已经有审官会话了';
    emit({
      ok: true, executor: 'mirasim', outcome: 'reused', pr: String(args.pr),
      reviewer: picked.modelId, worker: worker.modelId, sessionKey: guarded.record.sessionKey,
      agent: guarded.record.agent || null, treePath: guarded.record.treePath || null,
      expectedOid: guarded.record.expectedOid || null,
      liveHead: guarded.liveHead || null,
      mergePolicy: books.mergePolicy, mergePolicySource: books.source,
      reuse: {
        reuse: true,
        checked: guarded.checked ?? false,
        why: reuseWhy,
        peekWhy: guarded.peekWhy || null,
      },
      why: `${reuseWhy}（要另起加 --force）`,
    });
  }
  const res = guarded.res;
  const w = guarded.w;
  if (!res.ok) fail(res.error, { executor: 'mirasim', stage: res.stage, ...res });

  if (!w || w.ok !== true) {
    fail(
      `审官会话已起（sessionKey=${res.sessionKey}）但写登记失败，判失败（fail-closed，不许当 created）：${(w && w.error) || '写盘没回 ok'}`,
      { executor: 'mirasim', stage: 'registry', pr: String(args.pr), sessionKey: res.sessionKey, treePath: res.treePath, registryWrite: w || null },
    );
  }
  emit({
    ok: true, executor: 'mirasim', outcome: 'created', pr: String(args.pr),
    reviewer: picked.modelId, worker: worker.modelId, sessionKey: res.sessionKey, taskId: res.taskId,
    agent: res.agent, mode: res.mode, treePath: res.treePath, headRefName: res.headRefName,
    expectedOid: res.expectedOid, treeHead: res.treeHead, mergeable: res.mergeable, treeSync: res.treeSync,
    mergePolicy: books.mergePolicy, mergeReason: books.mergeReason, mergePolicySource: books.source,
    registryWrite: w,
  });
}

async function cmdWorkerDoneMirasim(args) {
  enableRealExecutorUnlessTest(process.env);
  if (!args.pr) fail('worker-done 要 --pr');
  let body = args.body;
  if (args.bodyFile) {
    try { body = readFileSync(args.bodyFile, 'utf8'); }
    catch (e) { fail(`worker-done 读 --body-file 失败：${e.message || e}`); }
  }
  const targetRepo = resolveMirasimRepoTarget(args, { role: 'worker', where: 'worker-done', defaultLocal: thisCheckoutRoot() });
  const gh = ghRunnerForTarget(targetRepo, { role: 'worker' });
  const ghR = ghRunnerForTarget(targetRepo, { role: 'reviewer' });
  // #1116：先按 PR head 分支从账本打标，再只读 PR label。
  // 没查成 / 不是派工链：打不上不挡，没标由 plan 拒。
  // 已查成的冲突/歧义/坏账（缺 model、非法 identity）：直接 fail-closed，不许再猜。
  const stamped = stampPrFromLedger({ pr: args.pr, runGh: gh, repo: targetRepo.ownerName });
  warnOrFailLedgerStamp(stamped, args.pr);
  // #895 快马单没有 reviewer/* label，靠显式 --reviewer 指名。这个参数原来只接在 orca 路的
  // 调用点上（memory fix-landed-at-one-call-site-only），mirasim 路漏传 → 快马单在这条路上
  // 一律「没有 reviewer/* label」拒掉。label 优先级不变：不传才自读。
  const plan = planWorkerDone({
    pr: args.pr, body, runGh: gh, reviewer: args.reviewer,
    reviewRoundsBudget: reviewRoundsBudgetOf(targetRepo.localPath),
  });
  if (!plan.ok) fail(plan.error, plan);
  const routing = loadOrFail();
  const execPolicy = readExecutorPolicy(routing);
  const named = judgeExecutorName(args.executor, execPolicy);
  if (!named.ok) fail(named.error);
  const bind = bindExecutor({ executor: named.name, routing });
  if (!bind.ok) fail(bind.error);

  // 工人模型：跨厂闸与新起会话要。首审 plan.workerModel 有；返工轮从 PR 标签兜。
  let workerModel = plan.workerModel;
  if (!workerModel) {
    const worker = resolveWorkerFromPr({ pr: args.pr, runGh: ghR });
    workerModel = worker.ok ? worker.modelId : null;
  }
  // #1122：登记会话死于满载时按顺位换下一位，再过同厂闸。闸必须在选人之后，
  // 否则标签上的死人会把退路自己砍掉。
  const failover = await readReviewerDeathNote(bind.runtime, args, targetRepo.ownerName || null);
  const failoverCtx = capacityFailoverCtx({ failover, workerId: workerModel, routing });
  const planned = planReviewerOnCapacityDeath({
    requested: plan.reviewer, capacityFailover: failoverCtx,
  });
  if (!planned.ok) fail(planned.error, { capacityPlan: planned, ...plan });
  plan.reviewer = planned.reviewerId;
  refuseIfSameVendor({ workerId: workerModel, reviewerId: plan.reviewer, routing });

  // #886 审官第 4 条：审官任务书的 m= 必须来自原派工，不许硬编码 auto——原单 m=manual
  // 却给审官注入 m=auto，审官会绕过「需人工合并」的边界。
  // 快路无署名单：mirasimMergePolicy 走 no-issue manual（与 commander-core 快路返工同一失败方向）。
  const policyPlan = mirasimMergePolicy(args, {
    issue: plan.issue, pr: plan.pr, dispatchId: args.soldierDispatch || null,
  });
  if (!policyPlan.ok) fail(policyPlan.error, { policyPlan, ...plan });
  const books = buildMirasimReviewerPrompts({
    pr: String(plan.pr), issue: plan.issue,
    soldierDispatchId: args.soldierDispatch != null ? String(args.soldierDispatch) : '',
    policyPlan, render: buildReviewerInject,
  });
  if (!books.ok) fail(books.error, { policyPlan, ...plan });

  if (args.dryRun) {
    const haltWhy = plan.halt === REVIEW_ROUNDS_HALT
      ? reviewRoundsExceededError({
        pr: plan.pr, rounds: (plan.reviewRounds || {}).rounds, max: (plan.reviewRounds || {}).max,
      })
      : plan.halt === REVIEW_ROUNDS_UNSCANNED
        ? reviewRoundsUnscannedError({ pr: plan.pr, error: (plan.reviewRounds || {}).error })
        : null;
    emit({
      ok: true, dryRun: true, executor: 'mirasim', settled: false, ...plan, workerModel,
      mergePolicy: books.mergePolicy, mergeReason: books.mergeReason, mergePolicySource: books.source,
      ...(haltWhy
        ? { action: plan.halt, why: haltWhy }
        : plan.round === 'first'
          ? { action: 'queued-for-review', why: '首审 dry-run：将入待审队列，不起审官（#1125）' }
          : {}),
    });
    return;
  }

  let postedIssue = { ok: true, skipped: true, why: '快路无署名单，完工评论只发 PR' };
  if (plan.issue != null) {
    postedIssue = postCommentOnce({
      kind: 'issue', number: plan.issue, body: plan.comment, runGh: gh,
      writeIssue: applyIssueWrite, host: 'worker-done',
      // 跨仓交卷必须把 owner/name 交给网关。不传会落到默认 windsurf-dao，正是本单禁止的回落。
      repo: targetRepo.ownerName || undefined,
      idempotency_key: `worker-done:issue:${plan.pr}:${plan.issue}`,
    });
  }
  if (!postedIssue.ok) fail(postedIssue.error, { ...plan, postedIssue });
  const postedPr = postCommentOnce({ kind: 'pr', number: plan.pr, body: plan.comment, runGh: gh });
  if (!postedPr.ok) fail(postedPr.error, { ...plan, postedIssue, postedPr });

  // #1125 主路：交卷**只入队，不起审官**。
  //
  // 病：起审官原来发生在工人交卷那一刻，于是**生产端决定了消费端的并发**——工人跑得多快，
  // 审官就被起得多快，而没有任何人在看上游还剩多少容量。2026-09-07 实测 13 个工人在跑、
  // 26 张开放 PR，而 gptpool 只剩一条腿（约 3 个并发），13 个审官里 8 个死于 at capacity。
  //
  // 队列本身早就有（#815），但当初是给 Orca depth 2 限制做的**起败兜底**，Orca 已随 #1115
  // 退役，理由没了、机制留着。这里把它接成主路：交卷入队，指挥官按在役审官数拉取。
  //
  // 首审一律入队。返工：审官树还在才往原会话推针；确认登记不在或树已拆才入队。
  // 登记没查成 / 缺 treePath / 树在不在没查成，一律 fail-visible，不许当成树已拆去起第二个审官。
  const repo = targetRepo.localPath;
  const enqueueHandoff = async (why) => {
    const dir = reviewPendingDir({ root: ROOT });
    let head = { name: null, oid: null };
    try {
      head = { name: null, oid: gitHeadOf(process.cwd()) };
    } catch { /* 失败票路径会 gh pr view；这里拿不到就退回 pr:N，不猜 */ }
    const built = buildReviewPendingTicket({
      pr: String(plan.pr), issue: plan.issue, reviewer: plan.reviewer, round: plan.round,
      workerModel, soldierDispatch: args.soldierDispatch || null,
      workerWorktree: repo,
      head,
      source: REVIEW_PENDING_SOURCE_WORKER_DONE_HANDOFF,
      // 仓键用 GitHub owner/name，不许把 localPath 塞进来（路径过不了 parseOwnerNameRepo，还会把跨仓票落到 12.json）。
      repo: targetRepo.ownerName || null,
      mergePolicy: books.mergePolicy,
      mergeReason: books.mergeReason,
    });
    if (!built.ok) fail(built.error, { ...plan, postedIssue, postedPr });
    const wrote = writeReviewPending({ dir, ticket: built.ticket });
    // 写票失败 fail-closed：报 ok 而票没落盘 = 这张 PR 从此没人管，比起审官失败更难发现。
    if (!wrote.ok) fail(wrote.error, { ...plan, postedIssue, postedPr });
    let stopped = { ok: true, skipped: true };
    try {
      stopped = await stopSessionsAtCwd(bind.runtime, process.cwd());
    } catch (e) {
      fail(`交卷后停会话没查成：${e && e.message ? e.message : e}`, { ...plan, postedIssue, postedPr });
    }
    emit({
      ok: true, executor: 'mirasim', commentPosted: true, settled: false, ...plan,
      mergePolicy: books.mergePolicy, mergeReason: books.mergeReason, mergePolicySource: books.source,
      postedIssue, postedPr, action: 'queued-for-review',
      reviewPending: { path: wrote.path, source: built.ticket.source },
      stopped,
      why,
    });
  };
  if (plan.halt === REVIEW_ROUNDS_HALT || plan.halt === REVIEW_ROUNDS_UNSCANNED) {
    const rr = plan.reviewRounds || {};
    let stopped = { ok: true, skipped: true };
    try {
      stopped = await stopSessionsAtCwd(bind.runtime, process.cwd());
    } catch (e) {
      fail(`交卷后停会话没查成：${e && e.message ? e.message : e}`, { ...plan, postedIssue, postedPr });
    }
    if (!stopped || stopped.ok !== true) {
      fail(`交卷后停会话失败：${(stopped && stopped.error) || '没查成'}`, { ...plan, postedIssue, postedPr, stopped });
    }
    emit({
      ok: true, executor: 'mirasim', commentPosted: true, settled: false, ...plan,
      mergePolicy: books.mergePolicy, mergeReason: books.mergeReason, mergePolicySource: books.source,
      postedIssue, postedPr, action: plan.halt,
      stopped,
      why: plan.halt === REVIEW_ROUNDS_HALT
        ? reviewRoundsExceededError({ pr: plan.pr, rounds: rr.rounds, max: rr.max })
        : reviewRoundsUnscannedError({ pr: plan.pr, error: rr.error }),
    });
    return;
  }
  if (plan.round === 'first') {
    await enqueueHandoff('首审已入待审队列，由指挥官按在役审官数拉取（#1125）——工人不再自己起审官');
    return;
  }
  const rec = mirasimRegistry().read(String(plan.pr), targetRepo.ownerName || null);
  const reviewTree = rec && rec.ok && rec.record && rec.record.treePath != null
    ? String(rec.record.treePath).trim()
    : '';
  // probeDir 而不是 existsSync：后者把 EACCES 洗成 false，随后按树已拆入队。
  const treeExists = reviewTree
    ? treeExistsFromProbe(probeDir(statSync, reviewTree))
    : undefined;
  const handoff = decideReworkReviewerHandoff({ rec, treeExists });
  if (handoff.action === 'fail') fail(handoff.why, { ...plan, postedIssue, postedPr });
  if (handoff.action === 'enqueue') {
    await enqueueHandoff(handoff.why);
    return;
  }

  const res = await mirasimWorkerDone({
    runtime: bind.runtime, gh: ghR, readTreeHead: gitHeadOf,
    prepareRef: (r, b, oid, rb) => gitFetchRef(r, b, oid, rb),
    syncTree: (p, oid) => gitSyncTreeTo(p, oid),
    registry: mirasimRegistry(),
    pr: String(plan.pr), repo, ownerName: targetRepo.ownerName || null,
    prompt: books.prompt,
    reworkPrompt: books.reworkPrompt,
    reviewerModel: plan.reviewer, workerModel,
    models: routing.models, mirasimPolicy: bind.mirasim, round: plan.round,
    reviewBranch: `dao-review-pr-${plan.pr}`, force: reviewerMustReplaceDead({
      force: args.force, switched: planned.switched, deadError: failover.deadError,
    }),
  });
  if (!res.ok) fail(res.error, { executor: 'mirasim', stage: res.stage, ...res, postedIssue, postedPr });
  let stopped = { ok: true, skipped: true };
  try {
    stopped = await stopSessionsAtCwd(bind.runtime, process.cwd());
  } catch (e) {
    fail(`交卷后停会话没查成：${e && e.message ? e.message : e}`, { ...plan, postedIssue, postedPr });
  }
  emit({
    ok: true, executor: 'mirasim', commentPosted: true, settled: false, ...plan,
    mergePolicy: books.mergePolicy, mergeReason: books.mergeReason, mergePolicySource: books.source,
    postedIssue, postedPr, action: res.action, session: res.session || null, interact: res.interact || null,
    sessionKey: res.sessionKey || res.session?.sessionKey || null, treeSync: res.treeSync || null,
    reuse: res.reuse ? { reuse: res.reuse.reuse, checked: res.reuse.checked, why: res.reuse.why } : null,
    stopped,
  });
}

/**
 * #1055：指挥官一次性会话的 mirasim 起法。
 *
 * orca 是两步（start 起 TUI + send 注入指针）。mirasim 是一步：prompt 本身就是注入，
 * 收到 accepted 就返回 sessionKey。workdir 优先 --worktree（已经是路径时直接用），
 * 否则 ensureWorkspace(repo, branch) 建/复用树。
 */
async function cmdStartMirasim(args) {
  if (!args.prompt) fail('start --executor mirasim 要 --prompt（注入本身就是起会话的那一帧）');
  if (!args.model) fail('start --executor mirasim 要 --model');
  const routing = loadOrFail();
  const bind = bindExecutor({ executor: 'mirasim', routing });
  if (!bind.ok) fail(bind.error, { executor: 'mirasim' });
  // #1059 合入时仍按旧签名 (model, mirasimPolicy) 调；本 PR 已把 mirasimRouteOrFail
  // 收成 (args, routing, policy)，不改这一处 dry-run 会在「要显式 --model」上假红。
  const route = mirasimRouteOrFail(args, routing, bind.policy, bind.runtime);

  let workdir = typeof args.worktree === 'string' && args.worktree.includes('/')
    ? args.worktree.replace(/^path:/, '')
    : '';
  const targetRepo = resolveMirasimRepoTarget(args, { role: 'worker', where: 'start', defaultLocal: thisCheckoutRoot() });
  const repo = targetRepo.localPath;
  const branch = args.branch || gitBranchName(ROOT).branch || 'master';
  const asPositiveInt = (v) => {
    const n = Number(v);
    return Number.isInteger(n) && n > 0 ? n : null;
  };
  const issue = asPositiveInt(args.issue);
  const pr = asPositiveInt(args.pr);
  const title = typeof args.title === 'string' && args.title.trim() ? args.title.trim() : null;

  if (args.dryRun) {
    emit({
      ok: true, dryRun: true, executor: 'mirasim',
      agent: route.agent, family: route.family, mode: route.mode, daoModel: args.model,
      repo, ghRepo: targetRepo.ownerName || null, branch, workdir: workdir || '(ensureWorkspace 后才有)',
      pr, issue, title,
      promptBytes: Buffer.byteLength(String(args.prompt), 'utf8'),
      note: '预览不碰 mirasim：没建树、没起会话、没烧额度',
    });
    return;
  }

  const isolation = judgeTestExecutorIsolation(process.env);
  if (!isolation.ok) fail(isolation.error, { isolation, executor: 'mirasim' });

  if (!workdir) {
    try {
      const tree = await bind.runtime.ensureWorkspace(repo, branch);
      workdir = tree.path;
    } catch (e) {
      fail(`mirasim 建树失败: ${String(e?.message || e)}`, { executor: 'mirasim', repo, branch });
    }
  }
  if (!workdir) fail('mirasim 起会话没拿到 workdir', { executor: 'mirasim', repo, branch });
  attachControlPlaneHooksOrFail(workdir, { executor: 'mirasim', repo, branch });

  let sess;
  try {
    sess = await bind.runtime.startSession({
      agent: route.agent, workdir, prompt: args.prompt,
      model: args.model, clientRef: `dao-start-${Date.now()}`,
      ...(issue ? { issue } : {}),
      ...(pr ? { pr } : {}),
      ...(title ? { title } : {}),
    });
  } catch (e) {
    fail(`mirasim 起会话失败: ${String(e?.message || e)}`, {
      executor: 'mirasim', repo, branch, workdir, agent: route.agent,
      // #1331：`code` 必须原样透出去。`reviewer-create` 那条路早就带着它，唯独 start 没带，
      // 于是返工/收口泵那侧只能拿错误文本去猜「这次是环境还是这张 PR 的事」。
      // 实测 7 天 99 次起会话失败里 66 次是「连不上回环 ws」（MirasimUnavailableError，
      // code='unavailable'），而它们全被记成「这张 PR 又试了一次」。
      ...(e?.code ? { code: String(e.code) } : {}),
      ...(e?.detail?.busy === true ? { busy: true, reason: e.detail.reason, holders: e.detail.holders } : {}),
    });
  }
  emit({
    ok: true, executor: 'mirasim',
    sessionKey: sess.sessionKey, taskId: sess.taskId ?? null, startedAt: sess.startedAt,
    handle: sess.sessionKey, // 兼容指挥官旧字段：brainSessions 的键就是这个
    agent: route.agent, family: route.family, mode: route.mode, daoModel: args.model,
    repo, branch, workdir, pr, issue, title,
  });
}

async function cmdSessionRead(args) {
  if (!args.session) fail('session-read 要 --session <sessionKey>');
  const routing = loadOrFail();
  const bind = bindExecutor({ executor: 'mirasim', routing });
  if (!bind.ok) fail(bind.error, { executor: 'mirasim' });
  let view;
  try { view = await bind.runtime.readSession(args.session); }
  catch (e) {
    fail(`session-read 没查成: ${String(e?.message || e)}`, { executor: 'mirasim', sessionKey: args.session });
  }
  emit({
    ok: true, executor: 'mirasim', sessionKey: args.session,
    phase: view.phase ?? null,
    text: view.text ?? '',
    toolCalls: view.toolCalls ?? [],
    error: view.error ?? null,
    missing: view.missing === true,
    partial: view.partial === true,
    via: view.via ?? null,
    why: view.why ?? null,
    readable: view.missing !== true,
  });
}

/** 停掉 cwd 落在这棵树上的会话。交卷后树留着、进程必须走。没清单或没有匹配 = 扫过 0 条，不是失败。 */
async function stopSessionsAtCwd(runtime, cwd) {
  const want = String(cwd || '').replace(/\\/g, '/').replace(/\/+$/, '');
  if (!want) return { ok: false, unscanned: true, error: '停会话没给 cwd', stopped: [] };
  if (!runtime || typeof runtime.listSessions !== 'function') {
    return { ok: false, unscanned: true, error: 'runtime 没有 listSessions', stopped: [] };
  }
  const listed = await runtime.listSessions();
  if (!listed || listed.ok === false) {
    return {
      ok: false, unscanned: true,
      error: (listed && listed.error) || '会话清单没查成',
      stopped: [],
    };
  }
  const sessions = Array.isArray(listed.sessions) ? listed.sessions : [];
  const hits = sessions.filter((s) => {
    const cwd = String((s && (s.cwd || s.workdir || s.worktree)) || '').replace(/\\/g, '/').replace(/\/+$/, '');
    return cwd && (cwd === want || cwd.startsWith(`${want}/`));
  });
  const stopped = [];
  for (const s of hits) {
    const key = s.sessionKey || s.key || s.id;
    if (!key) continue;
    try {
      const r = await stopSessionAndReap(runtime, key, { workdir: cwd });
      stopped.push({ sessionKey: key, ok: !!(r && r.ok), why: r && r.why });
    } catch (e) {
      stopped.push({ sessionKey: key, ok: false, why: String(e && e.message ? e.message : e) });
    }
  }
  const failed = stopped.filter((x) => x.ok !== true);
  if (failed.length) {
    return { ok: false, error: `有 ${failed.length} 个会话没停成`, stopped, scanned: hits.length };
  }
  return { ok: true, stopped, scanned: hits.length };
}

async function cmdSessionStop(args) {
  if (!args.session) fail('session-stop 要 --session <sessionKey>');
  const routing = loadOrFail();
  const bind = bindExecutor({ executor: 'mirasim', routing });
  if (!bind.ok) fail(bind.error, { executor: 'mirasim' });
  let stopped;
  try { stopped = await stopSessionAndReap(bind.runtime, args.session, { workdir: args.worktree || null }); }
  catch (e) {
    fail(`session-stop 没查成: ${String(e?.message || e)}`, { executor: 'mirasim', sessionKey: args.session });
  }
  emit({
    ok: stopped && stopped.ok === true,
    executor: 'mirasim', sessionKey: args.session,
    stopped: !!(stopped && stopped.ok),
    why: (stopped && stopped.why) || null,
  }, stopped && stopped.ok === true ? 0 : 1);
}

/**
 * start：mirasim 起会话，或 --dry-run 只从表打出启动命令。
 * orca 那条「裸起 TUI」脊已退役；没 --prompt 的 dry-run 留给 design-exam 指针照抄 .command。
 */
async function cmdStart(args) {
  if (args.executor === 'orca') fail('orca 已退役，执行体只剩 mirasim');
  if (args.prompt || args.executor === 'mirasim') return cmdStartMirasim(args);
  if (!args.dryRun) fail('start 要 --prompt（起 mirasim 会话）或 --dry-run（只看路由表启动命令）');
  const routing = loadOrFail();
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
  const startCap = assertCodexLaunch({ command: launch.command });
  if (!startCap.ok) fail(startCap.error);
  const startTrace = daoTraceFor({ role: 'shuai', model: args.model || launch.provider, fallback: 'start' });
  let command = launch.command;
  if (shouldPrefixDaoTrace(launch)) {
    const traced = applyDaoTraceToLaunch(launch, startTrace);
    command = traced.command;
  }
  emit({
    ok: true, dryRun: true, executor: 'mirasim',
    provider: launch.provider, command, template: launch.template,
    note: '预览路由表启动命令，没起会话',
  });
}

function main(argv = process.argv) {
  let args;
  try { args = parseArgs(argv); }
  catch (e) {
    if (IN_PROCESS) throw new ExitSignal({ ok: false, error: String(e.message || e) }, 1);
    console.error(String(e.message || e));
    process.exit(1);
  }
  if (args.verb === 'help' || args.help) {
    if (IN_PROCESS) throw new ExitSignal({ ok: true, usage: USAGE }, 0);
    process.stdout.write(USAGE);
    process.exit(0);
  }
  switch (args.verb) {
    case 'dispatch': return cmdDispatch(args);
    case 'dispatch-exec': return cmdDispatchExec(args);
    case 'start': return cmdStart(args);
    case 'session-read': return cmdSessionRead(args);
    case 'session-stop': return cmdSessionStop(args);
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
    case 'pr-open': return cmdPrOpen(args);
    case 'ledger-query': return cmdLedgerQuery(args);
    case 'preflight': return cmdPreflight(args);
    case 'breaker': return cmdBreaker(args);
    case 'leg': return cmdLeg(args);
    case 'amend': return cmdAmend(args);
    case 'next': return cmdNext(args);
    case 'now': return cmdNow(args);
    case 'board': return cmdBoard(args);
    case 'raw': return cmdRaw(args);
    default:
      if (IN_PROCESS) throw new ExitSignal({ ok: false, error: `未知动词: ${args.verb}` }, 1);
      console.error(`未知动词: ${args.verb}`);
      process.exit(1);
  }
}

/**
 * 进程内跑一次 CLI。给测试用——省掉 ~225ms 的进程启动，走的是同一条 argv→输出。
 * @param {string[]} args 动词及其后的参数（不含 node 与脚本路径）
 * @returns {{status:number, payload:object|null, error?:string}}
 *   payload 是 emit 本来要 JSON.stringify 出去的那个对象，直接给，不用再解析一遍。
 */
export async function runCliInProcess(args) {
  IN_PROCESS = true;
  try {
    // **必须 await**：一半动词（cmdReviewerCreate 等）是 async，它们的 fail() 抛在 Promise 里。
    // 同步 try/catch 接不住——首版就栽在这儿：同步返回「没 emit」，信号随后变成未捕获异常。
    await main(['node', 'dao.mjs', ...args]);
    // 走到这儿说明动词处理完了却没 emit——那是 CLI 的契约漏洞，如实报出来，不装成成功
    return { status: 0, payload: null, error: '动词返回但没有 emit（CLI 契约漏洞）' };
  } catch (e) {
    if (e instanceof ExitSignal) return { status: e.code, payload: e.payload };
    throw e;                       // 真异常照抛，不许被当成「CLI 报错」吞掉
  } finally {
    IN_PROCESS = false;
  }
}

// 只有当自己就是入口时才跑 main——被 import 时（测试进程内调用）不许自动执行
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
