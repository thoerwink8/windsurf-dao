// scripts/lib/broadcast-digest.mjs —— 播报撤出总控，攒成每天一条（#1029）
//
// 心跳 / 发布 / 熔断 / board-gc / stall 不再进总控消息流。
// 调用方把一条记进队列；指挥官每轮看「是不是新的一天」，到点合成一条发到「道·播报」。
// 纯函数：不读时钟、不发网。day / now 由调用方传入。

export const BROADCAST_CHAT_NAME = '道·播报';
export const ABANDONED_CHAT_PREFIXES = [
  'oc_37d7d3b1',
  'oc_e779d49e',
  'oc_45c99a05',
  'oc_dab28549',
];

export const ABANDONED_CHAT_IDS = [
  'oc_37d7d3b10274c04eb5bf3d52d4246424',
  'oc_e779d49e6aa6f7f59ed719de2913f8a1',
  'oc_45c99a053f683457d59b0d581b18a1ee',
  'oc_dab285495f665f7639335e3fac1e9231',
];

function str(v) {
  return v == null ? '' : String(v).trim();
}

export function dayOf(now) {
  if (typeof now === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(now)) return now;
  const d = now instanceof Date ? now : new Date(now || Date.now());
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}

export function emptyQueue() {
  return { day: '', items: [] };
}

export function normalizeQueue(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptyQueue();
  const day = str(raw.day);
  const items = Array.isArray(raw.items)
    ? raw.items.map((x) => ({
      at: str(x && x.at),
      source: str(x && x.source) || 'misc',
      text: str(x && x.text),
    })).filter((x) => x.text)
    : [];
  return { day, items };
}

/**
 * 记一条。换日 ⇒ 先把昨天的吐出来（flush），再开新队列。
 * 返回 { queue, flush }。flush 非空 = 昨天该发的摘要。
 */
export function enqueueBroadcast(queue, { text, source, now } = {}) {
  const line = str(text);
  const q = normalizeQueue(queue);
  const day = dayOf(now);
  if (!line) return { queue: q, flush: null };
  if (q.day && day && q.day !== day && q.items.length) {
    return {
      queue: { day, items: [{ at: day, source: str(source) || 'misc', text: line }] },
      flush: { day: q.day, items: q.items },
    };
  }
  const next = {
    day: day || q.day,
    items: [...q.items, { at: day || q.day, source: str(source) || 'misc', text: line }],
  };
  return { queue: next, flush: null };
}

/** 强制把当前队列吐出来（菜单不走这条；指挥官跨日 / 装机自检用）。 */
export function flushBroadcast(queue) {
  const q = normalizeQueue(queue);
  if (!q.items.length) return { queue: { day: q.day, items: [] }, flush: null };
  return { queue: { day: q.day, items: [] }, flush: { day: q.day, items: q.items } };
}

/**
 * 指挥官每轮：换日且昨天有条目 ⇒ 吐出。
 * 不等有新条入队——安静的新一天也要把昨天的摘要发掉。
 */
export function dueFlush(queue, now) {
  const q = normalizeQueue(queue);
  const today = dayOf(now);
  if (q.day && today && q.day !== today && q.items.length) {
    return {
      queue: { day: today, items: [] },
      flush: { day: q.day, items: q.items },
    };
  }
  return { queue: q, flush: null };
}

export function renderDigest(flush) {
  if (!flush || !Array.isArray(flush.items) || !flush.items.length) return '';
  const day = str(flush.day) || '今天';
  const lines = [`道·播报 ${day}（${flush.items.length} 条）`];
  for (const it of flush.items) {
    const src = str(it.source);
    lines.push(`- ${src ? `[${src}] ` : ''}${it.text}`);
  }
  return lines.join('\n');
}

export function isAbandonedChatId(id) {
  const s = str(id);
  if (ABANDONED_CHAT_IDS.includes(s)) return true;
  return ABANDONED_CHAT_PREFIXES.some((p) => s.startsWith(p));
}

export function findBroadcastChatId(chats) {
  const list = Array.isArray(chats) ? chats : [];
  for (const c of list) {
    const name = str(c && (c.name || c.chat_name));
    if (name === BROADCAST_CHAT_NAME) return str(c.chat_id || c.id);
  }
  return '';
}

function asChatList(raw) {
  if (Array.isArray(raw)) return raw;
  if (!raw || typeof raw !== 'object') return [];
  if (Array.isArray(raw.data?.items)) return raw.data.items;
  if (Array.isArray(raw.items)) return raw.items;
  if (Array.isArray(raw.data?.chats)) return raw.data.chats;
  if (Array.isArray(raw.data)) return raw.data;
  return [];
}

/** lark-cli +chat-list / +chat-search 的 JSON → {scanned, chats}。解不了 = 没查成。 */
export function parseChatListJson(out) {
  let raw;
  try {
    raw = JSON.parse(String(out ?? ''));
  } catch (e) {
    return { scanned: false, error: `群列表不是 JSON：${String(e.message || e).slice(0, 80)}` };
  }
  return { scanned: true, chats: asChatList(raw) };
}

export function chatIdFromCreate(out) {
  try {
    const j = JSON.parse(String(out ?? ''));
    return str(j?.data?.chat_id || j?.chat_id || j?.data?.id);
  } catch {
    return str(out).replace(/^"|"$/g, '');
  }
}

export function abandonedChatIds(chats) {
  const list = Array.isArray(chats) ? chats : [];
  const out = [];
  for (const c of list) {
    const id = str(c && (c.chat_id || c.id));
    if (id && isAbandonedChatId(id)) out.push(id);
  }
  return out;
}
