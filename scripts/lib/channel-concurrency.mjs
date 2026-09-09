// scripts/lib/channel-concurrency.mjs —— 渠道并发三件套：上限 + 顺位分流 + 熔断退避（#1145）
//
// 起因（2026-09-08 用户拍板，issue #1145）：派工/审官起会话原先只受机器负载准入
// （lib/admission.mjs，0.85×核）约束，**渠道并发完全没建模**。某些上游渠道（Codex 实测
// 容量 3-4）一轮起 10 个审官全部 429 撞死，撞死后每轮无退避重投同一渠道（retry storm）。
//
// 三层，分开是行业共识（LiteLLM max_parallel_requests + order 顺位 + 429 冷却）：
//   1. 上限：按「渠道」计在途会话数，满员不起该渠道的会话。
//   2. 分流：某渠道满员/熔断 → 按角色「顺位」找下一条没满的腿；都满 → 票留队列等下轮，不硬挤。
//   3. 熔断退避：429/at-capacity 死 → 该渠道冷却 2→4→8 轮封顶，冷却中等同满员。
//      复用 #843 breaker（provider-breaker.mjs 的 applyEvent），**不新造状态机**。
//
// 这是准入闸（admission.mjs）之上**叠加的第二道闸**，不替代它：admission 是总闸（机器余量），
// 本闸是渠道闸（上游合同容量）。两道都过才起会话。
//
// ── 闸装在哪：一道门，不是三处调用点 ────────────────────────────────────────
// **上限闸装在 mirasim-runtime.startSession 那道门里**（挨着租约闸），不装在各调用点。
// 仓内先例就是租约闸自己（lib/dispatch/lease.mjs 头部）：四个调用点（dao dispatch /
// dao start / 审官 create / 推一把）全从那道门过，装在门里绕不开。审官起会话因此**自动**
// 受闸，不用动审官选型核心代码。
// **分流（spill）留在决策层**（commander-core / preflightReviewer）——选哪个模型是决策，
// 不是门的职责；门只回答「这一个能不能起」。
//
// 本文件的结构照 lease.mjs：**判据是纯函数**（喂快照，不读盘、不 spawn、不出网），
// 底部两个薄壳（checkChannelCapacity / recordChannelFailure）才碰盘，供门调用。
//
// 「渠道」的键取自既有 target 分类（provider-probe.probeTargetOf）的**池级前缀**：
//   gw:grok/grok-4.6 → 渠道 gw:grok ； direct:codex@pqapi/responses → 渠道 direct:codex@pqapi 。
// 熔断表钉在**模型级 target**（沿用 #843 的键），并发上限钉在**池级渠道**——粒度不同是对的：
// 429 是池在限流，冷却却按模型 target 记。两者都在同一个判据里查。

import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { probeTargetOf } from './provider-probe.mjs';
import {
  inspectAvailability, resolveBreakerPolicy, applyEvent, loadBreakerDoc, saveBreakerDoc,
} from './provider-breaker.mjs';
import { acquireWorktreeLock } from './dispatch-lock.mjs';

/** 「不限」哨兵：渠道容量已验证工人无限做也没出问题（grokpool）。与「待填」区分——一个放开，一个没人填过。 */
export const CAP_UNLIMITED = '不限';

/**
 * 待填腿的**保守上限**。不是 Infinity（放开），也不是 0（拦死）——第三个答案，
 * 仓内先例是 admission.mjs 的 conservativeWorkerMb：「取偏大值收紧，不是放开」。
 *
 * 为什么必须收紧而不能放行：**429 风暴恰恰发生在待填的那几条渠道上**
 * （gptpool / pqapi / windsurf 正是 issue #1145 里撞死的那些）。按 Infinity 放行，
 * 等于这道闸对真正出事的渠道不设防，验收标准「缺字段不能放过去」直接落空。
 * 为什么不能按 0 拦死：用户 2026-09-08 明说 windsurf/gptpool/dspool/cursor/opencode
 * 「先留字段可空、待帅位实测填」——拦死会把在役生产渠道全停派。
 *
 * 取 3 的依据：issue 正文「某些上游渠道（如 Codex）实测容量只有 3-4」，取实测区间下界。
 * 状态仍标 pending，由 dao-check 显式列出来催填真数（validateLegCaps）。
 */
export const CONSERVATIVE_CAP = 3;

/** 渠道满员的原因名。**它是背压，不是失败**——仿 lease.mjs 的 LEASE_BUSY_REASON，
 *  调用方据此排队下一轮，不报帅、不开待拍板单。 */
export const CHANNEL_FULL_REASON = 'channel-full';

/** 熔断退避的一轮 = 指挥官节拍 20 分钟（commander-act 的实际周期）。 */
export const ROUND_MS = 20 * 60 * 1000;

