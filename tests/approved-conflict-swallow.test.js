// #1404：当前 HEAD 已绿但明确 CONFLICTING 时，pushMergeIfReady 尾部
// `if (readyToLand) return true` 没有合并也没有处置，却让调用方 continue，
// 既有冲突维修进不去。批准不是合并能力。
//
// 对照材料：法国 VPS 快照
// `/home/orca/.dao/commander/situation-2026-09-17T21-23-04-259Z.json`（PR #885）。
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const CORE = import('file://' + path.join(__dirname, '..', 'scripts', 'lib', 'commander-core.mjs').replace(/\\/g, '/'));

const SNAPSHOT = '/home/orca/.dao/commander/situation-2026-09-17T21-23-04-259Z.json';
const HEAD_885 = '91dbbbbfeff9f5a33c70d15ecfa95a9784e140f4';
const HEAD = 'aa11bb22cc33dd44ee55ff6677889900aabbccdd';

function baseSituation(over = {}) {
  return {
    github: { scanned: true, issues: [], prs: [] },
    orca: { scanned: true, worktrees: [] },
    trees: { scanned: true, worktrees: [] },
    reviewPending: { scanned: true, items: [] },
    prReviews: { scanned: true, byPr: {} },
    stall: { scanned: true, strikes: {} },
    wakeCounts: {},
    reworkDispatched: {},
    commanderPolicy: { requireModelInRouting: false },
    routingModels: ['grok-4.6', 'deepseek-v4-flash', 'gpt-5.6-sol', 'gpt-5.6-luna'],
    healthRedModels: [],
    ...over,
  };
}

function byKind(r, k) {
  return r.actions.filter((a) => a.kind === k);
}
function prActions(r, n) {
  return r.actions.filter((a) => Number(a.pr) === Number(n));
}
function prRework(r, n) {
  return byKind(r, 'rework').filter((a) => Number(a.pr) === Number(n));
}
function prMerge(r, n) {
  return byKind(r, 'merge').filter((a) => Number(a.pr) === Number(n));
}

function dumpPr(r, n) {
  return JSON.stringify(prActions(r, n).map((a) => ({
    kind: a.kind, pr: a.pr, conflict: a.conflict, why: a.why, reason: a.reason,
  })));
}

/** 最小纯函数入参：当前 HEAD 绿、CI 绿、合门 auto（无署名单 → no-issue/auto）。 */
function greenTicket({
  mergeable = 'CONFLICTING',
  isDraft = false,
  pr = 1404,
  head = HEAD,
  extraPr = {},
  extraSit = {},
  reviews,
} = {}) {
  const prObj = {
    number: pr,
    title: `PR ${pr}`,
    isDraft,
    mergeable,
    headRefOid: head,
    headRefName: `dao-${pr}`,
    body: '',
    labels: [
      { name: 'model/grok-4.6' },
      { name: 'reviewer/gpt-5.6-sol' },
      { name: 'type/写码' },
    ],
    statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }],
    ...extraPr,
  };
  return baseSituation({
    github: { scanned: true, issues: [], prs: [prObj] },
    prReviews: {
      scanned: true,
      byPr: {
        [pr]: {
          reviews: reviews || [{
            state: 'APPROVED',
            body: '看过了，可以合',
            commit_id: head,
            submitted_at: '2026-09-17T17:01:42Z',
          }],
        },
      },
    },
    sessions: { scanned: true, items: [] },
    ...extraSit,
  });
}

function sit885Shape({ mergeable = 'CONFLICTING', sessions } = {}) {
  const head = HEAD_885;
  const pr = {
    number: 885,
    title: '[grok] fix: mirasim 保活安全基础块（#880 卡 D；连树删留给 #1353）',
    isDraft: false,
    mergeable,
    headRefOid: head,
    headRefName: 'mirasim-keepalive-880d',
    reviewDecision: null,
    body: '关联 #880。署名 issue #880。',
    labels: [
      { name: 'model/grok-4.6' },
      { name: 'type/收口' },
      { name: 'reviewer/gpt-5.6-luna' },
    ],
    statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }],
  };
  const issue880 = {
    number: 880,
    title: '项·mirasim运行时重写',
    body: '框架活',
    labels: [
      { name: '已消歧' },
      { name: 'type/体系' },
      { name: 'reviewer/gpt-5.6-luna' },
    ],
  };
  return baseSituation({
    github: { scanned: true, issues: [], attributedIssues: [issue880], prs: [pr] },
    prReviews: {
      scanned: true,
      byPr: {
        885: {
          reviews: [
            {
              state: 'CHANGES_REQUESTED',
              commit_id: 'fd596ce229110b10969fa7d6fade212a8c8d0b65',
              submitted_at: '2026-09-17T09:28:46Z',
              body: '旧头红',
            },
            {
              state: 'APPROVED',
              commit_id: head,
              submitted_at: '2026-09-17T17:01:42Z',
              body: '本轮结论：APPROVED',
            },
          ],
        },
      },
    },
    sessions: sessions !== undefined ? sessions : { scanned: true, items: [] },
    dispatchLedger: {
      scanned: true,
      events: [{
        type: 'job.dispatch',
        identity: '工人',
        merge_policy: 'auto',
        issue_number: 880,
        pr_number: 885,
        job_id: 'dispatch-pi:d09ba33d-5fba-43b8-b166-0289502c8782',
        ts: '2026-09-07T08:31:37+08:00',
      }],
    },
  });
}

