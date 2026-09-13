// #1000：exhausted 是 PR 属性，不是待发送事件。
// 纯函数钉：打标 / 跳过 / 看门狗按 @head 推一次。不许改 escalate 去重。
const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const REPO = path.resolve(__dirname, '..');
const EX = import('file://' + path.join(REPO, 'scripts', 'lib', 'exhausted.mjs').replace(/\\/g, '/'));
const CORE = import('file://' + path.join(REPO, 'scripts', 'lib', 'commander-core.mjs').replace(/\\/g, '/'));
const BOARD = import('file://' + path.join(REPO, 'scripts', 'lib', 'now-board.mjs').replace(/\\/g, '/'));
const VERBS = import('file://' + path.join(REPO, 'scripts', 'lib', 'commander-verbs.mjs').replace(/\\/g, '/'));

function baseSituation(over = {}) {
  return {
    github: { scanned: true, issues: [], prs: [] },
    orca: { scanned: true, worktrees: [] },
    reviewPending: { scanned: true, items: [] },
    prReviews: { scanned: true, byPr: {} },
    stall: { scanned: true, strikes: {} },
    wakeCounts: {},
    reworkDispatched: {},
    commanderPolicy: { requireModelInRouting: false },
    routingModels: ['grok-4.6', 'gpt-5.6-sol'],
    healthRedModels: [],
    at: '2026-09-06T12:00:00.000Z',
    ...over,
  };
}
const byKind = (r, k) => r.actions.filter((a) => a.kind === k);
const OLD = '2026-09-05T00:00:00.000Z';

describe('#1000 账本键必须带 @head', () => {
  it('有 pr 有 head → pushed:<pr>@<head>', async () => {
    const { exhaustedPushKey } = await EX;
    assert.equal(exhaustedPushKey(909, 'abc'), 'pushed:909@abc');
  });
  it('缺 head 不给键——不许退回只用 pr（#909 就是栽在这上面）', async () => {
    const { exhaustedPushKey } = await EX;
    assert.equal(exhaustedPushKey(909, ''), null);
    assert.equal(exhaustedPushKey(909, null), null);
    assert.equal(exhaustedPushKey(null, 'abc'), null);
  });
});

describe('#1000 看门狗：同一 (pr, head) 只推一次', () => {
  const pr = (over) => ({
    number: 909, title: '卡死', headRefOid: 'headA',
    labels: [{ name: '卡死/自动化认输' }], ...over,
  });

  it('带认输标 + 新 (pr,head) → 推一次', async () => {
    const { planExhaustedPush } = await EX;
    const r = planExhaustedPush({ prs: [pr()], ledger: {} });
    assert.equal(r.pushes.length, 1);
    assert.equal(r.pushes[0].key, 'pushed:909@headA');
    assert.match(r.pushes[0].text, /自动化认输/);
  });

  it('同一 (pr,head) 账本已有 → 不再推', async () => {
    const { planExhaustedPush } = await EX;
    const r = planExhaustedPush({
      prs: [pr()],
      ledger: { 'pushed:909@headA': { at: OLD, pr: 909, head: 'headA' } },
    });
    assert.equal(r.pushes.length, 0);
    assert.ok(r.skipped.some((s) => s.why === 'already-pushed'));
  });

  it('head 改了 → 允许再推一次', async () => {
    const { planExhaustedPush } = await EX;
    const r = planExhaustedPush({
      prs: [pr({ headRefOid: 'headB' })],
      ledger: { 'pushed:909@headA': { at: OLD, pr: 909, head: 'headA' } },
    });
    assert.equal(r.pushes.length, 1);
    assert.equal(r.pushes[0].key, 'pushed:909@headB');
  });

  it('换成「卡死/等用户」→ 不再推', async () => {
    const { planExhaustedPush } = await EX;
    const r = planExhaustedPush({
      prs: [pr({ labels: [{ name: '卡死/等用户' }] })],
      ledger: {},
    });
    assert.equal(r.pushes.length, 0);
    assert.ok(r.skipped.some((s) => s.why === 'waiting-user'));
  });

  it('帅位移除 label → 不再推', async () => {
    const { planExhaustedPush } = await EX;
    const r = planExhaustedPush({ prs: [pr({ labels: [] })], ledger: {} });
    assert.equal(r.pushes.length, 0);
  });

  it('head 没查成 → 不推、不写无 head 键', async () => {
    const { planExhaustedPush } = await EX;
    const r = planExhaustedPush({ prs: [pr({ headRefOid: null })], ledger: {} });
    assert.equal(r.pushes.length, 0);
    assert.ok(r.skipped.some((s) => s.why === 'head-unscanned'));
  });

  it('labels 没查成 → 不推（没查成 ≠ 没有标）', async () => {
    const { planExhaustedPush } = await EX;
    const r = planExhaustedPush({ prs: [pr({ labels: null })], ledger: {} });
    assert.equal(r.pushes.length, 0);
    assert.ok(r.skipped.some((s) => s.why === 'labels-unscanned'));
  });
});

