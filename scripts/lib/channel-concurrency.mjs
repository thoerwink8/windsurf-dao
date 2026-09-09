// scripts/lib/channel-concurrency.mjs —— 渠道并发三件套：上限 + 顺位分流 + 熔断退避（#1145）
//
// 起因（2026-09-08 用户拍板，issue #1145）：派工/审官起会话目前只受机器负载准入
// （lib/admission.mjs，0.85×核）约束，**渠道并发完全没建模**。某些上游渠道（Codex 实测
// 容量 3-4）一轮起 10 个审官全部 429 撞死，撞死后每轮无退避重投同一渠道（retry storm）。
//
// 三层，分开是行业共识（LiteLLM max_parallel_requests + 429 冷却 + order 顺位）：
//   1. 上限：按「渠道」计在途会话数，满员不起该渠道的会话。
//   2. 分流：某渠道满员/熔断 → 按角色「顺位」找下一条没满的腿；都满 → 票留队列等下轮，不硬挤。
//   3. 熔断退避：429/at-capacity 死 → 该渠道冷却，冷却中等同满员。复用 #843 breaker（provider-breaker.mjs）。
//
// 这是准入闸（admission.mjs）之上**叠加的第二道闸**，不替代它：admission 是总闸（机器余量），
// 本闸是渠道闸（上游合同容量）。两道都过才起会话。
//
// 本文件纯函数：不读盘、不 spawn、不碰 /proc、不出网。判据函数与取数分离（参考 admission.mjs）——
//   · 在途计数喂「树→渠道」的已解析映射（取数在 commander.mjs：树来自租约闸 /proc 扫描，
//     树→model/reviewer 来自派工账本，model→渠道来自路由表落地）。
//   · 熔断状态喂 breaker 快照（provider-breaker 的纯函数 inspectAvailability 判可用性）。
//
// 「渠道」的键取自既有 target 分类（provider-probe.probeTargetOf），取其**池级前缀**：
//   gw:grok/grok-4.6 → 渠道 gw:grok ； direct:codex@pqapi/responses → 渠道 direct:codex@pqapi 。
// 熔断表钉在**模型级 target**（gw:grok/grok-4.6），并发上限钉在**池级渠道**（gw:grok）——
// 粒度不同是对的：429 是池在限流，冷却却按模型 target 记（沿用 #843 的键）。两者都在 pickLeg 里查。

import { probeTargetOf } from './provider-probe.mjs';
import { inspectAvailability, resolveBreakerPolicy } from './provider-breaker.mjs';

/** 「不限」哨兵：渠道容量已验证工人无限做也没出问题（grokpool）。与「待填」区分——一个放开，一个待测。 */
export const CAP_UNLIMITED = '不限';

/**
 * 落地 { provider, cli_model } → 渠道（池级）键。认不出返回 null。
 *
 * 复用 probeTargetOf 的 target 分类，取 `/` 前的池级前缀（不含模型），保证与熔断/健康表同一套键空间。
 * claude 族（含 reclaude/mirasim 载体）没有网关 target → 归入 mirasim 中继渠道（编排服务器上
 * claude 族一律经 mirasim 中继腿起会话，429 也来自那条中继）。
 */
export function channelKeyOf(landing) {
  if (!landing || typeof landing !== 'object') return null;
  const provider = String(landing.provider || '');
  if (provider === 'mirasim') return 'mirasim';
  if (provider === 'claude' || provider === 'reclaude') return 'mirasim';
  const target = probeTargetOf(landing);
  if (!target) return null;
  const cut = target.indexOf('/');
  return cut < 0 ? target : target.slice(0, cut);
}

/** 腿节 → 渠道键。先认 mirasim 载体（供应商/执行侧），否则按落地算。 */
export function legChannelKey(leg) {
  if (!leg || typeof leg !== 'object') return null;
  const via = String(leg['供应商'] || '');
  const side = String(leg['执行侧'] || '');
  if (via === 'mirasim' || side === 'mirasim') return 'mirasim';
  return channelKeyOf(leg['落地']);
}

