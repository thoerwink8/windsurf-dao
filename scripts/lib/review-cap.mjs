// 审查轮次上限的生产消费者（#1227 / PR #1324 返工）。
//
// 改这段前必须知道：dao-check 接线闸不认检查器自身、不认注释/字符串自命中。
// 熔断能不能触发，取决于这里是不是真的在读 budget.per_issue.review_rounds_max。
// 指挥官返工任务书用这个数告诉工人「到上限只能改判或拆单」。

/**
 * 从已解析的 release-policy 对象读审查轮次上限。
 * 读不到 / 不是正数 → unscanned，不许退成「没有上限」。
 */
export function readReviewRoundsMax(doc) {
  if (doc == null || typeof doc !== 'object' || Array.isArray(doc)) {
    return { unscanned: true, why: 'release-policy 不是对象' };
  }
  const n = doc.budget?.per_issue?.review_rounds_max;
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) {
    return { unscanned: true, why: `budget.per_issue.review_rounds_max 不是正数：${JSON.stringify(n)}` };
  }
  return { cap: n };
}

/** 解析 JSON 文本再读上限。坏 JSON = unscanned，不是「没有上限」。 */
export function loadReviewRoundsMax(text) {
  let doc;
  try {
    doc = JSON.parse(String(text ?? '').replace(/^\uFEFF/, ''));
  } catch (e) {
    return { unscanned: true, why: `release-policy JSON 解析不了：${String(e.message).slice(0, 80)}` };
  }
  return readReviewRoundsMax(doc);
}

/**
 * 已到上限还要继续判红 → 审官必须改判或拆单，不许再写一轮「请修 P2」。
 * 轮次或上限没查成 → unscanned，不装作能判。
 */
export function fuseChoiceRequired(redRounds, cap) {
  if (!Number.isFinite(Number(cap)) || Number(cap) <= 0) {
    return { unscanned: true, why: '上限没查成' };
  }
  if (!Number.isFinite(Number(redRounds)) || Number(redRounds) < 0) {
    return { unscanned: true, why: '轮次没查成' };
  }
  return { required: Number(redRounds) >= Number(cap) };
}
