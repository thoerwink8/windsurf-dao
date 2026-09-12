// scripts/lib/issue-gateway.mjs —— 跨宿主唯一 GitHub Issue 写入网关（#792）
//
// 调用者只表达业务动作，不能选身份、不能传 token、不能交任意 shell。
// 内部固定 dao-marshal[bot]（ghAs marshal），写完回读作者；对不上或没查成 → 失败。
// 拿到 URL 不等于成功。凭据缺失 fail-loud，不退回个人 gh。
// 幂等账与审计落 ~/.dao/issue-gateway（不进 git，换机不拷）。

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ghAs, loadRoleCreds } from './gh.mjs';

export const ACTIONS = ['issue_create', 'issue_comment', 'issue_close', 'issue_reopen', 'issue_edit_labels'];
export const MARSHAL_LOGIN = 'dao-marshal[bot]';
export const MARSHAL_APP = 'app/dao-marshal';
export const DEFAULT_ALLOWED_REPOS = [
  'thoerwink8/windsurf-dao',
  'thoerwink8/ai-gateway-stack',
  'thoerwink8/miraquota-win',
  'thoerwink8/windsurf-dao-memory',
  // #1024：派工链 --repo 打到 bot 已装的仓时，完工评论也走网关。
  // 名单少一个仓 = 交卷被拒，看起来像派出去了、实际写不进目标仓。
  'thoerwink8/ws-cleaner',
  'thoerwink8/miraquota-ledger',
];
export const FORBIDDEN_FIELDS = [
  'identity', 'token', 'gh_token', 'GH_TOKEN', 'GITHUB_TOKEN',
  'cmd', 'command', 'shell', 'argv', 'gh', 'role',
];
export const IDEMPOTENCY_MARK = 'dao-idempotency';

const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?\/[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const KEY_RE = /^[\x21-\x7E]{1,200}$/;

export function gatewayDir({ home = homedir(), env = process.env } = {}) {
  const override = env && env.DAO_ISSUE_GATEWAY_DIR;
  if (override) return override;
  return join(home, '.dao', 'issue-gateway');
}

export function reposFromGroupsDoc(doc) {
  if (!doc || typeof doc !== 'object') {
    return { ok: false, unscanned: true, error: '群映射不是对象——没查成，不是 0 个仓库' };
  }
  const repos = [];
  for (const [k, v] of Object.entries(doc)) {
    if (k.startsWith('_')) continue;
    if (v && typeof v.repo === 'string' && REPO_RE.test(v.repo.trim())) {
      repos.push(v.repo.trim());
    }
  }
  return { ok: true, unscanned: false, repos };
}

export function loadAllowlist({ extra, groupsDoc, env = process.env } = {}) {
  const set = new Set(DEFAULT_ALLOWED_REPOS);
  if (Array.isArray(extra)) for (const r of extra) if (r) set.add(String(r).trim());
  const envList = env && env.DAO_ISSUE_GATEWAY_REPOS;
  if (envList) {
    for (const r of String(envList).split(/[,;\s]+/)) if (r) set.add(r.trim());
  }
  if (groupsDoc !== undefined) {
    const g = reposFromGroupsDoc(groupsDoc);
    if (!g.ok) return g;
    for (const r of g.repos) set.add(r);
  }
  return { ok: true, unscanned: false, repos: [...set] };
}

export function forbiddenFieldsOf(req) {
  if (!req || typeof req !== 'object') return [];
  return FORBIDDEN_FIELDS.filter((k) => Object.prototype.hasOwnProperty.call(req, k));
}

export function embedIdempotencyMarker(body, key) {
  const mark = `<!-- ${IDEMPOTENCY_MARK}:${key} -->`;
  const text = String(body || '');
  if (text.includes(mark)) return text;
  return text ? `${text.trimEnd()}\n\n${mark}\n` : `${mark}\n`;
}

export function extractIdempotencyMarker(text) {
  const m = String(text || '').match(/<!--\s*dao-idempotency:([^\s>]+)\s*-->/);
  return m ? m[1] : '';
}

export function marshalAuthorOk(author) {
  if (author == null || typeof author !== 'object') {
    return { ok: false, unscanned: true, error: '作者没读到——不是核对过没事，是没查成' };
  }
  const login = String(author.login || author.name || '').trim();
  if (!login) {
    return { ok: false, unscanned: true, error: '作者 login 空——没查成' };
  }
  const bot = author.is_bot === true
    || String(author.type || '') === 'Bot'
    || /\[bot\]$/i.test(login);
  const marshal = login === MARSHAL_LOGIN
    || login === 'dao-marshal'
    || login === MARSHAL_APP;
  if (marshal && bot) return { ok: true, unscanned: false, login };
  return {
    ok: false,
    unscanned: false,
    login,
    error: `作者是 ${login}，不是 ${MARSHAL_LOGIN}`,
  };
}

// 2026-09-12 实咬：PR 上的评论回执走的是 **pull** 形状——
// `https://github.com/o/r/pull/1211#issuecomment-5645762291`。这里原来只认 `/issues/`，
// 于是「评论已发出去、GitHub 也回了 URL」被判成 incomplete_receipt（没收到回执）。
// 危害不止是文案：idempotency 只在成功路径记账，判失败就不记账，重跑会**再发一条**，
// 而调用方拿到 ok:false 会 fail-closed 停在原地——worker-done 就卡在这一步，
// 票没写、会话没停、交卷 comment 发了一串（#1211 连发三条的由来）。
// pull 与 issues 在 GitHub 上是同一套编号与 comment id，形状收全即可。
function parseCommentLike(text) {
  const m = String(text || '').match(
    /https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/(?:issues|pull)\/(\d+)#issuecomment-(\d+)/,
  );
  if (!m) return null;
  return {
    repo: `${m[1]}/${m[2]}`,
    number: Number(m[3]),
    commentId: m[4],
    url: m[0],
  };
}

export function parseCommentUrl(text) {
  return parseCommentLike(text);
}

export function parseIssueUrl(text) {
  const m = String(text || '').match(/https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/(?:issues|pull)\/(\d+)/);
  if (!m) return null;
  return { repo: `${m[1]}/${m[2]}`, number: Number(m[3]), url: m[0] };
}

function fail(stage, error, extra = {}) {
  // ok/stage/error 必须压过 extra：写幂等账失败时会把已落 GitHub 的 result 带进来，
  // 那里面的 ok:true 不得把失败盖回成功（#1015 审官第 6 条）。
  return { ...extra, ok: false, stage, error: String(error || '失败') };
}

function storeKey(action, repo, idempotencyKey) {
  return createHash('sha256')
    .update(`${action}\n${repo}\n${idempotencyKey}`)
    .digest('hex')
    .slice(0, 32);
}

function readStore(dir, id) {
  const p = join(dir, 'idempotency', `${id}.json`);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch (e) {
    return { ok: false, stage: 'idempotency_store', error: `幂等账读损坏：${String(e.message || e).slice(0, 120)}` };
  }
}

function writeStore(dir, id, rec) {
  const folder = join(dir, 'idempotency');
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, `${id}.json`), JSON.stringify(rec), { mode: 0o600 });
}

