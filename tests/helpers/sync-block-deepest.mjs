// 最深层：显式覆盖 NODE_OPTIONS，装不上 parent-alive。自己再卡在无 timeout
// 的 spawnSync 上。owner 死后只能靠看门狗按树清，不能靠本进程自杀。
import { spawn, spawnSync } from 'node:child_process';
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

const cleanEnv = {
  PATH: process.env.PATH || '/usr/bin:/bin',
  HOME: process.env.HOME || '',
  NODE_OPTIONS: '',
};

const hang = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
  stdio: 'ignore',
  env: cleanEnv,
});
patch({ deepest: process.pid, hang: hang.pid });
spawnSync(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { env: cleanEnv });
