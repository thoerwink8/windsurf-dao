const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const LOAD = import('file://' + path.join(__dirname, '..', 'scripts', 'lib', 'pr-mark-draft.mjs').replace(/\\/g, '/'));

describe('planMarkDraft：转 draft 失败必须报帅', () => {
  it('成功 → ok，不 escalate', async () => {
    const { planMarkDraft } = await LOAD;
    const r = planMarkDraft({ pr: 1218, run: () => ({ ok: true, out: '' }) });
    assert.equal(r.ok, true);
    assert.equal(r.escalate, undefined);
  });

  it('GitHub 拒了 → escalate，不许装成转成了', async () => {
    const { planMarkDraft } = await LOAD;
    const r = planMarkDraft({
      pr: 1218,
      run: () => ({ ok: false, error: 'Resource not accessible by integration (convertPullRequestToDraft)' }),
    });
    assert.equal(r.ok, false);
    assert.equal(r.escalate, true);
    assert.equal(r.reason, 'manual-draft-failed');
    assert.match(r.why, /报帅/);
    assert.match(r.error, /convertPullRequestToDraft/);
  });

  it('没给 PR / 没给 run → unscanned，不装成转成了', async () => {
    const { planMarkDraft } = await LOAD;
    assert.equal(planMarkDraft({}).unscanned, true);
    assert.equal(planMarkDraft({ pr: 1 }).unscanned, true);
  });
});
