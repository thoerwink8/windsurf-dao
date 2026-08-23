// tests/fixtures/fake-reviewer-create.mjs —— watchdog 自动起审官测试钩（delete-ack-layer）
//
// 背景：默认快照绝不能调真 dao.mjs reviewer-create（会建真卡）。
// 测试注入 WATCHDOG_REVIEWER_CREATE 指向本脚本，证明 missing-reviewer 真的带
// --pr / --reviewer / --parent-worktree 去起审官。生产不设该变量。

import { appendFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
let pr = null;
let reviewer = null;
let parent = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--pr') {
    pr = args[++i] || '';
    continue;
  }
  if (args[i] === '--reviewer') {
    reviewer = args[++i] || '';
    continue;
  }
  if (args[i] === '--parent-worktree') {
    parent = args[++i] || '';
    continue;
  }
  process.stderr.write(`fake-reviewer-create: 未预期参数 ${args[i]}`);
  process.exit(1);
}
if (!pr) {
  process.stderr.write('fake-reviewer-create: 要 --pr');
  process.exit(1);
}
if (!reviewer) {
  process.stderr.write('fake-reviewer-create: 要 --reviewer');
  process.exit(1);
}

const log = process.env.WATCHDOG_REVIEWER_CREATE_LOG;
const mark = process.env.WATCHDOG_REVIEWER_CREATE_MARK;
const line = `--pr ${pr} --reviewer ${reviewer}${parent ? ` --parent-worktree ${parent}` : ''}\n`;
if (log) appendFileSync(log, line);
if (mark) writeFileSync(mark, line);
process.stdout.write(JSON.stringify({ ok: true, pr, reviewer, parent }));
process.exit(0);
