#!/usr/bin/env node
// scripts/session-audit-hook.mjs —— 审计闸的 Stop hook 入口（issue #891 · W2）
//
// ── 为什么是 Stop ───────────────────────────────────────────────────────────
// Stop 每轮末**必触发**，是确定性时刻；判据只看 git 落地事实与账本里真实存在的事件，
// **零正则、零猜测**。`git show 286c9b3` 砍掉的四支（RECALL/SCAFFOLD/CLOSING/READY）
// 全是靠正则猜用户说话方式的概率层软提醒，本 hook 刻意站在留下来那一边。
//
// ── 为什么落在 scripts/ 而不是 host/skills/<名>/hooks/（任务书点的那个范式）────
// 那个范式有一条硬约束，写在 `host/skills/dao-mode/hooks/dao-mode.mjs:129`：
//   「本文件作为 Claude 插件分发（CLAUDE_PLUGIN_ROOT 场景仓外没有 scripts/lib），必须自包含」
// 本闸要用 `scripts/lib` 的四个模块（session-audit / redact / ledger-home+query / event-writer）。
// 塞进 skill 目录只有两条路，两条都错：
//   ① 把四个模块各抄一份进 skill 目录 —— 判据分两份，必漂移（redact.js 头注有实证）；
//   ② 跨 symlink 相对 import scripts/lib —— 破掉「skill 目录可独立分发」这条既有约束。
// ⇒ 落 scripts/（仓内机械件），注册面走 `~/.claude/settings.json` 的 Stop 槽，
//   与 `admit-push` 的 UserPromptSubmit 注册同形（那条也是 settings 面注册）。
//   本仓不自动改用户的 settings.json（那是机器配置，归用户拍板）；注册片段见 PR 正文。
//   **指针有报警**：tests/session-audit.test.js 的「⑥落点」组断言本文件存在且能被
//   `node --check`，被挪走/改名即红——不留指向空气的指针。
//
// ── 静默是常态 ──────────────────────────────────────────────────────────────
// 没产出、或有产出且账上有事件 ⇒ 零输出、零写入。只有两种情况说话：
//   判红那一轮（写 audit.bypass，不打印）、下一轮（打一句提示，不写）。
//
// ── 异常一律 exit 0 ─────────────────────────────────────────────────────────
// 只增不阻：git 不在、账本不可写、stdin 是空的、状态文件坏了——全部静默退 0。
// 一个能阻断用户会话的审计闸，第一次误伤就会被永久关掉。
//
// 用法（宿主自动传 stdin JSON；手跑排障也走同一条路）：
//   echo '{"session_id":"x","cwd":"D:/frank/windsurf-dao"}' | node scripts/session-audit-hook.mjs
// 环境变量：
//   DAO_AUDIT_STATE_DIR  状态文件目录（默认 ~/.dao/session-audit），测试用
//   LEDGER_EVENTS_DIR    账本目录（沿用 ledger-home 的既有覆写）
//   DAO_AUDIT_TIERS      算实质产出的档，逗号分隔（默认 commit,pr；加 dirty 把工作树改动也算上）
//   DAO_AUDIT_PR         =1 时开 `gh pr list` 那条腿（默认关，理由见 collectPrs）

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir, hostname } from 'node:os';
import { join, resolve } from 'node:path';

import { auditTurn, remindLine, DEFAULT_TIERS } from './lib/session-audit.mjs';
import { redact, redactDeep } from './lib/redact.mjs';
import { defaultLedgerDir } from './lib/ledger-home.mjs';
import { readLedgerEvents } from './lib/ledger-query.mjs';
import { writeEvent, nextSeq } from './lib/event-writer.mjs';

const ROOT = resolve(import.meta.dirname, '..');
/** 首轮回看窗：状态文件还不存在时往回看多久。有界——绝不把远古 commit 扫进来。 */
const FIRST_RUN_LOOKBACK_MS = 30 * 60 * 1000;

function nowIso() {
  // 带时区的 ISO8601（schema 要求）。Date#toISOString 给的是 Z，合法。
  return new Date().toISOString();
}

