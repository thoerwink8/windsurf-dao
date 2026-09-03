#!/usr/bin/env node

// 盘面摘要 hook（issue #564 第 1 条）。#807 起本机守卫栈已删：不再 ensure watchdog/flow，
// 也不再注 [卫] 行。挂点已从 settings.json 摘掉；本文件只剩 [盘] 纯函数给 next / 测试用。
//
// 改这个文件前必须知道的四条：
//   1. 只报不拦：永远 exit 0。UserPromptSubmit hook 的输出只是进上下文，绝不挡住用户输入
//      （hook 拦死会话的教训见 memory ralph-loop-disabled）。
//   2. 数据取 orca 本地状态 + 60 秒 TTL 缓存，**不打 GitHub**——用户每说一句话就消耗一次
//      API 配额（账号级共享池）。缓存 _flow/board-summary.json 是唯一的本地状态：
//      新鲜（<60s）直接用，过期重算，不参与任何判断——它只是节流。
//   3. 「扫完是空的」和「这次没扫到」必须不同形：[盘] 全 0 行 ≠ [盘] 没查成行。
//      守卫崩了（整体无输出）和守卫说没事（[盘] 行在）也要分得开。
//   4. 别在这里复述别的文件的事实：在途/待消歧/待收口的本地口径见函数注释与 issue #564/#588，
//      本文件只产出那一行字。#588 起这一行必须带单号和状态——只有计数，帅还是要「记得去查」。

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runOrcaRaw } from './orca-run.mjs';
import { displayNumberFromWorktree } from './card-identity.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.CLAUDE_PROJECT_DIR
  ? String(process.env.CLAUDE_PROJECT_DIR)
  : join(SCRIPT_DIR, '..', '..');
const CACHE_FILE = join(ROOT, '_flow', 'board-summary.json');
const CACHE_TTL_MS = 60 * 1000;
const ORCA_TIMEOUT_MS = 15000;

function cardRef(w) {
  const name = String(w.displayName || '');
  return {
    number: displayNumberFromWorktree(w),
    name,
    id: w.worktreeId || w.id || null,
  };
}

/** 卡级状态：人维护的 workspaceStatus 优先，agent 态兜底。子卡不进这一行。 */
export function cardStatus(w) {
  const agents = Array.isArray(w.agents) ? w.agents : [];
  const st = w.workspaceStatus;
  if (st === 'todo' && agents.length === 0) return '待消歧';
  if (st === 'completed') return '待收口';
  if (st === 'in-review') return '审中';
  const active = agents.some(a => a && (a.state === 'working' || a.state === 'waiting'));
  if (st === 'in-progress' && (active || agents.length > 0)) return '做中';
  if (active) return '做中';
  if (agents.length > 0) return '待收口';
  return null;
}

function fmtCards(list, withStatus) {
  if (!Array.isArray(list) || list.length === 0) return '无';
  return list.map(c => {
    const n = c.number != null ? `#${c.number}` : (c.name || '?');
    return withStatus && c.status ? `${n}(${c.status})` : n;
  }).join(' ');
}

/** 盘面清单短名：有号用 #N+状态（#729审中）；无号用卡名首段，丢掉 · 后的模型尾巴。 */
export function shortCardLabel(c) {
  if (!c) return '?';
  if (c.number != null) return c.status ? `#${c.number}${c.status}` : `#${c.number}`;
  const raw = String(c.name || '').trim();
  if (!raw) return '?';
  const noModel = raw.split('·')[0].trim();
  const token = noModel.split(/\s+/)[0] || '?';
  return token.length > 24 ? token.slice(0, 24) : token;
}

function fmtOnBoard(list) {
  if (!Array.isArray(list) || list.length === 0) return '无';
  return list.map(shortCardLabel).join(' ');
}

