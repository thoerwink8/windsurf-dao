// scripts/lib/reviewer-vendor-gate.mjs —— 起审官同厂硬闸（#679）
//
// 纯函数。输入 = 工人模型 id + 审官模型 id + 路由表 models。
// 输出三态分开：通过 / 同厂拒绝 / 没查成。
// 不读点将台打分，不复用「已经选好了」当判据。
//
// #843（过渡措施 2026-09-03）修 #822/#828 埋的洞：判「同厂」按**模型家族/网关后面的
// 真实供应商**（vendorFamilyOf），不是 provider 字段。#828 收拢后 provider 是**网关落地 id**
// （gw / gw-windsurf / gpt / pqapi…，供 launch 用），一个 gw 后面挂着多家真实供应商——
// grok(xAI)、gpt-luna(OpenAI)、glm(智谱)、kimi(月之暗面)、deepseek。工人全切 gw 后
// 用 provider 判会把 grok 工人与 luna 审官误判成同厂拒绝（见 docs/decisions/2026-09-03-all-pi-gw.md
// 「已知后果」，那单明写「要修另开单」——本单就是那张单）；反过来 gpt-sol(provider gpt) 与
// gpt-luna(provider gw) 是同一家 OpenAI 却会被误判成跨厂放行。真实厂商只认模型家族。
// provider（网关落地）仍随结果返回，只作诊断，不作判据。

// 已知真实供应商家族（网关后面那一家）。模型 id 以 `家族[-版本…]` 命名，取前缀即家族。
// 新增一家真实供应商要在这里登记；漏登记 → 家族没查成 → unscanned（挡住、报警），不静默放行。
const VENDOR_FAMILIES = [
  'gpt',      // OpenAI（sol 直连 codex、luna 经 gw-windsurf，同属 OpenAI）
  'claude',   // Anthropic
  'grok',     // xAI
  'kimi',     // 月之暗面 Moonshot
  'glm',      // 智谱 Zhipu
  'gemini',   // Google
  'deepseek', // DeepSeek
  'composer', // Cursor Composer
  'ox',       // opencode
  'devin',    // Cognition Devin（封装层，已退役）
];

/** 模型 id → 真实供应商家族（网关后面那一家）。查不出 → null（调用方按 unscanned 处置，不许猜）。 */
export function vendorFamilyOf(modelId) {
  if (modelId == null) return null;
  const id = String(modelId).trim().toLowerCase();
  if (!id) return null;
  for (const fam of VENDOR_FAMILIES) {
    if (id === fam || id.startsWith(fam + '-')) return fam;
  }
  return null;
}

export function providerOf(modelId, models) {
  if (!Array.isArray(models)) return { ok: false, state: 'unscanned', error: '路由表没查成（没拿到 models）' };
  if (modelId == null || String(modelId).trim() === '') {
    return { ok: false, state: 'unscanned', error: '模型 id 没查成' };
  }
  const id = String(modelId).trim();
  const hit = models.find(m => m && m.id === id);
  if (!hit) return { ok: false, state: 'unscanned', error: `模型 ${id} 不在路由表（没查成厂商）` };
  if (hit.provider == null || String(hit.provider).trim() === '') {
    return { ok: false, state: 'unscanned', error: `模型 ${id} 在路由表没查成厂商` };
  }
  return { ok: true, id, provider: String(hit.provider).trim() };
}

/**
 * 判据厂商：家族优先，注册表回落（#895）。
 *
 * 改这段前必须知道：「厂商可查」与「是派单候选」是两件事，从前混成一张表——models 由
 * modelsFromJson() 从职责树（工人/审官/帅）派生，职责树是**派单候选表**。于是只要执行者
 * 不是派单候选（帅位本体就是这种：#822 把 claude CLI 从选型移除），厂商就永远「没查成」、
 * 同厂闸永远拒，快马单起不了审官（#890 至今零审查的机械原因）。
 * 而 id 命名即家族，vendorFamilyOf('claude-opus-5') 本来就查得出 claude。
 *
 * 顺序：先 vendorFamilyOf(id)；查不出家族才回落注册表（落地 provider 本身是已登记家族时才认，
 * gw/pqapi 这类网关 id 不是家族）。两条都查不出 → 仍 fail-closed：挡住报警，不许猜。
 */
