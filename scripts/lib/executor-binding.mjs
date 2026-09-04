// scripts/lib/executor-binding.mjs —— 派工三动词的执行体绑定层（#880 卡 B）
//
// 改这段前必须知道：
// - 调用方（dao.mjs 的 dispatch / worktree-create / worker-start）只说 executor 是谁，
//   底下走 orca 还是 mirasim 由本文件决定。orca 退役那天删 createOrcaBinding 和策略里
//   「默认: orca」，调用方一行不改——这是 #880 拍的架构。
// - 策略只认 docs/model-routing.json 的「执行体」节。TOML 里不许有第二份（选型唯一真相源）。
// - 缺该族配置 = 报警拒派。静默降级会把「这一族没人拍过板」变成「随便挑条腿烧额度」，
//   而烧掉的额度撤不回来。判别用例钉住这条：拒派时**一个会话都不许起**。
// - mirasim 绑定拿不到 orca 执行器（bindExecutor 分岔时就不传），所以「不碰 orca」是
//   结构上的，不靠读代码相信；判别用例用会记账的 orca 假身把它证出来。
//
// 三个动词在两个绑定上的对应关系：
//   worktree-create → orca: `worktree create`      / mirasim: ensureWorkspace(repo,branch)
//   worker-start    → orca: `orchestration worker-start` / mirasim: startSession({agent,workdir,prompt})
//   dispatch        → orca: dao.mjs 原有队列脊（派工单 + detached 执行体，本绑定不接）
//                     mirasim: dispatchOne = ensureWorkspace + startSession（会话即卡）

import { createRuntime } from './mirasim-runtime.mjs';

export const EXECUTORS = ['orca', 'mirasim'];

/** 策略节在选型 JSON 里的键名。改这里要同步 docs/model-routing.json。 */
export const EXECUTOR_POLICY_KEY = '执行体';

/**
 * 读执行体策略。纯函数，只吃已解析的选型 JSON 文档。
 *
 * 没有「执行体」节时给 unscanned:true —— 这是「没查成」，**不是**「默认 orca」。
 * 把缺配置读成默认值，等于让一次读失败自动选一条腿，而选腿是拍板过的事。
 */
export function readExecutorPolicy(doc) {
  const node = doc && typeof doc === 'object' ? doc[EXECUTOR_POLICY_KEY] : null;
  if (!node || typeof node !== 'object') {
    return {
      ok: false,
      unscanned: true,
      error: `选型表里没扫到「${EXECUTOR_POLICY_KEY}」节——这是没查成，不是「默认走 orca」；要派先在 docs/model-routing.json 里拍板`,
      default: null,
      mirasim: null,
    };
  }
  const dflt = String(node.默认 || '').trim();
  if (!EXECUTORS.includes(dflt)) {
    return {
      ok: false,
      unscanned: false,
      error: `「${EXECUTOR_POLICY_KEY}.默认」是 ${JSON.stringify(node.默认)}，不在 ${EXECUTORS.join(' / ')} 里`,
      default: null,
      mirasim: null,
    };
  }
  const m = node.mirasim && typeof node.mirasim === 'object' ? node.mirasim : null;
  const mirasim = m
    ? {
      pinnedVersion: typeof m.钉版本 === 'string' ? m.钉版本 : null,
      familyByProvider: plainMap(m.族),
      familyByModelPrefix: plainMap(m.模型前缀族),
      agentRoutes: m.agentRoutes && typeof m.agentRoutes === 'object' ? m.agentRoutes : {},
    }
    : null;
  return { ok: true, unscanned: false, error: null, default: dflt, mirasim, raw: node };
}

function plainMap(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const out = {};
  for (const [k, val] of Object.entries(v)) {
    if (typeof k === 'string' && typeof val === 'string' && k && val) out[k] = val;
  }
  return out;
}

/**
 * 定执行体名字。显式 --executor 优先，其次策略里的默认。
 * 策略没查成时不许落默认——调用方当场拒派。
 */
export function judgeExecutorName(requested, policy) {
  const want = String(requested || '').trim();
  if (want) {
    if (!EXECUTORS.includes(want)) {
      return { ok: false, executor: null, error: `--executor ${want} 不认识（只要 ${EXECUTORS.join(' / ')}）` };
    }
    return { ok: true, executor: want, source: 'flag', error: null };
  }
  if (!policy || policy.ok !== true) {
    return {
      ok: false,
      executor: null,
      error: `没给 --executor，而执行体策略${policy?.unscanned ? '没查成' : '不合法'}：${policy?.error || '未知'}`,
    };
  }
  return { ok: true, executor: policy.default, source: 'policy', error: null };
}

