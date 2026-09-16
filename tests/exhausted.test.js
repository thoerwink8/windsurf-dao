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
// #1236：同步建键（fixture 用）。手拼字面量在加判据版本那天会静默失配。
const { retryKeysSync: RK } = require('../scripts/lib/commander-verbs.mjs');

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
    drainLedger: { [RK.drain(909, 'samehead')]: { at: OLD, pr: '909', tries: 3 } },
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
      drainLedger: { [RK.drain(909, 'samehead')]: { at: OLD, pr: '909', tries: 1 } },
    }));
    assert.equal(byKind(r, 'mark-exhausted').length, 0);
    assert.equal(byKind(r, 'retry-drain').length, 1);
  });
});

describe('#1000 decide：rereview / rework 试满同样打标', () => {
  it('rereview 试满 → mark-exhausted，不是 open-issue', async () => {
    const { decide, MAX_REREVIEW_TRIES, rereviewKey: coreRereviewKey } = await CORE;
    const HEAD = 'f9adbffa1170c57559c64160081619acc328988f';
    const r = decide(baseSituation({
      github: {
        scanned: true,
        issues: [{ number: 801, title: '单', labels: [{ name: 'model/grok-4.6' }, { name: 'reviewer/gpt-5.6-sol' }, { name: 'type/写码' }] }],
        prs: [{ number: 905, isDraft: false, mergeable: 'MERGEABLE', headRefOid: HEAD, body: '署名 issue #801', labels: [{ name: 'model/grok-4.6' }, { name: 'reviewer/gpt-5.6-sol' }] }],
      },
      prReviews: { scanned: true, byPr: { 905: { reviews: [{ state: 'CHANGES_REQUESTED', body: '一处', commit_id: 'old' }] } } },
      // #1236：键走生产侧那把（core.rereviewKey），不手拼字面量——
      // 手拼的键在加判据版本那天会**静默失配**，测试假绿而生产卡死。
      reworkDispatched: { [coreRereviewKey(905, HEAD)]: { at: OLD, pr: 905, head: HEAD, kind: 'rereview', tries: MAX_REREVIEW_TRIES } },
    }));
    assert.equal(byKind(r, 'rereview').length, 0);
    const marked = byKind(r, 'mark-exhausted');
    assert.equal(marked.length, 1, JSON.stringify(r.actions));
    assert.equal(marked[0].verb, 'rereview');
    assert.equal(byKind(r, 'open-issue').length, 0);
  });

  it('rework 试满 → mark-exhausted，不是 escalate', async () => {
    const { decide, MAX_REWORK_TRIES, reworkKey: coreReworkKey } = await CORE;
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
      reworkDispatched: { [coreReworkKey(950, 'h950')]: { at: OLD, pr: 950, head: 'h950', ok: false, unscanned: false, tries: MAX_REWORK_TRIES } },
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

  it('反证：同一个 head、同一个判据版本 → 不许摘（那才是「已认输」的本意）', async () => {
    const { planExhaustedLabelClear } = await EX;
    const r = planExhaustedLabelClear({
      prs: [prWith(100, 'SAMEHEAD', [EXHAUSTED])],
      // #1238：账本键带判据版本；版本没变、head 没变 → 这次认输仍然成立。
      ledger: { 'pushed:100@SAMEHEAD@eaaaaaaaaaaaa': { pr: 100, head: 'SAMEHEAD', at: '2026-09-13T00:00:00Z' } },
      epoch: 'aaaaaaaaaaaa',
    });
    assert.equal(r.clears.length, 0);
    assert.equal(r.skipped.some((x) => x.why === 'same-head-same-epoch'), true,
      '两条都没变才算「仍认输」  →  ' + JSON.stringify(r.skipped));
  });

  it('「等用户」不摘——人没回话之前机器不该自己动', async () => {
    const { planExhaustedLabelClear } = await EX;
    const r = planExhaustedLabelClear({
      prs: [prWith(100, 'NEWHEAD', [WAITING])],
      ledger: { 'pushed:100@OLDHEAD': { pr: 100, head: 'OLDHEAD' } },
    });
    assert.equal(r.clears.length, 0);
  });

  // ── #1238：判据变了，标也要过期 ────────────────────────────────────────────
  // 2026-09-13 第二次实咬：摘标原先只认「工人推了新 head」，于是**判据修好了但没人推
  // 新 head 的 PR 永远过期不了**。实测 6 张（#1225/#1213/#1211/#1209/#1111/#1148），
  // 其中 #1111/#1148 的病早已修在 master 上，标还挂着；人对它们「摘标重推」也无效。
  it('head 没动但判据版本变了 → 摘（挡住它的那套判据改过了）', async () => {
    const { planExhaustedLabelClear } = await EX;
    // 版本号**从真模块取**，不手打——手打 12 位 hex 这件事我当场就数错过两次
    // （这正是「凡是需要手打的常量早晚会被凭印象填」那条判例的形状，只不过发生在我自己身上）。
    const { epochOf } = await VERBS;
    const nowEpoch = epochOf().epoch;
    const oldEpoch = nowEpoch === 'aaaaaaaaaaaa' ? 'bbbbbbbbbbbb' : 'aaaaaaaaaaaa';
    const r = planExhaustedLabelClear({
      prs: [prWith(100, 'SAMEHEAD', [EXHAUSTED])],
      ledger: { [`pushed:100@SAMEHEAD@e${oldEpoch}`]: { pr: 100, head: 'SAMEHEAD', at: '2026-09-10T00:00:00Z' } },
      epoch: nowEpoch,
    });
    assert.equal(r.clears.length, 1, JSON.stringify(r));
    assert.equal(r.clears[0].reason, 'epoch-changed', '要说得出是版本变的，不是 head 变的');
    assert.ok(r.clears[0].why.includes(oldEpoch), '旧版本要写在理由里  →  ' + r.clears[0].why);
    assert.ok(r.clears[0].why.includes(nowEpoch), '新版本也要在  →  ' + r.clears[0].why);
  });

  it('老记录没带版本 → 按过期处理（留着 = 可能永久卡死）', async () => {
    const { planExhaustedLabelClear } = await EX;
    const r = planExhaustedLabelClear({
      prs: [prWith(100, 'SAMEHEAD', [EXHAUSTED])],
      ledger: { 'pushed:100@SAMEHEAD': { pr: 100, head: 'SAMEHEAD', at: '2026-09-07T00:00:00Z' } },
      epoch: 'aaaaaaaaaaaa',
    });
    assert.equal(r.clears.length, 1, '加版本之前的记录无从判断，按过期处理');
    assert.equal(r.clears[0].reason, 'epoch-missing');
  });

  it('本轮版本没算成 + 老记录 → 不动手（没依据不许摘）', async () => {
    const { planExhaustedLabelClear } = await EX;
    const r = planExhaustedLabelClear({
      prs: [prWith(100, 'SAMEHEAD', [EXHAUSTED])],
      ledger: { 'pushed:100@SAMEHEAD@eaaaaaaaaaaaa': { pr: 100, head: 'SAMEHEAD', at: '2026-09-07T00:00:00Z' } },
      epoch: null,
    });
    assert.equal(r.clears.length, 0, '这一轮算不出判据版本，就没依据说标过期了');
    assert.equal(r.skipped.some((x) => x.why === 'epoch-unscanned'), true);
  });

  it('一张 PR 多条记录 → 取 at 最新的那条比（不是 Object.keys 的第一条）', async () => {
    const { planExhaustedLabelClear } = await EX;
    const { epochOf } = await VERBS;
    const nowEpoch = epochOf().epoch;
    const oldEpoch = nowEpoch === 'aaaaaaaaaaaa' ? 'bbbbbbbbbbbb' : 'aaaaaaaaaaaa';
    // 构造一个**只有按 at 取最新才判得对**的场面：
    //   最老那条 = 旧版本的记录（按它比 → 摘，理由是 epoch-missing/changed）
    //   最新那条 = 新版本、同 head（按它比 → 不摘：这次认输仍然成立）
    // 误取最老那条 → 会摘掉一个**仍然成立**的标，把已经认输的 PR 重新放回流水线空转。
    const r = planExhaustedLabelClear({
      prs: [prWith(100, 'NEWHEAD', [EXHAUSTED])],
      ledger: {
        [`pushed:100@NEWHEAD@e${oldEpoch}`]: { pr: 100, head: 'NEWHEAD', at: '2026-09-07T00:00:00Z' },
        [`pushed:100@NEWHEAD@e${nowEpoch}`]: { pr: 100, head: 'NEWHEAD', at: '2026-09-13T00:00:00Z' },
      },
      epoch: nowEpoch,
    });
    assert.equal(r.clears.length, 0, '最新那条说这次认输仍成立，就不该摘  →  ' + JSON.stringify(r));
    assert.equal(r.skipped.some((x) => x.why === 'same-head-same-epoch'), true,
      '要走到「同 head 同版本」这条判据上  →  ' + JSON.stringify(r.skipped));
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

// ─────────────────────────────────────────────────────────────────────────────
// 2026-09-14 实咬（本单）：认输记录 head == 当前 head、版本也对得上，而 PR 明明在等复审。
// 9 张同形（#1256 #1232 #1225 #1213 #1211 #1209 #1111 #1096 #885）：红票→返工派成功（记在旧 head）
// →工人推新 head→新 head 上没人复审→叫审官 3 次失败→打认输标→永久焊死 #1213 静默 16 小时。
// ─────────────────────────────────────────────────────────────────────────────
describe('返工已落地 ⇒ 旧认输不成立（第 ④ 条：红票投在旧代码上）', () => {
  // 上面那个 describe 里的 prWith / EXHAUSTED 是块级 const，这里各建一份（不跨块引用）。
  const EXHAUSTED_L = '卡死/自动化认输';
  const WAITING_L = '卡死/等用户';
  const prWith = (n, head, labels) => ({ number: n, isDraft: false, mergeable: 'MERGEABLE', headRefOid: head, labels: labels.map((name) => ({ name })) });
  const HEAD = '56ad3686b7d6c434c2d0394353e02efdf8c616b1';
  const RED_OLD = 'dc4c1dd7b80ff4e5bc0d4193c0b0536a545ad438';
  const stamp = '9d7cf535fb03';
  // 认输记录记的就是当前 head、且带着当前版本——①②③ 一条都不成立。
  const ledger = { [`pushed:1213@${HEAD}@e${stamp}`]: { at: '2026-09-13T21:30:32.028Z', pr: 1213, head: HEAD } };

  it('红票在旧代码上 + 认输记录就在当前 head ⇒ 摘标（这是改前摘不掉的那一格）', async () => {
    const { planExhaustedLabelClear } = await EX;
    const before = planExhaustedLabelClear({ prs: [prWith(1213, HEAD, [EXHAUSTED_L])], ledger, epoch: stamp });
    assert.equal(before.clears.length, 0, '改前它就该摘不掉——这是本条的对照');
    const after = planExhaustedLabelClear({
      prs: [prWith(1213, HEAD, [EXHAUSTED_L])], ledger, epoch: stamp,
      staleRedAt: { 1213: RED_OLD },
    });
    assert.equal(after.clears.length, 1, JSON.stringify(after));
    assert.equal(after.clears[0].reason, 'rework-landed');
    assert.match(after.clears[0].why, /dc4c1dd7/);
  });

  it('红票就在当前 head 上 ⇒ 不摘（那是「真的刚判红」，该走返工不是解冻）', async () => {
    const { planExhaustedLabelClear } = await EX;
    const r = planExhaustedLabelClear({
      prs: [prWith(1213, HEAD, [EXHAUSTED_L])], ledger, epoch: stamp,
      staleRedAt: { 1213: HEAD },
    });
    assert.equal(r.clears.length, 0, JSON.stringify(r));
    assert.equal(r.skipped.some((x) => x.why === 'same-head-same-epoch'), true);
  });

  it('没给 staleRedAt（reviews 没查成）⇒ 第 ④ 条不成立，其余三条照旧', async () => {
    const { planExhaustedLabelClear } = await EX;
    for (const opt of [undefined, null, {}, []]) {
      const r = planExhaustedLabelClear({ prs: [prWith(1213, HEAD, [EXHAUSTED_L])], ledger, epoch: stamp, staleRedAt: opt });
      assert.equal(r.clears.length, 0, `staleRedAt=${JSON.stringify(opt)}`);
    }
    // 其余三条没被连坐：换成旧 head 照样摘
    const r2 = planExhaustedLabelClear({
      prs: [prWith(1213, HEAD, [EXHAUSTED_L])],
      ledger: { 'pushed:1213@OLDHEAD': { pr: 1213, head: 'OLDHEAD' } },
      epoch: stamp, staleRedAt: null,
    });
    assert.equal(r2.clears.length, 1);
    assert.equal(r2.clears[0].reason, 'new-head');
  });

  it('「等用户」照旧不摘——第 ④ 条也不许越过它', async () => {
    const { planExhaustedLabelClear } = await EX;
    const r = planExhaustedLabelClear({
      prs: [prWith(1213, HEAD, [EXHAUSTED_L, WAITING_L])], ledger, epoch: stamp,
      staleRedAt: { 1213: RED_OLD },
    });
    assert.equal(r.clears.length, 0);
    assert.equal(r.skipped.some((x) => x.why === 'waiting-user'), true);
  });

  it('staleRedAt 收 Map 也收普通对象（调用方两种都可能传）', async () => {
    const { planExhaustedLabelClear } = await EX;
    const r = planExhaustedLabelClear({
      prs: [prWith(1213, HEAD, [EXHAUSTED_L])], ledger, epoch: stamp,
      staleRedAt: new Map([[1213, RED_OLD]]),
    });
    assert.equal(r.clears.length, 1);
    assert.equal(r.clears[0].reason, 'rework-landed');
  });

  it('这份旧红票的新键已试满 → 不再摘（④ 一次性消费；否则 clear→rereview→mark 无限转）', async () => {
    const { planExhaustedLabelClear } = await EX;
    const r = planExhaustedLabelClear({
      prs: [prWith(1213, HEAD, [EXHAUSTED_L])], ledger, epoch: stamp,
      staleRedAt: { 1213: RED_OLD },
      spentStaleReds: { 1213: RED_OLD },
    });
    assert.equal(r.clears.length, 0, JSON.stringify(r));
    assert.equal(r.skipped.some((x) => x.why === 'stale-red-spent'), true,
      '要说得出是「新键已试满」才不摘，不是默默掉进 same-head  →  ' + JSON.stringify(r.skipped));
  });

  it('新键试满但工人又推了新 head → 仍摘（① 不被 ④ 的消费连坐）', async () => {
    const { planExhaustedLabelClear } = await EX;
    const r = planExhaustedLabelClear({
      prs: [prWith(1213, 'NEWHEAD999', [EXHAUSTED_L])],
      ledger: { [`pushed:1213@${HEAD}@e${stamp}`]: { at: '2026-09-13T21:30:32.028Z', pr: 1213, head: HEAD } },
      epoch: stamp,
      staleRedAt: { 1213: RED_OLD },
      spentStaleReds: { 1213: RED_OLD },
    });
    assert.equal(r.clears.length, 1, JSON.stringify(r));
    assert.equal(r.clears[0].reason, 'new-head');
  });

  it('消费表对不上当前红票 → ④ 仍成立（没依据不许假装已经试过）', async () => {
    const { planExhaustedLabelClear } = await EX;
    const r = planExhaustedLabelClear({
      prs: [prWith(1213, HEAD, [EXHAUSTED_L])], ledger, epoch: stamp,
      staleRedAt: { 1213: RED_OLD },
      spentStaleReds: { 1213: 'cccccccccccccccccccccccccccccccccccccccc' },
    });
    assert.equal(r.clears.length, 1, JSON.stringify(r));
    assert.equal(r.clears[0].reason, 'rework-landed');
  });
});

describe('第 ④ 条的证据：staleRedBallots 只收「红票确实投在旧代码上」', () => {
  const HEAD = '56ad3686b7d6c434c2d0394353e02efdf8c616b1';
  const RED_OLD = 'dc4c1dd7b80ff4e5bc0d4193c0b0536a545ad438';
  const prs = [{ number: 1213, headRefOid: HEAD }];
  const withReviews = (reviews) => ({ 1213: { reviews } });

  it('正控：红票在旧代码上 ⇒ 收下那张红票的 commit', async () => {
    const { staleRedBallots } = await CORE;
    const got = staleRedBallots({ prs, reviewsByPr: withReviews([{ state: 'CHANGES_REQUESTED', commit_id: RED_OLD }]) });
    assert.equal(got.get('1213'), RED_OLD);
  });

  it('反证：红票就在当前 head 上 ⇒ 不收（那是刚判红，不是「返工完了」）', async () => {
    const { staleRedBallots } = await CORE;
    const got = staleRedBallots({ prs, reviewsByPr: withReviews([{ state: 'CHANGES_REQUESTED', commit_id: HEAD }]) });
    assert.equal(got.size, 0);
  });

  it('反证：末条判定是绿 ⇒ 不收（绿票过期是另一条判据，不许在这里冒充红）', async () => {
    const { staleRedBallots } = await CORE;
    const got = staleRedBallots({ prs, reviewsByPr: withReviews([
      { state: 'CHANGES_REQUESTED', commit_id: RED_OLD },
      { state: 'APPROVED', commit_id: RED_OLD },
    ]) });
    assert.equal(got.size, 0);
  });

  it('没查成的三种一律不收：reviews 缺 / 缺 commit_id / head 缺', async () => {
    const { staleRedBallots } = await CORE;
    assert.equal(staleRedBallots({ prs, reviewsByPr: {} }).size, 0);
    assert.equal(staleRedBallots({ prs, reviewsByPr: withReviews([{ state: 'CHANGES_REQUESTED' }]) }).size, 0);
    assert.equal(staleRedBallots({
      prs: [{ number: 1 }],
      reviewsByPr: { 1: { reviews: [{ state: 'CHANGES_REQUESTED', commit_id: RED_OLD }] } },
    }).size, 0);
  });

  it('没有判别态 review（一条都没审）⇒ 不收', async () => {
    const { staleRedBallots } = await CORE;
    assert.equal(staleRedBallots({ prs, reviewsByPr: withReviews([]) }).size, 0);
    assert.equal(staleRedBallots({ prs, reviewsByPr: withReviews([{ state: 'COMMENTED', commit_id: RED_OLD }]) }).size, 0);
  });
});

describe('复审重试账：同一份红票只烧一次名额', () => {
  const HEAD = '56ad';
  const RED = 'dc4c1dd7b80ff4e5bc0d4193c0b0536a545ad438';

  it('没给红票表 ⇒ 与老键逐字一致（没依据不许改行为）', async () => {
    const { rereviewKey, rereviewBudgetKey } = await CORE;
    assert.equal(rereviewBudgetKey(1213, HEAD, null), rereviewKey(1213, HEAD));
    assert.equal(rereviewBudgetKey(1213, HEAD, {}), rereviewKey(1213, HEAD));
    assert.equal(rereviewBudgetKey(1213, HEAD, new Map()), rereviewKey(1213, HEAD));
  });

  it('红票在旧代码上 ⇒ 键带上那张红票的 commit（红票换了 = 名额重算）', async () => {
    const { rereviewBudgetKey } = await CORE;
    const k = rereviewBudgetKey(1213, HEAD, { 1213: RED });
    assert.equal(k.endsWith(`@red:${RED}`), true, k);
  });

  it('现场正控：改前那个「试满 3 次」的键，改后不再是同一个格子', async () => {
    const { rereviewKey, rereviewBudgetKey } = await CORE;
    const old = rereviewKey(1213, HEAD);                       // 账本里 tries=3 的那条
    const now = rereviewBudgetKey(1213, HEAD, { 1213: RED });
    assert.notEqual(now, old, '键没变 ⇒ 读到老的 tries=3 ⇒ 摘了标也照样当场再认输一轮');
  });
});

describe('第 ④ 条的一次性消费：spentStaleReds 只认「新键已试满」', () => {
  const HEAD = '56ad3686b7d6c434c2d0394353e02efdf8c616b1';
  const RED_OLD = 'dc4c1dd7b80ff4e5bc0d4193c0b0536a545ad438';
  const prs = [{ number: 1213, headRefOid: HEAD }];

  it('新键 tries 到顶 → 收下（第二次 mark-exhausted 之后 ④ 必须能看见）', async () => {
    const { spentStaleReds, rereviewBudgetKey, MAX_REREVIEW_TRIES } = await CORE;
    const k = rereviewBudgetKey(1213, HEAD, { 1213: RED_OLD });
    const got = spentStaleReds({
      prs, staleRedAt: { 1213: RED_OLD },
      reworkDispatched: { [k]: { at: OLD, pr: 1213, head: HEAD, kind: 'rereview', tries: MAX_REREVIEW_TRIES } },
    });
    assert.equal(got.get('1213'), RED_OLD);
  });

  it('只有老键试满、新键还没烧过 → 不收（这正是 ④ 要解冻的那一轮）', async () => {
    const { spentStaleReds, rereviewKey, MAX_REREVIEW_TRIES } = await CORE;
    const got = spentStaleReds({
      prs, staleRedAt: { 1213: RED_OLD },
      reworkDispatched: {
        [rereviewKey(1213, HEAD)]: { at: OLD, pr: 1213, head: HEAD, kind: 'rereview', tries: MAX_REREVIEW_TRIES },
      },
    });
    assert.equal(got.size, 0);
  });

  it('新键未满 → 不收', async () => {
    const { spentStaleReds, rereviewBudgetKey } = await CORE;
    const k = rereviewBudgetKey(1213, HEAD, { 1213: RED_OLD });
    const got = spentStaleReds({
      prs, staleRedAt: { 1213: RED_OLD },
      reworkDispatched: { [k]: { at: OLD, pr: 1213, head: HEAD, kind: 'rereview', tries: 1 } },
    });
    assert.equal(got.size, 0);
  });
});

describe('第 ④ 条接线：第二次 mark-exhausted 后的下一轮不再摘标', () => {
  const EXHAUSTED_L = '卡死/自动化认输';
  const HEAD = '56ad3686b7d6c434c2d0394353e02efdf8c616b1';
  const RED_OLD = 'dc4c1dd7b80ff4e5bc0d4193c0b0536a545ad438';
  const prWith = (labels) => ({
    number: 1213, isDraft: false, mergeable: 'MERGEABLE', headRefOid: HEAD,
    labels: labels.map((name) => ({ name })),
  });
  const reviews = { scanned: true, byPr: { 1213: { reviews: [{ state: 'CHANGES_REQUESTED', commit_id: RED_OLD, body: '改' }] } } };

  it('第一次：老键试满、新键还没有 → 仍摘（现场 9 张要的就是这一下）', async () => {
    const { decide, rereviewKey, MAX_REREVIEW_TRIES, epochOf } = await CORE;
    const epoch = epochOf().epoch;
    const r = decide(baseSituation({
      github: { scanned: true, issues: [], prs: [prWith([EXHAUSTED_L])] },
      prReviews: reviews,
      staleRedAt: { 1213: RED_OLD },
      exhaustedPush: { [`pushed:1213@${HEAD}@e${epoch}`]: { at: OLD, pr: 1213, head: HEAD } },
      reworkDispatched: {
        [rereviewKey(1213, HEAD)]: { at: OLD, pr: 1213, head: HEAD, kind: 'rereview', tries: MAX_REREVIEW_TRIES },
      },
    }));
    const ce = byKind(r, 'clear-exhausted');
    assert.equal(ce.length, 1, JSON.stringify(r.actions));
    assert.equal(byKind(r, 'rereview').length, 0, '标还在，复审被 stuck 跳过');
    assert.equal(byKind(r, 'mark-exhausted').length, 0);
  });

  it('第二次 mark-exhausted 后的下一轮：新键已试满 → 零 clear-exhausted（循环在这里断）', async () => {
    const { decide, rereviewBudgetKey, MAX_REREVIEW_TRIES, epochOf } = await CORE;
    const epoch = epochOf().epoch;
    const redKey = rereviewBudgetKey(1213, HEAD, { 1213: RED_OLD });
    const r = decide(baseSituation({
      github: { scanned: true, issues: [], prs: [prWith([EXHAUSTED_L])] },
      prReviews: reviews,
      staleRedAt: { 1213: RED_OLD },
      exhaustedPush: { [`pushed:1213@${HEAD}@e${epoch}`]: { at: OLD, pr: 1213, head: HEAD } },
      reworkDispatched: {
        [redKey]: { at: OLD, pr: 1213, head: HEAD, kind: 'rereview', tries: MAX_REREVIEW_TRIES },
      },
    }));
    assert.equal(byKind(r, 'clear-exhausted').length, 0, JSON.stringify(r.actions));
    assert.equal(byKind(r, 'rereview').length, 0);
    assert.equal(byKind(r, 'mark-exhausted').length, 0, '标还在，不重复打');
  });
});