function writeAudit(dir, rec) {
  const folder = join(dir, 'audit');
  mkdirSync(folder, { recursive: true });
  const line = JSON.stringify(rec);
  appendFileSync(join(folder, 'audit.ndjson'), `${line}\n`);
}

export function validateRequest(req = {}) {
  if (!req || typeof req !== 'object') {
    return fail('reject_input', '请求不是对象');
  }
  const forbidden = forbiddenFieldsOf(req);
  if (forbidden.length) {
    return fail('forbidden_field', `调用者不许传 ${forbidden.join('、')}（身份由网关固定 ${MARSHAL_LOGIN}）`);
  }
  const action = String(req.action || '').trim();
  if (!ACTIONS.includes(action)) {
    return fail('reject_input', `未知动作「${action || '?'}」（允许 ${ACTIONS.join('/')}）`);
  }
  const repo = String(req.repo || '').trim();
  if (!REPO_RE.test(repo)) {
    return fail('reject_input', 'repo 必须是 owner/name');
  }
  const host = String(req.host || '').trim();
  if (!host) return fail('reject_input', '要 host（发起宿主），审计少了它等于没查成');
  const key = String(req.idempotency_key || '').trim();
  if (!key) return fail('missing_idempotency', '每次写必须带 idempotency_key');
  if (!KEY_RE.test(key)) {
    return fail('missing_idempotency', 'idempotency_key 必须是 1–200 个可见字符、不能有空白');
  }
  const out = { action, repo, host, idempotency_key: key };
  if (action === 'issue_create') {
    const title = String(req.title || '').trim();
    if (!title) return fail('reject_input', 'create 要 title');
    out.title = title;
    out.body = String(req.body || '');
    out.labels = Array.isArray(req.labels) ? req.labels.map((x) => String(x)) : [];
  } else if (action === 'issue_comment') {
    const issue = String(req.issue ?? '').trim();
    if (!/^\d+$/.test(issue)) return fail('reject_input', 'comment 要 issue 号');
    if (!String(req.body || '').trim()) return fail('reject_input', 'comment 要 body');
    out.issue = issue;
    out.body = String(req.body);
  } else if (action === 'issue_close') {
    const issue = String(req.issue ?? '').trim();
    if (!/^\d+$/.test(issue)) return fail('reject_input', 'close 要 issue 号');
    out.issue = issue;
    out.reason = String(req.reason || 'completed');
    out.comment = req.comment == null ? '' : String(req.comment);
  } else if (action === 'issue_reopen') {
    const issue = String(req.issue ?? '').trim();
    if (!/^\d+$/.test(issue)) return fail('reject_input', 'reopen 要 issue 号');
    out.issue = issue;
    out.comment = req.comment == null ? '' : String(req.comment);
  } else if (action === 'issue_edit_labels') {
    const issue = String(req.issue ?? '').trim();
    if (!/^\d+$/.test(issue)) return fail('reject_input', 'edit-labels 要 issue 号');
    const add = Array.isArray(req.add) ? req.add.map((x) => String(x)) : [];
    const remove = Array.isArray(req.remove) ? req.remove.map((x) => String(x)) : [];
    if (!add.length && !remove.length) return fail('reject_input', 'edit-labels 要 add 或 remove');
    out.issue = issue;
    out.add = add;
    out.remove = remove;
  }
  return { ok: true, request: out };
}

