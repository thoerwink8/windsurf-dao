// scripts/lib/dispatch/reviewer.mjs —— 审官闭环域（#762 拆分）
//
// 改这段前必须知道：一张 PR 只许一个审官。四态必须分开：
// 复用已有 / 允许新建 / 已有所以拒绝新建 / 没查成。
// 审官位只许当前路由表 reviewerOrder[0]（现为 Codex），换厂当场拒。
// 审官 dispatch 已结算：报帅，不许自动 reviewer-create / 换厂再造。

import { prNumberFromWorktree } from '../card-identity.mjs';
import { extractSoldierTerminal, isLiveDispatchRecipient, readDispatchSettlement } from './deliver.mjs';
import { assertCrossVendor } from '../reviewer-vendor-gate.mjs';
import { normalizePipes } from '../next-launch.mjs';
import { availabilityFor } from '../provider-health.mjs';
import { loadDispatchPolicy, runPreflight } from '../preflight.mjs';
import { preflightStopReport } from './launch.mjs';

export function reviewerCardName(reviewerId) {
  return `审官·${reviewerId}`;
}

function worktreeIdMatches(workerWtId, sel) {
  const id = String(workerWtId || '');
  const want = String(sel || '');
  if (!id || !want) return false;
  return id === want || id.endsWith(`::${want}`) || id.endsWith(want);
}

function reviewerHandleFromWorker(w) {
  return w?.agentTerminalHandle || w?.resource?.terminalHandle || null;
}

function terminalIsLive(handle, terminals) {
  if (!handle) return false;
  if (!Array.isArray(terminals)) return false;
  const t = terminals.find(x => x && x.handle === handle);
  if (!t) return false;
  if (t.connected === false || t.writable === false || t.orphaned === true) return false;
  const st = String(t.status || t.state || '').toLowerCase();
  if (!st) return true;
  return !/^(exited|closed|stopped|stale|dead)$/.test(st);
}

function isActiveDispatch(w) {
  return w && w.dispatchStatus !== 'completed' && w.workerState !== 'succeeded';
}

function pickHandleFromHits(hits, terminals) {
  const prefer = hits.filter(isActiveDispatch);
  const ordered = prefer.concat(hits.filter(w => !prefer.includes(w)));
  const seen = [];
  for (const w of ordered) {
    const h = reviewerHandleFromWorker(w);
    if (!h || seen.includes(h)) continue;
    seen.push(h);
    if (terminalIsLive(h, terminals)) return { handle: h, live: true };
  }
  return { handle: seen[0] || null, live: false };
}

export const REVIEWER_CREATE_OUTCOMES = {
  reused: 'reused',
  created: 'created',
  refusedExisting: 'refused-existing',
  unscanned: 'unscanned',
  create: 'create',
};

const REFUSE_EXISTING_REVIEWER = '已有审官树/审官卡，拒绝新建（不许 Orca -2/-3）';

/**
 * 按 PR 收已有审官卡：工人卡子卡 ∩ dispatch 记账，或子卡/工人卡带该 PR 号。
 * 没拿到列表 → unscanned，和「扫完 0 张」分开。
 */
