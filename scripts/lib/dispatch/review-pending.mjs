// scripts/lib/dispatch/review-pending.mjs —— 待审队列（#815 建，#1125 改成主路）
//
// 改这段代码前必须知道的三件事：
//
// 1. **这是审官的主路，不是兜底。** 队列最早（#815）只是给 Orca depth 2 限制做的起败兜底
//    （Sub-worker dispatch is not permitted at depth 2）。Orca 已随 #1115 退役，那个理由没了；
//    2026-09-07 用户拍板把它接成主路：工人首审交卷**一律入队、不自己起审官**，
//    由指挥官调 review-pending-drain 按在役审官数拉取。
//
// 2. **为什么要队列**：起审官原来发生在工人交卷那一刻，于是生产端决定了消费端的并发——
//    工人跑得多快审官就被起得多快，而没人在看上游还剩多少容量。实测 13 个工人在跑、
//    26 张开放 PR，而 gptpool 只剩一条能用的腿（约 3 个并发），13 个审官 8 个死于 at capacity。
//    用户的话：「工人提前做好是好事，但是工人做好不要自己去开 PR 唤起审官，让中间态、
//    看门狗或者帅位去根据资源调度」。压工人是白扔算力，该管的是拉取那一侧。
//
// 3. 三态不许压成两态。扫完 0 条 ≠ 没扫成：目录不在或空是 scanned:0，目录读不了才 unscanned；
//    「在役几个」没查成时一张都不许拉——当成 0 个在跑就会一次把池子拉满，正是本单要治的病。
//
// 队列深度本身就是背压信号：「待审 18 张 / 在役 3 个」这句话即仪表盘。
// #1024 复审：文件名必须带仓，两个仓的同号 PR 不许共用 12.json。

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { dispatchQueueDir } from '../dispatch-queue.mjs';
import { EXECUTION_FINISHED, EXECUTION_RESERVED } from '../execution-states.mjs';
import { repoPrKey } from './repo.mjs';

export const REVIEW_PENDING_KIND = 'dao-review-pending';
export const REVIEW_PENDING_VERSION = 1;
export const REVIEW_PENDING_DIR_REL = join('_flow', 'queue', 'review-pending');

// #1014：复审票有两个生产者。来源必须是写票时记下的事实，读侧不许猜。
export const REVIEW_PENDING_SOURCE_WORKER_DONE_FAIL = 'worker-done-fail';
export const REVIEW_PENDING_SOURCE_COMMANDER_REREVIEW = 'commander-rereview';
// #1125：第三个生产者，也是现在的**主路**——工人首审交卷一律入队，不自己起审官。
// 与 worker-done-fail 分开记，是因为两者的含义完全不同：那个是「起失败了，兜底」，
// 这个是「按设计交到这里，等调度」。混成一个来源，队列里就分不出「出事了」和「在排队」。
export const REVIEW_PENDING_SOURCE_WORKER_DONE_HANDOFF = 'worker-done-handoff';
// #1134 短命会话：master 已在写 worker-done。读侧继续认，和新主路 handoff 一样要有工人树。
export const REVIEW_PENDING_SOURCE_WORKER_DONE = 'worker-done';
export const REVIEW_PENDING_SOURCES = new Set([
  REVIEW_PENDING_SOURCE_WORKER_DONE_FAIL,
  REVIEW_PENDING_SOURCE_COMMANDER_REREVIEW,
  REVIEW_PENDING_SOURCE_WORKER_DONE_HANDOFF,
  REVIEW_PENDING_SOURCE_WORKER_DONE,
]);

/** 票上的来源只认写票时记下的那几个值；缺/空/不认识一律 null（来源没查成，不猜）。 */
export function reviewPendingSourceOf(ticket) {
  const s = ticket && typeof ticket.source === 'string' ? ticket.source.trim() : '';
  return REVIEW_PENDING_SOURCES.has(s) ? s : null;
}

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

const REVIEW_PENDING_FILE_RE = /^(?:\d+|[A-Za-z0-9_.-]+__[A-Za-z0-9_.-]+__\d+)\.json$/;

