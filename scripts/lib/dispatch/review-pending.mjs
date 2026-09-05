// scripts/lib/dispatch/review-pending.mjs —— 复审待办队列（#815）
//
// 改这段前必须知道：worker-done 在士兵 dispatch 里起审官会撞 Orca 深度限制
// （Sub-worker dispatch is not permitted at depth 2）。起败时把待办落到
// _flow/queue/review-pending/<pr>.json，指挥官 / automations 调
// review-pending-drain 逐条 reviewer-attach --skip-wait。
// 扫完 0 条 ≠ 没扫成：目录不在或空是 scanned:0；目录读不了才 unscanned。

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { dispatchQueueDir } from '../dispatch-queue.mjs';

export const REVIEW_PENDING_KIND = 'dao-review-pending';
export const REVIEW_PENDING_VERSION = 1;
export const REVIEW_PENDING_DIR_REL = join('_flow', 'queue', 'review-pending');

export function reviewPendingDir({ root, env } = {}) {
  const e = env || process.env;
  const override = e.DAO_REVIEW_PENDING_DIR;
  if (override && String(override).trim()) return resolve(root || process.cwd(), String(override));
  if (e.DAO_DISPATCH_QUEUE_DIR && String(e.DAO_DISPATCH_QUEUE_DIR).trim()) {
    return join(dispatchQueueDir({ root, env: e }), 'review-pending');
  }
  if (!root) throw new Error('reviewPendingDir 要 root（或 DAO_REVIEW_PENDING_DIR）');
  return join(root, REVIEW_PENDING_DIR_REL);
}

export function reviewPendingPath(dir, pr) {
  return join(dir, `${String(pr).trim()}.json`);
}

export function buildReviewPendingTicket({
  pr, head, workerWorktree, reviewer, issue, round, error, workerModel, soldierDispatch, ts,
} = {}) {
  const n = String(pr ?? '').trim();
  if (!n) return { ok: false, error: '复审待办要 pr' };
  if (!workerWorktree || !String(workerWorktree).trim()) {
    return { ok: false, error: '复审待办要工人树' };
  }
  if (!reviewer || !String(reviewer).trim()) {
    return { ok: false, error: '复审待办要 reviewer' };
  }
  const oid = head?.oid || head?.headRefOid || null;
  const name = head?.name || head?.headRefName || null;
  const when = ts instanceof Date ? ts : new Date(ts || Date.now());
  return {
    ok: true,
    ticket: {
      kind: REVIEW_PENDING_KIND,
      v: REVIEW_PENDING_VERSION,
      pr: n,
      head: { name: name || null, oid: oid || null },
      workerWorktree: String(workerWorktree).trim(),
      reviewer: String(reviewer).trim(),
      issue: issue == null || String(issue).trim() === '' ? null : String(issue).trim(),
      round: round || null,
      workerModel: workerModel ? String(workerModel).trim() : null,
      soldierDispatch: soldierDispatch ? String(soldierDispatch).trim() : null,
      error: error ? String(error) : null,
      ts: Number.isNaN(when.getTime()) ? new Date().toISOString() : when.toISOString(),
    },
  };
}

export function writeReviewPending({ dir, ticket } = {}) {
  if (!dir) return { ok: false, error: '写复审待办没给目录' };
  if (!ticket || ticket.kind !== REVIEW_PENDING_KIND || !ticket.pr) {
    return { ok: false, error: '不是复审待办（kind/pr 对不上）' };
  }
  const path = reviewPendingPath(dir, ticket.pr);
  try {
    mkdirSync(dir, { recursive: true });
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(ticket, null, 2), 'utf8');
    renameSync(tmp, path);
  } catch (e) {
    return { ok: false, error: `复审待办写盘失败：${String(e.message || e)}` };
  }
  return { ok: true, path, ticket };
}

export function readReviewPending(path) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    return { ok: false, unscanned: true, error: `复审待办读不了 ${path}：${String(e.message || e)}` };
  }
  if (!parsed || parsed.kind !== REVIEW_PENDING_KIND || !parsed.pr) {
    return { ok: false, unscanned: true, error: `不是复审待办（kind/pr 对不上）: ${path}` };
  }
  return { ok: true, ticket: parsed };
}

export function listReviewPending(dir) {
  if (!dir || !existsSync(dir)) {
    return { ok: true, unscanned: false, scanned: 0, tickets: [] };
  }
  let names;
  try {
    names = readdirSync(dir);
  } catch (e) {
    return {
      ok: false,
      unscanned: true,
      error: `复审待办目录读不了：${String(e.message || e)}`,
      tickets: [],
    };
  }
  const tickets = [];
  for (const name of names) {
    if (!/^\d+\.json$/.test(name)) continue;
    const read = readReviewPending(join(dir, name));
    if (!read.ok) return { ok: false, unscanned: true, error: read.error, tickets };
    tickets.push(read.ticket);
  }
  tickets.sort((a, b) => String(a.ts || '').localeCompare(String(b.ts || '')));
  return { ok: true, unscanned: false, scanned: tickets.length, tickets };
}

