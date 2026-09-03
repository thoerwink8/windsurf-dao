#!/usr/bin/env node
// scripts/memory-sync.mjs —— memory 仓定期自动同步（2026-08-22 用户拍板）
//
// 场景：memory 仓（thoerwink8/windsurf-dao-memory，私有）靠本机 Junction 接着，
// 随写随改，但「改了没 push」换机就丢。本脚本：有未提交改动 → add+commit；
// 有未推送提交 → push；远端领先 → 先 pull --rebase（冲突只报不合）。
//
// 触发：本机手动 `node scripts/memory-sync.mjs --once` / `--force`（#807 起不再挂守卫保活）。
// 时间门在 planMemorySync 里（默认 30 分钟），高频调用无害。
// 只报不拦：任何失败打印 + 非零退出，但不拦调用方主流程。
//
// 用法：
//   node scripts/memory-sync.mjs --once      时间门内跳过，到门才真同步（默认）
//   node scripts/memory-sync.mjs --force     绕过时间门立刻同步
//   node scripts/memory-sync.mjs --dry-run   只打印计划不动手

import { appendFileSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { planMemorySync, parseAheadBehind } from './lib/memory-sync.mjs';
import { resolveMemoryDir } from './lib/memory-strikes-check.mjs';
import { defaultHome } from './lib/dao-memory-link-check.mjs';

const HERE = fileURLToPath(import.meta.url);
const REPO_ROOT = join(dirname(HERE), '..');

function statePath() {
  return join(homedir(), '.dao', 'memory-sync.json');
}

function readState() {
  try { return JSON.parse(readFileSync(statePath(), 'utf8')); }
  catch { return { lastSyncMs: null }; }
}

function writeState(patch) {
  try {
    mkdirSync(dirname(statePath()), { recursive: true });
    writeFileSync(statePath(), JSON.stringify({ ...readState(), ...patch }), 'utf8');
    return true;
  } catch { return false; }
}

function git(dir, args, timeout = 20000) {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8', timeout });
  if (r.error || r.status !== 0) {
    return { ok: false, error: String(r.error?.message || r.stderr || `exit ${r.status}`).trim().slice(0, 200) };
  }
  return { ok: true, out: String(r.stdout || '') };
}

function emit(payload, code = 0) {
  const line = JSON.stringify({ at: new Date().toISOString(), ...payload });
  console.log(line);
  // detached 运行时 stdout 没人读：结果同时落 jsonl，失败可查可见
  try {
    const logFile = join(homedir(), '.dao', 'memory-sync.jsonl');
    mkdirSync(dirname(logFile), { recursive: true });
    appendFileSync(logFile, line + '\n');
  } catch { /* 落痕失败不挡主流程 */ }
  process.exit(code);
}

function main() {
  const argv = process.argv.slice(2);
  const force = argv.includes('--force');
  const dryRun = argv.includes('--dry-run');

  const home = defaultHome(process.env);
  const mem = resolveMemoryDir({ root: REPO_ROOT, home });
  if (mem.skip) {
    emit({ ok: true, action: 'skip', reason: `memory 未接：${mem.error}（SKIP 不是绿也不是错）` });
  }
  if (!existsSync(join(mem.dir, '.git'))) {
    emit({ ok: true, action: 'skip', reason: `${mem.dir} 不是 git 仓（没查成 ≠ 干净）` });
  }

  const st = git(mem.dir, ['status', '--porcelain']);
  if (!st.ok) emit({ ok: false, action: 'unscanned', error: `git status 没查成：${st.error}` }, 1);
  const dirtyCount = st.out.split('\n').filter(Boolean).length;

  // 时间门先于 fetch：门内跳过不耗网络
  const state = readState();
  const gated = planMemorySync({
    connected: true, dirtyCount, ahead: 0, behind: 0,
    now: Date.now(), lastSyncMs: state.lastSyncMs, force,
  });
  if (gated.action === 'skip-fresh') emit({ ok: true, ...gated });

  const fetch = git(mem.dir, ['fetch', 'origin', '--quiet'], 30000);
  if (!fetch.ok) emit({ ok: false, action: 'unscanned', error: `git fetch 没查成：${fetch.error}` }, 1);
  const sb = git(mem.dir, ['status', '-sb']);
  if (!sb.ok) emit({ ok: false, action: 'unscanned', error: `git status -sb 没查成：${sb.error}` }, 1);
  const ab = parseAheadBehind(sb.out.split('\n')[0]);
  if (!ab.ok) emit({ ok: false, action: 'unscanned', error: ab.error }, 1);

  const plan = planMemorySync({
    connected: true, dirtyCount, ahead: ab.ahead, behind: ab.behind,
    now: Date.now(), lastSyncMs: state.lastSyncMs, force,
  });
  if (dryRun) emit({ ok: true, dryRun: true, ...plan });
  if (plan.action === 'noop-clean' || plan.action === 'skip-fresh') {
    writeState({ lastSyncMs: Date.now() });
    emit({ ok: true, ...plan });
  }

  const steps = [];
  if (plan.action === 'pull-rebase') {
    const pull = git(mem.dir, ['pull', '--rebase', 'origin'], 60000);
    steps.push({ cmd: 'pull --rebase', ok: pull.ok, error: pull.error || null });
    if (!pull.ok) {
      emit({ ok: false, action: 'report', error: `rebase 冲突或失败，只报不合：${pull.error}`, steps }, 1);
    }
  }
  if (plan.needCommit) {
    const add = git(mem.dir, ['add', '-A']);
    steps.push({ cmd: 'add -A', ok: add.ok, error: add.error || null });
    if (add.ok) {
      const msg = `sync: 自动同步 ${new Date().toISOString()}`;
      const commit = git(mem.dir, ['commit', '-m', msg, '--quiet']);
      steps.push({ cmd: 'commit', ok: commit.ok, error: commit.error || null });
    }
  }
  if (plan.needPush || plan.action === 'pull-rebase') {
    const push = git(mem.dir, ['push', 'origin'], 60000);
    steps.push({ cmd: 'push', ok: push.ok, error: push.error || null });
    if (!push.ok) {
      // 被拒（non-ff 等）不强推：显形等人处理——那多半是第二台机器在写的信号
      emit({ ok: false, action: 'report', error: `push 没成（不强推）：${push.error}`, steps }, 1);
    }
  }
  const failed = steps.filter(s => !s.ok);
  if (failed.length) {
    emit({ ok: false, action: 'report', error: `同步中途失败：${failed.map(s => s.cmd).join('、')}`, steps }, 1);
  }
  writeState({ lastSyncMs: Date.now() });
  emit({ ok: true, action: 'synced', steps });
}

main();
