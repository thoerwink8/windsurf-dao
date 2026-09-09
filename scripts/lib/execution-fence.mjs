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
    const result = spawnSync('/usr/bin/flock',['-x','-n','3'],{
      stdio:['ignore','pipe','pipe',fd],timeout:2000,env:{PATH:'/usr/bin:/bin'},windowsHide:true,
    });
    if (result.error || (result.status !== 0 && result.status !== 1)) throw new Error('execution admission flock unavailable');
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
