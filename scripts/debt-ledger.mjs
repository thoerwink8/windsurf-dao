#!/usr/bin/env node
// scripts/debt-ledger.mjs —— T32：债册子（P2/P3 审查发现的账）。
//
//   node scripts/debt-ledger.mjs --record findings.json   # 把一批审查发现折进账本（同指纹累加计数）
//   node scripts/debt-ledger.mjs --recheck                # 重查即重算：逐条看锚点/文件还在不在（只读，出口前清算用）
//   node scripts/debt-ledger.mjs --recheck --apply        # 把判「可关」的移进 closed（带证据）
//   node scripts/debt-ledger.mjs                          # 查账本：超期/条数超阈 → 红
//   node scripts/debt-ledger.mjs --json
//
// 判据全在 scripts/lib/debt-ledger.mjs（纯函数，单测覆盖）；本文件只读写盘 + 取数。
// 账本是**派生数据**，落 `~/.dao/debt/`（不进 git——进 git 就多一个没法人工合并的并发冲突点）。
// 三态：绿 / 红 / 没查成。**「没有债」与「没读成」必须分得开**。

import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyRecheck, debtMarker, foldFindings, judgeDebt, judgeRecheck } from './lib/debt-ledger.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = process.env.DAO_DEBT_REPO || 'thoerwink8/windsurf-dao';
const DIR = process.env.DAO_DEBT_DIR || join(homedir(), '.dao', 'debt');
const ledgerPath = (repo) => join(DIR, `${String(repo).replace(/[^A-Za-z0-9._-]/g, '__')}.json`);

function readLedger(repo) {
  const p = ledgerPath(repo);
  if (!existsSync(p)) return { ok: true, items: [], closed: [], path: p, fresh: true };
  try {
    const doc = JSON.parse(readFileSync(p, 'utf8'));
    if (!doc || !Array.isArray(doc.items)) return { ok: false, error: `账本形态不对：${p}` };
    return { ok: true, items: doc.items, closed: Array.isArray(doc.closed) ? doc.closed : [], path: p, fresh: false };
  } catch (e) {
    return { ok: false, error: `账本读不成（${p}）：${String(e.message || e).slice(0, 120)}` };
  }
}

/** 扫当前树：git 跟踪的文件清单 + 里面的 `DAO-DEBT:<前8位>` 锚点。读不到的文件少一个标记——
 *  那会让条目落进 unscanned（要人过一眼），不会误判成「已修」。 */
function scanRepo(root) {
  const r = spawnSync('git', ['ls-files'], { cwd: root, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) return null;
  const files = new Set(), markers = new Set();
  for (const line of String(r.stdout || '').split('\n')) {
    const rel = line.trim();
    if (!rel) continue;
    files.add(rel);
    try {
      const st = statSync(join(root, rel));
      if (!st.isFile() || st.size > 2 * 1024 * 1024) continue;
      for (const m of readFileSync(join(root, rel), 'utf8').matchAll(/DAO-DEBT:([0-9a-f]{8})/g)) markers.add(`DAO-DEBT:${m[1]}`);
    } catch { /* 读不到就少一个标记——由 unscanned 兜住，不当已修 */ }
  }
  return { files, markers };
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
    writeFileSync(cur.path, JSON.stringify({ repo, stage, updatedAt: now, items: folded.items, closed: cur.closed }, null, 2));
    const known = new Set(cur.items.map((i) => i.fingerprint));
    const out = {
      repo, path: cur.path, added: folded.added, bumped: folded.bumped, skipped: folded.skipped, total: folded.items.length,
      // 新条目的锚点文本：记账时把它贴到问题点，出口前的重查才找得到（见 judgeRecheck）。
      markers: folded.items.filter((i) => !known.has(i.fingerprint)).map((i) => ({ fingerprint: i.fingerprint, marker: debtMarker(i.fingerprint), where: i.file ? `${i.file}:${i.line}` : '' })),
    };
    if (json) process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    else {
      process.stdout.write(`✓ 债册子：新增 ${out.added} / 累加 ${out.bumped} / 跳过 ${out.skipped}；共 ${out.total} 条（${out.path}）\n`);
      for (const m of out.markers) process.stdout.write(`   ${m.where || '（没位置，只有 id）'} ← ${m.marker}\n`);
    }
    process.exit(0);
  }

  const cur = readLedger(repo);
  if (!cur.ok) {
    process.stdout.write(`${json ? JSON.stringify({ state: 'unscanned', why: cur.error }) : `? 债册子 — ${cur.error}`}\n`);
    process.exit(1);
  }

  if (argv.includes('--recheck')) {
    const scanned = scanRepo(ROOT);
    const verdict = scanned
      ? judgeRecheck({ items: cur.items, markers: scanned.markers, files: scanned.files })
      : { state: 'unscanned', why: '树没扫成（git ls-files 没跑成）——扫不到 ≠ 没有标记' };
    const applied = argv.includes('--apply') && verdict.state !== 'unscanned'
      ? applyRecheck({ items: cur.items, closed: cur.closed, resolved: verdict.resolved, now })
      : null;
    if (applied && applied.closedCount) {
      mkdirSync(DIR, { recursive: true });
      writeFileSync(cur.path, JSON.stringify({ repo, stage, updatedAt: now, items: applied.items, closed: applied.closed }, null, 2));
    }
    const out = { repo, stage, path: cur.path, verdict, applied: applied ? applied.closedCount : 0, total: applied ? applied.items.length : cur.items.length };
    if (json) process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    else {
      const mark = verdict.state === 'green' ? '✓' : '?';
      process.stdout.write(`${mark} 重查即重算 — ${verdict.why}\n`);
      for (const i of verdict.resolved.slice(0, 20)) process.stdout.write(`   可关 ${i.file || `id:${i.fingerprint}`}（${i.evidence}）\n`);
      for (const i of verdict.unscanned.slice(0, 20)) process.stdout.write(`   判不了 ${i.file || `id:${i.fingerprint}`}（${i.evidence}）\n`);
      if (applied) process.stdout.write(`   已关 ${applied.closedCount} 条（进 closed，带证据）\n`);
      else if (verdict.resolved.length) process.stdout.write('   要真关掉，加 --apply\n');
    }
    process.exit(verdict.state === 'green' ? 0 : 1);
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
