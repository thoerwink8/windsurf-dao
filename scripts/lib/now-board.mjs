// scripts/lib/now-board.mjs —— `dao now` 的判官与排版（纯函数，零 IO）
//
// 用户 2026-09-04 亲口要的（原话：想知道「一直没反应，就没卡住了还是什么情况」）。
// 三段形状是 #891 拍定的，播报面与看板将来同用同一份判据：
//   已落地 / 在途 / 待你拍
//
// 改这段前必须知道的三条：
//
//  1. 「没查成」和「没有」是两件事，而且**不许把没查成显示成一切正常**。
//     本仓反复实咬，2026-09-04 又栽一次：10 张 PR 的审官零审查被当成「审官坏了」，
//     实际是**从没起过**——两种处置完全相反（重起 vs 催审）。所以：
//       tri() 出三态；每段带自己的 unscanned 名单；section.state==='empty' 才准说「没有」。
//     empty（查成了确实没有）与 partial（查成的部分没有、但有源没查成）分开形。
//
//  2. 判定时间早于最后一次 push 的票是**过期票**。判据不用时间戳（updatedAt 会被评论
//     / label 顶起来，比不出「代码有没有再动」），用 review 的 commit oid 对 PR 的
//     headRefOid——GitHub 那条票明确记了它投在哪个提交上。commit oid 缺失 = 判不出
//     过期与否（staleUnknown），不许当「没过期」。
//
//  3. 取数与判定分开：本文件只吃入参。每一路数据都是一个信封
//     `{scanned:true, items:[…]}` 或 `{scanned:false, error:'…'}`，
//     任一路信封坏掉只让它自己那几行变成「没查成」，不许拖垮全局。
//     机器人「@我问现状」将来直接调 renderNow，不重写判据。

import { PENDING_LABEL } from './pending-disambiguation.mjs';
import { DISAMBIGUATED_LABEL } from './dispatch/card.mjs';

/** 「待拍板」标：飞书 triage 与帅位共用的那张（feishu-triage-core 的 GATE_ALLOWED 的对立面）。 */
export const AWAITING_CALL_LABEL = '待拍板';

/** 默认只回看这么多小时的「已落地」。 */
export const DEFAULT_WINDOW_HOURS = 6;
/** 默认一屏。超了折叠成计数 + 「用 --json 看全部」。 */
export const DEFAULT_MAX_LINES = 40;
/**
 * 结构下限 = 3 段 ×（标题 + 至少 1 条 + 折叠行 + 「没查成」行）。
 * maxLines 给得比这还小时按这个走——如实按下限排，不假装满足一个排不出来的数。
 * CLI 不给调行数的旗标（用户不会去敲它）；这个入口留给将来的机器人/看板。
 */
export const MIN_MAX_LINES = 12;

// ── 三态信封 ────────────────────────────────────────────────────────────────

/**
 * 一路数据的三态：
 *   unscanned —— 没查成（源没给、报错、或说查成了却没给数组）
 *   empty     —— 查过了，真的没有
 *   ok        —— 查过了，有货
 * 合并 unscanned 与 empty 是本仓的头号实咬，这个函数是那条判据的唯一落点。
 */
export function tri(src) {
  if (!src || typeof src !== 'object') {
    return { state: 'unscanned', why: '这一源根本没给（没查成）', items: [] };
  }
  if (src.scanned !== true) {
    return { state: 'unscanned', why: String(src.error || '没查成（源没说为什么）'), items: [] };
  }
  if (!Array.isArray(src.items)) {
    return {
      state: 'unscanned',
      why: String(src.error || '源说查成了却没给数组（契约不符，按没查成算）'),
      items: [],
    };
  }
  return { state: src.items.length ? 'ok' : 'empty', why: null, items: src.items };
}

/** 一段的态：主源没查成 → unscanned；有条目 → ok；没条目且有缺源 → partial；都没有 → empty。 */
export function sectionState({ primaryUnscanned, itemCount, gapCount }) {
  if (primaryUnscanned) return 'unscanned';
  if (itemCount > 0) return 'ok';
  if (gapCount > 0) return 'partial';
  return 'empty';
}

function pushGap(list, source, why) {
  if (!why) return list;
  if (list.some(g => g.source === source && g.why === why)) return list;
  list.push({ source, why: String(why) });
  return list;
}

