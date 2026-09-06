#!/usr/bin/env node
// scripts/shuai-scan.mjs —— 帅位看门狗 CLI（chain:progress-stall#0）
//
// #1004：发现层从「列举故障种类」换成盘面推进量。本 CLI 不再跑 evaluateScan /
// detectAnomalies；主路吃 runProgressWatch，判出停滞才打 AGENT_LOOP_TICK_PANMIAN。
// lib/shuai-scan.mjs 留下的是执行层共用件（PR 判绿 / CI 红 / 状态去重），不是盯盘主路。
//
// 有停滞且指纹变了 → stdout 首行 AGENT_LOOP_TICK_PANMIAN + 摘要；
// 无停滞 / 同一指纹 → 零输出 exit 0；没查成 → stderr + 非零，不许输出 sentinel。

import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { SENTINEL, runProgressWatch } from './progress-watch.mjs';

function parseArgs(argv) {
  const args = {
    dir: process.env.PROGRESS_WATCH_DIR || '',
    state: process.env.PROGRESS_WATCH_STATE || process.env.SHUAI_SCAN_STATE || '',
    rounds: 0,
    help: false,
    json: false,
    dryRun: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--json') args.json = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--dir') args.dir = argv[++i] || '';
    else if (a === '--state') args.state = argv[++i] || '';
    else if (a === '--rounds') {
      const n = Number(argv[++i]);
      if (Number.isFinite(n) && n > 0) args.rounds = Math.floor(n);
    }
  }
  return args;
}

export function runShuaiScan(argv = process.argv) {
  const args = parseArgs(argv);
  if (args.help) {
    return {
      exit: 0,
      stdout: `用法: node scripts/shuai-scan.mjs [--dir 快照目录] [--state 账本] [--rounds N] [--dry-run] [--json]

有停滞且指纹变了 → stdout 首行 ${SENTINEL} + 摘要；
无停滞 / 同一指纹 → 零输出 exit 0；
没查成 → stderr + 非零（不许输出 sentinel）。

环境变量：PROGRESS_WATCH_DIR / PROGRESS_WATCH_STATE / SHUAI_SCAN_STATE\n`,
      stderr: '',
    };
  }

  const opts = { dryRun: args.dryRun, json: args.json };
  if (args.dir) opts.dir = resolve(args.dir);
  if (args.state) opts.state = resolve(args.state);
  if (args.rounds > 0) opts.rounds = args.rounds;

  const result = runProgressWatch(opts);
  let stdout = '';
  if (args.json) {
    stdout += `${JSON.stringify({
      ok: result.ok,
      scanned: result.scanned,
      stalled: result.stalled || false,
      wake: result.wake,
      reason: result.reason || result.error,
      items: (result.items || []).map((i) => ({ kind: i.kind, id: i.id })),
      error: result.error || null,
    }, null, 2)}\n`;
  }
  if (!result.ok) {
    return {
      exit: result.exit || 2,
      stdout,
      stderr: `${result.report || result.error || '没查成'}\n`,
    };
  }
  if (result.wake) stdout += `${SENTINEL}\n${result.report}\n`;
  return { exit: 0, stdout, stderr: '' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const r = runShuaiScan(process.argv);
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  process.exit(r.exit);
}