export function reviewPendingPath(dir, pr, repo) {
  const keyed = repoPrKey({ repo, pr });
  if (!keyed.ok) {
    // 键没做成不许回落到纯 PR 号（两个仓同号会串票）。
    return join(dir, `.invalid-${String(pr ?? '').trim()}.json`);
  }
  return join(dir, `${keyed.stem}.json`);
}

export function buildReviewPendingTicket({
  pr, head, workerWorktree, reviewer, issue, round, error, workerModel, soldierDispatch, ts, source, repo,
} = {}) {
  const n = String(pr ?? '').trim();
  if (!n) return { ok: false, error: '复审待办要 pr' };
  if (!reviewer || !String(reviewer).trim()) {
    return { ok: false, error: '复审待办要 reviewer' };
  }
  const src = typeof source === 'string' ? source.trim() : '';
  if (!src) return { ok: false, error: '复审待办要 source（worker-done-fail | commander-rereview | worker-done-handoff | worker-done）' };
  if (!REVIEW_PENDING_SOURCES.has(src)) {
    return { ok: false, error: `复审待办来源不认识：${source}` };
  }
  // 工人失败票必须有树；指挥官 rereview 按设计可以没有（快马路，#927）。
  // 首审入队票（#1125 handoff / #1134 worker-done）也要有树：排障时要知道活干在哪；缺树 = 写票失败，不许入队。
  if ((src === REVIEW_PENDING_SOURCE_WORKER_DONE_FAIL
      || src === REVIEW_PENDING_SOURCE_WORKER_DONE_HANDOFF
      || src === REVIEW_PENDING_SOURCE_WORKER_DONE)
      && (!workerWorktree || !String(workerWorktree).trim())) {
    return { ok: false, error: '复审待办要工人树' };
  }
  const oid = head?.oid || head?.headRefOid || null;
  const name = head?.name || head?.headRefName || null;
  const when = ts instanceof Date ? ts : new Date(ts || Date.now());
  let repoField = null;
  if (repo != null && String(repo) !== '') {
    const keyed = repoPrKey({ repo, pr: n });
    if (!keyed.ok) return { ok: false, error: keyed.error };
    repoField = keyed.ownerName;
  }
  return {
    ok: true,
    ticket: {
      kind: REVIEW_PENDING_KIND,
      v: REVIEW_PENDING_VERSION,
      pr: n,
      head: { name: name || null, oid: oid || null },
      workerWorktree: workerWorktree && String(workerWorktree).trim() ? String(workerWorktree).trim() : null,
      reviewer: String(reviewer).trim(),
      issue: issue == null || String(issue).trim() === '' ? null : String(issue).trim(),
      round: round || null,
      workerModel: workerModel ? String(workerModel).trim() : null,
      soldierDispatch: soldierDispatch ? String(soldierDispatch).trim() : null,
      repo: repoField,
      error: error ? String(error) : null,
      source: src,
      ts: Number.isNaN(when.getTime()) ? new Date().toISOString() : when.toISOString(),
    },
  };
}

export function writeReviewPending({ dir, ticket } = {}) {
  if (!dir) return { ok: false, error: '写复审待办没给目录' };
  if (!ticket || ticket.kind !== REVIEW_PENDING_KIND || !ticket.pr) {
    return { ok: false, error: '不是复审待办（kind/pr 对不上）' };
  }
  const keyed = repoPrKey({ repo: ticket.repo, pr: ticket.pr });
  if (!keyed.ok) return { ok: false, error: keyed.error };
  const path = reviewPendingPath(dir, ticket.pr, ticket.repo);
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
    if (!REVIEW_PENDING_FILE_RE.test(name)) continue;
    const read = readReviewPending(join(dir, name));
    if (!read.ok) return { ok: false, unscanned: true, error: read.error, tickets };
    tickets.push(read.ticket);
  }
  tickets.sort((a, b) => String(a.ts || '').localeCompare(String(b.ts || '')));
  return { ok: true, unscanned: false, scanned: tickets.length, tickets };
}

