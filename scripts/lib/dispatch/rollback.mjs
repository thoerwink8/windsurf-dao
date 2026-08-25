// scripts/lib/dispatch/rollback.mjs —— 回滚域（#762 拆分）
//
// 改这段前必须知道：生产回滚先 fence（worker-stop + 未绑定 task 置 failed），
// 再 worker-list 核残留。没查成或仍有活动 Dispatch → fail-visible，不删树。
// 回滚步骤跑完后的失败必须单独叫，不能只埋在返回 JSON 里。

import { orcaErrorText } from '../orca-error.mjs';
import { argsTerminalClose, argsWorkerList, argsWorkerStop, argsTaskUpdate, argsWorktreeRm } from './args.mjs';

/** 回滚时报「本来就没了」也算成功（幂等）。 */
export function rollbackErrorAlreadyGone(error) {
  return /tab_not_found|terminal_handle_stale|dispatch_not_found|already_stopped|already_fenced|already_released|task_not_found|already_failed/i.test(orcaErrorText(error));
}

export function unboundTaskIds({ taskIds, workers } = {}) {
  const bound = new Set((Array.isArray(workers) ? workers : []).map(w => w && w.taskId).filter(Boolean));
  return (Array.isArray(taskIds) ? taskIds : []).filter(id => id && !bound.has(id));
}

export function planDispatchFence({ dispatchIds, taskIds, workers } = {}) {
  const steps = [];
  const seenId = new Set();
  for (const id of (Array.isArray(dispatchIds) ? dispatchIds : []).filter(Boolean).slice().reverse()) {
    if (seenId.has(id)) continue;
    seenId.add(id);
    steps.push(argsWorkerStop({ dispatch: id }));
  }
  const seenTask = new Set();
  for (const id of unboundTaskIds({ taskIds, workers }).slice().reverse()) {
    if (seenTask.has(id)) continue;
    seenTask.add(id);
    steps.push(argsTaskUpdate({ id, status: 'failed' }));
  }
  return steps;
}

export function planDispatchDestroy({
  workerId, workerHandle, reviewerId, reviewerHandle, handles, childIds, childHandles,
} = {}) {
  const steps = [];
  if (reviewerHandle) steps.push(argsTerminalClose({ terminal: reviewerHandle, tab: true }));
  if (reviewerId) steps.push(argsWorktreeRm({ worktree: reviewerId, force: true }));
  for (const handle of Array.isArray(childHandles) ? childHandles : []) {
    if (handle) steps.push(argsTerminalClose({ terminal: handle, tab: true }));
  }
  const extra = Array.isArray(handles) ? handles.filter(Boolean) : [];
  const seen = new Set();
  for (const h of extra.slice().reverse()) {
    if (seen.has(h) || h === workerHandle || h === reviewerHandle) continue;
    if (Array.isArray(childHandles) && childHandles.includes(h)) continue;
    seen.add(h);
    steps.push(argsTerminalClose({ terminal: h, tab: true }));
  }
  if (workerHandle) steps.push(argsTerminalClose({ terminal: workerHandle, tab: true }));
  for (const id of Array.isArray(childIds) ? childIds : []) {
    if (id) steps.push(argsWorktreeRm({ worktree: id, force: true }));
  }
  if (workerId) steps.push(argsWorktreeRm({ worktree: workerId, force: true }));
  return steps;
}

export function planDispatchRollback(created = {}) {
  return [...planDispatchFence(created), ...planDispatchDestroy(created)];
}

export function execRollbackStep(args, exec) {
  let r = exec(args);
  const step = {
    cmd: args.join(' '),
    ok: !!r.ok,
    error: r.ok ? undefined : orcaErrorText(r.error),
  };
  if (!r.ok && rollbackErrorAlreadyGone(r.error)) {
    step.ok = true;
    step.alreadyGone = true;
    step.error = undefined;
  } else if (!r.ok && args[0] === 'terminal' && args[1] === 'close' && args.includes('--tab')) {
    const retryArgs = args.filter(a => a !== '--tab');
    const retry = exec(retryArgs);
    step.retryWithoutTab = {
      cmd: retryArgs.join(' '),
      ok: !!retry.ok,
      error: retry.ok ? undefined : orcaErrorText(retry.error),
    };
    if (retry.ok || rollbackErrorAlreadyGone(retry.error)) {
      step.ok = true;
      step.alreadyGone = !retry.ok;
      step.recovered = !!retry.ok;
      step.error = undefined;
    }
  }
  return step;
}

