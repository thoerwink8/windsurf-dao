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
import { mainCheckoutRoot } from '../main-checkout.mjs';
import { EXECUTION_FINISHED, EXECUTION_RESERVED, sessionStateOf } from '../execution-states.mjs';
import { repoPrKey } from './repo.mjs';
import { vendorFamilyOf } from '../reviewer-vendor-gate.mjs';

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

/**
 * 队列落点 = **主 clone 根**下的 `_flow/queue/review-pending`。
 *
 * 为什么要过 mainCheckoutRoot（2026-09-12 实咬）：原来直接 `join(root, …)`，而 root 是
 * 调用方**本树**的根。工人在自己的 worktree 里交卷，票就写进那棵树；drain 在主树里读，
 * 永远看不见——#1159（票在 dao-1152/_flow/）、#1208（票在 dao-1174/_flow/）两条实锤，
 * 队列看起来只是「少了几张」，不报错。修法见 lib/main-checkout.mjs 头部。
 *
 * root 仍可显式给（测试隔真仓），但**再叠一层** git-common-dir：显式 root 若是 worktree，
 * 也归到主 clone——「一份队列」这件事不该由调用方记得。
 */
export function reviewPendingDir({ root, env, spawn } = {}) {
  const e = env || process.env;
  const override = e.DAO_REVIEW_PENDING_DIR;
  if (override && String(override).trim()) return resolve(root || process.cwd(), String(override));
  if (e.DAO_DISPATCH_QUEUE_DIR && String(e.DAO_DISPATCH_QUEUE_DIR).trim()) {
    return join(dispatchQueueDir({ root, env: e }), 'review-pending');
  }
  return join(mainCheckoutRoot({ treeRoot: root, env: e, spawn }), REVIEW_PENDING_DIR_REL);
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

/**
 * 上限兜底值。**只在没有任何有限渠道约束时用**（见 resolveReviewerCap）。
 *
 * 原先这里写死 3，注释说「2026-09-07 实测 gptpool 单腿同时活得下来约 3 个」。那次实测的前提
 * 今天全没了：gptpool / pqapi / windsurf 的执行档都已 `enabled:false`，在役审官只剩
 * `xai-native`（路由表「不限」）和 `mirasim-relay`（路由表 5），一条都不过网关。
 * 拿网关时代的数字限 ACP 直连时代的并发，是 memory `hand-typed-constant-will-be-wrong` 的原样复发。
 *
 * 有限渠道上限始终是最终上界：合同是 1 就不能为了保底再开第 2 条去撞 429。
 */
export const REVIEWER_CAP_FLOOR = 2;

/**
 * 审官并发上限 = min(机器核数, **本轮实际会用的审官**所落渠道里最严的一条上游合同)。
 *
 * 两层各管各的：机器那层管「本机同时开得起几个会话」，渠道那层管「上游账号合同容许几条」。
 * 把两层压成一个手打常量，就是任何一层变了都没人知道要改哪个数。
 *
 * **渠道那层只数本轮票真正会用的审官**（票上那位，或同厂有效 fallback），不许：
 *   · 拿整张容量表取严——不在役的腿会把在役的活拖死（2026-09-14 第一版，算出 2）；
 *   · 拿全部可用候选取严——队列用不到的那条 cap=1 腿会把整队压死。
 *
 * **有限渠道上限始终是最终上界**。保底只在没有任何有限渠道约束时生效——
 * `channelOf() => 1` 必须回 1，不许被保底抬成 2（两层取严的本意；抬上去会重演 429）。
 *
 * **`DAO_REVIEWER_CAP` 只收紧、不放宽**，而且必须从这里走。它原先在 `dao.mjs` 里是一条
 * 平级分支（`env ? env : resolveReviewerCap(...)`），整段渠道取严被绕过去——
 * 队列实际落在 cap=1 的渠道时 `DAO_REVIEWER_CAP=8` 仍会拉 8 张，造出一批必被渠道闸拒绝的
 * 启动尝试，跟「有限渠道上限始终是最终上界」正面矛盾（#1265 审官判红第 1 条）。
 * 这个逃生口的用途是人手临时**压**并发，不是抬过上游合同——所以它跟前两层一起取严。
 * 接在参数上而不是留在调用方：留在调用方，下一个调用点还会再写一遍那条平级分支。
 *
 * @param cores       本机核数（admission.cores）；读不到传 null
 * @param reviewerIds 本轮实际会用的审官 id（reviewerIdsForCap 的产物）；读不到传 null
 * @param channelOf   审官 id → 有限渠道上限（认不出 / 不限回 null 或 Infinity）
 * @param envCap      人手逃生口（DAO_REVIEWER_CAP 的原文）；非正整数 = 没给，不参与
 * @returns 正整数上限
 */
export function resolveReviewerCap({ cores = null, reviewerIds = null, channelOf = null, envCap = null } = {}) {
  // 一条规则管到底：环境变量到手就是字符串，parseInt 是它一直以来的读法（`2.5` 读成 2，只会更严）。
  // 数字与字符串走同一条，免得同一个值从两个入口进来得出两个上限。
  const env = Number.parseInt(String(envCap ?? ''), 10);
  const byEnv = Number.isInteger(env) && env > 0 ? env : null;
  const resolved = resolveReviewerCapWithoutEnv({ cores, reviewerIds, channelOf });
  // 只收紧：取严之后仍可能被逃生口压得更低，但永远不会被它抬高。
  return byEnv == null ? resolved : Math.min(byEnv, resolved);
}

function resolveReviewerCapWithoutEnv({ cores = null, reviewerIds = null, channelOf = null } = {}) {
  const byMachine = Number.isInteger(cores) && cores > 0 ? cores : null;
  let byChannel = null;
  const ids = Array.isArray(reviewerIds) ? reviewerIds : null;
  if (ids && ids.length > 0 && typeof channelOf === 'function') {
    for (const id of ids) {
      let cap = null;
      try { cap = channelOf(id); } catch { cap = null; }
      // null / Infinity = 「不限」或认不出渠道，不拿它去收紧别人；
      // 只有显式有限值才参与取严（「不限」是用户对这条渠道的已验证结论）。
      if (!Number.isFinite(cap) || cap <= 0) continue;
      byChannel = byChannel === null ? cap : Math.min(byChannel, cap);
    }
  }
  const channelBound = Number.isInteger(byChannel) && byChannel > 0 ? byChannel : null;
  if (channelBound != null) {
    if (Number.isInteger(byMachine) && byMachine > 0) return Math.min(byMachine, channelBound);
    return channelBound;
  }
  if (Number.isInteger(byMachine) && byMachine > 0) return Math.max(REVIEWER_CAP_FLOOR, byMachine);
  return REVIEWER_CAP_FLOOR;
}

/**
 * 票上那位若已不在可用顺位，换成同厂第一个能起的。没依据就不换。
 * 与 planReviewPendingDrain 同一把尺——cap 与 drain 换人必须看同一位审官。
 */
export function effectiveReviewerOf(ticket, usableReviewers) {
  const named = String(ticket?.reviewer ?? '').trim();
  if (!named) return { reviewer: null, switched: false };
  const order = Array.isArray(usableReviewers) ? usableReviewers.map(String) : null;
  if (!order || order.length === 0 || order.includes(named)) {
    return { reviewer: named, switched: false };
  }
  const fam = vendorFamilyOf(named);
  const next = order.find((id) => fam && vendorFamilyOf(id) === fam) || null;
  if (!next) return { reviewer: named, switched: false };
  return { reviewer: next, switched: true, switchedFrom: named };
}

/**
 * 本轮拉取该按哪些审官算渠道约束。
 *
 * 只数票上的 reviewer（或同厂有效 fallback），不数「可用但本轮用不到」的候选。
 * 一个 cap=1 的未使用候选若参与取严，会把 cap=5 的整队拖死。
 */
export function reviewerIdsForCap(tickets, usableReviewers) {
  const ids = [];
  const seen = new Set();
  if (!Array.isArray(tickets)) return ids;
  for (const t of tickets) {
    const picked = effectiveReviewerOf(t, usableReviewers);
    const id = picked.reviewer;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

/**
 * 没传 cap 时的每轮拉取预算，不是上游容量。上游容量走渠道闸 + 负载准入。
 * 旧值 3 来自已退役的 gptpool（2026-09-07：第 4 个 at capacity）。
 * 2026-09-14 实测 grok-4.6 / composer-2.5 短并发 6/6、零容量拒绝；
 * 8 = 实测 6 + 2 余量。DAO_REVIEWER_CAP 仍可覆盖。
 * 生产路径走 resolveReviewerCap，不要拿这个常量当默认上限。
 */
export const DEFAULT_REVIEWER_CAP = 8;

/**
 * 按资源拉取（#1125，2026-09-07 用户拍板）：队列里有多少张不重要，**能同时跑几个审官**才重要。
 *
 * 用户的话：「工人做好不要自己去开 PR 唤起审官，让中间态、看门狗或者帅位去根据资源调度」。
 * 生产端（工人）不该决定消费端并发——工人跑得快是净收益，压它是白扔算力；该管的是拉取这一侧。
 *
 * 这是每轮拉取预算，不是上游容量。上游容量走渠道闸（startSession）和负载准入。
 * gptpool=3 已退役，不要再拿那条死腿的实测当全局硬顶。
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
    // **根本没有这个字段**（真字段是 state/phase，见 mirasim-runtime 的 listSessions 行）。
    // 于是 phase 恒为空串 → 永远命不中终态 → **每一条登记记录都被算成「在役审官」**，
    // 实测 29 条登记数出 28 个在役，上限 3 永久吃满，复审票一张都拉不动。
    //
    // 字段名不再逐处兜底——全仓统一走正典的 sessionStateOf（那一处写明了三套词的优先级）。
    // 逐处写 `a ?? b ?? c` 正是本晚的病：每个消费者各写一份，写漏一处就是一次静默失效。
    const phase = sessionStateOf(s) || '';
    if (!occupiesReviewerSlot({ phase, updatedAt: s.updatedAt, now: Date.now() })) continue;
    // 带死因的那一针已经废了（#1121 同一判据），也不占位——否则残壳会把上限吃满，
    // 带死因的那一针已经废了（#1121 同一判据），也不占位——否则残壳会把上限吃满，
    // 队列永远拉不动，看起来像「一直满载」其实一个都没在跑。
    // 只认「死因」字样，不把任意非空 runDetail 当死——预览/进度字也会写进这一格。
    const detail = typeof s.runDetail === 'string' ? s.runDetail : '';
    if (/\bat capacity\b|Selected model is at capacity/i.test(detail)) continue;
    live.push({ pr: r.pr ?? null, sessionKey: key, phase: phase || null });
  }
  return { ok: true, unscanned: false, count: live.length, live };
}

/**
 * 票 → drain 计划。
 *
 * `usableReviewers`（可选）是「现在起得来的审官顺位」——由调用方从
 * `reviewerSelectOrder` × 执行目录可用性算好传进来（本模块零 IO，不自己读目录）。
 *
 * 传了它，这里才敢动票上的审官：**票上那个起不来时，顺位往后取第一个能起的**，
 * 并把「换了谁、为什么换」原样报出去（`switchedFrom` / `switchWhy`）。
 *
 * 为什么需要这一步（2026-09-14 实咬）：票在**写的那一刻**就把审官写死了
 * （`buildReviewPendingTicket` 的 reviewer 是必填）。那一档后来死了（执行目录
 * `availability=unverified`），新选的审官会被顺位表剔掉，**读票这条路却完全不看它**——
 * 于是每 20 分钟拿同一个必败的模型去起一次，试满 3 次打「卡死/自动化认输」。
 * 现场：#1225 #1216 两张票连续 5 轮没动，drain 报
 * 「execution profile unverified: codex-relay-gpt-5.6-sol」，而指挥官每轮日志里
 * 「审官顺位：剔掉 3 位……gpt-5.6-sol：availability=unverified」写得清清楚楚。
 *
 * 三条底线：
 *   · 票上那个**能用**就一个字都不改（票是事实，不许无端改写）；
 *   · **没给顺位表**（没查成）时一个字都不改——没有依据的换人是猜；
 *   · 顺位**全都不能起**时照旧失败，不许退回到「那就用第一个」（那正是本单要治的病）。
 *
 * 换人只换**同厂**的（2026-09-14 实咬，我自己撞的）：第一版无脑取顺位第一个能起的，
 * 而当前可用顺位是 [luna/gpt, grok-4.6/grok]——于是票上写着 luna 时被换成 grok，
 * 当场被 `assertReviewerSeat` 拒：「审官位只许同厂换顺位」。**读票侧的换人不能越过审官位那条闸**，
 * 它只是「同一位子换个起得来的同厂备选」。顺位里没有同厂备选 ⇒ 不换，照原样失败并如实报，
 * 让 `reviewer-down` 走到帅位面前——那是一条人看得见的出路，猜一个会拒的值不是。
 */
export function planReviewPendingDrain(ticket, { usableReviewers } = {}) {
  if (ticket == null) {
    return { ok: false, unscanned: true, error: '待办没拿到（没查成）' };
  }
  if (typeof ticket !== 'object') {
    return { ok: false, error: '待办不是对象' };
  }
  const pr = String(ticket.pr ?? '').trim();
  const worktree = String(ticket.workerWorktree ?? '').trim();
  if (!pr) return { ok: false, error: '待办缺 pr' };
  const picked = effectiveReviewerOf(ticket, usableReviewers);
  let reviewer = picked.reviewer;
  if (!reviewer) return { ok: false, error: '待办缺 reviewer' };
  let switchedFrom = null;
  let switchWhy = null;
  if (picked.switched) {
    // 只在**同厂**里换：跨厂换人是 assertReviewerSeat 的例外（要有满载/看门狗死因凭证），
    // 读票侧拿不出那个凭证，换出来的值必被拒——换了个必拒的值等于没修。
    switchedFrom = picked.switchedFrom;
    switchWhy = `票上写的审官 ${picked.switchedFrom} 现在起不来（不在可用顺位里），按顺位改用同厂备选 ${reviewer}`;
  }
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
    ...(switchedFrom ? { switchedFrom, switchWhy } : {}),
  };
}

/**
 * 把 reviewer-create 子进程的 spawn 结果收成 attach 回执。
 * 无 JSON / 超时 / 非零退出时，error 必须是完整 stderr/error——这串会进 drain 账当比较键
 * （consumeReviewPending 包一层「reviewer-attach 失败：」之后，applyDrainLedger / foldFailureStreak 逐字比）。
 * 人读摘要截字不在这里做。
 */
export function attachReceiptFromSpawn(spawned = {}) {
  let json = null;
  try { json = JSON.parse(String(spawned.stdout || '').trim().split(/\r?\n/).pop()); } catch { /* 非 JSON */ }
  if (spawned.error || (spawned.status !== 0 && spawned.status != null) || spawned.signal || !json || json.ok !== true) {
    const structured = json && json.error != null && json.error !== '' ? json.error : null;
    const fallback = String(spawned.stderr || spawned.error?.message || `reviewer-attach exit ${spawned.status}`);
    return {
      ok: false,
      error: structured == null ? fallback : (typeof structured === 'string' ? structured : String(structured)),
      json,
    };
  }
  return { ok: true, json };
}

export function consumeReviewPending({ dir, ticket, attach, usableReviewers } = {}) {
  const plan = planReviewPendingDrain(ticket, { usableReviewers });
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

export function drainReviewPending({ dir, tickets, attach, usableReviewers } = {}) {
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
    results.push(consumeReviewPending({ dir, ticket: t, attach, usableReviewers }));
  }
  const failed = results.filter(r => !r.ok);
  // #1239：顶层 error 必须带上**第一张失败票的真因**。
  //
  // 原先只有失败计数，`dao.mjs` 那侧 `fail(drained.error || '未全部成功', drained)`
  // 取不到 error 字符串 → 只能印兜底文案。于是真因（`execution profile unverified:
  // codex-relay-gpt-5.6-sol` 这类）躺在 results[].error 里没人读，日志里只剩一句
  // 「未全部成功」——7 天里 23 次。这是「错误在传递中丢失」，不是「错误没发生」：
  // 读日志的人据此查不出任何东西（#1233 / #1237 的同一族）。
  //
  // 取第一条而非拼接：认输/重试判据只读首行（judgeRetry / exhaustedComment 都取首行），
  // 拼一长串反而会把判据要的那句挤掉。
  const firstError = failed.length ? String(failed[0].error || failed[0].why || '').trim() : '';
  return {
    ok: failed.length === 0,
    unscanned: false,
    scanned: listed.length,
    drained: results.filter(r => r.ok).length,
    failed: failed.length,
    ...(firstError ? { error: failed.length > 1 ? `${firstError}（共 ${failed.length} 张失败）` : firstError } : {}),
    results,
  };
}
