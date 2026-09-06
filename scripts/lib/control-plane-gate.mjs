// 控制面闸（#948）：会话在跑 ≠ 帅位能接管。
//
// 改这段代码前必须知道的五条：
//
// 1. 现场是反过来的静默。liveness / routeSilent / board-gc 判的是「没有推进」；
//    本闸要拦的是「还在跑、还能 git push / 部署，只是 Remote Control 400、帅接管不上」。
//    把进程杀掉抓不住「活着但失控」——要拦的是对外写，不是人。
//
// 2. 三态不许压成两态。reachable / unreachable / unscanned。
//    探测自己失败（文件不在 / JSON 坏了 / 字段对不上 / 环境变量是垃圾）一律 unscanned，
//    **绝不许当成断了**。当成断了的方向是一次网络抖动锁死整条链（2026-09-05 拍板否决硬闸
//    的理由；2026-09-07 5A 允许上闸的前提就是这条分得开）。
//
// 3. 只拦对外写。git commit / status / log / add 以及只读，无论控制面状态都不拦。
//    整条命令里只要有一句是 git push / 部署，整条按对外写判（`echo x && git push` 必须拦）。
//
// 4. 本文件是纯函数 + 只读探头。不写控制面状态文件、不打网络、不 spawn。
//    谁要在这里加 spawnSync，必须带 windowsHide: true。
//    挂载面复用派工闸入口（dispatch-gate-hook / cursor-dispatch-gate-hook），
//    判定逻辑只此一份——那边只问 decideControlPlane，不复制分类。
//
// 5. 崩了由调用方 fail-closed（dispatch-gate 的 catch → Claude exit 2 / Cursor deny）。
//    本文件抛出 = 没查成的反面：闸自己坏了，跟「探测没查成」不是同一件事，
//    不许在这里吞掉再放行。

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 仓外落点（登记 host/machine/INDEX.md）。缺失 / 坏 JSON = 没查成，不拦。 */
export const CONTROL_PLANE_REL = ['.dao', 'control-plane.json'];

export const BLOCK_HINT = [
  '控制面明确不可达（reachable=false）。只读和本地提交不拦。',
  '重连控制面后再推 / 再部署。探测没查成不会走这条（没查成 ≠ 断了）。',
].join('');

export const UNSCANNED_HINT = '没查成 ≠ 断了';

const EVIDENCE_KEYS = ['session_id', 'task_id', 'dispatch_id', 'commit'];

const SKIP_WRAPPERS = new Set(['sudo', 'command', 'time', 'env', 'nice', 'nohup', 'npx', 'pnpx']);

const LOCAL_GIT = new Set([
  'commit', 'status', 'log', 'diff', 'show', 'add', 'restore', 'switch',
  'checkout', 'branch', 'stash', 'tag', 'rev-parse', 'describe', 'ls-files',
  'blame', 'shortlog', 'config', 'init', 'mv', 'rm', 'reset', 'cherry-pick',
  'rebase', 'merge', 'fetch', 'pull', 'clone', 'remote', 'submodule', 'notes',
  'reflog', 'fsck', 'gc', 'grep', 'shortlog', 'whatchanged', 'archive',
  'bundle', 'cat-file', 'check-ignore', 'count-objects', 'for-each-ref',
  'format-patch', 'hash-object', 'ls-tree', 'merge-base', 'name-rev',
  'rev-list', 'show-ref', 'symbolic-ref', 'update-index', 'version', 'help',
  'var', 'worktree',
]);

const GIT_VALUE_OPTS = new Set([
  '-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env',
  '--shallow-file', '--super-prefix',
]);

// ── 命令分类 ────────────────────────────────────────────────────────

export function normalizeCmd(cmd) {
  return String(cmd || '').replace(/\s+/g, ' ').trim();
}

/**
 * 把一条 shell 命令拆成会真跑起来的语句。
 * 与 dispatch-gate 同形，不互相 import（避免环：那边要问本文件的判定）。
 */
export function splitShellStatements(cmd) {
  const s = String(cmd || '');
  const parts = [];
  let buf = '';
  let quote = null;
  let escaped = false;
  const flush = () => {
    const t = stripUnquotedComment(buf).trim();
    if (t) parts.push(t);
    buf = '';
  };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (escaped) { buf += c; escaped = false; continue; }
    if (quote) {
      if (c === '\\' && quote !== "'") { escaped = true; buf += c; continue; }
      if (c === quote) quote = null;
      buf += c;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; buf += c; continue; }
    if (c === '\\') { escaped = true; buf += c; continue; }
    if (c === '\n' || c === '\r' || c === ';') { flush(); continue; }
    if (c === '&' && s[i + 1] === '&') { flush(); i++; continue; }
    if (c === '|' && s[i + 1] === '|') { flush(); i++; continue; }
    if (c === '|') { flush(); continue; }
    buf += c;
  }
  flush();
  return parts;
}

