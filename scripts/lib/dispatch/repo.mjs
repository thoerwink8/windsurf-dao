// scripts/lib/dispatch/repo.mjs —— repo 选择符（#762）
//
// 改这段前必须知道：派工执行体可能跑在任意 worktree，repo 选择符必须按
// git remote URL 匹配（路径匹配会失配）。0 条 / 多条 / 没查成必须分开报。

import { realpathSync } from 'node:fs';
import { ROOT } from './constants.mjs';

/** #762：worktree create 带 --repo 选择符，避免 Orca 从外部主树建卡报 Missing repo selector。 */
export function argsRepoList() {
  return ['repo', 'list', '--json'];
}

/** 归一化 git remote URL：去协议前缀 / 尾 .git / 大小写，用于与 orca repo 的 gitRemoteIdentity 对。 */
export function normalizeRepoRemote(url) {
  return String(url || '')
    .trim()
    .replace(/^[a-z]+:\/\//i, '')
    .replace(/^git@/, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

/**
 * #762：从 orca repo list 解析本仓选择符（`id:<repoId>`）。
 * 0 条 / 多条 / 没查成必须分开报（不许把「没查成」当「没注册」）。
 * 匹配优先用 git remote URL（执行体可能在任意 worktree 跑，路径匹配会失配）；
 * remote 没给 / 没命中时 fallback 路径 realpath 匹配。remote 与路径各命中一条 → 冲突，不许猜。
 */
export function resolveRepoSelector({ repos, root, remoteUrl } = {}) {
  if (!Array.isArray(repos)) {
    return { ok: false, unscanned: true, error: 'repo list 结构不认识（缺 result.repos 数组）' };
  }
  if (repos.length === 0) {
    return { ok: false, error: 'orca repo list 是空数组——本仓没注册进 orca，worktree create 会报 Missing repo selector（#762 同款）' };
  }
  const wantRemote = normalizeRepoRemote(remoteUrl);
  const here = root || ROOT;
  const byRemote = [];
  const byPath = [];
  for (const x of repos) {
    const id = x && x.id;
    if (!id) continue;
    const ident = x && x.gitRemoteIdentity;
    const repoRemote = normalizeRepoRemote(ident && (ident.remoteUrl || ident.canonicalKey));
    if (wantRemote && repoRemote && (repoRemote === wantRemote || repoRemote.endsWith(`/${wantRemote}`) || wantRemote.endsWith(`/${repoRemote}`))) {
      byRemote.push(x);
      continue;
    }
    const p = x && (x.path || x.rootPath || x.localPath);
    if (!p) continue;
    let same = false;
    try { same = realpathSync(p) === realpathSync(here); } catch { /* 路径读不到不算命中 */ }
    if (same) byPath.push(x);
  }
  const remoteHits = byRemote.length;
  const pathHits = byPath.length;
  if (remoteHits > 0 && pathHits > 0) {
    return {
      ok: false,
      error: `本仓 remote 命中 ${remoteHits} 条、路径命中 ${pathHits} 条——两种判据冲突，不许猜`,
      remoteIds: byRemote.map(x => x.id),
      pathIds: byPath.map(x => x.id),
    };
  }
  const hits = remoteHits > 0 ? byRemote : byPath;
  if (hits.length === 0) {
    return {
      ok: false,
      error: `本仓（${wantRemote || here}）没匹配到已注册 repo（共 ${repos.length} 条）——worktree create 会报 Missing repo selector（#762 同款）`,
    };
  }
  if (hits.length > 1) {
    return {
      ok: false,
      error: `本仓匹配到 ${hits.length} 条 repo（${hits.map(h => h.id).join('、')}）——选择符没法唯一确定，不许猜`,
      hits: hits.map(h => h.id),
    };
  }
  const id = hits[0].id;
  if (!id) return { ok: false, unscanned: true, error: '命中的 repo 没给 id（契约变了）' };
  return { ok: true, repoId: id, selector: `id:${id}`, matchedBy: remoteHits > 0 ? 'remote' : 'path' };
}
