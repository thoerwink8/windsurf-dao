// scripts/lib/commander-core.mjs —— 服务器指挥官「决策」层纯函数（#800）
//
// 眼睛（scan）产出「态势 situation」，本层 decide(situation) → 动作清单 actions[]，
// 手（act）逐条执行。判断全在这层，测试拿夹具钉判别力，不起真 orca / 真 GitHub。
//
// #800 三节判据逐条落这里：
//   自己做（确定性，调 dao.mjs 现有动词）：dispatch / rework / attach-reviewer / merge(+land)
//   唤大脑（要判断，起一次性 pi）：撞死指纹 #833 没接住 / 双向门到期代拍
//   报帅停手（永不自动）：缺 model|reviewer 标签 / 撞死指纹三次唤醒仍没闭环
//
// #931（用户 2026-09-05 拍板，grill-ai 从零重推）：**判红这条路上的「唤大脑」整层删掉**。
//   旧路 判红 → 唤大脑翻译返工方向 → 送达工人终端 → 唤满报帅：工人早已下班，方案没有接收者。
//   新路 判红 → 直接派一个返工工人（kind:'rework'），任务书带审官红项**全文**（不摘要）。
//   审官标准本来就要求红项写「文件:行号 + 现象 + 期望改法」，工人照着改即可，不需要中间那层翻译。
//   撞死指纹 / 代拍两条路的 wake-brain **没动**——它们要判断的不是「怎么改代码」，#931 没拍过它们。
//
// 铁律（CLAUDE.md「自动检查」+ #800）：**situation 里任何一节 unscanned，对应正向动作一律不产，
//   改产 escalate(reason:'unscanned')**。没查成 ≠ 空态势——空态势静默（noop），没查成要 fail-visible。
//   这条有专门红样本测试（tests/commander.test.js「没查成 ≠ 空」）。
//
// 复用已测原语（不重造）：
//   shuai-scan.mjs   prApprovedReady / prApprovedDraft / prChecksRed —— PR 判绿/待拍板/CI 红
//   ready-queue-check.mjs  inspectReadyQueue —— 已消歧 + 无在途 PR + 无卡 + 没挂「将来某版」 = 可立即起
//   review-state.mjs analyzeGithubReviews —— GitHub APPROVED / CHANGES_REQUESTED

import { prApprovedReady, prApprovedDraft, prChecksRed, DEFAULT_REPO } from './shuai-scan.mjs';
import { sessionStateOf, classifySessionState } from './execution-states.mjs';
import {
  canReleaseApprovedDraft, explicitApprovalIssue, isApprovedExecutionTask, checksSucceeded,
} from './approved-merge.mjs';
import { inspectReadyQueue } from './ready-queue-check.mjs';
import { analyzeGithubReviews, normalizeReviewState } from './review-state.mjs';
import { hasPendingLabel } from './pending-disambiguation.mjs';
import { attributedIssueNumber } from './close-issue.mjs';
import {
  proposeAddLabel, validateRetryDrain, escalateToOpenIssue, stampedKey,
  drainLedgerKey, epochOf, MAX_DRAIN_TRIES,
} from './commander-verbs.mjs';
import { buildMarkExhausted, prHasStuckLabel, planExhaustedLabelClear } from './exhausted.mjs';
// #1236：重试键的三件套（判据版本 / 键拼装 / drain 账键）转出去，让**测试与生产共用同一把键**。
// 手拼字面量的测试在加版本那天会静默失配（测试假绿、生产卡死）——今天漏的是测试，
// 明天就是写侧（#909 的形状）。
export { drainLedgerKey, epochOf, stampedKey } from './commander-verbs.mjs';
// #1237：失败分类——判据在 lib/retry-verdict.mjs，这里只消费。
import {
  judgeRetry, judgeRepeatedFailure, foldFailureStreak, SAME_ERROR_ROUNDS_TO_STUCK,
} from './retry-verdict.mjs';
export { judgeRepeatedFailure, foldFailureStreak, SAME_ERROR_ROUNDS_TO_STUCK };
import {
  REVIEW_PENDING_SOURCE_WORKER_DONE_FAIL,
  REVIEW_PENDING_SOURCE_COMMANDER_REREVIEW,
  REVIEW_PENDING_SOURCE_WORKER_DONE_HANDOFF,
  REVIEW_PENDING_SOURCE_WORKER_DONE,
  reviewPendingSourceOf,
} from './dispatch/review-pending.mjs';
import { resolveMergeable } from './dispatch/git.mjs';
import { pickMergePolicyFromLedger } from './dispatch/reviewer.mjs';
import {
  hasLiveExecutor, sessionListForLiveness, planReconcile,
} from './session-reconcile.mjs';
import {
  approvedToLand, lastJudgmentOf, lastApprovedCommitId, needsDockProof, provePureDock,
  manualMergeApproved,
} from './land-decision.mjs';
import {
  prioritizeReady, resolveAdmissionPolicy, RENAMED_KEY_HINT,
  capNewDispatchSlots,
} from './admission.mjs';
import { planTreeReaps, markTreesForMergedPrs } from './ephemeral-reap.mjs';
import { planOrphanReaps } from './dispatch/lease.mjs';
import { classifyAsk } from './ask-gate.mjs';
import { judgeChannelForModel, legAvailability, pickLeg, takeChannelSlot } from './channel-concurrency.mjs';
import { UNSIGNED_ISSUE_MERGE_REASON } from './dispatch/reviewer.mjs';

export const ACTION_KINDS = [
  'dispatch', 'rework', 'rereview', 'attach-reviewer', 'merge', 'land',
  'notify-hub', 'wake-brain', 'escalate', 'noop',
  'add-label', 'retry-drain', 'open-issue', 'reap-ticket', 'mark-exhausted',
  'stop-session', 'pump-draft', 'clear-exhausted', 'reap-tree', 'reap-orphan',
];

// 报帅停手的默认门槛：同一撞死终端唤醒大脑到这个次数仍没闭环 → 转报帅（#800）。
// #931 后 PR 判红不再走唤醒预算（改直接派返工工人），这个门槛只管撞死指纹 / 代拍两条路。
export const WAKE_LIMIT = 3;

/** 复审票里的 head：写票一侧给的是 {name, oid}，别处可能是字符串。取不出返回 null（不猜）。
 *  drain 账本的键要用它，decide 与 execute 两侧必须走同一个门面，否则算出来的键对不上。 */
export function ticketHeadOid(head) {
  if (typeof head === 'string') return head.trim() || null;
  const oid = head && typeof head === 'object' ? head.oid : null;
  return typeof oid === 'string' && oid.trim() ? oid.trim() : null;
}

/** 复审票上的仓（归一化 owner/name）。空 = 未声明仓。 */
function ticketRepoOf(it) {
  return it ? normalizeCommanderRepo(it.repo) : '';
}

/**
 * 票是否属于当前指挥官仓。空仓字段与显式本仓 repo 都算本仓——
 * 生产路径 worker-done 会写 `repo: owner/name`，不能把非空一律当跨仓。
 */
function ticketIsHome(it, homeRepo) {
  const repo = ticketRepoOf(it);
  if (!repo) return true;
  const here = normalizeCommanderRepo(homeRepo) || normalizeCommanderRepo(DEFAULT_REPO);
  return Boolean(here) && repo === here;
}

/** stale / 归属键：本仓纯 PR 号，跨仓 `owner/name#pr`。同号不同仓必须分开。
 *  空 repo 与显式本仓 repo 共用纯号——票循环和 PR 循环必须走同一把键。 */
export function ticketScopeKey(it, homeRepo) {
  if (!it || it.pr == null) return null;
  const n = Number(it.pr);
  if (!Number.isFinite(n)) return null;
  if (ticketIsHome(it, homeRepo)) return String(n);
  const repo = ticketRepoOf(it);
  return repo ? `${repo}#${n}` : String(n);
}

/** #1014：attach-reviewer 的 why 按票上记下的来源写，不许写死、不许猜。
 *  来源缺失/不认识 → 「来源没查成」；真失败要把 error 原文带上。 */
export function attachReviewerWhy(ticket) {
  const pr = ticket && ticket.pr != null ? ticket.pr : '?';
  const source = reviewPendingSourceOf(ticket);
  if (source === REVIEW_PENDING_SOURCE_WORKER_DONE_FAIL) {
    const err = ticket && ticket.error != null && String(ticket.error).trim()
      ? String(ticket.error).trim()
      : '（票上没带 error）';
    return `PR #${pr} 工人起审官失败：${err}`;
  }
  if (source === REVIEW_PENDING_SOURCE_COMMANDER_REREVIEW) {
    return `PR #${pr} 交卷可合但没人审，按设计叫审官`;
  }
  if (source === REVIEW_PENDING_SOURCE_WORKER_DONE_HANDOFF
      || source === REVIEW_PENDING_SOURCE_WORKER_DONE) {
    return `PR #${pr} 工人首审已入队，按在役审官数拉取`;
  }
  return `PR #${pr} 复审票来源没查成`;
}

/** 返工去重键：同一 PR 同一 head 只派一次（#931 边界）。act 侧按它记 state.reworkDispatched。
 *  #1236：带判据版本——决定「推不推得动」的代码变了，旧账自动作废（见 lib/retry-epoch.mjs）。 */
export function reworkKey(pr, head) {
  return stampedKey(`rework:${pr}@${head}`);
}

/** #1147 draft 收口泵：次数按张计，不按 head。新提交只影响「超没超龄」，不重置次数。
 *  #1236：同样带判据版本——泵不动的原因若是执行链坏了，修好后该重获机会。 */
export function pumpDraftKey(pr) {
  return stampedKey(`pump-draft:${pr}`);
}

/**
 * #1236：复审键。原先在 decide / execute 各写一份字面量，这次抽成一个函数——
 * 两处必须用**同一个**判据版本，写两份早晚分叉（#909 就是 decide 修了、写侧漏了，
 * 账记到另一个格子，票还在队列却永远走不进 retry-drain）。
 */
export function rereviewKey(pr, head) {
  return stampedKey(`rereview:${pr}@${head}`);
}

/**
 * 「这张 PR 的认定红票投在哪个 commit 上」——**判红投在旧代码上**才是本函数要的答案。
 *
 * 2026-09-14 实咬（#1213 静默 16 小时）：红票投完、返工派成功、工人推了新 head，
 * 新 head 上没人复审 → 叫审官 3 次失败 → 打认输标 → 永久焊死。而「返工已经落地、
 * 那次判定已经过期」这个事实**盘面早就在报**（`rework-awaiting-recheck`），
 * 只是没人拿它去解冻两处：认输标（`planExhaustedLabelClear` 的第 ④ 条）与复审重试账。
 *
 * 两处共用**这一份**结果——`#1233` 的教训就是同一个事实被两处各判一次，早晚分叉。
 *
 * 只收「没查成以外、红票确实不在当前 head 上」的条目：
 *   · reviews 没查成 / 缺 commit_id / head 没查成 → 不进表（没依据，不据此解冻任何东西）；
 *   · 无红票、或最后一条判定就是红且打在当前 head 上 → 不进表（那就是「真的刚判红」，该走返工）。
 *
 * @returns {Map<string, string>} PR 号 → 红票所在 commit oid（旧代码）
 */
export function staleRedBallots({ prs, reviewsByPr } = {}) {
  const out = new Map();
  for (const pr of Array.isArray(prs) ? prs : []) {
    if (!pr || pr.number == null) continue;
    const raw = prReviewInput(reviewsByPr?.[pr.number]);
    if (!Array.isArray(raw)) continue;         // reviews 没抓到 ⇒ 不进表（没查成 = 没依据）
    const atHeadJudge = analyzeReviewsAtHead(raw, pr.headRefOid);
    if (!atHeadJudge.scanned) continue;        // head 没查成 / 有判别态缺 commit_id ⇒ 不进表
    if (atHeadJudge.atHead > 0) continue;      // 当前 head 上有判定 ⇒ 不是「红票投在旧代码上」
    // 注意：这里**不能**读 atHeadJudge.latestRed —— 它只看打在当前 head 上的那几条，
    // atHead === 0 时恒为 false（现场实测：红票投在 dc4c1dd7、head 是 56ad3686，它给 false）。
    // 要问的是「这张 PR 的**全部**判定里，最后一条是不是红」，那是 analyzeReviews 的活儿。
    const all = analyzeReviews(raw);
    if (!all.scanned || all.latestRed !== true) continue;   // 末条不是红 ⇒ 与本判据无关
    const red = [...raw].reverse().find((rv) => {
      if (!rv || typeof rv !== 'object') return false;
      if (normalizeReviewState(rv) !== 'CHANGES_REQUESTED') return false;
      const cid = String(rv.commit_id || rv.commitId || '').trim();
      return Boolean(cid);
    });
    const cid = red ? String(red.commit_id || red.commitId || '').trim() : '';
    if (!cid || cid === String(pr.headRefOid || '').trim()) continue;
    out.set(String(pr.number), cid);
  }
  return out;
}

/**
 * 复审重试键：**同一份红票只该烧一次名额**。
 *
 * `rereview:<pr>@<head>` 只认 head，而「叫不动审官」这件事与 head 无关——同一张红票
 * 叫 3 次失败就打认输（#1213 实测 3 次、#1096 3 次、#885 3 次）。可一旦红票**本来就投在旧代码上**，
 * 那 3 次是在替「旧代码的红」烧的；工人已经推了新 head 之后，这笔账不该继续压着它。
 *
 * 所以键里带上红票所在 commit：红票换了（或红票过期了）⇒ 键变了 ⇒ tries 从 0 起算。
 * 不带 `staleRedAt` 时行为与 `rereviewKey` 逐字一致（没依据永远退回旧行为）。
 */
export function rereviewBudgetKey(pr, head, staleRedAt) {
  const oid = staleRedAt instanceof Map ? staleRedAt.get(String(pr)) : staleRedAt?.[pr];
  const red = typeof oid === 'string' && oid.trim() ? oid.trim() : '';
  return rereviewKey(pr, head) + (red ? `@red:${red}` : '');
}

/**
 * 这份旧红票的**新**复审键已经试满——第 ④ 条解冻过一次之后，又走完了 `@red:<oid>` 名额。
 *
 * 不在这里再判「红票是不是投在旧代码上」（那是 `staleRedBallots` 的事）：本函数只读
 * `rereviewBudgetKey` 算出来的键在账本里的 tries。键没带 `@red:`（没有旧红票 / 没注入表）
 * 或 tries 不到上限 → 不收。`planExhaustedLabelClear` 拿这张表当 ④ 的一次性消费。
 *
 * 旧键 `rereview:<pr>@<head>` 试满不算——那正是 ④ 要解冻的那一轮（9 张现场 PR 的账）。
 *
 * @returns {Map<string, string>} PR 号 → 已经试满的那张红票 oid
 */
export function spentStaleReds({ prs, staleRedAt, reworkDispatched } = {}) {
  const out = new Map();
  const reds = staleRedAt instanceof Map
    ? staleRedAt
    : (staleRedAt && typeof staleRedAt === 'object' && !Array.isArray(staleRedAt)
      ? new Map(Object.entries(staleRedAt)) : new Map());
  const book = reworkDispatched && typeof reworkDispatched === 'object' ? reworkDispatched : {};
  for (const pr of Array.isArray(prs) ? prs : []) {
    if (!pr || pr.number == null) continue;
    const head = typeof pr.headRefOid === 'string' && pr.headRefOid.trim() ? pr.headRefOid.trim() : '';
    if (!head) continue;
    const k = rereviewBudgetKey(pr.number, head, reds);
    const marker = k.lastIndexOf('@red:');
    if (marker < 0) continue;
    const tries = Number(book[k]?.tries) || 0;
    if (tries < MAX_REREVIEW_TRIES) continue;
    const red = k.slice(marker + 5);
    if (red) out.set(String(pr.number), red);
  }
  return out;
}



/**
 * 老单还有没有可执行动作（审查入队 / 判红返工 / 冲突 / 收口泵）。
 * 有 → 新派工最多留 1 个槽位。合并不算：合是指挥官 squash，不占工人会话。
 */
export function oldTicketsHaveWork({ reviewPending, prs, reviewsByPr, draftDueForPump } = {}) {
  if (Array.isArray(reviewPending) && reviewPending.length > 0) return true;
  for (const pr of Array.isArray(prs) ? prs : []) {
    if (!pr || pr.number == null) continue;
    if (typeof draftDueForPump === 'function' && draftDueForPump(pr)) return true;
    if (String(pr.mergeable || '').toUpperCase() === 'CONFLICTING') return true;
    const a = analyzeReviewsAtHead(prReviewInput(reviewsByPr?.[pr.number]), pr.headRefOid);
    if (a.scanned && a.latestRed === true) return true;
  }
  return false;
}

/** draft 距上次提交的毫秒。缺字段 / 解不出 / 没有时钟 → unscanned，绝不当超龄。 */
export function draftCommitAgeMs(pr, nowMs) {
  const raw = pr && pr.lastCommittedAt;
  if (typeof raw !== 'string' || !raw.trim()) {
    return { ok: false, unscanned: true, reason: 'commit-unscanned' };
  }
  const t = Date.parse(raw);
  if (!Number.isFinite(t)) return { ok: false, unscanned: true, reason: 'commit-unscanned' };
  if (!Number.isFinite(nowMs) || nowMs <= 0) {
    return { ok: false, unscanned: true, reason: 'clock-unscanned' };
  }
  return { ok: true, ageMs: nowMs - t, lastCommittedAt: raw };
}

// 框架活的角色标（type/体系）。这类单不进自动派单队列，走快马：主会话子代理闭环（#876，用户 2026-09-04 拍板）。
// 为什么不派：框架活要改的是派单机制本身，让派单机制去派它，等于让手术刀切自己。
export const FRAMEWORK_ROLE = '体系';

// 指挥官派单策略缺省（#1007）：机器余量准入，不再有「每轮派几个」常量。
export const COMMANDER_POLICY_DEFAULTS = {
  requireModelInRouting: true,
  // 主判据（2026-09-10 起）：真 CPU 占用率。loadThreshold 降级为趋势参考，不再当闸。
  cpuThreshold: 0.85,
  loadThreshold: 0.85,
  memReserveMb: 1536,
  conservativeWorkerMb: 400,
  minSamplePairs: 4,
  sampleWindow: 12,
  stalledDraftHours: 24,
  stalledDraftMaxPumps: 2,
};

