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

describe('analyzeReviewsAtHead', () => {
  it('当前 HEAD 的 APPROVED 被 DISMISSED 后不再算绿', async () => {
    const { analyzeReviewsAtHead } = await CORE;
    const head = 'h'.repeat(40);
    const r = analyzeReviewsAtHead([
      { state: 'APPROVED', commit_id: head },
      { state: 'DISMISSED', commit_id: head },
    ], head);
    assert.equal(r.scanned, true);
    assert.equal(r.latestGreen, false);
    assert.equal(r.latestRed, false);
    assert.equal(r.atHead, 0);
    assert.deepEqual(r.judged, []);
  });
});

describe('lastApprovedCommitId', () => {
  const cid = (n) => String(n).repeat(40);
  it('最后一条是 APPROVED → 取出该 commit', async () => {
    const { lastApprovedCommitId } = await LOAD;
    const r = lastApprovedCommitId([
      { state: 'APPROVED', commit_id: cid('a') },
    ]);
    assert.equal(r.scanned, true);
    assert.equal(r.commit, cid('a'));
    assert.equal(r.revoked, undefined);
  });
  it('APPROVED 后 DISMISSED → 撤销继承，不返回旧 commit', async () => {
    const { lastApprovedCommitId } = await LOAD;
    const r = lastApprovedCommitId([
      { state: 'APPROVED', commit_id: cid('a') },
      { state: 'DISMISSED', commit_id: cid('a') },
    ]);
    assert.equal(r.scanned, true);
    assert.equal(r.commit, null);
    assert.equal(r.revoked, true);
  });
  it('DISMISSED 之后又有新 APPROVED → 认新批准', async () => {
    const { lastApprovedCommitId } = await LOAD;
    const r = lastApprovedCommitId([
      { state: 'APPROVED', commit_id: cid('a') },
      { state: 'DISMISSED', commit_id: cid('a') },
      { state: 'APPROVED', commit_id: cid('b') },
    ]);
    assert.equal(r.scanned, true);
    assert.equal(r.commit, cid('b'));
    assert.equal(r.revoked, undefined);
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
  it('当前 HEAD 红优先：聚合 APPROVED 也不可合（latestRed 别名）', async () => {
    const { approvedToLand } = await LOAD;
    assert.equal(approvedToLand({
      decisionApproved: true, greenAtHead: false, latestRed: true, atHead: 1,
    }), false);
  });
  it('当前 HEAD 红优先：旧 head 绿也不可合', async () => {
    const { approvedToLand } = await LOAD;
    assert.equal(approvedToLand({
      greenAtHead: false, atHead: 1, lastJudgment: 'APPROVED', latestRed: true,
    }), false);
  });
});

// #1223（用户 2026-09-13 拍板选项①）：m=manual 必须是一路输入，不许从 pr.isDraft 反推。
// 现场：PR #1218 转 draft 被 GitHub 拒 → isDraft=false → 判绿就合，manual 静默失效。
describe('approvedToLand 认 mergePolicy（#1218 那一格）', () => {
  it('manual + 判绿 → **不可合**（旧行为是可合，这正是 #1218）', async () => {
    const { approvedToLand } = await LOAD;
    assert.equal(approvedToLand({ greenAtHead: true, mergePolicy: 'manual' }), false);
  });
  it('manual + reviewDecision=APPROVED → 也不可合', async () => {
    const { approvedToLand } = await LOAD;
    assert.equal(approvedToLand({ decisionApproved: true, mergePolicy: 'manual' }), false);
  });
  it('manual + 旧 head 绿新 head 零判定 → 也不可合', async () => {
    const { approvedToLand } = await LOAD;
    assert.equal(approvedToLand({ atHead: 0, lastJudgment: 'APPROVED', mergePolicy: 'manual' }), false);
  });
  it('正控：auto 照旧可合（收严只收 manual 那一格）', async () => {
    const { approvedToLand } = await LOAD;
    assert.equal(approvedToLand({ greenAtHead: true, mergePolicy: 'auto' }), true);
  });
  it('正控：不传 mergePolicy（老调用方/夹具）→ 维持原行为，不凭猜收严', async () => {
    const { approvedToLand } = await LOAD;
    assert.equal(approvedToLand({ greenAtHead: true }), true);
    assert.equal(approvedToLand({ greenAtHead: true, mergePolicy: null }), true);
  });
  it('正控：不绿时 manual 与 auto 一样不可合（没把它放宽）', async () => {
    const { approvedToLand } = await LOAD;
    assert.equal(approvedToLand({ mergePolicy: 'manual' }), false);
    assert.equal(approvedToLand({ mergePolicy: 'auto' }), false);
  });

  // #1223：没查成不许退回 auto。旧实现把 unscanned 排除出闸，署名单没扫到就直接合。
  it('unscanned（没查成）也拦——不许退回 auto', async () => {
    const { approvedToLand } = await LOAD;
    assert.equal(approvedToLand({
      greenAtHead: true, mergePolicy: 'manual', mergePolicySource: 'unscanned',
    }), false, '没查成不许开自动合门');
  });
  it('正控：查过确实是 manual 的两档都拦', async () => {
    const { approvedToLand } = await LOAD;
    assert.equal(approvedToLand({
      greenAtHead: true, mergePolicy: 'manual', mergePolicySource: 'framework',
    }), false);
    assert.equal(approvedToLand({
      greenAtHead: true, mergePolicy: 'manual', mergePolicySource: 'hold',
    }), false);
  });
});

describe('manualMergeApproved：manual 的拍板证据（非 draft 那一格）', () => {
  const mkPr = (over = {}) => ({
    number: 1218, isDraft: false, headRefOid: 'h1', mergeable: 'MERGEABLE',
    body: '署名 issue #1174',
    statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }],
    ...over,
  });
  const mkIssue = (over = {}) => ({
    number: 1174, labels: [{ name: '已拍板' }, { name: '已消歧' }], ...over,
  });
  const ev = () => {
    const M = require('../scripts/lib/approved-merge.mjs');
    return {
      explicitApprovalIssue: M.explicitApprovalIssue,
      isApprovedExecutionTask: M.isApprovedExecutionTask,
      checksSucceeded: M.checksSucceeded,
    };
  };

  it('证据齐（批准单 + 已拍板）+ 当前 head 绿 → 放行', async () => {
    const { manualMergeApproved } = await LOAD;
    const r = manualMergeApproved({ pr: mkPr(), issue: mkIssue(), greenAtHead: true, evidence: ev() });
    assert.equal(r.ok, true, JSON.stringify(r));
  });

  it('**非 draft 也不放行**——没批准单（#1218 的真实形状：正文没有批准单署名）', async () => {
    const { manualMergeApproved } = await LOAD;
    const r = manualMergeApproved({
      pr: mkPr({ body: '起因：usage-family-attr' }), issue: mkIssue(), greenAtHead: true, evidence: ev(),
    });
    assert.equal(r.ok, false);
    assert.match(r.why, /批准单/);
  });

  it('单上没有「已拍板」→ 不放行（人还没拍）', async () => {
    const { manualMergeApproved } = await LOAD;
    const r = manualMergeApproved({
      pr: mkPr(), issue: mkIssue({ labels: [{ name: '已消歧' }] }), greenAtHead: true, evidence: ev(),
    });
    assert.equal(r.ok, false);
    assert.match(r.why, /已拍板/);
  });

  it('当前 head 上没绿 → 不放行', async () => {
    const { manualMergeApproved } = await LOAD;
    const r = manualMergeApproved({ pr: mkPr(), issue: mkIssue(), greenAtHead: false, evidence: ev() });
    assert.equal(r.ok, false);
    assert.match(r.why, /没绿/);
  });

  it('CI 没全绿 → 不放行（没查成 ≠ 绿）', async () => {
    const { manualMergeApproved } = await LOAD;
    const r = manualMergeApproved({
      pr: mkPr({ statusCheckRollup: [] }), issue: mkIssue(), greenAtHead: true, evidence: ev(),
    });
    assert.equal(r.ok, false);
    assert.match(r.why, /check/);
  });

  it('判据没给全 / 没给 pr → 不放行（fail-close，不凭猜）', async () => {
    const { manualMergeApproved } = await LOAD;
    assert.equal(manualMergeApproved({ pr: mkPr(), issue: mkIssue(), greenAtHead: true }).ok, false);
    assert.equal(manualMergeApproved({ issue: mkIssue(), greenAtHead: true, evidence: ev() }).ok, false);
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

  it('APPROVED 后 DISMISSED → 对接证明 unknown，即使树级取证会相同', async () => {
    const { collectDockProofs } = await CORE;
    const { lastJudgmentOf } = await LOAD;
    const { analyzeReviews } = await CORE;
    const approved = 'a'.repeat(40);
    const head = 'b'.repeat(40);
    const tree = 'c'.repeat(40);
    let mergeTree = 0;
    const run = (argv) => {
      if (argv[0] === 'git' && argv[1] === 'merge-tree') {
        mergeTree += 1;
        return { ok: true, out: `${tree}\n` };
      }
      if (argv[0] === 'git' && argv[1] === 'rev-parse') {
        return { ok: true, out: `${String(argv[argv.length - 1]).replace(/\^{commit}$/, '')}\n` };
      }
      return { ok: true, out: '' };
    };
    const reviews = [
      { state: 'APPROVED', commit_id: approved },
      { state: 'DISMISSED', commit_id: approved },
    ];
    assert.equal(lastJudgmentOf(analyzeReviews(reviews)), null, '撤销后最后判别不得仍是 APPROVED');
    const r = collectDockProofs({
      github: { scanned: true, prs: [{ number: 1, headRefOid: head }] },
      prReviews: { scanned: true, byPr: { 1: { reviews } } },
    }, { run, masterRef: 'd'.repeat(40) });
    assert.equal(r[1].state, 'unknown', JSON.stringify(r[1]));
    assert.match(String(r[1].why), /DISMISSED|撤销/);
    assert.equal(mergeTree, 0, '撤销后不许再拿树级相同当继承');
  });
});
