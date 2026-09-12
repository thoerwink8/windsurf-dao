// 短命执行体清树 + 老单优先（#1174）
const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const REPO = path.resolve(__dirname, '..');
const toUrl = (p) => 'file://' + p.replace(/\\/g, '/');
const REAP = import(toUrl(path.join(REPO, 'scripts/lib/ephemeral-reap.mjs')));
const CORE = import(toUrl(path.join(REPO, 'scripts/lib/commander-core.mjs')));
const ADMIT = import(toUrl(path.join(REPO, 'scripts/lib/admission.mjs')));
const CAP = import(toUrl(path.join(REPO, 'scripts/lib/ephemeral-capacity.mjs')));
const CMD = () => import(toUrl(path.join(REPO, 'scripts/commander.mjs')));

const reviewerTree = (pr, extra = {}) => ({
  path: `/home/orca/mirasim-worktrees/windsurf-dao/dao-review-pr-${pr}`,
  kind: '审官',
  pr,
  displayName: `PR-#${pr} 审官`,
  ...extra,
});
const workerTree = (issue, extra = {}) => ({
  path: `/home/orca/mirasim-worktrees/windsurf-dao/dao-${issue}`,
  kind: '工人',
  linkedIssue: issue,
  displayName: `ISSUE-#${issue} 工人`,
  ...extra,
});