describe('#1000 decide：drain 试满打标，不再开单', () => {
  const ticket = (pr, oid) => ({ pr, head: { name: null, oid }, reviewer: 'gpt-5.6-luna', worker: null });
  const sit = (over) => baseSituation({
    github: {
      scanned: true, issues: [],
      prs: [{ number: 909, isDraft: false, mergeable: 'MERGEABLE', headRefOid: 'samehead', labels: [] }],
    },
    reviewPending: { scanned: true, items: [ticket(909, 'samehead')] },
    drainLedger: { 'pr:909@samehead': { at: OLD, pr: '909', tries: 3 } },
    ...over,
  });

  it('tries 到顶 → mark-exhausted，不产 open-issue / escalate(drain-exhausted)', async () => {
    const { decide } = await CORE;
    const r = decide(sit());
    const marked = byKind(r, 'mark-exhausted');
    assert.equal(marked.length, 1, JSON.stringify(r.actions));
    assert.equal(marked[0].pr, 909);
    assert.equal(marked[0].verb, 'drain');
    assert.equal(marked[0].tries, 3);
    assert.equal(marked[0].head, 'samehead');
    assert.match(marked[0].comment, /\[commander-exhausted\]/);
    assert.equal(byKind(r, 'open-issue').length, 0);
    assert.equal(byKind(r, 'escalate').filter((a) => a.reason === 'drain-exhausted').length, 0);
    assert.equal(byKind(r, 'retry-drain').length, 0);
  });

  it('第二轮已带认输标 → 不重复评论、不再 retry-drain', async () => {
    const { decide } = await CORE;
    const r = decide(sit({
      github: {
        scanned: true, issues: [],
        prs: [{
          number: 909, isDraft: false, mergeable: 'MERGEABLE', headRefOid: 'samehead',
          labels: [{ name: '卡死/自动化认输' }],
        }],
      },
    }));
    assert.equal(byKind(r, 'mark-exhausted').length, 0, JSON.stringify(r.actions));
    assert.equal(byKind(r, 'retry-drain').length, 0);
    assert.equal(byKind(r, 'attach-reviewer').length, 0);
    assert.equal(byKind(r, 'rereview').length, 0);
  });

  it('判别性反例：tries 未满不得打该标', async () => {
    const { decide } = await CORE;
    const r = decide(sit({
      drainLedger: { 'pr:909@samehead': { at: OLD, pr: '909', tries: 1 } },
    }));
    assert.equal(byKind(r, 'mark-exhausted').length, 0);
    assert.equal(byKind(r, 'retry-drain').length, 1);
  });
});

describe('#1000 decide：rereview / rework 试满同样打标', () => {
  it('rereview 试满 → mark-exhausted，不是 open-issue', async () => {
    const { decide, MAX_REREVIEW_TRIES } = await CORE;
    const HEAD = 'f9adbffa1170c57559c64160081619acc328988f';
    const r = decide(baseSituation({
      github: {
        scanned: true,
        issues: [{ number: 801, title: '单', labels: [{ name: 'model/grok-4.6' }, { name: 'reviewer/gpt-5.6-sol' }, { name: 'type/写码' }] }],
        prs: [{ number: 905, isDraft: false, mergeable: 'MERGEABLE', headRefOid: HEAD, body: '署名 issue #801', labels: [{ name: 'model/grok-4.6' }, { name: 'reviewer/gpt-5.6-sol' }] }],
      },
      prReviews: { scanned: true, byPr: { 905: { reviews: [{ state: 'CHANGES_REQUESTED', body: '一处', commit_id: 'old' }] } } },
      reworkDispatched: { [`rereview:905@${HEAD}`]: { at: OLD, pr: 905, head: HEAD, kind: 'rereview', tries: MAX_REREVIEW_TRIES } },
    }));
    assert.equal(byKind(r, 'rereview').length, 0);
    const marked = byKind(r, 'mark-exhausted');
    assert.equal(marked.length, 1, JSON.stringify(r.actions));
    assert.equal(marked[0].verb, 'rereview');
    assert.equal(byKind(r, 'open-issue').length, 0);
  });

  it('rework 试满 → mark-exhausted，不是 escalate', async () => {
    const { decide, MAX_REWORK_TRIES } = await CORE;
    const r = decide(baseSituation({
      github: {
        scanned: true,
        issues: [{ number: 950, title: '单', labels: [{ name: 'model/grok-4.6' }, { name: 'reviewer/gpt-5.6-sol' }, { name: 'type/写码' }] }],
        prs: [{
          number: 950, isDraft: false, reviewDecision: 'CHANGES_REQUESTED', mergeable: 'MERGEABLE',
          headRefOid: 'h950', body: '署名 issue #950', labels: [{ name: 'model/grok-4.6' }, { name: 'reviewer/gpt-5.6-sol' }],
        }],
      },
      prReviews: { scanned: true, byPr: { 950: { reviews: [{ state: 'CHANGES_REQUESTED', body: '要改', commit_id: 'h950' }] } } },
      reworkDispatched: { 'rework:950@h950': { at: OLD, pr: 950, head: 'h950', ok: false, unscanned: false, tries: MAX_REWORK_TRIES } },
    }));
    assert.equal(byKind(r, 'rework').length, 0);
    const marked = byKind(r, 'mark-exhausted');
    assert.equal(marked.length, 1, JSON.stringify(r.actions));
    assert.equal(marked[0].verb, 'rework');
    assert.equal(byKind(r, 'escalate').filter((a) => a.reason === 'rework-exhausted').length, 0);
  });
});

