#!/usr/bin/env node
// scripts/agent-stall-watch-mirasim.mjs —— mirasim 会话保活与回收（#880 卡 D）
//
// 现役 scripts/agent-stall-watch.mjs（#833）靠刮 orca 屏面判卡死；mirasim 没有屏面，
// 这条路只看「该发生的事有没有发生」：phase 还在跑，但账本行数没涨、快照正文没变超过阈值
// → 判卡死 → stopSession + 在关联 issue 落一条人话评论（复用 watchdog 报警形状）。
// 顺带做会话 GC（终态过 TTL → deleteSession，分支已合并再连树一起删）与健康段落盘。
//
// 判据全在 scripts/lib/mirasim-monitor.mjs（纯判官）；本文件只连线、读盘、记账、报帅。
//
// 用法：
//   node scripts/agent-stall-watch-mirasim.mjs --once            扫一遍（判卡死+GC）
//   node scripts/agent-stall-watch-mirasim.mjs --once --dry-run  只报决策不真停/删/评论
//   node scripts/agent-stall-watch-mirasim.mjs --health [--json]  只出健康段并落额度文件
//
// 运维/验收旋钮：
//   MIRASIM_STALL_MS        判死阈值毫秒（默认 8 分钟）
//   MIRASIM_GC_TTL_MS       终态回收 TTL 毫秒（默认 30 分钟）
//   MIRASIM_STALL_ONLY      只处置 sessionKey 含该串的会话（缩爆炸半径）
//   MIRASIM_STALL_ISSUE     推不出关联 issue 时的兜底 issue 号
// 测试注入（tests/mirasim-stall.test.js 用 sweepOnce + 假依赖，不碰真服务）：
//   MIRASIM_STALL_STATE     覆盖连红账本路径
//   MIRASIM_STALL_WATCHDOG  假评论脚本（argv: issue body），替 gh-as watchdog
//
// 退出码：0 扫完没事或已处理并自证 / 1 查成了但动作失败（停不成、评论没落、删了没自证掉）
//        / 2 没查成（连不上、枚举失败、或任一会话的关键读链路 unknown）。
// 「没查成」与「查过没事」永不合并：任一会话读不到快照/账本，整条命令就是 2，不打绿。

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createRuntime, readLedger, openWire,
} from './lib/mirasim-runtime.mjs';
import {
  judgeStall, judgeGcSession, judgeGcWorktree, errorFingerprint,
  normPhase, isTerminalPhase, activeWorkdirs,
  wireListSessions, wireDeleteSession, wireRemoveWorktree, probeMirasim,
} from './lib/mirasim-monitor.mjs';

const HERE = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(HERE), '..');
const DEFAULT_STATE = join(homedir(), '.dao', 'mirasim-stall-watch.json');
const USAGE_FILE = join(homedir(), '.dao', 'mirasim-usage.json');
const STALL_MS = Number(process.env.MIRASIM_STALL_MS || 8 * 60_000);   // 8 分钟没动静判卡死
const TTL_MS = Number(process.env.MIRASIM_GC_TTL_MS || 30 * 60_000);   // 终态静置 30 分钟回收

function parseArgs(argv) {
  const out = { mode: null, dryRun: false, json: false, state: process.env.MIRASIM_STALL_STATE || DEFAULT_STATE };
  for (const a of argv) {
    if (a === '--once') out.mode = 'once';
    else if (a === '--health') out.mode = 'health';
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--json') out.json = true;
  }
  return out;
}

function loadState(path) {
  if (!existsSync(path)) return { sessions: {} };
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    return raw && typeof raw === 'object' && raw.sessions ? raw : { sessions: {} };
  } catch { return { sessions: {} }; }
}

function saveState(path, state) {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(state), 'utf8');
}

function writeJsonFile(path, obj) {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(obj, null, 1), 'utf8');
}

/** 落 watchdog 评论：默认走 gh-as watchdog，测试用 MIRASIM_STALL_WATCHDOG 假脚本换掉。 */
function postComment({ issue, body }) {
  const hook = process.env.MIRASIM_STALL_WATCHDOG;
  const dir = join(homedir(), '.dao');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `mirasim-stall-comment-${Date.now()}.md`);
  writeFileSync(tmp, body, 'utf8');
  const cmd = hook
    ? [process.execPath, hook, String(issue), tmp]
    : [process.execPath, join(REPO_ROOT, 'scripts', 'gh-as.mjs'), 'watchdog', '--', 'issue', 'comment', String(issue), '--body-file', tmp];
  const r = spawnSync(cmd[0], cmd.slice(1), { encoding: 'utf8', cwd: REPO_ROOT, timeout: 60000 });
  const ok = !r.error && r.status === 0;
  return { ok, detail: ok ? '评论已落' : `评论失败：${String(r.error?.message || r.stderr || `exit ${r.status}`).slice(0, 200)}`, out: String(r.stdout || '').trim() };
}

