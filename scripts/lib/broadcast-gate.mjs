// scripts/lib/broadcast-gate.mjs —— 播报闸（issue #891 期一，五条闸的纯函数）
//
// 病（#891 起因）：`hub-say` 是 N 个调用方各自决定播什么——8 个触发点 + 一条
// 6 小时时间维去重（`scripts/commander.mjs` 的 `HUB_DEDUP_MS` / `hubOnce`）。
// 判据散在推送方手里，改不动、测不了、配不了。本文件把那一层删掉，换成
// 「一份账 + 一个播报闸」：账全量进 `~/.dao/ledger/events`，播由本文件判。
//
// ── 与现有 6 小时去重的关系（闸1 替代它，不是叠加）─────────────────────────
// 现状 `hubOnce` 是**时间维**：同一个 key 6 小时内不重发。粗在两头——
// 状态真变了也要等 6 小时（漏播），状态没变但过了 6 小时又发一遍（刷屏）。
// 闸1 是**内容维**：去重键 =（主体, digest）。同主体同 digest 永不重播，
// 主体的 digest 一变立刻放行。W5 接线时 `hubOnce` 的时间维那一层应当退役，
// 由本文件的闸1 + 调用方持久化的 `state.seen` 顶上；两条同时留着 = 双重压制。
//
// ── 纯函数纪律 ─────────────────────────────────────────────────────────
// 不读时钟、不读文件、不发网络、不改入参。时间面（今天是哪天、是不是窗末）
// 与已播历史（`state.seen` / `state.sentToday`）一律由调用方传入 ⇒ 可测、可重放。
// 事件顺序用账本全序键 (ts, machine, seq, event_id)（`ledger-query.compareEvents`），
// 群按 chat_id 字典序遍历 ⇒ 同输入同输出，不吃 Map 迭代序。
//
// ── 类型闭集：派生，不另抄 ───────────────────────────────────────────────
// 事件类型闭集的唯一权威是 `schemas/events.schema.json`（闭集 = oneOf[].title）。
// 本文件不持有类型清单，只经 `event-writer.schemaMeta(schema)` 派生（`deriveGateTypes`）。
// 白名单三类里引用到的具体类型名（policy，不是清单）逐个对派生闭集核验：
// schema 里没有 ⇒ 进 `missing`，`why` 里明说「该类本轮播不出去」——
// 这是「没查成」，不是「没有这类事件」。
//
// ── 配置落点 ───────────────────────────────────────────────────────────
// 沿用 `feishu-ops` 的群↔仓映射（`host/machine/feishu-groups.json` 占位模板 /
// 实机 `~/.mirasim/keys/feishu-groups.json`），每群加一个可选 `broadcast` 节。
// `loadBroadcastGroups()` 从同一份 JSON 里读它并补默认值，不另立文件。
// 既有两个消费方对多出来的字段免疫：`feishu-triage.loadGroups` 只取 repo/kind，
// `feishu-groups-check.parseGroupCatalog` 只取 chat_id。
//
// ── 调用方要做的两件事（本文件不做）───────────────────────────────────────
// ① 把 `send[].dedupeKey` 记进下一轮的 `state.seen[chatId]`，把发出条数累加进
//    `state.sentToday[chatId]`（发成了才记；没发成不记，下轮还会再判）。
// ② 脱敏。事件正文的净化归写口（#891 期一第 3 条，Stop hook 写入前过滤），
//    本文件只搬字符串，不当第二道防线。

import { canonicalStringify, sha256Hex } from './dianjiangtai-core.mjs';
import { schemaMeta } from './event-writer.mjs';
import { compareEvents } from './ledger-query.mjs';

// ── 三类白名单（闸2 的 policy；类型名逐个对派生闭集核验）─────────────────────

export const CLASS_DECISION = 'decision.pending';
export const CLASS_MILESTONE = 'milestone';
export const CLASS_INCIDENT = 'incident';
/** 播报三类，顺序固定（进 why / 默认订阅列表都靠它稳定）。 */
export const BROADCAST_CLASSES = [CLASS_DECISION, CLASS_MILESTONE, CLASS_INCIDENT];

