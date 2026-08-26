// #780 修复回归：isLiveDispatchRecipient / findDispatchForWorktree 死信箱判据
//
// 验的层：
// ① isLiveDispatchRecipient：completed/succeeded 是死信箱，agent_prompt_stalled 不复活
// ② isLiveDispatchRecipient：failed + agent_prompt_stalled 仍当活（devin 假阴性例外）
// ③ findDispatchForWorktree：failed + retained 不再无条件下放为活（需 lastFailure 配合）
// ④ findDispatchForWorktree：completed/succeeded 不当收件人

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

  it('failed + retained + lastFailure=agent_prompt_stalled → 活', async () => {
    const { findDispatchForWorktree } = await DAO_CMD_LOAD;

    const wl = {
      result: {
        workers: [
          {
            workerState: 'failed',
            dispatchStatus: 'failed',
            terminalState: 'retained',
            lastFailure: 'agent_prompt_stalled',
            dispatchId: 'd4',
            taskId: 't4',
            runId: 'r4',
            resource: { worktreeId: 'wt-4' },
          },
        ],
      },
    };
    const found = findDispatchForWorktree(wl, 'wt-4');
    assert.strictEqual(found.ok, true, 'failed + retained + agent_prompt_stalled → 活');
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
});
