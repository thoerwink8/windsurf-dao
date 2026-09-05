#!/usr/bin/env node
// scripts/board-gc.mjs —— 僵尸卡自动发现 + 自动清理
//
// 用户 2026-09-05：「把剩下的僵尸卡都判断一下是否不需要，然后将其处理掉，
// 并且需要建立一个能够自动清理的机制自动去发现，自动去清理」。
//
// 判据全在 scripts/lib/board-gc.mjs（纯函数、可测）。本文件只负责三件事：
// 采事实（orca / gh / git）、把事实喂给判据、按判决调 dao.mjs worktree-rm。
//
// 与 board-reset 的分工：board-reset 是「重测前一锅端」（所有非主树顶层卡）；
// 本命令是它的反面——**只清确实不需要的那几张**，其余一张不动。
//
// 用法：
//   node scripts/board-gc.mjs                 只列判决，不动盘面
//   node scripts/board-gc.mjs --apply         真删（逐卡整树，复用 worktree-rm 的占用闸与账本孤本闸）
//   node scripts/board-gc.mjs --say           把判决播一条进总控群
//
// 退出码：0 判完（清了或没得清） / 1 有 risky 要人判 / 2 没查成（一张都没动）。

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planBoardGc, formatBoardGc } from './lib/board-gc.mjs';
import {
  DEFAULT_SILENCE_MS, scanLiveness, applyProgressMemory, assessLiveness,
  sessionFromOrcaTerminal,
} from './lib/liveness.mjs';

const HERE = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(HERE), '..');
const DAO = join(ROOT, 'scripts', 'dao.mjs');

function parseArgs(argv) {
  const out = { apply: false, say: false, json: false };
  for (const a of argv) {
    if (a === '--apply') out.apply = true;
    else if (a === '--say') out.say = true;
    else if (a === '--json') out.json = true;
  }
  return out;
}

function run(cmd, args, { timeout = 60000 } = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout, windowsHide: true, maxBuffer: 64 << 20 });
  return { code: r.status, out: String(r.stdout || ''), err: String(r.stderr || ''), failed: !!r.error };
}

function orcaJson(args) {
  const bin = process.env.BOARD_GC_ORCA || 'orca';
  const r = process.env.BOARD_GC_ORCA
    ? run(process.execPath, [bin, ...args, '--json'])
    : run(bin, [...args, '--json']);
  const i = r.out.indexOf('{');
  if (i < 0) return { ok: false, error: `没有 JSON（exit=${r.code}）${r.err.trim().slice(0, 160)}` };
  try { return { ok: true, json: JSON.parse(r.out.slice(i)) }; }
  catch (e) { return { ok: false, error: `JSON 解析失败：${e.message}` }; }
}

/** 一次 gh 调用把所有 PR 状态拿全。拿不全就整体判没查成，不逐个猜。 */
function fetchPrState() {
  const r = run(process.execPath, [join(ROOT, 'scripts', 'gh-as.mjs'), 'marshal',
    'pr', 'list', '--state', 'all', '--limit', '200', '--json', 'number,state']);
  if (r.failed || r.code !== 0) return { ok: false, error: `gh pr list 失败：${r.err.trim().slice(0, 160)}` };
  try {
    const list = JSON.parse(r.out);
    if (!Array.isArray(list)) return { ok: false, error: 'gh pr list 契约变了（不是数组）' };
    const map = new Map(list.map((p) => [Number(p.number), String(p.state || '')]));
    return { ok: true, map };
  } catch (e) { return { ok: false, error: `gh pr list JSON 解析失败：${e.message}` }; }
}