/**
 * 解析一条腿的 `并发上限` 字段值 → { cap, state }。
 *   正整数 N        → { cap:N,        state:'capped'   }   有限上限
 *   '不限' / Infinity → { cap:Infinity, state:'unlimited' }   已验证不限
 *   null / 缺字段     → { cap:Infinity, state:'pending'   }   待填（先不拦，但可见）
 *   其它（0/负/NaN/杂串）→ { cap:Infinity, state:'pending', bad:true }  当待填并标脏
 *
 * 为什么「待填」不 fail-close 收紧到 0：用户 2026-09-08 明确要 gptpool/dspool/cursor/opencode/
 * windsurf「先留字段可空、待帅位实测填」——这是**已知的、故意的**未配置态，不是「没查成」。
 * 若把它当 0 拦死，windsurf/gptpool 等在役渠道全停派，破坏生产。故待填 = 本渠道暂不设上限，
 * 但 buildChannelCaps 会把它列进 pending 让校验/盘点看得见（可空=待填，不是红）。
 */
export function resolveLegCap(raw) {
  if (raw === CAP_UNLIMITED || raw === Infinity || raw === 'inf' || raw === 'Infinity') {
    return { cap: Infinity, state: 'unlimited' };
  }
  if (raw === null || raw === undefined) return { cap: Infinity, state: 'pending' };
  const n = Number(raw);
  if (Number.isInteger(n) && n >= 1) return { cap: n, state: 'capped' };
  return { cap: Infinity, state: 'pending', bad: true };
}

/**
 * 从路由表「腿」数组建渠道容量表。多条腿映到同一渠道时取**最严**（min 有限上限；
 * 一条有限一条不限 → 有限胜），保守不放大。
 *
 * @returns {{ok:true, caps:{[ch]:number}, states:{[ch]:string}, pending:string[], legs:number}
 *          |{ok:false, unscanned:true, error:string, caps:{}, states:{}, pending:[]}}
 * 腿节不是数组 ⇒ ok:false（没查成，调用方按 fail-close 处理：本闸这一轮不据渠道上限放大准入）。
 */
export function buildChannelCaps(legs) {
  if (!Array.isArray(legs)) {
    return { ok: false, unscanned: true, error: '腿节不是数组——渠道上限没查成', caps: {}, states: {}, pending: [] };
  }
  const caps = {};
  const states = {};
  const pendingSet = new Set();
  for (const leg of legs) {
    if (!leg || typeof leg !== 'object') continue;
    if (String(leg['状态'] || '') !== '在役') continue; // 停用腿不占渠道，也不要求填字段
    const ch = legChannelKey(leg);
    if (!ch) continue;
    const { cap, state } = resolveLegCap(leg['并发上限']);
    if (state === 'pending') pendingSet.add(ch);
    // 取最严：已有有限上限时，新值只在更小时覆盖；无上限的不覆盖有限的。
    if (Number.isFinite(cap)) {
      caps[ch] = Number.isFinite(caps[ch]) ? Math.min(caps[ch], cap) : cap;
      states[ch] = 'capped';
    } else if (caps[ch] === undefined) {
      caps[ch] = Infinity;
      if (states[ch] !== 'capped') states[ch] = state;
    }
  }
  return {
    ok: true,
    caps,
    states,
    pending: [...pendingSet].filter((ch) => !Number.isFinite(caps[ch])).sort(),
    legs: legs.length,
  };
}

/**
 * 校验在役腿的 `并发上限` 字段（供 dao-check / 盘点用）。
 * 待填不算红（可空=待填）；只有「值明显是脏的（0/负/杂串）」才算问题。
 * @returns {{ok:true, pending:string[], bad:Array<{id,value}>}}
 */
