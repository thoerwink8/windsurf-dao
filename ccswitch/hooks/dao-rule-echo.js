// dao-rule-echo.js — PostToolUse · 规则条款「写入即回灌」
//
// ── 治的是什么病 ─────────────────────────────────────────────────────────────
// always-on 规则（CLAUDE.md / @import 的 ccswitch/dao.md / .claude/rules/*.md 等）
// 是**会话启动时快照**注入上下文的。会话进行中新写入的条款，对该会话余下全程不可见。
// 双重第一人称实证（2026-07-26）：
//   ① 某 subagent 的 dispatch-clauses.md 注入副本从通用节末条直接跳到「## 复审官节」，
//      磁盘上当日新增的 16 条全缺（16/52 = 30.8%），截断点落在 07-25 20:02 与 07-26 07:41 之间；
//   ② 同一时刻指挥官会话缺同样 16 条，且其本人当天亲手写进 dao.md 的授权条款
//      也不在自己的注入副本里。
// 后果有二：一是新条款对当轮及后续同会话 agent 不存在；二是它污染归因——
// 把「从未投递」误判成「读了不遵守」，据此删条款＝拿脏数据做不可逆删除。
//
// ── 怎么治 ───────────────────────────────────────────────────────────────────
// 挂 PostToolUse（matcher: Edit|Write|MultiEdit）。当写入目标命中「规则文件」判据时，
// 把**本次写入的那段内容**经 hookSpecificOutput.additionalContext 回灌进上下文——
// 写条款的那一刻，条款经机器通道回灌自己。纯载荷携带，零记性依赖。
//
// 边界（有意不做的）：
//   · 不做全文回灌（dao.md 已 40KB+，全文会挤爆上下文），只回灌本次改动段，且有字符上限；
//   · 不挂 UserPromptSubmit —— 长自主窗内用户只发 1 条消息、此后全靠心跳驱动，
//     UserPromptSubmit 在那种窗里结构性失效（dao-rhythm.js 的已知坑，不重复踩）；
//   · 覆盖面止于「命中判据的写入」。判据是正则清单（见 RULE_PATTERNS），
//     清单外的路径不回灌；换宿主/换注入机制后判据需重核。
//
// ── 失败可见性 ───────────────────────────────────────────────────────────────
// 反面教材：hookify 插件的 stop.py 在 finally 里无条件 sys.exit(0)，任何内部错误都被吞，
// 启用后是「静默死层」，而「插件已启用 + 脚本存在」的检查会对它报绿。
// 本 hook 出错时三重留痕：stderr + systemMessage（用户可见）+ _tmp/rule-echo/errors.log，
// 但**不取阻断语义**（PostToolUse 阶段工具已执行完，不该报错误态污染工具结果），故仍 exit 0。
// 上述加固层已抽为公共库 ccswitch/lib/hook-selfcheck.js（fortify2-20260726 刀F F1），
// 本文件只留业务判据；两者的分工与「有意保留的差异」见该库头注。
//
// ── 未接线自检 ───────────────────────────────────────────────────────────────
// `node dao-rule-echo.js --selfcheck` 两路核验：① settings.json 里是否真注册（读注册串）
// ② 心跳文件是否有真实触发记录（只有真被调用过才写得出来）。
// 「文件存在＝已生效」是三例 55 天零生效事故的共同误判，故自检不看文件存在性。
//
// 真相源：windsurf-dao/ccswitch/hooks/dao-rule-echo.js
// 由 settings.json 的 PostToolUse hook 调用（注册 JSON 片段见本文件末尾「注册片段」注释块）。
// 自证：node tests/dao-rule-echo.tests.js（46 断言，两态 + 错误可见性）。

const fs = require("node:fs");
const os = require("node:os");
const { createHookScaffold } = require("../lib/hook-selfcheck.js");

