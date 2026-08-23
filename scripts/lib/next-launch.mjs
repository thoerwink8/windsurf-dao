// scripts/lib/next-launch.mjs —— 管子层纯函数（#615）
//
// 派工 / 验开工 / 换管只读 pipes，不另造映射表。
// 管子不进打分：本文件不碰 Score，只决定下一根管子或名单里的下一个模型。

/** 缺省 = 只一根，等于现在的 provider + cli_model。 */
export function normalizePipes(model) {
  if (!model || typeof model !== 'object') return [];
  const listed = Array.isArray(model.pipes) ? model.pipes.filter(p => p && p.provider) : [];
  if (listed.length > 0) {
    return listed.map(p => ({
      provider: String(p.provider),
      cli_model: p.cli_model != null && String(p.cli_model) !== '' ? String(p.cli_model) : undefined,
    }));
  }
  if (!model.provider) return [];
  return [{
    provider: String(model.provider),
    cli_model: model.cli_model != null && String(model.cli_model) !== ''
      ? String(model.cli_model)
      : (model.id != null ? String(model.id) : undefined),
  }];
}

/** 把模型 id 名单钉上每根管子。找不到的 id 丢掉（调用方应先做幽灵检查）。 */
export function attachPipes(ids, routingModels) {
  const byId = new Map();
  for (const m of routingModels || []) {
    if (m && m.id) byId.set(m.id, m);
  }
  const out = [];
  for (const id of ids || []) {
    const model = byId.get(id);
    if (!model) continue;
    const pipes = normalizePipes(model);
    if (pipes.length === 0) continue;
    out.push({ id, pipes });
  }
  return out;
}

/**
 * 过门闩后的模型序：JSON 顺位第一，否则配额/最高分那条队列。
 * 返回裸 id 数组；管子由 attachPipes 另钉。
 */
export function buildSlate({ passers, rankOrder, matchedRoute, quotaTop, byScore } = {}) {
  const passerIds = new Set((passers || []).map(d => d && d.model).filter(Boolean));
  const ordered = [];
  const push = (id) => {
    if (id && passerIds.has(id) && !ordered.includes(id)) ordered.push(id);
  };
  if (Array.isArray(rankOrder) && rankOrder.length > 0) {
    for (const id of rankOrder) push(id);
  } else if (matchedRoute) {
    push(matchedRoute.model);
    push(matchedRoute.fallback);
  }
  if (quotaTop) push(quotaTop.model);
  for (const d of byScore || []) push(d && d.model);
  return ordered;
}

function findSlateIndex(slate, modelId) {
  return (slate || []).findIndex(s => s && s.id === modelId);
}

/**
 * 下一步启动。
 * hardFailsOnThisPipe < 2 → 同一根重试（瞬时失败走这条：调用方不要把瞬时算进 hardFails）。
 * hardFailsOnThisPipe >= 2 → 切 pipes[1]；管子尽了换 slate 下一个模型的主路；名单走完才 fail。
 */
export function nextLaunch({ slate, modelId, pipeIndex, hardFailsOnThisPipe } = {}) {
  const models = Array.isArray(slate) ? slate : [];
  const idx = findSlateIndex(models, modelId);
  if (idx < 0) {
    return { action: 'fail', reason: 'model_not_in_slate', exhausted: true };
  }
  const entry = models[idx];
  const pipes = Array.isArray(entry.pipes) ? entry.pipes : [];
  const pi = Number(pipeIndex) || 0;
  const fails = Number(hardFailsOnThisPipe) || 0;

  if (fails < 2) {
    const pipe = pipes[pi] || null;
    return {
      action: 'retry',
      modelId,
      pipeIndex: pi,
      pipe,
    };
  }
  if (pi + 1 < pipes.length) {
    return {
      action: 'switch_pipe',
      modelId,
      pipeIndex: pi + 1,
      pipe: pipes[pi + 1],
    };
  }
  const next = models[idx + 1];
  if (next && next.id) {
    const nextPipes = Array.isArray(next.pipes) ? next.pipes : [];
    return {
      action: 'switch_model',
      modelId: next.id,
      pipeIndex: 0,
      pipe: nextPipes[0] || null,
    };
  }
  return { action: 'fail', reason: 'slate_exhausted', exhausted: true };
}

const HARD_RE = /cannot use this model|not available in your region|model[_ ]not[_ ]in[_ ]plan|login rejected|not logged in|unauthori[sz]ed|authentication required|please log in|not authenticated|quota|usage limit|out of credits|insufficient[\s\S]{0,24}(quota|credit)|model is disabled|\b402\b/i;
const TRANSIENT_RE = /timeout|timed out|econnreset|econnrefused|eai_again|enetunreach|socket|network|temporarily|\b503\b|\b502\b|\b504\b|at capacity|读了是空的|没读成/i;

/** 屏上拒模 / 区域不可用 / 额度见顶 / 登录没了。开工探针必须当失败，不能当 TUI 就绪。 */
export function isModelRejectText(text) {
  return HARD_RE.test(String(text || ''));
}

/**
 * 启动期失败分类。config = 错旗标/待确认/未配好（agent_unconfigured），不许拿来换管。
 * #661：agent_unconfigured（#649 实证：Cursor 弹 Workspace Trust 时 Orca 报的状态）
 * 是「这台机器没配好」，不是瞬时也不是选中错——立刻失败回滚，不试下一根管。
 */
