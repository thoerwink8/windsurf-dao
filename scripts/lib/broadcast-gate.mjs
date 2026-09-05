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
// ── 类型闭集与枚举：一律派生，不另抄 ──────────────────────────────────────
// 事件类型闭集的唯一权威是 `schemas/events.schema.json`（闭集 = oneOf[].title）。
// 本文件不持有类型清单，只经 `event-writer.schemaMeta(schema)` 派生（`deriveGateTypes`）。
// `decision.pending.urgency` 的取值枚举、`session.milestone.kind` 的取值枚举同样从
// schema 里读（`propSchema`），不在本文件抄第二份。白名单里引用到的具体类型名
// （policy，不是清单）逐个对派生闭集核验：schema 里没有 ⇒ 进 `missing`，
// `why` 里明说「这个类型本轮播不出去」——这是「没查成」，不是「没有这类事件」。
//
// ── 按 W1 #893 最终事件契约接线（审官 PR #896 判 CHANGES_REQUESTED 后返工）────
// ① 里程碑有**两个**类型，判据分开处理：
//    · `session.milestone`（W5 #897 的写口：commit/land/pr-merge）——**没有 success 字段**，
//      必填 kind/repo/evidence/milestone_key；本闸另要求 `milestone_key` 非空、
//      `evidence` 非空数组（schema minItems=1），因为**去重主体就是 milestone_key**，
//      缺了它去重会静默降级 ⇒ 缺就报「事件残缺没查成」，不拿它去播。
//    · `job.closed`（历史类型，能力账正样本）——必须 `success === true`；
//      `success === false` 是失败关单，只进账不播。
// ② `decision.pending.urgency` 是**事件自己的字段**（枚举 急/缓/null），不是类的固定属性：
//    急 ⇒ 即时插播；缓 ⇒ 攒到窗末；**null / 缺字段 ⇒ 按缓处理**，但 `why` 里记的是
//    「没判过」不是「判过是缓」（#897 实测：AskUserQuestion 与 im_ask_user 的入参里
//    都没有 urgency 这一位，写口只能记 null——账面不许伪造）。
// ③ 主体（去重键的前半）按类型取专用字段，**不认通名 `subject`**：
//    `session.milestone.subject` 是**提交标题**，不是主体——拿它当主体，两个同标题的
//    提交会撞成一条、后一条永不播。主体一律取幂等/标识字段（milestone_key /
//    decision_id / session_id / job_id / fingerprint）。
//
// ── 配置落点 ───────────────────────────────────────────────────────────
// 沿用 `feishu-ops` 的群↔仓映射（`host/machine/feishu-groups.json` 占位模板 /
// 实机 `~/.mirasim/keys/feishu-groups.json`），每群加一个可选 `broadcast` 节。
// `loadBroadcastGroups()` 从同一份 JSON 里读它并补默认值，不另立文件。
// 既有两个消费方对多出来的字段免疫：`feishu-triage.loadGroups` 只取 repo/kind，
// `feishu-groups-check.parseGroupCatalog` 只取 chat_id。
// **只有字段缺省才套默认值**：`broadcast` 出现但不是对象（`"bad"` / `[]` / `null`）、
// 或 `subscribe` / `dailyBudget` 类型不对，一律进 `problems`——把写坏的配置静默
// 套成「项目群全订阅 / 预算 20」，等于把「没读成」显示成「一切正常」（本仓反复实咬的病）。
// 认不出的**多余键**故意不报：W5 接线可能加字段，报了会把前向兼容变成红。
//
// ── 调用方要做的两件事（本文件不做）───────────────────────────────────────
// ① 把 `send[].dedupeKey` 记进下一轮的 `state.seen[chatId]`，把发出条数累加进
//    `state.sentToday[chatId]`（发成了才记；没发成不记，下轮还会再判）。
// ② 脱敏。事件正文的净化归写口（#891 期一第 3 条，Stop hook 写入前过滤），
//    本文件只搬字符串，不当第二道防线。

