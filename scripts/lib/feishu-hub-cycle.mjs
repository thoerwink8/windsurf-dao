// scripts/lib/feishu-hub-cycle.mjs —— 指挥官每轮：对账待拍板卡 + 决定要不要发日报（#1029 / #1052）
//
// 纯函数计划 + 注入发送口。GitHub 没查成不许把卡判成已办结，也不发假报。

import { AWAITING_CALL_LABEL } from './now-board.mjs';
import { parsePolicy } from './ask-gate.mjs';
import {
  applyMenuPlan, applyReconcilePlan, planMenuList, planReconcile,
} from './hub-pending.mjs';
import {
  buildDailyCard, headlinesFromQueue, planDailySend,
} from './feishu-daily-card.mjs';
import { dayOf } from './broadcast-digest.mjs';

function str(v) {
  return v == null ? '' : String(v).trim();
}

function labelNames(issue) {
  const raw = issue && issue.labels;
  if (!Array.isArray(raw)) return [];
  return raw.map((l) => (typeof l === 'string' ? l : (l && l.name) || '')).map(str).filter(Boolean);
}

export function githubFromSituation(situation, repo) {
  if (!situation || !situation.github || situation.github.scanned !== true) {
    return { scanned: false, error: str(situation && situation.github && situation.github.error) || 'GitHub 没查成' };
  }
  const ownerRepo = str(repo);
  const issues = [];
  for (const issue of situation.github.issues || []) {
    if (!issue || typeof issue !== 'object') continue;
    const number = Number(issue.number);
    if (!Number.isInteger(number) || number <= 0) continue;
    issues.push({
      repo: ownerRepo,
      number,
      title: str(issue.title),
      body: str(issue.body),
      url: str(issue.url) || (ownerRepo ? `https://github.com/${ownerRepo}/issues/${number}` : ''),
      labels: labelNames(issue),
    });
  }
  return { scanned: true, issues };
}

export function snapshotFromSituation(situation, { headlines = [] } = {}) {
  if (!situation || !situation.github || situation.github.scanned !== true) {
    return {
      scanned: false,
      error: str(situation && situation.github && situation.github.error) || 'GitHub 没查成',
    };
  }
  // admission.unscanned 是「查了没查成」，不是「没有这一节」。
  // 没查成的在跑工人印进日报会把空当成 0。GitHub 绿、准入红 → 整张不发。
  if (situation.admission && situation.admission.unscanned === true) {
    return {
      scanned: false,
      error: str(situation.admission.why || situation.admission.error) || '在跑工人没查成',
    };
  }
  const issues = Array.isArray(situation.github.issues) ? situation.github.issues : [];
  const prs = Array.isArray(situation.github.prs) ? situation.github.prs : [];
  const pending = issues.filter((i) => labelNames(i).includes(AWAITING_CALL_LABEL)).length;
  const conflicts = prs.filter((p) => str(p.mergeable) === 'CONFLICTING').length;
  let workers = null;
  if (situation.admission && situation.admission.unscanned !== true
    && typeof situation.admission.inFlight === 'number') {
    workers = situation.admission.inFlight;
  } else if (typeof situation.inflightWorkers === 'number') {
    workers = situation.inflightWorkers;
  }
  return {
    scanned: true,
    pending,
    openPrs: prs.length,
    workers,
    conflicts,
    stuck: conflicts,
    headlines: Array.isArray(headlines) ? headlines : [],
  };
}

export function loadAskPolicy(text) {
  return parsePolicy(text);
}

export function planHubCycle({
  situation, repo, hubPending, policy, digestState, now,
} = {}) {
  const github = githubFromSituation(situation, repo);
  const reconcile = planReconcile({ github, hubPending, policy, repo });
  const today = dayOf(now);
  const headlines = headlinesFromQueue(digestState && digestState.queue && digestState.queue.items);
  const snapshot = snapshotFromSituation(situation, { headlines });
  const daily = planDailySend({
    snapshot,
    previous: digestState && digestState.lastSnapshot,
    lastSentDay: digestState && digestState.lastSentDay,
    today,
  });
  const card = daily.send
    ? buildDailyCard({
      day: today,
      nowLabel: today,
      snapshot,
      previous: digestState && digestState.lastSnapshot,
      repo,
    })
    : null;
  return { reconcile, daily, snapshot, card, today, headlines };
}

export function applyHubCycle(plan, {
  issueCard, decideCard, digestLine, sendDaily, now, who,
} = {}) {
  // 先发日报（用计划时的队列快照），再对账。对账产生的摘要入队留给下一期，
  // 不许被「发完清空队列」吞掉。
  let daily = { ok: true, sent: false, why: plan && plan.daily && plan.daily.why };
  if (plan && plan.daily && plan.daily.send) {
    if (typeof sendDaily !== 'function') {
      daily = { ok: false, sent: false, error: '没有日报发送口' };
    } else {
      const r = sendDaily({ card: plan.card, snapshot: plan.snapshot, day: plan.today });
      daily = r && r.ok
        ? { ok: true, sent: true, messageId: r.messageId, why: plan.daily.why }
        : { ok: false, sent: false, error: (r && r.error) || '日报没送进群' };
    }
  }
  const applied = applyReconcilePlan(plan && plan.reconcile, {
    issueCard, decideCard, digestLine, now, who,
  });
  return { reconcile: applied, daily };
}

export function runMenuList({ github, hubPending, policy, repo, bumpCard, issueCard }) {
  const plan = planMenuList({ github, hubPending, policy, repo });
  const applied = applyMenuPlan(plan, { bumpCard, issueCard });
  return { plan, applied };
}