export function inspectRollbackResidue(created, exec) {
  const ids = Array.isArray(created?.dispatchIds) ? created.dispatchIds.filter(Boolean) : [];
  if (ids.length === 0) return { ok: true, leftover: [], skipped: true, unscanned: false };
  const listed = exec(argsWorkerList());
  if (!listed || !listed.ok) {
    return {
      ok: false,
      unscanned: true,
      leftover: [],
      error: `回滚后 worker-list 没查成：${orcaErrorText(listed && listed.error)}`,
    };
  }
  const workers = listed.json?.result?.workers;
  return classifyDispatchResidue({ dispatchIds: ids, workers });
}

/**
 * 生产回滚：先 fence（worker-stop + 未绑定 task 置 failed），再 worker-list 核残留。
 * 没查成或仍有活动 Dispatch → fail-visible，不删树。
 */
export function applyDispatchRollback(created, { exec } = {}) {
  if (typeof exec !== 'function') {
    return {
      ok: false,
      rollback: [],
      rollbackFailed: true,
      residue: { ok: false, unscanned: true, leftover: [], error: 'applyDispatchRollback 没拿到 exec（没查成）' },
      alarm: 'applyDispatchRollback 没拿到 exec（没查成）',
    };
  }
  const rollback = [];
  for (const args of planDispatchFence(created)) {
    rollback.push(execRollbackStep(args, exec));
  }
  const residue = inspectRollbackResidue(created, exec);
  if (!residue.ok) {
    for (const args of planDispatchDestroy(created)) {
      if (args[0] === 'worktree') continue;
      rollback.push(execRollbackStep(args, exec));
    }
    const report = rollbackReport(rollback);
    const alarm = residue.error || report.alarm;
    return { ok: false, rollback, rollbackFailed: true, residue, alarm };
  }
  for (const args of planDispatchDestroy(created)) {
    rollback.push(execRollbackStep(args, exec));
  }
  const report = rollbackReport(rollback);
  return {
    ok: !report.rollbackFailed,
    rollback,
    rollbackFailed: report.rollbackFailed,
    residue,
    alarm: report.alarm,
  };
}

/** 回滚后还剩没有结算的 Dispatch 吗。没查成与「扫完 0 条残留」分开。 */
export function classifyDispatchResidue({ dispatchIds, workers } = {}) {
  const ids = (Array.isArray(dispatchIds) ? dispatchIds : []).filter(Boolean).map(String);
  if (workers == null) {
    return {
      ok: false,
      unscanned: true,
      leftover: [],
      error: 'classifyDispatchResidue 没拿到 worker-list（没查成）',
    };
  }
  if (!Array.isArray(workers)) {
    return {
      ok: false,
      unscanned: true,
      leftover: [],
      error: 'classifyDispatchResidue 的 workers 不是数组（没查成）',
    };
  }
  const leftover = [];
  for (const id of ids) {
    const hit = workers.find(w => String(w?.dispatchId || '') === id);
    if (!hit) continue;
    const status = String(hit.dispatchStatus || '');
    const state = String(hit.workerState || '');
    const settled = /^(completed|failed|cancelled|stopped|fenced)$/i.test(status)
      || /^(succeeded|failed|cancelled|stopped)$/i.test(state);
    if (!settled) leftover.push({ dispatchId: id, dispatchStatus: status, workerState: state });
  }
  if (leftover.length) {
    return {
      ok: false,
      unscanned: false,
      leftover,
      error: `回滚后仍有活动 Dispatch：${leftover.map(x => x.dispatchId).join(',')}`,
    };
  }
  return { ok: true, unscanned: false, leftover: [] };
}

/** 回滚步骤跑完后的可见性：失败必须单独叫，不能只埋在返回 JSON 里。 */
export function rollbackReport(steps) {
  const list = (Array.isArray(steps) ? steps : []).map((s) => {
    if (!s || s.ok) return s;
    if (s.alreadyGone || rollbackErrorAlreadyGone(s.error)) {
      return { ...s, ok: true, alreadyGone: true, error: undefined };
    }
    return s;
  });
  const failed = list.filter(s => s && s.ok === false);
  if (failed.length === 0) {
    return { rollbackFailed: false, alarm: null, failed: [], steps: list };
  }
  const detail = failed.map(s => `${s.cmd || '?'} → ${s.error || '失败'}`).join('; ');
  return {
    rollbackFailed: true,
    alarm: `回滚失败，可能留下孤儿终端/树：${detail}`,
    failed,
    steps: list,
  };
}