import { canonicalStringify, sha256Hex } from './dianjiangtai-core.mjs';
import { schemaMeta } from './event-writer.mjs';
import { compareEvents } from './ledger-query.mjs';

// ── 三类白名单（闸2 的 policy；类型名与枚举逐个对 schema 核验）─────────────────

export const CLASS_DECISION = 'decision.pending';
export const CLASS_MILESTONE = 'milestone';
export const CLASS_INCIDENT = 'incident';
/** 播报三类，顺序固定（进 why / 默认订阅列表 / 窗末批次顺序都靠它稳定）。 */
export const BROADCAST_CLASSES = [CLASS_DECISION, CLASS_MILESTONE, CLASS_INCIDENT];

export const URGENCY_INSTANT = '急';
export const URGENCY_BATCH = '缓';
/** urgency 取「事件自己说」的哨兵（对上 decision.pending.urgency 那一位）。 */
const URGENCY_FROM_EVENT = '__from_event__';

/** 去重键的字段分隔符：NUL，主体与 digest 都不可能含它 ⇒ 键不会歧义拼接。 */
const KEY_SEP = '\u0000';

function nonEmptyStr(v) {
  return typeof v === 'string' && v.trim() !== '';
}

/**
 * 播报面认识的类型表：**按类型**给判据（不是按类——里程碑有两个类型，判据不同）。
 *   cls         这条类型归哪一播报类（闸2 白名单 / 闸5 订阅都按类）
 *   subjectKeys 去重主体取哪个字段（幂等/标识字段，不认通名 subject）
 *   urgency     固定急缓，或 URGENCY_FROM_EVENT = 读事件自己的 urgency
 *   accept(e)   → true | 一句「为什么不该播」；判据不合就只进账
 */
const TYPE_RULES = {
  'decision.pending': {
    cls: CLASS_DECISION,
    subjectKeys: ['decision_id'],
    urgency: URGENCY_FROM_EVENT,
    accept: (e) => (nonEmptyStr(e.decision_id)
      ? true
      : '缺 decision_id（schema 必填，且它就是去重主体）⇒ 事件残缺，没查成，不拿它去播'),
  },
  'session.milestone': {
    cls: CLASS_MILESTONE,
    subjectKeys: ['milestone_key'],
    urgency: URGENCY_BATCH,
    accept: (e) => {
      if (!nonEmptyStr(e.milestone_key)) {
        return '缺 milestone_key（schema 必填的幂等键，且它就是去重主体）⇒ 事件残缺，没查成，不拿它去播';
      }
      if (!Array.isArray(e.evidence) || e.evidence.length === 0) {
        return 'evidence 空或缺（schema minItems=1：里程碑没有证据就不该写）⇒ 没查成，不拿它去播';
      }
      return true;
    },
  },
  'job.closed': {
    cls: CLASS_MILESTONE,
    subjectKeys: ['job_id'],
    urgency: URGENCY_BATCH,
    accept: (e) => {
      if (!nonEmptyStr(e.job_id)) return '缺 job_id（去重主体）⇒ 没查成，不拿它去播';
      return e.success === true
        ? true
        : 'success !== true（失败关单不是里程碑；合并·落地才算）⇒ 只进账不播';
    },
  },
  incident: {
    cls: CLASS_INCIDENT,
    subjectKeys: ['fingerprint'],
    urgency: URGENCY_INSTANT,
    accept: (e) => (nonEmptyStr(e.fingerprint)
      ? true
      : '缺 fingerprint（schema 必填，且它就是去重主体）⇒ 事件残缺，没查成，不拿它去播'),
  },
};

