// 派工三动词的执行体绑定（#880 卡 B）：策略读取、族路由、两个绑定的分派。
//
// 两个判别用例是本套的存在理由：
//   ①「executor=mirasim 时一个 orca 命令都不发」——orca 假身会记账，调用次数必须是 0，
//     同时假运行时必须真收到 ensureWorkspace + startSession。少了后半句，一个啥也不干
//     的绑定也能让「没调 orca」通过，那就是「没扫到样本」冒充「查过没事」。
//   ②「策略缺该族配置 → 报警拒派」——不光要 ok:false，还要证明**一个会话都没起**：
//     静默降级的代价是烧掉的额度，而额度撤不回来。
// 不碰真服务：连线层全用假身注入，测的是判据，不是那台机器今天在不在。

const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const LIB = 'file://' + path.resolve(ROOT, 'scripts', 'lib', 'executor-binding.mjs').replace(/\\/g, '/');
// 只为读 PINNED_VERSION：判别用例要证明「策略钉的版本 ≠ 库内默认」，不能自己抄一份 0.0.282
const RUNTIME_LIB = 'file://' + path.resolve(ROOT, 'scripts', 'lib', 'mirasim-runtime.mjs').replace(/\\/g, '/');
const ROUTING_JSON = path.resolve(ROOT, 'docs', 'model-routing.json');

// 策略夹具：形状照 docs/model-routing.json 的「执行体」节抄
function policyDoc(over = {}) {
  return {
    执行体: {
      默认: 'orca',
      mirasim: {
        钉版本: '0.0.282',
        族: { claude: 'claude', gpt: 'gpt', gw: 'pi' },
        模型前缀族: { 'kimi-': 'kimi' },
        agentRoutes: {
          claude: { agent: 'claude', 腿: 'relay' },
          gpt: { agent: 'codex', 腿: 'relay' },
          pi: { agent: 'pi', 腿: 'direct' },
          kimi: { agent: 'kimi', 腿: 'relay' },
        },
        ...over,
      },
    },
  };
}

/** orca 假身：只记账，不干活。派 mirasim 时它的账必须是空的。 */
function orcaSpy() {
  const calls = [];
  const fn = (argv) => { calls.push(argv); return { ok: true, json: { spy: true } }; };
  fn.calls = calls;
  return fn;
}

/** mirasim 假运行时：记下每个动词被叫了几次、拿到什么参数。 */
function fakeRuntime(over = {}) {
  const calls = { ensureWorkspace: [], startSession: [] };
  return {
    calls,
    async ensureWorkspace(repo, branch) {
      calls.ensureWorkspace.push({ repo, branch });
      return over.workspace || { path: `/srv/trees/${branch}`, branch, created: true, verified: true };
    },
    async startSession(spec) {
      calls.startSession.push(spec);
      return over.session || { sessionKey: 'claude:fake-uuid', taskId: 't1', startedAt: 1788508356511 };
    },
    async readSession() { return { phase: 'done', missing: false }; },
    async waitForCompletion() { return { status: 'done', confirmedBy: ['snapshot', 'ledger'] }; },
    crossCheck() { return { ledger: { readable: true, rows: [] }, journal: { readable: false } }; },
  };
}

const argsWtSpy = (o) => ['worktree', 'create', '--name', String(o.name || ''), '--json'];
const argsWsSpy = (o) => ['orchestration', 'worker-start', '--task', String(o.task || ''), '--json'];

