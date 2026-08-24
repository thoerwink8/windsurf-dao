// scripts/lib/dispatch/reviewer.mjs —— 审官闭环/选型读取域（#768 从 dao-cmd.mjs 拆出，对外 API 不变）
import { prNumberFromWorktree } from '../card-identity.mjs';

// ── #564 label 自动打：dispatch 记 issue，帅合并时同步到 PR ─────────
// calibrate 读的是 PR 上的 model/* 与 type/*（每 label 必须有程序读它）；派工时 PR 还不存在，
// 所以：dispatch 成功时把 model/<模型> type/<角色> 打到目标 issue；帅合并时由
// `dao pr-sync-labels --pr <N>` 从 issue 同步到 PR。角色缺省写码（dispatch 默认写码类派工）。
// #586：审官选型另记 reviewer/<模型>。label 记「决定」，工人完工时用 pickReviewer 复算。

export const DEFAULT_DISPATCH_TYPE = '写码';
export const REVIEWER_LABEL_PREFIX = 'reviewer/';

function labelNameOf(item) {
  if (typeof item === 'string') return item;
  if (item && typeof item === 'object' && typeof item.name === 'string') return item.name;
  return '';
}
/**
 * 从 label 列表读出唯一的审官模型。无 IO、可复算。
 * 三态必须输出不同的话：查到一个 / 没有 reviewer/* / 有多个。
 * 后两者都算没查成，不许猜一个。没拿到列表（null/非数组）和「扫完 0 条」也要分开。
 */
export function pickReviewer(labels) {
  if (labels == null || !Array.isArray(labels)) {
    return {
      ok: false,
      state: 'unscanned',
      error: 'pickReviewer 没拿到 label 列表（没查成，不许猜）',
    };
  }
  const hits = labels
    .map(labelNameOf)
    .filter(name => name.startsWith(REVIEWER_LABEL_PREFIX) && name.length > REVIEWER_LABEL_PREFIX.length);
  if (hits.length === 0) {
    return {
      ok: false,
      state: 'none',
      error: '没有 reviewer/* label（扫完 0 条，不许猜一个）',
    };
  }
  if (hits.length > 1) {
    return {
      ok: false,
      state: 'many',
      labels: hits,
      error: `有多个 reviewer/* label（${hits.join('、')}，不许猜一个）`,
    };
  }
  return {
    ok: true,
    state: 'one',
    modelId: hits[0].slice(REVIEWER_LABEL_PREFIX.length),
    label: hits[0],
  };
}

const MODEL_LABEL_PREFIX = 'model/';
/** 从 label 列表读出唯一的工人模型。三态同分：一个 / 没有 / 多个。 */

export function pickModel(labels) {
  if (labels == null || !Array.isArray(labels)) {
    return { ok: false, state: 'unscanned', error: 'pickModel 没拿到 label 列表（没查成，不许猜）' };
  }
  const hits = labels
    .map(labelNameOf)
    .filter(name => name.startsWith(MODEL_LABEL_PREFIX) && name.length > MODEL_LABEL_PREFIX.length);
  if (hits.length === 0) {
    return { ok: false, state: 'none', error: '没有 model/* label（扫完 0 条，不许猜一个）' };
  }
  if (hits.length > 1) {
    return {
      ok: false,
      state: 'many',
      labels: hits,
      error: `有多个 model/* label（${hits.join('、')}，不许猜一个）`,
    };
  }
  return {
    ok: true,
    state: 'one',
    modelId: hits[0].slice(MODEL_LABEL_PREFIX.length),
    label: hits[0],
  };
}
/** 起审官前查工人模型。没拿到列表 ≠ 扫完没有 model/*，两者都拒绝起审官。 */

export function requireWorkerModel(labels) {
  const pick = pickModel(labels);
  if (pick.ok) return pick;
  if (pick.state === 'unscanned') {
    return { ...pick, error: '工人模型列表没拿到（没查成），拒绝起审官' };
  }
  if (pick.state === 'none') {
    return { ...pick, error: '扫完没有 model/*，拒绝起审官' };
  }
  return { ...pick, error: `${pick.error}，拒绝起审官` };
}

