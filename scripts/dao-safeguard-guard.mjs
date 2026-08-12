#!/usr/bin/env node
// ============================================================================
// dao-safeguard-guard.mjs —— Orca 层守护：救回降级会话（issue #336）+ 卡死看门狗（issue #348）
//
// 契约：
//   issue #336 —— 救回被安全拦截降级的 Claude Code 会话（背景见下）
//   issue #348 —— --watch-stall 卡死看门狗：同一终端屏面差分连续 N 轮（默认 3 轮×60s）
//                 零新行且未见 worker_done ⇒ stdout [STALL] 告警；只告警不杀，处置归协调者。
//   背景：Fable 5 的安全检查偶发误拦正常消息，宿主 Claude Code 自动把会话降级到
//   Opus 4.8 并提示 "Fable 5's safeguards flagged this message... Switched to Opus 4.8"。
//   会话内部无法自动补救（hook 无 safeguards 事件、/compact /model 无法从 hook 注入），
//   唯一可行路径是从 Orca 层盯终端、代用户敲命令。本脚本即那道守护。
//
// 它做什么（按 issue 方案）：
//   1. 轮询 `orca terminal read` 读受管终端输出（默认 30s 间隔）
//   2. 命中降级提示（匹配语料 = issue #336 英文原句的逐字片段，不自造变体）即依次：
//      /compact → 等压缩完成 → /model 切回 Fable 5 → 发「继续」
//   3. 同一终端补救上限 2 次（可配）；超限停手、留在降级模型并告警通知
//   4. 只碰显式授权的终端（--terminal 白名单），绝不自动发现、不动其他窗
//
// --watch-stall 模式（issue #348）做什么：
//   1. 每轮 `orca terminal read` 取尾内容，复用下方 newLinesStartIndex 差分引擎数新行
//   2. 连续 N 轮（默认 3）新行数 = 0 且 `orca orchestration inbox` 中未见该终端的
//      type==='worker_done' 消息（结构化字段判等）⇒ stdout [STALL] 告警（+ 可选 state-file）
//   3. 只告警不杀：不 send / 不 stop / 不 close；处置归协调者（掐/换人是判断）
//   4. 判定只用 差分行数 + 结构化信号；禁文案正则（2026-08-13 铁律：中文 Windows
//      stderr 是 GBK 乱码，文案匹配必死——见 ccswitch/rules/dao-writing-rules.md §二）
//   5. 完工信号用 inbox（只读 show，不改投递状态）而非 check（会消费/ack，会抢走
//      协调者正在等的 worker_done）——守护绝不能用 check 当完工探测。
//
// 三种态必须可区分（issue #337 教训：数到 0 与没看到样本，输出不许一样）：
//   'no_match'    —— 读到 ≥1 行，均未命中（正常，静默）
//   'no_samples'  —— 读到 0 行新输出（也是正常，但措辞与 no_match 不同）
//   'read_failed' —— 读取本身失败（进程错 / JSON 坏 / ok:false）—— 告警 + 计数，
//                    连续失败达阈值 → 挂起该终端（unknown）。绝不是「无事发生」。
//
// 近似与未实测处（照直写，勿当已校准）：
//   - 压缩完成的判据默认 = `orca terminal wait --for tui-idle`。这是 Orca 对 TUI
//     忙态的读屏，未在本机对真 Claude Code 降级会话实测过；若它对该 TUI 不成立，
//     用 --wait-mode sleep 退回固定时长等待。两个模式都是近似，待真机校准。
//   - `/model Fable 5` 一次发送+Enter 是否能无交互完成切模，取决于 Claude Code
//     版本对 /model <名称> 的处理；未在真机降级会话实测。若遇交互确认/选择器，
//     需校准命令模板（--model 可配）。
//   - 增量判定用尾内容差分（prevTail 与当前 tail 的最长重叠），不用 orca 的 --cursor：
//     终端保留环有上限（实测 --limit 不扩大它），环满后游标字段消失，增量读退化为整环重读。
//     差分重叠为 0 ⇒ 轮询间隔内输出已越过保留环 ⇒ 告警「期间若出现降级提示将漏检」。
//     这不是误报，是如实声明看不见。
//   - 首次轮询只建立基线、不扫描历史输出（避免陈旧降级提示误触发），除非
//     --scan-on-start。
//   - worker_done 检出靠 `orca orchestration inbox`，其 run 解析依赖 CLI 进程所在
//     worktree 的活跃终端。多 run 环境下若解析到别的 run 会看不到完工消息（保守方向是
//     误报 [STALL]，协调者以人工判断兜底）。未实测多 run。
//   - 一旦检出某终端 worker_done，该终端永久停止卡死告警（直到守护进程重启）；若协调者
//     把同一终端重新派单，旧 worker_done 仍会抑制新告警。未实测重派单场景。
//   - 工兵的心跳（orca orchestration send --type heartbeat）会在其终端回显响应行
//     （实测本机 send 打印 "Sent msg_..."），清零 stall 计数 ⇒ 心跳活跃的工兵不会误报。
//   - 终端 read 的 status 字段（running/exited…）是存活信号：已结束终端的静默合法，不算卡死。
//
// 自检与验证（命令坐标，值以跑出来的为准）：
//   node scripts/dao-safeguard-guard.mjs --selftest        # 纯函数自测，exit 0 = 过
//   node tests/dao-safeguard-guard.tests.js                # 回归网：自测桥接 + serviceStall 端到端
//                                                          # （假 runner 注入，见 serviceStall 的 deps 参数）+ state-file 字段（issue #361）
//   node scripts/dao-safeguard-guard.mjs --dry-run ...     # 干跑演示（见 --help）
//   node scripts/dao-safeguard-guard.mjs --watch-stall --terminal <h> --stall-rounds 3 --interval N --max-rounds M
//                                                        # 卡死看门狗实跑；先破（挂起终端 3 分钟内 [STALL]）再验（慢跑终端零误报）
//   node scripts/dao-check.mjs                             # 全仓体检（本脚本不影响它）
//
// 用法与全部参数：`--help`。退出码：0 正常 · 1 运行时失败 · 2 用法错。
// ============================================================================

import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const ORCA = process.env.ORCA_BIN || 'orca';

// ── 匹配语料 ─────────────────────────────────────────────────────────────
// 逐字取自 issue #336 正文引用的提示原文：
//   "Fable 5's safeguards flagged this message... Switched to Opus 4.8"
// 不自造变体；命中 = 任一行包含任一模式（大小写敏感子串）。
export const DOWNGRADE_PATTERNS = Object.freeze([
  'safeguards flagged this message',
  'Switched to Opus 4.8',
]);

export const DEFAULTS = Object.freeze({
  intervalSec: 30,          // issue 建议的轮询间隔
  maxAttempts: 2,           // 同一终端补救上限（反者道之动：同一手段失败 2 次即换）
  readFailThreshold: 5,     // 连续 read 失败达此数 → 挂起该终端
  compactTimeoutMs: 600_000,// 等压缩完成的超时（≤ 15 分钟，工人便签等待上限内）
  modelTimeoutMs: 30_000,   // 等 /model 切模完成的超时
  model: 'Fable 5',
  continueText: '继续',
  readLimit: 200,
  orcaCallTimeoutMs: 20_000,
  waitMode: 'tui-idle',     // tui-idle | sleep（见头注「近似与未实测处」）
  heartbeatSec: 600,        // 周期心跳行的间隔
  stallRounds: 3,           // --watch-stall：连续零新行轮数阈值（issue #348 默认 3 轮）
  stallIntervalSec: 60,     // --watch-stall 下的默认轮询间隔（issue #348：3 轮×60s）
  inboxLimit: 200,          // worker_done 检查的 inbox 拉取条数
  maxRounds: 0,             // 0 = 不限；>0 时轮询 N 轮后正常退出（冒烟/验证用）
});

