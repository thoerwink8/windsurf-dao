// tests/worker-done-cleanup.test.js —— #1400 worker-done 清退范围
// 全部假 runtime，不许对生产主树或真会话发 stop。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLEAN = import('file://' + join(REPO, 'scripts/lib/dispatch/worker-done-cleanup.mjs'));

const MAIN = '/srv/projects/windsurf-dao';
const NEST_A = `${MAIN}/.claude/worktrees/fix-dup-label`;
const NEST_B = `${MAIN}/.claude/worktrees/other-task`;
const WORKER = '/home/orca/mirasim-worktrees/windsurf-dao/dao-1400';
const REVIEWER = '/home/orca/mirasim-worktrees/windsurf-dao/dao-review-pr-1400';
const OTHER = '/home/orca/mirasim-worktrees/windsurf-dao/dao-1367';

const IDENTITY = {
  pr: 1400,
  issue: 1400,
  headRefName: 'dao-1400',
  mainCheckout: MAIN,
};

const SESSIONS = [
  { sessionKey: 'claude:worker-1400', cwd: WORKER, pr: 1400, issue: 1400, state: 'running' },
  { sessionKey: 'codex:reviewer-1400', cwd: REVIEWER, pr: 1400, title: '审官·gpt', state: 'running' },
  { sessionKey: 'claude:other-1367', cwd: OTHER, pr: 1367, issue: 1367, state: 'running' },
  { sessionKey: 'claude:nest-a', cwd: NEST_A, pr: 1299, state: 'running' },
  { sessionKey: 'claude:nest-b', cwd: NEST_B, pr: 1300, state: 'running' },
  { sessionKey: 'claude:later-holder', cwd: WORKER, pr: 1500, issue: 1500, state: 'running' },
  { sessionKey: 'claude:old-done', cwd: WORKER, pr: 1400, issue: 1400, state: 'stopped', cleanupVerified: true },
];

function legacyCwdPrefixHits(sessions, cwd) {
  const want = String(cwd || '').replace(/\\/g, '/').replace(/\/+$/, '');
  return sessions.filter((s) => {
    const c = String((s && (s.cwd || s.workdir || s.worktree)) || '').replace(/\\/g, '/').replace(/\/+$/, '');
    return c && (c === want || c.startsWith(`${want}/`));
  });
}

function fakeRuntime(sessions, { listOk = true, listError, stopOk = true } = {}) {
  const stops = [];
  return {
    stops,
    listed: 0,
    async listSessions() {
      this.listed += 1;
      if (listOk === false) return { ok: false, error: listError || '上游不可用' };
      return { ok: true, sessions };
    },
    async stopSession(key, opts) {
      stops.push({ key, workdir: opts && opts.workdir });
      if (stopOk === false) return { ok: false, why: 'stop 被拒' };
      return { ok: true };
    },
  };
}

describe('旧 cwd 前缀负控（修前会误杀）', () => {
  it('主树前缀会命中两个嵌套 worktree，不含本 PR 工人判定', () => {
    const hits = legacyCwdPrefixHits(SESSIONS, MAIN).map((s) => s.sessionKey);
    assert.deepEqual(hits, ['claude:nest-a', 'claude:nest-b']);
    assert.equal(hits.includes('codex:reviewer-1400'), false);
    assert.equal(hits.includes('claude:other-1367'), false);
  });
});

describe('归属规划：主树 / 错树拒绝', () => {
  it('主树 match=false，refuseReason=main-tree', async () => {
    const { judgeWorkerDoneCleanupScope } = await CLEAN;
    const scope = judgeWorkerDoneCleanupScope({ cwd: MAIN, ...IDENTITY });
    assert.equal(scope.ok, true);
    assert.equal(scope.match, false);
    assert.equal(scope.refuseReason, 'main-tree');
  });

  it('审官树拒绝', async () => {
    const { judgeWorkerDoneCleanupScope } = await CLEAN;
    const scope = judgeWorkerDoneCleanupScope({ cwd: REVIEWER, ...IDENTITY });
    assert.equal(scope.match, false);
    assert.equal(scope.refuseReason, 'reviewer-tree');
  });

  it('其他 issue 工人树拒绝', async () => {
    const { judgeWorkerDoneCleanupScope } = await CLEAN;
    const scope = judgeWorkerDoneCleanupScope({ cwd: OTHER, ...IDENTITY });
    assert.equal(scope.match, false);
    assert.equal(scope.refuseReason, 'wrong-tree');
  });

  it('缺 PR 号是没查成，不是放行', async () => {
    const { judgeWorkerDoneCleanupScope } = await CLEAN;
    const scope = judgeWorkerDoneCleanupScope({ cwd: WORKER, issue: 1400, mainCheckout: MAIN });
    assert.equal(scope.ok, false);
    assert.equal(scope.unscanned, true);
    assert.equal(scope.match, false);
  });

  it('本 PR 工人树 match=true', async () => {
    const { judgeWorkerDoneCleanupScope } = await CLEAN;
    const scope = judgeWorkerDoneCleanupScope({ cwd: WORKER, ...IDENTITY });
    assert.equal(scope.match, true);
    assert.equal(scope.workerCwd, WORKER);
  });
});

