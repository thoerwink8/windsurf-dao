#!/usr/bin/env node
// scripts/self-check-if-changed.mjs —— 本树 HEAD 变了才跑一次 dao-check，跑过就不重跑。
//
// 谁调：server-sync.sh 每 5 分钟一轮的尾巴（服务器只拉不推，land.mjs 那条「推之前跑检查」
// 在服务器上永远不触发，所以此前服务器上没人跑过 dao-check——server-check ⑪ 读账要有人写账）。
// 判据：~/.dao/dao-check/<本树>.json 里的 head == 当前 HEAD → 安静退出 0（不刷 journal）；
// 否则跑 dao-check（它自己在出口写账），退出码透传但**不挡**调用方——发现面在 server-check ⑪。
//
//   node scripts/self-check-if-changed.mjs [--root <树>] [--dry-run]

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { readSelfCheckRecord } from './lib/self-check-ledger.mjs';

const argv = process.argv.slice(2);
const at = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : null; };
const DRY = argv.includes('--dry-run');
const ROOT = resolve(at('--root') || resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')));

const headRun = spawnSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true });
if (headRun.status !== 0) {
  console.log(`self-check：读不到 HEAD（${(headRun.stderr || '').trim().slice(0, 120)}）——不跑`);
  process.exit(2);
}
const head = headRun.stdout.trim();
const ledger = readSelfCheckRecord(ROOT);
if (ledger.probed && ledger.record.head === head) process.exit(0); // 已有本 HEAD 的账，安静

const why = ledger.probed ? `账上是 ${String(ledger.record.head).slice(0, 7)}，本树已到 ${head.slice(0, 7)}` : ledger.reason;
if (DRY) { console.log(`self-check：[拟] 跑 dao-check（${why}）`); process.exit(0); }
console.log(`self-check：${why}——跑 dao-check`);
const t0 = Date.now();
const r = spawnSync(process.execPath, [resolve(ROOT, 'scripts', 'dao-check.mjs')], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
const tail = String(r.stdout || '').trim().split(/\r?\n/).pop() || '';
console.log(`self-check：dao-check 退出 ${r.status}（${Math.round((Date.now() - t0) / 1000)}s）：${tail}`);
process.exit(r.status == null ? 1 : r.status);
