// scripts/lib/dispatch/deliver.mjs —— 闭环投递域（#762 拆分）
//
// 改这段前必须知道：投递前先证收件人在，投递后核回执与落库，delivered_at 只如实报出、
// 不当唯一判据（本机这版 Orca 对活着的收件人也常留 null，当门就是天天假红）。
// --type worker_done 是结算口（#551）：省略 --to，必须带 task-id/dispatch-id/outcome，
// 发出后核 worker-show Dispatch 为 completed。

import { orcaErrorText } from '../orca-error.mjs';
import {
  argsOrchestrationInbox, argsOrchestrationSend, argsRunCurrent, argsRunShow,
  argsTerminalRead, argsWorkerShow,
} from './args.mjs';

/** #551：worker_done 是 exact-Dispatch 结算口，不是普通投递。 */
export function planWorkerDoneSend({ type, to, outcome, taskId, dispatchId, from, dispatchCapability } = {}) {
  const t = type == null ? '' : String(type).trim();
  if (t !== 'worker_done') {
    return { ok: true, kind: 'notify', settle: false };
  }
  const missing = [];
  if (!String(taskId || '').trim()) missing.push('task-id');
  if (!String(dispatchId || '').trim()) missing.push('dispatch-id');
  const oc = String(outcome || '').trim();
  if (oc !== 'succeeded' && oc !== 'failed') missing.push('outcome');
  if (missing.length) {
    return {
      ok: false, kind: 'settle', settled: false, unscanned: false,
      error: `未结算：worker_done 缺 ${missing.join('/')}（exact-Dispatch 信号必须带身份，不能省略）`,
    };
  }
  const dest = to == null ? '' : String(to).trim();
  if (dest) {
    return {
      ok: false, kind: 'settle', settled: false, unscanned: false,
      error: '未结算：worker_done 不能带 --to（exact-Dispatch 信号须省略 --to，走活动 Dispatch 的 Run 信箱）',
    };
  }
  return {
    ok: true, kind: 'settle', settle: true, omitTo: true,
    taskId: String(taskId).trim(),
    dispatchId: String(dispatchId).trim(),
    outcome: oc,
    from: from ? String(from).trim() : null,
    dispatchCapability: dispatchCapability ? String(dispatchCapability).trim() : null,
  };
}

/**
 * 读 worker-show 判断 Dispatch 是否真的 completed。
 * 没查成（缺信封/缺 status）和「查到了但未 completed」必须分开。
 */
export function readDispatchSettlement(json) {
  if (!json || typeof json !== 'object') {
    return { ok: false, unscanned: true, settled: false, error: 'worker-show 返回空（没查成，不许当未结算）' };
  }
  const dispatch = json.result && json.result.dispatch;
  if (!dispatch || typeof dispatch !== 'object') {
    return { ok: false, unscanned: true, settled: false, error: 'worker-show 没有 result.dispatch（没查成，不许当未结算）' };
  }
  const status = dispatch.status == null ? null : String(dispatch.status);
  const workerState = json.result?.worker?.state == null ? null : String(json.result.worker.state);
  if (status == null) {
    return {
      ok: false, unscanned: true, settled: false,
      error: 'worker-show 查到了但没有 dispatch.status（没查成，不许当未结算）',
      dispatchId: dispatch.id || null, workerState,
    };
  }
  const settled = String(status).toLowerCase() === 'completed';
  return {
    ok: true, unscanned: false, settled,
    status, workerState,
    dispatchId: dispatch.id || null,
    taskId: dispatch.task_id || null,
    assigneeHandle: dispatch.assignee_handle || null,
    completedAt: dispatch.completed_at || null,
  };
}

export function isWrongPaneWorkerDoneError(error) {
  const text = orcaErrorText(error);
  return /not the Dispatch pane|not_dispatch_pane|caller is not the Dispatch|assignee|exact-Dispatch|stable pane|pane identity/i.test(text);
}

/** run-current 三态：没查成 / 已有 Run / 查到 null 需要本窗自开。 */
export function planCallerRun({ currentOk, currentJson, currentError } = {}) {
  if (!currentOk) {
    return { ok: false, unscanned: true, error: `run-current 没查成：${currentError || ''}`.trim() };
  }
  const runId = extractRunId(currentJson);
  if (runId) return { ok: true, runId, needCreate: false };
  return { ok: true, runId: null, needCreate: true };
}

/** 真返回在 result.run.id。顶层 id 是 RPC id，不能当 runId。 */
export function extractRunId(json) {
  return json?.result?.run?.id || null;
}

