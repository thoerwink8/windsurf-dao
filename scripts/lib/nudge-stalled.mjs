// scripts/lib/nudge-stalled.mjs —— 「推一把」该不该起新会话（#1097）
//
// 垫片本体在 scripts/nudge-stalled.mjs。本文件是闸：只吃入参、不碰盘、不出网。
// 2026-09-07 实锤：timer 每 20 分钟对 runState: incomplete 的树调 startSession，
// 不看单是否已关、PR 是否已合、树上是否还有人、分支对不对。一次推了 6 棵，
// 含已关 #1012 / #1007，以及停在 master 的 #1063。
//
// 正路不是「往旧会话说话」——interact 只答会话里等着的问题，塞不进等下一轮的嘴里，
// 所以垫片只能起新会话。闸的意思是：**人退了才起新的**；已结束 / 人还在 / 错分支一律不推。
// #1056 对账循环合并时本垫片整套退役，在那之前这三道闸就是正门。

import { basename } from 'node:path';
import { attributedIssueNumber } from './close-issue.mjs';
import { identifyTreeDir } from './mirasim-trees.mjs';

// gh pr list 不翻页。取满 limit 条 = 可能被截断，截断后「没有该单 PR」是假阴性，
// 会把非 master 且查不到开放 PR 的工人判成 go，绕过分支闸。本仓 856 个 PR 时
// `--limit 100` 实锤只回 100 条（PR #1102 审官红项 1）。
export const PR_LIST_LIMIT = 10000;

/**
 * PR 列表是否查全。ok 且条数 < limit 才算完整；取满 / 非数组 / 没查成 → 没查全。
 */
export function classifyPrListScan({ ok, error, items, limit = PR_LIST_LIMIT } = {}) {
  if (ok !== true) {
    return { ok: false, error: error || 'PR 面没查成' };
  }
  if (!Array.isArray(items)) {
    return { ok: false, error: 'PR 面不是数组（没查成）' };
  }
  if (!Number.isInteger(limit) || limit <= 0) {
    return { ok: false, error: 'PR 面 limit 不是正整数（没查成）' };
  }
  if (items.length >= limit) {
    return {
      ok: false,
      error: `PR 面取满 ${limit} 条（列表被截断，没查全）`,
    };
  }
  return { ok: true, items };
}

/**
 * timer 退出码：没查成 2，起会话失败 1，busy 背压 / 跳过 / 成功 0。
 * systemd 只看得见非零；busy 不是失败，不能跟 mirasim unavailable 长成一个样。
 */
export function nudgeExitCode(out = {}) {
  if (Array.isArray(out.unscanned) && out.unscanned.length) return 2;
  if (Array.isArray(out.failed) && out.failed.length) return 1;
  return 0;
}

export function idOfTree(workdir) {
  const name = basename(String(workdir || '').replace(/\/+$/, ''));
  const id = identifyTreeDir(name);
  if (!id) return null;
  return {
    kind: id.kind,
    n: id.number,
    label: id.kind === '审官' ? `PR #${id.number}` : `#${id.number}`,
  };
}

function st(v) {
  return String(v || '').toUpperCase();
}