describe('planTreeReaps', () => {
  it('审官树：当前 head 有判定且无活会话 → 清', async () => {
    const { planTreeReaps } = await REAP;
    const r = planTreeReaps({
      trees: [reviewerTree(20)],
      sessions: [{ key: 'dead', state: 'incomplete', cwd: reviewerTree(20).path }],
      github: {
        scanned: true,
        issues: [],
        prs: [{ number: 20, headRefOid: 'abc', title: 'x', body: '署名 issue #9' }],
      },
      reviewsByPr: { 20: { reviews: [{ state: 'APPROVED', commit_id: 'abc' }] } },
    });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.items.length, 1);
    assert.equal(r.items[0].role, 'reviewer');
    assert.equal(r.items[0].pr, 20);
  });

  it('审官树：reviews 没查成 → 不清', async () => {
    const { planTreeReaps } = await REAP;
    const r = planTreeReaps({
      trees: [reviewerTree(20)],
      sessions: [],
      github: { scanned: true, issues: [], prs: [{ number: 20, headRefOid: 'abc' }] },
      reviewsByPr: {},
    });
    assert.equal(r.items.length, 0);
    assert.ok(r.skipped.some((s) => /reviews 没查成/.test(s.why)), JSON.stringify(r.skipped));
  });

  it('审官树：还有活会话 → 不清', async () => {
    const { planTreeReaps } = await REAP;
    const r = planTreeReaps({
      trees: [reviewerTree(20)],
      sessions: [{ key: 'live', state: 'running', cwd: reviewerTree(20).path }],
      github: { scanned: true, issues: [], prs: [{ number: 20, headRefOid: 'abc' }] },
      reviewsByPr: { 20: { reviews: [{ state: 'APPROVED' }] } },
    });
    assert.equal(r.items.length, 0);
    assert.ok(r.skipped.some((s) => /活会话/.test(s.why)));
  });

  it('工人树：本轮合并且无活会话 → 清', async () => {
    const { planTreeReaps, markTreesForMergedPrs } = await REAP;
    const trees = markTreesForMergedPrs([workerTree(9)], [{ pr: 20, issue: 9 }]);
    const r = planTreeReaps({
      trees,
      sessions: [],
      github: {
        scanned: true,
        issues: [{ number: 9 }],
        prs: [{ number: 20, title: 'x', body: '署名 issue #9' }],
      },
      mergedPrs: [20],
    });
    assert.equal(r.items.length, 1, JSON.stringify(r));
    assert.equal(r.items[0].role, 'worker');
    assert.equal(r.items[0].issue, 9);
  });

  it('同 issue 多树 + 一合一开 → 不清（对不上精确 PR）', async () => {
    const { planTreeReaps, markTreesForMergedPrs } = await REAP;
    const t1 = workerTree(9);
    const t2 = workerTree(9, { path: '/home/orca/mirasim-worktrees/windsurf-dao/dao-9-2' });
    const trees = markTreesForMergedPrs([t1, t2], [{ pr: 20, issue: 9 }]);
    assert.equal(trees.filter((t) => t.mergedPr === 20).length, 0, JSON.stringify(trees));
    const r = planTreeReaps({
      trees,
      sessions: [],
      github: {
        scanned: true,
        issues: [{ number: 9 }],
        prs: [
          { number: 20, title: 'x', body: '署名 issue #9' },
          { number: 21, title: 'y', body: '署名 issue #9' },
        ],
      },
      mergedPrs: [20],
    });
    assert.equal(r.items.length, 0, JSON.stringify(r));
    assert.ok(
      r.skipped.some((s) => /开放 PR|精确/.test(s.why)),
      JSON.stringify(r.skipped),
    );
  });

  it('同 issue 多树：head 分支名对上已合 PR 的那棵才清', async () => {
    const { planTreeReaps } = await REAP;
    const r = planTreeReaps({
      trees: [
        workerTree(9),
        workerTree(9, { path: '/home/orca/mirasim-worktrees/windsurf-dao/dao-9-2' }),
      ],
      sessions: [],
      github: {
        scanned: true,
        issues: [{ number: 9 }],
        prs: [
          { number: 20, title: 'x', body: '署名 issue #9', headRefName: 'dao-9' },
          { number: 21, title: 'y', body: '署名 issue #9', headRefName: 'dao-9-2' },
        ],
      },
      mergedPrs: [20],
    });
    assert.equal(r.items.length, 1, JSON.stringify(r));
    assert.equal(r.items[0].role, 'worker');
    assert.equal(r.items[0].pr, 20);
    assert.ok(r.items[0].path.endsWith('/dao-9'), r.items[0].path);
    assert.ok(r.skipped.some((s) => String(s.path || '').endsWith('/dao-9-2')), JSON.stringify(r.skipped));
  });

  it('工人树：单还开着 → 留着给返工', async () => {
    const { planTreeReaps } = await REAP;
    const r = planTreeReaps({
      trees: [workerTree(9)],
      sessions: [],
      github: {
        scanned: true,
        issues: [{ number: 9 }],
        prs: [{ number: 20, title: 'x', body: '署名 issue #9' }],
      },
    });
    assert.equal(r.items.length, 0);
    assert.ok(r.skipped.some((s) => /还开着/.test(s.why)));
  });

  it('会话名单没查成 → 一张都不清', async () => {
    const { planTreeReaps } = await REAP;
    const r = planTreeReaps({
      trees: [reviewerTree(20), workerTree(9)],
      sessions: null,
      github: { scanned: true, issues: [], prs: [] },
      reviewsByPr: { 20: { reviews: [{ state: 'APPROVED' }] } },
    });
    assert.equal(r.items.length, 0);
    assert.ok(r.skipped.some((s) => /没查成/.test(s.why)));
  });

  it('开放列表取满窗口 → 历史孤儿不猜', async () => {
    const { planTreeReaps, PR_LIST_WINDOW } = await REAP;
    const issues = Array.from({ length: PR_LIST_WINDOW }, (_, i) => ({ number: 1000 + i }));
    const r = planTreeReaps({
      trees: [workerTree(9)],
      sessions: [],
      github: { scanned: true, issues, prs: [] },
    });
    assert.equal(r.items.length, 0);
    assert.ok(r.skipped.some((s) => /截断/.test(s.why)), JSON.stringify(r.skipped));
  });

  it('历史孤儿：单不在未截断开放列表且无活会话 → 候选（exec 再核）', async () => {
    const { planTreeReaps } = await REAP;
    const r = planTreeReaps({
      trees: [workerTree(9)],
      sessions: [],
      github: { scanned: true, issues: [{ number: 1 }], prs: [] },
    });
    assert.equal(r.items.length, 1);
    assert.equal(r.items[0].role, 'orphan');
  });

  it('历史审官树：PR 不在未截断开放列表 → 候选', async () => {
    const { planTreeReaps } = await REAP;
    const r = planTreeReaps({
      trees: [reviewerTree(88)],
      sessions: [],
      github: { scanned: true, issues: [{ number: 1 }], prs: [] },
      reviewsByPr: {},
    });
    assert.equal(r.items.length, 1);
    assert.equal(r.items[0].role, 'reviewer');
    assert.equal(r.items[0].pr, 88);
  });
});

