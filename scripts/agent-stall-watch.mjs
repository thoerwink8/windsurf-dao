#!/usr/bin/env node
// scripts/agent-stall-watch.mjs —— 服务器撞限流探测（#833）
//
// 一条命令两处用：本机可手动跑，服务器 systemd timer 调同一条。
// 判据在 scripts/lib/agent-stall-detect.mjs。本文件只读盘面、记账、换人、报帅。
//
// 用法：
//   node scripts/agent-stall-watch.mjs                 扫真盘面（默认连红 2 轮才报）
//   node scripts/agent-stall-watch.mjs --dry-run       打印决策不真换人
//   node scripts/agent-stall-watch.mjs --state <file>  连红账本（默认 ~/.dao/agent-stall-watch.json）
//
// 测试注入：
//   AGENT_STALL_ORCA     假 orca（argv 原样转给它）
//   AGENT_STALL_SWITCH   假换人脚本（--pr / --reviewer / --parent-worktree）
//   AGENT_STALL_SAY      假报帅脚本（参数 = 文本）
//   AGENT_STALL_STATE    覆盖账本路径
//   AGENT_STALL_STRIKES  连红轮数（默认 2）
//
// 退出码：0 扫完没事或已处理 / 1 有真红没处理完 / 2 没查成。

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRouting, runGh } from './lib/dao-cmd.mjs';
import { issueNumberFromWorktree } from './lib/card-identity.mjs';
import { resolveActualWorkerModel } from './lib/reviewer-vendor-gate.mjs';
import { ensurePlain } from './lib/plain-words.mjs';
import {
  DEFAULT_SILENCE_MS, scanLiveness, routeSilent, applyProgressMemory,
  sessionFromOrcaTerminal, sessionFromMirasimSession,
} from './lib/liveness.mjs';
import {
  decideHitAction,
  reviewerOrderOf,
  reviewerPasserIds,
  scanRound,
} from './lib/agent-stall-detect.mjs';

const HERE = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(HERE), '..');
const DAO = join(REPO_ROOT, 'scripts', 'dao.mjs');
const DEFAULT_STATE = join(homedir(), '.dao', 'agent-stall-watch.json');
const PAD_SCRIPT = '/home/orca/bin/agent-stall-watch.mjs';
const PAD_TIMER = 'agent-stall-watch.timer';

function parseArgs(argv) {
  const out = { dryRun: false, state: process.env.AGENT_STALL_STATE || DEFAULT_STATE };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--state') out.state = argv[++i] || out.state;
  }
  return out;
}

function spawnJson(cmd, args, { timeout = 30000 } = {}) {
  const r = spawnSync(cmd, args, { windowsHide: true,
    encoding: 'utf8',
    timeout,
    maxBuffer: 32 << 20,
  });
  if (r.error) return { ok: false, error: `spawn 失败：${r.error.code || r.error.message}` };
  const text = String(r.stdout || '').trim();
  const start = text.indexOf('{');
  if (start < 0) {
    return {
      ok: false,
      error: `无 JSON（exit=${r.status}）${String(r.stderr || '').trim().slice(0, 160)}`,
    };
  }
  try {
    const json = JSON.parse(text.slice(start));
    if (json && json.ok === false) {
      return { ok: false, error: json.error?.message || json.error || json.message || 'ok=false', json };
    }
    return { ok: true, json };
  } catch (e) {
    return { ok: false, error: `JSON 解析失败：${String(e.message).slice(0, 120)}` };
  }
}

function withJson(args) {
  return args.includes('--json') ? args : [...args, '--json'];
}

function orca(args, opts) {
  const fake = process.env.AGENT_STALL_ORCA;
  const argv = withJson(args);
  if (fake) return spawnJson(process.execPath, [fake, ...argv], opts);
  return spawnJson('orca', argv, opts);
}

