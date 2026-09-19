#!/usr/bin/env node
// scripts/docs-retire.mjs —— T47：文档清退的三态检查（活文档会不会退役）。
//
//   node scripts/docs-retire.mjs            # 查活文档：超期未复核 / 从没复核过 → 红
//   node scripts/docs-retire.mjs --json
//
// 判据全在 scripts/lib/docs-retire.mjs（纯函数，单测覆盖）；本文件只取数（git ls-files + 读盘）。
// 退出码三态分得开：0=绿 / 1=红 / 2=没查成。**读不到 ≠ 没有落后文档。**
//
// 退役怎么写：在文档 frontmatter 加 `status: retired`（**不删文件**——判例档案原则）。
// 复核过怎么写：frontmatter 加 `reviewed: YYYY-MM-DD`。

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ARCHIVE_DIRS, DOCS_DIR_REL, EXEMPT_FILES, assessDocs, judgeDocsRetire, parseDocMeta } from './lib/docs-retire.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function listDocs() {
  // core.quotePath=false：非 ASCII 文件名不许被转义成 \345\215\225…（否则读盘全 ENOENT）。
  const r = spawnSync('git', ['-C', ROOT, '-c', 'core.quotePath=false', 'ls-files', `${DOCS_DIR_REL}/*.md`, `${DOCS_DIR_REL}/**/*.md`], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) return { ok: false, error: `git ls-files 没跑成（${String(r.stderr || '').trim().slice(0, 100)}）` };
  const all = String(r.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean);
  const live = all.filter((p) => {
    if (EXEMPT_FILES.includes(p)) return false;
    const rest = p.slice(DOCS_DIR_REL.length + 1);
    const head = rest.includes('/') ? rest.split('/')[0] : '';
    return !ARCHIVE_DIRS.includes(head);
  });
  const docs = [];
  for (const p of live) {
    try {
      docs.push(parseDocMeta(readFileSync(join(ROOT, p), 'utf8'), { name: p }));
    } catch (e) {
      return { ok: false, error: `读不了 ${p}（${String(e.code || e.message)}）` };
    }
  }
  return { ok: true, docs, total: all.length, archived: all.length - live.length };
}

const argv = process.argv.slice(2);
const json = argv.includes('--json');
const loaded = listDocs();
const assessed = loaded.ok ? assessDocs({ docs: loaded.docs }) : assessDocs({ unscanned: loaded.error });
const verdict = judgeDocsRetire(assessed);

if (json) {
  process.stdout.write(`${JSON.stringify({
    docsDir: DOCS_DIR_REL, archiveDirs: ARCHIVE_DIRS, exemptFiles: EXEMPT_FILES, scanned: loaded.ok ? loaded.docs.length : null,
    archived: loaded.ok ? loaded.archived : null, mode: assessed.mode, unscanned: !!assessed.unscanned, verdict,
    pending: (assessed.pending || []).map((d) => d.name), overdue: (assessed.overdue || []).map((d) => d.name),
    never: (assessed.never || []).map((d) => d.name), lines: assessed.lines,
  }, null, 2)}\n`);
} else {
  const mark = verdict.state === 'green' ? '✓' : verdict.state === 'red' ? '✗' : '?';
  process.stdout.write(`${mark} 文档清退 — ${verdict.why}\n`);
  if (loaded.ok) process.stdout.write(`   扫了 ${loaded.docs.length} 条活文档（档案目录 ${loaded.archived} 条、下发产物 ${EXEMPT_FILES.length} 条不进判据）\n`);
  for (const l of assessed.lines) process.stdout.write(`   ${l}\n`);
}
process.exit(verdict.state === 'green' ? 0 : verdict.state === 'red' ? 1 : 2);
