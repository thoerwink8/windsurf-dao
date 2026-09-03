// scripts/lib/agent-stall-detect.mjs —— 撞限流/卡死判据（#833）
//
// 从 watchdog.mjs 搬出来的是**判据**，不是 1400 行常驻。服务器承重面
// （systemd timer）调 scripts/agent-stall-watch.mjs，本文件只做纯函数：
// 指纹匹配、连红计数、换人/报帅决策。
//
// 2026-09-03 实咬：PR #827 审官屏面停在 `exceeded retry limit, last status: 429`，
// watchdog ERROR_FINGERPRINTS 没有这两条，就算本机看门狗在跑也不报。

import { planCapacitySwitch, parseReviewerCardName } from './dianjiangtai-reviewer-slot.mjs';

/** 撞限流/卡死指纹。字符串 = 大小写不敏感子串；正则按原样。 */
export const STALL_FINGERPRINTS = [
  'exceeded retry limit',            // 2026-09-03 PR #827 审官实咬（原 watchdog 表缺）
  'last status: 429',                // 同上
  '429 Too Many Requests',
  'Retry failed',
  'no serving account',
  'stream disconnected',
  'login rejected',
  'timed out connecting',
  /Reconnecting.*5\/5/i,
  'at capacity',
  'try a different model',
  'temporarily limiting requests',
  '拼车 5 小时额度已用完',
  '503 Service Unavailable',
  'api_key_registry_unavailable',
  /unexpected status 5\d\d/i,
];

const DEFAULT_STRIKES = 2;
const DEFAULT_STATE_WINDOW = 12;

/** 只看屏面底部当前状态，不对上部任务书/叙述做关键字匹配（watchdog v0 假阳同款）。 */
export function stateWindow(text, lines = DEFAULT_STATE_WINDOW) {
  const n = Number(lines);
  const take = Number.isFinite(n) && n > 0 ? n : DEFAULT_STATE_WINDOW;
  const parts = String(text || '').split(/\r?\n/);
  return parts.slice(-take).join('\n');
}

export function fingerprintLabel(fp) {
  return fp instanceof RegExp ? fp.source : String(fp);
}

export function matchFingerprints(text, fingerprints = STALL_FINGERPRINTS) {
  const src = String(text || '');
  const hits = [];
  for (const fp of fingerprints) {
    const ok = fp instanceof RegExp
      ? fp.test(src)
      : src.toLowerCase().includes(String(fp).toLowerCase());
    if (ok) hits.push(fingerprintLabel(fp));
  }
  return hits;
}

/**
 * 连红状态机（恢复即清零；同一终端同一指纹只报一次）。
 * @param {{ strikes?: number, reported?: string|null, sig?: string }} prev
 * @param {string|null} hitSig  本轮命中的指纹标签；未命中传 null
 * @param {number} [need=2]
 */
export function nextStrike({ prev = {}, hitSig = null, need = DEFAULT_STRIKES } = {}) {
  const n = Number(need);
  const needN = Number.isFinite(n) && n > 0 ? n : DEFAULT_STRIKES;
  if (!hitSig) {
    return { keep: false, strikes: 0, reported: null, sig: null, fresh: false };
  }
  const was = prev && typeof prev === 'object' ? prev : {};
  if (was.reported === hitSig) {
    return {
      keep: true,
      strikes: was.strikes || needN,
      reported: hitSig,
      sig: hitSig,
      fresh: false,
    };
  }
  const same = was.sig === hitSig;
  const strikes = (same ? (was.strikes || 0) : 0) + 1;
  const fresh = strikes >= needN;
  return {
    keep: true,
    strikes,
    reported: fresh ? hitSig : null,
    sig: hitSig,
    fresh,
  };
}

/**
 * 扫一轮 agent 终端。agents[].screen 是字符串；screen === null 算没查成。
 * @returns {{ nextState: object, reports: object[], unscanned: number, scanned: number }}
 */
export function scanRound({ agents = [], prevState = {}, strikesNeeded = DEFAULT_STRIKES, stateLines = DEFAULT_STATE_WINDOW } = {}) {
  const next = {};
  const reports = [];
  let unscanned = 0;
  let scanned = 0;
  for (const t of agents) {
    if (!t || !t.handle) continue;
    if (t.screen === null || t.screen === undefined) {
      unscanned += 1;
      continue;
    }
    scanned += 1;
    const hits = matchFingerprints(stateWindow(t.screen, stateLines));
    const hitSig = hits[0] || null;
    const step = nextStrike({ prev: prevState[t.handle], hitSig, need: strikesNeeded });
    if (!step.keep) continue;
    next[t.handle] = { strikes: step.strikes, reported: step.reported, sig: step.sig };
    if (step.fresh) {
      reports.push({
        handle: t.handle,
        sig: hitSig,
        hits,
        title: t.title || t.handle,
        displayName: t.displayName || t.title || t.handle,
        agentIdentity: t.agentIdentity || null,
        worktreeId: t.worktreeId || null,
        parentWorktreeId: t.parentWorktreeId || null,
        strikes: step.strikes,
      });
    }
  }
  return { nextState: next, reports, unscanned, scanned };
}

/**
 * 探到审官撞限流之后：能换就换，走完/同厂/没查成工人 → 报帅停手。
 * 工人卡只报警不换审官。
 */
export function decideHitAction({
  displayName,
  workerId,
  models = [],
  passerIds = [],
  order = [],
} = {}) {
  const parsed = parseReviewerCardName(displayName);
  if (!parsed.ok) {
    return {
      ok: false,
      action: 'alert',
      reason: parsed.error || '卡名不是审官',
      displayName,
    };
  }
  const plan = planCapacitySwitch({
    displayName,
    models,
    passerIds,
    workerId,
    order,
  });
  if (!plan.ok) {
    return {
      ok: false,
      action: 'escalate',
      reason: plan.error,
      exhausted: !!plan.exhausted,
      unscanned: !!plan.unscanned,
      pr: parsed.pr,
      from: parsed.model,
    };
  }
  return {
    ok: true,
    action: 'switch',
    pr: plan.pr,
    from: plan.from,
    to: plan.to,
  };
}

export function reviewerPasserIds(routing) {
  return (routing?.models || [])
    .filter((m) => m && Array.isArray(m.roles) && m.roles.some((r) => r === '审查' || r === '审读'))
    .filter((m) => !m.reviewerDisabled)
    .map((m) => m.id);
}

export function reviewerOrderOf(routing) {
  return routing?.reviewerOrder || [];
}