function stripUnquotedComment(stmt) {
  let quote = null;
  let escaped = false;
  for (let i = 0; i < stmt.length; i++) {
    const c = stmt[i];
    if (escaped) { escaped = false; continue; }
    if (quote) {
      if (c === '\\' && quote !== "'") { escaped = true; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '#') return stmt.slice(0, i);
  }
  return stmt;
}

export function tokenizeShell(stmt) {
  const s = String(stmt || '');
  const tokens = [];
  let buf = '';
  let quote = null;
  let escaped = false;
  let quoted = false;
  const flush = () => {
    if (buf.length || quoted) tokens.push({ value: buf, quoted });
    buf = '';
    quoted = false;
  };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (escaped) { buf += c; escaped = false; continue; }
    if (quote) {
      if (c === '\\' && quote !== "'") { escaped = true; continue; }
      if (c === quote) { quote = null; continue; }
      buf += c;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; quoted = true; continue; }
    if (c === '\\') { escaped = true; continue; }
    if (/\s/.test(c)) { flush(); continue; }
    buf += c;
  }
  flush();
  return tokens;
}

function bareTokens(stmt) {
  return tokenizeShell(stmt)
    .filter((t) => !t.quoted && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(t.value))
    .map((t) => t.value);
}

function basename(tok) {
  const s = String(tok || '').replace(/\\/g, '/');
  const cut = s.lastIndexOf('/');
  return (cut >= 0 ? s.slice(cut + 1) : s).toLowerCase();
}

function skipWrappers(toks) {
  let i = 0;
  while (i < toks.length && SKIP_WRAPPERS.has(basename(toks[i]).replace(/\.(exe|cmd)$/i, ''))) {
    i += 1;
    while (i < toks.length && toks[i].startsWith('-')) i += 1;
  }
  return toks.slice(i);
}

function gitSubcommand(toks) {
  let i = 1;
  while (i < toks.length) {
    const t = toks[i];
    if (t === '--') return toks[i + 1] || '';
    if (t.startsWith('-')) {
      const opt = t.includes('=') ? t.slice(0, t.indexOf('=')) : t;
      if (GIT_VALUE_OPTS.has(opt) && !t.includes('=')) { i += 2; continue; }
      i += 1;
      continue;
    }
    return t;
  }
  return '';
}

function hasFlag(toks, name) {
  return toks.some((t) => t === name || t.startsWith(`${name}=`));
}

function isLandMjs(toks) {
  return toks.some((t) => /(^|[\\/])land\.mjs$/i.test(t));
}

/** 未加引号的 token 流里有 git … push（含 -C / 套在 dao.mjs raw -- 后面的）。 */
function hasGitPushTokens(toks) {
  for (let i = 0; i < toks.length; i++) {
    const b = basename(toks[i]).replace(/\.(exe|cmd)$/i, '');
    if (b !== 'git') continue;
    if (gitSubcommand(toks.slice(i)) === 'push') return true;
  }
  return false;
}

/**
 * 一句是对外写 / 本地或只读 / 其他。
 * 其他（npm test、gh pr create）不是本闸的射程——不拦。
 */
