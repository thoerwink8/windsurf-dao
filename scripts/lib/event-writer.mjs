// scripts/lib/event-writer.mjs —— 点将台事件写入辅助（设计 A.2 三铁律）
//
// 一事件一文件：<账本目录>/<ulid>-<machine>.json（默认落点本机 ~/.dao/ledger/events，
// 不进 git，见 ledger-home.mjs）；写一次即不可变（已存在/同内容均拒绝，
// 纠错另立 attr.retract 不覆盖历史）；文件名 ULID 时间序 + 机器名，汇聚等于求并集。
// 事件类型闭集与必填字段一律派生自 schemas/events.schema.json（唯一权威），不另抄清单。
// 写入即校验（判据一律从 schema 派生，本文件不抄清单/数字/类型名）：类型在闭集内、
// 必填字段齐、enum 字段取值在闭集内、字段类型合 type 声明（含联合类型与数组元素）、
// 声明 minItems 的数组够条数、attr 责任向量不变量（份额和=1 或全 0 且低置信）、
// decision.pending 的 recommend 命中某条 option。
// 确定性：同一 (type, ts, machine, seq, payload) 恒产出同一 event_id 与同一文件名。

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalStringify, sha256Hex } from './dianjiangtai-core.mjs';

// 进程内目录索引：事件写一次即不可变（三铁律①），解析结果按文件名缓存；
// 每轮 readdir 只用来发现新文件/已删文件，新增才 readFileSync+parse。
// 修复前 scanEventId/scanJobType/nextSeq 每次都全量解析目录——批量写 N 个事件
// 总解析量 O(N²)；缓存后 = 冷启动一次全量 + 每事件一次增量，O(N)。
// 外部改已有文件内容违反不可变纪律，由 audit 独立冷扫负责，本缓存不重读。
const dirIndexes = new Map(); // dir -> Map<filename, event|null（损坏）>

function dirIndex(dir) {
  let idx = dirIndexes.get(dir);
  if (!idx) {
    idx = new Map();
    dirIndexes.set(dir, idx);
  }
  const names = existsSync(dir) ? readdirSync(dir) : [];
  const live = new Set(names);
  for (const name of idx.keys()) {
    if (!live.has(name)) idx.delete(name); // 外部删了 → 缓存跟着删
  }
  for (const f of names) {
    if (!f.endsWith('.json') || idx.has(f)) continue;
    try {
      idx.set(f, JSON.parse(readFileSync(join(dir, f), 'utf8')));
    } catch {
      idx.set(f, null); // 损坏文件交给 audit 查，不阻断写入
    }
  }
  return idx;
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const RESERVED = ['type', 'schema_version', 'ts', 'machine', 'seq', 'event_id'];
const ATTR_SHARE_KEYS = ['model_share', 'brief_share', 'coord_share', 'env_share'];
const OVERRUN_ATTRS = ['model', 'brief', 'coord', 'env'];

/** ULID 兼容：48-bit 毫秒时间戳（10 字符）+ 80-bit 熵（16 字符）。熵默认随机，可传 hex 求确定文件名。 */
export function ulidFromMs(ms, entropyHex) {
  let t = BigInt(ms);
  let out = '';
  for (let i = 0; i < 10; i++) {
    out = CROCKFORD[Number(t & 31n)] + out;
    t >>= 5n;
  }
  const e = BigInt('0x' + (entropyHex || randomBytes(10).toString('hex')));
  let x = e;
  for (let i = 0; i < 16; i++) {
    out += CROCKFORD[Number(x & 31n)];
    x >>= 5n;
  }
  return out;
}

/** schema 的 type 声明 → 允许类型数组（"string" 或 ["integer","null"] 都归一成数组）。 */
function declaredTypes(spec) {
  const t = spec?.type;
  if (typeof t === 'string') return [t];
  if (Array.isArray(t) && t.every(x => typeof x === 'string')) return [...t];
  return null; // 没声明 type（如纯 enum 字段）⇒ 类型不管，交给 enumInvariant
}

/**
 * 事件类型闭集 + 每类型必填字段 + 每类型枚举字段 + 每类型数组下限 + 每类型字段类型
 * （全部派生自 schema oneOf，闭集 = oneOf[].title；本文件不另抄任何清单、数字或类型名）。
 */
export function schemaMeta(schema) {
  const closedSet = [];
  const requiredByType = new Map();
  const enumsByType = new Map();
  const minItemsByType = new Map();
  const typesByType = new Map();
  const resolveRef = ref => {
    const name = ref.replace('#/definitions/', '');
    return schema.definitions ? schema.definitions[name] : null;
  };
  // acc = { required, enums, mins, types }：往下走时一路累积（allOf/$ref 都并进同一份）
  const walk = (node, acc) => {
    if (!node) return;
    if (node.$ref) return walk(resolveRef(node.$ref), acc);
    if (Array.isArray(node.allOf)) for (const c of node.allOf) walk(c, acc);
    if (Array.isArray(node.required)) {
      for (const f of node.required) if (!RESERVED.includes(f)) acc.required.add(f);
    }
    for (const [f, spec] of Object.entries(node.properties || {})) {
      if (RESERVED.includes(f)) continue;
      if (Array.isArray(spec?.enum)) acc.enums.set(f, spec.enum);
      if (spec?.type === 'array' && Number.isInteger(spec.minItems)) acc.mins.set(f, spec.minItems);
      const types = declaredTypes(spec);
      if (types) acc.types.set(f, { types, items: declaredTypes(spec.items) });
    }
  };
  for (const def of schema.oneOf || []) {
    const title = def.title;
    if (!title) throw new Error('schema oneOf 条目缺 title（闭集派生依赖 title）');
    closedSet.push(title);
    const acc = { required: new Set(), enums: new Map(), mins: new Map(), types: new Map() };
    walk(def, acc);
    requiredByType.set(title, [...acc.required]);
    enumsByType.set(title, acc.enums);
    minItemsByType.set(title, acc.mins);
    typesByType.set(title, acc.types);
  }
  return { closedSet, requiredByType, enumsByType, minItemsByType, typesByType, currentVersion: schema.version ?? 1 };
}

/** 值的 JSON Schema 类型名。null 与数组各自单独一类——typeof 两者都报 'object'。 */
function jsonTypeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  switch (typeof v) {
    case 'string': return 'string';
    case 'boolean': return 'boolean';
    case 'number': return Number.isInteger(v) ? 'integer' : 'number';
    case 'object': return 'object';
    default: return typeof v;
  }
}

