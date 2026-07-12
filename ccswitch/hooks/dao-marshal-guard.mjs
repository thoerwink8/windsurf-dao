// dao marshal-guard hook — 帅位警戒线（提醒型，绝不阻断）
//
// 背景：dao.md 帅节规定主会话指挥官（帅）不亲手产出制作性交付物（产品代码/原型/批量文档），
// 硬判据：单文件新建 >50 行或同一交付物 >3 轮工具循环 → 必须派后台 subagent。
// 但提示词层约束已两次实证失效（2026-07-12 mousse-cli：帅亲写 700 行原型；同日 3 条 PR 评论 7+ 轮循环）。
// 本 hook 是机制层警戒线：同一 session 内「制作性编辑」达第 4 次起，每次注入模型可见提醒。
//
// 形态铁律（用户拍板）：
//   - 只提醒不阻断：始终 exit 0，无 permissionDecision、无弹窗、无权限询问，用户完全无感
//   - 挂 PostToolUse(matcher: Edit|Write|MultiEdit)：工具已执行天然不阻断，
//     additionalContext 注入路径为本仓已验证先例（dao-glob-gate / dao-tool-nudge 同款）
//   - PreToolUse 虽也支持 additionalContext，但官方文档将其与 permissionDecision 耦合，
//     输出 "allow" 会静默越过权限系统（超出提醒型边界），故不选
//
// 判定启发式 v1：被编辑文件扩展名 ∈ 代码/原型类集合 → 计数；.md/.toml/.json 等不计。
// Subagent 豁免：官方文档明确 agent_id / agent_type 仅在 subagent 内触发的 hook stdin 中出现，
//   检测到即静默退出——帅位约束只对主会话生效。
// 计数状态：%TEMP%/dao-marshal-guard/<session_id>.count，按 session 隔离，不污染项目目录。
//
// 真相源：windsurf-dao/ccswitch/hooks/dao-marshal-guard.mjs
// 由 settings.json 的 PostToolUse hook(matcher: Edit|Write|MultiEdit)调用。

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const THRESHOLD = 3; // 第 THRESHOLD+1 次起提醒

const PRODUCTIVE_EXTS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs",
  "rs", "py", "go", "java", "c", "cpp", "h",
  "html", "css", "scss", "less", "vue", "svelte",
]);

let raw = "";
try { raw = fs.readFileSync(0, "utf8"); } catch { /* 无 stdin 视为空 */ }

let input = {};
try { input = JSON.parse(raw); } catch { process.exit(0); }

// ── Subagent 豁免：agent_id/agent_type 仅在 subagent 内出现（官方 hooks 文档）──
if (input.agent_id || input.agent_type) process.exit(0);

// ── 只处理编辑类工具（settings matcher 已过滤，此处兜底）──
const toolName = input.tool_name || "";
if (!/^(Edit|Write|MultiEdit)$/.test(toolName)) process.exit(0);

// ── 提取文件路径并做扩展名判定 ──
const filePath = (input.tool_input && input.tool_input.file_path) || "";
if (!filePath) process.exit(0);

const ext = path.extname(filePath).replace(/^\./, "").toLowerCase();
if (!PRODUCTIVE_EXTS.has(ext)) process.exit(0);

// ── session 隔离计数（存系统 temp，不碰项目目录）──
const sessionId = String(input.session_id || "").replace(/[^A-Za-z0-9_-]/g, "");
if (!sessionId) process.exit(0); // 无法隔离就不计数，宁静默不串号

const dir = path.join(os.tmpdir(), "dao-marshal-guard");
const countFile = path.join(dir, `${sessionId}.count`);

let count = 0;
try { count = parseInt(fs.readFileSync(countFile, "utf8"), 10) || 0; } catch { /* 首次 */ }
count += 1;

try {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(countFile, String(count), "utf8");
} catch { process.exit(0); } // 状态写不进去就放弃本次提醒，绝不影响工具链路

if (count <= THRESHOLD) process.exit(0);

const context =
  `⚔️ 帅位警戒：本会话已亲手编辑代码/原型类文件 ${count} 次（阈值${THRESHOLD}）。` +
  "若你是主会话指挥官：制作性交付物应派后台 subagent（dao.md 帅节·亲历上限），" +
  "请当场评估改派；用户在线逐条纠偏的快节奏跟改属豁免。";

process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: "PostToolUse",
    additionalContext: context,
  },
}));

process.exit(0);