// ───────────────────────── 纯函数（可测） ─────────────────────────────────

/** 扫描行集合，返回命中的模式原文；0 行或空输入返回 null（区分交给 classifyRead）。 */
export function scanLines(lines, patterns = DOWNGRADE_PATTERNS) {
  if (!Array.isArray(lines) || lines.length === 0) return null;
  for (const line of lines) {
    const s = String(line ?? '');
    for (const p of patterns) {
      if (s.includes(p)) return p;
    }
  }
  return null;
}

/**
 * 判定一次 `orca terminal read` 的解析结果属于哪一态。
 * 输入是解析后的对象（JSON 解析失败在 orca() 层已归为 ok:false）。
 * 返回 { kind: 'match'|'no_match'|'no_samples'|'read_failed', ... }。
 * 'no_samples'（读到 0 行）与 'no_match'（读到 ≥1 行没命中）是两个态。
 */
export function classifyRead(raw, patterns = DOWNGRADE_PATTERNS) {
  if (!raw) return { kind: 'read_failed', reason: 'no_response' };
  if (raw.ok === false) {
    const code = raw.error?.code || raw.error?.message || 'ok_false';
    return { kind: 'read_failed', reason: String(code) };
  }
  const tail = raw.result?.terminal?.tail;
  if (!Array.isArray(tail)) {
    return { kind: 'read_failed', reason: 'malformed_result' };
  }
  if (tail.length === 0) return { kind: 'no_samples' };
  const hit = scanLines(tail, patterns);
  if (hit) return { kind: 'match', pattern: hit };
  return { kind: 'no_match' };
}

/**
 * 补救决策。wouldBeAttempt = 本次触发将形成的第几次补救（= 已补救次数 + 1）。
 * attempts 达上限或 failures 达上限 ⇒ 拒绝（同一手段失败 N 次即换，两种失败都算）。
 */
export function decideRescue(wouldBeAttempt, failures, maxAttempts = DEFAULTS.maxAttempts) {
  if (failures >= maxAttempts) return { allow: false, reason: 'failure_cap' };
  if (wouldBeAttempt > maxAttempts) return { allow: false, reason: 'attempt_cap' };
  return { allow: true, reason: 'within_limit' };
}

/** 一次补救的完整命令序列（发送与等待交错）。dry-run 打印它，守护按它执行。 */
export function buildRescueSequence(opts = {}) {
  const model = opts.model || DEFAULTS.model;
  const continueText = opts.continueText || DEFAULTS.continueText;
  const compactTimeoutMs = opts.compactTimeoutMs ?? DEFAULTS.compactTimeoutMs;
  const modelTimeoutMs = opts.modelTimeoutMs ?? DEFAULTS.modelTimeoutMs;
  return [
    { type: 'send', step: 'compact', text: '/compact', enter: true },
    { type: 'wait', step: 'wait_compact', for: 'tui-idle', timeoutMs: compactTimeoutMs },
    { type: 'send', step: 'switch_model', text: `/model ${model}`, enter: true },
    { type: 'wait', step: 'wait_model', for: 'tui-idle', timeoutMs: modelTimeoutMs },
    { type: 'send', step: 'continue', text: continueText, enter: true },
  ];
}

/**
 * 增量判定：当前 tail 里「新行」的起点下标 = prev 尾部与 curr 头部的最长重叠长度。
 * 为什么不用 orca 的 --cursor 增量读：终端保留环有上限（实测 --limit 不扩大它），
 * 环满后响应里游标字段消失，增量读退化为整环重读 ⇒ 改用尾内容差分，不依赖游标字段。
 * 0 重叠 = 轮询间隔内输出已越过保留环（中间的看不见，由调用方告警）。
 * 输入为行字符串数组；返回新行起点下标（0 = 全部都是新行）。
 */
export function newLinesStartIndex(prev, curr) {
  if (!Array.isArray(prev) || prev.length === 0) return 0;
  if (!Array.isArray(curr) || curr.length === 0) return 0;
  const max = Math.min(prev.length, curr.length);
  for (let k = max; k >= 1; k--) {
    let eq = true;
    for (let i = 0; i < k; i++) {
      if (prev[prev.length - k + i] !== curr[i]) { eq = false; break; }
    }
    if (eq) return k;
  }
  return 0;
}

/**
 * 卡死计数单步（纯）：一轮的「新行数」进，下一轮计数出。
 * newLineCount > 0 ⇒ 清零（有输出不算卡死）；== 0 ⇒ 计数 +1，达阈值 → kind 'stall'。
 * 阈值后继续零新行 ⇒ 每轮仍是 'stall'（持续告警，让协调者看到卡死仍在）。
 * 判定只用差分行数，不做任何文案匹配（2026-08-13 铁律）。
 */
export function stallNext(prevRounds, newLineCount, threshold = DEFAULTS.stallRounds) {
  if (newLineCount > 0) return { rounds: 0, kind: 'new_output' };
  const rounds = (prevRounds ?? 0) + 1;
  return { rounds, kind: rounds >= threshold ? 'stall' : 'counting' };
}

/**
 * 完工信号（结构化，纯）：从 `orca orchestration inbox` 的解析结果里查该终端是否已发
 * worker_done。判定 = 字段判等（type==='worker_done' && from_handle===handle），
 * 不做文案匹配。返回 true（已完工）/ false（未见）/ 'unknown'（检查本身失败——
 * 不许把「没查成」当成「没完工」，与 issue #337 三态区分同构）。
 */
export function hasWorkerDone(inbox, handle) {
  if (!inbox || inbox.ok !== true) return 'unknown';
  const msgs = inbox.result?.messages;
  if (!Array.isArray(msgs)) return 'unknown';
  return msgs.some((m) => m && m.type === 'worker_done' && m.from_handle === handle);
}

/**
 * 终端是否已结束（结构化，纯）：read 响应带 status 且 ≠ 'running' ⇒ 已结束（exited 等），
 * 静默合法不该算卡死。status 字段缺失（旧运行时）⇒ 视为存活（未知偏保守）。
 */
export function isTerminalEnded(raw) {
  const status = raw?.result?.terminal?.status;
  if (typeof status !== 'string' || status === '') return false;
  return status !== 'running';
}

/**
 * 状态机单步（纯）。prev = 终端状态，event = 外部事件，返回下一状态 + 动作 + 告警。
 * 状态：idle / waiting_compact / waiting_model / stopped / unknown。
 * 计数：attempts（已触发的补救次数）、failures（已失败的等待/发送次数）、
 *       consecutiveReadFails（连续 read 失败）。
 * 返回 { state, outcomeKind, severity, actions, alert, ... }；actions 至多一个 send。
 */