/**
 * 从工作树反查它**当前**在哪条分支。会话清单的 branch 字段是起会话时请求的那个，
 * 真机 0.0.286 实测一半是 null、一半是 'master'，拿它当树的现状会既漏删又误删。
 * 游离 HEAD / 不是 git 树 / 查不成 → null（没查成 → judgeGcWorktree 拒回收）。
 */
function branchOfWorktree(dir) {
  if (!dir || !existsSync(dir)) return null;
  const r = spawnSync('git', ['-C', dir, 'symbolic-ref', '--quiet', '--short', 'HEAD'], { encoding: 'utf8', timeout: 15000 });
  if (r.error || r.status !== 0) return null; // 游离时 symbolic-ref 非零
  const b = String(r.stdout || '').trim();
  return b || null;
}

/** 树还在不在（删完回读自证用）。查不成回 null，与「不在了」分开。 */
function treeExists(dir) {
  if (!dir) return null;
  try { return existsSync(dir); } catch { return null; }
}

/** 分支合没合并进 master：merged/未合并/没查成三态。 */
function isBranchMerged(branch) {
  if (!branch) return null;
  const r = spawnSync('git', ['branch', '--merged', 'master', '--format=%(refname:short)'], { encoding: 'utf8', cwd: REPO_ROOT, timeout: 15000 });
  if (r.error || r.status !== 0) return null;
  const set = new Set(String(r.stdout || '').split(/\r?\n/).filter(Boolean));
  return set.has(branch);
}

/**
 * 扫一遍（可测核心）。deps 全注入，测试给假的：
 *   listSessions() / readSession(k) / readLedger(k) / stopSession(k)
 *   deleteSession(k,{removeWorktree}) / removeWorktree(path)
 *   isBranchMerged(branch) / branchOfWorktree(path) / treeExists(path)
 *   postComment({issue,body}) / now()
 *   issueOf(session) —— 从会话推关联 issue（推不出用 fallbackIssue）
 * opts: { stallMs, ttlMs, dryRun, fallbackIssue, protectPaths }
 * 返回 { scanned, stalled[], gced[], escalated[], live[], unknown[], unscanned, actionFailed, nextState, exit }
 * exit：2 = 有没查成的（枚举失败 / 任一会话读链路 unknown）；1 = 查成了但动作失败
 *      （停不成 / 评论没落 / 删了但回读没自证）；0 = 扫完且该做的都自证做成了。
 */
