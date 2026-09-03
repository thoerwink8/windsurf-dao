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
  const r = spawnSync(cmd, args, {
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
    const r = spawnSync(process.execPath, [hook, text], { encoding: 'utf8', timeout: 15000 });
    if (r.status !== 0) console.error(`报帅钩子失败：${String(r.stderr || r.status).slice(0, 160)}`);
    console.log(text);
    return;
  }
  const hub = '/home/orca/bin/hub-say';
  if (existsSync(hub)) {
    const r = spawnSync(hub, [text], { encoding: 'utf8', timeout: 20000 });
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

function switchReviewer({ pr, reviewer, parentWorktree, dryRun }) {
  if (dryRun) return { ok: true, dryRun: true, detail: `将换人：PR #${pr} → ${reviewer}` };
  const hook = process.env.AGENT_STALL_SWITCH;
  const cmd = hook
    ? [process.execPath, hook, '--pr', String(pr), '--reviewer', reviewer, ...(parentWorktree ? ['--parent-worktree', parentWorktree] : [])]
    : [process.execPath, DAO, 'reviewer-create', '--pr', String(pr), '--reviewer', reviewer, ...(parentWorktree ? ['--parent-worktree', parentWorktree] : [])];
  const r = spawnSync(cmd[0], cmd.slice(1), {
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
  const r = spawnSync('systemctl', ['list-timers', '--all'], { encoding: 'utf8', timeout: 8000 });
  if (!r.error && String(r.stdout || '').includes(PAD_TIMER)) bits.push(PAD_TIMER);
  if (bits.length) {
    console.error(`影子制度：垫片还在（${bits.join('；')}）。正式探测已接管，落地即删。`);
  }
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

  const agents = [];
  for (const t of terminals) {
    if (!t || !t.agentIdentity || !t.handle) continue;
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

  const prev = loadState(args.state);
  const need = Number(process.env.AGENT_STALL_STRIKES || 2);
  const round = scanRound({ agents, prevState: prev, strikesNeeded: need });
  saveState(args.state, round.nextState);

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
        dryRun: args.dryRun,
      });
      console.log(`· ${who} 命中 ${hit.sig} → ${sw.detail}（${decision.from} → ${decision.to}）`);
      lines.push({ name: hit.displayName, action: 'switch', ok: sw.ok, from: decision.from, to: decision.to, detail: sw.detail });
      if (!sw.ok) failed += 1;
    } else if (decision.action === 'escalate') {
      console.log(`· ${who} 命中 ${hit.sig} → 报帅停手：${decision.reason}`);
      lines.push({ name: hit.displayName, action: 'escalate', reason: decision.reason });
    } else {
      console.log(`· ${who} 命中 ${hit.sig} → 只报警（${decision.reason}）`);
      lines.push({ name: hit.displayName, action: 'alert', reason: decision.reason });
    }
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
