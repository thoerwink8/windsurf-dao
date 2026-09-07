// scripts/lib/broadcast-io.mjs —— 播报队列落盘（#1029）
//
// 心跳 / 发布 / 熔断 / board-gc / stall 记进 ~/.dao/broadcast-digest.json；
// 指挥官每轮看是不是新的一天，到点合成一张日报卡发到总控群。
// 本文件不读时钟：now 由调用方传入。

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  ABANDONED_CHAT_IDS,
  abandonedChatIds,
  dueFlush,
  emptyQueue,
  enqueueBroadcast,
  normalizeQueue,
  parseChatListJson,
} from './broadcast-digest.mjs';
import { parseMessageId } from './hub-ask.mjs';

function str(v) {
  return v == null ? '' : String(v).trim();
}

export function digestStatePath(home = homedir()) {
  return process.env.DAO_BROADCAST_DIGEST || join(home, '.dao', 'broadcast-digest.json');
}

export function loadDigestState(path) {
  const file = path || digestStatePath();
  if (!existsSync(file)) {
    return { queue: emptyQueue(), lastSentDay: '', lastSnapshot: null, leftAbandoned: [] };
  }
  try {
    const j = JSON.parse(readFileSync(file, 'utf8'));
    return {
      queue: normalizeQueue(j),
      lastSentDay: str(j && j.lastSentDay),
      lastSnapshot: j && j.lastSnapshot && typeof j.lastSnapshot === 'object' ? j.lastSnapshot : null,
      lastMessageId: str(j && j.lastMessageId),
      leftAbandoned: Array.isArray(j && j.leftAbandoned) ? j.leftAbandoned.map(str).filter(Boolean) : [],
    };
  } catch {
    return {
      queue: emptyQueue(), lastSentDay: '', lastSnapshot: null, leftAbandoned: [],
      unscanned: '播报队列读不了',
    };
  }
}

export function saveDigestState(state, path) {
  const file = path || digestStatePath();
  const dir = dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const payload = {
    day: state.queue?.day || '',
    items: Array.isArray(state.queue?.items) ? state.queue.items : [],
    lastSentDay: str(state.lastSentDay),
    lastSnapshot: state.lastSnapshot || null,
    lastMessageId: str(state.lastMessageId),
    leftAbandoned: Array.isArray(state.leftAbandoned) ? state.leftAbandoned : [],
    updatedAt: new Date().toISOString(),
  };
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
  renameSync(tmp, file);
}

function spawnLark(args, spawn = spawnSync) {
  return spawn('lark-cli', args, { encoding: 'utf8', timeout: 30000, windowsHide: true });
}

export function classifyLarkResult(r, { emptyOk = false } = {}) {
  if (r && r.error) {
    const msg = r.error.code === 'ENOENT' ? 'lark-cli 起不来' : (r.error.message || String(r.error));
    return { ok: false, error: msg };
  }
  if (r && r.status !== 0 && r.status != null) {
    return { ok: false, error: str(r.stderr || r.stdout || `exit ${r.status}`).slice(0, 200) };
  }
  const out = str(r && r.stdout);
  if (!out && !emptyOk) return { ok: false, error: 'lark-cli 没回内容' };
  return { ok: true, out };
}

export function sendCardViaLark({ chatId, card, spawn = spawnSync } = {}) {
  const hub = str(chatId);
  if (!hub) return { ok: false, error: '没送进群：缺群号' };
  if (!card || typeof card !== 'object') return { ok: false, error: '没送进群：缺卡片' };
  const r = spawnLark([
    'im', '+messages-send',
    '--as', 'bot',
    '--chat-id', hub,
    '--msg-type', 'interactive',
    '--content', JSON.stringify(card),
    '--format', 'json',
    '-q', '.data.message_id',
  ], spawn);
  const cls = classifyLarkResult(r);
  if (!cls.ok) return { ok: false, error: `没送进群：${cls.error}` };
  const messageId = parseMessageId(cls.out);
  if (!messageId) {
    return { ok: false, error: `没送进群：没有 message_id（stdout=${cls.out.slice(0, 80)}）` };
  }
  return { ok: true, messageId };
}

export function updateCardViaLark({ messageId, card, spawn = spawnSync } = {}) {
  const id = str(messageId);
  if (!id) return { ok: false, error: '没更新卡：缺消息号' };
  if (!card || typeof card !== 'object') return { ok: false, error: '没更新卡：缺卡片' };
  const r = spawnLark([
    'im', 'messages', 'patch',
    '--as', 'bot',
    '--message-id', id,
    '--data', JSON.stringify({ content: JSON.stringify(card) }),
    '--format', 'json',
  ], spawn);
  const cls = classifyLarkResult(r, { emptyOk: true });
  if (!cls.ok) return { ok: false, error: `没更新卡：${cls.error}` };
  return { ok: true, messageId: id };
}