describe('执行体策略读取', () => {
  it('没有「执行体」节 = 没查成，不是「默认 orca」', async () => {
    const S = await import(LIB);
    const p = S.readExecutorPolicy({ 工人: {} });
    assert.equal(p.ok, false);
    assert.equal(p.unscanned, true);
    assert.equal(p.default, null, '读失败时不许给出默认值——那等于让一次读失败替人拍板');
    assert.match(p.error, /没查成/);
  });

  it('默认值不在白名单 → 不合法（且不是 unscanned）', async () => {
    const S = await import(LIB);
    const p = S.readExecutorPolicy({ 执行体: { 默认: 'devin' } });
    assert.equal(p.ok, false);
    assert.equal(p.unscanned, false);
    assert.match(p.error, /默认/);
  });

  it('夹具能读出四族与钉版本', async () => {
    const S = await import(LIB);
    const p = S.readExecutorPolicy(policyDoc());
    assert.equal(p.ok, true);
    assert.equal(p.default, 'orca');
    assert.equal(p.mirasim.pinnedVersion, '0.0.282');
    assert.deepEqual(Object.keys(p.mirasim.agentRoutes).sort(), ['claude', 'gpt', 'kimi', 'pi']);
  });

  it('仓内真表读得出来，且不是 0 条（零样本报红）', async () => {
    const S = await import(LIB);
    const doc = JSON.parse(fs.readFileSync(ROUTING_JSON, 'utf8'));
    const p = S.readExecutorPolicy(doc);
    assert.equal(p.ok, true, p.error || '');
    const n = Object.keys(p.mirasim.agentRoutes).length;
    assert.ok(n > 0, '真表里 agentRoutes 一条都没有 = 本次等于没查');
    // #880 拍板的三条腿：claude 云端、gpt 云端、pi 直烧网关池
    assert.deepEqual(
      S.judgeAgentRoute({ policy: p, model: 'claude-opus', provider: 'claude' }),
      { ok: true, family: 'claude', agent: 'claude', leg: 'relay', via: 'provider claude', error: null },
    );
    assert.equal(S.judgeAgentRoute({ policy: p, model: 'gpt-5.6-luna', provider: 'gpt' }).agent, 'codex');
    assert.equal(S.judgeAgentRoute({ policy: p, model: 'gpt-5.6-luna', provider: 'gpt' }).leg, 'relay');
    assert.equal(S.judgeAgentRoute({ policy: p, model: 'grok-4.6', provider: 'gw' }).agent, 'pi');
    assert.equal(S.judgeAgentRoute({ policy: p, model: 'grok-4.6', provider: 'gw' }).leg, 'direct');
  });
});

describe('执行体名字', () => {
  it('显式 --executor 优先，且只认白名单', async () => {
    const S = await import(LIB);
    const p = S.readExecutorPolicy(policyDoc());
    assert.equal(S.judgeExecutorName('mirasim', p).executor, 'mirasim');
    assert.equal(S.judgeExecutorName('mirasim', p).source, 'flag');
    const bad = S.judgeExecutorName('devin', p);
    assert.equal(bad.ok, false);
    assert.match(bad.error, /不认识/);
  });

  it('没给 --executor 就用策略默认；策略没查成时拒派而不落默认', async () => {
    const S = await import(LIB);
    const p = S.readExecutorPolicy(policyDoc());
    const ok = S.judgeExecutorName(undefined, p);
    assert.equal(ok.executor, 'orca');
    assert.equal(ok.source, 'policy');
    const un = S.judgeExecutorName(undefined, S.readExecutorPolicy({}));
    assert.equal(un.ok, false);
    assert.equal(un.executor, null);
    assert.match(un.error, /没查成/);
  });
});

