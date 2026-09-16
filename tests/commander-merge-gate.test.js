// #1117 合并闸：① 基底含最新 master 从交卷时刻挪到合并时刻。
//
// 这套测试要证的是**采事实那一层没把三态压成两态**。判据本身在
// scripts/lib/handoff-check.mjs 里已经被 tests/handoff-check.test.js 钉死，这里不重复；
// 这里只喂假的 run()，钉住 commander 侧三件容易做错的事：
//   · 「不是祖先」（该红）和「git 跑不起来」（该没查成）在 runCmd 里长得一模一样（都是 !ok），
//     区分不开就会把「没查成」当成「不是祖先」判红，或者反过来放行。
//   · 拉不到远端不许当成「基底是新的」——那只证得了「比缓存新」。
//   · 查不到 PR 的 head 分支名是没查成，不是通过。

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const CMD = import('file://' + path.join(REPO, 'scripts', 'commander.mjs').replace(/\\/g, '/'));
const HC = import('file://' + path.join(REPO, 'scripts', 'lib', 'handoff-check.mjs').replace(/\\/g, '/'));
const MERGE_HEAD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
function prViewOut(head = MERGE_HEAD, number = 1234) {
  return JSON.stringify({
    number, state: 'OPEN', title: 'x', body: '',
    headRefOid: head, isDraft: false, mergeable: 'MERGEABLE',
    statusCheckRollup: [], reviews: [],
  });
}
function mergeAction(over = {}) {
  return { pr: 1234, head: MERGE_HEAD, why: '判绿可合', ...over };
}

/**
 * 假 run：按 argv 的前几个词查表。表里没有的命令一律抛——
 * 静默回 ok 会让测试在「判据多问了一条 git」时假绿。
 */
function fakeRun(table) {
  return (argv) => {
    const key = argv.join(' ');
    for (const [pat, val] of Object.entries(table)) {
      if (key.startsWith(pat)) return val;
    }
    throw new Error(`假 run 没备这条命令：${key}`);
  };
}

const OKOUT = (out) => ({ ok: true, out });
const FAIL = (error) => ({ ok: false, error });

/** 各条命令都成功的底表；每个用例只覆盖它关心的那一条。 */
function baseTable(extra = {}) {
  return {
    'node scripts/gh-as.mjs marshal -- pr view 1234 --json number,state': OKOUT(prViewOut(MERGE_HEAD, 1234)),
    'node scripts/gh-as.mjs marshal -- pr view 1143 --json number,state': OKOUT(prViewOut(MERGE_HEAD, 1143)),
    'node scripts/gh-as.mjs marshal -- pr view': OKOUT('feature-branch\n'),
    'git fetch --quiet origin': OKOUT(''),
    'git rev-parse --verify --quiet origin/feature-branch': OKOUT('abc1234abc1234abc1234abc1234abc1234abcd\n'),
    'git rev-parse --verify --quiet origin/master': OKOUT('def5678def5678def5678def5678def5678defa\n'),
    'git merge-base --is-ancestor': OKOUT(''),
    'git merge-base origin/master': OKOUT('def5678\n'),
    'git log --format': OKOUT(''),
    'git diff --name-only': OKOUT(''),
    ...extra,
  };
}

