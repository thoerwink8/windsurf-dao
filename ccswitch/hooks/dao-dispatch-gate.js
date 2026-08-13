// dao-dispatch-gate.js — 派活底座闸（PreToolUse · exit 2 阻断）
//
// 一句话职责：拦住「用本地 Agent 工具起会写盘的工兵」。判据出处是 issue #409 与用户
// 2026-08-13 的两条修订（本地 subagent 只剩两个合法场景：只读小勘察 + Orca 真死了的降级）。
//
// 改这个文件前必须知道的六条：
//
// 1. **本 hook 自己崩掉时放行（fail-open），不是拦截。** 宿主对命令型钩子的失效态就是放行
//    （只有 exit 2 拦得住），所以一道会因自身 bug 拦死一切的闸没有逃生通道 = 会话直接砖掉。
//    代价是「放行」与「通过」在退出码上长得一样，故 catch 里必打一行显眼 stderr。
//
// 2. **闸内零外部命令、零探测。** 判 Orca 死活是**读**一份别处已经写好的缓存（W1 那半：
//    `scripts/dao-roster.mjs` 落盘 + SessionStart 钩子刷新）。一次同步 spawn 就能把同一挂载点上
//    的所有闸拖到超时，而超时 = 放行。热路径上唯一的 I/O 是一次 readFileSync。
//
// 3. **判据只用结构化字段**（`tool_input.isolation` / agent 类型字段），**不去 prompt 正文里
//    grep 关键词**。正文关键词是近似手段，本单没有外部语料来源可以校准它的两侧误差。
//
// 4. **判据是近似的，两侧都有反例。** 漏报：本表没收录的显式类型名去干写盘活；
//    `isolation` 若有 `worktree` 以外的写盘形态（盘上无样本）。误报：拿写权官种、全权底座、
//    或**不填类型字段**去干一件纯只读的活（代价是一次被拦 + 三条可抄的换法，见拦截消息末段）。
//    刻意不去解析 prompt 正文。
//    🔴 **不填类型字段 = 宿主按缺省全权底座起 ⇒ 与显式 `general-purpose` 同一物 ⇒ 一样拦**
//    （W3 换家审 R1，树帅 2026-08-13 裁定）。拦显式、放隐式是闸内部自相矛盾，
//    而且那等于「少填一个字段就绕过全权底座那道裁决」——一个字段就能绕的禁令等于没有。
//
// 5. **`--selfcheck` 不许复用主逻辑的缓存解析**（它只读 live settings.json 回答「我到底接上没有」），
//    **但必须能看见主逻辑判据死没死**。两件事不是一回事：两半不共享解析所以不会一起瞎，
//    可「decide 被改成恒放行」是静默 exit 0（没抛异常就没有 fail-open 告警），而只答注册面的自检
//    照样报健康 —— **主逻辑死掉那一刻自检看着是绿的**（W3 换家审 R4 实测）。
//    ⇒ 自检末尾有 canary：拿合成缓存对必拦/必放两个 payload 真跑一遍 `decide()`，对不上即 exit 1。
//    canary 用的是**临时目录里现造的缓存**，不读真缓存——真缓存坏掉不许砸掉注册结论。
//
// 6. **本闸的退役触发器**（规则只增不减是结构必然，所以退役条件写在这里、并由自测钉住）：
//    ① roster 探测面若不再产出 `fabric.orca`，本闸的输入恒为「判不出」⇒ 全路降级放行，
//       那时它已是空壳，删掉它；`tests/dao-dispatch-gate.tests.js` 有一条断言盯着这个来源，
//       来源没了会红。② issue #409 那条用户拍板若被推翻（本地 subagent 重回常态），同样删。
//
// 自检：`node ccswitch/hooks/dao-dispatch-gate.js --selfcheck`（在 live settings.json 的 PreToolUse
// 里注册了没有 / matcher 覆不覆盖 GATE_TOOLS；未注册或失覆盖 exit 1）。
// ⚠ 注册的真实下发面是 cc-switch DB `providers` 表每个 provider 的 `settings_config`，写 git 快照层
//   或 DB 的 `common_config_*` 都不生效，且属**用户动作**（详见 `dao-hard-gates.js` 头注末段那个 ⚠）。
//   ⇒ 本闸此刻很可能**未注册**，`--selfcheck` 会照直说；**任何测试都不许依赖「已注册」**。
// 闸的自测：`node tests/dao-dispatch-gate.tests.js`，由 `node scripts/dao-check.mjs` 统一跑。
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const REPO = path.resolve(__dirname, "..", "..");