/**
 * 按族定 mirasim 上跑哪个执行体 agent、走哪条腿。
 *
 * 族的来源两条，模型前缀优先于 provider（kimi 这类自己成族的模型不该被 provider 带跑）。
 * 任一环缺配置都 ok:false —— 调用方必须当场拒派，不许挑一条腿凑。
 */
export function judgeAgentRoute({ policy, model, provider } = {}) {
  if (!policy || policy.ok !== true) {
    return { ok: false, error: `执行体策略${policy?.unscanned ? '没查成' : '不合法'}：${policy?.error || '未知'}` };
  }
  const m = policy.mirasim;
  if (!m) {
    return { ok: false, error: `「${EXECUTOR_POLICY_KEY}.mirasim」节不在——mirasim 路径没有策略可读，拒派` };
  }
  const routes = m.agentRoutes || {};
  const known = Object.keys(routes);
  if (known.length === 0) {
    return { ok: false, error: `「${EXECUTOR_POLICY_KEY}.mirasim.agentRoutes」一条都没有——这是没查成，拒派` };
  }

  const modelId = String(model || '').trim();
  const providerId = String(provider || '').trim();
  let family = null;
  let via = null;
  for (const [prefix, fam] of Object.entries(m.familyByModelPrefix || {})) {
    if (modelId && modelId.startsWith(prefix)) { family = fam; via = `模型前缀 ${prefix}`; break; }
  }
  if (!family && providerId && m.familyByProvider) {
    const hit = m.familyByProvider[providerId];
    if (hit) { family = hit; via = `provider ${providerId}`; }
  }
  if (!family) {
    return {
      ok: false,
      family: null,
      error: `执行体 mirasim 的策略表里没登记这一族：model=${modelId || '?'} provider=${providerId || '?'}`
        + `——报警拒派，不静默降级；要派先在 docs/model-routing.json 的 ${EXECUTOR_POLICY_KEY}.mirasim.族 里拍板`,
    };
  }

  const route = routes[family];
  if (!route || typeof route !== 'object') {
    return {
      ok: false,
      family,
      error: `族 ${family}（按${via}认出）在 ${EXECUTOR_POLICY_KEY}.mirasim.agentRoutes 里没有配置`
        + `——报警拒派，不静默降级；已登记的族只有 ${known.join(' / ')}`,
    };
  }
  const agent = typeof route.agent === 'string' ? route.agent.trim() : '';
  const leg = typeof route.腿 === 'string' ? route.腿.trim() : '';
  if (!agent || !leg) {
    return {
      ok: false,
      family,
      error: `族 ${family} 的配置形状不符：agent=${JSON.stringify(route.agent)} 腿=${JSON.stringify(route.腿)}，两者都要非空——拒派`,
    };
  }
  return { ok: true, family, agent, leg, via, error: null };
}

/**
 * orca 绑定。执行器与 argv 组装都靠注入——本层不 import dao.mjs（会成环），
 * 也不自己拼 argv（那是 lib/dispatch/args.mjs 的事，抄第二份必然走偏）。
 */
export function createOrcaBinding({ orca, argsWorktreeCreate, argsWorkerStart } = {}) {
  if (typeof orca !== 'function') throw new Error('createOrcaBinding 要 orca 执行器');
  if (typeof argsWorktreeCreate !== 'function') throw new Error('createOrcaBinding 要 argsWorktreeCreate');
  if (typeof argsWorkerStart !== 'function') throw new Error('createOrcaBinding 要 argsWorkerStart');
  return {
    name: 'orca',
    async worktreeCreate(spec = {}) {
      const r = orca(argsWorktreeCreate({
        name: spec.name,
        noParent: spec.noParent,
        setup: spec.setup,
        parentWorktree: spec.parentWorktree,
        baseBranch: spec.baseBranch,
        issue: spec.issue,
        comment: spec.comment,
        repo: spec.repo,
      }));
      if (!r || r.ok !== true) return { ok: false, executor: 'orca', error: r?.error ?? 'worktree create 失败', native: r?.json ?? null };
      return { ok: true, executor: 'orca', path: null, branch: null, created: true, native: r.json };
    },
    async workerStart(spec = {}) {
      const r = orca(argsWorkerStart({
        task: spec.task,
        worktree: spec.worktree,
        terminal: spec.terminal,
        retryOf: spec.retryOf,
        run: spec.run,
      }));
      if (!r || r.ok !== true) return { ok: false, executor: 'orca', error: r?.error ?? 'worker-start 失败', native: r?.json ?? null };
      return { ok: true, executor: 'orca', native: r.json };
    },
    async dispatchOne() {
      return {
        ok: false,
        executor: 'orca',
        error: 'orca 的 dispatch 走 dao.mjs 原有队列脊（dispatch 写派工单 → dispatch-exec 后台执行），不经本绑定；orca 退役时那段整体删',
      };
    },
  };
}

