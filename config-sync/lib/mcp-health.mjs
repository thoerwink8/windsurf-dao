// mcp-health.mjs — MCP server 健康态探测（issue #92）
//
// ── 治的病 ──────────────────────────────────────────────────────────────────
// 「注册了但从没生效」的第三个实例（前两个：#64 nudge matcher 缺口、G6 注册前零覆盖）。
// 已注册的 MCP server 连不上时无人发现——2026-08-02 实测三个死连接（fetch/codegraph/
// opendesign）活活挂了一整天，`fetch` 死着的同时 WebFetch 又被域名校验挡，取网页能力
// 静默归零，全天 30 次「取不到文档」都没人往这个方向查。共性：注册态与生效态分得开，
// 但没人例行去看那个区别。
//
// ── 探测方式的取舍（先调过再定，不是拍脑袋）──────────────────────────────────
// 候选①逐个 server 手写 ping（各协议自己连一次）：每种 transport（stdio/http/sse）握手
// 方式不同，等于把宿主已经实现过的连接逻辑重新写一遍——为道日损应先看现成的。
// 候选②读 `claude mcp list` 的输出契约（本条采用）：宿主自己已经对**已批准**的 server
// 做心跳式健康检查（`claude mcp --help` 原文：「approved servers are health-checked」），
// 一次子进程调用拿到全部 server 的结论，不必逐个连。**代价是它是纯文本、没有 --json**
// （2026-08-08 实测 `claude mcp list --help`/`get --help` 均无机器可读输出选项），
// 所以这里做的是「读输出契约」而非「读结构化 API」——按 dao-docs-lookup.md 的态度，
// 这是一个已知会随宿主版本漂移的近似判据，不是稳定契约，解析失败时必须显式说明（见下）。
//
// ── 成本实测（issue 原文说「30s+」，本机复测如下）───────────────────────────
// `claude mcp list` 本机 3 次实测 6.4s / 6.5s / 14.9s（含一次服务器 `! Connected ·
// tools fetch failed — Request timed out` 的瞬时抖动，同一台机器换一次就变回
// `✔ Connected`——健康态本身是易变的，不是这份探测器的锅）。issue 记录的历史实况是
// `fetch` 那次超时拖到 30s+。⇒ 默认超时留足余量（见 DEFAULT_TIMEOUT_MS），且**不放进
// SessionStart 同步路径**（那条路径预算只有 10s，参见 ccswitch/hooks/dao-scaffold-check.js
// 头注与 .claude/rules/hooks-deployment.md 的超时预算表）——只在显式体检
// （`dao.bat --doctor` → config-sync/lib/doctor.mjs）触发时付这个成本。
//
// ── 三态判据（issue 关闭条件明写：「判不出」不许被静默归入「可连」）──────────
// 每个**已注册**的 MCP server（cc-switch DB 里 enabled_claude=1 那些）最终落进以下
// 四类之一，且**任何一类都不等价于「未提及」**：
//   ok       —— 探测输出里找到该 server 的行，且状态符号是 ✔（Connected，无附加问题）
//   degraded —— 状态符号是 !（已连接但有后续问题，如 `tools fetch failed`）——
//               **它不是「可连」也不是「连不上」，是介于两者之间，必须单独报出**，
//               这正是本 issue 点名的那种「连上了但残缺」不能被静默吞掉的情形
//   pending  —— 状态符号是 ⏸（`claude mcp --help` 原文：unapproved .mcp.json server，
//               「not connected to」——宿主自己都没尝试探测它，判不出，不算健康）
//   dead     —— 状态符号是 ✘（Failed to connect / Connection closed 等）
// 任何一个**期望存在**的 server，若在探测输出里根本找不到对应的行（探测超时被截断 /
// 输出格式变了导致正则失配 / 探测器本身崩了），一律落「判不出」而非静默当「ok」——
// 见 evaluateMcpHealth() 的「missing」分支，这是本文件唯一的判据核心，值得反复读。
//
// ── 自检半边为什么不需要一套独立解析器（dao-guard-writing.md 的第二条判据）────
// 常规做法是「结构化解析」与「独立普查」两条腿分别数，数字对不上就报「扫描面塌陷」。
// 本文件**结构性地**不需要这第二条腿：evaluateMcpHealth() 的默认分支是「没找到 = 判不出」
// 而不是「没找到 = 健康」，所以哪怕 LINE_RE 100% 失配（宿主改了输出格式），每一个期望
// 的 server 都会各自落进 missing 分支、逐个报警告——不会出现「正则全瞎但汇总说零问题」
// 这种自证陷阱。**这不是省略了自检，是把判据设计成结构上不可能悄悄归零。**
// 退役触发器：LINE_RE 连续多次一个都不命中（即所有 server 都进 missing 分支）本身就是
// 「输出契约变了，来更新这个文件」的信号——它不会静默，会以体检报警告的形式出现在人眼前。
//
// 跑法（人工核对）：node -e "import('./config-sync/lib/mcp-health.mjs').then(m=>console.log(m.probeMcpHealth({})))"
// 自证：node tests/mcp-health.tests.js
// 真相源：windsurf-dao/config-sync/lib/mcp-health.mjs
// 调用方：config-sync/lib/doctor.mjs（`dao.bat --doctor` 的 MCP 健康态一节）

