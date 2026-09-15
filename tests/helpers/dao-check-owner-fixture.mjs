// 模拟 dao-check：本进程是 owner，再拉起一个卡在同步调用里的孩子。
// 文件名带 dao-check，cmdline 才能对上 OWNER_TOKEN。
import { spawn } from 'node:child_process';
import { writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OWNER_PID_ENV, OWNER_TOKEN_ENV, OWNER_TOKEN, OWNER_POLL_ENV } from '../../scripts/lib/test-child-guard.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const childPath = join(here, 'sync-block.mjs');
const preload = process.env.DAO_SYNC_BLOCK_PRELOAD;
if (!preload) {
  throw new Error('DAO_SYNC_BLOCK_PRELOAD 没设——孩子装不上 parent-alive，这条夹具什么都验不到');
}

const child = spawn(process.execPath, [childPath], {
  stdio: 'ignore',
  env: {
    ...process.env,
    [OWNER_PID_ENV]: String(process.pid),
    [OWNER_TOKEN_ENV]: OWNER_TOKEN,
    [OWNER_POLL_ENV]: process.env[OWNER_POLL_ENV] || '100',
    NODE_OPTIONS: `--import ${preload}`,
  },
});
writeSync(1, String(child.pid) + '\n');
setInterval(() => {}, 1000);