// ── 判定票（过期票在这儿判） ─────────────────────────────────────────────────

const JUDGED = new Set(['APPROVED', 'CHANGES_REQUESTED']);

function normState(s) {
  const up = String(s || '').toUpperCase().replace(/\s+/g, '_');
  if (up === 'APPROVE') return 'APPROVED';
  if (up === 'REQUEST_CHANGES' || up === 'CHANGES_REQUEST') return 'CHANGES_REQUESTED';
  return up;
}

/**
 * 一张 PR 的判定。ballots 是 GitHub review 列表（{author,state,submittedAt,commitOid}）。
 *
 * 三态严格分开：
 *   unscanned  —— review 没查成（这张 PR 的判定状态未知，不许当「无审查」）
 *   none       —— 查成了，一张判别票都没有（**从没审过**，不是审官坏了）
 *   APPROVED / CHANGES_REQUESTED —— 最后一张判别票的态
 * stale：最后那张判别票投在哪个 commit 上 ≠ 现在的 head → 过期票（返工已推 / 绿票已旧）。
 * commit oid 读不到 → staleUnknown，不许当「没过期」。
 */
export function judgeBallots({ reviews, headRefOid } = {}) {
  const t = tri(reviews);
  if (t.state === 'unscanned') {
    return { state: 'unscanned', why: t.why, judged: [], stale: false, staleUnknown: false, latest: null };
  }
  const judged = t.items
    .map(r => ({
      author: r && r.author ? String(r.author) : '?',
      state: normState(r && r.state),
      submittedAt: r && r.submittedAt ? String(r.submittedAt) : null,
      commitOid: r && r.commitOid ? String(r.commitOid) : null,
    }))
    .filter(r => JUDGED.has(r.state));
  if (judged.length === 0) {
    return { state: 'none', why: null, judged: [], stale: false, staleUnknown: false, latest: null };
  }
  // 最后一张判别票：按提交时间排；时间缺失的按原顺序垫底（GitHub 回的本来就是时间序）。
  const sorted = judged.slice().sort((a, b) => {
    const ta = a.submittedAt ? Date.parse(a.submittedAt) : NaN;
    const tb = b.submittedAt ? Date.parse(b.submittedAt) : NaN;
    if (Number.isNaN(ta) && Number.isNaN(tb)) return 0;
    if (Number.isNaN(ta)) return -1;
    if (Number.isNaN(tb)) return 1;
    return ta - tb;
  });
  const latest = sorted[sorted.length - 1];
  const head = headRefOid ? String(headRefOid) : null;
  let stale = false;
  let staleUnknown = false;
  if (!head || !latest.commitOid) staleUnknown = true;
  else stale = latest.commitOid !== head;
  const staleCount = head ? judged.filter(b => b.commitOid && b.commitOid !== head).length : 0;
  return { state: latest.state, why: null, judged, latest, stale, staleUnknown, staleCount };
}

// ── 审官登记 / 会话 / 树 ────────────────────────────────────────────────────

/**
 * 审官登记（`_flow/mirasim/reviewer-<PR>.json`）。
 *
 * ⚠️ 落点实测跟着**执行命令那棵树**跑（/home/orca/wt-unblock/_flow/mirasim/…），换棵树就找不到。
 * 所以「扫遍已知候选目录仍没有」**只能记没查成**，不许当「这张 PR 没有审官」——
 * 落点本身不可靠时，「没找到」不构成「不存在」的证据。改落点是 #880 卡 C 的范围，不在本动词。
 */
export function pickRegistry({ registries, pr } = {}) {
  const t = tri(registries);
  if (t.state === 'unscanned') {
    return { found: false, unscanned: true, why: `审官登记没查成：${t.why}`, item: null };
  }
  const hits = t.items.filter(r => r && String(r.pr) === String(pr));
  if (hits.length === 0) {
    const dirs = Array.isArray(registries.dirsScanned) ? registries.dirsScanned.length : 0;
    return {
      found: false,
      unscanned: true,
      why: `扫了 ${dirs} 个候选目录都没有 reviewer-${pr}.json——登记落点跟着执行树跑，找不到只能算没查成`,
      item: null,
    };
  }
  // 同一 PR 多份登记（换轮重起会各写一份）：取 ts 最大的那份。
  const item = hits.slice().sort((a, b) => (Number(a.ts) || 0) - (Number(b.ts) || 0)).pop();
  return { found: true, unscanned: false, why: null, item };
}

