// 无 timeout 的同步子进程调用。主线程事件循环在这里停住，
// parent-alive 的 setInterval 排不上——审官红项的判别样本。
import { spawnSync } from 'node:child_process';

spawnSync(process.execPath, ['-e', 'setInterval(()=>{},1000)']);
