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
 * #1024：跨仓 --repo owner/name 只许 remote 命中（allowPath:false）——路径兜底会命中本仓，
 * 那正是「静默回落到 windsurf-dao」的口。
 */
export function resolveRepoSelector({ repos, root, remoteUrl, allowPath = true, label = '本仓' } = {}) {
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
    if (!allowPath) continue;
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
      error: `${label} remote 命中 ${remoteHits} 条、路径命中 ${pathHits} 条——两种判据冲突，不许猜`,
      remoteIds: byRemote.map(x => x.id),
      pathIds: byPath.map(x => x.id),
    };
  }
  const hits = remoteHits > 0 ? byRemote : byPath;
  if (hits.length === 0) {
    return {
      ok: false,
      error: `${label}（${wantRemote || here}）没匹配到已注册 repo（共 ${repos.length} 条）——worktree create 会报 Missing repo selector（#762 同款）；跨仓时不许回落本仓`,
    };
  }
  if (hits.length > 1) {
    return {
      ok: false,
      error: `${label}匹配到 ${hits.length} 条 repo（${hits.map(h => h.id).join('、')}）——选择符没法唯一确定，不许猜`,
      hits: hits.map(h => h.id),
    };
  }
  const id = hits[0].id;
  if (!id) return { ok: false, unscanned: true, error: '命中的 repo 没给 id（契约变了）' };
  return { ok: true, repoId: id, selector: `id:${id}`, matchedBy: remoteHits > 0 ? 'remote' : 'path' };
}

/** #1024：--repo 只认 owner/name。缺 owner、带空格、路径、URL、半截选择符一律当场拒。 */
export function parseOwnerNameRepo(raw) {
  if (raw == null) return { ok: true, omitted: true, ownerName: null };
  const s = String(raw).trim();
  if (!s) return { ok: true, omitted: true, ownerName: null };
  if (/\s/.test(s)) {
    return { ok: false, error: `--repo 格式非法（带空格）：「${s}」。只要 owner/name，不许拼半截选择符` };
  }
  if (/^[a-z]+:\/\//i.test(s) || s.startsWith('git@') || s.endsWith('.git')) {
    return { ok: false, error: `--repo 格式非法（像 URL）：「${s}」。只要 owner/name` };
  }
  if (s.includes(':') || s.includes('\\') || s.startsWith('/') || s.startsWith('.')) {
    return { ok: false, error: `--repo 格式非法（像路径或 orca 选择符）：「${s}」。只要 owner/name` };
  }
  const m = s.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (!m) {
    return { ok: false, error: `--repo 格式非法（缺 owner 或形态不对）：「${s}」。只要 owner/name` };
  }
  return { ok: true, omitted: false, owner: m[1], name: m[2], ownerName: `${m[1]}/${m[2]}` };
}

/** 把 owner/name 收成 git remote 形态，给 resolveRepoSelector 的 remoteUrl。 */
export function githubRemoteUrlOf(ownerName) {
  const s = String(ownerName || '').trim();
  if (!s) return '';
  return `https://github.com/${s}.git`;
}

/**
 * #1024：gh 参数按目标仓钉死。不传 / 空 = 原样（本仓 cwd 语义一字不变）。
 * 已有 --repo 不重复插。非法格式当场拒，不许拼半截。
 */
export function withGhRepo(args, ownerName) {
  if (!Array.isArray(args)) return { ok: false, error: 'withGhRepo 没拿到 gh 参数数组' };
  if (ownerName == null || String(ownerName).trim() === '') {
    return { ok: true, args: [...args], injected: false };
  }
  const parsed = parseOwnerNameRepo(ownerName);
  if (!parsed.ok) return parsed;
  if (parsed.omitted) return { ok: true, args: [...args], injected: false };
  if (args.includes('--repo')) return { ok: true, args: [...args], injected: false, already: true };
  return { ok: true, args: [...args, '--repo', parsed.ownerName], injected: true, ownerName: parsed.ownerName };
}

/**
 * #1024：installation 授权闸。scanned=false → 没查成，不许当「这个仓不存在」。
 * 扫成且不在名单 → 拒派「这个仓没授权给 <role>」，不许静默回落本仓。
 */
export function assertRepoAuthorized({ ownerName, role, repositories, repoScan } = {}) {
  const parsed = parseOwnerNameRepo(ownerName);
  if (!parsed.ok) return parsed;
  if (parsed.omitted) return { ok: true, gated: false, ownerName: null };
  const r = String(role || '').trim() || 'worker';
  if (!repoScan || repoScan.scanned !== true) {
    const why = (repoScan && repoScan.error) || 'installation 仓库名单没扫成';
    return {
      ok: false,
      unscanned: true,
      gated: true,
      ownerName: parsed.ownerName,
      role: r,
      error: `目标仓 ${parsed.ownerName} 没查成（不是「这个仓不存在」）：${why}`,
    };
  }
  const names = Array.isArray(repositories) ? repositories.map(x => String(x || '').trim()).filter(Boolean) : [];
  const hit = names.some(n => n.toLowerCase() === parsed.ownerName.toLowerCase());
  if (!hit) {
    return {
      ok: false,
      gated: true,
      ownerName: parsed.ownerName,
      role: r,
      error: `这个仓没授权给 ${r}（${parsed.ownerName} 不在 ${r} 的 installation 里）。不许回落到本仓`,
    };
  }
  return { ok: true, gated: true, ownerName: parsed.ownerName, role: r };
}