export function classifyStatement(stmt) {
  const toks = skipWrappers(bareTokens(stmt));
  if (!toks.length) return 'other';
  if (hasGitPushTokens(toks)) return 'outbound';
  const base = basename(toks[0]).replace(/\.(exe|cmd)$/i, '');

  if (base === 'git') {
    const sub = gitSubcommand(toks);
    if (sub === 'push') return 'outbound';
    if (LOCAL_GIT.has(sub)) return 'local';
    return 'other';
  }

  if (base === 'docker' || base === 'podman') {
    const sub = toks.find((t, i) => i > 0 && !t.startsWith('-')) || '';
    if (sub === 'push') return 'outbound';
    return 'other';
  }

  if (base === 'npm' || base === 'pnpm' || base === 'yarn') {
    if (toks.includes('publish')) return 'outbound';
    return 'other';
  }

  if (base === 'wrangler' || base === 'vercel' || base === 'fly' || base === 'flyctl') {
    if (toks.includes('deploy') || hasFlag(toks, '--prod')) return 'outbound';
    return 'other';
  }

  if (base === 'helm') {
    const sub = toks.find((t, i) => i > 0 && !t.startsWith('-')) || '';
    if (sub === 'upgrade' || sub === 'install') return 'outbound';
    return 'other';
  }

  if (base === 'kubectl') {
    const sub = toks.find((t, i) => i > 0 && !t.startsWith('-')) || '';
    if (sub === 'apply' || sub === 'create' || sub === 'replace' || sub === 'rollout') return 'outbound';
    return 'other';
  }

  if (base === 'terraform' && toks.includes('apply')) return 'outbound';

  if (base === 'gh' && toks[1] === 'release' && (toks[2] === 'create' || toks[2] === 'upload')) {
    return 'outbound';
  }

  if (isLandMjs(toks)) {
    if (hasFlag(toks, '--dry-run') || hasFlag(toks, '--has-work')) return 'local';
    return 'outbound';
  }

  if (base === 'deploy' || base === 'deploy.sh' || base === 'deploy.ps1') return 'outbound';
  if (base === 'make' && (toks[1] === 'deploy' || toks[1] === 'release')) return 'outbound';

  return 'other';
}

/**
 * 整条命令的种类：任何一句 outbound ⇒ outbound；否则全是 local ⇒ local；其余 other。
 */
export function classifyCommand(cmd) {
  const statements = splitShellStatements(cmd);
  const parts = statements.length ? statements : [String(cmd || '')];
  let sawLocal = false;
  let sawOther = false;
  for (const stmt of parts) {
    const kind = classifyStatement(stmt);
    if (kind === 'outbound') return { kind: 'outbound', command: normalizeCmd(cmd) };
    if (kind === 'local') sawLocal = true;
    else sawOther = true;
  }
  if (sawLocal && !sawOther) return { kind: 'local', command: normalizeCmd(cmd) };
  return { kind: 'other', command: normalizeCmd(cmd) };
}

export function isOutboundWrite(cmd) {
  return classifyCommand(cmd).kind === 'outbound';
}

export function isLocalOrReadOnly(cmd) {
  return classifyCommand(cmd).kind === 'local';
}

// ── 三态探测 ────────────────────────────────────────────────────────

const UNREACHABLE_WORDS = new Set(['unreachable', 'down', 'false', '0', 'no']);
const REACHABLE_WORDS = new Set(['reachable', 'up', 'true', '1', 'yes']);
const UNSCANNED_WORDS = new Set(['unscanned', 'unknown', 'missing', 'unset', '']);

export function parseProbeText(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return { state: 'unscanned', why: '探测输入是空的——没查成，不是断了' };
  const word = s.toLowerCase();
  if (UNREACHABLE_WORDS.has(word)) return { state: 'unreachable', why: `探测字面量 ${word}` };
  if (REACHABLE_WORDS.has(word)) return { state: 'reachable', why: `探测字面量 ${word}` };
  if (UNSCANNED_WORDS.has(word)) return { state: 'unscanned', why: `探测字面量 ${word || '空'}` };
  if (s.startsWith('{') || s.startsWith('[')) return parseProbeJson(s);
  return { state: 'unscanned', why: `探测字面量认不出（${s.slice(0, 40)}）——没查成，不是断了` };
}

export function parseProbeJson(text) {
  let doc;
  try {
    doc = JSON.parse(String(text ?? '').replace(/^\uFEFF/, ''));
  } catch (e) {
    return { state: 'unscanned', why: `控制面状态不是 JSON：${String(e.message || e).slice(0, 80)}` };
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return { state: 'unscanned', why: '控制面状态顶层不是对象——没查成，不是断了' };
  }
  if (!Object.prototype.hasOwnProperty.call(doc, 'reachable')) {
    return { state: 'unscanned', why: '控制面状态缺 reachable 字段——没查成，不是断了' };
  }
  if (doc.reachable === true) {
    return { state: 'reachable', why: 'reachable=true', source: doc.source || null };
  }
  if (doc.reachable === false) {
    return {
      state: 'unreachable',
      why: doc.error ? `reachable=false：${String(doc.error).slice(0, 80)}` : 'reachable=false',
      source: doc.source || null,
    };
  }
  return { state: 'unscanned', why: `reachable 不是布尔（${typeof doc.reachable}）——没查成，不是断了` };
}

