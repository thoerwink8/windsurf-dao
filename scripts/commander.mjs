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
// 一次性会话的寿命上限。**改这个数就等于改巡检任务书里写给会话的那个数**——
// 任务书按它算「先落最小报告再深挖」的时间预算，两处对不上就是在骗那个会话。
const BRAIN_MAX_AGE_MS = 30 * 60 * 1000;
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

/**
 * 别的仓有没有事挂着。**只感知，不派工**——派工链（worktree/终端/审官）只在本仓有。
 *
 * 2026-09-05：用户把 bot 的仓授权从 1 个扩到 6 个。在那之前帅位对别的仓完全无感：
 * ai-gateway-stack 挂着 3 条 open issue 而它是本仓派工链的上游，网关坏了整条链跟着坏。
 * 管辖清单不另外维护——**授权范围本身就是那张清单**：授权加一个仓这里自动多一个，
 * 撤销自动少一个，不会像手写清单那样过期。
 */
function scanOtherRepos() {
  const owner = String(REPO || '').split('/')[0];
  if (!owner) return { scanned: false, error: 'REPO 里读不出 owner——没查成' };
  const grab = (kind) => {
    const gh = runGh(['search', kind, '--owner', owner, '--state', 'open',
      '--limit', '100', '--json', 'repository,number,title'], 60000);
    if (!gh.ok) return null;
    try { const v = JSON.parse(gh.out); return Array.isArray(v) ? v : null; } catch { return null; }
  };
  const issues = grab('issues');
  const prs = grab('prs');
  if (issues == null || prs == null) return { scanned: false, error: '跨仓 search 没查成（授权或网络）' };
  const mine = String(REPO);
  const byRepo = new Map();
  for (const [kind, list] of [['issue', issues], ['pr', prs]]) {
    for (const x of list) {
      const full = x?.repository?.nameWithOwner || x?.repository?.name;
      if (!full || full === mine || String(full).endsWith('/' + mine.split('/')[1])) continue;
      if (!byRepo.has(full)) byRepo.set(full, { repo: full, issues: 0, prs: 0, samples: [] });
      const e = byRepo.get(full);
      if (kind === 'issue') e.issues += 1; else e.prs += 1;
      if (e.samples.length < 3) e.samples.push(`#${x.number} ${String(x.title || '').slice(0, 50)}`);
    }
  }
  return { scanned: true, repos: [...byRepo.values()] };
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
  const otherRepos = scanOtherRepos();
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
    github, orca, reviewPending, prReviews, stall, otherRepos,
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

/**
 * 落一份任务书全文 + 读回自证。写不下去 / 读不回 / 对不上 → 没查成（不派、也不当成功）。
 * 返工和巡检共用这一把尺：注入永远只给指针，全文永远落文件，而「落了」必须是读回来对上的那种落了。
 */
export function writeBriefVerified({ path, text, io: fsio = null, what = '任务书' }) {
  const writer = fsio || { mkdir: (d) => ensureDir(d), write: writeFileSync, read: readFileSync };
  try {
    writer.mkdir(dirname(path));
    writer.write(path, text, 'utf8');
  } catch (e) {
    return { ok: false, unscanned: true, error: `${what}写不下去（${path}）：${String(e.message || e).slice(0, 160)}` };
  }
  let back = null;
  try { back = writer.read(path, 'utf8'); }
  catch (e) { return { ok: false, unscanned: true, error: `${what}写了读不回（${path}）：${String(e.message || e).slice(0, 160)}` }; }
  if (back !== text) return { ok: false, unscanned: true, error: `${what}读回对不上（${path}）——不拿半截任务书派工` };
  return { ok: true, path, bytes: Buffer.byteLength(text, 'utf8') };
}

/** 写红项全文 + 读回自证。写不下去 / 读不回 / 对不上 → 没查成（不派、也不当成功）。 */
export function writeReworkBrief(action, { io: fsio = null, dir = null } = {}) {
  return writeBriefVerified({
    path: reworkBriefPath(action, { dir }), text: reworkBriefText(action), io: fsio, what: '红项全文',
  });
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
// action.pointer / action.title 可覆写：巡检（cmdPatrol）用同一条起会话+登记+回收的路，
// 只换注入那句话和卡名。**不许为别的用途另写一份 start/send/登记**——回收只认 state.brainSessions，
// 另写一套就等于造一批没人回收的孤儿会话（本机那版巡检半天堆了几十个，就是这么来的）。
function wakeBrain(action, { state, dryRun, say }) {
  const situFile = state._lastSituationFile || '(本轮态势文件)';
  const pointer = action.pointer || [
    '你是服务器指挥官的「大脑」（一次性会话，#800）。',
    `先读 host/skills/commander/SKILL.md 与态势文件 ${situFile}，`,
    `处置目标：${action.target}（${action.why}）。`,
    '职责（2026-09-04 拍板）：给出具体解决方案（改哪里、验收判据），落痕到对应单后必须用 dao.mjs send/notify 送达工人或审官终端推动闭环——只留评论不算送达；终端死了或送不动，在单上写明「给了什么方案、送到哪、为什么没动」再报帅。',
    '边界：只许调 dao.mjs 动词 + gh issue/pr comment；不许改决策字段/协作约定文件/花钱。处置完打 exit 退出。',
  ].join('');
  const startCmd = ['node', 'scripts/dao.mjs', 'start', '--provider', 'gw', '--model', BRAIN_MODEL,
    '--worktree', BRAIN_WORKTREE, '--title', action.title || '指挥官大脑'];
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
function reapBrains({ state, dryRun, say, maxAgeMs = BRAIN_MAX_AGE_MS }) {
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

// ── 巡检（2026-09-05）：定时脚本只找得到「见过的失败形态」。当天真正被翻出来的两个洞
// （定时任务以 root 解释 orca 可写的脚本、活性判据的盲区）一个脚本都没报，是一个会话主动去翻才发现的。
// 所以留一条「让一个会话定期去翻」的路，专找脚本查不出的那类。
//
// 改这段之前必须知道的四件事：
//   · **注入只给指针**：任务书全文落仓外文件，注入那句话短到不会被 TUI 当成粘贴块坐在输入框里（#524）。
//     写完读回自证（writeBriefVerified）——读不回就不唤醒，半截任务书比不唤更坏。
//   · **回收不归巡检自己管**：会话登记进 state.brainSessions，act 每轮跑 reapBrains 超龄强关。
//     所以会话实际寿命上限 = BRAIN_MAX_AGE_MS，任务书里写给它的分钟数必须是同一个常量算出来的。
//   · **边界不能只写在任务书里**：嘱咐一个无人看管的会话「别乱改」等于没有边界。巡检的提交必须带
//     PATROL_COMMIT_TAG，下一轮回头查这些提交碰过哪些文件，越界当场报帅。
//   · **「没查成」要与「没发现」分开**：已有报告清单读不出来时，任务书里写的是「没查成，你自己去列」，
//     不是「一条都没有」——后者会让巡检把已经报过的东西再报一遍。
const PATROL_DIR = join(STATE_DIR, 'patrol');
const PATROL_COMMIT_TAG = '[patrol]';
const PATROL_ALLOW_PREFIX = 'docs/observations/';
const PATROL_AUDIT_LOOKBACK_MS = 7 * 24 * 3600 * 1000; // 没有上次审计锚点时回看多久

export function patrolBriefPath({ dir = null, now = new Date() } = {}) {
  return join(dir || PATROL_DIR, `patrol-${now.toISOString().replace(/[:.]/g, '-')}.md`);
}

/** 已有报告清单。读不了 = 没查成，绝不退化成空数组——空数组会让巡检重复报已经报过的事。 */
export function listObservations({ dir, io = null } = {}) {
  const reader = io || { readdir: readdirSync };
  try {
    const files = reader.readdir(dir).filter((f) => /\.md$/i.test(String(f))).sort();
    return { scanned: true, files };
  } catch (e) {
    return { scanned: false, error: `列不出已有报告（${dir}）：${String(e.message || e).slice(0, 160)}` };
  }
}

/**
 * 一批提交碰过的文件里，哪些越出了巡检的写入边界。
 * 清单不是数组 = 没查成（不当成「没越界」——查不成和查过没事必须分得开）。
 */
export function patrolBoundaryViolations(files, { allow = PATROL_ALLOW_PREFIX } = {}) {
  if (!Array.isArray(files)) return { scanned: false, error: '碰过的文件清单不是数组——没查成，不当成没越界' };
  const norm = files.map((f) => String(f == null ? '' : f).trim().replace(/\\/g, '/')).filter(Boolean);
  return { scanned: true, checked: norm.length, violations: norm.filter((f) => !f.startsWith(allow)) };
}

/** 回头查巡检自己的提交守没守住边界。git 查不成 → 没查成，不报「干净」。 */
export function auditPatrolCommits({ sinceIso, run = null, tag = PATROL_COMMIT_TAG } = {}) {
  const exec = run || ((argv) => runCmd(argv, 60000));
  const listed = exec(['git', 'log', '--since', String(sinceIso), '-F', `--grep=${tag}`, '--format=%H']);
  if (!listed.ok) return { scanned: false, error: `查不到巡检的提交：${listed.error}` };
  const hashes = String(listed.out || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const offenders = [];
  for (const h of hashes) {
    // 必须带 -z：不带的话 git 对非 ASCII 文件名会**加引号 + 八进制转义**
    // （`"docs/observations/2026-09-05-systemd\345\215\225..."`），前缀比对当场认不出它其实就在
    // 允许目录下，于是巡检自己写的中文名报告被判成越界。2026-09-05 实咬——第一份巡检报告就撞上了。
    // 解转义不是好办法（要处理引号、反斜杠、UTF-8 多字节）；让 git 直接吐原始路径才是。
    const shown = exec(['git', 'show', '--name-only', '-z', '--format=', h]);
    if (!shown.ok) return { scanned: false, error: `巡检提交 ${h.slice(0, 8)} 碰过哪些文件没查成：${shown.error}` };
    const v = patrolBoundaryViolations(String(shown.out || '').split('\0'));
    if (!v.scanned) return { scanned: false, error: v.error };
    if (v.violations.length) offenders.push({ commit: h.slice(0, 8), files: v.violations.slice(0, 10) });
  }
  return { scanned: true, commits: hashes.length, offenders };
}

/**
 * 巡检这一轮的退出码。三态必须分得开：
 *   2 = 有面没查成（不知道有没有问题）  1 = 查出上轮越界（知道有问题，已报帅）  0 = 查过没事。
 * 「没查成」优先级最高：它一旦被当成 0，systemctl 上就看不出这一轮其实什么都没查。
 */
export function patrolExitCode({ unscanned = [], outOfBounds = 0 } = {}) {
  if (Array.isArray(unscanned) ? unscanned.length : unscanned) return 2;
  return outOfBounds ? 1 : 0;
}

/** 注入那一句：短到不会被 TUI 当粘贴块，只说「全文在哪、先读它」。 */
export function patrolInjectText(briefPath) {
  return `你是这台服务器的机制巡检会话（一次性）。任务书全文在 ${briefPath}，先完整读它再动手，别照这一句话开工。做完打 exit 退出。`;
}

/** 巡检任务书全文。existing 是 listObservations 的三态结果，直接决定「已有报告」那一段怎么写。 */
export function patrolBriefText({ obsDir = 'docs/observations', existing = null, maxAgeMs = BRAIN_MAX_AGE_MS,
  commitTag = PATROL_COMMIT_TAG, allow = PATROL_ALLOW_PREFIX, now = new Date() } = {}) {
  const today = now.toISOString().slice(0, 10);
  const minutes = Math.round(maxAgeMs / 60000);
  const known = existing && existing.scanned
    ? (existing.files.length
      ? ['已有报告（先逐个读一遍，重复的不要再报）：', ...existing.files.map((f) => `- ${obsDir}/${f}`)]
      : [`已有报告：一条都没有（这是查过的结果，不是没查成）。`])
    : [`已有报告：**没查成**——${(existing && existing.error) || '清单读不出来'}。`,
      `你必须自己 \`ls ${obsDir}\` 确认；列不出来就不要写新报告，只回报「已有报告列不出来，这一轮没法判重复」。`];
  return [
    '# 机制巡检（一次性会话）',
    '',
    '你是这台服务器上的机制巡检。定时唤起，干完就退。**只写发现，不动手修。**',
    '',
    '## 为什么有你',
    '',
    '这台机器上另外几个定时任务都是判据写死的脚本，只找得到已经见过的失败形态。',
    '2026-09-05 那天真正被翻出来的两个洞——定时任务以 root 身份解释一个人人可写的脚本（等于给每个',
    '能写仓的执行体一条提权路）、以及巡检判「还活着」的判据有盲区——脚本一个都没报，',
    '是一个会话主动去翻才翻出来的。你就是那个去翻的人。',
    '',
    '## 去找什么',
    '',
    '重点是**脚本查不出**的那四类：',
    '',
    '1. **机制上的漏洞**：有权限、有通道，但没有任何人在看的地方。',
    '2. **装了没生效**：文件在、单元在册、检查也存在，可它实际上并没有在起作用。',
    '3. **判据前提已不成立**：检查还在跑，而它赖以成立的那个前提早就变了——真相源搬走了、',
    '   字段改名了、被检查的对象已经删了，于是它每次都绿，或者每次都红到没人看。',
    '4. **两处规矩互相打架**：A 处要求这样、B 处要求那样，照哪边做都会违反另一边。',
    '',
    '从哪儿翻（翻不完是正常的，翻到哪就说到哪）：',
    '',
    '- 仓里的规矩（`CLAUDE.md`、`host/skills/`、`docs/decisions/`）与 `scripts/` 里真正的实现对不对得上',
    '- `host/machine/systemd/` 里的单元与机器上的实际状态对不对得上：谁在跑、以谁的身份跑、下一次什么时候跑',
    '- `tests/` 里的闸：判据还成立吗？它这次到底扫到样本了没有？',
    '- 最近的提交（`git log`）里有没有「改了 A 没同改 B」',
    '',
    '## 发现写到哪',
    '',
    `一条发现一个文件，落 \`${obsDir}/${today}-<短名>.md\`（短名用中文或英文都行，能一眼认出是哪件事）。`,
    '正文中文，三段写清：',
    '',
    '- **结论**：一句话说清哪里有洞',
    '- **证据**：文件路径加行号、跑过的命令和它的真实输出。不许写「应该」「可能」——没验证的就标「没验证」',
    '- **建议的最小改造**：删哪一层能让这个问题不存在',
    '',
    `写完必须 \`git add\` + \`git commit\` + \`git push\`。**不提交别的机器看不到，等于没写。**`,
    `提交标题必须以 \`${commitTag}\` 开头——回头查你有没有守住边界，就靠这个标记找你的提交。`,
    '',
    '推不上去（别人先推了）就 `git pull --rebase` 再推。**不许留着不推**：这棵主树每 5 分钟要跟一次',
    '主分支，走的是只许快进的合并；本地留一个没推上去的提交，那条同步从此每轮都失败——',
    '你会用一份报告换掉整台机器的代码同步。推不上去又 rebase 不动，就 `git reset --soft HEAD~1`',
    '把改动退回工作区，然后如实报告「写了但没推上去」，别硬来。',
    '',
    '## 不许重复报',
    '',
    ...known,
    '',
    '同一件事已经报过（哪怕换了个说法），或者那个文件里已经写了「处置：」，就不要再报一遍。',
    '**没有新发现是正常结果**——这一轮就说一句「翻了哪几面、没有新发现」，不要为了交差凑一条。',
    '',
    '## 硬边界（越界就是事故）',
    '',
    '你没人看管，所以边界比产出重要：',
    '',
    `- 只许新建或修改 \`${allow}\` 底下的文件。别的文件一个字都不许改。`,
    '- 不许改代码、不许改配置、不许改定时任务、不许 `sudo`、不许启停任何服务。',
    '- 不许开 GitHub 单子或 PR，不许给单子和 PR 评论，不许合并、不许关单。',
    '- 不许花钱：不许起别的模型会话、不许调付费接口、不许派工。',
    `- 提交里只能有 \`${allow}\` 底下的文件。\`git status\` 里冒出别的改动就停手，在报告里写明你看见了什么。`,
    '- 发现了问题**只描述，不动手**。想动手的那股冲动，正是这条边界要拦的东西。',
    '',
    `这条边界有人查：下一轮巡检会把带 \`${commitTag}\` 的提交逐个翻出来看碰过哪些文件，越界当场报帅。`,
    '',
    '## 时间与收尾',
    '',
    `你最多有 ${minutes} 分钟，到点会被强制关掉。所以顺序是：**先把最小的一份报告写完并推上去，再回头深挖**。`,
    '干完打 `exit` 退出——退了才不占位子。',
    '',
  ].join('\n');
}

function cmdPatrol(argv) {
  const dryRun = argv.includes('--dry-run');
  const state = loadState();
  const log = [];
  const say = (m) => log.push(m);
  const unscanned = [];

  // ① 先回收上一轮的一次性会话。act 也会回收，这里再收一次是为了 act 停摆时巡检不至于自己堆孤儿。
  reapBrains({ state, dryRun, say });

  // ② 回头审上几轮巡检守没守住边界（边界不能只写在任务书里）。
  state.patrol = state.patrol || {};
  const sinceIso = state.patrol.lastAuditAt || new Date(Date.now() - PATROL_AUDIT_LOOKBACK_MS).toISOString();
  const audit = auditPatrolCommits({ sinceIso });
  let outOfBounds = 0;
  if (!audit.scanned) {
    unscanned.push(`越界审计：${audit.error}`);
    say(`  越界审计没查成：${audit.error}——不报「干净」`);
  } else {
    outOfBounds = audit.offenders.length;
    say(`  越界审计：${sinceIso} 起共 ${audit.commits} 个巡检提交，越界 ${outOfBounds} 个`);
    for (const o of audit.offenders) {
      execAction({
        kind: 'escalate', reason: 'patrol-out-of-bounds', term: `patrol-${o.commit}`,
        why: `巡检会话在提交 ${o.commit} 里改了 ${PATROL_ALLOW_PREFIX} 之外的文件（${o.files.join('、')}）`
          + '——巡检只许写发现不许动手，这条边界破了要人判',
      }, { state, dryRun, log });
    }
    if (!dryRun) state.patrol.lastAuditAt = nowIso();
  }

  // ③ 已有报告清单：读不出来就在任务书里明写「没查成」，不退化成「一条都没有」。
  const obsRel = PATROL_ALLOW_PREFIX.replace(/\/$/, '');
  const existing = listObservations({ dir: join(ROOT, ...obsRel.split('/')) });
  if (!existing.scanned) { unscanned.push(existing.error); say(`  ${existing.error}`); }
  else say(`  已有报告 ${existing.files.length} 份`);

  // ④ 任务书落文件 + 读回自证；注入只给指针。
  const briefPath = patrolBriefPath({});
  const briefText = patrolBriefText({ obsDir: obsRel, existing });
  if (dryRun) {
    say(`[dry] 任务书会落 ${briefPath}（${Buffer.byteLength(briefText, 'utf8')} 字节），全文见下`);
    say(briefText);
    say(`[dry] 注入指针（${Buffer.byteLength(patrolInjectText(briefPath), 'utf8')} 字节）：${patrolInjectText(briefPath)}`);
  }
  const written = dryRun
    ? { ok: true, path: briefPath, bytes: Buffer.byteLength(briefText, 'utf8') }
    : writeBriefVerified({ path: briefPath, text: briefText, what: '巡检任务书' });
  if (!written.ok) {
    say(`  ${written.error}`);
    console.log(JSON.stringify({ at: nowIso(), dryRun, woken: false, unscanned: [...unscanned, written.error] }, null, 2));
    console.error(log.join('\n'));
    process.exit(2);
  }

  // ⑤ 唤会话：复用大脑那条路（起会话 → 送指针 → 登记进 brainSessions 等回收）。
  const woken = wakeBrain({
    kind: 'wake-brain', target: 'patrol', title: '机制巡检', pointer: patrolInjectText(written.path),
    why: '定时机制巡检：找脚本查不出的洞',
  }, { state, dryRun, say });
  if (!woken.ok && !dryRun) unscanned.push(`巡检会话没唤成：${woken.error || '没查成'}`);

  if (!dryRun) saveState(state); // dry-run 无副作用：不落 state（与 act 一致）
  console.log(JSON.stringify({
    at: nowIso(), dryRun,
    brief: written.path, briefBytes: written.bytes,
    knownObservations: existing.scanned ? existing.files.length : null,
    auditedCommits: audit.scanned ? audit.commits : null,
    outOfBounds,
    woken: dryRun ? 'dry-run（没真起会话）' : woken.ok === true,
    reapBy: '每轮 act 的 reapBrains，超龄强关',
    unscanned,
  }, null, 2));
  console.error(log.join('\n'));
  process.exit(patrolExitCode({ unscanned, outOfBounds }));
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
    // 跨仓只报数，不进 health：别的仓查不到不该拦住本仓这一轮（它是感知，不是本轮要处置的活）。
    otherRepos: situation.otherRepos?.scanned
      ? situation.otherRepos.repos.map((r) => `${r.repo}: ${r.issues} issue / ${r.prs} PR`)
      : `没查成：${situation.otherRepos?.error || '缺节'}`,
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

const CMDS = { scan: cmdScan, act: cmdAct, patrol: cmdPatrol };

function main() {
  const [, , sub, ...rest] = process.argv;
  if (!sub || sub === '--help' || sub === '-h') {
    console.log(`用法: node scripts/commander.mjs <scan|act|patrol|inventory|status|install> [--dry-run]

  scan       眼睛：产态势 JSON 落 ~/.dao/commander/（三态退出：0 全查成 / 2 有没查成）
  act        scan → decide → 执行动作（--dry-run 只打印命令）
  patrol     机制巡检：唤一个一次性会话去翻脚本查不出的洞，发现落 docs/observations/
             （三态退出：0 唤起了 / 1 查出上轮巡检越界（已报帅） / 2 有面没查成；--dry-run 只打印计划与任务书全文）
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
