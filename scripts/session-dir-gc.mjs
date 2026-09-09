#!/usr/bin/env node
// scripts/session-dir-gc.mjs —— 会话目录对账清理（#1176）
//
// 判据全在 scripts/lib/session-dir-gc.mjs（纯函数、可测）。本文件只做三件事：
// 采事实（会话目录 / 进程面 / GitHub 盘面）、喂给判据、按判决归档。
//
// 与 board-gc 的分工见 lib/session-dir-gc.mjs 顶部。一句话：board-gc 管卡，本命令管会话目录本体。
//
// 用法：
//   node scripts/session-dir-gc.mjs              只列判决，一个文件都不动
//   node scripts/session-dir-gc.mjs --apply      真归档到 ~/.mirasim/sessions-archive
//   node scripts/session-dir-gc.mjs --purge      连归档区一起删（归档区超 7 天的）
//
// 退出码：0 判完 / 2 没查成（一个都没动）
//
// 为什么是归档不是直删：2026-09-10 首次清理 1563 个目录，当时无法确认服务端是否还引用它们。
// 归档=同盘 rename，秒级完成、随时可捞回。确认无碍后再由 --purge 收走。

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { planSessionGc, planOrphanGc, DEFAULT_KEEP_HOURS } from './lib/session-dir-gc.mjs';

const HOME = process.env.DAO_GC_HOME || homedir();
const SESSIONS = join(HOME, '.mirasim', 'sessions');
const ARCHIVE = join(HOME, '.mirasim', 'sessions-archive');
const CODEX_TMP = join(HOME, '.codex', '.tmp');
const KEEP_HOURS = Number(process.env.DAO_GC_KEEP_HOURS || DEFAULT_KEEP_HOURS);
const REPO = process.env.DAO_GC_REPO || 'thoerwink8/windsurf-dao';

const apply = process.argv.includes('--apply');
const purge = process.argv.includes('--purge');

/** 活进程集合：哪些会话目录下还挂着真进程。认不出就当成「有」，宁可漏清不可误删。 */
function livePids() {
  const live = new Set();
  try {
    const out = execFileSync('/bin/ps', ['-eo', 'args'], { encoding: 'utf8', timeout: 10000, windowsHide: true });
    for (const line of out.split('\n')) {
      const m = line.match(/\.mirasim\/sessions\/[a-z]+\/([0-9a-f-]{16,})/i);
      if (m) live.add(m[1]);
      const w = line.match(/mirasim-worktrees\/[^\s]*/);
      if (w) live.add(w[0]);
    }
  } catch { /* ps 读不到就是空集——下面按 alive=false 走，但时效闸仍在 */ }
  return live;
}

/** 采会话目录。每个 <agent>/<uuid>/record.json 一条。 */
function scanSessions(liveSet) {
  if (!existsSync(SESSIONS)) return null;
  let agents;
  try { agents = readdirSync(SESSIONS).filter((a) => statSync(join(SESSIONS, a)).isDirectory()); } catch { return null; }
  const out = [];
  for (const agent of agents) {
    const dir = join(SESSIONS, agent);
    let ids = [];
    try { ids = readdirSync(dir); } catch { continue; }
    for (const id of ids) {
      const sessDir = join(dir, id);
      let record = null;
      try { record = JSON.parse(readFileSync(join(sessDir, 'record.json'), 'utf8')); } catch { /* 坏记录也要进清单，交判据处理 */ }
      const updatedAtMs = Date.parse(record?.updatedAt || record?.createdAt || '');
      const alive = Boolean(record?.runPid) || liveSet.has(id)
        || (record?.workdir ? [...liveSet].some((k) => typeof k === 'string' && k === record.workdir) : false);
      out.push({ id, agent, dir: sessDir, alive, updatedAtMs, record: record || {} });
    }
  }
  return out;
}

/** 拉盘面上的关闭状态。查不成返回 null——判据据此 fail-closed。 */
function scanClosedRefs(refs) {
  if (refs.size === 0) return new Set();
  const closed = new Set();
  const list = [...refs];
  for (const n of list) {
    try {
      const out = execFileSync(process.execPath,
        [join(import.meta.dirname, 'gh-as.mjs'), 'marshal', '--', 'api', `repos/${REPO}/issues/${n}`],
        { encoding: 'utf8', timeout: 20000, windowsHide: true });
      const state = JSON.parse(out)?.state;
      if (state === 'closed') closed.add(n);
      else if (state !== 'open') return null; // 认不出状态 = 没查成
    } catch {
      return null; // 一条查不成就整轮 fail-closed，不许半份盘面当全份
    }
  }
  return closed;
}

function scanOrphans() {
  if (!existsSync(CODEX_TMP)) return [];
  try {
    return readdirSync(CODEX_TMP).filter((n) => n.startsWith('git-')).map((n) => {
      const p = join(CODEX_TMP, n);
      let mtimeMs = NaN;
      try { mtimeMs = statSync(p).mtimeMs; } catch { /* 读不到就 NaN，判据会留着 */ }
      return { path: p, mtimeMs };
    });
  } catch { return []; }
}

const liveSet = livePids();
const sessions = scanSessions(liveSet);
if (sessions === null) {
  console.error('会话根目录读不到——没查成，一个都不动');
  process.exit(2);
}

const allRefs = new Set();
for (const s of sessions) {
  for (const r of (await import('./lib/session-dir-gc.mjs')).refsOf(s.record)) allRefs.add(r);
}
const closedRefs = scanClosedRefs(allRefs);
const boardScanned = closedRefs !== null;

const plan = planSessionGc({ sessions, closedRefs: closedRefs || new Set(), boardScanned, keepHours: KEEP_HOURS });
console.log(plan.detail);
if (!boardScanned) console.log('  ⚠ GitHub 盘面没查成，本轮只按时效清（fail-closed）');

const orphans = planOrphanGc({ entries: scanOrphans() });
console.log(orphans.detail);

if (!apply && !purge) {
  console.log('\n[dry-run] 未移动任何文件。加 --apply 执行。');
  process.exit(plan.state === 'unknown' ? 2 : 0);
}

let archived = 0;
for (const s of plan.remove) {
  try {
    const dest = join(ARCHIVE, s.agent);
    if (!existsSync(dest)) mkdirSync(dest, { recursive: true });
    renameSync(s.dir, join(dest, s.id));
    archived++;
  } catch (e) { console.error(`归档失败 ${s.id}: ${e.message}`); }
}
let orphaned = 0;
for (const o of orphans.remove) {
  try { rmSync(o.path, { recursive: true, force: true }); orphaned++; } catch { /* 删不掉下轮再来 */ }
}
console.log(`\n已归档会话 ${archived} 个，清理临时目录 ${orphaned} 个`);

if (purge) {
  let purged = 0;
  const cutoff = Date.now() - 7 * 24 * 3600000;
  try {
    for (const agent of readdirSync(ARCHIVE)) {
      const dir = join(ARCHIVE, agent);
      for (const id of readdirSync(dir)) {
        const p = join(dir, id);
        try { if (statSync(p).mtimeMs < cutoff) { rmSync(p, { recursive: true, force: true }); purged++; } } catch { /* 跳过 */ }
      }
    }
  } catch { /* 归档区不存在 */ }
  console.log(`归档区清走 ${purged} 个（超 7 天）`);
}
