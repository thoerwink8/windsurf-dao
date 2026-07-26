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
//
// ── 未接线自检 ───────────────────────────────────────────────────────────────
// `node dao-rule-echo.js --selfcheck` 两路核验：① settings.json 里是否真注册（读注册串）
// ② 心跳文件是否有真实触发记录（只有真被调用过才写得出来）。
// 「文件存在＝已生效」是三例 55 天零生效事故的共同误判，故自检不看文件存在性。
//
// 真相源：windsurf-dao/ccswitch/hooks/dao-rule-echo.js
// 由 settings.json 的 PostToolUse hook 调用（注册 JSON 片段见本文件末尾「注册片段」注释块）。
// 自证：node tests/dao-rule-echo.tests.js（46 断言，两态 + 错误可见性）。

const fs = require("fs");
const os = require("os");
const path = require("path");

// ── 常量：回灌预算 ──────────────────────────────────────────────────────────
// 取值理由：4000 字符 ≈ 1000~1400 token。单条新增条款通常 200~800 字符，
// 4000 足够容纳一次批量补条款；再大就开始与「别挤爆上下文」冲突。
const MAX_ECHO_TOTAL = 4000;   // 单次回灌的规则正文总上限
const MAX_ECHO_SEG = 2000;     // MultiEdit 单段上限（防一段吃光预算）
const WRITE_FULL_LIMIT = 4000; // Write：内容 ≤ 此值全量回灌，超过转摘要模式
const WRITE_SUMMARY_HEAD = 1000; // 摘要模式回灌开头多少字符

const ROOT = path.resolve(__dirname, "..", ".."); // 本脚本在 <root>/ccswitch/hooks/
const STATE_DIR = path.join(ROOT, "_tmp", "rule-echo");
const FIRED_LOG = path.join(STATE_DIR, "fired.log");
const LAST_JSON = path.join(STATE_DIR, "last.json");
const ERROR_LOG = path.join(STATE_DIR, "errors.log");
const FIRED_LOG_MAX_LINES = 2000;

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

// ── 失败留痕：stderr + systemMessage + 磁盘日志，不阻断 ─────────────────────
let stdoutUsed = false;
function emit(obj) {
  if (stdoutUsed) return;
  stdoutUsed = true;
  try { process.stdout.write(JSON.stringify(obj)); } catch (_) {}
}

function appendErrorLog(msg, err) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const stack = err && err.stack ? "\n" + err.stack : "";
    fs.appendFileSync(ERROR_LOG, `[${new Date().toISOString()}] ${msg}${stack}\n`, "utf8");
  } catch (_) {}
}

function fail(stage, err) {
  const detail = err && err.message ? err.message : String(err);
  const msg = `[dao-rule-echo] ${stage} 失败：${detail}`;
  try { process.stderr.write(msg + "\n"); } catch (_) {}
  appendErrorLog(msg, err);
  emit({
    systemMessage: msg + `（本次规则回灌未执行；hook 不阻断工具调用。日志：${ERROR_LOG}）`
  });
  process.exit(0);
}

// 自检用故障闸：DAO_RULE_ECHO_FORCE_ERROR=1 时在主流程内抛错，用来验证「出错不静默」。
function maybeForceError(stage) {
  if (process.env.DAO_RULE_ECHO_FORCE_ERROR === "1") {
    throw new Error(`人为注入故障（DAO_RULE_ECHO_FORCE_ERROR=1）@${stage}`);
  }
}

// ── 心跳：只有真被宿主调用过才写得出来，是「已接线」的硬证据 ────────────────
// 自测/手工空跑也会走到这里，若不加区分，单元测试的心跳会让 --selfcheck 误报「已生效」
// ——那正是本 hook 要治的那类假绿。故心跳标注 synthetic，自检只采信非 synthetic 记录。
// 判据：显式自测环境变量，或缺 transcript_path（真实宿主调用必带）。
function isSynthetic(input) {
  if (process.env.DAO_RULE_ECHO_SELFTEST === "1") return true;
  return !(input && input.transcript_path);
}