/** 归一 commander 节。旧键 maxDispatchPerRound 读到打「已改名」提示，不按它限流。 */
export function resolveCommanderPolicy(raw) {
  return resolveAdmissionPolicy(raw);
}

export { RENAMED_KEY_HINT };

/**
 * 派前模型闸（#849）：不在当前选型 → 不派；健康表 red → 不派。
 * enabledIds 不是数组＝选型没查成（fail-closed）。
 */
export function assessDispatchModel(model, { policy, enabledIds, redIds } = {}) {
  const pol = resolveCommanderPolicy(policy);
  const id = model == null ? '' : String(model);
  if (pol.requireModelInRouting) {
    if (!Array.isArray(enabledIds)) {
      return { ok: false, reason: 'model-routing-unscanned', why: `模型 ${id} 的选型没查成，不派` };
    }
    if (!enabledIds.includes(id)) {
      return {
        ok: false,
        reason: 'model-not-in-routing',
        why: `模型标签 model/${id} 不在当前选型（退役或未登记），不派`,
      };
    }
  }
  if (Array.isArray(redIds) && redIds.includes(id)) {
    return { ok: false, reason: 'model-health-red', why: `模型 ${id} 健康表红，不派` };
  }
  return { ok: true };
}

/**
 * 审官顺位分流（#1145）：审官的 leg 不像工人那样被标签钉死（reviewer/ 是家族），
 * 起会话时按审官顺位挑第一条**渠道没满、没熔断、本轮没 429** 的腿；都满 → 排队等下轮。
 * 熔断/健康的逐位真探仍在 act 侧 preflightReviewer；本函数只加「渠道并发」这一层，
 * 供审官选腿处按当前在途快照筛掉满员渠道（与 preflightReviewer 的顺位走法同源）。
 *
 * @param {object} situation  需含 reviewerOrder / routingModelRecords / channelCaps / channelInFlight / breaker / at
 * @param {object} [opts]     { order 覆盖顺位, excluded 本轮 429 渠道集 }
 * @returns pickLeg 的返回（{ok,picked,spilledFrom} | {ok:false,queued,tried,why}）
 */
export function chooseReviewerLeg(situation = {}, { order, excluded } = {}) {
  const ord = Array.isArray(order) ? order : (Array.isArray(situation.reviewerOrder) ? situation.reviewerOrder : []);
  const recs = Array.isArray(situation.routingModelRecords) ? situation.routingModelRecords : [];
  const landingOf = (mid) => {
    const m = recs.find((r) => r && String(r.id) === String(mid));
    if (!m || !m.provider) return null;
    return { provider: m.provider, cli_model: m.cli_model };
  };
  const chSnap = situation.channelCaps && typeof situation.channelCaps === 'object' ? situation.channelCaps : {};
  const nowMs = Date.parse(situation.at || '') || 0;
  return pickLeg({
    order: ord,
    landingOf,
    caps: chSnap.caps || {},
    states: chSnap.states || {},
    inFlight: (situation.channelInFlight && situation.channelInFlight.counts) || {},
    breaker: situation.breaker || null,
    now: nowMs,
    excluded,
    legs: situation.routingLegs,
    models: recs,
  });
}

/**
 * #1094：派工前用 ask-gate 的现成判官看这单动的东西在不在 human_holds。
 * 命中 / 没查成 → manual（没查成不许退回 auto）；扫完不命中 → auto。
 * 关键词表不落在本文件，只认 policy（parsePolicy / loadPolicy 的结果）。
 * 不传 commitType：本闸只管 human_holds，不管发布档位。
 */
function mergePolicyUnscanned(why) {
  return {
    mergePolicy: 'manual',
    mergeReason: `human_holds 没查成：${why}——不许退回 auto`,
    mergePolicySource: 'unscanned',
  };
}

export function resolveIssueMergePolicy(issue, policy) {
  if (labelValue(issue, 'type/') === '体系') {
    return {
      mergePolicy: 'manual',
      mergeReason: 'type/体系 框架活：自动执行，合并必须人工拍板',
      mergePolicySource: 'framework',
    };
  }
  if (!policy || policy.unscanned) {
    return mergePolicyUnscanned(policy?.unscanned || '没拿到策略——判据本身没读到');
  }
  if (!issue || typeof issue !== 'object') {
    return mergePolicyUnscanned('issue 没查成');
  }
  // 正文键缺失 ≠ 正文是空：没扫到正文就只凭标题放行 auto，红线只写在正文里就会漏。
  if (issue.body === undefined || issue.body === null) {
    return mergePolicyUnscanned('issue 正文没查成——不许只凭标题放行 auto');
  }
  const title = issue.title == null ? '' : String(issue.title);
  const text = [title, String(issue.body)].filter((s) => String(s).trim()).join('\n');
  const classified = classifyAsk({ text, policy });
  if (classified.verdict === 'unscanned') {
    return mergePolicyUnscanned(classified.why);
  }
  if (classified.verdict === 'ask') {
    return {
      mergePolicy: 'manual',
      mergeReason: classified.why,
      mergePolicySource: 'hold',
    };
  }
  return {
    mergePolicy: 'auto',
    mergeReason: null,
    mergePolicySource: 'clear',
  };
}

/**
 * 合并侧读派工那一刻写下的 merge-policy，不从当前 issue 现算。
 * #1223：决定产生时写一次、消费方读回来；没查成不许退回 auto。
 *
 * 优先级：账本 auto|manual → 账本没查成/缺字段 → 署名单号有、对象没有 → 现有 issue 分类
 * → 无署名且无账本（非派工链 PR）才 auto。老夹具不传账本面（ledgerPick=null）走后半。
 */
export function resolveLandMergePolicy({
  issue = null,
  attributedNumber = null,
  ledgerPick = null,
  policy = null,
} = {}) {
  if (ledgerPick && ledgerPick.ok && (ledgerPick.mergePolicy === 'auto' || ledgerPick.mergePolicy === 'manual')) {
    return {
      mergePolicy: ledgerPick.mergePolicy,
      mergeReason: ledgerPick.mergeReason
        || (ledgerPick.mergePolicy === 'manual' ? '账本记的是 manual' : null),
      mergePolicySource: 'ledger',
    };
  }
  if (ledgerPick && (ledgerPick.unscanned || ledgerPick.state === 'missing-field')) {
    return mergePolicyUnscanned(ledgerPick.error || ledgerPick.state || '账本没查成');
  }
  const n = attributedNumber != null ? Number(attributedNumber) : null;
  if (Number.isInteger(n) && n > 0 && !issue) {
    return mergePolicyUnscanned(`署名 issue #${n} 没查到——不许退回 auto`);
  }
  if (issue) return resolveIssueMergePolicy(issue, policy);
  return {
    mergePolicy: 'auto',
    mergeReason: null,
    mergePolicySource: 'no-issue',
  };
}

function ledgerPickForLand(situation, pr, issueNo) {
  const led = situation && situation.dispatchLedger;
  if (!led) return null;
  if (led.scanned !== true) {
    return { ok: false, unscanned: true, state: 'unscanned', error: led.error || '账本没查成' };
  }
  return pickMergePolicyFromLedger({
    events: led.events,
    issue: issueNo,
    pr: pr && pr.number,
  });
}

/** act 侧把 decide 的 merge-policy 翻成 dao.mjs dispatch 旗标。
 * auto 不传（跟底层缺省合）；manual 必须带理由。字段缺失 / 非法值一律 manual——没查成不许退回 auto。 */
export function dispatchMergePolicyArgs(action) {
  if (action && action.mergePolicy === 'auto') return [];
  const reason = String(action && action.mergeReason || '').trim()
    || (action && action.mergePolicy === 'manual'
      ? 'human_holds 命中但理由没写上——不许退回 auto'
      : `merge-policy 没查成（${action && action.mergePolicy != null ? action.mergePolicy : '空'}）——不许退回 auto`);
  return ['--merge-policy', 'manual', '--merge-reason', reason];
}

/** 标签取值：`model/grok-4.6` → 传 prefix 'model/' 得 'grok-4.6'。issue / PR 都能用。取第一个命中，没有返回 null。 */
export function labelValue(issue, prefix) {
  const labels = Array.isArray(issue?.labels) ? issue.labels : [];
  for (const l of labels) {
    const name = l && typeof l.name === 'string' ? l.name : '';
    if (name.startsWith(prefix)) return name.slice(prefix.length);
  }
  return null;
}

/**
 * 一张 PR 的审官 review 历史 → 判别态。入参按时间序（旧→新）。
 * 认 GitHub state（APPROVED / CHANGES_REQUESTED）；兼容旧夹具里的判定行字符串。
 * 返回：
 *   { scanned:false }                 —— 入参不是数组（没查成）
 *   { redRounds:N, green:bool, latestGreen:bool }
 */
export function analyzeReviews(reviews) {
  if (!Array.isArray(reviews)) return { scanned: false };
  const mapped = reviews.map((item) => {
    if (item && typeof item === 'object' && (item.state || item.body != null)) return item;
    const s = String(item || '');
    if (/^\s*(?:[>*]\s*)*(判定|复核结论)[:：].*绿/.test(s) && !/红\s*\d+\s*项/.test(s)) return { state: 'APPROVED' };
    if (/^\s*(?:[>*]\s*)*(判定|复核结论)[:：].*红\s*\d+\s*项/.test(s)) return { state: 'CHANGES_REQUESTED' };
    return { state: 'COMMENTED' };
  });
  return analyzeGithubReviews(mapped);
}

/**
 * 只数「打在当前 PR head 上」的红/绿。
 *
 * 判绿只对它当时看的那个 commit 有效（memory review-green-must-match-head）——反过来同样成立：
 * 判红也只对当时那个 commit 有效。工人返工推了新 head，旧 review 挂在旧 commit 上，
 * 不能再当「仍红」。#911–#918 一夜八张重复报帅单就是拿历史累计红轮数判出来的。
 *
 * 三种「没查成」，一律 fail-visible，**绝不**当成「head 变了所以清零」，也不当成「仍红」：
 *   reviews-missing     —— 这张 PR 的 reviews 没抓到（既有契约：静默跳过，不臆测）
 *   head-unscanned      —— PR headRefOid 没查成，无从判断红打在哪个 commit 上
 *   commit-id-unscanned —— 有判别态 review 缺 commit_id，无从判断它属于哪个 commit
 *
 * 查成时返回 analyzeGithubReviews 的形态（redRounds/green/latestGreen/latestRed），
 * 外加 head（当前 head）、judgedTotal（历史判别态总数）、atHead（其中打在当前 head 上的条数）、
 * judged（打在当前 head 上的那几条 review 原件——返工任务书要拿红项**全文**，#931）。
 */
export function analyzeReviewsAtHead(reviews, head) {
  if (!Array.isArray(reviews)) return { scanned: false, reason: 'reviews-missing' };
  const h = typeof head === 'string' ? head.trim() : '';
  if (!h) return { scanned: false, reason: 'head-unscanned' };
  const judged = [];
  const events = [];
  for (const rv of reviews) {
    const state = normalizeReviewState(rv);
    if (state !== 'APPROVED' && state !== 'CHANGES_REQUESTED' && state !== 'DISMISSED') continue;
    const cid = rv && typeof rv === 'object' ? String(rv.commit_id || rv.commitId || '').trim() : '';
    if (!cid) return { scanned: false, reason: 'commit-id-unscanned' };
    const event = { rv, cid, state };
    events.push(event);
    if (state !== 'DISMISSED') judged.push(event);
  }
  const atHeadEvents = events.filter((x) => x.cid === h);
  const lastDismissed = atHeadEvents.map((x) => x.state).lastIndexOf('DISMISSED');
  const effectiveAtHead = (lastDismissed >= 0 ? atHeadEvents.slice(lastDismissed + 1) : atHeadEvents)
    .filter((x) => x.state !== 'DISMISSED');
  return {
    // DISMISSED 要留在当前 head 的时间序列里，才能终止同 head 上的旧 APPROVED；
    // 但它不是有效判定，所以 atHead / judged 仍只统计 APPROVED 与 CHANGES_REQUESTED。
    ...analyzeGithubReviews(effectiveAtHead.map((x) => x.rv)),
    head: h,
    judgedTotal: judged.length,
    atHead: effectiveAtHead.length,
    judged: effectiveAtHead.map((x) => x.rv),
  };
}

/**
 * 当前 head 上**最后一条**判红 review 的正文全文（#931：任务书带红项全文，不摘要）。
 * 空正文 / 拿不到 = 没查成（返回 null）——审官判了红却没留正文，返工工人无从下手，
 * 这时不许派工（「没查成」不许触发派工）。
 */
export function latestRedBody(judgedAtHead) {
  const list = Array.isArray(judgedAtHead) ? judgedAtHead : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (normalizeReviewState(list[i]) !== 'CHANGES_REQUESTED') continue;
    const body = list[i] && typeof list[i] === 'object' ? String(list[i].body || '') : '';
    return body.trim() ? body : null;
  }
  return null;
}

/**
 * 从 prReviews.byPr[n] 取给 analyzeReviews 的入参：优先 `.reviews`（[{state, body}]，认 GitHub state），
 * 缺时才回退 `.bodies`（旧夹具的判定行字符串）。#807 后 reviewer-book 不再写「判定：」行，
 * 只喂 bodies 会把真 approve 判成 approved-without-review、两轮 request-changes 判成 noop。
 */
function prReviewInput(entry) {
  if (!entry || typeof entry !== 'object') return undefined;
  if (Array.isArray(entry.reviews)) return entry.reviews;
  return entry.bodies;
}

function dockOf(situation, prNumber) {
  const table = situation && situation.dockByPr;
  if (table == null || typeof table !== 'object') {
    return { state: 'unknown', why: '对接证明没采' };
  }
  const v = table[prNumber] != null ? table[prNumber] : table[String(prNumber)];
  if (!v || typeof v !== 'object') return { state: 'unknown', why: '这张 PR 没有对接证明' };
  return v;
}

/**
 * 生产取证：只对「旧批准、当前 head 零判定」的 PR 跑树级对接证明。
 * decide 保持纯函数，证明表由眼睛注入 situation.dockByPr。
 */
export function collectDockProofs(situation, { run, masterRef = 'origin/master' } = {}) {
  const prs = (situation && situation.github && situation.github.prs) || [];
  const byPr = (situation && situation.prReviews && situation.prReviews.byPr) || {};
  const out = {};
  for (const pr of prs) {
    if (!pr || pr.number == null) continue;
    const raw = prReviewInput(byPr[pr.number]);
    const mergeA = analyzeReviewsAtHead(raw, pr.headRefOid);
    const last = lastJudgmentOf(analyzeReviews(raw));
    const greenAtHead = mergeA.scanned && mergeA.latestGreen === true;
    const atHead = mergeA.scanned ? mergeA.atHead : null;
    const approved = lastApprovedCommitId(raw);
    // DISMISSED 撤销了旧批准：即使虚拟合入树相同也不得继承，要当前 HEAD 重新拿到 APPROVED。
    if (approved.revoked && greenAtHead !== true && atHead === 0) {
      out[pr.number] = { state: 'unknown', why: '批准已被 DISMISSED 撤销，不得继承' };
      continue;
    }
    if (!needsDockProof({
      greenAtHead,
      atHead,
      lastJudgment: last,
    })) continue;
    if (!approved.scanned || !approved.commit) {
      out[pr.number] = { state: 'unknown', why: '批准 commit 没查成' };
      continue;
    }
    if (typeof run !== 'function') {
      out[pr.number] = { state: 'unknown', why: '取证 run 没给' };
      continue;
    }
    out[pr.number] = provePureDock({
      approved: approved.commit,
      head: pr.headRefOid,
      masterRef,
      run,
    });
  }
  return out;
}

function esc(why, extra = {}) {
  return { kind: 'escalate', why, ...extra };
}
function hub(subject, moment, extra = {}) {
  // moment ∈ {dispatched, decide, merged, stuck, heartbeat}：四个回流时刻 + 心跳
  return { kind: 'notify-hub', subject, moment, ...extra };
}

// 态势的必查节。scan 每节标 scanned:true/false。
// 2026-09-06 `orca` → `trees`：orca 运行时已 disabled，它**永远**没查成，
// 于是 fail-closed 总闸从「读不到盘面就别乱动」退化成「每一轮都别动」。
// 一个恒红的闸等于没有闸，而且它压掉的是真该做的动作。
// `orca` 段仍在态势里（还有没搬完的消费者读它），但不再决定这一轮能不能动手。
// `trees` 进清单：树面没查成 ≠ 没有在途工人，少派一轮可恢复，重复派工不可恢复。
// #1055：必查清单只认这一处——situationHealth 跟决策层同一份，复制一份会再钉死。
export const SITUATION_SECTIONS = ['github', 'trees', 'reviewPending', 'prReviews', 'stall'];

// 复审重试：上一票的宽限期与上限。
// 宽限期要大于「审官从起来到落判定」的常见耗时，否则审官正在看的时候就被重发一张票；
// commander-act 20 分钟一轮，45 分钟约等于「连着两轮都没等到判定才重发」。
// 上限是为了别死循环——试满仍无判定就停手交人（判据：当前 head 判定仍是 0）。
export const REREVIEW_GRACE_MIN = 45;
/**
 * 一轮里最多同时起几个**收尾**动作（叫审官 / 返工 / 解冲突 / 收口泵）。
 *
 * 为什么收尾要有自己的一笔名额、不跟新活共用：机器余量闸的本意是「别再开新活」，
 * 而它原先连「把手上这些活收掉」一起拦——机器一满（slots=0），25 张 PR 一条判定都没有，
 * 满载空转等收尾（2026-09-10 实咬，见 finishSlots 处的注释）。
 *
 * **上限不是手打的数**（2026-09-14 改）：原先写死 3，依据只是「一轮里开太多不好定位」的人体工学，
 * 不是任何资源。实测 13 小时 40 轮里 14 轮被这个 3 卡住、少派 28 个收尾动作，而同期机器准入
 * 报的是「还能收 28 张」——手打常量比真实容量紧一个数量级，正是 memory `hand-typed-constant-will-be-wrong`。
 *
 * 现在按机器比例算（`finishSlotCap`），依据是 2026-09-08 拍板「机器闸保持比例式（0.85×核数）」：
 * 换大 VPS 时并发自动跟着扩，没有第二处要人记得去改的数字。
 */
