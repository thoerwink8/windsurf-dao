const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const DAO = import('../scripts/dao.mjs');

describe('session-stop 后核实并回收 mirasim 子进程', () => {
  it('只回收同一 worktree 的 mirasim 后代，不碰其他树', async () => {
    const { reapMirasimSessionProcesses } = await DAO;
    const killed = [];
    let scans = 0;
    const r = reapMirasimSessionProcesses('/home/orca/mirasim-worktrees/windsurf-dao/dao-review-pr-1157', {
      scan: () => scans++ === 0 ? ({ ok: true, procs: [
        { pid: 11, cwd: '/home/orca/mirasim-worktrees/windsurf-dao/dao-review-pr-1157' },
        { pid: 12, cwd: '/home/orca/mirasim-worktrees/windsurf-dao/dao-1094' },
      ] }) : ({ ok: true, procs: [] }),
      kill: (pid) => { killed.push(`term:${pid}`); return { ok: true, pid }; },
      forceKill: (pid) => { killed.push(`kill:${pid}`); return { ok: true, pid }; },
    });
    assert.equal(r.ok, true);
    assert.deepEqual(killed, ['term:11', 'kill:11']);
  });

  it('进程观测没查成 → 不当作已清理', async () => {
    const { reapMirasimSessionProcesses } = await DAO;
    const r = reapMirasimSessionProcesses('/home/orca/mirasim-worktrees/windsurf-dao/dao-review-pr-1157', {
      scan: () => ({ ok: false, error: '权限不足' }),
    });
    assert.equal(r.ok, false);
    assert.equal(r.unscanned, true);
    assert.match(r.error, /权限不足/);
  });
});
