// 归档关卡（#637 可归档加速 + #665 MERGED 扫描）。
// 改这段前必须知道：
//   1. 不信通知自称的合并状态，只信 gh pr view --json state。
//   2. 没查成 ≠ 未合并：两者都 escalate、都不删。
//   3. 「可归档」只加速，不是门。扫描器每轮按 GitHub MERGED 收树。
//   4. 树认路径 / 卡名 PR-#N / issue 号 / linkedPR 任一，不只认 linkedPR。
//   5. idle / done 不算占用；只有 working / waiting 才拒删。
//      #826：PR 已合并且审官已 approve 时，working/waiting 也不挡（审官 d= 空无法结算的兜底）。
//   6. 失败必须写 GitHub 评论（marshal）。orchestration escalation 会被信箱台自己 ack。
//   7. escalation subject 不得再以「可归档」开头，否则 relay 会回环。
//   8. 2026-08-23（PR #758 教训）：错误文本一律过 errText——Error/结构化对象直接拼
//      字符串会变 [object Object]，真因全丢；失败评论按「PR+失败类别」去重（key 不带
//      易变错误详情），worktree-rm 连败限量后转只升级不重试。

import { issueNumberFromWorktree, prNumberFromWorktree, worktreeIdOf } from './card-identity.mjs';
import { occupyingAgents, resolveWorktreeSelector } from './dao-cmd.mjs';
import { orcaErrorText } from './orca-error.mjs';

/** 任何错误形态 → 可读文本。对象/Error 直接拼字符串 = [object Object]（PR #758 实证）。 */
export function errText(e) {
  const t = orcaErrorText(e);
  return t || '未知错误';
}