/** 上限默认值。2026-09-07 实测 gptpool 单腿同时活得下来约 3 个；可用 DAO_REVIEWER_CAP 覆盖。 */
export const DEFAULT_REVIEWER_CAP = 3;

/**
 * 按资源拉取（#1125，2026-09-07 用户拍板）：队列里有多少张不重要，**能同时跑几个审官**才重要。
 *
 * 用户的话：「工人做好不要自己去开 PR 唤起审官，让中间态、看门狗或者帅位去根据资源调度」。
 * 生产端（工人）不该决定消费端并发——工人跑得快是净收益，压它是白扔算力；该管的是拉取这一侧。
 *
 * 上限的由来是量出来的，不是拍的：`gptpool` 现在只剩一条能用的腿（pqapi 两条熔断，
 * 只剩 Windsurf luna），2026-09-07 实测同时活得下来约 3 个，起第 4 个就成片
 * `Selected model is at capacity`。所以 cap 是**上游腿容量**，不是机器资源。
 *
 * @param tickets       队列里的票（listReviewPending().tickets）
 * @param liveReviewers 在役审官会话数；null/非数 = 没查成
 * @param cap           上限
 * @returns {{ok, pull, held, why, unscanned?}} pull=这一轮该拉的，held=留在队列的
 */

/**
 * 容量闸开关（#1125 判别力自证）。测试把 cap-full 置 false，满载样本必须被放行——
 * 证明这条闸是承重的，不是旁路。生产路径上全 true。
 */
export const REVIEW_ADMISSION_CHECKS = {
  'cap-full': true,
  'live-unscanned': true,
  'queue-unscanned': true,
};

/**
 * drain 算不算「试过」（#1125 审官红 1）。达上限 / 没查成拉 0 是背压，不是失败——
 * 记 tries 会让 45 分钟后 retry-drain --pr 把容量闸冲掉。测试把闸摘掉，满载必须被记成试过。
 */
export const DRAIN_ATTEMPT_CHECKS = {
  'held-not-try': true,
  'unscanned-not-try': true,
};

export function classifyDrainAttempt(payload, { _checks } = {}) {
  const C = (_checks && typeof _checks === 'object') ? _checks : DRAIN_ATTEMPT_CHECKS;
  if (payload && payload.dryRun === true) {
    return { countTry: false, reason: 'dry-run' };
  }
  if (!payload || typeof payload !== 'object') {
    return { countTry: true, reason: 'drain-unparsed' };
  }
  if (payload.unscanned === true) {
    if (C['unscanned-not-try'] !== true) {
      return { countTry: true, reason: 'unscanned-but-gate-off', held: Number(payload.held) || 0 };
    }
    return { countTry: false, reason: 'unscanned', held: Number(payload.held) || 0 };
  }
  const drained = Number(payload.drained) || 0;
  const failed = Number(payload.failed) || 0;
  const held = Number(payload.held) || 0;
  if (payload.ok === true && drained === 0 && failed === 0) {
    if (held > 0 && C['held-not-try'] !== true) {
      return { countTry: true, reason: 'held-but-gate-off', held };
    }
    return { countTry: false, reason: held > 0 ? 'held' : 'empty', held };
  }
  return {
    countTry: true,
    reason: payload.ok === true ? 'pulled' : 'failed',
    drained,
    failed,
    held,
  };
}

function admissionChecksOf(input) {
  if (input && input._checks && typeof input._checks === 'object') return input._checks;
  return REVIEW_ADMISSION_CHECKS;
}

