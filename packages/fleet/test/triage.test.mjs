// T33：当场修 vs 进册子——判据在代码里。纯函数喂样本。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { triageFinding, splitFindings, EFFORTS, SLA_IMMEDIATE_TYPES } from '../src/triage.mjs';

describe('triage：当场修 vs 进册子', () => {
  it('P1 一律当场修（阻塞合并，不变）', () => {
    assert.equal(triageFinding({ finding: { severity: 'P1', detail: 'x' } }), 'rework');
    assert.equal(triageFinding({ finding: { severity: 'P1', type: 'ui', effort: 'large' }, resumable: false }), 'rework');
  });

  it('类型落在 SLA「立即」列（security/data/contract）→ 当场修，不看 effort', () => {
    for (const type of SLA_IMMEDIATE_TYPES) {
      assert.equal(triageFinding({ finding: { severity: 'P3', type, effort: 'large' }, resumable: false }), 'rework', type);
    }
  });

  it('便宜且上下文还热（small + 可续跑）→ 当场修；上下文不热就进册子', () => {
    const f = { severity: 'P2', type: 'maintainability', effort: 'small' };
    assert.equal(triageFinding({ finding: f, resumable: true }), 'rework');
    assert.equal(triageFinding({ finding: f, resumable: false }), 'debt');
  });

  it('其余进册子（P2/P3 的 maintainability/ui/perf 大改）', () => {
    assert.equal(triageFinding({ finding: { severity: 'P2', type: 'perf', effort: 'medium' }, resumable: true }), 'debt');
    assert.equal(triageFinding({ finding: { severity: 'P3', type: 'ui', effort: 'large' }, resumable: true }), 'debt');
    assert.equal(triageFinding({ finding: { severity: 'P2', type: 'maintainability', effort: 'small' } }), 'debt');
    assert.ok(EFFORTS.includes('small'));
  });

  it('splitFindings：按判据分成返工与册子两堆', () => {
    const p1 = { id: 'a', severity: 'P1', detail: 'd' };
    const small = { id: 'b', severity: 'P2', type: 'perf', effort: 'small', detail: 'd' };
    const big = { id: 'c', severity: 'P2', type: 'perf', effort: 'large', detail: 'd' };
    const r = splitFindings({ findings: [p1, small, big], resumable: true });
    assert.deepEqual(r.rework.map((f) => f.id), ['a', 'b']);
    assert.deepEqual(r.debt.map((f) => f.id), ['c']);
  });
});
