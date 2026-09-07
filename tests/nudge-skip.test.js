const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const LOAD = import('file://' + path.join(__dirname, '..', 'scripts', 'lib', 'nudge-skip.mjs').replace(/\\/g, '/'));

describe('推一把：已结束的单必须跳过', () => {
  it('工人 issue CLOSED → skip', async () => {
    const { shouldSkipNudge } = await LOAD;
    const r = shouldSkipNudge({ kind: '工人', issueState: 'CLOSED' });
    assert.equal(r.skip, true);
    assert.match(r.why, /已关/);
  });

  it('工人 issue 态没查成 → skip（fail-close，不许误推已关单）', async () => {
    const { shouldSkipNudge } = await LOAD;
    const r = shouldSkipNudge({ kind: '工人', issueUnscanned: true });
    assert.equal(r.skip, true);
  });

  it('工人 issue OPEN → 不 skip', async () => {
    const { shouldSkipNudge } = await LOAD;
    const r = shouldSkipNudge({ kind: '工人', issueState: 'OPEN' });
    assert.equal(r.skip, false);
  });

  it('审官 PR MERGED → skip', async () => {
    const { shouldSkipNudge } = await LOAD;
    const r = shouldSkipNudge({ kind: '审官', prState: 'MERGED' });
    assert.equal(r.skip, true);
  });

  it('审官 PR OPEN → 不 skip', async () => {
    const { shouldSkipNudge } = await LOAD;
    const r = shouldSkipNudge({ kind: '审官', prState: 'OPEN' });
    assert.equal(r.skip, false);
  });
});
