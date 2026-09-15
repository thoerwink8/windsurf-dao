const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const LOAD = import('file://' + path.join(__dirname, '..', 'scripts', 'lib', 'land-decision.mjs').replace(/\\/g, '/'));

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
  it('GitHub 聚合 APPROVED → 可合', async () => {
    const { approvedToLand } = await LOAD;
    assert.equal(approvedToLand({ decisionApproved: true, atHead: 0, lastJudgment: null }), true);
  });
  it('旧 head 上核绿、新 head 还没判定 → 可合（对接 master，不再审）', async () => {
    const { approvedToLand } = await LOAD;
    assert.equal(approvedToLand({
      greenAtHead: false, decisionApproved: false, atHead: 0, lastJudgment: 'APPROVED',
    }), true);
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

  // 2026-09-13：这一档是写完收窄当天被 tests/commander.test.js + tests/exhausted.test.js
  // 当场抓住的——夹具只给 prs 不给 issues，于是「没扫到」被当成「查过是 manual」，
  // 一整片无关用例的每条判绿 PR 都变成「待人工合并」。
  it('unscanned（没扫到 issue）**不拦**——没查成 ≠ 查过是 manual', async () => {
    const { approvedToLand } = await LOAD;
    assert.equal(approvedToLand({
      greenAtHead: true, mergePolicy: 'manual', mergePolicySource: 'unscanned',
    }), true, '没扫到不该把这张 PR 变成待人工合并');
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
