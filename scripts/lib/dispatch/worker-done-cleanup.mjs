// 交卷清退范围：只停本 PR 的合法工人会话。
//
// 改这段前必须知道：#1400 实咬是主树 worker-done 用 cwd 前缀把嵌套 worktree
// 一并停掉。目录前缀不是任务归属。主树 / 审官树 / 别人的工人树在任何 stop
// 之前拒绝。清单没查成或 stop 失败是 partial，不许冒充全闭环成功。

export function positiveInt(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export function normCleanupPath(p) {
  return String(p || '').replace(/\\/g, '/').replace(/\/+$/, '');
}

export function pathTail(p) {
  return normCleanupPath(p).split('/').filter(Boolean).pop() || '';
}

function branchDirName(branch) {
  const raw = String(branch || '').trim();
  return raw ? raw.replace(/[^\w.-]/g, '-') : '';
}

export function isReviewerTreePath(p) {
  const tail = pathTail(p);
  if (/^dao-review-pr-\d+/i.test(tail)) return true;
  if (/审官/.test(tail)) return true;
  return false;
}

export function sessionCwdOf(s) {
  return normCleanupPath(s && (s.cwd || s.workdir || s.worktree));
}

const TERMINAL_STATES = new Set([
  'stopped', 'done', 'completed', 'failed', 'gone', 'rejected',
  'cancelled', 'canceled', 'finished',
]);

/**
 * 当前 cwd 是不是本 PR 的工人树。纯函数，不扫会话。
 * match=false 时调用方在任何 list/stop 之前返回，结构上够不着别人的会话。
 */
export function judgeWorkerDoneCleanupScope({ cwd, pr, issue, headRefName, mainCheckout } = {}) {
  const n = normCleanupPath(cwd);
  if (!n) return { ok: false, unscanned: true, match: false, why: '停会话没给 cwd' };
  const wantPr = positiveInt(pr);
  if (!wantPr) {
    return { ok: false, unscanned: true, match: false, why: '交卷清退没给 PR 号，拒绝停任何会话' };
  }
  const main = normCleanupPath(mainCheckout);
  if (main && n === main) {
    return { ok: true, match: false, why: '主树不得清退', refuseReason: 'main-tree' };
  }
  if (isReviewerTreePath(n)) {
    return { ok: true, match: false, why: '审官树不得清退工人会话', refuseReason: 'reviewer-tree' };
  }
  const tail = pathTail(n);
  const wantIssue = positiveInt(issue);
  if (wantIssue && (tail === `dao-${wantIssue}` || new RegExp(`^ISSUE-#?${wantIssue}(?:-|$)`, 'i').test(tail))) {
    return { ok: true, match: true, workerCwd: n };
  }
  const branch = String(headRefName || '').trim();
  if (branch) {
    const dir = branchDirName(branch);
    if (tail === branch || (dir && tail === dir)) return { ok: true, match: true, workerCwd: n };
  }
  if (new RegExp(`(?:^|[._-])PR-#?${wantPr}(?:-|$)`, 'i').test(tail) && !/审官|reviewer/i.test(tail)) {
    return { ok: true, match: true, workerCwd: n };
  }
  return { ok: true, match: false, why: '当前目录不是本 PR 的工人树', refuseReason: 'wrong-tree' };
}

export function sessionLooksReviewer(s) {
  if (isReviewerTreePath(sessionCwdOf(s))) return true;
  const title = String((s && (s.title || s.label)) || '');
  if (/审官|reviewer/i.test(title)) return true;
  const role = String((s && (s.role || s.kind || s.identity)) || '');
  if (/审官|reviewer/i.test(role)) return true;
  return false;
}

export function sessionIsThisPrWorker(s, { pr, issue, workerCwd } = {}) {
  if (!s) return false;
  const cwd = sessionCwdOf(s);
  if (!cwd || cwd !== normCleanupPath(workerCwd)) return false;
  if (sessionLooksReviewer(s)) return false;
  const wantPr = positiveInt(pr);
  const wantIssue = positiveInt(issue);
  const explicitPr = positiveInt(s.pr ?? s.pr_number);
  const explicitIssue = positiveInt(s.issue ?? s.issue_number);
  if (explicitPr && wantPr && explicitPr !== wantPr) return false;
  if (explicitIssue && wantIssue && explicitIssue !== wantIssue) return false;
  if (s.cleanupVerified === true) return false;
  const state = String(s.state || s.phase || s.runState || '').trim();
  if (TERMINAL_STATES.has(state)) return false;
  const key = s.sessionKey || s.key || s.id;
  if (!key) return false;
  return true;
}

export function planWorkerDoneStops({
  cwd, pr, issue, headRefName, mainCheckout, sessions, listedOk,
} = {}) {
  const scope = judgeWorkerDoneCleanupScope({ cwd, pr, issue, headRefName, mainCheckout });
  if (!scope.ok) {
    return { ok: false, unscanned: true, refuse: true, hits: [], why: scope.why, scope };
  }
  if (!scope.match) {
    return { ok: true, refuse: true, hits: [], why: scope.why, scope, stopCount: 0 };
  }
  if (listedOk === false) {
    return { ok: false, unscanned: true, refuse: false, hits: [], why: '会话清单没查成', scope };
  }
  if (!Array.isArray(sessions)) {
    return { ok: false, unscanned: true, refuse: false, hits: [], why: '会话清单不是数组（没查成）', scope };
  }
  const hits = sessions.filter((s) => sessionIsThisPrWorker(s, { pr, issue, workerCwd: scope.workerCwd }));
  return { ok: true, refuse: false, hits, why: '只停本 PR 工人会话', scope };
}

export async function applyWorkerDoneStops(plan, { stopOne } = {}) {
  const empty = { stopped: [], scanned: 0, stopCount: 0 };
  if (!plan || plan.ok !== true) {
    return {
      ok: false,
      unscanned: plan?.unscanned === true,
      error: (plan && plan.why) || '清退计划没查成',
      refused: plan?.refuse === true,
      ...empty,
    };
  }
  if (plan.refuse) {
    return {
      ok: true, refused: true, why: plan.why,
      refuseReason: plan.scope && plan.scope.refuseReason,
      ...empty,
    };
  }
  if (typeof stopOne !== 'function') {
    return { ok: false, unscanned: true, error: '清退没有 stop 执行器', ...empty };
  }
  const stopped = [];
  for (const s of plan.hits) {
    const key = s.sessionKey || s.key || s.id;
    if (!key) continue;
    const workdir = sessionCwdOf(s);
    try {
      const r = await stopOne(key, workdir);
      stopped.push({ sessionKey: key, ok: !!(r && r.ok), why: r && (r.why || r.error) });
    } catch (e) {
      stopped.push({ sessionKey: key, ok: false, why: String(e && e.message ? e.message : e) });
    }
  }
  const failed = stopped.filter((x) => x.ok !== true);
  if (failed.length) {
    return {
      ok: false, partial: true,
      error: `有 ${failed.length} 个会话没停成`,
      stopped, scanned: plan.hits.length, stopCount: stopped.length,
    };
  }
  return { ok: true, stopped, scanned: plan.hits.length, stopCount: stopped.length };
}

/**
 * 交卷清退 IO。cwd 不是本 PR 工人树时不 list、不 stop。
 * 生产传入 stopOne=stopSessionAndReap；测试传入假 stopOne，禁止走真 reap。
 */
export async function stopWorkerDoneSessions(runtime, cwd, identity = {}, hooks = {}) {
  const empty = { stopped: [], scanned: 0, stopCount: 0 };
  const scope = judgeWorkerDoneCleanupScope({ cwd, ...identity });
  if (!scope.ok) {
    return { ok: false, unscanned: true, error: scope.why, refused: true, ...empty };
  }
  if (!scope.match) {
    return {
      ok: true, refused: true, why: scope.why, refuseReason: scope.refuseReason, ...empty,
    };
  }

  const list = typeof hooks.listSessions === 'function'
    ? hooks.listSessions
    : (runtime && typeof runtime.listSessions === 'function'
      ? runtime.listSessions.bind(runtime)
      : null);
  if (typeof list !== 'function') {
    return { ok: false, unscanned: true, error: 'runtime 没有 listSessions', ...empty };
  }
  let listed;
  try { listed = await list(); }
  catch (e) {
    return {
      ok: false, unscanned: true,
      error: `会话清单没查成：${String(e && e.message ? e.message : e)}`,
      ...empty,
    };
  }
  if (!listed || listed.ok === false) {
    return {
      ok: false, unscanned: true,
      error: (listed && (listed.error || listed.why)) || '会话清单没查成',
      ...empty,
    };
  }
  const sessions = Array.isArray(listed.sessions) ? listed.sessions : null;
  const plan = planWorkerDoneStops({
    cwd, ...identity, sessions, listedOk: sessions != null,
  });
  const stopOne = typeof hooks.stopOne === 'function'
    ? hooks.stopOne
    : async (key, workdir) => {
      if (!runtime || typeof runtime.stopSession !== 'function') {
        return { ok: false, why: 'runtime 没有 stopSession' };
      }
      return runtime.stopSession(key, { workdir });
    };
  return applyWorkerDoneStops(plan, { stopOne });
}

/** 收尾失败时给 CLI 的细分回执。评论/入队已经发生的事实必须还在。 */
export function workerDoneCleanupFailExtra(stopped, receipts = {}) {
  return {
    commentPosted: true,
    cleanup: 'failed',
    stopped: stopped || null,
    postedIssue: receipts.postedIssue ?? null,
    postedPr: receipts.postedPr ?? null,
    action: receipts.action ?? null,
    reviewPending: receipts.reviewPending ?? null,
  };
}
