// scripts/lib/run-lifecycle.mjs —— Run 生命周期与求救通道纯函数（issue #593）
//
// 改这段前必须知道：
//   1. 一个终端不能同时当两个 Run 的 coordinator（2026-08-17 实验：第二次
//      run-create/run-use 会把第一个的 coordinator_handle 踢成 null）。
//   2. orca 没有 run-delete。退役 = 关信箱台 + 删租约；Run 墓碑留在 run-list，
//      coordinator 变空或指向死终端。
//   3. check --run 只有指定终端是该 Run 当前 coordinator 才放行；跨 Run 读信
//      用 orchestration inbox（不绑 coordinator）或 check --terminal <台>。
//   4. 在途单的 Run 不许被 gc。活着的 dispatch、以及盘面上还在的任务树
//     （含待收口）都算在途。

export const ASK_TIMEOUT_MARK = 'ASK_TIMEOUT';

export function isLegacyRun(run) {
  return !run || run.legacy === 1 || run.legacy === true || run.id === 'run_legacy_local';
}

export function isLiveDispatch(worker) {
  if (!worker) return false;
  const st = worker.dispatchStatus;
  const ws = worker.workerState;
  if (st === 'dispatched' || st === 'running') return true;
  if (ws === 'ready' || ws === 'working' || ws === 'waiting') return true;
  return false;
}

export function boardWorktreeIds(worktrees) {
  const ids = new Set();
  if (!Array.isArray(worktrees)) return ids;
  for (const w of worktrees) {
    if (!w || w.isMainWorktree || w.isArchived) continue;
    const id = w.worktreeId || w.id;
    if (id) ids.add(id);
  }
  return ids;
}

function worktreeMatches(boardIds, workerTreeId) {
  const wt = String(workerTreeId || '');
  if (!wt) return false;
  for (const id of boardIds) {
    const s = String(id);
    if (wt === s || wt.endsWith(`::${s}`) || wt.endsWith(s)) return true;
  }
  return false;
}

/** 不许退役的 Run：活着的 dispatch，或盘面上还挂着任务树（含待收口）的。 */
export function protectedRunIds({ workers, worktrees } = {}) {
  const prot = new Set();
  if (!Array.isArray(workers)) return prot;
  const board = boardWorktreeIds(worktrees);
  for (const w of workers) {
    const runId = w?.runId;
    if (!runId || isLegacyRun({ id: runId, legacy: 0 })) continue;
    if (isLiveDispatch(w)) {
      prot.add(runId);
      continue;
    }
    if (worktreeMatches(board, w.resource?.worktreeId)) prot.add(runId);
  }
  return prot;
}

export function planRunGc({ runs, workers, worktrees } = {}) {
  if (!Array.isArray(runs)) {
    return { ok: false, unscanned: true, error: 'run-list 结构不认识（缺 runs 数组）', retire: [], keep: [] };
  }
  if (!Array.isArray(workers)) {
    return { ok: false, unscanned: true, error: 'worker-list 结构不认识（缺 workers 数组）', retire: [], keep: [] };
  }
  if (!Array.isArray(worktrees)) {
    return { ok: false, unscanned: true, error: 'worktree 盘面结构不认识', retire: [], keep: [] };
  }
  const prot = protectedRunIds({ workers, worktrees });
  const retire = [];
  const keep = [];
  const skippedLegacy = [];
  for (const run of runs) {
    if (!run?.id) continue;
    if (isLegacyRun(run)) {
      skippedLegacy.push(run);
      continue;
    }
    if (prot.has(run.id)) keep.push(run);
    else retire.push(run);
  }
  return {
    ok: true,
    unscanned: false,
    retire,
    keep,
    skippedLegacy,
    protected: [...prot],
  };
}

/** 即将删掉的树对应哪些 Run（从 worker-list 反查）。没查成与查到 0 分开。 */
export function resolveRunsForWorktrees({ workers, treeIds } = {}) {
  if (!Array.isArray(workers)) {
    return { ok: false, unscanned: true, error: 'worker-list 结构不认识', runIds: [] };
  }
  const want = new Set((treeIds || []).filter(Boolean).map(String));
  if (want.size === 0) return { ok: true, unscanned: false, runIds: [], scanned: workers.length };
  const runIds = [];
  const seen = new Set();
  for (const w of workers) {
    const wt = w?.resource?.worktreeId;
    if (!wt || !worktreeMatches(want, wt)) continue;
    const runId = w.runId;
    if (!runId || seen.has(runId)) continue;
    seen.add(runId);
    runIds.push(runId);
  }
  return { ok: true, unscanned: false, runIds, scanned: workers.length };
}

