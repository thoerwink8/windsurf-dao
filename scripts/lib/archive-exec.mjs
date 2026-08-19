// 信箱台收到「可归档」后的二次验证闸（#637）。
// 改这段前必须知道：
//   1. 不信通知自称的合并状态，只信 gh pr view --json state。
//   2. 没查成 ≠ 未合并：两者都 escalate、都不删。
//   3. 审官协议不改：识别靠 subject /^可归档[:：]/；树优先 payload.worktree，否则盘面 linkedPR。
//   4. escalation subject 不得再以「可归档」开头，否则 relay 会回环。

import { worktreeIdOf, prNumberFromWorktree } from './card-identity.mjs';
import { resolveWorktreeSelector } from './dao-cmd.mjs';

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

export function resolveArchiveWorktree({ notice, worktrees } = {}) {
  const list = Array.isArray(worktrees) ? worktrees : [];
  const pr = notice?.pr;
  if (notice?.worktree) {
    const hit = resolveWorktreeSelector(list, notice.worktree);
    if (!hit.ok) return { ok: false, error: hit.error };
    const root = walkToRoot(hit.worktree, list);
    if (root?.isMainWorktree) return { ok: false, error: '拒绝删主树' };
    const rootPr = prNumberOf(root);
    const hitPr = prNumberOf(hit.worktree);
    // #652：父树若挂着别的/未合 PR，只拆本 PR 的树（命中卡），不整树删。
    if (rootPr === pr) {
      // 根卡就是本 PR 的树：子树里没有别的 PR 关联才整树删（未合并 PR 的树不因可归档被删）。
      const foreign = subtreeForeignPrs(root, list);
      if (foreign.length > 0) {
        return { ok: false, error: `根卡子树还挂着别的 PR（${foreign.map(f => `#${f.pr} ${f.name}`).join('、')}）——未删整树（#652：未合并 PR 的树不因可归档被删）` };
      }
      const selector = worktreeIdOf(root);
      if (!selector) return { ok: false, error: '任务卡没有 worktree id' };
      return { ok: true, selector, worktree: root };
    }
    if (hitPr === pr) {
      // 根卡不带本 PR（父树挂别的/未合 PR 或只是 ISSUE 卡）→ 只拆命中卡，不碰父树。
      const foreign = subtreeForeignPrs(hit.worktree, list);
      if (foreign.length > 0) {
        return { ok: false, error: `命中卡子树还挂着别的 PR（${foreign.map(f => `#${f.pr} ${f.name}`).join('、')}）——未删（#652）` };
      }
      const selector = worktreeIdOf(hit.worktree);
      if (!selector) return { ok: false, error: '任务卡没有 worktree id' };
      return { ok: true, selector, worktree: hit.worktree };
    }
    if (rootPr != null) {
      return { ok: false, error: `通知里的树根卡（${root.displayName || worktreeIdOf(root) || '?'}）关联 PR #${rootPr}（linkedPR/卡名/路径），不是 #${pr}——父树还挂着别的 PR，未删整树（#652）` };
    }
    return { ok: false, error: `通知里的树（${hit.worktree?.displayName || '?'}）关联 PR #${hitPr ?? '?'}，不是 #${pr}（#652）` };
  }
  const hits = list.filter((w) => prNumberOf(w) === pr);
  if (hits.length === 0) {
    return { ok: false, error: `盘面没有关联 PR #${pr} 的树` };
  }
  // 每棵命中树向上找根：根卡带同一个 PR → 整树是删除单元（子卡同 PR，随根删）；
  // 根卡带别的/不带 PR（父树挂别的未合 PR 的多工人）→ 命中卡自己是删除单元（只拆已合子卡）。
  const units = [];
  const seenUnit = new Set();
  for (const hit of hits) {
    const root = walkToRoot(hit, list);
    if (root?.isMainWorktree) continue;
    const unit = prNumberOf(root) === pr ? root : hit;
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
  now = new Date(),
} = {}) {
  const ts = toIso(now);
  if (!plan || plan.action === 'ignore') {
    return { ...plan, ts, removed: false, escalated: false, result: 'ignored' };
  }
  if (plan.action === 'rm') {
    if (typeof removeWorktree !== 'function') {
      return finishEscalate(plan, {
        escalate,
        ts,
        reason: '没有 worktree-rm 执行器',
        result: 'rm-failed',
      });
    }
    let rm;
    try {
      rm = removeWorktree(plan.worktree);
    } catch (e) {
      rm = { ok: false, error: String(e?.message || e) };
    }
    if (rm && rm.ok === true) {
      return {
        ...plan,
        ts,
        result: 'removed',
        removed: true,
        escalated: false,
        reason: plan.reason,
      };
    }
    return finishEscalate(plan, {
      escalate,
      ts,
      reason: `worktree-rm 失败：${rm?.error || '未知错误'}`,
      result: 'rm-failed',
    });
  }
  return finishEscalate(plan, { escalate, ts, reason: plan.reason, result: 'escalated' });
}

export function processArchiveNotices(messages, {
  queryPrState,
  listWorktrees,
  removeWorktree,
  escalate,
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
    results.push(applyArchivePlan(plan, { removeWorktree, escalate, now }));
  }
  return results;
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

function finishEscalate(plan, { escalate, ts, reason, result }) {
  const next = {
    ...plan,
    action: 'escalate',
    ts,
    result,
    reason,
    removed: false,
    escalated: false,
  };
  const text = archiveEscalationText(next);
  if (typeof escalate === 'function') {
    try {
      const sent = escalate(text);
      if (sent && sent.ok === false) {
        next.result = 'escalate-failed';
        next.reason = `${reason}；escalation 也没发出：${sent.error || '未知错误'}`;
        return next;
      }
      next.escalated = true;
    } catch (e) {
      next.result = 'escalate-failed';
      next.reason = `${reason}；escalation 抛错：${e?.message || e}`;
      return next;
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
