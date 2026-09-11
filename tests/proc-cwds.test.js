// /proc cwd 覆盖证明（#1176 审官 P1）。
// 旧判据「至少读出一条 cwd 就算 ok」会在 60/249 时放行删除。
import test from 'node:test';
import assert from 'node:assert/strict';
import { scanProcCwds, linkErrorKind } from '../scripts/lib/proc-cwds.mjs';

const UID = 999;
const ROOT_UID = 0;

function err(code) {
  const e = new Error(code);
  e.code = code;
  return e;
}

function statusOf(uid) {
  return `Name:\tfoo\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\n`;
}

function io({ cwd = {}, exe = {}, uid = {}, extraRead } = {}) {
  const pids = [...new Set([...Object.keys(cwd), ...Object.keys(exe), ...Object.keys(uid)])];
  return {
    procDir: '/proc',
    getuid: () => UID,
    readdir: () => pids,
    readlink: (p) => {
      const m = /\/(\d+)\/(cwd|exe)$/.exec(String(p).replace(/\\/g, '/'));
      if (!m) throw new Error(`unexpected readlink ${p}`);
      const table = m[2] === 'cwd' ? cwd : exe;
      const v = table[m[1]];
      if (v instanceof Error) throw v;
      if (v == null) throw err('ENOENT');
      return v;
    },
    read: (p) => {
      if (extraRead) {
        const hit = extraRead(p);
        if (hit !== undefined) return hit;
      }
      const m = /\/(\d+)\/status$/.exec(String(p).replace(/\\/g, '/'));
      if (!m) throw err('ENOENT');
      const id = uid[m[1]];
      if (id instanceof Error) throw id;
      if (id == null) throw err('ENOENT');
      return statusOf(id);
    },
  };
}

test('linkErrorKind：ENOENT/ESRCH 是退了，其余是没核清', () => {
  assert.equal(linkErrorKind(err('ENOENT')), 'gone');
  assert.equal(linkErrorKind(err('ESRCH')), 'gone');
  assert.equal(linkErrorKind(err('EACCES')), 'denied');
  assert.equal(linkErrorKind(new Error('gone')), 'denied');
});

test('全部 cwd 读成 → ok', () => {
  const r = scanProcCwds(io({
    cwd: { 10: '/wt/a', 11: '/wt/b/' },
  }));
  assert.equal(r.ok, true);
  assert.deepEqual(r.cwds, ['/wt/a', '/wt/b']);
  assert.equal(r.denied, 0);
});

test('/proc 读不动 → unscanned', () => {
  const r = scanProcCwds({
    readdir: () => { throw err('EACCES'); },
    readlink: () => '',
    read: () => '',
    getuid: () => UID,
  });
  assert.equal(r.ok, false);
  assert.equal(r.unscanned, true);
  assert.match(r.error, /读不动/);
});

test('一个 cwd 都读不出 → unscanned，不是 0 条占用', () => {
  const r = scanProcCwds(io({
    cwd: { 1: err('ENOENT'), 2: err('ENOENT') },
  }));
  assert.equal(r.ok, false);
  assert.equal(r.unscanned, true);
  assert.equal(r.denied, 0);
  assert.match(r.error, /没查成/);
});

test('别人的进程 cwd EACCES → 仍 ok（Yama 预期，不是没查成）', () => {
  const r = scanProcCwds(io({
    cwd: { 1: err('EACCES'), 10: '/wt/a' },
    exe: { 1: err('EACCES') },
    uid: { 1: ROOT_UID },
  }));
  assert.equal(r.ok, true);
  assert.equal(r.foreign, 1);
  assert.equal(r.denied, 0);
  assert.deepEqual(r.cwds, ['/wt/a']);
});

test('本身份 cwd 权限失败但 exe 读得成 → unscanned（部分覆盖回归）', () => {
  const r = scanProcCwds(io({
    cwd: { 10: '/wt/a', 11: err('EACCES') },
    exe: { 11: '/usr/bin/node' },
    uid: { 11: UID },
  }));
  assert.equal(r.ok, false);
  assert.equal(r.unscanned, true);
  assert.equal(r.denied, 1);
  assert.equal(r.resolved, 1);
  assert.equal(r.total, 2);
  assert.match(r.error, /没核清/);
  assert.match(r.error, /exe 读得成/);
});

test('本身份 cwd+exe 都权限失败 → hidden，仍 ok（sd-pam）', () => {
  const r = scanProcCwds(io({
    cwd: { 10: '/wt/a', 12: err('EACCES') },
    exe: { 12: err('EACCES') },
    uid: { 12: UID },
  }));
  assert.equal(r.ok, true);
  assert.equal(r.hidden, 1);
  assert.equal(r.denied, 0);
  assert.deepEqual(r.cwds, ['/wt/a']);
});

test('cwd 失败后进程退了（status ENOENT）→ gone，仍 ok', () => {
  const r = scanProcCwds(io({
    cwd: { 10: '/wt/a', 13: err('EACCES') },
    uid: { 13: err('ENOENT') },
  }));
  assert.equal(r.ok, true);
  assert.equal(r.gone, 1);
  assert.equal(r.denied, 0);
});

test('getuid 不可用时权限失败分不出自己和别人 → unscanned', () => {
  const r = scanProcCwds({
    ...io({
      cwd: { 10: '/wt/a', 11: err('EACCES') },
      uid: { 11: UID },
      exe: { 11: '/usr/bin/node' },
    }),
    getuid: () => null,
  });
  assert.equal(r.ok, false);
  assert.equal(r.unscanned, true);
  assert.match(r.error, /getuid 不可用/);
});
