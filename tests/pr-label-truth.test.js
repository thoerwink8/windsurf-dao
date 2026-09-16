// tests/pr-label-truth.test.js —— #1116：真相源 = PR 自己的 label
//
// 用户 2026-09-07 拍板删掉「从 issue 标签反推派工决定」这一层。
// 决定在 dispatch 写一次（model + reviewer + branch）；消费方按 PR head 分支打标，
// 之后只读 PR label。读不到就拒，不回退去读 issue、不猜家族。

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const WD = import('file://' + path.join(__dirname, '..', 'scripts', 'lib', 'dispatch', 'worker-done.mjs').replace(/\\/g, '/'));
const CARD = import('file://' + path.join(__dirname, '..', 'scripts', 'lib', 'dispatch', 'card.mjs').replace(/\\/g, '/'));
const ROOT = path.join(__dirname, '..');
const REPO = 'thoerwink8/windsurf-dao';
const OTHER = 'acme/other-dao';

function ghLog() {
  const calls = [];
  const runGh = (args) => {
    calls.push(args.slice());
    return { ok: true, out: '{}' };
  };
  return { calls, runGh };
}

describe('pickWorkerDispatchByBranch', () => {
  it('按仓+分支精确命中工人 dispatch，带 reviewer', async () => {
    const { pickWorkerDispatchByBranch } = await WD;
    const events = [
      { type: 'job.dispatch', identity: '审官', branch: 'dao-1116', repo: REPO, model: 'gpt-5.6-luna', reviewer: 'x' },
      { type: 'job.dispatch', identity: '工人', branch: 'dao-other', repo: REPO, model: 'kimi-k3', reviewer: 'x' },
      { type: 'job.dispatch', identity: '工人', branch: 'dao-1116', repo: REPO, model: 'grok-4.6', reviewer: 'gpt-5.6-luna', work_type: '写码' },
    ];
    const got = pickWorkerDispatchByBranch(events, 'dao-1116', REPO);
    assert.equal(got.ok, true);
    assert.equal(got.model, 'grok-4.6');
    assert.equal(got.reviewer, 'gpt-5.6-luna');
  });

  it('查不到 → 需人工打标，不猜', async () => {
    const { pickWorkerDispatchByBranch } = await WD;
    const none = pickWorkerDispatchByBranch([], 'hand-opened', REPO);
    assert.equal(none.ok, false);
    assert.equal(none.state, 'none');
    assert.match(none.error, /需人工打标/);
    const unscanned = pickWorkerDispatchByBranch(null, 'dao-1', REPO);
    assert.equal(unscanned.state, 'unscanned');
    const noRepo = pickWorkerDispatchByBranch([], 'dao-1');
    assert.equal(noRepo.ok, false);
    assert.equal(noRepo.state, 'unscanned');
    assert.match(noRepo.error, /没给仓/);
    const noBranch = pickWorkerDispatchByBranch([], '', REPO);
    assert.equal(noBranch.ok, false);
    assert.equal(noBranch.state, 'unscanned');
    assert.match(noBranch.error, /没给分支名/);
  });

  it('缺 reviewer 的工人 dispatch 不当成功', async () => {
    const { pickWorkerDispatchByBranch } = await WD;
    const got = pickWorkerDispatchByBranch([
      { type: 'job.dispatch', identity: '工人', branch: 'dao-1116', repo: REPO, model: 'grok-4.6', work_type: '写码' },
    ], 'dao-1116', REPO);
    assert.equal(got.ok, false);
    assert.equal(got.state, 'invalid');
    assert.match(got.error, /缺 reviewer/);
    assert.match(got.error, /需人工打标/);
  });

  it('缺 identity 或非法身份不当成工人事件', async () => {
    const { pickWorkerDispatchByBranch } = await WD;
    const missing = pickWorkerDispatchByBranch([
      { type: 'job.dispatch', branch: 'dao-1116', repo: REPO, model: 'grok-4.6', reviewer: 'gpt-5.6-luna' },
    ], 'dao-1116', REPO);
    assert.equal(missing.ok, false);
    assert.equal(missing.state, 'invalid');
    assert.match(missing.error, /缺 identity 或不是工人/);
    assert.match(missing.error, /需人工打标/);
    const broken = pickWorkerDispatchByBranch([
      { type: 'job.dispatch', identity: '审官', branch: 'dao-1116', repo: REPO, model: 'wrong', reviewer: 'wrong' },
      { type: 'job.dispatch', identity: '协调者', branch: 'dao-1116', repo: REPO, model: 'also-wrong', reviewer: 'also-wrong' },
    ], 'dao-1116', REPO);
    assert.equal(broken.ok, false);
    const mixed = pickWorkerDispatchByBranch([
      { type: 'job.dispatch', branch: 'dao-1116', repo: REPO, model: 'wrong', reviewer: 'wrong' },
      { type: 'job.dispatch', identity: '工人', branch: 'dao-1116', repo: REPO, model: 'grok-4.6', reviewer: 'gpt-5.6-luna' },
    ], 'dao-1116', REPO);
    assert.equal(mixed.ok, true);
    assert.equal(mixed.model, 'grok-4.6');
    const laterBroken = pickWorkerDispatchByBranch([
      { type: 'job.dispatch', identity: '工人', branch: 'dao-1116', repo: REPO, model: 'grok-4.6', reviewer: 'gpt-5.6-luna' },
      { type: 'job.dispatch', branch: 'dao-1116', repo: REPO, model: 'wrong', reviewer: 'wrong' },
    ], 'dao-1116', REPO);
    assert.equal(laterBroken.ok, false);
    assert.match(laterBroken.error, /缺 identity 或不是工人/);
    assert.match(laterBroken.error, /需人工打标/);
  });

  it('后写残缺工人记录不得回退旧的完整记录', async () => {
    const { pickWorkerDispatchByBranch } = await WD;
    const got = pickWorkerDispatchByBranch([
      { type: 'job.dispatch', identity: '工人', branch: 'dao-1', repo: 'acme/repo', model: 'old-complete', reviewer: 'old-reviewer' },
      { type: 'job.dispatch', identity: '工人', branch: 'dao-1', repo: 'acme/repo', model: 'new-incomplete' },
    ], 'dao-1', 'acme/repo');
    assert.equal(got.ok, false);
    assert.match(got.error, /缺 reviewer/);
    assert.match(got.error, /需人工打标/);
  });

  it('后写缺 repo 不得回退旧的完整记录，但最新一条本身要认（历史事件无 repo）', async () => {
    const { pickWorkerDispatchByBranch } = await WD;
    // #1118 起 repo 才是必写字段，#1116 之前的历史事件全都没有。缺它不能当「不是这条链」，
    // 也不能因此回退到旧记录——仍以最新一条为准，只是把「仓是推的」标出来。
    const got = pickWorkerDispatchByBranch([
      { type: 'job.dispatch', identity: '工人', branch: 'b', repo: 'acme/repo', model: 'old', reviewer: 'old-r' },
      { type: 'job.dispatch', identity: '工人', branch: 'b', model: 'new', reviewer: 'new-r' },
    ], 'b', 'acme/repo');
    assert.equal(got.ok, true);
    assert.equal(got.model, 'new');
    assert.equal(got.reviewer, 'new-r');
    assert.equal(got.repoAssumed, true);

    // 账本写了 repo 的，repoAssumed 不在（没推，是读来的）
    const exact = pickWorkerDispatchByBranch([
      { type: 'job.dispatch', identity: '工人', branch: 'b', repo: 'acme/repo', model: 'm', reviewer: 'r' },
    ], 'b', 'acme/repo');
    assert.equal(exact.ok, true);
    assert.equal(exact.repoAssumed, false);
  });

  it('跨仓同名分支不套另一仓的 dispatch', async () => {
    const { pickWorkerDispatchByBranch } = await WD;
    const events = [
      { type: 'job.dispatch', identity: '工人', branch: 'dao-1116', repo: REPO, model: 'grok-4.6', reviewer: 'gpt-5.6-luna' },
      { type: 'job.dispatch', identity: '工人', branch: 'dao-1116', repo: OTHER, model: 'kimi-k3', reviewer: 'gpt-5.6-sol' },
    ];
    const here = pickWorkerDispatchByBranch(events, 'dao-1116', REPO);
    assert.equal(here.ok, true);
    assert.equal(here.model, 'grok-4.6');
    assert.equal(here.reviewer, 'gpt-5.6-luna');
    const there = pickWorkerDispatchByBranch(events, 'dao-1116', OTHER);
    assert.equal(there.ok, true);
    assert.equal(there.model, 'kimi-k3');
    const laterOther = pickWorkerDispatchByBranch([
      { type: 'job.dispatch', identity: '工人', branch: 'dao-1', repo: REPO, model: 'a', reviewer: 'r1' },
      { type: 'job.dispatch', identity: '工人', branch: 'dao-1', repo: OTHER, model: 'b', reviewer: 'r2' },
    ], 'dao-1', REPO);
    assert.equal(laterOther.ok, true);
    assert.equal(laterOther.model, 'a');
    const noRepoOnEvent = pickWorkerDispatchByBranch([
      { type: 'job.dispatch', identity: '工人', branch: 'dao-1', model: 'a', reviewer: 'r1' },
    ], 'dao-1', REPO);
    assert.equal(noRepoOnEvent.ok, true);
    assert.equal(noRepoOnEvent.repoAssumed, true);
  });

  it('已命中坏账不是 none：缺 model / 非法 identity 走 invalid，只有扫完没有才 none', async () => {
    const { pickWorkerDispatchByBranch } = await WD;
    const noChain = pickWorkerDispatchByBranch([], 'dao-1', REPO);
    assert.equal(noChain.state, 'none');

    const noModel = pickWorkerDispatchByBranch([
      { type: 'job.dispatch', identity: '工人', branch: 'dao-1', repo: REPO, reviewer: 'gpt-5.6-luna', work_type: '写码' },
    ], 'dao-1', REPO);
    assert.equal(noModel.ok, false);
    assert.equal(noModel.state, 'invalid');
    assert.match(noModel.error, /缺 model/);

    const badId = pickWorkerDispatchByBranch([
      { type: 'job.dispatch', identity: '审官', branch: 'dao-1', repo: REPO, model: 'grok-4.6', reviewer: 'gpt-5.6-luna' },
    ], 'dao-1', REPO);
    assert.equal(badId.ok, false);
    assert.equal(badId.state, 'invalid');
    assert.match(badId.error, /缺 identity 或不是工人/);
  });
});

