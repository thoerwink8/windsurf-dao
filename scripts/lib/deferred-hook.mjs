#!/usr/bin/env node

// Claude Code hook 入口（#583）。
// Stop：从 stdin 拿 session_id / transcript_path，自己去读 transcript 尾部 assistant，
//       扫 [[挂账:]] 写入 DEFERRED.md。stdin 当正文用是错的——实测 Stop stdin 不含回复。
// 写法提醒 / 增量播报由 board-hook 调 promptLines（UserPromptSubmit 只挂一条，
// 避免和盘面 hook 互相拖超时）。本文件也可被单独以 UserPromptSubmit 跑，方便单测。
// 只报不拦：永远 exit 0。崩了也不挡会话（拦会话的教训见 memory ralph-loop-disabled）。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  LEDGER_REL,
  REMINDER,
  applyMarks,
  extractMarks,
  formatDelta,
  hasDelta,
  lastAssistantText,
  parseLedger,
  projectSlug,
  serializeLedger,
} from './deferred.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const FALLBACK_ROOT = join(SCRIPT_DIR, '..', '..');

function readStdinSync() {
  try {
    if (process.stdin.isTTY) return '';
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function homeDir(env) {
  return env.USERPROFILE || env.HOME || '';
}

function projectRoot(env) {
  return env.CLAUDE_PROJECT_DIR ? String(env.CLAUDE_PROJECT_DIR) : FALLBACK_ROOT;
}

function statePath(_raw, env) {
  // 状态按项目根分，不按 cwd：Stop 的 cwd 和 UserPromptSubmit 可能不一致。
  const slug = projectSlug(projectRoot(env)) || 'unknown';
  return join(homeDir(env), '.claude', 'deferred', `${slug}.json`);
}

function loadState(raw, env) {
  const p = statePath(raw, env);
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return {};
  }
}

function saveState(raw, env, doc) {
  const p = statePath(raw, env);
  try {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, `${JSON.stringify(doc)}\n`, 'utf8');
  } catch {
    /* 状态写不进不挡会话 */
  }
}

/** 正文只从 transcript 来。stdin 里即便有 prompt/text 也当没看见。 */
export function resolveTranscriptPath(raw, env) {
  if (raw && raw.transcript_path && existsSync(raw.transcript_path)) {
    return { path: raw.transcript_path, how: 'transcript_path' };
  }
  const sid = raw && raw.session_id;
  if (!sid) return { path: '', how: 'no-session', error: 'stdin 没有 session_id，也没有可用的 transcript_path' };
  const cwd = (raw && raw.cwd) || projectRoot(env);
  const home = homeDir(env);
  if (!home) return { path: '', how: 'no-home', error: 'HOME/USERPROFILE 为空，拼不出 transcript 路径' };
  const p = join(home, '.claude', 'projects', projectSlug(cwd), `${sid}.jsonl`);
  if (!existsSync(p)) return { path: p, how: 'session_id', error: `transcript 不在：${p}` };
  return { path: p, how: 'session_id' };
}

function loadTranscript(raw, env) {
  const r = resolveTranscriptPath(raw, env);
  if (!r.path || r.error) return { text: '', error: r.error || '没有 transcript' };
  try {
    return { text: readFileSync(r.path, 'utf8'), path: r.path, how: r.how };
  } catch (e) {
    return { text: '', error: `读 transcript 失败：${String(e.message || e).slice(0, 80)}` };
  }
}

export function harvestFromTranscript(jsonl, ledgerText, { now = '', lastUuid = '' } = {}) {
  const last = lastAssistantText(jsonl);
  if (last.uuid && last.uuid === lastUuid) {
    return { skipped: true, reason: 'same-uuid', delta: null, ledgerText, lastUuid };
  }
  const marks = extractMarks(last.text);
  const parsed = parseLedger(ledgerText);
  const { doc, delta } = applyMarks(parsed, marks, { now });
  return {
    skipped: false,
    marks,
    delta,
    ledgerText: hasDelta(delta) ? serializeLedger(doc) : ledgerText,
    lastUuid: last.uuid || lastUuid,
    changed: hasDelta(delta),
  };
}

function onStop(raw, env) {
  const loaded = loadTranscript(raw, env);
  if (loaded.error) {
    process.stderr.write(`[挂账] 没查成：${loaded.error}（≠ 扫完没有标记）\n`);
    return 0;
  }
  const root = projectRoot(env);
  const ledgerPath = join(root, LEDGER_REL);
  let current = '';
  try { current = existsSync(ledgerPath) ? readFileSync(ledgerPath, 'utf8') : ''; } catch { current = ''; }
  const state = loadState(raw, env);
  const now = new Date().toISOString();
  const harvested = harvestFromTranscript(loaded.text, current, {
    now,
    lastUuid: state.lastUuid || '',
  });
  if (harvested.skipped) return 0;
  if (harvested.changed) {
    try { writeFileSync(ledgerPath, harvested.ledgerText, 'utf8'); } catch (e) {
      process.stderr.write(`[挂账] 写账本失败：${String(e.message || e).slice(0, 80)}\n`);
      return 0;
    }
    saveState(raw, env, { lastUuid: harvested.lastUuid, pendingDelta: harvested.delta });
  } else {
    saveState(raw, env, { lastUuid: harvested.lastUuid, pendingDelta: state.pendingDelta || null });
  }
  return 0;
}

export function promptLines(raw, env) {
  const state = loadState(raw, env);
  const lines = [REMINDER];
  if (hasDelta(state.pendingDelta)) {
    lines.push(formatDelta(state.pendingDelta));
    saveState(raw, env, { ...state, pendingDelta: null });
  }
  return lines;
}

function onPrompt(raw, env) {
  process.stdout.write(`${promptLines(raw, env).join('\n')}\n`);
  return 0;
}

export function runAsHook({ stdinText, env = process.env } = {}) {
  let raw = {};
  try { raw = stdinText ? JSON.parse(stdinText) : {}; } catch { raw = {}; }
  const event = raw.hook_event_name || 'Stop';
  if (event === 'UserPromptSubmit') return { exit: onPrompt(raw, env) };
  return { exit: onStop(raw, env) };
}

function main() {
  const r = runAsHook({ stdinText: readStdinSync(), env: process.env });
  process.exit(r.exit);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