function heartbeat(rec) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(LAST_JSON, JSON.stringify(rec, null, 2), "utf8");
    fs.appendFileSync(FIRED_LOG, JSON.stringify(rec) + "\n", "utf8");
    // 轻量裁剪，避免日志无界增长
    const lines = fs.readFileSync(FIRED_LOG, "utf8").split(/\r?\n/).filter(Boolean);
    if (lines.length > FIRED_LOG_MAX_LINES) {
      fs.writeFileSync(FIRED_LOG, lines.slice(-Math.floor(FIRED_LOG_MAX_LINES / 2)).join("\n") + "\n", "utf8");
    }
  } catch (_) { /* 心跳失败不该拖垮回灌本身 */ }
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
function selfcheck() {
  const HOME = process.env.USERPROFILE || process.env.HOME || os.homedir();
  const settingsPath = path.join(HOME, ".claude", "settings.json");
  const lines = [];
  let bad = 0;

  // ① 注册核验
  try {
    const j = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    const groups = (j.hooks && j.hooks.PostToolUse) || [];
    let hit = null;
    for (const g of groups) {
      for (const h of (g.hooks || [])) {
        if (typeof h.command === "string" && /dao-rule-echo\.js/.test(h.command)) hit = { g, h };
      }
    }
    if (!hit) {
      lines.push(`✗ 未注册：${settingsPath} 的 hooks.PostToolUse 里没有引用 dao-rule-echo.js 的 command。`);
      bad++;
    } else {
      const m = hit.g.matcher == null ? "" : String(hit.g.matcher);
      const covers = m === "*" || (/Edit/.test(m) && /Write/.test(m));
      lines.push(`${covers ? "✓" : "✗"} 已注册于 PostToolUse，matcher="${m}"${covers ? "" : " —— 该 matcher 未同时覆盖 Edit/Write，规则写入可能漏触发"}`);
      if (!covers) bad++;
    }
  } catch (e) {
    lines.push(`✗ 读取/解析 settings.json 失败：${e.message}`);
    bad++;
  }

  // ② 心跳核验：只采信非 synthetic 记录（自测心跳不算「已生效」）
  try {
    const all = fs.existsSync(FIRED_LOG)
      ? fs.readFileSync(FIRED_LOG, "utf8").split(/\r?\n/).filter(Boolean).map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean)
      : [];
    const real = all.filter(r => r.synthetic !== true);
    if (!real.length) {
      lines.push(`✗ 无真实触发记录（日志共 ${all.length} 条，其中自测/手工 ${all.length - real.length} 条）—— ` +
                 `尚未被宿主真实调用过；注册了也可能因 matcher/路径判据不匹配而从未触发。日志：${FIRED_LOG}`);
      bad++;
    } else {
      const last = real[real.length - 1];
      const days = (Date.now() - Date.parse(last.at)) / 86400000;
      lines.push(`✓ 有真实触发记录：末次 ${last.at}（${days.toFixed(1)} 天前）· ${last.tool} · ${last.file}；真实 ${real.length} 条 / 共 ${all.length} 条。`);
      if (days > 30) lines.push(`  ⚠ 末次真实触发距今 ${days.toFixed(0)} 天；若期间改过规则文件，说明已失联，请核 settings.json 注册。`);
    }
  } catch (e) {
    lines.push(`✗ 心跳日志读取失败：${e.message}`);
    bad++;
  }

  process.stdout.write("[dao-rule-echo --selfcheck]\n" + lines.map(s => "  " + s).join("\n") + "\n");
  process.exit(bad ? 1 : 0);
}

// ── 主流程 ──────────────────────────────────────────────────────────────────
if (process.argv.includes("--selfcheck")) {
  try { selfcheck(); } catch (e) {
    process.stderr.write(`[dao-rule-echo] selfcheck 异常：${e.message}\n`);
    process.exit(1);
  }
}

let raw = "";
try {
  raw = fs.readFileSync(0, "utf8");
} catch (e) {
  fail("读取 stdin", e);
}

let input;
try {
  maybeForceError("parse");
  input = JSON.parse(raw);
  if (!input || typeof input !== "object") throw new Error("stdin JSON 不是对象");
} catch (e) {
  // 真实 PostToolUse 一定给合法 JSON；解析不了说明协议对不上或被手工空跑，
  // 属该报的错，不做静默降级（静默＝死层）。
  fail("解析 stdin JSON", e);
}

try {
  const toolName = String(input.tool_name || "");
  const ti = (input.tool_input && typeof input.tool_input === "object") ? input.tool_input : {};
  const filePath = String(ti.file_path || "");

  if (!/^(Edit|Write|MultiEdit)$/.test(toolName) || !filePath) process.exit(0);

  // 工具本次执行明确失败 → 磁盘上未必落了这段内容，不回灌
  const tr = input.tool_response;
  if (tr && typeof tr === "object" && tr.success === false) process.exit(0);

  const norm = filePath.replace(/\\/g, "/");
  const label = classifyRuleFile(norm);
  if (!label) process.exit(0); // 非规则文件：静默，一个字都不输出

  maybeForceError("payload");
  const payload = buildPayload(toolName, ti);
  if (!payload) process.exit(0);

  const head =
    `【规则回灌 · rule-echo】刚以 ${toolName} 写入规则文件：${norm}\n` +
    `文件性质：${label}。\n` +
    `为什么会看到这段：always-on 规则是会话启动时快照注入的，会话中途写入的条款不会自动出现在你的上下文里` +
    `（2026-07-26 双重第一人称实证：同日新增 16 条中有 16 条在注入副本里缺失）。故此处把本次写入原样回灌，` +
    `本轮及本会话后续须按下方条款执行；若与你上下文里的旧副本冲突，以下方为新。\n` +
    `回灌范围：${payload.meta}`;

  const context = payload.body
    ? `${head}\n----- 本次写入内容 begin -----\n${payload.body}\n----- 本次写入内容 end -----`
    : head;

  heartbeat({
    at: new Date().toISOString(),
    tool: toolName,
    file: norm,
    label,
    bytes: Buffer.byteLength(context, "utf8"),
    session: String(input.session_id || ""),
    synthetic: isSynthetic(input)
  });

  emit({
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: context
    }
  });
  process.exit(0);
} catch (e) {
  fail("构造回灌载荷", e);
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
