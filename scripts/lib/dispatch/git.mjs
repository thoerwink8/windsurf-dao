// scripts/lib/dispatch/git.mjs —— git / gh 执行域（#762 拆分）
//
// 改这段前必须知道：#575 ⑦ 审官开审前对齐 master 只能用「先对齐 → 再审 → 再合」，
// rebase 会改 commit sha → review.commit_id != headRefOid → APPROVED 当场失效。
// mergeable 三态必须分开：MERGEABLE / CONFLICTING / UNKNOWN——UNKNOWN 不是绿。

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ghAs } from '../gh.mjs';

export function gitCapture(cwd, args) {
  if (!cwd) return { ok: false, error: 'git 没给工作区路径' };
  const r = spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8', windowsHide: true, timeout: 15000,
  });
  if (r.error || (r.status !== 0 && r.status != null)) {
    return { ok: false, error: String(r.error?.message || r.stderr || `git exit ${r.status}`).trim().slice(0, 200) };
  }
  return { ok: true, out: String(r.stdout || '').trim() };
}

export function gitHeadOid(cwd) {
  const r = gitCapture(cwd, ['rev-parse', 'HEAD']);
  if (!r.ok) return r;
  if (!/^[0-9a-f]{7,40}$/i.test(r.out)) return { ok: false, error: `git HEAD 不是 oid：${r.out.slice(0, 80)}` };
  return { ok: true, oid: r.out };
}

export function gitBranchName(cwd) {
  const r = gitCapture(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!r.ok) return r;
  if (!r.out || r.out === 'HEAD') return { ok: false, error: '工作区处于 detached HEAD，推不出分支名' };
  return { ok: true, branch: r.out };
}

/** #762：git remote get-url origin，用于 repo 选择符匹配（执行体可能跑在任意 worktree）。 */
export function gitRemoteOriginUrl(cwd) {
  const r = gitCapture(cwd, ['remote', 'get-url', 'origin']);
  if (!r.ok) return r;
  const out = String(r.out || '').trim();
  if (!out) return { ok: false, error: 'git remote get-url origin 返回空（没查成）' };
  return { ok: true, url: out };
}

/**
 * #575 ⑦：审官开审前对齐 master。
 * rebase 会改 commit sha → review.commit_id != headRefOid → APPROVED 当场失效
 * （判例 review-green-must-match-head）。所以只能先对齐 → 再审 → 再合。
 *
 * mergeable 三态必须分开：MERGEABLE / CONFLICTING / UNKNOWN。
 * UNKNOWN 是「GitHub 还在算」，不是绿——没查成，不许当 MERGEABLE 放行。
 */
export function assessPrMergeable(raw) {
  const v = String(raw ?? '').trim().toUpperCase();
  if (v === 'MERGEABLE') return { ok: true, mergeable: 'MERGEABLE' };
  if (v === 'CONFLICTING') {
    return {
      ok: false,
      mergeable: 'CONFLICTING',
      error: '先让工人 rebase master，别派审官白审（mergeable=CONFLICTING）',
    };
  }
  if (!v || v === 'UNKNOWN') {
    return {
      ok: false,
      unscanned: true,
      mergeable: v || null,
      error: `mergeable=${v || '空'}——GitHub 还在算或没查成，不许当 MERGEABLE 放行`,
    };
  }
  return {
    ok: false,
    unscanned: true,
    mergeable: v,
    error: `mergeable 值不认识：${v}——没查成，不许当绿放行`,
  };
}

function gitRun(cwd, args, runGit) {
  if (typeof runGit === 'function') return runGit(args);
  return gitCapture(cwd, args);
}

/**
 * 试合 origin/master（或 origin/main），记录落后数/冲突/触及文件，然后 --abort。
 * 树必须停在原 HEAD：审官审的是 PR head，expectedOid 校验才有意义。
 *
 * 顺序陷阱：rebase 会改 commit sha，导致 review.commit_id != headRefOid、
 * 审官的 APPROVED 失效（判例 review-green-must-match-head）。
 * 只能「先对齐 master → 再审 → 再合」，不能审完再 rebase。
 */
