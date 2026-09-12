// scripts/lib/ephemeral-reap.mjs —— 短命执行体的清树判据（#1174 2026-09-12 拍板）
//
// 改这段前必须知道：
//   1. 进程贵、树便宜。交卷后工人树要留着给审查/返工/冲突；审官树在判定落 GitHub 后立刻可删。
//   2. 删树不可逆。任何一格没查成（会话名单 / PR 态 / issue 态 / 列表窗口截断）⇒ 不删。
//      「不在开放列表里」只有在窗口未截断时才是「已关」的证据，与指挥官回收死票同一把尺。
//   3. decide 是纯函数：这里只产候选。exec 必须再核一次 GitHub 状态，查不成仍不删。
//   4. 通用 worktree-rm 仍禁止出现在 decide 输出里；本文件只产 kind:'reap-tree'。

import { basename } from 'node:path';
import { identifyTreeDir } from './mirasim-trees.mjs';
import { isLiveSession } from './session-reconcile.mjs';
import { analyzeGithubReviews } from './review-state.mjs';
import { attributedIssueNumber } from './close-issue.mjs';

export const PR_LIST_WINDOW = 100;

function normPath(p) {
  return String(p || '').replace(/\\/g, '/').replace(/\/+$/, '');
}

function identityOf(tree) {
  if (!tree || typeof tree !== 'object') return null;
  if (tree.kind === '审官' && Number.isInteger(tree.pr) && tree.pr > 0) {
    return { kind: '审官', number: tree.pr, name: tree.displayName || basename(tree.path || '') };
  }
  if (tree.kind === '工人' && Number.isInteger(tree.linkedIssue) && tree.linkedIssue > 0) {
    return { kind: '工人', number: tree.linkedIssue, name: tree.displayName || basename(tree.path || '') };
  }
  const fromDir = identifyTreeDir(basename(tree.path || tree.worktreeId || ''));
  if (fromDir) return fromDir;
  return identifyTreeDir(String(tree.displayName || '').replace(/^PR-#/, 'dao-review-pr-').replace(/^ISSUE-#/, 'dao-'));
}

/** 这棵树现在有没有活会话。名单不是数组 = 没查成，当作有人在做。 */
export function treeLive(tree, sessions) {
  if (sessions === undefined) {
    return { live: false, unscanned: false, unavailable: true, why: '观测面未接入' };
  }
  if (!Array.isArray(sessions)) {
    return { live: true, unscanned: true, why: '会话名单没查成，当作有人在做' };
  }
  const want = normPath(tree && tree.path);
  if (!want) return { live: true, unscanned: true, why: '树路径没查成，当作有人在做' };
  for (const s of sessions) {
    if (!s) continue;
    const cwd = normPath(s.cwd || s.workdir || s.worktree || s.worktreeId);
    if (!cwd || (cwd !== want && !cwd.startsWith(`${want}/`))) continue;
    const a = isLiveSession(s);
    if (a.unscanned) return { live: true, unscanned: true, why: a.why, session: s };
    if (a.live) return { live: true, unscanned: false, session: s, why: a.why };
  }
  return { live: false, unscanned: false, why: '这棵树上没有活会话' };
}

function reviewsOf(reviewsByPr, pr) {
  const row = reviewsByPr && typeof reviewsByPr === 'object' ? reviewsByPr[pr] : null;
  if (row == null) return null;
  if (Array.isArray(row)) return row;
  if (Array.isArray(row.reviews)) return row.reviews;
  return null;
}

function judgedAtHead(reviewsByPr, pr, head) {
  const list = reviewsOf(reviewsByPr, pr);
  if (!Array.isArray(list)) return { scanned: false };
  const atHead = head
    ? list.filter((r) => !r || !r.commit_id || String(r.commit_id) === String(head))
    : list;
  return analyzeGithubReviews(atHead);
}

/**
 * 开放列表够不够当「不在列表里 = 已关」的证据。
 * 取满窗口就说明可能被截断，掉出窗口的活 PR/单会长得和已关一模一样。
 */
export function openListComplete(github) {
  if (!github || github.scanned !== true) {
    return { ok: false, why: 'GitHub 盘面没查成' };
  }
  const issues = Array.isArray(github.issues) ? github.issues : null;
  const prs = Array.isArray(github.prs) ? github.prs : null;
  if (!issues || !prs) return { ok: false, why: '开放列表不是数组（没查成）' };
  if (issues.length >= PR_LIST_WINDOW) return { ok: false, why: `开放 issue 取满 ${PR_LIST_WINDOW}，窗口可能被截断` };
  if (prs.length >= PR_LIST_WINDOW) return { ok: false, why: `开放 PR 取满 ${PR_LIST_WINDOW}，窗口可能被截断` };
  return { ok: true, issues, prs };
}



/**
 * 产清树候选。调用方把结果 append 到动作清单末尾（merge 之后），exec 再核一次。
 *
 * @param {{
 *   trees: Array,
 *   sessions: Array|null|undefined,
 *   github: object,
 *   reviewsByPr?: object,
 *   mergedPrs?: number[],
 * }} input
 */
export function planTreeReaps({
  trees, sessions, github, reviewsByPr, mergedPrs = [],
} = {}) {
  if (!Array.isArray(trees)) {
    return { ok: false, unscanned: true, items: [], skipped: [], error: '树面没查成，一张都不清' };
  }
  if (sessions === undefined) {
    return { ok: true, items: [], skipped: [{ why: '观测面未接入，本轮不清树' }] };
  }
  if (!Array.isArray(sessions)) {
    return { ok: true, items: [], skipped: [{ why: '会话名单没查成，本轮不清树（fail-closed）' }] };
  }

  const merged = new Set((Array.isArray(mergedPrs) ? mergedPrs : []).map(Number).filter((n) => Number.isInteger(n) && n > 0));
  const list = openListComplete(github);
  const openIssues = new Set((list.ok ? list.issues : []).map((i) => Number(i && i.number)).filter(Number.isInteger));
  const openPrs = new Set((list.ok ? list.prs : []).map((p) => Number(p && p.number)).filter(Number.isInteger));
  const issueToOpenPr = new Map();
  if (list.ok) {
    for (const p of list.prs) {
      const n = attributedIssueNumber(p);
      if (Number.isInteger(n) && n > 0) issueToOpenPr.set(n, Number(p.number));
    }
  }

  const items = [];
  const skipped = [];
  for (const tree of trees) {
    if (!tree || !tree.path) {
      skipped.push({ why: '有树没路径，判不了' });
      continue;
    }
    const id = identityOf(tree);
    if (!id) {
      skipped.push({ path: tree.path, why: '认不出工人/审官树，不猜' });
      continue;
    }
    const live = treeLive(tree, sessions);
    if (live.unscanned) {
      skipped.push({ path: tree.path, why: live.why });
      continue;
    }
    if (live.live) {
      skipped.push({ path: tree.path, why: '树上还有活会话' });
      continue;
    }

    if (id.kind === '审官') {
      const pr = id.number;
      if (merged.has(pr)) {
        items.push({
          kind: 'reap-tree', role: 'reviewer', pr, issue: null, path: tree.path,
          why: `PR #${pr} 本轮合并，审官树无活会话`,
        });
        continue;
      }
      const head = (list.ok ? list.prs : []).find((p) => Number(p && p.number) === pr)?.headRefOid || null;
      const judged = judgedAtHead(reviewsByPr, pr, head);
      if (!judged.scanned) {
        if (list.ok && !openPrs.has(pr)) {
          items.push({
            kind: 'reap-tree', role: 'reviewer', pr, issue: null, path: tree.path,
            why: `PR #${pr} 不在未截断开放列表里，审官树无活会话——exec 须再核已关/已合`,
          });
          continue;
        }
        skipped.push({ path: tree.path, pr, why: `PR #${pr} 的 reviews 没查成，审官树不清` });
        continue;
      }
      if (judged.latestGreen === true || judged.latestRed === true || judged.green === true) {
        items.push({
          kind: 'reap-tree', role: 'reviewer', pr, issue: null, path: tree.path,
          why: `审官已给 PR #${pr} 当前 head 落判定，树无活会话`,
        });
        continue;
      }
      skipped.push({ path: tree.path, pr, why: `PR #${pr} 当前 head 还没有判定` });
      continue;
    }

    // 工人树
    const issue = id.number;
    const mergedHit = [...merged].find((pr) => {
      const p = (list.ok ? list.prs : []).find((x) => Number(x && x.number) === pr);
      return p ? attributedIssueNumber(p) === issue : false;
    });
    // 刚决定 merge 的 PR 还在开放列表里；用 mergedPrs 正面确认。
    if (mergedHit) {
      items.push({
        kind: 'reap-tree', role: 'worker', pr: mergedHit, issue, path: tree.path,
        why: `PR #${mergedHit} 本轮合并，工人树 #${issue} 无活会话`,
      });
      continue;
    }
    // 调用方把「刚合的 PR 号 → 署名单」直接传进来（PR 循环里已经有 attributedIssueNumber）。
    const mergedForIssue = (tree.mergedPr != null) ? Number(tree.mergedPr) : null;
    if (Number.isInteger(mergedForIssue) && merged.has(mergedForIssue)) {
      items.push({
        kind: 'reap-tree', role: 'worker', pr: mergedForIssue, issue, path: tree.path,
        why: `PR #${mergedForIssue} 本轮合并，工人树 #${issue} 无活会话`,
      });
      continue;
    }

    if (!list.ok) {
      skipped.push({ path: tree.path, issue, why: `历史孤儿不判：${list.why}` });
      continue;
    }
    if (openIssues.has(issue) || issueToOpenPr.has(issue)) {
      skipped.push({ path: tree.path, issue, why: `issue #${issue} 还开着或仍有开放 PR，工人树留着给返工` });
      continue;
    }
    items.push({
      kind: 'reap-tree', role: 'orphan', pr: null, issue, path: tree.path,
      why: `issue #${issue} 不在未截断的开放列表里，且无活会话——exec 须再核已关/已合`,
    });
  }
  return { ok: true, items, skipped };
}

/**
 * 把「本轮要合的 PR」标到工人树上，让 planTreeReaps 不用再从正文猜署名。
 * 猜不出来就不要标——exec 仍会核 GitHub。
 */
export function markTreesForMergedPrs(trees, mergedPairs) {
  if (!Array.isArray(trees) || !Array.isArray(mergedPairs)) return trees;
  const byIssue = new Map();
  for (const p of mergedPairs) {
    if (!p || !Number.isInteger(p.issue) || !Number.isInteger(p.pr)) continue;
    byIssue.set(p.issue, p.pr);
  }
  return trees.map((t) => {
    const id = identityOf(t);
    if (!id || id.kind !== '工人') return t;
    const pr = byIssue.get(id.number);
    return pr ? { ...t, mergedPr: pr } : t;
  });
}
