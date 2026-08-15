#!/usr/bin/env node
// scripts/watchdog.mjs —— 事故路径停摆侦测（issue #442 正式版，2026-08-15 融合改造瘦身）
//
// 双通道监视里本脚本负责「事故路径」：协调者不再把「沉默」当「还在跑」。
// 快乐路径（工人完工自报 orchestration worker_done）不归本脚本，见 dispatch skill。
// 规格书 = issue #442 全部案例与对策 + fusion-verdict.md（2026-08-15 拍板裁定书）。
//
// 检测矩阵（全部来自 #442 实测案例）：
//   1. exited       —— 终端 read 状态 exited（「终端 exited 且非完工态」独立报警，拍板追加①）
//   2. waiting      —— ps agents[].state=waiting（审批弹窗被刷屏点阵埋没案：ps 的 waiting
//                       就是「有弹窗/等输入」的官方信号，零关键字猜测）
//   3. fingerprint  —— 屏面底部当前状态窗口命中错误指纹清单，**两连同才报警**（2026-08-15 裁定书：
//                       单发即唤醒的宽指纹 'Error:'/'terminated'/'Connection error' 已退役）；
//                       报警前活证否决：输出 cursor 在前进 → 降级为日志行不唤醒（审官屏面讨论止血阀）
//   4. stall        —— 主判据 = 输出 cursor 连续三轮不前进（2026-08-15 裁定书：整屏哈希会被 TUI
//                       计时器动画骗过——grok 卡流 3 分钟实证，屏面动画在动、cursor 不动）；
//                       快照无 cursor 数据时回退整屏哈希三轮不变（v0.5 信号保留为兜底）
//   5. read-failed  —— 被监视工位却读不到屏面（守卫自身失效必须显形，不能静默）
//
// 两个窗口（#442 v0 首战假阳性教训的落点）：
//   --window       整屏窗口（默认 60 行）：哈希兜底判据用。
//   --state-window 屏面底部状态窗口（默认 12 行）：错误指纹判据用。只看屏面底部当前状态，
//                  不对历史叙述做关键字匹配——v0 就是把审官叙述里的「两个样本都被拦」
//                  误判成求助等待。
//
// 结构性排除（审读红 2 落点：不能靠 displayName 黑名单）：
//   - 主工作区（isMainWorktree）：master 卡只住协调者，永远零工人（dispatch skill 拓扑），
//     协调者/主会话不在被监视集合内。
//   - 监视器自己的工作区（--self-worktree；live 模式自动从 `orca worktree current` 取）：
//     监视器运行在被监视集合之外。
//   - --exclude-pane <paneKey>（可重复）：按稳定 pane ID **分级排除**（2026-08-15 裁定书）——
//     豁免指纹与停摆判据（审官/控制端屏面讨论不再自误报），但保留 exited/waiting 死活判据
//     （旧版整体排除 = 死活也没人盯，再造盲区）。
//
// 仓规硬约束：
//   - 输出必须区分「扫完 0 异常」（打印一行 OK 汇总，含扫描工位数）与
//     「没扫到任何工位」（明确打印 NO_TARGETS 警告）——数到 0 和没看到样本不是一回事。
//   - 检测逻辑只用 orca 官方输出（worktree ps / terminal list / terminal read），
//     不碰工人的自报（lastAssistantMessage 一律不读）。
//   - 监视对象每轮从 ps 自动枚举 working/waiting 态 agent，无手动名单。
//   - 读不到屏面一律 fail-visible：读失败 / 成功响应缺字段 / 结构不认识都报 read-failed，
//     不静默放行（审读红 3 落点）。
//
// 退出码：0 扫完 0 异常（活证否决的观察行不唤醒）/ 1 有报警 / 2 NO_TARGETS（本轮没查成）/ 3 基础设施失败。
//
// 用法：
//   node scripts/watchdog.mjs                    轮询模式（默认每 30s 一轮，供 Monitor 挂载）
//   node scripts/watchdog.mjs --once             跑单轮后退出（给测试用）
//   node scripts/watchdog.mjs --snapshot-dir <dir>  从录制的 ps/read JSON 快照跑检测（测试/复现用）
//   node scripts/watchdog.mjs --interval 20      轮询间隔秒数
//   node scripts/watchdog.mjs --window 80        整屏窗口行数
//   node scripts/watchdog.mjs --state-window 15  屏面底部状态窗口行数
//   node scripts/watchdog.mjs --self-worktree <id>  指定监视器自己的工作区 id（live 模式默认自动取）
//   node scripts/watchdog.mjs --exclude-pane <paneKey>  按稳定 pane ID 分级排除（可重复）

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

