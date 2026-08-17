// nextLaunch / 管子层（#615）
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const FIXTURE = path.join(REPO, 'tests', 'fixtures', 'next-launch-cases.json');
const LIB = path.join(REPO, 'scripts', 'lib', 'next-launch.mjs');

describe('nextLaunch', () => {
  it('夹具四条：瞬时不切 / 2 次硬失败切支路 / 管子尽了换模型 / 名单走完才失败', async (t) => {
    const {
      nextLaunch, classifyLaunchFailure, advanceLaunchState, normalizePipes, attachPipes, buildSlate, routingSlateIds,
    } = await import('file://' + LIB.replace(/\\/g, '/'));
    const doc = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
    assert.ok(Array.isArray(doc.cases) && doc.cases.length >= 4, '夹具至少 4 条');

    for (const c of doc.cases) {
      await t.test(c.name, () => {
        const got = nextLaunch({
          slate: doc.slate,
          modelId: c.modelId,
          pipeIndex: c.pipeIndex,
          hardFailsOnThisPipe: c.hardFailsOnThisPipe,
        });
        assert.ok(got.action === c.expect.action, `${c.name} action  →  ${got.action}`);
        if (c.expect.modelId != null) {
          assert.ok(got.modelId === c.expect.modelId, `${c.name} modelId  →  ${got.modelId}`);
        }
        if (c.expect.pipeIndex != null) {
          assert.ok(got.pipeIndex === c.expect.pipeIndex, `${c.name} pipeIndex  →  ${got.pipeIndex}`);
        }
      });
    }

    await t.test('classify：Cannot use this model = hard', () => {
      assert.ok(classifyLaunchFailure({ text: 'Cannot use this model' }) === 'hard');
    });
    await t.test('classify：空屏超时 = transient', () => {
      assert.ok(classifyLaunchFailure({ verifyReason: '读了是空的' }) === 'transient');
    });
    await t.test('classify：待确认 = config', () => {
      assert.ok(classifyLaunchFailure({ verifyReason: '有待确认提示' }) === 'config');
    });

    await t.test('advance：瞬时第一次不切、不计入 hardFails', () => {
      const r = advanceLaunchState({
        slate: doc.slate, modelId: 'kimi-k3', pipeIndex: 0,
        hardFailsOnThisPipe: 0, transientFailsOnThisPipe: 0, kind: 'transient',
      });
      assert.ok(r.action === 'retry' && r.pipeIndex === 0 && r.hardFailsOnThisPipe === 0, JSON.stringify(r));
    });
    await t.test('advance：连续 2 次硬失败切支路', () => {
      const r = advanceLaunchState({
        slate: doc.slate, modelId: 'kimi-k3', pipeIndex: 0,
        hardFailsOnThisPipe: 1, transientFailsOnThisPipe: 0, kind: 'hard',
      });
      assert.ok(r.action === 'switch_pipe' && r.pipeIndex === 1 && r.modelId === 'kimi-k3', JSON.stringify(r));
    });

    await t.test('normalizePipes：缺省一根', () => {
      const p = normalizePipes({ id: 'grok-4.6', provider: 'grok' });
      assert.ok(p.length === 1 && p[0].provider === 'grok' && p[0].cli_model === 'grok-4.6', JSON.stringify(p));
    });
    await t.test('attachPipes：丢掉幽灵 id', () => {
      const s = attachPipes(['kimi-k3', 'ghost'], [
        { id: 'kimi-k3', provider: 'cursor', cli_model: 'kimi-k3-high' },
      ]);
      assert.ok(s.length === 1 && s[0].id === 'kimi-k3' && s[0].pipes[0].provider === 'cursor', JSON.stringify(s));
    });

    await t.test('buildSlate：路由第一、fallback 是下一模型', () => {
      const passers = [{ model: 'grok-4.6' }, { model: 'deepseek-v4-flash' }, { model: 'kimi-k3' }];
      const ids = buildSlate({
        passers,
        matchedRoute: { model: 'grok-4.6', fallback: 'deepseek-v4-flash' },
        byScore: [{ model: 'kimi-k3' }, { model: 'grok-4.6' }, { model: 'deepseek-v4-flash' }],
      });
      assert.ok(ids[0] === 'grok-4.6' && ids[1] === 'deepseek-v4-flash' && ids[2] === 'kimi-k3', JSON.stringify(ids));
    });
    await t.test('buildSlate：被门闩剔的不进名单', () => {
      const ids = buildSlate({
        passers: [{ model: 'deepseek-v4-flash' }],
        matchedRoute: { model: 'grok-4.6', fallback: 'deepseek-v4-flash' },
        byScore: [{ model: 'deepseek-v4-flash' }],
      });
      assert.ok(ids[0] === 'deepseek-v4-flash' && !ids.includes('grok-4.6'), JSON.stringify(ids));
    });

    await t.test('routingSlateIds：峰时写码 grok 第一、flash 第二', () => {
      const routing = {
        routes: [{ role: '写码', beijing: '09:00-12:00,14:00-18:00', model: 'grok-4.6', fallback: 'deepseek-v4-flash' }],
        models: [{ id: 'grok-4.6' }, { id: 'deepseek-v4-flash' }, { id: 'kimi-k3' }],
      };
      const ids = routingSlateIds({ routing, role: '写码', now: '2026-08-18T10:00:00+08:00', model: 'grok-4.6' });
      assert.ok(ids[0] === 'grok-4.6' && ids[1] === 'deepseek-v4-flash', JSON.stringify(ids));
    });
  });
});
