#!/usr/bin/env node
// 推一把卡住的工人。**垫片**——正式的家是 issue #1056 的对账循环，合并时本脚本退役。
//
// 正路做不到「往旧会话说话」：interact 只答会话里等着的问题，塞不进等下一轮的嘴里，
// 所以本垫片只能起新会话。闸的意思是：**人退了才起新的**；已关 issue / 已合 PR /
// 人还在（租约 held）/ 树不在该单 PR head 上，一律不推。
// 2026-09-07 实锤：没这三道闸时一次推了 6 棵（含已关 #1012/#1007、停在 master 的 #1063），
// 同一晚 #1007 被推过 18 次。判据在 scripts/lib/nudge-stalled.mjs，本文件只接线。
// #1056 对账循环合并时本垫片整套退役，在那之前这三道闸就是正门。
//
// 为什么需要它：盘面上会一直挂着「某某静默 N 分钟」，却没有任何东西让它继续——
// 发现和处置之间断了一截。（原文这里指的是 agent-stall-watch 的 escalate 只报帅不动手；
// 那一层 2026-09-06 已整层删除，见 chain:agent-stall#7。今天的发现面是
// scripts/progress-watch.mjs 的盘面推进量，同样只叫醒帅位、不动手，缺口没变。）
//
// 探测面不自己造：卡死清单从 mirasim 落盘的 record.json 直接读（它是会话的所有者）。
// 这也是屏面指纹层删掉之后**会话级**判卡的唯一去处——progress-watch 看的是盘面对象
// （PR / issue / 复审票），看不见「某个会话跑完一轮在等话」。两个面互补，别合并。
//
//   node scripts/nudge-stalled.mjs                  列出卡住的派工树，不动手
//   node scripts/nudge-stalled.mjs --go             逐个推一把（过闸才起新会话）
//   node scripts/nudge-stalled.mjs --go --only 1056 只推一个

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createRuntime } from './lib/mirasim-runtime.mjs';
import { ghAs } from './lib/gh.mjs';
import { checkTreeLease } from './lib/dispatch/lease.mjs';
import { runNudge } from './lib/nudge-stalled.mjs';

const argv = process.argv.slice(2);
const GO = argv.includes('--go');
const only = argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : null;
const SESSIONS = '/home/orca/.mirasim/sessions';

const CONTINUE = [
  '继续。你上一轮跑完就停在那儿等指令了，任务没做完——接着做，别重新开始。',
  '先说一句你现在做到哪、下一步动哪个文件，然后直接动手。',
  '做完照任务书交卷（提交 + 推分支 + PR 正文写验收）。',
].join('\n');

// 审官的活是「判」不是「写」，交卷方式也不同，所以不能给它上面那套话。
// 上一轮多半是撞上游满载中断的（Selected model is at capacity），不是它判完了。
const REVIEW_CONTINUE = [
  '继续审。你上一轮没跑完就中断了（多半是上游满载），审查还没交卷——接着审，别重新开始。',
  '先说一句你已经看过哪些文件、还剩什么没看，然后接着看。',
  '判完照审官任务书交卷：逐条给判定，判绿或判红都要落到 PR review 上，别只在会话里说。',
].join('\n');

function readRecords(root) {
  let agents;
  try {
    agents = readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
  } catch (e) {
    console.error(`[推一把] 会话档案读不了 ${root}：${String(e.message || e)}——没查成，不动手`);
    process.exit(2);
  }
  const out = [];
  let seen = 0;
  for (const agent of agents) {
    let ids = [];
    try { ids = readdirSync(join(root, agent), { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name); } catch { continue; }
    for (const id of ids) {
      seen += 1;
      try { out.push({ agent, ...JSON.parse(readFileSync(join(root, agent, id, 'record.json'), 'utf8')) }); } catch { /* 还没落盘 */ }
    }
  }
  // 「扫完是 0」和「没扫到」必须分得开，否则会把没查成当成「没有卡死的」。
  if (seen === 0) {
    console.error(`[推一把] ${root} 下一个会话目录都没扫到——不是「没有工人」，是没扫成`);
    process.exit(2);
  }
  return out;
}

function ghJson(args, what) {
  let lastErr = `${what} 没查成`;
  for (const role of ['worker', 'watchdog']) {
    const r = ghAs(role, args);
    if (!r.ok) {
      lastErr = r.error || `${role} ${what} 失败`;
      continue;
    }
    try {
      return { ok: true, value: JSON.parse(r.out || '') };
    } catch (e) {
      return { ok: false, error: `${what} 不是 JSON：${String(e.message).slice(0, 80)}` };
    }
  }
  return { ok: false, error: lastErr };
}

const issueCache = new Map();
const reviewerPrCache = new Map();
let allPrsCache = null;

function lookupIssue(n) {
  const k = String(n);
  if (issueCache.has(k)) return issueCache.get(k);
  const got = ghJson(['issue', 'view', k, '--json', 'state'], `issue #${k}`);
  const out = !got.ok
    ? { ok: false, error: got.error }
    : (got.value && got.value.state != null)
      ? { ok: true, state: got.value.state }
      : { ok: false, error: `issue #${k} 没读到 state（没查成）` };
  issueCache.set(k, out);
  return out;
}

function loadAllPrs() {
  if (allPrsCache) return allPrsCache;
  const got = ghJson(
    ['pr', 'list', '--state', 'all', '--limit', '100', '--json', 'number,title,body,state,headRefName'],
    'PR 面',
  );
  allPrsCache = !got.ok
    ? { ok: false, error: got.error }
    : Array.isArray(got.value)
      ? { ok: true, items: got.value }
      : { ok: false, error: 'PR 面不是数组（没查成）' };
  return allPrsCache;
}

function lookupPrs(id) {
  if (id.kind === '审官') {
    const k = String(id.n);
    if (reviewerPrCache.has(k)) return reviewerPrCache.get(k);
    const got = ghJson(
      ['pr', 'view', k, '--json', 'number,state,headRefName,title,body'],
      `PR #${k}`,
    );
    const out = !got.ok
      ? { ok: false, error: got.error }
      : (got.value && got.value.number != null)
        ? { ok: true, items: [got.value] }
        : { ok: false, error: `PR #${k} 没读到（没查成）` };
    reviewerPrCache.set(k, out);
    return out;
  }
  return loadAllPrs();
}

function readBranch(workdir) {
  const r = spawnSync('git', ['-C', workdir, 'rev-parse', '--abbrev-ref', 'HEAD'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10000,
  });
  if (r.error || r.status !== 0) {
    return {
      ok: false,
      error: String(r.error?.message || r.stderr || `git exit ${r.status}`).trim().slice(0, 160),
    };
  }
  const name = String(r.stdout || '').trim();
  if (!name) return { ok: false, error: 'git 没给出分支名（没查成）' };
  return { ok: true, name };
}

function checkLease(workdir) {
  return checkTreeLease({ workdir });
}

let runtime = null;
async function startSession(args) {
  if (!runtime) runtime = createRuntime({ homeDir: '/home/orca' });
  return runtime.startSession(args);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const records = readRecords(SESSIONS);
  const out = await runNudge({
    go: GO,
    only,
    records,
    exists: existsSync,
    lookupIssue,
    lookupPrs,
    readBranch,
    checkLease,
    startSession,
    workerPrompt: CONTINUE,
    reviewPrompt: REVIEW_CONTINUE,
    log: (s) => console.log(s),
    error: (s) => console.error(s),
  });
  // 没查成要在 systemctl --failed 里看得见，不许跟「没有卡住的 / 全跳过」长成一个样。
  if (out.unscanned.length) process.exit(2);
}
