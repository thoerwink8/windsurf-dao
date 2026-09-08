// dao-check ㉞：在管仓 .git 属主一致性（issue #1149）。
//
// 病：以 root 跑 git（fetch/worktree/检查器）会在 orca 属主的仓 `.git` 里留下
// root 属主对象，之后以互不相像的面目失败。2026-09-08 一天两咬：
//   1. windsurf-dao：root fetch 中断 → `.git/objects` root 残留 + 坏对象 → gc 静默失败；
//   2. ai-gateway-stack：`git add` 直接 `insufficient permission for adding an object`。
// memory `root-owned-files-in-service-home` 早有判例，但没有闸——察觉不到违反的规则等于没有。
//
// 现有 checkRepoOwnership 扫工作区时故意 `-not -path './.git/*'`，正好把本闸要拦的
// 对象排除在外。本文件另开一道，不改那条工作区闸。
//
// 检查器自持判据，零 import（自己查自己查不出错）。IO / find 全由调用方注入。
//
// 三态必须分得开：
//   unscanned —— 没查成（没给清单 / 仓路径不存在 / find 失败 / .git 不是目录）
//   red       —— 扫到了，且仓本身不归 root，但 `.git` 里有 root 属主文件（点名文件）
//   ok        —— 扫了 N 个仓，0 个 root 属主文件
// 「仓不在」不许当绿。仓本身归 root 的机器跳过（与工作区属主闸同一条豁免）。

export const DEFAULT_MANAGED_REPOS = [
  { name: 'windsurf-dao', path: '/srv/projects/windsurf-dao' },
  { name: 'ai-gateway-stack', path: '/srv/projects/ai-gateway-stack' },
];

function gitDirOf(repoPath) {
  return `${String(repoPath || '').replace(/\/+$/, '')}/.git`;
}

function shortErr(e) {
  return String(e && e.message ? e.message : e).slice(0, 160);
}

function firstStderrLine(stderr) {
  return String(stderr || '').split('\n').map((l) => l.trim()).filter(Boolean)[0] || '';
}

/**
 * 把一次 `find -user root` 的 spawnSync 结果判成 {ok, files} / {ok:false, error}。
 * 任意非零退出或 stderr（含 Permission denied）都是没查成，不许当干净——
 * .git 未完整可读时部分扫描会漏掉 root 属主文件。
 */
export function interpretFindRootOwned(r) {
  if (!r) {
    return { ok: false, error: 'find 没给结果（没查成）' };
  }
  if (r.error) {
    return { ok: false, error: shortErr(r.error) };
  }
  const firstErr = firstStderrLine(r.stderr);
  if (r.status == null || r.status !== 0) {
    return { ok: false, error: (firstErr || `find exit ${r.status}`).slice(0, 160) };
  }
  if (firstErr) {
    return { ok: false, error: firstErr.slice(0, 160) };
  }
  const files = String(r.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean);
  return { ok: true, files };
}

/**
 * 扫一个仓的 `.git`。探头全注入，live 与单测走同一条。
 * exists(path) / isDir(path) / statUid(path) / findRootOwned(gitDir)→{ok, files, error}。
 */
export function scanGitRepo({ name, path, exists, isDir, statUid, findRootOwned } = {}) {
  const repoName = String(name || '');
  const repoPath = String(path || '');
  if (
    typeof exists !== 'function'
    || typeof isDir !== 'function'
    || typeof statUid !== 'function'
    || typeof findRootOwned !== 'function'
  ) {
    return {
      name: repoName,
      path: repoPath,
      exists: false,
      scanned: false,
      reason: '没给 exists/isDir/statUid/findRootOwned 探头（没查成）',
    };
  }
  if (!repoPath) {
    return { name: repoName, path: repoPath, exists: false, scanned: false, reason: '仓路径是空的' };
  }
  if (!exists(repoPath)) {
    return { name: repoName, path: repoPath, exists: false, scanned: false, reason: '仓路径不存在' };
  }
  const gitDir = gitDirOf(repoPath);
  if (!exists(gitDir)) {
    return { name: repoName, path: repoPath, gitDir, exists: true, scanned: false, reason: '.git 不在' };
  }
  if (!isDir(gitDir)) {
    return {
      name: repoName,
      path: repoPath,
      gitDir,
      exists: true,
      scanned: false,
      reason: '.git 不是目录（worktree 形态不当样本，扫主仓）',
    };
  }
  let repoOwnerUid;
  try { repoOwnerUid = statUid(repoPath); }
  catch (e) {
    return {
      name: repoName,
      path: repoPath,
      gitDir,
      exists: true,
      scanned: false,
      reason: `仓属主没查成：${shortErr(e)}`,
    };
  }
  if (repoOwnerUid === 0) {
    return {
      name: repoName,
      path: repoPath,
      gitDir,
      exists: true,
      scanned: true,
      repoOwnerUid: 0,
      skippedBecauseRoot: true,
      rootOwned: [],
    };
  }
  let found;
  try { found = findRootOwned(gitDir); }
  catch (e) {
    return {
      name: repoName,
      path: repoPath,
      gitDir,
      exists: true,
      scanned: false,
      repoOwnerUid,
      reason: `find 没查成：${shortErr(e)}`,
    };
  }
  if (!found || found.ok !== true || !Array.isArray(found.files)) {
    return {
      name: repoName,
      path: repoPath,
      gitDir,
      exists: true,
      scanned: false,
      repoOwnerUid,
      reason: `find 没查成：${(found && found.error) || (found && found.ok === true ? '没给 files 数组' : '无结果')}`,
    };
  }
  const rootOwned = found.files.map((f) => String(f || '').trim()).filter(Boolean);
  return {
    name: repoName,
    path: repoPath,
    gitDir,
    exists: true,
    scanned: true,
    repoOwnerUid,
    skippedBecauseRoot: false,
    rootOwned,
  };
}

