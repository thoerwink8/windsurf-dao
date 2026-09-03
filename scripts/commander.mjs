#!/usr/bin/env node
// scripts/commander.mjs —— 服务器指挥官（#800「眼睛常驻、大脑按需醒」的手脚）
//
// 四层里本文件是「眼睛（scan）+ 手（act/inventory）+ 自检（status）+ 装机（install）」；
// 「决策」在纯函数 scripts/lib/commander-core.mjs（decide），「大脑」是 act 起的一次性 pi 会话。
//
// 子命令：
//   scan            读 GitHub / Orca / 队列 / 撞死指纹 → 态势 JSON，落 ~/.dao/commander/situation-<ts>.json
//   act [--dry-run] scan → decide → 逐条执行动作（--dry-run 只打印）
//   inventory [--dry-run]  盘点体检：孤儿进程/终端登记/timer/探针连红/超龄PR/落地清单空列 → 异常开「待拍板」单
//   status [--json] 自检三态（0 通 / 1 红 / 2 没查成），供 server-check 一行引用
//   install [--dry-run]    幂等写 systemd service+timer（act 每 20 分钟、inventory 每 6 小时）
//
// 硬规矩（CLAUDE.md）：每个 ✓ 都是盘上读回来的事实；没查成明说「没查成」，与「查过没事」分开形。
// key 永不进代码——凭据只经 hub-say / gh-as 内部读。

import { spawnSync } from 'node:child_process';
import {
  appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildGithubGraphqlArgs, parseGithubGraphqlResponse, DEFAULT_REPO,
} from './lib/shuai-scan.mjs';
import { runOrca } from './lib/orca-run.mjs';
import { ghExecutable } from './lib/gh.mjs';
import { reviewPendingDir, listReviewPending } from './lib/dispatch/review-pending.mjs';
import {
  decide, heartbeatDue, hasLiveAction, actionsDigest,
} from './lib/commander-core.mjs';
import { loadDispatchPolicy } from './lib/preflight.mjs';
import { loadRoutingJsonRaw, modelsFromJson } from './lib/model-routing-json.mjs';
import { availabilityFor } from './lib/provider-health.mjs';

const HERE = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(HERE), '..');
const REPO = process.env.COMMANDER_REPO || DEFAULT_REPO;

// 仓外落点（检查器输出不落在自己会读的范围内，CLAUDE.md）。
const STATE_DIR = process.env.COMMANDER_STATE_DIR || join(homedir(), '.dao', 'commander');
const STATE_PATH = join(STATE_DIR, 'state.json');
const STALL_FILE = process.env.AGENT_STALL_WATCH_FILE || join(homedir(), '.agent-stall-watch.json');
// 大脑：一次性 pi 会话，经网关 gw/grok-4.6。
const BRAIN_MODEL = process.env.COMMANDER_BRAIN_MODEL || 'grok-4.6';
const BRAIN_WORKTREE = process.env.COMMANDER_BRAIN_WORKTREE || 'path:/home/orca/windsurf-dao';
const HUB_DEDUP_MS = 6 * 3600 * 1000; // 同一条回流 6 小时内不重发

function ensureDir(d) { if (!existsSync(d)) mkdirSync(d, { recursive: true }); }
const nowIso = () => new Date().toISOString();

// ── 状态 state.json（可注入时钟便于测试；这里只做 IO）──
function loadState() {
  try { return JSON.parse(readFileSync(STATE_PATH, 'utf8')); }
  catch { return {}; }
}
function saveState(state) {
  ensureDir(STATE_DIR);
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
}

// ── 眼睛：各面采集，每面标 scanned 或 unscanned（没查成 ≠ 空）──
function runGh(args, timeout = 45000) {
  const r = spawnSync(ghExecutable(), args, { encoding: 'utf8', cwd: ROOT, timeout, env: process.env });
  if (r.error) return { ok: false, error: `gh 不可用：${r.error.message}` };
  if (r.status !== 0) return { ok: false, error: String(r.stderr || r.stdout || `gh exit ${r.status}`).trim().slice(0, 240) };
  return { ok: true, out: String(r.stdout || '') };
}

function scanGithub() {
  const spec = buildGithubGraphqlArgs(REPO);
  if (!spec.ok) return { scanned: false, error: spec.error };
  const gh = runGh(spec.args);
  if (!gh.ok) return { scanned: false, error: gh.error };
  const parsed = parseGithubGraphqlResponse(gh.out);
  if (!parsed.ok) return { scanned: false, error: parsed.error };
  return { scanned: true, issues: parsed.issues, prs: parsed.prs };
}