/** 从 orca worktree ps 的 JSON 算盘面（纯函数，测试喂 fixture 不碰 orca）。
 * 口径（不打 GitHub；#588 起带单号和状态，不再只报计数）：
 *   在途 = 顶层任务卡里还在做 / 在审的（做中、审中）。
 *   待收口 = 顶层任务卡已做完、等帅合并/归档。
 *   待消歧 = 建了卡但 status=todo、还没有 agent。
 *   盘面 = 顶层非主树、非归档卡的真实名单（含无 cardStatus 的非正式空卡）。
 * 子卡（审官等，有 parentWorktreeId）并进父卡，不单独占一行。
 * 主树（isMainWorktree）明确排除，不进在途、不进盘面清单。
 * archived 卡不算。不计算「预期该留谁」，不自动删卡。 */
export function summarizeBoard(psJson) {
  const wts = Array.isArray(psJson?.result?.worktrees) ? psJson.result.worktrees : null;
  if (!wts) return { unscanned: true, error: 'worktree ps 返回没有 result.worktrees 数组' };
  const out = { inFlight: [], closing: [], todo: [], onBoard: [], scanned: 0, unscanned: false };
  for (const w of wts) {
    if (!w || w.isMainWorktree || w.isArchived) continue;
    out.scanned++;
    if (w.parentWorktreeId) continue;
    const status = cardStatus(w);
    const card = { ...cardRef(w), status };
    out.onBoard.push(card);
    if (!status) continue;
    if (status === '待消歧') out.todo.push(card);
    else if (status === '待收口') out.closing.push(card);
    else out.inFlight.push(card);
  }
  return out;
}

/** 一行盘面摘要。扫完真空（全无）与没扫到（未查成）必须是不同的形。 */
export function boardLine(summary) {
  if (!summary || summary.unscanned) {
    return `[盘] 没查成：${summary?.error || '摘要没算出来'}（≠ 扫完是空的）`;
  }
  if (!Array.isArray(summary.inFlight) || !Array.isArray(summary.closing)
    || !Array.isArray(summary.todo) || !Array.isArray(summary.onBoard)) {
    return `[盘] 没查成：缓存还是旧计数形，作废重算（≠ 扫完是空的）`;
  }
  const todoBit = summary.todo.length ? ` · 待消歧 ${fmtCards(summary.todo, false)}` : '';
  return `[盘] 在途 ${fmtCards(summary.inFlight, true)} · 待收口 ${fmtCards(summary.closing, false)}${todoBit} · 盘面 ${fmtOnBoard(summary.onBoard)}`;
}

// spawn 唯一真源在 scripts/lib/orca-run.mjs——raw 结果由本文件调用点自己解析。
function runOrca(args) {
  return runOrcaRaw(args, { timeout: ORCA_TIMEOUT_MS });
}

function loadCache() {
  try {
    const doc = JSON.parse(readFileSync(CACHE_FILE, 'utf8'));
    if (doc && typeof doc.ts === 'number' && doc.summary && !doc.summary.unscanned
      && Array.isArray(doc.summary.inFlight) && Array.isArray(doc.summary.onBoard)) return doc;
  } catch { /* 缓存不在/坏了 = 重算 */ }
  return null;
}

function saveCache(summary) {
  try {
    mkdirSync(dirname(CACHE_FILE), { recursive: true });
    writeFileSync(CACHE_FILE, JSON.stringify({ ts: Date.now(), summary }), 'utf8');
  } catch { /* 缓存写不进不翻转结果（它就是节流，不是判据） */ }
}

/** 盘面摘要对象：缓存新鲜直接用；过期或没缓存就重算（只缓存成功那次，没查成不落缓存）。
 * cache 可注入（测试喂 fixture，不碰真缓存文件）；缺省走 _flow/board-summary.json。 */
export function boardSummary({ orca = runOrca, cache = null } = {}) {
  const load = cache && typeof cache.load === 'function' ? cache.load : loadCache;
  const save = cache && typeof cache.save === 'function' ? cache.save : saveCache;
  const cached = load();
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.summary;
  const r = orca(['worktree', 'ps', '--json']);
  if (r.error || r.status !== 0) {
    return { unscanned: true, error: `orca worktree ps 失败（${r.error?.code || `exit ${r.status}`}）` };
  }
  let psJson;
  try { psJson = JSON.parse(r.stdout); }
  catch { return { unscanned: true, error: 'orca worktree ps 输出不是 JSON' }; }
  const summary = summarizeBoard(psJson);
  if (!summary.unscanned) save(summary);
  return summary;
}

