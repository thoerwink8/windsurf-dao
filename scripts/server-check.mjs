#!/usr/bin/env node
// scripts/server-check.mjs —— Linux 服务器派工底座探测（2026-08-24 拍板：运行时搬 Linux 服务器）
//
// 用途：服务器调通期间循环跑这一条，判断「orca 无头底座 + 派工要用的面」到不到位。
// 退出码三态（不许把没查成当通过）：
//   0 = 全部查过且通
//   1 = 有真红（查成了，结果不对）
//   2 = 有没查成（探不到，既不是通也不是红）
//
// 检查器纪律（CLAUDE.md「自动检查」）：
//  · 不复用被检查对象自己的解析逻辑——只吃 orca CLI 的 --json 契约，不 import 仓内 orca 封装。
//  · 区分「扫完是 0 条」和「这次没扫到」：前者 ok，后者 unknown。
//  · 输出不落在自己会读的范围内：--out 只许写仓外（默认 ~/.dao/server-check/）。
//
// 用法：
//   node scripts/server-check.mjs                 人读一屏
//   node scripts/server-check.mjs --json          一行 JSON（给循环/差分用）
//   node scripts/server-check.mjs --json --out    追加落盘到 ~/.dao/server-check/checks.jsonl
//   node scripts/server-check.mjs --self-test     故意造违规样本，验探测器真能拦（不碰真环境）

import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(HERE), '..');

const OK = 'ok';
const RED = 'red';
const UNKNOWN = 'unknown';

