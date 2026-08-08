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
// ── 三态判据（🔴 2026-08-08 对抗复核订正：下面这句判据不是 issue #92 正文的话）────
// **订正**：此前这里写着「issue 关闭条件明写：『判不出』不许被静默归入『可连』」——
// 逐字核对 issue #92 正文与评论，这句话**不存在**，「判不出」三个字全篇只出现一次，
// 出处是实现官 2026-08-08 自己发在该 issue 上的交付评论，不是用户写的关闭条件。
// **这是实现取的安全侧设计判据（AI 自定），不是用户的逐字要求**——判据本身仍然成立
// （对抗复核 14 组破坏性验证认可主干），但把它说成「issue 明写」是把判断档伪装成
// 照做档，属本仓红线（`[#官通-禁笃定措辞]`）。是否要把这条判据升格为团队共识、
// 还是仅当本实现的私房设计，留给 issue #70（待拍板总览）确认。
// 每个**已注册**的 MCP server（cc-switch DB 里 enabled_claude=1 那些）最终落进以下
// 四类之一，且**任何一类都不等价于「未提及」**：
//   ok       —— 探测输出里找到该 server 的行，且状态符号是 ✔（Connected，无附加问题）
//   degraded —— 状态符号是 !（已连接但有后续问题，如 `tools fetch failed`）——
//               **它不是「可连」也不是「连不上」，是介于两者之间，必须单独报出**，
//               这正是本 issue 点名的那种「连上了但残缺」不能被静默吞掉的情形
//   pending  —— 状态符号是 ⏸（`claude mcp --help` 原文：unapproved .mcp.json server，
//               「not connected to」——宿主自己都没尝试探测它，判不出，不算健康）。
//               **2026-08-08 对抗复核补一格**：帮助原文说这个状态只发生在**未批准的
//               项目级 `.mcp.json`** server 上，而本文件的期望集来自 cc-switch DB
//               （用户级）——这条路径在 `dao.bat --doctor` 这个集成里**结构上不可达**，
//               不只是「本机没触发过」。分类逻辑仍然保留（对未来别的调用方有意义，
//               且不保留没有额外好处），只是照直写清楚它此刻在这条路上够不到。
//   dead     —— 状态符号是 ✘（Failed to connect / Connection closed 等）
// 任何一个**期望存在**的 server，若在探测输出里根本找不到对应的行（探测超时被截断 /
// 输出格式变了导致正则失配 / 探测器本身崩了），一律落「判不出」而非静默当「ok」——
// 见 evaluateMcpHealth() 的「missing」分支，这是本文件唯一的判据核心，值得反复读。
//
// ── 自检半边为什么不需要一套独立解析器（dao-guard-writing.md 的第二条判据）────
// 常规做法是「结构化解析」与「独立普查」两条腿分别数，数字对不上就报「扫描面塌陷」。
// 本文件**结构性地**不需要这第二条腿：evaluateMcpHealth() 的默认分支是「没找到 = 判不出」
// 而不是「没找到 = 健康」，所以哪怕 LINE_RE **全盘**失配（宿主整体改了输出格式），每一个
// 期望的 server 都会各自落进 missing 分支、逐个报警告——不会出现「正则全瞎但汇总说零问题」
// 这种自证陷阱。
// 🔴 **2026-08-08 对抗复核收窄（原句「结构上不可能悄悄归零」是笃定措辞，已证伪）**：
// 上面那句话只在**全盘失配**时成立；**逐行错配**时不保证——若某一行恰好解析成另一个
// server 的「健康」样子（如状态文本里恰好嵌了一段 ` - ✔ Connected` 字面），那一行会被
// 计入 `ok` 而不是落进 missing。已知会构造出这种样子的两个形态见 LINE_RE 与
// `tests/mcp-health.tests.js` 的对抗回归用例（其中一个已修：字符类改成只认已知符号 +
// 惰性匹配取**第一个**符合的分隔点，把「探测文本自己提到别的符号」的误伤概率压到最低，
// 但没有消除——纯文本契约的结构性限制，见文件头「探测方式的取舍」）。
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
// 未在本机实机触发过，故按文档字面收，不算"实测"）。
const GLYPH_CATEGORY = { '✔': 'ok', '✘': 'dead', '!': 'degraded', '⏸': 'pending' };
const KNOWN_GLYPHS = Object.keys(GLYPH_CATEGORY).join('');

// 把符号字面翻成类别的单点，供 LINE_RE 命中之外的场景（如未来换一种解析路径）复用；
// 落在 LINE_RE 现在的形态下这个 `|| 'unknown'` 分支已经**不可达**（下面正则的字符类只
// 认这四个符号），保留是防御性纵深，不是活跃判据——2026-08-08 对抗复核前它确实可达
// （旧正则用 `\S+` 通吃任意 token），修正正则的同时把它降格记录在这里。
export function classifyGlyph(glyph) { return GLYPH_CATEGORY[glyph] || 'unknown'; }