describe('stampPrLabelsFromDispatch', () => {
  it('按 head 分支打 model/* reviewer/*，gh 序列没有 issue view', async () => {
    const { stampPrLabelsFromDispatch } = await WD;
    const { ensureRepoLabels } = await CARD;
    const calls = [];
    const runGh = (args) => {
      calls.push(args.slice());
      if (args[0] === 'pr' && args[1] === 'view') {
        return {
          ok: true,
          out: JSON.stringify({
            title: 'x', body: '署名 issue #1116', labels: [], headRefName: 'dao-1116',
          }),
        };
      }
      if (args[0] === 'label' && args[1] === 'list') {
        return { ok: true, out: JSON.stringify([{ name: 'model/grok-4.6' }, { name: 'type/写码' }, { name: 'reviewer/gpt-5.6-luna' }]) };
      }
      if (args[0] === 'pr' && args[1] === 'edit') return { ok: true, out: '{}' };
      return { ok: false, error: '未预期 ' + args.join(' ') };
    };
    const r = stampPrLabelsFromDispatch({
      pr: '1118',
      runGh,
      repo: REPO,
      events: [{
        type: 'job.dispatch', identity: '工人', branch: 'dao-1116', repo: REPO,
        model: 'grok-4.6', reviewer: 'gpt-5.6-luna', work_type: '写码',
      }],
      ensureLabels: ensureRepoLabels,
    });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.ok(r.labels.includes('model/grok-4.6'));
    assert.ok(r.labels.includes('reviewer/gpt-5.6-luna'));
    assert.equal(r.repoAssumed, false);
    assert.equal(r.reviewerSource, 'ledger');
    assert.equal(calls.some((a) => a[0] === 'pr' && a[1] === 'edit'), true);
    assert.equal(calls.some((a) => a.includes('model/grok-4.6')), true);
    assert.ok(!calls.some((a) => a[0] === 'issue'), JSON.stringify(calls));
  });

  it('已有同名 label 幂等，不再 edit', async () => {
    const { stampPrLabelsFromDispatch } = await WD;
    const calls = [];
    const runGh = (args) => {
      calls.push(args.slice());
      if (args[0] === 'pr' && args[1] === 'view') {
        return {
          ok: true,
          out: JSON.stringify({
            title: 'x', body: '署名 issue #1',
            labels: [{ name: 'model/grok-4.6' }, { name: 'type/写码' }, { name: 'reviewer/gpt-5.6-luna' }],
            headRefName: 'dao-1',
          }),
        };
      }
      return { ok: false, error: '未预期 ' + args.join(' ') };
    };
    const r = stampPrLabelsFromDispatch({
      pr: '1',
      runGh,
      repo: REPO,
      events: [{ type: 'job.dispatch', identity: '工人', branch: 'dao-1', repo: REPO, model: 'grok-4.6', reviewer: 'gpt-5.6-luna' }],
    });
    assert.equal(r.ok, true);
    assert.deepEqual(r.add, []);
    assert.deepEqual(r.drop, []);
    assert.ok(!calls.some((a) => a[1] === 'edit'));
  });

  // 2026-09-14 实咬（#1256）：打标路只加不减，于是「工人换过模型」的 PR 上
  // model/grok-4.6 与 model/claude-opus-5 并存。`pickModel` 对同前缀多条一律拒
  // （worker-done.mjs:87），起审官被拒，那个 PR **永久**卡死。
  // 现场：drain 报「有多个 model/* label（model/grok-4.6、model/claude-opus-5，不许猜一个），拒绝起审官」。
  it('同前缀旧标要摘掉（换过模型的 PR 不许被旧标焊死）', async () => {
    const { stampPrLabelsFromDispatch } = await WD;
    const { ensureRepoLabels } = await CARD;
    const calls = [];
    const runGh = (args) => {
      calls.push(args.slice());
      if (args[0] === 'pr' && args[1] === 'view') {
        return {
          ok: true,
          out: JSON.stringify({
            title: 'x', body: '署名 issue #1',
            labels: [{ name: 'model/claude-opus-5' }, { name: 'type/写码' }, { name: 'reviewer/gpt-5.6-luna' }],
            headRefName: 'dao-1',
          }),
        };
      }
      // label list 要给「已存在」的那些，否则 ensureRepoLabels 会去 label create（那一步不在被测范围）
      if (args[0] === 'label' && args[1] === 'list') {
        return { ok: true, out: JSON.stringify(['model/grok-4.6', 'model/claude-opus-5', 'type/写码', 'reviewer/gpt-5.6-luna', '卡死/等用户', '人工/待复核'].map((name) => ({ name }))) };
      }
      if (args[0] === 'pr' && args[1] === 'edit') return { ok: true, out: '{}' };
      return { ok: false, error: '未预期 ' + args.join(' ') };
    };
    const r = stampPrLabelsFromDispatch({
      pr: '1256',
      runGh,
      repo: REPO,
      ensureLabels: ensureRepoLabels,
      events: [{ type: 'job.dispatch', identity: '工人', branch: 'dao-1', repo: REPO, model: 'grok-4.6', reviewer: 'gpt-5.6-luna' }],
    });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(r.add, ['model/grok-4.6']);
    assert.deepEqual(r.drop, ['model/claude-opus-5']);
    const edit = calls.find((a) => a[0] === 'pr' && a[1] === 'edit');
    assert.ok(edit, JSON.stringify(calls));
    // 拆成最简条件：一条 ok(a && b) 失败时看不出哪半坏了（本仓 assert-style 闸）。
    const flagValue = (flag) => (edit.includes(flag) ? edit[edit.indexOf(flag) + 1] : null);
    assert.equal(flagValue('--add-label'), 'model/grok-4.6', JSON.stringify(edit));
    assert.equal(flagValue('--remove-label'), 'model/claude-opus-5', JSON.stringify(edit));
  });

  // 正控的另一半：**别的前缀不许碰**。同一次打标顺手清掉人工加的标会误伤——
  // 这里挂一个本次要打的三个前缀之外的标，它必须原样留下。
  it('不碰别的前缀的标（只清本次要打的那三个前缀）', async () => {
    const { stampPrLabelsFromDispatch } = await WD;
    const { ensureRepoLabels } = await CARD;
    const calls = [];
    const runGh = (args) => {
      calls.push(args.slice());
      if (args[0] === 'pr' && args[1] === 'view') {
        return {
          ok: true,
          out: JSON.stringify({
            title: 'x', body: '署名 issue #1',
            labels: [{ name: 'model/claude-opus-5' }, { name: '卡死/等用户' }, { name: '人工/待复核' }],
            headRefName: 'dao-1',
          }),
        };
      }
      // label list 要给「已存在」的那些，否则 ensureRepoLabels 会去 label create（那一步不在被测范围）
      if (args[0] === 'label' && args[1] === 'list') {
        return { ok: true, out: JSON.stringify(['model/grok-4.6', 'model/claude-opus-5', 'type/写码', 'reviewer/gpt-5.6-luna', '卡死/等用户', '人工/待复核'].map((name) => ({ name }))) };
      }
      if (args[0] === 'pr' && args[1] === 'edit') return { ok: true, out: '{}' };
      return { ok: false, error: '未预期 ' + args.join(' ') };
    };
    const r = stampPrLabelsFromDispatch({
      pr: '9',
      runGh,
      repo: REPO,
      ensureLabels: ensureRepoLabels,
      events: [{ type: 'job.dispatch', identity: '工人', branch: 'dao-1', repo: REPO, model: 'grok-4.6', reviewer: 'gpt-5.6-luna' }],
    });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(r.drop, ['model/claude-opus-5']);
    assert.ok(!r.drop.includes('卡死/等用户'), JSON.stringify(r.drop));
    assert.ok(!r.drop.includes('人工/待复核'), JSON.stringify(r.drop));
  });

  it('判别力：把打标事件拿掉，起审官当场红', async () => {
    const { stampPrLabelsFromDispatch, resolveReviewerFromPr, resolveWorkerFromPr } = await WD;
    const runGh = (args) => {
      if (args[0] === 'pr' && args[1] === 'view') {
        return {
          ok: true,
          out: JSON.stringify({
            title: '[cc] 手开', body: '署名 issue #1070', labels: [], headRefName: 'hand-1070',
          }),
        };
      }
      throw new Error('未预期 ' + args.join(' '));
    };
    const stamped = stampPrLabelsFromDispatch({ pr: '1070', runGh, events: [], repo: REPO });
    assert.equal(stamped.ok, false);
    assert.equal(stamped.state, 'none');
    assert.equal(stamped.skipped, true);
    assert.match(stamped.error, /需人工打标/);
    const rev = resolveReviewerFromPr({ pr: '1070', runGh });
    assert.equal(rev.ok, false);
    assert.match(rev.error, /需人工打标/);
    const worker = resolveWorkerFromPr({ pr: '1070', runGh });
    assert.equal(worker.ok, false);
    assert.match(worker.error, /需人工打标/);
  });

  it('缺 reviewer 打标 fail-visible，不许 ok:true 只留下 model/type', async () => {
    const { stampPrLabelsFromDispatch } = await WD;
    const calls = [];
    const runGh = (args) => {
      calls.push(args.slice());
      if (args[0] === 'pr' && args[1] === 'view') {
        return {
          ok: true,
          out: JSON.stringify({ title: 'x', body: '署名 issue #1', labels: [], headRefName: 'dao-1' }),
        };
      }
      if (args[0] === 'pr' && args[1] === 'edit') return { ok: true, out: '{}' };
      return { ok: false, error: '未预期 ' + args.join(' ') };
    };
    const r = stampPrLabelsFromDispatch({
      pr: '1',
      runGh,
      repo: REPO,
      events: [{ type: 'job.dispatch', identity: '工人', branch: 'dao-1', repo: REPO, model: 'grok-4.6', work_type: '写码' }],
    });
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.equal(r.state, 'invalid');
    assert.equal(r.skipped, false);
    assert.match(r.error, /需人工打标/);
    assert.ok(!calls.some((a) => a[1] === 'edit'), JSON.stringify(calls));
  });

  it('缺 model 的已命中记录 skipped=false，不把坏账标成可跳过', async () => {
    const { stampPrLabelsFromDispatch } = await WD;
    const calls = [];
    const r = stampPrLabelsFromDispatch({
      pr: '1',
      runGh: (args) => {
        calls.push(args.slice());
        if (args[0] === 'pr' && args[1] === 'view') {
          return {
            ok: true,
            out: JSON.stringify({
              title: 'x', body: '署名 issue #1',
              labels: [{ name: 'model/grok-4.6' }, { name: 'reviewer/gpt-5.6-luna' }],
              headRefName: 'dao-1',
            }),
          };
        }
        if (args[0] === 'pr' && args[1] === 'edit') return { ok: true, out: '{}' };
        return { ok: false, error: '未预期 ' + args.join(' ') };
      },
      repo: REPO,
      events: [{
        type: 'job.dispatch', identity: '工人', branch: 'dao-1', repo: REPO,
        reviewer: 'gpt-5.6-luna', work_type: '写码',
      }],
    });
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.equal(r.state, 'invalid');
    assert.equal(r.skipped, false, '已命中坏账不许 skipped');
    assert.match(r.error, /缺 model/);
    assert.equal(calls.some((a) => a[1] === 'edit'), false, JSON.stringify(calls));
  });

  it('账本缺 reviewer（历史事件）取 PR 自己的 reviewer/*，账本有就以账本为准', async () => {
    const { pickWorkerDispatchByBranch } = await WD;
    const ev = (extra) => ({ type: 'job.dispatch', identity: '工人', branch: 'dao-1', repo: REPO, model: 'grok-4.6', work_type: '写码', ...extra });

    // 账本没写 reviewer，标签有：收下，并说清审官是标签来的
    const fromLabel = pickWorkerDispatchByBranch([ev({})], 'dao-1', REPO, { reviewerHint: 'gpt-5.6-luna' });
    assert.equal(fromLabel.ok, true, JSON.stringify(fromLabel));
    assert.equal(fromLabel.reviewer, 'gpt-5.6-luna');
    assert.equal(fromLabel.reviewerSource, 'pr-label');

    // 账本写了：账本的说了算，标签同值也标成 ledger
    const fromLedger = pickWorkerDispatchByBranch([ev({ reviewer: 'gpt-5.6-luna' })], 'dao-1', REPO, { reviewerHint: 'gpt-5.6-luna' });
    assert.equal(fromLedger.ok, true);
    assert.equal(fromLedger.reviewerSource, 'ledger');

    // 两条都在且不一致：不猜，报人工（两条都是派工那刻的决定）
    const clash = pickWorkerDispatchByBranch([ev({ reviewer: 'gpt-5.6-luna' })], 'dao-1', REPO, { reviewerHint: 'grok-4.6' });
    assert.equal(clash.ok, false);
    assert.equal(clash.state, 'conflict');
    assert.match(clash.error, /不一致/);

    // 两条都没有：仍拒，不许拿「账本没写」当放行
    const neither = pickWorkerDispatchByBranch([ev({})], 'dao-1', REPO, {});
    assert.equal(neither.ok, false);
    assert.equal(neither.state, 'invalid');
    assert.match(neither.error, /需人工打标/);

    // model 没有这种历史缺口：缺了就是拒，不许从标签补；已命中坏账不是 none
    const noModel = pickWorkerDispatchByBranch([ev({ model: '' })], 'dao-1', REPO, { reviewerHint: 'gpt-5.6-luna' });
    assert.equal(noModel.ok, false);
    assert.equal(noModel.state, 'invalid');
    assert.match(noModel.error, /缺 model/);
  });

  it('跨仓同名分支：后写的另一仓 dispatch 不给本仓 PR 打标', async () => {
    const { stampPrLabelsFromDispatch } = await WD;
    const { ensureRepoLabels } = await CARD;
    const calls = [];
    const runGh = (args) => {
      calls.push(args.slice());
      if (args[0] === 'pr' && args[1] === 'view') {
        return {
          ok: true,
          out: JSON.stringify({ title: 'x', body: '署名 issue #2', labels: [], headRefName: 'dao-1' }),
        };
      }
      if (args[0] === 'label' && args[1] === 'list') {
        return { ok: true, out: JSON.stringify([{ name: 'model/grok-4.6' }, { name: 'type/写码' }, { name: 'reviewer/gpt-5.6-luna' }]) };
      }
      if (args[0] === 'pr' && args[1] === 'edit') return { ok: true, out: '{}' };
      return { ok: false, error: '未预期 ' + args.join(' ') };
    };
    const r = stampPrLabelsFromDispatch({
      pr: '2',
      runGh,
      repo: REPO,
      ensureLabels: ensureRepoLabels,
      events: [
        { type: 'job.dispatch', identity: '工人', branch: 'dao-1', repo: REPO, model: 'grok-4.6', reviewer: 'gpt-5.6-luna' },
        { type: 'job.dispatch', identity: '工人', branch: 'dao-1', repo: OTHER, model: 'kimi-k3', reviewer: 'gpt-5.6-sol' },
      ],
    });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.model, 'grok-4.6');
    assert.equal(r.reviewer, 'gpt-5.6-luna');
    assert.ok(r.labels.includes('model/grok-4.6'));
    assert.ok(r.labels.includes('reviewer/gpt-5.6-luna'));
    assert.ok(!r.labels.includes('model/kimi-k3'));
  });

  it('fork PR：headRepository 是来源仓，打标键用目标仓', async () => {
    const { stampPrLabelsFromDispatch } = await WD;
    const { ensureRepoLabels } = await CARD;
    const calls = [];
    const runGh = (args) => {
      calls.push(args.slice());
      if (args[0] === 'pr' && args[1] === 'view') {
        return {
          ok: true,
          out: JSON.stringify({
            title: 'x',
            body: '署名 issue #7',
            labels: [],
            headRefName: 'dao-7',
            headRepository: { nameWithOwner: 'fork-owner/source-repo' },
            url: 'https://github.com/base-owner/base-repo/pull/7',
          }),
        };
      }
      if (args[0] === 'label' && args[1] === 'list') {
        return {
          ok: true,
          out: JSON.stringify([
            { name: 'model/grok-4.6' },
            { name: 'type/写码' },
            { name: 'reviewer/gpt-5.6-luna' },
          ]),
        };
      }
      if (args[0] === 'pr' && args[1] === 'edit') return { ok: true, out: '{}' };
      return { ok: false, error: '未预期 ' + args.join(' ') };
    };
    const r = stampPrLabelsFromDispatch({
      pr: '7',
      runGh,
      repo: 'base-owner/base-repo',
      ensureLabels: ensureRepoLabels,
      events: [{
        type: 'job.dispatch', identity: '工人', branch: 'dao-7', repo: 'base-owner/base-repo',
        model: 'grok-4.6', reviewer: 'gpt-5.6-luna', work_type: '写码',
      }],
    });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.repo, 'base-owner/base-repo');
    assert.ok(r.labels.includes('model/grok-4.6'));
    assert.ok(r.labels.includes('reviewer/gpt-5.6-luna'));
    assert.equal(calls.some((a) => a[0] === 'pr' && a[1] === 'edit'), true);
    assert.equal(String(r.error || '').includes('fork-owner/source-repo'), false);
  });

  it('跨仓同名分支：PR URL 是另一仓时拒打标', async () => {
    const { stampPrLabelsFromDispatch } = await WD;
    const calls = [];
    const runGh = (args) => {
      calls.push(args.slice());
      if (args[0] === 'pr' && args[1] === 'view') {
        return {
          ok: true,
          out: JSON.stringify({
            title: 'x',
            body: '署名 issue #2',
            labels: [],
            headRefName: 'dao-1',
            headRepository: { nameWithOwner: OTHER },
            url: `https://github.com/${OTHER}/pull/2`,
          }),
        };
      }
      if (args[0] === 'pr' && args[1] === 'edit') return { ok: true, out: '{}' };
      return { ok: false, error: '未预期 ' + args.join(' ') };
    };
    const r = stampPrLabelsFromDispatch({
      pr: '2',
      runGh,
      repo: REPO,
      events: [{
        type: 'job.dispatch', identity: '工人', branch: 'dao-1', repo: REPO,
        model: 'grok-4.6', reviewer: 'gpt-5.6-luna', work_type: '写码',
      }],
    });
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.match(r.error, /不许跨仓套标/);
    assert.match(r.error, new RegExp(OTHER));
    assert.equal(calls.some((a) => a[0] === 'pr' && a[1] === 'edit'), false, JSON.stringify(calls));
  });

  it('多个 reviewer/*（含同名重复）fail-closed，账本有值也不放行', async () => {
    const { stampPrLabelsFromDispatch } = await WD;
    const events = [{
      type: 'job.dispatch', identity: '工人', branch: 'dao-1', repo: REPO,
      model: 'grok-4.6', reviewer: 'gpt-5.6-luna', work_type: '写码',
    }];
    const run = (labels) => {
      const calls = [];
      const r = stampPrLabelsFromDispatch({
        pr: '1',
        runGh: (args) => {
          calls.push(args.slice());
          if (args[0] === 'pr' && args[1] === 'view') {
            return {
              ok: true,
              out: JSON.stringify({
                title: 'x', body: '署名 issue #1', labels, headRefName: 'dao-1',
              }),
            };
          }
          if (args[0] === 'pr' && args[1] === 'edit') return { ok: true, out: '{}' };
          return { ok: false, error: '未预期 ' + args.join(' ') };
        },
        repo: REPO,
        events,
      });
      return { r, calls };
    };

    const two = run([
      { name: 'model/grok-4.6' },
      { name: 'reviewer/gpt-5.6-luna' },
      { name: 'reviewer/gpt-5.6-sol' },
    ]);
    assert.equal(two.r.ok, false, JSON.stringify(two.r));
    assert.equal(two.r.state, 'many');
    assert.match(two.r.error, /多个 reviewer/);
    assert.equal(two.calls.some((a) => a[1] === 'edit'), false, JSON.stringify(two.calls));

    const dup = run([
      { name: 'reviewer/gpt-5.6-luna' },
      { name: 'reviewer/gpt-5.6-luna' },
    ]);
    assert.equal(dup.r.ok, false, JSON.stringify(dup.r));
    assert.equal(dup.r.state, 'many');
    assert.equal(dup.calls.some((a) => a[1] === 'edit'), false, JSON.stringify(dup.calls));
  });

  it('账本 reviewer 与 PR 唯一标签不一致：stamp fail-closed 不 edit', async () => {
    const { stampPrLabelsFromDispatch } = await WD;
    const calls = [];
    const r = stampPrLabelsFromDispatch({
      pr: '1',
      runGh: (args) => {
        calls.push(args.slice());
        if (args[0] === 'pr' && args[1] === 'view') {
          return {
            ok: true,
            out: JSON.stringify({
              title: 'x', body: '署名 issue #1',
              labels: [{ name: 'reviewer/gpt-5.6-sol' }],
              headRefName: 'dao-1',
            }),
          };
        }
        if (args[0] === 'pr' && args[1] === 'edit') return { ok: true, out: '{}' };
        return { ok: false, error: '未预期 ' + args.join(' ') };
      },
      repo: REPO,
      events: [{
        type: 'job.dispatch', identity: '工人', branch: 'dao-1', repo: REPO,
        model: 'grok-4.6', reviewer: 'gpt-5.6-luna', work_type: '写码',
      }],
    });
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.equal(r.state, 'conflict');
    assert.match(r.error, /不一致/);
    assert.equal(calls.some((a) => a[1] === 'edit'), false, JSON.stringify(calls));
  });

  it('历史事件缺 repo/reviewer：stamp 成功返回值带 repoAssumed 与 reviewerSource', async () => {
    const { stampPrLabelsFromDispatch } = await WD;
    const { ensureRepoLabels } = await CARD;
    const r = stampPrLabelsFromDispatch({
      pr: '3',
      runGh: (args) => {
        if (args[0] === 'pr' && args[1] === 'view') {
          return {
            ok: true,
            out: JSON.stringify({
              title: 'x', body: '署名 issue #3',
              labels: [{ name: 'reviewer/gpt-5.6-luna' }],
              headRefName: 'dao-3',
            }),
          };
        }
        if (args[0] === 'label' && args[1] === 'list') {
          return {
            ok: true,
            out: JSON.stringify([
              { name: 'model/grok-4.6' },
              { name: 'type/写码' },
              { name: 'reviewer/gpt-5.6-luna' },
            ]),
          };
        }
        if (args[0] === 'pr' && args[1] === 'edit') return { ok: true, out: '{}' };
        return { ok: false, error: '未预期 ' + args.join(' ') };
      },
      repo: REPO,
      ensureLabels: ensureRepoLabels,
      events: [{ type: 'job.dispatch', identity: '工人', branch: 'dao-3', model: 'grok-4.6', work_type: '写码' }],
    });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.repoAssumed, true);
    assert.equal(r.reviewerSource, 'pr-label');
    assert.equal(r.reviewer, 'gpt-5.6-luna');
  });
});