/** 收件人形态。闭环三跳只有四种合法收件人，其余一律拒发（发出去没人负责 = 静默断链）。
 * term_… = 终端 handle（低层通道）；run:… = Run 信箱；dispatch:… = 受监督工人的结构化收件箱
 * （#559 官方通道优先：`send --to dispatch:<id>` 是结构化收件箱邮件，不是 prompt injection，
 * worker 的下一步 orchestration check 会收到它）；省略 = 自己那条 Run 信箱。 */
export function classifyNotifyTarget(to) {
  const t = String(to ?? '').trim();
  if (!t) return { kind: 'own-run', id: null };
  if (/^term_/.test(t)) return { kind: 'terminal', id: t };
  if (/^run:/.test(t)) return { kind: 'run', id: t.slice(4) };
  if (/^dispatch:/.test(t)) return { kind: 'dispatch', id: t.slice('dispatch:'.length) };
  if (t.startsWith('@')) {
    return { kind: 'unsupported', error: `闭环通知不发组播（${t}）：组播没人负责签收，收不到也看不出来` };
  }
  return { kind: 'unsupported', error: `收件人形态不认识: ${t}（只收 term_… / run:… / dispatch:… / 省略=自己那条 Run 信箱）` };
}

/** 从 worker-show JSON 取出士兵终端。已完工时 result.terminal 常为 null，退到 handle 字段。 */
export function extractSoldierTerminal(showJson) {
  const r = showJson?.result || {};
  return r.terminal?.handle
    || r.worker?.agent_terminal_handle
    || r.dispatch?.assignee_handle
    || r.terminalResource?.terminalHandle
    || null;
}

export function extractDispatchRunId(showJson) {
  return showJson?.result?.dispatch?.run_id || null;
}

export function extractDispatchWorktreeId(showJson) {
  const r = showJson?.result || {};
  return r.worker?.worktree_id
    || r.terminal?.worktreeId
    || r.terminalResource?.worktreeId
    || null;
}

/** hop 是不是「审官把红项打回士兵」这一跳。 */
export function isSoldierReworkHop(hop) {
  return /审官\s*→\s*士兵/.test(String(hop || ''));
}

/** probeRecipient 失败是不是「查到了、已完工」（不是没查成、不是不存在）。 */
export function isCompletedDispatchProbe(pre) {
  if (!pre || pre.kind !== 'dispatch' || pre.ok || pre.unscanned) return false;
  return !isLiveDispatchRecipient({ workerState: pre.status, dispatchStatus: pre.dispatchStatus })
    && !!(pre.status || pre.dispatchStatus);
}

function dispatchProbeExtras(showJson) {
  return {
    assigneeHandle: showJson?.result?.dispatch?.assignee_handle ?? null,
    agentTerminalHandle: showJson?.result?.worker?.agent_terminal_handle ?? null,
    terminalHandle: extractSoldierTerminal(showJson),
    runId: extractDispatchRunId(showJson),
    worktreeId: extractDispatchWorktreeId(showJson),
    lastFailure: showJson?.result?.dispatch?.last_failure ?? null,
  };
}

/** dispatch 收件人必须还活着。completed/succeeded/failed 不是收件人。
 * devin 假 stalled 例外（2026-08-26 实测）：devin -p 非交互形态的 dispatch 会被 Orca 判
 * failed（agent_prompt_stalled 是 stdin 注入假阴性，任务书已由 --prompt-file 送达，工人实际在跑），
 * 这类 failed 当活收件人——真 stalled 由 watchdog 用 git 证据/产物判，不在这里误杀。
 * #780 修复：例外只对 failed 生效。completed/succeeded 是终态成功，历史里的 stalled
 * 不改变已完工事实——死信箱就是死信箱，不许因 lastFailure 复活。 */
export function isLiveDispatchRecipient({ workerState, dispatchStatus, lastFailure } = {}) {
  const live = new Set(['ready', 'working', 'waiting']);
  const dead = new Set(['completed', 'succeeded', 'failed', 'cancelled', 'canceled', 'released', 'stopped']);
  const w = String(workerState || '').toLowerCase();
  const d = String(dispatchStatus || '').toLowerCase();
  if (dead.has(w) || dead.has(d)) {
    if ((w === 'failed' || d === 'failed') && /agent_prompt_stalled/i.test(String(lastFailure || ''))) return true;
    return false;
  }
  if (live.has(w)) return true;
  return false;
}

