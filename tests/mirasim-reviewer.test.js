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
    const common = {
      gh: fakeGh(), pr: '883', repo: '/repo',
      reviewerModel: 'gpt-5.6-luna', workerModel: 'claude-opus',
      models: MODELS, mirasimPolicy: MIRASIM_POLICY, prompt: '审',
    };
    // #886 后 HEAD 不符先试同步，所以「拒」分两支——两支都必须一帧不发：
    // ⓐ 推不动（没注入 syncTree / 同步失败）→ stage head-sync；
    const noSync = fakeRuntime({ head: 'c'.repeat(40) }); // 树 HEAD 与 PR head 不符
    const a = await mirasimReviewerCreate({ ...common, runtime: noSync, readTreeHead: async () => noSync._head });
    assert.equal(a.ok, false);
    assert.equal(a.stage, 'head-sync');
    assert.equal(noSync.calls.start.length, 0, '拒起会话时不许调 startSession');

    const badSync = fakeRuntime({ head: 'c'.repeat(40) });
    const b = await mirasimReviewerCreate({
      ...common, runtime: badSync, readTreeHead: async () => badSync._head,
      syncTree: async () => ({ ok: false, error: '推不动' }),
    });
    assert.equal(b.ok, false);
    assert.equal(b.stage, 'head-sync');
    assert.equal(badSync.calls.start.length, 0);

    // ⓑ 读不回树 HEAD（没查成，同步无从下手）→ stage head，仍是一帧不发。
    const blind = fakeRuntime();
    const c = await mirasimReviewerCreate({
      ...common, runtime: blind, readTreeHead: async () => '',
      syncTree: async () => ({ ok: true }),
    });
    assert.equal(c.ok, false);
    assert.equal(c.stage, 'head');
    assert.equal(blind.calls.start.length, 0);
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
    // treePath 是必需的：返工前要核审官在哪棵树、把它同步到新 head（#886 审官第 1 条）。
    reg.write('883', { pr: '883', sessionKey: 'codex:aaaa1111-2222-3333-4444-555555555555', treePath: '/mira/tree', expectedOid: HEAD });
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
    reg.write('883', { pr: '883', sessionKey: 'codex:aaaa1111-2222-3333-4444-555555555555', treePath: '/mira/tree', expectedOid: HEAD });
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

// ── #886 返工审官 5 条的判别测试 ───────────────────────────────────────────────
// 每条都对着一个已复现的洞：破了判据就翻红，不是「跑到这行了」。

const NEW = 'b'.repeat(40); // PR 返工后的新 head

/** 树 HEAD 可变的假 runtime + 可注入 syncTree（把树推到新 oid）。 */
function reworkRig({ treeHead, interactions = [], syncOk = true, syncErr = '树里有未提交改动' } = {}) {
  const calls = { ensure: [], start: [], interact: [], sync: [] };
  const box = { head: treeHead };
  const runtime = {
    calls,
    async ensureWorkspace(repo, branch) { calls.ensure.push({ repo, branch }); return { path: '/mira/tree' }; },
    async startSession(a) { calls.start.push(a); return { sessionKey: 'codex:99999999-2222-3333-4444-555555555555', taskId: 't9' }; },
    async readSession() { return { via: 'snapshot', missing: false, phase: 'running', snapshot: { interactions } }; },
    async interact(k, ans) { calls.interact.push({ k, ans }); return { ok: true, promptId: 'p1' }; },
  };
  return {
    runtime, calls, box,
    readTreeHead: async () => box.head,
    syncTree: async (p, oid) => {
      calls.sync.push({ p, oid });
      if (!syncOk) return { ok: false, error: syncErr };
      box.head = oid;
      return { ok: true, treeHead: oid };
    },
  };
}

const reworkArgs = (rig, extra = {}) => ({
  runtime: rig.runtime, readTreeHead: rig.readTreeHead, syncTree: rig.syncTree,
  repo: '/repo', reviewerModel: 'gpt-5.6-luna', workerModel: 'claude-opus',
  models: MODELS, mirasimPolicy: MIRASIM_POLICY, prompt: '审', reworkPrompt: '复审',
  reviewBranch: 'dao-review-pr-884', ...extra,
});

