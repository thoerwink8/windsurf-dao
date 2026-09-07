// 一 PR 一审官闸：已有则不新建；失败不换厂；没查成 ≠ 没有审官。
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const LIB = path.join(REPO, 'scripts', 'lib', 'dao-cmd.mjs');
const DAO = path.join(REPO, 'scripts', 'dao.mjs');
const S_LOAD = import('file://' + LIB.replace(/\\/g, '/'));

describe('一 PR 一审官闸', () => {
  it('四态话面互不相同：复用 / 允许新建 / 已有拒绝新建 / 没查成', async () => {
    const S = await S_LOAD;
    const parent = 'wt_worker';
    const parentWt = { id: parent, parentWorktreeId: null, displayName: 'PR-#88 工人·grok-4.6' };
    const reused = S.gateReviewerCreate({
      pr: 88,
      parentId: parent,
      worktrees: [
        parentWt,
        { id: 'wt_rev', parentWorktreeId: parent, createdAt: 10, displayName: 'PR-#88 审官·gpt-5.6-sol' },
      ],
      workers: [{
        dispatchId: 'ctx_r',
        resource: { worktreeId: 'wt_rev', terminalHandle: 'term_r' },
        agentTerminalHandle: 'term_r',
      }],
      terminals: [{ handle: 'term_r', status: 'running' }],
    });
    const allow = S.gateReviewerCreate({
      pr: 88,
      parentId: parent,
      worktrees: [parentWt],
      workers: [],
      terminals: [],
    });
    const refused = S.gateReviewerCreate({
      pr: 88,
      parentId: parent,
      worktrees: [
        parentWt,
        { id: 'wt_dead', parentWorktreeId: parent, createdAt: 10, displayName: 'PR-#88 审官·gpt-5.6-sol' },
      ],
      workers: [{
        dispatchId: 'ctx_dead',
        resource: { worktreeId: 'wt_dead', terminalHandle: 'term_dead' },
        agentTerminalHandle: 'term_dead',
      }],
      terminals: [{ handle: 'term_dead', status: 'exited' }],
    });
    const unscanned = S.gateReviewerCreate({ pr: 88, parentId: parent });
    assert.ok(reused.ok === true && reused.outcome === 'reused' && reused.action === 'reuse'
      && reused.worktreeId === 'wt_rev', JSON.stringify(reused));
    assert.ok(allow.ok === true && allow.outcome === 'create' && allow.action === 'create', JSON.stringify(allow));
    assert.ok(refused.ok === false && refused.outcome === 'refused-existing' && refused.action === 'refuse'
      && /拒绝新建/.test(refused.error || ''), JSON.stringify(refused));
    assert.ok(unscanned.ok === false && unscanned.outcome === 'unscanned' && unscanned.unscanned === true
      && /没查成/.test(unscanned.error || ''), JSON.stringify(unscanned));
    const texts = [reused.reason, allow.reason, refused.reason || refused.error, unscanned.error];
    assert.ok(new Set(texts).size === 4, JSON.stringify(texts));
    assert.ok(reused.outcome !== allow.outcome && allow.outcome !== refused.outcome
      && refused.outcome !== unscanned.outcome && reused.outcome !== unscanned.outcome);
  });

  it('已有审官则不新建；没查成 ≠ 没有审官', async () => {
    const S = await S_LOAD;
    const none = S.collectReviewerCardsForPr({
      pr: 91,
      parentId: 'wt_w',
      worktrees: [{ id: 'wt_w', parentWorktreeId: null }],
      workers: [],
    });
    const missList = S.collectReviewerCardsForPr({ pr: 91, parentId: 'wt_w', worktrees: null, workers: [] });
    const missWorkers = S.collectReviewerCardsForPr({ pr: 91, worktrees: [], workers: null });
    assert.ok(none.ok === true && none.unscanned === false && none.count === 0, JSON.stringify(none));
    assert.ok(missList.ok === false && missList.unscanned === true && /没查成/.test(missList.error), JSON.stringify(missList));
    assert.ok(missWorkers.ok === false && missWorkers.unscanned === true && /没查成/.test(missWorkers.error), JSON.stringify(missWorkers));
    assert.ok(missList.error !== none.ok && missList.unscanned !== none.unscanned);

    const existing = S.collectReviewerCardsForPr({
      pr: 91,
      worktrees: [
        { id: 'wt_w', parentWorktreeId: null, displayName: 'PR-#91 工人·grok-4.6' },
        { id: 'wt_rev', parentWorktreeId: 'wt_w', displayName: 'PR-#91 审官·gpt-5.6-sol' },
      ],
      workers: [],
    });
    assert.ok(existing.ok === true && existing.count === 1 && existing.cards[0].worktreeId === 'wt_rev', JSON.stringify(existing));

    const reuse = S.resolveReviewerReuse({
      parentId: 'wt_w',
      pr: 91,
      worktrees: [
        { id: 'wt_w', parentWorktreeId: null, displayName: 'PR-#91 工人·grok-4.6' },
        { id: 'wt_rev', parentWorktreeId: 'wt_w', createdAt: 3, displayName: 'PR-#91 审官·gpt-5.6-sol' },
      ],
      workers: [{
        dispatchId: 'ctx_r',
        resource: { worktreeId: 'wt_rev', terminalHandle: 'term_r' },
        agentTerminalHandle: 'term_r',
      }],
      terminals: [{ handle: 'term_r', status: 'running' }],
    });
    assert.ok(reuse.action === 'reuse' && reuse.outcome === 'reused' && reuse.worktreeId === 'wt_rev', JSON.stringify(reuse));
  });

  // 2026-09-05 用户拍板放开：审官位从「只许 reviewerOrder[0]」改成「同厂换顺位可以，换厂仍拒」。
  // 起因是 #833 的自动换人整条能力是零——静默判死后挑下一顺位 gpt-5.6-sol，被这道闸拒掉，
  // 服务器实测 10 个审官一个都没换成人。闸的注释一直写着「不许换厂」，实现的却是「不许换任何」。
  it('审官位：同厂换顺位放行，换厂/表外仍拒（#833 换人靠这条）', async () => {
    const S = await S_LOAD;
    const stop = S.planReviewerCreateAfterFail({ error: 'ensure 超时' });
    assert.ok(stop.ok === false && stop.switchVendor === false && stop.retry === false
      && /不许换厂/.test(stop.error) && !/kimi|glm|grok/.test(stop.error), JSON.stringify(stop));

    const routing = S.loadRouting();
    const seat = S.currentReviewerSeat(routing);
    // #843 过渡：审官顺位1 = gpt-5.6-luna（pqapi 故障，codex 每单必死）。恢复后切回 gpt-5.6-sol。
    assert.ok(seat.ok === true && seat.modelId === 'gpt-5.6-luna', JSON.stringify(seat));
    const pass = S.assertReviewerSeat({ reviewerId: 'gpt-5.6-luna', routing });
    assert.ok(pass.ok === true, JSON.stringify(pass));

    // 放行的那一条：同厂（GPT）、在顺位表里 → 换得成。这正是今天卡死 10 个审官的那一格。
    const sol = S.assertReviewerSeat({ reviewerId: 'gpt-5.6-sol', routing });
    assert.ok(sol.ok === true && sol.switched === true && sol.modelId === 'gpt-5.6-sol', JSON.stringify(sol));

    // 故意违规样本①：顺位表里但异厂——路由表自己写着「备选登记，不顶审官位」，必须仍被拦。
    const kimi = S.assertReviewerSeat({ reviewerId: 'kimi-k3', routing });
    const glm = S.assertReviewerSeat({ reviewerId: 'glm-5.2', routing });
    const grok = S.assertReviewerSeat({ reviewerId: 'grok-4.6', routing });
    for (const [id, r] of [['kimi-k3', kimi], ['glm-5.2', glm], ['grok-4.6', grok]]) {
      assert.ok(r.ok === false && /不许换厂/.test(r.error), `${id} 该被换厂闸拦下：${JSON.stringify(r)}`);
    }
    // 故意违规样本②：同厂但不在顺位表里 → 拒。放开的是「表内同厂」，不是「所有同厂」。
    const offTable = S.assertReviewerSeat({ reviewerId: 'gpt-4.1-nobody', routing });
    assert.ok(offTable.ok === false && /不在表里/.test(offTable.error), JSON.stringify(offTable));
    // 故意违规样本③：家族认不出 → 没查成，不许猜着放行。
    const weird = S.assertReviewerSeat({ reviewerId: '???', routing });
    assert.ok(weird.ok === false && weird.unscanned === true && /没查成/.test(weird.error), JSON.stringify(weird));

    const miss = S.assertReviewerSeat({ reviewerId: 'gpt-5.6-sol', routing: null });
    const empty = S.currentReviewerSeat({ reviewerOrder: [] });
    assert.ok(miss.ok === false && miss.unscanned === true && /没查成/.test(miss.error), JSON.stringify(miss));
    assert.ok(empty.ok === false && empty.outcome === 'none' && empty.unscanned !== true, JSON.stringify(empty));
    assert.ok(miss.error !== empty.error);
  });

  it('#1122 审官位跨厂例外：凭死因成立，正常完工仍拒，不许跳级', async () => {
    const S = await S_LOAD;
    const routing = S.loadRouting();
    const DEAD = 'Selected model is at capacity. Please try a different model.';
    // 上一位 luna 死于满载 → 下一顺位是同厂 sol；跨厂 kimi 仍是跳级。
    const skip = S.assertReviewerSeat({
      reviewerId: 'kimi-k3', routing,
      capacityFailover: { deadModelId: 'gpt-5.6-luna', deadError: DEAD, workerId: 'grok-4.6' },
    });
    assert.equal(skip.ok, false, JSON.stringify(skip));
    assert.match(skip.error, /不许跳级点名/);

    const sol = S.assertReviewerSeat({
      reviewerId: 'gpt-5.6-sol', routing,
      capacityFailover: { deadModelId: 'gpt-5.6-luna', deadError: DEAD, workerId: 'grok-4.6' },
    });
    assert.equal(sol.ok, true, JSON.stringify(sol));
    assert.equal(sol.switched, true);

    // 上一位 sol 也死于满载 → 下一档跨厂 kimi，且不是工人那一厂。
    const kimi = S.assertReviewerSeat({
      reviewerId: 'kimi-k3', routing,
      capacityFailover: { deadModelId: 'gpt-5.6-sol', deadError: DEAD, workerId: 'grok-4.6' },
    });
    assert.equal(kimi.ok, true, JSON.stringify(kimi));
    assert.equal(kimi.crossVendor, true);
    assert.equal(kimi.failover, 'capacity');

    // 正常完工（error 为空）→ 跨厂仍拒，例外口不是常开。
    const alive = S.assertReviewerSeat({
      reviewerId: 'kimi-k3', routing,
      capacityFailover: { deadModelId: 'gpt-5.6-sol', deadError: '', workerId: 'grok-4.6' },
    });
    assert.equal(alive.ok, false, JSON.stringify(alive));
    assert.equal(alive.unscanned, true);

    // 死因不是满载（判红）→ 仍拒。
    const red = S.assertReviewerSeat({
      reviewerId: 'kimi-k3', routing,
      capacityFailover: { deadModelId: 'gpt-5.6-sol', deadError: '审官判红', workerId: 'grok-4.6' },
    });
    assert.equal(red.ok, false, JSON.stringify(red));
    assert.match(red.error, /不是满载/);

    // 不交凭证 → 仍拒（老规矩）。
    const none = S.assertReviewerSeat({ reviewerId: 'kimi-k3', routing });
    assert.equal(none.ok, false, JSON.stringify(none));
    assert.match(none.error, /不许换厂/);
  });

  it('结算后再造：报帅且 create/换厂都是 false；没查成 ≠ 未结算', async () => {
    const S = await S_LOAD;
    const miss = S.planAfterSettledReviewer({});
    const bad = S.planAfterSettledReviewer({ settlement: { ok: false, unscanned: true, error: 'worker-show 失败' } });
    const settled = S.planAfterSettledReviewer({ settlement: { ok: true, settled: true, unscanned: false } });
    const live = S.planAfterSettledReviewer({ settlement: { ok: true, settled: false, unscanned: false } });
    assert.ok(miss.unscanned === true && miss.create === false && miss.switchVendor === false
      && /没查成/.test(miss.error), JSON.stringify(miss));
    assert.ok(bad.unscanned === true && bad.create === false && /没查成/.test(bad.error), JSON.stringify(bad));
    assert.ok(settled.ok === true && settled.action === 'report' && settled.create === false
      && settled.switchVendor === false && /不自动 reviewer-create/.test(settled.reason), JSON.stringify(settled));
    assert.ok(live.ok === true && live.action === 'none' && live.create === false, JSON.stringify(live));
    assert.ok(miss.unscanned !== live.unscanned && miss.error !== live.reason);
  });

  it('故意违规样本能被拦住；检查器不 import 被查对象解析', async () => {
    const checkPath = path.join(REPO, 'scripts', 'lib', 'no-reviewer-recreate-check.mjs');
    const C = await import('file://' + checkPath.replace(/\\/g, '/'));
    const root = path.join(REPO, 'tests', 'fixtures', 'no-reviewer-recreate');
    const samples = C.inspectNoReviewerRecreateFixtures(root);
    assert.ok(samples.ok === true && samples.unscanned === false
      && samples.kinds.red === 1 && samples.kinds.ok === 1 && samples.kinds.empty === 1, JSON.stringify(samples));
    const red = C.inspectNoReviewerRecreate({
      daoSrc: fs.readFileSync(path.join(root, 'red', 'dao.mjs'), 'utf8'),
    });
    assert.ok(red.ok === false && red.unscanned === false && red.problems.length >= 1, JSON.stringify(red));
    const none = C.inspectNoReviewerRecreate({});
    assert.ok(none.unscanned === true && /没查成/.test(none.error), JSON.stringify(none));
    const src = fs.readFileSync(checkPath, 'utf8');
    assert.ok(!/from '\.\/dao-cmd\.mjs'|from '\.\/flow\.mjs'|planAfterSettledReviewer/.test(src),
      '检查器复用了被查对象解析');
  });

  it('worker-done 失败路径不再调 nextReviewerAfter；create 先过闸', () => {
    const daoSrc = fs.readFileSync(DAO, 'utf8');
    const wdFn = (daoSrc.match(/function cmdWorkerDoneMirasim\([\s\S]*?\nasync function cmdStartMirasim/) || [''])[0];
    const createFn = (daoSrc.match(/function cmdReviewerCreateMirasim\([\s\S]*?\nasync function cmdWorkerDoneMirasim/) || [''])[0];
    assert.ok(wdFn && !/nextReviewerAfter/.test(wdFn), 'worker-done 仍换厂  →  ' + wdFn.slice(0, 200));
    assert.ok(/refuseIfSameVendor/.test(wdFn) || /fail\(/.test(wdFn),
      'worker-done 失败没停手报');
    assert.ok(/assertReviewerSeat/.test(createFn) || /refuseIfSameVendor/.test(createFn),
      'reviewer-create 没过同厂/审官位闸');
  });
});