function scanOrca() {
  const wt = runOrca(['worktree', 'ps', '--json'], { cwd: ROOT });
  if (!wt.ok) return { scanned: false, error: `worktree ps 没查成：${orcaErr(wt.error)}` };
  const worktrees = wt.json?.result?.worktrees;
  if (!Array.isArray(worktrees)) return { scanned: false, error: 'worktree ps 没有 worktrees 数组——没查成' };
  return { scanned: true, worktrees };
}

function scanReviewPending() {
  let dir;
  try { dir = reviewPendingDir({ root: ROOT }); }
  catch (e) { return { scanned: false, error: `复审队列目录没定：${String(e.message || e)}` }; }
  const listed = listReviewPending(dir);
  if (!listed.ok) return { scanned: false, error: listed.error };
  const items = (listed.tickets || []).map((t) => ({
    pr: Number(t.pr), head: t.head || null, reviewer: t.reviewer || null, worker: t.workerWorktree || null,
  }));
  return { scanned: true, items };
}

// 每张 open 非 draft PR 抓审官 review 正文（判红轮 / 判绿 / 歪了都靠它）。
// 抓不到的 PR：byPr 里不填，decide 对该 PR 静默不臆测（别处若要合并会另标 unscanned）。
function scanPrReviews(prs) {
  const [owner, name] = REPO.split('/');
  const byPr = {};
  let anyFail = null;
  for (const pr of prs || []) {
    if (!pr || pr.isDraft) continue; // draft 还没交卷，不抓
    const gh = runGh(['api', `repos/${owner}/${name}/pulls/${pr.number}/reviews`, '--paginate',
      '--jq', '[.[] | {body: .body, state: .state, submitted_at: .submittedAt}]'], 30000);
    if (!gh.ok) { anyFail = gh.error; continue; }
    try {
      const arr = JSON.parse(gh.out || '[]');
      byPr[pr.number] = { reviews: arr, bodies: arr.map((x) => x.body || '') };
    } catch (e) { anyFail = String(e.message || e); }
  }
  // 只要抓到过（哪怕 0 条）就算 scanned；一条都没试成才 unscanned。
  if (Object.keys(byPr).length === 0 && anyFail) return { scanned: false, error: `reviews 没查成：${anyFail}` };
  return { scanned: true, byPr, ...(anyFail ? { partialError: anyFail } : {}) };
}

function scanStall() {
  if (!existsSync(STALL_FILE)) return { scanned: false, error: `撞死指纹文件不在（${STALL_FILE}）——#833 垫片没写，读不到 ≠ 无撞死` };
  try {
    const strikes = JSON.parse(readFileSync(STALL_FILE, 'utf8'));
    if (!strikes || typeof strikes !== 'object') return { scanned: false, error: '撞死指纹不是对象——没查成' };
    return { scanned: true, strikes };
  } catch (e) {
    return { scanned: false, error: `撞死指纹读不了：${String(e.message || e)}` };
  }
}

function orcaErr(err) {
  if (!err) return '未知';
  if (typeof err === 'string') return err.slice(0, 160);
  return (err.message || err.code || JSON.stringify(err)).slice(0, 160);
}

/** 健康表标红的模型 id。表没查成 / unknown → []（不拦，与 #842 unknown 不拦对齐）。 */
function loadHealthRedIds(models) {
  if (!Array.isArray(models) || models.length === 0) return [];
  try {
    const r = availabilityFor(models);
    return Object.entries(r.availability || {})
      .filter(([, v]) => v === 'red')
      .map(([id]) => id);
  } catch {
    return [];
  }
}

// 完整态势（scan 子命令与 act 共用）。
function buildSituation({ state } = {}) {
  const github = scanGithub();
  const orca = scanOrca();
  const reviewPending = scanReviewPending();
  const prReviews = github.scanned ? scanPrReviews(github.prs) : { scanned: false, error: 'github 没查成，跳过 reviews' };
  const stall = scanStall();
  const policy = loadDispatchPolicy({ root: ROOT });
  let routingModels = null;
  let healthRedModels = [];
  try {
    const raw = loadRoutingJsonRaw();
    const models = modelsFromJson(raw);
    routingModels = models.filter((m) => m && m.id && m.reviewerDisabled !== true).map((m) => String(m.id));
    healthRedModels = loadHealthRedIds(models);
  } catch {
    routingModels = null;
    healthRedModels = [];
  }
  return {
    at: nowIso(), repo: REPO,
    github, orca, reviewPending, prReviews, stall,
    wakeCounts: (state && state.wakeCounts) || {},
    commanderPolicy: policy.commander || { maxDispatchPerRound: 2, requireModelInRouting: true },
    routingModels,
    healthRedModels,
  };
}