// ── 路径与常量（契约冻结，两边逐字一致）──────────────────────────────────────
// 🔴 这三份是**独立实现的第二份**：真相源在 `scripts/dao-roster.mjs`（ESM），hooks 是 CJS
//    import 不了它。两份必然漂移，所以自测里有一条「逐字相等」的闸盯着（写了指针就配一道会红的闸）。
//    改这里 = 同一批去看那边。env 在**调用时**读，不在模块加载期——测试靠 env 把落点指到临时目录。
function homeDir() {
  return process.env.USERPROFILE || process.env.HOME || os.homedir();
}
function rosterCachePath() {
  return process.env.DAO_ROSTER_CACHE || path.join(homeDir(), ".claude", "dao-roster-cache.json");
}
function degradeLogPath() {
  return process.env.DAO_DEGRADE_LOG || path.join(homeDir(), ".claude", "dao-degrade-log.jsonl");
}
function ttlMs() {
  return Number(process.env.DAO_ROSTER_TTL_MS) || 2 * 60 * 60 * 1000; // 2 小时
}

// 本闸声明要拦的工具名（供 --selfcheck 核 matcher 覆盖面）。**声明面窄，自检就跟着一起瞎。**
const GATE_TOOLS = ["Agent", "Task"];

// 宿主真实入参里 agent 类型的键名。`subagent_type` 是盘上实证过的那个（会话档里的 Agent
// tool_use input 就长这样）；另两个是同族写法，一并读——多读一个键零成本，猜错一个键即全盲。
const AGENT_TYPE_KEYS = ["subagent_type", "agentType", "agent_type"];

// 「会写盘的工兵」= 官种自己声明了写权。**这张表不是手写清单，是 `ccswitch/agents/*.md` 的
// frontmatter `tools:` 里含 Write/Edit 的那些名字**——自测按目录实况重算一遍双向比对，
// 加了新官种或给旧官种开了写权而没进表，dao check 会红（清单必须是实况的派生物）。
const WRITER_AGENT_TYPES = [
  "dao-adversary",
  "dao-dogfood",
  "dao-implementer",
  "dao-plan-writer",
  "dao-spec-writer",
  "dao-strategist",
  "dao-worker-batch",
];

// 全权底座（工具面无边界，写盘只是它的一个用法）。收进来的理由是 issue #409 正文那件事本身：
// 被抓到的那次「协调者用本地 subagent 派实现官」走的就是通用底座，不是某个写权官种；
// 只收官种表 = 精确地守住上次出事的位置，而风险已经长在别处。
// 代价照直说：拿通用底座干只读小勘察会被误拦一次，换法在拦截消息末段（改用只读官种）。
const FULL_ACCESS_AGENT_TYPES = ["claude", "general-purpose"];

// 拦截消息里推荐的只读官种。**不是随手写的名字**：自测按 `ccswitch/agents/*.md` 的实况核，
// 这里的每一个都必须在那儿、且确实没有 Write/Edit 写权——哪天谁给它们开了写权，dao check 会红
// （一条指向空气的建议比没有建议更糟：照做的人会以为自己走了合法路径）。
const READONLY_HINT_TYPES = ["dao-scout", "dao-reviewer", "dao-reviewer-critical", "dao-brainstormer", "dao-debugger"];

// ── 判据 ────────────────────────────────────────────────────────────────────

function agentTypeOf(toolInput) {
  for (const k of AGENT_TYPE_KEYS) {
    const v = toolInput && toolInput[k];
    if (typeof v === "string" && v) return v;
  }
  return "";
}

/** 写盘特征：命中任一即算「会写盘的工兵」；都不命中 ⇒ 只读侦察那一格，自然放行。 */
function writerFeature(toolInput) {
  const ti = toolInput || {};
  if (ti.isolation === "worktree") {
    return { kind: "isolation", detail: "`isolation: \"worktree\"`（要独占工作树写文件）" };
  }
  const type = agentTypeOf(ti);
  // 🔴 一个字段都没填 ⇒ 宿主按缺省全权底座起，与显式 `general-purpose` 是同一个东西 ⇒ 一样算写盘特征。
  //    （树帅 2026-08-13 裁定，出处 W3 换家审 R1；不这么判，任何人少填一个字段就绕过全权底座那道裁决。）
  if (!type) {
    return { kind: "agentTypeMissing", detail: "入参里没有任何 agent 类型字段 ⇒ 宿主按**缺省全权底座**起（与显式 `general-purpose` 同一物）" };
  }
  if (WRITER_AGENT_TYPES.includes(type)) {
    return { kind: "agentType", detail: `agent 类型 \`${type}\`（该官种自己声明了 Write/Edit 写权）` };
  }
  if (FULL_ACCESS_AGENT_TYPES.includes(type)) {
    return { kind: "agentType", detail: `agent 类型 \`${type}\`（全权底座，工具面无边界）` };
  }
  return null;
}

