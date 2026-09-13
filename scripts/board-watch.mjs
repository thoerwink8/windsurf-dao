#!/usr/bin/env node
// scripts/board-watch.mjs —— 看板 v0 阶段超时告警（#818）
//
// 读一张表，墙钟超阈值 → 发总控群；同一主体同一阶段不刷屏。
// 源没查成 → 不报「超时」（没查成 ≠ 超时），exit 2。
//
// 用法:
//   node scripts/board-watch.mjs
//   node scripts/board-watch.mjs --dry-run --json --state <账本> --root <仓根>
//
// 测试注入：
//   BOARD_WATCH_HUB_SAY   假 hub-say（打印收到的文案，exit 0）

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { collectBoard } from './lib/board-collect.mjs';
import {
  DEFAULT_ALERT_BATCH_MAX, formatDigestAlert, planStageTimeoutAlerts,
} from './lib/board-v0.mjs';
import { ensurePlain } from './lib/plain-words.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_STATE = join(homedir(), '.dao', 'board-watch.json');
const HUB_SAY_CANDIDATES = [process.env.DAO_HUB_SAY, '/home/orca/bin/hub-say'].filter(Boolean);

export function parseArgs(argv = []) {
  const out = {
    root: ROOT,
    state: process.env.BOARD_WATCH_STATE || DEFAULT_STATE,
    dryRun: false,
    json: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--json') out.json = true;
    else if (a === '--root') out.root = argv[++i] || out.root;
    else if (a === '--state') out.state = argv[++i] || out.state;
  }
  return out;
}

export function loadAlertLedger(path) {
  if (!path || !existsSync(path)) return { ok: true, alerts: {}, missing: true };
  let raw;
  try { raw = readFileSync(path, 'utf8'); }
  catch (e) { return { ok: false, error: `告警账本读不了：${String(e.message || e)}` }; }
  let doc;
  try { doc = JSON.parse(raw); }
  catch (e) { return { ok: false, error: `告警账本不是 JSON：${String(e.message || e)}` }; }
  if (!doc || typeof doc !== 'object') return { ok: true, alerts: {}, missing: false };
  const alerts = doc.alerts && typeof doc.alerts === 'object' && !Array.isArray(doc.alerts) ? doc.alerts : {};
  return { ok: true, alerts, missing: false, at: doc.at || null };
}

export function saveAlertLedger(path, { alerts, at } = {}) {
  if (!path) return { ok: false, error: '告警账本路径没给' };
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ alerts: alerts || {}, at: at || new Date().toISOString() }, null, 2), 'utf8');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `告警账本写不了：${String(e.message || e)}` };
  }
}

export function defaultHubSay(text) {
  const fake = process.env.BOARD_WATCH_HUB_SAY;
  const args = [ensurePlain(String(text), 'board-watch')];
  const tryOne = (cmd, extra = []) => spawnSync(cmd, [...extra, ...args], {
    encoding: 'utf8', windowsHide: true, timeout: 30000,
  });
  let r;
  if (fake) r = tryOne(process.execPath, [fake]);
  else {
    r = tryOne('hub-say');
    if (r.error && r.error.code === 'ENOENT') {
      for (const cand of HUB_SAY_CANDIDATES) {
        if (!existsSync(cand)) continue;
        r = tryOne(cand);
        break;
      }
    }
  }
  if (r && r.error) return { ok: false, error: `hub-say 起不来：${r.error.message}（服务器上在 /home/orca/bin）` };
  if (!r || (r.status ?? 1) !== 0) {
    return { ok: false, error: String((r && (r.stderr || r.stdout)) || 'hub-say 失败').trim().slice(0, 200) };
  }
  // 认回执，不认退出码（同 commander hubSay：exit 0 但没 message_id = 没送进群）。
  const messageId = String(r.stdout || '').trim().replace(/^"|"$/g, '');
  if (!messageId || messageId === 'null') {
    return { ok: false, error: `hub-say 退出码 0 但没回 message_id——没送进群（stdout=${String(r.stdout || '').trim().slice(0, 80)}）` };
  }
  return { ok: true, messageId };
}

function sourcesUnscanned(board) {
  const src = board && board.sources;
  if (!src || typeof src !== 'object') return ['整张表'];
  const bad = [];
  for (const [name, s] of Object.entries(src)) {
    if (name === 'ledger') continue;
    if (s && s.state === 'unscanned') bad.push(name);
  }
  return bad;
}