export function collectReviewerCardsForPr({ pr, parentId, worktrees, workers } = {}) {
  if (worktrees == null || !Array.isArray(worktrees)) {
    return { ok: false, unscanned: true, error: 'worktree list 没查成（没查成，不许猜有没有审官卡）' };
  }
  if (workers == null || !Array.isArray(workers)) {
    return { ok: false, unscanned: true, error: 'worker-list 没查成（没查成，不许猜 dispatch 记账）' };
  }
  const n = Number(pr);
  if (!Number.isInteger(n) || n <= 0) {
    return { ok: false, unscanned: true, error: 'collectReviewerCardsForPr 没给合法 PR 号（没查成）' };
  }

  const cards = [];
  const seen = new Set();
  function add(w, via) {
    const id = w && (w.id || w.worktreeId);
    if (!id || seen.has(id)) return;
    seen.add(id);
    cards.push({
      worktreeId: id,
      worktree: w,
      via,
      createdAt: Number(w.createdAt) || 0,
    });
  }

  if (parentId) {
    for (const child of worktrees.filter(w => (w.parentWorktreeId || null) === parentId)) {
      const cid = child.id || child.worktreeId;
      if (!cid) continue;
      const booked = workers.some(w => worktreeIdMatches(w?.resource?.worktreeId, cid));
      if (booked) add(child, 'parent+dispatch');
    }
  }

  for (const w of worktrees) {
    if (!w || !w.parentWorktreeId) continue;
    if (prNumberFromWorktree(w) === n) add(w, 'pr+child');
  }

  const workerParents = worktrees.filter(w => w && !w.parentWorktreeId && prNumberFromWorktree(w) === n);
  for (const parent of workerParents) {
    const pid = parent.id || parent.worktreeId;
    if (!pid) continue;
    for (const child of worktrees.filter(w => (w.parentWorktreeId || null) === pid)) {
      const cid = child.id || child.worktreeId;
      if (!cid) continue;
      const booked = workers.some(x => worktreeIdMatches(x?.resource?.worktreeId, cid));
      if (booked) add(child, 'pr-worker+dispatch');
    }
  }

  return { ok: true, unscanned: false, cards, count: cards.length };
}

/**
 * 一张 PR 只许一个审官。四态必须分开：复用已有 / 允许新建 / 已有所以拒绝新建 / 没查成。
 */
export function gateReviewerCreate({ pr, parentId, worktrees, workers, terminals } = {}) {
  const listed = collectReviewerCardsForPr({ pr, parentId, worktrees, workers });
  if (!listed.ok) {
    return { ok: false, outcome: 'unscanned', unscanned: true, error: listed.error };
  }
  if (terminals == null || !Array.isArray(terminals)) {
    return {
      ok: false,
      outcome: 'unscanned',
      unscanned: true,
      error: 'terminal list 没查成（没查成，不许猜终端死活）',
    };
  }
  if (listed.count === 0) {
    return {
      ok: true,
      outcome: 'create',
      action: 'create',
      reason: '扫完没有该 PR 的审官树/审官卡',
    };
  }

  const withHandles = listed.cards.map(c => {
    const hits = workers.filter(w => worktreeIdMatches(w?.resource?.worktreeId, c.worktreeId));
    const picked = pickHandleFromHits(hits, terminals);
    return { ...c, handle: picked.handle, live: picked.live };
  });
  const live = withHandles.filter(c => c.live && c.handle).sort((a, b) => b.createdAt - a.createdAt);
  if (live.length) {
    const pick = live[0];
    return {
      ok: true,
      outcome: 'reused',
      action: 'reuse',
      worktreeId: pick.worktreeId,
      handle: pick.handle,
      existingCount: listed.count,
      reason: '复用已有审官（该 PR 已有审官树/审官卡，禁止再 create）',
    };
  }

  const pick = withHandles.slice().sort((a, b) => b.createdAt - a.createdAt)[0];
  return {
    ok: false,
    outcome: 'refused-existing',
    action: 'refuse',
    worktreeId: pick.worktreeId,
    // PR #758：半成功卡（建了卡没起成）要能续跑——把路径带出去，消费端可复用该卡
    // 重开终端续跑，而不是拒绝后死循环。
    worktreePath: pick.worktree?.path || null,
    handle: pick.handle || null,
    existingCount: listed.count,
    closedWorktrees: withHandles.map(c => c.worktreeId),
    error: REFUSE_EXISTING_REVIEWER,
    reason: '已有所以拒绝新建',
  };
}

/**
 * #815：reviewer-attach 复用旧审官前必须 worker-read 核活性。
 * 不活或已结算 → 新建树；没查成不许猜。
 * workerRead 缺省 = 先返回 probe（调用方去 worker-read 再喂回来）。
 */
