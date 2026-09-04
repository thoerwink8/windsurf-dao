// scripts/lib/event-writer.mjs —— 点将台事件写入辅助（设计 A.2 三铁律）
//
// 一事件一文件：<账本目录>/<ulid>-<machine>.json（默认落点本机 ~/.dao/ledger/events，
// 不进 git，见 ledger-home.mjs）；写一次即不可变（已存在/同内容均拒绝，
// 纠错另立 attr.retract 不覆盖历史）；文件名 ULID 时间序 + 机器名，汇聚等于求并集。
// 事件类型闭集与必填字段一律派生自 schemas/events.schema.json（唯一权威），不另抄清单。
// 写入即校验：类型在闭集内、必填字段齐、schema 声明的 enum 字段取值在闭集内、
// attr 责任向量不变量（份额和=1 或全 0 且低置信）、decision.pending 的 recommend 命中某条 option。
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

/** 事件类型闭集 + 每类型必填字段 + 每类型枚举字段（派生自 schema oneOf，闭集 = oneOf[].title）。 */
export function schemaMeta(schema) {
  const closedSet = [];
  const requiredByType = new Map();
  const enumsByType = new Map();
  const resolveRef = ref => {
    const name = ref.replace('#/definitions/', '');
    return schema.definitions ? schema.definitions[name] : null;
  };
  const walk = (node, required, enums) => {
    if (!node) return;
    if (node.$ref) return walk(resolveRef(node.$ref), required, enums);
    if (Array.isArray(node.allOf)) for (const c of node.allOf) walk(c, required, enums);
    if (Array.isArray(node.required)) {
      for (const f of node.required) if (!RESERVED.includes(f)) required.add(f);
    }
    for (const [f, spec] of Object.entries(node.properties || {})) {
      if (!RESERVED.includes(f) && Array.isArray(spec?.enum)) enums.set(f, spec.enum);
    }
  };
  for (const def of schema.oneOf || []) {
    const title = def.title;
    if (!title) throw new Error('schema oneOf 条目缺 title（闭集派生依赖 title）');
    closedSet.push(title);
    const required = new Set();
    const enums = new Map();
    walk(def, required, enums);
    requiredByType.set(title, [...required]);
    enumsByType.set(title, enums);
  }
  return { closedSet, requiredByType, enumsByType, currentVersion: schema.version ?? 1 };
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
