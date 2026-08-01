// dao 编排器：cc-switch DB ↔ 仓库 snapshot ↔ GitHub(origin) 三层同步的唯一入口。
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

import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { projectRoot, snapshotPaths, readJsonIfExists, ccSwitchDbPath } from './paths.mjs';
import { selectRows, tableExists, stableJson, ensureSqlite3, bootstrapDb } from './sqlite.mjs';
import { runExport, redactSettings } from './export.mjs';
import { runRestore } from './restore.mjs';
import { SCOPES, SCOPE_KEYS, parseScope, describeScope } from './scope.mjs';
import { commonSecretsPath, countPlaceholders } from './secrets.mjs';

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
    else if (arg === '--goal-health') opts.action = 'goal-health';
    else if (arg === '--persona') opts.action = 'persona';
    else if (arg === '--deploy') opts.action = 'deploy';
    else if (arg === '--status') opts.action = 'status';
    else if (arg === '--pack') opts.action = 'pack';
    else if ((m = /^--direction=(.*)$/.exec(arg))) opts.direction = m[1].trim().toLowerCase();
    else if ((m = /^--(?:scope|only)=(.*)$/.exec(arg))) opts.scope = m[1];
    else if ((m = /^--message=(.*)$/.exec(arg))) opts.message = m[1];
  }
  return opts;
}

const libDir = path.dirname(fileURLToPath(import.meta.url));
// 转交给子脚本（doctor/inventory）。子脚本自己的退出码就是结果（doctor 发现问题会退 1），
// 原样透传，不当作 dao 自身崩溃。
function runChild(scriptFile) {
  try {
    execFileSync('node', [path.join(libDir, scriptFile)], { cwd: projectRoot, stdio: 'inherit' });
    process.exit(0);
  } catch (error) {
    process.exit(typeof error.status === 'number' ? error.status : 1);
  }
}

// 返回值：0=成功，非 0=失败。调用方（如 runDown）据此判断是否要把
// 「🟢 完成」降级成「⚠ 部署有失败」——此前静默吞掉非 0 退出码，用户看到的
// 永远是完成提示，即便 dao.ps1 link-claude 内部有 error（fortify2-20260726 D4）。
function runDaoPs1(action) {
  const daoPs1 = path.join(projectRoot, 'dao.ps1');
  try {
    execFileSync('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', daoPs1, action,
    ], { cwd: projectRoot, stdio: 'inherit', timeout: 60000 });
    return 0;
  } catch (error) {
    const code = typeof error.status === 'number' ? error.status : 1;
    if (code !== 0) console.error(`  dao.ps1 ${action} 失败（exit ${code}）：${error.message}`);
    return code;
  }
}

function runPack() {
  const packScript = path.join(projectRoot, 'scripts', 'dao-pack.ps1');
  try {
    execFileSync('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', packScript,
    ], { cwd: projectRoot, stdio: 'inherit', timeout: 120000 });
    process.exit(0);
  } catch (error) {
    process.exit(typeof error.status === 'number' ? error.status : 1);
  }
}