/** 投递前证收件人真的在。拿不到 ≠ 没有：分不开就标 unscanned，一样非零。 */
export function probeRecipient(target, orca) {
  if (typeof orca !== 'function') throw new Error('probeRecipient 要 orca 执行器');
  if (target.kind === 'terminal') {
    const r = orca(argsTerminalRead({ terminal: target.id, limit: 1 }));
    if (r.ok) return { ok: true, kind: 'terminal', id: target.id, status: r.json?.result?.terminal?.status ?? null };
    const text = orcaErrorText(r.error);
    if (/terminal_handle_stale|not_found/i.test(text)) {
      return { ok: false, kind: 'terminal', id: target.id, error: `收件人终端不存在或已失效（${text}）：${target.id}` };
    }
    return { ok: false, unscanned: true, kind: 'terminal', id: target.id, error: `收件人活性没查成（不等于收件人不在）：${text}` };
  }
  if (target.kind === 'run') {
    const r = orca(argsRunShow({ id: target.id }));
    if (r.ok && r.json?.result?.run) return { ok: true, kind: 'run', id: target.id };
    if (r.ok) return { ok: false, kind: 'run', id: target.id, error: `Run 信箱查无此 Run: ${target.id}` };
    const text = orcaErrorText(r.error);
    if (/run_not_found/i.test(text)) {
      return { ok: false, kind: 'run', id: target.id, error: `Run 信箱不存在（run_not_found）：${target.id}` };
    }
    return { ok: false, unscanned: true, kind: 'run', id: target.id, error: `Run 信箱没查成: ${text}` };
  }
  if (target.kind === 'dispatch') {
    // #559 官方通道：dispatch:<id> 是受监督工人的结构化收件箱。
    // 活性判据 = worker-show 能查到该 Dispatch（dispatch_not_found = 收件人不在，链断当场炸）。
    const r = orca(argsWorkerShow({ dispatch: target.id }));
    if (r.ok && r.json?.result?.dispatch?.id === target.id) {
      const workerState = r.json?.result?.worker?.state ?? null;
      const dispatchStatus = r.json?.result?.dispatch?.status ?? null;
      const extras = dispatchProbeExtras(r.json);
      if (workerState == null && dispatchStatus == null) {
        return {
          ok: false, unscanned: true, kind: 'dispatch', id: target.id,
          error: `收件人 Dispatch 查到了但没有 state/status（没查成，不许当活人）：${target.id}`,
          ...extras,
        };
      }
      if (!isLiveDispatchRecipient({ workerState, dispatchStatus, lastFailure: r.json?.result?.dispatch?.last_failure })) {
        return {
          ok: false, kind: 'dispatch', id: target.id,
          status: workerState,
          dispatchStatus,
          error: `收件人 Dispatch 已完工（state=${workerState} status=${dispatchStatus}）：禁止往已结算信箱发工作指令（#677：士兵没审完不该下班）。人走了 → 新开工人。`,
          ...extras,
        };
      }
      return {
        ok: true, kind: 'dispatch', id: target.id,
        status: workerState,
        dispatchStatus,
        ...extras,
      };
    }
    if (r.ok) {
      return { ok: false, kind: 'dispatch', id: target.id, error: `Dispatch 查无此 id: ${target.id}` };
    }
    const text = orcaErrorText(r.error);
    if (/dispatch_not_found|not_found|stale/i.test(text)) {
      return { ok: false, kind: 'dispatch', id: target.id, error: `收件人 Dispatch 不存在或已失效（${text}）：${target.id}` };
    }
    return { ok: false, unscanned: true, kind: 'dispatch', id: target.id, error: `收件人 Dispatch 活性没查成（不等于收件人不在）：${text}` };
  }
  const r = orca(argsRunCurrent());
  if (!r.ok) {
    const text = orcaErrorText(r.error);
    return { ok: false, unscanned: true, kind: 'own-run', error: `本终端绑的 Run 没查成: ${text}` };
  }
  const run = r.json?.result?.run;
  if (!run) return { ok: false, kind: 'own-run', error: '本终端没绑 orchestration Run（run-current 为 null），省略收件人 = 发进真空。工人/审官用 worker-show 的 dispatch.run_id 写成 --to run:<id>' };
  return { ok: true, kind: 'own-run', id: run.id || null };
}

/** send 的回执。真返回在 result.message，顶层 id 是 RPC id，不能当消息 id。
 * to_handle / to_dispatch 都可能是收件人落点（send --to dispatch:<id> 的消息字段形态以当时返回为准）。 */
