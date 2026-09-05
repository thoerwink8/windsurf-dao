// scripts/lib/check-budget.mjs —— 单套测试的耗时预算（棘轮）
//
// 来历（2026-09-06 用户问「后面是不是就不会出现同样的问题了」）：
// 那天堵了三个具体的洞——测试打外网、新测试不入图、spawn 总量失控——但
// **「新机制必须是快的」这条标准本身没有闸**。加检查永远只有收益没有代价，
// 于是 144 项、100 秒就是这么长出来的：每一项加进来的时候都「只慢了一点点」。
//
// 棘轮怎么工作：
//   · 没登记的套（＝新加的）超 NEW_SUITE_BUDGET_MS 就红 —— 新机制默认必须快
//   · 已登记的历史欠账各有各的天花板，只许降不许升 —— 变慢就红
//   · 改快了要**把登记的数字改小**，那一步是显式的，等于记一笔账
//
// 为什么不是「全部一刀切 1.5 秒」：那会让存量 5 套天天红，红久了就没人看
// （本仓判例：把误报降级常常等于把守卫关掉）。棘轮只拦「变得更糟」，不拦历史。
//
// 天花板 = 实测中位 × 1.6，留够抖动余量。机器忙时会波动，太紧的闸是噪音制造机。

/**
 * 新增测试套的耗时上限。
 *
 * 3 秒是按行业通行口径定的，不是拍脑袋：**「毫秒级」说的是单个测试**
 * （0.1s 的单测已经算慢），而**一个测试文件跑几十条、几秒是正常的**。
 * 拿单测标准去卡文件，只会逼着人把文件拆碎或把闸关掉。
 *
 * 2026-09-06 首版定 1500ms，当场十条红——过严的闸和没有闸等价，
 * 因为红久了没人看（本仓判例：把误报降级常常等于把守卫关掉）。
 */
export const NEW_SUITE_BUDGET_MS = 3000;

/**
 * 历史欠账登记：套名 → 当前天花板（ms）。**只许改小**。
 * 改大等于给自己发免死金牌，真要改大必须在 PR 正文说明为什么这次合理。
 *
 * **基线必须在闸自己跑的那个条件下测**——2026-09-06 首版拿串行数字 ×1.6 建表，
 * 而 dao-check 跑的是池宽 6，同一套在池里能慢 1.7 倍（dao-mode 串行 5.5s / 池里 8.9s），
 * 于是闸从上线第一天就在报假红。现在这张表取自池宽 6 实测 × 1.4 余量。
 *
 * 目标是 TIA 第二刀（spawn → 进程内）之后整表大幅下调。
 */
export const REGISTERED_SLOW = {
  'dao.test.js': 29600,
  'dao-mode.test.js': 12200,
  'dispatch-gate.test.js': 10300,
  'preflight-timeout.test.js': 9700,
  'reviewer-vendor-gate.test.js': 8100,
  'dispatch-launch.test.js': 5800,
  'agent-stall-watch.test.js': 5200,
  'land.test.js': 4700,
  'dianjiangtai.test.js': 4300,
  'session-audit.test.js': 4200,
  'handoff-check.test.js': 3700,
  'release-train.test.js': 3100,
  'board-gc.test.js': 3000,
  'dispatch-batch.test.js': 3000,
  'feishu-triage.test.js': 3000,
};

/**
 * 硬红的倍数门槛。
 *
 * **墙钟在有负载的机器上不是稳定信号**——2026-09-06 实测：同一套 agent-stall-watch
 * 两次跑分别是 3.7s 和 7.7s，差一倍；那会儿这台 6 核机 load average 5.09
 * （同时跑着几个 agent）。按 1 倍阈值硬红，闸就会随机报假红，
 * 而随机报假红的闸最后一定会被关掉。
 *
 * 所以按业界对性能闸的通行做法分两档：
 *   · 超过天花板 → **可见提示**（趋势信号，不拦）
 *   · 超过天花板 × GROSS_FACTOR → **红**（成倍恶化，负载解释不了）
 * 确定性的量（spawn 数）走硬闸，那条在 lib/spawn-budget.mjs。
 */
export const GROSS_FACTOR = 3;

/**
 * @param {{file:string,ms:number}[]} durations 本轮实际跑了的套 + 各自墙钟
 * @returns {{state:'ok'|'red'|'unknown', detail:string, notes?:string[]}}
 */
export function classifyDurations(durations) {
  if (!Array.isArray(durations)) return { state: 'unknown', detail: '耗时数据不是数组（没查成）' };
  if (durations.length === 0) {
    // 「一套都没跑」可能是裁剪后 0 套（合理），也可能是采集坏了（不合理）。
    // 这里分不出来，所以交给调用方：跑了 0 套时根本不该调本函数。
    return { state: 'unknown', detail: '没有耗时样本——没查成，不是「都很快」' };
  }
  const gross = [];
  const notes = [];
  for (const d of durations) {
    const ms = Number(d && d.ms);
    if (!Number.isFinite(ms)) continue;      // 单套没测到就跳过，不拿它冒充合格
    const cap = REGISTERED_SLOW[d.file] ?? NEW_SUITE_BUDGET_MS;
    const isNew = REGISTERED_SLOW[d.file] == null;
    if (ms > cap * GROSS_FACTOR) {
      gross.push(`${d.file} ${ms}ms 是${isNew ? `新套上限 ${cap}` : `登记天花板 ${cap}`}ms 的 ${(ms / cap).toFixed(1)} 倍——负载解释不了，查回归`);
    } else if (ms > cap) {
      notes.push(`${d.file} ${ms}ms > ${isNew ? `新套上限 ${cap}` : `天花板 ${cap}`}ms`);
    }
  }
  const measured = durations.filter((d) => Number.isFinite(Number(d.ms))).length;
  if (gross.length) return { state: 'red', detail: gross.join('；'), notes };
  const tail = notes.length
    ? `；${notes.length} 套轻微超标（负载抖动，只提示不拦）：${notes.slice(0, 3).join('、')}${notes.length > 3 ? ' …' : ''}`
    : '';
  return {
    state: 'ok',
    notes,
    detail: `${measured} 套耗时在预算内（新套上限 ${NEW_SUITE_BUDGET_MS}ms，${Object.keys(REGISTERED_SLOW).length} 套历史欠账各有天花板，超 ${GROSS_FACTOR} 倍才判红）${tail}`,
  };
}
