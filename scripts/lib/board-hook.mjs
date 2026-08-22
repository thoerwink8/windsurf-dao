#!/usr/bin/env node

// 盘面摘要 + 信箱台自愈 + 守卫兜底 hook（issue #564 第 1 条 + comment 追加的信箱台自愈 + #693 守卫兜底）。
// 挂在仓内 .claude/settings.json 的 UserPromptSubmit：每轮输出一行 [盘] 摘要，
// 顺带把信箱台 ensure 一遍（全活着秒退一行 JSON；死了当场自愈重建）；
// 主树会话再顺手 ensure 一遍守卫（#693：会话中途 watchdog/flow 死了，下一轮提示时拉起；
// 2026-08-22 起主树即拉，不再要求 master——master 只管帅位展示）+ 把未上报的守卫自停显形。
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
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { runOrcaRaw } from './orca-run.mjs';
import { displayNumberFromWorktree } from './card-identity.mjs';
import { judgeSeat, guardLaunchGate } from './guard-seat.mjs';
import { onceResultBits } from './guard-keepalive.mjs';
import { haltLogPath, readHaltLog } from './guard-halt.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.CLAUDE_PROJECT_DIR
  ? String(process.env.CLAUDE_PROJECT_DIR)
  : join(SCRIPT_DIR, '..', '..');
const CACHE_FILE = join(ROOT, '_flow', 'board-summary.json');
const CACHE_TTL_MS = 60 * 1000;
const ORCA_TIMEOUT_MS = 15000;
const INBOX_TIMEOUT_MS = 45000; // READY_WAIT_MS(30s) + 余量；健康时秒退
const INBOX_SCRIPT = join(ROOT, 'scripts', 'inbox-station.mjs');
const GUARD_ONCE_TIMEOUT_MS = 25000; // 健康时一次 CIM 查询秒级；与信箱台共享 60s hook 预算

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

/** 从 orca worktree ps 的 JSON 算盘面（纯函数，测试喂 fixture 不碰 orca）。
 * 口径（不打 GitHub；#588 起带单号和状态，不再只报计数）：
 *   在途 = 顶层任务卡里还在做 / 在审的（做中、审中）。
 *   待收口 = 顶层任务卡已做完、等帅合并/归档。
 *   待消歧 = 建了卡但 status=todo、还没有 agent。
 * 子卡（审官等，有 parentWorktreeId）并进父卡，不单独占一行。
 * master 主树与 archived 卡不算。 */
