// scripts/lib/dispatch/inject.mjs —— 注入/验证域（#762 拆分）
//
// 改这段前必须知道：往输入框粘贴 ≠ 开工（#661/#633/#679）。
// 未提交粘贴（Pasted Content / [Pasted text] / 未发 follow-up）只证明任务书停在输入框，
// 不证明 agent 真接过它。禁止补回车、禁止把粘贴当开工。
// 开工只认外部证据：worker-read 官方 transcript（source≠terminal）/ GitHub review /
// proof 不可用（provider_unsupported / session_not_reported）时降级到屏面连续稳定轮。

import fs from 'node:fs';
import path from 'node:path';
import { isModelRejectText } from '../next-launch.mjs';
import { orcaErrorText } from '../orca-error.mjs';
import { DEFAULT_PROBE_WAIT_MS } from './constants.mjs';

// #762 拆分：能力探针域移到 scripts/lib/dispatch/probe.mjs（保持对外 API 不变）
export {
  CODEX_CAPABLE_FLAG, PROBE_LABELS, PROBE_MARK_RE, probeMarkFound,
  assertCodexLaunch, assertReviewerLaunch, WRITE_PROBE_FILE, writeProbeScript,
  probeCommand, terminalProbeExec, runCapabilityProbes, hostProbeExec,
} from './probe.mjs';

// 漏 -a never 时 codex 会停在确认条。验开工认这些屏面，不靠「看起来在干活」。
export const CONFIRM_PATTERNS = [
  /allow this command/i,
  /allow command\??/i,
  /approval required/i,
  /ask for approval/i,
  /waiting for approval/i,
  /do you want to (allow|approve|run)/i,
  /run this command\??/i,
  /always allow/i,
  /\[y\/n\]/i,
  /待确认/,
  /批准这次/,
  /允许执行/,
];

export function sleepSync(ms) {
  const buf = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buf, 0, 0, Math.max(1, ms));
}

export function extractTerminalText(readJson) {
  if (readJson == null) return '';
  if (typeof readJson === 'string') return readJson;
  const result = readJson.result ?? readJson;
  if (typeof result === 'string') return result;
  const chunks = [];
  const pushLines = (arr) => {
    if (!Array.isArray(arr)) return;
    for (const line of arr) {
      if (typeof line === 'string') chunks.push(line);
      else if (line && typeof line.text === 'string') chunks.push(line.text);
    }
  };
  // 2026-08-15 真返回：文本在 result.terminal.tail（字符串数组），不在 result.text/output/lines。
  if (result.terminal && typeof result.terminal === 'object') {
    pushLines(result.terminal.tail);
    if (typeof result.terminal.preview === 'string') chunks.push(result.terminal.preview);
  }
  pushLines(result.tail);
  if (typeof result.text === 'string') chunks.push(result.text);
  if (typeof result.output === 'string') chunks.push(result.output);
  if (typeof result.preview === 'string') chunks.push(result.preview);
  pushLines(result.lines);
  pushLines(Array.isArray(result.output) ? result.output : null);
  if (chunks.length) return chunks.join('\n');
  if (typeof readJson.preview === 'string') return readJson.preview;
  return '';
}

/** 分得开「没读成」和「读了是空的」。unread 不能当成 empty。 */
export function classifyRead(readJson) {
  if (readJson == null) return { kind: 'unread', reason: '没读成', error: 'read 结果为空' };
  if (typeof readJson === 'string') {
    return String(readJson).trim()
      ? { kind: 'text', text: readJson }
      : { kind: 'empty', reason: '读了是空的', text: '' };
  }
  if (readJson.error) {
    return { kind: 'unread', reason: '没读成', error: readJson.error };
  }
  const text = extractTerminalText(readJson);
  if (!String(text).trim()) return { kind: 'empty', reason: '读了是空的', text: '' };
  return { kind: 'text', text };
}

