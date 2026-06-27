// dao glob-gate hook — 补 Windsurf glob trigger 缺口
//
// Claude Code 无原生 "编辑某类文件时注入规则" 机制(见 dao-fa-mechanism「glob 缺口」)。
// 本 hook 在 Edit/Write/MultiEdit 后,按目标文件类型注入 dao 提醒:
//   - 代码文件(.ts/.py/...) → 提醒过 dao-quality 质量门
//   - dao 元层文件(ccswitch/dao.md / dao-* skill·command·agent) → 提醒过 dao-meta 三关
//
// 配在 PostToolUse(改完即提醒,语义比 PreToolUse 更贴"收尾前验证")。
// 始终 exit 0,只注入不阻断。
//
// 真相源:windsurf-dao/ccswitch/hooks/dao-glob-gate.js
// 由 settings.json 的 PostToolUse hook 调用。

const fs = require("fs");

let raw = "";
try { raw = fs.readFileSync(0, "utf8"); } catch (_) {}

let input = {};
try { input = JSON.parse(raw); } catch (_) {}

const toolName = input.tool_name || "";
const filePath = (input.tool_input && input.tool_input.file_path) || "";

if (!/^(Edit|Write|MultiEdit)$/.test(toolName) || !filePath) {
  process.exit(0);
}

const norm = filePath.replace(/\\/g, "/");

// 代码文件扩展名(对齐原 quality.md globs)
const isCode = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|c|cpp|h|hpp|cs|rb|php|swift|kt|scala|vue|svelte|sql)$/i.test(norm);

// 前端/UI 文件:除代码型组件外,纯样式文件(.css/.scss/.less)也算 —— 触发 dao-design（open.md）
const isFrontend = /\.(tsx|jsx|vue|svelte|css|scss|less)$/i.test(norm);

// dao 元层文件:ccswitch/dao.md 或 ccswitch/{skills,commands,agents}/dao-*
// 路径可能是绝对(D:/.../ccswitch/dao.md)或相对(ccswitch/dao.md),故用 (^|/) 兼容两者
const isDaoMeta = /(^|\/)ccswitch\/dao\.md$/.test(norm) ||
                  /(^|\/)ccswitch\/(skills|commands|agents)\/dao-/.test(norm) ||
                  /(^|\/)\.windsurf\/(rules|skills|workflows)\//.test(norm);

// settings.json / windsurf-dao 文件改动 → 提醒同步
const isSettingsJson = /[\\/]\.claude[\\/]settings\.json$/.test(norm) || /[\\/]\.claude[\\/]mcp_servers\.json$/.test(norm);
const isWindsurfDaoFile = /[\\/]windsurf-dao[\\/]/.test(norm) && !/(node_modules|_tmp|\.git)[\\/]/.test(norm);

let context = "";
if (isDaoMeta) {
  context = "【dao-meta 守卫】本次改动涉及 dao 元层文件。收尾前过三关:① 通用性(换项目还成立吗) ② 内容边界(只许思维/流程/准则,禁技术选型/API/配置) ③ 影响评估(会让其他 dao 项目变差吗)。不通过 → 路由到项目 AGENT.md/CLAUDE.md。双栈共存:ccswitch/ 与 .windsurf/ 哲学需一致。";
} else if (isSettingsJson) {
  context = "【dao 同步提醒】你刚修改了 " + norm.split("/").pop() + "，本地配置已领先于 windsurf-dao 快照。任务完成后提醒用户运行 dao.bat --direction=up 上行同步，或在回答末尾追加同步建议。";
} else if (isWindsurfDaoFile) {
  context = "【dao 同步提醒】你刚修改了 windsurf-dao 仓库文件。任务完成后提醒用户:① 提交改动 ② 运行 dao.bat --direction=up 上行同步 ③ 如果改了 hooks/skills/commands，确认 settings.json 注册或 deploy 已更新。";
} else {
  // 非元层文件:按文件性质叠加提示(代码型→质量门;前端/UI→design-taste,二者可同时命中如 .tsx)
  const parts = [];
  if (isCode) {
    parts.push("【dao-quality 质量门】本次改动涉及代码文件。收尾前按任务领域过检查清单:安全(输入验证/认证/无硬编码密钥)· 数据库(N+1/索引/migration 可逆)· 测试(核心路径+边界)· 错误处理(不吞异常)· 性能(分页/无重复计算)。匹配领域而非全扫;发现问题当场修;改完跑构建/测试再声明完成。");
  }
  if (isFrontend) {
    parts.push("【dao-design】UI/前端改动:有 design/ 目录时以 Open Design 原型为视觉真相源 · 三维对齐(结构/视觉/交互) · a11y · 表单/控件走项目 ui/* 体系勿用原生 element。改完截图对比 design/*.html 再声明完成。");
  }
  context = parts.join(" ");
}

if (context) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: context
    }
  }));
}

process.exit(0);