export function planReviewAdmission({ tickets, liveReviewers, cap = DEFAULT_REVIEWER_CAP, _checks } = {}) {
  const C = admissionChecksOf({ _checks });
  if (!Array.isArray(tickets)) {
    if (C['queue-unscanned'] !== true) {
      return { ok: true, pull: [], held: [], why: '队列没扫成但闸被摘掉，当扫完 0 条' };
    }
    return { ok: false, unscanned: true, pull: [], held: [], why: '队列没扫成（没查成），这一轮不拉' };
  }
  // 「在役几个」没查成时拉 0 张。把没查成当成「0 个在跑」会一次拉满 cap 张，
  // 那正是本单要治的病——生产端一次把池子打满。
  if (!Number.isInteger(liveReviewers) || liveReviewers < 0) {
    if (C['live-unscanned'] !== true) {
      // 闸被摘掉：当成 0 个在跑去拉满——这正是本单要治的病，变异测试靠它当场变红。
      liveReviewers = 0;
    } else {
      return {
        ok: false, unscanned: true, pull: [], held: tickets.slice(),
        why: `在役审官数没查成（拿到 ${JSON.stringify(liveReviewers)}）——不许当成 0 个在跑去拉满`,
      };
    }
  }
  const room = Math.max(0, cap - liveReviewers);
  if (room === 0) {
    if (C['cap-full'] !== true) {
      // 闸被摘掉：满载也拉。变异测试用这个证明「达上限拉 0」是这条闸撑着的。
      return {
        ok: true, pull: tickets.slice(), held: [],
        why: `在役 ${liveReviewers} 个已达上限 ${cap}，但容量闸被摘掉，照拉`,
      };
    }
    return {
      ok: true, pull: [], held: tickets.slice(),
      why: `在役 ${liveReviewers} 个已达上限 ${cap}，这一轮拉 0 张（票留在队列，不丢）`,
    };
  }
  // 先来先服务：票按 ts 排，不然「谁被拉走」随目录枚举顺序变，积压里最老的可能永远排不上。
  const ordered = tickets.slice().sort((a, b) => String(a?.ts || '').localeCompare(String(b?.ts || '')));
  return {
    ok: true,
    pull: ordered.slice(0, room),
    held: ordered.slice(room),
    why: `在役 ${liveReviewers} / 上限 ${cap}，这一轮拉 ${Math.min(room, ordered.length)} 张（队列共 ${ordered.length} 张）`,
  };
}

// 终态：到了这几个就不占并发位了。注意 done 也在里面——审官那一针跑完就不再占上游。
//
// 2026-09-11：从手打清单换成 execution-states 的正典（同一晚第 4 处手打副本）。
// 手打那份漏了 `stopped` / `incomplete` / `gone` / `rejected` 等仓里公认的终态，
// 实测 29 条残留里只有 1 条 stopped 被算成终态，其余全被当成「在役」——
// 「在役 19 个」永久压着上限 3，复审票一张也拉不动。
const REVIEWER_DONE_PHASES = EXECUTION_FINISHED;

/**
 * 中间态（stopping / pending / uncertain）什么时候不再占位。
 *
 * 不能像终态那样直接放行：中间态是「收尾走了一半」，可能真在收。
 * 但也不能永远占位——同一晚实测 4 条 stopping 挂在 23–31 分钟前、对应树**零进程**，
 * 却把上限 3 吃满，队列一张都拉不动。
 *
 * 所以按 lease-gc 同一套纪律：**过宽限 + 名单里没有活会话**才不算在役。
 * 宽限内一律保留（审官可能正在收尾）。判据与「死人占树」那三层同源。
 */
const REVIEWER_RESERVED_GRACE_MIN = 15;

function occupiesReviewerSlot({ phase, updatedAt, now }) {
  if (REVIEWER_DONE_PHASES.has(phase)) return false;
  if (!EXECUTION_RESERVED.has(phase)) return true;   // 真在跑：占位
  const at = Number(updatedAt);
  if (!Number.isFinite(at) || at <= 0) return true;  // 时间读不到 → 不猜，占位（fail-closed）
  const ageMin = (now - at) / 60000;
  return ageMin < REVIEWER_RESERVED_GRACE_MIN;       // 宽限内算在收尾；过点就算挂了
}

/**
 * 数「现在有几个审官真在跑」。纯判据：会话名单由调用方一次读进来，本函数不碰 IO。
 *
 * 为什么不数登记文件：满地都是「登记还在、会话早死」的记录（#1121）。
 * 为什么不数进程：会话死后 mirasim 会把进程重新拉起来，进程活着而那一针永远不动（残壳）。
 * **只有会话名单里的 runState 算数。**
 *
 * @param records  审官登记记录数组（要有 sessionKey）
 * @param sessions listSessions 回的 sessions 数组；不是数组 = 没查成
 */
