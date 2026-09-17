// Shared runtime/updater admission protocol (Linux):
// 1. Open <stateDir>/admission.lock O_RDONLY|O_CREAT|O_NOFOLLOW, mode 0644.
// 2. spawnSync /usr/bin/flock -x -n 3, with that open fd inherited as child fd 3.
// 3. Exit 0 owns the lock on the shared open-file description. Keep the PARENT fd
//    open throughout the critical section; release by closing it, NEVER unlink.
// 4. Protect maintenance changes and durable registry/lease mutations with it.
//    Do not hold it across backend/network work. Pending/uncertain/stopping records
//    remain busy regardless of owner PID. The updater must inspect them when draining.
// O_RDONLY permits both root and the service user to flock the same 0644 inode.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';

export const FLOCK_TIMEOUT_MS = 2000;

// 「锁被别人占着」走的是 status===1 那条、不抛。所以抛出来的一定是 flock 本身没跑成：
// 起不来（ENOENT/EAGAIN）、跑满 2000ms 超时、或被信号杀。三者后果与修法都不同，
// 而原先一律只说 'flock unavailable'——谁看见都只能猜（#1358 与帅位各猜一个方向，都没验成）。
// 判据不变，只把现场带出来：下一次抖动要能一锤定音，不必再复现一轮。纯函数，便于直接喂样本。
export function describeFenceFailure(result,{elapsedMs,lockPath,timeoutMs}={}) {
  const why = result?.error ? (result.error.code || result.error.message)
    : result?.signal ? `killed by ${result.signal}` : `exit status ${result?.status}`;
  const at = Number.isFinite(elapsedMs) ? `${elapsedMs.toFixed(0)}ms` : '耗时未知';
  return `execution admission flock unavailable: ${why} (${at}, timeout ${timeoutMs}ms, ${lockPath})`;
}

export function acquireExecutionFence({stateDir} = {}) {
  if (process.platform !== 'linux') throw new Error('execution fence requires Linux flock');
  if (!stateDir || !path.isAbsolute(stateDir)) throw new Error('execution fence requires an absolute stateDir');
  fs.mkdirSync(stateDir,{recursive:true,mode:0o755});
  const lockPath = path.join(stateDir,'admission.lock');
  const fd = fs.openSync(lockPath,fs.constants.O_RDONLY|fs.constants.O_CREAT|fs.constants.O_NOFOLLOW,0o644);
  let transferred = false;
  try {
    const stat=fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error('execution admission lock is not a regular file');
    if ((stat.mode & 0o777) !== 0o644 && (stat.uid === process.getuid() || process.getuid() === 0)) fs.fchmodSync(fd,0o644);
    const startedAt = process.hrtime.bigint();
    const result = spawnSync('/usr/bin/flock',['-x','-n','3'],{
      stdio:['ignore','pipe','pipe',fd],timeout:FLOCK_TIMEOUT_MS,env:{PATH:'/usr/bin:/bin'},windowsHide:true,
    });
    if (result.error || (result.status !== 0 && result.status !== 1)) throw new Error(describeFenceFailure(result,{
      elapsedMs:Number(process.hrtime.bigint()-startedAt)/1e6,lockPath,timeoutMs:FLOCK_TIMEOUT_MS,
    }));
    if (result.status === 1) return {ok:false,busy:true,reason:'admission-held',path:lockPath};
    let released = false;
    const release = () => {
      if (released) return;
      released = true; process.removeListener('exit',release); fs.closeSync(fd);
    };
    process.once('exit',release);
    transferred = true;
    return {ok:true,path:lockPath,fd,release};
  } finally { if (!transferred) fs.closeSync(fd); }
}

export async function withExecutionFence({stateDir,timeoutMs=5000,retryMs=10} = {}, fn) {
  if (typeof fn !== 'function' || !Number.isFinite(timeoutMs) || timeoutMs < 0) throw new Error('invalid execution fence request');
  const deadline = Date.now()+timeoutMs;
  for (;;) {
    const held = acquireExecutionFence({stateDir});
    if (held.ok) { try { return await fn(); } finally { held.release(); } }
    if (Date.now() >= deadline) {
      const error = new Error('execution admission is being updated');
      error.code='busy'; error.detail={busy:true,reason:'admission-held'}; throw error;
    }
    await new Promise(resolve=>setTimeout(resolve,Math.max(1,retryMs)));
  }
}

// Record content reaches disk before the atomic rename; fsync the parent as well.
export function writeExecutionRecord(file,value) {
  fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
  const temp=file+'.'+crypto.randomUUID()+'.tmp';
  let fd;
  try {
    fd=fs.openSync(temp,'wx',0o600);
    fs.writeFileSync(fd,JSON.stringify(value,null,2)+'\n'); fs.fsyncSync(fd); fs.closeSync(fd); fd=undefined;
    fs.renameSync(temp,file);
    const directory=fs.openSync(path.dirname(file),'r');
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  } finally { if(fd!==undefined)fs.closeSync(fd);try{fs.unlinkSync(temp);}catch(e){if(e.code!=='ENOENT')throw e;} }
}
