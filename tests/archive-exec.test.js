// #637 信箱台「可归档」二次验证闸
//
// 验的层：①识别只认 subject「可归档」，其余 type 不动
// ②不信通知自称 MERGED，只信 gh state
// ③未合并 / 没查成 → 拒删 + escalation
// ④真 MERGED → worktree-rm + 日志留痕
// 判别力：OPEN 样本若被删，或 MERGED 样本没调 rm，必有一条变红。

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const LIB = path.resolve(__dirname, '..', 'scripts', 'lib', 'archive-exec.mjs');
const INBOX = path.resolve(__dirname, '..', 'scripts', 'inbox-station.mjs');
const REVIEWER = path.resolve(__dirname, '..', 'host', 'skills', 'dispatch', 'templates', 'reviewer-book.md');
const LIB_LOAD = import('file://' + LIB.replace(/\\/g, '/'));

function wt(partial) {
  return {
    worktreeId: partial.id,
    displayName: partial.name || partial.id,
    parentWorktreeId: partial.parent || null,
    childWorktreeIds: partial.children || [],
    isMainWorktree: !!partial.main,
    linkedPR: partial.pr ? { number: partial.pr, state: partial.prState || 'open' } : null,
    linkedIssue: partial.issue || null,
    path: partial.path || `/tmp/${partial.id}`,
  };
}

function archiveMsg(partial = {}) {
  return {
    id: partial.id || 'msg_archive',
    type: partial.type,
    subject: partial.subject ?? '可归档：12',
    body: partial.body ?? '判绿依据 + 合并结果',
    payload: partial.payload,
    worktree: partial.worktree,
  };
}

function recorder() {
  const calls = { pr: [], rm: [], escalate: [], listed: 0 };
  const state = {
    prQuery: { ok: true, state: 'MERGED' },
    listed: { ok: true, worktrees: [] },
    rmResult: { ok: true },
    escResult: { ok: true },
  };
  return {
    calls,
    state,
    queryPrState(pr) {
      calls.pr.push(pr);
      return state.prQuery;
    },
    listWorktrees() {
      calls.listed += 1;
      return state.listed;
    },
    removeWorktree(sel) {
      calls.rm.push(sel);
      return state.rmResult;
    },
    escalate(text) {
      calls.escalate.push(text);
      return state.escResult;
    },
  };
}

