// scripts/lib/event-writer.mjs —— 点将台事件写入辅助（设计 A.2 三铁律）
//
// 一事件一文件：ledger/events/<ulid>-<machine>.json；写一次即不可变（已存在/同内容均拒绝，
// 纠错另立 attr.retract 不覆盖历史）；文件名 ULID 时间序 + 机器名，git merge 等于求并集。
// 事件类型闭集与必填字段一律派生自 schemas/events.schema.json（唯一权威），不另抄清单。
// 写入即校验：类型在闭集内、必填字段齐、attr 责任向量不变量（份额和=1 或全 0 且低置信）。
// 确定性：同一 (type, ts, machine, seq, payload) 恒产出同一 event_id 与同一文件名。

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalStringify, sha256Hex } from './dianjiangtai-core.mjs';

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

/** 事件类型闭集 + 每类型必填字段（派生自 schema oneOf，闭集 = oneOf[].title）。 */
export function schemaMeta(schema) {
  const closedSet = [];
  const requiredByType = new Map();
  const resolveRef = ref => {
    const name = ref.replace('#/definitions/', '');
    return schema.definitions ? schema.definitions[name] : null;
  };
  const walk = (node, required) => {
    if (!node) return;
    if (node.$ref) return walk(resolveRef(node.$ref), required);
    if (Array.isArray(node.allOf)) for (const c of node.allOf) walk(c, required);
    if (Array.isArray(node.required)) {
      for (const f of node.required) if (!RESERVED.includes(f)) required.add(f);
    }
  };
  for (const def of schema.oneOf || []) {
    const title = def.title;
    if (!title) throw new Error('schema oneOf 条目缺 title（闭集派生依赖 title）');
    closedSet.push(title);
    const required = new Set();
    walk(def, required);
    requiredByType.set(title, [...required]);
  }
  return { closedSet, requiredByType, currentVersion: schema.version ?? 1 };
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

  const raw = { type, schema_version: meta.currentVersion, ts, machine, seq, ...payload };
  const event_id = sha256Hex(canonicalStringify(raw));
  return { ...raw, event_id };
}

function scanEventId(dir, eventId) {
  if (!existsSync(dir)) return null;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const e = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      if (e.event_id === eventId) return f;
    } catch { /* 损坏文件交给 audit 查，不阻断写入 */ }
  }
  return null;
}

// 语义防重：每 job 一次性的事件类型（重放会重复计账），同 (type, job_id) 已存在即拒绝。
// job.meter（实时多次快照）与 job.handoff（可链式 A→B→C）不在名单内。
const ONE_PER_JOB = new Set(['job.opened', 'job.dispatch', 'job.closed', 'job.override', 'job.explore']);

function scanJobType(dir, type, jobId) {
  if (!existsSync(dir)) return null;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const e = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      if (e.type === type && e.job_id === jobId) return f;
    } catch { /* 损坏文件交给 audit 查 */ }
  }
  return null;
}

/**
 * 写一事件一文件：ledger/events/<ulid>-<machine>.json。
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
  const jobDup = ONE_PER_JOB.has(event.type) && event.job_id ? scanJobType(dir, event.type, event.job_id) : null;
  if (jobDup) {
    throw new Error(`该 job 已有 ${event.type} 事件（${jobDup}）；每 job 一次，防重复计账——重复派单请另立 job_id`);
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(event, null, 2) + '\n', 'utf8');
  return { path, event };
}

/** 本机下一个单调 seq（扫描该机器已有事件取最大 +1；无则 0） */
export function nextSeq(dir, machine) {
  let max = -1;
  if (existsSync(dir)) {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const e = JSON.parse(readFileSync(join(dir, f), 'utf8'));
        if (e.machine === machine && typeof e.seq === 'number') max = Math.max(max, e.seq);
      } catch { /* 损坏文件交给 audit 查 */ }
    }
  }
  return max + 1;
}