export function planReviewerAttachReuse({ cards, workers, workerRead } = {}) {
  if (cards == null) {
    return { ok: false, unscanned: true, action: 'unscanned', error: '审官卡列表没拿到（没查成，不许猜活性）' };
  }
  if (!cards.ok) {
    return {
      ok: false,
      unscanned: cards.unscanned === true,
      action: 'unscanned',
      error: cards.error || '审官卡没查成',
    };
  }
  if (!cards.count) {
    return { ok: true, action: 'create', reason: '扫完没有该 PR 的审官树，新建' };
  }
  if (workers == null || !Array.isArray(workers)) {
    return { ok: false, unscanned: true, action: 'unscanned', error: 'worker-list 没查成，不许猜审官 dispatch' };
  }
  const pick = [...cards.cards].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0];
  const hits = workers.filter(w => worktreeIdMatches(w?.resource?.worktreeId, pick.worktreeId));
  const dispatchId = hits[0]?.dispatchId || hits[0]?.dispatch_id || null;
  if (!dispatchId) {
    return {
      ok: true,
      action: 'create',
      reason: '已有审官树但没有 dispatch，新建树',
      worktreeId: pick.worktreeId,
    };
  }
  if (workerRead == null) {
    return { ok: true, action: 'probe', dispatchId, worktreeId: pick.worktreeId };
  }
  if (workerRead.ok === false && (workerRead.unscanned || workerRead.json == null)) {
    return {
      ok: false,
      unscanned: true,
      action: 'unscanned',
      dispatchId,
      error: `worker-read 没查成，不许猜活性：${workerRead.error || ''}`.trim(),
    };
  }
  const json = workerRead.json || workerRead;
  const settlement = readDispatchSettlement(json);
  if (settlement.unscanned) {
    return { ok: false, unscanned: true, action: 'unscanned', dispatchId, error: settlement.error };
  }
  if (settlement.settled) {
    return {
      ok: true,
      action: 'create',
      reason: '旧审官已结算，新建树',
      dispatchId,
      worktreeId: pick.worktreeId,
    };
  }
  const live = isLiveDispatchRecipient({
    workerState: json?.result?.worker?.state,
    dispatchStatus: json?.result?.dispatch?.status,
    lastFailure: json?.result?.dispatch?.last_failure,
  });
  const handle = extractSoldierTerminal(json);
  const term = json?.result?.terminal;
  const termDead = !!(term && (term.connected === false || term.writable === false || term.orphaned === true));
  if (!live || !handle || termDead) {
    return {
      ok: true,
      action: 'create',
      reason: '旧审官不活，新建树',
      dispatchId,
      worktreeId: pick.worktreeId,
      handle: handle || null,
    };
  }
  return {
    ok: true,
    action: 'reuse',
    reason: 'worker-read 核活性：旧审官仍活，复用终端',
    dispatchId,
    worktreeId: pick.worktreeId,
    handle,
  };
}

/**
 * 找可复用审官。给了 pr 走一 PR 一审官闸。
 * 已有审官卡（含终端已关）→ 复用或拒绝新建，不许再 create。
 */
