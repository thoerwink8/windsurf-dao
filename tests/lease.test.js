// tests/lease.test.js —— 一棵树同时只许一个会话在跑
//
// 语料取自 2026-09-06 实测的 /proc，不是编的：
//   3015939 codex cwd=/home/orca/mirasim-worktrees/windsurf-dao/dao-review-pr-1040  ← 767216
//   3016221 codex cwd=…/dao-review-pr-1064                                          ← 3016131 ← 767216
//   3045660 codex cwd=…/dao-review-pr-1064   ← 同一棵树两个审官，这就是本闸要拦的东西
//   3012989 pi    cwd=/tmp/mirasim-unix-smoke                                       ← 619237（另一个实例）
//   767216 = /home/orca/mirasim-server/0.0.282/server.cjs --port 4316
//
// 为什么不用 record.json 的 runPid：那是 mirasim-server 自己的 pid，五条 running 记录
// 全是同一个 767216——判据文件头有实测原文。

const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const LEASE = import('file://' + path.join(__dirname, '..', 'scripts', 'lib', 'dispatch', 'lease.mjs').replace(/\\/g, '/'));

const W = '/home/orca/mirasim-worktrees/windsurf-dao';
const 树1040 = `${W}/dao-review-pr-1040`;
const 树1064 = `${W}/dao-review-pr-1064`;
const 树1055 = `${W}/dao-1055`;

const 观测 = [
  { pid: 3015939, comm: 'codex', cwd: 树1040 },
  { pid: 3016221, comm: 'codex', cwd: 树1064 },
  { pid: 3045660, comm: 'codex', cwd: 树1064 },
  { pid: 2977217, comm: 'pi', cwd: 树1055 },
];

describe('租约：树里有会话进程就不许再起', () => {
  it('树里有一个进程 → held，并说得出是谁', async () => {
    const { judgeTreeLease } = await LEASE;
    const got = judgeTreeLease({ workdir: 树1040, procs: 观测 });
    assert.equal(got.verdict, 'held');
    assert.deepEqual(got.holders, [{ pid: 3015939, comm: 'codex' }]);
  });

  // 这就是实测抓到的现行：同一个 PR 上两个审官同时在跑。
  it('同一棵树两个进程 → held，两个都列出来', async () => {
    const { judgeTreeLease } = await LEASE;
    const got = judgeTreeLease({ workdir: 树1064, procs: 观测 });
    assert.equal(got.verdict, 'held');
    assert.deepEqual(got.holders, [
      { pid: 3016221, comm: 'codex' },
      { pid: 3045660, comm: 'codex' },
    ]);
  });

  it('树里没进程 → free', async () => {
    const { judgeTreeLease } = await LEASE;
    const got = judgeTreeLease({ workdir: `${W}/dao-9999`, procs: 观测 });
    assert.equal(got.verdict, 'free');
  });

  it('一个进程都没有（扫成了，结论是 0）→ free', async () => {
    const { judgeTreeLease } = await LEASE;
    assert.equal(judgeTreeLease({ workdir: 树1040, procs: [] }).verdict, 'free');
  });

  it('路径尾斜杠不该让闸漏判', async () => {
    const { judgeTreeLease } = await LEASE;
    assert.equal(judgeTreeLease({ workdir: 树1040 + '/', procs: 观测 }).verdict, 'held');
  });

  // 前缀相同不等于同一棵树：dao-105 不该被 dao-1055 占住。
  it('树名互为前缀时不许误判', async () => {
    const { judgeTreeLease } = await LEASE;
    assert.equal(judgeTreeLease({ workdir: `${W}/dao-105`, procs: 观测 }).verdict, 'free');
  });
});

