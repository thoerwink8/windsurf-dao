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

  it('失败不换厂；审官位只许当前 Codex', async () => {
    const S = await S_LOAD;
    const stop = S.planReviewerCreateAfterFail({ error: 'ensure 超时' });
    assert.ok(stop.ok === false && stop.switchVendor === false && stop.retry === false
      && /不许换厂/.test(stop.error) && !/kimi|glm|grok/.test(stop.error), JSON.stringify(stop));

    const routing = S.loadRouting();
    const seat = S.currentReviewerSeat(routing);
    assert.ok(seat.ok === true && seat.modelId === 'gpt-5.6-sol', JSON.stringify(seat));
    const pass = S.assertReviewerSeat({ reviewerId: 'gpt-5.6-sol', routing });
    assert.ok(pass.ok === true, JSON.stringify(pass));
    const kimi = S.assertReviewerSeat({ reviewerId: 'kimi-k3', routing });
    const glm = S.assertReviewerSeat({ reviewerId: 'glm-5.2', routing });
    const grok = S.assertReviewerSeat({ reviewerId: 'grok-4.6', routing });
    assert.ok(kimi.ok === false && /不许换厂/.test(kimi.error), JSON.stringify(kimi));
    assert.ok(glm.ok === false && grok.ok === false, JSON.stringify({ glm, grok }));
    const miss = S.assertReviewerSeat({ reviewerId: 'gpt-5.6-sol', routing: null });
    const empty = S.currentReviewerSeat({ reviewerOrder: [] });
    assert.ok(miss.ok === false && miss.unscanned === true && /没查成/.test(miss.error), JSON.stringify(miss));
    assert.ok(empty.ok === false && empty.outcome === 'none' && empty.unscanned !== true, JSON.stringify(empty));
    assert.ok(miss.error !== empty.error);
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
      flowSrc: fs.readFileSync(path.join(root, 'red', 'flow.mjs'), 'utf8'),
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
    const wdFn = (daoSrc.match(/function cmdWorkerDone\([\s\S]*?\nfunction /) || [''])[0];
    const createFn = (daoSrc.match(/function cmdReviewerCreate\([\s\S]*?\nfunction /) || [''])[0];
    assert.ok(wdFn && !/nextReviewerAfter/.test(wdFn), 'worker-done 仍换厂  →  ' + wdFn.slice(0, 200));
    assert.ok(/planReviewerCreateAfterFail/.test(wdFn), 'worker-done 失败没停手报');
    assert.ok(/gateReviewerCreate/.test(createFn) && /assertReviewerSeat/.test(createFn),
      'reviewer-create 没过一审官闸');
    const gateAt = createFn.indexOf('gateReviewerCreate');
    const worktreeAt = createFn.indexOf('argsWorktreeCreate');
    assert.ok(gateAt >= 0 && worktreeAt > gateAt, '闸必须在 worktree create 之前');
  });
});
