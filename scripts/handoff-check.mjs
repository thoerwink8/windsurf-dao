#!/usr/bin/env node
// scripts/handoff-check.mjs —— 交卷前的契约闸（issue #904）
//
// 病：2026-09-04 九张 open PR，九张全被判 CHANGES_REQUESTED。而每个工人交卷时
// 全套测试 0 失败、dao-check exit 0、脱敏零命中、变异自证翻红复原——**全绿，然后全红**。
// 因为工人自证的是「我写的代码对不对」，审官核的是「它跟仓里既成事实对不对」，
// 而工人的闸里一道核后者的都没有。四个红没有一个是「代码写错」。
//
// 药：交卷前跑这一条，红则不得交卷。核的全是「本分支与 master / 与远端的关系」，
// 一件都不核本树自洽——那是 dao-check 和单元测试的活，重复做只会多花时间不多抓一条。
//
// 退出码三态（照 scripts/server-check.mjs 的惯例，不许把没查成当通过）：
//   0 = 四件都查过且通    1 = 有真红（查成了，结果不对）    2 = 有没查成（判不了 ⇒ 不放行）
//
// 用法：
//   node scripts/handoff-check.mjs                    交卷前在自己的树里跑
//   node scripts/handoff-check.mjs --json             一行 JSON（给脚本读）
//   node scripts/handoff-check.mjs --no-fetch         不联网（① 最多只能判到「没查成」）
//   node scripts/handoff-check.mjs --body-file <路径>  拿本地文件当 PR 正文核删除说明
//   node scripts/handoff-check.mjs --repo <路径> [--head <ref>] [--base <ref>]
//                                                    在别的仓 / 别的历史点上复跑（做样本用）
//
// 检查器纪律（CLAUDE.md「自动检查」）：
//  · 不复用被检查对象自己的解析——只吃 git 的 porcelain 输出，不 import 仓内任何 git 封装。
//  · 判据全在 scripts/lib/handoff-check.mjs 的纯函数里，本文件只负责采集事实。
//  · 每条 git 命令失败都显形成「没查成」，绝不静默跳过判绿。
//  · 不写任何文件——检查器的输出不能落进它自己会读的范围。

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  OK, RED, UNKNOWN,
  judgeBaseFreshness, judgeReverseDeletions, judgePointers, judgeHandoffBaseline,
  extractRepoPointers, verdictFromItems, COVERAGE_GAPS,
} from './lib/handoff-check.mjs';

const HERE = fileURLToPath(import.meta.url);

/** 跑一条命令，永不抛。probed=false 表示这次没跑成（不是「跑了没事」）。 */
function run(cmd, args, { cwd, timeout = 120000 } = {}) {
  const r = spawnSync(cmd, args, { cwd, windowsHide: true, encoding: 'utf8', timeout, maxBuffer: 1 << 28 });
  if (r.error) return { probed: false, reason: `${cmd} 起不来：${r.error.code || r.error.message}` };
  if (r.signal) return { probed: false, reason: `${cmd} 被信号打断：${r.signal}（可能超时 ${timeout}ms）` };
  return {
    probed: true,
    code: r.status,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    reason: r.status === 0 ? '' : `${cmd} ${args.slice(0, 3).join(' ')} 退出 ${r.status}：${String(r.stderr || '').trim().slice(0, 160)}`,
  };
}

