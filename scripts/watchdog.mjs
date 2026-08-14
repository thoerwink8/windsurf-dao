#!/usr/bin/env node
// scripts/watchdog.mjs —— 事故路径停摆侦测（issue #442 正式版）
//
// 双通道监视里本脚本负责「事故路径」：协调者不再把「沉默」当「还在跑」。
// 快乐路径（工人完工自报 orchestration worker_done）不归本脚本，见 dispatch skill。
// 规格书 = issue #442 全部案例与对策（九条评论），一条案例对应下面一条检测。
//
// 检测矩阵（全部来自 #442 评论区实测案例）：
//   1. exited       —— 终端 read 状态 exited（「终端 exited 且非完工态」独立报警，拍板追加①：
//                       卡片被误关、工人瞬灭，不能混在交卷/报错里）
//   2. waiting      —— ps agents[].state=waiting（审批弹窗被刷屏点阵埋没案：弹窗看不见，
//                       但 ps 的 waiting 就是「有弹窗/等输入」的官方信号，零关键字猜测）
//   3. fingerprint  —— 屏面底部当前状态窗口命中错误指纹清单（Grok 断线案 + GPT 断流案 +
//                       盲考案三份指纹，常量数组便于 append）
//   4. hash-stable  —— 整屏内容哈希连续三轮不变（v0.4 用滚动缓冲 cursor 停滞判停摆，
//                       对 reclaude 全屏 TUI 恒假阳性——alt-screen 重绘不产生滚动行；
//                       v0.5 改整屏哈希：干活时状态栏 token/费用/计时在变，哈希必变）
//   5. read-failed  —— working 工位却读不到屏面（守卫自身失效必须显形，不能静默）
//
// 两个窗口（#442 v0 首战假阳性教训的落点）：
//   --window       整屏窗口（默认 60 行）：哈希判据用，「整屏内容哈希」是钦定的全屏 TUI 通用信号。
//   --state-window 屏面底部状态窗口（默认 12 行）：错误指纹判据用。只看屏面底部当前状态，
//                  不对历史叙述做关键字匹配——v0 就是把审官叙述里的「两个样本都被拦」
//                  误判成求助等待。指纹字样出现在上部叙述里不算数，出现在底部才算数。
//
// 仓规硬约束：
//   - 输出必须区分「扫完 0 异常」（打印一行 OK 汇总，含扫描工位数）与
//     「没扫到任何工位」（明确打印 NO_TARGETS 警告）——数到 0 和没看到样本不是一回事，
//     分不开就会把「没查成」记成「查过没事」。
//   - 检测逻辑只用 orca 官方输出（worktree ps / terminal list / terminal read），
//     不碰工人的自报（lastAssistantMessage 一律不读）。
//   - 监视对象每轮从 ps 自动枚举 working/waiting 态 agent，无手动名单
//     （手动名单漏新工位是 2026-08-14 实测踩的坑）。
//
// 退出码：0 扫完 0 异常 / 1 有报警 / 2 NO_TARGETS（本轮没查成）/ 3 基础设施失败（ps 拉不到）。
//
// 用法：
//   node scripts/watchdog.mjs                    轮询模式（默认每 30s 一轮，供 Monitor 挂载）
//   node scripts/watchdog.mjs --once             跑单轮后退出（给测试用）
//   node scripts/watchdog.mjs --snapshot-dir <dir>  从录制的 ps/read JSON 快照跑检测（测试/复现用）
//   node scripts/watchdog.mjs --interval 20      轮询间隔秒数
//   node scripts/watchdog.mjs --window 80        整屏窗口行数
//   node scripts/watchdog.mjs --state-window 15  屏面底部状态窗口行数

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

const ORCA_TIMEOUT_MS = 30000;

// ── 屏面错误指纹清单（append-only）────────────────────────────────────
// 每条指纹对应 #442 评论区一个真实事故案例；新增事故时在这里加一行，
// 并同步在 tests/watchdog-fixtures/fingerprint/ 里补一条违规样本（上线前先故意构造违规样本，
// 被拦住才算生效——v0.4 跳过这步首报即翻车的教训）。
// 元素可以是普通字符串（大小写不敏感子串匹配）或正则字面量。
const ERROR_FINGERPRINTS = [
  'terminated',            // 盲考·Grok：Error: Retry failed after 3 attempts: terminated
  'Retry failed',          // 盲考·Grok：代理链路断线重试全败，几乎零产出死亡
  'no serving account',    // 盲考·GPT：pqgpt 中转池无可用账号（池竭/限流）断流
  'stream disconnected',   // 盲考·GPT：中转站断流（与 Grok 的 clash 抖动是两种不同断流）
  'login rejected',        // 登录被拒
  'Connection error',      // 连接错误
  'timed out connecting',  // 连接超时
  'Error:',                // #442 钦定的宽指纹，协调者收到后读屏分诊，不直接处置
  /Reconnecting.*5\/5/i,   // 盲考·GPT：Reconnecting 5/5 全败停机
];