export function classifyLaunchFailure({ error, verifyReason, text } = {}) {
  if (verifyReason === '有待确认提示') return 'config';
  if (verifyReason === '拒模') return 'hard';
  const blob = [error, verifyReason, text].filter(Boolean).join('\n');
  if (!blob) return 'hard';
  if (/agent[_ ]unconfigured/.test(blob)) return 'config';
  if (isModelRejectText(blob)) return 'hard';
  if (verifyReason === '读了是空的' || verifyReason === '没读成') return 'transient';
  if (TRANSIENT_RE.test(blob)) return 'transient';
  return 'hard';
}

/**
 * 一次失败后的状态推进。瞬时：同一根再试一次，不计入 hardFails。
 * 第二次瞬时按硬失败计。硬失败累加后交给 nextLaunch。
 */
export function advanceLaunchState({
  slate, modelId, pipeIndex, hardFailsOnThisPipe = 0, transientFailsOnThisPipe = 0, kind,
} = {}) {
  if (kind === 'config') {
    return { action: 'abort', reason: 'config', modelId, pipeIndex, hardFailsOnThisPipe, transientFailsOnThisPipe };
  }
  if (kind === 'transient' && transientFailsOnThisPipe < 1) {
    return {
      action: 'retry',
      modelId,
      pipeIndex,
      pipe: ((slate || []).find(s => s && s.id === modelId) || {}).pipes?.[pipeIndex] || null,
      hardFailsOnThisPipe,
      transientFailsOnThisPipe: transientFailsOnThisPipe + 1,
    };
  }
  const fails = hardFailsOnThisPipe + 1;
  const next = nextLaunch({ slate, modelId, pipeIndex, hardFailsOnThisPipe: fails });
  if (next.action === 'retry') {
    return { ...next, hardFailsOnThisPipe: fails, transientFailsOnThisPipe: 0 };
  }
  if (next.action === 'switch_pipe' || next.action === 'switch_model') {
    return { ...next, hardFailsOnThisPipe: 0, transientFailsOnThisPipe: 0 };
  }
  return { ...next, hardFailsOnThisPipe: fails, transientFailsOnThisPipe: 0 };
}

/**
 * 派工名单。live=true 时只接受已经过门闩的 slateIds；
 * 选型没查成必须 fail-close，不许回退到 routingSlateIds 的全表。
 * live=false 走路由表序：dry-run 预览用它；2026-08-23 async-launch 起显式 --model 的
 * 真派工也用它（打分整层删，bans 门闩过滤由调用方补）。--role 真派工必须 live:true。
 */
export function resolveDispatchSlate({
  live, selectOk, selectError, slateIds, routing, role, now, model,
} = {}) {
  let ids;
  if (live) {
    if (!selectOk) {
      return {
        ok: false,
        unscanned: true,
        error: selectError
          ? `选型没查成：${selectError}`
          : '选型没查成，不许回退到未过门闩的全模型名单',
      };
    }
    if (!Array.isArray(slateIds) || slateIds.length === 0) {
      return { ok: false, error: '选型 slate 是空的（没查成）' };
    }
    ids = slateIds;
  } else {
    ids = routingSlateIds({ routing, role, now, model });
  }
  const slate = attachPipes(ids, routing?.models);
  if (!slate.length) return { ok: false, error: 'slate 是空的（没查成）' };
  const startIndex = model ? slate.findIndex(s => s.id === model) : 0;
  if (startIndex < 0) {
    return { ok: false, error: `模型 ${model} 不在预计算名单里，禁止现场另点` };
  }
  return { ok: true, slate, startIndex };
}

/** 路由第一、其余按表序。dry-run 预览与显式 --model 真派工用它（async-launch）；--role 真派工必须走过门闩的 slate。 */
export function routingSlateIds({ routing, role, now, model } = {}) {
  const models = Array.isArray(routing?.models) ? routing.models : [];
  const known = new Set(models.map(m => m && m.id).filter(Boolean));
  const ids = [];
  const push = (id) => {
    if (id && known.has(id) && !ids.includes(id)) ids.push(id);
  };
  if (role && Array.isArray(routing?.routes)) {
    const ts = now instanceof Date ? now.toISOString() : now;
    const minute = beijingMinute(ts);
    for (const r of routing.routes) {
      if (!r || r.role !== role || !r.beijing) continue;
      if (beijingWindowsHit(r.beijing, minute)) {
        push(r.model);
        push(r.fallback);
        break;
      }
    }
  }
  push(model);
  for (const m of models) push(m && m.id);
  return ids;
}

function beijingMinute(ts) {
  if (ts == null) return 0;
  const d = ts instanceof Date ? ts : new Date(ts);
  if (Number.isNaN(d.getTime())) return 0;
  const bj = new Date(d.getTime() + 8 * 3600000);
  return bj.getUTCHours() * 60 + bj.getUTCMinutes();
}

function beijingWindowsHit(beijing, minute) {
  return String(beijing).split(',').some((part) => {
    const [a, b] = part.trim().split('-');
    if (!a || !b) return false;
    const hm = (x) => {
      const [h, m] = x.split(':').map(Number);
      return h * 60 + m;
    };
    const start = hm(a);
    const end = hm(b);
    return minute >= start && minute < end;
  });
}
