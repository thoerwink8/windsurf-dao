// dao-sync 编排器：cc-switch DB ↔ 仓库 snapshot ↔ GitHub(origin) 三层同步的唯一入口。
//
// 设计要点（见 docs/specs 与 PR 说明）：
//   - 三层不是两层：DB ↔ 工作区 snapshot ↔ origin。每个方向动手前必先 git fetch 看分叉。
//   - 真相源：origin = 共享配置唯一真相，cc-switch DB = 本地缓存。下行(默认安全)/上行(慎重)。
//   - 三档护栏：
//       🔴 硬拦  —— 直接拒绝执行（上行时本机落后 origin = 今天 bug 的命门）。
//       🟡 确认  —— 摊开 diff，交互需点 yes / 非交互需 --yes 才动。
//       🟢 提示  —— 只告知不挡路（如还原后重启 cc-switch）。
//
// 用法：
//   node lib/sync.mjs                      交互式菜单
//   node lib/sync.mjs --direction=down [--scope=all|settings,mcp] [--yes] [--dry-run] [--no-fetch]
//   node lib/sync.mjs --direction=up   [--scope=...] [--yes] [--dry-run] [--message="..."]

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { projectRoot, snapshotPaths, readJsonIfExists } from './paths.mjs';
import { selectRows, tableExists, stableJson } from './sqlite.mjs';
import { runExport, redactSettings } from './export.mjs';
import { runRestore } from './restore.mjs';
import { SCOPES, SCOPE_KEYS, parseScope, describeScope } from './scope.mjs';

const HARD = '🔴';
const CONFIRM = '🟡';
const NOTIFY = '🟢';

// ---------- 参数 ----------

function parseArgs(argv = process.argv.slice(2)) {
  const opts = { direction: null, scope: null, yes: false, dryRun: false, fetch: true, message: null, help: false, action: null };
  for (const arg of argv) {
    let m;
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--yes' || arg === '-y') opts.yes = true;
    else if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--no-fetch') opts.fetch = false;
    else if (arg === '--doctor') opts.action = 'doctor';
    else if (arg === '--inventory') opts.action = 'inventory';
    else if ((m = /^--direction=(.*)$/.exec(arg))) opts.direction = m[1].trim().toLowerCase();
    else if ((m = /^--(?:scope|only)=(.*)$/.exec(arg))) opts.scope = m[1];
    else if ((m = /^--message=(.*)$/.exec(arg))) opts.message = m[1];
  }
  return opts;
}

const libDir = path.dirname(fileURLToPath(import.meta.url));
// 转交给子脚本（doctor/inventory）。子脚本自己的退出码就是结果（doctor 发现问题会退 1），
// 原样透传，不当作 dao-sync 自身崩溃。
function runChild(scriptFile) {
  try {
    execFileSync('node', [path.join(libDir, scriptFile)], { cwd: projectRoot, stdio: 'inherit' });
    process.exit(0);
  } catch (error) {
    process.exit(typeof error.status === 'number' ? error.status : 1);
  }
}

function printHelp() {
  console.log(`dao-sync —— cc-switch DB ↔ 仓库 ↔ origin 同步

用法：
  node lib/sync.mjs                                    交互式（推荐）
  node lib/sync.mjs --direction=down [选项]            下行：origin → 本机 DB（默认安全）
  node lib/sync.mjs --direction=up   [选项]            上行：本机 DB → origin（慎重，落后即拒）

  node lib/sync.mjs --doctor                           只读体检（doctor）
  node lib/sync.mjs --inventory                        只读盘点（inventory）

选项：
  --scope=all|settings,mcp,skills,prompts,proxy             同步范围（默认 all）
  --yes        非交互模式下跳过确认（🟡 档护栏）
  --dry-run    只演练，不写 DB、不动 git
  --no-fetch   跳过 git fetch（离线时用，状态可能过时）
  --message    上行提交信息

scope 可选值：${SCOPE_KEYS.join(', ')}`);
}

// ---------- git ----------