export const URGENCY_INSTANT = '急';
export const URGENCY_BATCH = '缓';

/** 去重键的字段分隔符：NUL，主体与 digest 都不可能含它 ⇒ 键不会歧义拼接。 */
const KEY_SEP = '\u0000';

/**
 * 类 → { types（schema 闭集里的类型名）, urgency, match（事件级判据）, matchWhy }。
 * 里程碑不是一个事件类型：它是 job.closed 且 success=true（合并·落地）；
 * success=false 是失败关单，只进账不播（闸2 的反样本）。
 */
const CLASS_RULES = {
  [CLASS_DECISION]: {
    types: ['decision.pending'],
    urgency: URGENCY_INSTANT,
    match: () => true,
    matchWhy: '待拍板即时插播',
  },
  [CLASS_MILESTONE]: {
    types: ['job.closed'],
    urgency: URGENCY_BATCH,
    match: (e) => e.success === true,
    matchWhy: 'job.closed 且 success=true 才算里程碑（合并·落地）',
  },
  [CLASS_INCIDENT]: {
    types: ['incident'],
    urgency: URGENCY_INSTANT,
    match: () => true,
    matchWhy: '事故即时插播',
  },
};

/** 按群类型给的默认订阅（闸5：人多的群默认只订里程碑）。hub = 总控群，人最多。 */
export const DEFAULT_SUBSCRIBE = {
  hub: [CLASS_MILESTONE],
  project: [...BROADCAST_CLASSES],
};
/** 默认每日上限（闸4：上限由群配置决定，不由事件量决定）。 */
export const DEFAULT_DAILY_BUDGET = { hub: 6, project: 20 };

/** 预算溢出提示的去重主体（闸4 借闸1 的机制做到一天一条）。 */
export const BUDGET_SUBJECT = '__budget_notice__';

// ── 闭集派生 ──────────────────────────────────────────────────────────

/**
 * 从 schema 派生：闭集、类型→类映射、policy 里引用但闭集没有的类型。
 * 唯一权威 = schemas/events.schema.json 的 oneOf[].title（经 schemaMeta）。
 */
export function deriveGateTypes(schema) {
  if (!schema || typeof schema !== 'object' || !Array.isArray(schema.oneOf)) {
    throw new Error('deriveGateTypes 要解析后的 events schema 对象（缺 oneOf ⇒ 闭集没派生成，不是闭集为空）');
  }
  const { closedSet } = schemaMeta(schema);
  const set = new Set(closedSet);
  const typeToClass = new Map();
  const missing = [];
  for (const cls of BROADCAST_CLASSES) {
    for (const t of CLASS_RULES[cls].types) {
      if (set.has(t)) typeToClass.set(t, cls);
      else missing.push({ cls, type: t });
    }
  }
  return { closedSet: [...set].sort(), typeToClass, missing };
}

// ── 闸1 的键：主体 + digest ────────────────────────────────────────────

/** 主体：事件自报 subject 优先，否则按固定优先序取一个稳定标识。 */
export function subjectOf(event) {
  const order = ['subject', 'job_id', 'pr_number', 'issue', 'fingerprint', 'target_event_id', 'model'];
  for (const k of order) {
    const v = event ? event[k] : null;
    if (v != null && String(v).trim() !== '') return `${k}=${String(v).trim()}`;
  }
  return `type=${event && event.type ? event.type : ''}`;
}

/** 易变字段（同一状态每轮都会变）——算 digest 时必须剔掉，否则每轮都是「新状态」。 */
const VOLATILE = new Set(['ts', 'seq', 'event_id', 'machine', 'schema_version', 'digest']);

