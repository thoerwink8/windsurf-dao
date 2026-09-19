#!/usr/bin/env node
// scripts/conformance.mjs —— T37 ③：跨仓符合性报告（本仓读子仓，出三态结论）。
//
//   node scripts/conformance.mjs            # 人读报告
//   node scripts/conformance.mjs --json
//
// 清单在 host/machine/child-repos.json；判据在 scripts/lib/conformance.mjs（纯函数，单测覆盖）。
// 本文件只取数：读子仓的 AGENTS.md / CLAUDE.md 与 .dao/conventions.json（两条只读 gh api）。
//
// 三态分得开（退出码 0=绿 / 1=红 / 2=没查成）：
//   · 取不到（网络/权限失败）→ 没查成；
//   · 文件**确定不存在**（404）→ 红（未接，不是没查成）。
// **子仓未接 = 红**，这是报告该说的实话，不是故障。

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { judgeConformance } from './lib/conformance.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = process.env.DAO_CONFORMANCE_REPO || 'thoerwink8/windsurf-dao';

/** 只读 gh api：`--raw` 取文件正文。区分「确定不存在（404）」与「取不到（其它错）」。 */
function ghRaw(path) {
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'gh-as.mjs'), 'marshal', '--', 'api', '-H', 'Accept: application/vnd.github.raw', path], { encoding: 'utf8', windowsHide: true });
  const err = String(r.stderr || r.stdout || '').trim();
  if (r.status === 0) return { ok: true, text: String(r.stdout || '') };
  if (/HTTP 404|Not Found/i.test(err)) return { ok: false, notFound: true, error: err.slice(0, 120) };
  return { ok: false, error: err.slice(0, 120) };
}

function loadRepos() {
  try {
    const doc = JSON.parse(readFileSync(join(ROOT, 'host', 'machine', 'child-repos.json'), 'utf8'));
    return { ok: true, repos: doc && doc.repos, raw: doc };
  } catch (e) {
    return { ok: false, error: `child-repos.json 读不成：${String(e.message || e).slice(0, 120)}` };
  }
}

function truthVersion() {
  try {
    return JSON.parse(readFileSync(join(ROOT, 'host', 'conventions', 'conventions.json'), 'utf8')).version;
  } catch { return undefined; }
}

function sampleOf(fullName) {
  const base = `repos/${fullName}/contents`;
  let docText = null, docPath = null, docAbsent = false, docError = null;
  for (const name of ['AGENTS.md', 'CLAUDE.md']) {
    const r = ghRaw(`${base}/${name}`);
    if (r.ok) { docText = r.text; docPath = name; break; }
    if (r.notFound) { docAbsent = true; continue; }
    docError = r.error; break;
  }
  if (docText) docAbsent = false;

  let pin = null, pinAbsent = false, pinError = null;
  const pr = ghRaw(`${base}/.dao/conventions.json`);
  if (pr.ok) { try { pin = JSON.parse(pr.text); } catch { pinError = '不是 JSON'; } }
  else if (pr.notFound) pinAbsent = true;
  else pinError = pr.error;

  return { docText, docPath, docAbsent, docError, pin, pinAbsent, pinError };
}

const argv = process.argv.slice(2);
const json = argv.includes('--json');
const loaded = loadRepos();
if (!loaded.ok) {
  process.stdout.write(`${json ? JSON.stringify({ state: 'unscanned', why: loaded.error }) : `? 跨仓符合性 — ${loaded.error}`}\n`);
  process.exit(2);
}

const repos = loaded.repos || [];
const samples = {};
for (const r of repos) {
  if (r && r.fullName) samples[r.fullName] = sampleOf(r.fullName);
}
const verdict = judgeConformance({ repos, samples, expectedVersion: truthVersion() });

if (json) process.stdout.write(`${JSON.stringify({ repo: REPO, expectedVersion: truthVersion(), verdict }, null, 2)}\n`);
else {
  const mark = verdict.state === 'green' ? '✓' : verdict.state === 'red' ? '✗' : '?';
  process.stdout.write(`${mark} 跨仓符合性 — ${verdict.why}\n`);
  for (const p of verdict.perRepo) {
    const m = p.state === 'green' ? '✓' : p.state === 'red' ? '✗' : '?';
    process.stdout.write(`   ${m} ${p.fullName} [${p.code}] — ${p.why}\n`);
  }
}
process.exit(verdict.state === 'green' ? 0 : verdict.state === 'red' ? 1 : 2);
