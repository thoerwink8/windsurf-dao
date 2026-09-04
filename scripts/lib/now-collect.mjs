// scripts/lib/now-collect.mjs —— `dao now` 的取数层（只读，零副作用）
//
// 判定全在 now-board.mjs。这里只管把六路数据取回来，每路包成信封：
//   {scanned:true, items:[…]} / {scanned:false, error:'…'}
// 一路挂掉只让它自己那几行变成「没查成」，不许拖垮全局——所以全部 Promise.allSettled，
// 每路自带超时，整条命令 15 秒内必须出结果。
//
// 零写入：不 fetch（fetch 会写本机 refs）、不建树、不起会话、不发言。
// 因此 master 提交读的是本机 origin/master 引用，可能落后；这一点在信封的 note 里如实说。
//
// 审官登记（reviewer-<PR>.json）的落点实测跟着**执行命令那棵树**跑，不是固定目录
// （/home/orca/wt-unblock/_flow/mirasim/…）。这里只扫已知候选目录，扫不到由判官记「没查成」。
// 改落点是 #880 卡 C 的范围，本动词不碰。

import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const DEFAULT_BUDGET_MS = 15000;
const GH_TIMEOUT_MS = 9000;
const GIT_TIMEOUT_MS = 6000;
const SSH_TIMEOUT_MS = 11000;

/** 跑一条命令。永不抛：失败也回 {ok:false,error}，好让调用方把它变成「没查成」。 */
export function run(cmd, args, { cwd, timeout = GH_TIMEOUT_MS, input } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { cwd, windowsHide: true });
    } catch (e) {
      resolve({ ok: false, error: `${cmd} 起不来：${String(e && e.message || e)}` });
      return;
    }
    let out = '';
    let err = '';
    let done = false;
    const finish = (r) => { if (!done) { done = true; resolve(r); } };
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* 已经死了就算了 */ }
      finish({ ok: false, error: `${cmd} 超时 ${timeout}ms（没查成，不是查过没事）` });
    }, timeout);
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => {
      clearTimeout(timer);
      finish({ ok: false, error: `${cmd} 跑不了：${String(e && e.message || e)}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        finish({ ok: false, code, error: `${cmd} 退出 ${code}：${err.trim().slice(0, 160) || '没有 stderr'}` });
        return;
      }
      finish({ ok: true, out, err });
    });
    if (input != null) {
      child.stdin.on('error', () => { /* 对方先关了 stdin，交给 close 分支报 */ });
      child.stdin.end(input);
    }
  });
}

function parseJson(text, what) {
  try {
    const v = JSON.parse(text);
    return { ok: true, value: v };
  } catch (e) {
    return { ok: false, error: `${what} 回的不是 JSON（没查成）：${String(text).slice(0, 120)}` };
  }
}

// ── open PR ─────────────────────────────────────────────────────────────────

const PR_FIELDS = 'number,title,isDraft,reviewDecision,headRefOid,headRefName,mergeable,updatedAt';

export async function fetchOpenPrs({ cwd, limit = 60 } = {}) {
  const r = await run('gh', ['pr', 'list', '--state', 'open', '--limit', String(limit), '--json', PR_FIELDS], { cwd });
  if (!r.ok) return { scanned: false, error: r.error };
  const p = parseJson(r.out, 'gh pr list');
  if (!p.ok) return { scanned: false, error: p.error };
  if (!Array.isArray(p.value)) return { scanned: false, error: 'gh pr list 没给数组（契约不符，按没查成算）' };
  return { scanned: true, items: p.value };
}

// ── 每张 PR 的判定票（并发；一张失败只坏那一张） ─────────────────────────────

/**
 * review 走 REST，不走 `gh pr view --json reviews`——REST 每张票带 commit_id，
 * 那是判「过期票」的唯一硬判据（时间戳会被评论/label 顶起来，比不出代码有没有再动）。
 */
export async function fetchReviews({ cwd, numbers = [] } = {}) {
  if (!Array.isArray(numbers)) return { byPr: null, error: 'PR 名单没给（没查成）' };
  const jobs = numbers.map(async (n) => {
    const r = await run('gh', ['api', `repos/{owner}/{repo}/pulls/${n}/reviews`, '--paginate'], { cwd });
    if (!r.ok) return [n, { scanned: false, error: r.error }];
    const p = parseJson(r.out, `gh api pulls/${n}/reviews`);
    if (!p.ok) return [n, { scanned: false, error: p.error }];
    if (!Array.isArray(p.value)) return [n, { scanned: false, error: `#${n} 的 review 不是数组（没查成）` }];
    return [n, {
      scanned: true,
      items: p.value.map(rv => ({
        author: rv && rv.user ? rv.user.login : null,
        state: rv && rv.state,
        submittedAt: rv && rv.submitted_at,
        commitOid: rv && rv.commit_id,
      })),
    }];
  });
  const settled = await Promise.all(jobs);
  const byPr = {};
  for (const [n, env] of settled) byPr[String(n)] = env;
  return { byPr };
}

