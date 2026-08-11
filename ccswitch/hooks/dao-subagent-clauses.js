// dao-subagent-clauses.js — SubagentStart · 把「只给你这一份」的条款渲染进 subagent 的开场上下文
//
// 它在补派单首行通道的两个弱处：①首行是**槽位档**（敲不敲没程序核）；②首行给的是**整份文件**，
// 而带量化的杠杆是 Quote 形态（只渲染「与你那一条」相关，遵守率 17-40% → 76-77%）。
// 本 hook 走 SubagentStart：subagent 一被创建就把渲染结果放进它的开场上下文，不需要任何人记得。
//
// ── 宿主能力（禁笃定措辞，逐条标明依据）────────────────────────────────────
//   ✅ 已实测（读安装的 cli.js）：事件存在；payload 字面量
//      {…common, hook_event_name:"SubagentStart", agent_id:A, agent_type:q}；
//      输入含 session_id / transcript_path / cwd / permission_mode / agent_id / agent_type，
//      **没有 prompt 字段** —— 派单令正文在这里拿不到，官种只能从 agent_type 推（见下）。
//      ⚠ transcript_path 是**主会话**的转录，subagent 自己的转录此刻还不存在。
//   ✅ 输出 schema 只接受 hookSpecificOutput.additionalContext（zod 字面量），
//      随 type:"hook_additional_context" 推进 subagent 的开场消息列表 ⇒ 不能阻断创建、不能改 prompt。
//   ✅ 官方文档：matcher 匹配 agent 类型名；additionalContext 出现在「第一个 prompt 之前」；
//      **单个值超过 10,000 字符时宿主改为落文件 + 给一段预览**（本机 cli.js 未找到实现点，
//      只有文档依据 ⇒ 本 hook 一律压在 MAX_CONTEXT_CHARS=9000 以内，两种宿主行为下都安全）。
//   ✅ 真实 session 响过：本机真实派单的 subagent 开场收到注入并回报渲染末行
//      CLAUSE_RENDER_SUMMARY exit=0 role=general general=70 role_clauses=0 stale=0。
//      **注入率**（派 N 个官、几个真收到）仍未审计——那是退役「首行 Read」双通道的前置门
//      （契约：≥20 次注入率 100%），别把这一格读成已解决。
//
// ── 映射表：泛型降级是主路径不是异常路径 ───────────────────────────────────
// 实测 803 次 Task 派单里 753 次（93.8%）的 agent_type 不含官种信息（通用底座），
// 官种写在派单 prompt 正文里而本事件拿不到 ⇒ **「映射不出」是常态**，泛型降级那一支必须做好。
// 想让官种渲染真正生效得改**派单侧**（按官种选 agent type），不是在这张表上堆名字。
//
// ── 三条 fail-closed / 一条 fail-open，别混为一谈 ────────────────────────────
// 渲染端（render-clauses.mjs）是 fail-closed 的：索引过期、官种名不认识、该官种零条款，
// 一律 exit 1 而不吐一份看起来正常的东西。本 hook **不推翻它的判断**，只做一件事：
// **把它的失败翻译成一条指针注入**（「正文在哪、按哪一节读」），而不是静默不注入。
// ⇒ 四条降级路径：**索引不可信（stale=1）→ 指针，且不退官种**；官种节渲染不出 → 退到通用节
// 并写明；通用节也渲染不出 → 只给指针；本 hook 自己崩了 → 仍然只给指针 + systemMessage 留痕
// （**exit 恒 0**，绝不砖掉 subagent）。「永不静默空过」是第一原则：零注入与注入成功在
// transcript 上长得一样。每条路径的产出都带首行签名 [dao-subagent-clauses v1]，审计取证靠
// Grep 那个签名。
//
// ── 刻意不做的事 ─────────────────────────────────────────────────────────────
//   · **不落任何派生文件**（不写渲染产物 md）：派生副本必漂移；且守卫铁律「检查器的输出
//     不能落在它自己的扫描面内」——渲染产物逐字带着 [n= @ 触发:] 元字段，一旦有人把输出
//     目录加进索引源清单，它会被当成条款重新扫进去，每跑一次翻一倍。
//     要全文的按注入里给的 文件:行号 区间 Read 原文，**原文才是真相源**。
//   · **不动「首行 Read」双通道**：哪条通道该退役看注入率审计数据，不在本批预判。
//   · **不写 live settings.json / cc-switch DB**：注册是用户动作（硬闸 G2）。
//
// ── 官种节渲染得出来了，但别把它读成「这条通道已经活了」────────────────────
// 带官种分节的语料已进仓（dao-officer-clauses.md，六个官种节齐全）⇒ 默认语料里官种节渲得出。
// 但实证里 role 仍是 general、官种节 0 条——通道活着，**官种筛选空转**。这不是本文件的
// 缺陷，是 agent_type 上没有官种信息（见上「映射表」段），修法在派单侧；它生效没有由
// 下一批派单注入里 role= 还是不是 general 判定。
//
// ── 「语料源读不到」那一支：为什么单独成一条路径 ───────────────────────────
// 渲染端现算化后「索引过期」不存在了。剩下的失败分两格：①官种节 0 条 ⇒ 退通用节再渲一次
// 是对的；②语料源读不到 —— 对**每个**官种都一样，退通用节必然以同样的理由失败，只是多花
// 一次进程；而退了官种，指针就再也说不出「你那一节是哪一节」⇒ **这一支不退官种**。
// 本 hook 只认渲染端报文里「读不到」这个信号，不替它细分成因（细分 = 复刻渲染端判据，
// 它改了这边不会知道）。
//
// 项目特有那半仍在各项目仓，不进本仓默认语料清单。要临时把某个项目那份也算进来：
// 写一份 sources-json（[{file,selector,role_scheme}]）然后 DAO_CLAUSE_SOURCES=<清单路径>。
// 末行契约的 stale= 字段恒为 0（现算无新鲜度问题），字段保留只是不让旧消费方解析失锚。
//
// ── 这张映射表将来怎么退役 ───────────────────────────────────────────────────
// 映射表只增不减。留给它的触发器是 --selfcheck 第③段：逐条打印表里每个官种当前渲染出几条
// ——长期 0 条的那些行就是该问「这一行还有意义吗」的对象。这是观察线不是闸。
//
// ── 指针档自声明：条款正文源不一定是探到的那份 ─────────────────────────────
// 「按 cwd 探到项目侧条款库就指它」在**自己就是规则源**的仓里会指错：那种仓的项目侧档只装
// 判重面与落地坐标、**没有条款正文**，注入却自称「条款库正文」。修法是**让那份档自己声明**：
// 头部写一行 <!-- dao-clause-pointer …，本 hook 有界读头部认它，认出来就把正文源退回
// 官侧档、另附一行「项目侧（指针档）：<路径>」。**自声明是结构决定的、零近似**（作者在头部
// 写一行标记，机器只认那行标记在不在）。判据与射程见 POINTER_MARK_RE 那一段。
// 别的项目零影响：没标记 ⇒ 一个字不变。**它治的是「指针指错」，不是「注入率」**，别把这条
// 读成那两件事。
//
// 回归网：tests/subagent-clauses.tests.js（映射正控 / 泛型降级 / 渲染失败降级 / fail-open /
//          指针档两态 / mutation 双向）
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
// **订正的倒置依赖**：这里原先写死 `D:/frank/mousse-cli/docs/rules/dispatch-clauses.md`
// —— **一个本机绝对路径 + 某一个项目的文件**。它有两种坏法且都静默：换台机器指向空气
// （降级路径本身失效，而 hook 照常 exit 0），换个项目指向别人的账本（拿 A 仓的验证入口、
// 进程名、专有脚本去指导 B 仓的官）。现在退到**仓内相对路径**，随本仓走、随本文件搬。
// **射程照直写**：退到通用档只补得上「怎么做」那一半，项目特有那半（跑哪个命令）没探到就是
// 没有，注入文本里因此明写这一点，不假装两半都给了。
const CLAUSE_FILE_CANDIDATES = ["docs/rules/dispatch-clauses.md", ".claude/rules/dispatch-clauses.md"];
const KNOWN_CLAUSE_FILE = path.join(ROOT, "ccswitch", "rules", "dao-officer-clauses.md").replace(/\\/g, "/");