function screenOf(handle) {
  const r = orca(['terminal', 'read', '--terminal', handle, '--screen']);
  if (!r.ok) return null;
  const t = r.json?.result?.terminal || {};
  const s = t.screen ?? t.tail ?? '';
  return Array.isArray(s) ? s.join('\n') : String(s || '');
}

function loadState(path) {
  if (!existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

function saveState(path, state) {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(state), 'utf8');
}

function say(text) {
  const hook = process.env.AGENT_STALL_SAY;
  if (hook) {
    const r = spawnSync(process.execPath, [hook, text], { windowsHide: true, encoding: 'utf8', timeout: 15000 });
    if (r.status !== 0) console.error(`报帅钩子失败：${String(r.stderr || r.status).slice(0, 160)}`);
    console.log(text);
    return;
  }
  const hub = '/home/orca/bin/hub-say';
  if (existsSync(hub)) {
    const r = spawnSync(hub, [text], { windowsHide: true, encoding: 'utf8', timeout: 20000 });
    if (r.error || r.status !== 0) {
      console.error(`hub-say 失败：${String(r.error?.message || r.stderr || r.status).slice(0, 200)}`);
    }
  }
  console.log(text);
}

function wtId(w) {
  return (w && (w.worktreeId || w.id)) || null;
}

function idsEqual(a, b) {
  const left = String(a || '');
  const right = String(b || '');
  if (!left || !right) return false;
  return left === right || left.endsWith(`::${right}`) || left.endsWith(right)
    || right.endsWith(`::${left}`) || right.endsWith(left);
}

function parentOf(ps, worktreeId) {
  const list = Array.isArray(ps) ? ps : [];
  const self = list.find((w) => idsEqual(wtId(w), worktreeId));
  return self?.parentWorktreeId || null;
}

function displayNameOf(ps, worktreeId, fallback) {
  const list = Array.isArray(ps) ? ps : [];
  const self = list.find((w) => idsEqual(wtId(w), worktreeId));
  return self?.displayName || fallback;
}

function labelsFromGh(issue) {
  for (const role of ['watchdog', 'worker']) {
    const r = runGh(['issue', 'view', String(issue), '--json', 'labels'], { role });
    if (!r.ok) continue;
    try {
      const parsed = JSON.parse(r.out);
      if (Array.isArray(parsed.labels)) return { ok: true, labels: parsed.labels };
    } catch { /* 下一身份再试 */ }
  }
  return { ok: false };
}

function workerModelOf({ ps, workers, worktreeId }) {
  const parentId = parentOf(ps, worktreeId);
  if (!parentId) return resolveActualWorkerModel({});
  const list = Array.isArray(workers) ? workers : [];
  const hit = list.find((w) => {
    const id = w?.resource?.worktreeId || w?.worktreeId;
    return idsEqual(id, parentId);
  });
  const dispatchModel = hit?.model || hit?.resource?.model || hit?.requestedModel || null;
  if (dispatchModel) return resolveActualWorkerModel({ dispatchModel });
  const parent = (ps || []).find((w) => idsEqual(wtId(w), parentId));
  if (Array.isArray(parent?.labels) && parent.labels.length) {
    return resolveActualWorkerModel({ labels: parent.labels });
  }
  const issue = issueNumberFromWorktree(parent);
  if (!issue) return resolveActualWorkerModel({ labels: [] });
  const gh = labelsFromGh(issue);
  if (!gh.ok) return resolveActualWorkerModel({});
  return resolveActualWorkerModel({ labels: gh.labels });
}

// 换人没办成最多再试这么多轮，之后停手等人——不然每 15 分钟死循环一次。
const MAX_SWITCH_RETRY = 3;

/** 本轮换人结果：账本键 → 办成没办成。跑完回写进静默账，决定下一轮还试不试。 */
let switchLedger = null;

/**
 * 换人 = **先撤掉死的，再立新的**。少了前半步，换人这条路是零。
 *
 * 2026-09-05 实咬（#833 第三层闸）：审官位闸修通之后，reviewer-create 仍然换不成人——
 * 它返回 `oneReviewerGate: reused`，复用的正是那张已经死了 12 小时的审官卡。
 * 那道闸没写错：它是给「这个 PR 第一次起审官」用的，有卡就复用是对的。
 * 错的是换人复用了「起审官」这条路，而换人的语义里本来就有「旧的不要了」这一步。
 *
 * 所以不给闸开口子（开了它以后就分不清是新起还是换人），在这里编排两步。
 * 撤之前必须自己再确认一次那张卡没有活口——判死是上游给的，而删卡不可逆，
 * 两件不可逆的事之间要有独立的一道确认（memory deleted-card-process-outlived-it：
 * 卡删了底层进程还会活着跑完，那次是 --force 越过了占用闸）。
 * 这里用不带 --force 的 worktree-rm，占用闸继续守着；它拒绝就说明判死判错了，当场停手。
 */
function switchReviewer({ pr, reviewer, parentWorktree, deadWorktreeId, dryRun }) {
  if (dryRun) {
    return { ok: true, dryRun: true, detail: `将换人：PR #${pr} → ${reviewer}${deadWorktreeId ? '（先撤死卡）' : ''}` };
  }
  const hook = process.env.AGENT_STALL_SWITCH;
  if (!hook && deadWorktreeId) {
    const rm = spawnSync(process.execPath, [DAO, 'worktree-rm', '--worktree', deadWorktreeId],
      { windowsHide: true, encoding: 'utf8', cwd: REPO_ROOT, timeout: 120000 });
    if (rm.error || rm.status !== 0) {
      const why = String(rm.error?.message || rm.stderr || `exit ${rm.status}`).trim().slice(0, 160);
      // 占用闸拦下 = 这张卡其实还有活口 = 判死判错了。不硬删，报出来。
      return { ok: false, dryRun: false, detail: `换人失败：撤不掉旧审官卡（${why}）——它可能还活着，没有硬删` };
    }
  }
  const cmd = hook
    ? [process.execPath, hook, '--pr', String(pr), '--reviewer', reviewer, ...(parentWorktree ? ['--parent-worktree', parentWorktree] : [])]
    : [process.execPath, DAO, 'reviewer-create', '--pr', String(pr), '--reviewer', reviewer, ...(parentWorktree ? ['--parent-worktree', parentWorktree] : [])];
  const r = spawnSync(cmd[0], cmd.slice(1), { windowsHide: true,
    encoding: 'utf8',
    cwd: REPO_ROOT,
    timeout: 180000,
  });
  const ok = !r.error && r.status === 0;
  const err = String(r.error?.message || r.stderr || `exit ${r.status}`).trim().slice(0, 200);
  return { ok, dryRun: false, detail: ok ? `已换人：PR #${pr} → ${reviewer}` : `换人失败：${err}` };
}

function warnPadStillThere() {
  const bits = [];
  if (existsSync(PAD_SCRIPT)) bits.push(PAD_SCRIPT);
  const r = spawnSync('systemctl', ['list-timers', '--all'], { windowsHide: true, encoding: 'utf8', timeout: 8000 });
  if (!r.error && String(r.stdout || '').includes(PAD_TIMER)) bits.push(PAD_TIMER);
  if (bits.length) {
    console.error(`影子制度：垫片还在（${bits.join('；')}）。正式探测已接管，落地即删。`);
  }
}

/** 静默阈值（分钟）可用环境变量覆盖，便于按机器调；读不出数就用默认，不静默失效。 */
function livenessStatePath(statePath) {
  return String(statePath).replace(/\.json$/, '') + '-liveness.json';
}

/** 屏面签名账本：跨轮比对「屏上内容有没有变过」，不是「有没有输出过」。 */
function progressStatePath(statePath) {
  return String(statePath).replace(/\.json$/, '') + '-progress.json';
}

// 会话名要说人话：终端标题常常就是一行 shell 提示符，直接播出去用户只看到一串路径
// （服务器落地清单「说人话判据」：不出现路径/命令行）。取最后一段，去掉结尾的提示符。
function plainLabel(sess) {
  const raw = String(sess?.label || '').trim();
  const looksLikePrompt = raw.includes('/') || /[$#]\s*$/.test(raw);
  if (!looksLikePrompt) return `${sess.driver} 会话「${raw.slice(0, 40)}」`;
  const tail = raw.split('/').filter(Boolean).pop() || raw;
  return `${sess.driver} 会话「${tail.replace(/[$#]\s*$/, '').trim().slice(0, 40)}」`;
}

function silenceThresholdMs() {
  const n = Number(process.env.DAO_SILENCE_MINUTES);
  return Number.isFinite(n) && n > 0 ? n * 60000 : DEFAULT_SILENCE_MS;
}

/**
 * mirasim 会话：走它本地 WS API 的 listSessions。拿不到就返回空数组并说一句——
 * 「没查成」由上面的 sampledNothing / unscanned 两格显形，这里不假装 0 条等于没事。
 */
function mirasimSessions(notes) {
  // 指仓内脚本。此前这个能力只存在于服务器家目录里一个写着「用完即删」的临时脚本，
  // 指过去就是指向空气的指针（CLAUDE.md：留指针要配报警，配不了就别留）。
  const script = process.env.DAO_MIRASIM_LS || join(REPO_ROOT, 'scripts', 'mirasim-sessions.mjs');
  if (!existsSync(script)) return [];
  const r = spawnSync(process.execPath, [script, '--json'], { windowsHide: true, encoding: 'utf8', timeout: 20000 });
  if (r.error || r.status !== 0) {
    // 不在这里直接 say：那会绕过 dry-run 判断和一轮一条的合并，退回刷屏老路。
    // 交给调用方汇总进本轮那一条消息里。
    notes.push(`mirasim 会话没查成：${String(r.error?.message || r.stderr || `exit ${r.status}`).slice(0, 160)}`);
    return [];
  }
  const out = [];
  for (const line of String(r.stdout || '').split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      const sess = sessionFromMirasimSession(JSON.parse(t));
      if (sess) out.push(sess);
    } catch { /* 不是会话行，跳过 */ }
  }
  return out;
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  warnPadStillThere();

  const listed = orca(['terminal', 'list', '--json']);
  if (!listed.ok) {
    say(`⚠️ 撞限流探测没查成：terminal list 读不到（${listed.error}）`);
    process.exit(2);
  }
  const terminals = listed.json?.result?.terminals;
  if (!Array.isArray(terminals)) {
    say('⚠️ 撞限流探测没查成：terminal list 契约变了（result.terminals 不是数组）');
    process.exit(2);
  }

  const psR = orca(['worktree', 'ps', '--json']);
  const ps = psR.ok && Array.isArray(psR.json?.result?.worktrees) ? psR.json.result.worktrees : [];
  const wlR = orca(['orchestration', 'worker-list', '--json']);
  const workers = wlR.ok
    ? (wlR.json?.result?.workers || wlR.json?.result?.items || [])
    : [];

  // 采样面（2026-09-05 拍板改）：**不再按 agentIdentity 过滤**。
  // 旧代码这里是 `if (!t.agentIdentity) continue`——reclaude 起的终端没有这个字段，被整个跳过，
  // 于是不是「漏报」而是「没采样」，两者在报告里长得一模一样（memory reclaude-workers-invisible-to-orchestration）。
  const agents = [];
  const liveSessions = [];
  for (const t of terminals) {
    if (!t || !t.handle) continue;
    const sess = sessionFromOrcaTerminal({
      ...t,
      displayName: displayNameOf(ps, t.worktreeId, t.title || t.handle),
    });
    if (sess) liveSessions.push(sess);
    if (!t.agentIdentity) continue; // 指纹那条老路仍只看 agent 终端；活性判据看全部（上面已收）
    agents.push({
      handle: t.handle,
      title: t.title || t.handle,
      agentIdentity: t.agentIdentity,
      worktreeId: t.worktreeId || null,
      parentWorktreeId: parentOf(ps, t.worktreeId),
      displayName: displayNameOf(ps, t.worktreeId, t.title || t.handle),
      screen: screenOf(t.handle),
    });
  }
  const driverNotes = [];
  liveSessions.push(...mirasimSessions(driverNotes));

  // ② 发现判据（2026-09-05 拍板：删掉「靠认识错误字样」这一层）：
  // 唯一判据是「多久没有可验证的推进」。指纹只留作说明原因，不再决定报不报。
  // 先过屏面签名：TUI 空转重画会让 lastOutputAt 永远新鲜。2026-09-05 实测——盘面 45 个判 active，
  // 其中 37 个是 pi 停在空会话界面反复重画边框，假阳率 82%，僵尸卡因此永远清不掉。
  // 判据只认「屏上内容变没变」，与驱动、厂商、横幅文案全部无关。
  const progressed = applyProgressMemory({
    sessions: liveSessions,
    memory: loadState(progressStatePath(args.state)),
  });
  if (!args.dryRun) saveState(progressStatePath(args.state), progressed.memory);
  const live = scanLiveness({ sessions: progressed.sessions, thresholdMs: silenceThresholdMs() });
  const seenSilent = loadState(livenessStatePath(args.state));
  const nextSilent = {};
  const liveLines = [...driverNotes];
  const silentReviewers = [];
  if (!live.ok) {
    liveLines.push(`会话活性没查成：${live.error}`);
  } else {
    if (live.sampledNothing) liveLines.push('会话活性没查成：这一轮一个会话都没采到——不是「全都健康」');
    if (live.counts.unscanned) liveLines.push(`${live.counts.unscanned} 个会话答不上「上次真动」（没查成，不当活着）`);
    // 按**卡**去重再报，不按终端。一张卡有协调终端 + agent 终端好几个，
    // 按终端报会让同一张卡在同一条消息里重复出现（2026-09-05 实咬截图里就是成对的重复行）。
    const fresh = [];
    for (const sil of live.silent) {
      const route = routeSilent(sil);
      // 只报**新出现**的静默。timer 每 15 分钟一轮，不去重就是同一句话无限刷屏。
      // 键带处置动作——从「交给你看」变成「重起一个」算新情况，值得再说一次。
      const key = `${sil.worktreeId || sil.id}|${route.action}`;
      if (nextSilent[key]) continue; // 同一张卡本轮已收
      const prev = seenSilent[key];
      // 记账要区分「说过了」和「办成了」。2026-09-05 实咬：10 个审官换人全失败（exit 1），
      // 而失败和成功记的是同一条账，于是下一轮全被去重挡掉——**一次失败就永远不再试**，
      // 盘面上看着「已处置」，实际一个都没换成。
      // 办成了/纯报警 → 就此打住；没办成 → 再试，最多 MAX_RETRY 轮，之后停手等人（免得每 15 分钟一次死循环）。
      const tries = Number(prev?.tries) || 0;
      const settled = prev && (prev.ok === true || prev.action !== 'restart-reviewer');
      if (prev && (settled || tries >= MAX_SWITCH_RETRY)) {
        nextSilent[key] = { ...prev, minutes: Math.round((sil.silentMs || 0) / 60000) };
        continue;
      }
      nextSilent[key] = {
        at: new Date().toISOString(), minutes: Math.round((sil.silentMs || 0) / 60000),
        action: route.action, tries: tries + 1, ok: null,
      };
      fresh.push(`${plainLabel(sil)} 已经 ${Math.round((sil.silentMs || 0) / 60000)} 分钟没动`
        + `——${route.action === 'restart-reviewer' ? '当它死了，重起一个' : '交给你看'}`);
      // 判死之后要真换人（用户 2026-09-05 拍板 #833）。此前这条能力挂在 #807 删掉的本机 watchdog 上，
      // 删完就是零——PR #827 的审官撞 429 静默 9 小时零 review，最后是用户问了一句才发现。
      // 换人的判据/顺序/同厂禁令都在 decideHitAction 里现成，这里只把静默会话喂进同一条路，不另造判断。
      // 只喂**新判**的静默（上面 seenSilent 已挡掉重复），所以同一张卡不会每轮换一次人。
      if (route.action === 'restart-reviewer') {
        silentReviewers.push({
          handle: sil.id,
          displayName: String(sil.label || ''),
          agentIdentity: sil.agentIdentity || null,
          worktreeId: sil.worktreeId || null,
          sig: `静默 ${Math.round((sil.silentMs || 0) / 60000)} 分钟`,
          // 换人办没办成，回填到这条账上（见下面 lines 回写）。
          ledgerKey: key,
        });
      }
    }
    // 上限：一条消息最多列这么多，其余只给条数。第一次接上观测面时盘上会攒着几十个陈年静默，
    // 全列出来仍然是刷屏——只是从「每轮刷」变成「一次刷一屏」。
    const MAX_LISTED = 8;
    liveLines.push(...fresh.slice(0, MAX_LISTED));
    if (fresh.length > MAX_LISTED) {
      liveLines.push(`另有 ${fresh.length - MAX_LISTED} 个会话也静默了，先不逐条列（多半是早该清掉的旧卡）`);
    }
    console.log(`活性：活 ${live.counts.active} / 静默 ${live.counts.silent} / 干完 ${live.counts.done} / 没查成 ${live.counts.unscanned}`);
  }
  // 一轮只发一条：同轮多条发现合成一段（服务器落地清单「说人话判据」：不刷屏）。
  if (liveLines.length) {
    const text = liveLines.length === 1 ? liveLines[0] : `这一轮盘点发现 ${liveLines.length} 件事：\n· ${liveLines.join('\n· ')}`;
    if (args.dryRun) console.log(`[dry] 本会发：${text}`);
    else say(text);
  }
  // 先落一次账：下面 scanRound / 换人任何一步崩了，本轮判过的静默也不会丢，
  // 不至于下一轮当成全新的再报一遍。换人结果稍后回填再落第二次。
  if (!args.dryRun) saveState(livenessStatePath(args.state), nextSilent);
  switchLedger = {};

  const prev = loadState(args.state);
  const need = Number(process.env.AGENT_STALL_STRIKES || 2);
  const round = scanRound({ agents, prevState: prev, strikesNeeded: need });
  saveState(args.state, round.nextState);
  // 静默判死的审官走**同一条**换人路（用户 2026-09-05 拍板 #833）：
  // 指纹命中和静默判死是两种发现方式，处置只有一套——判据/顺序/同厂禁令都在 decideHitAction 里，
  // 在这里另写一套就是第二套判据。parentWorktreeId 现补，会话对象里没有。
  for (const s of silentReviewers) {
    round.reports.push({ ...s, parentWorktreeId: parentOf(ps, s.worktreeId) });
  }

  if (round.unscanned) {
    say(`⚠️ 撞限流探测：${round.unscanned} 个终端屏面没读成（没查成，不是没事）`);
  }

  if (!round.reports.length) {
    console.log(`扫 ${round.scanned} 个 agent 终端，新报 0 条，没查成 ${round.unscanned} 个`);
    process.exit(round.unscanned ? 2 : 0);
  }

  let routing;
  try { routing = loadRouting(); }
  catch (e) {
    say(`⚠️ 撞限流探测读选型表失败，没法换人：${e.message || e}`);
    process.exit(2);
  }

  const lines = [];
  let failed = 0;
  for (const hit of round.reports) {
    const actual = workerModelOf({ ps, workers, worktreeId: hit.worktreeId });
    const decision = decideHitAction({
      displayName: hit.displayName,
      workerId: actual.ok ? actual.modelId : null,
      models: routing.models || [],
      passerIds: reviewerPasserIds(routing),
      order: reviewerOrderOf(routing),
    });
    const who = `${hit.displayName}【${hit.agentIdentity || '?'}】${hit.handle}`;
    if (decision.action === 'switch') {
      const sw = switchReviewer({
        pr: decision.pr,
        reviewer: decision.to,
        parentWorktree: hit.parentWorktreeId,
        // 判死的就是这张审官卡；撤掉它，reviewer-create 才不会「复用」这具尸体。
        deadWorktreeId: hit.worktreeId || null,
        dryRun: args.dryRun,
      });
      console.log(`· ${who} 命中 ${hit.sig} → ${sw.detail}（${decision.from} → ${decision.to}）`);
      lines.push({ name: hit.displayName, action: 'switch', ok: sw.ok, from: decision.from, to: decision.to, detail: sw.detail });
      // 办成没办成回填到静默账上：办成了就此打住，没办成下一轮还要再试（见上面 MAX_SWITCH_RETRY）。
      if (hit.ledgerKey && switchLedger) switchLedger[hit.ledgerKey] = sw.ok === true;
      if (!sw.ok) failed += 1;
    } else if (decision.action === 'escalate') {
      console.log(`· ${who} 命中 ${hit.sig} → 报帅停手：${decision.reason}`);
      lines.push({ name: hit.displayName, action: 'escalate', reason: decision.reason });
    } else {
      console.log(`· ${who} 命中 ${hit.sig} → 只报警（${decision.reason}）`);
      lines.push({ name: hit.displayName, action: 'alert', reason: decision.reason });
    }
  }

  // 换人办成没办成回填静默账：办成的就此打住，没办成的下一轮还会再试（最多 MAX_SWITCH_RETRY 轮）。
  // 不回填的话失败和成功记的是同一条账，下一轮全被去重挡掉——一次失败就永远不再试。
  if (!args.dryRun && switchLedger && Object.keys(switchLedger).length) {
    for (const [k, ok] of Object.entries(switchLedger)) {
      if (nextSilent[k]) nextSilent[k].ok = ok;
    }
    saveState(livenessStatePath(args.state), nextSilent);
  }

  say(ensurePlain(buildStallReport({ failed, need, items: lines }), 'agent-stall-watch'));
  console.log(`扫 ${round.scanned} 个 agent 终端，新报 ${round.reports.length} 条，没查成 ${round.unscanned} 个`);
  process.exit(failed ? 1 : 0);
}

/** 总控群文案（说人话，用户 2026-09-04 拍板）：技术细节（签名/句柄/身份）留在 journal，群里只说谁、怎么了、我做了什么。 */
function buildStallReport({ failed, need, items }) {
  const switched = items.some((it) => it.action === 'switch' && it.ok);
  const head = failed
    ? `有 ${failed} 个卡住的工人换人没成功，需要你看一眼`
    : switched
      ? `有工人连续 ${need} 轮卡在上游限流，我已按备选顺序换人`
      : `有工人连续 ${need} 轮卡在上游限流，这次没换人（原因见下）`;
  const body = items.map((it) => {
    const name = String(it.name || '某工人').replace(/【.*?】|term_[0-9a-f-]+/g, '').trim();
    if (it.action === 'switch') {
      return it.ok
        ? `· ${name}：已换成 ${it.to}（原来是 ${it.from}）继续干`
        : `· ${name}：想换成 ${it.to} 但没换成——${String(it.detail || '').replace(/^换人失败：/, '')}`;
    }
    if (it.action === 'escalate') return `· ${name}：备选都用完了，先停手等你拍——${it.reason}`;
    return `· ${name}：先只提醒不换人——${it.reason}`;
  });
  return [head, ...body].join('\n');
}

const isDirect = process.argv[1] && resolve(process.argv[1]) === HERE;
if (isDirect) main();

export { main, parseArgs, workerModelOf, buildStallReport };
