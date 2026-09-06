#!/usr/bin/env node
// 并发抢审官锁的样本进程（tests/mirasim-reviewer.test.js 用）。
//
// 必须是**跨进程**：dispatch-lock 的等待是同步自旋（busy-wait），同一个进程里用
// Promise.all 并发会把事件循环焊死——先拿到锁的那个 await 永远回不来，直到锁超时。
// 真实场景本来就是两个 node 进程（两棵树各跑一次 reviewer-create），照真实场景测。
//
// 用法：node reviewer-race.mjs <lockPath> <flowDir> <pr> <标记>
// 输出：一行 JSON —— {outcome:'created'|'raced'|'lock-failed', mark}

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultReviewerRegistry } from '../../scripts/lib/dispatch/reviewer-mirasim.mjs';
import { withWorktreeLock } from '../../scripts/lib/dispatch-lock.mjs';

const [lockPath, flowDir, pr, mark] = process.argv.slice(2);

const registry = defaultReviewerRegistry({
  readFile: (p) => readFileSync(p, 'utf8'),
  writeFile: (p, c) => writeFileSync(p, c, 'utf8'),
  mkdir: (d) => mkdirSync(d, { recursive: true }),
  join,
  flowDir,
});

// 与 cmdReviewerCreateMirasim 同一形状：锁内复查 → 没有才「起会话」→ 起完写登记。
const got = await withWorktreeLock(async () => {
  const again = registry.read(pr);
  if (again.ok && again.record && again.record.sessionKey) return { outcome: 'raced' };
  // 「起会话」在真实代码里是一次网络往返，这里用一段可观测的耗时代替：
  // 没有锁的话，另一个进程正好在这个窗口里也读到 missing。
  const until = Date.now() + 300;
  while (Date.now() < until) { /* 占住临界区 */ }
  registry.write(pr, { pr, sessionKey: `codex:${mark}` });
  return { outcome: 'created' };
}, { lockPath, timeoutMs: 20000 });

if (got && got.ok === false && got.locked === false) {
  process.stdout.write(JSON.stringify({ outcome: 'lock-failed', mark, error: got.error }) + '\n');
} else {
  process.stdout.write(JSON.stringify({ ...got, mark }) + '\n');
}