export function resolveReviewerReuse({
  parentId,
  worktrees,
  workers,
  terminals,
  pr,
} = {}) {
  if (pr != null && String(pr).trim() !== '') {
    const gate = gateReviewerCreate({ pr, parentId, worktrees, workers, terminals });
    if (gate.outcome === 'unscanned') {
      return { ok: false, unscanned: true, outcome: 'unscanned', error: gate.error };
    }
    if (gate.outcome === 'reused') {
      return {
        ok: true,
        action: 'reuse',
        outcome: 'reused',
        worktreeId: gate.worktreeId,
        handle: gate.handle,
        reason: gate.reason,
      };
    }
    if (gate.outcome === 'refused-existing') {
      return {
        ok: true,
        action: 'refuse',
        outcome: 'refused-existing',
        worktreeId: gate.worktreeId,
        handle: gate.handle || null,
        closedWorktrees: gate.closedWorktrees,
        error: gate.error,
        reason: gate.reason,
      };
    }
    return { ok: true, action: 'create', outcome: 'create', reason: gate.reason };
  }

  if (!parentId) return { ok: false, unscanned: true, error: 'resolveReviewerReuse 没给工人卡 id' };
  if (!Array.isArray(worktrees)) {
    return { ok: false, unscanned: true, error: 'worktree list 没查成（没查成，不许猜有没有审官卡）' };
  }
  if (!Array.isArray(workers)) {
    return { ok: false, unscanned: true, error: 'worker-list 没查成（没查成，不许猜 dispatch 记账）' };
  }
  if (!Array.isArray(terminals)) {
    return { ok: false, unscanned: true, error: 'terminal list 没查成（没查成，不许猜终端死活）' };
  }

  const children = worktrees.filter(w => (w.parentWorktreeId || null) === parentId);
  const candidates = [];
  for (const child of children) {
    const cid = child.id || child.worktreeId;
    if (!cid) continue;
    const hits = workers.filter(w => worktreeIdMatches(w?.resource?.worktreeId, cid));
    if (hits.length === 0) continue;
    const picked = pickHandleFromHits(hits, terminals);
    candidates.push({
      worktreeId: cid,
      handle: picked.handle,
      live: picked.live,
      createdAt: Number(child.createdAt) || 0,
    });
  }

  if (candidates.length === 0) {
    return {
      ok: true,
      action: 'create',
      reason: '工人卡下没有带 dispatch 记账的审官子卡（parentWorktreeId + 记账，不按卡名/PR 号）',
    };
  }

  const live = candidates.filter(c => c.live && c.handle).sort((a, b) => b.createdAt - a.createdAt);
  if (live.length) {
    const pick = live[0];
    return {
      ok: true,
      action: 'reuse',
      worktreeId: pick.worktreeId,
      handle: pick.handle,
      reason: '复用工人卡下已有审官终端（parentWorktreeId + dispatch 记账，不按 PR 号）',
    };
  }

  return {
    ok: true,
    action: 'refuse',
    outcome: 'refused-existing',
    reason: '已有所以拒绝新建',
    error: REFUSE_EXISTING_REVIEWER,
    closedWorktrees: candidates.map(c => c.worktreeId),
    worktreeId: candidates[0].worktreeId,
  };
}

/** 路由表当前审官位（审官.审查 A 位，现为 Codex gpt-5.6-sol）。没查成 ≠ 扫完没有。 */
export function currentReviewerSeat(routing) {
  if (routing == null) {
    return { ok: false, outcome: 'unscanned', unscanned: true, error: '审官位路由表没拿到（没查成，不许猜）' };
  }
  if (!Array.isArray(routing.reviewerOrder)) {
    return { ok: false, outcome: 'unscanned', unscanned: true, error: '审官选型序没查成（没查成，不许猜审官位）' };
  }
  if (routing.reviewerOrder.length === 0) {
    return { ok: false, outcome: 'none', error: '扫完没有可用审官位' };
  }
  return { ok: true, modelId: routing.reviewerOrder[0] };
}

/** 审官位只许当前 Codex 那条。换厂到 kimi/glm/grok 当场拒。 */
export function assertReviewerSeat({ reviewerId, routing } = {}) {
  const seat = currentReviewerSeat(routing);
  if (!seat.ok) return seat;
  const got = reviewerId == null ? '' : String(reviewerId).trim();
  if (!got) return { ok: false, error: '没给审官模型' };
  if (got !== String(seat.modelId)) {
    return {
      ok: false,
      error: `审官位只许 ${seat.modelId}（路由表当前审官 Codex），不许换厂到 ${got}`,
      seat: seat.modelId,
      requested: got,
    };
  }
  return { ok: true, modelId: seat.modelId };
}