describe('#1117 合并闸：judgeMergeFreshness 采事实', () => {
  it('基底含最新 master → 通', async () => {
    const { judgeMergeFreshness } = await CMD;
    const { OK } = await HC;
    const r = judgeMergeFreshness(1234, { run: fakeRun(baseTable()) });
    assert.equal(r.state, OK);
  });

  it('不是祖先 → 红，并报出差了哪几个提交', async () => {
    const { judgeMergeFreshness } = await CMD;
    const { RED } = await HC;
    const r = judgeMergeFreshness(1234, {
      run: fakeRun(baseTable({
        // --is-ancestor 退出 1 = 不是祖先；探针 merge-base 本身跑得通
        'git merge-base --is-ancestor': FAIL('exit 1'),
        'git log --format': OKOUT('9139c6f59\t噪音单的根因\n789d10803\t删影响地图\n'),
        'git diff --name-only': OKOUT('scripts/escalate.mjs\n'),
      })),
    });
    assert.equal(r.state, RED);
    assert.match(r.detail, /9139c6f/);
    assert.match(r.detail, /escalate\.mjs/);
  });

  it('git 跑不起来 ≠ 不是祖先：探针也失败时判没查成，不判红', async () => {
    const { judgeMergeFreshness } = await CMD;
    const { UNKNOWN } = await HC;
    const r = judgeMergeFreshness(1234, {
      run: fakeRun(baseTable({
        'git merge-base --is-ancestor': FAIL('exit 128: not a git repository'),
        'git merge-base origin/master': FAIL('exit 128: not a git repository'),
      })),
    });
    assert.equal(r.state, UNKNOWN);
  });

  it('拉不到远端时不许判通：是祖先但没 fetch 成 → 没查成', async () => {
    const { judgeMergeFreshness } = await CMD;
    const { UNKNOWN } = await HC;
    const r = judgeMergeFreshness(1234, {
      run: fakeRun(baseTable({ 'git fetch --quiet origin': FAIL('无法连接 origin') })),
    });
    assert.equal(r.state, UNKNOWN);
    assert.match(r.detail, /没拉到远端/);
  });

  it('查不到 PR 的 head 分支名 → 没查成，不是通过', async () => {
    const { judgeMergeFreshness } = await CMD;
    const { UNKNOWN } = await HC;
    const r = judgeMergeFreshness(1234, {
      run: fakeRun(baseTable({ 'node scripts/gh-as.mjs marshal -- pr view': FAIL('gh: 404') })),
    });
    assert.equal(r.state, UNKNOWN);
    assert.match(r.detail, /head 分支名/);
  });

  it('解不出 origin/master → 没查成', async () => {
    const { judgeMergeFreshness } = await CMD;
    const { UNKNOWN } = await HC;
    const r = judgeMergeFreshness(1234, {
      run: fakeRun(baseTable({ 'git rev-parse --verify --quiet origin/master': FAIL('不存在') })),
    });
    assert.equal(r.state, UNKNOWN);
  });
});

describe('#1117 合并闸：execMerge 调用序列', () => {
  function spyRun(head = MERGE_HEAD, number = 1234) {
    const calls = [];
    const run = (argv) => {
      const s = argv.join(' ');
      calls.push(s);
      if (/pr view/.test(s) && /headRefOid/.test(s)) return { ok: true, out: prViewOut(head, number) };
      if (/pr view/.test(s) && /headRefName/.test(s)) return { ok: true, out: 'feature-branch\n' };
      return { ok: true, out: '' };
    };
    return { calls, run };
  }
  const silent = () => {};
  // execMerge 现在还会写 job.closed（#581 的差集靠它）。测试一律注入替身：
  // 不注入就会往**真账本**里写一条 gh-pr-<测试号> 的假终态，污染 ⑰ 的对照集合。
  const noLedger = () => ({ worker: { ok: true }, reviewer: { ok: true } });

  it('① 红仍 squash（落后 ≠ 冲突）', async () => {
    const { execMerge } = await CMD;
    const { RED } = await HC;
    const { calls, run } = spyRun();
    const r = execMerge(
      mergeAction(),
      { say: silent, run, ledgerClose: noLedger, judge: () => ({ state: RED, detail: '本树切自旧 origin/master' }) },
    );
    assert.equal(r.ok, true);
    assert.equal(r.blocked, undefined);
    assert.ok(calls.some((c) => /pr merge/.test(c)), `① 红应仍 squash：${calls.join(' | ')}`);
    assert.ok(calls.some((c) => /pr-sync-labels/.test(c)), 'squash 前仍要同步 label');
  });

  it('① 没查成同样不拦 squash', async () => {
    const { execMerge } = await CMD;
    const { UNKNOWN } = await HC;
    const { calls, run } = spyRun();
    const r = execMerge(
      mergeAction(),
      { say: silent, run, ledgerClose: noLedger, judge: () => ({ state: UNKNOWN, detail: '拉不到远端' }) },
    );
    assert.equal(r.ok, true);
    assert.ok(calls.some((c) => /pr merge/.test(c)));
  });

  it('① 通才走 pr merge，且 merge 在 sync-labels 之后', async () => {
    const { execMerge } = await CMD;
    const { OK } = await HC;
    const { calls, run } = spyRun();
    const r = execMerge(
      mergeAction(),
      { say: silent, run, ledgerClose: noLedger, judge: () => ({ state: OK, detail: '基底含最新 origin/master' }) },
    );
    assert.equal(r.ok, true);
    assert.equal(r.blocked, undefined);
    const mergeAt = calls.findIndex((c) => /pr merge/.test(c));
    const syncAt = calls.findIndex((c) => /pr-sync-labels/.test(c));
    assert.notEqual(mergeAt, -1, '通了必须真调 pr merge');
    assert.notEqual(syncAt, -1, '通了必须先同步 label');
    assert.equal(syncAt < mergeAt, true, 'label 同步必须在 merge 之前');
  });

  it('squash 档 ① 只报不判（落后不拦合入）', async () => {
    const { GATES } = await HC;
    assert.deepEqual(GATES.merge.advisory, ['①']);
    assert.deepEqual(GATES.handoff.advisory, ['①']);
  });
});

