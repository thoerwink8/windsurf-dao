// Contabo → MiraQuota 多机页采样器的纯判官（#881）。
//
// 归属：`machine/<id>` 分支约定在 miraquota-win（provider/lib/ledger-sync.mjs），
// 本仓零实现。本文件只做两件事——把 mirasim-server ws getRelay 的 usage windows
// 收成那边已经在跑的分片形状，以及读 sync.json 的 remote（没有就用那边的
// DEFAULT_REMOTE）。systemd / 装机脚本是 Contabo 这台机器的事，落本仓。
//
// 格式来源（两条都走了，不是手写常量）：
//   1. miraquota-win provider/lib/ledger.mjs exportShard + ledger-sync.mjs #shardLimits
//   2. 远端账本仓实物：machine/c02957cxy、machine/vmi3551059 的 shard.json
// getRelay 形状来自 2026-09-06 Contabo 真机：{type:'relay', relay:{usage:{ok,windows,…}}}
//
// 仓外落点（登记在 host/machine/INDEX.md）：
//   ~/.miraquota/sync.json            —— 账本仓地址；Contabo 上经常没有，退 DEFAULT_REMOTE
//   ~/.miraquota/contabo-install.json —— 本采样器自己的 installId，不跟 hostname 那行共用
//   ~/.miraquota/contabo-sync-repo    —— 覆盖式发布用的本地 git 工作目录
//
// 分层：下面全是纯函数，只吃入参不碰 IO / 网络。连线与 git 推送在
// scripts/miraquota-contabo-sync.mjs，自己查自己查不出错。

/** 与 miraquota-win provider/lib/ledger-sync.mjs 同一行，禁止另造第二份地址。 */
export const DEFAULT_REMOTE = 'https://github.com/thoerwink8/miraquota-ledger.git';

/** issue #881 验收钉死的分支名：machine/contabo。不是 os.hostname()（那是 vmi3551059）。 */
export const MACHINE_ID = 'contabo';

/** 与 miraquota-win CostLedger.RETENTION 同一数字：覆盖 7d 窗口并留余量。 */
export const RETENTION_SEC = 8 * 86400;

export const SHARD_SCHEMA = 1;

const INSTALL_ID_RE = /^[a-f0-9]{8,32}$/;

/**
 * 时间收到 unix 秒。getRelay 的 resetAt / capturedAt 是 ISO 字符串；
 * miraquota-win /v1/limits 路径是数字，偶发毫秒。两种都收，收不成回 null。
 */
export function toUnixSeconds(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1e11 ? value / 1000 : value;
  }
  if (typeof value === 'string' && value.trim()) {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms / 1000 : null;
  }
  return null;
}