function situationHealth(situation) {
  const sections = ['github', 'orca', 'reviewPending', 'prReviews', 'stall'];
  const unscanned = sections.filter((s) => !situation[s]?.scanned);
  return { unscanned, allScanned: unscanned.length === 0 };
}

// ── 手：hub 回流（带去重）──
function hubSay(text) {
  const r = spawnSync('hub-say', [text], { encoding: 'utf8', timeout: 30000 });
  if (r.error) return { ok: false, error: `hub-say 起不来：${r.error.message}（服务器上在 /home/orca/bin）` };
  if (r.status !== 0) return { ok: false, error: String(r.stderr || `hub-say exit ${r.status}`).trim().slice(0, 200) };
  return { ok: true };
}

function hubOnce({ state, key, text, now = Date.now(), dryRun }) {
  state.hubSeen = state.hubSeen || {};
  const last = Date.parse(state.hubSeen[key] || '') || 0;
  if (now - last < HUB_DEDUP_MS) return { sent: false, reason: '6 小时内已发过' };
  if (dryRun) { state.hubSeen[key] = new Date(now).toISOString(); return { sent: true, dryRun: true }; }
  const r = hubSay(text);
  if (!r.ok) return { sent: false, error: r.error };
  state.hubSeen[key] = new Date(now).toISOString();
  return { sent: true };
}

// ── 手：执行一条动作。dryRun 只回它要跑的命令，不动真环境 ──
function execAction(action, { state, dryRun, log }) {
  const say = (m) => log.push(m);
  switch (action.kind) {
    case 'dispatch': {
      const cmd = ['node', 'scripts/dao.mjs', 'dispatch',
        '--issue', String(action.issue),
        '--name', dispatchName(action.title, action.issue),
        '--model', action.model, '--reviewer', action.reviewer,
        '--split', 'no', '--split-reason', '指挥官自动派工：单块活（#800）',
        '--spec', dispatchSpec(action.issue), '--confirm'];
      return runOrShow(cmd, { dryRun, say, why: action.why });
    }
    case 'attach-reviewer': {
      // 走 blessed 路径 review-pending-drain（含归属/活性校验），一次清完队列。
      const cmd = ['node', 'scripts/dao.mjs', 'review-pending-drain'];
      return runOrShow(cmd, { dryRun, say, why: action.why });
    }
    case 'merge': {
      // 判绿 + m=auto + CI 绿 + mergeable：先同步 label（校准数据源）→ 合并 → 关单。
      const steps = [
        ['node', 'scripts/dao.mjs', 'pr-sync-labels', '--pr', String(action.pr)],
        ['node', 'scripts/gh-as.mjs', 'marshal', '--', 'pr', 'merge', String(action.pr), '--squash', '--delete-branch'],
        ['node', 'scripts/close-issues.mjs', '--pr', String(action.pr)],
      ];
      if (dryRun) { say(`[dry] merge #${action.pr}（${action.why}）：\n    ${steps.map((s) => s.join(' ')).join('\n    ')}`); return { ok: true, dryRun: true }; }
      for (const s of steps) {
        const r = runCmd(s);
        if (!r.ok) { say(`  merge 步骤失败：${s.join(' ')} → ${r.error}`); return { ok: false, error: r.error }; }
      }
      say(`  已合并 #${action.pr} 并关单`);
      return { ok: true };
    }
    case 'land':
      return runOrShow(['node', 'scripts/land.mjs'], { dryRun, say, why: action.why });
    case 'wake-brain':
      return wakeBrain(action, { state, dryRun, say });
    case 'notify-hub': {
      const link = action.pr ? prLink(action.pr) : action.issue ? issueLink(action.issue) : '';
      const text = `[指挥官] ${action.subject}${link ? '\n' + link : ''}`;
      const r = hubOnce({ state, key: `hub:${action.moment}:${action.pr || action.issue || action.subject}`, text, dryRun });
      say(`  ${r.sent ? (r.dryRun ? '[dry] ' : '') + 'hub：' + action.subject : 'hub 略：' + (r.reason || r.error)}`);
      return { ok: true };
    }
    case 'escalate':
      return escalate(action, { state, dryRun, say });
    case 'noop':
      return { ok: true };
    default:
      say(`  未知动作 kind=${action.kind}`);
      return { ok: false, error: `未知动作 ${action.kind}` };
  }
}