/**
 * mirasim 绑定。三个动词都落在卡 A 冻结的五动词上，签名一字不改。
 * 契约断言（钉版本 + 帧形状 + 执行体在不在）在 ensureWorkspace / startSession 里面，
 * 不符就抛且一帧 prompt 都不发——本层不再断第二遍（抄第二份判据必然走偏）。
 */
export function createMirasimBinding({ runtime, policy } = {}) {
  const rt = runtime || createRuntime();
  return {
    name: 'mirasim',
    async worktreeCreate(spec = {}) {
      const repo = String(spec.repo || '').trim();
      const branch = String(spec.branch || '').trim();
      if (!repo || !branch) return { ok: false, executor: 'mirasim', error: 'mirasim 建树要 repo（仓路径）和 branch（新分支名）' };
      const r = await rt.ensureWorkspace(repo, branch);
      return {
        ok: true,
        executor: 'mirasim',
        path: r.path,
        branch: r.branch ?? branch,
        created: r.created === true,
        verified: r.verified !== false,
        native: r,
      };
    },
    async workerStart(spec = {}) {
      const route = judgeAgentRoute({ policy, model: spec.model, provider: spec.provider });
      // 拒派点在起会话之前：这一步返回 false 时，一个会话都还没起。
      if (!route.ok) return { ok: false, executor: 'mirasim', refused: true, error: route.error, family: route.family ?? null };
      const workdir = String(spec.workdir || '').trim();
      const prompt = String(spec.prompt || '');
      if (!workdir || !prompt) return { ok: false, executor: 'mirasim', error: 'mirasim 起会话要 workdir 和 prompt（任务书）' };
      const started = await rt.startSession({ agent: route.agent, workdir, prompt });
      return {
        ok: true,
        executor: 'mirasim',
        sessionKey: started.sessionKey,
        taskId: started.taskId ?? null,
        startedAt: started.startedAt ?? null,
        agent: route.agent,
        family: route.family,
        leg: route.leg,
        // dao 的 --model 在这条路上选的是「哪一族、哪个执行体 agent」，
        // 不是上游那个具体模型 id——具体模型由执行体自己的配置决定（见 PR 正文「没查成」）。
        daoModel: spec.model ?? null,
        native: started,
      };
    },
    /** 派一单：建树 + 起会话。会话即卡（观察面是用户自己的 Mirasim 客户端，#880）。 */
    async dispatchOne(spec = {}) {
      const route = judgeAgentRoute({ policy, model: spec.model, provider: spec.provider });
      // 族没配置就在这里止步——建树也不做，一个会话都不起。
      if (!route.ok) return { ok: false, executor: 'mirasim', refused: true, error: route.error, family: route.family ?? null };
      const tree = await this.worktreeCreate({ repo: spec.repo, branch: spec.branch });
      if (!tree.ok) return { ok: false, executor: 'mirasim', error: tree.error, stage: 'worktree' };
      const started = await this.workerStart({
        workdir: tree.path,
        prompt: spec.prompt,
        model: spec.model,
        provider: spec.provider,
      });
      if (!started.ok) return { ...started, stage: 'session', tree };
      return { ...started, path: tree.path, branch: tree.branch, treeCreated: tree.created, tree };
    },
    /** 判完工：读会话 + 账本交叉核。腿都在卡 A，本层只转手。 */
    async waitForCompletion(sessionKey, opts) { return rt.waitForCompletion(sessionKey, opts); },
    async readSession(sessionKey) { return rt.readSession(sessionKey); },
    crossCheck(sessionKey) { return rt.crossCheck(sessionKey); },
  };
}

/**
 * 按 executor 分派绑定。
 *
 * mirasim 分支不接 orca 执行器，orca 分支不接 mirasim 运行时——两条路在结构上
 * 碰不到对方的东西，不靠约定。
 */
export function bindExecutor({ executor, policy, orca, argsWorktreeCreate, argsWorkerStart, runtime } = {}) {
  const named = judgeExecutorName(executor, policy);
  if (!named.ok) throw new Error(named.error);
  if (named.executor === 'mirasim') return createMirasimBinding({ runtime, policy });
  return createOrcaBinding({ orca, argsWorktreeCreate, argsWorkerStart });
}