function runMarshal(args, deps) {
  if (typeof deps.runMarshal === 'function') return deps.runMarshal(args);
  return ghAs('marshal', args, { cwd: deps.cwd });
}

function ensureCreds(deps) {
  if (typeof deps.runMarshal === 'function') return { ok: true };
  const creds = loadRoleCreds('marshal', { dir: deps.appsDir });
  if (!creds.ok) {
    return fail('creds_missing', creds.error || 'marshal 凭据没装——不许退回个人 gh');
  }
  return { ok: true, creds };
}

function parseJsonOut(r, stage, what) {
  if (!r || !r.ok) return fail(stage, `${what} 失败：${r && r.error ? r.error : '没查成'}`);
  try {
    return { ok: true, json: JSON.parse(String(r.out || '')) };
  } catch {
    return fail(stage, `${what} 返回不是 JSON——回执不完整`);
  }
}

function readIssue(repo, number, deps) {
  const r = runMarshal(['issue', 'view', String(number), '--repo', repo, '--json', 'number,url,title,state,author,labels,closedAt'], deps);
  return parseJsonOut(r, 'gh_readback', `回读 issue #${number}`);
}

function authorFromIssue(json) {
  return json && (json.author || json.user || null);
}

function performCreate(req, deps) {
  const body = embedIdempotencyMarker(req.body, req.idempotency_key);
  const args = ['issue', 'create', '--repo', req.repo, '--title', req.title, '--body', body];
  for (const l of req.labels) args.push('--label', l);
  const r = runMarshal(args, deps);
  if (!r || !r.ok) return fail('gh_write', `create 失败：${r && r.error ? r.error : '没查成'}`);
  const parsed = parseIssueUrl(r.out);
  if (!parsed || !parsed.number) {
    return fail('incomplete_receipt', `create 输出里没有 issue URL：${String(r.out || '').slice(0, 160)}`);
  }
  const viewed = readIssue(req.repo, parsed.number, deps);
  if (!viewed.ok) return { ...viewed, number: parsed.number, url: parsed.url };
  const who = marshalAuthorOk(authorFromIssue(viewed.json));
  if (who.unscanned) return fail('gh_readback', who.error, { number: parsed.number, url: parsed.url });
  if (!who.ok) {
    return fail('author_mismatch', who.error, { number: parsed.number, url: parsed.url, author: who.login });
  }
  return {
    ok: true,
    action: req.action,
    repo: req.repo,
    number: parsed.number,
    url: viewed.json.url || parsed.url,
    author: who.login,
    replay: false,
  };
}