export const FINISH_SLOTS_FLOOR = 2;

/**
 * 收尾名额上限 = 核数（floor 2）。
 *
 * 为什么是「核数」而不是 0.85×核数：那条比例是给**新活**用的，新活是内存密集的长会话；
 * 收尾是等模型回话的 IO（实测审官进程 ~2% CPU），每核跑一条仍有大量空闲。取核数是保守侧——
 * 真按 IO 密度能开更多，但那要闭环死因数据支撑，现在还没有（见 #1145 档案「最终判据永远是
 * 真实派工的会话死因统计」，而 execution/sessions 记录里根本没有 error 字段）。
 *
 * floor 2 保住 2026-09-10 那条性质：机器再满也得有收尾名额，否则 25 张 PR 一条判定都没有。
 * `cores` 读不到（老夹具/准入没吐）→ 回落到 floor，**不猜一个默认核数**。
 */
export function finishSlotCap(cores) {
  if (!Number.isInteger(cores) || cores <= 0) return FINISH_SLOTS_FLOOR;
  return Math.max(FINISH_SLOTS_FLOOR, cores);
}
export const MAX_REREVIEW_TRIES = 3;
// 返工派工失败后的重试节奏。与 drain / 复审同一套语义（45 分钟宽限、试满 3 次停手交人），
// 故意不另造一套数字：三条路犯的是同一个「派了 ≠ 成了」，节奏不同只会让人以为它们是三件事。
export const REWORK_RETRY_GRACE_MIN = 45;
export const MAX_REWORK_TRIES = 3;

/**
 * 「返工派成功了」的那条账多久之后可以当**工人已经死了**。
 * 必须比 REWORK_RETRY_GRACE_MIN 宽：那条管的是「派失败了多久能再试」，这条管的是
 * 「派成功了多久还没动静就算它没了」——后者要把工人真正干活的时间让出来，不然会在
 * 工人干到一半时再派一个，两个工人抢同一棵树。
 */
export const REWORK_ORPHAN_GRACE_MIN = 180;

/**
 * 派成功的返工是不是**已经没人在做了**（孤儿）。
 *
 * 三条必须同时成立，缺一不解冻——解冻的代价是重复工人，比多等一轮贵：
 *   ① 会话面确知「没有这条的活会话」：unscanned / unavailable 一律不算（fail-closed）
 *   ② 距派出去超过 REWORK_ORPHAN_GRACE_MIN：给工人真正干活的时间
 *   ③ head 没动：工人推了新东西 = 它活着或已交卷，这条账本来就不该再用
 *
 * ③ 在调用方天然成立（账本键就带 head），这里仍显式核一次——键的形状将来可能改，
 * 判据不该指望键里恰好含着它要的事实。
 *
 * @param prev 账本里那条 `{ at, ok, head }`
 * @param situation 取会话名单用；没有 sessions 节 ⇒ 观测面未接入 ⇒ 不解冻
 */
export function judgeReworkOrphan(pr, { prev, nowMs, situation } = {}) {
  if (!prev || prev.ok !== true) return { orphan: false, why: '不是一条派成功的账' };
  const head = typeof prev.head === 'string' ? prev.head.trim() : '';
  const cur = pr && typeof pr.headRefOid === 'string' ? pr.headRefOid.trim() : '';
  if (!head || !cur || head !== cur) return { orphan: false, why: 'head 已经动了或没查成' };
  const at = Date.parse(prev.at || '');
  if (!Number.isFinite(at) || !Number.isFinite(nowMs)) return { orphan: false, why: '派出时刻没查成' };
  const ageMin = (nowMs - at) / 60000;
  if (ageMin < REWORK_ORPHAN_GRACE_MIN) {
    return { orphan: false, why: `才派出去 ${Math.round(ageMin)} 分钟，还没到 ${REWORK_ORPHAN_GRACE_MIN} 分钟`, ageMin };
  }
  const live = hasLiveExecutor({
    sessions: sessionListForLiveness(situation),
    pr: pr && pr.number,
    issue: attributedIssueNumber(pr),
    branch: pr && pr.headRefName,
  });
  if (live.unavailable) return { orphan: false, why: '会话观测面未接入，不猜' };
  if (live.unscanned) return { orphan: false, why: '会话名单没查成，不猜' };
  if (live.live) return { orphan: false, why: '还有活会话在做' };
  return {
    orphan: true, ageMin,
    why: `返工 ${Math.round(ageMin / 60)} 小时前派成功，此后 head 一个字没动、会话名单里也没有活会话——工人已经没了`,
  };
}

/**
 * 署名 issue 仍给 merge-policy / human_holds 用（正文在 issue 上）。
 * 选型（谁写码、谁来审）只读 PR 自己的 label（#1116），不从这里反推。
 *
 * 已关闭的单**只用来读正文**，绝不并进 `github.issues`——那张表是派工候选表。
 */
export function attributedIssueOf(gh = {}, pr) {
  const n = attributedIssueNumber(pr);
  if (n == null) return null;
  return (gh.issues || []).find((i) => i && i.number === n)
    || (gh.attributedIssues || []).find((i) => i && i.number === n)
    || null;
}

/** #1116：审官型号只读这张 PR 自己的 reviewer/*。没标就是没有，不回退去读 issue。 */
export function reviewerLabelFor(_gh = {}, pr) {
  return labelValue(pr, 'reviewer/');
}

/** owner/name 小写；非法或空串不当仓键。 */
export function normalizeCommanderRepo(raw) {
  const s = String(raw || '').trim().toLowerCase();
  return /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(s) ? s : '';
}

/**
 * 票仓非空且与本仓不同才算跨仓。
 * 本仓交卷票本来就会带 repo（worker-done 写 owner/name，scanReviewPending 原样保留），
 * 不能把「有 repo 字段」当成跨仓——否则死票占名额、也不产 reap-ticket。
 */
export function ticketRepoIsForeign(ticketRepo, homeRepo) {
  const want = normalizeCommanderRepo(ticketRepo);
  const here = normalizeCommanderRepo(homeRepo) || normalizeCommanderRepo(DEFAULT_REPO);
  return Boolean(want && here && want !== here);
}

function prRepoOf(pr) {
  if (!pr || typeof pr !== 'object') return '';
  if (typeof pr.repo === 'string') return normalizeCommanderRepo(pr.repo);
  if (typeof pr.repository === 'string') return normalizeCommanderRepo(pr.repository);
  return normalizeCommanderRepo(pr.repository && pr.repository.nameWithOwner);
}

/**
 * 差集重派对应的开放 PR。匹配键是仓 + PR 号（没记 PR 号时才用署名单唯一命中）。
 * 目标仓不是当前指挥官仓、或该仓对不上本仓开放 PR → 没有，不拿同号本仓 PR 顶。
 */
export function correspondingPrForRedispatch(rd, prs, { homeRepo } = {}) {
  const list = Array.isArray(prs) ? prs : [];
  const wantRepo = normalizeCommanderRepo(rd && rd.repo);
  const here = normalizeCommanderRepo(homeRepo) || normalizeCommanderRepo(DEFAULT_REPO);
  if (ticketRepoIsForeign(rd && rd.repo, homeRepo)) return null;
  const scoped = list.filter((p) => {
    if (!p) return false;
    const prRepo = prRepoOf(p);
    if (prRepo && here && prRepo !== here) return false;
    if (prRepo && wantRepo && prRepo !== wantRepo) return false;
    return true;
  });
  if (rd && rd.pr != null) {
    const n = Number(rd.pr);
    if (!Number.isInteger(n) || n <= 0) return null;
    return scoped.find((p) => Number(p.number) === n) || null;
  }
  const issue = Number(rd && rd.issue);
  if (!Number.isInteger(issue) || issue <= 0) return null;
  const hits = scoped.filter((p) => attributedIssueNumber(p) === issue);
  return hits.length === 1 ? hits[0] : null;
}

// 声明式依赖表：每个动作 kind 的「必要节」——任一未 scanned，该动作在入口总闸一律不产。
// notify-hub / land 是随附动作，产出处会用 _needs 显式继承主动作的依赖（下面 hub/withNeeds）。
// escalate 是 fail-visible 出口、noop 是空态势——本身不依赖任何节。
// 审官 #840 红①要求：不靠各分支散落 if 挡 unscanned，改在 decide 入口按此表统一 fail-closed。
export const ACTION_NEEDS = {
  // 2026-09-06 摘掉 orca 依赖：派工/返工的建树起工人已切 mirasim（dao.mjs 的
  // MIRASIM_IS_ONLY_PATH），orca 节查不查得到都不影响这两个动作能不能干成。
  // 摘之前实测过后果：orca-serve 一停，这里的 fail-closed 让 commander 一个动作都不产，
  // 整条自动化停摆——依赖表没跟上执行体切换，就成了退役的最后一道锁。
  // #1055：orca 也不再进 SITUATION_SECTIONS——只摘 ACTION_NEEDS 不够，总闸按节清单
  // 合上，退役后每天仍刷「没查成的节：orca」。
  dispatch: ['github', 'prReviews'],
  rework: ['github', 'prReviews'],
  'attach-reviewer': ['github', 'reviewPending'],
  rereview: ['github', 'prReviews'],
  merge: ['github', 'prReviews'],
  land: ['github', 'prReviews'],
  'wake-brain': ['github', 'prReviews', 'stall'],
  'notify-hub': [],
  escalate: [],
  noop: [],
  'add-label': ['github'],
  'retry-drain': ['reviewPending'],
  'open-issue': [],
  // 回收死票要同时知道「队列里有什么」和「哪些 PR 还开着」——少一节都会把活票当死票剪掉。
  'reap-ticket': ['github', 'reviewPending'],
  // 摘「自动化认输」标要知道 PR 的当前 head 与 labels（都在 github 节）。
  // 2026-09-14：第 ④ 条（红票投在旧代码上）要 prReviews——但**不**加进依赖节：
  // 「reviews 没查成 ⇒ 连『推了新 head 该摘标』都不做」是把一条独立判据连坐停了。
  // reviews 没查成时 staleRedAt 为空表，第 ④ 条自然不成立，其余三条照常。fail-closed 落在
  // 判据内部（缺证据 ⇒ 不动手），不是靠把 github 节也一起停掉。
  'clear-exhausted': ['github'],
  // 认输打标写的是 PR。github 没查成不知道有没有标，不许盲打。
  'mark-exhausted': ['github'],
  'stop-session': [],
  // 幽灵进程只认 /proc + 会话名单；两面都由 collectCandidates 自己看 scanned，不进总闸。
  'reap-orphan': [],
  // #1147 draft 收口泵：只认 github 上的 draft + lastCommittedAt。会话名单不进
  // SITUATION_SECTIONS（没查成只挡住泵，不许把合并/叫审官整轮停掉）。
  'pump-draft': ['github'],
  // 清树：github 用来核 PR/issue 态。树面/会话名单没查成由 planTreeReaps 自己 skip，
  // 不进总闸——不能因为清不了树就把合并/叫审官整轮停掉。
  'reap-tree': ['github'],
};

// 决不能出现在自动路径里的动作（审官建议的「自动路径边界」）：清树 / 写指纹 / 改 dao.mjs 等
// 有破坏性或越界的动作，指挥官自动层永不产出——归帅或归别的在途单。
export const FORBIDDEN_AUTO_KINDS = new Set([
  'worktree-rm', 'worktree-remove', 'rm-tree', 'write-fingerprint', 'edit-dao', 'merge-force',
]);

function withNeeds(action, needs) { return { ...action, _needs: needs }; }

/** 半标能推出唯一跨厂值 → add-label；推不出保持 null，调用方报帅（查不到 ≠ 猜一个）。 */
function maybeAddLabel(target, situation, extra = {}, needs) {
  if (!target || target.number == null) return null;
  const proposed = proposeAddLabel({
    existingLabels: target.labels,
    models: situation.routingModelRecords,
    reviewerOrder: situation.reviewerOrder,
    workerOrder: situation.workerOrder,
  });
  if (!proposed.ok) return null;
  // on:'pr' 打到 PR（交卷后选型，#1116）；否则打到 issue（派工前半标）。
  const dest = extra.on === 'pr'
    ? { pr: extra.pr ?? target.number }
    : { issue: extra.issue ?? target.number, ...(extra.pr != null ? { pr: extra.pr } : {}) };
  return withNeeds({
    kind: 'add-label',
    ...dest,
    labels: proposed.labels,
    existingLabels: target.labels,
    workerId: proposed.workerId,
    reviewerId: proposed.reviewerId,
    models: situation.routingModelRecords,
    why: extra.why,
  }, needs);
}

/**
 * 收集「候选动作」：各分支照常按数据产候选，正向动作带 _needs（依赖节），由入口总闸统一裁定产不产。
 * 分支内只做「数据在不在」的安全读取（可选链 + || []），不再用 section.scanned 挡正向产出——
 * fail-closed 由总闸按 ACTION_NEEDS 统一做（审官 #840 红①：散落 if 会漏，交叉组合能绕过）。
 */