/**
 * #799：从工人 job.dispatch 事件读 merge-policy。
 * 匹配优先级：dispatch_id / job_id=dispatch-<id> > issue_number > pr_number。
 * 同档取 ts 最新。字段缺失与「没有匹配事件」分开，都不猜成 auto。
 */
export function pickMergePolicyFromLedger({ events, issue, pr, dispatchId } = {}) {
  if (events == null) {
    return { ok: false, unscanned: true, state: 'unscanned', error: '账本事件没拿到（没查成）' };
  }
  if (!Array.isArray(events)) {
    return { ok: false, unscanned: true, state: 'unscanned', error: '账本事件不是数组（没查成）' };
  }
  const issueN = issue != null && String(issue).trim() !== '' ? Number(issue) : null;
  const prN = pr != null && String(pr).trim() !== '' ? Number(pr) : null;
  const wantDispatch = String(dispatchId || '').trim() || null;

  const scoreOf = (e) => {
    if (!e || e.type !== 'job.dispatch') return 0;
    if (e.identity && e.identity !== '工人') return 0;
    if (wantDispatch && (
      String(e.dispatch_id || '') === wantDispatch
      || String(e.job_id || '') === `dispatch-${wantDispatch}`
    )) return 3;
    if (issueN && Number.isInteger(issueN) && (
      Number(e.issue_number) === issueN || Number(e.issue) === issueN
    )) return 2;
    if (prN && Number.isInteger(prN) && Number(e.pr_number) === prN) return 1;
    return 0;
  };

  const ranked = [];
  for (const e of events) {
    const s = scoreOf(e);
    if (s > 0) ranked.push({ e, s });
  }
  if (ranked.length === 0) {
    return { ok: false, state: 'none', error: '账本没有匹配的工人 job.dispatch' };
  }
  ranked.sort((a, b) => {
    if (a.s !== b.s) return a.s - b.s;
    return String(a.e.ts || '').localeCompare(String(b.e.ts || ''));
  });
  const ev = ranked[ranked.length - 1].e;
  const policy = ev.merge_policy || ev.mergePolicy || null;
  const reason = ev.merge_reason || ev.mergeReason || null;
  if (policy !== 'auto' && policy !== 'manual') {
    return { ok: false, state: 'missing-field', error: '派工记账无 mergePolicy', event: ev };
  }
  return {
    ok: true,
    state: 'one',
    mergePolicy: policy,
    mergeReason: reason ? String(reason) : null,
    source: 'ledger',
    event: ev,
  };
}

/**
 * #799：审官任务书的 merge-policy。
 * 显式旗标 > 账本 > 卡备注；都读不到才回退 auto，并带 fallbackReason 写进任务书。
 */
export function resolveReviewerMergePolicy({
  explicitPolicy, explicitReason, ledger, comment,
} = {}) {
  const explicit = String(explicitPolicy || '').trim();
  if (explicit) {
    if (explicit !== 'auto' && explicit !== 'manual') {
      return { ok: false, error: `--merge-policy 只允许 auto|manual，实际 ${explicit}` };
    }
    if (explicit === 'manual' && !String(explicitReason || '').trim()) {
      return { ok: false, error: '--merge-policy manual 必须给 --merge-reason' };
    }
    return {
      ok: true,
      mergePolicy: explicit,
      mergeReason: explicit === 'manual' ? String(explicitReason).trim() : null,
      source: 'flag',
    };
  }

  if (ledger && ledger.ok && (ledger.mergePolicy === 'auto' || ledger.mergePolicy === 'manual')) {
    return {
      ok: true,
      mergePolicy: ledger.mergePolicy,
      mergeReason: ledger.mergeReason || null,
      source: 'ledger',
    };
  }

  const fromComment = comment && (comment.mergePolicy === 'auto' || comment.mergePolicy === 'manual')
    ? comment
    : null;
  if (fromComment) {
    return {
      ok: true,
      mergePolicy: fromComment.mergePolicy,
      mergeReason: fromComment.mergeReason || null,
      source: 'comment',
    };
  }

  return {
    ok: true,
    mergePolicy: 'auto',
    mergeReason: null,
    source: 'fallback',
    fallbackReason: (ledger && ledger.unscanned) ? '读不到派工记账' : '账本无mergePolicy',
  };
}

