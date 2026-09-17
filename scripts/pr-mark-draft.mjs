#!/usr/bin/env node
// 审官 m=manual 转 draft 的唯一入口。失败非零退出，话面写清要报帅。
import { spawnSync } from 'node:child_process';
import { planMarkDraft } from './lib/pr-mark-draft.mjs';

const pr = process.argv[2];
if (!pr) {
  process.stderr.write('用法：node scripts/pr-mark-draft.mjs <PR号>\n');
  process.exit(2);
}

const run = (argv) => {
  const r = spawnSync(argv[0], argv.slice(1), {
    encoding: 'utf8', windowsHide: true, timeout: 45000,
  });
  if (r.error) return { ok: false, error: r.error.message };
  if (r.status !== 0) {
    return { ok: false, error: String(r.stderr || r.stdout || `exit ${r.status}`).trim().slice(0, 240) };
  }
  return { ok: true, out: String(r.stdout || '') };
};

const planned = planMarkDraft({ pr, run });
if (planned.ok) {
  process.stdout.write(`PR #${pr} 已转 draft\n`);
  process.exit(0);
}
process.stderr.write(`${planned.why || planned.error}\n`);
process.exit(planned.unscanned ? 2 : 1);
