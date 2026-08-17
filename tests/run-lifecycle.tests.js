// #593 Run 生命周期：gc 正负控、收信三态、reply 不抢台、ask 超时可见
const path = require('path');

const LIB = path.join(__dirname, '..', 'scripts', 'lib', 'run-lifecycle.mjs');

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  →  ' + detail : ''}`); }
}

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

async function main() {
  const S = await import('file://' + LIB.replace(/\\/g, '/'));

  console.log('\n=== ③ gc：无在途 → 全列；有在途 → 不许退役 ===');
  {
    const runs = [run({ id: 'run_a' }), run({ id: 'run_b' }), run({ id: 'run_legacy_local', legacy: 1 })];
    const empty = S.planRunGc({ runs, workers: [], worktrees: [] });
    check('无在途列出全部可退役', empty.ok && empty.retire.map(r => r.id).join(',') === 'run_a,run_b', JSON.stringify(empty));
    check('legacy 不进退役名单', empty.skippedLegacy.length === 1 && empty.keep.length === 0, JSON.stringify(empty));

    const live = S.planRunGc({
      runs,
      workers: [worker({ run: 'run_a', state: 'ready', status: 'dispatched', tree: 'repo::/wt/a' })],
      worktrees: [wt({ id: 'repo::/wt/a' })],
    });
    check('在途 Run 进 keep', live.keep.map(r => r.id).join(',') === 'run_a', JSON.stringify(live));
    check('其它 Run 仍可退役', live.retire.map(r => r.id).join(',') === 'run_b', JSON.stringify(live));

    const closing = S.planRunGc({
      runs,
      workers: [worker({ run: 'run_a', state: 'succeeded', status: 'completed', tree: 'repo::/wt/a' })],
      worktrees: [wt({ id: 'repo::/wt/a', status: 'completed' })],
    });
    check('待收口树仍保护 Run（审官还要上报）', closing.keep.map(r => r.id).join(',') === 'run_a', JSON.stringify(closing));

    const gone = S.planRunGc({
      runs,
      workers: [worker({ run: 'run_a', state: 'succeeded', status: 'completed', tree: 'repo::/wt/gone' })],
      worktrees: [wt({ id: 'master', main: true })],
    });
    check('树已不在盘面 → 完成的 dispatch 不保护', gone.retire.map(r => r.id).sort().join(',') === 'run_a,run_b', JSON.stringify(gone));
  }

  console.log('\n=== 没查成 ≠ 查到 0 ===');
  {
    check('runs 不是数组 → unscanned', S.planRunGc({ runs: null, workers: [], worktrees: [] }).unscanned === true);
    check('workers 不是数组 → unscanned', S.planRunGc({ runs: [], workers: null, worktrees: [] }).unscanned === true);
    check('worktrees 不是数组 → unscanned', S.planRunGc({ runs: [], workers: [], worktrees: null }).unscanned === true);
    const zero = S.planRunGc({ runs: [], workers: [], worktrees: [] });
    check('扫完 0 条是 ok 不是 unscanned', zero.ok && zero.unscanned === false && zero.retire.length === 0);
  }

  console.log('\n=== 删树反查 Run ===');
  {
    const workers = [
      worker({ run: 'run_a', tree: 'repo::/wt/a' }),
      worker({ run: 'run_a', tree: 'repo::/wt/a-child' }),
      worker({ run: 'run_b', tree: 'repo::/wt/b' }),
    ];
    const hit = S.resolveRunsForWorktrees({ workers, treeIds: ['repo::/wt/a'] });
    check('命中去重', hit.ok && hit.runIds.join(',') === 'run_a', JSON.stringify(hit));
    const miss = S.resolveRunsForWorktrees({ workers, treeIds: ['repo::/wt/none'] });
    check('查到 0 条不是没查成', miss.ok && miss.unscanned === false && miss.runIds.length === 0);
    const bad = S.resolveRunsForWorktrees({ workers: { result: {} }, treeIds: ['x'] });
    check('结构不认识 → unscanned', bad.unscanned === true);
  }

  console.log('\n=== ② 收信三态 ===');
  {
    check('查到 0 条', S.classifyMailboxRead({ ok: true, messages: [], runId: 'run_a' }).state === 'empty');
    check('没查成', S.classifyMailboxRead({ ok: false, error: 'timeout', runId: 'run_a' }).state === 'unscanned');
    check('Run 不存在', S.classifyMailboxRead({ ok: false, error: { code: 'run_not_found', message: 'Run x was not found.' }, runId: 'run_x' }).state === 'run_not_found');
    const fenced = S.classifyMailboxRead({
      ok: false,
      error: { code: 'consumer_fenced', message: 'not bound' },
      runId: 'run_a',
      inboxMessages: [
        { id: 'm1', run_id: 'run_a', body: 'hi' },
        { id: 'm2', run_id: 'run_b', body: 'other' },
      ],
    });
    check('check 被 fence 时 inbox 兜底能收到该 Run 的信', fenced.state === 'messages' && fenced.count === 1, JSON.stringify(fenced));
    const acked = S.classifyMailboxRead({
      ok: true,
      messages: [],
      runId: 'run_a',
      inboxMessages: [{ id: 'm3', run_id: 'run_a', body: 'sos', read: 1 }],
    });
    check('check 已读空时 inbox 仍能捞出已 ack 的求救', acked.state === 'messages' && acked.count === 1, JSON.stringify(acked));
  }

  console.log('\n=== 收信计划只扫在途 ===');
  {
    const plan = S.planInboxCollect({
      worktrees: [wt({ id: 'repo::/wt/a' })],
      workers: [worker({ run: 'run_a', state: 'ready', status: 'dispatched', tree: 'repo::/wt/a' })],
      runs: [run({ id: 'run_a', coord: 'term_station' }), run({ id: 'run_orphan' })],
    });
    check('只列在途 Run', plan.ok && plan.items.length === 1 && plan.items[0].runId === 'run_a', JSON.stringify(plan));
    check('带上台 handle', plan.items[0].coordinatorHandle === 'term_station');
    const missing = S.planInboxCollect({
      worktrees: [wt({ id: 'repo::/wt/a' })],
      workers: [worker({ run: 'run_gone', state: 'ready', status: 'dispatched', tree: 'repo::/wt/a' })],
      runs: [run({ id: 'run_a' })],
    });
    check('在途 Run 不在 list → run_not_found', missing.items[0].state === 'run_not_found');
  }

  console.log('\n=== reply 用台的 --from，不抢 coordinator ===');
  {
    const resolved = S.resolveReplyTarget({
      messageId: 'msg_q',
      inboxMessages: [{ id: 'msg_q', run_id: 'run_a', type: 'question' }],
      runs: [run({ id: 'run_a', coord: 'term_station' })],
    });
    check('自动带上 coordinator --from', resolved.ok && resolved.from === 'term_station' && resolved.runId === 'run_a', JSON.stringify(resolved));
    const explicit = S.resolveReplyTarget({
      messageId: 'msg_q',
      inboxMessages: [{ id: 'msg_q', run_id: 'run_a' }],
      runs: [run({ id: 'run_a', coord: 'term_station' })],
      explicitFrom: 'term_other',
    });
    check('--from 显式优先', explicit.from === 'term_other');
    const noInbox = S.resolveReplyTarget({ messageId: 'msg_q', inboxMessages: null });
    check('inbox 没查成 ≠ 找不到消息', noInbox.unscanned === true);
    const miss = S.resolveReplyTarget({ messageId: 'msg_no', inboxMessages: [] });
    check('扫过找不到', miss.ok === false && !miss.unscanned && /找不到/.test(miss.error));
  }

  console.log('\n=== ask 超时必须可见，不许空转 ===');
  {
    check('超时打 ASK_TIMEOUT', S.classifyAskPoll({ elapsedMs: 10, timeoutMs: 10 }).state === 'timeout'
      && S.classifyAskPoll({ elapsedMs: 10, timeoutMs: 10 }).mark === S.ASK_TIMEOUT_MARK);
    check('未到点继续等', S.classifyAskPoll({ elapsedMs: 5, timeoutMs: 10 }).state === 'waiting');
    const hit = S.findThreadReply([{ id: 'm2', thread_id: 'm1', body: 'yes' }], 'm1');
    check('按 thread 找到答复', S.classifyAskPoll({ reply: hit, elapsedMs: 1, timeoutMs: 10 }).state === 'answered'
      && S.classifyAskPoll({ reply: hit, elapsedMs: 1, timeoutMs: 10 }).body === 'yes');
    check('收信没查成单独一态', S.classifyAskPoll({ unscanned: true, error: 'boom' }).state === 'unscanned');
  }

  console.log('\n=== 退役：关台 + 删租约；台已不在不算失败 ===');
  {
    const plan = S.planStationRetire({
      runId: 'run_a',
      coordinatorHandle: 'term_s',
      files: ['inbox-a.lease', 'inbox-a.cmd'],
    });
    const applied = S.applyStationRetire(plan, {
      closeTerminal: () => ({ ok: true }),
      unlink: () => {},
    });
    check('退役成功', applied.ok && applied.state === 'retired' && applied.removed.length === 2, JSON.stringify(applied));
    const gone = S.applyStationRetire(plan, {
      closeTerminal: () => ({ ok: false, error: { code: 'tab_not_found' } }),
      unlink: () => {},
    });
    check('台已关 = 已退役', gone.ok && gone.closed.alreadyGone === true, JSON.stringify(gone));
    const boom = S.applyStationRetire(plan, {
      closeTerminal: () => ({ ok: false, error: 'permission denied' }),
      unlink: () => {},
    });
    check('关台真失败要报', boom.ok === false && /关信箱台失败/.test(boom.error), boom.error);
  }

  console.log(`\n${fail === 0 ? 'OK' : 'FAIL'}  ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