/**
 * 落地 { provider, cli_model } → 渠道（池级）键。认不出返回 null。
 *
 * 复用 probeTargetOf 的 target 分类，取 `/` 前的池级前缀（不含模型），保证与熔断/健康表同一套键空间。
 * claude 族（含 reclaude/mirasim 载体）没有网关 target → 归 mirasim 中继渠道（编排服务器上
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
 *   正整数 N          → { cap:N,               state:'capped'    }  显式有限上限
 *   '不限' / Infinity → { cap:Infinity,        state:'unlimited' }  已验证不限
 *   null / 缺字段     → { cap:CONSERVATIVE_CAP, state:'pending'  }  待填 ⇒ 保守收紧（见常量注释）
 *   其它（0/负/杂串） → 同待填，另标 bad:true（形状脏，dao-check 会点名）
 */
export function resolveLegCap(raw) {
  if (raw === CAP_UNLIMITED || raw === Infinity || raw === 'inf' || raw === 'Infinity') {
    return { cap: Infinity, state: 'unlimited' };
  }
  if (raw === null || raw === undefined) return { cap: CONSERVATIVE_CAP, state: 'pending' };
  const n = Number(raw);
  if (Number.isInteger(n) && n >= 1) return { cap: n, state: 'capped' };
  return { cap: CONSERVATIVE_CAP, state: 'pending', bad: true };
}

/**
 * 从路由表「腿」数组建渠道容量表。
 *
 * 同一渠道多条腿时的优先级（**显式决定压过没人填过**）：
 *   ① 有显式有限值 → 取最严（min），state 'capped'
 *   ② 否则有「不限」 → Infinity，state 'unlimited'
 *   ③ 全是待填 → CONSERVATIVE_CAP，state 'pending'
 * ②压过③的理由：「不限」是用户对这条渠道的**已验证结论**，待填是这条腿没人填过；
 * 拿「没人填过」去收紧一个已经验证过的渠道，是用缺失覆盖结论。
 *
 * @returns {{ok:true, caps, states, pending:string[], legs:number}
 *          |{ok:false, unscanned:true, error, caps:{}, states:{}, pending:[]}}
 * 腿节不是数组 ⇒ ok:false（**没查成**，与「扫完是 0」分得开；调用方 fail-close）。
 */
export function buildChannelCaps(legs) {
  if (!Array.isArray(legs)) {
    return { ok: false, unscanned: true, error: '腿节不是数组——渠道上限没查成', caps: {}, states: {}, pending: [] };
  }
  const acc = new Map(); // ch -> { explicit:number[], unlimited:bool, pending:bool }
  for (const leg of legs) {
    if (!leg || typeof leg !== 'object') continue;
    if (String(leg['状态'] || '') !== '在役') continue; // 停用腿不占渠道，也不要求填字段
    const ch = legChannelKey(leg);
    if (!ch) continue;
    if (!acc.has(ch)) acc.set(ch, { explicit: [], unlimited: false, pending: false });
    const slot = acc.get(ch);
    const { cap, state } = resolveLegCap(leg['并发上限']);
    if (state === 'capped') slot.explicit.push(cap);
    else if (state === 'unlimited') slot.unlimited = true;
    else slot.pending = true;
  }
  const caps = {};
  const states = {};
  const pending = [];
  for (const [ch, slot] of acc) {
    if (slot.explicit.length) { caps[ch] = Math.min(...slot.explicit); states[ch] = 'capped'; }
    else if (slot.unlimited) { caps[ch] = Infinity; states[ch] = 'unlimited'; }
    else { caps[ch] = CONSERVATIVE_CAP; states[ch] = 'pending'; pending.push(ch); }
  }
  return { ok: true, caps, states, pending: pending.sort(), legs: legs.length };
}

/**
 * 校验在役腿的 `并发上限` 字段（供 dao-check 用）。
 * **待填不算红**（它是故意未配置，且已按保守值收紧）；**腿节形状坏了才算红**（那是没查成）。
 * @returns {{ok:true, pending:Array<{id,channel}>, bad:Array<{id,value}>, conservativeCap:number, inService:number}
 *          |{ok:false, unscanned:true, error:string}}
 */
export function validateLegCaps(legs) {
  if (!Array.isArray(legs)) {
    return { ok: false, unscanned: true, error: '腿节不是数组——并发上限字段没查成（不是「扫完是 0」）' };
  }
  const pending = [];
  const bad = [];
  let inService = 0;
  for (const leg of legs) {
    if (!leg || typeof leg !== 'object') continue;
    if (String(leg['状态'] || '') !== '在役') continue;
    inService += 1;
    const r = resolveLegCap(leg['并发上限']);
    const id = String(leg.id || leg['模型'] || '?');
    if (r.bad) bad.push({ id, value: leg['并发上限'] });
    else if (r.state === 'pending') pending.push({ id, channel: legChannelKey(leg) });
  }
  return { ok: true, pending, bad, conservativeCap: CONSERVATIVE_CAP, inService };
}

