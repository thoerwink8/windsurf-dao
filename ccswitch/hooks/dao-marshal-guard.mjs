// dao marshal-guard hook — 帅位警戒线（提醒型，绝不阻断）
//
// 背景：dao.md 帅节规定主会话指挥官（帅）不亲手产出制作性交付物（产品代码/原型/批量文档），
// 硬判据：单文件新建 >50 行或同一交付物 >3 轮工具循环 → 必须派后台 subagent。
// 但提示词层约束已两次实证失效（2026-07-12 mousse-cli：帅亲写 700 行原型；同日 3 条 PR 评论 7+ 轮循环）。
// 本 hook 是机制层警戒线：同一 session 内「制作性编辑」达第 4 次起，每次注入模型可见提醒。
//
// v2（2026-07-12，第三次复发修复）：新增「侦察连击」独立计数——同一 session 内连续
// Read/Grep/Glob + 只读类 Bash（未被 Edit/Write/MultiEdit 或写类 Bash 打断）达第 8 次起提醒。
// 判据来源：dao.md 帅节·亲历上限 L14——"跨文件/跨仓的多轮搜证是斥候（只读侦察 subagent）的活"。
// 复发实证：断链排查任务内帅亲手做了 10+ 轮跨三仓只读侦察（Grep/Read/Bash 皆有）未派斥候。
// 两类计数完全独立、互不干扰：制作性编辑计数只认 Edit/Write/MultiEdit + 代码类扩展名；
// 侦察连击计数只认 Read/Grep/Glob + 只读类 Bash，被任意 Edit/Write/MultiEdit 或写类 Bash 清零。
//
// 形态铁律（用户拍板）：
//   - 只提醒不阻断：始终 exit 0，无 permissionDecision、无弹窗、无权限询问，用户完全无感
//   - 挂 PostToolUse(matcher 已扩至 Edit|Write|MultiEdit|Read|Grep|Glob|Bash)：工具已执行天然不阻断，
//     additionalContext 注入路径为本仓已验证先例（dao-glob-gate / dao-tool-nudge 同款）
//   - PreToolUse 虽也支持 additionalContext，但官方文档将其与 permissionDecision 耦合，
//     输出 "allow" 会静默越过权限系统（超出提醒型边界），故不选
//
// 判定启发式 v1（制作性编辑）：被编辑文件扩展名 ∈ 代码/原型类集合 → 计数；.md/.toml/.json 等不计。
// 判定启发式 v2（侦察连击）：Read/Grep/Glob 无条件计入；Bash 按命令白名单分三档——
//   read（ls/cat/head/tail/grep/find/git log|status|diff|show/git branch(无-d/-D)/awk/sed -n/wc 等）→ 计入，
//   write（git commit|push|add|reset|checkout|merge|rebase|clean|stash/rm/mv/mkdir/cp/touch/tee/
//   npm|pnpm|cargo|yarn/重定向 > >>）→ 清零，
//   其余判不准的一律归中性档：不计入也不清零（宁漏不误伤）。
// Subagent 豁免：官方文档明确 agent_id / agent_type 仅在 subagent 内触发的 hook stdin 中出现，
//   检测到即静默退出——帅位约束只对主会话生效，两类计数均豁免。
// 计数状态：%TEMP%/dao-marshal-guard/<session_id>.count（制作性）+ <session_id>.scout.count（侦察），
//   按 session 隔离，不污染项目目录，互不覆盖。
// 性能铁律：matcher 已扩到高频只读工具（Read/Grep/Glob/Bash），脚本必须极快退出——
//   只做"读 count 文件→判定→写回→可能输出一行 JSON"，零重计算、零同步耗时操作。
//
// 真相源：windsurf-dao/ccswitch/hooks/dao-marshal-guard.mjs
// 由 settings.json 的 PostToolUse hook(matcher: Edit|Write|MultiEdit|Read|Grep|Glob|Bash)调用。

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const PRODUCTIVE_THRESHOLD = 3; // 制作性编辑：第 4 次起提醒
const SCOUT_THRESHOLD = 8; // 侦察连击：第 8 次起提醒（比制作性宽松，防误伤正常读码定案）

const PRODUCTIVE_EXTS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs",
  "rs", "py", "go", "java", "c", "cpp", "h",
  "html", "css", "scss", "less", "vue", "svelte",
]);

// ── 只读 Bash 判定（白名单精神，宁漏不误伤——判不准一律归中性档）──
const BASH_WRITE_RE = new RegExp(
  "^(rm|mv|mkdir|cp|touch|tee|npm|pnpm|cargo|yarn)\\b|" +
    "^git\\s+(commit|push|add|reset|checkout|merge|rebase|clean|stash)\\b|" +
    "^git\\s+branch\\s+-[dD]\\b",
  "i"
);
const BASH_REDIRECT_RE = /(^|\s)>{1,2}(\s|\S)/;
const BASH_READ_RE = new RegExp(
  "^(ls|cat|head|tail|wc|pwd|which|awk)\\b|" +
    "^grep\\b|^find\\b|" +
    "^git\\s+(log|status|diff|show)\\b|" +
    "^git\\s+branch\\b|" + // 无 -d/-D 已被上面 write 规则先行拦截
    "^sed\\s+-n\\b",
  "i"
);