// ── 已落地 ──────────────────────────────────────────────────────────────────

export async function fetchMerged({ cwd, windowHours = 6, limit = 30 } = {}) {
  const [prs, commits] = await Promise.all([
    (async () => {
      const r = await run('gh', ['pr', 'list', '--state', 'merged', '--limit', String(limit), '--json', 'number,title,mergedAt,mergeCommit'], { cwd });
      if (!r.ok) return { scanned: false, error: r.error };
      const p = parseJson(r.out, 'gh pr list --state merged');
      if (!p.ok) return { scanned: false, error: p.error };
      if (!Array.isArray(p.value)) return { scanned: false, error: 'gh pr list merged 没给数组（没查成）' };
      return {
        scanned: true,
        items: p.value.map(x => ({
          number: x.number, title: x.title, mergedAt: x.mergedAt,
          mergeCommitOid: x.mergeCommit ? x.mergeCommit.oid : null,
        })),
      };
    })(),
    (async () => {
      const since = `${Math.max(1, Math.ceil(windowHours * 2))} hours ago`;
      const r = await run('git', ['log', 'origin/master', `--since=${since}`, '--format=%H%x09%cI%x09%s'], { cwd, timeout: GIT_TIMEOUT_MS });
      if (!r.ok) return { scanned: false, error: r.error };
      const items = String(r.out).split(/\r?\n/).filter(Boolean).map((line) => {
        const [sha, at, ...rest] = line.split('\t');
        return { sha, at, subject: rest.join('\t') };
      });
      return { scanned: true, items, note: '读的是本机 origin/master 引用（本动词零写入、不 fetch），可能落后' };
    })(),
  ]);
  return { prs, commits };
}

// ── open issue ──────────────────────────────────────────────────────────────

export async function fetchIssues({ cwd, limit = 60 } = {}) {
  const r = await run('gh', ['issue', 'list', '--state', 'open', '--limit', String(limit), '--json', 'number,title,labels,updatedAt'], { cwd });
  if (!r.ok) return { scanned: false, error: r.error };
  const p = parseJson(r.out, 'gh issue list');
  if (!p.ok) return { scanned: false, error: p.error };
  if (!Array.isArray(p.value)) return { scanned: false, error: 'gh issue list 没给数组（没查成）' };
  return { scanned: true, items: p.value };
}

// ── 本机 worktree（分支 / HEAD / 与远端发散） ────────────────────────────────

/** git worktree list --porcelain → [{path,branch,head}]。解析器自己写，不 import 被检对象。 */
export function parseWorktreePorcelain(text) {
  const items = [];
  let cur = null;
  for (const line of String(text || '').split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      if (cur) items.push(cur);
      cur = { path: line.slice(9).trim(), branch: null, head: null };
    } else if (line.startsWith('HEAD ') && cur) cur.head = line.slice(5).trim();
    else if (line.startsWith('branch ') && cur) cur.branch = line.slice(7).trim().replace(/^refs\/heads\//, '');
  }
  if (cur) items.push(cur);
  return items;
}

/** `[ahead 2, behind 1]` → {ahead:2,behind:1}；`[gone]`/空 → 0/0。 */
export function parseTrack(track) {
  const t = String(track || '');
  const a = /ahead (\d+)/.exec(t);
  const b = /behind (\d+)/.exec(t);
  return { ahead: a ? Number(a[1]) : 0, behind: b ? Number(b[1]) : 0 };
}

export async function fetchWorktrees({ cwd } = {}) {
  const [wt, refs] = await Promise.all([
    run('git', ['worktree', 'list', '--porcelain'], { cwd, timeout: GIT_TIMEOUT_MS }),
    run('git', ['for-each-ref', '--format=%(refname:short)\t%(upstream:short)\t%(upstream:track)', 'refs/heads'], { cwd, timeout: GIT_TIMEOUT_MS }),
  ]);
  if (!wt.ok) return { scanned: false, error: wt.error };
  const trees = parseWorktreePorcelain(wt.out);
  const trackByBranch = new Map();
  if (refs.ok) {
    for (const line of String(refs.out).split(/\r?\n/).filter(Boolean)) {
      const [name, upstream, track] = line.split('\t');
      trackByBranch.set(name, { upstream: upstream || null, ...parseTrack(track) });
    }
  }
  const items = trees.map((t) => {
    const tk = t.branch ? trackByBranch.get(t.branch) : null;
    if (!t.branch) return { ...t, trackScanned: true, ahead: 0, behind: 0, upstream: null };
    if (!refs.ok) return { ...t, trackScanned: false, trackError: refs.error };
    if (!tk) return { ...t, trackScanned: true, ahead: 0, behind: 0, upstream: null };
    return { ...t, trackScanned: true, ahead: tk.ahead, behind: tk.behind, upstream: tk.upstream };
  });
  return { scanned: true, items };
}