/** 审官树上有没有活着的执行体进程。判据是进程 cwd == 登记的 treePath（实测可精确归因）。 */
export function judgeSession({ sessions, treePath } = {}) {
  const t = tri(sessions);
  if (t.state === 'unscanned') return { state: 'unscanned', why: `审官会话没查成：${t.why}`, count: 0 };
  if (!treePath) return { state: 'unscanned', why: '没有审官树路径，会话对不上号（没查成）', count: 0 };
  const want = normPath(treePath);
  const count = t.items.filter(s => s && normPath(s.cwd) === want).length;
  if (count > 0) return { state: 'live', why: null, count };
  return { state: 'gone', why: '这棵审官树上没有活着的执行体进程', count: 0 };
}

function normPath(p) {
  return String(p || '').replace(/\\/g, '/').replace(/\/+$/, '');
}

/** 审官树 head 对不对得上 PR head。树 head 读不到 = 没查成，不许当「一致」。 */
export function judgeTreeHead({ treeHead, headRefOid } = {}) {
  const t = treeHead && typeof treeHead === 'object' ? treeHead : null;
  if (!t || t.scanned !== true || !t.oid) {
    return { state: 'unscanned', why: `审官树 head 没查成：${(t && t.error) || '没读到'}`, oid: null };
  }
  if (!headRefOid) return { state: 'unscanned', why: 'PR head 没读到，对不了（没查成）', oid: String(t.oid) };
  return String(t.oid) === String(headRefOid)
    ? { state: 'same', why: null, oid: String(t.oid) }
    : { state: 'behind', why: `审官树停在 ${short(t.oid)}，PR head 已经是 ${short(headRefOid)}`, oid: String(t.oid) };
}

export function short(oid) {
  return String(oid || '').slice(0, 7) || '?';
}

/** 本机在跑的工人：按分支名对 worktree。 */
export function judgeWorker({ worktrees, headRefName } = {}) {
  const t = tri(worktrees);
  if (t.state === 'unscanned') return { state: 'unscanned', why: `本机工人树没查成：${t.why}`, paths: [] };
  if (!headRefName) return { state: 'unscanned', why: 'PR 分支名没读到，对不上工人树（没查成）', paths: [] };
  const paths = t.items.filter(w => w && String(w.branch) === String(headRefName)).map(w => String(w.path));
  return paths.length ? { state: 'live', why: null, paths } : { state: 'none', why: null, paths: [] };
}

// ── 一张 open PR 的整行判定 ─────────────────────────────────────────────────

/**
 * 一张 PR → 一行现状 + 它要不要你拍。
 * needs 里的每一条都会进「待你拍」，每条都带 why（说人话，用户能照着做决定）。
 */