export function resolveVendor(modelId, models) {
  if (modelId == null || String(modelId).trim() === '') {
    return { ok: false, state: 'unscanned', error: '模型 id 没查成' };
  }
  const id = String(modelId).trim();
  const reg = providerOf(id, models); // 网关落地：仅诊断 + 家族回落源，不作判据
  const provider = reg.ok ? reg.provider : null;
  const fam = vendorFamilyOf(id);
  if (fam) {
    return { ok: true, id, vendor: fam, vendorSource: 'family', provider, registered: reg.ok };
  }
  const byProvider = provider ? vendorFamilyOf(provider) : null;
  if (byProvider) {
    return { ok: true, id, vendor: byProvider, vendorSource: 'registry', provider, registered: true };
  }
  return {
    ok: false,
    state: 'unscanned',
    id,
    provider,
    registered: reg.ok,
    error: reg.ok
      ? `模型 ${id} 没查成真实供应商家族（id 前缀未登记 VENDOR_FAMILIES，注册表落地 ${provider} 也不是家族，不许猜）`
      : `模型 ${id} 没查成真实供应商家族（id 前缀未登记 VENDOR_FAMILIES，路由表也没有，不许猜）`,
  };
}

/**
 * 工人与审官不得同厂。
 * @returns {{
 *   ok: boolean,
 *   state: 'pass'|'same_vendor'|'unscanned',
 *   error?: string,
 *   workerId?: string,
 *   reviewerId?: string,
 *   workerVendor?: string,     // 真实供应商家族——判据
 *   reviewerVendor?: string,
 *   workerProvider?: string,   // 网关落地 id——仅诊断，不作判据
 *   reviewerProvider?: string,
 * }}
 */
export function assertCrossVendor({ workerId, reviewerId, models } = {}) {
  if (!Array.isArray(models)) {
    return { ok: false, state: 'unscanned', error: '路由表没查成（没拿到 models）' };
  }
  if (workerId == null || String(workerId).trim() === '') {
    return { ok: false, state: 'unscanned', error: '工人模型 id 没查成' };
  }
  if (reviewerId == null || String(reviewerId).trim() === '') {
    return { ok: false, state: 'unscanned', error: '审官模型 id 没查成' };
  }
  // 判据 = 真实供应商家族（网关后面那一家），家族优先、注册表回落（#895）。
  // 不再要求「必须是派单候选」——但家族查不出照旧 unscanned（fail-closed，不许猜）。
  const worker = resolveVendor(workerId, models);
  if (!worker.ok) {
    return { ok: false, state: 'unscanned', error: `工人：${worker.error || '没查成厂商'}` };
  }
  const reviewer = resolveVendor(reviewerId, models);
  if (!reviewer.ok) {
    return { ok: false, state: 'unscanned', error: `审官：${reviewer.error || '没查成厂商'}` };
  }
  const workerVendor = worker.vendor;
  const reviewerVendor = reviewer.vendor;
  if (workerVendor === reviewerVendor) {
    return {
      ok: false,
      state: 'same_vendor',
      error: `工人 ${worker.id} 与审官 ${reviewer.id} 同厂（真实供应商 ${workerVendor}；网关落地 ${worker.provider || '没查成'}/${reviewer.provider || '没查成'}），审查必须换厂商`,
      workerId: worker.id,
      reviewerId: reviewer.id,
      workerVendor,
      reviewerVendor,
      workerProvider: worker.provider,
      reviewerProvider: reviewer.provider,
    };
  }
  return {
    ok: true,
    state: 'pass',
    workerId: worker.id,
    reviewerId: reviewer.id,
    workerVendor,
    reviewerVendor,
    workerProvider: worker.provider,
    reviewerProvider: reviewer.provider,
  };
}

/**
 * 派工名单预先剔除与审官同厂的候选，fallback 才不会落到同厂。
 * 路由表 / 审官 / 某条候选没查成厂商 → unscanned，不静默跳过。
 */
