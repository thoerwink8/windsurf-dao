// SessionStart 哨兵（2026-08-31）：换机接线自检，绿则零输出。
// 只做纯本地 stat/hash（onboard-check.mjs），不起进程、不打网络、永远 exit 0。
// 有问题只注入一行指路——修复必须过用户（AskUserQuestion），哨兵自己永不动家目录。
// 崩溃也要可见：catch 打「没查成」行，不许静默装绿（守卫崩了和守卫判通过不能一个样）。

import { checkOnboard, onboardNoticeLine } from './onboard-check.mjs';

let line;
try {
  line = onboardNoticeLine(checkOnboard({}));
} catch (e) {
  line = `[链] 换机自检没查成：${e && (e.code || e.message) || '未知错误'}（≠ 查过没事）`;
}
if (line) process.stdout.write(line + '\n');
process.exit(0);