describe('老单优先', () => {
  it('capNewDispatchSlots：老单忙时把新槽压到 1', async () => {
    const { capNewDispatchSlots, MAX_NEW_DISPATCH_WHEN_OLD_BUSY } = await ADMIT;
    assert.equal(MAX_NEW_DISPATCH_WHEN_OLD_BUSY, 1);
    assert.equal(capNewDispatchSlots(5, true), 1);
    assert.equal(capNewDispatchSlots(5, false), 5);
    assert.equal(capNewDispatchSlots(Infinity, true), 1);
    assert.equal(capNewDispatchSlots(0, true), 0);
  });

  it('同 rank 轮次多的、出生早的排前面', async () => {
    const { prioritizeReady } = await ADMIT;
    const a = { number: 10, title: '新', createdAt: '2026-09-12T00:00:00Z', labels: [{ name: 'type/写码' }] };
    const b = { number: 20, title: '老', createdAt: '2026-09-01T00:00:00Z', labels: [{ name: 'type/写码' }] };
    const c = { number: 30, title: '多轮', createdAt: '2026-09-11T00:00:00Z', labels: [{ name: 'type/写码' }] };
    assert.deepEqual(
      prioritizeReady([a, b, c], { roundsByIssue: { 30: 3, 20: 0, 10: 0 } }),
      [30, 20, 10],
    );
  });

  it('有复审票时新派工最多 1 张', async () => {
    const { decide } = await CORE;
    const issues = Array.from({ length: 4 }, (_, i) => ({
      number: 201 + i,
      title: `单 ${201 + i}`,
      body: '',
      labels: [
        { name: '已消歧' }, { name: 'model/grok-4.6' }, { name: 'reviewer/gpt-5.6-sol' }, { name: 'type/写码' },
      ],
    }));
    const r = decide({
      github: { scanned: true, issues, prs: [{ number: 101, title: 'PR 101', isDraft: false }] },
      orca: { scanned: true, worktrees: [] },
      trees: { scanned: true, worktrees: [] },
      reviewPending: { scanned: true, items: [{ pr: 101 }] },
      prReviews: { scanned: true, byPr: {} },
      stall: { scanned: true, strikes: {} },
      wakeCounts: {},
      reworkDispatched: {},
      commanderPolicy: { requireModelInRouting: false },
      routingModels: ['grok-4.6', 'gpt-5.6-sol'],
      healthRedModels: [],
      admission: { ok: true, slots: 5, why: 'slots=5' },
    });
    const dispatch = r.actions.filter((a) => a.kind === 'dispatch');
    assert.equal(dispatch.length, 1, `老单有票时新派了 ${dispatch.length} 张`);
  });
});

