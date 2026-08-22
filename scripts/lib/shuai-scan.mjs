// scripts/lib/shuai-scan.mjs —— 帅位看门狗纯函数层（chain:shuai-watchdog#1）
//
// 采集与判定分离：tests 注入 fixture/mock，CLI 只负责 IO。
// 「扫完 0 条」与「没扫成」必须不同形——任何 unscanned 维度整轮 fail-loud。

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allChecksGreen } from './close-issue.mjs';
import { inspectReadyQueue } from './ready-queue-check.mjs';
import { planRunGc, isLiveDispatch } from './run-lifecycle.mjs';
import {
  activeRunIds,
  relevantMessages,
  readLoggedIds,
  splitMessages,
  DEFAULT_LOG_REL,
} from '../inbox-station.mjs';

export const SENTINEL = 'AGENT_LOOP_TICK_PANMIAN';
export const DEFAULT_REPO = 'thoerwink8/windsurf-dao';
export const DEFAULT_STATE_BASENAME = 'shuai-scan-last.json';

const DEFAULT_TITLE_TEMPLATES = {
  P0: '帅·#{number} CI红',
  P1: '帅·#{number} 待合并',
  P2: '帅·#{number} 待派工',
  异常: '帅·{摘要}',
};
const DEFAULT_TITLE_MAX = 36;

export const GITHUB_GRAPHQL = `
query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    issues(first: 100, states: OPEN, orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes {
        number
        title
        updatedAt
        labels(first: 30) { nodes { name } }
      }
    }
    pullRequests(first: 100, states: OPEN, orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes {
        number
        title
        updatedAt
        isDraft
        reviewDecision
        mergeable
        body
        commits(last: 1) {
          nodes {
            commit {
              statusCheckRollup {
                contexts(first: 40) {
                  nodes {
                    ... on CheckRun {
                      status
                      conclusion
                    }
                    ... on StatusContext {
                      state
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}`;

function repoParts(repo) {
  const m = String(repo || '').match(/^([^/]+)\/([^/]+)$/);
  if (!m) return { ok: false, error: `仓库名形态不对（要 owner/name）：${repo}` };
  return { ok: true, owner: m[1], name: m[2] };
}

export function loadRules(text) {
  let doc;
  try {
    doc = JSON.parse(String(text || ''));
  } catch (e) {
    return { ok: false, error: `规则文件 JSON 解析失败：${String(e.message || e).slice(0, 120)}` };
  }
  if (!doc || typeof doc !== 'object') {
    return { ok: false, error: '规则文件不是对象' };
  }
  const anomalies = doc['异常判据'];
  const priorities = doc['推荐排序'];
  if (!anomalies || typeof anomalies !== 'object') {
    return { ok: false, error: '规则文件缺「异常判据」段' };
  }
  if (!priorities || typeof priorities !== 'object') {
    return { ok: false, error: '规则文件缺「推荐排序」段' };
  }
  return { ok: true, rules: doc };
}

export function loadRulesFile(path) {
  try {
    return loadRules(readFileSync(path, 'utf8'));
  } catch (e) {
    return { ok: false, error: `规则文件读不到：${String(e.message || e).slice(0, 120)}` };
  }
}

function rollupFromGraphqlCommit(commitNode) {
  const contexts = commitNode?.statusCheckRollup?.contexts?.nodes;
  if (!Array.isArray(contexts)) return null;
  const rollup = [];
  for (const c of contexts) {
    if (!c) continue;
    if ('status' in c && c.status != null) {
      rollup.push({ status: String(c.status).toUpperCase(), conclusion: c.conclusion ? String(c.conclusion).toUpperCase() : null });
      continue;
    }
    if ('state' in c && c.state != null) {
      const st = String(c.state).toUpperCase();
      rollup.push({ status: 'COMPLETED', conclusion: st === 'SUCCESS' ? 'SUCCESS' : st === 'FAILURE' ? 'FAILURE' : st || null });
    }
  }
  return rollup;
}

export function normalizeGithubGraphql(data) {
  const repo = data?.repository;
  if (!repo) return { ok: false, error: 'GraphQL 没返回 repository——没扫成' };
  const issues = (repo.issues?.nodes || []).map((i) => ({
    number: i.number,
    title: i.title,
    updatedAt: i.updatedAt,
    labels: (i.labels?.nodes || []).map((l) => ({ name: l.name })),
  }));
  const prs = (repo.pullRequests?.nodes || []).map((p) => {
    const commit = p.commits?.nodes?.[0]?.commit;
    const statusCheckRollup = rollupFromGraphqlCommit(commit);
    return {
      number: p.number,
      title: p.title,
      updatedAt: p.updatedAt,
      isDraft: !!p.isDraft,
      reviewDecision: p.reviewDecision || null,
      mergeable: p.mergeable || null,
      body: p.body || '',
      state: 'OPEN',
      statusCheckRollup,
    };
  });
  return { ok: true, issues, prs };
}

