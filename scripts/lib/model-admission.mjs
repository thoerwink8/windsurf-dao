// scripts/lib/model-admission.mjs —— 「这个模型现在还能不能派」的模型准入名单（纯函数）
//
// 从 commander.mjs 里搬出来（2026-09-10），因为它是**唯一**进 assessDispatchModel 的
// redIds 来源，判据错一次就是全盘派不出单——这种判据必须能单测，不能埋在 1500 行的脚本里。
//
// 归口规则（三层，别混）：
//   ① 选型表里**有落地**（provider/cli_model）的模型 → 归健康表 + 熔断表；
//   ② 没有落地、只能靠某个 execution profile 跑的（profile id 本身也算）→ 归 profile 的
//      availability：enabled 且 status==='available' 才放行；
//   ③ 两边都不沾的 → 不拦（unknown 不拦，与 #842 口径一致）。
//
// 2026-09-10 实咬（旧判据把 ①②混成一条）：对**所有**被 defaultForModels 提到的模型一律按
// profile 判，于是一个 profile 的 unverified 就把同模型在别处的在役腿一起冻掉——grok-4.6 的
// 选型落地明明是 gw/grok-4.6（健康表绿、实测在役），却因为另有一个未验的原生 profile 被标红；
// 当时 28 个模型里 25 个红，指挥官的差集重派 11 张单全被挡成 escalate，机器空转。
//
// 熔断为什么必须收进来：commander-core 的模型准入只看这份 redIds（assessDispatchModel），
// 熔断器另有一条路管**渠道**，而模型这一层原先没有。反例实咬：gpt-5.6-sol 的 codex 直连
// （pqapi 500）熔断中，它此前是靠「对应 profile 未验」被间接拦住的——归口拆开后会漏过去。
// 所以按 probeTargetForModel 把熔断 open 且未到冷却的模型一并算红。

import { availabilityFor, probeTargetForModel } from './provider-health.mjs';

const hasLanding = (m) => m && m.provider != null && String(m.provider).trim() !== '';

/**
 * @param {object} input
 * @param {Array}  input.models      modelsFromJson 形态（id / provider / cli_model / …）
 * @param {Array}  input.profiles    execution profiles（id / enabled / availability / defaultForModels）
 * @param {object} input.breaker     loadBreaker() 的返回（{ok, targets}）
 * @param {number} input.now         当前时刻（冷却判定用，便于测试注入）
 * @param {Function} input.availabilityForFn  注入点，默认真实现
 * @returns {string[]} 判定为「现在不派」的模型 id
 */
export function healthRedIds({ models, profiles = [], breaker = null, now = Date.now(), availabilityForFn = availabilityFor } = {}) {
  if (!Array.isArray(models) || models.length === 0) return [];
  const list = Array.isArray(profiles) ? profiles : [];
  const mapped = new Map(list.flatMap((p) => [p.id, ...(p.defaultForModels || [])].map((id) => [id, p])));


  const profileOnly = models.filter((m) => !hasLanding(m));
  const mappedIds = new Set(profileOnly.filter((m) => mapped.has(m.id)).map((m) => m.id));

  // ② profile 归口：没验过 / 停用 → 红。只对「没有落地」的 id 生效。
  const profileRed = profileOnly
    .filter((m) => mapped.has(m.id))
    .filter((m) => {
      const p = mapped.get(m.id);
      return p.enabled !== true || (p.availability?.status || p.availability) !== 'available';
    })
    .map((m) => m.id);

  // ① 健康表归口：喂「探针认得出的条目」，但**跳过已由 profile 管的 id**——
  // 那些 id 的落地是 profile 自己（如 cli_model 写成模型名），探针探不着，
  // 让它进健康表只会把「探针认不出」误读成红。
  let healthRed = new Set();
  try {
    const probeable = models.filter((m) => !mappedIds.has(m.id));
    // now 必须传下去：健康表/熔断里的 cooldown 也按同一时刻判，否则注入的 now 只管一半，
    // 测试里「冷却已过」的用例会被探针那条路按真实时间判成仍红（写这套测试时当场撞到）。
    const r = availabilityForFn(probeable, { now });
    healthRed = new Set(Object.entries(r.availability || {})
      .filter(([, v]) => v !== '空闲')
      .map(([id]) => id));
  } catch {
    healthRed = new Set(); // 表没查成不拦（与 #842 unknown 不拦一致）
  }

  // ③ 熔断归口：按模型自己的探针 key 查，open 且未到冷却 = 红。对所有认得出 key 的模型生效。
  const breakerRed = new Set();
  if (breaker && breaker.ok && breaker.targets && typeof breaker.targets === 'object') {
    for (const m of models) {
      const target = probeTargetForModel(m);
      if (!target) continue;
      const st = breaker.targets[target];
      if (!st || st.state !== 'open') continue;
      const until = Number(st.cooldownUntil) || Date.parse(st.cooldownUntil);
      if (Number.isFinite(until) && until <= now) continue; // 冷却已过，放行半开
      breakerRed.add(m.id);
    }
  }

  return [...new Set([...profileRed, ...healthRed, ...breakerRed])];
}