describe('族路由', () => {
  it('模型前缀优先于 provider（kimi 自己成族，不被 gw 带成 pi）', async () => {
    const S = await import(LIB);
    const p = S.readExecutorPolicy(policyDoc());
    const r = S.judgeAgentRoute({ policy: p, model: 'kimi-k3', provider: 'gw' });
    assert.equal(r.family, 'kimi');
    assert.equal(r.agent, 'kimi');
    assert.match(r.via, /模型前缀/);
  });

  it('provider 没登记 → 拒派，错误里点名去哪儿拍板', async () => {
    const S = await import(LIB);
    const p = S.readExecutorPolicy(policyDoc());
    const r = S.judgeAgentRoute({ policy: p, model: 'composer-2.5', provider: 'cursor' });
    assert.equal(r.ok, false);
    assert.match(r.error, /拒派/);
    assert.match(r.error, /不静默降级/);
    assert.match(r.error, /model-routing\.json/);
  });

  it('族认出来了但 agentRoutes 里没这一条 → 拒派并列出已登记的族', async () => {
    const S = await import(LIB);
    const doc = policyDoc();
    delete doc.执行体.mirasim.agentRoutes.claude;
    const p = S.readExecutorPolicy(doc);
    const r = S.judgeAgentRoute({ policy: p, model: 'claude-opus', provider: 'claude' });
    assert.equal(r.ok, false);
    assert.equal(r.family, 'claude');
    assert.match(r.error, /已登记的族/);
  });

  it('agentRoutes 是空的 → 没查成，不是「这一族不该派」', async () => {
    const S = await import(LIB);
    const p = S.readExecutorPolicy(policyDoc({ agentRoutes: {} }));
    const r = S.judgeAgentRoute({ policy: p, model: 'claude-opus', provider: 'claude' });
    assert.equal(r.ok, false);
    assert.match(r.error, /没查成/);
  });

  it('配置形状不全（缺腿）→ 拒派，不给一半的路由', async () => {
    const S = await import(LIB);
    const doc = policyDoc();
    doc.执行体.mirasim.agentRoutes.claude = { agent: 'claude' };
    const p = S.readExecutorPolicy(doc);
    const r = S.judgeAgentRoute({ policy: p, model: 'claude-opus', provider: 'claude' });
    assert.equal(r.ok, false);
    assert.match(r.error, /形状不符/);
  });
});

describe('判别用例①：executor=mirasim 时一个 orca 命令都不发', () => {
  it('派一单：orca 假身零调用，而 mirasim 侧两个动词都真被叫了', async () => {
    const S = await import(LIB);
    const p = S.readExecutorPolicy(policyDoc());
    const spy = orcaSpy();
    const rt = fakeRuntime();
    const binding = S.bindExecutor({
      executor: 'mirasim',
      policy: p,
      runtime: rt,
      orca: spy,
      argsWorktreeCreate: argsWtSpy,
      argsWorkerStart: argsWsSpy,
    });
    assert.equal(binding.name, 'mirasim');
    const r = await binding.dispatchOne({
      repo: '/home/orca/windsurf-dao',
      branch: 'dao-880',
      prompt: '读 host/skills/dispatch/templates/soldier-book.md spec=试一针 #880',
      model: 'claude-opus',
      provider: 'claude',
    });
    assert.equal(r.ok, true, r.error || '');
    // 前半句：一个 orca 命令都没发
    assert.equal(spy.calls.length, 0, `mirasim 路径发了 ${spy.calls.length} 条 orca 命令：${JSON.stringify(spy.calls)}`);
    // 后半句：确实干了活（不然「没调 orca」是空转冒充的）
    assert.equal(rt.calls.ensureWorkspace.length, 1);
    assert.deepEqual(rt.calls.ensureWorkspace[0], { repo: '/home/orca/windsurf-dao', branch: 'dao-880' });
    assert.equal(rt.calls.startSession.length, 1);
    assert.equal(rt.calls.startSession[0].agent, 'claude', '族路由要把 agent 定成 claude');
    assert.equal(rt.calls.startSession[0].workdir, '/srv/trees/dao-880');
    assert.match(rt.calls.startSession[0].prompt, /soldier-book\.md/);
    // 裁定里带着这一单实际走了哪条腿
    assert.equal(r.sessionKey, 'claude:fake-uuid');
    assert.equal(r.leg, 'relay');
    assert.equal(r.family, 'claude');
    assert.equal(r.path, '/srv/trees/dao-880');
  });

  it('对照组：executor=orca 时确实发 orca 命令（否则上一条会被空转蒙过去）', async () => {
    const S = await import(LIB);
    const p = S.readExecutorPolicy(policyDoc());
    const spy = orcaSpy();
    const binding = S.bindExecutor({
      executor: 'orca',
      policy: p,
      orca: spy,
      argsWorktreeCreate: argsWtSpy,
      argsWorkerStart: argsWsSpy,
    });
    assert.equal(binding.name, 'orca');
    const wt = await binding.worktreeCreate({ name: 'ISSUE-880-试' });
    assert.equal(wt.ok, true);
    const ws = await binding.workerStart({ task: 'task-1', terminal: 'term_x' });
    assert.equal(ws.ok, true);
    assert.equal(spy.calls.length, 2);
    assert.deepEqual(spy.calls[0].slice(0, 2), ['worktree', 'create']);
    assert.deepEqual(spy.calls[1].slice(0, 2), ['orchestration', 'worker-start']);
  });

  it('orca 绑定的 dispatch 明说走原有队列脊，不假装自己接了', async () => {
    const S = await import(LIB);
    const p = S.readExecutorPolicy(policyDoc());
    const binding = S.bindExecutor({
      executor: 'orca', policy: p, orca: orcaSpy(),
      argsWorktreeCreate: argsWtSpy, argsWorkerStart: argsWsSpy,
    });
    const r = await binding.dispatchOne({});
    assert.equal(r.ok, false);
    assert.match(r.error, /dispatch-exec/);
  });
});

