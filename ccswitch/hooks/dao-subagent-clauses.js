// dao-subagent-clauses.js — SubagentStart · 把「只给你这一份」的条款渲染进 subagent 的开场上下文
//
// ── 它在补哪个洞 ─────────────────────────────────────────────────────────────
// 今天 subagent 读到条款靠一条通道：派单 prompt 的必带首行「开工第一步：Read
// docs/rules/dispatch-clauses.md」。那条通道有两个已知弱处：**①它是槽位档**——帅要在写
// 派单令时把那一行敲进去，敲不敲没有任何程序在核；**②它给的是整份文件**，而调研里唯一
// 带量化的杠杆是 Quote 形态（把「只与你有关的那几条」渲染出来，遵守率 17-40% → 76-77%）。
// 本 hook 走的是 SubagentStart：subagent 一被创建，宿主就把这段文字放进它的开场上下文，
// **不需要任何人记得**。渲染端复用已有的 ccswitch/scripts/render-clauses.mjs，不另造解析。
//
// ── 宿主能力：哪些是实测的、哪些是推的（禁笃定措辞，逐条标明依据）──────────
//   ✅ 事件存在且本机宿主已实现（Claude Code v2.1.220 · 读安装的 cli.js 实证）：
//      `executeSubagentStartHooks` 构造的 payload 字面量是
//      `{...common, hook_event_name:"SubagentStart", agent_id:A, agent_type:q}`。
//   ✅ 输入字段（同上，来自 payload 字面量 + common 字段构造函数）：
//      session_id / transcript_path / cwd / permission_mode / hook_event_name / agent_id / agent_type。
//      **没有 prompt 字段** —— 派单令的正文在这里拿不到（这决定了官种只能从 agent_type 推，见下）。
//      ⚠ 这里的 transcript_path 是**主会话**的转录，subagent 自己的转录此刻还不存在。
//   ✅ 输出：宿主的输出 schema 对本事件只接受 `hookSpecificOutput.additionalContext`
//      （zod 字面量 `C.object({hookEventName:C.literal("SubagentStart"), additionalContext:C.string().optional()})`），
//      派发分支也只取 additionalContext；随后以 `type:"hook_additional_context"` 推进
//      **subagent 的开场消息列表**。⇒ 不能阻断创建、不能改 prompt（后者是官方 issue #23885 的未实现请求）。
//   ✅ 文档（官方 hooks 参考）另称：matcher 匹配的是 agent 类型名；additionalContext 出现在
//      「对话最开头、第一个 prompt 之前」；**单个值超过 10,000 字符时宿主改为落文件 + 给一段预览**。
//      本机 cli.js 里没找到那个 10,000 的实现点，所以这一条**只有文档依据、无本机实证**；
//      本 hook 一律把注入控制在 MAX_CONTEXT_CHARS（默认 9000）以内 —— 两种行为下都安全的那一侧。
//   ❌ **未实测：真实 session 里跑一次**。要跑得先把本 hook 注册进 live settings.json，
//      而那是硬闸 G2 拦下的用户动作（本批刻意不写 live / 不写 cc-switch DB，注册项 JSON 交 PR body）。
//      ⇒ 「注册之后它真的响了」这句话，**现在没有人有资格说**。判据在 --selfcheck 的第②段：
//      它只采信非 synthetic 的心跳记录，自测心跳不算数。
//
// ── 摸了全域分布再定映射表（建护栏前先摸分布，dao-guard-writing 第 1 条）──────
// 本机 713 份 transcript（1242 MiB）里 Task 调用的 subagent_type 实测分布：
//   general-purpose 638 · claude 115 · dao-reviewer-critical 17 · Explore 14 ·
//   dao-spec-writer 7 · dao-strategist 7 · claude-code-guide 4 · Plan 1   （合计 803 次 / 8 种）
// ⇒ **803 次里 753 次（93.8%）的 agent_type 根本不含官种信息**：帅派实现官/对抗验证官/
//    dogfood 官时用的都是通用底座（general-purpose / claude），官种写在**派单 prompt 正文里**，
//    而本事件拿不到 prompt。**所以「映射不出」是主路径不是异常路径**，泛型降级那一支才是
//    本 hook 今天的主要形态 —— 它必须做得好，不能当兜底草草了事。
//    另一个直接推论：想让官种渲染真正生效，得改**派单侧**（帅按官种选 agent type，或宿主
//    某天把 prompt 也下发给本事件），不是在这张表上堆更多名字。
//
// ── 三条 fail-closed / 一条 fail-open，别混为一谈 ────────────────────────────
//   渲染端（render-clauses.mjs）是 fail-closed 的：索引过期、官种名不认识、该官种零条款，
//   它一律 exit 1 而不吐一份看起来正常的东西。本 hook **不推翻它的判断**，只做一件事：
//   **把它的失败翻译成一条指针注入**（「正文在哪、按哪一节读」），而不是静默不注入。
//   ⇒ 三条降级路径：官种节渲染不出 → 退到通用节并写明；通用节也渲染不出 → 只给指针；
//     本 hook 自己崩了 → 仍然只给指针 + systemMessage 留痕（**exit 恒 0**，绝不砖掉 subagent）。
//   「永不静默空过」是这个 hook 的第一原则：**零注入与注入成功在 transcript 上长得一样**，
//   而那正是本体系反复踩的那个病。故每一条路径的产出都带首行签名 `[dao-subagent-clauses v1]`，
//   审计取证靠 Grep 那个签名，不靠问 subagent 本人。
//
// ── 刻意不做的事 ─────────────────────────────────────────────────────────────
//   · **不落任何派生文件**（不写渲染产物 md）。理由有二：①派生副本必漂移；②守卫铁律
//     「检查器的输出不能落在它自己的扫描面内」—— 渲染产物里逐字带着 `[n= @ 触发:]`，
//     一旦有人把 _tmp 加进索引源清单，它会被当成条款重新扫进去，每跑一次翻一倍。
//     要全文的官按注入里给的 `文件:行号` 区间 Read 原文，**原文才是真相源**。
//   · **不动 dispatch-clauses 的首行 Read 机制**（双通道过渡）。哪条通道该退役，要看
//     注册之后的实际注入率审计数据（契约：≥20 次注入率 100% 才谈退役），不在本批预判。
//   · **不写 live settings.json / 不写 cc-switch DB**：注册是用户动作（硬闸 G2）。
//
// ── 官种节渲染得出来了，但别把它读成「这条通道已经活了」（照直写）────────────
// **曾经的形态**：仓里那份默认索引（ccswitch/clause-index.json）的源清单**全是
// role_scheme=general 的仓内文件** ⇒ reviewer/implementer/adversary/scout/dogfood 一律 0 条
// ⇒ 映射命中了也照样退到通用节。成因是带官种分节的语料**只住在各项目仓**（那正是
// 「全局层被一个项目文件治理」）。
//
// **2026-08-02 两步走完**：①同日拆分批把通用半边搬进 **ccswitch/rules/dao-officer-clauses.md**
// （仓内、六个官种节齐全）；②合并态这一批把它登记进 clause-parser.mjs 的 defaultSources()
// （all-top-level + dispatch-sections）⇒ **默认索引里六个官种现在都有条款，官种节渲染得出来。**
//
// 🔴 **仍然没证到的那一半，别读成已解决**：渲染得出东西 ≠ 这个 hook 被调用过。
// 注册进 live settings.json 是**用户动作**（硬闸 G2 拦的那一格），本批照旧不代做 ⇒
// 「注册之后它在真实 session 里真的响了」现在仍然没有人有资格说。判据在 --selfcheck 第②段：
// 它只采信非 synthetic 的心跳记录。**「没注册」与「注册了没触发」在日志上长得一样。**
//
// 项目特有那半仍在各项目仓，仍然不进本仓索引（要么带本机绝对路径、要么把别人的语料复制进来）。
// 要临时把某个项目那份也算进来：
//   node ccswitch/scripts/gen-clause-index.mjs --sources-json <清单> --out <某处>/clause-index.json
//   然后 DAO_CLAUSE_INDEX=<某处>/clause-index.json
//
// ── 这张映射表将来怎么退役 ───────────────────────────────────────────────────
// 映射表和条款库一样只增不减。给它留的触发器是 `--selfcheck` 第③段：它逐条打印表里每个
// 官种**在当前索引里有几条条款**——长期 0 条的那些行就是该问「这一行还有意义吗」的对象。
// 这是观察线不是闸（机器判不出「这个映射对不对」，判得出的只有「它今天渲染得出东西吗」）。
//
// 回归网：tests/subagent-clauses.tests.js（映射正控 / 泛型降级 / 渲染失败降级 / fail-open / mutation 双向）
// 真相源：windsurf-dao/ccswitch/hooks/dao-subagent-clauses.js
// 注册（用户动作，本批不代做）：settings.json → hooks.SubagentStart，matcher "*"

