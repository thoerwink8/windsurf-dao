// scripts/lib/review-state.mjs —— GitHub review 状态（#807：判定行协议退役）
//
// 8-24 拍板：#573 后审官能真 approve / request-changes，GitHub 状态本身机器可读。
// 不再解析 review 正文「判定：红 N 项」字符串。本模块只认 state。

export function normalizeReviewState(review) {
  const raw = review && typeof review === 'object' ? review.state : review;
  const s = String(raw || '').toUpperCase().replace(/\s+/g, '_');
  if (s === 'APPROVED' || s === 'APPROVE') return 'APPROVED';
  if (s === 'CHANGES_REQUESTED' || s === 'CHANGES_REQUEST' || s === 'REQUEST_CHANGES') {
    return 'CHANGES_REQUESTED';
  }
  if (!s) return null;
  return s;
}

/** 工人完工 comment：issue comment 首行「完工」或「返工完成/处置」。 */
export function isCompletionComment(body) {
  const firstLine = String(body || '').split(/\r?\n/).map((l) => l.trim()).find(Boolean) || '';
  const stripped = firstLine.replace(/^#+\s*/, '');
  return /^完工/.test(stripped) || /返工(?:完成|处置)/.test(stripped);
}

/**
 * 一批 GitHub review → 红轮 / 是否绿过。
 * reviews 不是数组 = 没查成。COMMENTED 等非判别态跳过。
 */
export function analyzeGithubReviews(reviews) {
  if (!Array.isArray(reviews)) return { scanned: false };
  let redRounds = 0;
  let green = false;
  let latestJudged = null;
  for (const rv of reviews) {
    const state = normalizeReviewState(rv);
    if (state === 'APPROVED') {
      green = true;
      latestJudged = 'green';
      continue;
    }
    if (state === 'CHANGES_REQUESTED') {
      redRounds += 1;
      latestJudged = 'red';
    }
  }
  return {
    scanned: true,
    redRounds,
    green,
    latestGreen: latestJudged === 'green',
    latestRed: latestJudged === 'red',
  };
}

/** CHANGES_REQUESTED 条数。0 条判别态由调用方决定记 0 还是 null。 */
export function requestedChangeCount(reviews) {
  let n = 0;
  for (const rv of reviews || []) {
    if (normalizeReviewState(rv) === 'CHANGES_REQUESTED') n += 1;
  }
  return n;
}

/** 有判别态的 review 条数（APPROVED + CHANGES_REQUESTED）。 */
export function judgedReviewCount(reviews) {
  let n = 0;
  for (const rv of reviews || []) {
    const s = normalizeReviewState(rv);
    if (s === 'APPROVED' || s === 'CHANGES_REQUESTED') n += 1;
  }
  return n;
}

/**
 * 当前 head 上有没有审官交的判定。**三态**，不是布尔。
 *
 * 2026-09-15 实咬（#1289）：审官会话跑完、分析做完、结论写在会话文本里，
 * 但从没调 `gh pr review` 落到 GitHub，然后以 phase=done 收尾。下游把
 * 「会话结束」读成「审完了」，于是复用那个没交卷的会话，PR 冻了一整天。
 * 判「审完了没有」的唯一硬证据是 GitHub 上这个 head 有没有判定——不是会话状态。
 *
 * 返回 `true` / `false`（确认没有）/ `null`（没查成）。
 * 三者必须分开：把「没查成」当成「没有判定」会去重复烧额度，
 * 当成「有判定」会把 PR 继续冻着——两个方向都错，所以读不清就说读不清。
 *
 * @param reviews gh `pr view --json reviews` 的数组
 * @param headOid 当前 headRefOid
 */
export function verdictOnHead(reviews, headOid) {
  if (!Array.isArray(reviews)) return null;
  const head = String(headOid || '').trim();
  if (!head) return null;              // 不知道 head 就判不了「打在 head 上」
  for (const rv of reviews) {
    const state = normalizeReviewState(rv);
    if (state !== 'APPROVED' && state !== 'CHANGES_REQUESTED') continue;
    const oid = String((rv && rv.commit && rv.commit.oid) || '').trim();
    if (!oid) return null;             // 有判定但读不到它打在哪个 commit ⇒ 没查成
    if (oid === head) return true;
  }
  return false;
}