// ── 参数 ─────────────────────────────────────────────────────────────

function printUsage() {
  console.log(`用法：
  node scripts/watchdog.mjs [--once] [--interval 秒] [--window 行] [--state-window 行] [--snapshot-dir 目录]

  --once             跑单轮后退出（给测试用）
  --interval <秒>     轮询间隔（默认 30）
  --window <行>       整屏窗口行数，哈希判据用（默认 60）
  --state-window <行> 屏面底部状态窗口行数，错误指纹判据用（默认 12）
  --snapshot-dir <目录> 从录制的 ps/read JSON 快照跑检测（测试/复现用），跑完即退出`);
}

function parseArgs(argv) {
  const args = { once: false, interval: 30, window: 60, stateWindow: 12, snapshotDir: null };
  const take = (i, name) => {
    const v = Number(argv[i + 1]);
    if (!Number.isFinite(v) || v <= 0) {
      console.error(`参数 ${name} 需要正整数`);
      process.exit(3);
    }
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--once': args.once = true; break;
      case '--interval': args.interval = take(i++, '--interval'); break;
      case '--window': args.window = take(i++, '--window'); break;
      case '--state-window': args.stateWindow = take(i++, '--state-window'); break;
      case '--snapshot-dir': args.snapshotDir = resolve(process.cwd(), argv[++i] || ''); break;
      case '--help': printUsage(); process.exit(0);
      default:
        console.error(`未知参数: ${a}`);
        printUsage();
        process.exit(3);
    }
  }
  return args;
}

// ── orca 采集（live 模式）───────────────────────────────────────────

function runOrca(cmdArgs) {
  const r = spawnSync('orca', cmdArgs, { encoding: 'utf8', timeout: ORCA_TIMEOUT_MS });
  if (r.error || r.status !== 0) {
    return { ok: false, error: String(r.error?.message || r.stderr || `exit ${r.status}`).trim().slice(0, 200) };
  }
  try {
    return { ok: true, json: JSON.parse(r.stdout) };
  } catch (e) {
    return { ok: false, error: `orca 输出不是 JSON: ${e.message}` };
  }
}

function unwrapPayload(json, pathKey, topKey) {
  const viaPath = json?.result?.[pathKey];
  if (Array.isArray(viaPath)) return viaPath;
  if (Array.isArray(json?.[topKey])) return json[topKey];
  return null;
}

// 返回 { ps, handleByPane, readTerminal }；ps 拉不到时返回 { infraError }
function makeLiveSource(window) {
  const psR = runOrca(['worktree', 'ps', '--json']);
  if (!psR.ok) return { infraError: `orca worktree ps --json 失败：${psR.error}` };
  const ps = unwrapPayload(psR.json, 'worktrees', 'worktrees');
  if (!Array.isArray(ps)) return { infraError: 'ps 输出结构不认识（没有 result.worktrees 数组）' };

  const tlR = runOrca(['terminal', 'list', '--json']);
  const terminals = tlR.ok ? (unwrapPayload(tlR.json, 'terminals', 'terminals') ?? []) : [];
  const handleByPane = new Map();
  for (const t of terminals) {
    if (t.tabId && t.leafId && t.handle) handleByPane.set(`${t.tabId}:${t.leafId}`, t.handle);
  }

  const cache = new Map();
  const readTerminal = (handle) => {
    if (cache.has(handle)) return cache.get(handle);
    const r = runOrca(['terminal', 'read', '--terminal', handle, '--limit', String(window), '--json']);
    const t = r.ok ? r.json?.result?.terminal : null;
    const res = r.ok && t
      ? { handle, status: t.status, tail: Array.isArray(t.tail) ? t.tail : [] }
      : { error: r.error };
    cache.set(handle, res);
    return res;
  };

  return { ps, handleByPane, readTerminal };
}

// ── 快照采集（--snapshot-dir 模式）──────────────────────────────────

function loadSnapshotRounds(dir) {
  if (!existsSync(dir)) {
    console.error(`快照目录不存在：${dir}`);
    process.exit(3);
  }
  const roundSubs = readdirSync(dir)
    .filter(d => /^round-\d+$/.test(d))
    .sort((a, b) => Number(a.slice(6)) - Number(b.slice(6)));
  const dirs = roundSubs.length > 0 ? roundSubs.map(d => join(dir, d)) : [dir];
  return dirs.map(loadSnapshotRound);
}

