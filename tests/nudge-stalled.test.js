// tests/nudge-stalled.test.js —— 「推一把」三道闸（#1097）
//
// 语料是 2026-09-07 03:37 journal 实锤，不是编的：
//   工人 #1012 issue 已关、PR #1018 已合
//   工人 #1007 issue 已关、PR #1064 已合（同一晚被推过 18 次）
//   工人 #1063 树停在 master，PR #1070 分支是 fix-escalate-noise
// 没这三道闸，timer 每 20 分钟对 runState:incomplete 调 startSession，结束了还当没结束去推。
//
// 纯函数 + 注入 IO，不出网、不碰盘。

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const LIB = 'file://' + path.resolve(__dirname, '..', 'scripts', 'lib', 'nudge-stalled.mjs').replace(/\\/g, '/');
const CLI = path.resolve(__dirname, '..', 'scripts', 'nudge-stalled.mjs');
const SERVICE = path.resolve(__dirname, '..', 'host', 'machine', 'systemd', 'dao-nudge-stalled.service');

const TREE_1012 = '/home/orca/mirasim-worktrees/windsurf-dao/dao-1012';
const TREE_1007 = '/home/orca/mirasim-worktrees/windsurf-dao/dao-1007';
const TREE_1056 = '/home/orca/mirasim-worktrees/windsurf-dao/dao-1056';
const TREE_REV = '/home/orca/mirasim-worktrees/windsurf-dao/dao-review-pr-1040';

function id(kind, n, label) {
  return { kind, n, label: label || (kind === '审官' ? `PR #${n}` : `#${n}`) };
}

function issue(state) {
  return { ok: true, state };
}

function prs(items) {
  return { ok: true, items };
}

function branch(name) {
  return { ok: true, name };
}

function lease(verdict, why) {
  return { ok: true, verdict, why: why || (verdict === 'held' ? '人还在' : '没人') };
}

const OPEN_1056 = {
  number: 1057,
  state: 'OPEN',
  headRefName: 'dao-1056',
  title: '[cc] feat(x) (#1056)',
  body: '署名 issue #1056',
};

describe('idOfTree：跟 mirasim-trees 同一把尺', () => {
  it('工人树 / 第二棵 / 审官树各自认得出', async () => {
    const { idOfTree } = await import(LIB);
    assert.deepEqual(idOfTree(TREE_1012), { kind: '工人', n: 1012, label: '#1012' });
    assert.equal(idOfTree(`${TREE_1012}-2`).n, 1012);
    assert.deepEqual(idOfTree(TREE_REV), { kind: '审官', n: 1040, label: 'PR #1040' });
  });

  it('认不出 → null，不猜', async () => {
    const { idOfTree } = await import(LIB);
    assert.equal(idOfTree('/tmp/scratch'), null);
    assert.equal(idOfTree(''), null);
    assert.equal(idOfTree(null), null);
  });
});

