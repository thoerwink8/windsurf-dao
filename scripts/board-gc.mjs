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
//   node scripts/board-gc.mjs                 只列判决，不动盘面（一个 git 写动作都没有）
//   node scripts/board-gc.mjs --apply         先推 salvage 备份再真删（逐卡整树，复用 worktree-rm 的占用闸与账本孤本闸）
//   node scripts/board-gc.mjs --say           把判决播一条进总控群
//
// 退出码：0 判完（清了或没得清） / 1 有 risky 要人判 / 2 没查成（一张都没动）。

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planBoardGc, formatBoardGc, planSalvage, applySalvage } from './lib/board-gc.mjs';
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

/** issue 号 → OPEN/CLOSED。问不出来就整张表不给，判据自动不启用（没查成 ≠ 已关闭）。 */
function fetchIssueState() {
  const r = run(process.execPath, [join(ROOT, 'scripts', 'gh-as.mjs'), 'marshal',
    'issue', 'list', '--state', 'all', '--limit', '300', '--json', 'number,state']);
  if (r.failed || r.code !== 0) return null;
  try {
    const list = JSON.parse(r.out);
    if (!Array.isArray(list)) return null;
    return new Map(list.map((i) => [Number(i.number), String(i.state || '').toUpperCase()]));
  } catch { return null; }
}

/**
 * PR 号 → 当前 head 上有没有判定。只问盘面上真出现过、且还 OPEN 的那几个 PR——
 * 一个 PR 一次调用，全表问会很贵而且大部分用不上。
 * 判定必须比对 commit oid：审官判绿只对它当时看的那个 commit 有效（memory review-green-must-match-head）。
 * 任何一个问不出来 ⇒ 整张表不给，这条判据本轮不启用。
 */