function printHelp() {
  console.log(`dao —— windsurf-dao 统一入口（配置同步 + 部署 + 状态）

用法：
  dao.bat                                         交互式菜单（推荐）
  dao.bat --direction=down [选项]                 下行：origin → 本机 DB + 部署（默认安全）
  dao.bat --direction=up   [选项]                 上行：本机 DB → origin（慎重，落后即拒）

  dao.bat --deploy                                仅重新部署 skills/commands/hooks 到 ~/.claude
  dao.bat --status                                dao 双栈链接健康矩阵
  dao.bat --doctor                                只读体检（doctor）
  dao.bat --inventory                             只读盘点（inventory）
  dao.bat --goal-health                           只读扫描 goal 任务健康（stale in-progress / 声称完成但状态未更新的 transcript 风险，Codex 用户）
  dao.bat --persona                               Claude Code persona 切换
  dao.bat --pack                                  打包分发安装包（zip，发给新用户）

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

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function gitWithRetry(args, { retries = 2, delay = 2000, allowFail = false } = {}) {
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    try {
      return git(args);
    } catch (error) {
      if (attempt <= retries) {
        const wait = delay * attempt;
        console.log(`  git ${args[0]} 失败（${attempt}/${retries + 1}）：${error.message.split('\n')[0]}`);
        console.log(`  ${wait}ms 后重试……`);
        sleepSync(wait);
      } else if (allowFail) {
        return null;
      } else {
        throw error;
      }
    }
  }
}

function gitState({ fetch = true } = {}) {
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], { allowFail: true });
  let fetchError = null;
  if (fetch) {
    const ok = gitWithRetry(['fetch', '--quiet'], { allowFail: true });
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
  console.log('\n================ dao 状态板 ================');
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

// ---------- 系统全貌 ----------

const home = os.homedir();
const claudeJsonPath = path.join(home, '.claude.json');
const claudeSettingsPath = path.join(home, '.claude', 'settings.json');
const personaStateFile = path.join(home, '.claude', 'persona', '.current-mode');
const personaActiveFile = path.join(home, '.claude', 'persona', 'active-system-prompt.md');
const claudeSkillsDir = path.join(home, '.claude', 'skills');

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^﻿/, ''));
  } catch { return null; }
}

function printDashboard() {
  console.log('──────────── 系统全貌 ────────────');

  // 1. MCP servers
  const cj = readJsonSafe(claudeJsonPath);
  const mcpNames = cj ? Object.keys(cj.mcpServers || {}) : [];
  if (mcpNames.length) {
    console.log(`  MCP (${mcpNames.length}):  ${mcpNames.join(' · ')}`);
  } else {
    console.log('  MCP:           无');
  }

  // 2. Skills
  let skillCount = 0;
  const skillNames = [];
  if (fs.existsSync(claudeSkillsDir)) {
    for (const entry of fs.readdirSync(claudeSkillsDir, { withFileTypes: true })) {
      if (entry.isDirectory() || entry.isSymbolicLink()) {
        skillNames.push(entry.name);
        skillCount++;
      }
    }
  }
  if (skillCount > 10) {
    console.log(`  Skills (${skillCount}): ${skillNames.slice(0, 8).join(' · ')} … +${skillCount - 8}`);
  } else if (skillCount > 0) {
    console.log(`  Skills (${skillCount}): ${skillNames.join(' · ')}`);
  } else {
    console.log('  Skills:        无');
  }

  // 3. Hooks
  const settings = readJsonSafe(claudeSettingsPath);
  if (settings?.hooks) {
    const hookEvents = Object.keys(settings.hooks);
    let hookTotal = 0;
    for (const ev of hookEvents) {
      const groups = settings.hooks[ev];
      if (Array.isArray(groups)) {
        for (const g of groups) hookTotal += (g.hooks || []).length;
      }
    }
    console.log(`  Hooks (${hookTotal}):  ${hookEvents.join(' · ')}`);
  } else {
    console.log('  Hooks:         无');
  }

  // 4. Model
  if (settings?.model) {
    console.log(`  Model:         ${settings.model}`);
  }

  // 5. Persona
  let personaMode = 'off';
  if (fs.existsSync(personaStateFile)) {
    personaMode = fs.readFileSync(personaStateFile, 'utf8').trim() || 'off';
  }
  let personaSize = '';
  if (personaMode !== 'off' && fs.existsSync(personaActiveFile)) {
    const bytes = fs.statSync(personaActiveFile).size;
    personaSize = ` (${(bytes / 1024).toFixed(1)}KB)`;
  }
  console.log(`  Persona:       ${personaMode}${personaSize}`);

  // 6. Plugins
  if (settings?.enabledPlugins) {
    const enabled = Object.entries(settings.enabledPlugins).filter(([, v]) => v).map(([k]) => k.split('@')[0]);
    if (enabled.length) {
      console.log(`  Plugins:       ${enabled.join(' · ')}`);
    }
  }

  console.log('──────────────────────────────────\n');
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
  console.log('  [1] 下行  拉取最新（git pull + 恢复配置 + 部署 skills/hooks）');
  console.log('  [2] 上行  发布配置（导出本机 → commit → push）');
  console.log('  [3] 部署  仅重新部署 skills/commands/hooks 到 ~/.claude（不动 DB/git）');
  console.log('  [4] 状态  dao 双栈链接健康矩阵');
  console.log('  [5] 体检  doctor（只读检查一致性）');
  console.log('  [6] 盘点  inventory（只读盘存）');
  console.log('  [7] persona 切换（dao / fable5 / off）');
  console.log('  [8] 打包  生成分发安装包（zip，发给新用户）');
  console.log('  [9] goal 任务体检（只读扫描 stale/transcript 风险，Codex 用户）');
  const answer = await ask('输入 1-9（回车默认 1）：');
  if (answer === '2' || answer === 'up') return 'up';
  if (answer === '3') return 'deploy';
  if (answer === '4') return 'status';
  if (answer === '5') return 'doctor';
  if (answer === '6') return 'inventory';
  if (answer === '7') return 'persona';
  if (answer === '8') return 'pack';
  if (answer === '9') return 'goal-health';
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
      const pulled = gitWithRetry(['pull', '--ff-only'], { allowFail: true });
      if (pulled === null) {
        hardBlock('git pull --ff-only 失败：本机与 origin 已分叉（无法快进）。请先手动 reconcile（rebase/merge）再来同步，避免旧盖新。');
      }
      console.log('  已对齐 origin。');
    }
  } else if (state.hasUpstream) {
    console.log('\n本机未落后 origin，无需 pull。');
  }

  if (dryRun) {
    console.log(`\n[dry-run] 下行预览（范围：${describeScope(only)}）：`);
    runRestore({ only, dryRun: true });
    return 0;
  }

  console.log('\n写入 cc-switch DB……');
  runRestore({ only });

  console.log('\n部署 dao skills/commands/agents/hooks 到 ~/.claude……');
  const deployCode = runDaoPs1('link-claude');

  if (deployCode === 0) {
    console.log(`\n${NOTIFY} 完成。请重启 cc-switch 并切换一次 provider 下发配置，然后重启 Claude Code 会话（/clear）生效。`);
    return 0;
  }
  console.log(`\n⚠ 部署有失败（dao.ps1 link-claude 退出码 ${deployCode}，具体失败项见上方 summary 行 error=N）。settings/skills/hooks 可能未完整生效，请修复后重跑 dao.bat --direction=down 或 dao.bat link-claude。`);
  return 1;
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
    console.log('\n[dry-run] 上行预览（不写 snapshot、不动 git）：');
    console.log('  步骤：runExport 导出 DB → snapshot → 展示 diff → 确认 → git commit → git push');
    console.log(`  范围：config-sync/common（${describeScope(only)}）`);
    console.log('  实际执行请去掉 --dry-run。');
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
  const pushed = gitWithRetry(['push'], { allowFail: true });
  if (pushed === null) {
    hardBlock('git push 失败（可能 origin 又有新提交）。请 git pull 对齐后重试。本地已提交，不会丢失。');
  }
  console.log(`\n${NOTIFY} 已发布到 origin：${commitMessage}`);
  return 0;
}

// ---------- persona ----------

const personaScript = path.join(projectRoot, 'ccswitch', 'persona', 'dao-persona-manager.ps1');

function runPersonaCmd(action, mode) {
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', personaScript, action];
  if (mode) args.push(mode);
  try {
    execFileSync('powershell.exe', args, { stdio: 'inherit', timeout: 30000 });
  } catch (error) {
    const code = typeof error.status === 'number' ? error.status : 1;
    if (code !== 0) console.error(`  persona ${action} 失败（exit ${code}）`);
  }
}

async function runPersona() {
  console.log('\n>>> persona — Claude Code CLI 人设注入管理\n');
  runPersonaCmd('status');

  console.log('选操作：');
  console.log('  [1] 切换到 dao（道德经 + 阴符经 ~22KB）');
  console.log('  [2] 切换到 fable5（Fable 5 泄露原文 ~122KB）');
  console.log('  [3] 关闭注入（vanilla claude）');
  console.log('  [4] 安装 / 重装 profile hook');
  console.log('  [5] 卸载（移除 hook，还原 vanilla claude）');
  console.log('  [0] 返回');
  const answer = await ask('输入 0-5：');

  switch (answer) {
    case '1': runPersonaCmd('switch', 'dao'); break;
    case '2': runPersonaCmd('switch', 'fable5'); break;
    case '3': runPersonaCmd('switch', 'off'); break;
    case '4': runPersonaCmd('install'); break;
    case '5': runPersonaCmd('uninstall'); break;
    default: console.log('已返回。');
  }
}

// ---------- 环境预检 ----------

function preflight() {
  const issues = [];
  const fixed = [];

  // 1. git
  try {
    execFileSync('git', ['--version'], { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' });
  } catch {
    issues.push({ msg: 'git 未安装', fix: '请安装 Git：https://git-scm.com/download/win' });
  }

  // 2. sqlite3（缺失时按 vendor/sqlite-tools.json 下载 + 校验 SHA256 + 解压，首次需联网）
  try {
    ensureSqlite3();
  } catch (e) {
    issues.push({ msg: 'sqlite3 不可用', fix: e.message });
  }

  // 2b. gh CLI（GitHub 操作用 gh 而非 MCP）
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', ['gh'], { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' });
    try {
      execFileSync('gh', ['auth', 'status'], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
    } catch {
      fixed.push('gh CLI 已安装但未登录（gh auth login）');
    }
  } catch {
    fixed.push('gh CLI 未安装（winget install GitHub.cli）——GitHub 操作不可用');
  }

  // 2c. uvx（fetch MCP server 依赖）
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', ['uvx'], { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' });
  } catch {
    fixed.push('uvx 未安装（powershell -c "irm https://astral.sh/uv/install.ps1 | iex"）——fetch MCP 不可用');
  }

  // 3. cc-switch DB（自动从 snapshot 创建空表结构）
  if (!fs.existsSync(ccSwitchDbPath)) {
    if (issues.length) {
      issues.push({ msg: `cc-switch 数据库不存在：${ccSwitchDbPath}`, fix: '请先安装并启动一次 cc-switch。' });
    } else {
      try {
        const created = bootstrapDb();
        if (created) fixed.push(`cc-switch 数据库不存在，已从 snapshot 自动创建空表：${ccSwitchDbPath}`);
      } catch (e) {
        issues.push({ msg: 'cc-switch 数据库自动创建失败', fix: `${e.message}\n    请手动安装并启动一次 cc-switch。` });
      }
    }
  }

  // 4. common-secrets.json（占位符存在时提醒，不阻塞——restore 会跳过未还原的行）
  if (!issues.length && !fs.existsSync(commonSecretsPath)) {
    try {
      const doc = readJsonIfExists(snapshotPaths.settings, { rows: [] });
      const rows = Array.isArray(doc) ? doc : (doc.rows || []);
      let placeholders = 0;
      for (const row of rows) {
        try { placeholders += countPlaceholders(JSON.parse(row.value)); } catch {}
      }
      if (placeholders > 0) {
        fixed.push(`缺少 common-secrets.json（settings 含 ${placeholders} 个脱敏占位符），下行时会跳过这些 settings 行`);
      }
    } catch {}
  }

  if (!issues.length && !fixed.length) return true;

  console.log('\n================ 环境预检 ================');
  for (const msg of fixed) console.log(`  ✓ ${msg}`);
  for (const issue of issues) {
    console.log(`  ✗ ${issue.msg}`);
    console.log(`    → ${issue.fix}`);
  }
  console.log('============================================');

  if (issues.length) {
    console.log('\n存在阻塞问题，请先解决后重试。');
    return false;
  }
  return true;
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

  // 纯只读/部署操作：直接转交，不需 DB preflight/git 状态板。
  if (opts.action === 'doctor') { runChild('doctor.mjs'); return; }
  if (opts.action === 'inventory') { runChild('inventory.mjs'); return; }
  if (opts.action === 'goal-health') { runChild('goal-task-health.mjs'); return; }
  if (opts.action === 'persona') { await runPersona(); closeRl(); return; }
  if (opts.action === 'deploy') { runDaoPs1('link-claude'); return; }
  if (opts.action === 'status') { runDaoPs1('status'); return; }
  if (opts.action === 'pack') { runPack(); return; }

  if (!preflight()) { closeRl(); process.exit(1); }

  const state = gitState({ fetch: opts.fetch });
  const sc = settingsConsistency();
  printStateBoard(state, sc);
  printDashboard();

  const action = opts.direction || (await chooseAction());
  if (action === 'doctor') { closeRl(); runChild('doctor.mjs'); return; }
  if (action === 'inventory') { closeRl(); runChild('inventory.mjs'); return; }
  if (action === 'goal-health') { closeRl(); runChild('goal-task-health.mjs'); return; }
  if (action === 'persona') { await runPersona(); closeRl(); return; }
  if (action === 'deploy') { runDaoPs1('link-claude'); closeRl(); return; }
  if (action === 'status') { runDaoPs1('status'); closeRl(); return; }
  if (action === 'pack') { closeRl(); runPack(); return; }
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
  console.error(`dao 失败：${error.message}`);
  closeRl();
  process.exit(1);
});