describe('#1404 最小纯函数：当前绿票 + CONFLICTING 不得被 readyToLand 吞掉', () => {
  it('负控：当前绿票 + CONFLICTING + 无活执行者 → 恰好一个 rework(conflict:true)，不得 merge', async () => {
    const { decide } = await CORE;
    const r = decide(greenTicket());
    assert.equal(prRework(r, 1404).length, 1, '应派解冲突：' + dumpPr(r, 1404));
    assert.equal(prRework(r, 1404)[0].conflict, true);
    assert.equal(prMerge(r, 1404).length, 0, '不得直接 merge：' + dumpPr(r, 1404));
  });

  it('对照：同样输入只改 MERGEABLE → 当前 HEAD 合并出口；不派 rebase/rework', async () => {
    const { decide } = await CORE;
    const r = decide(greenTicket({ mergeable: 'MERGEABLE' }));
    assert.equal(prMerge(r, 1404).length, 1, dumpPr(r, 1404));
    assert.equal(prMerge(r, 1404)[0].head, HEAD);
    assert.match(prMerge(r, 1404)[0].why, /当前 head/);
    assert.equal(prRework(r, 1404).length, 0, '仅落后不强制 rebase');
  });

  it('当前 HEAD 负控：绿打在旧 commit 上不合；dock unknown 是相邻候选（已有 escalate，本单不扩成维修）', async () => {
    const { decide } = await CORE;
    const r = decide(greenTicket({
      reviews: [{
        state: 'APPROVED',
        body: '旧的',
        commit_id: 'oldheadoldheadoldheadoldheadoldheadoldh',
      }],
    }));
    assert.equal(prMerge(r, 1404).length, 0, '旧绿票不能裸合：' + dumpPr(r, 1404));
    const esc = byKind(r, 'escalate').filter((a) => Number(a.pr) === 1404);
    assert.equal(esc.length, 1, dumpPr(r, 1404));
    assert.equal(esc[0].reason, 'unscanned');
    assert.deepEqual(esc[0].missing, ['dockProof']);
  });

  it('维修后的新 HEAD 不继承旧绿票：MERGEABLE 但批准不在当前 HEAD、无 dock → 不合', async () => {
    const { decide } = await CORE;
    const r = decide(greenTicket({
      mergeable: 'MERGEABLE',
      head: 'newheadnewheadnewheadnewheadnewheadnewh',
      reviews: [{
        state: 'APPROVED',
        body: '旧 HEAD 上的绿',
        commit_id: HEAD,
      }],
    }));
    assert.equal(prMerge(r, 1404).length, 0, '新 HEAD 必须重新验：' + dumpPr(r, 1404));
  });

  it('UNKNOWN 不盲维修、不合', async () => {
    const { decide } = await CORE;
    const r = decide(greenTicket({ mergeable: 'UNKNOWN' }));
    assert.equal(prRework(r, 1404).length, 0, dumpPr(r, 1404));
    assert.equal(prMerge(r, 1404).length, 0, dumpPr(r, 1404));
  });

  it('活工人在做 → 不重复派、不合', async () => {
    const { decide } = await CORE;
    const r = decide(greenTicket({
      extraSit: {
        sessions: {
          scanned: true,
          items: [{ key: 'pi:1', state: 'running', title: 'PR #1404', cwd: '/x/dao-1404' }],
        },
      },
    }));
    assert.equal(prRework(r, 1404).length, 0, dumpPr(r, 1404));
    assert.equal(prMerge(r, 1404).length, 0, dumpPr(r, 1404));
  });

  it('会话名单没查成 → 不派（查不成当有人在做）', async () => {
    const { decide } = await CORE;
    const r = decide(greenTicket({
      extraSit: { sessions: { scanned: false, error: 'execution session scan incomplete' } },
    }));
    assert.equal(prRework(r, 1404).length, 0, dumpPr(r, 1404));
    assert.equal(prMerge(r, 1404).length, 0, dumpPr(r, 1404));
  });

  it('draft + 当前绿 + CONFLICTING + 无活人 → 维修，不合', async () => {
    const { decide } = await CORE;
    const r = decide(greenTicket({ isDraft: true }));
    assert.equal(prRework(r, 1404).length, 1, dumpPr(r, 1404));
    assert.equal(prRework(r, 1404)[0].conflict, true);
    assert.equal(prMerge(r, 1404).length, 0);
  });

  it('manual 合门 + MERGEABLE → 不擅自 auto merge', async () => {
    const { decide } = await CORE;
    const sit = greenTicket({ mergeable: 'MERGEABLE', extraPr: { body: '署名 issue #1400' } });
    sit.github.issues = [{
      number: 1400,
      title: '框架',
      body: '体系活',
      labels: [{ name: 'type/体系' }, { name: '已消歧' }],
    }];
    const r = decide(sit);
    assert.equal(prMerge(r, 1404).length, 0, 'manual 不得 auto merge：' + dumpPr(r, 1404));
  });

  it('manual 合门 + CONFLICTING + 无活人 → 维修，不合', async () => {
    const { decide } = await CORE;
    const sit = greenTicket({ extraPr: { body: '署名 issue #1400' } });
    sit.github.issues = [{
      number: 1400,
      title: '框架',
      body: '体系活',
      labels: [{ name: 'type/体系' }, { name: '已消歧' }],
    }];
    const r = decide(sit);
    assert.equal(prMerge(r, 1404).length, 0, dumpPr(r, 1404));
    assert.equal(prRework(r, 1404).length, 1, dumpPr(r, 1404));
    assert.equal(prRework(r, 1404)[0].conflict, true);
  });
});

