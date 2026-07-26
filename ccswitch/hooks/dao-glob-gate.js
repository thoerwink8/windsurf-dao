// dao glob-gate hook — 补 Windsurf glob trigger 缺口
//
// Claude Code 无原生 "编辑某类文件时注入规则" 机制(Windsurf glob trigger 的对应缺口)。
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
  // live settings.json 是 cc-switch SQLite DB 的投影：改它是「改投影」,下次 provider 下发即被覆盖。
  // 正道是改 git 快照层(config-sync/common/settings.json)再由用户 restore 写源。
  context = "【dao 同步提醒】你刚修改了 " + norm.split("/").pop() + "。⚠ 若这是 live `~/.claude/` 下的那份,它是 cc-switch DB 的**投影**——改它立即生效但不持久,下次下发即被覆盖。正道:同步改 git 快照层 `config-sync/common/settings.json`,并提醒用户跑 `dao.bat --direction=down`(快照→DB)。**不要建议 `--direction=up`**:up 是「读 DB 覆盖快照」,DB 里还没有你的改动,跑它会把你刚写的快照冲掉。";
} else if (isWindsurfDaoFile) {
  // 2026-07-27 修:本分支原文无条件建议跑 `--direction=up`,而 up 走 config-sync/lib/export.mjs 的
  // `selectRows('settings', "WHERE key LIKE 'common_config_%'")` —— 只从 SQLite DB 读,**看不见 ccswitch/ 下的
  // git 源文件**。故对 ccswitch/ 的改动,up 不仅无必要,还会用旧 DB 状态覆盖快照。该错误提醒已连续误导三名
  // subagent 照抄进交付报告(刀C/备案官/沉淀官,2026-07-26~27),属「每次都在误导」形态,优先级高于一次性错误。
  context = "【dao 同步提醒】你刚修改了 windsurf-dao 仓库文件。收尾提醒用户:① 提交并 `git push`(这是 ccswitch/ 下改动**唯一**需要的动作——hooks 现注册仓库路径、skills/commands/agents 走 symlink,改文件即生效,零部署步骤) ② **不要建议 `dao.bat --direction=up`**:up 只从 cc-switch DB 读并覆盖 git 快照,看不见 ccswitch/ 下的源文件;只有当你改了 `config-sync/common/*.json` 快照层、需要写回 DB 时,用的也是 `--direction=down` 而非 up ③ 若新建了 hook 文件,确认 settings.json 已注册(改既有 hook 文件不需要)。";
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
