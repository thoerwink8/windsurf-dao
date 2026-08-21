// 守卫自停留痕（#683）。
//
// 改这段前必须知道：#665 落后自停是正确 fail-close，但原来只 stderr 就 exit 4，
// 三台守卫可以全静默死掉。本层在 halt 当时写 ~/.dao/guard/halt.jsonl，再经
// dao-watchdog[bot] 报 GitHub。没凭据 / 评论列表没扫成 = 落盘记失败，不许当报成功。
// 测试默认不写本机、不打网（NODE_TEST_CONTEXT）；夹具设 DAO_GUARD_HALT_DIR。

import { appendFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  ACCIDENT_KEY_PREFIX,
  COMMENT_HEAD,
  formatWatchdogComment,
  parseAccidentKeysFromComments,
  scanCommentsOut,
  defaultLoadCreds,
  defaultRunGh,
} from './watchdog-report.mjs';

export const HALT_ISSUE_TITLE = '【看门狗】守卫自停';
export const HALT_FILE_NAME = 'halt.jsonl';

export function defaultHaltDir({ env = process.env, homedir: home = homedir() } = {}) {
  if (env.DAO_GUARD_HALT_DIR) return env.DAO_GUARD_HALT_DIR;
  return join(home, '.dao', 'guard');
}

export function haltLogPath(opts = {}) {
  return join(defaultHaltDir(opts), HALT_FILE_NAME);
}

export function shouldPersistHalt({ env = process.env } = {}) {
  if (env.DAO_GUARD_SKIP_HALT_RECORD === '1') return false;
  if (env.DAO_GUARD_HALT_DIR) return true;
  if (env.DAO_GUARD_FORCE_HALT_NOTIFY === '1') return true;
  if (env.NODE_TEST_CONTEXT) return false;
  return true;
}

export function shouldReportHalt({ env = process.env } = {}) {
  if (env.DAO_GUARD_SKIP_HALT_REPORT === '1') return false;
  if (env.DAO_GUARD_FORCE_HALT_NOTIFY === '1') return true;
  if (env.NODE_TEST_CONTEXT) return false;
  return true;
}

function shortSha(sha) {
  return sha ? String(sha).slice(0, 12) : '?';
}

function tagKind(tag) {
  const s = String(tag || 'STALE_CODE');
  const m = s.match(/\[([^\]]+)\]/);
  if (m) return m[1].trim();
  return s.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-|-$/g, '') || 'guard';
}

/** 同一守卫 + 同一落后/查不成原因去重。sha 变了是新事故。 */
export function haltAccidentKey(record = {}) {
  const kind = tagKind(record.tag);
  const rev = record.rev || {};
  const state = rev.state || 'unknown';
  const id = state === 'behind'
    ? shortSha(rev.startupSha)
    : String(rev.reason || 'unknown').slice(0, 80).replace(/\s+/g, ' ');
  return `guard-halt|${kind}|${state}|${id}`;
}

export function persistHalt(record, {
  env = process.env,
  homedir: home = homedir(),
  mkdir = mkdirSync,
  append = appendFileSync,
  now = () => new Date().toISOString(),
} = {}) {
  if (!shouldPersistHalt({ env })) return { skipped: 'gate' };
  const dir = defaultHaltDir({ env, homedir: home });
  mkdir(dir, { recursive: true });
  const path = join(dir, HALT_FILE_NAME);
  const line = JSON.stringify({
    at: record.at || now(),
    tag: record.tag || 'STALE_CODE',
    message: record.message || '',
    pid: record.pid || process.pid,
    key: haltAccidentKey(record),
    rev: record.rev
      ? {
        state: record.rev.state,
        behind: record.rev.behind,
        startupSha: record.rev.startupSha,
        originSha: record.rev.originSha,
        reason: record.rev.reason,
      }
      : null,
    github: record.github || null,
  });
  append(path, `${line}\n`, 'utf8');
  return { ok: true, path };
}

export function parseHaltIssueList(listed) {
  if (!listed || listed.ok !== true) {
    return { scanned: false, error: `自停台账 issue 列表没查成：${listed?.error || '未知'}——不是 0 条，是没扫成`, issues: [] };
  }
  const raw = listed.out;
  if (raw == null || String(raw).trim() === '') {
    return { scanned: false, error: '自停台账 issue 列表输出空——不是 0 条，是没扫成', issues: [] };
  }
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch {
    return { scanned: false, error: '自停台账 issue 列表不是 JSON——不是 0 条，是没扫成', issues: [] };
  }
  if (!Array.isArray(parsed)) {
    return { scanned: false, error: '自停台账 issue 列表不是数组——不是 0 条，是没扫成', issues: [] };
  }
  const issues = parsed.filter((i) => i && i.title === HALT_ISSUE_TITLE);
  return { scanned: true, issues, count: parsed.length };
}