/** 每类的人读标签（进消息前缀与窗末摘要抬头）。 */
const CLASS_LABEL = {
  [CLASS_DECISION]: '待拍板',
  [CLASS_MILESTONE]: '里程碑',
  [CLASS_INCIDENT]: '事故',
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

// ── 闭集与枚举派生 ─────────────────────────────────────────────────────

/** 从 schema 的某个 oneOf 条目里取某个字段的子 schema（走 allOf，不解 $ref——本文件只要顶层字段）。 */
export function propSchema(schema, title, prop) {
  const def = ((schema && schema.oneOf) || []).find((d) => d && d.title === title);
  if (!def) return null;
  const nodes = Array.isArray(def.allOf) ? def.allOf : [def];
  for (const n of nodes) {
    const p = n && n.properties && n.properties[prop];
    if (p) return p;
  }
  return null;
}

/**
 * 从 schema 派生：闭集、类型→类映射、缺的类型、以及两个取值枚举。
 * 唯一权威 = schemas/events.schema.json（闭集 = oneOf[].title；枚举 = 字段自己的 enum）。
 * enumOf 派生不出来时给 null，判定时按「枚举没派生成」说，不拿本文件的常量冒充权威。
 */
export function deriveGateTypes(schema) {
  if (!schema || typeof schema !== 'object' || !Array.isArray(schema.oneOf)) {
    throw new Error('deriveGateTypes 要解析后的 events schema 对象（缺 oneOf ⇒ 闭集没派生成，不是闭集为空）');
  }
  const { closedSet } = schemaMeta(schema);
  const set = new Set(closedSet);
  const typeToClass = new Map();
  const missing = [];
  for (const type of Object.keys(TYPE_RULES)) {
    if (set.has(type)) typeToClass.set(type, TYPE_RULES[type].cls);
    else missing.push({ cls: TYPE_RULES[type].cls, type });
  }
  const enumOf = (title, prop) => {
    const p = propSchema(schema, title, prop);
    return p && Array.isArray(p.enum) ? [...p.enum] : null;
  };
  return {
    closedSet: [...set].sort(),
    typeToClass,
    missing,
    urgencyEnum: enumOf('decision.pending', 'urgency'),
    milestoneKinds: enumOf('session.milestone', 'kind'),
  };
}

// ── 闸1 的键：主体 + digest ────────────────────────────────────────────

/**
 * 主体兜底顺序（表里没有的类型才走到这儿）。
 * **故意不含通名 `subject`**：`session.milestone.subject` 是提交标题，拿它当主体
 * 会让两个同标题的提交撞成一条、后一条永不播。
 */
const GENERIC_SUBJECT_KEYS = [
  'decision_id', 'milestone_key', 'session_id', 'job_id',
  'pr_number', 'issue', 'fingerprint', 'target_decision_id', 'target_event_id', 'model',
];

/** 主体：先按类型取专用标识字段，再走兜底顺序。 */
export function subjectOf(event) {
  const type = event && event.type;
  const rule = TYPE_RULES[type];
  const keys = rule ? [...rule.subjectKeys, ...GENERIC_SUBJECT_KEYS] : GENERIC_SUBJECT_KEYS;
  for (const k of keys) {
    const v = event ? event[k] : null;
    if (v != null && String(v).trim() !== '') return `${k}=${String(v).trim()}`;
  }
  return `type=${type || ''}`;
}

/** 易变字段（同一状态每轮都会变）——算 digest 时必须剔掉，否则每轮都是「新状态」。 */
const VOLATILE = new Set(['ts', 'seq', 'event_id', 'machine', 'schema_version', 'digest']);

/**
 * 状态摘要哈希：事件自带 `digest` 优先（`session.state` 的 schema 明说那一位就是
 * 「播报闸内容维去重键的内容部分」，写口算好），否则拿去掉易变字段的规范化正文算。
 */
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

// ── 闸3 的急缓：读事件自己的 urgency ────────────────────────────────────

/**
 * 判一条事件走急还是缓。返回 { urgency, why, unjudged }。
 * `unjudged=true` = 账面没判过（null/缺字段/值不认识），按缓走但不说成「判过是缓」。
 */
export function urgencyOf(event, derived) {
  const type = event && event.type;
  const rule = TYPE_RULES[type];
  if (!rule) return { urgency: URGENCY_BATCH, unjudged: true, why: '类型不在播报面，按缓兜底' };
  if (rule.urgency !== URGENCY_FROM_EVENT) {
    return { urgency: rule.urgency, unjudged: false, why: `类型 ${type} 固定走${rule.urgency}` };
  }
  const has = Object.prototype.hasOwnProperty.call(event, 'urgency');
  const raw = has ? event.urgency : undefined;
  // 1. null / 缺席单独说：枚举里有 null 只表示允许这个取值，不等于「判过是缓」
  if (raw === null || raw === undefined) {
    return {
      urgency: URGENCY_BATCH,
      unjudged: true,
      why: `urgency ${has ? '记的是 null' : '这一位没写'} = 写口没判过（#897 实测两种问用户的工具都拿不到）⇒ 按缓处理，不是「判过是缓」`,
    };
  }
  // 2. 急/缓放行前必须先过 schema 派生枚举。枚举没派生成则不要 includes 崩掉，沿用后面急/缓硬编码。
  if (Array.isArray(derived && derived.urgencyEnum) && !derived.urgencyEnum.includes(raw)) {
    const known = `schema 枚举=${derived.urgencyEnum.map((x) => String(x)).join('/')}`;
    return {
      urgency: URGENCY_BATCH,
      unjudged: true,
      why: `urgency 值「${String(raw)}」不在 schema 枚举、不认识（${known}）⇒ 没查成，按缓处理`,
    };
  }
  // 3. 通过枚举核验之后，才急/缓放行（不要把这两支写在核验前面）
  if (raw === URGENCY_INSTANT) {
    return { urgency: URGENCY_INSTANT, unjudged: false, why: '事件自报 urgency=急 ⇒ 即时插播' };
  }
  if (raw === URGENCY_BATCH) {
    return { urgency: URGENCY_BATCH, unjudged: false, why: '事件自报 urgency=缓 ⇒ 攒到窗末' };
  }
  // 4. 枚举里出现了本文件不认识的合法值
  const known = derived && Array.isArray(derived.urgencyEnum)
    ? `schema 枚举=${derived.urgencyEnum.map((x) => String(x)).join('/')}`
    : 'schema 里这一位的枚举没派生成';
  return {
    urgency: URGENCY_BATCH,
    unjudged: true,
    why: `urgency 值「${String(raw)}」不认识（${known}）⇒ 没查成，按缓处理`,
  };
}

// ── 群订阅配置：读同一份群↔仓映射 ─────────────────────────────────────────

function plainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * 从已解析的 feishu-groups.json 取每群的 broadcast 节，补默认值。
 * `_` 开头的键是注释（沿用群映射表既有约定），不参与。
 * 返回 { groups, problems }：problems 非空即配置有毛病，调用方自己决定拒还是降级。
 * **字段存在但类型不对 ⇒ 进 problems，不套默认值**：静默套默认等于把「没读成」
 * 显示成「一切正常」，写坏的配置会变成错误的播报策略。
 */
export function loadBroadcastGroups(groupsJson) {
  const problems = [];
  if (!plainObject(groupsJson)) {
    return { groups: {}, problems: ['群映射表根不是对象 ⇒ 本次没读成，不是没有群'] };
  }
  const groups = {};
  for (const chatId of Object.keys(groupsJson).sort()) {
    if (chatId.startsWith('_')) continue;
    const v = groupsJson[chatId];
    if (!plainObject(v)) {
      problems.push(`群 ${chatId} 的映射不是对象`);
      continue;
    }
    const kind = v.kind === 'hub' || v.kind === 'project' ? v.kind : null;
    if (!kind) {
      problems.push(`群 ${chatId} 的 kind 不认识：${String(v.kind)}`);
      continue;
    }
    // broadcast 缺省 = 用默认；出现但不是对象 = 没读成，绝不静默当空配置
    const hasB = Object.prototype.hasOwnProperty.call(v, 'broadcast');
    if (hasB && !plainObject(v.broadcast)) {
      problems.push(`群 ${chatId} 的 broadcast 不是对象（实际 ${JSON.stringify(v.broadcast)}）⇒ 没读成，不套默认值`);
      continue;
    }
    const b = hasB ? v.broadcast : {};
    let subscribe;
    if (!Object.prototype.hasOwnProperty.call(b, 'subscribe')) {
      subscribe = [...DEFAULT_SUBSCRIBE[kind]];
    } else if (!Array.isArray(b.subscribe)) {
      problems.push(`群 ${chatId} 的 broadcast.subscribe 不是数组（实际 ${JSON.stringify(b.subscribe)}）⇒ 没读成，不套默认值`);
      continue;
    } else {
      const bad = b.subscribe.filter((c) => !BROADCAST_CLASSES.includes(c));
      if (bad.length) {
        problems.push(`群 ${chatId} 订阅了不认识的类：${bad.map((x) => String(x)).join('/')}（认 ${BROADCAST_CLASSES.join('/')}）`);
        continue;
      }
      subscribe = BROADCAST_CLASSES.filter((c) => b.subscribe.includes(c));
    }
    let dailyBudget;
    if (!Object.prototype.hasOwnProperty.call(b, 'dailyBudget')) {
      dailyBudget = DEFAULT_DAILY_BUDGET[kind];
    } else if (!Number.isInteger(b.dailyBudget) || b.dailyBudget < 0) {
      problems.push(`群 ${chatId} 的 broadcast.dailyBudget 要非负整数，实际 ${JSON.stringify(b.dailyBudget)} ⇒ 没读成，不套默认值`);
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

/**
 * 事件正文一句话：按固定优先序取第一个有值的字段，都没有就退回主体。
 * 顺序照各类型的「那一句」排：question（待拍板）→ subject（里程碑的提交标题）
 * → doing（会话态）→ summary/detail → why（事故的一句说明）→ title。
 */
export function eventHeadline(event) {
  const order = ['question', 'subject', 'doing', 'summary', 'detail', 'why', 'title'];
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
        .map((o) => oneLine(typeof o === 'string' ? o : (o && o.label) || '', 40))
        .filter(Boolean);
      if (labels.length) parts.push(`选项：${labels.join(' / ')}`);
    }
    if (nonEmptyStr(event.recommend)) parts.push(`推荐：${oneLine(event.recommend, 60)}`);
    return parts.join('\n');
  }
  // 里程碑：session.milestone 有 kind（commit/land/pr-merge），job.closed 没有
  const kindBit = nonEmptyStr(event.kind) ? `·${oneLine(event.kind, 16)}` : '';
  return `[里程碑${kindBit}] ${eventHeadline(event)}`;
}

/**
 * 窗末攒批合成一条**三行**摘要（#891 闸3）。行数恒为 3，便于断言。
 * 按类分批：待拍板与里程碑各自一条，抬头不混——把待拍板塞进「里程碑」抬头会误标。
 */
export function renderDigest(items, cls = CLASS_MILESTONE) {
  const n = items.length;
  const head = items.slice(0, 3).map(({ event }) => oneLine(eventHeadline(event), 48));
  return [
    `[${CLASS_LABEL[cls] || cls}] 窗末汇总 ${n} 条`,
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
  const s = plainObject(state) ? state : {};
  const day = nonEmptyStr(s.day) ? s.day.trim() : '';
  if (!day) throw new Error('state.day 必填（YYYY-MM-DD，调用方给「今天」；本文件不读时钟）');
  const seen = {};
  for (const [k, v] of Object.entries(plainObject(s.seen) ? s.seen : {})) {
    seen[k] = new Set(Array.isArray(v) ? v : Object.keys(v || {}));
  }
  const sentToday = plainObject(s.sentToday) ? s.sentToday : {};
  return { day, windowClosing: s.windowClosing === true, seen, sentToday };
}

/**
 * 五条闸的唯一判官。纯函数：不读时钟/文件/网络，不改入参。
 *
 * events —— 账本事件数组（原样，含 type/ts/machine/seq/event_id + 类型专属字段）
 * config —— { schema（解析后的 events schema，闭集与枚举派生用）,
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
  const cfg = plainObject(config) ? config : {};
  const groups = plainObject(cfg.groups) ? cfg.groups : null;
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
    why.push(`闸2 没查成：schema 闭集里没有「${m.type}」⇒ 这个类型的事件本轮播不出去（不是「没有这类事件」）；它归「${m.cls}」类`);
  }
  if (!Array.isArray(derived.urgencyEnum)) {
    why.push('闸3 没查成：schema 里 decision.pending.urgency 的枚举没派生成 ⇒ 认不出的取值只能按缓兜底');
  }

  // 闸2：白名单三类（类型闭集派生自 schema，判据按类型分开）
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
      drop(null, e, 2, `类型「${type}」不在播报白名单（认 ${Object.keys(TYPE_RULES).sort().join('/')}）⇒ 只进账不播`);
      continue;
    }
    const verdict = TYPE_RULES[type].accept(e);
    if (verdict !== true) {
      drop(null, e, 2, `${type} 未达判据：${verdict}`);
      continue;
    }
    passed.push({ event: e, cls, urg: urgencyOf(e, derived) });
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
    const batches = new Map(); // cls -> items[]（窗末按类各合一条，抬头不混）
    for (const { event, cls, urg } of passed) {
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
      // 闸3：急缓分流——急看事件自己的 urgency，缓攒到窗末
      if (urg.urgency === URGENCY_INSTANT) {
        instant.push({ event, cls, key, urg });
      } else if (!st.windowClosing) {
        drop(chatId, event, 3, `${urg.why}；非窗末 ⇒ 攒到窗末合成一条三行摘要（deferred：本轮不发，不是丢弃）`, true);
      } else {
        if (!batches.has(cls)) batches.set(cls, []);
        batches.get(cls).push({ event, cls, key, urg });
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
          why: `${it.urg.why}；预算 ${budget} 已用 ${budget - remaining}`,
        });
      } else {
        blocked.push(it);
        drop(chatId, it.event, 4, `今日预算 ${budget} 条已用满（进本轮前已用 ${used}）⇒ 只发「还有 X 条，@我问详情」`);
      }
    }
    // 窗末批次按 BROADCAST_CLASSES 固定顺序发，每类一条（确定性，不吃 Map 插入序）
    for (const cls of BROADCAST_CLASSES) {
      const batch = batches.get(cls);
      if (!batch || batch.length === 0) continue;
      if (remaining > 0) {
        remaining -= 1;
        const unjudged = batch.filter((b) => b.urg.unjudged).length;
        emit({
          chatId,
          class: cls,
          urgency: URGENCY_BATCH,
          kind: 'digest',
          text: digestRender(batch, cls),
          dedupeKey: batch.map((b) => b.key).join(KEY_SEP),
          eventIds: batch.map((b) => b.event.event_id),
          gate: 3,
          why: `窗末把 ${batch.length} 条「${cls}」合成一条三行摘要${unjudged ? `（其中 ${unjudged} 条 urgency 没判过，按缓收进来）` : ''}；预算 ${budget} 已用 ${budget - remaining}`,
        });
      } else {
        for (const it of batch) {
          blocked.push(it);
          drop(chatId, it.event, 4, `今日预算 ${budget} 条已用满（进本轮前已用 ${used}）⇒ 「${cls}」窗末摘要也不发`);
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