/** 审官 dispatch 已结算：报帅，不许自动 reviewer-create / 换厂再造。没查成 ≠ 未结算。 */
export function planAfterSettledReviewer({ settlement } = {}) {
  if (settlement == null) {
    return {
      ok: false,
      unscanned: true,
      create: false,
      switchVendor: false,
      action: 'unscanned',
      error: '审官结算没查成（没查成，不许当没有审官、不许再造卡）',
    };
  }
  if (settlement.unscanned || settlement.ok === false) {
    return {
      ok: false,
      unscanned: true,
      create: false,
      switchVendor: false,
      action: 'unscanned',
      error: settlement.error
        ? `${settlement.error}（没查成，不许当没有审官、不许再造卡）`
        : '审官结算没查成（没查成，不许当没有审官、不许再造卡）',
    };
  }
  if (settlement.settled) {
    return {
      ok: true,
      create: false,
      switchVendor: false,
      action: 'report',
      reason: '审官 dispatch 已结算，报帅，不自动 reviewer-create（同卡重拉是人做的）',
    };
  }
  return {
    ok: true,
    create: false,
    switchVendor: false,
    action: 'none',
    reason: '审官未结算，不造卡',
  };
}

/** 起审官失败停手报，不许选下一个厂商再起。 */
export function planReviewerCreateAfterFail({ error } = {}) {
  return {
    ok: false,
    retry: false,
    switchVendor: false,
    outcome: 'stop',
    error: `审官起败，停手报，不许换厂${error ? `：${error}` : ''}`,
  };
}

/** #675：起审官失败三态。terminal create 超时 / 注入未提交 / 没查成 必须分开。 */
export function classifyReviewerSpawnError(error) {
  const t = String(error || '');
  if (/Timed out waiting for terminal handle|terminal create 失败|terminal create 超时/i.test(t)) {
    return { kind: 'terminal-timeout', label: 'terminal create 超时' };
  }
  if (/注入未提交|Pasted Content|Pasted text/i.test(t)) {
    return { kind: 'inject-unsubmitted', label: '注入未提交' };
  }
  return { kind: 'unscanned', label: '没查成' };
}

export function reviewerSpawnFailComment({ error, retried = false } = {}) {
  const cls = classifyReviewerSpawnError(error);
  return [
    `交卷没开成审官下一跳：${cls.label}`,
    '',
    `worker-done 起审官失败（${cls.label}）。完工评论已落到 GitHub。${retried ? '同一命令已重试一次仍失败。' : ''}`.trim(),
    String(error || ''),
  ].join('\n');
}

export function postIssueComment({ issue, body, runGh } = {}) {
  const n = String(issue ?? '').trim();
  if (!/^\d+$/.test(n)) return { ok: false, unscanned: true, error: 'postIssueComment 没给合法 issue 号' };
  if (!String(body || '').trim()) return { ok: false, error: 'postIssueComment 没给正文' };
  if (typeof runGh !== 'function') return { ok: false, unscanned: true, error: 'postIssueComment 没拿到 gh 执行器' };
  const r = runGh(['issue', 'comment', n, '--body', String(body)]);
  if (!r.ok) return { ok: false, error: `issue #${n} 发评论失败：${r.error}` };
  return { ok: true, issue: n };
}