/** 状态摘要哈希：事件自带 digest 优先（写口算过），否则拿去掉易变字段的规范化正文算。 */
export function digestOf(event) {
  if (event && typeof event.digest === 'string' && event.digest.trim()) return event.digest.trim();
  const body = {};
  for (const k of Object.keys(event || {}).sort()) {
    if (!VOLATILE.has(k)) body[k] = event[k];
  }
  return sha256Hex(canonicalStringify(body)).slice(0, 16);
}

/** 去重键 =（主体, digest）。同主体同 digest ⇒ 状态没跃迁 ⇒ 不播。 */
export function dedupeKey(event) {
  return `${subjectOf(event)}${KEY_SEP}${digestOf(event)}`;
}

// ── 群订阅配置：读同一份群↔仓映射 ─────────────────────────────────────────

/**
 * 从已解析的 feishu-groups.json 取每群的 broadcast 节，补默认值。
 * `_` 开头的键是注释（沿用群映射表既有约定），不参与。
 * 返回 { groups, problems }：problems 非空即配置有毛病，调用方自己决定拒还是降级。
 */
export function loadBroadcastGroups(groupsJson) {
  const problems = [];
  if (!groupsJson || typeof groupsJson !== 'object' || Array.isArray(groupsJson)) {
    return { groups: {}, problems: ['群映射表根不是对象 ⇒ 本次没读成，不是没有群'] };
  }
  const groups = {};
  for (const chatId of Object.keys(groupsJson).sort()) {
    if (chatId.startsWith('_')) continue;
    const v = groupsJson[chatId];
    if (!v || typeof v !== 'object' || Array.isArray(v)) {
      problems.push(`群 ${chatId} 的映射不是对象`);
      continue;
    }
    const kind = v.kind === 'hub' || v.kind === 'project' ? v.kind : null;
    if (!kind) {
      problems.push(`群 ${chatId} 的 kind 不认识：${String(v.kind)}`);
      continue;
    }
    const b = v.broadcast && typeof v.broadcast === 'object' && !Array.isArray(v.broadcast) ? v.broadcast : {};
    let subscribe;
    if (b.subscribe === undefined) {
      subscribe = [...DEFAULT_SUBSCRIBE[kind]];
    } else if (!Array.isArray(b.subscribe)) {
      problems.push(`群 ${chatId} 的 broadcast.subscribe 不是数组`);
      continue;
    } else {
      const bad = b.subscribe.filter((c) => !BROADCAST_CLASSES.includes(c));
      if (bad.length) {
        problems.push(`群 ${chatId} 订阅了不认识的类：${bad.join('/')}（认 ${BROADCAST_CLASSES.join('/')}）`);
        continue;
      }
      subscribe = BROADCAST_CLASSES.filter((c) => b.subscribe.includes(c));
    }
    let dailyBudget;
    if (b.dailyBudget === undefined) {
      dailyBudget = DEFAULT_DAILY_BUDGET[kind];
    } else if (!Number.isInteger(b.dailyBudget) || b.dailyBudget < 0) {
      problems.push(`群 ${chatId} 的 broadcast.dailyBudget 要非负整数，实际 ${JSON.stringify(b.dailyBudget)}`);
      continue;
    } else {
      dailyBudget = b.dailyBudget;
    }
    groups[chatId] = { kind, repo: typeof v.repo === 'string' ? v.repo : null, subscribe, dailyBudget };
  }
  if (Object.keys(groups).length === 0 && problems.length === 0) {
    problems.push('一个群都没读到（_ 注释键不算）⇒ 本次等于没读，不是没有群');
  }
  return { groups, problems };
}

/** 校验：给 dao-check / 装机终检用的三态判官（ok / 有毛病 / 没读成）。 */
export function validateBroadcastGroups(groupsJson, schema) {
  const { groups, problems } = loadBroadcastGroups(groupsJson);
  const out = { ok: false, groups, problems: [...problems], missingTypes: [] };
  if (schema !== undefined) {
    let derived;
    try {
      derived = deriveGateTypes(schema);
    } catch (e) {
      out.problems.push(`类型闭集没派生成：${String(e.message || e)}`);
      return out;
    }
    out.missingTypes = derived.missing.map((m) => `${m.cls}<-${m.type}`);
  }
  out.ok = out.problems.length === 0;
  return out;
}

