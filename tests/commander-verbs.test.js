// #971 服务器帅位三动词：纯函数校验 + 反证 + 变异。
// 每条校验必须两头都有判别力：合法放行、违规被拒。
// 变异：把该校验摘掉，同一份违规样本必须被放行——证明这条是承重的，不是旁路。
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const VERBS = import('file://' + path.join(REPO, 'scripts', 'lib', 'commander-verbs.mjs').replace(/\\/g, '/'));
// #1236：同步建键（fixture 用）。手拼字面量在加判据版本那天会静默失配。
const { retryKeysSync: RK } = require('../scripts/lib/commander-verbs.mjs');
const CORE = import('file://' + path.join(REPO, 'scripts', 'lib', 'commander-core.mjs').replace(/\\/g, '/'));

const MODELS = [
  { id: 'grok-4.6', provider: 'gw', reviewerDisabled: false },
  { id: 'gpt-5.6-luna', provider: 'gw', reviewerDisabled: false },
  { id: 'gpt-5.6-sol', provider: 'gpt', reviewerDisabled: false },
  { id: 'deepseek-v4-flash', provider: 'gw', reviewerDisabled: false },
  { id: 'claude-opus', provider: 'claude', reviewerDisabled: true },
  { id: 'kimi-k3', provider: 'gw', reviewerDisabled: false },
];

function withOff(id, checks) {
  return { ...checks, [id]: false };
}

const ANSWERS = { done: '补上 reviewer/ 标签并叫审官落判定', batch: 'this', docs: false };
const PAST = Date.parse('2026-09-05T12:00:00.000Z');
const OLD_AT = '2026-09-05T10:00:00.000Z'; // 120 分钟前，过了 45 分钟宽限
const FRESH_AT = '2026-09-05T11:50:00.000Z'; // 10 分钟前，还在宽限

describe('#971 形状对齐：drain 账本与复审同一套 tries', () => {
  it('DRAIN_GRACE_MIN / MAX_DRAIN_TRIES 与 commander-core 同值', async () => {
    const V = await VERBS;
    const C = await CORE;
    assert.equal(V.DRAIN_GRACE_MIN, C.REREVIEW_GRACE_MIN);
    assert.equal(V.MAX_DRAIN_TRIES, C.MAX_REREVIEW_TRIES);
  });

  it('FORBIDDEN_AUTO_KINDS 一字不放宽', async () => {
    const { FORBIDDEN_AUTO_KINDS, ACTION_KINDS } = await CORE;
    assert.deepEqual([...FORBIDDEN_AUTO_KINDS].sort(), [
      'edit-dao', 'merge-force', 'rm-tree', 'worktree-remove', 'worktree-rm', 'write-fingerprint',
    ].sort());
    for (const k of ['add-label', 'retry-drain', 'open-issue', 'mark-exhausted', 'pump-draft', 'reap-tree', 'reap-orphan']) {
      assert.ok(ACTION_KINDS.includes(k), `${k} 必须进白名单`);
      assert.ok(!FORBIDDEN_AUTO_KINDS.has(k), `${k} 不许进禁用表`);
    }
  });
});

