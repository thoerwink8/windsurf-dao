// scripts/lib/hub-ask.mjs —— 出站待拍板卡片（#1012）
//
// 机器主动问用户：复用 buildHubCard，不许另写一份卡片构造。
// 缺 {repo, number} 拒发——发出去的卡点了对不回单。
// 飞书回执只认 message_id，退出码 0 不算送进群（与 hubSay 同一坑）。

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { buildHubCard } from './feishu-hub-card.mjs';
import { doorOf, TWO_WAY_DEADLINE_MS } from './daipai.mjs';

function str(v) {
  return v == null ? '' : String(v).trim();
}

function issueNum(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

/** 缺仓库或单号一律拒。调用方在 send 之前调，避免发出去对不回单。 */
export function validateHubAsk(input = {}) {
  const repo = str(input.repo);
  const number = issueNum(input.number);
  if (!repo) return { ok: false, error: '缺仓库，拒发——点了对不回单' };
  if (!number) return { ok: false, error: '缺单号，拒发——点了对不回单' };
  return { ok: true, repo, number };
}

export function pendingFromAsk(input = {}) {
  const v = validateHubAsk(input);
  const repo = v.ok ? v.repo : str(input.repo);
  const number = v.ok ? v.number : issueNum(input.number);
  return {
    repo,
    number,
    url: str(input.url),
    title: str(input.title),
    from: str(input.from),
    what: str(input.what) || str(input.title),
    impact: str(input.impact),
    recommend: str(input.recommend),
    why: str(input.why),
    deadline: str(input.deadline),
  };
}

const ASK_FLAGS = ['url', 'title', 'from', 'what', 'impact', 'recommend', 'why', 'deadline'];

export function argvFromFields(input = {}) {
  const v = validateHubAsk(input);
  if (!v.ok) return v;
  const args = ['--repo', v.repo, '--number', String(v.number)];
  for (const k of ASK_FLAGS) {
    const val = str(input[k]);
    if (val) args.push(`--${k}`, val);
  }
  return { ok: true, args };
}

/** lark-cli / hub-say 的 stdout：去引号；空和字面 "null" 都算没拿到。 */
export function parseMessageId(raw) {
  const messageId = str(raw).replace(/^"|"$/g, '');
  if (!messageId || messageId === 'null') return '';
  return messageId;
}

export function classifySendResult(r = {}) {
  if (r.error) {
    const msg = r.error.code === 'ENOENT'
      ? 'lark-cli 起不来'
      : (r.error.message || String(r.error));
    return { ok: false, error: `没送进群：${msg}` };
  }
  const status = r.status;
  if (status !== 0 && status != null) {
    const err = str(r.stderr || r.stdout || `exit ${status}`).slice(0, 200);
    return { ok: false, error: `没送进群：${err}` };
  }
  const messageId = parseMessageId(r.stdout);
  if (!messageId) {
    return { ok: false, error: `没送进群：没有 message_id（stdout=${str(r.stdout).slice(0, 80)}）` };
  }
  return { ok: true, messageId };
}

/**
 * 记 messageId → 单号。已有 decided 的保留——发卡后立刻有人点，
 * 后写的 pending 不许把「已拍」冲掉。
 */
export function mergeHubPending(store, messageId, pending) {
  const id = str(messageId);
  if (!store) return { ok: false, error: '没有 hubPending 表，拒发——点了对不回单' };
  if (!id) return { ok: false, error: '缺 message_id，没法记 pending' };
  store.hubPending = store.hubPending && typeof store.hubPending === 'object' ? store.hubPending : {};
  const prev = store.hubPending[id] && typeof store.hubPending[id] === 'object' ? store.hubPending[id] : {};
  store.hubPending[id] = {
    ...pending,
    ...prev,
    repo: pending?.repo || prev.repo,
    number: pending?.number || prev.number,
    decided: prev.decided || pending?.decided,
  };
  return { ok: true };
}

export function sendCardViaLarkCli({ chatId, card, spawn = spawnSync } = {}) {
  const hub = str(chatId);
  if (!hub) return { ok: false, error: '没送进群：缺群号' };
  const r = spawn('lark-cli', [
    'im', '+messages-send',
    '--as', 'bot',
    '--chat-id', hub,
    '--msg-type', 'interactive',
    '--content', JSON.stringify(card),
    '--format', 'json',
    '-q', '.data.message_id',
  ], { encoding: 'utf8', timeout: 30000, windowsHide: true });
  return classifySendResult(r);
}

/**
 * 出站发一张待拍板卡。send / store 可注入（夹具不碰真通道）。
 * 成功才记 hubPending；send 失败不写假账。
 */
export function runHubAsk(input = {}, { send, store } = {}) {
  const v = validateHubAsk(input);
  if (!v.ok) return v;
  if (!store || typeof store !== 'object') {
    return { ok: false, error: '没有 hubPending 表，拒发——点了对不回单' };
  }
  if (typeof send !== 'function') {
    return { ok: false, error: '没送进群：没有发送口' };
  }
  const fields = { ...input, repo: v.repo, number: v.number };
  const card = buildHubCard(fields);
  let sent;
  try {
    sent = send(card);
  } catch (e) {
    return { ok: false, error: `没送进群：${e && e.message ? e.message : String(e)}` };
  }
  if (!sent || sent.ok !== true) {
    return { ok: false, error: (sent && sent.error) || '没送进群：没有 message_id' };
  }
  const messageId = parseMessageId(sent.messageId);
  if (!messageId) {
    return { ok: false, error: '没送进群：没有 message_id' };
  }
  const pending = pendingFromAsk(fields);
  const merged = mergeHubPending(store, messageId, pending);
  if (!merged.ok) return merged;
  if (typeof store.save === 'function') store.save();
  return { ok: true, messageId, card, pending };
}

const HOURS = Math.round(TWO_WAY_DEADLINE_MS / 3600000);

/** 指挥官报帅：有单号才发卡；没单号的待拍板出口不许发（点了对不回单）。 */
export function fieldsFromEscalate({ repo, number, why, reason, recommend, url } = {}) {
  const v = validateHubAsk({ repo, number });
  if (!v.ok) return v;
  const door = doorOf(reason);
  const rec = door === 'two-way'
    ? (recommend || '大脑边界内处置：定位问题 → 给方案 → 送达相关终端')
    : '等你拍板，超时不动';
  return {
    ok: true,
    fields: {
      repo: v.repo,
      number: v.number,
      url: url || '',
      title: why || '',
      from: '指挥官',
      what: why || '',
      impact: '不拍就不会动',
      recommend: rec,
      why: door === 'two-way' ? `双向门，${HOURS} 小时无人回复按推荐代拍` : '单向门，只等拍板',
      deadline: door === 'two-way' ? `双向门：${HOURS} 小时` : '单向门：超时不动',
    },
  };
}

/** 盘点开出的待拍板单。 */
export function fieldsFromInventory({ repo, number, key, detail, url } = {}) {
  const v = validateHubAsk({ repo, number });
  if (!v.ok) return v;
  return {
    ok: true,
    fields: {
      repo: v.repo,
      number: v.number,
      url: url || '',
      title: key || '',
      from: '指挥官盘点',
      what: detail || key || '',
      impact: '修要过你放行，不拍不会自己改',
      recommend: '放行后按盘点项修',
      why: '盘点只开单不自修',
      deadline: '',
    },
  };
}

/** 熔断全开：开出待拍板单之后才有单号。 */
export function fieldsFromBreaker({ repo, number, text, url } = {}) {
  const v = validateHubAsk({ repo, number });
  if (!v.ok) return v;
  return {
    ok: true,
    fields: {
      repo: v.repo,
      number: v.number,
      url: url || '',
      title: '编排层熔断：全部路径 open',
      from: '指挥官',
      what: text || '编排层熔断，全部路径 open',
      impact: '派工通道全停，不拍不会自己恢复',
      recommend: '看熔断原因，放行后再开',
      why: '全部路径 open 是单向门',
      deadline: '单向门：超时不动',
    },
  };
}

export function hubAskScriptPath(root) {
  return join(root, 'scripts', 'hub-ask.mjs');
}