const ARCHIVE_SUBJECT = /^可归档[:：]\s*(?:PR[#\s-]*)?#?(\d+)/i;
const SKIP_TYPES = new Set([
  'heartbeat',
  'escalation',
  'ask',
  'question',
  'decision_gate',
  'worker_done',
]);

export function isArchiveReadyMessage(msg) {
  const type = String(msg?.type || '').toLowerCase();
  if (SKIP_TYPES.has(type)) return false;
  return ARCHIVE_SUBJECT.test(String(msg?.subject || ''));
}

export function parseArchiveReadyNotice(msg) {
  const subject = String(msg?.subject || '');
  const matched = subject.match(ARCHIVE_SUBJECT);
  const payload = msg?.payload && typeof msg.payload === 'object' ? msg.payload : {};
  const worktree = firstText(
    payload.worktree,
    payload.worktreeId,
    payload.worktreeSelector,
    msg?.worktree,
  );
  return {
    pr: matched ? Number(matched[1]) : null,
    worktree,
    messageId: msg?.id ?? null,
    subject,
  };
}

export function parsePrStateOutput({ status, stdout, stderr, error } = {}, pr) {
  const n = pr == null ? '?' : pr;
  if (error || (status !== 0 && status != null)) {
    const detail = String(error?.message || stderr || stdout || `exit ${status}`).trim().slice(0, 160);
    return {
      ok: false,
      unscanned: true,
      error: `gh 读 PR #${n} state 失败（${status ?? 'error'}）——不是查过没事：${detail}`,
    };
  }
  const text = String(stdout || '').trim();
  if (!text) {
    return { ok: false, unscanned: true, error: `gh 读 PR #${n} 空输出——不是查过没事` };
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, unscanned: true, error: `gh 读 PR #${n} 返回非 JSON` };
  }
  const state = json?.state;
  if (state == null || String(state).trim() === '') {
    return { ok: false, unscanned: true, error: `gh 读 PR #${n} 没给 state` };
  }
  return { ok: true, state: String(state).trim() };
}

export function planArchiveNotice({
  message,
  prQuery,
  worktrees,
  worktreesOk = true,
  worktreesError,
} = {}) {
  if (!isArchiveReadyMessage(message)) {
    return { action: 'ignore', result: 'ignored' };
  }
  const notice = parseArchiveReadyNotice(message);
  if (!notice.pr) {
    return escalatePlan(notice, '通知里没有 PR 号，无法交叉验证');
  }
  if (!prQuery || prQuery.ok !== true) {
    return escalatePlan(notice, prQuery?.error || 'gh 读 PR state 没查成');
  }
  if (String(prQuery.state).toUpperCase() !== 'MERGED') {
    return escalatePlan(notice, `PR #${notice.pr} 实际是 ${prQuery.state}，不是 MERGED`);
  }
  if (worktreesOk !== true) {
    return escalatePlan(notice, worktreesError || '盘面 worktree 列表没查成，未删任何树');
  }
  const resolved = resolveArchiveWorktree({
    notice,
    worktrees: Array.isArray(worktrees) ? worktrees : [],
  });
  if (!resolved.ok) return escalatePlan(notice, resolved.error);
  return {
    action: 'rm',
    pr: notice.pr,
    worktree: resolved.selector,
    reason: 'PR MERGED，删除任务树',
    messageId: notice.messageId,
  };
}

export function worktreeMatchesArchiveNumber(w, n) {
  const num = Number(n);
  if (!Number.isInteger(num) || num <= 0) return false;
  return archiveNumbersOf(w).has(num);
}

export function resolveArchiveWorktree({ notice, worktrees } = {}) {
  const list = Array.isArray(worktrees) ? worktrees : [];
  const pr = notice?.pr;
  if (notice?.worktree) {
    const hit = resolveWorktreeSelector(list, notice.worktree);
    if (!hit.ok) return { ok: false, error: hit.error };
    const root = walkToRoot(hit.worktree, list);
    if (root?.isMainWorktree) return { ok: false, error: '拒绝删主树' };
    // #652：父树若挂着别的/未合 PR，只拆本号的树（命中卡），不整树删。
    // #633：认路径 / 卡名 / issue / linkedPR，不只认 linkedPR。
    if (worktreeMatchesArchiveNumber(root, pr)) {
      const foreign = subtreeForeignPrs(root, list);
      if (foreign.length > 0) {
        return { ok: false, error: `根卡子树还挂着别的 PR（${foreign.map(f => `#${f.pr} ${f.name}`).join('、')}）——未删整树（#652：未合并 PR 的树不因可归档被删）` };
      }
      const selector = worktreeIdOf(root);
      if (!selector) return { ok: false, error: '任务卡没有 worktree id' };
      return { ok: true, selector, worktree: root };
    }
    if (worktreeMatchesArchiveNumber(hit.worktree, pr)) {
      const foreign = subtreeForeignPrs(hit.worktree, list);
      if (foreign.length > 0) {
        return { ok: false, error: `命中卡子树还挂着别的 PR（${foreign.map(f => `#${f.pr} ${f.name}`).join('、')}）——未删（#652）` };
      }
      const selector = worktreeIdOf(hit.worktree);
      if (!selector) return { ok: false, error: '任务卡没有 worktree id' };
      return { ok: true, selector, worktree: hit.worktree };
    }
    const rootPr = prNumberOf(root);
    const hitPr = prNumberOf(hit.worktree);
    if (rootPr != null) {
      return { ok: false, error: `通知里的树根卡（${root.displayName || worktreeIdOf(root) || '?'}）关联 PR #${rootPr}（linkedPR/卡名/路径），不是 #${pr}——父树还挂着别的 PR，未删整树（#652）` };
    }
    return { ok: false, error: `通知里的树（${hit.worktree?.displayName || '?'}）关联 PR #${hitPr ?? '?'}，不是 #${pr}（路径/卡名/issue/linkedPR 都不认）` };
  }
  const hits = list.filter((w) => worktreeMatchesArchiveNumber(w, pr));
  if (hits.length === 0) {
    return { ok: false, error: `盘面没有对上 #${pr} 的树（路径/卡名/issue/linkedPR）` };
  }
  // 每棵命中树向上找根：根卡带同一个 PR → 整树是删除单元（子卡同 PR，随根删）；
  // 根卡带别的/不带 PR（父树挂别的未合 PR 的多工人）→ 命中卡自己是删除单元（只拆已合子卡）。
  const units = [];
  const seenUnit = new Set();
  for (const hit of hits) {
    const root = walkToRoot(hit, list);
    if (root?.isMainWorktree) continue;
    const unit = worktreeMatchesArchiveNumber(root, pr) ? root : hit;
    const uid = worktreeIdOf(unit);
    if (!uid || seenUnit.has(uid)) continue;
    seenUnit.add(uid);
    const foreign = subtreeForeignPrs(unit, list);
    if (foreign.length > 0) { /* 子树还挂别的 PR：这个删除单元不能整删，留给帅 */ continue; }
    units.push(unit);
  }
  const usable = units.filter((w) => !w.isMainWorktree);
  if (usable.length === 0) return { ok: false, error: '对上的树是主树/子树还挂着别的 PR，拒绝删（#652）' };
  if (usable.length !== 1) {
    return {
      ok: false,
      error: `对上 ${usable.length} 棵任务卡（${usable.map((w) => worktreeIdOf(w) || '?').join('、')}），未删`,
    };
  }
  const selector = worktreeIdOf(usable[0]);
  if (!selector) return { ok: false, error: '任务卡没有 worktree id' };
  return { ok: true, selector, worktree: usable[0] };
}

export function applyArchivePlan(plan, {
  removeWorktree,
  escalate,
  commentGithub,
  commentStore,
  rmAttemptStore,
  now = new Date(),
} = {}) {
  const ts = toIso(now);
  if (!plan || plan.action === 'ignore' || plan.action === 'skip') {
    return { ...plan, ts, removed: false, escalated: false, result: plan?.action === 'skip' ? 'skipped' : 'ignored' };
  }
  if (plan.action === 'refuse') {
    return { ...plan, ts, removed: false, escalated: false, result: 'refused' };
  }
  if (plan.action === 'unscanned') {
    return finishEscalate(plan, {
      escalate,
      commentGithub,
      commentStore,
      ts,
      reason: plan.reason,
      result: 'unscanned',
    });
  }
  if (plan.action === 'rm') {
    if (typeof removeWorktree !== 'function') {
      return finishEscalate(plan, {
        escalate,
        commentGithub,
        commentStore,
        ts,
        reason: '没有 worktree-rm 执行器',
        result: 'rm-failed',
      });
    }
    // PR #758：rm 连败限量。超过 RM_ATTEMPT_MAX 不再自动重试（file watcher 不退这类
    // 结构性失败重试无用），转只升级一次（评论按类别去重，不刷屏）。
    const attemptKey = commentKey(plan.pr ?? plan.worktree, 'rm');
    if (!shouldAttemptRm(attemptKey, rmAttemptStore)) {
      return finishEscalate(plan, {
        escalate,
        commentGithub,
        commentStore,
        ts,
        reason: `worktree-rm 连败已达 ${RM_ATTEMPT_MAX} 次，不再自动重试（结构性失败要人看）`,
        result: 'rm-gave-up',
      });
    }
    let rm;
    try {
      rm = removeWorktree(plan.worktree);
    } catch (e) {
      rm = { ok: false, error: errText(e) };
    }
    if (rm && rm.ok === true) {
      clearRmAttempts(attemptKey, rmAttemptStore);
      return {
        ...plan,
        ts,
        result: 'removed',
        removed: true,
        escalated: false,
        commented: false,
        reason: plan.reason,
      };
    }
    noteRmAttempt(attemptKey, rmAttemptStore);
    return finishEscalate(plan, {
      escalate,
      commentGithub,
      commentStore,
      ts,
      reason: `worktree-rm 失败：${errText(rm?.error)}`,
      result: 'rm-failed',
    });
  }
  return finishEscalate(plan, {
    escalate,
    commentGithub,
    commentStore,
    ts,
    reason: plan.reason,
    result: 'escalated',
  });
}

export function processArchiveNotices(messages, {
  queryPrState,
  listWorktrees,
  removeWorktree,
  escalate,
  commentGithub,
  commentStore,
  rmAttemptStore,
  now = new Date(),
} = {}) {
  const results = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!isArchiveReadyMessage(message)) continue;
    const notice = parseArchiveReadyNotice(message);
    let prQuery = { ok: false, error: '未查 PR state' };
    if (notice.pr) {
      if (typeof queryPrState !== 'function') {
        prQuery = { ok: false, unscanned: true, error: '没有 gh 执行器，未查成' };
      } else {
        try {
          prQuery = queryPrState(notice.pr);
        } catch (e) {
          prQuery = { ok: false, unscanned: true, error: `gh 读 PR #${notice.pr} 抛错：${e?.message || e}` };
        }
      }
    }
    let worktrees = [];
    let worktreesOk = true;
    let worktreesError;
    if (prQuery.ok && String(prQuery.state).toUpperCase() === 'MERGED') {
      if (typeof listWorktrees !== 'function') {
        worktreesOk = false;
        worktreesError = '没有盘面查询器，未查成';
      } else {
        try {
          const listed = listWorktrees();
          if (!listed || listed.ok !== true || !Array.isArray(listed.worktrees)) {
            worktreesOk = false;
            worktreesError = listed?.error || '盘面 worktree 列表没查成';
          } else {
            worktrees = listed.worktrees;
          }
        } catch (e) {
          worktreesOk = false;
          worktreesError = `盘面查询抛错：${e?.message || e}`;
        }
      }
    }
    const plan = planArchiveNotice({
      message,
      prQuery,
      worktrees,
      worktreesOk,
      worktreesError,
    });
    results.push(applyArchivePlan(plan, {
      removeWorktree, escalate, commentGithub, commentStore, rmAttemptStore, now,
    }));
  }
  return results;
}

export function archiveFailureComment(plan) {
  const pr = plan?.pr ? `#${plan.pr}` : '未知';
  return {
    pr: plan?.pr ?? null,
    worktree: plan?.worktree ?? null,
    body: [
      `归档失败：PR ${pr}`,
      `原因：${plan?.reason || '验证未过'}`,
      `树：${plan?.worktree || '（未解析）'}`,
      `结果：${plan?.result || plan?.action || 'escalated'}`,
      '可归档只加速，下一轮 MERGED 扫描仍会收。idle/done 终端不算占用。',
    ].join('\n'),
  };
}

export function commentKey(pr, reason) {
  return `${pr ?? '?'}::${String(reason || '').slice(0, 120)}`;
}

export function shouldWriteFailureComment(key, store) {
  if (!key) return false;
  if (store && typeof store.has === 'function' && store.has(key)) return false;
  return true;
}

export function rememberFailureComment(key, store) {
  if (key && store && typeof store.add === 'function') store.add(key);
}

export function subtreeOccupying(w, worktrees) {
  const out = [];
  for (const node of subtreeOf(w, worktrees)) {
    const agents = occupyingAgents(node);
    if (agents.length) {
      out.push({
        name: node.displayName || worktreeIdOf(node) || '?',
        states: agents.map((a) => a.state),
      });
    }
  }
  return out;
}

export function planMergedScan({ worktrees, queryPrState, queryPrReviews } = {}) {
  if (!Array.isArray(worktrees)) {
    return {
      ok: false,
      scanned: false,
      unscanned: true,
      error: '盘面 worktree 列表没查成——不是扫到 0',
      plans: [],
    };
  }
  const plans = [];
  const seen = new Set();
  for (const w of worktrees) {
    if (!w || w.isMainWorktree) continue;
    const pr = prNumberFromWorktree(w);
    if (pr == null) continue;
    const root = walkToRoot(w, worktrees);
    if (root?.isMainWorktree) continue;
    const unit = worktreeMatchesArchiveNumber(root, pr) ? root : w;
    const uid = worktreeIdOf(unit);
    const dedupe = `${uid || '?'}#${pr}`;
    if (!uid || seen.has(dedupe)) continue;
    seen.add(dedupe);

    let prQuery;
    if (typeof queryPrState !== 'function') {
      prQuery = { ok: false, unscanned: true, error: '没有 gh 执行器，未查成' };
    } else {
      try {
        prQuery = queryPrState(pr);
      } catch (e) {
        prQuery = { ok: false, unscanned: true, error: `gh 读 PR #${pr} 抛错：${e?.message || e}` };
      }
    }
    if (!prQuery || prQuery.ok !== true) {
      plans.push({
        action: 'unscanned',
        pr,
        worktree: uid,
        reason: prQuery?.error || 'gh 读 PR state 没查成',
      });
      continue;
    }
    if (String(prQuery.state).toUpperCase() !== 'MERGED') {
      plans.push({
        action: 'skip',
        pr,
        worktree: uid,
        reason: `PR #${pr} 实际是 ${prQuery.state}`,
      });
      continue;
    }
    const foreign = subtreeForeignPrs(unit, worktrees);
    if (foreign.length > 0) {
      plans.push({
        action: 'escalate',
        pr,
        worktree: uid,
        reason: `根卡子树还挂着别的 PR（${foreign.map((f) => `#${f.pr} ${f.name}`).join('、')}）——未删整树`,
      });
      continue;
    }
    const occ = subtreeOccupying(unit, worktrees);
    if (occ.length) {
      let approved = false;
      if (typeof queryPrReviews === 'function') {
        let reviews;
        try { reviews = queryPrReviews(pr); }
        catch (e) {
          reviews = { ok: false, unscanned: true, error: `gh 读 PR #${pr} reviews 抛错：${e?.message || e}` };
        }
        if (!reviews || reviews.ok !== true) {
          plans.push({
            action: 'unscanned',
            pr,
            worktree: uid,
            reason: reviews?.error || `占用中且 PR #${pr} reviews 没查成，不许当已 approve`,
          });
          continue;
        }
        const list = Array.isArray(reviews.reviews) ? reviews.reviews : [];
        approved = list.some((r) => {
          const s = String(r?.state || r?.verdict || '').toUpperCase();
          return s === 'APPROVED' || s === 'APPROVE';
        });
      }
      if (approved) {
        plans.push({
          action: 'rm',
          pr,
          worktree: uid,
          waivedOccupancy: true,
          reason: 'PR MERGED 且审官已 approve，working/waiting 不挡归档（#826）',
        });
        continue;
      }
      plans.push({
        action: 'refuse',
        pr,
        worktree: uid,
        reason: `占用中（working/waiting）：${occ.map((o) => `${o.name} agent=${o.states.join(',')}`).join('；')}——idle/done 不算占用`,
      });
      continue;
    }
    plans.push({
      action: 'rm',
      pr,
      worktree: uid,
      reason: 'PR MERGED，扫描收树（可归档不是门）',
    });
  }
  return {
    ok: true,
    scanned: true,
    unscanned: false,
    plans,
    trees: worktrees.length,
  };
}

export function processMergedScan({
  worktrees,
  queryPrState,
  queryPrReviews,
  removeWorktree,
  escalate,
  commentGithub,
  commentStore,
  rmAttemptStore,
  now = new Date(),
} = {}) {
  const planned = planMergedScan({ worktrees, queryPrState, queryPrReviews });
  if (!planned.ok) return { ...planned, results: [] };
  const results = planned.plans.map((plan) => applyArchivePlan(plan, {
    removeWorktree, escalate, commentGithub, commentStore, rmAttemptStore, now,
  }));
  return { ...planned, results };
}

export function formatMergedScanLog(scan, now) {
  const ts = toIso(now || new Date());
  if (!scan || scan.ok !== true) {
    return JSON.stringify({
      ts,
      type: 'merged-scan',
      result: 'unscanned',
      reason: scan?.error || '盘面没查成',
      scanned: 0,
    });
  }
  const results = Array.isArray(scan.results) ? scan.results : [];
  return JSON.stringify({
    ts,
    type: 'merged-scan',
    result: 'scanned',
    trees: scan.trees ?? null,
    plans: (scan.plans || []).length,
    removed: results.filter((r) => r.removed).length,
    refused: results.filter((r) => r.result === 'refused').length,
    unscanned: results.filter((r) => r.result === 'unscanned').length,
    failed: results.filter((r) => r.result === 'rm-failed' || r.result === 'escalated').length,
  });
}

export function formatArchiveExecLog(record, now) {
  const ts = record?.ts || toIso(now || new Date());
  return JSON.stringify({
    ts,
    type: 'archive-exec',
    pr: record?.pr ?? null,
    worktree: record?.worktree ?? null,
    result: record?.result ?? null,
    reason: record?.reason ?? '',
    messageId: record?.messageId ?? null,
  });
}

export function archiveEscalationText(plan) {
  const pr = plan?.pr ? `#${plan.pr}` : '未知';
  return {
    subject: `归档闸未过：PR ${pr}`,
    body: [
      `原因：${plan?.reason || '验证未过'}`,
      `PR：${pr}`,
      `树：${plan?.worktree || '（未解析）'}`,
      `消息：${plan?.messageId || '（无 id）'}`,
    ].join('\n'),
  };
}

function escalatePlan(notice, reason) {
  return {
    action: 'escalate',
    pr: notice?.pr ?? null,
    worktree: notice?.worktree ?? null,
    reason,
    messageId: notice?.messageId ?? null,
  };
}

/** worktree-rm 连败上限（PR #758：连挂 6 次每次刷评论）。超过就不再自动 rm，只升级。 */
export const RM_ATTEMPT_MAX = 3;

/** rm 限量判据：store 是 Map（key→次数）；没给 store = 老调用方，不限量。 */
export function shouldAttemptRm(key, store, max = RM_ATTEMPT_MAX) {
  if (!store || typeof store.get !== 'function') return true;
  return (Number(store.get(key)) || 0) < max;
}

export function noteRmAttempt(key, store) {
  if (!store || typeof store.set !== 'function' || typeof store.get !== 'function') return;
  store.set(key, (Number(store.get(key)) || 0) + 1);
}

export function clearRmAttempts(key, store) {
  if (!store || typeof store.delete !== 'function') return;
  store.delete(key);
}

function finishEscalate(plan, { escalate, commentGithub, commentStore, ts, reason, result }) {
  const next = {
    ...plan,
    action: 'escalate',
    ts,
    result,
    reason,
    removed: false,
    escalated: false,
    commented: false,
  };
  const text = archiveEscalationText(next);
  if (typeof escalate === 'function') {
    try {
      const sent = escalate(text);
      if (sent && sent.ok === false) {
        next.result = 'escalate-failed';
        next.reason = `${reason}；escalation 也没发出：${errText(sent.error)}`;
      } else {
        next.escalated = true;
      }
    } catch (e) {
      next.result = 'escalate-failed';
      next.reason = `${reason}；escalation 抛错：${errText(e)}`;
    }
  }
  const comment = archiveFailureComment(next);
  // PR #758：评论 key 用「PR + 失败类别」（result 是稳定枚举），不带易变错误详情——
  // 否则每轮错误文本略变就刷一条新评论（6 连刷实证）。
  const key = commentKey(next.pr, next.result);
  if (typeof commentGithub === 'function' && shouldWriteFailureComment(key, commentStore)) {
    try {
      const sent = commentGithub(comment);
      if (sent && sent.ok === false) {
        next.reason = `${next.reason}；GitHub 评论没写成：${errText(sent.error)}`;
      } else {
        next.commented = true;
        rememberFailureComment(key, commentStore);
      }
    } catch (e) {
      next.reason = `${next.reason}；GitHub 评论抛错：${errText(e)}`;
    }
  }
  return next;
}

function prNumberOf(w) {
  return prNumberFromWorktree(w);
}

// #652：根卡子树（含后代）里跟根卡不同 PR 关联的树。整树删前必须确认子树没有别的 PR。
function subtreeForeignPrs(w, worktrees) {
  const rootPr = prNumberOf(w);
  const out = [];
  for (const node of subtreeOf(w, worktrees)) {
    const n = prNumberOf(node);
    if (n != null && n !== rootPr) {
      out.push({ pr: n, name: node.displayName || worktreeIdOf(node) || '?' });
    }
  }
  return out;
}

function subtreeOf(w, worktrees) {
  const list = Array.isArray(worktrees) ? worktrees : [];
  const out = [];
  const stack = [w];
  const seen = new Set();
  while (stack.length) {
    const cur = stack.pop();
    if (!cur) continue;
    const id = worktreeIdOf(cur);
    if (id) {
      if (seen.has(id)) continue;
      seen.add(id);
    }
    out.push(cur);
    if (!id) continue;
    for (const other of list) {
      const oid = worktreeIdOf(other);
      if (oid && !seen.has(oid) && other.parentWorktreeId && idsEqual(other.parentWorktreeId, id)) {
        stack.push(other);
      }
    }
  }
  return out;
}

function archiveNumbersOf(w) {
  const nums = new Set();
  const pr = prNumberFromWorktree(w);
  if (pr) nums.add(pr);
  const issue = issueNumberFromWorktree(w);
  if (issue) nums.add(issue);
  const path = String(w?.path || w?.git?.path || '').replace(/\\/g, '/');
  const mi = path.match(/ISSUE-#?(\d+)/i);
  if (mi) nums.add(Number(mi[1]));
  return nums;
}

function walkToRoot(w, worktrees) {
  const list = Array.isArray(worktrees) ? worktrees : [];
  let cur = w;
  const seen = new Set();
  while (cur && cur.parentWorktreeId) {
    const pid = String(cur.parentWorktreeId);
    if (seen.has(pid)) break;
    seen.add(pid);
    const parent = list.find((x) => idsEqual(worktreeIdOf(x), cur.parentWorktreeId));
    if (!parent) break;
    cur = parent;
  }
  return cur;
}

function idsEqual(a, b) {
  const left = String(a || '');
  const right = String(b || '');
  if (!left || !right) return false;
  return left === right
    || left.endsWith(`::${right}`)
    || right.endsWith(`::${left}`);
}

function firstText(...vals) {
  for (const v of vals) {
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

function toIso(now) {
  if (now instanceof Date) return now.toISOString();
  if (typeof now === 'string') return now;
  return new Date().toISOString();
}