describe('#886 ①返工跟新 HEAD（judgeReviewTreeSync + 同步动作）', () => {
  it('judgeReviewTreeSync：对齐=noop；停旧 oid=sync；读不回/没 PR head=unscanned', async () => {
    const { judgeReviewTreeSync } = await import(RM);
    assert.equal(judgeReviewTreeSync({ treeHead: HEAD, expectedOid: HEAD }).action, 'noop');
    const s = judgeReviewTreeSync({ treeHead: HEAD, expectedOid: NEW });
    assert.equal(s.action, 'sync');
    assert.equal(s.from, HEAD);
    assert.equal(s.to, NEW);
    assert.equal(judgeReviewTreeSync({ treeHead: '', expectedOid: NEW }).action, 'unscanned');
    assert.equal(judgeReviewTreeSync({ treeHead: HEAD, expectedOid: '' }).action, 'unscanned');
  });

  it('旧 HEAD→新 HEAD：返工把树同步到新 head，interact 走既有会话，登记 expectedOid 跟着刷', async () => {
    const { mirasimWorkerDone } = await import(RM);
    const rig = reworkRig({ treeHead: HEAD, interactions: [{ promptId: 'p1' }] });
    const reg = memRegistry();
    reg.write('884', { pr: '884', sessionKey: 'codex:old11111-2222-3333-4444-555555555555', treePath: '/mira/tree', expectedOid: HEAD });
    const res = await mirasimWorkerDone({
      ...reworkArgs(rig), gh: fakeGh({ headRefOid: NEW, reviews: [{ state: 'CHANGES_REQUESTED' }] }),
      registry: reg, pr: '884', round: 'rework', reworkAnswer: '返工完成',
    });
    assert.equal(res.ok, true);
    assert.equal(res.action, 'reworked-interact');
    assert.equal(res.treeSync.done, true, '返工必须真同步过树');
    assert.equal(rig.box.head, NEW, '审官树要停在 PR 新 head');
    assert.equal(rig.calls.interact.length, 1);
    assert.equal(rig.calls.start.length, 0, '有在役会话就不再起第二个');
    // 帅位实咬：登记里的 expectedOid 原来还是首轮的值，下一轮又对不上。
    assert.equal(reg.store.get('884').expectedOid, NEW, '登记 expectedOid 必须刷到新 head');
    assert.equal(reg.store.get('884').treeHead, NEW);
  });

  it('同步失败 → fail-visible（不 interact 旧树、不新起会话、HEAD 闸不放宽）', async () => {
    const { mirasimWorkerDone } = await import(RM);
    const rig = reworkRig({ treeHead: HEAD, interactions: [{ promptId: 'p1' }], syncOk: false });
    const reg = memRegistry();
    reg.write('884', { pr: '884', sessionKey: 'codex:old11111-2222-3333-4444-555555555555', treePath: '/mira/tree', expectedOid: HEAD });
    const res = await mirasimWorkerDone({
      ...reworkArgs(rig), gh: fakeGh({ headRefOid: NEW, reviews: [{ state: 'CHANGES_REQUESTED' }] }),
      registry: reg, pr: '884', round: 'rework',
    });
    assert.equal(res.ok, false);
    assert.equal(res.stage, 'rework:tree-sync');
    assert.match(res.error, /未提交改动/);
    assert.equal(rig.calls.interact.length, 0, '同步不成不许 interact 旧树');
    assert.equal(rig.calls.start.length, 0);
    assert.equal(reg.store.get('884').expectedOid, HEAD, '同步没成就别刷登记（别谎报已跟上）');
  });

  it('同步「报成功」但树还停在旧 oid → 仍拒（闸不放宽，不打假 ✓）', async () => {
    const { mirasimWorkerDone } = await import(RM);
    const rig = reworkRig({ treeHead: HEAD, interactions: [{ promptId: 'p1' }] });
    const liar = async () => ({ ok: true }); // 只嘴上 ok，不真推树
    const reg = memRegistry();
    reg.write('884', { pr: '884', sessionKey: 'codex:old11111-2222-3333-4444-555555555555', treePath: '/mira/tree', expectedOid: HEAD });
    const res = await mirasimWorkerDone({
      ...reworkArgs(rig), syncTree: liar,
      gh: fakeGh({ headRefOid: NEW, reviews: [{ state: 'CHANGES_REQUESTED' }] }),
      registry: reg, pr: '884', round: 'rework',
    });
    assert.equal(res.ok, false);
    assert.equal(res.stage, 'rework:tree-sync');
    assert.match(res.error, /同步后仍对不上/);
    assert.equal(rig.calls.interact.length, 0);
  });

  it('登记没 treePath → 拒（核不出审官在哪棵树，不在没核过的树上复审）', async () => {
    const { mirasimWorkerDone } = await import(RM);
    const rig = reworkRig({ treeHead: HEAD, interactions: [{ promptId: 'p1' }] });
    const reg = memRegistry();
    reg.write('884', { pr: '884', sessionKey: 'codex:old11111-2222-3333-4444-555555555555' });
    const res = await mirasimWorkerDone({
      ...reworkArgs(rig), gh: fakeGh({ headRefOid: NEW, reviews: [{ state: 'CHANGES_REQUESTED' }] }),
      registry: reg, pr: '884', round: 'rework',
    });
    assert.equal(res.ok, false);
    assert.equal(res.stage, 'rework:tree');
    assert.equal(rig.calls.interact.length, 0);
  });

  it('mirasimReviewerCreate：复用的旧树停在旧 oid → 同步后才起会话；没注入 syncTree 则拒', async () => {
    const { mirasimReviewerCreate } = await import(RM);
    const ok = reworkRig({ treeHead: HEAD });
    const res = await mirasimReviewerCreate({
      ...reworkArgs(ok), gh: fakeGh({ headRefOid: NEW }), pr: '884',
    });
    assert.equal(res.ok, true);
    assert.equal(res.treeSync.done, true);
    assert.equal(res.treeHead, NEW);
    assert.equal(ok.calls.start.length, 1);

    const none = reworkRig({ treeHead: HEAD });
    const res2 = await mirasimReviewerCreate({
      ...reworkArgs(none), syncTree: undefined, gh: fakeGh({ headRefOid: NEW }), pr: '884',
    });
    assert.equal(res2.ok, false);
    assert.equal(res2.stage, 'head-sync');
    assert.equal(none.calls.start.length, 0, '推不动树就别起会话');
  });
});