describe('decide 产 reap-tree', () => {
  it('核绿可合的 PR，对应审官树无活会话 → 清单里有 reap-tree', async () => {
    const { decide } = await CORE;
    const r = decide({
      github: {
        scanned: true,
        issues: [{
          number: 9, title: '单', body: '',
          labels: [{ name: '已消歧' }, { name: 'model/grok-4.6' }, { name: 'reviewer/gpt-5.6-sol' }],
        }],
        prs: [{
          number: 20, title: 'PR', body: '署名 issue #9', isDraft: false,
          reviewDecision: 'APPROVED', mergeable: 'MERGEABLE', headRefOid: 'abc',
          statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }],
        }],
      },
      orca: { scanned: true, worktrees: [] },
      trees: { scanned: true, worktrees: [reviewerTree(20), workerTree(9)] },
      sessions: { scanned: true, items: [] },
      reviewPending: { scanned: true, items: [] },
      prReviews: { scanned: true, byPr: { 20: { reviews: [{ state: 'APPROVED', commit_id: 'abc' }] } } },
      stall: { scanned: true, strikes: {} },
      wakeCounts: {},
      reworkDispatched: {},
      commanderPolicy: { requireModelInRouting: false },
      routingModels: ['grok-4.6', 'gpt-5.6-sol'],
      healthRedModels: [],
      admission: { ok: true, slots: 2, why: 'ok' },
    });
    const reaps = r.actions.filter((a) => a.kind === 'reap-tree');
    const reviewerReaps = reaps.filter((a) => a.role === 'reviewer');
    const workerReaps = reaps.filter((a) => a.role === 'worker');
    assert.equal(reviewerReaps.length, 1, JSON.stringify(reaps));
    assert.equal(reviewerReaps[0].pr, 20);
    assert.equal(workerReaps.length, 1, JSON.stringify(reaps));
    assert.equal(workerReaps[0].issue, 9);
    const mergeIdx = r.actions.findIndex((a) => a.kind === 'merge');
    const reapIdx = r.actions.findIndex((a) => a.kind === 'reap-tree' && a.role === 'worker');
    assert.ok(mergeIdx >= 0, '有 merge');
    assert.ok(reapIdx > mergeIdx, '工人树清在 merge 之后');
  });

  it('同 issue 两棵工人树 + 一合一开 → decide 不清工人树', async () => {
    const { decide } = await CORE;
    const r = decide({
      github: {
        scanned: true,
        issues: [{
          number: 9, title: '单', body: '',
          labels: [{ name: '已消歧' }, { name: 'model/grok-4.6' }, { name: 'reviewer/gpt-5.6-sol' }],
        }],
        prs: [{
          number: 20, title: 'PR', body: '署名 issue #9', isDraft: false,
          reviewDecision: 'APPROVED', mergeable: 'MERGEABLE', headRefOid: 'abc',
          statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }],
        }, {
          number: 21, title: '另一张', body: '署名 issue #9', isDraft: true,
          reviewDecision: null, mergeable: 'MERGEABLE', headRefOid: 'def',
        }],
      },
      orca: { scanned: true, worktrees: [] },
      trees: {
        scanned: true,
        worktrees: [
          reviewerTree(20),
          workerTree(9),
          workerTree(9, { path: '/home/orca/mirasim-worktrees/windsurf-dao/dao-9-2' }),
        ],
      },
      sessions: { scanned: true, items: [] },
      reviewPending: { scanned: true, items: [] },
      prReviews: { scanned: true, byPr: { 20: { reviews: [{ state: 'APPROVED', commit_id: 'abc' }] } } },
      stall: { scanned: true, strikes: {} },
      wakeCounts: {},
      reworkDispatched: {},
      commanderPolicy: { requireModelInRouting: false },
      routingModels: ['grok-4.6', 'gpt-5.6-sol'],
      healthRedModels: [],
      admission: { ok: true, slots: 2, why: 'ok' },
    });
    const workerReaps = r.actions.filter((a) => a.kind === 'reap-tree' && a.role === 'worker');
    assert.equal(workerReaps.length, 0, JSON.stringify(workerReaps));
    assert.equal(r.actions.filter((a) => a.kind === 'merge' && a.pr === 20).length, 1);
  });
});