/** 实际类型是否落在声明的允许集内。整数也算 number（JSON Schema 里 integer ⊂ number）。 */
function typeAllowed(actual, allowed) {
  return allowed.includes(actual) || (actual === 'integer' && allowed.includes('number'));
}

// schema 声明了 type 的字段，写入即校验类型；类型名只从 schema 读，本文件不另抄。
// 三个必须踩准的点（#891 W5 用真 writer 实测出的洞，四条形状漂移原先全静默落盘）：
//   ① 联合类型（["integer","null"]）按声明逐个比——null 只在声明里列了才放行
//      （pending_decision_id / urgency 的 null 合法，pr_number 写 "12" 非法）；
//   ② 数组先判「是数组」再判元素：typeof [] === 'object'，光看 typeof 会把数组当对象放过，
//      跟上一轮 minItems 那个「字符串也有 .length」是同一个坑换了形状；
//   ③ 字段整个不写 = 缺字段，归必填检查，这里不管（identity 拿不到就别写那一条靠它）。
function typeInvariant(types, p) {
  for (const [field, spec] of types || []) {
    const v = p[field];
    if (v === undefined) continue;
    const actual = jsonTypeOf(v);
    if (!typeAllowed(actual, spec.types)) {
      throw new Error(`字段 ${field} 类型非法：schema 声明 ${spec.types.join('|')}，实际 ${actual}`);
    }
    if (actual !== 'array' || !spec.items) continue;
    for (let i = 0; i < v.length; i++) {
      const et = jsonTypeOf(v[i]);
      if (!typeAllowed(et, spec.items)) {
        throw new Error(`字段 ${field} 第 ${i + 1} 项类型非法：schema 声明 ${spec.items.join('|')}，实际 ${et}`);
      }
    }
  }
}

// schema 声明了 enum 的字段，写入即校验取值——枚举清单只从 schema 读，本文件不另抄。
// 缺字段不在这里报（归必填检查）；值为 null 时只有 schema 的 enum 里列了 null 才放行
// （如 overrun_attr）。#891：phase/urgency/by 这类新枚举天然被这一条罩住。
function enumInvariant(enums, p) {
  for (const [field, allowed] of enums || []) {
    if (p[field] === undefined) continue;
    if (!allowed.includes(p[field])) {
      throw new Error(
        `字段 ${field} 取值非法 ${JSON.stringify(p[field])}；schema 允许 ${allowed.map(v => JSON.stringify(v)).join('/')}`,
      );
    }
  }
}