function branchName(v) {
  return String(v || '').replace(/^refs\/heads\//, '').trim();
}

function attributedTo(pr, issueN) {
  if (!pr) return false;
  return attributedIssueNumber(pr) === issueN;
}

/**
 * 一棵 incomplete 的树该不该起新会话。
 *
 * 入参全是信封（ok / error），「没查成」与「查过没有」分得开。
 * 没查成 → action:'unscanned'，调用方不许起会话。
 *
 * @returns {{action:'go'|'skip'|'unscanned', kind?:string, reason:string}}
 */
export function judgeNudge({ id, issue, prs, branch, lease } = {}) {
  if (!id || !id.kind || !id.n) {
    return { action: 'skip', kind: 'unknown', reason: '认不出树身份，不推' };
  }

  const who = `${id.kind} ${id.label}`;

  // ① 已关 issue / 已合 PR —— 结束了还当没结束去推，就是今晚那 6 棵。
  if (id.kind === '工人') {
    if (!issue || issue.ok !== true) {
      const err = (issue && issue.error) || '没给 issue 面';
      return { action: 'unscanned', kind: 'issue', reason: `${who} 的 issue #${id.n} 没查成：${err}` };
    }
    if (st(issue.state) === 'CLOSED') {
      return { action: 'skip', kind: 'closed', reason: `${who} 的 issue #${id.n} 已关，不推` };
    }
  }

  if (!prs || prs.ok !== true) {
    const err = (prs && prs.error) || '没给 PR 面';
    return { action: 'unscanned', kind: 'pr', reason: `${who} 的 PR 面没查成：${err}` };
  }
  if (!Array.isArray(prs.items)) {
    return { action: 'unscanned', kind: 'pr', reason: `${who} 的 PR 面不是数组（没查成）` };
  }

  if (id.kind === '审官') {
    const pr = prs.items.find((p) => Number(p && p.number) === id.n);
    if (!pr) {
      return { action: 'unscanned', kind: 'pr', reason: `${who} 的 PR #${id.n} 没查到（没查成，不推）` };
    }
    const s = st(pr.state);
    if (s === 'MERGED') {
      return { action: 'skip', kind: 'merged', reason: `${who} 已合，不推` };
    }
    if (s === 'CLOSED') {
      return { action: 'skip', kind: 'closed', reason: `${who} 已关，不推` };
    }
  }

  if (id.kind === '工人') {
    const mine = prs.items.filter((p) => attributedTo(p, id.n));
    const merged = mine.find((p) => st(p.state) === 'MERGED');
    if (merged) {
      return {
        action: 'skip',
        kind: 'merged',
        reason: `${who} 的 PR #${merged.number} 已合，不推`,
      };
    }
  }

  // ② 租约 held = 人还在。startSession 会再起一条，正是 #1007 一晚 18 次的环路。
  if (!lease || lease.ok !== true) {
    const err = (lease && lease.error) || '没给租约面';
    return { action: 'unscanned', kind: 'lease', reason: `${who} 租约没查成，不推：${err}` };
  }
  if (lease.verdict === 'held') {
    return {
      action: 'skip',
      kind: 'held',
      reason: `${who} 人还在，不另起一条：${lease.why || '租约 held'}`,
    };
  }

  // ③ 树的分支对不上该单 PR head —— #1063 停在 master、PR 在 fix-escalate-noise。
  if (!branch || branch.ok !== true) {
    const err = (branch && branch.error) || '没给分支面';
    return { action: 'unscanned', kind: 'branch', reason: `${who} 的分支没查成，不推：${err}` };
  }
  const current = branchName(branch.name);
  if (!current || current === 'HEAD') {
    return {
      action: 'unscanned',
      kind: 'branch',
      reason: `${who} 不在具名分支上（${current || '空'}），对不上 PR head（没查成）`,
    };
  }

  let expected = null;
  let expectedPr = null;
  if (id.kind === '审官') {
    const pr = prs.items.find((p) => Number(p && p.number) === id.n);
    expected = branchName(pr && pr.headRefName);
    expectedPr = pr && pr.number;
    if (!expected) {
      return {
        action: 'unscanned',
        kind: 'branch',
        reason: `${who} 的 PR head 分支名没读到，对不上树（没查成）`,
      };
    }
  } else {
    const open = prs.items.filter((p) => attributedTo(p, id.n) && st(p.state) === 'OPEN');
    if (open.length === 1) {
      expected = branchName(open[0].headRefName);
      expectedPr = open[0].number;
      if (!expected) {
        return {
          action: 'unscanned',
          kind: 'branch',
          reason: `${who} 的 PR #${open[0].number} head 分支名没读到（没查成）`,
        };
      }
    } else if (open.length > 1) {
      const hit = open.find((p) => branchName(p.headRefName) === current);
      if (!hit) {
        const heads = open.map((p) => `#${p.number}:${branchName(p.headRefName) || '?'}`).join('、');
        return {
          action: 'skip',
          kind: 'wrong-branch',
          reason: `${who} 树在 ${current}，对不上该单开放 PR head（${heads}），不在错误分支上继续`,
        };
      }
    }
    // 0 个开放署名 PR：工人可能还没开 PR，分支闸无对象，不拦。
  }

  if (expected && current !== expected) {
    return {
      action: 'skip',
      kind: 'wrong-branch',
      reason: `${who} 树在 ${current}，该单 PR${expectedPr != null ? ` #${expectedPr}` : ''} head 是 ${expected}，不在错误分支上继续`,
    };
  }

  // 署名 PR 搜不到时，主干上也没有该单的工作分支——#1063 停在 master 就是这个。
  if (!expected && (current === 'master' || current === 'main')) {
    return {
      action: 'skip',
      kind: 'wrong-branch',
      reason: `${who} 树在 ${current}，不是该单的工作分支，不在错误分支上继续`,
    };
  }

  return { action: 'go', reason: `${who} incomplete 且未结束、人已退、分支对得上` };
}

/**
 * 按树取最近那条记录，再筛 incomplete。
 * 旧的 running 盖不住新的 incomplete（dao-1017 实咬）。
 */
export function collectStalled(records, { exists, only } = {}) {
  if (!Array.isArray(records)) return [];
  const latest = new Map();
  for (const r of records) {
    if (!r || !r.workdir) continue;
    const id = idOfTree(r.workdir);
    if (!id) continue;
    if (typeof exists === 'function' && !exists(r.workdir)) continue;
    const at = Date.parse(r.updatedAt || '') || 0;
    const prev = latest.get(r.workdir);
    if (!prev || at > prev.at) latest.set(r.workdir, { at, rec: r, id });
  }
  return [...latest.values()]
    .filter((x) => x.rec.runState === 'incomplete')
    .filter((x) => !only || String(x.id.n) === String(only))
    .sort((a, b) => a.at - b.at);
}

/**
 * 对已收集的卡住树逐个过闸。startSession 只在 action==='go' 且 go===true 时调用。
 * IO 全注入：lookupIssue / lookupPrs / readBranch / checkLease / startSession。
 */
export async function runNudge({
  go = false,
  only = null,
  records = [],
  exists,
  lookupIssue,
  lookupPrs,
  readBranch,
  checkLease,
  startSession,
  workerPrompt,
  reviewPrompt,
  log = () => {},
  error = () => {},
} = {}) {
  const stalled = collectStalled(records, { exists, only });
  const out = { stalled: stalled.length, started: [], skipped: [], unscanned: [], failed: [] };
  if (!stalled.length) {
    log('[推一把] 没有卡住的树');
    return out;
  }

  for (const { rec, id } of stalled) {
    const who = `${id.kind} ${id.label}`;
    const agent = rec.agent || 'pi';
    const issue = id.kind === '工人'
      ? (typeof lookupIssue === 'function' ? lookupIssue(id.n) : { ok: false, error: '没给 lookupIssue' })
      : null;
    const prs = typeof lookupPrs === 'function' ? lookupPrs(id) : { ok: false, error: '没给 lookupPrs' };
    const branch = typeof readBranch === 'function' ? readBranch(rec.workdir) : { ok: false, error: '没给 readBranch' };
    const lease = typeof checkLease === 'function' ? checkLease(rec.workdir) : { ok: false, error: '没给 checkLease' };
    const verdict = judgeNudge({ id, issue, prs, branch, lease });

    if (verdict.action === 'unscanned') {
      out.unscanned.push({ id, reason: verdict.reason });
      error(`[推一把] ${verdict.reason}`);
      continue;
    }
    if (verdict.action === 'skip') {
      out.skipped.push({ id, kind: verdict.kind, reason: verdict.reason });
      log(`[推一把${go ? '' : '·预览'}] ${verdict.reason}`);
      continue;
    }

    if (!go) {
      log(`[推一把·预览] ${who} ${agent} 将推（${rec.runDetail || rec.runState}）`);
      continue;
    }
    if (typeof startSession !== 'function') {
      out.unscanned.push({ id, reason: `${who} 没给 startSession（没查成）` });
      error(`[推一把] ${who} 没给 startSession（没查成，不起会话）`);
      continue;
    }
    try {
      const prompt = id.kind === '审官' ? reviewPrompt : workerPrompt;
      const r = await startSession({ agent, workdir: rec.workdir, prompt });
      const key = r && r.sessionKey;
      out.started.push({ id, sessionKey: key || null });
      log(`[推一把] ${who} 推了：${key || '（没给 sessionKey）'}`);
    } catch (e) {
      const busy = e && e.detail && e.detail.busy === true;
      if (busy) {
        const reason = `${who} 人还在，不另起一条：${String(e.message || e).slice(0, 160)}`;
        out.skipped.push({ id, kind: 'held', reason });
        log(`[推一把] ${reason}`);
      } else {
        const reason = `${who} 推不动：${String(e.message || e).slice(0, 160)}`;
        out.failed.push({ id, reason });
        error(`[推一把] ${reason}`);
      }
    }
  }
  return out;
}
