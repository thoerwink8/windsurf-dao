// 承认即落点：行内打标的解析、账本读写、增量播报（issue #583）。
//
// 判断交给模型（回复里写半句标记），搬运交给机器（Stop hook 读 transcript）。
// 本文件只装纯函数：hook / 测试喂文本，这里不读 stdin、不碰 ~/.claude。

export const LEDGER_REL = 'DEFERRED.md';
export const ESCALATE_AFTER = 3;

export const REMINDER = [
  '[挂账] 当轮承认但不处理时写 [[挂账: 是什么 | 为何不做 | 解冻条件]]。',
  '关闭 [[关闭: id | 证据]]。再挂 [[继续挂: id | 新原因 | 新触发]]（第 3 次升级给用户）。',
  '明确不做 [[不做: id | 原因]]。',
].join('');

const MARK_RE = /\[\[\s*(挂账|关闭|继续挂|不做)\s*[:：]\s*([\s\S]*?)\]\]/g;

const LEDGER_HEADER = [
  '# 挂账',
  '',
  '本文件由 Stop hook 从回复里的 [[挂账:]] 标记搬运，字段块会被重写成规范形。',
  '关闭必须带可核验证据。明确不做是合法终态。',
  '已知限制：AI 没意识到的错误这条链抓不到；普适挂账会随废弃分支一起消失。',
].join('\n');

export function fingerprint(what) {
  return String(what || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

export function projectSlug(cwd) {
  return String(cwd || '').replace(/[:\\/]/g, '-');
}

export function emptyDelta() {
  return { added: [], closed: [], wontfix: [], continued: [], escalated: [], rejected: [] };
}

export function hasDelta(delta) {
  if (!delta) return false;
  return ['added', 'closed', 'wontfix', 'continued', 'escalated', 'rejected']
    .some((k) => Array.isArray(delta[k]) && delta[k].length > 0);
}

export function clip(s, n = 40) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length <= n ? t : `${t.slice(0, n)}…`;
}

export function formatDelta(delta) {
  if (!hasDelta(delta)) return '';
  const bits = [];
  for (const i of delta.added || []) bits.push(`新 ${i.id}「${clip(i.what)}」`);
  for (const i of delta.closed || []) bits.push(`${i.id} 已关（${clip(i.evidence)}）`);
  for (const i of delta.wontfix || []) bits.push(`${i.id} 不做（${clip(i.evidence || i.why)}）`);
  for (const i of delta.continued || []) bits.push(`${i.id} 继续挂第 ${i.continues} 次`);
  for (const i of delta.escalated || []) {
    bits.push(`${i.id} 第 ${i.continues} 次继续挂 → 请拍板：做还是明确不做`);
  }
  for (const r of delta.rejected || []) bits.push(`未入账：${r.reason}`);
  return `[挂账·增量] ${bits.join('；')}`;
}

export function extractMarks(text) {
  const out = [];
  const src = String(text || '');
  MARK_RE.lastIndex = 0;
  let m;
  while ((m = MARK_RE.exec(src))) {
    const parsed = parsePayload(m[1], m[2]);
    if (parsed) out.push(parsed);
  }
  return out;
}

function parsePayload(action, payload) {
  const parts = String(payload || '').split('|').map((s) => s.trim());
  if (action === '挂账') {
    if (!parts[0]) return null;
    return { action, what: parts[0], why: parts[1] || '', thaw: parts[2] || '' };
  }
  if (action === '关闭') {
    if (!parts[0]) return null;
    return { action, id: parts[0], evidence: parts.slice(1).join(' | ').trim() };
  }
  if (action === '不做') {
    if (!parts[0]) return null;
    return { action, id: parts[0], why: parts.slice(1).join(' | ').trim() };
  }
  if (action === '继续挂') {
    if (!parts[0]) return null;
    return { action, id: parts[0], why: parts[1] || '', thaw: parts[2] || '' };
  }
  return null;
}

export function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text)
    .join('\n');
}

/** 从 jsonl 文本取最后一条 assistant 的 text 块。stdin 正文不走这里。 */
export function lastAssistantText(jsonl) {
  const lines = String(jsonl || '').split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    const msg = obj.message && typeof obj.message === 'object' ? obj.message : obj;
    const role = msg.role || obj.type;
    if (role !== 'assistant') continue;
    const text = textFromContent(msg.content);
    if (!text) continue;
    return {
      text,
      uuid: obj.uuid || msg.id || null,
    };
  }
  return { text: '', uuid: null };
}

export function parseLedger(text) {
  const items = [];
  const src = String(text || '');
  if (!src.trim()) return { items };
  const chunks = src.split(/\r?\n---\r?\n/);
  for (const chunk of chunks) {
    const item = parseItemBlock(chunk);
    if (item) items.push(item);
  }
  return { items };
}