export async function sweepOnce(deps, prevState = { sessions: {} }, opts = {}) {
  const now = deps.now || (() => Date.now());
  const stallMs = opts.stallMs ?? STALL_MS;
  const ttlMs = opts.ttlMs ?? TTL_MS;
  const dryRun = !!opts.dryRun;
  // 绝不回收的树：本仓根（主树）。真机会话的 workdir 里就有挂 master 的树，
  // 没这道闸 + branch 反查一开，第一遍就能把主树删掉。
  const protectPaths = opts.protectPaths ?? [REPO_ROOT];
  const nextState = { sessions: {} };
  const out = { scanned: 0, stalled: [], gced: [], escalated: [], live: [], unknown: [], unscanned: false, actionFailed: false };

  const sessions = await deps.listSessions();
  if (!Array.isArray(sessions)) {
    out.unscanned = true;
    return { ...out, nextState: prevState, exit: 2, reason: '枚举会话没查成（listSessions 没回 sessions 帧）' };
  }
  const active = activeWorkdirs(sessions);
  const pendingVerify = []; // 删过、等回读自证的（「送进去了」≠「删掉了」）

  for (const s of sessions) {
    if (!s || typeof s.sessionKey !== 'string') continue;
    out.scanned++;
    const key = s.sessionKey;
    const prev = prevState.sessions[key];
    const phase = normPhase(s.runState);

    // 终态 → GC
    if (isTerminalPhase(phase)) {
      const g = judgeGcSession({ meta: s, now: now(), ttlMs });
      if (!g.gc) { nextState.sessions[key] = prev || { sig: null, sinceTs: now() }; continue; }
      // 树 GC：分支已合并才连树删。
      // 会话清单的 branch 字段不能当树的现状（真机 0.0.286 实测 65 条：一半 null、一半 'master'），
      // 所以从 workdir 反查它**当前**在哪条分支；反查不成 → null → judgeGcWorktree 拒（审官第 7 条）。
      let removeTree = false;
      let treeBranch = null;
      let treeReason = s.workdir ? 'workdir 还在活动集里，不动树' : '会话没登记 workdir，不动树';
      if (s.workdir && !active.has(s.workdir)) {
        treeBranch = deps.branchOfWorktree ? deps.branchOfWorktree(s.workdir) : null;
        const merged = treeBranch ? deps.isBranchMerged(treeBranch) : null;
        const wj = judgeGcWorktree({ path: s.workdir, branch: treeBranch, merged, protectedPaths: protectPaths });
        removeTree = wj.gc;
        treeReason = wj.reason;
      }
      if (dryRun) {
        out.gced.push({ key, reason: g.reason, removeTree, treeBranch, treeReason, dryRun: true });
        nextState.sessions[key] = prev || { sig: null, sinceTs: now() };
        continue;
      }
      const del = await deps.deleteSession(key, { removeWorktree: removeTree });
      // ok:true 只说明「送进去了」；删成没成一律等下面回读清单/看树还在不在自证（注释承诺的那道回读）。
      const rec = { key, reason: g.reason, removeTree, treeBranch, treeReason, ok: del.ok, why: del.why, verified: null, treeGone: null };
      out.gced.push(rec);
      if (!del.ok) {
        // 明确失败 → 非零结果 + 保留状态可重试（审官第 4 条）
        out.actionFailed = true;
        nextState.sessions[key] = prev || { sig: null, sinceTs: now() };
        continue;
      }
      pendingVerify.push({ rec, key, prev, workdir: removeTree ? s.workdir : null });
      // 这里**不再**在 judgeGcWorktree 说「不回收」之后补一刀 removeWorktree：
      // 原来那段绕过判官重算 merged，会把保护名单里的树和挂默认分支的树删掉。
      continue;
    }

    // 还在跑 → 读 phase/账本，判卡死
    const view = await deps.readSession(key);
    const ledger = await deps.readLedger(key);
    const j = judgeStall({ view, ledger, updatedAt: s.updatedAt, prev, now: now(), stallMs });
    // 错误指纹两连同 → 不救、报帅
    const fp = errorFingerprint(view);
    const prevFp = prev?.errFp || null;
    nextState.sessions[key] = { sig: j.sig, sinceTs: j.sinceTs, errFp: fp };

    // 关键读链路没查成 → 整条命令算「没查成」（审官第 8 条）：
    // 不 stop、不报帅（连 view.error 都不可信）、不计入健康的「在跑」，并让 exit 变 2。
    if (j.status === 'unknown') {
      out.unknown.push({ key, reason: j.reason, gaps: j.gaps || [] });
      out.unscanned = true;
      continue;
    }

    if (fp && prevFp && fp === prevFp) {
      const issue = (deps.issueOf ? deps.issueOf(s) : null) || opts.fallbackIssue;
      out.escalated.push({ key, fp, issue });
      if (!dryRun && issue) {
        const body = escalateBody({ s, fp, view });
        const r = deps.postComment({ issue, body });
        if (!r.ok) out.actionFailed = true;
      }
      continue;
    }

    if (j.status === 'stalled') {
      const issue = (deps.issueOf ? deps.issueOf(s) : null) || opts.fallbackIssue;
      out.stalled.push({ key, reason: j.reason, issue });
      if (!dryRun) {
        const stop = await deps.stopSession(key);
        let phaseAfter = null;
        if (deps.readSession) { const v2 = await deps.readSession(key); phaseAfter = v2?.phase ?? null; }
        const body = stallBody({ s, reason: j.reason, stop, phaseAfter });
        const r = issue ? deps.postComment({ issue, body }) : { ok: false, detail: '没有关联 issue，评论没落' };
        if (!r.ok) out.actionFailed = true;
        out.stalled[out.stalled.length - 1].stop = stop;
        out.stalled[out.stalled.length - 1].phaseAfter = phaseAfter;
        out.stalled[out.stalled.length - 1].comment = r;
      }
      continue;
    }

    out.live.push({ key, status: j.status, reason: j.reason });
  }

  // ── 删除后回读自证（本文件原注释承诺过、但一直没实现的那道；审官第 4 条）──────
  // 一次回读清单核全部被删的会话；连树删的再看树路径还在不在。
  // 三种结果：不在了=真删成；还在=没删成；读不回来=没查成。后两种都算 actionFailed（非零）。
  if (pendingVerify.length) {
    const after = await deps.listSessions();
    const stillThere = Array.isArray(after)
      ? new Set(after.map(x => (x && typeof x.sessionKey === 'string' ? x.sessionKey : null)).filter(Boolean))
      : null;
    for (const v of pendingVerify) {
      if (stillThere === null) {
        v.rec.verified = null;
        v.rec.why = '删完回读清单没查成（listSessions 没回帧），删没删成不敢报';
        out.actionFailed = true;
      } else if (stillThere.has(v.key)) {
        v.rec.verified = false;
        v.rec.why = '回读清单里这条会话还在——没删成';
        out.actionFailed = true;
      } else {
        v.rec.verified = true;
      }
      if (v.workdir) {
        const exists = deps.treeExists ? deps.treeExists(v.workdir) : null;
        if (exists === null) {
          v.rec.treeGone = null;
          v.rec.treeWhy = '树还在不在没查成';
          out.actionFailed = true;
        } else if (exists === true) {
          v.rec.treeGone = false;
          v.rec.treeWhy = '回读树路径还在——树没拆成';
          out.actionFailed = true;
        } else {
          v.rec.treeGone = true;
        }
      }
      // 没自证成的留着状态，下一轮可重试
      if (v.rec.verified !== true || (v.workdir && v.rec.treeGone !== true)) {
        nextState.sessions[v.key] = v.prev || { sig: null, sinceTs: now() };
      }
    }
  }

  const exit = out.unscanned ? 2 : out.actionFailed ? 1 : 0;
  return { ...out, nextState, exit };
}

