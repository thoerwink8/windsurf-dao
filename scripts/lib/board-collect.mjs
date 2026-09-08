// scripts/lib/board-collect.mjs —— 看板 v0 取数（#818）
//
// 三路：GitHub 开放 issue / 开放 PR、本机派工队列、账本 job.dispatch。
// 每路包成信封 {scanned:true, items} / {scanned:false, error}。
// 一路挂掉只坏自己那几行。零写入。

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fetchIssues, fetchOpenPrs, run as runCmd } from './now-collect.mjs';
import { dispatchOrderPaths, dispatchQueueDir, listDispatchOrders, readDispatchOrder } from './dispatch-queue.mjs';
import { defaultLedgerDir } from './ledger-home.mjs';
import { readLedgerEvents } from './ledger-query.mjs';
import { DEFAULT_WORKER_WALL_HOURS, loadBoardThreshold, renderBoard } from './board-v0.mjs';

function parseJson(text, what) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, error: `${what} 不是 JSON` };
  }
}

export function loadBoardPolicy(root) {
  const file = join(root || '', 'docs', 'dispatch-policy.json');
  if (!root || !existsSync(file)) {
    return { thresholdHours: DEFAULT_WORKER_WALL_HOURS, error: null };
  }
  let src;
  try { src = readFileSync(file, 'utf8'); }
  catch (e) {
    return { thresholdHours: DEFAULT_WORKER_WALL_HOURS, error: `策略读不了：${String(e.message || e).slice(0, 80)}` };
  }
  const p = parseJson(src, 'dispatch-policy');
  if (!p.ok) return { thresholdHours: DEFAULT_WORKER_WALL_HOURS, error: p.error };
  return { thresholdHours: loadBoardThreshold(p.value), error: null, doc: p.value };
}

export function collectQueue({ root, env } = {}) {
  let dir;
  try {
    dir = dispatchQueueDir({ root, env });
  } catch (e) {
    return { scanned: false, error: `队列目录没给：${String(e.message || e)}` };
  }
  const listed = listDispatchOrders(dir, {
    readResult: (p) => {
      try { return JSON.parse(readFileSync(p, 'utf8')); }
      catch { return { ok: true }; }
    },
  });
  if (listed.unscanned || listed.ok === false) {
    return { scanned: false, error: listed.error || '派工队列没查成' };
  }
  const items = [];
  for (const o of listed.orders || []) {
    if (!o || o.status === 'done' || o.status === 'failed') continue;
    let model = o.model || null;
    if (!model && dir && o.id) {
      const read = readDispatchOrder(join(dir, `${o.id}.json`));
      if (read.ok) {
        const args = read.order && read.order.args;
        if (args && args.model) model = String(args.model);
      }
    }
    let runningAt = null;
    if (o.status === 'running' && dir && o.id) {
      const paths = dispatchOrderPaths(dir, o.id);
      try {
        const meta = JSON.parse(readFileSync(paths.running, 'utf8') || '{}');
        if (meta && meta.ts) runningAt = String(meta.ts);
      } catch { /* 读不到就空着，不拿入队时间顶 */ }
    }
    items.push({
      id: o.id,
      ts: o.ts,
      issue: o.issue,
      name: o.name,
      status: o.status,
      model,
      runningAt,
    });
  }
  return { scanned: true, items };
}

export function collectLedger({ home, env } = {}) {
  const { dir } = defaultLedgerDir({ home, env });
  const got = readLedgerEvents(dir);
  if (got.unscanned) return { scanned: false, error: got.error, items: [] };
  const items = (got.events || []).filter((e) => e && e.type === 'job.dispatch');
  return { scanned: true, items };
}

const STAGE_EVENT_CONCURRENCY = 5;

async function mapLimit(items, limit, fn) {
  const ret = new Array(items.length);
  let next = 0;
  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      ret[i] = await fn(items[i], i);
    }
  }
  const n = Math.max(1, Math.min(limit, items.length || 0));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return ret;
}

function parseEventsJson(text) {
  try {
    const v = JSON.parse(text);
    return Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

async function defaultFetchEvents({ cwd, number, kind }) {
  const path = kind === 'pr'
    ? `repos/{owner}/{repo}/issues/${number}/timeline`
    : `repos/{owner}/{repo}/issues/${number}/events`;
  const r = await runCmd('gh', ['api', path, '--paginate'], { cwd });
  if (!r.ok) return null;
  return parseEventsJson(r.out);
}

/**
 * 给已查成的 issue/PR 补阶段事件。一张失败只让那张耗时空着，
 * 不把整路打成没查成（#1108 审官：拿不到起点 ≠ 用开单日顶）。
 */
export async function attachStageEvents(env, { cwd, kind, fetchEvents = defaultFetchEvents } = {}) {
  if (!env || env.scanned !== true || !Array.isArray(env.items) || env.items.length === 0) return env;
  const items = await mapLimit(env.items, STAGE_EVENT_CONCURRENCY, async (it) => {
    const n = it && it.number;
    if (n == null) return it;
    let events;
    try { events = await fetchEvents({ cwd, number: n, kind }); }
    catch { return it; }
    if (!Array.isArray(events)) return it;
    return { ...it, events };
  });
  return { ...env, items };
}

/**
 * GitHub 那两路复用 now-collect；再补阶段事件当墙钟起点。
 * 补字段失败只让耗时空着，不把整路打成没查成。
 */
export async function collectBoardSources({ cwd, root, env, home, now = Date.now() } = {}) {
  const repoRoot = root || cwd;
  const [issuesRaw, prsRaw] = await Promise.all([
    fetchIssues({ cwd: repoRoot }),
    fetchOpenPrs({ cwd: repoRoot }),
  ]);
  const [issues, prs] = await Promise.all([
    attachStageEvents(issuesRaw, { cwd: repoRoot, kind: 'issue' }),
    attachStageEvents(prsRaw, { cwd: repoRoot, kind: 'pr' }),
  ]);
  const queue = collectQueue({ root: repoRoot, env });
  const ledger = collectLedger({ home, env });
  return { issues, prs, queue, ledger, now };
}

export async function collectBoard({ cwd, root, env, home, now = new Date().toISOString() } = {}) {
  const t0 = Date.now();
  const repoRoot = root || cwd;
  const policy = loadBoardPolicy(repoRoot);
  const src = await collectBoardSources({ cwd: repoRoot, root: repoRoot, env, home, now });
  const board = renderBoard({
    now,
    issues: src.issues,
    prs: src.prs,
    queue: src.queue,
    ledger: src.ledger,
    thresholdHours: policy.thresholdHours,
  });
  return { board, elapsedMs: Date.now() - t0, policy };
}