function collectCandidates(situation) {
  const out = [];
  const gh = situation.github || {};
  const rp = situation.reviewPending || {};
  const reviews = situation.prReviews || {};
  const stall = situation.stall || {};
  const wakeCounts = situation.wakeCounts || {};
  const reworkDispatched = situation.reworkDispatched || {};
  // 「认定红票投在旧代码上」这张表由**调用方**注入（commander.mjs 用 staleRedBallots 算一次，
  // 与 planExhaustedLabelClear 共用同一份）——decide 是纯函数，不自己再扫一遍 reviews：
  // 同一个事实两处各判一次，早晚分叉（#1233 的教训）。没注入 = 空表 = 这两条解冻永不成立。
  const staleRedAt = situation.staleRedAt instanceof Map
    ? situation.staleRedAt
    : (situation.staleRedAt && typeof situation.staleRedAt === 'object'
      ? new Map(Object.entries(situation.staleRedAt)) : new Map());
  const effectiveMergeability = new Map();
  const homeRepo = situation.repo || DEFAULT_REPO;
  // 时钟从态势里取（不用 Date.now）：decide 是纯函数，同一份态势必须产同一批动作。
  const nowMs = Date.parse(situation.at || '') || 0;
  let reworkThisRound = 0;
  const policy = resolveCommanderPolicy(situation.commanderPolicy);
  const enabledIds = situation.routingModels;
  const redIds = situation.healthRedModels;
  const N = ACTION_NEEDS;

  // ① 已消歧 + 无在途派工 → dispatch（缺标签 / 模型不在选型 / 健康表红 = 报帅不派）
  // #1007：闸是机器余量，不是「每轮派几个」。容量没查成 → 一张都不派（fail-close）。
  // 树面来自 situation.trees（mirasim，见 lib/mirasim-trees.mjs），**不再是 orca.worktrees**。
  // 2026-09-06 实咬：orca 退役后那一段恒 scanned:false，而这里原来写着 `orca.worktrees || []`
  // ——「没查成」被洗成「查过没有」，于是已消歧且还没开 PR 的单每 20 分钟被重复派一次。
  // 现在**不给兜底空数组**：树面没查成就让 inspectReadyQueue 判 unscanned，一张都不派。
  // 少派一轮是可恢复的，重复派工烧掉的额度和两个工人打架不是。
  // 「有没有活执行者」仍只问下面 hasLiveExecutor（#1056 唯一活性口），不拿卡面猜。
  const treeFace = situation.trees;
  const ready = treeFace && treeFace.scanned === true
    ? inspectReadyQueue({ issues: gh.issues || [], prs: gh.prs || [], worktrees: treeFace.worktrees })
    : {
      kind: 'unscanned',
      ready: null,
      line: `可立即起：没查成（${(treeFace && treeFace.error) || '树面没给'}，≠ 扫完是 0）`,
    };
  const admission = situation.admission;
  // 生产路径 buildSituation 必填 admission。夹具缺席 = 不限张（旧测兼容，不当成 0 放开闸的反面）。
  let dispatchSlots = Infinity;
  let admissionUnscanned = false;
  if (admission && admission.ok === false) {
    dispatchSlots = 0;
    admissionUnscanned = true;
  } else if (admission && Number.isInteger(admission.slots)) {
    dispatchSlots = Math.max(0, admission.slots);
  } else if (admission != null) {
    dispatchSlots = 0;
    admissionUnscanned = true;
  }
  // #1007 二期：**起会话的动作共用一个预算**，不是各管各的。
  // 审官现在算进在途分母（它吃同一份 CPU 和内存），那它就必须同样消耗名额——
  // 只改分母不改消耗，等于让新派单被限住、审官照旧不限张，闸只挡了一半。
  //
  // 优先级是「收尾先于开新」（工作队列常识：在制品堆着不收尾，吞吐只会更差）。
  // 复审票的数量本轮一开始就知道，所以先把名额留出来，剩下的才给新派单；
  // 返工与复审共用剩余额度，谁先跑到谁先拿。
  let slotsLeft = dispatchSlots;
  // #1125：drain 自己按在役数拉，decide 每轮只产一条 attach-reviewer。
  // 预留按票数会把新活全挤掉——队列里 18 张时 finishReserve=18，新活永远派不出。
  // 有票就留 1 个名额喊一次 drain，剩下的给新活。
  // #1147：收口泵也是收尾。预留只数「真能派出」的 draft：缺标签 / 模型派不出只 escalate、不 takeSlot。
  const stalledHoursMs = Number(policy.stalledDraftHours) * 3600 * 1000;
  const maxPumps = Number(policy.stalledDraftMaxPumps) || 2;
  const sessionsForLive = sessionListForLiveness(situation);
  const draftStalledForPump = (pr) => {
    if (!pr || pr.number == null || !pr.isDraft) return false;
    if (prHasStuckLabel(pr)) return false;
    const age = draftCommitAgeMs(pr, nowMs);
    if (!age.ok || age.ageMs < stalledHoursMs) return false;
    const live = hasLiveExecutor({
      sessions: sessionsForLive,
      pr: pr.number,
      issue: attributedIssueNumber(pr),
      branch: pr.headRefName,
    });
    if (live.live || live.unavailable) return false;
    const prev = reworkDispatched[pumpDraftKey(pr.number)];
    if (prev && prev.unscanned === true) return false;
    return true;
  };
  const draftDueForPump = (pr) => {
    if (!draftStalledForPump(pr)) return false;
    const tries = Number(reworkDispatched[pumpDraftKey(pr.number)]?.tries) || 0;
    return tries < maxPumps;
  };
  /** 跟 pushPumpDraft 派出前校验同一套：有标签且模型过闸（含顶班）才算能占名额。
   * #1116：选型只读这张 PR 自己的 model/* reviewer/*，不从署名单反推。 */
  const resolvePumpDraftDispatch = (pr) => {
    const issueNo = attributedIssueNumber(pr);
    const rIssue = attributedIssueOf(gh, pr);
    const rModel = labelValue(pr, 'model/');
    const rReviewer = labelValue(pr, 'reviewer/');
    if (!rModel || !rReviewer) {
      return { ok: false, reason: 'missing-labels', issueNo, rIssue, rModel, rReviewer };
    }
    let rGate = assessDispatchModel(rModel, { policy, enabledIds, redIds });
    let pumpModel = rModel;
    let substituted = null;
    if (!rGate.ok && (rGate.reason === 'model-not-in-routing' || rGate.reason === 'model-health-red')) {
      const fb = situation.defaultWorkerModel;
      const fbGate = fb ? assessDispatchModel(fb, { policy, enabledIds, redIds }) : { ok: false };
      if (fb && fbGate.ok) {
        substituted = { from: rModel, to: fb, why: rGate.why };
        pumpModel = fb;
        rGate = fbGate;
      }
    }
    if (!rGate.ok) {
      return { ok: false, reason: rGate.reason, why: rGate.why, issueNo, rIssue, rModel, rReviewer };
    }
    return { ok: true, issueNo, rIssue, rModel, rReviewer, pumpModel, substituted };
  };
  const stalledPumpCount = (gh.prs || []).filter((pr) => {
    if (!draftDueForPump(pr)) return false;
    return resolvePumpDraftDispatch(pr).ok;
  }).length;
  // 收尾名额与「新活名额」是两笔账，**不共用**。
  //
  // 2026-09-10 实咬：原先 finishReserve 从 dispatchSlots 里切，机器一满（slots=0）就
  // 切不出任何收尾名额，于是叫审官、解冲突、返工全被机器余量闸挡住——**闸的本意是
  // 「别再开新活」，实际把「把手上这些活收掉」也一起拦了**。现场：10 个 grok 工人把
  // 负载顶到 1.7–2.0，25 张 PR 一条判定都没有（#1129 甚至已有两条 APPROVED 打在
  // 当前 head 上），机器满载却在空转等收尾。
  //
  // 收尾为什么不该被余量闸拦：它不增在制品，是把已有的活推过终点线；审官会话本机
  // 开销也小（进程平均 2% CPU，其余是等模型回话的 IO 等待）。所以收尾名额**不受
  // dispatchSlots 约束**，只受下面自己的上限（本机同时最多几个收尾动作）管。
  // 反过来，机器满载时新活仍然一个不派——那半边的本意不动。
  // 死票（已合并/已关）只产 reap-ticket，不占会话名额（审官红③ / #1291）。
  // 存活判据与下面回收那一节同一把尺：没扫成 / 窗口截断 / 跨仓都不能证明它死了。
  const PR_WINDOW = 100;
  const prList = gh.prs || [];
  const ghScanned = gh.scanned === true && prList.length < PR_WINDOW;
  const openPrs = new Set(prList.map((p) => Number(p?.number)).filter(Number.isFinite));
  const reviewTicketIsLive = (it) => {
    if (!it || it.pr == null) return false;
    // 只有票仓非空且与本仓不同，才按跨仓票保守保活。本仓带同值 repo 的票仍按 openPrs 判死。
    if (ticketRepoIsForeign(it.repo, situation.repo)) return true;
    if (!ghScanned) return true;
    return openPrs.has(Number(it.pr));
  };
  const liveReviewItems = (rp.items || []).filter(reviewTicketIsLive);
  const reviewReserve = liveReviewItems.length > 0 ? 1 : 0;
  const finishReserve = reviewReserve + stalledPumpCount;
  // 老单还有审查/返工/冲突/收口泵时，普通新单最多 1 个槽位（#1174）。
  const agingBusy = oldTicketsHaveWork({
    reviewPending: liveReviewItems,
    prs: gh.prs,
    reviewsByPr: reviews.byPr,
    draftDueForPump,
  });
  const newWorkSlots = capNewDispatchSlots(Math.max(0, slotsLeft - finishReserve), agingBusy);
  // 收尾名额池：非负的 dispatchSlots 之外**另拿**一笔，上限见 finishSlotCap（按核数，不是手打常量）。
  // slots=Infinity（老夹具/未接准入）时跟着不限张，维持既有契约。
  //
  // **admission 没查成时收尾也归零**：读不到机器信号就不该起任何会话（fail-close），
  // 收尾同样吃 CPU——「读不到 ≠ 可以随便派」这条对两笔账一视同仁。
  // （写这版时先漏了这一格，shared-slots 的既有用例当场抓住：0 == 1。）
  let finishSlots = admissionUnscanned ? 0
    : (dispatchSlots === Infinity ? Infinity : finishSlotCap(admission?.cores));
  // 收尾名额被领光的次数。**必须报**：原先名额用尽是完全静默的（reportAdmission 只在
  // admissionUnscanned / dispatchSlots===0 时说话），于是「这一轮想派 10 个只派了 3 个」
  // 在盘面上和「本来就只有 3 个要派」长得一模一样——限流不可观测，等于没人会去调它。
  let finishDenied = 0;
  /** 领一个收尾名额（叫审官/返工/解冲突/收口泵）。不占新活名额。 */
  const takeFinishSlot = () => {
    if (finishSlots <= 0) { finishDenied += 1; return false; }
    finishSlots -= 1;
    return true;
  };
  /** 领一个名额。领不到回 false，调用方排队下一轮（不丢、不 escalate）。 */
  const takeSlot = () => {
    if (slotsLeft <= 0) return false;
    slotsLeft -= 1;
    return true;
  };

  let admissionReported = false;
  const reportAdmission = (kind) => {
    if (admissionReported) return;
    admissionReported = true;
    if (admissionUnscanned) {
      out.push(withNeeds(esc(`派单准入没查成：${admission?.why || '机器信号读不到'}——不派（fail-close）`, {
        reason: 'admission-unscanned',
      }), kind));
    } else if (dispatchSlots === 0) {
      out.push(withNeeds(hub(`机器余量不够，这轮不派新单（${admission?.why || 'slots=0'}）`, 'decide'), kind));
    }
  };
  const renamedHint = Array.isArray(policy.renamedKeyHints) && policy.renamedKeyHints[0]
    ? policy.renamedKeyHints[0] : null;

  // ── 渠道并发第二道闸（#1145）──────────────────────────────────────────────
  // 准入（admission）是总闸（机器余量）；这是叠加的渠道闸（上游合同容量）。两道都过才起会话。
  // 缺 channelCaps 快照 = 老夹具/未接线：闸 inert，恒放行，不改既有派工路。
  const chSnap = situation.channelCaps && typeof situation.channelCaps === 'object' ? situation.channelCaps : null;
  const chCaps = (chSnap && chSnap.caps) || {};
  const chStates = (chSnap && chSnap.states) || {};
  let chInFlight = { ...((situation.channelInFlight && situation.channelInFlight.counts) || {}) };
  const chBreaker = situation.breaker || null;
  const chExcluded = situation.channelExcluded instanceof Set
    ? situation.channelExcluded
    : new Set(Array.isArray(situation.channelExcluded) ? situation.channelExcluded : []);
  const modelRecs = Array.isArray(situation.routingModelRecords) ? situation.routingModelRecords : [];
  const landingOfModel = (id) => {
    const m = modelRecs.find((r) => r && String(r.id) === String(id));
    if (!m || !m.provider) return null;
    return { provider: m.provider, cli_model: m.cli_model };
  };
  // 工人的 model 由 PR 标签钉死（#1116；不像审官是家族），渠道满员时**不擅自换模型**，只排队等下轮。
  // 认不出落地 → 本闸不拦（其它闸会挡）。返回 { ok, channel, why }。
  // 有腿表时走 judgeChannelForModel：pending 模型不读同渠道另一条腿的 Infinity（#1274）。
  const routingLegs = Array.isArray(situation.routingLegs) ? situation.routingLegs : null;
  const channelAdmits = (model) => {
    if (!chSnap) return { ok: true, channel: null };
    if (routingLegs) {
      const judged = judgeChannelForModel({
        model, legs: routingLegs, models: modelRecs, caps: chCaps, states: chStates,
        inFlight: chInFlight, breaker: chBreaker, now: nowMs, excluded: chExcluded,
      });
      if (judged.attributed) {
        return judged.available
          ? { ok: true, channel: judged.channel }
          : { ok: false, channel: judged.channel, why: judged.why, reason: judged.reason };
      }
    }
    const landing = landingOfModel(model);
    if (!landing) return { ok: true, channel: null };
    const av = legAvailability(landing, {
      caps: chCaps, states: chStates, inFlight: chInFlight, breaker: chBreaker, now: nowMs, excluded: chExcluded,
      model, legs: routingLegs, models: modelRecs,
    });
    return av.available
      ? { ok: true, channel: av.channel }
      : { ok: false, channel: av.channel, why: av.why, reason: av.reason };
  };
  const channelQueueReported = new Set();
  const reportChannelQueue = (kind, admit) => {
    const ch = admit.channel || '?';
    if (channelQueueReported.has(ch)) return;
    channelQueueReported.add(ch);
    const what = admit.reason === 'breaker-open' ? '熔断冷却中' : admit.reason === 'excluded-429' ? '本轮已 429' : '已满员';
    out.push(withNeeds(hub(`渠道 ${ch} ${what}，本轮不再往它派新会话（${admit.why || ''}）——票留队列等下轮`, 'decide'), kind));
  };

  if (ready.kind === 'ready') {
    const readyIssues = ready.ready
      .map((n) => (gh.issues || []).find((i) => i && i.number === n))
      .filter(Boolean);
    const roundsByIssue = {};
    for (const pr of gh.prs || []) {
      const issueNo = attributedIssueNumber(pr);
      if (issueNo == null) continue;
      const judged = analyzeReviews(prReviewInput(reviews.byPr?.[pr.number]));
      const n = judged.scanned ? (Number(judged.redRounds) || 0) : 0;
      roundsByIssue[issueNo] = Math.max(roundsByIssue[issueNo] || 0, n);
    }
    const ordered = prioritizeReady(readyIssues, {
      openIssues: gh.issues || [], openPrs: gh.prs || [], roundsByIssue,
    });
    let dispatchedThisRound = 0;
    for (const n of ordered) {
      const issue = (gh.issues || []).find((i) => i && i.number === n);
      const model = labelValue(issue, 'model/');
      const reviewer = labelValue(issue, 'reviewer/');
      const role = labelValue(issue, 'type/');
      // #876 ②：带「待消歧」标的单一律不派，哪怕故意同时挂着「已消歧」。静默跳过——
      // 该说的话由盘点在「时机到了」那天说一次（commander-inventory 的待消歧一项），这里天天喊没意义。
      if (hasPendingLabel(issue?.labels)) continue;
      // #876 ①：框架活走无人值守快马，但必须保留人工合门。
      // 以前这里只回流给主会话；用户离开时没有执行者，框架活就永远不动。
      // 框架单仍要求明确 model/reviewer，不能为了自动化而猜模型。
      if (role === FRAMEWORK_ROLE) {
        if (!model || !reviewer) {
          out.push(withNeeds(hub(`#${n}${issue?.title ? '「' + issue.title + '」' : ''}是框架活，但缺 model/reviewer，不能无人值守派工；补齐后再自动执行`, 'decide', { issue: n }), N.dispatch));
          continue;
        }
        const frameworkGate = assessDispatchModel(model, { policy, enabledIds, redIds });
        if (!frameworkGate.ok) {
          out.push(withNeeds(esc(`#${n} 框架活不能自动派：${frameworkGate.why}`, {
            reason: frameworkGate.reason, issue: n, model, title: issue?.title || '',
          }), N.dispatch));
          continue;
        }
        const live = hasLiveExecutor({
          sessions: sessionListForLiveness(situation),
          issue: n,
        });
        if (live.live) continue;
        const fwChannel = channelAdmits(model);
        if (!fwChannel.ok) { reportChannelQueue(N.dispatch, fwChannel); continue; }
        if (dispatchedThisRound >= newWorkSlots || !takeSlot()) {
          reportAdmission(N.dispatch);
          continue;
        }
        dispatchedThisRound += 1;
        chInFlight = takeChannelSlot(chInFlight, fwChannel.channel);
        out.push(withNeeds({
          kind: 'dispatch', issue: n, model, reviewer, role,
          title: issue?.title || '', mergePolicy: 'manual',
          mergeReason: 'type/体系 框架活：自动执行，合并必须人工拍板',
          why: `#${n} 框架活已标齐，走无人值守快马`,
        }, N.dispatch));
        out.push(withNeeds(hub(`已自动派单 #${n}：框架活进入无人值守执行，合并仍等人工拍板`, 'dispatched', { issue: n }), N.dispatch));
        continue;
      }
      // 缺标签三档（#1003）。硬边界：不许改回「缺任一就报」。
      //
      // ① 为什么不是「缺任一就报」（2026-09-05 实咬）：进这个分支的门槛只有一条「已消歧」，
      //    而帅位开**任何**记账单/体系单都按惯例打「已消歧」⇒ 每开一张新单，指挥官下一轮就为它
      //    生一张「[待拍板] missing-labels」。#953 开单 06:49、#954 生成 06:56，隔 6 分钟；
      //    当天关掉 4 张（#900/#946/#951/#954），转头又生 4 张（#957/#958/#959/#961）。
      //    源单一直开着，报单就一直生——这不是漏标提醒，是自我繁殖。
      //
      // ② 为什么上面那条 type/体系 豁免接不住裸「已消歧」——**鸡生蛋**：
      //    type/* 的唯一自动写入方是 stampIssueLabels（scripts/lib/dispatch/card.mjs），
      //    由 scripts/dao.mjs 在**派工成功之后**才调。也就是说，豁免的开关只有「被派过工」
      //    才会自动打开，而这条豁免存在的目的**正是阻止派工**。新开的框架单永远等不到那一下。
      //    别拿「手工打过 type/体系 的单确实安静」当反证（#904/#903/#902/#895/#888 都安静）：
      //    那不是判据对，是有人替它手工打开了开关；没人手工打的单一律炸单。
      //    所以无 type/ + 两个都没有，必须继续静默。
      //
      // ③ 但注释 ② 同时点出了分得开的信号（#1003 实咬 #1000/#1001）：
      //    新开的单上如果出现 type/写码（或其他非 type/体系 的 type 标），一定是人手打的——
      //    stampIssueLabels 派工成功之后才写 type/*，记账单/体系单不会长出 type/写码。
      //    那就是明确瞄准了派工车道：两个都缺也要报帅，不能再跟记账单混成一档静默跳过。
      //
      // 三档：半标（有一个缺一个）→ 报（或 #971 能推出唯一跨厂值就自己补）；
      //       两个都没有 + 人手打过非体系 type/ → 报；
      //       两个都没有 + 无 type/ → 静默（记账单）。
      //
      // 「没查成」不会落进这里：labels 不是数组的 issue 在 inspectReadyQueue 就被挡掉了
      // （labelNames 返回 null → 不进 ready，整节报 kind:'unscanned'），所以走到这一步的 null
      // 一律是「查过、确实没这个标」，与「没查成」在出口上分得开。
      if ((model || reviewer) && (!model || !reviewer)) {
        // #971：半标且选型能推出唯一跨厂值 → 自己补，不再喊给空气。推不出仍报帅（查不到 ≠ 猜一个）。
        const filled = maybeAddLabel(issue, situation, {
          why: `#${n} 半标，补唯一跨厂标签（不猜）`,
        }, N['add-label']);
        if (filled) { out.push(filled); continue; }
        out.push(withNeeds(esc(`#${n} 已消歧，但派工标只打了一半：有 ${model ? 'model/' : 'reviewer/'}、缺 ${!model ? 'model/' : 'reviewer/'}，不猜——报帅补标签`, {
          reason: 'missing-labels', issue: n, title: issue?.title || '',
        }), N.dispatch));
        continue;
      }
      if (!model && !reviewer) {
        // 框架活已在上面 continue。走到这里的 role 只可能是人手打的非体系 type/，或根本没有。
        if (role) {
          out.push(withNeeds(esc(`#${n} 已消歧且带 type/${role}，但 model/ 和 reviewer/ 都没有——人手瞄准了派工车道却没打派工标，不猜——报帅补标签`, {
            reason: 'missing-labels', issue: n, title: issue?.title || '',
          }), N.dispatch));
        }
        continue; // 无 type/：记账单，静默（理由见上 ①②）
      }
      const gate = assessDispatchModel(model, { policy, enabledIds, redIds });
      if (!gate.ok) {
        out.push(withNeeds(esc(`#${n} ${gate.why}`, {
          reason: gate.reason, issue: n, model, title: issue?.title || '',
        }), N.dispatch));
        continue;
      }
      // #1056：活性只问这一处。同一 issue 已有活执行者（或名单没查成）→ 不派。
      // 观测面未接入（老夹具）live.live=false，既有派工路不受影响。
      const live = hasLiveExecutor({
        sessions: sessionListForLiveness(situation),
        issue: n,
      });
      if (live.live) continue;
      // 渠道并发第二道闸（#1145）：工人 model 由标签钉死，渠道满员/熔断时排队下轮，不擅自换模型。
      const chAdmit = channelAdmits(model);
      if (!chAdmit.ok) { reportChannelQueue(N.dispatch, chAdmit); continue; }
      // 新活只能用「留给收尾之后剩下的」那部分名额，且照样要从共用池里领一个。
      if (dispatchedThisRound >= newWorkSlots || !takeSlot()) {
        reportAdmission(N.dispatch);
        continue; // 余量用尽 / 没查成：排队下轮，不丢、不 escalate
      }
      dispatchedThisRound += 1;
      chInFlight = takeChannelSlot(chInFlight, chAdmit.channel);
      if (renamedHint && dispatchedThisRound === 1) {
        out.push(withNeeds(hub(renamedHint, 'decide'), N.dispatch));
      }
      const mergePlan = resolveIssueMergePolicy(issue, situation.askPolicy);
      out.push(withNeeds({
        kind: 'dispatch', issue: n, model, reviewer, role: role || null,
        title: issue?.title || '',
        mergePolicy: mergePlan.mergePolicy,
        mergeReason: mergePlan.mergeReason,
        mergePolicySource: mergePlan.mergePolicySource,
        why: `#${n} 已消歧、无在途派工、model|reviewer 标签齐；merge-policy:${mergePlan.mergePolicy}${mergePlan.mergeReason ? `（${mergePlan.mergeReason}）` : ''}`,
      }, N.dispatch));
      out.push(withNeeds(hub(`已自动派单 #${n}：${issue?.title || ''}（merge-policy:${mergePlan.mergePolicy}）`, 'dispatched', { issue: n }), N.dispatch));
    }
  }

  // ② review-pending 入队 → 首次 attach-reviewer；票还在且有上次尝试账 → retry-drain（#971）
  // 走到重试分支本身就是「上次没成」的证据（派了 ≠ 成了）。宽限期内不重发；试满 escalate。
  // 队列自己不认领存活，票就永远不死：PR 合了/关了，票还在，drain 永远消不掉，
  // tries 打满后每一轮都开一张 [待拍板] 单。实咬 2026-09-06：#970/#972/#983 合并后
  // 仍被开单，17 张噪音单全从这里来。存活判据只在 github 真扫到时才成立——
  // 没扫到时 openPrs 是空集，把全部活票判成死票正是最坏的剪法。
  // 主查询是 pullRequests(first:100, states:OPEN)——含 draft，所以 draft 票不会被误剪。
  // 但取满 100 条就说明窗口可能被截断，掉出窗口的活 PR 会长得和「已关」一模一样，
  // 那时「不在列表里」不再是死票的证据，一张都不剪。
  // PR_WINDOW / prList / ghScanned / openPrs 在上面预留名额时已经算过——同一把尺。
  const exhaustedThisRound = new Set(); // 本轮刚认输的 PR：标还没打上，PR 循环也要跳过
  // 票头过期 = 这张票问的不是现在的 head。它必须能穿过「已认输就跳过」那道否决，
  // 否则过期票收不掉、认输标摘不掉、按当前 head 该叫的复审永远叫不出来（#1208，见 commander-verbs
  // 的 retry-drain.stale-head）。在两道循环**之前**算一次，PR 循环的 stuck 否决要用同一个集合——
  // 各算一份迟早对不上，而这里的失效方式正是「两处判据不同步」。
  const staleTickets = new Set();
  for (const it of rp.items || []) {
    const scope = ticketScopeKey(it, homeRepo);
    if (!scope) continue;
    // 跨仓票的现场不在本仓 gh.prs。按纯 PR 号比对会把别仓过期票记成本仓 stale，
    // 本仓 stuck PR 就被绕过去派 rework/rereview（#1209 审官返工）。
    // 空 repo 与显式本仓 repo 都是本仓：生产票带 owner/name，非空 ≠ 跨仓。
    if (!ticketIsHome(it, homeRepo)) continue;
    const itHead0 = ticketHeadOid(it.head);
    const livePr0 = (gh.prs || []).find((p) => p && Number(p.number) === Number(it.pr));
    const liveHead0 = typeof livePr0?.headRefOid === 'string' ? livePr0.headRefOid.trim() : '';
    if (liveHead0 && itHead0 && itHead0 !== liveHead0) staleTickets.add(scope);
  }

  // 「自动化认输」是带 head 的判据，不是永久标签——工人推了新 head = 新局面，摘标放回流水线。
  // 2026-09-11 实咬：这个标只写不摘，12 张 PR 被永久焊死（decide 对它们零动作）。
  // 账本键是 pushed:<pr>@<head>（带 head），标签却是无头的——把那个不对称补上。
  // 判据是纯函数（lib/exhausted.mjs 的 planExhaustedLabelClear），这里只取数与产动作。
  {
    const clearPlan = planExhaustedLabelClear({
      prs: prList,
      ledger: situation.exhaustedPush || {},
      pushedThisRound: [],
      // #1238：带上本轮判据版本。判据改过 → 按旧判据打的认输标自动过期。
      epoch: epochOf().epoch,
      // 第 ④ 条：认定红票投在旧代码上 = 返工已落地、判定已过期。与复审重试账**同一份**表
      // （commander.mjs 算一次传进来），不在这里再扫一遍 reviews。
      staleRedAt: situation.staleRedAt || null,
      // ④ 的一次性消费：这份旧红票的 `@red:<oid>` 键已经试满 → 不再摘。
      // 用生产侧同一把键算，不在 exhausted.mjs 里重写一份（#1233：同一事实两处各判会分叉）。
      spentStaleReds: spentStaleReds({
        prs: prList, staleRedAt, reworkDispatched,
      }),
    });
    for (const c of clearPlan.clears) {
      out.push(withNeeds({
        kind: 'clear-exhausted',
        pr: c.pr,
        head: c.head,
        why: c.why,
      }, N['clear-exhausted'] || N['add-label']));
    }
  }

  for (const it of rp.items || []) {
    if (!it || it.pr == null) continue;
    const ticketHome = ticketIsHome(it, homeRepo);
    // 跨仓票：本仓开放列表不能证明它死了。指挥官本单不扫别仓，不许当死票回收。
    if (!reviewTicketIsLive(it)) {
      out.push(withNeeds({
        kind: 'reap-ticket', pr: it.pr, repo: null,
        why: `PR #${it.pr} 已不在开放列表（合并/已关）——复审票是死票，回收，不再叫审官`,
      }, N['reap-ticket']));
      continue;
    }
    const livePr = (gh.prs || []).find((p) => p && Number(p.number) === Number(it.pr));
    // 票里的 head 有两种形态：字符串，或 {name, oid}（写票的一侧给的是后者）。
    // 取不出就传 null——退回旧键，不是猜一个。
    const itHead = ticketHeadOid(it.head);
    // 票头是写票那一刻的快照，不是现场。带上当前 head，让「票过期」与「真试过」分开
    // （2026-09-12 #1208：票头停在旧 commit，重试账钉在旧键上，试满后永久认输，
    //  而按当前 head 本该叫的那轮复审一次也没叫出来）。见 commander-verbs 的 retry-drain.stale-head。
    const liveHead = typeof livePr?.headRefOid === 'string' ? livePr.headRefOid.trim() : '';
    // 判据顺序是负载的：**先判票过没过期，再判这张 PR 要不要省额度**。
    // 反过来写，#1208 那类事故会整段够不着——事故现场 PR 正挂着「卡死/自动化认输」，
    // 那句 `if (stuck) continue` 会在 stale-head 之前把整条票路掐掉，于是票永远是过期的旧票、
    // 认输标永远没人摘、按当前 head 该叫的复审永远叫不出来（2026-09-12 审官打回 #1209 的第一条）。
    // 省额度那句的本意是「已经认输的 PR 不用再花额度重试 drain」，它管的是**重试**，
    // 不该顺手把「收殓过期票」也管了——那件事不花额度，只是把死票从流水线上取下来。
    const staleTicket = staleTickets.has(ticketScopeKey(it, homeRepo));
    if (livePr && prHasStuckLabel(livePr) && !staleTicket) continue; // #1000：已认输 / 等用户，省额度不重试 drain
    const drain = validateRetryDrain({
      pr: it.pr,
      head: itHead,
      liveHead,
      queue: rp.items,
      ledger: situation.drainLedger || {},
      nowMs,
    });
    if (drain.ok) {
      // 重试 drain 同样是起一个审官会话，同样领名额（判据见 slotsLeft 那段）。
      if (!takeFinishSlot()) { reportAdmission(N['retry-drain']); continue; }
      out.push(withNeeds({
        kind: 'retry-drain', pr: it.pr, repo: it.repo || null, head: itHead, tries: drain.tries, stateKey: drain.stateKey,
        queue: rp.items,
        why: `PR #${it.pr} 上次 drain 没成（票还在队列），重试第 ${drain.tries} 次`,
      }, N['retry-drain']));
      continue;
    }
    if (drain.code === 'grace') continue;
    // 票头过期：不许拿它去 attach-reviewer（那张票问的不是现在的 head），也不许认输。
    // 落到下面 PR 循环的 rereview 分支——它按**当前 head** 重新写票，tries 从新键起算。
    if (drain.code === 'stale-head') continue;
    // #1237：'hopeless' 与 'exhausted' 都产认输动作，但**理由不一样**，评论也要不一样：
    //   hopeless  = 判据本身就是「拒」，一次都不该试 → 不该写「试了 N 次仍没推动」
    //   exhausted = 真试满了，机械重试确实无解
    // 混成一句话会误导读的人往错方向查（这正是 #1233 认输评论那个病的同一个形状）。
    if (drain.code === 'exhausted' || drain.code === 'hopeless') {
      // 跨仓票打在本仓同号 PR 上会标错仓。指挥官本单不扫别仓，停手不打标。
      if (!ticketHome) continue;
      // #1000：认输是 PR 属性，不再 escalate 开单（开单去重会把出口捂死）。
      if (livePr && prHasStuckLabel(livePr)) continue;
      const tries = Number(drain.tries) || 0;
      out.push(withNeeds(buildMarkExhausted({
        pr: it.pr, verb: 'drain', tries, head: itHead,
        why: drain.error,
        retryVerdict: drain.retryVerdict || (drain.code === 'hopeless' ? 'terminal' : null),
        maxTries: MAX_DRAIN_TRIES,
      }), N['mark-exhausted']));
      exhaustedThisRound.add(Number(it.pr));
      continue;
    }
    // #1125：执行侧 attach-reviewer 调的是不带 --pr 的 review-pending-drain，
    // drain 自己按在役数拉、拉满即停。所以 decide 每轮只产**一条** attach-reviewer——
    // 产 N 条就会连跑 N 次 drain，每次都看到「还没满」再拉一张，把容量闸冲掉。
    // 账仍按这张代表票的 pr@head 记（validateRetryDrain 的键），不是按整队。
    if (out.some((a) => a.kind === 'attach-reviewer')) continue;
    // 起审官也是起会话，也吃同一份 CPU 和内存——2026-09-06 实测 137 个会话里审官占 53 个。
    // 它原来完全不限张：只把工人限住而审官不限，等于闸只挡了一半（#1007 二期）。
    if (!takeFinishSlot()) { reportAdmission(N['attach-reviewer']); continue; }
    out.push(withNeeds({
      kind: 'attach-reviewer', pr: it.pr, repo: it.repo || null, reviewer: it.reviewer || null, worker: it.worker || null,
      head: it.head || null, source: it.source || null, error: it.error || null,
      why: attachReviewerWhy(it),
    }, N['attach-reviewer']));
  }

  // 返工工人的构造：判红和解冲突两条路共用。取 model/reviewer 一律从**这张 PR 自己的标签**来
  // （#1116：选型不读 issue；merge-policy 仍读署名单正文），任何一步取不到就报帅不派。
  // 抽成闭包是因为「冲突」这条路必须在 analyzeReviewsAtHead 之前判——冲突 PR 常常一条 review 都没有，
  // 而 reviews-missing 在下面是静默 continue，写在后面会被那一条吃掉。
  function pushRework(pr, { brief, head, redRounds, why, hubText, conflict = false }) {
    const rkey = reworkKey(pr.number, head);
    // 「派了 ≠ 成了」这条早就为 drain 定过（tries + 宽限 + 试满 escalate），却没接到返工这条路上：
    // 原判据只看「这条账在不在」，不看它成没成。于是一次**失败**的派工（ok:false，压根没造出工人）
    // 也会把这个 PR 在这个 head 上永久挡住。2026-09-06 实咬：PR #909 的返工 21:11 因署名单缺
    // 「已消歧」被拒派，标签当天就补上了，可它再也没被重派过——head 没变，账在，永远静默。
    // 账本里 ok 字段一直都在记，只是没人读。
    const prev = reworkDispatched[rkey];
    if (prev) {
      // 派成功了，但工人**可能早就死了**。原来这里无条件 return，判据是「派出去过」，
      // 而真正要问的是「现在还有没有人在做」——两者在工人静默退出时永久分叉：
      // head 不会再变（没人推），账 ok:true 不会再变（没人重写），于是这张 PR 在这个 head 上
      // 被自己的成功记录焊死。2026-09-14 实咬：#1154 的返工 09-14T05:37 派成功，14 小时后
      // 会话名单里一条活的都没有、head 一个字没动、盘面每轮报「合不上」却零动作；
      // #1091/#1216 同形状（exhausted.mjs 开头那段「pushRework 被 prev.ok === true 挡住」
      // 记的就是这个症状，只记了没修）。唯一逃生口是判据版本换代把账本键作废——
      // 靠改代码来解冻卡住的 PR，不是机制。
      //
      // 解冻判据必须**确知没人在做**，不是「没查到人」：会话面没接入 / 没查成一律维持旧行为，
      // 否则观测面一抖就批量重派，造出一堆重复工人。确知没人 + 超过孤儿宽限 ⇒ 落回下面的
      // 重试路，tries / 宽限 / MAX_REWORK_TRIES / terminal 判定原样全部适用，不新开一条绕闸的路。
      if (prev.ok === true) {
        const orphan = judgeReworkOrphan(pr, { prev, nowMs, situation });
        if (!orphan.orphan) return;
      }
      if (prev.unscanned === true) return; // 没查成：不知道有没有工人，fail-closed 不重派（重派会造重复工人）
      // 明确失败：上次没有工人被造出来，可以重试。但要宽限期 + 上限，
      // 否则失败原因没解决时会每轮刷一次（#849 刷单教训）。
      const tries = Number(prev.tries) || 1;
      const ageMin = (nowMs - (Date.parse(prev.at || '') || 0)) / 60000;
      if (Number.isFinite(ageMin) && ageMin < REWORK_RETRY_GRACE_MIN) return;
      // #1237：先问「这个失败再试一次会不会不一样」，再决定烧不烧名额。
      // 不可试的（树没了 / 标签缺 / 执行目录判死）当场交人，别白等 3×宽限期。
      const rworkVerdict = judgeRetry({ error: prev.lastError || prev.error });
      if (tries >= MAX_REWORK_TRIES || rworkVerdict.verdict === 'terminal') {
        if (prHasStuckLabel(pr)) return;
        const hopeless = rworkVerdict.verdict === 'terminal' && tries < MAX_REWORK_TRIES;
        out.push(withNeeds(buildMarkExhausted({
          pr: pr.number, verb: 'rework', tries, head,
          retryVerdict: rworkVerdict.verdict,
          maxTries: MAX_REWORK_TRIES,
          why: hopeless
            ? `PR #${pr.number} 返工派不动，且这个失败重试不会变（第 ${tries} 次即交人）——${prev.lastError || prev.error || '无原文'}`
            : `PR #${pr.number} 返工派了 ${tries} 次都没派成（当前 head ${String(head).slice(0, 8)}）——停手交人`,
        }), N['mark-exhausted']));
        exhaustedThisRound.add(Number(pr.number));
        return;
      }
    }
    const issueNo = attributedIssueNumber(pr);
    // 无署名 issue（pr-fast 快路，`host/skills/pr-fast/SKILL.md`：快路不收 issue）**不挡返工**。
    //
    // 2026-09-14 用户拍板「你决定如何推进」。原先这里当场报帅（`rework-no-issue`），
    // 代价是快路 PR 一旦判红就永久停在这——审官的红项躺在 GitHub 上没人接，而报帅单
    // 只是把「merge-policy 取不到」这件事又说了一遍，它拦不住任何真实风险：
    //   · 返工的**动作**（照红项改）跟署名 issue 一点关系都没有；
    //   · 唯一真依赖 issue 的是 **merge-policy**（human_holds 分类写在 issue 正文上，#1099）。
    //     取不到就是「不许放行 auto」——那就是 **manual**，与 `mergePolicyUnscanned` 同一个
    //     失败方向（本文件上面那条：没查成一律 manual，不许退回 auto）。
    //
    // 所以：无署名 ⇒ mergePolicy: manual + 如实写清理由，返工照派。
    // 判据**没有放宽**：没有 human_holds 证据 ⇒ 不许自动合；只是不再把「推不动」当成处置。
    if (issueNo == null) {
      const rModel0 = labelValue(pr, 'model/');
      const rReviewer0 = labelValue(pr, 'reviewer/');
      if (!rModel0 || !rReviewer0) {
        const filled0 = maybeAddLabel(pr, situation, {
          on: 'pr',
          pr: pr.number,
          why: `PR #${pr.number} 要返工，PR 上缺 ${!rModel0 ? 'model/' : ''}${!rModel0 && !rReviewer0 ? '、' : ''}${!rReviewer0 ? 'reviewer/' : ''}——补唯一跨厂标签`,
        }, N['add-label']);
        if (filled0) { out.push(filled0); return; }
        out.push(withNeeds(esc(`PR #${pr.number} 要返工，但 PR 上缺 ${!rModel0 ? 'model/' : ''}${!rModel0 && !rReviewer0 ? '、' : ''}${!rReviewer0 ? 'reviewer/' : ''} 标签，需人工打标（不读 issue、不猜）`, {
          reason: 'missing-labels', pr: pr.number, title: pr.title || '',
        }), N.rework));
        return;
      }
      let g0 = assessDispatchModel(rModel0, { policy, enabledIds, redIds });
      let model0 = rModel0;
      let sub0 = null;
      if (!g0.ok && (g0.reason === 'model-not-in-routing' || g0.reason === 'model-health-red')) {
        const fb = situation.defaultWorkerModel;
        const fbGate = fb ? assessDispatchModel(fb, { policy, enabledIds, redIds }) : { ok: false };
        if (fb && fbGate.ok) { sub0 = { from: rModel0, to: fb, why: g0.why }; model0 = fb; g0 = fbGate; }
      }
      if (!g0.ok) {
        out.push(withNeeds(esc(`PR #${pr.number} 要返工，但${g0.why}`, { reason: g0.reason, pr: pr.number, model: rModel0 }), N.rework));
        return;
      }
      if (!takeFinishSlot()) { reportAdmission(N.rework); return; }
      reworkThisRound += 1;
      out.push(withNeeds({
        kind: 'rework', pr: pr.number, head, issue: null,
        model: model0, reviewer: rReviewer0, redRounds,
        title: pr.title || '', brief, reworkKey: rkey, conflict,
        mergePolicy: 'manual',
        mergeReason: UNSIGNED_ISSUE_MERGE_REASON,
        mergePolicySource: 'no-issue',
        ...(sub0 ? { substitutedModel: sub0 } : {}),
        why: why + (sub0 ? `；原模型 ${sub0.from} 派不出（${sub0.why}），顶班 ${sub0.to}` : '')
          + '；merge-policy:manual（无署名 issue，不许放行 auto）',
      }, N.rework));
      out.push(withNeeds(hub(hubText, 'dispatched', { pr: pr.number }), N.rework));
      return;
    }
    // 署名单仍要扫到：merge-policy / human_holds 写在 issue 正文上（#1099）。
    // 选型不从这里取——单子关了不等于 PR 不用返工，但正文没扫到就不能放行 auto。
    const rIssue = attributedIssueOf(gh, pr);
    if (!rIssue) {
      out.push(withNeeds(esc(
        `PR #${pr.number} 的署名 issue #${issueNo} 这轮没扫到（已关且不在署名补取里）——merge-policy 没查成，不派`,
        { reason: 'unscanned', pr: pr.number, issue: issueNo, missing: ['github'], detail: 'rework-issue-unscanned' },
      ), N.rework));
      return;
    }
    const rModel = labelValue(pr, 'model/');
    const rReviewer = labelValue(pr, 'reviewer/');
    if (!rModel || !rReviewer) {
      const filled = maybeAddLabel(pr, situation, {
        on: 'pr',
        pr: pr.number,
        why: `PR #${pr.number} 要返工，PR 上缺 ${!rModel ? 'model/' : ''}${!rModel && !rReviewer ? '、' : ''}${!rReviewer ? 'reviewer/' : ''}——补唯一跨厂标签`,
      }, N['add-label']);
      if (filled) { out.push(filled); return; }
      out.push(withNeeds(esc(`PR #${pr.number} 要返工，但 PR 上缺 ${!rModel ? 'model/' : ''}${!rModel && !rReviewer ? '、' : ''}${!rReviewer ? 'reviewer/' : ''} 标签，需人工打标（不读 issue、不猜）`, {
        reason: 'missing-labels', pr: pr.number, issue: issueNo, title: pr.title || '',
      }), N.rework));
      return;
    }
    let rGate = assessDispatchModel(rModel, { policy, enabledIds, redIds });
    // 顶班（2026-09-05 实咬）：快马单的 model/ 标签常是主会话子代理的模型（claude-opus-5），
    // 它在服务器腿表里没有可派的腿 → 返工永远派不出去，红项在 GitHub 上躺着没人接。
    // 返工要的是「有人改」，不是「同一个人改」——原模型派不出就落回选型写码首选。
    // 只对「这个模型不能派」两种原因顶班；「选型没查成」仍 fail-closed，因为那时连顶班人选也验不了。
    let reworkModel = rModel;
    let substituted = null;
    if (!rGate.ok && (rGate.reason === 'model-not-in-routing' || rGate.reason === 'model-health-red')) {
      const fb = situation.defaultWorkerModel;
      const fbGate = fb ? assessDispatchModel(fb, { policy, enabledIds, redIds }) : { ok: false };
      if (fb && fbGate.ok) {
        substituted = { from: rModel, to: fb, why: rGate.why };
        reworkModel = fb;
        rGate = fbGate;
      }
    }
    if (!rGate.ok) {
      out.push(withNeeds(esc(`PR #${pr.number} 要返工，但${rGate.why}`, { reason: rGate.reason, pr: pr.number, issue: issueNo, model: rModel }), N.rework));
      return;
    }
    // 返工属于「收尾」，领**收尾名额**（与「新活名额」两笔账，见上面 finishSlots 的定义）。
    // 机器满载时新活一个不派，但返工照领——它不增在制品，是把已有 PR 推过终点线。
    // 收尾名额自有上限（FINISH_SLOTS_MAX），用尽则排队下轮，不丢、不 escalate。
    if (!takeFinishSlot()) {
      reportAdmission(N.rework);
      return;
    }
    reworkThisRound += 1;
    const mergePlan = resolveIssueMergePolicy(rIssue, situation.askPolicy);
    out.push(withNeeds({
      kind: 'rework', pr: pr.number, head, issue: issueNo,
      model: reworkModel, reviewer: rReviewer, redRounds,
      title: pr.title || '', brief, reworkKey: rkey, conflict,
      mergePolicy: mergePlan.mergePolicy,
      mergeReason: mergePlan.mergeReason,
      mergePolicySource: mergePlan.mergePolicySource,
      ...(substituted ? { substitutedModel: substituted } : {}),
      why: why + (substituted ? `；原模型 ${substituted.from} 派不出（${substituted.why}），顶班 ${substituted.to}` : '')
        + `；merge-policy:${mergePlan.mergePolicy}${mergePlan.mergeReason ? `（${mergePlan.mergeReason}）` : ''}`,
    }, N.rework));
    out.push(withNeeds(hub(hubText, 'dispatched', { pr: pr.number }), N.rework));
  }

  // ③ PR 驱动：判绿合并 / manual 待拍板 / 审官轮次
  // 老单优先：轮次多的先收口，再按等待时间（出生早的先）。
  const prsAged = [...(gh.prs || [])].sort((a, b) => {
    const ra = analyzeReviews(prReviewInput(reviews.byPr?.[a && a.number])).redRounds || 0;
    const rb = analyzeReviews(prReviewInput(reviews.byPr?.[b && b.number])).redRounds || 0;
    if (rb !== ra) return rb - ra;
    const ta = Date.parse((a && (a.createdAt || a.updatedAt)) || '') || 0;
    const tb = Date.parse((b && (b.createdAt || b.updatedAt)) || '') || 0;
    if (ta !== tb) return ta - tb;
    return (Number(a && a.number) || 0) - (Number(b && b.number) || 0);
  });
  for (const pr of prsAged) {
    if (!pr || pr.number == null) continue;
    // #1000：认输 / 等用户是 PR 属性。指挥官见到就跳过，不再机械重试（省额度）。
    // 合并路仍走——帅位关掉或去掉标之后自然回来；标还在时也不自动合一张已经认输的 PR。
    //
    // 2026-09-11 实咬：上面这句注释写着「合并路仍走」，但 `continue` 把合并路也一起跳掉了，
    // 于是「认输」把 PR **永久焊死**——审官后来真在 head 上落了 APPROVED 也合不了。
    // 现场：PR #1127 认输之后审官会话交付了 APPROVED（commit_id == headRefOid）、
    // CI 绿、MERGEABLE，三条都齐，却因为一个 40 分钟前打的标躺着不动。
    // 而 #1127 当时是 13 张认输 PR 里**唯一**真可合的——其余 12 张 atHead 零判定。
    //
    // 改法（最小）：只让「判绿」这一件事穿过这层标，其余动作照旧被认输挡住。
    // 认输的本意是「别再机械重试审官/返工」，不是「永远不许合一张已经合格的 PR」；
    // 真合不了的情况下面各道判据（CI 红、draft、冲突、head 零判定）各自会拦。
    // #1017：list / GraphQL 上 mergeable 常恒 UNKNOWN。未知态才单张重查，已知态不烧配额。
    // 认输 PR 也要写入 map——后面差集重派读这张表。以前 `continue` 跳过写入，
    // 差集拿到列表上的 UNKNOWN，把「GitHub 还在算」当成「工人死了」再派一个（#1133 / PR #1253）。
    const resolvedMergeable = resolveMergeable(pr, { viewMergeable: situation.viewMergeable });
    const mergeableState = String(resolvedMergeable.mergeable || '').toUpperCase();
    effectiveMergeability.set(pr.number, mergeableState);
    const mergeableNow = mergeableState === 'MERGEABLE';

    //
    // 2026-09-12 补第二个例外：**票头过期的票**也要穿过去。
    // 上面那个例外只放了「判绿」，#1208 的形态（认输标 + 过期票 + 当前 head 零判定）照样是 noop——
    // 于是修法在事故现场一次都不生效，因为事故现场正是「认输标 + 当前 head 零判定」这个组合。
    // 放它过去不花额度：落到下面 rereview 分支只重写一张票，宽限期和试满照样管着。
    const stuck = prHasStuckLabel(pr) || exhaustedThisRound.has(Number(pr.number));
    const staleTicketHere = staleTickets.has(ticketScopeKey({ pr: pr.number }, homeRepo));

    const approvalIssueOf = (target, mergeSrc) => {
      const n = explicitApprovalIssue(target);
      if (n == null) return null;
      if (mergeSrc && Number(mergeSrc.number) === n) return mergeSrc;
      return (gh.issues || []).find((i) => i && Number(i.number) === n)
        || (gh.attributedIssues || []).find((i) => i && Number(i.number) === n)
        || null;
    };

    // 所有 merge 生产出口共用这一套 merge-policy / 批准证据闸。
    // 认输标只放开重试抑制，不能放开人工合门（#1225 返工 P1）。
    const pushMergeIfReady = (target, { stuckException } = {}) => {
      const mergeA = analyzeReviewsAtHead(prReviewInput(reviews.byPr?.[target.number]), target.headRefOid);
      const allA = analyzeReviews(prReviewInput(reviews.byPr?.[target.number]));
      const decisionApproved = String(target.reviewDecision || '').toUpperCase() === 'APPROVED';
      const greenAtHead = mergeA.scanned && mergeA.latestGreen === true;
      const latestRed = mergeA.scanned && mergeA.latestRed === true;
      const mergeSrc = attributedIssueOf(gh, target);
      const issueNo = attributedIssueNumber(target);
      const mergePlan = resolveLandMergePolicy({
        issue: mergeSrc,
        attributedNumber: issueNo,
        ledgerPick: ledgerPickForLand(situation, target, issueNo),
        policy: situation.askPolicy,
      });
      const lastJudgment = lastJudgmentOf(allA);
      const dockNeeded = needsDockProof({
        greenAtHead,
        atHead: mergeA.scanned ? mergeA.atHead : null,
        lastJudgment,
      });
      const dock = dockNeeded ? dockOf(situation, target.number) : null;
      if (dockNeeded && !(dock && dock.state === 'ok')) {
        if (!dock || dock.state !== 'red') {
          out.push(withNeeds(esc(
            `PR #${target.number} 旧批准要继承但纯对接没查成：${(dock && dock.why) || '没证明'}`,
            { reason: 'unscanned', pr: target.number, missing: ['dockProof'] },
          ), N.merge));
          return true;
        }
        // dock.red：批准后有新树内容，落到下面复审，不合。
      }
      const landArgs = {
        greenAtHead,
        decisionApproved,
        atHead: mergeA.scanned ? mergeA.atHead : null,
        lastJudgment,
        latestRed,
        redAtHead: latestRed,
        dock,
      };
      const reviewReady = approvedToLand(landArgs);
      const readyToLand = approvedToLand({
        ...landArgs,
        mergePolicy: mergePlan.mergePolicy,
        mergePolicySource: mergePlan.mergePolicySource,
      });
      const manualNeedsHuman = target.isDraft || mergePlan.mergePolicy === 'manual';
      let manualApproved = false;
      if (manualNeedsHuman && !target.isDraft) {
        manualApproved = manualMergeApproved({
          pr: target, issue: mergeSrc, greenAtHead,
          evidence: { explicitApprovalIssue, isApprovedExecutionTask, checksSucceeded },
        }).ok;
      }

      if (readyToLand && !target.isDraft && mergeableNow) {
        const ci = prChecksRed(target);
        if (ci.red) {
          out.push(withNeeds(esc(`PR #${target.number} 审官判绿但 CI 红（${ci.reason}）——不自动合，报帅`, { reason: 'approved-but-ci-red', pr: target.number }), N.merge));
          out.push(withNeeds(hub(`PR #${target.number} 判绿但 CI 红，卡住了`, 'stuck', { pr: target.number }), N.merge));
          return true;
        }
        if (!greenAtHead) {
          const a = analyzeReviews(prReviewInput(reviews.byPr?.[target.number]));
          if (!a.scanned) {
            out.push(withNeeds(esc(`PR #${target.number} 判绿待合并，但该 PR reviews 没查成`, { reason: 'unscanned', pr: target.number, missing: ['prReviews'] }), N.merge));
            return true;
          }
          if (!a.green && !a.latestGreen) {
            out.push(withNeeds(esc(`PR #${target.number} reviewDecision=APPROVED 但 reviews 里没有 APPROVED 状态——报帅`, { reason: 'approved-without-review', pr: target.number }), N.merge));
            return true;
          }
        }
        const why = stuckException
          ? '审官判绿（当前 head）+ CI 绿 + MERGEABLE——已认输但条件齐了，照合（认输只挡重试，不挡合并）'
          : (greenAtHead
            ? '审官判绿（当前 head）+ CI 绿 + MERGEABLE'
            : '审官已放行（已证明纯对接 master，不再审）+ CI 绿 + MERGEABLE');
        out.push(withNeeds({
          kind: 'merge', pr: target.number, title: target.title || '', head: target.headRefOid, why,
        }, N.merge));
        out.push(withNeeds({
          kind: 'land',
          why: stuckException
            ? '合并后收工清理（land 幂等）'
            : '合并后收工清理（land 幂等；清树归 #829，本单只调 land）',
        }, N.land));
        out.push(withNeeds(hub(
          stuckException
            ? `PR #${target.number} 认输之后审官仍判绿，已自动合并`
            : `PR #${target.number} 已自动合并`,
          'merged', { pr: target.number },
        ), N.merge));
        return true;
      }

      if (manualNeedsHuman && mergeableNow && reviewReady) {
        const approvedIssue = approvalIssueOf(target, mergeSrc);
        const draftEvidence = !target.isDraft ? false : canReleaseApprovedDraft({
          pr: { ...target, mergeable: mergeableState }, issue: approvedIssue,
          greenAtHead, expectedHead: target.headRefOid,
        });
        if (draftEvidence || manualApproved) {
          const issueN = approvedIssue && approvedIssue.number;
          if (!target.isDraft && (issueN == null || !target.headRefOid)) {
            out.push(withNeeds(esc(
              `PR #${target.number} 非 draft manual 证据齐了但批准单或 HEAD 没带上——拒绝裸合`,
              { reason: 'manual-merge-unbound', pr: target.number },
            ), N.merge));
            return true;
          }
          out.push(withNeeds({
            kind: 'merge', pr: target.number, head: target.headRefOid,
            approvalIssue: issueN,
            evidenceMode: target.isDraft ? 'draft' : 'manual',
            title: target.title || '',
            why: '用户已批准执行，当前提交审查和检查均通过，自动解除合并等待',
          }, N.merge));
          out.push(withNeeds({ kind: 'land', why: '已批准任务合并后收尾' }, N.land));
          return true;
        }
        out.push(withNeeds(hub(
          target.isDraft
            ? `PR #${target.number} 判绿待人工合并（manual 合门 · draft）`
            : `PR #${target.number} 判绿待人工合并（manual 合门 · 非 draft 也拦——#1218 那一格）`,
          'decide', { pr: target.number },
        ), N.merge));
        if (!target.isDraft) {
          out.push(withNeeds(esc(
            `PR #${target.number} 是 m=manual 但不是 draft——转 draft 失败或闸被拿掉，报帅（不许静默当 auto）`,
            { reason: 'manual-not-draft', pr: target.number },
          ), N.merge));
        }
        return true;
      }

      // #1404：readyToLand 不是「已经合并」。CONFLICTING 必须落到下面既有维修入口。
      // UNKNOWN 等非 CONFLICTING 仍不盲修（没查成 ≠ 有冲突）。
      if (readyToLand && mergeableState !== 'CONFLICTING') return true;
      return false;
    };

    if (stuck && !staleTicketHere) {
      const greenR = analyzeReviewsAtHead(prReviewInput(reviews.byPr?.[pr.number]), pr.headRefOid);
      const ciR = prChecksRed(pr);
      // 认输只放「当前 head 判绿」穿过重试抑制，合并仍走上面那套合门。
      if (greenR.scanned && greenR.latestGreen === true && mergeableNow && !pr.isDraft && !ciR.red) {
        pushMergeIfReady(pr, { stuckException: true });
      }
      continue;
    }

    if (pushMergeIfReady(pr, { stuckException: false })) continue;

    // 冲突态：审官判不了冲突 PR——GitHub 对 CONFLICTING 连 CI 都不触发，叫审官必然白跑，
    // drain 试满后每轮开一张 [待拍板] 单。这一格原本整个空着：指挥官只认 MERGEABLE（合并）
    // 和判红（返工），CONFLICTING 从所有分支里漏掉，9 张 PR 卡在这里没有任何动作（2026-09-06 实测）。
    // 必须排在下面 analyzeReviewsAtHead 之前：冲突 PR 常常一条 review 都没有，
    // 而 reviews-missing 在下面是静默 continue，写在后面会被吃掉。
    // 只认显式 CONFLICTING：UNKNOWN 是 GitHub 还在异步算，没查成 ≠ 有冲突。
    // mergeableState 已经过 resolveMergeable：列表 UNKNOWN 时单张重查后再判。
    // #1056 / #1043：draft 不是「有人在做」。4 张 CONFLICTING 全是 draft、一个活会话都没有，
    // 却被 !pr.isDraft 整批挡在门外。改问活执行者；查不成当有人在做（不往活树上再塞人）。
    // 观测面未接入（老夹具）维持旧契约：draft 不派。
    if (mergeableState === 'CONFLICTING') {
      const live = hasLiveExecutor({
        sessions: sessionListForLiveness(situation),
        pr: pr.number,
        issue: attributedIssueNumber(pr),
        branch: pr.headRefName,
      });
      if (live.live) continue; // 有人在做，或会话名单没查成——不派
      if (live.unavailable && pr.isDraft) continue; // 观测面未接：draft 维持旧契约
      const head = pr.headRefOid || '';
      if (!head) {
        out.push(withNeeds(esc(
          `PR #${pr.number} 是 CONFLICTING 但 headRefOid 没查成——派不出解冲突工人`,
          { reason: 'unscanned', pr: pr.number, missing: ['github'], detail: 'conflict-head-unscanned' },
        ), N.rework));
        continue;
      }
      pushRework(pr, {
        head,
        redRounds: 0,
        conflict: true,
        brief: [
          `本单只做一件事：把 PR #${pr.number} 与 master 的冲突解掉，让它回到可合并状态。`,
          ``,
          `做法：把 origin/master 合进本分支，逐个冲突文件按「两边的意图都要保住」来解，`,
          `解完跑 node scripts/dao-check.mjs，绿了再推。`,
          ``,
          `硬边界：`,
          `- 不许用 --ours/--theirs 整片覆盖——master 上已合并的成果被反向删掉是本仓判例（#902）。`,
          `- 不许借机改本单范围外的东西；解冲突就只解冲突。`,
          `- 冲突文件在 master 侧被删除/拆分的（例如测试拆套），要把本分支的改动搬到新落点，不是把文件复活。`,
        ].join('\n'),
        why: `PR #${pr.number} 与 master 冲突（CONFLICTING）——脚本先自动合，合不上再在原树起短会话`,
        hubText: `PR #${pr.number} 与 master 冲突，先自动合入 master`,
      });
      continue;
    }

    // 审官已经放行（head 只因对接 master 变了）由 pushMergeIfReady 在 readyToLand 时 consume。

    // 红轮数按**当前 head** 重算：工人推了新 head ⇒ 旧红不作数，该 PR 回到「等审官」（不派返工）。
    const a = analyzeReviewsAtHead(prReviewInput(reviews.byPr?.[pr.number]), pr.headRefOid);
    // 2026-09-14 实咬（#1265/#1266 静默永不送审，挂了 4 小时没人叫审官）：
    // `reviews-missing` 有两种来源，处置**相反**，原来是同一格：
    //   ① 这张 PR 的 reviews **没抓到**（网络/接口失败）——按既有契约静默跳过，不臆测；
    //   ② 这张 PR **主动没去抓**（scanPrReviews 跳过 draft，不进 byPr）——这不是「没抓到」，
    //      是「**零判定**、该叫审官了」。当年跳 draft 是为了省额度，可省下来的代价是
    //      下游把它读成「没查成」并静默 continue，于是 draft PR 永远不会进复审队列，
    //      而**唯一**能把它变 non-draft 的收口泵又要等 24 小时超龄——两条路都堵着。
    // 判据：`reviews.skipped` 里点名了这张 PR ⇒ 按「零判定」走（它必然是 draft）。
    const skippedByScan = reviews && Array.isArray(reviews.skipped)
      && reviews.skipped.some((n) => Number(n) === Number(pr.number));
    if (!a.scanned && !(a.reason === 'reviews-missing' && skippedByScan)) {
      // head / commit_id 没查成走 fail-visible 的 unscanned escalate（escalate 对 unscanned 是静默进 status，不开单不刷屏）。
      if (a.reason !== 'reviews-missing') {
        const headMissing = a.reason === 'head-unscanned';
        out.push(withNeeds(esc(
          `PR #${pr.number} 的红要按当前 head 重算，但${headMissing ? ' PR headRefOid 没查成' : '有判别态 review 缺 commit_id'}——不清零、也不当仍红`,
          { reason: 'unscanned', pr: pr.number, missing: [headMissing ? 'github' : 'prReviews'], detail: a.reason },
        ), N.rework));
      }
      continue;
    }
    // 当前 head 上一条判定都没有 ⇒ 要审官。历史上审过（复审）和从没审过（首审）是同一格，
    // 别拆成两条规则：判据都是「当前 head 缺判定」，做法都是写一张复审待办票交给 drain。
    //
    // 2026-09-05 实咬两次，两次都是「记账记错了对象」：
    //  一、#890/#893/#896/#905 的红全打在旧 commit 上，工人早改完推了新 head，
    //     「按当前 head 重算」把红清零 → 不派返工也不走合并，这一格空着，PR 挂了 10 小时。
    //  二、补上复审票之后仍然卡死：账本记的是「票写出去了」，可审官起来就死（裸 pi 落错 provider 401），
    //     判定一条没落，而 `if (!reworkDispatched[rrKey])` 把这张 PR 永久挡在门外——
    //     #894/#899/#905 的票 04:22 就"派成功"了，7 小时后当前 head 判定仍是 0，没有任何东西会重试。
    //     这与同日 agent-stall-watch 换人账本犯的是同一个病（失败和成功记同一条账）。
    //
    // 所以这里不记 ok：**走到这个分支本身就是「上一次没落地」的证据**（判定真落了 a.atHead 就 > 0，
    // 根本进不来）。只记 tries，并给上一票一段宽限期——审官正在看的时候别每 20 分钟重发一张。
    // 试满仍无判定 ⇒ 停手报帅，不死循环。
    // 零判定有两种走法，判据都是「当前 head 缺判定」，做法都是写一张复审待办票交给 drain：
    //   · 历史上审过、这批判定全打在旧 commit 上 → 复审；
    //   · 一条 review 都没有（含 scan 主动跳过的 draft）→ 首审。
    // 别拆成两条规则。`skippedByScan` 那种没 scanned 但**确实零判定**，一样要走进来。
    if (a.atHead === 0 || (skippedByScan && a.reason === 'reviews-missing')) {
      // 这一步的 head 取 a.head（判据用的是它），但**没 scanned 时 a.head 是 undefined**——
      // 跳过 draft 那种零判定正是没 scanned，于是 a.head 为空，后面 takeFinishSlot 之后
      // 产出的动作 head:undefined，执行侧写票时 head.oid=null，票上没 head，重试键也对不上。
      // 落回 PR 自己的 headRefOid：判据源头本来就是它（analyzeReviewsAtHead 的第二个入参）。
      const headForAction = a.head || (typeof pr.headRefOid === 'string' ? pr.headRefOid.trim() : '');
      // 票上的 head、复审账键、给人看的文案必须用同一份 head。a.head 在
      // reviews-missing 时是 undefined，用它拼 rrKey 会得到 rereview:N@undefined@epoch，
      // 跟「同一 PR + 同一 head」对不上（2026-09-15 审官红项）。
      // #971 / #1116：缺 reviewer/ 时先补 PR 自己的标签。等宽限期不会让标签自己长出来；
      // 执行侧 requestRereview 没 reviewer 会拒，票写出去也是空转。不读 issue。
      //
      // 2026-09-11 实咬：补不上标时旧代码**继续往下走**，产出一个 reviewer=null 的
      // rereview。执行侧必拒，且它不进账本（账本由执行侧在派成时写，见 commander.mjs:1315），
      // 于是 tries 永远停在 1、永远到不了 MAX_REREVIEW_TRIES：
      // #1159/#1154 每 20 分钟刷一条一模一样的死动作，刷了 19 轮，全程没有出口。
      // **死动作不是「没动作」**——它在日志里长得像「已经叫过审官了」。
      //
      // 这里不再产死动作：补不上标就当场报帅（走 escalate，它有开单去重，不会刷屏）。
      const reviewer = reviewerLabelFor(gh, pr);
      if (!reviewer) {
        const filled = maybeAddLabel(pr, situation, {
          on: 'pr',
          pr: pr.number,
          why: `PR #${pr.number} 要叫审官，但 PR 上没有 reviewer/——补唯一跨厂标签`,
        }, N['add-label']);
        if (filled) { out.push(filled); continue; }
        if (!prHasStuckLabel(pr)) {
          const issueNo = attributedIssueNumber(pr);
          out.push(withNeeds(esc(
            `PR #${pr.number} 交卷可合、当前 head ${String(headForAction).slice(0, 8)} 零判定，但叫不动审官：`
            + `PR 上取不到 reviewer/ 标签，自动补标也补不上。`
            + `这张 PR 会一直挂到有人给 PR 打上 reviewer/ 为止（不读 issue、不猜）`,
            { reason: 'reviewer-label-missing', pr: pr.number, issue: issueNo },
          ), N.rereview));
        }
        continue;
      }
      const rrKey = rereviewBudgetKey(pr.number, headForAction, staleRedAt);
      const prev = reworkDispatched[rrKey];
      const tries = Number(prev?.tries) || 0;
      const ageMin = prev ? (nowMs - (Date.parse(prev.at || '') || 0)) / 60000 : Infinity;
      if (prev && Number.isFinite(ageMin) && ageMin < REREVIEW_GRACE_MIN) continue; // 上一票还在宽限期，审官可能正在看
      const firstRound = a.scanned ? a.judgedTotal === 0 : true;
      // 零判定有两种来源，措辞必须分开——`a.judgedTotal` 在没 scanned 时是 undefined，
      // 原来的三元式会写出「PR #N 的 undefined 条判定都打在旧 commit 上」这种把人带沟里的话
      // （2026-09-14 自测当场看到）。说清「一条 review 都没有」和「判定都过期了」是两回事。
      // #1237：同上——判据会永远拒的（执行目录 unverified 这类）当场交人。
      const rrVerdict = judgeRetry({ error: prev?.lastError || prev?.error });
      // 词表只认见过的字样，认不出的一律 retryable（`whitelist-fingerprints-cannot-find-unseen-failures`）。
      // 补一条**不看词、只看行为**的判据：同一 (pr, head) 连着几轮拿回一模一样的失败原文，
      // 就是「重试不会变」的直接证据，无论那句话谁写的、说的是什么。
      const repeated = judgeRepeatedFailure(prev);
      if (tries >= MAX_REREVIEW_TRIES || rrVerdict.verdict === 'terminal' || repeated.stuck) {
        const hopeless = (rrVerdict.verdict === 'terminal' || repeated.stuck) && tries < MAX_REREVIEW_TRIES;
        out.push(withNeeds(buildMarkExhausted({
          pr: pr.number, verb: 'rereview', tries, head: headForAction,
          retryVerdict: rrVerdict.verdict,
          maxTries: MAX_REREVIEW_TRIES,
          // 「判定仍是 0」只是**症状**。上一次叫审官如果是被闸当场拒的，那句拒绝原文才是
          // 看 PR 的人唯一用得上的东西——它说得出下一步该做什么（去 rebase / 去换审官），
          // 而「叫了 3 次没判定」说不出。2026-09-14 实咬：#1271 三轮全是
          // 「审官位只许同厂换顺位……没交换厂凭证」，认输评论里一个字都没提，
          // 读的人得自己去翻 journal 才知道真因。有原文就必须带上。
          why: (() => {
            const raw = prev?.lastError || prev?.error || null;
            if (hopeless) {
              return `PR #${pr.number} 叫不动审官，且这个失败重试不会变（第 ${tries} 次即交人）——${raw || '无原文'}`
                + (repeated.stuck ? `；判据：连着 ${repeated.rounds} 轮拿回一模一样的失败原文` : '');
            }
            const base = `PR #${pr.number} 叫了 ${tries} 次审官，当前 head ${String(headForAction).slice(0, 8)} 判定仍是 0——停手交人`;
            return raw ? `${base}；最后一次叫审官是被拒的：${raw}` : base;
          })(),
        }), N['mark-exhausted']));
        exhaustedThisRound.add(Number(pr.number));
        continue;
      }
      // 复审也是起审官会话，同样领名额（理由同 attach-reviewer）。
      if (!takeFinishSlot()) { reportAdmission(N['attach-reviewer']); continue; }
      out.push(withNeeds({
        kind: 'rereview', pr: pr.number, head: headForAction,
        issue: attributedIssueNumber(pr),
        reviewer,
        stateKey: rrKey,
        tries: tries + 1,
        why: firstRound
          ? `PR #${pr.number} 交卷可合但一条判定都没有，当前 head ${String(headForAction).slice(0, 8)} 没人审——叫审官`
          : `PR #${pr.number} 的 ${a.judgedTotal} 条判定都打在旧 commit 上，当前 head ${String(headForAction).slice(0, 8)} 没人审——叫审官复审（第 ${tries + 1} 次）`,
        // 票上写清这一票为什么存在：首审 / 复审 / **scan 跳过没抓**（后者是真断链，进轮次账要留痕）
        ...(skippedByScan ? { scanSkipped: true } : {}),
      }, N['attach-reviewer']));
      continue;
    }
    // 当前 head 上最后一条判别态是红 → 派一个返工工人（#931：删掉「唤大脑翻译返工方向」整层）。
    // 旧红（打在旧 head）在上面 analyzeReviewsAtHead 里就已经不算数了，这里天然不会触发。
    if (!a.latestRed) continue; // 没红 / 最后一条是绿 = 等审官或走合并路，本分支无事
    // 红项全文取不到（审官判了红没留正文）= 没查成：不派、也不当成功。
    const brief = latestRedBody(a.judged);
    if (!brief) {
      out.push(withNeeds(esc(
        `PR #${pr.number} 当前 head ${a.head.slice(0, 8)} 上判了红，但最后一条判红 review 没有正文——返工工人无从下手，不派`,
        { reason: 'unscanned', pr: pr.number, missing: ['prReviews'], detail: 'rework-brief-unscanned' },
      ), N.rework));
      continue;
    }
    pushRework(pr, {
      brief, head: a.head, redRounds: a.redRounds,
      why: `PR #${pr.number} 审官判红（打在当前 head ${a.head.slice(0, 8)} 上）——派返工工人，任务书带红项全文`,
      hubText: `PR #${pr.number} 审官判红，已自动派返工工人（红项全文交给它，逐条改）`,
    });
  }

  // #1147 draft 收口泵：无活会话 + 超 N 小时无提交 → 派短会话三选一；泵满仍 draft → 打「卡死/等用户」交帅。
  // 排在返工/复审之后、新派之前（finishReserve 已预扣名额）。不进上面的 PR 循环：
  // 判红返工、冲突解、叫审官都不认 draft 这一格，写进去会被 continue 吃掉。
  function pushPumpDraft(pr) {
    if (exhaustedThisRound.has(Number(pr.number))) return;
    // 这一轮已经为这张 PR 派了返工/审官 = 有人在推，别再塞一个收口会话抢树。
    if (out.some((a) => a && Number(a.pr) === Number(pr.number)
      && (a.kind === 'rework' || a.kind === 'rereview' || a.kind === 'attach-reviewer'))) {
      return;
    }
    const pkey = pumpDraftKey(pr.number);
    const prev = reworkDispatched[pkey];
    if (prev && prev.unscanned === true) return; // 上次派成没成没查成，不重派（重派会造重复工人）
    const tries = Number(prev?.tries) || 0;
    if (tries >= maxPumps) {
      if (prHasStuckLabel(pr) || exhaustedThisRound.has(Number(pr.number))) return;
      out.push(withNeeds(buildMarkExhausted({
        pr: pr.number, verb: 'pump-draft', tries,
        head: typeof pr.headRefOid === 'string' && pr.headRefOid.trim() ? pr.headRefOid.trim() : null,
        why: `PR #${pr.number} draft 收口泵试了 ${tries} 次仍是 draft——打「卡死/等用户」交帅，不再泵`,
      }), N['mark-exhausted']));
      exhaustedThisRound.add(Number(pr.number));
      return;
    }
    const resolved = resolvePumpDraftDispatch(pr);
    if (!resolved.ok) {
      if (resolved.reason === 'missing-labels') {
        out.push(withNeeds(esc(
          `PR #${pr.number} draft 超龄要收口，但 PR 上没有 model/reviewer——需人工打标（不读 issue、不猜）`,
          { reason: 'missing-labels', pr: pr.number, issue: resolved.issueNo, title: resolved.rIssue?.title || pr.title || '' },
        ), N['pump-draft']));
        return;
      }
      out.push(withNeeds(esc(`PR #${pr.number} draft 超龄要收口，但${resolved.why}`, {
        reason: resolved.reason, pr: pr.number, issue: resolved.issueNo, model: resolved.rModel,
      }), N['pump-draft']));
      return;
    }
    if (!takeFinishSlot()) {
      reportAdmission(N['pump-draft']);
      return;
    }
    const hours = Number(policy.stalledDraftHours) || 24;
    out.push(withNeeds({
      kind: 'pump-draft', pr: pr.number, issue: resolved.issueNo,
      model: resolved.pumpModel, reviewer: resolved.rReviewer,
      head: typeof pr.headRefOid === 'string' && pr.headRefOid.trim() ? pr.headRefOid.trim() : null,
      title: pr.title || '', pumpKey: pkey, tries: tries + 1,
      ...(resolved.substituted ? { substitutedModel: resolved.substituted } : {}),
      why: `PR #${pr.number} draft 超 ${hours}h 无提交且无活会话——派收口短会话（第 ${tries + 1}/${maxPumps} 次）`
        + (resolved.substituted ? `；原模型 ${resolved.substituted.from} 派不出（${resolved.substituted.why}），顶班 ${resolved.substituted.to}` : ''),
    }, N['pump-draft']));
    out.push(withNeeds(hub(
      `PR #${pr.number} draft 超龄无人推，已派收口短会话（第 ${tries + 1}/${maxPumps} 次）`,
      'dispatched', { pr: pr.number },
    ), N['pump-draft']));
  }
  for (const pr of gh.prs || []) {
    if (!draftStalledForPump(pr)) continue;
    pushPumpDraft(pr);
  }

  // ⑤ 对账循环（#1056）：未结 job.dispatch ∖ 活会话 → 差集重派。
  // 观测面和期望集都没挂上（老夹具）→ 整段跳过，既有动作不受影响。
  // sessions 不进 SITUATION_SECTIONS：名单没查成只挡住重派，不许把合并/叫审官整轮停掉。
  if (situation.sessions != null || situation.desiredJobs != null) {
    const desired = situation.desiredJobs;
    // 差集重派也起会话，吃同一份机器余量。夹具没给 admission 时 slotsLeft=Infinity，
    // 退回旧缺省 2（#849），不按已退役的 maxDispatchPerRound 键。
    const reconcileCap = Number.isFinite(slotsLeft) ? Math.max(0, slotsLeft) : 2;
    const plan = planReconcile({
      desired: desired && desired.unscanned ? null : (desired && desired.items),
      sessions: sessionListForLiveness(situation),
      openIssues: gh.scanned ? (gh.issues || []).map((i) => i && i.number).filter((n) => Number.isInteger(n)) : null,
      openPrs: gh.scanned ? (gh.prs || []).map(pr => {
        const review = analyzeReviewsAtHead(prReviewInput(reviews.byPr?.[pr.number]), pr.headRefOid);
        const mergeable = String(effectiveMergeability.get(pr.number) || pr.mergeable || '').toUpperCase();
        // 差集「已交卷等审查」只在真冲突 / 当前 head 真红时才叫工人回来。
        // UNKNOWN、审查没查成 ≠ 冲突：那是没查成，按 #1056 当有人在做，不许再派工人。
        return { ...pr, reworkRequired: mergeable === 'CONFLICTING' || (review.scanned === true && review.latestRed === true) };
      }) : null,
      alreadyQueued: out.map((a) => a.issue || a.approvalIssue).filter((n) => Number.isInteger(n)),
      maxPerRound: reconcileCap > 0 ? reconcileCap : 1,
      dispatchedThisRound: 0,
    });
    if (plan.unscanned) {
      out.push(withNeeds(esc(plan.reports[0] || '对账循环没查成——当有人在做，不重派', {
        reason: 'unscanned', detail: 'reconcile-unscanned',
      }), N.dispatch));
    }
    for (const rd of plan.redispatches) {
      // #1116：差集重派的选型只读对应 PR 的 label，不回退 issue 上的旧标。
      // 匹配键带仓：跨仓同号不得套本仓 PR 的 model/reviewer。
      const pr = correspondingPrForRedispatch(rd, gh.prs, { homeRepo });
      if (!pr) {
        const cross = ticketRepoIsForeign(rd && rd.repo, homeRepo);
        out.push(withNeeds(esc(
          cross
            ? `#${rd.issue} 差集要重派，目标仓 ${rd.repo} 不是当前指挥官仓 ${homeRepo}，需人工补标（不得用同号本仓 PR）`
            : `#${rd.issue} 差集要重派，但找不到对应 PR，需人工补标（不读 issue、不猜）`,
          { reason: 'missing-labels', issue: rd.issue, pr: rd.pr || null, repo: rd.repo || null },
        ), N.dispatch));
        continue;
      }
      const model = labelValue(pr, 'model/');
      const reviewer = labelValue(pr, 'reviewer/');
      const role = labelValue(pr, 'type/');
      if (!model || !reviewer) {
        out.push(withNeeds(esc(
          `PR #${pr.number} 差集要重派，但 PR 上缺 ${!model ? 'model/' : ''}${!model && !reviewer ? '、' : ''}${!reviewer ? 'reviewer/' : ''}，需人工打标（不读 issue、不猜）`,
          { reason: 'missing-labels', pr: pr.number, issue: rd.issue, title: pr.title || '', repo: rd.repo || homeRepo },
        ), N.dispatch));
        continue;
      }
      const rGate = assessDispatchModel(model, { policy, enabledIds, redIds });
      if (!rGate.ok) {
        out.push(withNeeds(esc(`PR #${pr.number} 差集要重派，但${rGate.why}`, {
          reason: rGate.reason, pr: pr.number, issue: rd.issue, model, repo: rd.repo || homeRepo,
        }), N.dispatch));
        continue;
      }
      if (!takeSlot()) {
        reportAdmission(N.dispatch);
        continue;
      }
      const issue = (gh.issues || []).find((i) => i && i.number === rd.issue)
        || attributedIssueOf(gh, pr);
      const mergeSource = role === FRAMEWORK_ROLE
        ? { title: issue?.title ?? '', body: issue?.body ?? '', labels: [{ name: `type/${FRAMEWORK_ROLE}` }] }
        : issue;
      const mergePlan = resolveIssueMergePolicy(mergeSource, situation.askPolicy);
      const targetRepo = (rd.repo && String(rd.repo).trim()) || homeRepo || null;
      out.push(withNeeds({
        kind: 'dispatch', issue: rd.issue, pr: pr.number, model, reviewer,
        repo: targetRepo,
        role: role || null,
        title: (issue && issue.title) || pr.title || '',
        mergePolicy: mergePlan.mergePolicy,
        mergeReason: mergePlan.mergeReason,
        mergePolicySource: mergePlan.mergePolicySource,
        why: rd.why + `；merge-policy:${mergePlan.mergePolicy}${mergePlan.mergeReason ? `（${mergePlan.mergeReason}）` : ''}`,
        reconcile: true,
      }, N.dispatch));
      out.push(withNeeds(hub(`#${rd.issue} 账上有人、名单里没有——已自动重派（merge-policy:${mergePlan.mergePolicy}）`, 'dispatched', { issue: rd.issue, pr: pr.number, repo: targetRepo }), N.dispatch));
    }
  }

  // ④ 撞死指纹 + #833 自动换人没接住 → wake-brain
  for (const [term, info] of Object.entries(stall.strikes || {})) {
    if (!info || (info.strikes || 0) < 2) continue;
    const woken = wakeCounts[`stall:${term}`] || 0;
    if (woken >= WAKE_LIMIT) {
      out.push(withNeeds(esc(`终端 ${term} 撞死指纹已唤大脑 ${woken} 次仍没闭环——报帅`, { reason: 'wake-exhausted', term, woken }), N['wake-brain']));
    } else {
      out.push(withNeeds({ kind: 'wake-brain', target: `stall:${term}`, term, why: `终端 ${term} 撞死指纹 strikes=${info.strikes}，#833 自动换人未接住` }, N['wake-brain']));
    }
  }

  // 清树放在 merge 之后：本轮刚决定合的 PR，exec 先 squash 再拆树。
  const mergedPairs = out.filter((a) => a.kind === 'merge' && Number.isInteger(a.pr)).map((a) => {
    const pr = (gh.prs || []).find((p) => p && Number(p.number) === Number(a.pr));
    return {
      pr: a.pr,
      issue: attributedIssueNumber(pr) || a.approvalIssue || null,
      headRefName: pr && pr.headRefName ? String(pr.headRefName) : null,
    };
  });
  const reaps = planTreeReaps({
    trees: markTreesForMergedPrs((treeFace && treeFace.worktrees) || [], mergedPairs),
    sessions: sessionListForLiveness(situation),
    github: gh,
    reviewsByPr: reviews.byPr,
    mergedPrs: mergedPairs.map((p) => p.pr),
  });
  if (reaps && reaps.ok) {
    for (const item of reaps.items || []) {
      out.push(withNeeds({
        kind: 'reap-tree',
        role: item.role,
        pr: item.pr,
        issue: item.issue,
        path: item.path,
        why: item.why,
      }, ACTION_NEEDS['reap-tree']));
    }
  }

  // 短命会话：终态立刻停。树留着，下一轮差集再起短会话。
  // 放在候选列表前面，act 先杀再派，避免租约还握在死人口里。
  // waiting_user 不是 incomplete：人还没回话，停了等于把问题扔掉，下一轮对账会当「人没了」重派（#1174 T8）。
  //
  // 旧口径只停 incomplete（mirasim「一轮跑完在等下一句」）。Codex 审官交卷后
  // phase=done，app-server 还占着渠道——2026-09-15 实咬：#1279 审官已落判定，
  // 返工被「渠道 mirasim 已满员（在途 1 ≥ 上限 1）」拒掉。done/completed/failed
  // 与 incomplete 一样是终态，走正典 classifySessionState，不再手写一份词表。
  // 已确认清退（cleanupVerified）不再 stop：rejected 无 vendor sessionKey 的登记
  // 投影若丢掉这个字段，每轮会拿 launch: 键空转。#1133 §2。
  const stops = [];
  for (const s of sessionListForLiveness(situation) || []) {
    const raw = sessionStateOf(s) || '';
    if (!raw) continue;
    if (raw === 'stopped' || raw === 'gone' || raw === 'cancelled' || raw === 'canceled') continue;
    if (classifySessionState(s) !== 'finished') continue;
    if (s && s.cleanupVerified === true) continue;
    const key = s && (s.key || s.id || s.sessionKey);
    if (!key) continue;
    stops.push(withNeeds({
      kind: 'stop-session',
      sessionKey: String(key),
      workdir: s.cwd || s.workdir || s.worktree || null,
      why: `一轮说完（${raw}），会话不常驻`,
    }, ACTION_NEEDS['stop-session']));
  }
  // 名单里没有活会话、/proc 还占着树：stop-session 杀不到（没有 key）。
  const orphanReaps = planOrphanReaps({
    procs: situation.lease && situation.lease.scanned === true ? situation.lease.procs : null,
    sessions: situation.sessions && situation.sessions.scanned === true
      ? (situation.sessions.items || []) : null,
    sessionsScanned: situation.sessions ? situation.sessions.scanned === true : false,
    leaseScanned: situation.lease ? situation.lease.scanned === true : false,
  });
  for (const a of orphanReaps.actions || []) {
    stops.push(withNeeds(a, ACTION_NEEDS['reap-orphan']));
  }
  if (finishDenied > 0) {
    // 观测通知：名额已经在 collect 里耗尽，跟 PR review 查没查成无关。
    // 挂 N.rereview（含 prReviews）时，reviews 没查成会把这条滤掉——限流又变静默。
    out.push(withNeeds(hub(
      `收尾名额用尽：这一轮还有 ${finishDenied} 个收尾动作（叫审官/返工/解冲突/收口泵）领不到名额，排下一轮。`
      + `本机 ${admission?.cores ?? '?'} 核 ⇒ 上限 ${finishSlotCap(admission?.cores)}；`
      + `连着几轮都报这一条就是上限太紧，扩机器或改 finishSlotCap`,
      'decide',
    ), N['notify-hub']));
  }
  return stops.concat(out);
}