function performComment(req, deps) {
  const body = embedIdempotencyMarker(req.body, req.idempotency_key);
  const r = runMarshal(['issue', 'comment', req.issue, '--repo', req.repo, '--body', body], deps);
  if (!r || !r.ok) return fail('gh_write', `comment 失败：${r && r.error ? r.error : '没查成'}`);
  const parsed = parseCommentUrl(r.out) || parseIssueUrl(r.out);
  if (!parsed) {
    return fail('incomplete_receipt', `comment 输出里没有 URL：${String(r.out || '').slice(0, 160)}`);
  }
  let authorJson = null;
  if (parsed.commentId) {
    const api = runMarshal(['api', `repos/${req.repo}/issues/comments/${parsed.commentId}`], deps);
    const parsedApi = parseJsonOut(api, 'gh_readback', `回读 comment ${parsed.commentId}`);
    if (!parsedApi.ok) return parsedApi;
    authorJson = parsedApi.json && (parsedApi.json.user || parsedApi.json.author);
  } else if (typeof deps.readCommentAuthor === 'function') {
    authorJson = deps.readCommentAuthor(parsed);
  }
  const who = marshalAuthorOk(authorJson);
  if (who.unscanned) return fail('gh_readback', who.error, { number: Number(req.issue), issue: req.issue, url: parsed.url });
  if (!who.ok) {
    return fail('author_mismatch', who.error, { number: Number(req.issue), issue: req.issue, url: parsed.url, author: who.login });
  }
  return {
    ok: true,
    action: req.action,
    repo: req.repo,
    number: Number(req.issue),
    commentId: parsed.commentId || null,
    url: parsed.url,
    author: who.login,
    replay: false,
  };
}

function performClose(req, deps) {
  const args = ['issue', 'close', req.issue, '--repo', req.repo];
  if (req.reason) args.push('--reason', req.reason);
  if (req.comment) args.push('--comment', embedIdempotencyMarker(req.comment, req.idempotency_key));
  const r = runMarshal(args, deps);
  if (!r || !r.ok) return fail('gh_write', `close 失败：${r && r.error ? r.error : '没查成'}`);
  const viewed = readIssue(req.repo, req.issue, deps);
  if (!viewed.ok) return viewed;
  const state = String(viewed.json.state || '').toUpperCase();
  if (!state) {
    return fail('gh_readback', 'close 后回读没有 state——没查成，不是已关闭');
  }
  if (state !== 'CLOSED') {
    return fail('incomplete_receipt', `close 后状态是 ${viewed.json.state || '?'}，不是 CLOSED`);
  }
  // close 不拿 issue.author 当写入身份：工人开的单也要能关。可验证的是状态变成 CLOSED。
  return {
    ok: true,
    action: req.action,
    repo: req.repo,
    number: Number(req.issue),
    url: viewed.json.url || null,
    state: 'CLOSED',
    replay: false,
  };
}

function performReopen(req, deps) {
  const args = ['issue', 'reopen', req.issue, '--repo', req.repo];
  if (req.comment) args.push('--comment', embedIdempotencyMarker(req.comment, req.idempotency_key));
  const r = runMarshal(args, deps);
  if (!r || !r.ok) return fail('gh_write', `reopen 失败：${r && r.error ? r.error : '没查成'}`);
  const viewed = readIssue(req.repo, req.issue, deps);
  if (!viewed.ok) return viewed;
  const state = String(viewed.json.state || '').toUpperCase();
  if (!state) {
    return fail('gh_readback', 'reopen 后回读没有 state——没查成，不是已重开');
  }
  if (state !== 'OPEN') {
    return fail('incomplete_receipt', `reopen 后状态是 ${viewed.json.state || '?'}，不是 OPEN`);
  }
  return {
    ok: true,
    action: req.action,
    repo: req.repo,
    number: Number(req.issue),
    url: viewed.json.url || null,
    state: 'OPEN',
    replay: false,
  };
}

function performEditLabels(req, deps) {
  const args = ['issue', 'edit', req.issue, '--repo', req.repo];
  for (const l of req.add) args.push('--add-label', l);
  for (const l of req.remove) args.push('--remove-label', l);
  const r = runMarshal(args, deps);
  if (!r || !r.ok) return fail('gh_write', `edit-labels 失败：${r && r.error ? r.error : '没查成'}`);
  const viewed = readIssue(req.repo, req.issue, deps);
  if (!viewed.ok) return viewed;
  const names = Array.isArray(viewed.json.labels)
    ? viewed.json.labels.map((x) => (typeof x === 'string' ? x : x && x.name)).filter(Boolean)
    : null;
  if (!names) return fail('gh_readback', '回读 labels 没查成');
  for (const l of req.add) {
    if (!names.includes(l)) return fail('incomplete_receipt', `打了 ${l} 但回读没有`);
  }
  for (const l of req.remove) {
    if (names.includes(l)) return fail('incomplete_receipt', `删了 ${l} 但回读还在`);
  }
  return {
    ok: true,
    action: req.action,
    repo: req.repo,
    number: Number(req.issue),
    url: viewed.json.url || null,
    labels: names,
    replay: false,
  };
}

