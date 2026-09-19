#!/usr/bin/env node
// scripts/reflow.mjs —— T37 ②：回流收件箱（子仓 → 本仓）的三态检查。
//
//   node scripts/reflow.mjs           # 查收件箱：超时 / 堆积 / rejected 缺理由 / 未提交 → 红
//   node scripts/reflow.mjs --json
//   node scripts/reflow.mjs --render  # 只打印注入文本（指挥官唤醒用）
//
// 判据全在 scripts/lib/reflow.mjs（纯函数，单测覆盖）；本文件只取数（读盘 + git 查未跟踪）。
// 退出码三态分得开：0=绿 / 1=红 / 2=没查成。**读不到 ≠ 收件箱是空的。**

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REFLOW_DIR_REL, assessReflow, judgeReflow, parseReflowDoc, renderReflow } from './lib/reflow.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BOXES = ['inbox', 'accepted', 'rejected'];

function loadDocs() {
  const docs = [];
  for (const box of BOXES) {
    const dir = join(ROOT, REFLOW_DIR_REL, box);
    let names;
    try { names = readdirSync(dir); } catch (e) { return { ok: false, error: `读不了 ${REFLOW_DIR_REL}/${box}（${String(e.code || e.message)}）` }; }
    for (const name of names) {
      if (!name.endsWith('.md') || name.startsWith('.')) continue;
      const p = join(dir, name);
      try {
        const st = statSync(p);
        if (!st.isFile()) continue;
        docs.push(parseReflowDoc(readFileSync(p, 'utf8'), { name: `${box}/${name}`, mtimeMs: st.mtimeMs, box }));
      } catch (e) {
        return { ok: false, error: `读不了 ${REFLOW_DIR_REL}/${box}/${name}（${String(e.code || e.message)}）` };
      }
    }
  }
  return { ok: true, docs };
}

function loadUntracked() {
  const r = spawnSync('git', ['-C', ROOT, 'ls-files', '--others', '--exclude-standard', '--', REFLOW_DIR_REL], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) return null;
  return String(r.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean);
}

const argv = process.argv.slice(2);
const json = argv.includes('--json');
const loaded = loadDocs();
const untracked = loaded.ok ? loadUntracked() : [];
const assessed = loaded.ok
  ? assessReflow({ docs: loaded.docs, untracked: untracked || [], unscanned: untracked === null ? 'git 查未跟踪没成' : null })
  : assessReflow({ unscanned: loaded.error });
const verdict = judgeReflow(assessed);

if (argv.includes('--render')) { process.stdout.write(renderReflow(assessed)); process.exit(0); }

if (json) {
  process.stdout.write(`${JSON.stringify({ dir: REFLOW_DIR_REL, mode: assessed.mode, unscanned: !!assessed.unscanned, verdict, pending: (assessed.pending || []).map((d) => d.name), overdue: (assessed.overdue || []).map((d) => d.name), missingReason: (assessed.missingReason || []).map((d) => d.name), lines: assessed.lines }, null, 2)}\n`);
} else {
  const mark = verdict.state === 'green' ? '✓' : verdict.state === 'red' ? '✗' : '?';
  process.stdout.write(`${mark} 回流收件箱 — ${verdict.why}\n`);
  for (const l of assessed.lines) process.stdout.write(`   ${l}\n`);
}
process.exit(verdict.state === 'green' ? 0 : verdict.state === 'red' ? 1 : 2);