function dispatchName(title, issue) {
  const t = String(title || '').replace(/\s+/g, ' ').trim();
  return t || `处理 issue #${issue}`;
}
function dispatchSpec(issue) {
  // spec ≤ 500 字节，只给指针（正文在 issue，闭环在 soldier-book）。
  return `本单职责见 issue #${issue} 正文（权威范围）；闭环框架见 host/skills/dispatch/templates/soldier-book.md。指挥官自动派工（#800）。`;
}
function prLink(n) { return `https://github.com/${REPO}/pull/${n}`; }
function issueLink(n) { return `https://github.com/${REPO}/issues/${n}`; }

function runCmd(argv, timeout = 600000) {
  const r = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', cwd: ROOT, timeout, env: process.env });
  if (r.error) return { ok: false, error: `起不来：${r.error.message}` };
  if (r.status !== 0) return { ok: false, error: String(r.stderr || r.stdout || `exit ${r.status}`).trim().slice(0, 300) };
  return { ok: true, out: String(r.stdout || '') };
}
function runOrShow(argv, { dryRun, say, why }) {
  if (dryRun) { say(`[dry] ${why || ''}\n    ${argv.join(' ')}`); return { ok: true, dryRun: true }; }
  const r = runCmd(argv);
  say(`  ${r.ok ? '跑完' : '失败'}：${argv.slice(1).join(' ')}${r.ok ? '' : ' → ' + r.error}`);
  return r;
}

// 大脑：起一次性 pi 会话 + 注入指针文本；记进 state.brainSessions（含 handle），
// 由后续 act 轮回收（会话干完自行 exit；没退的到期强关，保证「进程不在」有界）。
function wakeBrain(action, { state, dryRun, say }) {
  const situFile = state._lastSituationFile || '(本轮态势文件)';
  const pointer = [
    '你是服务器指挥官的「大脑」（一次性会话，#800）。',
    `先读 host/skills/commander/SKILL.md 与态势文件 ${situFile}，`,
    `处置目标：${action.target}（${action.why}）。`,
    '边界：只许调 dao.mjs 动词 + gh issue/pr comment；不许改决策字段/协作约定文件/花钱。处置完打 exit 退出。',
  ].join('');
  const startCmd = ['node', 'scripts/dao.mjs', 'start', '--provider', 'gw', '--model', BRAIN_MODEL,
    '--worktree', BRAIN_WORKTREE, '--title', '指挥官大脑'];
  if (dryRun) {
    say(`[dry] wake-brain ${action.target}：\n    ${startCmd.join(' ')}\n    然后 dao.mjs send --terminal <handle> --enter --agent pi --text "<指针>"`);
    return { ok: true, dryRun: true };
  }
  const started = runCmd(startCmd, 180000);
  if (!started.ok) { say(`  大脑起不来：${started.error}`); return { ok: false, error: started.error }; }
  let handle = null;
  try { handle = JSON.parse(started.out).handle; } catch { /* 下面报没拿到 */ }
  if (!handle) { say('  起了大脑但没拿到 handle——没查成'); return { ok: false, error: 'no-handle' }; }
  const sent = runCmd(['node', 'scripts/dao.mjs', 'send', '--terminal', handle, '--text', pointer, '--enter', '--agent', 'pi'], 60000);
  state.brainSessions = state.brainSessions || {};
  state.brainSessions[handle] = { startedAt: nowIso(), target: action.target, model: BRAIN_MODEL };
  state.wakeCounts = state.wakeCounts || {};
  state.wakeCounts[action.target] = (state.wakeCounts[action.target] || 0) + 1;
  say(`  大脑已起 handle=${handle}（唤醒第 ${state.wakeCounts[action.target]} 次）${sent.ok ? '，指针已送' : '，但指针没送：' + sent.error}`);
  return { ok: true, handle };
}

