const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { dirname, join } = path;

const LOAD = import('file://' + path.join(__dirname, '..', 'scripts', 'lib', 'land-decision.mjs').replace(/\\/g, '/'));
const CORE = import('file://' + path.join(__dirname, '..', 'scripts', 'lib', 'commander-core.mjs').replace(/\\/g, '/'));

describe('lastJudgmentOf', () => {
  it('没查成 → null，不当绿也不当红', async () => {
    const { lastJudgmentOf } = await LOAD;
    assert.equal(lastJudgmentOf(null), null);
    assert.equal(lastJudgmentOf({ scanned: false }), null);
  });
  it('最后一条绿 / 红 / 没有判别', async () => {
    const { lastJudgmentOf } = await LOAD;
    assert.equal(lastJudgmentOf({ scanned: true, latestGreen: true, latestRed: false }), 'APPROVED');
    assert.equal(lastJudgmentOf({ scanned: true, latestGreen: false, latestRed: true }), 'CHANGES_REQUESTED');
    assert.equal(lastJudgmentOf({ scanned: true, latestGreen: false, latestRed: false }), null);
  });
});

describe('approvedToLand', () => {
  it('当前 head 上是绿 → 可合', async () => {
    const { approvedToLand } = await LOAD;
    assert.equal(approvedToLand({ greenAtHead: true, atHead: 1, lastJudgment: 'APPROVED' }), true);
  });
  it('GitHub 聚合 APPROVED 不能单独代替 HEAD 证据', async () => {
    const { approvedToLand } = await LOAD;
    assert.equal(approvedToLand({ decisionApproved: true, atHead: 0, lastJudgment: null }), false);
  });
  it('当前 HEAD 红票不能被聚合 APPROVED 压掉', async () => {
    const { approvedToLand } = await LOAD;
    assert.equal(approvedToLand({
      greenAtHead: false, redAtHead: true, decisionApproved: true, atHead: 1, lastJudgment: 'CHANGES_REQUESTED',
    }), false);
  });
  it('旧 head 上核绿、新 head 还没判定、没有对接证明 → 不可合', async () => {
    const { approvedToLand } = await LOAD;
    assert.equal(approvedToLand({
      greenAtHead: false, decisionApproved: false, atHead: 0, lastJudgment: 'APPROVED',
    }), false);
  });
  it('旧批准 + 已证明纯对接 → 可合', async () => {
    const { approvedToLand } = await LOAD;
    assert.equal(approvedToLand({
      greenAtHead: false, atHead: 0, lastJudgment: 'APPROVED', dock: { state: 'ok' },
    }), true);
  });
  it('旧批准 + 对接证明红 / unknown → 不可合', async () => {
    const { approvedToLand } = await LOAD;
    assert.equal(approvedToLand({
      greenAtHead: false, atHead: 0, lastJudgment: 'APPROVED', dock: { state: 'red' },
    }), false);
    assert.equal(approvedToLand({
      greenAtHead: false, atHead: 0, lastJudgment: 'APPROVED', dock: { state: 'unknown' },
    }), false);
  });
  it('旧 head 上判红、新 head 还没判定 → 不可合（返工后要再看）', async () => {
    const { approvedToLand } = await LOAD;
    assert.equal(approvedToLand({
      greenAtHead: false, atHead: 0, lastJudgment: 'CHANGES_REQUESTED',
    }), false);
  });
  it('从来没审过 → 不可合', async () => {
    const { approvedToLand } = await LOAD;
    assert.equal(approvedToLand({ greenAtHead: false, atHead: 0, lastJudgment: null }), false);
  });
});

describe('judgePureDock', () => {
  it('双亲 merge commit 不是正控', async () => {
    const { judgePureDock } = await LOAD;
    const r = judgePureDock({
      approved: 'a'.repeat(40), head: 'b'.repeat(40), master: 'c'.repeat(40),
      twoParent: true,
    });
    assert.equal(r.state, 'unknown');
  });
  it('提交标题不是正控', async () => {
    const { judgePureDock } = await LOAD;
    const r = judgePureDock({
      approved: 'a'.repeat(40), head: 'b'.repeat(40), master: 'c'.repeat(40),
      title: 'Merge origin/master into feature',
    });
    assert.equal(r.state, 'unknown');
  });
  it('祖先关系不是正控', async () => {
    const { judgePureDock } = await LOAD;
    const r = judgePureDock({
      approved: 'a'.repeat(40), head: 'b'.repeat(40), master: 'c'.repeat(40),
      isAncestor: true,
    });
    assert.equal(r.state, 'unknown');
  });
  it('虚拟合入树相同 → ok', async () => {
    const { judgePureDock } = await LOAD;
    const tree = 'd'.repeat(40);
    const r = judgePureDock({
      approved: 'a'.repeat(40), head: 'b'.repeat(40), master: 'c'.repeat(40),
      approvedMasterTree: tree, headMasterTree: tree,
    });
    assert.equal(r.state, 'ok');
  });
  it('虚拟合入树不同 → red（新逻辑 / 偷带）', async () => {
    const { judgePureDock } = await LOAD;
    const r = judgePureDock({
      approved: 'a'.repeat(40), head: 'b'.repeat(40), master: 'c'.repeat(40),
      approvedMasterTree: 'd'.repeat(40), headMasterTree: 'e'.repeat(40),
    });
    assert.equal(r.state, 'red');
  });
  it('冲突 / 对象读取失败 → unknown', async () => {
    const { judgePureDock } = await LOAD;
    assert.equal(judgePureDock({
      approved: 'a'.repeat(40), head: 'b'.repeat(40), master: 'c'.repeat(40),
      approvedMasterConflict: true,
    }).state, 'unknown');
    assert.equal(judgePureDock({ objectReadFailed: true }).state, 'unknown');
  });
});