function finiteNumber(v) {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

/**
 * 从 getRelay 真机帧取出 usage。形状不对返回 {ok:false, unscanned, errors}，
 * 不猜、不填默认窗口——猜错的额度会印在多机页上。
 */
export function parseRelayUsage(frame) {
  if (!frame || typeof frame !== 'object') {
    return { ok: false, unscanned: true, errors: ['没收到 relay 帧（没查成）'], usage: null };
  }
  if (frame.type === 'error') {
    return {
      ok: false,
      unscanned: false,
      errors: [`服务端拒了 getRelay：${frame.message || '（没给原因）'}`],
      usage: null,
    };
  }
  const relay = frame.type === 'relay' ? frame.relay
    : frame.payload?.type === 'relay' ? frame.payload.relay
    : null;
  if (!relay || typeof relay !== 'object') {
    return {
      ok: false,
      unscanned: true,
      errors: [`不是 relay 帧：type=${JSON.stringify(frame.type)}`],
      usage: null,
    };
  }
  const usage = relay.usage;
  if (!usage || typeof usage !== 'object') {
    return { ok: false, unscanned: true, errors: ['relay 帧没有 usage（没查成）'], usage: null };
  }
  if (usage.ok !== true) {
    return {
      ok: false,
      unscanned: false,
      errors: [`usage.ok 不是 true（status=${JSON.stringify(usage.status)} error=${JSON.stringify(usage.error)}）`],
      usage,
    };
  }
  if (!Array.isArray(usage.windows) || usage.windows.length === 0) {
    return { ok: false, unscanned: false, errors: ['usage.windows 是空的，没有可对齐的额度窗口'], usage };
  }
  return { ok: true, unscanned: false, errors: [], usage };
}

/**
 * usage.windows → 分片 limits.windows。字段名对齐 miraquota-win Engine#shardLimits
 * （label / used / budget / resetAt / 可选 modelScoped），多出来的 usedPercent 等丢掉——
 * 老客户端读到不认识的键会忽略，但我们按那边已发布的形状写，不另发明。
 */
export function windowsToLimits(windows) {
  const out = [];
  const errors = [];
  for (const [i, w] of (Array.isArray(windows) ? windows : []).entries()) {
    const label = typeof w?.label === 'string' && w.label ? w.label
      : typeof w?.name === 'string' && w.name ? w.name
      : null;
    const used = finiteNumber(w?.used);
    const budget = finiteNumber(w?.budget);
    const resetAt = toUnixSeconds(w?.resetAt ?? w?.reset_at);
    if (!label || used == null || budget == null || budget <= 0 || resetAt == null) {
      errors.push(`windows[${i}] 缺 label/used/budget/resetAt`);
      continue;
    }
    const row = { label, used, budget, resetAt };
    if (w.modelScoped === true || w.model_scoped === true) row.modelScoped = true;
    out.push(row);
  }
  return { windows: out, errors };
}

/**
 * 组装分片上的 limits 块（v0.9.28 起的可选字段，schemaVersion 仍是 1）。
 * capturedAt 是读到那一刻的 unix 秒，不是发分片那一刻——对面据此判龄期。
 */
export function buildLimitsBlock(usage, { nowSec } = {}) {
  const parsed = windowsToLimits(usage?.windows);
  if (!parsed.windows.length) {
    return { ok: false, errors: parsed.errors.length ? parsed.errors : ['没有可写进 limits 的窗口'], limits: null };
  }
  const capturedAt = toUnixSeconds(usage?.capturedAt) ?? (typeof nowSec === 'number' ? nowSec : null);
  if (capturedAt == null) {
    return { ok: false, errors: ['usage.capturedAt 收不成 unix 秒，且没给 nowSec'], limits: null };
  }
  return {
    ok: true,
    errors: parsed.errors,
    limits: { capturedAt, windows: parsed.windows },
  };
}

export function isInstallId(v) {
  return typeof v === 'string' && INSTALL_ID_RE.test(v);
}

/**
 * 读 sync.json 只拿 git remote。文件不在 / 坏 JSON / 没 remote → 用 DEFAULT_REMOTE。
 * hub / inbox 通道本采样器不走——issue 钉死推 machine/contabo 分支，那是 git 通道的语义。
 */
export function loadSyncRemote(config) {
  if (!config || typeof config !== 'object') {
    return { remote: DEFAULT_REMOTE, from: 'default', why: '没有 sync.json，用 miraquota-win 的 DEFAULT_REMOTE' };
  }
  if (typeof config.remote === 'string' && config.remote.trim()) {
    return { remote: config.remote.trim(), from: 'sync.json', why: null };
  }
  return { remote: DEFAULT_REMOTE, from: 'default', why: 'sync.json 没有 remote，用 miraquota-win 的 DEFAULT_REMOTE' };
}

/**
 * 拼 schemaVersion 1 分片。buckets/scoped/family/unpriced 是契约必填的「键→数」对象；
 * getRelay 给的是账号级窗口点数，不是本机流水，所以账本四件套保持空对象——
 * 填进账号总额会把整池额度算到 contabo 头上，多机页「谁花的」会撒谎。
 * 额度数走 limits（与 getRelay 窗口 used/budget 逐字对齐，验收对的就是这一列）。
 */
export function buildShard({
  machineId = MACHINE_ID,
  installId,
  generatedAt,
  limits,
  coverage,
} = {}) {
  const errors = [];
  if (typeof machineId !== 'string' || !machineId) errors.push('缺 machineId');
  if (!isInstallId(installId)) errors.push('installId 要是 8–32 位十六进制');
  if (typeof generatedAt !== 'number' || !Number.isFinite(generatedAt)) errors.push('缺 generatedAt');
  if (!limits?.windows?.length) errors.push('缺 limits.windows');
  if (errors.length) return { ok: false, errors, shard: null };
  const fromSec = coverage?.fromSec ?? generatedAt - RETENTION_SEC;
  const toSec = coverage?.toSec ?? generatedAt;
  return {
    ok: true,
    errors: [],
    shard: {
      schemaVersion: SHARD_SCHEMA,
      machineId,
      installId,
      generatedAt,
      coverage: { fromSec, toSec },
      buckets: {},
      scoped: {},
      family: {},
      unpriced: {},
      limits,
    },
  };
}

/**
 * 对照实物分片 + miraquota-win validateShard 能收的那几格（git 通道不分 account）。
 * 返回 null 表示通过，否则一句人话原因——跟 inbox/shared.mjs 同一习惯。
 */
export function validateContaboShard(shard) {
  if (!shard || typeof shard !== 'object') return '不是 JSON 对象';
  if (shard.schemaVersion !== SHARD_SCHEMA) return `schemaVersion 只认 ${SHARD_SCHEMA}`;
  if (typeof shard.machineId !== 'string' || !shard.machineId) return '缺 machineId';
  if (!isInstallId(shard.installId)) return 'installId 要是 8–32 位十六进制';
  if (typeof shard.generatedAt !== 'number') return '缺 generatedAt';
  if (!shard.coverage || typeof shard.coverage.fromSec !== 'number' || typeof shard.coverage.toSec !== 'number') {
    return '缺 coverage';
  }
  const numMap = (o) => o != null && typeof o === 'object' && !Array.isArray(o)
    && Object.values(o).every((v) => typeof v === 'number' && Number.isFinite(v));
  for (const k of ['buckets', 'scoped', 'family', 'unpriced']) {
    if (!numMap(shard[k])) return `${k} 不是「键→数」`;
  }
  if (!shard.limits || typeof shard.limits.capturedAt !== 'number') return '缺 limits.capturedAt';
  if (!Array.isArray(shard.limits.windows) || shard.limits.windows.length === 0) return '缺 limits.windows';
  for (const [i, w] of shard.limits.windows.entries()) {
    if (typeof w?.label !== 'string' || !w.label) return `limits.windows[${i}] 缺 label`;
    if (typeof w.used !== 'number' || typeof w.budget !== 'number' || typeof w.resetAt !== 'number') {
      return `limits.windows[${i}] 缺 used/budget/resetAt`;
    }
  }
  return null;
}

/** 从 getRelay 帧一次走到可发布的分片。任何一格不行都 ok:false，不许半成品出门。 */
export function shardFromRelay(frame, { machineId = MACHINE_ID, installId, generatedAt } = {}) {
  const parsed = parseRelayUsage(frame);
  if (!parsed.ok) return { ok: false, unscanned: parsed.unscanned, errors: parsed.errors, shard: null };
  const nowSec = typeof generatedAt === 'number' ? generatedAt : Date.now() / 1000;
  const lim = buildLimitsBlock(parsed.usage, { nowSec });
  if (!lim.ok) return { ok: false, unscanned: false, errors: lim.errors, shard: null };
  const built = buildShard({ machineId, installId, generatedAt: nowSec, limits: lim.limits });
  if (!built.ok) return { ok: false, unscanned: false, errors: built.errors, shard: null };
  const why = validateContaboShard(built.shard);
  if (why) return { ok: false, unscanned: false, errors: [why], shard: null };
  return { ok: true, unscanned: false, errors: [], shard: built.shard };
}
