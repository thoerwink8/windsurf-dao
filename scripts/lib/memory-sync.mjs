// scripts/lib/memory-sync.mjs —— memory 仓定期同步的纯判官（CLI 在 scripts/memory-sync.mjs）
//
// 纪律：
//   - 时间门在判官里（默认 30 分钟才真同步一次），调用方随便高频调
//   - 没接 memory（CI/新机）= skip，不是错也不是干净
//   - behind > 0（别的机器推过）→ 先 pull --rebase 再推；rebase 冲突 → 只报不合
//   - 没查成（git 失败）≠ 干净，单独 unscanned

export const MEMORY_SYNC_GATE_MS = 30 * 60 * 1000;

/**
 * @param {{connected: boolean, dirtyCount: number, ahead: number, behind: number,
 *          now: number, lastSyncMs: number|null, gateMs?: number, force?: boolean}} s
 */
export function planMemorySync(s) {
  if (!s || s.connected !== true) {
    return { action: 'skip', reason: 'memory 未接（没查成 ≠ 干净）' };
  }
  for (const k of ['dirtyCount', 'ahead', 'behind', 'now']) {
    if (typeof s[k] !== 'number' || !Number.isFinite(s[k])) {
      return { action: 'unscanned', reason: `字段 ${k} 没查成（不是数字）` };
    }
  }
  const gateMs = s.gateMs ?? MEMORY_SYNC_GATE_MS;
  const fresh = !s.force && s.lastSyncMs != null && (s.now - s.lastSyncMs) < gateMs;
  if (fresh) {
    return { action: 'skip-fresh', reason: `距上次同步 ${Math.round((s.now - s.lastSyncMs) / 60000)} 分钟，未到 ${Math.round(gateMs / 60000)} 分钟门` };
  }
  if (s.behind > 0) return { action: 'pull-rebase', reason: `远端领先 ${s.behind} 个提交，先 rebase 对齐`, needPush: s.ahead > 0 || s.dirtyCount > 0, needCommit: s.dirtyCount > 0 };
  if (s.dirtyCount === 0 && s.ahead === 0) return { action: 'noop-clean', reason: '干净且已同步（扫完，不是没查成）' };
  return { action: 'sync', needCommit: s.dirtyCount > 0, needPush: true, reason: `未提交 ${s.dirtyCount} 处 / 未推送 ${s.ahead} 个` };
}

/** 解析 git status -sb 头行的 ahead/behind：## main...origin/main [ahead 2, behind 1] */
export function parseAheadBehind(statusFirstLine) {
  const line = String(statusFirstLine || '');
  const m = line.match(/\[(?:ahead (\d+))?(?:, )?(?:behind (\d+))?\]/);
  if (!m) {
    // 无方括号 = 无 ahead/behind 或没有 upstream；两种都要和「没查成」分开
    if (/^##\s+\S+/.test(line)) return { ok: true, ahead: 0, behind: 0, noUpstream: !line.includes('...') };
    return { ok: false, error: `status 头行不认识：${line.slice(0, 80)}` };
  }
  return { ok: true, ahead: Number(m[1] || 0), behind: Number(m[2] || 0), noUpstream: false };
}