describe('#886 ②一 PR 一审官（judgeReviewerSessionReuse）', () => {
  it('判据：无登记=可新建；服务端查不到/phase 已废=可新建；没查成=复用；--force=可新建', async () => {
    const { judgeReviewerSessionReuse } = await import(RM);
    const rec = { sessionKey: 'codex:aaaa1111-2222-3333-4444-555555555555' };
    assert.equal(judgeReviewerSessionReuse({ record: null, view: null }).reuse, false);
    assert.equal(judgeReviewerSessionReuse({ record: {}, view: null }).reuse, false);
    // 没查成不许当「没有会话」——那正是重复烧额度那条路
    const unscanned = judgeReviewerSessionReuse({ record: rec, view: null });
    assert.equal(unscanned.reuse, true);
    assert.equal(unscanned.checked, false);
    assert.equal(judgeReviewerSessionReuse({ record: rec, view: { missing: true, why: 'x' } }).reuse, false);
    assert.equal(judgeReviewerSessionReuse({ record: rec, view: { missing: false, phase: 'failed' } }).reuse, false);
    assert.equal(judgeReviewerSessionReuse({ record: rec, view: { missing: false, phase: 'aborted' } }).reuse, false);
    assert.equal(judgeReviewerSessionReuse({ record: rec, view: { missing: false, phase: 'running' } }).reuse, true);
    assert.equal(judgeReviewerSessionReuse({ record: rec, view: { missing: false, phase: 'done' } }).reuse, true);
    assert.equal(judgeReviewerSessionReuse({ record: rec, view: { missing: false, phase: 'running' }, force: true }).reuse, false);
  });

  it('重复首审（登记里已有在役会话）→ 复用，startSession 一次都不调', async () => {
    const { mirasimWorkerDone } = await import(RM);
    const rig = reworkRig({ treeHead: HEAD });
    const reg = memRegistry();
    reg.write('884', { pr: '884', sessionKey: 'codex:already11-2222-3333-4444-555555555555', treePath: '/mira/tree', expectedOid: HEAD });
    const res = await mirasimWorkerDone({
      ...reworkArgs(rig), gh: fakeGh({ reviews: [] }), registry: reg, pr: '884', round: 'first',
    });
    assert.equal(res.ok, true);
    assert.equal(res.action, 'reused');
    assert.equal(res.sessionKey, 'codex:already11-2222-3333-4444-555555555555');
    assert.equal(rig.calls.start.length, 0, '一 PR 一审官：不许再起第二个会话');
    assert.equal(rig.calls.ensure.length, 0, '复用连树都不用再建');
  });

  it('peekReviewerSession：抛错=没查成(view:null)，返回 missing=确认失效——两件事不许合成一种', async () => {
    const { peekReviewerSession, judgeReviewerSessionReuse } = await import(RM);
    const rec = { sessionKey: 'codex:aaaa1111-2222-3333-4444-555555555555' };

    const thrown = await peekReviewerSession({ async readSession() { throw new Error('连不上服务端'); } }, rec.sessionKey);
    assert.equal(thrown.view, null, '抛错只能是没查成，不许合成 {missing:true}');
    assert.match(thrown.why, /没查成/);
    assert.equal(judgeReviewerSessionReuse({ record: rec, view: thrown.view }).reuse, true, '没查成要复用，不许重复起会话');

    const said = await peekReviewerSession({ async readSession() { return { missing: true, why: '服务端不认识' }; } }, rec.sessionKey);
    assert.equal(said.view.missing, true);
    assert.equal(judgeReviewerSessionReuse({ record: rec, view: said.view }).reuse, false, '服务端明说不认识才算失效');

    const noVerb = await peekReviewerSession({}, rec.sessionKey);
    assert.equal(noVerb.view, null);
  });

  it('首审 + readSession 抛错（连不上）→ 仍复用，不起第二个会话', async () => {
    const { mirasimWorkerDone } = await import(RM);
    const rig = reworkRig({ treeHead: HEAD });
    rig.runtime.readSession = async () => { throw new Error('ECONNREFUSED 4316'); };
    const reg = memRegistry();
    reg.write('884', { pr: '884', sessionKey: 'codex:live1111-2222-3333-4444-555555555555', treePath: '/mira/tree', expectedOid: HEAD });
    const res = await mirasimWorkerDone({
      ...reworkArgs(rig), gh: fakeGh({ reviews: [] }), registry: reg, pr: '884', round: 'first',
    });
    assert.equal(res.ok, true);
    assert.equal(res.action, 'reused');
    assert.equal(rig.calls.start.length, 0, '服务端抽风不许变成重复烧额度');
  });

  it('首审 + 登记里的会话服务端已查不到 → 才新建（确认失效才新起）', async () => {
    const { mirasimWorkerDone } = await import(RM);
    const rig = reworkRig({ treeHead: HEAD });
    rig.runtime.readSession = async () => ({ missing: true, why: '服务端不认识这条会话' });
    const reg = memRegistry();
    reg.write('884', { pr: '884', sessionKey: 'codex:dead1111-2222-3333-4444-555555555555', treePath: '/mira/tree', expectedOid: HEAD });
    const res = await mirasimWorkerDone({
      ...reworkArgs(rig), gh: fakeGh({ reviews: [] }), registry: reg, pr: '884', round: 'first',
    });
    assert.equal(res.ok, true);
    assert.equal(res.action, 'reworked-new');
    assert.equal(rig.calls.start.length, 1);
    assert.equal(reg.store.get('884').prevSessionKey, 'codex:dead1111-2222-3333-4444-555555555555');
  });
});