function loadSnapshotRound(roundDir) {
  const readJson = (name) => {
    const p = join(roundDir, name);
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, 'utf8'));
  };

  const psJson = readJson('ps.json');
  if (!psJson) throw new Error(`${roundDir}: 缺 ps.json，快照至少要有 ps 快照`);
  const ps = unwrapPayload(psJson, 'worktrees', 'worktrees');
  if (!Array.isArray(ps)) throw new Error(`${roundDir}: ps.json 结构不认识`);

  const tlJson = readJson('terminal-list.json');
  const terminals = tlJson ? (unwrapPayload(tlJson, 'terminals', 'terminals') ?? []) : [];
  const handleByPane = new Map();
  for (const t of terminals) {
    if (t.tabId && t.leafId && t.handle) handleByPane.set(`${t.tabId}:${t.leafId}`, t.handle);
  }

  const reads = new Map();
  for (const f of readdirSync(roundDir).filter(f => /^read-.+\.json$/.test(f))) {
    const j = JSON.parse(readFileSync(join(roundDir, f), 'utf8'));
    const t = j?.result?.terminal ?? j;
    const handle = t.handle || f.replace(/^read-/, '').replace(/\.json$/, '');
    reads.set(handle, {
      handle,
      status: t.status,
      tail: Array.isArray(t.tail) ? t.tail : [],
      error: t.error,
    });
  }

  const readTerminal = (handle) => {
    const t = reads.get(handle);
    if (!t) return { error: `快照里没有该终端的 read 文件（句柄 ${handle}）` };
    return t.error ? { error: t.error } : t;
  };

  return { ps, handleByPane, readTerminal, label: basename(roundDir) };
}

// ── 一轮扫描 ────────────────────────────────────────────────────────

function matchFingerprints(text) {
  const hits = [];
  for (const fp of ERROR_FINGERPRINTS) {
    if (fp instanceof RegExp ? fp.test(text) : text.toLowerCase().includes(String(fp).toLowerCase())) {
      hits.push(fp instanceof RegExp ? fp.source : String(fp));
    }
  }
  return hits;
}

const normLines = (lines) => (Array.isArray(lines) ? lines : [])
  .map(l => String(l).replace(/\r$/, ''))
  .join('\n')
  .trim();

