// 两层同步阻塞的中间层。自己卡在 spawnSync 上，孩子显式清掉 NODE_OPTIONS。
// 顺手起一个 detached 孩子：owner-death 必须留着它（ACP）。
import { spawn, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync } from 'node:fs';

const pidFile = process.env.DAO_TREE_PID_FILE;
if (!pidFile) {
  throw new Error('DAO_TREE_PID_FILE 没设——这条夹具写不出 pid，测试验的是空气');
}

function patch(partial) {
  let cur = {};
  try { cur = JSON.parse(readFileSync(pidFile, 'utf8')); } catch { cur = {}; }
  writeFileSync(pidFile, JSON.stringify({ ...cur, ...partial }));
}

const detached = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
  stdio: 'ignore',
  detached: true,
  env: { PATH: process.env.PATH || '/usr/bin:/bin', HOME: process.env.HOME || '' },
});
detached.unref();
patch({ middle: process.pid, detached: detached.pid });

const deepest = join(dirname(fileURLToPath(import.meta.url)), 'sync-block-deepest.mjs');
spawnSync(process.execPath, [deepest], {
  env: {
    PATH: process.env.PATH || '/usr/bin:/bin',
    HOME: process.env.HOME || '',
    DAO_TREE_PID_FILE: pidFile,
    NODE_OPTIONS: '',
  },
});