describe('快路无署名单号也能交卷', () => {
  // 指挥官 #1240：快路 PR 无署名不挡返工。worker-done 原先对称地拒（「完工 comment 没处可发」），
  // 于是快路判红后工人改完正文却交不了卷。评论落 PR；没署名单就不给 issue 发。
  it('planWorkerDone 无署名 → ok，issue 为 null，评论首行仍是返工完成', async () => {
    const { planWorkerDone } = await WD;
    const r = planWorkerDone({
      pr: '1258',
      body: '返工完成：补正文',
      runGh: (args) => {
        if (args[0] === 'pr' && args[1] === 'view' && String(args).includes('reviews')) {
          return { ok: true, out: JSON.stringify({ reviews: [{ id: 1, state: 'CHANGES_REQUESTED' }] }) };
        }
        if (args[0] === 'pr' && args[1] === 'view') {
          return {
            ok: true,
            out: JSON.stringify({
              title: '[cc] fix(打标): x',
              body: '快路无署名 issue',
              labels: [{ name: 'model/grok-4.6' }, { name: 'reviewer/gpt-5.6-luna' }, { name: 'type/写码' }],
              headRefName: 'fix/stale-model-label',
            }),
          };
        }
        return { ok: false, error: '未预期 ' + args.join(' ') };
      },
    });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.issue, null);
    assert.equal(r.round, 'rework');
    assert.match(r.comment, /^返工完成/);
  });
});