/** 供单测直接喂 gh issue/pr list 形态。 */
export function normalizeGithubLists({ issues, prs } = {}) {
  if (!Array.isArray(issues) || !Array.isArray(prs)) {
    return { ok: false, error: 'issues/prs 必须是数组——没扫成' };
  }
  return { ok: true, issues, prs };
}

function unwrapOrcaList(json, key) {
  const v = json?.result?.[key] ?? json?.[key];
  return Array.isArray(v) ? v : null;
}

function parseWorkerAgeMinutes(worker) {
  const raw = worker?.updatedAt || worker?.updated_at;
  if (!raw) return null;
  const ms = Date.parse(String(raw).includes('T') ? raw : `${raw.replace(' ', 'T')}Z`);
  if (!Number.isFinite(ms)) return null;
  return (Date.now() - ms) / 60000;
}

export function collectOrcaBoard({ runOrca, root = process.cwd(), logRel = DEFAULT_LOG_REL } = {}) {
  if (typeof runOrca !== 'function') {
    return { ok: false, error: 'collectOrcaBoard 缺 runOrca——没扫成' };
  }
  const wt = runOrca(['worktree', 'ps', '--json']);
  if (!wt.ok) return { ok: false, error: `worktree ps 没查成：${fmtOrcaErr(wt.error)}` };
  const worktrees = unwrapOrcaList(wt.json, 'worktrees');
  if (!worktrees) return { ok: false, error: 'worktree ps 没有 worktrees 数组——没扫成' };

  const wl = runOrca(['orchestration', 'worker-list', '--json']);
  if (!wl.ok) return { ok: false, error: `worker-list 没查成：${fmtOrcaErr(wl.error)}` };
  const workers = unwrapOrcaList(wl.json, 'workers');
  if (!workers) return { ok: false, error: 'worker-list 没有 workers 数组——没扫成' };

  const rl = runOrca(['orchestration', 'run-list', '--json']);
  if (!rl.ok) return { ok: false, error: `run-list 没查成：${fmtOrcaErr(rl.error)}` };
  const runs = unwrapOrcaList(rl.json, 'runs');
  if (!runs) return { ok: false, error: 'run-list 没有 runs 数组——没扫成' };

  const tl = runOrca(['terminal', 'list', '--json']);
  if (!tl.ok) return { ok: false, error: `terminal list 没查成：${fmtOrcaErr(tl.error)}` };
  const terminals = unwrapOrcaList(tl.json, 'terminals') || [];

  const inbox = runOrca(['orchestration', 'inbox', '--full', '--json']);
  if (!inbox.ok) return { ok: false, error: `inbox 没查成：${fmtOrcaErr(inbox.error)}` };
  const messages = inbox.json?.result?.messages;
  if (!Array.isArray(messages)) return { ok: false, error: 'inbox 没有 result.messages 数组——没扫成' };

  const plan = planRunGc({ runs, workers, worktrees });
  if (!plan.ok) return { ok: false, error: plan.error || 'run-gc 计划没算成——没扫成' };

  const active = activeRunIds({ runs, workers, worktrees, terminals });
  const seen = readLoggedIds(join(root, logRel));
  const relevant = relevantMessages(messages, active, seen);
  const { loggable } = splitMessages(relevant);

  return {
    ok: true,
    runs,
    workers,
    worktrees,
    terminals,
    messages,
    plan,
    pendingInboxCount: loggable.length,
    activeRunCount: active.size,
  };
}

function fmtOrcaErr(err) {
  if (!err) return '未知';
  if (typeof err === 'string') return err.slice(0, 160);
  if (err.message) return String(err.message).slice(0, 160);
  if (err.code) return String(err.code).slice(0, 160);
  return JSON.stringify(err).slice(0, 160);
}