const ORCA_TIMEOUT_MS = 30000;

// ── 屏面错误指纹清单（append-only）────────────────────────────────────
// 每条指纹对应 #442 评论区一个真实事故案例；新增事故时在这里加一行，
// 并同步在 tests/watchdog-fixtures/ 里补一条违规样本（上线前先故意构造违规样本，
// 被拦住才算生效——v0.4 跳过这步首报即翻车的教训）。
// 2026-08-15 裁定书：单发即唤醒的宽指纹（'Error:'/'terminated'/'Connection error'）已退役——
// 宽指纹命中正常叙述/讨论的概率高，是假阳性温床；且现在一律两连同才报警 + 活证否决兜底。
// 元素可以是普通字符串（大小写不敏感子串匹配）或正则字面量。
const ERROR_FINGERPRINTS = [
  'Retry failed',          // 盲考·Grok：代理链路断线重试全败（Retry failed after 3 attempts）
  'no serving account',    // 盲考·GPT：pqgpt 中转池无可用账号（池竭/限流）断流
  'stream disconnected',   // 盲考·GPT：中转站断流（与 Grok 的 clash 抖动是两种不同断流）
  'login rejected',        // 登录被拒
  'timed out connecting',  // 连接超时
  /Reconnecting.*5\/5/i,   // 盲考·GPT：Reconnecting 5/5 全败停机
  'at capacity',           // 2026-08-15 实录：GPT/codex 报 ⚠ Selected model is at capacity
                           //   → 当轮中断、TUI 落回空闲、屏面静止（#442 新指纹语料）
  'try a different model', // 同上，同句报错的另一半
];

// ── 参数 ─────────────────────────────────────────────────────────────

function printUsage() {
  console.log(`用法：
  node scripts/watchdog.mjs [--once] [--interval 秒] [--window 行] [--state-window 行]
                            [--snapshot-dir 目录] [--self-worktree <id>] [--exclude-pane <paneKey>]...

  --once             跑单轮后退出（给测试用）
  --interval <秒>     轮询间隔（默认 30）
  --window <行>       整屏窗口行数，哈希判据用（默认 60）
  --state-window <行> 屏面底部状态窗口行数，错误指纹判据用（默认 12）
  --snapshot-dir <目录> 从录制的 ps/read JSON 快照跑检测（测试/复现用），跑完即退出
  --self-worktree <id> 监视器自己的工作区 id（live 模式默认从 orca worktree current 自动取）
  --exclude-pane <paneKey> 按稳定 pane ID 排除控制端/审官会话（可重复，不维护 displayName 名单）`);
}

function parseArgs(argv) {
  const args = { once: false, interval: 30, window: 60, stateWindow: 12, snapshotDir: null, selfWorktree: null, excludePanes: [] };
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
      case '--self-worktree': args.selfWorktree = argv[++i] || ''; break;
      case '--exclude-pane': args.excludePanes.push(argv[++i] || ''); break;
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
    // orca 的非零退出把结构化错误 JSON 打在 stdout（实测：terminal_handle_stale 的
    // {ok:false, error:{code,message}} 在 stdout 上、stderr 为空）——先试解析，
    // 拿到 error 就原样透传（live 与快照同形态、错误码不丢，审读红 ② 返工）；
    // 拿不到（spawn 失败/超时/stdout 不是 JSON）再回落 stderr/exit N 字符串。
    if (r.stdout) {
      try {
        const parsed = JSON.parse(r.stdout);
        if (parsed && parsed.error) return { ok: false, error: parsed.error };
      } catch { /* stdout 不是 JSON，走回落 */ }
    }
    return { ok: false, error: String(r.error?.message || r.stderr || `exit ${r.status}`).trim().slice(0, 200) };
  }
  try {
    return { ok: true, json: JSON.parse(r.stdout) };
  } catch (e) {
    return { ok: false, error: `orca 输出不是 JSON: ${e.message}` };
  }
}