describe('#886 ③登记写失败 fail-closed', () => {
  it('首审：write 回 {ok:false} → 整体 ok:false，且交出已起的 sessionKey', async () => {
    const { mirasimWorkerDone } = await import(RM);
    const rig = reworkRig({ treeHead: HEAD });
    const reg = { read() { return { ok: false, missing: true }; }, write() { return { ok: false, error: '盘满' }; } };
    const res = await mirasimWorkerDone({
      ...reworkArgs(rig), gh: fakeGh({ reviews: [] }), registry: reg, pr: '884', round: 'first',
    });
    assert.equal(res.ok, false, '没持久化就不许报 created');
    assert.equal(res.stage, 'registry');
    assert.equal(res.action, undefined);
    assert.ok(res.sessionKey, '已起的会话 key 要交出来，别丢线头');
    assert.match(res.error, /盘满/);
  });

  it('write 回 undefined / 缺 ok / ok 是字符串 → 也算失败（不许「没回 ok」当成 ok）', async () => {
    const { mirasimWorkerDone } = await import(RM);
    const shapes = [() => undefined, () => ({}), () => ({ ok: 'true' })];
    for (const w of shapes) {
      const rig = reworkRig({ treeHead: HEAD });
      const reg = { read() { return { ok: false, missing: true }; }, write: w };
      const res = await mirasimWorkerDone({
        ...reworkArgs(rig), gh: fakeGh({ reviews: [] }), registry: reg, pr: '884', round: 'first',
      });
      assert.equal(res.ok, false, `write 回 ${JSON.stringify(w())} 也该判失败`);
      assert.equal(res.stage, 'registry');
    }
  });

  it('返工刷 expectedOid 写失败 → 也 fail-closed（别当返工已交卷）', async () => {
    const { mirasimWorkerDone } = await import(RM);
    const rig = reworkRig({ treeHead: HEAD, interactions: [{ promptId: 'p1' }] });
    const reg = {
      read() { return { ok: true, record: { pr: '884', sessionKey: 'codex:old11111-2222-3333-4444-555555555555', treePath: '/mira/tree', expectedOid: HEAD } }; },
      write() { return { ok: false, error: '只读文件系统' }; },
    };
    const res = await mirasimWorkerDone({
      ...reworkArgs(rig), gh: fakeGh({ headRefOid: NEW, reviews: [{ state: 'CHANGES_REQUESTED' }] }),
      registry: reg, pr: '884', round: 'rework',
    });
    assert.equal(res.ok, false);
    assert.equal(res.stage, 'rework:registry');
    assert.equal(rig.calls.interact.length, 0, '登记没刷成就别 interact（下一轮又对不上）');
  });
});