export function assessPr({ pr, reviews, registries, sessions, worktrees } = {}) {
  const number = pr && pr.number != null ? String(pr.number) : '?';
  const verdict = judgeBallots({ reviews, headRefOid: pr && pr.headRefOid });
  const reg = pickRegistry({ registries, pr: number });
  const treePath = reg.found ? reg.item.treePath : null;
  const session = judgeSession({ sessions, treePath });
  const tree = judgeTreeHead({
    treeHead: reg.found ? reg.item.treeHead : null,
    headRefOid: pr && pr.headRefOid,
  });
  const worker = judgeWorker({ worktrees, headRefName: pr && pr.headRefName });
  const mergeable = pr && pr.mergeable ? String(pr.mergeable).toUpperCase() : null;

  const needs = [];
  if (verdict.state === 'CHANGES_REQUESTED' && verdict.stale) {
    needs.push({
      kind: 'rework-awaiting-recheck',
      why: `#${number} 被判红后又推了新代码（红票投在 ${short(verdict.latest.commitOid)}，head 已是 ${short(pr.headRefOid)}）——返工完了没人复审`,
    });
  }
  if (verdict.state === 'APPROVED' && verdict.stale) {
    needs.push({
      kind: 'stale-green',
      why: `#${number} 的绿票投在旧代码 ${short(verdict.latest.commitOid)} 上，之后又推过——这张绿不作数，要重审`,
    });
  }
  if (verdict.state === 'APPROVED' && !verdict.stale && !verdict.staleUnknown && !(pr && pr.isDraft)) {
    needs.push({ kind: 'green-awaiting-land', why: `#${number} 已绿且是当前代码——要不要合` });
  }
  if (verdict.state === 'none' && (reg.unscanned || session.state !== 'live')) {
    // 用户这次撞到的正是这一格：零审查 + 审官会话不在/查不到。
    // 「审官从没起过」和「审官起了又没了」处置不同，所以 why 里必须把哪一半没查成说出来。
    const half = reg.unscanned
      ? '审官到底起没起都没查成（登记找不到）'
      : (session.state === 'unscanned' ? '审官登记在、会话在不在没查成' : '审官登记在、但树上没有活着的进程');
    needs.push({
      kind: reg.unscanned ? 'reviewer-unknown' : (session.state === 'unscanned' ? 'reviewer-session-unknown' : 'reviewer-down'),
      why: `#${number} 一张票都没有，${half}——要你拍是重起审官、换人，还是先不审`,
    });
  }
  if (tree.state === 'behind') {
    needs.push({ kind: 'reviewer-tree-behind', why: `#${number} 的审官在审旧代码：${tree.why}` });
  }
  if (mergeable === 'CONFLICTING') {
    needs.push({ kind: 'conflicting', why: `#${number} 跟 master 冲突了，合不上——要先解冲突` });
  }

  return {
    pr: number,
    title: pr && pr.title ? String(pr.title) : '',
    draft: !!(pr && pr.isDraft),
    updatedAt: pr && pr.updatedAt ? String(pr.updatedAt) : null,
    headRefName: pr && pr.headRefName ? String(pr.headRefName) : null,
    headRefOid: pr && pr.headRefOid ? String(pr.headRefOid) : null,
    verdict,
    reviewer: reg.found
      ? { found: true, unscanned: false, agent: reg.item.agent || null, round: reg.item.round || null, treePath, sessionKey: reg.item.sessionKey || null, expectedOid: reg.item.expectedOid || null }
      : { found: false, unscanned: true, why: reg.why, agent: null, round: null, treePath: null, sessionKey: null, expectedOid: null },
    session,
    tree,
    worker,
    mergeable,
    needs,
  };
}

// ── open issue 的判定 ───────────────────────────────────────────────────────

function labelNames(labels) {
  if (!Array.isArray(labels)) return null; // null = 没查成（不是「没有标签」）
  return labels.map(l => (typeof l === 'string' ? l : (l && l.name) || '')).filter(Boolean);
}

/**
 * 一张 open issue 要不要你拍。
 *   待拍板     → 明摆着等你拍
 *   待消歧     → 等你拍怎么消歧（#876 的拦与浮：它落了盘也不许被派）
 *   缺「已消歧」→ 派不出去（消歧门 fail-close），要你先消歧
 *   有「已消歧」→ 不用你拍，可以派
 * labels 不是数组 = 没查成，绝不当「没有标签」（那会把它错判成「缺已消歧」）。
 */
export function assessIssue({ number, title, labels } = {}) {
  const names = labelNames(labels);
  const base = { issue: String(number ?? '?'), title: String(title || '') };
  if (names == null) {
    return { ...base, kind: 'issue-labels-unscanned', unscanned: true, why: `#${base.issue} 的 label 没查成——判不出它等不等你拍` };
  }
  if (names.includes(AWAITING_CALL_LABEL)) {
    return { ...base, kind: 'issue-awaiting-call', unscanned: false, why: `#${base.issue} 挂着「${AWAITING_CALL_LABEL}」——等你拍` };
  }
  if (names.includes(PENDING_LABEL)) {
    return { ...base, kind: 'issue-pending-disambiguation', unscanned: false, why: `#${base.issue} 挂着「${PENDING_LABEL}」——在你拍怎么做之前不会被派出去` };
  }
  if (!names.includes(DISAMBIGUATED_LABEL)) {
    return { ...base, kind: 'issue-not-disambiguated', unscanned: false, why: `#${base.issue} 还没「${DISAMBIGUATED_LABEL}」——现在派不出去` };
  }
  return { ...base, kind: 'issue-ready', unscanned: false, why: null };
}