describe('选型路径零残留', () => {
  it('四处删除在仓内 grep 零命中（生产代码）', () => {
    const banned = [
      'collectIssueLabelsFromPr',
      'vendorFamilyFromHostPrefix',
      'HOST_PREFIX_VENDOR_FAMILY',
      'function uniqueNames',
    ];
    const hits = [];
    const walk = (dir) => {
      for (const name of fs.readdirSync(dir)) {
        if (name === 'node_modules' || name === '.git') continue;
        const p = path.join(dir, name);
        const st = fs.statSync(p);
        if (st.isDirectory()) walk(p);
        else if (/\.(mjs|js|md)$/.test(name) && !name.includes('CHANGELOG')) {
          const text = fs.readFileSync(p, 'utf8');
          for (const needle of banned) {
            if (text.includes(needle) && !p.includes(`${path.sep}tests${path.sep}`)) {
              hits.push(`${p}: ${needle}`);
            }
          }
        }
      }
    };
    walk(path.join(ROOT, 'scripts'));
    walk(path.join(ROOT, 'host'));
    assert.deepEqual(hits, [], hits.join('\n'));
  });

  it('ready-queue-check 的链接判据是 re-export，不是第二份正则', () => {
    const src = fs.readFileSync(path.join(ROOT, 'scripts', 'lib', 'ready-queue-check.mjs'), 'utf8');
    // 两份判据都从 worker-done 取，本文件不自己写正则（名字列表顺序不钉死）。
    assert.match(src, /import \{[^}]*\blinkedIssueNumbers\b[^}]*\} from '\.\/dispatch\/worker-done\.mjs'/);
    assert.match(src, /import \{[^}]*\bclaimedIssueNumbers\b[^}]*\} from '\.\/dispatch\/worker-done\.mjs'/);
    assert.doesNotMatch(src, /const CLOSES_RE/);
    assert.doesNotMatch(src, /export function linkedIssueNumbers/);
    assert.doesNotMatch(src, /export function claimedIssueNumbers/);
  });

  it('#1051 在途判据用认领口径，不是宽口径（两个缺陷：关联当认领 + 否定式当认领）', () => {
    const rq = fs.readFileSync(path.join(ROOT, 'scripts', 'lib', 'ready-queue-check.mjs'), 'utf8');
    // 判在途那一行必须是 claimedIssueNumbers；用回 linkedIssueNumbers 直接红。
    assert.match(rq, /for \(const n of claimedIssueNumbers\(/);
    assert.doesNotMatch(rq, /for \(const n of linkedIssueNumbers\(/);

    const wd = fs.readFileSync(path.join(ROOT, 'scripts', 'lib', 'dispatch', 'worker-done.mjs'), 'utf8');
    // 认领判据只有一个实现副本，在关单侧。这里抄第二份正则就红（名字列表顺序不钉死）。
    assert.match(wd, /import \{[^}]*\battributedIssueNumbers\b[^}]*\} from '\.\.\/close-issue\.mjs'/);
    const claimedBody = wd.slice(wd.indexOf('export function claimedIssueNumbers'));
    assert.match(claimedBody, /return attributedIssueNumbers\(text\)/);
  });

  it('关单侧的认领判据会剥掉被否定的分句', () => {
    const ci = fs.readFileSync(path.join(ROOT, 'scripts', 'lib', 'close-issue.mjs'), 'utf8');
    assert.match(ci, /export function stripNegatedClaims/);
    assert.match(ci, /const scan = stripNegatedClaims\(text\)/);
  });

  it('closeIssueForPr 对还开着的目标传入 openIssues（标题裸退路收严接到写动作）', () => {
    const ci = fs.readFileSync(path.join(ROOT, 'scripts', 'lib', 'close-issue.mjs'), 'utf8');
    const fn = ci.slice(ci.indexOf('export function closeIssueForPr'));
    assert.match(fn, /attributedIssueNumber\(pr,\s*\{\s*openIssues:/);
  });

  it('job.dispatch schema 有 reviewer 与 branch 与 repo', () => {
    const schema = JSON.parse(fs.readFileSync(path.join(ROOT, 'schemas', 'events.schema.json'), 'utf8'));
    const variants = schema.oneOf || schema.anyOf || [];
    const job = variants.find((x) => x.title === 'job.dispatch');
    assert.ok(job, 'schema 缺 job.dispatch');
    const props = job.allOf[1].properties;
    assert.ok(props.reviewer, 'schema 缺 reviewer');
    assert.ok(props.branch, 'schema 缺 branch');
    assert.ok(props.repo, 'schema 缺 repo');
  });

  it('mirasim 派工写口带 reviewer + branch + repo', () => {
    const src = fs.readFileSync(path.join(ROOT, 'scripts', 'dao.mjs'), 'utf8');
    const fn = src.slice(src.indexOf('async function cmdDispatchMirasim'), src.indexOf('async function cmdDispatch(args)'));
    assert.match(fn, /reviewer: args\.reviewer/);
    assert.match(fn, /branch,/);
    assert.match(fn, /repo: resolveDispatchRepo\(ghRepo\)/);
  });
});

describe('快路无署名单号也能交卷', () => {
  // 指挥官 #1240：快路 PR 无署名不挡返工。worker-done 原先对称地拒（「完工 comment 没处可发」），
  // 于是快路判红后工人改完正文却交不了卷。评论落 PR；没署名单就不给 issue 发。
  it('planWorkerDone 无署名 → ok，issue 为 null，评论首行仍是返工完成', async () => {
    const { planWorkerDone } = await WD;
    const r = planWorkerDone({
      pr: '1265',
      body: '返工完成：补正文',
      runGh: (args) => {
        if (args[0] === 'pr' && args[1] === 'view' && String(args).includes('reviews')) {
          return { ok: true, out: JSON.stringify({ reviews: [{ id: 1, state: 'CHANGES_REQUESTED' }] }) };
        }
        if (args[0] === 'pr' && args[1] === 'view') {
          return {
            ok: true,
            out: JSON.stringify({
              title: 'fix(并发): 收尾名额与审官上限不再手打 3',
              body: '快路无署名 issue',
              labels: [{ name: 'model/grok-4.6' }, { name: 'reviewer/gpt-5.6-luna' }, { name: 'type/写码' }],
              headRefName: 'dao-finish-slots',
            }),
          };
        }
        return { ok: false, error: '未预期 ' + args.join(' ') };
      },
    });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.issue, null);
    assert.equal(r.round, 'rework');
    assert.match(r.comment, /^返工完成/);
  });
});

function lastJson(r) {
  try { return JSON.parse(String(r.stdout || '').trim().split(/\r?\n/).pop()); }
  catch { return { raw: r.stdout, err: r.stderr }; }
}

function cliWithGhLog(verb, pr) {
  const log = path.join(os.tmpdir(), `dao-1116-gh-${verb}-${pr}-${process.pid}-${Date.now()}.log`);
  try { fs.unlinkSync(log); } catch { /* 没有就没有 */ }
  const r = spawnSync(process.execPath, [
    path.join(ROOT, 'scripts', 'dao.mjs'),
    verb, '--pr', String(pr), '--executor', 'mirasim', '--dry-run',
  ], {
    encoding: 'utf8',
    cwd: ROOT,
    env: {
      ...process.env,
      DAO_GH_FAKE: path.join(ROOT, 'tests', 'fixtures', 'fake-gh.mjs'),
      DAO_GH_FAKE_LOG: log,
      DAO_GH_FAKE_REFUSE_ISSUE_VIEW: '1',
    },
  });
  const logText = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
  try { fs.unlinkSync(log); } catch { /* 测完收 */ }
  return { r, logText, payload: lastJson(r) };
}

describe('CLI 选型入口一次 issue label 都不读', () => {
  it('reviewer-create --pr 42：成功且 gh 序列没有 issue view', () => {
    const { r, logText, payload } = cliWithGhLog('reviewer-create', 42);
    assert.equal(r.status, 0, JSON.stringify({ payload, stderr: r.stderr, logText }));
    assert.equal(payload.ok, true);
    assert.equal(payload.reviewer, 'gpt-5.6-luna');
    assert.match(logText, /pr view/);
    assert.doesNotMatch(logText, /issue view/);
  });

  it('worker-done --pr 42：成功且 gh 序列没有 issue view', () => {
    const { r, logText, payload } = cliWithGhLog('worker-done', 42);
    assert.equal(r.status, 0, JSON.stringify({ payload, stderr: r.stderr, logText }));
    assert.equal(payload.ok, true);
    assert.equal(payload.reviewer, 'gpt-5.6-luna');
    assert.match(logText, /pr view/);
    assert.doesNotMatch(logText, /issue view/);
  });

  it('reviewer-create 手开无标 PR → 拒，话面需人工打标', () => {
    const { r, logText, payload } = cliWithGhLog('reviewer-create', 41);
    assert.notEqual(r.status, 0, JSON.stringify({ payload, stderr: r.stderr }));
    assert.match(String(payload.error || r.stderr || ''), /需人工打标/);
    assert.doesNotMatch(logText, /issue view/);
  });
});

function writeLedgerEvents(events) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dao-1211-ledger-'));
  events.forEach((e, i) => {
    fs.writeFileSync(path.join(dir, `${i}.json`), JSON.stringify(e));
  });
  return dir;
}