/**
 * 在途会话按渠道计数。**在途来源必须与租约闸同源**（/proc 扫出的被占树），不复用 mirasim 记账
 * （理由见 lease.mjs 头部：record.json 的 runPid 是 server pid，不刷新）。
 *
 * @param {string[]} busyTrees  被会话占着的树路径（lease.busyTrees 的产物）
 * @param {(tree:string)=>string|null} treeToChannel  树 → 渠道键（取数在调用方，见 treeChannelResolver）
 * @returns {{ok:true, counts, unattributed:string[]}|{ok:false, unscanned:true, error}}
 * 某树解不出渠道（账本查不到跑的什么模型）→ 计进 unattributed，**不硬塞进某个渠道**（塞错会误拦）。
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

/**
 * 一个模型该记在哪条渠道上。**腿表优先**——duty 树只登记了一部分模型
 * （实测 claude-opus-5 / claude-fable-5 / gpt-6-astra 只在腿表里，duty 树查不到），
 * 只按 duty 树落地算会把这些模型判成「认不出渠道」，闸对它们等于不存在。
 *
 * 同一模型有多条在役腿（如 gpt-5.6-sol 既有 pqapi 直连也有 mirasim 中继）时**取最严**：
 * 上限最小的那条渠道。理由：起会话时落哪条腿由运行时配置决定（codex 走 ~/.codex 直连、
 * mirasim relay 只做 failover），门里判不出来；按最严判，宁可这轮少起一个，不许把
 * pqapi(2) 的单当成 mirasim(5) 放过去——那正是 #1145 撞死的那一格。
 * 打平按渠道键排序取第一个（判据要确定，不许随 Object 顺序飘）。
 *
 * @returns {{channel, cap, candidates:string[], source:'legs'|'models'}|null}
 */
export function resolveModelChannel({ model, legs, models, caps } = {}) {
  const id = model == null ? '' : String(model);
  if (!id) return null;
  const capTable = caps && typeof caps === 'object' ? caps : (buildChannelCaps(legs).caps || {});
  const candidates = new Set();
  let source = null;
  for (const leg of Array.isArray(legs) ? legs : []) {
    if (!leg || typeof leg !== 'object') continue;
    if (String(leg['状态'] || '') !== '在役') continue;
    if (String(leg['模型'] || '') !== id) continue;
    const ch = legChannelKey(leg);
    if (ch) { candidates.add(ch); source = 'legs'; }
  }
  if (!candidates.size) {
    const rec = (Array.isArray(models) ? models : []).find((m) => m && String(m.id) === id);
    const ch = rec && rec.provider ? channelKeyOf({ provider: rec.provider, cli_model: rec.cli_model }) : null;
    if (ch) { candidates.add(ch); source = 'models'; }
  }
  if (!candidates.size) return null;
  const list = [...candidates].sort();
  let pick = list[0];
  for (const ch of list) {
    const a = Number.isFinite(capTable[ch]) ? capTable[ch] : Infinity;
    const b = Number.isFinite(capTable[pick]) ? capTable[pick] : Infinity;
    if (a < b) pick = ch;
  }
  return {
    channel: pick,
    cap: Number.isFinite(capTable[pick]) ? capTable[pick] : Infinity,
    candidates: list,
    source,
  };
}

/**
 * 一条渠道当下的三道检查——**唯一判据**，两个适配器（按落地 / 按模型）都走它，
 * 不许各写一套（否则决策层和门里会对同一个渠道给出不同结论）。
 * 顺序：本轮 429 排除 → 熔断（冷却中等同满员）→ 在途上限。
 */
function judgeChannelState({ channel, target, caps = {}, states = {}, inFlight = {}, breaker, now, breakerPolicy, excluded, }) {
  if (!channel) return { available: false, channel: null, reason: 'no-channel', why: '认不出渠道' };
  const excl = excluded instanceof Set ? excluded : new Set(Array.isArray(excluded) ? excluded : []);
  if (excl.has(channel)) {
    return { available: false, channel, target, reason: 'excluded-429', why: `渠道 ${channel} 本轮已 429，暂不再选` };
  }
  if (target && breaker && breaker.targets && breaker.targets[target] && now != null) {
    const pol = resolveBreakerPolicy(breakerPolicy, target);
    const av = inspectAvailability(breaker.targets[target], now, pol);
    if (!av.available) {
      return {
        available: false, channel, target, reason: 'breaker-open',
        why: `渠道 ${channel}（target ${target}）熔断${av.until ? `，冷却至 ${av.until}` : ''}——冷却中等同满员`,
      };
    }
  }
  const cap = Number.isFinite(caps[channel]) ? caps[channel] : Infinity;
  const n = Number(inFlight[channel]) || 0;
  if (Number.isFinite(cap) && n >= cap) {
    return {
      available: false, channel, target, reason: 'at-cap', cap, inFlight: n,
      why: `渠道 ${channel} 已满员（在途 ${n} ≥ 上限 ${cap}${states[channel] === 'pending' ? '，该渠道上限待填、按保守值收紧' : ''}）`,
    };
  }
  return { available: true, channel, target, cap, inFlight: n, pending: states[channel] === 'pending' };
}

