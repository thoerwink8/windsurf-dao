// 健康表纯函数（#967 从 /home/orca/bin 收进本仓）：把三类探测结果合成 ~/.dao/provider-health.json，
// 供编排层（#842）判供应商可用性。全是纯函数——真发请求、读盘写盘在 scripts/gw-remote-probe.mjs，
// 这里只做「结果 → 表」的确定性变换，好用夹具锁住 unscanned 传播、strikes 计数、过期判定这三处易错逻辑。
//
// 契约（改字段要同改消费端 scripts/lib/provider-health.mjs）：
//   { updatedAt, intervalMin, targets: { <key>: { kind, state, code, ms, lastGreenAt, strikes, why } } }
//   state 三态：green | red | unscanned —— unscanned 是「没探成」，既不是绿也不是红（§66）。

// 群里说人话（用户 2026-09-04 拍板，windsurf-dao 落地清单第 9 步）：内部 key（gw:gptpool/gpt-5.6、
// leg:WindsurfAPI、direct:codex）换成用户听得懂的名字；技术原因（HTTP 码/超时）只留 journal，
// 群里一句「连 N 次没回真内容」。三行体：出了什么事 / 影响 / 我打算。
export function plainTarget(key) {
  const k = String(key);
  if (k.startsWith('gw:')) { const g = k.slice(3).split('/')[0]; return `${g.replace(/pool$/, '')} 模型池`; }
  if (k.startsWith('leg:')) return `${k.slice(4)} 这条线`;
  if (k.startsWith('direct:') || k === 'codex') return 'codex 审官直连';
  return k;
}
export function buildRedAlert(bad, plan) {
  const names = bad.map(b => plainTarget(b.key));
  const kinds = new Set(bad.map(b => String(b.key).split(':')[0]));
  const impact = [];
  if (kinds.has('gw')) impact.push('整个池的备选链都不通，走它的工人和审官会卡');
  if (kinds.has('leg')) impact.push('单条线不通，走池的还有兜底');
  if (kinds.has('direct') || kinds.has('codex')) impact.push('codex 审官那条路不通');
  return `网关有 ${bad.length} 条线路连续 ${plan.strikesToAlert} 次没回真内容：${names.join('、')}
影响：${impact.join('；')}
我打算：${plan.intervalMin} 分钟后自动再探；还红我去查那家账号和额度。要不要先把它从首选摘掉，你说一句就行。`;
}

// 三态里只有 red 累计 strikes：unscanned（没探成）不能算连红，否则 HK 口一断就误报一串「连红」。
export function foldTarget(prev, result, nowIso) {
  const p = prev || {};
  const state = result.state;
  const strikes = state === 'red' ? (p.strikes || 0) + 1 : 0;
  const lastGreenAt = state === 'green' ? nowIso : (p.lastGreenAt || null);
  return {
    kind: result.kind,
    state,
    code: result.code ?? null,
    ms: result.ms ?? null,
    lastGreenAt,
    strikes,
    why: result.why || '',
  };
}

// legs.json 过期判定：HK 那份若比 factor×intervalMin 还旧，说明 HK 侧写表停了（timer 挂/机器重装），
// 旧值不可信——按「没探成」算 unscanned，不拿陈旧的绿冒充现在能用。
export function isStale(updatedAtIso, nowMs, intervalMin, factor = 2) {
  if (!updatedAtIso) return true;
  const t = Date.parse(updatedAtIso);
  if (!Number.isFinite(t)) return true;
  return nowMs - t > factor * intervalMin * 60_000;
}

// 合并 leg 三态：Contabo 读不到 HK 的 legs.json（口关了/网断/文件缺/过期）→ 全部 unscanned（不是红、不报警）；
// 读到了但某条腿不在表里 → 该腿 unscanned；正常 → 按 HK 给的 state/code/ms，why 本地按码合成（公开口不带报错正文）。
// legsDoc 形如 { updatedAt, legs: { <nameLike>: { state, code, ms } } }。
export function mergeLegHealth(legs, legsDoc, nowMs, intervalMin, staleFactor = 2) {
  const out = {};
  const unreachable = !legsDoc || !legsDoc.legs;
  const stale = !unreachable && isStale(legsDoc.updatedAt, nowMs, intervalMin, staleFactor);
  for (const leg of legs) {
    if (unreachable) {
      out[leg.key] = { kind: 'leg', state: 'unscanned', code: null, ms: null, why: '读不到 HK 逐腿口（legs.json 不可达）' };
      continue;
    }
    if (stale) {
      out[leg.key] = { kind: 'leg', state: 'unscanned', code: null, ms: null, why: `HK 逐腿表已过期（更新于 ${legsDoc.updatedAt}）` };
      continue;
    }
    const r = legsDoc.legs[leg.nameLike];
    if (!r) {
      out[leg.key] = { kind: 'leg', state: 'unscanned', code: null, ms: null, why: 'HK 逐腿表里没有这条腿' };
      continue;
    }
    const state = r.state === 'green' ? 'green' : r.state === 'unscanned' ? 'unscanned' : 'red';
    const why = state === 'green' ? `渠道测试通过（${r.ms ?? '?'}ms）`
      : state === 'unscanned' ? (r.why || 'HK 侧未探成')
      : `渠道测试未通过（HTTP ${r.code ?? '无响应'}）`;
    out[leg.key] = { kind: 'leg', state, code: r.code ?? null, ms: r.ms ?? null, why };
  }
  return out;
}

// 把本轮所有 target 的原始结果（{key,kind,state,code,ms,why}）折进上一份表，产出新表。
// prevTable 提供 strikes/lastGreenAt 的历史；results 里没出现的 key（如 --only 只探一个）原样保留旧值。
export function buildHealthTable(prevTable, results, intervalMin, nowIso) {
  const prevTargets = (prevTable && prevTable.targets) || {};
  const targets = { ...prevTargets };
  for (const r of results) targets[r.key] = foldTarget(prevTargets[r.key], r, nowIso);
  return { updatedAt: nowIso, intervalMin, targets };
}

// 报警集合从表算（连红达阈值且没报过 → 新报；报过的现在不红了 → 恢复）。unscanned 不参与，
// 与旧脚本「连红两轮才喊」同义，只是键从「组」变成「target key」。
export function computeAlerts(table, prevAlerted, strikesToAlert) {
  const alerted = new Set(prevAlerted || []);
  const nowRed = Object.entries(table.targets).filter(([, v]) => v.state === 'red').map(([k]) => k);
  const nowRedSet = new Set(nowRed);
  const newlyBad = nowRed.filter(k => (table.targets[k].strikes || 0) >= strikesToAlert && !alerted.has(k));
  const recovered = [...alerted].filter(k => !nowRedSet.has(k));
  // 下一轮的 alerted：已报过的里仍红的 + 本轮新报的
  const nextAlerted = [...new Set([...alerted, ...newlyBad])].filter(k => nowRedSet.has(k));
  return { newlyBad, recovered, nowRed, nextAlerted };
}
