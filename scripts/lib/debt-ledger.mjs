// scripts/lib/debt-ledger.mjs —— T32：债册子。纯函数：指纹去重、折叠计数、SLA 算期、判超期。
//
// 补的真洞：`contract.mjs` 把 findings 分成 blocking(P1) / advisory(P2,P3)，而 **advisory 之后没有任何消费方**
// ——今天的 P2/P3 是静默丢失的。P1 仍阻塞合并（不变）；P2/P3 记账、批量还、出口前清算。
//
// 业界做法（用户 2026-09-19 要求查证，见 #1460 的 T32 系列评论）：
//   · 只记指纹，不记细节（细节必然漂移，记了就是误导）；
//   · 相关实例归并成一条、按计数累加（SonarQube / debt register：不是「每行一个条目」）；
//   · **重查即重算**：发布时逐条重查，不再复现就关，查不动算 unscanned；
//   · 闸只拦**新债**，老债不挡发布但出口前必须逐条过。
//
// 三态：绿 / 红 / 没查成。**「没有债」与「没查成」必须分得开**。

import { createHash } from 'node:crypto';

export const DEBT_TYPES = Object.freeze(['security', 'data', 'contract', 'correctness', 'perf', 'maintainability', 'ui']);
export const DEBT_SEVERITIES = Object.freeze(['P1', 'P2', 'P3']);

/** 指纹：优先 `文件:行:类型`；审查还没带位置时退回 `id:<审查给的 slug>`（稳定、可累加）。
 *  **只记指纹，不记细节**——细节（当时的 diff/现象）必然漂移，记了就是误导。 */
export function debtFingerprint({ file, line, type, id } = {}) {
  const loc = String(file || '').trim() && String(type || '').trim();
  const key = loc
    ? `${String(file).trim()}:${Number(line) || 0}:${String(type).trim()}`
    : `id:${String(id || '').trim()}`;
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

/** SLA 矩阵里的一条，如 `security(可达) P1/P2` / `data P1/P2` / `maintainability P2/P3`。 */
function bucketMatches(entry, { type, severity, reachable }) {
  const m = String(entry || '').trim().match(/^([a-z]+)(?:\(([^)]+)\))?\s+(P\d(?:\/P\d)*)$/);
  if (!m) return false;
  const [, t, qual, sevs] = m;
  if (t !== type) return false;
  if (qual === '可达' && reachable !== true) return false;
  if (qual === '不可达' && reachable !== false) return false;
  return sevs.split('/').includes(severity);
}

/** 从 SLA 矩阵（docs/stages/<版本>.json 的 debt.sla）算这条债的到期桶。 */
export function slaBucket({ type, severity, reachable } = {}, sla = {}) {
  for (const [bucket, days] of [['immediate', 0], ['withinOneWeek', 7], ['withinTwoWeeks', 14]]) {
    if ((sla[bucket] || []).some((e) => bucketMatches(e, { type, severity, reachable }))) return { bucket, days };
  }
  if ((sla.debtBatch || []).some((e) => bucketMatches(e, { type, severity, reachable }))) return { bucket: 'debtBatch', days: null };
  return { bucket: 'unknown', days: null };
}

const addDays = (iso, days) => new Date(Date.parse(iso) + days * 86400000).toISOString();

/**
 * 折叠一批发现进账本：同指纹只累加计数、刷新 lastSeen，不重复开条。
 * @returns {{ items:object[], added:number, bumped:number, skipped:number }}
 */
export function foldFindings({ items = [], findings = [], now, sla = {}, stage = null } = {}) {
  const out = items.map((i) => ({ ...i }));
  const byFp = new Map(out.map((i) => [i.fingerprint, i]));
  let added = 0, bumped = 0, skipped = 0;
  for (const f of findings) {
    const severity = String(f && f.severity || '').toUpperCase();
    // 审查契约目前只保证 {id,severity,detail}：**没有 type 时按 maintainability 兜底**（catch-all），
    // 宁可归到最松的一类也别丢——丢了就回到「静默丢失」。契约补上 type 后自然变准（见 T32 后续）。
    const type = String(f && f.type || 'maintainability').toLowerCase();
    // P1 阻塞返工，不进册子；类型不认识也不进（宁可不记，不记错的）。
    if (!DEBT_SEVERITIES.includes(severity) || severity === 'P1' || !DEBT_TYPES.includes(type)) { skipped += 1; continue; }
    const fingerprint = debtFingerprint({ file: f.file, line: f.line, type, id: f.id });
    const hit = byFp.get(fingerprint);
    if (hit) {
      hit.count += 1;
      hit.lastSeen = now;
      hit.severity = severity;
      bumped += 1;
      continue;
    }
    const { bucket, days } = slaBucket({ type, severity, reachable: f.reachable === true }, sla);
    const item = {
      fingerprint,
      file: String(f.file || ''),
      line: Number(f.line) || 0,
      type,
      severity,
      reachable: f.reachable === true,
      count: 1,
      firstSeen: now,
      lastSeen: now,
      sla: bucket,
      dueAt: days === null ? null : addDays(now, days),
      stage,
    };
    out.push(item);
    byFp.set(fingerprint, item);
    added += 1;
  }
  return { items: out, added, bumped, skipped };
}

/**
 * 判账本健康：超期（有 dueAt 且已过）→ 红；条数超阈 → 红。
 * 三态：items 不是数组 / now 不是时间 → unscanned。
 */
export function judgeDebt({ items, now, maxItems = 40 } = {}) {
  if (!Array.isArray(items)) return { state: 'unscanned', why: '债册子没读成（取不到 ≠ 没有债）' };
  if (!Number.isFinite(now)) return { state: 'unscanned', why: 'now 没给（算不出超期）' };
  const overdue = items.filter((i) => i && i.dueAt && Date.parse(i.dueAt) < now);
  if (overdue.length) {
    return {
      state: 'red',
      overdue,
      why: `${overdue.length} 条债超期（${overdue.map((i) => `${i.file}:${i.line}(${i.type} ${i.severity})`).slice(0, 5).join(' ')}）——按 SLA 该还了`,
    };
  }
  if (items.length > maxItems) {
    return { state: 'red', overdue: [], why: `债册子 ${items.length} 条 > 阈值 ${maxItems}——批量还一轮或显式接受` };
  }
  return { state: 'green', overdue: [], why: items.length ? `债册子 ${items.length} 条，无超期` : '债册子空（没有债，不是没查成）' };
}