export function extractSentMessage(json) {
  const m = json?.result?.message || json?.message || null;
  if (!m || !m.id) return null;
  return {
    id: m.id,
    toHandle: m.to_handle ?? null,
    toDispatch: m.to_dispatch ?? null,
    deliveredAt: m.delivered_at ?? null,
  };
}

/** 落库复核。扫不到任何样本 → unscanned（「没查成」不许当「查过没事」）。 */
export function findInboxMessage(inboxJson, messageId) {
  const list = inboxJson?.result?.messages;
  if (!Array.isArray(list)) return { scanned: false, found: false, message: null };
  const hit = list.find(m => m && m.id === messageId) || null;
  return { scanned: true, found: !!hit, message: hit, sampled: list.length };
}

/**
 * 闭环一跳的投递：收件人在 → 发 → 有回执 → 落库可查。四关缺一即失败。
 * 失败一律返回 ok:false（调用方非零退出并升级），不许当「发成功了只是还没读」。
 *
 * 普通 notify 四关验的是投递，不是结算：ok:true 只说明消息进了收件人信箱。
 * --type worker_done 是结算口（#551）：必须带 task-id/dispatch-id/outcome、省略 --to，
 * 发出后核 worker-show Dispatch 为 completed。落库但未 completed、缺身份、错 pane
 * 一律 ok:false 并报「未结算」。没查成（unscanned）和查到未 completed 分开。
 *
 * #677：hop 审官→士兵 打进还活着的 id。已完工 fail-visible，不开下一跳救人。
 */
export function deliverMessage({
  to = null, subject, body = '', type, outcome, hop = '闭环通知', orca, inboxLimit = 50,
  taskId, dispatchId, dispatchCapability, from, filesModified, reportPath,
} = {}) {
  if (typeof orca !== 'function') throw new Error('deliverMessage 要 orca 执行器');
  if (!subject) return { ok: false, hop, stage: '参数', error: `${hop}：缺 --subject，没主题的通知等于没通知` };

  const settlePlan = planWorkerDoneSend({ type, to, outcome, taskId, dispatchId, from, dispatchCapability });
  if (!settlePlan.ok) {
    return { ok: false, hop, stage: '结算', settled: false, unscanned: !!settlePlan.unscanned, error: `${hop}：${settlePlan.error}` };
  }
  if (settlePlan.kind === 'settle') {
    return settleDispatch({
      hop, subject, body, outcome: settlePlan.outcome,
      taskId: settlePlan.taskId, dispatchId: settlePlan.dispatchId,
      from: settlePlan.from, dispatchCapability: settlePlan.dispatchCapability,
      filesModified, reportPath, orca,
    });
  }

  const target = classifyNotifyTarget(to);
  if (target.kind === 'unsupported') return { ok: false, hop, stage: '收件人', error: `${hop}：${target.error}` };

  const pre = probeRecipient(target, orca);
  if (!pre.ok) {
    if (isSoldierReworkHop(hop) && isCompletedDispatchProbe(pre)) {
      return {
        ok: false, hop, stage: '收件人',
        error: `${hop}：士兵已下班（过早 worker_done），红项打不进活人。不要开下一跳救人（#677）。人走了才升级给帅。`,
        recipient: pre,
      };
    }
    return { ok: false, hop, stage: '收件人', unscanned: !!pre.unscanned, error: `${hop}：${pre.error}`, recipient: pre };
  }

  const sent = orca(argsOrchestrationSend({ to, subject, body, type, outcome }));
  if (!sent.ok) {
    const text = orcaErrorText(sent.error);
    return { ok: false, hop, stage: '发送', error: `${hop}：orca send 失败: ${text}`, recipient: pre };
  }

  const msg = extractSentMessage(sent.json);
  if (!msg) {
    return { ok: false, hop, stage: '回执', error: `${hop}：orca 说发出去了却没给消息回执 —— 拿不到回执就当没送到`, recipient: pre };
  }
  if (to) {
    const expected = String(to);
    const badHandle = msg.toHandle && msg.toHandle !== expected;
    const badDispatch = msg.toDispatch
      && (expected.startsWith('dispatch:')
        ? msg.toDispatch !== expected && msg.toDispatch !== expected.slice('dispatch:'.length)
        : msg.toDispatch !== expected);
    if (badHandle || badDispatch) {
      return {
        ok: false, hop, stage: '回执', messageId: msg.id,
        error: `${hop}：回执收件人是 ${msg.toHandle || msg.toDispatch}，与请求的 ${expected} 不一致（错投）`, recipient: pre,
      };
    }
  }

  const inbox = orca(argsOrchestrationInbox({ limit: inboxLimit, full: true }));
  if (!inbox.ok) {
    const text = orcaErrorText(inbox.error);
    return { ok: false, hop, stage: '复核', unscanned: true, messageId: msg.id, error: `${hop}：投递复核没查成: ${text}`, recipient: pre };
  }
  const found = findInboxMessage(inbox.json, msg.id);
  if (!found.scanned) {
    return { ok: false, hop, stage: '复核', unscanned: true, messageId: msg.id, error: `${hop}：复核没扫到任何消息样本，这次没查成`, recipient: pre };
  }
  if (!found.found) {
    return { ok: false, hop, stage: '复核', messageId: msg.id, error: `${hop}：回执给了 ${msg.id}，编排里却查不到这条消息`, recipient: pre };
  }

  return {
    ok: true, hop, stage: '已送达', messageId: msg.id,
    to: msg.toHandle ?? (pre.id || null),
    deliveredAt: found.message?.delivered_at ?? null,
    recipient: pre,
    sampled: found.sampled,
  };
}