// 回收一次性大脑：会话已下班（终端读不到/idle）或超龄 → orca terminal close。保证进程不残留。
function reapBrains({ state, dryRun, say, maxAgeMs = 30 * 60 * 1000 }) {
  const sessions = state.brainSessions || {};
  for (const [handle, meta] of Object.entries(sessions)) {
    const age = Date.now() - (Date.parse(meta.startedAt || '') || 0);
    const rd = runOrca(['terminal', 'read', '--terminal', handle, '--screen', '--json'], { cwd: ROOT });
    const gone = !rd.ok; // 读不到 = 终端已关/进程不在
    const overAge = age > maxAgeMs;
    if (gone) { delete sessions[handle]; say && say(`  大脑 ${handle} 已退（读不到终端），登记清除`); continue; }
    if (overAge) {
      if (!dryRun) runOrca(['terminal', 'close', '--terminal', handle, '--tab'], { cwd: ROOT });
      delete sessions[handle];
      say && say(`  大脑 ${handle} 超龄回收（close --tab）`);
    }
  }
  state.brainSessions = sessions;
}

// 报帅：unscanned-class 只进态势/status（静默，不刷屏——「没查成」靠 status 三态可见）；
// 报帅停手 class（two-red / missing-labels / malformed / wake-exhausted / approved-but-ci-red）
// → hub 一条（去重）+ 开「待拍板」单（gh search 查重，不重复开）。
function escalate(action, { state, dryRun, say }) {
  if (action.reason === 'unscanned') {
    say(`  没查成（静默进 status）：${action.why}`);
    return { ok: true, silent: true };
  }
  const key = escalateKey(action);
  const marker = `[commander-inventory] ${key}`; // 与盘点体检共用查重标记
  // 查重：已有 open 带此标记的单 → 不重复开
  const found = runGh(['search', 'issues', '--repo', REPO, '--state', 'open', '--match', 'body', marker, '--json', 'number', '--limit', '3'], 30000);
  let existing = null;
  if (found.ok) { try { const arr = JSON.parse(found.out || '[]'); if (arr.length) existing = arr[0].number; } catch { /* ignore */ } }
  const link = action.pr ? prLink(action.pr) : action.issue ? issueLink(action.issue) : '';
  hubOnce({ state, key: `esc:${key}`, text: `[指挥官·待拍板] ${action.why}${link ? '\n' + link : ''}`, dryRun });
  if (existing) { say(`  报帅（待拍板 #${existing} 已在，不重开）：${action.why}`); return { ok: true, issue: existing }; }
  if (dryRun) { say(`[dry] 报帅开待拍板单：${action.why}（marker=${marker}）`); return { ok: true, dryRun: true }; }
  const opened = openEscalationIssue({ title: `[待拍板] ${escalateTitle(action)}`, body: escalateBody(action, marker) });
  say(`  ${opened.ok ? '报帅开单 #' + opened.number : '报帅开单失败：' + opened.error}：${action.why}`);
  return opened;
}
function escalateKey(a) {
  const t = a.pr != null ? `pr-${a.pr}` : a.issue != null ? `issue-${a.issue}` : a.term ? `term-${a.term}` : 'x';
  return `escalate/${a.reason}/${t}`;
}
function escalateTitle(a) { return `${a.reason}：${a.pr ? 'PR #' + a.pr : a.issue ? 'issue #' + a.issue : a.term || ''}`.trim(); }
function escalateBody(a, marker) {
  return [
    `指挥官报帅（#800「报帅停手」）：`,
    ``,
    `- 原因：${a.reason}`,
    `- 详情：${a.why}`,
    a.pr ? `- PR：${prLink(a.pr)}` : a.issue ? `- issue：${issueLink(a.issue)}` : '',
    ``,
    `指挥官不自动处置这类，等你拍板。查重标记（勿删）：${marker}`,
  ].filter(Boolean).join('\n');
}
function openEscalationIssue({ title, body }) {
  ensureDir(STATE_DIR);
  const bodyFile = join(STATE_DIR, `escalate-${Date.now()}.md`);
  writeFileSync(bodyFile, body, 'utf8');
  const r = runCmd(['node', 'scripts/gh-as.mjs', 'marshal', '--', 'issue', 'create',
    '--repo', REPO, '--title', title, '--body-file', bodyFile, '--label', '待拍板'], 60000);
  if (!r.ok) return { ok: false, error: r.error };
  const m = String(r.out).match(/\/issues\/(\d+)/);
  return { ok: true, number: m ? Number(m[1]) : null };
}