/** 适配器①：按**落地**判（决策层用——commander 的工人闸、preflightReviewer 的顺位分流）。 */
export function legAvailability(landing, opts = {}) {
  const channel = channelKeyOf(landing);
  if (!channel) return { available: false, channel: null, reason: 'no-channel', why: '落地认不出渠道，不起（fail-close）' };
  return judgeChannelState({ ...opts, channel, target: probeTargetOf(landing) });
}

/**
 * 适配器②：按**模型 id** 判（门里用——startSession 只拿到 model，拿不到落地）。
 * 熔断 target 仍按 duty 树落地算（沿用 #843 的键）；渠道按 resolveModelChannel（腿表优先、取最严）。
 * 认不出渠道 → { available:true, attributed:false }：**这一支故意不 fail-close**，理由见
 * checkChannelCapacity 的注释（全盘阻塞的代价远大于漏拦一个未登记模型，且机器总闸仍在）。
 */
export function judgeChannelForModel({ model, legs, models, caps, states, inFlight = {}, breaker, now, breakerPolicy, excluded } = {}) {
  const capTable = caps && typeof caps === 'object' ? caps : {};
  const resolved = resolveModelChannel({ model, legs, models, caps: capTable });
  if (!resolved) {
    return { available: true, attributed: false, channel: null, why: `模型 ${model == null ? '(空)' : model} 在腿表/选型里都认不出渠道——本闸不拦（机器总闸仍在）` };
  }
  const rec = (Array.isArray(models) ? models : []).find((m) => m && String(m.id) === String(model));
  const target = rec && rec.provider ? probeTargetOf({ provider: rec.provider, cli_model: rec.cli_model }) : null;
  const verdict = judgeChannelState({
    channel: resolved.channel, target, caps: capTable, states: states || {},
    inFlight, breaker, now, breakerPolicy, excluded,
  });
  return { ...verdict, attributed: true, candidates: resolved.candidates };
}

/**
 * 顺位分流：按角色顺位走候选，返回第一条**渠道没满、没熔断、没被本轮排除**的腿。
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

// ── 树 → 渠道的归属（在途计数的分子必须与上限的分母同一把尺）────────────────────

/** 树路径 → 分支名 → 派工账本里的 model。审官树 `dao-review-pr-<n>` 按 PR 找，工人树按 issue 找。 */
export function modelOfTree(tree, jobs) {
  const branch = String(tree || '').replace(/\/+$/, '').split('/').pop() || '';
  if (!branch) return null;
  const byIssue = new Map();
  const byPr = new Map();
  for (const j of Array.isArray(jobs) ? jobs : []) {
    if (!j || !j.model) continue;
    if (j.issue != null) byIssue.set(String(j.issue), String(j.model));
    if (j.pr != null) byPr.set(String(j.pr), String(j.model));
  }
  const rev = branch.match(/review-pr-(\d+)/);
  if (rev) return byPr.get(rev[1]) || null;
  const m = branch.match(/(\d+)/);
  if (!m) return null;
  return byIssue.get(m[1]) || byPr.get(m[1]) || null;
}

/**
 * 造「树 → 渠道」解析器。**门里和决策层共用这一个**，不许各造一份：
 * 分子（在途数怎么归渠道）与分母（上限挂在哪个渠道）用同一把尺，否则闸会对着错的格子判满。
 */
export function treeChannelResolver({ jobs, legs, models, caps } = {}) {
  const capTable = caps && typeof caps === 'object' ? caps : (buildChannelCaps(legs).caps || {});
  return (tree) => {
    const model = modelOfTree(tree, jobs);
    if (!model) return null;
    const r = resolveModelChannel({ model, legs, models, caps: capTable });
    return r ? r.channel : null;
  };
}

// ── 熔断退避（第三层）────────────────────────────────────────────────────────

