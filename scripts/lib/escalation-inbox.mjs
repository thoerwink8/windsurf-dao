// scripts/lib/escalation-inbox.mjs —— T39 ④ 的另一半：**指挥官侧收件箱**（读 + 机械裁决）。
//
// 上报侧（packages/fleet 的 escalate 活动）把「卡在哪 / 凭什么 / 试过什么 / 还能选谁」写成
// `~/.dao/fleet-escalations/<task>.json`。这一层负责：**能机械拍的当场拍，拍不了的标出来交人**——
// 否则「上报了没人看」就成了新的静默（本仓老话：写了指针就要配一道会报警的检查）。
//
// 三态：绿 / 红 / 没查成。**红 = 有单子躺太久没人看**（这才是要人管的事）。

export const INBOX_DECISIONS = Object.freeze(['retry', 'swap-leg', 'cancel', 'accept-as-is', 'ask-human']);

/**
 * 一条裁决载荷 → 机械决定（拍不了的返回 ask-human，不硬拍）。
 * 规则（先少后多，宁可交人也不乱拍）：
 *   · 上游容量满 → retry（工作流自己会走长退避，不该在收件箱里再等）
 *   · 停滞且还有轮次预算、且有同 family 候补 → swap-leg（换条腿重来）
 *   · 停滞且还有轮次预算、但没候补 → retry
 *   · 其余（没查成 / 认不出 / 轮次用尽）→ ask-human
 */
export function judgeEscalation({ payload } = {}) {
  const p = payload || {};
  const cls = String(p.failureClass || '');
  const reason = String(p.blockedReason || '');
  const round = Number(p.attempts && p.attempts.round);
  const limit = Number(p.attempts && p.attempts.reviewRounds);
  const exhausted = Number.isFinite(round) && Number.isFinite(limit) && round >= limit;
  const candidates = Array.isArray(p.candidates) ? p.candidates.filter(Boolean) : [];

  if (/capacity|429|rate.?limit/i.test(reason) || cls === 'capacity') {
    return { decision: 'retry', why: '上游容量满：工作流自己走长退避，收件箱里不重复等' };
  }
  if (cls === 'stall' && !exhausted) {
    return candidates.length
      ? { decision: 'swap-leg', why: `本步停滞且还有轮次：换同 family 的另一条腿（${candidates[0]}）` }
      : { decision: 'retry', why: '本步停滞且还有轮次，但没有同 family 候补：原腿重试' };
  }
  if (cls === 'stall' && exhausted) {
    return { decision: 'ask-human', why: '本步停滞且轮次已用尽——机器不该自己加轮次' };
  }
  return { decision: 'ask-human', why: `认不出的失败类（${cls || '空'}）：不硬拍，交人` };
}

/** 收件箱整体健康：有单子躺超时没人看 → 红。 */
export function judgeEscalationInbox({ items, now, maxAgeHours = 24 } = {}) {
  if (!Array.isArray(items)) return { state: 'unscanned', why: '收件箱没读成（取不到 ≠ 没有待裁决）' };
  if (!Number.isFinite(now)) return { state: 'unscanned', why: 'now 没给（算不出躺了多久）' };
  const judged = items.map((it) => ({ ...it, verdict: judgeEscalation({ payload: it.payload }) }));
  const counts = {};
  for (const j of judged) counts[j.verdict.decision] = (counts[j.verdict.decision] || 0) + 1;
  const stale = [];
  for (const j of judged) {
    const t = Date.parse((j.payload && j.payload.writtenAt) || j.writtenAt || '');
    if (!Number.isFinite(t)) return { state: 'unscanned', why: `#${j.payload?.taskId || '?'} 没有 writtenAt（算不出躺了多久）` };
    const ageHours = (now - t) / 3600000;
    if (ageHours >= maxAgeHours) stale.push({ taskId: (j.payload && j.payload.taskId) || null, ageHours: Math.round(ageHours) });
  }
  if (stale.length) {
    return {
      state: 'red',
      judged,
      counts,
      stale,
      why: `${stale.length} 条裁决躺了超 ${maxAgeHours} 小时没人看（${stale.slice(0, 5).map((s) => `${s.taskId || '?'}(${s.ageHours}h)`).join(' ')}）——上报了没人看就是新的静默`,
    };
  }
  const total = items.length;
  return {
    state: 'green',
    judged,
    counts,
    stale: [],
    why: total
      ? `收件箱 ${total} 条待裁决，都在 ${maxAgeHours} 小时内（${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(' / ')}）`
      : '收件箱空（没有待裁决，不是没查成）',
  };
}