function ruleNumber(section, key, fallback) {
  const v = section?.[key]?.['值'];
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function ruleEnabled(section, key, fallback = true) {
  const v = section?.[key]?.['启用'];
  return typeof v === 'boolean' ? v : fallback;
}

export function prChecksRed(pr) {
  if (!pr || pr.isDraft) return { red: false, reason: 'draft 跳过' };
  const rollup = pr.statusCheckRollup;
  if (rollup == null) return { red: false, reason: '没查成 check，不臆测红' };
  const g = allChecksGreen(pr);
  if (g.green) return { red: false, reason: '全绿' };
  return { red: true, reason: g.reason || 'check 不绿' };
}

export function prApprovedReady(pr) {
  if (!pr || pr.isDraft) return false;
  if (String(pr.reviewDecision || '').toUpperCase() !== 'APPROVED') return false;
  return String(pr.mergeable || '').toUpperCase() === 'MERGEABLE';
}

/** 判绿但卡在 draft（manual 合门的制度类 PR 按制度就是 draft）——最需要拍板的一类，不许隐形（#730 实证）。 */
export function prApprovedDraft(pr) {
  if (!pr || !pr.isDraft) return false;
  return String(pr.reviewDecision || '').toUpperCase() === 'APPROVED';
}

export function detectAnomalies({ rules, orca, github, now = Date.now() } = {}) {
  const out = [];
  const crit = rules?.['异常判据'] || {};
  const zombieThreshold = ruleNumber(crit, '僵尸Run阈值', 5);
  const workerTimeoutMin = ruleNumber(crit, '工人超时未报完工分钟', 120);
  const inboxThreshold = ruleNumber(crit, '未读消息条数阈值', 3);
  const ciRedOn = ruleEnabled(crit, 'PR_CI红', true);
  const approvedOn = ruleEnabled(crit, '判绿待合并', true);

  if (!orca?.ok) {
    return { ok: false, error: orca?.error ? `Orca 盘面没扫成：${orca.error}` : 'Orca 盘面没扫成', anomalies: [] };
  }
  if (!github?.ok) {
    return { ok: false, error: github?.error ? `GitHub 没扫成：${github.error}` : 'GitHub 没扫成', anomalies: [] };
  }

  const zombieCount = (orca.plan?.retire || []).length;
  if (zombieCount > zombieThreshold) {
    out.push(`Orca：僵尸 Run ${zombieCount} 个（阈值 ${zombieThreshold}），手动：node scripts/dao.mjs run-gc --apply`);
  }

  if (orca.pendingInboxCount > inboxThreshold) {
    out.push(`Orca：活跃 Run 待落盘 inbox 消息 ${orca.pendingInboxCount} 条（阈值 ${inboxThreshold}）`);
  }

  for (const w of orca.workers || []) {
    if (!isLiveDispatch(w)) continue;
    const ageMin = parseWorkerAgeMinutes(w);
    if (ageMin == null) continue;
    if (ageMin > workerTimeoutMin) {
      out.push(`Orca：工人 ${w.dispatchId || '?'} 在途 ${Math.round(ageMin)} 分钟未结算（阈值 ${workerTimeoutMin} 分钟）`);
    }
  }

  for (const pr of github.prs || []) {
    if (ciRedOn) {
      const chk = prChecksRed(pr);
      if (chk.red) out.push(`GitHub：PR #${pr.number} CI 红（${chk.reason}）`);
    }
    if (approvedOn && prApprovedReady(pr)) {
      out.push(`GitHub：PR #${pr.number} 审官已绿待合并（APPROVED + MERGEABLE）`);
    }
    if (approvedOn && prApprovedDraft(pr)) {
      out.push(`GitHub：PR #${pr.number} 判绿待拍板（draft，manual 合门）`);
    }
  }

  void now;
  return { ok: true, anomalies: out };
}

export function buildRecommendations({ rules, github, orca } = {}) {
  if (!github?.ok) return { ok: false, error: github?.error || 'GitHub 没扫成', items: [] };
  const prs = github.prs || [];
  const issues = github.issues || [];
  const items = [];

  for (const pr of prs) {
    const chk = prChecksRed(pr);
    if (chk.red) {
      items.push({ priority: 'P0', kind: 'pr', number: pr.number, title: pr.title, line: `P0 PR #${pr.number} CI 红：${pr.title}` });
    }
  }
  for (const pr of prs) {
    if (prApprovedReady(pr)) {
      items.push({ priority: 'P1', kind: 'pr', number: pr.number, title: pr.title, line: `P1 PR #${pr.number} 判绿待合并：${pr.title}` });
    } else if (prApprovedDraft(pr)) {
      items.push({ priority: 'P1', kind: 'pr', number: pr.number, title: pr.title, line: `P1 PR #${pr.number} 判绿待拍板（draft，manual 合门）：${pr.title}` });
    }
  }

  const readySnap = inspectReadyQueue({
    issues,
    prs,
    worktrees: orca?.ok ? orca.worktrees : [],
  });
  if (readySnap.kind === 'ready') {
    for (const n of readySnap.ready) {
      const issue = issues.find((i) => i.number === n);
      items.push({
        priority: 'P2',
        kind: 'issue',
        number: n,
        title: issue?.title || '',
        line: `P2 issue #${n} 已消歧未派工：${issue?.title || '?'}`,
      });
    }
  }

  const usedIssues = new Set(items.filter((i) => i.kind === 'issue').map((i) => i.number));
  const usedPrs = new Set(items.filter((i) => i.kind === 'pr').map((i) => i.number));
  const p3 = issues
    .filter((i) => !usedIssues.has(i.number))
    .sort((a, b) => Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0))
    .map((i) => ({
      priority: 'P3',
      kind: 'issue',
      number: i.number,
      title: i.title,
      line: `P3 issue #${i.number}：${i.title}`,
    }));

  const merged = [...items, ...p3];
  void rules;
  void usedPrs;
  return { ok: true, items: merged };
}