function fetchPrJudgedAtHead(worktrees, prState) {
  const want = new Set();
  for (const w of worktrees || []) {
    for (const m of String(w?.displayName || '').matchAll(/PR[-\s]*#?(\d+)/g)) {
      const n = Number(m[1]);
      if (prState.get(n) === 'OPEN') want.add(n);
    }
  }
  if (!want.size) return new Map();
  const map = new Map();
  for (const n of want) {
    const r = run(process.execPath, [join(ROOT, 'scripts', 'gh-as.mjs'), 'marshal',
      'pr', 'view', String(n), '--json', 'headRefOid,reviews']);
    if (r.failed || r.code !== 0) return null;
    try {
      const p = JSON.parse(r.out);
      const head = p.headRefOid;
      if (!head) return null;
      const atHead = (p.reviews || []).filter(
        (x) => ['APPROVED', 'CHANGES_REQUESTED'].includes(x.state) && x.commit && x.commit.oid === head);
      map.set(n, atHead.length > 0);
    } catch { return null; }
  }
  return map;
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

/**
 * 把一张 risky 卡的本地提交推成 salvage 备份分支（#950）。返回 { pushed, branch, error }，
 * 只有 pushed === true 才允许后面删树——删树不可逆，这条分支是唯一的备份。
 *
 * 四道闸，每道对着一种「以为推上去了其实没有」：
 *   ① 读不出本地 HEAD ⇒ 失败。连推的是哪个 commit 都不知道，就没法验证推没推成。
 *   ② 远端有没有同名分支查不出来 ⇒ 失败。「没查成」不许当「远端没有」——
 *      当成没有就会去推，推到别人的备份上。
 *   ③ 远端已有同名且不是同一个 commit ⇒ 失败，绝不覆盖：覆盖等于把上一次的备份冲掉。
 *      （同一个 commit 视为已经救过，直接算成功，重跑不报错。）
 *   ④ push 退出码非 0，或推完回查远端 ref 对不上本地 HEAD ⇒ 失败。
 *      push 说成功不等于远端真有那个 commit（钩子改写、推到别的仓、代理吞掉），
 *      要删树就得看着备份落地（memory verify-credential-on-real-endpoint）。
 * 全程不用 --force / --force-with-lease：这条路上没有任何「该覆盖」的情形。
 */
function pushSalvage({ path, salvageBranch }) {
  const g = (args, timeout = 120000) => run('git', ['-C', path, ...args], { timeout });
  const ref = `refs/heads/${salvageBranch}`;
  const head = g(['rev-parse', 'HEAD'], 20000);
  if (head.failed || head.code !== 0) return { pushed: false, error: `读不出本地 HEAD：${head.err.trim().slice(0, 120)}` };
  const local = head.out.trim();
  if (!/^[0-9a-f]{7,}$/i.test(local)) return { pushed: false, error: `本地 HEAD 读出来不像 commit：${local.slice(0, 40)}` };

  const remoteOid = () => {
    const r = g(['ls-remote', 'origin', ref]);
    if (r.failed || r.code !== 0) return { ok: false, error: `问不出远端有没有 ${salvageBranch}（exit=${r.code}）${r.err.trim().slice(0, 120)}` };
    const line = r.out.trim().split(/\r?\n/).filter(Boolean)[0];
    return { ok: true, oid: line ? line.split(/\s+/)[0] : null };
  };

  const before = remoteOid();
  if (!before.ok) return { pushed: false, error: before.error };
  if (before.oid && before.oid !== local) {
    return { pushed: false, error: `远端已有 ${salvageBranch}（${before.oid.slice(0, 8)}）且不是同一个 commit——不覆盖别人的备份` };
  }
  if (before.oid === local) return { pushed: true, branch: salvageBranch, note: '远端已有同一个 commit，不用再推' };

  const p = g(['push', 'origin', `HEAD:${ref}`], 180000);
  if (p.failed || p.code !== 0) return { pushed: false, error: `push 失败（exit=${p.code}）${(p.err.trim() || p.out.trim()).slice(0, 160)}` };

  const after = remoteOid();
  if (!after.ok) return { pushed: false, error: `推完回查没查成：${after.error}` };
  if (after.oid !== local) return { pushed: false, error: `推完回查对不上：远端 ${String(after.oid).slice(0, 8)}，本地 ${local.slice(0, 8)}` };
  return { pushed: true, branch: salvageBranch };
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

  // 这两张表拿不到就是 null，判据自动不启用——少清几张，不会误清。
  const judged = fetchPrJudgedAtHead(worktrees, prs.map);
  const issues = fetchIssueState();
  if (judged == null) console.error('提示：PR 当前 head 判定没查成，本轮不判「审官活已交付」');
  if (issues == null) console.error('提示：issue 状态没查成，本轮不判「issue 已关闭」');

  const plan = planBoardGc({
    worktrees,
    aliveWorktreeIds: alive,
    prState: prs.map,
    branchState: fetchBranchState(worktrees),
    prJudgedAtHead: judged,
    issueState: issues,
  });

  // risky 里「只差一条远端备份」的那几张：先推备份，推成的才并进可清名单（#950）。
  // 干跑一个 git 写动作都不许有——所以整段挂在 --apply 里，干跑只在报告里说「会推哪条」。
  let final = plan;
  const jobs = planSalvage(plan);
  if (args.apply && jobs.length) {
    const results = new Map();
    for (const j of jobs) {
      const r = pushSalvage(j);
      results.set(j.id, r);
      console.log(`${r.pushed ? '已备份' : '救不了'} ${j.name} → ${j.salvageBranch}${r.pushed ? (r.note ? `（${r.note}）` : '') : '：' + r.error}`);
    }
    final = applySalvage(plan, results);
  }

  if (args.json) { console.log(JSON.stringify(final, null, 2)); }
  else console.log(formatBoardGc(final, { apply: args.apply }));

  if (!final.ok) process.exit(2);

  if (args.apply) {
    for (const z of final.zombies) {
      const r = run(process.execPath, [DAO, 'worktree-rm', '--worktree', z.id], { timeout: 180000 });
      console.log(`${r.code === 0 ? '已清' : '清不掉'} ${z.name}${r.code === 0 ? '' : '：' + (r.err.trim() || r.out.trim()).slice(0, 200)}`);
    }
  }

  if (args.say) {
    const head = `盘面清理：僵尸 ${final.zombies.length} 张${args.apply ? '（已清）' : '（只列未清）'}`
      + `，要人判 ${final.risky.length} 张，没查成 ${final.unscanned.length} 张`;
    const detail = final.risky.length
      ? '\n要人判：\n· ' + final.risky.map((r) => `${r.name}｜${r.why}`).join('\n· ')
      : '';
    if (final.zombies.length || final.risky.length) say(head + detail);
  }

  process.exit(final.risky.length ? 1 : 0);
}

// 直接跑才执行；被 import 时只暴露函数（测试要拿 pushSalvage 去真 git 仓上试「不覆盖」那条闸，
// 而这种闸只有在真 git 上试过才算数）。Windows 上大小写与斜杠都可能不一致，按规范化后比。
const sameFile = (a, b) => {
  if (!a || !b) return false;
  const norm = (p) => resolve(p).replace(/\\/g, '/');
  return process.platform === 'win32' ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
};
if (sameFile(process.argv[1], HERE)) main();

export { pushSalvage };
