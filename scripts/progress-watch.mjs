#!/usr/bin/env node
// scripts/progress-watch.mjs —— 盘面推进量薄驱动（chain:progress-stall#0）
//
// 读最近 N 份 ~/.dao/commander/situation-*.json，调纯函数，出报告。
// 判出停滞 → 推帅位一次（AGENT_LOOP_TICK_PANMIAN）；同一指纹不重推。
// 快照读不出 / 目录空 → 没查成（exit 2），不许当成没停滞。
//
// 2026-09-06 用户拍板：屏面指纹层（agent-stall-watch）整层退役，本脚本是卡死发现的
// 唯一定时面。随之搬进来的还有「自动化认输的 PR 推帅位一次」——那段本就只读 PR 面、
// 与屏面指纹无关，删掉旧宿主时它会失去唯一调用点。
//
// 用法：
//   node scripts/progress-watch.mjs
//   node scripts/progress-watch.mjs --dir <快照目录> --state <账本> --rounds 5 --dry-run --json
//
// 测试注入：
//   PROGRESS_WATCH_EXHAUSTED_GH      假 gh（打印 PR 列表 JSON）
//   PROGRESS_WATCH_EXHAUSTED_LEDGER  覆盖认输账本路径

import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  DEFAULT_MIN_ROUNDS,
  detectProgressStall,
  planWake,
} from './lib/progress-detect.mjs';
import { runGh } from './lib/dao-cmd.mjs';
import { planExhaustedPush, exhaustedPushPath } from './lib/exhausted.mjs';

/** 与 shuai-scan 同一叫醒哨兵：有停滞且指纹变了才打到 stdout。 */
export const SENTINEL = 'AGENT_LOOP_TICK_PANMIAN';

const DEFAULT_DIR = join(homedir(), '.dao', 'commander');
const DEFAULT_STATE = join(homedir(), '.dao', 'progress-watch.json');

export function parseArgs(argv = []) {
  const out = {
    dir: process.env.PROGRESS_WATCH_DIR || DEFAULT_DIR,
    state: process.env.PROGRESS_WATCH_STATE || DEFAULT_STATE,
    rounds: DEFAULT_MIN_ROUNDS,
    dryRun: false,
    json: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--json') out.json = true;
    else if (a === '--dir') out.dir = argv[++i] || out.dir;
    else if (a === '--state') out.state = argv[++i] || out.state;
    else if (a === '--rounds') {
      const n = Number(argv[++i]);
      if (Number.isFinite(n) && n > 0) out.rounds = Math.floor(n);
    }
  }
  return out;
}

export function listSituationFiles(dir) {
  if (!dir) return { ok: false, error: '快照目录没给（没查成）', files: [] };
  if (!existsSync(dir)) return { ok: false, error: `快照目录不在：${dir}（没查成）`, files: [] };
  let names;
  try {
    names = readdirSync(dir);
  } catch (e) {
    return { ok: false, error: `快照目录读不了：${String(e.message || e)}（没查成）`, files: [] };
  }
  const files = names.filter((n) => /^situation-.*\.json$/i.test(n)).sort();
  return { ok: true, files: files.map((n) => join(dir, n)) };
}

export function readSnapshots(dir, { limit } = {}) {
  const listed = listSituationFiles(dir);
  if (!listed.ok) return { scanned: false, error: listed.error, snapshots: [], files: [] };
  if (!listed.files.length) {
    return { scanned: false, error: '快照目录是空的（没查成，不是没停滞）', snapshots: [], files: [] };
  }
  const n = Number(limit);
  const take = Number.isFinite(n) && n > 0 ? listed.files.slice(-Math.floor(n)) : listed.files;
  const snapshots = [];
  for (const file of take) {
    let raw;
    try {
      raw = readFileSync(file, 'utf8');
    } catch (e) {
      return { scanned: false, error: `快照读不了 ${file}：${String(e.message || e)}（没查成）`, snapshots: [], files: take };
    }
    let doc;
    try {
      doc = JSON.parse(raw);
    } catch (e) {
      return { scanned: false, error: `快照不是 JSON ${file}：${String(e.message || e)}（没查成）`, snapshots: [], files: take };
    }
    if (!doc || typeof doc !== 'object') {
      return { scanned: false, error: `快照不是对象 ${file}（没查成）`, snapshots: [], files: take };
    }
    snapshots.push(doc);
  }
  return { scanned: true, error: null, snapshots, files: take };
}

export function loadLedger(path) {
  if (!path || !existsSync(path)) return { ok: true, fingerprint: null, missing: true };
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (e) {
    return { ok: false, error: `账本读不了：${String(e.message || e)}（没查成）` };
  }
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (e) {
    return { ok: false, error: `账本不是 JSON：${String(e.message || e)}（没查成）` };
  }
  if (!doc || typeof doc !== 'object') return { ok: true, fingerprint: null, missing: false };
  return { ok: true, fingerprint: doc.fingerprint || null, missing: false, at: doc.at || null };
}