export function verifyStarted(readJson) {
  const cls = classifyRead(readJson);
  if (cls.kind === 'unread') {
    return { ok: false, reason: '没读成', error: cls.error, unscanned: true, text: '' };
  }
  if (cls.kind === 'empty') {
    return { ok: false, reason: '读了是空的', unscanned: false, text: '' };
  }
  const text = cls.text;
  for (const re of CONFIRM_PATTERNS) {
    const m = String(text).match(re);
    if (m) return { ok: false, reason: '有待确认提示', evidence: m[0], text, unscanned: false };
  }
  if (isModelRejectText(text)) {
    return { ok: false, reason: '拒模', text, unscanned: false };
  }
  return { ok: true, text, unscanned: false };
}

export function waitAndVerify({ readOnce, timeoutMs = DEFAULT_PROBE_WAIT_MS, intervalMs = 400, sleep = sleepSync } = {}) {
  if (typeof readOnce !== 'function') throw new Error('waitAndVerify 要 readOnce');
  const t0 = Date.now();
  let last = { ok: false, reason: '读了是空的', text: '', unscanned: false };
  while (Date.now() - t0 < timeoutMs) {
    last = verifyStarted(readOnce());
    if (last.ok) return last;
    if (last.reason === '有待确认提示' || last.reason === '没读成' || last.reason === '拒模') return last;
    sleep(intervalMs);
  }
  return last;
}

/** 注入没生效的现场指纹（#543 / #524）：任务书折在输入框里从未提交。Grok 形态。 */
export const PASTED_CONTENT_RE = /\[Pasted Content \d+ chars?\]/i;