describe('判别用例②：策略缺该族配置 → 报警拒派，一个会话都不起', () => {
  it('派单被拒时，ensureWorkspace 和 startSession 的调用次数都是 0', async () => {
    const S = await import(LIB);
    const doc = policyDoc();
    delete doc.执行体.mirasim.族.gw;         // grok-4.6 走 gw，这一族没人拍过板
    delete doc.执行体.mirasim.agentRoutes.pi;
    const p = S.readExecutorPolicy(doc);
    const rt = fakeRuntime();
    const spy = orcaSpy();
    const binding = S.bindExecutor({ executor: 'mirasim', policy: p, runtime: rt, orca: spy, argsWorktreeCreate: argsWtSpy, argsWorkerStart: argsWsSpy });
    const r = await binding.dispatchOne({
      repo: '/home/orca/windsurf-dao', branch: 'dao-880',
      prompt: '任务书', model: 'grok-4.6', provider: 'gw',
    });
    assert.equal(r.ok, false);
    assert.equal(r.refused, true);
    assert.match(r.error, /拒派/);
    assert.match(r.error, /不静默降级/);
    // 这才是判据：拒派的意思是额度一分没烧、树一棵没建
    assert.equal(rt.calls.startSession.length, 0, '拒派了却起了会话——那不叫拒派，叫烧完再报警');
    assert.equal(rt.calls.ensureWorkspace.length, 0, '拒派了却先建了树——判据顺序错了');
    assert.equal(spy.calls.length, 0);
  });

  it('worker-start 单独走也一样：先判族，判不过不起会话', async () => {
    const S = await import(LIB);
    const doc = policyDoc();
    delete doc.执行体.mirasim.agentRoutes.pi;
    const p = S.readExecutorPolicy(doc);
    const rt = fakeRuntime();
    const binding = S.bindExecutor({ executor: 'mirasim', policy: p, runtime: rt });
    const r = await binding.workerStart({ workdir: '/srv/trees/x', prompt: '任务书', model: 'grok-4.6', provider: 'gw' });
    assert.equal(r.ok, false);
    assert.equal(r.refused, true);
    assert.equal(rt.calls.startSession.length, 0);
  });

  it('策略整体没查成时，绑定连建都建不出来（不许退到 orca 偷偷派）', async () => {
    const S = await import(LIB);
    const p = S.readExecutorPolicy({});
    assert.throws(
      () => S.bindExecutor({ policy: p, orca: orcaSpy(), argsWorktreeCreate: argsWtSpy, argsWorkerStart: argsWsSpy }),
      /没查成/,
    );
  });
});