// ── 审官登记（本机候选目录） ─────────────────────────────────────────────────

export function localRegistryDirs({ repoRoot, worktreePaths = [] } = {}) {
  const dirs = new Set();
  if (repoRoot) dirs.add(join(repoRoot, '_flow', 'mirasim'));
  for (const p of worktreePaths) if (p) dirs.add(join(p, '_flow', 'mirasim'));
  return [...dirs];
}

/** 扫一批目录里的 reviewer-*.json。坏文件单列，不当「没有」。 */
export function readRegistryDirs(dirs, { readdir = readdirSync, readFile = readFileSync, exists = existsSync } = {}) {
  const items = [];
  const dirsScanned = [];
  const dirsMissing = [];
  const bad = [];
  for (const d of dirs) {
    if (!exists(d)) { dirsMissing.push(d); continue; }
    let names;
    try { names = readdir(d); } catch (e) { bad.push({ dir: d, why: String(e && e.message || e) }); continue; }
    dirsScanned.push(d);
    for (const n of names) {
      if (!/^reviewer-\d+\.json$/.test(n)) continue;
      try {
        const j = JSON.parse(readFile(join(d, n), 'utf8'));
        items.push({ ...j, pr: String(j.pr ?? (/(\d+)/.exec(n) || [])[1] ?? ''), from: join(d, n) });
      } catch (e) {
        bad.push({ file: join(d, n), why: String(e && e.message || e) });
      }
    }
  }
  return { scanned: true, items, dirsScanned, dirsMissing, bad };
}

// ── 服务器侧：登记 + 审官树 head + 活着的执行体（一次 ssh 拿全） ──────────────

// 远端脚本用单引号数组拼，绝不放进 JS 模板串——${…} 会被 JS 先吃掉（本机实咬：
// heredoc/模板串吃引号与反斜杠，今天四个工人里三个栽在这上面）。
// 两条实测（2026-09-04，本单踩的）：
//  1. `ssh contabo` 登进去是 **root**，$HOME=/root，而树都在 /home/orca —— 只按 $HOME 找必然 0 命中；
//     所以候选根是一串（$HOME / /home/orca / /root），扫到哪个算哪个。
//  2. root 读 orca 的仓，git 报 dubious ownership 直接 fatal —— 每次调用现加
//     `-c safe.directory="*"`（只影响这一次调用，不写任何配置，本动词零写入）。
const REMOTE_SCRIPT = [
  'set -u',
  'for root in "$HOME" /home/orca /root; do',
  '  for d in "$root"/windsurf-dao/_flow/mirasim "$root"/wt-*/_flow/mirasim "$root"/mirasim-worktrees/*/*/_flow/mirasim; do',
  '    case "$d" in *"*"*) continue;; esac',
  '    if [ -d "$d" ]; then',
  '      printf "DIROK\\t%s\\n" "$d"',
  '      for f in "$d"/reviewer-*.json; do',
  '        [ -f "$f" ] || continue',
  '        printf "REG\\t%s\\t%s\\n" "$f" "$(base64 -w0 < "$f")"',
  '      done',
  '    else',
  '      printf "DIRMISS\\t%s\\n" "$d"',
  '    fi',
  '  done',
  'done',
  'for t in "$HOME"/mirasim-worktrees/*/* /home/orca/mirasim-worktrees/*/*; do',
  '  case "$t" in *"*"*) continue;; esac',
  '  [ -e "$t/.git" ] || continue',
  '  oid=$(git -c safe.directory="*" -C "$t" rev-parse HEAD 2>/dev/null) || oid=-',
  '  printf "TREE\\t%s\\t%s\\n" "$t" "$oid"',
  'done',
  'for p in /proc/[0-9]*; do',
  '  cwd=$(readlink "$p/cwd" 2>/dev/null) || continue',
  '  case "$cwd" in *mirasim-worktrees*) printf "PROC\\t%s\\t%s\\n" "${p#/proc/}" "$cwd";; esac',
  'done',
  'printf "END\\n"',
].join('\n');

