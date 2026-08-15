// scripts/lib/master-title.mjs —— 主帅终端标题的单号区（issue #495）
//
// 改这段前必须知道：
// 1. 单号只写在末尾定界区 `｜[#N #M]`，加删只动这个区。不要在整段标题里子串找 #N
//    （#463/#489 用自由中文 + 子串匹配连打四层补丁全部失守）。
// 2. 谁的标题被改，只认「正在跑 dispatch 的那条终端」+「它在主工作树」。
//    不是「我不认识的终端就是主帅」（#492 三次把别人的工位判成孤儿）。
// 3. 2026-08-15 #502 实测：带 agent 的终端 rename 回 ok:true，list/show 标题不变。
//    主帅终端一定带 agent，用本文件改终端标题是死路。dao.mjs 已断开调用。
//    定界区函数仍可用于别的落点（comment 等），合并侧若换落点再接。

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

/**
 * 正识别：主工作树上、且带自己的 handle。
 * 缺 handle：CI 跳过（避免 runner 天天叫），本机报警（静默=标题永不更新）。
 * 认不出是不是主工作树：报警且不改——不把「不认识」当成主帅。
 */
export function titleUpdatePolicy({ env = {}, worktree } = {}) {
  const ci = env.CI === 'true' || env.GITHUB_ACTIONS === 'true';
  const handle = env.ORCA_TERMINAL_HANDLE;
  if (!handle) {
    if (ci) return { action: 'skip', reason: 'CI 无 Orca 终端，标题不更新' };
    return { action: 'warn', reason: 'ORCA_TERMINAL_HANDLE 不在，标题未更新' };
  }
  if (!worktree || typeof worktree.isMainWorktree !== 'boolean') {
    return { action: 'warn', reason: '认不出当前树是不是主工作树，不改标题' };
  }
  if (worktree.isMainWorktree !== true) {
    return { action: 'skip', reason: '当前树不是主工作树，不改工人/审官终端标题' };
  }
  return { action: 'update', handle };
}

function worktreeFromShow(json) {
  return json?.result?.worktree || json?.worktree || null;
}

export function mutateMasterTitle({ env = {}, runOrca, mutate } = {}) {
  if (typeof mutate !== 'function') {
    return { ok: false, action: 'warn', reason: 'mutateMasterTitle 没给 mutate' };
  }
  if (typeof runOrca !== 'function') {
    return { ok: false, action: 'warn', reason: 'mutateMasterTitle 没给 runOrca' };
  }

  let worktree = null;
  const wtId = env.ORCA_WORKTREE_ID;
  if (wtId) {
    const shown = runOrca(['worktree', 'show', '--worktree', wtId, '--json']);
    if (!shown || !shown.ok) {
      const reason = `worktree show 失败，不改标题：${shown?.error || '无详情'}`;
      console.error(`[dao] ${reason}`);
      return { ok: false, action: 'warn', reason };
    }
    worktree = worktreeFromShow(shown.json);
  }

  const policy = titleUpdatePolicy({ env, worktree });
  if (policy.action !== 'update') {
    if (policy.action === 'warn') console.error(`[dao] 主帅标题未更新：${policy.reason}`);
    return { ok: policy.action === 'skip', ...policy };
  }

  const listed = runOrca(['terminal', 'list', '--json']);
  if (!listed || !listed.ok) {
    const reason = `terminal list 失败，不改标题：${listed?.error || '无详情'}`;
    console.error(`[dao] ${reason}`);
    return { ok: false, action: 'warn', reason };
  }
  const terms = listed.json?.result?.terminals;
  if (!Array.isArray(terms)) {
    const reason = 'terminal list 缺 result.terminals，不改标题';
    console.error(`[dao] ${reason}`);
    return { ok: false, action: 'warn', unscanned: true, reason };
  }
  const mine = terms.find(t => t && t.handle === policy.handle);
  if (!mine) {
    const reason = `terminal list 里没有 ${policy.handle}，不改标题`;
    console.error(`[dao] ${reason}`);
    return { ok: false, action: 'warn', reason };
  }

  const current = mine.title == null ? '' : String(mine.title);
  const next = mutate(current);
  if (next === current) {
    return { ok: true, action: 'noop', handle: policy.handle, title: current };
  }
  const renamed = runOrca(['terminal', 'rename', '--terminal', policy.handle, '--title', next, '--json']);
  if (!renamed || !renamed.ok) {
    const reason = `terminal rename 失败：${renamed?.error || '无详情'}`;
    console.error(`[dao] ${reason}`);
    return { ok: false, action: 'warn', reason, handle: policy.handle, from: current, to: next };
  }
  // 投递成功≠送达：带 agent 的终端 rename 回 ok:true 但 list/show 标题不变（#502 实测）。
  const listed2 = runOrca(['terminal', 'list', '--json']);
  const terms2 = listed2?.ok ? listed2.json?.result?.terminals : null;
  const mine2 = Array.isArray(terms2) ? terms2.find(t => t && t.handle === policy.handle) : null;
  const actual = mine2 && mine2.title != null ? String(mine2.title) : '';
  if (actual !== next) {
    const reason = `terminal rename 回读不是所设（投递成功≠送达）：想要「${next}」，实际「${actual || '(空)'}」`;
    console.error(`[dao] ${reason}`);
    return { ok: false, action: 'warn', reason, handle: policy.handle, from: current, to: next, actual };
  }
  return { ok: true, action: 'updated', handle: policy.handle, from: current, title: next };
}

export function afterDispatchSuccess({ name, env = {}, runOrca } = {}) {
  const tickets = ticketsFromName(name);
  if (!tickets.length) {
    return { ok: true, action: 'skip', reason: '派工名里没有 #单号，标题不改', tickets };
  }
  const r = mutateMasterTitle({
    env,
    runOrca,
    mutate: (title) => tickets.reduce((acc, id) => addTicket(acc, id), title),
  });
  return { ...r, tickets };
}

export function applyRemoveTicket({ id, env = {}, runOrca } = {}) {
  const t = normalizeTicket(id);
  if (!t) return { ok: false, action: 'warn', reason: 'applyRemoveTicket 没给合法单号' };
  return mutateMasterTitle({
    env,
    runOrca,
    mutate: (title) => removeTicket(title, t),
  });
}