// schema 里声明了 minItems 的数组字段，写入即校验「是数组 + 够条数」。
// 下限只从 schema 读（不在本文件抄数字）：改 schema 的 minItems 就是改判据，
// 所以变异自证咬的是 schema 本身。声明 array 却给字符串必须拒——字符串也有 .length，
// 只比长度会让 evidence: "exit_code=0" 蒙过去（#891 evidence 统一成数组时的实咬点）。
function minItemsInvariant(mins, p) {
  for (const [field, min] of mins || []) {
    const v = p[field];
    if (v === undefined) continue; // 缺字段归必填检查
    if (!Array.isArray(v)) {
      throw new Error(`字段 ${field} 必须是数组（schema 声明 array，至少 ${min} 项），实际 ${typeof v}`);
    }
    if (v.length < min) {
      throw new Error(`字段 ${field} 至少 ${min} 项，实际 ${v.length} 项`);
    }
  }
}

// decision.pending 的跨字段不变量（#891）：推荐必须指向真实存在的选项，
// 否则飞书卡片与用户一键选择拿不到那条 option，账面看着齐、拍板面是死的。
// 空 options = 开放问题（问用户的工具允许不给选项，#897 实测），此时 recommend 必须是
// null——「没有选项可推荐」和「推荐了一个不存在的选项」得分开说。
function decisionInvariant(type, p) {
  if (type !== 'decision.pending') return;
  const opts = p.options;
  if (!Array.isArray(opts)) throw new Error(`decision.pending 的 options 必须是数组（实际 ${typeof opts}）`);
  if (opts.length === 1) throw new Error('decision.pending 的 options 只有一条（一个选项不叫拍板；开放问题写空数组）');
  const labels = opts.map(o => (o && typeof o === 'object' ? o.label : undefined));
  if (labels.some(l => typeof l !== 'string' || l.trim() === '')) {
    throw new Error('decision.pending 每条 option 必须有非空 label（用户看见并点的那句）');
  }
  if (opts.length === 0) {
    if (p.recommend != null) {
      throw new Error(`开放问题（options 空）不能有 recommend，实际 ${JSON.stringify(p.recommend)}`);
    }
    return;
  }
  if (p.recommend != null && !labels.includes(p.recommend)) {
    throw new Error(`recommend ${JSON.stringify(p.recommend)} 不在 options 的 label 里（${labels.join('/')}）；推荐指向不存在的选项，一键选择会失效`);
  }
}

function attrInvariant(type, p) {
  if (!type.startsWith('attr.') || type === 'attr.retract') return;
  const shares = ATTR_SHARE_KEYS.map(k => Number(p[k]) || 0);
  const allZero = shares.every(x => x === 0);
  const sum = shares.reduce((a, b) => a + b, 0);
  if (allZero) {
    // 四份额全 0 = 待定 unknown，唯一合法例外，须 confidence=low（设计 D.1）
    if ((p.confidence ?? 1) >= 0.8) {
      throw new Error(`unknown 归因（四份额全 0）必须 confidence < 0.8（低置信），实际 ${p.confidence}`);
    }
  } else if (Math.abs(sum - 1) > 1e-9) {
    throw new Error(`attr 责任向量份额和必须为 1，实际 ${sum.toFixed(4)}`);
  }
  if (p.confidence != null && (p.confidence < 0 || p.confidence > 1)) {
    throw new Error(`confidence 必须 0..1，实际 ${p.confidence}`);
  }
  if (p.overrun_attr != null && !OVERRUN_ATTRS.includes(p.overrun_attr)) {
    throw new Error(`overrun_attr 非法「${p.overrun_attr}」（允许 ${OVERRUN_ATTRS.join('/')}/null）`);
  }
}

/**
 * 构造事件对象（含 event_id）。payload 为类型专属字段；ts/machine/seq/type/schema_version 保留给调用方。
 */