// ── 指针档自声明 ────────────────────────────────────────────────────────────
// **要治的病**：「自己就是规则源」的仓（windsurf-dao 本身就是一例）里，条款正文住在仓内的
// `ccswitch/` 下，项目侧那份 `docs/rules/dispatch-clauses.md` 只装判重面与落地坐标、**刻意
// 一个字的条款正文都不放**（同一个仓放副本，副本从落笔那刻起就开始漂移）。而上面那段探测
// 「探到项目侧档就指它」于是把官指向了一份没有条款正文的文件，注入里还自称「条款库正文
// （含各官种分节）」—— **那句话变成假的，而没有任何东西会红**。
//
// **修法取「自声明」而不是「机器猜」**（三条备选里选定这条的理由，照直记，省得下次重走）：
//   · 甲「读它有没有 `## 通用节` 之类的正文签名」= **近似判断**，两个方向都构造得出反例；
//   · 乙「两个指针都给」= 注入长度本来就压在 9000 上限边缘（本仓真索引下已退成判据句形态）；
//   · 丙「识别 dao 仓自己」= 只治本仓，换个同型仓再撞一次。
//   ⇒ **自声明是结构决定的，零近似**：作者在头部写一行标记，机器只认那行标记在不在。
//
// **判据刻意写窄，两侧都说清**：①只读**头部有界窗口**（默认 4096 字节），不读全文——
// 正文里提到这个词不会被误判，且大文件不会被整份读进内存；②标记必须**行首**是 `<!--`
// （HTML 注释开头），句中提及匹配不上。两条合起来让「提到它」与「声明是它」分得开。
//
// **射程边界照直写**：只作用在**按 cwd 探到**的那两个候选路径上。`DAO_CLAUSE_FILE` 那条 env
// 覆写**刻意不走这道判断** —— 它是「换机/换项目」的逃生口，优先级最高，显式指了什么就是什么，
// 在逃生口上再加一层推断会让它不再是逃生口。
// 回归网：tests/subagent-clauses.tests.js §④′（两态 + 有界窗口边界）与 §⑨ M4（恒判非指针的反向 mutation）。
const POINTER_MARK_RE = /^<!--\s*dao-clause-pointer\b/m;
const POINTER_PROBE_BYTES = Number(process.env.DAO_CLAUSE_POINTER_PROBE_BYTES || 4096);
const POINTER_HOW =
  "本项目侧那份是**指针档**（头部自带 dao-clause-pointer 标记、不含条款正文），故正文取 dao 官侧档";