function perform(req, deps) {
  switch (req.action) {
    case 'issue_create': return performCreate(req, deps);
    case 'issue_comment': return performComment(req, deps);
    case 'issue_close': return performClose(req, deps);
    case 'issue_reopen': return performReopen(req, deps);
    case 'issue_edit_labels': return performEditLabels(req, deps);
    default: return fail('reject_input', `未知动作 ${req.action}`);
  }
}

/**
 * 唯一写入入口。deps.runMarshal 注入假 gh（测试）；不传则 loadRoleCreds(marshal)+ghAs。
 * 绝不读个人 GH_TOKEN 去 spawn 裸 gh。
 */
export function applyIssueWrite(raw, deps = {}) {
  const dir = deps.dir || gatewayDir({ home: deps.home, env: deps.env });
  const started = (deps.now || Date.now)();
  const auditBase = {
    ts: new Date(started).toISOString(),
    host: raw && raw.host || null,
    action: raw && raw.action || null,
    idempotency_key: raw && raw.idempotency_key || null,
    repo: raw && raw.repo || null,
    bot: MARSHAL_LOGIN,
  };
  const finish = (result) => {
    const rec = {
      ...auditBase,
      ok: !!result.ok,
      stage: result.stage || (result.ok ? 'ok' : 'failed'),
      error: result.error || null,
      url: result.url || null,
      number: result.number || null,
      replay: !!result.replay,
      author: result.author || null,
    };
    try {
      writeAudit(dir, rec);
    } catch (e) {
      const err = `审计写失败：${String(e.message || e).slice(0, 120)}`;
      if (result.ok || result.number) {
        return {
          ...result,
          ok: false,
          stage: 'audit',
          error: `${err}；对象可能已落 GitHub${result.url ? `（${result.url}）` : ''}，需人工按 URL 处置`,
          audit: rec,
        };
      }
      return { ...result, ok: false, audit: rec, auditError: err };
    }
    return { ...result, audit: rec };
  };

  const v = validateRequest(raw);
  if (!v.ok) return finish(v);
  const req = v.request;
  auditBase.host = req.host;
  auditBase.action = req.action;
  auditBase.idempotency_key = req.idempotency_key;
  auditBase.repo = req.repo;

  const allow = loadAllowlist({ extra: deps.extraRepos, groupsDoc: deps.groupsDoc, env: deps.env });
  if (!allow.ok) return finish(fail('allowlist', allow.error || '允许列表没查成'));
  if (!allow.repos.includes(req.repo)) {
    return finish(fail('allowlist', `仓库 ${req.repo} 不在允许列表`));
  }

  const id = storeKey(req.action, req.repo, req.idempotency_key);
  const hit = readStore(dir, id);
  if (hit && hit.ok === false && hit.stage === 'idempotency_store') return finish(hit);
  if (hit && hit.result && (hit.result.ok || hit.result.number)) {
    return finish({ ...hit.result, replay: true });
  }

  const creds = ensureCreds(deps);
  if (!creds.ok) return finish(creds);

  const result = perform(req, deps);
  // 已经落到 GitHub 对象（有 number）就必须记账，哪怕后续回读失败——
  // 否则同一幂等键重放会再建一张（本次真实验收 closedBy 字段踩过）。
  if (result.ok || result.number) {
    try {
      writeStore(dir, id, { ok: true, at: auditBase.ts, result: { ...result, replay: false } });
    } catch (e) {
      return finish(fail(
        'idempotency_store',
        `幂等账写失败：${String(e.message || e).slice(0, 120)}；对象已落 GitHub${result.url ? `（${result.url}）` : ''}，需人工按 URL 处置`,
        { number: result.number, url: result.url, author: result.author, landed: true },
      ));
    }
  }
  return finish(result);
}

export function issueCreate(fields, deps) {
  return applyIssueWrite({ ...fields, action: 'issue_create' }, deps);
}
export function issueComment(fields, deps) {
  return applyIssueWrite({ ...fields, action: 'issue_comment' }, deps);
}
export function issueClose(fields, deps) {
  return applyIssueWrite({ ...fields, action: 'issue_close' }, deps);
}
export function issueReopen(fields, deps) {
  return applyIssueWrite({ ...fields, action: 'issue_reopen' }, deps);
}
export function issueEditLabels(fields, deps) {
  return applyIssueWrite({ ...fields, action: 'issue_edit_labels' }, deps);
}