"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { createHookScaffold } = require("../lib/hook-selfcheck.js");

const SIGNATURE = "[dao-subagent-clauses v1]";
const EVENT = "SubagentStart";
const ROOT = path.resolve(__dirname, "..", ".."); // 本文件在 <root>/ccswitch/hooks/
const RENDERER = path.join(ROOT, "ccswitch", "scripts", "render-clauses.mjs");

// 注入上限：官方文档说单个 additionalContext 超 10,000 字符会被宿主改成「落文件 + 预览」。
// 取 9000 留头部余量 —— 两种宿主行为下都不触发那条分支的那一侧。
const MAX_CONTEXT_CHARS = Number(process.env.DAO_SUBAGENT_CLAUSES_MAX || 9000);
const RENDER_TIMEOUT_MS = Number(process.env.DAO_SUBAGENT_CLAUSES_TIMEOUT_MS || 10000);

// 条款库正文的位置：**先按 cwd 探项目侧那半**（跨项目资产不该把某一个仓的路径写死成唯一答案），
// 探不到才退到 **dao 自己的官侧通用档**。env 覆写优先级最高，测试与换机都靠它。
//
// **2026-08-02 订正的倒置依赖**：这里原先写死 `D:/frank/mousse-cli/docs/rules/dispatch-clauses.md`
// —— **一个本机绝对路径 + 某一个项目的文件**。它有两种坏法且都静默：换台机器指向空气
// （降级路径本身失效，而 hook 照常 exit 0），换个项目指向别人的账本（拿 A 仓的验证入口、
// 进程名、专有脚本去指导 B 仓的官）。现在退到**仓内相对路径**，随本仓走、随本文件搬。
// **射程照直写**：退到通用档只补得上「怎么做」那一半，项目特有那半（跑哪个命令）没探到就是
// 没有，注入文本里因此明写这一点，不假装两半都给了。
const CLAUSE_FILE_CANDIDATES = ["docs/rules/dispatch-clauses.md", ".claude/rules/dispatch-clauses.md"];
const KNOWN_CLAUSE_FILE = path.join(ROOT, "ccswitch", "rules", "dao-officer-clauses.md").replace(/\\/g, "/");