// ── 子命令 ──
function cmdScan() {
  const state = loadState();
  const situation = buildSituation({ state });
  ensureDir(STATE_DIR);
  const file = join(STATE_DIR, `situation-${situation.at.replace(/[:.]/g, '-')}.json`);
  writeFileSync(file, JSON.stringify(situation, null, 2), 'utf8');
  const health = situationHealth(situation);
  const summary = {
    at: situation.at, file,
    unscanned: health.unscanned,
    counts: {
      issues: situation.github.scanned ? situation.github.issues.length : null,
      prs: situation.github.scanned ? situation.github.prs.length : null,
      reviewPending: situation.reviewPending.scanned ? situation.reviewPending.items.length : null,
    },
  };
  console.log(JSON.stringify(summary, null, 2));
  process.exit(health.allScanned ? 0 : 2);
}

function cmdAct(argv) {
  const dryRun = argv.includes('--dry-run');
  const state = loadState();
  const situation = buildSituation({ state });
  // 落态势文件供大脑读
  ensureDir(STATE_DIR);
  const file = join(STATE_DIR, `situation-${situation.at.replace(/[:.]/g, '-')}.json`);
  writeFileSync(file, JSON.stringify(situation, null, 2), 'utf8');
  state._lastSituationFile = file;

  const { actions } = decide(situation);
  const log = [];
  // 先回收上一轮的大脑（保证一次性会话不残留）
  reapBrains({ state, dryRun, say: (m) => log.push(m) });
  for (const action of actions) {
    log.push(`· ${action.kind}${action.why ? '（' + action.why + '）' : ''}`);
    execAction(action, { state, dryRun, log });
  }
  // 心跳：一切正常连续静默 → 一条（假时钟走 state 的锚点）
  if (hasLiveAction(actions)) state.lastActivityAt = nowIso();
  else {
    const hb = heartbeatDue({ state });
    if (hb.due) {
      const r = dryRun ? { sent: true, dryRun: true } : hubSay('[指挥官] 一切正常，连续 7 天静默——心跳一条（沉默要能与死机区分）');
      if (r.sent || r.ok) { state.lastHeartbeatAt = nowIso(); log.push(`  心跳已发（${hb.reason}）`); }
    }
  }
  if (!dryRun) saveState(state); // dry-run 无副作用：不落 state（hubSeen/wakeCounts/回收登记都不持久化）
  const digest = actionsDigest(actions);
  console.log(JSON.stringify({ at: situation.at, dryRun, situationFile: file,
    unscanned: situationHealth(situation).unscanned, actions: actions.map(summarizeAction), digest }, null, 2));
  console.error(log.join('\n'));
  process.exit(0);
}
function summarizeAction(a) {
  const o = { kind: a.kind };
  for (const k of ['issue', 'pr', 'target', 'term', 'reason', 'moment', 'model', 'reviewer', 'missing']) if (a[k] != null) o[k] = a[k];
  return o;
}

const CMDS = { scan: cmdScan, act: cmdAct };

function main() {
  const [, , sub, ...rest] = process.argv;
  if (!sub || sub === '--help' || sub === '-h') {
    console.log(`用法: node scripts/commander.mjs <scan|act|inventory|status|install> [--dry-run]

  scan       眼睛：产态势 JSON 落 ~/.dao/commander/（三态退出：0 全查成 / 2 有没查成）
  act        scan → decide → 执行动作（--dry-run 只打印命令）
  inventory  盘点体检：异常开「待拍板」单，正常静默（--dry-run 只打印）
  status     自检三态（0 通 / 1 红 / 2 没查成），供 server-check 一行引用
  install    幂等写 systemd service+timer（act 每 20 分钟、inventory 每 6 小时；--dry-run 只打印）`);
    process.exit(0);
  }
  if (sub === 'inventory') return import('./lib/commander-inventory.mjs').then((m) => m.runInventory({ rest, ROOT, REPO, STATE_DIR, runGh, runOrca, hubOnce, openEscalationIssue, loadState, saveState }));
  if (sub === 'status') return import('./lib/commander-inventory.mjs').then((m) => m.runStatus({ rest, ROOT }));
  if (sub === 'install') return import('./lib/commander-inventory.mjs').then((m) => m.runInstall({ rest, ROOT }));
  const fn = CMDS[sub];
  if (!fn) { console.error(`未知子命令：${sub}`); process.exit(2); }
  fn(rest);
}

const isDirectRun = process.argv[1] && resolve(process.argv[1]) === HERE;
if (isDirectRun) main();

export { buildSituation, situationHealth, escalateKey };