// ── 分支发散 ────────────────────────────────────────────────────────────────

/** 与远端两头都有独占提交 = 发散（要你拍：以谁为准）。track 读不到 = 没查成。 */
export function assessWorktree(w) {
  const path = String((w && w.path) || '');
  const branch = (w && w.branch) ? String(w.branch) : null;
  if (!w || typeof w !== 'object' || !path) return null;
  if (w.trackScanned === false) {
    return { kind: 'branch-track-unscanned', unscanned: true, path, branch, why: `${branch || path} 与远端的领先/落后没查成` };
  }
  const ahead = Number(w.ahead) || 0;
  const behind = Number(w.behind) || 0;
  if (ahead > 0 && behind > 0) {
    return { kind: 'branch-diverged', unscanned: false, path, branch, why: `${branch || path} 与远端发散了（本地多 ${ahead}、远端多 ${behind}）——要你拍以谁为准` };
  }
  return null;
}

// ── 主判官 ──────────────────────────────────────────────────────────────────

function withinWindow(ts, now, hours) {
  const t = Date.parse(String(ts || ''));
  if (Number.isNaN(t)) return false;
  const n = now instanceof Date ? now.getTime() : Date.parse(String(now));
  if (Number.isNaN(n)) return false;
  return n - t <= hours * 3600 * 1000 && t <= n + 5 * 60 * 1000;
}

/**
 * 现状盘面。取数在外面做，这里只判。
 * 入参每一路都是信封；merged 里再套两个子信封（合并的 PR / master 提交），一个坏不影响另一个。
 */