// 有界读头部：openSync + 单次 readSync，不把整份文件读进来。
// 读不到（不存在/无权限/是目录）一律返回 null ⇒ 判为「非指针档」走原行为，**绝不因此抛异常**：
// 这条路径上任何一次抛出都会把 hook 打进最外层 catch，代价是整次注入退成纯指针。
function headOf(p, bytes) {
  let fd = null;
  try {
    fd = fs.openSync(p, "r");
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.slice(0, n).toString("utf8");
  } catch (_) {
    return null;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch (_) {} }
  }
}

function isPointerDoc(p) {
  const head = headOf(p, POINTER_PROBE_BYTES);
  return head !== null && POINTER_MARK_RE.test(head);
}

// 注入末尾那一行：**只在判为指针档时出现**。没有它的话，官只知道「正文在官侧档」，
// 不知道这个仓还有一份装着「跑哪个命令」的项目侧档 —— 而协议是两份都读。
function pointerLine(clause) {
  if (!clause || !clause.pointer) return null;
  return (
    `项目侧（指针档）：${clause.pointer}　〔它自己声明不含条款正文，装的是本仓的判重面与落地坐标` +
    `（跑哪个命令 / 账本在哪 / 再生成命令序）——**协议是两份都读**：官侧档答「怎么判」，它答「在这个仓里怎么做」。〕`
  );
}

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
    try {
      if (fs.existsSync(p)) {
        const found = p.replace(/\\/g, "/");
        // 指针档自声明：探到之后有界读头部认标记（见上面 POINTER_MARK_RE 那一段头注）
        if (isPointerDoc(p)) return { file: KNOWN_CLAUSE_FILE, how: POINTER_HOW, pointer: found };
        return { file: found, how: "按本次 cwd 探到" };
      }
    } catch (_) {}
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

// 渲染端失败报文里那条修法命令，**原样摘出来带进注入**，不在本文件里另存一份字面量：
// 存一份就是双写，而双写必漂移（脚本改名时，漂移出来的那条错命令读者会照着敲）。
function regenHintOf(body) {
  for (const ln of String(body || "").split(/\r?\n/)) {
    if (/clause-sources\.mjs|--sources-json/.test(ln)) return ln.replace(/^[\s·⇒>]+/, "").trim();
  }
  return null;
}