export function validateLegCaps(legs) {
  const out = { ok: true, pending: [], bad: [] };
  if (!Array.isArray(legs)) return { ok: false, unscanned: true, error: '腿节不是数组' };
  const pending = new Set();
  for (const leg of legs) {
    if (!leg || typeof leg !== 'object') continue;
    if (String(leg['状态'] || '') !== '在役') continue;
    const r = resolveLegCap(leg['并发上限']);
    if (r.bad) out.bad.push({ id: leg.id || null, value: leg['并发上限'] });
    else if (r.state === 'pending') pending.add(String(leg.id || legChannelKey(leg) || '?'));
  }
  out.pending = [...pending].sort();
  return out;
}

/**
 * 在途会话按渠道计数。**在途来源必须与租约闸同源**（/proc 扫出的被占树），不复用 mirasim 记账。
 *
 * @param {string[]} busyTrees    被会话占着的树路径（lib/dispatch/lease.busyTrees 的产物）
 * @param {(tree:string)=>string|null} treeToChannel  树 → 渠道键的已解析映射（取数在调用方）
 * @returns {{ok:true, counts:{[ch]:number}, unattributed:string[]}
 *          |{ok:false, unscanned:true, error}}
 * 某树解不出渠道（账本查不到跑的什么模型）→ 计进 unattributed，不硬塞进某个渠道（塞错会误拦）。
 * unattributed 仍受机器总闸（admission）约束，只是这一层归不到具体渠道。
 */
export function countInFlightByChannel(busyTrees, treeToChannel) {
  if (!Array.isArray(busyTrees)) {
    return { ok: false, unscanned: true, error: '在途树不是数组——渠道在途数没查成' };
  }
  const fn = typeof treeToChannel === 'function' ? treeToChannel : () => null;
  const counts = {};
  const unattributed = [];
  for (const tree of busyTrees) {
    const t = String(tree || '').replace(/\/+$/, '');
    if (!t) continue;
    const ch = fn(t);
    if (!ch) { unattributed.push(t); continue; }
    counts[ch] = (counts[ch] || 0) + 1;
  }
  return { ok: true, counts, unattributed };
}

/** 一条腿在当前快照下能不能起会话（渠道未满 + 未熔断 + 未被本轮 429 排除）。纯判定。 */
export function legAvailability(landing, {
  caps = {}, states = {}, inFlight = {}, breaker = null, now, breakerPolicy, excluded,
} = {}) {
  const ch = channelKeyOf(landing);
  if (!ch) return { available: false, channel: null, reason: 'no-channel', why: '落地认不出渠道，不起（fail-close）' };
  const excl = excluded instanceof Set ? excluded : new Set(Array.isArray(excluded) ? excluded : []);
  if (excl.has(ch)) {
    return { available: false, channel: ch, reason: 'excluded-429', why: `渠道 ${ch} 本轮已 429，暂不再选` };
  }
  // 熔断：钉在模型级 target。open/half-open 一针已用 = 不可用（冷却中等同满员）。
  const target = probeTargetOf(landing);
  if (target && breaker && breaker.targets && breaker.targets[target] && now != null) {
    const pol = resolveBreakerPolicy(breakerPolicy, target);
    const av = inspectAvailability(breaker.targets[target], now, pol);
    if (!av.available) {
      return {
        available: false, channel: ch, target, reason: 'breaker-open',
        why: `渠道 ${ch}（target ${target}）熔断${av.until ? `，冷却至 ${av.until}` : ''}——冷却中等同满员`,
      };
    }
  }
  // 上限：池级渠道。
  const cap = Number.isFinite(caps[ch]) ? caps[ch] : Infinity;
  const n = Number(inFlight[ch]) || 0;
  if (Number.isFinite(cap) && n >= cap) {
    return { available: false, channel: ch, target, reason: 'at-cap', cap, inFlight: n, why: `渠道 ${ch} 已满员（在途 ${n} ≥ 上限 ${cap}）` };
  }
  return { available: true, channel: ch, target, cap, inFlight: n, pending: states[ch] === 'pending' };
}

