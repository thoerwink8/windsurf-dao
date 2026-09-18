// limits：活动超时的算术。这条被独立复核咬过一次（P1）：宽限里叠 sleep 会让真实墙钟变 2×，
// 预算就盖不住，Temporal 会在「停会话让树」之前掐死活动——原阻塞会复活。算术只许有一处出处。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { activityBudgetSeconds, DEFAULT_UNKNOWN_WAIT_MS, DEFAULT_UNKNOWN_WAIT_ROUNDS, STEP_CLOSE_MARGIN_SECONDS } from '../src/limits.mjs';

describe('activity budget covers the worst path of one session step', () => {
  it('按生产默认值：stepTimeout + 每轮一次 waitForCompletion + 收尾余量', () => {
    const stepTimeoutSeconds = 1800;
    const graceSeconds = (DEFAULT_UNKNOWN_WAIT_MS * DEFAULT_UNKNOWN_WAIT_ROUNDS) / 1000;
    assert.equal(graceSeconds, 360);
    assert.equal(activityBudgetSeconds({ stepTimeoutSeconds }), stepTimeoutSeconds + graceSeconds + STEP_CLOSE_MARGIN_SECONDS);
  });
  it('预算必须大于等于真实墙钟（首轮 + 宽限），不留负余量', () => {
    const stepTimeoutSeconds = 1800;
    const worstCase = stepTimeoutSeconds + (DEFAULT_UNKNOWN_WAIT_MS * DEFAULT_UNKNOWN_WAIT_ROUNDS) / 1000;
    assert.ok(activityBudgetSeconds({ stepTimeoutSeconds }) >= worstCase, '预算盖不住墙钟时 Temporal 会掐死活动');
  });
  it('按注入的宽限参数缩放', () => {
    assert.equal(activityBudgetSeconds({ stepTimeoutSeconds: 60, unknownWaitMs: 1000, unknownWaitRounds: 2 }), 60 + 2 + STEP_CLOSE_MARGIN_SECONDS);
    assert.equal(activityBudgetSeconds({ stepTimeoutSeconds: 60, unknownWaitMs: 0, unknownWaitRounds: 0 }), 60 + STEP_CLOSE_MARGIN_SECONDS);
  });
  it('缺参数一律抛，不猜', () => {
    assert.throws(() => activityBudgetSeconds({ stepTimeoutSeconds: 0 }), /positive step timeout/);
    assert.throws(() => activityBudgetSeconds({ stepTimeoutSeconds: 60, unknownWaitRounds: 1.5 }), /round count/);
    assert.throws(() => activityBudgetSeconds({ stepTimeoutSeconds: 60, unknownWaitMs: -1 }), /unknown wait/);
  });
});
