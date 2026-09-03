// scripts/lib/dispatch/liveness.mjs —— 活性域（#762 拆分）
//
// 改这段前必须知道：process 文件（state.json / .pi / .lease / sessions）与
// 工作文件的时间戳分开统计。fake-alive = 进程文件还在动但工作文件不动。

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DEFAULT_PROCESS_ALIVE_MS, DEFAULT_THINK_GRACE_MS } from './constants.mjs';

const SKIP_DIRS = new Set([
  '.git', 'node_modules', '_flow', '_tmp', '_scratch', '.codegraph',
  '__pycache__', 'derived', '.playwright-mcp',
]);

export function isProcessFile(rel) {
  const n = String(rel || '').replace(/\\/g, '/').toLowerCase();
  if (n === 'state.json' || n.endsWith('/state.json')) return true;
  if (n === '.pi' || n.startsWith('.pi/') || n.includes('/.pi/')) return true;
  if (n.endsWith('.lease')) return true;
  if (/(^|\/)sessions?(\/|$)/.test(n)) return true;
  return false;
}

export function isWorkFile(rel) {
  const n = String(rel || '').replace(/\\/g, '/');
  if (!n || n.endsWith('/')) return false;
  if (isProcessFile(n)) return false;
  return true;
}

export function scanWorktreeTimes(root) {
  if (!root || !existsSync(root)) throw new Error(`工作树不在: ${root}`);
  let processNewestMtime = 0;
  let processStartedMs = Infinity;
  let workNewestMtime = 0;
  const walk = (dir) => {
    let ents;
    try { ents = readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    for (const ent of ents) {
      if (SKIP_DIRS.has(ent.name)) continue;
      const full = join(dir, ent.name);
      const rel = relative(root, full);
      if (ent.isDirectory()) { walk(full); continue; }
      if (!ent.isFile()) continue;
      let st;
      try { st = statSync(full); } catch { continue; }
      if (isProcessFile(rel)) {
        processNewestMtime = Math.max(processNewestMtime, st.mtimeMs);
        const birth = st.birthtimeMs > 0 ? st.birthtimeMs : st.mtimeMs;
        processStartedMs = Math.min(processStartedMs, birth);
      } else if (isWorkFile(rel)) {
        workNewestMtime = Math.max(workNewestMtime, st.mtimeMs);
      }
    }
  };
  walk(root);
  return {
    processNewestMtime,
    processStartedMs: Number.isFinite(processStartedMs) ? processStartedMs : 0,
    workNewestMtime,
  };
}

export function readGitTimes(cwd) {
  const log = spawnSync('git', ['log', '-1', '--format=%ct'], { cwd, encoding: 'utf8' });
  if (log.error || log.status !== 0) {
    throw new Error(`git log 失败: ${String(log.stderr || log.error?.message || `exit ${log.status}`).trim()}`);
  }
  const status = spawnSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' });
  if (status.error || status.status !== 0) {
    throw new Error(`git status 失败: ${String(status.stderr || status.error?.message || `exit ${status.status}`).trim()}`);
  }
  const gitHeadMs = Number(String(log.stdout || '').trim()) * 1000;
  if (!Number.isFinite(gitHeadMs) || gitHeadMs <= 0) throw new Error('git log 没给出提交时间');
  return { gitHeadMs, gitDirty: String(status.stdout || '').trim().length > 0 };
}

export function assessLiveness({
  now = Date.now(),
  processNewestMtime = 0,
  processStartedMs = 0,
  workNewestMtime = 0,
  gitHeadMs = 0,
  gitDirty = false,
  thinkGraceMs = DEFAULT_THINK_GRACE_MS,
  processAliveMs = DEFAULT_PROCESS_ALIVE_MS,
} = {}) {
  const processAlive = processNewestMtime > 0 && (now - processNewestMtime) <= processAliveMs;
  const hasRecentWork = workNewestMtime > 0 && (now - workNewestMtime) <= thinkGraceMs;
  const hasWorkSinceCommit = gitHeadMs > 0 && workNewestMtime > gitHeadMs + 2000;
  const hasOutput = hasRecentWork || (gitDirty && hasWorkSinceCommit);
  const started = processStartedMs > 0 ? processStartedMs : processNewestMtime;
  const aliveFor = started > 0 ? now - started : 0;

  if (hasOutput) return { verdict: 'working', processAlive, hasOutput: true, aliveFor };
  if (processAlive && aliveFor < thinkGraceMs) return { verdict: 'thinking', processAlive, hasOutput: false, aliveFor };
  if (processAlive && aliveFor >= thinkGraceMs) return { verdict: 'fake-alive', processAlive, hasOutput: false, aliveFor };
  return { verdict: 'dead', processAlive: false, hasOutput: false, aliveFor };
}

export function assessWorktreeLiveness(root, opts = {}) {
  const times = scanWorktreeTimes(root);
  const git = readGitTimes(root);
  return { ...assessLiveness({ now: opts.now ?? Date.now(), ...times, ...git, ...opts }), ...times, ...git };
}