describe('add-label 校验：合法放行 / 违规被拒', () => {
  it('合法：reviewer/gpt-5.6-luna 补到 grok 工人单上 → 放行，role 默认 marshal', async () => {
    const { validateAddLabel, DEFAULT_GH_ROLE } = await VERBS;
    const r = validateAddLabel({
      labels: ['reviewer/gpt-5.6-luna'],
      existingLabels: [{ name: 'model/grok-4.6' }],
      models: MODELS,
    });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.role, DEFAULT_GH_ROLE);
    assert.equal(DEFAULT_GH_ROLE, 'marshal');
    assert.deepEqual(r.labels, ['reviewer/gpt-5.6-luna']);
    assert.equal(r.workerId, 'grok-4.6');
    assert.equal(r.reviewerId, 'gpt-5.6-luna');
  });

  it('违规：type/ 前缀一律拒', async () => {
    const { validateAddLabel } = await VERBS;
    const r = validateAddLabel({
      labels: ['type/写码'],
      existingLabels: ['model/grok-4.6'],
      models: MODELS,
      workerId: 'grok-4.6',
      reviewerId: 'gpt-5.6-luna',
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'label-prefix');
  });

  it('违规：不在选型 → 查不到，不猜', async () => {
    const { validateAddLabel } = await VERBS;
    const r = validateAddLabel({
      labels: ['reviewer/no-such-model'],
      existingLabels: ['model/grok-4.6'],
      models: MODELS,
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'not-found');
  });

  it('违规：禁用条目拒（claude-opus）', async () => {
    const { validateAddLabel } = await VERBS;
    const r = validateAddLabel({
      labels: ['reviewer/claude-opus'],
      existingLabels: ['model/grok-4.6'],
      models: MODELS,
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'disabled');
  });

  it('违规：同厂拒（grok 工人 + grok 审官），按家族不是 provider', async () => {
    const { validateAddLabel } = await VERBS;
    const r = validateAddLabel({
      labels: ['reviewer/grok-4.6'],
      existingLabels: ['model/grok-4.6'],
      models: MODELS,
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'same-vendor');
  });

  it('反证：grok 工人 + luna 审官虽同经 gw，跨厂放行（#843 洞）', async () => {
    const { validateAddLabel } = await VERBS;
    const r = validateAddLabel({
      labels: ['reviewer/gpt-5.6-luna'],
      existingLabels: ['model/grok-4.6'],
      models: MODELS,
    });
    assert.equal(r.ok, true, JSON.stringify(r));
  });

  it('违规：同一前缀两个值 → 不唯一，不猜', async () => {
    const { validateAddLabel } = await VERBS;
    const r = validateAddLabel({
      labels: ['reviewer/gpt-5.6-luna', 'reviewer/gpt-5.6-sol'],
      existingLabels: ['model/grok-4.6'],
      models: MODELS,
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'not-unique');
  });

  it('违规：选型没查成 → unscanned，不是「不在表」', async () => {
    const { validateAddLabel } = await VERBS;
    const r = validateAddLabel({
      labels: ['reviewer/gpt-5.6-luna'],
      existingLabels: ['model/grok-4.6'],
      models: null,
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'routing-unscanned');
    assert.equal(r.unscanned, true);
  });

  it('违规：未知 gh role 拒', async () => {
    const { validateAddLabel } = await VERBS;
    const r = validateAddLabel({
      labels: ['reviewer/gpt-5.6-luna'],
      existingLabels: ['model/grok-4.6'],
      models: MODELS,
      role: 'not-a-bot',
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'bad-role');
  });

  it('合法：role=watchdog 放行（参数，不新增 App）', async () => {
    const { validateAddLabel } = await VERBS;
    const r = validateAddLabel({
      labels: ['reviewer/gpt-5.6-luna'],
      existingLabels: ['model/grok-4.6'],
      models: MODELS,
      role: 'watchdog',
    });
    assert.equal(r.ok, true);
    assert.equal(r.role, 'watchdog');
  });

  it('propose：半标能推出唯一跨厂审官；推不出是查不到不是猜', async () => {
    const { proposeAddLabel } = await VERBS;
    const hit = proposeAddLabel({
      existingLabels: ['model/grok-4.6'],
      models: MODELS,
      reviewerOrder: ['gpt-5.6-luna', 'gpt-5.6-sol'],
    });
    assert.equal(hit.ok, true, JSON.stringify(hit));
    assert.deepEqual(hit.labels, ['reviewer/gpt-5.6-luna']);

    const miss = proposeAddLabel({
      existingLabels: ['model/grok-4.6'],
      models: MODELS,
      reviewerOrder: ['grok-4.6'], // 全同厂
    });
    assert.equal(miss.ok, false);
    assert.equal(miss.code, 'not-found');

    const none = proposeAddLabel({
      existingLabels: [],
      models: MODELS,
      reviewerOrder: ['gpt-5.6-luna'],
    });
    assert.equal(none.ok, false);
    assert.equal(none.state, 'none');
  });

  it('planAddLabelCmd：issue 优先、argv 走 gh-as <role>', async () => {
    const { planAddLabelCmd } = await VERBS;
    const r = planAddLabelCmd({
      issue: 971,
      pr: 972,
      labels: ['reviewer/gpt-5.6-luna'],
      existingLabels: ['model/grok-4.6'],
      models: MODELS,
    });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.argv[1], 'scripts/issue-gateway.mjs');
    assert.ok(r.argv.includes('edit-labels'));
    assert.ok(r.argv.includes('--idempotency-key'));
    assert.ok(!r.argv.includes('--identity'));
    assert.ok(r.argv.includes('reviewer/gpt-5.6-luna'));
  });
});

describe('retry-drain 校验：只对队列里的票，派了 ≠ 成了', () => {
  const queued = [{ pr: '905' }];
  // #1236：键走同步建键器（形态 + 判据版本），不手拼——手拼的键在加版本那天会静默失配。
  const ledgerOk = { [RK.drain(905, null)]: { at: OLD_AT, tries: 1 } };

  it('合法：票在队列 + 有上次账 + 过了宽限 + 未试满 → 放行，tries 累加', async () => {
    const { validateRetryDrain } = await VERBS;
    const r = validateRetryDrain({ pr: 905, queue: queued, ledger: ledgerOk, nowMs: PAST });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.tries, 2);
    assert.equal(r.stateKey, RK.drain(905, null));
  });

  it('违规：不在队列不许凭空造票', async () => {
    const { validateRetryDrain } = await VERBS;
    const r = validateRetryDrain({ pr: 905, queue: [{ pr: '1' }], ledger: ledgerOk, nowMs: PAST });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'not-in-queue');
  });

  it('违规：没有上次账 → 应走 attach-reviewer 不是 retry', async () => {
    const { validateRetryDrain } = await VERBS;
    const r = validateRetryDrain({ pr: 905, queue: queued, ledger: {}, nowMs: PAST });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'never-attempted');
  });

  it('违规：宽限期内不重试', async () => {
    const { validateRetryDrain } = await VERBS;
    const r = validateRetryDrain({
      pr: 905, queue: queued, nowMs: PAST,
      ledger: { [RK.drain(905, null)]: { at: FRESH_AT, tries: 1 } },
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'grace');
  });

  it('违规：试满 escalate，账本有 ok:true 也不能当成功（票还在队列=没成）', async () => {
    const { validateRetryDrain, MAX_DRAIN_TRIES } = await VERBS;
    const r = validateRetryDrain({
      pr: 905, queue: queued, nowMs: PAST,
      ledger: { [RK.drain(905, null)]: { at: OLD_AT, tries: MAX_DRAIN_TRIES, ok: true } },
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'exhausted');
    assert.equal(r.escalate, true);
  });

  it('违规：票头过期（!= 当前 head）→ 拒，不重试这张，也不烧 tries', async () => {
    const { validateRetryDrain, MAX_DRAIN_TRIES } = await VERBS;
    const r = validateRetryDrain({
      pr: 905, queue: queued, nowMs: PAST,
      head: 'oldhead', liveHead: 'newhead',
      ledger: { [RK.drain(905, 'oldhead')]: { at: OLD_AT, tries: 1 } },
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'stale-head');
    // 关键：过期的票头即使试满，也不该认输——它问的不是现场。
    const full = validateRetryDrain({
      pr: 905, queue: queued, nowMs: PAST,
      head: 'oldhead', liveHead: 'newhead',
      ledger: { [RK.drain(905, 'oldhead')]: { at: OLD_AT, tries: MAX_DRAIN_TRIES } },
    });
    assert.equal(full.code, 'stale-head', '过期票头必须先于 max-tries 判定');
  });

  it('票头与当前 head 一致 / 有一侧没查成 → 不判过期，其余判据照走', async () => {
    const { validateRetryDrain } = await VERBS;
    const same = validateRetryDrain({
      pr: 905, queue: queued, nowMs: PAST,
      head: 'samehead', liveHead: 'samehead',
      ledger: { [RK.drain(905, 'samehead')]: { at: OLD_AT, tries: 1 } },
    });
    assert.equal(same.ok, true, JSON.stringify(same));
    // 没有 liveHead（老调用方 / PR 不在开放列表）→ 退回旧契约，不因缺参数就拦
    const noLive = validateRetryDrain({
      pr: 905, queue: queued, nowMs: PAST,
      head: 'oldhead',
      ledger: { [RK.drain(905, 'oldhead')]: { at: OLD_AT, tries: 1 } },
    });
    assert.equal(noLive.ok, true, JSON.stringify(noLive));
  });

  it('planRetryDrainCmd：argv 是 drain --pr，不是造新票', async () => {
    const { planRetryDrainCmd } = await VERBS;
    const r = planRetryDrainCmd({ pr: 905 }, { queue: queued, ledger: ledgerOk, nowMs: PAST });
    assert.equal(r.ok, true);
    assert.deepEqual(r.argv, ['node', 'scripts/dao.mjs', 'review-pending-drain', '--pr', '905']);
    assert.ok(!r.argv.includes('--force'), '--pr 只隔离，不过上限只认 --force；指挥官不许带');
  });

  it('planRetryDrainCmd：票上有仓 → argv 带 --repo，不顺手清掉别仓同号票', async () => {
    const { planRetryDrainCmd } = await VERBS;
    const r = planRetryDrainCmd(
      { pr: 905, repo: 'org/a' },
      { queue: queued, ledger: ledgerOk, nowMs: PAST },
    );
    assert.equal(r.ok, true);
    assert.deepEqual(r.argv, [
      'node', 'scripts/dao.mjs', 'review-pending-drain', '--pr', '905', '--repo', 'org/a',
    ]);
  });

  const GATE = 'reviewer-attach 失败：审官位只许同厂换顺位（当前 gpt-5.6-luna／gpt），'
    + '不许换厂到 grok-4.6／grok——换厂只在上一位死于满载/看门狗时成立：没交换厂凭证';

  it('未知但确定性的同一闸拒：tries=1 继续 ok；sameErrorRounds=2 当场 hopeless', async () => {
    const { validateRetryDrain } = await VERBS;
    const r1 = validateRetryDrain({
      pr: 905, queue: queued, nowMs: PAST,
      ledger: { [RK.drain(905, null)]: { at: OLD_AT, tries: 1, lastError: GATE, sameErrorRounds: 1 } },
    });
    assert.equal(r1.ok, true, '只重复一次还放行：' + JSON.stringify(r1));
    assert.equal(r1.tries, 2);

    const r2 = validateRetryDrain({
      pr: 905, queue: queued, nowMs: PAST,
      ledger: { [RK.drain(905, null)]: { at: OLD_AT, tries: 2, lastError: GATE, sameErrorRounds: 2 } },
    });
    assert.equal(r2.ok, false, '连着两轮同错必须停，不许白试到上限');
    assert.equal(r2.code, 'hopeless');
    assert.equal(r2.escalate, true);
    assert.ok(String(r2.error).includes('一模一样') || String(r2.error).includes('换厂凭证'), r2.error);
  });

  it('applyDrainLedger：同一失败连写两次累加 streak；背压不写也不清零', async () => {
    const { applyDrainLedger } = await VERBS;
    const payload = { ok: false, error: GATE };
    let r = applyDrainLedger({ ledger: {}, pr: 905, head: null, payload, nowIso: OLD_AT });
    assert.equal(r.wrote, true);
    assert.equal(r.ledger[RK.drain(905, null)].sameErrorRounds, 1);
    assert.equal(r.ledger[RK.drain(905, null)].lastError, GATE);

    r = applyDrainLedger({ ledger: r.ledger, pr: 905, head: null, payload, nowIso: OLD_AT });
    assert.equal(r.ledger[RK.drain(905, null)].sameErrorRounds, 2);
    assert.equal(r.ledger[RK.drain(905, null)].tries, 2);

    const held = applyDrainLedger({
      ledger: r.ledger, pr: 905, head: null,
      payload: { ok: true, drained: 0, failed: 0, held: 2 },
      nowIso: OLD_AT,
    });
    assert.equal(held.wrote, false);
    assert.equal(held.ledger[RK.drain(905, null)].sameErrorRounds, 2, '满载不许把 streak 清掉');

    const pulled = applyDrainLedger({
      ledger: r.ledger, pr: 905, head: null,
      payload: { ok: true, drained: 1, failed: 0, held: 0 },
      nowIso: OLD_AT,
    });
    assert.equal(pulled.wrote, true);
    assert.equal(pulled.ledger[RK.drain(905, null)].sameErrorRounds, 0, '真拉起才清零');
    assert.equal(pulled.ledger[RK.drain(905, null)].lastError, null);
  });

  it('applyDrainLedger：前 400 字相同但后文不同 ≠ 同错，不判 hopeless', async () => {
    const { applyDrainLedger, validateRetryDrain, drainErrorText } = await VERBS;
    const a = 'E'.repeat(400) + 'A';
    const b = 'E'.repeat(400) + 'B';
    assert.equal(drainErrorText({ error: a }), a, '抽取必须留下完整原文，不许截成 400 个 E');
    let r = applyDrainLedger({
      ledger: {}, pr: 905, head: null, payload: { ok: false, error: a }, nowIso: OLD_AT,
    });
    assert.equal(r.ledger[RK.drain(905, null)].lastError, a);
    assert.equal(r.ledger[RK.drain(905, null)].sameErrorRounds, 1);
    r = applyDrainLedger({
      ledger: r.ledger, pr: 905, head: null, payload: { ok: false, error: b }, nowIso: OLD_AT,
    });
    const rec = r.ledger[RK.drain(905, null)];
    assert.equal(rec.lastError, b, '账本必须留下带后缀的完整原文');
    assert.equal(rec.sameErrorRounds, 1, '后文不同必须从头数，不许被截成 400 个 E 后判同错');
    const v = validateRetryDrain({ pr: 905, queue: queued, nowMs: PAST, ledger: r.ledger });
    assert.equal(v.ok, true, '前缀相同、后缀不同不许判 hopeless：' + JSON.stringify(v));
    assert.notEqual(v.code, 'hopeless');
  });

  it('applyDrainLedger：第一行相同但第二行不同 ≠ 同错', async () => {
    const { applyDrainLedger, validateRetryDrain, drainErrorText } = await VERBS;
    const a = 'gate refused\nhead=aaa';
    const b = 'gate refused\nhead=bbb';
    assert.equal(drainErrorText({ error: a }), a, '第二行是原文的一部分，不许只留首行');
    let r = applyDrainLedger({
      ledger: {}, pr: 905, head: null, payload: { ok: false, error: a }, nowIso: OLD_AT,
    });
    r = applyDrainLedger({
      ledger: r.ledger, pr: 905, head: null, payload: { ok: false, error: b }, nowIso: OLD_AT,
    });
    const rec = r.ledger[RK.drain(905, null)];
    assert.equal(rec.lastError, b);
    assert.equal(rec.sameErrorRounds, 1, '第二行不同 = 另一句');
    const v = validateRetryDrain({ pr: 905, queue: queued, nowMs: PAST, ledger: r.ledger });
    assert.equal(v.ok, true, '只截首行会把这两句揉成同错：' + JSON.stringify(v));
    assert.notEqual(v.code, 'hopeless');
  });

  it('applyDrainLedger：完整长原文连写两次仍 hopeless（正控：不是长了就不比）', async () => {
    const { applyDrainLedger, validateRetryDrain } = await VERBS;
    const a = 'E'.repeat(400) + 'A';
    let r = applyDrainLedger({
      ledger: {}, pr: 905, head: null, payload: { ok: false, error: a }, nowIso: OLD_AT,
    });
    r = applyDrainLedger({
      ledger: r.ledger, pr: 905, head: null, payload: { ok: false, error: a }, nowIso: OLD_AT,
    });
    const rec = r.ledger[RK.drain(905, null)];
    assert.equal(rec.lastError, a);
    assert.equal(rec.sameErrorRounds, 2);
    const v = validateRetryDrain({ pr: 905, queue: queued, nowMs: PAST, ledger: r.ledger });
    assert.equal(v.ok, false);
    assert.equal(v.code, 'hopeless');
  });

  it('review-pending-drain 无 JSON/超时 fallback：前 400 字同、后文不同不判 hopeless', async () => {
    const { attachReceiptFromSpawn, drainReviewPending } = await import(
      'file://' + path.join(REPO, 'scripts', 'lib', 'dispatch', 'review-pending.mjs').replace(/\\/g, '/')
    );
    const { applyDrainLedger, validateRetryDrain, drainErrorText } = await VERBS;
    const a = 'E'.repeat(400) + 'A';
    const b = 'E'.repeat(400) + 'B';
    const ticket = { pr: '905', reviewer: 'gpt-5.6-sol' };
    const shapes = [
      { label: '无 JSON', spawned: (stderr) => ({ status: 1, stdout: 'not-json timeout noise', stderr }) },
      { label: '超时', spawned: (stderr) => ({
        status: null, signal: 'SIGTERM', stdout: '', stderr,
        error: { message: 'spawnSync ETIMEDOUT' },
      }) },
    ];
    for (const { label, spawned } of shapes) {
      const through = (stderr) => {
        const attached = attachReceiptFromSpawn(spawned(stderr));
        assert.equal(attached.ok, false, label);
        assert.equal(attached.error, stderr, label + '：回执必须留下完整 stderr，不许截成 400 个 E');
        const drained = drainReviewPending({ tickets: [ticket], attach: () => attached });
        assert.equal(drained.ok, false, label);
        assert.match(drained.error, new RegExp(stderr.slice(-1) + '$'), label + '：顶层 error 必须带上后缀');
        // dao.mjs fail() 把 drained.error 写进 JSON；指挥官 drainPayloadOf 再抽出来。
        return { ok: false, error: drained.error };
      };
      const pa = through(a);
      const pb = through(b);
      assert.equal(drainErrorText(pa).includes(a), true, label);
      assert.notEqual(drainErrorText(pa), drainErrorText(pb), label);
      assert.ok(drainErrorText(pa).length > 400, label);
      let r = applyDrainLedger({
        ledger: {}, pr: 905, head: null, payload: pa, nowIso: OLD_AT,
      });
      r = applyDrainLedger({
        ledger: r.ledger, pr: 905, head: null, payload: pb, nowIso: OLD_AT,
      });
      const rec = r.ledger[RK.drain(905, null)];
      assert.equal(rec.sameErrorRounds, 1, label + '：截 400 字会把这两句揉成同错');
      assert.ok(String(rec.lastError).endsWith('B'), label);
      const v = validateRetryDrain({ pr: 905, queue: queued, nowMs: PAST, ledger: r.ledger });
      assert.equal(v.ok, true, label + ' 不许判 hopeless：' + JSON.stringify(v));
      assert.notEqual(v.code, 'hopeless', label);
    }
  });

  it('review-pending-drain 真实链：首尾空白不同 ≠ 同错，不判 hopeless', async () => {
    const { attachReceiptFromSpawn, drainReviewPending } = await import(
      'file://' + path.join(REPO, 'scripts', 'lib', 'dispatch', 'review-pending.mjs').replace(/\\/g, '/')
    );
    const { drainPayloadOf } = await import(
      'file://' + path.join(REPO, 'scripts', 'commander.mjs').replace(/\\/g, '/')
    );
    const { applyDrainLedger, validateRetryDrain, drainErrorText } = await VERBS;
    const ticket = { pr: '905', reviewer: 'gpt-5.6-sol' };
    const pairs = [
      { a: 'gate refused\n', b: 'gate refused', label: '尾换行 vs 无换行' },
      { a: ' gate refused', b: 'gate refused', label: '首空格 vs 无空格' },
      { a: 'gate refused ', b: 'gate refused', label: '尾空格 vs 无空格' },
    ];
    const through = (stderr) => {
      const attached = attachReceiptFromSpawn({ status: 1, stdout: 'not-json', stderr });
      assert.equal(attached.ok, false);
      assert.equal(attached.error, stderr, '回执必须留下完整 stderr，含首尾空白');
      const drained = drainReviewPending({ tickets: [ticket], attach: () => attached });
      assert.equal(drained.ok, false);
      assert.ok(
        String(drained.error).endsWith(stderr),
        `顶层 error 必须保留 stderr 原文（含空白），实际=${JSON.stringify(drained.error)}`,
      );
      // dao.mjs fail() 把 drained 整份 emit 成 JSON；指挥官 drainPayloadOf 再抽出来。
      // runCmd.error 是人读摘要（已 trim+截），不许当比较键——这里故意塞一份截过的。
      const emitted = JSON.stringify({ ok: false, error: drained.error, ...drained });
      return drainPayloadOf({
        ok: false, status: 1, out: emitted, stderr: '',
        error: String(drained.error).trim().slice(0, 300),
      });
    };
    for (const { a, b, label } of pairs) {
      const pa = through(a);
      const pb = through(b);
      assert.equal(drainErrorText(pa).includes(a), true, label);
      assert.notEqual(drainErrorText(pa), drainErrorText(pb), label + '：trim 会把这两句揉成一句');
      let r = applyDrainLedger({
        ledger: {}, pr: 905, head: null, payload: pa, nowIso: OLD_AT,
      });
      r = applyDrainLedger({
        ledger: r.ledger, pr: 905, head: null, payload: pb, nowIso: OLD_AT,
      });
      const rec = r.ledger[RK.drain(905, null)];
      assert.equal(rec.sameErrorRounds, 1, label + '：trim 会把 sameErrorRounds 累到 2');
      const v = validateRetryDrain({ pr: 905, queue: queued, nowMs: PAST, ledger: r.ledger });
      assert.equal(v.ok, true, label + ' 不许判 hopeless：' + JSON.stringify(v));
      assert.notEqual(v.code, 'hopeless', label);
    }
    // 正控：同一份带尾换行的原文连写两次，仍 hopeless——不是空白就不比。
    const same = through('gate refused\n');
    let r = applyDrainLedger({
      ledger: {}, pr: 905, head: null, payload: same, nowIso: OLD_AT,
    });
    r = applyDrainLedger({
      ledger: r.ledger, pr: 905, head: null, payload: same, nowIso: OLD_AT,
    });
    assert.equal(r.ledger[RK.drain(905, null)].sameErrorRounds, 2);
    const hopeless = validateRetryDrain({ pr: 905, queue: queued, nowMs: PAST, ledger: r.ledger });
    assert.equal(hopeless.ok, false);
    assert.equal(hopeless.code, 'hopeless');
  });
});

describe('open-issue 校验：原文+reason、三问、去重', () => {
  const base = {
    reason: 'wake-exhausted',
    original: '终端 term_q 撞死指纹已唤大脑 3 次仍没闭环——报帅',
    target: 'term-term_q',
    answers: ANSWERS,
  };

  it('合法：原文+reason+三问齐 → 放行；正文含原文与 reason', async () => {
    const { validateOpenIssue, renderOpenIssueBody } = await VERBS;
    const r = validateOpenIssue(base);
    assert.equal(r.ok, true, JSON.stringify(r));
    const body = renderOpenIssueBody(base);
    assert.equal(body.ok, true);
    assert.ok(body.body.includes(base.original), '正文必须带 escalate 原文');
    assert.ok(body.body.includes(`- 原因：${base.reason}`), '正文必须带 reason');
    assert.ok(!body.body.includes('我觉得应该'), '不许自己编一段');
  });

  it('违规：没有原文 → 拒', async () => {
    const { validateOpenIssue } = await VERBS;
    const r = validateOpenIssue({ ...base, original: '' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'no-original');
  });

  it('违规：三问缺「做到什么算完」→ 不开', async () => {
    const { validateOpenIssue } = await VERBS;
    const r = validateOpenIssue({ ...base, answers: { ...ANSWERS, done: '' } });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'three-questions-done');
  });

  it('违规：不是这批会做 → 不开', async () => {
    const { validateOpenIssue } = await VERBS;
    const r = validateOpenIssue({ ...base, answers: { ...ANSWERS, batch: 'later' } });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'three-questions-batch');
  });

  it('违规：是 memory/docs → 不开', async () => {
    const { validateOpenIssue } = await VERBS;
    const r = validateOpenIssue({ ...base, answers: { ...ANSWERS, docs: true } });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'three-questions-docs');
  });

  it('违规：同一 reason+target 已开过 → 不重开', async () => {
    const { validateOpenIssue, openIssueDedupKey } = await VERBS;
    const key = openIssueDedupKey(base.reason, base.target);
    const r = validateOpenIssue({ ...base, ledger: { [key]: { at: OLD_AT, number: 900 } } });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'dup');
  });

  it('违规：unscanned 不开单', async () => {
    const { validateOpenIssue } = await VERBS;
    const r = validateOpenIssue({ ...base, reason: 'unscanned' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'unscanned-silent');
  });

  it('planOpenIssueCmd：issue-gateway + --body-file，不许 --body / --identity', async () => {
    const { planOpenIssueCmd } = await VERBS;
    const r = planOpenIssueCmd(base, { repo: 'thoerwink8/windsurf-dao', bodyPath: '/tmp/x.md' });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.argv[1], 'scripts/issue-gateway.mjs');
    assert.ok(r.argv.includes('--body-file'));
    assert.ok(!r.argv.includes('--body'));
    assert.ok(!r.argv.includes('--identity'));
    assert.ok(r.argv.includes('--idempotency-key'));
    assert.ok(r.argv.includes('待拍板'));
  });

  it('escalateToOpenIssue：账本有 OPEN 但无 hubSeen → existing 重试卡，不重开', async () => {
    const { escalateToOpenIssue, OPEN_ISSUE_CARD_DEDUP_MS } = await VERBS;
    const action = {
      kind: 'escalate',
      reason: 'wake-exhausted',
      why: base.original,
      term: 'term_q',
    };
    const ledger = { 'wake-exhausted+term_q': { at: OLD_AT, number: 900 } };
    const retry = escalateToOpenIssue(action, { ledger, hubSeen: {}, now: PAST });
    assert.equal(retry && retry.kind, 'open-issue');
    assert.equal(retry.existing, true);
    assert.equal(retry.number, 900);
    assert.equal(retry.reason, 'wake-exhausted');

    const fresh = escalateToOpenIssue(action, {
      ledger,
      hubSeen: { 'esc:wake-exhausted+term_q': FRESH_AT },
      now: PAST,
    });
    assert.equal(fresh, null, '成功后 6 小时内不再发');

    const expiredAt = PAST + OPEN_ISSUE_CARD_DEDUP_MS + 1;
    const expired = escalateToOpenIssue(action, {
      ledger,
      hubSeen: { 'esc:wake-exhausted+term_q': new Date(PAST).toISOString() },
      now: expiredAt,
    });
    assert.equal(expired && expired.existing, true, '过了 6 小时可以再发');
    assert.equal(expired.number, 900);
  });
});

describe('变异：把每个校验摘掉，违规样本必须被放行', () => {
  it('每条校验摘掉当场判红（违规样本变放行）', async () => {
    const V = await VERBS;
    const mutations = [
      {
        id: 'add-label.role',
        run: (checks) => V.validateAddLabel({
          _checks: checks,
          role: 'not-a-bot',
          labels: ['reviewer/gpt-5.6-luna'],
          existingLabels: ['model/grok-4.6'],
          models: MODELS,
        }),
      },
      {
        id: 'add-label.labels-array',
        run: (checks) => V.validateAddLabel({
          _checks: checks,
          labels: [],
          models: MODELS,
          workerId: 'grok-4.6',
          reviewerId: 'gpt-5.6-luna',
        }),
      },
      {
        id: 'add-label.prefix',
        run: (checks) => V.validateAddLabel({
          _checks: checks,
          labels: ['type/grok-4.6'],
          models: MODELS,
          workerId: 'grok-4.6',
          reviewerId: 'gpt-5.6-luna',
        }),
      },
      {
        id: 'add-label.unique-prefix',
        run: (checks) => V.validateAddLabel({
          _checks: checks,
          labels: ['reviewer/gpt-5.6-luna', 'reviewer/gpt-5.6-sol'],
          existingLabels: ['model/grok-4.6'],
          models: MODELS,
        }),
      },
      {
        id: 'add-label.routing',
        run: (checks) => V.validateAddLabel({
          _checks: checks,
          labels: ['reviewer/not-a-model'],
          models: MODELS,
          workerId: 'grok-4.6',
          reviewerId: 'gpt-5.6-luna',
        }),
      },
      {
        id: 'add-label.cross-vendor',
        run: (checks) => V.validateAddLabel({
          _checks: checks,
          labels: ['reviewer/grok-4.6'],
          existingLabels: ['model/grok-4.6'],
          models: MODELS,
        }),
      },
      {
        id: 'retry-drain.pr',
        run: (checks) => V.validateRetryDrain({
          _checks: checks,
          pr: '',
          queue: [{ pr: '' }],
          // #1236：空 pr 的键也走同步建键器（形态 `pr:` + 版本）。手拼会在加版本那天失配。
          ledger: { [RK.drain('', null)]: { at: OLD_AT, tries: 1 } },
          nowMs: PAST,
        }),
      },
      {
        id: 'retry-drain.queue',
        run: (checks) => V.validateRetryDrain({
          _checks: checks,
          pr: 905,
          queue: [{ pr: '1' }],
          ledger: { [RK.drain(905, null)]: { at: OLD_AT, tries: 1 } },
          nowMs: PAST,
        }),
      },
      {
        id: 'retry-drain.attempted',
        run: (checks) => V.validateRetryDrain({
          _checks: checks,
          pr: 905,
          queue: [{ pr: '905' }],
          ledger: {},
          nowMs: PAST,
        }),
      },
      {
        id: 'retry-drain.stale-head',
        run: (checks) => V.validateRetryDrain({
          _checks: checks,
          pr: 905,
          queue: [{ pr: '905' }],
          head: 'oldhead',
          liveHead: 'newhead',
          ledger: { [RK.drain(905, 'oldhead')]: { at: OLD_AT, tries: 1 } },
          nowMs: PAST,
        }),
      },
      {
        id: 'retry-drain.hopeless',
        run: (checks) => V.validateRetryDrain({
          _checks: checks,
          pr: 905,
          queue: [{ pr: '905' }],
          nowMs: PAST,
          ledger: {
            [RK.drain(905, null)]: {
              at: OLD_AT, tries: 2,
              lastError: 'reviewer-attach 失败：审官位只许同厂换顺位（当前 gpt-5.6-luna／gpt），不许换厂到 grok-4.6／grok——换厂只在上一位死于满载/看门狗时成立：没交换厂凭证',
              sameErrorRounds: 2,
            },
          },
        }),
      },
      {
        id: 'retry-drain.max-tries',
        run: (checks) => V.validateRetryDrain({
          _checks: checks,
          pr: 905,
          queue: [{ pr: '905' }],
          ledger: { [RK.drain(905, null)]: { at: OLD_AT, tries: V.MAX_DRAIN_TRIES } },
          nowMs: PAST,
        }),
      },
      {
        id: 'retry-drain.grace',
        run: (checks) => V.validateRetryDrain({
          _checks: checks,
          pr: 905,
          queue: [{ pr: '905' }],
          ledger: { [RK.drain(905, null)]: { at: FRESH_AT, tries: 1 } },
          nowMs: PAST,
        }),
      },
      {
        id: 'open-issue.reason',
        run: (checks) => V.validateOpenIssue({
          _checks: checks,
          reason: '',
          original: '原文在',
          target: 'x',
          answers: ANSWERS,
        }),
      },
      {
        id: 'open-issue.original',
        run: (checks) => V.validateOpenIssue({
          _checks: checks,
          reason: 'wake-exhausted',
          original: '',
          target: 'x',
          answers: ANSWERS,
        }),
      },
      {
        id: 'open-issue.three-questions',
        run: (checks) => V.validateOpenIssue({
          _checks: checks,
          reason: 'wake-exhausted',
          original: '原文在',
          target: 'x',
          answers: { done: '', batch: 'later', docs: true },
        }),
      },
      {
        id: 'open-issue.dedup',
        run: (checks) => V.validateOpenIssue({
          _checks: checks,
          reason: 'wake-exhausted',
          original: '原文在',
          target: 'x',
          answers: ANSWERS,
          ledger: { 'wake-exhausted+x': { at: OLD_AT } },
        }),
      },
    ];

    const ids = Object.keys(V.CHECKS);
    assert.deepEqual(mutations.map((m) => m.id).sort(), ids.sort(), '变异表必须覆盖 CHECKS 每一条');

    const evidence = [];
    for (const m of mutations) {
      const baseline = m.run(V.CHECKS);
      assert.equal(baseline.ok, false, `${m.id} 基线必须拒：${JSON.stringify(baseline)}`);
      const mutated = m.run(withOff(m.id, V.CHECKS));
      assert.equal(mutated.ok, true, `${m.id} 摘掉后违规样本必须被放行（否则这条没有判别力）：${JSON.stringify(mutated)}`);
      evidence.push(`${m.id}: 基线拒(${baseline.code}) → 摘掉放行`);
    }
    assert.equal(evidence.length, ids.length);
  });
});

describe('decide 接线：三个动词接住 escalate，不是只测纯函数', () => {
  function sit(over) {
    return {
      github: { scanned: true, issues: [], prs: [] },
      // 2026-09-06：在途派工的树面从 orca 换成 mirasim（situation.trees）。
      orca: { scanned: true, worktrees: [] },
      trees: { scanned: true, worktrees: [] },
      reviewPending: { scanned: true, items: [] },
      prReviews: { scanned: true, byPr: {} },
      stall: { scanned: true, strikes: {} },
      wakeCounts: {},
      reworkDispatched: {},
      commanderPolicy: { requireModelInRouting: false },
      routingModels: MODELS.filter((m) => !m.reviewerDisabled).map((m) => m.id),
      routingModelRecords: MODELS,
      reviewerOrder: ['gpt-5.6-luna', 'gpt-5.6-sol', 'kimi-k3'],
      workerOrder: ['grok-4.6', 'deepseek-v4-flash'],
      healthRedModels: [],
      at: '2026-09-05T12:00:00.000Z',
      ...over,
    };
  }
  // 队列里的票只有在 PR 真开着时才是活票——2026-09-06 加死票回收后，夹具必须把 PR 摆进开放列表。
  function openPr(n) {
    return { number: n, isDraft: false, mergeable: 'MERGEABLE', headRefOid: `head${n}` };
  }

  it('半标 + 能推出唯一审官 → add-label，不 escalate', async () => {
    const { decide } = await CORE;
    const issue = {
      number: 971, title: '三动词', labels: [
        { name: '已消歧' }, { name: 'model/grok-4.6' }, { name: 'type/写码' },
      ],
    };
    const r = decide(sit({ github: { scanned: true, issues: [issue], prs: [] } }));
    const add = r.actions.filter((a) => a.kind === 'add-label');
    assert.equal(add.length, 1, JSON.stringify(r.actions));
    assert.deepEqual(add[0].labels, ['reviewer/gpt-5.6-luna']);
    assert.equal(r.actions.filter((a) => a.kind === 'escalate' && a.reason === 'missing-labels').length, 0);
    assert.equal(r.actions.filter((a) => a.kind === 'dispatch').length, 0);
  });

  it('half-label but reviewer order all same vendor -> not-found, still escalate, no guess', async () => {
    const { decide } = await CORE;
    const issue = {
      number: 971, title: '三动词', labels: [
        { name: '已消歧' }, { name: 'model/grok-4.6' }, { name: 'type/写码' },
      ],
    };
    const r = decide(sit({
      github: { scanned: true, issues: [issue], prs: [] },
      reviewerOrder: ['grok-4.6'],
    }));
    assert.equal(r.actions.filter((a) => a.kind === 'add-label').length, 0);
    assert.ok(r.actions.some((a) => a.kind === 'escalate' && a.reason === 'missing-labels'));
  });

  it('队列里的票有上次账且过了宽限 → retry-drain，不是 attach-reviewer', async () => {
    const { decide } = await CORE;
    const r = decide(sit({
      github: { scanned: true, issues: [], prs: [openPr(920)] },
      reviewPending: { scanned: true, items: [{ pr: 920, reviewer: 'gpt-5.6-luna' }] },
      drainLedger: { [RK.drain(920, null)]: { at: OLD_AT, tries: 1 } },
    }));
    const rd = r.actions.filter((a) => a.kind === 'retry-drain');
    assert.equal(rd.length, 1, JSON.stringify(r.actions));
    assert.equal(rd[0].pr, 920);
    assert.equal(rd[0].tries, 2);
    assert.equal(r.actions.filter((a) => a.kind === 'attach-reviewer').length, 0);
  });

  it('宽限期内不重试 drain', async () => {
    const { decide } = await CORE;
    const r = decide(sit({
      reviewPending: { scanned: true, items: [{ pr: 920, reviewer: 'gpt-5.6-luna' }] },
      drainLedger: { [RK.drain(920, null)]: { at: FRESH_AT, tries: 1 } },
    }));
    assert.equal(r.actions.filter((a) => a.kind === 'retry-drain').length, 0);
    assert.equal(r.actions.filter((a) => a.kind === 'attach-reviewer').length, 0);
  });

  it('drain 试满 → mark-exhausted（#1000 认输是 PR 属性，不再开单）', async () => {
    const { decide } = await CORE;
    const { MAX_DRAIN_TRIES } = await VERBS;
    const r = decide(sit({
      github: { scanned: true, issues: [], prs: [openPr(920)] },
      reviewPending: { scanned: true, items: [{ pr: 920, reviewer: 'gpt-5.6-luna' }] },
      drainLedger: { [RK.drain(920, null)]: { at: OLD_AT, tries: MAX_DRAIN_TRIES } },
    }));
    const marked = r.actions.filter((a) => a.kind === 'mark-exhausted');
    assert.equal(marked.length, 1, JSON.stringify(r.actions));
    assert.equal(marked[0].verb, 'drain');
    assert.equal(r.actions.filter((a) => a.kind === 'open-issue').length, 0);
  });

  it('票头过期 → 不认输、不 attach 旧票，按当前 head 重新叫审官（#1208 实咬）', async () => {
    const { decide } = await CORE;
    const { MAX_DRAIN_TRIES } = await VERBS;
    const HEAD = 'newhead0000000000000000000000000000000000';
    const r = decide(sit({
      github: {
        scanned: true, issues: [],
        attributedIssues: [{ number: 1174, labels: [{ name: 'model/grok-4.6' }, { name: 'reviewer/gpt-5.6-luna' }, { name: '已消歧' }] }],
        // #1116：叫审官的选型只读 PR 自己的 label，所以这两个标必须打在 PR 上。
        prs: [{ number: 1208, isDraft: false, mergeable: 'MERGEABLE', headRefOid: HEAD, body: '署名 issue #1174',
          labels: [{ name: 'model/grok-4.6' }, { name: 'reviewer/gpt-5.6-luna' }] }],
      },
      // 六条判定全打在旧 commit 上 → 当前 head 零判定
      prReviews: { scanned: true, byPr: { 1208: { reviews: [{ state: 'CHANGES_REQUESTED', commit_id: 'oldhead', body: '红' }] } } },
      reviewPending: { scanned: true, items: [{ pr: 1208, head: { name: null, oid: 'oldhead' }, reviewer: 'gpt-5.6-luna' }] },
      drainLedger: { [RK.drain(1208, 'oldhead')]: { at: OLD_AT, tries: MAX_DRAIN_TRIES } },
    }));
    assert.equal(r.actions.filter((a) => a.kind === 'mark-exhausted').length, 0,
      '票过期不是「试满」——不许拿旧 head 的账认输');
    assert.equal(r.actions.filter((a) => a.kind === 'retry-drain').length, 0, '过期的票不许重试');
    const rr = r.actions.filter((a) => a.kind === 'rereview');
    assert.equal(rr.length, 1, JSON.stringify(r.actions));
    assert.equal(rr[0].head, HEAD, '复审票必须按当前 head 写');
  });

  it('票头与当前 head 一致且试满 → 照旧认输（新判据不回退老出口）', async () => {
    const { decide } = await CORE;
    const { MAX_DRAIN_TRIES } = await VERBS;
    const r = decide(sit({
      github: { scanned: true, issues: [], prs: [{ number: 920, isDraft: false, mergeable: 'MERGEABLE', headRefOid: 'head920' }] },
      reviewPending: { scanned: true, items: [{ pr: 920, head: { name: null, oid: 'head920' }, reviewer: 'gpt-5.6-luna' }] },
      drainLedger: { [RK.drain(920, 'head920')]: { at: OLD_AT, tries: MAX_DRAIN_TRIES } },
    }));
    const marked = r.actions.filter((a) => a.kind === 'mark-exhausted');
    assert.equal(marked.length, 1, JSON.stringify(r.actions));
    assert.equal(marked[0].verb, 'drain');
  });

  it('已开过的 open-issue：账本免重开，没成功发卡戳则重试卡', async () => {
    const { decide, WAKE_LIMIT } = await CORE;
    const r = decide(sit({
      stall: { scanned: true, strikes: { term_q: { strikes: 2 } } },
      wakeCounts: { 'stall:term_q': WAKE_LIMIT },
      openIssueLedger: { 'wake-exhausted+term_q': { at: OLD_AT, number: 900 } },
    }));
    const oi = r.actions.filter((a) => a.kind === 'open-issue');
    assert.equal(oi.length, 1, JSON.stringify(r.actions));
    assert.equal(oi[0].existing, true);
    assert.equal(oi[0].number, 900);
    assert.equal(oi[0].reason, 'wake-exhausted');
    assert.equal(r.actions.filter((a) => a.kind === 'escalate' && a.reason === 'wake-exhausted').length, 0);
  });

  it('已开过且发卡成功 6 小时内：不再产 open-issue', async () => {
    const { decide, WAKE_LIMIT } = await CORE;
    const r = decide(sit({
      stall: { scanned: true, strikes: { term_q: { strikes: 2 } } },
      wakeCounts: { 'stall:term_q': WAKE_LIMIT },
      openIssueLedger: { 'wake-exhausted+term_q': { at: OLD_AT, number: 900 } },
      hubSeen: { 'esc:wake-exhausted+term_q': FRESH_AT },
    }));
    assert.equal(r.actions.filter((a) => a.kind === 'open-issue').length, 0);
    assert.equal(r.actions.filter((a) => a.kind === 'escalate' && a.reason === 'wake-exhausted').length, 0);
  });

  it('交卷可合但 PR 缺 reviewer/ → add-label 打到 PR，不空转 rereview', async () => {
    const { decide } = await CORE;
    const HEAD = '749662d242db4d56f746d016b9c3dda00355774d';
    const r = decide(sit({
      github: {
        scanned: true,
        issues: [],
        attributedIssues: [{ number: 833, title: '撞限流', body: '', labels: [{ name: 'model/grok-4.6' }, { name: '已消歧' }] }],
        prs: [{ number: 945, isDraft: false, mergeable: 'MERGEABLE', headRefOid: HEAD, body: '署名 issue #833', labels: [{ name: 'model/grok-4.6' }] }],
      },
      prReviews: { scanned: true, byPr: { 945: { reviews: [] } } },
    }));
    const add = r.actions.filter((a) => a.kind === 'add-label');
    assert.equal(add.length, 1, JSON.stringify(r.actions));
    assert.equal(add[0].pr, 945);
    assert.equal(add[0].issue, undefined, '选型补标打到 PR，不打 issue');
    assert.deepEqual(add[0].labels, ['reviewer/gpt-5.6-luna']);
    assert.equal(r.actions.filter((a) => a.kind === 'rereview').length, 0, '标签没补上就叫审官是空转');
  });
});

describe('drainLedgerKey：decide 与 execute 同一门面', () => {
  it('有 head → pr:<pr>@<head>；拿不到 → 退回 pr:<pr>（尾部一律带判据版本 #1236）', async () => {
    const { drainLedgerKey, epochOf } = await VERBS;
    // 前缀部分是这套测试原本要钉的；尾部 @e<版本> 由 #1236 加上，两段分开断言，
    // 这样「前缀形态坏了」和「版本没带上」失败时看得出是哪一半（不写成一条复合断言）。
    const e = '@e' + epochOf().epoch;
    assert.equal(drainLedgerKey(909, 'abc'), 'pr:909@abc' + e);
    assert.equal(drainLedgerKey('909', '  abc  '), 'pr:909@abc' + e, '两头空白要 trim');
    assert.equal(drainLedgerKey(909, null), 'pr:909' + e);
    assert.equal(drainLedgerKey(909, ''), 'pr:909' + e, '空串 = 没拿到 head');
    assert.equal(drainLedgerKey(909, '   '), 'pr:909' + e, '纯空白 = 没拿到 head');
  });
});

describe('#1125 审官红 1：满载持票不记 tries，宽限期后不绕闸', () => {
  const heldPayload = { ok: true, drained: 0, failed: 0, held: 2 };

  it('满载拉 0 → applyDrainLedger 不写账', async () => {
    const { applyDrainLedger } = await VERBS;
    const r = applyDrainLedger({
      ledger: {}, pr: 920, head: null, payload: heldPayload, nowIso: OLD_AT,
    });
    assert.equal(r.wrote, false);
    assert.equal(r.verdict.countTry, false);
    assert.deepEqual(r.ledger, {});
  });

  it('没查成拉 0 → 也不写账', async () => {
    const { applyDrainLedger } = await VERBS;
    const r = applyDrainLedger({
      ledger: {}, pr: 920, head: null,
      payload: { ok: true, drained: 0, held: 2, unscanned: true },
      nowIso: OLD_AT,
    });
    assert.equal(r.wrote, false);
  });

  it('真拉走才记 tries', async () => {
    const { applyDrainLedger } = await VERBS;
    const r = applyDrainLedger({
      ledger: {}, pr: 920, head: 'h920',
      payload: { ok: true, drained: 1, failed: 0, held: 1 },
      nowIso: OLD_AT,
    });
    assert.equal(r.wrote, true);
    // #1236：键尾带判据版本，与 RK.drain 比而不是与字面量比
    assert.equal(r.key, RK.drain(920, 'h920'), '形态仍是 pr:<pr>@<head>，只是多了版本尾巴');
    assert.equal(r.ledger[RK.drain(920, 'h920')].tries, 1);
  });

  it('满载不记账 → 宽限期后仍走 attach-reviewer，不产 retry-drain --pr', async () => {
    const { applyDrainLedger } = await VERBS;
    const { decide } = await CORE;
    const applied = applyDrainLedger({
      ledger: {}, pr: 920, head: null, payload: heldPayload, nowIso: OLD_AT,
    });
    assert.equal(applied.wrote, false);
    const r = decide({
      github: { scanned: true, issues: [], prs: [{ number: 920, isDraft: false, mergeable: 'MERGEABLE', headRefOid: 'head920' }] },
      orca: { scanned: true, worktrees: [] },
      trees: { scanned: true, worktrees: [] },
      reviewPending: { scanned: true, items: [{ pr: 920, reviewer: 'gpt-5.6-luna' }] },
      prReviews: { scanned: true, byPr: {} },
      stall: { scanned: true, strikes: {} },
      wakeCounts: {},
      reworkDispatched: {},
      drainLedger: applied.ledger,
      commanderPolicy: { requireModelInRouting: false },
      routingModels: MODELS.filter((m) => !m.reviewerDisabled).map((m) => m.id),
      routingModelRecords: MODELS,
      reviewerOrder: ['gpt-5.6-luna', 'gpt-5.6-sol', 'kimi-k3'],
      workerOrder: ['grok-4.6', 'deepseek-v4-flash'],
      healthRedModels: [],
      at: '2026-09-05T12:00:00.000Z',
    });
    assert.equal(r.actions.filter((a) => a.kind === 'retry-drain').length, 0, '没账就不能走 retry-drain');
    assert.equal(r.actions.filter((a) => a.kind === 'attach-reviewer').length, 1, '下一轮仍走不带 --pr 的 attach-reviewer');
  });

  it('摘掉 held-not-try → 满载被记成试过，宽限期后产 retry-drain --pr（不带 --force）', async () => {
    const { applyDrainLedger, planRetryDrainCmd } = await VERBS;
    const { decide } = await CORE;
    const applied = applyDrainLedger({
      ledger: {}, pr: 920, head: null, payload: heldPayload, nowIso: OLD_AT,
      _checks: { 'held-not-try': false, 'unscanned-not-try': true },
    });
    assert.equal(applied.wrote, true, '闸摘掉就必须记 tries——否则宽限期后绕闸那条没有判别力');
    assert.equal(applied.ledger[RK.drain(920, null)].tries, 1);
    const r = decide({
      github: { scanned: true, issues: [], prs: [{ number: 920, isDraft: false, mergeable: 'MERGEABLE', headRefOid: 'head920' }] },
      orca: { scanned: true, worktrees: [] },
      trees: { scanned: true, worktrees: [] },
      reviewPending: { scanned: true, items: [{ pr: 920, reviewer: 'gpt-5.6-luna' }] },
      prReviews: { scanned: true, byPr: {} },
      stall: { scanned: true, strikes: {} },
      wakeCounts: {},
      reworkDispatched: {},
      drainLedger: applied.ledger,
      commanderPolicy: { requireModelInRouting: false },
      routingModels: MODELS.filter((m) => !m.reviewerDisabled).map((m) => m.id),
      routingModelRecords: MODELS,
      reviewerOrder: ['gpt-5.6-luna', 'gpt-5.6-sol', 'kimi-k3'],
      workerOrder: ['grok-4.6', 'deepseek-v4-flash'],
      healthRedModels: [],
      at: '2026-09-05T12:00:00.000Z',
    });
    const rd = r.actions.filter((a) => a.kind === 'retry-drain');
    assert.equal(rd.length, 1, '闸摘掉后宽限期就走 retry-drain');
    const planned = planRetryDrainCmd(rd[0], {
      queue: [{ pr: '920' }], ledger: applied.ledger, nowMs: PAST,
    });
    assert.equal(planned.ok, true);
    assert.ok(planned.argv.includes('--pr'), '毒票隔离仍带 --pr');
    assert.ok(!planned.argv.includes('--force'), '自动化不许 --force 绕上限');
  });

  it('drainLedger 连着 2 轮同一闸拒 → decide 产 mark-exhausted，不产 retry-drain', async () => {
    const { decide } = await CORE;
    const GATE = 'reviewer-attach 失败：审官位只许同厂换顺位（当前 gpt-5.6-luna／gpt），'
      + '不许换厂到 grok-4.6／grok——换厂只在上一位死于满载/看门狗时成立：没交换厂凭证';
    const r = decide({
      github: { scanned: true, issues: [], prs: [{ number: 920, isDraft: false, mergeable: 'MERGEABLE', headRefOid: 'head920' }] },
      orca: { scanned: true, worktrees: [] },
      trees: { scanned: true, worktrees: [] },
      reviewPending: { scanned: true, items: [{ pr: 920, reviewer: 'gpt-5.6-luna' }] },
      prReviews: { scanned: true, byPr: {} },
      stall: { scanned: true, strikes: {} },
      wakeCounts: {},
      reworkDispatched: {},
      drainLedger: {
        [RK.drain(920, null)]: { at: OLD_AT, pr: 920, tries: 2, lastError: GATE, sameErrorRounds: 2 },
      },
      commanderPolicy: { requireModelInRouting: false },
      routingModels: MODELS.filter((m) => !m.reviewerDisabled).map((m) => m.id),
      routingModelRecords: MODELS,
      reviewerOrder: ['gpt-5.6-luna', 'gpt-5.6-sol', 'kimi-k3'],
      workerOrder: ['grok-4.6', 'deepseek-v4-flash'],
      healthRedModels: [],
      at: '2026-09-05T12:00:00.000Z',
    });
    assert.equal(r.actions.filter((a) => a.kind === 'retry-drain').length, 0, '同错两轮不再白试');
    const marks = r.actions.filter((a) => a.kind === 'mark-exhausted');
    assert.equal(marks.length, 1, '接到队列主路径后必须提前交人');
    assert.ok(String(marks[0].why).includes('一模一样') || String(marks[0].why).includes('换厂凭证'), marks[0].why);
  });
});

describe('执行层真接了三个动词（不是只测纯函数）', () => {
  it('commander.mjs 的 switch 有三个 case，且动手前走 plan*Cmd', () => {
    const src = fs.readFileSync(path.join(REPO, 'scripts', 'commander.mjs'), 'utf8');
    for (const k of ["case 'add-label':", "case 'retry-drain':", "case 'open-issue':", "case 'mark-exhausted':"]) {
      assert.ok(src.includes(k), `executor 缺 ${k}`);
    }
    for (const fn of ['planAddLabelCmd', 'planRetryDrainCmd', 'planOpenIssueCmd']) {
      assert.ok(src.includes(fn), `executor 缺 ${fn}（校验层没接到手上）`);
    }
    assert.ok(/issue-gateway\.mjs/.test(src), 'Issue 写动作要走 issue-gateway（#792）');
    assert.ok(/marshal/.test(src), 'PR 合并等仍走 marshal 身份');
  });

  it('drainErrorText 不截行不截字；applyDrainLedger 走它，不再自截', () => {
    const src = fs.readFileSync(path.join(REPO, 'scripts', 'lib', 'commander-verbs.mjs'), 'utf8');
    const i = src.indexOf('export function drainErrorText');
    assert.ok(i > -1, '找不到 drainErrorText');
    const fnEnd = src.indexOf('export function applyDrainLedger', i);
    const fn = src.slice(i, fnEnd > i ? fnEnd : i + 600);
    assert.doesNotMatch(fn, /slice\s*\(/, '抽取函数自己不许截字');
    assert.doesNotMatch(fn, /split\s*\(/, '抽取函数自己不许截行');
    const apply = src.slice(fnEnd, src.indexOf('export function validateOpenIssue', fnEnd));
    assert.match(apply, /drainErrorText\(/, 'applyDrainLedger 必须走共用抽取');
    assert.doesNotMatch(apply, /drainErrorExcerpt/, '旧截断函数不许还在写侧');
  });

  it('attach-reviewer 记账走 applyDrainLedger，满载不记 tries；自动化不许 --force', () => {
    const src = fs.readFileSync(path.join(REPO, 'scripts', 'commander.mjs'), 'utf8');
    const i = src.indexOf("case 'attach-reviewer':");
    assert.ok(i > -1, '找不到 attach-reviewer case');
    const body = src.slice(i, src.indexOf("case 'merge':", i));
    assert.match(body, /recordDrainAttempt\(/, '写侧必须走 recordDrainAttempt → applyDrainLedger');
    // #1125：attach-reviewer 不带 --pr，整队按容量拉。带了就只拉代表票，补不满。
    // --pr 仍过容量闸；不过上限只认 --force，指挥官不许带。
    assert.ok(!/'--pr'/.test(body), 'attach-reviewer 不带 --pr：整队按容量拉');
    assert.ok(!/'--force'/.test(body), '指挥官 attach-reviewer 不许 --force 绕上限');
    assert.ok(!/`pr:\$\{action\.pr\}`/.test(body), '禁止手写旧键 pr:<N>——那是 #909 漏接的那一处');
    const recI = src.indexOf('function recordDrainAttempt');
    assert.ok(recI > -1, '找不到 recordDrainAttempt');
    const rec = src.slice(recI, recI + 800);
    assert.match(rec, /applyDrainLedger\(/, '记账必须走 applyDrainLedger，满载才不会记 tries');
    assert.match(rec, /ticketHeadOid\(/, 'head 两种形态必须过同一门面');
    const memI = src.indexOf('function rememberDrainFailure');
    assert.ok(memI > -1, '找不到 rememberDrainFailure');
    const memEnd = src.indexOf('export function drainPayloadOf', memI);
    const mem = src.slice(memI, memEnd > memI ? memEnd : memI + 800);
    assert.match(mem, /drainErrorText\(/, '复审账与 drain 账必须用同一份原文抽取，不许各截各的');
    const drainI = src.indexOf('function drainReviewPending');
    assert.ok(drainI > -1, '找不到 drainReviewPending');
    const drainEnd = src.indexOf('function drainPayloadOf', drainI);
    const drain = src.slice(drainI, drainEnd > drainI ? drainEnd : drainI + 800);
    assert.match(drain, /recordDrainAttempt\(/, 'rereview/retry 写侧必须走同一记账门面');
    assert.match(drain, /'--pr'/, 'rereview/retry 的 drain 必须带本张 PR，毒票不许拖死队列里别的 PR');
    assert.ok(!/'--force'/.test(drain), '自动化 drain 不许 --force');
    assert.ok(!/`pr:\$\{action\.pr\}`/.test(drain), '禁止手写旧键 pr:<N>——那是 #909 漏接的那一处');
    const daoSrc = fs.readFileSync(path.join(REPO, 'scripts', 'dao.mjs'), 'utf8');
    const drainCmdStart = daoSrc.indexOf('async function cmdReviewPendingDrain');
    const drainCmdEnd = daoSrc.indexOf('function cmdSend', drainCmdStart);
    const drainCmd = daoSrc.slice(drainCmdStart, drainCmdEnd > drainCmdStart ? drainCmdEnd : drainCmdStart + 4000);
    assert.match(drainCmd, /args\.force/, '不过上限只认 --force');
    assert.doesNotMatch(drainCmd, /args\.pr\s*\n\s*\? \{ ok: true/, '--pr 不许再当逃生口绕上限');
    assert.match(drainCmd, /attachReceiptFromSpawn/, '无 JSON/超时必须走共用回执，不许内联截断');
    assert.doesNotMatch(drainCmd, /slice\s*\(\s*0\s*,\s*400\s*\)/, 'attach fallback 不许截 400 字当比较键');
    const rpSrc = fs.readFileSync(path.join(REPO, 'scripts', 'lib', 'dispatch', 'review-pending.mjs'), 'utf8');
    const attachI = rpSrc.indexOf('export function attachReceiptFromSpawn');
    assert.ok(attachI > -1, '找不到 attachReceiptFromSpawn');
    const attachFn = rpSrc.slice(attachI, rpSrc.indexOf('export function consumeReviewPending', attachI));
    assert.doesNotMatch(attachFn, /slice\s*\(/, '回执函数自己不许截字');
    const drainAggI = rpSrc.indexOf('export function drainReviewPending');
    assert.ok(drainAggI > -1, '找不到 drainReviewPending 聚合');
    const drainAgg = rpSrc.slice(drainAggI);
    assert.doesNotMatch(drainAgg, /\.trim\s*\(/, '顶层 error 是比较键，不许 trim 首尾空白');
    const cmdSrc = fs.readFileSync(path.join(REPO, 'scripts', 'commander.mjs'), 'utf8');
    const payloadI = cmdSrc.indexOf('export function drainPayloadOf');
    const payloadFn = cmdSrc.slice(payloadI, payloadI + 700);
    assert.match(payloadFn, /runResult\.stderr \|\| runResult\.out/, '无 JSON 时比较键走完整 stderr/out');
    assert.doesNotMatch(payloadFn, /runResult\.error/, 'runCmd.error 是人读摘要，不许当比较键');
  });

  it('decide 产出白名单外 kind 仍抛（FORBIDDEN 样本）', async () => {
    const { FORBIDDEN_AUTO_KINDS } = await CORE;
    assert.ok(FORBIDDEN_AUTO_KINDS.has('worktree-rm'));
  });
});