export function filterSlateSameVendor({ slate, reviewerId, models, startIndex = 0 } = {}) {
  if (!Array.isArray(slate)) {
    return { ok: false, state: 'unscanned', error: 'slate 没查成' };
  }
  if (!Array.isArray(models)) {
    return { ok: false, state: 'unscanned', error: '路由表没查成（没拿到 models）' };
  }
  const requested = slate[startIndex] && slate[startIndex].id;
  const kept = [];
  const dropped = [];
  for (const entry of slate) {
    if (!entry || entry.id == null || String(entry.id).trim() === '') {
      return { ok: false, state: 'unscanned', error: 'slate 条目模型 id 没查成', dropped };
    }
    const gate = assertCrossVendor({ workerId: entry.id, reviewerId, models });
    if (gate.state === 'unscanned') {
      return { ok: false, state: 'unscanned', error: gate.error, dropped };
    }
    if (gate.state === 'same_vendor') {
      dropped.push(entry.id);
      continue;
    }
    kept.push(entry);
  }
  if (kept.length === 0) {
    return {
      ok: false,
      state: 'same_vendor',
      error: `派工名单剔除与审官同厂的候选后空了（审官 ${reviewerId}）`,
      dropped,
    };
  }
  if (requested != null && String(requested).trim() !== '') {
    const newStart = kept.findIndex(s => s.id === requested);
    if (newStart < 0) {
      return {
        ok: false,
        state: 'same_vendor',
        error: `请求模型 ${requested} 与审官同厂，已从名单剔除`,
        dropped,
      };
    }
    return { ok: true, state: 'pass', slate: kept, startIndex: newStart, dropped };
  }
  return { ok: true, state: 'pass', slate: kept, startIndex: 0, dropped };
}

/** 实际启动的工人（含 split 每个子工人）逐一过同厂闸。 */
export function assertLaunchedWorkers({ workerIds, reviewerId, models } = {}) {
  if (workerIds == null) {
    return { ok: false, state: 'unscanned', error: '实际工人模型列表没查成' };
  }
  if (!Array.isArray(workerIds) || workerIds.length === 0) {
    return { ok: false, state: 'unscanned', error: '实际工人模型 id 没查成' };
  }
  for (const workerId of workerIds) {
    const gate = assertCrossVendor({ workerId, reviewerId, models });
    if (!gate.ok) return { ...gate, workerId };
  }
  return { ok: true, state: 'pass', workerIds, reviewerId };
}

/**
 * 实际工人模型：只认 Dispatch/任务元数据或唯一 model/* 标签。
 * 不读卡名。两边都没有 → unscanned；扫完 0 条 / 多条 → 分开的失败态。
 */
export function resolveActualWorkerModel({ dispatchModel, labels } = {}) {
  const fromDispatch = dispatchModel == null ? '' : String(dispatchModel).trim();
  if (fromDispatch) {
    return { ok: true, source: 'dispatch', modelId: fromDispatch };
  }
  if (labels == null) {
    return {
      ok: false,
      state: 'unscanned',
      error: '没查成工人实际模型（无 Dispatch/任务元数据、无 model/* 标签）',
    };
  }
  if (!Array.isArray(labels)) {
    return { ok: false, state: 'unscanned', error: '工人 model/* 标签没查成（不是列表）' };
  }
  const hits = labels
    .map((x) => {
      if (typeof x === 'string') return x;
      if (x && typeof x.name === 'string') return x.name;
      return '';
    })
    .filter((name) => name.startsWith('model/') && name.length > 'model/'.length);
  if (hits.length === 0) {
    return { ok: false, state: 'none', error: '扫完没有唯一 model/*，不许从卡名猜' };
  }
  if (hits.length > 1) {
    return {
      ok: false,
      state: 'many',
      error: `有多个 model/*（${hits.join('、')}），不许猜一个、不许从卡名猜`,
    };
  }
  return { ok: true, source: 'label', modelId: hits[0].slice('model/'.length) };
}