// ── agent_type → 官种 ────────────────────────────────────────────────────────
// 两段式：先精确名，再关键词。**两段都是近似**，两个方向都构造得出反例：
//   · 漏判：通用底座（general-purpose / claude）承载的官种一律判不出 —— 实测占 93.8%。
//   · 误判：名字里带 review 的 agent 未必是 dao 语义下的复审官（dao-reviewer-critical
//     按名字归 reviewer，而它在实践中常被当对抗验证官用 —— 这一格该归哪边是**判断**，
//     不由本文件自定；注入文本里因此明写「若本次实际官种不是 X，按你那一节读原文」，
//     让误判在官那一侧当场可纠）。
const AGENT_ROLE_EXACT = [
  // Explore 是只读检索型 agent，与侦察官的定义性动作（只读调研、不落写入面）重合
  ["Explore", "scout"],
];
const AGENT_ROLE_KEYWORDS = [
  [/dogfood/i, "dogfood"],
  [/对抗|adversar/i, "adversary"],
  [/实现官|implement/i, "implementer"],
  [/侦察|scout|recon/i, "scout"],
  [/复审|review/i, "reviewer"],
];

const S = createHookScaffold({
  name: "dao-subagent-clauses",
  stateSubdir: "subagent-clauses",
  failTail: "本次没有注入任何条款正文，官只剩派单令首行 Read 那一条通道",
  forceErrorEnv: "DAO_SUBAGENT_CLAUSES_FORCE_ERROR",
  selfTestEnv: "DAO_SUBAGENT_CLAUSES_SELFTEST",
});

