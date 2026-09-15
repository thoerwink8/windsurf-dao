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
// 审官登记（reviewer-<PR>.json）的落点在**执行命令那棵树**或 `~/.dao/mirasim/`
// （`dao.mjs` 的 `mirasimRegistry()` 用 `join(homedir(), '.dao', 'mirasim')` 当 flowDir）。
// 2026-09-14 实咬：候选目录只扫 `_flow/mirasim`，而现役登记全在 `~/.dao/mirasim/`（81 份），
// 于是每一张有审官的 PR 都被判成「登记找不到」→ 盘面报 `reviewer-unknown`「要你拍」，
// 帅位按盘面拍板就会去重起一个已经在跑的审官。这里补上真实写入方那个目录。
// 仍然只扫已知候选目录：扫不到由判官记「没查成」，不当「这张 PR 没有审官」。

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_BUDGET_MS = 15000;
const GH_TIMEOUT_MS = 9000;
const GIT_TIMEOUT_MS = 6000;
/** ssh 与本机自扫共用。整条 `dao now` 15 秒预算，这一路必须短于它；不许靠放宽超时掩盖复杂度。 */
export const SCAN_TIMEOUT_MS = 11000;
const SSH_TIMEOUT_MS = SCAN_TIMEOUT_MS;

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

const PR_FIELDS = 'number,title,isDraft,reviewDecision,headRefOid,headRefName,mergeable,createdAt,updatedAt,labels';

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
  const r = await run('gh', ['issue', 'list', '--state', 'open', '--limit', String(limit), '--json', 'number,title,labels,createdAt,updatedAt'], { cwd });
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

export function localRegistryDirs({ repoRoot, worktreePaths = [], home = homedir() } = {}) {
  const dirs = new Set();
  if (repoRoot) dirs.add(join(repoRoot, '_flow', 'mirasim'));
  // 真实写入方的落点（dao.mjs mirasimRegistry 的 flowDir）。少了它，「登记在哪」与「去哪找」
  // 就是两条各写各的真相源——2026-09-14 实测：81 份登记在 ~/.dao/mirasim/，候选目录里 0 份。
  if (home) dirs.add(join(home, '.dao', 'mirasim'));
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

const OID_RE = /^[0-9a-f]{40}$/i;

/**
 * 本机登记有 treePath 就就地读 HEAD。lookup(treePath) → {scanned:true, oid} | {scanned:false, error}。
 * 已有 scanned:true 的不覆盖；无路径 / 读失败才 scanned:false。零写入。
 */
export function fillTreeHeads(items, lookup) {
  if (!Array.isArray(items)) return items;
  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    if (it.treeHead && it.treeHead.scanned === true) continue;
    const p = it.treePath == null ? '' : String(it.treePath).trim();
    if (!p) {
      it.treeHead = { scanned: false, error: '登记没写路径，审官树 HEAD 无从读' };
      continue;
    }
    it.treeHead = lookup(p);
  }
  return items;
}

function defaultRunGit(treePath) {
  const r = spawnSync('git', ['-c', 'safe.directory=*', '-C', treePath, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: GIT_TIMEOUT_MS,
  });
  if (r.error) return { ok: false, error: String(r.error.message || r.error) };
  if (r.status !== 0) {
    return { ok: false, error: String(r.stderr || '').trim().slice(0, 160) || `git 退出 ${r.status}` };
  }
  return { ok: true, out: r.stdout };
}

/**
 * 读一棵审官树 HEAD。可注入 runGit / exists，测试不必真起 git 仓。
 * 只加 `-c safe.directory=*` 这一次调用，不 fetch、不改 config。
 */
export function lookupGitHead(treePath, { runGit = defaultRunGit, exists = existsSync } = {}) {
  const p = treePath == null ? '' : String(treePath).trim();
  if (!p) return { scanned: false, error: '登记没写路径，审官树 HEAD 无从读' };
  if (!exists(p)) return { scanned: false, error: `审官树 ${p} 不在（目录不存在，HEAD 没读到）` };
  let r;
  try { r = runGit(p); } catch (e) {
    return { scanned: false, error: `审官树 ${p} 的 HEAD 没读到：${String(e && e.message || e)}` };
  }
  if (!r || r.ok !== true) {
    return { scanned: false, error: `审官树 ${p} 的 HEAD 没读到：${(r && r.error) || 'git 没回'}` };
  }
  const oid = String(r.out || '').trim();
  if (!OID_RE.test(oid)) {
    return { scanned: false, error: `审官树 ${p} 的 HEAD 不是 40 位 hex（没查成）` };
  }
  return { scanned: true, oid };
}

// ── 服务器侧：登记 + 审官树 head + 活着的执行体（一次 ssh 拿全） ──────────────

