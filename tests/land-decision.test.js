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