export function summarizeBoard(psJson) {
  const wts = Array.isArray(psJson?.result?.worktrees) ? psJson.result.worktrees : null;
  if (!wts) return { unscanned: true, error: 'worktree ps 返回没有 result.worktrees 数组' };
  const out = { inFlight: [], closing: [], todo: [], scanned: 0, unscanned: false };
  for (const w of wts) {
    if (!w || w.isMainWorktree || w.isArchived) continue;
    out.scanned++;
    if (w.parentWorktreeId) continue;
    const status = cardStatus(w);
    if (!status) continue;
    const card = { ...cardRef(w), status };
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
  if (!Array.isArray(summary.inFlight) || !Array.isArray(summary.closing) || !Array.isArray(summary.todo)) {
    return `[盘] 没查成：缓存还是旧计数形，作废重算（≠ 扫完是空的）`;
  }
  const todoBit = summary.todo.length ? ` · 待消歧 ${fmtCards(summary.todo, false)}` : '';
  return `[盘] 在途 ${fmtCards(summary.inFlight, true)} · 待收口 ${fmtCards(summary.closing, false)}${todoBit}`;
}

// spawn 唯一真源在 scripts/lib/orca-run.mjs——raw 结果由本文件调用点自己解析。
// （收编前本拷贝的 shell 回落缺 windowsHide: true，#695 同款弹窗隐患。）
function runOrca(args) {
  return runOrcaRaw(args, { timeout: ORCA_TIMEOUT_MS });
}

function loadCache() {
  try {
    const doc = JSON.parse(readFileSync(CACHE_FILE, 'utf8'));
    if (doc && typeof doc.ts === 'number' && doc.summary && !doc.summary.unscanned
      && Array.isArray(doc.summary.inFlight)) return doc;
  } catch { /* 缓存不在/坏了 = 重算 */ }
  return null;
}

function saveCache(summary) {
  try {
    mkdirSync(dirname(CACHE_FILE), { recursive: true });
    writeFileSync(CACHE_FILE, JSON.stringify({ ts: Date.now(), summary }), 'utf8');
  } catch { /* 缓存写不进不翻转结果（它就是节流，不是判据） */ }
}

/** 盘面行：缓存新鲜直接用；过期或没缓存就重算（只缓存成功那次，没查成不落缓存）。 */
export function boardInjection() {
  const cached = loadCache();
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return boardLine(cached.summary);
  const r = runOrca(['worktree', 'ps', '--json']);
  if (r.error || r.status !== 0) {
    return boardLine({ unscanned: true, error: `orca worktree ps 失败（${r.error?.code || `exit ${r.status}`}）` });
  }
  let psJson;
  try { psJson = JSON.parse(r.stdout); }
  catch { return boardLine({ unscanned: true, error: 'orca worktree ps 输出不是 JSON' }); }
  const summary = summarizeBoard(psJson);
  if (!summary.unscanned) saveCache(summary);
  return boardLine(summary);
}

/** 信箱台自愈：ensure 一遍。健康 = 无输出（[盘] 行的存在就是活证）；
 * 自愈动作（restart/rebuild）留痕；失败 = 可辨认的错误串，只报不拦。
 * exec 可注入（测试用假 spawn，不真建台）；默认 spawnSync 跑真 ensure。 */
export function inboxInjection({ script = INBOX_SCRIPT, exec = null } = {}) {
  const r = exec
    ? exec(script)
    : spawnSync(process.execPath, [script, 'ensure'], {
        encoding: 'utf8', timeout: INBOX_TIMEOUT_MS, windowsHide: true,
      });
  const out = String(r.stdout || '').trim();
  if (r.error || r.status !== 0) {
    const tail = (() => {
      try {
        const doc = JSON.parse(out.split(/\r?\n/).pop() || '{}');
        return doc.error || doc.reason || out.slice(0, 80) || '(无输出)';
      } catch { return out.slice(0, 80) || '(无输出)'; }
    })();
    return `[台] 信箱台自愈失败：${tail}（只报不拦，继续用）`;
  }
  try {
    const doc = JSON.parse(out.split(/\r?\n/).pop() || '{}');
    if (doc.action === 'restart' || doc.action === 'rebuild') {
      return `[台] 信箱台已自愈：${doc.action}（${doc.reason || 'relay 死了'}）`;
    }
  } catch { /* 输出不成 JSON：就当活着但把原文留痕？健康态不回显，失败态上面已处理 */ }
  return null;
}

/** 守卫兜底 ensure（#693）：主树会话每轮顺手跑 --once。健康 = 无输出（[盘] 行的存在
 * 就是活证）；拉起/失败留痕；只报不拦。非主树（工人树、别的仓）静默。
 * 2026-08-22 拍板：拉起闸认「主树在本仓」不认 master（主树停非 master 分支全灭过一次，
 * 15 小时无人知）；master 只管帅位展示。判不出来时不猜：注入可辨认的「没查成」行（≠ 已查）。
 * judge / exec 可注入（测试用假判定与假 spawn，不碰真机）。 */
export function guardInjection({ root = ROOT, judge = null, exec = null } = {}) {
  const seat = judge ? judge({ projectDir: root }) : judgeSeat({ projectDir: root });
  const gate = guardLaunchGate(seat);
  if (gate.unknown) {
    return `[卫] 帥位判定没查成：${gate.error}（守卫 ensure 这轮没跑，≠ 已查）`;
  }
  if (!gate.launch) return null;
  const script = join(root, 'scripts', 'guard-keepalive.mjs');
  const r = exec
    ? exec(script)
    : spawnSync(process.execPath, [script, '--once'], {
        // cwd 钉在判定的项目上：--once 用 cwd 的 git worktree list 定主树（心跳/状态文件落主树 _flow）
        encoding: 'utf8', cwd: root, timeout: GUARD_ONCE_TIMEOUT_MS, windowsHide: true,
      });
  const out = String(r.stdout || '').trim();
  if (r.error || (r.status !== 0 && r.status != null)) {
    const tail = String(r.stderr || '').trim() || out.slice(-120);
    return `[卫] 守卫 ensure 没查成：${r.error?.message || `exit ${r.status}`}${tail ? `（${tail.slice(-120)}）` : ''}（只报不拦，≠ 查过没事）`;
  }
  let doc = null;
  try { doc = JSON.parse(out.split(/\r?\n/).filter(Boolean).pop() || '{}'); } catch { doc = null; }
  if (!doc || !Array.isArray(doc.results)) {
    return `[卫] 守卫 ensure 输出没查成：--once 末行不是结果 JSON（≠ 查过没事）`;
  }
  const bits = onceResultBits(doc);
  // 主树非 master 时把分支显形：守卫照拉，但「谁是帅位」展示口径仍认 master，防盘面误读。
  const branchNote = gate.shuai ? '' : `（主树在 ${gate.branch}，非 master——守卫照拉）`;
  if (bits.failed.length) {
    return `[卫] 守卫拉起没成：${bits.all.join(' ')}${branchNote}（只报不拦，≠ 查过没事）`;
  }
  if (bits.started.length) {
    return `[卫] 守卫已拉起：${bits.all.join(' ')}${branchNote}`;
  }
  return null; // 全 already：静音
}

// ── 守卫自停可见（2026-08-22 拍板）──────────────────────────────────
// 自停（STALE_CODE 落后自停/查不成自停）只写本机 halt.jsonl 时，没人知道守卫死过。
// 本注入每轮读一次本机台账（纯本地文件，不打 GitHub）：近 24h 内有「没报成 GitHub」的
// 自停记录就显形一行；全已上报或台账不存在（从没自停过）静音；台账读不出 = 没查成行。
const HALT_LOOKBACK_MS = 24 * 60 * 60 * 1000;

export function haltInjection({ now = Date.now(), loadLog = null } = {}) {
  const log = loadLog ? loadLog() : readHaltLog(haltLogPath({ env: process.env }));
  if (!log || log.scanned !== true) {
    return `[卫] 守卫自停台账没查成：${log?.error || '读不出 halt.jsonl'}（≠ 查过没事；只报不拦）`;
  }
  if (log.missing || log.count === 0) return null; // 从没自停过：扫完 0，静音
  const recent = log.records.filter((r) => {
    const ts = Date.parse(r && r.at);
    return Number.isFinite(ts) && now - ts <= HALT_LOOKBACK_MS;
  });
  const unreported = recent.filter((r) => r && r.github?.ok !== true);
  if (unreported.length === 0) return null; // 近 24h 的自停都已报 GitHub：静音
  const latest = unreported[unreported.length - 1];
  const why = latest.github?.error ? `（${String(latest.github.error).slice(0, 80)}）` : '';
  return `[卫] 守卫自停 ${unreported.length} 条近 24h 未上报 GitHub：最近 ${latest.tag || '?'} ${latest.at || '?'}${why}——见 ~/.dao/guard/halt.jsonl（只报不拦）`;
}

function main() {
  const lines = [boardInjection()];
  const inbox = inboxInjection();
  if (inbox) lines.push(inbox);
  const guard = guardInjection();
  if (guard) lines.push(guard);
  const halt = haltInjection();
  if (halt) lines.push(halt);
  process.stdout.write(`${lines.join('\n')}\n`);
  process.exit(0);
}

// 只被命令行直跑（hook 面）时开工；被测试 import 时只导出纯函数，不碰 orca。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}