describe('#1404 现场 #885 形状 / 快照回放', () => {
  it('885 形状：账本 auto + 当前 HEAD 绿 + CONFLICTING + 无活人 → rework(conflict:true)，不得 merge', async () => {
    const { decide } = await CORE;
    const r = decide(sit885Shape());
    assert.equal(prRework(r, 885).length, 1, dumpPr(r, 885));
    assert.equal(prRework(r, 885)[0].conflict, true);
    assert.equal(prMerge(r, 885).length, 0, dumpPr(r, 885));
  });

  it('885 形状对照：只改 MERGEABLE → auto merge（why 含当前 head）；不派 rebase', async () => {
    const { decide } = await CORE;
    const r = decide(sit885Shape({ mergeable: 'MERGEABLE' }));
    assert.equal(prMerge(r, 885).length, 1, dumpPr(r, 885));
    assert.equal(prMerge(r, 885)[0].head, HEAD_885);
    assert.match(prMerge(r, 885)[0].why, /审官判绿（当前 head）\+ CI 绿 \+ MERGEABLE/);
    assert.equal(prRework(r, 885).length, 0);
  });

  it('885 形状：名单没查成 → 不派维修（与快照 sessions.scanned=false 同形）', async () => {
    const { decide } = await CORE;
    const r = decide(sit885Shape({
      sessions: { scanned: false, error: 'execution session scan incomplete' },
    }));
    assert.equal(prRework(r, 885).length, 0, dumpPr(r, 885));
    assert.equal(prMerge(r, 885).length, 0, dumpPr(r, 885));
  });

  it('现场快照回放：不改磁盘；CONFLICTING 零合并；只改 MERGEABLE 立刻 auto merge', async () => {
    if (!fs.existsSync(SNAPSHOT)) {
      assert.ok(true, '本机没有现场快照，形状夹具已覆盖对照');
      return;
    }
    const { decide } = await CORE;
    const snap = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));
    const original = prActions(decide(snap), 885);
    assert.equal(original.filter((a) => a.kind === 'merge').length, 0, '快照不得 merge：' + JSON.stringify(original.map((a) => a.kind)));

    const control = structuredClone(snap);
    control.github.prs.find((p) => p.number === 885).mergeable = 'MERGEABLE';
    const changed = prActions(decide(control), 885);
    const merge = changed.filter((a) => a.kind === 'merge');
    assert.equal(merge.length, 1, 'MERGEABLE 对照应合：' + JSON.stringify(changed.map((a) => ({ kind: a.kind, why: a.why }))));
    assert.match(merge[0].why, /审官判绿（当前 head）\+ CI 绿 \+ MERGEABLE/);
    assert.equal(merge[0].head, HEAD_885);
  });

  it('现场快照回放：内存里只把 sessions 扫成空名单，CONFLICTING 应派维修（定位吞路径，不改磁盘、不改 mergeable）', async () => {
    if (!fs.existsSync(SNAPSHOT)) {
      assert.ok(true, '本机没有现场快照，形状夹具已覆盖');
      return;
    }
    const { decide } = await CORE;
    const snap = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));
    snap.sessions = { scanned: true, items: [] };
    const r = decide(snap);
    assert.equal(prMerge(r, 885).length, 0, dumpPr(r, 885));
    assert.equal(prRework(r, 885).length, 1, '隔离吞路径后应维修：' + dumpPr(r, 885));
    assert.equal(prRework(r, 885)[0].conflict, true);
  });
});
