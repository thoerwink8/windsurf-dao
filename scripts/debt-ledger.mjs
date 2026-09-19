#!/usr/bin/env node
// scripts/debt-ledger.mjs —— T32：债册子（P2/P3 审查发现的账）。
//
//   node scripts/debt-ledger.mjs --record findings.json   # 把一批审查发现折进账本（同指纹累加计数）
//   node scripts/debt-ledger.mjs                          # 查账本：超期/条数超阈 → 红
//   node scripts/debt-ledger.mjs --json
//
// 判据全在 scripts/lib/debt-ledger.mjs（纯函数，单测覆盖）；本文件只读写盘 + 取数。
// 账本是**派生数据**，落 `~/.dao/debt/`（不进 git——进 git 就多一个没法人工合并的并发冲突点）。
// 三态：绿 / 红 / 没查成。**「没有债」与「没读成」必须分得开**。

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { foldFindings, judgeDebt } from './lib/debt-ledger.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = process.env.DAO_DEBT_REPO || 'thoerwink8/windsurf-dao';
const DIR = process.env.DAO_DEBT_DIR || join(homedir(), '.dao', 'debt');
const ledgerPath = (repo) => join(DIR, `${String(repo).replace(/[^A-Za-z0-9._-]/g, '__')}.json`);

function readLedger(repo) {
  const p = ledgerPath(repo);
  if (!existsSync(p)) return { ok: true, items: [], path: p, fresh: true };
  try {
    const doc = JSON.parse(readFileSync(p, 'utf8'));
    if (!doc || !Array.isArray(doc.items)) return { ok: false, error: `账本形态不对：${p}` };
    return { ok: true, items: doc.items, path: p, fresh: false };
  } catch (e) {
    return { ok: false, error: `账本读不成（${p}）：${String(e.message || e).slice(0, 120)}` };
  }
}

function loadSla(stage) {
  try {
    const doc = JSON.parse(readFileSync(join(ROOT, 'docs', 'stages', `${stage}.json`), 'utf8'));
    return (doc && doc.debt && doc.debt.sla) || {};
  } catch {
    return {};
  }
}

function main() {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  const recIdx = argv.indexOf('--record');
  const stageIdx = argv.indexOf('--stage');
  const stage = stageIdx >= 0 ? argv[stageIdx + 1] : 'v2.11';
  const repoIdx = argv.indexOf('--repo');
  const repo = repoIdx >= 0 ? argv[repoIdx + 1] : REPO;
  const now = new Date().toISOString();

  if (recIdx >= 0) {
    const file = argv[recIdx + 1];
    if (!file) { process.stdout.write('--record 要给一个 JSON 文件路径（findings 数组）\n'); process.exit(1); }
    let findings;
    try { findings = JSON.parse(readFileSync(file, 'utf8')); } catch (e) {
      process.stdout.write(`findings 读不成：${String(e.message || e).slice(0, 120)}\n`); process.exit(1);
    }
    if (!Array.isArray(findings)) { process.stdout.write('findings 要是数组\n'); process.exit(1); }
    const cur = readLedger(repo);
    if (!cur.ok) { process.stdout.write(`${cur.error}——没读成，不覆盖（宁可不记，不写坏账）\n`); process.exit(1); }
    const folded = foldFindings({ items: cur.items, findings, now, sla: loadSla(stage), stage });
    mkdirSync(DIR, { recursive: true });
    writeFileSync(cur.path, JSON.stringify({ repo, stage, updatedAt: now, items: folded.items }, null, 2));
    const out = { repo, path: cur.path, added: folded.added, bumped: folded.bumped, skipped: folded.skipped, total: folded.items.length };
    if (json) process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    else process.stdout.write(`✓ 债册子：新增 ${out.added} / 累加 ${out.bumped} / 跳过 ${out.skipped}；共 ${out.total} 条（${out.path}）\n`);
    process.exit(0);
  }

  const cur = readLedger(repo);
  if (!cur.ok) {
    process.stdout.write(`${json ? JSON.stringify({ state: 'unscanned', why: cur.error }) : `? 债册子 — ${cur.error}`}\n`);
    process.exit(1);
  }
  const verdict = judgeDebt({ items: cur.items, now: Date.parse(now) });
  if (json) {
    process.stdout.write(`${JSON.stringify({ repo, stage, path: cur.path, fresh: cur.fresh, total: cur.items.length, verdict }, null, 2)}\n`);
  } else {
    const mark = verdict.state === 'green' ? '✓' : verdict.state === 'red' ? '✗' : '?';
    process.stdout.write(`${mark} 债册子 — ${verdict.why}\n`);
    for (const i of cur.items.slice(0, 20)) {
      process.stdout.write(`   ${i.file ? `${i.file}:${i.line}` : `id:${i.fingerprint}`} ${i.type} ${i.severity} ×${i.count}（${i.sla}${i.dueAt ? `，到期 ${i.dueAt.slice(0, 10)}` : ''}）\n`);
    }
  }
  process.exit(verdict.state === 'green' ? 0 : 1);
}

main();