// ── 常量：回灌预算 ──────────────────────────────────────────────────────────
// 取值理由：4000 字符 ≈ 1000~1400 token。单条新增条款通常 200~800 字符，
// 4000 足够容纳一次批量补条款；再大就开始与「别挤爆上下文」冲突。
const MAX_ECHO_TOTAL = 4000;   // 单次回灌的规则正文总上限
const MAX_ECHO_SEG = 2000;     // MultiEdit 单段上限（防一段吃光预算）
const WRITE_FULL_LIMIT = 4000; // Write：内容 ≤ 此值全量回灌，超过转摘要模式
const WRITE_SUMMARY_HEAD = 1000; // 摘要模式回灌开头多少字符

const H = createHookScaffold({
  name: "dao-rule-echo",
  stateSubdir: "rule-echo",
  failTail: "本次规则回灌未执行；hook 不阻断工具调用",
  forceErrorEnv: "DAO_RULE_ECHO_FORCE_ERROR",
  selfTestEnv: "DAO_RULE_ECHO_SELFTEST",
});

// ── 规则文件判据 ────────────────────────────────────────────────────────────
// 只收「宿主会在会话启动时快照注入」的那一类文件——它们才有「中途写入不可见」的病。
// skills/commands 不在列内：它们是调用时才从磁盘读，不受快照影响。
const RULE_PATTERNS = [
  [/(^|\/)ccswitch\/dao\.md$/i,                                   "dao 场域根（被 ~/.claude/CLAUDE.md 以 @import 常驻注入）"],
  [/(^|\/)CLAUDE(\.local)?\.md$/i,                                "CLAUDE.md（常驻注入）"],
  [/(^|\/)\.claude\/rules\/.+\.md$/i,                             "项目规则 .claude/rules（常驻注入）"],
  [/(^|\/)AGENTS?\.md$/i,                                         "AGENTS.md（宿主常驻注入）"],
  [/(^|\/)\.claude\/projects\/[^/]+\/memory\/.+\.md$/i,           "auto-memory（常驻注入）"],
  [/(^|\/)memory\/MEMORY\.md$/i,                                  "memory 索引（常驻注入）"],
  [/(^|\/)\.windsurf\/rules\/.+$/i,                               "Windsurf 规则（双栈对位）"],
  // fortify-20260726 A1：条款库存根化后，全文迁到 docs/rules/（不再 always-on 快照，
  // subagent 按「必带首行」现场 Read）。本条并非补「快照延迟」病——而是覆盖同一会话内
  // 帅自己边写边用的场景：写完条款不代表当轮已生效，回灌能让帅立即看到刚落盘的内容，
  // 不必等下一次显式 Read。
  [/(^|\/)docs\/rules\/.+\.md$/i,                                 "条款库正文（docs/rules，现场 Read 型，非快照型）"],
];

// 排除面：临时产物/依赖/构建物里的同名文件不是生效中的规则文件
const EXCLUDE = /(^|\/)(_tmp|_scratch|node_modules|\.git|dist|build|target|coverage|__pycache__)\//i;

function classifyRuleFile(norm) {
  if (!norm || EXCLUDE.test(norm)) return null;
  for (const [re, label] of RULE_PATTERNS) {
    if (re.test(norm)) return label;
  }
  return null;
}