function classifyBash(cmd) {
  if (!cmd || typeof cmd !== "string") return "neutral";
  const parts = cmd.split(/&&|\|\||;|\|/).map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return "neutral";
  let sawWrite = false;
  let sawRead = false;
  let sawUnknown = false;
  for (const part of parts) {
    if (BASH_REDIRECT_RE.test(part) || BASH_WRITE_RE.test(part)) {
      sawWrite = true;
      continue;
    }
    if (BASH_READ_RE.test(part)) {
      sawRead = true;
      continue;
    }
    sawUnknown = true;
  }
  if (sawWrite) return "write"; // 任一子命令有副作用即整体判 write，安全优先
  if (sawRead && !sawUnknown) return "read"; // 全部子命令都能识别为只读才判 read
  return "neutral"; // 含未知子命令 → 宁漏不误伤
}

let raw = "";
try {
  raw = fs.readFileSync(0, "utf8");
} catch {
  /* 无 stdin 视为空 */
}

let input = {};
try {
  input = JSON.parse(raw);
} catch {
  process.exit(0);
}

// ── Subagent 豁免：agent_id/agent_type 仅在 subagent 内出现（官方 hooks 文档），两类计数均不适用 ──
if (input.agent_id || input.agent_type) process.exit(0);

const toolName = input.tool_name || "";

// ── session 隔离计数（存系统 temp，不碰项目目录）──
const sessionId = String(input.session_id || "").replace(/[^A-Za-z0-9_-]/g, "");
if (!sessionId) process.exit(0); // 无法隔离就不计数，宁静默不串号

const dir = path.join(os.tmpdir(), "dao-marshal-guard");
const productiveCountFile = path.join(dir, `${sessionId}.count`);
const scoutCountFile = path.join(dir, `${sessionId}.scout.count`);

function readCount(file) {
  try {
    return parseInt(fs.readFileSync(file, "utf8"), 10) || 0;
  } catch {
    return 0;
  }
}

function writeCount(file, n) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, String(n), "utf8");
    return true;
  } catch {
    return false; // 状态写不进去就放弃本次提醒，绝不影响工具链路
  }
}

function scoutContext(count) {
  return (
    `⚔️ 帅位警戒·侦察型：本会话已连续 ${count} 轮只读侦察未派将（阈值${SCOUT_THRESHOLD}）。` +
    "若你是主会话指挥官：跨文件/跨仓的多轮搜证是斥候（只读侦察 subagent）的活——" +
    "考虑派斥候带证据摘要回来，定案自留、搜证外包（dao.md 帅节·亲历上限，L14）。" +
    "一次 Edit/Write 或写类命令即重置本计数。"
  );
}

function emit(context) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: context },
    })
  );
}

// ══ 制作性编辑：Edit/Write/MultiEdit ══
if (/^(Edit|Write|MultiEdit)$/.test(toolName)) {
  // 任一编辑动作 = 定案落笔，侦察连击天然中断，无条件重置（不受扩展名过滤，静默不发消息）
  writeCount(scoutCountFile, 0);

  const filePath = (input.tool_input && input.tool_input.file_path) || "";
  const ext = filePath ? path.extname(filePath).replace(/^\./, "").toLowerCase() : "";
  if (!filePath || !PRODUCTIVE_EXTS.has(ext)) process.exit(0);

  const count = readCount(productiveCountFile) + 1;
  if (!writeCount(productiveCountFile, count)) process.exit(0);
  if (count <= PRODUCTIVE_THRESHOLD) process.exit(0);

  emit(
    `⚔️ 帅位警戒：本会话已亲手编辑代码/原型类文件 ${count} 次（阈值${PRODUCTIVE_THRESHOLD}）。` +
      "若你是主会话指挥官：制作性交付物应派后台 subagent（dao.md 帅节·亲历上限），" +
      "请当场评估改派；用户在线逐条纠偏的快节奏跟改属豁免。"
  );
  process.exit(0);
}

// ══ 侦察连击：Read/Grep/Glob 无条件计入 ══
if (/^(Read|Grep|Glob)$/.test(toolName)) {
  const count = readCount(scoutCountFile) + 1;
  if (!writeCount(scoutCountFile, count)) process.exit(0);
  if (count < SCOUT_THRESHOLD) process.exit(0);
  emit(scoutContext(count));
  process.exit(0);
}

// ══ 侦察连击：Bash 按只读/写类/中性三档分类 ══
if (toolName === "Bash") {
  const cmd = (input.tool_input && input.tool_input.command) || "";
  const kind = classifyBash(cmd);

  if (kind === "write") {
    writeCount(scoutCountFile, 0); // 静默清零，不发消息——写命令是正常节奏
    process.exit(0);
  }
  if (kind === "neutral") process.exit(0); // 判不准，不计入也不清零

  // kind === "read"
  const count = readCount(scoutCountFile) + 1;
  if (!writeCount(scoutCountFile, count)) process.exit(0);
  if (count < SCOUT_THRESHOLD) process.exit(0);
  emit(scoutContext(count));
  process.exit(0);
}

process.exit(0);