// 放行「没查成」等于没有闸，而且日志上看起来一切正常（闸在跑，只是没拦到）。
describe('没查成一律按占用（fail-close）', () => {
  it('procs 不是数组 → held，并说明是没查成', async () => {
    const { judgeTreeLease } = await LEASE;
    const got = judgeTreeLease({ workdir: 树1040, procs: null });
    assert.equal(got.verdict, 'held');
    assert.match(got.why, /没查成/);
  });

  it('/proc 读不动 → checkTreeLease 回 ok:false', async () => {
    const { checkTreeLease } = await LEASE;
    const 炸 = () => { throw new Error('permission denied'); };
    const got = checkTreeLease({ workdir: 树1040, io: { readdir: 炸 } });
    assert.equal(got.ok, false);
    assert.equal(got.unscanned, true);
    assert.match(got.error, /读不动/);
  });

  // 以别的用户跑时 /proc 目录列得出来、cwd 一个都读不出来——这跟「没有会话在跑」
  // 长得一模一样。分不开，闸就静默失效了。
  it('列得出 pid 但一个 cwd 都读不出来 → 没查成，不是 free', async () => {
    const { scanSessionProcs } = await LEASE;
    const got = scanSessionProcs({
      readdir: () => ['1', '767216', '3015939'],
      read: (p) => (p.endsWith('/stat') ? '1 (x) S 1 0 0' : p.endsWith('/cmdline') ? 'mirasim-server/0.0.282/server.cjs' : 'x'),
      readlink: () => { throw new Error('EACCES'); },
    });
    assert.equal(got.ok, false);
    assert.equal(got.unscanned, true);
  });

  it('mirasim 服务不在 → 查成了且结论是 0（不是没查成）', async () => {
    const { scanSessionProcs } = await LEASE;
    const got = scanSessionProcs({
      readdir: () => ['1', '2'],
      read: (p) => (p.endsWith('/stat') ? '1 (init) S 1 0 0' : ''),
      readlink: () => '/',
    });
    assert.equal(got.ok, true);
    assert.equal(got.noServer, true);
    assert.deepEqual(got.procs, []);
  });
});

describe('只认 mirasim 服务的后代', () => {
  // 机器上可能同时有第二个 mirasim 实例（实测 /tmp/mirasim-unix-smoke 那两个 pi
  // 挂在另一个 MainThread 下）。按祖先排除，不按进程名。
  const io = {
    readdir: () => ['767216', '3015913', '3015939', '619237', '3012989', '4000'],
    read: (p) => {
      const pid = /\/proc\/(\d+)\//.exec(p)?.[1];
      if (p.endsWith('/cmdline')) {
        return pid === '767216' ? '/home/orca/mirasim-server/0.0.282/server.cjs --port 4316'
          : pid === '619237' ? '/home/orca/mirasim-other/server.cjs' : 'x';
      }
      if (p.endsWith('/comm')) return pid === '3015939' ? 'codex\n' : 'pi\n';
      // stat：pid (comm) state ppid …
      const ppid = { 767216: 1, 3015913: 767216, 3015939: 3015913, 619237: 1, 3012989: 619237, 4000: 1 }[pid];
      return `${pid} (x) S ${ppid} 0 0`;
    },
    readlink: (p) => {
      const pid = /\/proc\/(\d+)\//.exec(p)?.[1];
      return { 3015939: 树1040, 3012989: 树1040, 4000: 树1040 }[pid] || '/';
    },
  };

  it('隔着一层 node 的孙进程也算数；服务自己不算', async () => {
    const { scanSessionProcs } = await LEASE;
    const got = scanSessionProcs(io);
    // 3015913 是中间那层 node，它的 cwd 是 '/'，判树时自然落不到任何工作树上；
    // 767216 是服务自己，必须被显式排除，否则它的 cwd 会占住一棵树。
    assert.equal(got.procs.some((p) => p.pid === 3015939), true, '孙进程要算数');
    assert.equal(got.procs.some((p) => p.pid === 767216), false, '服务自己不该算占用');
    assert.equal(got.procs.some((p) => p.pid === 3012989), false, '另一个实例的进程不该算数');
    assert.equal(got.procs.some((p) => p.pid === 4000), false, '跟服务无关的进程不该算数');
  });

  it('另一个 mirasim 实例的进程、以及跟服务无关的进程，都不算占用', async () => {
    const { judgeTreeLease, scanSessionProcs } = await LEASE;
    const got = judgeTreeLease({ workdir: 树1040, procs: scanSessionProcs(io).procs });
    assert.equal(got.verdict, 'held');
    assert.equal(got.holders.length, 1, '3012989(另一实例) 与 4000(无关进程) 不该算进来');
  });

  it('父链成环时不许卡死起会话那条路', async () => {
    const { scanSessionProcs } = await LEASE;
    const 环 = {
      readdir: () => ['100', '200', '300'],
      read: (p) => {
        const pid = /\/proc\/(\d+)\//.exec(p)?.[1];
        if (p.endsWith('/cmdline')) return pid === '100' ? 'mirasim-server/x/server.cjs' : 'y';
        if (p.endsWith('/comm')) return 'pi\n';
        const ppid = { 100: 1, 200: 300, 300: 200 }[pid];
        return `${pid} (x) S ${ppid} 0 0`;
      },
      readlink: () => 树1040,
    };
    const got = scanSessionProcs(环); // 不许挂住
    assert.equal(got.ok, true);
    // 200/300 互为父子成环，够不到服务，全部排除；100 是服务自己，也排除。
    assert.deepEqual(got.procs.map((p) => p.pid), []);
  });
});