describe('#886 ④审官任务书的 m= 来自原派工（buildMirasimReviewerPrompts）', () => {
  const render = (o) => `读书 ${o.spec} p=${o.pr} m=${o.mergePolicy}${o.mergePolicy === 'manual' && o.mergeReason ? ` r=${o.mergeReason}` : ''}`;

  it('auto 一路：两本书都注入 m=auto', async () => {
    const { buildMirasimReviewerPrompts } = await import(RM);
    const r = buildMirasimReviewerPrompts({ pr: '884', policyPlan: { ok: true, mergePolicy: 'auto', source: 'ledger' }, render });
    assert.equal(r.ok, true);
    assert.equal(r.mergePolicy, 'auto');
    assert.match(r.prompt, /m=auto/);
    assert.match(r.reworkPrompt, /m=auto/);
    assert.ok(!/m=manual/.test(r.prompt));
  });

  it('manual 一路：m=manual 且带 r=<原因>，不许被降成 auto', async () => {
    const { buildMirasimReviewerPrompts } = await import(RM);
    const r = buildMirasimReviewerPrompts({
      pr: '884', policyPlan: { ok: true, mergePolicy: 'manual', mergeReason: '要人工过', source: 'ledger' }, render,
    });
    assert.equal(r.ok, true);
    assert.equal(r.mergePolicy, 'manual');
    assert.match(r.prompt, /m=manual r=要人工过/);
    assert.match(r.reworkPrompt, /m=manual r=要人工过/);
    assert.ok(!/m=auto/.test(r.prompt), 'manual 单绝不许注入 m=auto');
  });

  it('manual 缺 r= / 策略没定成 / 值不认识 → 拒渲染（不静默回退 auto）', async () => {
    const { buildMirasimReviewerPrompts } = await import(RM);
    assert.equal(buildMirasimReviewerPrompts({ pr: '884', policyPlan: { ok: true, mergePolicy: 'manual' }, render }).ok, false);
    assert.equal(buildMirasimReviewerPrompts({ pr: '884', policyPlan: { ok: false, error: 'x' }, render }).ok, false);
    assert.equal(buildMirasimReviewerPrompts({ pr: '884', policyPlan: { ok: true, mergePolicy: 'whatever' }, render }).ok, false);
    assert.equal(buildMirasimReviewerPrompts({ pr: '884', policyPlan: null, render }).ok, false);
    assert.equal(buildMirasimReviewerPrompts({ pr: '884', policyPlan: { ok: true, mergePolicy: 'auto' } }).ok, false);
  });

  it('接真模板：executor=mirasim 的审官注入 manual 路真带 m=manual r=', async () => {
    const T = 'file://' + path.resolve(__dirname, '..', 'scripts', 'lib', 'dispatch', 'template.mjs').replace(/\\/g, '/');
    const { buildReviewerInject } = await import(T);
    const { buildMirasimReviewerPrompts } = await import(RM);
    const r = buildMirasimReviewerPrompts({
      pr: '884', issue: 880, soldierDispatchId: '',
      policyPlan: { ok: true, mergePolicy: 'manual', mergeReason: '跨仓改动', source: 'flag' },
      render: buildReviewerInject,
    });
    assert.equal(r.ok, true);
    assert.match(r.prompt, /m=manual r=跨仓改动/);
    assert.ok(!/ d=/.test(r.prompt), 'mirasim 版审官书没有 orchestration 的 d=');
  });
});