/** 解析远端 TSV。纯函数，测试用夹具直接喂。 */
export function parseRemoteScan(text) {
  const regs = [];
  const trees = new Map();
  const procs = [];
  const dirsScanned = [];
  const dirsMissing = [];
  const bad = [];
  let ended = false;
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line) continue;
    const [kind, a, b] = line.split('\t');
    if (kind === 'END') { ended = true; continue; }
    if (kind === 'DIROK') dirsScanned.push(a);
    else if (kind === 'DIRMISS') dirsMissing.push(a);
    else if (kind === 'TREE') trees.set(a, b && b !== '-' ? b : null);
    else if (kind === 'PROC') procs.push({ pid: a, cwd: b });
    else if (kind === 'REG') {
      try {
        const j = JSON.parse(Buffer.from(String(b || ''), 'base64').toString('utf8'));
        regs.push({ ...j, pr: String(j.pr ?? ''), from: a });
      } catch (e) {
        bad.push({ file: a, why: String(e && e.message || e) });
      }
    }
  }
  return { regs, trees, procs, dirsScanned, dirsMissing, bad, ended };
}

export async function fetchRemote({ host, cwd } = {}) {
  if (!host) {
    const why = '没给服务器名（--no-server 或本机不认识 contabo）';
    return { registries: { scanned: false, error: why }, sessions: { scanned: false, error: why } };
  }
  const r = await run('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=6', host, 'sh', '-s'], {
    cwd, timeout: SSH_TIMEOUT_MS, input: REMOTE_SCRIPT,
  });
  if (!r.ok) {
    const why = `连不上 ${host}：${r.error}`;
    return { registries: { scanned: false, error: why }, sessions: { scanned: false, error: why } };
  }
  const p = parseRemoteScan(r.out);
  if (!p.ended) {
    const why = `${host} 的扫描没跑完（输出没收到结束标记，按没查成算）`;
    return { registries: { scanned: false, error: why }, sessions: { scanned: false, error: why } };
  }
  const items = p.regs.map(reg => ({
    ...reg,
    treeHead: reg.treePath && p.trees.has(reg.treePath)
      ? { scanned: true, oid: p.trees.get(reg.treePath) }
      : { scanned: false, error: `审官树 ${reg.treePath || '(登记里没写路径)'} 的 HEAD 没读到` },
  }));
  return {
    registries: { scanned: true, items, dirsScanned: p.dirsScanned, dirsMissing: p.dirsMissing, bad: p.bad },
    sessions: { scanned: true, items: p.procs },
  };
}

// ── 合成 ────────────────────────────────────────────────────────────────────

function mergeRegistries(local, remote) {
  if (local.scanned !== true && remote.scanned !== true) {
    return { scanned: false, error: `本机与服务器两侧都没查成：${remote.error || ''} / ${local.error || ''}` };
  }
  const items = [...(local.items || []), ...(remote.items || [])];
  return {
    scanned: true,
    items,
    dirsScanned: [...(local.dirsScanned || []), ...(remote.dirsScanned || [])],
    dirsMissing: [...(local.dirsMissing || []), ...(remote.dirsMissing || [])],
    bad: [...(local.bad || []), ...(remote.bad || [])],
    halfUnscanned: local.scanned !== true ? '本机侧没查成' : (remote.scanned !== true ? `服务器侧没查成：${remote.error}` : null),
  };
}

/**
 * 六路一起取。任一路挂掉都只让自己变「没查成」。
 * 顺序上只有 reviews 依赖 PR 名单，其余全并发；整条命令的墙钟由各路超时兜住。
 */
export async function collectNow({ cwd, host = 'contabo', windowHours = 6, now = Date.now() } = {}) {
  const t0 = Date.now();
  const prsP = fetchOpenPrs({ cwd });
  const mergedP = fetchMerged({ cwd, windowHours });
  const issuesP = fetchIssues({ cwd });
  const worktreesP = fetchWorktrees({ cwd });
  const remoteP = fetchRemote({ host, cwd });

  const prs = await prsP;
  const numbers = prs.scanned ? prs.items.map(p => p.number) : [];
  const reviewsP = prs.scanned
    ? fetchReviews({ cwd, numbers })
    : Promise.resolve({ byPr: null, error: `open PR 名单没查成，review 无从查：${prs.error}` });

  const [merged, issues, worktrees, remote, reviews] = await Promise.all([mergedP, issuesP, worktreesP, remoteP, reviewsP]);

  const localReg = readRegistryDirs(localRegistryDirs({
    repoRoot: cwd,
    worktreePaths: worktrees.scanned ? worktrees.items.map(w => w.path) : [],
  }));
  // 本机侧登记若带 treePath，就地读一次 HEAD（同步、只读；本机 git 很快）。
  for (const it of localReg.items) {
    if (it.treeHead) continue;
    it.treeHead = { scanned: false, error: '本机侧没读审官树 HEAD' };
  }

  return {
    prs,
    reviews,
    merged,
    issues,
    worktrees,
    registries: mergeRegistries(localReg, remote.registries),
    sessions: remote.sessions,
    now,
    windowHours,
    elapsedMs: Date.now() - t0,
  };
}
