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

/** 死因原文是不是满载/看门狗那一类。空串不算——没查成不许当满载。 */
export function isCapacityDeath(error) {
  const t = error == null ? '' : String(error).trim();
  return t !== '' && CAPACITY_DEATH_RE.test(t);
}

function nextAfterDead(f) {
  if (!f || typeof f !== 'object') return { ok: false, error: '没交换厂凭证' };
  const deadError = f.deadError == null ? '' : String(f.deadError).trim();
  if (!deadError) {
    return { ok: false, unscanned: true, error: '没给上一位审官的死因原文（没查成，不许猜着放行）' };
  }
  if (!isCapacityDeath(deadError)) {
    return { ok: false, error: `上一位的死因不是满载/看门狗那一类（${deadError.slice(0, 80)}）` };
  }
  if (f.deadModelId == null || String(f.deadModelId).trim() === '') {
    return { ok: false, unscanned: true, error: '没查成上一位审官是谁，不许猜着换人' };
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
  return {
    ok: true,
    next: next.next,
    deadModelId: String(f.deadModelId),
    deadError,
    why: `上一位 ${f.deadModelId} 死于「${deadError.slice(0, 60)}」，按顺位换 ${next.next}`,
  };
}

/**
 * 撞满载换厂的凭证成不成立（#1122，2026-09-07 用户拍板开的例外）。纯判据，不碰 IO。
 *
 * 例外**不是一个旗标**：谁都能传的旗标 = 谁都能绕开审官位约束去点一个弱模型。
 * 三件都要过：① 死因是满载/看门狗那一类；② 算得出下一位；③ 请求的就是算出来那一位。
 * #679 的异厂要求由 nextReviewerAfter 内部的 assertCrossVendor 继续守着。
 */
export function judgeCapacityFailover({ requested, capacityFailover } = {}) {
  const next = nextAfterDead(capacityFailover);
  if (!next.ok) return next;
  if (String(requested) !== String(next.next)) {
    // 不许跳级：算出来该换 A，却来点名 B，那就是绕开顺位挑模型。
    return { ok: false, error: `按顺位该换 ${next.next}，请求的却是 ${requested}——不许跳级点名` };
  }
  return { ok: true, why: next.why };
}

/**
 * 生产路径选人（#1122）：上一位死于满载/看门狗时，按顺位取下一位。
 *
 * 闸口 `judgeCapacityFailover` 只回答「点名的这位过不过」——调用方仍拿 issue 标签上的
 * luna 去起，永远过不了「请求的必须等于下一位」。本函数才是换厂的腿：
 *   - 没点名、或点的就是刚死的那位 → 取下一位（标签还钉着死人，这是默认路径）
 *   - 点名的正好是下一位 → 放行
 *   - 点名是更靠前的（标签还钉着更早一跳死掉的那位）→ 仍取下一位
 *   - 点名比算出的下一位更靠后，或不在表里 → 跳级，拒
 * 没满载死因 → 原样返回 requested，不换。
 */
export function planReviewerOnCapacityDeath({ requested, capacityFailover } = {}) {
  const requestedId = requested == null ? '' : String(requested).trim();
  const f = capacityFailover;
  if (!f || typeof f !== 'object' || !isCapacityDeath(f.deadError)) {
    return { ok: true, reviewerId: requestedId, switched: false };
  }
  const next = nextAfterDead(f);
  if (!next.ok) return next;
  if (requestedId && requestedId !== String(next.next)) {
    const order = Array.isArray(f.order) && f.order.length ? f.order.map(String) : (f.passerIds || []).map(String);
    const iReq = order.indexOf(requestedId);
    const iNext = order.indexOf(String(next.next));
    // 跳级 = 点了更弱的（顺位更靠后），或点了表外的。标签钉着更早一跳（luna 死了换 sol，sol 又死了标签还写着 luna）不是跳级。
    if (iReq < 0 || iNext < 0 || iReq > iNext) {
      return { ok: false, error: `按顺位该换 ${next.next}，请求的却是 ${requestedId}——不许跳级点名` };
    }
  }
  return {
    ok: true,
    reviewerId: next.next,
    switched: next.next !== requestedId,
    why: next.why,
  };
}
