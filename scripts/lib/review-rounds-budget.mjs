// scripts/lib/review-rounds-budget.mjs —— per_issue.review_rounds_max 接线（#1227）
//
// 改这段前必须知道：
//   1. 上限只认 docs/release-policy.json 的 budget.per_issue.review_rounds_max。
//      不许在这里手抄 6。JSON 改了闸跟着改；改 JSON 本身是改规则，人拍板。
//   2. 审查轮次 = GitHub 判别态（APPROVED + CHANGES_REQUESTED）条数，含打在旧
//      commit 上的。COMMENTED / PENDING / DISMISSED 不算。#885 磨到第 8 轮，
//      数的就是这一种。
//   3. 已经满了（rounds >= max）⇒ 不许再起下一轮审官 / 返工。第 6 轮本身允许，
//      第 7 轮起拦。最后一条是绿的照样合，不停手。
//   4. 三态：ok / exceeded / unscanned。没读到上限 ≠ 没有上限，更不等于 6。

import { existsSync, readFileSync } from 'node:fs';
import { judgedReviewCount } from './review-state.mjs';
import { WAITING_USER_LABEL } from './exhausted.mjs';

export const POLICY_REL = 'docs/release-policy.json';
export const HALT_CODE = 'review-rounds-exceeded';

function str(v) {
  return v == null ? '' : String(v).trim();
}

function errText(e) {
  return str(e && e.message ? e.message : e).split(/\r?\n/)[0].slice(0, 160);
}

/** 解析策略正文。纯函数：给什么字解什么，不碰文件系统。 */
export function parseReviewRoundsBudget(text) {
  if (text == null) {
    return { unscanned: true, error: `没给 ${POLICY_REL} 正文（没查成）` };
  }
  let doc;
  try {
    doc = JSON.parse(String(text).replace(/^\uFEFF/, ''));
  } catch (e) {
    return { unscanned: true, error: `${POLICY_REL} 解析不了：${errText(e)}` };
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return { unscanned: true, error: `${POLICY_REL} 顶层不是对象` };
  }
  const max = doc?.budget?.per_issue?.review_rounds_max;
  if (!Number.isInteger(max) || max < 1) {
    return { unscanned: true, error: `${POLICY_REL} 的 budget.per_issue.review_rounds_max 不是正整数` };
  }
  const onExceed = str(doc?.budget?.per_issue?.on_exceed);
  return {
    unscanned: false,
    max,
    onExceed: onExceed || null,
  };
}

export function loadReviewRoundsBudgetFile(file) {
  if (!file) return { unscanned: true, error: `没给 ${POLICY_REL} 路径（没查成）` };
  try {
    if (!existsSync(file)) return { unscanned: true, error: `${POLICY_REL} 不在：${file}` };
    return parseReviewRoundsBudget(readFileSync(file, 'utf8'));
  } catch (e) {
    return { unscanned: true, error: `读 ${POLICY_REL} 失败：${errText(e)}` };
  }
}

/**
 * 要不要拦下一轮审查。
 *
 * budget 没给 / unscanned → skip（调用方没注入闸，不等于「上限是无限」；
 * 生产路径必须注入。测试夹具可不注入，以免改到无关用例）。
 * reviews 不是数组 → unscanned（没查成，不许当 0 轮）。
 */
export function judgeNextReviewRound({ reviews, budget } = {}) {
  if (budget == null) return { state: 'skip', rounds: null, max: null };
  if (budget.unscanned) {
    return {
      state: 'unscanned',
      rounds: null,
      max: null,
      error: budget.error || `${POLICY_REL} 的审查轮次上限没查成`,
    };
  }
  const max = budget.max;
  if (!Number.isInteger(max) || max < 1) {
    return { state: 'unscanned', rounds: null, max: null, error: '审查轮次上限不是正整数' };
  }
  if (!Array.isArray(reviews)) {
    return { state: 'unscanned', rounds: null, max, error: 'reviews 没查成，数不了审查轮次' };
  }
  const rounds = judgedReviewCount(reviews);
  if (rounds >= max) return { state: 'exceeded', rounds, max };
  return { state: 'ok', rounds, max };
}

export function reviewRoundsExceededError({ pr, rounds, max } = {}) {
  const n = pr == null ? '?' : String(pr);
  return `${HALT_CODE}：PR #${n} 审查轮次 ${rounds}/${max}，不起下一轮`;
}

export function reviewRoundsStopComment({ pr, rounds, max, head } = {}) {
  const n = pr == null ? '?' : String(pr);
  const h = str(head);
  return [
    `[review-rounds-budget] PR #${n} 审查轮次 ${rounds}/${max}`,
    '',
    `${POLICY_REL} 的 budget.per_issue.review_rounds_max 是 ${max}。`,
    '再磨一轮不会让单变小，只会继续烧额度。已打「卡死/等用户」，指挥官不再派返工/复审。',
    h ? `当前 head：${h}` : '当前 head 没查成，标打在 PR 上。',
    '',
    '帅位三选一：',
    '1. 拆成更小的单（推荐）',
    '2. 关掉这张 PR',
    '3. 去掉该标并接手——不是把上限放宽',
  ].join('\n');
}

export function reviewRoundsHubAskFields({ repo, issue, pr, rounds, max } = {}) {
  const ownerRepo = str(repo);
  const issueNo = Number(issue);
  const n = Number(pr);
  if (!ownerRepo || !Number.isInteger(issueNo) || issueNo <= 0 || !Number.isInteger(n) || n <= 0) {
    return null;
  }
  return {
    repo: ownerRepo,
    number: issueNo,
    url: `https://github.com/${ownerRepo}/issues/${issueNo}`,
    title: `PR #${n} 审查轮次 ${rounds}/${max}，已停手`,
    from: '指挥官',
    what: `PR #${n} 已经审了 ${rounds} 轮，上限是 ${max}（${POLICY_REL}）。再磨不会收敛。`,
    impact: '不拆单或不关 PR，这张单会一直停着，不再自动烧额度',
    recommend: '拆成更小的单，或关掉这张 PR',
    why: '上限是拍过板的预算，本单只接线不改规则',
    deadline: '单向门：超时不动',
  };
}

/** 指挥官动作用：打「卡死/等用户」+ 有署名单才带总控群卡片字段。 */
export function buildReviewRoundsStopAction({ pr, rounds, max, head, issue, repo } = {}) {
  const n = Number(pr);
  const action = {
    kind: 'mark-exhausted',
    pr: Number.isInteger(n) ? n : pr,
    verb: 'review-rounds',
    tries: Number(rounds) || 0,
    head: str(head) || null,
    label: WAITING_USER_LABEL,
    maxTries: Number.isInteger(max) ? max : null,
    why: `PR #${n} 审查轮次 ${rounds}/${max}，停手上报`,
    comment: reviewRoundsStopComment({ pr: n, rounds, max, head }),
  };
  const hubAsk = reviewRoundsHubAskFields({ repo, issue, pr: n, rounds, max });
  if (hubAsk) action.hubAsk = hubAsk;
  return action;
}
