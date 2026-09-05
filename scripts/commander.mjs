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
import {
  reviewPendingDir, listReviewPending, writeReviewPending,
  REVIEW_PENDING_KIND, REVIEW_PENDING_VERSION,
} from './lib/dispatch/review-pending.mjs';
import { doorOf, classifyDaipai, TWO_WAY_DEADLINE_MS, DAIPAI_MAX_PER_ROUND } from './lib/daipai.mjs';
import {
  decide, heartbeatDue, hasLiveAction, actionsDigest, reworkKey,
} from './lib/commander-core.mjs';
import { buildSoldierInject } from './lib/dispatch/template.mjs';
import { loadDispatchPolicy } from './lib/preflight.mjs';
import { loadRoutingJsonRaw, modelsFromJson } from './lib/model-routing-json.mjs';
import { availabilityFor } from './lib/provider-health.mjs';
import { runBreakerCommand } from './lib/provider-breaker.mjs';
import { stallWatchPath } from './lib/agent-stall-detect.mjs';

const HERE = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(HERE), '..');
const REPO = process.env.COMMANDER_REPO || DEFAULT_REPO;

// 仓外落点（检查器输出不落在自己会读的范围内，CLAUDE.md）。
const STATE_DIR = process.env.COMMANDER_STATE_DIR || join(homedir(), '.dao', 'commander');
const STATE_PATH = join(STATE_DIR, 'state.json');
const STALL_FILE = process.env.AGENT_STALL_WATCH_FILE || stallWatchPath(homedir());
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
  const r = spawnSync(ghExecutable(), args, { windowsHide: true, encoding: 'utf8', cwd: ROOT, timeout, env: process.env });
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
    // commit_id 必取：判红/判绿只对它当时看的那个 commit 有效（#911）。
    // 取不到 commit_id 的判别态 review = 没查成，不是「旧红」也不是「新红」。
    const gh = runGh(['api', `repos/${owner}/${name}/pulls/${pr.number}/reviews`, '--paginate',
      '--jq', '[.[] | {body: .body, state: .state, submitted_at: .submitted_at, commit_id: .commit_id}]'], 30000);
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

