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

  it('① 红时不调 pr merge（调用序列里没有它）', async () => {
    const { execMerge } = await CMD;
    const { RED } = await HC;
    const { calls, run } = spyRun();
    const r = execMerge(
      { pr: 1234, why: '判绿可合' },
      { say: silent, run, judge: () => ({ state: RED, detail: '本树切自旧 origin/master' }) },
    );
    assert.equal(r.blocked, true);
    assert.equal(r.gate, RED);
    assert.equal(r.calls.length, 0);
    assert.ok(!calls.some((c) => /pr merge/.test(c)), `① 红仍调了 pr merge：${calls.join(' | ')}`);
    assert.ok(!calls.some((c) => /pr-sync-labels/.test(c)), '闸没过就不该动手');
  });

  it('① 没查成同样不合，不是「通」', async () => {
    const { execMerge } = await CMD;
    const { UNKNOWN } = await HC;
    const { calls, run } = spyRun();
    const r = execMerge(
      { pr: 1234 },
      { say: silent, run, judge: () => ({ state: UNKNOWN, detail: '拉不到远端' }) },
    );
    assert.equal(r.blocked, true);
    assert.equal(r.gate, UNKNOWN);
    assert.ok(!calls.some((c) => /pr merge/.test(c)));
  });

  it('① 通才走 pr merge，且 merge 在 sync-labels 之后', async () => {
    const { execMerge } = await CMD;
    const { OK } = await HC;
    const { calls, run } = spyRun();
    const r = execMerge(
      { pr: 1234 },
      { say: silent, run, judge: () => ({ state: OK, detail: '基底含最新 origin/master' }) },
    );
    assert.equal(r.ok, true);
    assert.equal(r.blocked, undefined);
    const mergeAt = calls.findIndex((c) => /pr merge/.test(c));
    const syncAt = calls.findIndex((c) => /pr-sync-labels/.test(c));
    assert.notEqual(mergeAt, -1, '通了必须真调 pr merge');
    assert.notEqual(syncAt, -1, '通了必须先同步 label');
    assert.equal(syncAt < mergeAt, true, 'label 同步必须在 merge 之前');
  });

  it('判别力：把 ① 从 merge 档拿掉，上面那条「① 红就不合」必须当场红', async () => {
    const { GATES } = await HC;
    assert.deepEqual(GATES.merge.advisory, [],
      'merge 档若把 ① 放进 advisory，execMerge 会在 ① 红时仍去 pr merge——那正是本单要防的');
    assert.deepEqual(GATES.handoff.advisory, ['①']);
  });
});

describe('#1117 审官任务书不许拿 ① 当交卷红', () => {
  const BOOKS = [
    'host/skills/dispatch/templates/reviewer-book-mirasim.md',
    'host/skills/dispatch/templates/reviewer-book.md',
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
