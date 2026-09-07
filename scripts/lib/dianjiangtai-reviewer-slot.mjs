// scripts/lib/dianjiangtai-reviewer-slot.mjs —— 审读/审查 A 位按 JSON 选型序
//
// 2026-08-22：审官顺位真相源 docs/model-routing.json（审官.审查.模型）。
// 本模块只决定 A 位模型与换人顺序，不改 B/C，不写账。
// #679：换人跳过工人那一厂。

import { assertCrossVendor } from './reviewer-vendor-gate.mjs';

function orderedPasserIds({ models = [], passerIds = [], order = [] } = {}) {
  const byId = new Map((models || []).map(m => [m.id, m]));
  const set = new Set(passerIds || []);
  const out = [];
  for (const id of order || []) {
    if (set.has(id) && byId.has(id)) out.push(id);
  }
  for (const id of passerIds || []) {
    if (!out.includes(id) && byId.has(id)) out.push(id);
  }
  return out;
}

/**
 * @param {{ models: Array<{id:string,provider?:string}>, passerIds: string[], order?: string[] }} input
 * @returns {{ model: string|null, reason: 'reviewer_order'|'no_candidate' }}
 */
export function pinReviewerSlotA({ models = [], passerIds = [], order = [], workerId = null } = {}) {
  const ids = orderedPasserIds({ models, passerIds, order });
  if (ids.length === 0) return { model: null, reason: 'no_candidate' };
  const top = ids[0];
  if (workerId != null && String(workerId).trim() !== '') {
    const gate = assertCrossVendor({ workerId, reviewerId: top, models });
    if (gate.state === 'same_vendor') {
      return { model: null, reason: 'same_vendor_blocked', error: gate.error };
    }
  }
  return { model: top, reason: 'reviewer_order' };
}

export const REVIEWER_SELECT_ROLES = new Set(['审读', '审查']);

export function reviewerOrder({ models = [], passerIds = [], order = [] } = {}) {
  return orderedPasserIds({ models, passerIds, order });
}

export function nextReviewerAfter({ currentId, models = [], passerIds = [], workerId, order = [] } = {}) {
  const list = reviewerOrder({ models, passerIds, order });
  if (list.length === 0) {
    return { ok: false, unscanned: false, exhausted: true, error: '审官选型序空（没查成候选）' };
  }
  const cur = String(currentId || '');
  const i = list.indexOf(cur);
  const start = i < 0 ? -1 : i;
  let checked = 0;
  for (let k = start + 1; k < list.length; k++) {
    const cand = list[k];
    checked += 1;
    if (workerId != null && String(workerId).trim() !== '') {
      const gate = assertCrossVendor({ workerId, reviewerId: cand, models });
      if (gate.state === 'unscanned') {
        return { ok: false, unscanned: true, exhausted: false, error: gate.error };
      }
      if (gate.state === 'same_vendor') continue;
    }
    return { ok: true, next: cand, from: cur || null };
  }
  // 文案分态（2026-08-22 #729/#730 排障被误导实证）：「没有下一位」≠「剩余全同厂」。
  // 循环没跑过 = 候选池空了，报同厂是把排障引向不存在的厂商冲突。
  if (checked === 0) {
    return {
      ok: false,
      unscanned: false,
      exhausted: true,
      error: `审官选型序没有下一位可换（当前 ${cur || '未知'}，序内共 ${list.length} 位）——候选池空了，不是厂商冲突`,
    };
  }
  if (workerId != null && String(workerId).trim() !== '') {
    return {
      ok: false,
      unscanned: false,
      exhausted: true,
      error: `选型序剩余 ${checked} 位全部与工人同厂，没法再换（不许降级同厂）`,
    };
  }
  return { ok: false, unscanned: false, exhausted: true, error: '审官选型序走完，没法再换' };
}