describe('mirasim 绑定的边界', () => {
  it('建树缺 repo/branch → 报错，不拿空串去建', async () => {
    const S = await import(LIB);
    const p = S.readExecutorPolicy(policyDoc());
    const rt = fakeRuntime();
    const b = S.bindExecutor({ executor: 'mirasim', policy: p, runtime: rt });
    const r = await b.worktreeCreate({ repo: '', branch: 'x' });
    assert.equal(r.ok, false);
    assert.equal(rt.calls.ensureWorkspace.length, 0);
  });

  it('起会话缺 workdir/prompt → 报错，且族判过了也不许起空会话', async () => {
    const S = await import(LIB);
    const p = S.readExecutorPolicy(policyDoc());
    const rt = fakeRuntime();
    const b = S.bindExecutor({ executor: 'mirasim', policy: p, runtime: rt });
    const r = await b.workerStart({ workdir: '/srv/x', prompt: '', model: 'claude-opus', provider: 'claude' });
    assert.equal(r.ok, false);
    assert.equal(rt.calls.startSession.length, 0);
  });

  it('已有同分支的树 → created:false（幂等，不重复建）', async () => {
    const S = await import(LIB);
    const p = S.readExecutorPolicy(policyDoc());
    const rt = fakeRuntime({ workspace: { path: '/srv/trees/dao-880', branch: 'dao-880', created: false, verified: true } });
    const b = S.bindExecutor({ executor: 'mirasim', policy: p, runtime: rt });
    const r = await b.worktreeCreate({ repo: '/repo', branch: 'dao-880' });
    assert.equal(r.ok, true);
    assert.equal(r.created, false);
  });

  it('判完工的腿原样转给卡 A，不在本层抄第二份判据', async () => {
    const S = await import(LIB);
    const p = S.readExecutorPolicy(policyDoc());
    const b = S.bindExecutor({ executor: 'mirasim', policy: p, runtime: fakeRuntime() });
    const done = await b.waitForCompletion('claude:fake-uuid');
    assert.equal(done.status, 'done');
    assert.deepEqual(done.confirmedBy, ['snapshot', 'ledger']);
  });
});

// #884 审官 P1#5：钉版本的真相源是策略，不是 mirasim-runtime.mjs 里的常量。
// 判别力在「改策略要真的改到 runtime 手里」——只断 policy.mirasim.pinnedVersion
// 读出来是 0.0.283 不算，那只证明 JSON 解析没坏；必须读回 runtime 自己的 config。
describe('钉版本从策略传到 runtime（#884 P1#5）', () => {
  it('策略钉 0.0.283 → runtime.config.pinnedVersion 就是 0.0.283（不是库内 0.0.282）', async () => {
    const S = await import(LIB);
    const RT = await import(RUNTIME_LIB);
    const p = S.readExecutorPolicy(policyDoc({ 钉版本: '0.0.283' }));
    assert.equal(p.mirasim.pinnedVersion, '0.0.283');
    // 不注入 runtime：走的正是 dao.mjs 的真路径（bindExecutor 只给 policy）。
    const b = S.bindExecutor({ executor: 'mirasim', policy: p });
    assert.equal(
      b.runtime.config.pinnedVersion, '0.0.283',
      '策略改了钉版本却没传进 runtime：服务升级后照旧按旧版本拒派（#884 P1#5）',
    );
    assert.notEqual(
      b.runtime.config.pinnedVersion, RT.PINNED_VERSION,
      '夹具钉的版本必须与库内默认不同，否则这条断言分不出「传过去了」和「压根没传」',
    );
  });

  it('策略没写钉版本 → 落库内默认，不落 null/undefined（否则契约断言判不了版本）', async () => {
    const S = await import(LIB);
    const RT = await import(RUNTIME_LIB);
    const p = S.readExecutorPolicy(policyDoc({ 钉版本: undefined }));
    assert.equal(p.mirasim.pinnedVersion, null, '策略没写就是 null，本层不替它编一个');
    const b = S.bindExecutor({ executor: 'mirasim', policy: p });
    assert.equal(b.runtime.config.pinnedVersion, RT.PINNED_VERSION);
  });

  it('注入了 runtime 时用注入的那个，不被策略覆写（测试与调用方能自己接线）', async () => {
    const S = await import(LIB);
    const rt = fakeRuntime();
    const p = S.readExecutorPolicy(policyDoc({ 钉版本: '0.0.283' }));
    const b = S.bindExecutor({ executor: 'mirasim', policy: p, runtime: rt });
    assert.equal(b.runtime, rt);
  });

  it('仓内真表的钉版本就是 runtime 拿到的那个（真表与代码不许各钉一个）', async () => {
    const S = await import(LIB);
    const doc = JSON.parse(fs.readFileSync(ROUTING_JSON, 'utf8'));
    const p = S.readExecutorPolicy(doc);
    assert.equal(p.ok, true, p.error || '');
    assert.ok(p.mirasim && p.mirasim.pinnedVersion, '真表里没钉版本 = 本次等于没查');
    const b = S.bindExecutor({ executor: 'mirasim', policy: p });
    assert.equal(b.runtime.config.pinnedVersion, p.mirasim.pinnedVersion);
  });
});

