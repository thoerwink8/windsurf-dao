#!/usr/bin/env node
// scripts/shuai-scan.mjs —— 帅位看门狗 CLI（chain:shuai-watchdog#1）
//
// 纯采集 + 纯判定，零 AI。有内容且相对上一轮有变化 → stdout 首行 AGENT_LOOP_TICK_PANMIAN + 摘要；
// 无变化或无可报内容 → 零输出 exit 0；没扫成 → stderr + 非零，不许输出 sentinel。
//
// 状态去重：哈希落盘 os.tmpdir()/shuai-scan-last.json（SHUAI_SCAN_STATE 可覆盖）。
// 帅位标题：摘要末行「帅位标题建议：…」；rename_chat 由帅被叫醒后执行。

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { runOrca } from './lib/orca-run.mjs';
import { ghExecutable } from './lib/gh.mjs';
import {
  SENTINEL,
  DEFAULT_REPO,
  defaultStatePath,
  loadRulesFile,
  collectOrcaBoard,
  evaluateScan,
  decideOutput,
  readLastState,
  writeLastState,
  buildGithubGraphqlArgs,
  parseGithubGraphqlResponse,
} from './lib/shuai-scan.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_RULES = join(ROOT, 'docs', 'shuai-scan-rules.json');

function parseArgs(argv) {
  const args = {
    repo: process.env.SHUAI_SCAN_REPO || DEFAULT_REPO,
    rules: process.env.SHUAI_SCAN_RULES || DEFAULT_RULES,
    state: process.env.SHUAI_SCAN_STATE || defaultStatePath(),
    help: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--repo') args.repo = argv[++i] || '';
    else if (a === '--rules') args.rules = argv[++i] || '';
    else if (a === '--state') args.state = argv[++i] || '';
  }
  return args;
}

function fail(msg, code = 1) {
  console.error(String(msg || '帅位扫描失败').trim());
  process.exit(code);
}

function runGh(args) {
  const r = spawnSync(ghExecutable(), args, { windowsHide: true,
    encoding: 'utf8',
    cwd: ROOT,
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
    console.log(`用法: node scripts/shuai-scan.mjs [--repo owner/name] [--rules path] [--state path]

有内容且相对上一轮有变化 → stdout 首行 ${SENTINEL} + 摘要（含帅位标题建议行）；
无变化或无可报内容 → 零输出 exit 0；
没扫成 → stderr + 非零（不许输出 sentinel）。

环境变量：SHUAI_SCAN_REPO / SHUAI_SCAN_RULES / SHUAI_SCAN_STATE`);
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

  const lastState = readLastState(args.state);
  const decision = decideOutput({ result, lastState });
  if (!decision.ok) fail(decision.error);

  if (!decision.emit) {
    process.exit(0);
  }

  const written = writeLastState(args.state, {
    hash: result.stateHash,
    summary: result.summary,
  });
  if (!written.ok) fail(written.error);

  process.stdout.write(`${SENTINEL}\n${result.summary}\n`);
  process.exit(0);
}

main();