export function stepState(prev, event, cfg = {}) {
  const maxAttempts = cfg.maxAttempts ?? DEFAULTS.maxAttempts;
  const readFailThreshold = cfg.readFailThreshold ?? DEFAULTS.readFailThreshold;
  const seq = buildRescueSequence(cfg);
  const base = {
    handle: prev.handle,
    attempts: prev.attempts ?? 0,
    failures: prev.failures ?? 0,
    consecutiveReadFails: prev.consecutiveReadFails ?? 0,
    maxAttempts,
  };
  const sendFailed = () => {
    const failures = base.failures + 1;
    if (failures >= maxAttempts) {
      return { ...base, state: 'stopped', failures, outcomeKind: 'send_failed_stop', severity: 'alert', step: event.step, reason: event.reason, actions: [] };
    }
    // 发送失败回到监视：forceScan 让下一轮整尾重扫，可对同一触发再试一次（受 attempts 上限约束）
    return { ...base, state: 'idle', failures, forceScan: true, outcomeKind: 'send_failed_retry', severity: 'warn', step: event.step, reason: event.reason, actions: [] };
  };
  switch (prev.state) {
    case 'idle': {
      if (event.type === 'read_failed') {
        const consec = base.consecutiveReadFails + 1;
        if (consec >= readFailThreshold) {
          return { ...base, state: 'unknown', consecutiveReadFails: consec, outcomeKind: 'read_failed_exceeded', severity: 'alert', reason: event.reason, actions: [] };
        }
        return { ...base, state: 'idle', consecutiveReadFails: consec, outcomeKind: 'read_failed', severity: 'warn', reason: event.reason, actions: [] };
      }
      if (event.type === 'downgrade_seen') {
        const wouldBe = base.attempts + 1;
        const d = decideRescue(wouldBe, base.failures, maxAttempts);
        if (!d.allow) {
          return { ...base, state: 'stopped', attempts: wouldBe, outcomeKind: 'refused', severity: 'alert', reason: d.reason, actions: [] };
        }
        return { ...base, state: 'waiting_compact', attempts: wouldBe, consecutiveReadFails: 0, outcomeKind: 'rescuing', severity: 'info', actions: [seq[0]] };
      }
      if (event.type === 'send_failed') return sendFailed();
      // no_match / no_samples
      return { ...base, state: 'idle', consecutiveReadFails: 0, outcomeKind: event.type === 'no_samples' ? 'no_samples' : 'no_match', severity: 'debug', actions: [] };
    }
    case 'waiting_compact': {
      if (event.type === 'wait_ok') {
        return { ...base, state: 'waiting_model', outcomeKind: 'compact_done', severity: 'info', actions: [seq[2]] };
      }
      if (event.type === 'wait_fail') {
        const failures = base.failures + 1;
        if (failures >= maxAttempts) {
          return { ...base, state: 'stopped', failures, outcomeKind: 'compact_failed_stop', severity: 'alert', reason: event.reason, actions: [] };
        }
        // 补救失败回到监视：forceScan 让下一轮整尾重扫——同一降级仍在屏上 ⇒ 再试一次（受 attempts 上限约束）
        return { ...base, state: 'idle', failures, forceScan: true, outcomeKind: 'compact_failed_retry', severity: 'warn', reason: event.reason, actions: [] };
      }
      if (event.type === 'send_failed') return sendFailed();
      return { ...base, state: 'waiting_compact', outcomeKind: 'unknown_event', severity: 'warn', actions: [] };
    }
    case 'waiting_model': {
      if (event.type === 'wait_ok') {
        // 补救成功回到监视：reBaseline 让下一轮重新建立基线不扫描——旧降级提示已消费，
        // 若压缩后重发又被拦，新提示会是基线之后的新行，仍会被扫到（第 2 次补救）。
        return { ...base, state: 'idle', reBaseline: true, outcomeKind: 'rescue_complete', severity: 'info', actions: [seq[4]] };
      }
      if (event.type === 'wait_fail') {
        // /model 后超时：模型切换可能仍在途——仍发「继续」，但明确告警需人工核对
        return { ...base, state: 'idle', reBaseline: true, outcomeKind: 'rescue_complete_with_model_warn', severity: 'warn', reason: event.reason, actions: [seq[4]] };
      }
      if (event.type === 'send_failed') return sendFailed();
      return { ...base, state: 'waiting_model', outcomeKind: 'unknown_event', severity: 'warn', actions: [] };
    }
    case 'stopped':
      return { ...base, state: 'stopped', outcomeKind: 'stopped_idle', severity: 'debug', actions: [] };
    case 'unknown':
      return { ...base, state: 'unknown', outcomeKind: 'unknown_idle', severity: 'debug', actions: [] };
    default:
      return { ...base, state: 'idle', outcomeKind: 'unknown_event', severity: 'warn', actions: [] };
  }
}

/**
 * 把一次状态机结果格式化成可读行。注意：输出里绝不回显匹配模式原文——
 * 守卫的输出若落进被守终端的缓冲区，回显模式会造成自我命中（dao-writing-rules §二：
 * 检查器的输出不能落在自己的扫描面内）。
 */
export function formatOutcome(handle, e) {
  const p = (n) => n ?? 0;
  switch (e.outcomeKind) {
    case 'no_match': return `[ok]    ${handle}: 读到新行，无降级提示（no_match）`;
    case 'no_samples': return `[ok]    ${handle}: 本轮 0 行新输出（no_samples——与 no_match 有意区分）`;
    case 'ring_overrun': return `[warn]  ${handle}: 轮询间隔内输出已越过保留环，中间被丢弃——期间若出现降级提示将漏检（不是「没检测到」，是看不见）`;
    case 'read_failed': return `[warn]  ${handle}: read 失败（${e.reason}）——不是「无事发生」，连续失败 ${p(e.consecutiveReadFails)} 次`;
    case 'read_failed_exceeded': return `[ALERT] ${handle}: read 连续失败 ${p(e.consecutiveReadFails)} 次已达阈值 → 挂起该终端（unknown），不再轮询，需人工确认`;
    case 'rescuing': return `[info]  ${handle}: 命中降级提示 → 第 ${p(e.attempts)}/${p(e.maxAttempts)} 次补救：发送 /compact`;
    case 'refused': return `[ALERT] ${handle}: 再次命中降级提示，但补救已达上限 ${p(e.attempts)}/${p(e.maxAttempts)} → 拒绝补救，会话留在降级模型，需人工介入`;
    case 'compact_done': return `[info]  ${handle}: compact 完成（tui-idle）→ 发送 /model`;
    case 'compact_failed_retry': return `[warn]  ${handle}: 等 compact 失败（${e.reason}），第 ${p(e.failures)} 次失败 → 回到监视，保留在途触发可再试`;
    case 'compact_failed_stop': return `[ALERT] ${handle}: compact 失败已达上限 ${p(e.failures)}/${p(e.maxAttempts)} → 停手，会话留在降级模型，需人工介入`;
    case 'send_failed_retry': return `[warn]  ${handle}: 发送失败（step=${e.step}，${e.reason}）→ 回到监视可再试`;
    case 'send_failed_stop': return `[ALERT] ${handle}: 发送失败（step=${e.step}，${e.reason}）已达上限 → 停手，需人工介入`;
    case 'rescue_complete': return `[info]  ${handle}: 补救完成（compact → /model → 继续）`;
    case 'rescue_complete_with_model_warn': return `[warn]  ${handle}: /model 后 tui-idle 超时（${e.reason}）——模型切换可能仍在途，仍发「继续」，需人工核对模型`;
    case 'stopped_idle': return `[info]  ${handle}: 已停手（attempts=${p(e.attempts)}/${p(e.maxAttempts)}，failures=${p(e.failures)}/${p(e.maxAttempts)}），跳过后续轮询`;
    case 'unknown_idle': return `[info]  ${handle}: 已挂起（read 失败过多），跳过后续轮询`;
    case 'stall': return `[STALL] ${handle}: 屏面连续 ${p(e.stallCount)} 轮零新行（阈值 ${p(e.stallRounds)} 轮）且未见 worker_done → 疑似卡死；只告警不杀，处置归协调者（差分行数 + inbox 结构化信号判定）`;
    case 'stall_completed': return `[ok]    ${handle}: 检测到 worker_done（inbox 结构化信号）→ 静默合法，停止卡死告警`;
    case 'stall_terminal_ended': return `[ok]    ${handle}: 终端已结束（status=${e.reason}）→ 静默合法，停止卡死告警`;
    default: return `[?]     ${handle}: ${e.outcomeKind}`;
  }
}

// ───────────────────────── Orca I/O 层 ────────────────────────────────────