/**
 * 读 roster 缓存。返回 state：
 *   fresh   —— 拿到了且在 TTL 内（roster 可用）
 *   missing —— 文件不在
 *   parse   —— 读到了但解析不了 / `at` 不是可解析的时间
 *   stale   —— 解析成功但超出 TTL
 * 🔴 只读文件，不跑任何命令。`fabric.orca` 取不到时按 available=undefined 交给上层（≠ true ⇒ 降级）。
 */
function readRosterCache(cachePath) {
  let raw;
  try {
    raw = fs.readFileSync(cachePath, "utf8");
  } catch (e) {
    return { state: "missing", why: (e && e.code) || "read-failed" };
  }
  let roster;
  try {
    roster = JSON.parse(raw);
  } catch (e) {
    return { state: "parse", why: "JSON.parse: " + (e && e.message) };
  }
  if (!roster || typeof roster !== "object") return { state: "parse", why: "缓存不是一个对象" };
  const at = Date.parse(roster.at);
  if (!Number.isFinite(at)) return { state: "parse", why: "`at` 不是可解析的时间：" + JSON.stringify(roster.at) };
  const ageMs = Date.now() - at;
  if (ageMs > ttlMs()) return { state: "stale", roster, ageMs };
  return { state: "fresh", roster, ageMs };
}

/**
 * 判定表（契约第三节）。返回：
 *   {action:"allow"}                          放行，不留痕
 *   {action:"degrade", ...}                   放行 + 落一行降级留痕
 *   {action:"block", what, why, cacheState}   exit 2
 */
function decide(input) {
  const tool = (input && input.tool_name) || "";
  if (!GATE_TOOLS.includes(tool)) return { action: "allow", reason: "工具名不在覆盖内" };

  const feature = writerFeature(input && input.tool_input);
  if (!feature) return { action: "allow", reason: "无写盘特征（只读侦察走这一格）" };

  const cachePath = rosterCachePath();
  const c = readRosterCache(cachePath);

  if (c.state !== "fresh") {
    return {
      action: "block",
      cacheState: c.state,
      what: `要用本地 \`${tool}\` 起一个会写盘的工兵——${feature.detail}`,
      why:
        c.state === "missing" ? `roster 缓存不在（${cachePath}）` :
        c.state === "parse" ? `roster 缓存读得到但解析不了：${c.why}` :
        `roster 缓存过期了（探测于 ${c.roster && c.roster.at}，已超 ${Math.round(ttlMs() / 60000)} 分钟的新鲜度窗口）`,
    };
  }

  const orca = (c.roster.fabric && c.roster.fabric.orca) || {};
  if (orca.available === true) {
    return {
      action: "block",
      cacheState: "fresh",
      what: `要用本地 \`${tool}\` 起一个会写盘的工兵——${feature.detail}`,
      why: `而 Orca 此刻是活的（${c.roster.at} 探测：orca available=true）`,
    };
  }

  // available !== true（false 或 "unknown"）⇒ 保降级通道不卡人（用户修订②）。
  // 取 `!== true` 而不是 `=== false`：判不出死活时误放的代价是一次没走 Orca 且盘上有记录，
  // 误拦的代价是极端时刻卡死。
  return {
    action: "degrade",
    orcaAvailable: orca.available === undefined ? null : orca.available,
    orcaReason: orca.reason || null,
    rosterAt: c.roster.at || null,
    feature,
  };
}