describe('① 已关 issue / 已合 PR 必须跳过', () => {
  it('工人 #1012 issue CLOSED → skip closed，零起会话', async () => {
    const { judgeNudge } = await import(LIB);
    const got = judgeNudge({
      id: id('工人', 1012),
      issue: issue('CLOSED'),
      prs: prs([{ number: 1018, state: 'MERGED', headRefName: 'dao-1012', title: '(#1012)', body: '署名 issue #1012' }]),
      branch: branch('dao-1012'),
      lease: lease('free'),
    });
    assert.equal(got.action, 'skip');
    assert.equal(got.kind, 'closed');
    assert.match(got.reason, /已关/);
  });

  it('工人 #1007 issue 还开但署名 PR 已合 → skip merged', async () => {
    const { judgeNudge } = await import(LIB);
    const got = judgeNudge({
      id: id('工人', 1007),
      issue: issue('OPEN'),
      prs: prs([{ number: 1064, state: 'MERGED', headRefName: 'dao-1007', title: '(#1007)', body: '署名 issue #1007' }]),
      branch: branch('dao-1007'),
      lease: lease('free'),
    });
    assert.equal(got.action, 'skip');
    assert.equal(got.kind, 'merged');
    assert.match(got.reason, /#1064/);
  });

  it('审官 PR MERGED → skip merged', async () => {
    const { judgeNudge } = await import(LIB);
    const got = judgeNudge({
      id: id('审官', 1018),
      prs: prs([{ number: 1018, state: 'MERGED', headRefName: 'dao-1012' }]),
      branch: branch('dao-1012'),
      lease: lease('free'),
    });
    assert.equal(got.action, 'skip');
    assert.equal(got.kind, 'merged');
  });

  it('审官 PR CLOSED（没合）→ skip closed', async () => {
    const { judgeNudge } = await import(LIB);
    const got = judgeNudge({
      id: id('审官', 999),
      prs: prs([{ number: 999, state: 'CLOSED', headRefName: 'x' }]),
      branch: branch('x'),
      lease: lease('free'),
    });
    assert.equal(got.action, 'skip');
    assert.equal(got.kind, 'closed');
  });

  it('对已关单跑 --go：startSession 一次都不调', async () => {
    const { runNudge } = await import(LIB);
    const started = [];
    const out = await runNudge({
      go: true,
      records: [{ workdir: TREE_1012, runState: 'incomplete', updatedAt: '2026-09-07T03:37:00Z', agent: 'pi' }],
      exists: () => true,
      lookupIssue: () => issue('CLOSED'),
      lookupPrs: () => prs([]),
      readBranch: () => branch('dao-1012'),
      checkLease: () => lease('free'),
      startSession: async (a) => { started.push(a); return { sessionKey: 'should-not' }; },
      workerPrompt: '继续',
      reviewPrompt: '继续审',
    });
    assert.equal(started.length, 0, '已关单不许起会话');
    assert.equal(out.started.length, 0);
    assert.equal(out.skipped.length, 1);
    assert.equal(out.skipped[0].kind, 'closed');
  });

  it('今晚 6 棵一起 --go：已关/已合/错分支零起，只推未结且分支对的', async () => {
    const { runNudge } = await import(LIB);
    const TREE_1063 = '/home/orca/mirasim-worktrees/windsurf-dao/dao-1063';
    const TREE_1029 = '/home/orca/mirasim-worktrees/windsurf-dao/dao-1029';
    const TREE_1092 = '/home/orca/mirasim-worktrees/windsurf-dao/dao-1092';
    const started = [];
    const issues = {
      1012: 'CLOSED', 1007: 'CLOSED', 1063: 'OPEN',
      1056: 'OPEN', 1029: 'OPEN', 1092: 'OPEN',
    };
    const prByIssue = {
      1012: [{ number: 1018, state: 'MERGED', headRefName: 'dao-1012', title: '(#1012)', body: '署名 issue #1012' }],
      1007: [{ number: 1064, state: 'MERGED', headRefName: 'dao-1007', title: '(#1007)', body: '署名 issue #1007' }],
      1063: [{ number: 1070, state: 'OPEN', headRefName: 'fix-escalate-noise', title: '(#1063)', body: '署名 issue #1063' }],
      1056: [OPEN_1056],
      1029: [{ number: 1030, state: 'OPEN', headRefName: 'dao-1029', title: '(#1029)', body: '署名 issue #1029' }],
      1092: [{ number: 1096, state: 'OPEN', headRefName: 'dao-1092', title: '(#1092)', body: '署名 issue #1092' }],
    };
    const branches = {
      [TREE_1012]: 'dao-1012', [TREE_1007]: 'dao-1007', [TREE_1063]: 'master',
      [TREE_1056]: 'dao-1056', [TREE_1029]: 'dao-1029', [TREE_1092]: 'dao-1092',
    };
    const out = await runNudge({
      go: true,
      records: [TREE_1012, TREE_1007, TREE_1063, TREE_1056, TREE_1029, TREE_1092].map((wd, i) => ({
        workdir: wd, runState: 'incomplete', updatedAt: `2026-09-07T03:3${i}:00Z`, agent: 'pi',
      })),
      exists: () => true,
      lookupIssue: (n) => issue(issues[n]),
      lookupPrs: (ident) => prs(prByIssue[ident.n] || []),
      readBranch: (wd) => branch(branches[wd]),
      checkLease: () => lease('free'),
      startSession: async (a) => { started.push(a.workdir); return { sessionKey: 'k' }; },
      workerPrompt: '继续',
      reviewPrompt: '继续审',
    });
    assert.equal(started.length, 3, '只许推未结且分支对的三棵，实际：' + started.join(','));
    assert.equal(started.includes(TREE_1012), false);
    assert.equal(started.includes(TREE_1007), false);
    assert.equal(started.includes(TREE_1063), false);
    assert.equal(out.skipped.length, 3);
  });
});

describe('② 人还在（租约 held）不许再起一条', () => {
  it('lease held → skip held，理由写「人还在」', async () => {
    const { judgeNudge } = await import(LIB);
    const got = judgeNudge({
      id: id('工人', 1056),
      issue: issue('OPEN'),
      prs: prs([OPEN_1056]),
      branch: branch('dao-1056'),
      lease: lease('held', 'dao-1056 已经有 1 个会话进程在干活（pi pid 2977217）'),
    });
    assert.equal(got.action, 'skip');
    assert.equal(got.kind, 'held');
    assert.match(got.reason, /人还在/);
  });

  it('--go 时 held 零起会话', async () => {
    const { runNudge } = await import(LIB);
    const started = [];
    const out = await runNudge({
      go: true,
      records: [{ workdir: TREE_1056, runState: 'incomplete', updatedAt: '2026-09-07T03:37:00Z', agent: 'pi' }],
      exists: () => true,
      lookupIssue: () => issue('OPEN'),
      lookupPrs: () => prs([OPEN_1056]),
      readBranch: () => branch('dao-1056'),
      checkLease: () => lease('held', '人还在'),
      startSession: async (a) => { started.push(a); return { sessionKey: 'no' }; },
      workerPrompt: '继续',
      reviewPrompt: '继续审',
    });
    assert.equal(started.length, 0);
    assert.equal(out.skipped[0].kind, 'held');
  });

  it('startSession 抛 busy 也记成 held，不当成推失败去重试', async () => {
    const { runNudge } = await import(LIB);
    const err = new Error('租约被占，拒起会话');
    err.detail = { busy: true };
    const out = await runNudge({
      go: true,
      records: [{ workdir: TREE_1056, runState: 'incomplete', updatedAt: '2026-09-07T03:37:00Z', agent: 'pi' }],
      exists: () => true,
      lookupIssue: () => issue('OPEN'),
      lookupPrs: () => prs([OPEN_1056]),
      readBranch: () => branch('dao-1056'),
      checkLease: () => lease('free'),
      startSession: async () => { throw err; },
      workerPrompt: '继续',
      reviewPrompt: '继续审',
    });
    assert.equal(out.started.length, 0);
    assert.equal(out.skipped.length, 1);
    assert.equal(out.skipped[0].kind, 'held');
    assert.match(out.skipped[0].reason, /人还在/);
  });
});

describe('③ 树不在该单 PR head 上不许继续', () => {
  it('#1063 停在 master、PR head 是 fix-escalate-noise → skip wrong-branch', async () => {
    const { judgeNudge } = await import(LIB);
    const got = judgeNudge({
      id: id('工人', 1063),
      issue: issue('OPEN'),
      prs: prs([{
        number: 1070,
        state: 'OPEN',
        headRefName: 'fix-escalate-noise',
        title: '[cc] fix (#1063)',
        body: '署名 issue #1063',
      }]),
      branch: branch('master'),
      lease: lease('free'),
    });
    assert.equal(got.action, 'skip');
    assert.equal(got.kind, 'wrong-branch');
    assert.match(got.reason, /master/);
    assert.match(got.reason, /fix-escalate-noise/);
  });

  it('树在 master、署名 PR 也搜不到 → 仍 skip（不许在主干上继续）', async () => {
    const { judgeNudge } = await import(LIB);
    const got = judgeNudge({
      id: id('工人', 1063),
      issue: issue('OPEN'),
      prs: prs([]),
      branch: branch('master'),
      lease: lease('free'),
    });
    assert.equal(got.action, 'skip');
    assert.equal(got.kind, 'wrong-branch');
    assert.match(got.reason, /master/);
  });

  it('审官树分支对不上 PR head → skip', async () => {
    const { judgeNudge } = await import(LIB);
    const got = judgeNudge({
      id: id('审官', 1040),
      prs: prs([{ number: 1040, state: 'OPEN', headRefName: 'dao-1037' }]),
      branch: branch('master'),
      lease: lease('free'),
    });
    assert.equal(got.action, 'skip');
    assert.equal(got.kind, 'wrong-branch');
  });
});

describe('没查成 ≠ 没有：unscanned 不许起会话', () => {
  it('issue 面没给 → unscanned', async () => {
    const { judgeNudge } = await import(LIB);
    const got = judgeNudge({
      id: id('工人', 1056),
      issue: { ok: false, error: 'gh 超时' },
      prs: prs([OPEN_1056]),
      branch: branch('dao-1056'),
      lease: lease('free'),
    });
    assert.equal(got.action, 'unscanned');
    assert.equal(got.kind, 'issue');
    assert.match(got.reason, /没查成/);
  });

  it('租约没查成 → unscanned，不当成 free', async () => {
    const { judgeNudge } = await import(LIB);
    const got = judgeNudge({
      id: id('工人', 1056),
      issue: issue('OPEN'),
      prs: prs([OPEN_1056]),
      branch: branch('dao-1056'),
      lease: { ok: false, error: '/proc 读不动' },
    });
    assert.equal(got.action, 'unscanned');
    assert.equal(got.kind, 'lease');
  });

  it('租约成功信封缺 verdict → unscanned，不当成 free（#1102 红项）', async () => {
    const { judgeNudge } = await import(LIB);
    const got = judgeNudge({
      id: id('工人', 1056),
      issue: issue('OPEN'),
      prs: prs([OPEN_1056]),
      branch: branch('dao-1056'),
      lease: { ok: true },
    });
    assert.equal(got.action, 'unscanned');
    assert.equal(got.kind, 'lease');
    assert.match(got.reason, /没查成/);
  });

  it('租约 ok:true 但 verdict unknown → unscanned，不当成 go', async () => {
    const { judgeNudge } = await import(LIB);
    const got = judgeNudge({
      id: id('工人', 1056),
      issue: issue('OPEN'),
      prs: prs([OPEN_1056]),
      branch: branch('dao-1056'),
      lease: { ok: true, verdict: 'unknown' },
    });
    assert.equal(got.action, 'unscanned');
    assert.equal(got.kind, 'lease');
    assert.match(got.reason, /没查成/);
  });

  it('runNudge：ok:true 但缺/非法 verdict 零起会话，exit 2', async () => {
    const { runNudge, nudgeExitCode } = await import(LIB);
    for (const broken of [{ ok: true }, { ok: true, verdict: 'unknown' }]) {
      const started = [];
      const out = await runNudge({
        go: true,
        records: [{ workdir: TREE_1056, runState: 'incomplete', updatedAt: '2026-09-07T03:37:00Z', agent: 'pi' }],
        exists: () => true,
        lookupIssue: () => issue('OPEN'),
        lookupPrs: () => prs([OPEN_1056]),
        readBranch: () => branch('dao-1056'),
        checkLease: () => broken,
        startSession: async (a) => { started.push(a); return { sessionKey: 'no' }; },
        workerPrompt: '继续',
        reviewPrompt: '继续审',
      });
      assert.equal(started.length, 0);
      assert.equal(out.unscanned.length, 1);
      assert.equal(nudgeExitCode(out), 2);
    }
  });

  it('runNudge 对 unscanned 零起会话，并记进 out.unscanned', async () => {
    const { runNudge } = await import(LIB);
    const started = [];
    const out = await runNudge({
      go: true,
      records: [{ workdir: TREE_1056, runState: 'incomplete', updatedAt: '2026-09-07T03:37:00Z', agent: 'pi' }],
      exists: () => true,
      lookupIssue: () => ({ ok: false, error: '超时' }),
      lookupPrs: () => prs([]),
      readBranch: () => branch('dao-1056'),
      checkLease: () => lease('free'),
      startSession: async (a) => { started.push(a); return { sessionKey: 'no' }; },
      workerPrompt: '继续',
      reviewPrompt: '继续审',
    });
    assert.equal(started.length, 0);
    assert.equal(out.unscanned.length, 1);
  });
});

describe('该推才推：未结 + 人已退 + 分支对得上', () => {
  it('工人未结、free、分支对上 → go', async () => {
    const { judgeNudge } = await import(LIB);
    const got = judgeNudge({
      id: id('工人', 1056),
      issue: issue('OPEN'),
      prs: prs([OPEN_1056]),
      branch: branch('dao-1056'),
      lease: lease('free'),
    });
    assert.equal(got.action, 'go');
  });

  it('工人还没开 PR、不在 master → 分支闸无对象，不拦', async () => {
    const { judgeNudge } = await import(LIB);
    const got = judgeNudge({
      id: id('工人', 1097),
      issue: issue('OPEN'),
      prs: prs([]),
      branch: branch('dao-1097'),
      lease: lease('free'),
    });
    assert.equal(got.action, 'go');
  });

  it('--go 真起一次，prompt 按工人/审官分岔', async () => {
    const { runNudge } = await import(LIB);
    const started = [];
    const out = await runNudge({
      go: true,
      records: [
        { workdir: TREE_1056, runState: 'incomplete', updatedAt: '2026-09-07T03:37:00Z', agent: 'pi' },
        { workdir: TREE_REV, runState: 'incomplete', updatedAt: '2026-09-07T03:38:00Z', agent: 'codex' },
      ],
      exists: () => true,
      lookupIssue: () => issue('OPEN'),
      lookupPrs: (ident) => ident.kind === '审官'
        ? prs([{ number: 1040, state: 'OPEN', headRefName: 'dao-1037' }])
        : prs([OPEN_1056]),
      readBranch: (wd) => wd.includes('review') ? branch('dao-1037') : branch('dao-1056'),
      checkLease: () => lease('free'),
      startSession: async (a) => {
        started.push(a);
        return { sessionKey: `key-${started.length}` };
      },
      workerPrompt: 'WORKER',
      reviewPrompt: 'REVIEW',
    });
    assert.equal(started.length, 2);
    assert.equal(out.started.length, 2);
    assert.equal(started[0].prompt, 'WORKER');
    assert.equal(started[1].prompt, 'REVIEW');
    assert.equal(started[0].agent, 'pi');
    assert.equal(started[1].agent, 'codex');
  });

  it('预览模式（go=false）也不起会话', async () => {
    const { runNudge } = await import(LIB);
    const started = [];
    const out = await runNudge({
      go: false,
      records: [{ workdir: TREE_1056, runState: 'incomplete', updatedAt: '2026-09-07T03:37:00Z', agent: 'pi' }],
      exists: () => true,
      lookupIssue: () => issue('OPEN'),
      lookupPrs: () => prs([OPEN_1056]),
      readBranch: () => branch('dao-1056'),
      checkLease: () => lease('free'),
      startSession: async (a) => { started.push(a); return { sessionKey: 'no' }; },
      workerPrompt: '继续',
      reviewPrompt: '继续审',
    });
    assert.equal(started.length, 0);
    assert.equal(out.started.length, 0);
  });
});

describe('collectStalled：按树取最近那条 incomplete', () => {
  it('旧 running 盖不住新 incomplete', async () => {
    const { collectStalled } = await import(LIB);
    const got = collectStalled([
      { workdir: TREE_1056, runState: 'running', updatedAt: '2026-09-07T11:31:00Z' },
      { workdir: TREE_1056, runState: 'incomplete', updatedAt: '2026-09-07T11:49:00Z' },
    ], { exists: () => true });
    assert.equal(got.length, 1);
    assert.equal(got[0].rec.runState, 'incomplete');
  });

  it('新 running 盖住旧 incomplete → 不进清单', async () => {
    const { collectStalled } = await import(LIB);
    const got = collectStalled([
      { workdir: TREE_1056, runState: 'incomplete', updatedAt: '2026-09-07T11:31:00Z' },
      { workdir: TREE_1056, runState: 'running', updatedAt: '2026-09-07T11:49:00Z' },
    ], { exists: () => true });
    assert.equal(got.length, 0);
  });

  it('树已经清掉了不进清单', async () => {
    const { collectStalled } = await import(LIB);
    const got = collectStalled([
      { workdir: TREE_1007, runState: 'incomplete', updatedAt: '2026-09-07T03:37:00Z' },
    ], { exists: () => false });
    assert.equal(got.length, 0);
  });
});

describe('文件头与代码一致：人退了才起新的；#1056 合并时退役', () => {
  it('垫片头写明「人退了才起新的」，不再写「说一句继续，不是重派」当正路', () => {
    const src = fs.readFileSync(CLI, 'utf8');
    assert.match(src, /人退了才起新的/);
    assert.match(src, /#1056/);
    assert.match(src, /runNudge/);
    assert.match(src, /lookupIssue/);
    assert.match(src, /lookupPrs/);
    assert.match(src, /readBranch/);
    assert.match(src, /checkTreeLease/);
    assert.doesNotMatch(src.slice(0, 1200), /所以处置是\*\*说一句「继续」\*\*，不是重派/);
  });

  it('闸只吃入参、不碰盘、不出网', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '..', 'scripts', 'lib', 'nudge-stalled.mjs'), 'utf8');
    assert.match(src, /只吃入参、不碰盘、不出网/);
    assert.match(src, /export function judgeNudge/);
    assert.doesNotMatch(src, /from '\.\/gh\.mjs'/);
    assert.doesNotMatch(src, /spawnSync/);
  });

  it('service 头跟代码同口径：人退了才起新的', () => {
    const src = fs.readFileSync(SERVICE, 'utf8');
    assert.match(src, /人退了才起新的/);
    assert.match(src, /#1056/);
    assert.match(src, /已关 issue \/ 已合 PR/);
    assert.match(src, /退出码 1 = 起会话失败/);
    assert.match(src, /busy 背压是 skip/);
  });
});

