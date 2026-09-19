#!/usr/bin/env node
// host/conventions/kit/check-conventions.mjs —— T37：**子仓 CI 用**的约定符合性检查（零依赖，可整份复制）。
//
//   node check-conventions.mjs [--repo <目录>] [--expected-version <N>] [--json]
//
// 读两样东西：
//   · 该仓 `AGENTS.md`（没有就 `CLAUDE.md`）里的约定块 + `## 豁免` 段；
//   · 该仓 `.dao/conventions.json`（pin：{version, sha256}，从真相源 `stamp.mjs --print` 抄来）。
//
// 退出码**三态分得开**：0=绿、1=红、2=没查成。别把 2 当红、也别把 2 当绿——
// 「没查成」在宿主眼里必须看得见（崩溃/exit 1 与「判通过」看起来一样，这是本仓判例）。
//
// 判据在 ./conventions-core.mjs（同一份，不在两边各写一遍）。

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { judgeConventions, parseConventionBlock, parseExemptions } from './conventions-core.mjs';

const argv = process.argv.slice(2);
const json = argv.includes('--json');
const repoIdx = argv.indexOf('--repo');
const verIdx = argv.indexOf('--expected-version');
const repo = resolve(repoIdx >= 0 ? argv[repoIdx + 1] : '.');
const expectedVersion = verIdx >= 0 ? Number(argv[verIdx + 1]) : undefined;

function readFirst(paths) {
  for (const p of paths) {
    if (!existsSync(p)) continue;
    try { return { ok: true, path: p, text: readFileSync(p, 'utf8') }; } catch { return { ok: false, error: `读不成：${p}` }; }
  }
  return { ok: false, error: `AGENTS.md / CLAUDE.md 都没有：${repo}` };
}

function readPin() {
  const p = join(repo, '.dao', 'conventions.json');
  if (!existsSync(p)) return { pin: null };
  try { return { pin: JSON.parse(readFileSync(p, 'utf8')) }; } catch { return { pin: null, error: `pin 读不成：${p}` }; }
}

const doc = readFirst([join(repo, 'AGENTS.md'), join(repo, 'CLAUDE.md')]);
const verdict = doc.ok
  ? judgeConventions({
    block: parseConventionBlock(doc.text),
    pin: readPin().pin,
    exemptions: parseExemptions(doc.text),
    expectedVersion,
  })
  : { state: 'unscanned', why: doc.error, code: 'no-doc' };

if (json) process.stdout.write(`${JSON.stringify({ repo, doc: doc.path || null, verdict }, null, 2)}\n`);
else {
  const mark = verdict.state === 'green' ? '✓' : verdict.state === 'red' ? '✗' : '?';
  process.stdout.write(`${mark} 约定符合性 ${repo} — ${verdict.why}\n`);
}
process.exit(verdict.state === 'green' ? 0 : verdict.state === 'red' ? 1 : 2);