function git(args, { allowFail = false } = {}) {
  try {
    return execFileSync('git', args, {
      cwd: projectRoot,
      encoding: 'utf8',
      timeout: 30000,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_PAGER: 'cat', GIT_TERMINAL_PROMPT: '0' },
    }).trim();
  } catch (error) {
    if (allowFail) return null;
    const detail = String(error.stderr || error.stdout || error.message || '').trim();
    throw new Error(`git ${args.join(' ')} 失败：${detail}`);
  }
}

function gitState({ fetch = true } = {}) {
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], { allowFail: true });
  let fetchError = null;
  if (fetch) {
    const ok = git(['fetch', '--quiet'], { allowFail: true });
    if (ok === null) fetchError = '（git fetch 失败：可能离线/无凭证；以下基于上次已知 origin）';
  }
  const upstream = git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], { allowFail: true });
  const hasUpstream = Boolean(upstream);
  let ahead = 0;
  let behind = 0;
  if (hasUpstream) {
    const lr = git(['rev-list', '--left-right', '--count', '@{u}...HEAD'], { allowFail: true });
    if (lr) {
      const [b, a] = lr.split(/\s+/).map((n) => parseInt(n, 10) || 0);
      behind = b;
      ahead = a;
    }
  }
  const dirtyOut = git(['status', '--porcelain'], { allowFail: true }) || '';
  const dirtyFiles = dirtyOut.split('\n').map((s) => s.trim()).filter(Boolean);
  return { branch, upstream, hasUpstream, ahead, behind, dirty: dirtyFiles.length > 0, dirtyFiles, fetchError };
}

// DB 通用配置 vs 仓库 snapshot 是否一致（把 DB 行按 export 同样的脱敏+占位再比）。
// 返回 { available, status: 'same'|'diff'|'no-table'|'no-snapshot' }。
function settingsConsistency() {
  try {
    if (!tableExists('settings')) return { available: true, status: 'no-table' };
    const dbRows = selectRows('settings', "WHERE key LIKE 'common_config_%' ORDER BY key");
    const { redactedRows } = redactSettings(dbRows);
    const snap = readJsonIfExists(snapshotPaths.settings, null);
    if (!snap) return { available: true, status: 'no-snapshot' };
    const snapRows = Array.isArray(snap.rows) ? snap.rows : [];
    const same = stableJson(redactedRows) === stableJson(snapRows);
    return { available: true, status: same ? 'same' : 'diff', dbCount: dbRows.length, snapCount: snapRows.length };
  } catch (error) {
    return { available: false, error: error.message };
  }
}

// ---------- 状态板 ----------

function printStateBoard(state, sc) {
  console.log('\n================ dao-sync 状态板 ================');
  console.log(`  分支        : ${state.branch || '(未知)'}`);
  console.log(`  upstream    : ${state.upstream || '(无 upstream)'}`);
  if (state.hasUpstream) {
    const aheadLabel = state.ahead > 0 ? `领先 ${state.ahead}` : '不领先';
    const behindLabel = state.behind > 0 ? `落后 ${state.behind}` : '不落后';
    console.log(`  与 origin   : ${behindLabel} / ${aheadLabel}`);
  } else {
    console.log('  与 origin   : 无 upstream，无法比对（git branch --set-upstream-to=origin/<branch>）');
  }
  console.log(`  工作区      : ${state.dirty ? `有 ${state.dirtyFiles.length} 处未提交改动` : '干净'}`);
  if (sc.available) {
    const map = {
      same: 'DB 通用配置 与 仓库 snapshot 一致',
      diff: 'DB 通用配置 与 仓库 snapshot 不一致',
      'no-table': 'cc-switch 无 settings 表',
      'no-snapshot': '仓库无 settings snapshot',
    };
    console.log(`  DB↔snapshot : ${map[sc.status] || sc.status}`);
  } else {
    console.log(`  DB↔snapshot : 不可用（${sc.error}）`);
  }
  if (state.fetchError) console.log(`  ${state.fetchError}`);
  console.log('================================================\n');
}

// ---------- 交互 ----------

let rl = null;
function getRl() {
  if (!rl) rl = createInterface({ input: process.stdin, output: process.stdout });
  return rl;
}
function closeRl() {
  if (rl) { rl.close(); rl = null; }
}
async function ask(question) {
  return (await getRl().question(question)).trim();
}