describe('execReapTree fail-closed', () => {
  it('工人树：PR 还 OPEN → 不删', async () => {
    const M = await CMD();
    const calls = [];
    const run = (argv) => {
      calls.push(argv);
      if (argv.includes('view')) return { ok: true, out: '{"state":"OPEN"}\n' };
      return { ok: true, out: '' };
    };
    const r = M.execReapTree(
      { role: 'worker', pr: 20, path: '/tmp/dao-9', why: 'test' },
      { dryRun: false, say: () => {}, run },
    );
    assert.equal(r.ok, false);
    assert.ok(!calls.some((c) => c.includes('worktree-rm')), 'OPEN 不许发 worktree-rm');
  });

  it('工人树：PR MERGED → 发 worktree-rm', async () => {
    const M = await CMD();
    const calls = [];
    const run = (argv) => {
      calls.push(argv);
      if (argv.includes('view')) return { ok: true, out: '{"state":"MERGED"}\n' };
      return { ok: true, out: '{"ok":true}\n' };
    };
    const r = M.execReapTree(
      { role: 'worker', pr: 20, path: '/tmp/dao-9', why: 'test' },
      { dryRun: false, say: () => {}, run },
    );
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.ok(calls.some((c) => c.includes('worktree-rm')));
  });

  it('工人树：PR CLOSED 未合并 → 不删', async () => {
    const M = await CMD();
    const calls = [];
    const run = (argv) => {
      calls.push(argv);
      if (argv.includes('view')) return { ok: true, out: '{"state":"CLOSED"}\n' };
      return { ok: true, out: '' };
    };
    const r = M.execReapTree(
      { role: 'worker', pr: 20, path: '/tmp/dao-9', why: 'test' },
      { dryRun: false, say: () => {}, run },
    );
    assert.equal(r.ok, false);
    assert.equal(calls.filter((c) => c.includes('worktree-rm')).length, 0, JSON.stringify(calls));
  });

  it('审官树：OPEN 且无判定 → 不删', async () => {
    const M = await CMD();
    const calls = [];
    const run = (argv) => {
      calls.push(argv);
      if (argv.includes('view')) return { ok: true, out: '{"state":"OPEN","headRefOid":"abc","reviews":[]}\n' };
      return { ok: true, out: '' };
    };
    const r = M.execReapTree(
      { role: 'reviewer', pr: 20, path: '/tmp/dao-review-pr-20', why: 'test' },
      { dryRun: false, say: () => {}, run },
    );
    assert.equal(r.ok, false);
    assert.equal(calls.filter((c) => c.includes('worktree-rm')).length, 0, JSON.stringify(calls));
  });

  it('审官树：旧 HEAD 的判定 + 新 HEAD → 不删', async () => {
    const M = await CMD();
    const calls = [];
    const run = (argv) => {
      calls.push(argv);
      if (argv.includes('view')) {
        return {
          ok: true,
          out: JSON.stringify({
            state: 'OPEN',
            headRefOid: 'newhead',
            reviews: [{ state: 'APPROVED', commit: { oid: 'oldhead' } }],
          }) + '\n',
        };
      }
      return { ok: true, out: '' };
    };
    const r = M.execReapTree(
      { role: 'reviewer', pr: 20, path: '/tmp/dao-review-pr-20', why: 'test' },
      { dryRun: false, say: () => {}, run },
    );
    assert.equal(r.ok, false);
    assert.equal(calls.filter((c) => c.includes('worktree-rm')).length, 0, JSON.stringify(calls));
  });

  it('审官树：判定缺 commit oid → 不删', async () => {
    const M = await CMD();
    const calls = [];
    const run = (argv) => {
      calls.push(argv);
      if (argv.includes('view')) {
        return {
          ok: true,
          out: JSON.stringify({
            state: 'OPEN',
            headRefOid: 'abc',
            reviews: [{ state: 'CHANGES_REQUESTED' }],
          }) + '\n',
        };
      }
      return { ok: true, out: '' };
    };
    const r = M.execReapTree(
      { role: 'reviewer', pr: 20, path: '/tmp/dao-review-pr-20', why: 'test' },
      { dryRun: false, say: () => {}, run },
    );
    assert.equal(r.ok, false);
    assert.equal(r.unscanned, true);
    assert.equal(calls.filter((c) => c.includes('worktree-rm')).length, 0, JSON.stringify(calls));
  });

  it('审官树：OPEN 且判定打在当前 HEAD → 发 worktree-rm', async () => {
    const M = await CMD();
    const calls = [];
    const run = (argv) => {
      calls.push(argv);
      if (argv.includes('view')) {
        return {
          ok: true,
          out: JSON.stringify({
            state: 'OPEN',
            headRefOid: 'abc',
            reviews: [{ state: 'APPROVED', commit: { oid: 'abc' } }],
          }) + '\n',
        };
      }
      return { ok: true, out: '{"ok":true}\n' };
    };
    const r = M.execReapTree(
      { role: 'reviewer', pr: 20, path: '/tmp/dao-review-pr-20', why: 'test' },
      { dryRun: false, say: () => {}, run },
    );
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(calls.filter((c) => c.includes('worktree-rm')).length, 1, JSON.stringify(calls));
  });

  it('GitHub 读失败 → unscanned 不删', async () => {
    const M = await CMD();
    const r = M.execReapTree(
      { role: 'orphan', issue: 9, path: '/tmp/dao-9', why: 'test' },
      { dryRun: false, say: () => {}, run: () => ({ ok: false, error: 'gh 挂了' }) },
    );
    assert.equal(r.ok, false);
    assert.equal(r.unscanned, true);
  });
});

