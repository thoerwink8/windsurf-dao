// 审官流的 mirasim 路径（#880 卡 C）：executor 绑定 + 审官会话起法 + 判定汇总。
//
// 三个判别用例是本套的存在理由：
//   ① 读回 HEAD 与 PR head 对不上 → **拒起会话**（且证明 startSession 一次都没调）——审空气的根治；
//   ② 判定行解析——GitHub review 状态为主判据、会话正文为次级，都没有则「没查成」；
//   ③ 工人审官同厂 → 拒（跨厂闸照旧，不静默换厂）。
// 连线层用假 runtime / 假 gh 注入，不碰真服务：测的是判据，不是那台机器今天在不在。

const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const EB = 'file://' + path.resolve(__dirname, '..', 'scripts', 'lib', 'executor-binding.mjs').replace(/\\/g, '/');
const RM = 'file://' + path.resolve(__dirname, '..', 'scripts', 'lib', 'dispatch', 'reviewer-mirasim.mjs').replace(/\\/g, '/');

const MODELS = [
  { id: 'gpt-5.6-luna', provider: 'gw' },
  { id: 'gpt-5.6-sol', provider: 'gpt' },
  { id: 'claude-opus', provider: 'gw' },
];

const MIRASIM_POLICY = {
  钉版本: '0.0.282',
  模型前缀族: { 'gpt-5.6': 'gpt', gpt: 'gpt', claude: 'claude', pi: 'pi' },
  agentRoutes: {
    gpt: { agent: 'codex', mode: 'relay' },
    claude: { agent: 'claude', mode: 'relay' },
    pi: { agent: 'pi', mode: 'direct' },
  },
};

const ROUTING = { models: MODELS, raw: { 执行体: { 默认: 'orca', mirasim: MIRASIM_POLICY } } };

const HEAD = 'a'.repeat(40);

// 假 gh：pr view 回 PR head；pr view reviews 回给定 reviews。
function fakeGh({ headRefName = 'feat/x', headRefOid = HEAD, mergeable = 'MERGEABLE', reviews = [] } = {}) {
  return (argv) => {
    const a = argv.join(' ');
    if (a.includes('pr view') && a.includes('headRefName')) {
      return { ok: true, out: JSON.stringify({ headRefName, headRefOid, mergeable }) };
    }
    if (a.includes('pr view') && a.includes('reviews')) {
      return { ok: true, out: JSON.stringify({ reviews }) };
    }
    return { ok: true, out: '{}' };
  };
}

// 假 runtime：记下 startSession 调了几次，返回一个 sessionKey。
function fakeRuntime({ treePath = '/mira/tree', head = HEAD, sessionKey = 'codex:11111111-2222-3333-4444-555555555555' } = {}) {
  const calls = { ensure: [], start: [], readSession: [], interact: [] };
  return {
    calls,
    async ensureWorkspace(repo, branch) { calls.ensure.push({ repo, branch }); return { path: treePath }; },
    async startSession(a) { calls.start.push(a); return { sessionKey, taskId: 'task-1', startedAt: 1 }; },
    async readSession(k) { calls.readSession.push(k); return { missing: true, why: 'test' }; },
    async interact(k, ans) { calls.interact.push({ k, ans }); return { ok: true, promptId: 'p1' }; },
    _head: head,
  };
}

const memRegistry = () => {
  const store = new Map();
  return {
    store,
    read(pr) { return store.has(String(pr)) ? { ok: true, record: store.get(String(pr)) } : { ok: false, missing: true, why: 'none' }; },
    write(pr, rec) { store.set(String(pr), rec); return { ok: true }; },
  };
};

describe('executor-binding', () => {
  it('readExecutorPolicy 读到 mirasim 节；缺节回退默认 orca', async () => {
    const { readExecutorPolicy } = await import(EB);
    const p = readExecutorPolicy(ROUTING);
    assert.equal(p.default, 'orca');
    assert.ok(p.mirasim && p.mirasim.agentRoutes);
    const none = readExecutorPolicy({ raw: {} });
    assert.equal(none.default, 'orca');
    assert.equal(none.mirasim, null);
    assert.equal(none.scanned, false);
  });

  it('judgeExecutorName：空用默认；不认识拒；mirasim 未登记拒', async () => {
    const { judgeExecutorName, readExecutorPolicy } = await import(EB);
    const p = readExecutorPolicy(ROUTING);
    assert.equal(judgeExecutorName('', p).name, 'orca');
    assert.equal(judgeExecutorName('mirasim', p).ok, true);
    assert.equal(judgeExecutorName('nope', p).ok, false);
    assert.equal(judgeExecutorName('mirasim', readExecutorPolicy({ raw: {} })).ok, false);
  });

  it('judgeAgentRoute：gpt-5.6-luna → codex relay；未登记家族拒派不猜', async () => {
    const { judgeAgentRoute } = await import(EB);
    const r = judgeAgentRoute('gpt-5.6-luna', MIRASIM_POLICY);
    assert.equal(r.ok, true);
    assert.equal(r.agent, 'codex');
    assert.equal(r.mode, 'relay');
    assert.equal(judgeAgentRoute('pi-2', MIRASIM_POLICY).agent, 'pi');
    const bad = judgeAgentRoute('kimi-k3', MIRASIM_POLICY);
    assert.equal(bad.ok, false); // kimi 家族没登记 → 拒派
  });
});