// ── 作用域档识别（P2，2026-08-01）────────────────────────────────────────────
// 病：上面 RULE_PATTERNS 把 `.claude/rules/*.md` 一律标成「常驻注入」，而自 P2 起
// 这个目录里住着两类**性质相反**的文件：
//   · 无 `paths:` ⇒ 常驻（会话启动快照）——原描述对它成立
//   · 有 `paths:` ⇒ **作用域注入**，只在有人 Read 到匹配文件时才由宿主送达
// 对后者说「常驻注入」是**假话**，而这段文案的用途正是告诉读者「这条现在生效了没有」——
// 说反了比不说更糟：会让人以为一条只在特定路径下到达的规则已经全局生效。
//
// 为什么读盘而不是看本次写入载荷：Edit 只带改动段，frontmatter 多半不在里面
// ⇒ 看载荷会把有 paths 的文件系统性误报成常驻。PostToolUse 阶段文件已落盘，读盘拿终态。
// 读盘失败一律按「无 paths」处理（降级到原文案，不因识别失败而丢掉回灌本身）。
function readScopeGlobs(absPath) {
  let text;
  try { text = fs.readFileSync(absPath, "utf8"); } catch { return []; }
  const m = text.match(/^﻿?---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return [];
  const fm = m[1];
  const globs = [];
  let inPaths = false;
  for (const line of fm.split(/\r?\n/)) {
    if (/^\s*paths\s*:/.test(line)) {
      const inline = line.replace(/^\s*paths\s*:/, "").trim();
      if (inline.startsWith("[")) {
        for (const g of inline.replace(/^\[|\]$/g, "").split(",")) {
          const v = g.trim().replace(/^["']|["']$/g, "");
          if (v) globs.push(v);
        }
        inPaths = false;
      } else {
        inPaths = true;
      }
      continue;
    }
    if (!inPaths) continue;
    if (/^\s*-\s+/.test(line)) globs.push(line.replace(/^\s*-\s+/, "").trim().replace(/^["']|["']$/g, ""));
    else if (/^\S/.test(line)) inPaths = false; // 下一个顶层键，paths 段结束
  }
  return globs;
}

// 用户级 `~/.claude/rules/`：本机 2026-08-01 canary 实测——**无 `paths:` 的文件
// 三个 subagent 观察员 3/3 均未收到**（主会话侧未验）。故这一格不能沿用「常驻注入」。
function isUserLevelRules(norm) {
  const home = String(os.homedir() || "").replace(/\\/g, "/").replace(/\/+$/, "");
  if (!home) return false;
  return norm.toLowerCase().startsWith(`${home.toLowerCase()}/.claude/rules/`);
}

// ── 载荷提取：只取本次写入的内容，按工具形态分流 ────────────────────────────
function countLines(s) { return s ? s.split(/\r?\n/).length : 0; }

function clip(s, limit) {
  if (s.length <= limit) return { text: s, clipped: 0 };
  return { text: s.slice(0, limit), clipped: s.length - limit };
}

// 返回 { body, meta }；body 为空串表示「无正文可回灌」（如纯删除）
function buildPayload(toolName, ti) {
  if (toolName === "Edit") {
    const ns = String(ti.new_string == null ? "" : ti.new_string);
    if (!ns.trim()) {
      return { body: "", meta: `本次 Edit 的 new_string 为空 —— 属删除/清空条款（old_string ${String(ti.old_string || "").length} 字符）。` };
    }
    const c = clip(ns, MAX_ECHO_TOTAL);
    return {
      body: c.text,
      meta: c.clipped
        ? `本次写入 ${ns.length} 字符，超 ${MAX_ECHO_TOTAL} 字符预算，此处回灌前 ${c.text.length} 字符，余 ${c.clipped} 字符未回灌（需全文请 Read 该文件）。`
        : `本次写入 ${ns.length} 字符 / ${countLines(ns)} 行，已全量回灌。`
    };
  }

  if (toolName === "MultiEdit") {
    const edits = Array.isArray(ti.edits) ? ti.edits : [];
    const chunks = [];
    let used = 0, skippedSegs = 0, clippedChars = 0;
    for (let i = 0; i < edits.length; i++) {
      const ns = String(edits[i] && edits[i].new_string != null ? edits[i].new_string : "");
      if (!ns.trim()) { chunks.push(`— 段 ${i + 1}：new_string 为空（删除/清空）`); continue; }
      if (used >= MAX_ECHO_TOTAL) { skippedSegs++; continue; }
      const budget = Math.min(MAX_ECHO_SEG, MAX_ECHO_TOTAL - used);
      const c = clip(ns, budget);
      clippedChars += c.clipped;
      used += c.text.length;
      chunks.push(`— 段 ${i + 1}${c.clipped ? `（截断，余 ${c.clipped} 字符未回灌）` : ""}：\n${c.text}`);
    }
    const notes = [`本次 MultiEdit 共 ${edits.length} 段`];
    if (skippedSegs) notes.push(`${skippedSegs} 段因超 ${MAX_ECHO_TOTAL} 字符预算未回灌`);
    if (clippedChars) notes.push(`合计 ${clippedChars} 字符被截断`);
    if (skippedSegs || clippedChars) notes.push("需全文请 Read 该文件");
    return { body: chunks.join("\n"), meta: notes.join("；") + "。" };
  }

  if (toolName === "Write") {
    const content = String(ti.content == null ? "" : ti.content);
    if (!content.trim()) {
      return { body: "", meta: "本次 Write 内容为空 —— 属清空该规则文件。" };
    }
    if (content.length <= WRITE_FULL_LIMIT) {
      return { body: content, meta: `本次 Write 全量 ${content.length} 字符 / ${countLines(content)} 行，已全量回灌。` };
    }
    // 大文件重写：不倾泻全文，只回灌开头 + 规模，指向 Read 取全文
    const c = clip(content, WRITE_SUMMARY_HEAD);
    return {
      body: c.text,
      meta: `本次 Write 为大文件重写（${content.length} 字符 / ${countLines(content)} 行），超 ${WRITE_FULL_LIMIT} 字符预算 —— ` +
            `此处仅回灌开头 ${c.text.length} 字符作定位用，全文请 Read 该文件后再据以执行。`
    };
  }

  return null;
}

// ── --selfcheck：查注册 + 查心跳，不看「文件是否存在」 ──────────────────────
if (process.argv.includes("--selfcheck")) {
  H.runSelfcheckCli({
    event: "PostToolUse",
    scriptName: "dao-rule-echo.js",
    // 规则写入靠 Edit 与 Write 两路，缺一路就有整类写入漏触发
    covers: (m) => m === "*" || (/Edit/.test(m) && /Write/.test(m)),
    matcherLabel: (m) => m,
    coversFailNote: " —— 该 matcher 未同时覆盖 Edit/Write，规则写入可能漏触发",
    logPath: H.firedLog,
    missNote: "matcher/路径判据",
    describeLast: (last) => `${last.tool} · ${last.file}`,
    // 规则文件不是每天都改 ⇒ 30 天才算可疑（阈值低了会变噪音源，随即被人删掉）
    staleDays: 30,
    staleNote: (d) => `⚠ 末次真实触发距今 ${d} 天；若期间改过规则文件，说明已失联，请核 settings.json 注册。`,
    logReadFailLabel: "心跳日志读取失败",
  });
}

// ── 主流程 ──────────────────────────────────────────────────────────────────
const input = H.readStdinJson();

try {
  const toolName = String(input.tool_name || "");
  const ti = (input.tool_input && typeof input.tool_input === "object") ? input.tool_input : {};
  const filePath = String(ti.file_path || "");

  if (!/^(Edit|Write|MultiEdit)$/.test(toolName) || !filePath) process.exit(0);

  // 工具本次执行明确失败 → 磁盘上未必落了这段内容，不回灌
  const tr = input.tool_response;
  if (tr && typeof tr === "object" && tr.success === false) process.exit(0);

  const norm = filePath.replace(/\\/g, "/");
  const baseLabel = classifyRuleFile(norm);
  if (!baseLabel) process.exit(0); // 非规则文件：静默，一个字都不输出

  H.maybeForceError("payload");
  const payload = buildPayload(toolName, ti);
  if (!payload) process.exit(0);

  // 作用域档识别：有 `paths:` ⇒ 不是常驻注入，文案必须改口（见 readScopeGlobs 头注）
  const scopeGlobs = readScopeGlobs(filePath);
  const scoped = scopeGlobs.length > 0;
  const userLevel = isUserLevelRules(norm);

  let label = baseLabel;
  let why;
  if (scoped) {
    label = `${baseLabel.replace(/（[^（）]*注入[^（）]*）/, "")}（**作用域注入**，非常驻 · paths: ${scopeGlobs.join(", ")}）`;
    why =
      `为什么会看到这段：这是一份**作用域规则**——它**不常驻注入**，只在有人 Read 到匹配 ` +
      `\`paths:\` 的文件时才由宿主送达（本次匹配面：${scopeGlobs.join(", ")}）。你刚写了它，` +
      `而它对本会话此前的上下文不可见，故此处把本次写入原样回灌。` +
      `⚠️ 别把它读成「已对所有会话生效」：不匹配的路径下它一次都不会到达；` +
      `若它的源在 \`ccswitch/rules/scoped/\`，还需 \`node ccswitch/scripts/dao-rules-deploy.mjs\` ` +
      `部署到 \`~/.claude/rules/\` 才会被宿主扫描到。\n`;
  } else if (userLevel) {
    label = `${baseLabel.replace(/（[^（）]*注入[^（）]*）/, "")}（用户级 ~/.claude/rules，**无 paths**）`;
    why =
      `⚠️ 为什么会看到这段，以及一个必须说清的边界：这份文件在**用户级** \`~/.claude/rules/\` 下且` +
      `**没有 \`paths:\` frontmatter**——本机 2026-08-01 canary 实测，这一格的文件` +
      `**三个 subagent 观察员 3/3 均未收到**（主会话侧未验）。` +
      `⇒ **别把它当 always-on 用**：要它可靠生效，要么补 \`paths:\` 走作用域档，` +
      `要么把正文放进项目 \`.claude/rules/\` 或 dao.md。此处仍原样回灌本次写入，` +
      `但那只保证**你自己这一轮**看得到，不代表别的会话看得到。\n`;
  } else {
    why =
      `为什么会看到这段：always-on 规则是会话启动时快照注入的，会话中途写入的条款不会自动出现在你的上下文里` +
      `（2026-07-26 双重第一人称实证：同日新增 16 条中有 16 条在注入副本里缺失）。故此处把本次写入原样回灌，` +
      `本轮及本会话后续须按下方条款执行；若与你上下文里的旧副本冲突，以下方为新。\n`;
  }

  const head =
    `【规则回灌 · rule-echo】刚以 ${toolName} 写入规则文件：${norm}\n` +
    `文件性质：${label}。\n` +
    why +
    `回灌范围：${payload.meta}`;

  const context = payload.body
    ? `${head}\n----- 本次写入内容 begin -----\n${payload.body}\n----- 本次写入内容 end -----`
    : head;

  H.heartbeat({
    at: new Date().toISOString(),
    tool: toolName,
    file: norm,
    label,
    bytes: Buffer.byteLength(context, "utf8"),
    session: String(input.session_id || ""),
    synthetic: H.isSynthetic(input)
  });

  H.emit({
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: context
    }
  });
  process.exit(0);
} catch (e) {
  H.fail("构造回灌载荷", e);
}

// ── 注册片段（供 ~/.claude/settings.json 的 hooks.PostToolUse 数组使用）────────
// 三处一致（缺一处则换机/同步后失效）：
//   ① live  ~/.claude/settings.json
//   ② git 快照 windsurf-dao/config-sync/common/settings.json（cc-switch DB 导出格式）
//   ③ cc-switch DB（restore.mjs --scope=settings）
//
// 方案 A（推荐·独立组，只往 PostToolUse 数组里插一个对象，改动面最小）：
//   {
//     "matcher": "Edit|Write|MultiEdit",
//     "hooks": [
//       {
//         "type": "command",
//         "command": "node \"D:/frank/windsurf-dao/ccswitch/hooks/dao-rule-echo.js\"",
//         "timeout": 10
//       }
//     ]
//   }
//
// 方案 B（并入已有的 Edit|Write|MultiEdit 组，与 dao-glob-gate.js 同组并行执行）：
//   往该组 "hooks" 数组追加上面那个 command 对象即可。
//   两方案等效——同事件多 hook 并行跑，各自的 additionalContext 都会被投递。
//
// 注册后核验：node ccswitch/hooks/dao-rule-echo.js --selfcheck
//   预期从「✗ 未注册 / ✗ 无真实触发记录」转为「✓ 已注册 / ✓ 有真实触发记录」；
//   第二个 ✓ 需先真实改一次规则文件才会出现（心跳只由真实调用写出）。