// 合并后补 job.closed（#581 的差集判据 / dao-check ⑰ 读它）。
// 2026-09-13 实咬：这条链断了六周——写它的 flow.mjs 被 #807 整段删除，写口没接回来，
// 账本里 job.dispatch 一路在写而 job.closed 自 09-08 起 0 条，111 张已合并带标 PR 对不上。
describe('#581 合并后补 job.closed', () => {
  const silent = () => {};
  function runOk() {
    const calls = [];
    return {
      calls,
      run: (argv) => {
        const s = argv.join(' ');
        calls.push(s);
        if (/pr view/.test(s) && /headRefOid/.test(s)) return { ok: true, out: prViewOut() };
        return { ok: true, out: '' };
      },
    };
  }

  it('合并成功 ⇒ 记终态，且带上为什么合的', async () => {
    const { execMerge } = await CMD;
    const { OK } = await HC;
    const { run } = runOk();
    const seen = [];
    const r = execMerge(mergeAction(),
      { say: silent, run, judge: () => ({ state: OK }), ledgerClose: (a) => { seen.push(a); return { ok: true }; } });
    assert.equal(r.ok, true);
    assert.equal(seen.length, 1, '合并成功必须记一次终态  →  ' + JSON.stringify(seen));
    assert.equal(seen[0].pr, 1234);
    assert.equal(seen[0].why, '判绿可合', '归因要带 why——⑰ 之外还要能回答「这单为什么合了」');
  });

  it('合并失败 ⇒ 不记终态（失败路径不是终态）', async () => {
    const { execMerge } = await CMD;
    const { OK } = await HC;
    const run = (argv) => {
      const s = argv.join(' ');
      if (/pr view/.test(s) && /headRefOid/.test(s)) return { ok: true, out: prViewOut() };
      return argv.includes('merge') ? { ok: false, error: 'boom' } : { ok: true, out: '' };
    };
    let called = 0;
    const r = execMerge(mergeAction(), { say: silent, run, judge: () => ({ state: OK }), ledgerClose: () => { called += 1; return {}; } });
    assert.equal(r.ok, false);
    assert.equal(called, 0, '合并没成不许记成功终态  →  ' + called);
  });

  it('dry-run ⇒ 不记终态', async () => {
    const { execMerge } = await CMD;
    let called = 0;
    const r = execMerge(mergeAction(), { dryRun: true, say: silent, run: runOk().run, ledgerClose: () => { called += 1; return {}; } });
    assert.equal(r.ok, true);
    assert.equal(called, 0, 'dry-run 只打印，不许写账本');
  });

  it('写账本崩了不许把合并判成失败（合并已经发生了，回滚不了）', async () => {
    const { execMerge } = await CMD;
    const { OK } = await HC;
    const { run } = runOk();
    const r = execMerge(mergeAction(), { say: silent, run, judge: () => ({ state: OK }),
      ledgerClose: () => { throw new Error('账本目录只读'); } });
    assert.equal(r.ok, true, '账本写不了是 ⑰ 的事，不是合并失败  →  ' + JSON.stringify({ ok: r.ok, error: r.error }));
  });

  it('execMerge 把 run 传给 ledgerClose，合并后能重读 reviews', async () => {
    const { execMerge } = await CMD;
    const { OK } = await HC;
    const { run } = runOk();
    let seen = null;
    execMerge(mergeAction(), {
      say: silent, run, judge: () => ({ state: OK }),
      ledgerClose: (a) => { seen = a; return { ok: true }; },
    });
    assert.equal(typeof seen.run, 'function');
    assert.equal(seen.pr, 1234);
  });
});