// 一行的形态：`<name>: <连接细节，可能内含空格/连字符/URL> - <符号> <状态文本…>`
// 🔴 **2026-08-08 对抗复核：本注释与正则曾经是错的，已修，把错法照直记下**——
// 旧版 `(.+)\s-\s(\S+)` 用**贪婪**匹配 + 通吃 token，注释却写着「回溯到最后一个『` - `
// + 已知符号』的位置」——**正则本身根本不检查"已知符号"这四个字，`\S+` 吃任何非空白
// token**。对抗复核用真实可能出现的状态文本实测出两个后果：
//   ① **假阴性**：状态文本自己含 ` - <普通单词>`（如 `Failed to connect - Connection
//      closed`）时，贪婪回溯会把最后一个 ` - <token>` 误当分隔点，符号读成
//      "Connection" 这类词 ⇒ `dead`/`degraded` 被误判成 `unknown`（判不出）。
//   ② **假阳性（更危险）**：状态文本里若碰巧嵌了 ` - ✔ Connected` 这样的字面片段
//      （如 `uvx x - ✘ Failed - ✔ Connected`），贪婪回溯会挑**最后一个**看起来像符号
//      的 token，读出 `✔` ⇒ 死连接被误判成 `ok`。
// **现在的修法**：字符类收窄到只认 `[✔✘!⏸]` 这四个真符号（`\S+` → 字符类），且改
// **惰性**匹配 `.+?`（贪婪 → 惰性）取**第一个**满足「` - ` + 已知符号」的分隔点，
// 不再取最后一个。理由：真实契约里唯一有意义的分隔点是"连接细节"结束、状态标记开始的
// 那个位置，而这必然是**从左往右第一个**符合形态的位置——细节字段（命令行/URL）里
// 出现独立 ` - <非符号 token>`（如 `cmd --flag-a - flag-b`）不会提前触发，因为惰性匹配
// 会一直扩展 `(.+?)` 直到右边真的接上一个已知符号为止；而状态文本里嵌入的假符号字面
// 落在第一个真符号**之后**，天然不会被选中。两个后果同一次修复解决：①②在
// `tests/mcp-health.tests.js` 的对抗回归用例里各有一条钉住。
// **仍然不是万能解**：若细节字段本身就恰好在"状态文本真符号之前"提前包含一个假的
// ` - <已知符号>` 片段（结构上更靠左），惰性匹配会在那里提前停——这是纯文本契约的
// 结构性限制，不是这次没修干净，已知弱处照直写在上面的头注里。
const LINE_RE = new RegExp('^([^:\\r\\n]+):\\s+(.+?)\\s-\\s([' + KNOWN_GLYPHS + '])(?:\\s(.*))?$');

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
    const category = classifyGlyph(glyph);
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
// 🔴 **2026-08-08 对抗复核实证：生产路径（`shell:true`）永远拿不到 `ENOENT`**——
// 被 spawn 的其实是 `cmd.exe`（POSIX 上是 `/bin/sh`），它自己一定存在；`claude` 不存在时
// cmd.exe 是**自己**报错退出（status=1，`code` 是 undefined），不是 spawn 层的 ENOENT。
// 旧版只认 `code==='ENOENT'` 意味着 `unavailable` 分支在生产路径上**结构上不可达**——
// 命令找不到时一律落 `error`，且旧版只取 `e.message` 首行（恒为 `Command failed: claude
// mcp list` 这种无信息量的话），真正的原因（如 `'claude' 不是内部或外部命令`）躺在
// `e.stderr` 里被直接丢弃——不是假绿，是**诊断归零**：用户看到"探测失败"却看不到"为什么"。
// 修法两步：①`why` 里带上 `e.stderr`（有就带，没有不强求）；②`notFound` 的判据从「只认
// ENOENT」放宽到「ENOENT，或 stderr 命中已知的『命令不存在』文案」——**这是文本启发式，
// 不是稳定契约**（跟 LINE_RE 解析 `claude mcp list` 输出同一个性质：cmd.exe/sh 的报错
// 文案没有版本承诺，可能随 locale/系统版本变化），命中不了时仍然落 `error`、`why` 里仍
// 带着 stderr 原文，不会比现在更差，只是不一定精确分类到 `unavailable`。
// `: not found`（POSIX sh 的典型形态，如 `sh: 1: nope: not found`）与
// `command not found`（bash 的典型形态）两支都收，两者措辞不同、系统不同。
const NOT_FOUND_STDERR_RE = /is not recognized as|command not found|:\s*not found\b|不是内部或外部命令|No such file or directory/i;

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
    //   找不到命令——spawn 层拿不到可执行文件（`code==='ENOENT'`，仅 `shell:false` 时可达），
    //   或 shell 自己报"命令不存在"（生产路径实际会走的这一支，见上面那段注释）；
    //   其它——server 一侧真的失败（如子进程崩溃退出码非 0），归 'error'。
    const timedOut = !!(e && (e.signal === 'SIGTERM' || e.code === 'ETIMEDOUT'));
    const stderr = e && typeof e.stderr === 'string' ? e.stderr.trim() : '';
    const notFound = !!(e && e.code === 'ENOENT') || NOT_FOUND_STDERR_RE.test(stderr);
    const partial = e && typeof e.stdout === 'string' ? e.stdout : '';
    const msgFirstLine = e && e.message ? String(e.message).split('\n')[0] : String(e);
    // stderr 才是真原因，message 首行常是 `Command failed: <整条命令>` 这种废话——
    // 两者都留，废话当上下文、stderr 当主证据（与 check-dead-gates.mjs::errWhy 同一手法）。
    const why = stderr ? `${msgFirstLine}（stderr: ${stderr.slice(0, 300)}）` : msgFirstLine;
    return {
      state: timedOut ? 'timeout' : (notFound ? 'unavailable' : 'error'),
      servers: [],
      raw: partial,
      why,
      timeoutMs,
    };
  }
  return { state: 'ok', servers: parseMcpListOutput(raw), raw, why: '', timeoutMs };
}