/** 统一跑一条 orca CLI 调用，返回解析后的 JSON（失败也返回 {ok:false,error}）。 */
export function orca(args, timeoutMs = DEFAULTS.orcaCallTimeoutMs) {
  let r;
  try {
    r = spawnSync(ORCA, args, { encoding: 'utf8', timeout: timeoutMs, windowsHide: true });
  } catch (err) {
    return { ok: false, error: { code: 'spawn_error', message: String(err && err.message || err) } };
  }
  if (r.error) {
    return { ok: false, error: { code: 'spawn_error', message: String(r.error.message || r.error.code) } };
  }
  if (r.status === null) {
    return { ok: false, error: { code: 'timeout', message: `> ${timeoutMs}ms` } };
  }
  if (r.status !== 0) {
    return { ok: false, error: { code: 'exit_' + r.status, message: String(r.stderr || r.stdout || '').trim().slice(0, 300) } };
  }
  try {
    return JSON.parse(String(r.stdout || ''));
  } catch {
    return { ok: false, error: { code: 'bad_json', message: String(r.stdout || '').slice(0, 200) } };
  }
}

export function terminalRead(handle, limit = DEFAULTS.readLimit) {
  const args = ['terminal', 'read', '--terminal', handle, '--limit', String(limit), '--json'];
  return orca(args);
}

export function terminalSend(handle, text, enter) {
  const args = ['terminal', 'send', '--terminal', handle, '--text', text];
  if (enter) args.push('--enter');
  args.push('--json');
  return orca(args);
}

export function terminalWaitIdle(handle, timeoutMs) {
  return orca(['terminal', 'wait', '--terminal', handle, '--for', 'tui-idle', '--timeout-ms', String(timeoutMs), '--json']);
}

export function orchestrationInbox(limit = DEFAULTS.inboxLimit) {
  // 完工信号源：inbox 是只读 show（不改投递状态）；check 会消费/ack，会抢走协调者
  // 正在等的 worker_done —— 守护绝不能用 check 当完工探测。
  return orca(['orchestration', 'inbox', '--limit', String(limit), '--json']);
}

// ───────────────────────── 日志与状态落盘 ─────────────────────────────────

let LOG_LEVEL = 'info'; // debug < info < warn

function log(level, msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  if (level === 'warn') { process.stderr.write(line + '\n'); return; }
  if (level === 'debug' && LOG_LEVEL !== 'debug') return;
  process.stdout.write(line + '\n');
}

/** 应用状态机结果：写终端状态、打日志、追加状态文件行（可选）。 */
function applyState(t, e, cfg) {
  const prevState = t.state;
  t.state = e.state;
  t.attempts = e.attempts ?? t.attempts;
  t.failures = e.failures ?? t.failures;
  t.consecutiveReadFails = e.consecutiveReadFails ?? t.consecutiveReadFails;
  if (e.reBaseline) t.reBaseline = true;
  if (e.forceScan) t.forceScan = true;
  t.events += 1;
  if (prevState !== e.state) log('info', `${t.handle}: ${prevState} → ${e.state}`);
  const line = formatOutcome(t.handle, e);
  if (e.severity === 'warn') log('warn', line);
  else if (e.severity === 'debug') log('debug', line);
  else log('info', line);
  if (cfg.stateFile && (e.severity !== 'debug' || prevState !== e.state)) emitStateLine(t, e, cfg);
}

function emitStateLine(t, e, cfg) {
  const rec = {
    at: new Date().toISOString(),
    handle: t.handle,
    state: t.state,
    outcomeKind: e.outcomeKind,
    severity: e.severity,
    attempts: t.attempts,
    failures: t.failures,
    consecutiveReadFails: t.consecutiveReadFails,
    stallCount: e.stallCount ?? undefined,
    stallRounds: e.stallRounds ?? undefined,
    reason: e.reason ?? undefined,
    step: e.step ?? undefined,
  };
  try {
    appendFileSync(cfg.stateFile, JSON.stringify(rec) + '\n', 'utf8');
  } catch (err) {
    log('warn', `${t.handle}: state 文件写入失败（${err.message}）——仅 stdout 告警仍生效`);
  }
}

// ───────────────────────── 守护循环（每终端每轮一次） ─────────────────────

function makeTerminalState(handle) {
  return {
    handle, state: 'idle', attempts: 0, failures: 0, consecutiveReadFails: 0, events: 0, announcedStop: false,
    prevTail: [], established: false, scannedOnce: false, reBaseline: false, forceScan: false,
    stallCount: 0, done: false, // --watch-stall：连续零新行计数 / 已完工或已结束标记
  };
}

async function serviceIdle(t, cfg) {
  const j = terminalRead(t.handle, cfg.readLimit);
  const outcome = classifyRead(j, cfg.patterns);
  if (outcome.kind === 'read_failed') {
    const e = stepState(t, { type: 'read_failed', reason: outcome.reason }, cfg);
    applyState(t, e, cfg);
    return;
  }
  const curr = (j.result?.terminal?.tail || []).map(String);
  // 首轮：建立基线（默认不扫描历史输出，防陈旧降级提示误触发；--scan-on-start 例外）
  if (!t.established) {
    t.established = true;
    t.prevTail = curr;
    if (!cfg.scanOnStart) {
      log('debug', `${t.handle}: 基线已建立（${curr.length} 行），本批不扫描历史输出`);
      return;
    }
  }
  // 补救成功后重设基线（旧降级提示已消费；压缩后重发若再被拦，会在基线之后作为新行出现）
  if (t.reBaseline) {
    t.reBaseline = false;
    t.prevTail = curr;
    log('debug', `${t.handle}: 补救完成，基线已重设，本批不扫描`);
    return;
  }
  const force = t.forceScan;
  t.forceScan = false;
  const first = !t.scannedOnce;
  t.scannedOnce = true;
  let newLines;
  if (force || first) {
    newLines = curr; // 首轮 --scan-on-start 或补救失败后的整尾重扫
  } else {
    const overlap = newLinesStartIndex(t.prevTail, curr);
    if (overlap === 0 && t.prevTail.length > 0) {
      log('warn', `${t.handle}: 轮询间隔内输出已越过保留环，中间输出被丢弃——期间若出现降级提示将漏检（这不是「没检测到」，是看不见）`);
    }
    newLines = curr.slice(overlap);
  }
  t.prevTail = curr;
  if (newLines.length === 0) {
    log('debug', `${t.handle}: no_samples（0 行新输出，与 no_match 有意区分）`);
    return;
  }
  const hit = scanLines(newLines, cfg.patterns);
  if (!hit) {
    log('debug', `${t.handle}: no_match（新行=${newLines.length}）`);
    return;
  }
  const e = stepState(t, { type: 'downgrade_seen', pattern: hit }, cfg);
  applyState(t, e, cfg);
  if (e.actions?.length) await runSend(t, e.actions[0], cfg);
}

/**
 * 卡死看门狗的单轮服务（接线层）。deps 只供测试注入假 runner（issue #361 端到端自动化）：
 * deps.read  = (handle, limit) => read 响应 JSON（默认真 orca CLI）；
 * deps.inbox = (limit) => inbox 响应 JSON（默认真 orca CLI）。
 * 生产调用点 isTerminalEnded 就在本函数里——短路它会破坏「已结束终端的静默合法」，
 * 由 tests/dao-safeguard-guard.tests.js 的场景 B 兜住（M4 探针）。
 */
