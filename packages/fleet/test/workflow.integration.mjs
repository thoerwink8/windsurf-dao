import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { ApplicationFailure } from '@temporalio/activity';
import { bundleWorkflowCode, Worker } from '@temporalio/worker';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { normalizeTask } from '../src/contract.mjs';

const H = 'a'.repeat(40);
const B = 'b'.repeat(40);
const M = 'c'.repeat(40);
const spec = repository => ({ repository, issue: 17, generation: 1,
  contract: { requiredChecks: ['check'], deploymentRequired: false },
  limits: { reviewRounds: 2, stepTimeoutSeconds: 60 },
  roles: {
    lead: { profile: 'lead', family: 'openai', accountPool: 'a' },
    executor: { profile: 'executor', family: 'xai', accountPool: 'b' },
    reviewer: { profile: 'reviewer', family: 'anthropic', accountPool: 'c' },
  },
});
function activities(overrides = {}) {
  const calls = [];
  const methods = {
    prepare: async task => ({ repository: task.repository, head: B, checkpoint: 'base' }),
    lead: async () => ({ plan: 'Implement.' }),
    execute: async task => ({ repository: task.repository, head: H, checkpoint: 'code' }),
    verify: async () => ({ scanned: true, head: H, checks: [{ name: 'check', status: 'COMPLETED', conclusion: 'SUCCESS' }] }),
    // T33/T34 之后 runner 会调这两个活动——假活动里没有，工作流就卡在「activity not found」的重试上。
    // 这正是 #1422 的由来：fleet 测试不在 CI 面上，改坏了只有本地跑的人知道。
    selfReview: async () => ({ scanned: true, head: H, findings: [] }),
    changedFiles: async () => ({ scanned: true, files: ['scripts/lib/x.mjs'] }),
    review: async () => ({ completed: true, head: H, findings: [], identityVerified: true, executorFamily: 'xai', reviewerFamily: 'anthropic' }),
    integrate: async task => ({ repository: task.repository, issue: task.issue, pr: 19, merged: true, sourceHead: H, mergeCommit: M, baseRefName: 'master' }),
    deploy: async () => ({ checked: true, healthy: true, commit: M }),
    closeIssue: async task => ({ repository: task.repository, issue: task.issue, closed: true }),
    cleanup: async () => ({ verified: true }),
    ...overrides,
  };
  return { calls, handlers: Object.fromEntries(Object.entries(methods).map(([name, fn]) => [name, async (...args) => { calls.push({ name, taskId: args[0].id }); return fn(...args); }])) };
}
async function waitForState(handle, wanted) {
  let current;
  for (let i = 0; i < 100; i += 1) {
    current = await handle.query('status');
    if (current.state === wanted) return current;
    await sleep(100);
  }
  throw new Error(`State did not reach ${wanted}: ${JSON.stringify(current)}`);
}

let env;
let bundle;
before(async () => {
  const executable = process.env.DAO_FLEET_TEST_TEMPORAL_PATH;
  if (!executable) throw new Error('Set DAO_FLEET_TEST_TEMPORAL_PATH to a verified local Temporal CLI; tests never download executables');
  env = await TestWorkflowEnvironment.createLocal({ server: { executable: { type: 'existing-path', path: executable }, ui: false, ip: '127.0.0.1' } });
  bundle = await bundleWorkflowCode({ workflowsPath: fileURLToPath(new URL('../src/workflows.mjs', import.meta.url)) });
});
after(async () => { await env?.teardown(); });
const worker = (queue, handlers) => Worker.create({ connection: env.nativeConnection, taskQueue: queue, workflowBundle: bundle, activities: handlers });