describe('PR 列表截断 ≠ 没有该单 PR（#1102 红项 1）', () => {
  it('取满 limit 条 → 没查全，不是完整空列表', async () => {
    const { classifyPrListScan } = await import(LIB);
    const truncated = classifyPrListScan({
      ok: true,
      items: Array.from({ length: 100 }, (_, i) => ({ number: i + 1 })),
      limit: 100,
    });
    assert.equal(truncated.ok, false);
    assert.match(truncated.error, /截断|没查全/);
    const completeEmpty = classifyPrListScan({ ok: true, items: [], limit: 100 });
    assert.equal(completeEmpty.ok, true);
    assert.equal(completeEmpty.items.length, 0);
    const complete99 = classifyPrListScan({
      ok: true,
      items: Array.from({ length: 99 }, (_, i) => ({ number: i + 1 })),
      limit: 100,
    });
    assert.equal(complete99.ok, true);
    assert.equal(complete99.items.length, 99);
  });

  it('截断的 PR 面进 runNudge：非 master 工人 unscanned，零起会话', async () => {
    const { runNudge } = await import(LIB);
    const started = [];
    const TREE_1097 = '/home/orca/mirasim-worktrees/windsurf-dao/dao-1097';
    const out = await runNudge({
      go: true,
      records: [{ workdir: TREE_1097, runState: 'incomplete', updatedAt: '2026-09-07T03:37:00Z', agent: 'pi' }],
      exists: () => true,
      lookupIssue: () => issue('OPEN'),
      lookupPrs: () => ({ ok: false, error: 'PR 面取满 100 条（列表被截断，没查全）' }),
      readBranch: () => branch('dao-1097'),
      checkLease: () => lease('free'),
      startSession: async (a) => { started.push(a); return { sessionKey: 'should-not' }; },
      workerPrompt: '继续',
      reviewPrompt: '继续审',
    });
    assert.equal(started.length, 0, '截断不许当成没有 PR 去起会话');
    assert.equal(out.started.length, 0);
    assert.equal(out.unscanned.length, 1);
    assert.match(out.unscanned[0].reason, /没查成|没查全|截断/);
  });

  it('完整空列表仍允许未开 PR 的工人（分支闸无对象）', async () => {
    const { judgeNudge } = await import(LIB);
    const got = judgeNudge({
      id: id('工人', 1097),
      issue: issue('OPEN'),
      prs: prs([]),
      branch: branch('dao-1097'),
      lease: lease('free'),
    });
    assert.equal(got.action, 'go');
  });

  it('垫片 loadAllPrs 用 PR_LIST_LIMIT，取满即 classify 截断', () => {
    const src = fs.readFileSync(CLI, 'utf8');
    assert.match(src, /classifyPrListScan/);
    assert.match(src, /PR_LIST_LIMIT/);
    assert.doesNotMatch(src, /--limit', '100'/);
  });
});

describe('起会话失败可机器识别（#1102 红项 2）', () => {
  it('startSession 抛普通错误 → out.failed，不是成功收尾', async () => {
    const { runNudge, nudgeExitCode } = await import(LIB);
    const out = await runNudge({
      go: true,
      records: [{ workdir: TREE_1056, runState: 'incomplete', updatedAt: '2026-09-07T03:37:00Z', agent: 'pi' }],
      exists: () => true,
      lookupIssue: () => issue('OPEN'),
      lookupPrs: () => prs([OPEN_1056]),
      readBranch: () => branch('dao-1056'),
      checkLease: () => lease('free'),
      startSession: async () => { throw new Error('mirasim unavailable'); },
      workerPrompt: '继续',
      reviewPrompt: '继续审',
    });
    assert.equal(out.started.length, 0);
    assert.equal(out.skipped.length, 0);
    assert.equal(out.unscanned.length, 0);
    assert.equal(out.failed.length, 1);
    assert.match(out.failed[0].reason, /mirasim unavailable/);
    assert.equal(nudgeExitCode(out), 1);
  });

  it('busy 背压仍是 skip、exit 0，跟真实失败分得开', async () => {
    const { runNudge, nudgeExitCode } = await import(LIB);
    const err = new Error('租约被占，拒起会话');
    err.detail = { busy: true };
    const out = await runNudge({
      go: true,
      records: [{ workdir: TREE_1056, runState: 'incomplete', updatedAt: '2026-09-07T03:37:00Z', agent: 'pi' }],
      exists: () => true,
      lookupIssue: () => issue('OPEN'),
      lookupPrs: () => prs([OPEN_1056]),
      readBranch: () => branch('dao-1056'),
      checkLease: () => lease('free'),
      startSession: async () => { throw err; },
      workerPrompt: '继续',
      reviewPrompt: '继续审',
    });
    assert.equal(out.failed.length, 0);
    assert.equal(out.skipped[0].kind, 'held');
    assert.equal(nudgeExitCode(out), 0);
  });

  it('nudgeExitCode：没查成 2 优先于失败 1，成功/跳过 0', async () => {
    const { nudgeExitCode } = await import(LIB);
    assert.equal(nudgeExitCode({ unscanned: [{}], failed: [{}] }), 2);
    assert.equal(nudgeExitCode({ unscanned: [], failed: [{}] }), 1);
    assert.equal(nudgeExitCode({ unscanned: [], failed: [], started: [{}] }), 0);
    assert.equal(nudgeExitCode({}), 0);
  });

  it('垫片收尾走 nudgeExitCode，失败不再静默 exit 0', () => {
    const src = fs.readFileSync(CLI, 'utf8');
    assert.match(src, /nudgeExitCode/);
    assert.match(src, /if \(code\) process\.exit\(code\)/);
  });
});