function cliWithLedger(verb, pr, { events, extraArgs = [] } = {}) {
  const dir = writeLedgerEvents(events);
  const log = path.join(os.tmpdir(), `dao-1211-gh-${verb}-${pr}-${process.pid}-${Date.now()}.log`);
  try { fs.unlinkSync(log); } catch { /* 没有就没有 */ }
  const args = [path.join(ROOT, 'scripts', 'dao.mjs'), verb, '--pr', String(pr), ...extraArgs];
  if (verb !== 'pr-sync-labels') args.push('--executor', 'mirasim', '--dry-run');
  const r = spawnSync(process.execPath, args, {
    encoding: 'utf8',
    cwd: ROOT,
    env: {
      ...process.env,
      LEDGER_EVENTS_DIR: dir,
      DAO_GH_FAKE: path.join(ROOT, 'tests', 'fixtures', 'fake-gh.mjs'),
      DAO_GH_FAKE_LOG: log,
      DAO_GH_FAKE_REFUSE_ISSUE_VIEW: '1',
    },
  });
  const logText = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
  try { fs.unlinkSync(log); } catch { /* 测完收 */ }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 测完收 */ }
  return { r, logText, payload: lastJson(r) };
}

const FAKE_HEAD = 'thoerwink8/fake-head';
const clashEvent = {
  type: 'job.dispatch',
  identity: '工人',
  branch: FAKE_HEAD,
  repo: REPO,
  model: 'grok-4.6',
  reviewer: 'gpt-5.6-sol',
  work_type: '写码',
};
const historicEvent = {
  type: 'job.dispatch',
  identity: '工人',
  branch: FAKE_HEAD,
  model: 'grok-4.6',
  work_type: '写码',
};
const completeEvent = {
  type: 'job.dispatch',
  identity: '工人',
  branch: FAKE_HEAD,
  repo: REPO,
  model: 'grok-4.6',
  reviewer: 'gpt-5.6-luna',
  work_type: '写码',
};
const missingModelEvent = {
  type: 'job.dispatch',
  identity: '工人',
  branch: FAKE_HEAD,
  repo: REPO,
  reviewer: 'gpt-5.6-luna',
  work_type: '写码',
};
const badIdentityEvent = {
  type: 'job.dispatch',
  identity: '审官',
  branch: FAKE_HEAD,
  repo: REPO,
  model: 'grok-4.6',
  reviewer: 'gpt-5.6-luna',
  work_type: '写码',
};