function gitRepo() {
  const root = mkdtempSync(join(tmpdir(), 'dock-proof-'));
  const g = (args) => execFileSync('git', args, {
    cwd: root, encoding: 'utf8', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  g(['init', '-b', 'master']);
  g(['config', 'user.email', 'dock@example.invalid']);
  g(['config', 'user.name', 'dock']);
  g(['config', 'commit.gpgsign', 'false']);
  const put = (rel, text) => {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, text);
  };
  const sha = () => g(['rev-parse', 'HEAD']).trim();
  const run = (argv) => {
    try {
      const out = execFileSync(argv[0], argv.slice(1), {
        cwd: root, encoding: 'utf8', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      });
      return { ok: true, out: String(out), stderr: '' };
    } catch (e) {
      return {
        ok: false,
        out: String(e.stdout || ''),
        stderr: String(e.stderr || ''),
        error: String(e.stderr || e.message || '').slice(0, 300),
        status: e.status,
      };
    }
  };
  return { root, g, put, sha, run, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe('provePureDock 真 git', () => {
  it('合入 master 的纯对接 → ok；master 再领先仍 ok', async () => {
    const { provePureDock } = await LOAD;
    const repo = gitRepo();
    try {
      repo.put('base.txt', 'base\n');
      repo.g(['add', 'base.txt']);
      repo.g(['commit', '-m', 'M0']);
      repo.g(['checkout', '-b', 'pr']);
      repo.put('pr.txt', 'feature\n');
      repo.g(['add', 'pr.txt']);
      repo.g(['commit', '-m', 'A approved']);
      const approved = repo.sha();
      repo.g(['checkout', 'master']);
      repo.put('master.txt', 'from master\n');
      repo.g(['add', 'master.txt']);
      repo.g(['commit', '-m', 'M1']);
      const m1 = repo.sha();
      repo.g(['checkout', 'pr']);
      repo.g(['merge', '--no-edit', 'master']);
      const head = repo.sha();
      const docked = provePureDock({ approved, head, masterRef: m1, run: repo.run });
      assert.equal(docked.state, 'ok', docked.why);
      repo.g(['checkout', 'master']);
      repo.put('later.txt', 'master moved\n');
      repo.g(['add', 'later.txt']);
      repo.g(['commit', '-m', 'M2']);
      const m2 = repo.sha();
      const still = provePureDock({ approved, head, masterRef: m2, run: repo.run });
      assert.equal(still.state, 'ok', still.why);
    } finally {
      repo.cleanup();
    }
  });

  it('批准后普通改码 → red', async () => {
    const { provePureDock } = await LOAD;
    const repo = gitRepo();
    try {
      repo.put('base.txt', 'base\n');
      repo.g(['add', 'base.txt']);
      repo.g(['commit', '-m', 'M0']);
      repo.g(['checkout', '-b', 'pr']);
      repo.put('pr.txt', 'feature\n');
      repo.g(['add', 'pr.txt']);
      repo.g(['commit', '-m', 'A approved']);
      const approved = repo.sha();
      repo.g(['checkout', 'master']);
      repo.put('master.txt', 'from master\n');
      repo.g(['add', 'master.txt']);
      repo.g(['commit', '-m', 'M1']);
      const master = repo.sha();
      repo.g(['checkout', 'pr']);
      repo.g(['merge', '--no-edit', 'master']);
      repo.put('evil.txt', 'sneak\n');
      repo.g(['add', 'evil.txt']);
      repo.g(['commit', '-m', 'extra logic']);
      const head = repo.sha();
      const r = provePureDock({ approved, head, masterRef: master, run: repo.run });
      assert.equal(r.state, 'red', r.why);
    } finally {
      repo.cleanup();
    }
  });

  it('merge commit 偷带文件 → red', async () => {
    const { provePureDock } = await LOAD;
    const repo = gitRepo();
    try {
      repo.put('base.txt', 'base\n');
      repo.g(['add', 'base.txt']);
      repo.g(['commit', '-m', 'M0']);
      repo.g(['checkout', '-b', 'pr']);
      repo.put('pr.txt', 'feature\n');
      repo.g(['add', 'pr.txt']);
      repo.g(['commit', '-m', 'A approved']);
      const approved = repo.sha();
      repo.g(['checkout', 'master']);
      repo.put('master.txt', 'from master\n');
      repo.g(['add', 'master.txt']);
      repo.g(['commit', '-m', 'M1']);
      const master = repo.sha();
      repo.g(['checkout', 'pr']);
      repo.g(['merge', '--no-commit', 'master']);
      repo.put('sneak.txt', 'in merge commit\n');
      repo.g(['add', 'sneak.txt']);
      repo.g(['commit', '-m', 'Merge master with extra']);
      const head = repo.sha();
      const r = provePureDock({ approved, head, masterRef: master, run: repo.run });
      assert.equal(r.state, 'red', r.why);
    } finally {
      repo.cleanup();
    }
  });

  it('两边改同一文件导致虚拟合入冲突 → unknown', async () => {
    const { provePureDock } = await LOAD;
    const repo = gitRepo();
    try {
      repo.put('same.txt', 'v1\n');
      repo.g(['add', 'same.txt']);
      repo.g(['commit', '-m', 'M0']);
      repo.g(['checkout', '-b', 'pr']);
      repo.put('same.txt', 'from pr\n');
      repo.g(['add', 'same.txt']);
      repo.g(['commit', '-m', 'A approved']);
      const approved = repo.sha();
      repo.g(['checkout', 'master']);
      repo.put('same.txt', 'from master\n');
      repo.g(['add', 'same.txt']);
      repo.g(['commit', '-m', 'M1']);
      const master = repo.sha();
      const r = provePureDock({ approved, head: approved, masterRef: master, run: repo.run });
      assert.equal(r.state, 'unknown', r.why);
    } finally {
      repo.cleanup();
    }
  });

  it('对象读取失败 → unknown', async () => {
    const { provePureDock } = await LOAD;
    const repo = gitRepo();
    try {
      repo.put('base.txt', 'base\n');
      repo.g(['add', 'base.txt']);
      repo.g(['commit', '-m', 'M0']);
      const master = repo.sha();
      const r = provePureDock({
        approved: 'a'.repeat(40),
        head: 'b'.repeat(40),
        masterRef: master,
        run: repo.run,
      });
      assert.equal(r.state, 'unknown', r.why);
    } finally {
      repo.cleanup();
    }
  });

  it('生产接线 collectDockProofs：纯对接记 ok，偷带记 red', async () => {
    const { collectDockProofs } = await CORE;
    const repo = gitRepo();
    try {
      repo.put('base.txt', 'base\n');
      repo.g(['add', 'base.txt']);
      repo.g(['commit', '-m', 'M0']);
      repo.g(['checkout', '-b', 'pr']);
      repo.put('pr.txt', 'feature\n');
      repo.g(['add', 'pr.txt']);
      repo.g(['commit', '-m', 'A approved']);
      const approved = repo.sha();
      repo.g(['checkout', 'master']);
      repo.put('master.txt', 'from master\n');
      repo.g(['add', 'master.txt']);
      repo.g(['commit', '-m', 'M1']);
      const master = repo.sha();
      repo.g(['checkout', 'pr']);
      repo.g(['merge', '--no-edit', 'master']);
      const cleanHead = repo.sha();
      const clean = collectDockProofs({
        github: { scanned: true, prs: [{ number: 42, headRefOid: cleanHead }] },
        prReviews: { scanned: true, byPr: { 42: { reviews: [{ state: 'APPROVED', commit_id: approved }] } } },
      }, { run: repo.run, masterRef: master });
      assert.equal(clean[42].state, 'ok', JSON.stringify(clean[42]));
      repo.put('evil.txt', 'nope\n');
      repo.g(['add', 'evil.txt']);
      repo.g(['commit', '-m', 'sneak']);
      const dirtyHead = repo.sha();
      const dirty = collectDockProofs({
        github: { scanned: true, prs: [{ number: 42, headRefOid: dirtyHead }] },
        prReviews: { scanned: true, byPr: { 42: { reviews: [{ state: 'APPROVED', commit_id: approved }] } } },
      }, { run: repo.run, masterRef: master });
      assert.equal(dirty[42].state, 'red', JSON.stringify(dirty[42]));
    } finally {
      repo.cleanup();
    }
  });
});
