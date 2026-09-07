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
