// tests/inflight-count.test.js —— 在途数的新判据（#1007 二期）
//
// 换掉了什么，为什么（原来在 admission.mjs 的 countLiveWorkers /
// countLiveWorkersFromSessionFacts / classifyMirasimTreePath / isReviewerCard，整层删）：
//
//  1. 分母是错的——isReviewerCard 把审官树跳过，可审官吃同一份 CPU 和内存。
//     2026-09-06 实测 137 个会话里审官 53 个；漏掉一半分母，算出来的余量必然偏大。
//  2. 判据是错的——靠 mirasim 的 record.json 推活性，而它的 runPid 是 server 自己的 pid
//     （五条 running 记录全是 767216），updatedAt 也不随会话推进刷新。
//  3. 自己查自己——用 mirasim 的记账判「mirasim 有几个会话在跑」。
//
// 新判据只有一把尺：/proc 里进程的 cwd 落在哪棵树上，与租约闸同源。
// 本文件替下这三块被删测试的覆盖面（删掉保护而没有等价替代 = 净损失）。

const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const LEASE = import('file://' + path.join(__dirname, '..', 'scripts', 'lib', 'dispatch', 'lease.mjs').replace(/\\/g, '/'));

// 夹具用**显式给定**的树根，不读机器家目录——写死 /home/orca 只在这台机器绿
// （实测：本机 39/39 绿、CI 4 条红，因为 CI 跑在 runner 家目录下）。
const ROOT = '/fake-home/mirasim-worktrees';
const W = `${ROOT}/windsurf-dao`;

describe('busyTrees：一棵树算一个在途', () => {
  it('一棵树里十几个子进程只算一个（不按进程数）', async () => {
    const { busyTrees } = await LEASE;
    // 实测形状：一个会话会拉起 git / bash / node 一堆子进程
    const procs = [
      { pid: 1, comm: 'pi', cwd: `${W}/dao-982` },
      { pid: 2, comm: 'bash', cwd: `${W}/dao-982` },
      { pid: 3, comm: 'node', cwd: `${W}/dao-982` },
      { pid: 4, comm: 'git', cwd: `${W}/dao-982` },
    ];
    const got = busyTrees(procs, { root: ROOT });
    assert.equal(got.count, 1);
    assert.deepEqual(got.trees, [`${W}/dao-982`]);
  });

  // 这条是本次换判据的**核心**：审官必须算进分母。
  it('审官树照数不误', async () => {
    const { busyTrees } = await LEASE;
    const got = busyTrees([
      { pid: 1, comm: 'pi', cwd: `${W}/dao-982` },
      { pid: 2, comm: 'codex', cwd: `${W}/dao-review-pr-1018` },
      { pid: 3, comm: 'codex', cwd: `${W}/dao-review-pr-1071` },
    ], { root: ROOT });
    assert.equal(got.count, 3, '审官被漏掉的话分母就少一半');
    assert.equal(got.trees.includes(`${W}/dao-review-pr-1018`), true);
  });

  it('工作树根之外的进程不算（临时目录、baseline 树）', async () => {
    const { busyTrees } = await LEASE;
    const got = busyTrees([
      { pid: 1, comm: 'pi', cwd: `${W}/dao-982` },
      { pid: 2, comm: 'codex', cwd: '/tmp/dao-review-1064-baseline' },
      { pid: 3, comm: 'node', cwd: '/srv/projects/windsurf-dao' },
    ], { root: ROOT });
    assert.equal(got.count, 1);
  });

  // 光比 includes('mirasim-worktrees') 会把长得像的路径也算进来——前缀必须带斜杠。
  it('同名前缀的别的目录不算', async () => {
    const { busyTrees } = await LEASE;
    const got = busyTrees([
      { pid: 1, comm: 'pi', cwd: '/home/orca/mirasim-worktrees-fake/x' },
      { pid: 2, comm: 'pi', cwd: '/home/orca/mirasim-worktrees' },
    ], { root: ROOT });
    assert.equal(got.count, 0, '根目录本身和同名前缀目录都不是工作树');
  });

  it('根路径认 MIRASIM_WORKTREES，其次 ~/mirasim-worktrees（登记在 INDEX D 类）', async () => {
    const { worktreesRoot } = await LEASE;
    assert.equal(worktreesRoot('/home/orca'), process.env.MIRASIM_WORKTREES || '/home/orca/mirasim-worktrees');
  });

  it('一个进程都没有 → 0（这是查成了，不是没查成）', async () => {
    const { busyTrees } = await LEASE;
    const got = busyTrees([], { root: ROOT });
    assert.equal(got.ok, true);
    assert.equal(got.count, 0);
  });

  // 「没查成」当成 0 在途，闸就会以为机器全空、放开派——这正是要防的那件事。
  it('拿不到进程数组 → 没查成，不是 0 在途', async () => {
    const { busyTrees } = await LEASE;
    const got = busyTrees(null);
    assert.equal(got.ok, false);
    assert.equal(got.unscanned, true);
    assert.equal(got.count, undefined);
  });
});