// #884 审官 P1#4：公开 CLI 不许崩栈。走真进程黑盒——用 dao.mjs 自己的出口判，
// 不复用被测判据。判别力在「拿到的是结构化 ok:false，而不是模板异常的栈」。
describe('dispatch --executor mirasim 拒 --task（#884 P1#4）', () => {
  const DAO = path.resolve(ROOT, 'scripts', 'dao.mjs');
  // constrainDispatch 在执行体分岔之前就要 --model/--reviewer/--split，所以判别用例
  // 必须把它们都给足，才能真的走到 mirasim 分支——少给一个就变成在测上游的闸。
  const baseArgs = [
    '--executor', 'mirasim', '--branch', 'dao-probe-task',
    '--model', 'grok-4.6', '--reviewer', 'gpt-5.6-luna',
    '--split', 'no', '--split-reason', '#884 P1#4 判别用例',
    '--dry-run',
  ];
  const runDao = (extra) => spawnSync(process.execPath, [DAO, 'dispatch', ...extra, ...baseArgs], {
    encoding: 'utf8', timeout: 60000, cwd: ROOT, env: { ...process.env },
  });

  it('--task 没 --spec → 结构化拒派，绝不是 {{SPEC}} 模板崩栈', () => {
    const r = runDao(['--task', 'task-1']);
    assert.doesNotMatch(
      String(r.stderr || ''), /占位符 \{\{SPEC\}\} 没给值/,
      '仍在模板占位符上崩栈：公开 CLI 崩栈 = #884 P1#4 没修',
    );
    assert.doesNotMatch(String(r.stderr || ''), /at cmdDispatchMirasim/, '不许把 node 栈甩给用户');
    const out = JSON.parse(String(r.stdout || '').trim());
    assert.equal(out.ok, false);
    assert.equal(out.refused, true);
    assert.equal(out.unsupported, '--task');
    assert.equal(out.task, 'task-1');
    assert.match(out.error, /暂不支持 --task/);
    assert.equal(r.status, 1, '拒派要非零退出，否则脚本调用方看不出被拒');
  });

  it('给了 --spec 就照旧派（证明上一条拒的是缺 spec，不是把 mirasim 分支整条堵死）', () => {
    const r = runDao(['--spec', '#884 P1#4 判别用例：证明 spec 路没被堵']);
    const out = JSON.parse(String(r.stdout || '').trim());
    assert.equal(out.ok, true, out.error || '');
    assert.equal(out.dryRun, true);
    assert.equal(out.executor, 'mirasim');
    assert.equal(out.agent, 'pi', 'grok-4.6/gw 应落 pi 族 direct 腿（#880 拍板）');
    assert.ok(out.prompt && out.prompt.length > 0, 'spec 路必须真的渲出任务书');
    assert.equal(r.status, 0);
  });
});
