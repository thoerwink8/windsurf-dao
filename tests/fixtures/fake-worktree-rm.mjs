// tests/fixtures/fake-worktree-rm.mjs —— watchdog 孤儿真删测试钩（#630）
//
// 背景：快照夹具的 worktreeId 长得像本机真路径，默认快照绝不能调真 dao.mjs worktree-rm。
// 测试注入 WATCHDOG_ORPHAN_RM 指向本脚本，才能在不碰真树的前提下证明：
//   真孤儿会带 --force 调删、假孤儿不调、--dispose-actions off 不调。
// 生产不设该变量（同仓先例：DAO_GH_FAKE）。
//
// 只接受 worktree-rm 形态：--worktree <id> --force。其它调用 fail-loud。
// WATCHDOG_ORPHAN_RM_LOG 记录调用；WATCHDOG_ORPHAN_RM_MARK 是测试造的「树」（文件或目录），
// 被调用时删掉——断言「树真的被删了」认这个标记，不认夹具目录。

import { appendFileSync, rmSync } from 'node:fs';

const args = process.argv.slice(2);
let worktree = null;
let force = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--worktree') {
    worktree = args[++i] || '';
    continue;
  }
  if (args[i] === '--force') {
    force = true;
    continue;
  }
  process.stderr.write(`fake-worktree-rm: 未预期参数 ${args[i]}`);
  process.exit(1);
}
if (!worktree) {
  process.stderr.write('fake-worktree-rm: 要 --worktree');
  process.exit(1);
}
if (!force) {
  process.stderr.write('fake-worktree-rm: 要 --force（#630 真删必须带 --force）');
  process.exit(1);
}

const log = process.env.WATCHDOG_ORPHAN_RM_LOG;
const mark = process.env.WATCHDOG_ORPHAN_RM_MARK;
if (log) appendFileSync(log, `--worktree ${worktree} --force\n`);
if (mark) rmSync(mark, { recursive: true, force: true });
process.stdout.write(JSON.stringify({ ok: true, removed: [worktree] }));
process.exit(0);
