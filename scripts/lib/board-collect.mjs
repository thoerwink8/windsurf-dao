// scripts/lib/board-collect.mjs —— 看板 v0 取数（#818）
//
// 三路：GitHub 开放 issue / 开放 PR、本机派工队列、账本 job.dispatch。
// 每路包成信封 {scanned:true, items} / {scanned:false, error}。
// 一路挂掉只坏自己那几行。零写入。

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fetchIssues, fetchOpenPrs } from './now-collect.mjs';
import { dispatchQueueDir, listDispatchOrders, readDispatchOrder } from './dispatch-queue.mjs';
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
    items.push({
      id: o.id,
      ts: o.ts,
      issue: o.issue,
      name: o.name,
      status: o.status,
      model,
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

/**
 * GitHub 那两路复用 now-collect；issue/PR 补 createdAt（墙钟起点）。
 * 补字段失败只让耗时空着，不把整路打成没查成。
 */
export async function collectBoardSources({ cwd, root, env, home, now = Date.now() } = {}) {
  const repoRoot = root || cwd;
  const [issues, prs] = await Promise.all([
    fetchIssues({ cwd: repoRoot }),
    fetchOpenPrs({ cwd: repoRoot }),
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