export function postPrComment({ pr, body, runGh } = {}) {
  const n = String(pr ?? '').trim();
  if (!/^\d+$/.test(n)) return { ok: false, unscanned: true, error: 'postPrComment 没给合法 PR 号' };
  if (!String(body || '').trim()) return { ok: false, error: 'postPrComment 没给正文' };
  if (typeof runGh !== 'function') return { ok: false, unscanned: true, error: 'postPrComment 没拿到 gh 执行器' };
  const r = runGh(['pr', 'comment', n, '--body', String(body)]);
  if (!r.ok) return { ok: false, error: `PR #${n} 发评论失败：${r.error}` };
  return { ok: true, pr: n };
}

/** PR #758 教训：完工评论被重试刷了三遍一模一样。发前先查「同款发过了没」。
 * 比对口径 = trim 后全同（完工评论默认无时间戳，同文即重发）。 */
export function commentAlreadyPosted(comments, body) {
  const want = String(body ?? '').trim();
  if (!want) return false;
  const list = Array.isArray(comments) ? comments : [];
  return list.some(c => String(c && c.body || '').trim() === want);
}

/** 拉 issue/PR 评论列表。没查成 = ok:false unscanned（不许当「没发过」放行）。 */
export function listComments({ kind, number, runGh } = {}) {
  const n = String(number ?? '').trim();
  if (!/^\d+$/.test(n)) return { ok: false, unscanned: true, error: 'listComments 没给合法号码' };
  if (typeof runGh !== 'function') return { ok: false, unscanned: true, error: 'listComments 没拿到 gh 执行器' };
  const r = runGh([kind === 'pr' ? 'pr' : 'issue', 'view', n, '--json', 'comments']);
  if (!r.ok) return { ok: false, unscanned: true, error: `评论列表没查成：${r.error}` };
  try {
    const doc = JSON.parse(r.out);
    return { ok: true, comments: Array.isArray(doc.comments) ? doc.comments : [] };
  } catch {
    return { ok: false, unscanned: true, error: '评论列表不是 JSON（没查成）' };
  }
}

/**
 * #826：审官收口。不需要 Run id / task-id / dispatch-id。
 * 帅手起的审官、或士兵已结算时 d= 为空，任务书没法走 notify --type worker_done。
 * 本动词按 PR 号收口：PR 已合 + 审官已 approve 即合法下班。
 */
export function planReviewerDone({ pr, prState, reviews } = {}) {
  const n = String(pr ?? '').trim();
  if (!n || !/^\d+$/.test(n)) {
    return { ok: false, unscanned: false, error: 'reviewer-done 要 --pr' };
  }
  if (prState == null) {
    return { ok: false, unscanned: true, error: `PR #${n} state 没查成（不许当已合）` };
  }
  if (prState.ok !== true) {
    return {
      ok: false,
      unscanned: !!prState.unscanned,
      error: prState.error || `PR #${n} state 没查成`,
    };
  }
  const state = String(prState.state || '').toUpperCase();
  if (state !== 'MERGED') {
    return {
      ok: false,
      unscanned: false,
      error: `PR #${n} 实际是 ${prState.state}，不是 MERGED（reviewer-done 只收已合的单）`,
    };
  }
  if (reviews == null) {
    return { ok: false, unscanned: true, error: `PR #${n} reviews 没查成（不许当已 approve）` };
  }
  if (reviews.ok !== true) {
    return {
      ok: false,
      unscanned: !!reviews.unscanned,
      error: reviews.error || `PR #${n} reviews 没查成`,
    };
  }
  const list = Array.isArray(reviews.reviews) ? reviews.reviews : [];
  const approved = list.some((r) => {
    const s = String(r?.state || r?.verdict || '').toUpperCase();
    return s === 'APPROVED' || s === 'APPROVE';
  });
  if (!approved) {
    return {
      ok: false,
      unscanned: false,
      error: `PR #${n} 已合但没有 APPROVED review（reviewer-done 不伪造判定）`,
    };
  }
  return {
    ok: true,
    pr: n,
    merged: true,
    approved: true,
    needsRunId: false,
    reason: 'PR 已合并且审官已 approve，不需要 Run id',
  };
}