/** #551：发 worker_done 后必须核 Dispatch 变成 completed，落库无效力 = 未结算。 */
export function settleDispatch({
  hop = '闭环结算', subject, body = '', outcome, taskId, dispatchId,
  from, dispatchCapability, filesModified, reportPath, orca,
} = {}) {
  if (typeof orca !== 'function') throw new Error('settleDispatch 要 orca 执行器');

  const shown = orca(argsWorkerShow({ dispatch: dispatchId }));
  if (!shown.ok) {
    const text = orcaErrorText(shown.error);
    if (/dispatch_not_found|not_found/i.test(text)) {
      return { ok: false, hop, stage: '结算', settled: false, error: `${hop}：未结算：Dispatch 不存在（${text}）` };
    }
    return {
      ok: false, hop, stage: '结算', settled: false, unscanned: true,
      error: `${hop}：未结算：Dispatch 状态没查成（没查成 ≠ 未 completed）：${text}`,
    };
  }
  const before = readDispatchSettlement(shown.json);
  if (!before.ok) {
    return { ok: false, hop, stage: '结算', settled: false, unscanned: true, error: `${hop}：未结算：${before.error}` };
  }
  if (before.settled) {
    return {
      ok: false, hop, stage: '结算', settled: false,
      error: `${hop}：未结算：Dispatch 已经 completed，不能再发 worker_done`,
    };
  }
  const sender = from || before.assigneeHandle;
  if (!sender) {
    return {
      ok: false, hop, stage: '结算', settled: false,
      error: `${hop}：未结算：缺 --from，且 worker-show 没有 assignee_handle（错 pane 无法对齐）`,
    };
  }

  const sent = orca(argsOrchestrationSend({
    subject, body, type: 'worker_done', outcome,
    taskId, dispatchId, dispatchCapability, from: sender,
    filesModified, reportPath,
  }));
  if (!sent.ok) {
    const text = orcaErrorText(sent.error);
    const pane = isWrongPaneWorkerDoneError(sent.error);
    return {
      ok: false, hop, stage: '结算', settled: false, wrongPane: pane,
      error: `${hop}：未结算：${pane ? '错误 pane 发送（发送方不是 Dispatch 本人）' : 'orca send 失败'}：${text}`,
    };
  }
  const msg = extractSentMessage(sent.json);

  const afterShow = orca(argsWorkerShow({ dispatch: dispatchId }));
  if (!afterShow.ok) {
    const text = orcaErrorText(afterShow.error);
    return {
      ok: false, hop, stage: '结算', settled: false, unscanned: true, messageId: msg?.id || null,
      error: `${hop}：未结算：发出后 Dispatch 状态没查成（没查成 ≠ 未变 completed）：${text}`,
    };
  }
  const after = readDispatchSettlement(afterShow.json);
  if (!after.ok) {
    return {
      ok: false, hop, stage: '结算', settled: false, unscanned: true, messageId: msg?.id || null,
      error: `${hop}：未结算：${after.error}`,
    };
  }
  if (!after.settled) {
    return {
      ok: false, hop, stage: '结算', settled: false, messageId: msg?.id || null,
      status: after.status, workerState: after.workerState,
      error: `${hop}：未结算：消息已落库但 Dispatch 仍是 ${after.status || after.workerState || '非 completed'}（落库无结算效力）`,
    };
  }
  return {
    ok: true, hop, stage: '已结算', settled: true,
    messageId: msg?.id || null,
    dispatchId, taskId, outcome,
    status: after.status, workerState: after.workerState,
    from: sender,
  };
}