export function trialMergeMaster({ cwd, runGit } = {}) {
  if (!cwd && typeof runGit !== 'function') {
    return { ok: false, unscanned: true, error: 'trialMergeMaster 没给工作区' };
  }
  const run = (args) => gitRun(cwd, args, runGit);
  const head = run(['rev-parse', 'HEAD']);
  if (!head.ok) return { ok: false, unscanned: true, error: `试合前 HEAD 没查成：${head.error}` };
  const before = head.out;

  let base = 'origin/master';
  const hasMaster = run(['rev-parse', '--verify', 'origin/master']);
  if (!hasMaster.ok) {
    const hasMain = run(['rev-parse', '--verify', 'origin/main']);
    if (!hasMain.ok) {
      return { ok: false, unscanned: true, error: 'origin/master 与 origin/main 都没有——试合没查成' };
    }
    base = 'origin/main';
  }

  const behindR = run(['rev-list', '--count', `HEAD..${base}`]);
  if (!behindR.ok) return { ok: false, unscanned: true, error: `落后 commit 数没查成：${behindR.error}` };
  const behind = Number(behindR.out);
  if (!Number.isFinite(behind)) {
    return { ok: false, unscanned: true, error: `落后 commit 数不是数字：${behindR.out}` };
  }

  const touchedR = run(['diff', '--name-only', `HEAD...${base}`]);
  const masterFiles = touchedR.ok
    ? String(touchedR.out || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean)
    : [];

  const merge = run(['merge', base, '--no-commit', '--no-ff']);
  // 冲突只认未合并文件。merge 非零可能是没配 user.name（CI 实证 #578）——那是没查成，不是冲突。
  const unmerged = run(['diff', '--name-only', '--diff-filter=U']);
  const conflict = !!(unmerged.ok && String(unmerged.out || '').trim());
  if (!merge.ok && !conflict) {
    run(['merge', '--abort']);
    return {
      ok: false,
      unscanned: true,
      behind,
      masterFiles,
      error: `试合没跑成（不是冲突）：${merge.error}`,
    };
  }
  const abort = run(['merge', '--abort']);
  // 没进合并时 abort 会失败——只要 HEAD 还原且工作区干净就算成功。
  const after = run(['rev-parse', 'HEAD']);
  if (!after.ok) {
    return { ok: false, error: `试合后 HEAD 没查成：${after.error}`, behind, conflict, masterFiles };
  }
  if (after.out !== before) {
    return {
      ok: false,
      error: `试合后 HEAD ${after.out} ≠ 原 ${before}（--abort 没还原，审官树漂了）`,
      behind, conflict, masterFiles, head: after.out, expectedOid: before,
    };
  }
  const st = run(['status', '--porcelain']);
  if (!st.ok) return { ok: false, error: `试合后 git status 没查成：${st.error}`, behind, conflict };
  if (String(st.out || '').trim()) {
    return {
      ok: false,
      error: `试合后工作区不干净（--abort 有残留）：${String(st.out).slice(0, 120)}`,
      behind, conflict, masterFiles,
    };
  }
  return {
    ok: true,
    behind,
    conflict,
    clean: true,
    base,
    masterFiles,
    head: before,
    abortOk: abort.ok,
    hint: behind === 0
      ? '与 master 同步'
      : conflict
        ? `落后 ${behind} 个 commit，试合有冲突——工人应先 rebase`
        : `落后 ${behind} 个 commit，试合无冲突。重点核这 ${behind} 个 commit 碰过的文件与本 PR 的交集`,
  };
}

function oidsMatch(a, b) {
  const x = String(a || '').toLowerCase();
  const y = String(b || '').toLowerCase();
  if (!x || !y) return false;
  if (x === y) return true;
  return (x.length >= 7 && y.startsWith(x)) || (y.length >= 7 && x.startsWith(y));
}