describe('容量对比', () => {
  it('初始有 incomplete、stop 成功、样本残留为 0', async () => {
    const { leftoverIncompleteAfterStops, countLeftoverAfterHandoff } = await CAP;
    const sessions = [{ key: 'pi:dead', state: 'incomplete', cwd: '/x/dao-900' }];
    assert.equal(countLeftoverAfterHandoff(sessions, '/x/dao-900').count, 1);
    const after = leftoverIncompleteAfterStops(sessions, [
      { ok: true, sessionKey: 'pi:dead', workdir: '/x/dao-900' },
    ]);
    assert.equal(after.ok, true, JSON.stringify(after));
    assert.equal(after.count, 0);
  });

  it('stop 失败则残留仍是 1', async () => {
    const { leftoverIncompleteAfterStops } = await CAP;
    const after = leftoverIncompleteAfterStops(
      [{ key: 'pi:dead', state: 'incomplete', cwd: '/x/dao-900' }],
      [{ ok: false, sessionKey: 'pi:dead', workdir: '/x/dao-900' }],
    );
    assert.equal(after.ok, true);
    assert.equal(after.count, 1);
  });

  it('字段齐全算出差值；缺字段 unscanned', async () => {
    const { snapshotCapacity, compareCapacity } = await CAP;
    const before = snapshotCapacity({
      at: '2026-09-12T00:00:00Z', cpuBusy: 0.8, memAvailableMb: 2000, loadNorm: 1.5,
      inFlight: 10, sessions: 20, worktrees: 36, leftoverAfterHandoff: 8, cleanupFailures: 2,
    });
    const after = snapshotCapacity({
      at: '2026-09-12T12:00:00Z', cpuBusy: 0.3, memAvailableMb: 6000, loadNorm: 0.4,
      inFlight: 3, sessions: 4, worktrees: 8, leftoverAfterHandoff: 0, cleanupFailures: 0,
    });
    const c = compareCapacity(before, after);
    assert.equal(c.ok, true, c.why);
    const inflight = c.items.find((x) => x.key === 'inFlight');
    assert.equal(inflight.delta, -7);
    const missing = compareCapacity(before, snapshotCapacity({ inFlight: 1 }));
    assert.equal(missing.ok, false);
    assert.equal(missing.unscanned, true);
  });
});

describe('返工复用原 PR', () => {
  it('reworkSpec 写明切原 PR、不开新 PR', () => {
    const src = fs.readFileSync(path.join(REPO, 'scripts/commander.mjs'), 'utf8');
    assert.match(src, /别开新 PR/);
    assert.match(src, /复用这张 PR，不开第二张/);
    const i = src.indexOf('function dispatchRework');
    const body = src.slice(i, i + 4500);
    assert.match(body, /dao\.mjs', 'start'/);
    assert.doesNotMatch(body, /'--allow-dup'/);
  });
});
