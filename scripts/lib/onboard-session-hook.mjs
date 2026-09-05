// SessionStart 哨兵（2026-08-31）：换机接线自检，绿则零输出。
// 只做纯本地 stat/hash（onboard-check.mjs），不起进程、不打网络、永远 exit 0。
// 有问题只注入一行指路——修复必须过用户（AskUserQuestion），哨兵自己永不动家目录。
// 崩溃也要可见：catch 打「没查成」行，不许静默装绿（守卫崩了和守卫判通过不能一个样）。

import { spawnSync } from 'node:child_process';
import { checkOnboard, onboardNoticeLine } from './onboard-check.mjs';
import { landNoticeLine } from './land-core.mjs';

let line;
try {
  line = onboardNoticeLine(checkOnboard({}));
} catch (e) {
  line = `[链] 换机自检没查成：${e && (e.code || e.message) || '未知错误'}（≠ 查过没事）`;
}
if (line) process.stdout.write(line + '\n');

// 收工提醒（2026-09-01 拍板按帅方案走）：默认分支确有未推提交才给一行，其余零输出。
// 这是提醒不是守卫/闸——探不出（无 origin、git 不在、游离 HEAD）就沉默，不打「没查成」。
// 起的是一次性 git 子进程读本地 refs，不打网络，与哨兵「绿则零输出」纪律一致。
try {
  const g = (args) => String(spawnSync('git', args, { windowsHide: true, encoding: 'utf8', timeout: 5000 }).stdout || '').trim();
  const branch = g(['rev-parse', '--abbrev-ref', 'HEAD']);
  const def = (g(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).replace(/^origin\//, '')) || 'master';
  const ahead = Number(g(['rev-list', '--count', `origin/${def}..HEAD`]));
  const l2 = landNoticeLine({ branch, defaultBranch: def, ahead });
  if (l2) process.stdout.write(l2 + '\n');
} catch { /* 提醒探不出就沉默 */ }
process.exit(0);