export function buildEvent({ type, ts, machine, seq, payload = {}, schema }) {
  const meta = schemaMeta(schema);
  if (!meta.closedSet.includes(type)) {
    throw new Error(`未知事件类型「${type}」；闭集=${meta.closedSet.join('/')}`);
  }
  if (typeof ts !== 'string' || Number.isNaN(Date.parse(ts))) {
    throw new Error(`ts 必须是 ISO8601 带时区字符串，实际 ${JSON.stringify(ts)}`);
  }
  if (!Number.isInteger(seq) || seq < 0) throw new Error(`seq 必须是非负整数，实际 ${JSON.stringify(seq)}`);
  if (typeof machine !== 'string' || machine.length === 0) throw new Error('machine 必填');
  const clash = RESERVED.filter(k => payload[k] !== undefined);
  if (clash.length) throw new Error(`payload 含保留字段 ${clash.join(', ')}（由调用方传参）`);

  const missing = (meta.requiredByType.get(type) || []).filter(f => payload[f] === undefined);
  if (missing.length) throw new Error(`事件 ${type} 缺必填字段: ${missing.join(', ')}`);

  attrInvariant(type, payload);
  enumInvariant(meta.enumsByType.get(type), payload);
  typeInvariant(meta.typesByType.get(type), payload);
  minItemsInvariant(meta.minItemsByType.get(type), payload);
  decisionInvariant(type, payload);

  const raw = { type, schema_version: meta.currentVersion, ts, machine, seq, ...payload };
  const event_id = sha256Hex(canonicalStringify(raw));
  return { ...raw, event_id };
}

function scanEventId(dir, eventId) {
  if (!existsSync(dir)) return null;
  for (const [f, e] of dirIndex(dir)) {
    if (e && e.event_id === eventId) return f;
  }
  return null;
}

// 语义防重：每 job 一次性的事件类型（重放会重复计账），同 (type, job_id) 已存在即拒绝。
// job.meter（实时多次快照）与 job.handoff（可链式 A→B→C）不在名单内。
const ONE_PER_JOB = new Set(['job.opened', 'job.dispatch', 'job.closed', 'job.override', 'job.explore']);

function scanJobType(dir, type, jobId) {
  if (!existsSync(dir)) return null;
  for (const [f, e] of dirIndex(dir)) {
    if (e && e.type === type && e.job_id === jobId) return f;
  }
  return null;
}

/**
 * 写一事件一文件：<dir>/<ulid>-<machine>.json。
 * 三铁律守卫：①已存在同文件拒绝（写一次即不可变）；②同 event_id 已入账拒绝（防重复）。
 * 文件名确定性：熵取事件内容哈希（同一事件重跑得同一文件名，天然幂等报错）。
 */
export function writeEvent({ dir, type, ts, machine, seq, payload = {}, schema }) {
  const event = buildEvent({ type, ts, machine, seq, payload, schema });
  const entropyHex = sha256Hex(canonicalStringify(event)).slice(0, 20);
  const ulid = ulidFromMs(Date.parse(event.ts), entropyHex);
  const filename = `${ulid}-${machine}.json`;
  const path = join(dir, filename);
  if (existsSync(path)) {
    throw new Error(`事件文件已存在（写一次即不可变，纠错另立 attr.retract 不覆盖）: ${filename}`);
  }
  const dup = scanEventId(dir, event.event_id);
  if (dup) {
    throw new Error(`同内容事件已入账（event_id=${event.event_id}，已存在 ${dup}）；拒绝重复写入`);
  }
  // scope 追加（#591）可多次发生，不走「每 job 一条」；模型自选仍一人一次。
  const scopeAmend = event.type === 'job.override' && event.override_kind === 'scope';
  const jobDup = ONE_PER_JOB.has(event.type) && event.job_id && !scopeAmend
    ? scanJobType(dir, event.type, event.job_id)
    : null;
  if (jobDup) {
    throw new Error(`该 job 已有 ${event.type} 事件（${jobDup}）；每 job 一次，防重复计账——重复派单请另立 job_id`);
  }
  mkdirSync(dir, { recursive: true });
  // 原子写：先写同目录临时文件再 rename——进程中途崩溃留的是 .tmp 残件
  // （不以 .json 结尾，扫描器天然跳过），不会留半个 JSON 占事件位。
  // tmp 名带 pid+随机熵防同机并发撞名；rename 在同目录内是元数据操作。
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  writeFileSync(tmp, JSON.stringify(event, null, 2) + '\n', 'utf8');
  renameSync(tmp, path);
  dirIndex(dir).set(filename, event); // 登记进缓存，后续扫描不再重读
  return { path, event };
}

/** 本机下一个单调 seq（扫描该机器已有事件取最大 +1；无则 0） */
export function nextSeq(dir, machine) {
  let max = -1;
  if (existsSync(dir)) {
    for (const e of dirIndex(dir).values()) {
      if (e && e.machine === machine && typeof e.seq === 'number') max = Math.max(max, e.seq);
    }
  }
  return max + 1;
}
