#!/usr/bin/env node
// skills 装载面自愈入口（#1146）。
//
//   node scripts/skills-heal.mjs            # 合并式接回
//   node scripts/skills-heal.mjs --dry-run  # 只看不动
//
// systemd 每 5 分钟跑一次：已经是真目录 + 逐个链接就 exit 0 无事可做。
// 只动 <家目录>/.claude/skills 这一层，不删 <家目录>/.mirasim/skills。
// 没查成 exit 2（跟「查过没事」分形）；接回失败 exit 1。
//
// 守的是**本机所有有 .claude/ 的家目录**，不是当前进程那一个（判据在 lib/skill-homes.mjs）。
// 2026-09-13 实咬：单元 `User=orca` 只修得住 /home/orca，而 dao-check 看的是 /root，
// root 那份被 mirasim 劫走后红了三天没人接——两个 home 各自都「对」，合起来没人管。
//
// 从临时 worktree 里不许真接回（会链到干完就删的树，见 lib/skills-mount.mjs
// isLinkedWorktree）：要预演用 --dry-run，真要接回请到主树跑。硬拦时非零退出、不落任何链接。

import { healSkillsMount } from './lib/skills-mount.mjs';
import { repoRoot } from './lib/onboard-check.mjs';
import { agentHomes } from './lib/skill-homes.mjs';

const DRY = process.argv.includes('--dry-run');
const root = repoRoot();
const say = (s) => process.stdout.write(s + '\n');

const found = agentHomes();
if (!found.ok) {
  process.stderr.write(`[skills-heal] 没查成：${found.reason}（≠ 查过没事）\n`);
  process.exit(2);
}
if (!found.homes.length) {
  // 有家目录但一个装载面都没有 = 这台机器没装执行体，不是故障，但要说出来。
  say('[skills-heal] 本机没有任何家目录带 .claude/，无装载面要守');
  process.exit(0);
}

const results = [];
let failed = 0;
for (const home of found.homes) {
  const r = healSkillsMount({ root, home, dryRun: DRY, say: (s) => say(`  [${home}] ${s}`) });
  results.push({ home, ...r });
  if (r.unscanned || !r.ok) failed++;
}

const changed = results.filter((r) => r.changed);
const kindOf = (r) => (r.unscanned ? 'unscanned' : r.kind);
const summary = results.map((r) => `${r.home}:${kindOf(r)}`).join(' ');
if (failed) {
  const bad = results.filter((r) => r.unscanned || !r.ok);
  process.stderr.write(`[skills-heal] ${bad.length}/${results.length} 个家目录没接成：${bad.map((r) => `${r.home}(${r.reason || r.error || '未知'})`).join('；')}\n`);
  process.exit(1);
}
if (!changed.length) {
  say(`[skills-heal] ${results.length} 个装载面都已是逐个链接，无事可做（${summary}）`);
  process.exit(0);
}
say(`[skills-heal] ${DRY ? '拟' : '已'}接回 ${changed.length}/${results.length} 个：${summary}`);
process.exit(0);