export async function serviceStall(t, cfg, deps = {}) {
  const read = deps.read || terminalRead;
  const inbox = deps.inbox || orchestrationInbox;
  const j = read(t.handle, cfg.readLimit);
  const outcome = classifyRead(j, cfg.patterns);
  if (outcome.kind === 'read_failed') {
    const e = stepState(t, { type: 'read_failed', reason: outcome.reason }, cfg);
    applyState(t, e, cfg);
    return;
  }
  if (isTerminalEnded(j)) {
    t.done = true;
    log('info', formatOutcome(t.handle, { outcomeKind: 'stall_terminal_ended', reason: j.result?.terminal?.status || '?' }));
    return;
  }
  const curr = (j.result?.terminal?.tail || []).map(String);
  if (!t.established) {
    t.established = true;
    t.prevTail = curr;
    log('debug', `${t.handle}: 基线已建立（${curr.length} 行），本轮不计数`);
    return;
  }
  const overlap = newLinesStartIndex(t.prevTail, curr);
  if (overlap === 0 && t.prevTail.length > 0) {
    // 输出越过保留环/整屏替换：有输出但看不见 ⇒ 不算卡死（与救援模式同一差分引擎同一语义）
    t.prevTail = curr;
    t.stallCount = 0;
    log('warn', `${t.handle}: 轮询间隔内屏面整体替换/越过保留环——有输出但看不见，不算卡死，stall 计数清零`);
    return;
  }
  const newLines = curr.length - overlap;
  t.prevTail = curr;
  if (newLines > 0) {
    t.stallCount = 0;
    log('debug', `${t.handle}: 新输出 ${newLines} 行，stall 计数清零`);
    return;
  }
  // 零新行：先问「是不是已完工」（结构化信号；只在此刻查 inbox，省 busy 轮的 orca 调用）
  const done = hasWorkerDone(inbox(cfg.inboxLimit), t.handle);
  if (done === 'unknown') {
    log('warn', `${t.handle}: 完工检查失败（inbox 不可读）——无法区分「合法静默」与「卡死」，本轮不计数不告警`);
    return;
  }
  if (done) {
    t.done = true;
    log('info', formatOutcome(t.handle, { outcomeKind: 'stall_completed' }));
    return;
  }
  const s = stallNext(t.stallCount, 0, cfg.stallRounds);
  t.stallCount = s.rounds;
  if (s.kind === 'counting') {
    log('debug', `${t.handle}: 零新行 ${s.rounds}/${cfg.stallRounds} 轮（未达阈值）`);
    return;
  }
  applyState(t, { state: 'idle', outcomeKind: 'stall', severity: 'alert', stallCount: s.rounds, stallRounds: cfg.stallRounds }, cfg);
}

async function serviceWaitCompact(t, cfg) {
  if (cfg.waitMode === 'sleep') {
    await sleep(cfg.compactTimeoutMs);
    const e = stepState(t, { type: 'wait_ok' }, cfg);
    applyState(t, e, cfg);
    if (e.actions?.length) await runSend(t, e.actions[0], cfg);
    return;
  }
  const j = terminalWaitIdle(t.handle, cfg.compactTimeoutMs);
  const ok = j && j.ok === true;
  const e = stepState(t, ok ? { type: 'wait_ok' } : { type: 'wait_fail', reason: j?.error?.code || 'wait_error' }, cfg);
  applyState(t, e, cfg);
  if (e.actions?.length) await runSend(t, e.actions[0], cfg);
}

async function serviceWaitModel(t, cfg) {
  if (cfg.waitMode === 'sleep') {
    await sleep(cfg.modelTimeoutMs);
    const e = stepState(t, { type: 'wait_ok' }, cfg);
    applyState(t, e, cfg);
    if (e.actions?.length) await runSend(t, e.actions[0], cfg);
    return;
  }
  const j = terminalWaitIdle(t.handle, cfg.modelTimeoutMs);
  const ok = j && j.ok === true;
  const e = stepState(t, ok ? { type: 'wait_ok' } : { type: 'wait_fail', reason: j?.error?.code || 'wait_error' }, cfg);
  applyState(t, e, cfg);
  if (e.actions?.length) await runSend(t, e.actions[0], cfg);
}

async function runSend(t, action, cfg) {
  const j = terminalSend(t.handle, action.text, action.enter);
  if (j && j.ok === true) {
    log('info', `${t.handle}: 已发送 ${JSON.stringify(action.text)}${action.enter ? ' + Enter' : ''}`);
    return;
  }
  const e = stepState(t, { type: 'send_failed', step: action.step, reason: j?.error?.code || 'send_error' }, cfg);
  applyState(t, e, cfg);
}

