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
// - 卡 C（reviewer-create / worker-done）在本文件合并前写过一份最小同形实现。
//   **以本文件为准**。四个导出保持卡 C 调用点能用：readExecutorPolicy 认 routing.raw、
//   judgeExecutorName 同时给 name/executor、judgeAgentRoute 认 (modelId, mirasimPolicy)、
//   bindExecutor({routing}) 回 {ok, runtime, mirasim}。新调用走卡 B 形状。
//
// 三个动词在两个绑定上的对应关系：
//   worktree-create → orca: `worktree create`      / mirasim: ensureWorkspace(repo,branch)
//   worker-start    → orca: `orchestration worker-start` / mirasim: startSession({agent,workdir,prompt})
//   dispatch        → orca: dao.mjs 原有队列脊（派工单 + detached 执行体，本绑定不接）
//                     mirasim: dispatchOne = ensureWorkspace + startSession（会话即卡）

import { createRuntime, PINNED_VERSION } from './mirasim-runtime.mjs';

export const EXECUTORS = ['orca', 'mirasim'];

/** 策略节在选型 JSON 里的键名。改这里要同步 docs/model-routing.json。 */
export const EXECUTOR_POLICY_KEY = '执行体';

function looksLikeRoutingWrapper(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  if (obj[EXECUTOR_POLICY_KEY]) return false;
  return !!(obj.raw || Array.isArray(obj.models));
}

function unwrapDoc(routingOrRaw) {
  if (looksLikeRoutingWrapper(routingOrRaw)) return routingOrRaw.raw || {};
  return routingOrRaw;
}

function plainMap(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const out = {};
  for (const [k, val] of Object.entries(v)) {
    if (typeof k === 'string' && typeof val === 'string' && k && val) out[k] = val;
  }
  return out;
}

function normalizeMirasim(m) {
  if (!m || typeof m !== 'object') return null;
  return {
    ...m,
    pinnedVersion: typeof m.钉版本 === 'string' ? m.钉版本 : null,
    familyByProvider: plainMap(m.族),
    familyByModelPrefix: plainMap(m.模型前缀族),
    agentRoutes: m.agentRoutes && typeof m.agentRoutes === 'object' ? m.agentRoutes : {},
  };
}

/**
 * 读执行体策略。纯函数。
 *
 * 吃已解析的选型 JSON 文档，或卡 C 的 `{ raw, models }` 包装。
 * 没有「执行体」节时给 unscanned:true —— 这是「没查成」，**不是**「默认 orca」。
 * 把缺配置读成默认值，等于让一次读失败自动选一条腿，而选腿是拍板过的事。
 */
export function readExecutorPolicy(routingOrRaw) {
  const doc = unwrapDoc(routingOrRaw);
  const node = doc && typeof doc === 'object' ? doc[EXECUTOR_POLICY_KEY] : null;
  if (!node || typeof node !== 'object') {
    return {
      ok: false,
      unscanned: true,
      scanned: false,
      error: `选型表里没扫到「${EXECUTOR_POLICY_KEY}」节——这是没查成，不是「默认走 orca」；要派先在 docs/model-routing.json 里拍板`,
      default: null,
      mirasim: null,
      orca: null,
      why: `路由表没有「${EXECUTOR_POLICY_KEY}」节`,
    };
  }
  const dflt = String(node.默认 || '').trim();
  if (!EXECUTORS.includes(dflt)) {
    return {
      ok: false,
      unscanned: false,
      scanned: true,
      error: `「${EXECUTOR_POLICY_KEY}.默认」是 ${JSON.stringify(node.默认)}，不在 ${EXECUTORS.join(' / ')} 里`,
      default: null,
      mirasim: null,
      orca: null,
      why: null,
    };
  }
  return {
    ok: true,
    unscanned: false,
    scanned: true,
    error: null,
    default: dflt,
    mirasim: normalizeMirasim(node.mirasim),
    orca: (node.orca) || { 说明: '现役运行时（Orca worktree + terminal）' },
    raw: node,
    why: null,
  };
}

