#!/usr/bin/env node
// scripts/repo-hygiene.mjs —— 仓库卫生巡检：机器漂移（未推/未拉）+ PR 积压。
//
//   node scripts/repo-hygiene.mjs            # 人读报告
//   node scripts/repo-hygiene.mjs --json     # 机器读
//
// 判据全在 scripts/lib/repo-hygiene.mjs（纯函数，单测覆盖）；本文件只负责取数：
//   · 本机：git 的 ahead/behind/dirty（本仓）
//   · 远端机器：声明的清单（`DAO_HYGIENE_MACHINES` = [{"ssh":"别名","path":"/srv/projects/…","mustBeClean":true}]）
//   · PR 积压：`gh-as marshal -- pr list`（读走 marshal 身份；写动作仍只走 issue 网关）
//
// 三态：绿 / 红 / 没查成。**没查成不许当绿**（机器连不上、gh 取不到数都算没查成）。
// 为什么要有它：2026-09-19 实测——服务器上的仓有 2 笔改动躺了 9 天没推、本机主树落后 39 笔、
// 开放 PR 积到 17 个（最老 14.6 天）。这些都不该靠人偶然发现。

import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { judgeRepoDrift, judgePrBacklog, summarizeHygiene, HYGIENE_DEFAULTS } from './lib/repo-hygiene.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const run = (cmd, argv, opts = {}) => spawnSync(cmd, argv, { encoding: 'utf8', windowsHide: true, ...opts });

/** 一个仓的漂移计数：ahead/behind 用 rev-list 数（不解析 status 的自由文本），dirty 用 porcelain 行数。 */
function repoDriftOf(dir) {
  const ahead = run('git', ['-C', dir, 'rev-list', '--count', '@{u}..HEAD']);
  const behind = run('git', ['-C', dir, 'rev-list', '--count', 'HEAD..@{u}']);
  const dirty = run('git', ['-C', dir, 'status', '--porcelain']);
  if (ahead.status !== 0 || behind.status !== 0) {
    return { state: 'unscanned', why: `git 读不到（${String(ahead.stderr || behind.stderr || '').trim().slice(0, 80)}）——可能没有上游分支` };
  }
  if (dirty.status !== 0) return { state: 'unscanned', why: 'git status 读不到' };
  return {
    ahead: Number(String(ahead.stdout).trim()),
    behind: Number(String(behind.stdout).trim()),
    dirty: String(dirty.stdout || '').split('\n').filter(Boolean).length,
  };
}

function remoteDriftOf({ ssh, path }) {
  const r = run('ssh', [ssh, `cd ${path} && git rev-list --count @{u}..HEAD && git rev-list --count HEAD..@{u} && git status --porcelain | wc -l`]);
  if (r.status !== 0) return { state: 'unscanned', why: `ssh ${ssh} 读不到（${String(r.stderr || '').trim().slice(0, 80)}）` };
  const [ahead, behind, dirty] = String(r.stdout || '').trim().split('\n').map(Number);
  return { ahead, behind, dirty };
}

function prBacklog() {
  const r = run(process.execPath, [join(ROOT, 'scripts', 'gh-as.mjs'), 'marshal', '--', 'pr', 'list', '--state', 'open', '--json', 'number,createdAt,mergeable', '--limit', '50']);
  if (r.status !== 0) return { state: 'unscanned', why: `gh 取不到 PR 清单（${String(r.stderr || r.stdout || '').trim().slice(0, 100)}）` };
  let list;
  try { list = JSON.parse(String(r.stdout)); } catch { return { state: 'unscanned', why: 'gh 回的不是 JSON' }; }
  const now = Date.now();
  return { open: list.map(p => ({ number: p.number, mergeable: p.mergeable, ageDays: (now - Date.parse(p.createdAt)) / 86400000 })) };
}

// T32：债册子（P2/P3 审查发现的账）。同 #1503——调 debt-ledger 自己，别重造判据。
function debtLedger() {
  const r = run(process.execPath, [join(ROOT, 'scripts', 'debt-ledger.mjs'), '--json']);
  let doc;
  try { doc = JSON.parse(String(r.stdout || '')); } catch {
    return { state: 'unscanned', why: `debt-ledger 没查成（${String(r.stderr || r.stdout || '').trim().slice(0, 100)}）` };
  }
  if (!doc || !doc.verdict) return { state: 'unscanned', why: 'debt-ledger 回执形态不对' };
  return { state: doc.verdict.state, why: doc.verdict.why };
}