export async function serviceOnce(t, cfg, deps = {}) {
  if (t.done) return; // --watch-stall：已完工/已结束的终端不再轮询
  switch (t.state) {
    case 'idle': return cfg.watchStall ? serviceStall(t, cfg, deps) : serviceIdle(t, cfg);
    case 'waiting_compact': return serviceWaitCompact(t, cfg);
    case 'waiting_model': return serviceWaitModel(t, cfg);
    case 'stopped':
      if (!t.announcedStop) {
        t.announcedStop = true;
        log('info', formatOutcome(t.handle, { outcomeKind: 'stopped_idle', attempts: t.attempts, failures: t.failures, maxAttempts: cfg.maxAttempts }));
      }
      return;
    case 'unknown':
      if (!t.announcedStop) {
        t.announcedStop = true;
        log('info', formatOutcome(t.handle, { outcomeKind: 'unknown_idle' }));
      }
      return;
    default:
      log('warn', `${t.handle}: 未知状态 ${t.state}`);
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function runDaemon(cfg, terminals) {
  banner(cfg, terminals);
  let poll = 0;
  const t0 = Date.now();
  const heartbeatPolls = Math.max(1, Math.round(cfg.heartbeatSec / cfg.intervalSec));
  try {
    for (;;) {
      poll += 1;
      for (const t of terminals) await serviceOnce(t, cfg);
      if (cfg.maxRounds > 0 && poll >= cfg.maxRounds) {
        log('info', `达 --max-rounds ${cfg.maxRounds} 轮，正常退出（exit 0）`);
        return 0;
      }
      if (poll % heartbeatPolls === 0) {
        const summary = cfg.watchStall
          ? terminals.map((t) => `${t.handle}=${t.state}(stall ${t.stallCount}/${cfg.stallRounds}${t.done ? ' done' : ''})`).join(' ')
          : terminals.map((t) => `${t.handle}=${t.state}(a${t.attempts}/f${t.failures})`).join(' ');
        log('info', `心跳 poll#${poll}，运行 ${Math.round((Date.now() - t0) / 1000)}s：${summary}`);
      }
      await sleep(cfg.intervalSec * 1000);
    }
  } catch (err) {
    log('warn', `守护循环异常退出：${err && err.stack ? err.stack : String(err)} —— exit 1`);
    return 1;
  }
}

function banner(cfg, terminals) {
  process.stdout.write('── dao-safeguard-guard 启动 ─────────────────────────\n');
  process.stdout.write(`受管终端（白名单，仅此列表会被读/写）: ${terminals.map((t) => t.handle).join(', ')}\n`);
  if (cfg.watchStall) {
    process.stdout.write(`卡死看门狗（issue #348）：连续 ${cfg.stallRounds} 轮（间隔 ${cfg.intervalSec}s）零新行且无 worker_done ⇒ stdout [STALL] 告警；只告警不杀，处置归协调者\n`);
    process.stdout.write(`判定只用差分行数 + inbox 结构化信号（type===worker_done 字段判等），不做文案匹配（2026-08-13 铁律）\n`);
  } else {
    process.stdout.write(`轮询间隔 ${cfg.intervalSec}s · 补救上限 ${cfg.maxAttempts} 次 · wait 模式 ${cfg.waitMode} · 匹配语料 ${DOWNGRADE_PATTERNS.length} 条（逐字取自 issue #336）\n`);
  }
  process.stdout.write(`注意：不要把本守护自己的工作终端列入 --terminal；输出回显不命中语料，但保持扫描面干净（dao-writing-rules §二）。\n`);
  process.stdout.write('────────────────────────────────────────────────────\n');
}

// ───────────────────────── 模式：--selftest / --dry-run ───────────────────

export function runSelfTest() {
  const results = [];
  const check = (name, cond, detail = '') => results.push({ name, ok: !!cond, detail });

  const CORPUS = "Fable 5's safeguards flagged this message... Switched to Opus 4.8";

  // —— scanLines ——
  check('scanLines 命中完整语料句', scanLines([CORPUS]) === 'safeguards flagged this message');
  check('scanLines 命中第二模式', scanLines(['nothing here', 'Switched to Opus 4.8']) === 'Switched to Opus 4.8');
  check('scanLines 普通终端行不命中', scanLines(['PS C:\\>', 'node scripts/dao-check.mjs', 'Compacting...']) === null);
  check('scanLines 近形不命中（缺 this message）', scanLines(['safeguards flagged my other message']) === null);
  check('scanLines 大小写敏感', scanLines(['switched to opus 4.8']) === null);
  check('scanLines 空集合不命中', scanLines([]) === null && scanLines(null) === null);

  // —— classifyRead ——
  const okRead = (tail) => ({ ok: true, result: { terminal: { tail } } });
  check('classifyRead: 命中', classifyRead(okRead([CORPUS, 'PS C:\\>'])).kind === 'match');
  check('classifyRead: 无命中', classifyRead(okRead(['PS C:\\>', 'hello'])).kind === 'no_match');
  check('classifyRead: 0 行新输出 = no_samples（≠ no_match）', classifyRead(okRead([])).kind === 'no_samples');
  check('classifyRead: ok:false → read_failed', classifyRead({ ok: false, error: { code: 'no_active_terminal' } }).kind === 'read_failed');
  check('classifyRead: 畸形结果 → read_failed', classifyRead({ ok: true }).kind === 'read_failed');
  check('classifyRead: 空响应 → read_failed', classifyRead(null).kind === 'read_failed');

  // —— 三态输出必须互不相同（issue #337 教训的机器化）——
  const lineNoMatch = formatOutcome('term_x', { outcomeKind: 'no_match' });
  const lineNoSamples = formatOutcome('term_x', { outcomeKind: 'no_samples' });
  const lineReadFailed = formatOutcome('term_x', { outcomeKind: 'read_failed', reason: 'no_active_terminal', consecutiveReadFails: 1 });
  check('三态措辞两两不同', lineNoMatch !== lineNoSamples && lineNoSamples !== lineReadFailed && lineNoMatch !== lineReadFailed);
  check('read_failed 措辞含告警标记且非「无事发生」', lineReadFailed.includes('失败') && lineReadFailed.includes('不是「无事发生」'));

  // —— decideRescue ——
  check('decideRescue: 第 1 次允许', decideRescue(1, 0, 2).allow === true);
  check('decideRescue: 第 2 次允许', decideRescue(2, 0, 2).allow === true);
  check('decideRescue: 第 3 次拒绝（attempt_cap）', decideRescue(3, 0, 2).allow === false);
  check('decideRescue: 失败达上限拒绝（failure_cap）', decideRescue(1, 2, 2).allow === false);
  check('decideRescue: 上限 3 时第 3 次允许', decideRescue(3, 0, 3).allow === true);

  // —— 状态机：read 失败 ≠ 无事发生（本批负控）——
  const st = (over = {}) => ({ handle: 'term_t', state: 'idle', attempts: 0, failures: 0, consecutiveReadFails: 0, ...over });
  let e = stepState(st(), { type: 'read_failed', reason: 'no_active_terminal' }, {});
  check('负控: read 失败走告警分支而非 no_match', e.outcomeKind === 'read_failed' && e.severity === 'warn' && e.state === 'idle');
  check('负控: read 失败计数递增', e.consecutiveReadFails === 1);
  e = stepState(st({ consecutiveReadFails: 4 }), { type: 'read_failed', reason: 'no_active_terminal' }, { readFailThreshold: 5 });
  check('负控: 连续失败达阈值 → unknown 挂起', e.state === 'unknown' && e.outcomeKind === 'read_failed_exceeded' && e.severity === 'alert');

  // —— 状态机：降级触发与上限 ——
  e = stepState(st(), { type: 'downgrade_seen' }, {});
  check('触发 → waiting_compact + 第 1 次补救 + 发送 /compact', e.state === 'waiting_compact' && e.attempts === 1 && e.actions.length === 1 && e.actions[0].text === '/compact');
  e = stepState(st({ attempts: 2 }), { type: 'downgrade_seen' }, { maxAttempts: 2 });
  check('同一终端第 3 次触发 → 拒绝补救（refused，无动作）', e.state === 'stopped' && e.outcomeKind === 'refused' && e.actions.length === 0 && e.severity === 'alert');
  e = stepState(st(), { type: 'no_match' }, {});
  check('no_match 保持 idle 且清零连续失败', e.state === 'idle' && e.consecutiveReadFails === 0 && e.outcomeKind === 'no_match');

  // —— 状态机：等待与失败路径 ——
  e = stepState(st({ state: 'waiting_compact', attempts: 1 }), { type: 'wait_ok' }, {});
  check('compact 完成 → waiting_model + 发送 /model', e.state === 'waiting_model' && e.actions[0].text.startsWith('/model '));
  e = stepState(st({ state: 'waiting_compact', attempts: 1 }), { type: 'wait_fail', reason: 'timeout' }, {});
  check('compact 等待失败 → 回 idle + forceScan（可对同一触发再试）', e.state === 'idle' && e.failures === 1 && e.forceScan === true && e.severity === 'warn');
  e = stepState(st({ state: 'waiting_compact', attempts: 1, failures: 1 }), { type: 'wait_fail', reason: 'timeout' }, { maxAttempts: 2 });
  check('compact 失败达上限 → 停手', e.state === 'stopped' && e.outcomeKind === 'compact_failed_stop' && e.severity === 'alert');
  e = stepState(st({ state: 'waiting_model', attempts: 1 }), { type: 'wait_ok' }, {});
  check('model 完成 → idle + reBaseline + 发送 继续', e.state === 'idle' && e.reBaseline === true && e.outcomeKind === 'rescue_complete' && e.actions[0].text === '继续');
  e = stepState(st({ state: 'waiting_model', attempts: 1 }), { type: 'wait_fail', reason: 'timeout' }, {});
  check('model 等待超时 → 仍发 继续 但告警（带 reBaseline）', e.state === 'idle' && e.reBaseline === true && e.outcomeKind === 'rescue_complete_with_model_warn' && e.severity === 'warn' && e.actions.length === 1);
  e = stepState(st({ state: 'waiting_compact', attempts: 1 }), { type: 'send_failed', step: 'compact', reason: 'exit_1' }, {});
  check('发送失败 → 失败计数 + 回 idle + forceScan', e.state === 'idle' && e.failures === 1 && e.forceScan === true);

  // —— 序列与断层 ——
  const seq = buildRescueSequence({ model: 'Fable 5', continueText: '继续' });
  check('补救序列 = 5 步（compact→wait→model→wait→continue）', seq.length === 5 && seq[0].text === '/compact' && seq[2].text === '/model Fable 5' && seq[4].text === '继续' && seq[1].type === 'wait' && seq[3].type === 'wait');
  check('差分: 追加 1 行 → 新行起点 = 3', newLinesStartIndex(['A', 'B', 'C'], ['A', 'B', 'C', 'D']) === 3);
  check('差分: 头部滚掉 1 行 → 重叠 2', newLinesStartIndex(['A', 'B', 'C'], ['B', 'C', 'D']) === 2);
  check('差分: 完全无重叠 → 0（全部当新行 + 调用方告警）', newLinesStartIndex(['A', 'B', 'C'], ['X', 'Y']) === 0);
  check('差分: 首轮（prev 空）→ 0', newLinesStartIndex([], ['A', 'B']) === 0);
  check('差分: 完全没变 → 重叠 = 全长（无新行）', newLinesStartIndex(['A', 'B'], ['A', 'B']) === 2);
  check('差分: 重复行不误判（PS 提示符连续）', newLinesStartIndex(['P', 'P', 'B'], ['P', 'P', 'B', 'P']) === 3);

  // —— --watch-stall 卡死判定（issue #348）：只认差分行数与结构化信号 ——
  check('stallNext: 有新输出 → 清零', stallNext(2, 1, 3).kind === 'new_output' && stallNext(2, 1, 3).rounds === 0);
  check('stallNext: 零新行递增未达阈值 → counting', stallNext(0, 0, 3).kind === 'counting' && stallNext(0, 0, 3).rounds === 1);
  check('stallNext: 达阈值 → stall', stallNext(2, 0, 3).kind === 'stall' && stallNext(2, 0, 3).rounds === 3);
  check('stallNext: 阈值后继续零新行 → 仍 stall（持续告警）', stallNext(3, 0, 3).kind === 'stall' && stallNext(3, 0, 3).rounds === 4);
  // 负控：有输出的慢终端（输出穿插，最长静默 2 轮 < 阈值 3）→ 永不 [STALL]
  {
    const seq = [2, 0, 0, 1, 0, 0, 1, 0, 0, 1];
    let r = 0; const kinds = [];
    for (const n of seq) { const s = stallNext(r, n, 3); r = s.rounds; kinds.push(s.kind); }
    check('负控: 慢跑终端（输出穿插）连续 10 轮零 [STALL]', kinds.every((k) => k !== 'stall'));
  }
  // 正控：静默 3 轮 → 第 3 轮 stall；被输出打断后重新计时
  {
    const seq = [1, 0, 0, 0];
    let r = 0; const kinds = [];
    for (const n of seq) { const s = stallNext(r, n, 3); r = s.rounds; kinds.push(s.kind); }
    check('正控: 静默 3 轮 → 第 3 轮 [STALL]（输出打断后重新计时）', kinds[3] === 'stall' && kinds[1] === 'counting' && kinds[2] === 'counting');
  }
  check('stall 告警行含 [STALL] 标记', formatOutcome('term_x', { outcomeKind: 'stall', stallCount: 3, stallRounds: 3 }).includes('[STALL]'));

  // —— worker_done 结构化检出（消息形态取自本 run 真样本 msg_b743d080b68c）——
  const realInboxShape = { ok: true, result: { messages: [
    { type: 'heartbeat', from_handle: 'term_x' },
    { type: 'dispatch', from_handle: 'term_coord' },
    { type: 'worker_done', from_handle: 'term_worker1', payload: '{}' },
  ] } };
  check('worker_done: 命中本终端', hasWorkerDone(realInboxShape, 'term_worker1') === true);
  check('worker_done: 别的终端完工不算本终端', hasWorkerDone(realInboxShape, 'term_worker2') === false);
  check('worker_done: heartbeat 不是完工', hasWorkerDone(realInboxShape, 'term_x') === false);
  check('worker_done: 无消息 → false', hasWorkerDone({ ok: true, result: { messages: [] } }, 'x') === false);
  check('worker_done: ok:false → unknown（不许当 false）', hasWorkerDone({ ok: false, error: {} }, 'x') === 'unknown');
  check('worker_done: 缺 messages → unknown', hasWorkerDone({ ok: true }, 'x') === 'unknown');
  check('worker_done: 空响应 → unknown', hasWorkerDone(null, 'x') === 'unknown');

  // —— 终端已结束 ≠ 卡死 ——
  check('terminal_ended: running 未结束', isTerminalEnded({ ok: true, result: { terminal: { status: 'running' } } }) === false);
  check('terminal_ended: exited 已结束', isTerminalEnded({ ok: true, result: { terminal: { status: 'exited' } } }) === true);
  check('terminal_ended: 无 status 字段（旧运行时）→ 未结束', isTerminalEnded({ ok: true, result: { terminal: {} } }) === false);
  check('terminal_ended: 空响应 → 未结束', isTerminalEnded(null) === false);

  const failed = results.filter((r) => !r.ok);
  const lines = results.map((r) => `${r.ok ? '  ok  ' : '  X   '}${r.name}${r.ok ? '' : ' —— ' + r.detail}`).join('\n');
  return { passed: results.length - failed.length, failed: failed.length, lines };
}

export function runDryRun(a) {
  const handle = (a.terminals && a.terminals[0]) || '(demo)';
  const maxAttempts = a.maxAttempts;
  const wouldBe = a.attempts + 1;
  const hit = scanLines([a.sampleText]);
  const seq = buildRescueSequence(a);
  const out = [];
  out.push('── dao-safeguard-guard --dry-run ──');
  out.push(`样本文字: ${JSON.stringify(a.sampleText)}`);
  out.push(`匹配语料: ${JSON.stringify(DOWNGRADE_PATTERNS)}（逐字取自 issue #336）`);
  if (!hit) {
    out.push('结果: 未命中（no_match）—— 不采取任何动作，继续轮询');
    process.stdout.write(out.join('\n') + '\n');
    return 0;
  }
  out.push(`结果: 命中模式 ${JSON.stringify(hit)}`);
  const d = decideRescue(wouldBe, 0, maxAttempts);
  if (!d.allow) {
    out.push(`补救决策: 拒绝（${d.reason}）—— 已补救 ${a.attempts} 次，本次为第 ${wouldBe} 次触发 > 上限 ${maxAttempts}`);
    out.push('将通知用户（stdout [ALERT] 行 + --state-file 若配置）；不发送任何命令，终端保持原状');
    process.stdout.write(out.join('\n') + '\n');
    return 0;
  }
  out.push(`补救决策: 允许（本次为第 ${wouldBe}/${maxAttempts} 次补救）—— 将依次执行:`);
  for (const step of seq) {
    if (step.type === 'send') {
      out.push(`  orca terminal send --terminal ${handle} --text ${JSON.stringify(step.text)}${step.enter ? ' --enter' : ''}`);
    } else {
      out.push(`  orca terminal wait --terminal ${handle} --for ${step.for} --timeout-ms ${step.timeoutMs}   # 等待「${step.step}」完成（tui-idle）`);
    }
  }
  out.push('(dry-run：以上为「将发送的命令序列」，实际未触碰任何终端)');
  process.stdout.write(out.join('\n') + '\n');
  return 0;
}

// ───────────────────────── CLI 入口 ───────────────────────────────────────

function printUsage(stream = process.stdout) {
  stream.write(`dao-safeguard-guard.mjs —— Orca 层守护：救回降级会话（issue #336）+ 卡死看门狗（issue #348）

用法:
  node scripts/dao-safeguard-guard.mjs --terminal <handle> [--terminal <h2> ...] [选项]   # 长驻轮询（救回降级会话）
  node scripts/dao-safeguard-guard.mjs --watch-stall --terminal <handle> [选项]           # 卡死看门狗（只告警不杀）
  node scripts/dao-safeguard-guard.mjs --selftest                                            # 纯函数自测
  node scripts/dao-safeguard-guard.mjs --dry-run --sample-text "<文字>" [--attempts N]      # 干跑演示

参数:
  --terminal <handle>     授权终端 handle（可重复；守护只碰这个白名单，不自动发现）
  --interval <秒>         轮询间隔，默认 30
  --max-attempts <N>      同一终端补救上限，默认 2；超限停手并告警
  --read-fail-threshold <N> 连续 read 失败达 N 次即挂起该终端，默认 5
  --compact-timeout-ms <N>  等压缩完成的超时（tui-idle 模式）或固定等待（sleep 模式），默认 600000
  --model-timeout-ms <N>  等 /model 切模完成的超时，默认 30000
  --model <名称>          /model 的目标模型，默认 "Fable 5"
  --continue-text <文字>  补救完成后的「继续」文本，默认 "继续"
  --wait-mode <模式>      tui-idle（默认，读屏判忙态）| sleep（固定时长等待，近似回退）
  --state-file <路径>     状态/告警 JSON-lines 落盘（可选；仅 stdout 告警也始终有效）
  --log-level <debug|info|warn> 默认 info
  --once                  只跑一轮（调试/冒烟用）
  --scan-on-start         首轮也扫描历史输出（默认首轮只建立基线，防陈旧提示误触发）
  --watch-stall           卡死看门狗模式（issue #348）：同一终端屏面差分连续 N 轮（默认 3）零新行
                          且 orca orchestration inbox 中未见该终端的 worker_done ⇒ stdout [STALL] 告警。
                          本模式下轮询间隔默认 60s（可用 --interval 改）；只告警不杀，处置归协调者。
                          判定只用差分行数 + 结构化字段判等，不做文案匹配（中文 Windows GBK 乱码铁律）。
  --stall-rounds <N>      --watch-stall 的连续零新行阈值轮数，默认 3
  --max-rounds <N>        轮询 N 轮后正常退出（冒烟/验证用；默认不限）
  --sample-text <文字>    仅 --dry-run：要判定的样本文字
  --attempts <N>          仅 --dry-run：模拟「已补救 N 次」后的触发（演示第 N+1 次决策）
  --help                  本帮助

环境变量: ORCA_BIN（orca 可执行文件，默认 "orca"）· DAO_GUARD_TERMINALS（逗号分隔，附加到 --terminal）

退出码: 0 正常 · 1 运行时失败/自测红 · 2 用法错
`);
}

function parseArgs(argv) {
  const a = {
    terminals: [], logLevel: 'info', intervalSec: DEFAULTS.intervalSec, maxAttempts: DEFAULTS.maxAttempts,
    readFailThreshold: DEFAULTS.readFailThreshold, compactTimeoutMs: DEFAULTS.compactTimeoutMs,
    modelTimeoutMs: DEFAULTS.modelTimeoutMs, model: DEFAULTS.model, continueText: DEFAULTS.continueText,
    waitMode: DEFAULTS.waitMode, stateFile: null, sampleText: '', attempts: 0,
    help: false, selftest: false, dryRun: false, once: false, scanOnStart: false, badArgs: null,
    watchStall: false, stallRounds: DEFAULTS.stallRounds, maxRounds: 0, intervalSet: false,
  };
  const num = (key, v, min) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < min) { a.badArgs = `✗ ${key} 需要 ≥ ${min} 的数字，得到 ${JSON.stringify(v)}`; return null; }
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    let key = argv[i];
    let val = null;
    const eq = key.indexOf('=');
    if (eq > 0) { val = key.slice(eq + 1); key = key.slice(0, eq); }
    else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) { val = argv[++i]; }
    switch (key) {
      case '--terminal': if (val) a.terminals.push(val); break;
      case '--interval': { const n = num(key, val, 1); if (n) { a.intervalSec = n; a.intervalSet = true; } break; }
      case '--max-attempts': { const n = num(key, val, 1); if (n) a.maxAttempts = n; break; }
      case '--read-fail-threshold': { const n = num(key, val, 1); if (n) a.readFailThreshold = n; break; }
      case '--compact-timeout-ms': { const n = num(key, val, 1); if (n) a.compactTimeoutMs = n; break; }
      case '--model-timeout-ms': { const n = num(key, val, 1); if (n) a.modelTimeoutMs = n; break; }
      case '--model': if (val) a.model = val; break;
      case '--continue-text': if (val) a.continueText = val; break;
      case '--wait-mode':
        if (val === 'tui-idle' || val === 'sleep') a.waitMode = val;
        else a.badArgs = `✗ --wait-mode 只能取 tui-idle 或 sleep，得到 ${JSON.stringify(val)}`;
        break;
      case '--state-file': if (val) a.stateFile = val; break;
      case '--log-level': if (val) a.logLevel = val; break;
      case '--sample-text': if (val !== null) a.sampleText = val; break;
      case '--attempts': { const n = num(key, val, 0); if (n !== null) a.attempts = n; break; }
      case '--once': a.once = true; break;
      case '--scan-on-start': a.scanOnStart = true; break;
      case '--watch-stall': a.watchStall = true; break;
      case '--stall-rounds': { const n = num(key, val, 1); if (n) a.stallRounds = n; break; }
      case '--max-rounds': { const n = num(key, val, 1); if (n) a.maxRounds = n; break; }
      case '--selftest': a.selftest = true; break;
      case '--dry-run': a.dryRun = true; break;
      case '--help': case '-h': a.help = true; break;
      default: a.badArgs = `✗ 未知参数 ${key}`;
    }
    if (a.badArgs) break;
  }
  return a;
}