function lines(text) {
  return String(text || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

// ---------------------------------------------------------------------------
// 事实采集
// ---------------------------------------------------------------------------

function collect(opts) {
  const git = (args, o) => run('git', ['-C', opts.repo, ...args], o);

  // 基线 ref：默认 origin/master，解不出再试 origin/main。解不出就是没查成，不许退回本地 master
  // ——本地 master 是「我上次看到的 master」，拿它当基线等于把本单要防的病当成判据。
  const baseCandidates = opts.base ? [opts.base] : ['origin/master', 'origin/main'];
  let baseRef = null;
  let fetched = false;
  let fetchError = '';
  for (const cand of baseCandidates) {
    const m = /^origin\/(.+)$/.exec(cand);
    if (m && !opts.noFetch) {
      // 显式 refspec + 强制：`git fetch origin master` 在某些配置下只更新 FETCH_HEAD，
      // 不动 refs/remotes/origin/master，那样判的还是缓存。
      const f = git(['fetch', '--quiet', 'origin', `+refs/heads/${m[1]}:refs/remotes/origin/${m[1]}`], { timeout: 120000 });
      if (f.probed && f.code === 0) fetched = true;
      else fetchError = f.reason || f.stderr || '拉取失败';
    }
    const v = git(['rev-parse', '--verify', '--quiet', `${cand}^{commit}`]);
    if (v.probed && v.code === 0 && v.stdout.trim()) { baseRef = cand; break; }
  }
  if (opts.noFetch) fetchError = '本次带了 --no-fetch，没拉远端';

  const headRef = opts.head || 'HEAD';
  const headSha = (() => {
    const r = git(['rev-parse', '--verify', `${headRef}^{commit}`]);
    return r.probed && r.code === 0 ? r.stdout.trim() : null;
  })();

  const facts = { repo: opts.repo, baseRef: baseRef || baseCandidates[0], headRef, headSha, fetched, fetchError };

  // ① 基底新旧
  if (!baseRef || !headSha) {
    facts.base = { baseRef: facts.baseRef, baseResolved: false };
  } else {
    const anc = git(['merge-base', '--is-ancestor', baseRef, headSha]);
    const isAncestor = !anc.probed ? null : anc.code === 0 ? true : anc.code === 1 ? false : null;
    let missingCommits = [];
    let missingFiles = [];
    if (isAncestor === false) {
      const log = git(['log', '--format=%H%x09%s', '-n', '200', `${headSha}..${baseRef}`]);
      if (log.probed && log.code === 0) {
        missingCommits = lines(log.stdout).map((l) => {
          const [sha, ...rest] = l.split('\t');
          return { sha, subject: rest.join('\t') };
        });
      }
      const df = git(['diff', '--name-only', `${headSha}...${baseRef}`]);
      if (df.probed && df.code === 0) missingFiles = lines(df.stdout);
    }
    facts.base = { baseRef, baseResolved: true, fetched, fetchError, isAncestor, missingCommits, missingFiles };
  }

  // ② 反向删除（必须三点：merge-base…HEAD，见 lib 里的说明）
  if (!baseRef || !headSha) {
    facts.deletions = { baseRef: facts.baseRef, deleted: null, deletedError: '基线或 HEAD 解不出来' };
  } else {
    const d = git(['diff', '--diff-filter=D', '--name-only', `${baseRef}...${headSha}`]);
    facts.deletions = d.probed && d.code === 0
      ? { baseRef, deleted: lines(d.stdout) }
      : { baseRef, deleted: null, deletedError: d.reason || '没跑成' };
  }

  // ④ 新增行里的仓内路径指针
  facts.pointers = collectPointers(git, baseRef, headSha, opts);

  // ⑤ 自证基线 = 审官所见
  facts.baseline = collectBaseline(git, opts, headRef);

  return facts;
}

function collectPointers(git, baseRef, headSha, opts) {
  if (!baseRef || !headSha) return { scanError: '基线或 HEAD 解不出来' };
  const d = git(['diff', '-U0', '--no-color', `${baseRef}...${headSha}`]);
  if (!d.probed || d.code !== 0) return { scanError: d.reason || '没跑成' };

  const added = [];
  let cur = '';
  for (const raw of String(d.stdout).split(/\r?\n/)) {
    if (raw.startsWith('+++ b/')) { cur = raw.slice(6); continue; }
    if (raw.startsWith('+++') || raw.startsWith('---') || raw.startsWith('@@') || raw.startsWith('diff --git')) continue;
    if (raw.startsWith('+')) added.push({ file: cur, text: raw.slice(1) });
  }
  const pointers = extractRepoPointers(added);

  // 存在性只认**已提交的树**（git ls-tree），不认工作区：审官看的是提交，不是你桌上的文件。
  // 一次 ls-tree 换 N 次 cat-file，顺带避免 Windows 上几十次进程启动的开销。
  const ls = git(['ls-tree', '-r', '--name-only', headSha]);
  if (!ls.probed || ls.code !== 0) return { scanError: `ls-tree 没跑成（${ls.reason || ''}）` };
  const present = new Set(lines(ls.stdout));
  const missing = pointers.filter((p) => !present.has(p.path));
  if (opts.verbose) {
    for (const p of pointers) console.error(`    [指针] ${present.has(p.path) ? '有' : '无'} ${p.path} <- ${p.file}`);
  }
  return { addedLineCount: added.length, pointers, missing };
}

function collectBaseline(git, opts, headRef) {
  // 只对「当前工作树的 HEAD」有意义：拿历史 ref 复跑时，本地脏不脏、推没推，跟那个 ref 无关。
  if (headRef !== 'HEAD') {
    return { skipped: true, reason: `--head ${headRef}：本条只对当前工作树有意义，历史复跑时判不了` };
  }
  const st = git(['status', '--porcelain']);
  if (!st.probed || st.code !== 0) return { statusError: st.reason || '没跑成' };
  const rows = String(st.stdout).split(/\r?\n/).filter((l) => l.trim());
  // 未跟踪只报数不判红：.mirasim/ 这类本机杂物常年在，判红等于让闸天天喊狼来了。
  const untrackedCount = rows.filter((l) => l.startsWith('??')).length;
  const dirtyTracked = rows.filter((l) => !l.startsWith('??')).map((l) => l.slice(3).trim());

  const br = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  const branch = br.probed && br.code === 0 ? br.stdout.trim() : '';
  const hd = git(['rev-parse', 'HEAD']);
  const localHead = hd.probed && hd.code === 0 ? hd.stdout.trim() : null;

  const remoteRef = branch && branch !== 'HEAD' ? `origin/${branch}` : '';
  let remoteHead = null;
  let remoteError = '';
  if (!remoteRef) {
    remoteError = '当前是游离 HEAD，没有分支名';
  } else {
    if (!opts.noFetch) {
      const f = git(['fetch', '--quiet', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`], { timeout: 120000 });
      if (!(f.probed && f.code === 0)) remoteError = '远端没有同名分支（或拉取失败）';
    }
    const rv = git(['rev-parse', '--verify', '--quiet', `${remoteRef}^{commit}`]);
    if (rv.probed && rv.code === 0 && rv.stdout.trim()) { remoteHead = rv.stdout.trim(); remoteError = ''; }
    else if (!remoteError) remoteError = `解不出 ${remoteRef}`;
  }
  return { branch, dirtyTracked, untrackedCount, localHead, remoteRef, remoteHead, remoteError };
}

/** PR 正文：只在真有删除时才去取（没删除就不必花这次网络调用）。 */
function loadPrBody(opts, facts) {
  if (opts.bodyFile) {
    try {
      return { prBody: readFileSync(opts.bodyFile, 'utf8'), prLabel: `正文文件 ${opts.bodyFile}` };
    } catch (e) {
      return { prBody: null, prBodyError: `读不到 ${opts.bodyFile}：${String(e.message).slice(0, 120)}` };
    }
  }
  const branch = facts.baseline && facts.baseline.branch;
  if (!branch) return { prBody: null, prBodyError: '没有分支名，查不到 PR' };
  const args = ['pr', 'view', branch, '--json', 'body', '-q', '.body'];
  const r = run('gh', args, { cwd: opts.repo, timeout: 60000 });
  if (!r.probed) return { prBody: null, prBodyError: r.reason };
  if (r.code !== 0) return { prBody: null, prBodyError: `gh pr view 退出 ${r.code}：${String(r.stderr).trim().slice(0, 140)}` };
  return { prBody: r.stdout, prLabel: `PR 正文（${branch}）` };
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { repo: process.cwd(), noFetch: false, json: false, verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '--no-fetch') opts.noFetch = true;
    else if (a === '--verbose') opts.verbose = true;
    else if (a === '--repo') opts.repo = argv[++i];
    else if (a === '--head') opts.head = argv[++i];
    else if (a === '--base') opts.base = argv[++i];
    else if (a === '--body-file') opts.bodyFile = argv[++i];
    else if (a === '--help' || a === '-h') opts.help = true;
    else { opts.badArg = a; }
  }
  return opts;
}

const USAGE = `用法：node scripts/handoff-check.mjs [--json] [--no-fetch] [--body-file <路径>]
                                   [--repo <路径>] [--head <ref>] [--base <ref>]
退出码：0 通 / 1 真红（不得交卷）/ 2 没查成（判不了，同样不得交卷）`;

export function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (opts.help) { console.log(USAGE); return 0; }
  if (opts.badArg) { console.error(`认不得的参数：${opts.badArg}\n${USAGE}`); return 2; }

  const top = run('git', ['-C', opts.repo, 'rev-parse', '--show-toplevel']);
  if (!top.probed || top.code !== 0) {
    console.error(`这里不是 git 仓（${opts.repo}）：${top.reason || top.stderr}`);
    return 2;
  }
  opts.repo = top.stdout.trim();

  const facts = collect(opts);

  const items = [];
  items.push({ id: '①', name: '基底含最新 master', ...judgeBaseFreshness(facts.base) });

  const delFacts = { ...facts.deletions };
  if (Array.isArray(delFacts.deleted) && delFacts.deleted.length) Object.assign(delFacts, loadPrBody(opts, facts));
  items.push({ id: '②', name: '相对 master 零删除', ...judgeReverseDeletions(delFacts) });

  items.push({ id: '④', name: '本分支新写的仓内指针都存在', ...judgePointers(facts.pointers) });

  if (facts.baseline.skipped) {
    items.push({ id: '⑤', name: '自证基线＝审官所见', state: UNKNOWN, detail: facts.baseline.reason });
  } else {
    items.push({ id: '⑤', name: '自证基线＝审官所见', ...judgeHandoffBaseline(facts.baseline) });
  }

  const v = verdictFromItems(items);
  const payload = {
    at: new Date().toISOString(),
    repo: facts.repo,
    branch: (facts.baseline && facts.baseline.branch) || facts.headRef,
    base: facts.baseRef,
    head: facts.headSha,
    fetched: facts.fetched,
    verdict: v.verdict,
    exit: v.exit,
    ok: v.ok, red: v.red, unknown: v.unknown,
    items: items.map((i) => ({ id: i.id, name: i.name, state: i.state, detail: i.detail })),
    coverageGaps: COVERAGE_GAPS,
  };

  if (opts.json) {
    console.log(JSON.stringify(payload));
  } else {
    console.log(`交卷闸：${payload.branch} vs ${payload.base}${facts.fetched ? '（已拉远端）' : '（未拉远端）'}`);
    for (const i of items) {
      const mark = i.state === OK ? '✓' : i.state === RED ? 'X' : '?';
      console.log(`  ${mark}  ${i.id} ${i.name} —— ${i.detail}`);
    }
    console.log(`\n判定：${v.verdict}（${v.ok} 通 / ${v.red} 红 / ${v.unknown} 没查成）`
      + `${v.exit === 0 ? '——可以交卷' : '——不得交卷（红=改完重跑；没查成=先让它查得成）'}`);
    console.log('\n本闸盖不到什么（跑绿≠契约没问题）：');
    for (const g of COVERAGE_GAPS) console.log(`  · ${g}`);
  }
  return v.exit;
}

const isDirectRun = process.argv[1] && resolve(process.argv[1]) === resolve(HERE);
if (isDirectRun) process.exit(main());

export { collect, parseArgs, RED, OK, UNKNOWN };