const JOB = import('file://' + path.join(REPO, 'scripts', 'lib', 'ledger-job.mjs').replace(/\\/g, '/'));
const DJ = import('file://' + path.join(REPO, 'scripts', 'lib', 'dianjiangtai-core.mjs').replace(/\\/g, '/'));
const CAL = import('file://' + path.join(REPO, 'scripts', 'calibrate.mjs').replace(/\\/g, '/'));
const SCHEMA = JSON.parse(fs.readFileSync(path.join(REPO, 'schemas', 'events.schema.json'), 'utf8'));

function loadDirEvents(dir) {
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) =>
    JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
}

describe('#1228 合并后 job.closed 归真实模型、不伪造零返工', () => {
  const silent = () => {};
  const ts = '2026-09-14T12:00:00+08:00';

  function tempCtx() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'closed-1228-'));
    return { dir, schema: SCHEMA, machine: 'TEST-1228' };
  }

  it('dispatch=gpt-5.6-luna 的成功合并，能力账样本模型是 luna 不是 commander', async () => {
    const { recordJobClosed } = await CMD;
    const { writeJobDispatch, workerJobId } = await JOB;
    const { buildSamples } = await DJ;
    const ctx = tempCtx();
    try {
      const d = writeJobDispatch({
        ...ctx, ts, jobId: workerJobId(12281), model: 'gpt-5.6-luna', identity: '工人',
        workType: '写码', terminal: 'test', prNumber: 12281,
      });
      assert.equal(d.ok, true, d.error);
      const out = recordJobClosed({
        pr: 12281, why: '判绿可合', say: silent, ctx,
        reviews: [{ state: 'APPROVED', body: '判定：绿' }],
      });
      assert.equal(out['工人'].ok, true, out['工人'].error);
      assert.equal(out['工人'].event.merged_by, 'gpt-5.6-luna');
      assert.equal(out['审官'].skipped, 'no-dispatch');

      const { samples } = buildSamples({
        events: loadDirEvents(ctx.dir),
        at: '2099-01-01T00:00:00+08:00',
        registryByModel: {
          'gpt-5.6-luna': { version: 'gpt-5.6-luna' },
          commander: { version: 'commander' },
        },
      });
      const hit = samples.filter((s) => s.jobId === 'gh-pr-12281');
      assert.equal(hit.length, 1);
      assert.equal(hit[0].model, 'gpt-5.6-luna');
      assert.equal(samples.some((s) => s.model === 'commander'), false);
    } finally {
      fs.rmSync(ctx.dir, { recursive: true, force: true });
    }
  });

  it('审官 dispatch 的 merged_by 是审官模型，不是 reviewer', async () => {
    const { recordJobClosed } = await CMD;
    const { writeJobDispatch, workerJobId, reviewerJobId } = await JOB;
    const ctx = tempCtx();
    try {
      writeJobDispatch({
        ...ctx, ts, jobId: workerJobId(12282), model: 'gpt-5.6-luna', identity: '工人',
        workType: '写码', terminal: 'test', prNumber: 12282,
      });
      writeJobDispatch({
        ...ctx, ts, jobId: reviewerJobId(12282), model: 'gpt-5.6-sol', identity: '审官',
        workType: '审查', terminal: 'test', prNumber: 12282,
      });
      const out = recordJobClosed({
        pr: 12282, why: '判绿可合', say: silent, ctx,
        reviews: [{ state: 'APPROVED' }],
      });
      assert.equal(out['审官'].ok, true, out['审官'].error);
      assert.equal(out['审官'].event.merged_by, 'gpt-5.6-sol');
      assert.equal(out['工人'].event.merged_by, 'gpt-5.6-luna');
    } finally {
      fs.rmSync(ctx.dir, { recursive: true, force: true });
    }
  });

  it('先红后绿写入 worker_rework=1，不是零返工', async () => {
    const { recordJobClosed } = await CMD;
    const { writeJobDispatch, workerJobId } = await JOB;
    const ctx = tempCtx();
    try {
      writeJobDispatch({
        ...ctx, ts, jobId: workerJobId(12283), model: 'grok-4.6', identity: '工人',
        workType: '写码', terminal: 'test', prNumber: 12283,
      });
      const out = recordJobClosed({
        pr: 12283, why: '判绿可合', say: silent, ctx,
        reviews: [
          { state: 'CHANGES_REQUESTED', body: '判定：红 2 项' },
          { state: 'APPROVED', body: '判定：绿' },
        ],
      });
      const ev = out['工人'].event;
      assert.equal(out['工人'].ok, true, out['工人'].error);
      assert.equal(ev.rework, true);
      assert.equal(ev.worker_rework, 1);
      assert.equal(ev.red_flags, 1);
      assert.equal(ev.verdict_rounds, 2);
      assert.notEqual(ev.attribution_source, 'unscanned');
    } finally {
      fs.rmSync(ctx.dir, { recursive: true, force: true });
    }
  });

  it('reviews 没查成不伪造零返工', async () => {
    const { recordJobClosed } = await CMD;
    const { writeJobDispatch, workerJobId } = await JOB;
    const { reworkFromClosed } = await CAL;
    const ctx = tempCtx();
    try {
      writeJobDispatch({
        ...ctx, ts, jobId: workerJobId(12284), model: 'grok-4.6', identity: '工人',
        workType: '写码', terminal: 'test', prNumber: 12284,
      });
      const out = recordJobClosed({
        pr: 12284, why: '判绿可合', say: silent, ctx,
        reviewsUnscanned: true, reviewsError: 'gh 失败',
      });
      const ev = out['工人'].event;
      assert.equal(out['工人'].ok, true, out['工人'].error);
      assert.equal(ev.attribution_source, 'unscanned');
      assert.equal(ev.worker_rework, undefined);
      assert.equal(ev.red_flags, undefined);
      assert.equal(reworkFromClosed(ev), null);
    } finally {
      fs.rmSync(ctx.dir, { recursive: true, force: true });
    }
  });

  it('无 dispatch 的合并链 merged_by=unknown，不写 commander', async () => {
    const { recordJobClosed } = await CMD;
    const ctx = tempCtx();
    try {
      const out = recordJobClosed({
        pr: 12285, why: '判绿可合', say: silent, ctx,
        reviews: [{ state: 'APPROVED' }],
      });
      assert.equal(out['工人'].ok, true, out['工人'].error);
      assert.equal(out['工人'].event.merged_by, 'unknown');
      assert.equal(out['审官'].skipped, 'no-dispatch');
    } finally {
      fs.rmSync(ctx.dir, { recursive: true, force: true });
    }
  });

  it('gh 读 reviews 失败走 unscanned，不伪造 rework:false 当已知零', async () => {
    const { recordJobClosed } = await CMD;
    const { writeJobDispatch, workerJobId } = await JOB;
    const { reworkFromClosed } = await CAL;
    const ctx = tempCtx();
    try {
      writeJobDispatch({
        ...ctx, ts, jobId: workerJobId(12286), model: 'grok-4.6', identity: '工人',
        workType: '写码', terminal: 'test', prNumber: 12286,
      });
      const out = recordJobClosed({
        pr: 12286, why: '判绿可合', say: silent, ctx,
        run: () => ({ ok: false, error: 'gh down' }),
      });
      const ev = out['工人'].event;
      assert.equal(ev.attribution_source, 'unscanned');
      assert.equal(reworkFromClosed(ev), null);
    } finally {
      fs.rmSync(ctx.dir, { recursive: true, force: true });
    }
  });

  it('账本含坏 JSON + 无审官 dispatch 不产生审官 job.closed，归因保持 unscanned', async () => {
    const { recordJobClosed } = await CMD;
    const { writeJobDispatch, workerJobId, reviewerJobId } = await JOB;
    const { reworkFromClosed } = await CAL;
    const ctx = tempCtx();
    try {
      const d = writeJobDispatch({
        ...ctx, ts, jobId: workerJobId(19002), model: 'grok-4.6', identity: '工人',
        workType: '写码', terminal: 'test', prNumber: 19002,
      });
      assert.equal(d.ok, true, d.error);
      fs.writeFileSync(path.join(ctx.dir, 'bad.json'), '{not json');
      // reviews 已读到、且只有 APPROVED：完整账本时会写成 inferred + worker_rework=0。
      const out = recordJobClosed({
        pr: 19002, why: '判绿可合', say: silent, ctx,
        reviews: [{ state: 'APPROVED', body: '判定：绿' }],
      });
      assert.equal(out['审官'].skipped, 'no-dispatch');
      assert.equal(out['审官'].ok, undefined);
      assert.equal(out['工人'].ok, true, out['工人'].error);
      assert.equal(out['工人'].event.attribution_source, 'unscanned');
      assert.equal(out['工人'].event.worker_rework, undefined);
      assert.notEqual(out['工人'].event.attribution_source, 'inferred');
      assert.equal(reworkFromClosed(out['工人'].event), null);

      const closed = fs.readdirSync(ctx.dir).filter((f) => f.endsWith('.json')).flatMap((f) => {
        try { return [JSON.parse(fs.readFileSync(path.join(ctx.dir, f), 'utf8'))]; }
        catch { return []; }
      }).filter((e) => e && e.type === 'job.closed');
      const reviewerId = reviewerJobId(19002);
      assert.equal(closed.filter((e) => e.job_id === reviewerId).length, 0);
      assert.equal(closed.filter((e) => e.job_id === workerJobId(19002)).length, 1);
    } finally {
      fs.rmSync(ctx.dir, { recursive: true, force: true });
    }
  });
});