/**
 * 定执行体名字。显式 --executor 优先，其次策略里的默认。
 * 策略没查成时不许落默认——调用方当场拒派。
 * 同时给 `executor`（卡 B）和 `name`（卡 C），两套调用点都能读。
 */
export function judgeExecutorName(requested, policy) {
  const want = String(requested || '').trim();
  if (want) {
    if (!EXECUTORS.includes(want)) {
      return { ok: false, executor: null, name: want, error: `--executor ${want} 不认识（只要 ${EXECUTORS.join(' / ')}）` };
    }
    if (want === 'mirasim' && (!policy || !policy.mirasim)) {
      return {
        ok: false,
        executor: null,
        name: want,
        error: 'executor=mirasim 但路由表「执行体.mirasim」没登记（没查成，拒派）',
      };
    }
    return { ok: true, executor: want, name: want, source: 'flag', error: null };
  }
  if (!policy || policy.ok !== true) {
    return {
      ok: false,
      executor: null,
      name: null,
      error: `没给 --executor，而执行体策略${policy?.unscanned ? '没查成' : '不合法'}：${policy?.error || '未知'}`,
    };
  }
  return { ok: true, executor: policy.default, name: policy.default, source: 'policy', error: null };
}

function familyFromPrefix(prefixMap, modelId) {
  let family = null;
  let hitPrefix = '';
  const map = prefixMap && typeof prefixMap === 'object' ? prefixMap : {};
  for (const [prefix, fam] of Object.entries(map)) {
    if (!modelId || !prefix || !(modelId === prefix || modelId.startsWith(prefix))) continue;
    if (prefix.length <= hitPrefix.length) continue;
    hitPrefix = prefix;
    family = fam;
  }
  return { family, hitPrefix };
}

function agentRoutesOf(mirasimLike) {
  if (!mirasimLike || typeof mirasimLike !== 'object') return {};
  return mirasimLike.agentRoutes && typeof mirasimLike.agentRoutes === 'object' ? mirasimLike.agentRoutes : {};
}

function prefixMapOf(mirasimLike) {
  if (!mirasimLike || typeof mirasimLike !== 'object') return {};
  if (mirasimLike.familyByModelPrefix && typeof mirasimLike.familyByModelPrefix === 'object') {
    return mirasimLike.familyByModelPrefix;
  }
  return plainMap(mirasimLike['模型前缀族']);
}

function providerMapOf(mirasimLike) {
  if (!mirasimLike || typeof mirasimLike !== 'object') return {};
  if (mirasimLike.familyByProvider && typeof mirasimLike.familyByProvider === 'object') {
    return mirasimLike.familyByProvider;
  }
  return plainMap(mirasimLike['族']);
}

function routeLeg(route) {
  if (!route || typeof route !== 'object') return '';
  const a = typeof route.腿 === 'string' ? route.腿.trim() : '';
  const b = typeof route.mode === 'string' ? route.mode.trim() : '';
  return a || b;
}

/**
 * 按族定 mirasim 上跑哪个执行体 agent、走哪条腿。
 *
 * 两种调用：
 *   卡 B：judgeAgentRoute({ policy, model, provider })
 *   卡 C：judgeAgentRoute(modelId, mirasimPolicy)
 *
 * 族的来源（#880 / #982）：
 *   1. 「模型前缀族」最长前缀优先（书写顺序不许替人拍板）
 *   2. 模型 id 第一段（gpt-5.6-luna → gpt）——用来认出家族名字
 *   3. 夹具里的 provider→族 表（只在测试夹具把 族 写成 map 时有用；真表的 族 是字符串，不算）
 * 认出家族后必须在 agentRoutes 里有落点，否则报警拒派、不静默降级。
 * gw 是落地通道不是厂商族：grok-4.6 的 provider=gw 不许被带去 pi 直连腿。
 */