export function planReviewPendingDrain(ticket) {
  if (ticket == null) {
    return { ok: false, unscanned: true, error: '待办没拿到（没查成）' };
  }
  if (typeof ticket !== 'object') {
    return { ok: false, error: '待办不是对象' };
  }
  const pr = String(ticket.pr ?? '').trim();
  const worktree = String(ticket.workerWorktree ?? '').trim();
  const reviewer = String(ticket.reviewer ?? '').trim();
  if (!pr) return { ok: false, error: '待办缺 pr' };
  if (!reviewer) return { ok: false, error: '待办缺 reviewer' };
  if (!worktree) {
    // 快马票（2026-09-05 实咬 #884/#885/#886）：活干在非 Orca 管理的树里，票上 workerWorktree 是 null。
    // 此前这里直接判失败，三张 PR 的审官 10 小时起不来，而错误只出现在 drain 的返回里，没人看。
    // #927 起 reviewer-create 自己会「确证无士兵树才建替身树当父卡」，所以缺树改走 create 路，不是拒绝。
    // 注意仍然只在 worktree 缺失时走：有树就走 attach，别让快马路吞掉正常路的判据。
    const createArgv = ['reviewer-create', '--pr', pr, '--reviewer', reviewer];
    if (ticket.issue) createArgv.push('--issue', String(ticket.issue));
    return {
      ok: true,
      verb: 'reviewer-create',
      argv: createArgv,
      skipWait: true,
      fastPath: true,
      pr,
      worktree: null,
      reviewer,
    };
  }
  const argv = [
    'reviewer-attach',
    '--pr', pr,
    '--worktree', worktree,
    '--reviewer', reviewer,
    '--skip-wait',
  ];
  if (ticket.issue) argv.push('--issue', String(ticket.issue));
  if (ticket.soldierDispatch) argv.push('--soldier-dispatch', String(ticket.soldierDispatch));
  if (ticket.workerModel) argv.push('--model', String(ticket.workerModel));
  return {
    ok: true,
    verb: 'reviewer-attach',
    argv,
    skipWait: true,
    pr,
    worktree,
    reviewer,
  };
}

export function consumeReviewPending({ dir, ticket, attach } = {}) {
  const plan = planReviewPendingDrain(ticket);
  if (!plan.ok) return { ...plan, pr: ticket?.pr || null };
  if (typeof attach !== 'function') {
    return { ok: false, unscanned: true, error: 'drain 没拿到 attach 执行器（没查成）', pr: plan.pr };
  }
  let attached;
  try {
    attached = attach(plan);
  } catch (e) {
    return { ok: false, error: `reviewer-attach 抛了：${String(e.message || e)}`, pr: plan.pr, plan };
  }
  if (!attached || attached.ok !== true) {
    return {
      ok: false,
      error: `reviewer-attach 失败：${attached && attached.error ? attached.error : '没返回'}`,
      pr: plan.pr,
      plan,
      attached: attached || null,
    };
  }
  if (dir && ticket?.pr) {
    const pendingPath = reviewPendingPath(dir, ticket.pr);
    try {
      unlinkSync(pendingPath);
    } catch (e) {
      return {
        ok: false,
        cleanupFailed: true,
        error: `复审待办删不掉：${String(e.message || e)}（清理失败，不许当已消费）`,
        pr: plan.pr,
        plan,
        attached,
        path: pendingPath,
      };
    }
  }
  return { ok: true, pr: plan.pr, plan, attached };
}

export function drainReviewPending({ dir, tickets, attach } = {}) {
  let listed = tickets;
  if (!Array.isArray(listed)) {
    const scan = listReviewPending(dir);
    if (!scan.ok) return scan;
    listed = scan.tickets;
  }
  if (typeof attach !== 'function') {
    return {
      ok: false,
      unscanned: true,
      error: 'drain 没拿到 attach 执行器（没查成）',
      scanned: Array.isArray(listed) ? listed.length : 0,
    };
  }
  const results = [];
  for (const t of listed) {
    results.push(consumeReviewPending({ dir, ticket: t, attach }));
  }
  const failed = results.filter(r => !r.ok);
  return {
    ok: failed.length === 0,
    unscanned: false,
    scanned: listed.length,
    drained: results.filter(r => r.ok).length,
    failed: failed.length,
    results,
  };
}