describe('reviewer-mirasim 判官', () => {
  it('judgeReviewerHead：HEAD 对齐过；不符拒；读不回报没查成', async () => {
    const { judgeReviewerHead } = await import(RM);
    assert.equal(judgeReviewerHead({ treeHead: HEAD, expectedOid: HEAD }).ok, true);
    assert.equal(judgeReviewerHead({ treeHead: 'b'.repeat(40), expectedOid: HEAD }).ok, false);
    assert.equal(judgeReviewerHead({ treeHead: '', expectedOid: HEAD }).ok, false);
    assert.equal(judgeReviewerHead({ treeHead: HEAD, expectedOid: '' }).ok, false);
    // 短 sha 是全 sha 前缀 → 认
    assert.equal(judgeReviewerHead({ treeHead: HEAD, expectedOid: HEAD.slice(0, 12) }).ok, true);
  });

  it('parseSessionVerdict：认 review 状态词与中文判词，末位为准', async () => {
    const { parseSessionVerdict } = await import(RM);
    assert.equal(parseSessionVerdict('已 --request-changes 发出').verdict, 'red');
    assert.equal(parseSessionVerdict('review APPROVED').verdict, 'green');
    assert.equal(parseSessionVerdict('判绿').verdict, 'green');
    assert.equal(parseSessionVerdict('判红 3 项').verdict, 'red');
    assert.equal(parseSessionVerdict('无关正文').found, false);
    // 命令回显在前、结果在后：末位 CHANGES_REQUESTED 为准
    assert.equal(parseSessionVerdict('运行 --approve? 否，最终 CHANGES_REQUESTED').verdict, 'red');
  });

  it('readReviewVerdict：GitHub 状态为主，正文为次，都没有=没查成', async () => {
    const { readReviewVerdict } = await import(RM);
    const green = readReviewVerdict({ reviews: [{ state: 'APPROVED' }], sessionText: '' });
    assert.equal(green.verdict, 'green');
    assert.equal(green.via, 'github');
    const red = readReviewVerdict({ reviews: [{ state: 'CHANGES_REQUESTED' }], sessionText: '판' });
    assert.equal(red.verdict, 'red');
    // 只有正文有判词 → 次级证据 partial
    const say = readReviewVerdict({ reviews: [], sessionText: '判绿' });
    assert.equal(say.verdict, 'green');
    assert.equal(say.partial, true);
    // 都没有 → 没查成
    const none = readReviewVerdict({ reviews: [], sessionText: '干活中' });
    assert.equal(none.ok, false);
    assert.equal(none.verdict, null);
  });
});

describe('mirasimReviewerCreate 编排', () => {
  it('① HEAD 不符 → 拒起会话，且 startSession 一帧都没发', async () => {
    const { mirasimReviewerCreate } = await import(RM);
    const rt = fakeRuntime({ head: 'c'.repeat(40) }); // 树 HEAD 与 PR head 不符
    const res = await mirasimReviewerCreate({
      runtime: rt, gh: fakeGh(), readTreeHead: async () => rt._head,
      pr: '883', repo: '/repo', reviewerModel: 'gpt-5.6-luna', workerModel: 'claude-opus',
      models: MODELS, mirasimPolicy: MIRASIM_POLICY, prompt: '审',
    });
    assert.equal(res.ok, false);
    assert.equal(res.stage, 'head');
    assert.equal(rt.calls.start.length, 0, '拒起会话时不许调 startSession');
  });

  it('HEAD 对齐 → 起会话（agent=codex），返回 sessionKey', async () => {
    const { mirasimReviewerCreate } = await import(RM);
    const rt = fakeRuntime();
    const res = await mirasimReviewerCreate({
      runtime: rt, gh: fakeGh(), readTreeHead: async () => rt._head,
      pr: '883', repo: '/repo', reviewerModel: 'gpt-5.6-luna', workerModel: 'claude-opus',
      models: MODELS, mirasimPolicy: MIRASIM_POLICY, prompt: '审官任务书',
    });
    assert.equal(res.ok, true);
    assert.equal(res.agent, 'codex');
    assert.ok(res.sessionKey);
    assert.equal(rt.calls.start.length, 1);
    assert.equal(rt.calls.start[0].agent, 'codex');
    assert.equal(rt.calls.start[0].workdir, '/mira/tree');
  });

  it('③ 工人审官同厂 → 拒（跨厂闸），不起会话', async () => {
    const { mirasimReviewerCreate } = await import(RM);
    const rt = fakeRuntime();
    const res = await mirasimReviewerCreate({
      runtime: rt, gh: fakeGh(), readTreeHead: async () => rt._head,
      pr: '883', repo: '/repo', reviewerModel: 'gpt-5.6-luna', workerModel: 'gpt-5.6-sol', // 都 gpt 家族
      models: MODELS, mirasimPolicy: MIRASIM_POLICY, prompt: '审',
    });
    assert.equal(res.ok, false);
    assert.equal(res.stage, 'vendor');
    assert.equal(rt.calls.start.length, 0);
    assert.equal(rt.calls.ensure.length, 0, '同厂拒在建树之前');
  });

  it('未登记家族的审官 → 路由拒派，不起会话', async () => {
    const { mirasimReviewerCreate } = await import(RM);
    const rt = fakeRuntime();
    const res = await mirasimReviewerCreate({
      runtime: rt, gh: fakeGh(), readTreeHead: async () => rt._head,
      pr: '883', repo: '/repo', reviewerModel: 'kimi-k3', workerModel: 'claude-opus',
      models: [...MODELS, { id: 'kimi-k3', provider: 'gw' }], mirasimPolicy: MIRASIM_POLICY, prompt: '审',
    });
    assert.equal(res.ok, false);
    assert.equal(res.stage, 'route');
    assert.equal(rt.calls.start.length, 0);
  });
});

