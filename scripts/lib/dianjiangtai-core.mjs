// scripts/lib/dianjiangtai-core.mjs —— 点将台选型核心（纯函数）
//
// 规格：docs/dianjiangtai-design.md（#450 设计冻结版）A–E 节；上位拍板 issue #438。
// 硬约束（设计「硬约束对照」1/11）：在线选型毫秒级确定性、零 LLM。
// 本模块是纯函数：无文件 I/O、无 Date.now、无 Math.random，时间由调用方传入 ts；
// 同一 (ts, events, policies, inputs) 恒产出同一结果与同一 decision_id（E.1 决策票可复算）。
//
// 边界（任务书）：只做选型 + 账本，不做流转——「何时派单」归 issue #455 流转器；
// 本模块输出三选项 JSON，接口对齐即可被流转器调用。
//
// 特征归宿（F1–F18，设计「特征归宿总表」）：
//   门闩：F1 禁令 / F14 上下文 / F15 可用性 —— 剔除不进分
//   进 Score：F2 μ_shrunk、F3 n_eff（间接）、F4 σ_shrunk、F5 收缩锚点（间接）、
//             F6 w_time、F7 base_p/w_version、F9 P、F10 cost_util、F11/F12 进成本预估
//   不进 Score：F8 缺口（C.3 配额覆盖）、F16 配额（成本预估 + handoff 触发）、
//              F17 浪费（有界修正 cost_util）、F18 摊销（进成本）
//   F13 速度：仅进月报呈现，不进选型分（设计明示）

import { createHash } from 'node:crypto';
import { buildSlate } from './next-launch.mjs';

export { buildSlate } from './next-launch.mjs';

export const IDENTITIES = ['帅', '协调者', '工人', '审官'];

// 北京峰时窗口（与 model-routing.toml / policy/models.yml 的 peak_windows_beijing 同口径）
export const DEFAULT_PEAK_WINDOWS = ['09:00-12:00', '14:00-18:00'];

// 无计量历史时的 token 画像初值（确定性常数；有任务预算则 tIn=预算、tOut=预算×输出比）
export const DEFAULT_TOKEN_PROFILE = { tIn: 20000, tOut: 5000 };
export const DEFAULT_OUT_RATIO = 0.25;

// ── 确定性哈希 / 稳定序列化 ──────────────────────────────────────────

export function canonicalStringify(value) {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalStringify).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalStringify(value[k])).join(',') + '}';
}

export function sha256Hex(s) {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

export function hashOf(value) {
  return sha256Hex(canonicalStringify(value));
}

// ── 时间（纯）────────────────────────────────────────────────────────

export function parseTs(ts) {
  if (typeof ts === 'number') return new Date(ts);
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) throw new Error(`非法 ts: ${JSON.stringify(ts)}`);
  return d;
}

export function tsMs(ts) {
  return parseTs(ts).getTime();
}

export function daysBetweenMs(aMs, bMs) {
  return (bMs - aMs) / 86400000;
}

/** 北京时间墙钟分钟（UTC+8，无夏令时） */
export function beijingMinutes(ts) {
  const bj = new Date(tsMs(ts) + 8 * 3600000);
  return bj.getUTCHours() * 60 + bj.getUTCMinutes();
}

/** "HH:MM-HH:MM" → [startMin, endMin) */
export function parseWindow(s) {
  const [a, b] = s.trim().split('-');
  const hm = x => {
    const [h, m] = x.split(':').map(Number);
    return h * 60 + m;
  };
  return [hm(a), hm(b)];
}

export function isInWindows(minute, windows) {
  return windows.some(([a, b]) => minute >= a && minute < b);
}

/**
 * 匹配 model-routing.toml [[routes]] 的分时路由。
 * beijing 字段是 "HH:MM-HH:MM,..." 逗号列表（与 dao-check validBeijingWindows 同口径）。
 * 命中第一条 role + 北京墙钟窗口的路由；无命中返回 null。纯函数，禁 Date.now。
 */