/** 盘面行：缓存新鲜直接用；过期或没缓存就重算（只缓存成功那次，没查成不落缓存）。 */
export function boardInjection() {
  return boardLine(boardSummary());
}

// ── #576 next：动作候选层 ──────────────────────────────────────────
// #807 起本机常驻进程（flow/watchdog）整层删掉：next 不再读心跳文件，只剩盘面 + 模式态。
// 派工节奏与 PR 回流归服务器指挥官（commander.mjs），本行只报本地 orca 盘面。

/** 动作候选行（#576）：把「现在该干什么」算出来，按谁在等谁排，等人的排最前。
 * 纯函数：输入全是解析好的对象，测试喂 fixture 不碰 orca / GitHub。
 * standby 态（mode.mode === 'standby'，复用 dao-mode 的 state.json，不造新开关）
 * 不输出「待消歧」栏（⑤）。mode 读不到 = 按常态（不隐藏），dao-mode hook 自报态。 */
export function nextLine({ board, mode } = {}) {
  if (!board || board.unscanned) {
    return `[盘] 没查成：${(board && board.error) || '盘面摘要没算出来'}（≠ 扫完是空的）`;
  }
  const bits = [];

  // 待收口：盘面做完等帅合并/归档的卡
  if (Array.isArray(board.closing) && board.closing.length) {
    bits.push(`待收口 ${fmtCards(board.closing, false)}`);
  }

  // 待消歧：todo 卡；standby 态不输出（⑤）
  const standby = !!mode && mode.mode === 'standby';
  if (!standby && Array.isArray(board.todo) && board.todo.length) {
    bits.push(`待消歧 ${fmtCards(board.todo, false)}`);
  }

  // 在途：别人在动，只作摘要放最后（帅的动作只有终审合并与派工）
  if (Array.isArray(board.inFlight) && board.inFlight.length) {
    bits.push(`在途 ${fmtCards(board.inFlight, true)}`);
  }

  if (bits.length === 0) return '[盘] 无事可动 · 扫完是空的（≠ 没查成）';
  return `[盘] ${bits.join(' · ')}`;
}

/** dao-mode 状态文件路径：唯一真源是 host/skills/dao-mode/hooks/dao-mode.mjs 的 STATE_FILE，
 * 这里只复制落点（~/.claude/state.json，DAO_STATE_FILE 覆写），不复述它的解析逻辑。 */
function modeStatePath(env = process.env, home = homedir()) {
  return env.DAO_STATE_FILE || join(home, '.claude', 'state.json');
}

function readJsonOr(path, read) {
  try {
    return JSON.parse(String(read(path, 'utf8')).replace(/^\uFEFF/, ''));
  } catch { return null; }
}

/** 读侧（CLI 与 hook 共用）：盘面摘要 + 用户级模式态 → 一行动作候选。
 * 只读不写判断（board-summary 缓存过期经 orca worktree ps 重算，本地零 GitHub）。
 * read / exists / orca / cache 可注入（测试喂 fixture，不碰真机）。 */
export function nextInjection({ read = readFileSync, exists = existsSync, orca = runOrca, cache = null } = {}) {
  const modePath = modeStatePath();
  let mode = null;
  if (exists(modePath)) {
    const doc = readJsonOr(modePath, read);
    mode = doc && doc.mode ? { mode: String(doc.mode) } : { unreadable: true };
  }

  return nextLine({ board: boardSummary({ orca, cache }), mode });
}
function main() {
  process.stdout.write(`${nextInjection()}\n`);
  process.exit(0);
}

// 只被命令行直跑（hook 面）时开工；被测试 import 时只导出纯函数，不碰 orca。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}