// ── 降级留痕（用户修订②：人一个字不写，闸自己记）────────────────────────────
// 🔴 写失败不许影响放行：这一步的任何异常都吞掉，最多 stderr 一行。
function logDegrade(input, d) {
  const rec = {
    at: new Date().toISOString(),
    cwd: (input && input.cwd) || process.cwd(),
    tool: (input && input.tool_name) || "",
    agentType: agentTypeOf(input && input.tool_input) || null,
    isolation: ((input && input.tool_input) || {}).isolation || null,
    orcaAvailable: d.orcaAvailable,
    orcaReason: d.orcaReason,
    rosterAt: d.rosterAt,
  };
  const p = degradeLogPath();
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, JSON.stringify(rec) + "\n", "utf8");
  } catch (e) {
    process.stderr.write(`[dao-dispatch-gate] ⚠ 降级留痕写不进 ${p}：${e && e.message}（放行不受影响）\n`);
  }
  return rec;
}

// ── 拦截消息：必须自带「怎么办」（用户修订④）────────────────────────────────
// 三样缺一不可：①人话说清为什么拦 ②走 Orca 的最短命令 ③确认 Orca 真死了的刷新命令。
// 命令里的参数**不背表**：`ccswitch/rules/dao-dispatch.md` §三 明写动手前现查，这里给形态与出处。
// 第②段分两种写法，因为「该等」和「该动手」是两件事（W3 换家审 R3，树帅裁最小改法）：
// 缓存**缺失 / 过期**这两格多半发生在刚开窗——SessionStart 的后台刷新此刻多半正在跑，
// 一次探测是几十秒量级。这时候再指示一个人去手动跑同一条刷新命令，是让他为一个已经在发生的事
// 再等一轮，摩擦翻倍。**不许指示一个多半是冗余的动作** ⇒ 那两格改成「等一会儿直接重试」，
// 手动刷新降格为兜底。其余格（缓存新鲜但说 Orca 活 / 缓存解析不了）没有「已在途」这一说，照旧给命令。
function refreshSection(d, cachePath) {
  const cmd = `     node "${path.join(REPO, "scripts", "dao-roster.mjs")}"\n`;
  const tail = `   （缓存落点 ${cachePath}；本次读到的状态：${d.cacheState}）\n\n`;
  if (d.cacheState === "missing" || d.cacheState === "stale") {
    return (
      `② 这一格**不用你动手**：缓存不新鲜多半是刚开窗，后台探测（SessionStart 起的那个）此刻多半正在跑，\n` +
      `   一次探测是几十秒量级。**等一会儿直接重试这次派活即可**——探测说 Orca 不可用时本闸自动放行，\n` +
      `   降级留痕由闸自己写，你一个字都不用写。\n` +
      `   等不及、或确认压根没有刷新在跑时，才用这条兜底手动重探：\n` + cmd + tail
    );
  }
  return (
    `② Orca 真的死了？重探一次再重试本次派活——探测说 Orca 不可用时本闸**自动放行**，\n` +
    `   降级留痕由闸自己写，你一个字都不用写：\n` + cmd + tail
  );
}

function blockMessage(d) {
  const cachePath = rosterCachePath();
  return (
    `\n🔒 [dao-dispatch-gate] 这一步被拦下了。\n\n` +
    `拦的是什么：${d.what}\n\n` +
    `为什么拦：${d.why}。派会写盘的工兵走本地 Agent，等于后台不可见、烧本会话的额度、` +
    `Orca 侧栏与派单账目上查不到这一路——用户 2026-08-13 拍板：**产出要进 git 的派活必走 Orca**，` +
    `本地 subagent 只剩「只读小勘察」与「Orca 真死了的降级」两个场景（issue #409）。\n\n` +
    `① 走 Orca（形态出处 ccswitch/rules/dao-dispatch.md §三；参数一律 \`--help\` 现查，别背表）：\n` +
    `     orca orchestration task-create --spec <派单书文件> --json\n` +
    `     orca orchestration worker-start --worktree <本树> --task <taskId> --model <档> --json\n\n` +
    refreshSection(d, cachePath) +
    `③ 只是想派个只读小勘察？**显式指定一个只读官种**——${READONLY_HINT_TYPES.join(" / ")}（定义在本仓 ` +
    `ccswitch/agents/，部署面 ~/.claude/agents/），或宿主自带的 Explore / Plan；同时别带 ` +
    `\`isolation: "worktree"\`。⚠ **不填类型字段不等于只读**：宿主会按缺省的全权底座起，` +
    `所以本闸把「没填」与显式 \`general-purpose\` 同等对待。本闸对显式声明的只读官种一律放行。\n\n` +
    `为什么是一道闸而不是一句提醒：同一条规矩以散文形态存在时被现场解释掉了（issue #409 正文），` +
    `所以它被搬到了 agent 之外。绕过去就等于这条规则不存在。\n`
  );
}