/** 每棵树问三句：分支在不在远端、相对 master 超前几个提交、有几个脏文件。任一句问不出就不记。 */
function fetchBranchState(worktrees) {
  const map = new Map();
  for (const w of worktrees) {
    const p = w && w.path;
    const branch = String(w?.branch || '').replace(/^refs\/heads\//, '');
    if (!p || !branch) continue;
    const g = (args) => run('git', ['-C', p, ...args], { timeout: 20000 });
    const remote = g(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`]);
    const ahead = g(['rev-list', '--count', 'origin/master..HEAD']);
    const dirty = g(['status', '--porcelain']);
    if (ahead.code !== 0 || dirty.code !== 0) continue; // 问不出就不记 → 判据侧会判「没查成」
    // 这支到底给 master 添了东西没有：合一次看树变不变。比提交号可靠——
    // 分支被 rebase 或重做过，patch-id 就变了，git cherry 会给出假的「未合入」（2026-09-05 实测三支全假）。
    // 合不干净（有冲突）时留 null：判不了就是判不了，判据侧会转 risky。
    let contributes = null;
    const mt = g(['merge-tree', '--write-tree', 'origin/master', 'HEAD']);
    if (mt.code === 0) {
      const masterTree = g(['rev-parse', 'origin/master^{tree}']);
      if (masterTree.code === 0) contributes = mt.out.trim().split('\n')[0].trim() !== masterTree.out.trim();
    }
    map.set(branch, {
      onRemote: remote.code === 0 && remote.out.trim().length > 0,
      ahead: Number(ahead.out.trim()) || 0,
      dirty: dirty.out.trim() ? dirty.out.trim().split('\n').length : 0,
      contributes,
    });
  }
  return map;
}

function say(text) {
  const fake = process.env.BOARD_GC_SAY;
  if (fake) { run(process.execPath, [fake, text]); return; }
  const r = run('hub-say', [text]);
  if (r.failed) run(process.execPath, ['/home/orca/bin/hub-say', text]);
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  const ps = orcaJson(['worktree', 'list']);
  if (!ps.ok) { console.error(`盘面没查成：${ps.error}`); process.exit(2); }
  const worktrees = ps.json?.result?.worktrees;
  if (!Array.isArray(worktrees)) { console.error('盘面没查成：result.worktrees 不是数组'); process.exit(2); }

  const tm = orcaJson(['terminal', 'list']);
  if (!tm.ok) { console.error(`终端没查成：${tm.error}`); process.exit(2); }
  const terminals = tm.json?.result?.terminals;
  if (!Array.isArray(terminals)) { console.error('终端没查成：result.terminals 不是数组'); process.exit(2); }

  // 活性用同一把尺（liveness.mjs），本文件不另写判据。
  // 屏面签名账本与 agent-stall-watch 分开存：两条命令各自的采样节奏不同，混用会互相把 since 洗掉。
  const sessions = terminals.map((t) => sessionFromOrcaTerminal(t)).filter(Boolean);
  const statePath = process.env.BOARD_GC_STATE
    || join(process.env.HOME || process.env.USERPROFILE || '.', '.dao', 'board-gc-progress.json');
  let memory = {};
  try { memory = JSON.parse(readFileSync(statePath, 'utf8')) || {}; } catch { memory = {}; }
  const progressed = applyProgressMemory({ sessions, memory });
  try {
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, JSON.stringify(progressed.memory, null, 2));
  } catch { /* 账本写不下只影响下一轮精度，不该拦住本轮判决 */ }

  // 阈值可按机器调；给了读不出数的值就用默认并说一声，不静默失效。
  const raw = process.env.BOARD_GC_SILENCE_MIN;
  let thresholdMs = DEFAULT_SILENCE_MS;
  if (raw != null && raw !== '') {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) thresholdMs = n * 60000;
    else console.error(`BOARD_GC_SILENCE_MIN=${raw} 读不出分钟数，用默认 ${DEFAULT_SILENCE_MS / 60000} 分钟`);
  }
  const live = scanLiveness({ sessions: progressed.sessions, thresholdMs });
  if (!live.ok) { console.error(`活性没查成：${live.error}`); process.exit(2); }
  // 「活着」= 判据说 active。silent / unscanned / done 都不算活着——
  // 特别是 done：干完的会话不该让它那张卡永远免死。
  const alive = new Set();
  for (const s2 of progressed.sessions) {
    if (!s2.worktreeId) continue;
    if (assessLiveness(s2, { thresholdMs }).state === 'active') alive.add(s2.worktreeId);
  }

  const prs = fetchPrState();
  if (!prs.ok) { console.error(`PR 状态没查成：${prs.error}`); process.exit(2); }

  const plan = planBoardGc({
    worktrees,
    aliveWorktreeIds: alive,
    prState: prs.map,
    branchState: fetchBranchState(worktrees),
  });

  if (args.json) { console.log(JSON.stringify(plan, null, 2)); }
  else console.log(formatBoardGc(plan, { apply: args.apply }));

  if (!plan.ok) process.exit(2);

  if (args.apply) {
    for (const z of plan.zombies) {
      const r = run(process.execPath, [DAO, 'worktree-rm', '--worktree', z.id], { timeout: 180000 });
      console.log(`${r.code === 0 ? '已清' : '清不掉'} ${z.name}${r.code === 0 ? '' : '：' + (r.err.trim() || r.out.trim()).slice(0, 200)}`);
    }
  }

  if (args.say) {
    const head = `盘面清理：僵尸 ${plan.zombies.length} 张${args.apply ? '（已清）' : '（只列未清）'}`
      + `，要人判 ${plan.risky.length} 张，没查成 ${plan.unscanned.length} 张`;
    const detail = plan.risky.length
      ? '\n要人判：\n· ' + plan.risky.map((r) => `${r.name}｜${r.why}`).join('\n· ')
      : '';
    if (plan.zombies.length || plan.risky.length) say(head + detail);
  }

  process.exit(plan.risky.length ? 1 : 0);
}

main();