export function saveLedger(path, { fingerprint, at } = {}) {
  if (!path) return { ok: false, error: '账本路径没给' };
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ fingerprint: fingerprint || null, at: at || new Date().toISOString() }, null, 2), 'utf8');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `账本写不了：${String(e.message || e)}` };
  }
}

const EXHAUSTED_FIELDS = 'number,title,headRefOid,labels';

/** 开放 PR 列表。watchdog 身份先试，失败退 worker——两条都不通才算没查成。 */
function fetchOpenPrsForExhausted() {
  const fake = process.env.PROGRESS_WATCH_EXHAUSTED_GH;
  if (fake) {
    const r = spawnSync(process.execPath, [fake], { windowsHide: true, encoding: 'utf8', timeout: 15000 });
    if (r.status !== 0) return { ok: false, error: `假 gh 退出码 ${r.status}` };
    try {
      const v = JSON.parse(r.stdout || '[]');
      return Array.isArray(v) ? { ok: true, prs: v } : { ok: false, error: '假 gh 没给数组' };
    } catch (e) {
      return { ok: false, error: `假 gh JSON 解析失败：${String(e.message).slice(0, 80)}` };
    }
  }
  const args = ['pr', 'list', '--state', 'open', '--limit', '100', '--json', EXHAUSTED_FIELDS];
  for (const role of ['watchdog', 'worker']) {
    const r = runGh(args, { role });
    if (!r.ok) continue;
    try {
      const v = JSON.parse(r.out || '[]');
      if (Array.isArray(v)) return { ok: true, prs: v };
      return { ok: false, error: 'gh 没给数组' };
    } catch (e) {
      return { ok: false, error: String(e.message).slice(0, 80) };
    }
  }
  return { ok: false, error: 'gh pr list 两个身份都没查成' };
}

function loadJson(path) {
  if (!existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

function saveJson(path, doc) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(doc), 'utf8');
}

/**
 * 自动化认输的 PR 按 @head 推帅位一次（#1000）。
 * 账本键带 head：修好的新局面不该被旧账挡住。
 */
export function pushExhaustedToShuai({ dryRun = false, lines = [] } = {}) {
  const got = fetchOpenPrsForExhausted();
  if (!got.ok) {
    lines.push(`自动化认输的 PR 没查成：${got.error}`);
    return { ok: false, error: got.error, pushed: 0 };
  }
  const ledgerPath = process.env.PROGRESS_WATCH_EXHAUSTED_LEDGER || exhaustedPushPath(homedir());
  const ledger = loadJson(ledgerPath);
  const plan = planExhaustedPush({ prs: got.prs, ledger });
  for (const p of plan.pushes) {
    lines.push(p.text);
    if (!dryRun) ledger[p.key] = { at: new Date().toISOString(), pr: p.pr, head: p.head };
  }
  if (!dryRun && plan.pushes.length) saveJson(ledgerPath, ledger);
  return { ok: true, pushed: plan.pushes.length, skipped: plan.skipped.length };
}

export function formatReport(verdict) {
  if (!verdict || verdict.scanned !== true) {
    return `没查成：${verdict && verdict.error ? verdict.error : '盘面推进量没查成'}`;
  }
  if (!verdict.stalled) {
    if (verdict.reason === 'idle') return '盘面空闲，不算停滞';
    if (verdict.reason === 'not-enough-rounds') return `快照不足 ${verdict.rounds} 轮，还不能判停滞`;
    return '盘面有推进，不报停滞';
  }
  const items = verdict.items || [];
  const order = { pr: 0, ticket: 1, issue: 2 };
  const ranked = items.slice().sort((a, b) => (order[a.kind] ?? 9) - (order[b.kind] ?? 9));
  const prs = ranked.filter((i) => i.kind === 'pr').map((i) => `PR #${i.id}`);
  const head = `盘面停滞 ${verdict.rounds} 轮（${items.length} 个对象没动）`;
  const named = prs.length ? `：${prs.slice(0, 8).join(' ')}` : '';
  const extra = ranked.slice(0, 5).map((i) => `- ${i.why}`).join('\n');
  return `${head}${named}\n${extra}`;
}

/**
 * 给 `dao now` 的信封。目录空 / 损坏 → scanned:false；空闲或有推进 → scanned:true, items:[]。
 */