function runRound(source, opts, state) {
  const targets = [];
  for (const w of source.ps) {
    const agents = Array.isArray(w.agents) ? w.agents : [];
    const mon = agents.filter(a => a.state === 'working' || a.state === 'waiting');
    if (mon.length === 0) continue;
    const multi = mon.length > 1;
    mon.forEach((a, i) => {
      targets.push({
        key: `${w.worktreeId || w.id || w.path || '?'}|${a.paneKey || i}`,
        name: multi ? `${w.displayName || '?'}#${i + 1}` : (w.displayName || '?'),
        agent: a,
        handle: a.paneKey ? source.handleByPane.get(a.paneKey) : undefined,
      });
    });
  }

  if (targets.length === 0) return { noTargets: true, targets, events: [] };

  const events = [];
  for (const t of targets) {
    const st = state.stations[t.key] ||= { hashLast: null, hashPrev: null, fired: new Set(), prevUpdatedAt: null };

    // ② ps waiting 态（弹窗/等输入的官方信号）
    if (t.agent.state === 'waiting') {
      if (!st.fired.has('waiting')) {
        st.fired.add('waiting');
        events.push({ name: t.name, type: 'waiting', detail: 'ps agents[].state=waiting——有弹窗/等输入（#442 官方信号），第一动作发一记回车或读屏辨弹窗' });
      }
    } else {
      st.fired.delete('waiting');
    }

    // 读屏面
    const read = t.handle ? source.readTerminal(t.handle) : { error: 'paneKey 在 terminal list 里没有对应句柄' };
    if (read.error) {
      if (!st.fired.has('read-failed')) {
        st.fired.add('read-failed');
        events.push({ name: t.name, type: 'read-failed', detail: `读不到终端屏面：${read.error}——working 却读不到屏面本身可疑` });
      }
      continue; // 屏面都读不到，下面的判据无从谈起
    }
    st.fired.delete('read-failed');

    // ① 终端 exited（独立于交卷/报错，拍板追加①：卡片被误关/非完工退场）
    if (read.status === 'exited') {
      if (!st.fired.has('exited')) {
        st.fired.add('exited');
        events.push({ name: t.name, type: 'exited', detail: '终端已退出（exited）——非完工态退场需人工分诊（#442 三分类：交卷→收卷、报错→重试、指纹两连→换人）' });
      }
    } else {
      st.fired.delete('exited');
    }

    const all = normLines(read.tail);
    const bottom = normLines(read.tail.slice(-opts.stateWindow));

    // ③ 错误指纹（只看屏面底部当前状态窗口，不对历史叙述做关键字匹配）
    const matched = matchFingerprints(bottom);
    if (matched.length > 0) {
      if (!st.fired.has('fingerprint')) {
        st.fired.add('fingerprint');
        events.push({ name: t.name, type: 'fingerprint', detail: `屏面底部命中错误指纹「${matched.join('、')}」——报错→原地续命一次，指纹两连同→换人不救（#442 分诊三分支）` });
      }
    } else {
      st.fired.delete('fingerprint');
    }

    // ④ 整屏哈希连续三轮不变（停摆候选信号；ps 的 updatedAt 在推进说明有活动，不算停摆）
    const hash = createHash('sha256').update(all).digest('hex');
    const updatedAt = t.agent.updatedAt ?? null;
    const activityAdvanced = st.prevUpdatedAt !== null && updatedAt !== null && updatedAt !== st.prevUpdatedAt;
    st.prevUpdatedAt = updatedAt;

    if (activityAdvanced) {
      // 官方信号说工人有活动（ps updatedAt 推进）——长命令无输出、静默思考都不算停摆
      st.fired.delete('hash-stable');
      st.hashPrev = null;
      st.hashLast = null;
    } else if (hash === st.hashLast && hash === st.hashPrev) {
      if (!st.fired.has('hash-stable')) {
        st.fired.add('hash-stable');
        events.push({ name: t.name, type: 'hash-stable', detail: '整屏哈希连续 3 轮不变——停摆候选（#442 全屏 TUI 通用信号），读屏分诊' });
      }
      st.hashPrev = st.hashLast;
      st.hashLast = hash;
    } else {
      if (hash !== st.hashLast) st.fired.delete('hash-stable'); // 屏面变了 = 新段落，旧停摆段结案
      st.hashPrev = st.hashLast;
      st.hashLast = hash;
    }
  }

  return { noTargets: false, targets, events };
}

function printRound(round) {
  if (round.noTargets) {
    console.log('NO_TARGETS: 本轮没有 working/waiting 工位——没查成，不是「扫完 0 异常」（数到 0 和没看到样本不是一回事）');
    return { alarm: false, noTargets: true };
  }
  if (round.events.length > 0) {
    for (const e of round.events) console.log(`[${e.name}] ${e.type}: ${e.detail}`);
    return { alarm: true, noTargets: false };
  }
  const names = round.targets.map(t => t.name).join('、');
  console.log(`OK 扫完 ${round.targets.length} 个工位（${names}），0 异常`);
  return { alarm: false, noTargets: false };
}

// ── 主流程 ──────────────────────────────────────────────────────────

const args = parseArgs(process.argv.slice(2));
const state = { stations: new Map() };
let anyAlarm = false;
let anyNoTargets = false;

function executeOneRound(source) {
  const round = runRound(source, args, state);
  const r = printRound(round);
  if (r.alarm) anyAlarm = true;
  if (r.noTargets) anyNoTargets = true;
}

// 同步 sleep：轮询循环用（Node 的 Atomics.wait 在共享内存上等待，阻塞当前线程）
function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function liveLoop() {
  console.log(`# watchdog live：每 ${args.interval}s 一轮（--window ${args.window} / --state-window ${args.stateWindow}）`);
  for (;;) {
    const source = makeLiveSource(args.window);
    if (source.infraError) {
      console.log(`[watchdog] PS_FETCH_FAILED: ${source.infraError}——本轮没查成`);
      if (args.once) process.exit(3);
    } else {
      executeOneRound(source);
      if (args.once) break;
    }
    sleep(args.interval * 1000);
  }
}

if (args.snapshotDir) {
  const rounds = loadSnapshotRounds(args.snapshotDir);
  const toRun = args.once ? rounds.slice(0, 1) : rounds;
  const multi = toRun.length > 1;
  toRun.forEach((source, i) => {
    if (multi) console.log(`# snapshot round ${i + 1}/${toRun.length}（${source.label}）`);
    executeOneRound(source);
  });
} else {
  liveLoop();
}

process.exit(anyAlarm ? 1 : anyNoTargets ? 2 : 0);