// #1503：落后单清退。不重造判据——调 issue-retire 自己（它是机械判）。它红时退出码 1，
// 但 stdout 仍是合法 JSON，所以先看能不能解析，别把「有该清退的」洗成「没查成」。
function issueRetire() {
  const r = run(process.execPath, [join(ROOT, 'scripts', 'issue-retire.mjs'), '--json']);
  let doc;
  try { doc = JSON.parse(String(r.stdout || '')); } catch {
    return { state: 'unscanned', why: `issue-retire 没查成（${String(r.stderr || r.stdout || '').trim().slice(0, 100)}）` };
  }
  if (!doc || !doc.verdict) return { state: 'unscanned', why: 'issue-retire 回执形态不对' };
  return { state: doc.verdict.state, why: doc.verdict.why };
}

// T44：版本视图/伞单索引与 GitHub 状态是否一致。不重造检查器——调 stage-board 自己（它已是机械判据）。
// 它红时退出码是 1，但 stdout 仍是合法 JSON，所以先看能不能解析，别把「有红」洗成「没查成」。
function stageBoard() {
  const r = run(process.execPath, [join(ROOT, 'scripts', 'stage-board.mjs'), '--json']);
  let doc;
  try { doc = JSON.parse(String(r.stdout || '')); } catch {
    return { state: 'unscanned', why: `stage-board 没查成（${String(r.stderr || r.stdout || '').trim().slice(0, 100)}）` };
  }
  if (!doc || !doc.counts) return { state: 'unscanned', why: 'stage-board 回执形态不对' };
  return {
    state: doc.state,
    why: `版本视图/伞单索引：绿 ${doc.counts.green} / 红 ${doc.counts.red} / 没查成 ${doc.counts.unscanned}`,
  };
}

function main() {
  const json = process.argv.includes('--json');
  const machines = (() => { try { return JSON.parse(process.env.DAO_HYGIENE_MACHINES || '[]'); } catch { return null; } })();
  const checks = [];

  const local = repoDriftOf(ROOT);
  checks.push({ id: `local:${ROOT}`, kind: '机器漂移', verdict: local.state ? local : judgeRepoDrift(local) });

  // 声明的其它**本机**仓（逗号分隔）：同一台机器上的第二个仓同样会漂（服务器上的 ai-gateway-stack
  // 实测躺了 9 天没推）。
  for (const dir of String(process.env.DAO_HYGIENE_REPOS || '').split(',').map(s => s.trim()).filter(Boolean)) {
    const drift = repoDriftOf(dir);
    checks.push({ id: `local:${dir}`, kind: '机器漂移', verdict: drift.state ? drift : judgeRepoDrift({ ...drift, mustBeClean: true }) });
  }

  if (machines === null) {
    checks.push({ id: 'machines', kind: '机器漂移', verdict: { state: 'unscanned', why: 'DAO_HYGIENE_MACHINES 不是合法 JSON（没查成）' } });
  } else if (!machines.length) {
    // 空清单 = 只查本机：这是**配置选择**，不是「探测失败」——长期假红会让这道闸被关掉
    // （本仓的老话：随机误报的闸最后一定被关掉）。所以留成绿 + 说明，看得见但不当红。
    checks.push({ id: 'machines', kind: '机器漂移', verdict: { state: 'green', why: '未声明远端机器——只查了本机的仓（要覆盖别的机器就填 DAO_HYGIENE_MACHINES）' } });
  } else {
    for (const m of machines) {
      const drift = remoteDriftOf(m);
      checks.push({ id: `${m.ssh}:${m.path}`, kind: '机器漂移', verdict: drift.state ? drift : judgeRepoDrift({ ...drift, mustBeClean: m.mustBeClean === true }) });
    }
  }

  const backlog = prBacklog();
  checks.push({ id: 'pr-backlog', kind: 'PR 积压', verdict: backlog.state ? backlog : judgePrBacklog({ open: backlog.open, ...HYGIENE_DEFAULTS }) });

  checks.push({ id: 'issue-retire', kind: '落后单清退', verdict: issueRetire() });
  checks.push({ id: 'debt-ledger', kind: '债册子', verdict: debtLedger() });
  checks.push({ id: 'stage-board', kind: '阶段盘面', verdict: stageBoard() });

  const summary = summarizeHygiene(checks.map(c => c.verdict));
  if (json) {
    process.stdout.write(`${JSON.stringify({ summary, checks }, null, 2)}\n`);
  } else {
    for (const c of checks) {
      const mark = c.verdict.state === 'green' ? '✓' : c.verdict.state === 'red' ? '✗' : '?';
      process.stdout.write(`${mark} [${c.kind}] ${c.id} — ${c.verdict.why}\n`);
    }
    process.stdout.write(`\n仓库卫生：绿 ${summary.counts.green} / 红 ${summary.counts.red} / 没查成 ${summary.counts.unscanned}\n`);
    if (summary.counts.unscanned) process.stdout.write('「没查成」不是绿：连不上或取不到数，先看为什么。\n');
  }
  return summary.state === 'green' ? 0 : 1;
}

process.exit(main());