export function renderNow({
  prs, reviews, merged, issues, registries, worktrees, sessions,
  now, windowHours = DEFAULT_WINDOW_HOURS,
} = {}) {
  const at = now instanceof Date ? now : new Date(now || Date.now());

  // ── 已落地 ──
  const landedGaps = [];
  const mergedPrs = tri(merged && merged.prs);
  const mergedCommits = tri(merged && merged.commits);
  if (mergedPrs.state === 'unscanned') pushGap(landedGaps, '合并的 PR', mergedPrs.why);
  if (mergedCommits.state === 'unscanned') pushGap(landedGaps, 'master 提交', mergedCommits.why);
  const landedItems = [];
  const landedPrs = new Set();
  for (const p of mergedPrs.items) {
    if (!withinWindow(p && p.mergedAt, at, windowHours)) continue;
    landedPrs.add(String(p.number));
    landedItems.push({
      kind: 'merged-pr',
      pr: String(p.number),
      sha: p.mergeCommitOid ? short(p.mergeCommitOid) : null,
      at: String(p.mergedAt),
      text: String(p.title || ''),
    });
  }
  for (const c of mergedCommits.items) {
    if (!withinWindow(c && c.at, at, windowHours)) continue;
    // squash 合并的提交题目末尾带 (#N)：那张 PR 已经列过了，别把同一件事说两遍。
    const m = /\(#(\d+)\)\s*$/.exec(String((c && c.subject) || ''));
    if (m && landedPrs.has(m[1])) continue;
    landedItems.push({ kind: 'commit', sha: short(c.sha), at: String(c.at), text: String(c.subject || '') });
  }
  landedItems.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const landed = {
    state: sectionState({
      primaryUnscanned: mergedPrs.state === 'unscanned' && mergedCommits.state === 'unscanned',
      itemCount: landedItems.length,
      gapCount: landedGaps.length,
    }),
    items: landedItems,
    unscanned: landedGaps,
  };

  // ── 在途 ──
  const inflightGaps = [];
  const prT = tri(prs);
  if (prT.state === 'unscanned') pushGap(inflightGaps, 'open PR', prT.why);
  const regT = tri(registries);
  if (regT.state === 'unscanned') pushGap(inflightGaps, '审官登记', regT.why);
  const sessT = tri(sessions);
  if (sessT.state === 'unscanned') pushGap(inflightGaps, '审官会话', sessT.why);
  const wtT = tri(worktrees);
  if (wtT.state === 'unscanned') pushGap(inflightGaps, '本机工人树', wtT.why);

  const byPr = (reviews && typeof reviews === 'object' && reviews.byPr && typeof reviews.byPr === 'object')
    ? reviews.byPr
    : null;
  if (byPr == null) pushGap(inflightGaps, 'PR 判定', (reviews && reviews.error) || 'review 一张都没查（没查成）');

  const inflightItems = [];
  const decideItems = [];
  // 逐张 PR 的缺口按类型攒着一起报：一条「N 张的审官登记没查成」比 N 条重复的行有用，
  // 而且不会把「没查成」挤出屏幕（缺源永远看得见是硬要求）。
  const verdictMissing = [];
  const regMissing = [];
  for (const pr of prT.items) {
    const rv = byPr ? byPr[String(pr && pr.number)] : null;
    const row = assessPr({ pr, reviews: rv, registries, sessions, worktrees });
    inflightItems.push(row);
    if (row.verdict.state === 'unscanned') verdictMissing.push(row.pr);
    if (row.reviewer.unscanned) regMissing.push(row.pr);
    for (const n of row.needs) decideItems.push({ ...n, pr: row.pr, title: row.title });
  }
  if (verdictMissing.length) {
    pushGap(inflightGaps, `${verdictMissing.length} 张 PR 的判定`, `#${verdictMissing.join(' #')} 的 review 没查成——判定状态未知，不是「无审查」`);
  }
  if (regMissing.length) {
    pushGap(inflightGaps, `${regMissing.length} 张 PR 的审官登记`, `#${regMissing.join(' #')} 在候选目录里找不到 reviewer-<PR>.json——登记落点跟着执行树跑，找不到只能算没查成`);
  }
  inflightItems.sort((a, b) => Number(b.pr) - Number(a.pr));
  const inflight = {
    state: sectionState({
      primaryUnscanned: prT.state === 'unscanned',
      itemCount: inflightItems.length,
      gapCount: inflightGaps.length,
    }),
    items: inflightItems,
    unscanned: inflightGaps,
    counts: {
      open: inflightItems.length,
      draft: inflightItems.filter(r => r.draft).length,
      noReview: inflightItems.filter(r => r.verdict.state === 'none').length,
      red: inflightItems.filter(r => r.verdict.state === 'CHANGES_REQUESTED').length,
      green: inflightItems.filter(r => r.verdict.state === 'APPROVED').length,
      verdictUnscanned: inflightItems.filter(r => r.verdict.state === 'unscanned').length,
    },
  };

  // ── 待你拍 ──
  const decideGaps = inflightGaps.slice();
  const issT = tri(issues);
  if (issT.state === 'unscanned') pushGap(decideGaps, 'open issue', issT.why);
  for (const it of issT.items) {
    const v = assessIssue(it || {});
    if (v.kind === 'issue-ready') continue;
    if (v.kind === 'issue-labels-unscanned') { pushGap(decideGaps, `#${v.issue} 的 label`, v.why); continue; }
    decideItems.push({ kind: v.kind, why: v.why, issue: v.issue, title: v.title });
  }
  for (const w of wtT.items) {
    const v = assessWorktree(w);
    if (!v) continue;
    if (v.unscanned) { pushGap(decideGaps, `${v.branch || v.path} 的远端对比`, v.why); continue; }
    decideItems.push({ kind: v.kind, why: v.why, path: v.path, branch: v.branch });
  }
  const decide = {
    state: sectionState({
      // 待你拍没有单一主源：PR 与 issue 全没查成时这段才等于没查。
      primaryUnscanned: prT.state === 'unscanned' && issT.state === 'unscanned',
      itemCount: decideItems.length,
      gapCount: decideGaps.length,
    }),
    items: decideItems,
    unscanned: decideGaps,
  };

  const all = [];
  for (const g of [...landedGaps, ...inflightGaps, ...decideGaps]) pushGap(all, g.source, g.why);

  return { now: at.toISOString(), windowHours, landed, inflight, decide, unscanned: all };
}

// ── 排版（默认给人看；--json 给机器） ───────────────────────────────────────

const KIND_ORDER = [
  'conflicting', 'rework-awaiting-recheck', 'stale-green', 'reviewer-down',
  'reviewer-unknown', 'reviewer-session-unknown', 'reviewer-tree-behind',
  'issue-awaiting-call', 'issue-pending-disambiguation', 'branch-diverged',
  'green-awaiting-land', 'issue-not-disambiguated',
];
// KIND_ORDER 末尾那几类（量大、性质相同、看计数就够）自然先被折叠——排序即优先级，不另立名单。

// 折叠行里的说人话名字（用户自己会说的词，不是 kind 代号）。
const KIND_TEXT = {
  conflicting: '合不上（跟 master 冲突）',
  'rework-awaiting-recheck': '返工完了没人复审',
  'stale-green': '绿票投在旧代码上',
  'reviewer-down': '审官进程不在了',
  'reviewer-unknown': '审官起没起都没查成',
  'reviewer-session-unknown': '审官会话在不在没查成',
  'reviewer-tree-behind': '审官在审旧代码',
  'issue-awaiting-call': '挂着「待拍板」的单',
  'issue-pending-disambiguation': '挂着「待消歧」的单',
  'branch-diverged': '与远端发散的分支',
  'green-awaiting-land': '已绿等你合',
  'issue-not-disambiguated': '还没消歧、派不出去的单',
};

const VERDICT_TEXT = {
  unscanned: '判定没查成',
  none: '无审查',
  APPROVED: '已绿',
  CHANGES_REQUESTED: '已红',
};

function clip(s, n) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
}