function readStdinJson() {
  try {
    return JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    return {};
  }
}

function git(cwd, args, timeout = 5000) {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout });
  if (r.error || r.status !== 0) return null; // null = 这条腿没查成，与「查到空」分得开
  return String(r.stdout || '');
}

// ── 采集：三条腿，各自「查到 / 查到空 / 没查成」三态 ─────────────────────────

function collectCommits(cwd, since) {
  // 不用 `git log --since`（它按 committer date 做模糊解析，且本地化影响判据）；
  // 自己取 %cI（严格 ISO8601）再比毫秒，判据留在本文件里可测。
  const out = git(cwd, ['log', '--format=%H%x1f%cI%x1f%s', '-n', '80']);
  if (out === null) return null;
  const sinceMs = Date.parse(since);
  const commits = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const [sha, ts, ...rest] = line.split('\x1f');
    const t = Date.parse(ts);
    if (!Number.isFinite(t) || t < sinceMs) continue;
    commits.push({ sha, ts, subject: rest.join('\x1f') });
  }
  return commits;
}

function collectDirty(cwd) {
  const out = git(cwd, ['status', '--porcelain']);
  if (out === null) return null;
  return out.split('\n').map(l => l.slice(3).trim()).filter(Boolean);
}

// `gh pr list` 是**网络调用**，默认关。理由：它会给每一个回合的末尾都加上一次网络等待，
// 而这条腿在判据上几乎总被 commit 腿盖住（PR 前面必有 commit）。开着的收益只剩
// 「只改了 PR 描述、没有新 commit」这一种，代价是每轮一次网络往返 ⇒ 默认关、可开。
// 关着时**明确记成「没查成」**（不是「没有 PR」），由纯函数带进 why——三态不许合并。
function collectPrs(cwd) {
  if (process.env.DAO_AUDIT_PR !== '1') return null;
  const r = spawnSync('gh', ['pr', 'list', '--limit', '5', '--json', 'number,updatedAt,title'], {
    cwd, encoding: 'utf8', timeout: 5000,
  });
  if (r.error || r.status !== 0) return null;
  try {
    // `ts` 原样带上 updatedAt，**窗口过滤交给纯函数**（produceKeys 按 since 筛）——
    // 首版没有这道过滤，一个很久以前仍 open 的 PR 每轮 Stop 都被算成本轮产出（审官 P2）。
    // 过滤不放在这里是刻意的：判据要能被单测直接喂样本，采集侧换实现不该把它带走。
    return JSON.parse(r.stdout || '[]').map(p => ({ number: p.number, ts: p.updatedAt, updatedAt: p.updatedAt, title: p.title }));
  } catch {
    return null;
  }
}

// ── 会话状态：`since`（本轮起点）与 `reminded`（提示过的 audit.bypass）─────────
// 一个文件两用。放 ~/.dao/session-audit/ 而不是账本目录——账本是不可变事件流，
// 不该混进可变的进程状态。

function stateDir() {
  return process.env.DAO_AUDIT_STATE_DIR
    ? resolve(process.env.DAO_AUDIT_STATE_DIR)
    : join(homedir(), '.dao', 'session-audit');
}

function stateFile(sessionId) {
  const safe = String(sessionId || 'unknown').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80);
  return join(stateDir(), `${safe}.json`);
}

function readState(file) {
  try {
    const d = JSON.parse(readFileSync(file, 'utf8'));
    return {
      since: typeof d.since === 'string' ? d.since : null,
      reminded: Array.isArray(d.reminded) ? d.reminded.map(String) : [],
      // pending = 判过漏记、至今没被事件指向的产出键。**必须跨轮带着走**：产出只在落地那一轮
      // 出现在 git 窗口里，不存下来的话下一轮就看不见它了，`remind` 永远不会发生（审官 P1 实咬）。
      pending: Array.isArray(d.pending) ? d.pending.map(String) : [],
    };
  } catch {
    // 不在 / 坏了 ⇒ 当首轮。坏了不报错也不修：状态文件是缓存，重建即可。
    return { since: null, reminded: [], pending: [] };
  }
}