// ── --selfcheck：把「它到底接上没有」摆出来 ─────────────────────────────────
// 🔴 **本函数与主逻辑零共享**（不碰 readRosterCache / decide / 缓存文件）：一个检查器若用
//    被守对象的那套解析去确认自己没瞎，两半会一起错。这里只读 live settings.json。
function selfcheck() {
  const HOME = process.env.USERPROFILE || process.env.HOME || os.homedir();
  const liveSettings = path.join(HOME, ".claude", "settings.json");
  const lines = [];
  // 🔴 两个计数分开，且末尾把「退出码由谁贡献」打出来。合成一个 `bad` 会让本机的常态
  //    （未注册 ⇒ 注册面已经 1）永久盖住 canary 那一票：canary 红不红，退出码都是 1，
  //    于是「canary 的红计入退出码了吗」这一问既看不见也测不了（本轮 N5 实咬：把 canary 的
  //    计数摘掉，全套 77 条无一变红）。**测试断的是这一行的构成，不是退出码本身**——
  //    退出码是机器状态（注册与否）的函数，而注册是用户动作，测试不许依赖它。
  let badReg = 0;
  let badCanary = 0;
  let matchers = [];

  try {
    const s = JSON.parse(fs.readFileSync(liveSettings, "utf8"));
    const pre = (s.hooks && s.hooks.PreToolUse) || [];
    for (const grp of pre) {
      const cmds = (grp.hooks || []).map((h) => String(h.command || ""));
      if (cmds.some((c) => c.indexOf("dao-dispatch-gate.js") !== -1)) {
        matchers.push(grp.matcher == null ? "*" : String(grp.matcher));
      }
    }
    lines.push(
      matchers.length
        ? `✓ 已注册于 PreToolUse，matcher=${matchers.map((m) => JSON.stringify(m)).join(" , ")}`
        : `✗ 未注册：${liveSettings} 的 hooks.PreToolUse 里没有引用 dao-dispatch-gate.js 的 command。` +
          `本闸此刻**不生效**。修法：请用户把注册写进 cc-switch DB \`providers\` 表**每个** provider 的 ` +
          `\`settings_config\`（切 provider 会用目标 provider 的配置整体覆盖 live，只写一个等于没写）。` +
          `⚠ 写 git 快照层 config-sync/common/settings.json 或 DB 的 common_config_* 镜像层不会生效；` +
          `AI 侧写 DB 被权限分类器拦死，这一步是**用户动作**。`
    );
    if (!matchers.length) badReg++;
  } catch (e) {
    lines.push(`✗ 读不到 live settings.json（${liveSettings}）：${e.message} —— 无从判定是否注册，按未注册计。`);
    badReg++;
  }

  if (matchers.length) {
    const uncovered = GATE_TOOLS.filter((t) => !matchers.some((m) => matcherCovers(m, t)));
    if (uncovered.length) {
      badReg++;
      lines.push(`  ✗ matcher 覆盖不到 ${uncovered.join(" , ")} ⇒ **本闸对那些工具名静默零覆盖**`);
    } else {
      lines.push(`  ✓ matcher 覆盖本闸声明的全部工具名：${GATE_TOOLS.join(" , ")}`);
    }
  } else {
    lines.push(`  · 未注册 ⇒ 覆盖面无从谈起（本闸声明要拦：${GATE_TOOLS.join(" , ")}）`);
  }

  // ── canary：主逻辑判据还活着吗 ──────────────────────────────────────────
  // 🔴 上面那半只回答「接上没有」。一个 decide 被改成恒放行的闸，生产上是**静默 exit 0**
  //    （没抛异常就没有 fail-open 告警），而只答注册面的自检照样报健康。所以这里对
  //    **合成缓存**跑一遍真判据，正负控各一：必拦的要 block，必放的要 allow。
  //    合成缓存写在临时目录、跑完就删，**全程不读真缓存**——真缓存坏了不许砸掉上面的注册结论。
  //    整段 try/catch 兜住：canary 自己出事只判它自己红，不影响别的结论。
  const canary = [];
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dao-dispatch-canary-"));
    const fake = path.join(dir, "roster.json");
    fs.writeFileSync(fake, JSON.stringify({ at: new Date().toISOString(), fabric: { orca: { available: true } } }), "utf8");
    const savedCache = process.env.DAO_ROSTER_CACHE;
    process.env.DAO_ROSTER_CACHE = fake;
    try {
      const mustBlock = decide({ tool_name: "Agent", cwd: dir, tool_input: { subagent_type: WRITER_AGENT_TYPES[0] } });
      const mustAllow = decide({ tool_name: "Agent", cwd: dir, tool_input: { subagent_type: READONLY_HINT_TYPES[0] } });
      if (mustBlock.action !== "block") canary.push(`必拦样本判成了 ${mustBlock.action}`);
      if (mustAllow.action !== "allow") canary.push(`必放样本（只读官种 ${READONLY_HINT_TYPES[0]}）判成了 ${mustAllow.action}`);
    } finally {
      if (savedCache === undefined) delete process.env.DAO_ROSTER_CACHE;
      else process.env.DAO_ROSTER_CACHE = savedCache;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } catch (e) {
    canary.push(`canary 自己抛了：${e && e.message}`);
  }
  if (canary.length) {
    badCanary++;
    lines.push(`  ⚠ **主逻辑判据异常**（canary）：${canary.join("；")} ⇒ 闸此刻即使已注册也在错判，别信上面那行绿。`);
  } else {
    lines.push(`  ✓ 主逻辑判据 canary：合成缓存下必拦的拦住了、必放的放行了（判据没被改瞎）`);
  }

  lines.push(
    `本闸无逃生阀：它拦的事有一条自动例外（缓存说 Orca 不可用即自动放行并留痕），不需要人设开关。`
  );
  lines.push(`缓存落点 ${rosterCachePath()}；降级留痕落点 ${degradeLogPath()}。`);
  // 退出码的构成必须摆出来，见本函数开头那段 🔴：只看退出码分不出「谁贡献的」。
  lines.push(`退出码构成：注册面 ${badReg} + 主逻辑 canary ${badCanary} ⇒ exit ${badReg + badCanary ? 1 : 0}`);

  process.stdout.write(lines.join("\n") + "\n");
  process.exit(badReg + badCanary ? 1 : 0);
}

