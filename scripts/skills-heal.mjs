#!/usr/bin/env node
// skills 装载面自愈入口（#1146）。
//
//   node scripts/skills-heal.mjs            # 合并式接回
//   node scripts/skills-heal.mjs --dry-run  # 只看不动
//
// systemd 每 5 分钟跑一次：已经是真目录 + 逐个链接就 exit 0 无事可做。
// 只动 ~/.claude/skills 这一层，不删 ~/.mirasim/skills。
// 没查成 exit 2（跟「查过没事」分形）；接回失败 exit 1。

import { healSkillsMount } from './lib/skills-mount.mjs';
import { repoRootOfThisFile } from './lib/onboard-check.mjs';
import { defaultHome } from './lib/dao-memory-link-check.mjs';

const DRY = process.argv.includes('--dry-run');
const root = repoRootOfThisFile();
const home = defaultHome();
const say = (s) => process.stdout.write(s + '\n');

const r = healSkillsMount({ root, home, dryRun: DRY, say });
if (r.unscanned) {
  process.stderr.write(`[skills-heal] 没查成：${r.reason || '未知'}（≠ 查过没事）\n`);
  process.exit(2);
}
if (!r.ok) {
  process.stderr.write(`[skills-heal] 失败：${r.error || '未知'}\n`);
  process.exit(1);
}
if (!r.changed) {
  say('[skills-heal] 装载面已是逐个链接，无事可做');
  process.exit(0);
}
say(`[skills-heal] ${DRY ? '拟' : '已'}接回 kind=${r.kind} 仓内补=${(r.linked || []).length} 重建=${(r.rebuilt || []).length} 保留=${(r.kept || []).length}`);
process.exit(0);