export function countLiveReviewers({ records, sessions } = {}) {
  if (!Array.isArray(sessions)) {
    return { ok: false, unscanned: true, count: null, why: '会话名单没读到（没查成）——不许当成 0 个在跑' };
  }
  if (!Array.isArray(records)) {
    return { ok: false, unscanned: true, count: null, why: '审官登记没扫成（没查成）' };
  }
  const byKey = new Map(sessions.filter(s => s && s.sessionKey).map(s => [String(s.sessionKey), s]));
  const live = [];
  for (const r of records) {
    const key = r && r.sessionKey ? String(r.sessionKey).trim() : '';
    if (!key) continue;
    const s = byKey.get(key);
    if (!s) continue;                                   // 名单里没有 = 已经不在了
    // 2026-09-11 实咬：这里原来只读 `s.runState`，而执行运行时给的会话名单里
    // **根本没有 runState 这个字段**（字段是 state/phase，见 mirasim-runtime 的
    // listSessions 行）。于是 phase 恒为空串 → 永远命不中终态 →
    // **每一条登记记录都被算成「在役审官」**，实测 29 条登记数出 28 个在役，
    // 上限 3 永久吃满，复审票一张都拉不动（held 恒 4）。
    // 现场：7 张 PR 卡在「当前 head 零判定」，复审票在队列里躺了 5 轮。
    //
    // 仓里别处早就这么兜底了（commander-core `s.state || s.runState || s.driverState`、
    // execution-runtime `hit.runState || hit.phase`），只有这一处漏了。
    const raw = s.runState ?? s.state ?? s.phase ?? s.driverState;
    const phase = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    if (!occupiesReviewerSlot({ phase, updatedAt: s.updatedAt, now: Date.now() })) continue;
    // 带死因的那一针已经废了（#1121 同一判据），也不占位——否则残壳会把上限吃满，
    // 队列永远拉不动，看起来像「一直满载」其实一个都没在跑。
    // 只认「死因」字样，不把任意非空 runDetail 当死——预览/进度字也会写进这一格。
    const detail = typeof s.runDetail === 'string' ? s.runDetail : '';
    if (/\bat capacity\b|Selected model is at capacity/i.test(detail)) continue;
    live.push({ pr: r.pr ?? null, sessionKey: key, phase: phase || null });
  }
  return { ok: true, unscanned: false, count: live.length, live };
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
  // 审官统一走 mirasim（2026-09-06 切流量第二步）。
  //
  // 原来这里按「票上有没有工人树」分两条路：有树 attach 到那棵树，没树才 create。
  // 那个分岔是 orca 的世界观——审官要挂在一棵 Orca 卡管理的树上。mirasim 是「会话即卡」，
  // 没有可 attach 的对象，**整条 attach 路在这边不存在**，所以不是改判据，是删掉一层。
  //
  // 为什么现在能删：mirasim 审官路径当天验过两次（PR #1013 读代码跑核验、PR #1025 判出 APPROVED
  // 并已合并），树 HEAD 与 PR headRefOid 对得上，merge-policy 从账本恢复得回来。
  //
  // 不切的代价是实测出来的：dispatch 切了而审官没切，orca 树数不减反增——
  // 17:27 又冒出一棵 `PR-1018-审官-…-2`（连编号都说明是第二次起），退役直接被逆转。
  const argv = ['reviewer-create', '--pr', pr, '--reviewer', reviewer, '--executor', 'mirasim'];
  if (ticket.issue) argv.push('--issue', String(ticket.issue));
  if (ticket.soldierDispatch) argv.push('--soldier-dispatch', String(ticket.soldierDispatch));
  if (ticket.repo) argv.push('--repo', String(ticket.repo));
  return {
    ok: true,
    verb: 'reviewer-create',
    argv,
    skipWait: true,
    fastPath: true,
    pr,
    // 票上的工人树只做记录：mirasim 审官不挂在它上面，但排障时要知道活干在哪
    worktree: worktree || null,
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
    const pendingPath = reviewPendingPath(dir, ticket.pr, ticket.repo);
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
