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
  deliverMessage,
  dispatchComment,
  envProbeWorktree,
  extractHandleFromCreate,
  extractTaskId,
  extractTerminalText,
  extractWorktreeId,
  extractWorktreePath,
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
  verifyInjection,
  verifyReviewerFiles,
  verifyReviewerTree,
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
    workerLaunch: workerLaunch.command,
    reviewerLaunch: reviewerLaunch.command,
    reviewerCard: reviewerCardName(gate.reviewer),
    comment: dispatchComment(gate),
  };
  const hereBranch = gitBranchName(process.cwd());
  plan.reviewerBase = hereBranch.ok ? hereBranch.branch : '(工人树当前分支)';

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
  if (!created.workerPath) failCreated(created, '工人卡没返回 path', plan);

  const workerEnv = envProbeWorktree(created.workerPath);
  if (!workerEnv.ok) failCreated(created, `工人树环境自检失败: ${workerEnv.error}`, { probes: workerEnv, ...plan });

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

  const revName = reviewerCardName(gate.reviewer);
  const revWt = orca(argsWorktreeCreate({
    name: revName,
    setup: 'skip',
    parentWorktree: created.workerId,
    baseBranch: workerBranch.branch,
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

  // ── 闭环接线（#546 追加第五件）：两个 handle 互相写进对方任务书，完工→审官→帅 ──
  // 士兵任务书 = 模板 + 本单 spec + 审官 handle（完工后它自己通知审官，不发给帅）。
  // 审官任务书 = 模板 + 士兵 handle + merge-policy（红→发回士兵；乒乓两轮仍红才上帅；绿→合并→通知帅可归档）。
  let soldierBook = null;
  let reviewerBook = null;
  try {
    soldierBook = args.spec
      ? renderDispatchTemplate('soldier-book.md', {
          SPEC: String(args.spec),
          REVIEWER_HANDLE: String(created.reviewerHandle),
        })
      : null;
    reviewerBook = renderDispatchTemplate('reviewer-book.md', {
      SOLDIER_HANDLE: String(created.workerHandle),
      MERGE_POLICY: gate.mergePolicy,
    });
  } catch (e) {
    failCreated(created, `任务书模板渲染失败: ${String(e.message || e)}`, { ...plan, soldierBook: null, reviewerBook: null });
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

  const injectRead = readOnceHandle(created.workerHandle);
  const injected = verifyInjection({
    text: injectRead.error ? undefined : extractTerminalText(injectRead),
    readError: injectRead.error,
  });
  if (!injected.ok) failCreated(created, `注入后开工验证失败: ${injected.reason}`, { inject: injected, ...plan, taskId });

  // 审官也是 worker：起自己的 task + worker-start，拿到编排身份才能收士兵消息、发红项、判绿后通知帅。
  let reviewerTaskId = null;
  let reviewerInject = null;
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

    const revInjectRead = readOnceHandle(created.reviewerHandle);
    reviewerInject = verifyInjection({
      text: revInjectRead.error ? undefined : extractTerminalText(revInjectRead),
      readError: revInjectRead.error,
    });
    if (!reviewerInject.ok) failCreated(created, `审官注入后开工验证失败: ${reviewerInject.reason}`, { ...plan, taskId, reviewerTaskId, reviewerInject });
  }

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
    reviewerTaskId,
    loop: {
      soldierBook: !!soldierBook,
      reviewerBook: !!reviewerBook,
      soldierDoneTo: created.reviewerHandle,   // 士兵完工消息的收件人 = 审官 handle
      reviewerRedTo: created.workerHandle,     // 审官红项消息的收件人 = 士兵 handle
      archivedBy: '帅（归档动作帅做，审官不 rm 树）',
    },
    probes: { worker: workerEnv, reviewer: reviewerEnv },
    heads,
    inject: injected,
    reviewerInject,
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
  const read = orca(argsTerminalRead({ terminal: args.terminal, limit: 80 }));
  if (!read.ok) fail(`worker-start 成功但读屏失败——不是已开工，是没查成: ${errText(read.error)}`);
  const injected = verifyInjection({ text: extractTerminalText(read.json) });
  if (!injected.ok) fail(`注入后开工验证失败: ${injected.reason}`, { inject: injected });
  emit({ ok: true, json: r.json, inject: injected });
}

function cmdReviewerCreate(args) {
  if (!args.pr) fail('reviewer-create 要 --pr');
  if (!args.name && !args.dryRun) fail('reviewer-create 要 --name');

  const meta = runGh(['pr', 'view', String(args.pr), '--json', 'headRefName,headRefOid']);
  if (!meta.ok) fail(`gh 读 PR #${args.pr} 失败（不是没有 PR，是没查成）: ${meta.error}`);
  let head;
  try { head = JSON.parse(meta.out); }
  catch { fail(`gh 读 PR #${args.pr} 返回不是 JSON: ${String(meta.out).slice(0, 120)}`); }
  const baseBranch = head?.headRefName;
  const expectedOid = head?.headRefOid;
  if (!baseBranch || !expectedOid) fail(`gh 读 PR #${args.pr} 缺 headRefName/headRefOid`);

  const fileList = runGh(['api', `repos/{owner}/{repo}/pulls/${args.pr}/files`, '--paginate']);
  if (!fileList.ok) fail(`gh 读 PR #${args.pr} 文件列表失败（不是没有文件，是没查成）: ${fileList.error}`);
  let fileJson;
  try { fileJson = JSON.parse(fileList.out); }
  catch { fail(`gh 读 PR #${args.pr} 文件列表不是 JSON: ${String(fileList.out).slice(0, 120)}`); }
  const files = parseGhPullFiles(fileJson);
  if (!files) fail(`gh 读 PR #${args.pr} 文件列表形态不对`);

  const plan = { pr: String(args.pr), baseBranch, expectedOid, files, name: args.name || null };
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
  emit({ ok: true, ...plan, reviewerId, reviewerPath, heads, filesChecked: filesOk.checked, probes: env });
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
    case 'reviewer-create': return cmdReviewerCreate(args);
    case 'send': return cmdSend(args);
    case 'notify': return cmdNotify(args);
    case 'liveness': return cmdLiveness(args);
    case 'check-help': return cmdCheckHelp();
    case 'raw': return cmdRaw(args);
    default:
      console.error(`未知动词: ${args.verb}`);
      process.exit(1);
  }
}

main();