// ── 渲染（可注入；默认实现只搬字符串，不做脱敏）──────────────────────────────

function oneLine(s, cap = 160) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > cap ? `${t.slice(0, cap - 1)}…` : t;
}

/** 事件正文一句话：按固定优先序取第一个有值的字段，都没有就退回主体。 */
export function eventHeadline(event) {
  const order = ['summary', 'question', 'why', 'detail', 'title'];
  for (const k of order) {
    const v = event ? event[k] : null;
    if (typeof v === 'string' && v.trim()) return oneLine(v);
  }
  return oneLine(subjectOf(event));
}

/** 即时插播一条的正文。decision.pending 带选项与推荐（#891：一句话+选项+推荐）。 */
export function renderMessage(event, cls) {
  if (cls === CLASS_INCIDENT) {
    const fp = oneLine(event.fingerprint || '未知指纹', 60);
    const dis = oneLine(event.disposition || '未定', 24);
    return `[事故] ${fp} · 处置 ${dis} · ${eventHeadline(event)}`;
  }
  if (cls === CLASS_DECISION) {
    const parts = [`[待拍板] ${eventHeadline(event)}`];
    if (Array.isArray(event.options) && event.options.length) {
      const labels = event.options
        .map((o) => oneLine(typeof o === 'string' ? o : (o && (o.label || o.name)) || '', 40))
        .filter(Boolean);
      if (labels.length) parts.push(`选项：${labels.join(' / ')}`);
    }
    if (event.recommend != null && String(event.recommend).trim()) {
      parts.push(`推荐：${oneLine(event.recommend, 60)}`);
    }
    return parts.join('\n');
  }
  return `[里程碑] ${eventHeadline(event)}`;
}

/** 窗末里程碑合成一条**三行**摘要（#891 闸3）。行数恒为 3，便于断言。 */
export function renderDigest(items) {
  const n = items.length;
  const head = items.slice(0, 3).map(({ event }) => oneLine(eventHeadline(event), 48));
  return [
    `[里程碑] 窗末汇总 ${n} 条`,
    head.join('；') || '（无明细）',
    n > 3 ? `另有 ${n - 3} 条，@我问详情` : '明细 @我问详情',
  ].join('\n');
}

/** 预算溢出提示（闸4）：只报还有几条，不报内容。 */
export function renderBudgetNotice(blockedCount) {
  return `还有 ${blockedCount} 条，@我问详情`;
}

// ── 主闸 ─────────────────────────────────────────────────────────────

function normalizeState(state) {
  const s = state && typeof state === 'object' ? state : {};
  const day = typeof s.day === 'string' && s.day.trim() ? s.day.trim() : '';
  if (!day) throw new Error('state.day 必填（YYYY-MM-DD，调用方给「今天」；本文件不读时钟）');
  const seen = {};
  for (const [k, v] of Object.entries(s.seen && typeof s.seen === 'object' ? s.seen : {})) {
    seen[k] = new Set(Array.isArray(v) ? v : Object.keys(v || {}));
  }
  const sentToday = s.sentToday && typeof s.sentToday === 'object' ? s.sentToday : {};
  return { day, windowClosing: s.windowClosing === true, seen, sentToday };
}

/**
 * 五条闸的唯一判官。纯函数：不读时钟/文件/网络，不改入参。
 *
 * events —— 账本事件数组（原样，含 type/ts/machine/seq/event_id + 类型专属字段）
 * config —— { schema（解析后的 events schema，闭集派生用）,
 *             groups（loadBroadcastGroups 的产出）, render?, digestRender? }
 * state  —— { day: 'YYYY-MM-DD', windowClosing: bool,
 *             seen: { [chatId]: [dedupeKey…] }, sentToday: { [chatId]: N } }
 *
 * 返回 { send, suppressed, why }（恰好三个键）：
 *   send[]       = { chatId, class, urgency, kind, text, dedupeKey, eventIds, gate, why }
 *   suppressed[] = { chatId|null, eventId, type, class|null, gate, deferred, why }
 *                  deferred=true 是「攒到窗末」，不是丢弃（闸3）。
 *   why[]        = 逐条可读判定理由，顺序确定。
 */
