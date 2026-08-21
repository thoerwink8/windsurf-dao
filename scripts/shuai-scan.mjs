#!/usr/bin/env node
// scripts/shuai-scan.mjs —— 帅位看门狗 CLI（chain:shuai-watchdog#1）
//
// 纯采集 + 纯判定，零 AI。有事 stdout 首行 AGENT_LOOP_TICK_PANMIAN；无事零输出 exit 0；
// 没扫成 stderr + 非零，不许输出 sentinel。
//
// Orca 只读：直接 runOrca 调 worktree ps / worker-list / run-list / inbox / terminal list，
// 判定走 planRunGc（同 dao.mjs run-gc 干跑，不 --apply）。不 subprocess dao.mjs，避免误触副作用。
//
// GitHub：单次 gh api graphql 聚合 open issues + open PRs（120s 一轮，账号级配额见 github-quota-is-account-wide）。

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { runOrca } from './lib/orca-run.mjs';
import { ghExecutable } from './lib/gh.mjs';
import {
  SENTINEL,
  DEFAULT_REPO,
  loadRulesFile,
  collectOrcaBoard,
  evaluateScan,
  buildGithubGraphqlArgs,
  parseGithubGraphqlResponse,
} from './lib/shuai-scan.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_RULES = join(ROOT, 'docs', 'shuai-scan-rules.json');

function parseArgs(argv) {
  const args = {
    repo: process.env.SHUAI_SCAN_REPO || DEFAULT_REPO,
    rules: process.env.SHUAI_SCAN_RULES || DEFAULT_RULES,
    help: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--repo') args.repo = argv[++i] || '';
    else if (a === '--rules') args.rules = argv[++i] || '';
  }
  return args;
}

function fail(msg, code = 1) {
  console.error(String(msg || '帅位扫描失败').trim());
  process.exit(code);
}

function runGh(args) {
  const r = spawnSync(ghExecutable(), args, {
    encoding: 'utf8',
    cwd: ROOT,
    windowsHide: true,
    timeout: 45000,
    env: process.env,
  });
  if (r.error) return { ok: false, error: `gh 不可用：${r.error.message}` };
  if (r.status !== 0) {
    return { ok: false, error: String(r.stderr || r.stdout || `gh exit ${r.status}`).trim().slice(0, 240) };
  }
  return { ok: true, out: String(r.stdout || '') };
}

function collectGithub(repo) {
  const spec = buildGithubGraphqlArgs(repo);
  if (!spec.ok) return spec;
  const gh = runGh(spec.args);
  if (!gh.ok) return { ok: false, error: `GitHub 没扫成：${gh.error}` };
  const parsed = parseGithubGraphqlResponse(gh.out);
  if (!parsed.ok) return parsed;
  return parsed;
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(`用法: node scripts/shuai-scan.mjs [--repo owner/name] [--rules path]

有事 → stdout 首行 ${SENTINEL} + 摘要；无事 → 零输出 exit 0；
没扫成 → stderr + 非零（不许输出 sentinel）。

环境变量：SHUAI_SCAN_REPO / SHUAI_SCAN_RULES`);
    process.exit(0);
  }

  const rulesLoaded = loadRulesFile(args.rules);
  if (!rulesLoaded.ok) fail(rulesLoaded.error);

  const github = collectGithub(args.repo);
  if (!github.ok) fail(github.error);

  const orca = collectOrcaBoard({ runOrca: (cmd) => runOrca(cmd, { cwd: ROOT }), root: ROOT });
  if (!orca.ok) fail(orca.error);

  const result = evaluateScan({ rules: rulesLoaded.rules, orca, github });
  if (!result.ok) fail(result.error);

  if (!result.wake) process.exit(0);

  process.stdout.write(`${SENTINEL}\n${result.summary}\n`);
  process.exit(0);
}

main();