export function parseReviewerCardName(name) {
  const n = String(name || '').trim();
  const m = n.match(/PR-#?(\d+)\s+审官·(\S+)/);
  if (!m) return { ok: false, error: '卡名不是 PR-#N 审官·模型' };
  return { ok: true, pr: Number(m[1]), model: m[2] };
}

/** 卡名给人看。程序判据不要用这个读实际工人模型——fallback 后卡名可能停在请求模型。 */
export function parseWorkerModelFromCard(name) {
  const n = String(name || '').trim();
  const m = n.match(/工人·(\S+)/);
  if (!m) return { ok: false, error: '卡名不是 …工人·模型' };
  return { ok: true, model: m[1] };
}

// planCapacitySwitch 已删（#1122）：它按点将台卡名（`PR-#N 审官·模型`）解析，
// 而 #1115 删掉 orca 派工脊后 mirasim 路根本没有卡，它也就没有了任何生产调用方——
// 只剩单测和一个「验它还存在」的检查器在维持它活着的假象。
// 换厂的判据换成下面这个 judgeCapacityFailover：不认卡名，只认死因原文。

// 死于「这一针根本没跑成」的两类原文，2026-09-07 从真会话上抄的：
//   "Selected model is at capacity. Please try a different model."   上游满载
//   "pi turn stalled past 30 minutes"                                 回合看门狗
// 只认这两类。别的失败（判红、写错、被拒）不是换厂的理由——换厂治的是「这一厂现在跑不动」，
// 不是「这个模型审得不好」。判据写宽了，换厂就会变成挑模型的后门。
const CAPACITY_DEATH_RE = /at capacity|turn stalled|rate limit|too many requests|\b429\b|overloaded/i;

/**
 * 撞满载换厂的凭证成不成立（#1122，2026-09-07 用户拍板开的例外）。纯判据，不碰 IO。
 *
 * 例外**不是一个旗标**：谁都能传的旗标 = 谁都能绕开审官位约束去点一个弱模型。
 * 三件都要过：① 死因是满载/看门狗那一类；② 算得出下一位；③ 请求的就是算出来那一位。
 * #679 的异厂要求由 nextReviewerAfter 内部的 assertCrossVendor 继续守着。
 */
export function judgeCapacityFailover({ requested, capacityFailover } = {}) {
  const f = capacityFailover;
  if (!f || typeof f !== 'object') return { ok: false, error: '没交换厂凭证' };

  const deadError = f.deadError == null ? '' : String(f.deadError).trim();
  if (!deadError) {
    // 没给死因和「死因不是满载」不是一回事：前者是没查成，后者是查过不该换。
    return { ok: false, unscanned: true, error: '没给上一位审官的死因原文（没查成，不许猜着放行）' };
  }
  if (!CAPACITY_DEATH_RE.test(deadError)) {
    return { ok: false, error: `上一位的死因不是满载/看门狗那一类（${deadError.slice(0, 80)}）` };
  }
  // 没查成工人模型就不许换：nextReviewerAfter 只在拿得到 workerId 时才跑同厂闸，
  // 不给它就会安静地按纯顺位挑下一位，而那一位可能正是工人那一厂——#679 被绕开且无声。
  if (f.workerId == null || String(f.workerId).trim() === '') {
    return { ok: false, unscanned: true, error: '没查成工人模型，不许换人（换过去可能撞上工人同厂）' };
  }

  const next = nextReviewerAfter({
    currentId: f.deadModelId,
    models: f.models || [],
    passerIds: f.passerIds || [],
    workerId: f.workerId,
    order: f.order || [],
  });
  if (!next.ok) return { ok: false, unscanned: next.unscanned === true, error: next.error };
  if (String(requested) !== String(next.next)) {
    // 不许跳级：算出来该换 A，却来点名 B，那就是绕开顺位挑模型。
    return { ok: false, error: `按顺位该换 ${next.next}，请求的却是 ${requested}——不许跳级点名` };
  }
  return { ok: true, why: `上一位 ${f.deadModelId} 死于「${deadError.slice(0, 60)}」，按顺位换 ${next.next}` };
}