/**
 * 纯判官：把一组扫描结果判成 unscanned / red / ok / skip。
 * 仓不在、没扫成 ≠ 干净。真污染（red）优先于没查成，避免脏仓被缺路径盖住。
 */
export function classifyGitOwnership(scans) {
  if (!Array.isArray(scans) || scans.length === 0) {
    return {
      kind: 'unscanned',
      line: '.git 属主：一个仓都没扫——没查成，不是绿',
      howToFix: '给在管仓清单再扫：windsurf-dao、ai-gateway-stack',
      evidence: 'scans 空',
    };
  }
  const missing = [];
  const failed = [];
  const dirty = [];
  const clean = [];
  const skipped = [];
  for (const s of scans) {
    if (!s || s.exists === false) {
      missing.push(s && s.name ? `${s.name}（${s.path || ''}）` : '无名仓');
      continue;
    }
    if (!s.scanned) {
      failed.push(`${s.name || s.path}：${s.reason || '没查成'}`);
      continue;
    }
    if (s.skippedBecauseRoot || s.repoOwnerUid === 0) {
      skipped.push(s.name || s.path);
      continue;
    }
    const files = Array.isArray(s.rootOwned) ? s.rootOwned.filter(Boolean) : [];
    if (files.length) dirty.push({ name: s.name, path: s.path, gitDir: s.gitDir || gitDirOf(s.path), files });
    else clean.push(s.name || s.path);
  }
  if (dirty.length) {
    const files = dirty.flatMap((d) => d.files);
    const gitDirs = dirty.map((d) => d.gitDir);
    return {
      kind: 'red',
      line: `.git 属主：${dirty.length} 个仓有 root 残留（${files.length} 个文件）`,
      howToFix: `跑 chown -R orca:orca ${gitDirs.join(' ')} 修。根因是以 root 跑了 git fetch/worktree/检查器，对象落成 root，之后 gc / git add 以别的面目失败`,
      evidence: files.slice(0, 5).join('、') + (files.length > 5 ? ` …等 ${files.length} 个` : ''),
    };
  }
  if (missing.length) {
    return {
      kind: 'unscanned',
      line: `.git 属主：${missing.length} 个仓不在——没查成，不是绿`,
      howToFix: '仓路径不存在就不要当干净；本机应有 /srv/projects/windsurf-dao 与 /srv/projects/ai-gateway-stack',
      evidence: missing.join('、'),
    };
  }
  if (failed.length) {
    return {
      kind: 'unscanned',
      line: `.git 属主：${failed.length} 个仓没扫成`,
      howToFix: 'find 跑不起来或 .git 形态不对——别据此判断干净',
      evidence: failed.join('；'),
    };
  }
  if (clean.length === 0 && skipped.length) {
    return {
      kind: 'skip',
      line: `.git 属主：${skipped.length} 个仓本身归 root，本项跳过`,
    };
  }
  const skipBit = skipped.length ? `（另 ${skipped.length} 个仓归 root 已跳过）` : '';
  return {
    kind: 'ok',
    line: `.git 属主：${clean.length} 个仓扫完 0 个 root 属主文件${skipBit}`,
  };
}

/** 夹具判别力：red 必须点名文件、ok 必须绿、empty 必须标没查成。 */
export function inspectGitOwnershipFixtures({
  rootRel = 'tests/fixtures/git-ownership',
  exists,
  readFile,
} = {}) {
  if (typeof exists !== 'function' || typeof readFile !== 'function') {
    return { ok: false, unscanned: true, error: '没给 exists/readFile 探头（没查成）' };
  }
  if (!exists(rootRel)) {
    return { ok: false, unscanned: true, error: `样本目录不在：${rootRel}` };
  }
  const kinds = { red: 0, ok: 0, empty: 0 };
  const problems = [];
  for (const kind of ['red', 'ok', 'empty']) {
    const file = `${rootRel}/${kind}.json`;
    if (!exists(file)) {
      problems.push(`缺 ${kind}.json`);
      continue;
    }
    let scans;
    try { scans = JSON.parse(readFile(file)); }
    catch (e) {
      problems.push(`${kind}.json 不是 JSON：${shortErr(e)}`);
      continue;
    }
    const r = classifyGitOwnership(scans);
    if (kind === 'empty') {
      if (r.kind !== 'unscanned') {
        problems.push(`empty/ 应没查成但判成 ${r.kind}`);
      } else kinds.empty += 1;
    } else if (kind === 'red') {
      if (r.kind !== 'red') {
        problems.push(`red/ 自称该红但判成 ${r.kind}`);
      } else if (!/pack-evil|root-owned|objects\//.test(`${r.evidence || ''} ${r.line || ''}`)) {
        problems.push('red/ 没点出 root 属主文件');
      } else kinds.red += 1;
    } else if (kind === 'ok') {
      if (r.kind !== 'ok') {
        problems.push(`ok/ 自称该绿但判成 ${r.kind}：${r.line || ''}`);
      } else kinds.ok += 1;
    }
  }
  if (kinds.red === 0 || kinds.ok === 0 || kinds.empty === 0) {
    return {
      ok: false,
      unscanned: true,
      error: `样本种类不够 red=${kinds.red} ok=${kinds.ok} empty=${kinds.empty}`,
      kinds,
      problems,
    };
  }
  if (problems.length) return { ok: false, unscanned: false, error: problems[0], kinds, problems };
  return { ok: true, unscanned: false, kinds };
}