function parseItemBlock(chunk) {
  const fields = {};
  for (const line of String(chunk || '').split(/\r?\n/)) {
    const m = line.match(/^([a-z_]+):\s*(.*)$/);
    if (m) fields[m[1]] = m[2];
  }
  if (!fields.id || !fields.what) return null;
  return {
    id: fields.id,
    status: fields.status || 'open',
    what: fields.what,
    why: fields.why || '',
    thaw: fields.thaw || '',
    continues: Number.parseInt(fields.continues, 10) || 0,
    evidence: fields.evidence || '',
    scope: fields.scope || 'branch',
    at: fields.at || '',
  };
}

export function serializeLedger(doc) {
  const items = Array.isArray(doc?.items) ? doc.items : [];
  if (items.length === 0) return `${LEDGER_HEADER}\n`;
  const blocks = items.map((item) => [
    `id: ${item.id}`,
    `status: ${item.status}`,
    `what: ${item.what}`,
    `why: ${item.why || ''}`,
    `thaw: ${item.thaw || ''}`,
    `continues: ${item.continues || 0}`,
    `evidence: ${item.evidence || ''}`,
    `scope: ${item.scope || 'branch'}`,
    `at: ${item.at || ''}`,
  ].join('\n'));
  return `${LEDGER_HEADER}\n\n---\n\n${blocks.join('\n\n---\n\n')}\n`;
}

export function nextId(items) {
  let max = 0;
  for (const item of items || []) {
    const n = Number.parseInt(String(item.id || '').replace(/^D-/i, ''), 10);
    if (Number.isInteger(n) && n > max) max = n;
  }
  return `D-${String(max + 1).padStart(3, '0')}`;
}

function findItem(items, ref) {
  if (!ref) return null;
  if (/^D-\d+$/i.test(ref)) {
    const n = Number.parseInt(ref.replace(/^D-/i, ''), 10);
    return items.find((i) => Number.parseInt(String(i.id).replace(/^D-/i, ''), 10) === n) || null;
  }
  const fp = fingerprint(ref);
  return items.find((i) => fingerprint(i.what) === fp) || null;
}

function applyContinue(item, mark, delta) {
  if (item.status === 'closed' || item.status === 'wontfix') {
    delta.rejected.push({ reason: `${item.id} 已结束，不能继续挂`, mark });
    return;
  }
  item.continues = (item.continues || 0) + 1;
  if (mark.why) item.why = mark.why;
  if (mark.thaw) item.thaw = mark.thaw;
  if (item.continues >= ESCALATE_AFTER) {
    item.status = 'escalated';
    delta.escalated.push(item);
  } else {
    delta.continued.push(item);
  }
}

export function applyMarks(doc, marks, { now = '' } = {}) {
  const items = (doc?.items || []).map((i) => ({ ...i }));
  const delta = emptyDelta();
  for (const mark of marks || []) {
    if (mark.action === '挂账') {
      const existing = items.find((i) => (
        fingerprint(i.what) === fingerprint(mark.what)
        && i.status !== 'closed'
        && i.status !== 'wontfix'
      ));
      if (existing) {
        applyContinue(existing, mark, delta);
        continue;
      }
      const item = {
        id: nextId(items),
        status: 'open',
        what: mark.what,
        why: mark.why || '',
        thaw: mark.thaw || '',
        continues: 0,
        evidence: '',
        scope: 'branch',
        at: now,
      };
      items.push(item);
      delta.added.push(item);
      continue;
    }
    if (mark.action === '关闭') {
      const item = findItem(items, mark.id);
      if (!item) {
        delta.rejected.push({ reason: `无此 id ${mark.id}`, mark });
        continue;
      }
      if (!mark.evidence) {
        delta.rejected.push({ reason: `${item.id} 关闭必须带证据`, mark });
        continue;
      }
      item.status = 'closed';
      item.evidence = mark.evidence;
      delta.closed.push(item);
      continue;
    }
    if (mark.action === '不做') {
      const item = findItem(items, mark.id);
      if (!item) {
        delta.rejected.push({ reason: `无此 id ${mark.id}`, mark });
        continue;
      }
      if (!mark.why) {
        delta.rejected.push({ reason: `${item.id} 不做必须带原因`, mark });
        continue;
      }
      item.status = 'wontfix';
      item.evidence = mark.why;
      item.why = mark.why;
      delta.wontfix.push(item);
      continue;
    }
    if (mark.action === '继续挂') {
      const item = findItem(items, mark.id);
      if (!item) {
        delta.rejected.push({ reason: `无此 id ${mark.id}`, mark });
        continue;
      }
      applyContinue(item, mark, delta);
    }
  }
  return { doc: { items }, delta };
}
