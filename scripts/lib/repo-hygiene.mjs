// scripts/lib/repo-hygiene.mjs —— 仓库卫生判据（用户 2026-09-19：「主分支都有待合入或待拉取的，应该要有制度保证」）。
//
// 纯函数：**只判，不读盘、不联网**。三态（绿 / 红 / 没查成）——「没查成」永远不是绿。
// 两条判据对应两种真实病：
//   ① 机器漂移：某台机器上的仓 ahead（有未推）或 behind（有未拉）→ 别处拉不到 / 跑的是旧码。
//   ② PR 积压：开放 PR 太多、太老、或有冲突 → 审查容量被旧账吃掉（2026-09-19 实测积到 17 个、最老 14.6 天）。
//
// 阈值是**配置**不是常量：`docs/release-policy.json` 的 `hygiene` 段（缺省值在这里，改了要同一次提交改文档）。

export const HYGIENE_DEFAULTS = Object.freeze({
  maxOpenPrs: 6,
  maxOldestPrDays: 2,
});

const int = v => Number.isSafeInteger(v);

/** 一台机器上一个仓的漂移。`mustBeClean` 给部署树（服务器主树）用：它不该有未提交改动。 */
export function judgeRepoDrift(input = {}) {
  const { ahead, behind, dirty = 0, mustBeClean = false } = input || {};
  if (!int(ahead) || !int(behind) || !int(dirty)) {
    return { state: 'unscanned', why: 'git 计数读不到（没查成，不是同步）' };
  }
  if (ahead > 0) return { state: 'red', why: `有 ${ahead} 笔未推——别的机器拉不到` };
  if (behind > 0) return { state: 'red', why: `落后 ${behind} 笔未拉——跑的是旧码` };
  if (mustBeClean && dirty > 0) return { state: 'red', why: `${dirty} 个文件未提交（部署树必须干净）` };
  return { state: 'green', why: dirty > 0 ? `同步（另有 ${dirty} 个未提交文件）` : '同步' };
}

/** PR 积压。`open` 每项：{ number, ageDays, mergeable }。 */
export function judgePrBacklog({ open, maxOpenPrs = HYGIENE_DEFAULTS.maxOpenPrs, maxOldestPrDays = HYGIENE_DEFAULTS.maxOldestPrDays } = {}) {
  if (!Array.isArray(open)) return { state: 'unscanned', why: 'PR 清单读不到（没查成，不是没有积压）' };
  const conflicting = open.filter(p => String(p?.mergeable || '').toUpperCase() === 'CONFLICTING');
  if (conflicting.length) {
    return { state: 'red', why: `${conflicting.length} 个 PR 冲突（${conflicting.map(p => `#${p.number}`).join(' ')}）——冲突的 PR 连 CI 都不发车` };
  }
  const oldest = open.reduce((max, p) => Math.max(max, Number(p?.ageDays) || 0), 0);
  if (open.length > maxOpenPrs) {
    return { state: 'red', why: `开放 PR ${open.length} 个 > 阈值 ${maxOpenPrs}（最老 ${oldest.toFixed(1)} 天）` };
  }
  if (oldest > maxOldestPrDays) {
    return { state: 'red', why: `最老开放 PR ${oldest.toFixed(1)} 天 > 阈值 ${maxOldestPrDays} 天（开放 ${open.length} 个）` };
  }
  return { state: 'green', why: `开放 ${open.length} 个，最老 ${oldest.toFixed(1)} 天` };
}

/** 汇总：任一红 → 红；有红也有没查成时**都要报出来**（没查成不许被红的噪音盖住，也不许当绿）。 */
export function summarizeHygiene(verdicts = []) {
  const counts = { green: 0, red: 0, unscanned: 0 };
  for (const v of verdicts) counts[v.state] = (counts[v.state] || 0) + 1;
  return { counts, state: counts.red ? 'red' : counts.unscanned ? 'unscanned' : 'green' };
}
