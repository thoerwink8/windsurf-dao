// doorbell-core.mjs —— 空闲短门铃的纯逻辑（issue #645）
//
// 与 pi 运行时解耦：这里只放「能从 relay 日志行推导出该不该响门铃」的纯函数，
// node 22 CI 直接可测（tests/doorbell.test.js）。doorbell.ts 只负责把它接上 pi 生命周期。
//
// 语义（#644/#645 消歧记录）：
//   - 框空、没在打字时 → 代按一句「你有来信」再回车叫醒协调者（门铃 = sendUserMessage(短句)）
//   - 人在打字 → 绝不占输入框（editorText 非空即不响）
//   - 信的正文 → 不进输入框，只在对话里（门铃只进短句；正文留在 relay 日志里由协调者读）
//   - 通道 → 仍只一个等信者（现有信箱台），不拆信箱台（本模块只读日志，不加第二个 waiter）

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const DOORBELL_TEXT = '你有来信';
export const DEFAULT_LOG_DIR = '_flow';

/**
 * 解析 inbox 日志一行。格式：
 *   {"ts","id","type","from","to","subject","body","payload"}
 * relay 只落盘非 heartbeat 的消息行；archive-exec 行（可归档执行记录）是机器动作，
 * 不是工人来信，不算 actionable。
 * 解析失败 / 缺 id / heartbeat / archive-exec 返回 null。
 */
export function parseLogLine(line) {
  if (typeof line !== 'string') return null;
  const t = line.trim();
  if (!t.startsWith('{')) return null;
  let msg;
  try {
    msg = JSON.parse(t);
  } catch {
    return null;
  }
  if (!msg || typeof msg !== 'object') return null;
  if (!msg.id || typeof msg.id !== 'string') return null;
  if (msg.type === 'heartbeat') return null;
  if (msg.type === 'archive-exec') return null;
  return msg;
}

/**
 * 从一批日志行里收集「新的、可响门铃的」消息，按 id 去重。
 * 返回新消息数组；调用方把返回的 id 并入 seenIds（本函数也会就地并入）。
 * 幂等：同一行文本重复喂，第二次不再返回。
 * 注意：seenIds 只去重「已经解析过」——是否已成功响铃由调用方的
 * pendingIds（待响集合）独立记账（红 1 修法：未响铃的消息保持待响）。
 */
export function collectNewMessages(lines, seenIds) {
  const fresh = [];
  if (!Array.isArray(lines)) return fresh;
  for (const line of lines) {
    const msg = parseLogLine(line);
    if (!msg) continue;
    if (seenIds.has(msg.id)) continue;
    seenIds.add(msg.id);
    fresh.push(msg);
  }
  return fresh;
}

/**
 * 该不该响门铃（纯决策，不碰运行时）：
 *   - 必须确有新鲜消息（hasFresh）
 *   - pi 必须空闲（idle）——正在干活不打断
 *   - 输入框必须为空（editorText 无有效字符）——人在打字绝不占框
 *   - 冷却期内不重复响（cooldownMs > 0 时，距上次响 < 冷却即 false）
 */
export function shouldRing({ hasFresh, idle, editorText, now, lastRingAt, cooldownMs }) {
  if (!hasFresh) return false;
  if (!idle) return false;
  if (typeof editorText === 'string' && editorText.trim().length > 0) return false;
  const cd = Number(cooldownMs);
  if (Number.isFinite(cd) && cd > 0 && Number.isFinite(lastRingAt) && lastRingAt > 0) {
    if (now - lastRingAt < cd) return false;
  }
  return true;
}

/** 信箱台日志目录：环境变量优先，默认 <cwd>/_flow。 */
export function logDirFor(cwd) {
  if (process.env.PI_DOORBELL_LOG_DIR) return process.env.PI_DOORBELL_LOG_DIR;
  return join(cwd, DEFAULT_LOG_DIR);
}

/** 列出 logDir 下所有 inbox-*.log。读不到目录返回 []。 */
export function listInboxLogs(dir) {
  try {
    return readdirSync(dir)
      .filter((f) => /^inbox-.+\.log$/.test(f))
      .map((f) => join(dir, f))
      .sort();
  } catch {
    return [];
  }
}

/**
 * 轮询一轮：读每个日志从上次偏移起的新行 → 收集新消息 → 决策是否响门铃。
 * 返回 { rang, newCount, pending }（测试可直接调用）。
 * ctx 需要：isIdle() / ui.getEditorText()。sendUserMessage 由调用方注入。
 *
 * 状态三件套（红 1 / 红 2 修法）：
 *   - seenIds：只去重「解析过」——同一 id 重读（文件截断/轮转）不再重复处理。
 *   - pendingIds：已解析但**未成功响铃**的消息 id。打字/忙/冷却时来信进这里，
 *     条件满足后（空闲 + 框空 + 冷却外）响一次并清空。
 *   - primeFiles：每个日志文件首次见到时，存量全部并入 seenIds（不待响、不响），
 *     之后的追加行才盯——日志从无到有时（新机/归档清 `_flow`/新 Run 首信）
 *     不是永久失聪，只是这一批存量不当新信。
 */
export function pollOnce({
  dir,
  offsets,
  seenIds,
  pendingIds,
  primeFiles,
  lastRingAt,
  now,
  cooldownMs,
  ctx,
  sendUserMessage,
  text = DOORBELL_TEXT,
}) {
  const files = listInboxLogs(dir);
  let newCount = 0;
  for (const file of files) {
    let size;
    try {
      size = statSync(file).size;
    } catch {
      offsets.delete(file);
      continue;
    }
    const prev = offsets.get(file) ?? 0;
    if (size < prev) {
      // 文件被截断/轮转：重读全文（seenIds 兜底去重）
      offsets.set(file, 0);
      continue;
    }
    if (size === prev) continue;
    let raw;
    try {
      raw = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const lines = raw.split(/\r?\n/);
    if (!primeFiles.has(file)) {
      // 首次见到该日志：存量并入 seenIds（不待响、不响），之后的新行才盯。
      collectNewMessages(lines, seenIds);
      offsets.set(file, size);
      primeFiles.add(file);
      continue;
    }
    const fresh = collectNewMessages(lines, seenIds);
    newCount += fresh.length;
    for (const m of fresh) pendingIds.add(m.id);
    offsets.set(file, size);
  }
  const idle = typeof ctx?.isIdle === 'function' ? ctx.isIdle() : false;
  let editorText = '';
  try {
    editorText = ctx?.ui?.getEditorText?.() ?? '';
  } catch {
    editorText = '';
  }
  const ring = shouldRing({
    hasFresh: pendingIds.size > 0,
    idle,
    editorText,
    now,
    lastRingAt,
    cooldownMs,
  });
  if (!ring) return { rang: false, newCount, pending: pendingIds.size };
  try {
    sendUserMessage(text);
  } catch (e) {
    console.error(`[doorbell] 门铃发送失败: ${e?.message || e}`);
    return { rang: false, newCount, pending: pendingIds.size };
  }
  pendingIds.clear();
  return { rang: true, newCount, pending: 0 };
}