export function decideBroadcast({ events, config, state } = {}) {
  if (!Array.isArray(events)) {
    throw new Error('events 必须是数组（本次没判成，不是没有事件）');
  }
  const cfg = config && typeof config === 'object' ? config : {};
  const groups = cfg.groups && typeof cfg.groups === 'object' ? cfg.groups : null;
  if (!groups) throw new Error('config.groups 必填（loadBroadcastGroups 的产出）');
  const render = typeof cfg.render === 'function' ? cfg.render : renderMessage;
  const digestRender = typeof cfg.digestRender === 'function' ? cfg.digestRender : renderDigest;
  const st = normalizeState(state);
  const derived = deriveGateTypes(cfg.schema);

  const send = [];
  const suppressed = [];
  const why = [];
  const shortId = (e) => String((e && e.event_id) || '').slice(0, 8) || '(无 event_id)';
  const drop = (chatId, event, gate, reason, deferred = false) => {
    const item = {
      chatId: chatId || null,
      eventId: (event && event.event_id) || null,
      type: (event && event.type) || null,
      class: derived.typeToClass.get(event && event.type) || null,
      gate,
      deferred,
      why: reason,
    };
    suppressed.push(item);
    why.push(`闸${gate} 拦下 ${chatId || '全局'} ${shortId(event)} ${item.type || '?'}：${reason}`);
  };
  const emit = (row) => {
    send.push(row);
    why.push(`闸${row.gate} 放行 ${row.chatId} ${row.kind}/${row.class}（${row.urgency}）：${row.why}`);
  };

  for (const m of derived.missing) {
    why.push(`闸2 没查成：schema 闭集里没有「${m.type}」⇒「${m.cls}」这一类本轮播不出去（不是「没有这类事件」）`);
  }

  // 闸2：白名单三类（类型闭集派生自 schema，不另抄清单）
  const ordered = [...events].sort(compareEvents);
  const passed = [];
  for (const e of ordered) {
    const type = e && e.type;
    if (!derived.closedSet.includes(type)) {
      drop(null, e, 2, `类型「${String(type)}」不在 schema 闭集 ⇒ 不进播报面（闭集 ${derived.closedSet.length} 类）`);
      continue;
    }
    const cls = derived.typeToClass.get(type);
    if (!cls) {
      drop(null, e, 2, `类型「${type}」不在播报白名单三类（${BROADCAST_CLASSES.join('/')}）⇒ 只进账不播`);
      continue;
    }
    if (!CLASS_RULES[cls].match(e)) {
      drop(null, e, 2, `${type} 未达「${cls}」判据：${CLASS_RULES[cls].matchWhy} ⇒ 只进账不播`);
      continue;
    }
    passed.push({ event: e, cls });
  }

  // 闸5/1/3/4：逐群（chat_id 字典序，确定性）
  for (const chatId of Object.keys(groups).sort()) {
    const g = groups[chatId] || {};
    const subscribe = Array.isArray(g.subscribe) ? g.subscribe : [];
    const budget = Number.isInteger(g.dailyBudget) ? g.dailyBudget : 0;
    const seen = st.seen[chatId] || new Set();
    const used = Number.isInteger(st.sentToday[chatId]) ? st.sentToday[chatId] : 0;
    // 本轮内也要去重：一批事件里同主体同 digest 出现两次（重放、心跳重写），
    // 只看 state.seen 会双发——state.seen 是上一轮的，本轮还没写回。
    const roundSeen = new Set(seen);

    const instant = [];
    const batch = [];
    for (const { event, cls } of passed) {
      // 闸5：群维度订阅
      if (!subscribe.includes(cls)) {
        drop(chatId, event, 5, `本群未订阅「${cls}」（订阅=${subscribe.join('/') || '（空）'}）`);
        continue;
      }
      // 闸1：只播状态跃迁（内容维去重，键=(主体,digest)）
      const key = dedupeKey(event);
      const shortKey = `${subjectOf(event)}/${digestOf(event).slice(0, 8)}`;
      if (seen.has(key)) {
        drop(chatId, event, 1, `同主体同 digest 已播过 ⇒ 状态没跃迁（键 ${shortKey}）`);
        continue;
      }
      if (roundSeen.has(key)) {
        drop(chatId, event, 1, `本轮已收下同键的一条 ⇒ 同主体同 digest 只播一次（键 ${shortKey}）`);
        continue;
      }
      roundSeen.add(key);
      // 闸3：急缓分流
      if (CLASS_RULES[cls].urgency === URGENCY_INSTANT) {
        instant.push({ event, cls, key });
      } else if (!st.windowClosing) {
        drop(chatId, event, 3, '里程碑攒到窗末合成一条三行摘要（deferred：本轮不发，不是丢弃）', true);
      } else {
        batch.push({ event, cls, key });
      }
    }

    // 闸4：每日预算硬闸（上限来自群配置，不看事件量）
    let remaining = budget - used;
    const blocked = [];
    for (const it of instant) {
      if (remaining > 0) {
        remaining -= 1;
        emit({
          chatId,
          class: it.cls,
          urgency: URGENCY_INSTANT,
          kind: 'instant',
          text: render(it.event, it.cls),
          dedupeKey: it.key,
          eventIds: [it.event.event_id],
          gate: 3,
          why: `${CLASS_RULES[it.cls].matchWhy}；预算 ${budget} 已用 ${budget - remaining}`,
        });
      } else {
        blocked.push(it);
        drop(chatId, it.event, 4, `今日预算 ${budget} 条已用满（进本轮前已用 ${used}）⇒ 只发「还有 X 条，@我问详情」`);
      }
    }
    if (batch.length) {
      if (remaining > 0) {
        remaining -= 1;
        emit({
          chatId,
          class: CLASS_MILESTONE,
          urgency: URGENCY_BATCH,
          kind: 'digest',
          text: digestRender(batch),
          dedupeKey: batch.map((b) => b.key).join(KEY_SEP),
          eventIds: batch.map((b) => b.event.event_id),
          gate: 3,
          why: `窗末把 ${batch.length} 条里程碑合成一条三行摘要；预算 ${budget} 已用 ${budget - remaining}`,
        });
      } else {
        for (const it of batch) {
          blocked.push(it);
          drop(chatId, it.event, 4, `今日预算 ${budget} 条已用满（进本轮前已用 ${used}）⇒ 里程碑摘要也不发`);
        }
      }
    }
    if (blocked.length) {
      // 溢出提示本身不计预算（否则超限即静默），靠闸1 的机制做到一天一条。
      const noticeKey = `subject=${BUDGET_SUBJECT}${KEY_SEP}${st.day}`;
      if (seen.has(noticeKey)) {
        why.push(`闸4 拦下 ${chatId} 溢出提示：今天已发过一条「还有 X 条」（一天一条，靠闸1 的键 ${BUDGET_SUBJECT}/${st.day}）`);
      } else {
        emit({
          chatId,
          class: null,
          urgency: URGENCY_INSTANT,
          kind: 'budget-notice',
          text: renderBudgetNotice(blocked.length),
          dedupeKey: noticeKey,
          eventIds: blocked.map((b) => b.event.event_id),
          gate: 4,
          why: `超上限 ${blocked.length} 条被拦，改发一条提示（提示不计预算，一天一条）`,
        });
      }
    }
  }

  return { send, suppressed, why };
}