/** 盘面有 P0/P1/P2 或异常即「有内容可报」（去重前）。P3 alone 不算。 */
export function hasReportableContent({ anomalies, recommendations } = {}) {
  const an = anomalies?.anomalies || [];
  if (an.length > 0) return true;
  const items = recommendations?.items || [];
  return items.some((i) => i.priority === 'P0' || i.priority === 'P1' || i.priority === 'P2');
}

/** 去重键：异常清单 + 推荐序（P0–P2，不含 P3）。 */
export function normalizeScanState({ anomalies, recommendations } = {}) {
  const anList = (anomalies?.ok ? (anomalies.anomalies || []) : []).slice().sort();
  const recItems = (recommendations?.ok ? (recommendations.items || []) : [])
    .filter((i) => i.priority === 'P0' || i.priority === 'P1' || i.priority === 'P2')
    .map((i) => ({ p: i.priority, k: i.kind, n: i.number, t: i.title || '' }))
    .sort((a, b) => {
      const po = { P0: 0, P1: 1, P2: 2 };
      const d = (po[a.p] ?? 9) - (po[b.p] ?? 9);
      if (d !== 0) return d;
      return (a.n || 0) - (b.n || 0);
    });
  return { anomalies: anList, recommendations: recItems };
}

export function hashScanState(state) {
  const body = JSON.stringify(state ?? { anomalies: [], recommendations: [] });
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

export function defaultStatePath() {
  return join(tmpdir(), DEFAULT_STATE_BASENAME);
}

/** 读不到/坏 JSON/缺 hash → firstRun（fail-open 于报）。 */
export function readLastState(path) {
  if (!path) return { ok: false, firstRun: true, reason: 'no-path' };
  try {
    const raw = readFileSync(path, 'utf8');
    const doc = JSON.parse(raw);
    if (!doc || typeof doc.hash !== 'string' || !doc.hash) {
      return { ok: false, firstRun: true, reason: 'bad-shape' };
    }
    return {
      ok: true,
      hash: doc.hash,
      at: doc.at || null,
      summary: typeof doc.summary === 'string' ? doc.summary : null,
    };
  } catch (e) {
    const code = e && e.code;
    if (code === 'ENOENT') return { ok: false, firstRun: true, reason: 'absent' };
    return { ok: false, firstRun: true, reason: 'corrupt', error: String(e.message || e).slice(0, 120) };
  }
}

export function writeLastState(path, { hash, summary, at = new Date().toISOString() } = {}) {
  if (!path || !hash) return { ok: false, error: 'writeLastState 缺 path/hash' };
  try {
    writeFileSync(path, JSON.stringify({ hash, at, summary: summary || '' }, null, 0), 'utf8');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `落盘失败：${String(e.message || e).slice(0, 120)}` };
  }
}

/** 与上一轮哈希一致 → 静默；读不到/坏掉 → 视为变化（fail-open 报）。 */
export function shouldReportByDedup(currentHash, lastState) {
  if (!lastState?.ok) return true;
  return lastState.hash !== currentHash;
}

function truncateTitle(s, max) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  return `${t.slice(0, Math.max(0, max - 1))}…`;
}

function applyTitleTemplate(tpl, vars) {
  return String(tpl || '')
    .replace(/\{number\}/g, vars.number != null ? String(vars.number) : '?')
    .replace(/\{摘要\}/g, vars.summary || '?')
    .replace(/\{title\}/g, vars.title || '?');
}