export function planInboxCollect({ worktrees, workers, runs } = {}) {
  if (!Array.isArray(worktrees)) {
    return { ok: false, unscanned: true, error: 'worktree 盘面结构不认识', items: [] };
  }
  if (!Array.isArray(workers)) {
    return { ok: false, unscanned: true, error: 'worker-list 结构不认识', items: [] };
  }
  if (!Array.isArray(runs)) {
    return { ok: false, unscanned: true, error: 'run-list 结构不认识', items: [] };
  }
  const prot = protectedRunIds({ workers, worktrees });
  const byId = new Map(runs.filter(r => r && r.id).map(r => [r.id, r]));
  const items = [];
  for (const runId of prot) {
    const run = byId.get(runId);
    if (!run) {
      items.push({ runId, state: 'run_not_found', coordinatorHandle: null });
      continue;
    }
    items.push({
      runId,
      state: 'pending',
      coordinatorHandle: run.coordinator_handle || null,
    });
  }
  return { ok: true, unscanned: false, items, protected: [...prot] };
}

function errorText(error) {
  if (error == null) return '';
  if (typeof error === 'string') return error;
  if (typeof error === 'object') {
    return String(error.message || error.code || JSON.stringify(error));
  }
  return String(error);
}

/**
 * 三态：empty / unscanned / run_not_found。
 * check 被 consumer_fenced 时，可退到 inbox 里按 run_id 过滤（inbox 不绑 coordinator）。
 */
export function classifyMailboxRead({
  ok, error, messages, inboxMessages, runId,
} = {}) {
  const text = errorText(error);
  const code = error && typeof error === 'object' ? String(error.code || '') : '';
  if (/run_not_found/i.test(`${code} ${text}`) || /Run .+ was not found/i.test(text)) {
    return { state: 'run_not_found', runId, messages: [], count: 0, error: text || code };
  }
  const fromCheck = ok && Array.isArray(messages) ? messages : [];
  const fromInbox = Array.isArray(inboxMessages)
    ? inboxMessages.filter(m => m && m.run_id === runId)
    : null;
  if (!ok && fromInbox == null) {
    return { state: 'unscanned', runId, messages: [], count: 0, error: text || 'check 没查成' };
  }
  const byId = new Map();
  for (const m of fromCheck) {
    if (m && m.id) byId.set(m.id, m);
  }
  if (fromInbox) {
    for (const m of fromInbox) {
      if (m && m.id) byId.set(m.id, m);
    }
  }
  const all = [...byId.values()];
  if (all.length === 0) return { state: 'empty', runId, messages: [], count: 0 };
  return { state: 'messages', runId, messages: all, count: all.length };
}

export function resolveReplyTarget({
  messageId, inboxMessages, runs, explicitFrom, explicitRun,
} = {}) {
  if (!messageId) return { ok: false, error: 'reply 要 --id' };
  if (!Array.isArray(inboxMessages)) {
    return { ok: false, unscanned: true, error: 'inbox 没查成，不是找不到这条消息' };
  }
  const msg = inboxMessages.find(m => m && m.id === messageId) || null;
  if (!msg) return { ok: false, error: `inbox 里找不到消息 ${messageId}` };
  const runId = explicitRun || msg.run_id || null;
  if (!runId) return { ok: false, error: '消息没有 run_id，给 --run' };
  const run = Array.isArray(runs) ? (runs.find(r => r && r.id === runId) || null) : null;
  const from = explicitFrom || run?.coordinator_handle || null;
  return { ok: true, runId, from, message: msg };
}

/** reply 发信前的闸：没查成 / 没有台 handle 一律拦下，不许裸 reply。 */
export function resolveReplySender({
  messageId, explicitFrom, explicitRun, inboxOk, inboxMessages, runListOk, runs,
} = {}) {
  if (explicitFrom && explicitRun) {
    return { ok: true, from: explicitFrom, runId: explicitRun };
  }
  if (inboxOk === false) {
    return { ok: false, unscanned: true, error: 'inbox 没查成，不能猜 --from' };
  }
  if (runListOk === false && !explicitFrom) {
    return { ok: false, unscanned: true, error: 'run-list 没查成，不能猜 coordinator' };
  }
  const resolved = resolveReplyTarget({
    messageId,
    inboxMessages: inboxOk === false ? null : inboxMessages,
    runs: runListOk === false ? null : runs,
    explicitFrom,
    explicitRun,
  });
  if (!resolved.ok) return resolved;
  const from = explicitFrom || resolved.from;
  if (!from) {
    return { ok: false, error: '这个 Run 没有活着的 coordinator，给 --from <信箱台 handle>' };
  }
  return { ok: true, from, runId: explicitRun || resolved.runId };
}