/** 上游「撞容量」的指纹。只认确定性字样，认不出返回 hit:false（不猜——猜错会把普通失败熔成冷却）。 */
export function isCapacityError(text) {
  const s = String(text == null ? '' : text);
  if (!s) return { hit: false, kind: null };
  if (/\b429\b|too many requests|rate[ _-]?limit/i.test(s)) return { hit: true, kind: '429' };
  if (/at[ _-]?capacity|over[ _-]?capacity|capacity[ _-]?exceeded|overloaded|server is busy/i.test(s)) {
    return { hit: true, kind: 'at-capacity' };
  }
  return { hit: false, kind: null };
}

/**
 * 熔断退避的轮次→小时换算：2→4→8 轮封顶（issue #1145）。
 * 只算「这次该冷却几轮」，状态转移仍走 provider-breaker.applyEvent(trip, hours)——不新造状态机。
 * 首次 → startRounds；上次冷过 → 上次轮数 ×2，封顶 maxRounds。
 */
export function planBackoff(breakerTarget, { roundMs = ROUND_MS, maxRounds = 8, startRounds = 2 } = {}) {
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

/**
 * 把一次「撞容量」记进熔断表：planBackoff 算退避轮数 → applyEvent 的 trip 事件落状态。
 * 纯函数（吃整份 doc、吐整份 doc），时钟必须由调用方传（沿用 #843 禁 Date.now 的规矩）。
 * @returns {{doc, rounds, hours, target}}
 */
export function applyChannelFailure(doc, { target, now, roundMs = ROUND_MS, why, policy } = {}) {
  const key = target == null ? '' : String(target);
  if (!key) return { doc, rounds: 0, hours: 0, target: null };
  const prev = doc && doc.targets ? doc.targets[key] : null;
  const plan = planBackoff(prev, { roundMs });
  const next = applyEvent(doc, {
    type: 'trip', target: key, hours: plan.hours,
    why: why || `渠道撞容量（429/at-capacity），退避 ${plan.rounds} 轮（#1145）`,
  }, policy, now);
  return { doc: next, rounds: plan.rounds, hours: plan.hours, target: key };
}

// ── 薄壳：门里用的生产入口（这两个碰盘，上面全是纯函数）──────────────────────

/**
 * 门里的渠道上限判据（生产入口）。**取数与判据分离**：本函数只取数，判定全在
 * judgeChannelForModel。三态出口，与租约闸一一对应：
 *   { ok:true, verdict:'free' }              → 放行
 *   { ok:true, verdict:'full', reason, why } → 满员/熔断，调用方按**背压**排队下轮
 *   { ok:false, unscanned:true, error }      → 没查成，调用方 fail-close 拒起
 *
 * 哪些算「没查成」（收紧）：路由表读不出来、/proc 在途数读不出来。
 * 哪些**故意不收紧**：`model` 没给、或这个模型在腿表/选型里都认不出渠道。
 *   理由：那不是「读失败」，是**结构性缺席**（调用方没钉模型 / 模型没登记）。
 *   收紧的代价是**所有不带 model 的会话全起不来**（dao start、临时会话），
 *   那是全盘阻塞；而漏拦的代价有兜底——未登记模型在 commander 侧被
 *   assessDispatchModel 的 model-not-in-routing 拦着，机器总闸 admission 也仍在。
 */
/**
 * 取数：把判渠道要的四份快照读出来。**故意放在锁外**——它是读，且是本段里最慢的一步
 * （/proc 扫几百个 pid）。放锁里会把临界区从毫秒级拉长，而 #849 那把锁的等待是**忙自旋**
 * （dispatch-lock.mjs 的 sleep 是 `while (Date.now() < t) {}`），临界区一长，等待者就烧 CPU，
 * 在这台常年负载 19-20 的机器上比原问题更糟。
 *
 * 锁外读为什么不破坏原子性：竞态窗口里的并发起会话**一定各写了一条预占**，而预占是在
 * 锁内数的。也就是说「锁外的 /proc 数」只负责已经落地的会话，「锁内的预占数」负责正在起的，
 * 两段相加才是分母 —— 需要互斥的只有「数预占 + 写预占」这一小段。
 *
 * @returns {{ok:true, raw, models, caps, states, procCounts, unattributed, breaker}
 *          |{ok:false, unscanned:true, error}}
 */
export function readChannelFacts({ model, io = {} } = {}) {
  let raw;
  try {
    raw = io.loadRouting ? io.loadRouting() : null;
    if (!raw) {
      const m = io.routingModule || null;
      if (!m) throw new Error('没注入 loadRouting');
      raw = m.loadRoutingJsonRaw();
    }
  } catch (e) {
    return { ok: false, unscanned: true, error: `渠道上限没查成（路由表读不出来：${String(e && e.message || e)}）` };
  }
  const capsDoc = buildChannelCaps(raw && raw['腿']);
  if (!capsDoc.ok) return { ok: false, unscanned: true, error: `渠道上限没查成（${capsDoc.error}）` };
  const models = typeof io.loadModels === 'function' ? io.loadModels(raw) : [];
  const flight = typeof io.checkInFlight === 'function' ? io.checkInFlight() : { ok: false, error: '没注入在途判据' };
  if (!flight.ok) {
    return { ok: false, unscanned: true, error: `渠道在途数没查成（${flight.error || '在途判据没给'}）` };
  }
  const jobs = typeof io.loadJobs === 'function' ? io.loadJobs() : [];
  const counted = countInFlightByChannel(flight.trees || [], treeChannelResolver({
    jobs, legs: raw['腿'], models, caps: capsDoc.caps,
  }));
  if (!counted.ok) return { ok: false, unscanned: true, error: `渠道在途数没查成（${counted.error}）` };
  const breaker = typeof io.loadBreaker === 'function' ? io.loadBreaker() : null;
  return {
    ok: true, raw, models, caps: capsDoc.caps, states: capsDoc.states,
    procCounts: counted.counts, unattributed: counted.unattributed, breaker,
  };
}

/** 把 judgeChannelForModel 的结果收成门认的三态形状（free / full）。 */
function shapeVerdict(verdict, { unattributedTrees = 0, reservations = 0 } = {}) {
  if (verdict.available) {
    return {
      ok: true, verdict: 'free', attributed: verdict.attributed !== false,
      channel: verdict.channel || null, target: verdict.target || null,
      cap: verdict.cap, inFlight: verdict.inFlight, reservations,
      unattributedTrees,
      why: verdict.why || null,
    };
  }
  return {
    ok: true, verdict: 'full', attributed: true,
    channel: verdict.channel || null, target: verdict.target || null,
    reason: verdict.reason, cap: verdict.cap,
    inFlight: verdict.inFlight, reservations, why: verdict.why,
  };
}

export function checkChannelCapacity({
  model, now = Date.now(), io = {}, breakerPolicy,
} = {}) {
  if (model == null || String(model).trim() === '') {
    return { ok: true, verdict: 'free', attributed: false, why: '起会话没钉 model，渠道无从归属——本闸不拦（机器总闸仍在）' };
  }
  const facts = readChannelFacts({ model, io });
  if (!facts.ok) return facts;
  const verdict = judgeChannelForModel({
    model, legs: facts.raw['腿'], models: facts.models, caps: facts.caps, states: facts.states,
    inFlight: facts.procCounts, breaker: facts.breaker, now, breakerPolicy,
  });
  return shapeVerdict(verdict, { unattributedTrees: facts.unattributed.length });
}

/**
 * 把门里收到的「撞容量」落进熔断表（生产入口：读-改-写 ~/.dao/provider-breaker.json）。
 * 不许在这里发通知/开单——那是 #843 recordEvent 那条路的事，本函数只落状态。
 */
export function recordChannelFailure({ target, now = Date.now(), roundMs = ROUND_MS, why, policy, home, io = {} } = {}) {
  if (!target) return { ok: false, skipped: true, why: '没有 target，不猜（认不出就不记）' };
  const load = io.loadBreakerDoc || loadBreakerDoc;
  const save = io.saveBreakerDoc || saveBreakerDoc;
  const loaded = load(home ? { home } : {});
  const applied = applyChannelFailure(loaded.doc, { target, now, roundMs, why, policy });
  save(applied.doc, home ? { home } : {});
  return { ok: true, target: applied.target, rounds: applied.rounds, hours: applied.hours };
}

// ── 原子占槽：检查+预占分离，锁只护极短临界区 ────────────────────────────────
//
// 为什么必须原子（审官第二轮红项，实测属实）：原来的门是「读快照再放行」。两个并发
// startSession() 可以同时看到 inFlight < cap 都判 free，随后都 open() 发 prompt，
// 于是真实并发超过渠道上限。cap=2 的 pqapi 被两个并发顶到 3-4，正好落回 429 区——
// 闸等于白设。commander 内部是 await 串行，但「帅位手动起 + timer 那轮」「drain 与派工」
// 跨进程会叠上。takeChannelSlot() 只在 commander 的纯决策快照里返回新对象，护不到真实起会话。
//
// 为什么复用 #849 的 dispatch-lock 而不新造锁：它已经把这类锁最难的两件事解决了——
// O_EXCL 跨进程互斥（本仓零依赖，node:fs 没有 flockSync），以及**持锁进程死掉自动拆锁**
// （pid 判死 + mtime staleMs 兜底）。自己造一把必然要把这两件事再写一遍，而写漏第二件
// 的后果是预占泄漏 ⇒ 永久假满员 ⇒ 全盘起不了会话。
//
// **锁绝不持过网络 I/O**：dispatch-lock 的等待是忙自旋（sleep 里 `while (Date.now() < t) {}`），
// 锁一持住数秒，等待者就在这台常年负载 19-20 的机器上烧 CPU，比原问题更糟。所以临界区里
// 只有「数预占 + 写预占」这一小段纯本地代码，一个 await 都没有；连 /proc 都在锁外读
// （理由见 readChannelFacts）。
//
// 注：租约闸（lease.mjs）同属性——也是读快照、零锁，同样有 TOCTOU。那是另一个起因
// （租约原子性），不在本单，帅位另开单处理；别顺手在这儿一起改。

/** 渠道键 → 文件名安全的 slug（`direct:codex@pqapi` → `direct-codex-pqapi`）。 */
export function channelSlug(channel) {
  return String(channel == null ? '' : channel).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown';
}

/**
 * 预占的存活时限。必须**大于**一次正常 startSession 的耗时（门里 accept 超时默认 30s），
 * 否则慢而合法的起会话会中途丢掉自己的预占；又要足够短，让漏删的预占自己退场。
 * 60s 兼顾两头；真正的即时回收靠 pid 判死（持有者崩了当场不算），TTL 只是兜底。
 */
export const RESERVE_TTL_MS = 60 * 1000;

/** 临界区只有毫秒级本地操作，2s 足够；等不到说明有人在临界区里，按没查成处理（见 admitAndReserveChannel）。 */
export const RESERVE_LOCK_TIMEOUT_MS = 2000;
/** 锁正常持有只有毫秒级；30s 远超任何合法持有，超过一律当死锁拆掉。 */
export const RESERVE_LOCK_STALE_MS = 30 * 1000;

export function reserveDir({ home = os.homedir(), channel } = {}) {
  return join(home, '.dao', 'locks', `channel-${channelSlug(channel)}`);
}

export function reserveLockPath({ home = os.homedir(), channel } = {}) {
  return join(home, '.dao', 'locks', `channel-${channelSlug(channel)}.lock`);
}

/**
 * 数这个渠道当下的**活预占**，顺手把死的清掉（自愈，防目录长胖）。
 * 活的判据两条都要满足，与 #849 拆锁判据同源：**持有者 pid 还活着** 且 **年龄 < TTL**。
 * 目录不在 = 没有预占（这是「查成了，结论是 0」，不是没查成）。
 *
 * @returns {{ok:true, live:number, reaped:string[]}|{ok:false, unscanned:true, error}}
 * 目录读不动（权限等）⇒ ok:false，调用方 fail-close——读不到预占数不许当成 0。
 */
export function countLiveReservations({
  dir, now = Date.now(), ttlMs = RESERVE_TTL_MS,
  readdir = readdirSync, read = readFileSync, unlink = unlinkSync, exists = existsSync,
  pidAlive = defaultReservePidAlive,
} = {}) {
  if (!dir) return { ok: false, unscanned: true, error: '没给预占目录' };
  if (!exists(dir)) return { ok: true, live: 0, reaped: [] };
  let names;
  try { names = readdir(dir); }
  catch (e) { return { ok: false, unscanned: true, error: `预占目录读不动：${String(e && e.message || e)}` }; }
  let live = 0;
  const reaped = [];
  for (const name of Array.isArray(names) ? names : []) {
    if (!String(name).endsWith('.res')) continue;
    const p = join(dir, String(name));
    let doc = null;
    try { doc = JSON.parse(String(read(p, 'utf8'))); } catch { doc = null; }
    const pid = doc && Number(doc.pid);
    const at = doc && Number(doc.at);
    // 形状坏了（写一半 / 手改坏）：当死的清掉。它既证明不了有人在起会话，
    // 留着又会永久占位——而永久占位就是「假满员 ⇒ 全盘阻塞」那条最坏路径。
    const badShape = !Number.isInteger(pid) || pid <= 0 || !Number.isFinite(at);
    const expired = !badShape && (now - at) >= ttlMs;
    const dead = !badShape && !pidAlive(pid);
    if (badShape || expired || dead) {
      try { unlink(p); reaped.push(String(name)); } catch { /* 别人抢先清了 */ }
      continue;
    }
    live += 1;
  }
  return { ok: true, live, reaped };
}

function defaultReservePidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try { process.kill(n, 0); return true; }
  catch (e) { return e && e.code === 'EPERM'; } // 存在但没权限 = 还活着
}