/**
 * 顺位分流：按角色顺位走候选，返回第一条**渠道没满、没熔断、没被本轮排除**的腿。
 *
 * @param {object} args
 * @param {string[]} args.order          角色顺位（模型 id 数组，顺位小的在前）
 * @param {(id:string)=>object|null} args.landingOf  模型 id → 落地（取自路由表职责树/腿表）
 * @param {object} args.caps/states/inFlight/breaker/now/breakerPolicy/excluded  同 legAvailability
 * @returns {{ok:true, picked:{model,channel,target,cap,inFlight}, spilledFrom:Array}
 *          |{ok:false, queued:true, tried:Array, why:string}}
 * 都满 → ok:false, queued:true（票留队列等下轮，不硬挤——沿用租约闸「背压不是失败」的处置）。
 */
export function pickLeg({
  order, landingOf, caps = {}, states = {}, inFlight = {}, breaker = null, now, breakerPolicy, excluded,
} = {}) {
  const ids = Array.isArray(order) ? order : [];
  const getLanding = typeof landingOf === 'function' ? landingOf : () => null;
  const spilledFrom = [];
  for (const id of ids) {
    const landing = getLanding(id);
    if (!landing) { spilledFrom.push({ model: id, reason: 'no-landing' }); continue; }
    const av = legAvailability(landing, { caps, states, inFlight, breaker, now, breakerPolicy, excluded });
    if (av.available) {
      return {
        ok: true,
        picked: { model: id, channel: av.channel, target: av.target, cap: av.cap, inFlight: av.inFlight, pending: !!av.pending },
        spilledFrom,
      };
    }
    spilledFrom.push({ model: id, channel: av.channel, reason: av.reason, why: av.why });
  }
  return {
    ok: false,
    queued: true,
    tried: spilledFrom,
    why: ids.length
      ? `顺位内 ${ids.length} 条腿全满员/熔断/已排除，票留队列等下轮`
      : '顺位为空，无腿可选',
  };
}

/** 领一个渠道名额：把某渠道在途数 +1（decide 派完一个后调，供后续同轮判满）。返回新映射，不改原对象。 */
export function takeChannelSlot(inFlight, channel) {
  const next = { ...(inFlight && typeof inFlight === 'object' ? inFlight : {}) };
  if (channel) next[channel] = (Number(next[channel]) || 0) + 1;
  return next;
}

/**
 * 熔断退避的轮次→小时换算：2→4→8 轮封顶（issue #1145）。复用 #843 breaker 的 trip 事件承载。
 * 不新造状态机：只算「这次 429 该冷却几轮」，实际状态转移仍走 provider-breaker.applyEvent(trip, hours)。
 *
 * @param {object|null} breakerTarget  该 target 当前熔断态（provider-breaker 表里的一条）
 * @param {object} opts  { roundMs, maxRounds=8, startRounds=2 }
 * @returns {{rounds:number, hours:number}}
 * 首次 429 → 2 轮；已在冷却/刚冷却过 → 上次轮数 ×2，封顶 maxRounds。
 */
export function planBackoff(breakerTarget, { roundMs = 20 * 60 * 1000, maxRounds = 8, startRounds = 2 } = {}) {
  const t = breakerTarget && typeof breakerTarget === 'object' ? breakerTarget : null;
  let prevRounds = 0;
  if (t) {
    const trippedAt = Date.parse(t.trippedAt || '');
    const cooldownUntil = Date.parse(t.cooldownUntil || '');
    if (Number.isFinite(trippedAt) && Number.isFinite(cooldownUntil) && cooldownUntil > trippedAt) {
      prevRounds = Math.round((cooldownUntil - trippedAt) / roundMs);
    }
  }
  const rounds = prevRounds > 0 ? Math.min(prevRounds * 2, maxRounds) : startRounds;
  return { rounds, hours: (rounds * roundMs) / 3600000 };
}