describe('CLI 已查成冲突 fail-closed，来源字段向外层返回', () => {
  it('reviewer-create：账本 sol vs PR 唯一标签 luna → 拒，不继续选 PR 标签', () => {
    const { r, payload } = cliWithLedger('reviewer-create', 42, { events: [clashEvent] });
    assert.notEqual(r.status, 0, JSON.stringify({ payload, stderr: r.stderr }));
    assert.equal(payload.ok, false);
    assert.equal(payload.state, 'conflict');
    assert.match(String(payload.error || ''), /不一致/);
    assert.notEqual(payload.reviewer, 'gpt-5.6-luna');
    assert.notEqual(payload.reviewer, 'gpt-5.6-sol');
  });

  it('worker-done：账本 sol vs PR 唯一标签 luna → 拒，不继续选 PR 标签', () => {
    const { r, payload } = cliWithLedger('worker-done', 42, { events: [clashEvent] });
    assert.notEqual(r.status, 0, JSON.stringify({ payload, stderr: r.stderr }));
    assert.equal(payload.ok, false);
    assert.equal(payload.state, 'conflict');
    assert.match(String(payload.error || ''), /不一致/);
  });

  it('pr-sync-labels：历史事件缺 repo/reviewer → 输出 repoAssumed 与 reviewerSource=pr-label', () => {
    const { r, payload } = cliWithLedger('pr-sync-labels', 42, { events: [historicEvent] });
    assert.equal(r.status, 0, JSON.stringify({ payload, stderr: r.stderr }));
    assert.equal(payload.ok, true);
    assert.equal(payload.repoAssumed, true);
    assert.equal(payload.reviewerSource, 'pr-label');
    assert.equal(payload.reviewer, 'gpt-5.6-luna');
  });

  it('pr-sync-labels：账本写全 → 输出 repoAssumed=false 与 reviewerSource=ledger', () => {
    const { r, payload } = cliWithLedger('pr-sync-labels', 42, { events: [completeEvent] });
    assert.equal(r.status, 0, JSON.stringify({ payload, stderr: r.stderr }));
    assert.equal(payload.ok, true);
    assert.equal(payload.repoAssumed, false);
    assert.equal(payload.reviewerSource, 'ledger');
    assert.equal(payload.reviewer, 'gpt-5.6-luna');
  });

  it('reviewer-create：同仓同分支工人账缺 model，PR 自有标签也拒', () => {
    const { r, payload } = cliWithLedger('reviewer-create', 42, { events: [missingModelEvent] });
    assert.notEqual(r.status, 0, JSON.stringify({ payload, stderr: r.stderr }));
    assert.equal(payload.ok, false);
    assert.equal(payload.state, 'invalid');
    assert.match(String(payload.error || ''), /缺 model/);
    assert.notEqual(payload.reviewer, 'gpt-5.6-luna');
  });

  it('worker-done：同仓同分支工人账缺 model，PR 自有标签也拒', () => {
    const { r, payload } = cliWithLedger('worker-done', 42, { events: [missingModelEvent] });
    assert.notEqual(r.status, 0, JSON.stringify({ payload, stderr: r.stderr }));
    assert.equal(payload.ok, false);
    assert.equal(payload.state, 'invalid');
    assert.match(String(payload.error || ''), /缺 model/);
  });

  it('reviewer-create：同仓同分支账 identity 不是工人 → 拒', () => {
    const { r, payload } = cliWithLedger('reviewer-create', 42, { events: [badIdentityEvent] });
    assert.notEqual(r.status, 0, JSON.stringify({ payload, stderr: r.stderr }));
    assert.equal(payload.ok, false);
    assert.equal(payload.state, 'invalid');
    assert.match(String(payload.error || ''), /缺 identity 或不是工人/);
  });

  it('worker-done：同仓同分支账 identity 不是工人 → 拒', () => {
    const { r, payload } = cliWithLedger('worker-done', 42, { events: [badIdentityEvent] });
    assert.notEqual(r.status, 0, JSON.stringify({ payload, stderr: r.stderr }));
    assert.equal(payload.ok, false);
    assert.equal(payload.state, 'invalid');
    assert.match(String(payload.error || ''), /缺 identity 或不是工人/);
  });

  it('reviewer-create：扫完没有匹配的 job.dispatch 仍可跳过，认 PR 自有标签', () => {
    const { r, payload } = cliWithLedger('reviewer-create', 42, { events: [] });
    assert.equal(r.status, 0, JSON.stringify({ payload, stderr: r.stderr }));
    assert.equal(payload.ok, true);
    assert.equal(payload.reviewer, 'gpt-5.6-luna');
  });
});