// 远端脚本用单引号数组拼，绝不放进 JS 模板串——${…} 会被 JS 先吃掉（本机实咬：
// heredoc/模板串吃引号与反斜杠，今天四个工人里三个栽在这上面）。
// 两条实测（2026-09-04，本单踩的）：
//  1. `ssh contabo` 登进去是 **root**，$HOME=/root，而树都在 /home/orca —— 只按 $HOME 找必然 0 命中；
//     所以候选根是一串（$HOME / /home/orca / /root），扫到哪个算哪个。
//  2. root 读 orca 的仓，git 报 dubious ownership 直接 fatal —— 每次调用现加
//     `-c safe.directory="*"`（只影响这一次调用，不写任何配置，本动词零写入）。
/** 从登记 JSON 抽 treePath。必须吃 pretty JSON 的空格（`"treePath": "/p"`）；旧 grep 无空格会漏。 */
export const TREE_PATH_SED = 's/.*"treePath"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p';

/**
 * 吃 `ls -l /proc/PID/cwd` 的 stdout：有 ` -> path` 才是读得成的 cwd。
 * 沿 cwd 往上走，命中 TPLIST 里的登记树 = 原 `case "$cwd" in "$tp"|"$tp"/*`。
 * 不在 shell 里对每个 pid 再扫一遍 TPLIST（231×114 次读文件会单独吃掉数秒）。
 */
export const PROC_AWK = [
  'BEGIN { while ((getline p < tplist) > 0) if (p != "") paths[p]=1; close(tplist) }',
  '{ n = index($0, "/proc/"); if (n == 0) next;',
  'rest = substr($0, n + 6); arrow = index(rest, "/cwd -> "); if (arrow == 0) next;',
  'pid = substr(rest, 1, arrow - 1); if (pid !~ /^[0-9]+$/) next;',
  'cwd = substr(rest, arrow + 8); cur = cwd; depth = 0;',
  'while (cur != "" && depth++ < 64) {',
  'if (cur in paths) { printf "PROC\\t%s\\t%s\\n", pid, cwd; break }',
  'if (cur == "/") break;',
  'pos = 0; for (i = length(cur); i > 0; i--) { if (substr(cur, i, 1) == "/") { pos = i; break } }',
  'if (pos <= 1) cur = "/"; else cur = substr(cur, 1, pos - 1);',
  '} }',
].join(' ');