/**
 * 纯函数：态势 → 动作清单。**入口总闸 fail-closed**（审官 #840 红①）。
 * situation 各节形态（scan 负责填，任一节没查成把 scanned 置 false + error）：
 *   github:        { scanned, issues:[{number,title,body,labels:[{name}]}],
 *                    prs:[{number,title,isDraft,reviewDecision,mergeable,headRefOid,statusCheckRollup,body}], error }
 *                  headRefOid 缺 ⇒ 该 PR 的红轮判据按「没查成」走：不清零、也不当仍红
 *   orca:          观察面（#1055 起不进必查清单；退役后 scanned:false 不当闸）
 *   reviewPending: { scanned, items:[{pr,head,reviewer,worker,source,error}], error }
 *   prReviews:     { scanned, byPr:{ <n>:{ reviews:[{state,body,commit_id}], bodies:[...] } }, error }（decide 优先 reviews）
 *   stall:         { scanned, strikes:{ <term>:{strikes,sig} }, error }
 *   sessions:      { scanned, items:[{key,title,state,cwd}], error } —— #1056 观测集；不进 SITUATION_SECTIONS
 *   lease:         { scanned, procs:[{pid,comm,cwd}], error } —— /proc 会话进程；不进总闸，没查成则不产 reap-orphan
 *   desiredJobs:   { unscanned, items:[{job_id,issue,pr,identity,model}], error } —— #1056 期望集（未结 job.dispatch）
 *   wakeCounts:    { <target>: n }——撞死指纹 `stall:<term>` / 代拍 `daipai:issue-<n>`（#931 后 PR 判红不再走唤醒）
 *   reworkDispatched: { `rework:<pr>@<oid>`: {...} }——该 PR 该 head 已派过返工工人；act 侧派工后记账
 *   viewMergeable:  (prNumber) => string | {ok, mergeable, error} —— #1017 列表 UNKNOWN 时单张重查；不注入则 UNKNOWN 保持没查成
 *
 * 契约：任一节 unscanned → 依赖它的动作一律不产，汇成**一条** escalate(reason:'unscanned', missing:[...])；
 *       依赖节全 scanned 的动作照常。全部 unscanned → 只有那一条 escalate、零正向动作。
 */
