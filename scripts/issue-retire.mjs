#!/usr/bin/env node
// scripts/issue-retire.mjs —— 落后单的机械清退（#1503）。
//
//   node scripts/issue-retire.mjs            # 人读报告（两段式：待清退 / 该清退）
//   node scripts/issue-retire.mjs --json     # 机器读
//   node scripts/issue-retire.mjs --apply    # 真动手：进名单的打「待清退」；该清退的关 wontfix
//
// 判据全在 scripts/lib/issue-retire.mjs（纯函数，单测覆盖）；本文件只取数 + 动手。
// 三态：绿 / 红 / 没查成。**没查成不许当绿**（issue/PR 面取不到就不许说「没有落后单」）。

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { judgeIssueStaleness, RETIRE_DEFAULTS } from './lib/issue-retire.mjs';
import { issueClose, issueEditLabels } from './lib/issue-gateway.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = process.env.DAO_RETIRE_REPO || 'thoerwink8/windsurf-dao';

const run = (cmd, argv) => spawnSync(cmd, argv, { encoding: 'utf8', windowsHide: true });

function ghJson(args) {
  const r = run(process.execPath, [join(ROOT, 'scripts', 'gh-as.mjs'), 'marshal', '--', ...args]);
  if (r.status !== 0) return { unscanned: true, error: String(r.stderr || r.stdout || '').trim().slice(0, 140) };
  try { return { array: JSON.parse(String(r.stdout || '')) }; } catch { return { unscanned: true, error: 'gh 回的不是 JSON' }; }
}

function loadConfig() {
  let doc = {};
  try {
    doc = JSON.parse(readFileSync(join(ROOT, 'docs', 'release-policy.json'), 'utf8'));
  } catch { doc = {}; }
  const cfg = { ...RETIRE_DEFAULTS, ...(doc && doc.retire ? doc.retire : {}) };
  // 变异/联调用：改环境变量就能在真数据上验判据（不必改文件、不必写盘）。
  const env = process.env;
  if (env.DAO_RETIRE_WARN_DAYS) cfg.warnIdleDays = Number(env.DAO_RETIRE_WARN_DAYS);
  if (env.DAO_RETIRE_RETIRE_DAYS) cfg.retireIdleDays = Number(env.DAO_RETIRE_RETIRE_DAYS);
  if (env.DAO_RETIRE_LABEL) cfg.label = env.DAO_RETIRE_LABEL;
  return cfg;
}

function ensureLabel(name) {
  const listed = ghJson(['label', 'list', '--json', 'name', '--limit', '200']);
  if (listed.unscanned) return { ok: false, error: listed.error };
  if (listed.array.some((l) => l.name === name)) return { ok: true, created: false };
  const r = run(process.execPath, [join(ROOT, 'scripts', 'gh-as.mjs'), 'marshal', '--', 'label', 'create', name,
    '--color', 'FBCA04', '--description', '闲置超阈，下一段没人碰就清退（#1503）']);
  if (r.status !== 0) return { ok: false, error: String(r.stderr || r.stdout || '').trim().slice(0, 140) };
  return { ok: true, created: true };
}

function main() {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  const apply = argv.includes('--apply');
  const cfg = loadConfig();

  const issues = ghJson(['issue', 'list', '--state', 'open', '--json', 'number,title,updatedAt,labels,milestone', '--limit', '500']);
  const prs = ghJson(['pr', 'list', '--state', 'open', '--json', 'number,title,body', '--limit', '200']);

  const verdict = judgeIssueStaleness({
    issues: issues.unscanned ? undefined : issues.array,
    prs: prs.unscanned ? undefined : prs.array,
    config: cfg,
    now: Date.now(),
  });

  if (apply && verdict.state !== 'unscanned') {
    const acts = [];
    const lab = ensureLabel(cfg.label);
    if (!lab.ok) {
      process.stdout.write(`标签「${cfg.label}」没准备好：${lab.error}\n`);
      process.exit(1);
    }
    for (const w of verdict.warn || []) {
      const r = issueEditLabels({ repo: REPO, issue: String(w.number), add: [cfg.label], host: 'devin', idempotency_key: `retire-warn-${w.number}` });
      acts.push({ number: w.number, action: 'warn', ok: !!r.ok, error: r.error || null });
    }
    for (const t of verdict.retire || []) {
      const r = issueClose({
        repo: REPO, issue: String(t.number), reason: 'not planned',
        comment: `清退（#1503 机制）：闲置 ${t.idleDays} 天且已标「${cfg.label}」——长时间没人碰，先关掉；要接着做就 reopen。`,
        host: 'devin', idempotency_key: `retire-close-${t.number}`,
      });
      acts.push({ number: t.number, action: 'retire', ok: !!r.ok, error: r.error || null });
    }
    if (json) process.stdout.write(`${JSON.stringify({ verdict, actions: acts }, null, 2)}\n`);
    else for (const a of acts) process.stdout.write(`${a.ok ? '✓' : '✗'} ${a.action} #${a.number}${a.ok ? '' : ` — ${a.error}`}\n`);
    process.exit(acts.every((a) => a.ok) ? 0 : 1);
  }

  if (json) {
    process.stdout.write(`${JSON.stringify({ config: cfg, verdict }, null, 2)}\n`);
  } else {
    const mark = verdict.state === 'green' ? '✓' : verdict.state === 'red' ? '✗' : '?';
    process.stdout.write(`${mark} 落后单清退 — ${verdict.why}\n`);
    for (const w of verdict.warn || []) process.stdout.write(`  待清退 #${w.number}（闲置 ${w.idleDays} 天）\n`);
    for (const t of verdict.retire || []) process.stdout.write(`  该清退 #${t.number}（闲置 ${t.idleDays} 天）\n`);
    process.stdout.write(`\n阈值：闲置 ${cfg.warnIdleDays} 天进名单 / ${cfg.retireIdleDays} 天清退（docs/release-policy.json 的 retire 段）\n`);
  }
  process.exit(verdict.state === 'green' ? 0 : 1);
}

main();
