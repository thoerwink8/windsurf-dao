// scripts/lib/turn-outcomes.mjs —— 把执行体的真实 turn 结果折成「每条腿的成败账」（#1342）
//
// 改这段代码前必须知道的四件事：
//
// 1. **熔断器原来只吃探针和撞死指纹，不吃真实流量。** 行业做法（LiteLLM / Portkey 的
//    circuit breaker）是按真实请求的失败率开闸——探针一分钟一针，真流量一小时几十条；
//    探针绿的时候真流量可以 25% 成功率（2026-09-17 帅位实测：同机同时段，relay 上生产
//    turn 2 ok / 6 error，而探针表里对应 key 是 green）。这里就是那条缺的线。
//
// 2. **数据源是 mirasim 自己写的分析事件**（`~/.mirasim/analytics/events-<日>.ndjson` 按天、
//    `~/.mirasim/diag/ev-<日时>.ndjson` 按 UTC 小时），只读不写。`turn.submit` 带 agent/model，
//    `turn.finish` 带 ok/errorCode，两者**没有共同的 turnId**，按 bootId 内 FIFO 配对——
//    这是它们唯一的顺序关系，配不上的一律记 `?`，不猜。
//
// 3. **先扣掉我们自己杀的，再算失败率。** errorCode=interrupted 的 236 条里 231 条在 5 秒内
//    贴着一条我们发的 turn.stop（两生产者拉锯 / 看门狗停活会话）。把自杀记成上游失败，
//    熔断器会把一条好腿判死——那正是要防的错方向。`aborted` 同理（用户/编排取消）。
//
// 4. **key 用 provider-probe 的那一套**，别在这里再发明一份。codex 经 mirasim 起的会话一律
//    走它注入的代理（HTTPS_PROXY + 自家 MITM CA，实测于 app-server 的 /proc/<pid>/environ），
//    出口是 relay，所以 agent=codex 归 `relay:codex`；其余 agent 按选型表的落地算。

/** 我们自己造成的结束：不算上游失败，也不算成功。 */
export const SELF_INFLICTED_CODES = new Set(['interrupted', 'aborted']);

/** mirasim 起的 codex 会话的传输腿。所有 codex 模型（luna / sol / …）共用这条腿，坏是一起坏。 */
export const RELAY_CODEX_TARGET = 'relay:codex';

/**
 * 一条 turn.finish 的归类。
 * @returns {'ok'|'self'|'upstream'}
 */
export function classifyTurnOutcome(props) {
  const p = props && typeof props === 'object' ? props : {};
  if (p.ok === true) return 'ok';
  const code = p.errorCode == null ? '' : String(p.errorCode);
  return SELF_INFLICTED_CODES.has(code) ? 'self' : 'upstream';
}

/**
 * 把原始事件流配成 turn 记录。只认 turn.submit / turn.finish；同一 bootId 内 FIFO。
 * 事件可来自多个文件、顺序以传入为准（调用方按文件名排好）。同 id 的重复事件只算一次。
 *
 * @param {Array<{id?:string,name:string,ts:string,bootId?:string,props?:object}>} events
 * @returns {Array<{ts:string,agent:string,model:string,kind:'ok'|'self'|'upstream',errorCode:string|null,durationMs:number|null}>}
 */
export function pairTurnEvents(events) {
  const pending = new Map(); // bootId → [{agent, model}]
  const seen = new Set();
  const out = [];
  for (const e of Array.isArray(events) ? events : []) {
    if (!e || typeof e !== 'object') continue;
    if (e.id != null) {
      const id = String(e.id);
      if (seen.has(id)) continue;
      seen.add(id);
    }
    const boot = e.bootId == null ? '' : String(e.bootId);
    const props = e.props && typeof e.props === 'object' ? e.props : {};
    if (e.name === 'turn.submit') {
      if (!pending.has(boot)) pending.set(boot, []);
      pending.get(boot).push({ agent: String(props.agent || '?'), model: String(props.model || '?') });
      continue;
    }
    if (e.name !== 'turn.finish') continue;
    const q = pending.get(boot);
    const head = q && q.length ? q.shift() : { agent: '?', model: '?' };
    out.push({
      ts: typeof e.ts === 'string' ? e.ts : '',
      agent: head.agent,
      model: head.model,
      kind: classifyTurnOutcome(props),
      errorCode: props.ok === true ? null : (props.errorCode == null ? null : String(props.errorCode)),
      durationMs: Number.isFinite(Number(props.durationMs)) ? Number(props.durationMs) : null,
    });
  }
  return out;
}