export function decide(situation = {}) {
  const unscanned = SITUATION_SECTIONS.filter((s) => !situation[s]?.scanned);
  const candidates = collectCandidates(situation);
  const actions = [];
  const openLedger = situation.openIssueLedger || {};
  const hubSeen = situation.hubSeen || {};
  const nowMs = Date.parse(situation.at || '') || 0;
  for (const cand of candidates) {
    const needs = cand._needs || ACTION_NEEDS[cand.kind] || [];
    const missing = needs.filter((s) => !situation[s]?.scanned);
    const { _needs, ...clean } = cand;
    if (missing.length === 0) {
      // #971：能转成 open-issue 的 escalate 当场转。账本只免重开，不免发卡：
      // 已有 OPEN 且没有成功 hubSeen 戳时，仍产 existing 动作去重试卡。
      const next = escalateToOpenIssue(clean, { ledger: openLedger, hubSeen, now: nowMs });
      if (next) actions.push(next);
    }
    // 有 missing 的候选整条丢弃（含随附 notify-hub）——不逐条产 escalate，合并成下面一条
  }
  // 入口总闸：有节没查成 → 一条合并 escalate，列全缺的节。没查成 ≠ 空态势，必须 fail-visible。
  if (unscanned.length) {
    actions.push(esc(`没查成的节：${unscanned.join('、')}——依赖它们的动作一律不产（fail-closed 总闸）`, { reason: 'unscanned', missing: unscanned }));
  }
  // 硬保险：自动路径永不出现清树/写指纹/改 dao.mjs 类破坏性动作（审官「自动路径边界」）。
  for (const a of actions) {
    if (FORBIDDEN_AUTO_KINDS.has(a.kind)) {
      throw new Error(`decide 产出了禁用的自动动作 kind=${a.kind}——自动路径不许有破坏性/越界动作`);
    }
  }
  // 空态势：全查成、无待处理 → noop（静默，不回流）
  if (actions.length === 0) actions.push({ kind: 'noop', why: '盘面全查成、无待处理' });
  return { actions };
}

