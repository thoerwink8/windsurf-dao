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
