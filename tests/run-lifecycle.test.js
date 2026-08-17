// #593 Run 生命周期：gc 正负控、收信三态、reply 不抢台、ask 超时可见
const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const LIB = path.join(__dirname, '..', 'scripts', 'lib', 'run-lifecycle.mjs');
const LIB_LOAD = import('file://' + LIB.replace(/\\/g, '/'));

function run(partial) {
  return {
    id: partial.id,
    objective: partial.objective || partial.id,
    coordinator_handle: partial.coord ?? null,
    legacy: partial.legacy ?? 0,
  };
}

function worker(partial) {
  return {
    dispatchId: partial.dispatch || 'ctx_x',
    runId: partial.run,
    workerState: partial.state || 'succeeded',
    dispatchStatus: partial.status || 'completed',
    resource: partial.tree ? { worktreeId: partial.tree } : null,
  };
}

function wt(partial) {
  return {
    worktreeId: partial.id,
    id: partial.id,
    isMainWorktree: !!partial.main,
    isArchived: !!partial.archived,
    workspaceStatus: partial.status || 'in-progress',
  };
}

describe('run-lifecycle', () => {
  it('③ gc：无在途 → 全列；有在途 → 不许退役', async (t) => {
    const S = await LIB_LOAD;
    const runs = [run({ id: 'run_a' }), run({ id: 'run_b' }), run({ id: 'run_legacy_local', legacy: 1 })];
    const empty = S.planRunGc({ runs, workers: [], worktrees: [] });
    await t.test('无在途列出全部可退役', () => {
      assert.ok(empty.ok && empty.retire.map(r => r.id).join(',') === 'run_a,run_b', '无在途列出全部可退役  →  ' + JSON.stringify(empty));
    });
    await t.test('legacy 不进退役名单', () => {
      assert.ok(empty.skippedLegacy.length === 1 && empty.keep.length === 0, 'legacy 不进退役名单  →  ' + JSON.stringify(empty));
    });

    const live = S.planRunGc({
      runs,
      workers: [worker({ run: 'run_a', state: 'ready', status: 'dispatched', tree: 'repo::/wt/a' })],
      worktrees: [wt({ id: 'repo::/wt/a' })],
    });
    await t.test('在途 Run 进 keep', () => {
      assert.ok(live.keep.map(r => r.id).join(',') === 'run_a', '在途 Run 进 keep  →  ' + JSON.stringify(live));
    });
    await t.test('其它 Run 仍可退役', () => {
      assert.ok(live.retire.map(r => r.id).join(',') === 'run_b', '其它 Run 仍可退役  →  ' + JSON.stringify(live));
    });

    const closing = S.planRunGc({
      runs,
      workers: [worker({ run: 'run_a', state: 'succeeded', status: 'completed', tree: 'repo::/wt/a' })],
      worktrees: [wt({ id: 'repo::/wt/a', status: 'completed' })],
    });
    await t.test('待收口树仍保护 Run（审官还要上报）', () => {
      assert.ok(closing.keep.map(r => r.id).join(',') === 'run_a', '待收口树仍保护 Run（审官还要上报）  →  ' + JSON.stringify(closing));
    });

    const gone = S.planRunGc({
      runs,
      workers: [worker({ run: 'run_a', state: 'succeeded', status: 'completed', tree: 'repo::/wt/gone' })],
      worktrees: [wt({ id: 'master', main: true })],
    });
    await t.test('树已不在盘面 → 完成的 dispatch 不保护', () => {
      assert.ok(gone.retire.map(r => r.id).sort().join(',') === 'run_a,run_b', '树已不在盘面 → 完成的 dispatch 不保护  →  ' + JSON.stringify(gone));
    });
  });

  it('没查成 ≠ 查到 0', async (t) => {
    const S = await LIB_LOAD;
    await t.test('runs 不是数组 → unscanned', () => {
      assert.ok(S.planRunGc({ runs: null, workers: [], worktrees: [] }).unscanned === true, 'runs 不是数组 → unscanned');
    });
    await t.test('workers 不是数组 → unscanned', () => {
      assert.ok(S.planRunGc({ runs: [], workers: null, worktrees: [] }).unscanned === true, 'workers 不是数组 → unscanned');
    });
    await t.test('worktrees 不是数组 → unscanned', () => {
      assert.ok(S.planRunGc({ runs: [], workers: [], worktrees: null }).unscanned === true, 'worktrees 不是数组 → unscanned');
    });
    const zero = S.planRunGc({ runs: [], workers: [], worktrees: [] });
    await t.test('扫完 0 条是 ok 不是 unscanned', () => {
      assert.ok(zero.ok && zero.unscanned === false && zero.retire.length === 0, '扫完 0 条是 ok 不是 unscanned');
    });
  });

  it('删树反查 Run', async (t) => {
    const S = await LIB_LOAD;
    const workers = [
      worker({ run: 'run_a', tree: 'repo::/wt/a' }),
      worker({ run: 'run_a', tree: 'repo::/wt/a-child' }),
      worker({ run: 'run_b', tree: 'repo::/wt/b' }),
    ];
    const hit = S.resolveRunsForWorktrees({ workers, treeIds: ['repo::/wt/a'] });
    await t.test('命中去重', () => {
      assert.ok(hit.ok && hit.runIds.join(',') === 'run_a', '命中去重  →  ' + JSON.stringify(hit));
    });
    const miss = S.resolveRunsForWorktrees({ workers, treeIds: ['repo::/wt/none'] });
    await t.test('查到 0 条不是没查成', () => {
      assert.ok(miss.ok && miss.unscanned === false && miss.runIds.length === 0, '查到 0 条不是没查成');
    });
    const bad = S.resolveRunsForWorktrees({ workers: { result: {} }, treeIds: ['x'] });
    await t.test('结构不认识 → unscanned', () => {
      assert.ok(bad.unscanned === true, '结构不认识 → unscanned');
    });
  });

  it('② 收信三态', async (t) => {
    const S = await LIB_LOAD;
    await t.test('查到 0 条', () => {
      assert.ok(S.classifyMailboxRead({ ok: true, messages: [], runId: 'run_a' }).state === 'empty', '查到 0 条');
    });
    await t.test('没查成', () => {
      assert.ok(S.classifyMailboxRead({ ok: false, error: 'timeout', runId: 'run_a' }).state === 'unscanned', '没查成');
    });
    await t.test('Run 不存在', () => {
      assert.ok(S.classifyMailboxRead({ ok: false, error: { code: 'run_not_found', message: 'Run x was not found.' }, runId: 'run_x' }).state === 'run_not_found', 'Run 不存在');
    });
    const fenced = S.classifyMailboxRead({
      ok: false,
      error: { code: 'consumer_fenced', message: 'not bound' },
      runId: 'run_a',
      inboxMessages: [
        { id: 'm1', run_id: 'run_a', body: 'hi' },
        { id: 'm2', run_id: 'run_b', body: 'other' },
      ],
    });
    await t.test('check 被 fence 时 inbox 兜底能收到该 Run 的信', () => {
      assert.ok(fenced.state === 'messages' && fenced.count === 1, 'check 被 fence 时 inbox 兜底能收到该 Run 的信  →  ' + JSON.stringify(fenced));
    });
    const acked = S.classifyMailboxRead({
      ok: true,
      messages: [],
      runId: 'run_a',
      inboxMessages: [{ id: 'm3', run_id: 'run_a', body: 'sos', read: 1 }],
    });
    await t.test('check 已读空时 inbox 仍能捞出已 ack 的求救', () => {
      assert.ok(acked.state === 'messages' && acked.count === 1, 'check 已读空时 inbox 仍能捞出已 ack 的求救  →  ' + JSON.stringify(acked));
    });
  });

  it('收信计划只扫在途', async (t) => {
    const S = await LIB_LOAD;
    const plan = S.planInboxCollect({
      worktrees: [wt({ id: 'repo::/wt/a' })],
      workers: [worker({ run: 'run_a', state: 'ready', status: 'dispatched', tree: 'repo::/wt/a' })],
      runs: [run({ id: 'run_a', coord: 'term_station' }), run({ id: 'run_orphan' })],
    });
    await t.test('只列在途 Run', () => {
      assert.ok(plan.ok && plan.items.length === 1 && plan.items[0].runId === 'run_a', '只列在途 Run  →  ' + JSON.stringify(plan));
    });
    await t.test('带上台 handle', () => {
      assert.ok(plan.items[0].coordinatorHandle === 'term_station', '带上台 handle');
    });
    const missing = S.planInboxCollect({
      worktrees: [wt({ id: 'repo::/wt/a' })],
      workers: [worker({ run: 'run_gone', state: 'ready', status: 'dispatched', tree: 'repo::/wt/a' })],
      runs: [run({ id: 'run_a' })],
    });
    await t.test('在途 Run 不在 list → run_not_found', () => {
      assert.ok(missing.items[0].state === 'run_not_found', '在途 Run 不在 list → run_not_found');
    });
  });

  it('reply 用台的 --from，不抢 coordinator', async (t) => {
    const S = await LIB_LOAD;
    const resolved = S.resolveReplyTarget({
      messageId: 'msg_q',
      inboxMessages: [{ id: 'msg_q', run_id: 'run_a', type: 'question' }],
      runs: [run({ id: 'run_a', coord: 'term_station' })],
    });
    await t.test('自动带上 coordinator --from', () => {
      assert.ok(resolved.ok && resolved.from === 'term_station' && resolved.runId === 'run_a', '自动带上 coordinator --from  →  ' + JSON.stringify(resolved));
    });
    const explicit = S.resolveReplyTarget({
      messageId: 'msg_q',
      inboxMessages: [{ id: 'msg_q', run_id: 'run_a' }],
      runs: [run({ id: 'run_a', coord: 'term_station' })],
      explicitFrom: 'term_other',
    });
    await t.test('--from 显式优先', () => {
      assert.ok(explicit.from === 'term_other', '--from 显式优先');
    });
    const noInbox = S.resolveReplyTarget({ messageId: 'msg_q', inboxMessages: null });
    await t.test('inbox 没查成 ≠ 找不到消息', () => {
      assert.ok(noInbox.unscanned === true, 'inbox 没查成 ≠ 找不到消息');
    });
    const miss = S.resolveReplyTarget({ messageId: 'msg_no', inboxMessages: [] });
    await t.test('扫过找不到', () => {
      assert.ok(miss.ok === false && !miss.unscanned && /找不到/.test(miss.error), '扫过找不到');
    });
  });

  it('ask 超时必须可见，不许空转', async (t) => {
    const S = await LIB_LOAD;
    await t.test('超时打 ASK_TIMEOUT', () => {
      assert.ok(S.classifyAskPoll({ elapsedMs: 10, timeoutMs: 10 }).state === 'timeout'
        && S.classifyAskPoll({ elapsedMs: 10, timeoutMs: 10 }).mark === S.ASK_TIMEOUT_MARK, '超时打 ASK_TIMEOUT');
    });
    await t.test('未到点继续等', () => {
      assert.ok(S.classifyAskPoll({ elapsedMs: 5, timeoutMs: 10 }).state === 'waiting', '未到点继续等');
    });
    const hit = S.findThreadReply([{ id: 'm2', thread_id: 'm1', body: 'yes' }], 'm1');
    await t.test('按 thread 找到答复', () => {
      assert.ok(S.classifyAskPoll({ reply: hit, elapsedMs: 1, timeoutMs: 10 }).state === 'answered'
        && S.classifyAskPoll({ reply: hit, elapsedMs: 1, timeoutMs: 10 }).body === 'yes', '按 thread 找到答复');
    });
    await t.test('收信没查成单独一态', () => {
      assert.ok(S.classifyAskPoll({ unscanned: true, error: 'boom' }).state === 'unscanned', '收信没查成单独一态');
    });
  });

  it('退役：关台 + 删租约；台已不在不算失败', async (t) => {
    const S = await LIB_LOAD;
    const plan = S.planStationRetire({
      runId: 'run_a',
      coordinatorHandle: 'term_s',
      files: ['inbox-a.lease', 'inbox-a.cmd'],
    });
    const applied = S.applyStationRetire(plan, {
      closeTerminal: () => ({ ok: true }),
      unlink: () => {},
    });
    await t.test('退役成功', () => {
      assert.ok(applied.ok && applied.state === 'retired' && applied.removed.length === 2, '退役成功  →  ' + JSON.stringify(applied));
    });
    const gone = S.applyStationRetire(plan, {
      closeTerminal: () => ({ ok: false, error: { code: 'tab_not_found' } }),
      unlink: () => {},
    });
    await t.test('台已关 = 已退役', () => {
      assert.ok(gone.ok && gone.closed.alreadyGone === true, '台已关 = 已退役  →  ' + JSON.stringify(gone));
    });
    const boom = S.applyStationRetire(plan, {
      closeTerminal: () => ({ ok: false, error: 'permission denied' }),
      unlink: () => {},
    });
    await t.test('关台真失败要报', () => {
      assert.ok(boom.ok === false && /关信箱台失败/.test(boom.error), '关台真失败要报  →  ' + boom.error);
    });
  });

  it('#598 审官红项：reply / timeout / 退役收口 fail-closed', async (t) => {
    const S = await LIB_LOAD;
    const noCoord = S.resolveReplySender({
      messageId: 'msg_q',
      inboxOk: true,
      inboxMessages: [{ id: 'msg_q', run_id: 'run_a' }],
      runListOk: true,
      runs: [run({ id: 'run_a', coord: null })],
    });
    await t.test('没有 coordinator 不许发', () => {
      assert.ok(noCoord.ok === false && /coordinator/.test(noCoord.error), '没有 coordinator 不许发  →  ' + JSON.stringify(noCoord));
    });
    const inboxDown = S.resolveReplySender({
      messageId: 'msg_q', inboxOk: false, runListOk: true, runs: [],
    });
    await t.test('inbox 没查成 fail-closed', () => {
      assert.ok(inboxDown.ok === false && inboxDown.unscanned === true, 'inbox 没查成 fail-closed');
    });
    const listDown = S.resolveReplySender({
      messageId: 'msg_q', inboxOk: true, inboxMessages: [{ id: 'msg_q', run_id: 'run_a' }],
      runListOk: false,
    });
    await t.test('run-list 没查成 fail-closed', () => {
      assert.ok(listDown.ok === false && listDown.unscanned === true, 'run-list 没查成 fail-closed');
    });
    const explicit = S.resolveReplySender({
      messageId: 'msg_q', explicitFrom: 'term_s', explicitRun: 'run_a',
    });
    await t.test('显式 --from/--run 放行', () => {
      assert.ok(explicit.ok && explicit.from === 'term_s', '显式 --from/--run 放行');
    });

    await t.test('timeout 未给 → 默认', () => {
      assert.ok(S.parseAskTimeoutMs(undefined).timeoutMs === 600000 && S.parseAskTimeoutMs(undefined).defaulted === true, 'timeout 未给 → 默认');
    });
    await t.test('timeout 0 非零', () => {
      assert.ok(S.parseAskTimeoutMs(0).ok === false, 'timeout 0 非零');
    });
    await t.test('timeout 字符串 0 非零', () => {
      assert.ok(S.parseAskTimeoutMs('0').ok === false, 'timeout 字符串 0 非零');
    });
    await t.test('timeout NaN 非零', () => {
      assert.ok(S.parseAskTimeoutMs('nope').ok === false, 'timeout NaN 非零');
    });
    await t.test('timeout 小数 非零', () => {
      assert.ok(S.parseAskTimeoutMs('1.5').ok === false, 'timeout 小数 非零');
    });
    await t.test('timeout 正整数过', () => {
      assert.ok(S.parseAskTimeoutMs('12').ok && S.parseAskTimeoutMs('12').timeoutMs === 12, 'timeout 正整数过');
    });

    const lifeFail = S.finalizeWorktreeRmLifecycle({
      mapped: { ok: true, runIds: ['run_a'] },
      gc: { ok: true, retire: [{ id: 'run_a' }] },
      retireResults: [{ ok: false, runId: 'run_a', error: '关台失败' }],
    });
    await t.test('退役失败 → 归档非零', () => {
      assert.ok(lifeFail.ok === false && /退役失败/.test(lifeFail.error), '退役失败 → 归档非零  →  ' + JSON.stringify(lifeFail));
    });
    const mapDown = S.finalizeWorktreeRmLifecycle({
      mapped: { ok: false, unscanned: true, error: 'worker-list 结构不认识' },
      gc: { ok: true, retire: [] },
      retireResults: [],
    });
    await t.test('映射没查成 → 归档非零', () => {
      assert.ok(mapDown.ok === false && mapDown.unscanned === true, '映射没查成 → 归档非零');
    });
    const lifeOk = S.finalizeWorktreeRmLifecycle({
      mapped: { ok: true, runIds: ['run_a'] },
      gc: { ok: true, retire: [{ id: 'run_a' }] },
      retireResults: [{ ok: true, runId: 'run_a', state: 'retired' }],
    });
    await t.test('退役成功才 ok', () => {
      assert.ok(lifeOk.ok === true && lifeOk.retired.length === 1, '退役成功才 ok');
    });
  });
});