/** 跑一条命令，永不抛：拿不到就 unknown，不许当 0 条。 */
function run(cmd, args, { timeout = 30000 } = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout, windowsHide: true });
  if (r.error) return { probed: false, reason: `spawn 失败：${r.error.code || r.error.message}` };
  if (r.signal) return { probed: false, reason: `被信号打断：${r.signal}（可能超时 ${timeout}ms）` };
  return { probed: true, code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

// 这些 error.code 表示「这次探不到」，不是「查成了结果不对」。混在一起会把 orca 没起
// 说成十条真红，根因反而看不见（2026-08-24 故意样本实测：停掉 orca 后 6 面全报 red）。
const UNPROBEABLE_CODES = new Set([
  'runtime_unavailable',
  'runtime_not_running',
  'not_paired',
  'pairing_required',
  'connection_refused',
  'timeout',
]);

/** 纯函数：把一段 orca stdout 判成三态。抽出来是为了测试能钉死判别力，不用起真 orca。 */
export function classifyOrcaStdout({ probed, reason, code, stdout = '', stderr = '' }) {
  if (!probed) return { state: UNKNOWN, detail: reason || '没探到' };
  const text = String(stdout).trim();
  if (!text) return { state: UNKNOWN, detail: `无 stdout（exit=${code}）${String(stderr).trim().slice(0, 160)}` };
  // orca 启动期可能先吐诊断行，取第一个 { 起的整段
  const start = text.indexOf('{');
  if (start < 0) return { state: UNKNOWN, detail: `stdout 不是 JSON（exit=${code}）：${text.slice(0, 160)}` };
  let payload;
  try {
    payload = JSON.parse(text.slice(start));
  } catch (e) {
    return { state: UNKNOWN, detail: `JSON 解析失败（exit=${code}）：${String(e.message).slice(0, 120)}` };
  }
  if (payload.ok !== true) {
    const errCode = payload.error?.code || payload.code || '';
    const msg = payload.error?.message || payload.message || JSON.stringify(payload).slice(0, 160);
    if (UNPROBEABLE_CODES.has(errCode)) {
      return { state: UNKNOWN, detail: `探不到（${errCode}）：${String(msg).slice(0, 140)}`, payload };
    }
    return { state: RED, detail: `ok!=true（${errCode || '无 code'}）：${String(msg).slice(0, 160)}`, payload };
  }
  return { state: OK, payload };
}

/** orca 的 --json 契约：顶层 { ok, result } 或 { ok:false, error:{code,message} }。
 *  注意 orca 即使 ok:false 也退出 0——退出码不是信号，只认 JSON。 */
function orcaJson(args, opts) {
  return classifyOrcaStdout(run('orca', args, opts));
}

function checkOrcaOnPath() {
  const r = run('orca', ['--help'], { timeout: 20000 });
  if (!r.probed) {
    return { state: UNKNOWN, detail: `${r.reason}——PATH 里没有 orca？serve 启动时会装到 ~/.local/bin，确认 PATH 带上它` };
  }
  if (r.code !== 0) return { state: RED, detail: `orca --help 退出 ${r.code}` };
  return { state: OK, detail: 'orca 可执行' };
}

function checkNotRoot() {
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (uid === null) return { state: UNKNOWN, detail: '本平台读不到 uid' };
  if (uid === 0) {
    return { state: RED, detail: 'root 在跑：Electron 会拒绝启动（Running as root without --no-sandbox is not supported），必须用专用服务用户' };
  }
  return { state: OK, detail: `uid=${uid}（非 root）` };
}

// `orca status` 是查询，**恒返回 ok:true**——真信号在 result.runtime.reachable。
// 只看 ok 会在 orca 已经死掉时报绿（2026-08-24 故意样本实测：runtimeId=none 却判通）。
// 语义：orca 没起 = 查成了的根因红一条；下游各面因此探不到 = 没查成。
/** 纯函数：`orca status` 的 result 判三态。恒 ok:true，所以只认 runtime.reachable。 */
export function classifyRuntimeStatus(result) {
  const runtime = result?.runtime;
  if (!runtime || typeof runtime.reachable !== 'boolean') {
    return { state: UNKNOWN, detail: 'status 契约变了：result.runtime.reachable 不是布尔' };
  }
  if (!runtime.reachable) {
    return {
      state: RED,
      detail: `runtime 不可达（state=${runtime.state || '未给'}，app.running=${result?.app?.running}）`
        + '——起：systemctl start orca-serve，或 LIBGL_ALWAYS_SOFTWARE=1 <AppRun> serve --port 6768 --json',
    };
  }
  return { state: OK, detail: `runtime 可达（runtimeId=${runtime.runtimeId || '未给'}）` };
}

function checkRuntimeReachable() {
  const r = orcaJson(['status', '--json'], { timeout: 30000 });
  if (r.state !== OK) return { ...r, detail: `status 本身没查成：${r.detail || ''}` };
  return classifyRuntimeStatus(r.payload?.result);
}

/** 扫完是空的 → ok 但标 empty；没查成 → unknown。两者必须分得开。 */
function checkListSurface(name, args, pick) {
  const r = orcaJson(args);
  if (r.state !== OK) return { ...r, detail: `${name}：${r.detail || ''}` };
  const list = pick(r.payload?.result);
  if (!Array.isArray(list)) {
    return { state: UNKNOWN, detail: `${name} 契约变了：拿不到数组（result 键=${Object.keys(r.payload?.result || {}).join(',')}）` };
  }
  return { state: OK, detail: `${name} 扫完 ${list.length} 条`, count: list.length };
}

function checkRepoRegistered() {
  const r = orcaJson(['repo', 'list', '--json']);
  if (r.state !== OK) return { ...r, detail: `repo list：${r.detail || ''}` };
  const repos = r.payload?.result?.repos;
  if (!Array.isArray(repos)) return { state: UNKNOWN, detail: 'repo list 契约变了：result.repos 不是数组' };
  let here;
  try {
    here = realpathSync(REPO_ROOT);
  } catch {
    return { state: UNKNOWN, detail: '读不到本仓真实路径' };
  }
  const hit = repos.find((x) => {
    const p = x && (x.path || x.rootPath || x.localPath);
    if (!p) return false;
    try { return realpathSync(p) === here; } catch { return false; }
  });
  if (!hit) {
    return {
      state: RED,
      detail: `本仓（${here}）没注册进 orca（已注册 ${repos.length} 个）——worktree create 会报 Missing repo selector（#762 同款）`,
    };
  }
  return { state: OK, detail: `本仓已注册（id=${hit.id || '未给'}）` };
}

/** 纯函数：account list 的 result 判三态。认不出厂商键 = 契约变了 = 没查成，不是 0 个。 */
export function classifyAccountsResult(result) {
  const res = result || {};
  const counts = {};
  let total = 0;
  for (const vendor of Object.keys(res)) {
    const accounts = res[vendor] && res[vendor].accounts;
    if (Array.isArray(accounts)) {
      counts[vendor] = accounts.length;
      total += accounts.length;
    }
  }
  if (!Object.keys(counts).length) return { state: UNKNOWN, detail: 'account list 契约变了：认不出任何厂商键' };
  const shape = Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(' ');
  if (total === 0) {
    return { state: RED, detail: `一个托管账号都没有（${shape}）——派工起得来终端也登不上，先 orca account add` };
  }
  return { state: OK, detail: `托管账号 ${total} 个（${shape}）`, count: total };
}

function checkAccounts() {
  const r = orcaJson(['account', 'list', '--json']);
  if (r.state !== OK) return { ...r, detail: `account list：${r.detail || ''}` };
  return classifyAccountsResult(r.payload?.result);
}

function checkDisplay() {
  if (process.env.DISPLAY) return { state: OK, detail: `DISPLAY=${process.env.DISPLAY}（用现成显示，orca 不另起 Xvfb）` };
  const r = run('command', ['-v', 'Xvfb'], { timeout: 5000 });
  // command -v 不一定是可 spawn 的外部程序，退回查常见落点
  const paths = ['/usr/bin/Xvfb', '/usr/local/bin/Xvfb'];
  const found = (r.probed && r.code === 0 && r.stdout.trim()) || paths.find((p) => existsSync(p));
  if (!found) {
    return { state: RED, detail: 'DISPLAY 没设且找不到 Xvfb：orca serve 起不来（apt-get install -y xvfb）' };
  }
  return { state: OK, detail: `无 DISPLAY，靠 orca 自起 Xvfb（${found}）` };
}

/** 嵌套跑仓库自检：只取退出码，不解析它的输出（不复用被检查对象的解析逻辑）。 */
function checkRepoSelfCheck() {
  const r = run(process.execPath, [join(REPO_ROOT, 'scripts', 'dao-check.mjs')], { timeout: 600000 });
  if (!r.probed) return { state: UNKNOWN, detail: `dao-check 没跑成：${r.reason}` };
  if (r.code !== 0) return { state: RED, detail: `dao-check 退出 ${r.code}（跑 node scripts/dao-check.mjs 看红项）` };
  return { state: OK, detail: 'dao-check 退出 0' };
}

/** #802：检查器自己扫 TOML 文本，不 import launch.mjs / agent-ready.mjs。 */
export function parseStartAgentProviders(tomlText) {
  const text = String(tomlText || '');
  if (!text.trim()) return { unscanned: true, providers: null, error: '路由表空' };
  if (!/^\[providers\./m.test(text)) {
    return { unscanned: true, providers: null, error: '没扫到 [providers.*] 节' };
  }
  const providers = [];
  let current = null;
  let inTriple = false;
  for (const line of text.split(/\r?\n/)) {
    const triples = (line.match(/"""/g) || []).length;
    if (inTriple) {
      if (triples % 2 === 1) inTriple = false;
      continue;
    }
    if (triples % 2 === 1) {
      inTriple = true;
      continue;
    }
    const sec = line.match(/^\[providers\.([^\]]+)\]\s*$/);
    if (sec) {
      current = sec[1];
      continue;
    }
    if (current && /^\s*start\s*=\s*["']agent["']\s*$/.test(line)) {
      providers.push({ name: current, start: 'agent' });
    }
  }
  return { unscanned: false, providers };
}

/** 检查器自持的 provider → --agent id。不调用 orcaKnownAgentId。 */
export function providerToAgentId(name) {
  const p = String(name || '').toLowerCase();
  if (p === 'gpt') return 'codex';
  if (p === 'cursor') return 'cursor';
  if (p === 'grok') return 'grok';
  if (p === 'devin') return 'devin';
  if (p === 'deepseek' || p === 'opencode-go' || p === 'gw') return 'pi';
  return null;
}

/** 独立解析 Orca 的 TUI_AGENT_DISPLAY_NAMES。0 个 id = 没查成，不是空目录。 */
export function parseTuiAgentDisplayNames(source) {
  const text = String(source || '');
  if (!text.trim()) return { unscanned: true, ids: null, error: '目录文本空' };
  const start = text.search(/TUI_AGENT_DISPLAY_NAMES\s*=/);
  if (start < 0) return { unscanned: true, ids: null, error: '没扫到 TUI_AGENT_DISPLAY_NAMES' };
  const brace = text.indexOf('{', start);
  if (brace < 0) return { unscanned: true, ids: null, error: 'TUI_AGENT_DISPLAY_NAMES 不是对象' };
  let depth = 0;
  let end = -1;
  for (let i = brace; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) return { unscanned: true, ids: null, error: 'TUI_AGENT_DISPLAY_NAMES 对象没闭合' };
  const ids = [];
  for (const line of text.slice(brace + 1, end).split(/\r?\n/)) {
    const m = line.match(/^\s*['"]?([A-Za-z][A-Za-z0-9-]*)['"]?\s*:/);
    if (m) ids.push(m[1]);
  }
  if (ids.length === 0) {
    return { unscanned: true, ids: null, error: 'TUI_AGENT_DISPLAY_NAMES 0 个 id（没查成，不是空目录）' };
  }
  return { unscanned: false, ids };
}

export function classifyRequiredAgents({ requiredIds, knownIds, knownUnscanned, knownError } = {}) {
  if (knownUnscanned || !Array.isArray(knownIds)) {
    return { state: UNKNOWN, detail: knownError || '没扫到 Orca TUI agent 目录（没查成，不是 0 个）' };
  }
  if (!Array.isArray(requiredIds)) {
    return { state: UNKNOWN, detail: '没扫到路由表 start=agent 需求（没查成）' };
  }
  if (requiredIds.length === 0) {
    return { state: UNKNOWN, detail: '路由表没扫到任何 start=agent（没查成，不是 0 个要认的 id）' };
  }
  const known = new Set(knownIds);
  const uniq = [...new Set(requiredIds)];
  const missing = uniq.filter((id) => !known.has(id));
  if (missing.length) {
    return {
      state: RED,
      missing,
      detail: `本构建不认 --agent ${missing.join('、')}（路由表 start=agent 要用）`,
    };
  }
  return { state: OK, missing: [], detail: `认 --agent ${uniq.join('、')}` };
}

const TUI_AGENT_CATALOG_REL = join('resources', 'app.asar.unpacked', 'out', 'shared', 'tui-agent-display-names.js');

function candidateTuiCatalogPaths(env = process.env) {
  const roots = [
    env.ORCA_TUI_AGENT_CATALOG,
    env.ORCA_APP_ROOT && join(env.ORCA_APP_ROOT, TUI_AGENT_CATALOG_REL),
    join('/opt/orca/squashfs-root', TUI_AGENT_CATALOG_REL),
    join('/opt/orca', TUI_AGENT_CATALOG_REL),
  ].filter(Boolean);
  return roots;
}

function loadTuiAgentCatalog({ env = process.env, readFile } = {}) {
  const paths = candidateTuiCatalogPaths(env);
  const reader = typeof readFile === 'function'
    ? readFile
    : (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null);
  for (const p of paths) {
    let text;
    try {
      text = reader(p);
    } catch (e) {
      return { unscanned: true, ids: null, error: `读目录失败：${String(e.message).slice(0, 120)}`, file: p };
    }
    if (text == null) continue;
    const parsed = parseTuiAgentDisplayNames(text);
    return { ...parsed, file: p };
  }
  return { unscanned: true, ids: null, error: '没找到 tui-agent-display-names.js（没查成，不是 0 个 agent）', file: null };
}

function checkOrcaAgentIds() {
  const routingPath = join(REPO_ROOT, 'docs', 'model-routing.toml');
  if (!existsSync(routingPath)) {
    return { state: UNKNOWN, detail: 'docs/model-routing.toml 不在（没查成）' };
  }
  let tomlText;
  try {
    tomlText = readFileSync(routingPath, 'utf8');
  } catch (e) {
    return { state: UNKNOWN, detail: `路由表读失败：${String(e.message).slice(0, 120)}` };
  }
  const parsed = parseStartAgentProviders(tomlText);
  if (parsed.unscanned) return { state: UNKNOWN, detail: parsed.error };
  const requiredIds = [];
  for (const p of parsed.providers) {
    const id = providerToAgentId(p.name);
    if (id && !requiredIds.includes(id)) requiredIds.push(id);
  }
  const catalog = loadTuiAgentCatalog();
  return classifyRequiredAgents({
    requiredIds,
    knownIds: catalog.ids,
    knownUnscanned: catalog.unscanned,
    knownError: catalog.error,
  });
}

const CHECKS = [
  ['① orca 在 PATH', checkOrcaOnPath],
  ['② 非 root 运行', checkNotRoot],
  ['③ 显示面（DISPLAY 或 Xvfb）', checkDisplay],
  ['④ runtime 可达', checkRuntimeReachable],
  ['⑤ worktree 面', () => checkListSurface('worktree ps', ['worktree', 'ps', '--json'], (x) => x?.worktrees)],
  ['⑥ terminal 面', () => checkListSurface('terminal list', ['terminal', 'list', '--json'], (x) => x?.terminals)],
  ['⑦ orchestration 面', () => checkListSurface('run-list', ['orchestration', 'run-list', '--json'], (x) => x?.runs)],
  ['⑧ automations 面', () => checkListSurface('automations list', ['automations', 'list', '--json'], (x) => x?.automations)],
  ['⑨ 本仓已注册进 orca', checkRepoRegistered],
  ['⑩ 托管账号可用', checkAccounts],
  ['⑪ 仓库自检 dao-check', checkRepoSelfCheck],
  ['⑫ start=agent 的 --agent id 本构建是否认识', checkOrcaAgentIds],
];

function outPath() {
  const dir = join(homedir(), '.dao', 'server-check');
  // 仓外落盘：检查器读的是 orca 与仓内脚本，写这里不会成为下一轮输入
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, 'checks.jsonl');
}

function selfTest() {
  // 故意样本：证明「探不到」不会被算成通过。用一个必然不存在的命令名走同一条 run/解析路。
  const fake = run('orca-this-binary-does-not-exist', ['--json'], { timeout: 3000 });
  const failures = [];
  if (fake.probed) failures.push('不存在的命令竟然 probed=true');

  const emptyStdout = (() => {
    const r = { probed: true, code: 0, stdout: '', stderr: '' };
    const text = r.stdout.trim();
    return text ? 'non-empty' : UNKNOWN;
  })();
  if (emptyStdout !== UNKNOWN) failures.push('空 stdout 没被判成 unknown');

  // 「扫完 0 条」必须是 ok，不能和 unknown 混
  const emptyList = checkListSurface('假面', ['--version'], () => []);
  if (emptyList.state !== OK || emptyList.count !== 0) {
    // 上面这条会真跑 orca --version（可能没装），只在能跑通时断言
    if (emptyList.state !== UNKNOWN) failures.push(`空列表判成了 ${emptyList.state}，应为 ok/count=0`);
  }

  // #802：故意造「目录里没有 pi」——必须判红，不能当绿。
  const missingPi = classifyRequiredAgents({
    requiredIds: ['pi', 'devin', 'grok'],
    knownIds: ['grok', 'codex', 'devin'],
    knownUnscanned: false,
  });
  if (missingPi.state !== RED || !Array.isArray(missingPi.missing) || !missingPi.missing.includes('pi')) {
    failures.push(`故意缺 pi 应判红，实际 ${missingPi.state} missing=${JSON.stringify(missingPi.missing)}`);
  }
  const noCatalog = classifyRequiredAgents({
    requiredIds: ['pi'],
    knownIds: null,
    knownUnscanned: true,
    knownError: '没扫到 Orca TUI agent 目录（没查成，不是 0 个）',
  });
  if (noCatalog.state !== UNKNOWN) {
    failures.push(`没扫到目录应判 unknown，实际 ${noCatalog.state}`);
  }

  if (failures.length) {
    console.error('self-test 红：\n  - ' + failures.join('\n  - '));
    return 1;
  }
  console.log('self-test 绿：探不到 → unknown（不当通过）；扫完 0 条 → ok。');
  return 0;
}

function main(argv = process.argv.slice(2)) {
  if (argv.includes('--self-test')) process.exit(selfTest());
  const asJson = argv.includes('--json');
  const wantOut = argv.includes('--out');

  const results = [];
  for (const [name, fn] of CHECKS) {
    let r;
    try {
      r = fn();
    } catch (e) {
      r = { state: UNKNOWN, detail: `检查自己抛了：${String(e.message).slice(0, 160)}` };
    }
    results.push({ name, state: r.state, detail: r.detail || '', ...(r.count === undefined ? {} : { count: r.count }) });
  }

  const reds = results.filter((r) => r.state === RED);
  const unknowns = results.filter((r) => r.state === UNKNOWN);
  const exit = reds.length ? 1 : unknowns.length ? 2 : 0;
  const verdict = exit === 0 ? '通' : exit === 1 ? '真红' : '没查成';
  const payload = {
    at: new Date().toISOString(),
    verdict,
    exit,
    total: results.length,
    ok: results.length - reds.length - unknowns.length,
    red: reds.length,
    unknown: unknowns.length,
    results,
  };

  if (asJson) console.log(JSON.stringify(payload));
  else {
    for (const r of results) {
      const mark = r.state === OK ? '✓' : r.state === RED ? 'X' : '?';
      console.log(`  ${mark}  ${r.name} —— ${r.detail}`);
    }
    console.log(`\nserver check: ${verdict}（${payload.ok} 通 / ${payload.red} 红 / ${payload.unknown} 没查成）`);
  }

  if (wantOut) {
    try {
      appendFileSync(outPath(), JSON.stringify(payload) + '\n', 'utf8');
    } catch (e) {
      console.error(`落盘失败（不影响判定）：${e.message}`);
    }
  }
  process.exit(exit);
}

const isDirectRun = process.argv[1] && resolve(process.argv[1]) === HERE;
if (isDirectRun) main();

export {
  CHECKS, orcaJson, checkListSurface, UNPROBEABLE_CODES,
  loadTuiAgentCatalog, candidateTuiCatalogPaths,
};