/** #651：Cursor 粘贴块折叠形态（#634 实证屏面）：[Pasted text #N +M lines]。 */
export const CURSOR_PASTE_RE = /\[Pasted text(?: #\d+)? \+?\d+ lines?\]/i;

/** #651：Cursor 已提交后在干活的屏面形态——只认状态行（行首 Running:/Reading/Thinking 等），
 * 禁止无锚单词扫任务书正文（审红 2：正文含 Reading/Working 不得当已提交）。 */
export const CURSOR_WORKING_RE = /(?:^|\n)\s*(?:Running|Reading|Thinking|Working|处理中)[:：\s.…]/i;

/** #651：Cursor 未发出的 follow-up（第二条指纹）：→ 行带字 / N follow-ups。
 * 不是粘贴块的前置条件（审红 1），单独出现也算未提交。 */
export const CURSOR_FOLLOWUP_RE = /(?:^|\n)\s*→[^\n]*[^\s\n]|\d+\s*follow-ups?/i;

/** #619/#661/#679：未提交粘贴与「超时/环境」必须分开。垫片已退役：
 * 粘贴进输入框 ≠ 开工。看见 Pasted Content / [Pasted text] 继续等 timeout 或指纹消失且在干活；
 * 超时仍在输入框才 unsubmitted-paste。不补回车、不假装开工（#679 拍板）。
 * #680：cursor-agent 的 [Pasted text] 是提交后显示残留（实测 Working 后残留不消失），
 * 开工探针在 cursor 通道忽略它；Codex [Pasted Content] 仍是未提交。 */
export const UNSUBMITTED_PASTE_REASON = '注入未提交（Pasted Content / Pasted text）——任务书停在输入框未发出，禁止粘贴当开工（#661）';

export function isCursorStartChannel(provider) {
  const p = String(provider || '').trim().toLowerCase();
  return p === 'cursor' || p === 'cursor-agent';
}

/** 去掉 cursor-agent 提交后残留，才能看见输出在不在动。 */
export function stripCursorPasteResidue(text) {
  return String(text ?? '').replace(CURSOR_PASTE_RE, '');
}

/**
 * cursor 开工证据：Working/状态行可在粘贴块上方（残留停在输入框底部），
 * 或去掉 [Pasted text] 后屏面文本在变。
 */
export function cursorStartEvidence({ text, prevText } = {}) {
  const t = String(text ?? '');
  if (CURSOR_WORKING_RE.test(t)) return { ok: true, kind: 'working' };
  if (/(?:^|\n)[^\S\n]*Working(?:\b|[….。\s]|$)/im.test(t)) return { ok: true, kind: 'working' };
  const now = stripCursorPasteResidue(t).replace(/\s+/g, ' ').trim();
  const prev = stripCursorPasteResidue(prevText).replace(/\s+/g, ' ').trim();
  if (now && prev && now !== prev) return { ok: true, kind: 'output-moving' };
  return { ok: false };
}

/**
 * 开工探针用的未提交粘贴。cursor 通道忽略 [Pasted text] 残留；
 * Codex [Pasted Content] 无论通道都算未提交。
 */
export function unsubmittedPasteForStart({ text, provider } = {}) {
  const t = String(text ?? '');
  const codex = t.match(PASTED_CONTENT_RE);
  if (codex) return { kind: 'codex', evidence: codex[0] };
  if (isCursorStartChannel(provider)) return null;
  const leftover = pastedContentMatch(t);
  if (!leftover) return null;
  return { kind: 'legacy', evidence: leftover };
}

/** #651：Cursor 粘贴块等价 Grok 的 Pasted Content——单独出现且后面没有在干活（状态行）
 * 就算未提交（审红 1）。已提交（粘贴块后面有干活状态行）不当未提交，避免死循环误杀。 */
export function cursorUnsubmittedPaste(text) {
  const t = String(text ?? '');
  const m = t.match(CURSOR_PASTE_RE);
  if (!m) return null;
  const tail = t.slice(m.index + m[0].length);
  if (CURSOR_WORKING_RE.test(tail)) return null;
  return m[0];
}

/** #651：未发出的 follow-up 单独也是未提交指纹；已在干活（状态行）不当未提交。 */
export function cursorFollowupEvidence(text) {
  const t = String(text ?? '');
  if (CURSOR_WORKING_RE.test(t)) return null;
  const m = t.match(CURSOR_FOLLOWUP_RE);
  return m ? m[0] : null;
}

/** #651：Cursor 任一未提交指纹（粘贴块 / follow-up）。#633：只当没开工证据，禁止补回车。 */
export function cursorUnsubmittedEvidence(text) {
  return cursorUnsubmittedPaste(text) || cursorFollowupEvidence(text);
}

export function pastedContentMatch(text) {
  const t = String(text ?? '');
  const g = t.match(PASTED_CONTENT_RE);
  if (g) return g[0];
  const c = cursorUnsubmittedPaste(t);
  if (c) return c;
  return cursorFollowupEvidence(t);
}

/** #633：框里躺着的派活字（返工/复核指令）。看门狗只报不回车。 */
export const LEFTOVER_DISPATCH_RE = /【返工指令|【复核指令/;
export function leftoverDispatchMatch(text) {
  const t = String(text ?? '');
  const m = t.match(LEFTOVER_DISPATCH_RE);
  if (m) return m[0];
  const paste = pastedContentMatch(t);
  if (paste && /返工|复核/.test(t)) return paste;
  return null;
}

/** #565 时序 bug 的 TUI 启动占位态指纹：
 * 命中这些屏面文本 = TUI 还在加载（MCP servers 0/5 之类），任务书还没渲染——
 * 绝不判绿，稳定轮数归零，继续等 proof/marker。 */
export const TUI_LOADING_RE = /Starting MCP servers \(\d+\/\d+\)|Connecting|正在启动|初始化|配置同步|请稍候|加载中|登录/i;

/** #877：屏面「正在干活」指纹（spinner / Working / esc to interrupt）。
 * 只用于已验过任务书指纹之后的降级判据——单独出现不算开工（防 #762 假绿）。 */
export const WORKING_SCREEN_RE = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]|\bWorking\b|esc to interrupt/i;

/** pi 的 session 目录名：cwd 的 / 全换 -，首尾包一层 -/--（实测 /home/orca/windsurf-dao
 * → --home-orca-windsurf-dao--）。 */
export function piSessionSlug(cwd) {
  return '-' + String(cwd || '').replace(/\/+$/, '').replace(/\//g, '-') + '--';
}

/** #877 治本：orca worker-read 不认 pi（provider_unsupported / session_not_reported），
 * 而 pi 自己的 session jsonl 实时落盘且**只在任务书真正提交进上下文后**才写 user message——
 * 未提交粘贴不落盘，是比刮屏强得多的开工证据（877 实测：被误杀的审官 jsonl 184KB）。
 * 判据：cwd 对应 slug 目录里 mtime≥sinceMs 的 .jsonl 含 role:user 消息 → proven。
 * 目录不在 / 没有新文件 = 还没证明（继续轮询），不是失败；读目录出错 = unscanned。 */
export function piSessionProof({ cwd, sinceMs, home = process.env.HOME, fsImpl = fs } = {}) {
  if (!cwd) return { ok: true, proven: false, reason: 'pi session proof 没给 cwd' };
  const dir = path.join(String(home || ''), '.pi', 'agent', 'sessions', piSessionSlug(cwd));
  let names;
  try { names = fsImpl.readdirSync(dir); }
  catch (e) {
    if (e && e.code === 'ENOENT') return { ok: true, proven: false, reason: 'pi session 目录还没出现' };
    return { ok: false, proven: false, unscanned: true, error: String((e && e.message) || e) };
  }
  const since = Number(sinceMs) || 0;
  for (const n of names) {
    if (!n.endsWith('.jsonl')) continue;
    const p = path.join(dir, n);
    let st;
    try { st = fsImpl.statSync(p); } catch { continue; }
    if (st.mtimeMs < since) continue;
    let txt;
    try { txt = fsImpl.readFileSync(p, 'utf8'); } catch { continue; }
    if (/"type":\s*"message"/.test(txt) && /"role":\s*"user"/.test(txt)) {
      return { ok: true, proven: true, source: 'pi-session', file: n, reason: 'pi session jsonl 含已提交任务书（role:user）' };
    }
  }
  return { ok: true, proven: false, reason: 'pi session 无新落盘（任务书提交还没证明）' };
}

/** proof 不可用的可辨识 reason（#568 回归修法）：这两个值是 provider 级别不支持
 * transcript 证明（pi 实测 provider_unsupported / session_not_reported），
 * **不是「工人没开工」**——此时降级到屏面判据（连续稳定轮）判绿。
 * 其他值（null / no_hook_report 等）不降级：宁可继续等，不许假绿。 */
export function proofUnavailableReason(p) {
  const reason = String((p && p.fallbackReason) || '');
  return /provider_unsupported|session_not_reported/.test(reason) ? reason : null;
}

export function verifyInjection({ text, readError, expect } = {}) {
  if (readError) return { ok: false, reason: '没读成', error: readError, unscanned: true };
  if (text == null) return { ok: false, reason: '没读成', error: '注入后读屏结果为空', unscanned: true };
  const t = String(text);
  if (!t.trim()) return { ok: false, reason: '注入后屏面是空的', unscanned: false, text: '' };
  // #762：屏面非空 ≠ 注入成功。降级判绿前必须见任务书指纹（expect）——否则 PS 提示符/空转
  // 也会被 3 轮稳定判绿，把「注入没发生」当成「已开工」（2026-08-25 审官实测）。
  const want = String(expect ?? '').trim();
  if (want && !t.includes(want)) {
    return { ok: false, reason: `任务书指纹（${want.slice(0, 24)}…）没出现在屏面——注入可能没发生`, unscanned: false, text: t };
  }
  const g = t.match(PASTED_CONTENT_RE);
  if (g) {
    return {
      ok: false,
      reason: '任务书停在输入框（Pasted Content），没有进上下文',
      evidence: g[0],
      unscanned: false,
      text: t,
    };
  }
  const cm = cursorUnsubmittedPaste(t);
  if (cm) {
    return {
      ok: false,
      reason: '任务书停在输入框（Cursor Pasted text 未发出），没有进上下文',
      evidence: cm,
      unscanned: false,
      text: t,
    };
  }
  const cf = cursorFollowupEvidence(t);
  if (cf) {
    return {
      ok: false,
      reason: '任务书停在输入框（Cursor follow-up 未发出），没有进上下文',
      evidence: cf,
      unscanned: false,
      text: t,
    };
  }
  return { ok: true, text: t, unscanned: false };
}

/**
 * #661/#633/#679：退役「补一记回车」垫片（completePendingPaste 已删除）。
 * 往输入框粘贴 ≠ 开工：未提交粘贴（Pasted Content / [Pasted text] / 未发 follow-up）
 * 只证明任务书停在输入框，不证明 agent 真接过它。开工只认外部证据——
 *   - worker-read 官方 transcript（source≠terminal）= 真 session（调 verifyWorkerStarted）；
 *   - GitHub 已有 review（调用方另查，不在这里）；
 *   - proof 不可用（provider_unsupported / session_not_reported）时降级到屏面连续稳定轮
 *     （= agent 真在干活：屏上没有未提交粘贴）。
 *
 * 仍轮询的只有开工证明本身：
 *   1. worker-read 官方 transcript（source≠terminal）→ started；
 *   2. 看见未提交粘贴 → 继续等到 timeoutMs，或指纹消失且真在干活。
 *      超时仍在输入框才 unsubmitted-paste、pasteSubmitted:false。禁止补回车；
 *      #680：cursor 通道忽略 [Pasted text] 残留，改认 Working / 输出在动；
 *      Codex [Pasted Content] 仍是未提交。
 *   3. TUI 加载期（Starting MCP servers 等）不算绿；
 *   4. proof 不可用（provider_unsupported / session_not_reported）时降级到屏面连续稳定轮。
 */
export function verifyStartedPolling({
  dispatchId, readOnce, proofOnce, timeoutMs,
  intervalMs = 400, sleep = sleepSync, label = '',
  stableRoundsNeeded = 3, provider, expect,
} = {}) {
  if (typeof readOnce !== 'function') {
    throw new Error('verifyStartedPolling 要 readOnce');
  }
  const t0 = Date.now();
  let reads = 0;
  let unscanned = null;
  let lastText = '';
  let prevText = '';
  let proofUnavailable = null;
  let stableRounds = 0;
  let everSawExpect = false;
  const cursor = isCursorStartChannel(provider);
  while (Date.now() - t0 < timeoutMs) {
    if (dispatchId && typeof proofOnce === 'function') {
      const proof = proofOnce(dispatchId);
      if (proof && proof.ok && proof.proven) {
        return {
          ok: true,
          state: 'started',
          proof, reads,
          elapsedMs: Date.now() - t0,
          text: lastText,
        };
      }
      if (proof && proof.unscanned) unscanned = proof;
      if (proof && proof.proven === false && proofUnavailableReason(proof)) {
        proofUnavailable = proof;
      }
    }
    reads++;
    const read = readOnce();
    if (read && read.error) unscanned = { reason: '没读成', error: read.error };
    const text = read && !read.error ? extractTerminalText(read) : '';
    const leftover = unsubmittedPasteForStart({ text, provider });
    if (cursor) {
      const startEv = cursorStartEvidence({ text, prevText });
      prevText = text;
      lastText = text;
      if (leftover) {
        stableRounds = 0;
        sleep(intervalMs);
        continue;
      }
      if (startEv.ok && !TUI_LOADING_RE.test(text)) {
        stableRounds++;
        if (stableRounds >= stableRoundsNeeded) {
          return {
            ok: true,
            state: 'started',
            proofFallback: true,
            cursorStart: startEv.kind,
            proof: proofUnavailable || undefined,
            reads, stableRounds,
            elapsedMs: Date.now() - t0,
            text,
          };
        }
        sleep(intervalMs);
        continue;
      }
      stableRounds = 0;
      sleep(intervalMs);
      continue;
    }
    lastText = text;
    if (leftover) {
      // #679：粘贴后等，不要立刻杀。等 ≠ 补回车。指纹还在输入框就继续轮询。
      stableRounds = 0;
      sleep(intervalMs);
      continue;
    }
    const v = verifyInjection({ text, readError: read && read.error, expect });
    if (v.ok) {
      if (String(expect ?? '').trim()) everSawExpect = true;
      if (TUI_LOADING_RE.test(text)) {
        stableRounds = 0;
      } else {
        stableRounds++;
        if (proofUnavailable && stableRounds >= stableRoundsNeeded) {
          return {
            ok: true,
            state: 'started',
            proofFallback: true,
            proof: proofUnavailable,
            reads, stableRounds,
            elapsedMs: Date.now() - t0,
            text,
          };
        }
      }
    } else if (
      // #877：pi 干活时 TUI 屏面滚动，任务书指纹滚出屏外只剩 spinner——指纹曾验过 +
      // 屏面在干活 + 无未提交粘贴（上面 leftover 已拦）= 开工。从未见过指纹仍不绿（#762）。
      everSawExpect && proofUnavailable
      && WORKING_SCREEN_RE.test(text) && !TUI_LOADING_RE.test(text)
    ) {
      stableRounds++;
      if (stableRounds >= stableRoundsNeeded) {
        return {
          ok: true,
          state: 'started',
          proofFallback: true,
          workingAfterInject: true,
          proof: proofUnavailable,
          reads, stableRounds,
          elapsedMs: Date.now() - t0,
          text,
        };
      }
    }
    sleep(intervalMs);
  }
  const leftoverAtEnd = unsubmittedPasteForStart({ text: lastText, provider });
  if (leftoverAtEnd) {
    return {
      ok: false,
      state: 'unsubmitted-paste',
      reason: UNSUBMITTED_PASTE_REASON,
      evidence: leftoverAtEnd.evidence,
      reads,
      elapsedMs: Date.now() - t0,
      text: lastText,
      pasteSubmitted: false,
    };
  }
  return {
    ok: false,
    state: 'failed',
    reason: `超时没等到开工证明（${label || '注入'}，${timeoutMs}ms）`,
    unscanned: unscanned ? { unscanned: true, reason: unscanned.reason || '未记录', error: unscanned.error } : undefined,
    reads,
    stableRounds,
    elapsedMs: Date.now() - t0,
    text: lastText,
  };
}

/**
 * worker-read 的开工证明（#559 ⑥）。官方可靠源：source ≠ 'terminal' = hook 报告的
 * Codex/Claude/Grok transcript（可证明 worker session）；source = 'terminal' = 只给了
 * 有界终端输出（老式屏面证据，会假阳）。没读成必须标 unscanned——不许当成「没开工」。
 * 判开工优先用它；证明不了时降级回 verifyStartedPolling 的屏面稳定轮。
 */
export function verifyWorkerStarted(readJson) {
  if (readJson == null) return { ok: false, reason: '没读成', unscanned: true, error: 'worker-read 结果为空' };
  if (readJson.error) return { ok: false, reason: '没读成', unscanned: true, error: orcaErrorText(readJson.error) };
  const r = readJson.result ?? readJson;
  const source = r.source ?? 'terminal';
  if (source !== 'terminal') {
    return { ok: true, proven: true, source, reason: '官方 transcript 源（source=' + String(source) + '）' };
  }
  return {
    ok: false,
    proven: false,
    source: 'terminal',
    fallbackReason: r.fallbackReason ?? null,
    reason: 'worker-read 只给终端输出（source=terminal），没证明 worker session——降级回屏面验开工',
  };
}
