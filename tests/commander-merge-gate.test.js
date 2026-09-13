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
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const CMD = import('file://' + path.join(REPO, 'scripts', 'commander.mjs').replace(/\\/g, '/'));
const HC = import('file://' + path.join(REPO, 'scripts', 'lib', 'handoff-check.mjs').replace(/\\/g, '/'));

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
  function spyRun() {
    const calls = [];
    const run = (argv) => {
      calls.push(argv.join(' '));
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
      { pr: 1234, why: '判绿可合' },
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
      { pr: 1234 },
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
      { pr: 1234 },
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
    return { calls, run: (argv) => { calls.push(argv.join(' ')); return { ok: true, out: '' }; } };
  }

  it('合并成功 ⇒ 记终态，且带上为什么合的', async () => {
    const { execMerge } = await CMD;
    const { OK } = await HC;
    const { run } = runOk();
    const seen = [];
    const r = execMerge({ pr: 1234, why: '判绿可合' },
      { say: silent, run, judge: () => ({ state: OK }), ledgerClose: (a) => { seen.push(a); return { ok: true }; } });
    assert.equal(r.ok, true);
    assert.equal(seen.length, 1, '合并成功必须记一次终态  →  ' + JSON.stringify(seen));
    assert.equal(seen[0].pr, 1234);
    assert.equal(seen[0].why, '判绿可合', '归因要带 why——⑰ 之外还要能回答「这单为什么合了」');
  });

  it('合并失败 ⇒ 不记终态（失败路径不是终态）', async () => {
    const { execMerge } = await CMD;
    const { OK } = await HC;
    const run = (argv) => (argv.includes('merge') ? { ok: false, error: 'boom' } : { ok: true, out: '' });
    let called = 0;
    const r = execMerge({ pr: 1234 }, { say: silent, run, judge: () => ({ state: OK }), ledgerClose: () => { called += 1; return {}; } });
    assert.equal(r.ok, false);
    assert.equal(called, 0, '合并没成不许记成功终态  →  ' + called);
  });

  it('dry-run ⇒ 不记终态', async () => {
    const { execMerge } = await CMD;
    let called = 0;
    const r = execMerge({ pr: 1234 }, { dryRun: true, say: silent, run: runOk().run, ledgerClose: () => { called += 1; return {}; } });
    assert.equal(r.ok, true);
    assert.equal(called, 0, 'dry-run 只打印，不许写账本');
  });

  it('写账本崩了不许把合并判成失败（合并已经发生了，回滚不了）', async () => {
    const { execMerge } = await CMD;
    const { OK } = await HC;
    const { run } = runOk();
    const r = execMerge({ pr: 1234 }, { say: silent, run, judge: () => ({ state: OK }),
      ledgerClose: () => { throw new Error('账本目录只读'); } });
    assert.equal(r.ok, true, '账本写不了是 ⑰ 的事，不是合并失败  →  ' + JSON.stringify({ ok: r.ok, error: r.error }));
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
  function runWhere(failOn) {
    const calls = [];
    const run = (argv) => {
      const s = argv.join(' ');
      calls.push(s);
      return failOn && s.includes(failOn)
        ? { ok: false, error: `${failOn} 故意失败` }
        : { ok: true, out: '' };
    };
    return { calls, run };
  }

  it('打标签失败仍要真合并（#1143 的形状）', async () => {
    const { execMerge } = await CMD;
    const { calls, run } = runWhere('pr-sync-labels');
    const r = execMerge({ pr: 1143, why: '判绿可合' }, { say: silent, run, ledgerClose: noLedger, judge: () => ({ state: 'ok' }) });
    assert.equal(r.ok, true, '记账失败不该让整张 PR 卡住  →  ' + JSON.stringify(r));
    assert.ok(calls.some((c) => /pr merge/.test(c)), '②必须跑到：' + calls.join(' | '));
    assert.equal(r.failed.length, 1, '失败要报出来（不是静默吞）  →  ' + JSON.stringify(r.failed));
    assert.ok(/pr-sync-labels/.test(r.failed[0].step), '要点名是哪一步：' + r.failed[0].step);
    assert.equal(r.failed[0].error, 'pr-sync-labels 故意失败', '要带原错误，不是「记账失败」四个字');
  });

  it('关单失败也算记账：PR 已经合了，不许报成没合', async () => {
    const { execMerge } = await CMD;
    const { calls, run } = runWhere('close-issues');
    const r = execMerge({ pr: 1143 }, { say: silent, run, ledgerClose: noLedger, judge: () => ({ state: 'ok' }) });
    assert.equal(r.ok, true, 'PR 已合，关单没成是另一件事  →  ' + JSON.stringify(r));
    assert.ok(calls.some((c) => /pr merge/.test(c)));
    assert.equal(r.failed.length, 1, '关单失败要进 failed');
  });

  it('真正的合并失败仍是失败（门没被这次放宽拆掉）', async () => {
    const { execMerge } = await CMD;
    const { calls, run } = runWhere('pr merge');
    const r = execMerge({ pr: 1143 }, { say: silent, run, ledgerClose: noLedger, judge: () => ({ state: 'ok' }) });
    assert.equal(r.ok, false, 'pr merge 失败必须判失败  →  ' + JSON.stringify(r));
    assert.equal(r.error, 'pr merge 故意失败');
    assert.ok(!calls.some((c) => /close-issues/.test(c)), '合并没成不该去关单（顺序依赖还在）');
  });

  it('打标必须在 merge 之前——合并后 PR 关了，标签就补不上（战绩会缺这张）', async () => {
    const { execMerge } = await CMD;
    const { calls, run } = runWhere(null);
    execMerge({ pr: 1143 }, { say: silent, run, ledgerClose: noLedger, judge: () => ({ state: 'ok' }) });
    const syncAt = calls.findIndex((c) => /pr-sync-labels/.test(c));
    const mergeAt = calls.findIndex((c) => /pr merge/.test(c));
    assert.notEqual(syncAt, -1, 'label 仍要尝试同步');
    assert.equal(syncAt < mergeAt, true, '顺序不许因为放宽而颠倒：' + calls.join(' | '));
  });

  it('全记账成功时 failed 为空（别把成功也报成有失败）', async () => {
    const { execMerge } = await CMD;
    const { run } = runWhere(null);
    const r = execMerge({ pr: 1143 }, { say: silent, run, ledgerClose: noLedger, judge: () => ({ state: 'ok' }) });
    assert.deepEqual(r.failed, []);
    assert.equal(r.ok, true);
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
