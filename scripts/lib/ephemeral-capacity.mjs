// scripts/lib/ephemeral-capacity.mjs —— 短命执行体的容量快照与对比（#1174）
//
// 每轮指挥官记一笔：活会话、树、CPU、内存、交卷后残留、清树失败。
// 对比只做减法，不编「能并发几个」的填空上限——那个数字已经退役。

export const SAMPLE_SCHEMA = 1;

export function snapshotCapacity({
  at,
  cpuBusy,
  memAvailableMb,
  loadNorm,
  inFlight,
  sessions,
  worktrees,
  leftoverAfterHandoff,
  cleanupFailures,
} = {}) {
  const n = (v) => {
    const x = Number(v);
    return Number.isFinite(x) ? x : null;
  };
  return {
    schema: SAMPLE_SCHEMA,
    at: typeof at === 'string' && at ? at : null,
    cpuBusy: n(cpuBusy),
    memAvailableMb: n(memAvailableMb),
    loadNorm: n(loadNorm),
    inFlight: Number.isInteger(inFlight) ? inFlight : null,
    sessions: Number.isInteger(sessions) ? sessions : null,
    worktrees: Number.isInteger(worktrees) ? worktrees : null,
    leftoverAfterHandoff: Number.isInteger(leftoverAfterHandoff) ? leftoverAfterHandoff : null,
    cleanupFailures: Number.isInteger(cleanupFailures) ? cleanupFailures : null,
  };
}

function delta(a, b, key) {
  if (a == null || b == null) return { ok: false, unscanned: true, key, why: `${key} 一侧没查成` };
  return { ok: true, key, before: a, after: b, delta: b - a };
}

/**
 * 改造前后对比。任一侧缺字段 → 该项 unscanned，不算「变好了」。
 * 并发能力用 inFlight（当时实际在跑的会话数），不用已退役的填空上限。
 */
export function compareCapacity(before, after) {
  if (!before || typeof before !== 'object' || !after || typeof after !== 'object') {
    return { ok: false, unscanned: true, error: '对比两侧不是快照对象', items: [] };
  }
  const keys = ['cpuBusy', 'memAvailableMb', 'loadNorm', 'inFlight', 'sessions', 'worktrees', 'leftoverAfterHandoff', 'cleanupFailures'];
  const items = keys.map((k) => delta(before[k], after[k], k));
  const unscanned = items.filter((x) => x.unscanned);
  return {
    ok: unscanned.length === 0,
    unscanned: unscanned.length > 0,
    items,
    why: unscanned.length
      ? `有 ${unscanned.length} 项没查成：${unscanned.map((x) => x.key).join('、')}`
      : '两侧字段齐全',
  };
}

/** 交卷后残留：名单里 cwd 落在该树上、状态还是 incomplete。名单没查成 → unscanned。 */
export function countLeftoverAfterHandoff(sessions, workdir, { stateOf } = {}) {
  if (!Array.isArray(sessions)) {
    return { ok: false, unscanned: true, count: 0, error: '会话名单没查成' };
  }
  const want = String(workdir || '').replace(/\\/g, '/').replace(/\/+$/, '');
  if (!want) return { ok: false, unscanned: true, count: 0, error: '没给交卷树路径' };
  const read = typeof stateOf === 'function'
    ? stateOf
    : (s) => String((s && (s.state || s.phase || '')) || '').toLowerCase();
  let count = 0;
  for (const s of sessions) {
    const cwd = String((s && (s.cwd || s.workdir || s.worktree)) || '').replace(/\\/g, '/').replace(/\/+$/, '');
    if (!cwd || (cwd !== want && !cwd.startsWith(`${want}/`))) continue;
    if (read(s) === 'incomplete') count += 1;
  }
  return { ok: true, count };
}
