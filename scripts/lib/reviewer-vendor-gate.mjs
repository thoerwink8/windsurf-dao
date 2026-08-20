// scripts/lib/reviewer-vendor-gate.mjs —— 起审官同厂硬闸（#679）
//
// 纯函数。输入 = 工人模型 id + 审官模型 id + 路由表 models。
// 输出三态分开：通过 / 同厂拒绝 / 没查成。
// 不读点将台打分，不复用「已经选好了」当判据——厂商只从路由表 [[models]].provider 当场查。

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
 * 工人与审官不得同厂。
 * @returns {{
 *   ok: boolean,
 *   state: 'pass'|'same_vendor'|'unscanned',
 *   error?: string,
 *   workerId?: string,
 *   reviewerId?: string,
 *   workerProvider?: string,
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
  const worker = providerOf(workerId, models);
  if (!worker.ok) {
    return { ok: false, state: 'unscanned', error: `工人：${worker.error || '没查成厂商'}` };
  }
  const reviewer = providerOf(reviewerId, models);
  if (!reviewer.ok) {
    return { ok: false, state: 'unscanned', error: `审官：${reviewer.error || '没查成厂商'}` };
  }
  if (worker.provider === reviewer.provider) {
    return {
      ok: false,
      state: 'same_vendor',
      error: `工人 ${worker.id} 与审官 ${reviewer.id} 同厂（${worker.provider}），审查必须换厂商`,
      workerId: worker.id,
      reviewerId: reviewer.id,
      workerProvider: worker.provider,
      reviewerProvider: reviewer.provider,
    };
  }
  return {
    ok: true,
    state: 'pass',
    workerId: worker.id,
    reviewerId: reviewer.id,
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