export function judgeAgentRoute(a, b) {
  const cardB = a && typeof a === 'object' && !Array.isArray(a) && ('policy' in a || 'model' in a || 'provider' in a);
  if (cardB) return judgeAgentRouteFromPolicy(a);
  return judgeAgentRouteFromMirasim(a, b);
}

function judgeAgentRouteFromPolicy({ policy, model, provider } = {}) {
  if (!policy || policy.ok !== true) {
    return { ok: false, error: `执行体策略${policy?.unscanned ? '没查成' : '不合法'}：${policy?.error || '未知'}` };
  }
  const m = policy.mirasim;
  if (!m) {
    return { ok: false, error: `「${EXECUTOR_POLICY_KEY}.mirasim」节不在——mirasim 路径没有策略可读，拒派` };
  }
  return resolveFamilyRoute({
    mirasim: m,
    model,
    provider,
    emptyRoutesError: `「${EXECUTOR_POLICY_KEY}.mirasim.agentRoutes」一条都没有——这是没查成，拒派`,
  });
}

function judgeAgentRouteFromMirasim(modelId, mirasimPolicy) {
  const id = modelId == null ? '' : String(modelId).trim();
  if (!id) return { ok: false, error: '判 agent 路由要模型 id（没给）' };
  if (!mirasimPolicy || typeof mirasimPolicy !== 'object') {
    return { ok: false, error: 'mirasim 策略没查成（没拿到 agentRoutes）' };
  }
  return resolveFamilyRoute({
    mirasim: mirasimPolicy,
    model: id,
    provider: null,
    emptyRoutesError: 'mirasim.agentRoutes 没登记（没查成，拒派）',
  });
}

function resolveFamilyRoute({ mirasim, model, provider, emptyRoutesError }) {
  const routes = agentRoutesOf(mirasim);
  const known = Object.keys(routes);
  if (known.length === 0) {
    return { ok: false, error: emptyRoutesError };
  }

  const modelId = String(model || '').trim();
  const providerId = String(provider || '').trim();
  let family = null;
  let via = null;

  const prefixed = familyFromPrefix(prefixMapOf(mirasim), modelId);
  if (prefixed.family) {
    family = prefixed.family;
    via = `模型前缀 ${prefixed.hitPrefix}`;
  }
  if (!family && modelId) {
    const token = modelId.split(/[-.]/)[0];
    if (token) {
      family = token;
      via = `id 首段 ${token}`;
    }
  }
  if (!family && providerId) {
    const hit = providerMapOf(mirasim)[providerId];
    if (hit) {
      family = hit;
      via = `provider ${providerId}`;
    }
  }
  if (!family) {
    return {
      ok: false,
      family: null,
      error: `执行体 mirasim 的策略表里没登记这一族：model=${modelId || '?'} provider=${providerId || '?'}`
        + `——报警拒派，不静默降级；要派先在 docs/model-routing.json 的 ${EXECUTOR_POLICY_KEY}.mirasim 里拍板`,
    };
  }

  const route = routes[family];
  if (!route || typeof route !== 'object') {
    return {
      ok: false,
      family,
      error: `族 ${family}（按${via}认出）在 ${EXECUTOR_POLICY_KEY}.mirasim.agentRoutes 里没有配置`
        + `——报警拒派，不静默降级；已登记的族只有 ${known.join(' / ')}。要派先在 docs/model-routing.json 里拍板`,
    };
  }
  const agent = typeof route.agent === 'string' ? route.agent.trim() : '';
  const leg = routeLeg(route);
  if (!agent || !leg) {
    return {
      ok: false,
      family,
      error: `族 ${family} 的配置形状不符：agent=${JSON.stringify(route.agent)} 腿/mode=${JSON.stringify(route.腿 ?? route.mode)}，两者都要非空——拒派`,
    };
  }
  return { ok: true, family, agent, leg, mode: leg, via, error: null };
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
  // 钉版本的唯一真相源是策略（docs/model-routing.json 的 执行体.mirasim.钉版本）。
  // 不传等于 runtime 拿库内常量当真相：改路由表钉版本不生效——服务升级后照旧拒新版本，
  // 或策略已改新版本却继续放旧版本过（#884 审官 P1#5 实咬）。
  // 策略没写（null）时才让 createRuntime 落库内默认，不在这里抄第二份默认值。
  const rt = runtime || createRuntime({ pinnedVersion: policy?.mirasim?.pinnedVersion || undefined });
  return {
    name: 'mirasim',
    runtime: rt,
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
      if (!route.ok) return { ok: false, executor: 'mirasim', refused: true, error: route.error, family: route.family ?? null };
      const workdir = String(spec.workdir || '').trim();
      const prompt = String(spec.prompt || '');
      if (!workdir || !prompt) return { ok: false, executor: 'mirasim', error: 'mirasim 起会话要 workdir 和 prompt（任务书）' };
      // #884 审官 P1#2：model 在上一行算出来却不往下传 = 服务端永远收不到具体模型，
      // 而回执里的 daoModel 只是同一个变量抄了一遍，证明不了「发过」。
      const started = await rt.startSession({ agent: route.agent, workdir, prompt, model: spec.model || undefined });
      return {
        ok: true,
        executor: 'mirasim',
        sessionKey: started.sessionKey,
        taskId: started.taskId ?? null,
        startedAt: started.startedAt ?? null,
        agent: route.agent,
        family: route.family,
        leg: route.leg,
        mode: route.mode,
        daoModel: spec.model ?? null,
        native: started,
      };
    },
    async dispatchOne(spec = {}) {
      const route = judgeAgentRoute({ policy, model: spec.model, provider: spec.provider });
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
    async waitForCompletion(sessionKey, opts) { return rt.waitForCompletion(sessionKey, opts); },
    async readSession(sessionKey) { return rt.readSession(sessionKey); },
    crossCheck(sessionKey) { return rt.crossCheck(sessionKey); },
  };
}