function buildConfig(a) {
  return {
    intervalSec: a.watchStall && !a.intervalSet ? DEFAULTS.stallIntervalSec : a.intervalSec,
    maxAttempts: a.maxAttempts,
    readFailThreshold: a.readFailThreshold,
    compactTimeoutMs: a.compactTimeoutMs,
    modelTimeoutMs: a.modelTimeoutMs,
    model: a.model,
    continueText: a.continueText,
    waitMode: a.waitMode,
    stateFile: a.stateFile,
    readLimit: DEFAULTS.readLimit,
    patterns: DOWNGRADE_PATTERNS,
    scanOnStart: a.scanOnStart,
    heartbeatSec: DEFAULTS.heartbeatSec,
    watchStall: a.watchStall,
    stallRounds: a.stallRounds,
    maxRounds: a.maxRounds,
    inboxLimit: DEFAULTS.inboxLimit,
  };
}

function collectTerminals(a) {
  const set = new Set(a.terminals);
  const env = process.env.DAO_GUARD_TERMINALS || '';
  for (const h of env.split(',').map((s) => s.trim()).filter(Boolean)) set.add(h);
  return [...set].map((h) => makeTerminalState(h));
}

async function main(argv) {
  const a = parseArgs(argv);
  if (a.badArgs) {
    process.stderr.write(a.badArgs + '\n');
    printUsage(process.stderr);
    return 2;
  }
  if (a.help) { printUsage(); return 0; }
  if (a.selftest) {
    const r = runSelfTest();
    process.stdout.write(r.lines + '\n');
    process.stdout.write(`guard selftest: ${r.passed} passed / ${r.failed} failed\n`);
    return r.failed ? 1 : 0;
  }
  if (a.dryRun) {
    if (!a.sampleText) {
      process.stderr.write('✗ --dry-run 需要 --sample-text "<文字>"\n');
      printUsage(process.stderr);
      return 2;
    }
    return runDryRun(a);
  }
  const terminals = collectTerminals(a);
  if (terminals.length === 0) {
    process.stderr.write('✗ 没有授权终端：用 --terminal <handle>（可重复）或 DAO_GUARD_TERMINALS 指定。守护不会自行发现终端（只挂在授权终端上，不动其他窗）。\n');
    printUsage(process.stderr);
    return 2;
  }
  LOG_LEVEL = a.logLevel;
  const cfg = buildConfig(a);
  if (a.once) {
    banner(cfg, terminals);
    for (const t of terminals) await serviceOnce(t, cfg);
    process.stdout.write('── once 模式完成，退出 ──\n');
    return 0;
  }
  return runDaemon(cfg, terminals);
}

// 直接运行检测（允许被 import 以复用纯函数）
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  let shuttingDown = false;
  process.on('SIGINT', () => { if (shuttingDown) process.exit(130); shuttingDown = true; log('warn', 'SIGINT：守护退出（退出码 0）'); process.exit(0); });
  process.on('SIGTERM', () => { if (shuttingDown) process.exit(143); shuttingDown = true; log('warn', 'SIGTERM：守护退出（退出码 0）'); process.exit(0); });
  process.on('uncaughtException', (err) => { log('warn', `未捕获异常：${err && err.stack ? err.stack : String(err)} —— exit 1`); process.exit(1); });
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
