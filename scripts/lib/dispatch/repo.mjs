// scripts/lib/dispatch/repo.mjs —— repo 选择符（#762）
//
// 改这段前必须知道：派工执行体可能跑在任意 worktree，repo 选择符必须按
// git remote URL 匹配（路径匹配会失配）。0 条 / 多条 / 没查成必须分开报。

import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
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

/** #1024：--repo 只认 owner/name。缺 owner、带空格（含首尾）、路径、URL、半截选择符一律当场拒。 */
export function parseOwnerNameRepo(raw) {
  if (raw == null) return { ok: true, omitted: true, ownerName: null };
  const s = String(raw);
  if (!s) return { ok: true, omitted: true, ownerName: null };
  // 先查原始串任意空白，再 trim。trim 后再查会把首尾空格静默吃掉，验收标准要当场拒。
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

/** 绝对路径 / 相对路径 / Windows 盘符。owner/name 不是路径。 */
export function looksLikeLocalRepoPath(raw) {
  const s = String(raw || '');
  if (!s) return false;
  if (s.startsWith('/') || s.startsWith('.') || s.includes('\\')) return true;
  if (/^[A-Za-z]:[\\\/]/.test(s)) return true;
  return false;
}

/**
 * #1024 返工：把 --repo 拆成 GitHub owner/name 与 runtime 本地 checkout。
 * owner/name 只给 gh / 授权闸；本地路径只给 ensureWorkspace。两套不许混。
 * 不传 = 本仓（gh 不钉仓，本地用 ROOT）。路径与 owner/name 互斥。
 */
export function splitRepoTarget(raw, { root } = {}) {
  if (raw == null) {
    return { ok: true, omitted: true, ownerName: null, localPath: root || null, kind: 'omitted' };
  }
  const s = String(raw);
  if (!s) return { ok: true, omitted: true, ownerName: null, localPath: root || null, kind: 'omitted' };
  if (looksLikeLocalRepoPath(s)) {
    return { ok: true, omitted: false, ownerName: null, localPath: s, kind: 'path' };
  }
  const parsed = parseOwnerNameRepo(s);
  if (!parsed.ok) return parsed;
  if (parsed.omitted) {
    return { ok: true, omitted: true, ownerName: null, localPath: root || null, kind: 'omitted' };
  }
  return {
    ok: true,
    omitted: false,
    ownerName: parsed.ownerName,
    owner: parsed.owner,
    name: parsed.name,
    localPath: null,
    kind: 'ownerName',
  };
}

/**
 * GitHub owner/name → 本机主 clone 路径。约定 /srv/projects/<name>（NEW-MACHINE / INDEX）。
 * 目录不在或不是 git 仓 = 没查成，不许把 owner/name 原样交给 ensureWorkspace。
 */
export function resolveLocalCheckout({ ownerName, projectsRoot = '/srv/projects', exists, isGit } = {}) {
  const parsed = parseOwnerNameRepo(ownerName);
  if (!parsed.ok) return parsed;
  if (parsed.omitted) return { ok: false, error: 'resolveLocalCheckout 没给 owner/name' };
  const localPath = join(projectsRoot, parsed.name);
  const here = typeof exists === 'function' ? exists(localPath) : existsSync(localPath);
  if (!here) {
    return {
      ok: false,
      unscanned: true,
      ownerName: parsed.ownerName,
      localPath,
      error: `目标仓 ${parsed.ownerName} 本地 checkout 没查成（不是「这个仓不存在」）：${localPath} 不在。ensureWorkspace 要本地路径，不许把 owner/name 当路径`,
    };
  }
  const gitHere = typeof isGit === 'function' ? isGit(localPath) : existsSync(join(localPath, '.git'));
  if (!gitHere) {
    return {
      ok: false,
      unscanned: true,
      ownerName: parsed.ownerName,
      localPath,
      error: `目标仓 ${parsed.ownerName} 本地 checkout 没查成（不是「这个仓不存在」）：${localPath} 不是 git 仓`,
    };
  }
  return { ok: true, ownerName: parsed.ownerName, localPath, name: parsed.name };
}

/**
 * #1024 复审：跨仓持久化/互斥键（审官登记、锁、复审待办共用）。
 * 本仓（不传 --repo）仍用纯 PR 号，存量 `12.json` / `reviewer-12.json` 一字不变。
 * 显式 owner/name 用 `owner__name__pr`（`__` 不在 owner/name 字符集里，也不会被仓外路径闸扫成 `~/…`）。
 * 非法 --repo 当场拒，不许 trim 成半截键，也不许回落到纯 PR 号。
 */
export function repoPrKey({ repo, pr } = {}) {
  const n = String(pr ?? '').trim();
  if (!n) return { ok: false, error: 'repoPrKey 要 PR 号' };
  if (!/^\d+$/.test(n)) return { ok: false, error: `repoPrKey PR 号非法：「${n}」` };
  if (repo == null || String(repo) === '') {
    return { ok: true, key: n, stem: n, scoped: false, ownerName: null, pr: n };
  }
  const parsed = parseOwnerNameRepo(repo);
  if (!parsed.ok) return parsed;
  if (parsed.omitted) {
    return { ok: true, key: n, stem: n, scoped: false, ownerName: null, pr: n };
  }
  return {
    ok: true,
    key: `${parsed.ownerName}#${n}`,
    stem: `${parsed.owner}__${parsed.name}__${n}`,
    scoped: true,
    ownerName: parsed.ownerName,
    pr: n,
  };
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
