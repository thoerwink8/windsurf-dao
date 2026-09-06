// scripts/lib/model-reconcile.mjs —— 选型表与实际跑的模型对账（#944）
//
// 改这段前必须知道：
//
//  · **真相源是「腿」节**（`docs/model-routing.json` 的四轴：模型@供应商/执行侧 + 状态），
//    不是「工人/审官/帅」那三节——那三节排的是**顺位**（该派谁），腿表才是**这条路在不在役**。
//    对账要问的是「实际跑的这条路，表里承认吗」，所以只能拿腿表比。
//
//  · **回执源是 mirasim 自己的用量账**：`~/.mirasim/insights/usage-*.ndjson`，每条调用带
//    `agent`(族) / `model` / `provider` / `status` / `leg` / `upstreamHost`。
//    #944 原正文写「`schedule_task` 不收 model ⇒ 拿不到实际模型 ⇒ 本仓改不动，要等 mirasim 侧支持」
//    ——**那条已作废**：实际模型一直写在这个文件里，缺的不是上游支持，是没人读。
//
//  · **只对 `leg==='relay'` 且 `status===200` 的调用对账。** 两个都是必要的：
//    `leg==='local'` 没打上游、没走腿；非 200 的调用没真的跑起来。不滤掉的话，
//    量额度用的探针（故意打不存在的型号换 422）会被判成「未登记模型在跑」。
//
//  · 供应商不猜：`upstreamHost` 认识才映射，不认识就原样带出去，宁可报成未登记，
//    也不要静默归到某条腿上——静默映射会让对账永远绿。

/** relay.mirasim.ai 是 mirasim 自己的中继（不是 api.anthropic.com，别认错）。 */
const HOST_TO_VENDOR = new Map([['relay.mirasim.ai', 'mirasim']]);

/**
 * 独立解析 ndjson——不复用 mirasim 的读法（自己查自己查不出错）。
 * 坏行单独计数：整份读不出来和「读到了但有坏行」是两回事。
 */
export function parseUsageNdjson(text) {
  const records = [];
  let badLines = 0;
  for (const line of String(text).split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      const o = JSON.parse(s);
      if (o && typeof o === 'object') records.push(o);
      else badLines++;
    } catch {
      badLines++;
    }
  }
  return { records, badLines };
}

/** 一条用量记录 → 它实际走的那条腿的四轴。认不出的维度留 null，由调用方判未登记。 */
export function usageToLeg(rec) {
  const host = rec && rec.upstreamHost ? String(rec.upstreamHost) : '';
  return {
    模型: rec && rec.model ? String(rec.model) : null,
    族: rec && rec.agent ? String(rec.agent) : null,
    供应商: HOST_TO_VENDOR.get(host) || (host || null),
    执行侧: 'mirasim',
  };
}

/**
 * 只看最近这一窗——腿表是「现在什么在役」的登记，拿三周前的旧流量对今天的表，
 * 会造出永远修不掉的红（实例：2026-09-05 帅位测了 4 次 haiku 探针，次日用户拍板
 * haiku 落后模型永不登记——月账里那 4 条若一直算数，这条红要挂到月底才换账文件）。
 * 窗口 48h：陈旧的一次性流量自己老化出窗，常役腿每天都有新流量、不受影响。
 */
export const RECENT_WINDOW_MS = 48 * 3600 * 1000;

/** 只留「真的走过腿」的调用：打了上游 + 跑成了 + 在近窗内（没时间戳的保守算在窗内）。 */
export function billableRecords(records, now = Date.now()) {
  return records.filter((r) => {
    if (!r || r.leg !== 'relay' || r.status !== 200) return false;
    if (!r.ts) return true;
    const t = Date.parse(r.ts);
    return Number.isNaN(t) || now - t <= RECENT_WINDOW_MS;
  });
}

const legId = (l) => `${l.模型}@${l.供应商}/${l.执行侧}`;

/**
 * 对账判官（纯函数）。
 *
 * @param {object[]|null} legs        腿表（`docs/model-routing.json` 的「腿」）；null = 没读成
 * @param {object[]|null} records     用量记录；null = 没读成
 * @param {string} [why]              没读成时的原因，原样带进 detail
 * @returns {{state:'ok'|'red'|'unknown', detail:string, count?:number, mismatches?:object[]}}
 */
export function classifyReconcile({ legs, records, why, now = Date.now() } = {}) {
  if (!Array.isArray(legs)) {
    return { state: 'unknown', detail: `腿表没读成（${why || '原因不明'}）——不是 0 条腿` };
  }
  if (!Array.isArray(records)) {
    return { state: 'unknown', detail: `用量账没读成（${why || '原因不明'}）——不是 0 次调用` };
  }

  const billable = billableRecords(records, now);
  // 「这次没扫到任何样本」和「扫完查出 0 条」必须分得开：
  // 有记录但全被滤掉 = 扫完了确实没有可对账的调用（ok）；一条记录都没有 = 没扫到（unknown）。
  if (records.length === 0) {
    return { state: 'unknown', detail: '用量账里一条记录都没有——没扫到样本，不是「查过没事」' };
  }
  if (billable.length === 0) {
    return { state: 'ok', count: 0, detail: `扫完 ${records.length} 条，没有 relay+200 的可对账调用` };
  }

  // 按腿聚合，报告才点得出「哪条腿、跑了多少次」
  const seen = new Map();
  for (const r of billable) {
    const l = usageToLeg(r);
    const k = legId(l);
    if (!seen.has(k)) seen.set(k, { ...l, id: k, n: 0, sessions: new Set() });
    const o = seen.get(k);
    o.n++;
    if (r.sessionId) o.sessions.add(r.sessionId);
  }

  const mismatches = [];
  for (const got of seen.values()) {
    const hit = legs.find(
      (l) => l && l.模型 === got.模型 && l.族 === got.族 && l.供应商 === got.供应商 && l.执行侧 === got.执行侧,
    );
    if (!hit) {
      mismatches.push({ id: got.id, n: got.n, sessions: got.sessions.size, reason: '未登记腿', 状态: null });
    } else if (hit.状态 !== '在役') {
      mismatches.push({ id: got.id, n: got.n, sessions: got.sessions.size, reason: `腿表标「${hit.状态}」却在跑`, 状态: hit.状态 });
    }
  }

  if (mismatches.length === 0) {
    return { state: 'ok', count: seen.size, detail: `${seen.size} 条实跑腿全部在腿表且在役（${billable.length} 次调用）` };
  }
  const lines = mismatches
    .sort((a, b) => b.n - a.n)
    .map((m) => `${m.id}：${m.reason}（${m.n} 次 / ${m.sessions} 个会话）`);
  return {
    state: 'red',
    count: seen.size,
    mismatches,
    detail: `${mismatches.length}/${seen.size} 条实跑腿与腿表对不上 —— ${lines.join('；')}`,
  };
}
