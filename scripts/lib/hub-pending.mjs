// scripts/lib/hub-pending.mjs —— 总控群待拍板投影（#1029）
//
// 飞书只是投影。真相源是 GitHub 上的「待拍板」标签。指挥官每轮对账：
//   多的补发卡、少的把卡改成已办结。GitHub 没查成时**不许**把卡判成已办结。
// 一件一卡：诞生发一次，此后只 update。
// 发卡过滤复用 ask-gate（不许新造判据）：ask / unscanned 发卡，auto 不发卡只进摘要。

import { classifyAsk } from './ask-gate.mjs';
import { buildDecidedHubCard, buildHubCard } from './feishu-hub-card.mjs';

export const PENDING_DECISION_LABEL = '待拍板';
export const MENU_LIST_PENDING = 'list_pending';
export const MENU_EVENT_TYPE = 'application.bot.menu_v6';

function str(v) {
  return v == null ? '' : String(v).trim();
}

function issueNum(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

/** gh issue list --json 的输出 → 对账用的 github 快照。解析失败 = 没查成，不许当 0 件。 */
export function parseIssueListJson(out, fallbackRepo = '') {
  let arr;
  try {
    arr = JSON.parse(String(out ?? ''));
  } catch (e) {
    return { scanned: false, error: `待拍板列表不是 JSON：${String(e.message || e).slice(0, 80)}` };
  }
  if (!Array.isArray(arr)) {
    return { scanned: false, error: '待拍板列表不是数组' };
  }
  const issues = [];
  for (const issue of arr) {
    if (!issue || typeof issue !== 'object') continue;
    const number = issueNum(issue.number);
    const repo = issueRepo(issue, fallbackRepo);
    if (!number || !repo) continue;
    issues.push({
      repo,
      number,
      title: str(issue.title),
      body: str(issue.body),
      url: str(issue.url) || `https://github.com/${repo}/issues/${number}`,
      labels: labelsOf(issue),
    });
  }
  return { scanned: true, issues };
}

export function githubFromIssueList({ ok, out, error, repo } = {}) {
  if (!ok) {
    return { scanned: false, error: str(error) || '待拍板列表没查成' };
  }
  return parseIssueListJson(out, repo);
}

export function issueKey(repo, number) {
  const r = str(repo);
  const n = issueNum(number);
  if (!r || !n) return '';
  return `${r}#${n}`;
}

export function labelsOf(issue) {
  const raw = issue && issue.labels;
  if (!Array.isArray(raw)) return [];
  return raw.map((l) => (typeof l === 'string' ? l : (l && l.name) || '')).map(str).filter(Boolean);
}

export function hasPendingDecisionLabel(issue) {
  return labelsOf(issue).includes(PENDING_DECISION_LABEL);
}

/** hubPending 表 → 按单聚合。已办结的不算「还在投影里」。缺 repo/number 的不算，对不回单。 */
export function indexHubPending(hubPending) {
  const byIssue = new Map();
  const orphans = [];
  const src = hubPending && typeof hubPending === 'object' && !Array.isArray(hubPending) ? hubPending : {};
  const ids = Object.keys(src).sort();
  for (const messageId of ids) {
    const p = src[messageId];
    if (!p || typeof p !== 'object' || Array.isArray(p)) continue;
    const key = issueKey(p.repo, p.number);
    if (!key) {
      orphans.push({ messageId, pending: p, why: '缺仓库或单号' });
      continue;
    }
    const entry = { messageId, pending: p, key, decided: !!(p.decided && (p.decided.choice || p.decided.who)) };
    if (!byIssue.has(key)) byIssue.set(key, []);
    byIssue.get(key).push(entry);
  }
  return { byIssue, orphans };
}

export function liveCardFor(entries) {
  const list = Array.isArray(entries) ? entries : [];
  return list.find((e) => e && !e.decided) || null;
}

function issueRepo(issue, fallbackRepo) {
  return str(issue && (issue.repo || issue.repository || fallbackRepo));
}

function issueText(issue) {
  return [str(issue && issue.title), str(issue && issue.body)].filter(Boolean).join('\n');
}

/**
 * 复用 ask-gate。policy 没拿到 / classify 落 unscanned ⇒ 发卡（没查成不许自己拍）。
 * auto ⇒ 不发卡。
 */
export function cardFilter(issue, { policy, classify = classifyAsk } = {}) {
  if (!policy || policy.unscanned) {
    const why = (policy && policy.unscanned) || '没拿到策略——判据本身没读到';
    return { verdict: 'unscanned', card: true, why };
  }
  const v = classify({ text: issueText(issue), policy }) || {};
  const verdict = v.verdict || 'unscanned';
  if (verdict === 'auto') return { verdict: 'auto', card: false, why: v.why || 'ask-gate auto' };
  if (verdict === 'ask') return { verdict: 'ask', card: true, why: v.why || 'ask-gate ask' };
  return { verdict: 'unscanned', card: true, why: v.why || 'ask-gate 没查成' };
}

function githubPendingIssues(github, fallbackRepo) {
  const issues = Array.isArray(github && github.issues) ? github.issues : [];
  const out = [];
  for (const issue of issues) {
    if (!hasPendingDecisionLabel(issue)) continue;
    const number = issueNum(issue && issue.number);
    const repo = issueRepo(issue, fallbackRepo);
    if (!number || !repo) continue;
    out.push({
      repo,
      number,
      title: str(issue.title),
      body: str(issue.body),
      url: str(issue.url) || `https://github.com/${repo}/issues/${number}`,
      labels: labelsOf(issue),
    });
  }
  return out;
}

/**
 * 对账计划。纯函数：不读盘、不发网。
 * github.scanned !== true → actions 空，unscanned:true，**没有任何 decide**。
 */
export function planReconcile({
  github, hubPending, policy, classify = classifyAsk, repo: fallbackRepo = '',
} = {}) {
  if (!github || github.scanned !== true) {
    return {
      ok: false,
      unscanned: true,
      error: str(github && github.error) || 'GitHub 待拍板列表没查成',
      actions: [],
      keep: [],
    };
  }
  const pendingIssues = githubPendingIssues(github, fallbackRepo);
  const { byIssue } = indexHubPending(hubPending);
  const seen = new Set();
  const actions = [];
  const keep = [];

  for (const issue of pendingIssues) {
    const key = issueKey(issue.repo, issue.number);
    seen.add(key);
    const live = liveCardFor(byIssue.get(key));
    const filter = cardFilter(issue, { policy, classify });
    if (!filter.card) {
      if (live) {
        actions.push({
          kind: 'decide',
          key,
          messageId: live.messageId,
          pending: live.pending,
          why: filter.why,
        });
        const extras = (byIssue.get(key) || []).filter((e) => e !== live && !e.decided);
        for (const dup of extras) {
          actions.push({
            kind: 'decide',
            key,
            messageId: dup.messageId,
            pending: dup.pending,
            why: '同一单多于一张卡，只留一张',
          });
        }
      }
      actions.push({
        kind: 'digest',
        key,
        issue,
        why: filter.why,
      });
      continue;
    }
    if (live) {
      keep.push({ key, messageId: live.messageId, issue, filter });
      const extras = (byIssue.get(key) || []).filter((e) => e !== live && !e.decided);
      for (const dup of extras) {
        actions.push({
          kind: 'decide',
          key,
          messageId: dup.messageId,
          pending: dup.pending,
          why: '同一单多于一张卡，只留一张',
        });
      }
      continue;
    }
    actions.push({
      kind: 'issue',
      key,
      issue,
      why: filter.why,
    });
  }

  for (const [key, entries] of [...byIssue.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (seen.has(key)) continue;
    for (const e of entries) {
      if (e.decided) continue;
      actions.push({
        kind: 'decide',
        key,
        messageId: e.messageId,
        pending: e.pending,
        why: 'GitHub 上已经没有待拍板标签（别处办结 / 关单 / 摘标）',
      });
    }
  }

  return { ok: true, unscanned: false, actions, keep, pendingCount: pendingIssues.length };
}

/**
 * 菜单「看待拍板」：走和对账同一条取数。
 * 不新发一批卡——已有的 bump（原地 update），没有对应消息的才 issue。
 * 0 件 → empty（必须回一句，不许静默）。
 * 没查成 → unscanned（不许回「0 件」）。
 */
export function planMenuList({
  github, hubPending, policy, classify = classifyAsk, repo: fallbackRepo = '',
} = {}) {
  if (!github || github.scanned !== true) {
    return {
      ok: false,
      unscanned: true,
      empty: false,
      error: str(github && github.error) || 'GitHub 待拍板列表没查成',
      actions: [],
      text: `没查成：${str(github && github.error) || 'GitHub 待拍板列表没查成'}`,
    };
  }
  const pendingIssues = githubPendingIssues(github, fallbackRepo)
    .map((issue) => ({ issue, filter: cardFilter(issue, { policy, classify }) }))
    .filter((x) => x.filter.card);
  const { byIssue } = indexHubPending(hubPending);
  if (pendingIssues.length === 0) {
    return {
      ok: true,
      unscanned: false,
      empty: true,
      actions: [],
      text: '当前没有要你拍的',
    };
  }
  const actions = [];
  for (const { issue, filter } of pendingIssues) {
    const key = issueKey(issue.repo, issue.number);
    const live = liveCardFor(byIssue.get(key));
    if (live) {
      actions.push({
        kind: 'bump',
        key,
        messageId: live.messageId,
        pending: live.pending,
        issue,
        why: '已有卡，原地更新顶上来，不新发',
      });
    } else {
      actions.push({
        kind: 'issue',
        key,
        issue,
        why: filter.why,
      });
    }
  }
  return {
    ok: true,
    unscanned: false,
    empty: false,
    actions,
    text: `待拍板 ${pendingIssues.length} 件`,
  };
}

export function elsewhereDecided({ now, who } = {}) {
  const when = now instanceof Date ? now.toISOString() : str(now) || new Date().toISOString();
  return {
    choice: '已办结',
    who: str(who) || '别处处理',
    when,
  };
}

export function decidedCardFor(pending, decided) {
  return buildDecidedHubCard({ ...(pending || {}), decided });
}

export function pendingCardFor(issueOrPending) {
  return buildHubCard(issueOrPending || {});
}

export function digestLineFor(issue, why) {
  const repo = str(issue && issue.repo);
  const n = issueNum(issue && issue.number);
  const title = str(issue && issue.title);
  const key = repo && n ? `${repo}#${n}` : '';
  return [key, title, why ? `（${why}）` : ''].filter(Boolean).join(' ');
}

export function listPendingIssueArgs(repo) {
  return [
    'issue', 'list',
    '--repo', str(repo),
    '--label', PENDING_DECISION_LABEL,
    '--state', 'open',
    '--json', 'number,title,body,labels,url',
    '--limit', '50',
  ];
}

/**
 * 执行对账计划。issueCard / decideCard / digestLine 由调用方注入（夹具不碰真通道）。
 * 没查成的计划直接退，**一次 decideCard 都不调**。
 */
export function applyReconcilePlan(plan, {
  issueCard, decideCard, digestLine, now, who,
} = {}) {
  if (!plan || plan.unscanned || plan.ok === false) {
    return {
      ok: false,
      unscanned: true,
      error: str(plan && plan.error) || 'GitHub 待拍板列表没查成',
      results: [],
    };
  }
  const results = [];
  for (const a of plan.actions || []) {
    if (a.kind === 'issue') {
      const r = typeof issueCard === 'function' ? issueCard(a) : { ok: false, error: '没有发卡口' };
      results.push({ kind: a.kind, key: a.key, result: r || { ok: false, error: '发卡没回' } });
      continue;
    }
    if (a.kind === 'decide') {
      const decided = elsewhereDecided({ now, who });
      const card = decidedCardFor(a.pending, decided);
      const r = typeof decideCard === 'function'
        ? decideCard({ ...a, decided, card })
        : { ok: false, error: '没有更新口' };
      results.push({ kind: a.kind, key: a.key, messageId: a.messageId, result: r || { ok: false, error: '更新没回' }, decided });
      continue;
    }
    if (a.kind === 'digest') {
      const text = digestLineFor(a.issue, a.why);
      const r = typeof digestLine === 'function'
        ? digestLine({ ...a, text })
        : { ok: false, error: '没有摘要口' };
      results.push({ kind: a.kind, key: a.key, result: r || { ok: false, error: '摘要没回' }, text });
    }
  }
  return { ok: true, unscanned: false, results };
}

export function applyMenuPlan(plan, { bumpCard, issueCard } = {}) {
  if (!plan || plan.unscanned || plan.ok === false) {
    return {
      ok: false,
      unscanned: true,
      empty: false,
      error: str(plan && plan.error) || 'GitHub 待拍板列表没查成',
      text: str(plan && plan.text),
      results: [],
    };
  }
  const results = [];
  for (const a of plan.actions || []) {
    if (a.kind === 'bump') {
      const card = pendingCardFor({ ...(a.pending || {}), ...(a.issue || {}) });
      const r = typeof bumpCard === 'function'
        ? bumpCard({ ...a, card })
        : { ok: false, error: '没有更新口' };
      results.push({ kind: a.kind, key: a.key, messageId: a.messageId, result: r });
    } else if (a.kind === 'issue') {
      const r = typeof issueCard === 'function' ? issueCard(a) : { ok: false, error: '没有发卡口' };
      results.push({ kind: a.kind, key: a.key, result: r });
    }
  }
  return {
    ok: true,
    unscanned: false,
    empty: !!plan.empty,
    text: str(plan.text),
    results,
  };
}

function eventTypeOf(event) {
  if (!event || typeof event !== 'object') return '';
  return str(event.event_type || event.type || event.header?.event_type);
}

/** 飞书机器人菜单 → {eventKey, openId, chatId}；认不出返回 null。 */
export function parseMenuEvent(event) {
  if (!event || typeof event !== 'object') return null;
  const type = eventTypeOf(event);
  if (type && type !== MENU_EVENT_TYPE) return null;
  const nested = event.event && typeof event.event === 'object' ? event.event : null;
  const ev = nested && (nested.event_key || nested.operator) ? nested : event;
  const eventKey = str(ev.event_key || event.event_key);
  if (!eventKey) {
    if (type === MENU_EVENT_TYPE) return { ok: false, error: '菜单事件缺 event_key' };
    return null;
  }
  if (type && type !== MENU_EVENT_TYPE) return null;
  if (!type && !nested && !event.header) {
    // 扁平但没 type：只有明确带 event_key 且不像普通消息才认
    if (event.message) return null;
  }
  const op = ev.operator && typeof ev.operator === 'object' ? ev.operator : {};
  const opId = op.operator_id && typeof op.operator_id === 'object' ? op.operator_id : op;
  return {
    ok: true,
    eventKey,
    known: eventKey === MENU_LIST_PENDING,
    openId: str(opId.open_id || ev.operator_open_id || event.operator_open_id),
    chatId: str(ev.chat_id || op.chat_id || event.chat_id),
  };
}