export function collectIssueLabelsFromPr({ pr, runGh } = {}) {
  const n = String(pr ?? '').trim();
  if (!n) return { ok: false, unscanned: true, error: 'collectIssueLabelsFromPr 没给 PR 号' };
  if (typeof runGh !== 'function') {
    return { ok: false, unscanned: true, error: 'collectIssueLabelsFromPr 没拿到 gh 执行器（没查成，不许猜）' };
  }
  const view = runGh(['pr', 'view', n, '--json', 'title,body']);
  if (!view.ok) return { ok: false, unscanned: true, error: `gh pr view #${n} 失败：${view.error}` };
  let meta;
  try { meta = JSON.parse(view.out); }
  catch { return { ok: false, unscanned: true, error: `gh pr view #${n} 返回非 JSON：${String(view.out).slice(0, 120)}` }; }
  const refs = linkedIssueNumbers(`${meta.title || ''}\n${meta.body || ''}`);
  if (!refs.length) {
    return { ok: false, unscanned: false, error: `PR #${n} 没有署名单号，读不到 issue label（没查成，不许猜）` };
  }
  const collected = [];
  for (const issueNum of refs) {
    const iv = runGh(['issue', 'view', String(issueNum), '--json', 'labels']);
    if (!iv.ok) return { ok: false, unscanned: true, error: `gh issue view #${issueNum} 失败：${iv.error}` };
    let parsed;
    try { parsed = JSON.parse(iv.out); }
    catch { return { ok: false, unscanned: true, error: `gh issue view #${issueNum} 返回非 JSON` }; }
    const names = (Array.isArray(parsed?.labels) ? parsed.labels : []).map(labelNameOf).filter(Boolean);
    collected.push(...names);
  }
  return { ok: true, unscanned: false, refs, labels: collected };
}
/** 读 PR 署名 issue 上的 label，再走 pickReviewer。传了 explicit 就用它（工人路径不传）。 */

export function resolveReviewerFromPr({ pr, reviewer, runGh } = {}) {
  if (reviewer && String(reviewer).trim()) {
    return { ok: true, source: 'flag', modelId: String(reviewer).trim() };
  }
  const collected = collectIssueLabelsFromPr({ pr, runGh });
  if (!collected.ok) {
    if (!collected.unscanned && /没有署名单号/.test(collected.error || '')) {
      const n = String(pr ?? '').trim();
      return { ...collected, error: `PR #${n} 没有署名单号，读不到 reviewer/*（没查成，不许猜）` };
    }
    return collected;
  }
  const picked = pickReviewer(collected.labels);
  if (!picked.ok) return { ...picked, source: 'label', refs: collected.refs, labels: collected.labels };
  return { ...picked, source: 'label', refs: collected.refs, labels: collected.labels };
}
/** 读 PR 上的 review 条数。没查成和「0 条」分开。 */

export function listPrReviews({ pr, runGh } = {}) {
  const n = String(pr ?? '').trim();
  if (!n) return { ok: false, unscanned: true, error: 'listPrReviews 没给 PR 号' };
  if (typeof runGh !== 'function') {
    return { ok: false, unscanned: true, error: 'listPrReviews 没拿到 gh 执行器（没查成，不许猜）' };
  }
  const view = runGh(['pr', 'view', n, '--json', 'reviews']);
  if (!view.ok) return { ok: false, unscanned: true, error: `gh pr view #${n} reviews 失败：${view.error}` };
  let parsed;
  try { parsed = JSON.parse(view.out); }
  catch { return { ok: false, unscanned: true, error: `gh pr view #${n} reviews 返回非 JSON` }; }
  if (!parsed || !Array.isArray(parsed.reviews)) {
    return { ok: false, unscanned: true, error: `gh pr view #${n} 缺 reviews 数组（没查成，不许当 0 条）` };
  }
  return { ok: true, reviews: parsed.reviews, count: parsed.reviews.length };
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
}

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
/** PR 正文/标题里的署名单号：认「署名 issue #N」（#657）、「关联 issue #N」（#633）
 * 与旧的 GitHub 关闭关键词（Closes/Fixes/Resolves…）。正文随手引用的 #单号 仍不算。 */
export function linkedIssueNumbers(text) {
  const found = [];
  const re = /(?:署名\s+issue\s*#?\s*|关联(?:\s*issue)?\s+#|(?:close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved)\s+#)(\d+)/gi;
  let m;
  while ((m = re.exec(String(text || '')))) {
    const t = Number(m[1]);
    if (Number.isInteger(t) && !found.includes(t)) found.push(t);
  }
  return found;
}
/** dispatch 收件人必须还活着。completed/succeeded/failed 不是收件人。 */

export function isLiveDispatchRecipient({ workerState, dispatchStatus } = {}) {
  const live = new Set(['ready', 'working', 'waiting']);
  const dead = new Set(['completed', 'succeeded', 'failed', 'cancelled', 'canceled', 'released', 'stopped']);
  const w = String(workerState || '').toLowerCase();
  const d = String(dispatchStatus || '').toLowerCase();
  if (dead.has(w) || dead.has(d)) return false;
  if (live.has(w)) return true;
  return false;
}
