// tests/fixtures/fake-watchdog-gh.mjs —— 看门狗报帅写 GitHub 的假 gh（#673）
//
// 测试注入 WATCHDOG_GH_AS 指向本脚本，才能在不碰真 GitHub 的前提下证明：
//   报帅会发评论、去重不刷、缺目标/失败分得开。
// 生产不设该变量（同仓先例：WATCHDOG_ORPHAN_RM / DAO_GH_FAKE）。
//
// 只实现看门狗用到的调用面：api .../comments、pr comment、issue comment。
// 其它调用 fail-loud。WATCHDOG_GH_AS_LOG 记 JSON 行；WATCHDOG_GH_AS_COMMENTS 是
// 已有评论的 JSON 文件；WATCHDOG_GH_AS_FAIL=list|comment|all 模拟失败。

import { appendFileSync, readFileSync, existsSync } from 'node:fs';

const args = process.argv.slice(2);
const fail = process.env.WATCHDOG_GH_AS_FAIL || '';
const log = process.env.WATCHDOG_GH_AS_LOG;

function record(extra = {}) {
  if (!log) return;
  appendFileSync(log, JSON.stringify({ args, ...extra }) + '\n');
}

function die(msg) {
  record({ error: msg });
  process.stderr.write(msg);
  process.exit(1);
}

if (fail === 'all') die('fake-watchdog-gh: 模拟 gh 失败（all）');

const isList = args[0] === 'api' && /\/comments$/.test(String(args[1] || ''));
const isPrComment = args[0] === 'pr' && args[1] === 'comment';
const isIssueComment = args[0] === 'issue' && args[1] === 'comment';

if (isList) {
  if (fail === 'list') die('fake-watchdog-gh: 模拟评论列表没查成');
  record({ kind: 'list' });
  const src = process.env.WATCHDOG_GH_AS_COMMENTS;
  if (src && existsSync(src)) {
    process.stdout.write(readFileSync(src, 'utf8'));
  } else {
    process.stdout.write('[]');
  }
  process.exit(0);
}

if (isPrComment || isIssueComment) {
  if (fail === 'comment') die('fake-watchdog-gh: 模拟写评论失败');
  const n = args[2];
  let body = '';
  for (let i = 3; i < args.length; i++) {
    if (args[i] === '--body' && args[i + 1] != null) {
      body = args[i + 1];
      break;
    }
  }
  record({ kind: isPrComment ? 'pr-comment' : 'issue-comment', number: n, body });
  process.stdout.write(JSON.stringify({ id: 1, number: Number(n) }));
  process.exit(0);
}

die(`fake-watchdog-gh: 未预期的调用 ${args.join(' ')}`);
