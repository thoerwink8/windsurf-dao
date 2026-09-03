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
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LLM_MODEL as BOT_LLM_MODEL } from './feishu-triage.mjs';
import { extractDeltaContent } from './lib/provider-probe.mjs';
import { LAND_AUTOMATION_NAME } from './lib/land-automation.mjs';

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
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout, ...(env == null ? {} : { env }) });
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