// 🟡 确认门：交互问 y/N；非交互必须 --yes。
async function confirmGate(message, { interactive, yes }) {
  console.log(`\n${CONFIRM} ${message}`);
  if (!interactive) {
    if (yes) { console.log('  --yes 已确认，继续。'); return true; }
    console.log('  非交互模式且未加 --yes —— 已中止（不擅自动手）。');
    return false;
  }
  const answer = (await ask('  确认继续？(y/N) ')).toLowerCase();
  return answer === 'y' || answer === 'yes';
}

function hardBlock(message) {
  console.error(`\n${HARD} 硬拦：${message}`);
  closeRl();
  process.exit(2);
}

// ---------- 方向 ----------

async function chooseAction() {
  console.log('选操作：');
  console.log('  [1] 下行  origin → 本机 cc-switch（默认 / 安全：拉最新配置进本机）');
  console.log('  [2] 上行  本机 cc-switch → origin（慎重：把本机配置发布到 GitHub）');
  console.log('  [3] 体检  doctor（只读检查 DB / snapshot / 各端一致性）');
  console.log('  [4] 盘点  inventory（只读盘存 skills / MCP 链接）');
  const answer = await ask('输入 1-4（回车默认 1）：');
  if (answer === '2' || answer === 'up') return 'up';
  if (answer === '3') return 'doctor';
  if (answer === '4') return 'inventory';
  return 'down';
}

async function chooseScope() {
  console.log('\n选范围（同步什么）：');
  console.log('  [0] 全部');
  SCOPES.forEach((s, i) => console.log(`  [${i + 1}] ${s.key} —— ${s.label}`));
  const answer = await ask('输入编号，逗号分隔多选（回车默认全部）：');
  if (!answer || answer === '0' || answer.toLowerCase() === 'all') return null;
  const keys = answer.split(',').map((t) => t.trim()).filter(Boolean).map((t) => {
    const idx = parseInt(t, 10);
    if (!Number.isNaN(idx) && idx >= 1 && idx <= SCOPES.length) return SCOPES[idx - 1].key;
    return t.toLowerCase();
  });
  return parseScope(keys.join(','));
}

async function runDown({ only, state, interactive, yes, dryRun }) {
  console.log(`\n>>> 下行：origin → 本机 cc-switch（范围：${describeScope(only)}）`);

  if (state.dirty) {
    const ok = await confirmGate(
      `工作区有 ${state.dirtyFiles.length} 处未提交改动，下行可能与之冲突。建议先提交或丢弃。是否仍继续？`,
      { interactive, yes },
    );
    if (!ok) { console.log('已中止。'); return 0; }
  }

  if (state.hasUpstream && state.ahead > 0) {
    console.log(`\n${CONFIRM} 提示：本机领先 origin ${state.ahead} 个未推送提交；下行只拉 origin，不会动这些本地提交。`);
  }

  if (state.hasUpstream && state.behind > 0) {
    console.log(`\n本机落后 origin ${state.behind} 个提交，先 git pull --ff-only 对齐 origin……`);
    if (dryRun) {
      console.log('  [dry-run] 跳过 git pull。');
    } else {
      const pulled = git(['pull', '--ff-only'], { allowFail: true });
      if (pulled === null) {
        hardBlock('git pull --ff-only 失败：本机与 origin 已分叉（无法快进）。请先手动 reconcile（rebase/merge）再来同步，避免旧盖新。');
      }
      console.log('  已对齐 origin。');
    }
  } else if (state.hasUpstream) {
    console.log('\n本机未落后 origin，无需 pull。');
  }

  if (dryRun) {
    console.log(`\n[dry-run] 接下来会：runRestore(${describeScope(only)}) 把 snapshot 写入 cc-switch DB（会先自动备份 DB）。`);
    return 0;
  }

  console.log('\n写入 cc-switch DB……');
  runRestore({ only });
  console.log(`\n${NOTIFY} 完成。请重启 cc-switch，并切换一次 provider，让它把配置重新下发到 ~/.claude/settings.json 等各端。`);
  return 0;
}