function mapRole(agentType) {
  const t = String(agentType || "");
  if (!t) return { role: null, how: "输入里没有 agent_type" };
  for (const [name, role] of AGENT_ROLE_EXACT) {
    if (t === name) return { role, how: `agent 名精确命中「${name}」` };
  }
  for (const [re, role] of AGENT_ROLE_KEYWORDS) {
    if (re.test(t)) return { role, how: `agent 名含关键词 ${re.source}（近似判断）` };
  }
  return { role: null, how: `agent 名「${t}」不含官种信息（通用底座的常态）` };
}

function resolveClauseFile(cwd) {
  if (process.env.DAO_CLAUSE_FILE) return { file: process.env.DAO_CLAUSE_FILE, how: "env DAO_CLAUSE_FILE" };
  for (const rel of CLAUSE_FILE_CANDIDATES) {
    const p = path.join(cwd || ".", rel);
    try { if (fs.existsSync(p)) return { file: p.replace(/\\/g, "/"), how: "按本次 cwd 探到" }; } catch (_) {}
  }
  return { file: KNOWN_CLAUSE_FILE, how: "本项目下没探到项目特有条款库，退到 dao 官侧通用档（通用判据仍适用；本仓具体跑什么命令这一半缺）" };
}

// 渲染端的末行契约：`CLAUSE_RENDER_SUMMARY exit=… role=… …`（见 render-clauses.mjs 头注）。
// 按它切开 JSON 正文与摘要行 —— 不用 --out 是刻意的：那会落一个派生文件，见头注「刻意不做的事」。
function splitMarker(stdout) {
  const lines = String(stdout || "").split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].startsWith("CLAUSE_RENDER_SUMMARY ")) {
      return { body: lines.slice(0, i).join("\n"), marker: lines[i] };
    }
  }
  return { body: String(stdout || ""), marker: "" };
}

function render(role) {
  const args = [RENDERER, "--role", role, "--format", "json"];
  if (process.env.DAO_CLAUSE_INDEX) args.push("--index", process.env.DAO_CLAUSE_INDEX);
  const r = spawnSync(process.execPath, args, {
    encoding: "utf8",
    timeout: RENDER_TIMEOUT_MS,
    // stdin 给空串：渲染端不读 stdin，但继承本进程的 stdin 会让它在某些宿主下挂住
    input: "",
  });
  const { body, marker } = splitMarker(r.stdout);
  if (r.error) return { ok: false, why: `渲染器起不来：${r.error.message}`, marker, code: null };
  if (r.status !== 0) {
    const first = String(body || r.stderr || "").split(/\r?\n/).filter(Boolean)[0] || "（无输出）";
    return { ok: false, why: `渲染器 exit=${r.status}：${first.trim()}`, marker, code: r.status };
  }
  try {
    const doc = JSON.parse(body);
    return { ok: true, doc, marker, code: 0 };
  } catch (e) {
    return { ok: false, why: `渲染结果不是合法 JSON：${e.message}`, marker, code: r.status };
  }
}

function anchorOf(c) {
  return `${c.file}:${c.line}-${c.line_end}`;
}

// 判据句形态：一条一行，带出处行号区间 —— 要全文的官按行号 Read 原文，不给他一份副本。
function titleLines(list) {
  return list.map((c) => `- ${c.title || c.body_excerpt || "(无判据句)"}　〔${anchorOf(c)} · 触发:${c.trigger}〕`);
}
function bodyLines(list) {
  return list.map((c) => `${c.body}\n　〔出处 ${anchorOf(c)} · id=${c.id}〕`);
}

// 上限钳制：**所有出口共用这一个**。这不是洁癖——首版把它只挂在「渲染成功」那条路上，
// 而降级路径（指针 + 降级原因 + 渲染器原话）恰恰可以很长；回归网当场逮到它超限。
// 硬截断时必须把「被截断了」写进文里：静默截断的那半在输出上看不出来。
function clamp(text) {
  if (text.length <= MAX_CONTEXT_CHARS) return text;
  const notice = `\n（⚠ 本次注入被硬截断在 ${MAX_CONTEXT_CHARS} 字符——单条内容就超过了上限。被截掉的部分见上面给出的 文件:行号。）`;
  return text.slice(0, Math.max(0, MAX_CONTEXT_CHARS - notice.length)) + notice;
}

