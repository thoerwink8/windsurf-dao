// dao-hard-gates 回归网 — 每闸正控 + 误伤负控 + mutation 判别力 + canary 恒等
//
// 跑法：node tests/hard-gates.tests.js   （全绿 exit 0，任一红 exit 1）
//
// ── 为什么这份测试的形态是这样 ──────────────────────────────────────────────
// 被测对象是**一道会 exit 2 拦人的闸**，它的两侧代价都是真代价：
//   · 漏报 → 那条禁令仍然只是文字，而文字禁令的实测遵守率是 0%（arxiv 2607.26819）
//   · 误报 → 合法动作被拦死，而甲类闸的逃生阀只有用户设得了 ⇒ 会话当场卡住
// 故每闸都是**双向断言**：违例必 exit 2 且 stderr 里给得出合法路径；合法输入必 exit 0。
// 只证明「能拦住」不算完成 —— 这是 dispatch-clauses 实现官节点名要求的那一条。
//
// ── mutation 为什么写进回归网而不是手工跑一次 ───────────────────────────────
// 「测试存在」不等于「测试有判别力」。手工 mutation 只发生一次，判据却会被反复编辑。
// 故本文件把 mutation 做成常驻断言：把某一闸的判定**改坏**（写进 _tmp/ 的副本，
// 从不碰真文件），断言原本 exit 2 的那条用例变成 exit 0；再断言真文件在整个过程中
// 逐字节没动过（canary 恒等）。任何一天有人把某条判据写成永假，这里会红。
//
// ── 已知不覆盖（照直写，别读成全覆盖）──────────────────────────────────────
// · matcher 覆盖面只由 `--selfcheck` 自查，本文件只断言它的**输出形态**——
//   真实注册状态取决于用户的 live settings.json，锚死会让测试随用户配置变红。
// · fail-open 路径用「注入一个必抛的判定」构造，证的是「崩了会放行且会喊」，
//   证不了「所有崩法都能被 catch 到」（catch 不住的崩法：进程级 OOM/被杀）。
// · G5 的 `--body-file` 只测真实可读文件；「文件读不到 ⇒ 放行」这个漏报面
//   有一条负控钉着，但那是**有意为之**（见 hook 内注释），不是待修的洞。
// · G6 与 dao-rhythm.js WAKEUP 信号的**跨文件判据一致性**不在本文件，在
//   `tests/dao-rhythm.tests.js` 末尾那一组（那边有现成的沙箱，能避开真实埋点日志污染）。
//   放在这里只留指针：判据有两份实现，一致性只由那一组钉着，改任一侧都要看它。

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const childProcess = require("child_process");

const REPO = path.resolve(__dirname, "..");
const HOOK = path.join(REPO, "ccswitch", "hooks", "dao-hard-gates.js");
const NUDGE = path.join(REPO, "ccswitch", "hooks", "dao-tool-nudge.js");
const TMP = path.join(REPO, "_tmp", "hard-gates-tests");

// ── 运行时出口计数器（issue #159）──────────────────────────────────────────
// 数的是**「真 hook 这个文件被 spawn 了几次」这个动作**，不是「源码里长得像的文本有几处」。
// 判据：spawnSync 的参数数组里，有没有哪一项 `path.resolve` 之后就是 NUDGE 那个文件。
// 选型理由、误报/漏报面、以及它替掉的那条正则为什么必须退役 —— 全写在下面
// 「#129·防复发」那一节的头注里（那里是这套判据的唯一真相源，此处不重述）。
function keyOf(p) {
  try {
    const r = path.resolve(String(p));
    return process.platform === "win32" ? r.toLowerCase() : r;   // win32 路径大小写不敏感
  } catch (_) { return null; }
}
const NUDGE_KEY = keyOf(NUDGE);
let NUDGE_SPAWNS = 0;          // 真 hook 被 spawn 的总次数（由下面这层包装数）
let NUDGE_RAW_CALLS = 0;       // 其中经由 nudgeRaw() 的次数
let NUDGE_DECLARED_BYPASS = 0; // 判别力探针**显式登记**的刻意绕开次数
const _realSpawnSync = childProcess.spawnSync;
childProcess.spawnSync = function (file, args, options) {
  if (Array.isArray(args)) {
    for (const a of args) if (typeof a === "string" && keyOf(a) === NUDGE_KEY) { NUDGE_SPAWNS++; break; }
  }
  return _realSpawnSync.apply(this, arguments);
};
// 🔴 **解构必须在 patch 之后**：先解构就等于把原函数拷了个局部引用，后面再 patch 模块导出
//    也管不着它 —— 那样计数器会恒 0，而恒 0 与「一个多余出口都没有」输出一模一样。
//    收尾那一节有一条断言钉着「本轮真的数到过」，专治这一格（见文件末尾）。
const { spawnSync } = childProcess;

fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

const HOME = process.env.USERPROFILE || process.env.HOME;

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? "  →  " + detail : ""}`); }
}

function sha(p) {
  return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}

// ── 逃生阀隔离（issue #188）──────────────────────────────────────────────────
// 🔴 **子进程默认剥掉全部逃生阀变量。** 本文件绝大多数断言问的是「这段判据写没写对」，
//    而逃生阀一开，hook 在判据之前就 `continue` 掉了 ⇒ 同一份代码、同一条正控，
//    结果只取决于**敲命令的人此刻有没有开阀**。那不是在测被测对象，是在测这台机器。
//    实证：用户按体系自己设计的「开阀 → 装 hook → 跑测试验收」流程做事，全套红 **125 条**
//    而代码一行没坏；关掉阀的干净环境重跑 PASS=491 FAIL=0（2026-08-08，issue #188）。
//    **是体系自己跟自己打架**：装 hook 那条流程必然打破「跑测试的人没开阀」这个隐含假设。
// 🔑 **用例显式传 `env` 的路径不受影响** —— 下面那几条「测逃生阀」的用例正靠它。
//    ~~显式值在展开顺序上排在剥离之后，永远盖得住。~~
//    **归因订正（#190 F3，对抗官实测 + 本批复核）**：结论（显式值盖得住）为真，但**对逃生阀而言
//    展开顺序无关** —— `envWithoutEscapes()` 已经把那些 key 整个删掉了，后面的 `...env` 是
//    **新增一格**而不是覆盖一格，两个顺序结果相同。顺序真正保护的是 `USERPROFILE` / `HOME` /
//    `DAO_TOOL_NUDGE_STATE` 这类**非阀覆写**：那些 key 剥离不动它、两侧都在，谁排后面谁赢。
//    ⇒ 别把这一句读成「顺序在守逃生阀那一格」，它守的是另一批 key。
//    回归锚在「逃生阀隔离」那一节，它把父进程的阀真开起来再跑默认路径
//    （先破再验过：把剥离换回 `...process.env` ⇒ 那节全红）。
// 📌 同型的现成写法：`ccswitch/scripts/probe-shell-search.mjs:78` 早就在喂 hook 前
//    把 `DAO_SHELL_SEARCH_OK` 置空 —— 那条路走对了，只是当时没人把它推广到测试侧。
// ⚠️ **射程照直写**：本清单只剥「逃生阀」这一类（hook 里 `escapeEnv:` 声明的那些）。
//    别的会改变 hook 行为的环境变量（`USERPROFILE` / `HOME` / `DAO_TOOL_NUDGE_STATE` …）
//    照旧继承 —— 它们要么本来就是被测量的对象、要么由用例显式指定。
const ESCAPE_ENVS = [
  "DAO_SETTINGS_EDIT_APPROVED",   // G2-live-settings
  "DAO_PUBLISH_APPROVED",         // G3-publish
  "DAO_ALLOW_READONLY_TODO",      // G5-readonly-todo
  "DAO_WAKEUP_UNSIGNED_OK",       // G6-heartbeat-signature
  "DAO_SHELL_SEARCH_OK",          // G7-shell-search
];
// Windows 的环境变量名大小写不敏感，故按大写比对再删 —— 只按字面 key `delete` 的话，
// 用户用 `dao_settings_edit_approved=1` 设的那一份会原样漏进子进程。
const ESCAPE_ENV_KEYS = new Set(ESCAPE_ENVS.map((k) => k.toUpperCase()));
// `src` 缺省 = `process.env`（生产形态）。**参数只为单元级断言存在**（#190 F1）：
// 「小写 key 也被剥掉」这一格在常规大写环境下**摘掉 `.toUpperCase()` 也零红**，
// 而端到端只在「敲命令的人恰好用小写设了阀」时才走到那一格 —— 喂一份假 env 才夹得住它。
function envWithoutEscapes(src) {
  const out = {};
  for (const [k, v] of Object.entries(src || process.env)) {
    if (!ESCAPE_ENV_KEYS.has(k.toUpperCase())) out[k] = v;
  }
  return out;
}

// 喂一次 PreToolUse 输入。script 缺省=真 hook；env 用于测逃生阀（显式传的盖过剥离）。
function gate(payload, { script = HOOK, env = {} } = {}) {
  const r = spawnSync(process.execPath, [script], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...envWithoutEscapes(), ...env },
  });
  return { code: r.status, err: String(r.stderr || ""), out: String(r.stdout || "") };
}

// ── nudge 的沙箱（issue #129）────────────────────────────────────────────────
// 这个 helper 原先**既不给 payload 的 `cwd`、也不给 spawnSync 的 `cwd`** ⇒ hook 侧一路退到
// `process.cwd()` = 敲命令的那个目录 = 开发者真仓。那是「测试 payload 不带 cwd」这个形态的
// 第三个实例（前两个：`dao-tool-nudge.tests.js` 的探针被就地改写 · `subagent-clauses`
// 的红绿取决于在哪个目录敲命令）。本条是**清尾**。
//
// 🔴 **#129 单子上「危害已被 PR #108 从下一层堵住」这句，接手时复核为「还没堵」**
//    （2026-08-05 实测，两条独立证据）：㈠`gh pr view 108` = **OPEN**，未合并（它被判不可合，
//    账在 #113）；㈡本仓 Grep `tmp-redact-sweep|tmp-sweep-scope` **零命中** ⇒ master 上
//    `dao-tool-nudge.js` 根本没有那个 `_tmp/` 扫描面。**那句话描述的是一个尚未落地的兜底。**
//    ⇒ 结论方向不变（本条仍是清尾，因为**眼下**那条写盘路不存在），但**理由换了**：
//    不是「有人在下面接着」，而是「那一层现在是空的」。
//    ⚠️ **此处原写「填上的那一刻，所有不带 cwd 的站点会同时变成真会吃文件的站点」——
//    经 PR #156 对抗验证官实查 `origin/fix/101-tmp-credentials` 判为不成立**：#108 对
//    「拿不到显式 cwd」是 **fail-closed** 的（`explicitCwd` 为空即打印一行并跳过脱敏），
//    且那条路**读 payload、完全不用 `process.cwd()` 兜底** ⇒ 它落地只会让缺 cwd 的站点
//    **不跑扫描**，不会让它们开始吃文件。**说「X 落地那天 Y 就会出事」之前先读 X 的判据。**
//
// 🔑 **顺带堵一格 #129 单子上没有的**：`dao-tool-nudge.js` 的去重表 `SEEN_FILE` 锚在
// **hook 自己的仓根**（`ROOT/_tmp/tool-nudge/…`），**与 cwd 无关** ⇒ 光给 cwd 堵不住它。
// 本 helper 收 `toolName` 参数，只要有人拿它喂一个浏览器 MCP 工具名（`BROWSER_MCP_RE` 那一支），
// 就会往**真仓**写去重表。当前没有调用点这么做 ⇒ **这不是在止血，是纵深防御**
// （照直标，别读成修了个 bug）。故这里连 `DAO_TOOL_NUDGE_STATE` 一起指进沙箱。
const NUDGE_SANDBOX = path.join(TMP, "nudge-cwd-sandbox");
fs.mkdirSync(NUDGE_SANDBOX, { recursive: true });
const NUDGE_STATE = path.join(NUDGE_SANDBOX, "tool-nudge-seen.json");

// **本文件里喂 nudge hook 的唯一出口。** 下面 `nudge()` 只是它的一层解包。
// 这个形状是被 issue #129 的那个 twin 逼出来的：原先「拿注入内容」与「拿退出码」是**两处
// 各自 spawnSync**，于是收口了前者、后者原样留着不带 cwd —— 同一个文件里同一个形态两份，
// 而单子上只记了一份。**同型的东西只留一个出口**，下一次收口才不会再漏掉另一半。
// （本节末尾有一条断言钉着「只有一个出口」这件事，见「#129·防复发」。）
// `opts` 四个可选口子，各有明确用途，**都不是给日常调用点用的**（默认值即生产形态）：
//   · sandbox   —— 换一个一次性沙箱（issue #157：基线必须取在**那个沙箱的第 0 次调用**）
//   · state     —— 单独指定去重表落点（沙箱与状态需要解耦时）
//   · script    —— 换成探测替身（issue #158：行为级守护要问「hook 实际收到了什么」）
//   · extraEnv  —— 只给替身看的环境变量；真 hook 不认识它们
//   · sessionId —— 浏览器 MCP 那一支按 session 去重，探针需要每次一个新的才走得到写盘
function nudgeRaw(command, toolName = "Bash", opts = {}) {
  const sandbox = opts.sandbox || NUDGE_SANDBOX;
  const state = opts.state || (opts.sandbox ? path.join(sandbox, "tool-nudge-seen.json") : NUDGE_STATE);
  const script = opts.script || NUDGE;
  // 只数「喂真 hook」那些次 —— 与 NUDGE_SPAWNS 同一射程，否则恒等式两边数的不是一回事。
  if (keyOf(script) === NUDGE_KEY) NUDGE_RAW_CALLS++;
  return spawnSync(process.execPath, [script], {
    input: JSON.stringify({
      tool_name: toolName,
      cwd: sandbox,
      session_id: opts.sessionId || "hard-gates-tests",
      tool_input: { command },
    }),
    encoding: "utf8",
    cwd: sandbox,                             // 两处都给：payload 那个供 hook 判据用，
                                              // 这个供 hook 里任何 process.cwd() 兜底用
    env: { ...process.env, DAO_TOOL_NUDGE_STATE: state, ...(opts.extraEnv || {}) },
  });
}

function nudge(command, toolName = "Bash") {
  const r = nudgeRaw(command, toolName);
  let out = {};
  try { out = JSON.parse(r.stdout || "{}"); } catch (_) {}
  return String((out.hookSpecificOutput || {}).additionalContext || "");
}

const bash = (command, cwd) => ({ tool_name: "Bash", tool_input: { command }, cwd });
const edit = (file_path) => ({ tool_name: "Edit", tool_input: { file_path } });
const wake = (tool_input) => ({ tool_name: "ScheduleWakeup", tool_input });

// ── 8.3 短名：**算出来而不是写死 `ADMINI~1`** ──────────────────────────────────
// 写死会让一整组断言在别的机器上悄悄退化成「测了个不含短名的普通路径」，而它照样全绿。
// 判据是 **realpath 往返**：候选短名解回来必须逐字等于长名本身 —— 那是文件系统自己给的答案，
// 不是我们对 8.3 算法的猜测。
// **2026-08-08 提到模块级并补 `~2..~4`**（#134）：原先它是 G2 那一节的块内局部量、且只试 `~1`。
// #134 的 fixture 要在同一个父目录下造两个假 HOME，前六字符相同 ⇒ 第二个必然是 `~2`，
// 只试 `~1` 会拿到 `null`，于是整组 junction 断言被静默跳过 —— 正是这个 helper 存在的理由
// 在它自己身上复发一次。
const _bs = (s) => String(s).replace(/\//g, "\\").toLowerCase();
function shortNameOf(dir) {
  const parts = String(dir).split(/[\\/]/), leaf = parts.pop(), parent = parts.join("\\");
  if (!leaf || leaf.length <= 8) return null;
  // 🔴 **2026-08-09（PR #235）补一档**：Windows 生成 8.3 时把 `+ , ; = [ ]` 这几个长名合法、
  //   短名非法的字符换成 `_`（与 `ccswitch/hooks/dao-hard-gates.js` 的 `g2ShortStemOf` 同一条
  //   规则），首版只按字面 `slice(0,6)`——含这些字符的目录名算出来的候选永远撞不上真短名。
  const stem = leaf.replace(/[+,;=[\]]/g, "_").slice(0, 6).toUpperCase();
  for (const i of [1, 2, 3, 4]) {
    const cand = `${parent}\\${stem}~${i}`;
    try { if (_bs(fs.realpathSync.native(cand)) === _bs(dir)) return cand; } catch (_) { /* 没这个短名 */ }
  }
  return null;
}

// ── #87 绕过命令原文（真语料，session 9364d260 / 751b40c0 转录逐字）─────────────
// 🔴 **2026-08-04 提到模块级，只此一份**。原先它是 G2 shell 节里的块内局部常量，
// 于是 #117 第二轮里我想引用「#87 原文」时**另手打了一个近似串**（字面长名路径），
// 拿它的测量结果去推翻对抗官对**原文**的判断 —— 而原文是**变量形态**，两者行为不同类，
// 结论因此整个错掉（全过程见下方 G2 第二轮那节的长注释）。
// ⇒ 承重语料只留**一份**，谁要引用就引用这个名字；**再有人想"照着写一条一样的"，
//   那一刻就是本轮那个错误正在重演**。
const V_UP = "$env:USERPROFILE";        // 拼出来，免得本文件正文自己长得像一条待拦命令
const LIVE_V_TOP = `"${V_UP}\\.claude\\settings.json"`;
const BYPASS_87 = `Copy-Item "D:\\frank\\windsurf-dao\\_tmp\\hook-register-202608\\03-merged.live-settings.json" ${LIVE_V_TOP} -Force; "COPY_EXIT=$LASTEXITCODE $?"`;

// 每闸的一条"承重正控"，mutation 与 canary 都拿它当靶
const CANARY = {
  "G1-windows-mcp": { tool_name: "mcp__windows-mcp__Screenshot", tool_input: {} },
  "G2-live-settings": edit(path.join(HOME, ".claude", "settings.json")),
  "G3-publish": bash("npm publish --access public"),
  "G4-screenshot-path": {
    tool_name: "mcp__chrome-devtools__take_screenshot",
    tool_input: { filePath: "D:/frank/mousse-cli/shot.png" },
  },
  "G5-readonly-todo": bash('gh pr create --title x --body "做完了\n- [ ] 还没跑测试"'),
  // 取一条**真实语料形态**当承重正控：这段开头逐字抄自 ~/.claude/projects 里的历史心跳
  // （全量普查 993 次 ScheduleWakeup 调用，非 stop 的 962 次全长这样，零次带签名）。
  // 拿真实形态当靶，是为了让「闸上线后第一天会拦到什么」这件事在测试里就看得见。
  "G6-heartbeat-signature": wake({
    delaySeconds: 1500,
    prompt: "高性能目标窗心跳（不限时，目标=除蓄水池外 issue 清零）。对账：① 三路在途……",
  }),
  // 同样取**真实语料形态**：这条逐字抄自转录（`sed -n` 读文件片段是新增拦截面里第三大的一格）。
  // 注意它带 `cd … &&` 前缀 —— 真语料里 grep/sed 极少单独出现，绝大多数长这样，
  // 而这正是「段首」判据最容易写错的地方（`cd` 会把真正的命令挤到第二段去）。
  "G7-shell-search": bash("cd /d/frank/mousse-cli && sed -n 1,140p crates/mousse-app/src/commands/session.rs"),
};

const PRISTINE_SHA = sha(HOOK);
const canaryBefore = {};
for (const [id, p] of Object.entries(CANARY)) canaryBefore[id] = gate(p).code;

console.log("\n──── 逃生阀隔离（issue #188）：开着阀跑，测的也得是代码不是机器 ────");
{
  // ── 这一节是回归锚，不是新覆盖面 ────────────────────────────────────────────
  // 它把**父进程**的阀真的打开，再跑 `gate()` 的**默认路径**（不传 env），断言闸照拦。
  // 剥离逻辑被谁注掉/改回 `...process.env`，这里当场红 —— 而在它存在之前，同样的事故
  // 表现为「全套红 125 条、每条都指向被测判据」，没有任何一条报文指向真正的成因。
  // **它刻意放在最前面**：后面所有正控都建立在「阀是关的」这个前提上，前提该第一个被验。
  //
  // 每格两条，一正一反 —— 只验前者，「剥离生效」与「阀整个失灵」在输出里长得一样：
  //   ㈠ 父进程带阀 + 默认路径 ⇒ 仍 exit 2（剥离真的发生了）
  //   ㈡ 同一状态 + 显式传同一个阀 ⇒ 仍 exit 0（剥离没有误伤「测阀」那条路，
  //      也顺带证明阀本身没坏 —— 否则 ㈠ 的绿可以是「这台机器上阀压根不管用」）
  const ANCHORS = [
    ["DAO_SETTINGS_EDIT_APPROVED", "G2-live-settings"],
    ["DAO_PUBLISH_APPROVED", "G3-publish"],
    ["DAO_ALLOW_READONLY_TODO", "G5-readonly-todo"],
    ["DAO_WAKEUP_UNSIGNED_OK", "G6-heartbeat-signature"],
    ["DAO_SHELL_SEARCH_OK", "G7-shell-search"],
  ];
  for (const [key, id] of ANCHORS) {
    const had = Object.prototype.hasOwnProperty.call(process.env, key);
    const old = process.env[key];
    let stripped, explicit;
    process.env[key] = "1";
    try {
      stripped = gate(CANARY[id]).code;                            // 默认路径：阀必须被剥掉
      explicit = gate(CANARY[id], { env: { [key]: "1" } }).code;   // 显式传：阀必须照常生效
    } finally {
      if (had) process.env[key] = old; else delete process.env[key];
    }
    check(`㈠ 父进程 ${key}=1 时 gate() 默认路径仍拦 ${id}`, stripped === 2, `code=${stripped}`);
    check(`㈡ 同一状态下显式传 ${key} 仍放行 ${id}（剥离没误伤「测阀」用例，且阀本身是活的）`,
      explicit === 0, `code=${explicit}`);
  }

  // ── 清单漂移闸：剥离清单必须与 hook 里 `escapeEnv:` 声明的那一份逐个相等 ──────
  // 没有它，「新加一道带逃生阀的闸」就会静默地在这里留一个洞，而洞的发现方式仍然是
  // 下一个开着那个阀的人撞一次满屏红（本条治的正是这个复发路径，不只是这一次的三个变量）。
  // 📌 **判据独立于被守对象**（`[#守-自检独立]`）：这里是对 hook 源码的一次**独立**正则读取，
  //    不调用 hook、也不复用它的任何解析 —— hook 那侧读的是 `GATES[].escapeEnv` 的运行期值。
  // 📌 `declared.length > 0` 那一半是给正则自己留的：正则哪天失配 ⇒ 空集 ⇒ 本条红，
  //    而不是「空集与空集相等」式地静默通过（零检出 ≠ 零存在）。
  const declared = [...fs.readFileSync(HOOK, "utf8").matchAll(/escapeEnv:\s*"([A-Za-z0-9_]+)"/g)]
    .map((m) => m[1]).sort();
  const stripping = [...ESCAPE_ENVS].sort();
  check("剥离清单 === hook 里声明的全部逃生阀（新增一道带阀的闸而这里没跟上 ⇒ 本条红）",
    declared.length > 0 && declared.join(",") === stripping.join(","),
    `hook 声明=[${declared.join(",")}] 本文件剥离=[${stripping.join(",")}]`);

  // ── F1（issue #190）：大小写归一化的单元级断言 ────────────────────────────────
  // 病在哪：`envWithoutEscapes()` 靠 `k.toUpperCase()` 比对再删，那一步**承重**
  // （端到端实测：小写设阀时朴素的按字面 `delete` 真漏），但**摘掉它在常规大写环境下 0 红**
  // —— 判别力完全依赖「敲命令的人此刻恰好用了小写」这个偶然。
  // 修法：喂一份**假 env**做单元级断言 —— 确定性、不起子进程、且**不依赖平台的 env 大小写语义**
  // （Linux/macOS 的 env 是大小写敏感的，这几条断言在那些平台上照样成立，因为它们只测这个函数）。
  {
    const FAKE = {
      PATH: "keep-me",
      DAO_PUBLISH_APPROVED: "1",                 // 规范大写
      dao_settings_edit_approved: "1",           // 全小写（Windows 上与大写等价 ⇒ 漏剥就等于阀开着）
      Dao_Shell_Search_Ok: "1",                  // 混合大小写
      MY_DAO_PUBLISH_APPROVED: "1",              // 误伤反例：名字里**含**阀名
      DAO_PUBLISH_APPROVED_EXTRA: "1",           // 误伤反例：阀名是它的前缀
    };
    const s = envWithoutEscapes(FAKE);
    check("F1 正控：规范大写的阀被剥掉", !("DAO_PUBLISH_APPROVED" in s), JSON.stringify(Object.keys(s)));
    check("🔴 F1 正控：**全小写**的阀也被剥掉（此前这一格零守护 —— 摘掉 .toUpperCase() 常规环境 0 红）",
      !("dao_settings_edit_approved" in s), JSON.stringify(Object.keys(s)));
    check("🔴 F1 正控：**混合大小写**的阀也被剥掉",
      !("Dao_Shell_Search_Ok" in s), JSON.stringify(Object.keys(s)));
    check("F1 误伤反例：名字里含阀名 / 以阀名为前缀的变量**不剥**（判据是整名相等，不是子串）",
      s.MY_DAO_PUBLISH_APPROVED === "1" && s.DAO_PUBLISH_APPROVED_EXTRA === "1",
      JSON.stringify(Object.keys(s)));
    check("F1 负控：非阀变量原样保留（把整份 env 剥空 ⇒ 子进程连 node 都跑不起来，那是另一种全红）",
      s.PATH === "keep-me");
    check("F1 前提：不传参时仍读 process.env（改成必须传参会让 gate() 的默认路径静默失效）",
      Object.keys(envWithoutEscapes()).length > 0);
  }
}

console.log("\n──── G1 · windows-mcp 全面禁令（一票否决，无逃生阀）────");
{
  for (const t of ["mcp__windows-mcp__Screenshot", "mcp__windows-mcp__Click", "mcp__windows_mcp__PowerShell"]) {
    const r = gate({ tool_name: t, tool_input: {} });
    check(`正控：${t} → exit 2`, r.code === 2, `code=${r.code}`);
    check(`正控：${t} stderr 给得出替代工具`, /chrome-devtools|playwright/.test(r.err), r.err.slice(0, 120));
  }
  // 无逃生阀：即便把别的闸的 env 全设上也拦
  check("无逃生阀：设了所有已知 env 仍 exit 2",
    gate(CANARY["G1-windows-mcp"], {
      env: { DAO_SETTINGS_EDIT_APPROVED: "1", DAO_PUBLISH_APPROVED: "1", DAO_ALLOW_READONLY_TODO: "1" },
    }).code === 2);

  const negatives = [
    ["chrome-devtools 截图（无路径）不该拦", { tool_name: "mcp__chrome-devtools__take_screenshot", tool_input: {} }],
    ["playwright 点击不该拦", { tool_name: "mcp__playwright__browser_click", tool_input: {} }],
    ["名字里含 windows 但非 windows-mcp 服务器不该拦", { tool_name: "mcp__fs__read_windows_file", tool_input: {} }],
    ["内置 PowerShell 工具不该被当成 windows-mcp", bash("Get-Process node")],
  ];
  for (const [name, p] of negatives) check(`负控：${name}`, gate(p).code === 0, `code=${gate(p).code}`);
}

console.log("\n──── G2 · live ~/.claude/settings.json（投影，非源）────");
{
  for (const n of ["settings.json", "settings.local.json"]) {
    const r = gate(edit(path.join(HOME, ".claude", n)));
    check(`正控：Edit ${n} → exit 2`, r.code === 2, `code=${r.code}`);
    // ⚠ 2026-08-02 issue #63 改钉：原先这两条钉的是「指出 config-sync 快照层 + direction=down 是正路」，
    // 而那条路径已被 #49 的下发链实测证伪（快照层与 common_config_* 镜像层都不在下发路径上，
    // 照它做改动永不生效，PR #43 即如此）。现在钉的是①真实下发源②那两层**被明说为不生效**。
    // **刻意不写成 `!/direction/` 那种反向断言**：新文案仍然点名 `dao.bat --direction=down/up`，
    // 只是把它从「正路」改成「别拿它来让 hook 生效」——禁令本身有价值（旧说法散在 PR body 与
    // 历史文档里，光删不说等于让人再试一次）。两条断言在文案被回退成旧版时都会红（已 mutation 实测）。
    check(`正控：${n} stderr 指出真实下发源 providers.settings_config + 每个 provider 都要改`,
      /providers/.test(r.err) && /settings_config/.test(r.err) && /每个 provider 都要改/.test(r.err), r.err.slice(0, 300));
    check(`正控：${n} stderr 明说快照层/镜像层不会生效（旧「正路」已被 #49 证伪）`,
      /镜像层/.test(r.err) && /不会生效/.test(r.err), r.err.slice(0, 300));
  }
  check("正控：Write（整份覆写）同样拦",
    gate({ tool_name: "Write", tool_input: { file_path: path.join(HOME, ".claude", "settings.json") } }).code === 2);
  check("正控：反斜杠路径同样拦（Windows 原生形态）",
    gate({ tool_name: "Write", tool_input: { file_path: `${HOME}\\.claude\\settings.json` } }).code === 2);
  check("逃生阀：DAO_SETTINGS_EDIT_APPROVED=1 → 放行",
    gate(CANARY["G2-live-settings"], { env: { DAO_SETTINGS_EDIT_APPROVED: "1" } }).code === 0);
  check("逃生阀只认 '1'，不认 'true'（免得随手设个值就等于关掉闸）",
    gate(CANARY["G2-live-settings"], { env: { DAO_SETTINGS_EDIT_APPROVED: "true" } }).code === 2);

  const negatives = [
    // 名字 2026-08-02 (#63) 改过：原写「改 git 快照层是正路」——**那句话本身已被 #49 证伪**
    // （快照层不在下发路径上）。断言不变、覆盖面不变：本闸只管 live 那一份，仓内文件本就不该拦。
    ["改仓内 config-sync 快照层不该拦（本闸只管 live 那一份；快照层能不能生效是另一回事）",
      edit(path.join(REPO, "config-sync", "common", "settings.json"))],
    ["改项目级 .claude/settings.json 不该拦（那不是 cc-switch 投影）",
      edit("D:/frank/mousse-cli/.claude/settings.json")],
    ["改 ~/.claude 下的别的文件不该拦", edit(path.join(HOME, ".claude", "CLAUDE.md"))],
    ["写 _tmp/settings-patch.json 是 dao 指定的降级路径，不该拦",
      edit(path.join(REPO, "_tmp", "settings-patch.json"))],
    ["Read 不该拦（本闸只管写）", { tool_name: "Read", tool_input: { file_path: path.join(HOME, ".claude", "settings.json") } }],
  ];
  for (const [name, p] of negatives) check(`负控：${name}`, gate(p).code === 0, `code=${gate(p).code}`);
}

console.log("\n──── G2 · shell 写入面（issue #87 扩面）· 双向语料夹击 ────");
// ── 这一节为什么单独存在 ─────────────────────────────────────────────────────
// 2026-08-02 实测绕过：`Copy-Item "<源>" "$env:USERPROFILE\.claude\settings.json" -Force`
// 一次踩中两处失明 —— ①它是 PowerShell 工具调用，进不了 Edit/Write 分支 ②路径是变量形态。
// **承重正控用的是那条命令的原文**（下面第一条，逐字抄自 `~/.claude/projects` 转录），
// 不是自己编的近似串 —— 编出来的语料只能证明「我写的正则匹配我写的字符串」。
// **负控里标着「真语料」的 6 条同样逐字抄自转录**：它们全是**备份**（源位是 live），
// 而备份恰恰是本闸 `how` 里劝人走的那条路。判据若写成「这一段提到 live settings 就拦」，
// 这 6 条真实命令全部误伤，而逃生阀只有用户设得了 ⇒ 会话当场卡住。
{
  const ps = (command, cwd) => ({ tool_name: "PowerShell", tool_input: { command }, cwd });
  const V = V_UP;                          // 拼出来，免得本文件正文自己长得像一条待拦命令
  const LIVE_V = LIVE_V_TOP;
  // 绕过命令原文引用**模块级唯一那一份**（2026-08-04 提上去的，理由见那里）——
  // 刻意不在这里再写一遍：本节与第二轮那节必须引用**同一个字符串**，
  // 否则「#87 原文」就有两份，而两份必漂移（本 PR 第二轮就是栽在这上面）。
  const BYPASS = BYPASS_87;

  const BLOCK = [
    ["#87 绕过命令原文（真语料·承重正控）", ps(BYPASS)],
    ["同一条命令走 Bash 工具送进来", bash(`Copy-Item src.json ${LIVE_V} -Force`)],
    ["${env:USERPROFILE} 花括号形态", ps(`Copy-Item src.json "\${env:USERPROFILE}\\.claude\\settings.json" -Force`)],
    ["%USERPROFILE% cmd 形态", ps(`Copy-Item src.json "%USERPROFILE%\\.claude\\settings.json"`)],
    ["$HOME + 正斜杠", bash(`cp _tmp/new.json "$HOME/.claude/settings.json"`)],
    ["~ 形态", bash("cp _tmp/new.json ~/.claude/settings.json")],
    ["Git Bash /c/ 盘符形态", bash("cp _tmp/new.json /c/Users/Administrator/.claude/settings.json")],
    ["已展开的字面绝对路径", ps(`Copy-Item src.json "${HOME}\\.claude\\settings.json" -Force`)],
    ["Move-Item 目标位", ps(`Move-Item _tmp/x.json ${LIVE_V} -Force`)],
    ["mv 目标位", bash("mv _tmp/x.json ~/.claude/settings.json")],
    ["-Destination 具名参数", ps(`Copy-Item -Path _tmp/x.json -Destination ${LIVE_V} -Force`)],
    ["-Destination: 冒号内联形态", ps(`Copy-Item _tmp/x.json -Destination:${LIVE_V}`)],
    // Out-File 几乎总在管道位 —— G7 对管道段整体豁免，G2 **刻意不豁免**（管道位正是它的目标位）
    ["Out-File 在管道位（G7 的管道豁免不适用于 G2）", ps(`$j | Out-File -FilePath ${LIVE_V} -Encoding utf8`)],
    ["Set-Content -Path", ps(`Set-Content -Path ${LIVE_V} -Value $json`)],
    ["Add-Content 位置参数", ps(`Add-Content ${LIVE_V} "x"`)],
    ["重定向 > 目标", bash('node -e "console.log(1)" > ~/.claude/settings.json')],
    ["重定向 >> 目标", bash('printf x >> "$HOME/.claude/settings.json"')],
    ["2> 也会截断（stderr 重定向同样是写）", bash("node t.js 2> ~/.claude/settings.json")],
    ["(Join-Path …) 折叠", ps(`Copy-Item _tmp/x.json (Join-Path ${V} '.claude\\settings.json') -Force`)],
    ["同命令内的字面量变量间接", ps(`$p = ${LIVE_V}; Copy-Item _tmp/x.json $p -Force`)],
    ["目标位给的是 .claude 目录（文件名由源 basename 决定）", bash("cp _tmp/settings.json ~/.claude/")],
    ["settings.local.json 同样拦", ps(`Copy-Item x.json "${V}\\.claude\\settings.local.json" -Force`)],
    ["cwd 恰是 home 时的相对路径", bash("cp new.json .claude/settings.json", HOME)],
    ["tee 目标", bash("printf x | tee ~/.claude/settings.json")],
    ["cd 前缀不影响段首判定", ps(`cd D:\\frank; Copy-Item x.json ${LIVE_V} -Force`)],
  ];
  for (const [name, p] of BLOCK) {
    const r = gate(p);
    check(`正控：${name} → exit 2`, r.code === 2 && /G2-live-settings/.test(r.err), `code=${r.code}`);
  }
  check("承重正控的 stderr 指得出是哪一段命中（不是只说「被拦了」）",
    /这一段：/.test(gate(ps(BYPASS)).err));
  check("逃生阀：DAO_SETTINGS_EDIT_APPROVED=1 下同一条绕过命令放行",
    gate(ps(BYPASS), { env: { DAO_SETTINGS_EDIT_APPROVED: "1" } }).code === 0);
  check("逃生阀只认 '1'：设成 'true' 仍拦",
    gate(ps(BYPASS), { env: { DAO_SETTINGS_EDIT_APPROVED: "true" } }).code === 2);

  const ALLOW = [
    // ↓ 6 条「真语料」逐字抄自 ~/.claude/projects 转录：全是**备份**（源位是 live）。
    //   全库普查结果：shell 触到 live settings.json 的命令里，写 1 条（就是上面那条绕过），
    //   读/备份 4 条 —— 误伤面比拦截面还大，故「只看目标位」是本次最要紧的设计取舍。
    ["真语料·备份①：live → 同目录 .bak",
      ps(`Copy-Item ${LIVE_V} "${V}\\.claude\\settings.json.bak-20260801-hardgates" -Force; "备份就位"`)],
    ["真语料·备份②：cp live → .bak",
      bash('cp "C:/Users/Administrator/.claude/settings.json" "C:/Users/Administrator/.claude/settings.json.bak-20260712-marshal-scout" && echo BACKED_UP')],
    ["真语料·备份③：cp live → _tmp",
      bash('cp ~/.claude/settings.json "D:\\frank\\windsurf-dao\\_tmp\\settings-live-backup-$TS.json"')],
    ["真语料·备份④：/c/ 形态 live → .bak",
      bash("cp /c/Users/Administrator/.claude/settings.json /c/Users/Administrator/.claude/settings.json.bak-20260712-marshal-hook")],
    ["真语料·备份⑤：Copy-Item live → (Join-Path $dst 'settings.json')",
      ps(`Copy-Item '${HOME}\\.claude\\settings.json' (Join-Path 'D:\\frank\\x' 'settings.json')`)],
    ["真语料·⑥写 config-sync 快照层（本闸只管 live 那一份）",
      ps(`Copy-Item "D:\\frank\\windsurf-dao\\_tmp\\04.json" "D:\\frank\\windsurf-dao\\config-sync\\common\\settings.json" -Force; "COPIED"`)],
    // ↓ 以下为构造语料，照实标注（真语料里没有这些形态，但它们是判据两侧的边界）
    ["构造：dao 指定的降级正路 _tmp/settings-patch.json",
      ps("Set-Content -Path _tmp/settings-patch.json -Value $json -Encoding utf8")],
    ["构造：项目级 .claude/settings.json（不是 cc-switch 投影）",
      bash("cp _tmp/x.json D:/frank/mousse-cli/.claude/settings.json")],
    ["构造：~/.claude 下别的文件", bash("cp _tmp/x.md ~/.claude/CLAUDE.md")],
    ["构造：Set-Content 的 -Value 恰好是那条路径（内容不是目标）",
      ps(`Set-Content -Path _tmp/note.txt -Value ${LIVE_V}`)],
    ["构造：单个正参的 Copy-Item（没有目标位，是复制到当前目录）", ps(`Copy-Item ${LIVE_V}`)],
    ["构造：正文里提到重定向写法（引号里的 `>` 不算重定向）",
      bash('echo "别写 cp x > ~/.claude/settings.json 这种命令"')],
    ["构造：node -e require 读 live（读不是写）",
      bash(`node -e "const s=require('$HOME/.claude/settings.json');console.log(Object.keys(s))"`)],
    // `sc` 同时是 C:\windows\system32\sc.exe（本机 Get-Command sc -All 实测两个都在），
    // 故刻意不收进写入类命令表 —— 与条款「加规则/别名前必须实测该词在其他语境的含义」一致。
    ["构造：sc.exe 服务控制（`sc` 刻意不收，此条钉住这个决定）", ps(`sc query ${LIVE_V}`)],
  ];
  for (const [name, p] of ALLOW) {
    const r = gate(p);
    check(`负控：${name} → exit 0`, r.code === 0, `code=${r.code} err=${r.err.slice(0, 160)}`);
  }

  // ── mutation（锚点用正则 + 每组一条「锚点仍在」前置断言）────────────────────
  // ⚠️ **盘上是 CRLF**（本仓 2026-08-02 实测 1047 处 CRLF / 0 处裸 LF）。锚点若写死 `\n`
  //    会一处都匹配不到 ⇒ 变异体 = 原文 ⇒ 被测闸照常绿，**而那与「守卫真的没塌陷」逐字节相同**
  //    （同 issue #103 当天咬过两次的形态）。故锚点一律走正则、换行位一律写 `\r?\n`，
  //    并且**每组先断言锚点在源码里恰好命中一次**，再断言行为翻转。
  const src = fs.readFileSync(HOOK, "utf8");
  function mutate(label, re, to, payload, expectBefore, expectAfter) {
    const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
    const n = (src.match(g) || []).length;
    check(`mutation 锚点在源码里恰好命中 1 次（${label}）`, n === 1, `命中 ${n} 次`);
    if (n !== 1) return;
    const mp = path.join(TMP, `mutant-g2-${label.replace(/[^\w]+/g, "-")}.js`);
    fs.writeFileSync(mp, src.replace(re, () => to), "utf8");
    const before = gate(payload).code;
    const after = gate(payload, { script: mp }).code;
    check(`${label}：真文件 ${expectBefore} / 改坏后 ${expectAfter} ⇒ 这条断言真的在测那段判据`,
      before === expectBefore && after === expectAfter, `before=${before} after=${after}`);
  }

  // 正向三形态（对抗验证官节「改坏要试不止一种形态」：①移除 ②留着字面但不执行 ③结果不被消费）
  mutate("①移除·shell 分支整个不进",
    /if \(\/\^\(Bash\|PowerShell\)\$\/\.test\(tool\)\) \{/, "if (false) {",
    ps(BYPASS), 2, 0);
  mutate("②留字面不执行·目标位提取块永不进",
    /if \(destLast \|\| allTarget\) \{/, "if (false && (destLast || allTarget)) {",
    ps(BYPASS), 2, 0);
  mutate("③结果不被消费·照样算目标但裁决被丢掉",
    /if \(!g2IsLive\(hit\.path\)\) continue;/, "if (true) continue;",
    ps(BYPASS), 2, 0);
  // 变量展开这一层单独换靶：证明拦下绕过的是「$env: 被展开了」，不是别的分支顺手拦的
  mutate("$env: 展开被改坏 ⇒ 变量形态漏过（而字面绝对路径仍拦）",
    /\.replace\(\/\\\$env:\(\?:USERPROFILE\|HOME\)\(\?!\[A-Za-z0-9_\]\)\/gi, H\)/,
    ".replace(/__never_matches__/gi, H)", ps(BYPASS), 2, 0);
  check("上一条改坏后，已展开的字面绝对路径仍然被拦（证明只打掉了变量那一层）", (() => {
    const re = /\.replace\(\/\\\$env:\(\?:USERPROFILE\|HOME\)\(\?!\[A-Za-z0-9_\]\)\/gi, H\)/;
    if (!re.test(src)) return false;
    const mp = path.join(TMP, "mutant-g2-envonly.js");
    fs.writeFileSync(mp, src.replace(re, () => ".replace(/__never_matches__/gi, H)"), "utf8");
    return gate(ps(`Copy-Item x.json "${HOME}\\.claude\\settings.json" -Force`), { script: mp }).code === 2;
  })());

  // 反向三条：把**豁免**改坏，对应负控必须由 exit 0 翻成 exit 2。
  // 没有这一组，「一组永远为真的负控」与「一组真管用的负控」在全绿输出里长得一模一样。
  mutate("反向·源位豁免（末位才是目标）改坏 ⇒ 真语料备份命令被误伤",
    /out\.push\(\{ why: "末位参数（目标位）", raw: positional\[positional\.length - 1\] \}\);/,
    'for (const q of positional) out.push({ why: "末位参数（目标位）", raw: q });',
    ps(`Copy-Item ${LIVE_V} "${V}\\.claude\\settings.json.bak-20260801-hardgates" -Force; "备份就位"`), 0, 2);
  mutate("反向·引号感知改坏 ⇒ 正文里提到的 `>` 被当成真重定向",
    /if \(c === '"' \|\| c === "'"\) \{ quote = c; quoted = true; continue; \}/,
    "if (false) { quote = c; quoted = true; continue; }",
    bash('echo "别写 cp x > ~/.claude/settings.json 这种命令"'), 0, 2);
  mutate("反向·目标位参数白名单改坏 ⇒ -Value 的内容被当成目标路径",
    /const isTarget = destLast \? G2_DEST_PARAM\.test\(name\) : G2_TARGET_PARAM\.test\(name\);/,
    "const isTarget = true;",
    ps(`Set-Content -Path _tmp/note.txt -Value ${LIVE_V}`), 0, 2);
  mutate("反向·`sc` 不收这个决定改坏 ⇒ sc.exe 服务控制命令被误伤",
    /"new-item", "ni"\]\)/, '"new-item", "ni", "sc"])',
    ps(`sc query ${LIVE_V}`), 0, 2);
  mutate("反向·live 精确比对改成后缀匹配 ⇒ 项目级 .claude/settings.json 被误伤",
    // 锚点 2026-08-04 两次随 G2 常量侧改动更新：先是 `G2_LIVE_DIR` 常量 → 惰性 `g2LiveDir()`
    // （常量侧原先不过 `g2Canon`，与候选侧归一深度不一致 ⇒ 短名 HOME 下整闸失明），
    // 后又拆成「语法层 / realpath 层」两层比（第二轮对抗官指出常量侧 I/O 站点无超时守卫）。
    // 现在把**目录相等判定**整个换成后缀匹配，等价于当年那个「精确比对被放宽」的变异。
    /    return g2MatchesLiveDir\(low\.slice\(0, low\.length - n\.length - 1\)\);/,
    "    return true;",
    bash("cp _tmp/x.json D:/frank/mousse-cli/.claude/settings.json"), 0, 2);

  check("真 hook 文件在本节全部 mutation 之后仍逐字节未改", sha(HOOK) === PRISTINE_SHA);
}

console.log("\n──── G2 · 对抗验证官夹击（PR #106 / issue #87）────");
// ── 这一节是谁加的、为什么和上一节分开 ──────────────────────────────────────
// 上一节是**实现官**写的（证明新加的判据管用）；本节是**对抗验证官**写的，目标是证伪。
// 两节刻意不合并：合并之后「这条是实现方自己挑的语料」与「这条是别人挑来打它的」
// 就分不开了，而语料**从哪来**正是近似判据唯一站得住的地方（官抗节「语料非自证」）。
//
// 本节两半：
//   ㈠ **误伤侧负控**（当前行为正确，本节把它钉住）—— 护栏两侧代价不对称：
//      漏报只是「规则退回文字」，误报是**会话当场卡死**且逃生阀只有用户设得了。
//   ㈡ **已知漏报/误伤登记表**（当前行为**不正确**，本节把它钉成"自失效"断言）——
//      清单一旦与实测不符，本节当场红，逼下一个人回来更新清单。
//      **这是退役触发器，不是"这些行为是对的"的背书**（dao-guard-writing ④：
//      规则集只增不减是结构必然，须专门给退役造触发器）。
{
  const ps = (command, cwd) => ({ tool_name: "PowerShell", tool_input: { command }, cwd });
  const V = "$env:USERPROFILE";
  const LIVE_V = `"${V}\\.claude\\settings.json"`;
  const LIVEDIR_V = `"${V}\\.claude"`;
  const g2 = (p) => { const r = gate(p); return r.code === 2 && /G2-live-settings/.test(r.err) ? 2 : 0; };

  // ── ㈠ 误伤侧负控：真语料全域扫过零误伤，这些是把那个结果钉住的桩 ──────────
  // 全域实测（2026-08-02，对抗验证官）：`~/.claude/projects/**/*.jsonl` 里 27519 条**去重后**的
  // 真实 Bash/PowerShell 命令，逐条喂改前(fa46ea6)/改后两版 G2 —— 新增拦截 **2 条**，
  // 两条都是**真阳性**（`Copy-Item <源> "$env:USERPROFILE\.claude\settings.json" -Force` 同型），
  // 误伤 **0 条**、退化 **0 条**、守卫自身抛异常 **0 条**。下面这些是构造的边界桩，
  // **照直标：全部凭空构造**（真语料里没有这些形态，它们是判据两侧的悬崖边）。
  const ALLOW_ADV = [
    // 讨论这条规则本身 —— 守卫的输出会落回它自己的扫描面（dao-guard-writing ③）
    ["构造：多行 commit message 正文里提到那条绕过命令（引号感知 ⇒ 不切段）",
      bash(`git commit -m "[cc] fix: G2 扩面\n\n修的是 Copy-Item x \\"${V}\\.claude\\settings.json\\" -Force 这条"`)],
    ["构造：gh pr comment --body 里提到那条绕过命令",
      bash(`gh pr comment 106 --body "绕过原文：Copy-Item a ${V}\\.claude\\settings.json -Force"`)],
    ["构造：printf 把那条命令写进 _tmp 笔记",
      bash(`printf '%s\\n' 'Copy-Item a "${V}\\.claude\\settings.json" -Force' > _tmp/x.md`)],
    // 读 live 的合法形态（备份/诊断/对比）—— 「只看目标位」这个取舍的整个价值所在
    ["构造：管道读 live → 落 _tmp", ps(`Get-Content ${LIVE_V} -Raw | Out-File -FilePath _tmp/live.json -Encoding utf8`)],
    ["构造：git diff --no-index 比对 live 与快照层", bash(`git diff --no-index "$HOME/.claude/settings.json" config-sync/common/settings.json`)],
    ["构造：jq 读 live → 输出重定向到 _tmp", bash(`jq '.hooks.PreToolUse' "$HOME/.claude/settings.json" > _tmp/pre.json`)],
    ["构造：--selfcheck（它自己就要读 live）", bash("node ccswitch/hooks/dao-hard-gates.js --selfcheck")],
    ["构造：Copy-Item live → _tmp 备份（真语料同型）", ps(`Copy-Item ${LIVE_V} _tmp\\live-backup.json -Force`)],
    ["构造：输入重定向读 live、写 _tmp（`<` 是读不是写）", bash(`tee _tmp/o.txt < "$HOME/.claude/settings.json"`)],
    // 相邻但不是 live 的写入
    ["构造：写 ~/.claude/settings.json.bak", ps(`Copy-Item _tmp/x.json "${V}\\.claude\\settings.json.bak" -Force`)],
    ["构造：写 ~/.claude/agents/ 下的文件", ps(`Set-Content -Path "${V}\\.claude\\agents\\x.md" -Value "y"`)],
    ["构造：写 ~/.codex/settings.json（别的工具的同名文件）", ps(`Set-Content -Path "${V}\\.codex\\settings.json" -Value "{}"`)],
    ["构造：目标目录是 ~/.claude 但源 basename 不是 settings", ps(`Copy-Item .\\CLAUDE.md ${LIVEDIR_V} -Force`)],
    ["构造：New-Item 建 ~/.claude 目录本身", ps(`New-Item -ItemType Directory -Path ${LIVEDIR_V} -Force`)],
    // 变量表污染：同一条命令里别处的赋值不该串到目标位
    ["构造：$p 指向 live 但本条命令的目标是别的文件",
      ps(`$p = ${LIVE_V}; Write-Host "live is $p"; Copy-Item a.json b.json -Force`)],
    // 重定向 token 化的边界
    ["构造：PowerShell -gt 比较不是重定向", ps('if ((Get-Item x).Length -gt 0) { "ok" }')],
    ["构造：node -e 双引号里的 `>`", bash(`node -e "if (1 > 0) console.log('a > b')"`)],
    ["构造：`2>&1` 是 dup 不是文件", bash("cargo build 2>&1")],
    ["构造：输出到 $null", ps("Copy-Item a b > $null")],
    // cwd 恰在 ~/.claude 时的日常操作 —— 本机 `~/.claude` 就是常用工作目录之一
    ["构造：cwd=~/.claude 时写 CLAUDE.md", ps("Set-Content -Path CLAUDE.md -Value \"x\"", `${HOME}\\.claude`)],
    ["构造：cwd=~/.claude 时把 live 备份去 _tmp", ps("Copy-Item settings.json D:\\frank\\_tmp\\live.json -Force", `${HOME}\\.claude`)],
  ];
  for (const [name, p] of ALLOW_ADV) {
    const r = gate(p);
    check(`负控·对抗：${name} → exit 0`, r.code === 0, `code=${r.code} err=${r.err.slice(0, 160)}`);
  }

  // ── ㈡ 已知漏报 / 已知误伤 登记表（自失效断言）────────────────────────────
  // 🔴 **下面每一条的当前行为都是错的。** 本表钉住的是「错到什么程度」，不是「这样是对的」。
  //    补上覆盖（或修掉误伤）之后，对应那条会**变红** —— 那就是让你回来更新本表的信号。
  //    形态出处：官抗节「换靶 mutation 两态」的镜像 —— 那条防「绿信号答错问题」，
  //    这张表防「**清单**答错问题」：一份写在 PR body 里的漏报面清单没有任何东西在核它。
  //    每条末尾的 PowerShell 语义都**在本机实跑验证过**（临时文件，从未触碰真 live）。
  const KNOWN_GAPS = [
    // ── ✅ 已修（issue #112 甲⑥⑦⑨，PR 见下）：原先住在本表的 6 条已迁去
    //    「issue #112 三格修复」那一节当**正控**。本表刻意留这条注释而不是静默删行 ——
    //    表本身是退役触发器（dao-guard-writing ④），删得无声无息就等于把触发器也删了。
    //    迁走的 6 条：⑥ `-Path <源> <目标>` · ⑥ `-LiteralPath <源> <目标>` ·
    //    ⑦ 具名 `-Destination <目录>` · ⑨ shell 分支 `..` 回绕 · ⑨ Edit/Write 分支 `..` 回绕 ·
    //    ⑨ 8.3 短名。**⑧ 与两处误伤刻意未动**（判断档，留给用户拍板，见 issue #112 甲⑧/乙）。
    //
    // ⚠ 下面这条是 **#112 这一批新发现**的（攻 ⑦ 的尾斜杠边界时撞出来的），不在 #106 那份清单里。
    ["漏报·双引号里的**尾反斜杠**吞掉闭引号 ⇒ 整条命令剩余部分并进一个 token（具名目标）",
      ps(`Copy-Item .\\settings.json -Destination "${V}\\.claude\\" -Force`), 0],
    ["漏报·同上，位置目标也一样（证明它是 tokenizer 层的，不是某个分支的）",
      ps(`Copy-Item .\\settings.json "${V}\\.claude\\" -Force`), 0],
    ["漏报·单个正参 + cwd 恰在 ~/.claude ⇒ 隐式目标就是 live（本机实跑确认）",
      ps("Copy-Item ..\\backup\\settings.json -Force", `${HOME}\\.claude`), 0],
    ["漏报·Rename-Item 的 NewName 相对**源目录**解析，本闸按 cwd 解析（本机实跑确认）",
      ps(`Rename-Item "${V}\\.claude\\settings.json.bak" settings.json`), 0],
    ["漏报·PowerShell 逗号数组参数 `-Path a,b`", ps(`Set-Content -Path "_tmp/a.json",${LIVE_V} -Value "{}"`), 0],
    // ↓ 以下 3 条 PR body 的「已知漏报面」里已声明，本表只是把它们变成可机检的
    ["漏报·程序化写入（PR body 已声明第 1 条）",
      bash(`node -e "require('fs').writeFileSync(process.env.USERPROFILE+'/.claude/settings.json','{}')"`), 0],
    ["漏报·表达式右值变量（PR body 已声明第 2 条）",
      ps(`$p = Join-Path ${V} '.claude\\settings.json'; Copy-Item x $p -Force`), 0],
    ["漏报·cd 不传播（PR body 已声明第 3 条）", bash("cd ~/.claude && cp /d/x/settings.json settings.json")],
    ["漏报·`cp -t <目录>`（PR body 已声明第 5 条；注意此形态下**目标目录被读成了源位**）",
      bash(`cp -t "$HOME/.claude" ./settings.json`), 0],
    ["漏报·`New-Item -Path <目录> -Name <文件名>`（PR body 已声明第 5 条）",
      ps(`New-Item -Path ${LIVEDIR_V} -Name settings.json -ItemType File -Value "{}" -Force`), 0],
    ["漏报·robocopy（PR body 已声明第 5 条）", ps(`robocopy D:\\src ${LIVEDIR_V} settings.json`), 0],
    // ↓ 命令表是闭世界的：不在 G2_DEST_LAST/G2_ALL_TARGET 里的写入命令一律看不见
    ["漏报·命令表闭世界：tar -C 解包进 ~/.claude", bash(`tar -xf backup.tar -C "$HOME/.claude"`), 0],
    ["漏报·命令表闭世界：Expand-Archive -DestinationPath", ps(`Expand-Archive -Path b.zip -DestinationPath ${LIVEDIR_V} -Force`), 0],
    ["漏报·命令表闭世界：sed -i 原地改 live", bash(`sed -i 's/a/b/' "$HOME/.claude/settings.json"`), 0],
    ["漏报·命令表闭世界：dd of=", bash(`dd if=x.json of="$HOME/.claude/settings.json"`), 0],
    ["漏报·命令替换内部的写（`$(...)` 段不再切分，整段段首是 echo）",
      bash(`echo $(cp /d/x.json "$HOME/.claude/settings.json")`), 0],
    // ⚠ 8.3 短名那条已修（#112 甲⑨），迁去下节当正控。**UNC 共享形态仍在**——
    //    `//localhost/C$/…` 的解法只有 `realpath`，而它对网络路径会把 SMB 超时（可达数十秒）
    //    拖进 PreToolUse 钩子 ⇒ 拿会话卡死换覆盖面，刻意不换。判据见 hook 里 g2LongPath 的收窄㈠。
    //    （`\\?\C:\…` 那个**扩展长度前缀**形态是纯字符串、无 I/O，已在 #112 里修掉。）
    ["漏报·UNC 本机形态（realpath 是唯一解法，但它对网络路径会把 SMB 超时拖进钩子 ⇒ 刻意不修）",
      ps(`Copy-Item x "\\\\localhost\\C$\\Users\\Administrator\\.claude\\settings.json" -Force`), 0],
    // ↓ 误伤侧的两条（当前**过度拦截**）
    ["误伤·heredoc 正文里写着那条命令 ⇒ 正文行被当成真命令（守卫输出落回自己扫描面）",
      bash(`cat > _tmp/note.md <<'EOF'\nCopy-Item x "${V}\\.claude\\settings.json" -Force\nEOF`), 2],
    ["误伤·写入类命令的 `-Value (表达式)` 吞掉取值 ⇒ 后续 token 被当成目标位",
      ps(`Set-Content -Path _tmp/backup.json -Value (Get-Content ${LIVE_V} -Raw)`), 2],
  ];
  const drift = [];
  for (const [name, p, want] of KNOWN_GAPS) {
    const got = g2(p);
    if (got !== (want === undefined ? 0 : want)) drift.push(`${name}（表里写 ${want === undefined ? 0 : want}，实测 ${got}）`);
  }
  check(
    `已知漏报/误伤登记表 ${KNOWN_GAPS.length} 条与实测逐条一致` +
    "（🔴 本条变红 = 有一格的行为变了，去更新表 + 更新 hook 头注 G2 的漏报面清单；**不是**要你把表改回去）",
    drift.length === 0, drift.join(" ; ")
  );

  // ── mutation：证明上面那批**新增负控**真有判别力 ─────────────────────────
  // 官抗节「改坏要试不止一种形态」：①移除 ②留字面但不执行 ③结果不被消费。
  // ⚠ 盘上是 CRLF，锚点一律走正则（`\r?\n`），且每组先断言**锚点恰好命中 1 次**。
  const src2 = fs.readFileSync(HOOK, "utf8");
  function mutate2(label, re, to, payload, expectBefore, expectAfter) {
    const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
    const n = (src2.match(g) || []).length;
    check(`mutation 锚点在源码里恰好命中 1 次（${label}）`, n === 1, `命中 ${n} 次`);
    if (n !== 1) return;
    const mp = path.join(TMP, `mutant-adv-${label.replace(/[^\w]+/g, "-")}.js`);
    fs.writeFileSync(mp, src2.replace(re, () => to), "utf8");
    // canary：变异体本身还活着（能跑到被测逻辑，只是行为被改）—— 一个把靶弄死的
    // mutation 会让每条断言都翻，而那正是「判别力满分」的表象（官抗节「变异体存活」）。
    const alive = gate({ tool_name: "Bash", tool_input: { command: "echo hi" } }, { script: mp });
    check(`变异体存活（${label}）：无关输入仍 exit 0 且无 fail-open 告警`,
      alive.code === 0 && !/守卫自身出错/.test(alive.err), `code=${alive.code} err=${alive.err.slice(0, 120)}`);
    const before = gate(payload).code;
    const after = gate(payload, { script: mp }).code;
    check(`${label}：真文件 ${expectBefore} / 改坏后 ${expectAfter}`,
      before === expectBefore && after === expectAfter, `before=${before} after=${after}`);
  }

  // ①移除：整个 live 精确比对换成后缀匹配 ⇒ 「写别的工具的同名文件」负控被误伤
  mutate2("①移除·live 精确比对 ⇒ ~/.codex/settings.json 被误伤",
    // 锚点 2026-08-04 两次随 G2 常量侧改动更新：先是 `G2_LIVE_DIR` 常量 → 惰性 `g2LiveDir()`
    // （常量侧原先不过 `g2Canon`，与候选侧归一深度不一致 ⇒ 短名 HOME 下整闸失明），
    // 后又拆成「语法层 / realpath 层」两层比（第二轮对抗官指出常量侧 I/O 站点无超时守卫）。
    // 现在把**目录相等判定**整个换成后缀匹配，等价于当年那个「精确比对被放宽」的变异。
    /    return g2MatchesLiveDir\(low\.slice\(0, low\.length - n\.length - 1\)\);/,
    "    return true;",
    ps(`Set-Content -Path "${V}\\.codex\\settings.json" -Value "{}"`), 0, 2);
  // ②留字面但不执行：`in`（输入重定向）分支跳过被关掉 ⇒ `<` 后的路径被当成写目标。
  // 靶必须是**写入类命令**（`tee` 在 G2_ALL_TARGET 里），否则整段根本走不到参数解析
  // —— 首版靶写的是 `node t.js < live`，段首 `node` 不在两张表里，mutation 恒不翻转，
  //    而「锚点命中 1 次 + 变异体存活」两条前置**照样全绿** ⇒ 那正是本条要防的那种假绿。
  mutate2("②留字面不执行·输入重定向跳过被关掉 ⇒ 读被当成写",
    /if \(toks\[i\]\.k === "in"\) \{ i\+\+; continue; \}/,
    'if (false && toks[i].k === "in") { i++; continue; }',
    bash(`tee _tmp/o.txt < "$HOME/.claude/settings.json"`), 0, 2);
  // ③结果不被消费：目标目录 basename 展开照样算，但结果不 push ⇒ 承重正控从红变绿
  // ⚠ 锚点 2026-08-09 随 #199 更新：`g2IsLiveDir(destDir, destPre)` 那道 `continue` 已删，
  //   前筛改成问**源文件名**（`g2BaseCouldBeLive(base)`）并挪进了这一行的条件里。
  //   **旧锚 `if (base) out.push(...)` 已不在盘上** ⇒ 上一版这条会退化成「改坏了也不红」。
  mutate2("③结果不被消费·目标目录 basename 展开算了但不入候选 ⇒ 承重正控漏过",
    /if \(base && g2BaseCouldBeLive\(base\)\) out\.push\(\{ why: "目标目录 \+ 源文件名", raw: `\$\{destDir\}\/\$\{base\}` \}\);/,
    'if (base && g2BaseCouldBeLive(base)) { const _ = `${destDir}/${base}`; }',
    bash("cp _tmp/settings.json ~/.claude/"), 2, 0);
  // 反向：把「源位放行」改坏 ⇒ 上面「Copy-Item live → _tmp 备份」这条负控必须翻红。
  // 没有这一组，「一条永远为真的负控」与「一条真管用的负控」在全绿输出里长得一样。
  mutate2("反向·源位豁免改坏 ⇒ 备份类负控被误伤",
    /out\.push\(\{ why: "末位参数（目标位）", raw: positional\[positional\.length - 1\] \}\);/,
    'for (const q of positional) out.push({ why: "末位参数（目标位）", raw: q });',
    ps(`Copy-Item ${LIVE_V} _tmp\\live-backup.json -Force`), 0, 2);

  // ── 调用点覆盖率（官抗节「mutation 报告需附加调用点覆盖率」）─────────────
  // 判据：本 PR 新增判据的**生产调用点**有几个、本节端到端覆盖了几个。
  {
    const callSites = (name) => (src2.match(new RegExp(`\\b${name}\\s*\\(`, "g")) || []).length - 1; // 减去定义处
    // ⚠ 2026-08-09（#199）换名：`g2IsLiveDir` 已删（它问的是「目标目录末段像不像 `.claude`」，
    //   而 `~/.claude` 是链时真实目录可以叫任何名字 ⇒ 那个问题本身就是错的）。
    //   顶替它那一格前筛职责的是 `g2BaseCouldBeLive`（问源文件名），故计数换成它。
    const map = { g2WriteTargets: callSites("g2WriteTargets"), g2Resolve: callSites("g2Resolve"), g2IsLive: callSites("g2IsLive"), g2BaseCouldBeLive: callSites("g2BaseCouldBeLive") };
    const line = Object.entries(map).map(([k, v]) => `${k}=${v}`).join(" ");
    // ⚠️ **这句话 2026-08-03（#112）订正过一个数字，订正史留着**：原文写「g2Resolve 2/2
    //   （shell 分支 + Edit/Write 分支）」，而 `g2Resolve` 的生产调用点**当时就是 3 个**
    //   （第三个是 basename 展开里解 destDir 那次，就在 g2WriteTargets 自己体内）。
    //   分母是**手写死的**，分子也是手写死的，于是它印出来的 "2/2" 看起来像满覆盖、
    //   实则连分母都不对 —— 而上面那行 `${line}` 明明已经把真值算出来印在同一句里了。
    //   现改成引用算出来的真值。**它是本节唯一一个没有断言在守的数字**（console.log 不参与红绿），
    //   正是「检查器自己描述自己那半最少被人回头看」的实例（官通节「同批查引用」第四格）。
    console.log(`  （调用点覆盖率）G2 新判据函数的生产调用点：${line}；` +
      `本节端到端覆盖：g2WriteTargets 1/1（shell 分支）· g2Resolve ${map.g2Resolve}/${map.g2Resolve}` +
      `（Edit/Write 分支 + g2WriteTargets 的候选解析 + basename 展开的 destDir）· ` +
      `g2IsLive 2/2 · g2BaseCouldBeLive ${map.g2BaseCouldBeLive}/${map.g2BaseCouldBeLive}` +
      `（`+"`-Destination <目录>` 那条正控走到「像」的一支，负控 `cp a.md <目录>` 走到「不像」的一支）。" +
      `**未覆盖 0 个** —— 但覆盖的是"这个函数被走到了"，` +
      `不是"它的每个分支都被走到了"，后者由上面那张登记表反面记录。` +
      `⚠ 分母的**已知不精确**照直写（2026-08-09）：\`callSites\` 是纯文本计数、` +
      `**数得进注释里在讨论它的那些**，且箭头函数常量的定义式（\`const f = (x) =>\`）它数不到 ⇒ ` +
      `对 \`g2BaseCouldBeLive\` 这类它「多算注释、少减定义」，两个方向的误差不保证抵消。` +
      `守它的断言只要求每项 ≥1（改名即失效），**不要求这些数字精确**。`);
    check("调用点计数拿得到（拿不到说明函数被改名，覆盖率那句话即失效）",
      Object.values(map).every((v) => v >= 1), JSON.stringify(map));
  }

  check("真 hook 文件在本节全部 mutation 之后仍逐字节未改", sha(HOOK) === PRISTINE_SHA);
}

console.log("\n──── G2 · issue #112 三格修复（甲⑥ 具名源 / 甲⑦ 具名 -Destination / 甲⑨ 绝对路径归一）────");
// ── 这一节装什么、为什么又是单开一节 ────────────────────────────────────────
// 上面两节分别是 #87 的实现官与对抗验证官写的。本节是 **#112 的实现官**写的，
// 装的是那张登记表里**被修掉的那 6 条**（现在它们是正控，不再是漏报）。
// 三节不合并，理由同上一节：语料**从哪来**是近似判据唯一站得住的地方，
// 合并之后「谁挑的这条语料」就分不开了。
//
// 🔴 **语料来源照直标（官抗节「语料非自证」）**：
//   · **⑨ 的两类形态在真语料里是主流，不是构造的** —— 全量普查（2026-08-03，
//     `~/.claude/projects/**/*.jsonl`，1330 个 jsonl / 373865 行 / **27365 条去重命令**）：
//     `~<数字>` 8.3 短名路径 **1196 条**（本机 scratchpad 一律走 `C:\Users\ADMINI~1\AppData\…`，
//     而 `ADMINI~1` 正是 HOME 的短名）· `\\?\` / `\\localhost\C$` 等 UNC 形态 **27 条**
//     （其中一条真实命令逐字枚举了 `'C:\Users\ADMINI~1'`、`'\\?\C:\Users\Administrator'`、
//     `'\\localhost\C$\Users\Administrator'` 三种写法去探 home 的等价形态）。
//     ⇒ ⑨ **不是理论洞**：这台机器每天都在产生它需要的那种路径。
//   · **⑦ 的形态在真语料里有**（`-Destination` 具名 **107 处 / 42 文件**，其中
//     `Copy-Item -LiteralPath $src -Destination $dst -Force` 是反复出现的固定搭配），
//     但**目标位从来不是 live** ⇒ 下面正控是「真形态 + 目标位换成 live」，**不是纯真语料**。
//   · **⑥ 的混合形态（具名源 + 位置目标）在真语料里 0 条** —— 逐条人读确认那 2 条正则命中
//     全是 `Set-Content -Path` 的误匹配。**⑥ 的正控全部凭空构造**，照直标。
//     它站得住的地方不在语料，在 **PowerShell 的参数绑定语义**：`-Path` 具名之后，
//     剩下的第一个正参绑到 position 1 = `-Destination`（本机实跑确认真的会覆盖目标，
//     出处见 issue #87 对抗验证官的原始记录）。
{
  const ps = (command, cwd) => ({ tool_name: "PowerShell", tool_input: { command }, cwd });
  const V = "$env:USERPROFILE";
  const LIVE_V = `"${V}\\.claude\\settings.json"`;
  const LIVEDIR_V = `"${V}\\.claude"`;
  const HOME_FS = HOME.replace(/\\/g, "/");

  // ── 正控：这 6 条 + 扩展形态，改前**全部漏过**（原始双态输出见 PR body）────────
  const BLOCK_112 = [
    // 甲⑥ —— 具名源吃掉正参，只剩 1 个 ⇒ 撞上「单正参不算目标位」早退
    ["⑥ 构造·`Copy-Item -Path <源> <目标>`", ps(`Copy-Item -Path _tmp/x.json ${LIVE_V} -Force`)],
    ["⑥ 构造·`-LiteralPath <源> <目标>`", ps(`Copy-Item -LiteralPath _tmp/x.json ${LIVE_V} -Force`)],
    ["⑥ 构造·`-lp` 缩写", ps(`Copy-Item -lp _tmp/x.json ${LIVE_V} -Force`)],
    ["⑥ 构造·`Move-Item -Path <源> <目标>`", ps(`Move-Item -Path _tmp/x.json ${LIVE_V} -Force`)],
    ["⑥ 构造·内联冒号 `-Path:<源>`", ps(`Copy-Item -Path:_tmp/x.json ${LIVE_V} -Force`)],
    ["⑥ 构造·具名源 + 位置目标给的是**目录**（basename 展开也要跟着走）",
      ps(`Copy-Item -Path .\\settings.json ${LIVEDIR_V} -Force`)],
    // 甲⑦ —— basename 展开原先只写在位置分支里，具名 -Destination 拿不到
    ["⑦ 真形态+换靶·正参源 + `-Destination <目录>`", ps(`Copy-Item .\\settings.json -Destination ${LIVEDIR_V} -Force`)],
    ["⑦ 真形态+换靶·`-LiteralPath <源> -Destination <目录>`（真语料固定搭配）",
      ps(`Copy-Item -LiteralPath D:\\src\\settings.json -Destination ${LIVEDIR_V} -Force`)],
    ["⑦ 构造·`-Destination:<目录>` 内联冒号", ps(`Copy-Item .\\settings.local.json -Destination:${LIVEDIR_V} -Force`)],
    // 甲⑨ —— 绝对路径此前一步归一都没有。**两个分支都要验**：shell 是新的，Edit/Write 是自诞生起就漏的那个
    ["⑨ 构造·shell 分支 `..` 回绕", ps(`Copy-Item x "${V}\\.claude\\..\\.claude\\settings.json" -Force`)],
    ["⑨ 构造·**Edit 分支** `..` 回绕（自诞生起就漏的那一格）", edit(`${HOME}\\.claude\\..\\.claude\\settings.json`)],
    ["⑨ 构造·**Write 分支** `.` 当前目录段",
      { tool_name: "Write", tool_input: { file_path: `${HOME}\\.claude\\.\\settings.json` } }],
    ["⑨ 构造·**MultiEdit 分支** `..` 回绕 + settings.local.json",
      { tool_name: "MultiEdit", tool_input: { file_path: `${HOME}\\.claude\\..\\.claude\\settings.local.json` } }],
    ["⑨ 构造·**NotebookEdit 分支**（notebook_path 走的是同一条解析）",
      { tool_name: "NotebookEdit", tool_input: { notebook_path: `${HOME}\\.claude\\..\\.claude\\settings.json` } }],
    ["⑨ 构造·Edit 分支 `//` 重复斜杠", edit(`${HOME_FS}/.claude//settings.json`)],
    ["⑨ 真语料形态·Edit 分支 8.3 短名（本机 1196 条同型路径）", edit("C:\\Users\\ADMINI~1\\.claude\\settings.json")],
    ["⑨ 真语料形态·shell 分支 8.3 短名", ps(`Copy-Item x "C:\\Users\\ADMINI~1\\.claude\\settings.json" -Force`)],
    ["⑨ 真语料形态·Win32 扩展长度前缀 `\\\\?\\C:\\…`（纯字符串前缀，剥它零 I/O）",
      edit("\\\\?\\C:\\Users\\Administrator\\.claude\\settings.json")],
    ["⑨ 构造·盘根回绕 `C:/../`（win32 在盘根处夹住 `..`）",
      bash("cp x.json C:/../Users/Administrator/.claude/settings.json")],
    ["⑨ 构造·三格叠加：具名源 + `-Destination` 目录 + `..` 回绕",
      ps(`Copy-Item -LiteralPath .\\settings.json -Destination "${V}\\.claude\\..\\.claude" -Force`)],
  ];
  for (const [name, p] of BLOCK_112) {
    const r = gate(p);
    check(`正控：${name} → exit 2`, r.code === 2 && /G2-live-settings/.test(r.err), `code=${r.code}`);
  }

  // ── 负控：修完之后**不许**多拦这些（护栏两侧代价不对称，误报 = 会话当场卡死）────
  // ⚠ 这一组比正控更要紧：⑥ 把「目标位存在」的门槛从 2 个正参降到 1 个，
  //   ⑨ 让每一条绝对路径都多走一层归一（8.3 那格还会落一次 I/O）—— 两处都在**放宽**，
  //   而放宽正是误伤的来源。下面逐条钉住「放宽到哪儿为止」。
  const ALLOW_112 = [
    // ⑥ 的边界：具名源存在时，正参才是目标；源位仍然一律放行
    ["构造·具名源把 live 读走做备份（源位放行 —— 本闸最要紧的那个取舍）",
      ps(`Copy-Item -Path ${LIVE_V} -Destination "${V}\\.claude\\settings.json.bak" -Force`)],
    ["构造·具名源 live → _tmp 备份（正参目标）", ps(`Copy-Item -Path ${LIVE_V} _tmp\\live.json -Force`)],
    ["真语料形态·`-LiteralPath <源> -Destination <目标>` 两头都不是 live",
      ps("Copy-Item -LiteralPath D:/a/x.md -Destination D:/b/x.md -Force")],
    ["构造·**单个正参** Copy-Item（甲⑧ 判断档，不在本批 ⇒ 行为必须一个字节不变）", ps(`Copy-Item ${LIVE_V}`)],
    ["构造·具名源 + 无正参（没有目标位）", ps(`Copy-Item -Path ${LIVE_V} -Force`)],
    // ↓ 这两条钉住 G2_SRC_PARAM **只收源位那三个名字**这个决定。PowerShell 语义：`-Filter`/
    //   `-Encoding` 是过滤/编码，不吃源位 ⇒ 单个正参仍绑到 position 0 = `-Path`（源），
    //   拦它就是把甲⑧ 那一整类误伤进来。上面「反向⑥-b」那条 mutation 专门验这两条真会红。
    ["构造·`-Filter <值>` 不是源位 ⇒ 单正参仍是源，不许拦", ps(`Copy-Item -Filter *.json ${LIVE_V}`)],
    ["构造·`-Encoding <值>` 同上", ps(`Copy-Item -Encoding utf8 ${LIVE_V}`)],
    ["构造·`-Destination <目录>` 是 live 但源 basename 不是 settings",
      ps(`Copy-Item -Path .\\CLAUDE.md -Destination ${LIVEDIR_V} -Force`)],
    // ⑨ 的边界：归一不许把不是 live 的路径归成 live，也不许改写非盘符路径
    ["构造·`..` 回绕但终点是 ~/.codex（归一不许归到 live 上）", edit(`${HOME}\\.claude\\..\\.codex\\settings.json`)],
    ["构造·8.3 短名但终点不是 live", edit("C:\\Users\\ADMINI~1\\.claude\\CLAUDE.md")],
    ["构造·8.3 短名 + **项目级** settings.json（realpath 解开后仍不是 live）",
      edit("C:\\Users\\ADMINI~1\\AppData\\Local\\x\\.claude\\settings.json")],
    ["构造·8.3 短名指向**不存在**的路径（realpath 抛错 ⇒ 必须按原样比，不许崩也不许乱拦）",
      edit("C:\\Users\\NOSUCH~9\\.claude\\settings.json")],
    ["构造·POSIX 根回绕不许被补上当前盘符（`path.win32.resolve` 会干这事，故按根形态分派）",
      edit("/../home/x/.claude/settings.json")],
    ["构造·UNC 共享形态（覆盖面外，行为必须不变）",
      ps(`Copy-Item x "\\\\localhost\\C$\\Users\\Administrator\\.claude\\settings.json" -Force`)],
    ["构造·正文里提到 `..` 路径（引号感知仍在）", bash('echo "别写 cp x ~/.claude/../.claude/settings.json"')],
    ["构造·相对路径仍按 cwd 解析（归一不许吃掉这条老路）", bash("cp new.json _tmp/settings.json", HOME)],
  ];
  for (const [name, p] of ALLOW_112) {
    const r = gate(p);
    check(`负控：${name} → exit 0`, r.code === 0, `code=${r.code} err=${r.err.slice(0, 160)}`);
  }

  // ── mutation：三形态 + 反向。锚点一律正则（盘上 CRLF，写死 `\n` 恒不命中，见 #103）──
  const src3 = fs.readFileSync(HOOK, "utf8");
  function mutate3(label, re, to, payload, expectBefore, expectAfter) {
    const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
    const n = (src3.match(g) || []).length;
    check(`mutation 锚点在源码里恰好命中 1 次（${label}）`, n === 1, `命中 ${n} 次`);
    if (n !== 1) return null;
    const mp = path.join(TMP, `mutant-112-${label.replace(/[^\w]+/g, "-")}.js`);
    fs.writeFileSync(mp, src3.replace(re, () => to), "utf8");
    // 变异体存活（官抗节）：一个把靶弄死的 mutation 会让每条断言都翻，而那正是「判别力满分」的表象
    const alive = gate({ tool_name: "Bash", tool_input: { command: "echo hi" } }, { script: mp });
    check(`变异体存活（${label}）：无关输入仍 exit 0 且无 fail-open 告警`,
      alive.code === 0 && !/守卫自身出错/.test(alive.err), `code=${alive.code} err=${alive.err.slice(0, 120)}`);
    const before = gate(payload).code;
    const after = gate(payload, { script: mp }).code;
    check(`${label}：真文件 ${expectBefore} / 改坏后 ${expectAfter}`,
      before === expectBefore && after === expectAfter, `before=${before} after=${after}`);
    return mp;
  }

  const P6 = ps(`Copy-Item -Path _tmp/x.json ${LIVE_V} -Force`);
  const P7 = ps(`Copy-Item .\\settings.json -Destination ${LIVEDIR_V} -Force`);
  const P9 = edit(`${HOME}\\.claude\\..\\.claude\\settings.json`);
  const P9_83 = edit("C:\\Users\\ADMINI~1\\.claude\\settings.json");

  // 甲⑥ 三形态 —— 三条路各自独立地能让这一格重新漏掉
  mutate3("⑥①移除·门槛写死回 2（等于把本格的修复整个删掉）",
    /const needed = \(namedSrcs\.length && !G2_NO_SRC_THRESHOLD\.has\(head\)\) \? 1 : 2;/, "const needed = 2;", P6, 2, 0);
  mutate3("⑥②留字面不执行·具名源照旧被识别但从不入 namedSrcs ⇒ 门槛恒为 2",
    /else if \(destLast && G2_SRC_PARAM\.test\(name\)\) namedSrcs\.push\(val\);/,
    "else if (false && destLast && G2_SRC_PARAM.test(name)) namedSrcs.push(val);", P6, 2, 0);
  mutate3("⑥③结果不被消费·needed 照算，但取门槛时绕过它直接用字面 2",
    /const hasDestPos = positional\.length >= needed;/,
    "const hasDestPos = positional.length >= 2;", P6, 2, 0);
  check("⑥ 的三个 mutation 都不该动到「正参源」那条老路（`Copy-Item <源> <目标>` 仍拦）", (() => {
    const mp = path.join(TMP, "mutant-112-6-sidecheck.js");
    fs.writeFileSync(mp, src3.replace(/const needed = \(namedSrcs\.length && !G2_NO_SRC_THRESHOLD\.has\(head\)\) \? 1 : 2;/, () => "const needed = 2;"), "utf8");
    return gate(ps(`Copy-Item _tmp/x.json ${LIVE_V} -Force`), { script: mp }).code === 2;
  })());

  // 甲⑦ —— 具名目标必须进 destRaws，否则 basename 展开永远看不到它
  mutate3("⑦①移除·具名目标不再入 destRaws ⇒ 具名 -Destination 目录形态重新漏掉",
    /if \(isTarget\) \{ out\.push\(\{ why: `参数 \$\{name\}`, raw: val \}\); if \(destLast\) destRaws\.push\(val\); \}/,
    'if (isTarget) { out.push({ why: `参数 ${name}`, raw: val }); }', P7, 2, 0);
  mutate3("⑦③结果不被消费·具名目标的取值照读，但不入 destRaws",
    /if \(destLast\) destRaws\.push\(val\);/,
    "if (destLast) { const _unused = val; }", P7, 2, 0);
  check("⑦ 改坏后，**位置**目标位给目录的老路仍然拦（证明只打掉了具名那一格）", (() => {
    const mp = path.join(TMP, "mutant-112-7-sidecheck.js");
    fs.writeFileSync(mp, src3.replace(/if \(destLast\) destRaws\.push\(val\);/, () => "if (destLast) { const _unused = val; }"), "utf8");
    return gate(bash("cp _tmp/settings.json ~/.claude/"), { script: mp }).code === 2;
  })());

  // 甲⑨ 三形态 —— 归一这一层被打掉的三种方式
  // ⚠ 锚点 2026-08-08 随 #134 更新：`g2Resolve` 拆成了
  //   `g2Resolve(raw,cwd,vars) = g2Canon(g2ResolvePre(raw,cwd,vars))`（拆分理由见 hook 里
  //   `g2ResolvePre` 上方：快筛必须看得见归一前的末段）。**旧锚点 `return g2Canon(s);` 恒不命中**
  //   ⇒ 上一版这四条 mutation 会一起变成「改坏了也不红」，而那与「判据没塌陷」逐字节相同。
  //   **它们没有静默**：`命中 0 次` 那条前置断言当场红了 4 条并逐个点名（`#守-锚点行尾` ③
  //   要的就是这个 —— 断言的对象必须是真正喂给 `replace()` 的那个表达式）。
  // ⚠ 锚点 2026-08-09 再随 #199 更新（这是它们第三次跟着源码走）：
  //   · `g2Resolve` 多收第四个参数 `rp` 并透传 ⇒ 尾行变成 `g2Canon(…, rp)`
  //   · realpath 那一步前面多了零 I/O 前筛 `&& g2TailCouldBeLive(s)`
  //   **旧锚 `return g2Canon(g2ResolvePre(raw, cwd, vars));` 与 `if (/~\d/.test(s)) s = …`
  //   都已不在盘上** ⇒ 上一版这四条会一起退化成「改坏了也不红」。前置断言当场红了 4 条。
  const RE_RESOLVE_TAIL = /  return g2Canon\(g2ResolvePre\(raw, cwd, vars\), rp\);/;
  const RE_LONGPATH_CALL = /if \(\/~\\d\/\.test\(s\) && g2TailCouldBeLive\(s\)\) s = g2LongPath\(s, rp\);/;
  mutate3("⑨①移除·g2Resolve 不再调 g2Canon（绝对路径退回一步归一都没有）",
    RE_RESOLVE_TAIL, "  return g2ResolvePre(raw, cwd, vars);", P9, 2, 0);
  mutate3("⑨②留字面不执行·盘符分支整个不进（代码还在，只是永不执行）",
    /if \(\/\^\[A-Za-z\]:\\\/\/\.test\(s\)\) \{/, "if (false) {", P9, 2, 0);
  mutate3("⑨③结果不被消费·g2Canon 照调（副作用都发生了），但返回值被丢掉",
    /  return g2Canon\(g2ResolvePre\(raw, cwd, vars\), rp\);\r?\n\}/,
    "  g2Canon(g2ResolvePre(raw, cwd, vars), rp);\n  return g2ResolvePre(raw, cwd, vars);\n}", P9, 2, 0);
  // 8.3 那一层单独换靶：证明拦下短名的是 realpath 那一步，不是别的分支顺手拦的
  mutate3("⑨·8.3 单独换靶·realpath 那一步被关掉 ⇒ 短名形态重新漏掉",
    RE_LONGPATH_CALL, "if (false) s = g2LongPath(s, rp);", P9_83, 2, 0);
  // #199 新增：把**前筛**单独换靶（同一行的另一半）。它与上一条不是同一件事 ——
  // 上一条打掉的是「解不解」，这一条打掉的是「要不要试着解」。两半各自都能让 8.3 形态失明，
  // 而前筛这一半是本批**新加**的，没有它这一格就是零样本（`#官抗-负控独立归因`）。
  mutate3("⑨·#199 前筛单独换靶·`g2TailCouldBeLive` 恒假 ⇒ 一次 realpath 都不试 ⇒ 短名形态重新漏掉",
    RE_LONGPATH_CALL, "if (/~\\d/.test(s) && false) s = g2LongPath(s, rp);", P9_83, 2, 0);
  check("上一条改坏后，`..` 回绕仍然被拦（证明只打掉了 8.3 那一层，两层是独立的）", (() => {
    const mp = path.join(TMP, "mutant-112-9-83only.js");
    // 与上一条共用同一个 RegExp 对象 —— 锚一改两处同时改（`#守-锚点行尾` ③）
    fs.writeFileSync(mp, src3.replace(RE_LONGPATH_CALL, () => "if (false) s = g2LongPath(s, rp);"), "utf8");
    return gate(P9, { script: mp }).code === 2;
  })());

  // ── 反向 mutation：把修复**改得过宽**，对应负控必须由 exit 0 翻成 exit 2 ──────────
  // 没有这一组，「一条永远为真的负控」与「一条真管用的负控」在全绿输出里长得一模一样。
  // ⚠ 官抗节点名的第四件事：检查你的 mutation 是不是全在一个方向上 —— 上面 8 条全在
  //   「让闸变松」这一侧，故这里补 3 条「让闸变紧」的，把负控也真的红一遍。
  mutate3("反向⑥·门槛恒为 1 ⇒ 甲⑧（单正参 + 隐式目标）被顺带拦下，而那一格是**判断档**",
    /const needed = \(namedSrcs\.length && !G2_NO_SRC_THRESHOLD\.has\(head\)\) \? 1 : 2;/, "const needed = 1;",
    ps(`Copy-Item ${LIVE_V}`), 0, 2);
  mutate3("反向⑥-b·G2_SRC_PARAM 放宽成「任意具名取值参数都算源」⇒ `-Filter` 也把门槛降到 1，单正参被误伤",
    // 锚点 2026-08-04 更新：`lp` 已从表里删掉（PowerShell 无 `-lp` 这个参数，实跑报错；
    // bash 的 `cp -lp` 是捆绑短选项、不吃取值）——出处见 hook 里该常量上方的注释。
    /const G2_SRC_PARAM = \/\^-\{1,2\}\(path\|literalpath\)\$\/i;/,
    "const G2_SRC_PARAM = /^-{1,2}[\\w-]+$/i;",
    ps(`Copy-Item -Filter *.json ${LIVE_V}`), 0, 2);

  // 反向⑨·g2LongPath 的 fail-open catch 是承重的 —— 8.3 那一格是本批唯一会落 I/O 的判据，
  // 而 I/O 会抛（文件不存在是常态：Write 新建、路径写错、短名指向不存在的用户）。
  // ⚠ 这一条**不能用退出码断言**：真文件与改坏后都是 exit 0（fail-open 的设计就是放行），
  //   两者的差别只在 stderr 有没有那句告警 —— 拿退出码测它会得到一条永远为真的断言。
  {
    // 锚点 2026-08-08 随 #133 更新：realpath 的实现改由调用方给（`g2LongPath(p, rp)`），
    // 第一层因此写成 `realpath(p)` 而不再是 `norm(fs.realpathSync.native(p))`。
    // **注释文本刻意不进锚点**（`[^}]*` 吃掉它）—— 拿一句会被人改的中文当锚点，
    // 下次有人润色注释就把这条 mutation 变成「改坏了也不红」。
    // ⚠ 用 `[^}]*` 而不是 `[^\n]*`：后者写法里有个字面 `\n`，`check-mutation-anchor.mjs`
    //   会（按它自己的窄判据）把它报成「跨行锚点写死 \n」并 exit 1 —— **首版就是这么红的**。
    //   本闸的判据刻意窄，宁可让这种写法一起红，也不去猜「这个 \n 是不是在字符类里」。
    const re = /  try \{ return realpath\(p\); \} catch \(_\) \{[^}]*\}/;
    const n = (src3.match(new RegExp(re.source, "g")) || []).length;
    check("mutation 锚点在源码里恰好命中 1 次（反向⑨·g2LongPath 去掉 catch）", n === 1, `命中 ${n} 次`);
    if (n === 1) {
      const mp = path.join(TMP, "mutant-112-9-nocatch.js");
      fs.writeFileSync(mp, src3.replace(re, () => "  return realpath(p);"), "utf8");
      const nonexistent = edit("C:\\Users\\NOSUCH~9\\.claude\\settings.json");
      const real = gate(nonexistent), mut = gate(nonexistent, { script: mp });
      // 🔴 **判据 2026-08-09（#199）换过，作废原文照录**：
      //   ~~断言 `mut.err` 里有 `ENOENT`（不存在的 8.3 路径 ⇒ realpath 抛 ENOENT ⇒ 没有 catch
      //   就把守卫打进 fail-open）。~~ —— #199 之后 **hook 进程自己一次同步 realpath 都不调**
      //   （缺省实现由 `G2_RP_SYNC` 换成恒抛的 `G2_RP_NONE`，两个真实现都在子进程里）
      //   ⇒ **`ENOENT` 这个字再也不会出现在 hook 自己的错误里**，那半个判据在新盘上恒假。
      //   顺带说明这个 catch 的**性质变了**：它此前接的是「文件不存在」这种偶发事件，
      //   现在**每一次相① 都要经过它**（相① 的 rp 恒抛，那正是「本相不落 I/O」的实现手段）
      //   ⇒ 它从「兜底」变成了**主路径**，删掉它是每次都炸，不再是偶尔炸。
      const sentinel = /相①|未提供 realpath 实现/;
      check("反向⑨·去掉 g2LongPath 的 catch ⇒ 8.3 路径把守卫打进 fail-open（真文件不会）" +
            "；且报错正文是相① 的哨兵而**不再是 ENOENT**（#199 之后 hook 进程零同步 realpath）",
        real.code === 0 && !/守卫自身出错/.test(real.err) &&
        mut.code === 0 && /守卫自身出错/.test(mut.err) && sentinel.test(mut.err) && !/ENOENT/.test(mut.err),
        `real=${real.code}/${/守卫自身出错/.test(real.err)} mut=${mut.code}/${/守卫自身出错/.test(mut.err)}` +
        ` sentinel=${sentinel.test(mut.err)} enoent=${/ENOENT/.test(mut.err)}`);
    }
  }

  // 🔴 **一条阴性结果，照直记（官抗节：差额为零也是结论）**。
  //   **它的被测对象 2026-08-09（#199）已经删除了，整段保留是因为它记的是「为什么删得掉」**：
  //   ~~`if (!g2IsLiveDir(destDir, destPre)) continue;` 这道 guard **试过反向 mutation，翻不动**
  //   （⚠ 2026-08-08 订正调用形态：#134 之后它多收一个「归一前」参数）。
  //   实测（`_tmp/probe-reverse.mjs` B 组，3 条负控全部 0→0）：把它改成 `if (false) continue;`
  //   之后，`-Destination` 指向 `.bak` / `_tmp` / 别的仓，产出的候选是 `<那个目标>/<源basename>`，
  //   **结构上不可能等于 live** —— 因为要等于 live，destDir 就必须**恰好是** live 目录，
  //   而那种情况本来就会被拦。⇒ 它是**精度与开销**的优化（少产一堆永不命中的候选），
  //   **不是承重判据**。~~ —— **这条阴性结果正是 #199 敢删它的依据**：一条改成恒放行都翻不动
  //   任何断言的 guard，删掉它不会丢拦截面。⇒ **阴性结果不是「白测一场」，它是退役凭证**。
  //   🔴 **但那第二个参数曾是承重的，别一起读成「不承重」**（2026-08-08 实测，M2/M3）：
  //   把 `destPre` 不传（或喂空串）⇒ junction + 短名 HOME 那一格由 2 翻 0，各红 1 条。
  //   ⇒ **「这个 guard 本身不承重」与「它的入参不承重」是两句话**，第一句为真不蕴含第二句。
  //   #199 之后这一格由 `g2TwoPhase` 的**相①**承担（它整相都不归一，比「多传一个归一前的串」
  //   更彻底），断言在文件末尾 `#199` 那一节。**顶替 destDir 那道前筛的是 `g2BaseCouldBeLive`
  //   （问源文件名），它是承重的**：上面 ③ 那条 mutation 把它连同 push 一起关掉即由 2 翻 0。

  // ── 调用点覆盖率（官抗节「mutation 报告需附加调用点覆盖率」）─────────────
  {
    const callSites = (name) => (src3.match(new RegExp(`\\b${name}\\s*\\(`, "g")) || []).length - 1; // 减去定义处
    const map = { g2Canon: callSites("g2Canon"), g2LongPath: callSites("g2LongPath"), g2Resolve: callSites("g2Resolve") };
    console.log(`  （调用点覆盖率）#112 新增/改写判据的生产调用点：` +
      Object.entries(map).map(([k, v]) => `${k}=${v}`).join(" ") +
      `；本节端到端覆盖：g2Canon ${map.g2Canon}/${map.g2Canon}（唯一调用点在 g2Resolve，` +
      `而 g2Resolve 的 3 个调用点 —— Edit/Write 分支、g2WriteTargets 的候选解析、` +
      `basename 展开的 destDir —— 上面正控逐个走到了）· g2LongPath 1/1（8.3 正控）。**未覆盖 0 个**；` +
      `但这句话说的是"函数被走到了"，不是"它每个分支都被走到了" —— 后者由登记表反面记录。`);
    check("调用点计数拿得到（拿不到说明函数被改名，上面那句覆盖率即失效）",
      Object.values(map).every((v) => v >= 1), JSON.stringify(map));
  }

  check("真 hook 文件在本节全部 mutation 之后仍逐字节未改", sha(HOOK) === PRISTINE_SHA);
}

console.log("\n──── G2 · 对抗验证官夹击（#117 第二轮 · 合并前置）────");
// ── 这一节是谁写的、为什么又单开一节 ────────────────────────────────────────
// 上面三节依次是 #87 实现官 / #87 对抗官 / #112 实现官。本节是 **#117 的对抗验证官**写的。
// 不合并进上一节，理由同前：语料**从哪来**是近似判据唯一站得住的地方，合并之后
// 「谁挑的这条语料、他有没有动机挑好挑的」就分不开了。
//
// 本节的语料全部来自**对着 #112 那三格的边界现攻**，不是从真语料采的 —— 照直标。
// 分四组：㈠#112 修好了但没断言的形态 ㈡⑩ 的归因判别 ㈢本轮新发现的漏报/误伤（登记，自失效）
// ㈣🔴 本轮查出的**退化**（合并阻断项）。
{
  const ps = (command, cwd) => ({ tool_name: "PowerShell", tool_input: { command }, cwd });
  const LIVEDIR = `${HOME}\\.claude`;
  const LIVE = `${LIVEDIR}\\settings.json`;

  // 本机 HOME 的 8.3 短名。判据与「为什么算而不写死」见模块级 `shortNameOf`
  // （2026-08-08 由本处提到模块级，#134 的 fixture 要复用同一个 realpath 往返判据）。
  const SHORT_HOME = shortNameOf(HOME);
  check("前置：本卷启用了 8.3 短名（关掉的话下面几组只是没测到，不是通过）",
    SHORT_HOME !== null, `SHORT_HOME=${SHORT_HOME}`);

  // ㈠ #112 真的修好了、但那一批没有断言的形态 ────────────────────────────────
  // 头注 g2LongPath ㈢ 写着「文件名本身是短名（`SETTIN~1.JSON`）以外的形态都接得住」，
  // 语气是**没接住文件名短名**。实测反过来：本卷上 settings.json 的真实短名是
  // `SETTIN~1.JSO`（**扩展名截到 3 位**，头注写的 `.JSON` 是四位、根本不存在），
  // 而因为那个文件**存在**，realpath 一步就把整条解开了 ⇒ 文件名短名同样被拦。
  // ⇒ ⑨ 比它自己的文档更强，这一组把「更强」的那部分钉住，免得后人照头注去收窄它。
  const EXTRA_BLOCK = SHORT_HOME ? [
    ["⑨ 补·长目录 + **文件名** 8.3（`SETTIN~1.JSO`，本卷实测的真短名）", edit(`${LIVEDIR}\\SETTIN~1.JSO`)],
    ["⑨ 补·目录与文件名**都是**短名", edit(`${SHORT_HOME}\\.claude\\SETTIN~1.JSO`)],
    ["⑨ 补·settings.local.json 的短名 `SETTIN~2.JSO`", edit(`${LIVEDIR}\\SETTIN~2.JSO`)],
    ["⑨ 补·8.3 短名 + NTFS 备用数据流（realpath 顺带剥掉 `::$DATA`）",
      edit(`${SHORT_HOME}\\.claude\\settings.json::$DATA`)],
  ] : [];
  for (const [name, p] of EXTRA_BLOCK) {
    const r = gate(p);
    check(`正控：${name} → exit 2`, r.code === 2 && /G2-live-settings/.test(r.err), `code=${r.code}`);
  }
  for (const [name, p] of [
    ["⑨ 补·`//./C:/…` 设备命名空间（与 `//?/` 同一格，`[?.]` 两个字符都收）",
      edit("//./C:/Users/Administrator/.claude/settings.json")],
    ["⑨ 补·Git Bash `/c//Users/…`（盘符转换后残留的重复斜杠，win32.resolve 折掉）",
      edit("/c//Users/Administrator/.claude/settings.json")],
    // ⑥ 把 `-lp` 收进源位参数，理由写的是「PowerShell 的 -LiteralPath 缩写」。
    // **那个理由是错的**（见下面 ㈢ 的登记条），但这一格本身**歪打正着有真实召回**：
    // GNU coreutils 的 `cp -l -p` 可以捆绑成 `cp -lp`，而 `-lp` 早就在 G2_VALUE_PARAM 里、
    // 会吃掉后面那个 token ⇒ 改前只剩 1 个正参、撞早退**整条漏过**；⑥ 之后拦得下。
    ["⑥ 补·GNU `cp -lp <源> <live>`（`-l -p` 捆绑，真实存在的 Unix 形态）",
      bash(`cp -lp src.json "${LIVE}"`)],
  ]) {
    const r = gate(p);
    check(`正控：${name} → exit 2`, r.code === 2 && /G2-live-settings/.test(r.err), `code=${r.code}`);
  }
  check("负控：GNU `cp -lp <live> /backup/`（源位是 live，备份是正路）→ exit 0",
    gate(bash(`cp -lp "${LIVE}" /d/backup/`)).code === 0);

  // ㈡ ⑩ 的归因判别 —— 光证「它漏」不够，要证「漏在 tokenizer 层」 ──────────────
  // #112 判定 ⑩ 属 tokenizer 层，依据是「位置目标与具名目标同时中招」。那只排除了
  // 「某一个分支的锅」，**没有排除「basename 展开那段的锅」**。下面这条单引号对照
  // 才是决定性的：单引号里反斜杠**不转义** ⇒ 同一条命令、同一个分支、同一段展开，
  // 仅仅把引号换掉就拦得住 ⇒ 差别只可能在**双引号的转义处理**上，即 g2Tokens。
  const TRAILING_BS = [
    ["⑩ 位置目标 + 尾**反**斜杠（双引号）", ps(`Copy-Item settings.json "$env:USERPROFILE\\.claude\\"`), 0],
    ["⑩ 具名目标 + 尾**反**斜杠（双引号）", ps(`Copy-Item settings.json -Destination "$env:USERPROFILE\\.claude\\"`), 0],
    ["⑩ 具名源 + 具名目标 + 尾**反**斜杠（⑥⑦ 都到齐了仍漏 ⇒ 不在分支层）",
      ps(`Copy-Item -Path settings.json -Destination "$env:USERPROFILE\\.claude\\"`), 0],
    ["⑩ 判别对照·**单引号** + 尾反斜杠 ⇒ 拦得住（∴ 病在双引号转义 = g2Tokens）",
      ps(`Copy-Item settings.json -Destination '$env:USERPROFILE\\.claude\\'`), 2],
    ["⑩ 判别对照·尾**正**斜杠（tokenizer 不受影响）⇒ 拦得住",
      ps(`Copy-Item settings.json -Destination "$env:USERPROFILE/.claude/"`), 2],
  ];
  for (const [name, p, want] of TRAILING_BS) {
    check(`⑩ 归因：${name} → exit ${want}`, gate(p).code === want, `code=${gate(p).code}`);
  }

  // ㈢ 本轮新发现的漏报 / 误伤（登记表，自失效）────────────────────────────────
  // 与上面三节的登记表同一机制：**写的是当前实测值**，哪天有人修好了这条会红并点名，
  // 逼他同批更新 hook 头注的格号清单。**登记 ≠ 认可**，只是让它别再隐形。
  // ⚠ **2026-08-04 实现官回改**：本表里两格已修、两格维持、一格换了值 —— 逐条说明写在各行。
  //   「修好后这条会红并点名」在本 PR 上**真的发生了两次**（阻断项一次、本表一次）。
  const LEDGER_117 = [
    // ✅ 已修：ADS 只剥 `::$DATA` 这一种（本机实测只有它改写原文件，见 g2Canon 上方注释）
    ["✅已修·NTFS 备用数据流 `<live>::$DATA`（实测写它**确实改写原文件** ⇒ 真绕过，" +
     "现于 g2Canon 里按纯字符串剥掉末尾 `::$DATA`）",
      edit(`${LIVE}::$DATA`), 2],
    ["✅已修·ADS 经 shell 重定向", ps(`"x" > "$env:USERPROFILE\\.claude\\settings.json::$DATA"`), 2],
    // 🔴 **大小写两条是第二轮对抗官查出的「`i` 标志无守护」补的**（14 条 mutation 里唯一漏网的一条）：
    //   去掉 `/::\$DATA$/i` 的 `i`，回归网**零红** —— 因为当时只有大写那一条语料。
    //   而本机实测（`_tmp/probe-round2.ps1` A 组）：`::$DATA` / `::$data` / `::$Data`
    //   **三种写法都改写原文件** ⇒ `i` 是必需的，不是顺手加的。现在它有守护了。
    ["✅已补守护·**小写** `::$data`（实测同样改写原文件；这条一加，去掉 `i` 的变异当场红）",
      edit(`${LIVE}::$data`), 2],
    ["✅已补守护·**混写** `::$Data`", edit(`${LIVE}::$Data`), 2],
    // ↓ 负控：另外两种流形态**不碰原文件**（本机实测），剥它们才是误伤 —— 钉住「只剥一种」这个决定
    ["负控·单冒号 `:$DATA` 是**另一条**流，实测不改原文件 ⇒ 不许剥、不许拦",
      edit(`${LIVE}:$DATA`), 0],
    ["负控·具名旁路流 `:mystream` 实测不改原文件 ⇒ 不许剥、不许拦",
      edit(`${LIVE}:mystream`), 0],
    // ❌ 新登记（第二轮对抗官查出，本批**不修**，理由见下方长注释）
    ["❌新登记·**尾点** `settings.json.` —— 本机实测**确实改写原文件**（`probe-round2.ps1` C 组）；" +
     "不修是因为尾点在 POSIX 上是**合法且不同**的文件名，剥它必须按平台分叉",
      edit(`${LIVE}.`), 0],
    ["ⓘ对照·**尾空格** `settings.json ` 当前被拦，但那是 `win32.resolve` **顺带** trim 掉的 —— " +
     "**运气不是设计**，没有任何断言在保证它；这条只是把当前行为记下来",
      edit(`${LIVE} `), 2],
    // ❌ 维持：盘根绝对路径两格，本批**刻意不修**，理由见下方长注释
    ["❌维持·盘根绝对路径（无盘符）`/Users/…` —— Node 在 Windows 上按**当前盘**解析；" +
     "g2Canon 的 posix 分支刻意不补盘符（怕在 POSIX 机器上凭空造盘符）",
      edit("/Users/Administrator/.claude/settings.json"), 0],
    ["❌维持·三斜杠 `///Users/…`（posix 分支要求 `(?!/)` ⇒ 落在两个分支之外）",
      edit("///Users/Administrator/.claude/settings.json"), 0],
    // ⬇ 由 2 变 0：本批把甲⑥ 的门槛下降从 rename 族收回去了，**我扩出来的那一格已还原**
    ["⬇已收窄·`Rename-Item -Path <别处> settings.json` 且 cwd 恰在 `~/.claude`：" +
     "`-NewName` 相对**源目录**解析（实跑确认），本闸按 cwd 解 ⇒ 基准就是错的。" +
     "甲⑥ 曾把这个错基准扩到具名源形态，**本批已收回**（`G2_NO_SRC_THRESHOLD`）⇒ 由 2 变 0",
      ps(`Rename-Item -Path D:\\x\\foo.json settings.json`, LIVEDIR), 0],
    ["❌维持·同上的**全正参**形态：这一格**改前就误伤**、与甲⑥ 无关，基准修好前照旧",
      ps(`Rename-Item D:\\x\\foo.json settings.json`, LIVEDIR), 2],
    // ══ 🔴🔴 【已作废】下面这段是我写的，2026-08-05 第三轮对抗验证官证伪。整段保留，别删 ══
    //   ~~🔴 第二轮对抗官对这个收窄提过反对，本机实测「不复现」，维持不改 —— 详见 hook 里~~
    //   ~~`G2_NO_SRC_THRESHOLD` 上方注释。反对意见是「绝对 `-NewName` 被 PS 接受且真落在那里，~~
    //   ~~一刀切收窄等于连真拦截也退掉了」。**穷举 9 种写法全部被 PS 拒绝**~~
    //   ~~（`_tmp/probe-rename-abs.ps1` + `probe-rename-pos.ps1`，PSVersion 5.1.26100.8875）。~~
    //   ~~下面两条把「这个形态跑不起来」钉住……~~
    // ══ ✅ 真实规则（第三轮对抗官实跑，PSVersion 5.1.26100.8875，`-Force` 有无都一样）══════
    //   **`-NewName` 可以带路径，当且仅当它的目录部分与「源文件所在目录」字面相同。**
    //   我那 9 种写法**全部把目标设在源目录之外** —— 在那个约束内每条都对，**错的只有推广**。
    //   被拒的只有三格：目标目录 ≠ 源目录 · `..` 回绕 · `\\?\` 前缀。
    //   ⇒ 这个排除退掉了 **4 格** PS 真接受、真写 live 的形态（下面新登记那条是其代表）。
    //   ⚠️ **严重性上限（三轮下来没人量过）**：`Rename-Item` 覆盖不了已存在的目标、`-Force`
    //   也不行 ⇒ 只能在 `settings.json` **尚不存在**时把它创建出来。收支与窄修法见 issue #132。
    //
    //   下面这条**期望值 0 是对的、payload 也是对的，错的只有原来那个标签**：
    //   它把一个**条件性**结论（源在别处 ⇒ PS 拒绝）写成了**普遍**结论（绝对 -NewName 跑不起来）。
    //   ⇒ 标签已改写。**这一格钉的是「PS 真会拒绝的那种写法，本闸也不产候选」**。
    ["ⓘ源在别处的绝对 `-NewName`（**PS 5.1 实测确实报 `represents a path or device name`** —— " +
     "因为目标目录 ≠ 源目录，**不是因为「绝对路径」**）：本闸当前不产候选。" +
     "⚠️ 别把这一条读成「绝对 `-NewName` 都跑不起来」——那是本 PR 三轮里作废掉的那句话",
      ps(`Rename-Item -Path D:\\x\\foo.json "${LIVE}"`, LIVEDIR), 0],
    // 🔴 **新登记（第三轮对抗验证官点名：这一格此前一条断言都没有）**：
    //   `Rename-Item -Path <liveDir>\x.json <liveDir>\settings.json` —— **PS 真接受、文件真落在
    //   live 上**（源与目标同目录 ⇒ 满足真实规则），而本闸因为 rename 族被整族排除在门槛下降
    //   之外而**放行**。它是本批唯一「PS 接受 + 真写 live + 本闸放行」且在回归网里**完全隐形**
    //   的形态 —— 而这张登记表连着触发四次的价值，恰恰就是不让这种东西隐形。
    //   **登记值写 0，钉的是「当前放行」这个事实本身**（漏报方向、`HEAD == PRE` ⇒ **非退化**）：
    //   哪天有人做了窄修法（#132），这条会红并点名，逼他回来改这段字和 hook 头注 ⑬。
    //   判别力：下面有一条 mutation 钉着 —— 把 rename 排除去掉，这条由 0 翻 2。
    ["🆕新登记·**同目录**绝对 `-NewName`（PS 真接受、真落 live；本闸当前**放行** ⇒ 真漏报，非退化）",
      ps(`Rename-Item -Path ${LIVEDIR}\\evil.json "${LIVE}"`, LIVEDIR), 0],
    ["🆕新登记·同上 `-LiteralPath` 变体（同族四格之一）",
      ps(`Rename-Item -LiteralPath ${LIVEDIR}\\evil.json "${LIVE}"`, LIVEDIR), 0],
    ["🆕新登记·同上别名 `rni` 变体（同族四格之一）",
      ps(`rni -Path ${LIVEDIR}\\evil.json "${LIVE}"`, LIVEDIR), 0],
    // ⚠ **这一行的期望值我又写错了一次，留档**（同一个毛病：先写期望、后看实测）。
    //   我以为「不复现 ⇒ 本闸不产候选 ⇒ 0」。实测是 **2**：全正参 + 两个正参
    //   ⇒ `needed=2` 本来就满足，走的是**普通末位正参**那条老路，**和 rename 排除毫无关系**
    //   （那个排除只在「有具名源」时才起作用）。⇒ 判决 2 是「老路顺手拦下一条跑不起来的命令」，
    //   不是「本闸认这个形态」。**记下来是因为：同一个错我这一轮犯了两次，都是没先跑就先写。**
    ["ⓘ不复现·同上位置绑定写法（PS 实测被拒）：本闸走普通末位正参老路仍报 2，" +
     "**与 rename 排除无关** —— 那个排除只在有具名源时生效",
      ps(`Rename-Item D:\\x\\foo.json "${LIVE}"`, "D:\\frank"), 2],
    // ⬇ 由 2 变 0：`lp` 已从参数表删掉（PowerShell 无此参数，bash 侧是捆绑短选项）
    // ⚠ **这一行的期望值我第一次写错了，留档**：我以为删掉 `lp` 之后这条会变 0，实测仍是 2。
    //   原因是删掉之后 `-lp` 成了**开关**（不吃取值）⇒ 正参变成两个（`src.json` 与 live）
    //   ⇒ 走**普通的「末位正参即目标位」老路**照样拦下。**判决没变，变的是走哪条路**：
    //   改前靠「`lp` 是具名源」这条**错**规则拦，改后靠正参计数这条**对**规则拦。
    //   ⇒ 教训：`lp` 这一格此前是「**对的结果 + 错的理由**」，而单看红绿分辨不出这两者。
    ["✅理由已订正（判决不变）·PowerShell `Copy-Item -lp`：`-lp` **不是合法参数**（实测 " +
     "`-LiteralPath` 唯一别名是 `PSPath`，实跑报 `A parameter cannot be found`）。" +
     "`lp` 已从参数表删掉 ⇒ 现在它当开关、靠两个正参识别目标位，**不再靠一条编错的具名源规则**",
      ps(`Copy-Item -lp src.json "${LIVE}" -Force`), 2],
    ["✅真实召回·GNU `cp -lp <源> <目标>`（捆绑短选项 `-l`+`-p`，**这个是真跑得起来的**）" +
     "—— `-lp` 现在当开关，两个正参照常识别出目标位",
      bash(`cp -lp src.json "$HOME/.claude/settings.json"`), 2],
    ["负控·`cp -lp <live>` 单正参：那是**源**不是目标（删掉 `lp` 的取值语义后不再被误当目标位）",
      bash(`cp -lp "$HOME/.claude/settings.json"`), 0],
  ];
  for (const [name, p, want] of LEDGER_117) {
    check(`登记表(#117)：${name} → exit ${want}`, gate(p).code === want, `code=${gate(p).code}`);
  }

  // ── 判别力：上面那三条「🆕新登记」的 0 不是一个恒真的 0 ─────────────────────────
  // **一条登记值为 0 的断言天生可疑**：闸对**任何**输入都判 0 时它照样绿，而那正是它该报警的时候。
  // 故这里把 `G2_NO_SRC_THRESHOLD` 那个排除 mutate 掉（改成"谁都不排除"），断言那三条**由 0 翻 2**
  // —— 翻得动，才说明它们量的是「rename 排除」这件事，不是「本闸对什么都没反应」。
  // ⚠ 盘上是 CRLF，锚点走正则并先断言恰好命中 1 次（同本文件其余各处，见 #103）。
  // ⚠ 这一条同时是 issue #132 的自失效钩子：哪天窄修法落地，上面那三条会红并点名。
  {
    const srcR = fs.readFileSync(HOOK, "utf8");
    const RE_EXCL = /const needed = \(namedSrcs\.length && !G2_NO_SRC_THRESHOLD\.has\(head\)\) \? 1 : 2;/;
    const nR = (srcR.match(new RegExp(RE_EXCL.source, "g")) || []).length;
    check("mutation 锚点在源码里恰好命中 1 次（rename 排除）", nR === 1, `命中 ${nR} 次`);
    if (nR === 1) {
      const mp = path.join(TMP, "mutant-117r3-noexcl.js");
      fs.writeFileSync(mp, srcR.replace(RE_EXCL, () => "const needed = namedSrcs.length ? 1 : 2;"), "utf8");
      // 变异体存活：无关命令仍 exit 0 且不走 fail-open（没有它，「全翻」与「靶死了」长得一样）
      const aliveR = gate(ps(`Get-ChildItem D:\\frank`), { script: mp });
      check("变异体存活 canary（rename 排除被去掉后，无关命令仍 exit 0 且无 fail-open 告警）",
        aliveR.code === 0 && !/守卫自身出错/.test(aliveR.err), `code=${aliveR.code}`);
      const FLIP = [
        ["-Path 同目录绝对目标", ps(`Rename-Item -Path ${LIVEDIR}\\evil.json "${LIVE}"`, LIVEDIR)],
        ["-LiteralPath 变体", ps(`Rename-Item -LiteralPath ${LIVEDIR}\\evil.json "${LIVE}"`, LIVEDIR)],
        ["别名 rni 变体", ps(`rni -Path ${LIVEDIR}\\evil.json "${LIVE}"`, LIVEDIR)],
      ];
      for (const [nm, pay] of FLIP) {
        check(`判别力·去掉 rename 排除 ⇒「${nm}」由 0 翻 2（证明那条登记量的是这件事）`,
          gate(pay).code === 0 && gate(pay, { script: mp }).code === 2,
          `real=${gate(pay).code} mut=${gate(pay, { script: mp }).code}`);
      }
      // 负控：项目级 `.claude` 在变异体下**仍然不许拦** —— 去排除只该松 live 那一格，不该松成"见 rename 就拦"
      check("负控·同一变异体下，项目级 `.claude` 的同型 rename 仍 exit 0（没有连带误伤）",
        gate(ps(`Rename-Item -Path D:\\p\\.claude\\evil.json "D:\\p\\.claude\\settings.json"`, "D:\\p\\.claude"),
          { script: mp }).code === 0);
    }
  }

  // 🔴 **盘根绝对路径两格为什么本批不修（实现官判断，说明理由）**：
  //   修它 = 让 `/Users/…` 在 Windows 上按「某个盘」解析。而**按哪个盘**有两个候选：
  //   hook 进程的 `process.cwd()`，还是被拦那条工具调用的 `input.cwd`？两者不同，
  //   且正解是后者 —— 这意味着 `g2Canon` 要多收一个 `cwd` 参数，**它的每一个调用点都要跟着改，
  //   包括我这一批刚刚修好的常量侧 `g2LiveDir()`**。
  //   而本 PR 的阻断项**恰恰就是**「候选侧改了、常量侧没跟上」那个病。
  //   ⇒ 在同一批里对同一条共享归一链再做一次两侧改动，是制造下一次同型退化最省事的办法。
  //   **它是漏报方向（保守侧），已登记、可见、可被下一个人接手**；换成误伤方向我不会这么处置。
  //   `///Users/…` 同族，一并留。
  //
  // 🔴 **尾点 `settings.json.` 为什么也不修（同上，但理由不同）**：本机实测它**确实改写原文件**，
  //   所以它是真绕过。但**尾点在 POSIX 上是合法且不同的文件名**（`a.json.` ≠ `a.json`），
  //   剥它必须按 `process.platform` 分叉 —— 而本闸至今**一条平台分支都没有**，
  //   引入第一条平台分支属设计决定，且它会立刻带出「那 8.3 那层要不要也分叉」等一串问题。
  //   ⚠ 与 ADS 的关键差别：`::$DATA` 在两个平台上**都不是合法文件名**，所以剥它零误伤面；
  //   尾点不是。**同为「后缀别名」，一个能顺手修、一个不能 —— 差别就在误伤面上，不在难度上。**
  //
  // 🔴 **常量侧那个 I/O 站点的残余风险，照直挂账（第二轮对抗官指出）**：
  //   `fs.realpathSync.native` **同步不可中断**，`g2LongPath` 末尾那个 `try/catch`
  //   接得住「抛错」、**接不住「卡住」**（网络盘 / 断连映射盘）；而 live 注册写着 `timeout: 10`
  //   ⇒ 真卡住时**炸的是全部七道闸，不只 G2**。
  //   **本批做了什么**：把常量侧拆成「语法层（零 I/O）/ realpath 层（有 I/O）」两层先比语法层，
  //   外加一道**零 I/O 快筛** —— 而**真正把 I/O 挡在门外的是快筛，不是分层**（见下方 ③）。
  //   🔴 **本段 2026-08-05 订正，作废的原文照录**：
  //     ~~本机与常见部署（长名 HOME）**一次 I/O 都不落**，短名 HOME 下变量形态也不落 ——~~
  //     ~~风险面从「HOME 是短名就每次落」收窄到「HOME 是短名 **且** 候选写字面长名才落」。~~
  //     **后半句两处都是假的**（第三轮对抗验证官用 preload shim 包 `fs.realpathSync.native`
  //     数真实 syscall 量出来的）：①**短名 HOME 下变量形态落 4 次**，是所有形态里最多的；
  //     ②不是「候选写字面长名才落」——`.vscode/settings.json` 既不字面也不 live，照样落 1 次。
  //     ⚠️ **最省事的核法（也是这段字最该留下的部分）**：这句话被**同一个文件里往下约 100 行
  //     一条正在通过的断言**证伪 ——「对照·短名 HOME 下它**确实**会走到 realpath 层」。
  //     **同一份文件里两句话互相打架，而两句都在绿灯下** ⇒ 断言在跑不代表旁边那行字是真的。
  //   ✅ **实测站得住的说法只有一句**：长名 HOME（本机与常见部署）下**一次 I/O 都不落**；
  //     短名 HOME 下只有**尾巴已经长得像 live** 的路径才落（本机 16551 条 Edit 历史里 27 条，
  //     0.16%）。⇒ 风险面「方向对，量级比第二轮说的小」。
  //   ✅ **2026-08-08 修（issue #133），🔴 作废原文照录**：~~本批没做什么：那一格真被触发时
  //     仍可能卡死，且仍接不住。彻底解只有把 I/O 移出同步路径（子进程 / 预热缓存 /
  //     干脆不认这一格），三者都是设计改动 —— 账挂在 issue #133。~~
  //     走的是「子进程」那一条：常量侧那一次 realpath 现在由 `g2RealpathBounded` 带 `timeout` 起
  //     子进程做，失败/超时抛 ⇒ 落回同一个 `try/catch` 的 fail-open。**断言在本文件末尾
  //     「#133/#134」那一节**（含三条防复发：诱饵打不动它 · 失败倒向 fail-open · 界是子进程给的）。
  //     ⚠ **仍别把绿读成「它不会卡」**：那个界以子进程杀得掉为前提，断连映射盘那一格本机造不出、
  //     至今没测；且**候选侧仍然无界**（见 hook 头注 ⑮ ㈠㈡）。
  //   **上面两条 mutation 钉住的是两层各自承重，不是"它不会卡"** —— 别把绿读成那个意思。
  //   🔑 **这段字本身就是一次实证**：PR #145 三轮里有一轮的阻断项正是「hook 改了、**测试文件里
  //     关于它的现在时描述没跟上**」（第四轮才扫到）。本批改完代码回头 Grep 了一遍全仓的
  //     `#133|#134|g2IsLiveDir|g2LongPath|g2LiveDirReal|零 I/O 快筛`，这一段与下方 ㈢ 那条阴性结果
  //     就是那次 Grep 捞回来的两处 —— **不是自觉想起来的**（`#官通-同批查引用` 第四例的形态）。

  // ㈣ ✅ 合并阻断项**已修**（2026-08-04，实现官）：常量侧改惰性 `g2LiveDir()`，走同一归一器 ──
  // **这三条曾是登记表条目（登记值 exit 0），修好后当场变红并逐条点名，逼我回来改它们** ——
  // 那正是自失效登记表被设计出来要干的事，这是它在本 PR 上的第二次真实触发。
  // 现在它们是**正控**：登记值 0 → 断言值 2。
  //
  // 病根（留档，别删）：`G2_LIVE_DIR` 是个**常量**，`norm(path.join(HOME,".claude")).toLowerCase()`；
  // 而 #112 让**候选**侧一律多过一层 `g2Canon`。`path.join` 折得了 `.` / `..` / 重复分隔符 /
  // 尾分隔符，**折不了 8.3 短名、也剥不掉 `//?/`** —— 那两样恰恰是 `g2Canon` 新加的能力
  // ⇒ HOME 本身是这两种形态时两边永远对不上，**整道闸对所有输入一起静默放行**。
  //
  // 🔬 **透镜（比这个 bug 本身值钱）**：**「归一后再比」是两侧对称的动作，只改一侧即半成品**
  //    —— 每一半单独看都对，错的是**不在同一深度**。同窗另一个 bug 同形态（合并脚本 merge 了却不 push）。
  //
  // 🔴🔴 **我上一轮写在这里的「订正」是错的，第二轮对抗验证官是对的。留全过程，别删。**
  //    我当时写：「报文说含 #87 那条绕过原文，而 #87 用的是**字面长名路径**、短名 HOME 下改前就是 0，
  //    所以退化格数是 2 不是 3」。**错在输入**：`#87` 那条绕过原文**根本不是字面长名**，
  //    它是**变量形态** —— 常量就在本文件上方 `BYPASS`（那一行明写「真语料·承重正控」），
  //    展开后是 `$env:USERPROFILE\.claude\settings.json`。我自己换了个 payload 去测，
  //    却拿结果去推翻别人对**原文**的判断。
  //    **用真原文重跑**（`_tmp/repro-round2.mjs`，3 HOME × 6 payload）：
  //      短名 HOME 下真 #87 原文 **PRE112=2 → ROUND1=0** ⇒ **上一轮对抗官那句话完全成立。**
  //      拦下格数 PRE112=11/18 · ROUND1=6/18 · HEAD=18/18，ROUND1 退化 **6** 格。
  //    （对抗官自建 6 payload 报的是 12/6/18、退化 7 格 —— 与我差 1 格，因为 payload 集不同；
  //      **判据不是「几格」而是哪一类**，这一点两边完全一致：
  //      **凡 HOME 走变量 / `~` 展开的形态，改前拦得住、ROUND1 一律放行**；字面路径那一类 0 格退化。）
  //    🔑 **教训（比数字值钱）**：我上一轮用「一个自己挑的 payload」去推翻「别人对某个具名原文的判断」，
  //      而那个原文**就在我正在改的这个文件里、还标着「承重正控」**。
  //      ⇒ **要推翻一条关于「某个具名样本」的结论，必须先把那个样本原样取出来**，不能另造一个近似的。
  //    ⇒ 下面这组把**真 #87 原文**钉成跨 HOME 形态的承重正控 —— 这次归零，正是因为
  //      「换 HOME 形态」这根轴上一个断言都没有。
  if (SHORT_HOME) {
    for (const [hname, hval] of [["8.3 短名", SHORT_HOME], ["`//?/` 扩展前缀", `\\\\?\\${HOME}`]]) {
      const asHome = { USERPROFILE: hval };
      const REG = [
        // ↓ 这一条是**真 #87 原文**（复用上方同一个 BYPASS 常量，不另造近似串）
        ["🔑shell·**真 #87 绕过原文**（变量形态，与上方承重正控同一个 BYPASS 常量）", ps(BYPASS_87)],
        ["shell·变量形态精简版（ROUND1 退化的就是这一类）",
          ps(`Copy-Item src.json "$env:USERPROFILE\\.claude\\settings.json" -Force`)],
        ["bash·`~` 展开形态（同属变量/展开类）", bash("cp src.json ~/.claude/settings.json")],
        ["bash·`$HOME` 形态（同属变量/展开类）", bash('cp src.json "$HOME/.claude/settings.json"')],
        ["Edit·字面长名路径（**改前就漏**，本批顺带修掉，走 realpath 层）", edit(`${HOME}\\.claude\\settings.json`)],
        ["shell·字面长名路径（同上，走 realpath 层）", ps(`Copy-Item src.json "${HOME}\\.claude\\settings.json" -Force`)],
      ];
      for (const [name, p] of REG) {
        check(`阻断项已修·USERPROFILE=${hname} 时仍拦得住：${name} → exit 2`,
          gate(p, { env: asHome }).code === 2, `code=${gate(p, { env: asHome }).code}`);
      }
    }
    check("对照：真实 HOME（长名）下**真 #87 原文**照旧拦得住 ⇒ 修复没把老路弄坏",
      gate(ps(BYPASS_87)).code === 2);

    // mutation：常量侧现在是**两层**（语法层零 I/O / realpath 层有 I/O），
    // **每层各来一条** —— 只测一层会漏掉另一层塌陷。两条都必须带 env，否则在本机长名 HOME 下
    // 恒不翻转，而「恒不翻转」与「判据没塌陷」在全绿输出里长得一模一样（本 bug 就是这么藏住的）。
    //
    // 🔑 **两层各自是什么角色 —— 我第一版把它写反了，实测纠过来的，留档**：
    //   我原写「变量形态走语法层、字面长名走 realpath 层」。**错**。真实分工是：
    //     · **realpath 层承重**：短名 HOME 下，候选（任何形态）都被 `g2Canon` 归成**长名**，
    //       而语法层常量是**短名** ⇒ 语法层一律不中，**全靠 realpath 层**。
    //     · **语法层不承重、是纯优化**：把它关掉，**没有任何判决改变**（下面有断言钉住）。
    //       它的价值只有一个 —— 长名 HOME 下先命中就不必算第二层。
    //     · **真正把 I/O 挡在门外的是「零 I/O 快筛」**（`/.claude` 尾巴 / 文件名尾巴），
    //       不是分层。**因为语法层只在「命中」时短路，而绝大多数输入是不命中的。**
    //   出处：`_tmp/probe-layers.mjs`（把 realpath 层函数体换成 throw，看谁还拦得住）。
    {
      const src4 = fs.readFileSync(HOOK, "utf8");
      const asShort = { USERPROFILE: SHORT_HOME };
      const payVar = ps(BYPASS_87);
      const payLit = edit(`${HOME}\\.claude\\settings.json`);

      // 🔴 **2026-08-09（#199）：上面那段「两层各自是什么角色」有一半过期了，作废原文照录**：
      //   ~~realpath 层承重：短名 HOME 下，候选（**任何形态**）都被 `g2Canon` 归成长名，
      //   而语法层常量是短名 ⇒ 语法层一律不中，全靠 realpath 层。~~
      //   —— #199 之后判定跑**两相**，而**相①（归一前）压根不 realpath** ⇒ 短名 HOME 下
      //   「候选也写成短名」的那一类（变量 / `~` 展开 / `$HOME`，即真语料的主流形态）
      //   **在相① 就与短名常量字面相等、当场命中语法层**，一次 I/O 都不落。
      //   ⇒ **realpath 层仍然承重，但承重的样本换了**：只剩「候选写**字面长名** + HOME 是短名」
      //   这一类（两侧长短名形态不一致，只有归一得上）。下面 ① 因此把两个样本分开断言 ——
      //   **一个仍翻、一个不再翻，而「不再翻」本身是本批的产出，不是回归**。
      const L2 = /  return low === g2LiveDirReal\(\);/;
      const n2 = (src4.match(new RegExp(L2.source, "g")) || []).length;
      check("mutation 锚点恰好命中 1 次（常量侧·realpath 层）", n2 === 1, `命中 ${n2} 次`);
      if (n2 === 1) {
        const mp = path.join(TMP, "mutant-117-real.js");
        fs.writeFileSync(mp, src4.replace(L2, () => "  return false;"), "utf8");
        check("常量侧·realpath 层被打掉 ⇒ 短名 HOME 下「字面长名」由 2 翻 0（这一层仍承重）",
          gate(payLit, { env: asShort }).code === 2 && gate(payLit, { script: mp, env: asShort }).code === 0,
          `real=${gate(payLit, { env: asShort }).code} mut=${gate(payLit, { script: mp, env: asShort }).code}`);
        check("🟢#199 产出·同一变异体下「真 #87 原文（变量形态）」**不再翻**（2→2）" +
              "⇒ 那一格已由相① 的零 I/O 字面相等接住，不再依赖 realpath 层",
          gate(payVar, { env: asShort }).code === 2 && gate(payVar, { script: mp, env: asShort }).code === 2,
          `real=${gate(payVar, { env: asShort }).code} mut=${gate(payVar, { script: mp, env: asShort }).code}`);
        check("同一变异体在**长名 HOME** 下全部照拦 ⇒ 这个 bug 是环境条件性的，不是恒失效",
          gate(payVar, { script: mp }).code === 2 && gate(payLit, { script: mp }).code === 2);
      }

      // ② realpath 层换成 throw：**用来证明「零 I/O」这个性质**，不是证明判决。
      //    长名 HOME 下若仍拦得住 ⇒ 说明压根没走到那一层 ⇒ 那次 hook 调用一次 I/O 都没落。
      // ⚠ 锚点 2026-08-09 随 #199 更新（第二次跟着源码走）：常量侧不再把 `g2RealpathBounded`
      //   直接当 `g2Canon` 的第二参 —— 它现在**先做零 I/O 归一（传恒抛的 `G2_RP_NONE`）、
      //   再无条件过一次有界 realpath**。锚点改钉那条零 I/O 归一行（单行，行尾差异咬不到它）。
      //   **旧锚 `_g2LiveDirCache.real = g2Canon(…, g2RealpathBounded).toLowerCase();` 已不在盘上。**
      const RE_REAL_BODY = /    const syn = g2Canon\(norm\(path\.join\(HOME, "\.claude"\)\), G2_RP_NONE\);/;
      const n3 = (src4.match(new RegExp(RE_REAL_BODY.source, "g")) || []).length;
      check("mutation 锚点恰好命中 1 次（realpath 层函数体）", n3 === 1, `命中 ${n3} 次`);
      if (n3 === 1) {
        const mp = path.join(TMP, "mutant-117-l2throw.js");
        fs.writeFileSync(mp, src4.replace(RE_REAL_BODY, () => '    throw new Error("L2_WAS_CALLED");'), "utf8");
        for (const [nm, pay] of [["真 #87 原文", payVar], ["字面长名", payLit],
                                 ["`~` 展开", bash("cp src.json ~/.claude/settings.json")]]) {
          const r = gate(pay, { script: mp });   // 长名 HOME（本机默认）
          check(`零 I/O 性质·长名 HOME 下「${nm}」拦得住且 realpath 层从未被调用`,
            r.code === 2 && !/L2_WAS_CALLED/.test(r.err), `code=${r.code} 被调用=${/L2_WAS_CALLED/.test(r.err)}`);
        }
        const rs = gate(payLit, { script: mp, env: asShort });
        check("对照·短名 HOME + **字面长名候选**时它**确实**会走到 realpath 层 ⇒ 上面那组不是恒真",
          rs.code === 0 && /L2_WAS_CALLED/.test(rs.err), `code=${rs.code}`);

        // ③ 🔴 **#199 的代价，实测钉住（`#官通-禁笃定措辞`：别只写买到的那半）**：
        //    常量侧改成**无条件**过一次有界 realpath 之后，「长名 HOME 一次 I/O 都不落」
        //    **只对语法层命中的那些输入成立**。语法层没命中、而文件名又像 live 的路径
        //    （项目级 `.claude/settings.json`、`.vscode/settings.json` …）现在会落 1-2 次
        //    有界子进程。**这一格此前是零 I/O，是本批花掉的成本**，换来 ⑯ 相邻格与 ⑰ 两格真拦截。
        const projCfg = path.join(TMP, "io-cost-proj", ".claude", "settings.json");
        const rProj = gate(edit(projCfg), { script: mp });
        check("🔴#199 代价·长名 HOME 下写**项目级** `.claude/settings.json` 现在**会**走到 realpath 层" +
              "（此前零 I/O）—— 买到的是 ⑯ 相邻格 / ⑰ 两格真拦截",
          /L2_WAS_CALLED/.test(rProj.err), `被调用=${/L2_WAS_CALLED/.test(rProj.err)} code=${rProj.code}`);
        check("#199 代价·同一路径在真文件下仍 exit 0（走到 realpath 层 ≠ 被拦；误伤面没变）",
          gate(edit(projCfg)).code === 0, `code=${gate(edit(projCfg)).code}`);
        const rHome = gate(bash("cp src.json ~/.claude/settings.json"), { script: mp });
        check("#199 代价的边界·同一变异体下 `~/.claude/settings.json` 仍在语法层命中、从不走 realpath 层" +
              "⇒ 那笔成本只落在「语法层没命中」的那些输入上，不是全面退化",
          rHome.code === 2 && !/L2_WAS_CALLED/.test(rHome.err), `code=${rHome.code}`);
      }

      // ④ 语法层：**刻意断言它「不承重」** —— 关掉它一个判决都不变。
      //    这是阴性结果，写下来是为了防止后来人以为它是一道防线（官抗节：差额为零也是结论）。
      const L1 = /  if \(low === g2LiveDirSyntactic\(\)\) return true;/;
      const n1 = (src4.match(new RegExp(L1.source, "g")) || []).length;
      check("mutation 锚点恰好命中 1 次（常量侧·语法层）", n1 === 1, `命中 ${n1} 次`);
      if (n1 === 1) {
        const mp = path.join(TMP, "mutant-117-syn.js");
        fs.writeFileSync(mp, src4.replace(L1, () => "  if (false) return true;"), "utf8");
        const same = [payVar, payLit].every((p) =>
          gate(p, { script: mp }).code === gate(p).code &&
          gate(p, { script: mp, env: asShort }).code === gate(p, { env: asShort }).code);
        check("语法层被关掉 ⇒ **判决一个都不变**（它是纯优化不是防线，阴性结果照直钉住）", same);
      }
    }
  }

  check("真 hook 文件在本节之后仍逐字节未改", sha(HOOK) === PRISTINE_SHA);
}

console.log("\n──── G2 · #133 常量侧有界 realpath + #134 junction 快筛 + #199 候选侧有界化 · 两相判定 ────");
// ── 这一节测什么，以及为什么承重的不是「它现在拦得住」那几条 ────────────────────
// 两张单子落在同一段代码上：
//   **#133** 常量侧那次 `fs.realpathSync.native` 同步不可中断（实测打不可路由 UNC 阻塞
//        **21044 ms**，PR #145 第一轮对抗官）。卡住时被宿主杀掉的是**整个 hook 进程**，
//        而宿主对 `command` 型 hook 的失效态是 fail-open（PR #155 查官方文档三处交叉印证）
//        ⇒ **七道闸一起放行**。改法 = 那一次 realpath 走带 `timeout` 的**子进程**，
//        失败/超时一律抛 ⇒ 落回 `g2LongPath` 既有的「按原样比」。
//   **#134** 零 I/O 快筛作用在**归一后**的候选上，而归一（realpath）会改写末段 ⇒
//        `.claude` 是 junction 且 HOME 是 8.3 短名时 `endsWith("/.claude")` 为假、
//        **连比都不比**，丢一格真拦截。改法 = 快筛同时看「归一前 / 归一后」两个深度。
//   **#199（2026-08-09 加进本节）** 候选侧那格 realpath 仍无界，而它的触发次数**由 payload 控**
//        ⇒ 必须正面回答「N 个诱饵 × timeout 每个」。改法两刀：**零 I/O 前筛**
//        （`g2TailCouldBeLive`，末段不可能是 live 的连试都不试）+ **每进程至多一个批量子进程**
//        （`g2RealpathBatch`）⇒ 答案是 **N × 0 + 1 × timeout**。同批把判定改成**两相**
//        （相①=归一前 · 相②=归一后，任一命中即拦），从深度上消掉「用归一后的值做归一前假设」
//        那个连着换了四种长相的病；`g2IsLiveDir` / `g2DirTailLooksLive` 与缺省的 `G2_RP_SYNC`
//        一并删除。**本节因此多了三组断言**：放大攻击（N=20/200 实测）· 两相各自的专属样本 +
//        mutation · ⑱⑲ 两条新登记（诱饵抢先 / 形态交叉，都带自失效断言）。
//
// 🔴 **本节承重的是三条防复发断言**（PR #145 三轮不可合，**每一轮的修复都引入了下一轮的
//    阻断项**，而阻断项的形态全部是「预算耗尽后怎么办」）：
//    ㈠ **诱饵打不动它**：200 个带 `~N` 的写目标 + 真目标，短名 HOME 下仍 exit 2，
//       且子进程**仍然只起 1 次**。第二、三轮那两条绕过都以「攻击者能把某个共享预算耗尽」
//       为前件，这条钉的是**那个前件不存在**（这一版没有预算、没有 sticky、没有跨调用状态）。
//    ㈡ **失败方向是 fail-open，不是 fail-closed**。第三轮在本机真实环境实测过反方向的代价：
//       **一次** `ENAMETOOLONG` 就把合法的**项目级** `.claude/settings.json` 从 0 翻 2，
//       而 G2 的逃生阀只有用户设得了 ⇒ 撞上即会话卡死。
//    ㈢ **那个界是子进程给的，不是别的东西顺手给的**（`#官通-对照组自验`）：对照组把同样长的
//       阻塞注在**进程内**，寿命当场炸掉 ⇒ 上面那条「界成立」不是恒真。
//       第一轮那个 worker 方案栽的就是这一格：主线程的界成立（斜率 0.996），**进程寿命一点没变**。
//
// ⚠️ **语料来源照直标**（`#官抗-语料非自证`）：junction 的**机制**是真的 —— `mklink /J`，
//    与 cc-switch 在本机分发用的同一种；本机 `~/.claude` 下实测确有 12+ 条真链（`agents/*.md`
//    `commands/*.md` 指回仓内）。但「**`HOME/.claude` 自己是个链、且链目标 basename 不叫
//    `.claude`**」这个拓扑在本机**不存在**，故 fixture 的**拓扑是造的**，只有机制与 8.3 短名
//    （realpath 往返问文件系统要的）是真的。**别把这一节读成「真语料回归」。**
{
  const ps = (command, cwd) => ({ tool_name: "PowerShell", tool_input: { command } , cwd });
  const SRC = fs.readFileSync(HOOK, "utf8");
  const SHORT_HOME = shortNameOf(HOME);
  const SBX = path.join(TMP, "io-guard");
  fs.mkdirSync(SBX, { recursive: true });

  // ── 🔴 **相② 专属 fixture（#214 新增）：候选路径里有链，只有真 realpath 解得开** ────
  // **为什么本批必须新造一个**：#199 那时的「相② 专属样本」是「候选写 8.3 短名 + 长名 HOME」，
  // 而 #214 的相③（8.3 投机展开）**恰恰就把那一格接住了** ⇒ 拿它去做「候选侧 realpath 坏掉
  // ⇒ 由 2 翻 0」的反向 mutation，会得到一条**恒真断言**（翻不动，因为相③ 兜住了）。
  // ⇒ 承重样本换成「链」这一类：候选写 `<短名>\altlink\settings.json`，`altlink` 是指向
  // `<home>\.claude` 的 junction。**相③ 对它无能为力**（段数比 live 多一段，且 `altlink`
  // 与 `.claude` 不是 8.3 前缀关系）⇒ 它是「候选侧那次 realpath 到底还挣不挣得到饭吃」
  // 的唯一活证据，也是 ⑳ 那条新登记的载体。
  // **自失效**：junction 造不出来 / 链解不到 live / 短名算不出来 ⇒ 前置断言当场红，
  // 而不是悄悄退化成「测了个普通目录」（那正是 #134 那份 fixture 立下的规矩）。
  // ⚠️ **语料来源照直标**（`#官抗-语料非自证`）：`mklink /J` 的**机制**是真的（cc-switch 在本机
  //   分发用的同一种，`~/.claude` 下实测有 12+ 条真链），但「HOME 底下有个 junction 指向
  //   `.claude`」这个**拓扑是造的** —— 本机不存在。别把这一组读成真语料回归。
  const CL_HOME = path.join(SBX, "candlink-home");
  const CL_LIVE = path.join(CL_HOME, ".claude");
  const CL_LINK = path.join(CL_HOME, "altlink");
  fs.mkdirSync(CL_LIVE, { recursive: true });
  const clMk = spawnSync("cmd", ["/c", "mklink", "/J", CL_LINK, CL_LIVE],
    { encoding: "utf8", windowsHide: true });
  const CL_SHORT = shortNameOf(CL_HOME);
  const clReal = (() => { try { return fs.realpathSync.native(CL_LINK); } catch (_) { return ""; } })();
  check("#214 前置·候选侧链 fixture 造得出来（`mklink /J altlink → <home>\\.claude`）",
    clMk.status === 0, clMk.status === 0 ? "ok" : `mklink exit=${clMk.status}（⇒ 下面那组只是没测到，不是通过）`);
  check("#214 前置·它真解得到 live 目录（否则下面测的不是「只有 realpath 解得开」那一格）",
    /[\\/]\.claude$/i.test(clReal), `realpath=${clReal}`);
  check("#214 前置·该假 HOME 算得出真 8.3 短名（候选里得有 `~N`，`g2Canon` 才会落 realpath）",
    !!CL_SHORT, `short=${CL_SHORT}`);
  const clOk = clMk.status === 0 && /[\\/]\.claude$/i.test(clReal) && !!CL_SHORT;
  // 候选：短名段（给 `g2Canon` 一个 `~N` 让它落 realpath）+ junction 段（相③ 展不开）
  const payLink = clOk ? ps(`Copy-Item src.json "${CL_SHORT}\\altlink\\settings.json" -Force`) : null;
  const clEnv = { USERPROFILE: CL_HOME };
  if (clOk) {
    check("🟢#214 正控·**相② 专属**（候选经 junction，只有真 realpath 解得开）→ exit 2",
      gate(payLink, { env: clEnv }).code === 2, `code=${gate(payLink, { env: clEnv }).code}`);
    const bogus = ps(`Copy-Item src.json "${CL_SHORT}\\altlink2\\settings.json" -Force`);
    check("#214 负控·同一 fixture 里写一个**不存在的**兄弟目录 → exit 0（不许误伤）",
      gate(bogus, { env: clEnv }).code === 0, `code=${gate(bogus, { env: clEnv }).code}`);
  }

  // ── #133 ──────────────────────────────────────────────────────────────────
  // 锚点：三处，各自单行、且**断言的就是喂给 `replace()` 的那个 RegExp 对象**
  // （`#守-锚点行尾` ③：断言前缀串而 mutation 用正则 = 两个不同的锚）。
  const RE_RP_CHILD = /const G2_RP_CHILD = "process\.stdout\.write\(require\('fs'\)\.realpathSync\.native\(process\.argv\[1\]\)\)";/;
  const RE_SPAWN = /  const r = childProcess\.spawnSync\(process\.execPath, \["-e", G2_RP_CHILD, p\], \{/;
  // ⚠ 锚点 2026-08-09 随 #199 更新：常量侧不再把 `g2RealpathBounded` 当 `g2Canon` 的第二参，
  //   改成先零 I/O 归一、再**无条件**过一次有界 realpath（那次调用包在一个数成功次数的闭包里）。
  //   **旧锚 `_g2LiveDirCache.real = g2Canon(…, g2RealpathBounded).toLowerCase();` 已不在盘上。**
  const RE_BOUNDED_ARG = /      const v = g2RealpathBounded\(p\);/;
  for (const [nm, re] of [["G2_RP_CHILD 子进程正文", RE_RP_CHILD], ["spawnSync 调用", RE_SPAWN],
                          ["常量侧调有界实现", RE_BOUNDED_ARG]]) {
    const n = (SRC.match(new RegExp(re.source, "g")) || []).length;
    check(`#133 锚点恰好命中 1 次（${nm}）`, n === 1, `命中 ${n} 次`);
  }
  // 结构断言：**全仓只有常量侧那一个地方调有界单路径实现**。
  // 🔴 **必须先剥注释再数，这一格是被自己咬出来的**：首版直接在全文上数，得到 **9 次** ——
  //   多出来的 7 处全是头注里**在讨论它**的散文。那正是 PR #145 第二轮对抗官踩过的同一个
  //   自指坑（他把正则换成 `ZZZ_NEVER_MATCHES` 之后「它匹配到了自己那行正则字面量」），
  //   也正是 `#守-输出面外` 说的「答得出我的报告写在哪、那个位置在不在我扫的范围里」。
  const CODE = SRC.split(/\r?\n/).filter((l) => !/^\s*\/\//.test(l)).join("\n");
  const refs = (name) => (CODE.match(new RegExp(`\\b${name}\\b`, "g")) || []).length;
  // 🔴 **这条断言的语义 2026-08-09（#199）换了，作废原文照录**：
  //   ~~`g2RealpathBounded` 在代码里只出现 2 次（1 定义 + 1 常量侧引用），**候选侧零引用** ——
  //   多出第二处就说明有人把子进程接到了候选侧上，而候选侧的触发次数由 payload 控。~~
  //   —— #199 **就是**把子进程接到候选侧的那一批，所以「候选侧零引用」不再是要守的性质。
  //   守的换成：**候选侧不许复用单路径实现**（那会把「N × timeout」原样请回来），
  //   它只准走**批量**那一个（`g2RealpathBatch`，每进程 ≤1 次）。计数不变仍是 2，
  //   但**为什么是 2** 换了：1 定义 + 1 常量侧调用点，候选侧一次都不许引用它。
  check("#133/#199 结构·`g2RealpathBounded`（**单路径**有界实现）在代码里只出现 2 次" +
        "（1 定义 + 1 常量侧调用），**候选侧零引用** ⇒ 候选侧只能走批量那条",
    refs("g2RealpathBounded") === 2, `代码里 ${refs("g2RealpathBounded")} 次 / 含注释 ${(SRC.match(/\bg2RealpathBounded\b/g) || []).length} 次`);
  // 🔴 **#199 新增结构断言①：hook 进程自己一次同步 realpath 都不调。**
  //   缺省实现由 `G2_RP_SYNC`（进程内同步）换成恒抛的 `G2_RP_NONE` 之后，`realpathSync`
  //   在**剥掉注释的代码**里只该出现在两个子进程正文的**字符串字面量**里。
  //   多出第三处 = 有人把无界同步 realpath 放回了 hook 进程 —— 那正是 ⑮ 那格病的原样复发。
  const rpLines = CODE.split(/\r?\n/).filter((l) => /realpathSync/.test(l));
  check("🔴#199 结构·`realpathSync` 在代码里只出现在**两个子进程正文字面量**那两行" +
        "（∴ hook 进程自己零同步 realpath；缺省实现是恒抛的 `G2_RP_NONE`）",
    rpLines.length === 2 && rpLines.every((l) => /^const G2_RP_(BATCH_)?CHILD = "/.test(l.trim())),
    `${rpLines.length} 行：${rpLines.map((l) => l.trim().slice(0, 46)).join(" | ")}`);
  check("🔴#199 结构·缺省 realpath 实现是恒抛的 `G2_RP_NONE`，且 `G2_RP_SYNC` 已不在代码里",
    /const realpath = rp \|\| G2_RP_NONE;/.test(CODE) && !/\bG2_RP_SYNC\b/.test(CODE),
    `none=${/G2_RP_NONE;/.test(CODE)} sync残留=${/\bG2_RP_SYNC\b/.test(CODE)}`);
  // 🔴 **#199 新增结构断言②：孙进程结构上不存在**（PR #197 对抗官第 1 笔：`timeout` 杀进程
  //   不杀进程树 —— 实测 D 组孙进程 PID 存活）。两个子进程正文都是**写死的字面量**，
  //   只 `require('fs')`；只要它们不 spawn，就没有进程树可杀。**这是结构论证不是实测**，
  //   照直写：它证的是「造不出孙进程」，不是「有孙进程时杀得掉」。
  {
    const bodies = CODE.split(/\r?\n/).filter((l) => /^const G2_RP_(BATCH_)?CHILD = "/.test(l.trim()));
    const bad = bodies.filter((l) => /child_process|\bspawn|\bexec[A-Z(]|\bexec\(/.test(l));
    check("🔴#199 结构·两个子进程正文里零 `spawn` / `exec` / `child_process` ⇒ **结构上没有孙进程可杀**" +
          "（对抗官第 1 笔；这是结构论证，不是「有孙进程也杀得掉」的实测）",
      bodies.length === 2 && bad.length === 0, `正文 ${bodies.length} 行，命中危险 token ${bad.length} 行`);
    check("🔴#199 结构·候选侧路径走 **stdin** 而不进代码串（`input:` 存在且正文不做字符串拼接）" +
          "⇒ payload 造不出可执行内容，也不会撞 Windows 命令行长度上限那条**静默**失败",
      /input: list\.join\("\\n"\) \+ "\\n",/.test(CODE) &&
      /\["-e", G2_RP_BATCH_CHILD\]/.test(CODE), "见 g2RealpathBatch");
  }
  // 这两条是**文本断言**，射程照直写：挡得住「有人把它删掉」，挡不住「值给错了」。
  // 它们各自都是 PR #145 第二轮点名过的「好天气里无症状的删法」（删了没有任何东西会响）。
  check("#133 子进程带 `windowsHide`（少了它每次触发闪一个控制台窗；文本断言，删得掉给错值测不出）",
    /windowsHide: true,/.test(SRC));
  check("#133 子进程清掉 `NODE_OPTIONS`（免得父进程的 preload —— 含量它的探针自己 —— 改变被测对象）",
    /NODE_OPTIONS: ""/.test(SRC));

  if (SHORT_HOME) {
    const asShort = { USERPROFILE: SHORT_HOME };
    const payVar = ps(BYPASS_87);
    const payLit = ps(`Copy-Item src.json "${HOME}\\.claude\\settings.json" -Force`);
    const harmless = bash("echo hi");
    // 200 个带 `~N` 的诱饵写目标 + 末尾一个真目标。**诱饵刻意不叫 settings.json、
    // 父目录也不是 `.claude`** —— 那才是第三轮用来「先把预算打死再打常量侧」的形态。
    const DECOY = Array.from({ length: 200 }, (_, i) => `Copy-Item a.md "${SHORT_HOME}\\zz${i}\\f.md"`)
      .join("; ") + `; Copy-Item src.json "${SHORT_HOME}\\.claude\\settings.json" -Force`;
    // 🔴 **#199 的诱饵要比上面那条更狠**：上面那 200 条末段是 `f.md`，**过不了零 I/O 前筛**
    //   ⇒ 它量的是「前筛管用」，量不到「批量管用」。真正打候选侧那个乘法的诱饵必须
    //   **末段就叫 `settings.json`**（前筛必须放行它，因为目录是不是 live 只有比过才知道）。
    //   ⇒ 下面这条 N 条诱饵**每一条都会进 `wanted`**，而子进程仍该只起 1 个。
    const liveTailDecoy = (n, home) => Array.from({ length: n },
      (_, i) => `Copy-Item a.md "${home}\\zz${i}~1\\settings.json"`).join("; ") +
      `; Copy-Item src.json "${home}\\.claude\\settings.json" -Force`;

    // ① 正控：短名 HOME 下照旧拦得住（常量侧此刻走的是有界子进程那条路）
    for (const [nm, pay] of [["真 #87 原文（变量形态）", payVar], ["字面长名", payLit]]) {
      check(`#133 正控·短名 HOME 下「${nm}」仍 exit 2（换成有界子进程没把射程弄丢）`,
        gate(pay, { env: asShort }).code === 2, `code=${gate(pay, { env: asShort }).code}`);
    }

    // ② 子进程真的起了几次 —— 让子进程往标记文件里 append，**不能用 stderr 数**
    //    （`stdio` 把子进程的 stderr `ignore` 掉了；第一版探针就是这么骗到自己的：
    //     标记没出现，我差点写下「压根没起子进程」这个反向结论）。
    {
      const MARK = path.join(SBX, "spawns.log").replace(/\\/g, "/");
      const mp = path.join(TMP, "mutant-133-count.js");
      // 🔴 **#199 起两个子进程都要数**：常量侧那个记 `c`、候选侧批量那个记 `b`。
      //   只数一个会得到一条**看起来还在通过**的旧断言 —— 那正是本批最该防的那种假绿。
      //   批量那条锚点只钉**前缀**（`replace` 只换匹配到的那一段，行尾与正文一字不动），
      //   故它天然是单行锚点、行尾差异咬不到它（`#守-锚点行尾` ①）。
      const RE_BATCH_CHILD_HEAD = /const G2_RP_BATCH_CHILD = "const fs=require\('fs'\);/;
      const nb = (SRC.match(new RegExp(RE_BATCH_CHILD_HEAD.source, "g")) || []).length;
      check("#199 锚点恰好命中 1 次（批量子进程正文前缀）", nb === 1, `命中 ${nb} 次`);
      fs.writeFileSync(mp, SRC
        .replace(RE_RP_CHILD, () =>
          `const G2_RP_CHILD = "require('fs').appendFileSync('${MARK}','c');` +
          `process.stdout.write(require('fs').realpathSync.native(process.argv[1]))";`)
        .replace(RE_BATCH_CHILD_HEAD, () =>
          `const G2_RP_BATCH_CHILD = "const fs=require('fs');fs.appendFileSync('${MARK}','b');`), "utf8");
      const alive = gate(harmless, { script: mp });
      check("#133 变异体存活（计数版）：无关输入仍 exit 0 且无 fail-open 告警",
        alive.code === 0 && !/守卫自身出错/.test(alive.err), `code=${alive.code}`);
      const spawns = (pay, env) => {
        fs.rmSync(MARK, { force: true });
        const t0 = Date.now();
        const r = gate(pay, { script: mp, env });
        let s = ""; try { s = fs.readFileSync(MARK, "utf8"); } catch (_) { s = ""; }
        return { code: r.code, c: (s.match(/c/g) || []).length, b: (s.match(/b/g) || []).length,
                 n: s.length, ms: Date.now() - t0 };
      };
      // 🔴 **这一条是 #199 的产出，不是回归**：短名 HOME + 变量形态（真语料主流）
      //   现在由**相①（归一前）**的字面相等当场命中 ⇒ **两个子进程一个都不起**。
      //   作废原文照录：~~`#133 计数·短名 HOME + 尾巴像 live ⇒ 恰好 1 个子进程，且照拦`~~
      //   （那时只有一相、候选侧一律先归一，于是必然落一次常量侧 realpath）。
      const rShortVar = spawns(payVar, asShort);
      check("🟢#199 计数·短名 HOME + **变量形态**（真语料主流）⇒ **零子进程**且照拦" +
            "（相① 不归一 ⇒ 候选与常量都是短名、字面相等）",
        rShortVar.code === 2 && rShortVar.n === 0, `code=${rShortVar.code} c=${rShortVar.c} b=${rShortVar.b}`);
      const rShortLit = spawns(payLit, asShort);
      check("#133 计数·短名 HOME + **字面长名**候选 ⇒ 常量侧恰好 1 个子进程、候选侧 0，且照拦" +
            "（两侧长短名形态不一致，只有常量侧归一得上）",
        rShortLit.code === 2 && rShortLit.c === 1 && rShortLit.b === 0,
        `code=${rShortLit.code} c=${rShortLit.c} b=${rShortLit.b}`);
      const rLong = spawns(payVar, {});
      check("#133 计数·**长名 HOME 零子进程**（常见部署下这条主流形态一次 I/O 都不落）",
        rLong.code === 2 && rLong.n === 0, `code=${rLong.code} c=${rLong.c} b=${rLong.b}`);
      // 🔴 **这一条整个换掉了，作废原文照录**：
      //   ~~`#133 计数·**候选侧**含 `~N` 的路径仍走进程内同步（零子进程）⇒ 子进程只接在常量侧`~~
      //   —— #199 **就是**给候选侧接子进程的那一批，那句话在本批为假。现在量的是
      //   **候选侧那个子进程恰好 1 个**（批量），常量侧另算。
      const rCand = spawns(ps(`Copy-Item src.json "${SHORT_HOME}\\.claude\\settings.json" -Force`), {});
      check("🔴#199 计数·长名 HOME + 候选写 8.3 短名 ⇒ 常量侧 1 个 + **候选侧批量 1 个**，且照拦" +
            "（相① 比不上 ⇒ 相② 才起那一个批量子进程）",
        rCand.code === 2 && rCand.c === 1 && rCand.b === 1,
        `code=${rCand.code} c=${rCand.c} b=${rCand.b}`);
      // 🔴 ㈠ 防复发：第二、三轮那两条绕过的前件
      const rDecoy = spawns(ps(DECOY), asShort);
      check("🔴#133 防复发㈠·200 个 `~N` 诱饵（末段 `f.md`）+ 真目标 ⇒ **仍 exit 2 且总子进程 0 个**" +
            "（末段不像 live ⇒ 零 I/O 前筛全部挡掉，真目标由相① 命中）",
        rDecoy.code === 2 && rDecoy.n === 0, `code=${rDecoy.code} c=${rDecoy.c} b=${rDecoy.b}`);

      // ── 🔴🔴 **放大攻击实测（issue #199 的正题：N 个诱饵 × timeout 每个）** ────────────
      // 上面那条诱饵**过不了前筛**，所以它量的是第一刀。这一组的诱饵**每一条都过前筛**
      // （末段就叫 `settings.json`，前筛没有理由挡它 —— 目录是不是 live 只有比过才知道），
      // 于是它们**全部进 `wanted`**，正面打第二刀：**N 变大，子进程数变不变。**
      // 判据：`b` 恒为 1（与 N 无关）⇒ 「N × timeout」的答案是 **N × 0 + 1 × timeout**。
      for (const N of [20, 200]) {
        const r = spawns(ps(liveTailDecoy(N, SHORT_HOME)), {});
        check(`🔴#199 放大攻击·${N} 个**过得了前筛**的诱饵 + 真目标 ⇒ 候选侧批量子进程仍 **恰好 1 个**` +
              `（常量侧 ${r.c} 个另算），且真目标照拦 exit 2`,
          r.code === 2 && r.b === 1 && r.c <= 2, `code=${r.code} c=${r.c} b=${r.b} ${r.ms}ms`);
      }
      {
        // 同一组的**时间**面：N=200 时 hook 进程寿命仍在健康量级（远低于宿主 10 s）。
        // ⚠ 阈值给 6000 与本节别处同口径（`#官通-性能哨兵` ③：两侧都留余量、不贴实测值卡）。
        const r = spawns(ps(liveTailDecoy(200, SHORT_HOME)), {});
        check(`🔴#199 放大攻击·200 诱饵下 hook 进程寿命 < 6 s（实测 ${r.ms} ms）` +
              "⇒ 那个乘法被批量拆成了加法，宿主 10 s 预算烧不掉",
          r.ms < 6000, `${r.ms} ms`);
      }
      // 🔴 **前筛是不是真的在挡 I/O —— 反向 mutation（`#官抗-判别力自检`：两个方向都要验）**。
      //   ⚠️ **第一版这条断言写错了，留档（`#官抗-变异体存活` 的近亲：这次是「靶选错了」）**：
      //     我原先量的是「批量子进程**个数** 0→1」，实测 **0→0，翻不动**。原因不是前筛没用，
      //     而是那条 payload 的**真目标被相① 提前拦下、`return v1` 走人 ⇒ 批量压根没起过**
      //     —— 两侧都是 0，量的是「有没有走到相②」，不是「前筛挡没挡住 I/O」。
      //   ⇒ 改成量**进了 `wanted` 的路径条数**（让批量子进程每处理一条就记一个 `p`），
      //     并把 payload 换成「真目标只有相② 拦得住」的那一种（长名 HOME + 候选写 8.3 短名）。
      //     判据：**同一批诱饵，前筛开着时进 I/O 的路径数是个位数，关掉是三位数。**
      {
        const RE_PREFILT = /if \(\/~\\d\/\.test\(s\) && g2TailCouldBeLive\(s\)\) s = g2LongPath\(s, rp\);/;
        const RE_BATCH_LOOP = /for\(var i=0;i<a\.length;i\+\+\)\{if\(!a\[i\]\)continue;/;
        const np = (SRC.match(new RegExp(RE_PREFILT.source, "g")) || []).length;
        const nl = (SRC.match(new RegExp(RE_BATCH_LOOP.source, "g")) || []).length;
        check("#199 锚点恰好命中 1 次（零 I/O 前筛那一行）", np === 1, `命中 ${np} 次`);
        check("#199 锚点恰好命中 1 次（批量逐条循环·计路径版）", nl === 1, `命中 ${nl} 次`);
        if (np === 1 && nb === 1 && nl === 1) {
          // 计路径版：批量子进程每处理一条输入就往标记文件记一个 `p`；起进程本身记一个 `b`。
          const instrument = (src) => src
            .replace(RE_BATCH_CHILD_HEAD, () =>
              `const G2_RP_BATCH_CHILD = "const fs=require('fs');fs.appendFileSync('${MARK}','b');`)
            .replace(RE_BATCH_LOOP, () =>
              `for(var i=0;i<a.length;i++){if(!a[i])continue;fs.appendFileSync('${MARK}','p');`);
          const mpKeep = path.join(TMP, "mutant-199-filter-on.js");
          const mpOpen = path.join(TMP, "mutant-199-filter-off.js");
          fs.writeFileSync(mpKeep, instrument(SRC), "utf8");
          fs.writeFileSync(mpOpen, instrument(
            SRC.replace(RE_PREFILT, () => "if (/~\\d/.test(s) && true) s = g2LongPath(s, rp);")), "utf8");
          const paths = (script, pay, env) => {
            fs.rmSync(MARK, { force: true });
            const r = gate(pay, { script, env });
            let s = ""; try { s = fs.readFileSync(MARK, "utf8"); } catch (_) { s = ""; }
            return { code: r.code, b: (s.match(/b/g) || []).length, p: (s.match(/p/g) || []).length };
          };
          check("#199 变异体存活（计路径·前筛开）：无关输入仍 exit 0",
            paths(mpKeep, harmless, {}).code === 0);
          check("#199 变异体存活（计路径·前筛关）：无关输入仍 exit 0",
            paths(mpOpen, harmless, {}).code === 0);
          // payload：200 条 `f.md` 诱饵（末段不像 live）+ 一个**只有相② 拦得住**的真目标。
          const DECOY_LONG = Array.from({ length: 200 },
            (_, i) => `Copy-Item a.md "${SHORT_HOME}\\zz${i}\\f.md"`).join("; ") +
            `; Copy-Item src.json "${SHORT_HOME}\\.claude\\settings.json" -Force`;
          const on = paths(mpKeep, ps(DECOY_LONG), {});
          const off = paths(mpOpen, ps(DECOY_LONG), {});
          check("🔴#199 判别力·前筛恒真 ⇒ 同一批诱饵进 I/O 的**路径条数**由个位数暴涨到三位数" +
                `（实测 ${on.p} → ${off.p}）∴ \`g2TailCouldBeLive\` 确实是本闸唯一的 I/O 闸门`,
            on.p > 0 && on.p < 10 && off.p > 100, `on p=${on.p} b=${on.b} / off p=${off.p} b=${off.b}`);
          check("🔴#199 判别力的另一半·**路径条数暴涨而子进程数不变（两侧都恰好 1 个）**" +
                "⇒ 这正是「N 与子进程数脱钩」那句话的机器面证据",
            on.b === 1 && off.b === 1, `on b=${on.b} off b=${off.b}`);
          check("#199 阴性结果·前筛恒真下**判决不变**（真目标两侧都 exit 2）" +
                "⇒ 前筛是 I/O 挡板不是正确性边界（`#官抗-判别力自检`：差额为零也是结论）",
            on.code === 2 && off.code === 2, `on=${on.code} off=${off.code}`);
        }
      }
    }

    // ③ 卡住：把子进程正文换成睡 20 秒（远超界，也远超宿主注册的 10 s）
    //    两件事一起验：**判决倒向 fail-open** + **进程寿命被界住**。
    {
      const mp = path.join(TMP, "mutant-133-hang.js");
      fs.writeFileSync(mp, SRC.replace(RE_RP_CHILD, () =>
        'const G2_RP_CHILD = "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20000)";'), "utf8");
      const alive = gate(harmless, { script: mp });
      check("#133 变异体存活（卡死版）：无关输入仍 exit 0 且无 fail-open 告警",
        alive.code === 0 && !/守卫自身出错/.test(alive.err), `code=${alive.code}`);
      // ⚠ 样本 2026-08-09 换了：`payVar`（变量形态）在 #199 之后由相① 零 I/O 命中，
      //   **压根不走常量侧 realpath** ⇒ 拿它测「常量侧卡住会怎样」会得到一条恒真断言。
      //   承重样本换成 `payLit`（字面长名 + 短名 HOME，只有常量侧归一得上那一格）。
      const t0 = Date.now();
      const r = gate(payLit, { env: asShort, script: mp });
      const ms = Date.now() - t0;
      // 🔴 ㈡ 失败方向
      check("🔴#133 防复发㈡·常量侧 realpath 卡住 ⇒ **fail-open（exit 0）而不是 fail-closed**" +
            "（第三轮实测过反方向：一次失败就把合法的项目级 `.claude/settings.json` 从 0 翻 2）",
        r.code === 0, `code=${r.code}`);
      check("#133 卡住时那行自陈打得出来（fail-open 不许静默 —— 放行与「跑了且没事」退出码一样）",
        /常量侧 realpath 没验成/.test(r.err), r.err.slice(0, 160));
      check("🟢#199 同一变异体下**变量形态**仍 exit 2（相① 不依赖常量侧那次 realpath）" +
            "⇒ 常量侧卡死的射程比 #133 那时更小了",
        gate(payVar, { env: asShort, script: mp }).code === 2);
      // 性能哨兵（`#官通-性能哨兵`）：**两侧都留余量**，且不锚死绝对耗时。
      //   通过侧余量：界 2×800 ms + node 冷启 ≈ 1.7 s，阈值给到 6000（≈3.5×）。
      //   失败侧余量：注入的阻塞是 20 s，改造前实测真卡是 21 s ⇒ 无界时必然 >6000（≈3.3×）。
      //   刻意用「注入 20 s / 阈值 6 s」这种数量级差，而不是贴着实测值卡阈值。
      check(`🔴#133 界·注入 20 s 阻塞，hook 进程寿命仍 < 6 s（实测 ${ms} ms）` +
            "⇒ 宿主那 10 s 预算不会因为这一次 I/O 被烧掉",
        ms < 6000, `${ms} ms`);
      check("#133 对照·同一变异体在**长名 HOME** 下照拦且不受影响（∴ 上面那组不是恒真）",
        gate(payVar, { script: mp }).code === 2);
    }

    // ③-b 🔴 **候选侧那个批量子进程卡住会怎样（#199 新增，与 ③ 同构）**：
    //     把批量子进程正文整个换成睡 20 s ⇒ 整批解不开 ⇒ 落回相① 的结果（按原样比）。
    //     **失败方向必须仍是 fail-open**（`#官抗-dryrun变异` 那一路的同族：声明了「失败即降级」
    //     就要有一条断言真的把它逼到那条降级路径上）。
    {
      const RE_BATCH_HEAD2 = /const G2_RP_BATCH_CHILD = "const fs=require\('fs'\);/;
      const n = (SRC.match(new RegExp(RE_BATCH_HEAD2.source, "g")) || []).length;
      check("#199 锚点恰好命中 1 次（批量子进程正文前缀·卡死版）", n === 1, `命中 ${n} 次`);
      if (n === 1) {
        const mp = path.join(TMP, "mutant-199-batch-hang.js");
        // 前缀换成一段**永不返回**的正文；`"` 收尾后原行剩下的部分成了不可达代码的一部分，
        // 但那不要紧 —— 子进程在第一句就停住了。**刻意不动整行**：整行锚点跨不了行、
        // 但它长达数百字符，写进测试里会与源码逐字耦合（改一个分号就恒不命中）。
        fs.writeFileSync(mp, SRC.replace(RE_BATCH_HEAD2, () =>
          'const G2_RP_BATCH_CHILD = "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20000);const fs=require(\'fs\');'), "utf8");
        const alive = gate(harmless, { script: mp });
        check("#199 变异体存活（批量卡死版）：无关输入仍 exit 0 且无 fail-open 告警",
          alive.code === 0 && !/守卫自身出错/.test(alive.err), `code=${alive.code}`);
        // 🔴 **承重样本 2026-08-09（#214）换掉了，作废原文照录**：
        //   ~~`const payCand = ps(\`Copy-Item src.json "${"${SHORT_HOME}"}\\.claude\\settings.json" -Force\`);`~~
        //   —— 那条（候选写 8.3 短名 + 长名 HOME）在 #214 之后由**相③** 兜住 ⇒ 批量卡死它照拦
        //   ⇒ 拿它测「批量坏掉会怎样」会得到一条**恒真断言**。承重样本换成候选侧链那一格
        //   （相③ 展不开），它才是「批量坏掉真的会丢一格覆盖面」的活证据。
        const t0 = Date.now();
        const r = clOk ? gate(payLink, { env: clEnv, script: mp }) : { code: -1 };
        const ms = Date.now() - t0;
        check("🔴#199/#214 防复发·候选侧批量子进程卡住 ⇒ 相② 独有那一格**fail-open（exit 0）**" +
              "（禁 fail-closed —— 单条候选解不开换来的误伤在这道闸上代价更大；" +
              "**只有「候选数 > 阈值 + 有候选压根没轮到」那一格才 fail-close**，见 #214 那组）",
          r.code === 0, `code=${r.code}`);
        check(`🔴#199 界·批量子进程注入 20 s 阻塞，hook 进程寿命仍 < 6 s（实测 ${ms} ms）`,
          ms < 6000, `${ms} ms`);
        check("#199 对照·同一变异体下**相① 拦得住的那些**判决不变（短名 HOME + 变量形态仍 exit 2）" +
              "⇒ 批量卡死只吃掉相② 独有的那一格，不是整闸失明",
          gate(payVar, { env: asShort, script: mp }).code === 2);
        check("🟢#214 对照·同一变异体下**相③ 拦得住的那些**判决不变（候选写 8.3 短名 + 长名 HOME 仍 exit 2）" +
              "⇒ 批量整个坏掉时，短名那一大类由零 I/O 的相③ 接住（这正是 ⑱ 回归带的修法）",
          gate(ps(`Copy-Item src.json "${SHORT_HOME}\\.claude\\settings.json" -Force`), { script: mp }).code === 2,
          `code=${gate(ps(`Copy-Item src.json "${SHORT_HOME}\\.claude\\settings.json" -Force`), { script: mp }).code}`);
      }
    }

    // ③-c 🔴🔴 **⑱「诱饵抢先」那条登记 2026-08-09 兑现了（#214），它是自失效断言第 7 次真实触发。**
    //     🔴 **作废原文照录**：
    //     ~~`check("🔴#199 诚实边界·**批内第一条卡住 ⇒ 同批后面的真目标解不开、退回相① 结果
    //     （exit 0）**…… 方向是漏报且严格优于改动前……**账挂在 issue #214**", r.code === 0)`~~
    //     —— **「严格优于改动前」那句已被 PR #216 对抗官实测证伪**（约 292 KB ~ 2.4 MB 那一段
    //     改动前拦得住、#199 那一版漏），随后 #214 把它修了；这条登记于是当场变红并点名，
    //     逼我回来把它改成正控。**登记条目记得下「哪天有人修会红」，记不下「会怎么修」** ——
    //     它当时猜的两条修法（排序 / 每条一个子进程）**一条都没被采用**，实际修法是
    //     **相③：8.3 短名的零 I/O 投机展开 + 饿死 fail-close**（见 hook 里 `g2ShortExpand`
    //     与 `G2_CAND_STARVE_N` 上方）。
    //     构造不变：把批量子进程正文改成「解第一条之前先睡 20 s」= 第一条就卡 ⇒ 全批解不开
    //     （最强形态，比真实攻击更狠）。**现在要断言的是它照样拦得住。**
    {
      const RE_LOOP = /for\(var i=0;i<a\.length;i\+\+\)\{if\(!a\[i\]\)continue;/;
      const n = (SRC.match(new RegExp(RE_LOOP.source, "g")) || []).length;
      check("#199 锚点恰好命中 1 次（批量子进程的逐条循环）", n === 1, `命中 ${n} 次`);
      if (n === 1) {
        const mp = path.join(TMP, "mutant-199-headline.js");
        fs.writeFileSync(mp, SRC.replace(RE_LOOP, () =>
          "for(var i=0;i<a.length;i++){if(!a[i])continue;if(i===0){Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20000)}"), "utf8");
        const payCand = ps(`Copy-Item src.json "${SHORT_HOME}\\.claude\\settings.json" -Force`);
        const r = gate(payCand, { script: mp });
        check("🟢#214 正控（原 ⑱ 登记条目）·**批内第一条卡住、整批解不开 ⇒ 真目标仍 exit 2**" +
              "（相③ 零 I/O 投机展开接住了 8.3 短名那一大类 —— 这就是 ⑱ 回归带的闭合面）",
          r.code === 2, `code=${r.code}`);
        check("#214 归因·同一变异体下**那行「候选侧批量没跑完」自陈打得出来**" +
              "（∴ 上一条不是「批量其实没坏」，是坏了而相③ 顶上了）",
          /候选侧批量 realpath 没跑完/.test(r.err), r.err.slice(0, 160));
        // 🔴 **⑳ 新登记（自失效）：相③ 展不开的那一类，「毒路径抢先」仍然漏。**
        //   相③ 靠的是 8.3 短名的生成规则，**候选路径里若是链（而不是短名）就反推不出来**
        //   ⇒ 批内第一条卡住时，`altlink` 那一格照旧退回「按原样比」。
        //   **它不是相对改动前的退化**：改动前那条 payload 会让主进程一卡到底、宿主 10 s 到点
        //   杀掉整个 hook ⇒ 七道闸一起放行，比丢 G2 一格严重一个量级（本机实测见 PR body 那张表）。
        //   **也不是数量型**：数量型那一格由「饿死 fail-close」堵着（见下面 #214 那组）；
        //   这一格要的是**一条真毒路径**（本机造不出，故此处用注入卡死模拟）。
        //   哪天有人修好这条会红并点名，逼他同批更新 hook 头注 ⑳ 与本条。
        if (clOk) {
          const rl = gate(payLink, { env: clEnv, script: mp }).code;
          check("登记（自失效）·⑳ 相③ 展不开的那一类（候选经**链**而非短名）+ 批内第一条卡住 ⇒ 仍 **exit 0**。" +
                "**非退化**（改动前同一条 payload 会卡死整个 hook ⇒ 七闸齐放）。**账挂在 issue #214**",
            rl === 0, `code=${rl}`);
        }
      }
    }

    // ④ 🔴 ㈢ 对照组自验：把同样长的阻塞注在**进程内**（界够不着的地方）⇒ 寿命炸掉。
    //    没有这一条，「寿命 < 6 s」这句话可能只是因为阻塞压根没生效（第一轮那个 worker
    //    方案的红集就是这么被误读成「界成立」的：主线程的界成立，进程寿命一点没变）。
    {
      const mp = path.join(TMP, "mutant-133-unbounded.js");
      fs.writeFileSync(mp, SRC.replace(RE_SPAWN, () =>
        "  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 6000);\n" +
        '  const r = childProcess.spawnSync(process.execPath, ["-e", G2_RP_CHILD, p], {'), "utf8");
      // ⚠ 样本同 ③ 换成 `payLit`：`payVar` 在 #199 之后走不到 `g2RealpathBounded`，
      //   拿它测「注在那里的阻塞」会量到 30-40 ms —— 那不是「界成立」，是**阻塞压根没被执行**，
      //   而这一条的全部意义正是防这种误读（第一轮 worker 方案就栽在同型误读上）。
      const t0 = Date.now();
      const r = gate(payLit, { env: asShort, script: mp });
      const ms = Date.now() - t0;
      check(`🔴#133 防复发㈢·把 6 s 阻塞注在**进程内** ⇒ 寿命 ≥ 6 s（实测 ${ms} ms）` +
            "⇒ 上一条那个界确实是子进程给的，不是别的东西顺手给的",
        ms >= 6000, `${ms} ms`);
      check("#133 对照·进程内阻塞版判决仍是 2（证明这一条量的是寿命不是判决）", r.code === 2, `code=${r.code}`);
    }

    // ⑤ 反向 mutation：把界收到 1 ms ⇒ 健康调用也超时 ⇒ 短名 HOME 下退回未归一比对（fail-open）。
    //    它钉的是「这个界真的在被用」——`G2_CONST_REALPATH_MS` 被改大改小都得有断言响。
    {
      const RE_MS = /const G2_CONST_REALPATH_MS = 800;/;
      const n = (SRC.match(new RegExp(RE_MS.source, "g")) || []).length;
      check("#133 锚点恰好命中 1 次（界常量）", n === 1, `命中 ${n} 次`);
      if (n === 1) {
        const mp = path.join(TMP, "mutant-133-1ms.js");
        fs.writeFileSync(mp, SRC.replace(RE_MS, () => "const G2_CONST_REALPATH_MS = 1;"), "utf8");
        // ⚠ 样本同 ③④ 换成 `payLit`（理由见 ③ 那段）。
        const r = gate(payLit, { env: asShort, script: mp });
        check("#133 反向·界收到 1 ms ⇒ 短名 HOME + 字面长名候选由 2 翻 0 并打出那行自陈（∴ 这个常量真的在被用）",
          gate(payLit, { env: asShort }).code === 2 && r.code === 0 && /常量侧 realpath 没验成/.test(r.err),
          `mut=${r.code}`);
        check("#133 反向·同一变异体在长名 HOME 下判决不变（界只影响会落 I/O 的那一格）",
          gate(payVar, { script: mp }).code === 2);
      }
      // ⑤-b 🔴 **候选侧那个界也要有反向 mutation**（`#官通-调参三问` 的机器面：改大改小都得有响）：
      //      `G2_CAND_REALPATH_MS` 收到 1 ms ⇒ 批量必超时 ⇒ 相② 独有的那一格由 2 翻 0。
      //      没有它，那个常量就是一个「改了也没人吭声」的数字。
      {
        const RE_MS2 = /const G2_CAND_REALPATH_MS = 800;/;
        const n2 = (SRC.match(new RegExp(RE_MS2.source, "g")) || []).length;
        check("#199 锚点恰好命中 1 次（候选侧界常量）", n2 === 1, `命中 ${n2} 次`);
        if (n2 === 1) {
          const mp2 = path.join(TMP, "mutant-199-1ms.js");
          fs.writeFileSync(mp2, SRC.replace(RE_MS2, () => "const G2_CAND_REALPATH_MS = 1;"), "utf8");
          const payCand = ps(`Copy-Item src.json "${SHORT_HOME}\\.claude\\settings.json" -Force`);
          // 🔴 **承重样本 2026-08-09（#214）换掉了，作废原文照录**：
          //   ~~`gate(payCand).code === 2 && gate(payCand, { script: mp2 }).code === 0`~~
          //   —— `payCand`（候选写 8.3 短名 + 长名 HOME）在 #214 之后由相③ 兜住，界收到 1 ms
          //   它照样 exit 2 ⇒ 那条断言变成恒真，**它就不再证明「这个常量在被用」了**。
          //   换两条：①判决面用相③ 展不开的那一格（候选经链）②另加一条**行为面**——
          //   界收紧必然打出那行「候选侧批量没跑完」自陈，那是这个常量真的在被读的直接证据。
          if (clOk) {
            check("🔴#214 反向·候选侧界收到 1 ms ⇒ **相② 独有那一格**（候选经链）由 2 翻 0" +
                  "（∴ `G2_CAND_REALPATH_MS` 真的在被用，且单条解不开时失败方向仍是 fail-open）",
              gate(payLink, { env: clEnv }).code === 2 && gate(payLink, { env: clEnv, script: mp2 }).code === 0,
              `real=${gate(payLink, { env: clEnv }).code} mut=${gate(payLink, { env: clEnv, script: mp2 }).code}`);
          }
          check("🔴#214 反向·界收到 1 ms ⇒ 那行「候选侧批量 realpath 没跑完」自陈打得出来" +
                "（降级不许静默；这一条与判决无关，量的就是这个常量被读到了）",
            /候选侧批量 realpath 没跑完/.test(gate(payCand, { script: mp2 }).err),
            gate(payCand, { script: mp2 }).err.slice(0, 160));
          check("🟢#214 反向的另一半·界收到 1 ms 时**短名那一大类判决不变**（`payCand` 仍 exit 2）" +
                "⇒ 相③ 不吃候选侧那个界，⑱ 回归带的闭合与它无关",
            gate(payCand, { script: mp2 }).code === 2, `code=${gate(payCand, { script: mp2 }).code}`);
          check("#199 反向·同一变异体下相① 拦得住的那些判决不变（短名 HOME + 变量形态仍 2）",
            gate(payVar, { env: asShort, script: mp2 }).code === 2);
          check("#199 反向·两个界是**两个常量**，收窄候选侧不影响常量侧那一格" +
                "（短名 HOME + 字面长名仍 exit 2 ⇒ 合成一个常量就分不开该调哪一个）",
            gate(payLit, { env: asShort, script: mp2 }).code === 2,
            `code=${gate(payLit, { env: asShort, script: mp2 }).code}`);
        }
      }
    }
  } else {
    check("前置：本卷启用了 8.3 短名（关掉的话 #133 这一组只是**没测到**，不是通过）", false, "SHORT_HOME=null");
  }

  // ── #134：junction fixture ────────────────────────────────────────────────
  // fixture 必须**自失效**：造不出来时前置断言当场红。#134 单子上点名要防的正是
  // 「一条在别人机器上悄悄退化成『测了个普通目录』的断言，比没有断言更糟」。
  {
    const mkFakeHome = (leaf, cfgKind) => {
      const home = path.join(SBX, leaf);
      const link = path.join(home, ".claude");
      if (cfgKind === "junction") {
        const target = path.join(home, "actualcfg");
        fs.mkdirSync(target, { recursive: true });
        const r = spawnSync("cmd", ["/c", "mklink", "/J", link, target], { encoding: "utf8", windowsHide: true });
        if (r.status !== 0) return null;
      } else {
        fs.mkdirSync(link, { recursive: true });
      }
      return { home, link, short: shortNameOf(home) };
    };
    // leaf 前六字符刻意相同 ⇒ 两个假 HOME 的短名必然是 `~1`/`~2`，正好把 `shortNameOf`
    // 只试 `~1` 那个旧毛病钉住（它是本批改这个 helper 的理由）。
    const J = mkFakeHome("homedir-junction-x", "junction");
    const P = mkFakeHome("homedir-plaindir-y", "plain");

    const jOk = !!(J && J.short);
    check("#134 前置·真 junction 造得出来（`mklink /J`，与 cc-switch 分发用的同一机制）",
      !!J, J ? "ok" : "mklink 失败 ⇒ 下面那组只是没测到，不是通过");
    if (J) {
      const lst = fs.lstatSync(J.link);
      const rp = (() => { try { return fs.realpathSync.native(J.link); } catch (_) { return ""; } })();
      // 🔴 **这两条就是「自失效」本身**：fixture 一旦退化成普通目录，或者链目标碰巧也叫
      //    `.claude`，#134 那个形态就不成立了 —— 而那时下面的断言会「通过」并骗过所有人。
      check("#134 前置·它真是个链，不是普通目录（退化成普通目录 ⇒ 下面测的就不是 #134 那个形态）",
        lst.isSymbolicLink(), `isSymbolicLink=${lst.isSymbolicLink()}`);
      check("#134 前置·链目标的末段**不叫** `.claude`（`…/actualcfg`）—— 这一格正是快筛的盲点",
        /[\\/]actualcfg$/i.test(rp), `realpath=${rp}`);
      check("#134 前置·假 HOME 算得出真 8.3 短名（realpath 往返，不是猜 8.3 算法）",
        !!J.short, `short=${J.short}`);
    }
    check("#134 前置·对照用的「真实目录 .claude」假 HOME 也就位", !!(P && P.short), P ? `short=${P.short}` : "缺");

    if (jOk && P && P.short) {
      // payload 与 #134 单子里那条实测 payload 同形（`Copy-Item -LiteralPath … -Destination <home>\.claude`）
      const dest = (home) => `Copy-Item -LiteralPath settings.json -Destination "${home}\\.claude"`;
      // 2×2：junction×{长名,短名} HOME × {junction, 真实目录}。**四格里只有一格是本单要修的。**
      const CELLS = [
        ["junction 的 .claude + **短名** HOME  ← #134 就是这一格", J.short, dest(J.short), 2],
        ["junction 的 .claude + 长名 HOME", J.home, dest(J.home), 2],
        ["真实目录 .claude   + **短名** HOME", P.short, dest(P.short), 2],
        ["真实目录 .claude   + 长名 HOME", P.home, dest(P.home), 2],
      ];
      for (const [nm, home, cmd, want] of CELLS) {
        const c = gate(ps(cmd), { env: { USERPROFILE: home } }).code;
        check(`#134 正控·${nm} → exit ${want}`, c === want, `code=${c}`);
      }

      // 🔴 **#134 那条 mutation 2026-08-09 随 #199 退役，作废原文照录**：
      //   ~~把快筛退回「只看归一后的末段」（= 改前那一版）⇒ 只有那一格由 2 翻 0。
      //   `const RE_QF = /  if \(!g2DirTailLooksLive\(low\) && !g2DirTailLooksLive\(norm\(pre\)\.toLowerCase\(\)\)\) return false;/;`~~
      //   —— **被它 mutate 的那个函数（`g2IsLiveDir` / `g2DirTailLooksLive`）本批已删除**
      //   （删除理由与阴性结果凭证见 hook 里 `g2BaseCouldBeLive` 上方 + 上一节那段划线注释）。
      //   **它没有静默**：`锚点恰好命中 1 次` 那条前置断言当场红并点名 —— 这正是自失效锚点
      //   要干的事。⇒ 顶替它的是下面 `#199 两相` 那一组：#134 这四格现在由**相①（零 I/O
      //   字面相等）与常量侧那次无条件 realpath** 一起守着，判别力断言在那一组里。
      // ⚠️ **别再往这里补一条「新快筛」的 mutation**：`g2TailCouldBeLive` 是 **I/O 挡板**
      //   不是正确性边界（它的判别力断言在 #133 那一节的「前筛恒真 ⇒ 子进程 0 翻 1」），
      //   在这里再钉一条只会得到一条恒真断言。

      // 负控（`#官实-误伤反例`）：快筛放宽只该让更多路径**走到精确比对**，不该让更多路径被拦。
      // ⚠️ **负控的语料来源，照直标（`#官抗-语料非自证` 2026-08-07 补的那半）**：下面三条里
      //   **只有第一条有真实形态背书**——项目级 `<proj>/.claude/settings.json` 是工具链日常在写的
      //   （`update-config` 那条路），而且它正是 PR #145 第三轮 fail-closed **真误伤过的**那一格。
      //   另两条（`.claude-backup` / `actualcfg`）**是本轮自造的诱饵** ⇒ 它们只证明「**我的诱饵**
      //   不会被误伤」，证不了「真实的合法形态不中招」。原 PR body 只给**正控**标了来源，
      //   负控这一半是被字面漏掉的（由 PR #197 对抗官 M-d 捞出）。
      const PROJ = path.join(SBX, "someproject", ".claude");
      fs.mkdirSync(PROJ, { recursive: true });
      for (const [nm, home, cmd] of [
        ["项目级 `.claude` 目标位（`update-config` 那条路日常在写它）", J.short,
          `Copy-Item -LiteralPath settings.json -Destination "${PROJ}"`],
        ["名字像但不是 live 的目录（`.claude-backup`）", J.short,
          `Copy-Item -LiteralPath settings.json -Destination "${path.join(SBX, ".claude-backup")}"`],
        ["junction **自己的目标**目录（`…/actualcfg`，末段两个深度都不像 live）", J.home,
          `Copy-Item -LiteralPath a.md -Destination "${path.join(J.home, "actualcfg")}"`],
      ]) {
        const c = gate(ps(cmd), { env: { USERPROFILE: home } }).code;
        check(`#134 负控·${nm} → exit 0（不许误伤）`, c === 0, `code=${c}`);
      }
      // ⚠️ **上面第三条负控的拦截深度 2026-08-09 变了，照直写**：`-Destination …/actualcfg`
      //   这一条此前是被 `g2IsLiveDir` 那道目标目录快筛挡下的；#199 删掉那道筛之后，
      //   挡它的换成了 `g2BaseCouldBeLive(源的 basename)` —— 源叫 `a.md`，**连候选都不合成**。
      //   ⇒ 它仍是一条有效负控，但**它现在守的是另一段判据**，别照旧读成「目标目录筛还在」。

      // 🔴 **登记退役（自失效断言在本批兑现，这是它第 6 次真实触发）**：作废原文照录 ——
      //   ~~`check("登记·junction 写成**长名**时路径里没有 `~N` ⇒ 候选侧压根不 realpath ⇒ 仍漏
      //   （当前 exit 0）… 同一张单：issue #199", longJunc === 0)`~~
      //   —— **#199 落地当天它当场变红并点名**（实测 `code=2`），逼我回来把它改成正控。
      //   **修法与它自己那句预判不同**：它写的是「修它要让候选侧无条件 realpath」，
      //   而实际修法是**常量侧**无条件 realpath（攻击者写的是链目标的长名，候选侧对它无事可做，
      //   缺的一直是 live 目录那一侧没解开链）。⇒ **登记条目会记下「哪天有人修会红」，
      //   记不下「会怎么修」；它对修法的猜测不构成契约。**
      const longJunc = gate(ps(dest(J.home).replace(/\.claude"$/, 'actualcfg"')),
        { env: { USERPROFILE: J.home } }).code;
      check("🟢#199 正控（原登记条目）·junction 写成**长名**（`<home>\\actualcfg`，路径里没有 `~N`）" +
            "现在 **exit 2** —— 常量侧无条件解开链之后，写链目标不再是绕过路径",
        longJunc === 2, `code=${longJunc}`);

      // ── 🔴 #199 · 两相判定：各自的**专属样本** + 各自的 mutation ────────────────────
      // 判决 = 相①（归一前）∨ 相②（归一后）。两相各有一格是**只有它拦得住**的：
      //   · 相① 专属 = **`settings.json` 自己是符号链接**（头注 ⑰）—— 归一会把末段改写成
      //     链目标名，任何「归一后再问末段」的判据在这一格上必然失明。
      //   · 相② 专属 = **候选写 8.3 短名而 HOME 是长名** —— 两侧形态不一致，只有归一得上。
      // `#官抗-负控独立归因` 要的正是这个：**一格一样本一谓词**，缺哪一相都得有断言会红。
      {
        // ⑰ 的 fixture：真实目录 `.claude` + 文件级**符号链接** `settings.json → actual.json`。
        // **自失效**（同 #134 那份）：`mklink` 失败 / 退化成普通文件 / 链目标末段碰巧也叫
        // `settings.json` ⇒ 前置断言当场红，而不是悄悄测了个别的东西。
        const symHome = path.join(SBX, "homedir-symlink-z");
        const symDir = path.join(symHome, ".claude");
        fs.mkdirSync(symDir, { recursive: true });
        const symTarget = path.join(symDir, "actual.json");
        fs.writeFileSync(symTarget, "{}", "utf8");
        const symLink = path.join(symDir, "settings.json");
        const mk = spawnSync("cmd", ["/c", "mklink", symLink, symTarget], { encoding: "utf8", windowsHide: true });
        const symShort = shortNameOf(symHome);
        const lst = (() => { try { return fs.lstatSync(symLink); } catch (_) { return null; } })();
        const symReal = (() => { try { return fs.realpathSync.native(symLink); } catch (_) { return ""; } })();
        check("#199 前置·文件级符号链接造得出来（`mklink`，无 /J /D ⇒ 文件链）",
          mk.status === 0, mk.status === 0 ? "ok" : `mklink exit=${mk.status}（⇒ 下面那组只是没测到，不是通过）`);
        check("#199 前置·它真是个链，不是普通文件（退化成普通文件 ⇒ 测的就不是 ⑰ 那个形态）",
          !!lst && lst.isSymbolicLink(), `isSymbolicLink=${lst && lst.isSymbolicLink()}`);
        check("#199 前置·链目标末段**不叫** `settings.json`（`…/actual.json`）—— 这一格正是「归一改写末段」",
          /[\\/]actual\.json$/i.test(symReal), `realpath=${symReal}`);
        check("#199 前置·该假 HOME 算得出真 8.3 短名（realpath 往返，不是猜 8.3 算法）",
          !!symShort, `short=${symShort}`);

        if (mk.status === 0 && lst && lst.isSymbolicLink() && /[\\/]actual\.json$/i.test(symReal) && symShort) {
          const P1 = ps(`Copy-Item src.json "${symShort}\\.claude\\settings.json" -Force`);   // 相① 专属
          const P1long = ps(`Copy-Item src.json "${symHome}\\.claude\\settings.json" -Force`);
          const P2 = ps(`Copy-Item src.json "${SHORT_HOME}\\.claude\\settings.json" -Force`); // 相② 专属（真 HOME）
          check("🟢#199 正控·⑰ **`settings.json` 自己是符号链接 + 短名 HOME（候选也写短名）** → exit 2（此前 exit 0）",
            gate(P1, { env: { USERPROFILE: symShort } }).code === 2,
            `code=${gate(P1, { env: { USERPROFILE: symShort } }).code}`);
          check("#199 正控·同一 fixture，候选与 HOME **都写长名** → exit 2（改前长名侧本来就拦得住，别读成新增）",
            gate(P1long, { env: { USERPROFILE: symHome } }).code === 2,
            `code=${gate(P1long, { env: { USERPROFILE: symHome } }).code}`);
          check("#199 正控·相② 专属样本（候选写 8.3 短名 + 真实长名 HOME）→ exit 2",
            gate(P2).code === 2, `code=${gate(P2).code}`);

          // 🔴🔴 **⑲ 新登记（自失效）：⑰ 的第 5 种长相 —— 形态交叉的那一格仍然漏。**
          //   `settings.json` 是符号链接 **且** 候选写 8.3 短名 **而 HOME 是长名** ⇒ 两相一起失明：
          //     · 相①（不归一）：候选是短名、常量是长名 ⇒ 字符串比不上；
          //     · 相②（归一）：realpath 顺着链把末段改写成 `actual.json` ⇒ `g2IsLive` 的文件名快筛失明。
          //   ⚠️ **它是本任跑 2×2 时被自己的一条错断言逼出来的**（我原以为「长名 HOME 两边都拦」，
          //     实测 code=0）—— 又一次「一组样本的共同约束被当成背景写进结论」：⑰ 那份 2×2
          //     **候选形态与 HOME 形态始终一致**，交叉的两格从来没被量过。
          //   **非退化，实测 master 与本 PR 逐格相同**（`_tmp/probe-sym.mjs` 四格：
          //     master `0 / 2 / 0 / 2`、PR `0 / 2 / 2 / 2` —— 只有 ⑰ 那格由 0 变 2，本格两版都是 0）。
          //   **可达性照直写**：本机 `~/.claude/settings.json` 实测**不是**链（`lstat` isSymbolicLink=false）、
          //     `~/.claude` 也不是 ⇒ 这个拓扑在本机零发生，fixture 是造的。
          //   **已知修法（零额外 I/O，本批刻意不做）**：加一相「**归一后的目录 + 归一前的末段**」——
          //     父目录那条路径**已经在 `wanted` 里**（相① 的两级退化会把它一起记下），
          //     所以那一相不多花任何 syscall。不做的理由：本单契约是「候选侧有界化 + ⑯相邻格」，
          //     临合并加第三相属扩范围，而**判据类改动禁先合后审**（`#帅-撤宣称不抢修`：
          //     盘上文字改真、修法归跟进单，不在合并压力下抢修）。账见 PR body「未尽处」。
          const crossed = gate(P1, { env: { USERPROFILE: symHome } }).code;
          check("登记（自失效）·⑲ 符号链接 + **候选短名 / HOME 长名**（形态交叉）⇒ 两相一起失明，" +
                "当前 **exit 0**。master 同格也是 0 ⇒ 漏报方向、非退化。**账挂在 issue #214**。" +
                "哪天有人修好这条会红并点名，逼他同批更新 hook 头注 ⑲ 与本条",
            crossed === 0, `code=${crossed}`);

          // mutation A：**打掉相①**（结果算出来但不采纳 —— `#官抗-改坏多形态` 的第③向）
          const RE_P1 = /  if \(v1\) return v1;/;
          const nA = (SRC.match(new RegExp(RE_P1.source, "g")) || []).length;
          check("#199 锚点恰好命中 1 次（相① 的采纳点）", nA === 1, `命中 ${nA} 次`);
          if (nA === 1) {
            const mp = path.join(TMP, "mutant-199-no-phase1.js");
            fs.writeFileSync(mp, SRC.replace(RE_P1, () => "  if (false) return v1;"), "utf8");
            check("#199 变异体存活（无相①）：无关输入仍 exit 0", gate(bash("echo hi"), { script: mp }).code === 0);
            check("🔴#199 判别力·**相① 的结果不被采纳** ⇒ ⑰ 那一格由 2 **翻 0**（∴ 那一格只有相① 拦得住）",
              gate(P1, { env: { USERPROFILE: symShort }, script: mp }).code === 0,
              `mut=${gate(P1, { env: { USERPROFILE: symShort }, script: mp }).code}`);
            check("#199 归因·同一变异体下**相② 专属样本仍 2**（∴ 打掉的确实只是相① 那一半）",
              gate(P2, { script: mp }).code === 2, `code=${gate(P2, { script: mp }).code}`);
          }

          // mutation B：**打掉相②**（批量结果恒空 ⇒ 相② 与相① 逐字节同结果）
          // ⚠ 锚点 2026-08-09 随 #214 更新（第二次跟着源码走）：`g2RealpathBatch` 的返回值由
          //   一个 Map 换成 `{map, fed, tried}`（要分得开「试过但没有」与「压根没轮到」），
          //   **旧锚 `const map = g2RealpathBatch(wanted);` 已不在盘上**，它当场红并点名。
          const RE_P2 = /  const batch = g2RealpathBatch\(wanted\);/;
          const nB = (SRC.match(new RegExp(RE_P2.source, "g")) || []).length;
          check("#199 锚点恰好命中 1 次（相② 的批量解析点）", nB === 1, `命中 ${nB} 次`);
          if (nB === 1) {
            const mp = path.join(TMP, "mutant-199-no-phase2.js");
            // 🔴 **只清空解析结果，`fed`/`tried` 留真值** —— 这一格是被自己咬出来的：
            //   首版写成 `{ map: new Map(), fed: 0, tried: 0 }`，`fed=0` 连**相③ 与饿死判定
            //   一起打掉了**（两者都以 `fed` 为门），于是相③ 专属样本跟着翻 0 ⇒ 那不是
            //   「相② 的判别力」，是「一刀砍掉三相」。**大杀面变体分不出是哪一相在承重**
            //   （`#官抗-订正面变体` 同型）⇒ 改成 `Object.assign(…, { map: new Map() })`：
            //   批量照跑、`fed`/`tried` 照数，只有相② 拿不到东西。
            fs.writeFileSync(mp, SRC.replace(RE_P2, () =>
              "  const batch = Object.assign(g2RealpathBatch(wanted), { map: new Map() });"), "utf8");
            check("#199 变异体存活（无相②）：无关输入仍 exit 0", gate(bash("echo hi"), { script: mp }).code === 0);
            // 🔴 **承重样本 2026-08-09（#214）换掉了**：原样本（候选写 8.3 短名 + 长名 HOME）
            //   现在由相③ 兜住 ⇒ 打掉相② 它照样 exit 2，那条断言会变成恒真。
            if (clOk) {
              check("🔴#199/#214 判别力·**相② 拿不到任何解析结果** ⇒ 相② 专属样本（候选经链）由 2 **翻 0**",
                gate(payLink, { env: clEnv, script: mp }).code === 0,
                `mut=${gate(payLink, { env: clEnv, script: mp }).code}`);
            }
            // 🔴 **这一条量的是相③ 的射程边界，别读成「相③ 没用」**（首版在这里写错过一次）：
            //   相③ 只作用在 `batch.untried`（压根没轮到的），而本变异体是「批量照跑、只是
            //   结果被清空」⇒ `untried` 是空的 ⇒ 相③ **按设计不该介入** ⇒ 短名那一格照旧翻 0。
            //   ∴ **健康路径上守住短名那一大类的仍然是相②**，相③ 是饿死时才上场的兜底。
            //   （首版误写成「相③ 专属样本仍 2」并当场红 —— 那正是把兜底当主力读的形态。）
            check("🔴#214 射程·相② 结果被清空而**批量跑完了** ⇒ 短名那一格由 2 **翻 0**" +
                  "（∴ 相③ 只在「压根没轮到」时上场，不抢健康路径的活）",
              gate(P2, { script: mp }).code === 0, `code=${gate(P2, { script: mp }).code}`);
            check("#199 归因·同一变异体下 ⑰ 那一格仍 2（∴ 打掉的确实只是相② 那一半）",
              gate(P1, { env: { USERPROFILE: symShort }, script: mp }).code === 2,
              `code=${gate(P1, { env: { USERPROFILE: symShort }, script: mp }).code}`);
          }

          // 负控（`#官实-误伤反例`）：两相判定是**深度加倍**，不是判据放宽 —— 合法形态不许中招。
          // ⚠️ **语料来源照直标（`#官抗-语料非自证` 负控那半）**：第一条是真实形态
          //   （项目级 `.claude/settings.json`，`update-config` 那条路日常在写，也正是 PR #145
          //   第三轮 fail-closed 真误伤过的那一格）；后两条**是本轮自造的诱饵**，只证明
          //   「我的诱饵不会被误伤」。
          for (const [nm, home, pay] of [
            ["项目级 `.claude/settings.json`（真实形态：`update-config` 那条路）", symShort,
              edit(path.join(SBX, "someproject", ".claude", "settings.json"))],
            ["自造诱饵·链所在目录里的**别的**文件（`…/.claude/actual.json`，末段不是 live 名）", symShort,
              ps(`Copy-Item src.json "${symShort}\\.claude\\actual.json" -Force`)],
            ["自造诱饵·`settings.json` 但目录不是 live（`<sbx>/.claude-backup/`）", symShort,
              ps(`Copy-Item src.json "${path.join(SBX, ".claude-backup")}\\settings.json" -Force`)],
          ]) {
            const c = gate(pay, { env: { USERPROFILE: home } }).code;
            check(`#199 负控·${nm} → exit 0（不许误伤）`, c === 0, `code=${c}`);
          }
        }
      }
    }
  }

  // ── 🔴🔴 #214：⑱ 回归带闭合（相③ 8.3 投机展开 + 饿死 fail-close）────────────────────
  // **要修的病，一句话**：批量子进程是**一批候选共享一个时间界**，候选数量够大时排在后面的
  // 压根轮不到 ⇒ 退回「按原样比」⇒ 真目标漏过。PR #216 对抗官量出这是一段**真回归**——
  // 同一条命令改动前（逐条独立同步解析、无共享预算）拦得住，#199 那一版漏。
  // **两半修法**：①**相③** —— realpath 没验成时，按 8.3 短名的生成规则做**零 I/O 投机展开**
  // （短名不是随机串：主名前 6 + `~N`、扩展名前 3，冲突多了改用「前 2 + 4 位 hex」）；
  // ②**饿死 fail-close** —— 相③ 展不开、又确实有候选压根没轮到、且候选数已经不是日常形态时，
  // 不许静默 exit 0。**两半各有专属样本与专属 mutation**，缺哪半都得有断言会红。
  if (SHORT_HOME) {
    const asLong = {};                       // 长名 HOME：候选写短名时只有归一/展开得上才拦得住
    const harmless2 = bash("echo hi");
    const bandTarget = ps(`Copy-Item src.json "${SHORT_HOME}\\.claude\\settings.json" -Force`);
    // 回归带 payload：N 条**过得了零 I/O 前筛**的互异诱饵 + 末尾真目标。
    // 诱饵必须互不相同（`g2Phases` 的 `seen` 去重会把重复的折成一条）、末段像 live（否则
    // 前筛就挡了、量不到共享预算这一格）。
    // ⚠️ **N 是按本机标定的，它有一条会自己出声的失效条件**（`#官通-性能哨兵` ①：绝对数字
    //    不可移植）：一条诱饵进 `wanted` 两次（整条 + 父目录两级退化）⇒ fed ≈ 2N；本机实测
    //    800 ms 界内约解到第 4 万条 ⇒ N=48000（fed≈96000）留了约 2.4 倍余量。
    //    **换台快 2.4 倍以上的机器，整批会跑完 ⇒ 下面那条「自陈打得出来」的前置断言当场红**，
    //    那时把 N 调大即可 —— **别把它读成缺陷，那正是这条前置断言存在的理由**
    //    （没有它，批量跑完时上面几条会「通过」，而它们量的其实已经不是回归带了）。
    const BAND_N = 48000;
    const bandPay = ps(Array.from({ length: BAND_N },
      (_, i) => `Copy-Item a.md "${SHORT_HOME}\\zz${i}~1\\settings.json"`).join("; ") +
      `; Copy-Item src.json "${SHORT_HOME}\\.claude\\settings.json" -Force`);

    // ① 相③ 的三个 mutation 方向（`#官抗-改坏多形态`：①移除 ②保留字面但不执行 ③结果不被消费）
    const RE_P3 = /  if \(batch\.untried\.length\) \{/;                              // ①移除整相
    const RE_EXPAND = /  if \(!\/~\\d\/\.test\(s\)\) return null;/;                  // ②函数恒 null
    const RE_DIRECT = /    if \(direct\) \{\r?\n      return blocked\(/;             // ③结果不被消费
    const RE_STARVE = /const G2_CAND_STARVE_N = 64;/;
    for (const [nm, re] of [["相③ 整相", RE_P3], ["g2ShortExpand 首行", RE_EXPAND],
                            ["相③ 直判的采纳点", RE_DIRECT], ["饿死阈值常量", RE_STARVE]]) {
      const n = (SRC.match(new RegExp(re.source, "g")) || []).length;
      check(`#214 锚点恰好命中 1 次（${nm}）`, n === 1, `命中 ${n} 次`);
    }
    const anchorsOk = [RE_P3, RE_EXPAND, RE_DIRECT, RE_STARVE]
      .every((re) => (SRC.match(new RegExp(re.source, "g")) || []).length === 1);

    if (anchorsOk) {
      const mkMut = (name, ...pairs) => {
        const p = path.join(TMP, name);
        let body = SRC;
        for (const [re, to] of pairs) body = body.replace(re, () => to);
        fs.writeFileSync(p, body, "utf8");
        return p;
      };
      const mNo3 = mkMut("mutant-214-no-phase3.js", [RE_P3, "  if (false) {"]);
      const mNoExp = mkMut("mutant-214-expand-null.js", [RE_EXPAND, "  if (true) return null;"]);
      const mNoUse = mkMut("mutant-214-direct-unused.js", [RE_DIRECT, "    if (direct) {\n      blocked("]);
      for (const [nm, mp] of [["无相③", mNo3], ["展开恒 null", mNoExp], ["直判结果不被消费", mNoUse]]) {
        check(`#214 变异体存活（${nm}）：无关输入仍 exit 0 且无 fail-open 告警`,
          gate(harmless2, { script: mp }).code === 0 && !/守卫自身出错/.test(gate(harmless2, { script: mp }).err));
      }

      // ② 🔴 **回归带本体**：N 个诱饵把共享预算吃光 ⇒ 真目标排在后面解不开。
      //    **这一组既是正控也是判别力**：同一条 payload，有相③ 拦得住、没相③ 就是那条回归带。
      {
        // 🔴 **要看见「那条回归带」，必须把两半一起摘掉**（这一格是被自己咬出来的）：
        //   只摘相③ ⇒ 饿死 fail-close 顶上，payload 照拦 **exit 2**（那是纵深防御在起作用，
        //   不是相③ 没用）。⇒ 「相③ 承重」这句话要用「两半都摘」的变异体才量得到，
        //   而「只摘一半仍拦得住」本身值得单独记一条 —— 它证的是两半确实互为兜底。
        const mNo3NoStarve = mkMut("mutant-214-no-phase3-no-starve.js",
          [RE_P3, "  if (false) {"], [RE_STARVE, "const G2_CAND_STARVE_N = 1000000000;"]);
        const t0 = Date.now();
        const real = gate(bandPay, { env: asLong });
        const msReal = Date.now() - t0;
        const t1 = Date.now();
        const mut = gate(bandPay, { env: asLong, script: mNo3NoStarve });
        const msMut = Date.now() - t1;
        check(`🔴🔴#214 回归带闭合·${BAND_N} 个诱饵吃光共享预算 + 真目标排最后 ⇒ **仍 exit 2**`,
          real.code === 2, `code=${real.code}`);
        check("🔴🔴#214 判别力·同一条 payload **两半都摘掉就是那条回归带**（由 2 翻 0）" +
              "⇒ 这一格确实是本批在承重，不是别的东西顺手挡住的",
          mut.code === 0, `mut=${mut.code}`);
        check("🟢#214 纵深·**只摘相③**（饿死 fail-close 还在）⇒ 同一条 payload 仍 exit 2" +
              "（∴ 两半互为兜底，不是一根独木；也说明上一条必须两半一起摘才量得到）",
          gate(bandPay, { env: asLong, script: mNo3 }).code === 2,
          `code=${gate(bandPay, { env: asLong, script: mNo3 }).code}`);
        check("🟢#214 纵深的另一半·**只摘饿死 fail-close**（相③ 还在）⇒ 同一条 payload 仍 exit 2",
          gate(bandPay, { env: asLong, script: mkMut("mutant-214-starve-huge-only.js",
            [RE_STARVE, "const G2_CAND_STARVE_N = 1000000000;"]) }).code === 2);
        check("🔴#214 前置·那条 payload 确实把批量饿死了（「候选侧批量没跑完」自陈打得出来）" +
              "⇒ 上面两条量的是「没验成之后怎么办」，不是「批量其实跑完了」。" +
              "**这条红了 = 本机比标定时快了 2.4 倍以上，把 `BAND_N` 调大，不是缺陷**",
          /候选侧批量 realpath 没跑完/.test(real.err), real.err.slice(0, 200));
        // 性能哨兵（`#官通-性能哨兵`）：**不锚绝对毫秒**（换台机器差数倍），锚**相对量**——
        // 相③ 是零 I/O 的兜底，不许把 hook 墙钟变成另一个放大器（那正是 #133/#199 守的东西）。
        check(`🔴#214 界·加了相③ 之后同一条 payload 的 hook 寿命 < 摘掉相③ 的 2 倍` +
              `（实测 ${msReal} ms vs ${msMut} ms）⇒ 相③ 没把 N×something 请回来`,
          msReal < msMut * 2 + 1500, `real=${msReal}ms mut=${msMut}ms`);
        check("#214 对照·同一条 payload 在**短名 HOME** 下由相① 零 I/O 命中（∴ 上面那组不是恒真）",
          gate(bandPay, { env: { USERPROFILE: SHORT_HOME } }).code === 2);
      }

      // ③ 相③ 的**另外两个方向**打在最小 payload 上（不必再跑一遍两万条）
      {
        const mutHang = mkMut("mutant-214-band-hang.js",
          [/const G2_CAND_REALPATH_MS = 800;/, "const G2_CAND_REALPATH_MS = 1;"]);
        check("🔴#214 判别力②·`g2ShortExpand` 恒 null + 候选侧界 1 ms ⇒ 短名那一格由 2 翻 0",
          gate(bandTarget, { env: asLong }).code === 2 &&
          gate(bandTarget, { env: asLong, script: mkMut("mutant-214-expand-null-1ms.js",
            [RE_EXPAND, "  if (true) return null;"],
            [/const G2_CAND_REALPATH_MS = 800;/, "const G2_CAND_REALPATH_MS = 1;"]) }).code === 0);
        check("🔴#214 判别力③·**直判结果算出来但不被采纳** + 候选侧界 1 ms ⇒ 同一格由 2 翻 0" +
              "（`#官抗-改坏多形态` 第③向：门还在、门的答案没人听）",
          gate(bandTarget, { env: asLong, script: mkMut("mutant-214-direct-unused-1ms.js",
            [RE_DIRECT, "    if (direct) {\n      blocked("],
            [/const G2_CAND_REALPATH_MS = 800;/, "const G2_CAND_REALPATH_MS = 1;"]) }).code === 0);
        check("#214 对照·只把界收到 1 ms（相③ 完好）⇒ 同一格仍 exit 2（∴ 上两条翻的是相③ 不是那个界）",
          gate(bandTarget, { env: asLong, script: mutHang }).code === 2,
          `code=${gate(bandTarget, { env: asLong, script: mutHang }).code}`);

        // 🔴 相③ 的**第三个调用点**：`cp <源> <目标目录>` 那一支合成的候选是「目标目录 + 源文件名」，
        //    展开结果是 live **目录**而不是 live 文件 ⇒ 拦不拦要看源文件名，只有重跑 judge 知道。
        const destForm = ps(`Copy-Item -LiteralPath settings.json -Destination "${SHORT_HOME}\\.claude"`);
        check("🟢#214 正控·相③ 的**目标目录形态**（`-Destination <短名>\\.claude`）+ 界 1 ms ⇒ 仍 exit 2" +
              "（展开成 live 目录后重跑 judge，源文件名才定案）",
          gate(destForm, { env: asLong, script: mutHang }).code === 2,
          `code=${gate(destForm, { env: asLong, script: mutHang }).code}`);
        check("🔴#214 判别力·同一条在**无相③** 变异体下由 2 翻 0（∴ 那一格也是相③ 在承重）",
          gate(destForm, { env: asLong, script: mkMut("mutant-214-no-phase3-1ms.js",
            [RE_P3, "  if (false) {"],
            [/const G2_CAND_REALPATH_MS = 800;/, "const G2_CAND_REALPATH_MS = 1;"]) }).code === 0);
        check("#214 负控·同一条**源文件名不是 live**（`-LiteralPath a.md`）⇒ exit 0（不许误伤）" +
              "∴ 相③ 展开的是目录，定案的仍是源文件名",
          gate(ps(`Copy-Item -LiteralPath a.md -Destination "${SHORT_HOME}\\.claude"`),
            { env: asLong, script: mutHang }).code === 0);
      }

      // ④ 🔴 **饿死 fail-close**：相③ 展不开的那一类，靠「没验完 + 候选数不是日常形态」兜住。
      //    诱饵**不带真目标** —— 要量的是「这一批我没验完」本身，不是「查出了违例」。
      {
        const starvePay = ps(Array.from({ length: 200 },
          (_, i) => `Copy-Item a.md "${SHORT_HOME}\\zz${i}~1\\settings.json"`).join("; "));
        const m1ms = mkMut("mutant-214-1ms-only.js",
          [/const G2_CAND_REALPATH_MS = 800;/, "const G2_CAND_REALPATH_MS = 1;"]);
        check("🔴#214 正控·200 个候选 + 界 1 ms（整批没验成）⇒ **fail-close exit 2**" +
              "（「没验完」不等于「没有违例」，这一格不许静默放行）",
          gate(starvePay, { env: asLong, script: m1ms }).code === 2,
          `code=${gate(starvePay, { env: asLong, script: m1ms }).code}`);
        check("#214 正控·那条拦截文案说的是「这次没验过」而不是「查出你在写 live 配置」" +
              "（被拦的人不该去找一个并不存在的违例目标）",
          /这次没验过/.test(gate(starvePay, { env: asLong, script: m1ms }).err),
          gate(starvePay, { env: asLong, script: m1ms }).err.slice(0, 200));
        // 🔴 三条负控，都是**误伤方向**（`#官实-误伤反例`：两侧代价都是真代价）
        check("🔴#214 负控·同一条 200 候选在**真界**下批量跑得完 ⇒ exit 0（∴ 拦的不是「候选多」）",
          gate(starvePay, { env: asLong }).code === 0, `code=${gate(starvePay, { env: asLong }).code}`);
        if (clOk) {
          check("🔴#214 负控·候选数在阈值以下（2 条）+ 界 1 ms ⇒ 仍 **fail-open exit 0**" +
                "（单条解不开照旧 fail-open —— 设计取舍② 没有被这一格推翻）",
            gate(payLink, { env: clEnv, script: m1ms }).code === 0,
            `code=${gate(payLink, { env: clEnv, script: m1ms }).code}`);
        }
        // 反向 mutation：阈值改大改小**都要有断言响**（`#官通-调参三问` 的机器面）
        check("🔴#214 反向·阈值调到天大 ⇒ 上面那条 fail-close 由 2 翻 0（∴ 这个常量真的在被读）",
          gate(starvePay, { env: asLong, script: mkMut("mutant-214-starve-huge.js",
            [RE_STARVE, "const G2_CAND_STARVE_N = 1000000000;"],
            [/const G2_CAND_REALPATH_MS = 800;/, "const G2_CAND_REALPATH_MS = 1;"]) }).code === 0);
        if (clOk) {
          check("🔴#214 反向的另一侧·阈值调到 0 ⇒ **误伤方向**也有响（2 条候选那格由 0 翻 2）" +
                "⇒ 这条线的两侧都有断言夹着，不是只验了「拦得住」",
            gate(payLink, { env: clEnv, script: mkMut("mutant-214-starve-zero.js",
              [RE_STARVE, "const G2_CAND_STARVE_N = 0;"],
              [/const G2_CAND_REALPATH_MS = 800;/, "const G2_CAND_REALPATH_MS = 1;"]) }).code === 2);
        }
      }

      // ⑤ 🔴 **#235 · 相③「重跑 judge」路的预算闸**（issue #214 ㉑，PR #235 对抗官第三代实测坐实）：
      //    这条路首版没有开销上界——攻击者只需再塞一个「展开后恰是 live 目录本身」的候选
      //    （末位放，落进 `batch.untried`）就能强制重跑一遍完整判定。对抗官实测：N=48000 诱饵，
      //    不带这个 token 5.3 s、带上 11.4 s ⇒ 越过宿主 10 s ⇒ 整个 hook 被杀，七道闸一起放行——
      //    包括那条本该被饿死 fail-close 拦下的命令。**修法**：用这一次相① 的真实耗时当
      //    「重跑一遍要多贵」的估价，预算不够就不硬跑，退回饿死 fail-close（诚实说"没验完"）。
      {
        const RE_BUDGET_CHECK = /if \(elapsed \+ G2_RERUN_COST_FACTOR \* v1CostMs > G2_RERUN_DEADLINE_MS\) return g2Starved\(batch\.fed, starved\);/;
        const RE_MARGIN = /const G2_RERUN_SAFETY_MARGIN_MS = 2000;/;
        // 🔴 issue #254 新增三个锚点：估价系数常量 + 预算闸自己量的两个真实耗时变量
        //   （危险窗判别力断言 ⑦ 靠伪造后两个变量的值把机器速度从判据里剔除，见该节）。
        const RE_FACTOR = /const G2_RERUN_COST_FACTOR = 2\.5;/;
        const RE_V1COST = /const v1CostMs = Date\.now\(\) - t0;/;
        const RE_ELAPSED = /const elapsed = Date\.now\(\) - t0;/;
        const n235 = (SRC.match(new RegExp(RE_BUDGET_CHECK.source, "g")) || []).length;
        check("#235 锚点恰好命中 1 次（㉑ 预算闸，issue #254 后含系数乘项）", n235 === 1, `命中 ${n235} 次`);
        const nMargin = (SRC.match(new RegExp(RE_MARGIN.source, "g")) || []).length;
        check("#235 锚点恰好命中 1 次（安全边际常量）", nMargin === 1, `命中 ${nMargin} 次`);
        const nFactor = (SRC.match(new RegExp(RE_FACTOR.source, "g")) || []).length;
        check("#254 锚点恰好命中 1 次（估价系数常量）", nFactor === 1, `命中 ${nFactor} 次`);
        const nV1Cost = (SRC.match(new RegExp(RE_V1COST.source, "g")) || []).length;
        check("#254 锚点恰好命中 1 次（v1CostMs 赋值）", nV1Cost === 1, `命中 ${nV1Cost} 次`);
        const nElapsed = (SRC.match(new RegExp(RE_ELAPSED.source, "g")) || []).length;
        check("#254 锚点恰好命中 1 次（elapsed 赋值）", nElapsed === 1, `命中 ${nElapsed} 次`);

        if (n235 === 1 && nMargin === 1) {
          const mNoBudget = mkMut("mutant-235-no-budget.js", [RE_BUDGET_CHECK, "null"]);
          check("#235 变异体存活（摘掉预算闸）：无关输入仍 exit 0 且无 fail-open 告警",
            gate(harmless2, { script: mNoBudget }).code === 0 &&
            !/守卫自身出错/.test(gate(harmless2, { script: mNoBudget }).err));

          // 🔴 **判别力**：把预算闸的安全边际调到等于宿主超时本身（deadline≈0，恒判"预算不够"），
          //   配合候选侧界收到 1 ms（逼 dirForm 在小规模 payload 上也能可靠触发，不必真跑几万条
          //   诱饵——同一个判据，用「界 1 ms」换「不依赖机器速度/负载」，与 ③④ 两节同一手法）。
          //   **只需 3 个诱饵 + 1 个末置 dirForm 触发子**（fed=8，远低于 `G2_CAND_STARVE_N`）：
          //   正常预算下 fed 这么小根本到不了「饿死」那格（day-to-day 不该 fail-close 的性质
          //   在这里被同时验到）；deadline 恒超时，预算闸必须**不看 fed 门槛、直接** fail-close——
          //   这正是"重跑路自己的开销上界"要做的事：宁可少验一条，也不能因为验它而拖垮整个 hook。
          const m1msDeadlineZero = mkMut("mutant-235-1ms-deadline-zero.js",
            [RE_MARGIN, "const G2_RERUN_SAFETY_MARGIN_MS = 10000;"],
            [/const G2_CAND_REALPATH_MS = 800;/, "const G2_CAND_REALPATH_MS = 1;"]);
          const m1msNormal = mkMut("mutant-235-1ms-normal.js",
            [/const G2_CAND_REALPATH_MS = 800;/, "const G2_CAND_REALPATH_MS = 1;"]);

          const smallDecoys = Array.from({ length: 3 },
            (_, i) => `Copy-Item a.md "${SHORT_HOME}\\zz${i}~1\\settings.json"`).join("; ");
          const dirFormPay = ps(smallDecoys +
            `; Copy-Item -LiteralPath b.md -Destination "${SHORT_HOME}\\.claude"`);

          const normalR = gate(dirFormPay, { env: asLong, script: m1msNormal });
          check("#235 正控·正常预算 + 界 1 ms（fed=8，远低于饿死阈值）⇒ **仍 exit 0**" +
                "（相③ 重跑 judge 正常跑完，b.md 不是 live 名，没找到真违例，day-to-day 不该被拦）",
            normalR.code === 0, `code=${normalR.code}`);
          const budgetR = gate(dirFormPay, { env: asLong, script: m1msDeadlineZero });
          check("🔴#235 判别力·同一条 payload，把预算闸的安全边际调到「恒判预算不够」⇒ **由 0 翻 2**" +
                "（不看 fed 是否过阈值——重跑路自己的开销上界必须先于饿死阈值生效）",
            budgetR.code === 2, `code=${budgetR.code}`);
          check("#235 正控·拦截文案仍是「没验过」而不是「查出你在写 live 配置」",
            /这次没验过/.test(budgetR.err), budgetR.err.slice(0, 200));

          // ⑦ 🔴 **issue #254 ①·真能量到预算闸**（危险窗 v1∈(2.8s,3.5s)，本机约 N≈40000–52000）：
          //    上面 ⑤ 那组只证「预算闸这个机制存在且被读」（安全边际调到 10000 让 deadline≈0，
          //    不管系数是几都恒判"预算不够"，测的是**布线**不是**取值**）；下面 ⑥ 那组大规模
          //    复测证的是「兜底 fail-close 仍在」（M4 mutation 坐实：抹平 `starved` 才会翻绿，
          //    抹平预算闸判据不会——那条断言在危险窗内是**空过**，走的是末尾饿死闸，不是预算闸，
          //    2026-08-09 issue #254 判词首次点破）。**这一组要证的是第三件事、也是本单的关闭
          //    条件①**：估价系数这个乘项，是不是真的把原来漏判的那段 v1 区间关上了。
          //    **射程别读大**：它钉得住的是「系数大于本构造的翻转点」，不是字面 2.5——见下方判别力那条的注。
          //    **判别力靠退出码，不靠计时**（不必真跑几万条诱饵去凑机器相关的绝对耗时）：payload
          //    用上面的 `dirFormPay`（3 诱饵 + 1 个 dirForm 触发子，fed=8，远低于
          //    `G2_CAND_STARVE_N`=64）——**末尾饿死闸这一格在这个规模上永远到不了**（fed 太小），
          //    故 exit 2 在这个 payload 上只能来自预算闸，exit 0 只能是预算闸没拦、v3 重跑完
          //    又没找到真违例（`b.md` 不是 live 名，同 `normalR` 那条对照）。
          //    **v1CostMs / elapsed 直接伪造成危险窗中点**（`v1=3000ms`，`elapsed=1.31·v1≈3930ms`
          //    ——1.31 那个拟合系数取自 ㉑ 头注同一处出处，不是本节现造）：老系数（=1，issue #254
          //    修复前的等价值）算得 `3930+3000=6930≤8000` ⇒ 判"还来得及"（漏判）；新系数
          //    （=2.5，issue #254 拍板值）算得 `3930+2.5×3000=11430>8000` ⇒ 正确判"来不及"。
          //    **同带 `G2_CAND_REALPATH_MS→1`**（与 ③④⑤ 同一手法，不是无关改动）：这个 tiny
          //    payload（fed=8）在真界 800 ms 下批量 realpath 会**全部解得开**，`batch.untried`
          //    留空 ⇒ 根本进不了 `if (dirForm)` 那一格，我伪造的 v1CostMs/elapsed 就白伪造了
          //    （本条作者写这一组时先漏了这一步，第一轮跑出 code=0 才捞回来——批内两条都要它）。
          const mDangerWindow = mkMut("mutant-254-danger-window.js",
            [RE_V1COST, "const v1CostMs = 3000;"], [RE_ELAPSED, "const elapsed = 3930;"],
            [/const G2_CAND_REALPATH_MS = 800;/, "const G2_CAND_REALPATH_MS = 1;"]);
          const mDangerWindowBrokenFactor = mkMut("mutant-254-danger-window-factor1.js",
            [RE_V1COST, "const v1CostMs = 3000;"], [RE_ELAPSED, "const elapsed = 3930;"],
            [/const G2_CAND_REALPATH_MS = 800;/, "const G2_CAND_REALPATH_MS = 1;"],
            [RE_FACTOR, "const G2_RERUN_COST_FACTOR = 1;"]);
          if (nFactor === 1 && nV1Cost === 1 && nElapsed === 1) {
            const dwR = gate(dirFormPay, { env: asLong, script: mDangerWindow });
            check("🔴🔴#254 正控·危险窗中点（v1=3000ms,elapsed=3930ms）+ 系数=2.5（当前值）⇒ " +
                  "**预算闸真的开**（exit 2；这个 payload 上末尾饿死闸够不到 fed=8，故这个 2 只能" +
                  "来自预算闸——不是像 ⑥ 那条一样的空过）",
              dwR.code === 2, `code=${dwR.code}`);
            // 🔴 **谓词补强（PR #261 返修 · issue #254 对抗判词件①；存量同型两条的账在 issue #266）**
            //    这一条原本写的是 `/这次没验过/.test(dwR.err)`，**恒真**——那四个字同时住在
            //    `g2Starved` 的真拦截文案里**和** `starved > 0` 时那条 fail-open 批量告警里
            //    （本 hook `if (starved > 0)` 那段），而本组构造（候选侧界收到 1 ms）**保证**
            //    `starved > 0` ⇒ 把预算闸整个移除，它照样 true（对抗官三形态 mutation 实测：
            //    移除 / 注释掉 / 结果不被消费，旧谓词三次全绿）。
            //    **改真的形态是换锚点、不是改名**：锚到 `g2Starved` 的 `what` 独有的那句
            //    （批量告警里没有它），再加一条反向——拦截文案不许变成另一格的「查出你在写
            //    live 配置」。**下面两条负控是它的自证**：闸不开火（系数=1）与闸被整个移除，
            //    两侧新谓词都必须翻 false，而 `/这次没验过/` 在那两侧仍为 true —— 那正是旧谓词
            //    被换掉的理由，也一并钉在断言里，省得后人重推一遍。
            const RE_STARVED_VERDICT = /一条命令里产生了 \d+ 条待归一的候选/;  // g2Starved 独有
            const RE_LIVE_VERDICT = /要用 shell 写用户级 live 配置/;            // 另一格的拦截文案
            check("🔴#254 正控·拦下这一条的确实是**饿死 fail-close 那一格**（锚 `g2Starved` 独有句，" +
                  "不是那句 fail-open 批量告警也会打的「没验过」），文案说的是「这次没验过」" +
                  "而不是「查出你在写 live 配置」",
              RE_STARVED_VERDICT.test(dwR.err) && /这次没验过/.test(dwR.err)
                && !RE_LIVE_VERDICT.test(dwR.err), dwR.err.slice(0, 300));
            const dwBrokenR = gate(dirFormPay, { env: asLong, script: mDangerWindowBrokenFactor });
            // 🔴 **这条断言名被对抗官的换靶变异体证伪过一次（PR #261 定向复核 A6），改真后的射程如下**：
            //   本组把危险窗伪造成 `v1=3000` / `elapsed=3930`，而 `G2_RERUN_DEADLINE_MS = 10000−2000 = 8000`
            //   ⇒ 行为翻转点 **f* = 4070/3000 ≈ 1.357**（实测吻合：f=1.3 本条与上一条双红；f=1.36 **并把
            //   下面那个静态锚点一起改成 1.36**——正是改常量的人会顺手做的事——整套 659 条全绿）。
            //   ⇒ **行为侧这几条钉住的是 `f > 1.357`，不是 `f = 2.5`**；字面 2.5 只由同组那条静态文本锚点
            //   （`#254 锚点恰好命中 1 次（估价系数常量）`）单独钉着，而它拦的是「常量被动过」，
            //   不是「安全性质退化」。issue #254 的立论基础是实测 v3/v1 均值 ≈2.22 ⇒ **`[1.36, 2.22)`
            //   这一段行为侧无守护**，修法（重挑伪造值把 f* 抬到 2.22 之上）归 **issue #266 件③**。
            //   **这不是安全缺口**：生产系数仍是 2.5、闸仍在开火，缺的是回归网的射程。
            check("🔴#254 判别力·先破再验：同一危险窗中点，系数改回 1（issue #254 修复前的等价值）" +
                  "⇒ 预算闸判定变回「还来得及」、不拦，v3 重跑完也没找到真违例 ⇒ **由 2 翻 0**" +
                  "（∴ 上一条的通过不是巧合，是**系数大于本构造的翻转点 f*≈1.357** 在起作用，不是随便" +
                  "什么正数都行；**字面 2.5 由同组那条静态锚点单独钉着**，而 `[1.36, 2.22)` 段行为侧" +
                  "无守护——账在 issue #266 件③）",
              dwBrokenR.code === 0, `code=${dwBrokenR.code}`);
            check("🔴#254 负控①·系数改回 1（预算闸不开火）⇒ 上面那条文案谓词翻 **false**" +
                  "（∴ 它不是恒真）；同一份 stderr 上 `/这次没验过/` **仍为 true**——旧谓词的空过在这里现形",
              !RE_STARVED_VERDICT.test(dwBrokenR.err) && /这次没验过/.test(dwBrokenR.err),
              dwBrokenR.err.slice(0, 300));
            // 负控②：把预算闸那一行整个移除（与上面 `mNoBudget` 同一手法，叠在危险窗构造上）——
            //   这正是对抗官用来证伪旧谓词的那个变体，钉在这里就不必再靠一次性实测背书。
            const dwNoBudgetR = gate(dirFormPay, { env: asLong,
              script: mkMut("mutant-254-danger-window-no-budget.js",
                [RE_V1COST, "const v1CostMs = 3000;"], [RE_ELAPSED, "const elapsed = 3930;"],
                [/const G2_CAND_REALPATH_MS = 800;/, "const G2_CAND_REALPATH_MS = 1;"],
                [RE_BUDGET_CHECK, "null"]) });
            check("🔴#254 负控②·预算闸整行移除 ⇒ **由 2 翻 0**，且文案谓词同样翻 **false**" +
                  "（旧谓词 `/这次没验过/` 在这里仍为 true —— 那条 fail-open 批量告警在喂它）",
              dwNoBudgetR.code === 0 && !RE_STARVED_VERDICT.test(dwNoBudgetR.err)
                && /这次没验过/.test(dwNoBudgetR.err),
              `code=${dwNoBudgetR.code} starvedVerdict=${RE_STARVED_VERDICT.test(dwNoBudgetR.err)} ` +
              `旧谓词=${/这次没验过/.test(dwNoBudgetR.err)}`);
          }

          // ⑥ 🔴 **真实规模复测**：判词给出的 N=48000 + 末置 dirForm 触发子形态。
          //    ~~验证不越 10 s。~~
          //    🔴 **订正（对抗官第三代实测证伪，issue #254）**：这个规模落在预算闸的实测危险窗
          //    内（本机 N≈40000–52000），**有闸/无闸两侧本机实测都越过 10 s**——下面那条软哨兵
          //    闸不开时两边同值、恒过；真能量到预算闸的断言见上面 ⑦（issue #254 ①，本批已补，
          //    替掉了此前住在这里的那条空过断言——旧断言 `withFix.code === 2` 的 `exit 2` 走的是
          //    末尾饿死 fail-close，M4 mutation 坐实：抹平 `starved` 才会翻绿，抹平预算闸判据
          //    不会）。**这一节现在只剩一个职责**：大规模下时长的软证据，不再兼职当正控。
          //    **不锚绝对毫秒**（`#官通-性能哨兵` ①，换机/换负载差数倍）：锚的是「有预算闸时同一条
          //    payload 的 hook 寿命，相对没有预算闸时打了折扣」——与 #214 那条界哨兵同一手法，
          //    两次测量在**同一轮**内做，抵消系统负载的整体漂移。
          const trigTail = `Copy-Item -LiteralPath b.md -Destination "${SHORT_HOME}\\.claude"`;
          const bigPay = ps(Array.from({ length: BAND_N },
            (_, i) => `Copy-Item a.md "${SHORT_HOME}\\zz${i}~1\\settings.json"`).join("; ") +
            `; ${trigTail}`);
          const mNoBudgetBig = mkMut("mutant-235-no-budget-big.js", [RE_BUDGET_CHECK, "null"]);
          const t0 = Date.now();
          const withFix = gate(bigPay, { env: asLong });
          const msFixed = Date.now() - t0;
          const t1 = Date.now();
          const noFix = gate(bigPay, { env: asLong, script: mNoBudgetBig });
          const msNoFix = Date.now() - t1;
          // 🔴 此处原有一条 `withFix.code === 2` 的「正控」，已被对抗官第三代 M4 mutation 证伪
          // 是空过（`exit 2` 来自末尾饿死 fail-close，在预算闸出现之前就是绿的；抹平 `starved`
          // 才会翻红，抹平预算闸判据不会）——**issue #254 ① 已把它替掉**，见上面 ⑦（本节现在
          // 只保留大规模下的时长软证据，不再兼职当正控；`withFix`/`noFix` 两个变量仍保留只为
          // 取 `msFixed`/`msNoFix` 两个计时值，其 `.code` 不再被断言）。
          // ⚠️ **这条哨兵是软证据，不是主证据**（`#官通-性能哨兵` ①：绝对数字不可移植，
          //   本机实测同机同轮内就见过 1.7-3 倍离散——本条作者写这组断言当天，机器同时跑着
          //   30+ 个 node 进程、CPU 常驻 80%+ 以上，两次 48000 规模测量偶尔会整体一起被拖慢到
          //   连 A（无触发子）基线都摸到 10s+，此时"有闸 vs 无闸"的相对差会被噪声吃掉甚至倒挂。
          //   **真正钉住"预算闸确实生效"的是上面 ⑤（机制布线）与 ⑦（系数取值，issue #254 ①）
          //   两组判别力断言**（都不依赖机器速度/负载，恒定可复现）；这里只是在真实量级下留一笔
          //   "没有更差"的软证据，容忍度因此给得很宽，宁可漏检也不做一条会在这台共享机器上偶发
          //   闪红的断言。
          //   🔴 **闸不开时两边同值，本条恒过**（issue #254，对抗官第三代实测坐实：本机实测
          //   有闸=11811ms/无闸=11390ms 两个数都越 10s，闸开不开对这条断言的通过与否无影响）。
          check(`#235 界（软证据，闸不开时两边同值本条恒过）·有预算闸时同一条 payload 的 hook 寿命 < ` +
                `没有预算闸时的 2 倍 + 5000 ms` +
                `（实测 有闸=${msFixed}ms 无闸=${msNoFix}ms）——真正的判别力断言在上面 ⑤⑦ 两组`,
            msFixed < msNoFix * 2 + 5000, `fixed=${msFixed}ms nofix=${msNoFix}ms`);
        }
      }
    }

    // ── #235 · 8.3 非法字符替换（相③ 展开的漏报面之一，PR #235 对抗官第三代实测坐实）───────
    // Windows 生成 8.3 短名时，长名里 `+ , ; = [ ]` 这几个**长名合法、短名非法**的字符会被换成
    // `_`（实测 `Ad+min,istra[tor]` → `AD_MIN~1`）；旧版 `g2ShortStemOf` 只处理了空格，
    // 漏了这一档 ⇒ 界坏时对这类 HOME 展不开（漏报）。方向是漏报、可达性窄（这些字符出现在
    // Windows 用户名里的概率低，只在 HOME 被重定向到非常规目录时可达），非阻断项。
    {
      // 本节在 `if (anchorsOk)` 之外（与上面 `⑤ 误伤面` 那节同级），`mkMut` 不在作用域内 ——
      // 就地起一个同型的最小版（同一份「写副本、从不碰真文件」纪律，见文件顶部 mutation 注释）。
      const mkMut235 = (name, ...pairs) => {
        let body = SRC;
        for (const [re, to] of pairs) body = body.replace(re, () => to);
        const p = path.join(TMP, name);
        fs.writeFileSync(p, body, "utf8");
        return p;
      };
      const ODD_HOME = path.join(TMP, "odd-8.3-home", "Ad+min,istra[tor]");
      // **真界那条对照要 realpath 真解得开**——不落盘的话 `.claude/settings.json` 是 ENOENT，
      // ENOENT 算「试过了」不算「压根没轮到」（相③ 刻意不碰这一格，见 `g2ShortExpand` 头注），
      // 那样"真界"那条量的就不是「realpath 分得开」而是巧合落进了别的分支。
      fs.mkdirSync(path.join(ODD_HOME, ".claude"), { recursive: true });
      fs.writeFileSync(path.join(ODD_HOME, ".claude", "settings.json"), "{}", "utf8");
      const ODD_SHORT = shortNameOf(ODD_HOME);
      check("#235 前置·含 8.3 非法字符的目录名算得出真短名（不然下面测的不是这一格）",
        !!ODD_SHORT, `short=${ODD_SHORT}`);
      if (ODD_SHORT) {
        const m1ms = mkMut235("mutant-235-oddchar-1ms.js",
          [/const G2_CAND_REALPATH_MS = 800;/, "const G2_CAND_REALPATH_MS = 1;"]);
        const oddPay = ps(`Copy-Item src.json "${ODD_SHORT}\\.claude\\settings.json" -Force`);
        const oddEnv = { USERPROFILE: ODD_HOME };
        check("#235 正控·非法字符短名 + 界 1 ms（realpath 验不成，只能靠相③ 反推）⇒ 仍 exit 2",
          gate(oddPay, { env: oddEnv, script: m1ms }).code === 2,
          `code=${gate(oddPay, { env: oddEnv, script: m1ms }).code}`);
        check("#235 负控·同一 fixture 在真界下也 exit 2（realpath 真解得开，不靠相③也该拦）",
          gate(oddPay, { env: oddEnv }).code === 2,
          `code=${gate(oddPay, { env: oddEnv }).code}`);
        check("#235 判别力·旧版逻辑（只去空格、不替换非法字符）对同一 fixture **展不开**" +
              "（由 2 翻 0，坐实这一档确实是本批修的）",
          gate(oddPay, { env: oddEnv, script: mkMut235("mutant-235-oddchar-revert.js",
            [/const G2_CAND_REALPATH_MS = 800;/, "const G2_CAND_REALPATH_MS = 1;"],
            [/const s = String\(l \|\| ""\)\.replace\(\/\\s\+\/g, ""\)\.replace\(\/\[\+,;=\[\\\]\]\/g, "_"\);/,
              'const s = String(l || "").replace(/\\s+/g, "");']) }).code === 0);
      }
    }

    // ⑤ 🔴 **相③ 的误伤面（它是过近似，代价必须有断言量着）**
    // ⚠️ **语料来源照直标（`#官抗-语料非自证` 负控那半）**：前两条是**真实形态** ——
    //   scratchpad 一律走 `C:\Users\ADMINI~1\AppData\Local\Temp\…`（真语料 27365 条里含 `~N`
    //   的 1196 条几乎全长这样），项目级 `.claude/settings.json` 是工具链日常在写的那条路；
    //   后两条**是本轮自造的诱饵**，只证明「我的诱饵不会被误伤」。
    {
      const deep = path.join(SHORT_HOME, "AppData", "Local", "Temp", "someproj", ".claude", "settings.json");
      for (const [nm, pay] of [
        ["真实形态·scratchpad 深处的**项目级** `.claude/settings.json`（段数与 live 对不上）",
          edit(deep)],
        ["真实形态·scratchpad 深处项目级，走 shell 分支", ps(`Copy-Item src.json "${deep}" -Force`)],
        ["自造诱饵·前 6 字符**不同**的另一个用户目录短名（`GUESTX~1`）",
          ps(`Copy-Item src.json "C:\\Users\\GUESTX~1\\.claude\\settings.json" -Force`)],
        ["自造诱饵·扩展名前 3 位对不上的短名（`SETTIN~1.TXT`）",
          ps(`Copy-Item src.json "${SHORT_HOME}\\.claude\\SETTIN~1.TXT" -Force`)],
      ]) {
        const c = gate(pay, { env: asLong }).code;
        check(`🔴#214 负控·${nm} → exit 0（不许误伤）`, c === 0, `code=${c}`);
      }
      // 🔴 **代价那一半照直写**：前 6 字符**相同**的另一个短名（`ADMINI~2` 之类）在 realpath
      //    验不成时**会被相③ 当成 live 拦下**。这不是缺陷、是过近似的定义，但它得有断言量着，
      //    免得哪天有人以为「相③ 零误伤」。判据：真界下它 exit 0（realpath 分得开），
      //    界坏掉时 exit 2（相③ 分不开）——**两态都断言，才说得清代价究竟落在哪一格**。
      const twin = ps(`Copy-Item src.json "${SHORT_HOME.replace(/~1$/i, "~9")}\\.claude\\settings.json" -Force`);
      if (/~1$/i.test(SHORT_HOME)) {
        check("#214 代价·前 6 字符相同的另一个短名（`…~9`）在**真界**下 exit 0（realpath 分得开）",
          gate(twin, { env: asLong }).code === 0, `code=${gate(twin, { env: asLong }).code}`);
        const c2 = gate(twin, { env: asLong, script: path.join(TMP, "mutant-214-1ms-only.js") }).code;
        check("🔴#214 代价·同一条在界坏掉时 **exit 2** —— 相③ 是过近似，这一格是它的已知误伤面" +
              "（换来的是 ⑱ 那条回归带闭合；逃生阀仍在用户手里）",
          c2 === 2, `code=${c2}`);
      }
    }
  }

  // ── 调用点覆盖率（`#官抗-调用点覆盖率`）────────────────────────────────────
  // 数的是**剥掉注释后**的代码引用（见上方那条自指注释：含注释数会把「在讨论它」算成「在用它」）。
  {
    console.log(`  （调用点覆盖率）本批新增/改签名的判据，代码引用数（含定义）：` +
      `g2RealpathBounded ${refs("g2RealpathBounded")} · g2RealpathBatch ${refs("g2RealpathBatch")} · ` +
      `g2Phases ${refs("g2Phases")} · g2TailCouldBeLive ${refs("g2TailCouldBeLive")} · ` +
      `g2BaseCouldBeLive ${refs("g2BaseCouldBeLive")} · g2ResolvePre ${refs("g2ResolvePre")} · ` +
      `g2ShortExpand ${refs("g2ShortExpand")} · g2CompCouldBe ${refs("g2CompCouldBe")} · ` +
      `g2Starved ${refs("g2Starved")} · ` +
      `G2_RP_CHILD ${refs("G2_RP_CHILD")} · G2_RP_BATCH_CHILD ${refs("G2_RP_BATCH_CHILD")}。` +
      `**端到端覆盖**：g2RealpathBounded 生产调用点 1/1（常量侧，上面五组逐个走到）· ` +
      `g2RealpathBatch 1/1（相②，由「候选经 junction」那一格走到）· ` +
      `g2Phases **2/2**（Edit 分支由 ⑰ 负控里那条 \`edit(...)\` 走到、shell 分支由本节几乎每条正控走到` +
      ` —— 这两个调用点是 G2 仅有的两个判定入口，缺一个就是半道闸没接上）· ` +
      `g2ResolvePre 2/2（g2Resolve 那条由 Edit/shell 正控走到，destRaws 那个循环由 ` +
      `\`-Destination <目录>\` 正控走到）· g2TailCouldBeLive 1/1（唯一调用点在 g2Canon，` +
      `正反两支都有专属样本：`+"`f.md` 诱饵走「不像」那支、`settings.json` 诱饵走「像」那支）· " +
      `g2BaseCouldBeLive 2/2（g2TailCouldBeLive 内一处、g2WriteTargets 的 basename 展开一处）· ` +
      `**g2ShortExpand 3/3**（相③ 预判循环 · 直判分支 · 重跑 judge 那条 \`rp\` —— ` +
      `前两条由 #214 那组走到；**第三条「目标目录形态」只由合成样本走到**，照直标）· ` +
      `g2CompCouldBe 2/2（g2ShortExpand 里目录段一处、末段一处）· ` +
      `g2Starved 1/1（饿死 fail-close，由 #214 那组的 N>阈值 正控走到）。` +
      `**未覆盖 0 个** —— 但这句话说的是「被走到了」，不是「守住了」。`);
    // 🔴 **一条结构断言守着上面那句话别变成散文**（`#官抗-调用点覆盖率`：分母不能是手写死的）：
    //   这几个函数名，只要有一个在代码里消失（改名 / 删除 / 被 inline 掉），
    //   上面整段覆盖率叙述即刻失效 —— 那时这条会红并点名，逼人回来改它。
    //   ⚠ 2026-08-09（#214）：`g2TwoPhase` 已改名 `g2Phases`（它跑三相了），本条当场红过一次。
    check("#199/#214 覆盖率叙述的前提·这几个判据函数都还在代码里（改名即失效，逼人同批更新上面那段）",
      refs("g2RealpathBatch") >= 2 && refs("g2Phases") >= 3 && refs("g2TailCouldBeLive") >= 2 &&
      refs("g2ShortExpand") >= 2 && refs("g2Starved") >= 2,
      `batch=${refs("g2RealpathBatch")} phases=${refs("g2Phases")} tail=${refs("g2TailCouldBeLive")} ` +
      `expand=${refs("g2ShortExpand")} starved=${refs("g2Starved")}`);
  }

  check("真 hook 文件在本节全部 mutation 之后仍逐字节未改", sha(HOOK) === PRISTINE_SHA);
}

console.log("\n──── G3 · 对外发布（⑤自主边界：不可逆 + 需用户在场）────");
{
  const positives = [
    "npm publish --access public",
    "pnpm publish",
    "yarn publish",
    "cargo publish",
    "gh release create v1.2.3 --notes x",
    "gh release delete v1.0.0",
    "cd /d/frank/mousse-cli && npm publish",
    "VERSION=1.2.3 cargo publish",
  ];
  for (const c of positives) {
    const r = gate(bash(c));
    check(`正控：${c} → exit 2`, r.code === 2, `code=${r.code} ${r.err.slice(0, 80)}`);
  }
  check("正控：stderr 给得出三条合法路径（说明+dry-run+用户设 env）",
    /--dry-run/.test(gate(bash("npm publish")).err) && /DAO_PUBLISH_APPROVED/.test(gate(bash("npm publish")).err));
  check("正控：PowerShell 工具同样受管", gate({ tool_name: "PowerShell", tool_input: { command: "cargo publish" } }).code === 2);
  check("逃生阀：DAO_PUBLISH_APPROVED=1 → 放行",
    gate(CANARY["G3-publish"], { env: { DAO_PUBLISH_APPROVED: "1" } }).code === 0);

  const negatives = [
    ["--dry-run 是真演练，放行", "npm publish --dry-run"],
    ["cargo publish --dry-run 放行", "cargo publish --dry-run"],
    ["gh release list 只读，放行", "gh release list"],
    ["gh release view 只读，放行", "gh release view v1.0.0"],
    ["npm run build 放行", "npm run build"],
    ["npm install 放行", "npm install"],
    ["带 publish 字样但不是发布命令，放行", "node scripts/publish-notes.mjs"],
    ["字符串字面量里的命令，放行（段首不是它）", 'echo "npm publish"'],
    ["git push 归乙类软提醒，本闸放行", "git push origin main"],
  ];
  for (const [name, c] of negatives) check(`负控：${name}`, gate(bash(c)).code === 0, `code=${gate(bash(c)).code}`);
}

console.log("\n──── G4 · 浏览器 MCP 截图落盘路径（无逃生阀，正路只是换路径）────");
{
  const positives = [
    ["chrome-devtools 落项目根", { tool_name: "mcp__chrome-devtools__take_screenshot", tool_input: { filePath: "D:/frank/mousse-cli/shot.png" } }],
    ["playwright 落 _tmp 但不在 qa 下", { tool_name: "mcp__playwright__browser_take_screenshot", tool_input: { filename: "_tmp/shot.png" } }],
    ["落系统 temp", { tool_name: "mcp__playwright__browser_take_screenshot", tool_input: { filename: "C:/Users/x/AppData/Local/Temp/a.png" } }],
    ["反斜杠路径", { tool_name: "mcp__chrome-devtools__take_screenshot", tool_input: { filePath: "D:\\frank\\mousse-cli\\qa\\a.png" } }],
  ];
  for (const [name, p] of positives) {
    const r = gate(p);
    check(`正控：${name} → exit 2`, r.code === 2, `code=${r.code}`);
  }
  check("正控：stderr 给得出规范路径形态", /_tmp\/qa\/<context>/.test(gate(positives[0][1]).err));
  check("无逃生阀：设满 env 仍拦",
    gate(positives[0][1], { env: { DAO_SETTINGS_EDIT_APPROVED: "1", DAO_PUBLISH_APPROVED: "1", DAO_ALLOW_READONLY_TODO: "1" } }).code === 2);

  const negatives = [
    ["不给路径=内联返回不落盘，放行", { tool_name: "mcp__chrome-devtools__take_screenshot", tool_input: { fullPage: true } }],
    ["绝对路径落 _tmp/qa 下，放行", { tool_name: "mcp__chrome-devtools__take_screenshot", tool_input: { filePath: "D:/frank/mousse-cli/_tmp/qa/pr-1/a.png" } }],
    ["相对路径落 _tmp/qa 下，放行", { tool_name: "mcp__playwright__browser_take_screenshot", tool_input: { filename: "_tmp/qa/run/a.png" } }],
    ["反斜杠的 _tmp\\qa 也认，放行", { tool_name: "mcp__playwright__browser_take_screenshot", tool_input: { filename: "D:\\repo\\_tmp\\qa\\c\\a.png" } }],
    ["非截图工具带路径，放行", { tool_name: "mcp__playwright__browser_navigate", tool_input: { filename: "x.png" } }],
  ];
  for (const [name, p] of negatives) check(`负控：${name}`, gate(p).code === 0, `code=${gate(p).code}`);
}

console.log("\n──── G5 · 只读载体未勾待办（PR body / commit message）────");
{
  const bodyFile = path.join(TMP, "pr-body.md");
  fs.writeFileSync(bodyFile, "## 为什么改\n修了个洞。\n\n## 合并前自检\n- [ ] 验证跑了且过了\n", "utf8");
  const cleanFile = path.join(TMP, "pr-body-clean.md");
  fs.writeFileSync(cleanFile, "## 为什么改\n修了个洞。\n\n- [x] 验证跑了且过了（exit 0）\n", "utf8");

  const positives = [
    ["gh pr create 内联 body 含未勾框", bash('gh pr create --title x --body "- [ ] 还没跑"')],
    ["gh pr edit 内联 body 含未勾框", bash('gh pr edit 42 --body "- [ ] 待补"')],
    ["gh pr create --body-file 指向含未勾框的文件", bash(`gh pr create --title x --body-file ${bodyFile}`, TMP)],
    ["git commit -m 含未勾框", bash('git commit -m "[cc] feat: x\n- [ ] 随后补测试"')],
  ];
  for (const [name, p] of positives) {
    const r = gate(p);
    check(`正控：${name} → exit 2`, r.code === 2, `code=${r.code} ${r.err.slice(0, 80)}`);
    check(`正控：${name} stderr 给得出三选一`, /- \[x\]/.test(r.err) && /可编辑/.test(r.err), r.err.slice(0, 160));
  }
  check("正控：--body-file 用相对路径 + cwd 也能读到",
    gate(bash("gh pr create --title x --body-file pr-body.md", TMP)).code === 2);
  check("逃生阀：DAO_ALLOW_READONLY_TODO=1 → 放行",
    gate(CANARY["G5-readonly-todo"], { env: { DAO_ALLOW_READONLY_TODO: "1" } }).code === 0);

  const negatives = [
    ["已勾的 - [x] 是陈述过去，放行", bash('gh pr create --body "- [x] 跑过了"')],
    ["gh issue create 是可编辑载体，放行", bash('gh issue create --title x --body "- [ ] 待办"')],
    ["gh pr comment 不在本条射程内，放行", bash('gh pr comment 42 --body "- [ ] x"')],
    ["gh pr view 只读，放行", bash("gh pr view 42 --json body")],
    ["--body-file 指向干净文件，放行", bash(`gh pr create --title x --body-file ${cleanFile}`, TMP)],
    ["--body-file 指向不存在的文件 → 放行（明写的漏报面，不是洞）",
      bash("gh pr create --title x --body-file /nope/nothing.md", TMP)],
    ["普通 commit 无待办框，放行", bash('git commit -m "[cc] fix: 修一个 off-by-one"')],
    ["正文里出现减号但不是待办框，放行", bash('git commit -m "[cc] docs: a - b [ok]"')],
    // ↓ 这三条是「检查器把自己数进扫描面」的负控：讨论**本条规则**的正文必然引用那个记号，
    //   裸匹配会让每一份解释本闸的 PR body 都被本闸拦下（本批首稿实测命中）。
    ["散文里反引号引用该记号，放行（否则解释本规则的 PR 永远发不出去）",
      bash('gh pr create --title x --body "本闸拦的是只读载体里的 `- [ ]`，`- [x]` 放行"')],
    ["中文句子中间提到该记号，放行", bash('git commit -m "[cc] feat(gates): 拦未勾的 - [ ] 记号"')],
    ["--body-file 正文里只是引用该记号，放行",
      bash(`gh pr create --title x --body-file ${path.join(TMP, "pr-body-prose.md")}`, TMP)],
  ];
  fs.writeFileSync(path.join(TMP, "pr-body-prose.md"),
    "## 改了什么\n新闸拦的是只读载体里的 `- [ ]` 记号（`- [x]` 放行）。\n", "utf8");
  for (const [name, p] of negatives) check(`负控：${name}`, gate(p).code === 0, `code=${gate(p).code} ${gate(p).err.slice(0, 80)}`);
}

console.log("\n──── G6 · 心跳 prompt 缺 [dao-heartbeat] 签名（stop:true 豁免）────");
{
  // 正控语料**全部取自真实历史形态**（~/.claude/projects/**/*.jsonl 全量普查，2026-08-02，
  // 993 次 ScheduleWakeup tool_use）。这不是形式主义：dispatch-clauses 对抗验证官节明写
  // 「近似手段的验证语料禁只来自本轮发现的形态」——自造语料只能证明「我想到的那几种被拦住了」。
  const positives = [
    ["最常见的真实形态（占语料首位）", wake({ delaySeconds: 1500, prompt: "高性能自主窗心跳。第一动作：回看上一轮是否真有面向用户的最终文本发出……" })],
    ["带方括号但不是签名（真实形态，易被误以为已签）", wake({ delaySeconds: 900, prompt: "【8h 高性能自主窗 · 心跳】第一动作：回看上一轮……" })],
    ["签名不在开头 ⇒ 不算签名（rhythm 那边也认不出）", wake({ delaySeconds: 900, prompt: "对账：① 两路在途 [dao-heartbeat]" })],
    ["大小写不符 ⇒ 不算（两边判据都大小写敏感）", wake({ delaySeconds: 900, prompt: "[DAO-HEARTBEAT] 心跳" })],
    ["空 prompt 且无 stop ⇒ 无从签名也无从对账", wake({ delaySeconds: 900, prompt: "" })],
    ["既无 prompt 也无 stop", wake({ delaySeconds: 900 })],
    ["stop 是字符串 'true' 不算豁免（免得成为 agent 够得着的旁路）", wake({ stop: "true", prompt: "心跳" })],
    ["stop:false 显式继续，仍要签名", wake({ stop: false, delaySeconds: 900, prompt: "心跳" })],
  ];
  for (const [name, p] of positives) {
    const r = gate(p);
    check(`正控：${name} → exit 2`, r.code === 2, `code=${r.code} ${r.err.slice(0, 80)}`);
  }
  const errText = gate(CANARY["G6-heartbeat-signature"]).err;
  check("正控：stderr 教得出**可直接照抄**的格式（含前缀本身 + 一个完整示例）",
    /\[dao-heartbeat\]/.test(errText) && /例如/.test(errText), errText.slice(0, 200));
  check("正控：stderr 说明它为什么不是装饰（指向 dao-rhythm 与留守四句的投递）",
    /dao-rhythm/.test(errText) && /dao-longwindow/.test(errText), errText.slice(0, 300));
  check("正控：stderr 点明 stop:true 是收窗的正路、不是绕签名的后门",
    /stop:true/.test(errText) && /别拿它绕开签名/.test(errText), errText.slice(0, 400));
  check("逃生阀：DAO_WAKEUP_UNSIGNED_OK=1 → 放行",
    gate(CANARY["G6-heartbeat-signature"], { env: { DAO_WAKEUP_UNSIGNED_OK: "1" } }).code === 0);
  check("逃生阀只认 '1'，不认 'true'",
    gate(CANARY["G6-heartbeat-signature"], { env: { DAO_WAKEUP_UNSIGNED_OK: "true" } }).code === 2);

  const negatives = [
    ["签名开头 → 放行", wake({ delaySeconds: 1500, prompt: "[dao-heartbeat] 高性能目标窗心跳。对账：①……" })],
    ["签名前有空白（两边都先 trim）→ 放行", wake({ delaySeconds: 900, prompt: "  \n[dao-heartbeat] 心跳" })],
    ["签名后紧跟内容无空格 → 放行（判据只管前缀）", wake({ delaySeconds: 900, prompt: "[dao-heartbeat]对账" })],
    ["只有签名没有正文 → 放行（内容够不够是人的判断，不是闸的）", wake({ prompt: "[dao-heartbeat]" })],
    ["stop:true 收窗 → 放行", wake({ stop: true })],
    ["stop:true 且带 prompt → 放行（仍是收窗调用）", wake({ stop: true, prompt: "收窗" })],
    ["别的工具带同名 prompt 参数 → 放行（本闸只认 ScheduleWakeup）",
      { tool_name: "Task", tool_input: { prompt: "高性能目标窗心跳" } }],
    ["工具名含 ScheduleWakeup 子串但不相等 → 放行（早退用全等，不用正则）",
      { tool_name: "mcp__x__ScheduleWakeupLater", tool_input: { prompt: "心跳" } }],
    ["Bash 里出现 [dao-heartbeat] 字样 → 放行（不是这道闸的事）",
      bash('echo "[dao-heartbeat] 心跳"')],
  ];
  for (const [name, p] of negatives) check(`负控：${name}`, gate(p).code === 0, `code=${gate(p).code} ${gate(p).err.slice(0, 80)}`);
}

console.log("\n──── 乙类 · dao-tool-nudge 直推主干分支（提醒不阻断，两态）────");
{
  const positives = [
    ["git push origin main", "git push origin main"],
    ["git push origin master", "git push origin master"],
    ["git push -u origin main", "git push -u origin main"],
    ["git push origin HEAD:main", "git push origin HEAD:main"],
    ["git push --force origin main", "git push --force origin main"],
    ["在 && 链后一段", "npm test && git push origin main"],
  ];
  for (const [name, c] of positives) {
    const ctx = nudge(c);
    check(`正控：${name} → 注入 PR-first 提醒`,
      /dao PR-first/.test(ctx) && /dao-pr-merge\.ps1/.test(ctx), JSON.stringify(ctx.slice(0, 80)));
  }
  check("正控：提醒里说明它是默认节律不是禁令（免得被读成硬闸）",
    /非禁令|默认节律/.test(nudge("git push origin main")));

  const negatives = [
    ["推特性分支不该提醒", "git push origin feat/x"],
    ["裸 git push 刻意不认（目标分支看不见）", "git push"],
    ["git push -u origin feature 不该提醒", "git push -u origin feature/abc"],
    ["删远程分支不是直推，不该提醒", "git push origin --delete main"],
    ["git pull 不该提醒", "git pull origin main"],
    ["字面量里的命令不该提醒", 'echo "git push origin main"'],
    ["分支名里含 main 但不是 main，不该提醒", "git push origin domain-fix"],
  ];
  for (const [name, c] of negatives) {
    check(`负控：${name}`, !/dao PR-first/.test(nudge(c)), JSON.stringify(nudge(c).slice(0, 80)));
  }
  // ⚠ 这一处原先是**第二个** spawnSync 出口（不带 cwd）—— issue #129 单子上只记了 `nudge()`
  //   那一个，这一个是「那个没被列进单子的孪生兄弟」。
  //   ⇒ 改用 `nudgeRaw()` 走同一条沙箱路径：**同型的东西只留一个出口**，
  //   否则下次再有人收口 `nudge()`，这一处照旧从射程外溜过去（本仓反复记的那个形态）。
  check("乙类只提醒不阻断：nudge hook 恒 exit 0", nudgeRaw("git push origin main").status === 0);

  // ── issue #129 的关闭条件，做成自失效断言 ────────────────────────────────
  // 「跑完这套之后真仓 `_tmp/` 无改动」不能靠人事后去看一眼 —— 那正是无标记时刻的自由裁量。
  // 这里把它变成一条会红的断言：往沙箱里放 canary，跑一轮 nudge，再看它动没动。
  //
  // 🔴 **基线为什么必须另起一个一次性沙箱（issue #157，PR #156 对抗验证带账）**：
  //   原先 `before` 取自 `NUDGE_SANDBOX`，而**本文件到这一行为止已经跑过 22 次 nudge**
  //   ⇒ hook **首次调用**就会创建的东西（去重表 `SEEN_FILE` 是最典型的那个）在基线快照
  //   那一刻**已经躺在里面了**，于是它同时出现在 `before` 与 `after` 两侧 ⇒ 断言恒绿。
  //   对抗官实测：把 nudge 换成会写盘的替身，替身写下的 marker 两侧都有，**478 条全绿**。
  //   **这条断言在自己标题里点名要守的那样东西（去重表），正是它结构上守不到的。**
  //   而下面「判别力·沙箱本身可写」那条探针**抓不到这个病**：它的写入发生在 `before`
  //   **之后**，证的是「基线之后的新增看得见」，证不了「基线取得够早」——
  //   **它验的是仪器，不是基线**（官侧条款 `#官抗-基线是活的`：假基线比没有基线更危险，
  //   因为它看起来有数据支撑）。
  // ⇒ 本组改用**一次性新沙箱**，基线取在**这个沙箱的第 0 次调用**。
  //   为什么不是「把基线提到文件顶上取一次就完了」：那样基线的正确性就取决于**语句顺序**，
  //   而顺序是下一个人随手就会改的东西 —— **顺序型正确性是这个病的来源，不是它的解药**。
  {
    const SB = path.join(TMP, "nudge-closure-sandbox");
    fs.rmSync(SB, { recursive: true, force: true });
    const canary = path.join(SB, "_tmp", "dump", "canary.js");
    fs.mkdirSync(path.dirname(canary), { recursive: true });
    fs.writeFileSync(canary, "// CANARY_ORIGINAL\n", "utf8");
    // ⬇ 这一行之前，SB 上一次 nudge 都没跑过。**这才是 #157 要的那个基线时刻。**
    // 🔴 **这个「基线时刻」此前没有任何断言在守**（issue #163 第 3 笔，PR #161 对抗官 `157-E`）：
    //   把下面那条基线语句挪回 4 次调用**之后**（等于把 #157 的修复原样撤销），全套 488 条
    //   **一条没红**。⇒ 顺序依赖并没有消失，只是从「文件级 22 次调用」缩到了「局部 4 行」，
    //   而那 4 行照样是下一个人随手就会挪动的东西。
    // ⚠ **判据为什么不是「取基线时去重表还不存在」**（#163 单子上给的是那一版，实测后改的）：
    //   本块 4 次调用喂的**全是 `Bash`**，而 `dao-tool-nudge.js` 只在**浏览器 MCP** 那一支
    //   写去重表（`SEEN_FILE`，见该文件 ④ 那一节）⇒ 那张表在本块里**从头到尾就没出现过**。
    //   实测：4 次 Bash 调用前后 `readdirSync(SB)` 都是 `[_tmp]`，喂一次 MCP 工具名才变成
    //   `[_tmp,tool-nudge-seen.json]`。**「它不在 before 里」因此是一条零样本恒真断言** ——
    //   基线挪不挪它都绿，钉不住 `157-E`（`dao-guard-writing`：**数到 0 和没看到样本，输出一模一样**）。
    // ⇒ 改钉**结构性质**：取基线那一刻，这个沙箱一次 nudge 都还没跑过。
    // 🔑 **见证量必须与基线由同一条语句产出**：这样「把基线挪到调用之后」就一并把见证量挪了
    //   过去，差额当场变成一个可读的数字。**别把这两半拆开写**——拆开＝见证量留在原地、基线
    //   自己走掉，守护当场失效，**而全绿输出与现在逐字节相同**。
    const callsAtEntry = NUDGE_RAW_CALLS;          // 入块时的累计（这之后本块才开始喂 hook）
    let baselineCalls = -1;
    const before = (baselineCalls = NUDGE_RAW_CALLS, fs.readdirSync(SB).sort().join(","));
    for (const c of ["git push origin main", "pnpm dev", "npm run dev", "git push origin feat/x"]) {
      nudgeRaw(c, "Bash", { sandbox: SB });
    }
    check("#129·nudge 走沙箱 cwd 之后，沙箱里的 canary 逐字节没动",
      fs.readFileSync(canary, "utf8") === "// CANARY_ORIGINAL\n");
    check("#129·并且沙箱顶层没有凭空多出文件（基线取在本沙箱第 0 次调用，见 #157）",
      fs.readdirSync(SB).sort().join(",") === before,
      `before=${before} after=${fs.readdirSync(SB).sort().join(",")}`);
    // ⬆ 上面那条的**前提**：`before` 必须真的取在第 0 次调用。这条钉的就是那个前提。
    //   它与上面那条是一对：上面验「基线之后没多出东西」，这条验「基线本身取得够早」——
    //   **缺了它，「我把基线提早了」与「我什么也没做」在全绿输出里长得一模一样**（#157 原病）。
    check("#157·基线取在本沙箱第 0 次调用（取基线那一刻这个沙箱一次 nudge 都没跑过）",
      baselineCalls === callsAtEntry,
      `入块时 nudgeRaw 累计=${callsAtEntry}，取基线时=${baselineCalls}`
      + "（两者不等 ⇒ 基线取晚了，#157 那个病回来了）");
    // 判别力①（既有，保留）：这两条断言不是恒真的 —— 拿一个**真会写盘**的形态证明沙箱
    // 确实是可被写脏的。没有这一条，上面两条与「hook 压根没跑」在全绿输出里长得一模一样。
    fs.writeFileSync(path.join(SB, "probe-writable.txt"), "x", "utf8");
    check("判别力·沙箱本身是可写的（否则上面两条是恒真的废话）",
      fs.readdirSync(SB).sort().join(",") !== before);
    fs.rmSync(path.join(SB, "probe-writable.txt"), { force: true });
  }

  // ── 判别力②·#157 专项：**首次调用即写盘**的东西，早基线抓得到、晚基线抓不到 ──────
  // 上一条「沙箱可写」证的是**仪器**；这一条证的是**基线时刻**本身 —— 两件事，缺一不可。
  // 🔑 用的不是替身，是**真 hook 的真写盘路**：喂一个浏览器 MCP 工具名，hook 会在
  //   **本会话首次调用**时把去重表写进 `DAO_TOOL_NUDGE_STATE` 指的那个文件
  //   （`ccswitch/hooks/dao-tool-nudge.js` 的 ④ 那一支）。拿真路而不是拿替身，
  //   省掉「替身与真 hook 会不会漂移」这一整类问题。
  // 两条断言是一对：
  //   ㈠ 早基线（第 0 次调用时取）**看得见**那次写盘 ⇒ 这个仪器确实有判别力
  //   ㈡ 晚基线（第 1 次调用之后取）里**已经含着**那次写盘的产物 ⇒ 拿它当基线的比对
  //      对同一次写盘结构上失明 —— **这就是 #157 那个病，在这里当场复现一次**
  // 🔴 **㈡ 不是"顺便"**：没有它，「我把基线提早了」与「我什么也没改」在全绿输出里一样。
  {
    const SB = path.join(TMP, "nudge-firstcall-probe");
    fs.rmSync(SB, { recursive: true, force: true });
    fs.mkdirSync(SB, { recursive: true });
    const state = path.join(SB, "tool-nudge-seen.json");
    const early = fs.readdirSync(SB).sort().join(",");        // 第 0 次调用时的基线
    nudgeRaw("", "mcp__playwright__browser_navigate",
      { sandbox: SB, state, sessionId: "adv157-probe-" + process.pid + "-" + Date.now() });
    const late = fs.readdirSync(SB).sort().join(",");         // 「已经跑过一轮」之后的基线
    check("判别力·#157 ㈠ 早基线看得见 hook 首次调用写下的去重表",
      late !== early && fs.existsSync(state), `early=[${early}] late=[${late}]`);
    check("判别力·#157 ㈡ 晚基线里已经含着那次写盘的产物 ⇒ 拿它比对必然恒绿（本单要修的病）",
      late.split(",").includes("tool-nudge-seen.json") &&
      !early.split(",").includes("tool-nudge-seen.json"),
      `early=[${early}] late=[${late}]`);
    // 补一刀：从**晚基线**看过去，后续调用"什么也没发生" —— 那次写盘已被算进基线里了。
    for (const c of ["git push origin main", "pnpm dev"]) nudgeRaw(c, "Bash", { sandbox: SB, state });
    check("判别力·#157 ㈢ 晚基线之后再跑几轮，比对仍报「无变化」（失明是结构性的，不是偶然）",
      fs.readdirSync(SB).sort().join(",") === late,
      `late=[${late}] now=[${fs.readdirSync(SB).sort().join(",")}]`);
    fs.rmSync(SB, { recursive: true, force: true });
  }

  // ── #129·防复发：本文件喂 nudge hook 的出口必须**只有一个** ─────────────────
  // 🔴 **这一条治的不是 #129 那个 bug，是「#129 为什么没列到 twin」那个病。**
  //   那张单子上的三个实例，各是怎么被发现的：①官自己的探针被就地改写 ②红绿随目录翻
  //   ③种在 `_tmp/dump/` 的 canary 没了 + 台账里留了一行。
  //   **三个都是「有东西坏了」才进的名单** —— 那是一份**受害者名单**，不是一次普查。
  //   受害者名单结构上只列得出「已经造成危害的」，而 twin 恰恰是**当下造不成危害的那一种**：
  //   它只喂 `tool_name: "Bash"`，而 `dao-tool-nudge.js` 里唯一与 cwd 有关的那条路是只读的，
  //   写盘那条只在浏览器 MCP 工具名下走且锚在 hook 自己的仓根 ⇒ **不写盘、不翻红绿**。
  //   前一位官那两轮**行为普查**（正负控都自证过）因此对本文件报「零可疑」——
  //   **今天再跑一遍行为普查，还是会漏掉它。**
  // ⇒ 所以这里放的不是又一条行为断言，是一条**计数**断言：喂真 hook 的出口只能有一个。
  //   它盯的是「同一形态在同一文件里长出第二份」这个动作本身，与那一份有没有造成危害无关。
  // ⚠ **射程照直写**：只管**这一个文件**喂**这一个 hook**、且只管 `spawnSync` **这一个 API**
  //   （API 面是 issue #163 第 2 笔补进来的第三格，实测出处见下面漏报面 ③）。做成跨文件的闸
  //   需要先答「怎么机械识别一次 hook spawn」，#129 自己说了「没实测过误报率，不建议直接立闸」
  //   —— 本批照此**不立全局闸**。
  //
  // 🔴 **2026-08-06（issue #159）：判据从「数源码文本」换成「数真实 spawn」。**
  //   旧判据是一条正则（形如「`spawnSync(` + execPath + 方括号里那个常量名」）。
  //   PR #156 对抗官拿**本仓真实写法**跑了 7 条（逐条标了文件行号，不是合成的），**漏 6 条**：
  //     ① `[opts.script || NUDGE]`（tests/dao-tool-nudge.tests.js:54，本仓喂 hook 第二常见写法）
  //     ② `const args = [NUDGE]; …, args`（tests/dead-gates.tests.js:150-156）
  //     ③ 方括号里跟了第二个实参（`--selfcheck` 那种）
  //     ④ 脚本路径来自一个变量（喂副本的 mutation 写法）
  //     ⑤ 第二实参另起一行（**本文件 gate() 自己就是这个排版**）
  //     ⑥ `gate(payload, { script: NUDGE })` —— **`gate()` 就住在本文件里、就收 script 参数**，
  //        指向 NUDGE 即第二出口，而正则一个字都看不见（当前无此调用点，已核实）
  //   **「单文件内的写法就有 ≥7 种」这件事，正是 #129 那句「怎么机械识别一次 hook spawn，
  //   没实测过误报率」的实测答卷 —— 答案是：文本这条路走不通。**
  // ⇒ 换成**运行时恒等式**：模块顶部把 `child_process.spawnSync` 包一层，数「真 hook 这个
  //   文件被 spawn 了几次」，与 `nudgeRaw` 自己的调用次数对齐：
  //       真 hook 被 spawn 次数 === nudgeRaw 调用次数 + 探针显式登记的绕开次数
  //
  // **为什么是运行时而不是「把正则放宽」**（选型理由，本单要求写明）：
  //   ㈠ 正则数的是**文本**，而写法空间是开放的 —— 补一种写法只是把漏报面挪一格。
  //      本仓已经用 7 条真语料量到「单文件内 ≥7 种」，**补漏—再漏是结构性的**，
  //      而每补一次都要重做一次误报评估（官侧条款 `#官抗-语料非自证`：
  //      语料若由本轮发现的形态构造，只证得了「上一轮那些洞已补」）。
  //   ㈡ 运行时数的是**动作**：换行、变量、`||` 兜底、经由 `gate()` 转手 ——
  //      ~~写法与它无关，只要真的 spawn 了那个文件就会被数到。覆盖面不随代码风格变化。~~
  //      **同一个 API（`spawnSync`）下**写法与它无关：只要真的经 `spawnSync` 跑了那个文件
  //      就会被数到，覆盖面不随代码风格变化。**它关掉的是「实参形状」这个开放空间**
  //      （7 条真语料 7/7 实证），**没关掉「API」这个空间** —— 第二出口换成 `execFileSync`，
  //      恒等式两边都不动（issue #163 第 2 笔，对抗官 `159-D` 实测），见下面漏报面 ③。
  //      订正保留原句不删：那句话不是笔误，是**把一个近似手段说成了判定**
  //      （官侧条款 `#官通-禁笃定措辞`：近似手段两向都要给得出反例）。
  //   ㈢ **误报评估**（本单关闭条件点名要的那一格）：正则的误报面是「长得像但不是」——
  //      注释、测试数据、以及**描述它的那段散文**，这三层本文件**都真的被咬过**（记录见下）。
  //      运行时判据是「`path.resolve` 之后是不是同一个文件」⇒ 长得像但不是那个文件的东西
  //      一律不计，误报面塌缩到「那个文件真的被跑了」——**而那正是要数的东西本身**。
  //      下面有一条负控钉着这一格：喂 hook 的**同名副本**不计数。
  // ⚠ **它换来的漏报面，照直写**：运行时只看得见**真的被执行到**的 spawn。写在永不进入的
  //   分支里的第二出口，它数不到（旧正则倒是数得到 —— 如果写法恰好对得上那一种）。
  //   取这一边的理由：没被执行的出口在这一轮里弄不脏任何东西，而**执行了却看不见**
  //   （旧正则 6/7 的那一面）恰恰是会造成危害的那一半。**两边都不是零漏报，别读成升级即免疫。**
  // ⚠ 另一格射程：经由**探测替身**（下一节 #158 那个）跑起来的真 hook 是在**子进程的子进程**
  //   里 spawn 的，本进程的包装层看不见 —— 那一路两边都不计，恒等式因此仍然平衡。
  // ⚠ **③ API 面**（issue #163 第 2 笔补的第三格，PR #161 对抗官 `159-D` 实测）：包装层只
  //   patch 了 `child_process.spawnSync` 这**一个** API。把第二出口从 `spawnSync` 换成
  //   `execFileSync` ⇒ 恒等式两边都不动，**全套全绿**；同理隐形的还有 `execFile` / `spawn` /
  //   `exec` / `fork`，以及它们的 promisify 形态。**这一格与上面两格不同**：那两格漏的是
  //   「没被执行到」和「不在本进程里」，这一格漏的是**在本进程里真的执行了、也真的跑了那个
  //   文件，只是走了另一扇门**。
  //   **本批取「收窄措辞 + 记进本清单」而不是「扩覆盖面」**（帅裁走②）：扩覆盖面要重做一次
  //   误报评估，而本仓当前**所有**喂本 hook 的站点都是 `spawnSync`（对抗官扫全仓，零例外）
  //   ⇒ 这一格眼下是**纯理论面**。⚠ 但它是纯理论面这件事**没有任何东西在守**：哪天有人拿
  //   `execFile` 喂这个 hook，这道闸不会有半点动静，而上面 ㈡ 那句话会让读者以为它管得着。
  {
    // 🔴 **旧判据留下的三层自伤记录，随代码带走**（2026-08-05，PR #145 三轮对抗最值钱的产物）：
    //   **第一次** —— 判别力那一半原先把合成 twin 写成一个**整串字面量**，而那个字面量
    //   就住在本文件里 ⇒ 计数 2、合成后 3。**检查器的测试数据落进了它自己的扫描面。**
    //   **第二次** —— 改成运行时拼接之后仍然报 2。第二处命中是**那段注释本身**：
    //   解释这个坑的时候，把那个字面量**原样抄进了注释里**。同一条病的第三层形态 ——
    //   ①代码 ②测试数据 ③**描述它的那段散文**。前两层 `dao-guard-writing` 第三条写到了，
    //   第三层是那次现长出来的：注释不参与执行，所以人不会把它算进"扫描面"，
    //   **而正则不区分代码与注释。**
    //   ⚠ 它**是红出来的，不是想出来的**。若当初把判别力那一半省掉，剩下的「恰好 1 处」
    //   会安安静静地报 2，然后被当成"还有一处没收口"去找一个并不存在的 twin ——
    //   **一个把自己数进去的检查器，给出的错误方向是可信的那一种。**
    //   同批还留下一格：对抗官把那条正则换成一个**永不命中**的正则，**头牌反而 PASS 了** ——
    //   因为新正则匹配到了它自己那一行字面量，计数照样是 1。
    //   **真正在守的从来不是头牌，是判别力那几条。**
    //   ⇒ 换成运行时判据之后这三层**同时消失**（注释不参与执行，自然进不了扫描面）。
    //   但那个形态本身别忘：**任何"读自己源码"的守护都自带这三层。**

    // 主断言：到这一行为止，真 hook 的每一次 spawn 都经由 nudgeRaw。
    check("#129·防复发：真 hook 的每一次 spawn 都经由 nudgeRaw（运行时恒等式）",
      NUDGE_SPAWNS === NUDGE_RAW_CALLS + NUDGE_DECLARED_BYPASS,
      `spawns=${NUDGE_SPAWNS} nudgeRaw=${NUDGE_RAW_CALLS} 已登记绕开=${NUDGE_DECLARED_BYPASS}`);

    // 判别力①：一次**未登记**的绕开必须当场把恒等式打破。
    // 这里刻意用旧正则**看不见**的那个写法（方括号里跟第二个实参），一石二鸟。
    const s0 = NUDGE_SPAWNS, r0 = NUDGE_RAW_CALLS;
    spawnSync(process.execPath, [NUDGE, "--selfcheck"], { encoding: "utf8" });
    check("判别力·绕开 nudgeRaw 直接 spawn 真 hook ⇒ 恒等式当场失衡（旧正则对这个写法失明）",
      NUDGE_SPAWNS === s0 + 1 && NUDGE_RAW_CALLS === r0 &&
      NUDGE_SPAWNS !== NUDGE_RAW_CALLS + NUDGE_DECLARED_BYPASS,
      `spawns ${s0}→${NUDGE_SPAWNS}，nudgeRaw ${r0}→${NUDGE_RAW_CALLS}`);
    NUDGE_DECLARED_BYPASS += 1;   // 本次是探针刻意为之，登记后恒等式复衡

    // 判别力②·**7 条真语料逐条过计数器**。
    // 🔑 **语料非自证**：这 7 条逐字取自本仓真实 spawn 站点（出处行号写在每条标签里），
    //   不是照着本判据的实现造出来的 —— 官侧条款 `#官抗-语料非自证` 点名的就是这一格。
    //   旧正则对它们 1/7；下面这条断言要求 7/7。
    const corpus = [];
    const tally = (label, fn) => {
      const s = NUDGE_SPAWNS;
      fn();
      const d = NUDGE_SPAWNS - s;
      NUDGE_DECLARED_BYPASS += d;   // 语料探针都是刻意绕开，逐条登记，收尾恒等式才平得回来
      corpus.push([label, d]);
    };
    tally("① [opts.script || NUDGE]（出处 tests/dao-tool-nudge.tests.js:54）", () => {
      const opts = {};
      spawnSync(process.execPath, [opts.script || NUDGE], { input: "{}", encoding: "utf8" });
    });
    tally("② const args = [NUDGE]; …, args（出处 tests/dead-gates.tests.js:150-156）", () => {
      const args = [NUDGE];
      spawnSync(process.execPath, args, { input: "{}", encoding: "utf8" });
    });
    tally("③ 方括号里跟第二个实参（出处 本文件 --selfcheck 那一节的同形写法）", () => {
      spawnSync(process.execPath, [NUDGE, "--selfcheck"], { encoding: "utf8" });
    });
    // ⚠ ④ 的原出处那个变量装的是**副本**；这里把它绑成真 hook，验的是「路径来自一个变量」
    //   这个**写法**（那才是旧正则失明的原因）。副本本身刻意**不**计数，见下面那条负控。
    tally("④ 脚本路径来自一个变量（出处 喂 hook 副本的 mutation 写法）", () => {
      const script = NUDGE;
      spawnSync(process.execPath, [script], { input: "{}", encoding: "utf8" });
    });
    tally("⑤ 第二实参另起一行（出处 本文件 gate() 的排版）", () => {
      spawnSync(
        process.execPath,
        [NUDGE],
        { input: "{}", encoding: "utf8" });
    });
    tally("⑥ gate(payload, { script: NUDGE })（gate() 就住在本文件里、就收 script 参数）", () => {
      gate({ tool_name: "Bash", tool_input: { command: "echo hi" } }, { script: NUDGE });
    });
    tally("⑦ [NUDGE].concat(args || [])（7 条里旧正则唯一数得到的那一条，回归）", () => {
      const extra = null;
      spawnSync(process.execPath, [NUDGE].concat(extra || []), { input: "{}", encoding: "utf8" });
    });
    const counted = corpus.filter(([, d]) => d === 1).length;
    for (const [label, d] of corpus) if (d !== 1) console.log(`  （语料没被数到：${label} → Δ=${d}）`);
    check("#159·7 条真语料逐条过运行时计数器，7/7 被数到（旧正则 1/7）",
      counted === 7 && corpus.length === 7,
      corpus.map(([l, d]) => `${l.slice(0, 1)}Δ${d}`).join(" "));

    // 负控 · 射程边界与误报评估：喂 hook 的**同名副本**不该被数进来。
    // 这一条是上一条的**误伤反例**：判据是「resolve 之后是不是同一个文件」，不是「名字像不像」。
    // 副本刻意放进一棵**同构的假树**（`…/ccswitch/hooks/`）：hook 自己的 `ROOT` 是
    // `path.resolve(__dirname, "..", "..")` 算出来的，只有摆成同样深度，副本的 `ROOT` 才真的
    // 落在别处、去重表也就跟着落在别处 —— 那正是「它是另一码事（而且更安全）」这句话的依据。
    // ⚠ 摆在 `TMP` 顶层不行：那样 `ROOT` 恰好还是本仓根，上面这句话就成了一句没验过的断言。
    const twinDir = path.join(TMP, "copytree", "ccswitch", "hooks");
    fs.mkdirSync(twinDir, { recursive: true });
    const twinCopy = path.join(twinDir, "dao-tool-nudge.js");   // 同名、同内容、不同路径
    fs.copyFileSync(NUDGE, twinCopy);
    const s1 = NUDGE_SPAWNS;
    spawnSync(process.execPath, [twinCopy], { input: "{}", encoding: "utf8" });
    check("负控·同名不同路径的副本不计数（判据是同一个文件，不是名字像不像）",
      NUDGE_SPAWNS === s1, `Δ=${NUDGE_SPAWNS - s1}`);
  }

  // ── #129·那半个修复本身要有断言守着（PR #145 对抗验证官带账项）─────────────
  // 🔴 **对抗官把三条 mutation 打下来，511 条断言全绿零 FAIL**：摘掉 `spawnSync` 的 cwd /
  //   摘掉 payload 里的 cwd / 摘掉 `DAO_TOOL_NUDGE_STATE`，**回归网一声不响** ——
  //   把 #129 修的东西整个撤掉都没人知道。
  // **为什么那三条 canary 断言（canary 没动 / 沙箱顶层没多文件）挡不住**：cwd 被摘掉之后，
  //   脏东西落在**真仓**而不是沙箱里，而**没有任何断言在看真仓** —— 沙箱当然还是干净的。
  //   这是「零检出 ≠ 零存在」的又一形态：**断言看的地方，恰恰是脏东西离开的地方。**
  // ⇒ 补一组断言，直接钉住那三样东西还在。
  //   眼下 `dao-tool-nudge.js` 的 `_tmp/` 扫描面在 master 上还不存在，所以这不是在止血；
  //   它是纵深防御（PR #156 已订正：受益人**不是** #108 —— #108 对缺 cwd 是 fail-closed，
  //   且那条路读 payload、不用 `process.cwd()` 兜底，落地只会让缺 cwd 的站点不跑扫描）。
  //
  // 🔴 **2026-08-06（issue #158）：这组从「扫源码文本」换成「问 hook 实际收到了什么」。**
  //   上一版是三条**文本**断言（正则扫 `nudgeRaw` 函数体）。PR #156 对抗官拿 19 个变异体
  //   一跑，**6 发全绿**，而他的探测替身证明这 6 发**都真的改变了行为**：
  //     · st-comment（STATE 那行整个注释掉）        ⇒ env 变量 ABSENT
  //     · st-notconsumed（键被覆写成 undefined）    ⇒ env 变量 ABSENT
  //     · p-cwd-blockcomment（块注释包住，字面仍在）⇒ payload.cwd ABSENT
  //     · p-cwd-suffix（cwd 指向 …_ELSEWHERE，正则无尾边界）⇒ cwd 指向别处
  //     · s-cwd-dupkey（保留字面、其后补一个 `cwd: undefined`，后写者赢）
  //         ⇒ **process.cwd() 回到开发者真仓根 —— 正是 #129 要修的那个原病**，478 条一条没红
  //     · sandbox-redirect（只把沙箱这个名字指向别处）⇒ 三样全部离开沙箱
  //   **文本断言只对「移除字面」这一种改坏有效** —— 官侧条款 `#官抗-改坏多形态` 讲的正是
  //   这件事：改坏至少有 ①移除 ②保留字面但使其不执行 ③保留调用但结果不被消费 三向，
  //   **文本匹配型守护对 ② 天然失明**，而 `s-cwd-dupkey` 是 ③ 的教科书样本。
  // ⇒ 换成**行为级**：喂一个**探测替身**（它把实际收到的三元组记下来，再原样转调真 hook），
  //   断言 hook **实际收到**的 payload.cwd / process.cwd() / DAO_TOOL_NUDGE_STATE
  //   三样都指向沙箱。**正靶只换 `script` 一个参数、其余全走 `nudgeRaw` 的生产路径** ——
  //   这一点是承重的：换多了就变成"在验一条我另外搭的路"。
  {
    // 探测替身：只做两件事 —— 记下实际收到的三元组、原样转调真 hook（不扰动其余断言）。
    // 由本文件在运行期写出来、跑完随 TMP 一起删：不落进 tests/（那里的非 .tests.js 文件会被
    // run-tests 报成 stray），也不需要有人记得让「盘上的替身」与「本文件的期望」保持同步。
    const DETECT = path.join(TMP, "detect-nudge.js");
    const OBS = path.join(TMP, "detect-obs.json");
    fs.writeFileSync(DETECT, [
      '// 由 tests/hard-gates.tests.js 运行期生成（issue #158 行为级守护的探测替身）。',
      'const fs = require("fs"), { spawnSync } = require("child_process");',
      'let raw = ""; try { raw = fs.readFileSync(0, "utf8"); } catch (_) {}',
      'let input = {}; try { input = JSON.parse(raw || "{}"); } catch (_) {}',
      'fs.writeFileSync(process.env.DAO_NUDGE_OBS, JSON.stringify({',
      '  payloadCwd: input && input.cwd === undefined ? null : input.cwd,',
      '  processCwd: process.cwd(),',
      '  envState: process.env.DAO_TOOL_NUDGE_STATE === undefined ? null : process.env.DAO_TOOL_NUDGE_STATE,',
      '}), "utf8");',
      'const r = spawnSync(process.execPath, [process.env.DAO_NUDGE_REAL], { input: raw, encoding: "utf8" });',
      'if (r.stdout) process.stdout.write(r.stdout);',
      'if (r.stderr) process.stderr.write(r.stderr);',
      'process.exit(r.status == null ? 0 : r.status);',
    ].join("\n") + "\n", "utf8");
    const DETECT_ENV = { DAO_NUDGE_OBS: OBS, DAO_NUDGE_REAL: NUDGE };
    const readObs = () => { try { return JSON.parse(fs.readFileSync(OBS, "utf8")); } catch (_) { return null; } };

    // 判据只有一份，正靶与 6 个变异体共用。比的是**解析后的同一性**，不是字符串相等
    // （避免尾斜杠/大小写这类无关差异冒充"守护失效"）。
    const same = (a, b) => typeof a === "string" && typeof b === "string" && keyOf(a) === keyOf(b);
    const intoSandbox = (o) => !!o && same(o.payloadCwd, NUDGE_SANDBOX) &&
      same(o.processCwd, NUDGE_SANDBOX) && same(o.envState, NUDGE_STATE);

    // ── 正靶：**完全走生产路径**，只把 script 换成替身 ──────────────────────────
    fs.rmSync(OBS, { force: true });
    nudgeRaw("git push origin main", "Bash", { script: DETECT, extraEnv: DETECT_ENV });
    const real = readObs();
    check("#129·守护①（行为级）：hook 实际收到的 payload.cwd 指向沙箱",
      !!real && same(real.payloadCwd, NUDGE_SANDBOX), JSON.stringify(real));
    check("#129·守护②（行为级）：hook 进程的 process.cwd() 指向沙箱（spawnSync 的 cwd 真送到了）",
      !!real && same(real.processCwd, NUDGE_SANDBOX), JSON.stringify(real));
    check("#129·守护③（行为级）：hook 实际读到的 DAO_TOOL_NUDGE_STATE 指向沙箱里的去重表",
      !!real && same(real.envState, NUDGE_STATE), JSON.stringify(real));
    // 🔴 **守护⓪：一个不随名字走的锚** —— 上面三条拿 `NUDGE_SANDBOX` 当期望值，
    //   而对抗官的 `sandbox-redirect` 那一发改的**正是这个名字指向哪** ⇒ 期望值与实际值
    //   一起挪走，等式照样成立。**名 vs 值：拿被改的那个东西当尺子，量不出它被改了。**
    //   这一条改用一把**不会跟着挪**的尺子：`TMP` 由 `__dirname` 独立算出来，
    //   而 #129 要防的那件事本身就是「hook 别落在真仓的工作面上」。
    //   ⚠ 射程照直写：把沙箱重指到 `_tmp/hard-gates-tests/` **里面另一个目录**，这条不会红 ——
    //   那是**等价变异体**（仍然完全隔离，造不成 #129 那个危害），不是漏网。
    const underTmp = (p) => typeof p === "string" &&
      keyOf(p) !== null && keyOf(p).startsWith(keyOf(TMP) + path.sep);
    check("#129·守护⓪（锚不随名字走）：三样实际落点都在本测试的 _tmp 沙箱树下，且都不是真仓根",
      !!real && underTmp(real.payloadCwd) && underTmp(real.processCwd) && underTmp(real.envState) &&
      keyOf(real.processCwd) !== keyOf(REPO), JSON.stringify(real) + ` TMP=${TMP}`);
    // 🔴 **守护⓪ 那把尺子自己也得有人守**（issue #163 第 1 笔，PR #161 对抗官 `158-H` / `158-F`）：
    //   上面那条拿 `underTmp` 当尺子，而**尺子本身此前零守护**，两发实测都是全绿：
    //     · `158-H` 把 `underTmp` 打成**恒真** ⇒ 488 条一条没红（对抗官那 22 发里唯一的 ❌）。
    //       为什么：那 7 发变异体是**运行期**注入的，期望值没跟着挪，`intoSandbox` 一个人就
    //       把它们全杀了；`underTmp` 唯一不可替代的场合是**源码级重指**，而那种改法只有
    //       一次性验收才跑 —— **常驻回归网里没有任何一条断言在守它**。
    //     · `158-F` 把尺子本身（`TMP` 那个常量）整个挪到 `<repo>/_advmutTMP` ⇒ 同样 488 全绿，
    //       **而沙箱当场落进了真仓工作树**。
    //   ⇒ 上面那句「一把不随名字走的尺子」，准确说是「**不随 `NUDGE_SANDBOX` 这个名字走**」——
    //   `TMP` 自己也是个名字，往上挪一层照样把期望值与实际值一起带走。
    // 🔑 下面两条**各钉一格、互不重叠**（一条红了就指得出是哪一格坏的）：
    //   恒真只打得动前一条（后一条不看 `underTmp`）；挪 `TMP` 只打得动后一条
    //   （前一条的两个样本都跟着 `TMP` 走，恒等关系不变）。两条都是纯路径运算，不碰文件系统。
    check("负控·守护⓪ 的尺子是活的：真仓 _tmp 下另一处判 false、TMP 内判 true",
      !underTmp(path.join(REPO, "_tmp", "zz")) && underTmp(path.join(TMP, "zz")),
      `underTmp(<repo>/_tmp/zz)=${underTmp(path.join(REPO, "_tmp", "zz"))}`
      + ` underTmp(TMP/zz)=${underTmp(path.join(TMP, "zz"))}`
      + "（前者为 true ⇒ 尺子被打松/恒真；后者为 false ⇒ 尺子恒假）");
    check("负控·尺子自身锚定：TMP 必须落在 <repo>/_tmp/ 下",
      keyOf(TMP).startsWith(keyOf(path.join(REPO, "_tmp")) + path.sep),
      `TMP=${TMP}（不在 <repo>/_tmp/ 下 ⇒ 沙箱已经挪出去了，上面那些断言量的是别处）`);

    // ── 判别力：PR #156 那 6 发全绿的变异体，逐个必须被抓到 ─────────────────────
    // 这里不去改源码文本，而是**直接把那 6 发各自的行为后果造出来再真跑一遍** ——
    // 每一发都是真 spawn、真观测（对抗官那份实测表的「实际行为变化」那一列就是靶）。
    // 好处是：常驻回归网里跑得起，不需要谁事后手工做一轮源码 mutation 才知道这组有没有判别力。
    const ELSEWHERE = path.join(TMP, "nudge-elsewhere");
    fs.mkdirSync(ELSEWHERE, { recursive: true });
    // 「有害重指」那一发的落点：在真仓 `_tmp/` 下、但**不在** TMP 里 —— 既落得进 `.gitignore`
    // 覆盖面（万一哪天 hook 真写了也不脏工作树），又能被 `underTmp` 判成「离开了沙箱树」。
    const REDIRECT_PROBE_STATE = path.join(REPO, "_tmp", "adv158-redirect-probe.json");
    // `runDetect` 是变异体专用的低层跑法：把 payload.cwd / spawnSync 的 cwd / env 三者
    // **解耦**（`nudgeRaw` 里它们由同一个 sandbox 派生，改不出 dupkey 那种「只坏一样」的形态）。
    // 它与生产路径是否等价，由下面那条「基线与生产路径逐字段相同」的断言钉着 —— 不靠人眼比对。
    function runDetect(m = {}) {
      const payload = {
        tool_name: "Bash",
        session_id: "hard-gates-tests",
        tool_input: { command: "git push origin main" },
      };
      if (!m.dropPayloadCwd) payload.cwd = m.payloadCwd || NUDGE_SANDBOX;
      const env = { ...process.env, ...DETECT_ENV };
      if (m.dropState) delete env.DAO_TOOL_NUDGE_STATE;
      else env.DAO_TOOL_NUDGE_STATE = m.state || NUDGE_STATE;
      fs.rmSync(OBS, { force: true });
      spawnSync(process.execPath, [DETECT], {
        input: JSON.stringify(payload),
        encoding: "utf8",
        cwd: m.spawnCwd || NUDGE_SANDBOX,
        env,
      });
      return readObs();
    }
    // ⚠ 这一条是上面那句「换多了就变成在验另一条路」的机器化：变异体跑法的**未改坏基线**
    //   必须与生产路径观测到的三元组逐字段相同，否则下面 6 发抓到的是别人的病。
    const baseObs = runDetect({});
    check("判别力·变异体跑法的未改坏基线与生产路径（nudgeRaw）观测到的三元组逐字段相同",
      !!baseObs && !!real && JSON.stringify(baseObs) === JSON.stringify(real),
      `base=${JSON.stringify(baseObs)} real=${JSON.stringify(real)}`);
    const MUTANTS = [
      ["st-comment（STATE 那行整个注释掉）⇒ env ABSENT", { dropState: true }],
      ["st-notconsumed（键被覆写成 undefined）⇒ env ABSENT（与上一发同一个可观测后果）", { dropState: true }],
      ["p-cwd-blockcomment（块注释包住，字面仍在）⇒ payload.cwd ABSENT", { dropPayloadCwd: true }],
      ["p-cwd-suffix（cwd 指向别处，旧正则无尾边界）⇒ payload.cwd 离开沙箱", { payloadCwd: ELSEWHERE }],
      // ⚠ 这一发把 hook 的 cwd 摆回真仓根 —— 那正是 #129 的原病。**安全性照直说**：喂的是
      //   `tool_name: "Bash"`，而 hook 在这条路上只读不写（写盘只在浏览器 MCP 那一支，
      //   且此处 env 仍指向沙箱），故复现原病不会真的弄脏仓库。
      ["s-cwd-dupkey（后写者赢）⇒ process.cwd() 回到真仓根（#129 原病，478 条曾一条没红）", { spawnCwd: REPO }],
      ["sandbox-redirect（沙箱这个名字整个指向别处）⇒ 三样全部离开沙箱",
        { payloadCwd: ELSEWHERE, spawnCwd: ELSEWHERE, state: path.join(ELSEWHERE, "tool-nudge-seen.json") }],
      // 第 7 发是本批加的，不在对抗官那 6 发里：**它是「守护⓪ 存在的理由」的靶**。
      // 上面那发 sandbox-redirect 是在**运行期**注入的，期望值（NUDGE_SANDBOX）没跟着挪，
      // 所以 ①②③ 抓得到；但在**源码级**做同一发改动时期望值会一起挪走 ⇒ ①②③ 全部失明。
      // 这一发把落点摆到真仓根上，专门验那把不随名字走的尺子。
      ["sandbox-redirect·有害变体（落点摆回真仓根）⇒ 只有守护⓪ 那把不随名字走的尺子抓得到",
        { payloadCwd: REPO, spawnCwd: REPO, state: REDIRECT_PROBE_STATE }],
    ];
    // 判「这一发被抓到了没有」用的是**四条守护的合取** —— 与上面那四条 check 同一套判据。
    const fullyGuarded = (o) => intoSandbox(o) && !!o &&
      underTmp(o.payloadCwd) && underTmp(o.processCwd) && underTmp(o.envState) &&
      keyOf(o.processCwd) !== keyOf(REPO);
    let killed = 0;
    for (const [name, m] of MUTANTS) {
      const o = runDetect(m);
      if (!fullyGuarded(o)) killed++;
      else console.log(`  （判别力探针：变异体「${name}」没被抓到 ⇒ 这组守护对它失明 → ${JSON.stringify(o)}）`);
    }
    // 顺手证一格：上面那发把落点摆回真仓根时，hook **没有**在真仓里写下任何东西 ——
    // 喂的是 Bash，而写盘那条路只在浏览器 MCP 工具名下走。复现原病没有真的弄脏仓库。
    check("负控·复现「落点回真仓根」那一发时，真仓侧那个落点文件并未被创建（Bash 路只读）",
      !fs.existsSync(REDIRECT_PROBE_STATE), REDIRECT_PROBE_STATE);
    fs.rmSync(REDIRECT_PROBE_STATE, { force: true });
    check("判别力·PR #156 那 6 发「文本断言全绿」的变异体 + 1 发有害重指，行为级守护逐个抓到",
      killed === MUTANTS.length, `${killed}/${MUTANTS.length} 发被抓到`);
    // 负控：**没被改坏**的那一发必须仍判「三样都在沙箱里」—— 否则上面那条是恒真的（什么都抓）。
    // 这就是「改坏必须变红」的另一半：不改坏必须**不**红。
    check("负控·未改坏的那一发仍判为「三样都在沙箱里」（否则上一条抓的是空气）",
      intoSandbox(baseObs), JSON.stringify(baseObs));
  }
}

console.log("\n──── G7 · shell 里跑搜索/读文件（正负控全部取自真语料）────");
{
  // ⚠ **语料来源，照实说（2026-08-02 由对抗验证官抽查 27 条回查后改口）**：本节命令
  //   **取自 `~/.claude/projects/**/*.jsonl` 的真实调用形态**，其中一部分逐字整条命中、
  //   一部分作为子串命中、**另有约 10 条是为覆盖某个分支而构造的**（如
  //   `echo "grep -n foo file"`、`git log --grep="fix" -S "foo"`），还有数条把真实路径
  //   做了脱敏改写。**首版这里写的是「一条都不是我构造的」——那句是笃定措辞且不实**，
  //   留着这行订正当实例：自证性的话最容易被后人当实证引用，所以它必须最保守。
  //   实质影响小（构造的都是低风险负控），但「禁笃定措辞」这条对作者自己同样生效。
  //   仍然成立的那一半：**判据是拿真语料的分布定的**（32721 条命令 / 26402 条唯一命令），
  //   而不是拿本轮想到的形态定的 —— 那才是 dispatch-clauses「语料从哪来」要防的病。
  const positives = [
    ["sed 读文件片段（带 cd && 前缀，真语料最常见形态）",
      "cd /d/frank/mousse-cli && sed -n 130,200p crates/mousse-core/src/prompt_store/mod.rs", /Read 的/],
    ["cat 读文件", "cat src-ui/package.json", /Read/],
    ["grep 搜内容", 'grep -n "creative.libEmpty" src-ui/src/panels/creative/EquipmentLibraryColumn.tsx', /Grep 工具/],
    ["find 找路径", "find crates/mousse-core/src/injection -type f 2>/dev/null", /Glob 工具/],
    ["tail 读日志尾", "tail -8 _tmp/verify-all.log", /Read/],
    ["head 读文件头", "head -5 _tmp/pr-316-readback.md", /Read/],
    ["rg 搜内容", `rg -n "onmessage" src-ui/src --glob '!*.test.*'`, /Grep 工具/],
    // 这一条钉的是「`2>/dev/null` 是 **stderr** 重定向，不该被当成豁免②的 stdout 落文件」。
    // 两者只差一个字符，而放错会让绝大多数真实 grep 调用（真语料里极常带 `2>/dev/null`）整批漏掉。
    ["grep 带 2>/dev/null 仍拦（stderr 重定向 ≠ stdout 落文件）",
      'grep -rl "cdn.tailwindcss.com" "$dest/pages" 2>/dev/null', /Grep 工具/],
    // ── 下面两条钉的是 2026-08-02 对抗验证官找出的两个过宽豁免（都已修）──────
    // 缺陷一：HEREDOC 原为裸 `/<</`，匹配整段任意位置 ⇒ 正文里出现 `<<` 就整条放行。
    // 这条命令是真语料（查 git 冲突标记），它**不含任何 heredoc**，必须被拦。
    ["正文里的 `<<` 不是 heredoc（真语料，查 git 冲突标记）",
      'grep -n "^<<<<<<<\\|^=======\\|^>>>>>>>" src-ui/src/components/TerminalPane.tsx', /Grep 工具/],
    // 缺陷二：`-prune` 曾被列进 find 的"动作"清单 ⇒ 整条放行。
    // 它是**谓词不是动作**，这条是纯文件搜索、100% 可 Glob 替代。
    ["find -prune 是谓词不是动作，仍要拦",
      "find . -path ./node_modules -prune -o -name '*.test.ts' -print", /Glob 工具/],
    // PowerShell 赋值式段首：`Select-String` 在词表里，却曾被 `$x = ` 挡住整批漏过。
    ["PowerShell 赋值式段首（$x = Select-String）仍要拦",
      "$hits = Select-String -Path D:\\frank\\x\\a.md -Pattern version", /Grep 工具/],
  ];
  for (const [name, c, altRe] of positives) {
    const r = gate(bash(c));
    check(`正控：${name} → exit 2`, r.code === 2, `code=${r.code}`);
    check(`正控：${name} → stderr 给得出替代写法`, altRe.test(r.err), r.err.slice(0, 160));
  }
  check("正控：PowerShell 的 Select-String 同样拦",
    gate({ tool_name: "PowerShell", tool_input: { command: "Select-String -Path D:\\frank\\mousse-cli\\package.json -Pattern version" } }).code === 2);
  // 拒绝消息必须自带「什么情况下不拦」，否则读的人会以为这几个命令被禁了 —— 而它们没有。
  check("正控：stderr 同时列出合法用法（免得被读成「这些命令被禁了」）",
    /管道过滤/.test(gate(bash("cat a.md")).err) && /段首/.test(gate(bash("cat a.md")).err));

  const negatives = [
    // ① 管道过滤 —— 这 4 条全部来自「被权限拒但 G7 刻意放行」的那 31 条
    ["管道过滤 grep（真语料）", `cd /d/frank/windsurf-dao-wt-r2 && node tests/clause-index.tests.js 2>&1 | grep -n "FAIL " | head -20`],
    ["管道过滤 grep 之二（真语料）", `git ls-files ccswitch/ | grep -iE "test|clause|ledger"`],
    ["管道过滤 + head（真语料）", `gh api repos/pleaseai/claude-code-docs/git/trees/main?recursive=1 --jq '.tree[].path' 2>&1 | grep -i hook | head -20`],
    ["until 轮询（真语料）", `until grep -q "VERIFY_ALL_EXIT=" /d/frank/mousse-cli/_tmp/adv-f1/verify-all.out 2>/dev/null; do sleep 10; done; echo "DONE"`],
    // ② stdout 落真实文件
    ["head 输出落文件（真语料）", "head -25 _tmp/branches-to-delete.txt > _tmp/batch1.txt"],
    ["tail 输出追加到文件（真语料）", "tail -n +2 _tmp/pr-384-body-readback.md >> _tmp/pr-384-body-new.md"],
    // ③ heredoc / 命令替换
    ["cat 写文件 heredoc（真语料）", "cat > _tmp/qa/issue-304/probe-buttons.js <<'JS'"],
    ["命令替换里的 head", 'echo "$(head -1 _tmp/x.txt)"'],
    // ④ 不是「读」的动作
    ["sed -i 原地改（真语料）", `sed -i -E -e 's/font-size:[[:space:]]*12px/font-size:var(--text-xs)/g' a.css`],
    ["find -exec（真语料）", `find ccswitch -name "*.md" -exec wc -l {} \\;`],
    ["tail -f 流式（真语料）", "tail -f /dev/null & sleep 1"],
    ["tail -c 字节模式（Read 无字节语义，真语料 92 例）", `tail -c 3000 "C:/Users/x/tasks/out.txt"`],
    ["head -c 字节模式（真语料 22 例）", `head -c 8000 "C:/Users/x/a.jsonl"`],
    // ⑤ 段首不是这些词
    ["git log --grep 自带参数（段首是 git）", `git log --grep="fix" -S "foo" --oneline -20`],
    ["ls 刻意不收（Glob 给不出时间戳/权限位；真语料 3266 例）", `ls -la "/d/frank/TraceyU/design/" 2>/dev/null`],
    ["wc 刻意不收（Read 数不了行数；真语料 1032 例）", `wc -l "D:/frank/windsurf-dao/ccswitch/dao.md"`],
    ["字面量里的命令不该拦", `echo "grep -n foo file"`],
    ["普通命令", "node scripts/run-tests.mjs"],
  ];
  for (const [name, c] of negatives) {
    const r = gate(bash(c));
    check(`负控：${name} → exit 0`, r.code === 0, `code=${r.code} err=${r.err.slice(0, 130)}`);
  }
  check("逃生阀：设了 DAO_SHELL_SEARCH_OK=1 即放行",
    gate(CANARY["G7-shell-search"], { env: { DAO_SHELL_SEARCH_OK: "1" } }).code === 0);
}

console.log("\n──── 段切分器升级（{seg,sep} + $() 感知）后 G3/G5 行为未变 ────");
{
  // 2026-08-02 为 G7 把 shellSegments 换成了 shellSegmentsRaw + 薄包装。**这一组钉的是
  // 「G3/G5 的判定路径一个字符没动」这句自陈** —— 没有它，那句话就只是作者的声明。
  check("G5：多行 commit 正文仍被拦（原本就是靠引号感知切分才拦得住的那一条）",
    gate(bash('git commit -m "[cc] feat: x\n- [ ] 随后补测试"')).code === 2);
  check("G5：`- [x]` 仍放行", gate(bash('git commit -m "做完了\n- [x] 跑了测试"')).code === 0);
  check("G3：npm publish 仍被拦", gate(bash("npm publish --access public")).code === 2);
  check("G3：--dry-run 仍放行", gate(bash("npm publish --dry-run")).code === 0);
  check("G3：字面量 echo \"npm publish\" 仍放行", gate(bash('echo "npm publish"')).code === 0);
  // $() 感知**新**带来的一处行为差异，照直断言出来（而不是假装没有）：
  // 以前 `echo "$(ls | head -1)"` 会在 `|` 处被切成两段（第二段段首 `head`），现在是一段。
  // 对 G3/G5 无影响（段首都是 echo），对 G7 是必须的 —— 命令替换里取一行输出不是读文件。
  check("$() 内部不再切分：命令替换里的 head 不触发 G7", gate(bash('echo "$(ls | head -1)"')).code === 0);
  check("$() 内部不再切分：G3 对命令替换里的 publish 仍是已知漏报（照直钉住，不假装拦得住）",
    gate(bash('echo "$(npm publish)"')).code === 0);
  // 管道仍然要切分（$() 感知不能把 `|` 一起吃掉），且**管道后面那一段仍进 G5 射程**。
  // 判据取「G5 真的拦下了它」而不是「exit 0」—— 放行有两种成因（走到了判定但没命中 /
  // 压根没走到），两者输出一样，只有拦下来才证明那一段被读过。
  // ⚠ 初稿这里写的是 `cat body.md | git commit -F -`，**当场被自己的闸拦下**：
  //    第一段 `cat body.md` 段首正是 G7 的靶。留着这句话当实例 —— 负控写错了会
  //    伪装成「被测对象有问题」，而这次它只是我选错了命令。
  const pipeBody = path.join(TMP, "pipe-body.md");
  fs.writeFileSync(pipeBody, "做了一半\n- [ ] 剩下的随后补\n", "utf8");
  check("管道仍然切分：`echo x | git commit -F <带未勾框的文件>` 仍被 G5 拦下",
    gate(bash(`echo hi | git commit -F "${pipeBody}"`)).code === 2);
}

console.log("\n──── mutation · 判别力（改坏一处，对应正控必须从红变绿）────");
{
  // 每条：把 hook 源码里的一段判据改成永假，断言那一闸的承重正控由 exit 2 掉成 exit 0。
  // 改的是 _tmp/ 里的副本，真文件全程不碰（下面 canary 段验证这一点）。
  const src = fs.readFileSync(HOOK, "utf8");
  const MUTANTS = [
    ["G1-windows-mcp", "/^mcp__windows[-_]?mcp?[-_]*__/i", "/^__NEVER_MATCHES__/"],
    ["G2-live-settings", '["settings.json", "settings.local.json"]', '["__no-such-file.json"]'],
    ["G3-publish", "/^(npm|pnpm|yarn|bun)\\s+publish\\b/.test(seg) ? seg :", "/^__nope\\b/.test(seg) ? seg :"],
    ["G4-screenshot-path", "if (/(^|\\/)_tmp\\/qa\\//i.test(p)) return null;", "if (true) return null;"],
    // 靶点取赋值左侧而非正则字面量本身：判据被收窄过一次（见 hook 里 UNCHECKED_TODO 的注释），
    // 把整条正则抄进测试会让「判据一改、mutation 靶点失配」变成一个静默失效面。
    ["G5-readonly-todo", "const UNCHECKED_TODO = ", "const UNCHECKED_TODO = /__NEVER_MATCH_TODO__/; const _deadPattern = "],
    ["G6-heartbeat-signature", "if (HEARTBEAT_SIG.test(p)) return null;", "if (true) return null;"],
    ["G7-shell-search", "const alt = SEARCH_TOOL_ALT[head];", "const alt = undefined;"],
  ];
  for (const [id, from, to] of MUTANTS) {
    check(`mutation 靶点在源码里唯一存在（${id}）`, src.split(from).length === 2,
      `出现 ${src.split(from).length - 1} 次`);
    const mutantPath = path.join(TMP, `mutant-${id}.js`);
    fs.writeFileSync(mutantPath, src.replace(from, to), "utf8");
    const before = gate(CANARY[id]).code;
    const after = gate(CANARY[id], { script: mutantPath }).code;
    check(`${id}：真文件拦（exit 2）而改坏后不拦（exit 0）⇒ 这条断言真的在测那段判据`,
      before === 2 && after === 0, `before=${before} after=${after}`);
    // 改坏一闸不该顺手把别的闸也弄哑（否则上面那条"变绿"可能是整个 hook 崩了）
    const otherId = id === "G1-windows-mcp" ? "G3-publish" : "G1-windows-mcp";
    check(`${id}：改坏它之后其他闸仍然拦（证明不是整个 hook 崩了）`,
      gate(CANARY[otherId], { script: mutantPath }).code === 2);
  }

  // ── 反向 mutation（2026-08-02 随 G6 加）：上面那批**全在「把门改松」这一侧**，
  //    于是「负控会不会红」这件事一次都没被验到 —— 一组永远为真的负控与一组真正管用的负控，
  //    在全绿的输出里长得一模一样（dispatch-clauses 对抗验证官节点名的第四件事）。
  //    故这里反着来一次：把 G6 的 stop 豁免改坏 ⇒ 原本放行的 `{stop:true}` 必须变成 exit 2。
  {
    const from = "if (ti.stop === true) return null;";
    const to = "if (ti.stop === \"__never_matches__\") return null;";
    check("反向 mutation 靶点在源码里唯一存在（G6 stop 豁免）", src.split(from).length === 2,
      `出现 ${src.split(from).length - 1} 次`);
    const mutantPath = path.join(TMP, "mutant-G6-stop-exemption.js");
    fs.writeFileSync(mutantPath, src.replace(from, to), "utf8");
    const stopOnly = wake({ stop: true });
    const before = gate(stopOnly).code;
    const after = gate(stopOnly, { script: mutantPath }).code;
    check("G6：真文件放行 stop:true（exit 0）而豁免被改坏后拦（exit 2）⇒ 那条负控真的在测豁免分支",
      before === 0 && after === 2, `before=${before} after=${after}`);
    check("G6：改坏豁免不影响签名判据（带签名的仍放行）",
      gate(wake({ prompt: "[dao-heartbeat] 心跳" }), { script: mutantPath }).code === 0);
  }

  // ── G7 的反向 mutation（三条豁免分支各一条）────────────────────────────────
  //    G7 的负控有 18 条，其中一多半靠三个豁免分支放行。**一组永远为真的负控与一组
  //    真正管用的负控，在全绿的输出里长得一模一样** —— 所以每个豁免分支都必须被单独
  //    改坏一次，看着对应负控从 exit 0 翻成 exit 2，才算证明「那条负控真的走到了那个分支」。
  //    这三条同时也是 dispatch-clauses 讲的第三向 mutation：判据还在、也还在算，
  //    只是**算出来的结果不再被消费** —— 前两向验「门在不在」，这一向验「门的答案有没有人听」。
  {
    const REVERSE = [
      ["管道豁免", 'if (sep === "|") continue;', 'if (sep === "__never__") continue;',
        'cd /d/x && node t.js 2>&1 | grep -n "FAIL " | head -20'],
      ["stdout 落文件豁免", "if (STDOUT_TO_FILE.test(rest)) continue;", "if (false) continue;",
        "head -25 _tmp/branches-to-delete.txt > _tmp/batch1.txt"],
      ["-c 字节模式豁免", 'if ((head === "tail" || head === "head") && /(^|\\s)-c(\\s|=|\\d)/.test(rest)) continue;',
        "if (false) continue;", 'tail -c 3000 "C:/Users/x/out.txt"'],
      // ── 下面三条 2026-08-02 补，补它们的理由是本 PR 最贵的一课 ──────────────
      // 首版只给了上面三个分支反向 mutation；对抗验证官随后找出的两个真缺陷
      // （heredoc 裸 `<<` 匹配整段任意位置、`-prune` 被误当成动作）**恰好落在剩下这几个
      // 没配反向 mutation 的分支上**。上面那段注释写着「一组永远为真的负控与一组真管用的
      // 负控在全绿输出里长得一模一样」—— 这句话在本文件里**自己应验了一次**。
      // ⇒ 每个豁免分支都必须有一条反向 mutation。这不是形式主义，它就是那两个缺陷的成因。
      // ⚠️ **这条负控是构造的，不是真语料 —— 而这一格本身就是发现**：
      // 初版用的是真语料 `cat > _tmp/probe.js <<'JS'`，反向 mutation 当场**红**（before=0 after=0）：
      // 它根本没走 heredoc 分支，是被 `> _tmp/probe.js` 的 STDOUT_TO_FILE 分支放行的。
      // 顺着查下去，拿真 hook 对全库 **1147 条含 `<<` 的命令**跑了原版 vs 去掉 heredoc 的变异体，
      // 判决差集 **0 条** ⇒ **heredoc 在真语料上是一条死分支**，每条都被别的分支盖住了。
      // 仍然保留这个分支（`sed 's/a/b/' <<EOF` 这种"输入是内联文本"的形态是真实 shell 语义，
      // 砍掉它就是一个真误伤），但**必须用构造语料才测得到它** —— 照实标注，
      // 别让后人以为它被真实数据验证过。**没有这条反向 mutation，这一格永远不会被发现。**
      ["heredoc 豁免（构造语料·见上方注释）", "if (HEREDOC.test(rest)) continue;", "if (false) continue;",
        "sed 's/a/b/' <<'EOF'"],
      ["find 动作豁免", 'if (head === "find" && /(^|\\s)-(exec|execdir|ok|delete)(\\s|$)/.test(rest)) continue;',
        "if (false) continue;", 'find ccswitch -name "*.md" -exec wc -l {} \\;'],
      ["-f 流式豁免", 'if ((head === "tail" || head === "head") && /(^|\\s)-(f|F|-follow)(\\s|$)/.test(rest)) continue;',
        "if (false) continue;", "tail -f _tmp/dev.log"],
    ];
    for (const [name, from, to, negCmd] of REVERSE) {
      check(`反向 mutation 靶点唯一存在（G7 ${name}）`, src.split(from).length === 2,
        `出现 ${src.split(from).length - 1} 次`);
      const mp = path.join(TMP, `mutant-G7-${name}.js`);
      fs.writeFileSync(mp, src.replace(from, to), "utf8");
      const before = gate(bash(negCmd)).code;
      const after = gate(bash(negCmd), { script: mp }).code;
      check(`G7 ${name}：真文件放行（0）而豁免被改坏后拦（2）⇒ 那条负控真的在测这个分支`,
        before === 0 && after === 2, `before=${before} after=${after}`);
    }
  }

  // fail-open 路径：注入一个必抛的判定，断言"放行 + 大声喊"
  const boom = path.join(TMP, "mutant-throw.js");
  // ⚠ 这一处此前是本文件 **12 个变异体构造点里唯一没有「靶点仍在」前置断言**的
  //   （#117 对抗验证官的锚点审计捞出，源出 #103 那一路的普查）。
  //   **它不会静默空转**——本轮实测：把 hook 里那一行做行为等价的改动（多一个空格）让字面串
  //   失配 ⇒ 变异体 = 原文 ⇒ `CANARY["G3-publish"]` 被真 G3 拦下 ⇒ 下面两条当场红。
  //   **但两条红的报文说的都是「fail-open 没生效」**，读的人会去查 fail-open 那条路，
  //   而真正坏掉的是这个靶点 —— 归因指错方向，排查成本全落在下一个人身上。
  //   故补这一条：它红的时候直说「靶点失配」。判据同上面各处（`split(from).length === 2`）。
  const BOOM_ANCHOR = 'if (!/^mcp__windows[-_]?mcp?[-_]*__/i.test(input.tool_name || "")) return null;';
  check("mutation 靶点在源码里唯一存在（fail-open 注入点）", src.split(BOOM_ANCHOR).length === 2,
    `出现 ${src.split(BOOM_ANCHOR).length - 1} 次 —— 失配的话下面两条 fail-open 断言会红，但报文不会指向这里`);
  fs.writeFileSync(boom, src.replace(BOOM_ANCHOR, 'throw new Error("injected");'), "utf8");
  const r = gate(CANARY["G3-publish"], { script: boom });
  check("fail-open：守卫自身抛异常 → exit 0（放行，不砖掉会话）", r.code === 0, `code=${r.code}`);
  check("fail-open 不静默：stderr 明说「本次放行」+ 指向 --selfcheck",
    /守卫自身出错/.test(r.err) && /放行/.test(r.err) && /--selfcheck/.test(r.err), r.err.slice(0, 200));
}

console.log("\n──── canary 恒等（mutation 全程没碰过真文件）────");
{
  check("真 hook 文件 sha256 与开跑前一致", sha(HOOK) === PRISTINE_SHA);
  for (const [id, p] of Object.entries(CANARY)) {
    const after = gate(p).code;
    check(`${id}：mutation 前后真文件行为一致（before=${canaryBefore[id]} after=${after}）`,
      after === canaryBefore[id] && after === 2);
  }
}

console.log("\n──── --selfcheck（只断言形态，真实注册状态取决于用户配置）────");
{
  const r = spawnSync(process.execPath, [HOOK, "--selfcheck"], { encoding: "utf8" });
  const out = String(r.stdout || "");
  const shapeOk = /^✓ 已注册于 PreToolUse，matcher=/.test(out) ||
                  /^✗ 未注册：/.test(out) ||
                  /^✗ 读不到 live settings\.json/.test(out);
  check("首行为三种既定形态之一", shapeOk, JSON.stringify(out.split("\n")[0]));
  check("逐闸都各打印一行覆盖面结论", (out.match(/· G\d-|✓ G\d-|✗ G\d-/g) || []).length >= 7, out.slice(0, 400));
  check("末行报闸数与逃生阀清单", /共 7 道闸/.test(out) && /DAO_SETTINGS_EDIT_APPROVED/.test(out), out.slice(-200));
  check("G7 出现在逐闸覆盖面清单里", /G7-shell-search/.test(out), out.slice(0, 700));
  check("G7 的逃生阀进了末行清单", /DAO_SHELL_SEARCH_OK/.test(out), out.slice(-200));
  // G6 的注册面（matcher 加 `|ScheduleWakeup`）**属用户动作，本批不改**。故此刻 selfcheck
  // 大概率会把 G6 报成零覆盖 —— 那正是设计意图：「没接上」要在机器通道上说出来。
  // 这里刻意**不断言它一定是零覆盖**（用户随时可能注册完），只断言 G6 出现在逐闸清单里，
  // 即「这道闸的覆盖面确实被独立问过一次」。锚死任一态都会让测试随用户配置变红。
  check("G6 出现在逐闸覆盖面清单里（注册与否都得有它一行）", /G6-heartbeat-signature/.test(out), out.slice(0, 600));
  // ⚠ **这一条 2026-08-02 修过一个真 bug，成因值得留着**：它的名字写着「未注册 **/ 有闸失覆盖**」，
  // 而原判据是 `/^✗/.test(out)` —— `^` 不带 `m` 标志 ⇒ **只读首行**，也就是只看得见「注册没注册」，
  // 逐闸覆盖面那几行（`  ✗ Gn-…：matcher 覆盖不到 …`）它一行都读不到。
  // 于是「有闸失覆盖但已注册」这一态会被判成「该 exit 0」，与 selfcheck 的实际 exit 1 相撞。
  // **它一直没红，是因为在 G6 之前每道闸都被 matcher 覆盖着 —— 那一格从未被走到过。**
  // 这正是本仓反复记的那种形态：一条断言的**名字**覆盖了两种情况，**判据**只覆盖一种，
  // 而在缺一种样本的那段时间里，两者的输出逐字节相同。
  const anyFail = /(^|\n)\s*✗/.test(out);
  check("未注册 / 有闸失覆盖 → 退出码非 0（不许把「没接上」报成通过）",
    anyFail ? r.status !== 0 : r.status === 0, `code=${r.status} anyFail=${anyFail}`);
}

console.log("\n──── 兜底：无关输入一律不拦 ────");
{
  const harmless = [
    ["Read", { tool_name: "Read", tool_input: { file_path: "D:/x/a.md" } }],
    ["Grep", { tool_name: "Grep", tool_input: { pattern: "npm publish" } }],
    ["空输入", {}],
    ["普通 Bash", bash("node scripts/run-tests.mjs")],
    ["普通 Edit", edit("D:/frank/windsurf-dao/ccswitch/dao.md")],
  ];
  for (const [name, p] of harmless) check(`负控：${name} → exit 0`, gate(p).code === 0, `code=${gate(p).code}`);
  const r = spawnSync(process.execPath, [HOOK], { input: "这不是 JSON{{{", encoding: "utf8" });
  check("负控：喂垃圾输入 → exit 0（放行，不因解析失败拦人）", r.status === 0, `code=${r.status}`);
}

console.log("\n──── #159 · 收尾复核：运行时出口恒等式 ────");
{
  // 🔑 **为什么这一组在文件最末尾，而不是留在 G6 那一节里**：判据放在中间，它守的就只是
  //   它上面那一半 —— **后来人往文件下半截加的调用点会安安静静地落在射程之外**，
  //   而"射程就是写下的那个边界"是本仓反复记的形态。
  //   ~~放这里，整份文件都在里面。~~ 放这里，**到这一行为止**都在里面 —— 射程的下沿是
  //   下面那条断言本身，其后还有 `fs.rmSync(TMP)` 与汇总输出。**写在那条断言之后的第二出口
  //   仍在射程外**（issue #163 第 2 笔，PR #161 对抗官 `159-F` 实测：那样加一个出口，全绿）。
  //   低危（那之后只剩清理与打印，没人会在那里喂 hook），但「整份文件」这个说法本身不准。
  check("#159·收尾：整份文件跑完，真 hook 的 spawn 次数 === nudgeRaw 调用次数 + 已登记绕开",
    NUDGE_SPAWNS === NUDGE_RAW_CALLS + NUDGE_DECLARED_BYPASS,
    `spawns=${NUDGE_SPAWNS} nudgeRaw=${NUDGE_RAW_CALLS} 已登记绕开=${NUDGE_DECLARED_BYPASS}`
    + "（差额 > 0 = 有出口没走 nudgeRaw；差额 < 0 = 登记数虚高，探针的账记错了）");
  // 🔴 **计数器自己的存活证明（`#官抗-变异体存活` 的同一格）**：恒等式在「计数器恒 0」时
  //   同样成立 —— 而 0 === 0 与「密不透风」在全绿输出里逐字节相同。最容易造成恒 0 的写法
  //   就是把 `const { spawnSync } = childProcess` 挪到 patch 之前（模块顶部有告警）。
  //   **读恒等式之前，先回答「这一轮它真的数到过东西吗」。**
  check("#159·收尾：本轮真的数到过 spawn（计数器不是恒 0 —— 零检出 ≠ 零存在）",
    NUDGE_SPAWNS > 0 && NUDGE_RAW_CALLS > 0 && NUDGE_DECLARED_BYPASS > 0,
    `spawns=${NUDGE_SPAWNS} nudgeRaw=${NUDGE_RAW_CALLS} 已登记绕开=${NUDGE_DECLARED_BYPASS}`);
  // 并且证明那层包装确实还挂着（有人把它摘了、或被别的模块覆盖回去，这里会红）。
  check("#159·收尾：spawnSync 上那层计数包装仍然挂着（没被谁摘掉或覆盖回原函数）",
    childProcess.spawnSync !== _realSpawnSync && spawnSync !== _realSpawnSync);
}

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}

console.log(`\n=== 汇总: PASS=${pass} FAIL=${fail} ===`);
process.exit(fail ? 1 : 0);