/**
 * 现场探头：环境变量优先，否则读 ~/.dao/control-plane.json。
 * 文件不在 / 读不了 / JSON 坏 = unscanned。不打网络。
 */
export function probeControlPlane({
  env = process.env,
  home = homedir(),
  readFile = readFileSync,
  exists = existsSync,
} = {}) {
  const crash = env && (env.CONTROL_PLANE_GATE_CRASH === '1' || env.CONTROL_PLANE_GATE_CRASH === 'true');
  if (crash) throw new Error('control-plane-gate 故意崩（CONTROL_PLANE_GATE_CRASH）');

  if (env && env.DAO_CONTROL_PLANE != null && String(env.DAO_CONTROL_PLANE) !== '') {
    return { ...parseProbeText(env.DAO_CONTROL_PLANE), via: 'env' };
  }

  const file = (env && env.DAO_CONTROL_PLANE_FILE)
    || join(home, ...CONTROL_PLANE_REL);
  try {
    if (typeof exists === 'function' && !exists(file)) {
      return { state: 'unscanned', why: `${file} 不在——没查成，不是断了`, via: 'file', file };
    }
    const text = readFile(file, 'utf8');
    return { ...parseProbeJson(text), via: 'file', file };
  } catch (e) {
    return {
      state: 'unscanned',
      why: `控制面状态读不了：${String(e && e.message ? e.message : e).slice(0, 80)}——没查成，不是断了`,
      via: 'file',
      file,
    };
  }
}

// ── 证据 ────────────────────────────────────────────────────────────

export function collectEvidence({ env = {}, event = null, commit = null } = {}) {
  const ev = event && typeof event === 'object' ? event : {};
  const session = firstNonEmpty(
    env.CLAUDE_SESSION_ID,
    env.DAO_SESSION_ID,
    ev.session_id,
    ev.sessionId,
    ev.conversation_id,
  );
  const task = firstNonEmpty(env.DAO_TASK_ID, ev.task_id, ev.taskId);
  const dispatch = firstNonEmpty(env.DAO_DISPATCH_ID, ev.dispatch_id, ev.dispatchId);
  const sha = firstNonEmpty(commit, env.DAO_COMMIT, ev.commit);
  return {
    session_id: session || '',
    task_id: task || '',
    dispatch_id: dispatch || '',
    commit: sha || '',
  };
}

function firstNonEmpty(...vals) {
  for (const v of vals) {
    if (v == null) continue;
    const s = String(v).trim();
    if (s) return s;
  }
  return '';
}

export function formatEvidence(evidence = {}) {
  return EVIDENCE_KEYS.map((k) => `${k}=${evidence[k] ? String(evidence[k]) : '—'}`).join(' ');
}

export function formatBlockMessage({ cmd, evidence } = {}) {
  return [
    `拦下失控会话的对外写：${normalizeCmd(cmd)}`,
    BLOCK_HINT,
    formatEvidence(evidence),
  ].join('\n');
}

export function formatUnscannedNote({ cmd, evidence } = {}) {
  return [
    `${UNSCANNED_HINT}；本条对外写未拦（${normalizeCmd(cmd)}）。`,
    formatEvidence(evidence),
  ].join(' ');
}

// ── 判定 ────────────────────────────────────────────────────────────

/**
 * @param {{cmd:string, probe?:{state:string, why?:string}, evidence?:object}} arg
 * @returns {{block:boolean, kind:string, state:string, message?:string, note?:string, evidence:object}}
 */
export function decideControlPlane({ cmd = '', probe = null, evidence = null } = {}) {
  const classified = classifyCommand(cmd);
  const ev = evidence && typeof evidence === 'object' ? evidence : collectEvidence({});
  const probeState = probe && typeof probe === 'object' ? probe : { state: 'unscanned', why: '没给探测结果' };
  const state = probeState.state || 'unscanned';

  if (classified.kind !== 'outbound') {
    return { block: false, kind: classified.kind, state, evidence: ev };
  }

  if (state === 'unreachable') {
    return {
      block: true,
      kind: 'outbound',
      state,
      evidence: ev,
      message: formatBlockMessage({ cmd, evidence: ev }),
    };
  }

  if (state === 'unscanned') {
    return {
      block: false,
      kind: 'outbound',
      state,
      evidence: ev,
      note: formatUnscannedNote({ cmd, evidence: ev }),
    };
  }

  return { block: false, kind: 'outbound', state: 'reachable', evidence: ev };
}
