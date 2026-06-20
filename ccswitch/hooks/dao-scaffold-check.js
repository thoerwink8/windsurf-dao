// dao 脚手架检查 hook — SessionStart · 进入项目时静默检查标准结构
//
// 两种模式：
// A) 普通项目：检查 dao-project-scaffold 标准（CLAUDE.md / rules / 无冗余入口 / docs 扁平）
// B) windsurf-dao 元仓库：检查 hook 文件是否都已注册到 settings.json
//
// 发现缺项 → 注入 additionalContext 提醒 AI 在首次回答末尾告知用户。
// 全部通过 → 静默退出，不污染 context。
//
// 真相源：windsurf-dao/ccswitch/hooks/dao-scaffold-check.js

const fs = require("fs");
const path = require("path");

let raw = "";
try { raw = fs.readFileSync(0, "utf8"); } catch (_) {}

let input = {};
try { input = JSON.parse(raw); } catch (_) {}

const cwd = String(input.cwd || process.cwd());

function inject(context) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context }
  }));
  process.exit(0);
}
function done() { process.exit(0); }

function checkHookSync() {
  try {
    const hooksDir = path.join(cwd, "ccswitch", "hooks");
    if (!fs.existsSync(hooksDir)) return;

    const settingsPath = path.join(
      process.env.HOME || process.env.USERPROFILE || "",
      ".claude", "settings.json"
    );
    if (!fs.existsSync(settingsPath)) return;

    const settingsRaw = fs.readFileSync(settingsPath, "utf8");

    const hookFiles = fs.readdirSync(hooksDir)
      .filter(f => f.endsWith(".js"))
      .map(f => f.replace(/\.js$/, ""));

    const unregistered = hookFiles.filter(name => !settingsRaw.includes(name));

    if (unregistered.length === 0) return;

    inject(
      "【dao 同步检查】以下 hook 文件存在于 ccswitch/hooks/ 但未在 settings.json 中注册：\n" +
      unregistered.map(n => "- " + n + ".js").join("\n") +
      "\n请提醒用户是否需要注册到 ~/.claude/settings.json 的 hooks 配置中。"
    );
  } catch (_) {}
}

// windsurf-dao 元仓库：不检查项目模板，改为检查 hook 注册同步
if (path.basename(cwd) === "windsurf-dao") {
  checkHookSync();
  done();
}

// 跳过非 git 项目
try {
  if (!fs.existsSync(path.join(cwd, ".git"))) done();
} catch (_) { done(); }

const issues = [];

// 1. CLAUDE.md 存在且不超 80 行
const claudeMd = path.join(cwd, "CLAUDE.md");
try {
  if (!fs.existsSync(claudeMd)) {
    issues.push("缺少 CLAUDE.md（AI 入口文件）");
  } else {
    const lines = fs.readFileSync(claudeMd, "utf8").split(/\r?\n/).length;
    if (lines > 80) {
      issues.push("CLAUDE.md 超过 80 行（当前 " + lines + " 行），建议拆分详细规范到 .claude/rules/");
    }
  }
} catch (_) {}

// 2. .claude/rules/ 目录存在
try {
  if (!fs.existsSync(path.join(cwd, ".claude", "rules"))) {
    issues.push("缺少 .claude/rules/ 目录（领域规范存放处）");
  }
} catch (_) {}

// 3. 根目录无冗余 AI 入口
const redundant = ["AGENT_GUIDE.md", "KNOWLEDGE.md"];
for (const f of redundant) {
  try {
    if (fs.existsSync(path.join(cwd, f))) {
      issues.push("根目录存在冗余 AI 入口 " + f + "，内容应归入 CLAUDE.md 或 .claude/rules/");
    }
  } catch (_) {}
}

// 4. docs/ 结构检查（无 specs/superpowers 分裂）
const splitDirs = ["docs/specs", "docs/superpowers"];
for (const d of splitDirs) {
  try {
    const full = path.join(cwd, d);
    if (fs.existsSync(full) && fs.statSync(full).isDirectory()) {
      issues.push("docs/ 下存在 " + path.basename(d) + "/ 分裂目录，应统一到 docs/plans/");
    }
  } catch (_) {}
}

// 5. PRD.md 在根目录（应移到 docs/）
try {
  if (fs.existsSync(path.join(cwd, "PRD.md"))) {
    issues.push("PRD.md 在根目录，应移到 docs/prd.md");
  }
} catch (_) {}

if (issues.length === 0) done();

inject(
  "【dao 脚手架检查】本项目存在以下结构问题，请在回答用户问题后追加提醒：\n" +
  issues.map((s, i) => (i + 1) + ". " + s).join("\n") +
  "\n详细模板参考 dao-project-scaffold skill。提醒语气简洁友好，不阻塞用户当前任务。"
);
