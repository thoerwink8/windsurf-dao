// 故意违规样本（#1152）：执行体 env 丢失。
// spawn dao dispatch 不带 --dry-run，env 对象不继承 process.env、
// 也不带 NODE_TEST_CONTEXT / DAO_DISPATCH_NO_SPAWN——子进程读真账本，#565 无在途就真派工。
const { spawnSync } = require('node:child_process');
spawnSync(process.execPath, [
  'scripts/dao.mjs', 'dispatch', '--executor', 'mirasim',
  '--issue', '565', '--spec', '短摘要', '--name', 'x',
  '--model', 'grok-4.6', '--reviewer', 'gpt-5.6-sol', '--confirm',
  '--split', 'no', '--split-reason', '单测',
], {
  encoding: 'utf8',
  env: { PATH: '/usr/bin', HOME: '/tmp' },
});