function writeState(file, state) {
  try {
    mkdirSync(stateDir(), { recursive: true });
    writeFileSync(file, JSON.stringify(state, null, 2) + '\n', 'utf8');
    return true;
  } catch {
    return false; // 写不了 = 下一轮当首轮；顶多多看一次窗口，不阻断
  }
}

// ── 主流程 ──────────────────────────────────────────────────────────────────

function main() {
  const payload = readStdinJson();
  const cwd = payload.cwd && existsSync(String(payload.cwd)) ? String(payload.cwd) : ROOT;
  const file = stateFile(payload.session_id);
  const prev = readState(file);
  const now = nowIso();
  const since = prev.since || new Date(Date.now() - FIRST_RUN_LOOKBACK_MS).toISOString();

  const commits = collectCommits(cwd, since);
  const dirty = collectDirty(cwd);
  const prs = collectPrs(cwd);
  const unscanned = [];
  if (commits === null) unscanned.push('commits');
  if (dirty === null) unscanned.push('dirty');
  if (prs === null) unscanned.push('prs');
  const produced = { commits: commits || [], prs: prs || [], dirty: dirty || [], unscanned };

  const { dir: ledgerDir } = defaultLedgerDir();
  const read = readLedgerEvents(ledgerDir);
  const events = read.unscanned ? { unscanned: true, error: read.error } : read.events;

  const tiers = process.env.DAO_AUDIT_TIERS
    ? process.env.DAO_AUDIT_TIERS.split(',').map(s => s.trim()).filter(Boolean)
    : DEFAULT_TIERS;

  const result = auditTurn({
    produced, events, since, tiers,
    carry: prev.pending,
    reminded: prev.reminded,
    sessionId: payload.session_id ? String(payload.session_id) : null,
  });
  // `since` 照常推进（窗口只管「本轮新落地什么」），未补记的产出靠 pending 跨轮带走——
  // 两者分开是这次修复的要点：把窗口拉长会让同一批 commit 反复报警，把产出存下来才对。
  // 例外：账本没读成（unscanned）时**不要推进 since**。pending 已保住本轮键，冻窗口是双保险——
  // 账本恢复后 git 窗口仍能看见那批 commit（指挥官 round-1 方案；审官原文「或等价地不要推进窗口」）。
  const next = {
    since: result.verdict === 'unscanned' ? since : now,
    reminded: prev.reminded,
    pending: result.pending || [],
  };

  if (result.verdict === 'missing') {
    // 写前必过 redact：detail 里有 commit subject（人写的自由文本，最可能夹带凭据），
    // evidence 里有文件相对路径。整个 payload 走 redactDeep，别逐字段挑。
    try {
      const schema = JSON.parse(readFileSync(join(ROOT, 'schemas', 'events.schema.json'), 'utf8'));
      const machine = hostname();
      const { event } = writeEvent({
        dir: ledgerDir,
        type: 'audit.bypass',
        ts: now,
        machine,
        seq: nextSeq(ledgerDir, machine),
        payload: redactDeep({
          detail: result.detail,
          evidence: result.missing,
          why: result.why,
          source: 'session-audit-hook',
          session_id: String(payload.session_id || ''),
          since,
        }),
        schema,
      });
      next.reminded = prev.reminded; // 本轮只报警不提示；提示是下一轮的事
      // 判红那一轮**不打印**：产出刚落地，人还在场，账上的那条足够；打印等于抢话。
      void event;
    } catch {
      // 账本不可写 / schema 读不到 / 同内容已入账（幂等撞车）—— 全部静默。
      // 尤其「同内容已入账」是正常的重复触发，报错就是把幂等当故障。
    }
  } else if (result.verdict === 'remind') {
    process.stdout.write(redact(remindLine(result)) + '\n');
    next.reminded = [...new Set([...prev.reminded, ...result.remindFor])];
  }

  writeState(file, next);
}

try {
  main();
} catch {
  // 只增不阻：任何没预料到的异常都不许把用户的会话卡住，也不许刷屏。
}
process.exit(0);