describe('#1147 pump-draft 试满打「卡死/等用户」，不是认输标', () => {
  it('buildMarkExhausted(verb=pump-draft) → waiting-user 标 + 对应评论', async () => {
    const { buildMarkExhausted, WAITING_USER_LABEL, EXHAUSTED_LABEL } = await EX;
    const a = buildMarkExhausted({ pr: 885, verb: 'pump-draft', tries: 2, head: 'h885' });
    assert.equal(a.kind, 'mark-exhausted');
    assert.equal(a.label, WAITING_USER_LABEL);
    assert.equal(a.label === EXHAUSTED_LABEL, false);
    assert.match(a.comment, /卡死\/等用户/);
    assert.match(a.comment, /draft 收口泵/);
  });
});

describe('#1000 wake-exhausted 仍走开单（终端不是 PR）', () => {
  it('OPEN_ISSUE_REASONS 只剩 wake-exhausted', async () => {
    const { OPEN_ISSUE_REASONS } = await VERBS;
    assert.deepEqual([...OPEN_ISSUE_REASONS].sort(), ['wake-exhausted']);
  });
});

describe('#1000 dao now：待你拍列出两个卡死标', () => {
  const NOW = new Date('2026-09-04T16:00:00Z');
  const HEAD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const okEnv = (items) => ({ scanned: true, items });
  const prFixture = (over = {}) => ({
    number: 909, title: '卡死 PR', isDraft: false, reviewDecision: '',
    headRefOid: HEAD, headRefName: 'feat/x', mergeable: 'MERGEABLE',
    updatedAt: '2026-09-04T15:00:00Z', ...over,
  });

  it('挂着「卡死/自动化认输」进待你拍', async () => {
    const S = await BOARD;
    const row = S.assessPr({
      pr: prFixture({ labels: [{ name: '卡死/自动化认输' }] }),
      reviews: okEnv([]),
      registries: okEnv([]), sessions: okEnv([]), worktrees: okEnv([]),
    });
    assert.ok(row.needs.some((n) => n.kind === 'pr-exhausted'), JSON.stringify(row.needs));
    const b = S.renderNow({
      now: NOW,
      prs: okEnv([prFixture({ labels: [{ name: '卡死/自动化认输' }] })]),
      reviews: { byPr: { 909: okEnv([]) } },
      merged: { prs: okEnv([]), commits: okEnv([]) },
      issues: okEnv([]), registries: okEnv([]), worktrees: okEnv([]), sessions: okEnv([]),
    });
    assert.ok(b.decide.items.some((i) => i.kind === 'pr-exhausted'));
    assert.match(S.formatNow(b), /自动化认输/);
  });

  it('挂着「卡死/等用户」进待你拍，且不再当认输新出现', async () => {
    const S = await BOARD;
    const row = S.assessPr({
      pr: prFixture({ labels: [{ name: '卡死/等用户' }] }),
      reviews: okEnv([]),
      registries: okEnv([]), sessions: okEnv([]), worktrees: okEnv([]),
    });
    assert.ok(row.needs.some((n) => n.kind === 'pr-waiting-user'));
    assert.ok(!row.needs.some((n) => n.kind === 'pr-exhausted'));
  });
});