function render(role) {
  const args = [RENDERER, "--role", role, "--format", "json"];
  if (process.env.DAO_CLAUSE_SOURCES) args.push("--sources-json", process.env.DAO_CLAUSE_SOURCES);
  const r = spawnSync(process.execPath, args, {
    encoding: "utf8",
    timeout: RENDER_TIMEOUT_MS,
    // stdin 给空串：渲染端不读 stdin，但继承本进程的 stdin 会让它在某些宿主下挂住
    input: "",
  });
  const { body, marker } = splitMarker(r.stdout);
  if (r.error) return { ok: false, why: `渲染器起不来：${r.error.message}`, marker, hint: null, code: null };
  if (r.status !== 0) {
    const text = String(body || r.stderr || "");
    const first = text.split(/\r?\n/).filter(Boolean)[0] || "（无输出）";
    return { ok: false, why: `渲染器 exit=${r.status}：${first.trim()}`, marker, hint: regenHintOf(text), code: r.status };
  }
  try {
    const doc = JSON.parse(body);
    return { ok: true, doc, marker, hint: null, code: 0 };
  } catch (e) {
    return { ok: false, why: `渲染结果不是合法 JSON：${e.message}`, marker, hint: null, code: r.status };
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

function buildContext({ mapped, role, doc, degraded, clause, marker, sourceDead, regenHint }) {
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
    const pl = pointerLine(clause);
    if (pl) tail.push(pl);
  }
  if (degraded.length) {
    tail.push("⚠ 本次渲染有降级，照直写：" + degraded.join("；") + (marker ? `　〔渲染器末行：${marker}〕` : ""));
  }

  if (!doc) {
    // ── 降级指针：**这几行就是本次注入的全部内容**，所以它必须自己说完「去哪读、读哪两节」──
    // 祈使句 + 具体节名，才是一条指得动人的指针。
    const where = clause ? `\`${clause.file}\`` : "本体系的派单条款库正文";
    const ptr = [
      "🔴 " +
        (sourceDead
          ? "**条款语料源读不到**（渲染端报文见上），故本次**没有渲染出任何条款正文**——" +
            "这是渲染端刻意的 fail-closed：源缺了还照渲染，给的就是一份缺斤少两却看起来正常的东西。"
          : "**本次没有渲染出任何条款正文**（成因见上一行）。"),
      `⇒ **开工前自己去 Read ${where}：通读「通用节」＋ 你所属官种那一节` +
        `（本次按 agent 定义名推断为「${role}」，误判概率真实存在——与实际不符时读你自己那一节，本段不构成范围限制）**，逐条遵守。`,
    ];
    if (sourceDead) {
      ptr.push(
        "（修法归帅、不是你这一路的活" +
          (regenHint ? `：${regenHint}` : "，见渲染端自己的报文") +
          "；你照上面那条指针读原文即可，原文本来就是真相源。）"
      );
    }
    return {
      text: clamp(head.concat(tail, ptr).join("\n")),
      mode: sourceDead ? "source-dead-pointer" : "pointer-only",
      general: 0,
      roleClauses: 0,
    };
  }

  const general = doc.general || [];
  const roleClauses = doc.role_clauses || [];

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
    process.env.DAO_CLAUSE_SOURCES ? ["--sources-json", process.env.DAO_CLAUSE_SOURCES] : []
  ), { encoding: "utf8", input: "", timeout: RENDER_TIMEOUT_MS });
  const out = String(probe.stdout || "");
  if (probe.status !== 0) {
    bad++;
    lines.push(`✗ 渲染端跑不起来（exit=${probe.status}）⇒ 每一次注入都会退成纯指针：${String(probe.stderr || out).slice(0, 200)}`);
  } else {
    const unreadable = /有源读不到/.test(out);
    if (unreadable) {
      bad++;
      lines.push("✗ 条款语料有源读不到 ⇒ 渲染端 fail-closed，本 hook 每次都只能给指针。修法：核语料清单（默认清单见 node ccswitch/scripts/clause-sources.mjs）");
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
      ].concat(pointerLine(clause) || []).join("\n"),
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
  // ── 语料源读不到：单独一支，**不退官种**（头注那支的判据）──
  const sourceDead = !r.ok && /读不到/.test(r.why || "");
  if (sourceDead) {
    degraded.push(`条款语料读不到（${r.why}）⇒ 本次降级为指针，官种保持「${role}」不退`);
  } else {
    if (!r.ok && role !== "general") {
      degraded.push(`「${role}」节渲染不出（${r.why}），退到通用节`);
      role = "general";
      r = render(role);
    }
    if (!r.ok) degraded.push(`通用节也渲染不出（${r.why}）`);
  }

  const built = buildContext({
    mapped,
    role,
    doc: r.ok ? r.doc : null,
    degraded,
    clause,
    marker: r.marker,
    sourceDead,
    regenHint: r.hint,
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
    ].concat(pointerLine(clause) || []).join("\n"),
    msg + "（本次只注入了指针，没有条款正文）"
  );
  process.exit(0);
}