// #1235：记账步骤不许当门。实测 #1143 判绿可合、CI 绿、MERGEABLE，只因账本里没有
// job.dispatch（日报/升级链产生的 PR 都没有）打不上 label，在第①步 return，②pr merge
// 根本不跑，24 小时撞 38 次、白挂一天——一个纯记账动作挡住了一次真实合并。
describe('#1235 merge 记账步骤失败不挡合并', () => {
  const silent = () => {};
  // 本分支默认会写 job.closed；不注入就会往真账本塞 gh-pr-1143 的假终态，污染 ⑰。
  const noLedger = () => ({ worker: { ok: true }, reviewer: { ok: true } });
  /** 按 argv 子串决定成功/失败的假 run，用来构造「只有某一步坏」的场面 */
  function runWhere(failOn, head = MERGE_HEAD, number = 1143) {
    const calls = [];
    const run = (argv) => {
      const s = argv.join(' ');
      calls.push(s);
      if (/pr view/.test(s) && /headRefOid/.test(s)) return { ok: true, out: prViewOut(head, number) };
      if (failOn && s.includes(failOn)) return { ok: false, error: `${failOn} 故意失败` };
      return { ok: true, out: '' };
    };
    return { calls, run };
  }

  it('打标签失败仍要真合并（#1143 的形状）', async () => {
    const { execMerge } = await CMD;
    const { calls, run } = runWhere('pr-sync-labels');
    const r = execMerge({ pr: 1143, head: MERGE_HEAD, why: '判绿可合' }, { say: silent, run, ledgerClose: noLedger, judge: () => ({ state: 'ok' }) });
    assert.equal(r.ok, true, '记账失败不该让整张 PR 卡住  →  ' + JSON.stringify(r));
    assert.ok(calls.some((c) => /pr merge/.test(c)), '②必须跑到：' + calls.join(' | '));
    assert.equal(r.failed.length, 1, '失败要报出来（不是静默吞）  →  ' + JSON.stringify(r.failed));
    assert.ok(/pr-sync-labels/.test(r.failed[0].step), '要点名是哪一步：' + r.failed[0].step);
    assert.equal(r.failed[0].error, 'pr-sync-labels 故意失败', '要带原错误，不是「记账失败」四个字');
  });

  it('关单失败也算记账：PR 已经合了，不许报成没合', async () => {
    const { execMerge } = await CMD;
    const { calls, run } = runWhere('close-issues');
    const r = execMerge({ pr: 1143, head: MERGE_HEAD }, { say: silent, run, ledgerClose: noLedger, judge: () => ({ state: 'ok' }) });
    assert.equal(r.ok, true, 'PR 已合，关单没成是另一件事  →  ' + JSON.stringify(r));
    assert.ok(calls.some((c) => /pr merge/.test(c)));
    assert.equal(r.failed.length, 1, '关单失败要进 failed');
  });

  it('真正的合并失败仍是失败（门没被这次放宽拆掉）', async () => {
    const { execMerge } = await CMD;
    const { calls, run } = runWhere('pr merge');
    const r = execMerge({ pr: 1143, head: MERGE_HEAD }, { say: silent, run, ledgerClose: noLedger, judge: () => ({ state: 'ok' }) });
    assert.equal(r.ok, false, 'pr merge 失败必须判失败  →  ' + JSON.stringify(r));
    assert.equal(r.error, 'pr merge 故意失败');
    assert.ok(!calls.some((c) => /close-issues/.test(c)), '合并没成不该去关单（顺序依赖还在）');
  });

  it('打标必须在 merge 之前——合并后 PR 关了，标签就补不上（战绩会缺这张）', async () => {
    const { execMerge } = await CMD;
    const { calls, run } = runWhere(null);
    execMerge({ pr: 1143, head: MERGE_HEAD }, { say: silent, run, ledgerClose: noLedger, judge: () => ({ state: 'ok' }) });
    const syncAt = calls.findIndex((c) => /pr-sync-labels/.test(c));
    const mergeAt = calls.findIndex((c) => /pr merge/.test(c));
    assert.notEqual(syncAt, -1, 'label 仍要尝试同步');
    assert.equal(syncAt < mergeAt, true, '顺序不许因为放宽而颠倒：' + calls.join(' | '));
  });

  it('全记账成功时 failed 为空（别把成功也报成有失败）', async () => {
    const { execMerge } = await CMD;
    const { run } = runWhere(null);
    const r = execMerge({ pr: 1143, head: MERGE_HEAD }, { say: silent, run, ledgerClose: noLedger, judge: () => ({ state: 'ok' }) });
    assert.deepEqual(r.failed, []);
    assert.equal(r.ok, true);
  });
});