function buildContext({ mapped, role, doc, degraded, clause, marker }) {
  const head = [
    `${SIGNATURE} agent_type=${mapped.agentType || "(空)"} → 官种=${role}（${mapped.how}）`,
    "这段文字由 SubagentStart hook 渲染，内容是本体系派单条款库里与这个官种相关的那些条款。" +
      "按 dao 既定协议，官在开工前通读通用节与自己那一节；条款正文的真相源是下面各条注明的文件与行号。",
  ];
  const tail = [];
  if (clause) {
    tail.push(
      `条款库正文（含各官种分节）：${clause.file}　〔${clause.how}〕。` +
        `若本次实际官种不是「${role}」——本事件拿不到派单 prompt，官种是按 agent 定义名推断的，` +
        `误判概率真实存在——按你所属官种那一节读那份文件即可，本段不构成范围限制。`
    );
  }
  if (degraded.length) {
    tail.push("⚠ 本次渲染有降级，照直写：" + degraded.join("；") + (marker ? `　〔渲染器末行：${marker}〕` : ""));
  }

  if (!doc) {
    return {
      text: clamp(head.concat(tail, ["（本次没有渲染出任何条款正文，上面那条路径是唯一入口。）"]).join("\n")),
      mode: "pointer-only",
      general: 0,
      roleClauses: 0,
    };
  }

  const general = doc.general || [];
  const roleClauses = doc.role_clauses || [];
  const stale = !!(doc._generated && doc._generated.stale);
  if (stale) tail.push("⚠ 渲染所用索引已过期（正文按行号现切，可能切错行）—— 以原文为准。");

  const sections = [];
  const bodyTotal = general.concat(roleClauses).reduce((a, c) => a + String(c.body || "").length, 0);
  // 判据里带一份头尾开销的估计（head 实际长度 + 出处行/标题行的粗估），宁可保守一点
  const overhead = head.join("\n").length + tail.join("\n").length + 60 * (general.length + roleClauses.length) + 200;

  const useBodies = bodyTotal + overhead <= MAX_CONTEXT_CHARS;
  const fmt = useBodies ? bodyLines : titleLines;

  if (general.length) sections.push(`## 通用节（${general.length} 条 · 任意官种都适用）`, ...fmt(general), "");
  if (roleClauses.length) sections.push(`## ${role} 节（${roleClauses.length} 条）`, ...fmt(roleClauses));

  if (!useBodies) {
    head.push(
      `本次给的是**每条的判据句 + 出处行号**，不是全文：条款正文合计 ${bodyTotal} 字符，加头尾后超过注入上限 ` +
        `${MAX_CONTEXT_CHARS}（宿主对超长注入会改成落文件+预览）。要读某条全文，按它后面的 文件:行号 区间 Read 原文。`
    );
  }

  // 仍超限：**逐条截断并把丢了几条说出来**。静默截断是本体系点名要防的病（无从核验型误裁）。
  let lines = head.concat("", sections, "", tail);
  let dropped = 0;
  while (lines.join("\n").length > MAX_CONTEXT_CHARS && sections.length > 1) {
    sections.pop();
    dropped++;
    lines = head.concat(
      "",
      sections,
      `（还有 ${dropped} 行条款未列进本次注入——注入上限 ${MAX_CONTEXT_CHARS} 字符所限，不是它们不适用；全部在条款库正文里。）`,
      "",
      tail
    );
  }

  return {
    text: clamp(lines.join("\n")),
    mode: useBodies ? "full-body" : "judgement-lines",
    general: general.length,
    roleClauses: roleClauses.length,
    dropped,
    stale,
  };
}

// stdout 单帧协议：只写一次（写第二次 = 两个拼接的 JSON = 宿主解析失败 = 本次全部输出被丢）。
// 上限钳制放在这个**唯一出口**上，而不是各条路径各钳一次：漏钳的必然是最少走的那条路径，
// 而最少走的那条正是降级路径 —— 首版就是这么漏的。clamp 幂等，重复调用无副作用。
function emitContext(text, systemMessage) {
  const payload = { hookSpecificOutput: { hookEventName: EVENT, additionalContext: clamp(String(text || "")) } };
  if (systemMessage) payload.systemMessage = systemMessage;
  S.emit(payload);
}