describe('#886 ⑤mergeable 硬闸（复用 assessPrMergeable）', () => {
  it('UNKNOWN / CONFLICTING / 空 / 不认识 → 建树起会话之前就拒', async () => {
    const { mirasimReviewerCreate } = await import(RM);
    for (const m of ['UNKNOWN', 'CONFLICTING', '', 'WEIRD']) {
      const rig = reworkRig({ treeHead: HEAD });
      const res = await mirasimReviewerCreate({ ...reworkArgs(rig), gh: fakeGh({ mergeable: m }), pr: '884' });
      assert.equal(res.ok, false, `mergeable=${m || '空'} 不许放行`);
      assert.equal(res.stage, 'mergeable');
      assert.equal(rig.calls.ensure.length, 0, 'mergeable 闸要在建树之前');
      assert.equal(rig.calls.start.length, 0);
    }
  });

  it('MERGEABLE → 放行，且回报归一化后的 mergeable 值', async () => {
    const { mirasimReviewerCreate } = await import(RM);
    const rig = reworkRig({ treeHead: HEAD });
    const res = await mirasimReviewerCreate({ ...reworkArgs(rig), gh: fakeGh({ mergeable: 'MERGEABLE' }), pr: '884' });
    assert.equal(res.ok, true);
    assert.equal(res.mergeable, 'MERGEABLE');
  });

  it('返工轮也过同一道闸（CONFLICTING → rework:mergeable，不 interact）', async () => {
    const { mirasimWorkerDone } = await import(RM);
    const rig = reworkRig({ treeHead: HEAD, interactions: [{ promptId: 'p1' }] });
    const reg = memRegistry();
    reg.write('884', { pr: '884', sessionKey: 'codex:old11111-2222-3333-4444-555555555555', treePath: '/mira/tree', expectedOid: HEAD });
    const res = await mirasimWorkerDone({
      ...reworkArgs(rig), gh: fakeGh({ mergeable: 'CONFLICTING', reviews: [{ state: 'CHANGES_REQUESTED' }] }),
      registry: reg, pr: '884', round: 'rework',
    });
    assert.equal(res.ok, false);
    assert.equal(res.stage, 'rework:mergeable');
    assert.equal(rig.calls.interact.length, 0);
  });
});