export function suggestChatTitle({ rules, anomalies, recommendations } = {}) {
  const cfg = rules?.['帅位标题建议'] || {};
  const templates = { ...DEFAULT_TITLE_TEMPLATES, ...(cfg['模板'] || {}) };
  const maxLen = Number(cfg['标题最大长度']) || DEFAULT_TITLE_MAX;
  const items = (recommendations?.ok ? (recommendations.items || []) : [])
    .filter((i) => i.priority === 'P0' || i.priority === 'P1' || i.priority === 'P2');
  const order = { P0: 0, P1: 1, P2: 2 };
  items.sort((a, b) => (order[a.priority] ?? 9) - (order[b.priority] ?? 9) || (a.number || 0) - (b.number || 0));
  if (items.length) {
    const top = items[0];
    const tpl = templates[top.priority] || DEFAULT_TITLE_TEMPLATES[top.priority];
    return truncateTitle(applyTitleTemplate(tpl, {
      number: top.number,
      title: top.title,
      summary: top.title,
    }), maxLen);
  }
  const an = anomalies?.ok ? (anomalies.anomalies || []) : [];
  if (!an.length) return null;
  const first = an[0];
  const m = first.match(/#(\d+)/);
  const short = m ? `#${m[1]}` : truncateTitle(first.replace(/^[^:]+:\s*/, ''), maxLen - 3);
  return truncateTitle(applyTitleTemplate(templates['异常'] || DEFAULT_TITLE_TEMPLATES['异常'], {
    summary: short,
    number: m ? m[1] : null,
    title: short,
  }), maxLen);
}

export function formatSummary({ anomalies, recommendations, topN = 5, titleSuggestion = null } = {}) {
  const lines = [];
  const an = anomalies?.ok ? (anomalies.anomalies || []) : [];
  if (an.length) {
    lines.push('【Orca / GitHub 异常】');
    for (const a of an) lines.push(`- ${a}`);
  } else {
    lines.push('【Orca / GitHub 异常】无');
  }
  const rec = recommendations?.ok ? (recommendations.items || []) : [];
  lines.push('');
  lines.push(`【推荐处理顺序 top ${topN}】`);
  if (!rec.length) {
    lines.push('- （无 open 待办）');
  } else {
    for (const item of rec.slice(0, topN)) lines.push(`- ${item.line}`);
  }
  if (titleSuggestion) {
    lines.push('');
    lines.push(`帅位标题建议：${titleSuggestion}`);
  }
  return lines.join('\n');
}

export function evaluateScan({ rules, orca, github } = {}) {
  const anomalies = detectAnomalies({ rules, orca, github });
  if (!anomalies.ok) return { ok: false, error: anomalies.error, wake: false };
  const recommendations = buildRecommendations({ rules, github, orca });
  if (!recommendations.ok) return { ok: false, error: recommendations.error, wake: false };
  const hasContent = hasReportableContent({ anomalies, recommendations });
  const normalizedState = normalizeScanState({ anomalies, recommendations });
  const stateHash = hashScanState(normalizedState);
  const titleSuggestion = hasContent ? suggestChatTitle({ rules, anomalies, recommendations }) : null;
  const summary = formatSummary({ anomalies, recommendations, titleSuggestion });
  return {
    ok: true,
    wake: hasContent,
    hasContent,
    stateHash,
    normalizedState,
    titleSuggestion,
    anomalies,
    recommendations,
    summary,
  };
}

/** CLI：有内容且相对上一轮有变化才输出。 */
export function decideOutput({ result, lastState } = {}) {
  if (!result?.ok) return { ok: false, error: result?.error || '扫描失败', emit: false };
  if (!result.hasContent) return { ok: true, emit: false, reason: 'empty' };
  if (!shouldReportByDedup(result.stateHash, lastState)) {
    return { ok: true, emit: false, reason: 'unchanged' };
  }
  return { ok: true, emit: true, reason: lastState?.ok ? 'changed' : 'first-run' };
}

export function buildGithubGraphqlArgs(repo) {
  const parts = repoParts(repo);
  if (!parts.ok) return parts;
  return {
    ok: true,
    args: [
      'api', 'graphql',
      '-f', `query=${GITHUB_GRAPHQL}`,
      '-f', `owner=${parts.owner}`,
      '-f', `name=${parts.name}`,
    ],
  };
}

export function parseGithubGraphqlResponse(out) {
  let doc;
  try {
    doc = JSON.parse(String(out || ''));
  } catch (e) {
    return { ok: false, error: `GraphQL 输出不是 JSON：${String(e.message || e).slice(0, 80)}` };
  }
  if (doc.errors?.length) {
    return { ok: false, error: `GraphQL 错误：${doc.errors.map((e) => e.message).join('; ').slice(0, 200)}` };
  }
  return normalizeGithubGraphql(doc.data);
}
