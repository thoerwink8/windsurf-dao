// #780/#781 修复回归：isLiveDispatchRecipient / findDispatchForWorktree 死信箱判据
//
// 验的层：
// ① isLiveDispatchRecipient：completed/succeeded/cancelled/... 是死信箱，agent_prompt_stalled 不复活
// ② isLiveDispatchRecipient：failed + agent_prompt_stalled 仍当活（devin 假阴性例外）
// ③ isLiveDispatchRecipient：混合态 completed/failed、succeeded/failed、failed/completed、failed/succeeded 全判死（#781）
// ④ findDispatchForWorktree：不从 worker-list 项读 last_failure（字段不存在），用 resolveLastFailure 回调取真实值
// ⑤ findDispatchForWorktree：completed/succeeded 不当收件人

const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const DELIVER_LOAD = import('file://' + path.join(REPO, 'scripts', 'lib', 'dispatch', 'deliver.mjs').replace(/\\/g, '/'));
const DAO_CMD_LOAD = import('file://' + path.join(REPO, 'scripts', 'lib', 'dao-cmd.mjs').replace(/\\/g, '/'));

describe('#780 isLiveDispatchRecipient 死信箱判据', () => {
  it('completed/succeeded 不因 agent_prompt_stalled 复活', async () => {
    const { isLiveDispatchRecipient } = await DELIVER_LOAD;

    assert.strictEqual(
      isLiveDispatchRecipient({ workerState: 'completed', dispatchStatus: 'completed', lastFailure: 'agent_prompt_stalled' }),
      false,
      'completed + agent_prompt_stalled → 死'
    );
    assert.strictEqual(
      isLiveDispatchRecipient({ workerState: 'succeeded', dispatchStatus: 'succeeded', lastFailure: 'agent_prompt_stalled' }),
      false,
      'succeeded + agent_prompt_stalled → 死'
    );
    assert.strictEqual(
      isLiveDispatchRecipient({ workerState: 'completed', dispatchStatus: 'dispatched', lastFailure: 'agent_prompt_stalled' }),
      false,
      'worker completed + agent_prompt_stalled → 死（worker 态优先）'
    );
  });

  it('failed + agent_prompt_stalled 仍当活（devin 假阴性例外）', async () => {
    const { isLiveDispatchRecipient } = await DELIVER_LOAD;

    assert.strictEqual(
      isLiveDispatchRecipient({ workerState: 'failed', dispatchStatus: 'failed', lastFailure: 'agent_prompt_stalled' }),
      true,
      'failed + agent_prompt_stalled → 活（devin --prompt-file 假阴性）'
    );
    assert.strictEqual(
      isLiveDispatchRecipient({ dispatchStatus: 'failed', lastFailure: 'agent_prompt_stalled' }),
      true,
      'dispatch failed + agent_prompt_stalled → 活'
    );
  });

  it('failed 无 agent_prompt_stalled → 死', async () => {
    const { isLiveDispatchRecipient } = await DELIVER_LOAD;

    assert.strictEqual(
      isLiveDispatchRecipient({ workerState: 'failed', dispatchStatus: 'failed', lastFailure: 'crashed' }),
      false,
      'failed + crashed → 死'
    );
    assert.strictEqual(
      isLiveDispatchRecipient({ workerState: 'failed', dispatchStatus: 'failed', lastFailure: null }),
      false,
      'failed + 无 lastFailure → 死'
    );
  });

  it('活态 ready/working/waiting → 活', async () => {
    const { isLiveDispatchRecipient } = await DELIVER_LOAD;

    for (const state of ['ready', 'working', 'waiting']) {
      assert.strictEqual(
        isLiveDispatchRecipient({ workerState: state, dispatchStatus: 'dispatched' }),
        true,
        `${state} → 活`
      );
    }
  });

  it('cancelled/released/stopped → 死（无 stalled 例外）', async () => {
    const { isLiveDispatchRecipient } = await DELIVER_LOAD;

    for (const state of ['cancelled', 'canceled', 'released', 'stopped']) {
      assert.strictEqual(
        isLiveDispatchRecipient({ workerState: state, dispatchStatus: 'dispatched', lastFailure: 'agent_prompt_stalled' }),
        false,
        `${state} + agent_prompt_stalled → 死（非 failed 不享例外）`
      );
    }
  });

  it('#781 混合态 completed/succeeded + failed 全判死（不许因一边 failed 复活已结算信箱）', async () => {
    const { isLiveDispatchRecipient } = await DELIVER_LOAD;

    // 四种混合态：一边终态成功、另一边 failed，且 lastFailure 带 agent_prompt_stalled。
    // 旧实现 `(w === 'failed' || d === 'failed')` 只要一边 failed 就放行 → 全部错误返回 true。
    const mixed = [
      { workerState: 'completed', dispatchStatus: 'failed', lastFailure: 'agent_prompt_stalled' },
      { workerState: 'succeeded', dispatchStatus: 'failed', lastFailure: 'agent_prompt_stalled' },
      { workerState: 'failed', dispatchStatus: 'completed', lastFailure: 'agent_prompt_stalled' },
      { workerState: 'failed', dispatchStatus: 'succeeded', lastFailure: 'agent_prompt_stalled' },
    ];
    for (const c of mixed) {
      assert.strictEqual(
        isLiveDispatchRecipient(c),
        false,
        `${c.workerState}/${c.dispatchStatus} + agent_prompt_stalled → 死（终态成功在场，例外不生效）`
      );
    }
  });
});