describe('#1000 硬边界：不许改 escalate 去重', () => {
  // 本条守的是「去重机制还在」，不是「函数还叫那个名」。2026-09-06 去重键从
  // 「原因＋对象」改成「原因」（一个原因刷 6 张单的那次），判据跟着搬去 escalate-group.mjs，
  // 名字随之改成 escalateDedupKey——机制本身一个字没少，守的东西不变。
  it('commander.mjs 的 escalateLedger / 去重键判据还在', () => {
    const src = fs.readFileSync(path.join(REPO, 'scripts', 'commander.mjs'), 'utf8');
    assert.match(src, /state\.escalateLedger/);
    assert.match(src, /escalateDedupKey\(action\)/);
    assert.match(src, /function escalate\(/);
  });
  it('ACTION_KINDS 含 mark-exhausted，FORBIDDEN 没放宽', async () => {
    const { ACTION_KINDS, FORBIDDEN_AUTO_KINDS } = await CORE;
    assert.ok(ACTION_KINDS.includes('mark-exhausted'));
    assert.ok(!FORBIDDEN_AUTO_KINDS.has('mark-exhausted'));
  });
  it('ACTION_KINDS 含 pump-draft', async () => {
    const { ACTION_KINDS, FORBIDDEN_AUTO_KINDS } = await CORE;
    assert.equal(ACTION_KINDS.includes('pump-draft'), true);
    assert.equal(FORBIDDEN_AUTO_KINDS.has('pump-draft'), false);
  });
  it('executor 有 mark-exhausted case', () => {
    const src = fs.readFileSync(path.join(REPO, 'scripts', 'commander.mjs'), 'utf8');
    assert.match(src, /case 'mark-exhausted':/);
    assert.match(src, /function execMarkExhausted/);
  });
});

// ── 2026-09-11：认输是带 head 的判据，不是永久标签 ────────────────────────────
// 实咬：这个标只写不摘，12 张 PR 被永久焊死（decide 对它们零动作、连报帅都没有）。
// 本文件自己的注释早写着「账本键必须带 @head。只用 pr 会把修好的新局面永久挡住」，
// 但账本带 head、**标签是无头的**——这个不对称就是闩。
describe('认输标签随新 head 自动摘除（自主运转的死点 A）', () => {
  const EXHAUSTED = '卡死/自动化认输';
  const WAITING = '卡死/等用户';
  const prWith = (n, head, labels) => ({ number: n, isDraft: false, mergeable: 'MERGEABLE', headRefOid: head, labels: labels.map((name) => ({ name })) });

  it('工人推了新 head → 摘标（旧认输对新局面不成立）', async () => {
    const { planExhaustedLabelClear } = await EX;
    const r = planExhaustedLabelClear({
      prs: [prWith(100, 'NEWHEAD', [EXHAUSTED])],
      ledger: { 'pushed:100@OLDHEAD': { pr: 100, head: 'OLDHEAD' } },
    });
    assert.equal(r.clears.length, 1);
    assert.equal(r.clears[0].pr, 100);
    assert.equal(r.clears[0].head, 'NEWHEAD');
  });

  it('反证：同一个 head 不许摘（那才是「已认输」的本意）', async () => {
    const { planExhaustedLabelClear } = await EX;
    const r = planExhaustedLabelClear({
      prs: [prWith(100, 'SAMEHEAD', [EXHAUSTED])],
      ledger: { 'pushed:100@SAMEHEAD': { pr: 100, head: 'SAMEHEAD' } },
    });
    assert.equal(r.clears.length, 0);
    assert.equal(r.skipped.some((x) => x.why === 'same-head'), true);
  });

  // 2026-09-13 实咬（真 bug，不是设计）：老实现对「这张 PR 在账本里的记录」用
  // `Object.keys(book).find(v => v.pr === n)` 取**第一条**（插入序最老的），不是最新一条。
  // PR #1143 账本里有三条（a77faa7c → bc83fcf5 → 6c14ce71），find 永远命中 9-08 那条，
  // 于是当前 head 6c14ce71 被误判成「head 变了」→ 摘标 → worker-done 又打标又评论 → 再摘。
  // 每 20 分钟一轮，刷了 136 条同 head 的认输评论，标在「有/无」之间横跳，PR 一步没动。
  // 旧测试每条只放**一条**记录，所以这个 bug 从没被撞到——这条就是那个盲区的正控。
  it('账本里同一 PR 攒了多条记录 → 跟**最新**那条比，不是跟最老的比（#1143 刷屏的根因）', async () => {
    const { planExhaustedLabelClear } = await EX;
    const CUR = '6c14ce71c243ebd98d3ada4505c243df4072aea1';
    const r = planExhaustedLabelClear({
      prs: [prWith(1143, CUR, [EXHAUSTED])],
      ledger: {
        'pushed:1143@a77faa7c11583f97db5a18f6d3d433c136ce7ae2': { at: '2026-09-08T09:31:45.880Z', pr: 1143, head: 'a77faa7c11583f97db5a18f6d3d433c136ce7ae2' },
        'pushed:1143@bc83fcf5909d51f23b91002be2d0a03725ba5e7e': { at: '2026-09-08T10:32:05.566Z', pr: 1143, head: 'bc83fcf5909d51f23b91002be2d0a03725ba5e7e' },
        [`pushed:1143@${CUR}`]: { at: '2026-09-11T06:11:29.507Z', pr: 1143, head: CUR },
      },
    });
    assert.equal(r.clears.length, 0, '最新记录就是当前 head ⇒ 该判 same-head，不许摘');
    assert.equal(r.skipped[0].why, 'same-head');
  });

  it('多条记录里最新那条确实不是当前 head → 才摘（正控：别把该摘的也一起挡了）', async () => {
    const { planExhaustedLabelClear } = await EX;
    const NEW = 'f'.repeat(40);
    const r = planExhaustedLabelClear({
      prs: [prWith(1143, NEW, [EXHAUSTED])],
      ledger: {
        'pushed:1143@a77faa7c11583f97db5a18f6d3d433c136ce7ae2': { at: '2026-09-08T09:31:45.880Z', pr: 1143, head: 'a77faa7c11583f97db5a18f6d3d433c136ce7ae2' },
        'pushed:1143@6c14ce71c243ebd98d3ada4505c243df4072aea1': { at: '2026-09-11T06:11:29.507Z', pr: 1143, head: '6c14ce71c243ebd98d3ada4505c243df4072aea1' },
      },
    });
    assert.equal(r.clears.length, 1);
    assert.equal(r.clears[0].recordedHead, '6c14ce71c243ebd98d3ada4505c243df4072aea1', '要跟最新那条比，不是最老那条');
  });

  it('「等用户」不摘——人没回话之前机器不该自己动', async () => {
    const { planExhaustedLabelClear } = await EX;
    const r = planExhaustedLabelClear({
      prs: [prWith(100, 'NEWHEAD', [WAITING])],
      ledger: { 'pushed:100@OLDHEAD': { pr: 100, head: 'OLDHEAD' } },
    });
    assert.equal(r.clears.length, 0);
  });

  it('反证：账本里没有认输记录 → 不摘（没认输过就无从谈「过期」）', async () => {
    const { planExhaustedLabelClear } = await EX;
    const r = planExhaustedLabelClear({ prs: [prWith(100, 'NEWHEAD', [EXHAUSTED])], ledger: {} });
    assert.equal(r.clears.length, 0);
    assert.equal(r.skipped.some((x) => x.why === 'no-ledger-head'), true);
  });

  it('head 没查成 → 不摘（fail-closed：摘错会让一辆在修的车再被派一次）', async () => {
    const { planExhaustedLabelClear } = await EX;
    const r = planExhaustedLabelClear({
      prs: [{ number: 100, labels: [{ name: EXHAUSTED }] }],
      ledger: { 'pushed:100@OLD': { pr: 100, head: 'OLD' } },
    });
    assert.equal(r.clears.length, 0);
    assert.equal(r.skipped.some((x) => x.why === 'head-unscanned'), true);
  });

  it('decide 真接线：旧 head 认输的 PR 会产出 clear-exhausted', async () => {
    const { decide } = await CORE;
    const r = decide(baseSituation({
      github: { scanned: true, issues: [], prs: [prWith(777, 'NEWHEAD', [EXHAUSTED])] },
      exhaustedPush: { 'pushed:777@OLDHEAD': { pr: 777, head: 'OLDHEAD' } },
    }));
    const ce = byKind(r, 'clear-exhausted');
    assert.equal(ce.length, 1, '接线断了这条就白写');
    assert.equal(ce[0].pr, 777);
  });

  it('ACTION_KINDS 含 clear-exhausted，且 executor 有 case', async () => {
    const { ACTION_KINDS, FORBIDDEN_AUTO_KINDS } = await CORE;
    assert.equal(ACTION_KINDS.includes('clear-exhausted'), true);
    assert.equal(FORBIDDEN_AUTO_KINDS.has('clear-exhausted'), false);
    const src = fs.readFileSync(path.join(REPO, 'scripts', 'commander.mjs'), 'utf8');
    assert.match(src, /case 'clear-exhausted':/);
    assert.match(src, /function execClearExhausted/);
  });
});