describe('archive-exec', () => {
  it('① 识别可归档，其余 type 不动', async (t) => {
    const S = await LIB_LOAD;
    await t.test('subject 可归档：12', () => {
      assert.ok(S.isArchiveReadyMessage(archiveMsg()) === true, 'subject 可归档：12');
    });
    await t.test('可归档: #12', () => {
      assert.ok(S.isArchiveReadyMessage(archiveMsg({ subject: '可归档: #12' })) === true, '可归档: #12');
    });
    await t.test('可归档：PR #12', () => {
      assert.ok(S.isArchiveReadyMessage(archiveMsg({ subject: '可归档：PR #12' })) === true, '可归档：PR #12');
    });
    await t.test('heartbeat 即使 subject 可归档也不动', () => {
      assert.ok(S.isArchiveReadyMessage(archiveMsg({ type: 'heartbeat' })) === false, 'heartbeat 即使 subject 可归档也不动');
    });
    await t.test('escalation 不动', () => {
      assert.ok(S.isArchiveReadyMessage(archiveMsg({ type: 'escalation', subject: '归档闸未过：PR #12' })) === false, 'escalation 不动');
    });
    await t.test('ask 不动', () => {
      assert.ok(S.isArchiveReadyMessage(archiveMsg({ type: 'ask' })) === false, 'ask 不动');
    });
    await t.test('worker_done 完工不动', () => {
      assert.ok(S.isArchiveReadyMessage({ type: 'worker_done', subject: '完工：PR #12' }) === false, 'worker_done 完工不动');
    });
    await t.test('需人工合并不是可归档', () => {
      assert.ok(S.isArchiveReadyMessage({ subject: '需人工合并：PR #12' }) === false, '需人工合并不是可归档');
    });
  });

  it('② 解析 PR 号与树上的树', async (t) => {
    const S = await LIB_LOAD;
    const a = S.parseArchiveReadyNotice(archiveMsg({ payload: { worktree: 'p1' } }));
    await t.test('抽出 PR 12', () => {
      assert.ok(a.pr === 12, '抽出 PR 12  →  ' + JSON.stringify(a));
    });
    await t.test('抽出 payload.worktree', () => {
      assert.ok(a.worktree === 'p1', '抽出 payload.worktree');
    });
    const b = S.parseArchiveReadyNotice({ subject: 'hello' });
    await t.test('对不上的 subject 没有 PR', () => {
      assert.ok(b.pr === null, '对不上的 subject 没有 PR');
    });
  });

  it('③ 假样本：可归档但 PR 未合并 → 拒删 + 升级', async (t) => {
    const S = await LIB_LOAD;
    const io = recorder();
    io.state.prQuery = { ok: true, state: 'OPEN' };
    io.state.listed = { ok: true, worktrees: [wt({ id: 'p1', pr: 12 })] };
    const results = S.processArchiveNotices([
      archiveMsg({ payload: { worktree: 'p1' }, body: '已合并 MERGED' }),
    ], io);
    await t.test('只有一条归档结果', () => {
      assert.ok(results.length === 1, '只有一条归档结果  →  ' + JSON.stringify(results));
    });
    await t.test('动作是 escalate', () => {
      assert.ok(results[0].action === 'escalate' && results[0].removed !== true, '动作是 escalate');
    });
    await t.test('原因点明实际是 OPEN', () => {
      assert.ok(/OPEN/.test(results[0].reason) && /MERGED/.test(results[0].reason), '原因点明实际是 OPEN  →  ' + results[0].reason);
    });
    await t.test('没有调用 worktree-rm', () => {
      assert.ok(io.calls.rm.length === 0, '没有调用 worktree-rm  →  ' + JSON.stringify(io.calls.rm));
    });
    await t.test('发了 escalation', () => {
      assert.ok(io.calls.escalate.length === 1 && /归档闸未过/.test(io.calls.escalate[0].subject), '发了 escalation  →  ' + JSON.stringify(io.calls.escalate[0]));
    });
    await t.test('escalation subject 不以可归档开头（防回环）', () => {
      assert.ok(!/^可归档/.test(io.calls.escalate[0].subject), 'escalation subject 不以可归档开头');
    });
    await t.test('未合并时不查盘面', () => {
      assert.ok(io.calls.listed === 0, '未合并时不查盘面');
    });
    await t.test('通知自称 MERGED 不算', () => {
      assert.ok(io.calls.pr.length === 1 && io.calls.pr[0] === 12, '通知自称 MERGED 不算，仍查 gh');
    });
  });

  it('③b 没查成 ≠ 未合并，也不删', async (t) => {
    const S = await LIB_LOAD;
    const io = recorder();
    io.state.prQuery = { ok: false, unscanned: true, error: 'gh 读 PR #12 state 失败（1）——不是查过没事' };
    const results = S.processArchiveNotices([archiveMsg({ payload: { worktree: 'p1' } })], io);
    await t.test('没查成 escalate', () => {
      assert.ok(results[0].action === 'escalate' && /没查成|失败/.test(results[0].reason), '没查成 escalate  →  ' + results[0].reason);
    });
    await t.test('没查成不删', () => {
      assert.ok(io.calls.rm.length === 0, '没查成不删');
    });
    const parsed = S.parsePrStateOutput({ status: 1, stderr: 'HTTP 401' }, 12);
    await t.test('parsePrStateOutput 失败带 unscanned', () => {
      assert.ok(parsed.ok === false && parsed.unscanned === true, 'parsePrStateOutput 失败带 unscanned');
    });
    const empty = S.parsePrStateOutput({ status: 0, stdout: '{"title":"x"}' }, 12);
    await t.test('成功但没 state 也是没查成', () => {
      assert.ok(empty.ok === false && empty.unscanned === true, '成功但没 state 也是没查成');
    });
    const good = S.parsePrStateOutput({ status: 0, stdout: '{"state":"MERGED"}' }, 12);
    await t.test('成功读到 MERGED', () => {
      assert.ok(good.ok === true && good.state === 'MERGED', '成功读到 MERGED');
    });
  });

  it('④ 真合并场景：删树 + 日志留痕', async (t) => {
    const S = await LIB_LOAD;
    const forest = [
      wt({ id: 'master', name: 'master', main: true }),
      wt({ id: 'p1', name: 'PR-#12 工人', pr: 12, prState: 'merged', children: ['c1'] }),
      wt({ id: 'c1', name: 'PR-#12 审官', pr: 12, parent: 'p1' }),
    ];
    const io = recorder();
    io.state.prQuery = { ok: true, state: 'MERGED' };
    io.state.listed = { ok: true, worktrees: forest };
    const now = new Date('2026-08-18T08:00:00.000Z');
    const results = S.processArchiveNotices([
      archiveMsg({ id: 'msg_ok', payload: { worktree: 'p1' } }),
    ], { ...io, now });
    await t.test('动作是 rm 且已删', () => {
      assert.ok(results[0].action === 'rm' && results[0].removed === true && results[0].result === 'removed', '动作是 rm 且已删  →  ' + JSON.stringify(results[0]));
    });
    await t.test('worktree-rm 打到任务卡', () => {
      assert.ok(io.calls.rm.join(',') === 'p1', 'worktree-rm 打到任务卡  →  ' + JSON.stringify(io.calls.rm));
    });
    await t.test('真合并不升级', () => {
      assert.ok(io.calls.escalate.length === 0, '真合并不升级');
    });
    const line = S.formatArchiveExecLog(results[0], now);
    const obj = JSON.parse(line);
    await t.test('日志含 PR 号 + 时间 + 结果', () => {
      assert.ok(obj.type === 'archive-exec' && obj.pr === 12 && obj.ts === '2026-08-18T08:00:00.000Z' && obj.result === 'removed', '日志含 PR 号 + 时间 + 结果  →  ' + line);
    });
  });

  it('④d linkedPR=null 仍能靠卡名/路径/issue 收到根树', async (t) => {
    const S = await LIB_LOAD;
    const forest = [
      wt({ id: 'master', name: 'master', main: true }),
      wt({
        id: 'w655',
        name: 'PR-#655 工人·pi',
        issue: 638,
        path: 'C:/Users/Administrator/orca/workspaces/windsurf-dao/ISSUE-638-一台信箱台',
        children: ['r655'],
      }),
      wt({
        id: 'r655',
        name: 'PR-#655 审官·kimi-k3',
        parent: 'w655',
        path: 'C:/Users/Administrator/orca/workspaces/windsurf-dao/PR-655-审官-kimi-k3',
      }),
    ];
    const io = recorder();
    io.state.prQuery = { ok: true, state: 'MERGED' };
    io.state.listed = { ok: true, worktrees: forest };
    const results = S.processArchiveNotices([
      archiveMsg({ subject: '可归档：655' }),
    ], io);
    await t.test('可归档：655 不靠 linkedPR 也能对上工人树', () => {
      assert.ok(results[0].removed === true && io.calls.rm.join(',') === 'w655',
        '可归档：655 不靠 linkedPR 也能对上工人树  →  ' + JSON.stringify(results[0]));
    });
    const named = S.resolveArchiveWorktree({
      notice: { pr: 655 },
      worktrees: forest,
    });
    await t.test('resolveArchiveWorktree 卡名 PR-#655 命中根树', () => {
      assert.ok(named.ok && named.selector === 'w655',
        'resolveArchiveWorktree 卡名 PR-#655 命中根树  →  ' + JSON.stringify(named));
    });
    const byIssue = S.resolveArchiveWorktree({
      notice: { pr: 638 },
      worktrees: forest,
    });
    await t.test('issue 号也能对上（linkedIssue=638）', () => {
      assert.ok(byIssue.ok && byIssue.selector === 'w655',
        'issue 号也能对上  →  ' + JSON.stringify(byIssue));
    });
    const onlyReviewer = S.resolveArchiveWorktree({
      notice: { pr: 655 },
      worktrees: [forest[0], forest[2]],
    });
    await t.test('父卡不在盘面时，审官卡（linkedPR=null）自己当根', () => {
      assert.ok(onlyReviewer.ok && onlyReviewer.selector === 'r655',
        '父卡不在盘面时审官卡自己当根  →  ' + JSON.stringify(onlyReviewer));
    });
  });

  it('④b 通知不带树时按 linkedPR 找任务卡', async (t) => {
    const S = await LIB_LOAD;
    const forest = [
      wt({ id: 'master', name: 'master', main: true }),
      wt({ id: 'p1', pr: 12, children: ['c1'] }),
      wt({ id: 'c1', pr: 12, parent: 'p1' }),
    ];
    const io = recorder();
    io.state.prQuery = { ok: true, state: 'MERGED' };
    io.state.listed = { ok: true, worktrees: forest };
    const results = S.processArchiveNotices([archiveMsg()], io);
    await t.test('子卡 linkedPR 也收到父卡', () => {
      assert.ok(results[0].removed === true && io.calls.rm.join(',') === 'p1', '子卡 linkedPR 也收到父卡  →  ' + JSON.stringify(results[0]));
    });
  });

  it('④c 树对不上 / 主树 / 删失败都升级不盲删', async (t) => {
    const S = await LIB_LOAD;
    const mismatch = recorder();
    mismatch.state.prQuery = { ok: true, state: 'MERGED' };
    mismatch.state.listed = { ok: true, worktrees: [wt({ id: 'other', pr: 99 })] };
    const badTree = S.processArchiveNotices([
      archiveMsg({ payload: { worktree: 'other' } }),
    ], mismatch);
    await t.test('树对不上该 PR → 不删', () => {
      assert.ok(badTree[0].action === 'escalate' && mismatch.calls.rm.length === 0 && /#99/.test(badTree[0].reason), '树对不上该 PR → 不删  →  ' + badTree[0].reason);
    });

    const mainIo = recorder();
    mainIo.state.prQuery = { ok: true, state: 'MERGED' };
    mainIo.state.listed = { ok: true, worktrees: [wt({ id: 'master', name: 'master', main: true, pr: 12 })] };
    const mainHit = S.processArchiveNotices([
      archiveMsg({ payload: { worktree: 'master' } }),
    ], mainIo);
    await t.test('主树拒绝删', () => {
      assert.ok(mainHit[0].action === 'escalate' && mainIo.calls.rm.length === 0 && /主树/.test(mainHit[0].reason), '主树拒绝删  →  ' + mainHit[0].reason);
    });

    const rmFail = recorder();
    rmFail.state.prQuery = { ok: true, state: 'MERGED' };
    rmFail.state.listed = { ok: true, worktrees: [wt({ id: 'p1', pr: 12 })] };
    rmFail.state.rmResult = { ok: false, error: '子卡占用' };
    const failed = S.processArchiveNotices([
      archiveMsg({ payload: { worktree: 'p1' } }),
    ], rmFail);
    await t.test('rm 失败转 escalation', () => {
      assert.ok(failed[0].result === 'rm-failed' && failed[0].escalated === true && /子卡占用/.test(failed[0].reason), 'rm 失败转 escalation  →  ' + failed[0].reason);
    });
  });

  it('④d #652 父树挂未合 PR 只拆已合 PR 的子卡；卡名 PR-#N 也认', async (t) => {
    const S = await LIB_LOAD;
    const io = recorder();
    io.state.prQuery = { ok: true, state: 'MERGED' };
    io.state.listed = {
      ok: true,
      worktrees: [
        wt({ id: 'master', name: 'master', main: true }),
        wt({ id: 'p1', name: 'PR-#200 工人·head', pr: 200, children: ['w1'] }),
        // 子卡 linkedPR=null 但卡名带 PR-#101（#652：审官/分块子卡常见形态）
        wt({ id: 'w1', name: 'PR-#101 工人·块1', pr: null, parent: 'p1' }),
      ],
    };
    const results = S.processArchiveNotices([
      archiveMsg({ subject: '可归档：#101', payload: { worktree: 'w1' } }),
    ], io);
    await t.test('父树挂未合 PR → 只拆命中子卡，不碰父树', () => {
      assert.ok(results[0].removed === true && io.calls.rm.join(',') === 'w1', '只拆命中子卡  →  ' + JSON.stringify({ res: results[0], rm: io.calls.rm }));
    });
    await t.test('未合并 PR 的父树不因可归档被删', () => {
      assert.ok(!io.calls.rm.includes('p1'), '未合并 PR 的父树不因可归档被删  →  ' + JSON.stringify(io.calls.rm));
    });

    const io2 = recorder();
    io2.state.prQuery = { ok: true, state: 'MERGED' };
    io2.state.listed = {
      ok: true,
      worktrees: [
        wt({ id: 'master', name: 'master', main: true }),
        // 父树没有 linkedPR，只带 ISSUE 号；子卡卡名带 PR-#101
        wt({ id: 'p0', name: 'ISSUE-#652 工人·head', pr: null, issue: 652, children: ['w3'] }),
        wt({ id: 'w3', name: 'PR-#101 工人·块2', pr: null, parent: 'p0' }),
      ],
    };
    const res2 = S.processArchiveNotices([archiveMsg({ subject: '可归档：#101' })], io2);
    await t.test('无 linkedPR 但卡名 PR-#101 也能按号找到（不含父树）', () => {
      assert.ok(res2[0].removed === true && io2.calls.rm.join(',') === 'w3', '按卡名 PR-#101 找到并删子卡  →  ' + JSON.stringify({ res: res2[0], rm: io2.calls.rm }));
    });

    const io3 = recorder();
    io3.state.prQuery = { ok: true, state: 'MERGED' };
    io3.state.listed = {
      ok: true,
      worktrees: [
        wt({ id: 'master', name: 'master', main: true }),
        // 根卡带本 PR，但子树里还有别的 PR（分块兄弟未合）
        wt({ id: 'r1', name: 'PR-#12 工人·head', pr: 12, children: ['r2'] }),
        wt({ id: 'r2', name: 'PR-#99 工人·块', pr: 99, parent: 'r1' }),
      ],
    };
    const res3 = S.processArchiveNotices([archiveMsg({ payload: { worktree: 'r1' } })], io3);
    await t.test('根卡子树还挂别的 PR → 未删整树（未合并 PR 的树不因可归档被删）', () => {
      assert.ok(res3[0].action === 'escalate' && io3.calls.rm.length === 0 && /别的 PR/.test(res3[0].reason), '根卡子树还挂别的 PR → 未删整树  →  ' + JSON.stringify({ res: res3[0], rm: io3.calls.rm }));
    });
  });

  it('⑤ 同批其它通知类型不进归档闸', async (t) => {
    const S = await LIB_LOAD;
    const io = recorder();
    io.state.prQuery = { ok: true, state: 'MERGED' };
    const batch = [
      { id: 'h', type: 'heartbeat', subject: 'alive' },
      { id: 'e', type: 'escalation', subject: 'Blocked: x' },
      { id: 'a', type: 'ask', subject: '可归档：12' },
      { id: 'q', type: 'question', subject: '问' },
    ];
    const results = S.processArchiveNotices(batch, io);
    await t.test('整批零归档动作', () => {
      assert.ok(results.length === 0 && io.calls.pr.length === 0 && io.calls.rm.length === 0 && io.calls.escalate.length === 0, '整批零归档动作');
    });
  });

  it('⑥ relay 接了闸，审官协议未改', async (t) => {
    const inboxSrc = fs.readFileSync(INBOX, 'utf8');
    const reviewerSrc = fs.readFileSync(REVIEWER, 'utf8');
    await t.test('relay 调用 processArchiveNotices', () => {
      assert.ok(/processArchiveNotices/.test(inboxSrc) && /archive-exec/.test(inboxSrc), 'relay 调用 processArchiveNotices');
    });
    await t.test('审官任务书仍是可归档通知，不自己 rm', () => {
      assert.ok(/--subject "可归档：<PR号>"/.test(reviewerSrc) && /归档动作本身（worktree rm）由帅做/.test(reviewerSrc), '审官任务书仍是可归档通知，不自己 rm');
    });
    await t.test('可归档 → 信箱台 worktree-rm 必带 --force（未跟踪文件不挡删，#652）', () => {
      assert.ok(/\'worktree-rm\',\r?\n\s+\'--worktree\',\r?\n\s+String\(selector\),\r?\n\s+\'--force\'/.test(inboxSrc), '可归档 → 信箱台 worktree-rm 必带 --force  →  ' + inboxSrc.match(/removeWorktreeLive\([\s\S]{0,220}/)?.[0] || '(未找到)');
    });
  });
});
