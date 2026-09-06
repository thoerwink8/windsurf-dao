// scripts/lib/session-reconcile.mjs —— 对账循环纯函数（#1056）
//
// 点名册（job.dispatch）早就有，从来没人点名。每个消费者各自拿 draft / 登记文件 /
// resultPath 猜「有没有活执行者」，六种猜法六种失效。本文件是**唯一**活性判据：
//
//   期望集 = 事件账里未结的 job.dispatch（不新造台账）
//   观测集 = 会话名单里真实还在、且不是终态的那些
//   差集   = 该在却不在 → 直接重派（幂等键 = issue 号）
//
// 硬边界（今天已经实咬过，#1007/#1037 各积 3 个工人抢一棵树）：
//   「查不成」一律当作有人在做，只报不派。
//   不许拿 draft / 登记文件 / resultPath 当活性。
//   同一 issue 已有活执行者 ⇒ 拒绝再派。

import { unclosedJobIds } from './ledger-query.mjs';

/** 驱动自报的终态：人已经走了，名单里留着也不算活执行者。 */
const DEAD_STATES = new Set([
  'completed', 'complete', 'done', 'finished',
  'failed', 'error', 'aborted', 'cancelled', 'canceled',
]);

function positiveInt(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function cardNameOf(e) {
  return String((e && (e.card_name || e.cardName)) || '');
}

/** 未结派工的署名 issue：字段优先，卡名 ISSUE-#N 兜底。读不出就没法当幂等键。 */
export function issueOfDispatch(e) {
  const n = positiveInt(e && (e.issue_number ?? e.issue));
  if (n) return n;
  const m = cardNameOf(e).match(/ISSUE-#?(\d+)/i);
  return m ? Number(m[1]) : null;
}

/** 未结派工的 PR：字段优先，job_id gh-pr-N(-review) / 卡名 PR-#N 兜底。 */
export function prOfDispatch(e) {
  const n = positiveInt(e && e.pr_number);
  if (n) return n;
  const id = String((e && e.job_id) || '');
  const jm = id.match(/^gh-pr-(\d+)(?:-review)?$/);
  if (jm) return Number(jm[1]);
  const cm = cardNameOf(e).match(/PR-#?(\d+)/i);
  return cm ? Number(cm[1]) : null;
}

/**
 * 期望集：事件账里未结的 job.dispatch。
 * events 不是数组 → unscanned（没查成 ≠ 0 条）。
 */
export function desiredFromEvents(events) {
  if (!Array.isArray(events)) {
    return { unscanned: true, error: '没给事件数组（期望集没查成）', items: [] };
  }
  const open = new Set(unclosedJobIds(events));
  const items = [];
  const seen = new Set();
  for (const e of events) {
    if (!e || e.type !== 'job.dispatch' || !e.job_id) continue;
    if (!open.has(e.job_id) || seen.has(e.job_id)) continue;
    seen.add(e.job_id);
    items.push({
      job_id: e.job_id,
      identity: e.identity || null,
      issue: issueOfDispatch(e),
      pr: prOfDispatch(e),
      card_name: cardNameOf(e) || null,
      terminal: e.terminal || null,
      dispatch_id: e.dispatch_id || null,
      ts: e.ts || null,
      model: e.model || null,
    });
  }
  return { unscanned: false, items };
}

/**
 * 单条会话在不在。判据是「名单里有、且不是终态」——存在与否，不是静默多久。
 * 对象/key 没有 → unscanned，绝不当活着，也绝不当死（交给调用方按议题方向倒）。
 */
export function isLiveSession(s) {
  if (!s || typeof s !== 'object') {
    return { live: false, unscanned: true, why: '没给会话对象——没查成' };
  }
  const key = s.key || s.id;
  if (!key) {
    return { live: false, unscanned: true, why: '会话没有 key——没查成' };
  }
  const raw = String(s.state || s.runState || '').toLowerCase();
  if (DEAD_STATES.has(raw)) {
    return { live: false, unscanned: false, why: `终态 ${raw}` };
  }
  return { live: true, unscanned: false, why: raw ? `态 ${raw}` : '在名单里' };
}

/**
 * 一条会话在盯哪个 issue / 哪张 PR。只从 title / cwd 读结构化痕迹，
 * 不读 draft、不读登记文件、不读 resultPath。
 */
export function sessionSubjects(s) {
  const issues = new Set();
  const prs = new Set();
  const title = String((s && (s.title || s.label)) || '');
  const cwd = String((s && (s.cwd || s.workdir || s.worktreeId)) || '').replace(/\\/g, '/');
  for (const m of title.matchAll(/ISSUE-#?(\d+)/gi)) issues.add(Number(m[1]));
  for (const m of title.matchAll(/issue\s*#(\d+)/gi)) issues.add(Number(m[1]));
  for (const m of title.matchAll(/\bPR\s*#(\d+)/gi)) prs.add(Number(m[1]));
  for (const m of title.matchAll(/\bPR-#?(\d+)/gi)) prs.add(Number(m[1]));
  const base = cwd.split('/').filter(Boolean).pop() || '';
  const rev = base.match(/^dao-review-pr-(\d+)/i);
  if (rev) prs.add(Number(rev[1]));
  else {
    const iss = base.match(/^dao-(\d+)/i);
    if (iss) issues.add(Number(iss[1]));
  }
  return { issues, prs };
}

function sessionMatchesDispatch(s, d) {
  const key = String((s && (s.key || s.id)) || '');
  if (d.dispatch_id && key && key === String(d.dispatch_id)) return true;
  if (d.job_id && key && d.job_id === `dispatch-${key}`) return true;
  const subj = sessionSubjects(s);
  if (d.issue && subj.issues.has(d.issue)) return true;
  if (d.pr && subj.prs.has(d.pr)) return true;
  return false;
}

/**
 * 这张单 / 这张 PR 现在有没有活执行者。活性判据只许走这里。
 *
 *   sessions === undefined → 观测面未接入（老夹具 / 未接线），live:false 且 unavailable
 *   sessions 不是数组     → 没查成，当作有人在做（live:true, unscanned）
 *   命中的那条会话自己没查成 → 当作有人在做
 *   命中且活着             → live:true
 *   扫完没有命中的活会话   → live:false
 */
export function hasLiveExecutor({ sessions, issue, pr } = {}) {
  if (sessions === undefined) {
    return { live: false, unscanned: false, unavailable: true, why: '观测面未接入' };
  }
  if (!Array.isArray(sessions)) {
    return { live: true, unscanned: true, why: '会话名单没查成，当作有人在做' };
  }
  const wantIssue = positiveInt(issue);
  const wantPr = positiveInt(pr);
  for (const s of sessions) {
    if (!s) continue;
    const subj = sessionSubjects(s);
    const matches = (wantIssue && subj.issues.has(wantIssue))
      || (wantPr && subj.prs.has(wantPr));
    if (!matches) continue;
    const a = isLiveSession(s);
    if (a.unscanned) {
      return { live: true, unscanned: true, why: a.why, session: s };
    }
    if (a.live) return { live: true, unscanned: false, session: s, why: a.why };
  }
  return { live: false, unscanned: false, why: '名单里没有这条的活会话' };
}

/** 态势上的 sessions 节 → hasLiveExecutor 要的 sessions 入参。 */
export function sessionListForLiveness(situation) {
  const sec = situation && situation.sessions;
  if (sec == null) return undefined;
  if (sec.scanned !== true) return null;
  return Array.isArray(sec.items) ? sec.items : null;
}

function asNumberSet(v) {
  if (v instanceof Set) return v;
  if (!Array.isArray(v)) return null;
  return new Set(v.map(Number).filter((n) => Number.isInteger(n) && n > 0));
}

/**
 * 审官静默要不要重起（#1043 现场 B）。
 * 目标 PR 已不在开放名单 = 干完了，不报警不重起。
 * 读不出 PR / 开放名单没查成 = 按现场 B 可以报警（漏报一次比给已合并 PR 重起审官便宜）。
 */
export function shouldRestartReviewer(session, { openPrs } = {}) {
  const { prs } = sessionSubjects(session);
  if (prs.size === 0) {
    return { restart: true, unscanned: true, why: '标题/路径里读不出 PR 号——查不成，按现场 B 可以报警' };
  }
  const open = asNumberSet(openPrs);
  if (!open) {
    return { restart: true, unscanned: true, why: '开放 PR 名单没查成——按现场 B 可以报警' };
  }
  for (const n of prs) {
    if (open.has(n)) return { restart: true, unscanned: false, pr: n };
  }
  return { restart: false, unscanned: false, why: '目标 PR 已不在开放名单（已合并/关闭）——完工，不重起' };
}

/**
 * 差集：该在却不在的工人 → 重派。幂等键 = issue 号。
 * 审官不在这里重派（复审票 / drain 已经管「当前 head 缺判定」；已合并 PR 重起是现场 B 的病）。
 *
 * desired / sessions / openIssues 任一不是数组 → unscanned，零重派。
 */
export function planReconcile({
  desired,
  sessions,
  openIssues,
  alreadyQueued,
  maxPerRound = 2,
  dispatchedThisRound = 0,
} = {}) {
  if (!Array.isArray(desired)) {
    return {
      unscanned: true,
      redispatches: [],
      reports: ['期望集没查成（事件账未结 dispatch 读不到）——当有人在做，不重派'],
    };
  }
  if (!Array.isArray(sessions)) {
    return {
      unscanned: true,
      redispatches: [],
      reports: ['观测集没查成（会话名单读不到）——当有人在做，不重派'],
    };
  }
  const open = asNumberSet(openIssues);
  if (!open) {
    return {
      unscanned: true,
      redispatches: [],
      reports: ['开放 issue 名单没查成——不知道单还开不开，不重派'],
    };
  }

  const queued = asNumberSet(alreadyQueued) || new Set();
  const byIssue = new Map();
  const reports = [];
  for (const d of desired) {
    if (!d) continue;
    if (d.identity === '审官') continue;
    if (d.issue == null) {
      reports.push(`未结 ${d.job_id} 读不出 issue 号，无法当幂等键重派`);
      continue;
    }
    byIssue.set(d.issue, d);
  }

  const redispatches = [];
  let used = Number(dispatchedThisRound) || 0;
  const cap = Number.isInteger(maxPerRound) && maxPerRound > 0 ? maxPerRound : 2;
  for (const [issue, d] of byIssue) {
    if (!open.has(issue)) continue; // 单已关：不是漏救，是完工
    if (queued.has(issue)) continue; // 本轮已经要派，不造第二份
    const live = hasLiveExecutor({ sessions, issue, pr: d.pr });
    if (live.unscanned) {
      reports.push(`#${issue} 活会话没查成——当有人在做，不重派`);
      continue;
    }
    if (live.live) continue;
    if (used >= cap) continue; // 排队下轮，不丢、不 escalate
    used += 1;
    redispatches.push({
      issue,
      job_id: d.job_id,
      model: d.model || null,
      why: `#${issue} 账上有未结派工 ${d.job_id}，名单里没有活会话——差集重派`,
    });
  }
  return { unscanned: false, redispatches, reports };
}