export function sendTextViaLark({ chatId, text, spawn = spawnSync } = {}) {
  const hub = str(chatId);
  const line = str(text);
  if (!hub) return { ok: false, error: '没送进群：缺群号' };
  if (!line) return { ok: false, error: '没送进群：空文本' };
  const r = spawnLark([
    'im', '+messages-send',
    '--as', 'bot',
    '--chat-id', hub,
    '--text', line,
    '--format', 'json',
    '-q', '.data.message_id',
  ], spawn);
  const cls = classifyLarkResult(r);
  if (!cls.ok) return { ok: false, error: `没送进群：${cls.error}` };
  const messageId = parseMessageId(cls.out);
  if (!messageId) return { ok: false, error: `没送进群：没有 message_id（stdout=${cls.out.slice(0, 80)}）` };
  return { ok: true, messageId };
}

export function defaultListChats({ spawn = spawnSync } = {}) {
  const r = spawnLark(['im', '+chat-list', '--as', 'bot', '--format', 'json', '--page-all'], spawn);
  const cls = classifyLarkResult(r);
  if (!cls.ok) return { scanned: false, error: cls.error };
  return parseChatListJson(cls.out);
}

export function defaultLeaveChat({ chatId, botAppId, spawn = spawnSync } = {}) {
  const id = str(chatId);
  if (!id) return { ok: false, error: '退群缺 chat_id' };
  const appId = str(botAppId);
  const data = appId
    ? JSON.stringify({ id_list: [appId] })
    : JSON.stringify({ id_list: [] });
  const args = [
    'im', 'chat.members', 'delete',
    '--as', 'bot',
    '--chat-id', id,
    '--member-id-type', appId ? 'app_id' : 'open_id',
    '--data', data,
    '--format', 'json',
    '--yes',
  ];
  const r = spawnLark(args, spawn);
  return classifyLarkResult(r, { emptyOk: true });
}

export function leaveAbandonedChats(state, {
  listChats = defaultListChats, leaveChat = defaultLeaveChat, botAppId,
} = {}) {
  const next = {
    ...(state || {}),
    leftAbandoned: Array.isArray(state && state.leftAbandoned) ? [...state.leftAbandoned] : [],
  };
  const listed = listChats();
  if (!listed || listed.scanned !== true) {
    return {
      ok: false,
      unscanned: true,
      error: str(listed && listed.error) || '群列表没查成，不退群',
      state: next,
      left: [],
    };
  }
  const ids = abandonedChatIds(listed.chats);
  const left = [];
  const failed = [];
  for (const id of ids) {
    if (next.leftAbandoned.includes(id)) continue;
    const r = leaveChat({ chatId: id, botAppId });
    if (r && r.ok) {
      next.leftAbandoned.push(id);
      left.push(id);
    } else {
      failed.push({ id, error: str(r && r.error) || '退群失败' });
    }
  }
  const missing = ABANDONED_CHAT_IDS.filter((id) => !ids.includes(id) && !next.leftAbandoned.includes(id));
  return { ok: failed.length === 0, state: next, left, failed, missing };
}

/**
 * 记一条。换日只把昨天的条目留给日报卡去发，本函数不直接发群。
 * 入队成功就算回执——真送到飞书是日报卡那一次。
 */
export function recordBroadcast(text, {
  source = 'misc', now, path, dryRun = false,
} = {}) {
  const file = path || digestStatePath();
  const state = loadDigestState(file);
  if (state.unscanned) return { ok: false, error: state.unscanned, state };
  const enq = enqueueBroadcast(state.queue, { text, source, now });
  state.queue = enq.queue;
  if (enq.flush) {
    // 跨日：昨天的条还没发出去。把它们并回队列头，留给日报卡一次带走。
    state.queue = {
      day: enq.queue.day,
      items: [...enq.flush.items, ...enq.queue.items],
    };
  }
  if (!dryRun) saveDigestState(state, file);
  return {
    ok: true,
    queued: true,
    messageId: `queued:${state.queue.items.length}`,
    state,
    dryRun: !!dryRun,
  };
}

export function flushDueQueue({ now, path } = {}) {
  const file = path || digestStatePath();
  const state = loadDigestState(file);
  if (state.unscanned) return { ok: false, error: state.unscanned, state };
  const due = dueFlush(state.queue, now);
  return { ok: true, state, due };
}