export function parseAskTimeoutMs(raw, { defaultMs = 600000 } = {}) {
  if (raw == null || raw === '') {
    return { ok: true, timeoutMs: defaultMs, defaulted: true };
  }
  if (typeof raw === 'string' && !/^\d+$/.test(raw.trim())) {
    return { ok: false, error: `ask --timeout-ms 要正整数，实际 ${raw}` };
  }
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    return { ok: false, error: `ask --timeout-ms 要正整数，实际 ${raw}` };
  }
  return { ok: true, timeoutMs: n, defaulted: false };
}

/** 删树之后的退役收口。任何映射/名单/关台失败都 ok:false，不许装成归档成功。 */
export function finalizeWorktreeRmLifecycle({ mapped, gc, retireResults } = {}) {
  if (!mapped || mapped.ok !== true) {
    return {
      ok: false,
      unscanned: true,
      error: (mapped && mapped.error) || 'Run 映射没查成',
      retired: [],
      failed: [],
      skipped: [],
    };
  }
  if (!gc || gc.ok !== true) {
    return {
      ok: false,
      unscanned: true,
      error: (gc && gc.error) || '退役名单没查成',
      retired: [],
      failed: [],
      skipped: [],
    };
  }
  const retired = [];
  const skipped = [];
  const failed = [];
  for (const runId of mapped.runIds || []) {
    if (!gc.retire.some(r => r.id === runId)) {
      skipped.push({ runId, reason: '仍有在途单占用，不退役' });
      continue;
    }
    const one = (retireResults || []).find(r => r && r.runId === runId);
    if (!one) {
      failed.push({ runId, error: '退役结果缺失' });
      continue;
    }
    if (one.ok) retired.push(one);
    else failed.push(one);
  }
  if (failed.length) {
    return {
      ok: false,
      error: `Run 退役失败：${failed.map(f => f.runId || f.error).join('、')}`,
      retired,
      failed,
      skipped,
    };
  }
  return { ok: true, retired, failed, skipped };
}

export function findThreadReply(messages, questionId) {
  if (!Array.isArray(messages) || !questionId) return null;
  return messages.find(m => m && m.thread_id === questionId) || null;
}

export function classifyAskPoll({ reply, elapsedMs, timeoutMs, unscanned, error } = {}) {
  if (unscanned) return { state: 'unscanned', error: error || 'ask 收信没查成' };
  if (reply) {
    return {
      state: 'answered',
      body: reply.body ?? '',
      messageId: reply.id || null,
    };
  }
  const limit = Number(timeoutMs);
  const elapsed = Number(elapsedMs);
  if (Number.isFinite(limit) && Number.isFinite(elapsed) && elapsed >= limit) {
    return { state: 'timeout', mark: ASK_TIMEOUT_MARK };
  }
  return { state: 'waiting' };
}

export function planStationRetire({ runId, coordinatorHandle, files } = {}) {
  if (!runId) return { ok: false, error: 'retire 要 --run' };
  return {
    ok: true,
    runId,
    closeHandle: coordinatorHandle || null,
    files: Array.isArray(files) ? files.filter(Boolean) : [],
  };
}

export function applyStationRetire(plan, { closeTerminal, unlink } = {}) {
  if (!plan || plan.ok !== true) {
    return { ok: false, error: (plan && plan.error) || '没有退役计划', removed: [] };
  }
  const closed = { handle: plan.closeHandle, ok: true, alreadyGone: false };
  if (plan.closeHandle) {
    if (typeof closeTerminal !== 'function') {
      return { ok: false, error: 'applyStationRetire 没给 closeTerminal', removed: [] };
    }
    const r = closeTerminal(plan.closeHandle);
    const text = errorText(r && (r.error || r.err));
    if (!r || r.ok !== true) {
      if (/tab_not_found|terminal_handle_stale/i.test(text)) {
        closed.ok = true;
        closed.alreadyGone = true;
      } else {
        return {
          ok: false,
          error: `关信箱台失败：${text || 'close 失败'}`,
          closed,
          removed: [],
        };
      }
    }
  }
  if (typeof unlink !== 'function') {
    return { ok: false, error: 'applyStationRetire 没给 unlink', closed, removed: [] };
  }
  const removed = [];
  for (const file of plan.files) {
    try {
      unlink(file);
      removed.push(file);
    } catch (e) {
      if (e && e.code === 'ENOENT') continue;
      return {
        ok: false,
        error: `删租约失败 ${file}：${e && e.message ? e.message : e}`,
        closed,
        removed,
      };
    }
  }
  return { ok: true, state: 'retired', runId: plan.runId, closed, removed };
}
