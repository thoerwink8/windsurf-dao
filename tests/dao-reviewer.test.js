// tests/dao-reviewer.test.js —— dao 审官与完工
//
// 2026-09-06 从 dao.test.js 拆出（原 4220 行 / 1058 用例一个文件）。
// 本套管：审官按需起、树自证、任务书模板、完工评论幂等、label 同步
// 共享前置在 tests/helpers/dao-harness.js，各套逐字复用，行为与拆分前一致。

const { describe, it } = require('node:test');
const { assert, fs, os, path, spawnSync, REPO, CLI, LIB, S_LOAD, DAO_LOAD, cliInProc, ROUTING_LOAD, waitForOutJson } = require('./helpers/dao-harness');

describe('dao 审官与完工', () => {
  it('PR #758 教训：完工评论幂等（重试不重发）+ 半成功审官卡续跑', async (t) => {
    const S = await S_LOAD;

    await t.test('commentAlreadyPosted：同文（trim 后）= 已发过', () => {
      const comments = [{ body: '完工：PR #758\n\n自读选型：x\n' }];
      assert.ok(S.commentAlreadyPosted(comments, '完工：PR #758\n\n自读选型：x') === true, '同文命中');
      assert.ok(S.commentAlreadyPosted(comments, '完工：PR #758\n\n自读选型：y') === false, '不同文不命中');
      assert.ok(S.commentAlreadyPosted([], 'x') === false && S.commentAlreadyPosted(null, 'x') === false, '空列表不命中');
    });

    await t.test('postCommentOnce：同款已发过 → 跳过不再发', () => {
      const posted = [];
      const runGh = (argv) => {
        if (argv[1] === 'view') return { ok: true, out: JSON.stringify({ comments: [{ body: '完工：PR #758' }] }) };
        posted.push(argv.join(' '));
        return { ok: true, out: '' };
      };
      const r = S.postCommentOnce({ kind: 'pr', number: '758', body: '完工：PR #758', runGh });
      assert.ok(r.ok === true && r.skipped === true && r.alreadyPosted === true && posted.length === 0,
        '已发过跳过  →  ' + JSON.stringify(r));
    });

    await t.test('postCommentOnce：没发过 → 真发', () => {
      const posted = [];
      const runGh = (argv) => {
        if (argv[1] === 'view') return { ok: true, out: JSON.stringify({ comments: [] }) };
        posted.push(argv.join(' '));
        return { ok: true, out: '' };
      };
      const r = S.postCommentOnce({ kind: 'issue', number: '752', body: '完工：PR #758', runGh });
      assert.ok(r.ok === true && !r.skipped && posted.length === 1 && /issue comment 752/.test(posted[0]),
        '没发过真发  →  ' + JSON.stringify({ r, posted }));
    });

    await t.test('postCommentOnce：评论列表没查成 → ok:false unscanned（不许当没发过放行）', () => {
      const runGh = () => ({ ok: false, error: 'gh down' });
      const r = S.postCommentOnce({ kind: 'pr', number: '758', body: 'x', runGh });
      assert.ok(r.ok === false && r.unscanned === true, '没查成  →  ' + JSON.stringify(r));
    });

    await t.test('gateReviewerCreate：refused-existing 带 worktreePath（续跑要路）', () => {
      const r = S.gateReviewerCreate({
        pr: '758',
        parentId: 'wt_parent',
        worktrees: [
          { id: 'wt_parent', worktreeId: 'wt_parent', displayName: 'PR-#758 工人', parentWorktreeId: null },
          { id: 'wt_rev', worktreeId: 'wt_rev', displayName: 'PR-#758 审官', parentWorktreeId: 'wt_parent', path: 'C:/wt/rev' },
        ],
        workers: [{ resource: { worktreeId: 'wt_rev' }, dispatchId: 'ctx_1' }],
        terminals: [],
      });
      assert.ok(r.outcome === 'refused-existing' && r.worktreeId === 'wt_rev' && r.worktreePath === 'C:/wt/rev',
        'refuse 带 path  →  ' + JSON.stringify(r));
    });

    const daoSrc = fs.readFileSync(CLI, 'utf8');
    await t.test('cmdWorkerDone 完工评论走 postCommentOnce（幂等）', () => {
      const i = daoSrc.indexOf('function cmdWorkerDone(');
      const seg = daoSrc.slice(i, i + 6000);
      assert.ok(/postCommentOnce\(\{ kind: 'issue'/.test(seg) && /postCommentOnce\(\{ kind: 'pr'/.test(seg),
        'worker-done 完工评论要幂等');
    });
    await t.test('cmdReviewerCreate：refused-existing 转续跑（resumedFromExisting），不再直接 fail', () => {
      const i = daoSrc.indexOf('function cmdReviewerCreate(');
      const seg = daoSrc.slice(i, i + 9000);
      assert.ok(/resumedFromExisting/.test(seg) && /oneReviewerGate\.worktreePath/.test(seg),
        'reviewer-create 要能续跑半成功卡');
      assert.ok(!/if \(oneReviewerGate\.outcome === 'refused-existing'\) \{\s*fail\(/.test(seg),
        'refused-existing 不该再直接 fail 死循环');
    });
  });

  it('#564 label 自动打：dispatch 记 issue + pr-sync-labels 合并侧同步到 PR', async (t) => {
    const S = await S_LOAD;
    // 纯函数：label 名组装（角色缺省写码）。
    const ln1 = S.dispatchLabelNames({ model: 'grok-4.6' });
    await t.test('label 名：model/<id> + type/写码（缺省）', () => {
      assert.ok(ln1.includes('model/grok-4.6') && ln1.includes('type/写码'), 'label 名：model/<id> + type/写码（缺省）  →  ' + JSON.stringify(ln1));
    });
    const ln2 = S.dispatchLabelNames({ model: 'gpt-5.6-sol', role: '审查' });
    await t.test('label 名：给角色 → type/<角色>', () => {
      assert.ok(ln2.includes('model/gpt-5.6-sol') && ln2.includes('type/审查') && !ln2.includes('type/写码'), 'label 名：给角色 → type/<角色>  →  ' + JSON.stringify(ln2));
    });

    // PR 署名单号：只认 Closes/Fixes 关键词，正文随手引用的 #N 不算。
    const refs = S.linkedIssueNumbers('Closes #564\n参考 #498 #480（历史相关）');
    await t.test('署名单号只认 Closes 关键词（#498 #480 不被抄 label）',
      () => {
        assert.ok(refs.length === 1 && refs[0] === 564, '署名单号只认 Closes 关键词（#498 #480 不被抄 label）  →  ' + JSON.stringify(refs));
      });
    const refs2 = S.linkedIssueNumbers('Fixes #12');
    await t.test('Fixes 也算署名单号', () => {
      assert.ok(refs2.length === 1 && refs2[0] === 12, 'Fixes 也算署名单号  →  ' + JSON.stringify(refs2));
    });
    const refs3 = S.linkedIssueNumbers('关联 issue #633。不要 Closes。\n见 #655 现场');
    await t.test('关联 issue #N 也是署名（不触发 GitHub 自动关单）', () => {
      assert.ok(refs3.length === 1 && refs3[0] === 633, '关联 issue #N 也是署名  →  ' + JSON.stringify(refs3));
    });

    // dispatch 侧打标：stub runGh 验证调用面（label list → 缺的建 → issue edit --add-label）。
    const calls = [];
    const recGh = (a) => {
      calls.push(a.slice());
      if (a[0] === 'issue' && a[1] === 'view') return { ok: true, out: JSON.stringify({ labels: [] }) };
      if (a[0] === 'label' && a[1] === 'list') return { ok: true, out: JSON.stringify([{ name: 'model/grok-4.6' }]) };
      if (a[0] === 'label' && a[1] === 'create') return { ok: true, out: JSON.stringify({ name: a[2] }) };
      if (a[0] === 'issue' && a[1] === 'edit') return { ok: true, out: '{}' };
      return { ok: false, error: `未预期 ${a.join(' ')}` };
    };
    const stamped = S.stampIssueLabels({ issue: '123', model: 'grok-4.6', role: '写码', runGh: recGh });
    await t.test('dispatch 打标成功：names 对、缺的 label 先建、issue edit 带 --add-label',
      () => {
        assert.ok(stamped.ok === true && stamped.names.length === 2
        && calls.some(a => a[0] === 'label' && a[1] === 'create' && a[2] === 'type/写码')
        && calls.some(a => a[0] === 'issue' && a[1] === 'edit' && a[2] === '123' && a.includes('--add-label') && a.includes('model/grok-4.6') && a.includes('type/写码')),
        'dispatch 打标成功：names 对、缺的 label 先建、issue edit 带 --add-label  →  ' + JSON.stringify({ stamped, calls }));
      });

    // 没 gh 执行器 / 没合法 issue：不许当「查过没事」。
    const noGh = S.stampIssueLabels({ issue: '123', model: 'grok-4.6', runGh: null });
    await t.test('打标没 gh 执行器 → 报没查成', () => {
      assert.ok(noGh.ok === false && noGh.unscanned === true, '打标没 gh 执行器 → 报没查成  →  ' + JSON.stringify(noGh));
    });
    const skip = S.stampIssueLabels({ issue: '', model: 'grok-4.6', runGh: recGh });
    await t.test('打标没合法 issue 号 → skipped 不瞎打', () => {
      assert.ok(skip.ok === false && skip.skipped === true, '打标没合法 issue 号 → skipped 不瞎打  →  ' + JSON.stringify(skip));
    });

    // 合并侧同步：stub runGh（PR 正文 Closes #7，issue #7 有 model+type）。
    const calls2 = [];
    const syncGh = (a) => {
      calls2.push(a.slice());
      if (a[0] === 'pr' && a[1] === 'view') return { ok: true, out: JSON.stringify({ title: '修 X', body: 'Closes #7\n验收：过' }) };
      if (a[0] === 'issue' && a[1] === 'view') return { ok: true, out: JSON.stringify({ labels: [{ name: 'model/grok-4.6' }, { name: 'type/写码' }, { name: '已消歧' }] }) };
      if (a[0] === 'label' && a[1] === 'list') return { ok: true, out: JSON.stringify([{ name: 'model/grok-4.6' }, { name: 'type/写码' }]) };
      if (a[0] === 'pr' && a[1] === 'edit') return { ok: true, out: '{}' };
      return { ok: false, error: `未预期 ${a.join(' ')}` };
    };
    const synced = S.syncPrLabelsFromIssue({ pr: '7', runGh: syncGh });
    await t.test('pr-sync-labels：从署名 issue 把 model/type 抄到 PR（非 model/type 不抄）',
      () => {
        assert.ok(synced.ok === true && synced.labels.length === 2 && synced.labels.includes('model/grok-4.6') && synced.labels.includes('type/写码')
        && calls2.some(a => a[0] === 'pr' && a[1] === 'edit' && a[2] === '7' && a.includes('--add-label')),
        'pr-sync-labels：从署名 issue 把 model/type 抄到 PR（非 model/type 不抄）  →  ' + JSON.stringify({ synced, calls2 }));
      });

    // PR 没署名单号 → 说清楚，不许静默。
    const noRef = S.syncPrLabelsFromIssue({ pr: '9', runGh: (a) => {
      if (a[0] === 'pr' && a[1] === 'view') return { ok: true, out: JSON.stringify({ title: '无署名', body: '改动：修 bug' }) };
      return { ok: false, error: `未预期 ${a.join(' ')}` };
    } });
    await t.test('pr-sync-labels 无署名单号 → 报错需人工补', () => {
      assert.ok(noRef.ok === false && /Closes|署名/.test(noRef.error), 'pr-sync-labels 无署名单号 → 报错需人工补  →  ' + JSON.stringify(noRef));
    });

    // 署名 issue 没有 model/type label → 说清楚。
    const noLabel = S.syncPrLabelsFromIssue({ pr: '10', runGh: (a) => {
      if (a[0] === 'pr' && a[1] === 'view') return { ok: true, out: JSON.stringify({ title: 'x', body: 'Closes #10' }) };
      if (a[0] === 'issue' && a[1] === 'view') return { ok: true, out: JSON.stringify({ labels: [{ name: '已消歧' }] }) };
      return { ok: false, error: `未预期 ${a.join(' ')}` };
    } });
    await t.test('署名 issue 无 model/type → 报错需人工补', () => {
      assert.ok(noLabel.ok === false && /model|type/.test(noLabel.error), '署名 issue 无 model/type → 报错需人工补  →  ' + JSON.stringify(noLabel));
    });

    // CLI 级：pr-sync-labels --pr 42（fake-gh 固定：正文 Closes #565，565 带 model/type）→ 退出 0。
    const FAKE_GH2 = path.join(REPO, 'tests', 'fixtures', 'fake-gh.mjs');
    const cliSync = await cliInProc(['pr-sync-labels', '--pr', '42'], { DAO_GH_FAKE: FAKE_GH2 });
    const pSync = (() => { try { return JSON.parse((cliSync.stdout || '').trim().split(/\r?\n/).pop()); } catch { return {}; } })();
    await t.test('CLI pr-sync-labels --pr 42（假 gh）→ 退出 0 且 label 抄到',
      () => {
        assert.ok(cliSync.status === 0 && pSync.ok === true && (pSync.labels || []).includes('model/grok-4.6') && (pSync.labels || []).includes('type/写码'),
          'CLI pr-sync-labels --pr 42（假 gh）→ 退出 0 且 label 抄到  →  ' + `status=${cliSync.status} ${JSON.stringify(pSync)}`);
      });
    const cliSyncNoRef = await cliInProc(['pr-sync-labels', '--pr', '41'], { DAO_GH_FAKE: FAKE_GH2 });
    const pSyncNoRef = (() => { try { return JSON.parse((cliSyncNoRef.stdout || '').trim().split(/\r?\n/).pop()); } catch { return {}; } })();
    await t.test('CLI pr-sync-labels 无署名单号 → 非 0 且说清',
      () => {
        assert.ok(cliSyncNoRef.status !== 0 && /署名/.test(String(pSyncNoRef.error || '')), 'CLI pr-sync-labels 无署名单号 → 非 0 且说清  →  ' + `status=${cliSyncNoRef.status} ${JSON.stringify(pSyncNoRef)}`);
      });

    const daoSrcLabels = fs.readFileSync(CLI, 'utf8');
    await t.test('dao.mjs dispatch 成功后调 stampIssueLabels', () => {
      assert.ok(/stampIssueLabels\(\{/.test(daoSrcLabels), 'dao.mjs dispatch 成功后调 stampIssueLabels  →  ' + daoSrcLabels.slice(0, 60));
    });
    await t.test('dao.mjs dispatch 打 reviewer/*', () => {
      assert.ok(/reviewer:\s*gate\.reviewer/.test(daoSrcLabels), 'dao.mjs dispatch 打 reviewer/*  →  ' + daoSrcLabels.slice(0, 60));
    });
  });

  it('#586 审官按需起阶段一：pickReviewer + 自读选型 + worker-done 骨架', async (t) => {
    const S = await S_LOAD;
    const one = S.pickReviewer(['model/grok-4.6', 'type/写码', 'reviewer/gpt-5.6-sol', '已消歧']);
    await t.test('pickReviewer 查到一个 → ok + modelId', () => {
      assert.ok(one.ok === true && one.state === 'one' && one.modelId === 'gpt-5.6-sol', 'pickReviewer 查到一个 → ok + modelId  →  ' + JSON.stringify(one));
    });
    const none = S.pickReviewer(['model/grok-4.6', 'type/写码', '已消歧']);
    await t.test('pickReviewer 没有 reviewer/* → none，不许猜', () => {
      assert.ok(none.ok === false && none.state === 'none' && /没有 reviewer/.test(none.error), 'pickReviewer 没有 reviewer/* → none，不许猜  →  ' + JSON.stringify(none));
    });
    const many = S.pickReviewer(['reviewer/gpt-5.6-sol', 'reviewer/claude-opus']);
    await t.test('pickReviewer 有多个 → many，不许猜', () => {
      assert.ok(many.ok === false && many.state === 'many' && /多个 reviewer/.test(many.error), 'pickReviewer 有多个 → many，不许猜  →  ' + JSON.stringify(many));
    });
    const unscanned = S.pickReviewer(null);
    await t.test('pickReviewer 没拿到列表 → unscanned，和「扫完 0 条」不同话',
      () => {
        assert.ok(unscanned.ok === false && unscanned.state === 'unscanned'
        && unscanned.error !== none.error && unscanned.error !== many.error && one.state !== none.state,
        'pickReviewer 没拿到列表 → unscanned，和「扫完 0 条」不同话  →  ' + JSON.stringify({ unscanned, none, many }));
      });
    await t.test('pickReviewer 三态话面互不相同',
      () => {
        assert.ok(one.state !== none.state && none.state !== many.state && many.state !== one.state
        && none.error !== many.error,
        'pickReviewer 三态话面互不相同  →  ' + JSON.stringify({ none: none.error, many: many.error }));
      });

    // 同值重复 ≠ 歧义（PR #1103 实咬）：PR 署名两张 issue 时 collectIssueLabelsFromPr 把两张的
    // label 拼在一起，两张都写 model/grok-4.6 就被数成 2，判「有多个，不许猜」，审官永远起不来。
    // 判据本身不动：不同值仍然拒绝。下面四条把「重复」和「打架」钉成两件事。
    const dupRev = S.pickReviewer(['reviewer/gpt-5.6-luna', 'type/写码', 'reviewer/gpt-5.6-luna']);
    await t.test('pickReviewer 同一个值出现两次 → 仍是 one，不当成歧义', () => {
      assert.equal(dupRev.state, 'one');
      assert.equal(dupRev.modelId, 'gpt-5.6-luna');
    });
    const conflictRev = S.pickReviewer(['reviewer/gpt-5.6-luna', 'reviewer/kimi-k3', 'reviewer/gpt-5.6-luna']);
    await t.test('pickReviewer 去重后仍有两个不同值 → 照旧 many，不许猜', () => {
      assert.equal(conflictRev.state, 'many');
      assert.deepEqual(conflictRev.labels, ['reviewer/gpt-5.6-luna', 'reviewer/kimi-k3']);
    });
    const dupModel = S.pickModel(['model/grok-4.6', '已消歧', 'model/grok-4.6']);
    await t.test('pickModel 同一个值出现两次 → 仍是 one，不当成歧义', () => {
      assert.equal(dupModel.state, 'one');
      assert.equal(dupModel.modelId, 'grok-4.6');
    });
    const conflictModel = S.pickModel(['model/grok-4.6', 'model/claude-opus', 'model/grok-4.6']);
    await t.test('pickModel 去重后仍有两个不同值 → 照旧 many，不许猜', () => {
      assert.equal(conflictModel.state, 'many');
      assert.deepEqual(conflictModel.labels, ['model/grok-4.6', 'model/claude-opus']);
    });

    const lnRev = S.dispatchLabelNames({ model: 'grok-4.6', role: '写码', reviewer: 'gpt-5.6-sol' });
    await t.test('label 名含 reviewer/<id>', () => {
      assert.ok(lnRev.includes('reviewer/gpt-5.6-sol') && lnRev.includes('model/grok-4.6'), 'label 名含 reviewer/<id>  →  ' + JSON.stringify(lnRev));
    });

    const stampCalls = [];
    const stampGh = (a) => {
      stampCalls.push(a.slice());
      if (a[0] === 'issue' && a[1] === 'view') return { ok: true, out: JSON.stringify({ labels: [] }) };
      if (a[0] === 'label' && a[1] === 'list') return { ok: true, out: JSON.stringify([{ name: 'model/grok-4.6' }, { name: 'type/写码' }]) };
      if (a[0] === 'label' && a[1] === 'create') return { ok: true, out: JSON.stringify({ name: a[2] }) };
      if (a[0] === 'issue' && a[1] === 'edit') return { ok: true, out: '{}' };
      return { ok: false, error: `未预期 ${a.join(' ')}` };
    };
    const stampedRev = S.stampIssueLabels({ issue: '123', model: 'grok-4.6', role: '写码', reviewer: 'gpt-5.6-sol', runGh: stampGh });
    await t.test('dispatch 打标含 reviewer/*',
      () => {
        assert.ok(stampedRev.ok === true && stampedRev.names.includes('reviewer/gpt-5.6-sol')
        && stampCalls.some(a => a[0] === 'issue' && a.includes('reviewer/gpt-5.6-sol')),
        'dispatch 打标含 reviewer/*  →  ' + JSON.stringify({ stampedRev, stampCalls }));
      });

    const syncRevCalls = [];
    const syncRev = S.syncPrLabelsFromIssue({
      pr: '8',
      runGh: (a) => {
        syncRevCalls.push(a.slice());
        if (a[0] === 'pr' && a[1] === 'view') return { ok: true, out: JSON.stringify({ title: 'x', body: 'Closes #8' }) };
        if (a[0] === 'issue' && a[1] === 'view') return { ok: true, out: JSON.stringify({ labels: [{ name: 'model/grok-4.6' }, { name: 'type/写码' }, { name: 'reviewer/gpt-5.6-sol' }, { name: '已消歧' }] }) };
        if (a[0] === 'label' && a[1] === 'list') return { ok: true, out: JSON.stringify([{ name: 'model/grok-4.6' }, { name: 'type/写码' }, { name: 'reviewer/gpt-5.6-sol' }]) };
        if (a[0] === 'pr' && a[1] === 'edit') return { ok: true, out: '{}' };
        return { ok: false, error: `未预期 ${a.join(' ')}` };
      },
    });
    await t.test('pr-sync-labels 抄 reviewer/*（已消歧仍不抄）',
      () => {
        assert.ok(syncRev.ok === true && syncRev.labels.includes('reviewer/gpt-5.6-sol') && syncRev.labels.includes('model/grok-4.6')
        && !syncRev.labels.includes('已消歧'),
        'pr-sync-labels 抄 reviewer/*（已消歧仍不抄）  →  ' + JSON.stringify(syncRev));
      });

    const onlyRevCalls = [];
    const onlyRev = S.syncPrLabelsFromIssue({
      pr: '11',
      runGh: (a) => {
        onlyRevCalls.push(a.slice());
        if (a[0] === 'pr' && a[1] === 'view') return { ok: true, out: JSON.stringify({ title: 'x', body: 'Closes #11' }) };
        if (a[0] === 'issue' && a[1] === 'view') return { ok: true, out: JSON.stringify({ labels: [{ name: 'reviewer/gpt-5.6-sol' }] }) };
        if (a[0] === 'pr' && a[1] === 'edit') return { ok: true, out: '{}' };
        return { ok: false, error: `未预期 ${a.join(' ')}` };
      },
    });
    await t.test('pr-sync-labels 只有 reviewer/* → 拒且不调 pr edit',
      () => {
        assert.ok(onlyRev.ok === false && /model/.test(onlyRev.error) && /type/.test(onlyRev.error)
        && !onlyRevCalls.some(a => a[0] === 'pr' && a[1] === 'edit'),
        'pr-sync-labels 只有 reviewer/* → 拒且不调 pr edit  →  ' + JSON.stringify({ onlyRev, onlyRevCalls }));
      });

    const modelOnlyCalls = [];
    const modelOnly = S.syncPrLabelsFromIssue({
      pr: '12',
      runGh: (a) => {
        modelOnlyCalls.push(a.slice());
        if (a[0] === 'pr' && a[1] === 'view') return { ok: true, out: JSON.stringify({ title: 'x', body: 'Closes #12' }) };
        if (a[0] === 'issue' && a[1] === 'view') return { ok: true, out: JSON.stringify({ labels: [{ name: 'model/grok-4.6' }, { name: 'reviewer/gpt-5.6-sol' }] }) };
        if (a[0] === 'pr' && a[1] === 'edit') return { ok: true, out: '{}' };
        return { ok: false, error: `未预期 ${a.join(' ')}` };
      },
    });
    await t.test('pr-sync-labels 有 model 无 type → 拒且不调 pr edit',
      () => {
        assert.ok(modelOnly.ok === false && /type/.test(modelOnly.error)
        && !modelOnlyCalls.some(a => a[0] === 'pr' && a[1] === 'edit'),
        'pr-sync-labels 有 model 无 type → 拒且不调 pr edit  →  ' + JSON.stringify({ modelOnly, modelOnlyCalls }));
      });

    const FAKE_GH3 = path.join(REPO, 'tests', 'fixtures', 'fake-gh.mjs');
    // 下面这几条测的是 **orca 那条脊**的输出契约（files / mergeable / oneReviewerGate /
    // 嵌套调 reviewer-create）。2026-09-06 默认执行体翻成 mirasim 之后必须显式 `--executor orca`
    // 点名，否则它们测的是 mirasim 路——那条路的返回形状本来就不同（不嵌套调 reviewer-create），
    // 于是红的是「测试钉错了路」而不是「代码坏了」。
    // mirasim 路自己的契约在 tests/mirasim-reviewer.test.js 与 tests/dao-dispatch-gate.test.js。
    // orca 脊整体删除时，这几条跟着删。
    const cliPick = spawnSync(process.execPath, [CLI, 'reviewer-create', '--pr', '42', '--executor', 'orca', '--dry-run'], {
      encoding: 'utf8', cwd: REPO, env: { ...process.env, DAO_GH_FAKE: FAKE_GH3 },
    });
    const pPick = (() => { try { return JSON.parse((cliPick.stdout || '').trim().split(/\r?\n/).pop()); } catch { return {}; } })();
    await t.test('CLI reviewer-create --pr 42 --dry-run 打印出自读选型',
      () => {
        assert.ok(cliPick.status === 0 && pPick.ok === true && pPick.dryRun === true && pPick.reviewer === 'gpt-5.6-luna' && pPick.reviewerSource === 'label',
          'CLI reviewer-create --pr 42 --dry-run 打印出自读选型  →  ' + `status=${cliPick.status} ${JSON.stringify(pPick)} stderr=${cliPick.stderr}`);
      });

    const cliNone = spawnSync(process.execPath, [CLI, 'reviewer-create', '--pr', '43', '--executor', 'orca', '--dry-run'], {
      encoding: 'utf8', cwd: REPO, env: { ...process.env, DAO_GH_FAKE: FAKE_GH3 },
    });
    const pNone = (() => { try { return JSON.parse((cliNone.stdout || '').trim().split(/\r?\n/).pop()); } catch { return {}; } })();
    await t.test('CLI reviewer-create 没有 reviewer/* → 非 0 且话面是「没有」',
      () => {
        assert.ok(cliNone.status !== 0 && /没有 reviewer/.test(String(pNone.error || '')),
          'CLI reviewer-create 没有 reviewer/* → 非 0 且话面是「没有」  →  ' + `status=${cliNone.status} ${JSON.stringify(pNone)}`);
      });

    const cliMany = spawnSync(process.execPath, [CLI, 'reviewer-create', '--pr', '44', '--executor', 'orca', '--dry-run'], {
      encoding: 'utf8', cwd: REPO, env: { ...process.env, DAO_GH_FAKE: FAKE_GH3 },
    });
    const pMany = (() => { try { return JSON.parse((cliMany.stdout || '').trim().split(/\r?\n/).pop()); } catch { return {}; } })();
    await t.test('CLI reviewer-create 有多个 reviewer/* → 非 0 且话面是「多个」',
      () => {
        assert.ok(cliMany.status !== 0 && /多个 reviewer/.test(String(pMany.error || '')),
          'CLI reviewer-create 有多个 reviewer/* → 非 0 且话面是「多个」  →  ' + `status=${cliMany.status} ${JSON.stringify(pMany)}`);
      });
    await t.test('CLI 没有 / 多个 话面不同', () => {
      assert.ok(String(pNone.error || '') !== String(pMany.error || ''), 'CLI 没有 / 多个 话面不同');
    });

    await t.test('worker-done 已登记进 VERBS', () => {
      assert.ok(S.VERBS.includes('worker-done'), 'worker-done 已登记进 VERBS  →  ' + S.VERBS.join(','));
    });
    const wdHelp = await cliInProc(['worker-done', '--help']);
    await t.test('worker-done 出现在 help', () => {
      assert.ok(/worker-done/.test(wdHelp.stdout || ''), 'worker-done 出现在 help  →  ' + (wdHelp.stdout || '').slice(0, 200));
    });
    const wdMiss = await cliInProc(['worker-done']);
    const pWdMiss = (() => { try { return JSON.parse(wdMiss.stdout || '{}'); } catch { return {}; } })();
    await t.test('worker-done 缺 --pr → 非零', () => {
      assert.ok(wdMiss.status !== 0 && /--pr/.test(String(pWdMiss.error || wdMiss.stderr || '')), 'worker-done 缺 --pr → 非零  →  ' + JSON.stringify(pWdMiss));
    });

    const cliWd = spawnSync(process.execPath, [CLI, 'worker-done', '--pr', '42', '--executor', 'orca', '--dry-run'], {
      encoding: 'utf8', cwd: REPO, env: { ...process.env, DAO_GH_FAKE: FAKE_GH3 },
    });
    const pWd = (() => { try { return JSON.parse((cliWd.stdout || '').trim().split(/\r?\n/).pop()); } catch { return {}; } })();
    await t.test('CLI worker-done --dry-run 首审：wired + shouldCreate + 调 reviewer-create --dry-run',
      () => {
        assert.ok(cliWd.status === 0 && pWd.ok === true && pWd.wired === true && pWd.round === 'first' && pWd.shouldCreate === true
        && pWd.reviewer === 'gpt-5.6-luna'
        && pWd.reviewerCreate && pWd.reviewerCreate.invoked === true && pWd.reviewerCreate.dryRun === true
        && pWd.reviewerCreate.reviewer === 'gpt-5.6-luna'
        && pWd.settled === false
        && /^完工/.test(pWd.comment || ''),
        'CLI worker-done --dry-run 首审：wired + shouldCreate + 调 reviewer-create --dry-run  →  ' + `status=${cliWd.status} ${JSON.stringify(pWd)}`);
      });

    const cliWdRework = spawnSync(process.execPath, [CLI, 'worker-done', '--pr', '46', '--executor', 'orca', '--dry-run'], {
      encoding: 'utf8', cwd: REPO, env: { ...process.env, DAO_GH_FAKE: FAKE_GH3 },
    });
    const pWdRework = (() => { try { return JSON.parse((cliWdRework.stdout || '').trim().split(/\r?\n/).pop()); } catch { return {}; } })();
    await t.test('CLI worker-done --dry-run 返工：shouldCreate=false，不起第二个审官',
      () => {
        assert.ok(cliWdRework.status === 0 && pWdRework.ok === true && pWdRework.wired === true
        && pWdRework.round === 'rework' && pWdRework.shouldCreate === false
        && pWdRework.reviewerCreate && pWdRework.reviewerCreate.skipped === true
        && pWdRework.settled === false
        && /^返工完成/.test(pWdRework.comment || ''),
        'CLI worker-done --dry-run 返工：shouldCreate=false，不起第二个审官  →  ' + `status=${cliWdRework.status} ${JSON.stringify(pWdRework)}`);
      });

    const badBody = S.planWorkerDone({
      pr: '42',
      body: '已完成：漏了首行关键字',
      runGh: (a) => {
        if (a[0] === 'pr' && a[1] === 'view' && String(a).includes('reviews')) {
          return { ok: true, out: JSON.stringify({ reviews: [] }) };
        }
        if (a[0] === 'pr' && a[1] === 'view') return { ok: true, out: JSON.stringify({ title: 'x', body: 'Closes #565' }) };
        if (a[0] === 'issue' && a[1] === 'view') return { ok: true, out: JSON.stringify({ labels: [{ name: 'reviewer/gpt-5.6-sol' }] }) };
        return { ok: false, error: `未预期 ${a.join(' ')}` };
      },
    });
    await t.test('worker-done --body 不以「完工」开头 → 拒', () => {
      assert.ok(badBody.ok === false && /完工/.test(badBody.error), 'worker-done --body 不以「完工」开头 → 拒  →  ' + JSON.stringify(badBody));
    });

    const daoSrc586 = fs.readFileSync(CLI, 'utf8');
    await t.test('#586 不重写 reviewer-create 既有坑：仍走 assessPrMergeable + trialMergeMaster',
      () => {
        assert.ok(/function cmdReviewerCreate[\s\S]*assessPrMergeable/.test(daoSrc586)
        && /function cmdReviewerCreate[\s\S]*trialMergeMaster/.test(daoSrc586), '#586 不重写 reviewer-create 既有坑：仍走 assessPrMergeable + trialMergeMaster');
      });
    const wdFn = (daoSrc586.match(/function cmdWorkerDone\([\s\S]*?\nfunction /) || [''])[0];
    await t.test('#586 worker-done 首审真调 reviewer-create（不带 --dry-run 才建树）',
      () => {
        assert.ok(/invokeReviewerCreate\(/.test(wdFn) && /dryRun: false/.test(wdFn) && !/argsWorktreeCreate/.test(wdFn),
          '#586 worker-done 首审真调 reviewer-create（不带 --dry-run 才建树）  →  ' + wdFn.slice(0, 240));
      });
    await t.test('#675 完工评论在起审官之前（失败也要留交卷证据；PR #758 起幂等走 postCommentOnce）', () => {
      const post = wdFn.indexOf('#675：交卷证据必须先落到 GitHub');
      const spawn = post >= 0 ? wdFn.indexOf('if (shouldCreate)', post) : -1;
      assert.ok(post >= 0 && spawn > post && /postCommentOnce/.test(wdFn.slice(post, spawn)),
        '#675 完工评论在起审官之前（幂等）  →  post=' + post + ' spawn=' + spawn);
    });
    await t.test('#675 起审官失败三态分开', () => {
      const timeout = S.classifyReviewerSpawnError('审官终端创建失败: terminal create 失败: Timed out waiting for terminal handle after creation');
      const paste = S.classifyReviewerSpawnError('审官注入后开工验证失败: 注入未提交（Pasted Content / Pasted text）');
      const miss = S.classifyReviewerSpawnError('worker-list 没查成');
      assert.ok(timeout.kind === 'terminal-timeout' && paste.kind === 'inject-unsubmitted' && miss.kind === 'unscanned',
        '#675 三态  →  ' + JSON.stringify({ timeout, paste, miss }));
      assert.ok(timeout.label !== paste.label && paste.label !== miss.label && timeout.label !== miss.label, '三态标签互不相同');
    });
    await t.test('#675 失败评论写清种类且不以「完工」打头', () => {
      const body = S.reviewerSpawnFailComment({ error: '注入未提交（Pasted Content）', retried: true });
      assert.ok(/^交卷没开成审官下一跳：注入未提交/.test(body) && !/^完工/.test(body) && /已重试一次/.test(body),
        '#675 失败评论  →  ' + body.slice(0, 200));
    });
    await t.test('#586 worker-done 首审/返工都走 completeWorkerDoneNotify（投失败即停）',
      () => {
        assert.ok(/create\.reviewerDispatchId/.test(wdFn) && /completeWorkerDoneNotify/.test(wdFn)
        && !/plan\.round === 'first' && reviewerDispatchId/.test(wdFn),
        '#586 worker-done 首审/返工都走 completeWorkerDoneNotify（投失败即停）  →  ' + wdFn.slice(0, 400));
      });
    await t.test('#677 worker-done 成功路径不结算（无 settleDispatch / 无 type worker_done）', () => {
      assert.ok(/settled: false/.test(wdFn) && !/settleDispatch\(/.test(wdFn)
        && !/--type['"]?\s*,\s*['"]worker_done['"]/.test(wdFn)
        && /#677：本命令只交 GitHub 卷/.test(wdFn),
        '#677 worker-done 不结算  →  ' + wdFn.slice(0, 280));
    });
    const reworkNotifyCalls = [];
    const reworkNotify = S.completeWorkerDoneNotify({
      round: 'rework',
      pr: '46',
      comment: '返工完成：PR #46\n\n已修红项',
      reviewerDispatchId: 'ctx_reviewer_existing',
      deliver: (opts) => {
        reworkNotifyCalls.push(opts);
        return { ok: true, messageId: 'msg_rework1', hop: opts.hop };
      },
    });
    await t.test('#677 completeWorkerDoneNotify 是投递给审官，不是结算士兵', () => {
      assert.ok(reworkNotifyCalls.length === 1 && reworkNotifyCalls[0].type !== 'worker_done'
        && reworkNotifyCalls[0].hop === '士兵→审官'
        && String(reworkNotifyCalls[0].to).startsWith('dispatch:'),
        '#677 投递审官不是结算  →  ' + JSON.stringify(reworkNotifyCalls[0]));
    });
    await t.test('#586 返工路径 notified.ok===true（不只是 commentPosted）',
      () => {
        assert.ok(reworkNotify.ok === true && reworkNotify.notified && reworkNotify.notified.ok === true
        && reworkNotify.notified.dispatchId === 'ctx_reviewer_existing',
        '#586 返工路径 notified.ok===true（不只是 commentPosted）  →  ' + JSON.stringify(reworkNotify));
      });
    const pickedReuseFail = S.pickWorkerDoneDispatchId({
      create: { skipped: true },
      reused: { ok: false, reuseFailed: true, error: 'runtime_unavailable' },
      existingDispatchId: 'ctx_reviewer_existing',
    });
    await t.test('#552 复用 worker-start 失败禁止回退已有 dispatch（可能已结算）',
      () => {
        assert.ok(pickedReuseFail.ok === false && /禁止回退/.test(pickedReuseFail.error || '')
        && !pickedReuseFail.reviewerDispatchId,
        '#552 复用 worker-start 失败禁止回退已有 dispatch（可能已结算）  →  ' + JSON.stringify(pickedReuseFail));
      });
    const pickedExistingBlocked = S.pickWorkerDoneDispatchId({
      create: { skipped: true },
      reused: { skipped: true },
      existingDispatchId: 'ctx_reviewer_existing',
    });
    await t.test('#552 已有审官 dispatch 不得当复审收件人',
      () => {
        assert.ok(pickedExistingBlocked.ok === false && pickedExistingBlocked.source === 'existing-blocked'
        && /#552/.test(pickedExistingBlocked.error || ''),
        '#552 已有审官 dispatch 不得当复审收件人  →  ' + JSON.stringify(pickedExistingBlocked));
      });
    await t.test('#586 返工投递主题是「返工完成：PR #…」且收件人是现有审官 dispatch',
      () => {
        assert.ok(reworkNotifyCalls.length === 1
        && reworkNotifyCalls[0].to === 'dispatch:ctx_reviewer_existing'
        && reworkNotifyCalls[0].subject === '返工完成：PR #46'
        && reworkNotifyCalls[0].hop === '士兵→审官',
        '#586 返工投递主题是「返工完成：PR #…」且收件人是现有审官 dispatch  →  ' + JSON.stringify(reworkNotifyCalls));
      });
    const reworkNoId = S.completeWorkerDoneNotify({
      round: 'rework',
      pr: '46',
      comment: '返工完成：PR #46',
      reviewerDispatchId: null,
    });
    await t.test('#586 返工找不到审官 dispatch → fail-visible',
      () => {
        assert.ok(reworkNoId.ok === false && /审官/.test(reworkNoId.error || ''),
          '#586 返工找不到审官 dispatch → fail-visible  →  ' + JSON.stringify(reworkNoId));
      });
    const reworkFailDeliver = S.completeWorkerDoneNotify({
      round: 'rework',
      pr: '46',
      comment: '返工完成：PR #46',
      reviewerDispatchId: 'ctx_x',
      deliver: () => ({ ok: false, error: '士兵→审官：收件人不存在' }),
    });
    await t.test('#586 返工投递失败 → fail-visible',
      () => {
        assert.ok(reworkFailDeliver.ok === false && /没送到|不存在/.test(reworkFailDeliver.error || ''),
          '#586 返工投递失败 → fail-visible  →  ' + JSON.stringify(reworkFailDeliver));
      });
    const reworkPlan = S.planWorkerDone({
      pr: '46',
      runGh: (a) => {
        if (a[0] === 'pr' && a[1] === 'view' && String(a).includes('reviews')) {
          return { ok: true, out: JSON.stringify({ reviews: [{ id: 1, body: '判定：红 1 项' }] }) };
        }
        if (a[0] === 'pr' && a[1] === 'view') return { ok: true, out: JSON.stringify({ title: 'x', body: 'Closes #565' }) };
        if (a[0] === 'issue' && a[1] === 'view') return { ok: true, out: JSON.stringify({ labels: [{ name: 'reviewer/gpt-5.6-sol' }] }) };
        return { ok: false, error: `未预期 ${a.join(' ')}` };
      },
    });
    await t.test('planWorkerDone 已有 review → rework，shouldCreate=false',
      () => {
        assert.ok(reworkPlan.ok === true && reworkPlan.round === 'rework' && reworkPlan.shouldCreate === false
        && /^返工完成/.test(reworkPlan.comment),
        'planWorkerDone 已有 review → rework，shouldCreate=false  →  ' + JSON.stringify(reworkPlan));
      });

    const parent = 'wt_worker';
    const parentWt = { id: parent, parentWorktreeId: null };
    const first = S.resolveReviewerReuse({
      parentId: parent, worktrees: [parentWt], workers: [], terminals: [],
    });
    const afterCreate = S.resolveReviewerReuse({
      parentId: parent,
      worktrees: [
        parentWt,
        { id: 'wt_rev', parentWorktreeId: parent, createdAt: 10, displayName: '随便叫啥' },
      ],
      workers: [{
        dispatchId: 'ctx_r1',
        resource: { worktreeId: 'wt_rev', terminalHandle: 'term_r' },
        agentTerminalHandle: 'term_r',
        terminalState: 'retained',
      }],
      terminals: [{ handle: 'term_r', worktreeId: 'wt_rev', status: 'running' }],
    });
    const afterRework = S.resolveReviewerReuse({
      parentId: parent,
      worktrees: [
        parentWt,
        { id: 'wt_rev', parentWorktreeId: parent, createdAt: 10, displayName: '随便叫啥' },
      ],
      workers: [{
        dispatchId: 'ctx_r2',
        resource: { worktreeId: 'wt_rev', terminalHandle: 'term_r' },
        agentTerminalHandle: 'term_r',
      }],
      terminals: [{ handle: 'term_r', worktreeId: 'wt_rev', status: 'running' }],
    });
    await t.test('#586 样本① 首审→返工→复核全程只有一个审官卡',
      () => {
        assert.ok(first.action === 'create' && afterCreate.action === 'reuse' && afterCreate.worktreeId === 'wt_rev'
        && afterRework.action === 'reuse' && afterRework.worktreeId === 'wt_rev'
        && afterRework.handle === 'term_r',
        '#586 样本① 首审→返工→复核全程只有一个审官卡  →  ' + JSON.stringify({ first, afterCreate, afterRework }));
      });

    const closed = S.resolveReviewerReuse({
      parentId: parent,
      worktrees: [
        parentWt,
        { id: 'wt_rev_dead', parentWorktreeId: parent, createdAt: 10 },
      ],
      workers: [{
        dispatchId: 'ctx_dead',
        resource: { worktreeId: 'wt_rev_dead', terminalHandle: 'term_dead' },
        agentTerminalHandle: 'term_dead',
      }],
      terminals: [{ handle: 'term_dead', worktreeId: 'wt_rev_dead', status: 'exited' }],
    });
    await t.test('#586 样本② 老审官终端已关闭 → 拒绝新建，不许再 create',
      () => {
        assert.ok(closed.action === 'refuse' && closed.outcome === 'refused-existing'
        && /拒绝新建/.test(closed.error || closed.reason || '')
        && Array.isArray(closed.closedWorktrees) && closed.closedWorktrees.includes('wt_rev_dead'),
        '#586 样本② 老审官终端已关闭 → 拒绝新建  →  ' + JSON.stringify(closed));
      });

    const secondPr = S.resolveReviewerReuse({
      parentId: parent,
      worktrees: [
        parentWt,
        { id: 'wt_rev_590', parentWorktreeId: parent, createdAt: 1, displayName: '#590 - 别的号' },
      ],
      workers: [{
        dispatchId: 'ctx_590',
        resource: { worktreeId: 'wt_rev_590', terminalHandle: 'term_590' },
        agentTerminalHandle: 'term_590',
      }],
      terminals: [{ handle: 'term_590', worktreeId: 'wt_rev_590', status: 'running' }],
    });
    await t.test('#586 样本③ 同一工人换 PR 号不新建审官',
      () => {
        assert.ok(secondPr.action === 'reuse' && secondPr.worktreeId === 'wt_rev_590',
          '#586 样本③ 同一工人换 PR 号不新建审官  →  ' + JSON.stringify(secondPr));
      });

    const namedOnly = S.resolveReviewerReuse({
      parentId: parent,
      worktrees: [
        parentWt,
        { id: 'wt_named', parentWorktreeId: parent, createdAt: 1, displayName: '#1 - 审官·gpt' },
      ],
      workers: [],
      terminals: [],
    });
    const bookedAnon = S.resolveReviewerReuse({
      parentId: parent,
      worktrees: [
        parentWt,
        { id: 'wt_aux', parentWorktreeId: parent, createdAt: 1, displayName: '辅助·foo' },
      ],
      workers: [{
        dispatchId: 'ctx_aux',
        resource: { worktreeId: 'wt_aux', terminalHandle: 'term_aux' },
        agentTerminalHandle: 'term_aux',
      }],
      terminals: [{ handle: 'term_aux', status: 'running' }],
    });
    await t.test('#586 找审官不靠卡名：有「审官」二字但无记账 ≠ 审官卡',
      () => {
        assert.ok(namedOnly.action === 'create', '#586 找审官不靠卡名：有「审官」二字但无记账 ≠ 审官卡  →  ' + JSON.stringify(namedOnly));
      });
    await t.test('#586 找审官不靠卡名：有记账的子卡就算（即使卡名没有审官）',
      () => {
        assert.ok(bookedAnon.action === 'reuse' && bookedAnon.worktreeId === 'wt_aux',
          '#586 找审官不靠卡名：有记账的子卡就算（即使卡名没有审官）  →  ' + JSON.stringify(bookedAnon));
      });

    const staleThenLive = S.resolveReviewerReuse({
      parentId: parent,
      worktrees: [
        parentWt,
        { id: 'wt_rev_mix', parentWorktreeId: parent, createdAt: 10 },
      ],
      workers: [
        {
          dispatchId: 'ctx_old_done',
          dispatchStatus: 'completed',
          workerState: 'succeeded',
          resource: { worktreeId: 'wt_rev_mix', terminalHandle: 'term_stale' },
          agentTerminalHandle: 'term_stale',
        },
        {
          dispatchId: 'ctx_new_failed',
          dispatchStatus: 'failed',
          workerState: 'failed',
          resource: { worktreeId: 'wt_rev_mix', terminalHandle: 'term_live' },
          agentTerminalHandle: 'term_live',
        },
      ],
      terminals: [
        { handle: 'term_live', worktreeId: 'wt_rev_mix', connected: true, writable: true },
      ],
    });
    await t.test('#586 同树先结算后失败：复用还活着的 handle，不因旧 handle 误判已关',
      () => {
        assert.ok(staleThenLive.action === 'reuse' && staleThenLive.handle === 'term_live',
          '#586 同树先结算后失败：复用还活着的 handle，不因旧 handle 误判已关  →  ' + JSON.stringify(staleThenLive));
      });

    await t.test('#586 worker-done 源码不再用卡名匹配找审官',
      () => {
        assert.ok(!/\/审官\//.test(wdFn) && /resolveReviewerReuse/.test(wdFn) && /reuseReviewerOnTerminal/.test(wdFn),
          '#586 worker-done 源码不再用卡名匹配找审官  →  ' + wdFn.slice(0, 280));
      });
    await t.test('#586 复用路径 worker-start 必带审官树 --worktree',
      () => {
        assert.ok(/worktree: reviewerWorktreeId/.test(daoSrc586) && /result\.task\.id/.test(daoSrc586),
          '#586 复用路径 worker-start 必带审官树 --worktree  →  复用路径要显式 --worktree，task id 取 result.task.id');
      });
  });

  it('#546 #541 审官树自证 / 注入后开工 / 环境自检', async (t) => {
    const S = await S_LOAD;
    const folded = S.verifyInjection({ text: '⚠ MCP failed\n[Pasted Content 4686 chars]\n›' });
    await t.test('故意违规：Pasted Content 折叠 → 注入验证红', () => {
      assert.ok(folded.ok === false && /Pasted Content/.test(folded.reason), '故意违规：Pasted Content 折叠 → 注入验证红  →  ' + JSON.stringify(folded));
    });
    await t.test('折叠证据带字符数', () => {
      assert.ok(folded.evidence === '[Pasted Content 4686 chars]', '折叠证据带字符数  →  ' + JSON.stringify(folded));
    });
    const unreadInj = S.verifyInjection({ readError: 'terminal_handle_stale' });
    await t.test('注入后没读成 ≠ 已开工', () => {
      assert.ok(unreadInj.ok === false && unreadInj.unscanned === true, '注入后没读成 ≠ 已开工  →  ' + JSON.stringify(unreadInj));
    });
    const emptyInj = S.verifyInjection({ text: '   ' });
    await t.test('注入后屏面空 → 红', () => {
      assert.ok(emptyInj.ok === false && /空/.test(emptyInj.reason), '注入后屏面空 → 红  →  ' + JSON.stringify(emptyInj));
    });
    const landed = S.verifyInjection({ text: '短摘要：修命令库\nThinking...\n' });
    await t.test('屏上无 Pasted Content → 注入验证绿', () => {
      assert.ok(landed.ok === true, '屏上无 Pasted Content → 注入验证绿  →  ' + JSON.stringify(landed));
    });
    // #762 故意违规样本：expect 给了但屏面不含任务书指纹 → 必须红。
    // 2026-08-25 审官实测：屏面只有 PS 提示符（注入没发生）被 3 轮稳定判绿——纯函数漏洞。
    const noFingerprint = S.verifyInjection({ text: 'PS C:\\repo>', expect: '按审官任务书审 PR' });
    await t.test('#762 故意违规：expect 给了但屏面无任务书指纹 → 注入验证红（防 PS 提示符假绿）', () => {
      assert.ok(noFingerprint.ok === false && /任务书指纹/.test(noFingerprint.reason), '#762 expect 校验 → 红  →  ' + JSON.stringify(noFingerprint));
    });
    const withFingerprint = S.verifyInjection({ text: '按审官任务书审 PR #767\nReading...', expect: '按审官任务书审 PR' });
    await t.test('#762 expect 出现在屏面 → 注入验证绿', () => {
      assert.ok(withFingerprint.ok === true, '#762 expect 命中 → 绿  →  ' + JSON.stringify(withFingerprint));
    });

    // #559 ⑥：判开工优先 worker-read --source auto（官方可证明 transcript 源）
    const provenAuto = S.verifyWorkerStarted({ ok: true, result: { source: 'auto', transcript: { messages: [] } } });
    await t.test('#559 worker-read source=auto → 开工证明绿（官方 transcript 源）', () => {
      assert.ok(provenAuto.ok === true && provenAuto.proven === true, '#559 worker-read source=auto → 开工证明绿（官方 transcript 源）  →  ' + JSON.stringify(provenAuto));
    });
    const provenTranscript = S.verifyWorkerStarted({ ok: true, result: { source: 'transcript', transcript: { messages: [{ role: 'user', blocks: [] }] } } });
    await t.test('#559 worker-read source=transcript → 同样绿', () => {
      assert.ok(provenTranscript.ok === true && provenTranscript.proven === true, '#559 worker-read source=transcript → 同样绿  →  ' + JSON.stringify(provenTranscript));
    });
    const weakTerminal = S.verifyWorkerStarted({ ok: true, result: { source: 'terminal', fallbackReason: 'no_hook_report', terminal: { tail: [] } } });
    await t.test('#559 worker-read source=terminal → 降级（proven=false，带 fallbackReason）', () => {
      assert.ok(weakTerminal.ok === false && weakTerminal.proven === false && weakTerminal.fallbackReason === 'no_hook_report', '#559 worker-read source=terminal → 降级（proven=false，带 fallbackReason）  →  ' + JSON.stringify(weakTerminal));
    });
    const unreadProof = S.verifyWorkerStarted({ ok: false, error: { code: 'dispatch_not_found', message: 'x' } });
    await t.test('#559 worker-read 没读成 → unscanned（不许当成没开工）', () => {
      assert.ok(unreadProof.ok === false && unreadProof.unscanned === true, '#559 worker-read 没读成 → unscanned（不许当成没开工）  →  ' + JSON.stringify(unreadProof));
    });
    await t.test('#559 worker-read 已登记进 VERBS', () => {
      assert.ok(S.VERBS.includes('worker-read'), '#559 worker-read 已登记进 VERBS  →  ' + S.VERBS.join(','));
    });
    const wrRead = S.argsWorkerRead({ dispatch: 'ctx_x', source: 'auto', limit: 50 });
    await t.test('worker-read 拼 --dispatch/--source/--limit', () => {
      assert.ok(wrRead.includes('--source') && wrRead.includes('--limit'), 'worker-read 拼 --dispatch/--source/--limit  →  ' + wrRead.join(' '));
    });

    const filesUnscanned = S.verifyReviewerFiles({ reviewerPath: REPO });
    await t.test('#541 没给清单 = 没查成', () => {
      assert.ok(filesUnscanned.ok === false && filesUnscanned.unscanned === true, '#541 没给清单 = 没查成  →  ' + JSON.stringify(filesUnscanned));
    });
    const filesEmpty = S.verifyReviewerFiles({ reviewerPath: REPO, files: [] });
    await t.test('#541 空文件清单（PR 尚无改文件）→ 绿', () => {
      assert.ok(filesEmpty.ok === true && filesEmpty.checked === 0, '#541 空文件清单（PR 尚无改文件）→ 绿  →  ' + JSON.stringify(filesEmpty));
    });
    await t.test('#541 parseGhPullFiles 跳过 removed', () => {
      assert.ok(JSON.stringify(S.parseGhPullFiles([
        { filename: 'a.js', status: 'added' },
        { filename: 'gone.js', status: 'removed' },
      ])) === JSON.stringify(['a.js']), '#541 parseGhPullFiles 跳过 removed');
    });
    const filesOk = S.verifyReviewerFiles({ reviewerPath: REPO, files: ['scripts/dao.mjs', 'scripts/lib/dao-cmd.mjs'] });
    await t.test('#541 被审文件在 → 绿', () => {
      assert.ok(filesOk.ok === true && filesOk.checked === 2, '#541 被审文件在 → 绿  →  ' + JSON.stringify(filesOk));
    });
    const filesMiss = S.verifyReviewerFiles({ reviewerPath: REPO, files: ['scripts/dao.mjs', 'this-file-does-not-exist-541.js'] });
    await t.test('#541 缺被审文件 → 红并点名', () => {
      assert.ok(filesMiss.ok === false && (filesMiss.missing || []).includes('this-file-does-not-exist-541.js'), '#541 缺被审文件 → 红并点名  →  ' + JSON.stringify(filesMiss));
    });

    const parsed = S.parseDiffNameStatus('M\tscripts/dao.mjs\nA\thost/skills/dispatch/hooks/hooks.json\nD\told.txt\nR100\ta.txt\tb.txt\n');
    await t.test('name-status 收 A/M/R 新名、跳过 D', () => {
      assert.ok(parsed.includes('scripts/dao.mjs') && parsed.includes('host/skills/dispatch/hooks/hooks.json') && parsed.includes('b.txt') && !parsed.includes('old.txt'), 'name-status 收 A/M/R 新名、跳过 D  →  ' + JSON.stringify(parsed));
    });

    const tmpA = fs.mkdtempSync(path.join(os.tmpdir(), 'dao-rev-a-'));
    const tmpB = fs.mkdtempSync(path.join(os.tmpdir(), 'dao-rev-b-'));
    const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
    const gitIn = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8', env: gitEnv });
    gitIn(tmpA, ['init', '-q']);
    gitIn(tmpA, ['config', 'user.email', 't@t']);
    gitIn(tmpA, ['config', 'user.name', 't']);
    fs.writeFileSync(path.join(tmpA, 'f.txt'), 'a\n');
    gitIn(tmpA, ['add', 'f.txt']);
    gitIn(tmpA, ['commit', '-q', '-m', 'a']);
    gitIn(tmpB, ['init', '-q']);
    gitIn(tmpB, ['config', 'user.email', 't@t']);
    gitIn(tmpB, ['config', 'user.name', 't']);
    fs.writeFileSync(path.join(tmpB, 'f.txt'), 'b\n');
    gitIn(tmpB, ['add', 'f.txt']);
    gitIn(tmpB, ['commit', '-q', '-m', 'b']);
    const mismatch = S.verifyReviewerTree({ workerPath: tmpA, reviewerPath: tmpB });
    await t.test('#541 审官 HEAD ≠ 工人 HEAD → 红', () => {
      assert.ok(mismatch.ok === false && /审空气/.test(mismatch.error), '#541 审官 HEAD ≠ 工人 HEAD → 红  →  ' + JSON.stringify(mismatch));
    });
    const same = S.verifyReviewerTree({ workerPath: tmpA, reviewerPath: tmpA });
    await t.test('#541 两树 HEAD 相同 → 绿', () => {
      assert.ok(same.ok === true && same.reviewerHead === same.expectedOid, '#541 两树 HEAD 相同 → 绿  →  ' + JSON.stringify(same));
    });

    const missingDir = path.join(os.tmpdir(), `dao-env-missing-${Date.now()}`);
    const ro = S.envProbeWorktree(missingDir);
    await t.test('#546 故意让工作区不可写 → 环境自检红（写探针）', () => {
      assert.ok(ro.ok === false && (ro.failed || []).includes('write'), '#546 故意让工作区不可写 → 环境自检红（写探针）  →  ' + JSON.stringify(ro));
    });

    await t.test('#575 ⑦ MERGEABLE → 放行', () => {
      assert.ok(S.assessPrMergeable('MERGEABLE').ok === true, '#575 ⑦ MERGEABLE → 放行');
    });
    await t.test('#575 ⑦ CONFLICTING → 拒建树', () => {
      assert.ok(S.assessPrMergeable('CONFLICTING').ok === false && /rebase master/.test(S.assessPrMergeable('CONFLICTING').error), '#575 ⑦ CONFLICTING → 拒建树');
    });
    await t.test('#575 ⑦ UNKNOWN → 没查成，不是绿', () => {
      assert.ok(S.assessPrMergeable('UNKNOWN').ok === false && S.assessPrMergeable('UNKNOWN').unscanned === true, '#575 ⑦ UNKNOWN → 没查成，不是绿');
    });
    await t.test('#575 ⑦ 空值 → 没查成', () => {
      assert.ok(S.assessPrMergeable('').unscanned === true, '#575 ⑦ 空值 → 没查成');
    });
    await t.test('#575 ⑦ 不认识的值 → 没查成', () => {
      assert.ok(S.assessPrMergeable('DIRTY').unscanned === true, '#575 ⑦ 不认识的值 → 没查成');
    });

    const alignRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dao-align-'));
    const originDir = path.join(alignRoot, 'origin');
    const workDir = path.join(alignRoot, 'work');
    fs.mkdirSync(originDir);
    const envGit = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
    const g = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8', env: envGit });
    g(originDir, ['init', '-q', '-b', 'master']);
    g(originDir, ['config', 'user.email', 't@t']);
    g(originDir, ['config', 'user.name', 't']);
    fs.writeFileSync(path.join(originDir, 'a.txt'), 'a0\n');
    g(originDir, ['add', 'a.txt']);
    g(originDir, ['commit', '-q', '-m', 'base']);
    g(originDir, ['checkout', '-q', '-b', 'feature']);
    fs.writeFileSync(path.join(originDir, 'b.txt'), 'b\n');
    g(originDir, ['add', 'b.txt']);
    g(originDir, ['commit', '-q', '-m', 'feature']);
    g(originDir, ['checkout', '-q', 'master']);
    fs.writeFileSync(path.join(originDir, 'c.txt'), 'c\n');
    g(originDir, ['add', 'c.txt']);
    g(originDir, ['commit', '-q', '-m', 'master-ahead']);
    spawnSync('git', ['clone', '-q', '-b', 'feature', originDir, workDir], { encoding: 'utf8', env: envGit });
    g(workDir, ['config', 'user.email', 't@t']);
    g(workDir, ['config', 'user.name', 't']);
    const headBefore = String(g(workDir, ['rev-parse', 'HEAD']).stdout).trim();
    const alignOk = S.trialMergeMaster({ cwd: workDir });
    const headAfter = String(g(workDir, ['rev-parse', 'HEAD']).stdout).trim();
    const dirty = String(g(workDir, ['status', '--porcelain']).stdout).trim();
    await t.test('#575 ⑦ 试合无冲突：ok 且落后 ≥1', () => {
      assert.ok(alignOk.ok === true && alignOk.behind >= 1 && alignOk.conflict === false, '#575 ⑦ 试合无冲突：ok 且落后 ≥1  →  ' + JSON.stringify(alignOk));
    });
    const fakeFail = S.trialMergeMaster({
      cwd: workDir,
      runGit: (args) => {
        if (args[0] === 'merge' && args[1] !== '--abort') return { ok: false, error: 'Author identity unknown' };
        const { spawnSync } = require('child_process');
        const r = spawnSync('git', ['-C', workDir, ...args], { encoding: 'utf8' });
        if (r.error || (r.status !== 0 && r.status != null)) {
          return { ok: false, error: String(r.stderr || r.status) };
        }
        return { ok: true, out: String(r.stdout || '').trim() };
      },
    });
    await t.test('#575 ⑦ merge 非零但无 unmerged → 没查成，不是 conflict',
      () => {
        assert.ok(fakeFail.ok === false && fakeFail.unscanned === true && !fakeFail.conflict, '#575 ⑦ merge 非零但无 unmerged → 没查成，不是 conflict  →  ' + JSON.stringify(fakeFail));
      });
    await t.test('#575 ⑦ 试合后 HEAD 仍是 PR head', () => {
      assert.ok(headAfter === headBefore, '#575 ⑦ 试合后 HEAD 仍是 PR head  →  ' + `${headBefore} → ${headAfter}`);
    });
    await t.test('#575 ⑦ 试合后工作区干净', () => {
      assert.ok(dirty === '', '#575 ⑦ 试合后工作区干净  →  ' + dirty);
    });

    const clashDir = path.join(alignRoot, 'clash');
    g(originDir, ['checkout', '-q', 'feature']);
    fs.writeFileSync(path.join(originDir, 'a.txt'), 'feature-change\n');
    g(originDir, ['add', 'a.txt']);
    g(originDir, ['commit', '-q', '-m', 'feature-touch-a']);
    g(originDir, ['checkout', '-q', 'master']);
    fs.writeFileSync(path.join(originDir, 'a.txt'), 'master-change\n');
    g(originDir, ['add', 'a.txt']);
    g(originDir, ['commit', '-q', '-m', 'master-touch-a']);
    spawnSync('git', ['clone', '-q', '-b', 'feature', originDir, clashDir], { encoding: 'utf8', env: envGit });
    g(clashDir, ['config', 'user.email', 't@t']);
    g(clashDir, ['config', 'user.name', 't']);
    const clashHead = String(g(clashDir, ['rev-parse', 'HEAD']).stdout).trim();
    const alignClash = S.trialMergeMaster({ cwd: clashDir });
    const clashHeadAfter = String(g(clashDir, ['rev-parse', 'HEAD']).stdout).trim();
    const clashDirty = String(g(clashDir, ['status', '--porcelain']).stdout).trim();
    await t.test('#575 ⑦ 试合有冲突：conflict=true 且仍 ok（树已还原）', () => {
      assert.ok(alignClash.ok === true && alignClash.conflict === true, '#575 ⑦ 试合有冲突：conflict=true 且仍 ok（树已还原）  →  ' + JSON.stringify(alignClash));
    });
    await t.test('#575 ⑦ 冲突试合后 HEAD 不变', () => {
      assert.ok(clashHeadAfter === clashHead, '#575 ⑦ 冲突试合后 HEAD 不变');
    });
    await t.test('#575 ⑦ 冲突试合后工作区干净', () => {
      assert.ok(clashDirty === '', '#575 ⑦ 冲突试合后工作区干净  →  ' + clashDirty);
    });

    const daoSrcAlign = fs.readFileSync(CLI, 'utf8');
    await t.test('#575 ⑦ reviewer-create 建树前走 assessPrMergeable', () => {
      assert.ok(/function cmdReviewerCreate[\s\S]*assessPrMergeable/.test(daoSrcAlign), '#575 ⑦ reviewer-create 建树前走 assessPrMergeable');
    });
    await t.test('#575 ⑦ reviewer-attach 建树前走 assessPrMergeable', () => {
      assert.ok(/function cmdReviewerAttach[\s\S]*assessPrMergeable/.test(daoSrcAlign), '#575 ⑦ reviewer-attach 建树前走 assessPrMergeable');
    });
    await t.test('#575 ⑦ reviewer-create 建树后试合', () => {
      assert.ok(/function cmdReviewerCreate[\s\S]*trialMergeMaster/.test(daoSrcAlign), '#575 ⑦ reviewer-create 建树后试合');
    });

    const revHelp = await cliInProc(['reviewer-create', '--help']);
    await t.test('reviewer-create 出现在 help', () => {
      assert.ok(/reviewer-create/.test(revHelp.stdout || ''), 'reviewer-create 出现在 help  →  ' + (revHelp.stdout || '').slice(0, 200));
    });
    const revMiss = await cliInProc(['reviewer-create', '--name', 'x']);
    const pRevMiss = (() => { try { return JSON.parse(revMiss.stdout || '{}'); } catch { return {}; } })();
    await t.test('reviewer-create 缺 --pr → 非零', () => {
      assert.ok(revMiss.status !== 0 && /--pr/.test(String(pRevMiss.error || revMiss.stderr || '')), 'reviewer-create 缺 --pr → 非零  →  ' + JSON.stringify(pRevMiss));
    });
  });

  it('#546 追加第五件：士兵—审官闭环任务书模板', async (t) => {
    const S = await S_LOAD;
    const tmplDir = path.join(REPO, 'host', 'skills', 'dispatch', 'templates');
    const files = S.listDispatchTemplates();
    await t.test('模板目录有 soldier-book + reviewer-book + 两份 inject', () => {
      assert.ok(files.includes('soldier-book.md') && files.includes('reviewer-book.md') && files.includes('soldier-inject.md') && files.includes('reviewer-inject.md'), '模板目录有 soldier-book + reviewer-book + 两份 inject  →  ' + files.join(','));
    });

    const soldierBook = fs.readFileSync(path.join(tmplDir, 'soldier-book.md'), 'utf8');
    await t.test('soldier-book 不再内嵌审官 dispatch id（#586 按需起）', () => {
      assert.ok(!/REVIEWER_DISPATCH_ID/.test(soldierBook) && !/dispatch:undefined/.test(soldierBook), 'soldier-book 不再内嵌审官 dispatch id（#586 按需起）  →  ' + soldierBook.slice(-220));
    });
    await t.test('soldier-book 完工走 worker-done', () => {
      assert.ok(/worker-done/.test(soldierBook) && /--pr/.test(soldierBook), 'soldier-book 完工走 worker-done  →  ' + soldierBook.slice(-260));
    });
    await t.test('soldier-book 要求不要自己发 comment / notify', () => {
      assert.ok(/不要自己/.test(soldierBook), 'soldier-book 要求不要自己发 comment / notify');
    });

    const soldier = S.buildSoldierInject({ spec: '短摘要：修 X', issue: 602 });
    await t.test('士兵注入是单行且含 spec', () => {
      assert.ok(!/[\r\n]/.test(soldier) && /短摘要：修 X/.test(soldier), '士兵注入是单行且含 spec  →  ' + soldier);
    });
    await t.test('士兵注入含指针路径', () => {
      assert.ok(/host\/skills\/dispatch\/templates\/soldier-book\.md/.test(soldier), '士兵注入含指针路径  →  ' + soldier);
    });
    await t.test('主约束：士兵注入 ≤100 字节', () => {
      assert.ok(S.injectUtf8Bytes(soldier) <= 100, '主约束：士兵注入 ≤100 字节  →  ' + `bytes=${S.injectUtf8Bytes(soldier)} ${soldier}`);
    });

    const reviewer = S.buildReviewerInject({
      spec: '按审官任务书审 PR #1',
      pr: '1',
      soldierDispatchId: 'ctx_worker-1',
      mergePolicy: 'auto',
    });
    await t.test('审官注入是单行', () => {
      assert.ok(!/[\r\n]/.test(reviewer), '审官注入是单行  →  ' + reviewer);
    });
    await t.test('审官注入低于长度上限', () => {
      assert.ok(S.injectUtf8Bytes(reviewer) <= S.INJECT_MAX_BYTES, '审官注入低于长度上限  →  ' + `bytes=${S.injectUtf8Bytes(reviewer)} ${reviewer}`);
    });
    await t.test('审官注入填进士兵 dispatch id', () => {
      assert.ok(/ctx_worker-1/.test(reviewer), '审官注入填进士兵 dispatch id');
    });
    await t.test('审官注入填进 merge-policy', () => {
      assert.ok(/m=auto/.test(reviewer), '审官注入填进 merge-policy  →  ' + reviewer);
    });
    await t.test('审官注入红项目标是 dispatch:<id> 不是 handle', () => {
      assert.ok(/d=ctx_worker-1/.test(reviewer) && !/term_/.test(reviewer), '审官注入红项目标是 dispatch:<id> 不是 handle  →  ' + reviewer);
    });

    const reviewerBook = fs.readFileSync(path.join(tmplDir, 'reviewer-book.md'), 'utf8');
    await t.test('reviewer-book 要求红项发回士兵、乒乓两轮仍红才上帅', () => {
      assert.ok(/乒乓/.test(reviewerBook), 'reviewer-book 要求红项发回士兵、乒乓两轮仍红才上帅');
    });
    await t.test('reviewer-book 走 gh-as reviewer approve（#573）', () => {
      assert.ok(/gh-as\.mjs reviewer/.test(reviewerBook) && /--approve/.test(reviewerBook) && /真 approve/.test(reviewerBook), 'reviewer-book 走 gh-as reviewer approve（#573）  →  ' + reviewerBook.slice(0, 400));
    });
    await t.test('#625 reviewer-book 合并走 marshal squash，不依赖 GitHub --auto', () => {
      assert.ok(
        /gh-as\.mjs marshal -- pr merge <PR号> --squash --delete-branch/.test(reviewerBook)
          && !/pr merge <PR号> --auto/.test(reviewerBook)
          && !/服务端 auto-merge/.test(reviewerBook),
        '#625 reviewer-book 合并走 marshal squash，不依赖 GitHub --auto  →  ' + reviewerBook.slice(reviewerBook.indexOf('merge-policy: auto'), reviewerBook.indexOf('merge-policy: auto') + 280),
      );
    });
    const reviewerManual = S.buildReviewerInject({
      spec: '按审官任务书审 PR #1',
      pr: '1',
      soldierDispatchId: 'ctx_worker-1',
      mergePolicy: 'manual',
      mergeReason: '改协作约定',
    });
    await t.test('审官注入 manual 带 merge-reason', () => {
      assert.ok(/r=改协作约定/.test(reviewerManual) && !/[\r\n]/.test(reviewerManual), '审官注入 manual 带 merge-reason  →  ' + reviewerManual);
    });
    await t.test('reviewer-book manual 模式含转 draft 机器落点（#498/#559）', () => {
      assert.ok(/--undo/.test(reviewerBook) && /pr ready/.test(reviewerBook) && /gh-as\.mjs reviewer/.test(reviewerBook), 'reviewer-book manual 模式含转 draft 机器落点（#498/#559）  →  ' + reviewerBook.slice(-400));
    });

    let threw = false, threwMsg = '';
    try { S.buildReviewerInject({ spec: 'x', pr: '1', mergePolicy: 'auto' }); }
    catch (e) { threw = true; threwMsg = String(e.message || e); }
    await t.test('缺占位符值 → 抛', () => {
      assert.ok(threw && /SOLDIER_DISPATCH_ID/.test(threwMsg), '缺占位符值 → 抛  →  ' + threwMsg);
    });

    let threwU = false, uMsg = '';
    try { S.buildReviewerInject({ spec: 'x', pr: '1', soldierDispatchId: String(undefined), mergePolicy: 'auto' }); }
    catch (e) { threwU = true; uMsg = String(e.message || e); }
    await t.test('审官红项回归：dispatch id 缺失（"undefined" 字符串）→ 渲染抛错变红', () => {
      assert.ok(threwU && /SOLDIER_DISPATCH_ID/.test(uMsg) && /dispatch:undefined|无效值/.test(uMsg), '审官红项回归：dispatch id 缺失（"undefined" 字符串）→ 渲染抛错变红  →  ' + uMsg);
    });
    let threwN = false;
    try { S.buildReviewerInject({ spec: 'x', pr: '1', soldierDispatchId: 'null', mergePolicy: 'auto' }); }
    catch (e) { threwN = true; }
    await t.test('审官红项回归：占位符填字面量 null 也抛', () => {
      assert.ok(threwN, '审官红项回归：占位符填字面量 null 也抛');
    });

    const multi = S.buildSoldierInject({ spec: '短摘要\n第二行' });
    await t.test('spec 自带换行：注入渲染不炸，grok 发送前才转码', () => {
      assert.ok(/\n/.test(multi) && S.encodeSendText(multi, 'grok').includes('\x1b\r') && !S.encodeSendText(multi, 'grok').includes('\n'), 'spec 自带换行：注入渲染不炸，grok 发送前才转码');
    });

    let notFound = false;
    try { S.renderDispatchTemplate('no-such-template.md', {}); }
    catch (e) { notFound = true; }
    await t.test('模板文件不在 → 抛（不静默空模板）', () => {
      assert.ok(notFound, '模板文件不在 → 抛（不静默空模板）');
    });

    const badName = (() => { try { S.readDispatchTemplate('..\evil.md'); return false; } catch { return true; } })();
    await t.test('模板名不合法 → 拒绝', () => {
      assert.ok(badName, '模板名不合法 → 拒绝');
    });

    const daoSrc = fs.readFileSync(CLI, 'utf8');
    await t.test('dao.mjs 士兵任务书走短注入（buildSoldierInject）', () => {
      assert.ok(/buildSoldierInject/.test(daoSrc), 'dao.mjs 士兵任务书走短注入（buildSoldierInject）');
    });
    await t.test('dao.mjs 士兵 spec 不再是裸 args.spec（闭环包装）', () => {
      assert.ok(/soldierBook/.test(daoSrc) && !/REVIEWER_DISPATCH_ID/.test(daoSrc), 'dao.mjs 士兵 spec 不再是裸 args.spec（闭环包装）  →  REVIEWER_DISPATCH_ID 已从 dao.mjs 移除');
    });
    await t.test('dao.mjs 审官由 reviewer-create 起终端 + worker-start（dispatch 不再起）',
      () => {
        assert.ok(/function cmdReviewerCreate[\s\S]*reviewerTaskId/.test(daoSrc) && /function cmdReviewerCreate[\s\S]*revStarted/.test(daoSrc)
        && /function cmdDispatch[\s\S]*reviewerDeferred: true/.test(daoSrc), 'dao.mjs 审官由 reviewer-create 起终端 + worker-start（dispatch 不再起）');
      });
    await t.test('dao.mjs 审官注入后也验开工（reviewerInject）', () => {
      assert.ok(/reviewerInject/.test(daoSrc), 'dao.mjs 审官注入后也验开工（reviewerInject）');
    });
    await t.test('dao.mjs 从 worker-start 返回取 dispatch id（extractDispatchId）', () => {
      assert.ok(/extractDispatchId/.test(daoSrc), 'dao.mjs 从 worker-start 返回取 dispatch id（extractDispatchId）');
    });
    await t.test('dao.mjs dispatch 完工走 worker-done（不再预填 soldierDoneTo）', () => {
      assert.ok(/soldierDoneVia: 'worker-done'/.test(daoSrc) && /reviewerDeferred: true/.test(daoSrc), 'dao.mjs dispatch 完工走 worker-done（不再预填 soldierDoneTo）');
    });
    await t.test('审官红项修正：审官任务书在 reviewer-create 里用士兵真 id 渲染', () => {
      assert.ok(/function cmdReviewerCreate[\s\S]*planCreateSoldierDispatch/.test(daoSrc)
        && /function cmdReviewerCreate[\s\S]*soldierDispatchId/.test(daoSrc),
        '审官红项修正：审官任务书在 reviewer-create 里用士兵真 id 渲染  →  渲染落点检查');
    });
    await t.test('#799 reviewer-create/attach 继承 merge-policy，结算态士兵走 planCreateSoldierDispatch', () => {
      assert.ok(/function cmdReviewerCreate[\s\S]*lookupReviewerMergePolicy/.test(daoSrc)
        && /function cmdReviewerAttach[\s\S]*lookupReviewerMergePolicy/.test(daoSrc)
        && /function cmdReviewerCreate[\s\S]*planCreateSoldierDispatch/.test(daoSrc),
        '#799 create/attach 接线  →  create/attach 必须走 lookup + create 必须走 planCreate');
    });
    await t.test('#799 worker-done 写进度不整段覆盖 merge-policy 载体', () => {
      const wd = (daoSrc.match(/function cmdWorkerDone\([\s\S]*?\nfunction /) || [''])[0];
      assert.ok(/setWorkerCardProgress/.test(wd) && /progressDispatchComment/.test(daoSrc)
        && !/comment: '待终审'/.test(wd) && !/comment: '交卷了，审官没起来'/.test(wd),
        '#799 worker-done 不得整段覆盖卡备注  →  ' + wd.slice(wd.indexOf('setWorkerCardProgress'), wd.indexOf('setWorkerCardProgress') + 80));
    });
    await t.test('审官红项修正：审官身份消息发进士兵收件箱（四关确认）', () => {
      assert.ok(/审官身份/.test(daoSrc) && /identity/.test(daoSrc), '审官红项修正：审官身份消息发进士兵收件箱（四关确认）');
    });
  });
});

// 2026-09-06 实咬：#762 定过「worktree create 一律带 --repo」，只接在派工那条路上。
// 仓从 /home/orca/windsurf-dao 迁到 /srv/projects/windsurf-dao 后，没接的四处当场全断
// （orca 报 Missing repo selector），5 张复审票 drain 全挂，外面看到的却是「drain-exhausted」。
// 这条闸盯的是「又有人新加了一个不带 repo 的建树点」——它是静默失效，没别的东西会报警。
describe('建树一律带 repo 选择符（#762 的漏接面）', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'dao.mjs'), 'utf8');

  it('dao.mjs 里每个 argsWorktreeCreate({ 调用都带 repo', () => {
    const bad = [];
    const re = /argsWorktreeCreate\(\{/g;
    let m;
    while ((m = re.exec(src))) {
      // 取这次调用的实参块（到配平的 `}` 为止），只看它自己有没有 repo:
      let i = m.index + m[0].length;
      let depth = 1;
      while (i < src.length && depth > 0) {
        if (src[i] === '{') depth += 1;
        else if (src[i] === '}') depth -= 1;
        i += 1;
      }
      const block = src.slice(m.index, i);
      if (!/\brepo:/.test(block)) {
        bad.push(src.slice(Math.max(0, m.index - 120), m.index).split('\n').pop().trim());
      }
    }
    assert.deepEqual(bad, [], `这些建树点没带 repo，搬家/换 cwd 就会报 Missing repo selector：\n${bad.join('\n')}`);
  });

  it('选择符按 remote URL 解析，不按路径（路径匹配会被搬家打断）', () => {
    const i = src.indexOf('function thisRepoSelector');
    assert.ok(i > -1, 'thisRepoSelector 没了——建树点会各自散写一份解析');
    assert.match(src.slice(i, i + 900), /remoteUrl:/);
  });
});
