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
  assembleCardName,
  argsWorkerStart,
  argsWorkerRelease,
  argsWorkerRead,
  argsOrchestrationReply,
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
  runGh,
  stampIssueLabels,
  syncPrLabelsFromIssue,
  verifyInjection,
  verifyInjectionPolling,
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
  loadLedgerContext, beijingIsoFrom, dispatchJobId, recordPair,
} from './lib/ledger-job.mjs';

const ORCA_TIMEOUT_MS = 30000;

function errText(e) {
  if (e == null) return '';
  if (typeof e === 'string') return e;
  if (typeof e === 'object') return e.code ? `orca 报错 ${e.code}: ${e.message}` : String(e.message || e);
  return '';
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

/** 消歧门（#565）的 gh 执行器。测试注入：DAO_GH_FAKE 指向假 gh 脚本时用它——
 * CI（check.yml）无 GH_TOKEN，CLI 级门测试改走假 gh 造违规/通过样本（
 * tests/fixtures/fake-gh.mjs），否则门按「没查成」拒派、测试假红。生产不设该变量。
 * 只替消歧门这一处；reviewer-create 等其余 gh 调用不受影响。 */
function ghRunner() {
  const fake = process.env.DAO_GH_FAKE;
  if (!fake) return runGh;
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

function readOnceHandle(handle) {
  const read = orca(argsTerminalRead({ terminal: handle, limit: 80 }));
  if (!read.ok) return { error: errText(read.error) };
  return read.json;
}

/** 开工证明（#559 ⑥）：worker-read --source auto 官方 transcript 源优先。
 * 证明不了（source=terminal）不硬失败——verifyInjection 屏面检查兜底（③单接上后删）。
 * 没读成（unscanned）如实上报，不许当成「查过没事」。 */
function workerStartProof(dispatchId) {
  const r = orca(argsWorkerRead({ dispatch: dispatchId }));
  if (!r.ok) return { ok: false, unscanned: true, error: errText(r.error) };
  return verifyWorkerStarted(r.json);
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
    mergeReason: gate.mergeReason,
    model: gate.model,
    reviewer: gate.reviewer,
    issue: args.issue ? String(args.issue).trim() : null,
    workerCard: assembleCardName({ name: args.name, issue: args.issue }),
    workerLaunch: workerLaunch.command,
    reviewerLaunch: reviewerLaunch.command,
    reviewerCard: assembleCardName({ name: reviewerCardName(gate.reviewer), issue: args.issue }),
    comment: dispatchComment(gate),
  };
  const hereBranch = gitBranchName(process.cwd());
  plan.reviewerBase = hereBranch.ok ? hereBranch.branch : '(工人树当前分支)';

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
  plan.reviewerBase = workerBranch.branch;

  const workerTerm = orca(argsTerminalCreate({
    worktree: created.workerId,
    title: args.name,
    command: workerLaunch.command,
  }));
  if (!workerTerm.ok) failCreated(created, `工人终端创建失败: ${errText(workerTerm.error)}`, plan);
  created.workerHandle = extractHandleFromCreate(workerTerm.json);
  if (!created.workerHandle) failCreated(created, '工人终端没返回 handle', plan);

  const workerVerify = waitAndVerify({
    readOnce: () => readOnceHandle(created.workerHandle),
    timeoutMs: probeWaitMs(routing, workerLaunch.provider),
  });
  if (!workerVerify.ok) failCreated(created, '工人 TUI 未就绪', { verify: workerVerify, ...plan });

  const revName = assembleCardName({ name: reviewerCardName(gate.reviewer), issue: args.issue });
  const revWt = orca(argsWorktreeCreate({
    name: revName,
    setup: 'skip',
    parentWorktree: created.workerId,
    baseBranch: workerBranch.branch,
    issue: args.issue,
    comment: plan.comment,
  }));
  if (!revWt.ok) failCreated(created, `审官子卡创建失败: ${errText(revWt.error)}`, plan);
  created.reviewerId = extractWorktreeId(revWt.json);
  created.reviewerPath = extractWorktreePath(revWt.json);
  if (!created.reviewerId) failCreated(created, '审官子卡没返回 id', plan);
  if (!created.reviewerPath) failCreated(created, '审官子卡没返回 path', plan);

  const reviewerEnv = envProbeWorktree(created.reviewerPath);
  if (!reviewerEnv.ok) failCreated(created, `审官树环境自检失败: ${reviewerEnv.error}`, { probes: reviewerEnv, ...plan });

  const heads = verifyReviewerTree({
    workerPath: created.workerPath,
    reviewerPath: created.reviewerPath,
  });
  if (!heads.ok) failCreated(created, heads.error, { heads, ...plan });

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

  // ── 闭环接线（#546 追加第五件 → #559 换官方原语 → 审官红项修正拓扑）──
  // #559 ①：send 要发 --to dispatch:<id>（结构化收件箱）不是 terminal handle。
  // 拓扑硬约束：dispatch id 由 worker-start 创建，而 worker-start 需要先有 task，task 的 spec 就是任务书；
  // 两份任务书都内嵌对方 dispatch id 互为前置、无合法顺序（审官红项实证）。所以：
  //   · 士兵任务书 = 模板 + 本单 spec（**不含任何 dispatch id**；审官 dispatch id 以「审官身份」消息
  //     发进士兵收件箱，notify 四关确认送达，先收信记下再发完工通知）。
  //   · 审官任务书 = 模板 + 士兵 dispatch id（**先 worker-start 士兵拿到真 id 并校验，再渲染**）。
  let soldierBook = null;
  try {
    soldierBook = args.spec
      ? renderDispatchTemplate('soldier-book.md', { SPEC: String(args.spec) })
      : null;
  } catch (e) {
    failCreated(created, `任务书模板渲染失败: ${String(e.message || e)}`, { ...plan, soldierBook: null });
  }

  let taskId = args.task || null;
  if (soldierBook) {
    const task = orca(argsTaskCreate({ spec: soldierBook }));
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

  // 注入后开工验证（#565 追加，用户拍板：轮询等开工，不是一次性读屏）。
  // 时序 bug 判例：worker-start 返回时 codex TUI 还在加载 MCP servers，任务书还没渲染，
  // 「立即读一次」读到非空无 Pasted Content 的屏面就判通过——实际任务书折在输入框几十分钟。
  // 轮询 + 命中 Pasted Content 自动补回车（terminal send --enter）再重读；仍在 = 真失败才回滚。
  // 三态分开：started / startedAfterEnter（enter 留痕）/ failed。超时走 probe_wait_ms，不硬编码。
  const workerInject = verifyInjectionPolling({
    dispatchId: created.workerDispatchId,
    readOnce: () => readOnceHandle(created.workerHandle),
    sendEnter: () => orca(argsTerminalSend({ terminal: created.workerHandle, enter: true })),
    proofOnce: workerStartProof,
    timeoutMs: probeWaitMs(routing, workerLaunch.provider),
    label: '工人',
  });
  if (!workerInject.ok) failCreated(created, `注入后开工验证失败: ${workerInject.reason}`, { inject: workerInject, ...plan, taskId });
  const workerProof = workerStartProof(created.workerDispatchId); // 成功后再取一次留档（emit 用）

  // 审官也是 worker：起自己的 task + worker-start，拿到编排身份才能收士兵消息、发红项、判绿后通知帅。
  // 审官任务书此刻才渲染：SOLDIER_DISPATCH_ID = 上面已校验的真 id，结构上不可能再出现 dispatch:undefined。
  let reviewerBook = null;
  try {
    reviewerBook = renderDispatchTemplate('reviewer-book.md', {
      SOLDIER_DISPATCH_ID: String(created.workerDispatchId),
      MERGE_POLICY: gate.mergePolicy,
      MERGE_REASON: gate.mergeReason ? String(gate.mergeReason) : '',
    });
  } catch (e) {
    failCreated(created, `审官任务书模板渲染失败: ${String(e.message || e)}`, { ...plan, soldierBook, taskId });
  }

  let reviewerTaskId = null;
  let reviewerInject = null;
  let reviewerProof = null;
  if (reviewerBook) {
    const revTask = orca(argsTaskCreate({ spec: reviewerBook }));
    if (!revTask.ok) {
      if (isRunRequired(revTask.error)) failCreated(created, RUN_REQUIRED_HINT, { ...plan, taskId });
      failCreated(created, `审官 task-create 失败: ${errText(revTask.error)}`, { ...plan, taskId });
    }
    reviewerTaskId = extractTaskId(revTask.json);
    if (!reviewerTaskId) failCreated(created, '审官 task-create 没拿到 taskId', { ...plan, taskId });

    const revStarted = orca(argsWorkerStart({
      task: reviewerTaskId,
      worktree: created.reviewerId,
      terminal: created.reviewerHandle,
    }));
    if (!revStarted.ok) failCreated(created, `审官 worker-start 失败: ${errText(revStarted.error)}`, { ...plan, taskId, reviewerTaskId });
    created.reviewerDispatchId = extractDispatchId(revStarted.json);
    if (!created.reviewerDispatchId) {
      failCreated(created, '审官 worker-start 没拿到 dispatch id（没查成，审官收不到士兵消息）', { ...plan, taskId, reviewerTaskId });
    }

    reviewerInject = verifyInjectionPolling({
      dispatchId: created.reviewerDispatchId,
      readOnce: () => readOnceHandle(created.reviewerHandle),
      sendEnter: () => orca(argsTerminalSend({ terminal: created.reviewerHandle, enter: true })),
      proofOnce: workerStartProof,
      timeoutMs: probeWaitMs(routing, reviewerLaunch.provider),
      label: '审官',
    });
    if (!reviewerInject.ok) failCreated(created, `审官注入后开工验证失败: ${reviewerInject.reason}`, { ...plan, taskId, reviewerTaskId, reviewerInject });
    reviewerProof = workerStartProof(created.reviewerDispatchId); // 成功后再取一次留档（emit 用）
  }

  // 士兵的「审官身份」：审官 dispatch id 发进士兵结构化收件箱（notify 四关确认送达；
  // 失败 = 士兵完工时不知道该发到哪，整单回滚）。
  if (!reviewerBook || !created.reviewerDispatchId) {
    failCreated(created, '审官 dispatch id 没拿到（没查成）——不发身份消息，杜绝 审官身份：undefined', { ...plan, taskId, reviewerTaskId });
  }
  const identity = deliverMessage({
    to: `dispatch:${created.workerDispatchId}`,
    subject: `审官身份：${created.reviewerDispatchId}`,
    body: `你的审官 dispatch id = ${created.reviewerDispatchId}（士兵→审官 完工通知 --to dispatch:<这个 id>）。
先收这封信记下它，再发完工通知；收不到就 escalation，不许手抄/猜。`,
    hop: '派工→士兵（审官身份）',
    orca: (a) => orca(a),
  });
  if (!identity.ok) {
    failCreated(created, `审官身份消息没送到士兵收件箱: ${identity.error}`, { ...plan, taskId, reviewerTaskId, identity });
  }

  const comment = afterDispatchComment({
    name: args.name,
    issue: args.issue,
    worktreeId: created.workerId,
    runOrca: orca,
  });

  // #564 label 自动打：dispatch 成功时把 model/<模型> type/<角色> 打到目标 issue（best-effort，
  // 失败只报告不翻转派工结果——label 是校准数据源，但回滚一个成功的派工代价更大；帅合并时
  // 用 pr-sync-labels 从 issue 同步到 PR）。gh 没查成 != 查过没事：失败也要说清楚。
  const labels = stampIssueLabels({
    issue: args.issue,
    model: gate.model,
    role: gate.role,
    runGh: ghRunner(),
  });
  if (!labels.ok && !labels.skipped) {
    console.error(`[dao] dispatch label 没打上（派工本身成功）：${labels.error}`);
  }

  // #581：派工当下写 job.dispatch。此时多半还没有 PR 号，job_id 用 dispatch-<id>；
  // flow 在起审官/收判定/合并时再写 gh-pr-N（含 pr_number）。写入失败不回滚派工。
  let ledger = null;
  try {
    const ctx = loadLedgerContext({ root: ROOT });
    const ts = beijingIsoFrom(new Date());
    ledger = recordPair({
      ctx,
      ts,
      source: 'dao-dispatch',
      worker: {
        jobId: dispatchJobId(created.workerDispatchId),
        model: gate.model,
        identity: '工人',
        workType: gate.role || '写码',
        terminal: workerLaunch.provider || 'dao',
        extra: args.issue ? { issue_number: Number(args.issue) || args.issue } : {},
      },
      reviewer: {
        jobId: dispatchJobId(created.reviewerDispatchId),
        model: gate.reviewer,
        identity: '审官',
        workType: '审查',
        terminal: reviewerLaunch.provider || 'dao',
        extra: args.issue ? { issue_number: Number(args.issue) || args.issue } : {},
      },
    });
    const failed = [ledger.worker, ledger.reviewer].filter(r => r && !r.ok);
    if (failed.length) {
      console.error(`[dao] dispatch 账本没写上（派工本身成功）：${failed.map(r => r.error).join('；')}`);
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
    reviewerTaskId,
    loop: {
      soldierBook: !!soldierBook,
      reviewerBook: !!reviewerBook,
      soldierDoneTo: `dispatch:${created.reviewerDispatchId}`,   // 士兵完工消息的收件人 = 审官 Dispatch（身份消息送达士兵）
      reviewerRedTo: `dispatch:${created.workerDispatchId}`,     // 审官红项消息的收件人 = 士兵 Dispatch（内嵌审官任务书）
      identityTo: `dispatch:${created.workerDispatchId}`,        // 「审官身份」消息发进士兵收件箱（四关确认）
      archivedBy: '帅（归档动作帅做，审官不 rm 树）',
    },
    probes: { worker: workerEnv, reviewer: reviewerEnv },
    heads,
    inject: workerInject,
    startProof: workerProof,
    reviewerInject,
    reviewerProof,
    identity,
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
    name: assembleCardName({ name: args.name, issue: args.issue }),
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
  if (!args.terminal) fail('worker-start 要 --terminal（不用 --agent，参数在启动模板里）');
  // 消歧门（#565）：worker-start 带 --issue 同样受门控（项化路径续派/换人时带号）。
  // 在碰 orca 之前拦：被拦下时不会起任何终端/任务。
  const disambiguation = checkIssueDisambiguated({ issue: args.issue, runGh: ghRunner() });
  if (!disambiguation.ok) fail(disambiguation.error, { disambiguation });
  // #559 ②：worker_done 后同一终端续 Dispatch 走 worker-start --task <next> --terminal <handle>，
  // 不用 --worktree（工作区由终端决定，官方：Reuse an existing agent only with --terminal <handle>）。
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
  if (!args.name && !args.dryRun) fail('reviewer-create 要 --name');

  const meta = runGh(['pr', 'view', String(args.pr), '--json', 'headRefName,headRefOid,mergeable'], { role: 'reviewer' });
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

  const fileList = runGh(['api', `repos/{owner}/{repo}/pulls/${args.pr}/files`, '--paginate'], { role: 'reviewer' });
  if (!fileList.ok) fail(`gh 读 PR #${args.pr} 文件列表失败（不是没有文件，是没查成）: ${fileList.error}`);
  let fileJson;
  try { fileJson = JSON.parse(fileList.out); }
  catch { fail(`gh 读 PR #${args.pr} 文件列表不是 JSON: ${String(fileList.out).slice(0, 120)}`); }
  const files = parseGhPullFiles(fileJson);
  if (!files) fail(`gh 读 PR #${args.pr} 文件列表形态不对`);

  const plan = { pr: String(args.pr), baseBranch, expectedOid, files, name: args.name || null, mergeable };
  if (args.dryRun) emit({ ok: true, dryRun: true, ...plan });

  const created = orca(argsWorktreeCreate({
    name: args.name,
    setup: 'skip',
    parentWorktree: args.parentWorktree,
    baseBranch,
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
  emit({ ok: true, ...plan, reviewerId, reviewerPath, heads, filesChecked: filesOk.checked, probes: env, align });
}

/**
 * #575 ④：给已有、无审官的工人卡补派审官。一条命令走完 dispatch 里那段审官建法：
 * 建树 → 环境探针 → HEAD==PR head → 起终端 → 验 TUI → task+worker-start →
 * verifyInjectionPolling（命中 Pasted Content 自动补回车，仍未开工 fail-visible）。
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
    issue: args.issue,
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
  if (!soldierDispatchId && !args.spec) {
    const wl = orca(argsWorkerList());
    if (!wl.ok) failCreated(created, `worker-list 没查成，给 --soldier-dispatch：${errText(wl.error)}`, plan);
    const found = findDispatchForWorktree(wl.json, args.worktree);
    if (!found.ok) failCreated(created, `找不到士兵 dispatch（${found.error}）。给 --soldier-dispatch，或确认工人卡走过 worker-start`, { found, ...plan });
    soldierDispatchId = found.dispatchId;
  }

  let reviewerBook = null;
  try {
    const body = args.spec
      ? String(args.spec)
      : renderDispatchTemplate('reviewer-book.md', {
        SOLDIER_DISPATCH_ID: String(soldierDispatchId),
        MERGE_POLICY: policy,
        MERGE_REASON: args.mergeReason ? String(args.mergeReason) : '',
      });
    const overlap = (align.masterFiles || []).filter(f => files.includes(f));
    const alignNote = `你审的分支落后 master ${align.behind} 个 commit，试合${align.conflict ? '有冲突' : '无冲突'}。重点核这 ${align.behind} 个 commit 碰过的文件与本 PR 的交集${overlap.length ? `（${overlap.join(', ')}）` : ''}——那是语义冲突最可能藏身的地方。`;
    reviewerBook = `## 与 master 对齐（#575 ⑦）\n\n${alignNote}\n\n${body}`;
  } catch (e) {
    failCreated(created, `审官任务书渲染失败: ${String(e.message || e)}`, plan);
  }

  const revTask = orca(argsTaskCreate({ spec: reviewerBook }));
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

  const reviewerInject = verifyInjectionPolling({
    dispatchId: created.reviewerDispatchId,
    readOnce: () => readOnceHandle(created.reviewerHandle),
    sendEnter: () => orca(argsTerminalSend({ terminal: created.reviewerHandle, enter: true })),
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
  const r = orca(argsOrchestrationReply({ id: args.id, body: args.body, from: args.from }));
  if (!r.ok) fail(`reply 失败: ${errText(r.error)}`);
  emit({ ok: true, json: r.json, messageId: args.id });
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
    case 'reviewer-attach': return cmdReviewerAttach(args);
    case 'send': return cmdSend(args);
    case 'notify': return cmdNotify(args);
    case 'reply': return cmdReply(args);
    case 'gate-create': return cmdGateCreate(args);
    case 'gate-resolve': return cmdGateResolve(args);
    case 'gate-list': return cmdGateList(args);
    case 'liveness': return cmdLiveness(args);
    case 'check-help': return cmdCheckHelp();
    case 'pr-sync-labels': return cmdPrSyncLabels(args);
    case 'raw': return cmdRaw(args);
    default:
      console.error(`未知动词: ${args.verb}`);
      process.exit(1);
  }
}

main();