/**
 * 原子占槽（门里用的生产入口）。三态与 checkChannelCapacity 一致，多一个 `release`。
 *
 *   { ok:true, verdict:'free', release, ... }   → 放行；调用方**必须**在 finally 调 release
 *   { ok:true, verdict:'full', reason, why }    → 满员/熔断，调用方按背压排队（busy）
 *   { ok:false, unscanned:true, error }         → 没查成，调用方 fail-close 拒起
 *
 * 临界区（持锁，纯本地无 await）：数预占 → 判满 → 未满则写一条预占 → 放锁。
 * 分母 = 锁外读到的 /proc 在途 + 锁内数到的活预占。
 *
 * 拿不到锁（超时）**按没查成处理**：拿不到说明有人正在临界区，此刻我们既数不准也占不上槽；
 * 宁可这轮不起（下轮再来，且报得出来），也不许在没数准的情况下放行——那正是本红项的成因。
 */
export function admitAndReserveChannel({
  model, now = Date.now(), io = {}, breakerPolicy, home = os.homedir(),
  ttlMs = RESERVE_TTL_MS, lockTimeoutMs = RESERVE_LOCK_TIMEOUT_MS, lockStaleMs = RESERVE_LOCK_STALE_MS,
  pid = process.pid, lockIo = {}, reserveIo = {},
} = {}) {
  const noop = () => ({ ok: true, skipped: true });
  if (model == null || String(model).trim() === '') {
    return { ok: true, verdict: 'free', attributed: false, release: noop, why: '起会话没钉 model，渠道无从归属——本闸不拦（机器总闸仍在）' };
  }
  const facts = readChannelFacts({ model, io });
  if (!facts.ok) return facts;

  const resolved = resolveModelChannel({ model, legs: facts.raw['腿'], models: facts.models, caps: facts.caps });
  if (!resolved) {
    // 认不出渠道 ⇒ 无处占槽，也无从判满。语义与 judgeChannelForModel 那一支一致（故意不 fail-close，
    // 理由见 checkChannelCapacity 的注释：全盘阻塞的代价远大于漏拦一个未登记模型）。
    const verdict = judgeChannelForModel({
      model, legs: facts.raw['腿'], models: facts.models, caps: facts.caps, states: facts.states,
      inFlight: facts.procCounts, breaker: facts.breaker, now, breakerPolicy,
    });
    return { ...shapeVerdict(verdict, { unattributedTrees: facts.unattributed.length }), release: noop };
  }

  const channel = resolved.channel;
  const dir = reserveDir({ home, channel });
  const acquire = lockIo.acquire || acquireWorktreeLock;
  const got = acquire({
    lockPath: reserveLockPath({ home, channel }),
    timeoutMs: lockTimeoutMs,
    staleMs: lockStaleMs,
    ...lockIo.opts,
  });
  if (!got.ok) {
    return { ok: false, unscanned: true, error: `渠道占槽锁没拿到（${got.error}）——数不准也占不上槽，不起（fail-close）` };
  }

  try {
    const counted = countLiveReservations({ dir, now, ttlMs, ...reserveIo });
    if (!counted.ok) {
      return { ok: false, unscanned: true, error: `渠道预占数没查成（${counted.error}）` };
    }
    const inFlight = { ...facts.procCounts };
    inFlight[channel] = (Number(inFlight[channel]) || 0) + counted.live;
    const verdict = judgeChannelForModel({
      model, legs: facts.raw['腿'], models: facts.models, caps: facts.caps, states: facts.states,
      inFlight, breaker: facts.breaker, now, breakerPolicy,
    });
    if (!verdict.available) {
      return { ...shapeVerdict(verdict, { unattributedTrees: facts.unattributed.length, reservations: counted.live }), release: noop };
    }
    // 未满 → 当场占一个槽。写在锁里，所以「数」和「占」之间没有别人插得进来的缝。
    const mkdir = reserveIo.mkdir || mkdirSync;
    const write = reserveIo.write || writeFileSync;
    const unlink = reserveIo.unlink || unlinkSync;
    const file = join(dir, `${pid}-${Math.random().toString(36).slice(2, 10)}.res`);
    try {
      mkdir(dir, { recursive: true });
      write(file, JSON.stringify({ pid, at: now, model: String(model), channel }), 'utf8');
    } catch (e) {
      // 占不上槽 = 没查成（不是满员）：放行就等于回到读快照那套竞态。
      return { ok: false, unscanned: true, error: `渠道预占写不进（${String(e && e.message || e)}）——占不上槽不放行` };
    }
    let released = false;
    const release = () => {
      if (released) return { ok: true, skipped: true };
      released = true;
      try { unlink(file); return { ok: true, path: file }; }
      catch (e) {
        // 删不掉不许让起会话失败：预占有 TTL + pid 判死兜底，最坏是这个渠道少一个名额到 TTL 到点。
        return { ok: false, error: `预占删不掉（${String(e && e.message || e)}）——靠 TTL/pid 兜底`, path: file };
      }
    };
    return {
      ...shapeVerdict(verdict, { unattributedTrees: facts.unattributed.length, reservations: counted.live }),
      release, reservePath: file,
    };
  } finally {
    try { got.release(); } catch { /* 放锁失败由 #849 的 pid/mtime 拆锁兜底 */ }
  }
}