/**
 * 心跳判据（假时钟可测）：一切正常连续 silenceDays 天静默 → 发一条心跳，与探针同款
 * （沉默要能与死机区分）。lastActivityAt / lastHeartbeatAt 是 ISO 串或 null。
 */
export function heartbeatDue({ state = {}, now = Date.now(), silenceDays = 7 } = {}) {
  const ms = silenceDays * 24 * 3600 * 1000;
  const lastAct = Date.parse(state.lastActivityAt || '') || 0;   // 上次有非 noop 动作
  const lastHb = Date.parse(state.lastHeartbeatAt || '') || 0;   // 上次发心跳
  const anchor = Math.max(lastAct, lastHb); // 从「上次有动静」起算，动作和心跳都算动静
  if (anchor === 0) return { due: false, reason: '无锚点（首轮不发心跳）' };
  if (now - anchor < ms) return { due: false, reason: `静默不足 ${silenceDays} 天` };
  return { due: true, reason: `已静默 ≥ ${silenceDays} 天`, sinceMs: now - anchor };
}

/** 动作清单里是否有「有动静」的动作（非 noop、非纯 unscanned-escalate）——只看动作本身长什么样。 */
export function hasLiveAction(actions = []) {
  return actions.some((a) => a && a.kind !== 'noop' && !(a.kind === 'escalate' && a.reason === 'unscanned'));
}