/** 建审官树前：fetch origin/<分支>，PR head 的真相在远端不在本地（#810/#815）。 */
export function originRefForBranch(branch) {
  const raw = String(branch || '').trim();
  if (!raw) return { ok: false, error: '没给分支名' };
  const b = raw.replace(/^refs\/heads\//, '').replace(/^origin\//, '');
  if (!b) return { ok: false, error: '没给分支名' };
  return { ok: true, branch: b, ref: `origin/${b}` };
}

export function prepareReviewerOriginRef({ branch, expectedOid, cwd, runGit } = {}) {
  const parsed = originRefForBranch(branch);
  if (!parsed.ok) return parsed;
  if (!cwd && typeof runGit !== 'function') {
    return { ok: false, unscanned: true, error: 'prepareReviewerOriginRef 没给工作区（没查成）' };
  }
  const run = (args) => gitRun(cwd, args, runGit);
  const fetch = run(['fetch', 'origin', parsed.branch]);
  if (!fetch.ok) {
    return {
      ok: false,
      unscanned: true,
      error: `git fetch origin ${parsed.branch} 没查成：${fetch.error}`,
    };
  }
  const rev = run(['rev-parse', parsed.ref]);
  if (!rev.ok) {
    return {
      ok: false,
      unscanned: true,
      error: `${parsed.ref} 没查成：${rev.error}`,
    };
  }
  const originOid = String(rev.out || '').trim();
  if (!/^[0-9a-f]{7,40}$/i.test(originOid)) {
    return { ok: false, unscanned: true, error: `${parsed.ref} 不是 oid：${originOid.slice(0, 80)}` };
  }
  const want = expectedOid ? String(expectedOid).trim() : null;
  if (want && !oidsMatch(originOid, want)) {
    return {
      ok: false,
      error: `本地分支落后：${parsed.ref} ${originOid} ≠ PR head ${want}`,
      originOid,
      expectedOid: want,
      baseBranch: parsed.ref,
      localBehind: true,
    };
  }
  return {
    ok: true,
    branch: parsed.branch,
    baseBranch: parsed.ref,
    originOid,
    expectedOid: want,
  };
}

/** 已有审官树：按 origin/<分支> 检出（#810 接手后本地指针停在旧提交）。 */
export function checkoutOriginRef({ cwd, branch, expectedOid, runGit } = {}) {
  const prep = prepareReviewerOriginRef({ branch, expectedOid, cwd, runGit });
  if (!prep.ok) return prep;
  const run = (args) => gitRun(cwd, args, runGit);
  const co = run(['checkout', '-B', prep.branch, prep.baseBranch]);
  if (!co.ok) {
    return { ok: false, error: `按 ${prep.baseBranch} 检出失败：${co.error}`, ...prep };
  }
  return prep;
}

export function verifyReviewerTree({ workerPath, reviewerPath, expectedOid, originOid } = {}) {
  const rev = gitHeadOid(reviewerPath);
  if (!rev.ok) return { ok: false, error: `审官树 HEAD 没查成：${rev.error}` };
  let want = expectedOid || null;
  if (!want) {
    const w = gitHeadOid(workerPath);
    if (!w.ok) return { ok: false, error: `工人树 HEAD 没查成：${w.error}` };
    want = w.oid;
  }
  if (!oidsMatch(rev.oid, want)) {
    const origin = originOid ? String(originOid) : '';
    const localBehind = !!(origin && (!oidsMatch(origin, want) || !oidsMatch(rev.oid, origin)));
    return {
      ok: false,
      error: localBehind
        ? `审官树 HEAD ${rev.oid} ≠ 期望 ${want}（本地分支落后）`
        : `审官树 HEAD ${rev.oid} ≠ 期望 ${want}（在审空气）`,
      reviewerHead: rev.oid,
      expectedOid: want,
      originOid: origin || null,
      localBehind,
    };
  }
  return { ok: true, reviewerHead: rev.oid, expectedOid: want, originOid: originOid || null };
}

export function verifyReviewerFiles({ reviewerPath, files } = {}) {
  if (!Array.isArray(files)) {
    return { ok: false, error: '被审文件清单没查成', missing: [], unscanned: true };
  }
  const missing = [];
  for (const f of files) {
    if (!existsSync(join(reviewerPath, f))) missing.push(f);
  }
  if (missing.length) return { ok: false, error: `审官树缺被审文件 ${missing.length} 个`, missing };
  return { ok: true, checked: files.length, missing: [] };
}

/** GitHub pull file 列表：跳过 removed，取 filename。没查成时返回 null。 */
export function parseGhPullFiles(json) {
  if (!Array.isArray(json)) return null;
  return json
    .filter(f => f && f.status !== 'removed' && f.filename)
    .map(f => f.filename);
}

export function parseDiffNameStatus(text) {
  const mustExist = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const status = line.slice(0, tab).trim();
    const rest = line.slice(tab + 1);
    if (!status || status[0] === 'D') continue;
    const parts = rest.split('\t');
    mustExist.push(parts[parts.length - 1]);
  }
  return mustExist;
}

export function runGh(args, { cwd, role } = {}) {
  // role 有值 → 走 GitHub App 身份（#573）。其余裸调用先保持本人 gh，全量替换另开单。
  if (role) return ghAs(role, args, { cwd });
  const r = spawnSync('gh', args, {
    encoding: 'utf8', windowsHide: true, timeout: 30000, cwd,
  });
  if (r.error || (r.status !== 0 && r.status != null)) {
    return { ok: false, error: String(r.error?.message || r.stderr || `gh exit ${r.status}`).trim().slice(0, 240) };
  }
  return { ok: true, out: String(r.stdout || '') };
}
