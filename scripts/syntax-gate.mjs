#!/usr/bin/env node
// scripts/syntax-gate.mjs —— T41：对**改动文件**跑 `node --check`（零依赖，node 自带）。
//
//   node scripts/syntax-gate.mjs                     # 默认比 origin/master（CI/PR 用）
//   node scripts/syntax-gate.mjs --base HEAD~1       # 指定基线
//   node scripts/syntax-gate.mjs --files a.mjs b.js  # 指定文件（不查 git）
//   node scripts/syntax-gate.mjs --json
//
// 判据全在 scripts/lib/syntax-gate.mjs（纯函数，单测覆盖）；本文件只取数 + 起进程。
// 三态：绿 / 红 / 没查成。基线 ref 取不到 = 没查成（不是绿）。

import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { syntaxTargets, judgeSyntaxResults } from './lib/syntax-gate.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const run = (argv, opts = {}) => spawnSync('git', argv, { encoding: 'utf8', cwd: ROOT, windowsHide: true, ...opts });

function changedFiles(base) {
  const candidates = [base, 'origin/master', 'master', 'HEAD~1'].filter(Boolean);
  for (const ref of candidates) {
    const exists = run(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    if (exists.status !== 0) continue;
    const mergeBase = run(['merge-base', ref, 'HEAD']);
    const from = mergeBase.status === 0 ? String(mergeBase.stdout).trim() : ref;
    const diff = run(['diff', '--name-only', '--diff-filter=d', `${from}...HEAD`]);
    if (diff.status === 0) {
      return { ref, files: String(diff.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean) };
    }
  }
  return { error: `基线 ref 取不到（试过 ${candidates.join(' / ')}）——没查成，不是绿` };
}

function checkFile(file) {
  const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8', cwd: ROOT, windowsHide: true });
  return {
    file,
    ok: r.status === 0,
    error: r.status === 0 ? null : String(r.stderr || r.stdout || '').trim().split('\n').slice(0, 3).join(' | ').slice(0, 200),
  };
}

function main() {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  const baseIdx = argv.indexOf('--base');
  const base = baseIdx >= 0 ? argv[baseIdx + 1] : null;
  const filesIdx = argv.indexOf('--files');

  let files;
  let how;
  if (filesIdx >= 0) {
    files = argv.slice(filesIdx + 1).filter((a) => !a.startsWith('--'));
    how = '命令行给的 --files';
  } else {
    const got = changedFiles(base);
    if (got.error) {
      process.stdout.write(`${json ? JSON.stringify({ state: 'unscanned', why: got.error }) : `? 语法闸 — ${got.error}`}\n`);
      process.exit(1);
    }
    files = got.files;
    how = `与 ${got.ref} 的改动（${files.length} 个文件）`;
  }

  const targets = syntaxTargets(files);
  const results = (targets || []).map(checkFile);
  const verdict = judgeSyntaxResults(results);

  if (json) {
    process.stdout.write(`${JSON.stringify({ base: base || 'origin/master', how, targets: targets ? targets.length : null, verdict }, null, 2)}\n`);
  } else {
    const mark = verdict.state === 'green' ? '✓' : '✗';
    process.stdout.write(`${mark} 语法闸 — ${how}；${verdict.why}\n`);
    for (const f of verdict.failures || []) process.stdout.write(`    ${f.file}: ${f.error}\n`);
  }
  process.exit(verdict.state === 'green' ? 0 : 1);
}

main();
