// scripts/lib/run-lifecycle.mjs —— Run 生命周期与求救通道纯函数（issue #593）
//
// 改这段前必须知道：
//   1. 一个终端不能同时当两个 Run 的 coordinator（2026-08-17 实验：第二次
//      run-create/run-use 会把第一个的 coordinator_handle 踢成 null）。
//   2. orca 没有 run-delete。退役 = 关信箱台 + 删租约；Run 墓碑留在 run-list，
//      coordinator 变空或指向死终端。
//   3. check --run 只有指定终端是该 Run 当前 coordinator 才放行；跨 Run 读信
//      用 orchestration inbox（不绑 coordinator）或 check --terminal <台>。
//   4. 在途单的 Run 不许被 gc。判据是盘面上还挂着它的任务树（含待收口）。
//     活着但树已不在盘面 = 归档正在收自己，不保护（#601）。

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

/**
 * 不许退役的 Run：盘面上还挂着它的任务树（含待收口）。
 * 活着但树已经不在盘面 = 归档正在收自己的树，不保护（#601：#598 实跑
 * 时 dispatch 仍是 ready/dispatched，退役被跳过，台没关）。
 * 活着但没有 worktreeId：无法证明树已走，保守保护。
 */
export function protectedRunIds({ workers, worktrees } = {}) {
  const prot = new Set();
  if (!Array.isArray(workers)) return prot;
  const board = boardWorktreeIds(worktrees);
  for (const w of workers) {
    const runId = w?.runId;
    if (!runId || isLegacyRun({ id: runId, legacy: 0 })) continue;
    const wt = w.resource?.worktreeId;
    if (worktreeMatches(board, wt)) {
      prot.add(runId);
      continue;
    }
    if (isLiveDispatch(w) && !wt) prot.add(runId);
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

function pathMatches(workerTreeId, paths) {
  if (!workerTreeId || !paths || paths.size === 0) return false;
  const norm = String(workerTreeId).replace(/\\/g, '/').toLowerCase();
  for (const raw of paths) {
    const p = String(raw || '').replace(/\\/g, '/').toLowerCase();
    if (!p) continue;
    if (norm === p || norm.endsWith(`/${p}`) || norm.endsWith(`::${p}`)) return true;
  }
  return false;
}

/** 即将删掉的树对应哪些 Run（从 worker-list 反查）。没查成与查到 0 分开。 */
export function resolveRunsForWorktrees({ workers, treeIds, treePaths } = {}) {
  if (!Array.isArray(workers)) {
    return { ok: false, unscanned: true, error: 'worker-list 结构不认识', runIds: [] };
  }
  const want = new Set((treeIds || []).filter(Boolean).map(String));
  const paths = new Set((treePaths || []).filter(Boolean).map(String));
  if (want.size === 0 && paths.size === 0) {
    return { ok: true, unscanned: false, runIds: [], scanned: workers.length };
  }
  const runIds = [];
  const seen = new Set();
  for (const w of workers) {
    const wt = w?.resource?.worktreeId;
    if (!wt) continue;
    if (!worktreeMatches(want, wt) && !pathMatches(wt, paths)) continue;
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

/**
 * 关台目标必须能证明「这就是本 Run 的信箱台」。
 * coordinator_handle 会被 run-use 临时借走或指到帅的终端，不能单独当身份（#601 审官红 1）。
 * 证明链：租约 runId 对，再加租约 handle 在盘面，或 preview 唯一命中本 run 的 READY 行。
 * 租约过期（now - lease.ts > lease.ttlMs）直接 alreadyGone，不再查 OS 进程表 /
 * handle / preview 佐证（#635：PID 复用会让「数字还活着」永久假阳性）。
 * 租约未过期却证不出 → 失败，不许只删文件宣告 retired。
 */
export function previewHandlesForRun(terminals, runId, mark = 'INBOX_STATION_READY') {
  if (!Array.isArray(terminals) || !runId) return [];
  const needle = `run=${runId}`;
  const out = [];
  for (const t of terminals) {
    const preview = String(t?.preview || '');
    if (preview.includes(mark) && preview.includes(needle) && t.handle) out.push(t.handle);
  }
  return out;
}

export function resolveStationCloseTarget({
  runId,
  lease,
  leaseRead,
  now = Date.now(),
  coordinatorHandle,
  terminals,
  previewHandles,
} = {}) {
  if (!runId) return { ok: false, error: 'retire 要 --run' };
  if (leaseRead === 'unscanned') {
    return { ok: false, unscanned: true, error: '租约没读成，不能关台' };
  }
  if (!Array.isArray(terminals)) {
    return { ok: false, unscanned: true, error: 'terminal list 没查成，不能关台' };
  }
  if (lease && lease.runId && lease.runId !== runId) {
    return { ok: false, error: `租约归属 ${lease.runId}，不是 ${runId}，拒关` };
  }

  // #635：过期只看租约 ts+ttlMs。相等仍算未过期（与 isLeaseFresh 的 age <= ttl 对齐）。
  if (leaseTtlExpired(lease, now)) {
    return {
      ok: true,
      action: 'alreadyGone',
      closeHandle: null,
      reason: 'pid-dead-reused',
    };
  }

  const previews = [...new Set((previewHandles || []).filter(Boolean).map(String))];
  const onBoard = new Set(
    (terminals || []).map(t => t && t.handle).filter(Boolean).map(String),
  );
  const leaseHandle = lease && typeof lease.handle === 'string' && lease.handle
    ? lease.handle
    : null;

  if (leaseHandle) {
    const seen = onBoard.has(leaseHandle);
    if (!seen) {
      return {
        ok: false,
        error: `租约未过期，但 terminal list 找不到 handle ${leaseHandle}，证不出对应关系`,
      };
    }
    return {
      ok: true,
      action: 'close',
      closeHandle: leaseHandle,
      reason: 'lease-handle',
      coordinatorStolen: Boolean(coordinatorHandle && coordinatorHandle !== leaseHandle),
    };
  }

  if (lease) {
    if (previews.length === 1) {
      return {
        ok: true,
        action: 'close',
        closeHandle: previews[0],
        reason: 'preview-unique',
        coordinatorStolen: Boolean(coordinatorHandle && coordinatorHandle !== previews[0]),
      };
    }
    if (previews.length > 1) {
      return { ok: false, error: `租约无 handle 且 preview 命中 ${previews.length} 个台，证不唯一` };
    }
    return {
      ok: false,
      error: '租约未过期，但没有 handle、preview 也认不出信箱台，拒删文件',
    };
  }

  return {
    ok: true,
    action: 'alreadyGone',
    closeHandle: null,
    reason: 'no-lease',
  };
}

/** now - lease.ts > lease.ttlMs 才过期。ts/ttl 读不成则不过期，走未过期的身份证明。 */
export function leaseTtlExpired(lease, now = Date.now()) {
  if (!lease) return false;
  const ts = Number(lease.ts);
  const ttlMs = Number(lease.ttlMs);
  if (!Number.isFinite(ts) || !Number.isFinite(now) || !Number.isFinite(ttlMs) || ttlMs <= 0) {
    return false;
  }
  return now - ts > ttlMs;
}

/**
 * 租约/日志还在 = 待退；orca 没有 run-delete，run-list 里剩下的是墓碑。
 * 探头没查成必须 unscanned，不许把「没查成」当成「全是墓碑」。
 */
export function partitionGcTargets(retireRuns, { leaseExistsFor } = {}) {
  const pending = [];
  const tombstones = [];
  if (typeof leaseExistsFor !== 'function') {
    return {
      ok: false,
      unscanned: true,
      error: '没给租约探头，分不出待退和墓碑',
      pending,
      tombstones,
    };
  }
  for (const run of retireRuns || []) {
    if (!run?.id) continue;
    let exists;
    try {
      exists = leaseExistsFor(run.id);
    } catch (e) {
      return {
        ok: false,
        unscanned: true,
        error: `租约没查成 ${run.id}：${e && e.message ? e.message : e}`,
        pending,
        tombstones,
      };
    }
    if (exists == null) {
      return {
        ok: false,
        unscanned: true,
        error: `租约没查成 ${run.id}：探头返回空`,
        pending,
        tombstones,
      };
    }
    if (exists) pending.push(run);
    else tombstones.push(run);
  }
  return { ok: true, unscanned: false, pending, tombstones };
}

/** 真关 = 当场 terminal close 掉了活台；本已关 = 没关到活台（含只删到租约）。不许用删文件冒充关台。 */
export function classifyRetireOutcome(one) {
  if (!one || one.ok !== true) {
    return {
      bucket: 'failed',
      runId: one && one.runId,
      error: (one && one.error) || '退役失败',
    };
  }
  const closedLive = Boolean(
    one.closed && one.closed.handle && one.closed.ok && !one.closed.alreadyGone,
  );
  if (closedLive) {
    return { bucket: 'closed', runId: one.runId, closed: one.closed, removed: one.removed || [] };
  }
  return { bucket: 'alreadyGone', runId: one.runId, closed: one.closed, removed: one.removed || [] };
}

export function summarizeRetireResults(results) {
  const closed = [];
  const alreadyGone = [];
  const failed = [];
  for (const one of results || []) {
    const c = classifyRetireOutcome(one);
    if (c.bucket === 'closed') closed.push(c);
    else if (c.bucket === 'alreadyGone') alreadyGone.push(c);
    else failed.push(c);
  }
  return {
    closedCount: closed.length,
    alreadyGoneCount: alreadyGone.length,
    failedCount: failed.length,
    closed,
    alreadyGone,
    failed,
  };
}

/** --apply 时墓碑不再次关台，但必须计入 alreadyGone，否则「本已关」永远不含它们。 */
export function summarizeGcApply({ pendingResults, tombstones } = {}) {
  const tallied = summarizeRetireResults(pendingResults);
  const tombstoneItems = (tombstones || []).map((r) => ({
    bucket: 'alreadyGone',
    runId: r && (r.id || r.runId),
    source: 'tombstone',
  }));
  return {
    ...tallied,
    alreadyGone: [...tallied.alreadyGone, ...tombstoneItems],
    alreadyGoneCount: tallied.alreadyGoneCount + tombstoneItems.length,
    tombstoneAlreadyGoneCount: tombstoneItems.length,
  };
}

/** 删树之前的退役收口。任何映射/名单/关台失败都 ok:false，不许装成归档成功。 */
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

export function planStationRetire({ runId, coordinatorHandle, closeHandle, files } = {}) {
  if (!runId) return { ok: false, error: 'retire 要 --run' };
  return {
    ok: true,
    runId,
    closeHandle: closeHandle ?? coordinatorHandle ?? null,
    files: Array.isArray(files) ? files.filter(Boolean) : [],
  };
}

export function applyStationRetire(plan, { closeTerminal, unlink } = {}) {
  if (!plan || plan.ok !== true) {
    return { ok: false, error: (plan && plan.error) || '没有退役计划', removed: [] };
  }
  const closed = { handle: plan.closeHandle, ok: true, alreadyGone: !plan.closeHandle };
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