describe('mirasimWorkerDone 编排', () => {
  it('首审轮：起审官会话并登记 PR→会话', async () => {
    const { mirasimWorkerDone } = await import(RM);
    const rt = fakeRuntime();
    const reg = memRegistry();
    const res = await mirasimWorkerDone({
      runtime: rt, gh: fakeGh({ reviews: [] }), readTreeHead: async () => rt._head, registry: reg,
      pr: '883', repo: '/repo', prompt: '审', reworkPrompt: '复审',
      reviewerModel: 'gpt-5.6-luna', workerModel: 'claude-opus',
      models: MODELS, mirasimPolicy: MIRASIM_POLICY, round: 'first',
    });
    assert.equal(res.ok, true);
    assert.equal(res.action, 'created');
    assert.ok(reg.store.get('883').sessionKey);
    assert.equal(rt.calls.start.length, 1);
  });

  it('返工轮 + 会话有等答问题 → interact（不新起会话）', async () => {
    const { mirasimWorkerDone } = await import(RM);
    const rt = fakeRuntime();
    // 让 readSession 回一个带 pending interaction 的 snapshot
    rt.readSession = async () => ({
      via: 'snapshot',
      snapshot: { interactions: [{ promptId: 'p1', questions: [{ id: 'q1' }] }] },
    });
    const reg = memRegistry();
    reg.write('883', { pr: '883', sessionKey: 'codex:aaaa1111-2222-3333-4444-555555555555' });
    const res = await mirasimWorkerDone({
      runtime: rt, gh: fakeGh({ reviews: [{ state: 'CHANGES_REQUESTED' }] }), readTreeHead: async () => rt._head, registry: reg,
      pr: '883', repo: '/repo', prompt: '审', reworkPrompt: '复审', reworkAnswer: '返工完成',
      reviewerModel: 'gpt-5.6-luna', workerModel: 'claude-opus',
      models: MODELS, mirasimPolicy: MIRASIM_POLICY, round: 'rework',
    });
    assert.equal(res.ok, true);
    assert.equal(res.action, 'reworked-interact');
    assert.equal(rt.calls.interact.length, 1);
    assert.equal(rt.calls.start.length, 0, 'interact 成功就不新起会话');
  });

  it('返工轮 + 无等答问题 → 新起一针', async () => {
    const { mirasimWorkerDone } = await import(RM);
    const rt = fakeRuntime();
    rt.readSession = async () => ({ via: 'snapshot', snapshot: { interactions: [] } });
    const reg = memRegistry();
    reg.write('883', { pr: '883', sessionKey: 'codex:aaaa1111-2222-3333-4444-555555555555' });
    const res = await mirasimWorkerDone({
      runtime: rt, gh: fakeGh({ reviews: [{ state: 'CHANGES_REQUESTED' }] }), readTreeHead: async () => rt._head, registry: reg,
      pr: '883', repo: '/repo', prompt: '审', reworkPrompt: '复审',
      reviewerModel: 'gpt-5.6-luna', workerModel: 'claude-opus',
      models: MODELS, mirasimPolicy: MIRASIM_POLICY, round: 'rework',
    });
    assert.equal(res.ok, true);
    assert.equal(res.action, 'reworked-new');
    assert.equal(rt.calls.start.length, 1);
  });
});