// ── --selfcheck ─────────────────────────────────────────────────────────────
// ①注册 ②真实心跳（自测心跳不采信）—— 这两段用公共脚手架（只抽形态不抽判据）。
// ③本 hook 自己的判据：渲染端此刻渲染得出什么。**它与主逻辑走的不是同一条判断**：
//   主逻辑问「这一次该给谁哪一节」，这里问「这台机器上还渲染得出东西吗」。
function selfcheck() {
  const r = S.selfcheckLines({
    event: EVENT,
    scriptName: "dao-subagent-clauses.js",
    covers: (m) => m === "" || m === "*" || /general-purpose/.test(m) || safeRe(m, "general-purpose"),
    matcherLabel: (m) => (m === "" ? "(空=全部 agent 类型)" : m),
    coversFailNote:
      " ⇒ matcher 覆盖不到 general-purpose（实测占历史派单 79.5%），那批 subagent 一条都收不到；" +
      "本事件的 matcher 匹配的是 agent 类型名，要全覆盖就写 \"*\"。",
    logPath: S.firedLog,
    missNote: "matcher 与 agent 类型名",
    describeLast: (l) => `agent_type=${l.agent_type} → 官种=${l.role} · 形态=${l.mode} · ${l.chars} 字符`,
    staleDays: 14,
    staleNote: (d) =>
      `⚠ 末次真实触发在 ${d} 天前 —— 期间要么没派过 subagent，要么这条接线已经断了，两者在日志上长得一样。`,
  });

  const lines = r.lines.slice();
  let bad = r.bad;

  // ③ 渲染端可用性 + 映射表退役观察线
  const probe = spawnSync(process.execPath, [RENDERER, "--list-roles"].concat(
    process.env.DAO_CLAUSE_INDEX ? ["--index", process.env.DAO_CLAUSE_INDEX] : []
  ), { encoding: "utf8", input: "", timeout: RENDER_TIMEOUT_MS });
  const out = String(probe.stdout || "");
  if (probe.status !== 0) {
    bad++;
    lines.push(`✗ 渲染端跑不起来（exit=${probe.status}）⇒ 每一次注入都会退成纯指针：${String(probe.stderr || out).slice(0, 200)}`);
  } else {
    const stale = /索引已过期/.test(out);
    if (stale) {
      bad++;
      lines.push("✗ 条款索引已过期 ⇒ 渲染端 fail-closed，本 hook 每次都只能给指针。修法：node ccswitch/scripts/gen-clause-index.mjs");
    }
    const counts = {};
    for (const m of out.matchAll(/^\s{2}(\S+)\s+(\d+)\s*$/gm)) counts[m[1]] = Number(m[2]);
    lines.push(`ⓘ 当前索引各官种条数：${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(" ")}`);
    const mapped = [...new Set(AGENT_ROLE_EXACT.map((x) => x[1]).concat(AGENT_ROLE_KEYWORDS.map((x) => x[1])))];
    const empty = mapped.filter((role) => !counts[role]);
    if (empty.length) {
      lines.push(
        `ⓘ 映射表里这些官种今天渲染不出东西（索引里 0 条）：${empty.join(" / ")} ⇒ 派给它们的官会退到通用节+指针。` +
          "这是观察线不是闸：0 条既可能是「该退役这行映射」，也可能是「索引的源清单里没有带官种分节的语料」，机器分不出，人来判。"
      );
    }
  }
  lines.push(
    "ⓘ 本 hook 未注册时条款并非零投递：派单令首行「Read docs/rules/dispatch-clauses.md」那条通道仍在（双通道过渡，" +
      "哪条退役依注册后的注入率审计数据定，不在本批预判）。"
  );

  process.stdout.write(`[dao-subagent-clauses --selfcheck]\n` + lines.map((s) => "  " + s).join("\n") + "\n");
  process.exit(bad ? 1 : 0);
}

function safeRe(m, sample) {
  try { return new RegExp(m).test(sample); } catch (_) { return false; }
}

if (process.argv.includes("--selfcheck")) {
  try { selfcheck(); } catch (e) {
    process.stderr.write(`[dao-subagent-clauses] selfcheck 异常：${e.message}\n`);
    process.exit(1);
  }
}

// ── 主路径 ──────────────────────────────────────────────────────────────────
let input = null;
let inputErr = null;
try {
  S.maybeForceError("parse");
  const raw = fs.readFileSync(0, "utf8");
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object") throw new Error("stdin JSON 不是对象");
  input = parsed;
} catch (e) {
  inputErr = e;
}