function shortTitle(s) {
  return String(s?.title || s?.sessionKey || '某会话').replace(/\s+/g, ' ').trim().slice(0, 60);
}

/** 卡死评论（说人话）：谁、卡在哪、我做了什么、停完什么状态。 */
export function stallBody({ s, reason, stop, phaseAfter }) {
  return [
    `⚠️ mirasim 会话卡死已处理`,
    ``,
    `· 会话：${shortTitle(s)}（agent ${s?.agent || '?'}）`,
    `· 判据：${reason}`,
    `· 处置：已 stopSession（${stop?.ok ? '成' : '没停成：' + (stop?.why || '')}）；停后快照 phase = ${phaseAfter ?? '没读到'}`,
    ``,
    `技术细节（sessionKey / 账本目录）留在 journal，不进群。`,
  ].join('\n');
}

/** 错误两连同报帅评论。 */
export function escalateBody({ s, fp, view }) {
  return [
    `⚠️ mirasim 会话连着两轮同一个错，先停手等你拍`,
    ``,
    `· 会话：${shortTitle(s)}（agent ${s?.agent || '?'}）`,
    `· 错误指纹：${fp}`,
    `· 现状：${view?.error ? String(view.error).split('\n')[0].slice(0, 160) : '（快照没给错误正文）'}`,
    ``,
    `同一个错两连同，按规矩不自动重试——需要你看一眼根因。`,
  ].join('\n');
}

// ── 真依赖装配 ────────────────────────────────────────────────────────────────

async function withWire(fn, opts = {}) {
  const wire = await openWire(opts);
  try { return await fn(wire); } finally { wire.close(); }
}

function issueFromBranch(branch) {
  // 分支名尾部 -<digits><letter?> 形（如 mirasim-keepalive-880d）里的数字段即 issue 号
  const m = String(branch || '').match(/-(\d{2,6})[a-z]?$/);
  return m ? Number(m[1]) : null;
}