import { execFileSync } from 'node:child_process';

// 调参三问（2026-08-08 本机实测 6.4s/6.5s/14.9s，issue 原文记录过一次 30s+ 的超时）：
// ①改小会怎样——本机实测最慢一次 14.9s，若设成 20000 这类"刚好够用"的值，遇到 issue
//   原文那种真实卡死（`fetch` 连接超时 30s）会被误判成"探测器超时"而非"server 真的连不上"，
//   两者处方不同（前者该查探测器/机器，后者该查 server 本身）；②当前值够不够——60000
//   覆盖已实测最大值的 4 倍、覆盖 issue 记录的历史最坏值的 2 倍；③再大一点代价是什么——
//   `dao.bat --doctor` 是显式体检不是热路径，用户等 60s 换一次不会静默失效的结论不亏，
//   不取更大是因为再大只是让"探测器本身卡死"这种真故障多拖时间，没有额外收益。
export const DEFAULT_TIMEOUT_MS = Number(process.env.DAO_MCP_HEALTH_TIMEOUT_MS) > 0
  ? Number(process.env.DAO_MCP_HEALTH_TIMEOUT_MS) : 60000;

// 单条命令字符串 + `shell: true` + 空 args——是刻意的组合，不是随手写法：
// Windows 上 `claude` 解析到的是 `claude.cmd`（npm 全局安装的 shim），execFileSync 不带
// shell 选项时**直接 CreateProcess，不认识 .cmd**（本机实测 ENOENT）；把可执行名也塞进
// args 数组、连同 shell:true 一起传会触发 Node DEP0190 弃用警告（"参数不会被转义"）；
// 而这里唯一的"参数"是固定字面量 `mcp list`，没有任何外部输入拼接进来，用单字符串
// 反而更安全——没有值可注入。跑法验证过三种组合，只有这一种本机零警告、跨平台都能跑
// （POSIX 上 `claude` 若是可执行 shell 脚本，`shell:true` 同样直接可用）。
const MCP_LIST_COMMAND = 'claude mcp list';

function defaultRunner(timeoutMs) {
  return execFileSync(MCP_LIST_COMMAND, [], {
    encoding: 'utf8', timeout: timeoutMs, windowsHide: true, shell: true,
  });
}

// 状态符号 → 类别。四个都是 `claude mcp list` 实测输出里真实出现过的符号
// （✔/✘/! 本机 2026-08-08 直接观测；⏸ 来自 `claude mcp --help`/`get --help` 的文档原文
// "Unapproved .mcp.json servers are shown as ⏸ Pending approval and not connected to"，
// 未在本机实机触发过，故按文档字面收，不算"实测"）。任何其它符号 → 'unknown'，
// 同样不折进 'ok'。
const GLYPH_CATEGORY = { '✔': 'ok', '✘': 'dead', '!': 'degraded', '⏸': 'pending' };

// 一行的形态：`<name>: <连接细节，可能内含空格/连字符/URL> - <符号> <状态文本…>`
// `(.+)` 用贪婪匹配 + 回溯，专门为了兼容"连接细节里也含独立的 ` - `"这种形态
// （本机实测 HTTP transport 的 URL 里没出现过，但 stdio 的命令行参数理论上可能有）——
// 贪婪会自动回溯到**最后一个**「` - ` + 已知符号」的位置，而不是第一个，所以细节字段
// 里出现 ` - ` 不会把行切错地方。
const LINE_RE = /^([^:\r\n]+):\s+(.+)\s-\s(\S+)(?:\s(.*))?$/;

/**
 * 解析 `claude mcp list` 的纯文本输出。纯函数，不做任何 I/O——这是为什么它能被
 * 无需真实 claude CLI 就单测到（正控/负控见 tests/mcp-health.tests.js）。
 * @param {string} text
 * @returns {{name:string, detail:string, glyph:string, category:string, statusText:string, raw:string}[]}
 */
export function parseMcpListOutput(text) {
  const lines = String(text == null ? '' : text).split(/\r?\n/);
  const servers = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const m = LINE_RE.exec(trimmed);
    if (!m) continue;
    const [, name, detail, glyph, rest] = m;
    const category = GLYPH_CATEGORY[glyph] || 'unknown';
    servers.push({
      name: name.trim(),
      detail: detail.trim(),
      glyph,
      category,
      statusText: (rest || '').trim(),
      raw: trimmed,
    });
  }
  return servers;
}