export function haltIssueBody() {
  return [
    COMMENT_HEAD,
    '守卫落后自停 / 查不成 / keepalive 循环死亡的台账。新事故在本 issue 留评论，同一事故键不刷。',
    '本机留痕：~/.dao/guard/halt.jsonl',
    '不要关这张单：关了下一次自停会再开一张。',
  ].join('\n');
}

function parseCreatedIssueNumber(out) {
  const s = String(out || '');
  const m = s.match(/\/issues\/(\d+)/) || s.match(/"number"\s*:\s*(\d+)/);
  return m ? Number(m[1]) : null;
}

function postHaltComment({ record, number, key, now, runGh }) {
  const listed = runGh(['api', `repos/{owner}/{repo}/issues/${number}/comments`, '--paginate', '--slurp']);
  const scan = scanCommentsOut(listed);
  if (!scan.scanned) {
    return { ok: false, error: scan.error };
  }
  if (scan.keys.includes(key)) {
    return { ok: true, deduped: true, number };
  }
  const body = formatWatchdogComment({
    name: '守卫',
    detail: record.message || '',
    at: now,
    key,
    worktreeId: 'guard',
  });
  const posted = runGh(['issue', 'comment', String(number), '--body', body]);
  if (!posted.ok) {
    return { ok: false, error: posted.error || 'gh 失败' };
  }
  return { ok: true, number, posted: true };
}

/**
 * 找到或创建「【看门狗】守卫自停」台账 issue，再按事故键去重写评论。
 * 列表没扫成不得 create（会重复开单）。
 */
export function reportGuardHalt(record, {
  env = process.env,
  now = Date.now(),
  runGh = defaultRunGh,
  loadCreds,
} = {}) {
  if (!shouldReportHalt({ env })) return { skipped: 'gate' };

  const creds = loadCreds
    ? loadCreds()
    : (env.WATCHDOG_GH_AS ? { ok: true } : defaultLoadCreds());
  if (!creds.ok) {
    return { ok: false, error: creds.error || '缺凭据' };
  }

  const key = haltAccidentKey(record);
  const listed = runGh([
    'issue', 'list',
    '--search', `${HALT_ISSUE_TITLE} in:title`,
    '--state', 'open',
    '--limit', '20',
    '--json', 'number,title,state',
  ]);
  const scan = parseHaltIssueList(listed);
  if (!scan.scanned) {
    return { ok: false, error: scan.error };
  }

  let number = scan.issues[0]?.number;
  if (!number) {
    const created = runGh([
      'issue', 'create',
      '--title', HALT_ISSUE_TITLE,
      '--body', haltIssueBody(),
    ]);
    if (!created.ok) {
      return { ok: false, error: `开自停台账失败：${created.error || 'gh 失败'}` };
    }
    number = parseCreatedIssueNumber(created.out);
    if (!number) {
      return { ok: false, error: '开自停台账成功但读不出 issue 号——不是写成功' };
    }
  }

  const posted = postHaltComment({ record, number, key, now, runGh });
  if (!posted.ok) return posted;
  return { ok: true, key, ...posted };
}

/** haltIfStale 的默认副作用：报 GitHub（可跳过）再落盘；失败写进同一条 jsonl，不另起一行。 */
export function notifyGuardHalt(record, opts = {}) {
  const env = opts.env || process.env;
  let github = null;
  if (shouldReportHalt({ env })) {
    github = reportGuardHalt(record, opts);
  }
  const persist = persistHalt({
    ...record,
    github: github && !github.skipped
      ? {
        ok: github.ok === true,
        error: github.error || null,
        number: github.number || null,
        deduped: !!github.deduped,
      }
      : null,
  }, opts);
  return { persist, github };
}

export function readHaltLog(path, { read = readFileSync, exists = existsSync } = {}) {
  if (!exists(path)) return { scanned: true, records: [], count: 0, missing: true };
  const text = read(path, 'utf8');
  const records = [];
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { records.push(JSON.parse(line)); }
    catch {
      return { scanned: false, error: 'halt.jsonl 有不是 JSON 的行——没查成', records, count: records.length };
    }
  }
  return { scanned: true, records, count: records.length };
}

export { parseAccidentKeysFromComments, ACCIDENT_KEY_PREFIX, COMMENT_HEAD };