// 错误详情转可读文本：runOrca 对 orca JSON 错误原样透传结构化 error（{code,message}），
// 展示处统一走这里（normalizeReadResponse 与 ps/list/current 失败消息共用），
// 避免模板串把结构化错误打成 [object Object]。
function errText(e) {
  if (e == null) return '';
  if (typeof e === 'string') return e;                                    // runOrca 回落形态（spawn 失败/stdout 非 JSON）
  if (typeof e === 'object') return e.code ? `orca 报错 ${e.code}: ${e.message}` : String(e.message || e);
  return '';                                                             // 未知形态不编故事，交给调用方兜底
}

function unwrapPayload(json, pathKey, topKey) {
  const viaPath = json?.result?.[pathKey];
  if (Array.isArray(viaPath)) return viaPath;
  if (Array.isArray(json?.[topKey])) return json[topKey];
  return null;
}

// 终端的 paneKey（tabId:leafId）→ {handle, incarnationId}；读失败一律 fail-visible。
function buildPaneIndex(terminals) {
  const idx = new Map();
  for (const t of terminals) {
    if (t.tabId && t.leafId && t.handle) {
      idx.set(`${t.tabId}:${t.leafId}`, { handle: t.handle, incarnationId: t.incarnationId ?? null });
    }
  }
  return idx;
}

// ── terminal read 响应规整（live 与快照共用同一段逻辑）──────────────
// #452 复核收口建议 ②：快照样本必须打在 live 用的同一段规整逻辑上，否则
// makeLiveSource() 的 `!r.ok || !t` 分支只有肉眼 + live 实跑背书。
// res 形态 = runOrca 返回的 {ok, json, error}；快照加载时把原始 JSON 包成同形态再传入。
// 返回 {handle, status, tail, nextCursor} 或 {error}；读失败一律 fail-visible（审读红 3）。
// nextCursor：输出光标位置（绝对进度），活证否决 + 停摆主判据共用；旧快照可能没有 → null。
function normalizeReadResponse(res, handle) {
  if (!res || res.ok !== true) {
    // res.error 可能是结构化对象（orca JSON 错误，live/快照同形态）或字符串（runOrca 回落）
    return { error: `orca terminal read 失败：${errText(res?.error) || '无错误详情'}` };
  }
  const t = res.json?.result?.terminal;
  if (!t) return { error: 'orca terminal read 成功响应但缺 result.terminal（结构畸形）' };
  if (typeof t.status !== 'string' || !Array.isArray(t.tail)) {
    return { error: 'orca terminal read 成功响应但 status/tail 字段缺失（结构畸形）' };
  }
  const nc = t.nextCursor;
  return {
    handle: t.handle || handle,
    status: t.status,
    tail: t.tail,
    nextCursor: nc == null ? null : Number(nc),
  };
}