describe('#1133 全路径 HEAD 锁', () => {
  const silent = () => {};
  const noLedger = () => ({ worker: { ok: true }, reviewer: { ok: true } });

  it('没有 approvalIssue 的 auto 路径也要带 --match-head-commit', async () => {
    const { execMerge } = await CMD;
    const calls = [];
    const run = (argv) => {
      const s = argv.join(' ');
      calls.push(s);
      if (/pr view/.test(s) && /headRefOid/.test(s)) return { ok: true, out: prViewOut() };
      return { ok: true, out: '' };
    };
    const r = execMerge(mergeAction(), { say: silent, run, ledgerClose: noLedger, judge: () => ({ state: 'ok' }) });
    assert.equal(r.ok, true, JSON.stringify(r));
    const merge = calls.find((c) => /pr merge/.test(c));
    assert.match(merge, /--match-head-commit/);
    assert.match(merge, new RegExp(MERGE_HEAD));
  });

  it('没带期望 HEAD → 拒绝合入', async () => {
    const { execMerge } = await CMD;
    const calls = [];
    const run = (argv) => { calls.push(argv.join(' ')); return { ok: true, out: '' }; };
    const r = execMerge({ pr: 1234, why: '判绿可合' }, { say: silent, run, judge: () => ({ state: 'ok' }) });
    assert.equal(r.ok, false);
    assert.match(r.error, /期望 HEAD/);
    assert.equal(calls.some((c) => /pr merge/.test(c)), false);
  });

  it('判定后 HEAD 改变 → 拒绝合入，不调 pr merge', async () => {
    const { execMerge } = await CMD;
    const calls = [];
    const run = (argv) => {
      const s = argv.join(' ');
      calls.push(s);
      if (/pr view/.test(s) && /headRefOid/.test(s)) {
        return { ok: true, out: prViewOut('b'.repeat(40)) };
      }
      return { ok: true, out: '' };
    };
    const r = execMerge(mergeAction(), { say: silent, run, judge: () => ({ state: 'ok' }) });
    assert.equal(r.ok, true);
    assert.equal(r.skipped, 'head-changed');
    assert.equal(calls.some((c) => /pr merge/.test(c)), false);
  });

  it('重读 HEAD 没查成 → 拒绝合入', async () => {
    const { execMerge } = await CMD;
    const run = (argv) => {
      const s = argv.join(' ');
      if (/pr view/.test(s) && /headRefOid/.test(s)) return { ok: false, error: 'timeout' };
      return { ok: true, out: '' };
    };
    const r = execMerge(mergeAction(), { say: silent, run, judge: () => ({ state: 'ok' }) });
    assert.equal(r.ok, false);
    assert.equal(r.unscanned, true);
  });
});

