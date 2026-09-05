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
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { delimiter as PATH_DELIMITER, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LLM_MODEL as BOT_LLM_MODEL } from './feishu-triage.mjs';
import { extractDeltaContent } from './lib/provider-probe.mjs';
import { LAND_AUTOMATION_NAME } from './lib/land-automation.mjs';
import { classifyReconcile, parseUsageNdjson } from './lib/model-reconcile.mjs';

const HERE = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(HERE), '..');

const OK = 'ok';
const RED = 'red';
const UNKNOWN = 'unknown';

/** 跑一条命令，永不抛：拿不到就 unknown，不许当 0 条。 */
function run(cmd, args, { timeout = 30000, env } = {}) {
  // env：给需要带敏感值的子进程用——
  // 值放环境而不是 argv，因为 argv 就是 /proc/<pid>/cmdline，全局可读、ps aux 一眼看见；
  // /proc/<pid>/environ 只有属主读得到。
  const r = spawnSync(cmd, args, { windowsHide: true, encoding: 'utf8', timeout, ...(env == null ? {} : { env }) });
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

/** 纯函数：land automation 在册且 enabled。不在=红；契约不对=没查成。 */
export function classifyLandAutomation(list, name = LAND_AUTOMATION_NAME) {
  if (!Array.isArray(list)) {
    return { state: UNKNOWN, detail: 'automations 不是数组（没查成）' };
  }
  const hits = list.filter((a) => a && a.name === name);
  if (hits.length === 0) {
    return {
      state: RED,
      detail: `没有名为 ${name} 的 automation（不在 = 红）——跑 node scripts/install-land-automation.mjs`,
    };
  }
  if (hits.length > 1) {
    return { state: RED, detail: `名为 ${name} 的 automation 有 ${hits.length} 条（幂等坏了，先手工删到一条）` };
  }
  const hit = hits[0];
  if (hit.enabled !== true) {
    return { state: RED, detail: `${name} 在册但 enabled=${hit.enabled}（应为 true）` };
  }
  return { state: OK, detail: `${name} 在册且启用 id=${hit.id || '未给'}`, count: list.length };
}

function checkLandAutomation() {
  const r = orcaJson(['automations', 'list', '--json']);
  if (r.state !== OK) return { ...r, detail: `automations list：${r.detail || ''}` };
  const list = r.payload?.result?.automations;
  if (!Array.isArray(list)) {
    return {
      state: UNKNOWN,
      detail: `automations list 契约变了：拿不到数组（result 键=${Object.keys(r.payload?.result || {}).join(',')}）`,
    };
  }
  return classifyLandAutomation(list);
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
    // 2026-09-05 复审这条判据（本仓规矩：体检红项先问判据该不该在）。
    // 它原本判真红「派工起得来终端也登不上」。而实测：这台机器托管账号一直是 0，
    // 审官与工人却整天在跑——因为 #822 之后全员走 pi + 网关 keyFile，
    // orca 的托管账号根本不在登录路径上了。判据的前提已经不成立。
    //
    // 不删这条：真回到 claude/codex CLI 直连时它还有用。降成「见」——
    // 说清是「这台机器没用托管账号这条路」，而不是继续报一个谁也修不了的红。
    // 永远红的检查会把真红淹掉，这比没有检查更糟。
    return {
      state: OK, count: 0, empty: true,
      detail: `托管账号 0 个（${shape}）——本机不走这条登录路（#822 全员 pi + 网关 keyFile）。`
        + '若改回 claude/codex CLI 直连，这里要先 orca account add',
    };
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

// —— ⑫ 飞书适配器（#801 块A）——
// 「在跑 + 凭据文件在（600）」。systemctl 探不到（Windows/无 systemd）= unknown 不当绿；
// 凭据不在/权限不对 = 真红（适配器起不来）。
const FEISHU_CREDS = () => join(homedir(), '.mirasim', 'keys', 'feishu-app.json');

/** 纯函数：`systemctl is-active feishu-triage.service` 的 stdout 判三态。 */
export function classifyFeishuTriage({ probed, reason, code, stdout = '', stderr = '' } = {}) {
  if (!probed) return { state: UNKNOWN, detail: reason || '没探到 systemctl（本平台无 systemd？）' };
  const text = String(stdout).trim();
  if (text === 'active') return { state: OK, detail: 'feishu-triage.service active' };
  if (['inactive', 'failed', 'activating', 'deactivating', 'reloading'].includes(text)) {
    return { state: RED, detail: `feishu-triage.service 没在跑（${text}）——sudo systemctl start feishu-triage.service` };
  }
  return { state: UNKNOWN, detail: `is-active 输出不认识（exit=${code}）：${text || stderr}`.slice(0, 160) };
}

function checkFeishuCreds() {
  const file = FEISHU_CREDS();
  if (!existsSync(file)) {
    return { state: RED, detail: `凭据不在：${file}（飞书 App 待用户给，见 #801 用户待给）` };
  }
  if (process.platform !== 'win32') {
    try {
      const mode = statSync(file).mode & 0o777;
      if (mode !== 0o600) return { state: RED, detail: `凭据权限 ${mode.toString(8)}，应为 600：${file}` };
    } catch (e) {
      return { state: UNKNOWN, detail: `凭据 stat 没查成：${e.message}` };
    }
  }
  return { state: OK, detail: `凭据在（${file}）` };
}

// 机器人自己的模型还在不在（2026-09-04 实咬）：网关侧砍模型（ai-gateway-stack §68 砍了 253 条）后，
// **消费方没有任何东西报警**——机器人对每条消息都只回「稍后重试」，日志里只有 inbound，哑了一整天。
// 判据：拿机器人自己的 key 向网关发一针流式，200 且收到真内容才算通；503/model_not_found = 红。
// 「指针配报警」：模型名是指向网关的指针，这就是那道会报警的检查。
export function classifyBotModelProbe({ probed = false, reason = '', code = null, gotContent = false, model = '' } = {}) {
  if (!probed) return { state: UNKNOWN, detail: `机器人模型没探成：${reason || '未知'}` };
  if (code === 200 && gotContent) return { state: OK, detail: `机器人模型 ${model} 通（网关有货）` };
  if (code === 200) return { state: RED, detail: `机器人模型 ${model}：200 但零内容（网关只给了心跳）` };
  return { state: RED, detail: `机器人模型 ${model} 不通（网关 ${code ?? '?'}${/model_not_found|No available channel/.test(reason) ? '，模型已被砍' : ''}）——改 FEISHU_LLM_MODEL 或把模型加回网关白名单` };
}

/** 机器人的接线值从哪读。两份，按序合并（后者不覆盖前者已有的键）：
 *  ① `/etc/feishu-triage.public.env`（644）——**不含密钥**的那半：网关地址、模型名。
 *     检查器以 orca 身份跑，读得到的只有这一份。
 *  ② `/etc/feishu-triage.env`（600 root:root，含 ANTHROPIC_AUTH_TOKEN）——检查器读不到，
 *     只有以 root 跑时才补得上；读不到不报错，因为 ① 已经够判。
 *  为什么不能只看 process.env：Orca 终端不继承 orca-serve 的环境（NEW-MACHINE.md §「实测」），
 *  ANTHROPIC_* 全空——那样 ⑰ 会在编排机上永远说「探不到」，变成一个永不响的报警，
 *  正好复刻本单要修的「零报警」。为什么不能把 ② 改成 644：那份里有 token（key 不外泄是硬规矩）。 */
export const BOT_ENV_FILES = ['/etc/feishu-triage.public.env', '/etc/feishu-triage.env'];
/** @deprecated 单份时代的名字，留给旧引用；真相是 BOT_ENV_FILES。 */
export const BOT_ENV_FILE = BOT_ENV_FILES[1];
export function parseEnvFile(text) {
  const out = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

function probeBotModel() {
  const fileEnv = {};
  const notes = [];
  for (const f of BOT_ENV_FILES) {
    if (!existsSync(f)) { notes.push(`${f} 不在`); continue; }
    try {
      const kv = parseEnvFile(readFileSync(f, 'utf8'));
      for (const [k, v] of Object.entries(kv)) if (!(k in fileEnv)) fileEnv[k] = v;   // 先读的优先
    } catch (e) { notes.push(`${f} 读不了（${e.code || e.message}）`); }
  }
  const envErr = notes.length ? `接线值没读到：${notes.join('；')}——网关地址与模型名应放 ${BOT_ENV_FILES[0]}（644，不含密钥），密钥另留 600 那份` : null;
  const base = fileEnv.ANTHROPIC_BASE_URL || process.env.ANTHROPIC_BASE_URL || '';
  // 模型只有一份真相：scripts/feishu-triage.mjs 的 LLM_MODEL（它自己已经认 process.env.FEISHU_LLM_MODEL）。
  // 这里不再插一层检查器自己的环境变量——否则可能去探一个机器人并不用的模型。
  const model = fileEnv.FEISHU_LLM_MODEL || BOT_LLM_MODEL;
  const keyFile = join(homedir(), '.mirasim', 'keys', 'feishu-triage.key');
  if (!base) return { probed: false, reason: envErr || `网关地址没查成（${BOT_ENV_FILES.join(' / ')} 里都没有 ANTHROPIC_BASE_URL，环境变量里也没有）`, model };
  if (!existsSync(keyFile)) return { probed: false, reason: '机器人 key 不在本机', model };
  let key = '';
  try { key = readFileSync(keyFile, 'utf8').trim(); } catch (e) { return { probed: false, reason: `key 读不了：${e.message}`, model }; }
  if (!key) return { probed: false, reason: 'key 为空', model };
  // key **走子进程环境变量**，不进 argv：argv 就是 /proc/<pid>/cmdline，全局可读、ps aux 一眼看见；
  // 而 /proc/<pid>/environ 只有属主读得到，与「能读 key 文件本身」是同一道信任边界。
  //（另两条别回头踩：curl -K - 在 Windows 上挂住读不到 stdin EOF；内联 -e 源码要过两层转义，
  //  写岔过一次，探针只会报「超时」，根因看不见。所以子进程是独立文件。2026-09-04 实测。）
  const childFile = join(REPO_ROOT, 'scripts', 'lib', 'bot-model-probe-child.mjs');
  const r = run(process.execPath, [childFile, base, model], { timeout: 100000, env: { ...process.env, __PROBE_KEY__: key } });
  if (!r.probed) return { probed: false, reason: r.reason || "探针子进程没跑成", model };
  const out = String(r.stdout || '');
  const errHit = out.match(/__ERR__(.*)$/);
  const code = Number((out.match(/__HTTP__(\d{3})/) || [])[1]) || null;
  // 连不上/超时是「这次没探成」，不是「网关真红」（本文件头的三态纪律：探不到 ≠ 结果不对）。
  if (errHit) return { probed: false, reason: `发不出去：${errHit[1].slice(0, 120)}`, model };
  if (r.code !== 0 || !code) {
    return { probed: false, reason: `探针子进程退出 ${r.code}，没拿到状态码${String(r.stderr || '').slice(0, 120)}`, model };
  }
  // 「有真内容」判据复用 provider-probe 的纯函数：它认 content / reasoning_content / reasoning。
  // grok-4.6 是推理档，小预算时可能只吐推理增量——自己写正则就会把「模型正常」判成红。
  let gotContent = false;
  for (const line of out.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const p = line.slice(5).trim();
    if (!p || p === '[DONE]') continue;
    try { if (extractDeltaContent('gw-openai', JSON.parse(p))) { gotContent = true; break; } } catch { /* 半截行跳过 */ }
  }
  return { probed: true, code, gotContent, model, reason: out.replace(/__HTTP__\d+/, '').slice(0, 200) };
}

function checkFeishuTriage() {
  const svc = classifyFeishuTriage(run('systemctl', ['is-active', 'feishu-triage.service'], { timeout: 10000 }));
  const creds = checkFeishuCreds();
  const parts = [];
  if (svc.state !== OK) parts.push(svc.detail);
  if (creds.state !== OK) parts.push(creds.detail);
  if (!parts.length) return { state: OK, detail: '飞书适配器在跑 + 凭据文件在（600）' };
  const state = svc.state === RED || creds.state === RED ? RED : UNKNOWN;
  return { state, detail: parts.join('；') };
}

function checkBotModel() {
  return classifyBotModelProbe(probeBotModel());
}

// —— ⑮ 撞限流探测 timer（#833）——
// 另起一项，不改 ⑧ automations 那行（#829 已占用）；⑭ 是指挥官自检（#800）。
// 检查器自持判据，不 import agent-stall-detect。
const PAD_STALL_SCRIPT = () => join(homedir(), 'bin', 'agent-stall-watch.mjs');

/** 纯函数：systemctl list-timers 文本 + 垫片文件是否还在 → 三态。 */
export function classifyAgentStallWatch({
  probed = false,
  reason = '',
  timersText = '',
  padScriptExists = null,
  padScriptUnknown = false,
} = {}) {
  if (padScriptUnknown) {
    return { state: UNKNOWN, detail: '垫片脚本在不在没查成' };
  }
  if (!probed) {
    return { state: UNKNOWN, detail: reason || '没探到 systemctl（本平台无 systemd？）' };
  }
  const text = String(timersText || '');
  const official = /\bdao-agent-stall\.timer\b/.test(text);
  const padTimer = /\bagent-stall-watch\.timer\b/.test(text);
  const padScript = padScriptExists === true;
  if (padTimer || padScript) {
    const bits = [];
    if (padTimer) bits.push('agent-stall-watch.timer 还在');
    if (padScript) bits.push('/home/orca/bin/agent-stall-watch.mjs 还在');
    return {
      state: RED,
      detail: `撞限流垫片没退役（${bits.join('；')}）——落地即删，防影子制度`,
    };
  }
  if (!official) {
    return {
      state: RED,
      detail: 'dao-agent-stall.timer 不在册——sudo systemctl enable --now dao-agent-stall.timer（装法见 host/machine/systemd/dao-agent-stall.timer）',
    };
  }
  return { state: OK, detail: 'dao-agent-stall.timer 在册，垫片已退役' };
}

// ⑯ 主树跟主分支 + 机器人吃新码（scripts/server-sync.sh，落地清单第 9 步）。没这个 timer，合并了的代码到不了运行中的机器人。
function checkDaoSync() {
  const r = run('systemctl', ['is-enabled', 'dao-sync.timer'], { timeout: 10000 });
  if (!r.probed) return { state: UNKNOWN, detail: `systemctl 没跑成：${r.reason}` };
  const st = String(r.stdout || '').trim();
  if (st === 'enabled') return { state: OK, detail: 'dao-sync.timer 在册（主树每 5 分钟跟主分支，机器人代码变了自动重启）' };
  return { state: RED, detail: `dao-sync.timer=${st || 'unknown'}——sudo bash scripts/install-dao-sync.sh` };
}

function checkAgentStallWatch() {
  const timers = run('systemctl', ['list-timers', '--all'], { timeout: 10000 });
  let padExists = null;
  let padUnknown = false;
  try {
    padExists = existsSync(PAD_STALL_SCRIPT());
  } catch (e) {
    padUnknown = true;
  }
  return classifyAgentStallWatch({
    probed: timers.probed,
    reason: timers.reason,
    timersText: `${timers.stdout || ''}\n${timers.stderr || ''}`,
    padScriptExists: padExists,
    padScriptUnknown: padUnknown,
  });
}


/**
 * 每个 dao timer 都必须有「下一次」。2026-09-05 实咬：
 * dao-agent-stall.timer 从 12:37 起再没跑过，而 systemctl 说它 active + enabled，
 * list-timers --all 里也照样列着——现有的 ⑮⑯ 两条检查全绿，#833 的自动换人整段无声停摆。
 * 真相在 NEXT 那一列：显示 n/a，SubState=elapsed。只用单调时钟（OnBootSec/OnUnitActiveSec）
 * 的 timer 停掉再起之后会进这个死态，永远不再有触发点。
 *
 * 判据只看一件事：这个 timer 有没有未来的触发时刻。有=活，没有=死。
 * 与「装没装」「enable 没 enable」都无关——那两条正是当天全绿的原因。
 *
 * units：[{ unit, next }]，next 为 systemctl 的 NextElapseUSecRealtime（0 或 'n/a' 即无下一次）。
 */
export function classifyTimerArmed({ probed = false, reason = '', units = null } = {}) {
  if (!probed) return { state: UNKNOWN, detail: reason || '没探到 systemctl（本平台无 systemd？）' };
  if (!Array.isArray(units)) return { state: UNKNOWN, detail: 'timer 清单没查成（不是数组）——不当成 0 个死' };
  // 扫出 0 个 ≠ 全都健康：一个 timer 都没扫到，多半是判据或过滤失效。
  if (units.length === 0) {
    return { state: UNKNOWN, detail: '一个 timer 都没扫到——「没查成」不算「都没问题」' };
  }
  // 「没有下一次」有两种，必须分开（2026-09-05 本闸自己误报过一次）：
  //   SubState=running —— 它触发的服务此刻正在跑，服务跑完才排下一次，**这时没有下一次是对的**。
  //                        commander-act 派工人一跑好几分钟，扫到执行中就会被报成死态。
  //   其余（waiting / elapsed / dead）—— 没有下一次就是真死态，本闸要抓的正是它。
  // 判据缺 SubState 这一维，等于把「正在干活」读成「已经死了」。
  const noNext = (u) => {
    const n = u && u.next;
    if (n == null) return true;
    const t = String(n).trim();
    return t === '' || t === '0' || t === 'n/a' || t === 'infinity';
  };
  const running = units.filter((u) => u && String(u.subState || '') === 'running');
  const dead = units.filter((u) => noNext(u) && String(u.subState || '') !== 'running');
  if (dead.length) {
    return {
      state: RED,
      detail: `${dead.length}/${units.length} 个 timer 没有下一次触发（${dead.map((u) => u.unit).join('、')}）——`
        + '它们仍显示 active+enabled 但已经不会再跑；给单元加 OnCalendar 后 sudo systemctl restart <unit>',
    };
  }
  // 「现在还有下一次」不等于安全。只有单调时钟（OnBootSec/OnUnitActiveSec）的 timer
  // 停一次再起就进 active(elapsed)：显示 active+enabled 而永不触发。今天两个单元先后咬过。
  // 已经死了 和 下次重启必死，是同一个缺陷的两个阶段——都在这一格报，别等它死了再说。
  const latent = units.filter((u) => u && u.calendar === false);
  if (latent.length) {
    return {
      state: RED,
      detail: `${latent.length}/${units.length} 个 timer 现在还活着，但只有单调时钟、没有 OnCalendar`
        + `（${latent.map((u) => u.unit).join('、')}）——停一次再起就会进 active(elapsed)：`
        + '显示 active+enabled 却永不触发，而且没有任何东西会说一句。'
        + '给单元加 OnCalendar；不归本仓的单元（如 gw-* 属网关仓）去它自己的仓改，改完重装。',
    };
  }
  const unknownCal = units.filter((u) => u && u.calendar == null).length;
  if (unknownCal) {
    return { state: UNKNOWN, detail: `${unknownCal}/${units.length} 个 timer 的单元文件读不出来——「有没有 OnCalendar」这一格没查成` };
  }
  const runNote = running.length ? `（其中 ${running.length} 个此刻服务正在跑：${running.map((u) => u.unit).join('、')}）` : '';
  return { state: OK, detail: `${units.length} 个 dao timer 都有下一次触发，且都有墙钟点位${runNote}` };
}

/**
 * 这个单元是不是「我们装的」——判据是**单元文件落在哪**，不是它叫什么。
 *
 * 发行版的单元一律在 `/usr/lib/systemd/system/`（部分老系统 `/lib/systemd/system/`），
 * 管理员/我们装的一律在 `/etc/systemd/system/`。这条界线是 systemd 自己定的，
 * 不需要任何人维护名单，也天然覆盖将来别的仓装上来的单元。
 *
 * 读不到路径时回 null（没查成），**绝不回 false**——「不知道归谁」被当成「不归我管」，
 * 正是漏报的做法。
 */
export function isOurUnit(fragmentPath) {
  const s = String(fragmentPath || '').trim();
  if (!s) return null;
  if (/^\/(?:usr\/)?lib\/systemd\/system\//.test(s)) return false;
  if (/^\/etc\/systemd\/system\//.test(s)) return true;
  if (/^\/run\/systemd\//.test(s)) return false; // 运行时生成的，不归本仓
  return null; // 没见过的落点：不猜，交给调用方当「没查成」
}

/** 扫盘面上的 dao/commander timer——不许手写清单，清单会过期。 */
function checkTimerArmed() {
  const list = run('systemctl', ['list-timers', '--all', '--no-legend', '--no-pager'], { timeout: 10000 });
  if (!list.probed) return classifyTimerArmed({ probed: false, reason: `systemctl 没跑成：${list.reason}` });
  // 2026-09-05 服务器巡检自己抓到的：本闸原本只认 `dao*` / `commander*` 前缀，
  // 于是 `gw-remote-probe.timer`（写 ~/.dao/provider-health.json，我们**读**它判派工可用性）
  // 一直是单调时钟、不在扫描面里——它停掉再起就会进 active(elapsed) 死态，
  // 而派工把过期健康表当 unknown 不拦。**按名字前缀圈定扫描面，等于只查自己认识的东西。**
  // 头一版按 `dao*`/`commander*` 前缀圈定，漏了 `gw-remote-probe.timer`；改成「扫全机 + 排掉
  // 发行版前缀」之后，立刻把 Ubuntu 自带的 `apport-autoreport` / `ua-timer` 判成红——
  // **名字黑名单和名字白名单是同一个毛病**，都只覆盖「有人想得到的那些」。
  //
  // 换成结构判据：**看单元文件落在哪**。发行版的在 `/usr/lib/systemd/system/`，
  // 我们（本仓 + 别的仓）装的一律在 `/etc/systemd/system/`。这个界线不靠任何人维护名单，
  // 且天然覆盖将来别的仓装上来的单元——`gw-remote-probe` 正是这么被捞回来的。
  const names = [...String(list.stdout || '').matchAll(/\b([a-z0-9@_.-]+\.timer)\b/g)].map((m) => m[1]);
  const units = [];
  const skipped = [];
  for (const unit of [...new Set(names)]) {
    // 不加 `--value`：`systemctl show` 按**它自己的属性顺序**输出，不按命令行顺序，
    // 靠下标取值会张冠李戴（第一版就把某个时间戳当成了单元路径）。按键名取，与顺序无关。
    const p = run('systemctl', ['show', unit, '-p', 'FragmentPath', '-p', 'SubState', '-p', 'NextElapseUSecRealtime', '-p', 'NextElapseUSecMonotonic'], { timeout: 8000 });
    if (!p.probed) return classifyTimerArmed({ probed: false, reason: `systemctl show ${unit} 没跑成` });
    const kv = new Map(String(p.stdout || '').split(/\r?\n/)
      .map((l) => l.trim()).filter(Boolean)
      .map((l) => { const i = l.indexOf('='); return i < 0 ? null : [l.slice(0, i), l.slice(i + 1).trim()]; })
      .filter(Boolean));
    const frag = kv.get('FragmentPath') || '';
    if (!frag) return classifyTimerArmed({ probed: false, reason: `${unit} 读不到 FragmentPath——圈不出扫描面，不当「不归我管」` });
    const mine = isOurUnit(frag);
    if (mine === null) {
      return classifyTimerArmed({ probed: false, reason: `${unit} 的单元文件落在没见过的地方（${frag}）——判不出归属，不当「不归我管」` });
    }
    if (!mine) { skipped.push(unit); continue; }
    const vals = ['NextElapseUSecRealtime', 'NextElapseUSecMonotonic']
      .map((k) => kv.get(k) || '').filter(Boolean);
    // 两个点位任意一个有值就算有下一次；两个都空才是死态。
    const alive = vals.some((v) => v && v !== '0' && v !== 'n/a' && v !== 'infinity');
    // SubState 分开「没有下一次」的两种：
    //   waiting = 在岗等下一次 → 没有下一次就是死态（本闸要抓的）
    //   running = 它触发的服务此刻正在跑 → 服务跑完才排下一次，**没有下一次是对的**
    // 2026-09-05 本闸自己误报过一次：commander-act 派工人要跑好几分钟，
    // 恰好扫到它执行中，就被报成死态。判据缺这一维，会把「正在干活」读成「已经死了」。
    const subState = kv.get('SubState') || '';
    // 有没有墙钟点位，只能读单元文件本身——`systemctl show` 的 TimersCalendar 在老版本上不稳。
    // 读不到回 null（没查成），不回 false：那会把「没读着」报成「缺 OnCalendar」，是误报。
    let calendar = null;
    try { calendar = /^OnCalendar=/m.test(readFileSync(frag, 'utf8')); } catch { calendar = null; }
    units.push({ unit, next: alive ? vals.join('|') : null, calendar, subState });
  }
  if (units.length === 0 && skipped.length > 0) {
    // 全机只有发行版的 timer：我们一个都没装上。这不是「都健康」。
    return classifyTimerArmed({
      probed: false,
      reason: `扫到 ${skipped.length} 个 timer，但没有一个装在 /etc/systemd/system——我们的单元一个都没装上？`,
    });
  }
  return classifyTimerArmed({ probed: true, units });
}

// —— ⑲ 退役 CLI 还留在 PATH（#960）——
//
// 改这段前必须知道的四件事（#868 四轮判红全咬在这四条上，直接当验收清单）：
//  1. 找到文件 ≠ 能执行：PATH 目录里躺着一个同名的说明文件不算「CLI 还在」，要判可执行位。
//  2. EACCES 是「有这个东西但没权限看」，不是 absent——当成没有就是漏报。
//  3. `existsSync` 遇权限错**不抛异常**，直接返 false：它分不出「没有」和「看不见」。
//     所以本节一律 statSync + catch 看 e.code，禁用 existsSync。
//  4. PATH 里的空段（`a::b`）在 POSIX 里表示当前目录，`.filter(Boolean)` 会把它悄悄丢掉。
//
// 清单不许手写（手写的清单会过期）。两头都从真相源推：
//  · 「有哪些 agent CLI」← docs/model-routing.toml 的 [providers.*].cli（启动模板真相源，
//    派工 argv 只听这张表）。检查器自己扫文本，不 import launch.mjs。
//  · 「哪些还在役」    ← docs/model-routing.json（选型唯一真相源，2026-08-22 拍板）：
//    角色表里 禁用 !== true 的条目 + 腿表里 状态 === '在役' 的条目，取它们的 provider。
//  两者相减才是退役清单。routing 改了本项自动跟着改，不会留下第二份会过期的名单。
//
// 由此推出的一条反直觉但正确的结论：provider `claude` 的启动模板 cli 是 `reclaude`（裸 claude
// 会 login rejected），而腿表 2026-09-04 把两条 claude@reclaude/terminal 登记成「在役」（帅位）。
// 所以 reclaude 不进退役清单——哪怕 #822/#960 正文写着「claude CLI 已移除」。真相源比正文新。

/** 检查器自持地扫 [providers.*].cli（不复用被检查对象的解析逻辑）。0 个 = 没查成，不是「没有 CLI」。 */
export function parseProviderClis(tomlText) {
  const text = String(tomlText || '');
  if (!text.trim()) return { unscanned: true, clis: null, error: '启动模板空' };
  if (!/^\[providers\./m.test(text)) return { unscanned: true, clis: null, error: '没扫到 [providers.*] 节' };
  const clis = [];
  let current = null;
  let inTriple = false;
  for (const line of text.split(/\r?\n/)) {
    const triples = (line.match(/"""/g) || []).length;
    if (inTriple) {
      if (triples % 2 === 1) inTriple = false;
      continue;
    }
    if (triples % 2 === 1) { inTriple = true; continue; }
    const sec = line.match(/^\[providers\.([^\]]+)\]\s*$/);
    if (sec) { current = sec[1]; continue; }
    if (!current) continue;
    const m = line.match(/^\s*cli\s*=\s*["']([^"']+)["']\s*(?:#.*)?$/);
    if (m) clis.push({ provider: current, cli: m[1] });
  }
  if (clis.length === 0) {
    return { unscanned: true, clis: null, error: '一个 [providers.*].cli 都没扫到（没查成，不是 0 个 CLI）' };
  }
  return { unscanned: false, clis };
}

/** 从选型真相源 model-routing.json 推「在役 provider」。0 个 = 没查成（不是「全退役了」）。 */
export function inServiceProviders(routingDoc) {
  if (!routingDoc || typeof routingDoc !== 'object' || Array.isArray(routingDoc)) {
    return { unscanned: true, providers: null, error: 'routing 不是对象' };
  }
  const found = new Set();
  const take = (entry) => {
    if (!entry || typeof entry !== 'object') return;
    const p = entry.provider || (entry.落地 && entry.落地.provider);
    if (p) found.add(String(p));
  };
  // 角色表：<角色>.<工种>.模型[]，禁用 !== true 才算在役。
  for (const role of Object.values(routingDoc)) {
    if (!role || typeof role !== 'object' || Array.isArray(role)) continue;
    for (const trade of Object.values(role)) {
      if (!trade || typeof trade !== 'object' || !Array.isArray(trade.模型)) continue;
      for (const m of trade.模型) if (m && m.禁用 !== true) take(m);
    }
  }
  // 腿表（§73）：只认 状态 === '在役'。停用的腿留着是退役记录，不算在役。
  if (Array.isArray(routingDoc.腿)) {
    for (const leg of routingDoc.腿) if (leg && leg.状态 === '在役') take(leg);
  }
  if (found.size === 0) {
    return { unscanned: true, providers: null, error: '一个在役 provider 都没推出来（没查成，不是「全退役」）' };
  }
  return { unscanned: false, providers: [...found] };
}

/** 退役 CLI = 启动模板里有、但它服务的 provider **一个都不在役**。
 *  同一个二进制常服务多个 provider（pi 同时是在役 gw 与已退役 opencode-go 的 cli）——
 *  只要还有一个在役就不算退役，否则会把天天在用的 pi 报成退役。 */
export function retiredClis({ clis, inService } = {}) {
  if (!Array.isArray(clis) || !Array.isArray(inService)) return [];
  const live = new Set(inService.map(String));
  const byCli = new Map();
  for (const { provider, cli } of clis) {
    if (!cli) continue;
    if (!byCli.has(cli)) byCli.set(cli, { cli, providers: [], live: false });
    const row = byCli.get(cli);
    row.providers.push(provider);
    if (live.has(String(provider))) row.live = true;
  }
  return [...byCli.values()]
    .filter((r) => !r.live)
    .map((r) => ({ cli: r.cli, providers: r.providers }))
    .sort((a, b) => a.cli.localeCompare(b.cli));
}

/** PATH 拆段。坑 4：POSIX 的空段（`a::b` 中间那截）表示当前目录，`.filter(Boolean)` 会把它丢掉。 */
export function splitPathValue(pathValue, { delimiter = ':', platform = process.platform } = {}) {
  if (typeof pathValue !== 'string' || pathValue.length === 0) {
    return { unscanned: true, dirs: null, error: 'PATH 为空或读不到（没查成，不是「PATH 上没有」）' };
  }
  const dirs = [];
  for (const seg of pathValue.split(delimiter)) {
    if (seg === '') {
      // POSIX：空段 = 当前目录（execvp 的老规矩）。Windows 的 CreateProcess 忽略空段。
      if (platform !== 'win32') dirs.push('.');
      continue;
    }
    dirs.push(seg);
  }
  if (dirs.length === 0) return { unscanned: true, dirs: null, error: 'PATH 拆完一个目录都没有（没查成）' };
  return { unscanned: false, dirs };
}

/** 一个候选路径是不是「能起来的执行体」。四态，绝不把「看不见」说成「没有」（坑 1/2/3）。 */
export function classifyExecutableEntry(file, { stat, platform = process.platform } = {}) {
  if (typeof stat !== 'function') return { state: 'unknown', why: '没给 stat（判不了）' };
  let st;
  try {
    st = stat(file);
  } catch (e) {
    const code = (e && e.code) || '';
    if (code === 'ENOENT' || code === 'ENOTDIR') return { state: 'absent', why: code };
    // 坑 2：EACCES/EPERM = 有这个位置但看不进去 → 没查成。判成 absent 就是漏报。
    if (code === 'EACCES' || code === 'EPERM') {
      return { state: 'unknown', why: `${code}：这个目录/文件看不进去，不当「没有」` };
    }
    return { state: 'unknown', why: code || String((e && e.message) || e).slice(0, 80) };
  }
  if (!st || typeof st.isFile !== 'function') return { state: 'unknown', why: 'stat 结果不认识（没查成）' };
  if (!st.isFile()) return { state: 'absent', why: '不是普通文件' };
  if (platform === 'win32') return { state: 'executable', why: 'win32 认扩展名（PATHEXT），没有可执行位' };
  // 坑 1：找到文件不等于能执行。PATH 目录里躺着的同名说明文件/半截下载不该报警。
  if (typeof st.mode !== 'number') return { state: 'unknown', why: 'stat 没给 mode，判不了可执行位' };
  const perm = st.mode & 0o777;
  if ((st.mode & 0o111) === 0) return { state: 'not-executable', why: `有文件但没可执行位（mode ${perm.toString(8)}）` };
  return { state: 'executable', why: `mode ${perm.toString(8)}` };
}

const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

/** 在给定的 PATH 目录里找一个二进制名。win32 要配 PATHEXT（裸名在 Windows 上起不来）。 */
export function whichOnPath(name, { dirs, platform = process.platform, stat, pathExt } = {}) {
  const hits = [];
  const unknowns = [];
  if (!Array.isArray(dirs)) return { hits, unknowns, dirs: 0 };
  const sep = platform === 'win32' ? '\\' : '/';
  const exts = platform === 'win32'
    ? String(pathExt || DEFAULT_PATHEXT).split(';').map((x) => x.trim()).filter(Boolean)
    : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const file = `${dir}${dir.endsWith(sep) ? '' : sep}${name}${ext}`;
      const r = classifyExecutableEntry(file, { stat, platform });
      if (r.state === 'executable') hits.push({ dir, file, why: r.why });
      else if (r.state === 'unknown') unknowns.push({ dir, file, why: r.why });
    }
  }
  return { hits, unknowns, dirs: dirs.length };
}

/** 三态收口。三者在输出上必须分得开：没查成 / 扫完 0 条 / 查出问题（本仓硬规矩）。 */
export function scanRetiredClis({
  tomlText, routingDoc, pathValue, platform = process.platform, delimiter, stat, pathExt,
} = {}) {
  const cat = parseProviderClis(tomlText);
  if (cat.unscanned) {
    return { state: UNKNOWN, detail: `启动模板（model-routing.toml）没扫成：${cat.error}——没查成，不是「没有退役 CLI」` };
  }
  const svc = inServiceProviders(routingDoc);
  if (svc.unscanned) {
    return { state: UNKNOWN, detail: `在役清单（model-routing.json）没推成：${svc.error}——没查成，不是「都在役」` };
  }
  const retired = retiredClis({ clis: cat.clis, inService: svc.providers });
  if (retired.length === 0) {
    return {
      state: UNKNOWN,
      detail: `一个退役 CLI 都没推出来（启动模板 ${cat.clis.length} 条 cli、在役 provider ${svc.providers.length} 个）`
        + '——没查成，不是「扫完 0 条」',
    };
  }
  const split = splitPathValue(pathValue, { delimiter, platform });
  if (split.unscanned) return { state: UNKNOWN, detail: `PATH 没查成：${split.error}` };
  const hits = [];
  const unknowns = [];
  for (const r of retired) {
    const w = whichOnPath(r.cli, { dirs: split.dirs, platform, stat, pathExt });
    for (const h of w.hits) hits.push({ cli: r.cli, providers: r.providers, ...h });
    for (const u of w.unknowns) unknowns.push({ cli: r.cli, ...u });
  }
  const scope = `扫了 ${retired.length} 个退役 CLI（${retired.map((r) => r.cli).join('、')}）× ${split.dirs.length} 个 PATH 目录`;
  if (hits.length) {
    // 同一个名字可能在一个目录里命中多次（Windows 的 PATHEXT 一名多扩展、PATH 里同目录重复登记）。
    // 报警要按「哪个 CLI 在哪些目录」说人话，命中明细留在 hits 里给排障。
    const byCli = new Map();
    for (const h of hits) {
      if (!byCli.has(h.cli)) byCli.set(h.cli, { cli: h.cli, providers: h.providers, dirs: new Set() });
      byCli.get(h.cli).dirs.add(h.dir);
    }
    const named = [...byCli.values()]
      .map((g) => `${g.cli}（在 ${[...g.dirs].join('、')}，provider ${g.providers.join('/')} 已不在选型）`)
      .join('；');
    return {
      state: RED,
      count: byCli.size,
      hits,
      detail: `${scope}，查出 ${byCli.size} 个还在 PATH 上：${named}——卸载或从 PATH 摘掉。`
        + '留着的后果不是多占点盘：派工回落时会静默启到一个不该再用的执行体，而没有任何东西会说一句',
    };
  }
  if (unknowns.length) {
    const named = unknowns.slice(0, 6).map((u) => `${u.file}（${u.why}）`).join('；');
    return {
      state: UNKNOWN,
      count: 0,
      unknowns,
      detail: `${scope}：没命中，但有 ${unknowns.length} 个位置没看成（${named}）——「没查成」不算「扫完 0 条」`,
    };
  }
  return { state: OK, count: 0, detail: `${scope}：一个都不在 PATH 上` };
}

function checkRetiredCliOnPath() {
  const tomlPath = join(REPO_ROOT, 'docs', 'model-routing.toml');
  const jsonPath = join(REPO_ROOT, 'docs', 'model-routing.json');
  let tomlText;
  let routingDoc;
  try {
    tomlText = readFileSync(tomlPath, 'utf8');
  } catch (e) {
    return { state: UNKNOWN, detail: `启动模板读不了（${String(e.code || e.message).slice(0, 60)}）：${tomlPath}` };
  }
  try {
    routingDoc = JSON.parse(readFileSync(jsonPath, 'utf8'));
  } catch (e) {
    return { state: UNKNOWN, detail: `选型真相源读不了/不是 JSON（${String(e.code || e.message).slice(0, 80)}）：${jsonPath}` };
  }
  return scanRetiredClis({
    tomlText,
    routingDoc,
    pathValue: process.env.PATH || '',
    platform: process.platform,
    delimiter: PATH_DELIMITER,
    stat: statSync,
    pathExt: process.env.PATHEXT,
  });
}


// —— ⑳ 仓里的 systemd 单元 vs 机器上装着的（2026-09-05 巡检实咬）——
//
// 巡检第一次真跑就抓到：仓里把 OnCalendar 补进了 dao-agent-stall.timer，
// 机器上 /etc/systemd/system/ 里仍是两天前那份。**改了仓 ≠ 装了机器**——
// dao-sync 只拉代码、不装单元，而 tests/timer-armed.test.js 只扫仓里的文件，
// 于是「检查全绿，修没有生效」。这一项就是补那一格。
//
// **只报不装**：dao-sync 现在跑 orca 身份，写不了 /etc；而让它能写，正是
// 2026-09-05 堵掉的那条提权路（root 解释 orca 可写的仓内脚本）。装单元是人的动作。

/** 纯函数：逐个单元比对仓内与机器上的内容。读不到 = 没查成，不当「一致」。 */
export function classifyUnitDrift(pairs) {
  if (!Array.isArray(pairs)) return { state: UNKNOWN, detail: '单元清单不是数组——没查成' };
  // 扫出 0 个不是「都一致」，是判据失效（目录挪了、命名换了）
  if (pairs.length === 0) return { state: UNKNOWN, detail: '一个单元都没扫到——没查成，不是「都一致」' };
  // CRLF/LF 与首尾空白不算漂移——仓在 Windows 上编辑、机器是 Linux，
  // 不归一化这条会天天红成噪音，而噪音久了就没人看。归一化放判据层（一把尺在一处），
  // 取数层只管把原文读出来。
  const norm = (t) => (t == null ? null : String(t).replace(/\r\n/g, '\n').trim());
  const unreadable = pairs.filter((p) => p.repo == null || p.live == null);
  const drifted = pairs.filter((p) => p.repo != null && p.live != null && norm(p.repo) !== norm(p.live));
  if (unreadable.length) {
    const who = unreadable.map((p) => `${p.name}(${p.repo == null ? '仓内读不到' : '机器上没装'})`);
    return { state: UNKNOWN, detail: `${unreadable.length} 个单元没比成：${who.join('、')}——没查成，不是「一致」` };
  }
  if (drifted.length) {
    return {
      state: RED,
      detail: `${drifted.length}/${pairs.length} 个单元仓里和机器上不是同一份：${drifted.map((p) => p.name).join('、')}`
        + '——改了仓不等于装了机器。静态单元 sudo install -m 644 host/machine/systemd/<名> /etc/systemd/system/；'
        + '指挥官那两个是代码生成的，sudo node scripts/commander.mjs install。装完 daemon-reload',
    };
  }
  return { state: OK, detail: `${pairs.length} 个单元仓里和机器上一致` };
}

function checkUnitDrift() {
  const dir = join(REPO_ROOT, 'host', 'machine', 'systemd');
  let names;
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.timer') || n.endsWith('.service'));
  } catch (e) {
    return { state: UNKNOWN, detail: `仓内单元目录读不了（${e.message || e}）——没查成` };
  }
  // CRLF/LF 与首尾空白不算漂移——仓在 Windows 上编辑、机器是 Linux，
  // 不归一化的话这条会天天红成噪音，而噪音久了就没人看。
  const norm = (t) => String(t).replace(/\r\n/g, '\n').trim();
  const pairs = names.map((name) => {
    let repo = null; let live = null;
    try { repo = (readFileSync(join(dir, name), 'utf8')); } catch { repo = null; }
    try { live = (readFileSync(join('/etc/systemd/system', name), 'utf8')); } catch { live = null; }
    return { name, repo, live };
  });
  return classifyUnitDrift(pairs);
}

// —— (21) 服务用户的家目录里有没有 root 属主的文件（2026-09-05 实咬）——
//
// 症状不像权限问题：`.git/index` 落成 root 后 orca 的 git 写操作失败，
// memory 的 `MEMORY.md` 落成 root 后 gen-index 静默 EACCES，测试沙箱落成 root 后
// 5 条测试红成「代码坏了」。三处表现各不相同，根因是同一个——**有人用 root
// 在服务用户的目录里跑了东西**（sudo 跑测试、root 跑 clone/脚本都会）。
//
// 之所以要成一项常驻检查：它会复发（任何一次 root 误跑都重新种下），
// 而且每次都伪装成别的病。修法永远是 `sudo chown -R <用户>:<用户> <路径>`。

const SERVICE_USER = (() => { try { return userInfo().username; } catch { return process.env.USER || '<服务用户>'; } })();

/**
 * 纯函数：把扫描结果判成三态。扫不成 ≠ 干净。
 *
 * `skipped` 是「扫到了但进不去的子目录数」：find 对不可读子目录会打 stderr 并
 * 以 exit 1 收尾，而测试沙箱**故意**造 0000 目录（`session-audit` 的 `ledger-ro`
 * 就是），所以这条一定会发生。把它当「没查成」会让这一项周期性报噪音，
 * 而噪音久了就没人看；当「干净」又会藏掉真污染。所以照实说：绿，但注明漏了几处。
 */
export function classifyRootOwned(scans) {
  if (!Array.isArray(scans) || scans.length === 0) {
    return { state: UNKNOWN, detail: '一个路径都没扫——没查成，不是「干净」' };
  }
  const failed = scans.filter((s) => !s.scanned);
  if (failed.length) {
    const who = failed.map((s) => `${s.path}(${s.reason || '未知'})`);
    return { state: UNKNOWN, detail: `${failed.length}/${scans.length} 个路径没扫成：${who.join('、')}——没查成，不是「干净」` };
  }
  const dirty = scans.filter((s) => s.count > 0);
  if (dirty.length) {
    const who = dirty.map((s) => `${s.path} ${s.count} 个`);
    return {
      state: RED,
      detail: `${dirty.length} 个路径下有 root 属主文件：${who.join('、')}`
        + '——服务用户写不进去，git 操作与测试会以别的面目失败。'
        + `修：sudo chown -R ${SERVICE_USER}:${SERVICE_USER} ${dirty.map((s) => s.path).join(' ')}`,
    };
  }
  const total = scans.length;
  const skipped = scans.reduce((n, s) => n + (s.skipped || 0), 0);
  const tail = skipped ? `，另有 ${skipped} 个子目录进不去没扫（多半是测试故意造的只读目录）` : '';
  return { state: OK, detail: `${total} 个路径扫完，0 个 root 属主文件（服务用户 ${SERVICE_USER} 全握有写权）${tail}` };
}

function checkRootOwnedInHome() {
  // 只扫会致命的四处，不扫整个家目录（workspaces 下几十棵树，扫全家要分钟级）
  const home = homedir();
  const targets = [
    REPO_ROOT,
    join(home, 'windsurf-dao-memory'),
    join(home, '.dao'),
    join(home, '.claude'),
  ];
  const scans = targets.map((path) => {
    if (!existsSync(path)) return { path, scanned: true, count: 0 };
    const r = run('find', [path, '-user', 'root', '-print'], { timeout: 60000 });
    if (!r.probed) return { path, scanned: false, reason: r.reason };
    const count = String(r.stdout || '').split('\n').filter((l) => l.trim()).length;
    // find 以 exit 1 收尾只说明「有东西没进去」，不说明扫出来的那些不可信。
    // 逐行分辨：`Permission denied` 是可容忍的漏扫（记数照说），别的 stderr 才是真没查成。
    // 先剔掉「回不到原 cwd」：那是调用方的 cwd 不可读（在 /root 里 sudo -u orca 跑就会），
    // 与被扫路径无关，既不是漏扫也不是没查成。
    const errs = String(r.stderr || '').split('\n')
      .filter((l) => l.trim() && !/Failed to restore initial working directory/.test(l));
    const denied = errs.filter((l) => /Permission denied/.test(l));
    const other = errs.filter((l) => !/Permission denied/.test(l));
    if (r.code !== 0 && other.length) {
      return { path, scanned: false, reason: `find exit ${r.code}：${other[0].slice(0, 80)}` };
    }
    return { path, scanned: true, count, skipped: denied.length };
  });
  return classifyRootOwned(scans);
}

// 两台 mirasim 各记各的账：orca 那台（`执行体` 里钉的回环 4316）跑派工，root 那台跑帅位会话。
// 只读其中一台会漏掉半边流量，而漏掉的那半边恰恰是「对不上」最容易发生的地方。
const MIRASIM_ROOTS = [join(homedir(), '.mirasim'), '/home/orca/.mirasim', '/root/.mirasim'];

/** ㉑ 选型腿表 vs 实际跑过的模型（#944）。真相源＝「腿」节，回执源＝mirasim 用量账。 */
function checkModelReconcile() {
  // 腿表自己解析，不 import lib/model-routing-json.mjs——
  // 复用被检查对象的解析逻辑就等于自己查自己，它把字段读错时这条闸跟着一起错。
  let legs = null; let legsWhy = null;
  try {
    const doc = JSON.parse(readFileSync(join(REPO_ROOT, 'docs', 'model-routing.json'), 'utf8'));
    if (Array.isArray(doc['腿'])) legs = doc['腿'];
    else legsWhy = '选型 JSON 里没有「腿」节（数组）';
  } catch (e) {
    legsWhy = `选型 JSON 读不了：${e.message || e}`;
  }

  const records = [];
  const seenReal = new Set();
  let filesRead = 0; const why = [];
  for (const root of MIRASIM_ROOTS) {
    const dir = join(root, 'insights');
    let names;
    try { names = readdirSync(dir).filter((n) => /^usage-.*\.ndjson$/.test(n)); } catch (e) { why.push(`${dir}: ${e.code || e.message}`); continue; }
    for (const n of names) {
      const p = join(dir, n);
      // 同一台可能被两条路径指到（~ 与绝对路径），realpath 去重免得样本翻倍
      let real; try { real = realpathSync(p); } catch { real = p; }
      if (seenReal.has(real)) continue;
      seenReal.add(real);
      try { records.push(...parseUsageNdjson(readFileSync(real, 'utf8')).records); filesRead++; } catch (e) { why.push(`${n}: ${e.code || e.message}`); }
    }
  }
  if (filesRead === 0) {
    return { state: UNKNOWN, detail: `没读到任何 mirasim 用量账——没查成，不是「没有调用」（${why.join('；') || '候选目录都不在'}）` };
  }
  const r = classifyReconcile({ legs, records, why: legsWhy });
  return { state: r.state, detail: `${r.detail}（${filesRead} 份账）`, ...(r.count === undefined ? {} : { count: r.count }) };
}

const CHECKS = [
  ['① orca 在 PATH', checkOrcaOnPath],
  ['② 非 root 运行', checkNotRoot],
  ['③ 显示面（DISPLAY 或 Xvfb）', checkDisplay],
  ['④ runtime 可达', checkRuntimeReachable],
  ['⑤ worktree 面', () => checkListSurface('worktree ps', ['worktree', 'ps', '--json'], (x) => x?.worktrees)],
  ['⑥ terminal 面', () => checkListSurface('terminal list', ['terminal', 'list', '--json'], (x) => x?.terminals)],
  ['⑦ orchestration 面', () => checkListSurface('run-list', ['orchestration', 'run-list', '--json'], (x) => x?.runs)],
  ['⑧ automations 面（land 在册且启用）', checkLandAutomation],
  ['⑨ 本仓已注册进 orca', checkRepoRegistered],
  ['⑩ 托管账号可用', checkAccounts],
  ['⑪ 仓库自检 dao-check', checkRepoSelfCheck],
  ['⑫ 飞书适配器在跑且凭据文件在', checkFeishuTriage],
  ['⑬ start=agent 的 --agent id 本构建是否认识', checkOrcaAgentIds],
  ['⑭ 指挥官自检（commander status，#800）', () => { const r = run(process.execPath, [join(REPO_ROOT, 'scripts', 'commander.mjs'), 'status'], { timeout: 60000 }); return !r.probed ? { state: UNKNOWN, detail: `commander status 没跑成：${r.reason}` } : r.code === 0 ? { state: OK, detail: '指挥官 timer 在册且 enabled' } : r.code === 2 ? { state: UNKNOWN, detail: '指挥官自检：没查成（本平台无 systemd）' } : { state: RED, detail: `指挥官自检红（exit ${r.code}）——node scripts/commander.mjs install` }; }],
  ['⑮ 撞限流探测 timer 在册且垫片已退役', checkAgentStallWatch],
  ['⑯ 主树跟主分支 timer 在册（机器人吃新码）', checkDaoSync],
  ['⑰ 机器人自己的模型在网关还有货', checkBotModel],
  ['⑱ 每个 dao timer 都有下一次触发（防 active(elapsed) 死态）', checkTimerArmed],
  ['⑲ 退役 CLI 已不在 PATH（#960）', checkRetiredCliOnPath],
  ['⑳ 仓里的 systemd 单元与机器上装着的一致', checkUnitDrift],
  ['(21) 服务用户家目录没有 root 属主文件', checkRootOwnedInHome],
  // 名字里必须点明「mirasim 侧」：这条只看得见 mirasim 执行的调用，orca 侧（pi→gw）不经 mirasim、
  // 不在这两份账上。名字比覆盖面大 = 让人以为 orca 侧也查过了。
  ['(22) mirasim 侧实跑腿与选型腿表对得上（#944；orca 侧不在覆盖内）', checkModelReconcile],
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

  // #829：故意造「没有 land automation」——必须判红，不能当绿；查不成才是 unknown。
  const noLand = classifyLandAutomation([]);
  if (noLand.state !== RED) failures.push(`没有 land 应判红，实际 ${noLand.state}`);
  const disabledLand = classifyLandAutomation([{ name: LAND_AUTOMATION_NAME, enabled: false, id: 'x' }]);
  if (disabledLand.state !== RED) failures.push(`disable 应判红，实际 ${disabledLand.state}`);
  const okLand = classifyLandAutomation([{ name: LAND_AUTOMATION_NAME, enabled: true, id: 'x' }]);
  if (okLand.state !== OK) failures.push(`在册且启用应判 ok，实际 ${okLand.state}`);
  const badShape = classifyLandAutomation(null);
  if (badShape.state !== UNKNOWN) failures.push(`契约不对应判 unknown，实际 ${badShape.state}`);

  // #944：腿表标「停用」的腿实际在跑 —— 必须红；探针流量（非 200 / local 腿）不许被判成违规。
  const RECON_LEGS = [
    { 模型: 'claude-opus-5', 族: 'claude', 供应商: 'mirasim', 执行侧: 'mirasim', 状态: '停用' },
    { 模型: 'gpt-5.6-sol', 族: 'codex', 供应商: 'mirasim', 执行侧: 'mirasim', 状态: '在役' },
  ];
  const usageRec = (o) => ({ leg: 'relay', status: 200, upstreamHost: 'relay.mirasim.ai', sessionId: 's', ...o });
  const retired = classifyReconcile({ legs: RECON_LEGS, records: [usageRec({ agent: 'claude', model: 'claude-opus-5' })] });
  if (retired.state !== RED || !/停用/.test(retired.detail)) {
    failures.push(`停用腿在跑应判红并点名，实际 ${retired.state}：${retired.detail}`);
  }
  const unregistered = classifyReconcile({ legs: RECON_LEGS, records: [usageRec({ agent: 'codex', model: 'gpt-6-astra' })] });
  if (unregistered.state !== RED || !/未登记腿/.test(unregistered.detail)) {
    failures.push(`未登记腿在跑应判红，实际 ${unregistered.state}`);
  }
  const probesOnly = classifyReconcile({
    legs: RECON_LEGS,
    records: [usageRec({ agent: 'claude', model: 'claude-does-not-exist-9', status: 422 })],
  });
  if (probesOnly.state !== OK || probesOnly.count !== 0) {
    failures.push(`全是探针流量应判 ok/0，实际 ${probesOnly.state}/${probesOnly.count}`);
  }
  if (classifyReconcile({ legs: RECON_LEGS, records: [] }).state !== UNKNOWN) {
    failures.push('一条记录都没有应判 unknown（没扫到样本），不是 ok');
  }

  // #960：退役 CLI 在 PATH。故意样本走同一条 scanRetiredClis，只把 stat 换成假的（不碰真环境）。
  const RETIRED_TOML = [
    '[providers.gw]', 'cli = "pi"',
    '[providers.devin]', 'cli = "devin"',
  ].join('\n');
  const RETIRED_JSON = { 工人: { 写码: { 模型: [{ id: 'x', 禁用: false, provider: 'gw' }] } } };
  const fakeStat = (present) => (file) => {
    if (!present.has(file)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
    return { isFile: () => true, mode: present.get(file) };
  };
  const scanArgs = { tomlText: RETIRED_TOML, routingDoc: RETIRED_JSON, platform: 'linux', delimiter: ':' };
  // ① 故意违规：PATH 上放一个可执行的 devin → 必须红，且点名 CLI 与目录。
  const planted = scanRetiredClis({
    ...scanArgs, pathValue: '/usr/bin:/home/orca/bin',
    stat: fakeStat(new Map([['/home/orca/bin/devin', 0o755]])),
  });
  if (planted.state !== RED || !/devin/.test(planted.detail) || !/home\/orca\/bin/.test(planted.detail)) {
    failures.push(`PATH 上有可执行 devin 应判红并点名，实际 ${planted.state}：${planted.detail}`);
  }
  // ② 反证：把它拿走必须转绿（判据不是恒红）。
  const removed = scanRetiredClis({ ...scanArgs, pathValue: '/usr/bin:/home/orca/bin', stat: fakeStat(new Map()) });
  if (removed.state !== OK || removed.count !== 0) {
    failures.push(`移走后应转绿（扫完 0 条），实际 ${removed.state}：${removed.detail}`);
  }
  // ③ 反证：在役的 pi 就算在 PATH 上也不许报——不然天天在用的通道会被报成退役。
  const livePi = scanRetiredClis({
    ...scanArgs, pathValue: '/usr/bin', stat: fakeStat(new Map([['/usr/bin/pi', 0o755]])),
  });
  if (livePi.state !== OK) failures.push(`在役 pi 不该被报退役，实际 ${livePi.state}：${livePi.detail}`);
  // ④ 坑 2/3：EACCES 是「看不见」不是「没有」——必须 unknown，且和「扫完 0 条」在话术上分得开。
  const blind = scanRetiredClis({
    ...scanArgs, pathValue: '/root/bin',
    stat: () => { const e = new Error('EACCES'); e.code = 'EACCES'; throw e; },
  });
  if (blind.state !== UNKNOWN || !/没查成/.test(blind.detail)) {
    failures.push(`EACCES 应判没查成，实际 ${blind.state}：${blind.detail}`);
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
