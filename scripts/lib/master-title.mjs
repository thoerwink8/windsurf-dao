// scripts/lib/master-title.mjs —— 任务卡 comment 的单号定界区（issue #495）
//
// 改这段前必须知道：
// 1. 单号只写在末尾定界区 `｜[#N #M]`，加删只动这个区。不要在整段 comment 里子串找 #N
//    （#463/#489 用自由中文 + 子串匹配连打四层补丁全部失守）。
// 2. 落点是任务卡 `orca worktree set --comment`，不是终端标题。
//    带 agent 的终端 rename 回 ok:true 但 list/show 不变（#502 实测）。
// 3. 写完必回读。投递成功≠送达。
// 4. 合并侧删号：applyRemoveTicket({ id, worktreeId, runOrca })。本文件不碰 flow.mjs。

export const TICKET_ZONE_RE = /｜\[((?:#\d+)(?: #\d+)*)?\]$/;

export function normalizeTicket(id) {
  const m = String(id || '').trim().match(/^#?(\d+)$/);
  return m ? `#${m[1]}` : null;
}

export function ticketsFromName(name) {
  const found = [];
  const re = /#(\d+)/g;
  let m;
  while ((m = re.exec(String(name || '')))) {
    const t = `#${m[1]}`;
    if (!found.includes(t)) found.push(t);
  }
  return found;
}

export function parseTicketZone(title) {
  const s = String(title || '');
  const m = s.match(TICKET_ZONE_RE);
  if (!m) return { prefix: s, tickets: [], hasZone: false };
  const inner = m[1] || '';
  const tickets = inner ? inner.split(/\s+/).filter(Boolean) : [];
  return { prefix: s.slice(0, m.index), tickets, hasZone: true };
}

export function formatTitle(prefix, tickets) {
  const unique = [];
  for (const raw of tickets || []) {
    const t = normalizeTicket(raw);
    if (t && !unique.includes(t)) unique.push(t);
  }
  const head = prefix == null ? '' : String(prefix);
  if (unique.length === 0) return head;
  return `${head}｜[${unique.join(' ')}]`;
}

export function addTicket(title, id) {
  const t = normalizeTicket(id);
  if (!t) return String(title || '');
  const { prefix, tickets } = parseTicketZone(title);
  if (tickets.includes(t)) return formatTitle(prefix, tickets);
  return formatTitle(prefix, [...tickets, t]);
}

export function removeTicket(title, id) {
  const t = normalizeTicket(id);
  const { prefix, tickets, hasZone } = parseTicketZone(title);
  if (!t || !hasZone) return String(title || '');
  return formatTitle(prefix, tickets.filter(x => x !== t));
}

export function auditTitleTickets({ title, openIds } = {}) {
  if (title == null) {
    return { ok: false, unscanned: true, error: '没给标题，没查成', stale: [], scanned: 0 };
  }
  if (openIds == null) {
    return { ok: false, unscanned: true, error: '没给 openIds，没查成', stale: [], scanned: 0 };
  }
  const { tickets, hasZone } = parseTicketZone(title);
  if (!hasZone) {
    return { ok: true, unscanned: false, stale: [], scanned: 0, note: '标题无单号区' };
  }
  const open = new Set();
  for (const raw of openIds) {
    const t = normalizeTicket(raw);
    if (t) open.add(t);
  }
  const stale = tickets.filter(t => !open.has(t));
  return { ok: stale.length === 0, unscanned: false, stale, scanned: tickets.length };
}

/** 派工成功后卡 comment 必须有定界区。没给样本 = 没查成；有期望单号却无区 = 报警。 */
export function auditDispatchComment({ comment, expectedTickets } = {}) {
  if (comment == null) {
    return { ok: false, unscanned: true, error: '没给 comment，没查成', missing: [], scanned: 0 };
  }
  if (expectedTickets == null) {
    return { ok: false, unscanned: true, error: '没给 expectedTickets，没查成', missing: [], scanned: 0 };
  }
  const expected = [];
  for (const raw of expectedTickets) {
    const t = normalizeTicket(raw);
    if (t && !expected.includes(t)) expected.push(t);
  }
  if (expected.length === 0) {
    return { ok: true, unscanned: false, missing: [], scanned: 0, note: '没有期望单号' };
  }
  const { tickets, hasZone } = parseTicketZone(comment);
  if (!hasZone) {
    return {
      ok: false,
      unscanned: false,
      missing: expected,
      scanned: 0,
      reason: '派工卡 comment 缺单号定界区',
    };
  }
  const missing = expected.filter(t => !tickets.includes(t));
  return { ok: missing.length === 0, unscanned: false, missing, scanned: tickets.length };
}

function commentFromShow(json) {
  const wt = json?.result?.worktree || json?.worktree;
  return wt && wt.comment != null ? String(wt.comment) : '';
}

export function mutateWorktreeComment({ worktreeId, mutate, runOrca } = {}) {
  if (!worktreeId) return { ok: false, action: 'warn', reason: 'mutateWorktreeComment 没给 worktreeId' };
  if (typeof mutate !== 'function') return { ok: false, action: 'warn', reason: 'mutateWorktreeComment 没给 mutate' };
  if (typeof runOrca !== 'function') return { ok: false, action: 'warn', reason: 'mutateWorktreeComment 没给 runOrca' };

  const shown = runOrca(['worktree', 'show', '--worktree', worktreeId, '--json']);
  if (!shown || !shown.ok) {
    const reason = `worktree show 失败，不改 comment：${shown?.error || '无详情'}`;
    console.error(`[dao] ${reason}`);
    return { ok: false, action: 'warn', reason };
  }
  const current = commentFromShow(shown.json);
  const next = mutate(current);
  if (next === current) {
    return { ok: true, action: 'noop', worktreeId, comment: current };
  }
  const set = runOrca(['worktree', 'set', '--worktree', worktreeId, '--comment', next, '--json']);
  if (!set || !set.ok) {
    const reason = `worktree set --comment 失败：${set?.error || '无详情'}`;
    console.error(`[dao] ${reason}`);
    return { ok: false, action: 'warn', reason, from: current, to: next };
  }
  const shown2 = runOrca(['worktree', 'show', '--worktree', worktreeId, '--json']);
  const actual = commentFromShow(shown2?.json);
  if (actual !== next) {
    const reason = `worktree comment 回读不是所设（投递成功≠送达）：想要「${next}」，实际「${actual || '(空)'}」`;
    console.error(`[dao] ${reason}`);
    return { ok: false, action: 'warn', reason, from: current, to: next, actual };
  }
  return { ok: true, action: 'updated', worktreeId, from: current, comment: next };
}

export function afterDispatchComment({ name, worktreeId, runOrca } = {}) {
  const tickets = ticketsFromName(name);
  if (!tickets.length) {
    return { ok: true, action: 'skip', reason: '派工名里没有 #单号，comment 不定界区', tickets };
  }
  const r = mutateWorktreeComment({
    worktreeId,
    runOrca,
    mutate: (comment) => tickets.reduce((acc, id) => addTicket(acc, id), comment),
  });
  return { ...r, tickets };
}

export function applyRemoveTicket({ id, worktreeId, runOrca } = {}) {
  const t = normalizeTicket(id);
  if (!t) return { ok: false, action: 'warn', reason: 'applyRemoveTicket 没给合法单号' };
  return mutateWorktreeComment({
    worktreeId,
    runOrca,
    mutate: (comment) => removeTicket(comment, t),
  });
}