// ── #1214 缺口 A：帅位自开 PR 的正式入口（pr-open）
//
// 用户 2026-09-13 拍板走「显式打标入口」先解环。这一组验的就是那条入口：
// 开 draft + 落账（job.opened + job.dispatch）+ 打标，且**判据一个字没放宽**——
// 补给打标路的是一条真账，不是给判据开的后门。

function prOpenEnv({ ledgerDir, newPr = '901' } = {}) {
  const log = path.join(os.tmpdir(), `dao-priopen-gh-${process.pid}-${Date.now()}.log`);
  try { fs.unlinkSync(log); } catch { /* 没有就没有 */ }
  return {
    log,
    env: {
      ...process.env,
      DAO_GH_FAKE: path.join(ROOT, 'tests', 'fixtures', 'fake-gh.mjs'),
      DAO_GH_FAKE_LOG: log,
      DAO_GH_FAKE_NEW_PR: String(newPr),
      LEDGER_EVENTS_DIR: ledgerDir,
    },
  };
}

function runPrOpen(extraArgs, { ledgerDir, newPr, omitModel, envExtra } = {}) {
  const { log, env } = prOpenEnv({ ledgerDir, newPr });
  const argv = [
    path.join(ROOT, 'scripts', 'dao.mjs'), 'pr-open',
    '--title', '[cc] 帅位自开的活',
    '--body', '## 目标\n\n解环。\n\n## 验收标准\n\n- [ ] 打得上标\n\n## 进展\n\n- [ ] 待开工',
    '--head', 'cc/seat-opened',
  ];
  if (!omitModel) argv.push('--model', 'claude-opus');
  argv.push(...extraArgs);
  const r = spawnSync(process.execPath, argv, {
    encoding: 'utf8', cwd: ROOT, env: { ...env, ...(envExtra || {}) }, timeout: 60000,
  });
  const logText = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
  try { fs.unlinkSync(log); } catch { /* 测完收 */ }
  return { r, logText, payload: lastJson(r) };
}

function ledgerEvents(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json') && !f.endsWith('.schema.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
}