// 🔴 **2026-08-08 对抗复核实证：只查 cc-switch DB 的期望集会漏报**——`claude mcp list`
// 会报出它认识的**全部** server，不止 DB 里 `enabled_claude=1` 那些（本机当天 DB 只登记
// 5 个，`claude mcp list` 实报 7 个；多出的 `opendesign` 只注册在 Claude Code 自己那边，
// 当天恰好是死连接，且正是 issue #92 表格点名的三个死连接之一——旧版因为它不在 DB 期望集
// 里而**静默跳过**，issue 的关闭条件在它自己点名的样本上反而不成立）。
// 修法：调用方该查的宇宙 = 「DB 期望集」∪「探测实见」，不是 DB 期望集本身；探测失败时
// 观测不到任何"实见"，宇宙退化为纯 DB 期望集（与旧行为一致，不会因为探测失败而报更少）。
/**
 * 计算"该体检哪些名字"的并集。纯函数，不含任何 I/O——doctor.mjs 与本文件测试都直接调它。
 * @param {string[]} dbNames cc-switch DB 里登记的期望名单
 * @param {ReturnType<typeof probeMcpHealth>} probe
 * @returns {string[]} 排序后的并集（DB 期望集 ∪ 探测（state==='ok' 时）实见的名字）
 */
export function computeMcpUniverse(dbNames, probe) {
  const db = Array.isArray(dbNames) ? dbNames : [];
  const observed = probe && probe.state === 'ok' && Array.isArray(probe.servers)
    ? probe.servers.map((s) => s.name) : [];
  return Array.from(new Set(db.concat(observed))).sort();
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
 * **每条 line 都带 `name` 字段**（2026-08-08 对抗复核后补，配合 doctor.mjs 的期望集并集
 * 改动）：调用方要按名字标注"这条是不是只在探测实见、不在 cc-switch DB 里"这类附加信息时，
 * 靠数组下标与 `expectedNames` 位置对应是隐式契约、容易在重构中悄悄破坏；显式带名字更稳。
 * @param {string[]} expectedNames
 * @param {ReturnType<typeof probeMcpHealth>} probe
 * @returns {{lines:{name:string, level:'pass'|'warn'|'fail', message:string}[], summary:{pass:number,warn:number,fail:number}}}
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
      lines.push({ name, level: 'warn', message: `${name}：本次判不出（${why}）—— 不等于健康` });
    }
    return { lines, summary: tally(lines) };
  }
  const byName = new Map(probe.servers.map((s) => [s.name, s]));
  for (const name of names) {
    const found = byName.get(name);
    if (!found) {
      lines.push({ name, level: 'warn',
        message: `${name}：健康探测输出里没找到这一行（判不出，不等于健康）——可能是输出格式变了或该行被截断` });
      continue;
    }
    if (found.category === 'ok') {
      lines.push({ name, level: 'pass', message: `${name}：✔ ${found.statusText || 'Connected'}` });
    } else if (found.category === 'degraded') {
      lines.push({ name, level: 'warn', message: `${name}：已连接但不完整 —— ${found.statusText || found.raw}` });
    } else if (found.category === 'pending') {
      lines.push({ name, level: 'warn', message: `${name}：⏸ 未批准/宿主未探测（${found.statusText || found.raw}）` });
    } else if (found.category === 'dead') {
      // statusText 为空时兜底用 raw（原样那一行），别让报文尾部空着一个破折号——
      // 「连不上 —— 」看着像半句没写完，读者会怀疑是不是探测器本身又坏了。
      lines.push({ name, level: 'fail', message: `${name}：连不上 —— ${found.statusText || found.raw}` });
    } else {
      lines.push({ name, level: 'warn', message: `${name}：探测行解析不出已知状态符号（判不出）—— ${found.raw}` });
    }
  }
  return { lines, summary: tally(lines) };
}

function tally(lines) {
  const s = { pass: 0, warn: 0, fail: 0 };
  for (const l of lines) s[l.level] = (s[l.level] || 0) + 1;
  return s;
}