/**
 * 跑一次 `claude mcp list` 并解析。I/O 边界只在这一层——`execFn` 可注入，
 * 测试用它模拟超时/找不到命令/其它异常，不必真的起子进程或依赖本机装了什么 MCP。
 * @param {{execFn?: (timeoutMs:number)=>string, timeoutMs?: number}} opts
 * @returns {{state:'ok'|'timeout'|'unavailable'|'error', servers:Array, raw:string, why:string, timeoutMs:number}}
 */
export function probeMcpHealth(opts) {
  const o = opts || {};
  const timeoutMs = Number(o.timeoutMs) > 0 ? Number(o.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const runner = typeof o.execFn === 'function' ? o.execFn : defaultRunner;
  let raw;
  try {
    raw = runner(timeoutMs);
  } catch (e) {
    // 三种失败各自处方不同，判据取真实观测过的字段（与 dao-scaffold-check.js 的
    // `isBudgetKill` 同一套判据来源）：
    //   超时——node 对 execFileSync 的 timeout 选项用 SIGTERM 杀子进程，signal 就是它；
    //   找不到命令——spawn 层拿不到可执行文件，code 是 ENOENT；
    //   其它——server 一侧真的失败（如子进程崩溃退出码非 0），归 'error'。
    const timedOut = !!(e && (e.signal === 'SIGTERM' || e.code === 'ETIMEDOUT'));
    const notFound = !!(e && e.code === 'ENOENT');
    const partial = e && typeof e.stdout === 'string' ? e.stdout : '';
    return {
      state: timedOut ? 'timeout' : (notFound ? 'unavailable' : 'error'),
      servers: [],
      raw: partial,
      why: e && e.message ? String(e.message).split('\n')[0] : String(e),
      timeoutMs,
    };
  }
  return { state: 'ok', servers: parseMcpListOutput(raw), raw, why: '', timeoutMs };
}

/**
 * 期望的 server 名单 × 一次探测结果 → 逐条判据行。纯函数（不含任何 I/O），是本文件
 * 判据的真正落点，正控/负控测试直接打这个函数。
 *
 * 判据（与文件头注三态判据一一对应，`level` 决定调用方打 pass/warn/fail 哪一行）：
 *   探测本身没有 state==='ok'  → 每个期望的 server 各出一条 warn，明说"本次判不出"
 *   （不是打一条汇总 warn 就完事——逐条列名，方便调用方直接核对是哪几个）
 *   探测 ok 但某期望 server 没出现在输出里 → warn（判不出，不等于健康）
 *   category === 'ok'        → pass
 *   category === 'degraded'  → warn（连上了但不完整，不算过关也不算连不上）
 *   category === 'pending'   → warn（宿主自己都没探测它）
 *   category === 'dead'      → fail
 *   category === 'unknown'   → warn（这一行解析不出已知符号，判不出）
 * @param {string[]} expectedNames
 * @param {ReturnType<typeof probeMcpHealth>} probe
 * @returns {{lines:{level:'pass'|'warn'|'fail', message:string}[], summary:{pass:number,warn:number,fail:number}}}
 */
export function evaluateMcpHealth(expectedNames, probe) {
  const lines = [];
  const names = Array.isArray(expectedNames) ? expectedNames : [];
  if (!probe || probe.state !== 'ok') {
    const why = !probe ? '探测结果为空'
      : probe.state === 'unavailable' ? `claude CLI 不可用（${probe.why}）`
      : probe.state === 'timeout' ? `claude mcp list 超过 ${probe.timeoutMs}ms 未返回，已终止`
      : `claude mcp list 探测失败：${probe.why}`;
    for (const name of names) {
      lines.push({ level: 'warn', message: `${name}：本次判不出（${why}）—— 不等于健康` });
    }
    return { lines, summary: tally(lines) };
  }
  const byName = new Map(probe.servers.map((s) => [s.name, s]));
  for (const name of names) {
    const found = byName.get(name);
    if (!found) {
      lines.push({ level: 'warn',
        message: `${name}：健康探测输出里没找到这一行（判不出，不等于健康）——可能是输出格式变了或该行被截断` });
      continue;
    }
    if (found.category === 'ok') {
      lines.push({ level: 'pass', message: `${name}：✔ ${found.statusText || 'Connected'}` });
    } else if (found.category === 'degraded') {
      lines.push({ level: 'warn', message: `${name}：已连接但不完整 —— ${found.statusText}` });
    } else if (found.category === 'pending') {
      lines.push({ level: 'warn', message: `${name}：⏸ 未批准/宿主未探测（${found.statusText}）` });
    } else if (found.category === 'dead') {
      lines.push({ level: 'fail', message: `${name}：连不上 —— ${found.statusText}` });
    } else {
      lines.push({ level: 'warn', message: `${name}：探测行解析不出已知状态符号（判不出）—— ${found.raw}` });
    }
  }
  return { lines, summary: tally(lines) };
}

function tally(lines) {
  const s = { pass: 0, warn: 0, fail: 0 };
  for (const l of lines) s[l.level] = (s[l.level] || 0) + 1;
  return s;
}