describe('checkInFlight：读不到就收紧', () => {
  it('/proc 读不动 → ok:false（调用方按 fail-close 不派）', async () => {
    const { checkInFlight } = await LEASE;
    const got = checkInFlight({ io: { readdir: () => { throw new Error('EACCES'); } } });
    assert.equal(got.ok, false);
    assert.equal(got.unscanned, true);
  });

  it('mirasim 服务不在 → 查成了且 0 在途（一个会话也不可能在跑）', async () => {
    const { checkInFlight } = await LEASE;
    const got = checkInFlight({
      io: {
        readdir: () => ['1'],
        read: (p) => (p.endsWith('/stat') ? '1 (init) S 1 0 0' : ''),
        readlink: () => '/',
      },
    });
    assert.equal(got.ok, true);
    assert.equal(got.count, 0);
    assert.equal(got.noServer, true);
  });
});

describe('与租约闸同源（不许各造一份判据）', () => {
  it('busyTrees 与 judgeTreeLease 对同一份观测的结论一致', async () => {
    const { busyTrees, judgeTreeLease } = await LEASE;
    const procs = [
      { pid: 1, comm: 'pi', cwd: `${W}/dao-982` },
      { pid: 2, comm: 'codex', cwd: `${W}/dao-review-pr-1018` },
    ];
    const busy = busyTrees(procs, { root: ROOT });
    for (const t of busy.trees) {
      assert.equal(judgeTreeLease({ workdir: t, procs }).verdict, 'held', `${t} 被算成在途，租约却说它空着`);
    }
    // 反向：没被算进在途的树，租约必须说它是空的
    assert.equal(judgeTreeLease({ workdir: `${W}/dao-9999`, procs }).verdict, 'free');
  });

  // 判「函数在不在」，不是判「文件里有没有这几个字」——注释里要留下「删了什么、为什么」，
  // 按文本查会把那段注释本身当成违规（实测踩了一次）。
  it('admission.mjs 里不许再有审官排除逻辑', async () => {
    const fs = require('node:fs');
    const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'lib', 'admission.mjs'), 'utf8');
    const 无注释 = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.equal(/isReviewerCard/.test(无注释), false, '审官排除是错分母，删了就不许回来');
    assert.equal(/countLiveWorkersFromSessionFacts/.test(无注释), false, '靠 record.json 推活性的判据已删');
  });

  it('这几个函数确实不再导出', async () => {
    const ADMIT = await import('file://' + path.join(__dirname, '..', 'scripts', 'lib', 'admission.mjs').replace(/\\/g, '/'));
    for (const n of ['countLiveWorkers', 'countLiveWorkersFromSessionFacts', 'classifyMirasimTreePath']) {
      assert.equal(ADMIT[n], undefined, `${n} 还在导出，说明整层没删干净`);
    }
    assert.equal(typeof ADMIT.admitCapacity, 'function', '该留的没被误删');
  });
});
