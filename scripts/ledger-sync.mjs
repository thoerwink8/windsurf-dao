#!/usr/bin/env node
// scripts/ledger-sync.mjs —— 跨机账本汇聚的命令入口（按需拉取，issue #891 期二）
//
// 事件账本机优先、不进 git（ledger-home.mjs）。这条命令按需把别的机器的
// ~/.dao/ledger/events 汇聚到本机同一落点，让播报面与看板同读一份账。
// 判据、脚本、合并全在 scripts/lib/ledger-sync.mjs（纯函数可测）；本文件只做参数与人读输出。
//
// 用法：
//   node scripts/ledger-sync.mjs --from myserver                 # 从 myserver 拉本机没有的事件
//   node scripts/ledger-sync.mjs --from myserver --from other     # 一次拉多台
//   node scripts/ledger-sync.mjs --from myserver --dry-run        # 只算不写
//   node scripts/ledger-sync.mjs --from myserver --verify         # 连同名的也取回来比内容（审计）
//   node scripts/ledger-sync.mjs --from myserver --json           # 一行 JSON
// 选项：--remote-dir <远端目录>（默认远端 ~/.dao/ledger/events）
//       --dir <本机目录>（默认本机账本落点；等价于 LEDGER_EVENTS_DIR，排障/测试用）
//
// 退出码三态（不许把没查成当通过）：
//   0 = 拉过且没事（含「新增 0」的幂等复跑）
//   1 = 真红：同名不同内容（有一边改过历史）、写盘/读回失败，或判决表漏登记状态桶
//   2 = 没查成：ssh 探不到、命令非零退出、远端目录不在或读不了、列表/内容流不完整、
//       列表与取值对不上账（missing / lost）、来件进不了账
// 归类口径只有一处：scripts/lib/ledger-sync.mjs 的 SIGNAL_CLASS。

import { resolve } from 'node:path';
import { ensureLocalLedger } from './lib/ledger-home.mjs';
import { pullFromHost, verdict, DEFAULT_REMOTE_DIR } from './lib/ledger-sync.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const argv = process.argv.slice(2);

function valuesOf(name) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === `--${name}` && argv[i + 1] != null) out.push(argv[i + 1]);
  }
  return out;
}
const valueOf = name => valuesOf(name)[0];
const has = name => argv.includes(`--${name}`);

if (has('help') || argv.length === 0) {
  process.stdout.write(
    '用法：node scripts/ledger-sync.mjs --from <ssh 别名> [--from <别名2> ...]\n' +
    '        [--remote-dir <远端目录>] [--dir <本机目录>] [--verify] [--dry-run] [--json]\n'
  );
  process.exit(argv.length === 0 ? 3 : 0);
}

const hosts = valuesOf('from');
if (hosts.length === 0) {
  process.stderr.write('缺 --from <ssh 别名>（本机 ssh 配置里的 Host 别名，免密可登）\n');
  process.exit(3);
}

const localDir = valueOf('dir')
  ? resolve(valueOf('dir'))
  : ensureLocalLedger({ root: ROOT }).dir;
const remoteDir = valueOf('remote-dir') || DEFAULT_REMOTE_DIR;
const verify = has('verify');
const apply = !has('dry-run');
const asJson = has('json');

const results = hosts.map(host => pullFromHost({ host, remoteDir, localDir, verify, apply }));
const v = verdict(results);

if (asJson) {
  process.stdout.write(JSON.stringify({
    ok: v.code === 0,
    state: v.state,
    localDir,
    remoteDir,
    verify,
    applied: apply,
    hosts: results.map(r => ({
      host: r.host,
      remoteTotal: r.remoteTotal,
      counts: r.counts,
      added: r.added.map(a => ({ name: a.name, event_id: a.event_id })),
      conflicts: r.conflicts.map(c => ({ name: c.name, why: c.why })),
      rejected: r.rejected.map(x => ({ name: x.name, why: x.why })),
      suspects: r.suspects,
      missing: r.missing,
      lost: r.lost,
      ignored: r.ignored,
      writeFailures: r.writeFailures,
      unscanned: r.unscanned,
    })),
    ...(v.unclassified ? { unclassified: v.unclassified, why: v.why } : {}),
  }) + '\n');
  process.exit(v.code);
}

process.stdout.write(`本机落点 ${localDir}\n远端目录 ${remoteDir}${verify ? '（--verify：同名也取回来比内容）' : ''}\n`);
for (const r of results) {
  if (r.unscanned.length) {
    process.stdout.write(`\n${r.host}：没查成 —— ${r.unscanned.join('；')}\n`);
    continue;
  }
  const tail = apply ? '' : '（--dry-run，没写盘）';
  process.stdout.write(
    `\n${r.host}：新增 ${r.counts.added} / 跳过 ${r.counts.skipped}${tail}` +
    `（远端 ${r.remoteTotal} 个事件文件）\n`
  );
  if (apply && r.added.length) {
    // ✓ 只许来自读回：每个 event_id 都是写完从盘上读回来算的（见 writeIncoming）
    process.stdout.write(`  读回自证：${r.added.length} 个新文件逐个读回、指纹与 event_id 一致\n`);
    for (const a of r.added.slice(0, 10)) {
      process.stdout.write(`    ${a.name}  event_id=${a.event_id}\n`);
    }
    if (r.added.length > 10) process.stdout.write(`    …另 ${r.added.length - 10} 个\n`);
  }
  if (r.ignored.length) process.stdout.write(`  远端有 ${r.ignored.length} 个非事件文件，没拉：${r.ignored.slice(0, 3).join(' ')}\n`);
  if (r.missing.length) process.stdout.write(`  没查成 远端列了但取不到 ${r.missing.length} 个（列表与取值之间被删）：${r.missing.slice(0, 3).map(m => m.name).join(' ')}\n`);
  if (r.lost.length) process.stdout.write(`  没查成 名单对不上账 ${r.lost.length} 个：${r.lost.slice(0, 3).map(m => `${m.name}（${m.why}）`).join(' ')}\n`);
  if (r.suspects.length) process.stdout.write(`  名字与内容对不上 ${r.suspects.length} 个（就地脱敏过的老事件会这样，不拦）：${r.suspects.slice(0, 3).map(s => s.name).join(' ')}\n`);
  for (const c of r.conflicts) process.stdout.write(`  真红 冲突：${c.name} —— ${c.why}\n`);
  for (const x of r.rejected) process.stdout.write(`  没查成 进不了账：${x.name} —— ${x.why}\n`);
  for (const w of r.writeFailures) process.stdout.write(`  真红 写不进：${w.name} —— ${w.why}\n`);
}
if (v.unclassified) process.stdout.write(`\n判决表漏登记：${v.why}\n`);
process.stdout.write(`\n结论：${v.state === 'ok' ? '拉过且没事' : v.state === 'red' ? '真红（要处置）' : '有没查成的（不是绿）'}\n`);
process.exit(v.code);