// 闸在不在**起会话那道门里**，跟判据对不对是两回事。判据全绿而闸没接线，
// 盘面上看不出任何区别——所以单独钉一条：闸必须在 startSession 里，且在开 ws 之前。
describe('闸接在起会话入口上（守住别被摘掉）', () => {
  const fs = require('node:fs');
  const RT = path.join(__dirname, '..', 'scripts', 'lib', 'mirasim-runtime.mjs');
  const 切出 = () => {
    const src = fs.readFileSync(RT, 'utf8');
    const a = src.indexOf('async function startSession(');
    const b = src.indexOf('async function readSession(', a);
    assert.ok(a >= 0 && b > a, 'startSession/readSession 锚点找不到了——切片没取成，不是「检查通过」');
    const fn = src.slice(a, b);
    assert.ok(fn.length > 400, `切片只有 ${fn.length} 字符，锚点多半失效了`);
    return { src, fn };
  };

  it('startSession 里调了租约闸', async () => {
    const { fn } = 切出();
    assert.match(fn, /leaseCheck\(/, '起会话入口没过租约闸');
  });

  it('闸在开 ws 之前 —— 占着的树连连接都不建', async () => {
    const { fn } = 切出();
    assert.ok(fn.indexOf('leaseCheck(') < fn.indexOf('await open()'), '闸必须排在 open() 前面');
  });

  it('没查成要抛，不许当成放行', async () => {
    const { fn } = 切出();
    assert.match(fn, /lease\.ok[\s\S]{0,200}throw new MirasimUnavailableError/, '没查成必须抛（fail-close）');
    assert.match(fn, /verdict === 'held'[\s\S]{0,200}throw new MirasimRejectedError/, '被占必须抛');
  });

  it('默认判据是真闸，不是空函数', async () => {
    const { src } = 切出();
    assert.match(src, /opts\.leaseCheck \|\| checkTreeLease/, '默认值被换掉，闸就等于没装');
    assert.match(src, /import \{ checkTreeLease \} from '\.\/dispatch\/lease\.mjs'/);
  });
});

describe('/proc/<pid>/stat 解析', () => {
  // comm 里带空格和括号会把「按空格切」冲垮，切在最后一个 ')' 才安全。
  it('进程名里有空格和括号时 ppid 仍解析得对', async () => {
    const { scanSessionProcs } = await LEASE;
    const got = scanSessionProcs({
      readdir: () => ['100', '200'],
      read: (p) => {
        const pid = /\/proc\/(\d+)\//.exec(p)?.[1];
        if (p.endsWith('/cmdline')) return pid === '100' ? 'mirasim-server/x/server.cjs' : 'y';
        if (p.endsWith('/comm')) return 'pi (x)\n';
        return pid === '100' ? '100 (srv) S 1 0 0' : '200 (pi (turn) x) S 100 0 0';
      },
      readlink: () => 树1055,
    });
    assert.deepEqual(got.procs.map((p) => p.pid), [200], 'ppid 解析错就认不出它是服务的后代');
  });
});