/**
 * 按 executor 分派绑定。
 *
 * 卡 B：bindExecutor({ executor, policy, orca, argsWorktreeCreate, argsWorkerStart, runtime })
 *       策略没查成时抛；返回带 .name 的绑定。
 * 卡 C：bindExecutor({ executor, routing, runtimeFactory, runtimeOpts })
 *       返回 { ok, executor, runtime, policy, mirasim }，失败不抛。
 */
export function bindExecutor(opts = {}) {
  const cardC = opts.routing != null && opts.policy == null;
  if (cardC) {
    const policy = readExecutorPolicy(opts.routing);
    const named = judgeExecutorName(opts.executor, policy);
    if (!named.ok) return { ok: false, error: named.error, policy };
    if (named.executor === 'orca') {
      return { ok: true, executor: 'orca', name: 'orca', runtime: null, policy };
    }
    const runtimeFactory = opts.runtimeFactory || createRuntime;
    const pinned = (policy.mirasim && policy.mirasim.pinnedVersion) || PINNED_VERSION;
    const runtime = opts.runtime || runtimeFactory({ pinnedVersion: pinned, ...(opts.runtimeOpts || {}) });
    const binding = createMirasimBinding({ runtime, policy });
    return {
      ok: true,
      executor: 'mirasim',
      name: 'mirasim',
      runtime,
      policy,
      mirasim: policy.mirasim,
      pinnedVersion: pinned,
      worktreeCreate: binding.worktreeCreate.bind(binding),
      workerStart: binding.workerStart.bind(binding),
      dispatchOne: binding.dispatchOne.bind(binding),
    };
  }

  const named = judgeExecutorName(opts.executor, opts.policy);
  if (!named.ok) throw new Error(named.error);
  if (named.executor === 'mirasim') return createMirasimBinding({ runtime: opts.runtime, policy: opts.policy });
  return createOrcaBinding({
    orca: opts.orca,
    argsWorktreeCreate: opts.argsWorktreeCreate,
    argsWorkerStart: opts.argsWorkerStart,
  });
}