/**
 * 这一轮算不算「盘面在推进」——心跳的锚点判据。
 *
 * 2026-09-15 实咬：`hasLiveAction` 只看动作**长什么样**，不看它有没有改变什么。
 * 昨晚连续 9 轮唯一的动作都是同一条 `{kind:'escalate', reason:'missing-labels', issue:1174}`，
 * 它 kind 不是 noop、reason 不是 unscanned ⇒ 判成「有动静」⇒ `lastActivityAt` 每 20 分钟
 * 刷新一次 ⇒ **心跳永远不到期，系统自认一切正常**，而盘面整整冻了 10 小时、
 * 26 张开放 PR 有 22 张被跳过。
 *
 * 「服务没挂」和「活在推进」是两回事，原判据只测了前者（判例 memory `clean-exit-is-still-down`
 * 的同族：干净退出照样是死了，这里是干净空转照样是停了）。
 *
 * 判据补上第二个条件：**动作摘要跟上一轮不一样**。同一套动作重复 = 磨盘，不刷新锚点，
 * 于是静默计时正常走，心跳该响就响。
 *
 * `digestStreak` 必须是 `nextDigestStreak` 写回后的值（commander.mjs 先写 state 再调本函数）：
 *   · 0 = 本轮摘要跟上轮不同（或首轮）→ 算推进
 *   · ≥1 = 已经连续相同 → 磨盘，从第一轮重复起就不刷新锚点
 *
 * `digestStreak` 拿不到（undefined/非数）时退回旧行为——没查成不许当成「停了」，
 * 那会把正常运转误报成死机。
 */
export function countsAsProgress({ actions = [], digestStreak } = {}) {
  if (!hasLiveAction(actions)) return false;
  const n = Number(digestStreak);
  if (!Number.isFinite(n)) return true;   // 没查成 ⇒ 退回旧行为
  return n === 0;                         // nextDigestStreak：新摘要 0；第二轮相同才 ≥1
}

/**
 * 推进量：这一轮的动作摘要跟上一轮比，有没有变。
 *
 * 2026-09-11 立（一晚四个死点全靠它抓到）。判据是**动作摘要连续相同 = 停住**：
 *   · 12 张认输 PR 零动作 → 每轮摘要一模一样，不报错；
 *   · 死动作（被拒的 rereview）→ 每轮产一条，摘要也一模一样，日志里像已经叫过审官；
 *   · 判据读错字段 → 同上；
 *   · 整轮被一个异常带走 → 根本没有摘要。
 * **它们全都不报错**，所以错误扫描找不到；只有「跟上一轮比有没有变化」找得到。
 *
 * 两个刻意的选择：
 *   1. 数 digest 不数动作条数——一条被拒的死动作也是动作，数条数会把它当成有推进；
 *   2. **空闲不算卡住**：全是 noop 时摘要恒为空串，那是「手上没活」不是「卡住」，
 *      已有心跳（7 天静默）管那一头。所以只在确实有活动作时才累计。
 *
 * @returns {{streak:number, digest:string, stuck:boolean}}
 */
export function nextDigestStreak({ actions = [], lastDigest = null, lastStreak = 0, threshold = 6 } = {}) {
  const digest = actionsDigest(actions);
  const hasWork = actions.filter((a) => a && a.kind !== 'noop').length > 0;
  const sameWork = hasWork && lastDigest != null && lastDigest === digest;
  const streak = sameWork ? (Number(lastStreak) || 0) + 1 : 0;
  return { streak, digest, stuck: streak >= Math.max(1, Number(threshold) || 6) };
}

/** 稳定去重键：把一批动作归一成排序后的字符串，act 拿它跟 state 里上一轮比，决定回流不回流。 */
export function actionsDigest(actions = []) {
  const keys = actions
    .filter((a) => a && a.kind !== 'noop')
    .map((a) => {
      const t = a.issue != null ? `i${a.issue}` : a.pr != null ? `p${a.pr}` : a.term ? `t${a.term}` : a.target || '';
      return `${a.kind}:${a.reason || a.moment || ''}:${t}`;
    })
    .sort();
  return keys.join('|');
}