/** 幂等发评论：同款已发过就跳过。拉取没查成 → ok:false unscanned（不瞎发也不瞎跳）。 */
export function postCommentOnce({ kind, number, body, runGh } = {}) {
  const listed = listComments({ kind, number, runGh });
  if (!listed.ok) return { ok: false, unscanned: true, error: listed.error };
  if (commentAlreadyPosted(listed.comments, body)) {
    return { ok: true, skipped: true, alreadyPosted: true, [kind === 'pr' ? 'pr' : 'issue']: String(number) };
  }
  const post = kind === 'pr' ? postPrComment : postIssueComment;
  const r = post({ pr: number, issue: number, body, runGh });
  return { ...r, alreadyPosted: false };
}

// ── 派前探一针：审官起终端前（#842）──────────────────────────────────────
//
// 审官顺位（reviewerOrder）里，先剔同厂（#679 同厂闸不放宽），再按健康表排序、逐位真探，
// 红换下一位，全红 → stop 报帅停手。逻辑在 lib/preflight.mjs。--no-preflight 跳过且记账。
//
// @param {object} args
// @param {string[]} args.order   审官顺位 id 列表（routing.reviewerOrder）
// @param {Array}  args.models    routing 模型（含 provider/cli_model，算落地与厂商）
// @param {string} args.workerId  工人模型 id（同厂闸）
// @param {boolean} [args.noPreflight]
// @param {string|null} [args.dispatchId]
// @param {function} [args.probe] 注入探针（测试用）
// @param {object} [args.policy] / [args.availabilityResult] / [args.now] 注入
// @returns {Promise<{ok,stop,chosen,switched,probed,hardBlocked,notes,skipped,report}>}
export async function preflightReviewer({
  order = [], models = [], workerId = null, noPreflight = false, dispatchId = null,
  probe, policy, availabilityResult, now = new Date(), root, home,
} = {}) {
  const byId = new Map((models || []).map(m => [m.id, m]));
  // 同厂闸：顺位里与工人同厂的当场剔除，不放宽。
  const vendorFiltered = [];
  for (const id of order || []) {
    const m = byId.get(id);
    if (!m) continue;
    if (workerId != null && String(workerId).trim() !== '') {
      const gate = assertCrossVendor({ workerId, reviewerId: id, models });
      if (gate.state === 'same_vendor') continue;
      // unscanned（查不出厂商）：保守当同厂剔除，不放宽（#679 拿不准不降级）。
      if (gate.state === 'unscanned') continue;
    }
    const pipe = normalizePipes(m)[0];
    if (!pipe || !pipe.provider) continue;
    vendorFiltered.push({ id, landing: pipe });
  }
  if (vendorFiltered.length === 0) {
    return {
      ok: false, stop: true, chosen: null, switched: false, probed: [], hardBlocked: [],
      notes: ['审官顺位里没有可用候选（同厂全剔 / 顺位空）'], skipped: false,
      report: '派前探一针：审官顺位无异厂候选，停手报帅。',
    };
  }
  const pol = policy || loadDispatchPolicy(root ? { root } : {});
  const avail = availabilityResult
    || (pol.useHealthTable ? availabilityFor(vendorFiltered, { home, now: now instanceof Date ? now.getTime() : now }) : undefined);
  const r = await runPreflight({
    candidates: vendorFiltered, policy: pol, noPreflight, role: '审官', dispatchId,
    availabilityResult: avail, probe, now, home,
  });
  const top = vendorFiltered[0] ? vendorFiltered[0].id : null;
  return {
    ok: r.ok,
    stop: r.stop,
    chosen: r.chosen,
    switched: !!(r.chosen && top && r.chosen !== top),
    probed: r.probed,
    hardBlocked: r.hardBlocked,
    notes: r.notes,
    skipped: r.skipped,
    unscannedFallback: !!r.unscannedFallback,
    report: r.stop ? preflightStopReport({ role: '审官', probed: r.probed, hardBlocked: r.hardBlocked }) : null,
  };
}