export function matchBeijingRoute(routes, workType, ts) {
  if (!Array.isArray(routes) || routes.length === 0 || !workType) return null;
  const minute = beijingMinutes(ts);
  for (const r of routes) {
    if (!r || r.role !== workType || !r.beijing) continue;
    const windows = String(r.beijing).split(',').map(s => parseWindow(s.trim()));
    if (isInWindows(minute, windows)) return r;
  }
  return null;
}

/** 全序排序键 (ts, machine, seq, event_id) 字典序（设计 A.2） */
export function EVENT_ORDER_KEY(a, b) {
  const ka = [a.ts, a.machine, a.seq ?? 0, a.event_id ?? ''].join('\u0000');
  const kb = [b.ts, b.machine, b.seq ?? 0, b.event_id ?? ''].join('\u0000');
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

// ── 事件 → 样本（重放，设计 D.1 三本账）────────────────────────────────

// 样本 = 能力账的输入：y=1 正样本（成功合并，L0 直记）、y=0 负样本（失败且 model_share>0）。
// 四份额全 0（unknown）不进净指标；env_share 整单不入能力账；钱（usd_cash）永远立记不在此。
export function buildSamples({ events, at, registryByModel }) {
  const samples = [];
  const overrides = [];   // job.override → F9 P（job.explore 不计入 P，故不收集）
  const metersByCell = new Map();
  const cellKey = (m, i, w) => `${m}\u0000${i}\u0000${w}`;

  const atMs = tsMs(at);
  // 红3 修法首选：复算按选型时刻截断——event.ts > at 的未来事件不参与重放。
  // 否则 w_time = 0.5^(Δt/30天) 在 Δt 为负时 > 1，未来样本会把当前格权重大于 1
  // （设计 F6 新鲜度只对过去样本衰减；E.1 决策票可复算要求「当时的输入就是当时的账」）。
  const cutoffEvents = events.filter(e => tsMs(e.ts) <= atMs);

  const retracted = new Set(
    cutoffEvents.filter(e => e.type === 'attr.retract').map(e => e.target_event_id).filter(Boolean),
  );

  const byJob = new Map();
  for (const e of cutoffEvents) {
    if (e.type === 'job.override' && e.job_id && e.override_kind !== 'scope') {
      overrides.push({ model: e.model, identity: e.identity, workType: e.work_type, tsMs: tsMs(e.ts), jobId: e.job_id });
    }
    if (e.job_id) {
      if (!byJob.has(e.job_id)) byJob.set(e.job_id, []);
      byJob.get(e.job_id).push(e);
    }
  }

  // job.meter 不带 identity/work_type（schema 无此必填），格归属由该 job 的派单解析——
  // 否则 F11/F12（缓存 EWMA、token 画像）永远取不到计量（静默失效）。
  const metersByJob = new Map();
  for (const e of cutoffEvents) {
    if (e.type === 'job.meter' && e.job_id && e.model) {
      if (!metersByJob.has(e.job_id)) metersByJob.set(e.job_id, []);
      metersByJob.get(e.job_id).push(e);
    }
  }

  for (const [jobId, evts] of byJob) {
    const opened = evts.find(e => e.type === 'job.opened');
    const dispatch = evts.find(e => e.type === 'job.dispatch');
    const closed = evts.find(e => e.type === 'job.closed');
    if (!dispatch || !closed) continue; // 未派/未结：悬单无样本（留给审计 E.3）
    const identity = dispatch.identity || opened?.identity || null;
    const workType = dispatch.work_type || opened?.work_type || null;
    const version = dispatch.model_version || 'unknown';

    // 该 job 的计量归到其 (m,i,w) 格（F11/F12 数据源）
    if (identity && workType) {
      const k = cellKey(dispatch.model, identity, workType);
      if (!metersByCell.has(k)) metersByCell.set(k, []);
      for (const m of metersByJob.get(jobId) || []) metersByCell.get(k).push(m);
    }

    if (closed.success) {
      // 成功合并 → 能力账正样本，记给最终合并作者（handoff 后是接手者）
      const model = closed.merged_by || dispatch.model;
      if (!model || !identity || !workType) continue;
      const reg = registryByModel[model];
      // 红4 修法首选：接手成功（merged_by !== dispatch.model）时，正样本版本取接手者
      // 当前 registry.version——否则拿源模型 version 比接手者 registry 恒为异版本，
      // 正样本只进 base_p、接手者当前格永远收不到（D.1「成功合并记给最终合并作者」落空）。
      const sampleVersion = model === dispatch.model
        ? version
        : (registryByModel[model]?.version ?? 'unknown');
      const wVersion = reg?.version && sampleVersion === reg.version ? 1 : 0;
      const sampleTs = tsMs(closed.ts);
      samples.push({
        model, identity, workType, y: 1, tsMs: sampleTs, conf: 1,
        wVersion, wTime: 0.5 ** (Math.max(0, daysBetweenMs(sampleTs, atMs)) / 30), share: 1,
        jobId, eventId: closed.event_id,
      });
      continue;
    }

    // 失败：等归因（D.1 钱立刻记，能力债等归因）。取最后一个未被 retract 的有效归因
    // （L0→L1→L2→L3 链的终态；attr.retract 指向的当作没发生，净特征从零算，D.3）。
    const attrs = evts
      .filter(e => e.type.startsWith('attr.') && e.type !== 'attr.retract')
      .filter(e => !retracted.has(e.event_id))
      .sort(EVENT_ORDER_KEY);
    const attr = attrs[attrs.length - 1];
    if (!attr) continue; // 未归因失败：不进能力账（宁可少学不可乱罚）
    const ms = attr.model_share || 0;
    if (!(ms > 0)) continue; // unknown（四份额全 0）或责任不在模型 → 无能力负样本
    const model = attr.model || dispatch.model; // L0 规则 6/7 换模型场景指向源模型
    const reg = registryByModel[model];
    const wVersion = reg?.version && (model === dispatch.model ? version : 'unknown') === reg.version ? 1 : 0;
    const sampleTs = tsMs(attr.ts);
    samples.push({
      model, identity, workType, y: 0, tsMs: sampleTs,
      conf: attr.confidence ?? 1,
      wVersion, wTime: 0.5 ** (Math.max(0, daysBetweenMs(sampleTs, atMs)) / 30), share: ms,
      jobId, eventId: attr.event_id,
    });
  }

  return { samples, overrides, metersByCell, byJob };
}

// ── Beta 后验（设计 C.1）──────────────────────────────────────────────

function cellStats(samples, p0, k0) {
  const a0 = p0 * k0;
  const b0 = (1 - p0) * k0;
  let sw = 0;
  let sy = 0;
  for (const s of samples) {
    const w = s.wVersion * s.wTime * s.conf * (s.share ?? 1);
    sw += w;
    if (s.y) sy += w;
  }
  const aEff = a0 + sy;
  const bEff = b0 + (sw - sy);
  const total = aEff + bEff;
  const muRaw = total > 0 ? aEff / total : p0;
  const sigmaRaw = total > 0 ? Math.sqrt((aEff * bEff) / (total * total * (total + 1))) : 0;
  return { aEff, bEff, muRaw, sigmaRaw, nEff: sw };
}

function wsum(arr) {
  return arr.reduce((a, s) => a + s.wVersion * s.wTime * s.conf * (s.share ?? 1), 0);
}
function wy(arr) {
  return arr.reduce((a, s) => a + (s.y ? s.wVersion * s.wTime * s.conf * (s.share ?? 1) : 0), 0);
}

// 单个 (m,i,w) 格特征（F2–F9 + 收缩链 + 缺口）。红4 退化规则逐条写死（冷启动不出 NaN）：
//   ① μ_global 样本集合为空 → 0.5
//   ② n_model = 0 → Q_parent = μ_global（公式 (0·μ_model+k·μ_global)/(0+k) 自然给出）
//   ③ σ_parent 加权集合为空 → 当前格先验 σ = √(α0·β0/((α0+β0)²·(α0+β0+1)))
export function computeModelFeature({ model, identity, workType, samples, overrides, at, weights }) {
  const k = weights.shrinkage?.k ?? 4;
  const k0 = weights.shrinkage?.k0 ?? 2;
  const fallback = weights.shrinkage?.prior_center_fallback ?? 0.5;
  const atMs = tsMs(at);
  const isCell = s => s.model === model && s.identity === identity && s.workType === workType;

  const cellSamples = samples.filter(s => isCell(s) && s.wVersion > 0);
  const modelOther = samples.filter(s => s.model === model && !isCell(s) && s.wVersion > 0);
  const baseSamples = samples.filter(s => s.model === model && s.wVersion === 0);
  const globalSamples = samples.filter(s => !isCell(s));

  // F7 版本折扣：异版本样本只进 base_p（先验中心），不进当前格。
  // base_p(m) = Σ_{旧版本样本} w_time·y / Σ_{旧版本样本} w_time（设计原文：无 w_version 因子）
  const baseSum = baseSamples.reduce((a, s) => a + s.wTime * s.conf * (s.share ?? 1), 0);
  const baseY = baseSamples.reduce((a, s) => a + (s.y ? s.wTime * s.conf * (s.share ?? 1) : 0), 0);
  const baseP = baseSum > 0 ? baseY / baseSum : fallback;

  const p0 = baseP;
  const a0 = p0 * k0;
  const b0 = (1 - p0) * k0;

  const cell = cellStats(cellSamples, p0, k0);

  // 父级聚合（排除当前格，避免重复计权；父级样本权同用完整 w_sample）
  const muModel = wsum(modelOther) > 0 ? wy(modelOther) / wsum(modelOther) : null;
  const nModel = wsum(modelOther);

  // 红4 ①：全局样本集合为空 → 0.5
  const muGlobal = wsum(globalSamples) > 0 ? wy(globalSamples) / wsum(globalSamples) : fallback;

  // σ_parent：该模型当前版本、除当前格外各格 σ_raw 按 n_eff 加权平均
  const otherCells = new Map();
  for (const s of modelOther) {
    const key = `${s.identity}\u0000${s.workType}`;
    if (!otherCells.has(key)) otherCells.set(key, []);
    otherCells.get(key).push(s);
  }
  let spNum = 0;
  let spDen = 0;
  for (const cellS of otherCells.values()) {
    const cs = cellStats(cellS, p0, k0);
    spNum += cs.nEff * cs.sigmaRaw;
    spDen += cs.nEff;
  }
  // 红4 ③：σ_parent 加权集合为空 → 当前格先验 σ（α0=β0=1 时 = √(1/12) ≈ 0.289）
  const priorSigma = Math.sqrt((a0 * b0) / ((a0 + b0) ** 2 * (a0 + b0 + 1)));
  const sigmaParent = spDen > 0 ? spNum / spDen : priorSigma;

  // 红4 ②：n_model=0 → Q_parent = μ_global
  const QParent = nModel <= 0 ? muGlobal : (nModel * muModel + k * muGlobal) / (nModel + k);

  // 层级收缩（k=4，Claude 臂形态）
  const muShrunk = (cell.nEff * cell.muRaw + k * QParent) / (cell.nEff + k);
  const sigmaShrunk = (cell.nEff * cell.sigmaRaw + k * sigmaParent) / (cell.nEff + k);

  // F9 用户偏好：P = Σ(job.override)·0.5^(Δt/60天)；job.explore 不计入
  // （Δt 夹紧 ≥0：红3 双保险，未来 override 直接由 buildSamples 截断丢弃，不靠夹紧收编）
  const P = overrides
    .filter(o => o.model === model && o.identity === identity && o.workType === workType)
    .reduce((a, o) => a + 0.5 ** (Math.max(0, daysBetweenMs(o.tsMs, atMs)) / 60), 0);

  // F8 探索缺口：每格保底 + 新模型全局保底（进 C.3 配额覆盖，不进 Score）
  const nEff = cell.nEff;
  const nGlobal = samples.filter(s => s.model === model).reduce((a, s) => a + s.wVersion * s.wTime * s.conf * (s.share ?? 1), 0);
  const perCellFloor = weights.explore?.per_cell_floor ?? 3;
  const globalFloor = weights.explore?.new_model_global_floor ?? 5;
  const shortfall = Math.max(0, perCellFloor - nEff);
  const globalShortfall = Math.max(0, globalFloor - nGlobal);

  return {
    baseP, p0, a0, b0,
    aEff: cell.aEff, bEff: cell.bEff,
    muRaw: cell.muRaw, sigmaRaw: cell.sigmaRaw, nEff,
    muModel, nModel, muGlobal, sigmaParent, priorSigma, QParent,
    muShrunk, sigmaShrunk, P,
    shortfall, globalShortfall, nGlobal,
  };
}

// ── 成本特征（F10/F11/F12/F16/F18，设计 B.2）───────────────────────────

function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function computeCost({ model, taskTokens, meters, at }) {
  const pricing = model.pricing;
  if (!pricing || !pricing.verified_at) {
    return { c: null, note: '价目待补（pricing.verified_at=null）', currency: null, metered: null, alloc: null, tIn: null, tOut: null, h: null, rates: null };
  }

  // F12 token 画像：历史中位数（抗离群）；无历史用任务预算，再无则用确定性初值
  const tIn = taskTokens ?? median((meters || []).map(m => m.token_in)) ?? DEFAULT_TOKEN_PROFILE.tIn;
  const tOut = median((meters || []).map(m => m.token_out))
    ?? (taskTokens != null ? Math.round(taskTokens * DEFAULT_OUT_RATIO) : DEFAULT_TOKEN_PROFILE.tOut);

  // F11 缓存命中率 EWMA：h ← 0.9·h + 0.1·(cache/(prompt+cache))
  let h = 0;
  for (const m of [...(meters || [])].sort(EVENT_ORDER_KEY)) {
    const denom = (m.cache_hit || 0) + (m.token_in || 0);
    const ratio = denom > 0 ? (m.cache_hit || 0) / denom : 0;
    h = 0.9 * h + 0.1 * ratio;
  }

  const unit = pricing.unit ? (pricing.unit.includes('元') ? 'CNY' : 'USD') : null;
  let metered = 0;
  if (pricing.metered) {
    const minute = beijingMinutes(at);
    const windows = (pricing.metered.peak_windows_beijing || DEFAULT_PEAK_WINDOWS).map(parseWindow);
    const peak = isInWindows(minute, windows);
    const rates = peak ? pricing.metered.peak : pricing.metered.valley;
    metered = (tIn / 1e6) * rates.cache_hit * h
      + (tIn / 1e6) * rates.cache_miss * (1 - h)
      + (tOut / 1e6) * rates.output
      + (pricing.fixed_fee || 0);
  }

  // F18 摊销：月费 × usage_unit / forecast_total（骨架：月费未核 → 用已拍板的边际成本；
  // 月费已核 → amortized_per_mtok = 月费 / included_tokens × 1e6，alloc = usage × amortized_per_mtok）
  let alloc = 0;
  let allocNote = null;
  if (pricing.subscription) {
    const sub = pricing.subscription;
    if (sub.monthly_fee != null && sub.included_tokens) {
      const amortizedPerMtok = (sub.monthly_fee / sub.included_tokens) * 1e6;
      alloc = ((tIn + tOut) / 1e6) * amortizedPerMtok;
      allocNote = `摊销 ${alloc.toFixed(4)}（月费${sub.monthly_fee}/含${sub.included_tokens}）`;
    } else {
      alloc = sub.marginal_cost ?? 0;
      allocNote = '摊销待补（月费/包含额度未核），按已拍板边际成本计';
    }
  }

  const c = metered + alloc;
  const note = allocNote || (pricing.metered ? null : '无按量价目');
  return { c, note, currency: unit, metered, alloc, tIn, tOut, h };
}

// ── 门闩（F1/F14/F15，先于评分；成本不做门闩）───────────────────────────

export function checkGates({ model, identity, workType, bans, taskTokens, availability }) {
  const reasons = [];
  // F1 硬禁令：命中 (m,w) 或 (m,*) 即禁（bans.yml，仅用户可写）
  const banned = (bans || []).some(b =>
    (b.models || []).includes(model.id)
    && (!b.work_types || b.work_types.length === 0 || b.work_types.includes(workType))
    && (!b.identities || b.identities.length === 0 || b.identities.includes(identity)),
  );
  if (banned) reasons.push('ban');
  // F14 上下文适配：任务预算 token > 模型窗口 → 放不下（窗口待补 = 不拦，输出注明）
  if (taskTokens != null && model.context_window != null && taskTokens > model.context_window) {
    reasons.push(`context_insufficient(task=${taskTokens} > window=${model.context_window})`);
  }
  // F15 可用性：心跳/厂商故障（门闩；调用方传入，缺省空闲）
  const avail = availability?.[model.id] ?? '空闲';
  if (avail !== '空闲') reasons.push(`availability:${avail}`);
  return { rejected: reasons.length > 0, reasons, availability: avail };
}

// ── 选型主入口 ─────────────────────────────────────────────────────────

/**
 * @param {object} args
 * @param {string} args.ts 选型时刻（ISO8601 带时区）——由调用方传入，禁 Date.now
 * @param {string} args.jobId 任务卡 id（C.3 稳定哈希轮序用）
 * @param {string} args.identity 帅/协调者/工人/审官
 * @param {string} args.workType 写码/判断/查证/审查/UI/…（可增枚举）
 * @param {number|null} args.taskTokens 任务预算 token（F14/F10）
 * @param {string} args.risk 低/中/高（C.3 配额覆盖仅低风险）
 * @param {boolean} args.reversible 可逆/可沙箱（C.3 让路条件）
 * @param {object[]} args.events 事件流（ledger/events 解析后的数组）
 * @param {object[]} args.models policy/models.yml 解析结果
 * @param {object[]} args.bans policy/bans.yml 解析结果
 * @param {object} args.weights policy/weights.yml 解析结果
 * @param {object} [args.availability] 模型 → 空闲/忙/离线
 * @param {object} [args.usageByModel] F17 套餐用量：modelId → { days_to_reset, utilization }
 * @param {string|null} [args.policyHash] 政策内容哈希（决策票可复算依据）
 * @param {object[]} [args.routes] model-routing.toml [[routes]]（分时路由，参与 A 推荐）
 */
export function select({
  ts, jobId, identity, workType,
  taskTokens = null, risk = '低', reversible = true,
  events = [], models = [], bans = [], weights = {},
  availability = {}, usageByModel = {}, policyHash = null,
  routes = [],
}) {
  if (!IDENTITIES.includes(identity)) {
    throw new Error(`未知身份「${identity}」（允许 ${IDENTITIES.join('/')}）`);
  }
  if (!workType) throw new Error('work_type 必填');
  const at = tsMs(ts);

  // 红3 修法首选：只纳入 event.ts <= 选型 ts 的事件——未来事件不入重放也不入决策票快照。
  // 否则账一增长（CLI 读当前全账），同一 --ts/--job-id/政策复算 decision_id 就变，
  // 旧票不可按当时输入核对（E.1「任何人可重跑同一确定性函数」落空）。
  const cutoffEvents = events.filter(e => tsMs(e.ts) <= at);

  const registryByModel = Object.fromEntries(models.map(m => [m.id, m]));
  const { samples, overrides, metersByCell } = buildSamples({ events: cutoffEvents, at, registryByModel });
  const cellKey = (m, i, w) => `${m}\u0000${i}\u0000${w}`;

  // 逐模型：门闩 + 特征 + 成本（门闩不进分；被剔模型仍在输出里标注拒因）
  const details = {};
  for (const model of models) {
    const gates = checkGates({ model, identity, workType, bans, taskTokens, availability });
    const features = computeModelFeature({
      model: model.id, identity, workType, samples, overrides, at, weights,
    });
    const cost = computeCost({
      model, taskTokens,
      meters: metersByCell.get(cellKey(model.id, identity, workType)) || [],
      at,
    });
    details[model.id] = { model: model.id, gates, features, cost };
  }

  const passers = Object.values(details).filter(d => !d.gates.rejected);

  // cost_util：候选集内 log1p min-max，有界 [0,1]；max==min → 0.5；价目待补 → 中立 0.5
  let minLog = null;
  let maxLog = null;
  for (const d of passers) {
    if (d.cost.c == null) continue;
    const l = Math.log1p(d.cost.c);
    if (minLog === null || l < minLog) minLog = l;
    if (maxLog === null || l > maxLog) maxLog = l;
  }
  for (const d of passers) {
    d.costUtil = d.cost.c == null ? 0.5 : (maxLog === minLog ? 0.5 : 1 - (Math.log1p(d.cost.c) - minLog) / (maxLog - minLog));
  }

  // F17 浪费风险：订阅模型、临近重置且利用率低、质量不低于该类中位数 → cost_util 上调至 max(·, 0.7)
  const wTrig = weights.cost || {};
  const classMedians = (() => {
    const mus = passers.map(d => d.features.muShrunk).sort((a, b) => a - b);
    if (!mus.length) return null;
    const m = Math.floor(mus.length / 2);
    return mus.length % 2 ? mus[m] : (mus[m - 1] + mus[m]) / 2;
  })();
  for (const d of passers) {
    const u = usageByModel[d.model];
    const sub = (registryByModel[d.model]?.pricing || {}).subscription;
    const wasteHigh = u && sub
      && (u.days_to_reset ?? 99) <= (wTrig.waste_trigger_days_to_reset ?? 3)
      && (u.utilization ?? 1) <= (wTrig.waste_trigger_max_utilization ?? 0.3)
      && classMedians !== null && d.features.muShrunk >= classMedians;
    if (wasteHigh) {
      d.costUtil = Math.max(d.costUtil, wTrig.waste_cost_util_floor ?? 0.7);
      d.wasteBoosted = true;
    }
  }

  // Score(m,i,w) = μ_shrunk − λ_risk·σ_shrunk + λ_p·P + λ_c·cost_util（C.1）
  const lr = weights.weights?.lambda_risk ?? 1.0;
  const lp = weights.weights?.lambda_pref ?? 0.2;
  const lc = weights.weights?.lambda_cost ?? 0.15;
  for (const d of passers) {
    d.score = d.features.muShrunk - lr * d.features.sigmaShrunk + lp * d.features.P + lc * d.costUtil;
  }
  const byScore = [...passers].sort((a, b) => b.score - a.score || a.model.localeCompare(b.model));

  // C.3 确定性配额覆盖：门闩通过集合里存在缺口且本单 eligible（低风险、可逆/可沙箱）
  // → 默认项强制从缺口集合轮转：先每格缺口最大 → 再全局缺口最大 → 同缺口 c 最低 →
  //   仍并列用稳定哈希 hash(job_id‖model_id) 定序——确定性、可复现，无任何随机数，记 reason=quota_explore。
  // 红2 修法首选：F8 缺口 = shortfall>0 || globalShortfall>0——此前只 filter(shortfall>0)，
  // 新模型全局保底 max(0, 全局保底−n_global) 算了不进覆盖，是死字段（硬约束 4「无饿死」落空）。
  const eligibleRisk = (weights.explore?.eligible_risk || ['低']).includes(risk);
  const eligible = eligibleRisk && reversible !== false;
  const quota = eligible
    ? passers
        .filter(d => d.features.shortfall > 0 || d.features.globalShortfall > 0)
        .sort((a, b) =>
          b.features.shortfall - a.features.shortfall
          || b.features.globalShortfall - a.features.globalShortfall
          || (a.cost.c ?? Infinity) - (b.cost.c ?? Infinity)
          || hashOf(`${jobId}|${a.model}`).localeCompare(hashOf(`${jobId}|${b.model}`)))
    : [];
  const quotaTop = quota[0] || null;
  // 分时路由（docs/model-routing.toml [[routes]]）优先于配额覆盖与最高分。
  // 写码 A 位以路由表为准（#688：devin > og > 直连）。路由模型被门闩剔除 → fallback；两者都过不了门闩才退回配额/最高分。
  const matchedRoute = matchBeijingRoute(routes, workType, ts);
  const routedPick = matchedRoute
    ? (passers.find(d => d.model === matchedRoute.model)
      || passers.find(d => d.model === matchedRoute.fallback)
      || null)
    : null;
  const defaultPick = routedPick || quotaTop || byScore[0] || null;
  // reason 从 defaultPick 反推（与 A.model 同源）：拆掉 routedPick 接线时 reason 不能再谎称 route_beijing。
  const routedApplied = Boolean(defaultPick && routedPick && defaultPick === routedPick);
  const choiceReason = routedApplied
    ? (defaultPick.model === matchedRoute.model ? 'route_beijing' : 'route_fallback')
    : defaultPick && defaultPick === quotaTop ? 'quota_explore'
    : defaultPick ? 'highest_score'
    : 'no_candidate';

  const choice = {
    model: defaultPick ? defaultPick.model : null,
    reason: choiceReason,
    route: routedApplied
      ? { role: matchedRoute.role, beijing: matchedRoute.beijing, model: matchedRoute.model, fallback: matchedRoute.fallback }
      : null,
  };

  // 三选项（C.4）：A 默认推荐 / B 自选 / C 尝鲜
  const A = defaultPick
    ? {
        model: defaultPick.model,
        reason: choice.reason,
        score: defaultPick.score,
        score_detail: {
          mu_shrunk: defaultPick.features.muShrunk,
          sigma_shrunk: defaultPick.features.sigmaShrunk,
          risk_discount: -lr * defaultPick.features.sigmaShrunk,
          preference_P: defaultPick.features.P,
          preference_term: lp * defaultPick.features.P,
          cost_util: defaultPick.costUtil,
          cost_term: lc * defaultPick.costUtil,
          lambda: { lambda_risk: lr, lambda_pref: lp, lambda_cost: lc },
        },
        cost: defaultPick.cost,
      }
    : { model: null, reason: 'no_candidate', score: null, score_detail: null, cost: null };

  const B = {
    note: '用户自选位：门闩通过集合内任选（禁令不可绕过）；选中记 job.override，喂 F9 偏好 P',
    models: byScore.map(d => d.model),
  };

  const exploreCandidates = passers.filter(d => d.features.shortfall > 0 || d.features.globalShortfall > 0);
  const C = {
    note: '尝鲜位：用户主动试新/低分模型（缺口模型优先）；记 job.explore，不进 P 但结局照常进 Q',
    models: (exploreCandidates.length ? exploreCandidates : passers).map(d => d.model),
  };

  // E.1 决策票：decision_id = hash(全部输入特征快照 + 选中项)，任何人可重跑核对
  const snapshot = {
    version: 1,
    ts, job_id: jobId, identity, work_type: workType,
    task_tokens: taskTokens, risk, reversible, availability,
    policy_hash: policyHash,
    events_hash: hashOf(cutoffEvents),
    routes_hash: routes.length ? hashOf(routes) : null,
    models: Object.fromEntries(Object.keys(details).sort().map(id => {
      const d = details[id];
      return [id, {
        score: d.score ?? null,
        rejected: d.gates.rejected ? d.gates.reasons : null,
        mu_shrunk: d.features.muShrunk,
        sigma_shrunk: d.features.sigmaShrunk,
        n_eff: d.features.nEff,
        P: d.features.P,
        shortfall: d.features.shortfall,
        global_shortfall: d.features.globalShortfall,
        cost_util: d.costUtil ?? null,
        cost: d.cost.c,
      }];
    })),
    choice,
  };
  const decisionId = hashOf(snapshot);
  const slate = buildSlate({ passers, matchedRoute, quotaTop, byScore });

  return {
    decision_id: decisionId,
    snapshot,
    inputs: { ts, job_id: jobId, identity, work_type: workType, task_tokens: taskTokens, risk, reversible },
    options: { A, B, C },
    models: details,
    slate,
  };
}
