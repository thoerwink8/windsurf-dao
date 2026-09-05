// #971 服务器帅位三动词：纯函数校验 + 反证 + 变异。
// 每条校验必须两头都有判别力：合法放行、违规被拒。
// 变异：把该校验摘掉，同一份违规样本必须被放行——证明这条是承重的，不是旁路。
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const VERBS = import('file://' + path.join(REPO, 'scripts', 'lib', 'commander-verbs.mjs').replace(/\\/g, '/'));
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
    for (const k of ['add-label', 'retry-drain', 'open-issue']) {
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
    assert.deepEqual(r.argv, [
      'node', 'scripts/gh-as.mjs', 'marshal', '--',
      'issue', 'edit', '971', '--add-label', 'reviewer/gpt-5.6-luna',
    ]);
  });
});

describe('retry-drain 校验：只对队列里的票，派了 ≠ 成了', () => {
  const queued = [{ pr: '905' }];
  const ledgerOk = { 'pr:905': { at: OLD_AT, tries: 1 } };

  it('合法：票在队列 + 有上次账 + 过了宽限 + 未试满 → 放行，tries 累加', async () => {
    const { validateRetryDrain } = await VERBS;
    const r = validateRetryDrain({ pr: 905, queue: queued, ledger: ledgerOk, nowMs: PAST });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.tries, 2);
    assert.equal(r.stateKey, 'pr:905');
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
      ledger: { 'pr:905': { at: FRESH_AT, tries: 1 } },
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'grace');
  });

  it('违规：试满 escalate，账本有 ok:true 也不能当成功（票还在队列=没成）', async () => {
    const { validateRetryDrain, MAX_DRAIN_TRIES } = await VERBS;
    const r = validateRetryDrain({
      pr: 905, queue: queued, nowMs: PAST,
      ledger: { 'pr:905': { at: OLD_AT, tries: MAX_DRAIN_TRIES, ok: true } },
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'exhausted');
    assert.equal(r.escalate, true);
  });

  it('planRetryDrainCmd：argv 是 drain --pr，不是造新票', async () => {
    const { planRetryDrainCmd } = await VERBS;
    const r = planRetryDrainCmd({ pr: 905 }, { queue: queued, ledger: ledgerOk, nowMs: PAST });
    assert.equal(r.ok, true);
    assert.deepEqual(r.argv, ['node', 'scripts/dao.mjs', 'review-pending-drain', '--pr', '905']);
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

  it('planOpenIssueCmd：gh-as marshal + --body-file，不许 --body', async () => {
    const { planOpenIssueCmd } = await VERBS;
    const r = planOpenIssueCmd(base, { repo: 'thoerwink8/windsurf-dao', bodyPath: '/tmp/x.md' });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.ok(r.argv.includes('marshal'));
    assert.ok(r.argv.includes('--body-file'));
    assert.ok(!r.argv.includes('--body'));
    assert.ok(r.argv.includes('待拍板'));
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
          ledger: { 'pr:': { at: OLD_AT, tries: 1 } },
          nowMs: PAST,
        }),
      },
      {
        id: 'retry-drain.queue',
        run: (checks) => V.validateRetryDrain({
          _checks: checks,
          pr: 905,
          queue: [{ pr: '1' }],
          ledger: { 'pr:905': { at: OLD_AT, tries: 1 } },
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
        id: 'retry-drain.max-tries',
        run: (checks) => V.validateRetryDrain({
          _checks: checks,
          pr: 905,
          queue: [{ pr: '905' }],
          ledger: { 'pr:905': { at: OLD_AT, tries: V.MAX_DRAIN_TRIES } },
          nowMs: PAST,
        }),
      },
      {
        id: 'retry-drain.grace',
        run: (checks) => V.validateRetryDrain({
          _checks: checks,
          pr: 905,
          queue: [{ pr: '905' }],
          ledger: { 'pr:905': { at: FRESH_AT, tries: 1 } },
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
      orca: { scanned: true, worktrees: [] },
      reviewPending: { scanned: true, items: [] },
      prReviews: { scanned: true, byPr: {} },
      stall: { scanned: true, strikes: {} },
      wakeCounts: {},
      reworkDispatched: {},
      commanderPolicy: { maxDispatchPerRound: 20, requireModelInRouting: false },
      routingModels: MODELS.filter((m) => !m.reviewerDisabled).map((m) => m.id),
      routingModelRecords: MODELS,
      reviewerOrder: ['gpt-5.6-luna', 'gpt-5.6-sol', 'kimi-k3'],
      workerOrder: ['grok-4.6', 'deepseek-v4-flash'],
      healthRedModels: [],
      at: '2026-09-05T12:00:00.000Z',
      ...over,
    };
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
      reviewPending: { scanned: true, items: [{ pr: 920, reviewer: 'gpt-5.6-luna' }] },
      drainLedger: { 'pr:920': { at: OLD_AT, tries: 1 } },
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
      drainLedger: { 'pr:920': { at: FRESH_AT, tries: 1 } },
    }));
    assert.equal(r.actions.filter((a) => a.kind === 'retry-drain').length, 0);
    assert.equal(r.actions.filter((a) => a.kind === 'attach-reviewer').length, 0);
  });

  it('drain 试满 → open-issue（drain-exhausted），不再喊给空气', async () => {
    const { decide } = await CORE;
    const { MAX_DRAIN_TRIES } = await VERBS;
    const r = decide(sit({
      reviewPending: { scanned: true, items: [{ pr: 920, reviewer: 'gpt-5.6-luna' }] },
      drainLedger: { 'pr:920': { at: OLD_AT, tries: MAX_DRAIN_TRIES } },
    }));
    const opened = r.actions.filter((a) => a.kind === 'open-issue');
    assert.equal(opened.length, 1, JSON.stringify(r.actions));
    assert.equal(opened[0].reason, 'drain-exhausted');
    assert.ok(opened[0].original);
  });

  it('已开过的 open-issue 去重：账本有键就不再产', async () => {
    const { decide, WAKE_LIMIT } = await CORE;
    const r = decide(sit({
      stall: { scanned: true, strikes: { term_q: { strikes: 2 } } },
      wakeCounts: { 'stall:term_q': WAKE_LIMIT },
      openIssueLedger: { 'wake-exhausted+term_q': { at: OLD_AT, number: 900 } },
    }));
    assert.equal(r.actions.filter((a) => a.kind === 'open-issue').length, 0);
    assert.equal(r.actions.filter((a) => a.kind === 'escalate' && a.reason === 'wake-exhausted').length, 0);
  });

  it('交卷可合但署名单缺 reviewer/ → add-label，不空转 rereview', async () => {
    const { decide } = await CORE;
    const HEAD = '749662d242db4d56f746d016b9c3dda00355774d';
    const r = decide(sit({
      github: {
        scanned: true,
        issues: [],
        attributedIssues: [{ number: 833, title: '撞限流', labels: [{ name: 'model/grok-4.6' }, { name: '已消歧' }] }],
        prs: [{ number: 945, isDraft: false, mergeable: 'MERGEABLE', headRefOid: HEAD, body: '署名 issue #833' }],
      },
      prReviews: { scanned: true, byPr: { 945: { reviews: [] } } },
    }));
    const add = r.actions.filter((a) => a.kind === 'add-label');
    assert.equal(add.length, 1, JSON.stringify(r.actions));
    assert.equal(add[0].issue, 833);
    assert.equal(add[0].pr, 945);
    assert.deepEqual(add[0].labels, ['reviewer/gpt-5.6-luna']);
    assert.equal(r.actions.filter((a) => a.kind === 'rereview').length, 0, '标签没补上就叫审官是空转');
  });
});

describe('执行层真接了三个动词（不是只测纯函数）', () => {
  it('commander.mjs 的 switch 有三个 case，且动手前走 plan*Cmd', () => {
    const src = fs.readFileSync(path.join(REPO, 'scripts', 'commander.mjs'), 'utf8');
    for (const k of ["case 'add-label':", "case 'retry-drain':", "case 'open-issue':"]) {
      assert.ok(src.includes(k), `executor 缺 ${k}`);
    }
    for (const fn of ['planAddLabelCmd', 'planRetryDrainCmd', 'planOpenIssueCmd']) {
      assert.ok(src.includes(fn), `executor 缺 ${fn}（校验层没接到手上）`);
    }
    assert.ok(/gh-as\.mjs/.test(src) && /marshal/.test(src), '写动作要走 gh-as');
  });

  it('decide 产出白名单外 kind 仍抛（FORBIDDEN 样本）', async () => {
    const { FORBIDDEN_AUTO_KINDS } = await CORE;
    assert.ok(FORBIDDEN_AUTO_KINDS.has('worktree-rm'));
  });
});