function matcherCovers(matcher, tool) {
  if (matcher === "*" || matcher === "") return true;
  try {
    // 宿主对 matcher 是全串匹配还是子串匹配未被文档担保，两种都试过才算覆盖
    const re = new RegExp(matcher);
    if (re.test(tool)) return true;
    return new RegExp("^(?:" + matcher + ")$").test(tool);
  } catch (_) {
    return false;
  }
}

// ── 主流程 ──────────────────────────────────────────────────────────────────
// `require.main === module` 守着：被测试 import 时**不许**跑主流程（它会去读 fd 0）。
if (require.main === module) {
  if (process.argv.includes("--selfcheck")) selfcheck();

  let input = {};
  try {
    input = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
  } catch (_) {
    process.exit(0); // 读不到/解析不了输入 → 放行（见头注 1）
  }

  try {
    const d = decide(input);
    if (d.action === "block") {
      process.stderr.write(blockMessage(d));
      process.exit(2);
    }
    if (d.action === "degrade") {
      logDegrade(input, d);
      process.stderr.write(
        `[dao-dispatch-gate] ⚠ roster 说 Orca 不可用（available=${JSON.stringify(d.orcaAvailable)}），` +
        `本次本地派活**降级放行**，已留痕于 ${degradeLogPath()}。降级不降标：产物照走 worktree → PR。\n`
      );
    }
    process.exit(0);
  } catch (e) {
    // fail-open（见头注 1）：绝不静默——放行与通过在退出码上长得一样，这行 stderr 是唯一的区分。
    process.stderr.write(
      `[dao-dispatch-gate] ⚠ 守卫自身出错，本次**放行**（fail-open）：${e && e.stack ? e.stack : e}\n` +
      `⇒ 这一刻它没有在守。跑 \`node ccswitch/hooks/dao-dispatch-gate.js --selfcheck\` 看接线，并修掉这个错。\n`
    );
    process.exit(0);
  }
}

module.exports = {
  GATE_TOOLS,
  AGENT_TYPE_KEYS,
  WRITER_AGENT_TYPES,
  FULL_ACCESS_AGENT_TYPES,
  READONLY_HINT_TYPES,
  rosterCachePath,
  degradeLogPath,
  ttlMs,
  agentTypeOf,
  writerFeature,
  readRosterCache,
  decide,
};
