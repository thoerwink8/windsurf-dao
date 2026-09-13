// scripts/lib/proc-cwds.mjs —— /proc cwd 扫描 + 覆盖证明（#1176 审官 P1）
//
// 改这段前必须知道：readlink(/proc/pid/cwd) 失败不能一律吞掉。
// 「至少读出一条 cwd」不等于相关进程核清——本机实测大约 60/250 读得成，
// 其余几乎全是别的用户（Yama：cwd 永远 EACCES）。那些不是我们的会话/git。
//
// 相关进程 = 本身份（Uid == getuid）的进程。
//   cwd 读成 → 进名单
//   cwd ENOENT/ESRCH → 进程退了
//   别的用户 cwd 权限失败 → 预期，不在相关集合
//   本身份 cwd 权限失败、exe 却读得成 → 相关集合有洞，unscanned
//   本身份 cwd+exe 都权限失败 → 内核藏起来的（sd-pam），不在相关集合
//
// 破坏性清理必须等相关集合 denied === 0。把「任意 EACCES」当没查成，
// 这台机器上清理永远不会跑（191 个 root 进程永远读不出 cwd）。

import { readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';

/** readlink/read 失败：进程退了 vs 权限/覆盖不足。没 code 当没核清。 */
export function linkErrorKind(err) {
  const code = String((err && err.code) || '');
  if (code === 'ENOENT' || code === 'ESRCH') return 'gone';
  return 'denied';
}

function parseUid(text) {
  const m = /^Uid:\s+(\d+)/m.exec(String(text || ''));
  return m ? Number(m[1]) : null;
}

function defaultUid() {
  if (typeof process.getuid !== 'function') return null;
  try { return process.getuid(); } catch { return null; }
}

/**
 * 扫 cwd，带覆盖证明。
 *
 * @returns {{ok:true, cwds:string[], entries:Array, pids:number[], resolved:number, total:number, gone:number, hidden:number, foreign:number, denied:number}
 *          |{ok:false, unscanned:true, error:string, cwds?:string[], entries?:Array, pids?:number[], resolved?:number, total?:number, gone?:number, hidden?:number, foreign?:number, denied?:number}}
 */
export function scanProcCwds({
  procDir = '/proc',
  readdir = readdirSync,
  readlink = readlinkSync,
  read = readFileSync,
  getuid = defaultUid,
} = {}) {
  let names;
  try { names = readdir(procDir); } catch (e) {
    return { ok: false, unscanned: true, error: `${procDir} 读不动：${String(e && e.message || e)}` };
  }
  const pids = names.filter((n) => /^\d+$/.test(String(n)));
  if (!pids.length) {
    return { ok: false, unscanned: true, error: `${procDir} 下一个 pid 都没有——没查成` };
  }

  const selfUid = typeof getuid === 'function' ? getuid() : getuid;
  const cwds = [];
  const entries = [];
  let gone = 0;
  let hidden = 0;
  let foreign = 0;
  const denied = [];

  const link = (pid, leaf) => readlink(join(procDir, String(pid), leaf));

  for (const pid of pids) {
    try {
      const cwd = String(link(pid, 'cwd')).replace(/\/+$/, '');
      cwds.push(cwd);
      entries.push({ pid: Number(pid), cwd });
      continue;
    } catch (e) {
      if (linkErrorKind(e) === 'gone') { gone += 1; continue; }
    }

    let uid = null;
    try {
      uid = parseUid(read(join(procDir, String(pid), 'status'), 'utf8'));
    } catch (e) {
      if (linkErrorKind(e) === 'gone') { gone += 1; continue; }
      denied.push({ pid: Number(pid), why: 'status 读失败' });
      continue;
    }
    if (uid == null) {
      denied.push({ pid: Number(pid), why: 'status 没有 Uid' });
      continue;
    }
    if (selfUid == null || !Number.isFinite(Number(selfUid))) {
      denied.push({ pid: Number(pid), why: 'getuid 不可用，权限失败分不出自己和别人' });
      continue;
    }
    if (Number(uid) !== Number(selfUid)) { foreign += 1; continue; }

    try {
      link(pid, 'exe');
      denied.push({ pid: Number(pid), why: 'cwd 权限失败但 exe 读得成' });
    } catch (e) {
      if (linkErrorKind(e) === 'gone') { gone += 1; continue; }
      hidden += 1;
    }
  }

  const stats = {
    cwds, entries, pids: pids.map(Number),
    resolved: cwds.length, total: pids.length,
    gone, hidden, foreign, denied: denied.length,
  };
  if (denied.length) {
    return {
      ok: false,
      unscanned: true,
      error: `本身份 ${denied.length} 个进程 cwd 没核清（已读 ${cwds.length}/${pids.length}）：${denied[0].why}`,
      ...stats,
    };
  }
  if (!cwds.length) {
    return {
      ok: false,
      unscanned: true,
      error: `扫了 ${pids.length} 个进程，一个 cwd 都读不出来——没查成`,
      ...stats,
    };
  }
  return { ok: true, ...stats };
}