/**
 * (agent, model) → 熔断/健康 key。认不出回 null（不猜；调用方跳过）。
 * @param {{agent:string, model:string}} turn
 * @param {{models?:Array, probeTargetForModel?:Function}} deps  models 是 modelsFromJson 的输出
 */
export function turnTargetOf(turn, { models, probeTargetForModel } = {}) {
  const agent = turn && turn.agent != null ? String(turn.agent) : '';
  if (agent === 'codex') return RELAY_CODEX_TARGET;
  const model = turn && turn.model != null ? String(turn.model) : '';
  if (!model || model === '?' || typeof probeTargetForModel !== 'function' || !Array.isArray(models)) return null;
  const entry = models.find((m) => m && String(m.id) === model);
  if (!entry) return null;
  try { return probeTargetForModel(entry) || null; } catch { return null; }
}

/**
 * 按 key 汇总窗口内的成败。`total` 只算 ok + upstream（自杀不进分母——它既不证明腿好也不证明腿坏）。
 * @returns {Record<string, {ok:number, upstream:number, self:number, total:number, lastTs:string|null}>}
 */
export function summarizeTurnOutcomes(turns, { sinceMs = 0, targetOf } = {}) {
  const map = typeof targetOf === 'function' ? targetOf : () => null;
  const out = {};
  for (const t of Array.isArray(turns) ? turns : []) {
    if (!t) continue;
    const ms = Date.parse(t.ts || '');
    if (!Number.isFinite(ms) || ms < sinceMs) continue;
    const key = map(t);
    if (!key) continue;
    const row = out[key] || (out[key] = { ok: 0, upstream: 0, self: 0, total: 0, lastTs: null });
    row[t.kind] += 1;
    if (t.kind !== 'self') row.total += 1;
    if (!row.lastTs || t.ts > row.lastTs) row.lastTs = t.ts;
  }
  return out;
}

/** 失败率（百分比，整数）。total=0 回 null——「没样本」和「0%」必须分得开。 */
export function failRatePct(row) {
  if (!row || !Number.isFinite(Number(row.total)) || Number(row.total) <= 0) return null;
  return Math.round((Number(row.upstream) || 0) * 100 / Number(row.total));
}

/**
 * 读 mirasim 事件文件。只读 mtime 落在窗口内的文件（旧文件里不可能有窗口内的事件）。
 * 目录不在 / 读不了 → `unscanned:true`，调用方不据此改任何状态（没查成 ≠ 没失败）。
 */
export function readTurnEvents({
  home, sinceMs = 0,
  readdir, readFile, stat,
} = {}) {
  if (!home || typeof readdir !== 'function' || typeof readFile !== 'function' || typeof stat !== 'function') {
    return { ok: false, unscanned: true, events: [], files: [], why: '缺 home 或文件系统注入' };
  }
  const dirs = [`${home}/.mirasim/analytics`, `${home}/.mirasim/diag`];
  const files = [];
  let anyDir = false;
  for (const d of dirs) {
    let names;
    try { names = readdir(d); anyDir = true; } catch { continue; }
    for (const n of names) {
      if (!/\.ndjson$/.test(n)) continue;
      const p = `${d}/${n}`;
      let mtime = 0;
      try { mtime = Number(stat(p).mtimeMs) || 0; } catch { continue; }
      if (mtime < sinceMs) continue;
      files.push(p);
    }
  }
  if (!anyDir) return { ok: false, unscanned: true, events: [], files: [], why: '~/.mirasim/{analytics,diag} 都读不到' };
  files.sort();
  const events = [];
  for (const p of files) {
    let text;
    try { text = String(readFile(p, 'utf8')); } catch { continue; }
    for (const line of text.split('\n')) {
      const s = line.trim();
      if (!s) continue;
      try {
        const e = JSON.parse(s);
        if (e && typeof e === 'object') events.push(e);
      } catch { /* 半截行：文件正在写，跳过 */ }
    }
  }
  return { ok: true, unscanned: false, events, files };
}