async function runUp({ only, state, interactive, yes, dryRun, message }) {
  console.log(`\n>>> 上行：本机 cc-switch → origin（范围：${describeScope(only)}）`);

  if (!state.hasUpstream) {
    hardBlock('当前分支没有 upstream，无法安全发布。请先 git branch --set-upstream-to=origin/<branch>。');
  }
  // 命门护栏：落后 origin 时绝不允许导出并提交，否则会用旧 DB 盖掉 origin 上的新配置（今天的 bug）。
  if (state.behind > 0) {
    hardBlock(`本机落后 origin ${state.behind} 个提交。若现在上行，会用本机（可能陈旧）的配置盖掉 origin 上更新的版本。请先走「下行」或 git pull 对齐，再上行。`);
  }

  if (dryRun) {
    console.log('\n[dry-run] 接下来会：runExport 导出到 snapshot → 展示 diff → 确认 → git commit → git push（仅 config-sync/common）。');
    return 0;
  }

  console.log('\n从 cc-switch DB 导出到仓库 snapshot……');
  runExport({ only });

  // 导出后看仓库里 snapshot 改了什么（common-secrets.json 被 .gitignore，不会进来）。
  const changed = git(['status', '--porcelain', '--', 'config-sync/common'], { allowFail: true }) || '';
  const changedFiles = changed.split('\n').map((s) => s.trim()).filter(Boolean);
  if (!changedFiles.length) {
    console.log('\n仓库 snapshot 与 DB 已一致，没有需要发布的改动。');
    return 0;
  }
  console.log('\n本次将发布的 snapshot 改动：');
  console.log(git(['diff', '--stat', '--', 'config-sync/common'], { allowFail: true }) || changed);

  const ok = await confirmGate('确认把以上改动提交并 push 到 origin？', { interactive, yes });
  if (!ok) {
    console.log('已中止（仓库工作区已更新但未提交，可自行 git checkout 丢弃或手动提交）。');
    return 0;
  }

  const commitMessage = message || `[cc] chore(config-sync): sync cc-switch → snapshot (${describeScope(only)})`;
  // 只提交 snapshot 路径，避免裹进无关的已暂存改动。
  git(['commit', '-m', commitMessage, '--', 'config-sync/common']);
  console.log('\n推送到 origin……');
  const pushed = git(['push'], { allowFail: true });
  if (pushed === null) {
    hardBlock('git push 失败（可能 origin 又有新提交）。请 git pull 对齐后重试。本地已提交，不会丢失。');
  }
  console.log(`\n${NOTIFY} 已发布到 origin：${commitMessage}`);
  return 0;
}

// ---------- 主流程 ----------

async function main() {
  const opts = parseArgs();
  if (opts.help) { printHelp(); return; }

  const interactive = !opts.direction;

  let only;
  try {
    only = parseScope(opts.scope);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }

  // 纯只读体检/盘点：直接转交，不需状态板/方向。
  if (opts.action === 'doctor') { runChild('doctor.mjs'); return; }
  if (opts.action === 'inventory') { runChild('inventory.mjs'); return; }

  const state = gitState({ fetch: opts.fetch });
  const sc = settingsConsistency();
  printStateBoard(state, sc);

  const action = opts.direction || (await chooseAction());
  if (action === 'doctor') { closeRl(); runChild('doctor.mjs'); return; }
  if (action === 'inventory') { closeRl(); runChild('inventory.mjs'); return; }
  const direction = action;
  if (!['up', 'down'].includes(direction)) {
    console.error(`未知方向：${direction}（应为 up 或 down）`);
    process.exit(1);
  }

  if (interactive && only === null && opts.scope === null) {
    only = await chooseScope();
  }

  if (opts.dryRun) console.log('\n*** dry-run 模式：不会写 DB、不会动 git ***');

  let code = 0;
  if (direction === 'down') {
    code = await runDown({ only, state, interactive, yes: opts.yes, dryRun: opts.dryRun });
  } else {
    code = await runUp({ only, state, interactive, yes: opts.yes, dryRun: opts.dryRun, message: opts.message });
  }

  closeRl();
  process.exit(code);
}

main().catch((error) => {
  console.error(`dao-sync 失败：${error.message}`);
  closeRl();
  process.exit(1);
});
