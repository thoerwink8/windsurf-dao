// T39 ④：上报指挥官裁决的载荷（机器可读）。纯函数喂样本。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildEscalation, escalationFileName, ESCALATION_OPTIONS } from '../src/escalation.mjs';

const task = {
  id: 'dao/owner/repo/issue/17/g1', repository: 'owner/repo', issue: 17, generation: 1,
  limits: { reviewRounds: 3, stepTimeoutSeconds: 60 },
};
const state = {
  state: 'blocked', phase: 'reviewing', round: 3, acceptedHead: null,
  artifact: { head: 'a'.repeat(40), legSwappedTo: 'exec-alt' },
  checks: { checks: [{ name: 'check', status: 'COMPLETED', conclusion: 'SUCCESS' }] },
  advisory: [{ id: 'x' }, { id: 'y' }], riskTier: 'T2',
};

describe('T39：裁决载荷', () => {
  it('带全「卡在哪 / 凭什么 / 试过什么 / 还能选谁」', () => {
    const p = buildEscalation({ task, state, reason: 'review-budget-exhausted', extra: { failureClass: 'unscanned' } });
    assert.equal(p.taskId, task.id);
    assert.equal(p.repository, 'owner/repo');
    assert.equal(p.issue, 17);
    assert.equal(p.phase, 'reviewing');
    assert.equal(p.blockedReason, 'review-budget-exhausted');
    assert.equal(p.failureClass, 'unscanned');
    assert.deepEqual(p.attempts, { round: 3, reviewRounds: 3 });
    assert.equal(p.evidence.head, 'a'.repeat(40));
    assert.equal(p.evidence.advisoryCount, 2);
    assert.equal(p.evidence.legSwappedTo, 'exec-alt');
    assert.equal(p.evidence.riskTier, 'T2');
    assert.deepEqual(p.options, [...ESCALATION_OPTIONS]);
    assert.deepEqual(p.candidates, [], '候补腿由 escalate 活动补齐，纯函数里留空');
  });

  it('只放判据不放叙述：缺的字段是 null，不是编造', () => {
    const p = buildEscalation({ task: { id: 't', repository: 'r', issue: 1 }, state: {} });
    assert.equal(p.evidence.head, null);
    assert.equal(p.evidence.checks, null);
    assert.equal(p.evidence.advisoryCount, null);
    assert.equal(p.attempts.round, null);
    assert.equal(p.blockedReason, null);
  });

  it('空输入不抛', () => {
    const p = buildEscalation({});
    assert.equal(p.taskId, null);
    assert.equal(p.state, null);
    assert.deepEqual(p.options, [...ESCALATION_OPTIONS]);
  });

  it('落点文件名把 / 换成 _（别在文件名里造目录层级）', () => {
    assert.equal(escalationFileName('dao/owner/repo/issue/17/g1'), 'dao_owner_repo_issue_17_g1.json');
    assert.equal(escalationFileName(undefined), 'unknown.json');
  });
});