export function collectProgressStalls({
  dir = DEFAULT_DIR,
  minRounds = DEFAULT_MIN_ROUNDS,
  read = readSnapshots,
} = {}) {
  const got = read(dir, { limit: minRounds });
  if (!got || got.scanned !== true) {
    return { scanned: false, error: (got && got.error) || '快照没查成', items: [] };
  }
  const verdict = detectProgressStall(got.snapshots, { minRounds });
  if (verdict.scanned !== true) {
    return { scanned: false, error: verdict.error || '推进量没查成', items: [] };
  }
  if (!verdict.stalled) return { scanned: true, items: [], reason: verdict.reason };
  return {
    scanned: true,
    items: (verdict.items || []).map((it) => ({
      kind: 'progress-stall',
      why: it.why,
      objectKind: it.kind,
      id: it.id,
      rounds: verdict.rounds,
    })),
    reason: 'stalled',
    fingerprint: verdict.fingerprint,
  };
}

export function runProgressWatch({
  dir = DEFAULT_DIR,
  state = DEFAULT_STATE,
  rounds = DEFAULT_MIN_ROUNDS,
  dryRun = false,
  json = false,
  now = new Date().toISOString(),
  // 默认**不查**认输 PR：这一步要打 gh，纯函数级测试不许出网。CLI 的 main() 显式传进来。
  exhaustedPush = null,
} = {}) {
  const got = readSnapshots(dir, { limit: rounds });
  if (got.scanned !== true) {
    return {
      ok: false,
      exit: 2,
      scanned: false,
      error: got.error,
      wake: false,
      report: `没查成：${got.error}`,
    };
  }
  const verdict = detectProgressStall(got.snapshots, { minRounds: rounds });
  if (verdict.scanned !== true) {
    return {
      ok: false,
      exit: 2,
      scanned: false,
      error: verdict.error,
      wake: false,
      report: `没查成：${verdict.error}`,
    };
  }
  const ledger = loadLedger(state);
  if (!ledger.ok) {
    return {
      ok: false,
      exit: 2,
      scanned: false,
      error: ledger.error,
      wake: false,
      report: `没查成：${ledger.error}`,
    };
  }
  const planned = planWake({
    fingerprint: verdict.fingerprint,
    prevFingerprint: ledger.fingerprint,
    stalled: verdict.stalled,
  });
  if (planned.wake && !dryRun) {
    const saved = saveLedger(state, { fingerprint: planned.fingerprint, at: now });
    if (!saved.ok) {
      return {
        ok: false,
        exit: 2,
        scanned: false,
        error: saved.error,
        wake: false,
        report: `没查成：${saved.error}`,
      };
    }
  }
  // 认输推送与停滞判定是两条独立线：认输查不成不拖红主线（它有自己的账本去重），
  // 但那句「没查成」必须进报告并叫醒——不许长得像「查过没事」。
  const exhaustedLines = [];
  const exhausted = exhaustedPush ? exhaustedPush({ dryRun, lines: exhaustedLines }) : null;
  const report = [formatReport(verdict), ...exhaustedLines].join('\n');
  return {
    ok: true,
    exit: 0,
    scanned: true,
    stalled: !!verdict.stalled,
    wake: !!planned.wake || exhaustedLines.length > 0,
    wakeReason: planned.wake ? planned.reason : (exhaustedLines.length ? 'exhausted' : planned.reason),
    dryRun,
    fingerprint: planned.fingerprint,
    items: verdict.items || [],
    rounds: verdict.rounds,
    reason: verdict.reason,
    exhausted,
    report,
  };
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(`用法: node scripts/progress-watch.mjs [--dir 快照目录] [--state 账本] [--rounds N] [--dry-run] [--json]

连续 N 轮同一对象签名不变（且并非全空闲）→ stdout 首行 ${SENTINEL} + 摘要；
对象 A 停、对象 B 动 → 只报 A；
同一指纹不重推；指纹变了再推。
另查「自动化认输」的 PR，按 @head 推一次（账本 ~/.dao/exhausted-push.json）。
快照读不出 / 目录空 → stderr「没查成」+ exit 2（不许当成没停滞）。`);
    process.exit(0);
  }
  const result = runProgressWatch({
    dir: resolve(args.dir),
    state: resolve(args.state),
    rounds: args.rounds,
    dryRun: args.dryRun,
    json: args.json,
    exhaustedPush: pushExhaustedToShuai,
  });
  if (args.json) {
    console.log(JSON.stringify({
      ok: result.ok,
      scanned: result.scanned,
      stalled: result.stalled || false,
      wake: result.wake,
      reason: result.reason || result.error,
      items: (result.items || []).map((i) => ({ kind: i.kind, id: i.id })),
      error: result.error || null,
    }, null, 2));
  }
  if (!result.ok) {
    console.error(result.report || result.error || '没查成');
    process.exit(result.exit || 2);
  }
  if (result.wake) {
    process.stdout.write(`${SENTINEL}\n${result.report}\n`);
  }
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
