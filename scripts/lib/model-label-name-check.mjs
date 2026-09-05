// dao-check：model/* label 名必须能被 vendorFamilyOf 解析（#895）。
//
// 改这段前必须知道：worker-done 的 pickModel(labels) 从 `model/<id>` label 读工人模型，
// 同厂闸再拿这个 id 查真实供应商家族（vendorFamilyOf：id 命名即家族）。label 名字和家族
// 命名规则一旦对不上（本仓实咬：`model/opus-5` 缺 `claude-` 前缀），家族必查不出 →
// 同厂闸 unscanned → 任何用它的单都起不了审官（#890 至今零审查）。
// 规矩不配检查等于没有：这道检查就是那口哨。
//
// 本检查器**故意** import vendorFamilyOf——被查对象是 label 名字，判官是家族解析器本身，
// 自持一份正则副本反而会两边漂移（与 reviewer-vendor-gate-check.mjs 的「不 import 被查
// 对象」不同：那边查的是闸的接线，判官不能是闸自己）。

import { vendorFamilyOf } from './reviewer-vendor-gate.mjs';

export const MODEL_LABEL_PREFIX = 'model/';

function labelNameOf(item) {
  if (typeof item === 'string') return item;
  if (item && typeof item === 'object' && typeof item.name === 'string') return item.name;
  return '';
}

/**
 * 纯判官：给一份 label 名单，挑出 `model/*` 里家族查不出的名字。
 * 没拿到名单 / 扫到 0 个 model/* → unscanned（没查成，不是「都合规」）。
 * @returns {{ ok: boolean, unscanned: boolean, error?: string, scanned?: number, bad?: string[] }}
 */
export function inspectModelLabelNames({ labelNames } = {}) {
  if (!Array.isArray(labelNames)) {
    return { ok: false, unscanned: true, error: '没给 label 名单（没查成，不许当都合规）' };
  }
  const names = labelNames.map(labelNameOf).filter(Boolean);
  const models = names.filter(
    n => n.startsWith(MODEL_LABEL_PREFIX) && n.length > MODEL_LABEL_PREFIX.length,
  );
  if (models.length === 0) {
    return { ok: false, unscanned: true, error: '扫到 0 个 model/* label（没查成，不是都合规）' };
  }
  const bad = [];
  for (const name of models) {
    const id = name.slice(MODEL_LABEL_PREFIX.length);
    if (!vendorFamilyOf(id)) bad.push(name);
  }
  return { ok: bad.length === 0, unscanned: false, scanned: models.length, bad };
}
