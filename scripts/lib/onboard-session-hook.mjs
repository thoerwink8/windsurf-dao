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

// 任务清单开场简报（2026-09-08 用户拍板）：西瓜清单 active 条目 + 进行中的计划文档，开场念出来。
// 这是简报不是守卫——有 active 条目时有输出是设计意图（今天的实咬：帅位交接后不知道清单存在）。
// 分层地图见 docs/README.md；退出机制（单全关了该收摊）在 dao-check --full 的清单退场闸。
try {
  const { readFileSync, readdirSync } = await import('node:fs');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const { initiativeLines, planDocLines, parseFrontmatter } = await import('./session-brief.mjs');
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const doc = JSON.parse(readFileSync(join(root, 'docs', 'initiatives.json'), 'utf8'));
  const dir = join(root, 'docs', 'decisions');
  const plans = readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => {
    try { return { file: `docs/decisions/${f}`, fm: parseFrontmatter(readFileSync(join(dir, f), 'utf8')) }; }
    catch { return null; }
  });
  const lines = [...initiativeLines(doc), ...planDocLines(plans)];
  if (lines.length) process.stdout.write(lines.join('\n') + '\n');
} catch (e) {
  process.stdout.write(`[清单] 开场简报没查成：${e && (e.code || e.message) || '未知错误'}（≠ 清单是空的）\n`);
}

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