/** 一张 PR 一行。每格都写清是「没查成」还是实况。 */
export function formatPrRow(row) {
  const bits = [];
  let v = VERDICT_TEXT[row.verdict.state] || row.verdict.state;
  if (row.verdict.stale) v += '(过期票)';
  else if (row.verdict.staleUnknown && row.verdict.state !== 'none' && row.verdict.state !== 'unscanned') v += '(过期没查成)';
  bits.push(v);
  if (row.reviewer.unscanned) bits.push('审官没查成');
  else bits.push(`审官${row.reviewer.agent || '?'}${row.reviewer.round ? '·' + row.reviewer.round : ''}`);
  if (row.session.state === 'live') bits.push('会话在');
  else if (row.session.state === 'gone') bits.push('会话不在');
  else bits.push('会话没查成');
  if (row.tree.state === 'same') bits.push('树同步');
  else if (row.tree.state === 'behind') bits.push('树落后');
  else bits.push('树没查成');
  if (row.worker.state === 'live') bits.push(`工人在(${row.worker.paths.map(p => p.split(/[\\/]/).pop()).join(',')})`);
  else if (row.worker.state === 'unscanned') bits.push('工人没查成');
  if (row.mergeable === 'CONFLICTING') bits.push('冲突');
  return `  #${row.pr}${row.draft ? '(草稿)' : ''} ${clip(row.title, 34)} | ${bits.join(' ')}`;
}

function gapLines(gaps, indent = '  ') {
  if (!gaps.length) return [];
  const head = `${indent}没查成 ${gaps.length} 处：${gaps.slice(0, 3).map(g => g.source).join('、')}${gaps.length > 3 ? ` 等（--json 看全部）` : ''}`;
  return [head];
}

function emptyOrGapLine(state, emptyText, gaps, indent = '  ') {
  // 这里是「不许把没查成显示成一切正常」的最后一道：
  // 只有 state === 'empty'（查过、确实没有）才准说「没有」。
  if (state === 'empty') return [`${indent}${emptyText}`];
  if (state === 'unscanned') return [`${indent}没查成——这段等于没查，不是「没有」（${gaps.map(g => g.source).join('、') || '源没给原因'}）`];
  return [`${indent}查成的部分里没有；另有没查成的源，见下`];
}

/** 折叠一批「待你拍」条目成一行：按类计数，最多点名 2 类，其余归成「等 N 类」。 */
function foldDecide(hidden) {
  const byKind = new Map();
  for (const it of hidden) byKind.set(it.kind, (byKind.get(it.kind) || 0) + 1);
  const entries = [...byKind.entries()];
  const named = entries.slice(0, 2).map(([k, n]) => `${n} 件${KIND_TEXT[k] || k}`);
  const more = entries.length > 2 ? ` 等 ${entries.length} 类` : '';
  return `  …另 ${hidden.length} 件（${named.join('、')}${more}），用 --json 看全部`;
}