describe('假 runtime：主树零 stop，工人只停自己', () => {
  const PATHS = ['first', 'rework', 'halt'];

  it('主树调用：三条路径都不 list、不 stop，显式拒绝', async () => {
    const { stopWorkerDoneSessions } = await CLEAN;
    for (const pathName of PATHS) {
      const rt = fakeRuntime(SESSIONS);
      const r = await stopWorkerDoneSessions(rt, MAIN, IDENTITY, {
        stopOne: async (key, workdir) => rt.stopSession(key, { workdir }),
      });
      assert.equal(r.ok, true, pathName);
      assert.equal(r.refused, true, pathName);
      assert.equal(r.refuseReason, 'main-tree', pathName);
      assert.equal(r.stopCount, 0, pathName);
      assert.equal(rt.listed, 0, pathName);
      assert.deepEqual(rt.stops, [], pathName);
    }
  });

  it('工人树：只停本 PR 工人一次；审官/其他PR/嵌套/后来者/已完成 0 次', async () => {
    const { stopWorkerDoneSessions } = await CLEAN;
    for (const pathName of PATHS) {
      const rt = fakeRuntime(SESSIONS);
      const r = await stopWorkerDoneSessions(rt, WORKER, IDENTITY, {
        stopOne: async (key, workdir) => rt.stopSession(key, { workdir }),
      });
      assert.equal(r.ok, true, pathName);
      assert.equal(r.refused, undefined, pathName);
      assert.equal(r.stopCount, 1, pathName);
      assert.deepEqual(r.stopped.map((x) => x.sessionKey), ['claude:worker-1400']);
      assert.deepEqual(rt.stops, [{ key: 'claude:worker-1400', workdir: WORKER }]);
    }
  });

  it('修后负控：旧前缀命中的嵌套会话 stop 次数为 0', async () => {
    const { stopWorkerDoneSessions } = await CLEAN;
    const legacyKeys = legacyCwdPrefixHits(SESSIONS, MAIN).map((s) => s.sessionKey);
    const rt = fakeRuntime(SESSIONS);
    const r = await stopWorkerDoneSessions(rt, MAIN, IDENTITY, {
      stopOne: async (key, workdir) => rt.stopSession(key, { workdir }),
    });
    assert.equal(r.stopCount, 0);
    for (const key of legacyKeys) {
      assert.equal(rt.stops.some((s) => s.key === key), false, key);
    }
    assert.equal(rt.stops.some((s) => s.key === 'codex:reviewer-1400'), false);
    assert.equal(rt.stops.some((s) => s.key === 'claude:other-1367'), false);
  });
});

describe('部分失败假成功', () => {
  it('清单没查成：非零形态，stop 0 次', async () => {
    const { stopWorkerDoneSessions } = await CLEAN;
    const rt = fakeRuntime(SESSIONS, { listOk: false, listError: '上游不可用' });
    const r = await stopWorkerDoneSessions(rt, WORKER, IDENTITY, {
      stopOne: async (key, workdir) => rt.stopSession(key, { workdir }),
    });
    assert.equal(r.ok, false);
    assert.equal(r.unscanned, true);
    assert.match(r.error, /上游不可用|清单没查成/);
    assert.equal(r.stopCount, 0);
    assert.deepEqual(rt.stops, []);
  });

  it('stop 返回 ok:false：partial，不是抛异常才失败', async () => {
    const { stopWorkerDoneSessions, workerDoneCleanupFailExtra } = await CLEAN;
    const rt = fakeRuntime(SESSIONS, { stopOk: false });
    const r = await stopWorkerDoneSessions(rt, WORKER, IDENTITY, {
      stopOne: async (key, workdir) => rt.stopSession(key, { workdir }),
    });
    assert.equal(r.ok, false);
    assert.equal(r.partial, true);
    assert.equal(r.stopCount, 1);
    assert.equal(r.stopped[0].ok, false);
    const extra = workerDoneCleanupFailExtra(r, {
      postedIssue: { ok: true },
      postedPr: { ok: true },
      action: 'queued-for-review',
      reviewPending: { path: '/tmp/12.json' },
    });
    assert.equal(extra.commentPosted, true);
    assert.equal(extra.cleanup, 'failed');
    assert.equal(extra.postedIssue.ok, true);
    assert.equal(extra.postedPr.ok, true);
    assert.equal(extra.action, 'queued-for-review');
    assert.equal(extra.reviewPending.path, '/tmp/12.json');
    assert.equal(extra.stopped.ok, false);
  });
});

describe('热路接线', () => {
  it('首审/返工/预算早退都走 cleanupAfterWorkerDone，不再裸 cwd 前缀', () => {
    const dao = readFileSync(join(REPO, 'scripts/dao.mjs'), 'utf8');
    const start = dao.indexOf('async function cmdWorkerDoneMirasim');
    const end = dao.indexOf('async function cmdStartMirasim', start);
    const body = dao.slice(start, end);
    assert.match(body, /cleanupAfterWorkerDone/);
    assert.match(body, /plan\.halt/);
    const calls = body.match(/await cleanupAfterWorkerDone\(/g) || [];
    assert.equal(calls.length, 3);
    assert.equal(/stopSessionsAtCwd\(\s*[\w.]+\s*,\s*process\.cwd\(\)\s*\)/.test(dao), false);
    assert.match(dao, /workerDoneCleanupFailExtra/);
  });
});