export const REMOTE_SCRIPT = [
  'set -u',
  'TPLIST=$(mktemp 2>/dev/null || echo /tmp/now-collect-tp.$$)',
  'DLIST=$(mktemp 2>/dev/null || echo /tmp/now-collect-d.$$)',
  ': > "$TPLIST"',
  ': > "$DLIST"',
  // 候选根会互相重叠（`$HOME` 与 `/home/orca` 在本机是同一个目录），不去重就会把同一批文件
  // 扫两遍。treePath 用整目录一次 sed，不要逐份起 python3——2026-09-16 实咬：117 份登记
  // × 解释器启动 ≈ 6.3s，再加 /proc 就把 11 秒预算打爆，自扫天天超时。
  'for root in "$HOME" /home/orca /root; do',
  '  for d in "$root"/windsurf-dao/_flow/mirasim "$root"/wt-*/_flow/mirasim "$root"/mirasim-worktrees/*/*/_flow/mirasim "$root"/.dao/mirasim; do',
  '    case "$d" in *"*"*) continue;; esac',
  '    printf "%s\\n" "$d" >> "$DLIST"',
  '  done',
  'done',
  'sort -u "$DLIST" -o "$DLIST" 2>/dev/null || true',
  'while IFS= read -r d; do',
  '  [ -n "$d" ] || continue',
  '  if [ ! -d "$d" ]; then printf "DIRMISS\\t%s\\n" "$d"; continue; fi',
  '  printf "DIROK\\t%s\\n" "$d"',
  '  any=',
  '  for f in "$d"/reviewer-*.json; do',
  '    [ -f "$f" ] || continue',
  '    any=1',
  '    printf "REG\\t%s\\t%s\\n" "$f" "$(base64 -w0 < "$f")"',
  '  done',
  '  if [ -n "$any" ]; then',
  ['    sed -n \'', TREE_PATH_SED, '\' "$d"/reviewer-*.json >> "$TPLIST" || true'].join(''),
  '  fi',
  'done < "$DLIST"',
  'rm -f "$DLIST"',
  'sort -u "$TPLIST" -o "$TPLIST" 2>/dev/null || true',
  'while IFS= read -r tp; do',
  '  [ -n "$tp" ] || continue',
  '  if [ ! -d "$tp" ]; then printf "TREE\\t%s\\t-\\n" "$tp"; continue; fi',
  '  oid=$(git -c safe.directory="*" -C "$tp" rev-parse HEAD 2>/dev/null) || oid=-',
  '  printf "TREE\\t%s\\t%s\\n" "$tp" "$oid"',
  'done < "$TPLIST"',
  'for t in "$HOME"/mirasim-worktrees/*/* /home/orca/mirasim-worktrees/*/*; do',
  '  case "$t" in *"*"*) continue;; esac',
  '  [ -e "$t/.git" ] || continue',
  '  oid=$(git -c safe.directory="*" -C "$t" rev-parse HEAD 2>/dev/null) || oid=-',
  '  printf "TREE\\t%s\\t%s\\n" "$t" "$oid"',
  'done',
  ['ls -l /proc/[0-9]*/cwd 2>/dev/null | awk -v tplist="$TPLIST" \'', PROC_AWK, '\''].join(''),
  'rm -f "$TPLIST"',
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

/** 把远端 TREE 表贴到登记上。登记 treePath 不在表里 = 没查成（漏扫必须可见）。 */
export function attachRemoteTreeHeads(regs, trees) {
  const map = trees instanceof Map ? trees : new Map();
  return (Array.isArray(regs) ? regs : []).map((reg) => {
    const p = reg && reg.treePath ? String(reg.treePath) : '';
    if (p && map.has(p)) return { ...reg, treeHead: { scanned: true, oid: map.get(p) } };
    return {
      ...reg,
      treeHead: { scanned: false, error: `审官树 ${p || '(登记里没写路径)'} 的 HEAD 没读到` },
    };
  });
}

/**
 * 本机就是服务器时，ssh 到自己是纯开销，而且一旦这个主机名解析不了，整条观测面
 * 会**静默退化成「全都没查成」**——2026-09-14 实咬：这台机器上 `/etc/hosts` 没有
 * `contabo`（当初那个别名是手配的，装机文档里没有，换机/重置后必然丢），
 * 于是 `dao now` 报「审官会话没查成：连不上 contabo」，18 张 PR 全被挂上「要你拍」。
 *
 * 这里的兜底是**在 ssh 失败之后**才走：本机跑同一份 REMOTE_SCRIPT（`sh -s`，同一套
 * 目录与 /proc 判据），拿到的是一手数据，不是降级成空表。两条约束：
 *   · 只在 ssh 没成时才用，ssh 通了就以远端为准（真跨机部署时行为不变）；
 *   · 用了要说出来（`via: 'local-self-scan'`），别让「本机兜底」在盘面上长得像「远端正常」。
 */
export async function fetchLocalSelfScan({ cwd, runFn = run, timeout = SCAN_TIMEOUT_MS, script = REMOTE_SCRIPT } = {}) {
  const r = await runFn('sh', ['-s'], { cwd, timeout, input: script });
  if (!r.ok) return { registries: { scanned: false, error: `本机自扫起不来：${r.error}` }, sessions: { scanned: false, error: `本机自扫起不来：${r.error}` } };
  const p = parseRemoteScan(r.out);
  if (!p.ended) {
    const why = '本机自扫没跑完（输出没收到结束标记，按没查成算）';
    return { registries: { scanned: false, error: why }, sessions: { scanned: false, error: why } };
  }
  const items = attachRemoteTreeHeads(p.regs, p.trees);
  return {
    registries: { scanned: true, via: 'local-self-scan', items, dirsScanned: p.dirsScanned, dirsMissing: p.dirsMissing, bad: p.bad },
    sessions: { scanned: true, via: 'local-self-scan', items: p.procs },
  };
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
    // ssh 没成 ⇒ 名字解析不了时本机就是那台机器，自己扫一遍；扫不成仍按「没查成」如实报。
    const self = await fetchLocalSelfScan({ cwd });
    if (self.registries.scanned === true) return self;
    const why = `连不上 ${host}：${r.error}（本机自扫也没成：${self.registries.error || ''}）`;
    return { registries: { scanned: false, error: why }, sessions: { scanned: false, error: why } };
  }
  const p = parseRemoteScan(r.out);
  if (!p.ended) {
    const why = `${host} 的扫描没跑完（输出没收到结束标记，按没查成算）`;
    return { registries: { scanned: false, error: why }, sessions: { scanned: false, error: why } };
  }
  const items = attachRemoteTreeHeads(p.regs, p.trees);
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
  // 按落点去重：本机候选目录与远端脚本的候选根会重叠（本机就是服务器时更是同一批文件），
  // 不去重会让同一份登记出现两次。判官取 ts 最大的那份，重复不改变结论——但它让
  // 「候选目录几个」「登记几条」这些数失真，正是排查落点问题时唯一能用的那几个数。
  const seen = new Set();
  const items = [...(local.items || []), ...(remote.items || [])].filter((it) => {
    const k = it && it.from ? String(it.from) : null;
    if (!k) return true;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return {
    scanned: true,
    items,
    dirsScanned: [...new Set([...(local.dirsScanned || []), ...(remote.dirsScanned || [])])],
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
  fillTreeHeads(localReg.items, (p) => lookupGitHead(p));

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