async function realDeps(runtime) {
  // MIRASIM_STALL_ONLY：把这一遍的处置范围锁到 sessionKey 含该串的会话（缩爆炸半径，
  // 真机验收/单会话止血用）。不设＝全扫。
  const only = process.env.MIRASIM_STALL_ONLY || null;
  return {
    now: () => Date.now(),
    listSessions: () => withWire(async w => {
      const all = await wireListSessions(w);
      if (!Array.isArray(all) || !only) return all;
      return all.filter(s => typeof s?.sessionKey === 'string' && s.sessionKey.includes(only));
    }),
    readSession: k => runtime.readSession(k),
    readLedger: k => readLedger({ sessionKey: k, homeDir: homedir() }),
    stopSession: k => runtime.stopSession(k),
    deleteSession: (k, o) => withWire(w => wireDeleteSession(w, { sessionKey: k, removeWorktree: !!o?.removeWorktree })),
    removeWorktree: p => withWire(w => wireRemoveWorktree(w, { path: p })),
    isBranchMerged,
    branchOfWorktree,
    treeExists,
    postComment,
    issueOf: s => issueFromBranch(s?.branch) || issueFromBranch(String(s?.workdir || '').split('/').pop()),
  };
}

async function runHealth({ json }) {
  const collected = await probeMirasim({ port: Number(process.env.MIRASIM_PORT) || 4316 });
  writeJsonFile(USAGE_FILE, collected.usage);
  const h = collected.health;
  if (json) {
    console.log(JSON.stringify({ reachable: collected.reachable, health: h, usageFile: USAGE_FILE, perAgent: collected.perAgent }));
  } else {
    const mark = h.state === 'ok' ? '✓' : h.state === 'red' ? 'X' : '?';
    console.log(`${mark} mirasim 执行体：${h.state}（版本 ${h.version || '?'}｜模式 ${h.mode || '?'}）`);
    if (h.agentRoutes) console.log(`  路由：${Object.entries(h.agentRoutes).map(([a, m]) => `${a}→${m}`).join(' ')}`);
    for (const w of h.windows) console.log(`  额度窗 ${w.label}：用了 ${w.usedPercent}%（剩 ${w.remainingPercent}%，${w.status || ''}）`);
    for (const n of h.notes) console.log(`  · ${n}`);
    console.log(`  额度已落 ${USAGE_FILE}`);
  }
  return h.state === 'red' ? 1 : h.state === 'unknown' ? 2 : 0;
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.mode === 'health') { process.exit(await runHealth(args)); }
  if (args.mode !== 'once') {
    console.error('要么 --once（保活+回收）要么 --health（健康段）');
    process.exit(2);
  }
  const runtime = createRuntime();
  const deps = await realDeps(runtime);
  const prev = loadState(args.state);
  const fallbackIssue = Number(process.env.MIRASIM_STALL_ISSUE) || null;
  let res;
  try {
    res = await sweepOnce(deps, prev, { dryRun: args.dryRun, fallbackIssue });
  } catch (e) {
    console.error(`⚠️ mirasim 保活没查成：${e?.message || e}`);
    process.exit(2);
  }
  if (!args.dryRun) saveState(args.state, res.nextState);
  console.log(`扫 ${res.scanned} 个会话：卡死 ${res.stalled.length}、报帅 ${res.escalated.length}、回收 ${res.gced.length}、在跑 ${res.live.length}、没查成 ${res.unknown.length}`);
  for (const x of res.stalled) console.log(`· 卡死 ${x.key}：${x.reason}${x.stop ? `（停 ${x.stop.ok ? '成' : '败'}，停后 phase=${x.phaseAfter}）` : ''}`);
  for (const x of res.escalated) console.log(`· 报帅 ${x.key}：错误两连同 ${x.fp}`);
  for (const x of res.gced) {
    const verdict = x.dryRun ? '拟' : x.verified === true ? '回读自证：清单里没了' : x.verified === false ? '没删成（回读还在）' : x.ok === false ? `没删成：${x.why}` : `没查成：${x.why || '回读不回来'}`;
    const tree = x.removeTree ? `（连树 ${x.treeBranch || '?'}：${x.treeGone === true ? '树已没' : x.treeGone === false ? '树还在' : x.dryRun ? x.treeReason : '树还在不在没查成'}）` : '';
    console.log(`· 回收 ${x.key}：${x.reason} → ${verdict}${tree}`);
  }
  for (const x of res.unknown) console.log(`· 没查成 ${x.key}：${x.reason}（没 stop、不算在跑）`);
  if (res.unscanned) console.log('（有没查成的项，见上——本轮不算「查过没事」）');
  process.exit(res.exit);
}

const isDirect = process.argv[1] && resolve(process.argv[1]) === HERE;
if (isDirect) main();

export { parseArgs, isBranchMerged, issueFromBranch };