describe('Temporal-backed task lifecycle', { concurrency: false }, () => {
  it('runs two projects with the same issue number through two workers without conflating task identity', async () => {
    const queue = `fleet-${randomUUID()}`;
    const f = activities();
    const a = await worker(queue, f.handlers);
    const b = await worker(queue, f.handlers);
    const tasks = [spec('owner/one'), spec('owner/two')];
    const result = await a.runUntil(() => b.runUntil(() => Promise.all(tasks.map(task => env.client.workflow.execute('fusionTaskWorkflow', { taskQueue: queue, workflowId: normalizeTask(task).id, args: [task] })))));
    assert.deepEqual(result.map(value => value.state), ['completed', 'completed']);
    assert.notEqual(result[0].taskId, result[1].taskId);
    assert.equal(f.calls.filter(call => call.name === 'closeIssue').length, 2);
  });
  it('survives worker replacement while blocked and resumes review without replaying side effects', async () => {
    const queue = `fleet-${randomUUID()}`;
    let authenticated = false;
    const f = activities({ review: async () => {
      if (!authenticated) throw ApplicationFailure.nonRetryable('Authentication required', 'AUTH_REQUIRED');
      return { completed: true, head: H, findings: [], identityVerified: true, executorFamily: 'xai', reviewerFamily: 'anthropic' };
    } });
    let handle;
    const task = spec('owner/recovery');
    const a = await worker(queue, f.handlers);
    await a.runUntil(async () => {
      handle = await env.client.workflow.start('fusionTaskWorkflow', { taskQueue: queue, workflowId: normalizeTask(task).id, args: [task] });
      const state = await waitForState(handle, 'blocked');
      assert.equal(state.phase, 'reviewing');
      assert.equal(state.round, 0);
    });
    authenticated = true;
    await handle.signal('resume');
    const b = await worker(queue, f.handlers);
    const result = await b.runUntil(() => handle.result());
    assert.equal(result.state, 'completed');
    assert.equal(f.calls.filter(call => call.name === 'prepare').length, 1);
    assert.equal(f.calls.filter(call => call.name === 'execute').length, 1);
    assert.equal(f.calls.filter(call => call.name === 'integrate').length, 1);
    assert.equal(f.calls.filter(call => call.name === 'closeIssue').length, 1);
    assert.equal(f.calls.filter(call => call.name === 'review').length, 2);
  });
  it('上游容量满：长退避等待后重试成功，不占那 5 次小退避预算', async () => {
    const queue = `fleet-${randomUUID()}`;
    let reviewCalls = 0;
    const f = activities({ review: async () => {
      reviewCalls += 1;
      if (reviewCalls <= 3) throw ApplicationFailure.nonRetryable('gpt-5.6-terra 当前可用容量已满，本次请求未被服务', 'SERVICE_UNAVAILABLE');
      return { completed: true, head: H, findings: [], identityVerified: true, executorFamily: 'xai', reviewerFamily: 'anthropic' };
    } });
    const task = spec('owner/capacity');
    const w = await worker(queue, f.handlers);
    const result = await w.runUntil(() => env.client.workflow.execute('fusionTaskWorkflow', {
      taskQueue: queue, workflowId: normalizeTask(task).id,
      args: [task, { capacityWaitSeconds: 1, capacityWaitAttempts: 5 }],
    }));
    assert.equal(result.state, 'completed');
    assert.equal(f.calls.filter(call => call.name === 'review').length, 4, '三次容量满都该重试，而不是烧完小退避就 block');
  });
  it('cancellation is a durable command, not a model interpretation', async () => {
    const queue = `fleet-${randomUUID()}`;
    const f = activities({ review: async () => { throw ApplicationFailure.nonRetryable('Authentication required', 'AUTH_REQUIRED'); } });
    const w = await worker(queue, f.handlers);
    const result = await w.runUntil(async () => {
      const task = spec('owner/cancel');
      const handle = await env.client.workflow.start('fusionTaskWorkflow', { taskQueue: queue, workflowId: normalizeTask(task).id, args: [task] });
      await waitForState(handle, 'blocked');
      await handle.signal('cancel');
      return handle.result();
    });
    assert.equal(result.state, 'cancelled');
    assert.equal(f.calls.filter(call => call.name === 'cleanup').length, 1);
    assert.equal(f.calls.some(call => call.name === 'closeIssue'), false);
  });
  it('reports unverified cancellation cleanup instead of claiming cancellation completed', async () => {
    const queue = `fleet-${randomUUID()}`;
    const f = activities({
      review: async () => { throw ApplicationFailure.nonRetryable('Authentication required', 'AUTH_REQUIRED'); },
      cleanup: async () => ({ verified: false }),
    });
    const w = await worker(queue, f.handlers);
    const result = await w.runUntil(async () => {
      const task = spec('owner/cancel-unknown');
      const handle = await env.client.workflow.start('fusionTaskWorkflow', { taskQueue: queue, workflowId: normalizeTask(task).id, args: [task] });
      await waitForState(handle, 'blocked');
      await handle.signal('cancel');
      return handle.result();
    });
    assert.equal(result.state, 'blocked');
    assert.equal(result.reason, 'cancel-cleanup-unconfirmed');
    assert.equal(result.cancelRequested, true);
    assert.equal(f.calls.some(call => call.name === 'integrate'), false);
  });
});