describe('#780 findDispatchForWorktree 死信箱判据', () => {
  it('completed dispatch 不当收件人', async () => {
    const { findDispatchForWorktree } = await DAO_CMD_LOAD;

    const wl = {
      result: {
        workers: [
          {
            workerState: 'completed',
            dispatchStatus: 'completed',
            dispatchId: 'd1',
            taskId: 't1',
            runId: 'r1',
            resource: { worktreeId: 'wt-1' },
          },
        ],
      },
    };
    const found = findDispatchForWorktree(wl, 'wt-1');
    assert.strictEqual(found.ok, false, 'completed → 不当收件人');
    assert.ok(/已结算/.test(found.error), 'error 含「已结算」');
  });

  it('succeeded dispatch 不当收件人', async () => {
    const { findDispatchForWorktree } = await DAO_CMD_LOAD;

    const wl = {
      result: {
        workers: [
          {
            workerState: 'succeeded',
            dispatchStatus: 'succeeded',
            dispatchId: 'd2',
            taskId: 't2',
            runId: 'r2',
            resource: { worktreeId: 'wt-2' },
          },
        ],
      },
    };
    const found = findDispatchForWorktree(wl, 'wt-2');
    assert.strictEqual(found.ok, false, 'succeeded → 不当收件人');
  });

  it('failed + retained 无 lastFailure → 死（不再无条件下放）', async () => {
    const { findDispatchForWorktree } = await DAO_CMD_LOAD;

    const wl = {
      result: {
        workers: [
          {
            workerState: 'failed',
            dispatchStatus: 'failed',
            terminalState: 'retained',
            dispatchId: 'd3',
            taskId: 't3',
            runId: 'r3',
            resource: { worktreeId: 'wt-3' },
          },
        ],
      },
    };
    const found = findDispatchForWorktree(wl, 'wt-3');
    assert.strictEqual(found.ok, false, 'failed + retained 无 lastFailure → 死');
  });

  it('failed + retained + worker-show last_failure=agent_prompt_stalled → 活（真实路径）', async () => {
    const { findDispatchForWorktree } = await DAO_CMD_LOAD;

    // #781：worker-list 项没有 last_failure 字段，真实 last_failure 来自 worker-show。
    // 这里用 resolveLastFailure 回调模拟 worker-show 返回 agent_prompt_stalled。
    const wl = {
      result: {
        workers: [
          {
            workerState: 'failed',
            dispatchStatus: 'failed',
            terminalState: 'retained',
            dispatchId: 'd4',
            taskId: 't4',
            runId: 'r4',
            resource: { worktreeId: 'wt-4' },
          },
        ],
      },
    };
    const resolveLastFailure = (id) => (id === 'd4' ? 'agent_prompt_stalled' : null);
    const found = findDispatchForWorktree(wl, 'wt-4', resolveLastFailure);
    assert.strictEqual(found.ok, true, 'failed + retained + worker-show agent_prompt_stalled → 活');
    assert.strictEqual(found.dispatchId, 'd4', 'dispatchId 正确');
  });

  it('ready dispatch → 活收件人', async () => {
    const { findDispatchForWorktree } = await DAO_CMD_LOAD;

    const wl = {
      result: {
        workers: [
          {
            workerState: 'ready',
            dispatchStatus: 'dispatched',
            dispatchId: 'd5',
            taskId: 't5',
            runId: 'r5',
            resource: { worktreeId: 'wt-5' },
          },
        ],
      },
    };
    const found = findDispatchForWorktree(wl, 'wt-5');
    assert.strictEqual(found.ok, true, 'ready → 活');
    assert.strictEqual(found.dispatchId, 'd5', 'dispatchId 正确');
  });

  it('#781 真实 worker-list 字段形状（无 lastFailure/last_failure）failed 不靠不存在字段', async () => {
    const { findDispatchForWorktree } = await DAO_CMD_LOAD;

    // 真实 orca orchestration worker-list --json 项没有 lastFailure/last_failure 字段
    // （审官扫本机 303 个 failed Dispatch 确认）。钉死形状：故意不写这两个键，
    // 确认函数不读它们、无回调时 failed fail-close 判死。
    const wl = {
      result: {
        workers: [
          {
            dispatchId: 'd_real',
            workerState: 'failed',
            dispatchStatus: 'failed',
            terminalState: 'retained',
            taskId: 't_real',
            runId: 'r_real',
            resource: { worktreeId: 'wt-real' },
          },
        ],
      },
    };
    // 无回调：failed fail-close 判死（不是没查成）
    const foundNoCb = findDispatchForWorktree(wl, 'wt-real');
    assert.strictEqual(foundNoCb.ok, false, '无 resolveLastFailure → failed fail-close 判死');
    assert.strictEqual(foundNoCb.unscanned, false, '不是没查成，是查到死');
    assert.ok(/已结算/.test(foundNoCb.error), 'error 含「已结算」');
    // 回调返回非 stalled → 仍死
    const foundNotStalled = findDispatchForWorktree(wl, 'wt-real', () => 'crashed');
    assert.strictEqual(foundNotStalled.ok, false, 'worker-show last_failure 非 stalled → 死');
    // 回调返回 null（worker-show 没查成）→ fail-close 死，不许当活人
    const foundNull = findDispatchForWorktree(wl, 'wt-real', () => null);
    assert.strictEqual(foundNull.ok, false, 'worker-show 没查成 → fail-close 死');
  });
});