// 返回 { ps, paneByKey, readTerminal, tlError }；ps 拉不到时返回 { infraError }
function makeLiveSource(window) {
  const psR = runOrca(['worktree', 'ps', '--json']);
  if (!psR.ok) return { infraError: `orca worktree ps --json 失败：${errText(psR.error)}` };
  const ps = unwrapPayload(psR.json, 'worktrees', 'worktrees');
  if (!Array.isArray(ps)) return { infraError: 'ps 输出结构不认识（没有 result.worktrees 数组）' };

  const tlR = runOrca(['terminal', 'list', '--json']);
  const terminals = tlR.ok ? unwrapPayload(tlR.json, 'terminals', 'terminals') : null;
  // 成功响应但结构缺失 = 显形，不能当成空表（审读红 3）
  const paneByKey = Array.isArray(terminals) ? buildPaneIndex(terminals) : new Map();
  const tlError = tlR.ok
    ? (Array.isArray(terminals) ? null : 'orca terminal list 成功响应但缺 result.terminals 数组')
    : `orca terminal list --json 失败：${errText(tlR.error)}`;

  const cache = new Map();
  const readTerminal = (handle) => {
    if (cache.has(handle)) return cache.get(handle);
    // 与快照加载共用同一段规整逻辑：读失败（!r.ok）/ 缺 result.terminal / 缺 status-tail 都 fail-visible
    const res = normalizeReadResponse(runOrca(['terminal', 'read', '--terminal', handle, '--limit', String(window), '--json']), handle);
    cache.set(handle, res);
    return res;
  };

  return { ps, paneByKey, readTerminal, tlError };
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
  const terminals = tlJson ? unwrapPayload(tlJson, 'terminals', 'terminals') : [];
  const paneByKey = Array.isArray(terminals) ? buildPaneIndex(terminals) : new Map();

  const reads = new Map();
  const handleFromName = (f) => f.replace(/^read-/, '').replace(/\.json$/, '');
  for (const f of readdirSync(roundDir).filter(f => /^read-.+\.json$/.test(f))) {
    const j = JSON.parse(readFileSync(join(roundDir, f), 'utf8'));
    // 快照文件即 orca 原始响应：包成 runOrca 返回形态，走 live 同一条规整逻辑
    // （#452 复核收口建议 ②：read-malformed / read-error 样本打在 live 用的同一段代码上）
    // 注意：手工变异单元样本（exited/ 等）只存 {result:…} 没有顶层 ok 字段——
    // 显式 ok:false 才算失败，缺失 ok 视为成功，否则手工样本全被当读失败。
    const res = normalizeReadResponse({ ok: j?.ok !== false, json: j, error: j?.error }, handleFromName(f));
    // 索引键：优先文件内 result.terminal.handle（live/ 等样本文件名不含句柄，靠内部 handle 对齐 pane 映射），
    // 失败响应（只有 error 无 handle）回退文件名（真实实录 read-error/ 文件名即句柄）。
    reads.set(res.handle || handleFromName(f), res);
  }

  const readTerminal = (handle) => {
    const t = reads.get(handle);
    if (!t) return { error: `快照里没有该终端的 read 文件（句柄 ${handle}）` };
    return t.error ? { error: t.error } : t;
  };

  return { ps, paneByKey, readTerminal, tlError: null, label: basename(roundDir) };
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

// 结构性排除：主工作区（协调者）、监视器自己的工作区——整体不进监视集合。
// --exclude-pane 是分级排除（2026-08-15 裁定书）：豁免指纹/停摆判据，保留 exited/waiting 死活判据——
// 审官/控制端屏面讨论不再自误报，但死活仍有人盯（旧版整体排除 = 死活也没人盯，再造盲区）。
// 全部按 id 判，不碰 displayName（审读红 2）。
function isExcluded(w, a, args) {
  if (w.isMainWorktree === true) return true;                       // master 卡只住协调者
  if (args.selfWorktree && w.worktreeId === args.selfWorktree) return true; // 监视器自己
  return false;
}

function isGradedExcluded(a, args) {
  return !!(a.paneKey && args.excludePanes.includes(a.paneKey));    // 稳定 pane ID → 分级排除
}

function runRound(source, args, state) {
  const targets = [];
  for (const w of source.ps) {
    const agents = Array.isArray(w.agents) ? w.agents : [];
    const mon = agents.filter(a => (a.state === 'working' || a.state === 'waiting') && !isExcluded(w, a, args));
    if (mon.length === 0) continue;
    const multi = mon.length > 1;
    mon.forEach((a, i) => {
      const pane = a.paneKey ? source.paneByKey.get(a.paneKey) : undefined;
      targets.push({
        key: `${w.worktreeId || w.id || w.path || '?'}|${a.paneKey || i}`,
        name: multi ? `${w.displayName || '?'}#${i + 1}` : (w.displayName || '?'),
        agent: a,
        handle: pane ? pane.handle : undefined,
        incarnationId: pane ? pane.incarnationId : null,
        graded: isGradedExcluded(a, args),
      });
    });
  }

  if (targets.length === 0) return { noTargets: true, targets, events: [] };

  const events = [];
  const notes = []; // 活证否决降级的观察行：打印但不唤醒（退出码不算报警）
  for (const t of targets) {
    const st = state.stations[t.key] ||= {
      epoch: null, lastHash: null, consecutive: 0, fired: new Set(), prevUpdatedAt: null, prevIncarnation: null,
      fpStreak: 0, prevCursor: null, cursorStreak: 0,
    };
    const graded = t.graded === true; // 分级排除：豁免指纹/停摆，保留 exited/waiting 死活判据

    // ② ps waiting 态（弹窗/等输入的官方信号）
    if (t.agent.state === 'waiting') {
      if (!st.fired.has('waiting')) {
        st.fired.add('waiting');
        events.push({ name: t.name, type: 'waiting', detail: 'ps agents[].state=waiting——有弹窗/等输入（#442 官方信号），第一动作发一记回车或读屏辨弹窗' });
      }
    } else {
      st.fired.delete('waiting');
    }

    // 读屏面（读失败一律 fail-visible，不静默放行——审读红 3）
    const read = t.handle ? source.readTerminal(t.handle) : { error: `paneKey 在 terminal list 里没有对应句柄（${source.tlError || 'terminal list 为空'}）` };
    if (read.error) {
      if (!st.fired.has('read-failed')) {
        st.fired.add('read-failed');
        events.push({ name: t.name, type: 'read-failed', detail: `读不到终端屏面：${read.error}——被监视工位却读不到屏面本身可疑` });
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
    const bottom = normLines(read.tail.slice(-args.stateWindow));

    // cursor 跟踪（活证否决 + 停摆主判据共用）：nextCursor 前进 = 有新增输出 = token 在动；
    // 无 cursor 数据（旧快照）→ null，两个判据各自回退。
    const cursorVal = read.nextCursor;
    const cursorAdvancing = st.prevCursor != null && cursorVal != null && cursorVal > st.prevCursor;
    st.prevCursor = cursorVal;

    // ③ 错误指纹（只看屏面底部当前状态窗口，不对历史叙述做关键字匹配）——
    //    两连同才报警（2026-08-15 裁定书：单发宽指纹已退役）+ 活证否决（cursor 前进降级为观察行）。
    if (!graded) {
      const matched = matchFingerprints(bottom);
      if (matched.length > 0) {
        st.fpStreak += 1;
        if (st.fpStreak >= 2 && !st.fired.has('fingerprint')) {
          if (cursorAdvancing) {
            // 活证否决：输出 cursor 在前进 = 讨论/输出在动——审官屏面讨论误报的止血阀，不唤醒
            notes.push({ name: t.name, type: '观察', detail: `指纹两连同「${matched.join('、')}」但输出 cursor 在前进——活证否决，不唤醒，仅记录（审官屏面讨论止血阀）` });
          } else {
            st.fired.add('fingerprint');
            events.push({ name: t.name, type: 'fingerprint', detail: `屏面底部命中错误指纹「${matched.join('、')}」两连同——报错→原地续命一次，指纹两连同→换人不救（#442 分诊三分支）` });
          }
        }
      } else {
        st.fpStreak = 0;
        st.fired.delete('fingerprint');
      }
    }

    // ④ 停摆判据（显式 epoch 状态机——审读红 4）：
    //    主判据 = 输出 cursor 连续三轮不前进（2026-08-15 裁定书：整屏哈希会被 TUI 计时器动画骗过——
    //    2026-08-15 grok 卡流 3 分钟实证，屏面动画在动、cursor 不动）；
    //    快照无 cursor 数据时回退整屏哈希三轮不变（v0.5 信号保留为兜底）。
    //    生命周期键 = 终端 incarnationId + ps updatedAt；任一变化 = 新 epoch，计数重新起算。
    const hash = createHash('sha256').update(all).digest('hex');
    const updatedAt = t.agent.updatedAt ?? null;
    const incarnation = t.incarnationId ?? null;
    const epoch = `${incarnation}|${updatedAt}`;
    st.prevUpdatedAt = updatedAt;
    st.prevIncarnation = incarnation;

    if (!graded && cursorVal != null) {
      // 主判据：输出 cursor 三轮不前进
      if (st.epoch !== epoch || cursorAdvancing) {
        st.epoch = epoch;
        st.cursorStreak = 1;                 // 本轮即新序列第 1 轮
        st.fired.delete('cursor-stalled');
      } else {
        st.cursorStreak += 1;
        if (st.cursorStreak >= 3 && !st.fired.has('cursor-stalled')) {
          st.fired.add('cursor-stalled');
          events.push({ name: t.name, type: 'cursor-stalled', detail: '输出 cursor 连续 3 轮不前进——停摆候选（主判据；整屏哈希会被 TUI 计时器动画骗过，2026-08-15 grok 卡流实证），读屏分诊' });
        }
      }
    } else if (!graded) {
      // 兜底（快照无 cursor 数据）：整屏哈希连续三轮不变
      if (st.epoch !== epoch) {
        st.epoch = epoch;
        st.lastHash = hash;
        st.consecutive = 1;                 // 本轮即新序列第 1 轮
        st.fired.delete('hash-stable');
      } else if (hash === st.lastHash) {
        st.consecutive += 1;
        if (st.consecutive >= 3 && !st.fired.has('hash-stable')) {
          st.fired.add('hash-stable');
          events.push({ name: t.name, type: 'hash-stable', detail: '整屏哈希连续 3 轮不变——停摆候选（#442 全屏 TUI 通用信号，无 cursor 数据时回退），读屏分诊' });
        }
      } else {
        st.lastHash = hash;
        st.consecutive = 1;
        st.fired.delete('hash-stable');
      }
    }
  }

  return { noTargets: false, targets, events, notes };
}

function printRound(round) {
  if (round.noTargets) {
    console.log('NO_TARGETS: 本轮没有 working/waiting 工位（结构性排除后）——没查成，不是「扫完 0 异常」（数到 0 和没看到样本不是一回事）');
    return { alarm: false, noTargets: true };
  }
  // 活证否决的观察行：打印但不唤醒（只记日志，不升级为报警）
  for (const n of round.notes || []) console.log(`[${n.name}] ${n.type}: ${n.detail}`);
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

function detectSelfWorktree() {
  const r = runOrca(['worktree', 'current', '--json']);
  const id = r.ok ? r.json?.result?.worktree?.id : null;
  return { id, error: r.ok ? (id ? null : 'orca worktree current 成功响应但缺 worktree.id') : `orca worktree current 失败：${errText(r.error)}` };
}

function liveLoop() {
  if (!args.selfWorktree) {
    const self = detectSelfWorktree();
    if (self.id) args.selfWorktree = self.id;
    else console.log(`[watchdog] SELF_WORKTREE_UNKNOWN: ${self.error}——本轮起不排除自己的工作区，请用 --self-worktree <id> 显式指定`);
  }
  console.log(`# watchdog live：每 ${args.interval}s 一轮（--window ${args.window} / --state-window ${args.stateWindow}${args.selfWorktree ? ' / self-worktree ' + args.selfWorktree.slice(0, 24) + '…' : ''}）`);
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