export async function runBoardWatch({
  root = ROOT,
  state = DEFAULT_STATE,
  dryRun = false,
  now = new Date().toISOString(),
  collect = collectBoard,
  hubSay = defaultHubSay,
} = {}) {
  let collected;
  try {
    collected = await collect({ cwd: root, root, now });
  } catch (e) {
    return { ok: false, exit: 2, scanned: false, error: `看板没查成：${String(e.message || e)}`, sent: [] };
  }
  const board = collected && collected.board;
  if (!board || !Array.isArray(board.rows)) {
    return { ok: false, exit: 2, scanned: false, error: '看板没给出行（没查成）', sent: [] };
  }
  const missing = sourcesUnscanned(board);
  const ledger = loadAlertLedger(state);
  if (!ledger.ok) {
    return { ok: false, exit: 2, scanned: false, error: ledger.error, sent: [] };
  }
  const planned = planStageTimeoutAlerts({
    rows: board.rows,
    thresholdHours: board.thresholdHours,
    ledger: { alerts: ledger.alerts },
  });
  const batchMax = Number(collected && collected.policy && collected.policy.alertBatchMax);
  const cap = Number.isInteger(batchMax) && batchMax >= 1 ? batchMax : DEFAULT_ALERT_BATCH_MAX;
  const digest = planned.alerts.length > cap;
  const outbound = digest
    ? [{
        key: `digest:${now}`,
        digest: true,
        text: formatDigestAlert(planned.alerts, board.thresholdHours),
        covered: planned.alerts.map((a) => a.key),
      }]
    : planned.alerts;
  const sent = [];
  const nextAlerts = { ...ledger.alerts };
  for (const a of outbound) {
    if (dryRun) {
      sent.push({ key: a.key, dryRun: true, text: a.text, digest: !!a.digest });
      continue;
    }
    const hub = hubSay(a.text);
    if (!hub.ok) {
      return {
        ok: false,
        exit: 1,
        scanned: true,
        error: `告警没发出去：${hub.error}`,
        sent,
        alerts: planned.alerts,
      };
    }
    if (a.digest) {
      for (const k of a.covered || []) {
        const src = planned.alerts.find((x) => x.key === k);
        nextAlerts[k] = { at: now, stage: src && src.stage, id: src && src.id, kind: src && src.kind, digest: true };
      }
    } else {
      nextAlerts[a.key] = { at: now, stage: a.stage, id: a.id, kind: a.kind };
    }
    sent.push({ key: a.key, messageId: hub.messageId, text: a.text, digest: !!a.digest });
  }
  if (!dryRun && sent.length) {
    const saved = saveAlertLedger(state, { alerts: nextAlerts, at: now });
    if (!saved.ok) {
      return { ok: false, exit: 2, scanned: true, error: saved.error, sent };
    }
  }
  // 主源没查成：不许当「查过没事」。超时行仍可报（查成的那几行），但整轮 exit 2。
  if (missing.length) {
    return {
      ok: false,
      exit: 2,
      scanned: false,
      error: `${missing.join('、')} 没查成，不把整张表当成正常`,
      sent,
      skipped: planned.skipped,
      alerts: planned.alerts,
      board,
    };
  }
  return {
    ok: true,
    exit: 0,
    scanned: true,
    sent,
    skipped: planned.skipped,
    alerts: planned.alerts,
    board,
    dryRun,
  };
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(`用法: node scripts/board-watch.mjs [--root 仓根] [--state 账本] [--dry-run] [--json]

墙钟超阈值 → 总控群报一次；同一张单同一阶段不重报。
源没查成 → stderr「没查成」+ exit 2（不许当成没超时）。`);
    process.exit(0);
  }
  const result = await runBoardWatch({
    root: resolve(args.root),
    state: resolve(args.state),
    dryRun: args.dryRun,
  });
  if (args.json) {
    console.log(JSON.stringify({
      ok: result.ok,
      scanned: result.scanned,
      sent: (result.sent || []).map((s) => s.key),
      skipped: (result.skipped || []).length,
      error: result.error || null,
    }, null, 2));
  }
  if (!result.ok) {
    console.error(result.error || '没查成');
    process.exit(result.exit || 2);
  }
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