try {
  const cwd = input ? String(input.cwd || process.cwd()) : process.cwd();
  const clause = resolveClauseFile(cwd);

  if (!input) {
    // 输入坏掉也不静默：给指针 + 留痕。**这是 fail-open 的正确形态**——
    // 「什么都不注入」与「注入成功」在 transcript 上不可区分，那正是要防的死法。
    const msg = `[dao-subagent-clauses] 解析 stdin 失败：${inputErr && inputErr.message}`;
    try { process.stderr.write(msg + "\n"); } catch (_) {}
    S.appendErrorLog(msg, inputErr);
    // synthetic: true —— 输入没解析出来就判不了它是不是宿主真实调用（判据本来就是看 transcript_path）。
    // **不知道时记成"不算数"**：让 --selfcheck 少信一条，好过让一次坏输入把接线冒充成活的。
    S.heartbeat({ at: new Date().toISOString(), synthetic: true, agent_type: null, role: null, mode: "pointer-only", chars: 0, error: String(inputErr && inputErr.message) });
    emitContext(
      [
        `${SIGNATURE} agent_type=(输入解析失败) → 官种=未知`,
        `本次没能渲染条款（${inputErr && inputErr.message}）。派单条款库正文在 ${clause.file}〔${clause.how}〕，` +
          "按 dao 既定协议，官在开工前通读通用节与自己所属官种那一节。",
      ].join("\n"),
      msg + "（本次只注入了指针，没有条款正文）"
    );
    process.exit(0);
  }

  const agentType = String(input.agent_type || "");
  const mapped = mapRole(agentType);
  mapped.agentType = agentType;
  const degraded = [];

  let role = mapped.role || "general";
  if (!mapped.role) degraded.push(`官种映射不出（${mapped.how}），本次按通用节渲染`);

  // 故障注入的第二档：`=1` 打的是 stdin 解析那一段（走"输入坏掉"的降级路径），
  // `=render` 打的是这里（走最外层 catch 的"hook 自己崩了"路径）—— 两条降级路径要分别验得到。
  if (process.env.DAO_SUBAGENT_CLAUSES_FORCE_ERROR === "render") {
    throw new Error("人为注入故障（DAO_SUBAGENT_CLAUSES_FORCE_ERROR=render）@render");
  }
  let r = render(role);
  if (!r.ok && role !== "general") {
    degraded.push(`「${role}」节渲染不出（${r.why}），退到通用节`);
    role = "general";
    r = render(role);
  }
  if (!r.ok) degraded.push(`通用节也渲染不出（${r.why}）`);

  const built = buildContext({
    mapped,
    role,
    doc: r.ok ? r.doc : null,
    degraded,
    clause,
    marker: r.marker,
  });

  S.heartbeat({
    at: new Date().toISOString(),
    synthetic: S.isSynthetic(input),
    session_id: input.session_id || null,
    agent_id: input.agent_id || null,
    agent_type: agentType || null,
    role,
    mapped: !!mapped.role,
    mode: built.mode,
    general: built.general,
    role_clauses: built.roleClauses,
    dropped: built.dropped || 0,
    stale: !!built.stale,
    degraded,
    chars: built.text.length,
  });

  emitContext(built.text);
  process.exit(0);
} catch (e) {
  // 本 hook 自己崩了：仍然注入指针 + 三重留痕，exit 恒 0（绝不砖掉 subagent）
  const msg = `[dao-subagent-clauses] 注入失败：${e && e.message}`;
  try { process.stderr.write(msg + "\n"); } catch (_) {}
  S.appendErrorLog(msg, e);
  const clause = resolveClauseFile(input ? String(input.cwd || process.cwd()) : process.cwd());
  emitContext(
    [
      `${SIGNATURE} agent_type=${(input && input.agent_type) || "(未知)"} → 官种=未知（hook 内部异常）`,
      `本次没能渲染条款（${e && e.message}）。派单条款库正文在 ${clause.file}〔${clause.how}〕，` +
        "按 dao 既定协议，官在开工前通读通用节与自己所属官种那一节。",
    ].join("\n"),
    msg + "（本次只注入了指针，没有条款正文）"
  );
  process.exit(0);
}
