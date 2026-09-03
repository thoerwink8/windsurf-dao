// scripts/lib/dispatch-queue.mjs —— 派工单队列（2026-08-23 async-launch 拍板）
//
// dispatch 热路只做：参数校验 → 写派工单到 _flow/queue/ → spawn detached 执行体 → 返回（<1s）。
// 消歧门 / 账本查重 / 建卡 / 起终端 / 送字 / 记账全在执行体（dao.mjs dispatch-exec）里。
//
// 一派工单一组文件（同一目录，按 id 归组）：
//   <id>.json      派工单本体（热路写完即不可变）
//   <id>.running   执行体开工标记（pid + ts；结果落盘即删——还在 = 在跑或崩了）
//   <id>.out.json  执行结果（emit 结果槽写；ok:true=已派 / ok:false=拒派或失败回滚）
//   <id>.out.log   执行体 stdio（detached 没有屏面）
//
// 队列目录可被 DAO_DISPATCH_QUEUE_DIR 覆盖（测试隔真仓，同 LEDGER_EVENTS_DIR 的思路）。

import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DISPATCH_DEDUP_WINDOW_MS } from './ledger-query.mjs';

export const DISPATCH_QUEUE_DIR_REL = join('_flow', 'queue');
export const DISPATCH_ORDER_KIND = 'dao-dispatch-order';
export const DISPATCH_ORDER_VERSION = 1;

/** 队列目录：env 覆盖优先（测试），缺省 <root>/_flow/queue。 */
export function dispatchQueueDir({ root, env } = {}) {
  const override = (env || process.env).DAO_DISPATCH_QUEUE_DIR;
  if (override && String(override).trim()) return resolve(root || process.cwd(), String(override));
  if (!root) throw new Error('dispatchQueueDir 要 root（或 DAO_DISPATCH_QUEUE_DIR）');
  return join(root, DISPATCH_QUEUE_DIR_REL);
}

function beijingCompact(d) {
  const bj = new Date(d.getTime() + 8 * 3600000);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${bj.getUTCFullYear()}${p(bj.getUTCMonth() + 1)}${p(bj.getUTCDate())}T${p(bj.getUTCHours())}${p(bj.getUTCMinutes())}${p(bj.getUTCSeconds())}`;
}

export function newDispatchOrderId({ now = new Date(), rand = Math.random } = {}) {
  const d = now instanceof Date ? now : new Date(now);
  const ts = Number.isNaN(d.getTime()) ? beijingCompact(new Date()) : beijingCompact(d);
  const suffix = Math.floor(rand() * 36 ** 4).toString(36).padStart(4, '0');
  return `dq-${ts}-${suffix}`;
}

export function dispatchOrderPaths(dir, id) {
  return {
    dir,
    order: join(dir, `${id}.json`),
    running: join(dir, `${id}.running`),
    result: join(dir, `${id}.out.json`),
    log: join(dir, `${id}.out.log`),
  };
}

/**
 * 写派工单（tmp + rename，读者不会看到写一半的）。dedup 三元组由热路预算好
 * （issue / terminal / name），执行体查重直接读，不用反解 launch 命令。
 */
export function writeDispatchOrder({ dir, id, now = new Date(), args, plan, dedup } = {}) {
  if (!dir) return { ok: false, error: '写派工单没给目录' };
  if (!id) return { ok: false, error: '写派工单没给 id' };
  const paths = dispatchOrderPaths(dir, id);
  const order = {
    kind: DISPATCH_ORDER_KIND,
    v: DISPATCH_ORDER_VERSION,
    id,
    ts: (now instanceof Date ? now : new Date(now)).toISOString(),
    args: args || {},
    plan: plan || {},
    dedup: dedup || {},
  };
  try {
    mkdirSync(dir, { recursive: true });
    const tmp = `${paths.order}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(order, null, 2), 'utf8');
    renameSync(tmp, paths.order);
  } catch (e) {
    return { ok: false, error: `派工单写盘失败：${String(e.message || e)}` };
  }
  return { ok: true, id, order, paths };
}

/** 读派工单。kind 对不上 = 不是派工单（目录里不许有别的 json 单）。 */
export function readDispatchOrder(orderPath) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(orderPath, 'utf8'));
  } catch (e) {
    return { ok: false, error: `派工单读不了 ${orderPath}：${String(e.message || e)}` };
  }
  if (!parsed || parsed.kind !== DISPATCH_ORDER_KIND) {
    return { ok: false, error: `不是派工单（kind 对不上）: ${orderPath}` };
  }
  if (!parsed.id) return { ok: false, error: `派工单缺 id: ${orderPath}` };
  return { ok: true, order: parsed };
}

/**
 * detached 拉起执行体：spawn detached + stdio 进 <id>.out.log（append）+ unref。
 * 父进程（dispatch 热路）退出后执行体照跑。#807：不再传 windowsHide。
 */