describe('#1133 runActions：merge skip 后不 land、不发已合并', () => {
  it('head-changed 后不执行配套 land 与「已自动合并」通知', async () => {
    const { runActions } = await CMD;
    const actions = [
      { kind: 'merge', pr: 1308, head: MERGE_HEAD, why: '判绿可合' },
      { kind: 'land', why: '合并后收工清理' },
      { kind: 'notify-hub', pr: 1308, moment: 'merged', subject: 'PR #1308 已自动合并' },
    ];
    const seen = [];
    const log = [];
    runActions(actions, {
      exec: (a) => {
        seen.push(a.kind);
        if (a.kind === 'merge') return { ok: true, skipped: 'head-changed' };
        return { ok: true };
      },
      log,
    });
    assert.deepEqual(seen, ['merge'], `merge skip 后不得继续：${JSON.stringify(seen)}`);
    assert.equal(log.some((l) => /land 略/.test(l)), true);
    assert.equal(log.some((l) => /notify-hub 略/.test(l)), true);
    assert.equal(log.some((l) => /已自动合并/.test(l) && !/略/.test(l)), false);
  });

  it('approval-not-current 与 merge 失败同样拦配套收尾', async () => {
    const { runActions } = await CMD;
    for (const r of [{ ok: true, skipped: 'approval-not-current' }, { ok: false, error: 'merge failed' }]) {
      const seen = [];
      runActions([
        { kind: 'merge', pr: 77, head: MERGE_HEAD },
        { kind: 'land' },
        { kind: 'notify-hub', pr: 77, moment: 'merged', subject: 'PR #77 已自动合并' },
      ], { exec: (a) => { seen.push(a.kind); return a.kind === 'merge' ? r : { ok: true }; } });
      assert.deepEqual(seen, ['merge'], JSON.stringify({ r, seen }));
    }
  });

  it('真合入后配套 land 与通知照发；另一张 skip 的不殃及', async () => {
    const { runActions } = await CMD;
    const seen = [];
    runActions([
      { kind: 'merge', pr: 1, head: MERGE_HEAD },
      { kind: 'land' },
      { kind: 'notify-hub', pr: 1, moment: 'merged', subject: 'PR #1 已自动合并' },
      { kind: 'merge', pr: 2, head: MERGE_HEAD },
      { kind: 'land' },
      { kind: 'notify-hub', pr: 2, moment: 'merged', subject: 'PR #2 已自动合并' },
    ], {
      exec: (a) => {
        seen.push(`${a.kind}:${a.pr || ''}`);
        if (a.kind === 'merge' && a.pr === 2) return { ok: true, skipped: 'head-changed' };
        return { ok: true };
      },
    });
    assert.deepEqual(seen, ['merge:1', 'land:', 'notify-hub:1', 'merge:2']);
  });

  it('列表里没有 merge 时 land 仍跑（派工夹具反证）', async () => {
    const { runActions } = await CMD;
    const seen = [];
    runActions(
      [{ kind: 'dispatch', issue: 1 }, { kind: 'notify-hub', issue: 1 }, { kind: 'land' }],
      { exec: (a) => { seen.push(a.kind); return { ok: true }; } },
    );
    assert.deepEqual(seen, ['dispatch', 'notify-hub', 'land']);
  });
});

describe('#1117 审官任务书不许拿 ① 当交卷红', () => {
  const BOOKS = [
    'host/skills/dispatch/templates/reviewer-book-mirasim.md',
    'host/skills/dispatch/review-standard.md',
  ];
  for (const rel of BOOKS) {
    it(`${rel} 写明 ① 不许当交卷红`, () => {
      const text = fs.readFileSync(path.join(REPO, rel), 'utf8');
      assert.match(text, /不许拿它判红/,
        `${rel} 没写「不许拿它判红」——审官会按旧口径把基底过期当红项`);
      assert.doesNotMatch(text, /交卷闸四条全绿才算通过/,
        `${rel} 还残留「交卷闸四条全绿」——那正是本单要拆掉的活锁口径`);
    });
  }
});