describe('#1214 缺口 A：pr-open 落账后，打标路真的认得出这条链', () => {
  it('开 draft + 落 job.opened/job.dispatch（带 branch/repo/model/reviewer）+ 打标', () => {
    const ledgerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dao-priopen-ledger-'));
    try {
      const { r, payload, logText } = runPrOpen(['--reviewer', 'gpt-5.6-luna'], { ledgerDir });
      assert.equal(r.status, 0, JSON.stringify({ payload, stderr: r.stderr, logText }));
      assert.equal(payload.ok, true);
      assert.equal(payload.pr, 901);
      assert.equal(payload.draft, true);
      assert.equal(payload.ledgerWritten, true);
      assert.match(logText, /pr create/);
      assert.match(logText, /--draft/);
      const evts = ledgerEvents(ledgerDir);
      assert.deepEqual(evts.map((e) => e.type).sort(), ['job.dispatch', 'job.opened']);
      const d = evts.find((e) => e.type === 'job.dispatch');
      assert.equal(d.identity, '工人');
      assert.equal(d.model, 'claude-opus');
      assert.equal(d.branch, 'cc/seat-opened');
      assert.equal(d.repo, REPO);
      assert.equal(d.reviewer, 'gpt-5.6-luna');
      assert.equal(d.pr_number, 901);
      // 打标路读的就是这条 —— 这正是缺口 A 的修法：账补上，判据不放宽。
      assert.equal(d.source, 'dao-pr-open');
    } finally { fs.rmSync(ledgerDir, { recursive: true, force: true }); }
  });

  it('落的那条账，pickWorkerDispatchByBranch 当场认得出（不是「写了就算」）', async () => {
    const { pickWorkerDispatchByBranch } = await WD;
    const ledgerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dao-priopen-pick-'));
    try {
      const { r } = runPrOpen(['--reviewer', 'gpt-5.6-luna'], { ledgerDir });
      assert.equal(r.status, 0, r.stderr);
      const picked = pickWorkerDispatchByBranch(ledgerEvents(ledgerDir), 'cc/seat-opened', REPO);
      assert.equal(picked.ok, true, JSON.stringify(picked));
      assert.equal(picked.model, 'claude-opus');
      assert.equal(picked.reviewer, 'gpt-5.6-luna');
    } finally { fs.rmSync(ledgerDir, { recursive: true, force: true }); }
  });

  it('--model 不在 registry ⇒ 拒，且一条账都不落（不落幽灵账）', () => {
    const ledgerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dao-priopen-badmodel-'));
    try {
      const { r, payload } = runPrOpen(['--model', 'mistral-large-不存在的'], { ledgerDir });
      assert.notEqual(r.status, 0, JSON.stringify(payload));
      assert.match(String(payload.error || r.stderr || ''), /不在 registry/);
      assert.equal(ledgerEvents(ledgerDir).length, 0);
    } finally { fs.rmSync(ledgerDir, { recursive: true, force: true }); }
  });

  it('缺 --head ⇒ 当场拒（分支名是打标路的键，猜不得）', () => {
    const noHead = spawnSync(process.execPath, [
      path.join(ROOT, 'scripts', 'dao.mjs'), 'pr-open',
      '--title', 'x', '--body', 'y', '--model', 'claude-opus',
    ], {
      encoding: 'utf8', cwd: ROOT,
      env: { ...process.env, DAO_GH_FAKE: path.join(ROOT, 'tests', 'fixtures', 'fake-gh.mjs') },
    });
    assert.notEqual(noHead.status, 0);
    assert.match(String(noHead.stdout || noHead.stderr), /--head/);
  });

  // 审官 2026-09-14 判红第 1 条：文档原写「--reviewer 不给也行，稍后 pr-sync-labels 补齐」。
  // 那是错的——打标路要求这条 job.dispatch 里 model 与 reviewer **同时在**，缺一个就是
  // 「需人工打标」。所以缺 reviewer 必须当场拒，不能让一条打不上标的账落下去。
  it('缺 --reviewer ⇒ 当场拒，且一条账都不落（缺它就永远打不上标）', () => {
    const ledgerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dao-priopen-norev-'));
    try {
      const { r, payload } = runPrOpen([], { ledgerDir });
      assert.notEqual(r.status, 0, JSON.stringify(payload));
      assert.match(String(payload.error || r.stderr || ''), /--reviewer/);
      assert.equal(ledgerEvents(ledgerDir).length, 0);
    } finally { fs.rmSync(ledgerDir, { recursive: true, force: true }); }
  });

  it('--reviewer 不在 registry ⇒ 拒，不落幽灵账', () => {
    const ledgerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dao-priopen-badrev-'));
    try {
      const { r, payload } = runPrOpen(['--reviewer', '审官-不存在的'], { ledgerDir });
      assert.notEqual(r.status, 0, JSON.stringify(payload));
      assert.match(String(payload.error || r.stderr || ''), /不是可用审官|不在 registry/);
      assert.equal(ledgerEvents(ledgerDir).length, 0);
    } finally { fs.rmSync(ledgerDir, { recursive: true, force: true }); }
  });

  // 「在 registry 里」不等于「能当审官」。composer-2.5 在 registry 里，roles 却没有「审查」——
  // 放它过去就是一条「账上写着审官、起不来审官会话」的坏账，比缺字段更难查。
  it('--reviewer 在 registry 但不能当审官 ⇒ 拒（roles 不含「审查」）', () => {
    const ledgerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dao-priopen-nonrev-'));
    try {
      const { r, payload } = runPrOpen(['--model', 'grok-4.6', '--reviewer', 'composer-2.5'], { ledgerDir });
      assert.notEqual(r.status, 0, JSON.stringify(payload));
      assert.match(String(payload.error || r.stderr || ''), /不是可用审官/);
      assert.equal(ledgerEvents(ledgerDir).length, 0);
    } finally { fs.rmSync(ledgerDir, { recursive: true, force: true }); }
  });

  // 同厂当场拒：这条链一落账审官就定死了，开 PR 是唯一能拦住「自己审自己」的点。
  // 取 grok-4.6 + grok-mirasim-native：两个都在 registry、都是可用审官、真实供应商同为 grok——
  // 只有厂商这一关能拦住它们（先前用 claude-opus 是错的：它 reviewerDisabled，先被上一条挡下，
  // 于是这条测试根本走不到厂商闸，「配了正控」是假的）。
  it('--reviewer 与 --model 同厂 ⇒ 当场拒（审查换厂商）', () => {
    const ledgerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dao-priopen-samevendor-'));
    try {
      const { r, payload } = runPrOpen(['--model', 'grok-4.6', '--reviewer', 'grok-mirasim-native'], { ledgerDir });
      assert.notEqual(r.status, 0, JSON.stringify(payload));
      assert.match(String(payload.error || r.stderr || ''), /同厂|换厂商/);
      assert.equal(payload.vendorGate && payload.vendorGate.state, 'same_vendor',
        '要走到厂商闸才算验到，别的闸挡下都不算：' + JSON.stringify(payload).slice(0, 200));
      assert.equal(ledgerEvents(ledgerDir).length, 0);
    } finally { fs.rmSync(ledgerDir, { recursive: true, force: true }); }
  });

  // 审官 2026-09-14 返工红 3：CLI 必须覆盖真正不传 --model 的入口，不能只测导出的纯函数。
  it('不传 --model ⇒ 按当前审官座位 × 执行目录现算，落到 grok-4.6', () => {
    const ledgerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dao-priopen-nomodel-'));
    try {
      const { r, payload, logText } = runPrOpen(['--reviewer', 'gpt-5.6-luna'], { ledgerDir, omitModel: true });
      assert.equal(r.status, 0, JSON.stringify({ payload, stderr: r.stderr, logText }));
      assert.equal(payload.ok, true);
      assert.equal(payload.model, 'grok-4.6');
      assert.equal(payload.reviewer, 'gpt-5.6-luna');
      assert.match(logText, /pr create/);
      const d = ledgerEvents(ledgerDir).find((e) => e.type === 'job.dispatch');
      assert.equal(d && d.model, 'grok-4.6');
    } finally { fs.rmSync(ledgerDir, { recursive: true, force: true }); }
  });

  // 审官 2026-09-14 返工红 2：执行目录没查成时自动选腿 fail-closed，假 GitHub 0 次调用。
  it('不传 --model 且执行目录坏 JSON ⇒ 拒，假 GitHub 0 次调用', () => {
    const ledgerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dao-priopen-badcat-'));
    const broken = path.join(os.tmpdir(), `dao-priopen-broken-${process.pid}-${Date.now()}.json`);
    fs.writeFileSync(broken, '{not json');
    try {
      const { r, payload, logText } = runPrOpen(['--reviewer', 'gpt-5.6-luna'], {
        ledgerDir, omitModel: true, envExtra: { DAO_EXECUTION_PROFILES: broken },
      });
      assert.notEqual(r.status, 0, JSON.stringify(payload));
      assert.match(String(payload.error || r.stderr || ''), /执行目录没查成|请显式 --model/);
      assert.equal(/pr create/.test(logText), false, '没查成不许去开 PR：' + logText);
      assert.equal(ledgerEvents(ledgerDir).length, 0);
    } finally {
      fs.rmSync(ledgerDir, { recursive: true, force: true });
      try { fs.unlinkSync(broken); } catch { /* 测完收 */ }
    }
  });

  it('显式 --model 时执行目录坏了也不挡（自动选才 fail-closed）', () => {
    const ledgerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dao-priopen-explicit-badcat-'));
    const broken = path.join(os.tmpdir(), `dao-priopen-broken-ok-${process.pid}-${Date.now()}.json`);
    fs.writeFileSync(broken, '{not json');
    try {
      const { r, payload } = runPrOpen(['--reviewer', 'gpt-5.6-luna'], {
        ledgerDir, envExtra: { DAO_EXECUTION_PROFILES: broken },
      });
      assert.equal(r.status, 0, JSON.stringify({ payload, stderr: r.stderr }));
      assert.equal(payload.model, 'claude-opus');
    } finally {
      fs.rmSync(ledgerDir, { recursive: true, force: true });
      try { fs.unlinkSync(broken); } catch { /* 测完收 */ }
    }
  });
});