/**
 * 把三段拼成不超过 maxLines 行的输出。
 *
 * 行数账算得死：每段 = 标题 1 行 + 条目 n 行 + （有省略则）折叠 1 行 + 「没查成」0~1 行。
 * 超预算就从**条目最多的那段**一行一行往下裁（同数时按 已落地 → 待你拍 → 在途 的序，
 * 因为「在途」是这条命令的主角）。裁到每段各剩 1 行还超，就如实溢出——
 * **绝不裁标题、绝不裁「没查成」**：缺源看不见比多几行糟得多。
 * 早先按比例算配额那版在最坏情况实测超一行（30 张 PR + 三段都有缺源 → 41 行），
 * 所以改成这套逐行裁的死账；测试用最坏样本盯着。
 */
function assemble(secs, maxLines) {
  const shown = secs.map(s => s.rows.length);
  const fixed = secs.reduce((n, s) => n + 1 + s.note.length, 0);
  const total = () => fixed + shown.reduce((n, k, i) => n + k + (k < secs[i].rows.length ? 1 : 0), 0);
  const tieOrder = [0, 2, 1];
  while (total() > maxLines) {
    let pick = -1;
    let best = 0;
    for (const i of tieOrder) {
      if (shown[i] > 1 && shown[i] > best) { best = shown[i]; pick = i; }
    }
    if (pick < 0) break;
    shown[pick] -= 1;
  }
  const out = [];
  secs.forEach((s, i) => {
    out.push(s.head);
    out.push(...s.rows.slice(0, shown[i]));
    if (shown[i] < s.rows.length) out.push(s.fold(s.items.slice(shown[i])));
    out.push(...s.note);
  });
  return out;
}

/** 人看的输出。默认一屏；折叠只压条目，不压「没查成」——缺源永远看得见。 */
export function formatNow(board, { maxLines: want = DEFAULT_MAX_LINES } = {}) {
  const maxLines = Math.max(MIN_MAX_LINES, Number(want) || DEFAULT_MAX_LINES);
  const b = board || {};

  const landed = b.landed || { state: 'unscanned', items: [], unscanned: [] };
  const landedSec = {
    head: `已落地（近 ${b.windowHours ?? DEFAULT_WINDOW_HOURS} 小时）：`,
    items: landed.items,
    rows: landed.items.map(it => (it.kind === 'merged-pr'
      ? `  #${it.pr} ${it.sha || '?'} ${clip(it.text, 60)}`
      : `  ${it.sha} ${clip(it.text, 66)}`)),
    fold: hidden => `  …另 ${hidden.length} 条，用 --json 看全部`,
    note: landed.items.length === 0
      ? emptyOrGapLine(landed.state, '这段时间没有合并的 PR、master 也没有新提交', landed.unscanned).concat(gapLines(landed.unscanned))
      : gapLines(landed.unscanned),
  };

  const inflight = b.inflight || { state: 'unscanned', items: [], unscanned: [], counts: {} };
  const c = inflight.counts || {};
  const inflightSec = {
    head: `在途（${inflight.state === 'unscanned' ? 'open PR 没查成' : `${c.open} 张 open PR：无审查 ${c.noReview} / 红 ${c.red} / 绿 ${c.green}${c.verdictUnscanned ? ` / 判定没查成 ${c.verdictUnscanned}` : ''}`}）：`,
    items: inflight.items,
    rows: inflight.items.map(formatPrRow),
    fold: hidden => `  …另 ${hidden.length} 张，用 --json 看全部`,
    note: inflight.items.length === 0
      ? emptyOrGapLine(inflight.state, '一张 open PR 都没有', inflight.unscanned).concat(gapLines(inflight.unscanned))
      : gapLines(inflight.unscanned),
  };

  const decide = b.decide || { state: 'unscanned', items: [], unscanned: [] };
  const decideItems = decide.items.slice().sort(
    (a, b2) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b2.kind),
  );
  const decideSec = {
    head: `待你拍（${decide.state === 'unscanned' ? '没查成' : decideItems.length + ' 件'}）：`,
    items: decideItems,
    rows: decideItems.map(it => `  ${it.why}`),
    fold: foldDecide,
    note: decideItems.length === 0
      ? emptyOrGapLine(decide.state, '没有等你拍的事', decide.unscanned).concat(gapLines(decide.unscanned))
      : gapLines(decide.unscanned),
  };

  return assemble([landedSec, inflightSec, decideSec], maxLines).join('\n');
}