/** #843：周期面把健康表 red / 撞死指纹记进熔断表（只记事件，判定在 applyEvent）。失败不挡 scan。 */
function ingestBreakerSignals({ now = Date.now() } = {}) {
  try {
    const policy = loadDispatchPolicy({ root: ROOT });
    const health = runBreakerCommand({ action: 'ingest-health' }, { now, policy: policy.breaker });
    const stall = runBreakerCommand({ action: 'ingest-stall' }, { now, policy: policy.breaker });
    return { ok: true, health, stall };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

function scanStall() {
  if (!existsSync(STALL_FILE)) return { scanned: false, error: `撞死指纹文件不在（${STALL_FILE}）——#833 正式连红账本没写，读不到 ≠ 无撞死` };
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

/**
 * 选型里「写码」责任的首选在役模型 id——返工派不出原模型时的顶班人选。
 * 只取顺位最小且未禁用的一条；读不到返回 null（调用侧按「没有顶班人选」走，不猜）。
 */
function pickDefaultWorkerModel(raw) {
  const list = raw && raw['工人'] && raw['工人']['写码'] && Array.isArray(raw['工人']['写码']['模型'])
    ? raw['工人']['写码']['模型'] : null;
  if (!list) return null;
  const live = list
    .filter((m) => m && m.id && m['禁用'] !== true && typeof m['顺位'] === 'number')
    .sort((a, b) => a['顺位'] - b['顺位']);
  return live.length ? String(live[0].id) : null;
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
  let defaultWorkerModel = null;
  try {
    const raw = loadRoutingJsonRaw();
    const models = modelsFromJson(raw);
    routingModels = models.filter((m) => m && m.id && m.reviewerDisabled !== true).map((m) => String(m.id));
    healthRedModels = loadHealthRedIds(models);
    defaultWorkerModel = pickDefaultWorkerModel(raw);
  } catch {
    routingModels = null;
    healthRedModels = [];
    defaultWorkerModel = null;
  }
  const breakerIngest = ingestBreakerSignals();
  return {
    at: nowIso(), repo: REPO,
    github, orca, reviewPending, prReviews, stall,
    breakerIngest,
    wakeCounts: (state && state.wakeCounts) || {},
    reworkDispatched: (state && state.reworkDispatched) || {},
    commanderPolicy: policy.commander || { maxDispatchPerRound: 2, requireModelInRouting: true },
    routingModels,
    healthRedModels,
    defaultWorkerModel,
  };
}

function situationHealth(situation) {
  const sections = ['github', 'orca', 'reviewPending', 'prReviews', 'stall'];
  const unscanned = sections.filter((s) => !situation[s]?.scanned);
  return { unscanned, allScanned: unscanned.length === 0 };
}

// ── 手：hub 回流（带去重）──
function hubSay(text) {
  // hub-say 在服务器上装在 /home/orca/bin，而 systemd/ssh 的 PATH 里没有它——
  // 只 spawn 裸名字会 ENOENT，回流总控群整条哑掉且只在日志里留一行（2026-09-05 实咬）。
  let r = spawnSync('hub-say', [text], { windowsHide: true, encoding: 'utf8', timeout: 30000 });
  if (r.error && r.error.code === 'ENOENT') {
    for (const cand of [process.env.DAO_HUB_SAY, '/home/orca/bin/hub-say'].filter(Boolean)) {
      if (!existsSync(cand)) continue;
      r = spawnSync(cand, [text], { windowsHide: true, encoding: 'utf8', timeout: 30000 });
      break;
    }
  }
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
      // dispatch 是**异步**的：热路只写派工单+拉起执行体就 exit 0（「已受理」），
      // 真结果落 resultPath。只看退出码 = 把「受理了」当「派成了」——
      // 2026-09-04 实咬：#787 工人 TUI 等就绪失败，指挥官照样报「跑完」并往群里发「已自动派单」。
      const r = runOrShow(cmd, { dryRun, say, why: action.why });
      if (dryRun) { say('  [dry] 真跑时会回读派工结果文件，失败则不发「已自动派单」并报帅'); return r; }
      if (!r.ok) return r;
      return awaitDispatchResult(r.out, { say });
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
    case 'rework':
      return dispatchRework(action, { state, dryRun, say });
    case 'rereview':
      return requestRereview(action, { state, dryRun, say });
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
  const r = spawnSync(argv[0], argv.slice(1), { windowsHide: true, encoding: 'utf8', cwd: ROOT, timeout, env: process.env });
  if (r.error) return { ok: false, error: `起不来：${r.error.message}` };
  if (r.status !== 0) return { ok: false, error: String(r.stderr || r.stdout || `exit ${r.status}`).trim().slice(0, 300) };
  return { ok: true, out: String(r.stdout || '') };
}
/** 从 dispatch 的「已受理」输出里取 resultPath。拿不到 → null（调用方按没查成处理）。 */
export function resultPathOf(stdout) {
  const text = String(stdout || '');
  const start = text.indexOf('{');
  if (start < 0) return null;
  try {
    const j = JSON.parse(text.slice(start));
    return typeof j.resultPath === 'string' && j.resultPath ? j.resultPath : null;
  } catch { return null; }
}

/** 纯函数：把 out.json 的内容判成三态。没落盘 = 没查成（既不算成也不算败）。 */
export function classifyDispatchResult({ present, doc, waitedMs }) {
  if (!present) {
    return { ok: false, unscanned: true, error: `派工结果还没落盘（等了 ${Math.round(waitedMs / 1000)}s）——受理了但成没成没查成，下一轮再看` };
  }
  if (!doc || typeof doc !== 'object') return { ok: false, unscanned: true, error: '派工结果不是 JSON（没查成）' };
  if (doc.ok === true) return { ok: true, card: doc.workerCard || '', issue: doc.issue || '' };
  return { ok: false, unscanned: false, error: String(doc.error || '执行体报失败但没给原因').slice(0, 200) };
}

/**
 * 逐条执行动作，并管住一条纪律：**派工没成，就不许再发「已自动派单」**
 * （2026-09-04 实咬：#787 派工其实失败了，群里照样收到喜报——报喜不报忧比不报还坏）。
 * exec 可注入，所以这条纪律测得到；dry-run 也走这里，预览里同样看得见抑制与报帅。
 */
export const DISPATCHING_KINDS = new Set(['dispatch', 'rework']);

export function runActions(actions, { exec, log = [] } = {}) {
  const failedIssues = new Set();
  const failedPrs = new Set(); // 返工的随附回流按 PR 号挂，不按 issue（#931）
  for (const action of Array.isArray(actions) ? actions : []) {
    if (action.kind === 'notify-hub'
      && ((action.issue != null && failedIssues.has(String(action.issue)))
        || (action.pr != null && failedPrs.has(String(action.pr))))) {
      log.push(`· notify-hub 略：${action.pr != null ? 'PR #' + action.pr : '#' + action.issue} 派工没成，不发喜报`);
      continue;
    }
    log.push(`· ${action.kind}${action.why ? '（' + action.why + '）' : ''}`);
    const r = exec(action);
    // dry-run 也要判：预览若照打「已自动派单」，这条纪律就等于没上线
    const failed = DISPATCHING_KINDS.has(action.kind) && action.issue != null
      && (!r || (r.ok !== true) || r.dispatchFailed === true);
    if (!failed) continue;
    failedIssues.add(String(action.issue));
    if (action.pr != null) failedPrs.add(String(action.pr));
    const isRework = action.kind === 'rework';
    exec({
      kind: 'escalate',
      reason: r && r.unscanned
        ? (isRework ? 'rework-unscanned' : 'dispatch-unscanned')
        : (isRework ? 'rework-failed' : 'dispatch-failed'),
      issue: action.issue,
      ...(action.pr != null ? { pr: action.pr } : {}),
      why: isRework
        ? `PR #${action.pr} 自动派返工工人${r && r.unscanned ? '成没成没查成' : '失败'}：${(r && r.error) || ''}——同 head 不自动重派，交帅`
        : `#${action.issue} 自动派工${r && r.unscanned ? '成没成没查成' : '失败'}：${(r && r.error) || ''}`,
    });
  }
  return { log, failedIssues: [...failedIssues], failedPrs: [...failedPrs] };
}

/** 主线程同步睡。指挥官是 oneshot，阻塞期间本来也没别的事要做，所以不改 async 范式。
 *  不用 spawnSync(node -e setTimeout)：起不来子进程时（服务器 fork EAGAIN/内存紧）它立刻返回，
 *  循环就退化成满速热转直到预算耗尽；而且正常路径上一次等待要 80 次 node 冷启动。 */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** 回读异步派工的真结果：轮询 resultPath 直到落盘或超时。 */
function awaitDispatchResult(stdout, { say, budgetMs = 240000, stepMs = 3000, nowFn = Date.now } = {}) {
  const path = resultPathOf(stdout);
  if (!path) { say('  派工受理了，但输出里没有结果文件路径——成没成没查成'); return { ok: false, unscanned: true, error: '拿不到 resultPath' }; }
  const t0 = nowFn();
  let doc = null;
  let present = false;
  while (nowFn() - t0 < budgetMs) {
    if (existsSync(path)) {
      present = true;
      try { doc = JSON.parse(readFileSync(path, 'utf8')); } catch { doc = null; }
      if (doc) break;
    }
    sleepSync(stepMs);
  }
  const verdict = classifyDispatchResult({ present, doc, waitedMs: nowFn() - t0 });
  say(`  派工真结果：${verdict.ok ? '成了（' + (verdict.card || '') + '）' : (verdict.unscanned ? '没查成——' : '失败——') + verdict.error}`);
  return verdict;
}

function runOrShow(argv, { dryRun, say, why }) {
  if (dryRun) { say(`[dry] ${why || ''}\n    ${argv.join(' ')}`); return { ok: true, dryRun: true }; }
  const r = runCmd(argv);
  say(`  ${r.ok ? '跑完' : '失败'}：${argv.slice(1).join(' ')}${r.ok ? '' : ' → ' + r.error}`);
  return r;
}

// ── 返工（#931，用户 2026-09-05 拍板）：审官在**当前 head** 上判红 → 直接派一个返工工人。
// 删掉了原来的「先唤大脑翻译返工方向、送达工人终端、唤满 WAKE_LIMIT 才报帅」整层——
// 工人判红时早已下班，大脑的方案没有接收者（补丁链层 2 落闸，见 issue #931）。
// 审官标准本就要求红项写「文件:行号 + 现象 + 期望改法」，工人照着改即可，中间那层翻译价值可疑。
//
// 硬约束（都是本仓交过学费的判据）：
//   · 注入 ≤500 字节是硬闸（#602/#619），红项**全文**塞不进任务书 —— 全文落仓外文件，注入只给指针。
//   · 写完必须**读回自证**：读不回 / 对不上 = 没查成，不派工（半截任务书比不派更坏）。
//   · dispatch 是**异步**的（#787）：只看退出码 = 把「受理了」当「派成了」，必须回读结果文件判三态。
//   · 同一 PR 同一 head 只派一次：记账落 state.reworkDispatched，**尝试即记**——
//     失败/没查成不自动重派（重派会造重复工人），改由 runActions 报帅，人来决定。

/** 红项全文的仓外落点（生成物不落进自己会读的仓内范围，CLAUDE.md）。 */
export function reworkBriefPath(action, { dir = null } = {}) {
  return join(dir || join(STATE_DIR, 'rework'), `pr-${action.pr}-${String(action.head || '').slice(0, 8)}.md`);
}

/** 红项全文正文：原样转录，不摘要、不改写（#931 的整个理由就是「别再让 AI 翻译一遍」）。 */
export function reworkBriefText(action) {
  return [
    `# 返工任务：PR #${action.pr}`,
    '',
    `- 审官红项打在 head ${action.head} 上；署名 issue #${action.issue}`,
    `- 当前 head 上的判红轮数：${action.redRounds}`,
    '- 下面是审官那条 CHANGES_REQUESTED review 的**正文全文**（未摘要、未改写）：',
    '',
    '---',
    '',
    String(action.brief || ''),
    '',
  ].join('\n');
}

/** 写红项全文 + 读回自证。写不下去 / 读不回 / 对不上 → 没查成（不派、也不当成功）。 */
export function writeReworkBrief(action, { io: fsio = null, dir = null } = {}) {
  const path = reworkBriefPath(action, { dir });
  const text = reworkBriefText(action);
  const writer = fsio || { mkdir: (d) => ensureDir(d), write: writeFileSync, read: readFileSync };
  try {
    writer.mkdir(dirname(path));
    writer.write(path, text, 'utf8');
  } catch (e) {
    return { ok: false, unscanned: true, error: `红项全文写不下去（${path}）：${String(e.message || e).slice(0, 160)}` };
  }
  let back = null;
  try { back = writer.read(path, 'utf8'); }
  catch (e) { return { ok: false, unscanned: true, error: `红项全文写了读不回（${path}）：${String(e.message || e).slice(0, 160)}` }; }
  if (back !== text) return { ok: false, unscanned: true, error: `红项全文读回对不上（${path}）——不拿半截任务书派工` };
  return { ok: true, path, bytes: Buffer.byteLength(text, 'utf8') };
}

/** 返工卡名与注入指针。注入不带正文，只给「怎么切到 PR 分支 + 全文在哪」。 */
export function reworkCardName(action) { return `返工 PR #${action.pr}`; }
export function reworkSpec(action, briefPath) {
  return `返工 PR #${action.pr}：先 gh pr checkout ${action.pr} 切到该 PR 分支（改在本分支，别开新 PR）；审官红项全文在 ${briefPath}，逐条改完交卷。`;
}

/**
 * 叫审官复审：写一张复审待办票，交给已有的 review-pending drain 去消费。
 * 不在这里直接起审官——一 PR 一审官的闸、复用还是新建、缺士兵树走不走快马路，全在 drain/reviewer-create 那一侧，
 * 这里再判一遍就是第二套判据（2026-09-05：#890/#893/#896/#905 推了新 head 后没人叫审官，挂了 10 小时）。
 * 同一 PR 同一 head 只写一次：记 state.reworkDispatched[rereview:<pr>@<oid>]（与返工共用一张记账表，键前缀区分）。
 */
function requestRereview(action, { state, dryRun, say }) {
  if (!action.reviewer) {
    const error = `PR #${action.pr} 要复审，但署名 issue 上没有 reviewer/ 标签——不猜审官`;
    say(`  ${error}`);
    return { ok: false, error };
  }
  const dir = reviewPendingDir({ root: ROOT });
  const ticket = {
    kind: REVIEW_PENDING_KIND,
    v: REVIEW_PENDING_VERSION,
    pr: String(action.pr),
    head: { name: null, oid: action.head || null },
    workerWorktree: null,
    reviewer: String(action.reviewer),
    issue: action.issue == null ? null : String(action.issue),
    round: 'rereview',
    workerModel: null,
    soldierDispatch: null,
    error: `指挥官自动叫复审：${action.why}`,
    ts: nowIso(),
  };
  if (dryRun) {
    say(`[dry] 写复审待办 ${dir}/${action.pr}.json（${action.why}）`);
    return { ok: true, dryRun: true };
  }
  const w = writeReviewPending({ dir, ticket });
  if (!w.ok) { say(`  复审待办写不进去：${w.error}`); return { ok: false, error: w.error }; }
  state.reworkDispatched = state.reworkDispatched || {};
  state.reworkDispatched[action.stateKey || `rereview:${action.pr}@${action.head}`] = {
    at: nowIso(), pr: action.pr, head: action.head, kind: 'rereview', ticket: w.path,
  };
  say(`  已写复审待办 ${w.path}（drain 下一轮消费）`);
  return { ok: true, path: w.path };
}

function dispatchRework(action, { state, dryRun, say }) {
  const written = writeReworkBrief(action);
  if (!written.ok) { say(`  ${written.error}`); return { ok: false, unscanned: true, error: written.error }; }
  const spec = reworkSpec(action, written.path);
  // 注入字节闸先在本地过一遍：超限当场说清楚，别等后台执行体崩（dispatch 热路也会拦，这里只是早一步可读）。
  try { buildSoldierInject({ spec, issue: action.issue }); }
  catch (e) {
    const error = `返工注入过不了字节闸：${String(e.message || e).slice(0, 200)}`;
    say(`  ${error}`);
    return { ok: false, error };
  }
  // --allow-dup：底层去重按 issue 判（#759 定的，卡名不补刀，因为自动卡名会变），
  // 而快马多张 PR 共用一个署名 issue——同轮返工 #894 会把 #899 一起挡掉，第二张红没人接（2026-09-05 实咬）。
  // 返工这条路自己已有更准的去重：state.reworkDispatched 按 PR+head「尝试即记」（上面第 510 行），
  // 同一 PR 同一 head 永不重派。所以这里显式放行 issue 级去重，不动通用判据。
  const cmd = ['node', 'scripts/dao.mjs', 'dispatch',
    '--issue', String(action.issue),
    '--name', reworkCardName(action),
    '--model', action.model, '--reviewer', action.reviewer,
    '--split', 'no', '--split-reason', '指挥官自动返工：照审官红项逐条改（#931）',
    '--spec', spec, '--allow-dup', '--confirm'];
  if (dryRun) {
    say(`[dry] rework PR #${action.pr}（${action.why}）：\n    红项全文 ${written.path}（${written.bytes} 字节，已读回自证）\n    ${cmd.join(' ')}\n    [dry] 真跑时回读派工结果文件判三态，失败则不发「已派返工工人」并报帅`);
    return { ok: true, dryRun: true };
  }
  const started = runOrShow(cmd, { dryRun: false, say, why: action.why });
  const verdict = started.ok ? awaitDispatchResult(started.out, { say }) : started;
  // 尝试即记：同一 PR 同一 head 不再自动重派（重派会造重复工人）。成没成一起记下，便于人判。
  state.reworkDispatched = state.reworkDispatched || {};
  state.reworkDispatched[action.reworkKey || reworkKey(action.pr, action.head)] = {
    at: nowIso(), pr: action.pr, head: action.head, issue: action.issue,
    brief: written.path, ok: verdict.ok === true, unscanned: verdict.unscanned === true,
  };
  return verdict;
}

// 大脑：起一次性 pi 会话 + 注入指针文本；记进 state.brainSessions（含 handle），
// 由后续 act 轮回收（会话干完自行 exit；没退的到期强关，保证「进程不在」有界）。
function wakeBrain(action, { state, dryRun, say }) {
  const situFile = state._lastSituationFile || '(本轮态势文件)';
  const pointer = [
    '你是服务器指挥官的「大脑」（一次性会话，#800）。',
    `先读 host/skills/commander/SKILL.md 与态势文件 ${situFile}，`,
    `处置目标：${action.target}（${action.why}）。`,
    '职责（2026-09-04 拍板）：给出具体解决方案（改哪里、验收判据），落痕到对应单后必须用 dao.mjs send/notify 送达工人或审官终端推动闭环——只留评论不算送达；终端死了或送不动，在单上写明「给了什么方案、送到哪、为什么没动」再报帅。',
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
  // 会话登记与送达无关：进程已经起来了，回收（reapBrains）必须认得它，否则送失败就漏一个孤儿大脑。
  state.brainSessions[handle] = { startedAt: nowIso(), target: action.target, model: BRAIN_MODEL };
  if (!sent.ok) {
    // 指针没送到 = 这次唤醒没发生：**不计预算**（审官红项 2026-09-04）。
    // 递增会让「唤满三次转报帅」在大脑其实一次都没被告知的情况下提前触发——把投递故障算成大脑无能。
    say(`  大脑起了但指针没送：${sent.error}——不计唤醒次数（没送达 ≠ 唤过），下一轮重试`);
    return { ok: false, error: `指针没送达：${sent.error}`, handle };
  }
  state.wakeCounts = state.wakeCounts || {};
  // #931 后唤大脑只剩撞死指纹（`stall:<term>`）与代拍（`daipai:issue-<n>`）两条路，
  // 都按 target 记账。PR 判红改走 rework（返工工人），不再有唤醒预算。
  state.wakeCounts[action.target] = (state.wakeCounts[action.target] || 0) + 1;
  say(`  大脑已起 handle=${handle}（唤醒第 ${state.wakeCounts[action.target]} 次），指针已送`);
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

// ── 代拍：双向门待拍板单到期无人回复 → 唤大脑按推荐项执行（2026-09-04 拍板「双门制+超时代拍」）。
// 判据全在 lib/daipai.mjs 纯函数里；这里只做 gh 取数 + 唤醒 + hub 留痕。没查成一律不代拍。──
function runDaipai({ state, dryRun, say }) {
  const found = runGh(['search', 'issues', '--repo', REPO, '--state', 'open', '--match', 'body',
    '门类：双向门', '--json', 'number', '--limit', '10'], 30000);
  if (!found.ok) { say(`  代拍扫描没查成：${found.error}（没查成不代拍）`); return; }
  let nums = [];
  try { nums = JSON.parse(found.out || '[]').map((x) => x.number); } catch { say('  代拍扫描输出解析不了——没查成不代拍'); return; }
  let fired = 0;
  for (const n of nums) {
    if (fired >= DAIPAI_MAX_PER_ROUND) { say(`  代拍到本轮上限 ${DAIPAI_MAX_PER_ROUND}，其余下轮`); break; }
    const v = runGh(['issue', 'view', String(n), '--repo', REPO, '--json', 'body,createdAt,comments'], 30000);
    if (!v.ok) { say(`  代拍 #${n} 读不到——没查成跳过`); continue; }
    let doc = null;
    try { doc = JSON.parse(v.out); } catch { say(`  代拍 #${n} 输出解析不了——跳过`); continue; }
    const cls = classifyDaipai({ body: doc.body, createdAt: doc.createdAt, comments: doc.comments });
    if (!cls.daipai) { if (cls.unscanned) say(`  代拍 #${n} ${cls.why}——不代拍`); continue; }
    const woken = (state.wakeCounts || {})[`daipai:issue-${n}`] || 0;
    if (woken >= 2) { say(`  代拍 #${n} 已唤 ${woken} 次没闭环——不再唤，等人`); continue; }
    hubOnce({ state, key: `daipai:${n}`, text: `[指挥官·代拍] 待拍板 #${n} 双向门到期无人回复，按单内推荐项代拍（可翻案）\n${issueLink(n)}`, dryRun });
    wakeBrain({ target: `daipai:issue-${n}`, issue: n,
      why: `待拍板 #${n} 双向门到期 ${Math.round(TWO_WAY_DEADLINE_MS / 3600000)} 小时无人回复——读单内「推荐项」在边界内执行，做完在单上评论「已代拍：做了什么、怎么翻案」；超边界就写明卡在哪、不动` },
      { state, dryRun, say });
    fired += 1;
  }
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
  const door = doorOf(a.reason); // 双门制（2026-09-04 拍板）：确定性表判门，不靠模型现场判断
  const hours = Math.round(TWO_WAY_DEADLINE_MS / 3600000);
  return [
    `指挥官报帅（#800「报帅停手」）：`,
    ``,
    `- 原因：${a.reason}`,
    `- 详情：${a.why}`,
    a.pr ? `- PR：${prLink(a.pr)}` : a.issue ? `- issue：${issueLink(a.issue)}` : '',
    door === 'two-way'
      ? `- 门类：双向门（可翻案）——${hours} 小时无人回复，指挥官唤大脑按下面推荐项代拍并标「已代拍」`
      : `- 门类：单向门（花钱/换人/不可逆）——只等拍板，超时不动（高风险超时=拒绝）`,
    door === 'two-way' ? `- 推荐项：${a.recommend || '大脑边界内处置：定位问题 → 给方案 → 送达相关终端'}` : '',
    ``,
    `- 机制判定（处置人必填，2026-09-04 拍板）：这错在制度生效前还会再犯吗？会 → 机制改在哪（垫片/开单/PR 链接）；不会 → 为什么。答不出就写「没查成」，不许留空。`,
    ``,
    door === 'two-way'
      ? `到期无人回复会代拍；要拦住就在本单说一句（任何回复都会拦住代拍）。查重标记（勿删）：${marker}`
      : `指挥官不自动处置这类，等你拍板。查重标记（勿删）：${marker}`,
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
  runActions(actions, { exec: (a) => execAction(a, { state, dryRun, log }), log });
  runDaipai({ state, dryRun, say: (m) => log.push(m) }); // 双门制：双向门到期无人回复 → 唤大脑代拍
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