export function spawnDispatchExecutor({ scriptPath, orderPath, logPath, cwd, spawnFn = spawn, env } = {}) {
  if (!scriptPath) return { ok: false, error: 'spawn 执行体没给 scriptPath' };
  if (!orderPath) return { ok: false, error: 'spawn 执行体没给 orderPath' };
  let fd;
  try {
    if (logPath) {
      mkdirSync(dirname(logPath), { recursive: true });
      fd = openSync(logPath, 'a');
    }
  } catch (e) {
    return { ok: false, error: `执行体日志开不了 ${logPath}：${String(e?.message || e)}` };
  }
  let child;
  try {
    child = spawnFn(process.execPath, [scriptPath, 'dispatch-exec', '--order', orderPath], {
      cwd: cwd || process.cwd(),
      env: env || process.env,
      detached: true,
      stdio: ['ignore', fd == null ? 'ignore' : fd, fd == null ? 'ignore' : fd],
    });
  } catch (e) {
    if (fd != null) { try { closeSync(fd); } catch { /* 关 fd 失败不盖主错误 */ } }
    return { ok: false, error: `执行体 spawn 失败：${String(e?.message || e)}` };
  }
  if (fd != null) { try { closeSync(fd); } catch { /* 子进程已持有 dup 后的句柄 */ } }
  if (!child || !child.pid) return { ok: false, error: '执行体 spawn 没给出 pid' };
  if (typeof child.unref === 'function') child.unref();
  return { ok: true, pid: child.pid };
}

/** 单状态派生：有结果文件 → done/failed；有 running 标记 → running；否则 pending。 */
export function dispatchOrderStatus(dir, id, { readResult } = {}) {
  const paths = dispatchOrderPaths(dir, id);
  if (existsSync(paths.result)) {
    if (typeof readResult === 'function') {
      try {
        const r = readResult(paths.result);
        return r && r.ok === false ? 'failed' : 'done';
      } catch {
        return 'done'; // 结果文件读不动 ≠ 没跑完；按 done 不拦重派前的「在途」语义交账本查重
      }
    }
    return 'done';
  }
  if (existsSync(paths.running)) return 'running';
  return 'pending';
}

/** 列队列里的派工单（只看 <id>.json 本体；.out.json/.running/.log 是随单文件）。 */
export function listDispatchOrders(dir, { readResult } = {}) {
  if (!dir || !existsSync(dir)) return { ok: true, unscanned: false, orders: [] };
  let names;
  try {
    names = readdirSync(dir);
  } catch (e) {
    return { ok: false, unscanned: true, error: `派工队列目录读不了：${String(e.message || e)}`, orders: [] };
  }
  const orders = [];
  for (const name of names) {
    // 随单文件（.out.json 结果 / .running 标记 / .out.log 日志）不是派工单本体。
    if (!/^dq-.+\.json$/.test(name) || name.endsWith('.out.json')) continue;
    const read = readDispatchOrder(join(dir, name));
    if (!read.ok) return { ok: false, unscanned: true, error: read.error, orders };
    const o = read.order;
    orders.push({
      id: o.id,
      ts: o.ts || null,
      issue: o.dedup?.issue ?? null,
      terminal: o.dedup?.terminal ?? null,
      name: o.dedup?.name ?? null,
      status: dispatchOrderStatus(dir, o.id, { readResult }),
    });
  }
  orders.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  return { ok: true, unscanned: false, orders };
}

/**
 * 队列内查重（async-launch 后 #759 防重复建卡的第二道）：账本 job.dispatch 要等执行体
 * 送字成功才落，两单间隔几秒时账本还看不见第一单——但派工单是热路同步写的，第二单的
 * 执行体一定能看见。pending/running/done 的在窗同 issue（无 issue 时同终端+同卡名）单 → 命中；
 * failed 单不拦（没派成，重派合法）。三态同 recentDispatchDup。
 */
export function recentQueueDup(orders, { issue, terminal, name, withinMs = DISPATCH_DEDUP_WINDOW_MS, now, selfId } = {}) {
  if (!Array.isArray(orders)) {
    return { ok: false, unscanned: true, error: '没给派工单数组（没查成）' };
  }
  const nowMs = now == null ? Date.now() : (now instanceof Date ? now.getTime() : Date.parse(now));
  if (!Number.isFinite(nowMs)) {
    return { ok: false, unscanned: true, error: `now 非法（没查成）: ${now}` };
  }
  const windowMs = Math.max(0, Number(withinMs) || 0);
  const since = nowMs - windowMs;
  const wantIssue = issue != null && String(issue).trim() !== '';
  const wantName = name != null && String(name).trim() !== '';
  const hits = [];
  let skippedBadTs = 0;
  for (const o of orders) {
    if (!o || !o.id || o.id === selfId) continue;
    if (o.status === 'failed') continue;
    const t = Date.parse(o.ts || '');
    if (!Number.isFinite(t)) { skippedBadTs += 1; continue; }
    if (t < since || t > nowMs + 60000) continue;
    const issueHit = wantIssue && o.issue != null && String(o.issue) === String(issue).trim();
    const termHit = !wantIssue && terminal && wantName && o.terminal === terminal && o.name === name;
    if (issueHit || termHit) hits.push(o);
  }
  const base = { windowMs, ...(skippedBadTs ? { skippedBadTs } : {}) };
  if (hits.length === 0) return { ok: true, clear: true, hit: null, ...base };
  const latest = hits[hits.length - 1];
  return {
    ok: true,
    clear: false,
    hits: hits.length,
    hit: { order_id: latest.id, ts: latest.ts, status: latest.status, issue: latest.issue, name: latest.name },
    ...base,
  };
}
